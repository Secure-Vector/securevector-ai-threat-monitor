package sandbox

import "time"

const (
	DefaultTimeout        = 5 * time.Minute
	DefaultMaxOutputBytes = 10 * 1024 * 1024 // 10MB
)

// Profile configures how the sandbox runs a process.
type Profile struct {
	// AllowedEnv lists env var names to pass through to the sandboxed process.
	AllowedEnv []string

	// Timeout is the maximum wall-clock time for the process.
	// Zero means no timeout.
	Timeout time.Duration

	// WorkspaceRoot is the base directory for creating session workspaces.
	// Empty means use the system temp directory.
	WorkspaceRoot string

	// MaxOutputBytes caps stdout and stderr capture size.
	MaxOutputBytes int64

	// KeepWorkspace prevents cleanup of the workspace after exit.
	KeepWorkspace bool

	// Broker enables Mode B: credentials stay outside the sandbox.
	// When true, a mini proxy is started to inject credentials.
	Broker bool

	// VaultPath is the path to the secrets vault JSON file (Mode B).
	VaultPath string

	// ProxyURL is an external proxy URL (e.g., SecureVector on :8742).
	// When set with Broker=true, uses the external proxy instead of
	// the built-in mini proxy. Gets threat scanning + audit for free.
	ProxyURL string
}

// Result holds the outcome of a sandboxed execution.
type Result struct {
	ExitCode   int    `json:"exit_code"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	Workspace  string `json:"workspace"`
	DurationMs int64  `json:"duration_ms"`
	TimedOut   bool   `json:"timed_out"`
	Error      string `json:"error,omitempty"`
}
