"""Run health findings (services/run_health.py) and their API."""

from __future__ import annotations

import json

import pytest

from securevector.app.services import run_health as rh


# ---------------- builders ----------------


def span(name, sid, args=None, action="allow", ti=None):
    return {"span_kind": "tool_call", "function_name": name, "span_id": sid,
            "args_preview": json.dumps(args) if isinstance(args, dict) else args,
            "action": action, "turn_index": ti}


def spans_of(seq):
    """seq: list of (tool, args) -> spans with span ids s0, s1, ..."""
    return [span(t, f"s{i}", a) for i, (t, a) in enumerate(seq)]


def gen(i, **kw):
    g = {"span_kind": "generation", "model": "m", "request_id": f"r{i}",
         "called_at": f"2026-09-24T10:{i // 60:02d}:{i % 60:02d}Z",
         "input_tokens": 1000, "output_tokens": 10, "tool_calls": [], "tool_results": []}
    g.update(kw)
    return g


def kinds(out):
    return [f["kind"] for f in out["findings"]]


# ---------------- loop / same_call ----------------


def test_same_call_threshold_met_and_not_met():
    bash = ("Bash", {"command": "npm test"})
    other = ("Bash", {"command": "ls"})
    hit = rh.analyze_run({"spans": spans_of([bash, other, bash, other, bash])}, [])
    f = [x for x in hit["findings"] if x["kind"] == "same_call"]
    assert len(f) == 1
    assert f[0]["category"] == "loop"
    assert f[0]["title"] == "Looping on Bash, same arguments 3 times"
    assert f[0]["step_refs"] == ["s0", "s2", "s4"]
    assert f[0]["evidence"]["tool"] == "Bash" and f[0]["evidence"]["counts"] == {"calls": 3}
    assert "npm test" in f[0]["nudge"] or "Bash" in f[0]["nudge"]
    assert "npm test" not in f[0]["title"]  # no args text in the title
    miss = rh.analyze_run({"spans": spans_of([bash, other, bash])}, [])
    assert "same_call" not in kinds(miss)


def test_same_call_window_of_20():
    bash = ("Bash", {"command": "make"})
    filler = [("Bash", {"command": f"echo {i}"}) for i in range(20)]
    spread = [bash] + filler[:10] + [bash] + filler[10:] + [bash]
    assert "same_call" not in kinds(rh.analyze_run({"spans": spans_of(spread)}, []))
    close = [bash] + filler[:8] + [bash] + filler[8:16] + [bash]
    assert "same_call" in kinds(rh.analyze_run({"spans": spans_of(close)}, []))


def test_read_only_tools_count_only_back_to_back():
    read = ("Read", {"file_path": "/a.py"})
    grep = ("Grep", {"pattern": "x"})
    spread = [grep, read, grep, read, grep]
    out = rh.analyze_run({"spans": spans_of(spread)}, [])
    assert not [f for f in out["findings"] if f["kind"] == "same_call" and f["evidence"]["tool"] == "Grep"]
    b2b = rh.analyze_run({"spans": spans_of([grep, grep, grep])}, [])
    f = [x for x in b2b["findings"] if x["kind"] == "same_call"]
    assert f and f[0]["title"] == "Running Grep 3 times in a row, same arguments"


def test_empty_args_never_count_as_same_call():
    out = rh.analyze_run({"spans": [span("Bash", f"s{i}", None) for i in range(5)]}, [])
    assert "same_call" not in kinds(out)


def test_boundary_rows_are_not_calls():
    rows = [span("__session_start__", "b0", "x")] * 4
    assert rh.analyze_run({"spans": rows}, [])["findings"] == []


# ---------------- loop / cycle ----------------


def test_cycle_detection():
    a = ("Edit", {"file_path": "/x.py", "old_string": "a", "new_string": "b"})
    b = ("Bash", {"command": "pytest"})
    out = rh.analyze_run({"spans": spans_of([a, b, a, b, a, b])}, [])
    f = [x for x in out["findings"] if x["kind"] == "cycle"]
    assert len(f) == 1
    assert f[0]["title"] == "Repeating the same 2 calls 3 times (Edit, Bash)"
    assert f[0]["step_refs"] == [f"s{i}" for i in range(6)]
    two = rh.analyze_run({"spans": spans_of([a, b, a, b])}, [])
    assert "cycle" not in kinds(two)


def test_cycle_of_three_and_read_only_cycles_skipped():
    a, b, c = ("Bash", {"c": 1}), ("Bash", {"c": 2}), ("Write", {"file_path": "/y"})
    out = rh.analyze_run({"spans": spans_of([a, b, c] * 3)}, [])
    assert any(f["kind"] == "cycle" and f["evidence"]["counts"]["length"] == 3 for f in out["findings"])
    r1, r2 = ("Grep", {"p": 1}), ("Glob", {"p": 2})
    assert "cycle" not in kinds(rh.analyze_run({"spans": spans_of([r1, r2] * 4)}, []))


# ---------------- loop / reread ----------------


def test_reread_and_edit_between_resets():
    read = ("Read", {"file_path": "/src/app/config.py"})
    edit = ("Edit", {"file_path": "/src/app/config.py"})
    out = rh.analyze_run({"spans": spans_of([read, read, ("Bash", {"c": 1}), read])}, [])
    f = [x for x in out["findings"] if x["kind"] == "reread"]
    assert f and f[0]["title"] == "Read config.py 3 times with no edit between"
    reset = rh.analyze_run({"spans": spans_of([read, read, edit, read])}, [])
    assert "reread" not in kinds(reset)


