"""SecureVector Guardian — local ML detection layer (fail-open).

Wraps the **`securevector-guardian-model`** package (import name ``svguardian``),
a stdlib-only semantic threat classifier installed as a normal pip dependency
(no vendored runtime in this repo). Guardian is an ADDITIVE signal — it catches
obfuscated / paraphrased / buried / encoded attacks the literal rules miss; the
analyze route decides how its verdict folds into the calibrated gate (ML-alone
blocks at a higher bar, corroborates an already-firing rule at a lower one).

Whether Guardian actually runs is gated upstream in the analyze route by the
``guardian_ml_enabled`` setting (UI kill-switch) and the ``SECUREVECTOR_ML_ENABLED``
env flag — this module only loads/serves the model.

Loads once and is fully fail-open: any error (package missing, model fetch
failure, integrity mismatch, runtime issue) disables Guardian and leaves regex
detection untouched. It must never break the analyze hot path. `pip install -U
securevector-guardian-model` + restart picks up a newer model.
"""

from __future__ import annotations

import logging
import os
import threading

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_loaded = False
_guardian = None  # PureGuardian instance, or None if unavailable
_analyze_fn = None
# Loaded model version (the installed package version), so the UI reports the
# truth and `pip -U securevector-guardian-model` is visible after restart.
_loaded_source = None
_loaded_version = None


def _ensure_loaded() -> None:
    global _loaded, _guardian, _analyze_fn, _loaded_source, _loaded_version
    if _loaded:
        return
    with _lock:
        if _loaded:
            return
        _loaded = True
        try:
            import importlib
            from importlib.metadata import version as _dist_version

            _loaded_version = _dist_version("securevector-guardian-model")
            pure_infer = importlib.import_module("svguardian.model.pure_infer")
            serve = importlib.import_module("svguardian.serve")

            # Resolve the model weights. An explicit SV_GUARDIAN_RUNTIME wins
            # (air-gapped installs pre-place the runtime and point here).
            # Otherwise the package's resolver returns a cached path, fetching
            # the ~1.8 MB runtime once on first use and reusing it offline after.
            rt_env = os.environ.get("SV_GUARDIAN_RUNTIME")
            if rt_env and os.path.exists(rt_env):
                runtime_path = rt_env
            else:
                bundle = importlib.import_module("svguardian._bundle")
                runtime_path = bundle.resolve_runtime()

            _guardian = pure_infer.PureGuardian.load(runtime_path)  # verifies SHA sidecar if present
            _analyze_fn = serve.analyze
            _loaded_source = "package"
            logger.info(
                "Guardian ML loaded from securevector-guardian-model v%s", _loaded_version
            )
        except Exception as exc:  # noqa: BLE001 — fail open, never break analyze
            logger.warning(
                "Guardian ML unavailable, continuing with rules only: %s", exc
            )
            _guardian = None
            _analyze_fn = None


def is_available() -> bool:
    _ensure_loaded()
    return _guardian is not None


def model_version() -> "str | None":
    """Version of the Guardian model package actually loaded, for UI transparency.

    Reflects the installed ``securevector-guardian-model`` version that inference
    uses; `pip install -U securevector-guardian-model` + restart updates it.
    """
    _ensure_loaded()
    return _loaded_version


def model_source() -> "str | None":
    """Where the loaded model came from: ``"package"`` or None."""
    _ensure_loaded()
    return _loaded_source


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
