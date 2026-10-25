/**
 * RunsList: the data rules behind Observability > Runs, kept free of the DOM
 * so they can be tested on their own.
 *
 * Vocabulary: a Session is one agent session; a Run is one trace inside it
 * (GET /api/traces returns runs); a Span is one model turn or tool call.
 *
 * The list never approves or denies anything. Approvals happen only in the
 * trace span panel, with the full context of the one call they apply to.
 */
const RunsList = {
    LIVE_MS: 120000,
    PAGE_SIZE: 50,
    // Runs shown per session before "N earlier runs".
    SESSION_PREVIEW: 3,
    VIEWS_KEY: 'sv-runs-views',

    RANGES: {
        '1h': { days: 1, ms: 3600e3, label: 'Last hour', bucket: 5 * 60e3 },
        '24h': { days: 1, ms: 86400e3, label: 'Last 24 hours', bucket: 3600e3 },
        '7d': { days: 7, ms: 7 * 86400e3, label: 'Last 7 days', bucket: 3600e3 },
        '30d': { days: 30, ms: 30 * 86400e3, label: 'Last 30 days', bucket: 3600e3 },
        // Only offered while a deep link widened the range to reach its run.
        '90d': { days: 90, ms: 90 * 86400e3, label: 'Last 90 days', bucket: 3600e3, hidden: true },
    },

    STATUS: [
        ['review', 'Needs review'],
        ['running', 'Running'],
        ['ok', 'OK'],
        ['error', 'Error'],
    ],
    DECISION: [
        ['waiting', 'Waiting for approval'],
        ['blocked', 'Blocked'],
        ['allowed', 'Allowed only'],
    ],
    HEALTH: [['loop', 'Loop'], ['failing', 'Failing'], ['wasteful', 'Wasteful']],

    emptyFilters() {
        return { status: '', decision: [], harness: [], project: [], model: [], host: [], user: [], health: [], search: '' };
    },

    ms(ts) {
        if (!ts) return 0;
        const s = String(ts);
        const d = new Date(s.replace(' ', 'T') + (/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
        return isNaN(d) ? 0 : d.getTime();
    },

    duration(r) {
        const a = this.ms(r && r.started_at), b = this.ms(r && r.ended_at);
        return a && b && b >= a ? b - a : null;
    },

    /** What the Duration column shows: elapsed time since start while the
     *  run is running, the recorded span when it ended, null when unknown. */
    shownDuration(r, ctx) {
        if (this.status(r, ctx) === 'running') {
            const a = this.ms(r && r.started_at);
            const now = (ctx && ctx.now) || Date.now();
            return a && now >= a ? now - a : null;
        }
        return this.duration(r);
    },

    /** p95 of finished runs only: a running run has no duration yet. */
    finishedDurations(runs, ctx) {
        return runs.filter(r => this.status(r, ctx) !== 'running').map(r => this.duration(r)).filter(v => v != null);
    },

    project(r) {
        const t = r && r.terminal_task;
        return (t && t.workspace_name) || (r && r.project) || null;
    },
    host(r) { return (r && r.host) || null; },
    user(r) { return (r && r.user) || null; },

    /** Shared facts the per-run rules need: run numbers inside each session,
     *  the newest run of each session, live sessions and their scores, and
     *  the age of the oldest waiting request per run. */
    buildCtx(runs, opts = {}) {
        const now = opts.now || Date.now();
        const bySession = new Map();
        (runs || []).forEach(r => {
            const k = r.session_id || ('trace:' + r.trace_id);
            if (!bySession.has(k)) bySession.set(k, []);
            bySession.get(k).push(r);
        });
        const runIndex = {}, runTotal = {}, newest = {};
        bySession.forEach((list, k) => {
            const asc = list.slice().sort((a, b) => (this.ms(a.started_at) || this.ms(a.ended_at)) - (this.ms(b.started_at) || this.ms(b.ended_at)));
            asc.forEach((r, i) => { runIndex[r.trace_id] = i + 1; runTotal[r.trace_id] = asc.length; });
            const last = list.reduce((m, r) => (!m || this.ms(r.ended_at) > this.ms(m.ended_at) ? r : m), null);
            if (last) newest[k] = last.trace_id;
        });
        const live = {}, scores = {};
        ((opts.live && opts.live.sessions) || []).forEach(s => {
            if (!s || !s.session_id) return;
            live[s.session_id] = s;
            if (typeof s.score === 'number') scores[s.session_id] = s.score;
        });
        // Oldest waiting request per run, from the pending approvals list.
        const waitingSince = {};
        ((opts.pending && opts.pending.items) || []).forEach(p => {
            if (!p || p.rule_source === 'delegate') return;
            let tid = p.trace_id;
            if (!tid && p.session_id && newest[p.session_id]) tid = newest[p.session_id];
            const at = this.ms(p.requested_at);
            if (tid && at && (!waitingSince[tid] || at < waitingSince[tid])) waitingSince[tid] = at;
        });
        return { now, runIndex, runTotal, newest, live, scores, waitingSince, coverage: opts.coverage || null };
    },

    _sessionKey(r) { return r.session_id || ('trace:' + r.trace_id); },
    isNewest(r, ctx) { return !!ctx && ctx.newest[this._sessionKey(r)] === r.trace_id; },

    isRunning(r, ctx) {
        const now = (ctx && ctx.now) || Date.now();
        if (r.ended_at && now - this.ms(r.ended_at) < this.LIVE_MS) return true;
        return !!(ctx && r.session_id && ctx.live[r.session_id] && this.isNewest(r, ctx));
    },

    score(r, ctx) {
        if (!ctx || !r.session_id || !this.isNewest(r, ctx)) return null;
        const s = ctx.scores[r.session_id];
        return typeof s === 'number' ? s : null;
    },

    /** running | error | ok */
    status(r, ctx) {
        if (this.isRunning(r, ctx)) return 'running';
        if (Number((r.health || {}).failing) > 0) return 'error';
        return 'ok';
    },

    calls(r) {
        return { allowed: Number(r.allowed || 0), waiting: Number(r.waiting || 0), blocked: Number(r.blocked || 0) };
    },

    /** Waiting approvals, blocked calls, or a session score of 70 or more. */
    needsReview(r, ctx) {
        const c = this.calls(r);
        if (c.waiting > 0 || c.blocked > 0) return true;
        const sc = this.score(r, ctx);
        return sc != null && sc >= 70;
    },

    /** Parse "session:abc harness:codex project:api decision:blocked text". */
    parseSearch(q) {
        const out = { session: '', harness: '', project: '', decision: '', text: '' };
        const rest = [];
        String(q || '').trim().split(/\s+/).filter(Boolean).forEach(tok => {
            const m = tok.match(/^(session|harness|project|decision):(.*)$/i);
            if (m && m[2]) out[m[1].toLowerCase()] = m[2].toLowerCase();
            else rest.push(tok);
        });
        out.text = rest.join(' ').toLowerCase();
        return out;
    },

    /** A free-text term that reads as a span hash (hex, 8 or more). */
    looksLikeHash(text) {
        return /^[0-9a-f]{8,128}$/i.test(String(text || '').trim());
    },

    _decisionKey(word) {
        const w = String(word || '').toLowerCase();
        if (w.startsWith('wait')) return 'waiting';
        if (w.startsWith('block')) return 'blocked';
        if (w.startsWith('allow')) return 'allowed';
        return w;
    },

    _decisionMatch(r, key) {
        const c = this.calls(r);
        if (key === 'waiting') return c.waiting > 0;
        if (key === 'blocked') return c.blocked > 0;
        if (key === 'allowed') return c.waiting === 0 && c.blocked === 0;
        return true;
    },

    name(r, ctx) {
        const named = window.ObsTabs && ObsTabs.agentName ? ObsTabs.agentName(r.trace_id) : null;
        const t = r.terminal_task;
        const title = named || r.first_prompt || r.task_title || (t && t.title && String(t.title).trim()) || '';
        const n = ctx && ctx.runIndex[r.trace_id];
        const base = n ? `Run ${n}` : 'Run';
        return title ? `${base} · ${title}` : base;
    },

    _text(r, ctx) {
        return [this.name(r, ctx), r.session_id, r.trace_id, r.runtime_kind, this.project(r), this.host(r), this.user(r),
            ...(r.models || []), ...(r.tools || [])].filter(Boolean).join(' ').toLowerCase();
    },

    inRange(r, rangeKey, now) {
        const rg = this.RANGES[rangeKey] || this.RANGES['24h'];
        const t = this.ms(r.ended_at) || this.ms(r.started_at);
        return !t || (now - t) <= rg.ms;
    },

    matches(r, f, ctx) {
        f = f || this.emptyFilters();
        if (f.status === 'review' && !this.needsReview(r, ctx)) return false;
        if (f.status && f.status !== 'review' && this.status(r, ctx) !== f.status) return false;
        if (f.decision && f.decision.length && !f.decision.some(d => this._decisionMatch(r, d))) return false;
        if (f.harness && f.harness.length && !f.harness.includes(r.runtime_kind || 'unknown')) return false;
        if (f.project && f.project.length && !f.project.includes(this.project(r) || 'none')) return false;
        if (f.model && f.model.length && !(r.models || []).some(m => f.model.includes(m))) return false;
        if (f.host && f.host.length && !f.host.includes(this.host(r) || 'this device')) return false;
        if (f.user && f.user.length && !f.user.includes(this.user(r) || 'unknown')) return false;
        if (f.health && f.health.length && !f.health.some(h => Number((r.health || {})[h]) > 0)) return false;
        const q = this.parseSearch(f.search);
        if (q.session && !String(r.session_id || '').toLowerCase().startsWith(q.session)) return false;
        if (q.harness && !String(r.runtime_kind || '').toLowerCase().includes(q.harness)) return false;
        if (q.project && !String(this.project(r) || '').toLowerCase().includes(q.project)) return false;
        if (q.decision && !this._decisionMatch(r, this._decisionKey(q.decision))) return false;
        if (q.text && !this._text(r, ctx).includes(q.text)) return false;
        return true;
    },

    /** The tab-row filters as removable chips, one per chosen value (the
     *  search box is not one: it stays on the second row). Pure. */
    filterChips(f) {
        const out = [];
        if (!f) return out;
        const name = (list, k) => ((list.find(x => x[0] === k) || [0, k])[1]);
        if (f.status) out.push({ key: 'status', value: f.status, label: `Status: ${name(this.STATUS, f.status)}` });
        const dims = [
            ['decision', 'Decision', (v) => name(this.DECISION, v)],
            ['harness', 'Harness', (v) => v],
            ['project', 'Project', (v) => v],
            ['model', 'Model', (v) => v],
            ['host', 'Host', (v) => v],
            ['user', 'User', (v) => v],
            ['health', 'Health', (v) => name(this.HEALTH, v)],
        ];
        dims.forEach(([key, label, show]) => {
            (Array.isArray(f[key]) ? f[key] : []).forEach(v => out.push({ key, value: v, label: `${label}: ${show(v)}` }));
        });
        return out;
    },

    /** Remove one chip from the filters, in place. Returns the filters. */
    removeFilterChip(f, chip) {
        if (!f || !chip) return f;
        if (chip.key === 'status') { f.status = ''; return f; }
        const list = f[chip.key];
        if (Array.isArray(list)) {
            const at = list.indexOf(chip.value);
            if (at >= 0) list.splice(at, 1);
        }
        return f;
    },

    /** Every chip cleared; the search text is kept (it is not in the
     *  Filters popover). Returns new filters. */
    clearFilterChips(f) {
        return Object.assign(this.emptyFilters(), { search: (f && f.search) || '' });
    },

    /** Count of active filters (the search box included). */
    activeCount(f) {
        if (!f) return 0;
        let n = f.status ? 1 : 0;
        ['decision', 'harness', 'project', 'model', 'host', 'user', 'health'].forEach(k => { if (f[k] && f[k].length) n++; });
        if (String(f.search || '').trim()) n++;
        return n;
    },

    _statusRank(r, ctx) {
        const c = this.calls(r);
        if (c.waiting) return 0;
        if (c.blocked) return 1;
        const s = this.status(r, ctx);
        return s === 'running' ? 2 : s === 'error' ? 3 : 4;
    },

    sortValue(r, key, ctx) {
        switch (key) {
            case 'duration': return this.shownDuration(r, ctx) || 0;
            case 'tokens': return Number(r.tokens || 0);
            case 'cost': return Number(r.cost || 0);
            case 'calls': { const c = this.calls(r); return c.allowed + c.waiting + c.blocked; }
            case 'status': return -this._statusRank(r, ctx);
            case 'session': return `${r.runtime_kind || ''} ${this.project(r) || ''} ${r.session_id || ''}`.toLowerCase();
            case 'host': return `${this.host(r) || ''} ${this.user(r) || ''}`.toLowerCase();
            case 'started':
            default: return this.ms(r.started_at) || this.ms(r.ended_at);
        }
    },

    sortRuns(runs, key, dir, ctx) {
        const sign = dir === 'asc' ? 1 : -1;
        return runs.slice().sort((a, b) => {
            const x = this.sortValue(a, key || 'started', ctx), y = this.sortValue(b, key || 'started', ctx);
            if (x < y) return -sign;
            if (x > y) return sign;
            return (this.ms(b.ended_at) - this.ms(a.ended_at));
        });
    },

    /** Review-needed first (owner rule): runs with a waiting approval move
     *  ahead of all others, soonest expiry first (no expiry last), the rest
     *  keep their order. Grouped by session after this, sessions with a
     *  waiting run lead (soonest expiry first, so they land on page 1) and
     *  inside a session its waiting runs come first. */
    waitingFirst(runs) {
        const exp = (r) => this.ms(r.oldest_waiting_expires_at) || Infinity;
        const idx = new Map((runs || []).map((r, i) => [r, i]));
        const w = (runs || []).filter(r => Number(r && r.waiting || 0) > 0)
            .sort((a, b) => (exp(a) - exp(b)) || (idx.get(a) - idx.get(b)));
        return w.concat((runs || []).filter(r => !(Number(r && r.waiting || 0) > 0)));
    },

    /** Needs review order: waiting first, oldest request first; then
     *  blocked, newest first; then the rest (high score). */
    reviewOrder(runs, ctx) {
        const since = (r) => (ctx && ctx.waitingSince[r.trace_id]) || this.ms(r.oldest_waiting_expires_at) || Infinity;
        const rank = (r) => { const c = this.calls(r); return c.waiting ? 0 : c.blocked ? 1 : 2; };
        return runs.slice().sort((a, b) => {
            const ra = rank(a), rb = rank(b);
            if (ra !== rb) return ra - rb;
            if (ra === 0) return since(a) - since(b);
            return this.ms(b.ended_at) - this.ms(a.ended_at);
        });
    },

    /** Group sorted runs by session, sessions in the order their first run
     *  appears, runs keeping the sort order. */
    groupBySession(runs) {
        const groups = [];
        const at = new Map();
        runs.forEach(r => {
            const k = this._sessionKey(r);
            if (!at.has(k)) { const g = { key: k, session_id: r.session_id || null, runs: [] }; at.set(k, g); groups.push(g); }
            at.get(k).runs.push(r);
        });
        return groups;
    },

    page(list, pageIdx, size) {
        size = size || this.PAGE_SIZE;
        const total = list.length;
        const pages = Math.max(1, Math.ceil(total / size));
        const p = Math.min(Math.max(0, pageIdx || 0), pages - 1);
        const items = list.slice(p * size, p * size + size);
        return { items, page: p, pages, total, from: total ? p * size + 1 : 0, to: p * size + items.length };
    },

    /** Grouped paging: by session, never splitting a session's runs.
     *  Each page holds up to `size` sessions with all their matching runs. */
    pageSessions(orderedRuns, pageIdx, size) {
        size = size || this.PAGE_SIZE;
        const groups = this.groupBySession(orderedRuns);
        const info = this.page(groups, pageIdx, size);
        info.groups = info.items;
        info.runs = info.groups.reduce((a, g) => a + g.runs.length, 0);
        info.totalRuns = orderedRuns.length;
        return info;
    },

    /** The rows a session shows: all when expanded, else its newest
     *  SESSION_PREVIEW plus the open run. `hidden` is exact: the session's
     *  matching runs minus the rows shown. */
    sessionRows(g, expanded, selected) {
        const rows = expanded ? g.runs.slice() : g.runs.slice(0, this.SESSION_PREVIEW);
        if (!expanded && selected) {
            const sel = g.runs.find(r => r.trace_id === selected);
            if (sel && !rows.includes(sel)) rows.push(sel);
        }
        return { rows, hidden: g.runs.length - rows.length };
    },

    // ------------------------------------------------- inline expansion
    // A run opens in place: its span tree shows indented under the run row
    // in the same table, a span's details open as a row below it. Sessions,
    // runs and spans all start collapsed.

    /** Runs open at once; opening one more closes the oldest. */
    INLINE_MAX_OPEN: 10,

    /** A session shows only its header until opened, unless it holds the
     *  run whose full trace is open. */
    sessionClosed(openSessions, g, selected) {
        if (openSessions && openSessions[g.key]) return false;
        return !(selected && (g.runs || []).some(r => r.trace_id === selected));
    },

    /** Open or close one run. Returns the new open list (oldest first) and
     *  the runs closed to stay within the cap. */
    inlineToggle(open, traceId, max) {
        max = max || this.INLINE_MAX_OPEN;
        const list = (open || []).filter(id => id !== traceId);
        if (list.length !== (open || []).length) return { open: list, opened: false, evicted: [] };
        list.push(traceId);
        const evicted = [];
        while (list.length > max) evicted.push(list.shift());
        return { open: list, opened: true, evicted };
    },

    /** The rows a run shows under itself: its span tree flattened depth
     *  first, the run row being the root (depth 0, not returned). A node's
     *  children show only when its key is in `openKeys`, so every level
     *  starts collapsed. `guides[k]` says whether the line of the depth k+1
     *  ancestor continues past this row; `last` ends its own connector. */
    inlineRows(tree, openKeys) {
        const out = [];
        const open = openKeys || {};
        const visit = (n, depth, guides, last) => {
            const kids = n.children || [];
            const expanded = !!open[n.key] && kids.length > 0;
            out.push({ node: n, key: n.key, depth, guides, last, hasKids: kids.length > 0, expanded });
            if (expanded) kids.forEach((c, i) => visit(c, depth + 1, guides.concat([!last]), i === kids.length - 1));
        };
        const top = (tree && tree.children) || [];
        top.forEach((c, i) => visit(c, 1, [], i === top.length - 1));
        return out;
    },

    /** What makes an open run fetch its spans again on a live refresh: its
     *  span count, and its waiting count (a decision made elsewhere). */
    inlineSig(r) {
        return `${Number((r && r.spans) || 0)}|${Number((r && r.waiting) || 0)}`;
    },

    /** On a live tick: should this open run fetch again? Yes after a failed
     *  fetch (a retry, at most once a tick since a fetch in flight blocks
     *  another), or when its signature moved. */
    inlineNeedsFetch(entry, r) {
        if (!entry || entry.loading) return false;
        if (entry.error) return true;
        if (!entry.trace || !r) return false;
        return this.inlineSig(r) !== entry.sig;
    },

    /** Drop the cached spans of every run that is no longer open. */
    inlinePrune(cache, open) {
        const keep = new Set(open || []);
        Object.keys(cache || {}).forEach(id => { if (!keep.has(id)) delete cache[id]; });
        return cache;
    },

    /** Per-run fetch sequence: start a fetch, then keep its answer only if
     *  no newer fetch for the same run started since. */
    inlineBegin(entry) {
        entry.seq = (entry.seq || 0) + 1;
        return entry.seq;
    },
    inlineCurrent(entry, seq) { return !!entry && entry.seq === seq; },

    // ------------------------------------------------- jump to a waiting call
    // The amber "waiting for approval" badge is a shortcut: it opens the
    // session, the run and the turn, and the waiting span's details, where
    // Approve and Deny live with the call's full context.

    /** The waiting request among `traceIds` that expires soonest (no expiry
     *  sorts last, then the oldest request). A request without a trace id
     *  belongs to its session's newest run, as in buildCtx. Returns
     *  { req, traceId } or null. */
    soonestWaiting(items, traceIds, ctx) {
        const want = new Set(traceIds || []);
        const newest = (ctx && ctx.newest) || {};
        let best = null;
        const exp = (p) => this.ms(p.expires_at) || Infinity;
        const at = (p) => this.ms(p.requested_at) || Infinity;
        (items || []).forEach(p => {
            if (!p || p.rule_source === 'delegate' || (p.status && p.status !== 'pending')) return;
            const tid = p.trace_id || (p.session_id && newest[p.session_id]) || null;
            if (!tid || !want.has(tid)) return;
            if (!best || exp(p) < exp(best.req) || (exp(p) === exp(best.req) && at(p) < at(best.req))) best = { req: p, traceId: tid };
        });
        return best;
    },

    /** Fallback when the pending list has no match: the run with waiting
     *  calls whose oldest wait expires soonest. */
    soonestWaitingRun(runs) {
        const w = (runs || []).filter(r => r && Number(r.waiting || 0) > 0);
        if (!w.length) return null;
        const exp = (r) => this.ms(r.oldest_waiting_expires_at) || Infinity;
        return w.slice().sort((a, b) => exp(a) - exp(b))[0];
    },

    /** The path to a waiting span in a run's span tree: the keys to open
     *  (its ancestors under the run, e.g. the turn) and the span's key.
     *  Matches by request id as the trace panel does (node.req.id); with no
     *  id, the pending node that expires soonest. Null when not found. */
    waitPath(tree, reqId) {
        let best = null;
        const exp = (n) => this.ms(n.req && n.req.expires_at) || Infinity;
        const visit = (n, anc) => {
            const r = n.req;
            if (r && (reqId ? r.id === reqId : r.status === 'pending')) {
                if (!best || (!reqId && exp(n) < exp(best.node))) best = { node: n, open: anc.slice() };
                if (reqId) return;
            }
            const next = n.kind === 'run' ? anc : anc.concat([n.key]);
            (n.children || []).forEach(c => { if (!(reqId && best)) visit(c, next); });
        };
        if (tree) visit(tree, []);
        return best ? { key: best.node.key, open: best.open } : null;
    },

    /** The list page that holds a run: by run in the flat list, by session
     *  when grouped (sessions are never split). -1 when not listed. */
    pageOfRun(ordered, traceId, flat, size) {
        size = size || this.PAGE_SIZE;
        if (flat) {
            const i = (ordered || []).findIndex(r => r.trace_id === traceId);
            return i < 0 ? -1 : Math.floor(i / size);
        }
        const gi = this.groupBySession(ordered || []).findIndex(g => g.runs.some(r => r.trace_id === traceId));
        return gi < 0 ? -1 : Math.floor(gi / size);
    },

    /** One-shot handoff between pages: read a pending target and clear it,
     *  so it is consumed exactly once. */
    takeOnce(holder, prop) {
        if (!holder) return null;
        const v = holder[prop] == null ? null : holder[prop];
        holder[prop] = null;
        return v;
    },

    /** Coverage badge text for a runtime: "partial · N paths not checked",
     *  "not enforced · recorded after the call", or "enforced before the call". */
    coverageLabel(entry) {
        if (!entry) return 'not enforced · not checked';
        if (entry.label) return entry.label;
        if (entry.enforced === 'after_call') return 'not enforced · recorded after the call';
        if (entry.enforced !== 'before_call') return 'not enforced · not checked';
        const n = (entry.unchecked || []).length;
        if (!n) return 'enforced before the call';
        return `partial · ${n} path${n === 1 ? '' : 's'} not checked`;
    },

    coverageFor(kind, ctx) {
        const table = ctx && ctx.coverage;
        if (!table) return null;
        return table[kind] || null;
    },

    /** Saved views, per viewer, in this browser only. Storage can be absent
     *  or throw (private window, blocked site data); that reads as none. */
    loadViews(storage) {
        try {
            const st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
            if (!st) return [];
            const v = JSON.parse(st.getItem(this.VIEWS_KEY) || '[]');
            return Array.isArray(v) ? v.filter(x => x && typeof x.name === 'string' && x.filters) : [];
        } catch (_) { return []; }
    },

    saveView(name, state, storage) {
        const nm = String(name || '').trim().slice(0, 40);
        if (!nm) return false;
        const views = this.loadViews(storage).filter(v => v.name !== nm);
        views.push({ name: nm, filters: JSON.parse(JSON.stringify(state)) });
        try {
            const st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
            if (!st) return false;
            st.setItem(this.VIEWS_KEY, JSON.stringify(views.slice(-20)));
            return true;
        } catch (_) { return false; }
    },

    deleteView(name, storage) {
        const views = this.loadViews(storage).filter(v => v.name !== name);
        try {
            const st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
            if (st) st.setItem(this.VIEWS_KEY, JSON.stringify(views));
        } catch (_) { /* nothing saved, nothing lost */ }
    },

    /** Bucketed values for a sparkline across the range. agg: sum | count | p95. */
    buckets(runs, rangeKey, now, valueFn, agg) {
        const rg = this.RANGES[rangeKey] || this.RANGES['24h'];
        const n = Math.max(1, Math.min(720, Math.round(rg.ms / rg.bucket)));
        const start = now - n * rg.bucket;
        const bins = Array.from({ length: n }, () => []);
        runs.forEach(r => {
            const t = this.ms(r.started_at) || this.ms(r.ended_at);
            if (!t || t < start) return;
            const i = Math.min(n - 1, Math.floor((t - start) / rg.bucket));
            const v = valueFn(r);
            if (v != null) bins[i].push(v);
        });
        return bins.map(b => agg === 'count' ? b.length : agg === 'p95' ? this.p95(b) : b.reduce((a, x) => a + x, 0));
    },

    p95(values) {
        const v = (values || []).filter(x => typeof x === 'number' && isFinite(x)).sort((a, b) => a - b);
        if (!v.length) return 0;
        return v[Math.min(v.length - 1, Math.ceil(0.95 * v.length) - 1)];
    },
};
window.RunsList = RunsList;
