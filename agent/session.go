package agent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Session is a live desktop registration against a relay.
type Session struct {
	cfg    Config
	conn   *websocket.Conn
	proto  int
	window int

	mu       sync.Mutex
	unacked  map[string]int
	waiting  map[string]chan struct{}
	http     map[string]context.CancelFunc
	sockets  map[string]*websocket.Conn
	closed   chan struct{}
	closeErr error
	client   *http.Client
}

// Dial connects to the relay, registers, and starts serving the local backend
// until ctx is cancelled or the relay closes the agent socket.
func Dial(ctx context.Context, cfg Config) (*Session, error) {
	cfg, err := cfg.validate()
	if err != nil {
		return nil, err
	}
	wsURL, err := cfg.agentWSURL()
	if err != nil {
		return nil, err
	}

	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPClient: &http.Client{Timeout: 0},
	})
	if err != nil {
		return nil, fmt.Errorf("dial relay: %w", err)
	}
	conn.SetReadLimit(32 << 20)

	s := &Session{
		cfg:     cfg,
		conn:    conn,
		proto:   1,
		window:  defaultStreamWindow,
		unacked: make(map[string]int),
		waiting: make(map[string]chan struct{}),
		http:    make(map[string]context.CancelFunc),
		sockets: make(map[string]*websocket.Conn),
		closed:  make(chan struct{}),
		client:  &http.Client{Timeout: 0},
	}

	reg := registerFrame{
		T:         "register",
		TokenHash: TokenHash(cfg.ConnectToken),
		Name:      cfg.Name,
		Ver:       cfg.Version,
		Key:       cfg.Key,
	}
	if cfg.Protocol >= 2 {
		reg.Proto = cfg.Protocol
	}
	if err := s.writeJSON(ctx, reg); err != nil {
		_ = conn.Close(websocket.StatusGoingAway, "register failed")
		return nil, err
	}

	_, data, err := conn.Read(ctx)
	if err != nil {
		_ = conn.Close(websocket.StatusGoingAway, "register read failed")
		return nil, fmt.Errorf("read register reply: %w", err)
	}
	var envelope struct {
		T string `json:"t"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		_ = conn.Close(websocket.StatusGoingAway, "bad register reply")
		return nil, fmt.Errorf("register reply: %w", err)
	}
	switch envelope.T {
	case "registered":
		var rf registeredFrame
		if err := json.Unmarshal(data, &rf); err != nil {
			_ = conn.Close(websocket.StatusGoingAway, "bad registered")
			return nil, err
		}
		if cfg.Protocol >= 2 && rf.Proto >= 2 {
			s.proto = cfg.Protocol
			if rf.Proto < s.proto {
				s.proto = rf.Proto
			}
		}
		if s.proto >= 3 && rf.Window > 0 {
			s.window = rf.Window
		}
	case "error":
		var ef errorFrame
		_ = json.Unmarshal(data, &ef)
		_ = conn.Close(websocket.StatusPolicyViolation, "rejected")
		return nil, fmt.Errorf("relay rejected registration: %s", ef.Message)
	default:
		_ = conn.Close(websocket.StatusGoingAway, "unexpected register reply")
		return nil, fmt.Errorf("unexpected register reply %q", envelope.T)
	}

	go s.loop(ctx)
	return s, nil
}

// Protocol returns the negotiated protocol version.
func (s *Session) Protocol() int { return s.proto }

// Done is closed when the session ends.
func (s *Session) Done() <-chan struct{} { return s.closed }

// Err returns the session termination error, if any.
func (s *Session) Err() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closeErr
}

// Close terminates the agent socket.
func (s *Session) Close() error {
	return s.conn.Close(websocket.StatusNormalClosure, "bye")
}

func (s *Session) loop(ctx context.Context) {
	defer s.shutdown(nil)
	for {
		typ, data, err := s.conn.Read(ctx)
		if err != nil {
			s.shutdown(err)
			return
		}
		if typ == websocket.MessageBinary {
			if err := s.onBinary(ctx, data); err != nil {
				s.shutdown(err)
				return
			}
			continue
		}
		var envelope struct {
			T string `json:"t"`
		}
		if err := json.Unmarshal(data, &envelope); err != nil {
			continue
		}
		if err := s.onFrame(ctx, envelope.T, data); err != nil {
			s.shutdown(err)
			return
		}
	}
}

func (s *Session) shutdown(err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	select {
	case <-s.closed:
		return
	default:
		if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, io.EOF) {
			s.closeErr = err
		}
		for _, cancel := range s.http {
			cancel()
		}
		for id, c := range s.sockets {
			_ = c.Close(websocket.StatusGoingAway, "agent closed")
			delete(s.sockets, id)
		}
		close(s.closed)
	}
}

func (s *Session) onFrame(ctx context.Context, t string, data []byte) error {
	switch t {
	case "hreq":
		var f hreqFrame
		if err := json.Unmarshal(data, &f); err != nil {
			return err
		}
		go s.handleHTTP(ctx, f)
	case "hcancel":
		var f idFrame
		if err := json.Unmarshal(data, &f); err != nil {
			return err
		}
		s.cancelHTTP(f.ID)
	case "hreqend":
		// streamed body complete; handled via body pumps
		return nil
	case "wopen":
		var f idFrame
		// path is required; decode loosely
		var full struct {
			T    string `json:"t"`
			ID   string `json:"id"`
			Path string `json:"path"`
		}
		if err := json.Unmarshal(data, &full); err != nil {
			return err
		}
		f.ID, f.S = full.ID, full.Path
		go s.handleWS(ctx, full.ID, full.Path)
	case "wmsg":
		var f idFrame
		if err := json.Unmarshal(data, &f); err != nil {
			return err
		}
		return s.forwardToLocalWS(f)
	case "wclose":
		var f idFrame
		if err := json.Unmarshal(data, &f); err != nil {
			return err
		}
		s.closeLocalWS(f.ID, f.Code, f.Reason)
	case "ack":
		var f ackFrame
		if err := json.Unmarshal(data, &f); err != nil {
			return err
		}
		s.onAck(f.ID, f.N)
	default:
		return nil
	}
	return nil
}

func (s *Session) onBinary(ctx context.Context, frame []byte) error {
	kind, id, data, err := DecodeBinary(frame)
	if err != nil {
		return err
	}
	switch kind {
	case BinHBody:
		// streamed request body; attach to pending request via side channel if needed
		_ = ctx
		_ = id
		_ = data
		return nil
	case BinWBin, BinWText:
		s.mu.Lock()
		local := s.sockets[id]
		s.mu.Unlock()
		if local == nil {
			return nil
		}
		msgType := websocket.MessageBinary
		if kind == BinWText {
			msgType = websocket.MessageText
		}
		writeCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		return local.Write(writeCtx, msgType, data)
	default:
		return nil
	}
}

func (s *Session) handleHTTP(parent context.Context, f hreqFrame) {
	reqCtx, cancel := context.WithCancel(parent)
	s.mu.Lock()
	s.http[f.ID] = cancel
	s.mu.Unlock()
	defer func() {
		cancel()
		s.mu.Lock()
		delete(s.http, f.ID)
		s.mu.Unlock()
	}()

	body, err := decodeBody(f.B)
	if err != nil {
		_ = s.writeJSON(parent, idFrame{T: "herr", ID: f.ID, Message: err.Error()})
		return
	}

	backend, err := url.Parse(s.cfg.BackendURL)
	if err != nil {
		_ = s.writeJSON(parent, idFrame{T: "herr", ID: f.ID, Message: err.Error()})
		return
	}
	path := f.Path
	if path == "" {
		path = "/"
	}
	target, err := backend.Parse(path)
	if err != nil {
		_ = s.writeJSON(parent, idFrame{T: "herr", ID: f.ID, Message: err.Error()})
		return
	}
	target.Scheme, target.Host = backend.Scheme, backend.Host

	var bodyReader io.Reader
	if len(body) > 0 {
		bodyReader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(reqCtx, f.Method, target.String(), bodyReader)
	if err != nil {
		_ = s.writeJSON(parent, idFrame{T: "herr", ID: f.ID, Message: err.Error()})
		return
	}
	for k, vals := range f.Headers {
		lk := strings.ToLower(k)
		if lk == "host" || lk == "connection" || lk == "content-length" || lk == "transfer-encoding" {
			continue
		}
		for _, v := range vals {
			req.Header.Add(k, v)
		}
	}

	res, err := s.client.Do(req)
	if err != nil {
		if reqCtx.Err() != nil {
			return
		}
		_ = s.writeJSON(parent, idFrame{T: "herr", ID: f.ID, Message: err.Error()})
		return
	}
	defer res.Body.Close()

	headers := map[string][]string{}
	for k, vals := range res.Header {
		headers[k] = append([]string(nil), vals...)
	}
	if err := s.writeJSON(parent, hresFrame{T: "hres", ID: f.ID, Status: res.StatusCode, Headers: headers}); err != nil {
		return
	}

	buf := make([]byte, 64*1024)
	for {
		n, readErr := res.Body.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			if err := s.sendBody(parent, f.ID, chunk); err != nil {
				return
			}
		}
		if readErr == io.EOF {
			_ = s.writeJSON(parent, idFrame{T: "hend", ID: f.ID})
			return
		}
		if readErr != nil {
			_ = s.writeJSON(parent, idFrame{T: "herr", ID: f.ID, Message: readErr.Error()})
			return
		}
	}
}

func (s *Session) sendBody(ctx context.Context, id string, payload []byte) error {
	if err := s.waitWindow(ctx, id, len(payload)); err != nil {
		return err
	}
	if s.proto >= 2 {
		frame, err := EncodeBinary(BinHChunk, id, payload)
		if err != nil {
			return err
		}
		if err := s.conn.Write(ctx, websocket.MessageBinary, frame); err != nil {
			return err
		}
	} else {
		if err := s.writeJSON(ctx, idFrame{T: "hchunk", ID: id, B: base64.StdEncoding.EncodeToString(payload)}); err != nil {
			return err
		}
	}
	s.spent(id, len(payload))
	return nil
}

func (s *Session) handleWS(parent context.Context, id, path string) {
	backend, err := url.Parse(s.cfg.BackendURL)
	if err != nil {
		_ = s.writeJSON(parent, idFrame{T: "werr", ID: id, Message: err.Error()})
		return
	}
	if path == "" {
		path = "/"
	}
	target, err := backend.Parse(path)
	if err != nil {
		_ = s.writeJSON(parent, idFrame{T: "werr", ID: id, Message: err.Error()})
		return
	}
	switch backend.Scheme {
	case "https":
		target.Scheme = "wss"
	default:
		target.Scheme = "ws"
	}
	target.Host = backend.Host

	local, _, err := websocket.Dial(parent, target.String(), nil)
	if err != nil {
		_ = s.writeJSON(parent, idFrame{T: "werr", ID: id, Message: err.Error()})
		return
	}
	s.mu.Lock()
	s.sockets[id] = local
	s.mu.Unlock()
	if err := s.writeJSON(parent, idFrame{T: "wopened", ID: id}); err != nil {
		s.closeLocalWS(id, 1011, "open ack failed")
		return
	}

	go func() {
		defer s.closeLocalWS(id, 1000, "")
		for {
			typ, data, err := local.Read(parent)
			if err != nil {
				_ = s.writeJSON(context.Background(), idFrame{T: "wclose", ID: id, Code: 1011, Reason: err.Error()})
				return
			}
			if err := s.sendWS(parent, id, data, typ == websocket.MessageBinary); err != nil {
				return
			}
		}
	}()
}

func (s *Session) sendWS(ctx context.Context, id string, payload []byte, binary bool) error {
	if err := s.waitWindow(ctx, id, len(payload)); err != nil {
		return err
	}
	if s.proto >= 2 {
		kind := byte(BinWText)
		if binary {
			kind = BinWBin
		}
		frame, err := EncodeBinary(kind, id, payload)
		if err != nil {
			return err
		}
		if err := s.conn.Write(ctx, websocket.MessageBinary, frame); err != nil {
			return err
		}
	} else if binary {
		if err := s.writeJSON(ctx, idFrame{T: "wmsg", ID: id, B: base64.StdEncoding.EncodeToString(payload)}); err != nil {
			return err
		}
	} else {
		if err := s.writeJSON(ctx, idFrame{T: "wmsg", ID: id, S: string(payload)}); err != nil {
			return err
		}
	}
	s.spent(id, len(payload))
	return nil
}

func (s *Session) forwardToLocalWS(f idFrame) error {
	s.mu.Lock()
	local := s.sockets[f.ID]
	s.mu.Unlock()
	if local == nil {
		return nil
	}
	var (
		payload []byte
		typ     websocket.MessageType
		err     error
	)
	if f.B != "" {
		payload, err = base64.StdEncoding.DecodeString(f.B)
		typ = websocket.MessageBinary
	} else {
		payload = []byte(f.S)
		typ = websocket.MessageText
	}
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return local.Write(ctx, typ, payload)
}

func (s *Session) closeLocalWS(id string, code int, reason string) {
	s.mu.Lock()
	local := s.sockets[id]
	delete(s.sockets, id)
	s.mu.Unlock()
	if local == nil {
		return
	}
	status := websocket.StatusCode(code)
	if status == 0 {
		status = websocket.StatusNormalClosure
	}
	_ = local.Close(status, reason)
}

func (s *Session) cancelHTTP(id string) {
	s.mu.Lock()
	cancel := s.http[id]
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (s *Session) spent(id string, n int) {
	if s.proto < 3 || n <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.unacked[id] += n
}

func (s *Session) onAck(id string, n int) {
	if s.proto < 3 || n <= 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.unacked[id] -= n
	if s.unacked[id] <= 0 {
		delete(s.unacked, id)
	}
	if ch := s.waiting[id]; ch != nil && s.unacked[id] < s.window {
		delete(s.waiting, id)
		close(ch)
	}
}

func (s *Session) waitWindow(ctx context.Context, id string, n int) error {
	if s.proto < 3 {
		return nil
	}
	for {
		s.mu.Lock()
		if s.unacked[id] < s.window {
			s.mu.Unlock()
			return nil
		}
		ch := s.waiting[id]
		if ch == nil {
			ch = make(chan struct{})
			s.waiting[id] = ch
		}
		s.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-s.closed:
			return errors.New("session closed")
		case <-ch:
		}
		_ = n
	}
}

func (s *Session) writeJSON(ctx context.Context, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return s.conn.Write(ctx, websocket.MessageText, b)
}

func decodeBody(b64 string) ([]byte, error) {
	if b64 == "" {
		return nil, nil
	}
	return base64.StdEncoding.DecodeString(b64)
}
