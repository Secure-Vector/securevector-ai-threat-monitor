"""Governed delegation: an app-launched task asks for a second task.

A task the app launched (and only such a task, identified by its own hook
token) may ask SecureVector to start another harness on a folder with a
prompt. The request is checked in a fixed order, each refusal answered with
a plain reason and audited on the parent:

1. depth: a delegated task cannot delegate in turn
2. children: at most MAX_CHILDREN not-ended delegations per parent
3. harness: one of the app's executors
4. same harness unless the delegation policy has ``cross_harness``
5. folder: inside the parent's workspace (after resolving links) or in the
   policy allowlist
6. prompt scan: the local rules, plus Guardian when it is on; a block
   refuses, a warning goes to approval with the reasons shown
7. tool verdict: the existing verdict for ``mcp__securevector__delegate``
8. governed: the parent and the child harness both run with their Guard

A same-harness delegation that passes with a clean scan starts at once,
approved by the delegation policy, at most AUTO_LAUNCH_LIMIT per parent in
AUTO_LAUNCH_WINDOW_MINUTES. A cross-harness delegation, a prompt with scan
warnings, or one over that limit is filed as an approval request
(rule_source ``delegate``) and waits for a person in the local web UI. An
approval launches the task and nothing else: it never writes a grant, an
allow row, a run exemption or a host grant.

The child's prompt is written to its terminal once the harness is ready.
The delegation is done when the child goes idle after that first turn, or
exits. For Claude Code and Codex the result is the last assistant message
of the transcript, capped and scanned with the same rules; a flagged result
is held until a person releases or discards it.

Audit: tool_call_audit rows (tool_id ``sv.delegation``) on the parent and the
child, and task events on both trails. The prompt is recorded by sha256 and
length only.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)

TOOL_NAME = "mcp__securevector__delegate"
AUDIT_TOOL_ID = "sv.delegation"
TOOL_PREFIX = "delegate:"
MAX_CHILDREN = 4
# Same-harness delegations start without a person; at most this many per
# parent in the window, after which they ask for approval like any other.
AUTO_LAUNCH_LIMIT = 4
AUTO_LAUNCH_WINDOW_MINUTES = 10
MAX_PROMPT_CHARS = 4000
RESULT_CAP_BYTES = 8 * 1024
TRANSCRIPT_HARNESSES = ("claude-code", "codex")
NO_TEXT_RESULT = "Finished. No final message is available for this harness; see the child pane"
# Claude Code and Codex: the transcript had no final message within
# RESULT_GIVE_UP_S of the child's exit.
NO_TRANSCRIPT_RESULT = "Finished. The final message could not be read from the transcript; see the child pane"
RESULT_RETRIES = 5
RESULT_RETRY_S = 1.0
RESULT_GIVE_UP_S = 30.0
RESULT_PENDING_NOTE = "Finished. The final message is still being read from the transcript."
HELD_NOTE = "The result is held for review in SecureVector."
OPEN_STATES = ("pending_approval", "running", "waiting_for_user")
LIVE_STATES = ("running", "waiting_for_user")
_RULE_FLOOR = 0.25
_ML_ALONE_BAR = 0.92
_ML_ALONE_BAR_INCOMING = 0.97
_ML_CORROBORATE_BAR = 0.60
_ML_MIN_CHARS = 20
_ML_MIN_WORDS = 4

_parent_locks: dict = {}
_finalize_lock: Optional[asyncio.Lock] = None


class Refusal(Exception):
    """A delegation refused with a plain reason."""

    def __init__(self, reason: str, check: str):
        super().__init__(reason)
        self.reason = reason
        self.check = check


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "surrogateescape")).hexdigest()


_CONTROL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
_PASTE_MARKERS = ("\x1b[200~", "\x1b[201~")
PROMPT_MARK = "\nPrompt:\n"
_FOLDER_BAD_RE = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]")


def clean_prompt(text: str) -> str:
    """The prompt with paste markers and control characters (other than
    newline and tab) removed. A carriage return becomes a newline."""
    for marker in _PASTE_MARKERS:
        text = text.replace(marker, "")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return _CONTROL_RE.sub("", text)


def paste_text(text: str) -> str:
    """What is pasted into the child's terminal: the cleaned prompt."""
    return clean_prompt(text)


def _lock_for(parent_task_id: str) -> asyncio.Lock:
    lock = _parent_locks.get(parent_task_id)
    if lock is None:
        lock = _parent_locks[parent_task_id] = asyncio.Lock()
    return lock


def forget_task(task_id: str) -> None:
    """Drop the per-parent lock of a task that ended, unless it is held."""
    lock = _parent_locks.get(task_id)
    if lock is not None and not lock.locked():
        _parent_locks.pop(task_id, None)


# --- scanning ---------------------------------------------------------------------


def _analysis_service():
    from securevector.app.services.analysis_service import get_analysis_service

    return get_analysis_service()


def _ml_on() -> bool:
    return os.environ.get("SECUREVECTOR_ML_ENABLED", "on").strip().lower() in ("1", "true", "yes", "on")


