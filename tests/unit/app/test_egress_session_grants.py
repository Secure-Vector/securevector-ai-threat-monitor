"""Story #229: egress approvals tied to the session.

- A blocked promotable host files a request in that session's Approval inbox.
- Approving it (15 min, 1 hour, rest of session) allows the host for that
  session and harness only; other sessions stay blocked; grants expire and
  can be revoked; the grant row carries scope, session and actor.
- Non-promotable rules (denylist, publish, metadata) are never grantable.
- Denylist add/remove is validated.
- A blocked egress call shows in the task's Tool calls list without a second
  audit row.
"""

from types import SimpleNamespace

import pytest
import pytest_asyncio
from fastapi import HTTPException

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.egress import EgressRepository
from securevector.app.database.repositories.jit_access import JitAccessRepository
from securevector.app.server.routes import egress as egress_routes
from securevector.app.server.routes import jit_access as jit_routes
from securevector.app.terminals import routes as terminal_routes
from securevector.app.terminals.store import TerminalStore
from securevector.core.egress import (
    BLOCK,
    EgressContext,
    EgressPolicy,
    evaluate_tool_call,
)

HOST = "api.unlisted-host.dev"
TOKEN = jit_routes._UI_TOKEN


class _FakeManager:
    """Stands in for app.state.terminal_manager: per-task hook tokens and
    the real TerminalStore over the test database."""

    def __init__(self, db):
        self.store = TerminalStore(db)
        self.tokens = {}

    def hook_token(self, task_id):
        return self.tokens.get(task_id)

    async def task_for(self, session_id, origin="launch"):
        task_id = "task-" + session_id
        if await self.store.get_task(task_id) is None:
            await self.store.create_task(task_id, executor_id="claude-code", workspace="/w",
                                         title=None, pid=None, session_id=session_id,
                                         origin=origin)
            if origin == "launch":
                self.tokens[task_id] = "tok-" + session_id
        return task_id


def _http(manager, headers=None, port=8741):
    return SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(terminal_manager=manager)),
        headers=headers or {}, url=SimpleNamespace(port=port))


@pytest_asyncio.fixture
async def db(tmp_path, monkeypatch):
    conn = DatabaseConnection(tmp_path / "grants.db")
    await run_migrations(conn)
    monkeypatch.setattr(egress_routes, "get_database", lambda: conn)
    monkeypatch.setattr(jit_routes, "get_database", lambda: conn)
    repo = EgressRepository(conn)
    policy = await repo.get_active_policy()
    await repo.update_policy(policy["id"], preset="contained")
    global MANAGER
    MANAGER = _FakeManager(conn)
    return conn


MANAGER = None


async def _call(session_id, host=HOST, runtime="claude-code", verified=True,
                command=None, headers=None):
    """One evaluate call. `verified`: sent by the Guard inside the task that
    owns the session, with that task's hook token."""
    hdrs = dict(headers or {})
    if session_id and verified:
        task_id = await MANAGER.task_for(session_id)
        hdrs.update({"x-sv-terminal-task": task_id,
                     "x-sv-terminal-hook": MANAGER.tokens[task_id]})
    return await egress_routes.evaluate_egress(egress_routes.EvaluateRequest(
        tool_name="Bash",
        tool_input={"command": command or f"curl -s https://{host}/v1/x"},
        runtime_kind=runtime,
        session_id=session_id,
    ), _http(MANAGER, hdrs))


async def _pending(db):
    return await JitAccessRepository(db).list_requests(status="pending")


