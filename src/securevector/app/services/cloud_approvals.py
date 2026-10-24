"""Cloud sync of governance rows and approvals from SecureVector Cloud.

Design 25 (approved 2026-10-23), the device side of Phases 2 and 3.

Phase 2, sync up (metadata only). On a device whose fleet destination is
configured and enabled (the same gates as task_event and generation rows):

- `approval_request` rows: one when a held call's request is filed and one
  on every state change (waiting, approved, denied, expired, used). The call
  preview carries data names only (".env, OPENAI_API_KEY"), never values,
  plus the SHA-256 call fingerprint.
- `egress` rows: one per outbound host decision.
- `harness_coverage` rows: this device's coverage table, at most once a day
  or when it changes.

Phase 3, approvals from the cloud. The setting "Allow approvals from
SecureVector Cloud" is off by default, lives only in this app's database and
changes only through the local UI (a synced policy never writes it). While it
is on and at least one pending request was shared with the cloud, the device
polls `GET /fleet/approvals/decisions` every 5 s with its existing fleet
credential; with nothing pending it does not poll. Every decision passes all
the checks in `apply_cloud_decision` before it is applied through the same
approve or deny function a local decision uses (source 'cloud', approver the
cloud user), then the device reports applied or rejected with a reason code.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Mapping, Optional
from urllib.parse import quote

logger = logging.getLogger(__name__)

ENROLLMENT_SOURCE = "enrollment"
AUDIT_TOOL_ID = "sv.cloud_approvals"

DURATIONS = ("once", "15m", "1h", "session")
DEFAULT_ALLOWANCE = ("once",)
# Credential-then-network and outside-content holds are approved on this
# device only by default (owner decisions, 2026-10-23). The owner can lift
# this per rule locally.
DEFAULT_DEVICE_ONLY_RULES = ("cred_then_net", "outside_then_reach")
MAX_DEVICE_ONLY_RULES = 50

POLL_INTERVAL_S = 5.0
EGRESS_EVERY_TICKS = 6  # egress rows every 30 s
COVERAGE_RESEND = timedelta(days=1)
REQUEST_LOOKBACK = timedelta(hours=24)
NON_RUNG_EXPIRY = timedelta(hours=24)  # JitAccessRepository.expire_stale_requests
MAX_REQUESTS_PER_PASS = 200
MAX_EGRESS_PER_PASS = 500
MAX_DECISIONS_PER_POLL = 100
HTTP_TIMEOUT_S = 15.0
INGEST_SUFFIX = "/ocsf/ingest"

_RULE_ID_RE = re.compile(r"\A[A-Za-z0-9_.:-]{1,64}\Z")
_REQUEST_ID_RE = re.compile(r"\A[A-Za-z0-9._:-]{1,128}\Z")
_HARNESS_RE = re.compile(r"\A[a-z0-9_-]{1,32}\Z")
_TOOL_RE = re.compile(r"\A[A-Za-z0-9_.:/-]{1,128}\Z")
_TOKEN_RE = re.compile(r"\A[a-z_]{1,32}\Z")
_FINGERPRINT_RE = re.compile(r"\A[0-9a-f]{64}\Z")
_REASON_RE = re.compile(r"\A[a-z_]{1,48}\Z")
_ISO_RE = re.compile(r"\A\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?\Z")

# Data names in a call preview: the same two shapes the local span panel's
# "Data" line shows (run-trace.js dataNames). Names only, values never.
_NAME_FILE_RE = re.compile(
    r"(?:^|[\s@'\"=/])(\.env[\w.-]*|id_rsa|id_ed25519|\.npmrc|\.pypirc|\.netrc"
    r"|credentials(?:\.json)?|[\w.-]+\.pem|[\w.-]+\.key)\b"
)
_NAME_VAR_RE = re.compile(r"\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|URL)[A-Z0-9_]*\b")
_MAX_NAMES = 8

# Reason codes reported back to the cloud (snake_case, engine _REASON_RE).
R_OFF = "cloud_approvals_off"
R_BAD = "malformed_decision"
R_NOT_FOUND = "request_not_found"
R_NOT_SHARED = "request_not_shared"
R_DECIDED = "already_decided"
R_EXPIRED = "request_expired"
R_DEVICE = "device_mismatch"
R_SESSION = "session_mismatch"
R_DEVICE_ONLY = "device_only_rule"
R_NO_APPROVALS = "approvals_not_supported"
R_DURATION = "duration_not_allowed"
R_FP_REQUIRED = "fingerprint_required"
R_FP_MISMATCH = "fingerprint_mismatch"
R_NOT_GRANTABLE = "not_grantable"

_STATE_SETTINGS = "settings"
_STATE_SINCE = "decisions_since"
_STATE_EGRESS = "egress_last_id"
_STATE_COV_DIGEST = "coverage_digest"
_STATE_COV_SENT = "coverage_sent_at"


# --- small helpers --------------------------------------------------------------------


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_db_time(value: Any) -> Optional[datetime]:
    """A SQLite CURRENT_TIMESTAMP ('YYYY-MM-DD HH:MM:SS', UTC) or ISO time."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _clean_user(value: Any) -> str:
    """The cloud user who decided, as a short printable label."""
    text = "".join(c for c in str(value or "") if ord(c) >= 32 and ord(c) != 127).strip()
    return text[:120] or "cloud user"


