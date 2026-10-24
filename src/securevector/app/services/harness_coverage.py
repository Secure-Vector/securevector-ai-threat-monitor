"""What SecureVector can see and stop for each agent runtime.

A static table: one entry per runtime_kind, read by the Observability pages
to say how much of a session was checked. Values describe the Guard code that
ships in this repository; where the code did not settle a value, the less
capable one is recorded.

Evidence (paths relative to src/securevector/; P = plugins, R = app/server/routes):

claude-code
  enforced=before_call   P/claude-code/hooks/hooks.json:5 (matcher ".*"), hooks/pre-tool-use.js:346 (deny/ask)
  egress_visible=True    P/claude-code/lib/client.js:180 (/api/egress/evaluate), hooks/pre-tool-use.js:418
  token_data=True        R/traces.py:404 (claude-code, codex only), R/transcript_generations.py:566
  session_id_sent=True   hooks/pre-tool-use.js:315, lib/client.js:129
  approvals=True         hooks/pre-tool-use.js:495-500 (POST /api/jit/requests)
codex
  enforced=before_call   P/codex/hooks/hooks.json:15, hooks/pre-tool-use.js:229-243 (ask becomes deny)
  egress_visible=True    hooks/pre-tool-use.js:428, P/codex/lib/client.js:170
  token_data=True        R/traces.py:404, R/transcript_generations.py:650,681
  session_id_sent=True   hooks/pre-tool-use.js:480, lib/client.js:129
  approvals=True         hooks/pre-tool-use.js:505
copilot-cli
  enforced=before_call   P/copilot-cli/hooks/hooks.json:15, hooks/pre-tool-use.js:182,187
  egress_visible=True    hooks/pre-tool-use.js:367, P/copilot-cli/lib/client.js:170
  token_data=False       R/traces.py:404 (not parsed per run; R/hooks_copilot_cli.py:697 is a device total)
  session_id_sent=True   hooks/pre-tool-use.js:153, lib/client.js:129
  approvals=True         hooks/pre-tool-use.js:467
opencode
  enforced=before_call   P/opencode/index.js:138,199 (tool.execute.before throws); ask is audited and allowed
  egress_visible=True    P/opencode/lib/decide.js:142,177-189, lib/client.js:169
  token_data=False       R/traces.py:404 (R/hooks_opencode.py:702 is a device total)
  session_id_sent=True   P/opencode/index.js:141,155,178
  approvals=True         P/opencode/index.js:178, lib/decide.js:183
cursor
  enforced=before_call   P/cursor/hooks/hooks.json:10,16 (shell and MCP only); file reads observe only
                         (hooks/before-read-file.js:8-14), edits after the call (hooks/after-file-edit.js)
  egress_visible=True    P/cursor/lib/client.js:163, lib/decide.js:228-240 (shell and MCP only)
  token_data=False       no token source in the plugin or its routes
  session_id_sent=True   P/cursor/lib/decide.js:187,203-205 (conversation_id)
  approvals=True         P/cursor/lib/decide.js:117
antigravity
  enforced=before_call   P/antigravity/hooks.json:6, hooks/pre-tool-use.js:256
  egress_visible=True    hooks/pre-tool-use.js:535, P/antigravity/lib/client.js:177 (MCP name shape unverified, :63)
  token_data=False       no token source
  session_id_sent=True   hooks/pre-tool-use.js:238, lib/client.js:129
  approvals=True         hooks/pre-tool-use.js:548
openclaw
  enforced=after_call    P/openclaw/index.ts:492 (after_tool_call only), :469-482 (block recorded as log_only
                         unless the proxy blocks)
  egress_visible=True    P/openclaw/index.ts:177-180 (evaluated after the call, recorded only)
  token_data=True        P/openclaw/index.ts:630-646 (llm_output -> /api/costs/track, :146)
  session_id_sent=True   P/openclaw/index.ts:220
  approvals=False        no /api/jit/requests call; policy fetched with no runtime (index.ts:93)
govrun
  enforced=after_call    app/terminals/executors.py:139-144 (reports through its own Guard; no hook
                         route or plugin here, so SecureVector only sees what it records)
  egress_visible=False, token_data=False, session_id_sent=False, approvals=False: no evidence in this repo
hermes
  enforced=after_call    R/tool_permissions.py:332-338,684-693 (decided by the external Hermes SDK);
                         R/hooks_hermes.py:199 is a device token total only
  egress_visible=False, token_data=False, session_id_sent=False, approvals=False: no evidence in this repo

Common to every plugin: hosts are checked only when they can be read from the
tool input or the MCP endpoint, so network opened by child processes is not
seen, and every plugin lets the call through when the app is not reachable.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Optional

CHILD_NET = "network from child processes"
FAIL_OPEN = "calls pass when SecureVector is not running"
NO_APPROVALS = "approvals not supported"

COVERAGE: dict = {
    "claude-code": {
        "enforced": "before_call", "egress_visible": True, "token_data": True,
        "session_id_sent": True, "approvals": True,
        "unchecked": [CHILD_NET, FAIL_OPEN],
    },
    "codex": {
        "enforced": "before_call", "egress_visible": True, "token_data": True,
        "session_id_sent": True, "approvals": True,
        "unchecked": [CHILD_NET, FAIL_OPEN],
    },
    "copilot-cli": {
        "enforced": "before_call", "egress_visible": True, "token_data": False,
        "session_id_sent": True, "approvals": True,
        "unchecked": [CHILD_NET, FAIL_OPEN],
    },
    "opencode": {
        "enforced": "before_call", "egress_visible": True, "token_data": False,
        "session_id_sent": True, "approvals": True,
        "unchecked": ["rules set to ask are allowed without asking", CHILD_NET, FAIL_OPEN],
    },
    "cursor": {
        "enforced": "before_call", "egress_visible": True, "token_data": False,
        "session_id_sent": True, "approvals": True,
        "unchecked": ["file reads and edits", "built-in web and search tools", CHILD_NET, FAIL_OPEN],
    },
    "antigravity": {
        "enforced": "before_call", "egress_visible": True, "token_data": False,
        "session_id_sent": True, "approvals": True,
        "unchecked": ["MCP tool names not verified", CHILD_NET, FAIL_OPEN],
    },
    "openclaw": {
        "enforced": "after_call", "egress_visible": True, "token_data": True,
        "session_id_sent": True, "approvals": False,
        "unchecked": ["calls run before they are recorded", NO_APPROVALS,
                      "blocking needs the SecureVector proxy", CHILD_NET],
    },
    "govrun": {
        "enforced": "after_call", "egress_visible": False, "token_data": False,
        "session_id_sent": False, "approvals": False,
        "unchecked": ["decisions made by its own Guard, not by SecureVector", NO_APPROVALS,
                      "network not checked"],
    },
    "hermes": {
        "enforced": "after_call", "egress_visible": False, "token_data": False,
        "session_id_sent": False, "approvals": False,
        "unchecked": ["decisions made by the Hermes SDK, not by SecureVector",
                      "MCP tools not in the tool list", NO_APPROVALS, "network not checked"],
    },
}

_UNKNOWN = {
    "enforced": "none", "egress_visible": False, "token_data": False,
    "session_id_sent": False, "approvals": False,
    "unchecked": ["no SecureVector Guard for this agent"],
}


def _level(entry: dict) -> str:
    if entry["enforced"] != "before_call":
        return "not_enforced"
    return "partial" if entry["unchecked"] else "full"


def coverage(kind: Optional[str]) -> dict:
    """The entry for one runtime_kind (a copy), with `runtime_kind`, `level`
    (full | partial | not_enforced) and `label`. Unknown kinds read as not
    enforced."""
    entry = deepcopy(COVERAGE.get(kind or "", _UNKNOWN))
    entry["runtime_kind"] = kind or None
    entry["level"] = _level(entry)
    entry["label"] = label(kind)
    return entry


def label(kind: Optional[str]) -> str:
    """A short phrase for a badge, e.g. "partial · 2 paths not checked"."""
    entry = COVERAGE.get(kind or "", _UNKNOWN)
    if entry["enforced"] == "after_call":
        return "not enforced · recorded after the call"
    if entry["enforced"] != "before_call":
        return "not enforced · not checked"
    n = len(entry["unchecked"])
    if not n:
        return "enforced before the call"
    return f"partial · {n} path{'s' if n != 1 else ''} not checked"


def table() -> dict:
    """Every known runtime's entry, keyed by runtime_kind."""
    return {kind: coverage(kind) for kind in COVERAGE}
