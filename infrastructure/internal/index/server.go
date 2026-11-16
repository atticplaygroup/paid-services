// Package index implements the paid provider advertisement index.
package index

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/url"
	"strconv"
	"time"

	"connectrpc.com/connect"
	indexdb "github.com/atticplaygroup/paid-services/infrastructure/internal/index/db/sqlc"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/middleware"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/index/v1"
	"github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
	"github.com/lestrrat-go/jwx/v3/jwa"
	"github.com/lestrrat-go/jwx/v3/jwk"
	"github.com/lestrrat-go/jwx/v3/jws"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type Server struct {
	Scorers []Scorer
	Queries indexdb.Querier
}

func hash(v proto.Message) string {
	b, _ := (proto.MarshalOptions{Deterministic: true}).Marshal(v)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
func validateProvider(p *pb.Provider, now time.Time, depth int) error {
	if len(p.Scores) != 0 {
		return errors.New("scores must be empty when registering")
	}
	u, err := url.Parse(p.Origin)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || len(p.Origin) > 2048 {
		return errors.New("provider origin must be an HTTP(S) origin")
	}
	if depth > 2 || len(p.Exchanges) > 8 {
		return errors.New("exchanges exceed limits")
	}
	if p.Price < 0 || p.CoinType <= 0 || p.CoinEnvironment <= 0 {
		return errors.New("invalid price or coin")
	}
	if !p.ExpireTime.AsTime().After(now) || p.ExpireTime.AsTime().After(now.Add(30*24*time.Hour)) || p.UpdateTime.AsTime().After(now.Add(time.Minute)) || p.UpdateTime.AsTime().IsZero() || p.UpdateTime.AsTime().After(p.ExpireTime.AsTime()) {
		return errors.New("invalid provider timestamps (maximum expiry 30 days)")
	}
	for _, e := range p.Exchanges {
		if err := validateProvider(e, now, depth+1); err != nil {
			return err
		}
	}
	return nil
}

func verifyAdvertisement(a *pb.ProviderAdvertisement, principal string) error {
	parts, err := jws.Parse([]byte(a.Signature))
	if err != nil || len(parts.Signatures()) != 1 {
		return errors.New("invalid advertisement signature")
	}
	key, ok := parts.Signatures()[0].ProtectedHeaders().JWK()
	if !ok || key.Has("d") {
		return errors.New("public signing JWK required")
	}
	var pub ecdsa.PublicKey
	if err := jwk.Export(key, &pub); err != nil || pub.Curve != elliptic.P256() {
		return errors.New("ES256 key required")
	}
	owner, err := utils.FormatPrincipal(&pub)
	if err != nil || principal == "" || owner.String() != principal {
		return errors.New("advertisement signer does not match caller")
	}
	payload, err := jws.Verify([]byte(a.Signature), jws.WithKey(jwa.ES256(), &pub))
	if err != nil {
		return err
	}

	signed := new(pb.SignedAdvertisement)
	if err := protojson.Unmarshal(payload, signed); err != nil {
		return err
	}
	expected := &pb.SignedAdvertisement{V: "paid.index.advertisement.v1", Functionality: a.Functionality, Providers: a.Providers}
	if !proto.Equal(signed, expected) {
		return errors.New("advertisement payload mismatch")
	}
	return nil
}

func (s *Server) Advertise(ctx context.Context, req *connect.Request[pb.AdvertiseRequest]) (*connect.Response[pb.AdvertiseResponse], error) {
	a := req.Msg.GetAdvertisement()
	now := time.Now().UTC()
	for _, p := range a.Providers {
		if err := validateProvider(p, now, 0); err != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, err)
		}
	}
	session, err := middleware.SessionFromContext(ctx)
	if err != nil {
		return nil, connect.NewError(connect.CodeUnauthenticated, err)
	}
	if err := verifyAdvertisement(a, session.UserId); err != nil {
		return nil, connect.NewError(connect.CodePermissionDenied, err)
	}
	body, err := protojson.Marshal(a)
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	id := sha256.Sum256([]byte(hash(a.Functionality) + "\x00" + session.UserId))
	if err := s.Queries.PutAdvertisement(ctx, indexdb.PutAdvertisementParams{ID: hex.EncodeToString(id[:]), Functionality: hash(a.Functionality), Publisher: session.UserId, Advertisement: body, IngressTime: now.UnixMilli()}); err != nil {
		return nil, connect.NewError(connect.CodeInternal, errors.New("store advertisement failed"))
	}
	return connect.NewResponse(&pb.AdvertiseResponse{IngressTime: timestamppb.New(now)}), nil
}
func (s *Server) SearchProvider(ctx context.Context, req *connect.Request[pb.SearchProviderRequest]) (*connect.Response[pb.SearchProviderResponse], error) {
	scorers := matchingScorers(s.Scorers, req.Msg.ProviderScorings)
	if len(scorers) == 0 {
		return connect.NewResponse(&pb.SearchProviderResponse{}), nil
	}
	limit := req.Msg.Limit
	if limit == 0 {
		limit = 20
	}
	offset := int64(0)
	var err error
	if req.Msg.Offset != "" {
		offset, err = strconv.ParseInt(req.Msg.Offset, 10, 32)
	}
	if err != nil || offset < 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("invalid offset"))
	}
	result := &pb.SearchProviderResponse{}
	skipped := int64(0)
	scan := int32(0)
	now := time.Now()
	for len(result.ProviderAdvertisements) < int(limit) {
		rows, err := s.Queries.SearchAdvertisements(ctx, indexdb.SearchAdvertisementsParams{Functionality: hash(req.Msg.Functionality), Limit: 100, Offset: scan})
		if err != nil {
			return nil, connect.NewError(connect.CodeInternal, errors.New("search failed"))
		}
		for _, row := range rows {
			a := new(pb.ProviderAdvertisement)
			if err := protojson.Unmarshal(row.Advertisement, a); err != nil {
				return nil, connect.NewError(connect.CodeInternal, errors.New("invalid stored advertisement"))
			}
			live := false
			for _, p := range a.Providers {
				if p.ExpireTime.AsTime().After(now) {
					live = true
					break
				}
			}
			if !live {
				continue
			}
			if skipped < offset {
				skipped++
				continue
			}
			for _, p := range a.Providers {
				enrichProvider(p, scorers, row.IngressTime)
			}
			result.ProviderAdvertisements = append(result.ProviderAdvertisements, a)
			if len(result.ProviderAdvertisements) == int(limit) {
				break
			}
		}
		if len(rows) < 100 {
			break
		}
		scan += 100
	}
	if len(result.ProviderAdvertisements) == int(limit) {
		result.NextOffset = strconv.FormatInt(offset+int64(len(result.ProviderAdvertisements)), 10)
	}
	return connect.NewResponse(result), nil
}
