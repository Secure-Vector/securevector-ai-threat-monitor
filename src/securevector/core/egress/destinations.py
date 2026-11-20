"""
Network destination extraction from agent tool calls.

Turns a tool call (`WebFetch`, `Bash`, a remote MCP invocation) into zero or
more `EgressAttempt` records describing *where* the call would reach and
*what kind of operation* it would perform there.

Design notes that matter downstream:

- **Extraction is best-effort and says so.** Every attempt carries a
  `confidence` and every extraction carries a `coverage` note. The containment
  attestation prints these verbatim; a gap that is stated is defensible, a gap
  that is hidden is not. Never infer more certainty than the parse supports.

- **Read vs write is the axis the policy turns on.** A uniform destination
  allowlist breaks every agent on install (agents legitimately reach PyPI, npm,
  GitHub and docs constantly, and that set cannot be enumerated in advance).
  Reads are recorded and allowed; writes are denied by default. Classification
  therefore has to be conservative in a specific direction: when the operation
  is genuinely ambiguous we return `UNKNOWN`, and the engine treats UNKNOWN as
  write-shaped under the stricter presets rather than waving it through.

- **`Bash` is the hard case and the honest gap.** We tokenize and inspect argv
  for known network binaries. A command that reaches the network through a path
  we do not model (an inline interpreter, a shell function, an obscure client,
  a compiled binary) is invisible here. That is a limit of tool-boundary
  enforcement, not a bug to be fixed by more regexes.
"""

import logging
import re
import shlex
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

# Operation classes.
READ = "read"
WRITE = "write"
UNKNOWN = "unknown"

# Confidence in a single extracted destination.
EXACT = "exact"        # the destination was a structured field (a URL argument)
PARSED = "parsed"      # recovered by tokenizing a command we understand
HEURISTIC = "heuristic"  # pattern-matched; the host may be wrong or absent

# Tools that can reach the network. Anything not in this set short-circuits
# before any parsing happens, so the overwhelmingly common Read/Edit/Glob/Grep
# path costs one set lookup and never touches the evaluator.
#
# Runtimes name their shell tool differently — Claude Code says `Bash`, Cursor
# fires a `beforeShellExecution` event it calls `shell`, others say `exec` or
# `terminal`. A name missing here means the server answers `network_capable:
# false` and egress is SILENTLY not enforced for that runtime, so this list
# must stay a superset of every runtime's shell tool name. The JS
# `NETWORK_CAPABLE` set in each plugin's pre-tool-use hook mirrors it.
NETWORK_CAPABLE_BUILTINS = frozenset({
    "webfetch",
    "websearch",
    "bash",
    "powershell",
    "shell",
    "exec",
    "terminal",
    "run_terminal_cmd",
    "runcommand",
    "execute_command",
})

# Shell binaries whose argv we know how to read. Extending this set widens
# coverage; it never changes the meaning of an existing parse.
_HTTP_CLIENTS = frozenset({"curl", "wget", "http", "https", "httpie", "xh"})
_RAW_SOCKET = frozenset({"nc", "ncat", "netcat", "telnet", "socat", "openssl"})
# openssl subcommands that connect to a host; the rest work on local files.
_OPENSSL_NETWORK = frozenset({"s_client", "s_time", "ocsp"})
_OPENSSL_DEST_FLAGS = frozenset({"-connect", "-url", "-host"})
# nc and telnet take a bare name (`nc db 5432`); socat words are address types.
_SINGLE_LABEL_SOCKETS = frozenset({"nc", "ncat", "netcat", "telnet"})
_LABEL_RE = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")
# Short flags that take a value, per tool: the same letter differs between
# them (`-c` is a command in ncat and takes nothing in telnet). `nc` may be
# the BSD tool or ncat under that name, so its set covers both; a value
# skipped by mistake is recovered below when no other destination is named.
_SOCKET_SHORT_VALUE = {
    "nc": frozenset("bcegGIiOpPsTVwxXMmq"),
    "netcat": frozenset("bcegGIiOpPsTVwxXMmq"),
    "ncat": frozenset("cdegGimopsxw"),
    "telnet": frozenset("belnsSXk"),
}
# Letters whose meaning really differs between tools sharing a name: in the
# BSD `nc`, `-c` takes nothing, so the token after it can be the host.
_SOCKET_AMBIGUOUS = {"nc": frozenset("c"), "netcat": frozenset("c")}
# A shell redirection token: `>`, `2>`, `>>`, `<`, `2>&1`, `&>log`, `2>/dev/null`.
_REDIRECT_RE = re.compile(r"^(?:\d*|&)(?:>>?|<)(.*)$")
# ncat long options whose next token is a value.
_NCAT_LONG_VALUE = frozenset({
    "--sh-exec", "--exec", "--lua-exec", "--proxy", "--proxy-type", "--proxy-auth",
    "--output", "--hex-dump", "--source", "--source-port", "--wait", "--delay",
    "--idle-timeout", "--max-conns", "--ssl-cert", "--ssl-key", "--ssl-trustfile",
    "--ssl-ciphers", "--ssl-servername", "--ssl-alpn", "--allow", "--allowfile",
    "--deny", "--denyfile",
})
# curl short flags that take a value (case-sensitive; -O and -L do not).
_CURL_SHORT_VALUE = frozenset("dDHXouAeFTbcxmwCEKPQrtyYzU")
# wget short flags that take a value (-O file, -o log, -P dir, -T seconds).
_WGET_SHORT_VALUE = frozenset("OoaetTwQPUARDXIlBi")
_SCP_LIKE = frozenset({"scp", "sftp", "rsync"})

