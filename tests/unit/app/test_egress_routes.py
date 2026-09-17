"""Egress HTTP surface for the per-session destinations lookup.

The session id arrives as a path segment and is handed to a query parameter,
so the route pattern-checks it instead of trusting it. The shape of the
response is pinned too: the attached-terminal panel reads `distinct_hosts` and
`blocked_hosts` for its count badge and would show a blank badge if either key
quietly changed name.
"""

import pytest
from fastapi import HTTPException

from securevector.app.server.routes import egress as egress_routes


class _StubRepo:
    def __init__(self, rows):
        self._rows = rows
        self.called_with = None

    async def session_destinations(self, session_id, limit=50):
        self.called_with = (session_id, limit)
        return self._rows


@pytest.fixture
def stub_repo(monkeypatch):
    rows = [
        {"host": "bad.example.com", "calls": 2, "blocked": 2, "writes": 0,
         "hard_blocked": 1, "first_seen": "t0", "last_seen": "t1"},
        {"host": "api.example.com", "calls": 5, "blocked": 0, "writes": 1,
         "hard_blocked": 0, "first_seen": "t0", "last_seen": "t1"},
    ]
    repo = _StubRepo(rows)
    monkeypatch.setattr(egress_routes, "get_database", lambda: object())
    monkeypatch.setattr(egress_routes, "EgressRepository", lambda db: repo)
    return repo


class TestSessionDestinationsRoute:
    @pytest.mark.asyncio
    async def test_happy_path_summarises_the_rows(self, stub_repo):
        out = await egress_routes.get_session_destinations("sess-01.a:b")
        assert out["session_id"] == "sess-01.a:b"
        assert out["distinct_hosts"] == 2
        assert out["blocked_hosts"] == 1
        assert out["destinations"][0]["host"] == "bad.example.com"
        assert stub_repo.called_with == ("sess-01.a:b", 50)

    @pytest.mark.asyncio
    @pytest.mark.parametrize("bad", ["", "a/b", "../etc", "a b", "x" * 129,
                                     "drop'; --"])
    async def test_malformed_session_id_is_rejected(self, bad, stub_repo):
        with pytest.raises(HTTPException) as exc:
            await egress_routes.get_session_destinations(bad)
        assert exc.value.status_code == 400
        assert stub_repo.called_with is None

    @pytest.mark.asyncio
    async def test_no_rows_is_an_empty_list_not_an_error(self, monkeypatch):
        repo = _StubRepo([])
        monkeypatch.setattr(egress_routes, "get_database", lambda: object())
        monkeypatch.setattr(egress_routes, "EgressRepository", lambda db: repo)
        out = await egress_routes.get_session_destinations("s1")
        assert out == {"session_id": "s1", "distinct_hosts": 0,
                       "blocked_hosts": 0, "destinations": []}

    def test_route_is_registered(self):
        paths = {r.path for r in egress_routes.router.routes}
        assert "/egress/sessions/{session_id}/destinations" in paths
