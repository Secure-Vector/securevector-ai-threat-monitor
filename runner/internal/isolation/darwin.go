//go:build darwin

package isolation

import "os/exec"

// DarwinIsolator will implement sandbox-exec profile isolation.
// Phase 1: stub that applies no restrictions.
type DarwinIsolator struct{}

func New() Isolator {
	return &DarwinIsolator{}
}

func (d *DarwinIsolator) Name() string {
	return "darwin-stub"
}

func (d *DarwinIsolator) Available() bool {
	return true
}

func (d *DarwinIsolator) Apply(cmd *exec.Cmd, opts Options) error {
	// Phase 2+: apply sandbox-exec profiles
	return nil
}

func (d *DarwinIsolator) Cleanup() error {
	return nil
}