def test_reread_distinguishes_ranges_and_falls_back_to_hash():
    r1 = ("Read", {"file_path": "/big.log", "offset": 0, "limit": 100})
    r2 = ("Read", {"file_path": "/big.log", "offset": 100, "limit": 100})
    r3 = ("Read", {"file_path": "/big.log", "offset": 200, "limit": 100})
    assert "reread" not in kinds(rh.analyze_run({"spans": spans_of([r1, ("Bash", {"a": 1}), r2, ("Bash", {"a": 2}), r3])}, []))
    # No path in the preview: the args identity keys it; unknown args skip.
    raw = [span("Read", f"s{i}", "opaque-args") for i in range(3)]
    raw.insert(1, span("Bash", "x", "y"))
    out = rh.analyze_run({"spans": raw}, [])
    assert any(f["kind"] == "reread" and f["title"].startswith("Read the same file") for f in out["findings"])
    assert "reread" not in kinds(rh.analyze_run({"spans": [span("Read", f"s{i}", None) for i in range(3)]}, []))


# ---------------- loop / retry_loop ----------------


def _tcall(i, name, h, err, kind=None):
    c = {"name": name, "args_hash": h, "id": f"t{i}"}
    if kind:
        c["cmd_kind"] = kind
    return gen(i, tool_calls=[c], tool_results=[{"name": name, "is_error": err, "tool_use_id": f"t{i}"}])


def test_retry_loop_is_run_healths_own_and_supersedes_same_call():
    gens = [_tcall(i, "Bash", "h1", True) for i in range(3)]
    detail = {"spans": spans_of([("Bash", {"command": "npm test"})] * 3)}
    out = rh.analyze_run(detail, gens)
    ks = kinds(out)
    assert "retry_loop" in ks and "same_call" not in ks
    f = next(x for x in out["findings"] if x["kind"] == "retry_loop")
    assert f["title"] == "Retrying Bash after errors, 3 times with the same arguments"
    assert f["nudge"].startswith("You have run Bash 3 times with the same arguments and it keeps failing.")
    assert f["step_refs"] == ["s0", "s1", "s2"]  # pointed at the governed rows
    bare = rh.analyze_run(None, gens)
    assert next(x for x in bare["findings"] if x["kind"] == "retry_loop")["step_refs"] == [0, 1, 2]
    import inspect
    assert "detect_retry_loops" not in inspect.getsource(rh)


def test_retry_needs_each_earlier_attempts_own_error():
    # The middle attempt passed: not a retry of a failure.
    gens = [_tcall(0, "Bash", "h", True), _tcall(1, "Bash", "h", False), _tcall(2, "Bash", "h", True)]
    assert "retry_loop" not in kinds(rh.analyze_run(None, gens))
    # An error on another tool does not make these retries.
    gens = [_tcall(0, "Bash", "h", False), _tcall(1, "Read", "r", True), _tcall(2, "Bash", "h", False),
            _tcall(3, "Bash", "h", False)]
    assert "retry_loop" not in kinds(rh.analyze_run(None, gens))


def test_retry_negative_tdd_cycle():
    gens = [_tcall(0, "Bash", "pytest", True), _tcall(1, "Edit", "e1", False),
            _tcall(2, "Bash", "pytest", True), _tcall(3, "Edit", "e2", False),
            _tcall(4, "Bash", "pytest", False)]
    assert rh.analyze_run(None, gens)["findings"] == []


def test_retry_negative_codex_cargo_with_apply_patch_between():
    gens = [_tcall(0, "exec_command", "cargo", True), _tcall(1, "apply_patch", "p1", False),
            _tcall(2, "exec_command", "cargo", True), _tcall(3, "exec_command", "p2", False, "write"),
            _tcall(4, "exec_command", "cargo", True)]
    assert "retry_loop" not in kinds(rh.analyze_run(None, gens))
    assert "same_call" not in kinds(rh.analyze_run(None, gens))


def test_retry_negative_bash_pytest_with_sed_between():
    gens = [_tcall(0, "Bash", "pytest", True), _tcall(1, "Bash", "sed1", False, "write"),
            _tcall(2, "Bash", "pytest", True), _tcall(3, "Bash", "sed2", False, "write"),
            _tcall(4, "Bash", "pytest", True)]
    out = rh.analyze_run(None, gens)
    assert "retry_loop" not in kinds(out) and "same_call" not in kinds(out)


# ---------------- failing ----------------


def test_error_streak_and_rate():
    ok = {"name": "Bash", "is_error": False}
    bad = {"name": "Bash", "is_error": True}
    streak = [gen(i, tool_results=[r]) for i, r in enumerate([ok, bad, bad, bad, ok])]
    out = rh.analyze_run({}, streak)
    f = next(x for x in out["findings"] if x["kind"] == "error_streak")
    assert f["title"] == "3 tool calls failed in a row (Bash)"
    assert f["category"] == "failing" and f["step_refs"] == [1, 2, 3]
    assert "error_rate" not in kinds(out)  # 5 calls: under the 10-call floor
    rate = [gen(i, tool_results=[bad if i % 2 else ok]) for i in range(10)]
    f2 = next(x for x in rh.analyze_run({}, rate)["findings"] if x["kind"] == "error_rate")
    assert f2["severity"] == "info" and f2["title"] == "50% of tool calls failed (5 of 10)"
    three = [gen(i, tool_results=[bad if i < 3 and i != 1 else ok]) for i in range(10)]
    assert "error_rate" not in kinds(rh.analyze_run({}, three))  # 20%, under 30%


