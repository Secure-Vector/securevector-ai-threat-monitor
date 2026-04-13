package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/Secure-Vector/sv-sandbox/internal/sandbox"
)

var version = "dev"

func main() {
	timeout := flag.Duration("timeout", sandbox.DefaultTimeout, "execution timeout (0 = no timeout)")
	workspaceRoot := flag.String("workspace", "", "workspace root directory (default: system temp)")
	allowEnv := flag.String("allow-env", "", "comma-separated env vars to pass through")
	broker := flag.Bool("broker", false, "Mode B: credentials stay outside sandbox, injected by proxy")
	vault := flag.String("vault", "", "path to secrets vault JSON file (Mode B)")
	proxyURL := flag.String("proxy-url", "", "external proxy URL e.g. http://localhost:8742 (Mode B with SecureVector)")
	jsonOutput := flag.Bool("json", false, "output result as JSON")
	keep := flag.Bool("keep", false, "keep workspace after exit")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println("sv-sandbox", version)
		os.Exit(0)
	}

	command := flag.Args()
	if len(command) == 0 {
		fmt.Fprintln(os.Stderr, "usage: sv-sandbox [flags] -- command [args...]")
		fmt.Fprintln(os.Stderr, "")
		fmt.Fprintln(os.Stderr, "Mode A (classic):  sv-sandbox --allow-env OPENAI_API_KEY -- agent")
		fmt.Fprintln(os.Stderr, "Mode B (secure):   sv-sandbox --broker --vault secrets.json -- agent")
		fmt.Fprintln(os.Stderr, "Mode B + SV proxy: sv-sandbox --broker --proxy-url http://localhost:8742 -- agent")
		os.Exit(1)
	}

	if *broker && *vault == "" && *proxyURL == "" {
		fmt.Fprintln(os.Stderr, "sv-sandbox: --broker requires --vault or --proxy-url")
		os.Exit(1)
	}

	// Parse allowed env vars
	var allowed []string
	if *allowEnv != "" {
		for _, v := range strings.Split(*allowEnv, ",") {
			v = strings.TrimSpace(v)
			if v != "" {
				allowed = append(allowed, v)
			}
		}
	}

	profile := sandbox.Profile{
		AllowedEnv:     allowed,
		Timeout:        *timeout,
		WorkspaceRoot:  *workspaceRoot,
		MaxOutputBytes: sandbox.DefaultMaxOutputBytes,
		KeepWorkspace:  *keep,
		Broker:         *broker,
		VaultPath:      *vault,
		ProxyURL:       *proxyURL,
	}

	// Handle signals for clean shutdown
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	result := sandbox.Run(ctx, profile, command)

	if *jsonOutput {
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		enc.Encode(result)
	} else {
		if result.Stdout != "" {
			fmt.Fprint(os.Stdout, result.Stdout)
		}
		if result.Stderr != "" {
			fmt.Fprint(os.Stderr, result.Stderr)
		}
		if result.Error != "" {
			fmt.Fprintf(os.Stderr, "sv-runner: %s\n", result.Error)
		}
		if result.TimedOut {
			fmt.Fprintf(os.Stderr, "sv-runner: process timed out after %dms\n", result.DurationMs)
		}
	}

	if result.ExitCode < 0 {
		os.Exit(1)
	}
	os.Exit(result.ExitCode)
}
