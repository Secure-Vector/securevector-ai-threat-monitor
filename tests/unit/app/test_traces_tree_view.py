"""Trace tree view (GET /api/traces/{id}?view=tree) and the single-span route:
paging, run totals, the payload bound and the full view kept as it was."""

from __future__ import annotations

import json

import pytest
from fastapi import HTTPException

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.costs import CostsRepository
from securevector.app.database.repositories.custom_tools import CustomToolsRepository
from securevector.app.server.routes import traces as traces_mod
from securevector.app.utils.trace_id import derive_trace_id

SID = "tree-session-1"
RT = "openclaw"  # no transcript lookup: spans come from the DB only
BIG = "x" * 6000


@pytest.fixture
def world(tmp_path, monkeypatch):
    holder = {}
    monkeypatch.setattr(traces_mod, "get_database", lambda: holder["db"])
    traces_mod._trace_memo.clear()

    async def make():
        db = DatabaseConnection(tmp_path / "t.db")
        await run_migrations(db)
        holder["db"] = db
        return db

    yield make
    traces_mod._trace_memo.clear()


async def _seed(db, n, gens=0):
    repo = CustomToolsRepository(db)
    for i in range(n):
        action = "block" if i % 10 == 0 else ("log_only" if i % 7 == 0 else "allow")
        await repo.log_tool_call_audit(
            "Bash", "Bash", action, risk="read",
            reason="tool error: exit 1" if i % 13 == 0 else "ok",
            args_preview='{"command": "echo %d %s"}' % (i, BIG),
            runtime_kind=RT, session_id=SID, span_id=f"sp{i:04d}",
        )
    tid = derive_trace_id(RT, SID)
    costs = CostsRepository(db)
    for j in range(gens):
        await costs.record_generation(
            trace_id=tid, span_id=f"g{j:03d}", session_id=SID, runtime_kind=RT,
            provider="anthropic", model_id="m", input_tokens=10, output_tokens=5,
            started_at="2000-01-01T00:00:%02d+00:00" % j, request_id=f"r{j}",
            input_preview="u" * 4000, output_preview="o" * 4000,
        )
    return tid


async def _tree(tid, **kw):
    kw.setdefault("limit", 200)
    return await traces_mod.get_trace(tid, view="tree", before=kw.pop("before", None),
                                      after=kw.pop("after", None), **kw)


@pytest.mark.asyncio
async def test_default_view_is_the_full_response(world):
    world = await world()
    tid = await _seed(world, 5)
    full = await traces_mod.get_trace(tid, view="full", limit=200, before=None, after=None)
    assert len(full["spans"]) == 5
    assert all(len(s["args_preview"]) > 6000 for s in full["spans"])
    assert "page" not in full and "totals" not in full


@pytest.mark.asyncio
async def test_first_page_is_newest_and_carries_run_totals(world):
    world = await world()
    tid = await _seed(world, 450, gens=3)
    page = await _tree(tid)
    p = page["page"]
    assert p["first"] is True and p["order"] == "asc"
    assert p["returned"] == 200 and p["has_more"] is True
    # Newest 200 of the run, oldest first within the page.
    keys = [s["sk"] for s in page["spans"]]
    assert keys[-1] == page["spans"][-1]["sk"] and p["newest"].endswith("|" + keys[-1])
    assert [int(k[2:]) for k in keys] == sorted(int(k[2:]) for k in keys)
    t = page["totals"]
    assert t["spans"] == 453 and t["tool_call"] == 450 and t["generation"] == 3
    assert t["block"] == 45 and t["allow"] + t["block"] + t["log_only"] == 450
    assert t["failed"] == 35
    assert page["span_count"] == 453 and page["blocked"] == 45


@pytest.mark.asyncio
async def test_before_pages_walk_the_whole_run_once(world):
    world = await world()
    tid = await _seed(world, 450, gens=3)
    seen, before = [], None
    for _ in range(10):
        page = await _tree(tid, before=before)
        seen = [s["sk"] for s in page["spans"]] + seen
        before = page["page"]["next_before"]
        if not page["page"]["has_more"]:
            break
    assert before is None
    assert len(seen) == 453 and len(set(seen)) == 453
    # Turn numbers count across the run, not per page.
    gens = [s for s in (await _tree(tid, limit=1000))["spans"] if s["span_kind"] == "generation"]
    assert [g["gen_no"] for g in gens] == [1, 2, 3]