def _ids(value: Any) -> list:
    return [x for x in str(value or "").split(",") if x]


async def _get_state(db, key: str) -> Optional[str]:
    try:
        row = await db.fetch_one("SELECT value FROM cloud_approval_state WHERE key = ?", (key,))
    except Exception:  # noqa: BLE001 - table absent before the storage step
        return None
    return dict(row)["value"] if row else None


async def _set_state(db, key: str, value: str) -> None:
    await db.execute(
        "INSERT INTO cloud_approval_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
        (key, value),
    )


# --- the setting ----------------------------------------------------------------------


def normalize_settings(raw: Any) -> dict:
    """{enabled, allowance, device_only_rules}, defaults for anything missing
    or malformed. Deny is always allowed and is not part of the allowance."""
    raw = raw if isinstance(raw, Mapping) else {}
    enabled = raw.get("enabled") is True
    allowance = raw.get("allowance")
    if isinstance(allowance, (list, tuple)):
        allowance = [d for d in DURATIONS if d in allowance]
    else:
        allowance = list(DEFAULT_ALLOWANCE)
    rules = raw.get("device_only_rules")
    if isinstance(rules, (list, tuple)):
        clean: list = []
        for r in rules:
            if isinstance(r, str) and _RULE_ID_RE.match(r.strip()) and r.strip() not in clean:
                clean.append(r.strip())
        rules = clean[:MAX_DEVICE_ONLY_RULES]
    else:
        rules = list(DEFAULT_DEVICE_ONLY_RULES)
    return {"enabled": enabled, "allowance": allowance, "device_only_rules": rules}


async def get_settings(db) -> dict:
    raw = await _get_state(db, _STATE_SETTINGS)
    try:
        parsed = json.loads(raw) if raw else None
    except (TypeError, ValueError):
        parsed = None
    return normalize_settings(parsed)


async def set_settings(db, changes: Mapping[str, Any]) -> dict:
    """Apply a partial change from the local UI and audit it. The route that
    calls this requires the person in the app (UI token and confirmation);
    nothing synced from the cloud calls it."""
    current = await get_settings(db)
    merged = dict(current)
    for key in ("enabled", "allowance", "device_only_rules"):
        if key in changes and changes[key] is not None:
            merged[key] = changes[key]
    clean = normalize_settings(merged)
    await _set_state(db, _STATE_SETTINGS, json.dumps(clean, sort_keys=True))
    if clean != current:
        await _audit(
            db, "settings.cloud_approvals",
            reason="Approvals from SecureVector Cloud changed in the app",
            preview=(f"enabled={str(clean['enabled']).lower()} "
                     f"allowance={','.join(['deny'] + clean['allowance'])} "
                     f"device_only={','.join(clean['device_only_rules']) or 'none'}"),
        )
    return clean


async def _audit(db, function_name: str, *, reason: str, preview: str,
                 session_id: Optional[str] = None, harness: Optional[str] = None,
                 request_id: Optional[str] = None) -> None:
    try:
        from securevector.app.database.repositories.custom_tools import CustomToolsRepository

        await CustomToolsRepository(db).log_tool_call_audit(
            AUDIT_TOOL_ID, function_name, "log_only", reason=reason[:300],
            args_preview=preview[:500], runtime_kind=harness, session_id=session_id,
            request_id=request_id,
        )
    except Exception:  # noqa: BLE001 - the audit is best effort
        logger.warning("cloud approvals audit write failed", exc_info=True)


# --- request facts --------------------------------------------------------------------


def request_rule_ids(req: Mapping[str, Any]) -> list:
    """The rule ids that held a request (`held_by`), e.g. ['cred_then_net']."""
    return _ids(req.get("held_by"))


def request_expiry(req: Mapping[str, Any]) -> Optional[datetime]:
    """When a pending request stops being answerable: the step-up hold limit
    for a rung request, a day for any other (expire_stale_requests)."""
    filed = _parse_db_time(req.get("requested_at"))
    if filed is None:
        return None
    if req.get("rule_source") == "rung":
        from securevector.app.services.response_rungs import HOLD_LIMIT_S

        return filed + timedelta(seconds=HOLD_LIMIT_S)
    return filed + NON_RUNG_EXPIRY


