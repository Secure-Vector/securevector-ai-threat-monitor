// Package proxy implements a lightweight credential-injecting reverse proxy
// for LLM API providers. It runs outside the sandbox and injects API keys
// from a vault into outbound requests, so secrets never enter the sandbox.
//
// No TLS MITM is needed: the agent sends plain HTTP to localhost, and the
// proxy makes the real HTTPS call to the provider with credentials attached.
package proxy

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// knownProviders maps base URL path prefixes to real upstream endpoints.
// When the agent calls localhost:PORT/v1/chat/completions, the proxy
// routes it to the appropriate provider based on vault domain config.
var knownProviders = map[string]string{
	"api.openai.com":    "https://api.openai.com",
	"api.anthropic.com": "https://api.anthropic.com",
	"api.groq.com":      "https://api.groq.com",
	"api.mistral.ai":    "https://api.mistral.ai",
	"api.x.ai":          "https://api.x.ai",
}

// Proxy is a credential-injecting HTTP reverse proxy.
type Proxy struct {
	vault    *Vault
	server   *http.Server
	port     int
	mu       sync.Mutex
	requests int
}

// New creates a new proxy backed by the given vault.
func New(vault *Vault) *Proxy {
	return &Proxy{vault: vault}
}

// Start starts the proxy on a random available port and returns
// the port number. The proxy runs until Stop is called.
func (p *Proxy) Start() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("listen: %w", err)
	}

	p.port = listener.Addr().(*net.TCPAddr).Port

	mux := http.NewServeMux()
	mux.HandleFunc("/", p.handleRequest)

	p.server = &http.Server{
		Handler:      mux,
		ReadTimeout:  120 * time.Second,
		WriteTimeout: 120 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		if err := p.server.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Printf("sv-proxy: server error: %v", err)
		}
	}()

	return p.port, nil
}

// Stop gracefully shuts down the proxy.
func (p *Proxy) Stop() {
	if p.server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		p.server.Shutdown(ctx)
	}
}

// Port returns the port the proxy is listening on.
func (p *Proxy) Port() int {
	return p.port
}

// RequestCount returns the number of requests handled.
func (p *Proxy) RequestCount() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.requests
}

func (p *Proxy) handleRequest(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	p.requests++
	p.mu.Unlock()

	// Determine target provider from vault
	// The proxy forwards to the first provider that has a secret configured
	target, secret := p.resolveTarget(r)
	if target == "" {
		if p.vault.DefaultPolicy == "block" {
			http.Error(w, "sv-proxy: no provider configured for this request", http.StatusForbidden)
			return
		}
		// allow mode: forward without credentials (unlikely useful)
		http.Error(w, "sv-proxy: no provider matched", http.StatusBadGateway)
		return
	}

	// Build upstream URL
	upstreamURL := target + r.URL.Path
	if r.URL.RawQuery != "" {
		upstreamURL += "?" + r.URL.RawQuery
	}

	// Create upstream request
	upstreamReq, err := http.NewRequestWithContext(r.Context(), r.Method, upstreamURL, r.Body)
	if err != nil {
		http.Error(w, fmt.Sprintf("sv-proxy: create request: %v", err), http.StatusInternalServerError)
		return
	}

	// Copy headers from agent request
	for key, values := range r.Header {
		for _, v := range values {
			upstreamReq.Header.Add(key, v)
		}
	}

	// Remove hop-by-hop headers
	upstreamReq.Header.Del("Host")
	upstreamReq.Header.Del("Connection")

	// Inject credential from vault
	if secret != nil {
		upstreamReq.Header.Set(secret.HeaderName, secret.ResolveHeader())
	}

	// Forward request
	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(upstreamReq)
	if err != nil {
		http.Error(w, fmt.Sprintf("sv-proxy: upstream error: %v", err), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	// Copy response headers
	for key, values := range resp.Header {
		for _, v := range values {
			w.Header().Add(key, v)
		}
	}
	w.WriteHeader(resp.StatusCode)

	// Stream response body
	io.Copy(w, resp.Body)
}

// resolveTarget finds the upstream URL and credential for this request.
// It checks vault secrets to determine which provider to use.
func (p *Proxy) resolveTarget(r *http.Request) (string, *Secret) {
	// Check if agent sent a specific provider hint via X-Provider header
	providerHint := r.Header.Get("X-Provider")
	r.Header.Del("X-Provider") // don't forward internal header

	for domain, upstream := range knownProviders {
		secrets := p.vault.GetForDomain(domain)
		if len(secrets) == 0 {
			continue
		}

		// If provider hint matches, use this one
		if providerHint != "" && !strings.Contains(strings.ToLower(domain), strings.ToLower(providerHint)) {
			continue
		}

		return upstream, &secrets[0]
	}

	// No hint: return first provider with a secret
	if providerHint == "" {
		for domain, upstream := range knownProviders {
			secrets := p.vault.GetForDomain(domain)
			if len(secrets) > 0 {
				return upstream, &secrets[0]
			}
		}
	}

	return "", nil
}
