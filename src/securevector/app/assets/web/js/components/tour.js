/**
 * Tour — guided product walkthrough.
 *
 * A spotlight overlay that steps the user through the setup → operate flow:
 * install a plugin (or enable the proxy) → set tool permissions → cost settings
 * → rules → MCP policies → SIEM forwarding → skills → Agent Activity.
 *
 * Each step drives the real sidebar: it navigates to the relevant page,
 * expands the owning nav section, then spotlights the matching nav item and
 * anchors an explainer card next to it. No third-party library — one dimmed
 * backdrop, a box-shadow "cutout" ring, and a card. Theme-aware via the same
 * CSS variables the rest of the app uses.
 */
const Tour = {
    DONE_KEY: 'sv-tour-completed',
    _i: 0,
    _open: false,

    // Three integration paths, kept here so the copy stays accurate as
    // integrations graduate proxy → SDK → native plugin:
    //   • plugin harnesses — native one-click plugin
    //   • SDK frameworks   — two-line pip SDK (LangChain/LangGraph/CrewAI)
    //   • proxy-only        — everything else, via env-var routing
    PLUGIN_HARNESSES: 'Claude Code, Codex, and OpenClaw',
    SDK_FRAMEWORKS: 'LangChain, LangGraph, CrewAI, and Hermes',
    PROXY_ONLY: 'n8n, Ollama, and any OpenAI-compatible app',

    steps() {
        return [
            {
                nav: 'guide-connect-agents', go: 'guide-connect-agents',
                badge: 'Set up', title: 'Connect your agents',
                body: `Start here — <b>Connect Agents</b> is the front door. Pick your agent or harness ` +
                    `(${this.PLUGIN_HARNESSES} ship a <b>native plugin</b>; ${this.SDK_FRAMEWORKS} use a ` +
                    `<b>two-line SDK</b>), choose <b>where SecureVector runs</b> — this device or your cloud — and ` +
                    `copy the commands. Not sure what you have? Let it <b>detect what's already on this device</b> ` +
                    `and jump straight to the right steps.`,
            },
            {
                nav: 'integrations', go: 'proxy-claude-code', expand: 'integrations',
                badge: 'Reference', title: 'Full per-agent reference',
                body: `Need the detail? <b>Integrations</b> is the deep per-agent reference — install, verify, ` +
                    `troubleshoot, and <b>self-host / auth</b> for a remote engine — plus <b>proxy-only</b> tools ` +
                    `without a plugin or SDK (${this.PROXY_ONLY}). Connect Agents is the quick path; this is the manual.`,
            },
            {
                nav: 'tool-permissions', go: 'tool-permissions',
                badge: 'Configure', title: 'Set tool permissions',
                body: `Decide what each agent may do: <b>allow</b>, <b>block</b>, or <b>log-only</b> per tool. ` +
                    `By default every harness built-in tool is <b>allowed</b> — tighten the ones you don't want running.`,
            },
            {
                nav: 'cost-settings', go: 'cost-settings',
                badge: 'Configure', title: 'Cost settings',
                body: `Set dollar <b>budgets and pricing</b> for <b>proxy-based</b> agents. Claude Code and Codex ` +
                    `run on your own subscription, so there's no per-call dollar cost — they're still tracked, ` +
                    `but <b>Cost Tracking shows token usage</b> for them instead of dollars.`,
            },
            {
                nav: 'rules', go: 'rules',
                badge: 'Configure', title: 'Rules',
                body: `The local rule engine auto-blocks or alerts on matches. Want curated cloud rule packs? ` +
                    `Create an account, turn on <b>Cloud Connect</b>, sync the rules you like — then switch Cloud mode ` +
                    `<b>back off</b> if you want all analysis to stay fully local.`,
            },
            {
                nav: 'mcp-policies', go: 'mcp-policies',
                badge: 'Cloud · optional', title: 'MCP Policies',
                body: `Optional and cloud-enabled. Sync tool policies set by your <b>org admin</b> and manage ` +
                    `<b>multiple devices</b> centrally. Skip it if you're running a single local install.`,
            },
            {
                nav: 'siem-export', go: 'siem-export',
                badge: 'Connect', title: 'SIEM Forwarder',
                body: `Forward <b>tool runs, threats, and metadata</b> to the SIEM of your choice — Splunk, Datadog, ` +
                    `Sentinel, QRadar, Chronicle, OTLP, or any HTTPS webhook.`,
            },
            {
                nav: 'skill-scanner', go: 'skill-scanner',
                badge: 'Optional', title: 'Skill Scanner',
                body: `Optional <b>static analysis</b> of agent skills — no code is executed. It flags risky ` +
                    `network / file / exec patterns before you trust a skill.`,
            },
            {
                nav: 'agent-activity', go: 'agent-map', expand: 'agent-activity',
                badge: 'Operate', title: 'Watch your agents',
                body: `Head to <b>Agent Activity</b>. Explore your runs as an <b>Agent Map</b> ` +
                    `(Tree · Radial · Mesh · Sankey), the <b>Runs</b> list, and the <b>Timeline</b> — and keep an eye ` +
                    `on <b>Secret Detections</b> and <b>Cost Tracking</b>.`,
            },
            {
                nav: 'guide', go: 'guide', expand: 'guide',
                badgeSvg: '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" ' +
                    'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-1px"><path d="M20 6 9 17l-5-5"/></svg>',
                badge: 'All set', title: 'Open the Guide any time',
                body: `That's the whole flow. The <b>Guide</b> has step-by-step docs for every harness plugin and ` +
                    `feature — open it from here whenever you need the detail.`,
            },
        ];
    },

    _injectStyle() {
        if (document.getElementById('sv-tour-style')) return;
        const st = document.createElement('style');
        st.id = 'sv-tour-style';
        st.textContent = `
            .sv-tour-backdrop { position:fixed; inset:0; z-index:9998; background:transparent; cursor:default; }
            .sv-tour-ring { position:fixed; z-index:9999; border-radius:11px; pointer-events:none;
                box-shadow:0 0 0 3px var(--accent-primary,#5eadb8), 0 0 0 9999px rgba(3,7,13,.66), 0 0 22px rgba(94,173,184,.5);
                transition:top .32s cubic-bezier(.4,0,.2,1), left .32s cubic-bezier(.4,0,.2,1),
                    width .32s cubic-bezier(.4,0,.2,1), height .32s cubic-bezier(.4,0,.2,1); }
            .sv-tour-card { position:fixed; z-index:10000; width:340px; max-width:calc(100vw - 32px);
                background:var(--bg-card,#161b22); color:var(--text-primary,#e6edf3);
                border:1px solid var(--border-default,#30363d); border-radius:14px;
                box-shadow:0 18px 50px rgba(0,0,0,.5); padding:18px 18px 14px;
                font-family:'Avenir Next',Avenir,system-ui,sans-serif;
                opacity:0; transform:translateY(6px); transition:opacity .22s ease, transform .22s ease; }
            .sv-tour-card.in { opacity:1; transform:translateY(0); }
            /* left-pointing caret toward the spotlight */
            .sv-tour-card::before { content:''; position:absolute; left:-8px; top:26px; width:14px; height:14px;
                background:var(--bg-card,#161b22); border-left:1px solid var(--border-default,#30363d);
                border-bottom:1px solid var(--border-default,#30363d); transform:rotate(45deg); }
            .sv-tour-card.caret-right::before { left:auto; right:-8px; transform:rotate(225deg); }
            .sv-tour-card.caret-none::before { display:none; }
            .sv-tour-top { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px; }
            .sv-tour-badge { font-size:10px; font-weight:800; letter-spacing:.6px; text-transform:uppercase;
                color:var(--accent-primary,#5eadb8); background:color-mix(in srgb, var(--accent-primary,#5eadb8) 14%, transparent);
                border:1px solid color-mix(in srgb, var(--accent-primary,#5eadb8) 34%, transparent);
                padding:3px 9px; border-radius:999px; }
            .sv-tour-x { background:none; border:none; color:var(--text-muted,#7d8590); font-size:18px; line-height:1;
                cursor:pointer; padding:2px 6px; border-radius:6px; transition:color .12s, background .12s; }
            .sv-tour-x:hover { color:var(--text-primary,#e6edf3); background:var(--bg-hover,#21262d); }
            .sv-tour-title { font-size:16px; font-weight:800; margin:0 0 7px; color:var(--text-primary,#e6edf3); }
            .sv-tour-body { font-size:13px; line-height:1.62; color:var(--text-secondary,#b1bac4); margin:0 0 15px; }
            .sv-tour-body b { color:var(--text-primary,#e6edf3); font-weight:700; }
            .sv-tour-foot { display:flex; align-items:center; justify-content:space-between; gap:10px; }
            .sv-tour-dots { display:flex; gap:5px; }
            .sv-tour-dots i { width:6px; height:6px; border-radius:50%; background:var(--border-default,#30363d); transition:background .2s, transform .2s; }
            .sv-tour-dots i.on { background:var(--accent-primary,#5eadb8); transform:scale(1.35); }
            .sv-tour-btns { display:flex; gap:8px; }
            .sv-tour-btn { font:700 12.5px 'Avenir Next',Avenir,system-ui,sans-serif; padding:7px 14px; border-radius:8px;
                cursor:pointer; border:1px solid var(--border-default,#30363d); background:transparent;
                color:var(--text-secondary,#b1bac4); transition:background .12s, color .12s, border-color .12s; }
            .sv-tour-btn:hover { background:var(--bg-hover,#21262d); color:var(--text-primary,#e6edf3); }
            .sv-tour-btn.primary { background:var(--accent-primary,#5eadb8); border-color:var(--accent-primary,#5eadb8); color:#fff; }
            .sv-tour-btn.primary:hover { filter:brightness(1.06); color:#fff; }
            .sv-tour-skip { font-size:11.5px; color:var(--text-muted,#7d8590); cursor:pointer; background:none; border:none; padding:4px; }
            .sv-tour-skip:hover { color:var(--text-secondary,#b1bac4); text-decoration:underline; }
        `;
        document.head.appendChild(st);
    },

    start(fromStep) {
        this._injectStyle();
        this._open = true;
        this._i = fromStep || 0;

        this._backdrop = document.createElement('div');
        this._backdrop.className = 'sv-tour-backdrop';
        // Block accidental app interaction; clicking the dim area does nothing
        // (Skip / Esc to leave) so a stray click can't silently end the tour.
        this._backdrop.addEventListener('click', (e) => e.stopPropagation());

        this._ring = document.createElement('div');
        this._ring.className = 'sv-tour-ring';

        this._card = document.createElement('div');
        this._card.className = 'sv-tour-card';
        this._card.setAttribute('role', 'dialog');
        this._card.setAttribute('aria-modal', 'true');
        this._card.setAttribute('aria-label', 'Product tour');

        document.body.appendChild(this._backdrop);
        document.body.appendChild(this._ring);
        document.body.appendChild(this._card);

        this._onKey = (e) => {
            if (!this._open) return;
            if (e.key === 'Escape') { this.end(false); }
            else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); this.next(); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); this.prev(); }
        };
        document.addEventListener('keydown', this._onKey);
        this._onResize = () => this._position();
        window.addEventListener('resize', this._onResize);

        this._show();
    },

    next() { if (this._i >= this.steps().length - 1) { this.end(true); } else { this._i++; this._show(); } },
    prev() { if (this._i > 0) { this._i--; this._show(); } },

    _show() {
        const steps = this.steps();
        const step = steps[this._i];

        // Drive the real navigation: expand the owning section + load the page
        // so the spotlit nav item matches what's on screen.
        if (window.Sidebar) {
            if (step.expand) Sidebar.expandSection(step.expand);
            Sidebar.navigate(step.go || step.nav);
        }

        this._renderCard(step, steps.length);
        // Sidebar items already exist (sidebar isn't re-rendered on navigate);
        // wait one frame so expandSection's display change + any scroll settle.
        requestAnimationFrame(() => requestAnimationFrame(() => this._position()));
    },

    _target(step) {
        const sel = step.sub
            ? `.nav-sub-item[data-page="${step.nav}"]`
            : `.nav-item[data-page="${step.nav}"]:not(.nav-sub-item)`;
        return document.querySelector(sel);
    },

    _position() {
        const step = this.steps()[this._i];
        const el = this._target(step);

        if (!el) {
            // No nav item (collapsed/mobile sidebar) — center the card, hide ring.
            this._ring.style.opacity = '0';
            this._card.classList.add('caret-none');
            this._card.style.left = '50%';
            this._card.style.top = '50%';
            this._card.style.transform = 'translate(-50%, -50%)';
            requestAnimationFrame(() => this._card.classList.add('in'));
            return;
        }

        // Instant (not smooth) scroll — a smooth/animated scroll resolves after
        // we read the rect, so the fixed-position ring would land on whatever
        // item slid into the old coordinates. Instant scroll updates layout
        // synchronously, so the rect below is already correct.
        try { el.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (_) {}
        const r = el.getBoundingClientRect();
        const pad = 6;
        this._ring.style.opacity = '1';
        this._ring.style.top = (r.top - pad) + 'px';
        this._ring.style.left = (r.left - pad) + 'px';
        this._ring.style.width = (r.width + pad * 2) + 'px';
        this._ring.style.height = (r.height + pad * 2) + 'px';

        // Card to the right of the sidebar item by default; flip left if it
        // would overflow the viewport.
        const cardW = Math.min(340, window.innerWidth - 32);
        this._card.style.transform = 'none';
        let left = r.right + 16;
        let caret = 'left';
        if (left + cardW > window.innerWidth - 12) {
            left = Math.max(12, r.left - cardW - 16);
            caret = 'right';
        }
        let top = r.top - 18;
        const cardH = this._card.offsetHeight || 220;
        if (top + cardH > window.innerHeight - 12) top = Math.max(12, window.innerHeight - cardH - 12);
        if (top < 12) top = 12;

        this._card.classList.toggle('caret-right', caret === 'right');
        this._card.classList.remove('caret-none');
        this._card.style.left = left + 'px';
        this._card.style.top = top + 'px';
        requestAnimationFrame(() => this._card.classList.add('in'));
    },

    _renderCard(step, total) {
        this._card.classList.remove('in');
        this._card.textContent = '';

        const top = document.createElement('div');
        top.className = 'sv-tour-top';
        const badge = document.createElement('span');
        badge.className = 'sv-tour-badge';
        // badge / badgeSvg are authored static strings (no user input).
        badge.innerHTML = (step.badgeSvg || '') + (step.badge || `Step ${this._i + 1}`);
        top.appendChild(badge);
        const x = document.createElement('button');
        x.className = 'sv-tour-x';
        x.setAttribute('aria-label', 'Close tour');
        x.textContent = '×';
        x.addEventListener('click', () => this.end(false));
        top.appendChild(x);
        this._card.appendChild(top);

        const h = document.createElement('div');
        h.className = 'sv-tour-title';
        h.textContent = `${this._i + 1}. ${step.title}`;
        this._card.appendChild(h);

        const body = document.createElement('div');
        body.className = 'sv-tour-body';
        body.innerHTML = step.body;  // static, authored copy — no user input
        this._card.appendChild(body);

        const foot = document.createElement('div');
        foot.className = 'sv-tour-foot';

        const dots = document.createElement('div');
        dots.className = 'sv-tour-dots';
        for (let k = 0; k < total; k++) {
            const d = document.createElement('i');
            if (k === this._i) d.className = 'on';
            dots.appendChild(d);
        }
        foot.appendChild(dots);

        const btns = document.createElement('div');
        btns.className = 'sv-tour-btns';
        if (this._i > 0) {
            const back = document.createElement('button');
            back.className = 'sv-tour-btn';
            back.textContent = 'Back';
            back.addEventListener('click', () => this.prev());
            btns.appendChild(back);
        }
        const next = document.createElement('button');
        next.className = 'sv-tour-btn primary';
        next.textContent = this._i === total - 1 ? 'Finish' : 'Next';
        next.addEventListener('click', () => this.next());
        btns.appendChild(next);
        foot.appendChild(btns);
        this._card.appendChild(foot);

        // Skip link only matters before the final step.
        if (this._i < total - 1) {
            const skipRow = document.createElement('div');
            skipRow.style.cssText = 'text-align:center; margin-top:9px;';
            const skip = document.createElement('button');
            skip.className = 'sv-tour-skip';
            skip.textContent = 'Skip tour';
            skip.addEventListener('click', () => this.end(false));
            skipRow.appendChild(skip);
            this._card.appendChild(skipRow);
        }

        // Move keyboard focus to the primary action for keyboard users.
        setTimeout(() => { try { next.focus(); } catch (_) {} }, 60);
    },

    end(completed) {
        this._open = false;
        document.removeEventListener('keydown', this._onKey);
        window.removeEventListener('resize', this._onResize);
        [this._backdrop, this._ring, this._card].forEach(el => { if (el && el.parentNode) el.remove(); });
        this._backdrop = this._ring = this._card = null;
        if (completed) {
            try { localStorage.setItem(this.DONE_KEY, '1'); } catch (_) {}
            if (window.Toast) Toast.success("You're set up — explore Agent Activity any time.");
        }
    },
};

window.Tour = Tour;
