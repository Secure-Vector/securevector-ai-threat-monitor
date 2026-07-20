/**
 * Connect Wizard — detect → protect → verify in one guided flow.
 *
 * The activation path for v5.0.0: scans this device for agent runtimes
 * (via /api/detection/agents — the same rollup the Agent Map uses), offers
 * one-click Guard plugin install per detected harness (the existing
 * /api/hooks/<slug>/install handlers), then live-verifies the first
 * protected tool call by polling until the runtime's audit activity
 * appears. Frameworks (SDK route) render as copy-paste cards since their
 * agents run in the user's own Python environment.
 *
 * Auto-launched once on a fresh install with no connected runtimes (see
 * App.maybeAutoLaunchWizard) and re-runnable any time from the sidebar.
 * No backend of its own — pure composition over existing endpoints.
 */

const ConnectWizardPage = {
    // slug → install endpoint. OpenClaw predates the per-slug prefixes and
    // keeps its legacy /api/hooks root.
    INSTALL_URLS: {
        'claude-code': '/api/hooks/claude-code/install',
        'codex': '/api/hooks/codex/install',
        'copilot-cli': '/api/hooks/copilot-cli/install',
        'cursor': '/api/hooks/cursor/install',
        'openclaw': '/api/hooks/install',
    },
    GUIDES: {
        'claude-code': 'guide-claude-code',
        'codex': 'guide-codex',
        'copilot-cli': 'guide-copilot-cli',
        'cursor': 'guide-cursor',
        'openclaw': 'guide-openclaw',
    },
    // SDK route — agents live in the user's environment, so these stay
    // copy-paste. Command strings mirror guide-connect-agents.
    FRAMEWORKS: [
        { id: 'langchain', label: 'LangChain', pkg: 'securevector-sdk-langchain' },
        { id: 'langgraph', label: 'LangGraph', pkg: 'securevector-sdk-langgraph' },
        { id: 'crewai',    label: 'CrewAI',    pkg: 'securevector-sdk-crewai' },
        { id: 'hermes',    label: 'Hermes',    pkg: 'securevector-sdk-hermes' },
    ],

    pollTimer: null,
    root: null,
    // slug → { phase: 'installing'|'awaiting'|'verified'|'error',
    //          baselineCalls, nextStep, commands }
    installState: {},

    async render(container) {
        this.stopPolling();
        this.installState = {};
        this._injectStyles();

        if (window.Header) Header.setPageInfo(
            'Connect Wizard',
            'Detect → protect → verify. Your runtimes under guard in about two minutes.'
        );

        container.textContent = '';
        const root = document.createElement('div');
        root.className = 'wiz';
        this.root = root;
        container.appendChild(root);

        root.appendChild(this._stepper(1));

        // --- Scan phase (brief, honest: the API is fast, the sweep gives the
        // reveal a beat so the cards land as a moment, not a flash) ---
        const scanPanel = document.createElement('div');
        scanPanel.className = 'wiz-scan';
        scanPanel.innerHTML =
            '<div class="wiz-scan-ring"><div class="wiz-scan-sweep"></div></div>' +
            '<div class="wiz-scan-label">Scanning this device for agent runtimes…</div>';
        root.appendChild(scanPanel);

        const [data] = await Promise.all([
            this._fetchAgents(),
            new Promise(r => setTimeout(r, this._reducedMotion() ? 0 : 900)),
        ]);
        scanPanel.remove();

        if (!data) {
            const err = document.createElement('div');
            err.className = 'wiz-error';
            err.textContent = 'Could not reach the local detection API. Is the app still starting? Refresh to retry.';
            root.appendChild(err);
            return;
        }

        this._renderResults(data);
        this._startPolling();
    },

    // ------------------------------------------------------------------ data

    async _fetchAgents() {
        try {
            const res = await fetch('/api/detection/agents');
            if (!res.ok) return null;
            return await res.json();
        } catch (_) {
            return null;
        }
    },

    // --------------------------------------------------------------- results

    _renderResults(data) {
        const root = this.root;
        // Everything below the stepper is rebuilt on each poll tick; the
        // stepper survives so its step state can advance in place.
        root.querySelectorAll('.wiz-body').forEach(el => el.remove());

        const body = document.createElement('div');
        body.className = 'wiz-body';
        root.appendChild(body);

        const harnesses = (data.harnesses || []);
        const detected = harnesses.filter(h => h.detected || h.plugin_connected);
        const absent = harnesses.filter(h => !h.detected && !h.plugin_connected);
        const protectedCount = detected.filter(h => this._isProtected(h)).length;

        // Stepper: 1 Scan (nothing found yet) · 2 Protect (installs pending)
        // · 3 Verify (an install is awaiting its first call) · 4 = all steps
        // done (every detected runtime protected).
        const anyAwaiting = Object.values(this.installState)
            .some(st => st && st.phase === 'awaiting');
        this._setStep(!detected.length ? 1
            : (protectedCount === detected.length ? 4
                : (anyAwaiting ? 3 : 2)));

        // --- Summary line ---
        const summary = document.createElement('div');
        summary.className = 'wiz-summary';
        const uncoveredTotal = (data.summary && data.summary.unprotected_sessions) || 0;
        if (detected.length) {
            let txt = `${detected.length} runtime${detected.length === 1 ? '' : 's'} found on this device` +
                ` — Guard active on ${protectedCount}`;
            if (uncoveredTotal > 0) {
                txt += ` · ≈${uncoveredTotal} session${uncoveredTotal === 1 ? '' : 's'} not yet covered`;
            }
            summary.textContent = txt;
        } else {
            summary.textContent = 'No agent harnesses found on this device — use the SDK route below, or install a harness and re-run the wizard.';
        }
        body.appendChild(summary);

        // --- Detected harness cards ---
        if (detected.length) {
            const grid = document.createElement('div');
            grid.className = 'wiz-grid';
            detected.forEach((h, i) => grid.appendChild(this._harnessCard(h, i)));
            body.appendChild(grid);
        }

        // --- Absent harnesses (dimmed, one compact row) ---
        if (absent.length) {
            const row = document.createElement('div');
            row.className = 'wiz-absent';
            row.appendChild(Object.assign(document.createElement('span'),
                { className: 'wiz-absent-label', textContent: 'Not found on this device:' }));
            absent.forEach(h => {
                const chip = document.createElement('span');
                chip.className = 'wiz-absent-chip';
                chip.textContent = h.label;
                row.appendChild(chip);
            });
            body.appendChild(row);
        }

        // --- Frameworks (SDK route) ---
        body.appendChild(this._frameworksSection(data.frameworks || []));

        // --- Footer ---
        const footer = document.createElement('div');
        footer.className = 'wiz-footer';
        const done = document.createElement('button');
        done.className = 'wiz-btn wiz-btn-primary';
        done.textContent = protectedCount > 0 ? 'Done — open the Dashboard' : 'Skip for now — open the Dashboard';
        done.addEventListener('click', () => {
            localStorage.setItem('sv-wizard-done', '1');
            if (window.App) App.loadPage('dashboard');
        });
        footer.appendChild(done);
        const rerun = document.createElement('span');
        rerun.className = 'wiz-footer-note';
        rerun.textContent = 'Re-run any time from the sidebar — Connect Wizard.';
        footer.appendChild(rerun);
        body.appendChild(footer);
    },

    _isProtected(h) {
        const st = this.installState[h.slug];
        if (st && st.phase === 'verified') return true;
        return !!h.plugin_connected;
    },

    _harnessCard(h, index) {
        const st = this.installState[h.slug];
        const card = document.createElement('div');
        card.className = 'wiz-card';
        if (!this._reducedMotion()) card.style.animationDelay = `${index * 90}ms`;

        // Monogram badge
        const badge = document.createElement('div');
        badge.className = 'wiz-badge';
        // Monogram: initials for multi-word labels ("Claude Code" → CC),
        // first two letters for single words so Codex/Cursor don't both
        // collapse to "C".
        const words = h.label.replace(/[^A-Za-z ]/g, ' ').trim().split(/\s+/);
        badge.textContent = (words.length > 1
            ? words.map(w => w[0]).join('').slice(0, 2)
            : (words[0] || '?').slice(0, 2)).toUpperCase();
        card.appendChild(badge);

        const main = document.createElement('div');
        main.className = 'wiz-card-main';
        card.appendChild(main);

        const title = document.createElement('div');
        title.className = 'wiz-card-title';
        title.textContent = h.label;
        main.appendChild(title);

        const sub = document.createElement('div');
        sub.className = 'wiz-card-sub';
        sub.textContent = h.home || '';
        main.appendChild(sub);

        // Guard coverage: even a "Protected" harness can have on-disk session
        // transcripts that never went through Guard (older sessions, or sessions
        // started before the plugin was installed). Surface that estimate so a
        // green "Protected" chip doesn't imply full historical coverage.
        if (h.sessions && h.sessions.supported && (h.unprotected_sessions || 0) > 0) {
            const cov = document.createElement('div');
            cov.className = 'wiz-card-coverage';
            cov.title = 'Estimate: on-disk session transcripts minus the sessions seen in ' +
                'SecureVector’s audit. Older sessions that predate Guard count here. ' +
                'Connecting Guard covers new sessions going forward.';
            cov.textContent = '≈ ' + h.unprotected_sessions + ' of ' +
                (h.sessions.total || 0) + ' sessions not covered by Guard';
            main.appendChild(cov);
        }

        const action = document.createElement('div');
        action.className = 'wiz-card-action';
        card.appendChild(action);

        if (this._isProtected(h)) {
            card.classList.add('wiz-card-protected');
            if (st && st.phase === 'verified' && !st.celebrated) {
                st.celebrated = true;
                card.classList.add('wiz-card-pop');
            }
            const chip = document.createElement('span');
            chip.className = 'wiz-chip wiz-chip-ok';
            const live = h.status === 'active' ? '<span class="wiz-live-dot"></span>' : '';
            // "Protected" overclaims when on-disk history predates Guard: enforcement
            // is only forward-looking, it can't retroactively cover past sessions. Say
            // "Guard active" (true now) and let the amber coverage line carry the caveat.
            const hasUncovered = h.sessions && h.sessions.supported && (h.unprotected_sessions || 0) > 0;
            chip.innerHTML = `${live}${hasUncovered ? 'Guard active' : 'Protected'}`;
            if (hasUncovered) chip.title = 'Guard is enforcing on new calls for this runtime. ' +
                'It cannot retroactively cover sessions that ran before it was connected — see the estimate below.';
            action.appendChild(chip);
            const stats = document.createElement('div');
            stats.className = 'wiz-card-stats';
            const blocked = h.blocked ? ` · ${h.blocked} blocked` : '';
            stats.textContent = h.calls
                ? `${h.calls} call${h.calls === 1 ? '' : 's'} audited${blocked}`
                : 'First protected call verified';
            action.appendChild(stats);
        } else if (st && st.phase === 'installing') {
            const chip = document.createElement('span');
            chip.className = 'wiz-chip wiz-chip-busy';
            chip.textContent = 'Installing…';
            action.appendChild(chip);
        } else if (st && st.phase === 'awaiting') {
            const chip = document.createElement('span');
            chip.className = 'wiz-chip wiz-chip-wait';
            chip.innerHTML = '<span class="wiz-wait-ring"></span>Waiting for the first call…';
            action.appendChild(chip);
            if (st.nextStep) {
                const hint = document.createElement('div');
                hint.className = 'wiz-card-hint';
                hint.textContent = st.nextStep;
                action.appendChild(hint);
            }
        } else {
            if (st && st.phase === 'error') {
                const err = document.createElement('div');
                err.className = 'wiz-card-hint wiz-card-err';
                err.textContent = st.error || 'Install failed — see the guide.';
                action.appendChild(err);
            }
            const btn = document.createElement('button');
            btn.className = 'wiz-btn wiz-btn-protect';
            btn.textContent = 'Protect this runtime';
            btn.addEventListener('click', () => this._install(h));
            action.appendChild(btn);
            const guide = document.createElement('a');
            guide.className = 'wiz-card-guide';
            guide.textContent = 'manual setup guide';
            guide.href = '#';
            guide.addEventListener('click', (e) => {
                e.preventDefault();
                if (window.App) App.loadPage(this.GUIDES[h.slug] || 'guide-connect-agents');
            });
            action.appendChild(guide);
        }

        return card;
    },

    async _install(h) {
        const url = this.INSTALL_URLS[h.slug];
        if (!url) return;
        this.installState[h.slug] = {
            phase: 'installing',
            baselineCalls: h.calls || 0,
        };
        this._refresh();
        try {
            const res = await fetch(url, { method: 'POST' });
            const out = await res.json().catch(() => ({}));
            if (!res.ok || out.ok === false) {
                this.installState[h.slug] = {
                    phase: 'error',
                    error: (out && (out.detail || out.message)) || `Install failed (HTTP ${res.status}).`,
                };
            } else {
                this.installState[h.slug] = {
                    phase: 'awaiting',
                    baselineCalls: h.calls || 0,
                    nextStep: out.next_step ||
                        (Array.isArray(out.commands) && out.commands.length
                            ? `Run in ${h.label}: ${out.commands.join('  then  ')}`
                            : `Start a new ${h.label} session to activate.`),
                };
                if (window.Toast) Toast.show(`${h.label} plugin installed`, 'success');
            }
        } catch (_) {
            this.installState[h.slug] = { phase: 'error', error: 'Could not reach the install API.' };
        }
        this._refresh();
    },

    // ---------------------------------------------------------------- verify

    _startPolling() {
        this.stopPolling();
        this.pollTimer = setInterval(async () => {
            // Self-terminate once the wizard leaves the DOM (page switch).
            if (!this.root || !document.body.contains(this.root)) {
                this.stopPolling();
                return;
            }
            const data = await this._fetchAgents();
            if (!data) return;
            (data.harnesses || []).forEach(h => {
                const st = this.installState[h.slug];
                if (st && st.phase === 'awaiting' &&
                    (h.plugin_connected || (h.calls || 0) > st.baselineCalls)) {
                    st.phase = 'verified';
                    if (window.Toast) Toast.show(`${h.label}: first protected call verified`, 'success');
                }
            });
            this._latest = data;
            this._renderResults(data);
        }, 4000);
    },

    stopPolling() {
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    },

    async _refresh() {
        const data = this._latest || await this._fetchAgents();
        if (data) this._renderResults(data);
    },

    // ------------------------------------------------------------ frameworks

    _frameworksSection(frameworks) {
        const wrap = document.createElement('div');
        wrap.className = 'wiz-frameworks';

        const head = document.createElement('div');
        head.className = 'wiz-section-head';
        head.textContent = 'Running agents in code? Add the Guard SDK where they run';
        wrap.appendChild(head);

        const grid = document.createElement('div');
        grid.className = 'wiz-fw-grid';
        this.FRAMEWORKS.forEach(f => {
            const seen = frameworks.find(x => x.runtime_kind === f.id);
            const card = document.createElement('div');
            card.className = 'wiz-fw-card';

            const title = document.createElement('div');
            title.className = 'wiz-fw-title';
            title.textContent = f.label;
            if (seen) {
                const chip = document.createElement('span');
                chip.className = 'wiz-chip wiz-chip-ok wiz-chip-sm';
                chip.textContent = `${seen.calls || 0} calls audited`;
                title.appendChild(chip);
            }
            card.appendChild(title);

            const cmd = document.createElement('code');
            cmd.className = 'wiz-fw-cmd';
            cmd.textContent = `pip install ${f.pkg}`;
            card.appendChild(cmd);

            const copy = document.createElement('button');
            copy.className = 'wiz-btn wiz-btn-ghost';
            copy.textContent = 'Copy';
            copy.addEventListener('click', () => {
                navigator.clipboard.writeText(`pip install ${f.pkg}`).then(() => {
                    copy.textContent = 'Copied ✓';
                    setTimeout(() => { copy.textContent = 'Copy'; }, 1600);
                });
            });
            card.appendChild(copy);

            const guide = document.createElement('a');
            guide.className = 'wiz-card-guide';
            guide.textContent = 'wiring guide';
            guide.href = '#';
            guide.addEventListener('click', (e) => {
                e.preventDefault();
                if (window.App) App.loadPage('guide-frameworks');
            });
            card.appendChild(guide);

            grid.appendChild(card);
        });
        wrap.appendChild(grid);
        return wrap;
    },

    // --------------------------------------------------------------- stepper

    _stepper(active) {
        const rail = document.createElement('div');
        rail.className = 'wiz-stepper';
        ['Scan', 'Protect', 'Verify'].forEach((label, i) => {
            const step = document.createElement('div');
            step.className = 'wiz-step';
            step.dataset.step = String(i + 1);
            step.innerHTML = `<span class="wiz-step-num">${i + 1}</span><span class="wiz-step-label">${label}</span>`;
            rail.appendChild(step);
        });
        this._applyStep(rail, active);
        return rail;
    },

    _setStep(active) {
        const rail = this.root && this.root.querySelector('.wiz-stepper');
        if (rail) this._applyStep(rail, active);
    },

    _applyStep(rail, active) {
        rail.querySelectorAll('.wiz-step').forEach(el => {
            const n = parseInt(el.dataset.step, 10);
            el.classList.toggle('wiz-step-active', n === active);
            el.classList.toggle('wiz-step-done', n < active);
        });
    },

    // ----------------------------------------------------------------- misc

    _reducedMotion() {
        return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    },

    _injectStyles() {
        if (document.getElementById('wiz-styles')) return;
        const style = document.createElement('style');
        style.id = 'wiz-styles';
        style.textContent = `
.wiz { max-width: 860px; margin: 0 auto; padding: 8px 4px 40px; }

.wiz-stepper { display: flex; gap: 28px; margin: 4px 0 22px; }
.wiz-step { display: flex; align-items: center; gap: 8px; color: var(--text-muted); font-size: 13px; }
.wiz-step-num { width: 22px; height: 22px; border-radius: var(--radius-full); border: 1px solid var(--border-default);
    display: inline-flex; align-items: center; justify-content: center; font-size: 11px; }
.wiz-step-active { color: var(--text-primary); }
.wiz-step-active .wiz-step-num { border-color: var(--accent-primary); color: var(--accent-primary); }
.wiz-step-done .wiz-step-num { background: var(--accent-primary); border-color: var(--accent-primary); color: var(--bg-primary); }

.wiz-scan { display: flex; flex-direction: column; align-items: center; gap: 18px; padding: 64px 0; }
.wiz-scan-ring { width: 96px; height: 96px; border-radius: var(--radius-full); border: 1px solid var(--border-default);
    position: relative; overflow: hidden; }
.wiz-scan-sweep { position: absolute; inset: 0; border-radius: var(--radius-full);
    background: conic-gradient(from 0deg, transparent 0deg, transparent 300deg, var(--accent-primary) 360deg);
    opacity: .55; animation: wiz-sweep 1.1s linear infinite; }
.wiz-scan-label { color: var(--text-secondary); font-size: 14px; }
@keyframes wiz-sweep { to { transform: rotate(360deg); } }

.wiz-summary { font-size: 15px; color: var(--text-primary); margin: 2px 0 14px; }

.wiz-grid { display: flex; flex-direction: column; gap: 10px; }
.wiz-card { display: flex; align-items: center; gap: 14px; padding: 14px 16px;
    background: var(--bg-card); border: 1px solid var(--border-default); border-radius: var(--radius-lg);
    animation: wiz-card-in .34s ease both; }
@keyframes wiz-card-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.wiz-card-protected { border-color: color-mix(in srgb, var(--success) 45%, var(--border-default)); }
.wiz-card-pop { animation: wiz-pop .45s ease; }
@keyframes wiz-pop { 30% { transform: scale(1.015); } }

.wiz-badge { width: 40px; height: 40px; border-radius: var(--radius-md); background: var(--bg-tertiary);
    color: var(--accent-primary); font-weight: 600; font-size: 14px; letter-spacing: .5px;
    display: inline-flex; align-items: center; justify-content: center; flex: none; }
.wiz-card-main { flex: 1; min-width: 0; }
.wiz-card-title { color: var(--text-primary); font-size: 14px; font-weight: 600; }
.wiz-card-sub { color: var(--text-muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wiz-card-coverage { color: var(--warning); font-size: 11.5px; font-weight: 600; margin-top: 3px; cursor: help; }
.wiz-card-action { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; max-width: 46%; }
.wiz-card-stats { color: var(--text-secondary); font-size: 12px; }
.wiz-card-hint { color: var(--text-muted); font-size: 12px; text-align: right; }
.wiz-card-err { color: var(--danger); }
.wiz-card-guide { color: var(--text-muted); font-size: 12px; text-decoration: underline; cursor: pointer; }

.wiz-chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: var(--radius-full);
    font-size: 12px; font-weight: 600; }
.wiz-chip-sm { font-size: 11px; margin-left: 8px; padding: 2px 8px; }
.wiz-chip-ok { color: var(--success); background: color-mix(in srgb, var(--success) 12%, transparent); }
.wiz-chip-busy { color: var(--warning); background: color-mix(in srgb, var(--warning) 12%, transparent); }
.wiz-chip-wait { color: var(--info); background: color-mix(in srgb, var(--info) 12%, transparent); }
.wiz-live-dot { width: 7px; height: 7px; border-radius: var(--radius-full); background: var(--success);
    animation: wiz-pulse 1.6s ease infinite; }
.wiz-wait-ring { width: 10px; height: 10px; border-radius: var(--radius-full);
    border: 2px solid color-mix(in srgb, var(--info) 35%, transparent); border-top-color: var(--info);
    animation: wiz-sweep .9s linear infinite; }
@keyframes wiz-pulse { 50% { opacity: .35; } }

.wiz-absent { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.wiz-absent-label { color: var(--text-muted); font-size: 12px; }
.wiz-absent-chip { color: var(--text-muted); font-size: 12px; padding: 2px 10px;
    border: 1px dashed var(--border-default); border-radius: var(--radius-full); opacity: .75; }

.wiz-section-head { margin: 26px 0 10px; color: var(--text-secondary); font-size: 13px;
    text-transform: uppercase; letter-spacing: .6px; }
.wiz-fw-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
.wiz-fw-card { padding: 12px 14px; background: var(--bg-card); border: 1px solid var(--border-default);
    border-radius: var(--radius-lg); display: flex; flex-direction: column; gap: 8px; }
.wiz-fw-title { color: var(--text-primary); font-size: 13px; font-weight: 600; display: flex; align-items: center; }
.wiz-fw-cmd { display: block; padding: 6px 8px; background: var(--bg-tertiary); border-radius: var(--radius-sm);
    color: var(--text-secondary); font-size: 12px; overflow-x: auto; white-space: nowrap; }

.wiz-btn { border: 1px solid var(--border-default); background: var(--bg-tertiary); color: var(--text-primary);
    padding: 7px 14px; border-radius: var(--radius-md); font-size: 13px; cursor: pointer;
    transition: var(--transition-fast); }
.wiz-btn:hover { background: var(--bg-hover); }
.wiz-btn-primary { background: var(--accent-primary); border-color: var(--accent-primary); color: var(--bg-primary); font-weight: 600; }
.wiz-btn-primary:hover { filter: brightness(1.08); background: var(--accent-primary); }
.wiz-btn-protect { border-color: var(--accent-primary); color: var(--accent-primary); background: transparent; font-weight: 600; }
.wiz-btn-protect:hover { background: color-mix(in srgb, var(--accent-primary) 12%, transparent); }
.wiz-btn-ghost { align-self: flex-start; padding: 4px 10px; font-size: 12px; }

.wiz-footer { display: flex; align-items: center; gap: 14px; margin-top: 30px; }
.wiz-footer-note { color: var(--text-muted); font-size: 12px; }
.wiz-error { color: var(--danger); padding: 32px 0; }

@media (prefers-reduced-motion: reduce) {
    .wiz-card, .wiz-scan-sweep, .wiz-live-dot, .wiz-wait-ring, .wiz-card-pop { animation: none !important; }
}
`;
        document.head.appendChild(style);
    },
};

window.ConnectWizardPage = ConnectWizardPage;
