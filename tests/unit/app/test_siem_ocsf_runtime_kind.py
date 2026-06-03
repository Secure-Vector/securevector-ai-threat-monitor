"""SIEM OCSF encoder — `runtime_kind` propagation.

Both `encode_tool_audit_event` (OCSF 1007 Process Activity) and
`encode_scan_event` (OCSF 2001 Security Finding) must surface the
plugin's `runtime_kind` so a SOC consuming the forwarded events can
pivot per-agent ("show me all Codex activity vs Claude Code vs
OpenClaw"). Pre-this-fix the field was dropped at the encoder; SOC
consumers saw indistinguishable events across runtimes.

`runtime_kind` lives under `unmapped` because OCSF 1.3.0 doesn't have
a first-class field for "which agent framework executed this." Going
through unmapped is the documented path for non-standard product
fields per the schema's `unmapped` allow-list.
"""

from __future__ import annotations

import sys
from pathlib import Path

# src layout isn't on sys.path during pytest discovery; inject it.
ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from securevector.app.services.siem_ocsf import (  # noqa: E402
    encode_scan_event,
    encode_tool_audit_event,
)


def test_tool_audit_event_includes_runtime_kind_when_present():
    """Codex / CC / OpenClaw rows all carry runtime_kind on the
    incoming /api/tool-permissions/call-audit POST. The OCSF event
    must propagate it into `unmapped.runtime_kind`."""
    for kind in ("codex", "claude-code", "openclaw"):
        event = encode_tool_audit_event({
            "audit_id": 1,
            "function_name": "Bash",
            "tool_id": "Bash",
            "action": "block",
            "risk": "admin",
            "called_at": "2026-06-01T22:46:54Z",
            "seq": 109,
            "prev_hash": "abc",
            "row_hash": "def",
            "device_id": "sv-test",
            "runtime_kind": kind,
        })
        assert event["unmapped"]["runtime_kind"] == kind, event


def test_tool_audit_event_omits_runtime_kind_when_missing():
    """Pre-v32 audit rows (before the column was added) had no
    `runtime_kind`. The encoder must not synthesize a default —
    a missing field is signal too. Pins backward-compat for
    forwarded historical events."""
    event = encode_tool_audit_event({
        "audit_id": 1,
        "function_name": "Bash",
        "tool_id": "Bash",
        "action": "allow",
        "called_at": "2026-06-01T22:46:54Z",
        "seq": 1,
        "prev_hash": None,
        "row_hash": "x",
    })
    assert "runtime_kind" not in event["unmapped"], event


def test_scan_event_includes_runtime_kind_at_standard_tier():
    """Threat-intel POSTs from the plugins set runtime_kind in the
    payload's metadata. The OCSF 2001 encoder must surface it at
    the standard tier (and full tier)."""
    for tier in ("standard", "full"):
        event = encode_scan_event({
            "scan_id": "scan-1",
            "verdict": "BLOCK",
            "threat_score": 0.95,
            "confidence_score": 0.9,
            "timestamp": "2026-06-01T12:00:00Z",
            "runtime_kind": "codex",
            "matched_rule_ids": ["sv_community_001"],
        }, redaction=tier)
        assert event["unmapped"]["runtime_kind"] == "codex", (tier, event)


def test_scan_event_omits_runtime_kind_at_minimal_tier():
    """The `minimal` redaction tier intentionally strips everything
    beyond SOC-correlation essentials. runtime_kind goes with the
    other context fields — present at standard+, absent at minimal."""
    event = encode_scan_event({
        "scan_id": "scan-1",
        "verdict": "BLOCK",
        "timestamp": "2026-06-01T12:00:00Z",
        "runtime_kind": "codex",
    }, redaction="minimal")
    assert "runtime_kind" not in event.get("unmapped", {}), event
