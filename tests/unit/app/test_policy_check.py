"""Pre-flight policy checks: check_policy and session_burn.

- Canonical descriptors: equivalent spellings hash equal, near misses do
  not, and nothing touches the file system or resolves a name.
- Decision tokens: bound to session, action, target, policy version and
  expiry; single use; a forged tag is refused before any lookup.
- Responses: one fixed shape; a denied target and an absent one give the
  same bytes; no rule id or rule text; the rate limit and an unreachable app
  give `indeterminate`, never `allow`; every check is audited.
- Enforcement: the Guard's egress check matches calls against recent checks
  for metrics, and still evaluates every call in full.
- An action attempted after a deny is recorded and reaches the drift score.
- session_burn sources, and the MCP tool schemas.
- In the loop: a Claude Code-shaped PreToolUse call checked through the MCP
  tool, then attempted.
"""

import asyncio
import json
import os
import socket
from pathlib import Path
from types import SimpleNamespace

import pytest
import pytest_asyncio
from starlette.datastructures import Headers

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import (
    CURRENT_SCHEMA_VERSION,
    ensure_policy_check_tables,
    migrate_to_v58,
    run_migrations,
)
from securevector.app.database.repositories.egress import EgressRepository
from securevector.app.database.repositories.policy_decisions import PolicyDecisionsRepository, iso
from securevector.app.database.repositories.tool_permissions import ToolPermissionsRepository
from securevector.app.server.routes import egress as egress_routes
from securevector.app.server.routes import hooks_claude_code as cc_routes
from securevector.app.server.routes import policy as policy_routes
from securevector.app.server.routes import tool_permissions as tp_routes
from securevector.app.services import mcp_registration, policy_check, session_drift
from securevector.app.terminals.store import TerminalStore
from securevector.core.egress import BLOCK, EgressEvaluation
from securevector.core.egress import canonical
from securevector.core.egress.engine import SELF_CONTROL_RULE_ID, evaluate_tool_call
from securevector.mcp.tools import policy_tools

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "claude_code_pre_tool_use_curl.json").read_text())
SID = FIXTURE["session_id"]
TASK = "task-preflight-1"
TOKEN = "hook-token-preflight-1"


class _FakeManager:
    def __init__(self, db):
        self.store = TerminalStore(db)
        self.tokens = {}

    def hook_token(self, task_id):
        return self.tokens.get(task_id)


class _Req:
    """Enough of a Starlette Request for the policy routes."""

    def __init__(self, manager, body=None, headers=None, port=8741):
        self._body = json.dumps(body).encode() if body is not None else b""
        base = {"content-type": "application/json", "host": f"127.0.0.1:{port}"}
        base.update(headers or {})
        self.headers = Headers(base)
        self.app = SimpleNamespace(state=SimpleNamespace(terminal_manager=manager, port=port))
        self.url = SimpleNamespace(port=port)

    async def body(self):
        return self._body


def _http(manager, headers=None, port=8741):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(terminal_manager=manager)),
                           headers=headers or {}, url=SimpleNamespace(port=port))


@pytest_asyncio.fixture
async def world(tmp_path, monkeypatch):
    conn = DatabaseConnection(tmp_path / "preflight.db")
    await run_migrations(conn)
    for mod in (egress_routes, tp_routes, policy_routes):
        monkeypatch.setattr(mod, "get_database", lambda: conn)
    manager = _FakeManager(conn)
    await manager.store.create_task(TASK, executor_id="claude-code", workspace="/w/app", title=None,
                                    pid=None, session_id=SID)
    manager.tokens[TASK] = TOKEN
    policy_check.CHECK_LIMITER = policy_check.RateLimiter()
    policy_check.BURN_LIMITER = policy_check.RateLimiter()
    policy_check._burn_cache.clear()
    policy_tools._state["session"] = None
    return SimpleNamespace(db=conn, manager=manager)


def _verified_headers():
    return {"x-sv-terminal-task": TASK, "x-sv-terminal-hook": TOKEN}


async def _check(world, tool_name, tool_input, *, headers=None, session=None, **kw):
    hdrs = _verified_headers() if headers is None else headers
    caller = await policy_check.caller_from_headers(world.manager, hdrs, "claude-code", "/w/app")
    return await policy_check.check(world.db, caller, tool_name, tool_input, session, **kw)


async def _evaluate(world, tool_input, *, verified=True):
    hdrs = _verified_headers() if verified else {}
    return await egress_routes.evaluate_egress(egress_routes.EvaluateRequest(
        tool_name="Bash", tool_input=tool_input, runtime_kind="claude-code", session_id=SID,
    ), _http(world.manager, hdrs))


# --- storage -----------------------------------------------------------------------


