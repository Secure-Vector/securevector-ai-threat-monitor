"""
Integration tests for the Skill Scanner API routes.

Tests endpoints:
  POST  /api/skill-scans/scan
  GET   /api/skill-scans/history
  GET   /api/skill-scans/history/{scan_id}
  DELETE /api/skill-scans/history/{scan_id}

NOTE: These tests require a running server.
      Start the application with `securevector-app --web` before executing them.
      They are skipped in CI by default via the module-level pytestmark below.
"""

import pytest

# Skip all tests in this module unless running against a live server.
pytestmark = pytest.mark.skip(
    reason="requires running server — start with securevector-app --web before running"
)


@pytest.mark.asyncio
async def test_scan_invalid_path_returns_400(client):
    resp = await client.post("/api/skill-scans/scan", json={"path": "/nonexistent/skill/path"})
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_history_detail_404_for_unknown_id(client):
    resp = await client.get("/api/skill-scans/history/00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_delete_unknown_id_returns_404(client):
    resp = await client.delete("/api/skill-scans/history/00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 404