@pytest.mark.asyncio
async def test_after_returns_only_newer_spans_or_a_gap(world):
    world = await world()
    tid = await _seed(world, 30)
    first = await _tree(tid, limit=10)
    cursor = first["page"]["newest"]
    # The cursor span comes again (a growing turn is replaced), nothing else.
    none_new = await _tree(tid, limit=10, after=cursor)
    assert [s["sk"] for s in none_new["spans"]] == [first["spans"][-1]["sk"]]
    assert none_new["page"]["gap"] is False
    await _seed(world, 3)  # three more calls in the same run
    newer = await _tree(tid, limit=10, after=cursor)
    assert len(newer["spans"]) == 4 and newer["page"]["newest"] != cursor
    await _seed(world, 12)
    gap = await _tree(tid, limit=10, after=newer["page"]["newest"])
    assert gap["page"]["gap"] is True and gap["spans"] == []


@pytest.mark.asyncio
async def test_page_size_is_bounded_and_text_is_cut(world):
    world = await world()
    tid = await _seed(world, 250, gens=5)
    full = await traces_mod.get_trace(tid, view="full", limit=200, before=None, after=None)
    page = await _tree(tid)
    size = len(json.dumps(page))
    assert size < 200 * 2000, size  # about 1 KB a span, whatever the args
    assert size * 4 < len(json.dumps(full))  # blocked calls keep full args
    for s in page["spans"]:
        assert s["_slim"] is True
        if s.get("action") == "block":
            assert len(s["args_preview"]) > 6000  # approvals match on full args
        else:
            assert len(s.get("args_preview") or "") <= traces_mod._TREE_TEXT_CAP
            assert s["_cut"] is True


@pytest.mark.asyncio
async def test_single_span_route_returns_full_detail(world):
    world = await world()
    tid = await _seed(world, 20, gens=2)
    page = await _tree(tid)
    tool = next(s for s in page["spans"] if s["span_kind"] == "tool_call" and s["action"] == "allow")
    got = await traces_mod.get_trace_span(tid, tool["sk"])
    assert got["sk"] == tool["sk"] and len(got["span"]["args_preview"]) > 6000
    by_id = await traces_mod.get_trace_span(tid, tool["span_id"])
    assert by_id["sk"] == tool["sk"]
    gen = next(s for s in page["spans"] if s["span_kind"] == "generation")
    g = await traces_mod.get_trace_span(tid, gen["sk"])
    assert len(g["span"]["input_preview"]) == 4000
    with pytest.raises(HTTPException) as e:
        await traces_mod.get_trace_span(tid, "t:999999")
    assert e.value.status_code == 404


@pytest.mark.asyncio
async def test_memo_rebuilds_when_the_run_grows(world, monkeypatch):
    world = await world()
    tid = await _seed(world, 5)
    calls = {"n": 0}
    real = traces_mod._build_trace

    async def counted(*a, **k):
        calls["n"] += 1
        return await real(*a, **k)

    monkeypatch.setattr(traces_mod, "_build_trace", counted)
    await _tree(tid)
    await _tree(tid)
    await traces_mod.get_trace_span(tid, "t:1")
    assert calls["n"] == 1
    await _seed(world, 1)
    page = await _tree(tid)
    assert calls["n"] == 2 and page["totals"]["tool_call"] == 6


# ---------------- decision= filter (run badges) ----------------


@pytest.mark.asyncio
async def test_decision_block_covers_the_whole_run_with_turns_and_paging(world):
    world = await world()
    tid = await _seed(world, 450, gens=3)
    page = await _tree(tid, decision="block", limit=20)
    p = page["page"]
    assert p["decision"] == "block" and p["matches"] == 45
    tools = [s for s in page["spans"] if s["span_kind"] == "tool_call"]
    assert tools and all(s["action"] == "block" for s in tools)
    seen, before = [s["sk"] for s in page["spans"]], p["next_before"]
    while before:
        older = await _tree(tid, decision="block", limit=20, before=before)
        seen = [s["sk"] for s in older["spans"]] + seen
        before = older["page"]["next_before"]
    blocked = [k for k in seen if k.startswith("t:")]
    assert len(blocked) == 45 and len(set(seen)) == len(seen)
    # Totals stay the run's.
    assert page["totals"]["tool_call"] == 450
    logged = await _tree(tid, decision="log_only", limit=1000)
    assert {s["action"] for s in logged["spans"] if s["span_kind"] == "tool_call"} == {"log_only"}