# Package managers: (binary, {subcommand: operation}). A subcommand absent from
# the map falls through to UNKNOWN rather than being assumed safe — `pip
# something-new` should not silently read as a read.
_PACKAGE_MANAGERS = {
    "pip": {"install": READ, "download": READ, "wheel": READ, "upload": WRITE},
    "pip3": {"install": READ, "download": READ, "wheel": READ, "upload": WRITE},
    "uv": {"add": READ, "sync": READ, "pip": READ, "publish": WRITE},
    "twine": {"upload": WRITE, "check": READ},
    "npm": {"install": READ, "i": READ, "ci": READ, "publish": WRITE, "unpublish": WRITE},
    "pnpm": {"install": READ, "add": READ, "publish": WRITE},
    "yarn": {"install": READ, "add": READ, "publish": WRITE},
    "cargo": {"build": READ, "fetch": READ, "add": READ, "publish": WRITE, "yank": WRITE},
    "gem": {"install": READ, "fetch": READ, "push": WRITE, "yank": WRITE},
    "docker": {"pull": READ, "push": WRITE},
    "podman": {"pull": READ, "push": WRITE},
    "go": {"get": READ, "mod": READ, "install": READ},
    "mvn": {"deploy": WRITE, "install": READ},
    "gradle": {"publish": WRITE},
    "helm": {"pull": READ, "push": WRITE},
    "poetry": {"add": READ, "install": READ, "publish": WRITE},
}

# The registry each package manager talks to when no explicit index is given.
# Used so a `npm publish` with no --registry still resolves to a destination
# the policy can match on, rather than producing a hostless attempt that
# silently evades a host-scoped rule.
_DEFAULT_REGISTRY = {
    "pip": "pypi.org",
    "pip3": "pypi.org",
    "uv": "pypi.org",
    "twine": "upload.pypi.org",
    "poetry": "pypi.org",
    "npm": "registry.npmjs.org",
    "pnpm": "registry.npmjs.org",
    "yarn": "registry.npmjs.org",
    "cargo": "crates.io",
    "gem": "rubygems.org",
    "docker": "registry-1.docker.io",
    "podman": "registry-1.docker.io",
    "go": "proxy.golang.org",
    "mvn": "repo.maven.apache.org",
    "gradle": "repo.maven.apache.org",
    "helm": "charts.helm.sh",
}

# git subcommands that reach the network, and which way the bytes flow.
_GIT_NETWORK_SUBCOMMANDS = {
    "clone": READ,
    "fetch": READ,
    "pull": READ,
    "ls-remote": READ,
    "submodule": READ,
    "push": WRITE,
}

# curl/wget flags that turn a default-GET into a body-carrying request.
_CURL_WRITE_FLAGS = frozenset({
    "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode",
    "-F", "--form", "-T", "--upload-file", "--post301", "--post302",
})
_WGET_WRITE_FLAGS = frozenset({"--post-data", "--post-file", "--method"})

# Verbs that mean a body is being sent even when the flag itself does not.
_WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

# A bare host:port or IP with no scheme, as it appears in nc/telnet argv.
_BARE_HOST_RE = re.compile(r"^[A-Za-z0-9._-]+$")

# Flags whose NEXT token is a value, not a destination. Without this, the `x`
# in `curl -X POST -d x https://real.host/` parses as a hostname and produces a
# phantom destination that can block a legitimate call. A false positive here
# is not a cosmetic bug: it is the thing that gets the whole feature disabled.
# `--url` is deliberately absent — its value IS the destination.
_VALUE_FLAGS = frozenset({
    "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode",
    "-H", "--header", "-X", "--request", "--method", "-o", "--output",
    "-O", "--output-document", "-u", "--user", "-A", "--user-agent",
    "-e", "--referer", "-F", "--form", "-T", "--upload-file",
    "-b", "--cookie", "-c", "--cookie-jar", "-x", "--proxy",
    "--connect-timeout", "-m", "--max-time", "--retry", "--max-redirs",
    "--cacert", "--cert", "--key", "--resolve", "--interface",
    "--post-data", "--post-file", "--body-data", "--body-file",
    "-w", "--write-out", "--oauth2-bearer", "--limit-rate",
})

# A token only counts as a destination if it could actually be one. A shell
# variable, a filename, or a bare word is not a host, and treating one as a
# host invents traffic that never happened.
_HOSTNAME_RE = re.compile(r"^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
                          r"(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$")


def _plausible_host(host: Optional[str]) -> bool:
    """True when `host` could really be a network destination.

    Accepts dotted hostnames, IP literals, and the loopback names. Rejects
    shell expansions, single bare words, and anything carrying shell
    metacharacters — all of which mean the parse recovered a value, not a
    destination.
    """
    if not host:
        return False
    h = host.strip().lower()
    if not h or any(c in h for c in "$`(){}*?!\\'\"<>|"):
        return False
    if h in ("localhost", "::1"):
        return True
    try:
        import ipaddress as _ip
        _ip.ip_address(h)
        return True
    except ValueError:
        pass
    return bool(_HOSTNAME_RE.match(h))


@dataclass(frozen=True)
class EgressAttempt:
    """One network destination a tool call would reach."""

    host: Optional[str]      # normalized lowercase hostname or IP literal
    operation: str           # READ | WRITE | UNKNOWN
    kind: str                # http | git | package | raw_socket | mcp | search
    detector: str            # which extractor produced this, for coverage reporting
    confidence: str          # EXACT | PARSED | HEURISTIC
    scheme: Optional[str] = None
    port: Optional[int] = None
    # The command fragment or URL this came from, already truncated. Callers
    # must treat this as untrusted display text, never as something to execute.
    evidence: str = ""
    # Set when the attempt is a package-registry mutation (publish / push /
    # yank). The baseline pack denies these outright, independent of host.
    is_publish: bool = False
    # Set when a git remote was supplied as a literal URL rather than a
    # configured remote name. `git push origin main` is ordinary; `git push
    # https://host/x main` bypasses the repository's configured remotes
    # entirely, which is both rare and unambiguous — the two properties a
    # Baseline rule needs. This is what lets the foreign-remote check work
    # from a hook that has no access to .git/config.
    inline_remote: bool = False


@dataclass
class ExtractionResult:
    """Everything one tool call yielded, plus what we could not see."""

    attempts: list = field(default_factory=list)
    # False for the overwhelming majority of calls (Read/Edit/Glob/...). When
    # False the caller skips evaluation entirely.
    network_capable: bool = False
    # Human-readable statement of what this parse could not determine. Flows
    # into the containment attestation unchanged.
    coverage: Optional[str] = None