async def scan_text(db, text: str, *, direction: str) -> dict:
    """{"level": "clean" | "warn" | "block", "reasons": [rule names]}.

    The local rules decide with the calibrated verdict (one high-confidence
    hit, or two corroborating ones, is a block; any other surviving hit is a
    warning). Guardian adds a block when it alone clears its bar, a warning
    when it corroborates. Raises when the rules cannot run."""
    from securevector.app.services.analysis_service import calibrated_verdict

    result = await _analysis_service().analyze(text, direction=direction)
    confs, reasons = [], []
    for rule in result.matched_rules or []:
        try:
            conf = float(rule.get("confidence") or 0.0)
        except (TypeError, ValueError):
            conf = 0.0
        if conf < _RULE_FLOOR:
            continue
        confs.append(conf)
        name = str(rule.get("name") or rule.get("id") or "rule")[:120]
        if name not in reasons:
            reasons.append(name)
    level = "clean"
    if confs:
        level = "block" if calibrated_verdict(confs) else "warn"
    stripped = text.strip()
    if len(stripped) >= _ML_MIN_CHARS and len(stripped.split()) >= _ML_MIN_WORDS and _ml_on():
        try:
            from securevector.app.database.repositories.settings import SettingsRepository

            ml_enabled = (await SettingsRepository(db).get()).guardian_ml_enabled
        except Exception:  # noqa: BLE001
            ml_enabled = False
        if ml_enabled:
            try:
                from securevector.app.services import guardian_service

                gr = await asyncio.to_thread(guardian_service.analyze, stripped, direction=direction)
            except Exception:  # noqa: BLE001 - Guardian is additive only
                gr = None
            if gr and gr.get("is_threat") and gr.get("matched_rules"):
                try:
                    ml_conf = float(gr["matched_rules"][0].get("confidence") or 0.0)
                except (TypeError, ValueError, AttributeError):
                    ml_conf = 0.0
                alone = _ML_ALONE_BAR_INCOMING if direction == "incoming" else _ML_ALONE_BAR
                if ml_conf >= alone or (confs and ml_conf >= _ML_CORROBORATE_BAR):
                    if ml_conf >= alone:
                        level = "block"
                    elif level == "clean":
                        level = "warn"
                    reasons.append("SecureVector Guardian")
    return {"level": level, "reasons": reasons[:10]}


# --- transcripts --------------------------------------------------------------------


def last_assistant_text(executor_id: str, session_id: Optional[str]) -> Optional[str]:
    """The last assistant message in a Claude Code or Codex transcript, or
    None when there is none (or the harness keeps no readable transcript)."""
    if executor_id not in TRANSCRIPT_HARNESSES or not session_id:
        return None
    from securevector.app.server.routes.transcript_generations import _codex_text, _text_of
    from securevector.app.terminals.session_cwd import _safe_session_id, _tail_lines, _transcript_for

    if not _safe_session_id(session_id):
        return None
    path = _transcript_for(executor_id, session_id)
    if path is None:
        return None
    try:
        lines = _tail_lines(path, tail_bytes=2 * 1024 * 1024)
    except OSError:
        return None
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if not isinstance(rec, dict):
            continue
        if executor_id == "claude-code":
            if rec.get("type") != "assistant":
                continue
            msg = rec.get("message") or {}
            text = _text_of(msg.get("content")) if isinstance(msg, dict) else ""
        else:
            payload = rec.get("payload") or {}
            if not isinstance(payload, dict):
                continue
            if payload.get("type") == "message" and payload.get("role") == "assistant":
                text = _codex_text(payload.get("content"))
            elif payload.get("type") == "agent_message" and isinstance(payload.get("message"), str):
                text = payload["message"]
            else:
                continue
        if text and text.strip():
            return text
    return None


def cap_text(text: str, cap: int = RESULT_CAP_BYTES) -> str:
    data = text.encode("utf-8", "replace")
    if len(data) <= cap:
        return text
    return data[:cap].decode("utf-8", "ignore")


# --- folders ------------------------------------------------------------------------


def _inside(path: str, root: str) -> bool:
    root = root.rstrip(os.sep) or os.sep
    return path == root or path.startswith(root + os.sep) or root == os.sep


def resolve_folder(folder: Any, workspace: Optional[str], allowlist: list) -> Optional[str]:
    """The folder with links resolved, when it is an existing directory
    inside the parent's workspace or inside an allowlisted folder."""
    if not isinstance(folder, str) or not folder.strip() or "\x00" in folder or len(folder) > 4096:
        return None
    # Reject control characters and line breaks in folder paths.
    if _FOLDER_BAD_RE.search(folder):
        return None
    raw = os.path.expanduser(folder.strip())
    if not os.path.isabs(raw):
        if not workspace:
            return None
        raw = os.path.join(workspace, raw)
    # A folder inside a task's worktree is scoped as the same folder in the
    # source, so a child of a worktree task gets the source folder semantics.
    from securevector.app.terminals.worktree import source_for

    real = source_for(os.path.realpath(raw))
    if _FOLDER_BAD_RE.search(real) or not os.path.isdir(real):
        return None
    roots = []
    if workspace:
        roots.append(os.path.realpath(workspace))
    for entry in allowlist or []:
        if isinstance(entry, str) and entry.startswith("/"):
            roots.append(os.path.realpath(entry))
    for root in roots:
        if _inside(real, root):
            return real
    return None


# --- storage ------------------------------------------------------------------------


async def _get(db, delegation_id: str) -> Optional[dict]:
    row = await db.fetch_one("SELECT * FROM delegations WHERE id = ?", (delegation_id,))
    return dict(row) if row else None


async def by_request(db, request_id: str) -> Optional[dict]:
    row = await db.fetch_one("SELECT * FROM delegations WHERE jit_request_id = ?", (request_id,))
    return dict(row) if row else None


async def for_parent(db, parent_task_id: str, limit: int = 50) -> list:
    rows = await db.fetch_all(
        "SELECT * FROM delegations WHERE parent_task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
        (parent_task_id, limit),
    )
    return [dict(r) for r in rows or []]


async def _insert(db, *, parent_task_id: str, harness: str, folder: str, prompt: str, state: str,
                  refusal_reason: Optional[str] = None, store_prompt: bool = True) -> str:
    did = f"dlg_{uuid.uuid4().hex[:20]}"
    await db.execute(
        "INSERT INTO delegations (id, parent_task_id, harness, folder, prompt_sha256, prompt_text, state, "
        "refusal_reason, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (did, parent_task_id, harness or "", folder or "", _sha(prompt or ""),
         prompt if store_prompt else None, state, refusal_reason, _now(),
         _now() if state == "refused" else None),
    )
    return did


