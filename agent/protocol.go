package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
)

// Binary frame kinds for protocol >= 2.
const (
	BinHChunk = 1
	BinHBody  = 2
	BinWBin   = 3
	BinWText  = 4
)

const (
	defaultProtocol = 3
	bodyWindow      = 4 * 1024 * 1024
	defaultStreamWindow = 1024 * 1024
)

var tokenRe = regexp.MustCompile(`^[A-Za-z0-9_-]{16,128}$`)

// TokenHash returns sha256 hex of the connect token.
func TokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// ValidateToken checks the public connect-token alphabet/length.
func ValidateToken(token string) error {
	if !tokenRe.MatchString(token) {
		return fmt.Errorf("connect token must match [A-Za-z0-9_-]{16,128}")
	}
	return nil
}

type registerFrame struct {
	T         string `json:"t"`
	TokenHash string `json:"tokenHash"`
	Name      string `json:"name,omitempty"`
	Ver       string `json:"ver,omitempty"`
	Key       string `json:"key,omitempty"`
	Proto     int    `json:"proto,omitempty"`
}

type registeredFrame struct {
	T      string `json:"t"`
	Proto  int    `json:"proto,omitempty"`
	Window int    `json:"window,omitempty"`
}

type errorFrame struct {
	T       string `json:"t"`
	Message string `json:"message"`
}

type hreqFrame struct {
	T       string    `json:"t"`
	ID      string    `json:"id"`
	Method  string    `json:"method"`
	Path    string    `json:"path"`
	Headers headerMap `json:"headers"`
	B       string    `json:"b,omitempty"`
	Stream  bool      `json:"stream,omitempty"`
}

type hresFrame struct {
	T       string              `json:"t"`
	ID      string              `json:"id"`
	Status  int                 `json:"status"`
	Headers map[string][]string `json:"headers"`
}

// headerMap accepts Node-style string values or multi-value arrays.
type headerMap map[string][]string


type idFrame struct {
	T       string `json:"t"`
	ID      string `json:"id"`
	B       string `json:"b,omitempty"`
	S       string `json:"s,omitempty"`
	Message string `json:"message,omitempty"`
	N       int    `json:"n,omitempty"`
	Code    int    `json:"code,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

type ackFrame struct {
	T  string `json:"t"`
	ID string `json:"id"`
	N  int    `json:"n"`
}
