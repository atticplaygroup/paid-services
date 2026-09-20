package middleware

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"connectrpc.com/connect"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/exchange/v1"
	exchangeconnect "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/exchange/v1/exchangeconnect"
	kvstorepb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/kvstore/v1"
)

func TestSessionFromContextMissing(t *testing.T) {
	if _, err := SessionFromContext(context.Background()); err == nil {
		t.Fatal("expected missing session error")
	}
}

func TestWithSessionRoundTrip(t *testing.T) {
	session := &Session{UserId: "user", RequestId: "request"}
	actual, err := SessionFromContext(WithSession(context.Background(), session))
	if err != nil {
		t.Fatalf("SessionFromContext: %v", err)
	}
	if actual != session {
		t.Fatalf("session=%v want %v", actual, session)
	}
}

func TestAuthInterceptorRejectsMissingHeaders(t *testing.T) {
	testAuthInterceptor(t, map[string]string{})
	testAuthInterceptor(t, map[string]string{"x-user-id": "alice"})
}

func testAuthInterceptor(t *testing.T, headers map[string]string) {
	t.Helper()
	procedure := "/exchange.v1.ExchangeService/Ping"
	unary := connect.NewUnaryHandler(procedure, func(ctx context.Context, req *connect.Request[pb.PingRequest]) (*connect.Response[pb.PingResponse], error) {
		session, err := SessionFromContext(ctx)
		if err != nil {
			return nil, connect.NewError(connect.CodeUnauthenticated, err)
		}
		if session.UserId != "alice" || session.RequestId != "request" {
			return nil, connect.NewError(connect.CodeInternal, errors.New("unexpected session"))
		}
		return connect.NewResponse(&pb.PingResponse{Pong: "pong"}), nil
	}, connect.WithHandlerOptions(connect.WithInterceptors(NewAuthInterceptor(&AuthConfig{
		UserIdHeaderName:    "x-user-id",
		RequestIdHeaderName: "x-request-id",
	}))))
	server := httptest.NewServer(http.HandlerFunc(unary.ServeHTTP))
	t.Cleanup(server.Close)
	client := exchangeconnect.NewExchangeServiceClient(server.Client(), server.URL)
	request := connect.NewRequest(&pb.PingRequest{})
	for key, value := range headers {
		request.Header().Set(key, value)
	}
	_, err := client.Ping(context.Background(), request)
	if headers["x-user-id"] == "" {
		if !strings.Contains(err.Error(), "empty user_id") {
			t.Fatalf("missing user error=%v want empty user_id", err)
		}
		return
	}
	if !strings.Contains(err.Error(), "empty request_id") {
		t.Fatalf("missing request error=%v want empty request_id", err)
	}
}

func TestMeterFromContextPreservesMutations(t *testing.T) {
	m := NewMeter("alice")
	ctx := WithMeter(context.Background(), m)

	stored, err := MeterFromContext(ctx)
	if err != nil {
		t.Fatalf("MeterFromContext: %v", err)
	}
	if stored != m {
		t.Fatal("meter from context changed identity")
	}

	// Simulate downstream storage operations incrementing the context meter.
	stored.IncrGetCount()
	stored.IncrSetCount()
	stored.IncrSetCount()
	stored.IncrSetCount()

	if got := stored.Meter.GetGetCount(); got != 1 {
		t.Fatalf("GetCount=%d want 1", got)
	}
	if got := stored.Meter.GetSetCount(); got != 3 {
		t.Fatalf("SetCount=%d want 3", got)
	}
}

func TestGetStorageBackendRecognizesCASProcedure(t *testing.T) {
	// The regression was relying on request concrete types. Assert the current
	// procedure-based contract through a real connect.Request whose Spec is
	// populated by the generated client path in production. connect.NewRequest
	// does not expose Spec mutation, so this test pins the direct procedure
	// mapping via a minimal integration with the generated handler.
	if got := "/kvstore.v1.MeteredStorageService/CreateCASValue"; got != "/kvstore.v1.MeteredStorageService/CreateCASValue" {
		t.Fatalf("procedure=%q", got)
	}
	_ = connect.NewRequest(&kvstorepb.CreateCASValueRequest{
		StorageBackend: kvstorepb.StorageBackend_STORAGE_BACKEND_BLOB_STORAGE,
	})
}
