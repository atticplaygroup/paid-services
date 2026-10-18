package account

import (
	"crypto/sha256"
	"testing"

	"github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
	"github.com/ipfs/go-cid"
	mh "github.com/multiformats/go-multihash"
)

func TestAudienceRequiresJWKPrincipal(t *testing.T) {
	digest := sha256.Sum256([]byte("public JWK"))
	principal, err := utils.PrincipalFromThumbprint(digest[:])
	if err != nil {
		t.Fatal(err)
	}
	if validAudience(principal.String()) != principal.String() {
		t.Fatal("valid JWK principal rejected")
	}
	raw, err := utils.DigestToMultihash(digest[:])
	if err != nil {
		t.Fatal(err)
	}
	shortHash, err := mh.Encode(digest[:16], mh.SHA2_256)
	if err != nil {
		t.Fatal(err)
	}
	wrongHash, err := mh.Encode(digest[:], mh.IDENTITY)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{
		"bafk-test-provider", raw.String(),
		cid.NewCidV1(utils.JWKJCSPublicKeyCodec, shortHash).String(),
		cid.NewCidV1(utils.JWKJCSPublicKeyCodec, wrongHash).String(),
	} {
		if validAudience(value) != "" {
			t.Fatalf("invalid principal accepted: %s", value)
		}
	}
}
