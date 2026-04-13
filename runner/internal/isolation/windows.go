//go:build windows

package isolation

import "os/exec"

// WindowsIsolator will implement job object and restricted token isolation.
// Phase 1: stub that applies no restrictions.
type WindowsIsolator struct{}

func New() Isolator {
	return &WindowsIsolator{}
}

func (w *WindowsIsolator) Name() string {
	return "windows-stub"
}

func (w *WindowsIsolator) Available() bool {
	return true
}

func (w *WindowsIsolator) Apply(cmd *exec.Cmd, opts Options) error {
	// Phase 2+: apply job objects, restricted tokens
	return nil
}

func (w *WindowsIsolator) Cleanup() error {
	return nil
}
