package sandbox

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"github.com/Secure-Vector/sv-sandbox/internal/isolation"
	"github.com/Secure-Vector/sv-sandbox/internal/proxy"
	"github.com/Secure-Vector/sv-sandbox/internal/workspace"
)

// boundedBuffer is a bytes.Buffer that stops accepting writes after max bytes.
type boundedBuffer struct {
	buf bytes.Buffer
	max int64
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	if b.max > 0 && int64(b.buf.Len()+len(p)) > b.max {
		remaining := b.max - int64(b.buf.Len())
		if remaining > 0 {
			b.buf.Write(p[:remaining])
		}
		return len(p), nil // pretend we wrote it all to avoid broken pipe
	}
	return b.buf.Write(p)
}

func (b *boundedBuffer) String() string {
	return b.buf.String()
}

// Run executes a command inside an isolated sandbox workspace.
func Run(ctx context.Context, profile Profile, command []string) *Result {
	if len(command) == 0 {
		return &Result{ExitCode: 1, Error: "no command specified"}
	}

	maxOutput := profile.MaxOutputBytes
	if maxOutput == 0 {
		maxOutput = DefaultMaxOutputBytes
	}

	// 1. Create workspace
	ws, err := workspace.New(profile.WorkspaceRoot)
	if err != nil {
		return &Result{ExitCode: 1, Error: fmt.Sprintf("create workspace: %v", err)}
	}
	if !profile.KeepWorkspace {
		defer ws.Cleanup()
	}

	// 2. Copy agent config directories into workspace
	copyAgentConfigs(ws.Path())

	// 3. Start credential proxy if broker mode
	var proxyURL string
	var miniProxy *proxy.Proxy
	if profile.Broker {
		if profile.ProxyURL != "" {
			// External proxy (SecureVector on 8742) — use it directly
			proxyURL = profile.ProxyURL
		} else if profile.VaultPath != "" {
			// Standalone mode — start built-in mini proxy
			vault, vaultErr := proxy.LoadVault(profile.VaultPath)
			if vaultErr != nil {
				return &Result{ExitCode: 1, Error: fmt.Sprintf("load vault: %v", vaultErr)}
			}
			miniProxy = proxy.New(vault)
			port, proxyErr := miniProxy.Start()
			if proxyErr != nil {
				return &Result{ExitCode: 1, Error: fmt.Sprintf("start proxy: %v", proxyErr)}
			}
			defer miniProxy.Stop()
			proxyURL = fmt.Sprintf("http://127.0.0.1:%d", port)
		}
	}

	// 4. Filter env
	env := FilterEnv(os.Environ(), profile.AllowedEnv, ws.Path())

	// 5. Inject proxy URL for LLM base URLs if broker mode
	if proxyURL != "" {
		env = injectProxyEnv(env, proxyURL)
	}

	// 6. Set up timeout
	var cancel context.CancelFunc
	if profile.Timeout > 0 {
		ctx, cancel = context.WithTimeout(ctx, profile.Timeout)
		defer cancel()
	}

	// 7. Build command
	cmd := exec.CommandContext(ctx, command[0], command[1:]...)
	cmd.Dir = ws.Path()
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	// 8. Apply isolation
	isolator := isolation.New()
	if err := isolator.Apply(cmd, isolation.Options{
		WorkspacePath: ws.Path(),
	}); err != nil {
		return &Result{
			ExitCode:  1,
			Workspace: ws.Path(),
			Error:     fmt.Sprintf("apply isolation (%s): %v", isolator.Name(), err),
		}
	}
	defer isolator.Cleanup()

	// 9. Capture output
	stdout := &boundedBuffer{max: maxOutput}
	stderr := &boundedBuffer{max: maxOutput}
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	// 10. Run
	start := time.Now()
	err = cmd.Start()
	if err != nil {
		return &Result{
			ExitCode:   1,
			Workspace:  ws.Path(),
			DurationMs: time.Since(start).Milliseconds(),
			Error:      fmt.Sprintf("start command: %v", err),
		}
	}

	err = cmd.Wait()
	duration := time.Since(start)
	timedOut := ctx.Err() == context.DeadlineExceeded

	// Kill entire process group on timeout
	if timedOut {
		if pgid, pgErr := syscall.Getpgid(cmd.Process.Pid); pgErr == nil {
			syscall.Kill(-pgid, syscall.SIGKILL)
		}
	}

	// 11. Build result
	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			exitCode = 1
		}
	}

	result := &Result{
		ExitCode:   exitCode,
		Stdout:     stdout.String(),
		Stderr:     stderr.String(),
		Workspace:  ws.Path(),
		DurationMs: duration.Milliseconds(),
		TimedOut:   timedOut,
	}

	if timedOut {
		result.Error = "process timed out"
		result.ExitCode = -1
	}

	return result
}

// copyAgentConfigs copies known agent configuration directories from the
// user's real home into the sandbox workspace. This allows agents like
// OpenClaw and Claude Code to find their auth/config without exposing
// the full home directory.
func copyAgentConfigs(workspacePath string) {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}

	// Known agent config directories (read-only copies)
	configs := []struct {
		src string // relative to real HOME
		dst string // relative to workspace
	}{
		{".openclaw", ".openclaw"},   // OpenClaw auth + agent config
		{".claude", ".claude"},       // Claude Code config
		{".codex", ".codex"},         // Codex config
	}

	for _, cfg := range configs {
		srcPath := filepath.Join(home, cfg.src)
		dstPath := filepath.Join(workspacePath, cfg.dst)

		info, err := os.Stat(srcPath)
		if err != nil || !info.IsDir() {
			continue
		}

		if err := copyDir(srcPath, dstPath); err != nil {
			// Non-fatal: agent may still work without config
			continue
		}
	}
}

// copyDir recursively copies a directory tree. Files are copied, not linked,
// so the sandbox can modify them without affecting the originals.
func copyDir(src, dst string) error {
	return filepath.Walk(src, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip files we can't read
		}

		rel, err := filepath.Rel(src, path)
		if err != nil {
			return nil
		}
		target := filepath.Join(dst, rel)

		if info.IsDir() {
			return os.MkdirAll(target, 0o755)
		}

		// Skip large files (>10MB) — likely caches, not config
		if info.Size() > 10*1024*1024 {
			return nil
		}

		return copyFile(path, target)
	})
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}

	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, in)
	return err
}