def harness_has_approvals(runtime_kind: Any) -> bool:
    from securevector.app.services import harness_coverage

    return bool(harness_coverage.coverage(runtime_kind if isinstance(runtime_kind, str) else None)
                .get("approvals"))


def is_device_only(req: Mapping[str, Any], settings: Mapping[str, Any]) -> bool:
    rules = set(settings.get("device_only_rules") or ())
    return any(r in rules for r in request_rule_ids(req))


def cloud_approvable(req: Mapping[str, Any], settings: Mapping[str, Any]) -> bool:
    """Cloud approvals on, not a device-only rule, and a harness that has
    approvals at all. A delegation request is never approvable from the cloud."""
    return bool(
        settings.get("enabled")
        and req.get("rule_source") != "delegate"
        and not is_device_only(req, settings)
        and harness_has_approvals(req.get("runtime_kind"))
    )


def cloud_call_preview(preview: Any) -> Optional[str]:
    """The data names in a local preview ("data: .env, OPENAI_API_KEY"), or
    None. Values never leave: only names that pass the value check do."""
    from securevector.app.database.repositories.external_forwarders import gov_preview_is_safe

    text = str(preview or "")
    if not text:
        return None
    names: list = []
    for m in _NAME_FILE_RE.finditer(text):
        if m.group(1) not in names:
            names.append(m.group(1))
    for m in _NAME_VAR_RE.finditer(text):
        if m.group(0) not in names:
            names.append(m.group(0))
    names = [n for n in names if gov_preview_is_safe(n)][:_MAX_NAMES]
    if not names:
        return None
    out = "data: " + ", ".join(names)
    while len(out) > 256 and names:
        names.pop()
        out = "data: " + ", ".join(names)
    return out if names and gov_preview_is_safe(out) else None


# Userinfo (user:pw@) is skipped, never taken for the host.
_URL_HOST_RE = re.compile(r"\b(?:https?|wss?)://(?:[^/\s@]*@)?([^/\s'\"@:]+)", re.IGNORECASE)
EGRESS_TOOL_PREFIX = "egress:"


def request_destination(req: Mapping[str, Any]) -> Optional[str]:
    """The host a held call would connect to, as the local span panel shows
    it (run-trace.js hostOf): the host of an `egress:<host>` request, else
    the host of the first URL in the preview. Host only (optional :port),
    lowercase; a URL is reduced to its host. None when unknown or when the
    result is not a plain host."""
    from securevector.app.database.repositories.external_forwarders import _GOV_HOST_RE

    tool = str(req.get("tool_id") or "")
    host = None
    if tool.lower().startswith(EGRESS_TOOL_PREFIX):
        host = tool[len(EGRESS_TOOL_PREFIX):]
    else:
        m = _URL_HOST_RE.search(str(req.get("call_preview") or ""))
        host = m.group(1) if m else None
    if not host:
        return None
    host = host.strip().lower()
    if len(host) > 260 or not _GOV_HOST_RE.match(host):
        return None
    return host


async def _grant_used(db, request_id: str) -> bool:
    row = await db.fetch_one(
        "SELECT 1 AS u FROM jit_access_grants WHERE request_id = ? AND used_at IS NOT NULL LIMIT 1",
        (request_id,),
    )
    return bool(row)


async def request_state(db, req: Mapping[str, Any], now: Optional[datetime] = None) -> tuple:
    """(state, decision_source) as the cloud row carries them."""
    now = now or _utcnow()
    status = req.get("status")
    source = req.get("decision_source") or "local"
    if status == "pending":
        exp = request_expiry(req)
        if exp is not None and now >= exp:
            return "expired", "timeout"
        return "waiting", None
    if status == "approved":
        return ("used" if await _grant_used(db, str(req.get("id"))) else "approved"), source
    if status == "denied":
        if req.get("decided_by") == "timeout":
            return "expired", "timeout"
        return "denied", source
    return "expired", "timeout"


