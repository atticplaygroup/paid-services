package index

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"
	indexdb "github.com/atticplaygroup/paid-services/infrastructure/internal/index/db/sqlc"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/connecthttp"
	epb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/exchange/v1"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/index/v1"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/index/v1/indexconnect"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
	"github.com/lestrrat-go/jwx/v3/jwa"
	"github.com/lestrrat-go/jwx/v3/jwk"
	"github.com/lestrrat-go/jwx/v3/jws"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func functionality() *pb.Functionality {
	return &pb.Functionality{Behavior: &pb.Behavior{Name: "api", Maintainer: "alice", Tag: "v1"}, Variant: &pb.Variant{Name: "data", Maintainer: "bob", Tag: "v1"}}
}
func provider() *pb.Provider {
	now := time.Now().UTC()
	return &pb.Provider{Origin: "https://provider", Principal: "provider-party", CoinType: epb.CoinType_COIN_TYPE_SUI, CoinEnvironment: epb.CoinEnvironment_COIN_ENVIRONMENT_LOCALNET, UpdateTime: timestamppb.New(now), ExpireTime: timestamppb.New(now.Add(time.Hour))}
}
func signedAdvertisement(t *testing.T) (*pb.ProviderAdvertisement, string) {
	t.Helper()
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	pub, _ := jwk.Import(&key.PublicKey)
	headers := jws.NewHeaders()
	_ = headers.Set(jws.JWKKey, pub)
	second := provider()
	second.Origin = "https://second-provider"
	second.Exchanges = []*pb.Provider{provider()}
	a := &pb.ProviderAdvertisement{Functionality: functionality(), Providers: []*pb.Provider{provider(), second}}
	payload, _ := protojson.Marshal(&pb.SignedAdvertisement{V: "paid.index.advertisement.v1", Functionality: a.Functionality, Providers: a.Providers})
	signed, err := jws.Sign(payload, jws.WithKey(jwa.ES256(), key, jws.WithProtectedHeaders(headers)))
	if err != nil {
		t.Fatal(err)
	}
	a.Signature = string(signed)
	owner, _ := utils.FormatPrincipal(&key.PublicKey)
	return a, owner.String()
}
func TestAdvertisementSignatureBindsCallerAndFields(t *testing.T) {
	a, owner := signedAdvertisement(t)
	if err := verifyAdvertisement(a, owner); err != nil {
		t.Fatal(err)
	}
	if verifyAdvertisement(a, "another-caller") == nil {
		t.Fatal("accepted another caller")
	}
	changed := proto.Clone(a).(*pb.ProviderAdvertisement)
	changed.Providers[0].Principal = "substituted-party"
	if verifyAdvertisement(changed, owner) == nil {
		t.Fatal("accepted substituted principal")
	}
	a.Providers[0].Origin = "https://attacker"
	if verifyAdvertisement(a, owner) == nil {
		t.Fatal("accepted substituted provider")
	}
}
func TestProviderLimits(t *testing.T) {
	p := provider()
	now := time.Now()
	if err := validateProvider(p, now, 0); err != nil {
		t.Fatal(err)
	}
	for _, origin := range []string{"file:///etc/passwd", "https://user:pass@provider", "https://provider/path", "https://provider?x=1"} {
		bad := proto.Clone(p).(*pb.Provider)
		bad.Origin = origin
		if validateProvider(bad, now, 0) == nil {
			t.Fatalf("accepted %s", origin)
		}
	}
	p.ExpireTime = timestamppb.New(now.Add(31 * 24 * time.Hour))
	if validateProvider(p, now, 0) == nil {
		t.Fatal("accepted excessive expiry")
	}
}

type memoryQueries struct {
	row *indexdb.PutAdvertisementParams
}

