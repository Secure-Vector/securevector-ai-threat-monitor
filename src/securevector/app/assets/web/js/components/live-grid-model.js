/**
 * LiveGridModel: the rules behind Observability > Live grid, kept free of the
 * DOM so they can be tested on their own.
 *
 * A Session is one running agent session (GET /api/terminals/observability/
 * live). Large tiles show the pinned sessions with their full governance;
 * compact tiles scale to hundreds of running sessions.
 *
 * Tiles and lists never approve or deny. A decision is made only in the
 * span panel (the same one the Runs details and the trace show), with the
 * full context of the one call it applies to. Review opens that panel in
 * place, inside the tile's own panel, so many sessions can be watched and
 * acted on without leaving the grid (owner, 6.1).
 *
 * Every server string is escaped before it reaches markup.
 */
(function (root) {
    const LiveGridModel = {
        PIN_KEY: 'sv-live-grid-pins',
        VIEWS_KEY: 'sv-live-grid-views',
        MAX_LARGE: 6,
        GROUP_PREVIEW: 12,
        QUIET_S: 300,

        TOGGLES: [
            ['waiting', 'Waiting for approval'],
            ['blocked', 'With blocked calls'],
            ['score70', 'Score 70+'],
            ['quiet', 'Quiet over 5m'],
            ['cost', 'Cost, running'],
        ],

        esc(s) {
            return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        },

        ms(ts) {
            if (ts == null || ts === '') return null;
            const s = String(ts);
            const t = Date.parse(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
            return Number.isFinite(t) ? t : null;
        },

        clock(ts) {
            const t = this.ms(ts);
            if (t == null) return '';
            const d = new Date(t);
            const p = (n) => String(n).padStart(2, '0');
            return `${p(d.getHours())}:${p(d.getMinutes())}`;
        },

        dur(seconds) {
            const s = Math.max(0, Math.floor(Number(seconds) || 0));
            if (s < 60) return `${s}s`;
            if (s < 3600) return `${Math.floor(s / 60)}m`;
            return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
        },

        short(id, n = 8) { return String(id || '').slice(0, n); },

        HARNESS_WORDS: {
            'claude-code': 'Claude Code', codex: 'Codex', 'copilot-cli': 'Copilot CLI', opencode: 'OpenCode',
            cursor: 'Cursor', antigravity: 'Antigravity', openclaw: 'OpenClaw', govrun: 'GovRun', hermes: 'Hermes',
        },

        harnessLabel(kind) {
            if (!kind) return 'unknown';
            if (this.HARNESS_WORDS[kind]) return this.HARNESS_WORDS[kind];
            const DU = root.DelegationUI;
            return (DU && DU.harnessLabel) ? DU.harnessLabel(kind) : String(kind);
        },

        /** Plain words for a score band. */
        scoreBand(score) {
            if (typeof score !== 'number') return '';
            return score >= 70 ? 'high' : score >= 40 ? 'worth a look' : 'calm';
        },

        // ------------------------------------------------------------ pins

        _store(storage) {
            if (storage !== undefined) return storage;
            try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (_) { return null; }
        },

        /** Pinned session ids, per viewer, in this browser only. Storage can
         *  be absent or throw; that reads as no pins. */
        loadPins(storage) {
            try {
                const st = this._store(storage);
                if (!st) return [];
                const v = JSON.parse(st.getItem(this.PIN_KEY) || '[]');
                return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x).slice(0, this.MAX_LARGE) : [];
            } catch (_) { return []; }
        },

        savePins(pins, storage) {
            try {
                const st = this._store(storage);
                if (!st) return false;
                st.setItem(this.PIN_KEY, JSON.stringify((pins || []).slice(0, this.MAX_LARGE)));
                return true;
            } catch (_) { return false; }
        },

        /** Add or remove one pin; returns the new list (kept in memory even
         *  when storage fails). At most MAX_LARGE, oldest pin drops first. */
        togglePin(pins, id, storage) {
            const cur = (pins || []).filter(x => x !== id);
            const next = cur.length === (pins || []).length ? cur.concat([id]).slice(-this.MAX_LARGE) : cur;
            this.savePins(next, storage);
            return next;
        },

        /** Default: Pinned in Large when any session is pinned, else All
         *  running in Compact. */
        defaults(pins) {
            const any = (pins || []).length > 0;
            return { scope: any ? 'pinned' : 'all', mode: any ? 'large' : 'compact',
                harness: '', project: '', status: '', group: 'none', toggles: {}, chip: '' };
        },

        /** A saved view from before the chips carries `toggles`: the first
         *  waiting, blocked or quiet toggle becomes the chip and the rest go,
         *  so the grid never narrows without a visible control. */
        viewFilters(f) {
            const v = Object.assign({}, f || {});
            const t = v.toggles || {};
            if (!v.chip) v.chip = (this.CHIPS.map(c => c[0]).find(k => t[k])) || '';
            v.toggles = {};
            return v;
        },

        /** Pinned focus shows only while something is pinned: with no pins
         *  the view falls back to the grid of all running sessions. */
        viewFor(st, pins) {
            const out = Object.assign({}, st || {});
            const any = (pins || []).length > 0;
            if (!any && out.mode === 'large') out.mode = 'compact';
            if (!any && out.scope === 'pinned') out.scope = 'all';
            return { st: out, showFocus: any };
        },

        // ----------------------------------------------------------- state

        /** ended | waiting | blocked | quiet | running. An ended session
         *  (not running, last activity within 30 minutes) keeps its tile,
         *  dimmed, until the server drops it. */
        state(s) {
            if (!s) return 'running';
            // A call waiting for approval outranks ended: it still needs you.
            if ((s.waiting || 0) > 0) return 'waiting';
            if (s.ended) return 'ended';
            if ((s.blocked || 0) > 0) return 'blocked';
            if ((Number(s.quiet_seconds) || 0) > this.QUIET_S) return 'quiet';
            return 'running';
        },

        coverageWord(level) {
            return level === 'full' ? 'full' : level === 'partial' ? 'partial' : 'not enforced';
        },

        /** The compact state line: expiry when waiting, blocked count (and a
         *  repeat attempt), quiet time, else running. */
        stateLine(s) {
            const st = this.state(s);
            if (st === 'waiting') {
                const exp = this.clock(s.oldest_waiting_expires_at);
                return 'waiting for approval' + (exp ? ` · expires ${exp}` : '');
            }
            if (st === 'blocked') return `${s.blocked} blocked` + (s.repeat_attempt ? ' · repeat attempt' : '');
            if (st === 'quiet') return `quiet ${this.dur(s.quiet_seconds)}`;
            if (st === 'ended') return `ended ${this.dur(s.quiet_seconds)} ago`;
            return 'running';
        },

        scoreText(s) { return typeof s.score === 'number' ? String(s.score) : 'no score'; },

        fmtUsd(v) {
            if (v == null) return '—';
            const n = Number(v);
            if (!Number.isFinite(n)) return '—';
            return n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
        },

        fmtTok(n) {
            if (n == null) return '';
            const v = Number(n) || 0;
            if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
            if (v >= 1e3) return `${Math.round(v / 1e3)}k`;
            return String(v);
        },

        /** Cost and tokens. Tokens still being read show "…", never 0; a
         *  missing cost shows "not recorded", never $0. */
        costText(s) {
            const tok = s.tokens_pending ? '…' : (s.tokens != null && s.tokens > 0 ? `${this.fmtTok(s.tokens)} tokens` : '');
            const usd = s.cost_usd != null ? this.fmtUsd(s.cost_usd) : 'cost not recorded';
            return [usd, tok].filter(Boolean).join(' · ');
        },

        // ------------------------------------------------------ sort/filter

        /** Triage order: waiting (oldest expiry first), blocked, score, then
         *  the most recent activity. */
        compare(a, b) {
            const ea0 = a.ended ? 1 : 0, eb0 = b.ended ? 1 : 0;
            if (ea0 !== eb0) return ea0 - eb0;
            const wa = (a.waiting || 0) > 0 ? 0 : 1, wb = (b.waiting || 0) > 0 ? 0 : 1;
            if (wa !== wb) return wa - wb;
            if (!wa) {
                const ea = this.ms(a.oldest_waiting_expires_at) || 0, eb = this.ms(b.oldest_waiting_expires_at) || 0;
                if (ea !== eb) return ea - eb;
            }
            const ba = (a.blocked || 0) > 0 ? 0 : 1, bb = (b.blocked || 0) > 0 ? 0 : 1;
            if (ba !== bb) return ba - bb;
            const sa = typeof a.score === 'number' ? a.score : -1, sb = typeof b.score === 'number' ? b.score : -1;
            if (sa !== sb) return sb - sa;
            const qa = a.quiet_seconds == null ? Infinity : Number(a.quiet_seconds);
            const qb = b.quiet_seconds == null ? Infinity : Number(b.quiet_seconds);
            if (qa !== qb) return qa - qb;
            return String(a.session_id).localeCompare(String(b.session_id));
        },

        sort(list) { return (list || []).slice().sort((a, b) => this.compare(a, b)); },

        /** Hold the order while watching: known sessions keep their place,
         *  gone ones drop, new ones join at the end in triage order. A kept
         *  session that starts waiting (not in `prevWaiting`) moves into the
         *  waiting block at its sorted place, so a new approval never hides
         *  at the bottom. `resort` re-applies the full sort. Returns the new
         *  id order. */
        order(prev, sessions, resort, prevWaiting) {
            if (resort || !prev || !prev.length) return this.sort(sessions).map(s => s.session_id);
            const list = sessions || [];
            const byId = new Map(list.map(s => [s.session_id, s]));
            const was = new Set(prevWaiting || []);
            const isW = (id) => (byId.get(id).waiting || 0) > 0;
            const kept = prev.filter(id => byId.has(id));
            const moved = prevWaiting ? kept.filter(id => isW(id) && !was.has(id)) : [];
            const movedSet = new Set(moved);
            const rest = kept.filter(id => !movedSet.has(id));
            moved.forEach(id => {
                const s = byId.get(id);
                // Inside the leading waiting block, before the first waiting
                // session that sorts after it.
                let i = 0;
                while (i < rest.length && isW(rest[i]) && this.compare(byId.get(rest[i]), s) <= 0) i++;
                rest.splice(i, 0, id);
            });
            const known = new Set(kept);
            const fresh = this.sort(list.filter(s => !known.has(s.session_id))).map(s => s.session_id);
            return rest.concat(fresh);
        },

        waitingIds(sessions) {
            return (sessions || []).filter(s => (s.waiting || 0) > 0).map(s => s.session_id);
        },

        /** Drop pins whose session has been missing from Live for a full
         *  poll: missing now and already missing at the previous poll. Only
         *  when the list is complete (not cut at the limit). Returns
         *  { pins, missed } and saves a changed list. */
        prunePins(pins, sessions, missedBefore, complete, storage) {
            const ids = new Set((sessions || []).map(s => s.session_id));
            const before = new Set(missedBefore || []);
            const missing = (pins || []).filter(id => !ids.has(id));
            if (complete === false) return { pins: (pins || []).slice(), missed: [] };
            const drop = new Set(missing.filter(id => before.has(id)));
            const next = (pins || []).filter(id => !drop.has(id));
            if (drop.size) this.savePins(next, storage);
            return { pins: next, missed: missing.filter(id => !drop.has(id)) };
        },

        /** A cheap signature of what a refresh would draw, so an unchanged
         *  poll does not rebuild the grid (and keeps focus). */
        signature(data, details, now) {
            // 10 s buckets, so ages under a minute tick too.
            const bucket = Math.floor((now || 0) / 10000);
            const ses = ((data && data.sessions) || []).map(s => [s.session_id, s.waiting, s.blocked, s.score, s.cost_usd,
                s.tokens, s.tokens_pending, s.tool_calls, s.oldest_waiting_expires_at, s.project, s.harness,
                s.coverage_level, s.repeat_attempt, s.started_at, Math.floor((Number(s.quiet_seconds) || 0) / 10),
                s.last_call && [s.last_call.at, s.last_call.action, s.last_call.tool_id, s.last_call.reason],
                s.last_egress && [s.last_egress.host, s.last_egress.action], s.egress_visible,
                s.waiting_call && [s.waiting_call.tool_id, s.waiting_call.function_name], !!s.ended,
                s.alert && [s.alert.id, s.alert.label]]);
            const det = Object.keys(details || {}).sort().map(k => {
                const d = details[k] || {}, g = d.gov || {};
                return [k, d.traceId, (d.spans || []).map(x => [x.span_id || x.row_hash, x.action, x.called_at]),
                    g.tool_calls, g.findings, g.score, g.cost, g.coverage && g.coverage.level,
                    ((g.approvals && g.approvals.pending) || []).map(p => [p.id, p.expires_at]),
                    g.egress && [g.egress.visible, (g.egress.hosts || []).map(h => [h.host, h.status, h.calls])],
                    ((g.blocked_calls) || []).map(b => [b.span_id, b.kind])];
            });
            return JSON.stringify([bucket, ses, data && data.counters, data && data.groups, data && data.limit, det]);
        },

        arrange(sessions, orderIds) {
            const pos = new Map((orderIds || []).map((id, i) => [id, i]));
            return (sessions || []).slice().sort((a, b) => {
                const pa = pos.has(a.session_id) ? pos.get(a.session_id) : 1e9;
                const pb = pos.has(b.session_id) ? pos.get(b.session_id) : 1e9;
                return pa - pb || this.compare(a, b);
            });
        },

        matchToggle(s, key) {
            // Attention chips count running sessions only; ended tiles show
            // under no chip but stay in the full grid.
            if (key === 'running') return !s.ended;
            if (key === 'waiting') return !s.ended && (s.waiting || 0) > 0;
            if (key === 'blocked') return !s.ended && (s.blocked || 0) > 0;
            if (key === 'score70') return typeof s.score === 'number' && s.score >= 70;
            if (key === 'quiet') return !s.ended && (Number(s.quiet_seconds) || 0) > this.QUIET_S;
            if (key === 'cost') return s.cost_usd != null;
            return true;
        },

        /** Dropdown filters plus counter toggles (all active toggles must
         *  hold). */
        filter(sessions, f) {
            const o = f || {};
            const on = Object.keys(o.toggles || {}).filter(k => o.toggles[k]);
            return (sessions || []).filter(s => {
                if (o.harness && (s.harness || 'unknown') !== o.harness) return false;
                if (o.project && (s.project || 'unknown') !== o.project) return false;
                if (o.status && this.state(s) !== o.status) return false;
                if (o.chip && !this.matchToggle(s, o.chip)) return false;
                return on.every(k => this.matchToggle(s, k));
            });
        },

        /** Counters over every running session (the server sends these; this
         *  rebuilds them from a list when it does not). */
        counters(sessions) {
            const every = sessions || [];
            const all = every.filter(s => !s.ended);
            const known = all.filter(s => s.cost_usd != null);
            return {
                running: all.length,
                waiting: all.reduce((a, s) => a + (s.waiting || 0), 0),
                blocked_sessions: all.filter(s => (s.blocked || 0) > 0).length,
                score_70_plus: all.filter(s => typeof s.score === 'number' && s.score >= 70).length,
                quiet_over_5m: all.filter(s => (Number(s.quiet_seconds) || 0) > this.QUIET_S).length,
                cost_usd: known.length ? Math.round(known.reduce((a, s) => a + Number(s.cost_usd || 0), 0) * 1e6) / 1e6 : null,
                cost_known_sessions: known.length,
                tokens: all.reduce((a, s) => a + (Number(s.tokens) || 0), 0),
                coverage_partial: all.filter(s => s.coverage_level === 'partial').length,
                coverage_not_enforced: all.filter(s => s.coverage_level === 'not_enforced').length,
                ended: every.length - all.length,
            };
        },

        // ------------------------------------------------- attention chips

        CHIPS: [['waiting', 'Waiting'], ['blocked', 'Blocked'], ['quiet', 'Quiet'], ['running', 'Running only']],

        /** Sessions per chip (not requests): how many tiles each would show.
         *  "Running only" hides the dimmed tiles of sessions that ended. */
        chipCounts(sessions) {
            const out = { waiting: 0, blocked: 0, quiet: 0, running: 0 };
            (sessions || []).forEach(s => this.CHIPS.forEach(([k]) => { if (this.matchToggle(s, k)) out[k]++; }));
            return out;
        },

        /** One chip at a time: a chip narrows the grid, clicking it again
         *  clears it. All sessions show by default. */
        chipToggle(cur, key) { return cur === key ? '' : key; },

        chipsHtml(sessions, cur) {
            const n = this.chipCounts(sessions);
            return `<div class="lg-chips" role="group" aria-label="Narrow by attention">` +
                this.CHIPS.map(([k, l]) => {
                    const on = cur === k;
                    return `<button type="button" class="lg-chip k-${k}${on ? ' on' : ''}" data-act="chip" data-key="${k}" aria-pressed="${on}"` +
                        ` aria-label="${l}, ${n[k]} session${n[k] === 1 ? '' : 's'}${on ? ', showing only these' : ''}">` +
                        `${l}<span class="lg-chip-n">${n[k]}</span></button>`;
                }).join('<span class="lg-chip-sep" aria-hidden="true">·</span>') + `</div>`;
        },

        // ------------------------------------------------ tile glance lines

        /** Egress for a tile, honest about what is known: a harness without
         *  an egress view is "not monitored", a monitored session with no
         *  destination is "no egress observed", and missing data is "not
         *  synced yet". Never a clear signal it has not earned. */
        egressState(s, gov) {
            const eg = gov && gov.egress;
            const visible = eg ? eg.visible !== false
                : (s && typeof s.egress_visible === 'boolean' ? s.egress_visible : null);
            if (visible === false) return { key: 'off', text: 'Egress not monitored' };
            if (visible === null) return { key: 'missing', text: 'Not synced yet' };
            const le = s && s.last_egress;
            if (le && le.host) return { key: le.action === 'block' ? 'blocked' : 'host', text: String(le.host), host: String(le.host) };
            const hosts = (eg && Array.isArray(eg.hosts)) ? eg.hosts.filter(h => h && h.host) : [];
            if (hosts.length) {
                const h = hosts.find(x => x.status === 'blocked' || x.status === 'waiting') || hosts[0];
                return { key: h.status === 'blocked' ? 'blocked' : 'host', text: String(h.host), host: String(h.host) };
            }
            if (!eg && s && s.last_egress === undefined) return { key: 'missing', text: 'Not synced yet' };
            return { key: 'none', text: 'No egress observed' };
        },

        /** The latest governance result in plain words. */
        govWord(action) {
            if (action === 'block') return { key: 'blocked', label: 'blocked' };
            if (action === 'hold' || action === 'waiting') return { key: 'waiting', label: 'held' };
            if (action === 'log_only') return { key: 'recorded', label: 'logged' };
            return { key: 'allowed', label: 'allowed' };
        },

        /** What a tile says: the current or last action (tool plus target,
         *  no values), the latest governance result with its rule, and the
         *  egress state. */
        glance(s) {
            const lc = (s && s.last_call) || null;
            const RT = root.RunTrace;
            let tool = lc ? (lc.function_name || lc.tool_id || 'tool') : '';
            let target = '';
            if (lc && lc.args_preview) {
                const names = RT && RT.dataNames ? (RT.dataNames(lc.args_preview) || []) : [];
                target = this.previewOf(lc.args_preview);
                // A preview that names secret-like data shows the names only.
                if (names.length) target = names.join(', ');
            }
            const wc = this.state(s) === 'waiting' ? (s.waiting_call || null) : null;
            if (wc) {
                // The held call leads: its data names and destination only,
                // never the raw preview (it may carry values).
                tool = wc.function_name || wc.tool_id || 'tool';
                const names = RT && RT.dataNames ? (RT.dataNames(wc.call_preview) || []) : [];
                const host = RT && RT.hostOf ? (RT.hostOf(wc.tool_id) || RT.hostOf(wc.call_preview)) : null;
                target = [names.join(', '), host ? 'to ' + host : ''].filter(Boolean).join(' ');
            }
            let gov;
            if (this.state(s) === 'waiting') {
                const exp = this.clock(s.oldest_waiting_expires_at);
                gov = { key: 'waiting', label: 'held', rule: 'waiting for approval' + (exp ? `, expires ${exp}` : '') };
            } else if (lc) {
                const w = this.govWord(lc.action);
                const rule = lc.reason ? String(lc.reason).replace(/\s+/g, ' ').slice(0, 60) : '';
                gov = { key: w.key, label: w.label, rule };
            } else gov = null;
            return { tool, target, gov, egress: this.egressState(s, null) };
        },

        /** "updated 12s ago" from a time in ms; "ended 4m ago" for a
         *  session that stopped running. */
        agoText(atMs, now, ended) {
            if (atMs == null || !Number.isFinite(atMs)) return ended ? 'ended' : 'no activity yet';
            const n = Math.max(0, Math.round(((now == null ? Date.now() : now) - atMs) / 1000));
            const w = ended ? 'ended' : 'updated';
            if (n < 60) return `${w} ${n}s ago`;
            if (n < 3600) return `${w} ${Math.floor(n / 60)}m ago`;
            return `${w} ${Math.floor(n / 3600)}h ago`;
        },

        /** Coverage as information, not an alert. */
        coverageLine(c) {
            return `Coverage: ${(c && c.coverage_partial) || 0} partial · ${(c && c.coverage_not_enforced) || 0} not enforced`;
        },

        oldestWaiting(sessions, now) {
            const w = (sessions || []).filter(s => (s.waiting || 0) > 0);
            if (!w.length) return null;
            // Expiry order stands in for request order; the oldest waits longest.
            return this.sort(w)[0];
        },

        // ---------------------------------------------------------- groups

        groupKey(s, by) {
            if (by === 'host') return s.host || 'unknown';
            if (by === 'project') return s.project || 'unknown';
            if (by === 'harness') return s.harness || 'unknown';
            return 'all';
        },

        rollupText(key, r, label) {
            const parts = [`${label || key}`, `${(r && r.running) || 0} running`];
            if (r && r.ended) parts.push(`${r.ended} ended`);
            const flags = [];
            if (r && r.waiting) flags.push(`${r.waiting} waiting`);
            if (r && r.blocked_sessions) flags.push(`${r.blocked} blocked`);
            parts.push(flags.length ? flags.join(' · ') : 'nothing flagged');
            return parts.join(' · ');
        },

        /** Groups for the visible sessions. Rollups come from the server
         *  (they cover every running session) when it sent them; otherwise
         *  they are built from the list. Order: flagged groups first. */
        groups(sessions, by, serverGroups) {
            if (!by || by === 'none') return [{ key: 'all', sessions: sessions || [], rollup: null }];
            const roll = new Map(((serverGroups || [])).map(g => [g.key, g.rollup]));
            const m = new Map();
            (sessions || []).forEach(s => {
                const k = this.groupKey(s, by);
                if (!m.has(k)) m.set(k, []);
                m.get(k).push(s);
            });
            const out = [...m.entries()].map(([key, list]) => {
                const c = this.counters(list);
                const local = { running: c.running, ended: c.ended, waiting: c.waiting, blocked_sessions: c.blocked_sessions,
                    blocked: list.filter(s => !s.ended).reduce((a, s) => a + (s.blocked || 0), 0) };
                return { key, sessions: list, rollup: roll.get(key) || local };
            });
            return out.sort((a, b) => ((b.rollup.waiting || 0) - (a.rollup.waiting || 0))
                || ((b.rollup.blocked_sessions || 0) - (a.rollup.blocked_sessions || 0))
                || ((b.rollup.running || 0) - (a.rollup.running || 0)) || String(a.key).localeCompare(String(b.key)));
        },

        // -------------------------------------------------------- markup

        /** One tile: harness and session, the current or last action, the
         *  latest governance result, egress and how long ago it updated. No
         *  listeners: the page delegates clicks on [data-sid]. No approve or
         *  deny control on the tile itself. `s._gone` marks a pinned session
         *  that is not in the live list ('ended' or 'outside' a cut list). */
        compactTileHtml(s, pinned, open, opts = {}) {
            const e = (x) => this.esc(x);
            const st = s._gone ? 'quiet' : this.state(s);
            const harness = s._gone && !s.harness ? 'Session' : this.harnessLabel(s.harness);
            const cov = s._gone ? '' : this.coverageWord(s.coverage_level);
            const tc = s.tool_calls || {};
            const title = [
                `Session ${s.session_id}`,
                s._gone ? '' : `Calls ${tc.total || 0}: ${tc.allowed || 0} allowed, ${tc.waiting || 0} waiting, ${tc.blocked || 0} blocked`,
                s._gone ? '' : `Cost ${this.costText(s)}`,
                typeof s.score === 'number' ? `Score ${s.score}` : '',
                s.coverage ? `Coverage ${s.coverage}` : '',
            ].filter(Boolean).join('\n');
            const sid = e(s.session_id);
            const shortId = this.short(s.session_id);
            const name = s.project || shortId;
            const g = this.glance(s);
            const exp = `<button type="button" class="lg-exp" data-act="expand" data-sid="${sid}" aria-expanded="${open ? 'true' : 'false'}"` +
                ` aria-controls="lg-cx-${sid}" aria-label="${open ? 'Hide' : 'Show'} recent calls and egress for ${e(name)}" title="${open ? 'Hide' : 'Show'} recent calls and egress">` +
                `<span class="lg-exp-ico" aria-hidden="true"><svg viewBox="0 0 16 16" width="16" height="16" focusable="false"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span></button>`;
            // A waiting tile is the waiting badge: Review opens its panel with
            // the waiting call's details, in place. Any other tile opens or
            // closes its panel. Neither leaves the grid.
            const wait = st === 'waiting';
            const actLine = s._gone
                ? `<span class="lg-c-act none">${s._gone === 'outside' ? 'Not in the live list (cut at the limit)' : 'Not running now'}</span>`
                : g.tool ? `<span class="lg-c-act"><span class="lg-c-tool">${e(g.tool)}</span>${g.target ? ` <span class="lg-c-tgt">${e(g.target)}</span>` : ''}</span>`
                    : `<span class="lg-c-act none">No calls recorded yet</span>`;
            const govLine = g.gov && !s._gone
                ? `<span class="lg-c-gov"><span class="lg-dec ${g.gov.key}">${e(g.gov.label)}</span>${g.gov.rule ? ` <span class="lg-c-rule">${e(g.gov.rule)}</span>` : ''}</span>` : '';
            const egLine = s._gone ? '' : `<span class="lg-c-eg k-${g.egress.key}"><span class="lg-c-egl">Egress</span> ${e(g.egress.text)}</span>`;
            const atMs = this.ms(s.last_activity_at) != null ? this.ms(s.last_activity_at)
                : (s.quiet_seconds != null && opts.now ? opts.now - Number(s.quiet_seconds) * 1000 : null);
            const ended = !s._gone && !!s.ended;
            const ago = s._gone ? '' : `<span class="lg-c-ago" data-at="${atMs == null ? '' : e(atMs)}"${ended ? ' data-ended="1"' : ''}>${e(this.agoText(atMs, opts.now, ended))}</span>`;
            // Suspicious egress turns the tile red with the reason, in
            // plain words (services/egress_alerts.py).
            const al = !s._gone && s.alert && s.alert.host ? s.alert : null;
            const alertLine = al ? `<span class="lg-c-alert" title="${e(al.text || '')}"><span class="lg-c-alert-w">Check egress</span> ${e(al.host)}${al.label ? `: ${e(al.label)}` : ''}</span>` : '';
            const label = `${harness}, ${name}${s.project ? ' ' + shortId : ''}, ${s._gone ? 'not running now' : this.stateLine(s)}` +
                (al ? `, suspicious egress: ${al.text || al.host}` : '') +
                (wait ? ', review the waiting call' : `, ${open ? 'hide' : 'show'} recent calls`);
            return `<div class="lg-cw st-${st}${pinned ? ' pinned' : ''}${open ? ' open' : ''}${ended ? ' ended' : ''}${al ? ' alert' : ''}" data-tsid="${sid}">` +
                `<button type="button" class="lg-c st-${st}${al ? ' alert' : ''}" data-act="${wait ? 'review' : 'peek'}" data-sid="${sid}" title="${e(title)}"` +
                `${wait ? '' : ` aria-expanded="${open ? 'true' : 'false'}" aria-controls="lg-cx-${sid}"`} aria-label="${e(label)}">` +
                `<span class="lg-c-bar" aria-hidden="true"></span>` +
                `<span class="lg-c-main"><span class="lg-c-head"><span class="lg-c-h">${e(harness)}</span>` +
                `<span class="lg-c-name">${e(s.project || '')}${s.project ? ' ' : ''}<span class="lg-c-id">${e(shortId)}</span></span></span>` +
                alertLine + actLine + govLine + egLine + `</span></button>` +
                `<div class="lg-c-foot">${ago}${cov ? `<span class="lg-c-cov">${e(cov)}</span>` : ''}` +
                (wait ? `<button type="button" class="lg-rv" data-act="review" data-sid="${sid}" data-key="btn">Review</button>` : '') + `</div>` +
                `<button type="button" class="lg-pin" data-act="pin" data-sid="${sid}" aria-pressed="${pinned ? 'true' : 'false'}" aria-label="${pinned ? 'Unpin' : 'Pin'} session ${e(shortId)}" title="${pinned ? 'Unpin' : 'Pin for Pinned focus'}">◆</button>` + exp + `</div>`;
        },

        /** A tile and, when it is expanded, its full-row panel right after
         *  it. The grid packs densely, so the panel opens under the tile's
         *  row and the tiles after it keep their places in that row. */
        _tileWithPanel(s, pins, openSet, details, panels, now) {
            const open = openSet.has(s.session_id);
            const tile = this.compactTileHtml(s, pins.has(s.session_id), open, { now });
            if (!open) return tile;
            const sid = this.esc(s.session_id);
            const d = (details || {})[s.session_id] || null;
            return tile + `<div class="lg-cx" id="lg-cx-${sid}" role="region" aria-label="${this.esc((s.project || this.short(s.session_id)) + ': recent calls and egress')}">` +
                `<div class="lg-cx-head"><span class="lg-cx-name">${this.esc(s.project || this.harnessLabel(s.harness))}</span>` +
                `<span class="lg-th-id">${this.esc(this.short(s.session_id))}</span>` +
                `<button type="button" class="lg-link" data-act="open-panel" data-sid="${sid}">Open trace →</button>` +
                `<button type="button" class="lg-link lg-link-2" data-act="open-runs" data-sid="${sid}">Open in Runs</button></div>` +
                this.sectionsHtml(s.session_id, d, { panel: (panels || {})[s.session_id] || null }) + `</div>`;
        },

        /** The whole compact body as one string: groups with a caret,
         *  rollup line and "Show all N". */
        compactHtml(groups, opts = {}) {
            const e = (x) => this.esc(x);
            const collapsed = opts.collapsed || {};
            const expanded = opts.expanded || {};
            const pins = new Set(opts.pins || []);
            const openSet = new Set(opts.open || []);
            const tiles = (list) => list.map(s => this._tileWithPanel(s, pins, openSet, opts.details, opts.panels, opts.now)).join('');
            const by = opts.group || 'none';
            const label = (k) => (by === 'harness' ? this.harnessLabel(k) : k);
            if (!groups.length || !groups.some(g => g.sessions.length)) {
                return `<div class="lg-empty">${e(opts.emptyText || 'No running sessions match.')}</div>`;
            }
            return groups.map(g => {
                if (by === 'none') {
                    return `<div class="lg-cgrid${opts.focus ? ' lg-focus' : ''}">${tiles(g.sessions)}</div>`;
                }
                const open = !collapsed[g.key];
                const total = ((g.rollup && ((g.rollup.running || 0) + (g.rollup.ended || 0))) || g.sessions.length);
                const all = !!expanded[g.key];
                const shown = all ? g.sessions : g.sessions.slice(0, this.GROUP_PREVIEW);
                const more = Math.max(total, g.sessions.length) > shown.length;
                return `<section class="lg-group" data-gkey="${e(g.key)}">` +
                    `<div class="lg-ghead"><button type="button" class="lg-caret" data-act="caret" data-gkey="${e(g.key)}" aria-expanded="${open}">` +
                    `<span aria-hidden="true">${open ? '▾' : '▸'}</span> <span class="lg-gname">${e(this.rollupText(g.key, g.rollup, label(g.key)))}</span></button>` +
                    (more && open ? `<button type="button" class="lg-link" data-act="showall" data-gkey="${e(g.key)}">Show all ${e(total)}</button>` : '') +
                    (all && open ? `<button type="button" class="lg-link" data-act="showless" data-gkey="${e(g.key)}">Show fewer</button>` : '') +
                    `</div>` +
                    (open ? `<div class="lg-cgrid">${tiles(shown)}</div>` : '') +
                    `</section>`;
            }).join('');
        },

        decisionWord(action) {
            if (action === 'block') return { key: 'blocked', label: 'blocked' };
            if (action === 'hold' || action === 'waiting') return { key: 'waiting', label: 'waiting for approval' };
            if (action === 'log_only') return { key: 'recorded', label: 'recorded' };
            return { key: 'allowed', label: 'allowed' };
        },

        /** Latest calls of a trace (tool spans, newest first) plus the
         *  waiting requests, at most n. */
        recentCalls(spans, pending, n = 5) {
            const tools = (spans || []).filter(s => s && s.span_kind !== 'generation');
            const rows = tools.map(s => ({ at: s.called_at, name: s.function_name || s.tool_id || 'tool',
                preview: s.args_preview, action: s.action, span: s }));
            (pending || []).forEach(p => rows.push({ at: p.requested_at, name: p.function_name || p.tool_id || 'tool',
                preview: p.call_preview, action: 'hold', reqId: p.id || null }));
            rows.sort((a, b) => (this.ms(b.at) || 0) - (this.ms(a.at) || 0));
            return rows.slice(0, n);
        },

        previewOf(x) {
            // The trace tree's reading first (command, url, file path), so a
            // tile names a call the way its span does.
            // RunTrace.previewText picks the command, url or path and masks
            // secret values; a tile target always goes through it.
            const RT = root.RunTrace;
            if (RT && RT.previewText) {
                const raw = x && typeof x === 'object' ? JSON.stringify(x) : String(x == null ? '' : x);
                return String(RT.previewText(raw) || '').replace(/\s+/g, ' ').slice(0, 90);
            }
            let t = x;
            if (t && typeof t === 'object') t = t.command || t.url || t.file_path || t.path || JSON.stringify(t);
            t = String(t == null ? '' : t);
            try { const j = JSON.parse(t); if (j && typeof j === 'object') return this.previewOf(j); } catch (_) { /* plain text */ }
            return t.replace(/\s+/g, ' ').slice(0, 90);
        },

        // ------------------------------------------- tool calls and egress

        SECTION_CAP: 5,

        MAX_OPEN: 6,

        /** Expanded compact tiles: a new list with `sid` added or removed.
         *  At most MAX_OPEN, like pins: opening one more closes the oldest. */
        toggleOpen(open, sid) {
            const list = (open || []).filter(x => x !== sid);
            if (list.length === (open || []).length && sid) list.push(sid);
            return list.slice(-this.MAX_OPEN);
        },

        /** The expanded sessions still running: the only ones whose details
         *  a poll fetches. */
        openToLoad(open, sessions) {
            const live = new Set((sessions || []).map(s => s.session_id));
            return (open || []).filter(id => live.has(id));
        },

        /** Open `sid`'s panel without closing it when it is open (Review).
         *  Same cap as toggleOpen: the oldest closes. */
        ensureOpen(open, sid) {
            const list = (open || []).slice();
            if (sid && !list.includes(sid)) list.push(sid);
            return list.slice(-this.MAX_OPEN);
        },

        // --------------------------------------- call details in a panel

        /** The session's requests: the pending list's rows for `sid`, plus
         *  any the governance summary holds that the list does not. */
        sessionReqs(sid, reqs, gov) {
            const mine = (reqs || []).filter(r => r && r.session_id === sid);
            const ids = new Set(mine.map(r => r.id));
            ((gov && gov.approvals && gov.approvals.pending) || []).forEach(p => {
                if (p && p.id && !ids.has(p.id)) mine.push(Object.assign({ session_id: sid, status: 'pending' }, p));
            });
            return mine;
        },

        /** What Review on a tile targets: the session's waiting request that
         *  expires soonest (pending, not a delegate's), or null. */
        reviewTarget(reqs, sid) {
            const ms = (t) => { const v = this.ms(t); return v == null ? Infinity : v; };
            const w = (reqs || []).filter(x => x && x.session_id === sid && (!x.status || x.status === 'pending') && x.rule_source !== 'delegate')
                .sort((a, b) => ms(a.expires_at) - ms(b.expires_at));
            return w.length ? w[0].id : null;
        },

        /** Details open per tile: { sid: { key, req, wait } }, one per tile.
         *  A row click toggles that row; another row replaces it. */
        detToggle(det, sid, key) {
            const next = Object.assign({}, det || {});
            const cur = next[sid];
            if (cur && cur.key === key) delete next[sid];
            else next[sid] = { key, req: null, wait: false };
            return next;
        },

        /** Review: the waiting call's details, by request id when the tile
         *  names one, else the soonest-expiring one when it is drawn. */
        detReview(det, sid, reqId) {
            return Object.assign({}, det || {}, { [sid]: { key: null, req: reqId || null, wait: true } });
        },

        detClose(det, sid) {
            const next = Object.assign({}, det || {});
            delete next[sid];
            return next;
        },

        /** Only tiles whose panel shows keep their open details. */
        detPrune(det, sids) {
            const keep = new Set(sids || []);
            const next = {};
            Object.keys(det || {}).forEach(k => { if (keep.has(k)) next[k] = det[k]; });
            return next;
        },

        /** Review on a tile, in place: the panel opens (compact) and the
         *  waiting call's details open in it. Never a navigation. */
        reviewPlan(state, sid, reqId, reqs, gov) {
            const st = state || {};
            const target = reqId || this.reviewTarget(this.sessionReqs(sid, reqs, gov), sid);
            // Pinned focus and the grid both open the full-row panel.
            return {
                open: this.ensureOpen(st.open, sid),
                det: this.detReview(st.det, sid, target),
                focus: sid,
                navigate: false,
            };
        },

        /** Resolve a tile's open details against its run: the span node and
         *  the RunTrace context the span panel needs. A waiting request the
         *  run's spans do not hold yet shows as its own node. Null when
         *  nothing resolves. */
        detailFor(sid, d, reqs, entry, live) {
            const RT = root.RunTrace;
            if (!entry || !d || !RT || !RT.buildTree) return null;
            const gov = d.gov || null;
            const mine = this.sessionReqs(sid, reqs, gov);
            const trace = { trace_id: d.traceId || ('session:' + sid), session_id: sid, spans: d.spans || [],
                started_at: (d.spans && d.spans[0] && d.spans[0].called_at) || null };
            const tree = RT.buildTree(trace, { requests: mine, grants: [], newest: true });
            const reqId = entry.req || (entry.wait ? this.reviewTarget(mine, sid) : null);
            let found = null;
            if (reqId) RT.walk(tree, (n, p) => { if (!found && n.req && n.req.id === reqId) found = { node: n, parent: p }; });
            if (!found && reqId) {
                const r = mine.find(x => x.id === reqId && (!x.status || x.status === 'pending'));
                if (r) {
                    const s = { span_kind: 'tool_call', tool_id: r.tool_id, function_name: r.function_name,
                        args_preview: r.call_preview, called_at: r.requested_at, action: 'hold', _request: true };
                    found = { node: { key: 'req:' + r.id, kind: 'tool', span: s, children: [], req: r, grant: null, repeat: false }, parent: tree };
                }
            }
            if (!found && entry.key) found = RT.find(tree, entry.key);
            if (!found || found.node.kind !== 'tool') return null;
            const lv = live || {};
            const ctx = {
                trace,
                coverage: (gov && gov.coverage) || null,
                user: lv.user || (gov && gov.user) || null,
                host: lv.host || (gov && gov.host) || null,
                expiryOf: (req) => {
                    const p = mine.find(x => x && req && x.id === req.id);
                    return (p && p.expires_at) || (req && req.expires_at) || null;
                },
            };
            return { ctx, found, key: found.node.key, tree };
        },

        /** The `panel` option sectionsHtml takes: a key for each call row
         *  and the open call's span panel (the Runs one, with its approval
         *  controls), or no detail. */
        panelFor(sid, d, reqs, entry, live) {
            const RT = root.RunTrace;
            if (!d || !RT || !RT.buildTree) return null;
            const res = entry ? this.detailFor(sid, d, reqs, entry, live) : null;
            const tree = res ? res.tree : RT.buildTree({ trace_id: d.traceId || ('session:' + sid), session_id: sid, spans: d.spans || [] },
                { requests: this.sessionReqs(sid, reqs, d.gov), grants: [], newest: true });
            const bySpan = new Map();
            const byReq = new Map();
            RT.walk(tree, n => {
                if (n.kind !== 'tool') return;
                if (n.span) bySpan.set(n.span, n.key);
                if (n.req && n.req.id && !byReq.has(n.req.id)) byReq.set(n.req.id, n.key);
            });
            const keyOf = (r) => (r.span && bySpan.get(r.span)) || (r.reqId && (byReq.get(r.reqId) || 'req:' + r.reqId)) || null;
            let detailHtml = '';
            if (res) {
                const e = (x) => this.esc(x);
                const name = RT.toolName ? RT.toolName(res.found.node.span || {}) : 'Call';
                detailHtml = `<div class="lg-det" role="region" data-dsid="${e(sid)}" aria-label="${e('Details: ' + name)}">` +
                    RT.spanPanelHtml(res.ctx, res.found)
                        .replace('aria-label="Close span detail, show session governance"', 'aria-label="Close these call details"')
                        .replace('<div class="rt-ph"><h3>', `<div class="rt-ph"><h3 tabindex="-1" data-act="det-h" data-sid="${e(sid)}">`) +
                    `</div>`;
            }
            return { keyOf, openKey: res ? res.key : null, detailHtml, resolved: res };
        },

        /** Tool calls section: the latest calls (newest first, at most cap)
         *  and how many more the trace holds. */
        callSection(d, cap) {
            const n = cap || this.SECTION_CAP;
            const gov = (d && d.gov) || null;
            const pending = (gov && gov.approvals && gov.approvals.pending) || [];
            const all = this.recentCalls(d && d.spans, pending, 1e9);
            const RT = root.RunTrace;
            const rows = all.slice(0, n).map(r => {
                const dw = this.decisionWord(r.action);
                // A waiting call names its data only, as the banner does:
                // the raw command can carry values.
                const target = dw.key === 'waiting'
                    ? ((RT && RT.dataNames ? RT.dataNames(r.preview) : []) || []).join(', ')
                    : (this.previewOf(r.preview) || '');
                return { at: r.at, name: r.name, target, key: dw.key, label: dw.label, span: r.span || null, reqId: r.reqId || null };
            });
            const tc = (gov && gov.tool_calls) || {};
            const total = Math.max(Number(tc.total) || 0, all.length);
            return { rows, total, more: Math.max(0, total - rows.length) };
        },

        /** One host status in plain words. */
        egressStatus(status) {
            if (status === 'blocked') return { key: 'blocked', label: 'blocked' };
            if (status === 'waiting') return { key: 'waiting', label: 'waiting for approval' };
            if (status === 'tool') return { key: 'tool', label: 'stopped by a tool rule' };
            return { key: 'allowed', label: 'allowed' };
        },

        /** Egress section: hosts with their status (waiting, blocked and
         *  tool-rule stops first, then by calls), at most cap, plus counts.
         *  Hosts named in blocked tool calls come from the trace's own rule. */
        egressSection(gov, cap) {
            const n = cap || this.SECTION_CAP;
            if (!gov) return { loading: true, visible: true, rows: [], total: 0, more: 0, counts: {} };
            const RT = root.RunTrace;
            const eg = gov.egress || {};
            const hosts = RT && RT.egressHosts ? RT.egressHosts(gov).hosts
                : (Array.isArray(eg.hosts) ? eg.hosts.slice() : []);
            const visible = eg.visible !== false;
            const list = (visible ? hosts : hosts.filter(h => h.status === 'tool'));
            const rank = { waiting: 0, blocked: 1, tool: 2, allowed: 3 };
            const ordered = list.map(h => Object.assign({ calls: Number(h.calls) || 0 }, h, this.egressStatus(h.status), { host: String(h.host || '') }))
                .sort((a, b) => rank[a.key] - rank[b.key] || b.calls - a.calls || a.host.localeCompare(b.host));
            const counts = { allowed: 0, waiting: 0, blocked: 0, tool: 0 };
            ordered.forEach(h => { counts[h.key]++; });
            const rows = ordered.slice(0, n).map(h => ({ host: h.host, key: h.key, label: h.label, calls: h.calls }));
            return { loading: false, visible, rows, total: ordered.length, more: Math.max(0, ordered.length - rows.length), counts };
        },

        /** The two sections as markup, shared by the large tile and the
         *  expanded compact tile. "+N more" opens the trace. No decision
         *  control. */
        sectionsHtml(sid, d, opts = {}) {
            const e = (x) => this.esc(x);
            const cap = opts.cap || this.SECTION_CAP;
            const more = (n, what, act) => n > 0 ? `<button type="button" class="lg-link lg-more" data-act="${act}" data-sid="${e(sid)}">+${e(n)} more ${what}</button>` : '';
            const cs = this.callSection(d, cap);
            // With a panel (the page passes one), each call row opens its
            // details below it, one open per tile.
            const pn = opts.panel || null;
            let shownDet = false;
            const detLi = () => { shownDet = true; return `<li class="lg-calldet" id="lg-cd-${e(sid)}">${pn.detailHtml}</li>`; };
            const rowsHtml = cs.rows.map(r => {
                const tgt = r.target || r.name;
                const inner = `<span class="lg-call-t">${e(this.clock(r.at))}</span>` +
                    `<span class="lg-call-n" title="${e(r.name + (r.target ? ': ' + r.target : ''))}"><span class="lg-call-tool">${e(r.name)}</span>${r.target ? ` <span class="lg-call-arg">${e(tgt)}</span>` : ''}</span>` +
                    `<span class="lg-dec ${r.key}">${e(r.label)}</span>`;
                const key = pn && pn.keyOf ? pn.keyOf(r) : null;
                if (!key) return `<li>${inner}</li>`;
                const on = !!(pn.openKey && key === pn.openKey && pn.detailHtml && !shownDet);
                return `<li class="lg-crow"><button type="button" class="lg-call${on ? ' on' : ''}" data-act="call" data-sid="${e(sid)}" data-key="${e(key)}" aria-expanded="${on}"` +
                    `${on ? ` aria-controls="lg-cd-${e(sid)}"` : ''} aria-label="${e((on ? 'Hide' : 'Show') + ' details: ' + r.name + ', ' + r.label)}">${inner}</button></li>` +
                    (on ? detLi() : '');
            }).join('');
            // The open call is not among the latest rows: its details lead.
            const lead = pn && pn.detailHtml && !shownDet ? `<ol class="lg-calls">${detLi()}</ol>` : '';
            const callsBody = !d ? '<div class="lg-sec-empty">Loading calls…</div>'
                : lead + (cs.rows.length ? `<ol class="lg-calls">${rowsHtml}</ol>` : '<div class="lg-sec-empty">No calls recorded yet.</div>');
            const es = this.egressSection(d && d.gov, cap);
            const egCount = es.loading || (!es.visible && !es.total) ? '' : `${es.total} host${es.total === 1 ? '' : 's'}`;
            let egBody;
            if (!d || es.loading) egBody = `<div class="lg-sec-empty">${d && d.gov === null ? 'Not synced yet.' : 'Loading egress…'}</div>`;
            else {
                egBody = (!es.visible ? '<div class="lg-sec-empty">Egress not monitored: this harness has no egress view.</div>' : '') +
                    (es.rows.length ? `<ul class="lg-hosts">${es.rows.map(h =>
                        `<li><span class="lg-host" title="${e(h.host)}">${e(h.host)}</span>` +
                        `<span class="lg-host-n">${h.calls ? e(h.calls + ' call' + (h.calls === 1 ? '' : 's')) : ''}</span>` +
                        `<span class="lg-dec ${h.key}">${e(h.label)}</span></li>`).join('')}</ul>`
                        : (es.visible ? '<div class="lg-sec-empty">No egress observed.</div>' : ''));
            }
            return `<div class="lg-secs${shownDet ? ' has-det' : ''}">` +
                `<section class="lg-sec" aria-label="Tool calls"><h4 class="lg-sec-h">Tool calls<span class="lg-sec-n">${d ? e(cs.total) : ''}</span></h4>${callsBody}${d ? more(cs.more, cs.more === 1 ? 'call' : 'calls', 'more-calls') : ''}</section>` +
                `<section class="lg-sec" aria-label="Egress"><h4 class="lg-sec-h">Egress<span class="lg-sec-n">${e(egCount)}</span></h4>${egBody}${more(es.more, es.more === 1 ? 'host' : 'hosts', 'more-hosts')}</section>` +
                `</div>`;
        },

        /** The amber banner fields for the oldest waiting request. Data names
         *  only, values never. */
        banner(gov, reqs, coverageLevel) {
            const pend = (gov && gov.approvals && gov.approvals.pending) || [];
            if (!pend.length) return null;
            const p = pend[0];
            const full = (reqs || []).find(r => r && r.id === p.id) || p;
            const RT = root.RunTrace;
            const rule = RT && RT.ruleText ? RT.ruleText(full, null) : { id: '', name: '', version: '' };
            const names = RT && RT.dataNames ? RT.dataNames(p.call_preview || full.call_preview) : [];
            return {
                id: p.id, requested_at: p.requested_at, expires_at: p.expires_at || full.expires_at,
                rule: [rule.id || rule.name, rule.version].filter(Boolean).join(' '),
                // Names only: never the raw command, which can carry values.
                data: names.length ? names.join(', ') : String(p.function_name || p.tool_id || ''),
                partial: coverageLevel === 'partial',
                count: pend.length,
            };
        },

        /** One large tile. `s` is the live row (may be null when the pinned
         *  session is no longer running), `d` the detail: { gov, spans,
         *  reqs }. No approve or deny control on the tile: Review opens the
         *  span panel below the call, inside this tile. */
        largeTileHtml(sid, s, d, now, opts = {}) {
            const e = (x) => this.esc(x);
            const gov = (d && d.gov) || null;
            const live = s || {};
            const harness = this.harnessLabel(live.harness || (gov && gov.harness));
            const project = live.project || (gov && gov.project) || '';
            const cov = (gov && gov.coverage) || null;
            const covLevel = live.coverage_level || (cov && cov.level);
            const covLabel = live.coverage || (cov && cov.label) || this.coverageWord(covLevel);
            const st = s ? this.state(s) : 'ended';
            const quiet = s && (Number(s.quiet_seconds) || 0) > this.QUIET_S;
            const startedMs = this.ms(live.started_at || (gov && gov.started_at));
            // Missing from a list cut at the limit is not "not running".
            const stateText = !s ? (opts.cutAt ? `outside the first ${opts.cutAt}` : 'not running') : quiet ? `quiet ${this.dur(s.quiet_seconds)}`
                : `running${startedMs ? ' · ' + this.dur(((now || Date.now()) - startedMs) / 1000) : ''}`;
            const tc = (gov && gov.tool_calls) || live.tool_calls || {};
            const callsSub = [`${tc.allowed || 0} allowed`, tc.waiting ? `${tc.waiting} waiting` : '', tc.blocked ? `${tc.blocked} blocked` : ''].filter(Boolean).join(' · ');
            // Egress
            let egMain, egSub;
            if (gov && gov.egress && gov.egress.visible === false) { egMain = 'not checked'; egSub = 'for this harness'; }
            else if (gov && gov.egress) {
                // The same hosts the Egress section lists, tool-rule stops included.
                const es = this.egressSection(gov, 1);
                const w = es.counts.waiting, b = es.counts.blocked, t = es.counts.tool;
                egMain = `${es.total} host${es.total === 1 ? '' : 's'}`;
                egSub = (w || b || t) ? [w ? `${w} waiting` : '', b ? `${b} blocked` : '', t ? `${t} stopped by a tool rule` : ''].filter(Boolean).join(' · ') : 'none blocked';
            } else { egMain = '…'; egSub = 'loading'; }
            // Cost
            const c = (gov && gov.cost) || null;
            const usd = live.cost_usd != null ? live.cost_usd : (c ? c.usd : null);
            const tokens = live.tokens_pending ? null : (live.tokens != null && live.tokens > 0 ? live.tokens : (c ? c.tokens : null));
            const costMain = usd != null ? this.fmtUsd(usd) : (live.tokens_pending || tokens ? 'not recorded' : '—');
            const costSub = live.tokens_pending ? '… tokens' : (tokens ? `${this.fmtTok(tokens)} tokens` : 'no token data');
            // Findings
            const f = gov && gov.findings;
            const findMain = f ? String((f.threats || 0)) : '—';
            const findSub = f ? `threats · ${f.secrets || 0} secrets` : 'threats, secrets';
            // Score
            const enforced = cov ? cov.enforced === 'before_call' : covLevel !== 'not_enforced';
            // The stored score (the same one the compact tile and the Runs
            // list show) first; the governance summary's only when none is
            // stored yet.
            const scoreVal = typeof live.score === 'number' ? live.score
                : (gov && gov.score && typeof gov.score.score === 'number' ? gov.score.score : null);
            const scoreMain = scoreVal != null ? String(scoreVal) : 'no score';
            const scoreSub = scoreVal != null ? this.scoreBand(scoreVal) : (enforced ? 'not scored yet' : 'not enforced');
            const cell = (k, main, sub, tone) => `<div class="lg-cell${tone ? ' ' + tone : ''}"><div class="lg-cell-k">${e(k)}</div>` +
                `<div class="lg-cell-v">${e(main)}</div><div class="lg-cell-s">${e(sub)}</div></div>`;
            const b = this.banner(gov, d && d.reqs, covLevel);
            const bannerHtml = b ? `<div class="lg-banner" role="status"><div class="lg-banner-txt"><strong>Waiting for approval</strong>` +
                (b.requested_at ? ` · ${e(this.dur(((now || Date.now()) - (this.ms(b.requested_at) || now || Date.now())) / 1000))}` : '') +
                (b.expires_at ? ` · denied at ${e(this.clock(b.expires_at))} if unanswered` : '') +
                (b.rule ? ` · ${e(b.rule)}` : '') + (b.data ? ` · ${e(b.data)}` : '') +
                (b.partial ? ' · approving with partial coverage' : '') +
                (b.count > 1 ? ` · ${e(b.count - 1)} more waiting` : '') +
                `</div><button type="button" class="lg-btn lg-review" data-act="review" data-sid="${e(sid)}" data-req="${e(b.id)}">Review</button></div>` : '';
            const callsHtml = this.sectionsHtml(sid, d, { panel: opts.panel || null });
            const dot = !s ? (opts.cutAt ? 'quiet' : 'off') : quiet ? 'quiet' : 'live';
            return `<article class="lg-tile st-${st}" data-sid="${e(sid)}" aria-label="${e((project || harness) + ' session ' + this.short(sid))}">` +
                `<header class="lg-thead"><span class="lg-dot ${dot}" aria-hidden="true"></span>` +
                `<span class="lg-th-h">${e(harness)}</span><span class="lg-th-p">${e(project)}</span>` +
                `<span class="lg-th-id">${e(this.short(sid))}</span><span class="lg-cov">${e(covLabel)}</span>` +
                `<span class="lg-th-st">${e(stateText)}</span>` +
                `<button type="button" class="lg-unpin" data-act="unpin" data-sid="${e(sid)}" aria-label="Unpin session ${e(this.short(sid))}" title="Unpin">✕</button></header>` +
                `<div class="lg-cells">` +
                cell('Tool calls', String(tc.total || 0), callsSub, tc.waiting ? 'warn' : tc.blocked ? 'bad' : '') +
                cell('Egress', egMain, egSub, /waiting/.test(egSub) ? 'warn' : (/blocked|tool rule/.test(egSub) && egSub !== 'none blocked') ? 'bad' : '') +
                cell('Cost', costMain, costSub, '') +
                cell('Findings', findMain, findSub, f && (f.threats || f.secrets) ? 'bad' : '') +
                cell('Score', scoreMain, scoreSub, '') +
                `</div>` + bannerHtml + callsHtml +
                `<div class="lg-tfoot"><button type="button" class="lg-link" data-act="open-foot" data-sid="${e(sid)}">Open trace →</button>` +
                `<button type="button" class="lg-link lg-link-2" data-act="open-runs" data-sid="${e(sid)}">Open in Runs</button></div>` +
                `</article>`;
        },
    };
    root.LiveGridModel = LiveGridModel;
})(typeof window !== 'undefined' ? window : globalThis);
