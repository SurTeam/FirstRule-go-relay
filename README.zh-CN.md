# FirstRule Relay

[English](README.md) | 简体中文

为 **[FirstRule](https://github.com/SurTeam/FirstRule-go)** 提供可自托管的反向隧道，
让桌面上的 Agent 能从其他设备访问，无需端口转发或 VPN。

```
桌面 FirstRule ──主动发起 WSS──▶  你的中继  ◀──HTTPS/WSS── 远程客户端
```

桌面端主动连到中继并保持连接；远程客户端的 HTTP / SSE / WebSocket 经中继转发到桌面。
中继不落盘，只按 `sha256(connect token)` 路由。

推荐用 **Cloudflare Workers 免费计划** 部署。

线协议基于 [alma-relay](https://github.com/yetone/alma-relay)（MIT）。

## 部署

### 方式 A：Cloudflare Workers（推荐，免费）

```bash
git clone https://github.com/SurTeam/FirstRule-go-relay.git
cd FirstRule-go-relay
npm install
npx wrangler deploy        # 输出 https://firstrule-relay.<you>.workers.dev
```

使用支持 WebSocket 休眠的 SQLite Durable Objects，空闲配对几乎不消耗配额。
可选：`npx wrangler secret put RELAY_REGISTRATION_KEY` 限制谁能开隧道。

### 方式 B：Docker 自动 HTTPS

```bash
git clone https://github.com/SurTeam/FirstRule-go-relay.git
cd FirstRule-go-relay
cp .env.example .env       # 设置 RELAY_DOMAIN=relay.example.com
docker compose up -d
```

### 方式 C：本地 / 自有反代

```bash
npm start                  # :8787
```

健康检查：`curl https://<relay>/healthz`。

## 连接 FirstRule 桌面端

1. 部署中继并记下 `https://` 地址。
2. 桌面端按 [docs/INTEGRATION.md](docs/INTEGRATION.md) 启用远程访问。
3. 其他设备访问 `https://<relay>/c/<token>/...`，流量会桥到桌面本地 API。

Go 拨号器在 [`agent/`](agent/)。

## 开发

```bash
npm install && npm test
cd agent && go test ./...
```

## 许可

[MIT](LICENSE)。实现派生自 [alma-relay](https://github.com/yetone/alma-relay)，见 [NOTICE](NOTICE)。
