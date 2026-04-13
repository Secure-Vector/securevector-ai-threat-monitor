package proxy

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// Secret defines a credential with a domain-scoped injection policy.
type Secret struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Value          string   `json:"value"`
	AllowedDomains []string `json:"allowed_domains"`
	HeaderName     string   `json:"header_name"`     // e.g., "Authorization"
	HeaderTemplate string   `json:"header_template"` // e.g., "Bearer {value}"
}

// Vault holds secrets loaded from a vault file.
type Vault struct {
	Secrets       []Secret `json:"secrets"`
	DefaultPolicy string   `json:"default_policy"` // "block" or "allow"
}

// LoadVault reads and parses a vault JSON file.
func LoadVault(path string) (*Vault, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read vault file: %w", err)
	}

	var vault Vault
	if err := json.Unmarshal(data, &vault); err != nil {
		return nil, fmt.Errorf("parse vault file: %w", err)
	}

	// Validate
	for i, s := range vault.Secrets {
		if s.Name == "" {
			return nil, fmt.Errorf("secret at index %d has no name", i)
		}
		if s.Value == "" {
			return nil, fmt.Errorf("secret %q has no value", s.Name)
		}
		if len(s.AllowedDomains) == 0 {
			return nil, fmt.Errorf("secret %q has no allowed_domains", s.Name)
		}
		if s.HeaderName == "" {
			vault.Secrets[i].HeaderName = "Authorization"
		}
		if s.HeaderTemplate == "" {
			vault.Secrets[i].HeaderTemplate = "Bearer {value}"
		}
	}

	if vault.DefaultPolicy == "" {
		vault.DefaultPolicy = "block"
	}

	return &vault, nil
}

// GetForDomain returns secrets whose allowed_domains match the given host.
func (v *Vault) GetForDomain(host string) []Secret {
	// Strip port if present
	if idx := strings.LastIndex(host, ":"); idx != -1 {
		host = host[:idx]
	}
	host = strings.ToLower(host)

	var matched []Secret
	for _, s := range v.Secrets {
		for _, d := range s.AllowedDomains {
			if strings.ToLower(d) == host {
				matched = append(matched, s)
				break
			}
		}
	}
	return matched
}

// ResolveHeader returns the header value with {value} replaced by the secret.
func (s *Secret) ResolveHeader() string {
	return strings.ReplaceAll(s.HeaderTemplate, "{value}", s.Value)
}
