package deduction

import (
	"strconv"
	"testing"
	"time"

	"github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
	corev3 "github.com/envoyproxy/go-control-plane/envoy/config/core/v3"
	datalogv3 "github.com/envoyproxy/go-control-plane/envoy/data/accesslog/v3"
	alsv3 "github.com/envoyproxy/go-control-plane/envoy/service/accesslog/v3"
	"google.golang.org/protobuf/types/known/durationpb"
)

func TestGatewayRouteServiceMetersArbitraryObjectPaths(t *testing.T) {
	srv, mr := setupBalanceBackendTest(t)
	const principal = "s3-reader"
	const balance = int64(1_000_000_000)
	if err := mr.Set(utils.AuthzKey(principal), strconv.FormatInt(balance, 10)); err != nil {
		t.Fatal(err)
	}
	mr.HSet("p:s3", "METER_TYPE_DURATION_MS", "2")
	mr.HSet("p:s3", "METER_TYPE_INGRESS_BYTES", "3")
	mr.HSet("p:s3", "METER_TYPE_EGRESS_BYTES", "5")
	for _, path := range []string{"/applications/first-object", "/applications/other-object?versionId=1"} {
		srv.handle(&alsv3.StreamAccessLogsMessage{
			LogEntries: &alsv3.StreamAccessLogsMessage_HttpLogs{
				HttpLogs: &alsv3.StreamAccessLogsMessage_HTTPAccessLogEntries{
					LogEntry: []*datalogv3.HTTPAccessLogEntry{{
						CommonProperties: &datalogv3.AccessLogCommon{
							CustomTags: map[string]string{"meter_service": "s3"},
							Duration:   durationpb.New(2 * time.Millisecond),
						},
						Request: &datalogv3.HTTPRequestProperties{
							Path: path, RequestHeaders: map[string]string{"x-user-id": principal},
							RequestHeadersBytes: 20, RequestBodyBytes: 80,
						},
						Response: &datalogv3.HTTPResponseProperties{
							ResponseHeadersBytes: 50, ResponseBodyBytes: 150,
						},
					}},
				},
			},
		})
	}
	got, err := mr.Get(utils.AuthzKey(principal))
	if err != nil {
		t.Fatal(err)
	}
	want := strconv.FormatInt(balance-2*(2*2+100*3+200*5)*utils.INFLATION, 10)
	if got != want {
		t.Fatalf("balance=%s want %s; duration, ingress and egress must all be billed", got, want)
	}
}

func TestGatewayPricingIgnoresClientServiceHeaders(t *testing.T) {
	entry := &datalogv3.HTTPAccessLogEntry{
		CommonProperties: &datalogv3.AccessLogCommon{
			DownstreamLocalAddress: &corev3.Address{Address: &corev3.Address_SocketAddress{
				SocketAddress: &corev3.SocketAddress{PortSpecifier: &corev3.SocketAddress_PortValue{PortValue: 8443}},
			}},
		},
		Request: &datalogv3.HTTPRequestProperties{
			Path:           "/kvstore.v1.MeteredStorageService/GetCASValue",
			RequestHeaders: map[string]string{"meter_service": "s3"},
		},
	}
	got, err := formatDPoPKey(entry)
	if err != nil {
		t.Fatal(err)
	}
	if want := "p::8443:/kvstore.v1.MeteredStorageService/GetCASValue"; got != want {
		t.Fatalf("key=%s want %s", got, want)
	}
}