func (q *memoryQueries) PutAdvertisement(_ context.Context, p indexdb.PutAdvertisementParams) error {
	q.row = &p
	return nil
}
func (q *memoryQueries) SearchAdvertisements(_ context.Context, p indexdb.SearchAdvertisementsParams) ([]indexdb.SearchAdvertisementsRow, error) {
	if q.row == nil || q.row.Functionality != p.Functionality || p.Offset > 0 {
		return nil, nil
	}
	return []indexdb.SearchAdvertisementsRow{{ID: q.row.ID, Advertisement: q.row.Advertisement, IngressTime: q.row.IngressTime}}, nil
}
func TestGeneratedClientsAndValidation(t *testing.T) {
	for _, jsonWire := range []bool{false, true} {
		t.Run(map[bool]string{false: "binary", true: "json"}[jsonWire], func(t *testing.T) {
			q := new(memoryQueries)
			scorers := []Scorer{{Functionality: functionality(), Score: func(_ *pb.Provider, ingressTime int64) float64 { return float64(ingressTime) }}}
			path, handler := NewHandler(&Server{Queries: q, Scorers: scorers})
			mux := http.NewServeMux()
			mux.Handle(path, handler)
			httpServer := httptest.NewServer(mux)
			defer httpServer.Close()
			options := []connect.ClientOption{}
			if jsonWire {
				options = append(options, connect.WithProtoJSON())
			}
			client := indexconnect.NewIndexServiceClient(httpServer.Client(), httpServer.URL, options...)
			a, owner := signedAdvertisement(t)
			request := connect.NewRequest(&pb.AdvertiseRequest{Advertisement: a})
			request.Header().Set("x-user-id", owner)
			request.Header().Set("x-request-id", "register")
			if _, err := client.Advertise(context.Background(), request); err != nil {
				t.Fatal(err)
			}
			search := connect.NewRequest(&pb.SearchProviderRequest{Functionality: a.Functionality, ProviderScorings: []*pb.Functionality{functionality()}, Limit: 2})
			search.Header().Set("x-user-id", owner)
			search.Header().Set("x-request-id", "search")
			response, err := client.SearchProvider(context.Background(), search)
			if err != nil {
				t.Fatal(err)
			}
			if len(response.Msg.ProviderAdvertisements) != 1 {
				t.Fatalf("unexpected response %v", response.Msg)
			}
			enriched := response.Msg.ProviderAdvertisements[0]
			for _, p := range enriched.Providers {
				if p.Principal != "provider-party" || len(p.Scores) != 1 || !proto.Equal(p.Scores[0].ScoringFunctionality, functionality()) || p.Scores[0].Score <= 0 {
					t.Fatalf("missing provider enrichment: %v", p)
				}
			}
			if len(enriched.Providers[1].Exchanges[0].Scores) != 1 {
				t.Fatal("missing exchange scores")
			}
			// Remove output-only fields to recover the publisher's signed input.
			registered := proto.Clone(enriched).(*pb.ProviderAdvertisement)
			clearEnrichment(registered.Providers)
			if !proto.Equal(registered, a) || verifyAdvertisement(registered, owner) != nil {
				t.Fatal("search changed signed registration fields")
			}
			stored := new(pb.ProviderAdvertisement)
			if err := protojson.Unmarshal(q.row.Advertisement, stored); err != nil || !proto.Equal(stored, a) {
				t.Fatal("index persisted output-only enrichment")
			}
			unsupported := proto.Clone(functionality()).(*pb.Functionality)
			unsupported.Variant.Tag = "unsupported"
			search.Msg.ProviderScorings = []*pb.Functionality{unsupported, functionality(), functionality()}
			partial, err := client.SearchProvider(context.Background(), search)
			if err != nil || len(partial.Msg.ProviderAdvertisements) != 1 || len(partial.Msg.ProviderAdvertisements[0].Providers[0].Scores) != 1 {
				t.Fatalf("partial matches must succeed without duplicate scores: %v %v", partial, err)
			}
			search.Msg.ProviderScorings = []*pb.Functionality{unsupported}
			none, err := client.SearchProvider(context.Background(), search)
			if err != nil || len(none.Msg.ProviderAdvertisements) != 0 {
				t.Fatalf("unsupported model must yield no matches, got %v %v", none, err)
			}
			search.Msg.ProviderScorings = []*pb.Functionality{functionality()}
			for _, mutate := range []func(*pb.Provider){
				func(p *pb.Provider) { p.Principal = "" },
				func(p *pb.Provider) {
					p.Scores = []*pb.ProviderScore{{ScoringFunctionality: functionality(), Score: 999}}
				},
			} {
				bad := proto.Clone(a).(*pb.ProviderAdvertisement)
				mutate(bad.Providers[0])
				invalid := connect.NewRequest(&pb.AdvertiseRequest{Advertisement: bad})
				invalid.Header().Set("x-user-id", owner)
				invalid.Header().Set("x-request-id", "forged")
				if _, err := client.Advertise(context.Background(), invalid); connect.CodeOf(err) != connect.CodeInvalidArgument {
					t.Fatalf("accepted supplied output fields: %v", err)
				}
			}
			search.Msg.Limit = 101
			if _, err := client.SearchProvider(context.Background(), search); connect.CodeOf(err) != connect.CodeInvalidArgument {
				t.Fatalf("expected invalid argument, got %v", err)
			}
			request.Msg.Advertisement.Providers = make([]*pb.Provider, 33)
			for i := range request.Msg.Advertisement.Providers {
				request.Msg.Advertisement.Providers[i] = provider()
			}
			if _, err := client.Advertise(context.Background(), request); connect.CodeOf(err) != connect.CodeInvalidArgument {
				t.Fatalf("expected invalid argument, got %v", err)
			}
			search.Header().Del("x-user-id")
			if _, err := client.SearchProvider(context.Background(), search); connect.CodeOf(err) != connect.CodeUnauthenticated {
				t.Fatalf("expected unauthenticated, got %v", err)
			}
		})
	}
	v := connecthttp.NewValidator()
	if v.Validate(&pb.AdvertiseRequest{}) == nil {
		t.Fatal("missing advertisement passed schema validation")
	}
}

func clearEnrichment(providers []*pb.Provider) {
	for _, p := range providers {
		p.Scores = nil
		clearEnrichment(p.Exchanges)
	}
}
