"""Incremental, shared transcript parsing (services/transcript_cache): only
appended bytes are read, partial last lines wait, a shrunk or replaced file
is parsed again, idle and surplus entries are dropped, and every caller
(generations, token totals, the traces routes) goes through it."""

from __future__ import annotations

import asyncio
import json
import os

import pytest

from securevector.app.server.routes import hooks_claude_code as cc
from securevector.app.server.routes import traces as traces_mod
from securevector.app.server.routes import transcript_generations as tg
from securevector.app.services import transcript_cache as tc


@pytest.fixture(autouse=True)
def _fresh_cache():
    tc.clear()
    before = dict(tc.stats)
    yield before
    tc.clear()


def _line(rec: dict) -> bytes:
    return (json.dumps(rec) + "\n").encode()


def _user(text, ts="2026-10-01T00:00:00Z"):
    return {"type": "user", "timestamp": ts, "message": {"role": "user", "content": text}}


def _tool_result(tid, text="ok", ts="2026-10-01T00:00:02Z"):
    return {"type": "user", "timestamp": ts, "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": tid, "content": text}]}}


def _asst(rid, ts="2026-10-01T00:00:01Z", text="", tool=None, tid=None, out=5, model="claude-x"):
    content = []
    if text:
        content.append({"type": "text", "text": text})
    if tool:
        content.append({"type": "tool_use", "id": tid, "name": tool, "input": {"command": "ls"}})
    return {"type": "assistant", "timestamp": ts, "requestId": rid, "message": {
        "role": "assistant", "model": model, "content": content, "stop_reason": "tool_use" if tool else "end_turn",
        "usage": {"input_tokens": 10, "output_tokens": out,
                  "cache_read_input_tokens": 3, "cache_creation_input_tokens": 1}}}


def _session(n):
    recs = []
    for i in range(n):
        recs.append(_user(f"prompt {i}"))
        recs.append(_asst(f"r{i}", text=f"answer {i}"))
        recs.append(_asst(f"r{i}", tool="Bash", tid=f"t{i}"))
        recs.append(_tool_result(f"t{i}", text=f"out {i}"))
    return recs


def _fresh(path, **kw):
    """The same parse with no cache state: what a full read gives."""
    tc.clear()
    return tg.build_generations("s", path=path, **kw)


def test_append_reads_only_new_bytes_and_matches_a_full_parse(tmp_path):
    p = tmp_path / "s.jsonl"
    recs = _session(6)
    p.write_bytes(b"".join(_line(r) for r in recs[:9]))
    first = tg.build_generations("s", store_text=True, with_analysis=True, path=p)
    assert tc.stats["full"] >= 1
    full_before = tc.stats["full"]
    with p.open("ab") as fh:
        fh.write(b"".join(_line(r) for r in recs[9:]))
    grown = tg.build_generations("s", store_text=True, with_analysis=True, path=p)
    assert tc.stats["full"] == full_before  # no re-read from the start
    assert len(grown) == 6 and len(first) < len(grown)
    assert grown == _fresh(p, store_text=True, with_analysis=True)


def test_every_cut_point_matches_a_full_parse(tmp_path):
    """Including cuts inside one request's streamed records and before its
    tool result arrives: the open round-trip shows as a flush would leave it."""
    p = tmp_path / "s.jsonl"
    # ...and a request whose stream is split by its own tool result (reopened)
    split = [_user("go"), _asst("rs", tool="Read", tid="ta"), _tool_result("ta"),
             _asst("rs", text="after", tool="Grep", tid="tb"), _tool_result("tb", text="")]
    lines = [_line(r) for r in _session(3) + split]
    p.write_bytes(b"")
    for i, ln in enumerate(lines):
        with p.open("ab") as fh:
            fh.write(ln)
        got = tg.build_generations("s", store_text=True, with_analysis=True, path=p)
        # a copy under another name is a fresh entry: a full read of the same bytes
        q = tmp_path / f"fresh{i}.jsonl"
        q.write_bytes(p.read_bytes())
        assert got == tg.build_generations("s", store_text=True, with_analysis=True, path=q)
    # s.jsonl was read from the start once; every later call read only its tail
    assert tc.stats["incremental"] >= len(lines) - 1


def test_partial_last_line_waits_for_its_newline(tmp_path):
    p = tmp_path / "s.jsonl"
    recs = _session(2)
    head = b"".join(_line(r) for r in recs[:4])
    tail = _line(recs[4]) + _line(recs[5])
    p.write_bytes(head + tail[:20])  # half of the next user record
    a = tg.build_generations("s", store_text=False, path=p)
    assert len(a) == 1
    with p.open("ab") as fh:
        fh.write(tail[20:])
    b = tg.build_generations("s", store_text=False, path=p)
    assert len(b) == 2
    assert b == _fresh(p, store_text=False)


