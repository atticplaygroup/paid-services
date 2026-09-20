// Package dpop mints and verifies self-issued Bearer DPoP JWTs (core claims only).
//
// Wire format: Authorization: Bearer <jwt>
// Header: alg=ES256, typ=dpop+jwt, jwk=<public>
// Claims: jti, iat (htm/htu/ath not required)
package dpop

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/lestrrat-go/jwx/v3/jwa"
	"github.com/lestrrat-go/jwx/v3/jwk"
	"github.com/lestrrat-go/jwx/v3/jws"
	"github.com/lestrrat-go/jwx/v3/jwt"
)

const (
	TypeDPoP      = "dpop+jwt"
	DefaultMaxAge = 60 * time.Second
	clockSkew     = 5 * time.Second
)

// Result is a verified Bearer DPoP JWT.
type Result struct {
	JKTBytes []byte
	JKT      string
	JTI      string
	IAT      time.Time
}

// JTIStore rejects replayed JTIs within a TTL window.
type JTIStore interface {
	// Seen reports whether jti was already consumed; if not, records it until expiry.
	Seen(jti string, expiry time.Time) bool
}

// MemoryJTI is an in-process JTI replay cache.
type MemoryJTI struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

// NewMemoryJTI returns an empty in-process JTI store.
func NewMemoryJTI() *MemoryJTI {
	return &MemoryJTI{seen: make(map[string]time.Time)}
}

// Seen implements JTIStore.
func (m *MemoryJTI) Seen(jti string, expiry time.Time) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	for k, exp := range m.seen {
		if !exp.After(now) {
			delete(m.seen, k)
		}
	}
	if exp, ok := m.seen[jti]; ok && exp.After(now) {
		return true
	}
	m.seen[jti] = expiry
	return false
}

// Verifier verifies self-issued Bearer DPoP JWTs.
type Verifier struct {
	MaxAge time.Duration
	Store  JTIStore
	Now    func() time.Time
}

// NewVerifier returns a verifier with maxAge (default 60s) and an in-process JTI store.
func NewVerifier(maxAge time.Duration) *Verifier {
	if maxAge <= 0 {
		maxAge = DefaultMaxAge
	}
	return &Verifier{
		MaxAge: maxAge,
		Store:  NewMemoryJTI(),
		Now:    time.Now,
	}
}

func (v *Verifier) maxAge() time.Duration {
	if v != nil && v.MaxAge > 0 {
		return v.MaxAge
	}
	return DefaultMaxAge
}

func (v *Verifier) now() time.Time {
	if v != nil && v.Now != nil {
		return v.Now()
	}
	return time.Now()
}

func (v *Verifier) store() JTIStore {
	if v != nil && v.Store != nil {
		return v.Store
	}
	return NewMemoryJTI()
}

// VerifyBearer verifies Authorization header value ("Bearer <jwt>" or raw jwt).
func (v *Verifier) VerifyBearer(authorization, method, htu string) (*Result, error) {
	raw, err := stripBearer(authorization)
	if err != nil {
		return nil, err
	}
	return v.Verify(raw, method, htu)
}

// Verify verifies a compact DPoP JWT and returns its jkt.
func (v *Verifier) Verify(compact, method, htu string) (*Result, error) {
	if v == nil {
		return nil, fmt.Errorf("dpop: nil verifier")
	}
	key, err := parseHeaderJWK(compact)
	if err != nil {
		return nil, err
	}
	claims, err := verifySigClaims(compact, key)
	if err != nil {
		return nil, err
	}
	if err := checkRequestBinding(claims.htm, claims.htu, method, htu); err != nil {
		return nil, err
	}
	if err := checkFreshness(claims.jti, claims.iat, v.maxAge(), v.now(), v.store()); err != nil {
		return nil, err
	}
	thumbBytes, err := jktFromJWK(key)
	if err != nil {
		return nil, err
	}
	thumb := base64.RawURLEncoding.EncodeToString(thumbBytes)
	return &Result{JKTBytes: thumbBytes, JKT: thumb, JTI: claims.jti, IAT: claims.iat}, nil
}

