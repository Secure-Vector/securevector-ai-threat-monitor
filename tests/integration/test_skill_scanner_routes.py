"""
Integration tests for the Skill Scanner API routes.

Tests all four endpoints:
  POST  /api/skill-scans/scan
  GET   /api/skill-scans/history
  GET   /api/skill-scans/history/{scan_id}
  DELETE /api/skill-scans/history/{scan_id}

NOTE: These tests require a running server.
      Start the application with `securevector-app --web` before executing them.
      They are skipped in CI by default via the module-level pytestmark below.
"""

import pytest
from pathlib import Path

# Skip all tests in this module unless running against a live server.
pytestmark = pytest.mark.skip(
    reason="requires running server — start with securevector-app --web before running"
)

FIXTURES = Path(__file__).parent.parent / "fixtures" / "skills"


@pytest.mark.asyncio
async def test_scan_malicious_skill_returns_high_risk(client):
    path = str(FIXTURES / "malicious-skill")
    resp = await client.post("/api/skill-scans/scan", json={"path": path})
    assert resp.status_code == 200
    data = resp.json()
    assert data["risk_level"] == "HIGH"
    assert data["findings_count"] > 0
    assert "findings" in data
    assert data["id"]


@pytest.mark.asyncio
async def test_scan_invalid_path_returns_400(client):
    resp = await client.post("/api/skill-scans/scan", json={"path": "/nonexistent/skill/path"})
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_scan_clean_skill_returns_low_or_medium(client):
    path = str(FIXTURES / "manifest-skill")
    resp = await client.post("/api/skill-scans/scan", json={"path": path})
    assert resp.status_code == 200
    data = resp.json()
    assert data["risk_level"] in ("LOW", "MEDIUM")


@pytest.mark.asyncio
async def test_history_returns_paginated_list(client):
    # Create a scan first
    path = str(FIXTURES / "malicious-skill")
    await client.post("/api/skill-scans/scan", json={"path": path})

    resp = await client.get("/api/skill-scans/history", params={"limit": 10, "offset": 0})
    assert resp.status_code == 200
    data = resp.json()
    assert "records" in data
    assert "total" in data
    assert data["total"] >= 1
    assert isinstance(data["records"], list)


@pytest.mark.asyncio
async def test_history_detail_returns_full_findings(client):
    path = str(FIXTURES / "malicious-skill")
    scan_resp = await client.post("/api/skill-scans/scan", json={"path": path})
    scan_id = scan_resp.json()["id"]

    resp = await client.get(f"/api/skill-scans/history/{scan_id}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["id"] == scan_id
    assert "findings" in data
    assert isinstance(data["findings"], list)


@pytest.mark.asyncio
async def test_history_detail_404_for_unknown_id(client):
    resp = await client.get("/api/skill-scans/history/00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_scan_returns_204(client):
    path = str(FIXTURES / "malicious-skill")
    scan_resp = await client.post("/api/skill-scans/scan", json={"path": path})
    scan_id = scan_resp.json()["id"]

    resp = await client.delete(f"/api/skill-scans/history/{scan_id}")
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_delete_scan_then_404_on_refetch(client):
    path = str(FIXTURES / "malicious-skill")
    scan_resp = await client.post("/api/skill-scans/scan", json={"path": path})
    scan_id = scan_resp.json()["id"]

    await client.delete(f"/api/skill-scans/history/{scan_id}")
    resp = await client.get(f"/api/skill-scans/history/{scan_id}")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_unknown_id_returns_404(client):
    resp = await client.delete("/api/skill-scans/history/00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 404
