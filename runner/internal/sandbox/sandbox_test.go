package sandbox

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestRunEchoHello(t *testing.T) {
	profile := Profile{
		Timeout: 10 * time.Second,
	}

	result := Run(context.Background(), profile, []string{"echo", "hello"})

	if result.ExitCode != 0 {
		t.Fatalf("expected exit code 0, got %d (error: %s)", result.ExitCode, result.Error)
	}
	if strings.TrimSpace(result.Stdout) != "hello" {
		t.Fatalf("expected stdout 'hello', got %q", result.Stdout)
	}
	if result.TimedOut {
		t.Fatal("should not have timed out")
	}
	if result.DurationMs <= 0 {
		t.Fatal("duration should be positive")
	}
}

func TestRunTimeout(t *testing.T) {
	profile := Profile{
		Timeout: 1 * time.Second,
	}

	result := Run(context.Background(), profile, []string{"sleep", "30"})

	if !result.TimedOut {
		t.Fatal("expected timed_out=true")
	}
	if result.ExitCode != -1 {
		t.Fatalf("expected exit code -1 on timeout, got %d", result.ExitCode)
	}
}

func TestRunNoTimeout(t *testing.T) {
	profile := Profile{
		Timeout: 0, // no timeout
	}

	result := Run(context.Background(), profile, []string{"echo", "no-timeout"})

	if result.ExitCode != 0 {
		t.Fatalf("expected exit code 0, got %d (error: %s)", result.ExitCode, result.Error)
	}
	if strings.TrimSpace(result.Stdout) != "no-timeout" {
		t.Fatalf("expected stdout 'no-timeout', got %q", result.Stdout)
	}
}

func TestRunNonZeroExit(t *testing.T) {
	profile := Profile{
		Timeout: 10 * time.Second,
	}

	result := Run(context.Background(), profile, []string{"sh", "-c", "exit 42"})

	if result.ExitCode != 42 {
		t.Fatalf("expected exit code 42, got %d", result.ExitCode)
	}
}

func TestRunStderr(t *testing.T) {
	profile := Profile{
		Timeout: 10 * time.Second,
	}

	result := Run(context.Background(), profile, []string{"sh", "-c", "echo oops >&2"})

	if result.ExitCode != 0 {
		t.Fatalf("expected exit code 0, got %d", result.ExitCode)
	}
	if strings.TrimSpace(result.Stderr) != "oops" {
		t.Fatalf("expected stderr 'oops', got %q", result.Stderr)
	}
}

func TestRunNoCommand(t *testing.T) {
	profile := Profile{}

	result := Run(context.Background(), profile, nil)

	if result.ExitCode != 1 {
		t.Fatalf("expected exit code 1, got %d", result.ExitCode)
	}
	if result.Error == "" {
		t.Fatal("expected error message")
	}
}

func TestRunEnvFiltered(t *testing.T) {
	profile := Profile{
		Timeout: 10 * time.Second,
	}

	result := Run(context.Background(), profile, []string{"env"})

	if result.ExitCode != 0 {
		t.Fatalf("expected exit code 0, got %d (error: %s)", result.ExitCode, result.Error)
	}

	// HOME should be rewritten to workspace path
	for _, line := range strings.Split(result.Stdout, "\n") {
		if strings.HasPrefix(line, "HOME=") {
			if !strings.Contains(line, "sv-session-") {
				t.Fatalf("HOME should be rewritten to workspace, got: %s", line)
			}
		}
		if strings.HasPrefix(line, "AWS_") {
			t.Fatalf("AWS vars should be stripped, found: %s", line)
		}
		if strings.HasPrefix(line, "SSH_") {
			t.Fatalf("SSH vars should be stripped, found: %s", line)
		}
	}
}

func TestRunWorkspaceIsDir(t *testing.T) {
	profile := Profile{
		Timeout: 10 * time.Second,
	}

	result := Run(context.Background(), profile, []string{"pwd"})

	if result.ExitCode != 0 {
		t.Fatalf("expected exit code 0, got %d", result.ExitCode)
	}
	if !strings.Contains(result.Stdout, "sv-session-") {
		t.Fatalf("pwd should show sandbox workspace, got: %s", result.Stdout)
	}
}
