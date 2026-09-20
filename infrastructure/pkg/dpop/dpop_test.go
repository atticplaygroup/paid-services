package dpop_test

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"strings"
	"testing"
	"time"

	"github.com/atticplaygroup/paid-services/infrastructure/pkg/dpop"
)

const (
	testMethod = "GET"
	testHTU    = "https://api.example.com/v1/foo"
)

func testKey(t *testing.T) *ecdsa.PrivateKey {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func TestMintVerify(t *testing.T) {
	priv := testKey(t)
	compact, jkt, err := dpop.Mint(priv, testMethod, testHTU)
	if err != nil {
		t.Fatal(err)
	}
	if jkt == "" || compact == "" {
		t.Fatal("empty mint")
	}
	v := dpop.NewVerifier(time.Minute)
	res, err := v.VerifyBearer("Bearer "+compact, testMethod, testHTU)
	if err != nil {
		t.Fatal(err)
	}
	if res.JKT != jkt {
		t.Fatalf("jkt got %q want %q", res.JKT, jkt)
	}
}

func TestReplayJTI(t *testing.T) {
	priv := testKey(t)
	compact, _, err := dpop.Mint(priv, testMethod, testHTU)
	if err != nil {
		t.Fatal(err)
	}
	v := dpop.NewVerifier(time.Minute)
	if _, err := v.Verify(compact, testMethod, testHTU); err != nil {
		t.Fatal(err)
	}
	if _, err := v.Verify(compact, testMethod, testHTU); err == nil || !strings.Contains(err.Error(), "replay") {
		t.Fatalf("want jti replay, got %v", err)
	}
}

func TestReplayHTU(t *testing.T) {
	priv := testKey(t)
	uriA := "https://a.example.com/v1/foo"
	uriB := "https://b.example.com/v1/bar"
	compact, _, err := dpop.Mint(priv, testMethod, uriA)
	if err != nil {
		t.Fatal(err)
	}
	v := dpop.NewVerifier(time.Minute)
	if _, err := v.Verify(compact, testMethod, uriB); err == nil || !strings.Contains(err.Error(), "htu mismatch") {
		t.Fatalf("want htu mismatch, got %v", err)
	}
	if _, err := v.Verify(compact, testMethod, uriA); err != nil {
		t.Fatalf("bound uri should still verify once, got %v", err)
	}
	if _, err := v.Verify(compact, testMethod, uriA); err == nil || !strings.Contains(err.Error(), "replay") {
		t.Fatalf("want jti replay on second bound use, got %v", err)
	}
}

func TestHTMMismatch(t *testing.T) {
	priv := testKey(t)
	compact, _, err := dpop.Mint(priv, "POST", testHTU)
	if err != nil {
		t.Fatal(err)
	}
	v := dpop.NewVerifier(time.Minute)
	if _, err := v.Verify(compact, "GET", testHTU); err == nil || !strings.Contains(err.Error(), "htm mismatch") {
		t.Fatalf("want htm mismatch, got %v", err)
	}
}

func TestHTUNormalize(t *testing.T) {
	for _, tc := range []struct {
		a, b string
	}{
		{"https://api.example.com/v1/foo", "https://api.example.com:443/v1/foo"},
		{"https://api.example.com/v1/foo?x=1", "https://api.example.com/v1/foo"},
		{"https://api.example.com/v1/foo#frag", "https://api.example.com/v1/foo"},
	} {
		na, err := dpop.NormalizeHTU(tc.a)
		if err != nil {
			t.Fatalf("normalize %q: %v", tc.a, err)
		}
		nb, err := dpop.NormalizeHTU(tc.b)
		if err != nil {
			t.Fatalf("normalize %q: %v", tc.b, err)
		}
		if na != nb {
			t.Fatalf("normalize mismatch %q vs %q => %q vs %q", tc.a, tc.b, na, nb)
		}
	}
}

func TestIATTooOld(t *testing.T) {
	priv := testKey(t)
	compact, _, err := dpop.Mint(priv, testMethod, testHTU)
	if err != nil {
		t.Fatal(err)
	}
	base := time.Now()
	v := dpop.NewVerifier(2 * time.Second)
	v.Now = func() time.Time { return base }
	if _, err := v.Verify(compact, testMethod, testHTU); err != nil {
		t.Logf("first verify: %v", err)
	}
	v2 := dpop.NewVerifier(time.Second)
	v2.Now = func() time.Time { return base.Add(30 * time.Second) }
	compact2, _, err := dpop.Mint(priv, testMethod, testHTU)
	if err != nil {
		t.Fatal(err)
	}
	v2.Store = dpop.NewMemoryJTI()
	if _, err := v2.Verify(compact2, testMethod, testHTU); err == nil || !strings.Contains(err.Error(), "too old") {
		t.Fatalf("want iat too old, got %v", err)
	}
}

func TestBadSignature(t *testing.T) {
	priv := testKey(t)
	compact, _, err := dpop.Mint(priv, testMethod, testHTU)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(compact, ".")
	if len(parts) != 3 {
		t.Fatalf("parts=%d", len(parts))
	}
	sig := []byte(parts[2])
	sig[len(sig)-1] ^= 0x1
	parts[2] = string(sig)
	bad := strings.Join(parts, ".")
	v := dpop.NewVerifier(time.Minute)
	if _, err := v.Verify(bad, testMethod, testHTU); err == nil {
		t.Fatal("want verify failure")
	}
}