async def _update(db, delegation_id: str, **fields) -> None:
    if not fields:
        return
    cols = ", ".join(f"{k} = ?" for k in fields)
    await db.execute(f"UPDATE delegations SET {cols} WHERE id = ?", (*fields.values(), delegation_id))


# --- audit --------------------------------------------------------------------------


async def _audit(db, function_name: str, action: str, *, reason: str, harness: Optional[str],
                 session_id: Optional[str], detail: dict) -> None:
    from securevector.app.database.repositories.custom_tools import CustomToolsRepository

    try:
        await CustomToolsRepository(db).log_tool_call_audit(
            tool_id=AUDIT_TOOL_ID, function_name=function_name, action=action,
            reason=reason[:300], args_preview=json.dumps(detail, default=str)[:2000],
            runtime_kind=harness, session_id=session_id,
        )
    except Exception as e:  # noqa: BLE001 - the decision stands; the audit is best effort
        logger.warning("Delegation audit write failed: %s", type(e).__name__)


async def _task_event(store, task_id: Optional[str], detail: str) -> None:
    if not store or not task_id:
        return
    try:
        await store.add_event(task_id, kind="delegation", origin="delegate", detail=detail[:300])
    except Exception as e:  # noqa: BLE001
        logger.warning("Delegation task event failed: %s", type(e).__name__)


def _parent_detail(row: dict, **extra) -> dict:
    out = {"delegation_id": row.get("id"), "parent_task_id": row.get("parent_task_id"),
           "child_task_id": row.get("child_task_id"), "harness": row.get("harness"),
           "folder": row.get("folder"), "prompt_sha256": row.get("prompt_sha256")}
    out.update(extra)
    return out


# --- request ------------------------------------------------------------------------

TITLE_CHARS = 40
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]+")


def child_title(prompt: Optional[str]) -> str:
    """A short task title from the first words of the prompt: control
    characters and runs of whitespace collapse to one space, about 40
    characters, cut at a word boundary with an ellipsis. Empty prompts fall
    back to the generic title. The text is agent-supplied; the UI escapes it."""
    text = " ".join(_CONTROL.sub(" ", str(prompt or "")).split())
    if not text:
        return "Delegated task"
    if len(text) <= TITLE_CHARS:
        return text
    cut = text[:TITLE_CHARS + 1]
    head = cut[:cut.rfind(" ")] if " " in cut[1:] else text[:TITLE_CHARS]
    return head.rstrip(" ,.;:-") + "\u2026"


async def _open_children(db, manager, parent_task_id: str) -> int:
    """Delegated tasks of this parent that have not ended, plus delegations
    whose approval request is still pending. A request that expired
    undecided marks its delegation refused."""
    from securevector.app.database.repositories.jit_access import JitAccessRepository

    repo = JitAccessRepository(db)
    try:
        await repo.expire_stale_requests()
    except Exception:  # noqa: BLE001
        logger.debug("expiry sweep failed", exc_info=True)
    count = 0
    for row in await for_parent(db, parent_task_id, limit=500):
        if row.get("state") in LIVE_STATES:
            row = await refresh(db, manager, row, quick=True)
        if row.get("state") != "pending_approval":
            continue
        req = await repo.get_request(row["jit_request_id"]) if row.get("jit_request_id") else None
        if req is not None and req.get("status") == "pending":
            count += 1
        elif req is not None and req.get("status") == "expired":
            await _refuse_row(db, manager, row, "The approval expired.", check="expired")
    for child in await manager.store.children_of(parent_task_id):
        if not child.get("ended_at") and child.get("status") not in _ENDED:
            count += 1
    return count


async def _auto_launches(db, parent_task_id: str) -> int:
    """Delegations of this parent the policy launched in the rate window."""
    found = await db.fetch_one(
        "SELECT COUNT(*) AS n FROM delegations WHERE parent_task_id = ? AND jit_request_id IS NULL "
        "AND child_task_id IS NOT NULL AND created_at >= datetime('now', ?)",
        (parent_task_id, f"-{AUTO_LAUNCH_WINDOW_MINUTES} minutes"),
    )
    return int(found["n"] or 0) if found else 0


async def _scrub(db, row: dict) -> None:
    """Drop the stored prompt text, keeping its sha256 and length."""
    if row.get("prompt_text") is not None:
        await _update(db, row["id"], prompt_text=None)
    rid = row.get("jit_request_id")
    if rid:
        from securevector.app.database.repositories.jit_access import JitAccessRepository

        repo = JitAccessRepository(db)
        req = await repo.get_request(rid)
        just = (req or {}).get("justification") or ""
        if PROMPT_MARK in just:
            head = just.split(PROMPT_MARK, 1)[0]
            length = len(row.get("prompt_text") or just.split(PROMPT_MARK, 1)[1])
            await repo.set_justification(
                rid, f"{head}\nPrompt removed: sha256={row.get('prompt_sha256')} length={length}")


async def _refuse_row(db, manager, row: dict, reason: str, *, check: str, state: str = "refused") -> dict:
    await _update(db, row["id"], state=state, refusal_reason=reason, decided_at=row.get("decided_at") or _now(),
                  ended_at=_now() if state == "failed" else None)
    await _scrub(db, row)
    row = await _get(db, row["id"])
    store = manager.store if manager is not None else None
    parent = await store.get_task(row["parent_task_id"]) if store else None
    await _audit(db, "delegation.refused" if state == "refused" else "delegation.result",
                 "block" if state == "refused" else "log_only", reason=reason,
                 harness=parent and parent.get("executor_id"), session_id=parent and parent.get("session_id"),
                 detail=_parent_detail(row, check=check, state=state))
    await _task_event(store, row["parent_task_id"], f"{state} {row['id']}: {check}")
    return row


