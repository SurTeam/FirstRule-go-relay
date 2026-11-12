package agent

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestHandleHTTPStreamedBodyReachesBackend(t *testing.T) {
	var (
		mu   sync.Mutex
		body []byte
	)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		mu.Lock()
		body = append([]byte(nil), b...)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer backend.Close()

	// Drain agent→relay frames so writeJSON does not block on hack/hres.
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		go func() {
			defer c.Close(websocket.StatusNormalClosure, "")
			for {
				if _, _, err := c.Read(context.Background()); err != nil {
					return
				}
			}
		}()
	}))
	defer relay.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	wsURL := "ws" + relay.URL[len("http"):]
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	s := &Session{
		cfg:     Config{BackendURL: backend.URL},
		conn:    conn,
		proto:   3,
		window:  defaultStreamWindow,
		unacked: make(map[string]int),
		waiting: make(map[string]chan struct{}),
		http:    make(map[string]context.CancelFunc),
		uploads: make(map[string]*bodyUpload),
		sockets: make(map[string]*websocket.Conn),
		closed:  make(chan struct{}),
		client:  backend.Client(),
	}

	const id = "req-1"
	payload := []byte(`{"text":"hello from stream"}`)
	pr, pw := io.Pipe()
	s.uploads[id] = &bodyUpload{pr: pr, pw: pw}

	done := make(chan struct{})
	go func() {
		defer close(done)
		s.handleHTTP(context.Background(), hreqFrame{
			T:      "hreq",
			ID:     id,
			Method: http.MethodPost,
			Path:   "/v1/messages",
			Headers: headerMap{
				"content-type": []string{"application/json"},
			},
			Stream: true,
		})
	}()

	if err := s.writeUpload(context.Background(), id, payload); err != nil {
		t.Fatal(err)
	}
	s.finishUpload(id, nil)

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("handleHTTP did not finish")
	}

	mu.Lock()
	got := append([]byte(nil), body...)
	mu.Unlock()
	if !bytes.Equal(got, payload) {
		t.Fatalf("backend body %q want %q", got, payload)
	}
}