# ---------------- wasteful ----------------


def test_duplicate_turns_with_estimated_tokens():
    gens = [gen(0, input_hash="x", cost=0.2), gen(1, input_hash="x", cost=0.2), gen(2, input_hash="y")]
    out = rh.analyze_run({}, gens)
    f = next(x for x in out["findings"] if x["kind"] == "duplicate_turns")
    assert f["evidence"]["est_tokens"] == 1010 and f["evidence"]["est_usd"] == 0.2
    assert f["title"] == "The same model turn was sent 2 times"


def test_resend_growth_and_tool_result_carry():
    gens = [gen(0, input_tokens=20_000), gen(1, input_tokens=60_000,
                                             tool_results=[{"name": "Read", "is_error": False, "result_chars": 40_000}]),
            gen(2, input_tokens=120_000)]
    out = rh.analyze_run({}, gens)
    ks = kinds(out)
    assert "resend_growth" in ks and "tool_result_carry" in ks
    carry = next(x for x in out["findings"] if x["kind"] == "tool_result_carry")
    assert carry["evidence"]["est_tokens"] == 10_000 and carry["step_refs"] == [1]
    small = [gen(0, input_tokens=20_000), gen(1, input_tokens=90_000)]
    assert rh.analyze_run({}, small)["findings"] == []


def test_runaway_against_runtime_median():
    detail = {"runtime_kind": "claude-code",
              "spans": [span("Bash", f"s{i}", {"c": i}) for i in range(50)]}
    base = {"runs": 10, "median_calls": 20}
    out = rh.analyze_run(detail, [], base)
    f = next(x for x in out["findings"] if x["kind"] == "runaway")
    assert f["title"] == "50 tool calls, over twice the usual 20 for claude-code"
    assert "runaway" not in kinds(rh.analyze_run(detail, [], {"runs": 3, "median_calls": 20}))
    assert "runaway" not in kinds(rh.analyze_run(detail, [], {"runs": 10, "median_calls": 30}))


def test_runaway_pace_cold_start():
    gens = [gen(i, called_at=f"2026-09-24T10:00:{i:02d}Z",
                tool_calls=[{"name": "Bash", "args_hash": "same"}]) for i in range(40)]
    out = rh.analyze_run({}, gens)
    assert any(f["kind"] == "runaway" and f["title"].startswith("Runaway pace") for f in out["findings"])


# ---------------- blocked, refs, shape ----------------


def test_blocked_counts_egress_and_refs():
    detail = {"spans": [span("Bash", "s0", {"c": 1}, action="block"), span("Read", "s1", {"c": 2})],
              "egress_blocked": 2}
    out = rh.analyze_run(detail, [])
    f = next(x for x in out["findings"] if x["kind"] == "blocked")
    assert f["title"] == "3 calls blocked by policy" and f["step_refs"] == ["s0"]
    assert out["counts"] == {"loop": 0, "failing": 0, "wasteful": 0, "blocked": 1}


def test_generation_refs_map_to_detail_spans():
    detail = {"spans": [{"span_kind": "generation", "request_id": "r0", "turn_index": 4},
                        {"span_kind": "generation", "request_id": "r1", "span_id": "g1", "turn_index": 5}]}
    bad = {"name": "Bash", "is_error": True}
    gens = [gen(0, tool_results=[bad, bad]), gen(1, tool_results=[bad])]
    f = next(x for x in rh.analyze_run(detail, gens)["findings"] if x["kind"] == "error_streak")
    assert f["step_refs"] == [4, "g1"]


def test_finding_shape_and_order():
    bad = {"name": "Bash", "is_error": True}
    gens = [gen(i, tool_results=[bad]) for i in range(7)]
    out = rh.analyze_run({"spans": spans_of([("Grep", {"p": 1})] * 3)}, gens)
    for f in out["findings"]:
        assert set(f) >= {"id", "category", "kind", "severity", "title", "why", "action", "step_refs", "evidence", "nudge"}
        assert set(f["evidence"]) == {"counts", "tool", "est_tokens", "est_usd"}
        assert "—" not in f["title"] + f["why"] + f["action"] + (f["nudge"] or "")
    assert out["findings"][0]["severity"] == "high"


def test_args_identity_matches_list_prefix():
    preview = "x" * 2000
    assert rh.args_identity(preview) == rh.args_identity(preview[:rh.IDENTITY_PREFIX_CHARS], 2000)
    assert rh.args_identity("") is None


def test_cache_keyed_by_last_span_time():
    rh.clear_cache()
    rh.remember("t1", "2026-09-24T10:00:00+00:00", {"findings": [1]})
    assert rh.cached("t1", "2026-09-24T10:00:00+00:00") == {"findings": [1]}
    assert rh.cached("t1", "2026-09-24T10:05:00+00:00") is None
    rh.clear_cache()