class TestMigration:
    @pytest.mark.asyncio
    async def test_v58_tables_and_idempotent(self, world):
        assert CURRENT_SCHEMA_VERSION == 58
        names = {r["name"] for r in await world.db.fetch_all(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        assert {"logical_sessions", "policy_decisions"} <= names
        await ensure_policy_check_tables(world.db)
        await migrate_to_v58(world.db)
        row = await world.db.fetch_one("SELECT MAX(version) AS v FROM schema_version")
        assert row["v"] == 58


# --- 1. canonicalisation --------------------------------------------------------------

EQUIVALENT = [
    (("Bash", {"command": "ls -la"}), ("Bash", {"command": "  ls   -la  "})),
    (("Bash", {"command": "ls"}), ("bash", {"command": "ls"})),
    (("Bash", {"command": "ls", "description": "a"}), ("Bash", {"command": "ls", "description": "b"})),
    (("Bash", {"command": "ls", "timeout": 1000}), ("Bash", {"command": "ls"})),
    (("Bash", {"command": "curl https://example.com"}), ("Bash", {"command": "curl 'https://example.com'"})),
    (("Bash", {"command": "curl https://example.com"}), ("Bash", {"command": 'curl "https://example.com"'})),
    (("Bash", {"command": "curl https://EXAMPLE.com"}), ("Bash", {"command": "curl https://example.com"})),
    (("Bash", {"command": "curl https://example.com:443/"}), ("Bash", {"command": "curl https://example.com/"})),
    (("Bash", {"command": "curl http://example.com:80/x"}), ("Bash", {"command": "curl http://example.com/x"})),
    (("Bash", {"command": "curl https://example.com./x"}), ("Bash", {"command": "curl https://example.com/x"})),
    (("Bash", {"command": "curl https://example.com/a/../b"}), ("Bash", {"command": "curl https://example.com/b"})),
    (("Bash", {"command": "curl https://example.com/%61"}), ("Bash", {"command": "curl https://example.com/a"})),
    (("Bash", {"command": "ls '*.py'"}), ("Bash", {"command": 'ls "*.py"'})),
    (("Bash", {"command": "a&&b"}), ("Bash", {"command": "a && b"})),
    (("Bash", {"command": "echo hi>out"}), ("Bash", {"command": "echo hi > out"})),
    (("Bash", {"command": "rm 'a b'"}), ("Bash", {"command": 'rm "a b"'})),
    (("Read", {"file_path": "/w/app/src/../x.py"}), ("Read", {"file_path": "/w/app/x.py"})),
    (("Read", {"file_path": "/w/app/x.py"}), ("Read", {"file_path": "  '/w/app/x.py'  "})),
    (("Read", {"file_path": "/w/app/x.py", "offset": 10}), ("Read", {"file_path": "/w/app/x.py"})),
    (("Write", {"file_path": "/w//app/./x.py", "content": "z"}), ("Write", {"file_path": "/w/app/x.py", "content": "z"})),
    (("WebFetch", {"url": "HTTPS://Example.com/a/./b", "prompt": "p"}),
     ("WebFetch", {"url": "https://example.com/a/b", "prompt": "q"})),
    (("WebFetch", {"url": "https://example.com"}), ("WebFetch", {"url": "https://example.com/"})),
    (("WebSearch", {"query": "  Rust   Lifetimes "}), ("WebSearch", {"query": "rust lifetimes"})),
    (("mcp__github__create_issue", {"title": "t", "body": "b"}),
     ("mcp__github__create_issue", {"body": "b", "title": "t"})),
    (("Glob", {"pattern": "*.py"}), ("Glob", {"pattern": "*.py", "path": "."})),
]

NEAR_MISS = [
    (("Bash", {"command": "rm a b"}), ("Bash", {"command": "rm 'a b'"})),
    (("Bash", {"command": "echo &&"}), ("Bash", {"command": "echo '&&'"})),
    (("Bash", {"command": 'echo "$HOME"'}), ("Bash", {"command": "echo '$HOME'"})),
    (("Bash", {"command": "curl https://example.com/a"}), ("Bash", {"command": "curl https://example.com/b"})),
    (("Bash", {"command": "curl https://example.com"}), ("Bash", {"command": "curl https://example.org"})),
    (("Bash", {"command": "ls"}), ("PowerShell", {"command": "ls"})),
    (("Read", {"file_path": "/w/app/x.py"}), ("Write", {"file_path": "/w/app/x.py", "content": ""})),
    (("Write", {"file_path": "/w/app/x.py", "content": "a"}), ("Write", {"file_path": "/w/app/x.py", "content": "b"})),
    (("Read", {"file_path": "/w/app/x.py"}), ("Read", {"file_path": "/w/app/y.py"})),
    (("mcp__github__create_issue", {"title": "t"}), ("mcp__github__close_issue", {"title": "t"})),
]


class TestCanonical:
    @pytest.fixture(autouse=True)
    def _no_io(self, monkeypatch):
        def boom(*a, **k):
            raise AssertionError("canonicalisation touched the file system or DNS")

        for name in ("stat", "lstat", "listdir", "scandir"):
            monkeypatch.setattr(os, name, boom)
        monkeypatch.setattr(os.path, "exists", boom)
        monkeypatch.setattr(os.path, "realpath", boom)
        monkeypatch.setattr(socket, "getaddrinfo", boom)
        monkeypatch.setattr(socket, "gethostbyname", boom)

    def test_counts(self):
        assert len(EQUIVALENT) == 25 and len(NEAR_MISS) == 10

    @pytest.mark.parametrize("a,b", EQUIVALENT)
    def test_equivalent_pairs_hash_equal(self, a, b):
        x, y = canonical.canonical_action(*a), canonical.canonical_action(*b)
        assert x == y

    @pytest.mark.parametrize("a,b", NEAR_MISS)
    def test_near_misses_differ(self, a, b):
        assert canonical.canonical_action(*a).action_hash != canonical.canonical_action(*b).action_hash

    @pytest.mark.parametrize("a,b", [
        ("sed s/x/../y/", "sed s/y/"),
        ('cat "$A/../b"', "cat b"),
        ('cat "$A/../b"', 'cat "$A/b"'),
        ("cat $A/../b", "cat b"),
        ("ls *", "ls '*'"),
        ('ls *', 'ls "*"'),
        ("echo $X", "echo '$X'"),
        ('echo "$X"', "echo $X"),
        ("cat ~/x", "cat '~/x'"),
        ("cat ./a/../b.txt", "cat b.txt"),
    ])
    def test_quoting_and_words_are_kept(self, a, b):
        x = canonical.canonical_action("Bash", {"command": a})
        y = canonical.canonical_action("Bash", {"command": b})
        assert x.action_hash != y.action_hash

    def test_sed_expression_is_not_rewritten(self):
        assert canonical.normalize_command("sed s/x/../y/ f") == "sed s/x/../y/ f"
        assert canonical.normalize_command('cat "$A/../b"') == 'cat "$A/../b"'

    def test_kinds(self):
        kind = lambda n, i: canonical.canonical_action(n, i).kind  # noqa: E731
        assert kind("Bash", {"command": "ls"}) == canonical.SHELL
        assert kind("Read", {"file_path": "/a"}) == canonical.FILE_READ
        assert kind("Edit", {"file_path": "/a", "old_string": "x", "new_string": "y"}) == canonical.FILE_WRITE
        assert kind("WebFetch", {"url": "https://a.b"}) == canonical.NETWORK
        assert kind("mcp__s__t", {}) == canonical.MCP
        assert kind("TodoWrite", {"todos": []}) == canonical.OTHER

    @pytest.mark.parametrize("name,inp", [("", {}), (None, {}), ("Bash", "ls"), ("Bash", {}), ("mcp__x", {})])
    def test_unsupported(self, name, inp):
        with pytest.raises(canonical.UnsupportedAction):
            canonical.canonical_action(name, inp)


# --- response shape ----------------------------------------------------------------------

FIELDS = {"decision", "reason", "policy_version", "token", "expires_at", "session", "advisory"}


class TestShape:
    @pytest.mark.asyncio
    async def test_every_field_always_present(self, world):
        await ToolPermissionsRepository(world.db).upsert_override("Write", "block")
        answers = [
            await _check(world, "Bash", {"command": "ls"}),
            await _check(world, "Write", {"file_path": "/w/app/a", "content": "x"}),
            await _check(world, "Bash", "not a dict"),
        ]
        for a in answers:
            assert set(a) == FIELDS
            assert a["advisory"] is False
            assert len(json.dumps(a)) <= policy_check.RESPONSE_CAP
        assert [a["decision"] for a in answers] == ["allow", "deny", "indeterminate"]
        assert answers[2]["reason"] == "unsupported_action"
        assert answers[0]["token"].startswith("svd1.") and answers[0]["expires_at"]
        assert answers[1]["token"] is None and answers[1]["expires_at"] is None

    @pytest.mark.asyncio
    async def test_route_bad_body_is_a_decision(self, world):
        req = _Req(world.manager, headers=_verified_headers())
        req._body = b"{not json"
        out = await policy_routes.check_policy(req)
        assert out["decision"] == "indeterminate" and out["reason"] == "unsupported_action"

    @pytest.mark.asyncio
    async def test_prompt_is_needs_approval_and_files_nothing(self, world, monkeypatch):
        async def rows(harness, sid):
            return [{"tool_id": "Bash", "effect": "prompt", "source": "synced", "requestable": True}]

        monkeypatch.setattr(policy_check, "_tool_rows", rows)
        out = await _check(world, "Bash", {"command": "make deploy"})
        assert out["decision"] == "needs_approval" and out["reason"] == "approval_required"
        assert out["token"]
        n = await world.db.fetch_one("SELECT COUNT(*) AS n FROM jit_access_requests")
        assert n["n"] == 0


# --- 2. tokens and replay --------------------------------------------------------------------


class TestToken:
    @pytest.mark.asyncio
    async def test_format_and_tag(self, world):
        out = await _check(world, "Bash", {"command": "ls"})
        jti, tag = policy_check.parse_token(out["token"])
        row = await PolicyDecisionsRepository(world.db).get_decision(jti)
        assert policy_check.token_matches_row(out["token"], row)
        assert len(tag) == 22
        edited = out["token"][:-1] + ("A" if out["token"][-1] != "A" else "B")
        assert not policy_check.token_matches_row(edited, row)

    @pytest.mark.asyncio
    async def test_single_use_and_bindings(self, world):
        call = {"command": "ls"}
        out = await _check(world, "Bash", call)
        sess = out["session"]
        consume = policy_check.consume_token
        assert await consume(world.db, out["token"], "Bash", {"command": "ls -l"}, session=sess) == "mismatch"
        assert await consume(world.db, out["token"], "Bash", call, session="svs_0000000000000000") == "other_session"
        assert await consume(world.db, out["token"], "Bash", call, session=sess) == "matched"
        assert await consume(world.db, out["token"], "Bash", call, session=sess) == "replayed"

    @pytest.mark.asyncio
    async def test_edited_tag_is_refused_before_lookup(self, world, monkeypatch):
        out = await _check(world, "Bash", {"command": "ls"})
        jti, tag = policy_check.parse_token(out["token"])
        assert await policy_check.consume_token(world.db, "svd1.zz.short", "Bash", {"command": "ls"},
                                                session=out["session"]) == "forged"
        forged = f"svd1.{jti}.{'A' * 22}"
        assert await policy_check.consume_token(world.db, forged, "Bash", {"command": "ls"},
                                                session=out["session"]) == "forged"
        # The real token still works afterwards.
        assert await policy_check.consume_token(world.db, out["token"], "Bash", {"command": "ls"},
                                                session=out["session"]) == "matched"

    @pytest.mark.asyncio
    async def test_policy_change_and_expiry_force_reevaluation(self, world):
        repo = EgressRepository(world.db)
        out = await _check(world, "Bash", {"command": "ls"})
        pol = await repo.get_active_policy()
        await repo.update_policy(pol["id"], preset="hardened")
        assert await policy_check.consume_token(world.db, out["token"], "Bash", {"command": "ls"},
                                                session=out["session"]) == "policy_changed"
        now = 1_900_000_000.0
        out2 = await _check(world, "Bash", {"command": "pwd"}, now=now)
        assert await policy_check.consume_token(world.db, out2["token"], "Bash", {"command": "pwd"},
                                                session=out2["session"], now=now + 121) == "expired"

    @pytest.mark.asyncio
    async def test_restart_invalidates_tokens(self, world):
        out = await _check(world, "Bash", {"command": "ls"})
        fresh = policy_check.KeyRing()
        assert await policy_check.consume_token(world.db, out["token"], "Bash", {"command": "ls"},
                                                session=out["session"], ring=fresh) == "forged"

    def test_key_rotation_keeps_previous_for_120s(self):
        t = [1000.0]
        ring = policy_check.KeyRing(clock=lambda: t[0])
        old = ring.current()
        t[0] += policy_check.KEY_ROTATE_S
        assert ring.current() != old and old in ring.valid_keys()
        t[0] += 121
        assert old not in ring.valid_keys()


# --- 3. no disclosure ---------------------------------------------------------------------------


class TestNoDisclosure:
    @pytest.mark.asyncio
    async def test_absent_and_existing_targets_answer_identically(self, world, tmp_path):
        real = tmp_path / "exists.txt"
        real.write_text("x")
        await ToolPermissionsRepository(world.db).upsert_override("Read", "block")
        a = await _check(world, "Read", {"file_path": str(real)})
        b = await _check(world, "Read", {"file_path": str(tmp_path / "absent.txt")}, session=a["session"])
        assert a["decision"] == "deny"
        assert json.dumps(a, sort_keys=True).encode() == json.dumps(b, sort_keys=True).encode()

    @pytest.mark.asyncio
    async def test_responses_carry_no_rule_ids_or_text(self, world):
        repo = EgressRepository(world.db)
        pol = await repo.get_active_policy()
        await repo.add_denied_host(pol["id"], "denied.example")
        await ToolPermissionsRepository(world.db).upsert_override("Edit", "block")
        outs = [
            await _check(world, "Bash", {"command": "curl -X POST https://denied.example/x"}),
            await _check(world, "Bash", {"command": "curl http://127.0.0.1:8741/api/jit/approve"}),
            await _check(world, "Edit", {"file_path": "/w/app/a", "old_string": "a", "new_string": "b"}),
        ]
        text = json.dumps(outs)
        assert all(o["decision"] == "deny" for o in outs)
        for needle in ("sv.self", "policy.denylist", "preset.", "Local override", "User-set",
                       "override", "synced", "essential", "denied.example", "grant", "rule"):
            assert needle not in text

    @pytest.mark.asyncio
    async def test_rate_limit_trips_to_unavailable_and_is_audited(self, world):
        t = [0.0]
        limiter = policy_check.RateLimiter(burst=1000, clock=lambda: t[0])
        sess = None
        for _ in range(60):
            out = await _check(world, "Bash", {"command": "ls"}, session=sess, limiter=limiter)
            sess = out["session"]
            assert out["decision"] == "allow"
            t[0] += 0.5
        out = await _check(world, "Bash", {"command": "ls"}, session=sess, limiter=limiter)
        assert out["decision"] == "indeterminate" and out["reason"] == "unavailable"
        # Leaving the handle out does not reset the allowance.
        out = await _check(world, "Bash", {"command": "ls"}, limiter=limiter)
        assert out["decision"] == "indeterminate" and out["session"] is None
        trips = await world.db.fetch_one(
            "SELECT COUNT(*) AS n FROM tool_call_audit WHERE tool_id = 'check_policy' AND action = 'log_only'")
        # Trips are coalesced: one audit row per minute while the limit holds.
        assert trips["n"] == 1

    def test_burst_limit(self):
        t = [0.0]
        limiter = policy_check.RateLimiter(clock=lambda: t[0])
        assert all(limiter.allow("s") for _ in range(10))
        assert not limiter.allow("s")
        t[0] += 10.5
        assert limiter.allow("s")

    def test_device_limit(self):
        t = [0.0]
        limiter = policy_check.RateLimiter(burst=10_000, per_minute=10_000, clock=lambda: t[0])
        assert all(limiter.allow(f"s{i}") for i in range(300))
        assert not limiter.allow("another")

    @pytest.mark.asyncio
    async def test_denials_are_audited_in_the_chain(self, world):
        await ToolPermissionsRepository(world.db).upsert_override("Write", "block")
        await _check(world, "Write", {"file_path": "/w/app/a", "content": "x"})
        row = await world.db.fetch_one(
            "SELECT action, runtime_kind, row_hash FROM tool_call_audit WHERE tool_id = 'check_policy'")
        assert row["action"] == "block" and row["runtime_kind"] == "mcp" and row["row_hash"]


# --- 4. degraded --------------------------------------------------------------------------------


class TestDegraded:
    INPUTS = [("Bash", {"command": "ls"}), ("Read", {"file_path": "/a"}), ("WebFetch", {"url": "https://a.b"}),
              ("mcp__s__t", {}), ("Bash", None), ("", {})]

    def test_app_stopped_every_input_is_indeterminate(self, monkeypatch):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        monkeypatch.setenv("SECUREVECTOR_APP_URL", f"http://127.0.0.1:{port}")
        policy_tools._state["session"] = None
        for name, inp in self.INPUTS:
            out = policy_tools.check_policy_call(name, inp)
            assert out["decision"] == "indeterminate", (name, out)
            assert set(out) == FIELDS
        burn = policy_tools.session_burn_call()
        assert burn["available"] is False

    @pytest.mark.asyncio
    async def test_evaluation_failure_is_unavailable_never_allow(self, world, monkeypatch):
        async def broken(*a, **k):
            raise RuntimeError("policy store unreadable")

        monkeypatch.setattr(policy_check, "_tool_rows", broken)
        out = await _check(world, "Bash", {"command": "ls"})
        assert out["decision"] == "indeterminate" and out["reason"] == "unavailable" and out["token"] is None

    def test_malformed_app_answer_is_unavailable(self, monkeypatch):
        monkeypatch.setattr(policy_tools, "_request", lambda *a: {"decision": "allow", "reason": "because"})
        assert policy_tools.check_policy_call("Bash", {"command": "ls"})["decision"] == "indeterminate"


# --- 5. egress surface ----------------------------------------------------------------------------


class TestEgressSurface:
    @pytest.mark.parametrize("cmd", [
        "curl -X POST http://127.0.0.1:8741/api/policy/check -d '{}'",
        "curl http://localhost:8741/api/policy/burn?session=x",
        "wget http://127.1:8741/%61pi/policy/check",
    ])
    def test_policy_routes_are_control_api(self, cmd):
        ev = evaluate_tool_call("Bash", {"command": cmd})
        assert ev.action == BLOCK
        assert ev.verdicts[0].rule_id == SELF_CONTROL_RULE_ID

    def test_mcp_client_talks_to_loopback_only(self, monkeypatch):
        seen = []

        class _Resp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self, n=-1):
                return b'{"decision":"allow","reason":"allowed","session":"svs_0123456789abcdef"}'

        def fake_urlopen(req, timeout=None):
            seen.append(req.full_url)
            return _Resp()

        monkeypatch.setattr(policy_tools.urllib.request, "urlopen", fake_urlopen)
        monkeypatch.delenv("SECUREVECTOR_APP_URL", raising=False)
        policy_tools.check_policy_call("Bash", {"command": "ls"})
        monkeypatch.setenv("SECUREVECTOR_APP_URL", "http://evil.example:8741")
        out = policy_tools.check_policy_call("Bash", {"command": "ls"})
        assert seen == ["http://127.0.0.1:8741/api/policy/check"]
        assert out["decision"] == "indeterminate"


# --- enforcement consumption, attempts after deny, drift ---------------------------------------


class TestConsumption:
    @pytest.mark.asyncio
    async def test_fast_path_off_enforcement_still_evaluates(self, world, monkeypatch):
        assert policy_check.DECISION_TOKEN_FAST_PATH is False
        call = FIXTURE["tool_input"]
        out = await _check(world, "Bash", call)
        assert out["decision"] == "allow"
        calls = []
        real = egress_routes.evaluate_tool_call

        def spy(*a, **k):
            calls.append(a[0])
            ev = real(*a, **k)
            return EgressEvaluation(action=BLOCK, verdicts=ev.verdicts, network_capable=True,
                                    coverage=ev.coverage, reason="blocked")

        monkeypatch.setattr(egress_routes, "evaluate_tool_call", spy)
        verdict = await _evaluate(world, call)
        assert calls == ["Bash"] and verdict["action"] == BLOCK
        row = await world.db.fetch_one("SELECT consume_result, consumed_at FROM policy_decisions")
        assert row["consume_result"] == "matched" and row["consumed_at"]

    @pytest.mark.asyncio
    async def test_replay_and_unverified(self, world):
        call = FIXTURE["tool_input"]
        await _check(world, "Bash", call)
        await _evaluate(world, call)
        assert (await policy_check.consume_for_call(
            world.db, "Bash", call, task_id=TASK, verified=True, harness="claude-code",
            harness_session_id=SID))["result"] == "replayed"
        await _check(world, "Bash", {"command": "curl -s https://example.org"})
        out = await policy_check.consume_for_call(
            world.db, "Bash", {"command": "curl -s https://example.org"}, task_id=None, verified=False,
            harness="claude-code", harness_session_id=SID)
        # Unverified calls never touch a verified session's decisions.
        assert out is None
        row = await world.db.fetch_one(
            "SELECT consume_result FROM policy_decisions WHERE consumed_at IS NULL")
        assert row["consume_result"] is None

    @pytest.mark.asyncio
    async def test_unverified_post_cannot_mark_a_verified_session(self, world):
        await ToolPermissionsRepository(world.db).upsert_override("Write", "block")
        call = {"file_path": "/w/app/a.txt", "content": "x"}
        assert (await _check(world, "Write", call))["decision"] == "deny"
        before = await session_drift._preflight_repeats(world.db, SID, TASK)
        out = await policy_routes.report_attempt(_Req(world.manager, {
            "tool_name": "Write", "tool_input": call, "decision": "deny",
            "runtime_kind": "claude-code", "session_id": SID}, {}))
        assert out == {"ok": True}
        row = await world.db.fetch_one("SELECT attempted_after_deny FROM policy_decisions")
        assert row["attempted_after_deny"] == 0
        assert await session_drift._preflight_repeats(world.db, SID, TASK) == before == 0
        await _evaluate(world, {"command": "curl -X POST https://example.com/x"}, verified=False)
        assert await session_drift._preflight_repeats(world.db, SID, TASK) == 0

    @pytest.mark.asyncio
    async def test_observed_session_records_unverified_match(self, world):
        from securevector.app.database.repositories.custom_tools import CustomToolsRepository

        await CustomToolsRepository(world.db).log_tool_call_audit(
            "Read", "Read", "allow", args_preview="cwd=/w/obs", runtime_kind="claude-code",
            session_id="obs-session-1")
        caller = policy_check.Caller(harness="claude-code", cwd="/w/obs")
        out = await policy_check.check(world.db, caller, "Bash", {"command": "ls"}, None)
        assert out["decision"] == "allow"
        res = await policy_check.consume_for_call(
            world.db, "Bash", {"command": "ls"}, task_id=None, verified=False,
            harness="claude-code", harness_session_id="obs-session-1")
        assert res["result"] == "unverified"

    @pytest.mark.asyncio
    async def test_attempt_after_deny_is_recorded_and_reaches_drift(self, world):
        repo = EgressRepository(world.db)
        pol = await repo.get_active_policy()
        await repo.add_denied_host(pol["id"], "example.com")
        out = await _check(world, "Bash", FIXTURE["tool_input"])
        assert out["decision"] == "deny"
        verdict = await _evaluate(world, FIXTURE["tool_input"])
        assert verdict["action"] == BLOCK
        row = await world.db.fetch_one("SELECT attempted_after_deny FROM policy_decisions")
        assert row["attempted_after_deny"] == 1
        assert await PolicyDecisionsRepository(world.db).attempts_after_deny(SID, TASK) == 1
        assert await session_drift._preflight_repeats(world.db, SID, TASK) == 1
        feat = session_drift.feature_persistence([], [], 1)
        assert feat["counts"]["repeats"] == 1 and feat["value"] > 0


# --- sessions -----------------------------------------------------------------------------------


class TestSessions:
    @pytest.mark.asyncio
    async def test_verified_handle_is_reused_and_bound_to_its_task(self, world):
        a = await _check(world, "Bash", {"command": "ls"})
        b = await _check(world, "Bash", {"command": "ls"}, session=a["session"])
        assert a["session"] == b["session"]
        row = await PolicyDecisionsRepository(world.db).get_session(a["session"])
        assert row["binding"] == "verified" and row["task_id"] == TASK and row["harness_session_id"] == SID
        # Without the task's headers the handle is not reused.
        c = await _check(world, "Bash", {"command": "ls"}, headers={}, session=a["session"])
        assert c["session"] != a["session"]
        bad = await _check(world, "Bash", {"command": "ls"},
                           headers={"x-sv-terminal-task": TASK, "x-sv-terminal-hook": "wrong"})
        ls = await PolicyDecisionsRepository(world.db).get_session(bad["session"])
        assert ls["binding"] == "unlinked" and ls["task_id"] is None

    @pytest.mark.asyncio
    async def test_observed_links_to_unclaimed_session_in_same_folder(self, world):
        from securevector.app.database.repositories.custom_tools import CustomToolsRepository

        await CustomToolsRepository(world.db).log_tool_call_audit(
            "Read", "Read", "allow", args_preview="cwd=/w/other", runtime_kind="claude-code",
            session_id="ext-session-1")
        caller = policy_check.Caller(harness="claude-code", cwd="/w/other")
        row = await policy_check.resolve_session(world.db, caller, None)
        assert row["binding"] == "observed" and row["harness_session_id"] == "ext-session-1"
        other = await policy_check.resolve_session(world.db, policy_check.Caller(harness="claude-code",
                                                                                  cwd="/w/elsewhere"), None)
        assert other["binding"] == "unlinked"


# --- session_burn ------------------------------------------------------------------------------------


def _transcript(root: Path, sid: str) -> Path:
    d = root / "-w-app"
    d.mkdir(parents=True, exist_ok=True)
    lines = [
        {"type": "user", "timestamp": "2026-10-08T10:00:00.000Z", "message": {"role": "user", "content": "hi"}},
        {"timestamp": "2026-10-08T10:00:05.000Z", "message": {"model": "claude-sonnet-4-5", "usage": {
            "input_tokens": 100, "output_tokens": 50, "cache_creation_input_tokens": 1000,
            "cache_read_input_tokens": 2000}}},
        {"timestamp": "2026-10-08T10:01:00.000Z", "message": {"model": "claude-sonnet-4-5", "usage": {
            "input_tokens": 10, "output_tokens": 5, "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 3000}}},
        {"timestamp": "2026-10-08T10:01:01.000Z", "message": {"model": "<synthetic>", "usage": {"input_tokens": 0}}},
    ]
    p = d / f"{sid}.jsonl"
    p.write_text("\n".join(json.dumps(x) for x in lines) + "\n")
    return p


class TestBurn:
    @pytest.mark.asyncio
    async def test_transcript_tokens_match_the_statusline_source(self, world, tmp_path, monkeypatch):
        root = tmp_path / "projects"
        path = _transcript(root, SID)
        monkeypatch.setattr(cc_routes, "CLAUDE_PROJECTS_DIR", root)
        await world.db.execute(
            "INSERT OR REPLACE INTO model_pricing (id, provider, model_id, display_name, input_per_million, "
            "output_per_million) VALUES ('t1', 'anthropic', 'claude-sonnet-4-5', 'S', 3.0, 15.0)")
        first = await _check(world, "Bash", {"command": "ls"})
        caller = await policy_check.caller_from_headers(world.manager, _verified_headers(), "claude-code", None)
        out = await policy_check.burn(world.db, caller, first["session"])
        turns, inp, outp, cw, cr, *_ = cc_routes._aggregate_session_usage(path)
        assert out["available"] is True and out["cost_basis"] == "estimate"
        assert out["tokens"] == {"input": inp, "output": outp, "cache_read": cr, "cache_write": cw}
        assert out["calls"] == turns == 2
        expected = (110 * 3 + 55 * 15 + 5000 * 3 * 0.1 + 1000 * 3 * 1.25) / 1e6
        assert abs(out["cost_usd"] - expected) <= expected * 0.01
        assert out["since"] == "2026-10-08T10:00:00.000Z"
        assert str(path) not in json.dumps(out) and "-w-app" not in json.dumps(out)

    @pytest.mark.asyncio
    async def test_recorded_costs_when_no_transcript(self, world, tmp_path, monkeypatch):
        monkeypatch.setattr(cc_routes, "CLAUDE_PROJECTS_DIR", tmp_path / "none")
        await world.db.execute(
            "INSERT INTO llm_cost_records (id, agent_id, provider, model_id, input_tokens, output_tokens, "
            "total_cost_usd, session_id) VALUES ('c1', 'a', 'anthropic', 'm1', 40, 60, 0.25, ?)", (SID,))
        first = await _check(world, "Bash", {"command": "ls"})
        caller = await policy_check.caller_from_headers(world.manager, _verified_headers(), "claude-code", None)
        out = await policy_check.burn(world.db, caller, first["session"])
        assert out["available"] and out["cost_basis"] == "recorded" and out["cost_usd"] == 0.25
        assert out["tokens"]["input"] == 40 and out["tokens"]["output"] == 60

    @pytest.mark.asyncio
    async def test_unlinked_and_foreign_sessions_are_unavailable(self, world):
        caller = policy_check.Caller(harness="claude-code", cwd="/nowhere")
        out = await policy_check.burn(world.db, caller, None)
        assert out["available"] is False and out["session"].startswith("svs_")
        verified = await _check(world, "Bash", {"command": "ls"})
        assert (await policy_check.burn(world.db, caller, verified["session"]))["available"] is False
        assert (await policy_check.burn(world.db, caller, "../etc"))["available"] is False


# --- MCP tools ------------------------------------------------------------------------------------------


class TestMcpTools:
    @pytest.mark.asyncio
    async def test_schemas(self):
        from mcp.server.fastmcp import FastMCP

        m = FastMCP("t")
        policy_tools.setup_policy_tools(m, None, ["check_policy", "session_burn"])
        tools = {t.name: t for t in await m.list_tools()}
        assert set(tools) == {"check_policy", "session_burn"}
        cp = tools["check_policy"]
        assert cp.inputSchema["required"] == ["tool_name"]
        assert set(cp.inputSchema["properties"]) == {"tool_name", "tool_input", "session"}
        assert "deny means do not attempt" in cp.description
        assert "shell, network, file write or MCP" in cp.description
        sb = tools["session_burn"]
        assert set(sb.inputSchema["properties"]) == {"session"}
        assert "30 seconds" in sb.description and "estimate" in sb.description
        for t in tools.values():
            assert "\u2014" not in t.description

    def test_cli_tools_flag_limits_the_server(self):
        from securevector.mcp import __main__ as cli

        args = SimpleNamespace(mode="balanced", api_key=None, host="localhost", port=8000,
                               transport="stdio", tools="check_policy,session_burn")
        config = cli.get_config_from_args(args)
        assert config.enabled_tools == ["check_policy", "session_burn"]
        assert config.enable_resources is False and config.enable_prompts is False


# --- 6. in the loop ---------------------------------------------------------------------------------------


class TestInLoop:
    """A Claude Code-shaped PreToolUse call: the agent asks check_policy
    through the MCP tool (task env set, as Agent Sessions launches it), then
    makes the call, which the Guard's egress check sees."""

    @pytest.fixture
    def mcp_env(self, monkeypatch):
        monkeypatch.setenv("SV_TERMINAL_TASK_ID", TASK)
        monkeypatch.setenv("SV_TERMINAL_HOOK_TOKEN", TOKEN)
        monkeypatch.setenv("SECUREVECTOR_MCP_HARNESS", "claude-code")
        monkeypatch.delenv("SECUREVECTOR_APP_URL", raising=False)

    def _route_through_app(self, monkeypatch, world, loop):
        def fake_request(method, path, body):
            assert path.startswith("/api/policy/")
            headers = policy_tools._headers()
            if method == "POST":
                coro = policy_routes.check_policy(_Req(world.manager, body, headers))
            else:
                from urllib.parse import parse_qs, urlsplit

                q = {k: v[0] for k, v in parse_qs(urlsplit(path).query).items()}
                coro = policy_routes.session_burn(_Req(world.manager, None, headers), **q)
            return asyncio.run_coroutine_threadsafe(coro, loop).result(10)

        monkeypatch.setattr(policy_tools, "_request", fake_request)

    @pytest.mark.asyncio
    async def test_check_then_attempt_is_matched(self, world, monkeypatch, mcp_env):
        self._route_through_app(monkeypatch, world, asyncio.get_running_loop())
        out = await asyncio.to_thread(policy_tools.check_policy_call, FIXTURE["tool_name"], FIXTURE["tool_input"])
        assert out["decision"] == "allow" and out["token"]
        verdict = await _evaluate(world, FIXTURE["tool_input"])
        assert verdict["action"] != BLOCK
        task = await world.manager.store.get_task(TASK)
        summary = await policy_check.preflight_summary(world.db, task)
        assert summary["checked"] == 1 and summary["matched"] == 1 and summary["match_rate"] == 1.0
        assert summary["recent"][0]["kind"] == "shell" and summary["recent"][0]["decision"] == "allow"
        burn = await asyncio.to_thread(policy_tools.session_burn_call)
        assert burn["session"] == out["session"]

    @pytest.mark.asyncio
    async def test_denied_check_stops_the_agent(self, world, monkeypatch, mcp_env):
        repo = EgressRepository(world.db)
        pol = await repo.get_active_policy()
        await repo.add_denied_host(pol["id"], "example.com")
        self._route_through_app(monkeypatch, world, asyncio.get_running_loop())
        out = await asyncio.to_thread(policy_tools.check_policy_call, FIXTURE["tool_name"], FIXTURE["tool_input"])
        assert out["decision"] == "deny" and out["token"] is None
        # The agent does not attempt the call: no egress attempt row.
        n = await world.db.fetch_one("SELECT COUNT(*) AS n FROM egress_audit")
        assert n["n"] == 0
        task = await world.manager.store.get_task(TASK)
        summary = await policy_check.preflight_summary(world.db, task)
        assert summary["avoided_denials"] == 1 and summary["attempted_after_deny"] == 0


# --- harness registration ---------------------------------------------------------------------------------


class TestRegistration:
    def test_claude_code_round_trip(self, _isolated_home, mcp_available):
        (_isolated_home / ".claude").mkdir()
        cfg = _isolated_home / ".claude.json"
        cfg.write_text(json.dumps({"numStartups": 3, "mcpServers": {"other": {"command": "x"}}}))
        assert mcp_registration.register("claude-code")
        data = json.loads(cfg.read_text())
        entry = data["mcpServers"]["securevector"]
        assert entry["args"] == ["-m", "securevector.mcp", "--tools", "check_policy,session_burn"]
        assert entry["env"]["SECUREVECTOR_APP_URL"].startswith("http://127.0.0.1:")
        assert data["numStartups"] == 3 and "other" in data["mcpServers"]
        assert mcp_registration.status()["claude-code"]["state"] == "registered"
        assert mcp_registration.unregister("claude-code")
        data = json.loads(cfg.read_text())
        assert "securevector" not in data["mcpServers"] and "other" in data["mcpServers"]

    def test_codex_toml_block(self, _isolated_home, mcp_available):
        tomllib = pytest.importorskip("tomllib")

        (_isolated_home / ".codex").mkdir()
        cfg = _isolated_home / ".codex" / "config.toml"
        cfg.write_text('model = "o3"\n\n[mcp_servers.other]\ncommand = "x"\n')
        assert mcp_registration.register("codex") and mcp_registration.register("codex")
        parsed = tomllib.loads(cfg.read_text())
        assert parsed["mcp_servers"]["securevector"]["args"][-1] == "check_policy,session_burn"
        assert parsed["mcp_servers"]["securevector"]["env"]["SECUREVECTOR_MCP_HARNESS"] == "codex"
        assert parsed["mcp_servers"]["other"]["command"] == "x"
        assert mcp_registration.unregister("codex")
        parsed = tomllib.loads(cfg.read_text())
        assert "securevector" not in parsed["mcp_servers"] and parsed["model"] == "o3"

    def test_other_harnesses_and_untouched_cases(self, _isolated_home, mcp_available):
        for sub in (".cursor", ".copilot", ".config/opencode", ".gemini/antigravity"):
            (_isolated_home / sub).mkdir(parents=True)
        for h in ("cursor", "copilot-cli", "opencode", "antigravity"):
            assert mcp_registration.register(h), h
            assert mcp_registration.is_registered(h), h
        oc = json.loads((_isolated_home / ".config/opencode/opencode.json").read_text())
        assert oc["mcp"]["securevector"]["type"] == "local"
        assert oc["mcp"]["securevector"]["command"][1:] == ["-m", "securevector.mcp", "--tools",
                                                           "check_policy,session_burn"]
        # Not installed: nothing written.
        assert not mcp_registration.register("claude-code")
        assert not (_isolated_home / ".claude.json").exists()
        # A config that does not parse is left alone.
        bad = _isolated_home / ".cursor" / "mcp.json"
        bad.write_text("{oops")
        assert not mcp_registration.register("cursor")
        assert bad.read_text() == "{oops"


class TestRegistrationTrust:
    @pytest.mark.asyncio
    async def test_own_entry_is_not_reported_by_config_trust(self, world, _isolated_home, mcp_available):
        from securevector.app.services import config_trust

        (_isolated_home / ".claude").mkdir()
        (_isolated_home / ".claude.json").write_text(json.dumps({"mcpServers": {}}))
        await config_trust.approve(world.db, "claude-code", None, target="setup")
        before = await config_trust.evaluate(world.db, "claude-code", None, audit=False)
        assert mcp_registration.register("claude-code")
        after = await config_trust.evaluate(world.db, "claude-code", None, audit=False)
        assert after["state"] == before["state"]
        assert not any(s["name"] == "securevector" for s in after["servers"])
        assert not after.get("changes")


class TestInstallerRegistersTools:
    @pytest.mark.asyncio
    async def test_cursor_install_and_uninstall(self, _isolated_home, monkeypatch, mcp_available):
        from securevector.app.server.routes import hooks_cursor

        monkeypatch.setattr(hooks_cursor, "CURSOR_HOME", _isolated_home / ".cursor", raising=False)
        (_isolated_home / ".cursor").mkdir()
        await hooks_cursor.install_plugin()
        assert mcp_registration.is_registered("cursor")
        await hooks_cursor.uninstall_plugin()
        assert not mcp_registration.is_registered("cursor")


def test_builtin_tool_names_match_the_guard_normaliser():
    import re

    src = (Path(__file__).resolve().parents[3] / "src/securevector/plugins/claude-code/lib/normalize.js").read_text()
    block = src[src.index("new Set(["):src.index("]);", src.index("new Set(["))]
    assert set(re.findall(r"'([A-Za-z]+)'", block)) == set(policy_check._BUILTIN_TOOLS)
    assert policy_check.tool_candidates("mcp__srv__do_it") == ["srv:do_it", "do_it"]
    assert policy_check.tool_candidates("Bash") == ["Bash"] and policy_check.tool_candidates("bash") == []


# --- review follow-ups -----------------------------------------------------------------------


@pytest.fixture
def mcp_available(monkeypatch):
    monkeypatch.setattr(mcp_registration, "_available", True)


class TestRegistrationSafety:
    def test_frozen_build_registers_nothing(self, _isolated_home, monkeypatch):
        import sys

        (_isolated_home / ".cursor").mkdir()
        monkeypatch.setattr(sys, "frozen", True, raising=False)
        assert not mcp_registration.register("cursor")
        assert not (_isolated_home / ".cursor" / "mcp.json").exists()
        st = mcp_registration.status(["cursor"])["cursor"]
        assert st["state"] == "unavailable" and "securevector-ai-monitor[mcp]" in st["text"]

    def test_missing_mcp_package_registers_nothing(self, _isolated_home, monkeypatch):
        import importlib.util

        (_isolated_home / ".cursor").mkdir()
        monkeypatch.setattr(mcp_registration, "_available", None)
        monkeypatch.setattr(importlib.util, "find_spec", lambda name, *a: None)
        assert not mcp_registration.available()
        assert not mcp_registration.register("cursor")
        assert mcp_registration.status(["cursor"])["cursor"]["state"] == "unavailable"

    def test_available_install_registers(self, _isolated_home, mcp_available):
        (_isolated_home / ".cursor").mkdir()
        assert mcp_registration.register("cursor")
        entry = json.loads((_isolated_home / ".cursor" / "mcp.json").read_text())["mcpServers"]["securevector"]
        log = entry["env"]["SECUREVECTOR_AUDIT_LOG"]
        assert os.path.isabs(log) and log.startswith(str(_isolated_home / ".securevector"))

    def test_foreign_entry_is_left_unchanged(self, _isolated_home, mcp_available):
        (_isolated_home / ".cursor").mkdir()
        cfg = _isolated_home / ".cursor" / "mcp.json"
        original = '{\n    "mcpServers": {\n        "securevector": {"command": "my-own"}\n    }\n}\n'
        cfg.write_text(original)
        assert not mcp_registration.register("cursor")
        assert not mcp_registration.unregister("cursor")
        assert cfg.read_text() == original
        assert mcp_registration.status(["cursor"])["cursor"]["state"] == "other_entry"

    def test_codex_foreign_block_is_left_unchanged(self, _isolated_home, mcp_available):
        (_isolated_home / ".codex").mkdir()
        cfg = _isolated_home / ".codex" / "config.toml"
        original = '[mcp_servers.securevector]\ncommand = "mine"\n'
        cfg.write_text(original)
        assert not mcp_registration.register("codex") and not mcp_registration.unregister("codex")
        assert cfg.read_text() == original

    def test_backup_once_and_indent_kept(self, _isolated_home, mcp_available):
        (_isolated_home / ".cursor").mkdir()
        cfg = _isolated_home / ".cursor" / "mcp.json"
        original = '{\n    "mcpServers": {\n        "other": {\n            "command": "x"\n        }\n    },\n    "z": "é"\n}\n'
        cfg.write_text(original)
        assert mcp_registration.register("cursor")
        bak = _isolated_home / ".cursor" / ("mcp.json" + mcp_registration.BACKUP_SUFFIX)
        assert bak.read_text() == original
        text = cfg.read_text()
        assert '\n    "mcpServers": {\n        "other"' in text and "é" in text and text.endswith("\n")
        assert mcp_registration.unregister("cursor")
        assert bak.read_text() == original
        assert json.loads(cfg.read_text()) == json.loads(original)


class TestMcpAuditLogPath:
    def test_default_is_absolute_under_home(self, _isolated_home, monkeypatch):
        from securevector.mcp.config.server_config import SecurityConfig

        monkeypatch.delenv("SECUREVECTOR_AUDIT_LOG", raising=False)
        path = SecurityConfig().audit_log_path
        assert os.path.isabs(path) and path.startswith(str(_isolated_home / ".securevector"))
        monkeypatch.setenv("SECUREVECTOR_AUDIT_LOG", "/tmp/x/mcp.log")
        assert SecurityConfig().audit_log_path == "/tmp/x/mcp.log"


class TestRouteGuards:
    @pytest.mark.asyncio
    async def test_content_type_origin_and_host(self, world):
        from fastapi import HTTPException

        body = {"tool_name": "Bash", "tool_input": {"command": "ls"}}
        for headers, code in (({"content-type": "text/plain"}, 415),
                              ({"origin": "https://evil.example"}, 403),
                              ({"host": "evil.example:8741"}, 403)):
            with pytest.raises(HTTPException) as exc:
                await policy_routes.check_policy(_Req(world.manager, body, headers))
            assert exc.value.status_code == code
        ok = await policy_routes.check_policy(_Req(world.manager, body, {"origin": "http://127.0.0.1:8741"}))
        assert ok["decision"] == "allow"
        with pytest.raises(HTTPException):
            await policy_routes.session_burn(_Req(world.manager, None, {"origin": "https://evil.example"}))


class TestAttemptReports:
    async def _report(self, world, tool_name, tool_input):
        hdrs = dict(_verified_headers())
        return await policy_routes.report_attempt(_Req(world.manager, {
            "tool_name": tool_name, "tool_input": tool_input, "decision": "deny",
            "runtime_kind": "claude-code", "session_id": SID}, hdrs))

    @pytest.mark.asyncio
    async def test_file_tool_token_matches_from_hook_report(self, world):
        call = {"file_path": "/w/app/README.md"}
        out = await _check(world, "Read", call)
        assert out["decision"] == "allow"
        assert await self._report(world, "Read", call) == {"ok": True}
        row = await world.db.fetch_one("SELECT consume_result FROM policy_decisions")
        assert row["consume_result"] == "matched"

    @pytest.mark.asyncio
    async def test_tool_permission_deny_attempt_is_recorded(self, world):
        await ToolPermissionsRepository(world.db).upsert_override("Write", "block")
        call = {"file_path": "/w/app/a.txt", "content": "x"}
        assert (await _check(world, "Write", call))["decision"] == "deny"
        await self._report(world, "Write", call)
        row = await world.db.fetch_one("SELECT attempted_after_deny FROM policy_decisions")
        assert row["attempted_after_deny"] == 1

    @pytest.mark.asyncio
    async def test_approval_between_deny_and_attempt_is_not_counted(self, world):
        await ToolPermissionsRepository(world.db).upsert_override("Write", "block")
        call = {"file_path": "/w/app/a.txt", "content": "x"}
        await _check(world, "Write", call, now=1_900_000_000.0)
        await world.db.execute(
            "INSERT INTO jit_access_requests (id, tool_id, runtime_kind, session_id, rule_source, status) "
            "VALUES ('r1', 'Write', 'claude-code', ?, 'local', 'approved')", (SID,))
        await world.db.execute(
            "INSERT INTO jit_access_grants (id, request_id, tool_id, runtime_kind, session_id, duration, granted_at) "
            "VALUES ('g1', 'r1', 'Write', 'claude-code', ?, 'session', '2030-03-17 17:47:00')", (SID,))
        out = await policy_check.consume_for_call(
            world.db, "Write", call, task_id=TASK, verified=True, harness="claude-code",
            harness_session_id=SID, now=1_900_000_100.0)
        assert out["result"] == "approved_after_deny"
        row = await world.db.fetch_one("SELECT attempted_after_deny FROM policy_decisions")
        assert row["attempted_after_deny"] == 0

    @pytest.mark.asyncio
    async def test_bad_report_is_ignored(self, world):
        req = _Req(world.manager, None, _verified_headers())
        req._body = b"[1,2]"
        assert await policy_routes.report_attempt(req) == {"ok": True}


class TestEnforcementContext:
    @pytest.mark.asyncio
    async def test_origin_and_endpoint_reach_the_engine(self, world, monkeypatch, _isolated_home):
        import securevector.core.egress as eg

        seen = {}
        real = eg.evaluate_tool_call

        def spy(name, inp, policy, ctx, mcp_endpoint=None, pack=None):
            seen.update(origin=ctx.origin_git_host, endpoint=mcp_endpoint)
            return real(name, inp, policy, ctx, mcp_endpoint=mcp_endpoint, pack=pack)

        monkeypatch.setattr(eg, "evaluate_tool_call", spy)
        await _check(world, "Bash", {"command": "git push upstream main"}, origin_git_host="GitHub.com")
        assert seen["origin"] == "github.com"
        (_isolated_home / ".claude").mkdir()
        (_isolated_home / ".claude.json").write_text(json.dumps({"mcpServers": {
            "remote": {"type": "http", "url": "https://mcp.denied.example/mcp"},
            "local": {"command": "node", "args": ["srv.js"]}}}))
        repo = EgressRepository(world.db)
        pol = await repo.get_active_policy()
        await repo.add_denied_host(pol["id"], "mcp.denied.example")
        out = await _check(world, "mcp__remote__do_it", {"x": 1})
        assert seen["endpoint"] == "https://mcp.denied.example/mcp" and out["decision"] == "deny"
        out = await _check(world, "mcp__local__do_it", {"x": 1})
        assert seen["endpoint"] is None and out["decision"] == "allow"

    @pytest.mark.asyncio
    async def test_unknown_mcp_server_is_indeterminate(self, world, _isolated_home):
        out = await _check(world, "mcp__nowhere__do_it", {})
        assert out["decision"] == "indeterminate" and out["reason"] == "unavailable" and out["token"] is None

    def test_mcp_client_sends_origin_host(self, tmp_path):
        import subprocess

        subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
        subprocess.run(["git", "-C", str(tmp_path), "remote", "add", "origin", "git@GitHub.com:o/r.git"], check=True)
        policy_tools._origin_cache.clear()
        assert policy_tools.origin_git_host(str(tmp_path)) == "github.com"
        assert policy_tools.origin_git_host(str(tmp_path / "missing")) is None


def test_registration_requires_a_server_that_accepts_tools(monkeypatch):
    from types import SimpleNamespace
    from securevector.app.services import mcp_registration as m

    monkeypatch.setattr(m, "_available", None)
    monkeypatch.setattr(m.subprocess, "run",
                        lambda *a, **k: SimpleNamespace(returncode=0, stdout="usage: --transport"))
    assert m.available() is False
    monkeypatch.setattr(m, "_available", None)
    monkeypatch.setattr(m.subprocess, "run",
                        lambda *a, **k: SimpleNamespace(returncode=0, stdout="usage: --tools TOOLS"))
    assert m.available() is True


def test_source_checkout_registers_its_own_path(monkeypatch):
    from securevector.app.services import mcp_registration as m

    monkeypatch.setattr(m, "_source_root", lambda: m.Path("/checkout/src"))
    assert m._env("claude-code")["PYTHONPATH"] == "/checkout/src"
    monkeypatch.setattr(m, "_source_root", lambda: None)
    assert "PYTHONPATH" not in m._env("claude-code")
