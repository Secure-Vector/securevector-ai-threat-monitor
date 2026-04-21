package sandbox

import (
	"strings"
	"testing"
)

func envMap(env []string) map[string]string {
	m := make(map[string]string)
	for _, e := range env {
		k, v, _ := strings.Cut(e, "=")
		m[k] = v
	}
	return m
}

func TestFilterEnvStripsAWSKeys(t *testing.T) {
	input := []string{
		"PATH=/usr/bin",
		"AWS_SECRET_ACCESS_KEY=supersecret",
		"AWS_ACCESS_KEY_ID=AKIA123",
		"USER=testuser",
	}

	result := envMap(FilterEnv(input, nil, "/tmp/ws"))

	if _, ok := result["AWS_SECRET_ACCESS_KEY"]; ok {
		t.Error("AWS_SECRET_ACCESS_KEY should be stripped")
	}
	if _, ok := result["AWS_ACCESS_KEY_ID"]; ok {
		t.Error("AWS_ACCESS_KEY_ID should be stripped")
	}
	if result["PATH"] != "/usr/bin" {
		t.Error("PATH should be kept")
	}
	if result["USER"] != "testuser" {
		t.Error("USER should be kept")
	}
}

func TestFilterEnvStripsSSH(t *testing.T) {
	input := []string{
		"SSH_AUTH_SOCK=/tmp/ssh-agent",
		"SSH_AGENT_PID=12345",
		"LANG=en_US.UTF-8",
	}

	result := envMap(FilterEnv(input, nil, "/tmp/ws"))

	if _, ok := result["SSH_AUTH_SOCK"]; ok {
		t.Error("SSH_AUTH_SOCK should be stripped")
	}
	if _, ok := result["SSH_AGENT_PID"]; ok {
		t.Error("SSH_AGENT_PID should be stripped")
	}
	if result["LANG"] != "en_US.UTF-8" {
		t.Error("LANG should be kept")
	}
}

func TestFilterEnvStripsSecretPatterns(t *testing.T) {
	input := []string{
		"MY_SECRET_TOKEN=abc",
		"DB_PASSWORD=hunter2",
		"API_PRIVATE_KEY=xxx",
		"TERM=xterm",
	}

	result := envMap(FilterEnv(input, nil, "/tmp/ws"))

	if _, ok := result["MY_SECRET_TOKEN"]; ok {
		t.Error("MY_SECRET_TOKEN should be stripped")
	}
	if _, ok := result["DB_PASSWORD"]; ok {
		t.Error("DB_PASSWORD should be stripped")
	}
	if _, ok := result["API_PRIVATE_KEY"]; ok {
		t.Error("API_PRIVATE_KEY should be stripped")
	}
	if result["TERM"] != "xterm" {
		t.Error("TERM should be kept")
	}
}

func TestFilterEnvRewritesHome(t *testing.T) {
	input := []string{
		"HOME=/home/testuser",
		"OPENCLAW_HOME=/home/testuser/.openclaw",
		"OPENCLAW_STATE_DIR=/home/testuser/.openclaw/state",
		"PATH=/usr/bin",
	}

	result := envMap(FilterEnv(input, nil, "/tmp/sv-session-123"))

	if result["HOME"] != "/tmp/sv-session-123" {
		t.Errorf("HOME should be rewritten to workspace, got %s", result["HOME"])
	}
	if result["OPENCLAW_HOME"] != "/tmp/sv-session-123" {
		t.Errorf("OPENCLAW_HOME should be rewritten, got %s", result["OPENCLAW_HOME"])
	}
	if result["OPENCLAW_STATE_DIR"] != "/tmp/sv-session-123" {
		t.Errorf("OPENCLAW_STATE_DIR should be rewritten, got %s", result["OPENCLAW_STATE_DIR"])
	}
}

func TestFilterEnvAllowsExplicitVars(t *testing.T) {
	input := []string{
		"OPENAI_API_KEY=sk-123",
		"CUSTOM_VAR=hello",
		"PATH=/usr/bin",
	}

	result := envMap(FilterEnv(input, []string{"OPENAI_API_KEY", "CUSTOM_VAR"}, "/tmp/ws"))

	if result["OPENAI_API_KEY"] != "sk-123" {
		t.Error("OPENAI_API_KEY should be kept when explicitly allowed")
	}
	if result["CUSTOM_VAR"] != "hello" {
		t.Error("CUSTOM_VAR should be kept when explicitly allowed")
	}
}

func TestFilterEnvStripsUnknownVars(t *testing.T) {
	input := []string{
		"PATH=/usr/bin",
		"RANDOM_VAR=something",
		"ANOTHER_THING=value",
	}

	result := envMap(FilterEnv(input, nil, "/tmp/ws"))

	if _, ok := result["RANDOM_VAR"]; ok {
		t.Error("RANDOM_VAR should be stripped (not in safe defaults)")
	}
	if _, ok := result["ANOTHER_THING"]; ok {
		t.Error("ANOTHER_THING should be stripped (not in safe defaults)")
	}
	if result["PATH"] != "/usr/bin" {
		t.Error("PATH should be kept")
	}
}