# ---------------- API ----------------


async def _db(tmp_path):
    from securevector.app.database.connection import DatabaseConnection
    from securevector.app.database.migrations import run_migrations
    db = DatabaseConnection(tmp_path / "test.db")
    await run_migrations(db)
    return db


@pytest.mark.asyncio
async def test_list_health_single_pass_for_200_runs(tmp_path, monkeypatch):
    from securevector.app.database.repositories.custom_tools import CustomToolsRepository
    from securevector.app.server.routes import traces as traces_mod
    rh.clear_cache()
    db = await _db(tmp_path)
    monkeypatch.setattr(traces_mod, "get_database", lambda: db)
    repo = CustomToolsRepository(db)
    for n in range(200):
        for k in range(3 if n % 2 else 2):
            await repo.log_tool_call_audit("Bash", "Bash", "allow", args_preview='{"command":"npm test"}',
                                           runtime_kind="claude-code", session_id=f"s{n}")

    def boom(*a, **k):
        raise AssertionError("transcript read in the list pass")
    monkeypatch.setattr(traces_mod, "build_generations", boom)
    monkeypatch.setattr(traces_mod, "build_generations_codex", boom)
    calls = {"n": 0}
    orig = CustomToolsRepository.get_health_rows

    async def counted(self, *a, **k):
        calls["n"] += 1
        return await orig(self, *a, **k)
    monkeypatch.setattr(CustomToolsRepository, "get_health_rows", counted)

    out = await traces_mod.list_traces(window_days=7, limit=200, health=None)
    assert len(out["runs"]) == 200 and calls["n"] == 1
    by = {r["session_id"]: r for r in out["runs"]}
    assert by["s1"]["health"] == {"loop": 1, "failing": 0, "wasteful": 0}
    assert by["s0"]["health"] == {"loop": 0, "failing": 0, "wasteful": 0}
    assert all(r["health_partial"] is True for r in out["runs"])
    looped = await traces_mod.list_traces(window_days=7, limit=200, health="loop")
    assert len(looped["runs"]) == 100

    across = await traces_mod.list_run_health(window_days=7, limit=200)
    assert across["counts"]["loop"] == 100 and across["partial_runs"] == 200
    assert {"trace_id", "session_id", "runtime_kind", "title", "step_refs"} <= set(across["findings"][0])


@pytest.mark.asyncio
async def test_trace_health_endpoint_and_cache_reuse(tmp_path, monkeypatch):
    from securevector.app.database.repositories.custom_tools import CustomToolsRepository
    from securevector.app.server.routes import traces as traces_mod
    rh.clear_cache()
    db = await _db(tmp_path)
    monkeypatch.setattr(traces_mod, "get_database", lambda: db)
    repo = CustomToolsRepository(db)
    for _ in range(3):
        await repo.log_tool_call_audit("Bash", "Bash", "allow", args_preview='{"command":"make"}',
                                       runtime_kind="claude-code", session_id="sx")
    bad = {"name": "Bash", "is_error": True}
    gens = [gen(i, tool_results=[bad]) for i in range(3)]
    monkeypatch.setattr(traces_mod, "build_generations", lambda *a, **k: [dict(g) for g in gens])
    tid = (await traces_mod.list_traces(window_days=7, limit=50, health=None))["runs"][0]["trace_id"]
    out = await traces_mod.get_trace_health(tid)
    assert out["trace_id"] == tid and out["partial"] is False
    assert out["counts"]["loop"] == 1 and out["counts"]["failing"] == 1
    # The runs list now reuses the full result for this run.
    again = await traces_mod.list_traces(window_days=7, limit=50, health=None)
    run = again["runs"][0]
    assert run["health_partial"] is False and run["health"]["failing"] == 1
    rh.clear_cache()


# ---------------- review fixes: false positives ----------------


def test_same_call_reset_by_edits_between():
    test_cmd = ("Bash", {"command": "pytest"})
    edit = lambda i: ("Edit", {"file_path": "/a.py", "old_string": str(i), "new_string": str(i + 1)})
    seq = [test_cmd, edit(1), test_cmd, edit(2), test_cmd]
    assert rh.analyze_run({"spans": spans_of(seq)}, [])["findings"] == []


def test_read_only_commands_among_edits_are_not_loops():
    gs = ("Bash", {"command": "git status"})
    seq = []
    for i in range(4):
        seq += [gs, ("Edit", {"file_path": f"/f{i}", "old_string": "a", "new_string": "b"}),
                ("Bash", {"command": f"echo {i}"}), ("Write", {"file_path": f"/w{i}", "content": str(i)})]
    assert "same_call" not in kinds(rh.analyze_run({"spans": spans_of(seq)}, []))
    # Even with no edits, a read-only command counts only back to back.
    spread = [gs, ("Bash", {"command": "echo 1"}), gs, ("Bash", {"command": "echo 2"}), gs]
    assert "same_call" not in kinds(rh.analyze_run({"spans": spans_of(spread)}, []))
    assert "same_call" in kinds(rh.analyze_run({"spans": spans_of([gs, gs, gs])}, []))
    assert "git status" not in rh.READ_ONLY_TOOLS
    assert rh.is_read_only_command("rg -n foo src") and rh.is_read_only_command("git log --oneline")
    assert not rh.is_read_only_command("git push") and not rh.is_read_only_command("npm test")


