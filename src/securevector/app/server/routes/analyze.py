"""
Analysis API endpoint for threat detection.

POST /api/v1/analyze - Analyze text for threats
"""

import asyncio
import logging
import os
import re
import time
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

# SecureVector Guardian (local ML detection layer) — verdict policy.
# ADDITIVE: the model can only raise/strengthen a verdict, never suppress a
# rule. It folds into the existing calibrated gate at TWO bars:
#   * ML ALONE (no rule fired) blocks only at high confidence.
#   * ML CORROBORATES an already-firing rule at a lower bar.
# High-precision: catches what rules miss without firing on weak model hunches.
_ML_ALONE_BAR = 0.90
_ML_CORROBORATE_BAR = 0.60


def _ml_enabled() -> bool:
    """Environment kill-switch layered over the Settings toggle.

    The user-facing on/off lives in app_settings.guardian_ml_enabled (Settings
    page, default ON). SECUREVECTOR_ML_ENABLED=false force-disables Guardian
    regardless of the UI — an operator escape hatch that needs no DB access.
    Read per-request (cheap) so it can be toggled without a restart."""
    return os.environ.get("SECUREVECTOR_ML_ENABLED", "on").strip().lower() in (
        "1", "true", "yes", "on"
    )

# Base64-encoded image blobs forwarded by the Claude Code plugin (e.g.
# screenshots returned by a tool, image attachments in MCP responses) are
# random-looking long [A-Za-z0-9+/=] strings. The community rule pack is
# text-shaped and occasionally trips on substrings of these blobs — most
# visibly `sv_community_output_001_credential_leak` firing on PNG bytes
# that happen to contain the substring `password`. We don't want to skip
# the audit altogether (the user wants visibility that the scan happened),
# but we also can't let random image bytes mint false positives. The fix:
# replace each base64 image payload with a fixed placeholder BEFORE the
# engine runs. The surrounding JSON envelope (`{"type":"image", ...}`) is
# preserved so any real text gets scanned normally. The four prefixes
# below cover PNG / JPEG / GIF / WebP (which is RIFF...WEBP — `UklGR` is
# the base64 of `RIFF`). 100-char minimum tail prevents matching the
# magic prefix in normal prose ("the iVBORw0KGgo png-base64 prefix...").
_IMAGE_BASE64_RE = re.compile(
    r'(?:iVBORw0KGgo|/9j/|R0lGOD|UklGR)[A-Za-z0-9+/=]{100,}'
)


def _strip_image_base64(text: str) -> str:
    return _IMAGE_BASE64_RE.sub('[IMAGE-BASE64-REDACTED]', text)

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.threat_intel import ThreatIntelRepository
from securevector.app.database.repositories.settings import SettingsRepository
from securevector.app.database.repositories.redactions import (
    RedactionsRepository,
    hash_matched_substring,
)
from securevector.app.utils.redaction import redact_secrets

logger = logging.getLogger(__name__)

router = APIRouter()


class AnalysisRequest(BaseModel):
    """Request body for threat analysis."""

    text: str = Field(..., max_length=102400, description="Text to analyze (max 100KB)")
    source: Optional[str] = Field(None, max_length=255, description="Source identifier")
    session_id: Optional[str] = Field(None, max_length=64, description="Session ID")
    request_id: Optional[str] = Field(None, max_length=64, description="Client request ID")
    metadata: Optional[dict] = Field(None, description="Additional metadata")
    llm_response: bool = Field(False, description="Set true when analyzing LLM output (checks for leaks, PII)")
    # Bundle 0.2 — Indirect Prompt Injection (IDPI) scan mode.
    # Three values, semantically distinct:
    #   "outgoing"  (default) — text is heading user→LLM. Existing rule set
    #                 applies (prompt injection / jailbreak / etc.).
    #   "incoming"  — text was *fetched* by the agent (RAG chunk, scraped HTML,
    #                 email body, tool output) and is about to be fed to the
    #                 LLM as context. IDPI rule pack fires; threshold for
    #                 BLOCK is tighter because the user has zero agency over
    #                 hidden instructions in fetched content.
    #   "llm_response" — equivalent to the existing llm_response=True flag;
    #                 retained for back-compat. Prefer using `direction`
    #                 for new integrations.
    # Defaults to "outgoing" so any v4.0.x client continues to get the
    # original behaviour without code change.
    direction: Literal["outgoing", "incoming", "llm_response"] = Field(
        "outgoing",
        description="Scan mode: outgoing (user→LLM, default), incoming (fetched context→LLM, IDPI), or llm_response (LLM→user, equivalent to llm_response=True).",
    )


