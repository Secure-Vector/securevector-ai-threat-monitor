"""Agent Config Trust: the opt-in read-only `tools/list` probe.

HTTP transports only, and only for a server the user switched the probe on
for. Three JSON-RPC posts to the configured URL (initialize, the initialized
notification, tools/list with pagination), with the headers the config
names. No process is started, so stdio servers are never probed. Header
values are used for the request and dropped; they are never stored or
logged. The caller records the request in egress_audit.

Redirects are refused (a 3xx is a failure), so a server cannot bounce the
request, headers included, to another host. Loopback, link-local and
metadata addresses and the app's own port are refused. The name is resolved
once, every address is checked, and every request in the probe connects to
that checked address (the Host header, TLS SNI and certificate hostname
check keep the configured name), so a short-TTL name cannot pass the check
and then point the credentials at loopback or a metadata service. The peer
address is verified after each connect. Proxies from the environment are
not used: they would resolve the name themselves. The whole exchange runs
under one deadline.
"""

from __future__ import annotations

import http.client
import ipaddress
import json
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Dict, List, Optional, Tuple

from securevector.app.services.config_trust_scan import tool_entry

TIMEOUT_SECONDS = 5           # connect and per-read ceiling
TOTAL_SECONDS = 10            # the whole probe: initialize, notification, every page
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_PAGES = 5
PROTOCOL_VERSION = "2025-06-18"
# Never probed: loopback, link-local (cloud metadata), unique-local IPv6,
# the unspecified address. Tests narrow this to reach a loopback fixture.
BLOCKED_NETWORKS = tuple(ipaddress.ip_network(n) for n in (
    "127.0.0.0/8", "::1/128", "169.254.0.0/16", "fe80::/10", "fd00::/8", "0.0.0.0/8", "::/128",
))


class ProbeError(Exception):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None  # urllib then raises HTTPError for the 3xx


def _connect(ip: str, port: int, timeout: Optional[float]) -> socket.socket:
    """One TCP connect to the checked address. Tests swap this for a fixture."""
    return socket.create_connection((ip, port), timeout)


def _check_peer(sock: socket.socket, pinned_ip: str) -> None:
    """After every connect: the peer must be the checked address and never a
    refused one. Closes the socket and raises otherwise."""
    try:
        peer = sock.getpeername()[0]
        ok = not _blocked(peer) and ipaddress.ip_address(peer.split("%")[0]) == ipaddress.ip_address(pinned_ip)
    except (OSError, ValueError):
        ok = False
    if not ok:
        try:
            sock.close()
        except OSError:
            pass
        raise ProbeError("The probe never calls loopback, link-local or metadata addresses.")


class _PinnedHTTPConnection(http.client.HTTPConnection):
    """http.client connection that connects to the address checked once in
    check_destination instead of resolving the name again. `host` (and so
    the Host header) stays the configured name."""

    _pinned_ip = ""  # set by _pinned(); never resolved from `host`

    def connect(self):
        self.sock = _connect(self._pinned_ip, self.port, self.timeout)
        _check_peer(self.sock, self._pinned_ip)
        try:
            self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass


class _PinnedHTTPSConnection(http.client.HTTPSConnection, _PinnedHTTPConnection):
    """HTTPSConnection.connect calls the pinned connect above, then wraps the
    socket with server_hostname=self.host, so SNI and the certificate
    hostname check use the configured name, not the address."""


def _pinned(cls, pinned_ip: str):
    """A connection factory for urllib's do_open: cls(host, **kwargs) bound
    to the checked address."""
    def make(host, **kwargs):
        conn = cls(host, **kwargs)
        conn._pinned_ip = pinned_ip
        return conn
    return make


class _PinnedHTTPHandler(urllib.request.HTTPHandler):
    def __init__(self, pinned_ip: str):
        super().__init__()
        self._conn = _pinned(_PinnedHTTPConnection, pinned_ip)

    def http_open(self, req):
        return self.do_open(self._conn, req)


class _PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, pinned_ip: str):
        super().__init__()  # default context: CERT_REQUIRED, check_hostname
        self._conn = _pinned(_PinnedHTTPSConnection, pinned_ip)

    def https_open(self, req):
        return self.do_open(self._conn, req, context=self._context)


def _opener(pinned_ip: str) -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}), _NoRedirect(),
        _PinnedHTTPHandler(pinned_ip), _PinnedHTTPSHandler(pinned_ip),
    )


def _blocked(addr: str) -> bool:
    try:
        ip = ipaddress.ip_address(addr.split("%")[0])
    except ValueError:
        return True
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return any(ip in net for net in BLOCKED_NETWORKS)


