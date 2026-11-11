package agent

import (
	"fmt"
	"net/url"
	"strings"
)

// Config configures a desktop dialer session.
type Config struct {
	// RelayURL is the https:// relay origin (workers.dev or custom domain).
	RelayURL string
	// ConnectToken is the raw connect code shared with remote clients.
	ConnectToken string
	// BackendURL is the loopback FirstRule API, e.g. http://127.0.0.1:7920.
	BackendURL string
	// Name is reported in the register frame.
	Name string
	// Version is reported in the register frame.
	Version string
	// Key is an optional RELAY_REGISTRATION_KEY or minted relay JWT.
	Key string
	// Protocol is the newest protocol to offer (1..3). Zero means 3.
	Protocol int
}

func (c Config) validate() (Config, error) {
	if strings.TrimSpace(c.RelayURL) == "" {
		return c, fmt.Errorf("RelayURL is required")
	}
	u, err := url.Parse(c.RelayURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return c, fmt.Errorf("RelayURL must be an http(s) origin")
	}
	if err := ValidateToken(c.ConnectToken); err != nil {
		return c, err
	}
	if strings.TrimSpace(c.BackendURL) == "" {
		return c, fmt.Errorf("BackendURL is required")
	}
	bu, err := url.Parse(c.BackendURL)
	if err != nil || (bu.Scheme != "http" && bu.Scheme != "https") || bu.Host == "" {
		return c, fmt.Errorf("BackendURL must be an http(s) URL")
	}
	if c.Name == "" {
		c.Name = "firstrule-desktop"
	}
	if c.Version == "" {
		c.Version = "0.1.0"
	}
	if c.Protocol == 0 {
		c.Protocol = defaultProtocol
	}
	if c.Protocol < 1 || c.Protocol > 3 {
		return c, fmt.Errorf("Protocol must be 1..3")
	}
	return c, nil
}

func (c Config) agentWSURL() (string, error) {
	u, err := url.Parse(c.RelayURL)
	if err != nil {
		return "", err
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	default:
		return "", fmt.Errorf("unsupported relay scheme %q", u.Scheme)
	}
	u.Path = "/agent"
	q := u.Query()
	q.Set("th", TokenHash(c.ConnectToken))
	u.RawQuery = q.Encode()
	return u.String(), nil
}