def test_whole_last_line_without_newline_is_read(tmp_path):
    p = tmp_path / "s.jsonl"
    recs = _session(1)
    p.write_bytes(b"".join(_line(r) for r in recs[:2]).rstrip(b"\n"))
    assert len(tg.build_generations("s", store_text=False, path=p)) == 1
    with p.open("ab") as fh:
        fh.write(b"\n" + b"".join(_line(r) for r in recs[2:]))
    assert tg.build_generations("s", store_text=False, path=p) == _fresh(p, store_text=False)


def test_truncated_file_is_parsed_again(tmp_path):
    p = tmp_path / "s.jsonl"
    recs = _session(4)
    p.write_bytes(b"".join(_line(r) for r in recs))
    assert len(tg.build_generations("s", store_text=False, path=p)) == 4
    full_before = tc.stats["full"]
    p.write_bytes(b"".join(_line(r) for r in recs[:4]))
    assert len(tg.build_generations("s", store_text=False, path=p)) == 1
    assert tc.stats["full"] == full_before + 1


def test_replaced_file_is_parsed_again(tmp_path):
    p = tmp_path / "s.jsonl"
    p.write_bytes(b"".join(_line(r) for r in _session(2)))
    assert len(tg.build_generations("s", store_text=False, path=p)) == 2
    other = tmp_path / "new.jsonl"
    recs = [_user("x"), _asst("other", model="claude-y")]
    other.write_bytes(b"".join(_line(r) for r in recs) * 1 + b"".join(_line(r) for r in _session(2)))
    os.replace(other, p)
    got = tg.build_generations("s", store_text=False, path=p)
    assert [g["model"] for g in got][0] == "claude-y"
    assert got == _fresh(p, store_text=False)


def test_rewrite_in_place_with_a_new_prefix_is_parsed_again(tmp_path):
    """Same inode, longer file, different bytes before the old offset."""
    p = tmp_path / "s.jsonl"
    p.write_bytes(b"".join(_line(r) for r in _session(2)))
    tg.build_generations("s", store_text=False, path=p)
    recs = [_user("x"), _asst("z0", model="claude-z")] + _session(3)
    with p.open("wb") as fh:  # truncate + write keeps the inode
        fh.write(b"".join(_line(r) for r in recs))
    got = tg.build_generations("s", store_text=False, path=p)
    assert got[0]["model"] == "claude-z"
    assert got == _fresh(p, store_text=False)


def test_unchanged_file_is_a_hit_and_callers_get_copies(tmp_path):
    p = tmp_path / "s.jsonl"
    p.write_bytes(b"".join(_line(r) for r in _session(2)))
    a = tg.build_generations("s", store_text=False, with_analysis=True, path=p)
    a[0]["model"] = "mutated"
    a[0]["tool_results"].append({"x": 1})
    a[0]["tool_calls"][0]["name"] = "mutated"
    hits = tc.stats["hits"]
    b = tg.build_generations("s", store_text=False, with_analysis=True, path=p)
    assert tc.stats["hits"] == hits + 1
    assert b[0]["model"] == "claude-x"
    assert {"x": 1} not in b[0]["tool_results"]
    assert b[0]["tool_calls"][0]["name"] == "Bash"


def test_missing_file_answers_empty(tmp_path):
    assert tg.build_generations("s", store_text=False, path=tmp_path / "none.jsonl") == []
    assert cc._aggregate_session_usage(tmp_path / "none.jsonl") == (0, 0, 0, 0, 0, None, {}, {})


def test_idle_entries_are_dropped(tmp_path, monkeypatch):
    p1, p2 = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    for p in (p1, p2):
        p.write_bytes(b"".join(_line(r) for r in _session(1)))
    now = [1000.0]
    monkeypatch.setattr(tc.time, "monotonic", lambda: now[0])
    tg.build_generations("s", store_text=False, path=p1)
    assert tc.entry_count() == 1
    now[0] += tc.IDLE_S + 1
    tg.build_generations("s", store_text=False, path=p2)
    assert tc.entry_count() == 1  # a.jsonl went idle and was dropped


