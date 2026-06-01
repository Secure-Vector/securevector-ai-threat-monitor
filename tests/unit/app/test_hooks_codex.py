"""Tests for the TOML section-aware helpers in hooks_codex.

Focus: the v4.4 hardening of `_strip_our_sections` + `_is_enabled_in_config_toml`
that replaced the v4.3 regex-based parsers. The earlier versions had two
real bugs flagged in the #131 review:

  1. ``_strip_our_sections`` terminated a section on any line whose first
     non-space character was ``[``. TOML array values like
     ``ignore = [".git", ".venv"]`` on their own line would end the strip
     early, leaving the tail of our prior section in the file.
  2. ``_is_enabled_in_config_toml`` used a single regex with ``[^\\[]*?``
     and ``re.DOTALL`` to find ``enabled = true`` after our header. With
     no negative-lookahead for the next section header, a sibling
     section's ``enabled = true`` could produce a false positive.

These tests are deliberately black-box: they construct realistic
config.toml inputs that would have tripped the v4.3 parsers and assert
the v4.4 line-scanner produces the correct output.
"""

from __future__ import annotations

import sys
from pathlib import Path

# The src layout isn't on sys.path during pytest discovery; inject it.
ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from securevector.app.server.routes import hooks_codex  # noqa: E402


def test_strip_handles_array_value_starting_with_bracket():
    """v4.3 regression: array values like `ignore = [...]` on their own
    line were treated as the next section header, ending the strip early.
    """
    text = (
        "[some-other]\n"
        "ignore = [\n"
        '  ".git",\n'
        '  ".venv"\n'
        "]\n"
        "\n"
        "[marketplaces.securevector-local]\n"
        'source = "/tmp/x"\n'
        "\n"
        "[plugins.\"securevector-guard@securevector-local\"]\n"
        "enabled = true\n"
        "\n"
        "[another-section]\n"
        "value = 1\n"
    )
    cleaned = hooks_codex._strip_our_sections(text)
    # Our two sections must be fully gone:
    assert "[marketplaces.securevector-local]" not in cleaned
    assert '[plugins."securevector-guard@securevector-local"]' not in cleaned
    # The unrelated array value must survive intact:
    assert "[some-other]" in cleaned
    assert 'ignore = [' in cleaned
    assert '".git"' in cleaned
    # The trailing unrelated section must still be there:
    assert "[another-section]" in cleaned
    assert "value = 1" in cleaned


def test_strip_handles_multiline_string_containing_header_literal():
    """A triple-quoted string whose body looks like our section header
    must NOT trigger a strip. The v4.3 parser would have matched the
    literal as a header and eaten the surrounding section.
    """
    text = (
        "[docs]\n"
        'example = """\n'
        "Here is a sample config block:\n"
        "[marketplaces.securevector-local]\n"
        'source = "/tmp/notreal"\n'
        '"""\n'
        "\n"
        "[after]\n"
        "x = 1\n"
    )
    cleaned = hooks_codex._strip_our_sections(text)
    # The triple-quoted string must survive — header literal is inside
    # a value, not a real section.
    assert '[docs]' in cleaned
    assert '[marketplaces.securevector-local]' in cleaned  # in the string body
    assert '[after]' in cleaned
    assert 'x = 1' in cleaned


def test_strip_drops_only_our_sections_and_preserves_neighbours():
    text = (
        "# user comment\n"
        "[unrelated]\n"
        "key = \"value\"\n"
        "\n"
        "[marketplaces.securevector-local]\n"
        "last_updated = \"2026-05-28T00:00:00Z\"\n"
        "source_type = \"local\"\n"
        'source = "/Users/x/.securevector/staging/codex-plugin"\n'
        "\n"
        '[plugins."securevector-guard@securevector-local"]\n'
        "enabled = true\n"
        "\n"
        "[trailing]\n"
        "kept = true\n"
    )
    cleaned = hooks_codex._strip_our_sections(text)
    assert "[unrelated]" in cleaned
    assert 'key = "value"' in cleaned
    assert "[trailing]" in cleaned
    assert "kept = true" in cleaned
    assert "[marketplaces.securevector-local]" not in cleaned
    assert '[plugins."securevector-guard@securevector-local"]' not in cleaned
    # No accumulating gap between unrelated and trailing.
    assert "\n\n\n" not in cleaned