async def build_request_row(db, req: Mapping[str, Any], settings: Mapping[str, Any],
                            now: Optional[datetime] = None) -> dict:
    """The approval_request row for one local request. Fields that do not
    fit their contract are left out rather than sent malformed."""
    from securevector.app.services import call_rules

    now = now or _utcnow()
    state, source = await request_state(db, req, now)
    rules = request_rule_ids(req)
    rule_id = next((r for r in rules if r in call_rules.RULE_IDS), rules[0] if rules else None)
    held_by = rules[0] if rules else None
    filed = _parse_db_time(req.get("requested_at"))
    exp = request_expiry(req) or now
    harness = req.get("runtime_kind")
    tool = req.get("tool_id")
    fp = req.get("call_fingerprint")
    sid = req.get("session_id")
    tid = req.get("trace_id")
    row = {
        "request_id": str(req.get("id")),
        "session_id": sid if isinstance(sid, str) and 0 < len(sid) <= 128 else None,
        "trace_id": tid if isinstance(tid, str) and 0 < len(tid) <= 128 else None,
        "harness": harness if isinstance(harness, str) and _HARNESS_RE.match(harness) else None,
        "tool": tool if isinstance(tool, str) and _TOOL_RE.match(tool) else None,
        "rule_id": rule_id if rule_id and _RULE_ID_RE.match(rule_id) else None,
        "rule_name": call_rules.RULE_NAMES.get(rule_id) if rule_id else None,
        "call_preview": cloud_call_preview(req.get("call_preview")),
        "call_fingerprint": fp if isinstance(fp, str) and _FINGERPRINT_RE.match(fp) else None,
        "held_by": held_by if held_by and _TOKEN_RE.match(held_by) else None,
        "destination": request_destination(req),
        "expires_at": _iso(exp),
        "state": state,
        "cloud_approvals_enabled": bool(settings.get("enabled")),
        "cloud_approvable": cloud_approvable(req, settings),
        "cloud_allowance": list(settings.get("allowance") or []),
        "decision_source": source,
        "created_at": _iso(filed) if filed else None,
        "emitted_at": _iso(now),
    }
    for key in ("session_id", "trace_id"):
        v = row[key]
        if v is not None and any(ord(c) < 32 or ord(c) == 127 for c in v):
            row[key] = None
    return {k: v for k, v in row.items() if v is not None}


# --- fleet destination ----------------------------------------------------------------


async def fleet_destinations(db) -> list:
    """Enabled fleet (enrollment) destinations while forwarding is on."""
    from securevector.app.database.repositories.external_forwarders import (
        ExternalForwardersRepository,
        is_siem_forwarding_enabled,
    )

    if not await is_siem_forwarding_enabled(db):
        return []
    active = await ExternalForwardersRepository(db).list_active()
    return [f for f in active if str(f.get("source") or "") == ENROLLMENT_SOURCE]


async def _enqueue(db, kind: str, row: Mapping[str, Any], fleet: list) -> int:
    from securevector.app.database.repositories.external_forwarders import (
        ExternalForwardOutboxRepository,
        build_governance_payload,
    )

    payload = build_governance_payload(kind, row)
    return await ExternalForwardOutboxRepository(db).enqueue_fanout(kind, payload, forwarders=fleet)


# --- Phase 2: sync up -----------------------------------------------------------------


async def sync_requests_once(db, now: Optional[datetime] = None) -> int:
    """Queue an approval_request row for every request filed or changed since
    the last pass. Returns rows queued (0 when there is no fleet destination)."""
    fleet = await fleet_destinations(db)
    if not fleet:
        return 0
    now = now or _utcnow()
    settings = await get_settings(db)
    since = (now - REQUEST_LOOKBACK).strftime("%Y-%m-%d %H:%M:%S")
    rows = await db.fetch_all(
        "SELECT r.*, s.last_state AS _shared_state FROM jit_access_requests r "
        "LEFT JOIN cloud_approval_shared s ON s.request_id = r.id "
        "WHERE COALESCE(r.rule_source, '') != 'delegate' "
        "AND (r.requested_at >= ? OR (s.request_id IS NOT NULL AND s.last_state = 'waiting')) "
        "ORDER BY r.requested_at, r.id LIMIT ?",
        (since, MAX_REQUESTS_PER_PASS),
    ) or []
    sent = 0
    for r in rows:
        req = dict(r)
        if not _REQUEST_ID_RE.match(str(req.get("id") or "")):
            continue
        state, _ = await request_state(db, req, now)
        if state == req.get("_shared_state"):
            continue
        try:
            row = await build_request_row(db, req, settings, now)
            written = await _enqueue(db, "approval_request", row, fleet)
        except ValueError:
            logger.warning("cloud approvals: request row refused by the contract")
            continue
        if not written:
            continue
        sent += 1
        await db.execute(
            "INSERT INTO cloud_approval_shared (request_id, last_state, cloud_approvable) "
            "VALUES (?, ?, ?) ON CONFLICT(request_id) DO UPDATE SET last_state = excluded.last_state, "
            "cloud_approvable = excluded.cloud_approvable, updated_at = CURRENT_TIMESTAMP",
            (req["id"], state, 1 if row.get("cloud_approvable") else 0),
        )
    return sent


_EGRESS_ACTION = {"allow": "allow", "block": "block", "log_only": "log", "observed": "log"}