class TestSessionHostGrant:
    @pytest.mark.asyncio
    async def test_block_files_a_session_scoped_request(self, db):
        out = await _call("sess-aaaa1111")
        assert out["action"] == BLOCK
        assert out["verdicts"][0]["rule_id"] == "preset.contained"
        pending = await _pending(db)
        assert len(pending) == 1
        req = pending[0]
        assert req["tool_id"] == f"egress:{HOST}"
        assert req["session_id"] == "sess-aaaa1111"
        assert req["runtime_kind"] == "claude-code"
        assert req["function_name"] == "preset.contained"
        # A repeat block does not queue a second request.
        await _call("sess-aaaa1111")
        assert len(await _pending(db)) == 1

    @pytest.mark.asyncio
    async def test_rest_of_session_grant_allows_only_that_session(self, db):
        await _call("sess-aaaa1111")
        req = (await _pending(db))[0]
        grant = await JitAccessRepository(db).approve_request(req["id"], "session")
        assert grant["duration"] == "session"
        assert grant["session_id"] == "sess-aaaa1111"
        decided = await JitAccessRepository(db).get_request(req["id"])
        assert decided["decided_by"] == "local-user"

        mine = await _call("sess-aaaa1111")
        assert mine["action"] == "allow"
        assert mine["verdicts"][0]["rule_id"] == "grant.session_host"
        # Another open session, same host: still blocked.
        other = await _call("sess-bbbb2222")
        assert other["action"] == BLOCK
        # Same session id, another harness: still blocked.
        codex = await _call("sess-aaaa1111", runtime="codex")
        assert codex["action"] == BLOCK
        # The allowed call is audited with the grant rule.
        rows = await EgressRepository(db).recent(limit=10)
        assert any(r["rule_id"] == "grant.session_host" for r in rows)

    @pytest.mark.asyncio
    @pytest.mark.parametrize("duration,minutes", [("15m", 15), ("1h", 60)])
    async def test_timeboxed_grants_expire_on_their_own(self, db, duration, minutes):
        await _call("sess-aaaa1111")
        req = (await _pending(db))[0]
        grant = await JitAccessRepository(db).approve_request(req["id"], duration)
        assert grant["session_id"] == "sess-aaaa1111"
        row = await db.fetch_one(
            "SELECT (julianday(expires_at) - julianday(granted_at)) * 1440 AS m "
            "FROM jit_access_grants WHERE id = ?", (grant["id"],))
        assert abs(row["m"] - minutes) < 1
        assert (await _call("sess-aaaa1111"))["action"] == "allow"
        await db.execute(
            "UPDATE jit_access_grants SET expires_at = datetime('now', '-1 minute') WHERE id = ?",
            (grant["id"],))
        assert (await _call("sess-aaaa1111"))["action"] == BLOCK

    @pytest.mark.asyncio
    async def test_revoked_grant_blocks_again(self, db):
        await _call("sess-aaaa1111")
        req = (await _pending(db))[0]
        grant = await JitAccessRepository(db).approve_request(req["id"], "session")
        assert await JitAccessRepository(db).revoke_grant(grant["id"])
        assert (await _call("sess-aaaa1111"))["action"] == BLOCK

    @pytest.mark.asyncio
    async def test_no_session_no_request(self, db):
        out = await _call(None)
        assert out["action"] == BLOCK
        assert await _pending(db) == []

    @pytest.mark.asyncio
    async def test_synced_policy_is_not_grantable(self, db):
        await db.execute("UPDATE egress_policies SET source = 'synced' WHERE is_active = 1")
        await _call("sess-aaaa1111")
        assert await _pending(db) == []
        with pytest.raises(HTTPException) as exc:
            await egress_routes.grant_host(
                egress_routes.HostGrantRequest(host=HOST, session_id="sess-aaaa1111",
                                               duration="session"),
                _http(MANAGER), x_sv_ui_token=TOKEN)
        assert exc.value.status_code == 403

    @pytest.mark.asyncio
    async def test_grant_tool_rows_are_not_emitted_as_tool_allows(self, db, monkeypatch):
        await _call("sess-aaaa1111")
        req = (await _pending(db))[0]
        await JitAccessRepository(db).approve_request(req["id"], "session")
        from securevector.app.server.routes import tool_permissions
        monkeypatch.setattr(tool_permissions, "get_database", lambda: db)
        await db.execute("UPDATE app_settings SET tool_permissions_enabled = 1 WHERE id = 1")
        out = await tool_permissions.get_synced_overrides(
            runtime="claude-code", session_id="sess-aaaa1111")
        tool_ids = {r["tool_id"] for r in out["synced"]}
        assert f"egress:{HOST}" not in tool_ids
        assert HOST not in tool_ids


