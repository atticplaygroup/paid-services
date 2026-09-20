package exchange

import (
	"bytes"
	"crypto/ed25519"
	"fmt"
	"time"

	"github.com/atticplaygroup/paid-services/infrastructure/pkg/utils"
	"golang.org/x/crypto/blake2b"
)

type Clock interface {
	Now() time.Time
}

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

type Auth struct {
	Secret             ed25519.PrivateKey
	MessageAuthTimeout time.Duration
	SessionTimeout     time.Duration
	Clock              Clock
}

func NewAuth(conf *Config) (*Auth, error) {
	return &Auth{
		Secret:             conf.TokenSigningPrivateKey,
		MessageAuthTimeout: conf.MessageAuthTimeout,
		SessionTimeout:     conf.SessionTimeout,
		Clock:              realClock{},
	}, nil
}

func (a *Auth) GetChallenge(address string, startTime time.Time) (*[32]byte, error) {
	addressBytes, err := utils.HexToBytes32(address)
	if err != nil {
		return nil, err
	}
	timestampBytes, err := startTime.UTC().MarshalBinary()
	if err != nil {
		return nil, err
	}
	concatBytes := utils.ConcatBytes(a.Secret, addressBytes, timestampBytes)
	challenge := blake2b.Sum256(concatBytes)
	return &challenge, nil
}

type SuiAuthMessage struct {
	StartTime time.Time `json:"start_time" binding:"required"`
	Challenge []byte    `json:"challenge" binding:"required"`
	Address   string    `json:"address" binding:"required"`
	Signature string    `json:"signature" binding:"required"`
}

type ParsedAuthMessage struct {
	Payload []byte
	Address []byte
}

func (a *Auth) VerifySuiAuthMessagePayload(message *SuiAuthMessage) error {
	expectedBytes, err := a.GetChallenge(message.Address, message.StartTime)
	if err != nil {
		return fmt.Errorf("get challenge failed: %w", err)
	}
	if !bytes.Equal(expectedBytes[:], message.Challenge) {
		return fmt.Errorf("invalid challenge bytes %v: Expected %v", message.Challenge, expectedBytes[:])
	}
	now := a.Clock.Now()
	if message.StartTime.After(now) {
		return fmt.Errorf("decodedMessage.StartTime (%v) > now (%v)", message.StartTime, now)
	}
	if message.StartTime.Add(a.MessageAuthTimeout).Before(now) {
		return fmt.Errorf(
			"signing timeout: start %v, timeout %v, now %v",
			message.StartTime, a.MessageAuthTimeout, now,
		)
	}
	return nil
}

func (a *Auth) EncodeMessage(startTime time.Time, challenge []byte, address string) (*SuiAuthMessage, error) {
	authMessage := SuiAuthMessage{
		StartTime: startTime,
		Challenge: challenge,
		Address:   address,
	}
	return &authMessage, nil
}
