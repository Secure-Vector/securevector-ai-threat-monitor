"""The rule override endpoints answer with the real rule, not a placeholder.

PUT /rules/{id}/override returns the community rule with the override applied;
DELETE /rules/{id}/override returns the community rule as shipped.
"""

from __future__ import annotations

import asyncio

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.rules import RulesRepository

RULE_ID = "sv_community_test_rule"


def _client(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from securevector.app.server.routes import rules as rules_routes

    async def _setup():
        db = DatabaseConnection(tmp_path / "test.db")
        await run_migrations(db)
        await RulesRepository(db).cache_community_rule(
            rule_id=RULE_ID,
            name="Prompt injection probe",
            category="prompt_injection",
            description="Detects a probe",
            severity="high",
            patterns=[r"ignore previous"],
            metadata={"origin": "test"},
        )
        await db.disconnect()

    asyncio.run(_setup())
    db = DatabaseConnection(tmp_path / "test.db")
    app = FastAPI()
    app.include_router(rules_routes.router, prefix="/api/v1")
    monkeypatch.setattr(rules_routes, "get_database", lambda: db)
    return TestClient(app)


def test_set_override_returns_the_effective_rule(tmp_path, monkeypatch):
    with _client(tmp_path, monkeypatch) as client:
        res = client.put(f"/api/v1/rules/{RULE_ID}/override", json={"severity": "low", "enabled": False})
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["id"] == RULE_ID
        assert body["name"] == "Prompt injection probe"
        assert body["category"] == "prompt_injection"
        assert body["description"] == "Detects a probe"
        assert body["severity"] == "low"
        assert body["enabled"] is False
        # Fields the override leaves unset fall through to the rule.
        assert body["patterns"] == [r"ignore previous"]
        assert body["has_override"] is True
        assert body["source"] == "community"
        assert body["metadata"] == {"origin": "test"}

        # Same view the list endpoint gives.
        listed = client.get("/api/v1/rules", params={"source": "community"}).json()["items"]
        row = next(r for r in listed if r["id"] == RULE_ID)
        for key in ("name", "category", "severity", "enabled", "patterns", "has_override", "created_at"):
            assert row[key] == body[key]
        assert body["created_at"]


def test_reset_override_returns_the_original_rule(tmp_path, monkeypatch):
    with _client(tmp_path, monkeypatch) as client:
        client.put(f"/api/v1/rules/{RULE_ID}/override", json={"severity": "low", "patterns": ["other"]})
        res = client.delete(f"/api/v1/rules/{RULE_ID}/override")
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["id"] == RULE_ID
        assert body["name"] == "Prompt injection probe"
        assert body["severity"] == "high"
        assert body["patterns"] == [r"ignore previous"]
        assert body["enabled"] is True
        assert body["has_override"] is False
        assert body["created_at"]


def test_reset_without_an_override_is_404(tmp_path, monkeypatch):
    with _client(tmp_path, monkeypatch) as client:
        resp = client.delete(f"/api/v1/rules/{RULE_ID}/override")
        assert resp.status_code == 404
