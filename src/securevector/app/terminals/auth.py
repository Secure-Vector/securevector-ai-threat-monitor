"""Browser-side hardening for the Terminals control surface.

Threat model: a page in another origin (a tab the user opened) trying to
drive the loopback API from the browser. Defences, all enforced per
request: a per-install token carried in an HttpOnly cookie (never a bare
query parameter), Host validation, Origin validation on every state change
and on the WebSocket upgrade, and a custom header on every route the UI
calls (reads included) so neither a cross-site form post nor a same-site
<img>/form GET -- which carries the cookie under SameSite=strict but can't
set custom headers or an Origin -- can qualify.
"""

from __future__ import annotations

import errno
import os
import secrets
from pathlib import Path
from typing import Dict, Mapping, NoReturn, Optional

from fastapi import HTTPException, Request, Response, WebSocket

COOKIE = "sv_terminals"
HEADER = "X-SV-Terminals"
COOKIE_PATH = "/api/terminals"
_LOOPBACK = ("127.0.0.1", "localhost", "[::1]")


def token_path(data_dir: Path) -> Path:
    return Path(data_dir) / "terminals" / "ui-token"


def load_or_create_token(data_dir: Path) -> str:
    path = token_path(data_dir)
    # mode= is subject to umask, so also chmod explicitly below; on Windows
    # (os.name == "nt") neither call restricts access the way POSIX chmod
    # does -- permission enforcement there relies on the parent directory's
    # ACL, inherited by any file created under it.
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.name == "posix":
        try:
            os.chmod(path.parent, 0o700)
        except OSError as exc:
            raise RuntimeError(
                f"Terminals token directory is not owned by the current user: {path.parent}"
            ) from exc
    if path.exists():
        existing = path.read_text().strip()
        if len(existing) >= 32:
            owned_by_us = True
            if os.name == "posix":
                owned_by_us = os.stat(path).st_uid == os.getuid()
            if owned_by_us:
                if os.name == "posix":
                    os.chmod(path, 0o600)
                return existing
            # Existing file belongs to another OS user: don't trust it as a
            # secret only we hold. We own the 0700 parent, so removing it
            # (even though we can't open it for writing) succeeds; fall
            # through and rotate.
            # POSIX-only: owned_by_us is always True on Windows.
            path.unlink()
    token = secrets.token_hex(24)
    open_flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    if os.name == "posix":
        # Refuse to write through a symlink planted at this path.
        open_flags |= os.O_NOFOLLOW
    try:
        fd = os.open(path, open_flags, 0o600)
    except OSError as exc:
        if os.name == "posix" and exc.errno == errno.ELOOP:
            raise RuntimeError(
                f"Refusing to write the terminals token through a symlink: {path}"
            ) from exc
        raise
    with os.fdopen(fd, "w") as fh:
        fh.write(token)
    if os.name == "posix":
        os.chmod(path, 0o600)
    return token


class TerminalAuth:
    def __init__(self, token: str, port: int) -> None:
        self.token = token
        self.port = port
        self.allowed_hosts = {f"{h}:{port}" for h in _LOOPBACK}
        self.allowed_origins = {f"http://{h}:{port}" for h in _LOOPBACK}

    # -- primitives ----------------------------------------------------------

    def _cookie_ok(self, cookies: Mapping[str, str]) -> bool:
        value = cookies.get(COOKIE)
        if not value:
            return False
        # A cookie value can carry non-ASCII bytes (e.g. via a crafted
        # request); encode explicitly rather than let compare_digest raise
        # TypeError, which would surface as a 500 instead of a 403.
        value_bytes = value.encode("utf-8", "surrogateescape")
        return secrets.compare_digest(value_bytes, self.token.encode("utf-8"))

    def _host_ok(self, headers: Mapping[str, str]) -> bool:
        return headers.get("host", "") in self.allowed_hosts

    def _origin_ok(self, headers: Mapping[str, str], *, required: bool) -> bool:
        origin = headers.get("origin")
        if origin is None:
            return not required
        return origin in self.allowed_origins

    @staticmethod
    def _deny() -> NoReturn:
        raise HTTPException(status_code=403, detail="Terminals: request not authorised")

    # -- FastAPI dependencies -------------------------------------------------

    async def _check(self, request: Request, *, origin_required: bool) -> None:
        if not (
            self._host_ok(request.headers)
            and self._origin_ok(request.headers, required=origin_required)
            and self._cookie_ok(request.cookies)
            and request.headers.get(HEADER) == "1"
        ):
            self._deny()

    async def require_read(self, request: Request) -> None:
        await self._check(request, origin_required=False)

    async def require_write(self, request: Request) -> None:
        await self._check(request, origin_required=True)

    async def session_response(self, request: Request, response: Response) -> Dict[str, bool]:
        """Issue the cookie. Host must match; Origin, if present, must match."""
        if not (
            self._host_ok(request.headers) and self._origin_ok(request.headers, required=False)
        ):
            self._deny()
        response.set_cookie(COOKIE, self.token, httponly=True, samesite="strict", path=COOKIE_PATH)
        response.headers["Cache-Control"] = "no-store"
        return {"ok": True}

    def check_ws(self, websocket: WebSocket) -> bool:
        return (
            self._host_ok(websocket.headers)
            and self._origin_ok(websocket.headers, required=True)
            and self._cookie_ok(websocket.cookies)
        )


def get_auth(request: Request) -> TerminalAuth:
    auth: Optional[TerminalAuth] = getattr(request.app.state, "terminal_auth", None)
    if auth is None:
        raise HTTPException(status_code=503, detail="Terminals are not initialised")
    return auth
