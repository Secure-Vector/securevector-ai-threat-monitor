"""
Scope expansion — notice the shape of the traffic, not just each destination.

Every destination an agent reaches can be individually unremarkable while the
pattern is the whole story. The 2026-08 eval-containment incident scanned about
nine thousand hosts; not one of those requests would have tripped a
destination rule, because scanning nine thousand hosts is nine thousand
ordinary-looking reads. The signal was never in any single call. It was in the
count.

So this measures the shape: how many distinct hosts a session reached, how many
of them this device had never seen before, and how fast. Three deliberate
constraints:

**It alerts, it never blocks.** A rate threshold is a heuristic, and heuristics
that halt work get switched off within a week. A test suite that legitimately
fetches two hundred fixtures must not be stopped by a number somebody guessed.
Alerting keeps the signal available without spending the user's trust on it.

**It refuses to fire without a baseline.** On a fresh install every host is
novel, so a novelty detector would fire on the first session every time and be
muted before it ever saw a real one. Below a minimum of known hosts the answer
is `insufficient_baseline`, which says so rather than guessing.

**Novelty is measured against the device, not the session.** A session reaching
forty hosts it has used every day for a month is a busy session. A session
reaching forty hosts this device has never contacted is a different event, and
conflating the two is what makes volume alerts worthless.
"""

import logging

logger = logging.getLogger(__name__)

# Below this many known hosts, novelty carries no information: everything is
# new because the device has barely been observed. Chosen to be crossed within
# an ordinary day of agent work, not to be a tuning knob.
MIN_BASELINE_HOSTS = 25

# A session touching more distinct hosts than this is unusual for interactive
# agent work. Stated as a threshold rather than hidden in a scoring function so
# an operator can disagree with it concretely.
DISTINCT_HOST_ALERT = 30

# Novel hosts matter more than total hosts, so the bar is lower.
NOVEL_HOST_ALERT = 15

# Hosts per minute. Sustained fan-out at this rate is not a person waiting on
# results; it is a loop.
RATE_ALERT_PER_MINUTE = 10.0

STATUS_QUIET = "quiet"
STATUS_ELEVATED = "elevated"
STATUS_EXPANDING = "expanding"
STATUS_NO_BASELINE = "insufficient_baseline"


def assess(session: dict, known_host_count: int) -> dict:
    """Classify one session's egress shape.

    `session` is a row from `EgressRepository.session_scope`. Returns a verdict
    plus the reasons behind it, so the UI never shows a severity without the
    sentence that produced it.
    """
    distinct = int(session.get("distinct_hosts") or 0)
    novel = int(session.get("novel_hosts") or 0)
    minutes = float(session.get("span_minutes") or 0)
    # A burst inside a single second has no measurable span. Flooring at a few
    # seconds avoids reporting an infinite rate for two calls that happened to
    # land in the same tick.
    rate = distinct / max(minutes, 0.05) if distinct else 0.0

    if known_host_count < MIN_BASELINE_HOSTS:
        return {
            **session,
            "status": STATUS_NO_BASELINE,
            "rate_per_minute": round(rate, 1),
            "reasons": [
                f"This device has only seen {known_host_count} destinations so far. "
                f"Novelty needs at least {MIN_BASELINE_HOSTS} before it means "
                "anything, because on a new install every host is new."
            ],
        }

    reasons = []
    if novel >= NOVEL_HOST_ALERT:
        reasons.append(
            f"{novel} destinations this device had never contacted before, in a "
            "single session."
        )
    if distinct >= DISTINCT_HOST_ALERT:
        reasons.append(f"{distinct} distinct destinations in a single session.")
    if rate >= RATE_ALERT_PER_MINUTE and distinct >= 10:
        reasons.append(
            f"About {rate:.0f} new destinations per minute, which is a loop "
            "rather than someone waiting on results."
        )

    # Novelty alone escalates; volume alone does not. A busy session against
    # familiar infrastructure is a busy session, and treating it as an incident
    # is how a signal gets muted.
    if novel >= NOVEL_HOST_ALERT and len(reasons) > 1:
        status = STATUS_EXPANDING
    elif reasons:
        status = STATUS_ELEVATED
    else:
        status = STATUS_QUIET

    return {
        **session,
        "status": status,
        "rate_per_minute": round(rate, 1),
        "reasons": reasons,
    }


def summarize(assessments: list) -> dict:
    """Roll per-session verdicts into the banner the Destinations tab shows."""
    expanding = [a for a in assessments if a["status"] == STATUS_EXPANDING]
    elevated = [a for a in assessments if a["status"] == STATUS_ELEVATED]

    def _sessions(n):
        return f"{n} session" if n == 1 else f"{n} sessions"

    if expanding:
        status, headline = STATUS_EXPANDING, (
            f"{_sessions(len(expanding))} reached an unusual number of "
            "destinations this device had never seen before."
        )
    elif elevated:
        status, headline = STATUS_ELEVATED, (
            f"{_sessions(len(elevated))} reached more destinations than usual."
        )
    elif any(a["status"] == STATUS_NO_BASELINE for a in assessments):
        status, headline = STATUS_NO_BASELINE, (
            "Not enough history yet to say whether any session is unusual."
        )
    else:
        status, headline = STATUS_QUIET, "No unusual egress patterns."

    return {
        "status": status,
        "headline": headline,
        "sessions": [a for a in assessments if a["status"] != STATUS_QUIET],
        "note": (
            "This is an alert, not an enforcement action. Nothing was blocked "
            "on the basis of volume: a rate threshold is a guess, and a guess "
            "that halts real work gets switched off. Destination policy is what "
            "blocks; this only tells you where to look."
        ),
        "thresholds": {
            "distinct_hosts": DISTINCT_HOST_ALERT,
            "novel_hosts": NOVEL_HOST_ALERT,
            "rate_per_minute": RATE_ALERT_PER_MINUTE,
            "min_baseline_hosts": MIN_BASELINE_HOSTS,
        },
    }