async def sync_egress_once(db) -> int:
    """Queue egress rows written since the last pass. The first pass on a
    device only sets the marker: history from before the sync is not sent."""
    from securevector.app.database.repositories.external_forwarders import (
        _GOV_HOST_RE,
        _GOV_REQUEST_ID_RE,
    )

    fleet = await fleet_destinations(db)
    if not fleet:
        return 0
    marker = await _get_state(db, _STATE_EGRESS)
    if marker is None:
        row = await db.fetch_one("SELECT COALESCE(MAX(id), 0) AS m FROM egress_audit")
        await _set_state(db, _STATE_EGRESS, str(int(dict(row)["m"]) if row else 0))
        return 0
    try:
        last = int(marker)
    except ValueError:
        last = 0
    rows = await db.fetch_all(
        "SELECT id, timestamp, host, action, rule_id, session_id FROM egress_audit "
        "WHERE id > ? ORDER BY id LIMIT ?",
        (last, MAX_EGRESS_PER_PASS),
    ) or []
    sent = 0
    for r in rows:
        e = dict(r)
        last = max(last, int(e["id"]))
        host = str(e.get("host") or "").strip().lower()
        at = _parse_db_time(e.get("timestamp"))
        if not host or len(host) > 260 or not _GOV_HOST_RE.match(host) or at is None:
            continue
        rule = e.get("rule_id")
        sid = e.get("session_id")
        row = {
            "host": host,
            "action": _EGRESS_ACTION.get(str(e.get("action") or ""), "log"),
            "at": _iso(at),
            "egress_id": f"egress-{int(e['id'])}",
            "rule_id": rule if isinstance(rule, str) and _RULE_ID_RE.match(rule) else None,
            "session_id": sid if isinstance(sid, str) and _GOV_REQUEST_ID_RE.match(sid) else None,
        }
        try:
            sent += await _enqueue(db, "egress", {k: v for k, v in row.items() if v is not None}, fleet)
        except ValueError:
            continue
    await _set_state(db, _STATE_EGRESS, str(last))
    return sent


def _path_token(text: str) -> Optional[str]:
    tok = re.sub(r"[^a-z0-9]+", "_", str(text).lower()).strip("_")[:48].strip("_")
    return tok or None


def coverage_rows() -> list:
    """One harness_coverage row per known harness (without emitted_at)."""
    from securevector.app.services import harness_coverage

    out = []
    for kind, entry in harness_coverage.table().items():
        if not _HARNESS_RE.match(kind):
            continue
        enforced = {"before_call": "before", "after_call": "after"}.get(entry.get("enforced"), "none")
        paths = []
        for p in entry.get("unchecked") or []:
            tok = _path_token(p)
            if tok and tok not in paths:
                paths.append(tok)
        label = entry.get("label")
        out.append({
            "harness": kind,
            "enforced": enforced,
            "label": label if isinstance(label, str) and 0 < len(label) <= 80 else None,
            "unchecked_paths": paths[:8],
            "approvals_supported": bool(entry.get("approvals")),
            "egress_visible": bool(entry.get("egress_visible")),
            "token_data": bool(entry.get("token_data")),
        })
    return out


async def sync_coverage_once(db, now: Optional[datetime] = None) -> int:
    """Queue the coverage table when it changed or a day has passed."""
    fleet = await fleet_destinations(db)
    if not fleet:
        return 0
    now = now or _utcnow()
    rows = coverage_rows()
    digest = hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()
    last_digest = await _get_state(db, _STATE_COV_DIGEST)
    last_sent = _parse_db_time(await _get_state(db, _STATE_COV_SENT))
    if last_digest == digest and last_sent is not None and now - last_sent < COVERAGE_RESEND:
        return 0
    sent = 0
    for row in rows:
        row = dict(row, emitted_at=_iso(now))
        try:
            sent += await _enqueue(db, "harness_coverage", {k: v for k, v in row.items() if v is not None}, fleet)
        except ValueError:
            continue
    if sent:
        await _set_state(db, _STATE_COV_DIGEST, digest)
        await _set_state(db, _STATE_COV_SENT, _iso(now))
    return sent


# --- Phase 3: decisions from the cloud ------------------------------------------------


async def has_shared_pending(db, now: Optional[datetime] = None) -> bool:
    """At least one request this device shared with the cloud is pending and
    not expired. Device-only requests count too: the cloud may deny them."""
    now = now or _utcnow()
    try:
        rows = await db.fetch_all(
            "SELECT r.* FROM cloud_approval_shared s "
            "JOIN jit_access_requests r ON r.id = s.request_id "
            "WHERE r.status = 'pending' ORDER BY r.requested_at DESC LIMIT 200"
        ) or []
    except Exception:  # noqa: BLE001 - storage absent
        return False
    for r in rows:
        exp = request_expiry(dict(r))
        if exp is not None and now < exp:
            return True
    return False


def _same(a: Any, b: Any) -> bool:
    if not isinstance(a, str) or not isinstance(b, str) or not a or not b:
        return False
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


