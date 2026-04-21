package workspace

import (
	"fmt"
	"os"
	"path/filepath"
)

// Workspace manages an isolated temporary directory for a sandbox session.
type Workspace struct {
	dir     string
	cleaned bool
}

// New creates a new isolated workspace under root.
// If root is empty, the system temp directory is used.
func New(root string) (*Workspace, error) {
	if root == "" {
		root = os.TempDir()
	}

	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("create workspace root %s: %w", root, err)
	}

	dir, err := os.MkdirTemp(root, "sv-session-")
	if err != nil {
		return nil, fmt.Errorf("create workspace temp dir: %w", err)
	}

	return &Workspace{dir: dir}, nil
}

// Path returns the absolute path to the workspace directory.
func (w *Workspace) Path() string {
	return w.dir
}

// Cleanup removes the workspace directory and all its contents.
func (w *Workspace) Cleanup() error {
	if w.cleaned {
		return nil
	}
	w.cleaned = true

	if w.dir == "" {
		return nil
	}

	// Sanity check: never remove root-level directories
	if len(w.dir) < 10 || !filepath.IsAbs(w.dir) {
		return fmt.Errorf("refusing to remove suspicious path: %s", w.dir)
	}

	return os.RemoveAll(w.dir)
}
