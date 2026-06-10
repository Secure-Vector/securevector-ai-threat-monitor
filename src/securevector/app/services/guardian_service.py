"""SecureVector Guardian — local ML detection layer (fail-open).

Wraps the vendored, stdlib-only Guardian runtime (no scikit-learn / numpy at
runtime) so the app can run a semantic threat classifier alongside the regex
rules. Guardian is an ADDITIVE signal — it catches obfuscated / paraphrased /
buried / encoded attacks the literal rules miss; the analyze route decides how
its verdict folds into the calibrated gate (ML-alone blocks at a higher bar,
corroborates an already-firing rule at a lower one).

Loads once and is fully fail-open: any error (missing bundle, integrity
mismatch, runtime issue) disables Guardian and leaves regex detection
untouched. It must never break the analyze hot path.
"""

from __future__ import annotations

import logging
import os
import threading

logger = logging.getLogger(__name__)

_RUNTIME = os.path.join(os.path.dirname(__file__), "guardian", "guardian.runtime.json.gz")

_lock = threading.Lock()
_loaded = False
_guardian = None  # PureGuardian instance, or None if unavailable
_analyze_fn = None


def _ensure_loaded() -> None:
    global _loaded, _guardian, _analyze_fn
    if _loaded:
        return
    with _lock:
        if _loaded:
            return
        _loaded = True
        try:
            from .guardian.pure_infer import PureGuardian
            from .guardian.serve import analyze as _af
            if not os.path.exists(_RUNTIME):
                logger.info("Guardian runtime not found; ML layer disabled")
                return
            _guardian = PureGuardian.load(_RUNTIME)  # verifies SHA sidecar
            _analyze_fn = _af
            logger.info("Guardian ML layer loaded (offline, stdlib-only)")
        except Exception as exc:  # noqa: BLE001 — fail open, never break analyze
            logger.warning("Guardian ML layer unavailable, continuing with rules only: %s", exc)
            _guardian = None


def is_available() -> bool:
    _ensure_loaded()
    return _guardian is not None


def analyze(text: str, *, direction: str = "outgoing") -> dict | None:
    """Return Guardian's ``AnalysisResult``-shaped dict, or ``None`` if the ML
    layer is unavailable or errors. Never raises."""
    _ensure_loaded()
    if _guardian is None or _analyze_fn is None:
        return None
    try:
        return _analyze_fn(text, _guardian, direction=direction)
    except Exception as exc:  # noqa: BLE001 — fail open
        logger.warning("Guardian analyze failed (ignored): %s", exc)
        return None
