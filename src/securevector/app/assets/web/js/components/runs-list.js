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

    /** Durations of finished runs only: a running run has no duration yet. */
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
    inlineRows(tree, openKeys, caps) {
        const out = [];
        const open = openKeys || {};
        // Each parent shows at most `caps[key]` children (INLINE_CAP by
        // default), in the tree's own order; the rest wait behind a "Show
        // more" row on the same guide, which takes the last-child elbow.
        const shownOf = (key, total) => Math.min(total, this.inlineCap(caps, key));
        const level = (parentKey, kids, depth, guides) => {
            const n = shownOf(parentKey, kids.length);
            const more = kids.length - n;
            for (let i = 0; i < n; i++) visit(kids[i], depth, guides, i === n - 1 && !more);
            if (more > 0) out.push({ more: true, key: `more:${parentKey}`, parentKey, depth, guides, last: true, left: more, hasKids: false, expanded: false });
        };
        const visit = (n, depth, guides, last) => {
            const kids = n.children || [];
            const expanded = !!open[n.key] && kids.length > 0;
            out.push({ node: n, key: n.key, depth, guides, last, hasKids: kids.length > 0, expanded });
            if (expanded) level(n.key, kids, depth + 1, guides.concat([!last]));
        };
        level(this.inlineRootKey(tree), (tree && tree.children) || [], 1, []);
        return out;
    },

    /** Children shown per parent before "Show more": keeps a run with
     *  thousands of calls from rendering thousands of rows. */
    INLINE_CAP: 200,

    inlineRootKey(tree) { return (tree && tree.key) || '__run__'; },

    inlineCap(caps, key) {
        const v = caps && Number(caps[key]);
        return v > 0 ? v : this.INLINE_CAP;
    },

    /** "Show 200 more · N left": one more page of children for a parent. */
    inlineShowMore(caps, key) {
        caps[key] = this.inlineCap(caps, key) + this.INLINE_CAP;
        return caps;
    },

    /** Raise the caps along a path so a span past them shows (the waiting
     *  jump). `path` is waitPath's { open: [ancestor keys], key }. Each
     *  parent's cap grows by whole pages until the next step is inside. */
    inlineReveal(tree, path, caps) {
        if (!tree || !path) return caps;
        const chain = (path.open || []).concat([path.key]);
        let parent = tree;
        let pkey = this.inlineRootKey(tree);
        for (const k of chain) {
            const kids = (parent && parent.children) || [];
            const i = kids.findIndex(c => c && c.key === k);
            if (i < 0) break;
            const cap = this.inlineCap(caps, pkey);
            if (i >= cap) caps[pkey] = Math.ceil((i + 1) / this.INLINE_CAP) * this.INLINE_CAP;
            parent = kids[i];
            pkey = k;
        }
        return caps;
    },

    /** A run this large refetches its spans on a live tick at most every
     *  INLINE_BIG_MS, so a busy run with thousands of calls stays cheap. */
    INLINE_BIG: 2000,
    INLINE_BIG_MS: 30000,

    /** What makes an open run fetch its spans again on a live refresh: its
     *  span count, and its waiting count (a decision made elsewhere). */
    inlineSig(r) {
        return `${Number((r && r.spans) || 0)}|${Number((r && r.waiting) || 0)}`;
    },

    /** On a live tick: should this open run fetch again? Yes after a failed
     *  fetch (a retry, at most once a tick since a fetch in flight blocks
     *  another), or when its signature moved. */
    inlineNeedsFetch(entry, r, now) {
        if (!entry || entry.loading) return false;
        if (entry.error) return true;
        if (!entry.trace || !r) return false;
        if (this.inlineSig(r) === entry.sig) return false;
        if (now != null && Number(r.spans || 0) >= this.INLINE_BIG && entry.fetchedAt && now - entry.fetchedAt < this.INLINE_BIG_MS) return false;
        return true;
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

    // ------------------------------------------------ summary: scope words
    /** "last 24h", "last 7 days": the window the summary counts over. */
    windowShort(rangeKey) {
        return ({ '1h': 'last hour', '24h': 'last 24h', '7d': 'last 7 days', '30d': 'last 30 days', '90d': 'last 90 days' })[rangeKey] || 'last 24h';
    },

    /** Cost across runs: "Not recorded" when no run has a model turn with a
     *  cost record, never "$0"; a measured zero stays "$0.00". */
    costText(runs) {
        const list = runs || [];
        const recorded = list.some(r => Number(r.generations || 0) > 0 || Number(r.cost || 0) > 0);
        if (!recorded) return 'Not recorded';
        const c = list.reduce((a, r) => a + Number(r.cost || 0), 0);
        return '$' + c.toFixed(2);
    },

    // ----------------------------------------- run row badge span filters
    // A run row's blocked and error badges filter its inline spans to that
    // kind. Waiting keeps its jump to the waiting call.
    SPAN_FILTERS: { blocked: 'blocked', error: 'error', waiting: 'waiting', recorded: 'recorded' },

    /** The kinds one span node is: blocked (incl. a repeat attempt), error,
     *  waiting, recorded (logged only). RT is RunTrace, TS is TraceSteps. */
    spanKinds(n, RT, TS) {
        const out = [];
        if (!n || n.kind !== 'tool') return out;
        const s = n.span || {};
        const d = RT && RT.decision ? RT.decision(n) : null;
        if (d && (d.key === 'blocked' || d.key === 'repeat')) out.push('blocked');
        if (d && d.key === 'waiting') out.push('waiting');
        if (TS && TS.isFailed ? TS.isFailed(s) : !!s.is_error) out.push('error');
        if (s.action === 'log_only') out.push('recorded');
        return out;
    },

    /** One run's span tree narrowed to `kind`: matching spans plus the
     *  parent turns on their path, as a pruned copy (keys unchanged, so the
     *  open details stay). `open` expands every kept parent so each match
     *  shows; `closed` ({key: true}) folds a parent the user folded.
     *  Returns { tree, matches, open }. */
    filterSpans(tree, kind, RT, TS, closed) {
        const open = {};
        let matches = 0;
        const shut = closed || {};
        const visit = (n) => {
            const kids = (n.children || []).map(visit).filter(Boolean);
            const hit = this.spanKinds(n, RT, TS).includes(kind);
            if (hit) matches++;
            if (!hit && !kids.length) return null;
            if (kids.length && !shut[n.key]) open[n.key] = true;
            return Object.assign({}, n, { children: kids });
        };
        const top = ((tree && tree.children) || []).map(visit).filter(Boolean);
        return { tree: Object.assign({}, tree || {}, { children: top }), matches, open };
    },

    /** Clicking a badge: the same kind again (or null) clears it. */
    nextSpanFilter(current, kind) {
        return !kind || current === kind ? null : kind;
    },

    /** Drop the filters of runs that are no longer open. */
    pruneSpanFilters(filters, open) {
        const keep = new Set(open || []);
        Object.keys(filters || {}).forEach(id => { if (!keep.has(id)) delete filters[id]; });
        return filters;
    },

    /** Median of the numbers given; 0 for none. */
    median(values) {
        const v = (values || []).filter(x => typeof x === 'number' && isFinite(x)).sort((a, b) => a - b);
        if (!v.length) return 0;
        const m = Math.floor(v.length / 2);
        return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
    },

    // ------------------------------------------------ summary line
    /** "12k" style token count, '' for none. */
    tokensText(n) {
        n = Number(n || 0);
        if (!n) return '';
        if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
        if (n >= 1e3) return Math.round(n / 1e3) + 'k';
        return String(n);
    },

    /** The one-line summary above the list, in order: runs, waiting,
     *  refused, cost and tokens (only when cost was recorded), median run
     *  (only with 2+ finished runs). Waiting and refused carry the
     *  decision filter they toggle; `pressed` when that filter is on. */
    summaryItems(shown, ctx, rangeKey, filters, fmtDur) {
        const list = shown || [];
        const sum = (k) => list.reduce((a, r) => a + Number(r[k] || 0), 0);
        const dec = (filters && filters.decision) || [];
        const waiting = sum('waiting'), blocked = sum('blocked'), tokens = sum('tokens');
        const items = [{ key: 'runs', text: `${list.length.toLocaleString()} run${list.length === 1 ? '' : 's'}` }];
        items.push({ key: 'waiting', n: waiting, text: `${waiting} waiting for approval`, tone: waiting ? 'amber' : '',
            filter: 'waiting', pressed: dec.includes('waiting') });
        items.push({ key: 'refused', n: blocked, text: `${blocked} call${blocked === 1 ? '' : 's'} refused`, tone: blocked ? 'red' : '',
            filter: 'blocked', pressed: dec.includes('blocked'),
            // Tool-policy blocks plus egress refusals of the listed runs, both
            // counted over the selected range (the server windows egress too).
            title: `tool policy + egress · listed runs · ${this.windowShort(rangeKey)}` });
        const cost = this.costText(list);
        if (cost !== 'Not recorded') {
            const tok = this.tokensText(tokens);
            items.push({ key: 'cost', text: tok ? `${cost} · ${tok} tokens` : cost });
        }
        const done = this.finishedDurations(list, ctx);
        if (done.length >= 2) {
            const med = this.median(done);
            items.push({ key: 'median', text: `median run ${fmtDur ? fmtDur(med) : Math.round(med / 1000) + 's'}` });
        }
        return items;
    },

    /** A summary button click: turn its decision filter on, or off when it
     *  is already on. Returns the filters. */
    toggleSummaryFilter(filters, key) {
        if (!filters || !Array.isArray(filters.decision) || !key) return filters;
        const i = filters.decision.indexOf(key);
        if (i >= 0) filters.decision.splice(i, 1); else filters.decision.push(key);
        return filters;
    },

    // ------------------------------------------- running session "now"
    /** What a running session is doing now, from its live row: latest
     *  activity (tool, short target, age) or "Quiet 7m"; a governance badge
     *  (Blocked N, or Governed; none while waiting, the waiting button says
     *  it); egress in the Live grid's words. LGM is LiveGridModel, RT is
     *  RunTrace. Null without a live row. `scope` ({ blocked, rangeKey })
     *  counts Blocked over the session's runs in the selected range, the
     *  same runs the summary line counts; without it the live row's own
     *  all-time count is used. */
    sessionNow(live, now, LGM, RT, scope) {
        if (!live || !LGM) return null;
        const quiet = Number(live.quiet_seconds);
        let activity = '';
        if (isFinite(quiet) && live.quiet_seconds != null && quiet > (LGM.QUIET_S || 300)) {
            activity = `Quiet ${LGM.dur(quiet)}`;
        } else {
            const g = LGM.glance ? LGM.glance(live) : { tool: '', target: '' };
            let target = String(g.target || '').replace(/\s+/g, ' ').trim();
            if (RT && RT.maskSecrets) target = String(RT.maskSecrets(target) || '');
            if (target.length > 48) target = target.slice(0, 47) + '…';
            const lc = live.last_call || {};
            const t = this.ms(lc.at) || this.ms(live.last_activity_at);
            const age = t ? `${LGM.dur(Math.max(0, ((now || Date.now()) - t) / 1000))} ago`
                : (isFinite(quiet) && live.quiet_seconds != null ? `${LGM.dur(quiet)} ago` : '');
            activity = [g.tool, target, age].filter(Boolean).join(' · ');
        }
        const scoped = !!(scope && scope.blocked != null);
        const blocked = Number((scoped ? scope.blocked : live.blocked) || 0);
        const gov = blocked > 0 ? { key: 'blocked', text: `Blocked ${blocked}` }
            : Number(live.waiting || 0) > 0 ? null
                : { key: 'governed', text: 'Governed' };
        if (gov && scoped) gov.title = `${blocked} blocked call${blocked === 1 ? '' : 's'} in this session, ${this.windowShort(scope.rangeKey)}${scope.filtered ? ' with the current filters' : ''}`;
        const es = LGM.egressState(live, null);
        // Always led by "Egress", in the Live grid's states.
        const egText = es.host ? `Egress ${es.text}`
            : ({ off: 'Egress not monitored', missing: 'Egress not synced yet', none: 'Egress none observed' })[es.key] || `Egress ${es.text}`;
        const egress = { key: es.key, text: egText };
        return { activity, quiet: activity.startsWith('Quiet '), gov, egress };
    },
};
window.RunsList = RunsList;
