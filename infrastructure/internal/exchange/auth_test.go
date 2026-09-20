package exchange

import (
	"crypto/ed25519"
	"testing"
	"time"
)

type fakeClock struct {
	now time.Time
}

func (clock fakeClock) Now() time.Time {
	return clock.now
}

func TestGetChallengeAndVerify(t *testing.T) {
	address := "0x1111111111111111111111111111111111111111111111111111111111111111"
	auth := &Auth{
		Secret:             make(ed25519.PrivateKey, ed25519.PrivateKeySize),
		MessageAuthTimeout: time.Minute,
		Clock:              fakeClock{now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)},
	}
	start := auth.Clock.Now().Add(-time.Second)
	challenge, err := auth.GetChallenge(address, start)
	if err != nil {
		t.Fatalf("GetChallenge: %v", err)
	}
	if err := auth.VerifySuiAuthMessagePayload(&SuiAuthMessage{
		StartTime: start,
		Challenge: challenge[:],
		Address:   address,
	}); err != nil {
		t.Fatalf("VerifySuiAuthMessagePayload: %v", err)
	}
}

func TestVerifyChallengeFailures(t *testing.T) {
	address := "0x1111111111111111111111111111111111111111111111111111111111111111"
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	auth := &Auth{
		Secret:             make(ed25519.PrivateKey, ed25519.PrivateKeySize),
		MessageAuthTimeout: time.Minute,
		Clock:              fakeClock{now: now},
	}
	challenge, err := auth.GetChallenge(address, now)
	if err != nil {
		t.Fatalf("GetChallenge: %v", err)
	}
	if err := auth.VerifySuiAuthMessagePayload(&SuiAuthMessage{StartTime: now, Challenge: []byte("bad"), Address: address}); err == nil {
		t.Fatal("expected bad challenge rejection")
	}
	if err := auth.VerifySuiAuthMessagePayload(&SuiAuthMessage{StartTime: now.Add(time.Minute), Challenge: challenge[:], Address: address}); err == nil {
		t.Fatal("expected future start rejection")
	}
	if err := auth.VerifySuiAuthMessagePayload(&SuiAuthMessage{StartTime: now.Add(-2 * time.Minute), Challenge: challenge[:], Address: address}); err == nil {
		t.Fatal("expected timeout rejection")
	}
	if _, err := auth.GetChallenge("bad-address", now); err == nil {
		t.Fatal("expected bad address rejection")
	}
}