class TestPaneGrantRoute:
    @pytest.mark.asyncio
    async def test_grant_from_pane_scopes_to_session_and_takes_harness_from_audit(self, db):
        await _call("sess-aaaa1111")
        out = await egress_routes.grant_host(
            egress_routes.HostGrantRequest(host=HOST.upper(), session_id="sess-aaaa1111",
                                           duration="1h"),
            _http(MANAGER), x_sv_ui_token=TOKEN)
        grant = out["grant"]
        assert grant["tool_id"] == f"egress:{HOST}"
        assert grant["session_id"] == "sess-aaaa1111"
        assert grant["runtime_kind"] == "claude-code"
        # The pending inbox request was the one approved, not a second one.
        assert await _pending(db) == []
        assert (await _call("sess-aaaa1111"))["action"] == "allow"
        assert (await _call("sess-bbbb2222"))["action"] == BLOCK

    @pytest.mark.asyncio
    async def test_requires_ui_token(self, db):
        await _call("sess-aaaa1111")
        for token in (None, "nope"):
            with pytest.raises(HTTPException) as exc:
                await egress_routes.grant_host(
                    egress_routes.HostGrantRequest(host=HOST, session_id="sess-aaaa1111",
                                                   duration="15m"),
                    _http(MANAGER), x_sv_ui_token=token)
            assert exc.value.status_code == 403

    @pytest.mark.asyncio
    async def test_grant_needs_a_launched_task_that_owns_the_session(self, db):
        # Linked: no token, so the grant could never apply; refused.
        await MANAGER.task_for("sess-link0001", origin="linked")
        await _call("sess-link0001", verified=False)
        with pytest.raises(HTTPException) as exc:
            await egress_routes.grant_host(
                egress_routes.HostGrantRequest(host=HOST, session_id="sess-link0001",
                                               duration="15m"),
                _http(MANAGER), x_sv_ui_token=TOKEN)
        assert exc.value.status_code == 403
        # External: no task at all.
        with pytest.raises(HTTPException) as exc:
            await egress_routes.grant_host(
                egress_routes.HostGrantRequest(host=HOST, session_id="sess-nobody01",
                                               duration="15m"),
                _http(MANAGER), x_sv_ui_token=TOKEN)
        assert exc.value.status_code == 403
        # Archived: the task left the board.
        task_id = await MANAGER.task_for("sess-aaaa1111")
        await _call("sess-aaaa1111")
        await MANAGER.store.update_status(task_id, "done")
        assert await MANAGER.store.archive_task(task_id)
        with pytest.raises(HTTPException) as exc:
            await egress_routes.grant_host(
                egress_routes.HostGrantRequest(host=HOST, session_id="sess-aaaa1111",
                                               duration="15m"),
                _http(MANAGER), x_sv_ui_token=TOKEN)
        assert exc.value.status_code == 403
        assert await JitAccessRepository(db).active_host_grants("sess-aaaa1111", any_runtime=True) == {}

    @pytest.mark.asyncio
    async def test_host_never_blocked_in_session_is_404(self, db):
        await _call("sess-aaaa1111")
        await MANAGER.task_for("sess-bbbb2222")
        with pytest.raises(HTTPException) as exc:
            await egress_routes.grant_host(
                egress_routes.HostGrantRequest(host=HOST, session_id="sess-bbbb2222",
                                               duration="session"),
                _http(MANAGER), x_sv_ui_token=TOKEN)
        assert exc.value.status_code == 404

    @pytest.mark.asyncio
    @pytest.mark.parametrize("bad", ["https://x.com", "x.com/a", "x.com:443", "*.x.com", "a b"])
    async def test_invalid_host_is_400(self, db, bad):
        with pytest.raises(HTTPException) as exc:
            await egress_routes.grant_host(
                egress_routes.HostGrantRequest(host=bad, session_id="sess-aaaa1111",
                                               duration="session"),
                _http(MANAGER), x_sv_ui_token=TOKEN)
        assert exc.value.status_code == 400

    @pytest.mark.asyncio
    async def test_denylisted_host_is_not_grantable(self, db):
        repo = EgressRepository(db)
        policy = await repo.get_active_policy()
        await repo.update_policy(policy["id"], denylist=["paste.example.org"])
        out = await _call("sess-aaaa1111", host="paste.example.org")
        assert out["verdicts"][0]["rule_id"] == "policy.denylist"
        assert await _pending(db) == []
        with pytest.raises(HTTPException) as exc:
            await egress_routes.grant_host(
                egress_routes.HostGrantRequest(host="paste.example.org",
                                               session_id="sess-aaaa1111", duration="session"),
                _http(MANAGER), x_sv_ui_token=TOKEN)
        assert exc.value.status_code == 403

    @pytest.mark.asyncio
    async def test_agent_cannot_file_an_egress_request(self, db):
        with pytest.raises(HTTPException) as exc:
            await jit_routes.create_request(jit_routes.JitRequestCreate(
                tool_id=f"egress:{HOST}", session_id="sess-aaaa1111"))
        assert exc.value.status_code == 403


