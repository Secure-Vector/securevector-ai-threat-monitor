"""Unit tests for the shared plugin-install helpers in _hooks_common.

These helpers are the lifted-out form of OpenClaw's private plumbing in
hooks.py; the same functions will be reused by additional agent-runtime
plugin install routes in later tasks.
"""

from __future__ import annotations

from pathlib import Path


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


def test_stage_files_copies_binary_assets_byte_for_byte(tmp_path):
    """A binary asset (e.g. a plugin logo / favicon.ico) is not valid UTF-8, so
    a text read+rewrite would corrupt it. stage_files must detect the
    UnicodeDecodeError and copy it verbatim — while still substituting in the
    text file staged alongside it. Regression for the Cursor plugin logo."""
    source = tmp_path / "src"
    source.mkdir()
    # Bytes that are NOT valid UTF-8 (0x89 PNG header, 0xff, etc.) and happen to
    # contain the substitution needle — which must NOT be applied to binary.
    blob = bytes([0x89, 0x50, 0x4E, 0x47, 0xFF, 0xFE, 0x00, 0x01]) + b"http://localhost:8741"
    (source / "logo.ico").write_bytes(blob)
    (source / "client.js").write_text('const u = "http://localhost:8741";')

    staging = tmp_path / "stage"
    written = _hooks_common.stage_files(
        staging_dir=staging,
        source_dir=source,
        files=["logo.ico", "client.js"],
        substitutions={"http://localhost:8741": "http://127.0.0.1:9000"},
    )

    assert sorted(written) == ["client.js", "logo.ico"]
    # Binary survives byte-for-byte (no decode, no substitution).
    assert (staging / "logo.ico").read_bytes() == blob
    # Text file alongside it still gets the substitution.
    assert (staging / "client.js").read_text() == 'const u = "http://127.0.0.1:9000";'


# --- staged_is_current ----------------------------------------------------


def _staged_case(tmp_path):
    src = tmp_path / "src"
    dst = tmp_path / "dst"
    src.mkdir()
    dst.mkdir()
    (src / "a.ts").write_text("url=http://localhost:8741")
    (src / "logo.bin").write_bytes(b"\xff\xfe\x00http://localhost:8741")
    return src, dst


def test_staged_is_current_true_after_stage_files(tmp_path):
    src, dst = _staged_case(tmp_path)
    subs = {"http://localhost:8741": "http://127.0.0.1:9"}
    files = ["a.ts", "logo.bin"]
    _hooks_common.stage_files(staging_dir=dst, source_dir=src, files=files, substitutions=subs)
    assert _hooks_common.staged_is_current(
        staging_dir=dst, source_dir=src, files=files, substitutions=subs
    )


def test_staged_is_current_false_on_substitution_mismatch(tmp_path):
    src, dst = _staged_case(tmp_path)
    files = ["a.ts"]
    _hooks_common.stage_files(
        staging_dir=dst, source_dir=src, files=files,
        substitutions={"http://localhost:8741": "http://127.0.0.1:9"},
    )
    assert not _hooks_common.staged_is_current(
        staging_dir=dst, source_dir=src, files=files,
        substitutions={"http://localhost:8741": "http://127.0.0.1:10"},
    )


def test_staged_is_current_false_when_missing_or_changed(tmp_path):
    src, dst = _staged_case(tmp_path)
    files = ["a.ts"]
    assert not _hooks_common.staged_is_current(
        staging_dir=dst, source_dir=src, files=files, substitutions={}
    )
    (dst / "a.ts").write_text("stale")
    assert not _hooks_common.staged_is_current(
        staging_dir=dst, source_dir=src, files=files, substitutions={}
    )
    assert (dst / "a.ts").read_text() == "stale"  # read-only


def test_staged_is_current_compares_binary_bytes(tmp_path):
    src, dst = _staged_case(tmp_path)
    (dst / "logo.bin").write_bytes(b"\xff\xfe\x00http://localhost:8741")
    subs = {"http://localhost:8741": "http://127.0.0.1:9"}
    assert _hooks_common.staged_is_current(
        staging_dir=dst, source_dir=src, files=["logo.bin"], substitutions=subs
    )
    (dst / "logo.bin").write_bytes(b"\xff\xfe\x01")
    assert not _hooks_common.staged_is_current(
        staging_dir=dst, source_dir=src, files=["logo.bin"], substitutions=subs
    )



def test_stage_files_refuses_a_symlinked_folder_at_any_depth(tmp_path):
    src = tmp_path / "src"
    (src / "a" / "b").mkdir(parents=True)
    (src / "a" / "b" / "f.js").write_text("x")
    (src / "top.js").write_text("y")
    dst = tmp_path / "dst"
    dst.mkdir()
    outside = tmp_path / "outside"
    (outside / "b").mkdir(parents=True)
    (dst / "a").symlink_to(outside, target_is_directory=True)
    written = _hooks_common.stage_files(staging_dir=dst, source_dir=src, files=["a/b/f.js", "top.js"],
                                        substitutions={})
    assert written == ["top.js"]
    assert not (outside / "b" / "f.js").exists()


def test_staged_is_current_false_when_the_destination_is_a_symlink(tmp_path):
    src, dst = _staged_case(tmp_path)
    files = ["a.ts"]
    _hooks_common.stage_files(staging_dir=dst, source_dir=src, files=files, substitutions={})
    real = tmp_path / "real.ts"
    real.write_bytes((dst / "a.ts").read_bytes())
    (dst / "a.ts").unlink()
    (dst / "a.ts").symlink_to(real)
    assert not _hooks_common.staged_is_current(staging_dir=dst, source_dir=src, files=files, substitutions={})
