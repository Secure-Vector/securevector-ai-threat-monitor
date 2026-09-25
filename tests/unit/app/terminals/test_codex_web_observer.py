"""Codex's built-in web tool, read back from the local transcript.

The tool fires no hook, so nothing governs it and nothing would otherwise
appear in Egress for a task that spent its run reading the internet. What is
pinned here is the narrow scope of the read: only the web action, only after
consent, only forward from where the last pass stopped, and never a second row
for an event already recorded.

Fixtures are built from the record *shapes* Codex writes. No real transcript is
copied into this repository.
"""

import json

import pytest

from securevector.app.services import codex_web_observer as obs


def _search(query, legacy=False):
    if legacy:
        return {"timestamp": "t", "type": "response_item",
                "payload": {"type": "web_search_call", "status": "completed",
                            "action": {"type": "search", "query": query}}}
    return {"timestamp": "t", "type": "event_msg",
            "payload": {"type": "item_completed",
                        "item": {"type": "Extension", "kind": "web.search",
                                 "action": {"type": "search", "query": query}}}}


def _open_page(url, legacy=False):
    if legacy:
        return {"timestamp": "t", "type": "response_item",
                "payload": {"type": "web_search_call",
                            "action": {"type": "openPage", "url": url}}}
    return {"timestamp": "t", "type": "event_msg",
            "payload": {"type": "item_completed",
                        "item": {"type": "Extension", "kind": "web.search",
                                 "action": {"type": "openPage", "url": url}}}}


def _write(path, records, mode="a"):
    with open(path, mode, encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps(rec) + "\n")