class TestEngineGrantBoundary:
    def test_grant_never_clears_a_non_promotable_rule(self):
        policy = EgressPolicy(preset="contained", denylist=["paste.example.org"])
        for host in ("paste.example.org", "169.254.169.254"):
            ctx = EgressContext(session_id="s", host_grants={host: "jitgrant_x"})
            ev = evaluate_tool_call("Bash", {"command": f"curl http://{host}/latest"},
                                    policy, ctx)
            assert ev.action == BLOCK, host
            assert not ev.verdicts[0].promotable

    def test_grant_clears_a_promotable_block_for_that_host_only(self):
        policy = EgressPolicy(preset="contained")
        ctx = EgressContext(session_id="s", host_grants={HOST: "jitgrant_x"})
        ok = evaluate_tool_call("Bash", {"command": f"curl https://{HOST}/"}, policy, ctx)
        assert ok.action == "allow"
        other = evaluate_tool_call("Bash", {"command": "curl https://other.dev/"}, policy, ctx)
        assert other.action == BLOCK


class TestDenylistEditing:
    @pytest.mark.asyncio
    async def test_add_then_block_from_any_session_then_remove(self, db):
        body = egress_routes.DenyHostRequest(host=" Paste.Example.ORG. ")
        policy = await egress_routes.add_denied_host(body, x_sv_ui_token=TOKEN)
        assert "paste.example.org" in policy["denylist"]
        for sid in ("sess-aaaa1111", "sess-bbbb2222", None):
            out = await _call(sid, host="files.paste.example.org")
            assert out["action"] == BLOCK
            assert out["verdicts"][0]["rule_id"] == "policy.denylist"
        policy = await egress_routes.remove_denied_host(
            egress_routes.DenyHostRequest(host="paste.example.org"), x_sv_ui_token=TOKEN)
        assert "paste.example.org" not in policy["denylist"]

    @pytest.mark.asyncio
    @pytest.mark.parametrize("bad", ["http://evil.com", "evil.com/x", "evil.com:80",
                                     "*.evil.com", "ev il.com", "-evil.com", "a..b"])
    async def test_invalid_hosts_are_rejected(self, db, bad):
        with pytest.raises(HTTPException) as exc:
            await egress_routes.add_denied_host(
                egress_routes.DenyHostRequest(host=bad), x_sv_ui_token=TOKEN)
        assert exc.value.status_code == 400
        assert (await EgressRepository(db).get_active_policy())["denylist"] == []

    @pytest.mark.asyncio
    async def test_ip_literals_are_accepted(self, db):
        policy = await egress_routes.add_denied_host(
            egress_routes.DenyHostRequest(host="203.0.113.7"), x_sv_ui_token=TOKEN)
        assert "203.0.113.7" in policy["denylist"]

    @pytest.mark.asyncio
    async def test_remove_unlisted_is_404_and_token_required(self, db):
        with pytest.raises(HTTPException) as exc:
            await egress_routes.remove_denied_host(
                egress_routes.DenyHostRequest(host="nope.example.com"), x_sv_ui_token=TOKEN)
        assert exc.value.status_code == 404
        with pytest.raises(HTTPException) as exc:
            await egress_routes.add_denied_host(
                egress_routes.DenyHostRequest(host="x.example.com"), x_sv_ui_token=None)
        assert exc.value.status_code == 403


