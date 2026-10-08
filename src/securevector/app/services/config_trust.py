"""Agent Config Trust: pin what the user approved, compare, say what moved.

Runs the read-only scanner (config_trust_scan) off the event loop, compares
the result with the stored pins and returns plain-words findings. Every pin,
change, approval and mod event goes into the tool-call audit chain with
hashes only (tool_id ``sv.config_trust``). Observe and flag only: nothing
here blocks a launch or a tool call.

MCP tool surfaces come without starting any server, in this order:
harness-reported (Cursor keeps descriptors on disk), relay-observed (MCP
calls seen in the audit log: names and argument keys), and the opt-in HTTP
``tools/list`` probe (config_trust_probe), logged in egress_audit. Stdio
servers are never started, so their descriptions stay unobserved unless the
harness itself keeps them.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import urllib.parse
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from securevector.app.database.repositories.config_trust import ConfigTrustRepository
from securevector.app.services import config_trust_scan as scanmod
from securevector.app.services.config_trust_scan import (
    HARNESS_LABELS,
    HARNESSES,
    NORMALISER_VERSION,
    RED_TYPES,
    ScopeScan,
    hash_canonical,
    workspace_id,
)

logger = logging.getLogger(__name__)

TOOL_ID = "sv.config_trust"
RECHECK_DEBOUNCE_SECONDS = 60
PROBE_INTERVAL_SECONDS = 600
MAX_REASONS = 3
MAX_RECHECK_TASKS = 20
RUNNING = ("starting", "working", "blocked", "idle")
_RUNTIME_TO_HARNESS = {"copilot": "copilot-cli"}
# The app's own port; the probe refuses it. Set by the routes from app state.
APP_PORT: Optional[int] = None


class StaleView(Exception):
    """The setup on disk moved after the user saw it; approve nothing."""

TYPE_WORDS = {
    "hooks": "Hooks", "mcp": "MCP servers", "permissions": "Permission settings",
    "plugins": "Mod settings", "rules": "Rules file", "other": "Other settings",
}

# Stat-gated recheck state, per (harness, workspace or "").
_last_sig: Dict[Tuple[str, str], str] = {}
_last_scan: Dict[Tuple[str, str], ScopeScan] = {}
_audit_cursor: Optional[int] = None
_status_cache: Tuple[float, Optional[dict]] = (0.0, None)


def h8(value: Optional[str]) -> str:
    return (value or "")[:8] or "none"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def harness_for(runtime_kind: Optional[str]) -> Optional[str]:
    rk = _RUNTIME_TO_HARNESS.get(runtime_kind or "", runtime_kind or "")
    return rk if rk in HARNESS_LABELS else None


async def _scan(harness: str, workspace: Optional[str]) -> ScopeScan:
    scan = await asyncio.to_thread(scanmod.scan_scope, harness, workspace)
    key = (harness, scan.workspace_hash)
    _last_scan[key] = scan
    _last_sig[key] = await asyncio.to_thread(scanmod.stat_signature, scan)
    return scan


async def _audit(db, function_name: str, harness: str, preview: str, session_id: Optional[str] = None) -> None:
    from securevector.app.database.repositories.custom_tools import CustomToolsRepository
    try:
        await CustomToolsRepository(db).log_tool_call_audit(
            TOOL_ID, function_name, "log_only", reason="Agent setup trust", args_preview=preview[:500],
            runtime_kind=harness, session_id=session_id,
        )
    except Exception:  # noqa: BLE001 - the audit write must never break a scan
        logger.debug("config trust audit write failed", exc_info=True)


# --- tool surface comparison ------------------------------------------------------


def _tools_hash(tools: Optional[list]) -> str:
    if not tools:
        return ""
    return hash_canonical([[t.get("name"), t.get("desc_hash"), t.get("schema_hash")] for t in tools])


def merge_relay_tools(current: Optional[list], seen: Dict[str, List[str]]) -> list:
    """Add relay-observed tools (name and argument keys, no description)."""
    by_name = {t["name"]: dict(t) for t in (current or [])}
    for name, keys in seen.items():
        t = by_name.get(name)
        if t is None:
            by_name[name] = {"name": name, "desc_hash": None, "schema_hash": None, "description": None,
                             "arg_keys": sorted(set(keys)), "source": "relay"}
        else:
            t["arg_keys"] = sorted(set(t.get("arg_keys") or []) | set(keys))
    return sorted(by_name.values(), key=lambda t: t["name"])


def compare_tools(server: str, pinned: Optional[list], current: Optional[list]) -> List[dict]:
    """Plain-words changes between an approved tool surface and the current one."""
    out: List[dict] = []
    if current is None:
        return out
    pin = {t["name"]: t for t in (pinned or [])}
    full_listing = any(t.get("source") in ("harness", "probe") for t in current)
    cur = {t["name"]: t for t in current}
    for name, t in sorted(cur.items()):
        p = pin.get(name)
        if p is None:
            out.append({"target": "server", "server": server, "tool": name, "state": "unknown", "severity": "red",
                        "text": f"Server {server} has a new tool {name}, not approved yet.",
                        "new_description": t.get("description"), "old": None, "new": t.get("desc_hash")})
            continue
        if p.get("desc_hash") and t.get("desc_hash") and p["desc_hash"] != t["desc_hash"]:
            out.append({"target": "server", "server": server, "tool": name, "state": "changed", "severity": "red",
                        "text": f"Server {server} changed the description of tool {name}.",
                        "old_description": p.get("description"), "new_description": t.get("description"),
                        "old": p["desc_hash"], "new": t["desc_hash"]})
        if p.get("schema_hash") and t.get("schema_hash") and p["schema_hash"] != t["schema_hash"]:
            out.append({"target": "server", "server": server, "tool": name, "state": "changed", "severity": "red",
                        "text": f"Server {server} changed the inputs of tool {name}.",
                        "old_keys": p.get("arg_keys") or [], "new_keys": t.get("arg_keys") or [],
                        "old": p["schema_hash"], "new": t["schema_hash"]})
    if full_listing:
        for name in sorted(set(pin) - set(cur)):
            out.append({"target": "server", "server": server, "tool": name, "state": "changed", "severity": "amber",
                        "text": f"Server {server} no longer offers tool {name}.",
                        "old": pin[name].get("desc_hash"), "new": None})
    return out


def _current_tools(srv: Optional[Any], row: Optional[dict]) -> Optional[list]:
    if srv is not None and srv.tools is not None:
        return srv.tools
    return (row or {}).get("observed")


def _server_hash(srv: Optional[Any], row: Optional[dict]) -> str:
    if srv is None:
        return "removed"
    return hash_canonical([srv.definition_hash, _tools_hash(_current_tools(srv, row))])


def _mod_hash(m: Any) -> str:
    return hash_canonical([m.manifest_hash, m.tree_hash])


def _target_hashes(scan: ScopeScan, rows: Dict[str, dict]) -> Dict[str, str]:
    """What each approvable item looks like right now. The client sends back
    the value it displayed, so Approve pins exactly what the user saw."""
    out = {f"surface:{s.key}": s.hash for s in scan.surfaces}
    out.update({f"server:{m.name}": _server_hash(m, rows.get(m.name)) for m in scan.servers})
    out.update({f"mod:{m.key}": _mod_hash(m) for m in scan.mods})
    return out


def _view_hash(targets: Dict[str, str], unparsed: List[str]) -> str:
    return hash_canonical([sorted(targets.items()), sorted(unparsed)])


def _change_target(c: dict) -> str:
    if c["target"] == "server":
        return f"server:{c['server']}"
    return f"{c['target']}:{c['key']}"


def _allow_secrets(srv: Any, row: Optional[dict]) -> bool:
    """Credentials ride along only for a user-scope server, or a project
    server whose exact definition the user already approved."""
    if srv.scope == "user":
        return True
    row = row or {}
    return bool(row.get("pinned_at")) and row.get("definition_hash") == srv.definition_hash


def _probe_on(srv: Optional[Any], row: Optional[dict]) -> bool:
    row = row or {}
    return bool(srv is not None and row.get("probe_opt_in")
                and row.get("probe_definition_hash") == srv.definition_hash)


# --- evaluate one scope ------------------------------------------------------------


async def evaluate(db, harness: str, workspace: Optional[str] = None, *, scan: Optional[ScopeScan] = None,
                   session_id: Optional[str] = None, audit: bool = True) -> dict:
    """Scan one harness scope and compare it with its pins.

    Writes only bookkeeping: silent re-pins after a normaliser upgrade, the
    mod inventory, and one audit row per newly seen change (deduplicated)."""
    repo = ConfigTrustRepository(db)
    if scan is None:
        scan = await _scan(harness, workspace)
    ws = scan.workspace_hash
    pins = await repo.pins(harness, scan.scope, ws)
    rows = await repo.servers(harness, scan.scope, ws)
    pinned = await repo.scope_pinned(harness, scan.scope, ws)
    changes: List[dict] = []

    # Normaliser upgrades re-pin silently, so a fix to the normaliser is never a finding.
    cur_by_key = {s.key: s for s in scan.surfaces}
    for key, pin in list(pins.items()):
        if pin["normaliser_version"] != NORMALISER_VERSION and key in cur_by_key:
            s = cur_by_key[key]
            await repo.set_pin(harness=harness, scope=scan.scope, workspace_hash=ws, workspace_name=scan.workspace_name,
                               surface=key, surface_type=s.type, path_hint=s.path_hint, hash=s.hash,
                               normaliser_version=NORMALISER_VERSION)
            pins[key] = {**pin, "hash": s.hash, "normaliser_version": NORMALISER_VERSION, "alerted_hash": None}

    # Mods (Claude Code user scope): inventory always, findings once pinned.
    mod_views = []
    if scan.mods or (harness == "claude-code" and scan.scope == "user"):
        known = await repo.mods()
        for m in scan.mods:
            prev = known.get(m.key)
            # Inventory events are deduplicated by the inventory row itself.
            if prev is None:
                await _audit(db, "mod.new", harness, f"surface=plugins scope=user mod={m.name} "
                             f"old=none new={h8(m.manifest_hash)}", session_id)
            elif (prev.get("manifest_hash"), prev.get("tree_hash")) != (m.manifest_hash, m.tree_hash):
                await _audit(db, "mod.changed", harness, f"surface=plugins scope=user mod={m.name} "
                             f"old={h8(prev.get('manifest_hash'))} new={h8(m.manifest_hash)}", session_id)
            await repo.upsert_mod(m, first_seen=(prev or {}).get("first_seen"))
            mkey = f"mod:{m.key}"
            mhash = hash_canonical([m.manifest_hash, m.tree_hash])
            pin = pins.get(mkey)
            state = "new"
            if pinned:
                if pin is None or pin.get("hash") is None:
                    state = "new"
                    changes.append({"target": "mod", "key": m.key, "state": "unknown", "severity": "red",
                                    "type": "plugins", "text": f"New mod {m.name}, not approved yet.",
                                    "old": None, "new": mhash})
                elif pin["hash"] != mhash:
                    state = "changed"
                    changes.append({"target": "mod", "key": m.key, "state": "changed", "severity": "red",
                                    "type": "plugins", "text": f"Mod {m.name} changed (manifest or files).",
                                    "old": pin["hash"], "new": mhash})
                else:
                    state = "pinned"
            mod_views.append({**asdict(m), "state": state})

    # Surfaces.
    if pinned:
        for s in scan.surfaces:
            pin = pins.get(s.key)
            old = pin.get("hash") if pin else None
            if old == s.hash:
                continue
            sev = "red" if s.type in RED_TYPES else "amber"
            word = TYPE_WORDS.get(s.type, "Settings")
            text = f"{word} changed in {s.path_hint}." if old else f"New {word.lower()} in {s.path_hint}."
            if s.type == "rules":
                text = f"Rules file {s.path_hint} changed." if old else f"Rules file {s.path_hint} is new."
            changes.append({"target": "surface", "key": s.key, "type": s.type, "state": "changed",
                            "severity": sev, "text": text, "old": old, "new": s.hash})
        for key, pin in pins.items():
            if key.startswith("mod:") or key in cur_by_key or pin.get("hash") is None:
                continue
            sev = "red" if pin["surface_type"] in RED_TYPES else "amber"
            word = TYPE_WORDS.get(pin["surface_type"], "Settings")
            changes.append({"target": "surface", "key": key, "type": pin["surface_type"], "state": "changed",
                            "severity": sev, "text": f"{word} removed from {pin.get('path_hint') or key}.",
                            "old": pin["hash"], "new": None})

    # MCP servers: one group per server.
    server_views = []
    by_name = {s.name: s for s in scan.servers}
    for name in sorted(set(by_name) | {n for n, r in rows.items() if r.get("pinned_at") and r.get("definition_hash")}):
        srv = by_name.get(name)
        row = rows.get(name)
        current_tools = _current_tools(srv, row)
        state = "new"
        srv_changes: List[dict] = []
        if pinned:
            if srv is None:
                srv_changes.append({"target": "server", "server": name, "state": "changed", "severity": "amber",
                                    "type": "mcp", "text": f"MCP server {name} was removed.",
                                    "old": row.get("definition_hash"), "new": None})
                state = "changed"
            elif row is None or not row.get("pinned_at") or not row.get("definition_hash"):
                srv_changes.append({"target": "server", "server": name, "state": "unknown", "severity": "red",
                                    "type": "mcp", "text": f"New MCP server {name} ({srv.transport}), not approved yet.",
                                    "old": None, "new": srv.definition_hash})
                state = "unknown"
            else:
                if row["definition_hash"] != srv.definition_hash:
                    srv_changes.append({"target": "server", "server": name, "state": "changed", "severity": "red",
                                        "type": "mcp",
                                        "text": f"MCP server {name} changed how it starts (command, arguments, address or key names).",
                                        "old": row["definition_hash"], "new": srv.definition_hash})
                srv_changes.extend(dict(c, type="mcp") for c in compare_tools(name, row.get("tools"), current_tools))
                state = "changed" if srv_changes else "pinned"
        tool_states = {c.get("tool"): c["state"] for c in srv_changes if c.get("tool")}
        tools_view = [{"name": t["name"], "state": tool_states.get(t["name"], "pinned" if state != "new" else "new"),
                       "description": "observed" if t.get("desc_hash") else "unobserved", "source": t.get("source")}
                      for t in (current_tools or [])]
        server_views.append({
            "name": name, "scope": scan.scope, "transport": srv.transport if srv else None,
            "source_hint": srv.source_hint if srv else None, "state": state, "tools": tools_view,
            "descriptions": "observed" if any(t.get("desc_hash") for t in (current_tools or [])) else "unobserved",
            "probe_opt_in": _probe_on(srv, row), "probe_allowed": bool(srv and srv.transport == "http"),
            "probed_at": (row or {}).get("probed_at"),
            "probe_host": (urllib.parse.urlparse(srv.url).netloc if srv and srv.url else None),
            "probe_header_names": (sorted(scanmod.probe_headers_for(srv, _allow_secrets(srv, row)))
                                   if srv and srv.transport == "http" else []),
            "current": _server_hash(srv, row),
            "env_keys": srv.env_keys if srv else [], "header_keys": srv.header_keys if srv else [],
        })
        changes.extend(srv_changes)
        # Dedupe the drift audit per server on the combined current hash.
        if pinned and srv_changes and audit:
            combo = hash_canonical([srv.definition_hash if srv else None, _tools_hash(current_tools)])
            await repo.ensure_server_row(harness, scan.scope, ws, name)
            fresh = (await repo.servers(harness, scan.scope, ws)).get(name) or {}
            if fresh.get("alerted_hash") != combo:
                first = srv_changes[0]
                tool = f" tool={first['tool']}" if first.get("tool") else ""
                await _audit(db, "mcp.drift", harness, f"surface=mcp scope={scan.scope} server={name}{tool} "
                             f"old={h8(first.get('old'))} new={h8(first.get('new'))}", session_id)
                await repo.mark_alerted("mcp_pins", fresh["id"], combo)

    # Surface and mod change audits, deduplicated on the alerted hash.
    if pinned and audit:
        for c in changes:
            if c["target"] not in ("surface", "mod"):
                continue
            key = c["key"] if c["target"] == "surface" else f"mod:{c['key']}"
            pin = pins.get(key)
            if pin is None:
                s = cur_by_key.get(key)
                await repo.set_pin(harness=harness, scope=scan.scope, workspace_hash=ws,
                                   workspace_name=scan.workspace_name, surface=key,
                                   surface_type=(s.type if s else "plugins"), path_hint=(s.path_hint if s else key),
                                   hash=None, normaliser_version=NORMALISER_VERSION)
                pin = (await repo.pins(harness, scan.scope, ws)).get(key)
            marker = c.get("new") or "removed"
            if pin and pin.get("alerted_hash") != marker:
                if c["target"] == "surface":
                    await _audit(db, "config.changed", harness, f"surface={c['type']} scope={scan.scope} "
                                 f"old={h8(c.get('old'))} new={h8(c.get('new'))}", session_id)
                await repo.mark_alerted("config_pins", pin["id"], marker)

    if not scan.surfaces and not scan.servers and not scan.mods:
        state = "none"
    elif not pinned:
        state = "new"
    elif changes:
        state = "changed"
    else:
        state = "pinned"
    if scan.unparsed and state in ("pinned", "none"):
        state = "unparsed"
    targets = _target_hashes(scan, rows)
    for c in changes:
        c["current"] = targets.get(_change_target(c), "removed")
    order = {"red": 0, "amber": 1}
    changes.sort(key=lambda c: order.get(c["severity"], 2))
    return {
        "view_hash": _view_hash(targets, scan.unparsed), "unparsed": list(scan.unparsed),
        "harness": harness, "label": HARNESS_LABELS[harness], "scope": scan.scope,
        "workspace_name": scan.workspace_name, "workspace_hash": ws, "present": scan.present,
        "state": state, "setup_hash": scan.setup_hash,
        "counts": {
            "mcp_servers": len(scan.servers),
            "hooks": sum(s.count or 1 for s in scan.surfaces if s.type == "hooks"),
            "rules": sum(1 for s in scan.surfaces if s.type == "rules"),
            "mods": len(scan.mods),
            "surfaces": len(scan.surfaces),
        },
        "risks": sorted([asdict(r) for r in scan.risks], key=lambda r: order.get(r["severity"], 2)),
        "surfaces": [{"key": s.key, "type": s.type, "path_hint": s.path_hint, "partial": s.partial,
                      "current": s.hash,
                      "state": ("new" if not pinned else "changed" if any(c.get("key") == s.key for c in changes)
                                else "pinned")} for s in scan.surfaces],
        "servers": server_views, "mods": mod_views, "posture": scan.posture,
        "changes": changes,
    }


# --- approve ------------------------------------------------------------------------


async def approve(db, harness: str, workspace: Optional[str] = None, *, target: str = "setup",
                  key: Optional[str] = None, session_id: Optional[str] = None,
                  expected: Optional[str] = None) -> dict:
    """Re-pin the named surface, one server, one mod, or the whole setup of
    one harness scope. Writes one audit row per pinned item, hashes only."""
    if harness not in HARNESS_LABELS:
        raise ValueError("unknown harness")
    if target not in ("setup", "surface", "server", "mod"):
        raise ValueError("unknown target")
    repo = ConfigTrustRepository(db)
    scan = await _scan(harness, workspace)
    ws, scope = scan.workspace_hash, scan.scope
    first = not await repo.scope_pinned(harness, scope, ws)
    pins = await repo.pins(harness, scope, ws)
    rows = await repo.servers(harness, scope, ws)
    pinned_items = 0
    if expected is not None:
        targets = _target_hashes(scan, rows)
        now = (_view_hash(targets, scan.unparsed) if target == "setup"
               else targets.get(f"{target}:{key}", "removed"))
        if now != expected:
            raise StaleView("The setup changed after it was shown. Review the current changes and approve again.")

    async def pin_surface(key: str, s) -> None:
        nonlocal pinned_items
        old = (pins.get(key) or {}).get("hash")
        if s is None:
            await repo.delete_pin(harness, scope, ws, key)
        else:
            await repo.set_pin(harness=harness, scope=scope, workspace_hash=ws, workspace_name=scan.workspace_name,
                               surface=key, surface_type=s.type, path_hint=s.path_hint, hash=s.hash,
                               normaliser_version=NORMALISER_VERSION)
        fn = "config.pin" if first else "config.approved"
        stype = s.type if s is not None else (pins.get(key) or {}).get("surface_type", "other")
        await _audit(db, fn, harness, f"surface={stype} scope={scope} old={h8(old)} new={h8(s.hash if s else None)}",
                     session_id)
        pinned_items += 1

    async def pin_server(name: str) -> None:
        nonlocal pinned_items
        srv = next((x for x in scan.servers if x.name == name), None)
        row = rows.get(name) or {}
        # One hash over the definition and the tool surface, before and after.
        old = (hash_canonical([row.get("definition_hash"), _tools_hash(row.get("tools"))])
               if row.get("definition_hash") else None)
        if srv is None:
            await repo.delete_server(harness, scope, ws, name)
            new = None
        else:
            tools = _current_tools(srv, row)
            await repo.pin_server(harness=harness, scope=scope, workspace_hash=ws, server=name,
                                  definition_hash=srv.definition_hash, tools=tools,
                                  source=(tools[0].get("source") if tools else None))
            new = hash_canonical([srv.definition_hash, _tools_hash(tools)])
        fn = "mcp.pin" if first or not row.get("pinned_at") else "config.approved"
        await _audit(db, fn, harness, f"surface=mcp scope={scope} server={name} old={h8(old)} new={h8(new)}",
                     session_id)
        pinned_items += 1

    async def pin_mod(mkey: str) -> None:
        nonlocal pinned_items
        m = next((x for x in scan.mods if x.key == mkey), None)
        pkey = f"mod:{mkey}"
        old = (pins.get(pkey) or {}).get("hash")
        if m is None:
            await repo.delete_pin(harness, scope, ws, pkey)
            new = None
        else:
            new = hash_canonical([m.manifest_hash, m.tree_hash])
            await repo.set_pin(harness=harness, scope=scope, workspace_hash=ws, workspace_name=scan.workspace_name,
                               surface=pkey, surface_type="plugins", path_hint=f"mod {m.name}", hash=new,
                               normaliser_version=NORMALISER_VERSION)
        await _audit(db, "config.pin" if first else "config.approved", harness,
                     f"surface=plugins scope={scope} mod={mkey.split('@')[0]} old={h8(old)} new={h8(new)}", session_id)
        pinned_items += 1

    cur = {s.key: s for s in scan.surfaces}
    if target == "setup":
        for k, s in cur.items():
            if (pins.get(k) or {}).get("hash") != s.hash:
                await pin_surface(k, s)
        for k, p in pins.items():
            if not k.startswith("mod:") and k not in cur:
                await pin_surface(k, None)
        for name in sorted({s.name for s in scan.servers} | {n for n, r in rows.items() if r.get("pinned_at")}):
            await pin_server(name)
        for m in scan.mods:
            await pin_mod(m.key)
        if first and pinned_items == 0:
            # An empty setup is still a decision: pin its absence.
            await repo.set_pin(harness=harness, scope=scope, workspace_hash=ws, workspace_name=scan.workspace_name,
                               surface="#empty", surface_type="other", path_hint="", hash=None,
                               normaliser_version=NORMALISER_VERSION)
    elif target == "surface":
        if not key or (key not in cur and key not in pins):
            raise ValueError("unknown surface")
        await pin_surface(key, cur.get(key))
    elif target == "server":
        if not key:
            raise ValueError("unknown server")
        await pin_server(key)
    else:
        if not key:
            raise ValueError("unknown mod")
        await pin_mod(key)
    _invalidate_status()
    return await evaluate(db, harness, workspace, scan=scan, session_id=session_id, audit=False)


# --- repo trust check and session checks ------------------------------------------------


def _verdict(view: dict) -> dict:
    """Folder verdict for the launch dialog: state plus the top three reasons."""
    reasons = [{"severity": r["severity"], "text": r["text"]} for r in view["risks"]]
    reasons += [{"severity": c["severity"], "text": c["text"]} for c in view["changes"]]
    reasons.sort(key=lambda r: 0 if r["severity"] == "red" else 1)
    state = {"pinned": "trusted"}.get(view["state"], view["state"])
    if view.get("unparsed") and state in ("trusted", "none", "new"):
        state = "unparsed"
    return {
        "harness": view["harness"], "label": view["label"], "workspace_name": view["workspace_name"],
        "state": state, "reasons": reasons[:MAX_REASONS], "reasons_total": len(reasons),
        "warnings": sum(1 for r in reasons if r["severity"] == "red"),
        "counts": view["counts"], "view_hash": view.get("view_hash"),
    }


def _unparsed_verdict(harness: str, workspace: Optional[str]) -> dict:
    _h, name = workspace_id(workspace)
    return {"harness": harness, "label": HARNESS_LABELS.get(harness, harness), "workspace_name": name,
            "state": "unparsed", "reasons": [{"severity": "red", "text": "Could not check this folder's agent config."}],
            "reasons_total": 1, "warnings": 1, "counts": {}, "view_hash": None}


async def repo_check(db, harness: str, workspace: str, session_id: Optional[str] = None) -> dict:
    """Folder verdict. Fails closed in words: any error reads as "could not
    check", never as a missing verdict."""
    try:
        view = await evaluate(db, harness, workspace, session_id=session_id)
    except Exception:  # noqa: BLE001 - a failed scan still produces a verdict
        logger.warning("config trust: folder check failed", exc_info=True)
        return _unparsed_verdict(harness, workspace)
    return _verdict(view)