def test_entry_cap_drops_the_least_recently_used(tmp_path, monkeypatch):
    monkeypatch.setattr(tc, "MAX_ENTRIES", 3)
    paths = []
    for i in range(5):
        p = tmp_path / f"{i}.jsonl"
        p.write_bytes(b"".join(_line(r) for r in _session(1)))
        paths.append(p)
        tg.build_generations("s", store_text=False, path=p)
    assert tc.entry_count() == 3
    full = tc.stats["full"]
    tg.build_generations("s", store_text=False, path=paths[-1])  # still cached
    assert tc.stats["full"] == full
    tg.build_generations("s", store_text=False, path=paths[0])  # was evicted
    assert tc.stats["full"] == full + 1


def test_token_totals_group_has_its_own_cap(tmp_path, monkeypatch):
    """The dashboard's walk over every transcript must not push the live
    sessions' generation parses out."""
    monkeypatch.setattr(tc, "MAX_ENTRIES", 2)
    live = tmp_path / "live.jsonl"
    live.write_bytes(b"".join(_line(r) for r in _session(1)))
    tg.build_generations("s", store_text=False, path=live)
    for i in range(6):
        p = tmp_path / f"u{i}.jsonl"
        p.write_bytes(b"".join(_line(r) for r in _session(1)))
        cc._aggregate_session_usage(p)
    full = tc.stats["full"]
    tg.build_generations("s", store_text=False, path=live)
    assert tc.stats["full"] == full


def test_usage_totals_are_incremental_and_match(tmp_path):
    p = tmp_path / "s.jsonl"
    recs = _session(5)
    p.write_bytes(b"".join(_line(r) for r in recs[:6]))
    first = cc._aggregate_session_usage(p)
    with p.open("ab") as fh:
        fh.write(b"".join(_line(r) for r in recs[6:]))
    full = tc.stats["full"]
    got = cc._aggregate_session_usage(p)
    assert tc.stats["full"] == full
    assert got[0] == 10 and first[0] < got[0]  # two assistant records per turn
    tc.clear()
    assert cc._aggregate_session_usage(p) == got
    got[6]["claude-x"]["turns"] = 999  # a caller's copy
    assert cc._aggregate_session_usage(p)[6]["claude-x"]["turns"] == 10


def test_codex_rollout_is_incremental(tmp_path):
    def tc_rec(out, total):
        return {"type": "event_msg", "timestamp": "2026-10-01T00:00:05Z", "payload": {
            "type": "token_count", "info": {"last_token_usage": {"input_tokens": 9, "output_tokens": out},
                                            "total_token_usage": {"t": total}}}}
    recs = [{"type": "turn_context", "payload": {"model": "gpt-x"}}]
    for i in range(4):
        recs.append({"type": "response_item", "timestamp": "2026-10-01T00:00:01Z",
                     "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": f"q{i}"}]}})
        recs.append({"type": "response_item", "timestamp": "2026-10-01T00:00:02Z",
                     "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": f"a{i}"}]}})
        recs.append(tc_rec(3, i))
    p = tmp_path / "rollout.jsonl"
    p.write_bytes(b"".join(_line(r) for r in recs[:4]))
    assert len(tg.build_generations_codex("s", store_text=True, path=p)) == 1
    full = tc.stats["full"]
    with p.open("ab") as fh:
        fh.write(b"".join(_line(r) for r in recs[4:]))
    got = tg.build_generations_codex("s", store_text=True, path=p)
    assert tc.stats["full"] == full and len(got) == 4
    tc.clear()
    assert tg.build_generations_codex("s", store_text=True, path=p) == got


def test_traces_parse_goes_through_the_shared_cache(tmp_path, monkeypatch):
    """parse_generations (trace detail, Live tokens, health) reads only the
    appended bytes of a live transcript."""
    p = tmp_path / "live.jsonl"
    recs = _session(4)
    p.write_bytes(b"".join(_line(r) for r in recs[:8]))
    monkeypatch.setattr(traces_mod, "_transcript_path", lambda rk, sid: p)
    a = asyncio.run(traces_mod.parse_generations("claude-code", "live", store_text=False))
    assert len(a) == 2
    full = tc.stats["full"]
    with p.open("ab") as fh:
        fh.write(b"".join(_line(r) for r in recs[8:]))
    gens, stamp = traces_mod._parse_with_stamp("claude-code", "live", False, True)
    assert stamp == str(p.stat().st_mtime_ns)
    b = asyncio.run(traces_mod.parse_generations("claude-code", "live", store_text=False))
    assert len(b) == 4 and len(gens) == 4
    # the with_analysis parse is its own entry (one full read), the plain one
    # stayed incremental
    assert tc.stats["full"] == full + 1
    assert tc.stats["incremental"] >= 1