@pytest.fixture
def codex_home(tmp_path, monkeypatch):
    """A `~/.codex/sessions/YYYY/MM/DD` tree with one rollout file."""
    obs.reset_state()
    root = tmp_path / ".codex" / "sessions" / "2026" / "09" / "17"
    root.mkdir(parents=True)
    monkeypatch.setattr(obs.Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.setattr(obs, "consent_granted", lambda: True)
    yield root / "rollout-2026-09-17T10-00-00-sess-1.jsonl"
    obs.reset_state()


class TestParser:
    def test_reads_a_search_and_a_page_visit(self, codex_home):
        _write(codex_home, [_search("who makes it"), _open_page("https://ex.example.com/a")])
        events, offset = obs.observe("sess-1", 0)
        assert events == [
            {"kind": "search", "query": "who makes it"},
            {"kind": "open", "url": "https://ex.example.com/a", "host": "ex.example.com"},
        ]
        assert offset == codex_home.stat().st_size

    def test_reads_the_older_response_item_shape(self, codex_home):
        _write(codex_home, [_search("q", legacy=True), _open_page("https://a.example.com", legacy=True)])
        events, _ = obs.observe("sess-1", 0)
        assert [e["kind"] for e in events] == ["search", "open"]

    def test_malformed_lines_are_skipped_not_fatal(self, codex_home):
        codex_home.write_text("{not json\n\n[]\n", encoding="utf-8")
        _write(codex_home, [_search("still read")])
        events, _ = obs.observe("sess-1", 0)
        assert events == [{"kind": "search", "query": "still read"}]

    def test_unrelated_records_are_not_read(self, codex_home):
        _write(codex_home, [
            {"type": "response_item", "payload": {"type": "message",
                                                  "content": "a private prompt"}},
            {"type": "event_msg", "payload": {"type": "item_completed",
                                              "item": {"kind": "command_execution",
                                                       "command": "ls"}}},
        ])
        events, _ = obs.observe("sess-1", 0)
        assert events == []

    def test_an_undescribed_web_action_records_nothing(self, codex_home):
        """Codex writes `{"type": "other"}` for activity it does not detail."""
        _write(codex_home, [{"type": "event_msg", "payload": {
            "type": "item_completed",
            "item": {"kind": "web.search", "action": {"type": "other"}}}}])
        assert obs.observe("sess-1", 0)[0] == []

    def test_a_url_with_no_host_is_dropped(self, codex_home):
        _write(codex_home, [_open_page("not-a-url")])
        assert obs.observe("sess-1", 0)[0] == []

    def test_resumes_from_the_offset_and_never_repeats(self, codex_home):
        _write(codex_home, [_search("first")])
        first, offset = obs.observe("sess-1", 0)
        _write(codex_home, [_open_page("https://b.example.com/x")])
        second, next_offset = obs.observe("sess-1", offset)
        assert [e["kind"] for e in first] == ["search"]
        assert [e["kind"] for e in second] == ["open"]
        assert next_offset > offset
        assert obs.observe("sess-1", next_offset)[0] == []

    def test_a_partial_trailing_line_is_left_for_the_next_pass(self, codex_home):
        _write(codex_home, [_search("complete")])
        with open(codex_home, "a", encoding="utf-8") as fh:
            fh.write('{"type": "event_msg", "payload": {"type": "item_comp')
        events, offset = obs.observe("sess-1", 0)
        assert [e["kind"] for e in events] == ["search"]
        assert offset < codex_home.stat().st_size

    def test_the_read_is_bounded_to_whole_lines(self, codex_home, monkeypatch):
        """A rollout file grows without bound; one pass must not."""
        monkeypatch.setattr(obs, "MAX_READ_BYTES", 220)
        _write(codex_home, [_search("first"), _search("second")])
        events, offset = obs.observe("sess-1", 0)
        assert [e["query"] for e in events] == ["first"]
        assert 0 < offset < codex_home.stat().st_size
        assert [e["query"] for e in obs.observe("sess-1", offset)[0]] == ["second"]

    def test_an_oversized_line_never_stalls_the_reader(self, codex_home, monkeypatch):
        """A line longer than one pass would otherwise park the offset forever.

        Skipping it loses that one record. Waiting for it loses every record
        after it, for the life of the session, which is the worse of the two.
        """
        monkeypatch.setattr(obs, "MAX_READ_BYTES", 200)
        _write(codex_home, [_search("q" * 900), _search("after the big one")])
        size = codex_home.stat().st_size
        offset, seen, passes = 0, [], 0
        while offset < size and passes < 20:
            events, offset = obs.observe("sess-1", offset)
            seen.extend(events)
            passes += 1
        assert offset == size, "the reader must reach the end of the file"
        assert [e["query"] for e in seen] == ["after the big one"]

    def test_a_shrunken_file_resumes_at_its_end_not_its_start(self, codex_home):
        """A replaced rollout must never be replayed as today's activity."""
        _write(codex_home, [_search("old one"), _search("old two")])
        _, offset = obs.observe("sess-1", 0)
        codex_home.write_text("", encoding="utf-8")
        _write(codex_home, [_search("a whole new file")])
        size = codex_home.stat().st_size
        assert offset > size
        events, resumed = obs.observe("sess-1", offset)
        assert events == []
        assert resumed == size
        _write(codex_home, [_search("after the replacement")])
        assert [e["query"] for e in obs.observe("sess-1", resumed)[0]] == [
            "after the replacement"]

    def test_a_missing_transcript_is_not_re_walked_every_tick(self, codex_home,
                                                              monkeypatch):
        """A task launched a moment ago has no rollout file yet."""
        walks = []
        real_walk = obs.os.walk
        monkeypatch.setattr(obs.os, "walk",
                            lambda *a, **k: (walks.append(1), real_walk(*a, **k))[1])
        clock = [1000.0]
        monkeypatch.setattr(obs.time, "monotonic", lambda: clock[0])
        assert obs.find_transcript("sess-later") is None
        assert obs.find_transcript("sess-later") is None
        assert len(walks) == 1
        clock[0] += obs.MISS_TTL_SECONDS + 1
        assert obs.find_transcript("sess-later") is None
        assert len(walks) == 2

    def test_a_transcript_that_appears_is_found_after_the_ttl(self, codex_home,
                                                              monkeypatch):
        clock = [1000.0]
        monkeypatch.setattr(obs.time, "monotonic", lambda: clock[0])
        assert obs.find_transcript("sess-2") is None
        later = codex_home.parent / "rollout-2026-09-17T11-00-00-sess-2.jsonl"
        _write(later, [_search("q")], mode="w")
        clock[0] += obs.MISS_TTL_SECONDS + 1
        assert obs.find_transcript("sess-2") == later

    def test_without_consent_nothing_is_read(self, codex_home, monkeypatch):
        _write(codex_home, [_search("q"), _open_page("https://c.example.com")])
        monkeypatch.setattr(obs, "consent_granted", lambda: False)
        assert obs.observe("sess-1", 0) == ([], 0)

    def test_an_unknown_session_has_no_transcript(self, codex_home):
        _write(codex_home, [_search("q")])
        assert obs.find_transcript("sess-nope") is None
        assert obs.observe("sess-nope", 0) == ([], 0)

    @pytest.mark.parametrize("bad", ["", "../etc/passwd", "a/b", "x" * 200])
    def test_a_malformed_session_id_is_never_looked_up(self, codex_home, bad):
        assert obs.find_transcript(bad) is None


class _StubStore:
    def __init__(self, tasks):
        self._tasks = tasks

    async def list_tasks(self, running_only=False, limit=200):
        return self._tasks


class _StubManager:
    def __init__(self, tasks):
        self.store = _StubStore(tasks)


class _StubRepo:
    def __init__(self):
        self.rows = []

    async def record(self, **row):
        self.rows.append(row)


class TestRecordingPass:
    @pytest.mark.asyncio
    async def test_first_pass_marks_the_end_and_backfills_nothing(self, codex_home):
        _write(codex_home, [_search("before the app started")])
        repo = _StubRepo()
        manager = _StubManager([{"executor_id": "codex", "session_id": "sess-1"}])
        assert await obs.observe_once(manager, repo) == 0
        assert repo.rows == []

    @pytest.mark.asyncio
    async def test_each_event_is_recorded_exactly_once(self, codex_home):
        codex_home.write_text("", encoding="utf-8")
        repo = _StubRepo()
        manager = _StubManager([{"executor_id": "codex", "session_id": "sess-1"}])
        await obs.observe_once(manager, repo)
        _write(codex_home, [_search("q"), _open_page("https://d.example.com/p")])
        assert await obs.observe_once(manager, repo) == 2
        assert await obs.observe_once(manager, repo) == 0
        assert [r["host"] for r in repo.rows] == ["web-search", "d.example.com"]

    @pytest.mark.asyncio
    async def test_the_row_is_marked_observed_not_allowed(self, codex_home):
        codex_home.write_text("", encoding="utf-8")
        repo = _StubRepo()
        manager = _StubManager([{"executor_id": "codex", "session_id": "sess-1"}])
        await obs.observe_once(manager, repo)
        _write(codex_home, [_open_page("https://e.example.com/p?x=1")])
        await obs.observe_once(manager, repo)
        row = repo.rows[0]
        assert row["action"] == "observed"
        assert row["rule_id"] is None
        assert row["host"] == "e.example.com"
        assert row["port"] == 443
        assert row["operation"] == "read"
        assert row["kind"] == "web"
        assert row["detector"] == "codex-transcript"
        assert row["tool_name"] == "web_search"
        assert row["runtime_kind"] == "codex"
        assert row["session_id"] == "sess-1"
        assert row["evidence"] == "https://e.example.com/p?x=1"
        assert "not governed" in row["reason"]

    @pytest.mark.asyncio
    async def test_a_linked_codex_session_is_observed_too(self, codex_home):
        """A session started outside the app is exactly as ungoverned."""
        codex_home.write_text("", encoding="utf-8")
        repo = _StubRepo()
        manager = _StubManager([
            {"executor_id": "codex", "session_id": "sess-1", "origin": "linked"},
        ])
        await obs.observe_once(manager, repo)
        _write(codex_home, [_search("q")])
        assert await obs.observe_once(manager, repo) == 1

    @pytest.mark.asyncio
    async def test_other_executors_and_sessionless_tasks_are_skipped(self, codex_home):
        _write(codex_home, [_search("q")])
        repo = _StubRepo()
        manager = _StubManager([
            {"executor_id": "claude-code", "session_id": "sess-1"},
            {"executor_id": "codex", "session_id": None},
        ])
        assert await obs.observe_once(manager, repo) == 0
        assert obs._offsets == {}

    @pytest.mark.asyncio
    async def test_without_consent_no_pass_runs(self, codex_home, monkeypatch):
        monkeypatch.setattr(obs, "consent_granted", lambda: False)
        repo = _StubRepo()
        manager = _StubManager([{"executor_id": "codex", "session_id": "sess-1"}])
        assert await obs.observe_once(manager, repo) == 0
        assert obs._offsets == {}

    @pytest.mark.asyncio
    async def test_withdrawing_consent_drops_the_offsets(self, codex_home,
                                                         monkeypatch):
        """Re-granting consent must not backfill the window it was off for."""
        codex_home.write_text("", encoding="utf-8")
        repo = _StubRepo()
        manager = _StubManager([{"executor_id": "codex", "session_id": "sess-1"}])
        await obs.observe_once(manager, repo)
        assert obs._offsets["sess-1"] == 0

        consent = [False]
        monkeypatch.setattr(obs, "consent_granted", lambda: consent[0])
        assert await obs.observe_once(manager, repo) == 0
        assert obs._offsets == {}
        _write(codex_home, [_search("while consent was off")])

        consent[0] = True
        assert await obs.observe_once(manager, repo) == 0
        assert obs._offsets["sess-1"] == codex_home.stat().st_size
        assert repo.rows == []
        _write(codex_home, [_search("after consent came back")])
        assert await obs.observe_once(manager, repo) == 1
        assert repo.rows[0]["evidence"] == "after consent came back"

    @pytest.mark.asyncio
    async def test_the_row_claims_no_parse_confidence(self, codex_home):
        """Nothing was parsed out of a command line, so nothing is asserted."""
        codex_home.write_text("", encoding="utf-8")
        repo = _StubRepo()
        manager = _StubManager([{"executor_id": "codex", "session_id": "sess-1"}])
        await obs.observe_once(manager, repo)
        _write(codex_home, [_search("q")])
        await obs.observe_once(manager, repo)
        assert repo.rows[0].get("confidence", "LOW") == "LOW"
