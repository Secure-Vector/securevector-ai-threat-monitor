/**
 * Agent Map — active-agent-observability #143 (the hero graph)
 *
 * A force-directed network node map of the agent fleet: AGENT nodes (the
 * runtime that emitted the calls) connected to the TOOL / MCP nodes they
 * invoked. Organic 2D force layout (charge repulsion + link springs + gravity),
 * thin edges coloured by ENFORCEMENT OUTCOME (blocked pops red; allow/log
 * stay calm), tool-call traffic animated as flowing dashes, and hover-only
 * labels so a dense fleet stays readable.
 *
 * Interaction: wheel / button zoom (around the cursor), background pan, and
 * draggable + pinnable nodes. Local-first, read-only. Hand-rolled SVG (no
 * graph library), following the replay.js createElementNS idiom.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

// Risk + outcome map to SecureVector's own status colours (danger / warning /
// success), NOT a generic graph palette.
const RISK_COLOR = { red: '#ef4444', amber: '#f59e0b', green: '#10b981' };
const OUTCOME_COLOR = { blocked: '#ef4444', log_only: '#64748b', allow: '#10b981' };
// Per-agent fills derived from the SecureVector brand (teal accent-primary
// #5eadb8) — a cool teal/cyan/blue/indigo family, on-brand and deliberately
// NOT the warm purple/yellow of a generic network graph. Deep enough to read
// on both the dark (#0d1117) and light (#ffffff) themes. Reds/ambers/greens are
// reserved for risk semantics, so they're kept out of this palette.
// Spread across the cool spectrum (hue + lightness) so each agent is clearly
// distinguishable — teal leads (brand), then blue, indigo, cyan, deep-teal,
// sky, periwinkle, dark-cyan. Avoids near-duplicate teals.
const AGENT_PALETTE = ['#5eadb8', '#3b82f6', '#8b5cf6', '#06b6d4', '#6366f1', '#0d9488', '#38bdf8', '#155e75'];
const TOOL_FILL = '#64748b'; // neutral slate — keeps tools subordinate to agents, legible on dark + light

// Inline SVG icons (no emojis — crisp + theme-consistent at any size).
const LOCK_PATH = 'M12 1a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5zm3 8H9V6a3 3 0 0 1 6 0z';
const BAN_PATH = 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2c1.8 0 3.5.6 4.9 1.7L5.7 16.9A8 8 0 0 1 12 4zm0 16a8 8 0 0 1-4.9-1.7L18.3 7.1A8 8 0 0 1 12 20z';
const ICON = {
    lock: (c = '#f59e0b', s = 12) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" style="vertical-align:-2px"><path fill="${c}" d="${LOCK_PATH}"/></svg>`,
    ban: (c = '#ef4444', s = 12) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" style="vertical-align:-2px"><path fill="${c}" d="${BAN_PATH}"/></svg>`,
};

const AgentMapPage = {
    windowDays: 7,
    focus: 'all', // 'all' | 'blocked' | 'secret' | '<agent node id>'
    data: { nodes: [], edges: [], truncated: false, dropped_edges: 0 },

    W: 1000,
    H: 620,
    view: { k: 1, tx: 0, ty: 0 },
    _MIN_K: 0.2,
    _MAX_K: 4,

    async render(container) {
        container.textContent = '';
        if (window.Header) {
            Header.setPageInfo('Agent Activity', 'Live map of which agents are calling which tools — and what we blocked');
        }
        this._injectStyle();
        ObsTabs.render(container, 'map');

        const toolbar = document.createElement('div');
        toolbar.className = 'filters-bar';
        toolbar.id = 'agent-map-toolbar';
        container.appendChild(toolbar);

        const stats = document.createElement('div');
        stats.id = 'agent-map-stats';
        container.appendChild(stats);

        const body = document.createElement('div');
        body.id = 'agent-map-body';
        body.style.cssText = 'position:relative;width:100%;height:620px;border:1px solid var(--border-default,#30363d);border-radius:12px;overflow:hidden;background:radial-gradient(130% 130% at 25% 0%, rgba(13,148,136,.05), transparent 55%), var(--bg-card,#161b22);';
        container.appendChild(body);

        this._buildToolbar(toolbar);
        await this.loadData();
    },

    _injectStyle() {
        if (document.getElementById('agent-map-style')) return;
        const st = document.createElement('style');
        st.id = 'agent-map-style';
        st.textContent = `
            @keyframes svFlow { to { stroke-dashoffset: -17.5; } }
            @keyframes svPulse { 0%,100% { opacity: .55; } 50% { opacity: 1; } }
            /* Solid connection line. */
            .sv-edge-base { pointer-events: stroke; }
            /* A bright dot travelling along the solid line — the "water flow". */
            .sv-edge-flow { stroke-dasharray: 1.5 16; stroke-linecap: round; animation: svFlow linear infinite; pointer-events: none; }
            .sv-edge-blocked { animation: svFlow linear infinite, svPulse 1.2s ease-in-out infinite; }
            @media (prefers-reduced-motion: reduce) { .sv-edge-flow, .sv-edge-blocked { animation: none !important; } }
            .sv-node { cursor: grab; }
            .sv-node:active { cursor: grabbing; }
            /* Calm nodes wear a quiet theme-aware outline; elevated risk overrides inline. */
            .sv-node-dot { stroke: var(--border-default,#30363d); stroke-width: 1.5; }
            .sv-node:hover .sv-node-dot, .sv-node:focus .sv-node-dot { stroke-width: 3; filter: brightness(1.12); }
            .sv-node.sv-pinned .sv-node-dot { stroke-dasharray: 2 2; }
            /* Always-on label in a refined sans (Avenir Next), small + lightly
               tracked; halo uses the card bg so it reads over edges. */
            .sv-node-label { font: 600 10px 'Avenir Next','Avenir','Segoe UI Variable',system-ui,-apple-system,sans-serif;
                letter-spacing:.2px; pointer-events:none; user-select:none;
                opacity: .94; transition: opacity .1s; paint-order: stroke; stroke: var(--bg-card,#161b22); stroke-width: 3px; }
            .sv-node:hover .sv-node-label, .sv-node:focus .sv-node-label { opacity: 1; }
            /* Slim summary line — only the numbers you can't count by eye
               (blocked, secret) are emphasised; the rest is quiet context. */
            #agent-map-stats { display:flex; align-items:center; gap:13px; flex-wrap:wrap; margin:6px 2px 10px;
                font-size:11px; color:var(--text-secondary,#b1bac4); }
            .sv-stat { display:inline-flex; align-items:baseline; gap:5px; }
            .sv-stat b { font:600 12px ui-monospace,'JetBrains Mono','SF Mono',Menlo,monospace; font-variant-numeric:tabular-nums; color:var(--text-primary,#e6edf3); }
            .sv-stat-sep { width:1px; height:14px; background:var(--border-default,#30363d); }
            .sv-stat.is-alert, .sv-stat.is-alert b { color:var(--danger,#ef4444); }
            .sv-stat.is-watch, .sv-stat.is-watch b { color:var(--warning,#f59e0b); }
            #agent-map-body.sv-panning { cursor: grabbing; }
            #agent-map-legend span { display:inline-flex; align-items:center; gap:5px; margin-right:13px; font-size:11.5px; color:var(--text-secondary,#b1bac4); }
            #agent-map-legend i { width:16px; height:0; border-top:3px solid; display:inline-block; }
            #agent-map-legend .lg-dot { width:9px; height:9px; border:0; border-top:0; border-radius:50%; }
            #agent-map-legend .lg-sep { width:1px; height:13px; padding:0; background:var(--border-default,#30363d); margin-right:13px; }
            .sv-zoom { position:absolute; top:12px; right:12px; display:flex; flex-direction:column; gap:6px; z-index:5; }
            .sv-zoom button { width:32px; height:32px; display:flex; align-items:center; justify-content:center;
                font-size:16px; line-height:1; border-radius:8px; cursor:pointer;
                background:var(--bg-card,#161b22); color:var(--text-primary,#e2e8f0); border:1px solid var(--border-default,#30363d);
                box-shadow:var(--shadow-sm,0 1px 2px rgba(0,0,0,.2)); transition:background .12s,border-color .12s; }
            .sv-zoom button:hover { background:var(--bg-hover,#21262d); border-color:var(--accent-primary,#5eadb8); }
            .sv-zoom button:focus-visible { outline:2px solid var(--accent-primary,#5eadb8); outline-offset:1px; }
            .sv-hint { position:absolute; left:12px; bottom:10px; font-size:11px; color:var(--text-muted,#64748b); z-index:5; user-select:none; }
            /* Rich hover tooltip — per-agent (or per-tool) call breakdown. */
            .sv-tooltip { position:absolute; z-index:10; pointer-events:none; min-width:160px; max-width:280px;
                background:var(--bg-card,#161b22); color:var(--text-primary,#e6edf3); border:1px solid var(--border-default,#30363d);
                border-radius:8px; padding:7px 9px; font:11px ui-sans-serif,system-ui,sans-serif;
                box-shadow:var(--shadow-lg,0 8px 24px rgba(0,0,0,.4)); opacity:0; transition:opacity .08s; }
            .sv-tooltip.show { opacity:1; }
            .sv-tt-title { font-weight:600; font-size:12px; display:flex; align-items:center; gap:6px; margin-bottom:2px; }
            .sv-tt-sub { color:var(--text-secondary,#b1bac4); font-size:10.5px; margin-bottom:5px; }
            .sv-tt-row { display:flex; justify-content:space-between; gap:16px; padding:1px 0; }
            .sv-tt-row b { font-family:ui-monospace,'JetBrains Mono','SF Mono',Menlo,monospace; font-variant-numeric:tabular-nums; }
            .sv-tt-blk { color:var(--danger,#ef4444); }
            .sv-tt-dot { width:9px; height:9px; border-radius:50%; display:inline-block; flex:0 0 auto; }
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

        // Focus filter — the persona convergence: cut the graph to what you
        // care about (SOC → blocked · CISO → secret · indie → one agent).
        const fgrp = document.createElement('div');
        fgrp.className = 'filter-group';
        const flbl = document.createElement('label');
        flbl.textContent = 'Focus';
        fgrp.appendChild(flbl);
        const fsel = document.createElement('select');
        fsel.className = 'filter-select';
        fsel.id = 'agent-map-focus';
        fsel.addEventListener('change', () => { this.focus = fsel.value; this._applyFocus(); });
        fgrp.appendChild(fsel);
        bar.appendChild(fgrp);
        this._focusSel = fsel;

        const legend = document.createElement('div');
        legend.id = 'agent-map-legend';
        legend.style.cssText = 'margin-left:auto;display:flex;align-items:center;flex-wrap:wrap;';
        legend.innerHTML =
            `<span><i style="border-color:${OUTCOME_COLOR.allow};opacity:.6"></i>allowed</span>` +
            `<span><i style="border-color:${OUTCOME_COLOR.log_only}"></i>log-only</span>` +
            `<span><i style="border-color:${OUTCOME_COLOR.blocked}"></i>blocked</span>` +
            `<span class="lg-sep"></span>` +
            `<span><i class="lg-dot" style="background:${AGENT_PALETTE[0]}"></i>agent</span>` +
            `<span><i class="lg-dot" style="background:${TOOL_FILL}"></i>tool / MCP</span>` +
            `<span>${ICON.lock('#f59e0b', 13)} secret / cloud</span>`;
        bar.appendChild(legend);
    },

    async loadData() {
        const body = document.getElementById('agent-map-body');
        if (body) {
            body.innerHTML = '<div class="loading" style="padding:40px;text-align:center;color:var(--text-secondary,#b1bac4);">Loading agent map…</div>';
        }
        this.data = await API.getAgentToolGraph({ window_days: this.windowDays });
        this._assignAgentColors();
        this.draw();
    },

    _assignAgentColors() {
        let i = 0;
        this._agentColor = {};
        (this.data.nodes || []).filter(n => n.kind === 'agent').forEach(n => {
            this._agentColor[n.id] = AGENT_PALETTE[i % AGENT_PALETTE.length];
            i += 1;
        });
    },

    _nodeFill(n) {
        return n.kind === 'agent' ? (this._agentColor[n.id] || AGENT_PALETTE[0]) : TOOL_FILL;
    },

    draw() {
        const body = document.getElementById('agent-map-body');
        if (!body) return;
        body.textContent = '';

        const nodes = this.data.nodes || [];
        const edges = this.data.edges || [];
        if (!nodes.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding:64px 24px;text-align:center;color:var(--text-secondary,#b1bac4);';
            empty.innerHTML = '<div style="font-size:15px;margin-bottom:6px;">No tool activity in this window.</div>' +
                '<div style="font-size:13px;">Install a SecureVector Guard plugin and run an agent — every tool call shows up here.</div>';
            body.appendChild(empty);
            return;
        }

        const W = this.W, H = this.H;
        this._layout(nodes, edges, W, H);

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label',
            `Agent–tool graph: ${nodes.filter(n => n.kind === 'agent').length} agents, ` +
            `${nodes.filter(n => n.kind === 'tool').length} tools, ${edges.length} connections`);
        this._svg = svg;

        const bg = document.createElementNS(SVG_NS, 'rect');
        bg.setAttribute('x', 0); bg.setAttribute('y', 0);
        bg.setAttribute('width', W); bg.setAttribute('height', H);
        bg.setAttribute('fill', 'transparent');
        svg.appendChild(bg);

        const vp = document.createElementNS(SVG_NS, 'g');
        vp.setAttribute('id', 'sv-vp');
        svg.appendChild(vp);
        this._vp = vp;

        const byId = {};
        nodes.forEach(n => { byId[n.id] = n; });

        // Edges (under nodes): a SOLID connection line + a bright dot that
        // travels along it (the "water flow"). Outcome-coloured; blocked pops.
        this._edgeEls = [];
        edges.forEach(e => {
            const s = byId[e.source], t = byId[e.target];
            if (!s || !t) return;
            const blocked = e.outcome === 'blocked';
            const color = OUTCOME_COLOR[e.outcome] || OUTCOME_COLOR.allow;
            const width = +Math.max(0.7, Math.min(1.6, Math.log2((e.calls || 1) + 1) * 0.32)).toFixed(2);

            const base = document.createElementNS(SVG_NS, 'line');
            base.setAttribute('x1', s.x); base.setAttribute('y1', s.y);
            base.setAttribute('x2', t.x); base.setAttribute('y2', t.y);
            base.setAttribute('stroke', color);
            base.setAttribute('stroke-width', width);
            base.setAttribute('stroke-opacity', blocked ? '0.9' : '0.42');
            base.setAttribute('stroke-linecap', 'round');
            base.setAttribute('class', 'sv-edge-base');
            const title = document.createElementNS(SVG_NS, 'title');
            title.textContent = `${s.label} → ${t.label}: ${e.calls} call(s), ${e.blocked} blocked`;
            base.appendChild(title);
            base.style.cursor = 'pointer';
            base.addEventListener('click', () => this._openTool(t));
            vp.appendChild(base);

            const flow = document.createElementNS(SVG_NS, 'line');
            flow.setAttribute('x1', s.x); flow.setAttribute('y1', s.y);
            flow.setAttribute('x2', t.x); flow.setAttribute('y2', t.y);
            flow.setAttribute('stroke', color);
            flow.setAttribute('stroke-width', Math.max(width + 0.5, 1.6));
            flow.setAttribute('stroke-opacity', '0.95');
            flow.setAttribute('class', blocked ? 'sv-edge-flow sv-edge-blocked' : 'sv-edge-flow');
            // Speed ∝ call volume — busier edges flow faster.
            flow.style.animationDuration = `${Math.max(0.5, 2.4 - Math.log2((e.calls || 1) + 1) * 0.3)}s`;
            vp.appendChild(flow);

            this._edgeEls.push({ lines: [base, flow], s, t, e });
        });

        // Nodes — solid fill (per-runtime palette / tool slate), risk ring.
        this._nodeEls = {};
        nodes.forEach(n => {
            const g = document.createElementNS(SVG_NS, 'g');
            g.setAttribute('class', 'sv-node');
            g.setAttribute('tabindex', '0');
            g.setAttribute('transform', `translate(${n.x},${n.y})`);

            const r = n.kind === 'agent' ? 13 : 8;
            const fill = this._nodeFill(n);
            const dot = document.createElementNS(SVG_NS, 'circle');
            dot.setAttribute('class', 'sv-node-dot');
            dot.setAttribute('r', r);
            dot.setAttribute('fill', fill);
            // Only elevated risk gets a coloured ring, so blocked/secret nodes
            // stand out; calm nodes wear a quiet dark outline.
            dot.setAttribute('stroke', n.risk === 'green' ? 'rgba(2,6,23,.6)' : RISK_COLOR[n.risk]);
            dot.setAttribute('stroke-width', n.risk === 'green' ? 1.5 : 3);
            g.appendChild(dot);

            // Lock badge on secret / cloud-managed tools so a CISO spots the
            // sensitive surface at a glance (only the few that qualify).
            if (n.kind === 'tool' && (n.cloud_managed || n.touched_secrets)) {
                const lock = document.createElementNS(SVG_NS, 'path');
                lock.setAttribute('d', LOCK_PATH);
                lock.setAttribute('fill', '#f59e0b');
                lock.style.stroke = 'var(--bg-card, #161b22)'; // halo (CSS var works in .style, not in a presentation attr)
                lock.setAttribute('stroke-width', '2.5');
                lock.setAttribute('paint-order', 'stroke');
                lock.setAttribute('pointer-events', 'none');
                lock.setAttribute('transform', `translate(${r - 5}, ${-(r + 7)}) scale(0.5)`);
                g.appendChild(lock);
            }

            const label = document.createElementNS(SVG_NS, 'text');
            label.setAttribute('class', 'sv-node-label');
            label.setAttribute('text-anchor', 'middle');
            label.setAttribute('dy', r + 13); // below the node, always visible
            // Agents wear their identity colour; tools stay neutral text so the
            // coloured agents read as the primary actors.
            label.style.fill = n.kind === 'agent' ? fill : 'var(--text-secondary, #b1bac4)';
            label.textContent = n.label.length > 26 ? n.label.slice(0, 25) + '…' : n.label;
            g.appendChild(label);

            // Rich hover tooltip (per-agent / per-tool call breakdown) replaces
            // the native <title>.
            g.addEventListener('mouseenter', (ev) => this._showTip(n, ev));
            g.addEventListener('mousemove', (ev) => this._moveTip(ev));
            g.addEventListener('mouseleave', () => this._hideTip());
            g.addEventListener('focus', () => this._showTipAtNode(n));
            g.addEventListener('blur', () => this._hideTip());

            this._wireNodeDrag(g, n);
            vp.appendChild(g);
            this._nodeEls[n.id] = { g, node: n };
        });

        body.appendChild(svg);
        this._body = body;
        this._byId = byId;
        this._edges = edges;
        this._buildTooltip(body);
        this._renderStats();
        this._refreshFocusOptions();
        this._applyFocus();
        this._wireViewport(svg, body);
        this._addControls(body);

        if (this.data.truncated) {
            const note = document.createElement('div');
            note.className = 'sv-hint';
            note.style.color = '#f59e0b';
            note.textContent = `Top ${this.data.node_cap} edges by volume — ${this.data.dropped_edges} hidden.`;
            body.appendChild(note);
        } else {
            const hint = document.createElement('div');
            hint.className = 'sv-hint';
            hint.textContent = 'Hover a node for its name · scroll to zoom · drag canvas to pan · drag a node to pin it';
            body.appendChild(hint);
        }

        this._fit();
    },

    // ---------------- force-directed layout ----------------

    /**
     * Organic 2D force layout: charge repulsion (every pair pushes apart),
     * link springs (edges pull to an ideal length), and a gentle gravity that
     * keeps the graph centred. Deterministic golden-angle seed → the same
     * fleet always settles to the same shape (stable across reloads + tests).
     * Pinned nodes (user-dragged) are fixed anchors the rest relaxes around.
     */
    _layout(nodes, edges, W, H) {
        const cx = W / 2, cy = H / 2;
        const byId = {};
        nodes.forEach(n => { byId[n.id] = n; });
        const agents = nodes.filter(n => n.kind === 'agent');
        const tools = nodes.filter(n => n.kind === 'tool');
        const ringR = (count) => Math.max(120, Math.min(Math.min(W, H) * 0.5 - 70, count * 26));

        // EGO / STAR layout — a single agent sits dead-centre with its tools
        // ringed around it. The clean hub-and-spokes shape for the indie-dev
        // (one agent) case; avoids the lopsided look of a generic force layout.
        if (agents.length === 1 && !agents[0].pinned && tools.length) {
            agents[0].x = cx; agents[0].y = cy;
            const r = ringR(tools.length);
            tools.forEach((t, i) => {
                if (t.pinned) return;
                const a = (i / tools.length) * Math.PI * 2 - Math.PI / 2;
                t.x = cx + r * Math.cos(a); t.y = cy + r * Math.sin(a);
            });
            return;
        }
        // INVERSE EGO — a single shared tool hub with many agents around it.
        if (tools.length === 1 && agents.length > 1 && !tools[0].pinned) {
            tools[0].x = cx; tools[0].y = cy;
            const r = ringR(agents.length);
            agents.forEach((a, i) => {
                if (a.pinned) return;
                const ang = (i / agents.length) * Math.PI * 2 - Math.PI / 2;
                a.x = cx + r * Math.cos(ang); a.y = cy + r * Math.sin(ang);
            });
            return;
        }

        // GENERAL CASE — seed agents evenly on a WIDE ring so they start (and
        // stay) spread out around the canvas instead of collapsing to the centre.
        const R = Math.min(W, H) * 0.36;
        agents.forEach((n, i) => {
            if (n.pinned) return;
            const a = (i / Math.max(1, agents.length)) * Math.PI * 2 - Math.PI / 2;
            n.x = cx + R * Math.cos(a);
            n.y = cy + R * Math.sin(a);
        });
        // Seed each tool near the mean position of the agents that call it, so
        // it settles in that agent's neighbourhood rather than the middle.
        const GA = Math.PI * (3 - Math.sqrt(5));
        tools.forEach((n, i) => {
            if (n.pinned) return;
            const conn = edges.filter(e => e.target === n.id).map(e => byId[e.source]).filter(Boolean);
            let bx = cx, by = cy;
            if (conn.length) {
                bx = conn.reduce((s, a) => s + a.x, 0) / conn.length;
                by = conn.reduce((s, a) => s + a.y, 0) / conn.length;
            }
            const rr = 40 + (i % 5) * 14;
            n.x = bx + rr * Math.cos(i * GA);
            n.y = by + rr * Math.sin(i * GA);
        });

        // Lower gravity + strong agent↔agent repulsion keeps the agents fanned
        // out (high-degree nodes would otherwise sink to the centre).
        const REPULSE = 9000, LINK = 115, SPRING = 0.045, GRAVITY = 0.01, AGENT_MULT = 4.5;
        let alpha = 1;
        for (let it = 0; it < 340; it++) {
            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
                    const a = nodes[i], b = nodes[j];
                    let dx = a.x - b.x, dy = a.y - b.y;
                    let d2 = dx * dx + dy * dy;
                    if (d2 < 1) { d2 = 1; dx = (i - j) || 1; dy = 1; }
                    const d = Math.sqrt(d2);
                    let f = (REPULSE * alpha) / d2;
                    if (a.kind === 'agent' && b.kind === 'agent') f *= AGENT_MULT;
                    const ux = dx / d, uy = dy / d;
                    if (!a.pinned) { a.x += ux * f; a.y += uy * f; }
                    if (!b.pinned) { b.x -= ux * f; b.y -= uy * f; }
                }
            }
            for (const e of edges) {
                const s = byId[e.source], t = byId[e.target];
                if (!s || !t) continue;
                const dx = t.x - s.x, dy = t.y - s.y;
                const d = Math.sqrt(dx * dx + dy * dy) || 1;
                const diff = ((d - LINK) / d) * SPRING * alpha;
                if (!s.pinned) { s.x += dx * diff; s.y += dy * diff; }
                if (!t.pinned) { t.x -= dx * diff; t.y -= dy * diff; }
            }
            for (const n of nodes) {
                if (n.pinned) continue;
                n.x += (cx - n.x) * GRAVITY * alpha;
                n.y += (cy - n.y) * GRAVITY * alpha;
            }
            alpha *= 0.992;
        }
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
        const k0 = this.view.k;
        const k1 = this._clampK(k0 * factor);
        if (k1 === k0) return;
        const gx = (center.x - this.view.tx) / k0;
        const gy = (center.y - this.view.ty) / k0;
        this.view.k = k1;
        this.view.tx = center.x - gx * k1;
        this.view.ty = center.y - gy * k1;
        this._applyView();
    },

    _fit() {
        const nodes = (this.data.nodes || []);
        if (!nodes.length || !this._svg) return;
        const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
        const pad = 42;
        const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
        const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
        const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
        const k = this._clampK(Math.min(this.W / bw, this.H / bh));
        this.view.k = k;
        this.view.tx = (this.W - bw * k) / 2 - minX * k;
        this.view.ty = (this.H - bh * k) / 2 - minY * k;
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
            panning = true;
            startVb = this._clientToVb(ev);
            startT = { tx: this.view.tx, ty: this.view.ty };
            body.classList.add('sv-panning');
            svg.setPointerCapture(ev.pointerId);
        });
        svg.addEventListener('pointermove', (ev) => {
            if (!panning) return;
            const now = this._clientToVb(ev);
            this.view.tx = startT.tx + (now.x - startVb.x);
            this.view.ty = startT.ty + (now.y - startVb.y);
            this._applyView();
        });
        const endPan = () => { panning = false; body.classList.remove('sv-panning'); };
        svg.addEventListener('pointerup', endPan);
        svg.addEventListener('pointercancel', endPan);
    },

    _wireNodeDrag(g, node) {
        let dragging = false, moved = false, start = null;
        g.addEventListener('pointerdown', (ev) => {
            ev.stopPropagation();
            dragging = true; moved = false;
            start = this._clientToVb(ev);
            g.setPointerCapture(ev.pointerId);
        });
        g.addEventListener('pointermove', (ev) => {
            if (!dragging) return;
            const vb = this._clientToVb(ev);
            if (Math.abs(vb.x - start.x) + Math.abs(vb.y - start.y) > 3) moved = true;
            node.x = (vb.x - this.view.tx) / this.view.k;
            node.y = (vb.y - this.view.ty) / this.view.k;
            node.pinned = true;
            g.classList.add('sv-pinned');
            g.setAttribute('transform', `translate(${node.x},${node.y})`);
            this._updateEdgesFor(node);
        });
        g.addEventListener('pointerup', () => {
            dragging = false;
            if (!moved) {
                node.kind === 'tool' ? this._openTool(node) : this._openAgent(node);
            }
        });
        g.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                node.kind === 'tool' ? this._openTool(node) : this._openAgent(node);
            }
        });
    },

    _updateEdgesFor(node) {
        (this._edgeEls || []).forEach(({ lines, s, t }) => {
            lines.forEach(line => {
                if (s === node) { line.setAttribute('x1', node.x); line.setAttribute('y1', node.y); }
                if (t === node) { line.setAttribute('x2', node.x); line.setAttribute('y2', node.y); }
            });
        });
    },

    _addControls(body) {
        const box = document.createElement('div');
        box.className = 'sv-zoom';
        const mk = (label, aria, fn) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = label;
            b.title = aria; b.setAttribute('aria-label', aria);
            b.addEventListener('click', fn);
            box.appendChild(b);
        };
        const center = () => ({ x: this.W / 2, y: this.H / 2 });
        mk('+', 'Zoom in', () => this._zoomAt(1.2, center()));
        mk('−', 'Zoom out', () => this._zoomAt(1 / 1.2, center()));
        mk('⤢', 'Fit to view', () => this._fit());
        body.appendChild(box);
    },

    // ---------------- stats + tooltip ----------------

    _renderStats() {
        const el = document.getElementById('agent-map-stats');
        if (!el) return;
        const nodes = this.data.nodes || [], edges = this.data.edges || [];
        const agents = nodes.filter(n => n.kind === 'agent').length;
        const tools = nodes.filter(n => n.kind === 'tool');
        const blockedCalls = edges.reduce((s, e) => s + (e.blocked || 0), 0);
        const secretTools = tools.filter(n => n.cloud_managed || n.touched_secrets).length;
        el.innerHTML =
            `<span class="sv-stat"><b>${agents}</b> agents</span>` +
            `<span class="sv-stat"><b>${tools.length}</b> tools / MCP</span>` +
            `<span class="sv-stat"><b>${edges.length}</b> connections</span>` +
            `<span class="sv-stat-sep"></span>` +
            `<span class="sv-stat ${blockedCalls ? 'is-alert' : ''}">${ICON.ban(blockedCalls ? '#ef4444' : '#64748b', 13)} <b>${blockedCalls}</b> blocked</span>` +
            `<span class="sv-stat ${secretTools ? 'is-watch' : ''}">${ICON.lock(secretTools ? '#f59e0b' : '#64748b', 13)} <b>${secretTools}</b> secret / cloud</span>`;
    },

    _refreshFocusOptions() {
        const sel = this._focusSel;
        if (!sel) return;
        const cur = this.focus || 'all';
        const agents = (this.data.nodes || []).filter(n => n.kind === 'agent');
        const opts = [
            ['all', 'All'],
            ['blocked', 'Blocked only'],
            ['secret', 'Secret / cloud only'],
            ...agents.map(a => [a.id, `Agent: ${a.label}`]),
        ];
        sel.innerHTML = opts.map(([v, t]) => `<option value="${this._esc(v)}">${this._esc(t)}</option>`).join('');
        sel.value = opts.some(o => o[0] === cur) ? cur : 'all';
        this.focus = sel.value;
    },

    /** Highlight the focused subset, dim the rest. Re-styles in place (no relayout). */
    _applyFocus() {
        const f = this.focus || 'all';
        const matched = new Set();
        (this._edgeEls || []).forEach(ed => {
            let m;
            if (f === 'all') m = true;
            else if (f === 'blocked') m = ed.e.outcome === 'blocked';
            else if (f === 'secret') m = !!(ed.t.cloud_managed || ed.t.touched_secrets);
            else m = ed.s.id === f; // agent node id
            const dim = !(f === 'all' || m);
            ed.lines.forEach(l => { l.style.opacity = dim ? '0.08' : ''; });
            if (m) { matched.add(ed.s.id); matched.add(ed.t.id); }
        });
        Object.values(this._nodeEls || {}).forEach(({ g, node }) => {
            g.style.opacity = (f === 'all' || matched.has(node.id)) ? '' : '0.12';
        });
    },

    _buildTooltip(body) {
        if (this._tip && this._tip.parentNode === body) return;
        const tip = document.createElement('div');
        tip.className = 'sv-tooltip';
        body.appendChild(tip);
        this._tip = tip;
    },

    // Escape agent-controlled strings (tool/agent names) before they hit
    // innerHTML — a hostile tool/MCP name must not execute (XSS). The values
    // originate from untrusted agent activity, not the trusted local user.
    _esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g,
            c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    },

    /** Per-counterpart call breakdown: tools → by agent, agents → by tool. */
    _breakdownFor(node) {
        const edges = this._edges || [], byId = this._byId || {};
        let rows;
        if (node.kind === 'tool') {
            rows = edges.filter(e => e.target === node.id).map(e => ({
                label: (byId[e.source] || {}).label || e.source,
                color: this._nodeFill(byId[e.source] || { kind: 'agent', id: e.source }),
                calls: e.calls, blocked: e.blocked,
            }));
        } else {
            rows = edges.filter(e => e.source === node.id).map(e => ({
                label: (byId[e.target] || {}).label || e.target,
                color: TOOL_FILL,
                calls: e.calls, blocked: e.blocked,
            }));
        }
        rows.sort((a, b) => b.calls - a.calls);
        return {
            total: rows.reduce((s, r) => s + r.calls, 0),
            blocked: rows.reduce((s, r) => s + r.blocked, 0),
            rows,
        };
    },

    _showTip(node, ev) {
        if (!this._tip) return;
        const b = this._breakdownFor(node);
        const isTool = node.kind === 'tool';
        const sub = isTool ? 'called by agent' : 'calls by tool';
        const secret = (node.cloud_managed || node.touched_secrets) ? ` ${ICON.lock('#f59e0b', 12)}` : '';
        const head =
            `<div class="sv-tt-title"><span class="sv-tt-dot" style="background:${this._nodeFill(node)}"></span>${this._esc(node.label)}${secret}</div>` +
            `<div class="sv-tt-sub">${isTool ? 'Tool / MCP' : 'Agent'} · ${b.total} call(s)` +
            `${b.blocked ? ` · <span class="sv-tt-blk">${b.blocked} blocked</span>` : ''} · ${sub}</div>`;
        const rows = b.rows.map(r =>
            `<div class="sv-tt-row"><span><span class="sv-tt-dot" style="background:${r.color}"></span> ${this._esc(r.label)}</span>` +
            `<b>${r.calls}${r.blocked ? ` <span class="sv-tt-blk">${ICON.ban('#ef4444', 11)}${r.blocked}</span>` : ''}</b></div>`).join('');
        this._tip.innerHTML = head + (rows || '<div class="sv-tt-sub">no connections</div>');
        this._tip.classList.add('show');
        if (ev) this._moveTip(ev);
    },

    _showTipAtNode(node) {
        this._showTip(node, null);
        const el = this._nodeEls[node.id];
        if (!el || !this._body) return;
        const nr = el.g.getBoundingClientRect(), br = this._body.getBoundingClientRect();
        this._tip.style.left = Math.min(br.width - (this._tip.offsetWidth || 200) - 6, nr.left - br.left + 16) + 'px';
        this._tip.style.top = Math.max(6, nr.top - br.top) + 'px';
    },

    _moveTip(ev) {
        if (!this._tip || !this._body) return;
        const rect = this._body.getBoundingClientRect();
        const tw = this._tip.offsetWidth || 200, th = this._tip.offsetHeight || 80;
        let x = ev.clientX - rect.left + 14;
        let y = ev.clientY - rect.top + 14;
        if (x + tw > rect.width) x = ev.clientX - rect.left - tw - 14;
        if (y + th > rect.height) y = rect.height - th - 8;
        this._tip.style.left = Math.max(6, x) + 'px';
        this._tip.style.top = Math.max(6, y) + 'px';
    },

    _hideTip() {
        if (this._tip) this._tip.classList.remove('show');
    },

    // ---------------- drill-downs ----------------

    _openTool() {
        if (window.App && typeof App.loadPage === 'function') App.loadPage('tool-activity');
    },

    _openAgent() {
        // Agent-node click → the per-agent trace (Agent Runs / #142).
        if (window.App && typeof App.loadPage === 'function') App.loadPage('agent-runs');
    },
};

window.AgentMapPage = AgentMapPage;
