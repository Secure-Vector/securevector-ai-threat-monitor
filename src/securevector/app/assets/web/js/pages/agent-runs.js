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

// Keep in sync with agent-map.js HARNESS_FIXED so a harness reads the same
// colour on the Map and in Runs: claude-code orange, codex blue, openclaw red.
const RUNTIME_COLOR = {
    'claude-code': '#fba35a', codex: '#3b82f6', openclaw: '#ef4444',
    langchain: '#06b6d4', langgraph: '#0ea5e9', crewai: '#0d9488',
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
    runtimeFilter: null,   // active "only this runtime" filter (from a Map agent-node click)
    _pendingRuntime: null, // one-shot runtime filter handed off by the Map; consumed on render
    _pendingKinds: null,   // one-shot built-in/external filter handed off by a Map tool-node click
    _pendingTrace: null,   // one-shot: open THIS exact run (trace_id) from a Map agent-node click
    toolFilter: null,      // filter spans to one tool_id (from a Map tool-node click)
    _pendingTool: null,    // one-shot tool_id handed off by a Map tool-node click
    outcomeFilter: 'all',  // span verdict filter: all | allow | blocked | log_only | threat | secret

    async render(container) {
        container.textContent = '';
        // Consume one-shot filters handed off by a Map node click. A plain tab
        // navigation leaves them null → no change (avoids a stale filter sticking
        // around when the user opens Runs directly). Agent node → runtime filter;
        // tool node → tool-kind filter (gear=external, dot=built-in).
        this.runtimeFilter = this._pendingRuntime || null;
        this._pendingRuntime = null;
        if (this._pendingKinds) { this.kinds = this._pendingKinds; this._pendingKinds = null; }
        // Tool-node drill → scope the run's spans to that one tool (one-shot, so
        // a plain tab nav clears it). Resets the verdict filter to "all" so the
        // tool's own outcomes (allow AND block) all show.
        if (this._pendingTool) { this.toolFilter = this._pendingTool; this._pendingTool = null; this.outcomeFilter = 'all'; }
        else { this.toolFilter = null; }
        if (window.Header) {
            Header.setPageInfo('Agent Runs', 'Per-run trace — every tool call, turn by turn, with the tool permission applied to it. Click a step to expand its details.');
        }
        this._injectStyle();

        const header = document.createElement('div');
        header.className = 'obs-header';
        ObsTabs.render(header, 'runs');
        // "How to read runs" — sits right after the tabs, before the filter
        // cluster (which is pushed right via margin-left:auto on .filters-bar).
        const howto = ObsTabs.howToReadLink('How to read runs', 'section-read-runs', 'gs-read-runs');
        howto.style.alignSelf = 'center';
        header.appendChild(howto);
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
            /* Run cards: runtime-coloured left rail, lift on hover, accent when selected.
               flex:0 0 auto is load-bearing — the runlist is a flex column with max-height,
               so without it many runs flex-shrink every card to ~24px and crush the text. */
            .ar-run { position:relative; flex:0 0 auto; text-align:left; cursor:pointer; border:1px solid var(--border-default,#30363d); border-radius:12px;
                background:var(--bg-card,#161b22); padding:11px 13px 11px 16px; overflow:hidden;
                transition:border-color .14s,background .14s,box-shadow .14s,transform .14s; }
            .ar-run::before { content:''; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--ar-accent,#5eadb8); opacity:.5; transition:opacity .14s,width .14s; }
            .ar-run:hover { border-color:var(--accent-primary,#5eadb8); box-shadow:0 4px 14px rgba(0,0,0,.22); transform:translateY(-1px); }
            .ar-run:hover::before { opacity:.9; }
            .ar-run.sel { border-color:var(--accent-primary,#5eadb8); background:color-mix(in srgb, var(--accent-primary,#5eadb8) 9%, var(--bg-card,#161b22)); }
            .ar-run.sel::before { opacity:1; width:4px; }
            .ar-run-top { display:flex; align-items:center; gap:8px; margin-bottom:5px; }
            .ar-run-rt { font:700 13px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3); letter-spacing:.2px;
                min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            .ar-run-sub { font:600 10px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-muted,#7d8590); text-transform:lowercase;
                border:1px solid var(--border-default,#30363d); border-radius:999px; padding:1px 7px; letter-spacing:.2px; flex:0 0 auto; white-space:nowrap; }
            .ar-run-dot { width:9px; height:9px; border-radius:50%; flex:0 0 auto; box-shadow:0 0 0 3px color-mix(in srgb, var(--ar-accent,#5eadb8) 22%, transparent); }
            .ar-run-meta { font-size:11.5px; color:var(--text-secondary,#b1bac4); display:flex; gap:11px; flex-wrap:wrap; align-items:center; }
            .ar-num { font-family:ui-monospace,'JetBrains Mono','SF Mono',Menlo,monospace; font-variant-numeric:tabular-nums; color:var(--text-primary,#e6edf3); }
            .ar-blk { color:var(--danger,#ef4444); }
            .ar-risk { margin-left:auto; width:10px; height:10px; border-radius:50%; }
            .ar-det-head { display:flex; align-items:center; gap:10px; margin-bottom:3px; }
            .ar-det-title { font:700 16px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3); letter-spacing:.2px; }
            .ar-det-sub { font-size:12px; color:var(--text-secondary,#b1bac4); margin-bottom:20px; }
            .ar-sid { display:inline-flex; align-items:center; gap:6px; margin-top:6px; }
            .ar-sid code { font:600 11px ui-monospace,'JetBrains Mono',Menlo,monospace; color:var(--text-primary,#e6edf3); user-select:all; }
            .ar-copy { border:1px solid var(--border-default,#30363d); background:var(--bg-card,#161b22); color:var(--text-secondary,#b1bac4);
                border-radius:6px; padding:2px 7px; font:600 10px 'Avenir Next',Avenir,system-ui,sans-serif; cursor:pointer; }
            .ar-copy:hover { border-color:var(--accent-primary,#5eadb8); color:var(--text-primary,#e6edf3); }
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

        // Harness filter — narrow the run list to one runtime (claude-code /
        // codex / openclaw / …). Options are populated from the loaded runs in
        // _populateHarnessFilter(); stays in sync with a Map drill-down's
        // runtimeFilter.
        const hgrp = document.createElement('div');
        hgrp.className = 'filter-group';
        const hlbl = document.createElement('label');
        hlbl.textContent = 'Harness';
        hgrp.appendChild(hlbl);
        const hsel = document.createElement('select');
        hsel.className = 'filter-select';
        const allOpt = document.createElement('option');
        allOpt.value = ''; allOpt.textContent = 'All harnesses';
        hsel.appendChild(allOpt);
        hsel.addEventListener('change', () => {
            this.runtimeFilter = hsel.value || null;
            this.renderRuns();
            const shown = this._filteredRuns();
            if (shown.length) this.selectRun((shown.find(r => r.trace_id === this.selected) || shown[0]).trace_id);
            else this._detailEmpty(`No ${this.runtimeFilter} runs in this window.`, 'Pick another harness or widen the Window.');
        });
        hgrp.appendChild(hsel);
        bar.appendChild(hgrp);
        this._harnessSel = hsel;

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

        // Verdict filter — show only allowed / blocked / log-only / threat /
        // secret-touching spans. Matches the Map's Outcome filter so a tool-node
        // drill that lands here can be narrowed the same way.
        const ogrp = document.createElement('div');
        ogrp.className = 'filter-group';
        const olbl = document.createElement('label');
        olbl.textContent = 'Outcome';
        ogrp.appendChild(olbl);
        const osel = document.createElement('select');
        osel.className = 'filter-select';
        [['all', 'All'], ['allow', 'Allowed'], ['blocked', 'Blocked'], ['log_only', 'Log-only'], ['threat', 'Threats'], ['secret', 'Secret-touching']].forEach(([v, t]) => {
            const o = document.createElement('option');
            o.value = v; o.textContent = t;
            if (v === this.outcomeFilter) o.selected = true;
            osel.appendChild(o);
        });
        osel.addEventListener('change', () => { this.outcomeFilter = osel.value; if (this._trace) this.renderWaterfall(this._trace); });
        ogrp.appendChild(osel);
        bar.appendChild(ogrp);
        this._outcomeSel = osel;

        const exp = ObsTabs.exportMenu([
            { label: 'CSV', onClick: () => this._exportCSV() },
            { label: 'PDF', onClick: () => this._exportPDF() },
        ]);
        bar.appendChild(exp);
    },

    /** Does a span match the active Outcome (verdict) filter? */
    _outcomeMatch(s) {
        const f = this.outcomeFilter || 'all';
        if (f === 'all') return true;
        const act = s.action || s.outcome;
        if (f === 'allow') return s.outcome === 'allow' || act === 'allow';
        if (f === 'blocked') return s.outcome === 'blocked' || act === 'block';
        if (f === 'log_only') return s.outcome === 'log_only' || act === 'log_only';
        if (f === 'secret') return this._isSecret(s);
        if (f === 'threat') return s.outcome === 'blocked' || act === 'block' || this._isSecret(s)
            || ['delete', 'admin', 'write'].includes(String(s.risk || '').toLowerCase());
        return true;
    },
    _isSecret(s) {
        return /credential|secret|api[_ ]?key|token|password|exfil|pii/.test(String(s.reason || '').toLowerCase());
    },

    _exportCols() {
        return [
            { label: 'turn', get: s => s.turn_index },
            { label: 'tool_id', get: s => s.tool_id },
            { label: 'function', get: s => s.function_name },
            { label: 'kind', get: s => ObsTabs.isExternalTool(s.tool_id) ? 'external' : 'built-in' },
            { label: 'action', get: s => s.action },
            { label: 'tool_permission', get: s => s.verdict },
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
        const wantTrace = this._pendingTrace; this._pendingTrace = null;
        const data = await API.getTraces({ window_days: this.windowDays });
        this.runs = (data && data.runs) || [];
        this._computeAgentNums();
        this._populateHarnessFilter();
        this.renderRuns();
        const shown = this._filteredRuns();
        if (wantTrace && this.runs.some(r => r.trace_id === wantTrace)) {
            // A Map agent-node click → open that exact session's run.
            this.selectRun(wantTrace);
        } else if (wantTrace) {
            this._detailEmpty('That agent run isn’t in this window.',
                `Session ${this._esc(String(wantTrace).slice(0, 12))}… — widen the Window to load older runs.`);
        } else if (shown.length) {
            const keep = shown.find(r => r.trace_id === this.selected);
            this.selectRun((keep || shown[0]).trace_id);
        } else if (this.runtimeFilter) {
            this._detailEmpty(`No ${this.runtimeFilter} runs in this window.`, 'Clear the filter to see runs from other runtimes.');
        } else {
            this._detailEmpty('No agent runs in this window.', 'Install a Guard plugin and run an agent — each session becomes a trace here.');
        }
    },

    /** Assign each run an "agent #N" per harness, newest-first — mirrors the
     *  Agent Map's per-harness numbering so the label a user clicked on the map
     *  ("agent #2") is the same label shown here. */
    _computeAgentNums() {
        const byRt = {};
        (this.runs || []).forEach(r => { (byRt[r.runtime_kind] = byRt[r.runtime_kind] || []).push(r); });
        this._agentNum = {};
        Object.values(byRt).forEach(list => {
            list.slice()
                .sort((a, b) => String(b.ended_at || '').localeCompare(String(a.ended_at || '')))
                .forEach((r, i) => { this._agentNum[r.trace_id] = i + 1; });
        });
    },

    /** Display label for a run: custom name (set on the Map) → "agent #N" →
     *  runtime kind. The runtime is still shown as a small sub-tag alongside. */
    _agentLabel(r) {
        if (!r) return 'run';
        const nm = ObsTabs.agentName(r.trace_id);
        if (nm) return nm;
        const n = this._agentNum ? this._agentNum[r.trace_id] : null;
        return n != null ? ('agent #' + n) : (r.runtime_kind || 'run');
    },

    /** Fill the Harness dropdown with the distinct runtimes present in the
     *  loaded runs, preserving the current selection (a Map drill-down may have
     *  set runtimeFilter before the options existed). */
    _populateHarnessFilter() {
        const sel = this._harnessSel;
        if (!sel) return;
        const kinds = [...new Set((this.runs || []).map(r => r.runtime_kind).filter(Boolean))].sort();
        sel.innerHTML = '';
        const all = document.createElement('option');
        all.value = ''; all.textContent = 'All harnesses';
        sel.appendChild(all);
        kinds.forEach(k => { const o = document.createElement('option'); o.value = k; o.textContent = k; sel.appendChild(o); });
        sel.value = this.runtimeFilter || '';
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
        if (this.toolFilter) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'ar-filter-chip';
            chip.title = 'Clear tool filter';
            chip.innerHTML = `Tool <b>${this._esc(String(this.toolFilter).split(':').pop())}</b><span class="ar-chip-x">×</span>`;
            chip.addEventListener('click', () => { this.toolFilter = null; this.renderRuns(); if (this._trace) this.renderWaterfall(this._trace); });
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
            // Label leads with the custom name or "agent #N" (matching the Map);
            // the runtime/harness is always shown as a small secondary tag.
            const rtMain = `<span class="ar-run-rt">${this._esc(this._agentLabel(r))}</span>` +
                `<span class="ar-run-sub">${this._esc(r.runtime_kind)}</span>`;
            card.innerHTML =
                `<div class="ar-run-top"><span class="ar-run-dot" style="background:${color}"></span>` +
                rtMain +
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
            `<span class="ar-det-title">${this._esc(this._agentLabel(trace))}</span>` +
            `<span class="ar-run-sub">${this._esc(trace.runtime_kind)}</span>`;
        detail.appendChild(head);

        const allSpans = trace.spans || [];
        const extCount = allSpans.filter(s => ObsTabs.isExternalTool(s.tool_id)).length;
        const run = (this.runs || []).find(r => r.trace_id === trace.trace_id) || {};
        const sid = String(run.session_id || trace.trace_id || '');
        const sub = document.createElement('div');
        sub.className = 'ar-det-sub';
        sub.innerHTML = `<span class="ar-num">${trace.span_count}</span> spans · ` +
            `<span class="ar-num">${allSpans.length - extCount}</span> built-in · ` +
            `<span class="ar-num">${extCount}</span> external · ` +
            (trace.blocked ? `<span class="ar-blk">${BAN_SVG('#ef4444')} <span class="ar-num ar-blk">${trace.blocked}</span> blocked</span> · ` : '') +
            `run ${this._esc(String(trace.trace_id).slice(0, 12))}…` +
            (sid ? `<br><span class="ar-sid">session <code>${this._esc(sid)}</code><button class="ar-copy" data-copy="${this._esc(sid)}" title="Copy session id">copy</button></span>` : '');
        detail.appendChild(sub);
        const cp = sub.querySelector('.ar-copy');
        if (cp) cp.onclick = () => {
            const txt = cp.dataset.copy, done = () => { cp.textContent = 'copied'; setTimeout(() => { cp.textContent = 'copy'; }, 1200); };
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done).catch(() => {});
            else { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) { } document.body.removeChild(ta); }
        };

        // Apply the built-in / external checkbox filter, then show NEWEST first
        // (the API returns spans oldest→newest by seq; reverse for display so
        // the most recent step is at the top of every trace). .filter() already
        // returns a fresh array, so .reverse() doesn't mutate trace.spans.
        const spans = allSpans
            .filter(s => (ObsTabs.isExternalTool(s.tool_id) ? this.kinds.external : this.kinds.builtin)
                && (!this.toolFilter || s.tool_id === this.toolFilter)
                && this._outcomeMatch(s))
            .reverse();

        if (!spans.length) {
            const none = !this.kinds.builtin && !this.kinds.external;
            if (this.toolFilter || this.outcomeFilter !== 'all') {
                const what = [this.toolFilter ? this._esc(String(this.toolFilter).split(':').pop()) : '',
                this.outcomeFilter !== 'all' ? this.outcomeFilter.replace('_', '-') : ''].filter(Boolean).join(' · ');
                this._detailEmpty(`No ${what} calls in this run.`, 'Clear the Tool/Outcome filter to see the full trace.');
                return;
            }
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
            kv('Tool permission', s.verdict || (s.outcome || '').toUpperCase()) +
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
