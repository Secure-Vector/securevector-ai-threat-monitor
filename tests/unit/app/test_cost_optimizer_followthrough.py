"""Follow-through on a copied fix: copied -> pasted -> worked.

The distinction between the three states is the point of the feature. A paste
is not a win; only a measured change is. These tests pin that boundary so a
later refactor cannot quietly start congratulating people for pasting.
"""

from securevector.app.services.cost_optimizer import (
    fix_fingerprint,
    find_paste,
    fix_metrics,
    fix_worked,
)


def _user(text):
    return {"type": "user", "message": {"content": text}}


SNIPPET = (
    "From now on, keep tool results small: search first, then read only the "
    "specific line ranges you need, and keep any single tool result under "
    "about 2K tokens."
)


class TestPasteDetection:
    def test_finds_a_verbatim_paste(self):
        recs = [_user("carry on"), _user(SNIPPET)]
        assert find_paste(recs, fix_fingerprint(SNIPPET), None) == 1

    def test_finds_an_edited_paste(self):
        # Users trim the snippet before pasting. Word overlap catches that.
        edited = ("keep tool results small: search first, then read only the "
                  "specific line ranges you need. under 2K tokens please")
        assert find_paste([_user(edited)], fix_fingerprint(SNIPPET), None) == 0

    def test_ignores_an_unrelated_turn(self):
        recs = [_user("run the tests again"), _user("thanks")]
        assert find_paste(recs, fix_fingerprint(SNIPPET), None) is None

    def test_ignores_assistant_turns(self):
        # Only what the human typed counts as a paste: the assistant quoting
        # the advice back is not the user applying it.
        rec = {"type": "assistant", "message": {"content": SNIPPET}}
        assert find_paste([rec], fix_fingerprint(SNIPPET), None) is None

    def test_reads_block_content(self):
        rec = {"type": "user",
               "message": {"content": [{"type": "text", "text": SNIPPET}]}}
        assert find_paste([rec], fix_fingerprint(SNIPPET), None) == 0

    def test_fingerprint_carries_no_user_text(self):
        # It is derived from our own template and nothing else.
        assert fix_fingerprint(SNIPPET) in fix_fingerprint(SNIPPET + " extra")


class TestVerdict:
    def test_compact_needs_context_to_actually_drop(self):
        before = {"context_tokens": 150_000}
        assert fix_worked("compact_act_now", before, {"context_tokens": 40_000})
        assert not fix_worked("compact_act_now", before,
                              {"context_tokens": 140_000})

    def test_compact_with_no_before_is_not_a_win(self):
        # Never celebrate on a missing baseline: unknown is not improved.
        assert not fix_worked("compact_last_call", {},
                              {"context_tokens": 10_000})

    def test_flag_fixes_need_the_flag_to_be_gone(self):
        before = {"advisories": ["tool_result_carry"]}
        assert fix_worked("tool_result_carry", before, {"advisories": []})
        assert not fix_worked("tool_result_carry", before,
                              {"advisories": ["tool_result_carry"]})

    def test_metrics_slice_is_numbers_only(self):
        snap = {"context_tokens_now": 1000, "fill_pct": 12.5,
                "advisories": [{"type": "failure_loop", "streak": 5}],
                "model": "claude-opus-5"}
        m = fix_metrics(snap)
        assert m == {"context_tokens": 1000, "fill_pct": 12.5,
                     "advisories": ["failure_loop"]}


from securevector.app.services.cost_optimizer import (  # noqa: E402
    CostOptimizerService,
    _compact_boundaries,
    _effective_ceiling,
    analyze_live_tail,
)


def _usage(ctx, model="claude-fable-5"):
    return {"type": "assistant",
            "message": {"model": model, "usage": {"input_tokens": ctx}}}


def _boundary(trigger, pre):
    return {"type": "system", "subtype": "compact_boundary",
            "compactMetadata": {"trigger": trigger, "preTokens": pre}}


class TestEffectiveCeiling:
    """The fill-% denominator comes from evidence, never from a guess."""

    def test_boundaries_are_read_not_inferred(self):
        recs = [_usage(1000), _boundary("auto", 600_000), _usage(2000)]
        assert _compact_boundaries(recs) == [(1, "auto", 600_000)]

    def test_auto_trigger_point_beats_the_model_lookup(self):
        recs = [_boundary("auto", 600_000)]
        assert _effective_ceiling("claude-fable-5[1m]", recs, 0) == 600_000

    def test_most_recent_auto_trigger_wins(self):
        recs = [_boundary("auto", 600_000), _boundary("auto", 400_000)]
        assert _effective_ceiling(None, recs, 0) == 400_000

    def test_manual_compacts_say_nothing_about_the_ceiling(self):
        recs = [_boundary("manual", 90_000)]
        assert _effective_ceiling(None, recs, 0) == 200_000

    def test_observed_peak_disproves_the_lookup(self):
        # the "118% full" bug: lookup said 200K, the session said otherwise
        assert _effective_ceiling(None, [], 236_000) == 236_000

    def test_fill_never_exceeds_one_hundred(self):
        recs = [_usage(236_000)]
        snap = analyze_live_tail(recs)
        assert snap["fill_pct"] <= 100.0
        assert snap["context_window"] == 236_000


class TestAutocompactAttribution:
    """A context drop the harness caused is not the user's win."""

    def _fix_and_tails(self, extra_after):
        svc = CostOptimizerService()
        fix = {"id": "x1", "type": "compact_act_now", "status": "pasted",
               "session_id": "s1", "copied_at": "2026-08-26T00:00:00Z",
               "fingerprint": fix_fingerprint(SNIPPET),
               "baseline": {"context_tokens": 150_000, "fill_pct": 75.0,
                            "advisories": []}}
        after = [_usage(40_000) for _ in range(4)] + extra_after
        tails = {"s1": [_user(SNIPPET)] + after}
        svc._advance_fix(fix, tails, {}, 0)
        return fix

    def test_auto_compact_is_never_credited(self):
        fix = self._fix_and_tails([_boundary("auto", 600_000)])
        assert fix["status"] == "auto_compacted"

    def test_manual_compact_after_paste_stays_a_win(self):
        # running /compact is what the pasted fix asks for
        fix = self._fix_and_tails([_boundary("manual", 150_000)])
        assert fix["status"] == "worked"
