/**
 * Policies hub: the one place that lists everything deciding what an agent
 * may do. Each card is a door to an existing page (tool permissions, rules,
 * egress policy, cost settings, MCP policies) with one live line so the
 * overview already answers "is anything waiting for me".
 */
const PoliciesHubPage = {
    CARDS: [
        { id: 'tool-permissions', title: 'Tool Permissions', icon: 'lock',
          desc: 'Allow, block or log-only per tool. Pending just-in-time requests wait here.' },
        { id: 'rules', title: 'Rules', icon: 'shield',
          desc: 'Auto-block or alert on threats that match your own criteria.' },
        { id: 'egress-policy', title: 'Egress Policy', icon: 'proxy',
          desc: 'Where agents may reach: allow, block or log per destination.' },
        { id: 'cost-settings', title: 'Cost Settings', icon: 'costs',
          desc: 'Budgets, per-run limits and model pricing.' },
        { id: 'mcp-policies', title: 'MCP Policies', icon: 'integrations', cloud: true,
          desc: 'Org-managed tool rules synced from your SecureVector account.' },
        { id: 'skill-scanner', title: 'Skills Scanner', icon: 'scan',
          desc: 'Static analysis and policy for skill directories.' },
    ],

    async render(container) {
        if (window.Header && typeof Header.setPageInfo === 'function') {
            Header.setPageInfo('Policies', 'Everything that decides what an agent may do.');
        }
        this._injectStyle();
        container.textContent = '';
        const grid = document.createElement('div');
        grid.className = 'ph-grid';
        this.CARDS.forEach(card => grid.appendChild(this._card(card)));
        container.appendChild(grid);
        this._loadLive(grid);
    },

    _card(card) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'ph-card';
        el.dataset.page = card.id;
        const head = document.createElement('div');
        head.className = 'ph-head';
        if (window.Sidebar && typeof Sidebar.createIcon === 'function') head.appendChild(Sidebar.createIcon(card.icon));
        const title = document.createElement('span');
        title.className = 'ph-title';
        title.textContent = card.title;
        head.appendChild(title);
        if (card.cloud) {
            const tier = document.createElement('span');
            tier.className = 'ph-tier';
            tier.textContent = 'Cloud';
            head.appendChild(tier);
        }
        el.appendChild(head);
        const desc = document.createElement('p');
        desc.className = 'ph-desc';
        desc.textContent = card.desc;
        el.appendChild(desc);
        const live = document.createElement('div');
        live.className = 'ph-live';
        live.dataset.liveFor = card.id;
        live.textContent = '';
        el.appendChild(live);
        el.addEventListener('click', () => {
            if (window.Sidebar) Sidebar.navigate(card.id);
            else if (window.App) App.loadPage(card.id);
        });
        return el;
    },

    _setLive(grid, id, text, state) {
        const el = grid.querySelector(`.ph-live[data-live-for="${id}"]`);
        if (!el) return;
        el.textContent = text;
        el.classList.toggle('ph-live-attn', state === 'attn');
    },

    async _loadLive(grid) {
        if (typeof API === 'undefined') return;
        const num = (r) => (typeof r === 'number' ? r : Number((r && (r.count ?? r.total)) || 0));
        API.getRules().then(r => {
            const n = num(r && (r.total ?? (r.items ? r.items.length : 0)));
            this._setLive(grid, 'rules', n === 1 ? '1 rule active' : `${n} rules active`);
        }).catch(() => {});
        API.getJitRequests('pending').then(r => {
            const list = Array.isArray(r) ? r : ((r && (r.items || r.requests)) || []);
            const n = list.length;
            this._setLive(grid, 'tool-permissions',
                n === 0 ? 'No requests waiting' : (n === 1 ? '1 request waiting for you' : `${n} requests waiting for you`),
                n > 0 ? 'attn' : '');
        }).catch(() => {});
        API.getEgressPolicy().then(r => {
            const preset = r && (r.preset || r.active_preset || r.name);
            if (preset) this._setLive(grid, 'egress-policy', `Preset: ${String(preset).replace(/^\w/, c => c.toUpperCase())}`);
        }).catch(() => {});
    },

    _injectStyle() {
        if (document.getElementById('policies-hub-style')) return;
        const st = document.createElement('style');
        st.id = 'policies-hub-style';
        st.textContent = `
.ph-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }
.ph-card { text-align: left; font: inherit; color: var(--text-primary); background: var(--bg-secondary);
  border: 1px solid var(--border-default); border-radius: var(--radius-lg, 12px); padding: 16px 18px; cursor: pointer;
  display: flex; flex-direction: column; gap: 8px; min-height: 132px; transition: border-color .15s, transform .15s; }
.ph-card:hover { border-color: var(--accent-primary); transform: translateY(-1px); }
.ph-card:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
.ph-head { display: flex; align-items: center; gap: 10px; }
.ph-head svg { width: 18px; height: 18px; color: var(--text-secondary); flex-shrink: 0; }
.ph-title { font-weight: 600; font-size: 14px; flex: 1; }
.ph-tier { font-size: 9px; font-weight: 700; letter-spacing: .4px; text-transform: uppercase; padding: 1px 6px;
  border-radius: 999px; border: 1px solid var(--border-default); color: var(--text-secondary); }
.ph-desc { margin: 0; font-size: 12.5px; line-height: 1.45; color: var(--text-secondary); flex: 1; }
.ph-live { font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary); min-height: 14px; }
.ph-live-attn { color: #f59e0b; }
`;
        document.head.appendChild(st);
    },
};
window.PoliciesHubPage = PoliciesHubPage;
