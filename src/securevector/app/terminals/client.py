"""Talk to a running app's Terminals API from outside the browser.

The API is deliberately awkward to reach by accident: a request must carry a
loopback ``Host``, a matching ``Origin``, the per-install token in an HttpOnly
cookie, and a custom header. That combination is what stops a page in another
tab from driving the local API, and it is not something a stray ``curl`` gets
right by chance. This module is the one supported way to satisfy all four, so
the CLI never reimplements the handshake and cannot drift from it.

Read-only by nature: it holds no state, starts nothing, and fails loudly when
the app is not running rather than trying to start one.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Mapping, Optional

from securevector.app.terminals.auth import COOKIE, HEADER, token_path

RUNTIME_JSON = Path.home() / ".securevector" / "runtime.json"
TIMEOUT_S = 10


class AppNotRunning(RuntimeError):
    """No local app is listening, or it never wrote its runtime file."""


class ApiError(RuntimeError):
    """The app answered, and said no."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


class RedirectRefused(RuntimeError):
    """The port answered with a redirect instead of the API response.

    `urllib.request.urlopen` follows a 30x by default, and CPython's own
    redirect handler carries the original request's headers over onto the
    new one -- the `Cookie: sv_terminals=<token>` included. The one way that
    matters here: `RUNTIME_JSON` can outlive the app that wrote it (a crash
    leaves it behind), and once the OS reassigns that port to something
    else, a redirect from whatever is listening now would hand it the
    per-install token verbatim, to whatever host it names. Nothing this
    client does should ever need to leave 127.0.0.1, so a redirect is a sign
    that port is no longer this app, not a request worth honouring.
    """

    def __init__(self, code: int, location: Optional[str]) -> None:
        super().__init__(f"refused an HTTP {code} redirect to {location or '(no Location header)'}")
        self.code = code
        self.location = location


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Installed in place of the default handler: never follows a redirect.

    `redirect_request` returning a URL is what makes the default handler
    build a second, header-copying request. Raising here instead means no
    second request is ever built, so there is no request for the Cookie
    header to ride along on.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: N802 - urllib's name
        raise RedirectRefused(code, newurl)


# One opener, reused for every call: `urlopen()` has no parameter for
# swapping a handler in, only `install_opener()` (which would reach outside
# this module and affect anyone else importing `urllib.request`) or a
# private opener's own `.open()`. This module already owns its whole request
# path, so the opener lives here instead.
_opener = urllib.request.build_opener(_NoRedirect)


def _data_dir() -> Path:
    """Where the app keeps its token.

    The SAME resolver the server uses when it creates that token
    (`server/app.py` calls `get_app_data_dir()`), not a second copy of the
    per-platform path: a divergence here would read a token no app ever wrote
    and report "open the app once" while the app was running.

    Imported lazily so the CLI still imports when the app extra is absent.
    """
    from securevector.app.utils.platform import get_app_data_dir

    return Path(get_app_data_dir())


