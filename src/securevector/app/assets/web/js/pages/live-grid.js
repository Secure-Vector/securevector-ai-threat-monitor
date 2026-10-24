/**
 * Observability > Live grid: every running session at a glance.
 *
 * Large mode shows the pinned sessions (up to six) with the same governance
 * the trace shows: tool calls allowed, waiting and blocked, egress, cost and
 * tokens, findings, score and coverage, the waiting approval and the latest
 * calls. Compact mode scales to hundreds of sessions with filter counters and
 * grouping. The rules live in js/components/live-grid-model.js.
 *
 * The grid never approves or denies. Review and Open trace hand off to the
 * Runs trace view, where the span panel holds the one decision.
 */
const LiveGridPage = {
    POLL_MS: 5000,
    st: null,
    pins: [],
    data: null,
    details: {},
    reqs: [],
    _order: null,
    _waiting: null,
    _missed: [],
    _sig: null,
    _collapsed: {},
    _expanded: {},
    // Compact tiles opened inline (tool calls and egress). Kept across
    // polls; only these, never every tile, have their details fetched.
    _open: [],
    _oneSeq: {},
    _inflight: {},
    FETCH_CAP: 6,
    _paused: false,
    _updatedAt: 0,
    _timer: null,
    _ticker: null,
    _busy: false,
    _seq: 0,

    M() { return window.LiveGridModel; },

    async render(container) {
        const M = this.M();
        this.destroy();
        this.pins = M.loadPins();
        // Pinned in Large when anything is pinned, else All running in
        // Compact. Saved views keep any other arrangement.
        this.st = M.defaults(this.pins);
        this.data = null; this.details = {}; this._order = null; this._waiting = null; this._missed = []; this._sig = null;
        this._paused = false; this._updatedAt = 0;
        if (window.Header) Header.setPageInfo('Observability: Live grid', 'Running sessions, the approvals waiting on you, and what each one is allowed to do.');
        this._injectStyle();
        container.textContent = '';
        const root = document.createElement('div');
        root.className = 'lg-root';
        root.id = 'lg-root';
        const head = document.createElement('div');
        head.className = 'obs-header';
        if (window.ObsTabs) ObsTabs.render(head, 'grid');
        root.appendChild(head);
        const bar = document.createElement('div');
        bar.className = 'lg-toolbar';
        bar.id = 'lg-toolbar';
        bar.innerHTML = this._toolbarHtml();
        root.appendChild(bar);
        const body = document.createElement('div');
        body.id = 'lg-body';
        body.innerHTML = '<div class="lg-empty">Loading running sessions…</div>';
        root.appendChild(body);
        container.appendChild(root);
        root.addEventListener('click', (ev) => this._onClick(ev));
        root.addEventListener('change', (ev) => this._onChange(ev));
        await this.refresh();
        this._timer = setInterval(() => this._tick(), this.POLL_MS);
        this._ticker = setInterval(() => this._paintAgo(), 1000);
    },

    destroy() {
        if (this._timer) clearInterval(this._timer);
        if (this._ticker) clearInterval(this._ticker);
        this._timer = null; this._ticker = null;
        this._seq++;
    },

    _mounted() { return !!document.getElementById('lg-root') && (!window.App || App.currentPage === 'live-grid'); },

    _tick() {
        if (!this._mounted()) { this.destroy(); return; }
        if (document.hidden || this._paused) return;
        this.refresh();
    },

    // ------------------------------------------------------------- data

    async refresh(opts = {}) {
        if (this._busy && !opts.force) return;
        this._busy = true;
        const seq = ++this._seq;
        try {
            const data = await API.getObservabilityLive({ group: this.st.group, limit: 500 }).catch(() => null);
            if (seq !== this._seq || !this._mounted()) return;
            if (!data) {
                if (!this.data) this._body().innerHTML = '<div class="lg-empty">Running sessions could not be loaded. Retrying.</div>';
                return;
            }
            this.data = data;
            const M = this.M();
            this._order = M.order(this._order, data.sessions || [], !!opts.resort, this._waiting);
            this._waiting = M.waitingIds(data.sessions || []);
            const complete = !(data.counters && (data.sessions || []).length < (data.counters.running || 0));
            const pr = M.prunePins(this.pins, data.sessions || [], this._missed, complete);
            this.pins = pr.pins;
            this._missed = pr.missed;
            const want = this._detailIds();
            if (want.length) await this._loadDetails(seq, want);
            else this.details = {};
            if (seq !== this._seq || !this._mounted()) return;
            this._updatedAt = Date.now();
            // Nothing new: keep the DOM (and focus) as it is.
            const sig = M.signature(data, this.details, Date.now()) + '|' + this.pins.join(',') + '|' + this._open.join(',');
            if (!opts.force && sig === this._sig) { this._paintAgo(); return; }
            this._sig = sig;
            this.paint();
        } finally {
            if (seq === this._seq) this._busy = false;
        }
    },

    /** The sessions whose details a poll fetches: the pins while Large
     *  shows them, plus the compact tiles opened inline that still run. */
    _detailIds() {
        const ids = this.st.mode === 'large' ? this.pins.slice() : [];
        const compactShown = this.st.mode === 'compact' || this.st.scope === 'all';
        if (compactShown) this.M().openToLoad(this._open, (this.data && this.data.sessions) || []).forEach(id => { if (!ids.includes(id)) ids.push(id); });
        return ids;
    },

    async _detailOf(sid) {
        const gov = await API.getSessionGovernance(sid).catch(() => null);
        const tid = gov && gov.runs && (gov.runs.trace_ids || [])[0];
        const trace = tid ? await API.getTrace(tid).catch(() => null) : null;
        return [sid, { gov, spans: (trace && trace.spans) || [], traceId: tid || null }];
    },

    /** Governance and the newest run's spans for each session in `ids`. */
    async _loadDetails(seq, ids) {
        const [reqs, ...rows] = await Promise.all([
            API.getJitRequests ? API.getJitRequests('pending').catch(() => ({ items: [] })) : Promise.resolve({ items: [] }),
            this._pool(ids || this.pins, this.FETCH_CAP, (sid) => this._detailOf(sid)),
        ]).then(([r, list]) => [r, ...list]);
        if (seq !== this._seq) return;
        this.reqs = (reqs && reqs.items) || [];
        const next = {};
        rows.forEach(([sid, d]) => { next[sid] = d; });
        // A tile opened while this poll ran keeps what its own fetch got.
        this._open.forEach(id => { if (!(id in next) && this.details[id]) next[id] = this.details[id]; });
        this.details = next;
    },

    /** Run `fn` over `ids`, at most `cap` at a time, results in order. */
    async _pool(ids, cap, fn) {
        const out = new Array(ids.length);
        let next = 0;
        const worker = async () => { while (next < ids.length) { const i = next++; out[i] = await fn(ids[i]); } };
        await Promise.all(Array.from({ length: Math.min(cap, ids.length) }, worker));
        return out;
    },

    /** One tile opened inline: fetch its details now, not on the next poll.
     *  One fetch per session at a time; a slower, older answer never
     *  overwrites a newer one. */
    async _loadOne(sid) {
        if (this._inflight[sid]) return;
        this._inflight[sid] = true;
        const mine = (this._oneSeq[sid] = (this._oneSeq[sid] || 0) + 1);
        let d;
        try { [, d] = await this._detailOf(sid); } finally { delete this._inflight[sid]; }
        if (mine !== this._oneSeq[sid] || !this._mounted() || !this._open.includes(sid)) return;
        this.details = Object.assign({}, this.details, { [sid]: d });
        this._sig = null;
        this.paint();
    },

    // ------------------------------------------------------------ paint

    _body() { return document.getElementById('lg-body') || document.createElement('div'); },

    _sessions() {
        const M = this.M();
        const all = M.arrange((this.data && this.data.sessions) || [], this._order);
        return all;
    },

    paint() {
        const M = this.M();
        const body = this._body();
        const all = this._sessions();
        const st = this.st;
        this._syncToolbar(all);
        const pinSet = new Set(this.pins);
        const scoped = st.scope === 'pinned' ? all.filter(s => pinSet.has(s.session_id)) : all;
        const shown = M.filter(scoped, st);
        let html = '';
        if (st.mode === 'large') {
            const bySid = new Map(all.map(s => [s.session_id, s]));
            const c = this.data && this.data.counters;
            const cutAt = c && all.length < (c.running || 0) ? all.length : 0;
            const now = Date.now();
            if (!this.pins.length) {
                html += '<div class="lg-empty">No pinned sessions. Pin a session from the compact view with its ◆ button, up to six.</div>';
            } else {
                html += `<div class="lg-large">${this.pins.map(sid => {
                    const d = this.details[sid] ? Object.assign({ reqs: this.reqs }, this.details[sid]) : null;
                    return M.largeTileHtml(sid, bySid.get(sid) || null, d, now, { cutAt });
                }).join('')}</div>`;
            }
            if (st.scope === 'all') {
                const rest = shown.filter(s => !pinSet.has(s.session_id));
                html += `<h3 class="lg-sub">All running</h3>` + this._compactBlock(rest, all);
            }
        } else {
            html += this._compactBlock(shown, all);
        }
        // Rebuild, then put focus back on the same control.
        const a = document.activeElement;
        const keep = a && body.contains(a) && a.dataset && a.dataset.act
            ? ['act', 'sid', 'key', 'gkey'].filter(k => a.dataset[k] != null).map(k => `[data-${k}="${this._css(a.dataset[k])}"]`).join('')
            : null;
        body.innerHTML = html;
        if (keep) { const el = body.querySelector(keep); if (el) el.focus({ preventScroll: true }); }
        this._paintAgo();
    },

    _css(v) { return (window.CSS && CSS.escape) ? CSS.escape(String(v)) : String(v).replace(/["\\]/g, '\\$&'); },

    _compactBlock(list, all) {
        const M = this.M();
        const st = this.st;
        const c = (this.data && this.data.counters) || M.counters(all);
        const cells = M.counterCells(c, all, Date.now());
        const strip = `<div class="lg-strip" role="group" aria-label="Filter by attention">` +
            `<div class="lg-strip-run"><span class="lg-strip-n">${M.esc(c.running || 0)}</span> running</div>` +
            cells.map(x => {
                const on = !!st.toggles[x.key];
                return `<button type="button" class="lg-counter k-${x.key}${on ? ' on' : ''}" data-act="toggle" data-key="${x.key}" aria-pressed="${on}">` +
                    `<span class="lg-counter-l">${M.esc(x.label)}</span><span class="lg-counter-v">${M.esc(x.value)}</span>` +
                    `<span class="lg-counter-s">${M.esc(x.sub)}${on ? ' · filtering' : ''}</span></button>`;
            }).join('') +
            `<div class="lg-covline">${M.esc(M.coverageLine(c))}</div></div>`;
        const groups = M.groups(list, st.group, this.data && this.data.groups);
        const grid = M.compactHtml(groups, { group: st.group, collapsed: this._collapsed, expanded: this._expanded, pins: this.pins,
            open: this._open, details: this.details,
            emptyText: (all || []).length ? 'No running sessions match these filters.' : 'No sessions running right now. Sessions show here while an agent is active.' });
        const gw = { host: 'host', project: 'project', harness: 'harness' }[st.group];
        const foot = `<div class="lg-foot">${gw ? `Grouped by ${gw} · ` : ''}order holds while you watch · ` +
            `<button type="button" class="lg-link" data-act="resort">re-sort</button>` +
            `<span class="lg-foot-r">Open a tile's ▸ for its tool calls and egress · pin one for the large view</span></div>`;
        return strip + grid + foot;
    },

    _paintAgo() {
        const el = document.getElementById('lg-ago');
        if (!el) return;
        if (this._paused) { el.textContent = 'Paused'; return; }
        if (!this._updatedAt) { el.textContent = 'Live · loading'; return; }
        el.textContent = `Live · updated ${Math.max(0, Math.round((Date.now() - this._updatedAt) / 1000))}s ago`;
    },

    // ---------------------------------------------------------- toolbar

    _seg(name, items, cur) {
        return `<div class="lg-seg" role="group" aria-label="${name}">${items.map(([v, l]) =>
            `<button type="button" data-act="${name}" data-v="${v}" aria-pressed="${v === cur}">${l}</button>`).join('')}</div>`;
    },

    _toolbarHtml() {
        const st = this.st;
        const sel = (id, label, opts) => `<label class="lg-sel"><span>${label}</span><select id="${id}" data-f="${id.slice(3)}">${opts}</select></label>`;
        return `<h2 class="lg-title">Live grid</h2>` +
            `<div class="lg-seg" role="group" aria-label="Scope">` +
            `<button type="button" data-act="scope" data-v="pinned" aria-pressed="${st.scope === 'pinned'}">Pinned <span id="lg-n-pinned">${this.pins.length}</span></button>` +
            `<button type="button" data-act="scope" data-v="all" aria-pressed="${st.scope === 'all'}">All running <span id="lg-n-all">0</span></button></div>` +
            this._seg('mode', [['large', 'Large'], ['compact', 'Compact']], st.mode) +
            sel('lg-harness', 'Harness', '<option value="">All</option>') +
            sel('lg-project', 'Project', '<option value="">All</option>') +
            sel('lg-status', 'Status', [['', 'All running'], ['waiting', 'Waiting for approval'], ['blocked', 'Blocked'], ['quiet', 'Quiet'], ['running', 'Running']]
                .map(([v, l]) => `<option value="${v}"${st.status === v ? ' selected' : ''}>${l}</option>`).join('')) +
            sel('lg-group', 'Group', [['host', 'Host'], ['project', 'Project'], ['harness', 'Harness'], ['none', 'None']]
                .map(([v, l]) => `<option value="${v}"${st.group === v ? ' selected' : ''}>${l}</option>`).join('')) +
            `<div class="lg-views"><button type="button" class="lg-btn" data-act="views" aria-expanded="false" aria-haspopup="true">Views ▾</button>` +
            `<div class="lg-views-menu" id="lg-views-menu" hidden></div></div>` +
            `<span class="lg-live"><span class="lg-dot live" aria-hidden="true"></span><span id="lg-ago" aria-live="off">Live · loading</span></span>` +
            `<button type="button" class="lg-btn" data-act="pause" aria-pressed="${this._paused}">${this._paused ? 'Resume' : 'Pause'}</button>`;
    },

    /** Counts and dropdown options in place, so an open select or focus is
     *  not lost on a refresh. */
    _syncToolbar(all) {
        const M = this.M();
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
        set('lg-n-pinned', this.pins.length);
        set('lg-n-all', (this.data && this.data.counters && this.data.counters.running) || all.length);
        const opts = (id, key, values, label) => {
            const el = document.getElementById(id);
            if (!el || document.activeElement === el) return;
            const cur = this.st[key] || '';
            const vals = [...new Set(values.concat(cur ? [cur] : []))].sort();
            const sig = vals.join('\u0001');
            if (el.dataset.sig === sig && el.value === cur) return;
            el.dataset.sig = sig;
            el.innerHTML = `<option value="">All ${vals.length}</option>` + vals.map(v =>
                `<option value="${M.esc(v)}"${v === cur ? ' selected' : ''}>${M.esc(label(v))}</option>`).join('');
            el.value = cur;
        };
        opts('lg-harness', 'harness', all.map(s => s.harness || 'unknown'), (v) => M.harnessLabel(v));
        opts('lg-project', 'project', all.map(s => s.project || 'unknown'), (v) => v);
        // Group by Host only once some session reports a host.
        const hostOpt = document.querySelector('#lg-group option[value="host"]');
        if (hostOpt) hostOpt.hidden = !(all.some(s => s.host) || this.st.group === 'host');
        document.querySelectorAll('#lg-toolbar [data-act="scope"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === this.st.scope)));
        document.querySelectorAll('#lg-toolbar [data-act="mode"]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === this.st.mode)));
    },

    // ------------------------------------------------------------ views

    _viewsApi() {
        const RL = window.RunsList;
        return RL ? Object.create(RL, { VIEWS_KEY: { value: this.M().VIEWS_KEY } }) : null;
    },

    _paintViews() {
        const menu = document.getElementById('lg-views-menu');
        const V = this._viewsApi();
        if (!menu || !V) return;
        const M = this.M();
        const views = V.loadViews();
        menu.innerHTML = (views.length ? views.map(v =>
            `<div class="lg-view-row"><button type="button" class="lg-view" data-act="view-apply" data-name="${M.esc(v.name)}">${M.esc(v.name)}</button>` +
            `<button type="button" class="lg-view-del" data-act="view-del" data-name="${M.esc(v.name)}" aria-label="Delete view ${M.esc(v.name)}">✕</button></div>`).join('')
            : '<div class="lg-view-none">No saved views yet.</div>') +
            `<div class="lg-view-save"><input type="text" id="lg-view-name" maxlength="40" placeholder="Name this view" aria-label="View name">` +
            `<button type="button" class="lg-btn" data-act="view-save">Save</button></div>`;
    },

    // ----------------------------------------------------------- events

    _onChange(ev) {
        const t = ev.target;
        if (!t || !t.dataset || !t.dataset.f) return;
        const f = t.dataset.f;
        this.st[f] = t.value;
        if (f === 'group') { this.refresh({ force: true }); return; }
        this.paint();
    },

    _onClick(ev) {
        const b = ev.target.closest && ev.target.closest('[data-act]');
        if (!b) {
            const menu = document.getElementById('lg-views-menu');
            if (menu && !menu.hidden && !(ev.target.closest && ev.target.closest('.lg-views'))) this._closeViews();
            return;
        }
        const act = b.dataset.act;
        const sid = b.dataset.sid;
        if (act === 'scope' || act === 'mode') {
            this.st[act] = b.dataset.v;
            if (act === 'mode' && b.dataset.v === 'large' && this.pins.length) { this.refresh({ force: true }); return; }
            this.paint();
        } else if (act === 'toggle') {
            this.st.toggles[b.dataset.key] = !this.st.toggles[b.dataset.key];
            this.paint();
        } else if (act === 'caret') {
            this._collapsed[b.dataset.gkey] = !this._collapsed[b.dataset.gkey];
            this.paint();
        } else if (act === 'showall' || act === 'showless') {
            this._expanded[b.dataset.gkey] = act === 'showall';
            this.paint();
        } else if (act === 'resort') {
            this._order = this.M().order(null, (this.data && this.data.sessions) || [], true);
            this.paint();
        } else if (act === 'pin' || act === 'unpin') {
            this.pins = this.M().togglePin(this.pins, sid);
            if (this.st.mode === 'large' || act === 'pin') { this.refresh({ force: true }); }
            this.paint();
        } else if (act === 'pause') {
            this._paused = !this._paused;
            b.setAttribute('aria-pressed', String(this._paused));
            b.textContent = this._paused ? 'Resume' : 'Pause';
            this._paintAgo();
            if (!this._paused) this.refresh({ force: true });
        } else if (act === 'expand') {
            this._open = this.M().toggleOpen(this._open, sid);
            const opening = this._open.includes(sid);
            this.paint();
            if (opening) this._loadOne(sid);
        } else if (act === 'open' || act === 'open-panel' || act === 'open-foot' || act === 'more-calls' || act === 'more-hosts') {
            this.openTrace(sid, null);
        } else if (act === 'review') {
            this.openTrace(sid, b.dataset.req || null, { atWaiting: true });
        } else if (act === 'views') {
            const menu = document.getElementById('lg-views-menu');
            if (!menu) return;
            if (menu.hidden) { this._paintViews(); menu.hidden = false; b.setAttribute('aria-expanded', 'true'); }
            else this._closeViews();
        } else if (act === 'view-save') {
            const inp = document.getElementById('lg-view-name');
            const V = this._viewsApi();
            const { scope, mode, harness, project, status, group, toggles } = this.st;
            if (V && inp && V.saveView(inp.value, { scope, mode, harness, project, status, group, toggles })) {
                if (window.Toast) Toast.success('View saved in this browser');
                this._paintViews();
            } else if (window.Toast) Toast.error('Name the view to save it.');
        } else if (act === 'view-apply') {
            const V = this._viewsApi();
            const v = V && V.loadViews().find(x => x.name === b.dataset.name);
            if (!v) return;
            const groupChanged = v.filters.group && v.filters.group !== this.st.group;
            Object.assign(this.st, v.filters, { toggles: Object.assign({}, v.filters.toggles || {}) });
            this._closeViews();
            const bar = document.getElementById('lg-toolbar');
            if (bar) bar.innerHTML = this._toolbarHtml();
            if (groupChanged || this.st.mode === 'large') this.refresh({ force: true }); else this.paint();
        } else if (act === 'view-del') {
            const V = this._viewsApi();
            if (V) V.deleteView(b.dataset.name);
            this._paintViews();
        }
    },

    _closeViews() {
        const menu = document.getElementById('lg-views-menu');
        if (menu) menu.hidden = true;
        const btn = document.querySelector('#lg-toolbar [data-act="views"]');
        if (btn) btn.setAttribute('aria-expanded', 'false');
    },

    /** Open the session's run trace on the Runs view, the same path the
     *  Runs list uses. With a request id, that held call's span is selected
     *  so the decision is made in the span panel with its full context. */
    async openTrace(sid, reqId, opts = {}) {
        if (!sid) return;
        let tid = this.details[sid] && this.details[sid].traceId;
        if (!reqId && opts.atWaiting) {
            // A compact tile names no request: the session's waiting call
            // that expires soonest.
            const ms = (t) => { const v = t ? Date.parse(t) : NaN; return isNaN(v) ? Infinity : v; };
            const w = (this.reqs || []).filter(x => x && x.session_id === sid && (!x.status || x.status === 'pending') && x.rule_source !== 'delegate')
                .sort((a, b) => ms(a.expires_at) - ms(b.expires_at));
            if (w.length) reqId = w[0].id;
        }
        if (reqId) {
            const r = (this.reqs || []).find(x => x && x.id === reqId);
            if (r && r.trace_id) tid = r.trace_id;
        }
        if (!tid) {
            const gov = await API.getSessionGovernance(sid).catch(() => null);
            tid = gov && gov.runs && (gov.runs.trace_ids || [])[0];
        }
        if (!tid) {
            if (window.Toast) Toast.info('No run recorded yet for this session. Try again in a moment.');
            return;
        }
        if (window.AgentRunsPage && opts.atWaiting) {
            // Review: the run opens in place on the Runs list at its waiting
            // call, details open, so Approve and Deny show with full context.
            AgentRunsPage._pendingWait = { traceId: tid, reqId: reqId || null };
        } else if (window.AgentRunsPage) {
            AgentRunsPage._pendingTrace = tid;
            AgentRunsPage._pendingReq = reqId || null;
        }
        if (window.Sidebar && Sidebar.navigate) Sidebar.navigate('agent-runs');
        else if (window.App) App.loadPage('agent-runs');
    },

    // ------------------------------------------------------------ style

    _injectStyle() {
        if (document.getElementById('sv-live-grid-style')) return;
        const s = document.createElement('style');
        s.id = 'sv-live-grid-style';
        s.textContent = `
.lg-root { --lg-warn: var(--warning); --lg-bad: var(--danger); padding-bottom:96px; }
.lg-toolbar { display:flex; flex-wrap:wrap; align-items:flex-end; gap:10px 12px; margin:0 0 12px; }
.lg-title { margin:0 6px 0 0; font-size:18px; color:var(--text-primary); align-self:center; }
.lg-seg { display:inline-flex; border:1px solid var(--border-default); border-radius:8px; overflow:hidden; background:var(--bg-tertiary); }
.lg-seg button { border:0; background:transparent; color:var(--text-secondary); font:600 12.5px var(--font-body); padding:7px 11px; cursor:pointer; }
.lg-seg button + button { border-left:1px solid var(--border-default); }
.lg-seg button[aria-pressed="true"] { background:var(--bg-card); color:var(--text-primary); box-shadow:inset 0 -2px var(--accent-primary); }
.lg-seg button:focus-visible, .lg-btn:focus-visible, .lg-link:focus-visible, .lg-counter:focus-visible, .lg-c:focus-visible, .lg-pin:focus-visible, .lg-caret:focus-visible, .lg-unpin:focus-visible { outline:2px solid var(--accent-primary); outline-offset:2px; }
.lg-sel { display:flex; flex-direction:column; gap:3px; font-size:11px; color:var(--text-muted); }
.lg-sel select { background:var(--bg-card); color:var(--text-primary); border:1px solid var(--border-default); border-radius:7px; padding:6px 8px; font:500 12.5px var(--font-body); max-width:180px; }
.lg-btn { border:1px solid var(--border-default); background:var(--bg-card); color:var(--text-primary); border-radius:7px; padding:7px 11px; font:600 12.5px var(--font-body); cursor:pointer; }
.lg-btn:hover { border-color:var(--accent-primary); }
.lg-views { position:relative; }
.lg-views-menu { position:absolute; z-index:40; top:calc(100% + 5px); right:0; min-width:230px; padding:6px; border-radius:9px; background:var(--bg-elevated); border:1px solid var(--border-default); box-shadow:var(--elevate-pop); }
.lg-view-row { display:flex; gap:4px; }
.lg-view { flex:1; text-align:left; border:0; background:transparent; color:var(--text-primary); padding:6px 8px; border-radius:6px; cursor:pointer; font:500 12.5px var(--font-body); }
.lg-view:hover, .lg-view-del:hover { background:var(--bg-hover); }
.lg-view-del { border:0; background:transparent; color:var(--text-muted); cursor:pointer; border-radius:6px; }
.lg-view-none { color:var(--text-muted); font-size:12px; padding:6px 8px; }
.lg-view-save { display:flex; gap:6px; margin-top:6px; border-top:1px solid var(--border-default); padding-top:6px; }
.lg-view-save input { flex:1; min-width:0; background:var(--bg-card); color:var(--text-primary); border:1px solid var(--border-default); border-radius:6px; padding:5px 7px; }
.lg-live { display:inline-flex; align-items:center; gap:6px; margin-left:auto; color:var(--text-secondary); font-size:12.5px; align-self:center; }
.lg-dot { width:8px; height:8px; border-radius:50%; display:inline-block; background:var(--text-muted); flex:0 0 auto; }
.lg-dot.live { background:var(--accent-primary); }
.lg-dot.off { background:transparent; border:1px solid var(--text-muted); }
.lg-empty { padding:28px; text-align:center; color:var(--text-secondary); background:var(--bg-card); border:1px dashed var(--border-default); border-radius:10px; }
.lg-sub { font-size:13px; color:var(--text-secondary); margin:18px 0 8px; }
/* Large tiles */
.lg-large { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:12px; }
@media (max-width: 1100px) { .lg-large { grid-template-columns:minmax(0,1fr); } }
.lg-tile { background:var(--bg-card); border:1px solid var(--border-default); border-radius:10px; padding:12px 14px; display:flex; flex-direction:column; gap:10px; min-width:0; }
.lg-tile.st-waiting { border-color:color-mix(in srgb, var(--lg-warn) 55%, var(--border-default)); }
.lg-tile.st-blocked { border-color:color-mix(in srgb, var(--lg-bad) 45%, var(--border-default)); }
.lg-thead { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:12.5px; color:var(--text-secondary); }
.lg-th-h { font-weight:700; color:var(--text-primary); }
.lg-th-p { font-weight:600; color:var(--text-primary); }
.lg-th-id { font-family:var(--font-mono); font-size:11.5px; color:var(--text-muted); }
.lg-cov { border:1px solid var(--border-light); border-radius:999px; padding:1px 8px; font-size:11px; color:var(--text-secondary); }
.lg-th-st { margin-left:auto; }
.lg-unpin { border:0; background:transparent; color:var(--text-muted); cursor:pointer; padding:2px 6px; border-radius:6px; }
.lg-unpin:hover { background:var(--bg-hover); color:var(--text-primary); }
.lg-cells { display:grid; grid-template-columns:1.4fr 1fr .8fr .8fr .8fr; gap:1px; background:var(--border-default); border:1px solid var(--border-default); border-radius:8px; overflow:hidden; }
.lg-cell { background:var(--bg-secondary); padding:8px 10px; min-width:0; }
.lg-cell-k { font-size:10.5px; text-transform:uppercase; letter-spacing:.4px; color:var(--text-muted); }
.lg-cell-v { font:700 16px var(--font-body); color:var(--text-primary); margin-top:2px; overflow-wrap:anywhere; }
.lg-cell-s { font-size:11.5px; color:var(--text-secondary); overflow-wrap:anywhere; }
.lg-cell.warn .lg-cell-s { color:var(--warning-text); }
.lg-cell.bad .lg-cell-s { color:color-mix(in srgb, var(--lg-bad) 75%, var(--text-primary)); }
.lg-banner { display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:8px; background:var(--warning-chip-bg); border:1px solid var(--warning-chip-border); color:var(--warning-text); font-size:12.5px; }
.lg-banner-txt { flex:1; min-width:0; }
.lg-banner .lg-review { border-color:var(--warning-chip-border); }
.lg-secs { display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap:10px 16px; }
.lg-sec { min-width:0; display:flex; flex-direction:column; gap:4px; }
.lg-sec-h { margin:0 0 2px; display:flex; align-items:baseline; gap:8px; font-size:10.5px; font-weight:600; text-transform:uppercase; letter-spacing:.4px; color:var(--text-muted); border-bottom:1px solid var(--border-default); padding-bottom:4px; }
.lg-sec-n { font-size:11.5px; text-transform:none; letter-spacing:0; color:var(--text-secondary); font-variant-numeric:tabular-nums; }
.lg-sec-empty { font-size:12px; color:var(--text-muted); }
.lg-more { align-self:flex-start; font-size:12px; padding:2px 0; }
.lg-calls { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:3px; font-size:12px; }
.lg-calls li { display:grid; grid-template-columns:58px minmax(0,1fr) auto; gap:8px; align-items:center; min-height:20px; }
.lg-call-tool { color:var(--text-secondary); }
.lg-call-arg { color:var(--text-primary); }
.lg-hosts { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:3px; font-size:12px; }
.lg-hosts li { display:grid; grid-template-columns:minmax(0,1fr) auto auto; gap:8px; align-items:center; min-height:20px; }
.lg-host { font-family:var(--font-mono); font-size:11.5px; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.lg-host-n { font-size:11px; color:var(--text-muted); font-variant-numeric:tabular-nums; }
.lg-call-t { font-family:var(--font-mono); font-size:11px; color:var(--text-muted); }
.lg-call-n { font-family:var(--font-mono); font-size:11.5px; color:var(--text-primary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.lg-dec { font-size:11px; color:var(--text-secondary); }
.lg-dec.waiting { color:var(--warning-text); font-weight:600; }
.lg-dec.blocked, .lg-dec.tool { color:color-mix(in srgb, var(--lg-bad) 75%, var(--text-primary)); font-weight:600; }
.lg-calls-empty { font-size:12px; color:var(--text-muted); }
.lg-tfoot { display:flex; justify-content:flex-end; }
.lg-link { border:0; background:transparent; color:var(--accent-primary); font:600 12.5px var(--font-body); cursor:pointer; padding:2px 4px; }
.lg-link:hover { text-decoration:underline; }
/* Compact */
.lg-strip { display:flex; flex-wrap:wrap; align-items:stretch; gap:8px; margin:0 0 12px; }
.lg-strip-run { display:flex; align-items:center; gap:6px; padding:0 10px; color:var(--text-secondary); font-size:13px; }
.lg-strip-n { font:700 20px var(--font-body); color:var(--text-primary); }
.lg-counter { display:flex; flex-direction:column; align-items:flex-start; gap:1px; padding:7px 12px; border-radius:8px; cursor:pointer; text-align:left;
  background:var(--bg-card); border:1px solid var(--border-default); color:var(--text-primary); font-family:var(--font-body); min-width:130px; }
.lg-counter:hover { border-color:var(--accent-primary); }
.lg-counter[aria-pressed="true"] { border-color:var(--accent-primary); box-shadow:inset 0 -2px var(--accent-primary); background:color-mix(in srgb, var(--accent-primary) 10%, var(--bg-card)); }
.lg-counter-l { font-size:11px; color:var(--text-secondary); }
.lg-counter-v { font-size:17px; font-weight:700; }
.lg-counter-s { font-size:11px; color:var(--text-muted); }
.lg-counter.k-waiting .lg-counter-v { color:var(--warning-text); }
.lg-counter.k-blocked .lg-counter-v { color:color-mix(in srgb, var(--lg-bad) 75%, var(--text-primary)); }
.lg-covline { align-self:center; margin-left:auto; font-size:12px; color:var(--text-secondary); }
.lg-group { margin:0 0 12px; }
.lg-ghead { display:flex; align-items:center; gap:10px; margin:0 0 6px; }
.lg-caret { border:0; background:transparent; color:var(--text-primary); font:600 13px var(--font-body); cursor:pointer; padding:3px 4px; display:inline-flex; gap:6px; }
.lg-cgrid { display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); grid-auto-flow:row dense; gap:6px; }
.lg-cw { position:relative; min-width:0; display:flex; border:1px solid var(--border-default); border-radius:6px; background:var(--bg-card); overflow:hidden; }
.lg-cw:hover { border-color:var(--accent-primary); }
.lg-cw.open { border-color:var(--accent-primary); }
.lg-c { flex:1 1 auto; display:grid; grid-template-columns:4px minmax(0,1fr) auto; gap:8px; align-items:center; padding:8px 10px 8px 0; border:0;
  background:transparent; color:var(--text-primary); font:12px var(--font-body); text-align:left; cursor:pointer; overflow:hidden; min-width:0; }
.lg-exp { flex:0 0 26px; min-height:24px; border:0; border-left:1px solid var(--border-default); background:transparent; color:var(--text-secondary); cursor:pointer; font-size:12px; padding:0; }
.lg-exp:hover, .lg-exp[aria-expanded="true"] { background:var(--bg-hover); color:var(--text-primary); }
.lg-exp:focus-visible { outline:2px solid var(--accent-primary); outline-offset:-2px; }
.lg-c:focus-visible, .lg-cw .lg-pin:focus-visible { outline-offset:-2px; }
.lg-cx { grid-column:1 / -1; background:var(--bg-card); border:1px solid var(--accent-primary); border-radius:8px; padding:10px 14px 12px; display:flex; flex-direction:column; gap:8px; min-width:0; }
.lg-cx-head { display:flex; align-items:center; gap:8px; font-size:12.5px; }
.lg-cx-name { font-weight:600; color:var(--text-primary); }
.lg-cx-head .lg-link { margin-left:auto; }
.lg-c-bar { align-self:stretch; margin:-8px 0; background:var(--accent-primary); }
.lg-c.st-waiting .lg-c-bar { background:var(--lg-warn); }
.lg-c.st-blocked .lg-c-bar { background:var(--lg-bad); }
.lg-c.st-quiet .lg-c-bar { background:var(--text-muted); }
.lg-c-main { display:flex; flex-direction:column; gap:2px; min-width:0; }
.lg-c-name { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; padding-right:14px; }
.lg-c-state { color:var(--text-secondary); overflow-wrap:anywhere; }
.lg-c.st-waiting .lg-c-state { color:var(--warning-text); }
.lg-c.st-blocked .lg-c-state { color:color-mix(in srgb, var(--lg-bad) 75%, var(--text-primary)); }
.lg-c.st-quiet .lg-c-state { color:var(--text-muted); }
.lg-c-sub { font-size:11px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.lg-c-score { font-size:18px; font-weight:600; color:var(--text-primary); }
.lg-c-score.none { font-size:11px; font-weight:500; color:var(--text-muted); }
.lg-pin { position:absolute; top:3px; right:30px; border:0; background:transparent; color:var(--text-muted); font-size:10px; padding:2px 4px; border-radius:4px; cursor:pointer; opacity:0; }
.lg-cw:hover .lg-pin, .lg-pin:focus-visible, .lg-cw.pinned .lg-pin { opacity:1; }
.lg-cw.pinned .lg-pin { color:var(--accent-primary); }
.lg-foot { display:flex; flex-wrap:wrap; align-items:center; gap:4px 6px; margin-top:10px; font-size:12px; color:var(--text-muted); }
.lg-foot-r { margin-left:auto; }
`;
        document.head.appendChild(s);
    },
};
window.LiveGridPage = LiveGridPage;
