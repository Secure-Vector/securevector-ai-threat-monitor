"""Claude Code hook relay for Agent Terminals.

Runs inside a launched task on every registered hook event. Reads the hook
payload from stdin, forwards a trimmed copy to the local app, and always
exits 0 without writing to stdout so the task never notices a relay
failure. Standard library only: this must start fast and must not import
the app.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.parse
import urllib.request

PREVIEW_LIMIT = 200
FORWARDED = ("hook_event_name", "session_id", "tool_name", "notification_type", "message", "cwd")
# PostToolUse can carry a large tool_response; cap the read but always drain
# the rest of stdin below so the parent process never sees EPIPE.
STDIN_LIMIT = 4_000_000

# The child env deliberately forwards HTTP_PROXY/http_proxy for the task's
# own use, but the loopback call to the local app must never go through a
# proxy (a proxied machine would otherwise leak the token and payload to
# whatever host the proxy points at). Build a proxy-free opener explicitly.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _post(url: str, body: dict, token: str) -> None:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={"Content-Type": "application/json", "X-SV-Terminal-Hook": token},
    )
    with _OPENER.open(req, timeout=2):
        pass


def main() -> int:
    task_id = os.environ.get("SV_TERMINAL_TASK_ID")
    port = os.environ.get("SV_TERMINAL_PORT")
    token = os.environ.get("SV_TERMINAL_HOOK_TOKEN")
    if not (task_id and port and token):
        return 0
    try:
        raw = sys.stdin.read(STDIN_LIMIT)
        sys.stdin.read()  # drain any remainder so the writer never sees EPIPE
        payload = json.loads(raw) if raw.strip() else {}
        if not isinstance(payload, dict):
            return 0
        body = {key: payload[key] for key in FORWARDED if key in payload}
        if "tool_input" in payload:
            try:
                body["tool_input_preview"] = json.dumps(payload["tool_input"])[:PREVIEW_LIMIT]
            except (TypeError, ValueError):
                body["tool_input_preview"] = str(payload["tool_input"])[:PREVIEW_LIMIT]
        if "hook_event_name" not in body:
            return 0
        safe_task_id = urllib.parse.quote(task_id, safe="")
        url = f"http://127.0.0.1:{int(port)}/api/terminals/tasks/{safe_task_id}/events"
        _post(url, body, token)
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
