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
    kinds: { builtin: true, external: true }, // checkbox filter for the waterfall steps
    runs: [],
    selected: null,
    runtimeFilter: null,   // active "only this runtime" filter (from a Map node click)
    _pendingRuntime: null, // one-shot filter handed off by the Map; consumed on render

    async render(container) {
        container.textContent = '';
        // Consume a one-shot runtime filter from a Map agent-node click. A plain
        // tab navigation leaves _pendingRuntime null → no filter (avoids a stale
        // filter sticking around when the user opens Runs directly).
        this.runtimeFilter = this._pendingRuntime || null;
        this._pendingRuntime = null;
        if (window.Header) {
            Header.setPageInfo('Agent Runs', 'Per-run trace — every tool call, turn by turn, with its enforcement verdict. Click a step to expand its details.');
        }
        this._injectStyle();

        const header = document.createElement('div');
        header.className = 'obs-header';
        ObsTabs.render(header, 'runs');
        const toolbar = document.createElement('div');
        toolbar.className = 'filters-bar';
        toolbar.id = 'agent-runs-toolbar';
        header.appendChild(toolbar);
        container.appendChild(header);
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
            @keyframes arFade { from { opacity:0; transform:translateY(-3px); } to { opacity:1; transform:none; } }
            .ar-layout { display:flex; gap:16px; align-items:flex-start; }
            .ar-runlist { width:308px; flex:0 0 308px; max-height:680px; overflow:auto; display:flex; flex-direction:column; gap:9px; padding:2px; }
            .ar-detail { flex:1; min-width:0; border:1px solid var(--border-default,#30363d); border-radius:14px;
                background:linear-gradient(180deg, var(--bg-card,#161b22), color-mix(in srgb, var(--bg-card,#161b22) 88%, #000)); padding:18px 20px; min-height:320px; }
            /* Run cards: runtime-coloured left rail, lift on hover, accent when selected. */
            .ar-run { position:relative; text-align:left; cursor:pointer; border:1px solid var(--border-default,#30363d); border-radius:12px;
                background:var(--bg-card,#161b22); padding:11px 13px 11px 16px; overflow:hidden;
                transition:border-color .14s,background .14s,box-shadow .14s,transform .14s; }
            .ar-run::before { content:''; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--ar-accent,#5eadb8); opacity:.5; transition:opacity .14s,width .14s; }
            .ar-run:hover { border-color:var(--accent-primary,#5eadb8); box-shadow:0 4px 14px rgba(0,0,0,.22); transform:translateY(-1px); }
            .ar-run:hover::before { opacity:.9; }
            .ar-run.sel { border-color:var(--accent-primary,#5eadb8); background:color-mix(in srgb, var(--accent-primary,#5eadb8) 9%, var(--bg-card,#161b22)); }
            .ar-run.sel::before { opacity:1; width:4px; }
            .ar-run-top { display:flex; align-items:center; gap:8px; margin-bottom:5px; }
            .ar-run-rt { font:700 13px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3); letter-spacing:.2px; }
            .ar-run-dot { width:9px; height:9px; border-radius:50%; flex:0 0 auto; box-shadow:0 0 0 3px color-mix(in srgb, var(--ar-accent,#5eadb8) 22%, transparent); }
            .ar-run-meta { font-size:11.5px; color:var(--text-secondary,#b1bac4); display:flex; gap:11px; flex-wrap:wrap; align-items:center; }
            .ar-num { font-family:ui-monospace,'JetBrains Mono','SF Mono',Menlo,monospace; font-variant-numeric:tabular-nums; color:var(--text-primary,#e6edf3); }
            .ar-blk { color:var(--danger,#ef4444); }
            .ar-risk { margin-left:auto; width:10px; height:10px; border-radius:50%; }
            .ar-det-head { display:flex; align-items:center; gap:10px; margin-bottom:3px; }
            .ar-det-title { font:700 16px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3); letter-spacing:.2px; }
            .ar-det-sub { font-size:12px; color:var(--text-secondary,#b1bac4); margin-bottom:20px; }
            /* Waterfall spine — gradient rail, glowing verdict dots. */
            .ar-span { position:relative; padding:0 0 20px 30px; }
            .ar-span::before { content:''; position:absolute; left:7px; top:16px; bottom:-3px; width:2px;
                background:linear-gradient(180deg, var(--border-default,#30363d), color-mix(in srgb, var(--border-default,#30363d) 40%, transparent)); }
            .ar-span:last-child::before { display:none; }
            .ar-span-dot { position:absolute; left:0; top:4px; width:15px; height:15px; border-radius:50%;
                border:3px solid var(--bg-card,#161b22); box-sizing:content-box; box-shadow:0 0 0 4px color-mix(in srgb, currentColor 0%, transparent); }
            .ar-span-row { display:flex; align-items:center; gap:11px; cursor:pointer; border-radius:8px;
                padding:5px 8px; margin:-5px -8px; transition:background .12s; }
            .ar-span-row:hover { background:var(--bg-hover,#21262d); }
            .ar-caret { width:13px; height:13px; flex:0 0 auto; color:var(--text-muted,#7d8590); transition:transform .14s; }
            .ar-span.open .ar-caret { transform:rotate(90deg); color:var(--accent-primary,#5eadb8); }
            .ar-span-tool { font:600 13.5px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3); }
            /* Built-in (harness) vs external (MCP/plugin) tool chip. */
            .ar-kind { font:700 9.5px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.6px; text-transform:uppercase;
                padding:2px 8px; border-radius:6px; border:1px solid var(--border-default,#30363d); color:var(--text-secondary,#b1bac4); }
            .ar-kind.ext { color:var(--accent-primary,#5eadb8); border-color:color-mix(in srgb, var(--accent-primary,#5eadb8) 55%, transparent);
                background:color-mix(in srgb, var(--accent-primary,#5eadb8) 12%, transparent); }
            /* Expandable per-step detail panel. */
            .ar-detail-body { margin-top:10px; padding:12px 14px; border:1px solid var(--border-default,#30363d);
                border-radius:10px; background:var(--bg-tertiary,#0d1117); display:none; }
            .ar-span.open .ar-detail-body { display:block; animation:arFade .16s ease-out; }
            .ar-kv { display:grid; grid-template-columns:104px 1fr; gap:6px 14px; font-size:12px; }
            .ar-kv dt { color:var(--text-muted,#7d8590); font-weight:600; }
            .ar-kv dd { margin:0; color:var(--text-primary,#e6edf3); word-break:break-word;
                font-family:ui-monospace,'JetBrains Mono','SF Mono',Menlo,monospace; }
            .ar-args { margin-top:11px; }
            .ar-args-label { font-size:10px; letter-spacing:.5px; text-transform:uppercase; color:var(--text-muted,#7d8590); margin-bottom:4px; }
            .ar-args pre { margin:0; padding:9px 11px; border-radius:8px; background:var(--bg-card,#161b22);
                border:1px solid var(--border-default,#30363d); color:var(--text-secondary,#b1bac4);
                font:11.5px ui-monospace,'JetBrains Mono','SF Mono',Menlo,monospace; white-space:pre-wrap; word-break:break-word;
                max-height:220px; overflow:auto; }
            .ar-turn { font-family:ui-monospace,'JetBrains Mono',Menlo,monospace; font-size:11px; color:var(--text-muted,#7d8590); min-width:26px; }
            .ar-badge { font:700 10px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.5px; padding:3px 9px; border-radius:20px; display:inline-flex; align-items:center; gap:4px; }
            .ar-time { margin-left:auto; font-size:11px; color:var(--text-muted,#7d8590); white-space:nowrap; font-variant-numeric:tabular-nums; }
            .ar-reason { margin-top:4px; margin-left:30px; font-size:11.5px; color:var(--text-secondary,#b1bac4); }
            .ar-reason.blk { color:var(--danger,#ef4444); }
            /* Inline reason on the span row (same line as tool/verdict). */
            .ar-reason-inline { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
                font-size:11.5px; color:var(--text-secondary,#b1bac4); }
            .ar-reason-inline.blk { color:var(--danger,#ef4444); }
            .ar-empty { padding:60px 18px; text-align:center; color:var(--text-secondary,#94a3b8); }
            /* Runtime drill-down filter chip (set by a Map agent-node click) */
            .ar-filter-chip { display:inline-flex; align-items:center; gap:7px; cursor:pointer; align-self:flex-start;
                border:1px solid var(--accent-primary,#5eadb8); border-radius:999px; padding:5px 11px; margin-bottom:3px;
                background:color-mix(in srgb, var(--accent-primary,#5eadb8) 12%, var(--bg-card,#161b22));
                color:var(--text-primary,#e6edf3); font:600 12px 'Avenir Next',Avenir,system-ui,sans-serif;
                transition:background .14s,border-color .14s; }
            .ar-filter-chip:hover { background:color-mix(in srgb, var(--accent-primary,#5eadb8) 20%, var(--bg-card,#161b22)); }
            .ar-filter-chip b { font-weight:700; }
            .ar-chip-dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; }
            .ar-chip-x { margin-left:2px; font-size:11px; color:var(--text-secondary,#b1bac4); }
            .ar-filter-chip:hover .ar-chip-x { color:var(--text-primary,#e6edf3); }
            /* Tool-kind checkbox filter */
            .ar-kind-checks { display:inline-flex; align-items:center; gap:14px; }
            .ar-check { display:inline-flex; align-items:center; gap:6px; cursor:pointer;
                font:600 12.5px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3); user-select:none; }
            .ar-check input { width:14px; height:14px; cursor:pointer; accent-color:var(--accent-primary,#5eadb8); margin:0; }
            .ar-check-dot { width:9px; height:9px; border-radius:50%; flex:0 0 auto; }
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

        // Built-in vs external filter — checkboxes so each kind toggles
        // independently (isolate external MCP calls, or hide them entirely).
        const kgrp = document.createElement('div');
        kgrp.className = 'filter-group';
        const klbl = document.createElement('label');
        klbl.textContent = 'Tool';
        kgrp.appendChild(klbl);
        const kwrap = document.createElement('div');
        kwrap.className = 'ar-kind-checks';
        [
            { key: 'builtin', label: 'Built-in', color: '#64748b' },
            { key: 'external', label: 'External MCP', color: 'var(--accent-primary,#5eadb8)' },
        ].forEach(k => {
            const lab = document.createElement('label');
            lab.className = 'ar-check';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!this.kinds[k.key];
            cb.addEventListener('change', () => {
                this.kinds[k.key] = cb.checked;
                if (this._trace) this.renderWaterfall(this._trace);
            });
            const dot = document.createElement('span');
            dot.className = 'ar-check-dot';
            dot.style.background = k.color;
            const txt = document.createElement('span');
            txt.textContent = k.label;
            lab.appendChild(cb); lab.appendChild(dot); lab.appendChild(txt);
            kwrap.appendChild(lab);
        });
        kgrp.appendChild(kwrap);
        bar.appendChild(kgrp);

        const exp = ObsTabs.exportMenu([
            { label: 'CSV', onClick: () => this._exportCSV() },
            { label: 'PDF', onClick: () => this._exportPDF() },
        ]);
        bar.appendChild(exp);
    },

    _exportCols() {
        return [
            { label: 'turn', get: s => s.turn_index },
            { label: 'tool_id', get: s => s.tool_id },
            { label: 'function', get: s => s.function_name },
            { label: 'kind', get: s => ObsTabs.isExternalTool(s.tool_id) ? 'external' : 'built-in' },
            { label: 'action', get: s => s.action },
            { label: 'verdict', get: s => s.verdict },
            { label: 'risk', get: s => s.risk },
            { label: 'called_at', get: s => s.called_at },
            { label: 'reason', get: s => s.reason },
        ];
    },
    /** Export the selected run's spans as CSV. */
    _exportCSV() {
        const t = this._trace;
        if (!t || !(t.spans || []).length) return;
        ObsTabs.download(`agent-run-${String(t.trace_id).slice(0, 8)}.csv`,
            ObsTabs.toCSV(this._exportCols(), t.spans), 'text/csv');
    },
    /** PDF = printable page with the run header + the step table. */
    _exportPDF() {
        const t = this._trace;
        if (!t || !(t.spans || []).length) return;
        const sub = `${t.runtime_kind || 'unknown'} · ${t.span_count} spans · ${t.blocked || 0} blocked · run ${String(t.trace_id).slice(0, 12)}…`;
        ObsTabs.printDoc('SecureVector — Agent Run',
            `<h1>Agent Run</h1><div class="sub">${sub}</div>` +
            ObsTabs.tableHTML(this._exportCols(), t.spans));
    },

    async loadData() {
        const list = document.getElementById('ar-runlist');
        if (list) list.innerHTML = '<div class="ar-empty">Loading runs…</div>';
        const data = await API.getTraces({ window_days: this.windowDays });
        this.runs = (data && data.runs) || [];
        this.renderRuns();
        const shown = this._filteredRuns();
        if (shown.length) {
            const keep = shown.find(r => r.trace_id === this.selected);
            this.selectRun((keep || shown[0]).trace_id);
        } else if (this.runtimeFilter) {
            this._detailEmpty(`No ${this.runtimeFilter} runs in this window.`, 'Clear the filter to see runs from other runtimes.');
        } else {
            this._detailEmpty('No agent runs in this window.', 'Install a Guard plugin and run an agent — each session becomes a trace here.');
        }
    },

    /** Runs after applying the active runtime filter (Map drill-down). */
    _filteredRuns() {
        return this.runtimeFilter
            ? this.runs.filter(r => (r.runtime_kind || '') === this.runtimeFilter)
            : this.runs;
    },

    clearRuntimeFilter() {
        this.runtimeFilter = null;
        this.renderRuns();
        const shown = this._filteredRuns();
        if (shown.length) this.selectRun((shown.find(r => r.trace_id === this.selected) || shown[0]).trace_id);
    },

    renderRuns() {
        const list = document.getElementById('ar-runlist');
        if (!list) return;
        list.textContent = '';
        // Active filter chip — clickable to clear, so the Map drill-down is reversible.
        if (this.runtimeFilter) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'ar-filter-chip';
            chip.title = 'Clear runtime filter';
            chip.innerHTML = `<span class="ar-chip-dot" style="background:${RUNTIME_COLOR[this.runtimeFilter] || '#64748b'}"></span>` +
                `Only <b>${this._esc(this.runtimeFilter)}</b><span class="ar-chip-x">×</span>`;
            chip.addEventListener('click', () => this.clearRuntimeFilter());
            list.appendChild(chip);
        }
        const shown = this._filteredRuns();
        if (!shown.length) {
            const msg = document.createElement('div');
            msg.className = 'ar-empty';
            msg.textContent = this.runtimeFilter ? `No ${this.runtimeFilter} runs.` : 'No runs.';
            list.appendChild(msg);
            return;
        }
        shown.forEach(r => {
            const card = document.createElement('button');
            card.className = 'ar-run' + (r.trace_id === this.selected ? ' sel' : '');
            card.type = 'button';
            const color = RUNTIME_COLOR[r.runtime_kind] || '#64748b';
            card.style.setProperty('--ar-accent', color);
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
        this._trace = trace;
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

        const allSpans = trace.spans || [];
        const extCount = allSpans.filter(s => ObsTabs.isExternalTool(s.tool_id)).length;
        const sub = document.createElement('div');
        sub.className = 'ar-det-sub';
        sub.innerHTML = `<span class="ar-num">${trace.span_count}</span> spans · ` +
            `<span class="ar-num">${allSpans.length - extCount}</span> built-in · ` +
            `<span class="ar-num">${extCount}</span> external · ` +
            (trace.blocked ? `<span class="ar-blk">${BAN_SVG('#ef4444')} <span class="ar-num ar-blk">${trace.blocked}</span> blocked</span> · ` : '') +
            `run ${String(trace.trace_id).slice(0, 12)}…`;
        detail.appendChild(sub);

        // Apply the built-in / external checkbox filter, then show NEWEST first
        // (the API returns spans oldest→newest by seq; reverse for display so
        // the most recent step is at the top of every trace). .filter() already
        // returns a fresh array, so .reverse() doesn't mutate trace.spans.
        const spans = allSpans
            .filter(s => ObsTabs.isExternalTool(s.tool_id) ? this.kinds.external : this.kinds.builtin)
            .reverse();

        if (!spans.length) {
            const none = !this.kinds.builtin && !this.kinds.external;
            const msg = none ? 'No tool kind selected.'
                : !this.kinds.builtin ? 'No external MCP calls in this run.'
                    : 'No built-in tool calls in this run.';
            this._detailEmpty(msg, none ? 'Tick Built-in or External MCP to show steps.' : 'Tick the other Tool checkbox to see everything.');
            return;
        }

        spans.forEach(s => {
            const o = OUTCOME[s.outcome] || OUTCOME.allow;
            const external = ObsTabs.isExternalTool(s.tool_id);
            const span = document.createElement('div');
            span.className = 'ar-span';
            const dot = `<span class="ar-span-dot" style="background:${o.color}"></span>`;
            const caret = `<svg class="ar-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`;
            const badge = `<span class="ar-badge" style="background:${o.color}22;color:${o.color}">` +
                `${s.outcome === 'blocked' ? BAN_SVG(o.color, 10) : ''}${o.label}</span>`;
            const kind = `<span class="ar-kind ${external ? 'ext' : ''}">${external ? 'External MCP' : 'Built-in'}</span>`;
            // Reason sits INLINE on the same row (truncated); full text is in the
            // expandable detail panel below.
            const reason = s.reason
                ? `<span class="ar-reason-inline ${s.outcome === 'blocked' ? 'blk' : ''}">${this._esc(s.reason)}</span>`
                : '';
            span.innerHTML = dot +
                `<div class="ar-span-row">${caret}<span class="ar-turn">#${s.turn_index ?? '–'}</span>` +
                `<span class="ar-span-tool">${this._esc(s.function_name || s.tool_id || 'tool')}</span>` +
                kind + badge + reason +
                `<span class="ar-time">${this._fmtTime(s.called_at)}</span></div>` +
                this._spanDetail(s, external);
            const row = span.querySelector('.ar-span-row');
            row.addEventListener('click', () => span.classList.toggle('open'));
            detail.appendChild(span);
        });
    },

    /** The collapsible per-step detail panel revealed when a span is clicked. */
    _spanDetail(s, external) {
        const kv = (k, v) => v ? `<dt>${k}</dt><dd>${this._esc(v)}</dd>` : '';
        const args = s.args_preview
            ? `<div class="ar-args"><div class="ar-args-label">Arguments (redacted preview)</div><pre>${this._esc(s.args_preview)}</pre></div>`
            : '';
        return `<div class="ar-detail-body">` +
            `<dl class="ar-kv">` +
            kv('Tool', s.tool_id) +
            kv('Function', s.function_name) +
            kv('Kind', external ? 'External MCP / plugin' : 'Built-in harness tool') +
            kv('Verdict', s.verdict || (s.outcome || '').toUpperCase()) +
            kv('Risk', s.risk) +
            kv('Time', this._fmtTime(s.called_at)) +
            kv('Reason', s.reason) +
            `</dl>${args}</div>`;
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
