package agent

import (
	"strings"
	"testing"
)

func TestTokenHashStable(t *testing.T) {
	h := TokenHash("abcdefghijklmnopqrstuv")
	if len(h) != 64 {
		t.Fatalf("hash len %d", len(h))
	}
	if TokenHash("abcdefghijklmnopqrstuv") != h {
		t.Fatal("hash not stable")
	}
}

func TestValidateToken(t *testing.T) {
	if err := ValidateToken("short"); err == nil {
		t.Fatal("expected error")
	}
	if err := ValidateToken("abcdefghijklmnopqrstuv"); err != nil {
		t.Fatal(err)
	}
}

func TestEncodeDecodeBinary(t *testing.T) {
	frame, err := EncodeBinary(BinHChunk, "abc", []byte("hello"))
	if err != nil {
		t.Fatal(err)
	}
	kind, id, data, err := DecodeBinary(frame)
	if err != nil {
		t.Fatal(err)
	}
	if kind != BinHChunk || id != "abc" || string(data) != "hello" {
		t.Fatalf("got kind=%d id=%q data=%q", kind, id, data)
	}
}

func TestConfigAgentWSURL(t *testing.T) {
	c := Config{
		RelayURL:     "https://firstrule-relay.example.workers.dev",
		ConnectToken: "abcdefghijklmnopqrstuv",
		BackendURL:   "http://127.0.0.1:7920",
	}
	c, err := c.validate()
	if err != nil {
		t.Fatal(err)
	}
	u, err := c.agentWSURL()
	if err != nil {
		t.Fatal(err)
	}
	wantPrefix := "wss://firstrule-relay.example.workers.dev/agent?th="
	if u[:len(wantPrefix)] != wantPrefix {
		t.Fatalf("url %s", u)
	}
	if !strings.Contains(u, TokenHash(c.ConnectToken)) {
		t.Fatalf("missing hash in %s", u)
	}
}
