package index

import (
	"encoding/json"
	"testing"

	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/index/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func TestEnabledScorersAndRequestedIntersection(t *testing.T) {
	first := functionality()
	second := proto.Clone(first).(*pb.Functionality)
	second.Variant.Tag = "second"
	disabled := proto.Clone(first).(*pb.Functionality)
	disabled.Variant.Tag = "disabled"
	config := []map[string]any{}
	for _, f := range []*pb.Functionality{first, second} {
		raw, _ := protojson.Marshal(f)
		config = append(config, map[string]any{"implementation": "ingress-time", "functionality": json.RawMessage(raw)})
	}
	data, _ := json.Marshal(config)
	enabled, err := ParseEnabledScorers(data)
	if err != nil {
		t.Fatal(err)
	}
	matches := matchingScorers(enabled, []*pb.Functionality{disabled, second, first, second})
	p := provider()
	enrichProvider(p, matches, 12345)
	if len(p.Scores) != 2 || p.Scores[0].Score != 12345 || !proto.Equal(p.Scores[0].ScoringFunctionality, first) || !proto.Equal(p.Scores[1].ScoringFunctionality, second) {
		t.Fatalf("unexpected matched scores: %v", p.Scores)
	}
	partial := matchingScorers(enabled, []*pb.Functionality{disabled, second})
	if len(partial) != 1 || !proto.Equal(partial[0].Functionality, second) {
		t.Fatal("partial intersection failed")
	}
	if len(matchingScorers(enabled, []*pb.Functionality{disabled})) != 0 || len(matchingScorers(enabled, nil)) != 0 {
		t.Fatal("unrequested scorer matched")
	}
	if _, err := ParseEnabledScorers(nil); err != nil {
		t.Fatal(err)
	}
	config[0]["implementation"] = "missing-plugin"
	data, _ = json.Marshal(config)
	if _, err := ParseEnabledScorers(data); err == nil {
		t.Fatal("enabled unavailable implementation")
	}
	config[0]["implementation"] = "ingress-time"
	config[1] = config[0]
	data, _ = json.Marshal(config)
	if _, err := ParseEnabledScorers(data); err == nil {
		t.Fatal("enabled duplicate functionality")
	}
}
