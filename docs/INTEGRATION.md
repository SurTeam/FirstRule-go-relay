# FirstRule integration

This relay is an opaque reverse tunnel. FirstRule remote access has three parts:

1. **Relay** (this repo) — Cloudflare Worker or Node process.
2. **Desktop dialer** (`agent/` in this repo) — runs beside FirstRule, dials
   `wss://<relay>/agent?th=<sha256(token)>`, registers, and proxies tunneled
   HTTP/WebSocket frames to a loopback API.
3. **Local API** — served by FirstRule (or a sidecar) on loopback; remote
   clients reach it as `https://<relay>/c/<token>/<path>`.

```
remote client
   │  HTTPS/WSS /c/<token>/v1/...
   ▼
FirstRule Relay (Cloudflare DO / Node)
   │  agent socket frames: hreq / hres / hchunk / wopen / …
   ▼
desktop dialer  ──http://127.0.0.1:<port>──▶  FirstRule local API
```

## Connect token

- Generate a high-entropy token locally (`[A-Za-z0-9_-]{16,128}`).
- Desktop registers with `tokenHash = sha256_hex(token)`.
- Clients address the desktop with the raw token in the URL path.
- Rotating the token revokes previous remote access.

Never commit real tokens. Examples in docs use placeholders only.

## Desktop dialer (Go)

```go
import "github.com/SurTeam/FirstRule-go-relay/agent"

cfg := agent.Config{
    RelayURL:     "https://firstrule-relay.example.workers.dev",
    ConnectToken: token,          // raw token; dialer hashes it
    BackendURL:   "http://127.0.0.1:7920",
    Name:         "firstrule-desktop",
    Key:          registrationKey, // optional RELAY_REGISTRATION_KEY / JWT
    Protocol:     3,
}
sess, err := agent.Dial(ctx, cfg)
```

The dialer speaks protocol 1–3 as negotiated by the relay (see [PROTOCOL.md](PROTOCOL.md)).

## Suggested local API surface

FirstRule should expose a loopback-only HTTP API that the dialer forwards.
A minimal useful surface:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Liveness |
| `GET` | `/v1/session` | Current session summary |
| `POST` | `/v1/messages` | Enqueue a user message |
| `GET` | `/v1/events` | SSE stream of agent/tool events |
| `POST` | `/v1/permissions/{id}` | Approve/deny a pending permission |

Exact routes are owned by the FirstRule main repository; the relay does not
interpret them.

## Security notes

- Always serve the relay over HTTPS.
- Prefer setting `RELAY_REGISTRATION_KEY` or per-user `RELAY_TOKEN_SECRET` tokens
  so arbitrary clients cannot open empty tunnels on your Worker.
- Bind the local API to `127.0.0.1` only; the dialer is the sole ingress.
- Treat the connect token like a password; regenerate to revoke access.
- Optional application-level E2E can ride inside the tunnel opaquely; the relay
  only routes ciphertext or plaintext frames it is given.

## Cloudflare free-plan checklist

1. `npm install && npx wrangler deploy`
2. Optional: `npx wrangler secret put RELAY_REGISTRATION_KEY`
3. Point FirstRule dialer at the printed `*.workers.dev` URL
4. `curl https://<worker>/healthz` → `{"ok":true,"edition":"cloudflare",...}`
