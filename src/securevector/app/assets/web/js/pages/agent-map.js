/**
 * Agent Map — active-agent-observability (the hero graph), 3-layer edition.
 *
 * A multi-layer map of the agent fleet: DEVICE → HARNESS (runtime) → AGENT
 * (one node per session/run) → TOOL (built-in vs external MCP). The user picks
 * the TOPOLOGY: a radial dendrogram (hero), a tidy left→right tree, or a
 * shared-tool mesh (Sankey is parked). Edges are coloured by ENFORCEMENT
 * OUTCOME (blocked pops red), active runs animate a flowing pipeline, inactive
 * runs grey out with an "Nd inactive" note. Click ANY node for a detail card
 * that drills into Agent Runs; selecting a node focuses its connected subgraph
 * (a shared tool lights up exactly the agents reaching it — blast radius).
 *
 * Local-first, read-only. Hand-rolled SVG (no graph library), following the
 * replay.js createElementNS idiom. Backed by GET /api/graph/agent-session.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

const RISK_COLOR = { red: '#ef4444', amber: '#f59e0b', green: '#10b981' };
const OUTCOME_COLOR = { blocked: '#ef4444', log_only: '#64748b', allow: '#10b981' };
// Per-harness fills from the SecureVector brand (cool teal/blue/indigo family);
// reds/ambers/greens stay reserved for risk semantics.
// Fixed brand colours for the known harnesses (user choice): claude-code
// orange, codex blue, openclaw red. Other/unknown harnesses fall back to the
// cool palette below.
const HARNESS_FIXED = { 'claude-code': '#fba35a', 'codex': '#3b82f6', 'openclaw': '#ef4444' };
const HARNESS_PALETTE = ['#5eadb8', '#06b6d4', '#0ea5e9', '#0d9488', '#38bdf8', '#1d4ed8', '#155e75', '#8b5cf6'];
const TOOL_FILL = '#64748b';      // built-in tool — neutral slate
const TOOL_FILL_EXT = '#e08a3c';  // external MCP / plugin — warm amber gear
const GRAY = '#5b626b';           // inactive / greyed-out
const EDGE_NEUTRAL = '#586273';   // edges/flow stay neutral slate — only NODES carry harness colour
// Later of two SQLite "YYYY-MM-DD HH:MM:SS" strings (lexical compare is safe).
const maxStr = (a, b) => (!a ? b : (!b ? a : (a >= b ? a : b)));
// Mix a #rrggbb toward white (amt>0) or black (amt<0) — for gradient stops.
const shade = (hex, amt) => {
    const n = parseInt(String(hex).slice(1), 16);
    if (isNaN(n)) return hex;
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const t = amt < 0 ? 0 : 255, p = Math.abs(amt);
    r = Math.round(r + (t - r) * p); g = Math.round(g + (t - g) * p); b = Math.round(b + (t - b) * p);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
};

const GEAR_PATH = 'M19.14 12.94a7.49 7.49 0 0 0 .05-.94 7.49 7.49 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.3 7.3 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.74 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.03.31-.05.62-.05.94s.02.63.05.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .61.22l2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96a.5.5 0 0 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z';
const LOCK_PATH = 'M12 1a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5zm3 8H9V6a3 3 0 0 1 6 0z';
const BAN_PATH = 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2c1.8 0 3.5.6 4.9 1.7L5.7 16.9A8 8 0 0 1 12 4zm0 16a8 8 0 0 1-4.9-1.7L18.3 7.1A8 8 0 0 1 12 20z';
const ICON = {
    lock: (c = '#f59e0b', s = 12) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" style="vertical-align:-2px"><path fill="${c}" d="${LOCK_PATH}"/></svg>`,
    ban: (c = '#ef4444', s = 12) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" style="vertical-align:-2px"><path fill="${c}" d="${BAN_PATH}"/></svg>`,
    gear: (c = '#e08a3c', s = 12) => `<svg class="sv-spin" viewBox="0 0 24 24" width="${s}" height="${s}" style="vertical-align:-2px"><path fill="${c}" d="${GEAR_PATH}"/></svg>`,
};

const TOPOLOGIES = [
    { key: 'tree', label: 'Tree' },
    { key: 'radial', label: 'Radial' },
    { key: 'mesh', label: 'Mesh' },
    { key: 'sankey', label: 'Sankey' },
];

const AgentMapPage = {
    windowDays: 7,
    topo: 'tree',
    showInactive: false,
    outcomeFilter: 'all', // all | allow | blocked | log_only | threat
    data: { nodes: [], edges: [], truncated: false, dropped_edges: 0 },

    W: 1000,
    H: 700,
    view: { k: 1, tx: 0, ty: 0 },
    _MIN_K: 0.2,
    _MAX_K: 4,

    async render(container) {
        container.textContent = '';
        if (window.Header) {
            Header.setPageInfo('Agent Map', 'Live map of harness → agent → tool. Blocked calls pop red, secret-touching agents wear a lock — pick a topology, click any node to drill in.');
        }
        this._injectStyle();

        const header = document.createElement('div');
        header.className = 'obs-header';
        ObsTabs.render(header, 'map');
        const toolbar = document.createElement('div');
        toolbar.className = 'filters-bar';
        toolbar.id = 'agent-map-toolbar';
        header.appendChild(toolbar);
        container.appendChild(header);

        const body = document.createElement('div');
        body.id = 'agent-map-body';
        body.style.cssText = 'position:relative;width:100%;height:700px;border:1px solid var(--border-default,#30363d);border-radius:14px;overflow:hidden;' +
            'background:radial-gradient(120% 120% at 18% -5%, rgba(94,173,184,.10), transparent 50%),' +
            'radial-gradient(120% 120% at 100% 110%, rgba(99,102,241,.07), transparent 55%),' +
            'var(--bg-card,#161b22);box-shadow:inset 0 1px 0 rgba(255,255,255,.03);';
        container.appendChild(body);

        this._buildToolbar(toolbar);
        await this.loadData();
    },

    _injectStyle() {
        if (document.getElementById('agent-map-style')) return;
        const st = document.createElement('style');
        st.id = 'agent-map-style';
        st.textContent = `
            @keyframes svFlow { to { stroke-dashoffset: -16; } }
            @keyframes svPulse { 0%,100% { opacity: .5; } 50% { opacity: .95; } }
            .sv-edge-flow { stroke-dasharray: 3 11; stroke-linecap: round; animation: svFlow linear infinite; pointer-events: none; }
            .sv-edge-blocked { animation: svFlow linear infinite, svPulse 1.2s ease-in-out infinite; }
            @keyframes svGearSpin { to { transform: rotate(360deg); } }
            .sv-gear { transform-box: fill-box; transform-origin: center; animation: svGearSpin 28s linear infinite; }
            .sv-spin { transform-origin: center; animation: svGearSpin 28s linear infinite; }
            @media (prefers-reduced-motion: reduce) { .sv-edge-flow, .sv-edge-blocked, .sv-gear, .sv-spin { animation: none !important; } }
            .sv-node { cursor: grab; }
            .sv-node:active { cursor: grabbing; }
            .sv-node.sv-sel circle { stroke: var(--accent-primary,#5eadb8) !important; stroke-width: 3.4 !important; }
            .sv-node.sv-sel rect { stroke: var(--accent-primary,#5eadb8) !important; stroke-width: 2.5 !important; }
            /* Visible keyboard-focus indicator (mouse focus stays clean). */
            .sv-node:focus { outline: none; }
            .sv-node:focus-visible circle, .sv-node:focus-visible rect { stroke: var(--accent-primary,#5eadb8) !important; stroke-width: 3 !important; }
            .sv-node:focus-visible path.sv-gear { filter: drop-shadow(0 0 2px var(--accent-primary,#5eadb8)); }
            .sv-node-label { font: 600 10px 'Avenir Next','Avenir','Segoe UI Variable',system-ui,sans-serif;
                letter-spacing:.2px; pointer-events:none; user-select:none; paint-order: stroke;
                stroke: var(--bg-card,#161b22); stroke-width: 3px; }
            .sv-harness-label { font: 700 12.5px 'Avenir Next','Avenir',system-ui,sans-serif; }
            .sv-agent-label { font: 700 9px ui-monospace,'JetBrains Mono',Menlo,monospace; }
            .sv-reason { font: 500 9.5px 'Avenir Next','Avenir',system-ui,sans-serif; fill: var(--text-muted,#64748b); }
            #agent-map-body.sv-panning { cursor: grabbing; }
            /* Topology segmented control */
            .sv-seg { display:inline-flex; background:color-mix(in srgb,var(--bg-card,#161b22) 60%, #000 8%); border:1px solid var(--border-default,#30363d); border-radius:10px; padding:3px; gap:2px; }
            .sv-seg button { background:transparent; border:none; border-radius:7px; padding:6px 12px; font:600 12px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-secondary,#b1bac4); cursor:pointer; }
            .sv-seg button.on { background:color-mix(in srgb,var(--accent-primary,#5eadb8) 20%, var(--bg-card,#161b22)); color:var(--text-primary,#e6edf3); }
            .sv-seg button.soon { color:var(--text-muted,#64748b); font-style:italic; }
            .sv-seg button .tag { font-size:8.5px; font-weight:700; color:var(--text-muted,#64748b); margin-left:5px; border:1px solid var(--border-default,#30363d); border-radius:5px; padding:0 4px; vertical-align:middle; }
            /* Detail card — opens on click of ANY node (mirrors node→Runs drill-down) */
            #agent-map-card { position:absolute; top:14px; right:14px; z-index:12; width:266px; padding:14px 15px;
                border:1px solid var(--border-default,#30363d); border-radius:13px; background:color-mix(in srgb,var(--bg-card,#161b22) 97%, transparent);
                -webkit-backdrop-filter:blur(10px); backdrop-filter:blur(10px); box-shadow:0 14px 40px rgba(0,0,0,.5);
                transform:translateX(20px); opacity:0; pointer-events:none; transition:opacity .12s,transform .12s; }
            #agent-map-card.show { transform:none; opacity:1; pointer-events:auto; }
            #agent-map-card .ch { display:flex; align-items:center; gap:9px; margin-bottom:3px; }
            #agent-map-card .ch .dot { width:11px; height:11px; border-radius:50%; flex:none; }
            #agent-map-card .ch .ttl { font-weight:700; font-size:14px; color:var(--text-primary,#e6edf3); }
            #agent-map-card .typ { font-size:10.5px; letter-spacing:.4px; text-transform:uppercase; color:var(--text-muted,#7d8590); margin-bottom:11px; }
            #agent-map-card .kv { display:grid; grid-template-columns:90px 1fr; gap:5px 10px; font-size:12.5px; color:var(--text-secondary,#b1bac4); }
            #agent-map-card .kv b { color:var(--text-primary,#e6edf3); font-weight:600; word-break:break-word; }
            #agent-map-card .perm { display:inline-block; padding:1px 8px; border-radius:6px; font-size:11px; font-weight:700; }
            #agent-map-card .perm.allow { color:#10b981; background:color-mix(in srgb,#10b981 16%,transparent); }
            #agent-map-card .perm.block { color:#ef4444; background:color-mix(in srgb,#ef4444 16%,transparent); }
            #agent-map-card .perm.log { color:#f59e0b; background:color-mix(in srgb,#f59e0b 16%,transparent); }
            #agent-map-card .open { margin-top:13px; width:100%; text-align:left; background:color-mix(in srgb,var(--accent-primary,#5eadb8) 14%,var(--bg-card,#161b22));
                border:1px solid color-mix(in srgb,var(--accent-primary,#5eadb8) 40%,var(--border-default,#30363d)); color:var(--text-primary,#e6edf3); border-radius:9px; padding:9px 11px;
                font:600 12.5px 'Avenir Next',Avenir,system-ui,sans-serif; cursor:pointer; }
            #agent-map-card .open:hover { background:color-mix(in srgb,var(--accent-primary,#5eadb8) 22%,var(--bg-card,#161b22)); }
            #agent-map-card .close { position:absolute; top:11px; right:12px; width:20px; height:20px; border:none; background:transparent; color:var(--text-muted,#7d8590); font-size:16px; cursor:pointer; line-height:1; padding:0; }
            #agent-map-card .sv-sid { display:flex; align-items:center; gap:6px; min-width:0; }
            #agent-map-card .sv-sid code { font:600 10.5px ui-monospace,'JetBrains Mono',Menlo,monospace; color:var(--text-primary,#e6edf3); word-break:break-all; user-select:all; line-height:1.3; }
            #agent-map-card .sv-copy { flex:0 0 auto; border:1px solid var(--border-default,#30363d); background:var(--bg-card,#161b22); color:var(--text-secondary,#b1bac4); border-radius:6px; padding:2px 7px; font:600 10px 'Avenir Next',Avenir,system-ui,sans-serif; cursor:pointer; }
            #agent-map-card .sv-copy:hover { border-color:var(--accent-primary,#5eadb8); color:var(--text-primary,#e6edf3); }
            #agent-map-tip { position:absolute; z-index:11; pointer-events:none; max-width:260px; padding:6px 9px;
                border:1px solid var(--border-default,#30363d); border-radius:8px; background:rgba(22,27,34,.98);
                -webkit-backdrop-filter:blur(8px); backdrop-filter:blur(8px); box-shadow:0 6px 20px rgba(0,0,0,.45);
                opacity:0; transition:opacity .08s; font:12px 'Avenir Next',Avenir,system-ui,sans-serif; }
            #agent-map-tip.show { opacity:1; }
            #agent-map-tip b { display:block; font-weight:700; font-size:12.5px; color:var(--text-primary,#e6edf3); }
            #agent-map-tip span { display:block; font-size:11px; color:var(--text-secondary,#b1bac4); margin-top:2px; }
            #agent-map-tip span .blk { color:var(--danger,#ef4444); font-weight:600; }
            #agent-map-stats { position:absolute; top:12px; left:14px; z-index:4; display:flex; align-items:center;
                gap:12px; flex-wrap:wrap; max-width:54%; padding:7px 13px; border-radius:11px;
                background:color-mix(in srgb, var(--bg-card,#161b22) 78%, transparent);
                -webkit-backdrop-filter:blur(9px); backdrop-filter:blur(9px);
                border:1px solid color-mix(in srgb, var(--border-default,#30363d) 80%, transparent);
                box-shadow:0 6px 20px rgba(0,0,0,.28); pointer-events:none; font-size:11px; color:var(--text-secondary,#b1bac4); }
            .sv-stat { display:inline-flex; align-items:baseline; gap:5px; }
            .sv-stat b { font:600 12px ui-monospace,'JetBrains Mono',Menlo,monospace; font-variant-numeric:tabular-nums; color:var(--text-primary,#e6edf3); }
            .sv-stat-sep { width:1px; height:14px; background:var(--border-default,#30363d); }
            .sv-stat.is-alert, .sv-stat.is-alert b { color:var(--danger,#ef4444); }
            .sv-stat.is-watch, .sv-stat.is-watch b { color:var(--warning,#f59e0b); }
            #agent-map-legend { position:absolute; bottom:12px; left:14px; z-index:4; display:flex; align-items:center;
                flex-wrap:wrap; gap:4px 0; max-width:74%; padding:7px 13px; border-radius:11px;
                background:color-mix(in srgb, var(--bg-card,#161b22) 80%, transparent);
                -webkit-backdrop-filter:blur(9px); backdrop-filter:blur(9px);
                border:1px solid color-mix(in srgb, var(--border-default,#30363d) 80%, transparent);
                box-shadow:0 6px 20px rgba(0,0,0,.28); pointer-events:none; }
            #agent-map-legend span { display:inline-flex; align-items:center; gap:5px; margin-right:13px; font-size:11px; color:var(--text-secondary,#b1bac4); }
            #agent-map-legend i { width:15px; height:0; border-top:3px solid; display:inline-block; }
            #agent-map-legend .lg-dot { width:9px; height:9px; border:0; border-radius:50%; }
            #agent-map-legend .lg-ring { width:11px; height:11px; border-radius:50%; border:2px solid; box-sizing:border-box; }
            #agent-map-legend .lg-sep { width:1px; height:13px; padding:0; background:var(--border-default,#30363d); margin-right:13px; }
            .sv-zoom { position:absolute; bottom:12px; right:12px; display:flex; flex-direction:column; gap:6px; z-index:5; }
            .sv-zoom button { width:33px; height:33px; display:flex; align-items:center; justify-content:center;
                font-size:16px; line-height:1; border-radius:9px; cursor:pointer;
                background:color-mix(in srgb, var(--bg-card,#161b22) 78%, transparent);
                -webkit-backdrop-filter:blur(9px); backdrop-filter:blur(9px);
                color:var(--text-primary,#e2e8f0); border:1px solid color-mix(in srgb, var(--border-default,#30363d) 80%, transparent);
                box-shadow:0 4px 14px rgba(0,0,0,.25); transition:background .12s,border-color .12s,transform .1s; }
            .sv-zoom button:hover { background:var(--bg-hover,#21262d); border-color:var(--accent-primary,#5eadb8); transform:translateY(-1px); }
            .sv-hint { position:absolute; left:14px; bottom:10px; max-width:50%; font-size:11px; color:var(--text-muted,#64748b); z-index:5; user-select:none; }
            .sv-check { display:inline-flex; align-items:center; gap:6px; cursor:pointer;
                font:600 12.5px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3); user-select:none; }
            .sv-check input { width:14px; height:14px; cursor:pointer; accent-color:var(--accent-primary,#5eadb8); margin:0; }
        `;
        document.head.appendChild(st);
    },

    _buildToolbar(bar) {
        bar.textContent = '';

        // Window
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

        // Topology selector — user picks how to view the agent/tool graph.
        const tgrp = document.createElement('div');
        tgrp.className = 'filter-group';
        const tlbl = document.createElement('label');
        tlbl.textContent = 'View';
        tgrp.appendChild(tlbl);
        const seg = document.createElement('div');
        seg.className = 'sv-seg';
        TOPOLOGIES.forEach(t => {
            const b = document.createElement('button');
            b.type = 'button';
            b.dataset.topo = t.key;
            b.className = (t.key === this.topo ? 'on ' : '') + (t.soon ? 'soon' : '');
            b.innerHTML = this._esc(t.label) + (t.soon ? '<span class="tag">SOON</span>' : '');
            b.addEventListener('click', () => {
                this.topo = t.key;
                seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.topo === this.topo));
                this._closeCard();
                this.draw();
            });
            seg.appendChild(b);
        });
        tgrp.appendChild(seg);
        bar.appendChild(tgrp);

        // Show inactive sessions toggle (off by default).
        const igrp = document.createElement('div');
        igrp.className = 'filter-group';
        const ilab = document.createElement('label');
        ilab.className = 'sv-check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = this.showInactive;
        cb.addEventListener('change', () => { this.showInactive = cb.checked; this._closeCard(); this.draw(); });
        const itxt = document.createElement('span');
        itxt.textContent = 'Show inactive';
        ilab.appendChild(cb); ilab.appendChild(itxt);
        igrp.appendChild(ilab);
        bar.appendChild(igrp);

        // Outcome filter — highlight only allowed / blocked / log-only / threat
        // tool calls (dims the rest). The enforcement verdict is the thing a
        // SOC/CISO wants to isolate.
        const ogrp = document.createElement('div');
        ogrp.className = 'filter-group';
        const olbl = document.createElement('label');
        olbl.textContent = 'Outcome';
        ogrp.appendChild(olbl);
        const osel = document.createElement('select');
        osel.className = 'filter-select';
        [['all', 'All'], ['allow', 'Allowed'], ['blocked', 'Blocked'], ['log_only', 'Log-only'], ['threat', 'Threats']].forEach(([v, t]) => {
            const o = document.createElement('option');
            o.value = v; o.textContent = t;
            if (v === this.outcomeFilter) o.selected = true;
            osel.appendChild(o);
        });
        osel.addEventListener('change', () => { this.outcomeFilter = osel.value; this._closeCard(); });
        ogrp.appendChild(osel);
        bar.appendChild(ogrp);

        const exp = ObsTabs.exportMenu([
            { label: 'CSV (connections)', onClick: () => this._exportCSV() },
            { label: 'PDF', onClick: () => this._exportPDF() },
        ]);
        bar.appendChild(exp);
    },

    async loadData() {
        const body = document.getElementById('agent-map-body');
        if (body) {
            body.innerHTML = '<div class="loading" style="padding:40px;text-align:center;color:var(--text-secondary,#b1bac4);">Loading agent map…</div>';
        }
        this.data = await API.getAgentSessionGraph({ window_days: this.windowDays });
        this._assignColors();
        this.draw();
    },

    _assignColors() {
        let i = 0;
        this._harnessColor = {};
        (this.data.nodes || []).filter(n => n.kind === 'harness').forEach(n => {
            this._harnessColor[n.id] = HARNESS_FIXED[n.label] || HARNESS_PALETTE[i % HARNESS_PALETTE.length];
            i += 1;
        });
    },

    /** One vertical LIGHT→DARK gradient per harness colour (bright at the top,
     *  base in the middle, deeper at the bottom) — fills harness + agent nodes
     *  so they read like glossy 3D chips rather than flat discs. Tools stay flat. */
    _buildGradients(svg) {
        const defs = document.createElementNS(SVG_NS, 'defs');
        this._gradFill = {};
        const colors = [...new Set(Object.values(this._harnessColor || {}))];
        colors.forEach(col => {
            const id = 'svgrad-' + String(col).replace('#', '');
            const lg = document.createElementNS(SVG_NS, 'linearGradient');
            lg.setAttribute('id', id);
            lg.setAttribute('x1', '0'); lg.setAttribute('y1', '0');
            lg.setAttribute('x2', '0'); lg.setAttribute('y2', '1'); // top → bottom
            // gentle, matte gradient (small light/dark range) — not glossy
            [['0%', shade(col, 0.20)], ['55%', col], ['100%', shade(col, -0.14)]].forEach(([o, c]) => {
                const st = document.createElementNS(SVG_NS, 'stop');
                st.setAttribute('offset', o); st.setAttribute('stop-color', c);
                lg.appendChild(st);
            });
            defs.appendChild(lg);
            this._gradFill[col] = `url(#${id})`;
        });
        svg.appendChild(defs);
    },
    _fillFor(col) { return (this._gradFill && this._gradFill[col]) || col; },

    // ---------------- model preparation (device hub + inactive filter) -------

    /** Build the render model from the raw 3-layer payload: synthesize the
     *  local DEVICE hub, drop or grey inactive sessions per the toggle, and
     *  attach per-node colour / gray / idle metadata. Returns {nodes, edges}. */
    _prepare() {
        const raw = this.data || {};
        const rawNodes = raw.nodes || [];
        const rawEdges = raw.edges || [];
        const byId = {};
        rawNodes.forEach(n => { byId[n.id] = n; });

        const harnesses = rawNodes.filter(n => n.kind === 'harness');
        const sessions = rawNodes.filter(n => n.kind === 'session');
        const tools = rawNodes.filter(n => n.kind === 'tool');

        // Which sessions are visible? Active always; inactive only when toggled.
        const visSession = {};
        sessions.forEach(s => { visSession[s.id] = s.active || this.showInactive; });

        const nodes = [];
        const edges = [];

        // Device hub (one local device).
        nodes.push({ id: 'device', kind: 'device', label: 'this device' });

        harnesses.forEach(h => {
            const col = this._harnessColor[h.id] || HARNESS_PALETTE[0];
            const gray = !h.active;
            const idle = this._idleDays(h.last_used);
            nodes.push(Object.assign({}, h, {
                col, gray, idle_days: idle,
                reason: gray ? (idle != null ? `inactive · ${idle}d idle` : 'no recent activity') : null,
            }));
            edges.push({ source: 'device', target: h.id, tier: 'device-harness', col: gray ? GRAY : EDGE_NEUTRAL, op: gray ? 0.22 : 0.5, w: 1.4, flow: false });
        });

        // Which sessions touched a secret? (any of their tools tripped the
        // secret heuristic) — so the map can flag "this agent detected a leak".
        const secretSessions = new Set(tools.filter(t => t.touched_secrets).map(t => t.session_id_node));
        sessions.forEach(s => {
            if (!visSession[s.id]) return;
            const col = this._harnessColor[s.harness_id] || HARNESS_PALETTE[0];
            const gray = !s.active;
            nodes.push(Object.assign({}, s, { col: gray ? GRAY : col, baseCol: col, gray, secret: secretSessions.has(s.id) }));
        });

        tools.forEach(t => {
            if (!visSession[t.session_id_node]) return;
            const sgray = !(byId[t.session_id_node] && byId[t.session_id_node].active);
            const ext = ObsTabs.isExternalTool(t.tool_id);
            const blocked = (t.blocked || 0) > 0 && !sgray;
            nodes.push(Object.assign({}, t, { ext, gray: sgray, blocked }));
        });

        // Edges from the payload, filtered to visible endpoints.
        const visNode = {};
        nodes.forEach(n => { visNode[n.id] = true; });
        rawEdges.forEach(e => {
            if (!visNode[e.source] || !visNode[e.target]) return;
            const srcSession = byId[e.source];
            const sgray = e.tier === 'session-tool' && srcSession && !srcSession.active;
            const blocked = e.outcome === 'blocked' && !sgray;
            // Edges/flow stay neutral (only nodes carry harness colour); blocked
            // edges still pop red, inactive ones dim grey.
            edges.push(Object.assign({}, e, {
                col: blocked ? OUTCOME_COLOR.blocked : (sgray ? '#454b54' : EDGE_NEUTRAL),
                op: sgray ? 0.15 : (blocked ? 0.7 : (e.tier === 'session-tool' ? 0.4 : 0.5)),
                w: blocked ? 1.7 : Math.max(0.8, Math.min(1.7, Math.log2((e.calls || 1) + 1) * 0.42)),
                flow: e.tier === 'session-tool' && !sgray,
                blocked,
            }));
        });

        return { nodes, edges, byId: this._index(nodes) };
    },

    _index(nodes) { const m = {}; nodes.forEach(n => { m[n.id] = n; }); return m; },

    _idleDays(lastUsed) {
        if (!lastUsed) return null;
        const t = Date.parse(String(lastUsed).replace(' ', 'T') + (String(lastUsed).endsWith('Z') ? '' : 'Z'));
        if (isNaN(t)) return null;
        return Math.max(0, Math.floor((Date.now() - t) / 86400000));
    },

    /** Friendly "Nh ago" relative time for the last tool call. */
    _relTime(lastUsed) {
        if (!lastUsed) return '—';
        const t = Date.parse(String(lastUsed).replace(' ', 'T') + (String(lastUsed).endsWith('Z') ? '' : 'Z'));
        if (isNaN(t)) return String(lastUsed);
        const s = Math.max(0, (Date.now() - t) / 1000);
        if (s < 60) return 'just now';
        if (s < 3600) return Math.floor(s / 60) + 'm ago';
        if (s < 86400) return Math.floor(s / 3600) + 'h ago';
        return Math.floor(s / 86400) + 'd ago';
    },

    /** Precise local clock time ("Jun 5, 15:44") so two near-simultaneous
     *  events are distinguishable when both round to the same "Nh ago". */
    _absTime(lastUsed) {
        if (!lastUsed) return '';
        const t = Date.parse(String(lastUsed).replace(' ', 'T') + (String(lastUsed).endsWith('Z') ? '' : 'Z'));
        if (isNaN(t)) return '';
        try { return new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
        catch (e) { return ''; }
    },

    // ---------------- draw ----------------

    draw() {
        const body = document.getElementById('agent-map-body');
        if (!body) return;
        body.textContent = '';
        this._sel = null;

        const model = this._prepare();
        this._lnodes = model.nodes;
        this._ledges = model.edges;
        this._byId = model.byId;

        const realSessions = (this.data.nodes || []).filter(n => n.kind === 'session');
        if (!realSessions.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding:64px 24px;text-align:center;color:var(--text-secondary,#b1bac4);';
            empty.innerHTML = '<div style="font-size:15px;margin-bottom:6px;">No agent activity in this window.</div>' +
                '<div style="font-size:13px;">Install a SecureVector Guard plugin and run an agent — every session and tool call shows up here.</div>';
            body.appendChild(empty);
            return;
        }

        const W = this.W, H = this.H;
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        // role=group (not img) so the focusable node buttons are exposed to AT.
        svg.setAttribute('role', 'group');
        svg.setAttribute('aria-label', `Agent map (${this.topo}): ${realSessions.length} agent sessions. Tab through nodes; Enter for detail.`);
        this._svg = svg;
        this._buildGradients(svg);
        const bg = document.createElementNS(SVG_NS, 'rect');
        bg.setAttribute('width', W); bg.setAttribute('height', H); bg.setAttribute('fill', 'transparent');
        svg.appendChild(bg);
        const vp = document.createElementNS(SVG_NS, 'g');
        vp.setAttribute('id', 'sv-vp');
        svg.appendChild(vp);
        this._vp = vp;

        if (this.topo === 'sankey') {
            this._drawSankey(vp, model);
        } else {
            // Layout writes x,y onto each node (and may rewrite edges for mesh dedup).
            if (this.topo === 'tree') this._layoutTree(model);
            else if (this.topo === 'mesh') this._layoutMesh(model);
            else this._layoutRadial(model);

            // Edges under nodes.
            this._edgeEls = [];
            this._ledges.forEach(e => {
                const A = this._byId[e.source], B = this._byId[e.target];
                if (!A || !B) return;
                const d = this._edgePath(A, B);
                const base = document.createElementNS(SVG_NS, 'path');
                base.setAttribute('d', d); base.setAttribute('fill', 'none');
                base.setAttribute('stroke', e.col); base.setAttribute('stroke-width', e.w);
                base.setAttribute('stroke-opacity', e.op); base.setAttribute('stroke-linecap', 'round');
                vp.appendChild(base);
                let flow = null;
                if (e.flow) {
                    flow = document.createElementNS(SVG_NS, 'path');
                    flow.setAttribute('d', d); flow.setAttribute('fill', 'none');
                    flow.setAttribute('stroke', e.blocked ? '#ffffff' : e.col);
                    flow.setAttribute('stroke-width', Math.max(e.w + 0.6, 2));
                    flow.setAttribute('stroke-opacity', e.blocked ? 0.6 : 0.9);
                    flow.setAttribute('class', e.blocked ? 'sv-edge-flow sv-edge-blocked' : 'sv-edge-flow');
                    flow.style.animationDuration = `${Math.max(0.6, 2.2 - Math.log2((e.calls || 1) + 1) * 0.3)}s`;
                    vp.appendChild(flow);
                }
                this._edgeEls.push({ base, flow, e, srcId: e.source, tgtId: e.target });
            });

            // Nodes.
            this._nodeEls = {};
            this._lnodes.forEach(n => this._drawNode(vp, n));
        }

        body.appendChild(svg);
        const statsEl = document.createElement('div');
        statsEl.id = 'agent-map-stats';
        body.appendChild(statsEl);
        const legendEl = document.createElement('div');
        legendEl.id = 'agent-map-legend';
        body.appendChild(legendEl);
        const card = document.createElement('div');
        card.id = 'agent-map-card';
        body.appendChild(card);
        this._card = card;
        const tip = document.createElement('div');
        tip.id = 'agent-map-tip';
        body.appendChild(tip);
        this._tip = tip;
        this._body = body;

        this._renderStats();
        this._renderLegend();
        this._wireViewport(svg, body);
        this._addControls(body);
        svg.addEventListener('pointerdown', (ev) => { if (ev.target === bg || ev.target === svg) this._closeCard(); });

        const hint = document.createElement('div');
        hint.className = 'sv-hint';
        hint.textContent = this.data.truncated
            ? `Top ${this.data.node_cap} edges by volume — ${this.data.dropped_edges} hidden · click a node for detail`
            : 'Click any node for detail · drag to reposition · scroll to zoom · drag canvas to pan';
        if (this.data.truncated) hint.style.color = '#f59e0b';
        body.appendChild(hint);

        this._fitStatic();
        this._applyOutcomeFilter();
    },

    // ---------------- layouts ----------------

    _layoutRadial(model) {
        const W = this.W, H = this.H, cx = W / 2, cy = H / 2 + 4;
        const rH = 118, rS = 198, rT = 288;
        this._cx = cx; this._cy = cy;
        const harnesses = model.nodes.filter(n => n.kind === 'harness');
        const sessionsOf = h => model.nodes.filter(n => n.kind === 'session' && n.harness_id === h.id);
        const toolsOf = s => model.nodes.filter(n => n.kind === 'tool' && n.session_id_node === s.id);

        // proportional wedges with a floor so small harnesses get breathing room
        const minFrac = 0.14;
        let sh = harnesses.map(h => Math.max(1, sessionsOf(h).length));
        let tot = sh.reduce((a, b) => a + b, 0) || 1;
        sh = sh.map(s => Math.max(minFrac, s / tot));
        const t2 = sh.reduce((a, b) => a + b, 0);
        sh = sh.map(s => s / t2);
        let acc = 0;
        const wedge = sh.map(w => { const o = { a0: acc * 6.2832 - 1.5708, a1: (acc + w) * 6.2832 - 1.5708 }; acc += w; return o; });
        const totalTools = harnesses.reduce((a, h) => a + sessionsOf(h).reduce((b, s) => b + toolsOf(s).length, 0), 0);
        const labelTools = totalTools <= 16;

        const dev = model.nodes.find(n => n.id === 'device');
        dev.x = cx; dev.y = cy;

        harnesses.forEach((h, hi) => {
            const a0 = wedge[hi].a0, a1 = wedge[hi].a1, c = (a0 + a1) / 2;
            h.x = cx + Math.cos(c) * rH; h.y = cy + Math.sin(c) * rH;
            const lr = (h.gray ? 13 : 16) + 13;
            h._lbl = { dx: Math.cos(c) * lr, dy: Math.sin(c) * lr + 3, anchor: 'middle', reasonDy: 12 };
            const ss = sessionsOf(h), m = ss.length;
            // In a dense wedge the external "agent #N" labels collide — the
            // in-node number already identifies each agent, so suppress the
            // redundant outer label past a density threshold (click still works).
            const denseLabel = m > 6;
            // Inset each wedge by an angular GAP so the boundary sessions of
            // adjacent harnesses don't sit close enough to overlap labels.
            const gap = Math.min(0.18, (a1 - a0) * 0.22);
            const loAng = a0 + gap, hiAng = a1 - gap;
            const sAng = i => m <= 1 ? c : loAng + (hiAng - loAng) * (i / (m - 1));
            ss.forEach((s, si) => {
                const sa = sAng(si);
                s._denseLabel = denseLabel;
                s.x = cx + Math.cos(sa) * rS; s.y = cy + Math.sin(sa) * rS;
                const tools = toolsOf(s), tn = tools.length;
                tools.forEach((t, ti) => {
                    const ta = sa + (ti - (tn - 1) / 2) * 0.075;
                    t.x = cx + Math.cos(ta) * rT; t.y = cy + Math.sin(ta) * rT;
                    const anchor = Math.abs(Math.cos(ta)) < 0.35 ? 'middle' : (Math.cos(ta) > 0 ? 'start' : 'end');
                    t._lbl = labelTools ? { dx: Math.cos(ta) * 15, dy: Math.sin(ta) * 15 + 3, anchor } : null;
                });
            });
        });
        this._edgeMode = 'radial';
    },

    _layoutTree(model) {
        // Top-down binary-tree style: device at the top, then a harness row, an
        // agent/session row, and the tools fanned across the bottom. Horizontal
        // position is leaf-driven (each parent sits at the mean of its children)
        // for a tidy, balanced tree; the dense tool row uses rotated labels.
        const W = this.W, H = this.H, left = 60, right = W - 60, span = right - left;
        const rowY = { device: 56, harness: 188, session: 326, tool: 470 };
        this._cx = W / 2; this._cy = H / 2;
        const harnesses = model.nodes.filter(n => n.kind === 'harness');
        const sessionsOf = h => model.nodes.filter(n => n.kind === 'session' && n.harness_id === h.id);
        const toolsOf = s => model.nodes.filter(n => n.kind === 'tool' && n.session_id_node === s.id);

        let totalLeaves = 0;
        harnesses.forEach(h => { const ss = sessionsOf(h); if (!ss.length) { totalLeaves++; return; } ss.forEach(s => { totalLeaves += Math.max(1, toolsOf(s).length); }); });
        totalLeaves = totalLeaves || 1;
        let slot = 0;
        const xNext = () => { const x = left + (slot + 0.5) / totalLeaves * span; slot++; return x; };

        const hXs = [];
        harnesses.forEach(h => {
            const ss = sessionsOf(h), sXs = [];
            ss.forEach(s => {
                const tools = toolsOf(s), tXs = [];
                tools.forEach(t => {
                    const tx = xNext(); tXs.push(tx); t.x = tx; t.y = rowY.tool;
                    // rotated label so a dense bottom row doesn't overlap horizontally
                    t._lbl = { dx: 0, dy: 14, anchor: 'start', rot: 55 };
                });
                const sx = tXs.length ? tXs.reduce((a, b) => a + b, 0) / tXs.length : xNext(); sXs.push(sx);
                s.x = sx; s.y = rowY.session;
            });
            const hx = sXs.length ? sXs.reduce((a, b) => a + b, 0) / sXs.length : xNext(); hXs.push(hx);
            h.x = hx; h.y = rowY.harness;
            h._lbl = { dx: 0, dy: -(h.gray ? 13 : 16) - 8, anchor: 'middle', reasonDy: 12 };
        });
        const dev = model.nodes.find(n => n.id === 'device');
        dev.x = hXs.length ? hXs.reduce((a, b) => a + b, 0) / hXs.length : W / 2; dev.y = rowY.device;
        this._edgeMode = 'tree';
    },

    _layoutMesh(model) {
        const W = this.W, H = this.H, cx = W / 2, cy = H / 2 + 4;
        const rH = 104, rS = 198, rT = 290;
        this._cx = cx; this._cy = cy;
        const harnesses = model.nodes.filter(n => n.kind === 'harness');
        const sessions = model.nodes.filter(n => n.kind === 'session');
        const perSessionTools = model.nodes.filter(n => n.kind === 'tool');

        // Dedup tools by tool_id → shared tool nodes (the honest many-to-many).
        const toolMap = {};
        perSessionTools.forEach(t => {
            const key = t.tool_id;
            if (!toolMap[key]) toolMap[key] = { id: 'mtool:' + key, kind: 'tool', label: t.label, tool_id: key, ext: t.ext, blocked: false, calls: 0, cloud_managed: false, touched_secrets: false, last_used: null, last_blocked: null };
            toolMap[key].blocked = toolMap[key].blocked || t.blocked;
            toolMap[key].calls += (t.calls || 0);
            toolMap[key].cloud_managed = toolMap[key].cloud_managed || t.cloud_managed;
            toolMap[key].touched_secrets = toolMap[key].touched_secrets || t.touched_secrets;
            toolMap[key].last_used = maxStr(toolMap[key].last_used, t.last_used);
            toolMap[key].last_blocked = maxStr(toolMap[key].last_blocked, t.last_blocked);
        });
        const sharedTools = Object.values(toolMap).sort((a, b) => String(a.tool_id).localeCompare(String(b.tool_id)));

        // Rebuild the node + edge sets for mesh: device + harnesses + sessions + shared tools.
        const meshNodes = [];
        const dev = model.nodes.find(n => n.id === 'device'); dev.x = cx; dev.y = cy; meshNodes.push(dev);
        harnesses.forEach((h, i) => {
            const a = -1.5708 + i / harnesses.length * 6.2832;
            h.x = cx + Math.cos(a) * rH; h.y = cy + Math.sin(a) * rH;
            const lr = (h.gray ? 13 : 16) + 12;
            const anchor = Math.abs(Math.cos(a)) < 0.35 ? 'middle' : (Math.cos(a) > 0 ? 'start' : 'end');
            h._lbl = { dx: Math.cos(a) * lr, dy: Math.sin(a) * lr + 3, anchor, reasonDy: 12 };
            meshNodes.push(h);
        });
        sessions.forEach((s, i) => {
            const a = -1.5708 + (i + 0.5) / Math.max(1, sessions.length) * 6.2832;
            s.x = cx + Math.cos(a) * rS; s.y = cy + Math.sin(a) * rS;
            meshNodes.push(s);
        });
        const toolAng = {};
        sharedTools.forEach((t, i) => {
            const a = -1.5708 + i / Math.max(1, sharedTools.length) * 6.2832;
            toolAng[t.tool_id] = a;
            t.x = cx + Math.cos(a) * rT; t.y = cy + Math.sin(a) * rT;
            const anchor = Math.abs(Math.cos(a)) < 0.35 ? 'middle' : (Math.cos(a) > 0 ? 'start' : 'end');
            t._lbl = { dx: Math.cos(a) * 15, dy: Math.sin(a) * 15 + 3, anchor };
            meshNodes.push(t);
        });

        // Edges: device→harness, harness→session (from existing), session→sharedTool.
        const meshEdges = [];
        this._ledges.forEach(e => {
            if (e.tier === 'device-harness' || e.tier === 'harness-session') meshEdges.push(e);
        });
        perSessionTools.forEach(t => {
            const sid = t.session_id_node;
            meshEdges.push({
                source: sid, target: 'mtool:' + t.tool_id, tier: 'session-tool',
                calls: t.calls || 0, blocked: t.blocked, outcome: t.blocked ? 'blocked' : 'allow',
                col: t.blocked ? OUTCOME_COLOR.blocked : (t.gray ? '#454b54' : EDGE_NEUTRAL),
                op: t.gray ? 0.13 : (t.blocked ? 0.7 : 0.3),
                w: t.blocked ? 1.7 : Math.max(0.8, Math.min(1.6, Math.log2((t.calls || 1) + 1) * 0.4)),
                flow: !t.gray, blocked: t.blocked,
            });
        });

        this._lnodes = meshNodes;
        this._ledges = meshEdges;
        this._byId = this._index(meshNodes);
        this._edgeMode = 'mesh';
    },

    // ---------------- edge paths ----------------

    _edgePath(A, B) {
        if (this._edgeMode === 'tree') {
            // top-down: bow vertically through the mid-Y between the two rows
            const my = (A.y + B.y) / 2;
            return `M${A.x.toFixed(1)},${A.y.toFixed(1)} C${A.x.toFixed(1)},${my.toFixed(1)} ${B.x.toFixed(1)},${my.toFixed(1)} ${B.x.toFixed(1)},${B.y.toFixed(1)}`;
        }
        if (this._edgeMode === 'mesh') {
            return `M${A.x.toFixed(1)},${A.y.toFixed(1)} L${B.x.toFixed(1)},${B.y.toFixed(1)}`;
        }
        // radial bundled dendrogram curve
        const cx = this._cx, cy = this._cy;
        let aA = Math.atan2(A.y - cy, A.x - cx), rA = Math.hypot(A.x - cx, A.y - cy);
        let aB = Math.atan2(B.y - cy, B.x - cx), rB = Math.hypot(B.x - cx, B.y - cy);
        if (rA < 2) aA = aB; if (rB < 2) aB = aA;
        const rm = (rA + rB) / 2;
        const c1x = cx + Math.cos(aA) * rm, c1y = cy + Math.sin(aA) * rm;
        const c2x = cx + Math.cos(aB) * rm, c2y = cy + Math.sin(aB) * rm;
        return `M${A.x.toFixed(1)},${A.y.toFixed(1)} C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${B.x.toFixed(1)},${B.y.toFixed(1)}`;
    },

    // ---------------- node rendering ----------------

    _drawNode(vp, n) {
        const g = document.createElementNS(SVG_NS, 'g');
        g.setAttribute('class', 'sv-node');
        g.setAttribute('tabindex', '0');
        g.setAttribute('role', 'button');
        g.setAttribute('aria-label', this._ariaLabel(n));
        g.setAttribute('transform', `translate(${n.x},${n.y})`);

        if (n.kind === 'device') {
            const c = document.createElementNS(SVG_NS, 'circle');
            c.setAttribute('r', 24); c.setAttribute('fill', 'var(--bg-card,#161b22)');
            c.setAttribute('stroke', 'var(--border-default,#30363d)'); c.setAttribute('stroke-width', 1.5);
            g.appendChild(c);
            ['this', 'device'].forEach((tx, i) => {
                const t = document.createElementNS(SVG_NS, 'text');
                t.setAttribute('text-anchor', 'middle'); t.setAttribute('y', i ? 10 : -1);
                t.setAttribute('font-size', 9.5); t.setAttribute('fill', 'var(--text-muted,#7d8590)');
                t.textContent = tx; g.appendChild(t);
            });
        } else if (n.kind === 'harness') {
            const r = n.gray ? 13 : 16;
            const c = document.createElementNS(SVG_NS, 'circle');
            c.setAttribute('r', r); c.setAttribute('fill', n.gray ? '#22272e' : this._fillFor(n.col));
            c.setAttribute('stroke', 'var(--bg-card,#161b22)'); c.setAttribute('stroke-width', 3);
            if (n.gray) c.setAttribute('fill-opacity', 0.6);
            g.appendChild(c);
            const L = n._lbl || { dx: 0, dy: r + 16, anchor: 'middle' };
            const hl = document.createElementNS(SVG_NS, 'text');
            hl.setAttribute('class', 'sv-node-label sv-harness-label');
            hl.setAttribute('x', L.dx); hl.setAttribute('y', L.dy); hl.setAttribute('text-anchor', L.anchor);
            hl.style.fill = n.gray ? 'var(--text-muted,#7d8590)' : n.col;
            hl.textContent = n.label; g.appendChild(hl);
            if (n.gray && n.reason) {
                const rl = document.createElementNS(SVG_NS, 'text');
                rl.setAttribute('class', 'sv-reason'); rl.setAttribute('x', L.dx);
                rl.setAttribute('y', L.dy + (L.reasonDy || 12)); rl.setAttribute('text-anchor', L.anchor);
                rl.textContent = n.reason; g.appendChild(rl);
            }
        } else if (n.kind === 'session') {
            const c = document.createElementNS(SVG_NS, 'circle');
            c.setAttribute('r', 10); c.setAttribute('fill', n.gray ? '#2b3038' : this._fillFor(n.col));
            // Always wear the dark card-coloured halo; the risk colour goes on a
            // SEPARATE outer ring (below) so it reads even when the harness fill
            // is the same hue (e.g. openclaw red + blocked red).
            c.setAttribute('stroke', 'var(--bg-card,#161b22)'); c.setAttribute('stroke-width', 2.5);
            g.appendChild(c);
            // Risk ring: red = blocked, amber = secret-touch or high-risk.
            const ring = n.gray ? null : ((n.blocked || 0) > 0 ? OUTCOME_COLOR.blocked : (n.secret || n.risk === 'amber') ? '#f59e0b' : n.risk === 'red' ? OUTCOME_COLOR.blocked : null);
            if (ring) {
                const rr = document.createElementNS(SVG_NS, 'circle');
                rr.setAttribute('r', 12.5); rr.setAttribute('fill', 'none');
                rr.setAttribute('stroke', ring); rr.setAttribute('stroke-width', 2.5);
                g.appendChild(rr);
            }
            if (n.secret && !n.gray) {
                const lock = document.createElementNS(SVG_NS, 'path');
                lock.setAttribute('d', LOCK_PATH); lock.setAttribute('fill', '#f59e0b');
                lock.style.stroke = 'var(--bg-card,#161b22)'; lock.setAttribute('stroke-width', 2.5);
                lock.setAttribute('paint-order', 'stroke'); lock.setAttribute('pointer-events', 'none');
                lock.setAttribute('transform', 'translate(6,-16) scale(0.5)'); g.appendChild(lock);
            }
            const num = document.createElementNS(SVG_NS, 'text');
            num.setAttribute('text-anchor', 'middle'); num.setAttribute('y', 3);
            num.setAttribute('font-size', 8); num.setAttribute('font-weight', 700);
            num.setAttribute('fill', n.gray ? 'var(--text-muted,#7d8590)' : '#fff');
            num.textContent = n.num != null ? n.num : ''; g.appendChild(num);
            if (!n._denseLabel) {
                const al = document.createElementNS(SVG_NS, 'text');
                al.setAttribute('class', 'sv-node-label sv-agent-label'); al.setAttribute('text-anchor', 'middle'); al.setAttribute('y', 21);
                al.style.fill = n.gray ? 'var(--text-muted,#7d8590)' : 'var(--text-secondary,#b1bac4)';
                al.textContent = n.label || ('agent #' + (n.num || '?')); g.appendChild(al);
            }
            if (!n.active) {
                const idl = document.createElementNS(SVG_NS, 'text');
                idl.setAttribute('class', 'sv-reason'); idl.setAttribute('text-anchor', 'middle'); idl.setAttribute('y', 31);
                idl.textContent = (n.idle_days != null ? n.idle_days : '?') + 'd inactive'; g.appendChild(idl);
            }
        } else { // tool
            if (n.blocked) {
                const halo = document.createElementNS(SVG_NS, 'circle');
                halo.setAttribute('r', 13); halo.setAttribute('fill', OUTCOME_COLOR.blocked);
                halo.setAttribute('fill-opacity', 0.16); halo.setAttribute('stroke', OUTCOME_COLOR.blocked);
                halo.setAttribute('stroke-opacity', 0.45); halo.setAttribute('stroke-width', 1);
                g.appendChild(halo);
            }
            if (n.ext) {
                const gw = document.createElementNS(SVG_NS, 'g');
                gw.setAttribute('transform', 'translate(-8,-8) scale(0.68)');
                const p = document.createElementNS(SVG_NS, 'path');
                p.setAttribute('d', GEAR_PATH); p.setAttribute('fill', n.gray ? '#4b515a' : TOOL_FILL_EXT);
                if (!n.gray) p.setAttribute('class', 'sv-gear');
                gw.appendChild(p); g.appendChild(gw);
            } else {
                const c = document.createElementNS(SVG_NS, 'circle');
                c.setAttribute('r', 6); c.setAttribute('fill', n.gray ? '#3a4048' : TOOL_FILL);
                c.setAttribute('stroke', n.blocked ? OUTCOME_COLOR.blocked : 'var(--border-default,#30363d)');
                c.setAttribute('stroke-width', n.blocked ? 2 : 1.2);
                g.appendChild(c);
            }
            if ((n.cloud_managed || n.touched_secrets) && !n.gray) {
                const lock = document.createElementNS(SVG_NS, 'path');
                lock.setAttribute('d', LOCK_PATH); lock.setAttribute('fill', '#f59e0b');
                lock.style.stroke = 'var(--bg-card,#161b22)'; lock.setAttribute('stroke-width', 2.5);
                lock.setAttribute('paint-order', 'stroke'); lock.setAttribute('pointer-events', 'none');
                lock.setAttribute('transform', 'translate(3,-13) scale(0.5)'); g.appendChild(lock);
            }
            if (n._lbl) {
                const tl = document.createElementNS(SVG_NS, 'text');
                tl.setAttribute('class', 'sv-node-label'); tl.setAttribute('text-anchor', n._lbl.anchor); tl.setAttribute('font-size', 9.5);
                tl.style.fill = n.gray ? 'var(--text-muted,#7d8590)' : 'var(--text-secondary,#b1bac4)';
                if (n._lbl.rot) {
                    tl.setAttribute('x', 0); tl.setAttribute('y', 0);
                    tl.setAttribute('transform', `translate(${n._lbl.dx},${n._lbl.dy}) rotate(${n._lbl.rot})`);
                } else {
                    tl.setAttribute('x', n._lbl.dx); tl.setAttribute('y', n._lbl.dy);
                }
                tl.textContent = this._toolLabel(n); g.appendChild(tl);
            }
        }

        this._wireNodeDrag(g, n);
        this._wireHover(g, n);
        vp.appendChild(g);
        this._nodeEls[n.id] = { g, node: n };
    },

    _toolLabel(n) {
        const s = String(ObsTabs.isExternalTool(n.tool_id) ? String(n.tool_id).split(':').pop() : (n.label || ''));
        return s.length > 22 ? s.slice(0, 21) + '…' : s;
    },

    /** Screen-reader description of a node — nodes are focusable buttons, so
     *  each needs a meaningful label (otherwise SRs announce just "group"). */
    _ariaLabel(n) {
        if (n.kind === 'device') return 'This device';
        if (n.kind === 'harness') return `${n.label} harness, ${n.gray ? 'inactive' : 'active'}, ${n.sessions || 0} agents, ${n.calls || 0} tool calls, ${n.blocked || 0} blocked`;
        if (n.kind === 'session') return `Agent ${n.num}, ${n.harness}, ${n.active ? 'running' : 'inactive, no activity in last 24 hours, ' + (n.idle_days || 0) + ' days idle'}, ${n.tools || 0} tools, ${n.calls || 0} calls, ${n.blocked || 0} blocked`;
        const fleet = (this.data.nodes || []).filter(x => x.kind === 'tool' && x.tool_id === n.tool_id);
        const agents = new Set(fleet.map(x => x.session_id_node)).size || 1;
        return `${this._toolLabel(n)}, ${n.ext ? 'external MCP' : 'built-in'} tool, ${n.blocked ? 'blocked' : 'allowed'}, used by ${agents} agent${agents === 1 ? '' : 's'}`;
    },

    /** Sankey posture view: harness → agent → deduped shared tool, ribbon
     *  width ∝ call volume, blocked flow in red. Answers "which tools does my
     *  fleet share, and how heavily". Sets the same _lnodes/_ledges/_nodeEls/
     *  _edgeEls contract as the other topologies so cards + focus work. */
    _drawSankey(vp, model) {
        const W = this.W, H = this.H;
        const harnesses = model.nodes.filter(n => n.kind === 'harness');
        const sessions = model.nodes.filter(n => n.kind === 'session');
        const perTools = model.nodes.filter(n => n.kind === 'tool');

        this._lnodes = []; this._ledges = []; this._byId = {}; this._nodeEls = {}; this._edgeEls = [];
        if (!sessions.length) return;

        // Dedupe tools into shared nodes; accumulate call volume.
        const toolMap = {};
        perTools.forEach(t => {
            const k = t.tool_id;
            if (!toolMap[k]) toolMap[k] = { id: 'stool:' + k, kind: 'tool', label: t.label, tool_id: k, ext: t.ext, blocked: false, cloud_managed: false, touched_secrets: false, value: 0, calls: 0, last_used: null, last_blocked: null };
            const m = toolMap[k];
            m.value += (t.calls || 0); m.calls += (t.calls || 0); m.blocked = m.blocked || t.blocked;
            m.cloud_managed = m.cloud_managed || t.cloud_managed; m.touched_secrets = m.touched_secrets || t.touched_secrets;
            m.last_used = maxStr(m.last_used, t.last_used); m.last_blocked = maxStr(m.last_blocked, t.last_blocked);
        });
        const sharedTools = Object.values(toolMap);

        // Node throughput values.
        harnesses.forEach(h => { h.value = sessions.filter(s => s.harness_id === h.id).reduce((a, s) => a + (s.calls || 0), 0); });
        sessions.forEach(s => { s.value = Math.max(1, s.calls || 0); });
        sharedTools.forEach(t => { t.value = Math.max(1, t.value); });

        const top = 46, bot = H - 40, availH = bot - top, barW = 13;
        const colX = { harness: 122, session: Math.round(W * 0.46), tool: W - 152 };
        const hIndex = {}; harnesses.forEach((h, i) => { hIndex[h.id] = i; });
        sessions.sort((a, b) => (hIndex[a.harness_id] - hIndex[b.harness_id]) || ((a.num || 0) - (b.num || 0)));
        // order tools by mean Y of the sessions using them (barycenter → fewer crossings)
        // Reserve a MIN height per node so a low-volume harness/agent (one chatty
        // session can dwarf the rest) stays visible and its label doesn't collide;
        // the remaining space is shared by call volume so ribbon widths still read
        // as throughput.
        const stackY = (nodes, x, gap, minH) => {
            const m = nodes.length;
            const total = nodes.reduce((a, n) => a + n.value, 0) || 1;
            const pool = Math.max(0, availH - gap * Math.max(0, m - 1) - minH * m);
            let y = top;
            nodes.forEach(n => { n._h = minH + (n.value / total) * pool; n._x = x; n._y = y; n._cy = y + n._h / 2; y += n._h + gap; });
            const used = (y - gap) - top, off = (availH - used) / 2;
            if (off > 0) nodes.forEach(n => { n._y += off; n._cy += off; });
        };
        stackY(harnesses, colX.harness, 16, 22);
        stackY(sessions, colX.session, 8, 13);
        const byIdTmp = {}; sessions.forEach(s => { byIdTmp[s.id] = s; });
        sharedTools.forEach(t => {
            const ys = perTools.filter(p => p.tool_id === t.tool_id).map(p => (byIdTmp[p.session_id_node] || {})._cy || 0);
            t._ord = ys.reduce((a, b) => a + b, 0) / (ys.length || 1);
        });
        sharedTools.sort((a, b) => a._ord - b._ord);
        stackY(sharedTools, colX.tool, 6, 9);

        const nodes = harnesses.concat(sessions, sharedTools);
        const byId = {}; nodes.forEach(n => { byId[n.id] = n; });

        // Links with per-endpoint stacking offsets.
        const links = [];
        sessions.forEach(s => { links.push({ source: s.harness_id, target: s.id, tier: 'harness-session', value: Math.max(1, s.calls || 0), calls: s.calls || 0, blocked: (s.blocked || 0) > 0, col: EDGE_NEUTRAL }); });
        perTools.forEach(t => {
            links.push({ source: t.session_id_node, target: 'stool:' + t.tool_id, tier: 'session-tool', outcome: t.blocked ? 'blocked' : 'allow', value: Math.max(1, t.calls || 0), calls: t.calls || 0, blocked: t.blocked, col: t.blocked ? OUTCOME_COLOR.blocked : (t.gray ? '#454b54' : EDGE_NEUTRAL) });
        });
        const bySrc = {}, byTgt = {};
        links.forEach(l => { (bySrc[l.source] = bySrc[l.source] || []).push(l); (byTgt[l.target] = byTgt[l.target] || []).push(l); });
        Object.values(bySrc).forEach(arr => {
            const src = byId[arr[0].source]; if (!src) return;
            arr.sort((a, b) => ((byId[a.target] || {})._cy || 0) - ((byId[b.target] || {})._cy || 0));
            const sum = arr.reduce((s, l) => s + l.value, 0) || 1, scale = src._h / sum; let acc = 0;
            arr.forEach(l => { l._sw = l.value * scale; l._sy = src._y + acc; acc += l._sw; });
        });
        Object.values(byTgt).forEach(arr => {
            const tgt = byId[arr[0].target]; if (!tgt) return;
            arr.sort((a, b) => ((byId[a.source] || {})._cy || 0) - ((byId[b.source] || {})._cy || 0));
            const sum = arr.reduce((s, l) => s + l.value, 0) || 1, scale = tgt._h / sum; let acc = 0;
            arr.forEach(l => { l._tw = l.value * scale; l._ty = tgt._y + acc; acc += l._tw; });
        });

        // Column headers.
        [[colX.harness, 'harnesses'], [colX.session, 'agents'], [colX.tool, 'tools']].forEach(([x, t]) => {
            const h = document.createElementNS(SVG_NS, 'text');
            h.setAttribute('x', x + barW / 2); h.setAttribute('y', 30); h.setAttribute('text-anchor', 'middle');
            h.setAttribute('font-size', 11); h.setAttribute('font-weight', 700); h.setAttribute('fill', 'var(--text-muted,#7d8590)');
            h.setAttribute('letter-spacing', '.4px'); h.textContent = t.toUpperCase(); vp.appendChild(h);
        });

        // Ribbons (under bars).
        links.forEach(l => {
            const x0 = byId[l.source]._x + barW, x1 = byId[l.target]._x;
            const d = this._ribbon(x0, l._sy, l._sy + l._sw, x1, l._ty, l._ty + l._tw);
            const p = document.createElementNS(SVG_NS, 'path');
            p.setAttribute('d', d); p.setAttribute('fill', l.col); p.setAttribute('fill-opacity', l.blocked ? 0.55 : 0.34);
            p.setAttribute('stroke', 'none'); vp.appendChild(p);
            this._edgeEls.push({ base: p, flow: null, e: l, srcId: l.source, tgtId: l.target });
        });

        // Node bars.
        nodes.forEach(n => {
            const g = document.createElementNS(SVG_NS, 'g');
            g.setAttribute('class', 'sv-node'); g.setAttribute('tabindex', '0');
            g.setAttribute('role', 'button'); g.setAttribute('aria-label', this._ariaLabel(n));
            g.setAttribute('transform', `translate(${n._x},${n._y})`);
            n.x = n._x + barW / 2; n.y = n._cy; // for card/focus geometry
            const rect = document.createElementNS(SVG_NS, 'rect');
            rect.setAttribute('width', barW); rect.setAttribute('height', n._h); rect.setAttribute('rx', 2.5);
            const fill = n.kind === 'harness' ? (n.gray ? GRAY : this._fillFor(n.col))
                : n.kind === 'session' ? (n.gray ? GRAY : this._fillFor(n.col || n.baseCol))
                    : (n.blocked ? OUTCOME_COLOR.blocked : (n.ext ? TOOL_FILL_EXT : TOOL_FILL));
            rect.setAttribute('fill', fill);
            rect.setAttribute('stroke', 'var(--bg-card,#161b22)'); rect.setAttribute('stroke-width', 1);
            g.appendChild(rect);
            // label: harness left, tool right, agent left (small)
            const lab = document.createElementNS(SVG_NS, 'text');
            lab.setAttribute('class', 'sv-node-label'); lab.setAttribute('font-size', n.kind === 'harness' ? 11.5 : 9.5);
            lab.setAttribute('dominant-baseline', 'middle');
            if (n.kind === 'tool') { lab.setAttribute('x', barW + 5); lab.setAttribute('y', n._h / 2); lab.setAttribute('text-anchor', 'start'); }
            else { lab.setAttribute('x', -5); lab.setAttribute('y', n._h / 2); lab.setAttribute('text-anchor', 'end'); }
            lab.style.fill = n.kind === 'harness' ? (n.gray ? 'var(--text-muted,#7d8590)' : n.col) : 'var(--text-secondary,#b1bac4)';
            if (n.kind === 'harness') lab.style.fontWeight = '700';
            lab.textContent = n.kind === 'tool' ? this._toolLabel(n) : (n.kind === 'harness' ? n.label : (n.label || ('agent #' + n.num)));
            g.appendChild(lab);
            this._wireSankeyClick(g, n);
            this._wireHover(g, n);
            vp.appendChild(g);
            this._nodeEls[n.id] = { g, node: n };
        });

        this._lnodes = nodes; this._ledges = links; this._byId = byId;
    },

    _ribbon(x0, sy0, sy1, x1, ty0, ty1) {
        const xm = (x0 + x1) / 2;
        return `M${x0.toFixed(1)},${sy0.toFixed(1)} C${xm.toFixed(1)},${sy0.toFixed(1)} ${xm.toFixed(1)},${ty0.toFixed(1)} ${x1.toFixed(1)},${ty0.toFixed(1)} `
            + `L${x1.toFixed(1)},${ty1.toFixed(1)} C${xm.toFixed(1)},${ty1.toFixed(1)} ${xm.toFixed(1)},${sy1.toFixed(1)} ${x0.toFixed(1)},${sy1.toFixed(1)} Z`;
    },

    _wireSankeyClick(g, node) {
        let down = null;
        g.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); down = { x: ev.clientX, y: ev.clientY }; });
        g.addEventListener('pointerup', (ev) => {
            if (!down) return;
            if (Math.abs(ev.clientX - down.x) + Math.abs(ev.clientY - down.y) < 5) this.selectNode(node, g);
            down = null;
        });
        g.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); this.selectNode(node, g); } });
    },

    // ---------------- hover tooltip (quick scan, no focus change) ----------------

    _tipHtml(n) {
        const e = (s) => this._esc(s);
        const blk = (b) => b ? ` · <span class="blk">${b} blocked</span>` : '';
        if (n.kind === 'device') return `<b>this device</b>`;
        if (n.kind === 'harness') return `<b>${e(n.label)}</b><span>${n.gray ? 'inactive' : 'active'} · ${n.sessions || 0} agents · ${n.calls || 0} calls${blk(n.blocked)}</span>`;
        if (n.kind === 'session') return `<b>agent #${n.num} · ${e(n.harness)}</b><span>${n.active ? 'running' : (n.idle_days || 0) + 'd inactive'} · ${n.calls || 0} calls${blk(n.blocked)}</span>`;
        // tool — full (untruncated) name + kind + volume, the value hover adds
        // over the rotated/clipped tree labels
        const owner = n.session_id_node ? (() => { const so = (this.data.nodes || []).find(x => x.id === n.session_id_node); return so ? ` · ${e(so.harness)} #${so.num}` : ''; })() : '';
        const full = ObsTabs.isExternalTool(n.tool_id) ? String(n.tool_id).split(':').pop() : (n.label || '');
        return `<b>${e(full)}</b><span>${n.ext ? 'external MCP' : 'built-in'}${n.blocked ? ' · <span class="blk">blocked</span>' : ''} · ${n.calls || 0} calls${owner}</span>`;
    },

    _wireHover(g, n) {
        g.addEventListener('mouseenter', (ev) => { if (!this._tip) return; this._tip.innerHTML = this._tipHtml(n); this._tip.classList.add('show'); this._moveTip(ev); });
        g.addEventListener('mousemove', (ev) => this._moveTip(ev));
        g.addEventListener('mouseleave', () => this._hideTip());
    },
    _moveTip(ev) {
        if (!this._tip || !this._body) return;
        const rect = this._body.getBoundingClientRect();
        const tw = this._tip.offsetWidth || 180, th = this._tip.offsetHeight || 40;
        let x = ev.clientX - rect.left + 14, y = ev.clientY - rect.top + 14;
        if (x + tw > rect.width) x = ev.clientX - rect.left - tw - 14;
        if (y + th > rect.height) y = rect.height - th - 8;
        this._tip.style.left = Math.max(6, x) + 'px';
        this._tip.style.top = Math.max(6, y) + 'px';
    },
    _hideTip() { if (this._tip) this._tip.classList.remove('show'); },

    // ---------------- detail card (click any node) ----------------

    selectNode(n, g) {
        Object.values(this._nodeEls || {}).forEach(({ g }) => g.classList.remove('sv-sel'));
        if (g) g.classList.add('sv-sel');
        this._sel = n;
        const col = n.col || (n.gray ? GRAY : (n.kind === 'tool' ? (n.ext ? TOOL_FILL_EXT : TOOL_FILL) : 'var(--accent-primary,#5eadb8)'));
        let title, typ, rows = '', openLbl, openFn;
        const kv = (k, v) => `<span>${this._esc(k)}</span><b>${v}</b>`;
        const kvBlk = (k, v) => `<span>${this._esc(k)}</span><b style="color:${v ? 'var(--danger,#ef4444)' : 'var(--text-primary,#e6edf3)'}">${v}</b>`;

        if (n.kind === 'device') {
            const hs = this._lnodes.filter(x => x.kind === 'harness');
            const ag = (this.data.nodes || []).filter(x => x.kind === 'session');
            const calls = ag.reduce((a, x) => a + (x.calls || 0), 0);
            const blk = ag.reduce((a, x) => a + (x.blocked || 0), 0);
            title = 'this device'; typ = 'Host';
            rows = kv('Harnesses', hs.length) + kv('Agents', ag.length) + kv('Tool calls', calls) + kvBlk('Blocked', blk);
            openLbl = '▸ Open all runs'; openFn = () => this._openRuns();
        } else if (n.kind === 'harness') {
            title = this._esc(n.label); typ = 'Harness' + (n.gray ? ' · inactive' : '');
            const hstatus = n.gray ? `inactive — no activity in last 24h${n.idle_days != null ? ` (${n.idle_days}d idle)` : ''}` : 'active';
            rows = kv('Status', hstatus) + kv('Last call', this._relTime(n.last_used)) + kv('Agents', n.sessions || 0)
                + kv('Tool calls', n.calls || 0) + kvBlk('Blocked', n.blocked || 0);
            openLbl = '▸ Open runs for ' + this._esc(n.label); openFn = () => this._openHarness(n);
        } else if (n.kind === 'session') {
            title = this._esc(n.label || ('agent #' + n.num)); typ = this._esc(n.harness) + (n.active ? '' : ' · inactive');
            const fullSid = String(n.session_id || n.trace_id || '');
            const sstatus = n.active ? 'running'
                : `inactive — no activity in last 24h${n.idle_days != null ? ` (${n.idle_days}d idle)` : ''}`;
            rows = kv('Status', sstatus) + kv('Last call', this._relTime(n.last_used))
                + kv('Tools', n.tools || 0) + kv('Tool calls', n.calls || 0) + kvBlk('Blocked', n.blocked || 0)
                + (n.secret ? kv('Secret access', '<span style="color:var(--warning,#f59e0b);font-weight:700">detected</span>') : '')
                + (fullSid ? `<span>Session</span><span class="sv-sid"><code>${this._esc(fullSid)}</code><button class="sv-copy" data-copy="${this._esc(fullSid)}" title="Copy session id">copy</button></span>` : '');
            openLbl = '▸ Open this agent’s run'; openFn = () => this._openAgent(n);
        } else { // tool
            // Per-node by design: in radial/tree a tool node is ONE agent's use
            // of the tool, so calls/last-call/last-blocked describe THAT node (in
            // mesh/sankey the node is the deduped shared tool → aggregated). Only
            // "Used by" is fleet-wide (blast radius across all agents by tool_id).
            const tid = n.tool_id;
            const fleet = (this.data.nodes || []).filter(x => x.kind === 'tool' && x.tool_id === tid);
            const agents = new Set(fleet.map(x => x.session_id_node)).size
                || new Set(this._ledges.filter(e => e.target === n.id).map(e => e.source)).size;
            const calls = n.calls || 0;
            const lastCall = n.last_used || null, lastBlocked = n.last_blocked || null;
            const secret = !!n.touched_secrets, cloud = !!n.cloud_managed;
            // owning agent (radial/tree per-session nodes) so claude-code's Bash
            // is visibly distinct from codex's Bash
            let owner = '';
            if (n.session_id_node) { const so = (this.data.nodes || []).find(x => x.id === n.session_id_node); if (so) owner = ` · ${this._esc(so.harness)} agent #${so.num}`; }
            const perm = n.blocked ? ['block', 'blocked'] : (n.ext ? ['log', 'log_only'] : ['allow', 'allow']);
            const src = n.blocked ? 'synced policy' : (n.ext ? 'essential default' : 'local override');
            title = this._esc(this._toolLabel(n)); typ = (n.ext ? 'External MCP tool' : 'Built-in tool') + (n.gray ? ' · inactive' : '') + owner;
            rows = kv('Tool permission', `<span class="perm ${perm[0]}">${perm[1]}</span>`) + kv('Source', src)
                + kv('Tool calls', calls) + kv('Used by', agents + (agents === 1 ? ' agent' : ' agents'))
                + kv('Last call', `${this._esc(this._relTime(lastCall))}${lastCall ? ` <span style="color:var(--text-muted,#7d8590)">· ${this._esc(this._absTime(lastCall))}</span>` : ''}`)
                + (lastBlocked ? kv('Last blocked', `<span style="color:var(--danger,#ef4444);font-weight:700">${this._esc(this._relTime(lastBlocked))}</span> <span style="color:var(--text-muted,#7d8590)">· ${this._esc(this._absTime(lastBlocked))}</span>`) : '')
                + (secret ? kv('Secret access', '<span style="color:var(--warning,#f59e0b);font-weight:700">detected</span>') : '')
                + (cloud ? kv('Cloud-managed', 'yes') : '');
            openLbl = '▸ Open runs for ' + this._esc(this._toolLabel(n)); openFn = () => this._openTool(n);
        }
        const card = this._card;
        card.innerHTML = `<button class="close" aria-label="close">×</button>` +
            `<div class="ch"><span class="dot" style="background:${col}"></span><span class="ttl">${title}</span></div>` +
            `<div class="typ">${typ}</div><div class="kv">${rows}</div>` +
            `<button class="open">${openLbl}</button>`;
        card.classList.add('show');
        card.querySelector('.close').onclick = () => this._closeCard();
        card.querySelector('.open').onclick = openFn;
        const cp = card.querySelector('.sv-copy');
        if (cp) cp.onclick = () => {
            const txt = cp.dataset.copy;
            const done = () => { cp.textContent = 'copied'; setTimeout(() => { cp.textContent = 'copy'; }, 1200); };
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done).catch(() => {});
            else { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) { } document.body.removeChild(ta); }
        };
        this._focusNode(n);
    },

    _closeCard() {
        if (this._card) this._card.classList.remove('show');
        Object.values(this._nodeEls || {}).forEach(({ g }) => g.classList.remove('sv-sel'));
        this._sel = null;
        this._clearFocus();
        this._applyOutcomeFilter(); // restore the base outcome-filter dimming
    },

    /** Highlight only the tool calls matching the Outcome filter (dim the rest).
     *  Operates on session→tool edges + their tool nodes; structural edges and
     *  harness/agent nodes stay visible so the map keeps its shape. */
    _applyOutcomeFilter() {
        const f = this.outcomeFilter || 'all';
        const match = (e) => {
            if (e.tier && e.tier !== 'session-tool') return true; // structural edges always shown
            if (f === 'all') return true;
            if (f === 'allow') return e.outcome === 'allow';
            if (f === 'blocked') return e.outcome === 'blocked' || e.blocked;
            if (f === 'log_only') return e.outcome === 'log_only' || (e.log_only || 0) > 0;
            if (f === 'threat') return e.blocked || e.touched_secrets || e.risk === 'amber' || e.risk === 'red';
            return true;
        };
        const lit = new Set();
        (this._edgeEls || []).forEach(({ base, flow, e }) => {
            const on = match(e);
            base.style.opacity = on ? '' : '0.05';
            if (flow) flow.style.display = on ? '' : 'none';
            if (on && e.tier === 'session-tool') lit.add(e.target);
        });
        Object.values(this._nodeEls || {}).forEach(({ g, node }) => {
            if (f === 'all' || node.kind !== 'tool') { g.style.opacity = ''; return; }
            g.style.opacity = lit.has(node.id) ? '' : '0.12';
        });
    },

    /** Dim everything except the selected node's connected subgraph (blast radius). */
    _focusNode(n) {
        const keep = new Set([n.id]);
        (this._edgeEls || []).forEach(({ e }) => { if (e.source === n.id || e.target === n.id) { keep.add(e.source); keep.add(e.target); } });
        // Use element opacity (not stroke-opacity) so it dims both stroked
        // edges and Sankey's filled ribbons uniformly.
        (this._edgeEls || []).forEach(({ base, flow, e }) => {
            const on = e.source === n.id || e.target === n.id;
            base.style.opacity = on ? 1 : 0.08;
            if (flow) flow.style.opacity = on ? 1 : 0.06;
        });
        Object.values(this._nodeEls || {}).forEach(({ g, node }) => { g.style.opacity = keep.has(node.id) ? 1 : 0.16; });
    },

    _clearFocus() {
        (this._edgeEls || []).forEach(({ base, flow }) => { base.style.opacity = ''; if (flow) flow.style.opacity = ''; });
        Object.values(this._nodeEls || {}).forEach(({ g }) => { g.style.opacity = 1; });
    },

    // ---------------- zoom / pan / drag ----------------

    _applyView() {
        const { k, tx, ty } = this.view;
        if (this._vp) this._vp.setAttribute('transform', `translate(${tx},${ty}) scale(${k})`);
    },
    _clientToVb(ev) {
        const ctm = this._svg.getScreenCTM();
        if (!ctm) return { x: 0, y: 0 };
        const pt = this._svg.createSVGPoint();
        pt.x = ev.clientX; pt.y = ev.clientY;
        const loc = pt.matrixTransform(ctm.inverse());
        return { x: loc.x, y: loc.y };
    },
    _clampK(k) { return Math.max(this._MIN_K, Math.min(this._MAX_K, k)); },
    _zoomAt(factor, center) {
        const k0 = this.view.k, k1 = this._clampK(k0 * factor);
        if (k1 === k0) return;
        const gx = (center.x - this.view.tx) / k0, gy = (center.y - this.view.ty) / k0;
        this.view.k = k1; this.view.tx = center.x - gx * k1; this.view.ty = center.y - gy * k1;
        this._applyView();
    },
    _fitStatic() {
        // The topology layouts are pre-fitted to the viewBox; reset to identity.
        this.view = { k: 1, tx: 0, ty: 0 };
        this._applyView();
    },
    _wireViewport(svg, body) {
        svg.addEventListener('wheel', (ev) => {
            ev.preventDefault();
            const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
            this._zoomAt(factor, this._clientToVb(ev));
        }, { passive: false });
        let panning = false, startVb = null, startT = null;
        svg.addEventListener('pointerdown', (ev) => {
            if (ev.target.closest('.sv-node')) return;
            panning = true; startVb = this._clientToVb(ev); startT = { tx: this.view.tx, ty: this.view.ty };
            body.classList.add('sv-panning'); svg.setPointerCapture(ev.pointerId);
        });
        svg.addEventListener('pointermove', (ev) => {
            if (!panning) return;
            const now = this._clientToVb(ev);
            this.view.tx = startT.tx + (now.x - startVb.x); this.view.ty = startT.ty + (now.y - startVb.y);
            this._applyView();
        });
        const endPan = () => { panning = false; body.classList.remove('sv-panning'); };
        svg.addEventListener('pointerup', endPan);
        svg.addEventListener('pointercancel', endPan);
    },
    _wireNodeDrag(g, node) {
        let dragging = false, moved = false, start = null;
        g.addEventListener('pointerdown', (ev) => {
            ev.stopPropagation(); dragging = true; moved = false;
            this._hideTip();
            start = this._clientToVb(ev); g.setPointerCapture(ev.pointerId);
        });
        g.addEventListener('pointermove', (ev) => {
            if (!dragging) return;
            const vb = this._clientToVb(ev);
            if (Math.abs(vb.x - start.x) + Math.abs(vb.y - start.y) > 3) moved = true;
            node.x = (vb.x - this.view.tx) / this.view.k;
            node.y = (vb.y - this.view.ty) / this.view.k;
            g.setAttribute('transform', `translate(${node.x},${node.y})`);
            this._updateEdgesFor(node);
        });
        g.addEventListener('pointerup', () => {
            dragging = false;
            if (!moved) this.selectNode(node, g);
        });
        g.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); this.selectNode(node, g); }
        });
    },
    _updateEdgesFor(node) {
        (this._edgeEls || []).forEach(({ base, flow, srcId, tgtId }) => {
            if (srcId !== node.id && tgtId !== node.id) return;
            const A = this._byId[srcId], B = this._byId[tgtId];
            const d = this._edgePath(A, B);
            base.setAttribute('d', d); if (flow) flow.setAttribute('d', d);
        });
    },
    _addControls(body) {
        const box = document.createElement('div');
        box.className = 'sv-zoom';
        const mk = (label, aria, fn) => {
            const b = document.createElement('button');
            b.type = 'button'; b.textContent = label; b.title = aria; b.setAttribute('aria-label', aria);
            b.addEventListener('click', fn); box.appendChild(b);
        };
        const center = () => ({ x: this.W / 2, y: this.H / 2 });
        mk('+', 'Zoom in', () => this._zoomAt(1.2, center()));
        mk('−', 'Zoom out', () => this._zoomAt(1 / 1.2, center()));
        mk('⤢', 'Reset view', () => this._fitStatic());
        body.appendChild(box);
    },

    // ---------------- stats + exports ----------------

    _renderStats() {
        const el = document.getElementById('agent-map-stats');
        if (!el) return;
        const sessions = (this.data.nodes || []).filter(n => n.kind === 'session');
        const harnesses = (this.data.nodes || []).filter(n => n.kind === 'harness');
        const active = sessions.filter(n => n.active).length;
        const blocked = (this.data.edges || []).reduce((s, e) => s + (e.blocked || 0), 0);
        // distinct secret-touching tools across the fleet (posture at a glance)
        const secrets = new Set((this.data.nodes || []).filter(n => n.kind === 'tool' && n.touched_secrets).map(n => n.tool_id)).size;
        el.innerHTML =
            `<span class="sv-stat"><b>${harnesses.length}</b> harnesses</span>` +
            `<span class="sv-stat"><b>${active}</b> active agents</span>` +
            `<span class="sv-stat"><b>${sessions.length}</b> total</span>` +
            `<span class="sv-stat-sep"></span>` +
            `<span class="sv-stat ${blocked ? 'is-alert' : ''}">${ICON.ban(blocked ? '#ef4444' : '#64748b', 13)} <b>${blocked}</b> blocked</span>` +
            `<span class="sv-stat ${secrets ? 'is-watch' : ''}">${ICON.lock(secrets ? '#f59e0b' : '#64748b', 13)} <b>${secrets}</b> secret</span>`;
    },

    _renderLegend() {
        const el = document.getElementById('agent-map-legend');
        if (!el) return;
        // Legend must match what's actually drawn: edges/flow are neutral slate
        // (blocked = red), and node colour = harness identity.
        const harnessDot = Object.values(this._harnessColor || {})[0] || HARNESS_PALETTE[0];
        const flow = this.topo === 'sankey'
            ? `<span><i style="border-color:${EDGE_NEUTRAL};border-top-width:6px"></i>ribbon width = call volume</span>`
            : `<span><i style="border-color:${EDGE_NEUTRAL}"></i>tool call</span>` +
              `<span><i style="border-color:${OUTCOME_COLOR.blocked}"></i>blocked</span>`;
        el.innerHTML = flow +
            `<span class="lg-sep"></span>` +
            `<span><i class="lg-dot" style="background:${harnessDot}"></i>harness / agent</span>` +
            `<span><i class="lg-dot" style="background:${TOOL_FILL}"></i>built-in tool</span>` +
            `<span>${ICON.gear(TOOL_FILL_EXT, 14)} external / MCP</span>` +
            `<span><i class="lg-ring" style="border-color:${OUTCOME_COLOR.blocked}"></i>blocked tool</span>` +
            `<span>${ICON.lock('#f59e0b', 13)} secret / cloud</span>` +
            `<span><i class="lg-dot" style="background:${GRAY}"></i>inactive</span>`;
    },

    _edgeRows() {
        const byId = this._byId || {};
        return (this._ledges || []).filter(e => e.tier === 'session-tool').map(e => {
            const s = byId[e.source] || {}, t = byId[e.target] || {};
            return {
                agent: s.label || e.source, harness: s.harness || '',
                tool: this._toolLabel(t), kind: ObsTabs.isExternalTool(t.tool_id) ? 'external' : 'built-in',
                calls: e.calls, blocked: e.blocked ? 1 : 0, outcome: e.outcome,
            };
        });
    },
    _exportCols() {
        return [
            { label: 'harness', get: r => r.harness }, { label: 'agent', get: r => r.agent },
            { label: 'tool', get: r => r.tool }, { label: 'kind', get: r => r.kind },
            { label: 'calls', get: r => r.calls }, { label: 'blocked', get: r => r.blocked },
            { label: 'outcome', get: r => r.outcome },
        ];
    },
    _exportCSV() {
        const rows = this._edgeRows();
        if (!rows.length) return;
        ObsTabs.download('agent-map.csv', ObsTabs.toCSV(this._exportCols(), rows), 'text/csv');
    },
    _exportPDF() {
        if (!this._svg) return;
        const clone = this._svg.cloneNode(true);
        clone.setAttribute('xmlns', SVG_NS); clone.setAttribute('width', this.W); clone.setAttribute('height', this.H);
        const svgHTML = new XMLSerializer().serializeToString(clone);
        const sessions = (this.data.nodes || []).filter(n => n.kind === 'session');
        const sub = `${sessions.length} agent sessions · ${this.topo} view · last ${this.windowDays} day(s)`;
        ObsTabs.printDoc('SecureVector — Agent Map',
            `<h1>Agent Map</h1><div class="sub">${sub}</div>${svgHTML}` +
            `<h2 style="font-size:13px;margin:18px 0 6px;">Connections</h2>` +
            ObsTabs.tableHTML(this._exportCols(), this._edgeRows()));
    },

    _esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g,
            c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    },

    // ---------------- drill-downs (into Agent Runs) ----------------

    _navRuns() {
        if (window.App && typeof App.loadPage === 'function') App.loadPage('agent-runs');
    },
    // Every drill-down FULLY specifies the Runs filter (runtime + tool kinds)
    // so a previous click never leaks into the next — e.g. opening a claude-code
    // tool after viewing openclaw runs must not stay scoped to openclaw.
    _setPending(runtime, kinds) {
        if (!window.AgentRunsPage) return;
        AgentRunsPage._pendingRuntime = runtime || null;
        AgentRunsPage._pendingKinds = kinds || { builtin: true, external: true };
        AgentRunsPage._pendingTrace = null; // cleared unless an agent/tool drill sets it
        AgentRunsPage._pendingTool = null;  // cleared unless a tool drill sets it
    },
    _openRuns() { this._setPending(null, null); this._navRuns(); },              // device → all runs
    _openHarness(node) { this._setPending(node && node.label, null); this._navRuns(); },
    _openAgent(node) {
        // Open the EXACT run for this agent session (by trace_id) so Runs lands
        // on it instead of just filtering to the runtime (which showed nothing
        // precise). Runtime is still set for the filter chip context.
        this._setPending(node && node.harness, null);
        if (window.AgentRunsPage) AgentRunsPage._pendingTrace = (node && node.trace_id) || null;
        this._navRuns();
    },
    _openTool(node) {
        // Open the EXACT run this tool node belongs to (radial/tree per-session)
        // and FILTER the spans to this tool, so clicking claude-code's "Read"
        // (allow) shows Read's calls — not every built-in span of the run. Shared
        // tools (mesh/sankey) span runtimes, so no run/runtime, just the tool +
        // kind filter.
        let runtime = null, trace = null;
        if (node && node.session_id_node) {
            const s = (this.data.nodes || []).find(x => x.id === node.session_id_node);
            if (s) { runtime = s.harness; trace = s.trace_id; }
        }
        const ext = !!(node && ObsTabs.isExternalTool(node.tool_id));
        this._setPending(runtime, ext ? { builtin: false, external: true } : { builtin: true, external: false });
        if (window.AgentRunsPage) {
            AgentRunsPage._pendingTool = (node && node.tool_id) || null;
            if (trace) AgentRunsPage._pendingTrace = trace;
        }
        this._navRuns();
    },
};

window.AgentMapPage = AgentMapPage;
