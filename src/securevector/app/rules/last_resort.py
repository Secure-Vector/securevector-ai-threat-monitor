"""
Hard-coded last-resort tool-call rules — always applied, even when a synced
cloud bundle says allow, even when the user toggled the local rule off, even
when Cloud Connect is OFF.

This is the safety floor of the threat-monitor: rules so dangerous that no
admin should be able to override them. Compiled into the binary, never
synced over the wire, never editable from any UI.

Rule shape mirrors the same `tool_id, effect, reason` triple used by synced
rules / Tool Permissions. Effect is always `deny` — last-resort rules are
never `prompt` or `allow`. Audit reason is always `last_resort_rule` so
ops can grep for these specifically.

active-mcp-and-policy-sync bundle, Phase 2 / Release B device side.

Extending this list: add a new entry, document the threat model in the
`reason` field. Removing an entry: don't. Bug fixes only via pattern
refinement.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Tuple


@dataclass(frozen=True)
class LastResortRule:
    """One immutable last-resort rule."""

    tool_id: str
    effect: str  # always "deny" for v1
    reason: str  # surfaced in audit + UI


# v1 — minimal starter set. Each rule is a known-bad pattern that no
# legitimate agent workflow needs. Expand cautiously.
LAST_RESORT_RULES: Tuple[LastResortRule, ...] = (
    LastResortRule(
        tool_id="filesystem.read:/etc/passwd",
        effect="deny",
        reason="Last-resort rule: blocks reads of /etc/passwd. Common credential-harvest target.",
    ),
    LastResortRule(
        tool_id="filesystem.read:/etc/shadow",
        effect="deny",
        reason="Last-resort rule: blocks reads of /etc/shadow. Hashed-credential target.",
    ),
    LastResortRule(
        tool_id="filesystem.read:~/.ssh/id_rsa",
        effect="deny",
        reason="Last-resort rule: blocks reads of SSH private keys.",
    ),
    LastResortRule(
        tool_id="bash:rm -rf /",
        effect="deny",
        reason="Last-resort rule: blocks recursive root deletion. No legitimate agent task requires this.",
    ),
    LastResortRule(
        tool_id="bash:curl|sh",
        effect="deny",
        reason="Last-resort rule: blocks curl-pipe-shell idiom. Common malware-staging pattern.",
    ),
)


def matches_last_resort(tool_id: str) -> LastResortRule | None:
    """
    Return the first LastResortRule whose `tool_id` matches the given string.

    v1: substring match — `tool_id` matches if any LAST_RESORT_RULES entry's
    `tool_id` is a substring of the call (covers both exact-match calls
    like `filesystem.read:/etc/passwd` and shell-flavored calls embedding
    the dangerous pattern). Replace with a structured matcher if shells
    out the pattern coverage gets noisy.
    """
    if not tool_id:
        return None
    for rule in LAST_RESORT_RULES:
        if rule.tool_id in tool_id:
            return rule
    return None


__all__ = ["LAST_RESORT_RULES", "LastResortRule", "matches_last_resort"]