def _slim(changes: List[dict]) -> List[dict]:
    keep = ("target", "key", "server", "tool", "type", "state", "severity", "text", "old", "new")
    return [{k: c[k] for k in keep if k in c} for c in changes]


async def session_check(db, *, harness: str, workspace: Optional[str], phase: str,
                        task_id: Optional[str] = None, session_id: Optional[str] = None) -> Optional[dict]:
    """One check for a session (start, mid, exit): user and project scope."""
    harness = harness_for(harness) or harness
    if harness not in HARNESS_LABELS:
        return None
    user = await evaluate(db, harness, None, session_id=session_id)
    proj = await evaluate(db, harness, workspace, session_id=session_id) if workspace else None
    changes = user["changes"] + (proj["changes"] if proj else [])
    states = [user["state"]] + ([proj["state"]] if proj else [])
    state = "changed" if "changed" in states else "new" if "new" in states else "pinned"
    setup_hash = hash_canonical([user["setup_hash"], proj["setup_hash"] if proj else None])
    await ConfigTrustRepository(db).add_check(
        session_id=session_id, task_id=task_id, harness=harness,
        workspace_hash=(proj or {}).get("workspace_hash", ""), phase=phase, setup_hash=setup_hash,
        state=state, diff=_slim(changes),
    )
    return {"state": state, "changes": changes, "setup_hash": setup_hash,
            "verdict": _verdict(proj) if proj else None}


