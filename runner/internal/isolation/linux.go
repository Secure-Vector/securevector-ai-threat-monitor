//go:build linux

package isolation

import "os/exec"

// LinuxIsolator will implement seccomp, landlock, and namespace isolation.
// Phase 1: stub that applies no restrictions.
type LinuxIsolator struct{}

func New() Isolator {
	return &LinuxIsolator{}
}

func (l *LinuxIsolator) Name() string {
	return "linux-stub"
}

func (l *LinuxIsolator) Available() bool {
	return true
}

func (l *LinuxIsolator) Apply(cmd *exec.Cmd, opts Options) error {
	// Phase 2+: apply seccomp filters, landlock rules, namespace isolation
	return nil
}

func (l *LinuxIsolator) Cleanup() error {
	return nil
}