# Secret shapes that must never reach disk. Mirrors SECRET_PATTERNS in the
# Guard plugin's lib/redact.js so the JS and Python paths redact the same
# things.
#
# This matters more here than it looks: `evidence` is persisted to
# egress_audit, and an agent command line routinely carries a live credential
# (`curl -H "Authorization: Bearer ..."`, `-u user:token`, `?api_key=...`).
# SecureVector must never take custody of a secret, so redaction happens at
# EXTRACTION time — before the value is ever handed to a caller that might
# store it — rather than being left to each storage site to remember.
_SECRET_PATTERNS = [
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"),
    re.compile(r"\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),  # JWT
    # Authorization / bearer / basic headers, with or without quoting.
    re.compile(r"(?i)\b(authorization|proxy-authorization)\s*:\s*\S+"),
    re.compile(r"(?i)\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}"),
    # `-u user:password`, `--user user:token`
    re.compile(r"(?i)(^|\s)(-u|--user)\s+\S+:\S+"),
    # Labelled key/value pairs in flags, env assignments, or query strings.
    re.compile(
        r"(?i)([\"']?(?:password|passwd|secret|token|api[_-]?key|apikey|"
        r"auth[_-]?token|access[_-]?token|client[_-]?secret|private[_-]?key)"
        r"[\"']?\s*[:=]\s*[\"']?)[^\"'\s,}\]&]{4,256}"
    ),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
]


def redact_secrets(text: str) -> str:
    """Mask credential shapes in a command fragment.

    Conservative and bounded: patterns cap their match length so a large
    argument cannot drive catastrophic backtracking. A missed secret is a leak,
    but an over-redacted display string costs nothing, so this errs toward
    masking.
    """
    if not text:
        return ""
    out = str(text)
    for pattern in _SECRET_PATTERNS:
        out = pattern.sub(
            lambda m: (m.group(1) + "[REDACTED]") if (m.groups() and m.group(1)) else "[REDACTED]",
            out,
        )
    return out


def _truncate(text: str, limit: int = 160) -> str:
    # Redact BEFORE truncating: truncating first can slice a token in half and
    # leave a prefix that no pattern matches, defeating the redaction.
    text = " ".join(redact_secrets(str(text)).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _host_from_url(raw: str):
    """Split a URL into (host, scheme, port). Returns (None, None, None) on junk."""
    try:
        candidate = raw.strip().strip("'\"")
        # Bare `example.com/path` is common in agent-written commands; urlsplit
        # would read the whole thing as a path, so give it a scheme to chew on.
        if "://" not in candidate:
            if not candidate or candidate.startswith("-"):
                return None, None, None
            candidate = "//" + candidate
        parts = urlsplit(candidate, scheme="")
        host = (parts.hostname or "").lower() or None
        port = parts.port
        scheme = parts.scheme or None
        return host, scheme, port
    except Exception:
        # A malformed URL is a coverage gap, not a crash. The caller records an
        # attempt with host=None so the policy can still refuse to vouch for it.
        return None, None, None


def _split_shell_segments(command: str):
    """Split a compound shell command into individually-parsed segments.

    `curl a.com && git push` is two network operations with different
    consequences; evaluating the concatenated string would classify it as one.
    Splitting on the operators keeps each verb's operation class intact.
    """
    return [seg for seg in re.split(r"(?:\|\||&&|;|\||\n)", command) if seg.strip()]


def _classify_http(tokens, detector: str):
    """Read argv for curl/wget/httpie and produce attempts."""
    binary = tokens[0].rsplit("/", 1)[-1].lower()
    operation = READ
    explicit_method = None

    for i, tok in enumerate(tokens[1:], start=1):
        low = tok.lower()
        # Short curl flags are CASE-SENSITIVE: `-T` uploads a file, `-t` sets
        # telnet options; `-F` is a form post, `-f` is fail-fast. Comparing the
        # lowercased token would classify an upload as a read. Long flags are
        # matched case-insensitively, which is harmless.
        if tok in _CURL_WRITE_FLAGS or low in _WGET_WRITE_FLAGS or (
            tok.startswith("--") and low in _CURL_WRITE_FLAGS
        ):
            operation = WRITE
        # `-X POST` / `--request POST` / httpie's bare `POST url`
        if low in ("-x", "--request", "--method") and i + 1 < len(tokens):
            explicit_method = tokens[i + 1].upper()
        elif low.startswith("-x") and len(tok) > 2:
            explicit_method = tok[2:].upper()

    if explicit_method:
        operation = WRITE if explicit_method in _WRITE_METHODS else READ

    # httpie takes the method as a positional: `http POST example.com/x`
    if binary in ("http", "https", "httpie", "xh"):
        for tok in tokens[1:]:
            if tok.upper() in _WRITE_METHODS:
                operation = WRITE
                break

    attempts = []
    skip_next = False
    short_value = _CURL_SHORT_VALUE if binary == "curl" else _WGET_SHORT_VALUE if binary == "wget" else None
    for tok in tokens[1:]:
        if skip_next:
            skip_next = False
            continue
        if short_value and len(tok) > 1 and tok[0] == "-" and tok[1] != "-":
            # curl and wget give the same letter different meanings (`-c`,
            # `-O`), so each reads its own set. Single or grouped
            # (`-sSfLo out.bin`): the first letter that takes a value ends
            # the group. Last in the group, its value is the next token;
            # otherwise the value is the rest of this token.
            for pos, ch in enumerate(tok[1:], start=1):
                if ch in short_value:
                    skip_next = pos == len(tok) - 1
                    break
            continue
        if tok in _VALUE_FLAGS:
            # This flag's value follows; it is data, not a destination.
            skip_next = True
            continue
        if tok.startswith("-") and tok != "--url":
            continue
        if tok == "--url":
            continue  # the next token is the destination, handled normally
        if tok.upper() in _WRITE_METHODS:
            continue  # httpie's positional verb, not a destination
        host, scheme, port = _host_from_url(tok)
        if _plausible_host(host):
            attempts.append(EgressAttempt(
                host=host, operation=operation, kind="http", detector=detector,
                confidence=PARSED, scheme=scheme, port=port,
                evidence=_truncate(" ".join(tokens)),
            ))
    if not attempts:
        # We recognised a network binary but could not recover a host — a flag
        # form we do not model, a URL in a variable, a config file. Emit a
        # hostless attempt so the policy still sees that egress was attempted.
        attempts.append(EgressAttempt(
            host=None, operation=operation, kind="http", detector=detector,
            confidence=HEURISTIC, evidence=_truncate(" ".join(tokens)),
        ))
    return attempts


def _classify_git(tokens, detector: str):
    """Read argv for git, recovering the remote when it is written inline."""
    sub = None
    for tok in tokens[1:]:
        if not tok.startswith("-"):
            sub = tok.lower()
            break
    if sub not in _GIT_NETWORK_SUBCOMMANDS:
        return []  # local-only git (status, add, commit, log) — not egress

    operation = _GIT_NETWORK_SUBCOMMANDS[sub]
    attempts = []
    for tok in tokens[1:]:
        if tok.startswith("-") or tok.lower() == sub:
            continue
        # scp-style remote: git@github.com:org/repo.git
        if "@" in tok and ":" in tok and "://" not in tok:
            host = tok.split("@", 1)[1].split(":", 1)[0].lower()
            if not _plausible_host(host):
                continue
            attempts.append(EgressAttempt(
                host=host, operation=operation, kind="git", detector=detector,
                confidence=PARSED, evidence=_truncate(" ".join(tokens)),
                inline_remote=True,
            ))
            continue
        host, scheme, port = _host_from_url(tok)
        if _plausible_host(host):
            attempts.append(EgressAttempt(
                host=host, operation=operation, kind="git", detector=detector,
                confidence=PARSED, scheme=scheme, port=port,
                evidence=_truncate(" ".join(tokens)),
                inline_remote=True,
            ))

    if not attempts:
        # `git push` with no remote argument resolves to whatever `origin` (or
        # the branch's upstream) points at, which lives in .git/config and is
        # not visible from argv. Emit hostless so the caller can resolve it
        # against the repo config; a push we cannot attribute to a host must
        # not read as "no egress happened".
        attempts.append(EgressAttempt(
            host=None, operation=operation, kind="git", detector=detector,
            confidence=HEURISTIC, evidence=_truncate(" ".join(tokens)),
        ))
    return attempts


def _classify_package(tokens, detector: str):
    """Read argv for a package manager, resolving the implicit registry."""
    binary = tokens[0].rsplit("/", 1)[-1].lower()
    table = _PACKAGE_MANAGERS.get(binary)
    if not table:
        return []

    sub = None
    for tok in tokens[1:]:
        if not tok.startswith("-"):
            sub = tok.lower()
            break
    if sub is None:
        return []

    operation = table.get(sub, UNKNOWN)
    # `uv pip install` / `cargo publish` — a nested verb changes the meaning.
    if binary == "uv" and sub == "pip":
        nested = [t for t in tokens[2:] if not t.startswith("-")]
        if nested:
            operation = {"install": READ, "download": READ}.get(nested[0].lower(), UNKNOWN)

    is_publish = operation == WRITE

    # An explicit index/registry flag overrides the default host.
    host = _DEFAULT_REGISTRY.get(binary)
    confidence = HEURISTIC  # the default registry is an assumption, not a parse
    for i, tok in enumerate(tokens):
        low = tok.lower()
        if low in ("--index-url", "--repository-url", "--registry", "-i", "--index") and i + 1 < len(tokens):
            parsed, _, _ = _host_from_url(tokens[i + 1])
            if parsed:
                host, confidence = parsed, PARSED
        elif low.startswith("--registry=") or low.startswith("--index-url="):
            parsed, _, _ = _host_from_url(tok.split("=", 1)[1])
            if parsed:
                host, confidence = parsed, PARSED

    # `docker push ghcr.io/org/img` carries its registry in the image ref.
    if binary in ("docker", "podman") and sub in ("push", "pull"):
        for tok in tokens[2:]:
            if tok.startswith("-"):
                continue
            first = tok.split("/", 1)[0]
            if "." in first or ":" in first:
                host, confidence = first.split(":", 1)[0].lower(), PARSED
            break

    return [EgressAttempt(
        host=host, operation=operation, kind="package", detector=detector,
        confidence=confidence, evidence=_truncate(" ".join(tokens)),
        is_publish=is_publish,
    )]


def _classify_raw_socket(tokens, detector: str):
    """nc / telnet / socat / openssl client: the protocol is opaque, so the
    operation is UNKNOWN. The first destination named wins; a later file or
    script argument never replaces it."""
    host = None
    port = None
    recovered = False
    binary = tokens[0].rsplit("/", 1)[-1].lower()
    if binary == "openssl":
        if len(tokens) < 2 or tokens[1].lower() not in _OPENSSL_NETWORK:
            return []  # only the client subcommands open a connection
        # The destination is the value of -connect / -url / -host, or a
        # `host:port` right after the subcommand.
        named = [tokens[i + 1] for i, tok in enumerate(tokens[:-1]) if tok.lower() in _OPENSSL_DEST_FLAGS]
        if len(tokens) > 2 and not tokens[2].startswith("-") and ":" in tokens[2]:
            named.append(tokens[2])
        for value in named:
            parsed, _, parsed_port = _host_from_url(value)
            if _plausible_host(parsed):
                host, port = parsed, parsed_port
                break
    else:
        single_label = binary in _SINGLE_LABEL_SOCKETS
        short_value = _SOCKET_SHORT_VALUE.get(binary, frozenset())
        ambiguous = _SOCKET_AMBIGUOUS.get(binary, frozenset())
        maybe_host = []   # values of ambiguous flags, in order
        listening = False
        unread = False    # a positional that named no destination ($VAR, a word)
        skip_next = None  # the flag letter whose value is the next token
        for tok in tokens[1:]:
            if skip_next is not None:
                if skip_next in ambiguous:
                    maybe_host.append(tok)
                skip_next = None
                continue
            if tok.startswith("-"):
                if len(tok) > 1 and tok[1] != "-":
                    # `-e run.sh`, `-w 3`, `-zw 3`: the flag's value follows.
                    for pos, ch in enumerate(tok[1:], start=1):
                        if ch in short_value:
                            skip_next = ch if pos == len(tok) - 1 else None
                            break
                        if ch == "l" and binary != "telnet":
                            listening = True
                elif binary == "ncat" and tok.lower() in _NCAT_LONG_VALUE:
                    skip_next = ""
                elif tok.lower() == "--listen":
                    listening = True
                continue
            redirect = _REDIRECT_RE.match(tok)
            if redirect:
                # `2>/dev/null`, `< file`: shell plumbing, never a destination.
                if not redirect.group(1):
                    skip_next = ""
                continue
            if tok.isdigit():
                port = port or int(tok)
                continue
            if host is not None or unread:
                # The first destination wins, and after one that could not be
                # read ($VAR) a later word is a port or service name, not a host.
                continue
            if _BARE_HOST_RE.match(tok) and (_plausible_host(tok) or (single_label and _LABEL_RE.match(tok))):
                host = tok.lower()
            else:
                parsed, _, parsed_port = _host_from_url(tok)
                if _plausible_host(parsed):
                    host, port = parsed, parsed_port or port
                else:
                    unread = True
        if host is None and not listening and not unread:
            # No positional at all besides ports: the value of an ambiguous
            # flag may be the host (BSD `nc -c host 80`). Never when a
            # positional went unread: the real destination is then unknown,
            # and a flag value must not stand in for it.
            for tok in maybe_host:
                if _BARE_HOST_RE.match(tok) and not tok.isdigit() and _plausible_host(tok):
                    host, recovered = tok.lower(), True
                    break
    return [EgressAttempt(
        host=host, operation=UNKNOWN, kind="raw_socket", detector=detector,
        confidence=PARSED if host and not recovered else HEURISTIC, port=port,
        evidence=_truncate(" ".join(tokens)),
    )]


def _classify_scp_like(tokens, detector: str):
    """scp / sftp / rsync — direction depends on argument order."""
    remotes = []
    remote_is_dest = False
    args = [t for t in tokens[1:] if not t.startswith("-")]
    for idx, tok in enumerate(args):
        if "@" in tok and ":" in tok:
            _h = tok.split("@", 1)[1].split(":", 1)[0].lower()
            if _plausible_host(_h):
                remotes.append(_h)
            if idx == len(args) - 1:
                remote_is_dest = True
        elif tok.count(":") == 1 and not tok.startswith("/") and "://" not in tok:
            _h = tok.split(":", 1)[0].lower()
            if _plausible_host(_h):
                remotes.append(_h)
            if idx == len(args) - 1:
                remote_is_dest = True
    operation = WRITE if remote_is_dest else READ
    if not remotes:
        return [EgressAttempt(
            host=None, operation=UNKNOWN, kind="raw_socket", detector=detector,
            confidence=HEURISTIC, evidence=_truncate(" ".join(tokens)),
        )]
    return [EgressAttempt(
        host=h, operation=operation, kind="raw_socket", detector=detector,
        confidence=PARSED, evidence=_truncate(" ".join(tokens)),
    ) for h in remotes]


def extract_from_bash(command: str) -> ExtractionResult:
    """Parse a shell command for network intent.

    Best-effort by construction. The returned `coverage` string names what this
    parse could not see, and it is meant to be surfaced to the user rather than
    swallowed.
    """
    if not command or not command.strip():
        return ExtractionResult(network_capable=False)

    attempts = []
    unparseable = 0

    for segment in _split_shell_segments(command):
        try:
            tokens = shlex.split(segment, comments=True)
        except ValueError:
            # Unbalanced quotes — common in agent-written one-liners. Fall back
            # to whitespace splitting rather than dropping the segment silently.
            tokens = segment.split()
            unparseable += 1
        if not tokens:
            continue

        # Skip leading env assignments and `sudo`: `FOO=bar sudo curl ...`
        # Strip leading env assignments and wrappers so `FOO=bar sudo curl ...`
        # is classified on `curl`, not on `FOO=bar`. Parenthesised explicitly:
        # relying on `and` binding tighter than `or` here is the kind of thing
        # that silently inverts during a later edit.
        while tokens and (
            ("=" in tokens[0].split(" ")[0] and not tokens[0].startswith("-"))
            or tokens[0].lower() in ("sudo", "env", "command", "nohup")
        ):
            tokens = tokens[1:]
        if not tokens:
            continue

        binary = tokens[0].rsplit("/", 1)[-1].lower()

        if binary in _HTTP_CLIENTS:
            attempts.extend(_classify_http(tokens, "bash.http"))
        elif binary == "git":
            attempts.extend(_classify_git(tokens, "bash.git"))
        elif binary in _PACKAGE_MANAGERS:
            attempts.extend(_classify_package(tokens, "bash.package"))
        elif binary in _RAW_SOCKET:
            attempts.extend(_classify_raw_socket(tokens, "bash.raw_socket"))
        elif binary in _SCP_LIKE:
            attempts.extend(_classify_scp_like(tokens, "bash.scp"))
        else:
            # Not a binary we model. A bare URL anywhere in the segment still
            # signals intent worth recording, at heuristic confidence.
            for tok in tokens:
                if "://" in tok:
                    host, scheme, port = _host_from_url(tok)
                    if _plausible_host(host):
                        attempts.append(EgressAttempt(
                            host=host, operation=UNKNOWN, kind="http",
                            detector="bash.bare_url", confidence=HEURISTIC,
                            scheme=scheme, port=port, evidence=_truncate(segment),
                        ))

    coverage = (
        "Bash network detection is best-effort argv analysis. Network access "
        "through an inline interpreter (python -c, node -e), a shell function, "
        "a compiled binary, or a client not in the known set is not visible at "
        "this boundary."
    )
    if unparseable:
        coverage += f" {unparseable} command segment(s) could not be tokenized cleanly."

    return ExtractionResult(
        attempts=attempts,
        network_capable=True,
        coverage=coverage,
    )


# Browser automation tools, by the tool part of `mcp__server__tool`. The MCP
# server is usually local, but the page the tool opens is a destination the
# agent chose.
_BROWSER_NAVIGATE_TOOLS = frozenset({
    "navigate", "browser_navigate", "navigate_page", "new_page", "puppeteer_navigate",
    "browser_tab_new", "go_to_url", "open_tab",
})
_BROWSER_SCRIPT_TOOLS = frozenset({
    "browser_run_code_unsafe", "browser_run_code", "browser_evaluate", "javascript_tool",
    "evaluate_script", "puppeteer_evaluate",
})
# A tool that carries several browser actions in one call.
_BROWSER_BATCH_TOOLS = frozenset({"browser_batch"})
_BATCH_SCRIPT_KEYS = frozenset({"code", "function", "text", "script", "expression", "javascript"})
_BATCH_NODE_LIMIT = 2000
_BATCH_DEPTH_LIMIT = 8

# Schemes a browser fetches over the network, and ones that name no remote
# destination. Anything else is recorded without a host: unreadable, so the
# policy does not vouch for it.
_BROWSER_NETWORK_SCHEMES = frozenset({"http", "https", "ws", "wss"})
_BROWSER_LOCAL_SCHEMES = frozenset({
    "about", "chrome", "chrome-extension", "edge", "brave", "devtools", "blob", "mailto", "tel",
})
# A javascript: or data: URL carries content that can fetch; its body is read
# like a script.
_BROWSER_INLINE_SCHEMES = frozenset({"javascript", "data"})
_JOINED_AFTER_RE = re.compile(r"[\"'`]\s*\+")
_BROWSER_HISTORY_WORDS = frozenset({"back", "forward", "reload"})
_URL_SCHEME_RE = re.compile(r"^([A-Za-z][A-Za-z0-9+.\-]*):")
_HOST_PORT_REST_RE = re.compile(r"^\d{1,5}(?:[/?#]|$)")
_URL_EDGE_CHARS = "".join(chr(c) for c in range(0x21))   # C0 controls and space
_HOST_FORBIDDEN_RE = re.compile(r"[\x00-\x20#/<>?@\[\\\]^|%\x7f]")
_BAD_PERCENT_RE = re.compile(r"%(?![0-9A-Fa-f]{2})")
# A URL with a scheme, or a quoted one that starts with // (it takes the
# scheme of the page; the quote keeps a // comment from matching).
_SCRIPT_URL_RE = re.compile(r"(?:(?:https?|wss?):|(?<=[\"'`])//(?=[^\s/]))[^\s\"'`<>()]+", re.IGNORECASE)
_INLINE_BODY_LIMIT = 200_000
_SCRIPT_SCAN_LIMIT = 100_000     # characters, for the whole call
_SCRIPT_MATCH_LIMIT = 400        # matches examined, for the whole call
_SCRIPT_HOST_LIMIT = 25
_BROWSER_SCRIPT_COVERAGE = (
    "Only URLs written in the script are recorded. A URL built while the script runs, "
    "and hosts a page loads by itself, are not visible from this boundary."
)
_SKIP, _HOST, _UNREADABLE, _INLINE = "skip", "host", "unreadable", "inline"


def _browser_ipv4(host: str):
    """A host whose last label is a number is an IPv4 address to a browser,
    in decimal, octal or hex, with one to four parts. Returns the dotted
    form, False when it is numeric but not a valid address, None when the
    host is a name."""
    parts = host.split(".")
    last = parts[-1]
    if not (last.isdigit() or re.fullmatch(r"0[xX][0-9A-Fa-f]*", last)):
        return None
    if len(parts) > 4:
        return False
    numbers = []
    for part in parts:
        try:
            if part[:2].lower() == "0x":
                numbers.append(int(part[2:] or "0", 16))
            elif len(part) > 1 and part[0] == "0":
                numbers.append(int(part, 8))
            else:
                numbers.append(int(part, 10))
        except ValueError:
            return False
    if any(n > 255 for n in numbers[:-1]) or numbers[-1] >= 256 ** (5 - len(numbers)):
        return False
    value = numbers[-1]
    for i, n in enumerate(numbers[:-1]):
        value += n << (8 * (3 - i))
    return ".".join(str((value >> s) & 255) for s in (24, 16, 8, 0))


def _browser_host(raw: str) -> Optional[str]:
    """The host as a browser resolves it: width and case folded, percent
    escapes decoded, dots unified, a trailing dot dropped, numeric forms
    turned into the address, other scripts into punycode. None when a
    browser would not accept it."""
    import unicodedata
    from urllib.parse import unquote

    if not raw or _BAD_PERCENT_RE.search(raw):
        return None
    host = unicodedata.normalize("NFKC", unquote(raw))
    host = host.replace("。", ".").replace("．", ".").replace("｡", ".").lower()
    if host.endswith("."):
        host = host[:-1]
    if not host or _HOST_FORBIDDEN_RE.search(host):
        return None
    numeric = _browser_ipv4(host)
    if numeric is False:
        return None
    if numeric:
        return numeric
    if not host.isascii():
        try:
            host = host.encode("idna").decode("ascii")
        except (UnicodeError, ValueError):
            return None
    return host if _plausible_host(host.replace("_", "-")) else None


def _browser_url_target(raw):
    """How a browser would treat ``raw`` as an address: ``(state, host,
    scheme, port)``. ``skip`` names no remote destination (history words,
    about:, file:, data: and the like), ``host`` is a destination, and
    ``unreadable`` is something a browser may load that this cannot resolve.

    Follows the browser's reading where it differs from a general URL
    parser: edge whitespace and control characters are dropped, a backslash
    is a slash, any number of slashes may follow the scheme, and what stands
    before the last ``@`` of the authority is credentials, not the host."""
    if not isinstance(raw, str):
        return _SKIP, None, None, None
    text = raw.strip(_URL_EDGE_CHARS).replace("\t", "").replace("\n", "").replace("\r", "")
    if not text or text.lower() in _BROWSER_HISTORY_WORDS:
        return _SKIP, None, None, None
    if len(text) > 4096:
        return _UNREADABLE, None, None, None
    while text[:12].lower() == "view-source:":
        text = text[12:]
    scheme = None
    rest = text
    match = _URL_SCHEME_RE.match(text)
    if match:
        name = match.group(1).lower()
        after = text[match.end():]
        if name in _BROWSER_LOCAL_SCHEMES:
            return _SKIP, None, None, None
        if name in _BROWSER_INLINE_SCHEMES:
            return _INLINE, None, name, None
        if name == "file":
            # file:///path is local; file://host/share opens a share on that host.
            share = after.replace("\\", "/")
            if not share.startswith("//"):
                return _SKIP, None, None, None
            host_text = re.split(r"[/?#]", share[2:], maxsplit=1)[0]
            if not host_text or host_text.lower() == "localhost":
                return _SKIP, None, None, None
            host = _browser_host(host_text)
            return (_HOST, host, "file", None) if host else (_UNREADABLE, None, None, None)
        if name in _BROWSER_NETWORK_SCHEMES:
            scheme, rest = name, after.replace("\\", "/").lstrip("/")
        elif not _HOST_PORT_REST_RE.match(after):
            return _UNREADABLE, None, None, None      # a scheme this does not know
    if scheme is None:
        rest = rest.replace("\\", "/")
        if rest.startswith("//"):
            rest = rest[2:]                           # same scheme as the current page
        elif rest.startswith("/"):
            return _UNREADABLE, None, None, None
    authority = re.split(r"[/?#]", rest, maxsplit=1)[0]
    authority = authority.rsplit("@", 1)[-1]
    port = None
    if authority.startswith("["):
        end = authority.find("]")
        if end < 0:
            return _UNREADABLE, None, None, None
        try:
            import ipaddress
            address = ipaddress.IPv6Address(authority[1:end])
        except ValueError:
            return _UNREADABLE, None, None, None
        # ::ffff:a.b.c.d and the NAT64 form 64:ff9b::a.b.c.d reach the IPv4
        # address; record it as that.
        if address.ipv4_mapped is not None:
            host = str(address.ipv4_mapped)
        elif int(address) >> 32 == 0x0064FF9B << 64:
            host = str(ipaddress.IPv4Address(int(address) & 0xFFFFFFFF))
        else:
            host = str(address)
        port_text = authority[end + 1:]
        if port_text and not re.fullmatch(r":\d{0,5}", port_text):
            return _UNREADABLE, None, None, None
        port_text = port_text[1:]
    else:
        host_text, _, port_text = authority.partition(":")
        if port_text and not port_text.isdigit():
            return _UNREADABLE, None, None, None
        host = _browser_host(host_text)
        if host is None:
            return _UNREADABLE, None, None, None
    if port_text:
        port = int(port_text)
        if port > 65535:
            return _UNREADABLE, None, None, None
    return _HOST, host, scheme, port


def _unread_attempt(detector: str, evidence: str) -> EgressAttempt:
    """Something that may reach the network and could not be resolved."""
    return EgressAttempt(
        host=None, operation=UNKNOWN, kind="http", detector=detector,
        confidence=HEURISTIC, evidence=_truncate(evidence))


def browser_inline_body(raw) -> Optional[str]:
    """The content of a ``javascript:`` or ``data:`` URL as text, read the way
    a browser reads the URL. ``""`` when ``raw`` is not such a URL; None when
    the content cannot be read (a base64 body that does not decode, or one
    over the size limit)."""
    if _browser_url_target(raw)[0] != _INLINE:
        return ""
    from urllib.parse import unquote
    text = raw.strip(_URL_EDGE_CHARS).replace("\t", "").replace("\n", "").replace("\r", "")
    while text[:12].lower() == "view-source:":
        text = text[12:]
    scheme, _, body = text.partition(":")
    if len(body) > _INLINE_BODY_LIMIT:
        return None
    if scheme.lower() != "data":
        return unquote(body)
    header, comma, payload = body.partition(",")
    if not comma:
        return ""
    if "base64" not in header.lower():
        return unquote(payload)
    import base64
    import binascii
    try:
        data = re.sub(r"\s+", "", unquote(payload))
        return base64.b64decode(data + "=" * (-len(data) % 4), validate=True).decode("latin-1")
    except (binascii.Error, ValueError):
        return None


def _navigate_attempts(raw) -> list:
    state, host, scheme, port = _browser_url_target(raw)
    if state == _SKIP:
        return []
    if state == _INLINE:
        body = browser_inline_body(raw)
        if body is None:
            return [_unread_attempt("browser.navigate", _truncate(str(raw)))]
        return _script_attempts([body])
    return [EgressAttempt(
        host=host, operation=READ, kind="http", detector="browser.navigate",
        confidence=EXACT if state == _HOST else HEURISTIC, scheme=scheme, port=port,
        evidence=_truncate(str(raw)),
    )]


def _script_attempts(texts):
    """One attempt per distinct host written in the script texts, within one
    budget for the whole call. Recorded once without a host: a URL that
    carries a backslash (a script escape can rebuild any character), one
    joined to more text, one that cannot be resolved, and anything left
    unscanned when a limit is reached. A limit is never silent."""
    attempts, seen_hosts, seen_raw = [], set(), set()
    unread = None            # evidence for the single hostless attempt
    budget, examined = _SCRIPT_SCAN_LIMIT, 0
    for text in texts:
        if budget <= 0:
            if text:
                unread = unread or "script text past the scan limit"
            continue
        chunk = text[:budget]
        cut = len(text) > len(chunk)
        budget -= len(chunk)
        if cut:
            unread = unread or "script text past the scan limit"
        for match in _SCRIPT_URL_RE.finditer(chunk):
            examined += 1
            raw = match.group(0)
            if examined > _SCRIPT_MATCH_LIMIT or len(attempts) >= _SCRIPT_HOST_LIMIT:
                unread = unread or raw
                break
            if raw in seen_raw:
                continue
            seen_raw.add(raw)
            if "\\" in raw or (cut and match.end() == len(chunk)) \
                    or _JOINED_AFTER_RE.match(chunk, match.end()):
                unread = unread or raw
                continue
            state, host, scheme, port = _browser_url_target(raw)
            if state == _SKIP:
                continue
            if state != _HOST:
                unread = unread or raw
                continue
            if host in seen_hosts:
                continue
            seen_hosts.add(host)
            attempts.append(EgressAttempt(
                host=host, operation=UNKNOWN, kind="http", detector="browser.script",
                confidence=HEURISTIC, scheme=scheme, port=port, evidence=_truncate(raw)))
    if unread is not None:
        attempts.append(_unread_attempt("browser.script", unread))
    return attempts


def _walk_parts(root, in_script: bool):
    """(urls, script texts, complete) found anywhere under ``root``, in
    order, within a node and depth limit. With ``in_script`` every string is
    script text; otherwise a string is read by its key (``url``, or a script
    key, under which every nested string is script text too). ``complete``
    is False when a limit left part of the input unread."""
    urls, scripts, complete = [], [], True
    stack, visited = [(root, 0, in_script)], 0
    while stack:
        if visited >= _BATCH_NODE_LIMIT:
            complete = False
            break
        node, depth, scripted = stack.pop()
        visited += 1
        if depth > _BATCH_DEPTH_LIMIT:
            complete = False
            continue
        if isinstance(node, dict):
            items = [(str(k).lower(), v) for k, v in node.items()]
        else:
            items = [(None, v) for v in node]
        nested = []
        for key, value in items:
            keyed = scripted or key in _BATCH_SCRIPT_KEYS
            if isinstance(value, str):
                if key == "url" and not scripted:
                    urls.append(value)
                elif keyed:
                    scripts.append(value)
            elif isinstance(value, (dict, list)):
                nested.append((value, depth + 1, keyed))
        stack.extend(reversed(nested))
    return urls, scripts, complete


def browser_tool_parts(tool_name: str, tool_input) -> tuple:
    """(urls, script texts, complete) a browser automation tool call carries,
    or ``([], [], True)`` when the tool is not one. ``complete`` is False
    when the input was too large or too deep to read in full. ``tool_name``
    is the host-supplied name; only the tool part after the last ``__`` is
    read."""
    tool_input = tool_input if isinstance(tool_input, dict) else {}
    tool = (tool_name or "").strip().lower().rsplit("__", 1)[-1]
    if tool in _BROWSER_NAVIGATE_TOOLS:
        url = tool_input.get("url")
        return ([url] if isinstance(url, str) else []), [], True
    if tool in _BROWSER_SCRIPT_TOOLS:
        return _walk_parts(tool_input, True)
    if tool in _BROWSER_BATCH_TOOLS:
        return _walk_parts(tool_input, False)
    return [], [], True


def browser_script_texts(tool_name: str, tool_input) -> tuple:
    """(script texts, complete) for a browser tool call: its scripts plus the
    content of any ``javascript:`` or ``data:`` URL it opens."""
    urls, scripts, complete = browser_tool_parts(tool_name, tool_input)
    texts = list(scripts)
    for url in urls:
        body = browser_inline_body(url)
        if body is None:
            complete = False
        elif body:
            texts.append(body)
    return texts, complete


def _browser_attempts(tool_name: str, tool_input: dict):
    """Attempts for a browser automation tool call, and a coverage note.
    ([], None) when the tool is not one, or names no network destination."""
    urls, scripts, complete = browser_tool_parts(tool_name, tool_input)
    attempts = []
    if not complete:
        attempts.append(_unread_attempt("browser.script", "input too large or too deep to read in full"))
    for url in urls[:_SCRIPT_HOST_LIMIT]:
        attempts.extend(_navigate_attempts(url))
    if len(urls) > _SCRIPT_HOST_LIMIT:
        attempts.append(_unread_attempt("browser.navigate", f"{len(urls) - _SCRIPT_HOST_LIMIT} more URLs in one call"))
    scripted = _script_attempts(scripts) if scripts else []
    note = _BROWSER_SCRIPT_COVERAGE if scripted or any(a.detector == "browser.script" for a in attempts) else None
    return attempts + scripted, note


def extract_from_tool_call(
    tool_name: str,
    tool_input: Optional[dict] = None,
    mcp_endpoint: Optional[str] = None,
) -> ExtractionResult:
    """Extract every network destination a single tool call would reach.

    Args:
        tool_name: Host-supplied tool name (`WebFetch`, `Bash`, `mcp__srv__tool`).
        tool_input: The tool's argument object, as the runtime supplied it.
        mcp_endpoint: For remote MCP tools, the server's resolved endpoint URL.

    Returns:
        ExtractionResult. `network_capable=False` means the caller should skip
        egress evaluation entirely — this is the fast path for the vast
        majority of tool calls.
    """
    tool_input = tool_input or {}
    name = (tool_name or "").strip()
    lowered = name.lower()

    # Remote MCP tools reach whatever their server reaches. We can only see the
    # server endpoint; see the proxy caveat in coverage below.
    if lowered.startswith("mcp__"):
        # A browser tool opens a page the agent chose, wherever its server runs.
        browser, browser_note = _browser_attempts(lowered, tool_input)
        if not mcp_endpoint:
            # A local (stdio) MCP server has no network destination of its own.
            if not browser:
                return ExtractionResult(network_capable=False)
            return ExtractionResult(attempts=browser, network_capable=True, coverage=browser_note)
        host, scheme, port = _host_from_url(mcp_endpoint)
        return ExtractionResult(
            attempts=[EgressAttempt(
                host=host, operation=UNKNOWN, kind="mcp", detector="mcp.endpoint",
                confidence=EXACT if host else HEURISTIC, scheme=scheme, port=port,
                evidence=_truncate(name),
            )] + browser,
            network_capable=True,
            coverage=(
                "A remote MCP server is an egress proxy: this records the server "
                "endpoint only. Any host the server itself reaches downstream is "
                "not observable from this boundary."
            ),
        )

    if lowered not in NETWORK_CAPABLE_BUILTINS:
        return ExtractionResult(network_capable=False)

    if lowered == "webfetch":
        raw_url = tool_input.get("url") or tool_input.get("URL") or ""
        host, scheme, port = _host_from_url(str(raw_url))
        return ExtractionResult(
            attempts=[EgressAttempt(
                host=host,
                # WebFetch is a GET-shaped retrieval in every runtime that ships
                # it today. If a runtime adds a body parameter this must change.
                operation=READ,
                kind="http", detector="tool.webfetch",
                confidence=EXACT if host else HEURISTIC,
                scheme=scheme, port=port, evidence=_truncate(str(raw_url)),
            )],
            network_capable=True,
        )

    if lowered == "websearch":
        # A search reaches the runtime vendor's own search backend, which is not
        # a destination the operator chose and not one worth policing. Recorded
        # as network-capable with no destination so it appears in coverage
        # rather than being silently dropped.
        return ExtractionResult(
            attempts=[],
            network_capable=True,
            coverage="WebSearch reaches the runtime vendor's search backend; "
                     "no operator-selected destination is involved.",
        )

    # Bash / PowerShell
    command = tool_input.get("command") or tool_input.get("script") or ""
    return extract_from_bash(str(command))