def test_codex_exec_after_file_edits_is_not_a_loop():
    ex = ("exec_command", {"cmd": ["bash", "-lc", "cargo test"]})
    patch = lambda i: ("apply_patch", {"input": f"*** Begin Patch {i}"})
    seq = [ex, patch(1), ex, patch(2), ex]
    assert rh.analyze_run({"spans": spans_of(seq)}, [])["findings"] == []
    assert rh.command_of('{"cmd":["bash","-lc","git status"]}') == "git status"


def test_same_failing_command_with_nothing_changing_still_flags():
    npm = ("Bash", {"command": "npm test"})
    out = rh.analyze_run({"spans": spans_of([npm, npm, ("Bash", {"command": "cat log"}), npm])}, [])
    f = next(x for x in out["findings"] if x["kind"] == "same_call")
    assert f["evidence"]["counts"]["calls"] == 3


def test_guard_denials_and_no_match_are_not_failures():
    deny = {"name": "Bash", "is_error": True, "denied": True}
    bad = {"name": "Bash", "is_error": True}
    nomatch = {"name": "Bash", "is_error": True, "no_match": True}
    gens = [gen(i, tool_results=[deny]) for i in range(4)]
    assert "error_streak" not in kinds(rh.analyze_run({}, gens))
    gens = [gen(i, tool_results=[nomatch]) for i in range(4)]
    assert "error_streak" not in kinds(rh.analyze_run({}, gens))
    # Matched by tool_use_id to a blocked call's request_id.
    gens = [gen(i, tool_results=[dict(bad, tool_use_id=f"tu{i}")]) for i in range(3)]
    detail = {"spans": [span("Bash", f"s{i}", {"c": i}, action="block") for i in range(3)]}
    for i, sp in enumerate(detail["spans"]):
        sp["request_id"] = f"tu{i}"
    assert "error_streak" not in kinds(rh.analyze_run(detail, gens))


def test_transcript_flags_hook_denials():
    from securevector.app.server.routes.transcript_generations import _NO_MATCH_RE, _looks_denied
    assert _looks_denied("PreToolUse:Bash hook error: SecureVector Guard: blocked by policy")
    assert not _looks_denied("PreToolUse:Bash hook error: blocked by policy")  # not the Guard
    assert not _looks_denied("npm ERR! test failed")
    assert _NO_MATCH_RE.match("Exit code 1") and not _NO_MATCH_RE.match("Exit code 1\nTraceback")


def test_gen_refs_consume_shared_timestamps_and_emit_none():
    t = "2026-09-24T10:00:00Z"
    detail = {"spans": [{"span_kind": "generation", "called_at": t, "turn_index": 1},
                        {"span_kind": "generation", "called_at": t, "turn_index": 2}]}
    gens = [{"called_at": t}, {"called_at": t}, {"called_at": t}, {"called_at": "other"}]
    assert rh._gen_refs(detail, gens) == [1, 2, None, None]


def test_stale_cache_is_served_until_recomputed():
    rh.clear_cache()
    rh.remember("t", ("A", "m1", "3"), {"findings": [1]})
    assert rh.cached_any("t", "A")["stale"] is False
    stale = rh.cached_any("t", "B")
    assert stale["stale"] is True and stale["findings"] == [1]
    rh.clear_cache()


def test_warm_up_selection_and_skip():
    from datetime import datetime, timedelta, timezone
    from securevector.app.server.routes.traces import _health_key, _ts_key
    rh.clear_cache()
    now = datetime(2026, 9, 24, 12, 0, tzinfo=timezone.utc)
    ts = lambda m: (now - timedelta(minutes=m)).strftime("%Y-%m-%d %H:%M:%S")
    runs = [{"trace_id": f"t{i}", "ended_at": ts(i * 5)} for i in range(30)]  # 0..145 min ago
    runs.append({"trace_id": "old", "ended_at": ts(200)})
    recent = rh.recent_runs(runs, now, _ts_key)
    assert [r["trace_id"] for r in recent][:2] == ["t0", "t1"] and "old" not in [r["trace_id"] for r in recent]
    assert len(recent) == 25  # 0..120 min
    stamps = {r["trace_id"]: "m" for r in recent}
    todo = rh.select_warm_runs(recent, stamps, _health_key)
    assert len(todo) == rh.WARM_MAX_RUNS and todo[0] == "t0"
    # Unchanged key: skipped. Moved transcript: recomputed.
    rh.remember("t0", (_health_key(ts(0)), "m", "4"), {"findings": []})
    rh.remember("t1", (_health_key(ts(5)), "old-mtime", "4"), {"findings": []})
    todo = rh.select_warm_runs(recent, stamps, _health_key)
    assert "t0" not in todo and todo[0] == "t1"
    rh.clear_cache()