async def _tool_verdict(db, caller, tool_input: dict, workspace: Optional[str], app_port: Optional[int]) -> str:
    from securevector.app.services import policy_check

    try:
        decision, _version = await policy_check.decide(
            db, TOOL_NAME, tool_input, harness=caller.harness,
            harness_session_id=caller.harness_session_id, verified=True,
            app_port=app_port, cwd=workspace,
        )
    except Exception as e:  # noqa: BLE001 - an unknown verdict is not an allow
        logger.warning("Delegation tool verdict unavailable: %s", type(e).__name__)
        return policy_check.INDETERMINATE
    return decision


async def request_delegation(db, manager, caller, folder: Any, prompt: Any, harness: Any = None, *,
                             app_port: Optional[int] = None) -> dict:
    """Run the checks and file the approval request. `caller` is a
    verified policy_check.Caller. Returns the public view."""
    store = manager.store
    parent = await store.get_task(caller.task_id)
    if parent is None:
        raise Refusal("The requesting task is not on the board.", "caller")
    parent_harness = parent.get("executor_id") or caller.harness
    want = harness if isinstance(harness, str) and harness.strip() else parent_harness
    want = want.strip() if isinstance(want, str) else ""
    text = clean_prompt(prompt) if isinstance(prompt, str) else ""
    folder_in = folder if isinstance(folder, str) else ""
    async with _lock_for(caller.task_id):
        try:
            if not text.strip():
                raise Refusal("A prompt is required.", "prompt")
            if len(text) > MAX_PROMPT_CHARS:
                raise Refusal(f"The prompt is longer than {MAX_PROMPT_CHARS} characters.", "prompt")
            if text.strip()[:1] in ("!", "/", "#"):
                raise Refusal("The prompt cannot start with !, / or #.", "prompt")
            # A lone word could name one of the harness's own subcommands.
            if re.fullmatch(r"[A-Za-z0-9_.:-]+", text.strip()):
                raise Refusal("The prompt must be more than one word.", "prompt")
            if caller.task_ended:
                raise Refusal("The requesting task has ended.", "caller")
            from securevector.app.database.repositories.settings import SettingsRepository

            policy = await SettingsRepository(db).get_delegation_policy()
            if not policy.get("enabled", True):
                raise Refusal("Delegation is turned off in SecureVector.", "policy")
            # 1. depth
            if parent.get("parent_task_id"):
                raise Refusal("A delegated task cannot delegate.", "depth")
            # 2. children
            if await _open_children(db, manager, caller.task_id) >= MAX_CHILDREN:
                raise Refusal(f"This task already has {MAX_CHILDREN} delegated tasks that have not ended.",
                              "children")
            # 3. harness
            from securevector.app.terminals.executors import EXECUTORS

            if want not in EXECUTORS:
                raise Refusal("That harness is not one SecureVector can launch.", "harness")
            # 4. same harness by default
            if want != parent_harness and not policy.get("cross_harness"):
                raise Refusal("Delegation to a different harness is off in the delegation policy.", "harness")
            # 5. folder
            resolved = resolve_folder(folder_in, parent.get("workspace"), policy.get("folder_allowlist") or [])
            if resolved is None:
                raise Refusal("The folder must be inside this task's workspace or the delegation allowlist.",
                              "folder")
            # A worktree task's child runs in that worktree; refused when it is gone.
            from securevector.app.terminals.worktree import WorktreeError

            try:
                if hasattr(manager, "child_run_dir"):
                    manager.child_run_dir(parent, resolved)
            except WorktreeError as e:
                raise Refusal(str(e), "folder") from None
            # 6. prompt scan
            try:
                verdict = await scan_text(db, text, direction="outgoing")
            except Exception as e:  # noqa: BLE001 - no scan, no delegation
                logger.warning("Delegation prompt scan failed: %s", type(e).__name__)
                raise Refusal("The prompt could not be scanned.", "scan") from None
            if verdict["level"] == "block":
                raise Refusal("The prompt matched SecureVector detection rules: "
                              + ", ".join(verdict["reasons"][:3]) + ".", "scan")
            # 7. tool verdict
            from securevector.app.services import policy_check

            decision = await _tool_verdict(db, caller, {"folder": folder_in, "prompt": text, "harness": want},
                                           parent.get("workspace"), app_port)
            if decision == policy_check.DENY:
                raise Refusal("The delegate tool is blocked by policy.", "policy")
            if decision == policy_check.INDETERMINATE:
                raise Refusal("The delegate tool verdict is unavailable.", "policy")
            # 8. governed parent and child
            if caller.task_id in manager.ungoverned_ids():
                raise Refusal("The requesting task runs without its Guard plugin.", "governed")
            if not manager.would_be_governed(want):
                raise Refusal(guard_missing_reason(want), "governed")
            # 9. A request a person approves must fit the approval card whole.
            auto = (want == parent_harness and verdict["level"] == "clean"
                    and await _auto_launches(db, caller.task_id) < AUTO_LAUNCH_LIMIT)
            justification = None
            if not auto:
                from securevector.app.database.repositories.jit_access import MAX_DELEGATE_JUSTIFICATION_CHARS

                warning = ("Scan warnings: " + ", ".join(verdict["reasons"][:5]) + ". ") if verdict["reasons"] else ""
                justification = (f"{warning}Delegate to {want} in {resolved} from task {caller.task_id}."
                                 f"{PROMPT_MARK}{text}")
                if len(justification.strip()) > MAX_DELEGATE_JUSTIFICATION_CHARS:
                    raise Refusal("The request is too long to show in full for approval; "
                                  "use a shorter prompt or folder path.", "length")
        except Refusal as refusal:
            did = await _insert(db, parent_task_id=caller.task_id, harness=want, folder=folder_in[:4096],
                                prompt=text, state="refused", refusal_reason=refusal.reason, store_prompt=False)
            row = await _get(db, did)
            await _audit(db, "delegation.refused", "block", reason=refusal.reason, harness=parent_harness,
                         session_id=caller.harness_session_id,
                         detail=_parent_detail(row, check=refusal.check, prompt_length=len(text)))
            await _task_event(store, caller.task_id, f"refused {did}: {refusal.check}")
            return view(row)

        from securevector.app.database.repositories.jit_access import JitAccessRepository

        did = await _insert(db, parent_task_id=caller.task_id, harness=want, folder=resolved, prompt=text,
                            state="pending_approval")
        # Same harness, a clean scan and room in the rate window: the
        # delegation policy approves it. Cross-harness requests, warned
        # prompts and requests over the window wait for a person.
        if auto:
            row = await _get(db, did)
            await _audit(db, "delegation.requested", "log_only", reason="Delegation requested",
                         harness=parent_harness, session_id=caller.harness_session_id,
                         detail=_parent_detail(row, prompt_length=len(text), scan=verdict["level"],
                                               approver="policy"))
            await _task_event(store, caller.task_id, f"requested {did}")
            await _update(db, did, decided_at=_now())
            return await _launch(db, manager, row, approver="policy")
        req = await JitAccessRepository(db).create_delegate_request(
            tool_id=f"{TOOL_PREFIX}{want}", runtime_kind=parent_harness,
            session_id=caller.harness_session_id, trace_id=did, justification=justification,
        )
        if req is None:
            await _update(db, did, state="refused", refusal_reason="The approval queue is full; try again later.",
                          decided_at=_now(), prompt_text=None)
            row = await _get(db, did)
            await _audit(db, "delegation.refused", "block", reason=row["refusal_reason"], harness=parent_harness,
                         session_id=caller.harness_session_id, detail=_parent_detail(row, check="queue"))
            return view(row)
        await _update(db, did, jit_request_id=req["id"])
        row = await _get(db, did)
        await _audit(db, "delegation.requested", "log_only", reason="Delegation waiting for approval",
                     harness=parent_harness, session_id=caller.harness_session_id,
                     detail=_parent_detail(row, request_id=req["id"], prompt_length=len(text),
                                           scan=verdict["level"], scan_reasons=verdict["reasons"]))
        await _task_event(store, caller.task_id, f"requested {did}")
        out = view(row)
        if verdict["reasons"]:
            out["warnings"] = verdict["reasons"]
        return out


