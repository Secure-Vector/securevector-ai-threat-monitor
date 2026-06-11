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
# Which runtime actually loaded ("package" / "bundled") and its version, so the
# UI reports the truth and `pip -U securevector-guardian-model` is visible.
_loaded_source = None
_loaded_version = None


def _ver_tuple(v: "str | None"):
    """Best-effort semver → comparable tuple. Non-numeric parts → 0."""
    out = []
    for part in str(v or "0").split("."):
        num = "".join(ch for ch in part if ch.isdigit())
        out.append(int(num) if num else 0)
    return tuple(out) or (0,)


def _bundled_version() -> "str | None":
    try:
        from .guardian import __version__ as v
        return v
    except Exception:  # noqa: BLE001
        return None


def _try_load_from_package():
    """Load Guardian from the installed ``securevector-guardian-model`` package
    IF it is at least the bundled version — so a stale wheel can never downgrade
    the model. Returns ``(guardian, analyze_fn, version)`` or ``None``. Fully
    fail-safe: any problem returns None and the bundled runtime is used.

    DORMANT until a compatible package ships: today the published wheel is older
    than the bundled runtime, so this returns None and nothing changes. Once the
    model repo publishes ``svguardian`` at >= the bundled version, `pip -U` +
    restart loads it here. Mirrors the vendored API (``pure_infer.PureGuardian``
    + ``serve.analyze`` + a packaged ``guardian.runtime.json.gz``); if a future
    package reshapes that, the except-guard falls back to bundled.
    """
    try:
        from importlib.metadata import PackageNotFoundError, version as _dist_version

        try:
            pkg_ver = _dist_version("securevector-guardian-model")
        except PackageNotFoundError:
            return None
        if _ver_tuple(pkg_ver) < _ver_tuple(_bundled_version()):
            return None  # older than the bundled floor — don't downgrade

        import importlib

        pure_infer = importlib.import_module("svguardian.model.pure_infer")
        serve = importlib.import_module("svguardian.serve")
        # OFFLINE-ONLY runtime resolution — the app must never fetch over the
        # network in its load path. As of svguardian v1.2, the wheel bundles its
        # weights in-package (svguardian/_runtime/), so we resolve them via the
        # package's own offline locator `_runtime.bundled_path()` — NEVER via
        # `resolve_runtime()`, which can download. An explicit SV_GUARDIAN_RUNTIME
        # still wins. No offline runtime → return None and keep the bundled floor.
        rt_env = os.environ.get("SV_GUARDIAN_RUNTIME")
        if rt_env and os.path.exists(rt_env):
            return pure_infer.PureGuardian.load(rt_env), serve.analyze, pkg_ver
        # `bundled_path()` returns the in-wheel runtime that matches THIS package
        # version (its .sha256 sidecar sits beside it, so tamper-check holds).
        runtime_mod = importlib.import_module("svguardian._runtime")
        bundled = runtime_mod.bundled_path()
        if bundled and os.path.exists(bundled):
            guardian = pure_infer.PureGuardian.load(bundled)
            return guardian, serve.analyze, pkg_ver
        return None
    except Exception as exc:  # noqa: BLE001 — never let the package path break load
        logger.warning("Guardian package load failed; using bundled runtime: %s", exc)
        return None


def _ensure_loaded() -> None:
    global _loaded, _guardian, _analyze_fn, _loaded_source, _loaded_version
    if _loaded:
        return
    with _lock:
        if _loaded:
            return
        _loaded = True
        # Prefer the installed model package when it's compatible (>= bundled);
        # otherwise use the vendored runtime. The package path is dormant until
        # a compatible wheel ships, so this is a no-op change today.
        pkg = _try_load_from_package()
        if pkg is not None:
            _guardian, _analyze_fn, _loaded_version = pkg
            _loaded_source = "package"
            logger.info("Guardian ML layer loaded from installed package v%s", _loaded_version)
            return
        try:
            from .guardian.pure_infer import PureGuardian
            from .guardian.serve import analyze as _af
            if not os.path.exists(_RUNTIME):
                logger.info("Guardian runtime not found; ML layer disabled")
                return
            _guardian = PureGuardian.load(_RUNTIME)  # verifies SHA sidecar
            _analyze_fn = _af
            _loaded_source = "bundled"
            _loaded_version = _bundled_version()
            logger.info("Guardian ML layer loaded (bundled v%s, offline, stdlib-only)", _loaded_version)
        except Exception as exc:  # noqa: BLE001 — fail open, never break analyze
            logger.warning("Guardian ML layer unavailable, continuing with rules only: %s", exc)
            _guardian = None


def is_available() -> bool:
    _ensure_loaded()
    return _guardian is not None


def model_version() -> "str | None":
    """Version of the Guardian model ACTUALLY loaded, for UI transparency.

    Reflects what inference uses: the loader records the version of whichever
    runtime won (installed package when compatible, else bundled), so this is
    always truthful — a stale wheel sitting alongside a newer bundled runtime
    reports the bundled version, and `pip -U` to a compatible wheel reports the
    package version after restart.
    """
    _ensure_loaded()
    return _loaded_version


def model_source() -> "str | None":
    """Where the loaded model came from: ``"package"``, ``"bundled"``, or None."""
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