// HTU builds the RFC 9449 htu value (scheme + authority + path; no query/fragment).
func HTU(scheme, host, path string) (string, error) {
	scheme = strings.ToLower(strings.TrimSpace(scheme))
	host = strings.TrimSpace(host)
	path = strings.TrimSpace(path)
	if scheme == "" || host == "" {
		return "", fmt.Errorf("dpop: htu needs scheme and host")
	}
	if path == "" {
		path = "/"
	}
	if i := strings.IndexAny(path, "?#"); i >= 0 {
		path = path[:i]
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return NormalizeHTU((&url.URL{Scheme: scheme, Host: host, Path: path}).String())
}

// HTUFromRequest derives htu from an incoming HTTP request.
func HTUFromRequest(r *http.Request) (string, error) {
	if r == nil || r.URL == nil {
		return "", fmt.Errorf("dpop: nil request")
	}
	scheme := r.URL.Scheme
	if scheme == "" {
		if r.TLS != nil {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}
	host := r.Host
	if host == "" {
		host = r.URL.Host
	}
	return HTU(scheme, host, r.URL.Path)
}

// Mint signs a self-issued Bearer DPoP JWT for priv (ES256 / P-256).
func Mint(priv *ecdsa.PrivateKey, method, htu string) (compact string, jkt string, err error) {
	if priv == nil || priv.Curve != elliptic.P256() {
		return "", "", fmt.Errorf("dpop: need P-256 EC private key")
	}
	method = strings.TrimSpace(method)
	if method == "" {
		return "", "", fmt.Errorf("dpop: missing method")
	}
	htuNorm, err := NormalizeHTU(htu)
	if err != nil {
		return "", "", err
	}
	pubJWK, err := publicJWK(priv)
	if err != nil {
		return "", "", err
	}
	jkt, err = Thumbprint(&priv.PublicKey)
	if err != nil {
		return "", "", err
	}
	compact, err = signDPoP(priv, pubJWK, method, htuNorm)
	if err != nil {
		return "", "", err
	}
	return compact, jkt, nil
}

func stripBearer(authorization string) (string, error) {
	raw := strings.TrimSpace(authorization)
	if len(raw) >= 7 && strings.EqualFold(raw[:7], "bearer ") {
		raw = strings.TrimSpace(raw[7:])
	}
	if raw == "" {
		return "", fmt.Errorf("dpop: missing bearer token")
	}
	return raw, nil
}

func parseHeaderJWK(compact string) (jwk.Key, error) {
	msg, err := jws.Parse([]byte(compact))
	if err != nil {
		return nil, fmt.Errorf("dpop: parse jws: %w", err)
	}
	sigs := msg.Signatures()
	if len(sigs) != 1 {
		return nil, fmt.Errorf("dpop: want 1 signature, got %d", len(sigs))
	}
	hdrs := sigs[0].ProtectedHeaders()
	var typ string
	if err := hdrs.Get(jws.TypeKey, &typ); err != nil || !strings.EqualFold(typ, TypeDPoP) {
		return nil, fmt.Errorf("dpop: typ want %s", TypeDPoP)
	}
	var key jwk.Key
	if err := hdrs.Get(jws.JWKKey, &key); err != nil || key == nil {
		return nil, fmt.Errorf("dpop: missing header jwk")
	}
	if key.KeyType() != jwa.EC() {
		return nil, fmt.Errorf("dpop: jwk kty want EC")
	}
	return key, nil
}

type sigClaims struct {
	jti string
	iat time.Time
	htm string
	htu string
}

func verifySigClaims(compact string, key jwk.Key) (sigClaims, error) {
	verified, err := jws.Verify([]byte(compact), jws.WithKey(jwa.ES256(), key))
	if err != nil {
		return sigClaims{}, fmt.Errorf("dpop: verify: %w", err)
	}
	tok, err := jwt.Parse(verified, jwt.WithVerify(false), jwt.WithValidate(false))
	if err != nil {
		return sigClaims{}, fmt.Errorf("dpop: parse jwt: %w", err)
	}
	jti, ok := tok.JwtID()
	if !ok || strings.TrimSpace(jti) == "" {
		return sigClaims{}, fmt.Errorf("dpop: missing jti")
	}
	iat, ok := tok.IssuedAt()
	if !ok || iat.IsZero() {
		return sigClaims{}, fmt.Errorf("dpop: missing iat")
	}
	var htm, htu string
	if err := tok.Get("htm", &htm); err != nil || strings.TrimSpace(htm) == "" {
		return sigClaims{}, fmt.Errorf("dpop: missing htm")
	}
	if err := tok.Get("htu", &htu); err != nil || strings.TrimSpace(htu) == "" {
		return sigClaims{}, fmt.Errorf("dpop: missing htu")
	}
	return sigClaims{jti: jti, iat: iat, htm: htm, htu: htu}, nil
}

func checkRequestBinding(claimHTM, claimHTU, method, htu string) error {
	method = strings.TrimSpace(method)
	if method == "" {
		return fmt.Errorf("dpop: missing request method")
	}
	claimHTM = strings.TrimSpace(claimHTM)
	if claimHTM != method {
		return fmt.Errorf("dpop: htm mismatch")
	}
	normClaim, err := NormalizeHTU(claimHTU)
	if err != nil {
		return err
	}
	normExpected, err := NormalizeHTU(htu)
	if err != nil {
		return fmt.Errorf("dpop: invalid request htu: %w", err)
	}
	if normClaim != normExpected {
		return fmt.Errorf("dpop: htu mismatch")
	}
	return nil
}

func NormalizeHTU(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("dpop: invalid htu")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", fmt.Errorf("dpop: invalid htu")
	}
	u.Fragment = ""
	u.RawQuery = ""
	u.Scheme = strings.ToLower(u.Scheme)
	if u.Path == "" {
		u.Path = "/"
	} else {
		u.Path = u.EscapedPath()
		if u.Path == "" {
			u.Path = "/"
		}
	}
	u.Host = normalizeHTUHost(u.Scheme, u.Host)
	return u.String(), nil
}

func normalizeHTUHost(scheme, host string) string {
	hostname := host
	port := ""
	if h, p, err := net.SplitHostPort(host); err == nil {
		hostname = h
		port = p
	}
	if port == "" {
		return hostname
	}
	if (scheme == "https" && port == "443") || (scheme == "http" && port == "80") {
		return hostname
	}
	return net.JoinHostPort(hostname, port)
}

func checkFreshness(jti string, iat time.Time, maxAge time.Duration, now time.Time, store JTIStore) error {
	if iat.After(now.Add(clockSkew)) {
		return fmt.Errorf("dpop: iat in future")
	}
	if now.Sub(iat) > maxAge+clockSkew {
		return fmt.Errorf("dpop: iat too old (max_age=%s)", maxAge)
	}
	if store.Seen(jti, iat.Add(maxAge+clockSkew)) {
		return fmt.Errorf("dpop: jti replay")
	}
	return nil
}

func jktFromJWK(key jwk.Key) ([]byte, error) {
	var pub any
	if err := jwk.Export(key, &pub); err != nil {
		return nil, fmt.Errorf("dpop: export jwk: %w", err)
	}
	thumb, err := ThumbprintBytes(pub)
	if err != nil {
		return nil, fmt.Errorf("dpop: jkt: %w", err)
	}
	return thumb, nil
}

func publicJWK(priv *ecdsa.PrivateKey) (jwk.Key, error) {
	pubJWK, err := jwk.PublicKeyOf(priv)
	if err != nil {
		return nil, fmt.Errorf("dpop: public jwk: %w", err)
	}
	_ = pubJWK.Remove(jwk.AlgorithmKey)
	return pubJWK, nil
}

func signDPoP(priv *ecdsa.PrivateKey, pubJWK jwk.Key, htm, htu string) (string, error) {
	tok, err := jwt.NewBuilder().
		JwtID(randomJTI()).
		IssuedAt(time.Now()).
		Claim("htm", htm).
		Claim("htu", htu).
		Build()
	if err != nil {
		return "", err
	}
	hdrs := jws.NewHeaders()
	if err := hdrs.Set(jws.TypeKey, TypeDPoP); err != nil {
		return "", err
	}
	if err := hdrs.Set(jws.JWKKey, pubJWK); err != nil {
		return "", err
	}
	signed, err := jwt.Sign(tok, jwt.WithKey(jwa.ES256(), priv, jws.WithProtectedHeaders(hdrs)))
	if err != nil {
		return "", err
	}
	return string(signed), nil
}

func randomJTI() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return base64.RawURLEncoding.EncodeToString(b[:])
}

// ThumbprintBytes returns the raw RFC 7638 JWK thumbprint (SHA-256, 32 bytes).
func ThumbprintBytes(pub any) ([]byte, error) {
	key, err := jwk.Import(pub)
	if err != nil {
		return nil, fmt.Errorf("jwk import: %w", err)
	}
	sum, err := key.Thumbprint(crypto.SHA256)
	if err != nil {
		return nil, fmt.Errorf("jwk thumbprint: %w", err)
	}
	return sum, nil
}

// Thumbprint returns the RFC 7638 JWK thumbprint (base64url) of pub.
// Same path as auth0/go-jwt-middleware (jwk.Key.Thumbprint SHA-256).
func Thumbprint(pub any) (string, error) {
	sum, err := ThumbprintBytes(pub)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(sum), nil
}
