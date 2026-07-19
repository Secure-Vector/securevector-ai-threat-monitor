/**
 * Blocked-Action Ledger — agent-observability §3.2.
 *
 * The security-console view no pure-observability tool ships: not "what
 * happened" but "what we PREVENTED, and which policy fired." Reads the
 * blocked (action='block') rows of the tool-call audit log, aggregated by
 * reason and by tool, with hit counts. Local-first, read-only.
 *
 * SOC colour discipline: red is the blocked state (used sparingly on the
 * headline + count pills); everything structural is neutral; teal is the one
 * interactive accent.
 */

const BlockedLedgerPage = {
    _state: { windowDays: 7, data: null },

    _BAN: (c = '#ef4444', s = 14) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" style="vertical-align:-2px"><path fill="${c}" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2c1.8 0 3.5.6 4.9 1.7L5.7 16.9A8 8 0 0 1 12 4zm0 16a8 8 0 0 1-4.9-1.7L18.3 7.1A8 8 0 0 1 12 20z"/></svg>`,

    async render(container) {
        container.textContent = '';
        if (window.Header) {
            Header.setPageInfo('Blocked Actions',
                'Every prevented tool call, grouped by the policy that fired.');
        }
        this._injectStyle();

        const header = document.createElement('div');
        header.className = 'bl-header';
        const win = document.createElement('div');
        win.className = 'bl-winbar';
        win.innerHTML = '<span class="bl-winlabel">Window</span>';
        [1, 7, 30].forEach(d => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'bl-winbtn' + (this._state.windowDays === d ? ' on' : '');
            b.textContent = d === 1 ? '24h' : d + 'd';
            b.addEventListener('click', () => { this._state.windowDays = d; this.load(); });
            win.appendChild(b);
        });
        header.appendChild(win);
        container.appendChild(header);

        const body = document.createElement('div');
        body.id = 'bl-body';
        body.innerHTML = '<div class="bl-empty">Loading…</div>';
        container.appendChild(body);

        await this.load();
    },

    async load() {
        const body = document.getElementById('bl-body');
        // Re-highlight the active window button (render may not have re-run).
        document.querySelectorAll('.bl-winbtn').forEach(b => {
            const d = b.textContent === '24h' ? 1 : parseInt(b.textContent, 10);
            b.classList.toggle('on', d === this._state.windowDays);
        });
        if (body) body.innerHTML = '<div class="bl-empty">Loading…</div>';
        const data = await API.getBlockedLedger({ window_days: this._state.windowDays });
        this._state.data = data;
        this._renderBody(data);
    },

    _renderBody(data) {
        const body = document.getElementById('bl-body');
        if (!body) return;
        body.textContent = '';
        const s = data.summary || {};
        const total = s.blocked_total || 0;

        if (!total) {
            const empty = document.createElement('div');
            empty.className = 'bl-empty bl-empty-clear';
            empty.innerHTML =
                `<div class="bl-empty-icon">${this._BAN('var(--text-muted,#7d8590)', 34)}</div>` +
                `<div class="bl-empty-title">Nothing blocked in this window</div>` +
                `<div class="bl-empty-sub">No tool call hit a deny policy or a blocking threat rule in the last ` +
                `${this._winLabel()}. When enforcement stops an agent, every prevented action lands here with the ` +
                `reason that fired — your record of what SecureVector kept from running.</div>`;
            body.appendChild(empty);
            return;
        }

        // --- Summary stat row ---
        const stats = document.createElement('div');
        stats.className = 'bl-stats';
        stats.appendChild(this._stat(total, total === 1 ? 'action prevented' : 'actions prevented', true));
        stats.appendChild(this._stat(s.tools_blocked || 0, (s.tools_blocked === 1 ? 'tool' : 'tools') + ' blocked'));
        stats.appendChild(this._stat(s.agents_affected || 0, (s.agents_affected === 1 ? 'agent' : 'agents') + ' affected'));
        stats.appendChild(this._stat((data.by_reason || []).length, 'distinct ' + ((data.by_reason || []).length === 1 ? 'policy' : 'policies')));
        body.appendChild(stats);

        // --- By reason (the ledger core) ---
        body.appendChild(this._sectionTitle('What fired', 'Prevented actions grouped by the policy or rule that blocked them, most-hit first.'));
        const reasons = document.createElement('div');
        reasons.className = 'bl-reasons';
        (data.by_reason || []).forEach(r => reasons.appendChild(this._reasonCard(r, total)));
        body.appendChild(reasons);

        // --- By tool ---
        body.appendChild(this._sectionTitle('Which tools', 'The tools whose calls were blocked, by hit count.'));
        const tools = document.createElement('div');
        tools.className = 'bl-tools';
        (data.by_tool || []).forEach(t => tools.appendChild(this._toolRow(t)));
        body.appendChild(tools);

        // --- Export ---
        const foot = document.createElement('div');
        foot.className = 'bl-foot';
        const exp = ObsTabs.exportMenu([
            { label: 'Export CSV', onClick: () => this._exportCSV() },
            { label: 'Export PDF', onClick: () => this._exportPDF() },
        ]);
        foot.appendChild(exp);
        body.appendChild(foot);
    },

    _stat(value, label, danger) {
        const el = document.createElement('div');
        el.className = 'bl-stat' + (danger ? ' danger' : '');
        el.innerHTML = `<div class="bl-stat-val">${Number(value).toLocaleString()}</div>` +
            `<div class="bl-stat-label">${this._esc(label)}</div>`;
        return el;
    },

    _sectionTitle(title, sub) {
        const el = document.createElement('div');
        el.className = 'bl-sectitle';
        el.innerHTML = `<h3>${this._esc(title)}</h3><p>${this._esc(sub)}</p>`;
        return el;
    },

    /** Navigate to Traces pre-filtered: outcome ('blocked') and/or one tool.
     *  The receiving page consumes these one-shots and picks a trace that
     *  actually contains matching runs. */
    _drill(outcome, toolId) {
        if (!window.AgentRunsPage || !window.App) return;
        if (toolId) { AgentRunsPage._pendingTool = toolId; }
        if (outcome) { AgentRunsPage._pendingOutcome = outcome; }
        App.loadPage('agent-runs');
    },

    _reasonCard(r, total) {
        const card = document.createElement('div');
        card.className = 'bl-reason';
        const pct = total ? Math.round((r.count / total) * 100) : 0;
        const tools = (r.tool_names || '').split(',').filter(Boolean);
        const toolChips = tools.slice(0, 6).map(t =>
            `<span class="bl-chip">${this._esc(String(t).split(':').pop())}</span>`).join('') +
            (tools.length > 6 ? `<span class="bl-chip more">+${tools.length - 6}</span>` : '');
        const risk = r.high_risk
            ? '<span class="bl-risk">high-risk</span>' : '';
        card.innerHTML =
            `<div class="bl-reason-top">` +
            `<div class="bl-reason-count">${this._BAN('#ef4444', 13)}<b>${Number(r.count).toLocaleString()}</b></div>` +
            `<div class="bl-reason-text">${this._esc(r.reason)}${risk}</div>` +
            `</div>` +
            `<div class="bl-reason-bar"><span style="width:${pct}%"></span></div>` +
            `<div class="bl-reason-meta">` +
            `<span>${pct}% of blocks</span>` +
            `<span>${r.tools || 0} ${r.tools === 1 ? 'tool' : 'tools'}</span>` +
            `<span>${r.agents || 0} ${r.agents === 1 ? 'agent' : 'agents'}</span>` +
            `<span class="bl-reason-when">last hit ${this._rel(r.last_at)}</span>` +
            `</div>` +
            (toolChips ? `<div class="bl-reason-chips">${toolChips}</div>` : '');
        // Drill-through: a ledger group answers "what fired"; the trace answers
        // "on which agent, doing what". Click → Traces filtered to blocked runs.
        card.setAttribute('role', 'button');
        card.tabIndex = 0;
        card.title = 'View the blocked runs in Traces';
        card.addEventListener('click', () => this._drill('blocked'));
        card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._drill('blocked'); } });
        return card;
    },

    _toolRow(t) {
        const row = document.createElement('div');
        row.className = 'bl-toolrow';
        const external = ObsTabs.isExternalTool(t.tool_id);
        row.innerHTML =
            `<span class="bl-tool-name">${this._esc(t.function_name || t.tool_id || 'tool')}</span>` +
            `<span class="bl-tool-kind ${external ? 'ext' : ''}">${external ? 'External MCP' : 'Built-in'}</span>` +
            `<span class="bl-tool-when">last hit ${this._rel(t.last_at)}</span>` +
            `<span class="bl-tool-count">${this._BAN('#ef4444', 11)}<b>${Number(t.count).toLocaleString()}</b></span>`;
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.title = 'View this tool’s blocked runs in Traces';
        row.addEventListener('click', () => this._drill('blocked', t.tool_id));
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this._drill('blocked', t.tool_id); } });
        return row;
    },

    // --- exports ---
    _exportRows() {
        return (this._state.data && this._state.data.by_reason || []).map(r => ({
            reason: r.reason, count: r.count, tools: r.tools, agents: r.agents,
            high_risk: r.high_risk ? 'yes' : 'no', last_at: r.last_at,
        }));
    },
    _exportCols() {
        return [
            { label: 'reason', get: r => r.reason },
            { label: 'blocks', get: r => r.count },
            { label: 'tools', get: r => r.tools },
            { label: 'agents', get: r => r.agents },
            { label: 'high_risk', get: r => r.high_risk },
            { label: 'last_blocked', get: r => r.last_at },
        ];
    },
    _exportCSV() {
        const rows = this._exportRows();
        if (!rows.length) return;
        ObsTabs.download(`blocked-ledger-${this._state.windowDays}d.csv`,
            ObsTabs.toCSV(this._exportCols(), rows), 'text/csv');
    },
    _exportPDF() {
        const rows = this._exportRows();
        if (!rows.length) return;
        const s = (this._state.data && this._state.data.summary) || {};
        const sub = `${s.blocked_total || 0} actions prevented · ${s.tools_blocked || 0} tools · ` +
            `${s.agents_affected || 0} agents · last ${this._winLabel()}`;
        ObsTabs.printDoc('SecureVector — Blocked-Action Ledger',
            `<h1>Blocked-Action Ledger</h1><div class="sub">${sub}</div>` +
            ObsTabs.tableHTML(this._exportCols(), rows));
    },

    _winLabel() { return this._state.windowDays === 1 ? '24 hours' : this._state.windowDays + ' days'; },

    _rel(iso) {
        if (!iso) return '—';
        const t = String(iso).replace(' ', 'T') + (String(iso).endsWith('Z') ? '' : 'Z');
        const d = new Date(t);
        if (isNaN(d)) return String(iso);
        const secs = (Date.now() - d.getTime()) / 1000;
        if (secs < 60) return 'just now';
        if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
        if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
        return Math.floor(secs / 86400) + 'd ago';
    },

    _esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    },

    _injectStyle() {
        // The Export split-button styles live in ObsTabs' stylesheet, which is
        // normally injected by ObsTabs.render() — a component this page doesn't
        // use. Inject it explicitly, or a direct load of /blocked-ledger shows
        // the export menu as raw unstyled buttons.
        if (window.ObsTabs) ObsTabs._injectStyle();
        if (document.getElementById('bl-style')) return;
        const st = document.createElement('style');
        st.id = 'bl-style';
        st.textContent = `
            .bl-header { display:flex; align-items:center; margin-bottom:16px; }
            .bl-winbar { display:inline-flex; align-items:center; gap:4px; padding:4px; border-radius:10px;
                background:var(--bg-tertiary,#21262d); border:1px solid var(--border-default,#30363d); }
            .bl-winlabel { font:600 10.5px 'Avenir Next',Avenir,system-ui,sans-serif; text-transform:uppercase;
                letter-spacing:.6px; color:var(--text-muted,#7d8590); padding:0 8px; }
            .bl-winbtn { border:0; background:transparent; color:var(--text-secondary,#b1bac4);
                font:600 12px 'Avenir Next',Avenir,system-ui,sans-serif; padding:5px 12px; border-radius:7px; cursor:pointer;
                transition:color .12s, background .12s; }
            .bl-winbtn.on { background:var(--bg-card,#161b22); color:var(--text-primary,#e6edf3); box-shadow:0 1px 2px rgba(0,0,0,.25); }
            .bl-winbtn:hover:not(.on) { color:var(--text-primary,#e6edf3); }

            .bl-empty { padding:26px; color:var(--text-muted,#7d8590); font-size:13px; }
            .bl-empty-clear { text-align:center; max-width:520px; margin:48px auto; }
            .bl-empty-icon { margin-bottom:14px; opacity:.6; }
            .bl-empty-title { font:700 17px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3); margin-bottom:8px; }
            .bl-empty-sub { font-size:13px; line-height:1.6; color:var(--text-secondary,#b1bac4); }

            .bl-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:26px; }
            .bl-stat { padding:16px 18px; border-radius:12px; background:var(--bg-card,#161b22);
                border:1px solid var(--border-default,#30363d); box-shadow:var(--elevate-1,none); }
            .bl-stat.danger { border-color:color-mix(in srgb,#ef4444 45%,transparent);
                background:color-mix(in srgb,#ef4444 7%,var(--bg-card,#161b22)); }
            .bl-stat-val { font:700 28px ui-monospace,'JetBrains Mono',Menlo,monospace; color:var(--text-primary,#e6edf3);
                font-variant-numeric:tabular-nums; line-height:1; }
            .bl-stat.danger .bl-stat-val { color:#ef4444; }
            .bl-stat-label { margin-top:6px; font:600 10.5px 'Avenir Next',Avenir,system-ui,sans-serif; text-transform:uppercase;
                letter-spacing:.5px; color:var(--text-muted,#7d8590); }

            .bl-sectitle { margin:0 0 12px; }
            .bl-sectitle h3 { margin:0 0 3px; font:700 14px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3); }
            .bl-sectitle p { margin:0; font-size:12px; color:var(--text-muted,#7d8590); }

            .bl-reasons { display:flex; flex-direction:column; gap:10px; margin-bottom:28px; }
            .bl-reason { padding:14px 16px; border-radius:12px; background:var(--bg-card,#161b22);
                border:1px solid var(--border-default,#30363d); box-shadow:var(--elevate-1,none);
                cursor:pointer; transition:border-color .12s, background .12s; }
            .bl-reason:hover { border-color:var(--accent-primary,#5eadb8); background:var(--bg-hover,#1b2129); }
            .bl-reason:focus-visible, .bl-toolrow:focus-visible { outline:2px solid var(--accent-primary,#5eadb8); outline-offset:2px; }
            .bl-reason-top { display:flex; align-items:flex-start; gap:12px; }
            .bl-reason-count { display:inline-flex; align-items:center; gap:5px; flex:0 0 auto;
                font:700 15px ui-monospace,'JetBrains Mono',Menlo,monospace; color:#ef4444; font-variant-numeric:tabular-nums;
                min-width:52px; }
            .bl-reason-text { font:600 13px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3);
                line-height:1.4; word-break:break-word; }
            .bl-risk { margin-left:8px; font:700 9px 'Avenir Next',Avenir,system-ui,sans-serif; text-transform:uppercase;
                letter-spacing:.5px; color:#f59e0b; border:1px solid color-mix(in srgb,#f59e0b 50%,transparent);
                padding:1px 6px; border-radius:5px; vertical-align:1px; }
            .bl-reason-bar { height:5px; border-radius:3px; background:var(--bg-tertiary,#21262d); margin:10px 0 8px; overflow:hidden; }
            .bl-reason-bar span { display:block; height:100%; border-radius:3px; background:#ef4444; opacity:.75; }
            .bl-reason-meta { display:flex; flex-wrap:wrap; gap:14px; font-size:11px; color:var(--text-muted,#7d8590);
                font-variant-numeric:tabular-nums; }
            .bl-reason-when { margin-left:auto; }
            .bl-reason-chips { display:flex; flex-wrap:wrap; gap:5px; margin-top:9px; }
            .bl-chip { font:600 10.5px ui-monospace,'JetBrains Mono',Menlo,monospace; padding:2px 8px; border-radius:6px;
                background:var(--bg-tertiary,#21262d); color:var(--text-secondary,#b1bac4); border:1px solid var(--border-default,#30363d); }
            .bl-chip.more { color:var(--text-muted,#7d8590); }

            .bl-tools { display:flex; flex-direction:column; gap:2px; margin-bottom:24px; border-radius:12px; overflow:hidden;
                border:1px solid var(--border-default,#30363d); }
            .bl-toolrow { display:flex; align-items:center; gap:12px; padding:11px 16px; background:var(--bg-card,#161b22); cursor:pointer; }
            .bl-toolrow:hover { background:var(--bg-hover,#21262d); }
            .bl-tool-name { font:600 13px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3); }
            .bl-tool-kind { font:700 9px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.5px; text-transform:uppercase;
                padding:2px 7px; border-radius:6px; border:1px solid var(--border-default,#30363d); color:var(--text-secondary,#b1bac4); }
            .bl-tool-kind.ext { color:var(--accent-primary,#5eadb8); border-color:color-mix(in srgb,var(--accent-primary,#5eadb8) 55%,transparent);
                background:color-mix(in srgb,var(--accent-primary,#5eadb8) 12%,transparent); }
            .bl-tool-when { font-size:11px; color:var(--text-muted,#7d8590); }
            .bl-tool-count { margin-left:auto; display:inline-flex; align-items:center; gap:5px;
                font:700 13px ui-monospace,'JetBrains Mono',Menlo,monospace; color:#ef4444; font-variant-numeric:tabular-nums; }

            .bl-foot { display:flex; justify-content:flex-end; margin-top:8px; }
        `;
        document.head.appendChild(st);
    },
};
window.BlockedLedgerPage = BlockedLedgerPage;
