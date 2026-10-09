"""Reads and writes for Agent Config Trust.

Four tables (migration v57): `config_pins` (one approved hash per surface),
`config_checks` (one row per session check), `mcp_pins` (per server: the
approved definition hash and tool surface, plus the latest observed one) and
`mod_inventory`. Hashes, key names, counts and basenames only; the one
exception is tool description text in `mcp_pins`, kept locally for the
approval diff.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from securevector.app.database.connection import DatabaseConnection


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ConfigTrustRepository:
    def __init__(self, db: DatabaseConnection):
        self.db = db

    # --- surface pins ----------------------------------------------------------

    async def pins(self, harness: str, scope: str, workspace_hash: str = "") -> Dict[str, dict]:
        rows = await self.db.fetch_all(
            "SELECT * FROM config_pins WHERE harness = ? AND scope = ? AND workspace_hash = ?",
            (harness, scope, workspace_hash),
        )
        return {r["surface"]: dict(r) for r in rows}

    async def set_pin(self, *, harness: str, scope: str, workspace_hash: str, workspace_name: str,
                      surface: str, surface_type: str, path_hint: str, hash: Optional[str],
                      normaliser_version: int) -> None:
        conn = await self.db.connect()
        await conn.execute(
            """
            INSERT INTO config_pins (harness, scope, workspace_hash, workspace_name, surface, surface_type,
                                     path_hint, hash, normaliser_version, alerted_hash, pinned_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
            ON CONFLICT (harness, scope, workspace_hash, surface) DO UPDATE SET
                hash = excluded.hash, surface_type = excluded.surface_type, path_hint = excluded.path_hint,
                normaliser_version = excluded.normaliser_version, workspace_name = excluded.workspace_name,
                alerted_hash = NULL, pinned_at = excluded.pinned_at
            """,
            (harness, scope, workspace_hash, workspace_name, surface, surface_type, path_hint, hash,
             normaliser_version, _now()),
        )
        await conn.commit()

    async def delete_pin(self, harness: str, scope: str, workspace_hash: str, surface: str) -> None:
        conn = await self.db.connect()
        await conn.execute(
            "DELETE FROM config_pins WHERE harness = ? AND scope = ? AND workspace_hash = ? AND surface = ?",
            (harness, scope, workspace_hash, surface),
        )
        await conn.commit()

    async def mark_alerted(self, table: str, row_id: int, value: Optional[str]) -> None:
        if table not in ("config_pins", "mcp_pins"):
            raise ValueError(table)
        conn = await self.db.connect()
        await conn.execute(f"UPDATE {table} SET alerted_hash = ? WHERE id = ?", (value, row_id))
        await conn.commit()

    async def scope_pinned(self, harness: str, scope: str, workspace_hash: str = "") -> bool:
        row = await self.db.fetch_one(
            "SELECT 1 FROM config_pins WHERE harness = ? AND scope = ? AND workspace_hash = ? "
            "UNION SELECT 1 FROM mcp_pins WHERE harness = ? AND scope = ? AND workspace_hash = ? "
            "AND pinned_at IS NOT NULL LIMIT 1",
            (harness, scope, workspace_hash, harness, scope, workspace_hash),
        )
        return row is not None

    # --- MCP pins --------------------------------------------------------------

    async def servers(self, harness: str, scope: str, workspace_hash: str = "") -> Dict[str, dict]:
        rows = await self.db.fetch_all(
            "SELECT * FROM mcp_pins WHERE harness = ? AND scope = ? AND workspace_hash = ?",
            (harness, scope, workspace_hash),
        )
        out = {}
        for r in rows:
            d = dict(r)
            d["tools"] = json.loads(d["tools_json"]) if d.get("tools_json") else None
            d["observed"] = json.loads(d["observed_json"]) if d.get("observed_json") else None
            out[d["server"]] = d
        return out

    async def servers_by_name(self, harness: str, server: str) -> List[dict]:
        rows = await self.db.fetch_all(
            "SELECT * FROM mcp_pins WHERE harness = ? AND server = ?", (harness, server))
        return [dict(r) for r in rows]

    async def pin_server(self, *, harness: str, scope: str, workspace_hash: str, server: str,
                         definition_hash: Optional[str], tools: Optional[list], source: Optional[str]) -> None:
        conn = await self.db.connect()
        await conn.execute(
            """
            INSERT INTO mcp_pins (harness, server, scope, workspace_hash, definition_hash, tools_json,
                                  source, state, alerted_hash, pinned_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pinned', NULL, ?)
            ON CONFLICT (harness, scope, workspace_hash, server) DO UPDATE SET
                definition_hash = excluded.definition_hash, tools_json = excluded.tools_json,
                source = excluded.source, state = 'pinned', alerted_hash = NULL, pinned_at = excluded.pinned_at
            """,
            (harness, server, scope, workspace_hash, definition_hash,
             json.dumps(tools) if tools is not None else None, source, _now()),
        )
        await conn.commit()

    async def ensure_server_row(self, harness: str, scope: str, workspace_hash: str, server: str) -> None:
        conn = await self.db.connect()
        await conn.execute(
            "INSERT OR IGNORE INTO mcp_pins (harness, server, scope, workspace_hash, state) "
            "VALUES (?, ?, ?, ?, 'unpinned')",
            (harness, server, scope, workspace_hash),
        )
        await conn.commit()

    async def set_observed(self, harness: str, scope: str, workspace_hash: str, server: str,
                           tools: list, source: str, probed: bool = False) -> None:
        await self.ensure_server_row(harness, scope, workspace_hash, server)
        conn = await self.db.connect()
        await conn.execute(
            "UPDATE mcp_pins SET observed_json = ?, source = COALESCE(source, ?)"
            + (", probed_at = ?" if probed else "")
            + " WHERE harness = ? AND scope = ? AND workspace_hash = ? AND server = ?",
            ((json.dumps(tools), source) + ((_now(),) if probed else ())
             + (harness, scope, workspace_hash, server)),
        )
        await conn.commit()

    async def set_probe(self, harness: str, scope: str, workspace_hash: str, server: str, on: bool,
                        definition_hash: Optional[str] = None) -> None:
        """The opt-in is bound to the server definition it was given for: a
        changed URL, header name or transport revokes it."""
        await self.ensure_server_row(harness, scope, workspace_hash, server)
        conn = await self.db.connect()
        await conn.execute(
            "UPDATE mcp_pins SET probe_opt_in = ?, probe_definition_hash = ? "
            "WHERE harness = ? AND scope = ? AND workspace_hash = ? AND server = ?",
            (1 if on else 0, definition_hash if on else None, harness, scope, workspace_hash, server),
        )
        await conn.commit()

    async def probe_targets(self) -> List[dict]:
        rows = await self.db.fetch_all("SELECT * FROM mcp_pins WHERE probe_opt_in = 1")
        return [dict(r) for r in rows]

    async def delete_server(self, harness: str, scope: str, workspace_hash: str, server: str) -> None:
        conn = await self.db.connect()
        await conn.execute(
            "DELETE FROM mcp_pins WHERE harness = ? AND scope = ? AND workspace_hash = ? AND server = ?",
            (harness, scope, workspace_hash, server),
        )
        await conn.commit()

    # --- mods ------------------------------------------------------------------

    async def mods(self) -> Dict[str, dict]:
        rows = await self.db.fetch_all("SELECT * FROM mod_inventory")
        return {r["mod_key"]: dict(r) for r in rows}

    async def upsert_mod(self, mod: Any, *, first_seen: Optional[str] = None) -> None:
        now = _now()
        conn = await self.db.connect()
        await conn.execute(
            """
            INSERT INTO mod_inventory (mod_key, version, managed, enabled_json, handlers_json, permissions_json,
                                       manifest_hash, tree_hash, first_seen, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (mod_key) DO UPDATE SET
                version = excluded.version, managed = excluded.managed, enabled_json = excluded.enabled_json,
                handlers_json = excluded.handlers_json, permissions_json = excluded.permissions_json,
                manifest_hash = excluded.manifest_hash, tree_hash = excluded.tree_hash, last_seen = excluded.last_seen
            """,
            (mod.key, mod.version, 1 if mod.managed else 0, json.dumps(mod.enabled_scopes),
             json.dumps(mod.handlers), json.dumps(mod.permissions), mod.manifest_hash, mod.tree_hash,
             first_seen or now, now),
        )
        await conn.commit()

    # --- session checks ---------------------------------------------------------

    async def add_check(self, *, session_id: Optional[str], task_id: Optional[str], harness: str,
                        workspace_hash: str, phase: str, setup_hash: str, state: str, diff: list) -> None:
        conn = await self.db.connect()
        await conn.execute(
            "INSERT INTO config_checks (session_id, task_id, harness, workspace_hash, phase, setup_hash, state, "
            "diff_json, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (session_id, task_id, harness, workspace_hash, phase, setup_hash, state, json.dumps(diff), _now()),
        )
        await conn.commit()

    async def checks_for(self, task_id: Optional[str] = None, session_id: Optional[str] = None) -> List[dict]:
        if not task_id and not session_id:
            return []
        rows = await self.db.fetch_all(
            "SELECT * FROM config_checks WHERE (task_id = ? AND ? IS NOT NULL) OR (session_id = ? AND ? IS NOT NULL) "
            "ORDER BY checked_at ASC, id ASC",
            (task_id, task_id, session_id, session_id),
        )
        out = []
        for r in rows:
            d = dict(r)
            d["diff"] = json.loads(d["diff_json"]) if d.get("diff_json") else []
            out.append(d)
        return out

    async def latest_for_tasks(self, task_ids: List[str]) -> Dict[str, dict]:
        if not task_ids:
            return {}
        marks = ",".join("?" for _ in task_ids[:400])
        rows = await self.db.fetch_all(
            f"SELECT c.* FROM config_checks c JOIN (SELECT task_id, MAX(id) AS mid FROM config_checks "
            f"WHERE task_id IN ({marks}) GROUP BY task_id) m ON c.id = m.mid",
            tuple(task_ids[:400]),
        )
        out = {}
        for r in rows:
            d = dict(r)
            d["diff"] = json.loads(d["diff_json"]) if d.get("diff_json") else []
            out[d["task_id"]] = d
        return out