async def apply_cloud_decision(db, decision: Mapping[str, Any], *,
                               settings: Optional[Mapping[str, Any]] = None,
                               device_id: Optional[str] = None,
                               now: Optional[datetime] = None) -> tuple:
    """Check one cloud decision and apply it when every check passes.

    Returns ("applied", None) or ("rejected", reason_code). Every outcome is
    audited as decision.cloud_applied or decision.cloud_rejected. A decision
    is applied only through JitAccessRepository.approve_request /
    deny_request, the functions a local decision uses."""
    from securevector.app.database.repositories.jit_access import JitAccessRepository
    from securevector.app.services import decisions as decisions_svc

    now = now or _utcnow()
    settings = settings if settings is not None else await get_settings(db)
    d = decision if isinstance(decision, Mapping) else {}
    rid = d.get("request_id")
    user = _clean_user(d.get("decided_by"))
    verb = d.get("decision")
    req: dict = {}

    async def reject(reason: str) -> tuple:
        await _audit(
            db, "decision.cloud_rejected",
            reason=f"Decision from SecureVector Cloud not applied: {reason}",
            preview=(f"decision={verb if verb in ('allow', 'deny') else 'unknown'} by=cloud:{user} "
                     f"request={rid if isinstance(rid, str) and _REQUEST_ID_RE.match(rid) else 'none'} "
                     f"reason={reason}"),
            session_id=req.get("session_id"), harness=req.get("runtime_kind"),
        )
        return "rejected", reason

    if not isinstance(rid, str) or not _REQUEST_ID_RE.match(rid) or verb not in ("allow", "deny"):
        return await reject(R_BAD)
    # 1. Cloud approvals are on for this device (local setting, off by default).
    if not settings.get("enabled"):
        return await reject(R_OFF)

    repo = JitAccessRepository(db)
    # A hold past its limit is already a deny; a late answer cannot open it.
    try:
        from securevector.app.services import response_rungs

        await response_rungs.expire_holds(db)
    except Exception:  # noqa: BLE001
        logger.debug("expire_holds failed before a cloud decision", exc_info=True)
    found = await repo.get_request(rid)
    if not found:
        return await reject(R_NOT_FOUND)
    req = dict(found)
    shared = await db.fetch_one("SELECT 1 AS s FROM cloud_approval_shared WHERE request_id = ?", (rid,))
    if not shared or req.get("rule_source") == "delegate":
        return await reject(R_NOT_SHARED)
    # 2. Pending and not expired. 7. First answer wins: a local answer stands.
    if req.get("status") != "pending":
        return await reject(R_DECIDED)
    exp = request_expiry(req)
    if exp is None or now >= exp:
        return await reject(R_EXPIRED)
    # 3. Device id and session id match the local request.
    local_device = device_id
    if local_device is None:
        from securevector.app.utils.device_id import get_device_id

        local_device = get_device_id()
    if not _same(d.get("device_id"), local_device):
        return await reject(R_DEVICE)
    if not _same(d.get("session_id"), req.get("session_id")):
        return await reject(R_SESSION)

    by = f"cloud: {user}"
    applied_duration = None
    if verb == "deny":
        # Deny is always allowed while cloud approvals are on.
        ok = await repo.deny_request(rid, "Denied from SecureVector Cloud", decided_by=user,
                                     decision_source="cloud", max_age_s=_max_age_s(req))
        if not ok:
            return await reject(await _why_not_changed(repo, rid))
        await decisions_svc.audit(
            db, "deny", session_id=req.get("session_id"), klass=decisions_svc.call_class(req),
            tool_id=req.get("tool_id"), request_id=rid, by=by, harness=req.get("runtime_kind"),
            reason=f"Denied from SecureVector Cloud by {user}",
        )
    else:
        # 6. Not a rule marked "approve on this device only".
        if is_device_only(req, settings):
            return await reject(R_DEVICE_ONLY)
        if not harness_has_approvals(req.get("runtime_kind")):
            return await reject(R_NO_APPROVALS)
        # 5. The duration is within this device's cloud allowance. A step-up
        # approval other than once lasts the session, so that is what counts.
        duration = d.get("duration")
        allowance = set(settings.get("allowance") or ())
        if duration not in DURATIONS or duration not in allowance:
            return await reject(R_DURATION)
        if req.get("rule_source") == "rung" and duration != "once" and "session" not in allowance:
            return await reject(R_DURATION)
        # 4. Once binds to the local call fingerprint.
        if duration == "once":
            local_fp = req.get("call_fingerprint")
            if not local_fp:
                return await reject(R_FP_REQUIRED)
            if not _same(d.get("fingerprint"), local_fp):
                return await reject(R_FP_MISMATCH)
        try:
            grant, changed = await repo.approve_request(
                rid, duration, with_change=True, decided_by=user, decision_source="cloud",
                max_age_s=_max_age_s(req))
        except ValueError:
            return await reject(R_NOT_GRANTABLE)
        if grant is None or not changed:
            return await reject(await _why_not_changed(repo, rid))
        applied_duration = grant.get("duration")
        await decisions_svc.audit(
            db, "allow", session_id=req.get("session_id"), klass=decisions_svc.call_class(req),
            tool_id=req.get("tool_id"), request_id=rid, by=by, harness=req.get("runtime_kind"),
            reason=f"Approved from SecureVector Cloud by {user}",
        )
        try:
            from securevector.app.services import call_rules

            await call_rules.on_approved(db, req, duration=grant.get("duration"))
        except Exception:  # noqa: BLE001 - never raises by contract; belt and braces
            logger.debug("call_rules.on_approved failed", exc_info=True)

    await _audit(
        db, "decision.cloud_applied",
        reason=f"Decision from SecureVector Cloud applied: {verb} by {user}",
        preview=(f"decision={verb} by=cloud:{user} request={rid} "
                 f"duration={applied_duration if verb == 'allow' else 'none'}"),
        session_id=req.get("session_id"), harness=req.get("runtime_kind"),
    )
    return "applied", None


