/**
 * Agent Runs — active-agent-observability #142 (the trace waterfall)
 *
 * The *time* view to the Agent Map's *topology* view: a list of agent RUNS
 * (one per runtime session) and, for the selected run, the ordered SPANS —
 * each an enforced tool call stamped with its allow / block / log_only
 * verdict. "What did this agent try to do, turn by turn, and what did we
 * stop?" — the enforcement verdict on each span is the differentiator.
 *
 * Local-first, read-only. Hand-rolled DOM + SVG icons (no emoji), themed via
 * the app's CSS variables (dark + light).
 */

const RUNTIME_COLOR = {
    'claude-code': '#5eadb8', codex: '#8b5cf6', openclaw: '#6366f1',
    langchain: '#3b82f6', langgraph: '#06b6d4', crewai: '#0d9488',
};
const OUTCOME = {
    blocked: { color: '#ef4444', label: 'BLOCKED' },
    log_only: { color: '#94a3b8', label: 'LOG' },
    allow: { color: '#10b981', label: 'ALLOW' },
};
const RISK_DOT = { red: '#ef4444', amber: '#f59e0b', green: '#10b981' };
const BAN_SVG = (c, s = 11) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" style="vertical-align:-2px"><path fill="${c}" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2c1.8 0 3.5.6 4.9 1.7L5.7 16.9A8 8 0 0 1 12 4zm0 16a8 8 0 0 1-4.9-1.7L18.3 7.1A8 8 0 0 1 12 20z"/></svg>`;

const AgentRunsPage = {
    windowDays: 7,
    runs: [],
    selected: null,

    async render(container) {
        container.textContent = '';
        if (window.Header) {
            Header.setPageInfo('Agent Activity', 'Per-run trace — every tool call, turn by turn, with its enforcement verdict');
        }
        this._injectStyle();
        ObsTabs.render(container, 'runs');

        const toolbar = document.createElement('div');
        toolbar.className = 'filters-bar';
        toolbar.id = 'agent-runs-toolbar';
        container.appendChild(toolbar);
        this._buildToolbar(toolbar);

        const layout = document.createElement('div');
        layout.className = 'ar-layout';
        layout.innerHTML = '<div class="ar-runlist" id="ar-runlist"></div><div class="ar-detail" id="ar-detail"></div>';
        container.appendChild(layout);

        await this.loadData();
    },

    _injectStyle() {
        if (document.getElementById('agent-runs-style')) return;
        const st = document.createElement('style');
        st.id = 'agent-runs-style';
        st.textContent = `
            .ar-layout { display:flex; gap:14px; align-items:flex-start; }
            .ar-runlist { width:300px; flex:0 0 300px; max-height:660px; overflow:auto; display:flex; flex-direction:column; gap:8px; }
            .ar-detail { flex:1; min-width:0; border:1px solid var(--border-default,#30363d); border-radius:12px;
                background:var(--bg-card,#161b22); padding:16px 18px; min-height:300px; }
            .ar-run { text-align:left; cursor:pointer; border:1px solid var(--border-default,#30363d); border-radius:10px;
                background:var(--bg-card,#161b22); padding:10px 12px; transition:border-color .12s,background .12s; }
            .ar-run:hover { border-color:var(--accent-primary,#5eadb8); }
            .ar-run.sel { border-color:var(--accent-primary,#5eadb8); background:var(--bg-hover,#21262d); }
            .ar-run-top { display:flex; align-items:center; gap:7px; margin-bottom:4px; }
            .ar-run-rt { font-weight:600; font-size:13px; color:var(--text-primary,#e6edf3); }
            .ar-run-dot { width:9px; height:9px; border-radius:50%; flex:0 0 auto; }
            .ar-run-meta { font-size:11.5px; color:var(--text-secondary,#b1bac4); display:flex; gap:10px; flex-wrap:wrap; }
            .ar-num { font-family:ui-monospace,'JetBrains Mono','SF Mono',Menlo,monospace; font-variant-numeric:tabular-nums; color:var(--text-primary,#e6edf3); }
            .ar-blk { color:var(--danger,#ef4444); }
            .ar-risk { margin-left:auto; width:10px; height:10px; border-radius:50%; }
            .ar-det-head { display:flex; align-items:center; gap:9px; margin-bottom:2px; }
            .ar-det-title { font-weight:600; font-size:15px; color:var(--text-primary,#e6edf3); }
            .ar-det-sub { font-size:12px; color:var(--text-secondary,#b1bac4); margin-bottom:16px; }
            /* Waterfall spine */
            .ar-span { position:relative; padding:0 0 16px 26px; }
            .ar-span::before { content:''; position:absolute; left:6px; top:14px; bottom:-2px; width:2px; background:var(--border-default,#30363d); }
            .ar-span:last-child::before { display:none; }
            .ar-span-dot { position:absolute; left:0; top:4px; width:14px; height:14px; border-radius:50%;
                border:3px solid var(--bg-card,#161b22); box-sizing:content-box; }
            .ar-span-row { display:flex; align-items:center; gap:10px; }
            .ar-span-tool { font:600 13px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3); }
            .ar-turn { font-family:ui-monospace,'JetBrains Mono',Menlo,monospace; font-size:11px; color:var(--text-muted,#7d8590); }
            .ar-badge { font:600 10.5px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.4px; padding:2px 8px; border-radius:20px; display:inline-flex; align-items:center; gap:4px; }
            .ar-time { margin-left:auto; font-size:11px; color:var(--text-muted,#7d8590); white-space:nowrap; }
            .ar-reason { margin-top:3px; font-size:11.5px; color:var(--text-secondary,#b1bac4); }
            .ar-reason.blk { color:var(--danger,#ef4444); }
            .ar-empty { padding:54px 18px; text-align:center; color:var(--text-secondary,#94a3b8); }
        `;
        document.head.appendChild(st);
    },

    _buildToolbar(bar) {
        bar.textContent = '';
        const grp = document.createElement('div');
        grp.className = 'filter-group';
        const lbl = document.createElement('label');
        lbl.textContent = 'Window';
        grp.appendChild(lbl);
        const sel = document.createElement('select');
        sel.className = 'filter-select';
        [['1', '24h'], ['7', '7 days'], ['30', '30 days']].forEach(([v, t]) => {
            const o = document.createElement('option');
            o.value = v; o.textContent = t;
            if (Number(v) === this.windowDays) o.selected = true;
            sel.appendChild(o);
        });
        sel.addEventListener('change', () => { this.windowDays = Number(sel.value); this.loadData(); });
        grp.appendChild(sel);
        bar.appendChild(grp);
    },

    async loadData() {
        const list = document.getElementById('ar-runlist');
        if (list) list.innerHTML = '<div class="ar-empty">Loading runs…</div>';
        const data = await API.getTraces({ window_days: this.windowDays });
        this.runs = (data && data.runs) || [];
        this.renderRuns();
        if (this.runs.length) {
            const keep = this.runs.find(r => r.trace_id === this.selected);
            this.selectRun((keep || this.runs[0]).trace_id);
        } else {
            this._detailEmpty('No agent runs in this window.', 'Install a Guard plugin and run an agent — each session becomes a trace here.');
        }
    },

    renderRuns() {
        const list = document.getElementById('ar-runlist');
        if (!list) return;
        if (!this.runs.length) { list.innerHTML = '<div class="ar-empty">No runs.</div>'; return; }
        list.textContent = '';
        this.runs.forEach(r => {
            const card = document.createElement('button');
            card.className = 'ar-run' + (r.trace_id === this.selected ? ' sel' : '');
            card.type = 'button';
            const color = RUNTIME_COLOR[r.runtime_kind] || '#64748b';
            card.innerHTML =
                `<div class="ar-run-top"><span class="ar-run-dot" style="background:${color}"></span>` +
                `<span class="ar-run-rt">${this._esc(r.runtime_kind)}</span>` +
                `<span class="ar-risk" style="background:${RISK_DOT[r.risk] || RISK_DOT.green}" title="risk: ${r.risk}"></span></div>` +
                `<div class="ar-run-meta"><span><span class="ar-num">${r.spans}</span> spans</span>` +
                (r.blocked ? `<span class="ar-blk">${BAN_SVG('#ef4444')} <span class="ar-num ar-blk">${r.blocked}</span> blocked</span>` : '') +
                `<span>${this._fmtTime(r.ended_at)}</span></div>`;
            card.addEventListener('click', () => this.selectRun(r.trace_id));
            list.appendChild(card);
        });
    },

    async selectRun(traceId) {
        this.selected = traceId;
        document.querySelectorAll('.ar-run').forEach(el => el.classList.remove('sel'));
        this.renderRuns();
        const detail = document.getElementById('ar-detail');
        if (detail) detail.innerHTML = '<div class="ar-empty">Loading trace…</div>';
        const trace = await API.getTrace(traceId);
        if (this.selected !== traceId) return; // a newer run was clicked mid-fetch
        if (!trace) { this._detailEmpty('Trace unavailable.', ''); return; }
        this.renderWaterfall(trace);
    },

    renderWaterfall(trace) {
        const detail = document.getElementById('ar-detail');
        if (!detail) return;
        detail.textContent = '';
        const color = RUNTIME_COLOR[trace.runtime_kind] || '#64748b';

        const head = document.createElement('div');
        head.className = 'ar-det-head';
        head.innerHTML = `<span class="ar-run-dot" style="background:${color}"></span>` +
            `<span class="ar-det-title">${this._esc(trace.runtime_kind)}</span>`;
        detail.appendChild(head);

        const sub = document.createElement('div');
        sub.className = 'ar-det-sub';
        sub.innerHTML = `<span class="ar-num">${trace.span_count}</span> spans · ` +
            (trace.blocked ? `<span class="ar-blk">${BAN_SVG('#ef4444')} <span class="ar-num ar-blk">${trace.blocked}</span> blocked</span> · ` : '') +
            `run ${String(trace.trace_id).slice(0, 12)}…`;
        detail.appendChild(sub);

        const spans = trace.spans || [];
        if (!spans.length) { this._detailEmpty('No spans in this run.', ''); return; }

        spans.forEach(s => {
            const o = OUTCOME[s.outcome] || OUTCOME.allow;
            const span = document.createElement('div');
            span.className = 'ar-span';
            const dot = `<span class="ar-span-dot" style="background:${o.color}"></span>`;
            const badge = `<span class="ar-badge" style="background:${o.color}22;color:${o.color}">` +
                `${s.outcome === 'blocked' ? BAN_SVG(o.color, 10) : ''}${o.label}</span>`;
            const reason = s.reason
                ? `<div class="ar-reason ${s.outcome === 'blocked' ? 'blk' : ''}">${this._esc(s.reason)}</div>`
                : '';
            span.innerHTML = dot +
                `<div class="ar-span-row"><span class="ar-turn">#${s.turn_index ?? '–'}</span>` +
                `<span class="ar-span-tool">${this._esc(s.function_name || s.tool_id || 'tool')}</span>` +
                badge +
                `<span class="ar-time">${this._fmtTime(s.called_at)}</span></div>` +
                reason;
            detail.appendChild(span);
        });
    },

    _detailEmpty(title, sub) {
        const detail = document.getElementById('ar-detail');
        if (detail) detail.innerHTML = `<div class="ar-empty"><div style="font-size:15px;margin-bottom:6px;">${title}</div><div style="font-size:13px;">${sub}</div></div>`;
    },

    _fmtTime(iso) {
        if (!iso) return '';
        const t = String(iso).replace(' ', 'T') + (String(iso).endsWith('Z') ? '' : 'Z');
        const d = new Date(t);
        if (isNaN(d)) return String(iso);
        return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    },

    _esc(s) {
        return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    },
};

window.AgentRunsPage = AgentRunsPage;
