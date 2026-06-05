/**
 * ObsTabs — shared Map | Runs toggle for the Agent Observability pages.
 *
 * The Agent Map (topology) and Agent Runs (trace) views are two halves of one
 * feature, so they live under a single sidebar entry and switch via this
 * segmented control instead of two separate nav items.
 */
const ObsTabs = {
    _injectStyle() {
        if (document.getElementById('sv-obs-tabs-style')) return;
        const st = document.createElement('style');
        st.id = 'sv-obs-tabs-style';
        st.textContent = `
            .sv-obs-tabs { display:inline-flex; gap:2px; padding:3px; border-radius:9px;
                background:var(--bg-tertiary,#21262d); border:1px solid var(--border-default,#30363d); margin-bottom:12px; }
            .sv-obs-tab { border:0; background:transparent; color:var(--text-secondary,#b1bac4);
                font:600 12.5px 'Avenir Next',Avenir,system-ui,sans-serif; padding:5px 16px; border-radius:7px;
                cursor:pointer; transition:color .12s,background .12s; }
            .sv-obs-tab.on { background:var(--bg-card,#161b22); color:var(--text-primary,#e6edf3);
                box-shadow:var(--shadow-sm,0 1px 2px rgba(0,0,0,.2)); }
            .sv-obs-tab:hover:not(.on) { color:var(--text-primary,#e6edf3); }
        `;
        document.head.appendChild(st);
    },

    /** active: 'map' | 'runs' */
    render(container, active) {
        this._injectStyle();
        const wrap = document.createElement('div');
        wrap.className = 'sv-obs-tabs';
        const mk = (label, page, on) => `<button class="sv-obs-tab ${on ? 'on' : ''}" data-p="${page}">${label}</button>`;
        wrap.innerHTML = mk('Map', 'agent-map', active === 'map') + mk('Runs', 'agent-runs', active === 'runs');
        wrap.querySelectorAll('button').forEach(b =>
            b.addEventListener('click', () => window.App && App.loadPage(b.dataset.p)));
        container.appendChild(wrap);
    },
};
window.ObsTabs = ObsTabs;
