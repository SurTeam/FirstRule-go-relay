# FirstRule relay dialer (Go)

Desktop-side client that registers with a FirstRule Relay and proxies
tunneled HTTP / WebSocket traffic to a loopback FirstRule API.

```go
cfg := agent.Config{
    RelayURL:     "https://firstrule-relay.example.workers.dev",
    ConnectToken: token,
    BackendURL:   "http://127.0.0.1:7920",
    Key:          registrationKey, // optional
}
sess, err := agent.Dial(ctx, cfg)
```

See [../docs/INTEGRATION.md](../docs/INTEGRATION.md) and [../docs/PROTOCOL.md](../docs/PROTOCOL.md).