class TestSessionCard:
    @pytest.mark.asyncio
    async def test_blocked_host_names_rule_reason_and_grant(self, db):
        await _call("sess-aaaa1111")
        out = await egress_routes.get_session_destinations("sess-aaaa1111")
        row = out["destinations"][0]
        assert row["rule_id"] == "preset.contained"
        assert row["rule_title"] == "Not on the contained-run allowlist"
        assert "not listed" in row["reason"]
        assert row["promotable"] is True
        assert "grant" not in row
        await egress_routes.grant_host(
            egress_routes.HostGrantRequest(host=HOST, session_id="sess-aaaa1111",
                                           duration="session"),
            _http(MANAGER), x_sv_ui_token=TOKEN)
        row = (await egress_routes.get_session_destinations("sess-aaaa1111"))["destinations"][0]
        assert row["grant"]["duration"] == "session"

    @pytest.mark.asyncio
    async def test_baseline_rule_title_comes_from_the_pack(self, db):
        assert egress_routes._rule_title("sv.egress.cloud_metadata")


class TestToolCallsList:
    @pytest.mark.asyncio
    async def test_egress_block_listed_without_a_second_audit_row(self, db):
        await _call("sess-aaaa1111")
        out = await terminal_routes.list_verdicts("task-sess-aaaa1111", manager=MANAGER)
        assert out["items"] == []
        blocks = out["egress_blocks"]
        assert len(blocks) == 1
        assert blocks[0]["action"] == "block"
        assert blocks[0]["source"] == "egress"
        assert blocks[0]["hosts"] == [HOST]
        assert "preset.contained" in blocks[0]["reason"]
        tool_rows = await db.fetch_one("SELECT COUNT(*) AS n FROM tool_call_audit")
        egress_rows = await db.fetch_one(
            "SELECT COUNT(*) AS n FROM egress_audit WHERE action = 'block'")
        assert tool_rows["n"] == 0
        assert egress_rows["n"] == 1


