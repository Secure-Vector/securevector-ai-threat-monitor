/**
 * Cmd+K command palette (v5.0.0) — keyboard navigation over existing pages.
 *
 * Pure navigation chrome (idea-local-app-ux-refresh #5): no new data, no new
 * endpoints. The item list is derived from Sidebar.navItems at open time so
 * the palette can never drift from the real nav; section labels (Observe /
 * Govern / Connect) ride along for context. Recent pages float first on an
 * empty query (localStorage, ids only — no content).
 *
 * Keys: Cmd+K / Ctrl+K toggle · ↑↓ move · Enter go · Esc close.
 * Accessible: role=dialog + aria-modal, input keeps focus, options use
 * aria-selected, and prefers-reduced-motion drops the entry animation.
 */

const CommandPalette = {
    _open: false,
    _items: [],       // flattened nav catalogue (built per open)
    _filtered: [],
    _sel: 0,
    RECENTS_KEY: 'sv-palette-recents',
    MAX_RECENTS: 6,

    // ------------------------------------------------------------ catalogue

    /** Flatten Sidebar.navItems into {id, label, section, keywords}. */
    _catalogue() {
        const out = [];
        const nav = (window.Sidebar && Sidebar.navItems) || [];
        // Mirror of the sidebar's SECTION_BEFORE — the palette shows the same
        // three verbs so both surfaces read as one system.
        const sectionOf = (id) => {
            if (['dashboard', 'threats', 'agent-activity', 'agent-map', 'storylines', 'tool-activity',
                'redactions', 'costs'].includes(id)) return 'Visibility';
            if (['tool-permissions', 'rules', 'skill-scanner', 'guardian-ml',
                'cost-settings', 'governance', 'mcp-policies'].includes(id)) return 'Govern';
            if (['connect-wizard', 'guide-connect-agents', 'integrations'].includes(id) || id.startsWith('proxy-')) return 'Connect';
            if (['siem-export', 'cloud-activity'].includes(id)) return 'Cloud & Forwarders';
            return '';
        };
        const push = (id, label, extra) => {
            if (!id || id.startsWith('gs-')) return; // guide anchors need section scroll — skip
            out.push({ id, label, section: sectionOf(id), keywords: (extra || '') + ' ' + id });
        };
        nav.forEach(item => {
            if (item.id && !(item.subItems && !item.navigable)) push(item.id, item.label, item.tooltip);
            (item.subItems || []).forEach(sub => {
                if (sub.id) push(sub.id, sub.label, (item.label || '') + ' ' + (sub.aliases || []).join(' '));
            });
        });
        // A few high-value aliases people will actually type.
        push('agent-runs', 'Traces — trace + run waterfall');
        push('agent-timeline', 'Traces — Live feed');
        push('storylines', 'Traces — grouped by agent');
        push('bill-of-tools', 'Tool Inventory (SBOM)');
        push('settings', 'Settings');
        // De-dup by id, first-seen wins (nav entries beat aliases).
        const seen = new Set();
        return out.filter(i => (seen.has(i.id) ? false : (seen.add(i.id), true)));
    },

    _recents() {
        try { return JSON.parse(localStorage.getItem(this.RECENTS_KEY) || '[]') || []; }
        catch (_) { return []; }
    },
    _pushRecent(id) {
        const r = [id, ...this._recents().filter(x => x !== id)].slice(0, this.MAX_RECENTS);
        try { localStorage.setItem(this.RECENTS_KEY, JSON.stringify(r)); } catch (_) {}
    },

    // ---------------------------------------------------------------- match

    /** Subsequence fuzzy score: substring > word-start > scattered. 0 = no match. */
    _score(q, item) {
        const hay = (item.label + ' ' + item.keywords).toLowerCase();
        const needle = q.toLowerCase().trim();
        if (!needle) return 1;
        const idx = hay.indexOf(needle);
        if (idx >= 0) return 100 - Math.min(idx, 50);
        let hi = 0, matched = 0;
        for (const ch of needle) {
            if (ch === ' ') continue;
            const at = hay.indexOf(ch, hi);
            if (at < 0) return 0;
            matched++;
            hi = at + 1;
        }
        return matched > 0 ? 10 : 0;
    },

    // ------------------------------------------------------------------- ui

    _injectStyles() {
        if (document.getElementById('sv-palette-style')) return;
        const st = document.createElement('style');
        st.id = 'sv-palette-style';
        st.textContent = `
            .sv-palette-backdrop { position: fixed; inset: 0; z-index: 1000;
                background: color-mix(in srgb, #000 45%, transparent);
                backdrop-filter: blur(2px); display: flex; align-items: flex-start; justify-content: center; }
            .sv-palette { width: min(560px, calc(100vw - 40px)); margin-top: 12vh;
                background: var(--bg-card, #161b22); border: 1px solid var(--border-default, #30363d);
                border-radius: 14px; box-shadow: 0 24px 64px rgba(0,0,0,.5); overflow: hidden;
                animation: svPaletteIn .18s cubic-bezier(.2,.9,.3,1.2) both; }
            @keyframes svPaletteIn { from { opacity: 0; transform: translateY(-10px) scale(.98); }
                to { opacity: 1; transform: none; } }
            @media (prefers-reduced-motion: reduce) { .sv-palette { animation: none; } }
            .sv-palette-input { width: 100%; box-sizing: border-box; padding: 15px 18px; border: 0;
                border-bottom: 1px solid var(--border-default, #30363d); outline: none;
                background: transparent; color: var(--text-primary, #e6edf3);
                font: 600 15px 'Avenir Next', Avenir, system-ui, sans-serif; }
            .sv-palette-input::placeholder { color: var(--text-muted, #7d8590); font-weight: 500; }
            .sv-palette-list { max-height: 46vh; overflow-y: auto; padding: 6px; }
            .sv-palette-item { display: flex; align-items: center; gap: 10px; padding: 9px 12px;
                border-radius: 8px; cursor: pointer; }
            .sv-palette-item[aria-selected="true"] { background: color-mix(in srgb, var(--accent-primary, #5eadb8) 16%, transparent); }
            .sv-palette-item-label { font: 600 13px 'Avenir Next', Avenir, system-ui, sans-serif;
                color: var(--text-primary, #e6edf3); }
            .sv-palette-item[aria-selected="true"] .sv-palette-item-label { color: var(--accent-primary, #5eadb8); }
            .sv-palette-section { margin-left: auto; font: 700 9.5px 'Avenir Next', Avenir, sans-serif;
                letter-spacing: .8px; text-transform: uppercase; color: var(--text-muted, #7d8590);
                border: 1px solid var(--border-default, #30363d); border-radius: 999px; padding: 2px 8px; }
            .sv-palette-empty { padding: 22px; text-align: center; font: 500 12.5px 'Avenir Next', Avenir, sans-serif;
                color: var(--text-muted, #7d8590); }
            .sv-palette-hint { display: flex; gap: 14px; padding: 8px 14px; border-top: 1px solid var(--border-default, #30363d);
                font: 600 10.5px 'Avenir Next', Avenir, sans-serif; color: var(--text-muted, #7d8590); }
            .sv-palette-hint kbd { font: inherit; border: 1px solid var(--border-default, #30363d);
                border-radius: 4px; padding: 0 5px; margin-right: 3px; }
        `;
        document.head.appendChild(st);
    },

    open() {
        if (this._open) return;
        this._open = true;
        this._injectStyles();
        this._items = this._catalogue();

        const backdrop = document.createElement('div');
        backdrop.className = 'sv-palette-backdrop';
        backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) this.close(); });

        const box = document.createElement('div');
        box.className = 'sv-palette';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        box.setAttribute('aria-label', 'Go to page');

        const input = document.createElement('input');
        input.className = 'sv-palette-input';
        input.type = 'text';
        input.placeholder = 'Go to page…  (type to search)';
        input.setAttribute('aria-label', 'Search pages');
        box.appendChild(input);

        const list = document.createElement('div');
        list.className = 'sv-palette-list';
        list.setAttribute('role', 'listbox');
        box.appendChild(list);

        const hint = document.createElement('div');
        hint.className = 'sv-palette-hint';
        hint.innerHTML = '<span><kbd>↑↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span>';
        box.appendChild(hint);

        backdrop.appendChild(box);
        document.body.appendChild(backdrop);
        this._el = backdrop;
        this._list = list;
        this._input = input;

        const refilter = () => {
            const q = input.value;
            if (!q.trim()) {
                // Empty query: recents first, then the catalogue in nav order.
                const recents = this._recents();
                const byId = new Map(this._items.map(i => [i.id, i]));
                const rec = recents.map(id => byId.get(id)).filter(Boolean);
                const rest = this._items.filter(i => !recents.includes(i.id));
                this._filtered = [...rec, ...rest];
            } else {
                this._filtered = this._items
                    .map(i => ({ i, s: this._score(q, i) }))
                    .filter(x => x.s > 0)
                    .sort((a, b) => b.s - a.s)
                    .map(x => x.i);
            }
            this._sel = 0;
            this._renderList();
        };

        input.addEventListener('input', refilter);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); this._move(1); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); this._move(-1); }
            else if (e.key === 'Enter') { e.preventDefault(); this._go(this._filtered[this._sel]); }
            else if (e.key === 'Escape') { e.preventDefault(); this.close(); }
        });

        refilter();
        input.focus();
    },

    close() {
        if (!this._open) return;
        this._open = false;
        if (this._el) { this._el.remove(); this._el = null; }
    },

    _move(delta) {
        if (!this._filtered.length) return;
        this._sel = (this._sel + delta + this._filtered.length) % this._filtered.length;
        this._renderList();
        const el = this._list.querySelector('[aria-selected="true"]');
        if (el) el.scrollIntoView({ block: 'nearest' });
    },

    _go(item) {
        if (!item) return;
        this._pushRecent(item.id);
        this.close();
        if (window.Sidebar && typeof Sidebar.navigate === 'function') Sidebar.navigate(item.id);
        else if (window.App) App.loadPage(item.id);
    },

    _renderList() {
        const list = this._list;
        list.textContent = '';
        if (!this._filtered.length) {
            const empty = document.createElement('div');
            empty.className = 'sv-palette-empty';
            empty.textContent = 'No matching page.';
            list.appendChild(empty);
            return;
        }
        this._filtered.slice(0, 12).forEach((item, i) => {
            const row = document.createElement('div');
            row.className = 'sv-palette-item';
            row.setAttribute('role', 'option');
            row.setAttribute('aria-selected', i === this._sel ? 'true' : 'false');
            const label = document.createElement('span');
            label.className = 'sv-palette-item-label';
            label.textContent = item.label;
            row.appendChild(label);
            if (item.section) {
                const sec = document.createElement('span');
                sec.className = 'sv-palette-section';
                sec.textContent = item.section;
                row.appendChild(sec);
            }
            row.addEventListener('mouseenter', () => { this._sel = i; this._renderList(); });
            row.addEventListener('click', () => this._go(item));
            list.appendChild(row);
        });
    },
};

// Global shortcut — Cmd+K (mac) / Ctrl+K. Registered once at load; ignores
// the shortcut while a modal input someplace else has its own Cmd+K handler
// (none today). Esc-to-close is handled inside the palette's input.
document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        if (CommandPalette._open) CommandPalette.close();
        else CommandPalette.open();
    }
});

window.CommandPalette = CommandPalette;