@pytest.mark.asyncio
async def test_warm_health_once_computes_then_skips(tmp_path, monkeypatch):
    from securevector.app.database.repositories.custom_tools import CustomToolsRepository
    from securevector.app.server.routes import traces as traces_mod
    rh.clear_cache()
    db = await _db(tmp_path)
    monkeypatch.setattr(traces_mod, "get_database", lambda: db)
    repo = CustomToolsRepository(db)
    for _ in range(3):
        await repo.log_tool_call_audit("Bash", "Bash", "allow", args_preview='{"command":"make"}',
                                       runtime_kind="claude-code", session_id="w1")
    first = await traces_mod.warm_health_once()
    assert len(first) == 1
    assert await traces_mod.warm_health_once() == []  # idle: nothing moved
    run = (await traces_mod.list_traces(window_days=7, limit=50, health=None))["runs"][0]
    assert run["health_partial"] is False and run["health"]["loop"] == 1
    rh.clear_cache()


@pytest.mark.asyncio
async def test_health_zero_skips_and_filter_applies_before_limit(tmp_path, monkeypatch):
    from securevector.app.database.repositories.custom_tools import CustomToolsRepository
    from securevector.app.server.routes import traces as traces_mod
    rh.clear_cache()
    db = await _db(tmp_path)
    monkeypatch.setattr(traces_mod, "get_database", lambda: db)
    repo = CustomToolsRepository(db)
    await repo.log_tool_call_audit("Bash", "Bash", "allow", args_preview='{"c":1}', runtime_kind="claude-code", session_id="loopy")
    await repo.log_tool_call_audit("Bash", "Bash", "allow", args_preview='{"c":1}', runtime_kind="claude-code", session_id="loopy")
    await repo.log_tool_call_audit("Bash", "Bash", "allow", args_preview='{"c":1}', runtime_kind="claude-code", session_id="loopy")
    for n in range(5):  # five newer clean runs
        await db.execute("UPDATE tool_call_audit SET called_at = datetime('now', '-1 hour') WHERE session_id = 'loopy'")
        await repo.log_tool_call_audit("Read", "Read", "allow", args_preview=f'{{"n":{n}}}', runtime_kind="claude-code", session_id=f"c{n}")
    plain = await traces_mod.list_traces(window_days=7, limit=2, health="0")
    assert all("health" not in r for r in plain["runs"])
    looped = await traces_mod.list_traces(window_days=7, limit=2, health="loop")
    assert [r["session_id"] for r in looped["runs"]] == ["loopy"]
    rh.clear_cache()


@pytest.mark.asyncio
async def test_health_rows_capped_per_trace(tmp_path):
    from securevector.app.database.repositories.custom_tools import CustomToolsRepository
    db = await _db(tmp_path)
    repo = CustomToolsRepository(db)
    for i in range(12):
        await repo.log_tool_call_audit("Bash", "Bash", "allow", args_preview=f'{{"i":{i}}}', runtime_kind="claude-code", session_id="big")
    runs = await repo.get_trace_runs(window_days=7)
    rows = (await repo.get_health_rows([runs[0]["trace_id"]], per_trace=5))[runs[0]["trace_id"]]
    assert [r["args_head"] for r in rows] == [f'{{"i":{i}}}' for i in range(7, 12)]


@pytest.mark.asyncio
async def test_health_parses_the_transcript_once_off_the_loop(tmp_path, monkeypatch):
    import threading
    from securevector.app.database.repositories.custom_tools import CustomToolsRepository
    from securevector.app.server.routes import traces as traces_mod
    rh.clear_cache()
    db = await _db(tmp_path)
    monkeypatch.setattr(traces_mod, "get_database", lambda: db)
    await CustomToolsRepository(db).log_tool_call_audit("Bash", "Bash", "allow", args_preview='{"c":1}',
                                                        runtime_kind="claude-code", session_id="p1")
    calls = []
    main = threading.get_ident()

    def fake(*a, **k):
        calls.append((threading.get_ident() != main, k.get("with_analysis")))
        return [gen(0)]
    monkeypatch.setattr(traces_mod, "build_generations", fake)
    tid = (await traces_mod.list_traces(window_days=7, limit=5, health=None))["runs"][0]["trace_id"]
    await traces_mod.get_trace_health(tid)
    assert calls == [(True, True)]
    rh.clear_cache()


# ---------------- second review: shell edits, deny markers, warmer cost ----------------


def test_shell_edits_reset_same_call():
    cargo = ("exec_command", {"cmd": ["bash", "-lc", "cargo test"]})
    patch = lambda i: ("exec_command", {"cmd": ["bash", "-lc", f"apply_patch <<'EOF'\n*** Begin Patch {i}\nEOF"]})
    assert rh.analyze_run({"spans": spans_of([cargo, patch(1), cargo, patch(2), cargo])}, [])["findings"] == []
    pyt = ("Bash", {"command": "pytest"})
    sed = lambda i: ("Bash", {"command": f"sed -i 's/a{i}/b/' app.py"})
    assert rh.analyze_run({"spans": spans_of([pyt, sed(1), pyt, sed(2), pyt])}, [])["findings"] == []
    assert rh.is_write_command("echo x >> notes.txt") and rh.is_write_command("cat > f.py <<EOF")
    assert not rh.is_write_command("pytest 2>&1 > /dev/null") and not rh.is_write_command("npm test 2>/dev/null")