class TestSessionBinding:
    @pytest.mark.asyncio
    async def test_tokenless_call_keeps_its_session_but_is_unverified(self, db):
        # A Guard plugin from 6.0.0 sends no token: the row keeps the session
        # (counts, Egress section and Tool calls work as before) but is not
        # verified, so no inbox request is filed and nothing can be granted.
        await MANAGER.task_for("sess-aaaa1111")
        out = await _call("sess-aaaa1111", verified=False)
        assert out["action"] == BLOCK
        assert await _pending(db) == []
        rows = await db.fetch_all("SELECT session_id, session_verified FROM egress_audit")
        assert [(r["session_id"], r["session_verified"]) for r in rows] == [("sess-aaaa1111", 0)]
        card = await egress_routes.get_session_destinations("sess-aaaa1111")
        assert card["blocked_calls"] == 1
        assert card["destinations"][0]["blocked"] == 1
        assert card["destinations"][0]["promotable"] is False
        with pytest.raises(HTTPException) as exc:
            await egress_routes.grant_host(
                egress_routes.HostGrantRequest(host=HOST, session_id="sess-aaaa1111",
                                               duration="session"),
                _http(MANAGER), x_sv_ui_token=TOKEN)
        assert exc.value.status_code == 404
        # The blocked call still reaches the session's Tool calls list.
        blocks = await EgressRepository(db).blocked_calls(["sess-aaaa1111"])
        assert len(blocks) == 1 and blocks[0]["hosts"] == [HOST]

    @pytest.mark.asyncio
    async def test_verified_row_is_grantable_and_a_grant_never_clears_an_unverified_one(self, db):
        await _call("sess-aaaa1111")
        rows = await db.fetch_all("SELECT session_verified FROM egress_audit")
        assert [r["session_verified"] for r in rows] == [1]
        card = await egress_routes.get_session_destinations("sess-aaaa1111")
        assert card["destinations"][0]["promotable"] is True
        await egress_routes.grant_host(
            egress_routes.HostGrantRequest(host=HOST, session_id="sess-aaaa1111",
                                           duration="session"),
            _http(MANAGER), x_sv_ui_token=TOKEN)
        assert (await _call("sess-aaaa1111"))["action"] == "allow"
        assert (await _call("sess-aaaa1111", verified=False))["action"] == BLOCK

    @pytest.mark.asyncio
    async def test_wrong_tasks_token_cannot_plant_into_another_session(self, db):
        b_task = await MANAGER.task_for("sess-bbbb2222")
        await MANAGER.task_for("sess-aaaa1111")
        hdrs = {"x-sv-terminal-task": b_task, "x-sv-terminal-hook": MANAGER.tokens[b_task]}
        await _call("sess-aaaa1111", verified=False, headers=hdrs)
        assert await _pending(db) == []
        row = await db.fetch_one("SELECT session_id FROM egress_audit")
        assert row["session_id"] is None

    @pytest.mark.asyncio
    async def test_own_token_before_the_session_is_recorded_keeps_the_claim_unverified(self, db):
        # First PreToolUse racing the hook relay: the task exists and the
        # token is its own, but no session id is recorded yet.
        task_id = "task-early"
        await MANAGER.store.create_task(task_id, executor_id="codex", workspace="/w",
                                        title=None, pid=None, session_id=None, origin="launch")
        MANAGER.tokens[task_id] = "tok-early"
        hdrs = {"x-sv-terminal-task": task_id, "x-sv-terminal-hook": "tok-early"}
        out = await _call("sess-early001", runtime="codex", verified=False, headers=hdrs)
        assert out["action"] == BLOCK
        assert await _pending(db) == []
        row = await db.fetch_one("SELECT session_id, session_verified FROM egress_audit")
        assert (row["session_id"], row["session_verified"]) == ("sess-early001", 0)

    @pytest.mark.asyncio
    async def test_grant_not_applied_without_token(self, db):
        await _call("sess-aaaa1111")
        req = (await _pending(db))[0]
        await JitAccessRepository(db).approve_request(req["id"], "session")
        assert (await _call("sess-aaaa1111"))["action"] == "allow"
        assert (await _call("sess-aaaa1111", verified=False))["action"] == BLOCK

    @pytest.mark.asyncio
    async def test_linked_session_keeps_its_audit_binding_but_files_nothing(self, db):
        await MANAGER.task_for("sess-link0001", origin="linked")
        await _call("sess-link0001", verified=False)
        assert await _pending(db) == []
        row = await db.fetch_one("SELECT session_id FROM egress_audit")
        assert row["session_id"] == "sess-link0001"