def read_port() -> int:
    try:
        raw = json.loads(RUNTIME_JSON.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise AppNotRunning(
            "SecureVector is not running. Start the app, then try again."
        ) from exc
    except (OSError, ValueError) as exc:
        raise AppNotRunning(f"Cannot read {RUNTIME_JSON}: {exc}") from exc
    port = raw.get("web_port")
    if not isinstance(port, int) or not (1 <= port <= 65535):
        raise AppNotRunning(f"{RUNTIME_JSON} names no usable web port.")
    return port


def read_token() -> str:
    path = token_path(_data_dir())
    try:
        token = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError as exc:
        raise AppNotRunning(
            "SecureVector has not created its Terminals token yet. Open the app once."
        ) from exc
    except OSError as exc:
        # 0600 and owned by the installing user, so this is the "wrong user"
        # case rather than a missing file. Say which, because sudo is exactly
        # the wrong fix and someone will try it.
        raise AppNotRunning(
            f"Cannot read {path}: {exc}. It belongs to the user that installed the app."
        ) from exc
    if len(token) < 32:
        raise AppNotRunning("The Terminals token looks truncated; reopen the app.")
    return token


def _detail(exc: "urllib.error.HTTPError") -> str:
    """Whatever the app said, as one line a person can read.

    FastAPI answers a rejected BODY with `detail` as a LIST of validation
    objects, not a string, so the obvious `.get("detail")` prints a raw Python
    list at someone. Flatten those to the fields that were wrong; keep a plain
    string detail as it is; fall back to the status code.
    """
    try:
        body = json.loads(exc.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 - a non-JSON error body is still an error
        return f"HTTP {exc.code}"
    detail = (body or {}).get("detail") if isinstance(body, dict) else None
    if isinstance(detail, str) and detail:
        return detail
    if isinstance(detail, list) and detail:
        parts = []
        for item in detail:
            if not isinstance(item, dict):
                continue
            # loc is ("body", "field"); the field is the part worth naming.
            loc = [str(x) for x in (item.get("loc") or []) if x != "body"]
            msg = item.get("msg") or "is not valid"
            parts.append(f"{'.'.join(loc) or 'request'}: {msg}")
        if parts:
            return "; ".join(parts)
    return f"HTTP {exc.code}"


class TerminalsClient:
    """One app, one token, four headers."""

    def __init__(self, port: Optional[int] = None, token: Optional[str] = None) -> None:
        self.port = port if port is not None else read_port()
        self.token = token if token is not None else read_token()
        self.base = f"http://127.0.0.1:{self.port}"

    def _request(self, method: str, path: str, body: Optional[Mapping[str, Any]] = None) -> Any:
        url = f"{self.base}{path}"
        data = None
        req = urllib.request.Request(url, method=method)
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            req.add_header("Content-Type", "application/json")
        # All four, every time. Host is implied by the URL; the rest are not.
        req.add_header("Origin", self.base)
        req.add_header(HEADER, "1")
        req.add_header("Cookie", f"{COOKIE}={self.token}")
        try:
            with _opener.open(req, data=data, timeout=TIMEOUT_S) as resp:
                raw = resp.read().decode("utf-8") or "null"
        except RedirectRefused as exc:
            raise ApiError(exc.code, str(exc)) from exc
        except urllib.error.HTTPError as exc:
            raise ApiError(exc.code, _detail(exc)) from exc
        except urllib.error.URLError as exc:
            raise AppNotRunning(
                f"Nothing is listening on {self.base}. Start the app, then try again."
            ) from exc
        return json.loads(raw)

    # -- the calls the CLI makes -------------------------------------------

    def tasks(self) -> dict:
        return self._request("GET", "/api/terminals/tasks")

    def executors(self) -> dict:
        return self._request("GET", "/api/terminals/executors")

    def unlinked(self) -> dict:
        return self._request("GET", "/api/terminals/sessions/unlinked")

    def launch(
        self,
        executor_id: str,
        workspace: str,
        *,
        title: Optional[str] = None,
        resume_session_id: Optional[str] = None,
    ) -> dict:
        return self._request(
            "POST",
            "/api/terminals/tasks",
            {
                "executor_id": executor_id,
                "workspace": workspace,
                "title": title,
                "resume_session_id": resume_session_id,
                "origin": "cli",
            },
        )

    def link(
        self,
        executor_id: str,
        session_id: str,
        *,
        workspace: Optional[str] = None,
        title: Optional[str] = None,
    ) -> dict:
        return self._request(
            "POST",
            "/api/terminals/tasks/link",
            {
                "executor_id": executor_id,
                "session_id": session_id,
                "workspace": workspace,
                "title": title,
                "origin": "cli",
            },
        )

    def stop(self, task_id: str) -> dict:
        safe = urllib.parse.quote(task_id, safe="")
        return self._request("POST", f"/api/terminals/tasks/{safe}/stop?origin=cli")

    def stop_all(self) -> dict:
        return self._request("POST", "/api/terminals/stop-all?origin=cli")


__all__ = [
    "TerminalsClient",
    "AppNotRunning",
    "ApiError",
    "RedirectRefused",
    "read_port",
    "read_token",
]
