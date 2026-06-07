"""CI gate for detection quality (issue #136).

Three guards:
  1. test_all_community_rule_files_load — every community rule YAML parses and
     every pattern is a compilable string. The engine wraps each file load in
     try/except and SILENTLY SKIPS a malformed one, so a YAML break is a stealth
     recall hole (it just removes a whole rule family from production with no
     error). This is exactly how `sv_community_prompt_injection.yml` was dead.
  2. test_precision_recall_floor — overall precision/recall must stay at/above a
     committed floor. Ratchet the floor UP as rules are tightened (#136 part 5);
     never down without a recorded reason.
  3. test_no_new_misclassifications — the set of corpus samples the detector gets
     wrong must not GROW. New regressions fail loudly even if the aggregate
     scores still clear the floor. Removing a known weakness (shrinking the set)
     is always allowed.

Run the human-readable report with:
    PYTHONPATH=src python -m tests.harness.precision_recall
"""

from __future__ import annotations

import re
from pathlib import Path

import yaml

from tests.harness.precision_recall import RULES_DIR, load_ruleset, score_corpus

# Committed floor. Introduced at precision=recall=0.889; raised to 0.95 after
# the Phase-5 pass closed both seed weaknesses (precision=recall=1.000 on the
# current corpus). RATCHET UP as detection improves — do not lower silently.
_PRECISION_FLOOR = 0.95
_RECALL_FLOOR = 0.95

# Known, documented weaknesses the harness tolerates. Empty: the current corpus
# is fully classified. Add an id here (with a rationale) ONLY to consciously
# accept a gap you can't yet close — never to silence a fresh regression.
_KNOWN_WEAKNESSES: set[str] = set()


def test_all_community_rule_files_load():
    """Every community rule file parses and every pattern compiles.

    Regression guard for the silent-skip class of bug (#136): a YAML break
    removes a whole rule family from production with no error.
    """
    problems = []
    files = sorted(RULES_DIR.glob("*.yml")) + sorted(RULES_DIR.glob("*.yaml"))
    assert files, f"no community rule files found under {RULES_DIR}"
    for f in files:
        try:
            data = yaml.safe_load(f.read_text(encoding="utf-8")) or {}
        except yaml.YAMLError as e:
            problems.append(f"{f.name}: YAML parse error: {str(e).splitlines()[0]}")
            continue
        for rule in data.get("rules") or []:
            for pat in rule.get("patterns") or []:
                if not isinstance(pat, str):
                    problems.append(f"{f.name}:{rule.get('id')}: non-string pattern {pat!r}")
                    continue
                try:
                    re.compile(pat, re.IGNORECASE)
                except re.error as e:
                    problems.append(f"{f.name}:{rule.get('id')}: bad regex: {e}")
    assert not problems, "Community rule files failed to load:\n  " + "\n  ".join(problems)


def test_ruleset_includes_prompt_injection():
    """The prompt-injection family must actually load (it was silently dead)."""
    categories = {r.category for r in load_ruleset()}
    assert "prompt_injection" in categories, (
        "prompt_injection rules are not loading — sv_community_prompt_injection.yml "
        "likely failed to parse again (see #136)."
    )


def test_precision_recall_floor():
    m = score_corpus()
    assert m.overall.precision >= _PRECISION_FLOOR, (
        f"precision {m.overall.precision:.3f} < floor {_PRECISION_FLOOR}\n" + m.format_report()
    )
    assert m.overall.recall >= _RECALL_FLOOR, (
        f"recall {m.overall.recall:.3f} < floor {_RECALL_FLOOR}\n" + m.format_report()
    )


def test_no_new_misclassifications():
    m = score_corpus()
    failing = {sid for (sid, _expected, _got, _rules) in m.failures}
    new = failing - _KNOWN_WEAKNESSES
    assert not new, (
        "New detection regressions (samples newly misclassified):\n  "
        + "\n  ".join(sorted(new))
        + "\n\n"
        + m.format_report()
    )
