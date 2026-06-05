"""Precision/Recall harness for the SecureVector community rule pack (issue #136).

The rule-quality foundation. Loads the community rule pack straight from the
YAML (no DB needed — mirrors tests/unit/app/test_rule_pattern_precision.py),
computes each rule's calibrated confidence and applies the SAME calibrated
verdict the production analyze route uses (`calibrated_verdict`, imported, so
the harness and the route can never drift), then scores predictions against
the labeled corpus in tests/corpora/.

What this measures: the **rule + calibration layer** — does a sample's set of
matched rules clear the calibrated-verdict bar? It deliberately does NOT model
the analyze route's additional precision filters (the low-signal heuristic gate
and direction-aware suppression), which only ever DROP matches. So the layer
measured here is a *lower bound* on production precision: any false positive the
harness reports is a rule that is loose on its own and a candidate for the
per-rule tightening pass (#136 part 5). Recall here is an *upper bound only* in
the sense that the route never adds matches, so a recall miss here is a real miss.

Usage:
    from tests.harness.precision_recall import score_corpus, load_ruleset, load_corpus
    metrics = score_corpus()
    print(metrics.format_report())
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from securevector.app.services.analysis_service import (
    calibrate_confidence,
    calibrated_verdict,
    direction_applies,
    resolve_direction,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
RULES_DIR = _REPO_ROOT / "src" / "securevector" / "rules" / "community"
CORPUS_PATH = _REPO_ROOT / "tests" / "corpora" / "detection_corpus.yaml"


@dataclass
class CompiledRule:
    rule_id: str
    category: str
    severity: str
    confidence: float
    patterns: list[re.Pattern]
    direction: str = "both"


def load_ruleset(rules_dir: Path = RULES_DIR) -> list[CompiledRule]:
    """Compile every community rule with its calibrated confidence.

    Mirrors AnalysisService._compile_rules: authored metadata.confidence wins,
    else a severity-based default — via the shared calibrate_confidence().
    """
    ruleset: list[CompiledRule] = []
    for yaml_file in sorted(rules_dir.glob("*.yml")) + sorted(rules_dir.glob("*.yaml")):
        try:
            data = yaml.safe_load(yaml_file.read_text(encoding="utf-8")) or {}
        except yaml.YAMLError:
            # Mirror the engine, which wraps each file load in try/except and
            # SKIPS a malformed file. The harness stays alive; the dedicated
            # test_rule_files_all_load guard is what fails loudly on a bad file
            # (a silently-skipped rule file is a recall hole — see #136).
            continue
        rules = data.get("rules")
        if not rules:
            continue
        for rule in rules:
            patterns = rule.get("patterns") or []
            if not patterns:
                continue
            severity = rule.get("severity", "medium")
            metadata = rule.get("metadata") or {}
            compiled = []
            for pat in patterns:
                if not pat:
                    continue
                try:
                    compiled.append(re.compile(pat, re.IGNORECASE))
                except re.error:
                    # Invalid regex — skipped by the engine too; ignore here.
                    continue
            if not compiled:
                continue
            rid = rule.get("id", yaml_file.stem)
            category = rule.get("category", yaml_file.stem)
            ruleset.append(
                CompiledRule(
                    rule_id=rid,
                    category=category,
                    severity=severity,
                    confidence=calibrate_confidence(severity, metadata.get("confidence")),
                    patterns=compiled,
                    direction=resolve_direction(rid, category, metadata.get("direction")),
                )
            )
    return ruleset


def load_corpus(corpus_path: Path = CORPUS_PATH) -> list[dict]:
    data = yaml.safe_load(corpus_path.read_text(encoding="utf-8")) or {}
    return data.get("samples") or []


def predict(text, ruleset, scan_direction=None):
    """Return (is_threat, matched_rules) for one sample using the calibrated
    verdict. Rules whose `direction` does not apply to `scan_direction` are
    suppressed first — mirroring the analyze route's direction filtering
    (issue #136 Phase 3) so the harness measures the same behavior."""
    matched = [
        r for r in ruleset
        if direction_applies(r.direction, scan_direction)
        and any(p.search(text) for p in r.patterns)
    ]
    is_threat = calibrated_verdict([r.confidence for r in matched])
    return is_threat, matched


@dataclass
class CategoryMetrics:
    tp: int = 0
    fp: int = 0
    fn: int = 0
    tn: int = 0

    @property
    def precision(self) -> float:
        denom = self.tp + self.fp
        return self.tp / denom if denom else 1.0

    @property
    def recall(self) -> float:
        denom = self.tp + self.fn
        return self.tp / denom if denom else 1.0


@dataclass
class Metrics:
    overall: CategoryMetrics = field(default_factory=CategoryMetrics)
    by_category: dict = field(default_factory=dict)
    failures: list = field(default_factory=list)  # (sample_id, expected, got, matched_rule_ids)

    def format_report(self) -> str:
        lines = ["Detection precision/recall (rule + calibration layer)", "=" * 56]
        o = self.overall
        lines.append(
            f"OVERALL  precision={o.precision:.3f}  recall={o.recall:.3f}  "
            f"(tp={o.tp} fp={o.fp} fn={o.fn} tn={o.tn})"
        )
        for cat in sorted(self.by_category):
            m = self.by_category[cat]
            lines.append(
                f"  {cat:<22} precision={m.precision:.3f} recall={m.recall:.3f} "
                f"(tp={m.tp} fp={m.fp} fn={m.fn} tn={m.tn})"
            )
        if self.failures:
            lines.append("-" * 56)
            lines.append("Misclassifications:")
            for sid, expected, got, rules in self.failures:
                kind = "FALSE POSITIVE" if expected == "benign" else "FALSE NEGATIVE"
                lines.append(f"  [{kind}] {sid}: expected={expected} got_threat={got} matched={rules}")
        return "\n".join(lines)


def score_corpus(corpus_path: Path = CORPUS_PATH, rules_dir: Path = RULES_DIR) -> Metrics:
    ruleset = load_ruleset(rules_dir)
    samples = load_corpus(corpus_path)
    metrics = Metrics()

    for sample in samples:
        text = sample["text"]
        expected_malicious = sample["label"] == "malicious"
        got_threat, matched = predict(text, ruleset, sample.get("direction"))
        cat = sample.get("category") or ("benign" if not expected_malicious else "uncategorized")
        cm = metrics.by_category.setdefault(cat, CategoryMetrics())

        if expected_malicious and got_threat:
            metrics.overall.tp += 1; cm.tp += 1
        elif expected_malicious and not got_threat:
            metrics.overall.fn += 1; cm.fn += 1
            metrics.failures.append((sample["id"], "malicious", got_threat, [r.rule_id for r in matched]))
        elif not expected_malicious and got_threat:
            metrics.overall.fp += 1; cm.fp += 1
            metrics.failures.append((sample["id"], "benign", got_threat, [r.rule_id for r in matched]))
        else:
            metrics.overall.tn += 1; cm.tn += 1

    return metrics


if __name__ == "__main__":  # pragma: no cover — manual run: python -m tests.harness.precision_recall
    print(score_corpus().format_report())
