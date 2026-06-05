"""Regression tests for case-insensitive tool_id matching (issue #138).

Cloud-pushed and local-UI rules may store ``tool_id`` in any casing
(e.g. lowercase ``read``) while a runtime emits the canonical tool name
(``Read``). A case-sensitive lookup silently failed a deny rule open.
``evaluate_tool_call`` must match synced rules and user overrides
regardless of casing — this is the OpenClaw LLM-proxy decision oracle,
mirroring the CC / Codex JS hooks and the OpenClaw plugin.
"""

from securevector.core.tool_permissions.engine import evaluate_tool_call


REGISTRY = {"Read": {"risk": "read", "default_permission": "allow"}}


def test_lowercase_override_denies_pascalcase_tool():
    decision = evaluate_tool_call("Read", REGISTRY, overrides={"read": "block"})
    assert decision.action == "block"


def test_uppercase_override_denies_pascalcase_tool():
    decision = evaluate_tool_call("Read", REGISTRY, overrides={"READ": "block"})
    assert decision.action == "block"


def test_lowercase_synced_rule_denies_pascalcase_tool():
    decision = evaluate_tool_call(
        "Read",
        REGISTRY,
        synced_overrides={"read": {"effect": "deny", "policy_name": "p"}},
    )
    assert decision.action == "block"


def test_pascalcase_synced_rule_denies_lowercase_call():
    decision = evaluate_tool_call(
        "read",
        REGISTRY,
        synced_overrides={"Read": {"effect": "deny", "policy_name": "p"}},
    )
    assert decision.action == "block"


def test_unrelated_tool_still_allows():
    # No rule for Write -> registry default (allow) preserved; the
    # case-insensitive change must not over-match.
    decision = evaluate_tool_call("Read", REGISTRY, overrides={"write": "block"})
    assert decision.action == "allow"