def test_strip_idempotent_on_clean_input():
    """Re-running on a file that has no SecureVector sections is a no-op."""
    text = (
        "[other]\n"
        "value = 1\n"
        "\n"
        "[more]\n"
        "list = [1, 2, 3]\n"
    )
    assert hooks_codex._strip_our_sections(text) == text.rstrip("\n") + "\n"


def test_is_enabled_true_for_our_section():
    text = (
        "[marketplaces.securevector-local]\n"
        'source = "/tmp/x"\n'
        "\n"
        '[plugins."securevector-guard@securevector-local"]\n'
        "enabled = true\n"
    )
    assert hooks_codex._is_enabled_in_config_toml.__wrapped__ if hasattr(
        hooks_codex._is_enabled_in_config_toml, "__wrapped__"
    ) else True
    # Drive via the read-codex helper monkey-patched at call time.
    orig = hooks_codex._read_codex_config_toml
    hooks_codex._read_codex_config_toml = lambda: text
    try:
        assert hooks_codex._is_enabled_in_config_toml() is True
    finally:
        hooks_codex._read_codex_config_toml = orig


def test_is_enabled_false_when_our_section_disabled():
    text = (
        '[plugins."securevector-guard@securevector-local"]\n'
        "enabled = false\n"
    )
    orig = hooks_codex._read_codex_config_toml
    hooks_codex._read_codex_config_toml = lambda: text
    try:
        assert hooks_codex._is_enabled_in_config_toml() is False
    finally:
        hooks_codex._read_codex_config_toml = orig


def test_is_enabled_false_when_only_sibling_section_has_enabled_true():
    """v4.3 regression: a sibling section's `enabled = true` could
    register as ours because the regex had no negative-lookahead for
    the next section header.
    """
    text = (
        '[plugins."securevector-guard@securevector-local"]\n'
        "enabled = false\n"
        "\n"
        '[plugins."some-other@market"]\n'
        "enabled = true\n"
    )
    orig = hooks_codex._read_codex_config_toml
    hooks_codex._read_codex_config_toml = lambda: text
    try:
        assert hooks_codex._is_enabled_in_config_toml() is False
    finally:
        hooks_codex._read_codex_config_toml = orig


def test_is_enabled_false_when_section_absent():
    text = "[unrelated]\nkey = 1\n"
    orig = hooks_codex._read_codex_config_toml
    hooks_codex._read_codex_config_toml = lambda: text
    try:
        assert hooks_codex._is_enabled_in_config_toml() is False
    finally:
        hooks_codex._read_codex_config_toml = orig


def test_is_enabled_false_on_empty_file():
    orig = hooks_codex._read_codex_config_toml
    hooks_codex._read_codex_config_toml = lambda: ""
    try:
        assert hooks_codex._is_enabled_in_config_toml() is False
    finally:
        hooks_codex._read_codex_config_toml = orig


def test_section_header_detector_rejects_array_value_lines():
    """The standalone header regex should accept real section headers
    and reject the lines that previously caused the v4.3 strip bug —
    array values like ``ignore = [".git"]`` on their own line.
    """
    assert hooks_codex._is_section_header("[plugins.foo]") is True
    assert hooks_codex._is_section_header('[plugins."bar@baz"]') is True
    assert hooks_codex._is_section_header("  [indented.section]  ") is True
    assert hooks_codex._is_section_header("[section] # trailing comment") is True
    # The critical reject case — array values on their own line:
    assert hooks_codex._is_section_header("value = [1, 2, 3]") is False
    assert hooks_codex._is_section_header('  ignore = [".git"]') is False
    # Reject table-array headers (none of our sections use [[...]]):
    assert hooks_codex._is_section_header("[[some.array]]") is False
    # Multi-line array continuation (just the `]`) is not a header:
    assert hooks_codex._is_section_header("]") is False
