"""Trace text posture (5.3.0): redact always, cap at 8 KB, at the repository
boundary so every producer is covered."""

from __future__ import annotations

import pytest

from securevector.app.database.connection import DatabaseConnection
from securevector.app.database.migrations import run_migrations
from securevector.app.database.repositories.costs import CostsRepository
from securevector.app.database.repositories.custom_tools import CustomToolsRepository
from securevector.app.utils.trace_text import TRACE_TEXT_CAP, sanitize_trace_text

OPENAI_KEY = "sk-" + "a" * 40
GITHUB_PAT = "ghp_" + "b" * 36


async def _build_db(tmp_path) -> DatabaseConnection:
    db = DatabaseConnection(tmp_path / "test.db")
    await run_migrations(db)
    return db


def test_cap_is_8kb():
    assert TRACE_TEXT_CAP == 8192


def test_sanitize_redacts_and_keeps_short_text():
    out, truncated = sanitize_trace_text(f"curl -H 'Authorization: Bearer x' {OPENAI_KEY}")
    assert OPENAI_KEY not in out
    assert "sk-****" in out
    assert truncated is False


def test_sanitize_caps_and_flags_truncation():
    out, truncated = sanitize_trace_text("x" * (TRACE_TEXT_CAP + 500))
    assert len(out) == TRACE_TEXT_CAP
    assert truncated is True


def test_sanitize_redacts_before_capping():
    # The key sits across the cap boundary: a cap-then-redact order would
    # store the first half of the secret verbatim.
    # (The key pattern is greedy over alphanumerics, so the tail is spaced.)
    text = "y" * (TRACE_TEXT_CAP - 10) + OPENAI_KEY + " " + "w" * 100
    out, truncated = sanitize_trace_text(text)
    assert truncated is True
    assert "sk-" + "a" * 5 not in out
    assert "sk-****" in out


def test_sanitize_none_and_empty_are_preserved():
    assert sanitize_trace_text(None) == (None, False)
    assert sanitize_trace_text("") == ("", False)


def test_sanitize_incoming_direction_redacts_pem_body():
    pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----"
    out, _ = sanitize_trace_text(pem, direction="incoming")
    assert "MIIEow" not in out
    assert "BEGIN RSA PRIVATE KEY" in out


@pytest.mark.asyncio
async def test_tool_audit_redacts_args_and_reason_server_side(tmp_path):
    # A producer that forgot to redact (or a raw OTLP span) must still land
    # scrubbed, and long args keep 8 KB rather than 200 characters.
    db = await _build_db(tmp_path)
    repo = CustomToolsRepository(db)
    long_args = f"cmd={GITHUB_PAT} " + "q" * (TRACE_TEXT_CAP + 100)
    await repo.log_tool_call_audit(
        "Bash", "Bash", "allow",
        reason=f"token {OPENAI_KEY} seen",
        args_preview=long_args,
        runtime_kind="claude-code",
    )
    rows, _total = await repo.get_audit_log(limit=1)
    row = rows[0]
    assert GITHUB_PAT not in row["args_preview"]
    assert "ghp_****" in row["args_preview"]
    assert len(row["args_preview"]) == TRACE_TEXT_CAP
    assert OPENAI_KEY not in row["reason"]
    # The hash chain was built over the stored (redacted) text.
    chain = await repo.verify_audit_chain()
    assert chain["ok"] is True


@pytest.mark.asyncio
async def test_generation_redacts_previews_server_side(tmp_path):
    db = await _build_db(tmp_path)
    costs = CostsRepository(db)
    await costs.record_generation(
        trace_id="t1", span_id="g1", session_id="s1", runtime_kind="claude-code",
        provider="anthropic", model_id="m",
        input_preview=f"please use {OPENAI_KEY}",
        output_preview="o" * (TRACE_TEXT_CAP + 5),
    )
    gens = await costs.get_trace_generations("t1")
    assert len(gens) == 1
    assert OPENAI_KEY not in gens[0]["input_preview"]
    assert "sk-****" in gens[0]["input_preview"]
    assert len(gens[0]["output_preview"]) == TRACE_TEXT_CAP