async def session_summary(db, task_id: Optional[str], session_id: Optional[str] = None) -> dict:
    """The Setup row for the session summary, in plain words."""
    checks = await ConfigTrustRepository(db).checks_for(task_id, session_id)
    if not checks:
        return {"state": "unchecked", "text": "Setup not checked for this session.", "changes": []}
    first, last = checks[0], checks[-1]
    moved = first["setup_hash"] != last["setup_hash"]
    changes = [{k: c.get(k) for k in ("severity", "text", "target", "key", "server", "tool")} for c in last["diff"]]
    if not moved and last["state"] == "pinned":
        text = "Setup unchanged during this session."
    elif not moved and last["state"] == "new":
        text = "Setup unchanged during this session (not approved yet)."
    elif not moved:
        text = f"Setup unchanged during this session; {len(changes)} unapproved change(s) from before it started."
    else:
        text = f"Setup changed during this session ({len(changes)})."
    return {"state": "changed" if moved else last["state"], "moved": moved, "text": text, "changes": changes,
            "checks": len(checks), "last_phase": last["phase"], "harness": last["harness"]}


# --- status for the setup scan card --------------------------------------------------------


def _invalidate_status() -> None:
    global _status_cache
    _status_cache = (0.0, None)


async def status(db, *, fresh: bool = False, max_age: float = 60.0) -> dict:
    """Every harness at user scope, for "Your agent setup"."""
    global _status_cache
    at, cached = _status_cache
    if cached is not None and not fresh and time.monotonic() - at < max_age:
        return cached
    harnesses = []
    for h in HARNESSES:
        try:
            view = await evaluate(db, h, None)
        except Exception:  # noqa: BLE001 - one unreadable harness must not hide the others
            logger.debug("config trust scan failed for %s", h, exc_info=True)
            continue
        if not view["present"]:
            continue
        harnesses.append(view)
    risky = sum(1 for v in harnesses for r in v["risks"] if r["severity"] == "red")
    out = {
        "harnesses": harnesses,
        "totals": {
            "harnesses": len(harnesses),
            "mcp_servers": sum(v["counts"]["mcp_servers"] for v in harnesses),
            "hooks": sum(v["counts"]["hooks"] for v in harnesses),
            "rules": sum(v["counts"]["rules"] for v in harnesses),
            "mods": sum(v["counts"]["mods"] for v in harnesses),
            "risky": risky,
            "changed": sum(len(v["changes"]) for v in harnesses),
            "unapproved": sum(1 for v in harnesses if v["state"] == "new"),
        },
        "checked_at": _now(),
    }
    _status_cache = (time.monotonic(), out)
    return out


