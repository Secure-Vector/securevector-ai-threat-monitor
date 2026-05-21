"""
Regression guard for rule-pack regex precision.

History: two community rules used unanchored `.*` or `[^\\s]{8,}` patterns
that matched any sufficiently long prose containing common English words
or path delimiters. They produced critical-severity false positives on
2 KB security-review briefs (the prose talked ABOUT data leakage; the
rules treated mention as instance) and on prompts containing localhost
URLs (path strings have digits + delimiters = "credential dump" to a
loose regex).

The fix bounds inter-token distance to ~5 words (excessive_agency) and
excludes path/URL delimiters from credential tokens (credential_leak).

This test compiles the patterns straight from the YAML and asserts:
  - canonical attack shapes STILL match (no regression in detection)
  - the specific false-positive shapes that triggered the regression
    do NOT match (precision improvement)

The test is intentionally pattern-level — it doesn't go through the
analysis service, so it catches drift even before the rule cache is
rebuilt.
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml


RULES_DIR = (
    Path(__file__).resolve().parents[3]
    / "src"
    / "securevector"
    / "rules"
    / "community"
)


def _load_patterns(filename: str, rule_id: str) -> list[re.Pattern]:
    rules = yaml.safe_load((RULES_DIR / filename).read_text())["rules"]
    rule = next(r for r in rules if r["id"] == rule_id)
    return [re.compile(p, re.IGNORECASE) for p in rule["patterns"]]


def _any_pattern_matches(patterns: list[re.Pattern], text: str) -> bool:
    return any(p.search(text) for p in patterns)


# ---------------------------------------------------------------- excessive_agency


def test_excessive_agency_matches_canonical_destructive_command():
    patterns = _load_patterns("owasp_top10.yml", "sv_llm_008_excessive_agency")
    assert _any_pattern_matches(patterns, "Delete all files in /tmp now")
    assert _any_pattern_matches(patterns, "delete all my temp files please")
    assert _any_pattern_matches(patterns, "remove all the test files")
    assert _any_pattern_matches(patterns, "destroy all backup files")


def test_excessive_agency_matches_other_canonical_shapes():
    patterns = _load_patterns("owasp_top10.yml", "sv_llm_008_excessive_agency")
    assert _any_pattern_matches(patterns, "execute the autonomous agent")
    assert _any_pattern_matches(patterns, "transfer 1000 dollars in funds")
    assert _any_pattern_matches(patterns, "access protected system files")
    assert _any_pattern_matches(patterns, "grant unlimited admin permissions")


def test_excessive_agency_does_not_match_separated_words_in_prose():
    """
    The pasted security-review brief from session 2026-05-21 contained the
    word "Remove" near the start and the word "files" near the end, hundreds
    of characters apart, in totally unrelated contexts. The prior pattern
    matched. The bounded variant must not.
    """
    patterns = _load_patterns("owasp_top10.yml", "sv_llm_008_excessive_agency")
    # ~700-char prose with "Remove", "all", "files" scattered far apart
    benign_brief = (
        "You are reviewing a code change. Look for: stripped headers, "
        "license issues, GDPR concerns, removed coverage, third-party "
        "dependencies, marketing-claim risk. The README mentions all the "
        "supported runtimes including Claude Code. Please flag any "
        "regression in test coverage. The diff touches several files in "
        "the plugins directory. If nothing material changed, reply with "
        "SHIP."
    )
    assert not _any_pattern_matches(patterns, benign_brief), (
        "the brief mentions 'Remove' (in 'removed coverage'), 'all', and "
        "'files' in unrelated phrases — bounded pattern should not match"
    )


def test_excessive_agency_funds_alternation_is_now_bounded():
    """
    The prior pattern `(send|transfer).*money|funds` had a precedence bug:
    it parsed as `((send|transfer).*money) | (funds)` and matched any text
    containing the bare word 'funds'. The bounded variant uses an explicit
    group so 'funds' alone does NOT match.
    """
    patterns = _load_patterns("owasp_top10.yml", "sv_llm_008_excessive_agency")
    assert not _any_pattern_matches(
        patterns, "The pension funds were audited last quarter"
    ), "bare 'funds' must not trigger excessive-agency without a transfer verb"
    # Sanity: the verb+noun phrase DOES still match
    assert _any_pattern_matches(patterns, "please send the funds to account X")


# ---------------------------------------------------------------- credential_leak


def test_credential_leak_matches_canonical_credential_dump():
    patterns = _load_patterns(
        "sv_community_output_leakage.yml",
        "sv_community_output_001_credential_leak",
    )
    # numbered list with high-entropy mixed-char tokens — the canonical
    # "agent leaked these to chat" shape this rule was designed for
    assert _any_pattern_matches(
        patterns,
        "Here are the keys:\n1. sk_test_AbCd123!ZxYw\n2. AKIA-EXAMPLE-7890",
    )
    assert _any_pattern_matches(
        patterns, "- AbCd1234!XyZw9876_secret"
    )


def test_credential_leak_does_not_match_path_or_url_tokens():
    """
    The prior `[^\\s]{8,}` accepted any non-whitespace token, so paths like
    `/var/folders/rj/2t60.../diff.patch` matched (mixed case, digits, special
    chars, no spaces). The fix excludes /, :, ., @ from the token.
    """
    patterns = _load_patterns(
        "sv_community_output_leakage.yml",
        "sv_community_output_001_credential_leak",
    )
    assert not _any_pattern_matches(
        patterns,
        "- See diff at /var/folders/rj/2t60mpjn1r13fb7ypdx1q1ww0000gn/T/file.patch",
    ), "filesystem path should not trip the bulleted-credential rule"
    assert not _any_pattern_matches(
        patterns,
        "1. Check the URL https://example.com/api/v1/foo?token=abc123",
    ), "URL containing dots and slashes should not trip the rule"
    assert not _any_pattern_matches(
        patterns,
        "2. Contact admin@example.com for access",
    ), "email address should not trip the rule"


def test_credential_leak_still_catches_jwt_via_dedicated_pattern():
    """
    JWTs use '.' as a separator (eyJ...eyJ...sig). The bulleted-token
    pattern excludes '.', so JWTs would no longer match THAT pattern —
    but the rule has a separate dedicated JWT pattern further down.
    """
    patterns = _load_patterns(
        "sv_community_output_leakage.yml",
        "sv_community_output_001_credential_leak",
    )
    jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123_signature"
    assert _any_pattern_matches(patterns, jwt), (
        "JWT must still be caught by the dedicated eyJ... pattern even "
        "though it contains '.' and is excluded from the bulleted-token "
        "pattern"
    )