class MatchedRule(BaseModel):
    """Matched rule details."""

    rule_id: str
    rule_name: str
    category: str
    severity: str
    source: str  # 'community' or 'custom'
    matched_patterns: list[str] = []
    # Per-rule detection confidence (issue #136), 0.0–1.0. Authored
    # metadata.confidence or a severity default from the engine. Surfaced
    # so consumers (and the precision/recall harness) can see why a rule
    # did or didn't contribute to the calibrated verdict. Optional for
    # backward compatibility with callers that don't emit it.
    confidence: Optional[float] = None
    # MITRE ATT&CK technique IDs associated with this rule match. Sourced
    # from the rule's own metadata.mitre_attack_ids when present; falls
    # back to a per-category default otherwise. Surfaces in OCSF's
    # `finding.techniques` for downstream SIEM dashboards.
    mitre_techniques: list[str] = []


class LLMReviewInfo(BaseModel):
    """LLM review details."""

    reviewed: bool = False
    agrees: bool = True
    confidence: float = 0.0
    reasoning: str = ""
    recommendation: str = ""  # Recommended action from LLM
    risk_adjustment: int = 0
    model_used: Optional[str] = None
    processing_time_ms: int = 0
    tokens_used: int = 0


class AnalysisResult(BaseModel):
    """Response body for threat analysis."""

    is_threat: bool
    threat_type: Optional[str]
    risk_score: int = Field(..., ge=0, le=100)
    confidence: float = Field(..., ge=0, le=1)
    matched_rules: list[MatchedRule]
    analysis_id: Optional[str] = None
    processing_time_ms: int
    request_id: Optional[str] = None
    analysis_source: str = "local"  # "local", "cloud", or "local_fallback"
    # LLM Review fields
    llm_review: Optional[LLMReviewInfo] = None
    # Redacted text (returned when secrets are detected and redacted)
    redacted_text: Optional[str] = None
    # Action taken (logged, blocked, or redacted)
    action_taken: str = "logged"


