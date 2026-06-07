/**
 * ObsTabs — shared Map | Runs | Timeline switcher for the Agent Observability
 * pages.
 *
 * The Agent Map (topology), Agent Runs (per-session trace) and Timeline
 * (chronological feed) views are three lenses on one feature, so they live
 * under a single sidebar entry and switch via this segmented control instead
 * of separate nav items.
 *
 * Also the one place that classifies a tool as built-in vs external: an MCP /
 * plugin tool is namespaced `server:tool` (a colon); a built-in harness tool
 * (Bash, Read, Edit, …) is a bare name. Mirrors plugins/.../lib/normalize.js,
 * which emits `server:tool` for `mcp__server__tool` and the bare name for
 * built-ins. Shared so Map, Runs and Timeline agree on the distinction.
 */
const ObsTabs = {
    // --- shared agent naming (user-given names, keyed by trace_id) ----------
    // The Map lets a user rename an agent (e.g. "agent #1" → "nightly-deploy").
    // The name is keyed by the run's trace_id and persisted locally so it
    // reflects everywhere the agent appears — Map, Runs, Timeline. Local-only
    // (localStorage); the audit log itself is never rewritten.
    AGENT_NAMES_KEY: 'sv-agent-names',
    _agentNames() {
        try { return JSON.parse(localStorage.getItem(this.AGENT_NAMES_KEY) || '{}') || {}; }
        catch (_) { return {}; }
    },
    /** Custom name for a run/agent, or null if the user hasn't named it. */
    agentName(traceId) {
        if (!traceId) return null;
        const m = this._agentNames();
        return (m && m[traceId]) || null;
    },
    /** Set (or clear, when name is empty) the custom name for a trace_id. */
    setAgentName(traceId, name) {
        if (!traceId) return;
        const m = this._agentNames();
        const v = (name || '').trim().slice(0, 60);
        if (v) m[traceId] = v; else delete m[traceId];
        try { localStorage.setItem(this.AGENT_NAMES_KEY, JSON.stringify(m)); } catch (_) {}
    },

    // --- shared "How to read this view" deep-link --------------------------
    // A small info link the Map and Runs pages place near their header/stats.
    // Clicking it opens the Guide and scrolls to the matching how-to-read
    // section. Keeps both views pointing at one source of truth.
    _injectHowtoStyle() {
        if (document.getElementById('sv-howto-style')) return;
        const st = document.createElement('style');
        st.id = 'sv-howto-style';
        st.textContent = `
            .sv-howto-link { display:inline-flex; align-items:center; gap:5px; background:transparent; cursor:pointer;
                border:1px solid var(--border-default,#30363d); border-radius:999px; padding:3px 10px;
                color:var(--text-secondary,#b1bac4); font:600 11.5px 'Avenir Next',Avenir,system-ui,sans-serif;
                transition:color .12s, border-color .12s, background .12s; white-space:nowrap; }
            .sv-howto-link:hover { color:var(--accent-primary,#5eadb8); border-color:var(--accent-primary,#5eadb8);
                background:color-mix(in srgb, var(--accent-primary,#5eadb8) 8%, transparent); }
            .sv-howto-link svg { width:13px; height:13px; flex:0 0 auto; }
        `;
        document.head.appendChild(st);
    },
    /** Build a "How to read…" link that deep-links to a Guide section. */
    howToReadLink(label, sectionId, subItemId) {
        this._injectHowtoStyle();
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sv-howto-link';
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/>' +
            '<path d="M12 16v-4M12 8h.01"/></svg><span></span>';
        btn.querySelector('span').textContent = label;
        btn.addEventListener('click', () => {
            if (window.Sidebar && Sidebar.navigateToSection) Sidebar.navigateToSection('guide', sectionId, subItemId);
        });
        return btn;
    },

    // --- shared tool classification (built-in harness vs external MCP/plugin) ---
    isExternalTool(toolId) {
        return typeof toolId === 'string' && toolId.includes(':');
    },
    toolKindLabel(toolId) {
        return this.isExternalTool(toolId) ? 'External MCP' : 'Built-in';
    },

    // --- shared export helpers (Map / Runs / Timeline all offer a download) ---
    download(filename, content, mime = 'text/plain') {
        const blob = new Blob([content], { type: mime });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
    },
    toCSV(columns, rows) {
        const esc = (v) => {
            const s = v == null ? '' : String(v);
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const head = columns.map(c => esc(c.label)).join(',');
        const body = rows.map(r => columns.map(c => esc(c.get(r))).join(',')).join('\n');
        return head + '\n' + body + '\n';
    },
    /** An "Export" split button with a CSV / PDF dropdown menu.
     *  items: [{ label, onClick }] */
    exportMenu(items) {
        const wrap = document.createElement('div');
        wrap.className = 'sv-export-wrap';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'sv-export-btn';
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg><span>Export</span>' +
            '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" ' +
            'stroke-linecap="round" stroke-linejoin="round" style="margin-left:1px"><path d="M6 9l6 6 6-6"/></svg>';
        const menu = document.createElement('div');
        menu.className = 'sv-export-menu';
        items.forEach(it => {
            const mi = document.createElement('button');
            mi.type = 'button';
            mi.className = 'sv-export-item';
            mi.textContent = it.label;
            mi.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.remove('open'); it.onClick(); });
            menu.appendChild(mi);
        });
        btn.addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('open'); });
        document.addEventListener('click', () => menu.classList.remove('open'));
        wrap.appendChild(btn); wrap.appendChild(menu);
        return wrap;
    },

    /** Open a print-ready window with the given HTML and trigger the browser's
     *  print dialog — the user picks "Save as PDF". No third-party library. */
    printDoc(title, innerHTML) {
        const w = window.open('', '_blank');
        if (!w) { if (window.Toast) Toast.error('Allow pop-ups to export PDF'); return; }
        w.document.write(
            '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title><style>' +
            'body{font:13px -apple-system,Segoe UI,Roboto,sans-serif;color:#111;margin:32px;}' +
            'h1{font-size:18px;margin:0 0 2px;} .sub{color:#666;font-size:12px;margin-bottom:18px;}' +
            'table{border-collapse:collapse;width:100%;font-size:11.5px;} th,td{border:1px solid #ddd;padding:5px 8px;text-align:left;vertical-align:top;}' +
            'th{background:#f5f5f5;font-weight:700;} tr:nth-child(even) td{background:#fafafa;}' +
            'svg{max-width:100%;height:auto;border:1px solid #eee;border-radius:6px;background:#fff;}' +
            '.badge{font-weight:700;} @media print{.noprint{display:none;}}' +
            '</style></head><body>' + innerHTML + '</body></html>');
        w.document.close(); w.focus();
        setTimeout(() => { try { w.print(); } catch (_) { /* user can print manually */ } }, 350);
    },

    /** Build an HTML <table> string from columns [{label,get}] + rows. */
    tableHTML(columns, rows) {
        const esc = (v) => String(v == null ? '' : v).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        const head = '<tr>' + columns.map(c => `<th>${esc(c.label)}</th>`).join('') + '</tr>';
        const body = rows.map(r => '<tr>' + columns.map(c => `<td>${esc(c.get(r))}</td>`).join('') + '</tr>').join('');
        return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
    },

    // Order = Map first. The topology Map is the hero view (the product's wow
    // feature), so it leads and is the default landing; Runs (per-session) and
    // Timeline (chronological feed) follow. All three are always shown.
    _TABS: [
        // label, page, inline-svg path(s) for a 24-grid icon
        { label: 'Map',      page: 'agent-map',      icon: 'M5 7h4v4H5zM15 13h4v4h-4zM9 9h6M17 11v2' },
        { label: 'Runs',     page: 'agent-runs',     icon: 'M4 6h16M4 12h16M4 18h10' },
        { label: 'Timeline', page: 'agent-timeline', icon: 'M4 12h16M7 12a2 2 0 1 0 0-.01M15 12a2 2 0 1 0 0-.01' },
    ],

    _injectStyle() {
        if (document.getElementById('sv-obs-tabs-style')) return;
        const st = document.createElement('style');
        st.id = 'sv-obs-tabs-style';
        st.textContent = `
            /* One-line header: tabs + page filters + legend on a single row to
               save vertical space. Wraps only when the viewport is narrow. */
            .obs-header { display:flex; align-items:center; gap:12px 14px; flex-wrap:wrap; margin-bottom:10px; }
            .obs-header .sv-obs-tabs { margin-bottom:0; }
            .obs-header .filter-group { margin:0; }
            /* Push the whole filter+export cluster to the far right edge, well
               clear of the tabs (margin-left:auto on the toolbar itself). */
            .obs-header .filters-bar { margin:0 0 0 auto; padding:0; border:0; background:none;
                display:flex; align-items:flex-end; gap:12px 14px; flex-wrap:wrap; }
            /* Keep every filter group the same height so their controls sit on a
               single bottom line (short ones like a lone checkbox don't float). */
            .obs-header .filter-group { min-height:40px; justify-content:flex-end; }
            .obs-header .filter-group > .sv-check, .obs-header .filter-group > .ar-kind-checks,
            .obs-header .filter-group > .sv-kind-checks { min-height:34px; align-items:center; }
            .sv-obs-tabs { display:inline-flex; gap:4px; padding:4px; border-radius:11px;
                background:var(--bg-tertiary,#21262d); border:1px solid var(--border-default,#30363d);
                margin-bottom:14px; box-shadow:var(--shadow-sm,0 1px 2px rgba(0,0,0,.2)) inset; }
            .sv-obs-tab { display:inline-flex; align-items:center; gap:7px; border:1px solid transparent;
                background:transparent; color:var(--text-secondary,#b1bac4);
                font:700 13px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.2px;
                padding:8px 18px; border-radius:8px; cursor:pointer;
                transition:color .12s,background .12s,border-color .12s,box-shadow .12s; }
            .sv-obs-tab svg { width:16px; height:16px; flex:0 0 auto; }
            .sv-obs-tab.on { background:var(--accent-primary,#5eadb8); color:#fff; border-color:var(--accent-primary,#5eadb8);
                box-shadow:0 1px 3px rgba(0,0,0,.25); }
            .sv-obs-tab.on svg { stroke:#fff; }
            .sv-obs-tab:not(.on) svg { stroke:var(--text-secondary,#b1bac4); }
            .sv-obs-tab:hover:not(.on) { color:var(--text-primary,#e6edf3); background:var(--bg-hover,#30363d); }
            .sv-obs-tab:hover:not(.on) svg { stroke:var(--text-primary,#e6edf3); }
            .sv-obs-tab:focus-visible { outline:2px solid var(--accent-primary,#5eadb8); outline-offset:2px; }
            .sv-export-btn { display:inline-flex; align-items:center; gap:6px; padding:7px 13px; border-radius:8px;
                border:1px solid var(--border-default,#30363d); background:var(--bg-card,#161b22); color:var(--text-primary,#e6edf3);
                font:600 12.5px 'Avenir Next',Avenir,system-ui,sans-serif; cursor:pointer; transition:background .12s,border-color .12s; }
            .sv-export-btn:hover { background:var(--bg-hover,#21262d); border-color:var(--accent-primary,#5eadb8); }
            .sv-export-btn:focus-visible { outline:2px solid var(--accent-primary,#5eadb8); outline-offset:2px; }
            .sv-export-btn svg { color:var(--accent-primary,#5eadb8); }
            .sv-export-wrap { position:relative; display:inline-flex; }
            .sv-export-menu { position:absolute; right:0; top:calc(100% + 5px); z-index:30; display:none; flex-direction:column;
                min-width:128px; padding:4px; border-radius:9px; background:var(--bg-card,#161b22);
                border:1px solid var(--border-default,#30363d); box-shadow:var(--shadow-lg,0 8px 24px rgba(0,0,0,.4)); }
            .sv-export-menu.open { display:flex; }
            .sv-export-item { display:flex; align-items:center; gap:8px; padding:7px 11px; border:0; border-radius:6px; background:transparent;
                color:var(--text-primary,#e6edf3); font:600 12.5px 'Avenir Next',Avenir,system-ui,sans-serif; text-align:left; cursor:pointer; }
            .sv-export-item:hover { background:var(--bg-hover,#21262d); }
        `;
        document.head.appendChild(st);
    },

    _icon(d) {
        return `<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
            `<path d="${d}"/></svg>`;
    },

    /** active: 'map' | 'runs' | 'timeline' */
    render(container, active) {
        this._injectStyle();
        const wrap = document.createElement('div');
        wrap.className = 'sv-obs-tabs';
        wrap.setAttribute('role', 'tablist');
        const activePage = { map: 'agent-map', runs: 'agent-runs', timeline: 'agent-timeline' }[active];
        this._TABS.forEach(t => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'sv-obs-tab' + (t.page === activePage ? ' on' : '');
            b.setAttribute('role', 'tab');
            b.setAttribute('aria-selected', t.page === activePage ? 'true' : 'false');
            b.dataset.p = t.page;
            b.innerHTML = this._icon(t.icon) + `<span>${t.label}</span>`;
            b.addEventListener('click', () => window.App && App.loadPage(t.page));
            wrap.appendChild(b);
        });
        container.appendChild(wrap);
    },
};
window.ObsTabs = ObsTabs;
