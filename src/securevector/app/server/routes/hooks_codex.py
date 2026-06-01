"""
OpenAI Codex plugin management API endpoints.

Parallel to ``hooks_claude_code.py`` (Claude Code plugin) and ``hooks.py``
(OpenClaw plugin). All three modules delegate the shared file-staging
plumbing to ``_hooks_common``.

GET  /api/hooks/codex/status     - Plugin install status
POST /api/hooks/codex/install    - Stage plugin tree + auto-install into ~/.codex
POST /api/hooks/codex/uninstall  - Remove staged tree + config.toml entries (idempotent)

The install flow stages the plugin tree into
``~/.securevector/staging/codex-plugin/`` with the local-app URL
substituted, writes a marketplace manifest under ``.agents/plugins/``,
then copies the plugin tree into ``~/.codex/plugins/cache/...`` and
registers it in ``~/.codex/config.toml``. If Codex isn't installed
(``~/.codex/`` missing) we fall back to returning two paste-in commands
the user can run inside a Codex session.

Codex stores plugin state in TOML (``~/.codex/config.toml``) — not JSON.
Two sections are added:

    [marketplaces.securevector-local]
    last_updated = "<ISO timestamp>"
    source_type = "local"
    source = "<staging-dir>"

    [plugins."securevector-guard@securevector-local"]
    enabled = true

Every other section is preserved verbatim by deleting only our two
sections (header + their keys until the next header) before appending
the new content. That round-trip avoids the lossy parse→re-emit pitfall
where comments, key order, or formatting would otherwise be normalised.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from . import _hooks_common

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/hooks/codex", tags=["Hooks"])

PLUGIN_NAME = "securevector-guard"

# Plugin tree files — must match what lives under
# ``src/securevector/plugins/codex/``. Excludes ``statusline.js`` and
# ``stop-hook-probe.js`` which are CC-specific (Codex's statusline is
# built-in items only; the Stop probe was a CC token-discovery experiment).
PLUGIN_FILES = [
    ".codex-plugin/plugin.json",
    "hooks/hooks.json",
    "hooks/pre-tool-use.js",
    "hooks/post-tool-use.js",
    "hooks/user-prompt-submit.js",
    "lib/normalize.js",
    "lib/client.js",
    "lib/redact.js",
    "README.md",
    "PRIVACY.md",
]

# Bundled plugin source directory (shipped with the package).
# Path: src/securevector/app/server/routes/<this file> → up 4 → securevector/
BUNDLED_PLUGIN_DIR = (
    Path(__file__).parent.parent.parent.parent / "plugins" / "codex"
)

# Staging directory. Mirrors the Claude Code plugin's staging convention.
# This is the marketplace source root — Codex reads
# ``<staging>/.agents/plugins/marketplace.json`` from here.
SECUREVECTOR_DIR = Path.home() / ".securevector"
STAGING_DIR = SECUREVECTOR_DIR / "staging" / "codex-plugin"

# Codex per-user config + plugin cache locations. Discovered empirically
# against codex-cli 0.133.0 — these paths and the TOML section names are
# stable across the public 0.133.x releases.
CODEX_HOME = Path.home() / ".codex"
CODEX_CONFIG_TOML = CODEX_HOME / "config.toml"
CODEX_PLUGIN_CACHE_ROOT = CODEX_HOME / "plugins" / "cache"

# Hidden marketplace slug. Mirrors the CC plugin's convention: every
# install is registered under a single per-machine marketplace so the
# user never sees the slug. ``MARKETPLACE_SLUG`` shows up in TOML
# section headers only.
MARKETPLACE_SLUG = "securevector-local"
INSTALL_KEY = f"{PLUGIN_NAME}@{MARKETPLACE_SLUG}"


# --- Pydantic response models -----------------------------------------------


class StatusResponse(BaseModel):
    installed: bool
    staging_dir: str
    files_present: list[str]
    auto_installed: bool = False
    codex_install_path: Optional[str] = None
    enabled: bool = False
    # True when Codex appears to be present on this machine — used by the
    # dashboard plugin-nudge banner to gate the "Install for Codex" CTA so
    # it isn't shown to users who don't have Codex at all. Signal is the
    # per-user config dir Codex creates on first launch.
    codex_detected: bool = False


class InstallResponse(BaseModel):
    ok: bool
    staging_dir: str
    files: list[str]
    commands: list[str]
    auto_installed: bool = False
    codex_install_path: Optional[str] = None
    enabled: bool = False
    next_step: Optional[str] = None


class UninstallResponse(BaseModel):
    ok: bool


# --- Marketplace manifest ---------------------------------------------------

# Codex requires the marketplace manifest at
# ``<source>/.agents/plugins/marketplace.json`` (preferred) or
# ``<source>/.claude-plugin/marketplace.json`` (fallback). We use
# the Codex-native ``.agents/`` path so we never collide with the CC
# plugin's own marketplace tree.
def _build_marketplace_manifest() -> dict:
    return {
        "name": MARKETPLACE_SLUG,
        "interface": {
            "displayName": "SecureVector (local)",
        },
        "plugins": [
            {
                "name": PLUGIN_NAME,
                "source": {
                    "source": "local",
                    "path": f"./plugins/{PLUGIN_NAME}",
                },
                "policy": {
                    "installation": "AVAILABLE",
                    "authentication": "ON_INSTALL",
                },
                "category": "Security",
            }
        ],
    }


# --- Plugin version reader --------------------------------------------------


# Same conservative semver regex used by the CC route. Rejects path-
# traversal payloads like ``../etc`` so a malicious manifest cannot
# coerce us into writing outside the cache dir.
_VERSION_RE = re.compile(r"^[0-9]+(?:\.[0-9]+){0,3}(?:[-+][A-Za-z0-9.+-]+)?$")


def _read_staged_plugin_version() -> str:
    """Read the plugin's ``version`` from the staged plugin.json.

    Falls back to ``"0.0.0"`` if the file is missing or malformed so the
    install path resolves to *some* version directory. Anything failing
    the semver regex is rewritten to ``"0.0.0"`` and logged — defends
    against ``version: "../../etc"`` payloads.
    """
    import json
    pj = STAGING_DIR / "plugins" / PLUGIN_NAME / ".codex-plugin" / "plugin.json"
    try:
        data = json.loads(pj.read_text(encoding="utf-8"))
        v = data.get("version")
        if isinstance(v, str) and v and _VERSION_RE.match(v):
            return v
        if isinstance(v, str) and v:
            logger.warning(
                "plugin.json version %r failed semver validation; "
                "falling back to 0.0.0 to prevent path-traversal", v,
            )
    except (OSError, ValueError, KeyError):
        pass
    return "0.0.0"


# --- TOML config.toml manipulation -----------------------------------------
#
# Codex stores marketplace + plugin state in ``~/.codex/config.toml``.
# We can't rely on a third-party TOML writer (CLAUDE.md says no new
# dependencies). The simplest safe pattern is:
#
#   1. Read the file as text.
#   2. Strip any existing block whose header matches one of our two
#      sections — a section is the header line plus every line until the
#      next ``^[`` header or EOF.
#   3. Append our new sections at the end.
#
# This is loss-less for every OTHER section: comments, key order, blank
# lines, custom formatting all survive. Round-tripping through a real
# TOML parser would normalise the file and silently rewrite the user's
# preferred style.


_OUR_SECTION_HEADERS = (
    f"[marketplaces.{MARKETPLACE_SLUG}]",
    f'[plugins."{INSTALL_KEY}"]',
)

# Matches a real TOML section header line: optional leading whitespace,
# `[...]` content (rejects table-array `[[...]]` since none of ours use
# it), optional trailing whitespace + optional `#` comment. Anchored to
# both ends so values like `value = [1, 2, 3]` (which start with `[`
# but don't end with `]\s*$`) are NOT treated as headers — that was the
# pre-v4.4 termination bug.
_TOML_SECTION_HEADER_RE = re.compile(r"^\s*\[[^\[\]]+\]\s*(?:#.*)?$")


def _is_section_header(line: str) -> bool:
    """True iff ``line`` is the start of a real TOML table section."""
    return bool(_TOML_SECTION_HEADER_RE.match(line))


def _enter_multiline_string(line: str, in_ml: bool) -> bool:
    """Track whether we're inside a TOML triple-quoted multi-line string.

    Counts triple-quote (basic and literal) openers/closers on ``line``
    and XORs their parity with the inbound state. Conservative: any
    odd number of triple-quote toggles the state. Used so a literal
    ``[plugins."..."]`` appearing inside a multi-line value isn't
    mistaken for a real section header during the scan.
    """
    triples = line.count('\"\"\"') + line.count("\'\'\'")
    return in_ml if triples % 2 == 0 else not in_ml


def _strip_our_sections(text: str) -> str:
    """Remove every line of any section whose header matches ours.

    A section starts at one of our header lines and ends at the next
    real TOML table-section header or EOF. Triple-quoted multi-line
    strings are tracked so a header-shaped literal inside a value
    isn't misread as a section boundary. Leading / trailing blank
    lines around the removed block are swept so reinstalls don't
    accumulate gaps.

    The pre-v4.4 termination used ``startswith("[")`` which incorrectly
    ended the scan on TOML array values like ``ignore = [".git", ...]``
    on their own line — that could leave the tail of our prior section
    in the file. Fix in #131 review: only treat fully-bracketed lines
    matching the section-header regex as terminators.
    """
    lines = text.splitlines(keepends=False)
    out: list[str] = []
    i = 0
    n = len(lines)
    in_multiline = False
    while i < n:
        line = lines[i]
        # Inside a multi-line string we never act on the contents — both
        # header-match and header-terminator checks are paused until the
        # closing `"""` / `'''` toggles us back out.
        if in_multiline:
            out.append(line)
            in_multiline = _enter_multiline_string(line, in_multiline)
            i += 1
            continue
        stripped = line.strip()
        if stripped in _OUR_SECTION_HEADERS:
            # Drop this section: header + body until the next REAL
            # section header. Body lines that toggle multi-line state
            # are honoured so we don't break out mid-string.
            i += 1
            body_ml = False
            while i < n:
                body_line = lines[i]
                if body_ml:
                    body_ml = _enter_multiline_string(body_line, body_ml)
                    i += 1
                    continue
                if _is_section_header(body_line):
                    break
                body_ml = _enter_multiline_string(body_line, body_ml)
                i += 1
            # Eat trailing blank lines so we don't accumulate them.
            while out and out[-1].strip() == "":
                out.pop()
            continue
        out.append(line)
        in_multiline = _enter_multiline_string(line, in_multiline)
        i += 1
    # Re-join with a trailing newline — TOML files conventionally end
    # with one and ``str.splitlines`` strips it.
    return "\n".join(out).rstrip("\n") + "\n"


def _toml_string_escape(value: str) -> str:
    """Escape a string for a TOML basic-string literal.

    TOML basic strings are double-quoted and use C-style escapes for
    backslash, quote, and control chars. Codex's existing config.toml
    writes paths as basic strings, so we mirror that style.
    """
    out = []
    for ch in value:
        if ch == "\\":
            out.append("\\\\")
        elif ch == '"':
            out.append('\\"')
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\r":
            out.append("\\r")
        elif ch == "\t":
            out.append("\\t")
        elif ord(ch) < 0x20:
            out.append(f"\\u{ord(ch):04X}")
        else:
            out.append(ch)
    return '"' + "".join(out) + '"'


def _format_our_sections(staging_dir: Path, now_iso: str) -> str:
    """Render our two TOML sections as the text to append to config.toml."""
    return (
        "\n"
        f"[marketplaces.{MARKETPLACE_SLUG}]\n"
        f"last_updated = {_toml_string_escape(now_iso)}\n"
        f"source_type = \"local\"\n"
        f"source = {_toml_string_escape(str(staging_dir))}\n"
        "\n"
        f'[plugins."{INSTALL_KEY}"]\n'
        "enabled = true\n"
    )


def _atomic_write_text(path: Path, content: str) -> None:
    """Write text atomically with the same symlink + traversal guard the
    Claude Code route uses for JSON writes.

    Refuses to write outside ``~/.codex/`` or ``~/.securevector/`` so an
    attacker-controlled ``path`` argument can't be coerced into rewriting
    sensitive files. ``tempfile + os.replace`` keeps the on-disk
    representation crash-safe.
    """
    resolved_parent = path.parent.resolve(strict=False)
    home = Path.home().resolve(strict=False)
    codex_root = (home / ".codex").resolve(strict=False)
    sv_root = (home / ".securevector").resolve(strict=False)
    if not (
        resolved_parent.is_relative_to(codex_root)
        or resolved_parent.is_relative_to(sv_root)
    ):
        raise PermissionError(
            f"refusing to write outside allowed dirs (~/.codex or "
            f"~/.securevector): resolved {resolved_parent} (was {path})"
        )
    if path.is_symlink():
        raise PermissionError(
            f"refusing to write through symlink at {path} "
            f"(target was {os.readlink(path)})"
        )
    resolved_parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        prefix=path.name + ".", suffix=".tmp", dir=str(resolved_parent)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp_path, resolved_parent / path.name)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _read_codex_config_toml() -> str:
    """Return the current config.toml contents, or empty string."""
    if not CODEX_CONFIG_TOML.is_file():
        return ""
    try:
        return CODEX_CONFIG_TOML.read_text(encoding="utf-8")
    except OSError:
        return ""


def _register_in_config_toml(staging_dir: Path) -> None:
    """Add (or replace) our marketplace + plugin sections in config.toml.

    Idempotent: re-running while sections are already present strips the
    old block and appends a fresh one with the current timestamp.
    """
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )
    existing = _read_codex_config_toml()
    cleaned = _strip_our_sections(existing) if existing else ""
    # If the file was empty and the user has no other config, omit the
    # leading newline so we don't write a stray blank line at the top.
    new_section = _format_our_sections(staging_dir, now_iso)
    if cleaned.strip() == "":
        new_content = new_section.lstrip("\n")
    else:
        new_content = cleaned.rstrip("\n") + new_section
    _atomic_write_text(CODEX_CONFIG_TOML, new_content)


def _unregister_from_config_toml() -> bool:
    """Strip our two sections from config.toml. Idempotent.

    Returns True if anything was changed.
    """
    existing = _read_codex_config_toml()
    if not existing:
        return False
    cleaned = _strip_our_sections(existing)
    if cleaned == existing:
        return False
    # If stripping leaves an empty file (or only whitespace), delete it
    # entirely so a clean uninstall leaves no trace.
    if cleaned.strip() == "":
        try:
            CODEX_CONFIG_TOML.unlink()
            return True
        except OSError:
            logger.exception("Failed to remove empty config.toml")
            return False
    _atomic_write_text(CODEX_CONFIG_TOML, cleaned)
    return True


_ENABLED_TRUE_RE = re.compile(r"^\s*enabled\s*=\s*true\s*(?:#.*)?$")


def _is_enabled_in_config_toml() -> bool:
    """Whether ``[plugins."<key>"] enabled = true`` is set in config.toml.

    Walks the file line-by-line: locates our plugin header (skipping
    matches inside multi-line strings), then scans only the lines
    between that header and the next REAL section header for an
    ``enabled = true`` line. The earlier regex-based check used
    ``[^\\[]*?`` with ``re.DOTALL`` and had no negative-lookahead for
    the next header — a sibling section's `enabled = true` could
    produce a false positive. Replaced in #131 review.
    """
    text = _read_codex_config_toml()
    if not text:
        return False
    target_header = f'[plugins."{INSTALL_KEY}"]'
    lines = text.splitlines(keepends=False)
    n = len(lines)
    i = 0
    in_multiline = False
    while i < n:
        line = lines[i]
        if in_multiline:
            in_multiline = _enter_multiline_string(line, in_multiline)
            i += 1
            continue
        if line.strip() == target_header:
            # Scan body until next real section header or EOF.
            i += 1
            body_ml = False
            while i < n:
                body_line = lines[i]
                if body_ml:
                    body_ml = _enter_multiline_string(body_line, body_ml)
                    i += 1
                    continue
                if _is_section_header(body_line):
                    return False
                if _ENABLED_TRUE_RE.match(body_line):
                    return True
                body_ml = _enter_multiline_string(body_line, body_ml)
                i += 1
            return False
        in_multiline = _enter_multiline_string(line, in_multiline)
        i += 1
    return False


# --- Auto-install / uninstall ----------------------------------------------


def _codex_install_path(version: str) -> Path:
    """The cache dir Codex would store the plugin at after `codex plugin add`."""
    return CODEX_PLUGIN_CACHE_ROOT / MARKETPLACE_SLUG / PLUGIN_NAME / version


def _auto_install_to_codex_cache(version: str) -> Optional[Path]:
    """Copy the plugin into Codex's cache + register in config.toml.

    Returns the install path on success, ``None`` when ``~/.codex/`` is
    missing (user hasn't run Codex yet, or it's installed at a
    non-standard location — auto-install can't safely guess).

    Layout written:
      * ``~/.codex/plugins/cache/<slug>/<plugin>/<version>/`` — plugin
        files copied from the staged ``plugins/<plugin>/`` subtree.
        Atomic via ``copytree → os.replace`` so the loader never sees a
        half-populated version dir.
      * ``~/.codex/config.toml`` — adds the marketplace + plugin
        sections, preserving every other section verbatim.

    Side effects are committed step-by-step; on partial failure the
    cache copy is removed but the config.toml mutation is not unwound
    (we can't always tell what the prior state was). Acceptable because
    config.toml mutations are idempotent — a re-run heals.
    """
    if not CODEX_HOME.is_dir():
        logger.info(
            "Skipping Codex auto-install: %s does not exist (Codex likely "
            "not installed at the default location)", CODEX_HOME,
        )
        return None

    install_path = _codex_install_path(version)
    plugin_src = STAGING_DIR / "plugins" / PLUGIN_NAME
    if not plugin_src.is_dir():
        logger.error(
            "Cannot auto-install: staged plugin source missing at %s", plugin_src,
        )
        return None

    # 1. Copy the plugin tree into the cache. Two-step `tmp → os.replace`
    #    prevents Codex from seeing a half-populated dir mid-copy.
    tmp_install_path = install_path.parent / f"{install_path.name}.tmp"
    if tmp_install_path.exists():
        shutil.rmtree(tmp_install_path, ignore_errors=True)
    if install_path.exists():
        shutil.rmtree(install_path, ignore_errors=True)
    install_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(plugin_src, tmp_install_path)
    os.replace(str(tmp_install_path), str(install_path))

    # 2. Register in config.toml. Idempotent — re-running just refreshes
    #    the `last_updated` timestamp and re-asserts `enabled = true`.
    try:
        _register_in_config_toml(STAGING_DIR)
    except Exception:
        # Roll back the cache copy so we don't leave files without
        # config.toml registration. Best-effort: a failure here is
        # logged but the original exception propagates.
        try:
            shutil.rmtree(install_path, ignore_errors=True)
        except Exception:
            logger.exception("Cache rollback after config.toml failure failed")
        raise

    logger.info(
        "Auto-installed %s v%s into %s and registered marketplace %s in config.toml",
        PLUGIN_NAME, version, install_path, MARKETPLACE_SLUG,
    )
    return install_path


def _auto_uninstall_from_codex_cache() -> bool:
    """Reverse the two writes from auto-install. Each step is best-effort
    — failing to remove one shouldn't leave the other orphaned. Idempotent.

    Returns True if anything was changed.
    """
    touched = False

    # 1. Wipe the cache dir for our plugin across all versions. The
    #    ``<slug>/<plugin>/`` subtree contains only our plugin so it's
    #    safe to rmtree.
    plugin_cache_dir = CODEX_PLUGIN_CACHE_ROOT / MARKETPLACE_SLUG / PLUGIN_NAME
    if plugin_cache_dir.exists():
        shutil.rmtree(plugin_cache_dir, ignore_errors=True)
        touched = True
    # 1b. If the slug dir is now empty, remove it too (cosmetic).
    slug_dir = CODEX_PLUGIN_CACHE_ROOT / MARKETPLACE_SLUG
    if slug_dir.is_dir():
        try:
            slug_dir.rmdir()
        except OSError:
            pass

    # 2. Strip our sections from config.toml.
    try:
        if _unregister_from_config_toml():
            touched = True
    except Exception:
        logger.exception("Skipping config.toml strip during uninstall")

    if touched:
        logger.info("Auto-uninstalled %s from Codex config", PLUGIN_NAME)
    return touched


def _current_codex_install_path() -> Optional[Path]:
    """Return the currently-installed cache path for our plugin, or None.

    Scans the version subdirs under ``~/.codex/plugins/cache/<slug>/<plugin>/``
    and returns the highest-semver one that exists. Used by /status so
    the UI can show whether the user already auto-installed.
    """
    plugin_dir = CODEX_PLUGIN_CACHE_ROOT / MARKETPLACE_SLUG / PLUGIN_NAME
    if not plugin_dir.is_dir():
        return None
    versions: list[tuple[tuple, Path]] = []
    for child in plugin_dir.iterdir():
        if not child.is_dir():
            continue
        if not _VERSION_RE.match(child.name):
            continue
        # Lexicographic on the parsed version tuple — good enough for
        # ordering 4.3.0 < 4.4.0 etc; treats pre-release suffixes as
        # equal-prefix.
        parts = tuple(int(p) for p in re.split(r"[.\-+]", child.name) if p.isdigit())
        versions.append((parts, child))
    if not versions:
        return None
    versions.sort(reverse=True)
    return versions[0][1]


# --- Plugin tree staging ----------------------------------------------------


def _stage_plugin_tree(sv_url: str) -> list[str]:
    """Stage the plugin tree at ``STAGING_DIR``.

    Layout written:
      * ``<staging>/.agents/plugins/marketplace.json`` — marketplace manifest
      * ``<staging>/plugins/<plugin>/...`` — plugin files copied from the
        bundled source with the SV base URL substituted.

    Returns the list of plugin file paths (relative to the plugin root)
    that were successfully written.
    """
    import json

    # 1. Stage plugin files into <staging>/plugins/<plugin>/.
    plugin_staging = STAGING_DIR / "plugins" / PLUGIN_NAME
    files_written = _hooks_common.stage_files(
        staging_dir=plugin_staging,
        source_dir=BUNDLED_PLUGIN_DIR,
        files=PLUGIN_FILES,
        substitutions={
            "http://127.0.0.1:8741": sv_url,
            "http://localhost:8741": sv_url,
        },
    )

    # 2. Write marketplace.json under .agents/plugins/.
    marketplace_path = STAGING_DIR / ".agents" / "plugins" / "marketplace.json"
    marketplace_path.parent.mkdir(parents=True, exist_ok=True)
    marketplace_path.write_text(
        json.dumps(_build_marketplace_manifest(), indent=2) + "\n",
        encoding="utf-8",
    )

    return files_written


# --- Routes -----------------------------------------------------------------


@router.get("/status", response_model=StatusResponse)
async def plugin_status():
    """Return whether the plugin is staged + the list of present files.

    Read-only. Treats partial installs as not-installed (all-or-nothing
    from the user's perspective).
    """
    plugin_staging = STAGING_DIR / "plugins" / PLUGIN_NAME
    files_present = [
        f for f in PLUGIN_FILES if (plugin_staging / f).is_file()
    ]
    codex_path = _current_codex_install_path()
    # Codex creates ~/.codex/ on first launch. Either the dir itself or
    # the config.toml is sufficient evidence the host is installed.
    codex_detected = CODEX_HOME.is_dir() or CODEX_CONFIG_TOML.is_file()
    return StatusResponse(
        installed=len(files_present) == len(PLUGIN_FILES),
        staging_dir=str(STAGING_DIR),
        files_present=files_present,
        auto_installed=codex_path is not None,
        codex_install_path=str(codex_path) if codex_path else None,
        enabled=_is_enabled_in_config_toml(),
        codex_detected=codex_detected,
    )


@router.post("/install", response_model=InstallResponse)
async def install_plugin():
    """Stage the plugin tree + auto-install into ~/.codex if present.

    Idempotent — reinstalling overwrites the staged files and refreshes
    the config.toml entries. URL substitution keeps the staged hooks
    pointing at the current local-app URL even if the user changed
    their app port.
    """
    _hooks_common.ensure_bundled_dir(BUNDLED_PLUGIN_DIR, PLUGIN_FILES)
    sv_url = _hooks_common.resolve_sv_url()
    files_written = _stage_plugin_tree(sv_url)

    logger.info(
        "Staged %d Codex plugin file(s) for %s at %s (sv_url=%s)",
        len(files_written), PLUGIN_NAME, STAGING_DIR, sv_url,
    )

    # Auto-install into ~/.codex if Codex is present.
    version = _read_staged_plugin_version()
    install_path: Optional[Path]
    try:
        install_path = _auto_install_to_codex_cache(version)
    except Exception:
        logger.exception(
            "Auto-install to Codex cache failed; falling back to paste-in commands",
        )
        install_path = None

    if install_path is not None:
        return InstallResponse(
            ok=True,
            staging_dir=str(STAGING_DIR),
            files=files_written,
            commands=[],
            auto_installed=True,
            codex_install_path=str(install_path),
            enabled=_is_enabled_in_config_toml(),
            next_step=(
                "Start a new Codex session — the plugin loads on next launch. "
                "Codex will prompt you to trust SecureVector Guard hooks on first run."
            ),
        )

    return InstallResponse(
        ok=True,
        staging_dir=str(STAGING_DIR),
        files=files_written,
        commands=[
            f"codex plugin marketplace add {STAGING_DIR}",
            f"codex plugin add {INSTALL_KEY}",
        ],
        auto_installed=False,
        codex_install_path=None,
        enabled=False,
        next_step=None,
    )


@router.post("/uninstall", response_model=UninstallResponse)
async def uninstall_plugin():
    """Remove the staged plugin tree + Codex cache entry + config.toml
    sections. All steps are independently best-effort. Idempotent.
    """
    if STAGING_DIR.is_dir():
        shutil.rmtree(STAGING_DIR, ignore_errors=True)
        logger.info("Removed staged Codex plugin tree at %s", STAGING_DIR)
    try:
        _auto_uninstall_from_codex_cache()
    except Exception:
        logger.exception("Auto-uninstall from Codex cache failed")
    return UninstallResponse(ok=True)
