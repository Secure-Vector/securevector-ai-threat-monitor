/**
 * TraceSteps: a trace's spans as a short list of steps.
 *
 * One step per model turn (generation span): a two part time bar (model
 * time, then the tool time that followed it) and the tool calls that turn
 * made. Shared by Agent Sessions (the Traces rail) and the Traces page, and
 * by the Traces exports, so every surface groups a run the same way.
 *
 * Everything here is pure: plain data in, plain data or an HTML string out.
 * Every server string is escaped before it reaches markup.
 */
(function (root) {
    const TraceSteps = {
        STEPS_MAX: 6,             // rows shown before "+ N more steps"
        STEPS_BAR_W: 64,          // px, the widest bar in a run
        STEPS_SEG_MIN_W: 3,       // px, so a short but real segment still shows
        STEPS_TOOL_CAP_MS: 300000, // an idle person is not tool time; cap at 5 min
        STEPS_CHIPS_MAX: 8,       // chips per step before "+N more"
        STEPS_FLAT_GAP_MS: 60000, // with no model turns, a pause this long starts a new step
        // Codex's own agent-coordination tools: they never reach a hook and act
        // only inside Codex. Never list anything that runs commands, edits files or uses the network.
        UNCHECKED_IGNORE: ['wait', 'wait_agent', 'send_message', 'list_agents', 'interrupt_agent', 'followup_task', 'update_plan', 'request_user_input_async',
            // Claude Code's read-only and UI helpers (tool discovery, questions to
            // the person, reading a shell's output, the todo list, plan mode):
            // the Guard hook skips or has nothing to govern in them.
            'ToolSearch', 'AskUserQuestion', 'BashOutput', 'TaskOutput', 'TodoWrite', 'TodoRead', 'EnterPlanMode', 'ExitPlanMode',
            // Claude's own agent coordination (messages between its agents, its
            // notification inbox): no effect outside Claude. Agent / Task stay counted.
            'SendMessage', 'ListAgents', 'ReadNotifications'],

        esc(s) {
            return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        },

        /** Epoch ms for a span timestamp, or null. */
        time(iso) {
            if (iso == null || iso === '') return null;
            // SQLite writes "YYYY-MM-DD HH:MM:SS" in UTC with no zone; read it as UTC.
            const str = String(iso);
            const t = Date.parse(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(str) ? `${str.replace(' ', 'T')}Z` : str);
            return Number.isFinite(t) ? t : null;
        },

        /** "2026-09-24 19:26:12": a timestamp with no fraction of a second. */
        wholeSecond(iso) {
            return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:?\d{2})?$/.test(String(iso == null ? '' : iso));
        },

        /** Session lifecycle sentinels the Guard plugins emit around a run
         *  (__session_start__ / __session_end__). They are boundaries, not calls. */
        isBoundaryRow(row) {
            const sentinel = (name) => {
                const s = String(name || '');
                return s.length >= 4 && s.slice(0, 2) === '__' && s.slice(-2) === '__';
            };
            return sentinel(row && row.function_name) || sentinel(row && row.tool_id);
        },

        /** Group a trace's spans into steps. Each generation opens a step; a
         *  tool call joins the generation whose span_id is its parent_span_id,
         *  else the latest generation before it. Calls before any generation
         *  form a leading step. With no generation at all, calls form flat
         *  steps split on a pause over STEPS_FLAT_GAP_MS, with no bar. Each
         *  step carries model/tool times in ms (null when not known) and
         *  whether the tool time was capped. */
        build(spans, opts = {}) {
            const rank = (s) => (s.span_kind === 'generation' ? 0 : 1);
            let carry = -Infinity;
            const genTimes = (Array.isArray(spans) ? spans : [])
                .filter(s => s && s.span_kind === 'generation')
                .map(s => this.time(s.called_at)).filter(t => t != null).sort((a, b) => a - b);
            const list = (Array.isArray(spans) ? spans : [])
                .filter(s => s && typeof s === 'object')
                // Session markers are boundaries, not calls; they are logged
                // with no verdict of their own. One that was ever refused is a
                // real verdict and stays.
                .filter(s => !(this.isBoundaryRow(s) && s.action !== 'block'))
                .map((s, i) => {
                    const t = this.time(s.called_at);
                    if (t != null) carry = t;
                    // Hook rows are stamped to the whole second; the model
                    // call that asked for the tool ends a few ms into that
                    // second. For ordering only, read such a call as the end
                    // of its second so it joins that call, not the one before.
                    // Never past the next generation, so two model calls in
                    // one second keep their order (a tie sorts the generation first).
                    let shift = 0;
                    if (t != null && s.span_kind !== 'generation' && this.wholeSecond(s.called_at)) {
                        const next = genTimes.find(g => g >= t);
                        shift = next == null ? 999 : Math.min(999, next - t);
                    }
                    return { s, i, t, k: t != null ? t + shift : carry };
                })
                .sort((a, b) => (a.k - b.k) || (rank(a.s) - rank(b.s)) || (a.i - b.i));
            const gens = list.filter(x => x.s.span_kind === 'generation');
            const tools = list.filter(x => x.s.span_kind !== 'generation');
            if (!gens.length) {
                // No model turns to hang calls on: a pause of over a minute
                // between calls starts a new step, so a long run stays readable.
                const flat = [];
                let prev = null;
                for (const x of tools) {
                    if (!flat.length || (x.t != null && prev != null && x.t - prev > this.STEPS_FLAT_GAP_MS)) {
                        flat.push({ gen: null, leading: false, flat: true, start: null, lastTool: null, tools: [], model: null, tool: null, step: null, capped: false });
                    }
                    flat[flat.length - 1].tools.push(x.s);
                    if (x.t != null) prev = x.t;
                }
                flat.forEach(step => { step.unchecked = []; });
                return flat;
            }
            const steps = [];
            const byId = new Map();
            const stepOf = new Map();
            for (const x of gens) {
                const d = Number(x.s.duration_ms);
                const step = {
                    gen: x.s, leading: false, flat: false, start: x.t, lastTool: null, tools: [],
                    model: x.s.duration_ms != null && Number.isFinite(d) && d >= 0 ? d : null,
                    tool: null, step: null, capped: false,
                };
                steps.push(step);
                stepOf.set(x, step);
                if (x.s.span_id != null && x.s.span_id !== '') byId.set(String(x.s.span_id), step);
            }
            let leading = null;
            let latest = null;
            for (const x of list) {
                if (x.s.span_kind === 'generation') { latest = stepOf.get(x); continue; }
                const parent = x.s.parent_span_id != null ? byId.get(String(x.s.parent_span_id)) : null;
                let step = parent || latest;
                if (!step) {
                    if (!leading) leading = { gen: null, leading: true, flat: false, start: x.t, lastTool: null, tools: [], model: null, tool: null, step: null, capped: false };
                    step = leading;
                }
                step.tools.push(x.s);
                if (x.t != null && (step.lastTool == null || x.t > step.lastTool)) step.lastTool = x.t;
            }
            if (leading) steps.unshift(leading);
            steps.forEach(step => { step.unchecked = this.unchecked(step); });
            this.matchEgress(steps, opts.egressBlocks);
            this.markFailed(steps);
            // Where the model part of a step begins and ends. A measured
            // duration_ms starts at called_at. A transcript turn's duration is
            // estimated back from its record (duration_estimated), so there the
            // model ran from called_at - duration_ms up to called_at.
            steps.forEach((step) => {
                if (step.start == null) { step.modelStart = null; step.genEnd = null; return; }
                const est = step.gen && step.gen.duration_estimated && step.model != null;
                step.modelStart = est ? step.start - step.model : step.start;
                step.genEnd = est ? step.start : step.start + (step.model || 0);
            });
            steps.forEach((step, n) => {
                if (step.start == null) return;
                // No tool calls, no tool time: the gap after a turn that
                // called nothing is the person reading or away.
                if (!step.tools.length && !step.unchecked.length) return;
                const next = steps[n + 1];
                // Tool time runs on to the next model start, unless that turn
                // began from a typed prompt: then the gap before it was the
                // person, and tool time ends at the step's last call. A turn
                // with no turn_start (proxy / SDK measured) keeps the old rule.
                let to;
                if (next && next.gen && next.gen.turn_start !== 'prompt') to = next.modelStart;
                else to = step.lastTool != null ? step.lastTool : step.genEnd;
                if (to == null) return;
                let gap = Math.max(0, to - step.genEnd);
                if (gap > this.STEPS_TOOL_CAP_MS) { gap = this.STEPS_TOOL_CAP_MS; step.capped = true; }
                // A turn with no model time cannot be split into thinking and
                // tools, so its whole gap is one neutral "step time" segment.
                if (step.gen && step.model == null) step.step = gap;
                else step.tool = gap;
            });
            return steps;
        },

        /** Calls the model made (its transcript's tool_use_names) that no
         *  governed tool span in the step accounts for, by name and count:
         *  3 Bash uses with 1 governed Bash span leave 2 not recorded. */
        unchecked(step) {
            const names = step && step.gen && Array.isArray(step.gen.tool_use_names) ? step.gen.tool_use_names : [];
            if (!names.length) return [];
            const seen = new Map();
            names.forEach(n => {
                if (n && !this.UNCHECKED_IGNORE.includes(String(n))) seen.set(String(n), (seen.get(String(n)) || 0) + 1);
            });
            const used = new Set();
            const out = [];
            for (const [name, count] of seen) {
                let covered = 0;
                step.tools.forEach(t => {
                    if (covered >= count || used.has(t)) return;
                    if (this.sameTool(name, t)) { used.add(t); covered++; }
                });
                if (count > covered) out.push({ name, count: count - covered });
            }
            return out;
        },

        /** Whether a transcript tool name and a governed span name the same
         *  tool. MCP tools: the transcript says mcp__server__tool (older Codex
         *  server__tool), the span carries that name and tool_id server:tool. */
        sameTool(name, span) {
            const n = String(name || '');
            const s = span || {};
            if (!n) return false;
            if (s.function_name === n || s.tool_id === n) return true;
            const bare = n.startsWith('mcp__') ? n.slice(5) : n;
            const i = bare.indexOf('__');
            if (i > 0 && i < bare.length - 2) {
                const colon = `${bare.slice(0, i)}:${bare.slice(i + 2)}`;
                if (s.tool_id === colon || s.function_name === `mcp__${bare}`) return true;
            }
            return false;
        },

        /** Egress denies are recorded in egress_audit, not as tool spans. A
         *  deny that matches a call the step would otherwise show as not
         *  recorded becomes a governed block on that call (host only). */
        matchEgress(steps, blocks) {
            const list = (Array.isArray(blocks) ? blocks : [])
                .filter(b => b && b.tool_name)
                .map(b => ({ b, t: this.time(b.called_at) }))
                .filter(x => x.t != null)
                .sort((a, b) => a.t - b.t);
            for (const { b, t } of list) {
                const tEff = t + (this.wholeSecond(b.called_at) ? 999 : 0);
                // Only the step whose window holds the deny: the last one that
                // started by then. No match there leaves the deny unmatched; it
                // never walks back to an earlier step's unrecorded call.
                let target = null;
                for (const step of steps) {
                    if (step.start != null && step.start <= tEff) target = step;
                }
                if (!target || !target.gen) continue;
                const entry = (target.unchecked || []).find(x => x.count > 0 && this.sameTool(x.name, { function_name: b.tool_name, tool_id: b.tool_name }));
                if (!entry) continue;
                const hosts = (Array.isArray(b.hosts) ? b.hosts : []).filter(Boolean).map(String);
                target.tools.push({
                    span_kind: 'tool_call', function_name: entry.name, tool_id: b.tool_name,
                    action: 'block', outcome: 'blocked', verdict: 'BLOCKED', egress: true,
                    reason: hosts.length ? `destination not allowed: ${hosts.join(', ')}` : 'destination not allowed',
                    detection_rules: (Array.isArray(b.rule_ids) ? b.rule_ids : []).filter(Boolean).map(String),
                    called_at: b.called_at,
                });
                if (target.lastTool == null || t > target.lastTool) target.lastTool = t;
                entry.count -= 1;
                target.unchecked = target.unchecked.filter(x => x.count > 0);
            }
        },

        /** Pixel widths for one step's segments, scaled so the run's longest
         *  step fills STEPS_BAR_W. A non-zero segment is never thinner than
         *  STEPS_SEG_MIN_W. */
        barWidths(step, maxTotal) {
            const w = (ms) => {
                if (!(ms > 0) || !(maxTotal > 0)) return 0;
                return Math.max(this.STEPS_SEG_MIN_W, Math.round((ms / maxTotal) * this.STEPS_BAR_W));
            };
            return { model: w(step.model), tool: w(step.tool), step: w(step.step) };
        },

        maxTotal(steps) {
            return steps.reduce((m, s) => Math.max(m, (s.model || 0) + (s.tool || 0) + (s.step || 0)), 0);
        },

        /** 450 ms, 3 s, 1 m 5 s, 2 h 3 m. Empty for anything not a duration. */
        fmtDur(ms) {
            const n = Number(ms);
            if (ms == null || ms === '' || !Number.isFinite(n) || n < 0) return '';
            if (n < 1000) return `${Math.round(n)} ms`;
            const s = Math.round(n / 1000);
            if (s < 60) return `${s} s`;
            const m = Math.floor(s / 60);
            if (m < 60) return s % 60 ? `${m} m ${s % 60} s` : `${m} m`;
            const h = Math.floor(m / 60);
            return m % 60 ? `${h} h ${m % 60} m` : `${h} h`;
        },

        /** "3 s + 2 s" when the step has both, else whichever it has. A capped
         *  tool time reads as a floor, not a measurement. */
        durText(step) {
            const model = step.model > 0 ? this.fmtDur(step.model) : '';
            const tool = step.tool > 0 ? `${step.capped ? '≥' : ''}${this.fmtDur(step.tool)}` : '';
            if (step.step > 0) return `${step.capped ? '≥' : ''}${this.fmtDur(step.step)}`;
            return model && tool ? `${model} + ${tool}` : (model || tool);
        },

        /** A block is blocked, an amber risk is flagged. A call that was only
         *  logged, or that a detection fired on, is flagged too. */
        chipState(span) {
            const s = span || {};
            if (s.action === 'block' || s.verdict === 'BLOCKED' || s.outcome === 'blocked') return 'blocked';
            const rules = Array.isArray(s.detection_rules) ? s.detection_rules.filter(Boolean) : [];
            if (s.risk === 'amber' || s.action === 'log_only' || s.action === 'warn'
                || s.verdict === 'LOG' || rules.length || s.detection_source) return 'flagged';
            // The tool ran and errored: not a security state, so neutral.
            if (this.isFailed(s)) return 'failed';
            return 'allowed';
        },

        /** A call whose result was an error: matched from the transcript
         *  (_failed, set in build) or an audit row PostToolUseFailure wrote. */
        isFailed(span) {
            const s = span || {};
            return !!(s._failed || s.is_error || /^tool error\b/.test(String(s.reason || '')));
        },

        /** The first line of a failed call's error, when the transcript text
         *  is stored; '' otherwise. */
        failedText(span) {
            const t = span && typeof span._error === 'string' ? span._error : '';
            const line = t.split('\n').map(x => x.trim()).find(Boolean) || '';
            return line.length > 80 ? `${line.slice(0, 80)}…` : line;
        },

        /** Mark the governed calls of each step whose transcript result was an
         *  error: results pair with the step's calls of the same tool, in order. */
        markFailed(steps) {
            // Derived on every build, never carried over from an earlier one.
            steps.forEach(step => step.tools.forEach(t => { if (t._failed || t._error) { delete t._failed; delete t._error; } }));
            steps.forEach(step => {
                const results = step.gen && Array.isArray(step.gen.tool_results) ? step.gen.tool_results : [];
                if (!results.length) return;
                const byName = new Map();
                results.forEach(r => {
                    const n = String((r && r.name) || '');
                    if (!byName.has(n)) byName.set(n, []);
                    byName.get(n).push(r);
                });
                const used = new Map();
                step.tools.forEach(t => {
                    if (t.egress) return;
                    const name = [...byName.keys()].find(n => n && this.sameTool(n, t));
                    if (!name) return;
                    const k = used.get(name) || 0;
                    const r = byName.get(name)[k];
                    used.set(name, k + 1);
                    if (r && r.is_error && !r.denied) {
                        t._failed = true;
                        if (typeof r.preview === 'string' && r.preview) t._error = r.preview;
                    }
                });
            });
        },

        /** A pending approval for this blocked call: same tool, and the same
         *  trace. An approval that carries no trace_id must at least have been
         *  requested at or after the call it would answer. */
        approvalFor(span, approvals, traceId) {
            const list = Array.isArray(approvals) ? approvals : [];
            const s = span || {};
            const sameTool = (a) => (a.tool_id && s.tool_id && a.tool_id === s.tool_id)
                || (a.function_name && s.function_name && a.function_name === s.function_name);
            return list.find(a => {
                if (!a || !sameTool(a)) return false;
                if (a.trace_id) return a.trace_id === traceId;
                const asked = this.time(a.requested_at || a.created_at);
                const called = this.time(s.called_at);
                return asked != null && called != null && asked >= called;
            }) || null;
        },

        /** Stable keys for a run's calls, so an open detail and focus follow
         *  the call rather than its position when the run grows. */
        chipKeys(steps) {
            const seen = new Map();
            return steps.map(st => st.tools.map(t => {
                if (t.span_id != null && t.span_id !== '') return `s:${t.span_id}`;
                const base = `${t.called_at == null ? '' : t.called_at}|${t.function_name || t.tool_id || ''}`;
                const n = seen.get(base) || 0;
                seen.set(base, n + 1);
                return `k:${base}|${n}`;
            }));
        },

        /** The call a chip key names, or null. */
        spanForKey(steps, key) {
            const keys = this.chipKeys(steps);
            for (let si = 0; si < steps.length; si++) {
                const ti = keys[si].indexOf(key);
                if (ti >= 0) return steps[si].tools[ti];
            }
            return null;
        },

        /** Consecutive calls with the same name and state, merged. */
        groups(step) {
            const out = [];
            step.tools.forEach((t, ti) => {
                const state = this.chipState(t);
                const name = t.function_name || t.tool_id || 'tool';
                const g = out[out.length - 1];
                if (g && g.name === name && g.state === state) { g.count++; g.calls.push(t); }
                else out.push({ t, ti, name, state, count: 1, calls: [t] });
            });
            return out;
        },

        /** Run level numbers: took, steps, calls, blocked, flagged, cost. */
        summary(detail, steps) {
            const d = detail || {};
            steps = steps || this.build(d.spans, { egressBlocks: d.egress_blocks });
            let blocked = 0;
            let flagged = 0;
            let calls = 0;
            steps.forEach(s => s.tools.forEach(t => {
                calls++;
                const st = this.chipState(t);
                if (st === 'blocked') blocked++;
                else if (st === 'flagged') flagged++;
            }));
            // d.blocked counts tool_call_audit blocks; egress denies live in
            // egress_audit, so the ones matched to a call are added on.
            // Every egress deny in the run's window when the server says how
            // many (the same number the traces list folds in), else the ones
            // matched to a call here.
            const egress = Number.isFinite(Number(d.egress_blocked)) && d.egress_blocked != null
                ? Number(d.egress_blocked)
                : steps.reduce((n, s) => n + s.tools.filter(t => t.egress).length, 0);
            if (Number.isFinite(Number(d.blocked)) && d.blocked != null) blocked = Number(d.blocked) + egress;
            const a = this.time(d.started_at);
            const b = this.time(d.ended_at);
            return {
                took_ms: a != null && b != null && b > a ? b - a : null,
                steps: steps.length,
                calls,
                blocked,
                flagged,
                cost: Number(d.generation_total_cost) || 0,
            };
        },

        /** The step view as plain records, for exports. Carries no text
         *  beyond tool names, rule ids and the recorded reason (never args). */
        records(detail) {
            const d = detail || {};
            const steps = this.build(d.spans, { egressBlocks: d.egress_blocks });
            return {
                summary: (({ took_ms, steps: n, blocked, flagged, cost }) => ({ took_ms, steps: n, blocked, flagged, cost }))(this.summary(d, steps)),
                steps: steps.map((st, i) => ({
                    index: i + 1,
                    model_ms: st.model,
                    tool_ms: st.tool,
                    step_ms: st.step,
                    model_estimated: !!(st.gen && st.gen.duration_estimated && st.model != null),
                    tool_capped: !!st.capped,
                    unchecked: (st.unchecked || []).map(u => ({ name: u.name, count: u.count })),
                    tools: this.groups(st).map(g => {
                        const rules = [];
                        g.calls.forEach(c => (Array.isArray(c.detection_rules) ? c.detection_rules : [])
                            .filter(Boolean).map(String).forEach(r => { if (!rules.includes(r)) rules.push(r); }));
                        const withReason = g.calls.find(c => c.reason);
                        return {
                            name: g.name, count: g.count, state: g.state, rule_ids: rules,
                            reason: withReason ? String(withReason.reason) : null,
                        };
                    }),
                })),
            };
        },

        /** "bash ×118, WebFetch (blocked)" for one exported step. */
        toolsText(tools, unchecked) {
            return (tools || []).map(t => `${t.name}${t.count > 1 ? ` ×${t.count}` : ''}${t.state === 'allowed' ? '' : ` (${t.state})`}`)
                .concat((unchecked || []).map(u => `${u.name}${u.count > 1 ? ` ×${u.count}` : ''} (not recorded)`))
                .join(', ');
        },

        // --- run health (GET /api/traces/{id}/health) -------------------------
        // Findings are neutral chips with a small icon: colour means security
        // state only. A failing finding may use amber; nothing else is coloured.
        HEALTH_ICON: { loop: '⟳', failing: '!', wasteful: '$', blocked: '✕' },
        HEALTH_LABEL: { loop: 'Loop', failing: 'Failing', wasteful: 'Wasteful', blocked: 'Blocked' },
        // Inline SVG glyphs (the app's icon pattern): the text glyphs above
        // render as a dot in the UI font. Stroke is currentColor, so the
        // colour comes from the neutral (or failing amber) class around it.
        HEALTH_SVG: {
            loop: '<path d="M20 11a8 8 0 0 0-14.9-3"/><path d="M4 13a8 8 0 0 0 14.9 3"/><path d="M4 4v4h4"/><path d="M20 20v-4h-4"/>',
            failing: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><path d="M12 16.5v.5"/>',
            wasteful: '<circle cx="12" cy="12" r="9"/><path d="M14.5 9.5c-.5-1-1.5-1.5-2.5-1.5-1.4 0-2.5.8-2.5 2s1.1 1.6 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1 0-2-.5-2.5-1.5"/><path d="M12 6.5V8"/><path d="M12 16v1.5"/>',
            blocked: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
        },

        /** A health category's icon as inline SVG ('' for an unknown one). */
        healthIcon(cat, size = 12) {
            const body = this.HEALTH_SVG[cat];
            if (!body) return '';
            return `<svg class="sv-health-icon sv-health-icon-${cat}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
        },
        FINDINGS_OPEN_MAX: 2,     // more findings than this collapse to one summary line

        /** The findings the strip shows. Blocked calls already show as red
         *  chips in the steps, so the strip leaves them out. */
        stripFindings(health) {
            const list = health && Array.isArray(health.findings) ? health.findings : [];
            return list.filter(f => f && typeof f === 'object' && f.category !== 'blocked');
        },

        /** Index of the step a finding ref points at, or -1. A string ref is
         *  a span_id (a tool call or a model turn); a number is a span's
         *  turn_index in the trace detail. */
        refStep(steps, spans, ref) {
            if (ref == null || ref === '') return -1;
            let target = null;
            if (typeof ref === 'number') {
                target = (Array.isArray(spans) ? spans : []).find(s => s && s.turn_index === ref) || null;
                if (!target) return -1;
            }
            for (let i = 0; i < steps.length; i++) {
                const st = steps[i];
                if (target) {
                    if (st.gen === target || st.tools.includes(target)) return i;
                } else {
                    const id = String(ref);
                    if (st.gen && st.gen.span_id != null && String(st.gen.span_id) === id) return i;
                    if (st.tools.some(t => t && t.span_id != null && String(t.span_id) === id)) return i;
                }
            }
            return -1;
        },

        /** Sorted 0-based step indexes a finding refers to. */
        findingSteps(steps, spans, finding) {
            const out = new Set();
            ((finding && finding.step_refs) || []).forEach(r => {
                const i = this.refStep(steps, spans, r);
                if (i >= 0) out.add(i);
            });
            return Array.from(out).sort((a, b) => a - b);
        },

        /** step index -> the category of the first finding that names it
         *  (findings arrive most severe first). */
        stepMarks(steps, spans, findings) {
            const marks = new Map();
            (findings || []).forEach(f => {
                if (!this.HEALTH_ICON[f.category] || f.category === 'blocked') return;
                this.findingSteps(steps, spans, f).forEach(i => { if (!marks.has(i)) marks.set(i, f.category); });
            });
            return marks;
        },

        /** "2 loop, 1 failing" for a counts object. */
        countsText(counts) {
            const c = counts || {};
            return ['loop', 'failing', 'wasteful'].filter(k => Number(c[k]) > 0)
                .map(k => `${Number(c[k])} ${k}`).join(', ');
        },

        /** Small neutral badges for a run's health counts ({loop, failing,
         *  wasteful}). Failing may be amber; the rest stay neutral. */
        badgesHtml(health, opts = {}) {
            const h = health || {};
            const cls = opts.className || 'sv-health-badge';
            const words = opts.words || { loop: 'Loop', failing: 'Failing', wasteful: 'Wasteful' };
            return ['loop', 'failing', 'wasteful'].filter(k => Number(h[k]) > 0).map(k =>
                `<span class="${cls} ${cls}-${k}" title="${this.esc(`${Number(h[k])} ${k} finding${Number(h[k]) === 1 ? '' : 's'}`)}" aria-label="${this.esc(words[k])}">${this.healthIcon(k)}<span class="sv-health-badge-text">${this.esc(words[k])}</span></span>`).join('');
        },

        /** The findings strip above the steps. opts.prefix, opts.findingsOpen
         *  (expanded when there are more than FINDINGS_OPEN_MAX). */
        findingsHtml(traceId, health, steps, spans, opts = {}) {
            const P = opts.prefix || 'terminals-steps';
            const list = this.stripFindings(health);
            if (!list.length) return '';
            const esc = (v) => this.esc(v);
            const tid = esc(traceId);
            const counts = { loop: 0, failing: 0, wasteful: 0 };
            list.forEach(f => { if (f.category in counts) counts[f.category]++; });
            const many = list.length > this.FINDINGS_OPEN_MAX;
            const open = !many || !!opts.findingsOpen;
            const sumText = `${list.length} health finding${list.length === 1 ? '' : 's'}: ${this.countsText(counts)}`;
            const sum = many ? `<div class="${P}-findings-sum"><span>${esc(sumText)}</span><button type="button" class="${P}-findings-toggle" data-trace-id="${tid}" data-fk="h:${tid}" aria-expanded="${open ? 'true' : 'false'}">${open ? 'Hide' : 'Show'}</button></div>` : '';
            const rows = open ? list.map(f => {
                const cat = this.HEALTH_ICON[f.category] ? f.category : 'loop';
                const at = this.findingSteps(steps, spans, f);
                const first = at.length ? at[0] + 1 : null;
                const why = [f.why, f.action].filter(Boolean).join(' · ');
                const jump = first ? `<button type="button" class="${P}-finding-jump" data-trace-id="${tid}" data-step="${first}" data-fk="j:${tid}:${esc(f.id)}">Jump to step ${first}</button>` : '';
                const copy = f.nudge ? `<button type="button" class="${P}-finding-copy" data-trace-id="${tid}" data-finding-id="${esc(f.id)}" data-fk="n:${tid}:${esc(f.id)}">Copy nudge</button>` : '';
                return `<li class="${P}-finding ${P}-finding-${cat}" data-finding-id="${esc(f.id)}">
                  <span class="${P}-finding-icon" aria-hidden="true">${this.healthIcon(cat)}</span>
                  <span class="${P}-finding-body"><span class="${P}-finding-title">${esc(f.title)}</span><span class="${P}-finding-why">${esc(why)}</span></span>
                  ${jump || copy ? `<span class="${P}-finding-actions">${jump}${copy}</span>` : ''}
                </li>`;
            }).join('') : '';
            return `<div class="${P}-findings" data-trace-id="${tid}">${sum}${rows ? `<ul class="${P}-findings-list">${rows}</ul>` : ''}</div>`;
        },

        /** The finding a strip button names, or null. */
        findingById(health, id) {
            const list = health && Array.isArray(health.findings) ? health.findings : [];
            return list.find(f => f && String(f.id) === String(id)) || null;
        },

        /** Findings as plain lines for exports: title, then why and action. */
        findingsRecords(health) {
            return (health && Array.isArray(health.findings) ? health.findings : []).map(f => ({
                category: f.category, severity: f.severity, title: f.title, why: f.why, action: f.action,
            }));
        },

        /** A run's step list as HTML.
         *  opts.prefix       class prefix ('terminals-steps' default, 'trace-steps')
         *  opts.stepsMax     rows before "+ N more steps" (STEPS_MAX)
         *  opts.chipsMax     chips per step (STEPS_CHIPS_MAX)
         *  opts.detailKey    open chip key, '' for none, undefined for the
         *                    first blocked call
         *  opts.approvals    pending approvals, for the Approve button
         *  opts.fullRunLabel foot button label ('See full run'); '' for none
         *  opts.moreLabel    aria text for "+N more" ('see full run')
         *  opts.modelLabel   legend label for model time ('Claude thinking')
         *  opts.jumpLabel    a button in the detail line that names the call
         *                    by its key (e.g. 'View in timeline'); none when unset
         *  opts.health       the run's /health payload: findings strip above
         *                    the steps and a marker on each step a finding names
         *  opts.findingsOpen show every finding when the strip is collapsed
         *  opts.focusStep    1-based step to show and mark (Jump to step N) */
        html(traceId, detail, opts = {}) {
            const P = opts.prefix || 'terminals-steps';
            const stepsMax = opts.stepsMax > 0 ? opts.stepsMax : this.STEPS_MAX;
            const chipsMax = opts.chipsMax > 0 ? opts.chipsMax : this.STEPS_CHIPS_MAX;
            const fullRunLabel = opts.fullRunLabel === undefined ? 'See full run' : opts.fullRunLabel;
            const moreLabel = opts.moreLabel || 'see full run';
            const modelLabel = opts.modelLabel || 'Claude thinking';
            const esc = (v) => this.esc(v);
            const tid = esc(traceId);
            const d = detail || {};
            const steps = this.build(d.spans, { egressBlocks: d.egress_blocks });
            const sum = this.summary(d, steps);
            const calls = sum.calls;
            const blockedCount = sum.blocked;
            const took = sum.took_ms != null ? this.fmtDur(sum.took_ms) : '';
            const cost = sum.cost;
            const flat = steps.length > 0 && steps.every(st => st.flat);
            const summary = [
                took ? `Took ${took}` : null,
                flat ? `${calls} tool call${calls === 1 ? '' : 's'}` : null,
                flat && steps.length === 1 ? null : `${steps.length} step${steps.length === 1 ? '' : 's'}`,
                blockedCount > 0 ? `${blockedCount} blocked` : null,
                cost > 0 ? `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}` : null,
            ].filter(Boolean).join(' · ');
            const fullBtn = fullRunLabel ? `<button type="button" class="${P}-full" data-trace-id="${tid}">${esc(fullRunLabel)}</button>` : '';
            if (!steps.length) {
                return `<div class="${P}-summary">${esc(summary)}</div><span class="${P === 'terminals-steps' ? 'terminals-empty' : `${P}-empty`}">No steps recorded.</span>
              <div class="${P}-foot">${fullBtn}</div>`;
            }
            const focusStep = Number(opts.focusStep) > 0 ? Number(opts.focusStep) : null;
            const shown = steps.slice(0, Math.max(stepsMax, focusStep && focusStep <= steps.length ? focusStep : 0));
            const maxTotal = this.maxTotal(steps);
            const marks = opts.health ? this.stepMarks(steps, d.spans, this.stripFindings(opts.health)) : new Map();
            const strip = opts.health ? this.findingsHtml(traceId, opts.health, steps, d.spans, { prefix: P, findingsOpen: opts.findingsOpen }) : '';
            const anyBar = maxTotal > 0;
            const keys = this.chipKeys(steps);
            let key = opts.detailKey;
            if (key === undefined) {
                key = '';
                shown.some((s, si) => s.tools.some((t, ti) => {
                    if (this.chipState(t) === 'blocked') { key = keys[si][ti]; return true; }
                    return false;
                }));
            }
            const used = { model: false, tool: false, step: false };
            steps.forEach(st => { const w = this.barWidths(st, maxTotal); for (const k of Object.keys(used)) if (w[k]) used[k] = true; });
            const icon = { blocked: '✕', flagged: '!', failed: '✗', allowed: '✓' };
            const rows = shown.map((step, si) => {
                const bw = this.barWidths(step, maxTotal);
                const bar = `<span class="${P}-bar" aria-hidden="true">${bw.model ? `<span class="${P}-seg ${P}-seg-model" style="width:${bw.model}px"></span>` : ''}${bw.tool ? `<span class="${P}-seg ${P}-seg-tool" style="width:${bw.tool}px"></span>` : ''}${bw.step ? `<span class="${P}-seg ${P}-seg-step" style="width:${bw.step}px"></span>` : ''}</span>`;
                const dur = this.durText(step);
                let openDetail = '';
                // Consecutive calls with the same name and state share one chip
                // ("bash ×12"); a different state never merges. At most
                // chipsMax chips show: blocked and flagged ones always, and
                // first, then allowed ones in order; the rest are "+N more".
                const groups = this.groups(step);
                // Calls the plugin never saw: after blocked and flagged, before
                // allowed, and never merged with a governed chip.
                const unchecked = (step.unchecked || []).map(u => ({ name: u.name, count: u.count }));
                let room = chipsMax - groups.filter(g => g.state !== 'allowed').length;
                let hiddenCalls = 0;
                unchecked.forEach(u => {
                    if (room > 0) { u.show = true; room--; } else { u.show = false; hiddenCalls += u.count; }
                });
                groups.forEach(g => {
                    if (g.state !== 'allowed') g.show = true;
                    else if (room > 0) { g.show = true; room--; }
                    else { g.show = false; hiddenCalls += g.count; }
                });
                const genKey = step.gen ? (step.gen.span_id != null && step.gen.span_id !== '' ? step.gen.span_id : `${step.gen.called_at == null ? '' : step.gen.called_at}`) : `${si}`;
                const uncheckedChips = unchecked.filter(u => u.show).map(u => {
                    const k = `u:${genKey}|${u.name}`;
                    const on = key === k;
                    if (on) {
                        openDetail = `<div class="${P}-detail ${P}-detail-unrecorded">
                      <span class="${P}-detail-text">SecureVector has no record of this call. It may have run before the plugin was active, failed, or been cancelled.</span>
                    </div>`;
                    }
                    return `<button type="button" class="${P}-chip ${P}-chip-unrecorded" data-trace-id="${tid}" data-step-key="${esc(k)}" data-fk="c:${tid}:${esc(k)}" aria-pressed="${on ? 'true' : 'false'}" aria-label="${esc(`${u.name}, not recorded${u.count > 1 ? `, ${u.count} calls` : ''}`)}">${esc(u.name)}${u.count > 1 ? ` ×${u.count}` : ''} · not recorded</button>`;
                }).join('');
                const chips = groups.filter(g => g.show).map(({ t, ti, name, state, count }) => {
                    const k = keys[si][ti];
                    const on = key === k;
                    if (on) {
                        const label = state === 'blocked' ? 'Blocked' : (state === 'flagged' ? 'Flagged' : (state === 'failed' ? 'Failed' : 'Allowed'));
                        const rules = (Array.isArray(t.detection_rules) ? t.detection_rules : []).filter(Boolean).map(String);
                        // Failed: the error's first line when text is stored, else just "Failed".
                        const why = state === 'allowed' ? ''
                            : state === 'failed' ? (this.failedText(t) ? `: ${this.failedText(t)}` : '')
                                : (t.reason ? `: ${t.reason}` : ': no reason recorded');
                        const args = t.args_preview == null ? '' : String(t.args_preview);
                        const shortArgs = args.length > 80 ? `${args.slice(0, 80)}…` : args;
                        const approval = state === 'blocked' ? this.approvalFor(t, opts.approvals, traceId) : null;
                        const jump = opts.jumpLabel ? `<button type="button" class="${P}-jump" data-trace-id="${tid}" data-step-key="${esc(k)}">${esc(opts.jumpLabel)}</button>` : '';
                        openDetail = `<div class="${P}-detail ${P}-detail-${state}">
                      <span class="${P}-detail-text">${esc(label + why)}${rules.length ? ` <span class="${P}-rules">(${esc(rules.join(', '))})</span>` : ''}</span>${approval ? `<button type="button" class="btn btn-sm ${P}-approve">Approve</button>` : ''}${jump}
                      ${shortArgs ? `<code class="${P}-args">${esc(shortArgs)}</code>` : ''}
                    </div>`;
                    }
                    return `<button type="button" class="${P}-chip ${P}-chip-${state}" data-trace-id="${tid}" data-step-key="${esc(k)}" data-fk="c:${tid}:${esc(k)}" aria-pressed="${on ? 'true' : 'false'}" aria-label="${esc(`${name}, ${state}${count > 1 ? `, ${count} calls` : ''}`)}">${icon[state]} ${esc(name)}${count > 1 ? ` ×${count}` : ''}${state === 'failed' ? ' · failed' : ''}</button>`;
                }).join('') + uncheckedChips + (hiddenCalls ? `<button type="button" class="${P}-chip ${P}-more" data-trace-id="${tid}" aria-label="${esc(`${hiddenCalls} more calls, ${moreLabel}`)}">+${hiddenCalls} more</button>` : '');
                const mark = marks.get(si);
                const markHtml = mark ? `<span class="${P}-mark ${P}-mark-${mark}" title="${esc(`${this.HEALTH_LABEL[mark]} finding`)}" aria-label="${esc(`${this.HEALTH_LABEL[mark]} finding`)}">${this.healthIcon(mark, 11)}</span>` : '';
                return `<li class="${P}-row${focusStep === si + 1 ? ` ${P}-row-focus` : ''}" data-step="${si + 1}">
                <div class="${P}-line">
                  <span class="${P}-num">${si + 1}</span>${markHtml}
                  ${bar}
                  <span class="${P}-dur">${esc(dur)}</span>
                  <span class="${P}-chips">${chips || `<span class="${P}-none">no tool calls</span>`}</span>
                </div>${openDetail}
              </li>`;
            }).join('');
            const more = steps.length - shown.length;
            const foot = `${more > 0 ? `<span>+ ${more} more step${more === 1 ? '' : 's'}${fullBtn ? ' · ' : ''}</span>` : ''}${fullBtn}`;
            return `<div class="${P}-summary">${esc(summary)}</div>${strip}
              ${anyBar ? `<div class="${P}-legend">${[
                  used.model ? `<span class="${P}-key ${P}-key-model" aria-hidden="true">■</span> ${esc(modelLabel)}` : '',
                  used.tool ? `<span class="${P}-key ${P}-key-tool" aria-hidden="true">■</span> Tools` : '',
                  used.step ? `<span class="${P}-key ${P}-key-step" aria-hidden="true">■</span> Step time` : '',
              ].filter(Boolean).join(' ')}</div>` : ''}
              <ol class="${P}-list">${rows}</ol>
              ${foot ? `<div class="${P}-foot">${foot}</div>` : ''}`;
        },
    };
    root.TraceSteps = TraceSteps;
})(typeof window !== 'undefined' ? window : this);
