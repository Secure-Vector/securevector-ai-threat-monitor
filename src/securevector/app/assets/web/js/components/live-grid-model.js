/**
 * LiveGridModel: the rules behind Observability > Live grid, kept free of the
 * DOM so they can be tested on their own.
 *
 * A Session is one running agent session (GET /api/terminals/observability/
 * live). Large tiles show the pinned sessions with their full governance;
 * compact tiles scale to hundreds of running sessions.
 *
 * The grid never approves or denies anything. Approvals happen only in the
 * trace span panel, with the full context of the one call they apply to; a
 * tile shows the waiting state and its expiry and links to that panel.
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
                harness: '', project: '', status: '', group: 'none', toggles: {} };
        },

        // ----------------------------------------------------------- state

        /** waiting | blocked | quiet | running */
        state(s) {
            if (!s) return 'running';
            if ((s.waiting || 0) > 0) return 'waiting';
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
                s.coverage_level, s.repeat_attempt, s.started_at, Math.floor((Number(s.quiet_seconds) || 0) / 10)]);
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
            if (key === 'waiting') return (s.waiting || 0) > 0;
            if (key === 'blocked') return (s.blocked || 0) > 0;
            if (key === 'score70') return typeof s.score === 'number' && s.score >= 70;
            if (key === 'quiet') return (Number(s.quiet_seconds) || 0) > this.QUIET_S;
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
                return on.every(k => this.matchToggle(s, k));
            });
        },

        /** Counters over every running session (the server sends these; this
         *  rebuilds them from a list when it does not). */
        counters(sessions) {
            const all = sessions || [];
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
            };
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

        counterCells(c, sessions, now) {
            const cc = c || this.counters(sessions);
            const ow = this.oldestWaiting(sessions, now);
            const owExp = ow ? this.clock(ow.oldest_waiting_expires_at) : '';
            const cost = cc.cost_usd != null ? this.fmtUsd(cc.cost_usd) : '—';
            return [
                { key: 'waiting', label: 'Waiting for approval', value: cc.waiting || 0, sub: owExp ? `next expires ${owExp}` : 'none waiting' },
                { key: 'blocked', label: 'With blocked calls', value: cc.blocked_sessions || 0, sub: 'sessions' },
                { key: 'score70', label: 'Score 70+', value: cc.score_70_plus || 0, sub: 'high' },
                { key: 'quiet', label: 'Quiet over 5m', value: cc.quiet_over_5m || 0, sub: 'may be stuck' },
                { key: 'cost', label: 'Cost, running', value: cost,
                    sub: `${this.fmtTok(cc.tokens || 0)} tokens` + (cc.cost_known_sessions != null && cc.cost_known_sessions < (cc.running || 0) ? ` · recorded for ${cc.cost_known_sessions}` : '') },
            ];
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
                const local = { running: c.running, waiting: c.waiting, blocked_sessions: c.blocked_sessions,
                    blocked: list.reduce((a, s) => a + (s.blocked || 0), 0) };
                return { key, sessions: list, rollup: roll.get(key) || local };
            });
            return out.sort((a, b) => ((b.rollup.waiting || 0) - (a.rollup.waiting || 0))
                || ((b.rollup.blocked_sessions || 0) - (a.rollup.blocked_sessions || 0))
                || ((b.rollup.running || 0) - (a.rollup.running || 0)) || String(a.key).localeCompare(String(b.key)));
        },

        // -------------------------------------------------------- markup

        /** One small tile. No listeners: the page delegates clicks on
         *  [data-sid]. No approve or deny control. */
        compactTileHtml(s, pinned, open) {
            const e = (x) => this.esc(x);
            const st = this.state(s);
            const harness = this.harnessLabel(s.harness);
            const cov = this.coverageWord(s.coverage_level);
            const tc = s.tool_calls || {};
            const title = [
                `Session ${s.session_id}`,
                `Calls ${tc.total || 0}: ${tc.allowed || 0} allowed, ${tc.waiting || 0} waiting, ${tc.blocked || 0} blocked`,
                `Cost ${this.costText(s)}`,
                s.coverage ? `Coverage ${s.coverage}` : '',
            ].filter(Boolean).join('\n');
            const score = typeof s.score === 'number' ? `<span class="lg-c-score">${e(s.score)}</span>` : '<span class="lg-c-score none">no score</span>';
            const sid = e(s.session_id);
            const name = s.project || this.short(s.session_id);
            const exp = `<button type="button" class="lg-exp" data-act="expand" data-sid="${sid}" aria-expanded="${open ? 'true' : 'false'}"` +
                ` aria-controls="lg-cx-${sid}" aria-label="${open ? 'Hide' : 'Show'} tool calls and egress for ${e(name)}" title="${open ? 'Hide' : 'Show'} tool calls and egress">` +
                `<span aria-hidden="true">${open ? '▾' : '▸'}</span></button>`;
            return `<div class="lg-cw${pinned ? ' pinned' : ''}${open ? ' open' : ''}"><button type="button" class="lg-c st-${st}" data-act="open" data-sid="${sid}" title="${e(title)}" aria-label="${e((s.project || harness) + ', ' + this.stateLine(s) + ', open trace')}">` +
                `<span class="lg-c-bar" aria-hidden="true"></span>` +
                `<span class="lg-c-main"><span class="lg-c-name">${e(s.project || this.short(s.session_id))}</span>` +
                `<span class="lg-c-state">${e(this.stateLine(s))}</span>` +
                `<span class="lg-c-sub">${e(harness)} · ${e(cov)}</span></span>` + score + `</button>` +
                `<button type="button" class="lg-pin" data-act="pin" data-sid="${sid}" aria-pressed="${pinned ? 'true' : 'false'}" aria-label="${pinned ? 'Unpin' : 'Pin'} session ${e(this.short(s.session_id))}" title="${pinned ? 'Unpin' : 'Pin for the large view'}">◆</button>` + exp + `</div>`;
        },

        /** A tile and, when it is expanded, its full-row panel right after
         *  it. The grid packs densely, so the panel opens under the tile's
         *  row and the tiles after it keep their places in that row. */
        _tileWithPanel(s, pins, openSet, details) {
            const open = openSet.has(s.session_id);
            const tile = this.compactTileHtml(s, pins.has(s.session_id), open);
            if (!open) return tile;
            const sid = this.esc(s.session_id);
            const d = (details || {})[s.session_id] || null;
            return tile + `<div class="lg-cx" id="lg-cx-${sid}" role="region" aria-label="${this.esc((s.project || this.short(s.session_id)) + ': tool calls and egress')}">` +
                `<div class="lg-cx-head"><span class="lg-cx-name">${this.esc(s.project || this.harnessLabel(s.harness))}</span>` +
                `<span class="lg-th-id">${this.esc(this.short(s.session_id))}</span>` +
                `<button type="button" class="lg-link" data-act="open-panel" data-sid="${sid}">Open trace →</button></div>` +
                this.sectionsHtml(s.session_id, d) + `</div>`;
        },

        /** The whole compact body as one string: groups with a caret,
         *  rollup line and "Show all N". */
        compactHtml(groups, opts = {}) {
            const e = (x) => this.esc(x);
            const collapsed = opts.collapsed || {};
            const expanded = opts.expanded || {};
            const pins = new Set(opts.pins || []);
            const openSet = new Set(opts.open || []);
            const tiles = (list) => list.map(s => this._tileWithPanel(s, pins, openSet, opts.details)).join('');
            const by = opts.group || 'none';
            const label = (k) => (by === 'harness' ? this.harnessLabel(k) : k);
            if (!groups.length || !groups.some(g => g.sessions.length)) {
                return `<div class="lg-empty">${e(opts.emptyText || 'No running sessions match.')}</div>`;
            }
            return groups.map(g => {
                if (by === 'none') {
                    return `<div class="lg-cgrid">${tiles(g.sessions)}</div>`;
                }
                const open = !collapsed[g.key];
                const total = (g.rollup && g.rollup.running) || g.sessions.length;
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
                preview: s.args_preview, action: s.action }));
            (pending || []).forEach(p => rows.push({ at: p.requested_at, name: p.function_name || p.tool_id || 'tool',
                preview: p.call_preview, action: 'hold' }));
            rows.sort((a, b) => (this.ms(b.at) || 0) - (this.ms(a.at) || 0));
            return rows.slice(0, n);
        },

        previewOf(x) {
            // The trace tree's reading first (command, url, file path), so a
            // tile names a call the way its span does.
            const RT = root.RunTrace;
            if (RT && RT.previewText && typeof x === 'string') {
                const r = String(RT.previewText(x) || '');
                if (r !== x) return r.replace(/\s+/g, ' ').slice(0, 90);
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
                return { at: r.at, name: r.name, target, key: dw.key, label: dw.label };
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
            const callsBody = !d ? '<div class="lg-sec-empty">Loading calls…</div>'
                : cs.rows.length ? `<ol class="lg-calls">${cs.rows.map(r => {
                    const tgt = r.target || r.name;
                    return `<li><span class="lg-call-t">${e(this.clock(r.at))}</span>` +
                        `<span class="lg-call-n" title="${e(r.name + (r.target ? ': ' + r.target : ''))}"><span class="lg-call-tool">${e(r.name)}</span>${r.target ? ` <span class="lg-call-arg">${e(tgt)}</span>` : ''}</span>` +
                        `<span class="lg-dec ${r.key}">${e(r.label)}</span></li>`;
                }).join('')}</ol>` : '<div class="lg-sec-empty">No calls recorded yet.</div>';
            const es = this.egressSection(d && d.gov, cap);
            const egCount = es.loading || (!es.visible && !es.total) ? '' : `${es.total} host${es.total === 1 ? '' : 's'}`;
            let egBody;
            if (!d || es.loading) egBody = `<div class="lg-sec-empty">${d && d.gov === null ? 'No governance summary for this session.' : 'Loading egress…'}</div>`;
            else {
                egBody = (!es.visible ? '<div class="lg-sec-empty">Not checked: this harness has no egress view.</div>' : '') +
                    (es.rows.length ? `<ul class="lg-hosts">${es.rows.map(h =>
                        `<li><span class="lg-host" title="${e(h.host)}">${e(h.host)}</span>` +
                        `<span class="lg-host-n">${h.calls ? e(h.calls + ' call' + (h.calls === 1 ? '' : 's')) : ''}</span>` +
                        `<span class="lg-dec ${h.key}">${e(h.label)}</span></li>`).join('')}</ul>`
                        : (es.visible ? '<div class="lg-sec-empty">No network destinations yet.</div>' : ''));
            }
            return `<div class="lg-secs">` +
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
         *  reqs }. No approve or deny control: Review opens the span panel. */
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
            const callsHtml = this.sectionsHtml(sid, d);
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
                `<div class="lg-tfoot"><button type="button" class="lg-link" data-act="open-foot" data-sid="${e(sid)}">Open trace →</button></div>` +
                `</article>`;
        },
    };
    root.LiveGridModel = LiveGridModel;
})(typeof window !== 'undefined' ? window : globalThis);