# --- relay-observed tools and the probe --------------------------------------------------


def parse_mcp_name(function_name: str, tool_id: str = "") -> Optional[Tuple[str, str]]:
    name = function_name or ""
    if name.startswith("mcp__"):
        rest = name[5:]
        server, sep, tool = rest.partition("__")
        if sep and server and tool:
            return server, tool
    if ":" in (tool_id or "") and not tool_id.startswith("sv."):
        server, _, tool = tool_id.partition(":")
        if server and tool:
            return server, tool
    return None


def _arg_keys(preview: Optional[str]) -> List[str]:
    try:
        data = json.loads(preview or "")
    except ValueError:
        return []
    return sorted(str(k) for k in data)[:50] if isinstance(data, dict) else []


async def observe_relay(db, rows: List[dict]) -> int:
    """Fold MCP calls seen through the hooks into each configured server's
    observed surface. A tool not on the pinned surface surfaces as unknown."""
    seen: Dict[Tuple[str, str], Dict[str, List[str]]] = {}
    for r in rows:
        harness = harness_for(r.get("runtime_kind"))
        parsed = parse_mcp_name(r.get("function_name") or "", r.get("tool_id") or "")
        if not harness or not parsed:
            continue
        server, tool = parsed
        seen.setdefault((harness, server), {}).setdefault(tool, []).extend(_arg_keys(r.get("args_preview")))
    repo = ConfigTrustRepository(db)
    updated = 0
    for (harness, server), tools in seen.items():
        for row in await repo.servers_by_name(harness, server):
            observed = json.loads(row["observed_json"]) if row.get("observed_json") else None
            merged = merge_relay_tools(observed, tools)
            await repo.set_observed(harness, row["scope"], row["workspace_hash"], server, merged, "relay")
            updated += 1
        if not await repo.servers_by_name(harness, server):
            # Not configured at a scope we have seen yet: keep it at user scope.
            await repo.set_observed(harness, "user", "", server, merge_relay_tools(None, tools), "relay")
            updated += 1
    return updated


