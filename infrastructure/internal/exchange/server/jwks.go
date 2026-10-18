package server

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
)

type publicJWK struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	Alg string `json:"alg"`
	Use string `json:"use"`
	Kid string `json:"kid"`
	X   string `json:"x"`
}

// HandleJWKS serves the Ed25519 public key used to sign BuyPoints JWTs.
// Account services fetch this at https://{VALID_EXCHANGE_ENDPOINT}/.well-known/jwks.json
func (s *Server) HandleJWKS(w http.ResponseWriter, _ *http.Request) {
	pub := s.config.TokenSigningPrivateKey.Public().(ed25519.PublicKey)
	keys := []publicJWK{{
		Kty: "OKP", Crv: "Ed25519", Alg: "EdDSA", Use: "sig",
		Kid: s.config.TokenSigningKeyId,
		X:   base64.RawURLEncoding.EncodeToString(pub),
	}}
	seen := map[string]struct{}{s.config.TokenSigningKeyId: {}}
	if s.config.TokenRetiredPublicKeys != "" {
		var retired []publicJWK
		if err := json.Unmarshal([]byte(s.config.TokenRetiredPublicKeys), &retired); err != nil {
			http.Error(w, "invalid retired JWKS configuration", http.StatusInternalServerError)
			return
		}
		for _, key := range retired {
			x, err := base64.RawURLEncoding.DecodeString(key.X)
			if err != nil || len(x) != ed25519.PublicKeySize || key.Kid == "" {
				http.Error(w, "invalid retired JWKS key", http.StatusInternalServerError)
				return
			}
			if _, duplicate := seen[key.Kid]; duplicate {
				http.Error(w, "duplicate JWKS key id", http.StatusInternalServerError)
				return
			}
			seen[key.Kid] = struct{}{}
			key.Kty, key.Crv, key.Alg, key.Use = "OKP", "Ed25519", "EdDSA", "sig"
			keys = append(keys, key)
		}
	}
	doc := map[string]any{
		"keys": keys,
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(doc); err != nil {
		log.Printf("jwks encode: %v", err)
	}
}