def test_deny_marker_only_at_the_start():
    from securevector.app.server.routes.transcript_generations import _looks_denied
    assert _looks_denied("SecureVector Guard: blocked by rule r1")
    assert _looks_denied("PreToolUse:Bash hook error: SecureVector Guard: destination not allowed")
    mid = "FAILED tests/test_x.py::test_guard - AssertionError: expected 'SecureVector Guard: x'"
    assert not _looks_denied(mid)
    bad = {"name": "Bash", "is_error": True, "denied": _looks_denied(mid)}
    assert "error_streak" in kinds(rh.analyze_run({}, [gen(i, tool_results=[bad]) for i in range(3)]))


@pytest.mark.asyncio
async def test_runtime_baseline_is_memoised(tmp_path):
    from securevector.app.server.routes import traces as traces_mod
    db = await _db(tmp_path)
    traces_mod._baseline_memo.clear()
    reads = {"n": 0}
    orig = traces_mod._runtime_baseline_read

    async def counted(*a):
        reads["n"] += 1
        return await orig(*a)
    traces_mod._runtime_baseline_read = counted
    try:
        await traces_mod._runtime_baseline(db, "claude-code")
        await traces_mod._runtime_baseline(db, "claude-code")
        assert reads["n"] == 1
    finally:
        traces_mod._runtime_baseline_read = orig
        traces_mod._baseline_memo.clear()
    assert traces_mod._PARSE_CACHE_MAX >= 32


# ---------------- regression: a real failing loop the audit never saw ----------------


def _cc_transcript(path, n_calls=6):
    """Synthetic Claude Code transcript with the live shape: one request
    making 1 Bash call, one request making 5 (split records, same
    requestId), each result its own user record, every one "Exit code 1"."""
    recs = []
    t = [0]

    def ts():
        t[0] += 1
        return f"2026-09-24T10:00:{t[0]:02d}Z"
    usage = {"input_tokens": 100, "output_tokens": 10}
    recs.append({"type": "user", "timestamp": ts(), "message": {"role": "user", "content": "run the check"}})
    plan = [("req_a", 1), ("req_b", n_calls - 1)]
    k = 0
    for rid, n in plan:
        for _ in range(n):
            k += 1
            recs.append({"type": "assistant", "requestId": rid, "timestamp": ts(), "message": {
                "role": "assistant", "model": "claude-x", "usage": usage, "stop_reason": "tool_use",
                "content": [{"type": "tool_use", "id": f"toolu_{k}", "name": "Bash",
                             "input": {"command": "python3 check.py", "description": f"Run check.py (run {k})"}}]}})
            recs.append({"type": "user", "timestamp": ts(), "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": f"toolu_{k}", "is_error": True, "content": "Exit code 1"}]}})
    recs.append({"type": "assistant", "requestId": "req_c", "timestamp": ts(), "message": {
        "role": "assistant", "model": "claude-x", "usage": usage, "stop_reason": "end_turn",
        "content": [{"type": "text", "text": "It keeps failing."}]}})
    path.write_text("\n".join(json.dumps(r) for r in recs) + "\n")


def test_regression_boundary_only_audit_with_six_failing_bash_calls(tmp_path):
    from securevector.app.server.routes.transcript_generations import build_generations
    p = tmp_path / "s.jsonl"
    _cc_transcript(p)
    gens = build_generations("s", store_text=False, with_analysis=True, path=p)
    assert [len(g["tool_results"]) for g in gens] == [1, 5, 0], "every result is kept, not only the last"
    assert all(r["is_error"] and not r["no_match"] for g in gens for r in g["tool_results"])
    # The trace detail as the app serves it: one boundary row plus the turns.
    spans = [{"span_kind": "tool_call", "function_name": "__session_start__", "tool_id": "__session_start__",
              "action": "log_only", "span_id": "boot", "turn_index": 0}]
    for i, g in enumerate(gens):
        spans.append(dict(g, turn_index=i + 1))
    out = rh.analyze_run({"runtime_kind": "claude-code", "spans": spans}, gens)
    ks = kinds(out)
    assert "retry_loop" in ks or "same_call" in ks
    loop = next(f for f in out["findings"] if f["kind"] in ("retry_loop", "same_call"))
    assert loop["evidence"]["counts"]["calls"] == 6 and loop["step_refs"] == [1, 2]
    streak = next(f for f in out["findings"] if f["kind"] == "error_streak")
    assert streak["evidence"]["counts"]["streak"] == 6 and streak["step_refs"] == [1, 2]
    assert out["counts"]["loop"] >= 1 and out["counts"]["failing"] >= 1