async def probe(db, harness: str, server: str, workspace: Optional[str] = None) -> dict:
    """Run the opt-in read-only tools/list probe for one HTTP server."""
    from securevector.app.database.repositories.egress import EgressRepository
    from securevector.app.services.config_trust_probe import ProbeError, probe_tools

    repo = ConfigTrustRepository(db)
    scan = await _scan(harness, workspace)
    srv = next((s for s in scan.servers if s.name == server), None)
    if srv is None:
        raise ValueError("unknown server")
    if srv.transport != "http" or not srv.url:
        raise ValueError("Only HTTP servers can be probed. Stdio servers are never started.")
    row = (await repo.servers(harness, scan.scope, scan.workspace_hash)).get(server) or {}
    if not row.get("probe_opt_in"):
        raise PermissionError("The probe is off for this server.")
    if not _probe_on(srv, row):
        raise PermissionError("This server's definition changed since the probe was turned on. Turn it on again.")
    parsed = urllib.parse.urlparse(srv.url)
    headers = scanmod.probe_headers_for(srv, _allow_secrets(srv, row))
    error = None
    tools: List[dict] = []
    try:
        tools = await asyncio.to_thread(probe_tools, srv.url, headers, APP_PORT)
    except ProbeError as exc:
        error = str(exc)
    try:
        await EgressRepository(db).record(
            host=parsed.hostname or "", port=parsed.port, scheme=parsed.scheme, operation="read", kind="mcp",
            action="observed", detector="config_trust_probe", confidence="HIGH", tool_name="tools/list",
            runtime_kind=harness, reason="Setup trust: read-only tools/list probe, opted in for this server"
            + (f" ({error})" if error else ""),
        )
    except Exception:  # noqa: BLE001 - the probe result still stands
        logger.debug("egress record for the probe failed", exc_info=True)
    if error:
        return {"ok": False, "error": error}
    await repo.set_observed(harness, scan.scope, scan.workspace_hash, server, tools, "probe", probed=True)
    _invalidate_status()
    return {"ok": True, "tools": len(tools)}


