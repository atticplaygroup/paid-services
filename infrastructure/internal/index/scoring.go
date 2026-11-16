package index

import (
	"encoding/json"
	"fmt"

	"github.com/atticplaygroup/paid-services/infrastructure/pkg/connecthttp"
	pb "github.com/atticplaygroup/paid-services/infrastructure/pkg/proto/gen/go/index/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// Scorer pairs an enabled functionality with its implementation.
// Other implementations can be registered here when they become available.
type Scorer struct {
	Functionality *pb.Functionality
	Score         func(provider *pb.Provider, ingressTime int64) float64
}

func ParseEnabledScorers(data []byte) ([]Scorer, error) {
	var config []struct {
		Implementation string          `json:"implementation"`
		Functionality  json.RawMessage `json:"functionality"`
	}
	if len(data) == 0 {
		data = []byte("[]")
	}
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, err
	}
	if len(config) > 32 {
		return nil, fmt.Errorf("at most 32 enabled scorers")
	}
	scorers := make([]Scorer, 0, len(config))
	validator := connecthttp.NewValidator()
	for _, entry := range config {
		functionality := new(pb.Functionality)
		if err := protojson.Unmarshal(entry.Functionality, functionality); err != nil {
			return nil, err
		}
		if err := validator.Validate(functionality); err != nil {
			return nil, err
		}
		for _, scorer := range scorers {
			if proto.Equal(scorer.Functionality, functionality) {
				return nil, fmt.Errorf("duplicate scoring functionality")
			}
		}
		switch entry.Implementation {
		case "ingress-time":
			scorers = append(scorers, Scorer{Functionality: functionality, Score: func(_ *pb.Provider, ingressTime int64) float64 { return float64(ingressTime) }})
		default:
			return nil, fmt.Errorf("unsupported scorer implementation %q", entry.Implementation)
		}
	}
	return scorers, nil
}

func matchingScorers(enabled []Scorer, requested []*pb.Functionality) []Scorer {
	matches := []Scorer{}
	for _, scorer := range enabled {
		for _, functionality := range requested {
			if proto.Equal(scorer.Functionality, functionality) {
				matches = append(matches, scorer)
				break
			}
		}
	}
	return matches
}

// Scores are index output, not part of the publisher's signed registration.
func enrichProvider(p *pb.Provider, scorers []Scorer, ingressTime int64) {
	p.Scores = nil
	for _, scorer := range scorers {
		p.Scores = append(p.Scores, &pb.ProviderScore{ScoringFunctionality: proto.Clone(scorer.Functionality).(*pb.Functionality), Score: scorer.Score(p, ingressTime)})
	}
	for _, exchange := range p.Exchanges {
		enrichProvider(exchange, scorers, ingressTime)
	}
}
