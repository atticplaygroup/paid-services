package server

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
)

// HandleJWKS serves the Ed25519 public key used to sign BuyToken JWTs.
// Account services fetch this at https://{VALID_EXCHANGE_ENDPOINT}/.well-known/jwks.json
func (s *Server) HandleJWKS(w http.ResponseWriter, _ *http.Request) {
	pub := s.config.TokenSigningPrivateKey.Public().(ed25519.PublicKey)
	doc := map[string]any{
		"keys": []map[string]string{{
			"kty": "OKP",
			"crv": "Ed25519",
			"alg": "EdDSA",
			"use": "sig",
			"kid": s.config.TokenSigningKeyId,
			"x":   base64.RawURLEncoding.EncodeToString(pub),
		}},
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(doc); err != nil {
		log.Printf("jwks encode: %v", err)
	}
}