# --- background recheck (warm loop, every 60 s) ------------------------------------------


def _changed_since(key: Tuple[str, str]) -> bool:
    scan = _last_scan.get(key)
    if scan is None:
        return True
    sig = scanmod.stat_signature(scan)
    if sig == _last_sig.get(key):
        return False
    # Debounce: let an editor finish writing before re-hashing.
    if time.time() - scanmod.newest_mtime(scan) < RECHECK_DEBOUNCE_SECONDS:
        return False
    return True


async def recheck_once(db) -> dict:
    """Stat-gated recheck: re-hash only when an mtime or size moved."""
    global _audit_cursor
    done = {"tasks": 0, "user": 0, "probes": 0, "relay": 0}
    # Relay-observed MCP tools and Guard session starts since the last pass.
    try:
        if _audit_cursor is None:
            row = await db.fetch_one("SELECT MAX(id) AS m FROM tool_call_audit")
            _audit_cursor = max(0, int((row or {})["m"] or 0) - 5000) if row else 0
        rows = await db.fetch_all(
            "SELECT id, tool_id, function_name, runtime_kind, session_id, args_preview FROM tool_call_audit "
            "WHERE id > ? AND (function_name LIKE 'mcp\\_\\_%' ESCAPE '\\' OR tool_id LIKE '%:%' "
            "OR function_name = '__session_start__') ORDER BY id ASC LIMIT 5000",
            (_audit_cursor,),
        )
        rows = [dict(r) for r in rows]
        if rows:
            _audit_cursor = rows[-1]["id"]
            done["relay"] = await observe_relay(db, [r for r in rows if r["function_name"] != "__session_start__"])
            for r in rows:
                if r["function_name"] != "__session_start__" or not r.get("session_id"):
                    continue
                from securevector.app.terminals.store import cwd_from_preview
                cwd = cwd_from_preview(r.get("args_preview"))
                harness = harness_for(r.get("runtime_kind"))
                if harness:
                    try:
                        await session_check(db, harness=harness, workspace=cwd, phase="start",
                                            session_id=r["session_id"])
                    except Exception:  # noqa: BLE001 - one bad folder must not stop the pass
                        logger.debug("config trust session check failed", exc_info=True)
    except Exception:  # noqa: BLE001
        logger.debug("config trust relay pass failed", exc_info=True)

    # Running tasks: mid-session recheck.
    try:
        tasks = await db.fetch_all(
            "SELECT id, executor_id, workspace, session_id FROM terminal_tasks WHERE status IN "
            "('starting','working','blocked','idle') ORDER BY created_at DESC LIMIT ?",
            (MAX_RECHECK_TASKS,),
        )
    except Exception:  # noqa: BLE001 - terminals tables missing on an odd schema
        tasks = []
    for t in tasks:
        t = dict(t)
        harness = harness_for(t.get("executor_id"))
        if not harness:
            continue
        ws_hash, _ = workspace_id(t.get("workspace"))
        keys = [(harness, ""), (harness, ws_hash)]
        moved = False
        for k in keys:
            moved = moved or await asyncio.to_thread(_changed_since, k)
        if not moved:
            continue
        try:
            await session_check(db, harness=harness, workspace=t.get("workspace"), phase="mid",
                                task_id=t["id"], session_id=t.get("session_id"))
            done["tasks"] += 1
        except Exception:  # noqa: BLE001 - one bad folder must not skip user scope and probes
            logger.debug("config trust mid-session check failed", exc_info=True)

    # User scope across sessions, and the opted-in probes that are due.
    for h in HARNESSES:
        if (h, "") in _last_scan and not await asyncio.to_thread(_changed_since, (h, "")):
            continue
        try:
            await evaluate(db, h, None)
            done["user"] += 1
        except Exception:  # noqa: BLE001
            logger.debug("config trust user recheck failed for %s", h, exc_info=True)
    for row in await ConfigTrustRepository(db).probe_targets():
        if row["scope"] != "user":
            continue
        last = row.get("probed_at")
        if last:
            try:
                age = (datetime.now(timezone.utc) - datetime.fromisoformat(last)).total_seconds()
            except ValueError:
                age = PROBE_INTERVAL_SECONDS
            if age < PROBE_INTERVAL_SECONDS:
                continue
        try:
            await probe(db, row["harness"], row["server"])
            done["probes"] += 1
        except Exception:  # noqa: BLE001
            logger.debug("config trust probe failed", exc_info=True)
    if any(done.values()):
        _invalidate_status()
    return done


def schedule(coro) -> None:
    """Fire and forget from a hot path (spawn, hook relay); never raises."""
    try:
        task = asyncio.get_running_loop().create_task(coro)
        task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
    except RuntimeError:
        coro.close()