def _max_age_s(req: Mapping[str, Any]) -> int:
    """How long after filing a request stays answerable, in seconds; the
    approve / deny UPDATE carries it so expiry is enforced atomically."""
    if req.get("rule_source") == "rung":
        from securevector.app.services.response_rungs import HOLD_LIMIT_S

        return int(HOLD_LIMIT_S)
    return int(NON_RUNG_EXPIRY.total_seconds())


async def _why_not_changed(repo, rid: str) -> str:
    """A guarded UPDATE that changed nothing: still pending means it expired
    in between; anything else means another answer came first."""
    again = await repo.get_request(rid)
    return R_EXPIRED if again and again.get("status") == "pending" else R_DECIDED


# --- poll backoff and the paused state ------------------------------------------------

_STATE_FAILS = "poll_failures"
_STATE_NEXT = "poll_next_at"
_STATE_AUTH_FAILS = "poll_auth_failures"
_STATE_PAUSED = "poll_paused_credential"  # SHA-256 of the failing credential, never the credential
BACKOFF_BASE_S = 5
BACKOFF_MAX_S = 300
AUTH_FAILS_TO_PAUSE = 3
PAUSED_TEXT = "Cloud approvals paused: sign-in to Cloud Connect failed"


def _int_state(value: Optional[str]) -> int:
    try:
        return max(0, int(value or 0))
    except ValueError:
        return 0


def _credential_digest(headers: Mapping[str, str]) -> str:
    return hashlib.sha256(str(headers.get("Authorization") or "").encode("utf-8")).hexdigest()


async def _poll_failed(db, now: datetime, *, auth: bool, headers: Mapping[str, str]) -> None:
    fails = _int_state(await _get_state(db, _STATE_FAILS)) + 1
    delay = min(BACKOFF_BASE_S * (2 ** min(fails - 1, 16)), BACKOFF_MAX_S)
    await _set_state(db, _STATE_FAILS, str(fails))
    await _set_state(db, _STATE_NEXT, _iso(now + timedelta(seconds=delay)))
    if auth:
        n = _int_state(await _get_state(db, _STATE_AUTH_FAILS)) + 1
        await _set_state(db, _STATE_AUTH_FAILS, str(n))
        if n >= AUTH_FAILS_TO_PAUSE:
            await _set_state(db, _STATE_PAUSED, _credential_digest(headers))
            logger.warning("cloud approvals: polling paused, the cloud refused this device's credential")


async def _poll_ok(db) -> None:
    for key in (_STATE_FAILS, _STATE_AUTH_FAILS):
        await _set_state(db, key, "0")
    await db.execute("DELETE FROM cloud_approval_state WHERE key IN (?, ?)", (_STATE_NEXT, _STATE_PAUSED))


async def poll_status(db) -> dict:
    """{paused, message} for the Settings page."""
    paused = bool(await _get_state(db, _STATE_PAUSED))
    return {"paused": paused, "paused_message": PAUSED_TEXT if paused else None}


def _endpoint_base(fwd: Mapping[str, Any]) -> Optional[str]:
    """The cloud API base from the fleet destination's ingest URL, or None
    when the URL is not an https .../ocsf/ingest endpoint."""
    url = str(fwd.get("url") or "").strip()
    if not url.lower().startswith("https://") or not url.endswith(INGEST_SUFFIX):
        return None
    return url[: -len(INGEST_SUFFIX)]