def test_decision_keeps_the_parent_turn_of_each_match():
    spans = [
        {"span_kind": "generation", "span_id": "g1", "called_at": "2026-01-01T00:00:00+00:00"},
        {"span_kind": "tool_call", "audit_seq": 1, "action": "allow", "called_at": "2026-01-01T00:00:01+00:00"},
        {"span_kind": "generation", "span_id": "g2", "called_at": "2026-01-01T00:00:02+00:00"},
        {"span_kind": "tool_call", "audit_seq": 2, "action": "block", "called_at": "2026-01-01T00:00:03+00:00"},
    ]
    page = traces_mod._tree_page({"spans": spans}, limit=10, decision="block")
    assert [s["sk"] for s in page["spans"]] == ["g:g2", "t:2"]
    assert page["spans"][0]["gen_no"] == 2


def test_failed_pairs_transcript_results_like_the_client():
    spans = [
        {"span_kind": "generation", "span_id": "g1", "tool_results": [
            {"name": "Bash", "is_error": False}, {"name": "Bash", "is_error": True},
            {"name": "mcp__gh__issue", "is_error": True, "denied": True}]},
        {"span_kind": "tool_call", "audit_seq": 1, "tool_id": "Bash", "function_name": "Bash"},
        {"span_kind": "tool_call", "audit_seq": 2, "tool_id": "Bash", "function_name": "Bash"},
        {"span_kind": "tool_call", "audit_seq": 3, "tool_id": "gh:issue", "function_name": "issue"},
        {"span_kind": "tool_call", "audit_seq": 4, "tool_id": "Read", "reason": "tool error: missing"},
    ]
    assert traces_mod._failed_indices(spans) == {2, 4}
    page = traces_mod._tree_page({"spans": spans}, limit=10, decision="error")
    assert [s["sk"] for s in page["spans"]] == ["g:g1", "t:2", "t:4"]
    assert page["totals"]["failed"] == 2 and all(s["error"] for s in page["spans"][1:])


@pytest.mark.asyncio
async def test_decision_waiting_matches_pending_requests(world):
    world = await world()
    tid = await _seed(world, 25)
    full = await traces_mod.get_trace(tid, view="full", limit=200, before=None, after=None)
    blocks = [s for s in full["spans"] if s["action"] == "block"]
    await world.execute(
        "INSERT INTO jit_access_requests (id, tool_id, function_name, session_id, trace_id, rule_source, requested_at, status) "
        "VALUES ('r1', 'Bash', 'Bash', ?, ?, 'local', ?, 'pending')",
        (SID, tid, blocks[-1]["called_at"]),
    )
    page = await _tree(tid, decision="waiting")
    tools = [s for s in page["spans"] if s["span_kind"] == "tool_call"]
    assert len(tools) == 1 and tools[0]["action"] == "block" and page["page"]["matches"] == 1


@pytest.mark.asyncio
async def test_span_hash_lookup(world):
    world = await world()
    tid = await _seed(world, 6)
    full = await traces_mod.get_trace(tid, view="full", limit=200, before=None, after=None)
    s = full["spans"][3]
    got = await traces_mod.lookup_span(s["row_hash"][:12].upper())
    assert got["trace_id"] == tid and got["sk"] == f"t:{s['audit_seq']}"
    with pytest.raises(HTTPException):
        await traces_mod.lookup_span("ffffffffffffffff")


@pytest.mark.asyncio
async def test_totals_carry_the_runs_tokens_and_cost(world):
    world = await world()
    tid = await _seed(world, 3, gens=4)
    page = await _tree(tid, limit=1)
    assert page["totals"]["tokens"] == 4 * 15
