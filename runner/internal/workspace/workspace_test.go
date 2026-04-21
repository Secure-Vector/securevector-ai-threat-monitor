package workspace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNewCreatesDirectory(t *testing.T) {
	ws, err := New("")
	if err != nil {
		t.Fatalf("New() error: %v", err)
	}
	defer ws.Cleanup()

	if ws.Path() == "" {
		t.Fatal("Path() returned empty string")
	}

	if !filepath.IsAbs(ws.Path()) {
		t.Fatalf("Path() is not absolute: %s", ws.Path())
	}

	if !strings.Contains(ws.Path(), "sv-session-") {
		t.Fatalf("Path() does not contain sv-session- prefix: %s", ws.Path())
	}

	info, err := os.Stat(ws.Path())
	if err != nil {
		t.Fatalf("workspace dir does not exist: %v", err)
	}
	if !info.IsDir() {
		t.Fatal("workspace path is not a directory")
	}
}

func TestNewWithCustomRoot(t *testing.T) {
	root := t.TempDir()
	ws, err := New(root)
	if err != nil {
		t.Fatalf("New(%s) error: %v", root, err)
	}
	defer ws.Cleanup()

	if !strings.HasPrefix(ws.Path(), root) {
		t.Fatalf("workspace %s not under root %s", ws.Path(), root)
	}
}

func TestCleanupRemovesDirectory(t *testing.T) {
	ws, err := New("")
	if err != nil {
		t.Fatalf("New() error: %v", err)
	}

	path := ws.Path()

	// Write a file inside
	if err := os.WriteFile(filepath.Join(path, "test.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	if err := ws.Cleanup(); err != nil {
		t.Fatalf("Cleanup() error: %v", err)
	}

	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("workspace dir still exists after cleanup: %s", path)
	}
}

func TestCleanupIdempotent(t *testing.T) {
	ws, err := New("")
	if err != nil {
		t.Fatalf("New() error: %v", err)
	}

	if err := ws.Cleanup(); err != nil {
		t.Fatalf("first Cleanup() error: %v", err)
	}
	if err := ws.Cleanup(); err != nil {
		t.Fatalf("second Cleanup() error: %v", err)
	}
}
