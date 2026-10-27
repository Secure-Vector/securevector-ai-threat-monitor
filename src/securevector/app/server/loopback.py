"""Loopback checks shared by the routes that answer only on this machine.

A request is "on this machine" when its peer is a loopback address AND its
Host header names this machine (localhost, 127.0.0.1 or [::1]).

Loopback is always local: a remote access proxy may never be listed by a
loopback address. As a defence, while Remote access mode is on, a loopback
request carrying any forwarding header (X-Forwarded-*, Forwarded,
X-Real-IP) is never "on this machine": it came through a proxy.
"""

from __future__ import annotations

import ipaddress
from typing import Any, Optional

LOOPBACK_NAMES = ("127.0.0.1", "localhost", "[::1]")
FORWARD_HEADERS = ("forwarded", "x-real-ip")


def loopback_ip(host: Optional[str]) -> bool:
    """127.0.0.0/8, ::1 or an IPv4-mapped 127.x address."""
    try:
        ip = ipaddress.ip_address(str(host or "").strip())
    except ValueError:
        return False
    mapped = getattr(ip, "ipv4_mapped", None)
    return (mapped or ip).is_loopback


def loopback_host_header(value: Optional[str]) -> bool:
    """Host header naming this machine: localhost, 127.0.0.1 or [::1], with
    an optional port."""
    v = str(value or "").strip().lower()
    if v.startswith("["):
        end = v.find("]")
        if end < 0:
            return False
        name, rest = v[: end + 1], v[end + 1:]
    else:
        name, _, port = v.partition(":")
        rest = ":" + port if port else ""
    port = rest[1:]
    if rest and not (rest.startswith(":") and port.isascii() and port.isdigit()):
        return False
    return name in LOOPBACK_NAMES


def forwarded(headers: Any) -> bool:
    """Any forwarding header: X-Forwarded-*, Forwarded or X-Real-IP."""
    try:
        keys = [str(k).lower() for k in headers.keys()]
    except Exception:  # noqa: BLE001 - a mapping without keys()
        return False
    return any(k.startswith("x-forwarded-") or k in FORWARD_HEADERS for k in keys)


def on_this_machine(peer: Optional[str], host: Optional[str], headers: Any) -> bool:
    if not (loopback_ip(peer) and loopback_host_header(host)):
        return False
    from securevector.app.server import remote_access

    state = remote_access.cached_state()
    if not state.get("remote_access_enabled"):
        return True
    return not forwarded(headers)


def asked_on_this_machine(request: Any) -> bool:
    client = getattr(request, "client", None)
    return on_this_machine(client.host if client else None, request.headers.get("host"), request.headers)
