"""Unit tests for the shared plugin-install helpers in _hooks_common.

These helpers are the lifted-out form of OpenClaw's private plumbing in
hooks.py; the same functions will be reused by additional agent-runtime
plugin install routes in later tasks.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from securevector.app.server.routes import _hooks_common


# --- resolve_sv_url -------------------------------------------------------


def test_resolve_sv_url_returns_http_url(monkeypatch):
    monkeypatch.delenv("SV_WEB_PORT", raising=False)
    url = _hooks_common.resolve_sv_url()
    assert url.startswith("http://")
    assert ":" in url


def test_resolve_sv_url_respects_env_port(monkeypatch):
    monkeypatch.setenv("SV_WEB_PORT", "9999")
    # bypass the config-file fall-back that could override env
    monkeypatch.setattr(_hooks_common, "_load_server_config", lambda: {})
    url = _hooks_common.resolve_sv_url()
    assert url.endswith(":9999")


# --- ensure_bundled_dir ---------------------------------------------------


def test_ensure_bundled_dir_returns_dir_when_all_files_present(tmp_path):
    bundled = tmp_path / "plugin"
    bundled.mkdir()
    files = ["a.json", "b.ts"]
    for f in files:
        (bundled / f).write_text("x")

    result = _hooks_common.ensure_bundled_dir(bundled, files)
    assert result == bundled


def test_ensure_bundled_dir_calls_regenerate_when_files_missing(tmp_path):
    bundled = tmp_path / "plugin"
    files = ["a.json", "b.ts"]

    called_with = []

    def regen(target_dir: Path) -> None:
        called_with.append(target_dir)
        for f in files:
            (target_dir / f).write_text("regenerated")

    result = _hooks_common.ensure_bundled_dir(bundled, files, regenerate_cb=regen)
    assert result == bundled
    assert bundled.is_dir()
    assert called_with == [bundled]
    for f in files:
        assert (bundled / f).read_text() == "regenerated"


def test_ensure_bundled_dir_skips_regenerate_when_complete(tmp_path):
    """If files already exist, regenerate_cb must not be called."""
    bundled = tmp_path / "plugin"
    bundled.mkdir()
    files = ["a.json"]
    (bundled / "a.json").write_text("existing")

    called = []
    _hooks_common.ensure_bundled_dir(
        bundled, files, regenerate_cb=lambda d: called.append(d)
    )
    assert called == []
    assert (bundled / "a.json").read_text() == "existing"


# --- stage_files ---------------------------------------------------------


def test_stage_files_copies_with_substitutions(tmp_path):
    source = tmp_path / "src"
    source.mkdir()
    (source / "a.json").write_text('{"url": "http://localhost:8741/x"}')
    (source / "b.ts").write_text('const u = "http://localhost:8000/y";')

    staging = tmp_path / "stage"
    written = _hooks_common.stage_files(
        staging_dir=staging,
        source_dir=source,
        files=["a.json", "b.ts"],
        substitutions={
            "http://localhost:8741": "http://127.0.0.1:9000",
            "http://localhost:8000": "http://127.0.0.1:9000",
        },
    )

    assert sorted(written) == ["a.json", "b.ts"]
    assert (staging / "a.json").read_text() == '{"url": "http://127.0.0.1:9000/x"}'
    assert (staging / "b.ts").read_text() == 'const u = "http://127.0.0.1:9000/y";'


def test_stage_files_skips_missing_sources(tmp_path):
    source = tmp_path / "src"
    source.mkdir()
    (source / "present.json").write_text("ok")

    staging = tmp_path / "stage"
    written = _hooks_common.stage_files(
        staging_dir=staging,
        source_dir=source,
        files=["present.json", "absent.json"],
        substitutions={},
    )
    assert written == ["present.json"]
    assert (staging / "present.json").read_text() == "ok"
    assert not (staging / "absent.json").exists()


def test_stage_files_creates_staging_dir(tmp_path):
    source = tmp_path / "src"
    source.mkdir()
    (source / "a.json").write_text("x")

    staging = tmp_path / "nested" / "stage"
    _hooks_common.stage_files(
        staging_dir=staging,
        source_dir=source,
        files=["a.json"],
        substitutions={},
    )
    assert staging.is_dir()
