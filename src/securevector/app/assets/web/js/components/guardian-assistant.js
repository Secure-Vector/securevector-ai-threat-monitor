/**
 * Guardian Assistant — the floating Guardian Bot, and what it opens.
 *
 * Replaces the retired TryItChat floating panel (its launcher was removed
 * long ago; the panel was dead code). The Guardian Bot floats bottom-right —
 * bobbing, eyes wandering — and clicking it opens a compact triage panel.
 * Its main job is cost/token optimization; it also hands you the security
 * surfaces: threats, secret leaks, and blocked permission checks.
 *
 * Not a chat. Every row is real data from existing endpoints with a
 * click-through to the page that owns it, all fetched lazily on open and
 * degrading to quiet omission when an endpoint is unavailable. Dollar
 * figures stay labelled estimates; counts are facts.
 */

const GuardianAssistant = {
    _open: false,
    _panel: null,
    _fab: null,

    _bot3d: null,

    mount() {
        if (this._fab || !window.GuardianBot) return;
        this._injectStyle();
        const fab = document.createElement('button');
        fab.type = 'button';
        fab.className = 'sv-ga-fab';
        fab.title = 'Guardian: cost optimization, threats, secrets, blocked actions';
        fab.setAttribute('aria-label', 'Open Guardian');
        // Hero renderer when the machine can carry it: the real-3D Guardian
        // (Three.js + GSAP, vendored) with pointer-tracked eyes and a wave.
        // The SVG character remains the fallback — same figure, lighter.
        if (window.Guardian3D && Guardian3D.available()) {
            try { this._bot3d = Guardian3D.mount(fab, { size: 118 }); } catch (_) { this._bot3d = null; }
        }
        if (!this._bot3d) fab.appendChild(GuardianBot.el({ state: 'idle', size: 92, label: '' }));
        fab.addEventListener('click', () => {
            if (this._bot3d && !this._open) this._bot3d.wave(); // greets while the panel opens
            this.toggle();
        });
        document.body.appendChild(fab);
        this._fab = fab;
    },

    toggle() {
        if (this._open) return this.close();
        this.open();
    },

    close() {
        this._open = false;
        if (this._panel) this._panel.classList.remove('open');
    },

    async open() {
        this._open = true;
        if (!this._panel) this._build();
        this._panel.classList.add('open');
        // greeting: a quick wave from the panel bot, then back to idle
        const headBot = this._panel.querySelector('.sv-ga-headbot .sv-gbot');
        if (headBot && window.GuardianBot) {
            GuardianBot.set(headBot, 'ok');
            setTimeout(() => GuardianBot.set(headBot, 'idle'), 2600);
        }
        await this._fill();
    },

    _build() {
        const panel = document.createElement('div');
        panel.className = 'sv-ga-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Guardian');
        panel.innerHTML =
            '<div class="sv-ga-head">' +
            '<span class="sv-ga-headbot"></span>' +
            '<div><div class="sv-ga-title">Guardian</div>' +
            '<div class="sv-ga-tag">Cost first. Threats always.</div></div>' +
            '<button type="button" class="sv-ga-close" aria-label="Close">&times;</button>' +
            '</div>' +
            '<div class="sv-ga-body"><div class="sv-ga-loading">Looking around…</div></div>';
        panel.querySelector('.sv-ga-headbot')
            .appendChild(GuardianBot.el({ state: 'idle', size: 50, label: '' }));
        panel.querySelector('.sv-ga-close').addEventListener('click', () => this.close());
        document.body.appendChild(panel);
        this._panel = panel;
    },

    _row({ label, value, sub, page, tab, primary }) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'sv-ga-row' + (primary ? ' primary' : '');
        row.innerHTML =
            '<div class="sv-ga-row-text"><b></b><span></span></div>' +
            '<span class="sv-ga-row-val"></span>' +
            '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
            'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
        row.querySelector('b').textContent = label;
        row.querySelector('.sv-ga-row-text span').textContent = sub || '';
        row.querySelector('.sv-ga-row-val').textContent = value || '';
        row.addEventListener('click', () => {
            this.close();
            if (tab && window.CostsPage) CostsPage._pendingTab = tab;
            if (window.Sidebar && Sidebar.navigate) Sidebar.navigate(page);
        });
        return row;
    },

    async _fill() {
        const body = this._panel.querySelector('.sv-ga-body');
        const fmtTok = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B'
            : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
            : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(Math.round(n || 0));

        const [optStatus, blocked, analytics] = await Promise.all([
            API.getOptimizerStatus(),
            API.getBlockedLedger({ window_days: 7 }).catch(() => null),
            API.getThreatAnalytics().catch(() => null),
        ]);
        let rep = null;
        if (optStatus && optStatus.has_report) rep = await API.getOptimizerReport();
        // the FAB mirrors what the app is doing: scanning -> scan state
        const scanning = !!(optStatus && optStatus.running);
        if (this._bot3d) {
            this._bot3d.setState(scanning ? 'scan' : 'idle');
        } else if (this._fab && window.GuardianBot) {
            const fabBot = this._fab.querySelector('.sv-gbot');
            if (fabBot) GuardianBot.set(fabBot, scanning ? 'scan' : 'idle');
        }

        body.textContent = '';

        // --- the main job: cost / token optimization ---
        const sec1 = document.createElement('div');
        sec1.className = 'sv-ga-sec';
        sec1.textContent = 'Optimize';
        body.appendChild(sec1);
        if (rep && rep.observed) {
            const mode = optStatus.prefs
                && (optStatus.prefs.billing_mode || optStatus.prefs.billing_mode_derived);
            const lead = mode === 'api' && rep.observed.est_cost_usd != null
                ? `≈$${Math.round(rep.observed.est_cost_usd).toLocaleString()} → ≈$${Math.round(rep.modeled.est_cost_usd).toLocaleString()} est`
                : `${fmtTok(rep.observed.total_tokens)} → ${fmtTok(rep.modeled.total_tokens)} tok`;
            body.appendChild(this._row({
                label: 'Cost / Token Optimizer', primary: true,
                sub: `${(rep.findings || []).length} findings · last ${rep.window_days} days · modeled estimate`,
                value: lead, page: 'costs', tab: 'optimizer',
            }));
        } else {
            body.appendChild(this._row({
                label: 'Cost / Token Optimizer', primary: true,
                sub: 'Run your first scan: see why your sessions cost what they did.',
                value: '', page: 'costs', tab: 'optimizer',
            }));
        }

        // --- and the watch: threats, secrets, blocked permissions ---
        const sec2 = document.createElement('div');
        sec2.className = 'sv-ga-sec';
        sec2.textContent = 'Watch';
        body.appendChild(sec2);
        const totals = (analytics && (analytics.totals || analytics)) || {};
        const threatCount = totals.threats_detected ?? totals.total_threats ?? null;
        body.appendChild(this._row({
            label: 'Threats',
            sub: 'Detections from rules and Guardian ML.',
            value: threatCount != null ? String(threatCount) : '', page: 'threats',
        }));
        body.appendChild(this._row({
            label: 'Secret leaks',
            sub: 'Credentials and PII caught mid-flight.',
            value: '', page: 'redactions',
        }));
        body.appendChild(this._row({
            label: 'Blocked permission checks',
            sub: 'Tool calls your policies stopped.',
            value: blocked && blocked.summary && blocked.summary.blocked_total != null
                ? String(blocked.summary.blocked_total)
                : (blocked && blocked.blocked_total != null ? String(blocked.blocked_total) : ''),
            page: 'blocked-ledger',
        }));

        const foot = document.createElement('div');
        foot.className = 'sv-ga-foot';
        foot.textContent = 'Local-first. Counts are facts; dollar figures are list-price estimates.';
        body.appendChild(foot);
    },

    _injectStyle() {
        if (document.getElementById('sv-guardian-assistant-style')) return;
        const st = document.createElement('style');
        st.id = 'sv-guardian-assistant-style';
        st.textContent = `
.sv-ga-fab { position: fixed; right: 22px; bottom: 18px; z-index: 900;
  background: none; border: none; padding: 4px; cursor: pointer;
  filter: drop-shadow(0 4px 10px rgba(0,0,0,0.35));
  transition: transform 180ms ease; }
.sv-ga-fab:hover { transform: translateY(-3px) scale(1.04); }
.sv-ga-fab:focus-visible { outline: 2px solid var(--accent-primary, #5eadb8); border-radius: 12px; }
.sv-ga-panel { position: fixed; right: 22px; bottom: 100px; z-index: 899;
  width: 340px; max-width: calc(100vw - 44px); max-height: 70vh; overflow-y: auto;
  background: var(--bg-card, #12171e); border: 1px solid var(--border-light, #303844);
  border-radius: 14px; box-shadow: 0 12px 34px rgba(0,0,0,0.45);
  opacity: 0; pointer-events: none; transform: translateY(10px);
  transition: opacity 160ms ease, transform 160ms ease; }
.sv-ga-panel.open { opacity: 1; pointer-events: auto; transform: translateY(0); }
.sv-ga-head { display: flex; align-items: center; gap: 12px; padding: 14px 14px 10px;
  border-bottom: 1px solid var(--border-default, #232a33); }
.sv-ga-title { font-family: var(--font-display, inherit); font-weight: 700;
  font-size: 15px; color: var(--text-primary, #eef2f7); }
.sv-ga-tag { font-size: 11px; color: var(--text-muted, #7f8a97); }
.sv-ga-close { margin-left: auto; background: none; border: none; cursor: pointer;
  color: var(--text-muted, #7f8a97); font-size: 18px; line-height: 1; padding: 4px 8px;
  border-radius: 6px; }
.sv-ga-close:hover { color: var(--text-primary, #eef2f7); background: var(--bg-secondary, #0e1218); }
.sv-ga-body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 6px; }
.sv-ga-loading { color: var(--text-muted, #7f8a97); font-size: 12px; padding: 10px 4px; }
.sv-ga-sec { font-size: 10px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase;
  color: var(--text-muted, #7f8a97); padding: 6px 4px 2px; }
.sv-ga-row { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
  background: var(--bg-secondary, #0e1218); border: 1px solid var(--border-default, #232a33);
  border-radius: 10px; padding: 10px 12px; cursor: pointer; color: var(--text-muted, #7f8a97);
  transition: border-color 140ms ease; }
.sv-ga-row:hover { border-color: var(--accent-primary, #5eadb8); }
.sv-ga-row.primary { border-color: color-mix(in srgb, var(--accent-primary, #5eadb8) 45%, transparent); }
.sv-ga-row-text { flex: 1; min-width: 0; }
.sv-ga-row-text b { display: block; font-size: 12.5px; font-weight: 600;
  color: var(--text-primary, #eef2f7); }
.sv-ga-row-text span { display: block; font-size: 11px; color: var(--text-muted, #7f8a97);
  line-height: 1.4; margin-top: 1px; }
.sv-ga-row-val { font-family: var(--font-mono, monospace); font-size: 12px; font-weight: 700;
  color: var(--text-secondary, #aeb7c2); white-space: nowrap; }
.sv-ga-foot { font-size: 10.5px; color: var(--text-muted, #7f8a97); padding: 6px 4px 0;
  line-height: 1.4; }
`;
        document.head.appendChild(st);
    },
};

window.GuardianAssistant = GuardianAssistant;