# --- decisions ------------------------------------------------------------------------


async def approve(db, manager, request_id: str) -> Optional[dict]:
    """A person approved the request in the UI: launch the task. None when
    the request is not a pending delegation."""
    from securevector.app.database.repositories.jit_access import JitAccessRepository

    row = await by_request(db, request_id)
    if row is None:
        return None
    if not await JitAccessRepository(db).decide_delegate_request(request_id, True):
        return view(await _get(db, row["id"]))
    await _update(db, row["id"], decided_at=_now())
    return await _launch(db, manager, row, approver="person")


async def _launch(db, manager, row: dict, *, approver: str) -> dict:
    """Launch an approved delegation: by a person in the inbox, or by the
    delegation policy for a same-harness request that passed every check."""
    store = manager.store if manager is not None else None
    parent = await store.get_task(row["parent_task_id"]) if store else None
    reason = None
    if manager is None:
        reason = "Agent Terminals is not running."
    elif parent is None or parent.get("ended_at") or row["parent_task_id"] not in getattr(manager, "_running", set()):
        reason = "The requesting task has ended."
    else:
        from securevector.app.database.repositories.settings import SettingsRepository

        policy = await SettingsRepository(db).get_delegation_policy()
        if resolve_folder(row["folder"], parent.get("workspace"), policy.get("folder_allowlist") or []) != row["folder"]:
            reason = "The folder changed after the request; ask again."
    if reason is None and row["parent_task_id"] in manager.ungoverned_ids():
        reason = "The requesting task runs without its Guard plugin."
    if reason is None and not manager.would_be_governed(row["harness"]):
        reason = guard_missing_reason(row["harness"])
    session = parent.get("session_id") if parent else None
    if reason:
        row = await _refuse_row(db, manager, row, reason, check="launch")
        return view(row)
    await _audit(db, "delegation.approved", "allow",
                 reason=("Delegation approved in SecureVector" if approver == "person"
                         else "Delegation approved by the delegation policy"),
                 harness=parent.get("executor_id"), session_id=session,
                 detail=_parent_detail(row, approver=approver))
    allowlist = policy.get("folder_allowlist") or []
    workspace = parent.get("workspace")
    approved = row["folder"]

    def folder_check(path: str) -> bool:
        return resolve_folder(path, workspace, allowlist) == approved

    from securevector.app.terminals.executors import EXECUTORS

    # A harness whose Guard reports ready gets its first prompt pasted after
    # that hook; one with no ready signal gets it on the command line.
    executor = EXECUTORS[row["harness"]]
    by_argv = bool(executor.prompt_argv) and not executor.ready_hook
    first = paste_text(row.get("prompt_text") or "")
    try:
        child = await manager.spawn(row["harness"], row["folder"], title=child_title(row.get("prompt_text")), origin="delegate",
                                    parent_task_id=row["parent_task_id"], folder_check=folder_check,
                                    initial_prompt=first if by_argv else None)
    except Exception as e:  # noqa: BLE001
        from securevector.app.terminals.manager import FolderOutOfScope

        from securevector.app.terminals.worktree import WorktreeError

        msg = (str(e) if isinstance(e, (FolderOutOfScope, WorktreeError))
               else f"The task could not start ({type(e).__name__}).")
        row = await _refuse_row(db, manager, row, msg, check="launch", state="failed")
        return view(row)
    child_id = child["id"]
    parent_id = row["parent_task_id"]
    if parent_id not in getattr(manager, "_running", set()) or parent_id in getattr(manager, "_stop_requested", set()):
        # The parent stopped while the child was starting: stop the child too.
        try:
            await manager.stop(child_id, origin="process")
        except Exception:  # noqa: BLE001
            logger.warning("stopping delegated task %s failed after its parent ended", child_id, exc_info=True)
        await _update(db, row["id"], child_task_id=child_id)
        row = await _get(db, row["id"])
        row = await _refuse_row(db, manager, row, "The requesting task has ended.", check="launch", state="failed")
        return view(row)
    await _update(db, row["id"], state="running", child_task_id=child_id)
    row = await _get(db, row["id"])
    if by_argv:
        await _scrub(db, row)
        row = await _get(db, row["id"])
    else:
        manager.deliver_prompt(child_id, row.get("prompt_text") or "", quiet=not executor.ready_hook)
    detail = _parent_detail(row)
    await _audit(db, "delegation.launched", "allow", reason="Delegated task launched",
                 harness=parent.get("executor_id"), session_id=session, detail=detail)
    await _audit(db, "delegation.launched", "allow", reason="Launched by delegation",
                 harness=row["harness"], session_id=child.get("session_id"), detail=dict(detail, role="child"))
    await _task_event(store, row["parent_task_id"], f"launched {row['id']} as {child_id}")
    await _task_event(store, child_id, f"delegated by {row['parent_task_id']} ({row['id']})")
    return view(row)