class TestControlApiSelfProtection:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("cmd", [
        "curl -X POST http://127.0.0.1:8741/api/egress/promote -d '{\"host\":\"evil.com\"}'",
        "curl -s localhost:8741/api/jit/ui-token",
        "curl -X POST 'http://[::1]:8741/api/egress/grants'",
        "curl 0.0.0.0:8741//api/tool-permissions/overrides",
        "python3 -c \"import urllib.request as u; u.urlopen('http://127.0.0.2:8741/api/jit/requests/x/approve')\"",
        "wget -qO- HTTP://LOCALHOST:8741/API/EGRESS/POLICY",
        # Loopback spellings the old host list missed: the rule keys on the
        # port and path, whatever the host.
        "curl 127.1:8741/api/egress/promote",
        "curl localhost.:8741/api/jit/ui-token",
        "curl 0x7f000001:8741/api/egress/grants",
        "curl 'http://[::ffff:7f00:1]:8741/api/egress/policy'",
        "H=127.0.0.1; curl $H:8741/api/egress/promote",
        "curl http://127.0.0.1:8741/%61pi/egress/promote",
        "curl https://example.com:8741/api/egress/promote",
    ])
    async def test_agent_call_to_control_api_is_blocked(self, db, cmd):
        repo = EgressRepository(db)
        policy = await repo.get_active_policy()
        await repo.update_policy(policy["id"], preset="baseline")
        out = await _call("sess-aaaa1111", command=cmd)
        assert out["action"] == BLOCK
        v = out["verdicts"][0]
        assert v["rule_id"] == "sv.self.control_api"
        assert v["promotable"] is False
        assert await _pending(db) == []
        # Not grantable from the pane either.
        with pytest.raises(HTTPException) as exc:
            await egress_routes.grant_host(
                egress_routes.HostGrantRequest(host=egress_routes._normalize_host(v["host"]) or "localhost",
                                               session_id="sess-aaaa1111", duration="session"),
                _http(MANAGER), x_sv_ui_token=TOKEN)
        assert exc.value.status_code in (403, 404)

    @pytest.mark.asyncio
    @pytest.mark.parametrize("cmd", [
        "curl -s localhost:9999/api/egress/promote",
        "curl -s http://127.0.0.1:8741/api/traces",
    ])
    async def test_other_ports_and_routes_are_not_this_rule(self, db, cmd):
        repo = EgressRepository(db)
        policy = await repo.get_active_policy()
        await repo.update_policy(policy["id"], preset="baseline")
        out = await _call("sess-aaaa1111", command=cmd)
        assert all(v["rule_id"] != "sv.self.control_api" for v in out["verdicts"])

    @pytest.mark.asyncio
    async def test_only_network_capable_input_is_checked(self, db):
        # Writing or searching a file that mentions the URL is not a call.
        url = "http://127.0.0.1:8741/api/egress/promote"
        for tool, inp in (
            ("Write", {"file_path": "/w/docs/api.md", "content": f"POST {url}"}),
            ("Edit", {"file_path": "/w/t.py", "old_string": "x", "new_string": url}),
            ("Grep", {"pattern": "127.0.0.1:8741/api/egress"}),
        ):
            out = await egress_routes.evaluate_egress(egress_routes.EvaluateRequest(
                tool_name=tool, tool_input=inp, session_id="sess-aaaa1111"), _http(MANAGER))
            assert out["network_capable"] is False and out["action"] == "allow", tool
        out = await egress_routes.evaluate_egress(egress_routes.EvaluateRequest(
            tool_name="Bash", tool_input={"command": f"curl -X POST {url}"},
            session_id="sess-aaaa1111"), _http(MANAGER))
        assert out["action"] == BLOCK
        assert out["verdicts"][0]["rule_id"] == "sv.self.control_api"
        out = await egress_routes.evaluate_egress(egress_routes.EvaluateRequest(
            tool_name="WebFetch", tool_input={"url": url}), _http(MANAGER))
        assert out["verdicts"][0]["rule_id"] == "sv.self.control_api"

    @pytest.mark.asyncio
    async def test_rule_follows_the_apps_own_port(self, db):
        cmd = "curl -X POST http://127.0.0.1:8761/api/egress/promote"
        out = await egress_routes.evaluate_egress(egress_routes.EvaluateRequest(
            tool_name="Bash", tool_input={"command": cmd}), _http(MANAGER, port=8761))
        assert out["verdicts"][0]["rule_id"] == "sv.self.control_api"

    @pytest.mark.asyncio
    async def test_hook_endpoints_unaffected(self, db):
        # The hooks' own POST to /egress/evaluate is not a tool call: it is
        # the request itself, and a plain tool call still evaluates normally.
        out = await _call("sess-aaaa1111", host="docs.python.org")
        assert all(v["rule_id"] != "sv.self.control_api" for v in out["verdicts"])
        from securevector.app.terminals import routes as troutes
        assert any(r.path.endswith("/tasks/{task_id}/events") for r in troutes.router.routes)