async def poll_decisions_once(db, http: Any = None, *, device_id: Optional[str] = None,
                              now: Optional[datetime] = None) -> dict:
    """One poll. Does nothing (no network) unless cloud approvals are on and
    a shared request is pending. `http` is an object with async get / post
    (an httpx.AsyncClient); tests pass a fake."""
    settings = await get_settings(db)
    if not settings.get("enabled"):
        return {"polled": False, "why": "off"}
    clock = now or _utcnow()
    if not await has_shared_pending(db, clock):
        return {"polled": False, "why": "nothing_pending"}
    next_at = _parse_db_time(await _get_state(db, _STATE_NEXT))
    if next_at is not None and clock < next_at:
        return {"polled": False, "why": "backoff"}
    fleet = await fleet_destinations(db)
    fwd = next((f for f in fleet if _endpoint_base(f)), None)
    if fwd is None:
        return {"polled": False, "why": "no_destination"}
    base = _endpoint_base(fwd)
    from securevector.app.services.external_forwarder import _build_auth_headers

    try:
        headers = _build_auth_headers(fwd, "application/json", {})
    except ValueError:
        return {"polled": False, "why": "no_credential"}
    if "Authorization" not in headers:
        return {"polled": False, "why": "no_credential"}
    paused = await _get_state(db, _STATE_PAUSED)
    if paused:
        if hmac.compare_digest(paused, _credential_digest(headers)):
            return {"polled": False, "why": "auth_paused"}
        # The Cloud Connect credential changed: try again from scratch.
        await _poll_ok(db)

    own_client = http is None
    if own_client:
        import httpx

        http = httpx.AsyncClient(timeout=HTTP_TIMEOUT_S)
    results: list = []
    try:
        since = await _get_state(db, _STATE_SINCE)
        params = {"since": since} if since and _ISO_RE.match(since) else None
        try:
            resp = await http.get(f"{base}/fleet/approvals/decisions", params=params, headers=headers)
        except Exception as e:  # noqa: BLE001 - network: back off and try again
            logger.debug("cloud approvals poll failed: %s", type(e).__name__)
            await _poll_failed(db, clock, auth=False, headers=headers)
            return {"polled": True, "error": "network"}
        status = getattr(resp, "status_code", 0)
        if status != 200:
            if status != 401:
                await _set_state(db, _STATE_AUTH_FAILS, "0")
            await _poll_failed(db, clock, auth=status == 401, headers=headers)
            return {"polled": True, "error": f"http_{status}"}
        await _poll_ok(db)
        try:
            body = resp.json()
        except Exception:  # noqa: BLE001
            return {"polled": True, "error": "bad_body"}
        items = body.get("decisions") if isinstance(body, Mapping) else None
        if not isinstance(items, list):
            return {"polled": True, "error": "bad_body"}
        for item in items[:MAX_DECISIONS_PER_POLL]:
            result, reason = await apply_cloud_decision(
                db, item if isinstance(item, Mapping) else {}, settings=settings,
                device_id=device_id, now=now)
            rid = item.get("request_id") if isinstance(item, Mapping) else None
            results.append((rid, result, reason))
            if isinstance(rid, str) and _REQUEST_ID_RE.match(rid):
                report = {"result": result}
                if reason and _REASON_RE.match(reason):
                    report["reason"] = reason
                try:
                    await http.post(f"{base}/fleet/approvals/{quote(rid, safe='')}/applied",
                                    json=report, headers=headers)
                except Exception as e:  # noqa: BLE001 - the decision stands locally
                    logger.debug("cloud approvals report failed: %s", type(e).__name__)
        generated = body.get("generatedAt")
        if isinstance(generated, str) and _ISO_RE.match(generated.replace("+00:00", "Z")):
            await _set_state(db, _STATE_SINCE, generated)
    finally:
        if own_client:
            try:
                await http.aclose()
            except Exception:  # noqa: BLE001
                pass
    return {"polled": True, "results": results}


# --- the background loop --------------------------------------------------------------


class CloudApprovalsService:
    """Every 5 s: queue changed request rows; every 30 s: egress rows; the
    coverage table when it changed or daily; and one decision poll, which
    is a no-op without network unless a shared request is pending."""

    def __init__(self) -> None:
        self._task: Optional[asyncio.Task] = None
        self._tick = 0

    async def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None

    async def tick(self, db) -> None:
        self._tick += 1
        for step in (
            lambda: sync_requests_once(db),
            (lambda: sync_egress_once(db)) if self._tick % EGRESS_EVERY_TICKS == 1 else None,
            lambda: sync_coverage_once(db),
            lambda: poll_decisions_once(db),
            lambda: sync_requests_once(db),  # report applied decisions promptly
        ):
            if step is None:
                continue
            try:
                await step()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - one failing step never stops the loop
                logger.debug("cloud approvals step failed", exc_info=True)

    async def _run(self) -> None:
        from securevector.app.database.connection import get_database

        while True:
            await asyncio.sleep(POLL_INTERVAL_S)
            try:
                await self.tick(get_database())
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                logger.debug("cloud approvals tick failed", exc_info=True)


_service = CloudApprovalsService()


async def start_cloud_approvals() -> None:
    await _service.start()


async def stop_cloud_approvals() -> None:
    await _service.stop()
