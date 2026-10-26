/**
 * Observability > Live grid: every running session at a glance.
 *
 * Large mode shows the pinned sessions (up to six) with the same governance
 * the trace shows: tool calls allowed, waiting and blocked, egress, cost and
 * tokens, findings, score and coverage, the waiting approval and the latest
 * calls. Compact mode scales to hundreds of sessions with filter counters and
 * grouping. The rules live in js/components/live-grid-model.js.
 *
 * Tiles never approve or deny. Review opens the waiting call's span panel
 * (the same panel and decision path as the Runs inline details) in place,
 * inside that tile's panel, so many sessions are watched and acted on in one
 * pane. Open trace and Open in Runs are secondary links that leave the grid.
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
    // Call details open per tile ({ sid: { key, req, wait } }, one per
    // tile), kept across polls. Focus goes to a just-opened panel heading.
    _det: {},
    _focusDet: null,
    _raw: {},
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
        // Pinned focus opens with the pinned tiles' panels open (capped).
        if (this.st.mode === 'large') this.pins.forEach(id => { this._open = M.ensureOpen(this._open, id); });
        this.data = null; this.details = {}; this._order = null; this._waiting = null; this._missed = []; this._sig = null;
        this._paused = false; this._updatedAt = 0;
        this._det = {}; this._focusDet = null; this._raw = {};
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
        // Harness, Project and Status sit on the tab row, right aligned
        // (owner, 6.1), or fold into one "Filters · N" button when they do
        // not fit. Scope, size, grouping, views and Pause stay on row two.
        const filters = document.createElement('div');
        filters.className = 'lg-filters';
        filters.id = 'lg-filters';
        filters.setAttribute('role', 'group');
        filters.setAttribute('aria-label', 'Live grid filters');
        filters.innerHTML = this._filtersHtml();
        this._fold = (window.ObsTabs && ObsTabs.foldFilters) ? ObsTabs.foldFilters(head, filters, {
            label: 'Live grid filters',
            count: () => this._foldChips().length,
            chips: () => this._foldChips(),
            clearAll: () => { ['harness', 'project', 'status'].forEach(k => { this.st[k] = ''; }); this._resetFilterSelects(); this.paint(); },
        }) : null;
        if (!this._fold) head.appendChild(filters);
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
        // An open "Raw arguments" stays open across rebuilds.
        root.addEventListener('toggle', (ev) => {
            const t = ev.target;
            const host = t && t.matches && t.matches('details.rt-raw') && t.closest('[data-dsid]');
            if (host) this._raw[host.dataset.dsid] = t.open;
        }, true);
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
            const sig = M.signature(data, this.details, Date.now()) + '|' + this.pins.join(',') + '|' + this._open.join(',') +
                '|' + JSON.stringify(this._det) + '|' + (this.reqs || []).map(r => r && [r.id, r.status, r.expires_at].join(':')).join(',');
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
        let d, reqs;
        try {
            [[, d], reqs] = await Promise.all([this._detailOf(sid),
                API.getJitRequests ? API.getJitRequests('pending').catch(() => null) : Promise.resolve(null)]);
        } finally { delete this._inflight[sid]; }
        if (mine !== this._oneSeq[sid] || !this._mounted() || !this._open.includes(sid)) return;
        if (reqs && reqs.items) this.reqs = reqs.items;
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
        // Pinned focus only while something is pinned; the last unpin falls
        // back to the grid.
        this.st = M.viewFor(this.st, this.pins).st;
        const st = this.st;
        this._syncToolbar(all);
        const pinSet = new Set(this.pins);
        const scoped = st.scope === 'pinned' ? all.filter(s => pinSet.has(s.session_id)) : all;
        const shown = M.filter(scoped, st);
        this._panels = this._buildPanels(all);
        let html = '';
        const now = Date.now();
        if (st.mode === 'large') {
            // Pinned focus: the pinned sessions as larger tiles, in pin order,
            // each with the same full-row panel under its row as the grid.
            const bySid = new Map(all.map(s => [s.session_id, s]));
            const c = this.data && this.data.counters;
            const cut = !!(c && all.length < (c.running || 0));
            const rows = this.pins.map(sid => bySid.get(sid) || { session_id: sid, _gone: cut ? 'outside' : 'ended' });
            html += M.compactHtml([{ key: 'all', sessions: rows }], { group: 'none', focus: true, pins: this.pins, open: this._open,
                details: this.details, panels: this._panels || {}, now, emptyText: 'No pinned sessions.' });
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
            ? ['act', 'sid', 'key', 'gkey', 'req', 'dur'].filter(k => a.dataset[k] != null).map(k => `[data-${k}="${this._css(a.dataset[k])}"]`).join('')
            : null;
        body.innerHTML = html;
        body.querySelectorAll('[data-dsid] details.rt-raw').forEach(el => {
            const host = el.closest('[data-dsid]');
            if (host && this._raw[host.dataset.dsid]) el.open = true;
        });
        // A just-opened call's details take focus on their heading, not on
        // Deny, so a held Enter cannot repeat onto a decision.
        const fh = this._focusDet ? body.querySelector(`[data-act="det-h"][data-sid="${this._css(this._focusDet)}"]`) : null;
        if (fh) {
            this._focusDet = null;
            fh.focus({ preventScroll: true });
            try { fh.closest('.lg-det').scrollIntoView({ block: 'nearest' }); } catch (_) { /* older engines */ }
        } else if (keep) { const el = body.querySelector(keep); if (el) el.focus({ preventScroll: true }); }
        this._paintAgo();
    },

    /** Panel options per shown tile with details: call row keys and the open
     *  call's span panel. Details of tiles no longer shown are dropped. */
    _buildPanels(all) {
        const M = this.M();
        const ids = this._detailIds();
        this._det = M.detPrune(this._det, ids);
        const bySid = new Map((all || []).map(s => [s.session_id, s]));
        const out = {};
        let any = false;
        ids.forEach(sid => {
            const d = this.details[sid];
            if (!d) return;
            const p = M.panelFor(sid, d, this.reqs, this._det[sid] || null, bySid.get(sid) || null);
            if (!p) return;
            out[sid] = p;
            // Remember what resolved, so the details stay on that call after
            // its request is decided and leaves the waiting list.
            if (p.resolved && this._det[sid]) {
                const n = p.resolved.found.node;
                this._det[sid] = Object.assign({}, this._det[sid], { key: n.key, req: (n.req && n.req.id) || this._det[sid].req });
            }
            if (p.detailHtml) any = true;
        });
        if (any && window.RunTrace && RunTrace.injectStyle) RunTrace.injectStyle();
        return out;
    },

    _css(v) { return (window.CSS && CSS.escape) ? CSS.escape(String(v)) : String(v).replace(/["\\]/g, '\\$&'); },

    _compactBlock(list, all) {
        const M = this.M();
        const st = this.st;
        const c = (this.data && this.data.counters) || M.counters(all);
        // Waiting · Blocked · Quiet: one chip narrows the grid, clicking it
        // again clears it. Coverage stays as plain information.
        const strip = `<div class="lg-filterrow"><span class="lg-run-n">${M.esc(c.running || 0)} running</span>` +
            M.chipsHtml(all, st.chip || '') +
            `<span class="lg-covline">${M.esc(M.coverageLine(c))}</span></div>`;
        const groups = M.groups(list, st.group, this.data && this.data.groups);
        const grid = M.compactHtml(groups, { group: st.group, collapsed: this._collapsed, expanded: this._expanded, pins: this.pins,
            open: this._open, details: this.details, panels: this._panels || {}, now: Date.now(),
            emptyText: (all || []).length ? 'No running sessions match these filters.' : 'No sessions running right now. Sessions show here while an agent is active.' });
        const gw = { host: 'host', project: 'project', harness: 'harness' }[st.group];
        const foot = `<div class="lg-foot">${gw ? `Grouped by ${gw} · ` : ''}order holds while you watch · ` +
            `<button type="button" class="lg-link" data-act="resort">re-sort</button>` +
            `<span class="lg-foot-r">Click a tile for its recent calls and egress · pin one for Pinned focus</span></div>`;
        return strip + grid + foot;
    },

    _paintAgo() {
        const M = this.M();
        const now = Date.now();
        document.querySelectorAll('#lg-body .lg-c-ago[data-at]').forEach(t => {
            const v = t.dataset.at ? Number(t.dataset.at) : null;
            const txt = M.agoText(v, now);
            if (t.textContent !== txt) t.textContent = txt;
        });
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
        // No "Live grid" heading: the active tab names the page.
        return `<div class="lg-seg" role="group" aria-label="Scope">` +
            `<button type="button" data-act="scope" data-v="pinned" aria-pressed="${st.scope === 'pinned'}">Pinned <span id="lg-n-pinned">${this.pins.length}</span></button>` +
            `<button type="button" data-act="scope" data-v="all" aria-pressed="${st.scope === 'all'}">All running <span id="lg-n-all">0</span></button></div>` +
            this._seg('mode', [['large', 'Pinned focus'], ['compact', 'Grid']], st.mode).replace('data-v="large"', `data-v="large"${this.pins.length ? '' : ' hidden'}`) +
            sel('lg-group', 'Group', [['host', 'Host'], ['project', 'Project'], ['harness', 'Harness'], ['none', 'None']]
                .map(([v, l]) => `<option value="${v}"${st.group === v ? ' selected' : ''}>${l}</option>`).join('')) +
            `<div class="lg-views"><button type="button" class="lg-btn" data-act="views" aria-expanded="false" aria-haspopup="true">Views ▾</button>` +
            `<div class="lg-views-menu" id="lg-views-menu" hidden></div></div>` +
            `<span class="lg-live"><span class="lg-dot live" aria-hidden="true"></span><span id="lg-ago" aria-live="off">Live · loading</span></span>` +
            `<button type="button" class="lg-btn" data-act="pause" aria-pressed="${this._paused}">${this._paused ? 'Resume' : 'Pause'}</button>`;
    },

    STATUS_OPTS: [['', 'All running'], ['waiting', 'Waiting for approval'], ['blocked', 'Blocked'], ['quiet', 'Quiet'], ['running', 'Running']],

    /** The tab-row filters: Harness, Project, Status (ids unchanged). */
    _filtersHtml() {
        const st = this.st;
        const sel = (id, label, opts) => `<label class="lg-sel"><span>${label}</span><select id="${id}" data-f="${id.slice(3)}">${opts}</select></label>`;
        return sel('lg-harness', 'Harness', '<option value="">All</option>') +
            sel('lg-project', 'Project', '<option value="">All</option>') +
            sel('lg-status', 'Status', this.STATUS_OPTS
                .map(([v, l]) => `<option value="${v}"${st.status === v ? ' selected' : ''}>${l}</option>`).join(''));
    },

    /** Active tab-row filters as removable chips for the Filters popover. */
    _foldChips() {
        const M = this.M();
        const st = this.st || {};
        const out = [];
        const drop = (k) => () => { this.st[k] = ''; this._resetFilterSelects(); this.paint(); };
        if (st.harness) out.push({ label: `Harness: ${M && M.harnessLabel ? M.harnessLabel(st.harness) : st.harness}`, remove: drop('harness') });
        if (st.project) out.push({ label: `Project: ${st.project}`, remove: drop('project') });
        if (st.status) out.push({ label: `Status: ${(this.STATUS_OPTS.find(o => o[0] === st.status) || [0, st.status])[1]}`, remove: drop('status') });
        return out;
    },

    /** Put the filter selects back in line with this.st after a chip goes. */
    _resetFilterSelects() {
        ['harness', 'project', 'status'].forEach(k => {
            const el = document.getElementById('lg-' + k);
            if (el) { el.value = this.st[k] || ''; if (k !== 'status') delete el.dataset.sig; }
        });
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
        document.querySelectorAll('#lg-toolbar [data-act="mode"]').forEach(b => {
            b.setAttribute('aria-pressed', String(b.dataset.v === this.st.mode));
            if (b.dataset.v === 'large') b.hidden = !this.pins.length;
        });
        if (this._fold) this._fold.refit();
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
        // Controls inside a call's span panel name their tile by the panel.
        const host = b.closest('[data-dsid]');
        const sid = b.dataset.sid || (host && host.dataset.dsid);
        if (act !== 'det-h') this._focusDet = null;
        if (act === 'det-h') {
            // The panel heading only takes focus.
        } else if (act === 'call') {
            this._det = this.M().detToggle(this._det, sid, b.dataset.key);
            this.paint();
        } else if (act === 'unpick') {
            this._det = this.M().detClose(this._det, sid);
            this.paint();
        } else if (act === 'copy') {
            if (window.RunTrace && RunTrace._copy) RunTrace._copy(b);
        } else if (act === 'approve' || act === 'deny') {
            this._decide(sid, act, b.dataset.req || null, b.dataset.dur || null);
        } else if (act === 'open-runs') {
            const ent = this._det[sid];
            this.openTrace(sid, (ent && ent.req) || null, { inRuns: true });
        } else if (act === 'scope' || act === 'mode') {
            this.st[act] = b.dataset.v;
            if (act === 'mode' && b.dataset.v === 'large' && this.pins.length) {
                // Pinned focus opens the pinned tiles' panels (capped).
                this.pins.forEach(id => { this._open = this.M().ensureOpen(this._open, id); });
                this.refresh({ force: true });
                return;
            }
            this.paint();
        } else if (act === 'chip') {
            this.st.chip = this.M().chipToggle(this.st.chip || '', b.dataset.key);
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
        } else if (act === 'expand' || act === 'peek') {
            this._open = this.M().toggleOpen(this._open, sid);
            const opening = this._open.includes(sid);
            this.paint();
            if (opening) this._loadOne(sid);
        } else if (act === 'open' || act === 'open-panel' || act === 'open-foot' || act === 'more-calls' || act === 'more-hosts') {
            this.openTrace(sid, null);
        } else if (act === 'review') {
            this.reviewInPlace(sid, b.dataset.req || null);
        } else if (act === 'views') {
            const menu = document.getElementById('lg-views-menu');
            if (!menu) return;
            if (menu.hidden) { this._paintViews(); menu.hidden = false; b.setAttribute('aria-expanded', 'true'); }
            else this._closeViews();
        } else if (act === 'view-save') {
            const inp = document.getElementById('lg-view-name');
            const V = this._viewsApi();
            const { scope, mode, harness, project, status, group, chip } = this.st;
            if (V && inp && V.saveView(inp.value, { scope, mode, harness, project, status, group, toggles: {}, chip: chip || '' })) {
                if (window.Toast) Toast.success('View saved in this browser');
                this._paintViews();
            } else if (window.Toast) Toast.error('Name the view to save it.');
        } else if (act === 'view-apply') {
            const V = this._viewsApi();
            const v = V && V.loadViews().find(x => x.name === b.dataset.name);
            if (!v) return;
            const groupChanged = v.filters.group && v.filters.group !== this.st.group;
            Object.assign(this.st, this.M().viewFilters(v.filters));
            this._closeViews();
            const bar = document.getElementById('lg-toolbar');
            if (bar) bar.innerHTML = this._toolbarHtml();
            const fl = document.getElementById('lg-filters');
            if (fl) fl.innerHTML = this._filtersHtml();
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

    /** Review, in place: the tile's panel opens (compact) with the waiting
     *  call's span details in it, the soonest-expiring one when the tile
     *  names none. It never leaves the grid. */
    reviewInPlace(sid, reqId) {
        if (!sid) return;
        const M = this.M();
        const d = this.details[sid];
        const plan = M.reviewPlan({ mode: this.st.mode, pins: this.pins, open: this._open, det: this._det },
            sid, reqId, this.reqs, d && d.gov);
        const wasOpen = this._open.includes(sid);
        this._open = plan.open;
        this._det = plan.det;
        this._focusDet = plan.focus;
        this._sig = null;
        this.paint();
        // A compact panel opened now fetches its details (and the waiting
        // list) at once, not on the next poll.
        if (!wasOpen && this._open.includes(sid)) this._loadOne(sid);
        else if (!d || !(this.reqs || []).length) this._refreshOne(sid);
    },

    /** Fetch one shown tile's details now (a large tile, or an open compact
     *  tile), through the same one-at-a-time path. */
    _refreshOne(sid) {
        if (this._open.includes(sid)) return this._loadOne(sid);
        return this.refresh({ force: true });
    },

    /** Allow or Deny one held call from a tile's span panel: the Runs inline
     *  details' path (the JIT routes, with the UI token and the app's
     *  confirmation). The request must be the one the panel shows, Allow
     *  once needs its recorded arguments, and one decision runs at a time. */
    async _decide(sid, act, reqId, duration) {
        const M = this.M();
        const RT = window.RunTrace;
        const d = this.details[sid];
        const ent = this._det[sid];
        const res = d && ent && RT ? M.detailFor(sid, d, this.reqs, ent, null) : null;
        const req = res && res.found.node.req;
        if (!req || !reqId || req.id !== reqId) return;
        if (duration === 'once' && !req.call_fingerprint) return;
        const st = RT.state(res.ctx.trace.trace_id);
        if (st.busy) return;
        st.busy = true;
        this._sig = null;
        this.paint();
        try {
            if (act === 'deny') await API.denyJitRequest(req.id, 'Denied from the Live grid span details');
            else await API.approveJitRequest(req.id, duration);
            const what = act === 'deny' ? 'Denied' : (duration === 'once' ? 'Allowed once' : 'Allowed');
            if (window.Toast) (Toast.success || Toast.info).call(Toast, `${what}: ${req.tool_id || 'the call'}, in this session only`);
        } catch (err) {
            if (window.Toast) Toast.error((err && err.message) || 'The decision did not go through');
        } finally {
            st.busy = false;
            // Focus on the panel heading, not on a decision button.
            this._focusDet = sid;
            if (this._mounted()) await this.refresh({ force: true });
            if (this._mounted()) { this._sig = null; this.paint(); }
        }
    },

    /** Leave the grid for the session's run: Open trace shows the full
     *  trace view (with a request, that call's span selected); Open in Runs
     *  opens the run in place on the Runs list at that call. Secondary
     *  links only: Review stays in the grid. */
    async openTrace(sid, reqId, opts = {}) {
        if (!sid) return;
        let tid = this.details[sid] && this.details[sid].traceId;
        if (!reqId && opts.inRuns) {
            const d = this.details[sid];
            reqId = this.M().reviewTarget(this.M().sessionReqs(sid, this.reqs, d && d.gov), sid);
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
        if (window.AgentRunsPage && opts.inRuns) {
            // Open in Runs: the run opens in place on the Runs list at its
            // waiting call, details open.
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
.lg-filters { display:flex; align-items:center; gap:8px 10px; }
.obs-fold .lg-filters .lg-sel, .lg-toolbar .lg-sel { flex-direction:row; align-items:center; gap:6px; white-space:nowrap; }
.lg-toolbar { align-items:center; }
.obs-fold-pop .lg-filters { flex-direction:column; align-items:stretch; }
.obs-fold-pop .lg-filters .lg-sel select { max-width:none; }
.lg-seg { display:inline-flex; border:1px solid var(--border-default); border-radius:8px; overflow:hidden; background:var(--bg-tertiary); }
.lg-seg button { border:0; background:transparent; color:var(--text-secondary); font:600 12.5px var(--font-body); padding:7px 11px; cursor:pointer; }
.lg-seg button + button { border-left:1px solid var(--border-default); }
.lg-seg button[aria-pressed="true"] { background:var(--bg-card); color:var(--text-primary); box-shadow:inset 0 -2px var(--accent-primary); }
.lg-seg button:focus-visible, .lg-btn:focus-visible, .lg-link:focus-visible, .lg-chip:focus-visible, .lg-rv:focus-visible, .lg-c:focus-visible, .lg-pin:focus-visible, .lg-caret:focus-visible, .lg-unpin:focus-visible { outline:2px solid var(--accent-primary); outline-offset:2px; }
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
.lg-filterrow { display:flex; flex-wrap:wrap; align-items:center; gap:6px 12px; margin:0 0 10px; font-size:12.5px; }
.lg-run-n { color:var(--text-secondary); }
.lg-chips { display:inline-flex; flex-wrap:wrap; align-items:center; gap:4px; }
.lg-chip-sep { color:var(--text-muted); }
.lg-chip { display:inline-flex; align-items:center; gap:6px; padding:3px 10px; border-radius:999px; border:1px solid var(--border-default); background:var(--bg-card); color:var(--text-primary); font:500 12.5px var(--font-body); cursor:pointer; }
.lg-chip:hover { border-color:var(--accent-primary); }
.lg-chip[aria-pressed="true"] { border-color:var(--accent-primary); background:color-mix(in srgb, var(--accent-primary) 12%, var(--bg-card)); }
.lg-chip-n { font-weight:700; font-variant-numeric:tabular-nums; }
.lg-chip.k-waiting .lg-chip-n { color:var(--warning-text); }
.lg-chip.k-blocked .lg-chip-n { color:color-mix(in srgb, var(--lg-bad) 75%, var(--text-primary)); }
.lg-covline { margin-left:auto; font-size:12px; color:var(--text-secondary); }
.lg-cgrid { display:grid; grid-template-columns:repeat(auto-fill, minmax(250px, 1fr)); grid-auto-flow:row dense; gap:8px; }
.lg-cgrid.lg-focus { grid-template-columns:repeat(auto-fill, minmax(340px, 1fr)); gap:10px; }
.lg-cw { position:relative; min-width:0; display:grid; grid-template-columns:minmax(0,1fr) 40px; grid-template-rows:1fr auto; border:1px solid var(--border-default); border-radius:6px; background:var(--bg-card); overflow:hidden; }
.lg-cw.st-waiting { border-color:color-mix(in srgb, var(--lg-warn) 55%, var(--border-default)); }
.lg-c { grid-column:1; grid-row:1; display:grid; grid-template-columns:4px minmax(0,1fr); gap:9px; align-items:stretch; padding:8px 10px 2px 0; border:0;
  background:transparent; color:var(--text-primary); font:12px var(--font-body); text-align:left; cursor:pointer; overflow:hidden; min-width:0; }
.lg-c-bar { align-self:stretch; margin:-8px 0 -2px; background:var(--accent-primary); }
.lg-c-main { display:flex; flex-direction:column; gap:3px; min-width:0; }
.lg-c-head { display:flex; align-items:baseline; gap:6px; min-width:0; padding-right:18px; }
.lg-c-h { font-weight:700; white-space:nowrap; }
.lg-c-name { font-weight:500; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
.lg-c-id { font-family:var(--font-mono); font-size:11px; color:var(--text-muted); }
.lg-c-act { font-family:var(--font-mono); font-size:11.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.lg-c-act.none { font-family:var(--font-body); color:var(--text-muted); }
.lg-c-tool { color:var(--text-secondary); }
.lg-c-tgt { color:var(--text-primary); }
.lg-c-gov { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:11.5px; }
.lg-c-rule { color:var(--text-secondary); }
.lg-c-eg { font-size:11.5px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.lg-c-eg.k-host, .lg-c-eg.k-blocked { font-family:var(--font-mono); color:var(--text-primary); }
.lg-c-eg.k-blocked { color:color-mix(in srgb, var(--lg-bad) 75%, var(--text-primary)); }
.lg-c-eg.k-off, .lg-c-eg.k-missing { color:var(--text-muted); font-style:italic; }
.lg-c-egl { font-family:var(--font-body); font-style:normal; font-size:10.5px; text-transform:uppercase; letter-spacing:.4px; color:var(--text-muted); margin-right:2px; }
.lg-c-foot { grid-column:1; grid-row:2; display:flex; align-items:center; gap:8px; padding:2px 10px 6px 13px; font-size:11px; color:var(--text-muted); min-height:22px; }
.lg-c-ago { font-variant-numeric:tabular-nums; }
.lg-c-cov { margin-left:auto; }
.lg-rv { border:1px solid var(--warning-chip-border, var(--border-default)); background:transparent; color:var(--warning-text); font:600 11.5px var(--font-body); border-radius:5px; padding:1px 9px; cursor:pointer; }
.lg-rv:hover { background:var(--bg-hover); }
.lg-exp { grid-column:2; grid-row:1 / span 2; min-height:24px; border:0; border-left:1px solid var(--border-default); background:transparent; color:var(--text-secondary); cursor:pointer; font-size:12px; padding:0; }
.lg-pin { position:absolute; top:4px; right:30px; border:0; background:transparent; color:var(--text-muted); font-size:10px; padding:2px 4px; border-radius:4px; cursor:pointer; opacity:0; }
.lg-group { margin:0 0 12px; }
.lg-ghead { display:flex; align-items:center; gap:10px; margin:0 0 6px; }
.lg-caret { border:0; background:transparent; color:var(--text-primary); font:600 13px var(--font-body); cursor:pointer; padding:3px 4px; display:inline-flex; gap:6px; }
.lg-cw:hover { border-color:var(--accent-primary); }
.lg-cw.open { border-color:var(--accent-primary); }
.lg-exp:hover, .lg-exp[aria-expanded="true"] { background:var(--bg-hover); color:var(--text-primary); }
.lg-exp { display:flex; align-items:center; justify-content:center; width:36px; color:var(--accent-primary); }
.lg-exp-ico { display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px; border-radius:50%; border:1px solid var(--accent-primary); background:var(--bg-secondary); transition:transform .15s ease, background .15s ease; }
.lg-exp:hover .lg-exp-ico { background:var(--accent-primary); color:var(--bg-primary); }
.lg-exp[aria-expanded="true"] .lg-exp-ico { transform:rotate(90deg); background:var(--accent-primary); color:var(--bg-primary); }
.lg-exp:focus-visible { outline:2px solid var(--accent-primary); outline-offset:-2px; }
.lg-c:focus-visible, .lg-cw .lg-pin:focus-visible { outline-offset:-2px; }
.lg-cx { grid-column:1 / -1; background:var(--bg-card); border:1px solid var(--accent-primary); border-radius:8px; padding:10px 14px 12px; display:flex; flex-direction:column; gap:8px; min-width:0; }
.lg-cx-head { display:flex; align-items:center; gap:8px; font-size:12.5px; }
.lg-cx-name { font-weight:600; color:var(--text-primary); }
.lg-cx-head .lg-link { margin-left:auto; }
.lg-cx-head .lg-link-2 { margin-left:0; }
.lg-link-2 { color:var(--text-secondary); font-weight:500; }
.lg-tfoot .lg-link-2 { margin-left:6px; }
.lg-calls li.lg-crow, .lg-calls li.lg-calldet { display:block; min-height:0; }
.lg-call { display:grid; grid-template-columns:58px minmax(0,1fr) auto; gap:8px; align-items:center; width:calc(100% + 8px); min-height:22px; margin:0 -4px; padding:1px 4px; border:0; border-radius:4px; background:transparent; color:inherit; font:inherit; text-align:left; cursor:pointer; }
.lg-call:hover { background:var(--bg-hover); }
.lg-call.on { background:var(--bg-hover); box-shadow:inset 2px 0 0 var(--accent-primary); }
.lg-call:focus-visible { outline:2px solid var(--accent-primary); outline-offset:1px; }
.lg-det h3:focus { outline:none; }
.lg-det h3:focus-visible { outline:2px solid var(--accent-primary); }
.lg-det { margin:4px 0 8px; padding:10px 12px; border:1px solid var(--border-default); border-radius:8px; background:var(--bg-secondary); font-size:12.5px; min-width:0; }
.lg-det .rt-cmd { white-space:pre-wrap; word-break:break-all; }
.lg-secs.has-det { grid-template-columns:1fr; }
.lg-c.st-waiting .lg-c-bar { background:var(--lg-warn); }
.lg-c.st-blocked .lg-c-bar { background:var(--lg-bad); }
.lg-c.st-quiet .lg-c-bar { background:var(--text-muted); }
.lg-c-main { display:flex; flex-direction:column; gap:2px; min-width:0; }
.lg-cw:hover .lg-pin, .lg-pin:focus-visible, .lg-cw.pinned .lg-pin { opacity:1; }
.lg-cw.pinned .lg-pin { color:var(--accent-primary); }
.lg-foot { display:flex; flex-wrap:wrap; align-items:center; gap:4px 6px; margin-top:10px; font-size:12px; color:var(--text-muted); }
.lg-foot-r { margin-left:auto; }
`;
        document.head.appendChild(s);
    },
};
window.LiveGridPage = LiveGridPage;