def resolve_destination(url: str, app_port: Optional[int] = None) -> Tuple[str, int, str]:
    """Refuse URLs the probe must never reach. Resolves the name once and
    checks every address. Returns (host, port, checked address); the probe
    connects to that address for every request."""
    parsed = urllib.parse.urlparse(url or "")
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ProbeError("Only http and https servers can be probed.")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if app_port and port == int(app_port):
        raise ProbeError("The probe never calls SecureVector's own port.")
    try:
        infos = socket.getaddrinfo(parsed.hostname, port, proto=socket.IPPROTO_TCP)
    except OSError as exc:
        raise ProbeError("The server name did not resolve.") from exc
    if not infos or any(_blocked(info[4][0]) for info in infos):
        raise ProbeError("The probe never calls loopback, link-local or metadata addresses.")
    infos = sorted(infos, key=lambda info: info[0] != socket.AF_INET)  # IPv4 first when present
    return parsed.hostname, port, str(infos[0][4][0])


def check_destination(url: str, app_port: Optional[int] = None) -> Tuple[str, int]:
    """Refuse URLs the probe must never reach. Returns (host, port)."""
    host, port, _ = resolve_destination(url, app_port)
    return host, port


def _parse_body(raw: bytes, content_type: str, want_id: Optional[int]) -> Optional[dict]:
    text = raw.decode("utf-8", "replace")
    if "text/event-stream" in content_type:
        for line in text.splitlines():
            if not line.startswith("data:"):
                continue
            try:
                msg = json.loads(line[5:].strip())
            except ValueError:
                continue
            if isinstance(msg, dict) and (want_id is None or msg.get("id") == want_id):
                return msg
        return None
    if not text.strip():
        return None
    try:
        msg = json.loads(text)
    except ValueError as exc:
        raise ProbeError("The server answered with something other than JSON.") from exc
    return msg if isinstance(msg, dict) else None


def _remaining(deadline: float) -> float:
    left = deadline - time.monotonic()
    if left <= 0:
        raise ProbeError("The server took too long to answer.")
    return left


def _post(opener, url: str, headers: Dict[str, str], body: dict,
          deadline: float) -> Tuple[Optional[dict], Dict[str, str]]:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"), method="POST",
        headers={**headers, "Content-Type": "application/json",
                 "Accept": "application/json, text/event-stream"},
    )
    try:
        with opener.open(req, timeout=min(TIMEOUT_SECONDS, _remaining(deadline))) as resp:
            chunks, total = [], 0
            while total < MAX_RESPONSE_BYTES:
                left = _remaining(deadline)
                sock = getattr(getattr(getattr(resp, "fp", None), "raw", None), "_sock", None)
                if sock is not None:
                    sock.settimeout(min(TIMEOUT_SECONDS, left))
                chunk = resp.read(min(65536, MAX_RESPONSE_BYTES - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
            raw = b"".join(chunks)
            ctype = resp.headers.get("Content-Type", "")
            out_headers = {k.lower(): v for k, v in resp.headers.items()}
    except ProbeError:
        raise
    except urllib.error.HTTPError as exc:
        if 300 <= exc.code < 400:
            raise ProbeError("The server tried to redirect the request; redirects are never followed.") from exc
        raise ProbeError(f"The server answered HTTP {exc.code}.") from exc
    except Exception as exc:  # noqa: BLE001 - reported as one plain message
        raise ProbeError(f"The server did not answer ({type(exc).__name__}).") from exc
    return _parse_body(raw, ctype, body.get("id")), out_headers


def probe_tools(url: str, headers: Optional[Dict[str, str]] = None,
                app_port: Optional[int] = None) -> List[dict]:
    """Return the server's tool surface as tool entries (name, hashes, local
    description text). Raises ProbeError with a plain message."""
    deadline = time.monotonic() + TOTAL_SECONDS
    _, _, pinned_ip = resolve_destination(url, app_port)
    opener = _opener(pinned_ip)
    base = dict(headers or {})
    init, resp_headers = _post(opener, url, base, {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": PROTOCOL_VERSION, "capabilities": {},
                   "clientInfo": {"name": "securevector-setup-trust", "version": "1"}},
    }, deadline)
    if not init or "result" not in init:
        raise ProbeError("The server did not accept the initialize request.")
    session = resp_headers.get("mcp-session-id")
    if session:
        base["Mcp-Session-Id"] = session
    base["MCP-Protocol-Version"] = str(init["result"].get("protocolVersion") or PROTOCOL_VERSION)
    try:
        _post(opener, url, base, {"jsonrpc": "2.0", "method": "notifications/initialized"}, deadline)
    except ProbeError:
        pass  # a notification has no answer to wait for
    tools: List[dict] = []
    cursor = None
    for page in range(MAX_PAGES):
        params = {"cursor": cursor} if cursor else {}
        msg, _ = _post(opener, url, base, {"jsonrpc": "2.0", "id": 2 + page, "method": "tools/list", "params": params},
                       deadline)
        if not msg or "result" not in msg:
            raise ProbeError("The server did not return a tool list.")
        for t in msg["result"].get("tools") or []:
            if isinstance(t, dict) and t.get("name"):
                tools.append(tool_entry(t["name"], t.get("description"), t.get("inputSchema"), "probe"))
        cursor = msg["result"].get("nextCursor")
        if not cursor:
            break
    return sorted(tools, key=lambda e: e["name"])
