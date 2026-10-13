"""Board spend: a parent's total rolls up its children; spend_usd stays its own."""

import asyncio
from types import SimpleNamespace

from securevector.app.database.repositories import costs as costs_mod
from securevector.app.terminals import routes


class _Repo:
    def __init__(self, db):
        pass

    async def get_run_usage_bulk(self, ids):
        table = {"s-parent": (1.0, 3), "s-a": (0.25, 1), "s-b": (0.5, 2)}
        return {i: {"spend_usd": table[i][0], "requests": table[i][1]} for i in ids if i in table}


def _run(items, monkeypatch):
    monkeypatch.setattr(costs_mod, "CostsRepository", _Repo)
    manager = SimpleNamespace(store=SimpleNamespace(db=None))
    asyncio.run(routes._with_spend(manager, items))
    return items


def test_parent_total_includes_children_and_own_figure_is_unchanged(monkeypatch):
    items = _run([
        {"id": "p", "session_id": "s-parent"},
        {"id": "a", "session_id": "s-a", "parent_task_id": "p"},
        {"id": "b", "session_id": "s-b", "parent_task_id": "p"},
        {"id": "x", "session_id": "s-none"},
    ], monkeypatch)
    by = {i["id"]: i for i in items}
    assert by["p"]["spend_usd"] == 1.0
    assert by["p"]["spend_total_usd"] == 1.75
    assert "spend_total_usd" not in by["a"] and "spend_total_usd" not in by["x"]


def test_no_total_without_children(monkeypatch):
    items = _run([{"id": "p", "session_id": "s-parent"}], monkeypatch)
    assert "spend_total_usd" not in items[0]


def test_total_when_parent_has_no_own_spend(monkeypatch):
    items = _run([
        {"id": "p", "session_id": "s-none"},
        {"id": "a", "session_id": "s-a", "parent_task_id": "p"},
    ], monkeypatch)
    assert items[0]["spend_total_usd"] == 0.25
    assert "spend_usd" not in items[0]
