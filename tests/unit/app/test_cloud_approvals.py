"""Cloud sync of governance rows (Phase 2) and approvals from SecureVector
Cloud, device side (Phase 3). Design 25.

No real cloud: the fleet destination points at example.invalid and every
decision poll goes through a fake HTTP client. The device id is passed in,
so nothing reads or writes the per-user device id file.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from securevector.app.database.connection import close_database, init_database
from securevector.app.database.migrations import ensure_cloud_approval_storage, run_migrations
from securevector.app.database.repositories import external_forwarders as fwd_mod
from securevector.app.database.repositories.external_forwarders import (
    ExternalForwardersRepository,
    build_governance_payload,
    invalidate_siem_enabled_cache,
)
from securevector.app.database.repositories.jit_access import JitAccessRepository
from securevector.app.services import cloud_approvals as ca
from securevector.app.services import siem_ocsf

DEVICE = "dev-test-0001"
SESSION = "sess-1111"
FP = "a" * 64
INGEST = "https://fleet.example.invalid/ocsf/ingest"


@pytest.fixture(autouse=True)
def _reset():
    invalidate_siem_enabled_cache()
    yield
    invalidate_siem_enabled_cache()


async def _db(tmp_path):
    db = await init_database(tmp_path / "ca.db")
    await run_migrations(db)
    await ensure_cloud_approval_storage(db)
    return db


async def _fleet(db, *, enabled=True, source="enrollment", name="fleet"):
    return await ExternalForwardersRepository(db).create(
        kind="webhook", name=name, url=INGEST, event_filter="all",
        include_tool_audits=True, redaction_level="standard", enabled=enabled, source=source,
    )


async def _request(db, *, tool="Bash", source="local", session=SESSION, harness="claude-code",
                   fp=FP, preview=None, held_by=None):
    return await JitAccessRepository(db).create_request(
        tool_id=tool, rule_source=source, runtime_kind=harness, session_id=session,
        call_fingerprint=fp, call_preview=preview, held_by=held_by,
    )


async def _outbox(db, kind=None):
    rows = await db.fetch_all("SELECT forwarder_id, kind, payload_json FROM external_forward_outbox ORDER BY id")
    out = [dict(r) for r in rows or []]
    return [r for r in out if kind is None or r["kind"] == kind]


async def _on(db, **extra):
    await ca.set_settings(db, dict({"enabled": True}, **extra))


async def _shared(db, **kw):
    """A request filed and shared with the cloud (one sync pass)."""
    req = await _request(db, **kw)
    await ca.sync_requests_once(db)
    return req


def _decision(req, **over):
    d = {"request_id": req["id"], "device_id": DEVICE, "session_id": req["session_id"],
         "decision": "allow", "duration": "once", "decided_by": "owner@example.com",
         "decided_at": "2026-10-23T10:00:00Z", "fingerprint": FP}
    d.update(over)
    return d


async def _audit_rows(db, fn):
    rows = await db.fetch_all(
        "SELECT function_name, args_preview FROM tool_call_audit WHERE function_name = ? ORDER BY id", (fn,))
    return [dict(r) for r in rows or []]


async def _apply(db, decision, **kw):
    return await ca.apply_cloud_decision(db, decision, device_id=DEVICE, **kw)


# --- storage and the setting ----------------------------------------------------------


@pytest.mark.asyncio
async def test_storage_widens_outbox_kinds_and_is_idempotent(tmp_path):
    db = await _db(tmp_path)
    try:
        await ensure_cloud_approval_storage(db)
        sql = (await db.fetch_one(
            "SELECT sql FROM sqlite_master WHERE name = 'external_forward_outbox'"))["sql"]
        for kind in ("egress", "approval_request", "harness_coverage", "alert", "generation"):
            assert f"'{kind}'" in sql
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_setting_is_off_by_default_and_every_change_is_audited(tmp_path):
    db = await _db(tmp_path)
    try:
        s = await ca.get_settings(db)
        assert s == {"enabled": False, "allowance": ["once"],
                     "device_only_rules": ["cred_then_net", "outside_then_reach"]}
        s = await ca.set_settings(db, {"enabled": True, "allowance": ["1h", "once", "forever"]})
        assert s["enabled"] is True and s["allowance"] == ["once", "1h"]
        rows = await _audit_rows(db, "settings.cloud_approvals")
        assert len(rows) == 1 and "enabled=true" in rows[0]["args_preview"]
        await ca.set_settings(db, {"enabled": True})  # no change, no audit row
        assert len(await _audit_rows(db, "settings.cloud_approvals")) == 1
    finally:
        await close_database()


# --- Phase 2: rows go up only through an enabled fleet destination --------------------


@pytest.mark.asyncio
async def test_request_rows_only_when_fleet_destination_enabled(tmp_path):
    db = await _db(tmp_path)
    try:
        await _request(db)
        assert await ca.sync_requests_once(db) == 0  # not enrolled
        await _fleet(db, source="user", name="splunk")
        await _fleet(db, enabled=False, name="off")
        assert await ca.sync_requests_once(db) == 0
        assert await _outbox(db) == []
        fleet = await _fleet(db)
        await fwd_mod.set_siem_forwarding_enabled(db, False)
        assert await ca.sync_requests_once(db) == 0
        await fwd_mod.set_siem_forwarding_enabled(db, True)
        assert await ca.sync_requests_once(db) == 1
        rows = await _outbox(db)
        assert [(r["forwarder_id"], r["kind"]) for r in rows] == [(fleet["id"], "approval_request")]
        # Unchanged state: nothing new.
        assert await ca.sync_requests_once(db) == 0
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_request_row_shape_and_state_changes(tmp_path):
    db = await _db(tmp_path)
    try:
        await _fleet(db)
        await _on(db)
        req = await _shared(db, held_by="cred_then_net")
        row = json.loads((await _outbox(db, "approval_request"))[0]["payload_json"])
        assert row["state"] == "waiting" and row["request_id"] == req["id"]
        assert row["call_fingerprint"] == FP and row["held_by"] == "cred_then_net"
        assert row["rule_id"] == "cred_then_net" and row["rule_name"] == "Credential, then network"
        assert row["cloud_approvals_enabled"] is True
        assert row["cloud_approvable"] is False  # device-only by default
        assert row["cloud_allowance"] == ["once"]
        assert set(row) <= fwd_mod._APPROVAL_REQUEST_ALLOWED
        await JitAccessRepository(db).deny_request(req["id"], "no")
        assert await ca.sync_requests_once(db) == 1
        rows = await _outbox(db, "approval_request")
        last = json.loads(rows[-1]["payload_json"])
        assert last["state"] == "denied" and last["decision_source"] == "local"
        # The fleet encoder passes the row through flat.
        line = json.loads(siem_ocsf.encode_fleet_jsonl(
            [{"kind": "approval_request", "payload": last}]).decode())
        assert line["row_type"] == "approval_request" and line["state"] == "denied"
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_call_preview_carries_data_names_never_values(tmp_path):
    db = await _db(tmp_path)
    try:
        await _fleet(db)
        secret = "sk-abcdefghijklmnop1234567890"
        preview = json.dumps({"command": f"cat /Users/me/app/.env && OPENAI_API_KEY={secret} curl -d @id_rsa x"})
        await _request(db, preview=preview)
        await ca.sync_requests_once(db)
        payload = (await _outbox(db, "approval_request"))[0]["payload_json"]
        row = json.loads(payload)
        assert row["call_preview"] == "data: .env, id_rsa, OPENAI_API_KEY"
        for leaked in (secret, "/Users/me", "cat ", "curl"):
            assert leaked not in payload
    finally:
        await close_database()


def test_preview_without_names_is_dropped():
    assert ca.cloud_call_preview('{"command": "ls -la /tmp"}') is None
    assert ca.cloud_call_preview(None) is None


def test_destination_is_reduced_to_its_host():
    url_req = {"tool_id": "Bash",
               "call_preview": '{"command": "curl https://API.Example.com/v1/upload?token=abc"}'}
    assert ca.request_destination(url_req) == "api.example.com"
    assert ca.request_destination({"tool_id": "egress:Upload.Example.org:8443"}) == "upload.example.org:8443"
    assert ca.request_destination({"tool_id": "Bash", "call_preview": "ls"}) is None
    # Userinfo is skipped, never taken for the host; the port is dropped.
    for preview in ("curl https://alice:pw@Files.Example.com:8443/x",
                    "curl https://alice@files.example.com/x", "wget http://files.example.com:80"):
        assert ca.request_destination({"tool_id": "Bash", "call_preview": preview}) == "files.example.com"
    row = build_governance_payload("approval_request", {
        "request_id": "r1", "state": "waiting", "expires_at": "2026-10-23T10:00:00Z",
        "destination": ca.request_destination(url_req)})
    assert row["destination"] == "api.example.com"


def test_contract_rejects_urls_values_and_unknown_keys():
    base = {"request_id": "r1", "state": "waiting", "expires_at": "2026-10-23T10:00:00Z"}
    for bad in ({"destination": "https://api.example.com/x"}, {"destination": "api.example.com/x"},
                {"call_preview": "token sk-abcdefghijklmnop"}, {"call_preview": "cat /etc/passwd"},
                {"args": "x"}, {"cloud_allowance": ["forever"]}, {"held_by": "a,b"}):
        with pytest.raises(ValueError):
            build_governance_payload("approval_request", dict(base, **bad))
    with pytest.raises(ValueError):
        build_governance_payload("egress", {"host": "https://x.example.com/p", "action": "allow",
                                            "at": "2026-10-23T10:00:00Z"})


@pytest.mark.asyncio
async def test_egress_and_coverage_rows(tmp_path):
    db = await _db(tmp_path)
    try:
        await _fleet(db)
        # First pass only sets the marker; history is not sent.
        await db.execute("INSERT INTO egress_audit (host, operation, kind, action, confidence, detector) "
                         "VALUES ('old.example.com', 'read', 'web', 'allow', 'LOW', 'test')")
        assert await ca.sync_egress_once(db) == 0
        await db.execute("INSERT INTO egress_audit (host, operation, kind, action, confidence, detector, "
                         "session_id, rule_id) VALUES ('API.example.com', 'write', 'web', 'block', 'HIGH', "
                         "'test', 'sess-1111', 'policy.denylist')")
        assert await ca.sync_egress_once(db) == 1
        row = json.loads((await _outbox(db, "egress"))[0]["payload_json"])
        assert row["host"] == "api.example.com" and row["action"] == "block"
        assert row["session_id"] == SESSION and set(row) <= fwd_mod._EGRESS_ALLOWED

        n = await ca.sync_coverage_once(db)
        assert n >= 1
        assert await ca.sync_coverage_once(db) == 0  # unchanged, same day
        cov = [json.loads(r["payload_json"]) for r in await _outbox(db, "harness_coverage")]
        oc = next(r for r in cov if r["harness"] == "openclaw")
        assert oc["approvals_supported"] is False and oc["enforced"] == "after"
        later = datetime.now(timezone.utc) + timedelta(days=2)
        assert await ca.sync_coverage_once(db, now=later) == n
    finally:
        await close_database()


def test_task_event_row_carries_session_id_only_when_set():
    from securevector.app.services import fleet_task_events

    assert getattr(fleet_task_events.enqueue_task_event, "wants_session_id", False) is True
    assert "session_id" in fwd_mod._TASK_EVENT_ALLOWED
    row = siem_ocsf._fleet_task_event_row({"task_id": "ab", "session_id": SESSION})
    assert row["session_id"] == SESSION
    assert "session_id" not in siem_ocsf._fleet_task_event_row({"task_id": "ab"})


# --- Phase 3: every check before a cloud decision is applied ---------------------------


@pytest.mark.asyncio
async def test_allow_once_applied_through_the_local_path(tmp_path):
    db = await _db(tmp_path)
    try:
        await _fleet(db)
        await _on(db)
        req = await _shared(db)
        assert await _apply(db, _decision(req)) == ("applied", None)
        got = await JitAccessRepository(db).get_request(req["id"])
        assert got["status"] == "approved" and got["decision_source"] == "cloud"
        assert got["decided_by"] == "owner@example.com"
        grant = await JitAccessRepository(db).once_grant(SESSION, "claude-code", "Bash", FP)
        assert grant is not None
        assert len(await _audit_rows(db, "decision.cloud_applied")) == 1
        allow = await _audit_rows(db, "decision.allow")
        assert allow and "by=cloud: owner@example.com" in allow[-1]["args_preview"]
        # Replay of the same decision: first answer already applied.
        assert await _apply(db, _decision(req)) == ("rejected", ca.R_DECIDED)
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_cloud_approvals_off_ignores_every_decision(tmp_path):
    db = await _db(tmp_path)
    try:
        await _fleet(db)
        req = await _shared(db)
        for d in (_decision(req), _decision(req, decision="deny")):
            assert await _apply(db, d) == ("rejected", ca.R_OFF)
        assert (await JitAccessRepository(db).get_request(req["id"]))["status"] == "pending"
        assert len(await _audit_rows(db, "decision.cloud_rejected")) == 2
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_wrong_session_and_wrong_device_are_rejected(tmp_path):
    db = await _db(tmp_path)
    try:
        await _fleet(db)
        await _on(db)
        req = await _shared(db)
        assert await _apply(db, _decision(req, session_id="sess-other")) == ("rejected", ca.R_SESSION)
        assert await _apply(db, _decision(req, decision="deny", session_id="sess-other")) == ("rejected", ca.R_SESSION)
        assert await _apply(db, _decision(req, device_id="dev-other")) == ("rejected", ca.R_DEVICE)
        assert (await JitAccessRepository(db).get_request(req["id"]))["status"] == "pending"
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_expired_request_is_rejected(tmp_path):
    db = await _db(tmp_path)
    try:
        await _fleet(db)
        await _on(db)
        req = await _shared(db)
        later = datetime.now(timezone.utc) + timedelta(hours=25)
        assert await _apply(db, _decision(req), now=later) == ("rejected", ca.R_EXPIRED)
        assert await _apply(db, _decision(req, decision="deny"), now=later) == ("rejected", ca.R_EXPIRED)
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_already_decided_locally_wins(tmp_path):
    db = await _db(tmp_path)
    try:
        await _fleet(db)
        await _on(db)
        req = await _shared(db)
        await JitAccessRepository(db).deny_request(req["id"], "decided here")
        assert await _apply(db, _decision(req)) == ("rejected", ca.R_DECIDED)
        got = await JitAccessRepository(db).get_request(req["id"])
        assert got["status"] == "denied" and got["decision_source"] is None
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_device_only_rule_refuses_allow_but_applies_deny(tmp_path):
    db = await _db(tmp_path)
    try:
        await _fleet(db)
        await _on(db)
        req = await _shared(db, held_by="cred_then_net")
        assert await _apply(db, _decision(req)) == ("rejected", ca.R_DEVICE_ONLY)
        assert await _apply(db, _decision(req, decision="deny")) == ("applied", None)
        got = await JitAccessRepository(db).get_request(req["id"])
        assert got["status"] == "denied" and got["decision_source"] == "cloud"
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_duration_outside_the_allowance_is_refused(tmp_path):
    db = await _db(tmp_path)
    try:
        await _fleet(db)
        await _on(db)
        req = await _shared(db)
        for dur in ("15m", "1h", "session", "forever"):
            assert await _apply(db, _decision(req, duration=dur)) == ("rejected", ca.R_DURATION)
        await ca.set_settings(db, {"allowance": ["once", "15m"]})
        assert await _apply(db, _decision(req, duration="15m")) == ("applied", None)
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_step_up_approval_counts_as_session(tmp_path):
    db = await _db(tmp_path)
    try:
        await _fleet(db)
        await _on(db, allowance=["once", "15m"])
        req = await _shared(db, source="rung")
        # A step-up 15m approval lasts the session, which is not allowed.
        assert await _apply(db, _decision(req, duration="15m")) == ("rejected", ca.R_DURATION)
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_once_needs_the_matching_fingerprint(tmp_path):
    db = await _db(tmp_path)
    try:
        await _fleet(db)
        await _on(db)
        req = await _shared(db)
        assert await _apply(db, _decision(req, fingerprint="b" * 64)) == ("rejected", ca.R_FP_MISMATCH)
        assert await _apply(db, _decision(req, fingerprint=None)) == ("rejected", ca.R_FP_MISMATCH)
        nofp = await _shared(db, tool="Write", fp=None)
        assert await _apply(db, _decision(nofp)) == ("rejected", ca.R_FP_REQUIRED)
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_harness_without_approvals_and_unshared_requests(tmp_path):
    db = await _db(tmp_path)
    try:
        await _fleet(db)
        await _on(db)
        oc = await _shared(db, harness="openclaw")
        assert await _apply(db, _decision(oc)) == ("rejected", ca.R_NO_APPROVALS)
        # Filed but never shared (no sync pass since): not answerable.
        local = await _request(db, tool="Edit")
        assert await _apply(db, _decision(local)) == ("rejected", ca.R_NOT_SHARED)
        assert await _apply(db, _decision(local, request_id="jitreq_missing")) == ("rejected", ca.R_NOT_FOUND)
        assert await _apply(db, {"request_id": "x", "decision": "maybe"}) == ("rejected", ca.R_BAD)
    finally:
        await close_database()


# --- the poller -----------------------------------------------------------------------


class _Resp:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body

    def json(self):
        return self._body


class FakeCloud:
    def __init__(self, decisions=(), statuses=()):
        self.decisions = list(decisions)
        self.statuses = list(statuses)  # replies before the 200s; "net" raises
        self.gets: list = []
        self.posts: list = []

    async def get(self, url, params=None, headers=None):
        self.gets.append((url, params, headers))
        if self.statuses:
            st = self.statuses.pop(0)
            if st == "net":
                raise ConnectionError("down")
            return _Resp(st, {})
        return _Resp(200, {"decisions": self.decisions, "generatedAt": "2026-10-23T10:00:05Z"})

    async def post(self, url, json=None, headers=None):
        self.posts.append((url, json))
        return _Resp(200, {})


@pytest.fixture
def _auth(monkeypatch):
    from securevector.app.services import external_forwarder

    monkeypatch.setattr(external_forwarder, "_build_auth_headers",
                        lambda fwd, ct, extra: {"Content-Type": ct, "Authorization": "Bearer test"})


@pytest.mark.asyncio
async def test_poller_idle_when_nothing_pending_or_off(tmp_path, _auth):
    db = await _db(tmp_path)
    try:
        await _fleet(db)
        cloud = FakeCloud()
        assert (await ca.poll_decisions_once(db, cloud, device_id=DEVICE))["polled"] is False  # off
        await _on(db)
        assert (await ca.poll_decisions_once(db, cloud, device_id=DEVICE))["polled"] is False  # none shared
        req = await _shared(db)
        await JitAccessRepository(db).deny_request(req["id"], "here")
        assert (await ca.poll_decisions_once(db, cloud, device_id=DEVICE))["polled"] is False  # none pending
        assert cloud.gets == [] and cloud.posts == []
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_poller_applies_and_reports_back(tmp_path, _auth):
    db = await _db(tmp_path)
    try:
        await _fleet(db)
        await _on(db)
        a = await _shared(db)
        b = await _shared(db, tool="Write", held_by="cred_then_net")
        cloud = FakeCloud([_decision(a), _decision(b)])
        out = await ca.poll_decisions_once(db, cloud, device_id=DEVICE)
        assert out["polled"] is True
        assert cloud.gets[0][0] == "https://fleet.example.invalid/fleet/approvals/decisions"
        assert cloud.posts == [
            (f"https://fleet.example.invalid/fleet/approvals/{a['id']}/applied", {"result": "applied"}),
            (f"https://fleet.example.invalid/fleet/approvals/{b['id']}/applied",
             {"result": "rejected", "reason": ca.R_DEVICE_ONLY}),
        ]
        # The next poll asks again from where the cloud left off.
        await ca.poll_decisions_once(db, FakeCloud(), device_id=DEVICE)
        assert await ca._get_state(db, "decisions_since") == "2026-10-23T10:00:05Z"
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_poller_skips_expired_and_keeps_polling_for_device_only(tmp_path, _auth):
    db = await _db(tmp_path)
    try:
        await _fleet(db)
        await _on(db)
        req = await _shared(db, held_by="cred_then_net")  # device-only: the cloud may still deny
        assert await ca.has_shared_pending(db) is True
        later = datetime.now(timezone.utc) + timedelta(hours=25)
        assert await ca.has_shared_pending(db, later) is False
        cloud = FakeCloud([_decision(req, decision="deny")])
        await ca.poll_decisions_once(db, cloud, device_id=DEVICE)
        assert cloud.posts[0][1] == {"result": "applied"}
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_poller_backs_off_on_errors_and_resets_after_200(tmp_path, _auth):
    db = await _db(tmp_path)
    try:
        await _fleet(db)
        await _on(db)
        await _shared(db)
        t0 = datetime.now(timezone.utc)
        cloud = FakeCloud(statuses=[503, "net", 500])
        assert (await ca.poll_decisions_once(db, cloud, device_id=DEVICE, now=t0))["error"] == "http_503"
        # 5 s backoff: no call at +4 s, a call at +5 s.
        assert (await ca.poll_decisions_once(db, cloud, device_id=DEVICE, now=t0 + timedelta(seconds=4)))["why"] == "backoff"
        assert (await ca.poll_decisions_once(db, cloud, device_id=DEVICE, now=t0 + timedelta(seconds=5)))["error"] == "network"
        # Then 10 s, then 20 s.
        t1 = t0 + timedelta(seconds=5)
        assert (await ca.poll_decisions_once(db, cloud, device_id=DEVICE, now=t1 + timedelta(seconds=9)))["why"] == "backoff"
        assert (await ca.poll_decisions_once(db, cloud, device_id=DEVICE, now=t1 + timedelta(seconds=10)))["error"] == "http_500"
        t2 = t1 + timedelta(seconds=10)
        assert await ca._get_state(db, "poll_next_at") == ca._iso(t2 + timedelta(seconds=20))
        assert len(cloud.gets) == 3
        out = await ca.poll_decisions_once(db, cloud, device_id=DEVICE, now=t2 + timedelta(seconds=20))
        assert out["polled"] is True and "error" not in out
        assert await ca._get_state(db, "poll_failures") == "0"
        assert await ca._get_state(db, "poll_next_at") is None
        # The cap is 5 minutes.
        for _ in range(12):
            await ca._poll_failed(db, t0, auth=False, headers={})
        assert await ca._get_state(db, "poll_next_at") == ca._iso(t0 + timedelta(seconds=300))
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_three_401s_pause_until_the_credential_changes(tmp_path, monkeypatch):
    from securevector.app.services import external_forwarder

    token = {"v": "Bearer one"}
    monkeypatch.setattr(external_forwarder, "_build_auth_headers",
                        lambda fwd, ct, extra: {"Content-Type": ct, "Authorization": token["v"]})
    db = await _db(tmp_path)
    try:
        await _fleet(db)
        await _on(db)
        await _shared(db)
        cloud = FakeCloud(statuses=[401, 401, 401])
        t = datetime.now(timezone.utc)
        for i in range(3):
            t = t + timedelta(minutes=10)
            assert (await ca.poll_decisions_once(db, cloud, device_id=DEVICE, now=t))["error"] == "http_401"
        assert (await ca.poll_status(db))["paused"] is True
        assert (await ca.poll_status(db))["paused_message"] == "Cloud approvals paused: sign-in to Cloud Connect failed"
        stored = await ca._get_state(db, "poll_paused_credential")
        assert "one" not in stored  # a digest, never the credential
        t = t + timedelta(hours=1)
        assert (await ca.poll_decisions_once(db, cloud, device_id=DEVICE, now=t))["why"] == "auth_paused"
        assert len(cloud.gets) == 3
        token["v"] = "Bearer two"  # Cloud Connect signed in again
        out = await ca.poll_decisions_once(db, cloud, device_id=DEVICE, now=t)
        assert out["polled"] is True and "error" not in out
        assert (await ca.poll_status(db))["paused"] is False
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_two_401s_then_a_500_do_not_pause(tmp_path, _auth):
    db = await _db(tmp_path)
    try:
        await _fleet(db)
        await _on(db)
        await _shared(db)
        cloud = FakeCloud(statuses=[401, 401, 500, 401])
        t = datetime.now(timezone.utc)
        for _ in range(4):
            t = t + timedelta(minutes=10)
            await ca.poll_decisions_once(db, cloud, device_id=DEVICE, now=t)
        assert (await ca.poll_status(db))["paused"] is False
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_expiry_is_part_of_the_update_gate(tmp_path):
    db = await _db(tmp_path)
    try:
        repo = JitAccessRepository(db)
        req = await _request(db)
        await db.execute("UPDATE jit_access_requests SET requested_at = datetime('now', '-120 seconds') "
                         "WHERE id = ?", (req["id"],))
        grant, changed = await repo.approve_request(req["id"], "once", with_change=True,
                                                    decided_by="u", decision_source="cloud", max_age_s=60)
        assert grant is None and changed is False
        assert not await repo.deny_request(req["id"], "x", decided_by="u", decision_source="cloud", max_age_s=60)
        assert (await repo.get_request(req["id"]))["status"] == "pending"
        assert await repo.deny_request(req["id"], "x", decided_by="u", decision_source="cloud", max_age_s=600)
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_applied_audit_logs_the_actual_duration(tmp_path):
    db = await _db(tmp_path)
    try:
        await _fleet(db)
        await _on(db, allowance=["once", "15m", "session"])
        req = await _shared(db, source="rung")
        assert await _apply(db, _decision(req, duration="15m")) == ("applied", None)
        rows = await _audit_rows(db, "decision.cloud_applied")
        assert "duration=session" in rows[-1]["args_preview"]
    finally:
        await close_database()


@pytest.mark.asyncio
async def test_egress_session_id_must_be_an_id(tmp_path):
    db = await _db(tmp_path)
    try:
        await _fleet(db)
        assert await ca.sync_egress_once(db) == 0
        await db.execute("INSERT INTO egress_audit (host, operation, kind, action, confidence, detector, "
                         "session_id) VALUES ('a.example.com', 'read', 'web', 'allow', 'LOW', 't', 'two words')")
        assert await ca.sync_egress_once(db) == 1
        row = json.loads((await _outbox(db, "egress"))[0]["payload_json"])
        assert "session_id" not in row
    finally:
        await close_database()