def test_grep_exit_1_is_no_match_but_a_script_exit_1_is_an_error(tmp_path):
    from securevector.app.server.routes.transcript_generations import build_generations
    recs = [{"type": "user", "timestamp": "2026-09-24T10:00:00Z", "message": {"role": "user", "content": "go"}}]
    for k, cmd in enumerate(["rg -n missing src", "python3 check.py"]):
        recs.append({"type": "assistant", "requestId": f"r{k}", "timestamp": f"2026-09-24T10:00:0{2 * k + 1}Z", "message": {
            "role": "assistant", "model": "m", "usage": {"input_tokens": 1, "output_tokens": 1},
            "content": [{"type": "tool_use", "id": f"t{k}", "name": "Bash", "input": {"command": cmd}}]}})
        recs.append({"type": "user", "timestamp": f"2026-09-24T10:00:0{2 * k + 2}Z", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": f"t{k}", "is_error": True, "content": "Exit code 1"}]}})
    p = tmp_path / "g.jsonl"
    p.write_text("\n".join(json.dumps(r) for r in recs) + "\n")
    gens = build_generations("g", store_text=False, with_analysis=True, path=p)
    flags = [r["no_match"] for g in gens for r in g["tool_results"]]
    assert flags == [True, False]
    assert gens[0]["tool_calls"][0]["cmd_kind"] == "read"


def test_audit_tool_error_rows_feed_failing_without_a_transcript():
    rows = [span("Bash", f"s{i}", {"command": f"make t{i}"}) for i in range(4)]
    for r in rows:
        r["reason"] = "tool error"
    out = rh.analyze_run({"spans": rows}, [])
    f = next(x for x in out["findings"] if x["kind"] == "error_streak")
    assert f["step_refs"] == ["s0", "s1", "s2", "s3"]


def test_merged_sequence_points_refs_at_audit_rows():
    gens = [gen(0, tool_calls=[{"name": "Bash", "args_hash": "h", "id": f"t{i}"} for i in range(3)],
                tool_results=[{"name": "Bash", "is_error": False, "tool_use_id": f"t{i}"} for i in range(3)])]
    detail = {"spans": [{"span_kind": "generation", "request_id": "r0", "turn_index": 0}]
              + [span("Bash", f"a{i}", {"command": "make"}, ti=i + 1) for i in range(3)]}
    out = rh.analyze_run(detail, gens)
    f = next(x for x in out["findings"] if x["kind"] == "same_call")
    assert f["step_refs"] == ["a0", "a1", "a2"]
    assert out["sources"]["calls"] == "transcript+audit"


def test_shell_identity_ignores_the_description():
    seq = [("Bash", {"command": "python3 check.py", "description": f"Run check (run {i})"}) for i in range(3)]
    f = next(x for x in rh.analyze_run({"spans": spans_of(seq)}, [])["findings"] if x["kind"] == "same_call")
    assert f["evidence"]["counts"]["calls"] == 3
    from securevector.app.server.routes.transcript_generations import _args_hash
    assert _args_hash({"command": "x", "description": "a"}, "Bash") == _args_hash({"command": "x", "description": "b"}, "Bash")



def test_description_is_dropped_for_shell_tools_only():
    from securevector.app.server.routes.transcript_generations import _args_hash
    assert _args_hash({"command": "x", "description": "a"}, "Bash") == _args_hash({"command": "x", "description": "b"}, "Bash")
    assert _args_hash({"q": "x", "description": "a"}, "mcp__srv__search") != _args_hash({"q": "x", "description": "b"}, "mcp__srv__search")


def test_tool_results_deduped_by_tool_use_id(tmp_path):
    from securevector.app.server.routes.transcript_generations import build_generations
    res = {"type": "user", "timestamp": "2026-09-24T10:00:02Z", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "t1", "is_error": True, "content": "boom"}]}}
    recs = [{"type": "user", "timestamp": "2026-09-24T10:00:00Z", "message": {"role": "user", "content": "go"}},
            {"type": "assistant", "requestId": "r1", "timestamp": "2026-09-24T10:00:01Z", "message": {
                "role": "assistant", "model": "m", "usage": {"input_tokens": 1, "output_tokens": 1},
                "content": [{"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "x"}}]}},
            res, res]
    p = tmp_path / "d.jsonl"
    p.write_text("\n".join(json.dumps(r) for r in recs) + "\n")
    gens = build_generations("d", store_text=False, with_analysis=True, path=p)
    assert len(gens[0]["tool_results"]) == 1


@pytest.mark.asyncio
async def test_warmer_first_pass_is_soon_after_startup(monkeypatch):
    import asyncio as _a
    from securevector.app.server.routes import traces as traces_mod
    sleeps, passes = [], []
    real_sleep = _a.sleep

    async def fake_sleep(d):
        sleeps.append(d)
        if len(sleeps) > 2:
            raise _a.CancelledError()
        await real_sleep(0)

    async def fake_pass():
        passes.append(1)
        return []
    monkeypatch.setattr(traces_mod.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(traces_mod, "warm_health_once", fake_pass)
    with pytest.raises(_a.CancelledError):
        await traces_mod.run_health_warmer()
    assert sleeps[:2] == [rh.WARM_FIRST_DELAY_SECONDS, rh.WARM_INTERVAL_SECONDS] and rh.WARM_FIRST_DELAY_SECONDS == 5
    assert len(passes) == 2


@pytest.mark.asyncio
async def test_run_health_warm_param_runs_one_pass_first(tmp_path, monkeypatch):
    from securevector.app.database.repositories.custom_tools import CustomToolsRepository
    from securevector.app.server.routes import traces as traces_mod
    rh.clear_cache()
    db = await _db(tmp_path)
    monkeypatch.setattr(traces_mod, "get_database", lambda: db)
    for _ in range(3):
        await CustomToolsRepository(db).log_tool_call_audit("Bash", "Bash", "allow", args_preview='{"command":"make"}',
                                                            runtime_kind="claude-code", session_id="w9")
    cold = await traces_mod.list_run_health(window_days=7, limit=50, warm=False)
    assert cold["partial_runs"] == 1
    hot = await traces_mod.list_run_health(window_days=7, limit=50, warm=True)
    assert hot["partial_runs"] == 0
    rh.clear_cache()
