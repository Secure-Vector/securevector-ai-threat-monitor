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
    "-w", "--write-out", "--oauth2-bearer", "--tlsv1", "--limit-rate",
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
    for tok in tokens[1:]:
        if skip_next:
            skip_next = False
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
    """nc / telnet / socat — protocol is opaque, so the operation is UNKNOWN."""
    host = None
    port = None
    for tok in tokens[1:]:
        if tok.startswith("-"):
            continue
        if _BARE_HOST_RE.match(tok) and not tok.isdigit() and _plausible_host(tok):
            host = tok.lower()
        elif tok.isdigit():
            port = int(tok)
        else:
            parsed, _, parsed_port = _host_from_url(tok)
            if parsed:
                host, port = parsed, parsed_port or port
    return [EgressAttempt(
        host=host, operation=UNKNOWN, kind="raw_socket", detector=detector,
        confidence=PARSED if host else HEURISTIC, port=port,
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
        if not mcp_endpoint:
            # A local (stdio) MCP server has no network destination of its own.
            return ExtractionResult(network_capable=False)
        host, scheme, port = _host_from_url(mcp_endpoint)
        return ExtractionResult(
            attempts=[EgressAttempt(
                host=host, operation=UNKNOWN, kind="mcp", detector="mcp.endpoint",
                confidence=EXACT if host else HEURISTIC, scheme=scheme, port=port,
                evidence=_truncate(name),
            )],
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
