package utils

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"testing"

	"github.com/atticplaygroup/paid-services/infrastructure/pkg/dpop"
	"github.com/ipfs/go-cid"
	mh "github.com/multiformats/go-multihash"
)

func TestPrincipalMatchesTypeScriptVector(t *testing.T) {
	seed := sha256.Sum256([]byte("cashierlegal winner thank year wave sausage worth useful legal winner thank yellow"))
	x, y := elliptic.P256().ScalarBaseMult(seed[:])
	principal, err := FormatPrincipal(&ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y})
	if err != nil {
		t.Fatal(err)
	}
	const expected = "bahi5mayseakgxo3yvoqqco7lttd7c7mzxvos4f45ffo4jv27fgctrrgc2rv3s"
	if principal.String() != expected {
		t.Fatalf("principal = %s, want %s", principal, expected)
	}
}

func TestPrincipalCodecAcrossKeyAlgorithms(t *testing.T) {
	ec, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	ed, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	for name, key := range map[string]any{"P-256": &ec.PublicKey, "Ed25519": ed, "RSA": &rsaKey.PublicKey} {
		t.Run(name, func(t *testing.T) {
			principal, err := FormatPrincipal(key)
			if err != nil {
				t.Fatal(err)
			}
			thumbprint, err := dpop.ThumbprintBytes(key)
			if err != nil {
				t.Fatal(err)
			}
			digest, err := mh.Decode(principal.Hash())
			if err != nil {
				t.Fatal(err)
			}
			if principal.Type() != JWKJCSPublicKeyCodec || digest.Code != mh.SHA2_256 || string(digest.Digest) != string(thumbprint) {
				t.Fatal("principal must identify the SHA-256 canonical public JWK thumbprint")
			}
			content, err := DigestToMultihash(thumbprint)
			if err != nil {
				t.Fatal(err)
			}
			if content.Type() != cid.Raw || content.Equals(*principal) {
				t.Fatal("raw content IDs must remain distinct from key principals")
			}
		})
	}
}
