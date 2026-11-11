# FirstRule Relay

English | [简体中文](README.zh-CN.md)

Self-hostable reverse tunnel for **[FirstRule](https://github.com/SurTeam/FirstRule-go)** remote access.
Reach a desktop FirstRule agent from another device without port forwarding or a VPN.

```
desktop FirstRule ──outbound WSS──▶  your relay  ◀──HTTPS/WSS── remote client
```

The desktop dials **out** to the relay and keeps the connection open. Remote
clients send HTTP, SSE and WebSocket traffic to the relay; the relay forwards
it through that outbound tunnel. The relay stores nothing on disk and only
routes by `sha256(connect token)`.

This repository is the relay + desktop dialer used by FirstRule. Prefer the
**Cloudflare Workers** free plan deployment below.

Based on the wire protocol pioneered by [alma-relay](https://github.com/yetone/alma-relay) (MIT).

## Deploy

### Option A: Cloudflare Workers (recommended, free)

```bash
git clone https://github.com/SurTeam/FirstRule-go-relay.git
cd FirstRule-go-relay
npm install
npx wrangler deploy        # prints https://firstrule-relay.<you>.workers.dev
```

Uses SQLite-backed Durable Objects with WebSocket hibernation on the Workers
**Free** plan. Idle pairings cost next to nothing. TLS and `*.workers.dev` are
included. For a custom domain, uncomment `routes` in `wrangler.jsonc`.

Optional gate so strangers cannot open tunnels on your Worker:

```bash
npx wrangler secret put RELAY_REGISTRATION_KEY
```

### Option B: Docker with automatic HTTPS

```bash
git clone https://github.com/SurTeam/FirstRule-go-relay.git
cd FirstRule-go-relay
cp .env.example .env       # set RELAY_DOMAIN=relay.example.com
docker compose up -d
```

### Option C: Local / behind your own proxy

```bash
npm start                  # Node edition on :8787
# or
docker run -d --restart unless-stopped -p 127.0.0.1:8787:8787 \
  ghcr.io/surteam/firstrule-relay
```

Check with `curl https://<relay>/healthz`.

## Connect a FirstRule desktop

1. Deploy the relay and note its `https://` URL.
2. On the desktop, start FirstRule with remote access enabled (see
   [docs/INTEGRATION.md](docs/INTEGRATION.md)), pointing at that URL and your
   connect token / registration key.
3. From another device, call `https://<relay>/c/<token>/...` — the relay
   bridges to the desktop local API.

The dialer lives in Go under [`agent/`](agent/) (`github.com/SurTeam/FirstRule-go-relay/agent`).

## Configuration

| Variable | Meaning |
| --- | --- |
| `RELAY_REGISTRATION_KEY` | Shared key desktops must present before they can register |
| `RELAY_TOKEN_SECRET` | HS256 secret for per-user signed relay tokens (takes precedence) |
| `RELAY_TOKEN_MESSAGE` | Message shown when a desktop lacks a valid token |
| `PORT` / `HOST` | Node listen address (`8787` / `0.0.0.0`) |
| `MAX_BODY_MB` | Request-body cap in MB |
| `RELAY_PROTOCOL` | Newest protocol offered (`3`) |
| `LOCATION_HINT` | Cloudflare only: `apac` / `enam` / `weur` … |

Mint a per-user token:

```bash
RELAY_TOKEN_SECRET=… npm run mint-token -- alice 365
```

## Development

```bash
npm install
npm start                    # Node edition on :8787
npx wrangler dev             # Cloudflare edition locally

npm test                     # e2e against Node
npm run test:cloudflare      # e2e against wrangler dev

cd agent && go test ./...
```

| Path | Role |
| --- | --- |
| `index.mjs` | Node / Docker edition |
| `cloudflare/worker.mjs` | Cloudflare Workers + Durable Objects |
| `shared.mjs` | Shared protocol helpers |
| `docs/PROTOCOL.md` | Wire protocol |
| `docs/INTEGRATION.md` | FirstRule desktop / client integration |
| `agent/` | Go dialer that registers with the relay and proxies a local HTTP API |

## License

[MIT](LICENSE). Relay implementation derived from [alma-relay](https://github.com/yetone/alma-relay);
see [NOTICE](NOTICE).