async def deny(db, manager, request_id: str, reason: Optional[str] = None) -> Optional[dict]:
    from securevector.app.database.repositories.jit_access import JitAccessRepository

    row = await by_request(db, request_id)
    if row is None:
        return None
    if not await JitAccessRepository(db).decide_delegate_request(request_id, False, reason):
        return view(await _get(db, row["id"]))
    text = "Denied in SecureVector." + (f" {reason.strip()[:200]}" if isinstance(reason, str) and reason.strip() else "")
    row = await _refuse_row(db, manager, row, text, check="approval")
    return view(row)


# --- results --------------------------------------------------------------------------


_ENDED = ("done", "exited", "stopped", "interrupted", "failed")


async def _tool_calls_after_delivery(db, store, child: dict) -> int:
    """Audited tool calls of the child's session since its prompt was
    delivered (SecureVector's own rows excluded)."""
    sid = child.get("session_id")
    if not sid:
        return 0
    delivered = [ev for ev in await store.list_events(child["id"], limit=2000) if ev.get("kind") == "delegate_prompt"]
    if not delivered:
        return 0
    since = str(delivered[0].get("created_at") or "").replace("T", " ")[:19]
    found = await db.fetch_one(
        "SELECT COUNT(*) AS n FROM tool_call_audit WHERE session_id = ? AND called_at >= ? "
        "AND tool_id NOT IN (?, '__session_start__') AND COALESCE(function_name, '') NOT LIKE '\\_\\_%' ESCAPE '\\'",
        (sid, since, AUDIT_TOOL_ID),
    )
    return int(found["n"] or 0) if found else 0


def no_changes_result(executor_id: Optional[str]) -> str:
    return f"{_label(executor_id)} finished without making any changes. Its model may not support tool use."


async def _prompt_delivered(store, child_task_id: str) -> bool:
    return any(ev.get("kind") == "delegate_prompt" for ev in await store.list_events(child_task_id, limit=2000))


async def _child_done(store, child: dict) -> bool:
    if child.get("ended_at") or child.get("status") in _ENDED:
        return True
    events = await store.list_events(child["id"], limit=2000)
    delivered = None
    for ev in events:
        if ev.get("kind") == "delegate_prompt":
            delivered = ev.get("seq")
        elif delivered is not None and ev.get("kind") == "hook" and str(ev.get("detail") or "").endswith("-> idle"):
            return True
    return False


def _result_pending(row: dict) -> bool:
    if row.get("state") != "done" or row.get("result_text") is not None:
        return False
    try:
        return bool((json.loads(row.get("result_flag") or "{}") or {}).get("pending"))
    except ValueError:
        return False


async def _read_transcript(harness: str, session_id: Optional[str], tries: int) -> Optional[str]:
    """The last assistant message, read off the event loop. A transcript is
    often written a moment after the harness reports the turn ended, and the
    session id can arrive after that, so a first read retries briefly."""
    for attempt in range(max(1, tries)):
        if session_id:
            try:
                text = await asyncio.to_thread(last_assistant_text, harness, session_id)
            except Exception:  # noqa: BLE001
                text = None
            if text is not None:
                return text
        if attempt + 1 < tries:
            await asyncio.sleep(RESULT_RETRY_S)
    return None


