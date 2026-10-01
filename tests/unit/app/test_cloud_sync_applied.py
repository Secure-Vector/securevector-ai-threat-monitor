"""/policy/applied: no null org_id, and no hot loop on a 4xx."""

import asyncio
import logging

import pytest

from securevector.app.services import cloud_sync
from securevector.app.services.credentials import EnrolledCredentials


class _Resp:
    def __init__(self, status: int, text: str = ""):
        self.status_code = status
        self.text = text


class _Client:
    responses: list = []
    posts: list = []

    def __init__(self, *a, **kw):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, json=None, headers=None):
        _Client.posts.append(json)
        r = _Client.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r


def _creds(org_id=None) -> EnrolledCredentials:
    return EnrolledCredentials(
        device_record_id="r", device_id="d", org_id=org_id, org_name="",
        user_id="u", user_email="e@example.com", supabase_jwt="jwt",
    )


@pytest.fixture(autouse=True)
def _wired(monkeypatch):
    _Client.responses = []
    _Client.posts = []
    monkeypatch.setattr(cloud_sync.httpx, "AsyncClient", _Client)
    monkeypatch.setattr(cloud_sync, "get_lse_url", lambda: "https://engine.invalid")
    monkeypatch.setattr(cloud_sync, "get_device_id", lambda: "dev")
    monkeypatch.setattr(cloud_sync, "_build_sync_auth_headers", lambda c: {})
    monkeypatch.setattr(cloud_sync, "_APPLIED_ACK", {"ok": True, "delay": 0.0, "until": 0.0})


async def _post(creds, org_id=None):
    return await cloud_sync._post_applied(
        creds, bundle_id="b", policy_id="p", version=1, status="ok", error=None,
        org_id=org_id,
    )


@pytest.mark.asyncio
async def test_null_org_id_is_not_sent():
    _Client.responses = [_Resp(200), _Resp(200), _Resp(200)]
    assert await _post(_creds(None)) is True
    assert "org_id" not in _Client.posts[0]
    assert await _post(_creds(None), org_id="") is True
    assert "org_id" not in _Client.posts[1]
    assert await _post(_creds("org-1"), org_id="org-1") is True
    assert _Client.posts[2]["org_id"] == "org-1"


@pytest.mark.asyncio
async def test_org_id_comes_from_the_verified_bundle_not_the_credentials():
    _Client.responses = [_Resp(200), _Resp(200)]
    assert await _post(_creds("stale-org"), org_id="bundle-org") is True
    assert _Client.posts[0]["org_id"] == "bundle-org"
    # Stored credentials alone never supply the org.
    assert await _post(_creds("stale-org")) is True
    assert "org_id" not in _Client.posts[1]


@pytest.mark.asyncio
async def test_4xx_backs_off_and_logs_once_per_window(caplog):
    caplog.set_level(logging.WARNING, logger=cloud_sync.logger.name)
    _Client.responses = [_Resp(422, "{}")]
    assert await _post(_creds()) is False
    for _ in range(20):  # every later poll inside the window
        assert await _post(_creds()) is False
    assert len(_Client.posts) == 1
    warnings = [r for r in caplog.records if "/policy/applied" in r.getMessage()]
    assert len(warnings) == 1
    assert cloud_sync._APPLIED_ACK["delay"] == cloud_sync.SYNC_INTERVAL_SECONDS


@pytest.mark.asyncio
async def test_4xx_backoff_doubles_to_the_cap_and_resets_on_success():
    now = asyncio.get_running_loop().time()
    delays = []
    for _ in range(8):
        cloud_sync._APPLIED_ACK["until"] = now - 1  # window elapsed
        _Client.responses.append(_Resp(422))
        await _post(_creds())
        delays.append(cloud_sync._APPLIED_ACK["delay"])
    assert delays[:4] == [60.0, 120.0, 240.0, 480.0]
    assert max(delays) == cloud_sync.APPLIED_BACKOFF_MAX
    cloud_sync._APPLIED_ACK["until"] = now - 1
    _Client.responses.append(_Resp(200))
    assert await _post(_creds()) is True
    assert cloud_sync._APPLIED_ACK == {"ok": True, "delay": 0.0, "until": 0.0}


@pytest.mark.asyncio
async def test_5xx_and_network_errors_are_not_put_in_backoff():
    _Client.responses = [_Resp(503), RuntimeError("boom"), _Resp(200)]
    assert await _post(_creds()) is False
    assert await _post(_creds()) is False
    assert await _post(_creds()) is True
    assert len(_Client.posts) == 3


@pytest.mark.asyncio
async def test_loop_keeps_normal_cadence_when_the_ack_failed(monkeypatch):
    sleeps = []

    async def fake_sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) >= 2:
            raise asyncio.CancelledError

    async def no_verify(*a, **kw):
        return True

    async def applied_but_refused(*a, **kw):
        cloud_sync._APPLIED_ACK["ok"] = False
        return True

    monkeypatch.setattr(cloud_sync.asyncio, "sleep", fake_sleep)
    monkeypatch.setattr(cloud_sync, "_verify_envelope_or_quarantine", no_verify)
    monkeypatch.setattr(cloud_sync, "_sync_once", applied_but_refused)
    with pytest.raises(asyncio.CancelledError):
        await cloud_sync._sync_loop(db=None)
    assert sleeps == [cloud_sync.SYNC_INTERVAL_SECONDS, cloud_sync.SYNC_INTERVAL_SECONDS]
