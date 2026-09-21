"""Shared gate for the plugin install and uninstall routes.

These live under /api/hooks rather than /api/terminals, so the terminals
cookie (scoped to COOKIE_PATH) is never sent to them. All twelve install and
uninstall routes across the six harnesses were therefore reachable with no
headers at all: a page on any origin could POST /api/hooks/<harness>/uninstall
and remove a Guard, and CORS would hide only the reply, not the effect.

Host plus a REQUIRED matching Origin is the check that answers that. It is
deliberately weaker than the terminals quartet because it has to be: the
Integrations page cannot present a cookie it is never sent.
"""

from __future__ import annotations

from typing import Optional

from fastapi import HTTPException, Request
from pydantic import BaseModel, ConfigDict

# The loopback set is imported, never restated: if a second bind host or an
# IPv6 form is ever added to one of these, a private copy here would quietly
# keep refusing it.
from securevector.app.terminals.auth import _LOOPBACK, TerminalAuth


class ForceBody(BaseModel):
    """`force` in a JSON body, never a query string.

    A query parameter is reachable from a plain link and from a form, and it
    lands in server logs and browser history. A JSON body additionally forces
    a Content-Type that a simple cross-origin form cannot set, so it is one
    more thing an attacking page has to get past on top of the Origin check.
    """

    model_config = ConfigDict(extra="forbid")
    force: bool = False


def _allowed(port: int) -> tuple[set, set]:
    return (
        {f"{h}:{port}" for h in _LOOPBACK},
        {f"http://{h}:{port}" for h in _LOOPBACK},
    )


async def require_local_origin(request: Request) -> None:
    """Refuse anything that is not this app's own page talking to itself.

    Derived from the server's own bound port rather than from TerminalAuth.
    Terminals is one feature; installing a Guard plugin is another, and it
    shipped first. Hanging this check off `app.state.terminal_auth` meant that
    if Terminals failed to initialise for any reason, all eight install and
    uninstall routes answered 503 and Guard installation was silently dead for
    every harness. Failing closed is right for a route that deletes files; it
    is not right to couple a 5.x feature's availability to a 6.0 one's startup.

    Falls back to TerminalAuth only when the port is not on app.state, so an
    embedding that wires things differently still gets a check rather than
    none.
    """
    port = getattr(request.app.state, "port", None)
    if isinstance(port, int) and port > 0:
        hosts, origins = _allowed(port)
        headers = request.headers
        origin = headers.get("origin")
        # Origin is REQUIRED, not merely validated when present: treating
        # "absent" as acceptable is what left these reachable from a bare curl.
        if headers.get("host", "") in hosts and origin is not None and origin in origins:
            return
        raise HTTPException(status_code=403, detail="Forbidden")
    auth: Optional[TerminalAuth] = getattr(request.app.state, "terminal_auth", None)
    if auth is None:
        raise HTTPException(
            status_code=503,
            detail="The local app is still starting up. Try again in a moment.",
        )
    await auth.require_local_write(request)