async def refresh(db, manager, row: dict, *, quick: bool = False) -> dict:
    """Finish a running delegation when its child is done, and keep reading
    the transcript for a result still pending. Idempotent. `quick` reads
    the transcript once, without the retry wait (page loads and counts)."""
    global _finalize_lock
    pending = _result_pending(row)
    if (row.get("state") not in LIVE_STATES and not pending) or not row.get("child_task_id") or manager is None:
        return row
    store = manager.store
    child = await store.get_task(row["child_task_id"])
    if child is None:
        if pending:
            return row
        await _update(db, row["id"], state="failed", refusal_reason="The delegated task is gone.", ended_at=_now())
        return await _get(db, row["id"])
    if not pending and not await _child_done(store, child):
        return row
    if not pending and not await _prompt_delivered(store, child["id"]):
        # Ended before its prompt was delivered: it did no delegated work.
        if _finalize_lock is None:
            _finalize_lock = asyncio.Lock()
        async with _finalize_lock:
            current = await _get(db, row["id"]) or row
            if current.get("state") in LIVE_STATES:
                return await _refuse_row(db, manager, current, "The child ended before the prompt was delivered.",
                                         check="ready", state="failed")
            return current
    harness = child.get("executor_id") or row.get("harness")
    text = None
    if harness in TRANSCRIPT_HARNESSES:
        text = await _read_transcript(harness, child.get("session_id"),
                                      1 if pending or quick else RESULT_RETRIES)
        if text is None:
            from securevector.app.terminals.store import age_seconds

            ended = bool(child.get("ended_at"))
            age = age_seconds(child.get("ended_at")) if ended else None
            if not ended or age is None or age < RESULT_GIVE_UP_S:
                if _finalize_lock is None:
                    _finalize_lock = asyncio.Lock()
                async with _finalize_lock:
                    current = await _get(db, row["id"]) or row
                    if current.get("state") in LIVE_STATES:
                        await _update(db, row["id"], state="done", result_text=None,
                                      result_flag=json.dumps({"pending": True}), ended_at=_now())
                        current = await _get(db, row["id"])
                    return current
            text = NO_TRANSCRIPT_RESULT
    if _finalize_lock is None:
        _finalize_lock = asyncio.Lock()
    async with _finalize_lock:
        row = await _get(db, row["id"]) or row
        if row.get("state") not in LIVE_STATES and not _result_pending(row):
            return row
        if text is None:
            # No final message for this harness: say whether it did anything.
            if await _tool_calls_after_delivery(db, store, child) == 0:
                text = no_changes_result(harness)
            else:
                text = NO_TEXT_RESULT
            scanned = {"level": "clean", "reasons": []}
        elif text == NO_TRANSCRIPT_RESULT:
            scanned = {"level": "clean", "reasons": []}
        else:
            text = cap_text(text)
            try:
                scanned = await scan_text(db, text, direction="incoming")
            except Exception as e:  # noqa: BLE001 - unscanned text is held
                logger.warning("Delegation result scan failed: %s", type(e).__name__)
                scanned = {"level": "block", "reasons": ["scan unavailable"]}
        held = scanned["level"] != "clean"
        await _update(db, row["id"], state="held" if held else "done", result_text=text,
                      result_flag=json.dumps({"level": scanned["level"], "reasons": scanned["reasons"]}) if held else None,
                      ended_at=row.get("ended_at") or _now())
        row = await _get(db, row["id"])
        parent = await store.get_task(row["parent_task_id"])
        detail = _parent_detail(row, state=row["state"], result_sha256=_sha(text),
                                result_length=len(text.encode("utf-8", "replace")),
                                exit_code=child.get("exit_code"), flags=scanned["reasons"])
        reason = "Delegated result held for review" if held else "Delegated task finished"
        await _audit(db, "delegation.result", "log_only", reason=reason,
                     harness=parent and parent.get("executor_id"), session_id=parent and parent.get("session_id"),
                     detail=detail)
        await _audit(db, "delegation.result", "log_only", reason=reason, harness=harness,
                     session_id=child.get("session_id"), detail=dict(detail, role="child"))
        await _task_event(store, row["parent_task_id"], f"result {row['id']}: {row['state']}")
        return row


async def _running_for_child(db, child_task_id: str) -> Optional[dict]:
    found = await db.fetch_one(
        "SELECT * FROM delegations WHERE child_task_id = ? AND state IN ('running', 'waiting_for_user')",
        (child_task_id,))
    return dict(found) if found else None


async def on_prompt_delivered(manager, child_task_id: str) -> None:
    """The prompt reached the child: the stored copy is no longer needed."""
    db = manager.store.db
    row = await _running_for_child(db, child_task_id)
    if row:
        if row.get("state") == "waiting_for_user":
            await _update(db, row["id"], state="running", refusal_reason=None)
        await _scrub(db, row)


# Dialogs a harness shows before it takes input, which only the person may
# answer. Matched on the letters of the screen's tail, since a TUI draws
# words with cursor moves in between.
_DIALOGS = (
    (("trustthisfolder",), "trust this folder"),
    (("doyoutrustthefilesinthisfolder",), "trust this folder"),
    (("isthisaprojectyoucreatedoroneyoutrust",), "trust this folder"),
    (("updatenow", "skipuntilnextversion"), "answer the update prompt"),
    (("hooksneedreview",), "review the harness hooks"),
    (("continuewithouttrusting",), "review the harness hooks"),
)
_ANSI_RE = re.compile(rb"\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]")
DIALOG_TAIL_BYTES = 6144


def user_dialog(screen: bytes) -> Optional[str]:
    """The waiting reason when the end of the child's screen output shows a
    dialog only the person can answer, else None."""
    if not screen:
        return None
    tail = _ANSI_RE.sub(b" ", screen[-DIALOG_TAIL_BYTES:]).decode("utf-8", "ignore").lower()
    letters = re.sub(r"[^a-z]", "", tail)
    for needles, what in _DIALOGS:
        if all(n in letters for n in needles):
            return f"Waiting for you in the child pane: {what}"
    return None


def _label(executor_id: Optional[str]) -> str:
    from securevector.app.terminals.executors import EXECUTORS

    executor = EXECUTORS.get(executor_id or "")
    return executor.label if executor else "this harness"


def guard_silent_reason(executor_id: Optional[str]) -> str:
    label = _label(executor_id)
    return (f"SecureVector Guard did not report from this {label} session. "
            f"Its hooks may need approval in {label}.")