class TestHumanOnlyRoutes:
    @pytest.mark.asyncio
    async def test_promote_and_patch_need_the_token(self, db):
        for call in (
            lambda t: egress_routes.promote_destination(
                egress_routes.PromoteRequest(host="evil.com"), x_sv_ui_token=t),
            lambda t: egress_routes.patch_policy(
                egress_routes.PolicyPatch(preset="baseline"), x_sv_ui_token=t),
        ):
            for bad in (None, "nope"):
                with pytest.raises(HTTPException) as exc:
                    await call(bad)
                assert exc.value.status_code == 403
        out = await egress_routes.promote_destination(
            egress_routes.PromoteRequest(host="Evil.COM."), x_sv_ui_token=TOKEN)
        assert "evil.com" in out["policy"]["allowlist"]
        with pytest.raises(HTTPException) as exc:
            await egress_routes.promote_destination(
                egress_routes.PromoteRequest(host="http://x/y"), x_sv_ui_token=TOKEN)
        assert exc.value.status_code == 400
        policy = await egress_routes.patch_policy(
            egress_routes.PolicyPatch(preset="baseline"), x_sv_ui_token=TOKEN)
        assert policy["preset"] == "baseline"

    @pytest.mark.asyncio
    @pytest.mark.parametrize("headers,ok", [
        ({}, False),
        ({"user-agent": "curl/8.4.0"}, False),
        ({"origin": "http://evil.example"}, False),
        ({"referer": "http://127.0.0.1:87410/x"}, False),
        ({"sec-fetch-site": "same-origin"}, True),
        ({"origin": "http://127.0.0.1:8741"}, True),
        ({"referer": "http://localhost:8741/terminals"}, True),
        ({"user-agent": "Mozilla/5.0 AppleWebKit SecureVectorDesktop/6.0.0"}, True),
    ])
    async def test_ui_token_needs_a_same_origin_signal(self, headers, ok):
        req = SimpleNamespace(headers=headers, url=SimpleNamespace(port=8741))
        if ok:
            assert (await jit_routes.get_ui_token(req))["token"] == TOKEN
        else:
            with pytest.raises(HTTPException) as exc:
                await jit_routes.get_ui_token(req)
            assert exc.value.status_code == 403


class TestHostRequestCaps:
    @pytest.mark.asyncio
    async def test_per_session_cap_and_dedupe_by_session_host_rule(self, db):
        jit = JitAccessRepository(db)
        for i in range(15):
            await jit.create_host_request(f"h{i}.example.com", "preset.contained", "r",
                                          "claude-code", "sess-aaaa1111")
        mine = [r for r in await _pending(db) if r["session_id"] == "sess-aaaa1111"]
        assert len(mine) == 10
        # Same session, host and rule from another harness: the same request.
        dup = await jit.create_host_request("h0.example.com", "preset.contained", "r",
                                            "codex", "sess-aaaa1111")
        assert dup["id"] == [r for r in mine if r["tool_id"] == "egress:h0.example.com"][0]["id"]
        # Another session still gets its own.
        other = await jit.create_host_request("h0.example.com", "preset.contained", "r",
                                              "claude-code", "sess-bbbb2222")
        assert other is not None

    @pytest.mark.asyncio
    async def test_host_requests_never_starve_tool_requests(self, db):
        jit = JitAccessRepository(db)
        for s in range(6):
            for i in range(10):
                await jit.create_host_request(f"h{i}.example.com", "preset.contained", "r",
                                              "claude-code", f"sess-{s:08d}")
        tool = await jit.create_request(tool_id="Bash", rule_source="local",
                                        runtime_kind="claude-code", session_id="sess-x")
        assert tool is not None
        hosts = [r for r in await jit.list_requests(status="pending", limit=500)
                 if r["tool_id"].startswith("egress:")]
        assert len(hosts) == 50


class TestGrantsEndWithTheTask:
    @pytest.mark.asyncio
    async def test_archive_and_exit_revoke_host_grants(self, db):
        from securevector.app.terminals.manager import TerminalManager

        for sid in ("sess-aaaa1111", "sess-bbbb2222"):
            await _call(sid)
        for r in await _pending(db):
            await JitAccessRepository(db).approve_request(r["id"], "session")
        # Drive the manager's own revoke helper against the fake's store.
        fake = SimpleNamespace(store=MANAGER.store)
        await TerminalManager._revoke_host_grants(fake, "task-sess-aaaa1111")
        assert (await _call("sess-aaaa1111"))["action"] == BLOCK
        assert (await _call("sess-bbbb2222"))["action"] == "allow"