@router.post("/analyze", response_model=AnalysisResult)
async def analyze_text(request: AnalysisRequest, http_request: Request) -> AnalysisResult:
    """
    Analyze text content for threats.

    When cloud mode is enabled, proxies to SecureVector cloud API.
    Otherwise, runs the text through local community and custom rules.
    Stores the result in threat intel and returns the analysis.
    """
    start_time = time.perf_counter()
    analysis_source = "local"
    user_agent = http_request.headers.get("user-agent")

    # Reconcile the legacy `llm_response: bool` flag with the new
    # `direction: str` field. `direction` is the source of truth going
    # forward; `llm_response=True` is back-compat shorthand for
    # `direction="llm_response"`.
    direction = request.direction
    if request.llm_response and direction == "outgoing":
        direction = "llm_response"
    is_llm_response = direction == "llm_response"
    is_idpi_scan = direction == "incoming"

    # Stamp resolved direction onto the metadata dict so it lands in the
    # threat_intel row + flows into OCSF SIEM events. Pivot key for the
    # Threat Monitor UI to filter outgoing vs incoming-context vs llm_response.
    # Don't mutate request.metadata — FastAPI keeps that reference for the
    # response cycle.
    augmented_metadata = dict(request.metadata or {})
    augmented_metadata["direction"] = direction
    if is_idpi_scan:
        augmented_metadata.setdefault("scan_type", "incoming_context")

    try:
        # Check settings
        db = get_database()
        settings_repo = SettingsRepository(db)
        settings = await settings_repo.get()

        # If this is an LLM response scan and scan_llm_responses is disabled, skip
        if is_llm_response and not settings.scan_llm_responses:
            logger.debug("LLM response scanning disabled, skipping")
            return AnalysisResult(
                is_threat=False,
                threat_type=None,
                risk_score=0,
                confidence=0.0,
                matched_rules=[],
                analysis_id="skipped",
                processing_time_ms=0,
                request_id=request.request_id,
                analysis_source="disabled",
            )

        # Output scans run locally with the same bundled ruleset as input
        # scans — PII, secrets, harmful-content, and data-leak patterns
        # fire just as well against an LLM completion as against a
        # prompt. When Cloud Connect is on we route to the cloud for
        # ML-grade analysis (Llama Guard); otherwise we serve whatever
        # the regex layer catches. Local is always the floor — never
        # "skipped because cloud is off".

        skip_cloud = (request.metadata or {}).get("skip_cloud", False)
        # Cloud analysis is ONLY invoked when Cloud Connect is turned on
        # (``settings.cloud_mode_enabled``) and the caller hasn't set
        # ``metadata.skip_cloud=true``. With Cloud Connect off, we never
        # enter this branch — both the input ``/analyze`` and output
        # ``/analyze/output`` cloud endpoints stay untouched, and the
        # scan drops straight to the local ruleset below.
        if settings.cloud_mode_enabled and not skip_cloud:
            try:
                from securevector.app.services.cloud_proxy import (
                    get_cloud_proxy,
                    CloudProxyError,
                )

                proxy = get_cloud_proxy()
                if is_llm_response:
                    # ``proxy.analyze_output`` → cloud ``POST /analyze/output``.
                    # Reached only when Cloud Connect is on (see guard above).
                    # Local regex rules still run in the cloud-failure
                    # fallback path; the cloud response supplements them
                    # with Llama Guard ML scoring.
                    cloud_result = await proxy.analyze_output(
                        output_text=request.text,
                        metadata=augmented_metadata,
                        model_id=(request.metadata or {}).get("model_id"),
                        conversation_id=(request.metadata or {}).get("conversation_id")
                            or request.session_id,
                    )
                else:
                    # ``proxy.analyze`` → cloud ``POST /analyze``.
                    # Reached only when Cloud Connect is on (see guard above).
                    cloud_result = await proxy.analyze(
                        text=request.text,
                        metadata=augmented_metadata,
                    )

                # Cloud returned result - use it directly
                processing_time_ms = int(
                    (time.perf_counter() - start_time) * 1000
                )

                # Determine action_taken from metadata (sent by LLM proxy)
                default_action = "blocked" if settings.block_threats else "logged"
                action_taken = (request.metadata or {}).get("action_taken", default_action)

                # Only store in database if threat detected
                record = None
                if cloud_result.get("is_threat", False):
                    threat_intel_repo = ThreatIntelRepository(db)

                    record = await threat_intel_repo.create(
                        text=request.text,
                        is_threat=cloud_result.get("is_threat", False),
                        threat_type=cloud_result.get("threat_type"),
                        risk_score=cloud_result.get("risk_score", 0),
                        confidence=cloud_result.get("confidence", 0.0),
                        matched_rules=cloud_result.get("matched_rules", []),
                        processing_time_ms=processing_time_ms,
                        store_text=settings.store_text_content,
                        request_id=request.request_id,
                        source=request.source,
                        session_id=request.session_id,
                        metadata=augmented_metadata,
                        user_agent=user_agent,
                        action_taken=action_taken,
                    )

                return AnalysisResult(
                    is_threat=cloud_result.get("is_threat", False),
                    threat_type=cloud_result.get("threat_type"),
                    risk_score=cloud_result.get("risk_score", 0),
                    confidence=cloud_result.get("confidence", 0.0),
                    matched_rules=[],  # Cloud doesn't return detailed rules
                    analysis_id=record.id if record else None,
                    processing_time_ms=processing_time_ms,
                    request_id=request.request_id,
                    analysis_source="cloud",
                    action_taken=action_taken,
                )

            except Exception as e:
                # Cloud failed. Fall back to the local ruleset for both
                # input and output scans — local results are a real
                # answer (regex-layer catches most PII / secrets /
                # injection / harmful-content patterns), and a security
                # firewall should never silently fail-open with
                # `is_threat=False` just because the ML uplift was
                # unreachable. The `analysis_source="local_fallback"`
                # string lets the caller see that the cloud leg didn't
                # land, without hiding the real result.
                logger.warning(f"Cloud analysis failed, falling back to local: {e}")
                analysis_source = "local_fallback"

        # Use local analysis service (combines SDK + custom rules)
        from securevector.app.services.analysis_service import (
            calibrated_verdict,
            direction_applies,
            get_analysis_service,
        )

        service = get_analysis_service()

        # Strip SecureVector's own context guard directives before scanning.
        # The plugin injects these into every prompt — they contain phrases
        # like "prompt injection" and "jailbreak" that trigger our own rules.
        # Uses string search instead of regex to avoid polynomial regex risk.
        _GUARD_START = 'This session is monitored by SecureVector AI Threat Monitor.'
        _GUARD_END = 'SecureVector is actively scanning all messages for threats.'
        scan_text = request.text
        start_idx = scan_text.find(_GUARD_START)
        if start_idx != -1:
            end_idx = scan_text.find(_GUARD_END, start_idx)
            if end_idx != -1:
                scan_text = (scan_text[:start_idx] + scan_text[end_idx + len(_GUARD_END):]).strip() or request.text

        # Replace base64 image payloads with a placeholder before the engine
        # runs. The request itself is still recorded (audit trail intact);
        # the engine just doesn't see the random bytes that would otherwise
        # mint false-positive rule matches on substrings like "password" or
        # "ghp_" appearing by chance in PNG/JPEG/GIF/WebP base64.
        scan_text = _strip_image_base64(scan_text)

        # SecureVector Guardian (local ML layer) runs IN PARALLEL with the regex
        # analysis below: kicked off here in a worker thread, awaited at the
        # verdict merge. Fail-open — any setup error leaves rules untouched.
        # Gated on the Settings toggle (default ON) AND the env kill-switch.
        _guardian_task = None
        if settings.guardian_ml_enabled and _ml_enabled():
            try:
                from securevector.app.services import guardian_service

                _guardian_task = asyncio.create_task(
                    asyncio.to_thread(
                        guardian_service.analyze, scan_text, direction=direction
                    )
                )
            except Exception:  # noqa: BLE001 — never break analyze
                _guardian_task = None

        result = await service.analyze(scan_text)

        # Drop rule hits below the noise floor. Engine occasionally returns very
        # low-confidence semantic matches (e.g. 0.008 on plain source code that
        # happens to look "bulky" or "encoded") that pollute the threat log
        # without informing the operator. 0.25 is a conservative cut — real
        # detections from the regex/blocklist stages return >= 0.70, and the
        # ML-stage threshold for "ALLOW" is < 0.45 in the engine.
        _MIN_RULE_CONFIDENCE = 0.25

        # Direction-aware rule suppression (issue #136 Phase 3). The community
        # rule pack ships rules that match LANGUAGE-KEYWORD shapes (`eval\(`,
        # `subprocess`, `system\s*\(`, "export as csv") rather than secret
        # VALUES. They catch an LLM generating dangerous code in an outgoing
        # response, but fire on every source file or markdown a Read tool
        # returns as incoming context — a false-positive flood. Each rule now
        # carries an evaluation `direction` (resolved by the engine via
        # resolve_direction): `outgoing`-tagged rules — command-exec, insecure
        # output, encoded content, bulk-extraction, and all `_evasion_` rules —
        # are suppressed on an incoming scan, while rules that match real
        # secret values stay `both` and still fire on tool responses where a
        # credential leaks. This replaces the former hardcoded id list with a
        # tag-driven check (`direction_applies`) shared by the engine, this
        # route, and the precision/recall harness.

        # Low-signal heuristic-shape filter.
        #
        # ROOT-CAUSE NOTE: the local engine (`analysis_service.analyze`) does
        # not carry a per-rule confidence into each matched-rule dict, and
        # hardcodes the verdict `confidence` to a flat 0.8 for ANY regex hit
        # (see analysis_service.py). That means the `_MIN_RULE_CONFIDENCE`
        # checks below — both the per-rule `rule.get("confidence", 1.0)` line
        # and the overall `result.confidence < floor` check — can never fire
        # for a local match: there is no sub-floor confidence to catch. The
        # consequence was a flood of `data_leakage` / "Output Credential
        # Leakage Detection" rows minted at confidence 0.8 from purely
        # SHAPE-based heuristics that match ordinary prose.
        #
        # The credential-leak rule mixes two kinds of pattern:
        #   - STRUCTURED secret patterns — `ghp_…`, `gho_…`, `sk-…`,
        #     `sk_test_…`, `AKIA…`, `xox…`, `github_pat_…`, JWT (`eyJ….eyJ…`),
        #     PEM blocks, and `api_key:`/`password=`/`bearer ` followed by a
        #     value. A hit on any of these is a real, high-signal leak.
        #   - LOOSE heuristic shapes — a bulleted/numbered line whose token
        #     merely contains a letter+digit+symbol. These fire on everyday
        #     text (code review prose, config snippets, changelogs) and
        #     produce the false-positive flood.
        #
        # We can't read a confidence the engine never emits, so we judge
        # signal by the matched REGEX itself: if a rule's ONLY surviving
        # matched patterns are loose heuristic shapes (no structured-secret
        # pattern hit), the match is low-signal and is dropped. A genuine
        # secret leak hits a structured pattern and survives untouched.
        #
        # IMPORTANT — these fragments MUST be live substrings of the CURRENT
        # `sv_community_output_001_credential_leak` patterns, or the filter
        # silently goes dead (always returns False) and the FP flood comes
        # back. They are distinctive substrings of the bulleted/numbered
        # entropy-token heuristic, which is the only LOOSE-shape arm still
        # present in the YAML (the bare `Word##!sym` arm was removed when
        # the rule was tightened). Picked the symbol-lookahead and the
        # token-body class because both appear ONLY in that loose arm and in
        # no structured-secret pattern (verified against the whole rule
        # pack), so a structured hit is never mistaken for low-signal:
        #   - `(?=[^\s]*[!@#$%^&*])` — the special-char lookahead.
        #   - `[^\s/:.@_]{8,}`       — the bulleted-token body class.
        _LOOSE_HEURISTIC_PATTERN_FRAGMENTS = (
            # Special-char lookahead from the bulleted-token heuristic.
            r"(?=[^\s]*[!@#$%^&*])",
            # Token body of the bulleted-token heuristic (excludes path/URL
            # delimiters + underscore — see the rule's own comment).
            r"[^\s/:.@_]{8,}",
        )

        def _is_loose_heuristic_pattern(pattern: str) -> bool:
            return any(frag in pattern for frag in _LOOSE_HEURISTIC_PATTERN_FRAGMENTS)

        def _is_low_signal_heuristic_only(rule_dict) -> bool:
            """True when every matched pattern is a loose shape heuristic.

            Returns False (i.e. keep) the moment a structured-secret pattern
            is present, so real credential leaks are never suppressed.
            """
            patterns = rule_dict.get("matched_patterns") or []
            if not patterns:
                # No pattern detail to judge — keep, fail-safe toward recording.
                return False
            return all(_is_loose_heuristic_pattern(p) for p in patterns)

        # Convert matched rules to response format (filtered)
        matched_rules = []
        surviving_confidences = []  # per-rule confidence of survivors (issue #136)
        for rule in result.matched_rules:
            # Missing confidence defaults to 1.0 — callers that pre-date the
            # per-rule confidence field (and the unit tests that mock the
            # engine) intend such a hit to count as high-signal.
            rule_conf = float(rule.get("confidence", 1.0))
            if rule_conf < _MIN_RULE_CONFIDENCE:
                continue
            if _is_low_signal_heuristic_only(rule):
                # Rule fired ONLY on loose shape heuristics (bulleted-token /
                # Word##!sym) — no structured-secret pattern matched. This is
                # the source of the 0.8-confidence `data_leakage` flood; drop
                # it. A real secret leak hits a structured pattern and is kept.
                continue
            if not direction_applies(rule.get("direction", "both"), request.direction):
                # Cross-direction rule (e.g. an outgoing-only keyword/shape
                # rule on an incoming fetched-content scan) — suppress. Rules
                # that match real secret values are tagged `both` and survive.
                continue
            surviving_confidences.append(rule_conf)
            matched_rules.append(
                MatchedRule(
                    rule_id=rule.get("id", "unknown"),
                    rule_name=rule.get("name", "Unknown Rule"),
                    category=rule.get("category", "unknown"),
                    severity=rule.get("severity", "medium"),
                    source=rule.get("source", "community"),
                    matched_patterns=rule.get("matched_patterns", []),
                    mitre_techniques=list(rule.get("mitre_techniques") or []),
                    confidence=round(rule_conf, 3),
                )
            )

        # Fold in the PARALLEL Guardian (ML) result started before the regex run.
        # ADDITIVE, never suppresses a rule. The bar depends on whether a rule
        # already survived: ML ALONE must clear _ML_ALONE_BAR (0.90); if a rule
        # fired, ML only needs _ML_CORROBORATE_BAR (0.60) to strengthen it. Its
        # confidence then flows through the SAME calibrated gate below, so a
        # qualifying ML hit raises or corroborates a threat exactly like a rule.
        # Fail-open: any error leaves the rule verdict untouched.
        if _guardian_task is not None:
            try:
                gr = await _guardian_task
            except Exception:  # noqa: BLE001
                gr = None
            if gr and gr.get("is_threat") and gr.get("matched_rules"):
                ml_rule = gr["matched_rules"][0]
                ml_conf = float(ml_rule.get("confidence") or 0.0)
                ml_bar = _ML_CORROBORATE_BAR if surviving_confidences else _ML_ALONE_BAR
                if ml_conf >= ml_bar:
                    surviving_confidences.append(ml_conf)
                    matched_rules.append(
                        MatchedRule(
                            rule_id=ml_rule.get("rule_id", "sv_guardian_model"),
                            rule_name=ml_rule.get("rule_name", "SecureVector Guardian (ML)"),
                            category=ml_rule.get("category", "unknown"),
                            severity=ml_rule.get("severity", "medium"),
                            source="model",
                            matched_patterns=[],
                            mitre_techniques=[],
                            confidence=round(ml_conf, 3),
                        )
                    )
                    # PROMOTE: the engine said benign but ML ALONE cleared its
                    # high bar — raise the verdict here, because the calibrated
                    # block below only demotes (it keys off result.is_threat)
                    # and final_* fields inherit from result.
                    if not result.is_threat and ml_conf >= _ML_ALONE_BAR:
                        result.is_threat = True
                        result.threat_type = (
                            gr.get("threat_type") or ml_rule.get("category") or "unknown"
                        )
                        result.risk_score = float(
                            gr.get("risk_score") or round(ml_conf * 100)
                        )
                        result.confidence = ml_conf

        # Calibrated verdict (issue #136). "Any rule matched = threat"
        # over-alarms: a lone low/medium-confidence heuristic should inform
        # the score but not raise a threat by itself. Among the SURVIVING
        # rules (after the per-rule floor + low-signal heuristic + direction
        # guards above), require either ONE high-confidence hit OR at least
        # TWO corroborating medium-confidence hits. This subsumes the old
        # overall-confidence-floor and empty-after-filter demotions: an empty
        # survivor set or a single sub-threshold heuristic both fail the bar.
        calibrated_is_threat = bool(matched_rules) and calibrated_verdict(
            surviving_confidences
        )
        if result.is_threat and not calibrated_is_threat:
            if not matched_rules:
                reason = "all rules filtered (floor / heuristic / direction guard)"
            else:
                reason = (
                    f"uncorroborated low/medium confidence "
                    f"(top={max(surviving_confidences):.2f}, "
                    f"survivors={len(surviving_confidences)})"
                )
            logger.debug(
                "Dropped threat — %s: engine_conf=%.3f risk_score=%s engine_rules=%d → surviving=%d",
                reason,
                float(result.confidence or 0.0),
                result.risk_score,
                len(result.matched_rules or []),
                len(matched_rules),
            )
            result.is_threat = False
            result.threat_type = None
            result.risk_score = 0.0
            matched_rules = []

        processing_time_ms = result.processing_time_ms

        # Get settings for LLM review and storage
        db = get_database()
        settings_repo = SettingsRepository(db)
        settings = await settings_repo.get()

        # LLM Review (if enabled)
        llm_review_info = None
        final_is_threat = result.is_threat
        final_risk_score = result.risk_score
        final_confidence = result.confidence
        final_threat_type = result.threat_type

        # Mark output scan threats with "output_" prefix
        scan_type = (request.metadata or {}).get("scan_type", "input")
        if is_llm_response and scan_type == "output" and final_threat_type:
            if not final_threat_type.startswith("output_"):
                final_threat_type = f"output_{final_threat_type}"

        llm_settings = settings.llm_settings or {}
        # Only run LLM review for input scans (not output)
        is_input_scan = scan_type == "input"
        if llm_settings.get("enabled") and is_input_scan:
            try:
                from securevector.app.services.llm_review import LLMConfig, LLMReviewService

                config = LLMConfig(
                    enabled=True,
                    provider=llm_settings.get("provider", "ollama"),
                    model=llm_settings.get("model", "llama3"),
                    endpoint=llm_settings.get("endpoint", "http://localhost:11434"),
                    api_key=llm_settings.get("api_key"),
                    timeout=llm_settings.get("timeout", 30),
                    max_tokens=llm_settings.get("max_tokens", 1024),
                    temperature=llm_settings.get("temperature", 0.1),
                )

                llm_service = LLMReviewService(config)
                try:
                    # Build analysis dict for LLM review
                    analysis_dict = {
                        "is_threat": result.is_threat,
                        "threat_type": result.threat_type,
                        "risk_score": result.risk_score,
                        "confidence": result.confidence,
                        "matched_rules": [r.rule_name for r in matched_rules],
                        # Context for LLM review: output scan looks for data leakage, PII exposure
                        "scan_type": "output" if is_llm_response else "input",
                    }

                    llm_result = await llm_service.review(request.text, analysis_dict)

                    if llm_result.reviewed:
                        llm_review_info = LLMReviewInfo(
                            reviewed=True,
                            agrees=llm_result.llm_agrees,
                            confidence=llm_result.llm_confidence,
                            reasoning=llm_result.llm_explanation,
                            recommendation=llm_result.llm_recommendation,
                            risk_adjustment=llm_result.llm_risk_adjustment,
                            model_used=llm_result.model_used,
                            processing_time_ms=llm_result.processing_time_ms,
                            tokens_used=llm_result.tokens_used,
                        )

                        # Combine results: adjust risk score and confidence
                        # If LLM found threat but regex didn't (or vice versa)
                        if llm_result.llm_threat_assessment == "threat" and not result.is_threat:
                            # LLM detected threat that regex missed
                            final_is_threat = True
                            final_risk_score = min(100, result.risk_score + max(30, llm_result.llm_risk_adjustment))
                            final_threat_type = llm_result.llm_suggested_category or "llm_detected"
                        elif llm_result.llm_threat_assessment == "safe" and result.is_threat:
                            # LLM thinks it's safe, reduce risk but keep as threat if high regex confidence
                            if result.confidence < 0.7:
                                final_is_threat = False
                                final_risk_score = max(0, result.risk_score + llm_result.llm_risk_adjustment)
                        else:
                            # Both agree, adjust risk score by LLM recommendation
                            final_risk_score = max(0, min(100, result.risk_score + llm_result.llm_risk_adjustment))

                        # Combine confidence scores (weighted average)
                        if llm_result.llm_confidence > 0:
                            final_confidence = (result.confidence * 0.4 + llm_result.llm_confidence * 0.6)

                        processing_time_ms += llm_result.processing_time_ms

                finally:
                    await llm_service.close()

            except Exception as e:
                logger.warning(f"LLM review failed, using regex-only result: {e}")
                llm_review_info = LLMReviewInfo(
                    reviewed=False,
                    reasoning=f"LLM review failed: {str(e)}",
                )

        # Always run redaction — regardless of whether the threat engine
        # flagged the text. Rationale:
        #   - The threat engine and the redactor are independent layers.
        #     The engine catches injection/exfil PATTERNS; the redactor
        #     catches raw secret SHAPES. A response containing a bare
        #     ghp_<token> or AKIA<id> with no surrounding instruction
        #     prose won't trip any threat rule, but the redactor will —
        #     and we still want that secret scrubbed before the agent
        #     ingests the content, and we still want an audit-log row.
        #   - Gating redaction on is_threat (the pre-v4.3 behaviour) made
        #     redactor coverage strictly less than what the redactor's
        #     own patterns claim. End-to-end testing of the Redactions
        #     page surfaced this on a bare GitHub PAT: the engine
        #     returned is_threat=False and the redaction never ran.
        #
        # `direction` is forwarded so INCOMING_ONLY_PATTERNS (PEM private-
        # key blocks + OpenSSH binary carrier) fire ONLY on fetched
        # content (tool responses, RAG) — see redaction.py docstring.
        #
        # Every match is also recorded to the redaction_events audit log
        # via the record_event callback. The callback receives the raw
        # matched substring — we IMMEDIATELY hash it and discard, never
        # persist the raw value (see RedactionsRepository docstring).
        # This is what backs the local Redactions page.
        redacted_text_result = None
        redaction_count = 0

        # Resolve tool metadata from the scan metadata (PostToolUse fills
        # tool_name + tool_id when this is a tool-response scan). Stays
        # None for direct /analyze callers that don't set them.
        scan_meta = augmented_metadata or {}
        source_tool = scan_meta.get("tool_name") if isinstance(scan_meta, dict) else None
        source_tool_id = scan_meta.get("tool_id") if isinstance(scan_meta, dict) else None
        # Both Guard plugins (claude-code, openclaw, …) stamp runtime_kind on
        # the analyze metadata. Thread it through so the Secret Detections
        # page can disambiguate per-plugin without joining anywhere else.
        runtime_kind = scan_meta.get("runtime_kind") if isinstance(scan_meta, dict) else None
        # OpenClaw's older plugins set `source: "openclaw-plugin"` but never
        # populate `runtime_kind` — fall back to inferring from `source` so
        # those events still attribute correctly.
        if not runtime_kind:
            src = request.source or ""
            if "openclaw" in src:
                runtime_kind = "openclaw"
            elif "claude-code" in src:
                runtime_kind = "claude-code"
        redactions_repo = RedactionsRepository(db)
        pending_events: list[dict] = []

        def _capture(match_meta: dict) -> None:
            # Hash before queuing — the raw substring stops here.
            pending_events.append({
                "pattern_id": match_meta["pattern_id"],
                "secret_type": match_meta["secret_type"],
                "redaction_hash": hash_matched_substring(match_meta["matched"]),
            })

        redacted_text, redaction_count = redact_secrets(
            request.text,
            direction=direction,
            record_event=_capture,
        )
        if redaction_count > 0:
            redacted_text_result = redacted_text
        # Persist the events outside the redactor (DB writes are async,
        # the redactor itself is sync). Failures are swallowed inside
        # RedactionsRepository.record — they must never derail a scan.
        for ev in pending_events:
            await redactions_repo.record(
                pattern_id=ev["pattern_id"],
                secret_type=ev["secret_type"],
                direction=direction,
                source_tool=source_tool,
                source_tool_id=source_tool_id,
                request_id=request.request_id,
                redaction_hash=ev["redaction_hash"],
                runtime_kind=runtime_kind,
            )

        # Determine action_taken from metadata (always, for response)
        # Priority: blocked > redacted > logged
        default_action = "blocked" if settings.block_threats else "logged"
        action_taken = (request.metadata or {}).get("action_taken", default_action)
        if redaction_count > 0 and action_taken == "logged":
            action_taken = "redacted"

        # Only store in database if threat detected
        record = None
        if final_is_threat:
            threat_intel_repo = ThreatIntelRepository(db)

            # Use redacted text for storage
            text_to_store = redacted_text_result if redacted_text_result else request.text

            record = await threat_intel_repo.create(
                text=text_to_store,
                is_threat=final_is_threat,
                threat_type=final_threat_type,
                risk_score=final_risk_score,
                confidence=final_confidence,
                matched_rules=[r.model_dump() for r in matched_rules],
                processing_time_ms=processing_time_ms,
                store_text=settings.store_text_content,
                request_id=request.request_id,
                source=request.source,
                session_id=request.session_id,
                metadata=augmented_metadata,
                # LLM Review data
                llm_reviewed=llm_review_info.reviewed if llm_review_info else False,
                llm_agrees=llm_review_info.agrees if llm_review_info else True,
                llm_confidence=llm_review_info.confidence if llm_review_info else 0.0,
                llm_explanation=llm_review_info.reasoning if llm_review_info else None,
                llm_recommendation=llm_review_info.recommendation if llm_review_info else None,
                llm_risk_adjustment=llm_review_info.risk_adjustment if llm_review_info else 0,
                llm_model_used=llm_review_info.model_used if llm_review_info else None,
                llm_tokens_used=llm_review_info.tokens_used if llm_review_info else 0,
                user_agent=user_agent,
                action_taken=action_taken,
            )

        logger.debug(
            f"Analysis complete: is_threat={final_is_threat}, "
            f"risk_score={final_risk_score}, "
            f"llm_reviewed={llm_review_info.reviewed if llm_review_info else False}, "
            f"processing_time={processing_time_ms}ms"
        )

        return AnalysisResult(
            is_threat=final_is_threat,
            threat_type=final_threat_type,
            risk_score=final_risk_score,
            confidence=final_confidence,
            matched_rules=matched_rules,
            analysis_id=record.id if record else None,
            processing_time_ms=processing_time_ms,
            request_id=request.request_id,
            analysis_source=analysis_source,
            llm_review=llm_review_info,
            redacted_text=redacted_text_result,
            action_taken=action_taken,
        )

    except Exception as e:
        logger.error(f"Analysis failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Analysis failed. Please try again.")