async def on_guard_silent(manager, child_task_id: str, reason: str) -> None:
    """The child got its prompt but its Guard never reported: it ran
    ungoverned, so the delegation fails with that reason."""
    db = manager.store.db
    row = await _running_for_child(db, child_task_id)
    if row:
        await _refuse_row(db, manager, row, reason, check="governed", state="failed")


def guard_missing_reason(executor_id: Optional[str]) -> str:
    return (f"SecureVector Guard is not installed for {_label(executor_id)}. "
            "Install it from Connect Agents, then try again.")


def guard_not_running_reason(executor_id: Optional[str]) -> str:
    return (f"SecureVector Guard is not running in this {_label(executor_id)} session, so the task was not "
            "started. Open the child pane to check, or reinstall the Guard from Connect Agents.")


def reason_code(reason: Optional[str]) -> Optional[str]:
    """A stable code for the Guard-related reasons above, so readers match on
    the code and not on wording. Derived from the same builders' fixed openings."""
    text = str(reason or "")
    if text.startswith("SecureVector Guard did not report from this"):
        return "guard_silent"
    if text.startswith("SecureVector Guard is not installed for"):
        return "guard_missing"
    if text.startswith("SecureVector Guard is not running in this"):
        return "guard_not_running"
    return None


async def on_waiting_for_user(manager, child_task_id: str, reason: str) -> None:
    """The child shows a dialog for the person: the delegation and the
    child's card say so. Nothing is typed into it."""
    db = manager.store.db
    row = await _running_for_child(db, child_task_id)
    if row and row.get("state") in LIVE_STATES and row.get("refusal_reason") != reason:
        await _update(db, row["id"], state="waiting_for_user", refusal_reason=reason)
        await _task_event(manager.store, row["parent_task_id"], f"waiting {row['id']}")
    try:
        await manager.store.update_status(child_task_id, "blocked", activity=reason)
    except Exception:  # noqa: BLE001
        logger.debug("child status update failed", exc_info=True)


async def on_prompt_not_ready(manager, child_task_id: str, reason: Optional[str] = None) -> None:
    """The child was not ready for its prompt in time; nothing was typed."""
    db = manager.store.db
    row = await _running_for_child(db, child_task_id)
    if row:
        await _refuse_row(db, manager, row, reason or "The child did not become ready.", check="ready",
                          state="failed")


async def on_child_event(manager, child_task_id: str) -> None:
    """Called by the terminal manager when a delegated task goes idle or
    exits."""
    db = manager.store.db
    found = await db.fetch_one(
        "SELECT * FROM delegations WHERE child_task_id = ? AND state IN ('running', 'waiting_for_user')",
        (child_task_id,))
    if found:
        await refresh(db, manager, dict(found))


async def get_for_caller(db, manager, caller, delegation_id: str) -> Optional[dict]:
    """The caller's own delegation, refreshed; None for any other id."""
    if not isinstance(delegation_id, str) or not caller.verified or not caller.task_id:
        return None
    row = await _get(db, delegation_id)
    if row is None or row.get("parent_task_id") != caller.task_id:
        return None
    row = await refresh(db, manager, row)
    out = view(row)
    if row.get("child_task_id") and manager is not None:
        child = await manager.store.get_task(row["child_task_id"])
        if child:
            out["exit_code"] = child.get("exit_code")
            out["child_status"] = child.get("status")
    return out


async def release(db, manager, delegation_id: str) -> Optional[dict]:
    row = await _get(db, delegation_id)
    if row is None or row.get("state") != "held":
        return None
    await _update(db, delegation_id, state="done")
    row = await _get(db, delegation_id)
    await _decision_audit(db, manager, row, "Held result released in SecureVector")
    return view(row)


async def discard(db, manager, delegation_id: str) -> Optional[dict]:
    row = await _get(db, delegation_id)
    if row is None or row.get("state") != "held":
        return None
    flag = {}
    try:
        flag = json.loads(row.get("result_flag") or "{}") or {}
    except ValueError:
        flag = {}
    flag["discarded"] = True
    await _update(db, delegation_id, state="done", result_text=None, result_flag=json.dumps(flag))
    row = await _get(db, delegation_id)
    await _decision_audit(db, manager, row, "Held result discarded in SecureVector")
    return view(row)


async def _decision_audit(db, manager, row: dict, reason: str) -> None:
    store = manager.store if manager is not None else None
    parent = await store.get_task(row["parent_task_id"]) if store else None
    await _audit(db, "delegation.result", "log_only", reason=reason, harness=parent and parent.get("executor_id"),
                 session_id=parent and parent.get("session_id"), detail=_parent_detail(row, state=row["state"]))
    await _task_event(store, row["parent_task_id"], f"{reason.split(' in ')[0].lower()} {row['id']}")


def view(row: Optional[dict]) -> dict:
    """What the caller sees. A held result carries no text; a refused one
    carries its reason."""
    if not row:
        return {"delegation_id": None, "state": "failed", "reason": "Not found."}
    state = row.get("state")
    out = {
        "delegation_id": row.get("id"),
        "state": state,
        "harness": row.get("harness"),
        "folder": row.get("folder"),
        "child_task_id": row.get("child_task_id"),
        "reason": row.get("refusal_reason") if state in ("refused", "failed", "waiting_for_user") else None,
        "result": None,
    }
    out["reason_code"] = reason_code(out["reason"])
    if _result_pending(row):
        out["result_pending"] = True
        out["reason"] = RESULT_PENDING_NOTE
    elif state == "done":
        discarded = False
        try:
            discarded = bool((json.loads(row.get("result_flag") or "{}") or {}).get("discarded"))
        except ValueError:
            discarded = False
        out["result"] = row.get("result_text")
        if discarded:
            out["reason"] = "The result was discarded in SecureVector."
    elif state == "held":
        out["reason"] = HELD_NOTE
    elif state == "pending_approval":
        out["reason"] = "Waiting for approval in SecureVector."
    return out
