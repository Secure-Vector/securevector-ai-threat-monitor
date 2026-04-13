package isolation

import "os/exec"

// Options configures isolation constraints applied to the sandboxed process.
type Options struct {
	WorkspacePath string
	AllowNetwork  bool
	MaxMemoryMB   int64
	MaxCPUPercent int
	MaxProcesses  int
}

// Isolator applies OS-level isolation to a process before it starts.
type Isolator interface {
	// Name returns the isolator backend name (e.g., "linux-seccomp", "darwin-sandbox", "noop").
	Name() string

	// Available reports whether this isolator can run on the current system.
	Available() bool

	// Apply configures isolation on the exec.Cmd before it is started.
	Apply(cmd *exec.Cmd, opts Options) error

	// Cleanup releases any isolation resources after the process exits.
	Cleanup() error
}
