package sandbox

import (
	"strings"
)

// dangerousPrefixes are env var prefixes stripped by default.
var dangerousPrefixes = []string{
	"AWS_",
	"GCP_",
	"GCLOUD_",
	"GOOGLE_APPLICATION_",
	"AZURE_",
	"SSH_",
	"GITHUB_TOKEN",
	"GH_TOKEN",
	"GITLAB_",
	"DOCKER_",
}

// dangerousExact are env var names stripped by default.
var dangerousExact = []string{
	"SSH_AUTH_SOCK",
	"DATABASE_URL",
	"REDIS_URL",
	"MONGO_URL",
	"MONGODB_URI",
}

// dangerousSubstrings are substrings that cause env vars to be stripped.
var dangerousSubstrings = []string{
	"_SECRET",
	"_PASSWORD",
	"_PRIVATE_KEY",
	"_CREDENTIALS",
}

// safeDefaults are env vars always kept (not stripped).
var safeDefaults = []string{
	"PATH",
	"USER",
	"LOGNAME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TERM",
	"SHELL",
	"TMPDIR",
	"TZ",
	"XDG_RUNTIME_DIR",
}

// rewriteToWorkspace are env vars whose values get replaced with the workspace path.
var rewriteToWorkspace = []string{
	"HOME",
	"OPENCLAW_HOME",
	"OPENCLAW_STATE_DIR",
	"OPENCLAW_CONFIG_PATH",
}

// FilterEnv filters and rewrites environment variables for the sandbox.
// It strips dangerous vars, rewrites home-like vars to the workspace path,
// and only keeps safe defaults plus any explicitly allowed vars.
func FilterEnv(environ []string, allowedExtra []string, workspacePath string) []string {
	allowed := make(map[string]bool)
	for _, k := range safeDefaults {
		allowed[k] = true
	}
	for _, k := range allowedExtra {
		allowed[k] = true
	}
	for _, k := range rewriteToWorkspace {
		allowed[k] = true
	}

	rewrite := make(map[string]bool)
	for _, k := range rewriteToWorkspace {
		rewrite[k] = true
	}

	var result []string
	for _, entry := range environ {
		key, _, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}

		if isDangerous(key) && !allowed[key] {
			continue
		}

		if rewrite[key] {
			result = append(result, key+"="+workspacePath)
			continue
		}

		if allowed[key] {
			result = append(result, entry)
		}
	}

	return result
}

// injectProxyEnv rewrites LLM provider base URL env vars to point at
// the credential proxy. This is the core of Mode B: the agent thinks
// it's talking to OpenAI/Anthropic, but actually hits the proxy which
// injects credentials from the vault.
func injectProxyEnv(env []string, proxyURL string) []string {
	// LLM SDK base URL env vars to rewrite
	llmBaseURLVars := []string{
		"OPENAI_BASE_URL",
		"OPENAI_API_BASE",
		"ANTHROPIC_BASE_URL",
		"GROQ_BASE_URL",
		"MISTRAL_BASE_URL",
	}

	// Strip any existing API key vars (they should NOT be in the sandbox)
	apiKeyPatterns := []string{
		"OPENAI_API_KEY",
		"ANTHROPIC_API_KEY",
		"GROQ_API_KEY",
		"MISTRAL_API_KEY",
	}

	rewrite := make(map[string]bool)
	for _, v := range llmBaseURLVars {
		rewrite[v] = true
	}

	strip := make(map[string]bool)
	for _, v := range apiKeyPatterns {
		strip[v] = true
	}

	var result []string
	for _, entry := range env {
		key, _, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		if strip[key] {
			continue // strip API keys in broker mode
		}
		if rewrite[key] {
			continue // will be added below with proxy URL
		}
		result = append(result, entry)
	}

	// Add proxy URL for all LLM base URL vars
	for _, v := range llmBaseURLVars {
		result = append(result, v+"="+proxyURL)
	}

	return result
}

func isDangerous(key string) bool {
	upper := strings.ToUpper(key)

	for _, prefix := range dangerousPrefixes {
		if strings.HasPrefix(upper, prefix) {
			return true
		}
	}

	for _, exact := range dangerousExact {
		if upper == exact {
			return true
		}
	}

	for _, sub := range dangerousSubstrings {
		if strings.Contains(upper, sub) {
			return true
		}
	}

	return false
}
