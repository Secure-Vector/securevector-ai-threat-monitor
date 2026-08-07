"""
Repository for agent egress governance.

Three concerns, deliberately kept separate:

- **Policy** — the active destination policy (preset + allow/deny lists).
  Exactly one row is active at a time.
- **Audit** — one row per *destination reached*, not per tool call. A single
  Bash command can reach several hosts with different consequences, and
  collapsing that into one row would erase the distinction the policy exists
  to make.
- **Containment proofs** — results of the controlled self-test, hash-chained
  so a removed or edited proof is detectable.

Data boundaries: no prompt text, no tool output, no credential value ever
lands here. `evidence` is a truncated, already-redacted command fragment kept
for display only, and callers must treat it as untrusted text.
"""

import json
import logging
import uuid
from typing import Optional

from securevector.app.database.connection import DatabaseConnection

logger = logging.getLogger(__name__)

# An agent in a scan loop can generate destinations far faster than a human
# reads them. The cap bounds a single call's audit fan-out; the aggregate
# volume signal (distinct hosts per run) is what actually carries meaning at
# that scale, and it survives truncation.
MAX_ATTEMPTS_PER_CALL = 50
MAX_EVIDENCE_CHARS = 200


class EgressRepository:
    """Repository for egress policy, per-destination audit, and proofs."""

    def __init__(self, db: DatabaseConnection):
        self.db = db

    # --------------------------------------------------------------- policy

    async def get_active_policy(self) -> Optional[dict]:
        """Return the active policy row, or None when nothing is active."""
        conn = await self.db.connect()
        cur = await conn.execute(
            "SELECT id, name, preset, allowlist, denylist, fail_closed, "
            "ci_profile, baseline_enabled, source, policy_version "
            "FROM egress_policies WHERE is_active = 1 LIMIT 1"
        )
        row = await cur.fetchone()
        if not row:
            return None
        return {
            "id": row[0],
            "name": row[1],
            "preset": row[2],
            "allowlist": self._load_list(row[3]),
            "denylist": self._load_list(row[4]),
            "fail_closed": bool(row[5]),
            "ci_profile": bool(row[6]),
            "baseline_enabled": bool(row[7]),
            "source": row[8],
            "policy_version": row[9],
        }

    async def get_synced_policy(self) -> Optional[dict]:
        """Return the org policy pushed by the cloud, or None if there is none.

        Kept as a separate row from the active local policy rather than
        overwriting it: an org policy must be removable (the device leaves the
        org, the admin deletes the policy) and the operator's own settings
        have to still be there when it is.
        """
        conn = await self.db.connect()
        cur = await conn.execute(
            "SELECT id, name, preset, allowlist, denylist, policy_version "
            "FROM egress_policies WHERE source = 'synced' "
            "ORDER BY id DESC LIMIT 1"
        )
        row = await cur.fetchone()
        if not row:
            return None
        return {
            "id": row[0],
            "name": row[1],
            "preset": row[2],
            "allowlist": self._load_list(row[3]),
            "denylist": self._load_list(row[4]),
            "policy_version": row[5],
        }

    async def replace_synced_policy(
        self,
        *,
        preset: str,
        allowlist: list,
        denylist: list,
        policy_name: str,
        policy_version: Optional[int] = None,
    ) -> None:
        """Replace the org policy with the one from the latest bundle.

        Replace rather than merge: the bundle is a complete statement of org
        policy, so a host the admin removed upstream has to stop applying
        here. Accumulating would make deletions in the cloud admin silently
        ineffective on the device.

        `is_active` stays 0 — the active row remains the operator's local
        policy, and the two are combined at read time by
        `core.egress.policy_merge.resolve_effective_policy`.
        """
        conn = await self.db.connect()
        await conn.execute("DELETE FROM egress_policies WHERE source = 'synced'")
        await conn.execute(
            "INSERT INTO egress_policies "
            "(name, preset, allowlist, denylist, is_active, source, "
            " policy_version, updated_at) "
            "VALUES (?, ?, ?, ?, 0, 'synced', ?, CURRENT_TIMESTAMP)",
            (
                policy_name,
                preset,
                json.dumps(self._normalise(allowlist)),
                json.dumps(self._normalise(denylist)),
                policy_version,
            ),
        )
        await conn.commit()

    async def clear_synced_policy(self) -> int:
        """Drop the org policy. Used when the device is no longer enrolled.

        Leaving a stale org policy applied after unenrollment would keep
        enforcing rules from an organisation that can no longer change them,
        which is the one failure here with no recovery path from the UI.
        """
        conn = await self.db.connect()
        cur = await conn.execute(
            "DELETE FROM egress_policies WHERE source = 'synced'"
        )
        await conn.commit()
        return cur.rowcount or 0

    @staticmethod
    def _normalise(hosts) -> list:
        """Match `update_policy`'s storage form so both paths compare equal."""
        return sorted({
            str(h).strip().lower() for h in (hosts or []) if str(h).strip()
        })

    @staticmethod
    def _load_list(raw) -> list:
        """Parse a JSON host list, degrading to empty rather than raising.

        A corrupt allowlist must not take enforcement down. Degrading to empty
        is the safe direction: it makes the policy stricter, never looser.
        """
        try:
            value = json.loads(raw or "[]")
            return [str(v) for v in value] if isinstance(value, list) else []
        except (ValueError, TypeError):
            logger.warning("Corrupt egress host list in policy row; treating as empty")
            return []

    async def update_policy(
        self,
        policy_id: int,
        preset: Optional[str] = None,
        allowlist: Optional[list] = None,
        denylist: Optional[list] = None,
        fail_closed: Optional[bool] = None,
        ci_profile: Optional[bool] = None,
        baseline_enabled: Optional[bool] = None,
    ) -> None:
        """Patch the named policy. Only supplied fields change."""
        sets, params = [], []
        if preset is not None:
            sets.append("preset = ?")
            params.append(preset)
        if allowlist is not None:
            sets.append("allowlist = ?")
            params.append(json.dumps(sorted({str(h).strip().lower() for h in allowlist if str(h).strip()})))
        if denylist is not None:
            sets.append("denylist = ?")
            params.append(json.dumps(sorted({str(h).strip().lower() for h in denylist if str(h).strip()})))
        if fail_closed is not None:
            sets.append("fail_closed = ?")
            params.append(1 if fail_closed else 0)
        if ci_profile is not None:
            sets.append("ci_profile = ?")
            params.append(1 if ci_profile else 0)
        if baseline_enabled is not None:
            sets.append("baseline_enabled = ?")
            params.append(1 if baseline_enabled else 0)
        if not sets:
            return
        sets.append("updated_at = CURRENT_TIMESTAMP")
        params.append(policy_id)
        conn = await self.db.connect()
        await conn.execute(
            f"UPDATE egress_policies SET {', '.join(sets)} WHERE id = ?", params
        )
        await conn.commit()

    async def promote_host(self, policy_id: int, host: str) -> bool:
        """Add a host to the allowlist. This is the deny-time promotion path.

        Promotion at deny-time (rather than proactive allowlist authoring) is
        what keeps this policy maintainable: nobody maintains an allowlist, but
        everybody clicks allow when something they recognise is stopped.
        """
        host = (host or "").strip().lower()
        if not host:
            return False
        policy = await self.get_active_policy()
        if not policy:
            return False
        allow = set(policy["allowlist"])
        if host in allow:
            return True
        allow.add(host)
        await self.update_policy(policy_id, allowlist=sorted(allow))
        # Mark the matching denied rows as promoted so the promotion-rate
        # health signal can distinguish "policy caught something real" from
        # "policy is mis-set and the user is clicking through it".
        conn = await self.db.connect()
        await conn.execute(
            "UPDATE egress_audit SET promoted = 1, promoted_at = CURRENT_TIMESTAMP "
            "WHERE host = ? AND action = 'block' AND promoted = 0",
            (host,),
        )
        await conn.commit()
        return True

    # ---------------------------------------------------------------- audit

    async def log_attempts(self, verdicts, tool_name=None, runtime_kind=None,
                           session_id=None, request_id=None) -> int:
        """Persist one row per evaluated destination. Returns rows written."""
        conn = await self.db.connect()
        written = 0
        for verdict in list(verdicts)[:MAX_ATTEMPTS_PER_CALL]:
            attempt = verdict.attempt
            await conn.execute(
                """
                INSERT INTO egress_audit (
                    host, port, scheme, operation, kind, action, rule_id,
                    severity, confidence, detector, tool_name, runtime_kind,
                    session_id, request_id, evidence, reason
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    attempt.host, attempt.port, attempt.scheme, attempt.operation,
                    attempt.kind, verdict.action, verdict.rule_id, verdict.severity,
                    attempt.confidence, attempt.detector, tool_name, runtime_kind,
                    session_id, request_id,
                    (attempt.evidence or "")[:MAX_EVIDENCE_CHARS],
                    verdict.reason,
                ),
            )
            written += 1
        await conn.commit()
        return written

    async def recent(self, limit: int = 100, action: Optional[str] = None) -> list:
        """Recent egress rows, newest first."""
        conn = await self.db.connect()
        sql = (
            "SELECT id, timestamp, host, port, operation, kind, action, rule_id, "
            "severity, confidence, detector, tool_name, runtime_kind, evidence, "
            "reason, promoted FROM egress_audit"
        )
        params = []
        if action:
            sql += " WHERE action = ?"
            params.append(action)
        sql += " ORDER BY timestamp DESC, id DESC LIMIT ?"
        params.append(max(1, min(int(limit), 1000)))
        cur = await conn.execute(sql, params)
        cols = ["id", "timestamp", "host", "port", "operation", "kind", "action",
                "rule_id", "severity", "confidence", "detector", "tool_name",
                "runtime_kind", "evidence", "reason", "promoted"]
        return [dict(zip(cols, r)) for r in await cur.fetchall()]

    # Rules whose block a promotion cannot clear. Baseline verdicts are decided
    # before the allowlist is consulted, so adding one of these hosts to the
    # allowlist changes nothing: publish interdiction and the metadata endpoint
    # are severe enough to cost an explicit policy edit. A UI that offers a
    # one-click allow here would be offering a button that does not work.
    NON_PROMOTABLE_RULES = ("sv.egress.package_publish", "sv.egress.cloud_metadata",
                            "policy.denylist")

    async def destination_inventory(self, days: int = 30) -> list:
        """Distinct destinations seen, with counts. The blast-radius number.

        This is the figure nobody currently has: how many external hosts the
        agents on this machine actually reached.
        """
        conn = await self.db.connect()
        placeholders = ", ".join("?" for _ in self.NON_PROMOTABLE_RULES)
        cur = await conn.execute(
            f"""
            SELECT host,
                   COUNT(*)                                        AS calls,
                   SUM(CASE WHEN action = 'block' THEN 1 ELSE 0 END) AS blocked,
                   SUM(CASE WHEN operation = 'write' THEN 1 ELSE 0 END) AS writes,
                   MAX(CASE WHEN action = 'block'
                             AND rule_id IN ({placeholders})
                            THEN 1 ELSE 0 END)                     AS hard_blocked,
                   MIN(timestamp)                                  AS first_seen,
                   MAX(timestamp)                                  AS last_seen
            FROM egress_audit
            WHERE host IS NOT NULL
              AND timestamp >= datetime('now', ?)
            GROUP BY host
            ORDER BY calls DESC
            """,
            (*self.NON_PROMOTABLE_RULES, f"-{max(1, int(days))} days"),
        )
        cols = ["host", "calls", "blocked", "writes", "hard_blocked",
                "first_seen", "last_seen"]
        rows = [dict(zip(cols, r)) for r in await cur.fetchall()]
        for row in rows:
            row["promotable"] = not row.pop("hard_blocked")
        return rows

    async def session_scope(self, days: int = 7, limit: int = 50) -> list:
        """Per-session egress shape: how wide, how novel, how fast.

        The pattern carries information no individual destination does. A host
        counts as *novel* only when its earliest appearance anywhere on this
        device falls inside the session, so a session hammering familiar
        infrastructure does not look like a session discovering new hosts.
        """
        conn = await self.db.connect()
        cur = await conn.execute(
            """
            WITH firsts AS (
                -- Keyed on the row id, not the timestamp. `timestamp` has
                -- one-second resolution, so several sessions inside the same
                -- second would each claim to have discovered the same host.
                -- The id is monotonic and settles it.
                SELECT host, MIN(id) AS first_id
                FROM egress_audit WHERE host IS NOT NULL GROUP BY host
            )
            SELECT a.session_id,
                   COUNT(DISTINCT a.host)                                   AS distinct_hosts,
                   COUNT(DISTINCT CASE WHEN a.id = f.first_id
                                       THEN a.host END)                     AS novel_hosts,
                   COUNT(*)                                                 AS calls,
                   MIN(a.timestamp)                                         AS started_at,
                   MAX(a.timestamp)                                         AS ended_at,
                   (julianday(MAX(a.timestamp)) - julianday(MIN(a.timestamp)))
                       * 1440.0                                             AS span_minutes
            FROM egress_audit a
            JOIN firsts f ON f.host = a.host
            WHERE a.session_id IS NOT NULL
              AND a.host IS NOT NULL
              AND a.timestamp >= datetime('now', ?)
            GROUP BY a.session_id
            ORDER BY novel_hosts DESC, distinct_hosts DESC
            LIMIT ?
            """,
            (f"-{max(1, int(days))} days", max(1, min(int(limit), 500))),
        )
        cols = ["session_id", "distinct_hosts", "novel_hosts", "calls",
                "started_at", "ended_at", "span_minutes"]
        return [dict(zip(cols, r)) for r in await cur.fetchall()]

    async def attempts_for_replay(self, days: int = 30, limit: int = 20000) -> list:
        """Recorded destinations in a window, shaped for counterfactual replay.

        `evidence` is not selected. Replay decides on destination facts alone,
        and pulling a display string it cannot use would move redacted command
        fragments through a code path that has no reason to see them.
        """
        conn = await self.db.connect()
        cur = await conn.execute(
            """
            SELECT host, port, scheme, operation, kind, action, rule_id,
                   confidence, detector
            FROM egress_audit
            WHERE timestamp >= datetime('now', ?)
            ORDER BY timestamp DESC
            LIMIT ?
            """,
            (f"-{max(1, int(days))} days", max(1, min(int(limit), 100000))),
        )
        cols = ["host", "port", "scheme", "operation", "kind", "action",
                "rule_id", "confidence", "detector"]
        return [dict(zip(cols, r)) for r in await cur.fetchall()]

    async def blast_radius(self, days: int = 30, new_within_days: int = 7) -> dict:
        """The headline counter: how far the agents on this machine can reach.

        Deliberately a count of *destinations*, not of blocks. A blocked-events
        number measures the product; a destination count measures the exposure,
        and the exposure is what the operator did not previously have any way
        to see. It is also the one number that stays interesting when the
        policy is working and nothing is being blocked at all.

        `first_seen_recently` is the movement in that number. A steady host set
        is a steady blast radius; a set that grew this week grew for a reason.
        """
        conn = await self.db.connect()
        cur = await conn.execute(
            """
            SELECT
              COUNT(DISTINCT host)                                            AS hosts,
              COUNT(DISTINCT CASE WHEN operation = 'write' THEN host END)     AS write_hosts,
              COUNT(*)                                                        AS calls,
              SUM(CASE WHEN action = 'block' THEN 1 ELSE 0 END)               AS blocked,
              COUNT(DISTINCT CASE WHEN kind = 'mcp' THEN host END)            AS mcp_hosts
            FROM egress_audit
            WHERE host IS NOT NULL AND timestamp >= datetime('now', ?)
            """,
            (f"-{max(1, int(days))} days",),
        )
        row = await cur.fetchone() or (0, 0, 0, 0, 0)

        # A host is "new" only if it was never seen before the recent window,
        # not merely if it appears in it. Anything else counts every routine
        # destination as new every week and the signal dies.
        cur = await conn.execute(
            """
            SELECT COUNT(*) FROM (
                SELECT host FROM egress_audit
                WHERE host IS NOT NULL
                GROUP BY host
                HAVING MIN(timestamp) >= datetime('now', ?)
            )
            """,
            (f"-{max(1, int(new_within_days))} days",),
        )
        new_row = await cur.fetchone()

        return {
            "window_days": days,
            "distinct_hosts": row[0] or 0,
            "write_capable_hosts": row[1] or 0,
            "mcp_hosts": row[4] or 0,
            "total_calls": row[2] or 0,
            "blocked_calls": row[3] or 0,
            "first_seen_recently": (new_row[0] or 0) if new_row else 0,
            "new_within_days": new_within_days,
            "coverage": (
                "Counts destinations SecureVector observed at the agent tool "
                "boundary. Traffic from a process these hooks do not cover is "
                "not included, and a remote MCP server counts as one "
                "destination however many hosts it reaches downstream."
            ),
        }

    async def known_hosts(self) -> frozenset:
        """Every host seen before. Feeds hardened-preset first-seen detection."""
        conn = await self.db.connect()
        cur = await conn.execute(
            "SELECT DISTINCT host FROM egress_audit WHERE host IS NOT NULL"
        )
        return frozenset(r[0].lower() for r in await cur.fetchall() if r[0])

    async def promotion_rate(self, days: int = 30) -> dict:
        """Blocks vs blocks-later-promoted.

        A policy whose denials are all promoted is mis-set. Surfacing that is
        the honest alternative to waiting for the user to disable the feature:
        no security product measures its own false-positive rate out loud.
        """
        conn = await self.db.connect()
        cur = await conn.execute(
            "SELECT COUNT(*), SUM(promoted) FROM egress_audit "
            "WHERE action = 'block' AND timestamp >= datetime('now', ?)",
            (f"-{max(1, int(days))} days",),
        )
        row = await cur.fetchone()
        blocks = (row[0] or 0) if row else 0
        promoted = (row[1] or 0) if row else 0
        rate = (promoted / blocks) if blocks else 0.0
        return {
            "window_days": days,
            "blocks": blocks,
            "promoted": promoted,
            "promotion_rate": round(rate, 3),
            # Threshold is a judgement call, stated rather than hidden: if more
            # than half of blocks get promoted the policy is fighting the user.
            "policy_health": "mis-set" if blocks >= 4 and rate > 0.5 else "ok",
        }

    # ----------------------------------------------------- containment proof

    async def save_proof(self, probes: list, verdict: str, coverage=None,
                         trigger: str = "manual", policy_preset=None) -> dict:
        """Persist a completed proof, chained to the previous one."""
        import hashlib

        conn = await self.db.connect()
        cur = await conn.execute(
            "SELECT result_hash FROM containment_proofs "
            "ORDER BY started_at DESC, rowid DESC LIMIT 1"
        )
        prev_row = await cur.fetchone()
        prev_hash = prev_row[0] if prev_row else None

        proof_id = str(uuid.uuid4())
        reached = sum(1 for p in probes if p.get("reached"))
        blocked = sum(1 for p in probes if p.get("blocked_by_securevector"))
        payload = json.dumps(probes, sort_keys=True)
        result_hash = hashlib.sha256(
            f"{proof_id}|{verdict}|{payload}|{prev_hash or ''}".encode("utf-8")
        ).hexdigest()

        await conn.execute(
            """
            INSERT INTO containment_proofs (
                id, completed_at, trigger, verdict, probes, reached_count,
                blocked_count, coverage, policy_preset, result_hash, prev_hash
            ) VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (proof_id, trigger, verdict, payload, reached, blocked,
             json.dumps(coverage or []), policy_preset, result_hash, prev_hash),
        )
        await conn.commit()
        return {
            "id": proof_id, "verdict": verdict, "reached_count": reached,
            "blocked_count": blocked, "result_hash": result_hash,
        }

    async def latest_proof(self) -> Optional[dict]:
        conn = await self.db.connect()
        cur = await conn.execute(
            "SELECT id, started_at, completed_at, trigger, verdict, probes, "
            "reached_count, blocked_count, coverage, policy_preset, result_hash "
            "FROM containment_proofs ORDER BY started_at DESC, rowid DESC LIMIT 1"
        )
        row = await cur.fetchone()
        if not row:
            return None
        return {
            "id": row[0], "started_at": row[1], "completed_at": row[2],
            "trigger": row[3], "verdict": row[4],
            "probes": json.loads(row[5] or "[]"),
            "reached_count": row[6], "blocked_count": row[7],
            "coverage": json.loads(row[8] or "[]"),
            "policy_preset": row[9], "result_hash": row[10],
        }

    async def recent_proofs_full(self, limit: int = 2) -> list:
        """The last N proofs including probe detail, newest first.

        Drift needs the probe arrays, which `proof_history` deliberately omits
        to keep the list view cheap.
        """
        conn = await self.db.connect()
        cur = await conn.execute(
            "SELECT id, started_at, completed_at, trigger, verdict, probes, "
            "reached_count, blocked_count, coverage, policy_preset, result_hash, "
            "prev_hash FROM containment_proofs "
            "ORDER BY started_at DESC, rowid DESC LIMIT ?",
            (max(1, min(int(limit), 50)),),
        )
        out = []
        for row in await cur.fetchall():
            out.append({
                "id": row[0], "started_at": row[1], "completed_at": row[2],
                "trigger": row[3], "verdict": row[4],
                "probes": json.loads(row[5] or "[]"),
                "reached_count": row[6], "blocked_count": row[7],
                "coverage": json.loads(row[8] or "[]"),
                "policy_preset": row[9], "result_hash": row[10],
                "prev_hash": row[11],
            })
        return out

    async def get_proof(self, proof_id: str) -> Optional[dict]:
        """One proof by id, with probe detail. Used by the attestation export."""
        conn = await self.db.connect()
        cur = await conn.execute(
            "SELECT id, started_at, completed_at, trigger, verdict, probes, "
            "reached_count, blocked_count, coverage, policy_preset, result_hash, "
            "prev_hash FROM containment_proofs WHERE id = ?",
            (proof_id,),
        )
        row = await cur.fetchone()
        if not row:
            return None
        return {
            "id": row[0], "started_at": row[1], "completed_at": row[2],
            "trigger": row[3], "verdict": row[4],
            "probes": json.loads(row[5] or "[]"),
            "reached_count": row[6], "blocked_count": row[7],
            "coverage": json.loads(row[8] or "[]"),
            "policy_preset": row[9], "result_hash": row[10], "prev_hash": row[11],
        }

    async def proof_history(self, limit: int = 20) -> list:
        conn = await self.db.connect()
        cur = await conn.execute(
            "SELECT id, started_at, verdict, reached_count, blocked_count, "
            "policy_preset FROM containment_proofs "
            "ORDER BY started_at DESC, rowid DESC LIMIT ?",
            (max(1, min(int(limit), 200)),),
        )
        cols = ["id", "started_at", "verdict", "reached_count", "blocked_count",
                "policy_preset"]
        return [dict(zip(cols, r)) for r in await cur.fetchall()]
