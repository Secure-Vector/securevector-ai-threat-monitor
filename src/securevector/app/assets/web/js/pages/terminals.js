// src/securevector/app/assets/web/js/pages/terminals.js
// Agent Tasks: launch a governed task, attach to one at a time, and keep
// governance available without taking over the workspace.
const TerminalsPage = {
    // The stage with no pane in it. Kept in one place because leaving the
    // board also repaints it, and an empty grey box is not an empty state.
    STAGE_EMPTY_HTML: `
                <div class="terminals-stage-empty">
                  <h3>Your governed agent workspace</h3>
                  <p>Launch a harness or select a task to return to its live terminal, verdicts, and approvals.</p>
                </div>`,
    // The rail's Agent Tasks row asks for the board rather than the task it
    // left attached. Read once at mount, because restoring a stored layout
    // re-attaches a task and would otherwise overrule the request.
    _wantBoard: false,
    _tasks: [],
    _executors: [],
    _pollTimer: null,
    _railTimer: null,
    _attachedAt: null,
    _error: null,
    _pendingApprovalSessions: new Set(),
    _railSig: '',
    _taskQuery: '',
    _gen: 0,
    _govCounts: { governed: 0, blocked: 0 },
    // Keyed to one executor id at a time: an install that requires the user
    // to paste commands into the harness leaves them showing across a
    // _renderExecutorOptions() re-render, until Check again clears it.
    _guardPending: null,
    // The same idea for the in-session banner: a manual Guard install leaves
    // its commands on screen across the 3 s poll until Check again clears it.
    _guardBannerPending: null,
    _guardBannerSig: null,
    // The page container, kept so the banner's Guard install can re-render the
    // launch form's executor options after a refetch.
    _container: null,
    // The launch form has two modes: spawn a task here, or link a harness
    // session the user started in their own terminal.
    _mode: 'launch',
    _unlinked: null,
    _linking: false,
    // Whether the attached session has reported to the Guard at all. A linked
    // task always carries a session id, so the id cannot answer that question
    // for it; null means "not known yet", which shows no banner rather than a
    // wrong one for the tick before the first read returns.
    _sessionReported: null,
    // Rebuild signatures: the 3 s poll must not blow away keyboard focus on a
    // tab by re-writing innerHTML when nothing about the strip has changed.
    _headSig: null,
    _footSig: null,
    // A tab strip is a glance, not a task list: past eight tabs the titles are
    // unreadable, so the rest collapse into one overflow tab back to the board.
    TAB_LIMIT: 8,

    // --- sessions running outside the board ------------------------------
    //
    // The same /sessions/unlinked read the link form uses, surfaced on the
    // board so a session reporting in right now is visible without the user
    // first knowing the link form exists.
    //
    // Deliberately NOT on the 3 s task cycle: unlinked_sessions() is a GROUP
    // BY over tool_call_audit with two correlated subqueries, and that table
    // takes a row for every governed tool call on the machine. Twenty seconds
    // is still well inside "I just started a session" attention.
    ADOPT_POLL_MS: 20000,
    // Claude Code mints a session id per conversation, so a working day makes
    // many unlinked rows. Without a per-session dismissal this panel is a nag
    // bar, and a nag bar gets ignored wholesale.
    ADOPT_DISMISS_KEY: 'sv-terminals-adopt-dismissed',
    ADOPT_DISMISS_V: 1,
    // Dismissals expire, so the key cannot grow for the life of the install.
    ADOPT_DISMISS_TTL_MS: 48 * 3600 * 1000,
    // Three rows is a glance; the rest are behind Show all so the panel never
    // pushes the task list itself off the screen.
    ADOPT_PREVIEW: 3,
    // Held apart from _unlinked, which belongs to the launch form: the two
    // read the same endpoint but are filtered and rendered differently, and
    // sharing the field would make the board's dismissals leak into the form.
    _adoptable: null,
    _adoptAt: 0,
    _adoptExpanded: false,
    _governingId: null,
    // Panel level rather than per row: only one adopt runs at a time, so at
    // most one message can be live.
    _adoptError: null,

    async render(container) {
        const gen = ++this._gen;
        this._destroyed = false;
        // navigating terminals -> terminals re-renders without calling destroy(),
        // so a stale attachment/timers from the outgoing DOM must be torn down here too.
        clearInterval(this._pollTimer);
        clearInterval(this._railTimer);
        this._pollTimer = null;
        this._railTimer = null;
        clearTimeout(this._removeConfirmTimer);
        this._removeConfirmTimer = null;
        this._removeConfirmId = null;
        this._cancelGovDrag();
        this._unbindGovLayoutObserver();
        this._detach();
        // The form is rebuilt below in launch mode, so the remembered mode
        // must not outlive the DOM that showed it.
        this._mode = 'launch';
        this._unlinked = null;
        this._adoptable = null;
        this._adoptAt = 0;
        this._adoptExpanded = false;
        this._governingId = null;
        this._adoptError = null;
        this._container = container;
        container.innerHTML = `
          <div class="terminals-page">
            <section class="terminals-tasks">
              <div class="terminals-tasks-head">
                <div class="terminals-tasks-actions">
                  <input class="terminals-task-search" id="terminals-task-search" type="search" placeholder="Find a task" aria-label="Find a task">
                  <button class="btn btn-primary btn-sm terminals-launch-button" id="terminals-launch-btn">+ Launch</button>
                </div>
              </div>
              <form class="terminals-launch" id="terminals-launch" hidden>
                <div class="terminals-launch-modes" role="group" aria-label="Launch mode">
                  <button type="button" class="terminals-launch-mode is-active" id="terminals-mode-launch" aria-pressed="true">Launch a task</button>
                  <button type="button" class="terminals-launch-mode" id="terminals-mode-link" aria-pressed="false">Link a running session</button>
                </div>
                <label>Harness
                  <select id="terminals-executor"></select>
                </label>
                <label class="terminals-link-only" id="terminals-session-field" hidden>Session id
                  <input id="terminals-session-id" class="terminals-session-input" type="text" placeholder="paste the harness session id" maxlength="128" autocomplete="off" spellcheck="false">
                </label>
                <label>Folder
                  <input id="terminals-workspace" type="text" placeholder="/path/to/project" autocomplete="off" spellcheck="false">
                </label>
                <label>Title (optional)
                  <input id="terminals-title" type="text" maxlength="120">
                </label>
                <div class="terminals-launch-actions">
                  <button type="submit" class="btn btn-primary btn-sm" id="terminals-launch-submit">Launch task</button>
                  <button type="button" class="btn btn-sm" id="terminals-launch-cancel">Cancel</button>
                </div>
                <div class="terminals-launch-error" id="terminals-launch-error" hidden></div>
                <div class="terminals-executor-hint" id="terminals-executor-hint" hidden></div>
                <div class="terminals-guard-row" id="terminals-guard-row" hidden>
                  <span class="terminals-guard-text" id="terminals-guard-text"></span>
                  <button type="button" class="btn btn-sm btn-primary" id="terminals-guard-install">Install SecureVector Guard</button>
                  <button type="button" class="btn btn-sm" id="terminals-guard-recheck" hidden>Check again</button>
                </div>
                <pre class="terminals-guard-commands" id="terminals-guard-commands" hidden></pre>
                <div class="terminals-unlinked" id="terminals-unlinked" hidden></div>
              </form>
              <div class="terminals-board-summary" id="terminals-board-summary" hidden></div>
              <div class="terminals-adopt" id="terminals-adopt" hidden></div>
              <div id="terminals-task-list" class="terminals-task-list"></div>
            </section>
            <div class="terminals-workspace">
            <section class="terminals-centre">
              <div class="terminals-attached-head" id="terminals-attached-head">
                <span class="terminals-empty">Pick a task to attach, or launch one.</span>
              </div>
              <div class="terminals-attention" id="terminals-attention" hidden></div>
              <div class="terminals-guard-banner" id="terminals-guard-banner" hidden>
                <span class="terminals-guard-banner-text" id="terminals-guard-banner-text"></span>
                <span class="terminals-guard-banner-actions">
                  <button type="button" class="btn btn-sm btn-primary" id="terminals-guard-banner-install">Install SecureVector Guard</button>
                  <button type="button" class="btn btn-sm" id="terminals-guard-banner-recheck" hidden>Check again</button>
                  <button type="button" class="btn btn-sm btn-primary" id="terminals-guard-banner-restart" hidden>Restart harness</button>
                </span>
              </div>
              <pre class="terminals-guard-commands" id="terminals-guard-banner-commands" hidden></pre>
              <div class="terminals-attached-body" id="terminals-attached-body">${this.STAGE_EMPTY_HTML}
              </div>
              <div class="terminals-pane-foot" id="terminals-pane-foot" hidden></div>
            </section>
            <div class="terminals-gov-edge" id="terminals-gov-edge">
              <div class="terminals-gov-gutter" id="terminals-gov-gutter" role="separator" aria-orientation="vertical" aria-label="Resize the governance column" tabindex="0"></div>
              <button type="button" class="terminals-governance-toggle" id="terminals-governance-toggle" aria-expanded="true" aria-controls="terminals-governance-body" aria-label="Collapse governance activity"><span class="terminals-governance-caret" aria-hidden="true"></span></button>
            </div>
            <section class="terminals-governance" id="terminals-governance">
              <div class="terminals-governance-head" id="terminals-governance-head">
                <span class="terminals-governance-name">Governance activity</span>
                <span class="terminals-governance-summary" id="terminals-governance-summary">Attach a task to inspect its trace</span>
              </div>
              <div class="terminals-governance-body" id="terminals-governance-body">
                <div class="terminals-gov-hero" id="terminals-gov-hero" hidden>
                  <div class="terminals-gov-hero-bot" id="terminals-gov-hero-bot"></div>
                  <h4 class="terminals-gov-hero-title" id="terminals-gov-hero-title"></h4>
                  <p class="terminals-gov-hero-text" id="terminals-gov-hero-text"></p>
                  <ul class="terminals-gov-hero-list">
                    <li><span class="terminals-gov-hero-k">Tool calls</span><span>every call the harness makes, with its verdict</span></li>
                    <li><span class="terminals-gov-hero-k">Traces</span><span>the full span of each governed call</span></li>
                    <li><span class="terminals-gov-hero-k">Egress</span><span>every external host the task reaches</span></li>
                    <li><span class="terminals-gov-hero-k">Context &amp; cost</span><span>context fill, waste, and a Compact now button</span></li>
                  </ul>
                </div>
                <details class="terminals-gov-section terminals-gov-context" id="terminals-gov-context" open>
                  <summary><h3>Context &amp; cost</h3><span class="terminals-gov-stage" id="terminals-context-stage"></span></summary>
                  <div id="terminals-context" class="terminals-context"><span class="terminals-empty">No task attached.</span></div>
                </details>
                <details class="terminals-gov-section" open><summary><h3>Tool calls</h3><span class="terminals-gov-count" id="terminals-verdicts-count"></span></summary><div id="terminals-verdicts" class="terminals-verdicts"><span class="terminals-empty">No task attached.</span></div></details>
                <details class="terminals-gov-section" open><summary class="terminals-traces-head"><h3>Traces</h3><a href="#" class="terminals-traces-all" id="terminals-traces-all">All traces</a><span class="terminals-gov-count" id="terminals-traces-count"></span></summary><div id="terminals-traces" class="terminals-traces"><span class="terminals-empty">No task attached.</span></div></details>
                <details class="terminals-gov-section" open><summary><h3>Egress</h3><span class="terminals-gov-count" id="terminals-egress-count"></span></summary><div id="terminals-egress" class="terminals-egress"><span class="terminals-empty">No task attached.</span></div></details>
                <details class="terminals-gov-section" open><summary><h3>Approval inbox</h3><span class="terminals-gov-count" id="terminals-approvals-count"></span></summary><div id="terminals-approvals" class="terminals-approvals"><span class="terminals-empty">Nothing waiting.</span></div></details>
              </div>
            </section>
            </div>
          </div>`;

        this._layoutRestored = false;
        try {
            this._wantBoard = sessionStorage.getItem('sv-agent-tasks-board') === '1';
            sessionStorage.removeItem('sv-agent-tasks-board');
        } catch (e) { this._wantBoard = false; }
        this._bindPaneKeys();
        this._bindGovDock();
        this._bindLaunchForm(container);
        container.querySelector('#terminals-task-search').oninput = (ev) => {
            this._taskQuery = ev.target.value.trim().toLowerCase();
            this._renderTaskList();
        };
        const tracesAll = container.querySelector('#terminals-traces-all');
        if (tracesAll) tracesAll.onclick = (e) => {
            e.preventDefault();
            if (window.AgentRunsPage) AgentRunsPage._pendingTrace = null;
            if (window.Sidebar?.navigate) Sidebar.navigate('agent-runs');
        };
        try {
            const ex = await API.terminalsExecutors();
            if (gen !== this._gen) return;
            this._executors = ex.items || [];
            this._renderExecutorOptions(container);
            this._renderGuardBanner();
        } catch (e) {
            console.warn('Terminals: executors unavailable', e);
            this._executors = [];
            this._renderExecutorOptions(container);
            this._renderGuardBanner();
        }
        if (gen !== this._gen) return;
        await this._refreshTasks();
        if (gen !== this._gen) return;
        this._pollTimer = setInterval(() => this._refreshTasks(), 3000);
        this._railTimer = setInterval(() => { this._refreshRail(); this._refreshPaneGov(); }, 4000);
    },

    destroy() {
        this._gen = (this._gen || 0) + 1;
        // Beside the generation bump, not further down: destroy() is called
        // inside a try/catch, and a throw below here would otherwise leave a
        // torn-down page looking live to _claimFocusedPane's guard.
        this._destroyed = true;
        clearInterval(this._pollTimer);
        clearInterval(this._railTimer);
        this._pollTimer = null;
        this._railTimer = null;
        clearTimeout(this._removeConfirmTimer);
        this._removeConfirmTimer = null;
        this._removeConfirmId = null;
        this._cancelGovDrag();
        this._unbindGovLayoutObserver();
        this._detach();
        clearTimeout(this._stopAllTimer);
        this._stopAllTimer = null;
        this._stopAllArmed = false;
        // A drag in flight owns window listeners; navigating away mid drag
        // must take them with it rather than leaving them resizing nothing.
        if (this._drag && this._drag.finish) this._drag.finish(false);
        this._clearDragGhost();
        this._clearDropZone();
        this._drag = null;
        this._clickAfterDrag = false;
        this._unbindPaneKeys();
        this._layoutRestored = false;
        this._tasks = [];
        this._executors = [];
        this._attachedAt = null;
        this._error = null;
        this._pendingApprovalSessions = new Set();
        this._taskQuery = '';
        this._tracesCache = null;
        this._guardPending = null;
        this._guardBannerPending = null;
        this._guardBannerSig = null;
        this._container = null;
        this._mode = 'launch';
        this._unlinked = null;
        this._adoptable = null;
        this._adoptAt = 0;
        this._adoptExpanded = false;
        this._governingId = null;
        this._adoptError = null;
        this._linking = false;
        this._sessionReported = null;
    },

    // --- task strip -----------------------------------------------------

    _bindLaunchForm(container) {
        const form = container.querySelector('#terminals-launch');
        container.querySelector('#terminals-launch-btn').onclick = () => {
            form.hidden = !form.hidden;
            if (!form.hidden) container.querySelector('#terminals-workspace').focus();
        };
        container.querySelector('#terminals-launch-cancel').onclick = () => { form.hidden = true; };
        const modeLaunch = container.querySelector('#terminals-mode-launch');
        const modeLink = container.querySelector('#terminals-mode-link');
        if (modeLaunch) modeLaunch.onclick = () => this._setLaunchMode(container, 'launch');
        if (modeLink) modeLink.onclick = () => this._setLaunchMode(container, 'link');
        const guardInstall = container.querySelector('#terminals-guard-install');
        if (guardInstall) guardInstall.onclick = () => {
            const sel = container.querySelector('#terminals-executor');
            if (sel && sel.value) this._installGuard(sel.value, container);
        };
        const guardRecheck = container.querySelector('#terminals-guard-recheck');
        if (guardRecheck) guardRecheck.onclick = () => {
            const sel = container.querySelector('#terminals-executor');
            if (sel && sel.value) this._recheckGuard(sel.value, container);
        };
        form.onsubmit = async (ev) => {
            ev.preventDefault();
            if (this._mode === 'link') { await this._submitLink(container); return; }
            const err = container.querySelector('#terminals-launch-error');
            err.hidden = true;
            const executor = container.querySelector('#terminals-executor').value;
            const chosen = this._executors.find(e => e.id === executor);
            if (!chosen || chosen.installed === false) { err.textContent = (chosen && chosen.hint) || 'This harness is not ready to launch.'; err.hidden = false; return; }
            const workspace = container.querySelector('#terminals-workspace').value.trim();
            const title = container.querySelector('#terminals-title').value.trim();
            if (!workspace) { err.textContent = 'Enter the folder the task should run in.'; err.hidden = false; return; }
            try {
                const task = await API.terminalsLaunch(executor, workspace, title);
                form.hidden = true;
                await this._refreshTasks();
                if (window.Sidebar?.refreshAgentTaskViews) Sidebar.refreshAgentTaskViews();
                await this._attach(task.id);
            } catch (e) {
                err.textContent = e.message || 'Launch failed.';
                err.hidden = false;
            }
        };
    },

    // --- link a session that runs outside the app -----------------------

    /** Switch the launch form between spawning a task here and linking a
     *  harness session the user started in their own terminal. Only the
     *  fields and the submit verb change: the harness select, the folder and
     *  the title mean the same thing in both modes. */
    _setLaunchMode(container, mode) {
        this._mode = mode === 'link' ? 'link' : 'launch';
        const link = this._mode === 'link';
        const launchBtn = container.querySelector('#terminals-mode-launch');
        const linkBtn = container.querySelector('#terminals-mode-link');
        const setActive = (btn, on) => {
            if (!btn) return;
            btn.classList[on ? 'add' : 'remove']('is-active');
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        };
        setActive(launchBtn, !link);
        setActive(linkBtn, link);
        const field = container.querySelector('#terminals-session-field');
        if (field) field.hidden = !link;
        const list = container.querySelector('#terminals-unlinked');
        if (list) list.hidden = !link;
        const submit = container.querySelector('#terminals-launch-submit');
        if (submit) submit.textContent = link ? 'Link session' : 'Launch task';
        const err = container.querySelector('#terminals-launch-error');
        if (err) err.hidden = true;
        this._showExecutorState(container);
        if (link) {
            container.querySelector('#terminals-session-id')?.focus();
            this._loadUnlinked();
        }
    },

    async _loadUnlinked() {
        try {
            const r = await API.terminalsUnlinkedSessions();
            this._unlinked = r.items || [];
        } catch (e) {
            this._unlinked = [];
        }
        this._renderUnlinked();
    },

    _renderUnlinked() {
        const el = document.getElementById('terminals-unlinked');
        if (!el) return;
        const rows = this._unlinked || [];
        if (!rows.length) {
            el.innerHTML = '<span class="terminals-empty">No unlinked sessions reported in the last 24 hours.</span>';
            return;
        }
        el.innerHTML = rows.map(r => {
            const short = String(r.session_id || '').slice(0, 8);
            const calls = `${r.calls || 0} call${r.calls === 1 ? '' : 's'}`;
            const folder = r.workspace ? this._shortPath(r.workspace) : '';
            return `
              <div class="terminals-unlinked-row">
                <span class="terminals-unlinked-harness">${this._esc(r.label || r.executor_id)}</span>
                <span class="terminals-unlinked-id" title="${this._esc(r.session_id)}">${this._esc(short)}</span>
                <span class="terminals-unlinked-when">${this._esc(this._ago(r.last_at))}</span>
                <span class="terminals-unlinked-calls">${this._esc(calls)}</span>
                <span class="terminals-unlinked-folder" title="${this._esc(r.workspace || '')}">${this._esc(folder)}</span>
                <button type="button" class="btn btn-sm terminals-unlinked-link" data-session-id="${this._esc(r.session_id)}" data-executor-id="${this._esc(r.executor_id)}" data-workspace="${this._esc(r.workspace || '')}">Link</button>
              </div>`;
        }).join('');
        el.querySelectorAll('.terminals-unlinked-link').forEach(b => {
            b.onclick = async () => {
                const container = this._container || document;
                const sel = container.querySelector('#terminals-executor');
                if (sel) sel.value = b.dataset.executorId;
                const sid = container.querySelector('#terminals-session-id');
                if (sid) sid.value = b.dataset.sessionId;
                const ws = container.querySelector('#terminals-workspace');
                if (ws && b.dataset.workspace) ws.value = b.dataset.workspace;
                await this._submitLink(container);
            };
        });
    },

    async _submitLink(container) {
        // One link at a time. The backend serialises the read-then-insert so
        // a double submit cannot make two rows, but it would still turn the
        // second click into a "already on the board" error the user never
        // asked for, so the form stops accepting one.
        if (this._linking) return;
        const err = container.querySelector('#terminals-launch-error');
        if (err) err.hidden = true;
        const sel = container.querySelector('#terminals-executor');
        const executor = sel ? sel.value : '';
        const chosen = this._executors.find(e => e.id === executor);
        const fail = (msg) => { if (err) { err.textContent = msg; err.hidden = false; } };
        // A linked session needs the harness installed so its label and
        // Guard install path are real, but not governed: linking an
        // ungoverned session is exactly how the user gets it governed.
        if (!chosen || chosen.installed === false) {
            fail((chosen && chosen.hint) || 'This harness is not installed.');
            return;
        }
        const sessionEl = container.querySelector('#terminals-session-id');
        const sessionId = sessionEl ? sessionEl.value.trim() : '';
        if (!sessionId) { fail('Paste the harness session id.'); return; }
        const wsEl = container.querySelector('#terminals-workspace');
        const workspace = wsEl ? wsEl.value.trim() : '';
        const titleEl = container.querySelector('#terminals-title');
        const title = titleEl ? titleEl.value.trim() : '';
        this._linking = true;
        this._setLinkingDisabled(container, true);
        try {
            const task = await API.terminalsLink(executor, sessionId, workspace, title);
            const form = container.querySelector('#terminals-launch');
            if (form) form.hidden = true;
            await this._refreshTasks();
            if (window.Sidebar?.refreshAgentTaskViews) Sidebar.refreshAgentTaskViews();
            await this._attach(task.id);
        } catch (e) {
            fail(e.message || 'Could not link that session.');
        } finally {
            this._linking = false;
            this._setLinkingDisabled(container, false);
        }
    },

    /** Hold the submit and every picker Link button while one link is in
     *  flight, so a second click cannot race the first. */
    _setLinkingDisabled(container, on) {
        const submit = container.querySelector('#terminals-launch-submit');
        if (submit) submit.disabled = on;
        const list = document.getElementById('terminals-unlinked');
        if (list && list.querySelectorAll) {
            list.querySelectorAll('.terminals-unlinked-link').forEach(b => { b.disabled = on; });
        }
    },

    // --- adopt a running session from the board --------------------------
    //
    // The link form above answers "I know a session exists, put it on the
    // board". This answers the question nobody thinks to ask: a session is
    // reporting tool calls into the audit trail right now and the board is
    // silent about it. Same endpoints, one click, no form.

    /** Refresh the adoptable list, at most once per ADOPT_POLL_MS.
     *
     *  Called from the 3 s task cycle, so the throttle is the whole point:
     *  unlinked_sessions() aggregates tool_call_audit, which is the busiest
     *  table the app owns. */
    async _maybeLoadAdoptable() {
        const now = Date.now();
        if (now - (this._adoptAt || 0) < this.ADOPT_POLL_MS) return;
        // Stamped before the await, never after: a request slower than the
        // window would otherwise let the next tick queue a second one behind
        // it, which is exactly the pile-up the throttle exists to prevent.
        this._adoptAt = now;
        const gen = this._gen;
        try {
            const r = await API.terminalsUnlinkedSessions();
            if (gen !== this._gen) return;
            this._adoptable = r.items || [];
        } catch (e) {
            if (gen !== this._gen) return;
            // Swallowed, never rethrown: _refreshTasks awaits this, and an
            // offer the user did not ask for must not take the board down.
            this._adoptable = [];
        }
        this._renderAdoptable();
    },

    /** The dismissed session ids, pruned to the TTL on every read so the key
     *  cannot grow for the life of the install.
     *
     *  Anything that is not v: 1 is dropped rather than migrated, the same
     *  way _restoreGov() drops a foreign shape: a key we cannot vouch for is
     *  not worth guessing at when the cost of guessing wrong is hiding a
     *  session the person wanted to see. */
    _adoptDismissed() {
        const store = this._store();
        if (!store) return {};
        let saved = null;
        try {
            const raw = store.getItem(this.ADOPT_DISMISS_KEY);
            saved = raw ? JSON.parse(raw) : null;
        } catch (e) { return {}; /* unreadable or not ours */ }
        if (!saved || saved.v !== this.ADOPT_DISMISS_V) return {};
        if (!saved.ids || typeof saved.ids !== 'object') return {};
        const cutoff = Date.now() - this.ADOPT_DISMISS_TTL_MS;
        const kept = {};
        for (const id of Object.keys(saved.ids)) {
            const at = saved.ids[id];
            if (typeof at === 'number' && isFinite(at) && at >= cutoff) kept[id] = at;
        }
        return kept;
    },

    /** Dismiss one session, not the panel. A day of Claude Code conversations
     *  is a day of new session ids, so a global "hide this" would silence
     *  tomorrow's sessions too. */
    _adoptDismiss(sessionId) {
        if (!sessionId) return;
        const ids = this._adoptDismissed();
        ids[sessionId] = Date.now();
        const store = this._store();
        if (store) {
            try {
                store.setItem(this.ADOPT_DISMISS_KEY, JSON.stringify({ v: this.ADOPT_DISMISS_V, ids }));
            } catch (e) { /* storage unavailable or full */ }
        }
        this._renderAdoptable();
    },

    /** What the panel would show: dismissed ids removed, most recent first. */
    _adoptRows() {
        const dismissed = this._adoptDismissed();
        return (this._adoptable || [])
            .filter(r => r && r.session_id && !Object.prototype.hasOwnProperty.call(dismissed, r.session_id))
            .slice()
            .sort((a, b) => (Date.parse(b.last_at) || 0) - (Date.parse(a.last_at) || 0));
    },

    /** Forget one row without waiting for the next fetch. Twenty seconds of a
     *  row you just adopted still sitting there reads as a click that did
     *  nothing, so the local list is corrected and the clock reset. */
    _dropAdoptable(sessionId) {
        this._adoptable = (this._adoptable || []).filter(r => r.session_id !== sessionId);
        this._adoptAt = 0;
    },

    _renderAdoptable() {
        const el = document.getElementById('terminals-adopt');
        if (!el) return;
        const rows = this._adoptRows();
        if (!rows.length) {
            // Nothing to offer means no panel at all, not an empty-state box:
            // the board's job is the task list, and this sits above it.
            this._adoptError = null;
            el.hidden = true;
            el.innerHTML = '';
            return;
        }
        const more = rows.length > this.ADOPT_PREVIEW;
        const shown = this._adoptExpanded ? rows : rows.slice(0, this.ADOPT_PREVIEW);
        const body = shown.map(r => {
            const calls = `${r.calls || 0} call${r.calls === 1 ? '' : 's'}`;
            const folder = r.workspace ? this._shortPath(r.workspace) : '';
            return `
              <div class="terminals-adopt-row">
                <span class="terminals-adopt-harness">${this._esc(r.label || r.executor_id)}</span>
                <span class="terminals-adopt-folder" title="${this._esc(r.workspace || '')}">${this._esc(folder)}</span>
                <span class="terminals-adopt-when">${this._esc(this._ago(r.last_at))}</span>
                <span class="terminals-adopt-calls">${this._esc(calls)}</span>
                <button type="button" class="btn btn-sm btn-primary terminals-adopt-govern" data-session-id="${this._esc(r.session_id)}">Govern</button>
                <button type="button" class="btn btn-sm terminals-adopt-dismiss" data-session-id="${this._esc(r.session_id)}" aria-label="Dismiss this session">Dismiss</button>
              </div>`;
        }).join('');
        const toggle = more
            ? `<button type="button" class="terminals-adopt-more">${this._esc(this._adoptExpanded ? 'Show fewer' : `Show all ${rows.length}`)}</button>`
            : '';
        const error = this._adoptError
            ? `<div class="terminals-adopt-error">${this._esc(this._adoptError)}</div>`
            : '';
        el.hidden = false;
        el.innerHTML = `
          <div class="terminals-adopt-head">
            <span class="terminals-adopt-title">Running outside SecureVector</span>
            <span class="terminals-adopt-count">${this._esc(rows.length)}</span>
          </div>
          <p class="terminals-adopt-note">These sessions are reporting in but are not on your board yet.</p>
          ${body}${toggle}${error}`;
        el.querySelectorAll('.terminals-adopt-govern').forEach(b => {
            b.onclick = () => {
                // Looked up by id rather than carried on the element: the row
                // the click means is the one currently held, not whatever the
                // markup was built from a render ago.
                const row = (this._adoptable || []).find(r => r.session_id === b.dataset.sessionId);
                if (row) this._governSession(row, b);
            };
        });
        el.querySelectorAll('.terminals-adopt-dismiss').forEach(b => {
            b.onclick = () => this._adoptDismiss(b.dataset.sessionId);
        });
        const moreBtn = el.querySelector('.terminals-adopt-more');
        // Expansion is a glance, not a preference: deliberately not persisted,
        // so the panel is back to three rows on the next visit.
        if (moreBtn) moreBtn.onclick = () => { this._adoptExpanded = !this._adoptExpanded; this._renderAdoptable(); };
    },

    /** request() throws a plain Error and does not attach the HTTP status
     *  (api.js identifies its own 401/403 by message for the same reason), so
     *  the 409 is recognised by the detail the backend sends. e.status is
     *  honoured first in case a caller ever starts attaching one. */
    _adoptIsAlreadyLinked(e) {
        if (e && e.status === 409) return true;
        return ((e && e.message) || '') === 'This session is already on the board.';
    },

    /** Put one reported session on the board, with no form in the way.
     *
     *  _submitLink() cannot serve this: it reads the launch form's inputs and
     *  writes its errors into the form's error line, and none of that DOM
     *  exists while the form is closed. This calls the same endpoint through
     *  API.terminalsLink() directly. */
    async _governSession(row, btn) {
        // One adopt at a time, page wide. The backend serialises the
        // read-then-insert so a double click cannot make two rows, but it
        // would still answer the second click with an "already on the board"
        // error the person never asked for.
        if (this._governingId) return;
        if (!row || !row.session_id) return;
        const chosen = this._executors.find(e => e.id === row.executor_id);
        // Installed, because the link needs a real harness label and Guard
        // install path. Deliberately NOT governed: adopting an ungoverned
        // session is precisely how a person gets it governed.
        if (!chosen || chosen.installed === false) {
            this._adoptError = (chosen && chosen.hint) || 'This harness is not installed.';
            this._renderAdoptable();
            return;
        }
        this._governingId = row.session_id;
        this._adoptError = null;
        if (btn) { btn.disabled = true; btn.textContent = 'Adopting…'; }
        try {
            await API.terminalsLink(row.executor_id, row.session_id, row.workspace || '', '');
            this._dropAdoptable(row.session_id);
            await this._refreshTasks();
            if (window.Sidebar?.refreshAgentTaskViews) Sidebar.refreshAgentTaskViews();
        } catch (e) {
            if (this._adoptIsAlreadyLinked(e)) {
                // Someone, or another window, got there first. The row has
                // done its job; an error the person cannot act on is worse
                // than quietly agreeing with what already happened.
                this._dropAdoptable(row.session_id);
                await this._refreshTasks();
                if (window.Sidebar?.refreshAgentTaskViews) Sidebar.refreshAgentTaskViews();
            } else {
                this._adoptError = (e && e.message) || 'Could not govern that session.';
                if (btn) { btn.disabled = false; btn.textContent = 'Govern'; }
            }
        } finally {
            this._governingId = null;
            this._renderAdoptable();
        }
    },

    async _refreshTasks() {
        const gen = this._gen;
        try {
            const r = await API.terminalsTasks();
            this._tasks = r.items || [];
            this._error = null;
        } catch (e) {
            this._error = e.message;
        }
        if (gen !== this._gen) return;
        // The JIT inbox is the source of truth for work that needs a human.
        // Keep this separate from a generic `blocked` harness notification:
        // only a task with a pending, session-matched approval gets the
        // actionable row badge.
        try {
            const jit = await API.getJitRequests('pending');
            this._pendingApprovalSessions = new Set(
                (jit.items || []).map(r => r.session_id).filter(Boolean)
            );
        } catch (e) {
            // A temporary inbox failure must not make task attachment or the
            // task list unavailable. Avoid showing a stale approval badge.
            this._pendingApprovalSessions = new Set();
        }
        if (gen !== this._gen) return;
        this._renderTaskList();
        this._renderPaneHeads();
        this._checkDragAlive();
        const sig = this._tasks.map(t => t.id + ':' + this._taskState(t).kind).join('|');
        if (sig !== this._railSig) {
            this._railSig = sig;
            if (window.Sidebar?.refreshAgentTaskViews) Sidebar.refreshAgentTaskViews();
        }
        this._renderAttachedHead();
        // Rides the task cycle but on its own much slower clock, and never
        // throws: the board is the page, the adopt panel is an offer.
        await this._maybeLoadAdoptable();
        if (gen !== this._gen) return;
        // A stored layout is rebuilt once per mount, and only now: pruning it
        // needs the task list, and it has to settle before the reconcile below
        // decides whether the stored task id still wants attaching.
        if (!this._layoutRestored) {
            this._layoutRestored = true;
            if (this._wantBoard) {
                // Asked for the board, so the stored panes are not what the
                // user wants back; forget them rather than reopen their sockets.
                this._wantBoard = false;
                this._clearStoredLayout();
            } else {
                await this._restoreLayout();
                if (gen !== this._gen) return;
            }
        }
        this._pruneLayoutToTasks();
        // This must run before the reconcile block below: _attach() is what
        // writes the stored id, so the reconcile block needs to see that
        // write (or the lack of one) already settled.
        const requested = sessionStorage.getItem('sv-agent-task-id');
        if (requested && requested !== this._attached && this._tasks.some(task => task.id === requested)) {
            this._attach(requested);
        } else if (!this._error && requested && !this._tasks.some(task => task.id === requested)) {
            // The stored id names a task that no longer exists server-side;
            // nothing will ever re-attach it, so drop the stale key.
            try { sessionStorage.removeItem('sv-agent-task-id'); } catch (e) { /* storage unavailable */ }
            if (window.Sidebar?.setActive) Sidebar.setActive('terminals');
        }
        // the rail Agent Tasks row clears the stored id without touching this
        // page's DOM, so a poll tick must notice and detach on its behalf.
        if (this._attached && !sessionStorage.getItem('sv-agent-task-id')) {
            this._detach();
            this._clearStoredLayout();
            const attachedBody = document.getElementById('terminals-attached-body');
            if (attachedBody) attachedBody.innerHTML = this.STAGE_EMPTY_HTML;
            if (window.Sidebar?.setActive) Sidebar.setActive('terminals');
            this._renderAttachedHead();
            this._renderTaskList();
        }
    },

    _renderTaskList() {
        const el = document.getElementById('terminals-task-list');
        if (!el) return;
        if (this._error) { this._renderBoardSummary([]); el.innerHTML = `<div class="terminals-error">${this._esc(this._error)}</div>`; return; }
        if (!this._tasks.length) {
            this._renderBoardSummary([]);
            el.innerHTML = `<div class="terminals-task-empty">
              <strong>Start your first governed task</strong>
              <span>Choose a harness, then SecureVector keeps its calls and decisions together.</span>
              <button class="btn btn-sm btn-primary" id="terminals-empty-launch">Launch a harness</button>
            </div>`;
            const launch = el.querySelector('#terminals-empty-launch');
            if (launch) launch.onclick = () => document.getElementById('terminals-launch-btn')?.click();
            return;
        }
        const query = this._taskQuery;
        const shown = query ? this._tasks.filter(t =>
            [t.title, t.workspace, t.executor_id, t.status].some(value => String(value || '').toLowerCase().includes(query))
        ) : this._tasks;
        if (!shown.length) {
            this._renderBoardSummary([]);
            el.innerHTML = '<div class="terminals-task-empty"><strong>No matching tasks</strong><span>Try a task name, workspace, harness, or state.</span></div>';
            return;
        }
        this._renderBoardSummary(shown);
        const groups = new Map();
        for (const t of shown) {
            if (!groups.has(t.workspace)) groups.set(t.workspace, []);
            groups.get(t.workspace).push(t);
        }
        let html = '';
        const isSingleGroup = groups.size === 1;
        for (const [ws, tasks] of groups) {
            html += `<div class="terminals-group${isSingleGroup ? ' is-single' : ''}"><div class="terminals-group-name" title="${this._esc(ws)}">${this._esc(this._shortPath(ws))}</div>`;
            for (const t of tasks) {
                const active = t.id === this._attached ? ' is-attached' : '';
                const state = this._taskState(t);
                const canRelaunch = this._isEnded(t);
                // The launching state lives on the page, not on the button: the
                // 3 s poll rebuilds every card, and a disabled flag set on the
                // old DOM node would be gone by the next tick, leaving a live
                // Relaunch button over an already-running launch.
                const relaunching = this._relaunchingId === t.id;
                const relaunch = canRelaunch
                    ? `<button class="terminals-task-relaunch" data-relaunch-id="${this._esc(t.id)}" aria-label="Relaunch task" title="Relaunch with the same harness and folder"${relaunching ? ' disabled' : ''}>${relaunching ? 'Launching…' : '↻'}</button>` : '';
                const removable = !['starting', 'working', 'blocked', 'idle'].includes(t.status)
                    ? (this._removeConfirmId === t.id
                        ? `<span class="terminals-task-confirm">Remove from the board? Its audit trace is kept. <button type="button" class="terminals-task-confirm-yes" data-confirm-remove-id="${this._esc(t.id)}">Remove</button><button type="button" class="terminals-task-confirm-no" data-cancel-remove-id="${this._esc(t.id)}">Keep</button></span>`
                        : `<button class="terminals-task-remove" data-remove-id="${this._esc(t.id)}" title="Remove from board; the audit record remains">Remove</button>`)
                    : '';
                const elapsed = this._elapsed(t.created_at, t.ended_at);
                const guard = this._guardState(t);
                const branch = typeof t.branch === 'string' && t.branch
                    ? `<span class="terminals-task-branch" title="${this._esc(t.branch)}">${this._esc(t.branch)}</span>` : '';
                html += `
                  <article class="terminals-task${active}" data-id="${this._esc(t.id)}">
                    <button class="terminals-task-select" data-id="${this._esc(t.id)}" aria-label="Open ${this._esc(t.title || this._label(t.executor_id))}">
                      <span class="terminals-task-title-row">${window.TaskAvatar ? TaskAvatar.html({ id: t.id, harness: t.executor_id, state: state.kind, size: 44 }) : ''}<span class="terminals-task-title">${this._esc(t.title || this._label(t.executor_id))}</span>${t.origin === 'linked' ? '<span class="terminals-task-linked">linked</span>' : ''}</span>
                      <span class="terminals-task-sub" title="${this._esc(state.detail)}">${this._esc(this._label(t.executor_id))} · ${this._esc(state.label)}</span>
                      <span class="terminals-task-doing" title="${this._esc(this._activityLine(t))}">${this._esc(this._activityLine(t))}</span>
                      <span class="terminals-task-guard terminals-guard-${guard.kind}" title="${this._esc(guard.detail)}">${this._esc(guard.label)}</span>
                      <span class="terminals-task-when">${branch}<span class="terminals-task-elapsed">${this._esc(elapsed)}</span></span>
                    </button>
                    ${relaunch}
                    ${removable}
                  </article>`;
            }
            html += '</div>';
        }
        el.innerHTML = html;
        el.querySelectorAll('.terminals-task-select').forEach(b => {
            b.onclick = () => {
                // The click that ends a card drag belongs to the drag, not to
                // the card it happened to finish over.
                if (this.consumeDragClick()) return;
                this._attach(b.dataset.id);
            };
        });
        // Grouping two sessions has to be possible from the board, where no
        // pane is on screen to drop onto, so one card drops onto another.
        el.querySelectorAll('.terminals-task[data-id]').forEach(card => {
            card.onpointerdown = (ev) => this._onCardPointerDown(ev, card.dataset.id);
        });
        el.querySelectorAll('[data-relaunch-id]').forEach(b => {
            b.onclick = async (ev) => {
                ev.stopPropagation();
                if (this._relaunchingId) return;
                const task = this._tasks.find(t => t.id === b.dataset.relaunchId);
                if (!task) return;
                this._relaunchingId = task.id;
                this._renderTaskList();
                try {
                    await this._relaunchTask(task);
                } catch (e) {
                    this._banner(e.message || 'Could not relaunch task.');
                } finally {
                    this._relaunchingId = null;
                    this._renderTaskList();
                }
            };
        });
        el.querySelectorAll('[data-remove-id]').forEach(b => {
            b.onclick = (ev) => { ev.stopPropagation(); this._askRemove(b); };
        });
        el.querySelectorAll('[data-cancel-remove-id]').forEach(b => {
            b.onclick = (ev) => { ev.stopPropagation(); this._closeRemoveConfirm(); };
        });
        el.querySelectorAll('[data-confirm-remove-id]').forEach(b => {
            b.onclick = async (ev) => {
                ev.stopPropagation();
                const task = this._tasks.find(t => t.id === b.dataset.confirmRemoveId);
                if (!task) return;
                b.disabled = true;
                try {
                    await API.terminalsArchive(task.id);
                    this._removeConfirmId = null;
                    // The pane holding it is closed by the prune in
                    // _refreshTasks(); the rest of the workspace stays up.
                    if (sessionStorage.getItem('sv-agent-task-id') === task.id) sessionStorage.removeItem('sv-agent-task-id');
                    await this._refreshTasks();
                    if (window.Sidebar?.refreshAgentTaskViews) Sidebar.refreshAgentTaskViews();
                    this._renderAttachedHead();
                    this._refreshRail();
                } catch (e) {
                    b.disabled = false;
                    this._banner(e.message || 'Could not remove task.');
                }
            };
        });
        el.querySelectorAll('.terminals-task-confirm').forEach(sp => {
            sp.onclick = (ev) => ev.stopPropagation();
        });
    },

    // Removing a task is reversible in intent (the audit trace is kept) but
    // native confirm() freezes the whole window and cannot be styled or
    // tested. The confirmation lives in the card instead, and times out so a
    // forgotten prompt does not sit armed on the board.
    REMOVE_CONFIRM_MS: 6000,

    _askRemove(btn) {
        const id = btn.dataset.removeId;
        // One card at a time: two armed Remove buttons on the board is two
        // chances to click the wrong one.
        this._removeConfirmId = id;
        clearTimeout(this._removeConfirmTimer);
        this._removeConfirmTimer = setTimeout(() => {
            if (this._removeConfirmId === id) this._closeRemoveConfirm();
        }, this.REMOVE_CONFIRM_MS);
        this._renderTaskList();
    },

    _closeRemoveConfirm() {
        clearTimeout(this._removeConfirmTimer);
        this._removeConfirmTimer = null;
        this._removeConfirmId = null;
        this._renderTaskList();
    },

    _taskState(t) {
        // Geometry intentionally carries meaning too. A task is not a tiny
        // chatbot: its compact marker is an operational state indicator.
        if (this._hasPendingApproval(t)) return { kind: 'approval', label: 'Waiting approval', detail: 'Paused for your decision', mark: '!' };
        if (t.status === 'blocked') return { kind: 'blocked', label: 'Blocked', detail: 'Harness blocked this task', mark: '×' };
        if (t.status === 'done') return { kind: 'completed', label: 'Completed', detail: 'Task completed successfully', mark: '✓' };
        if (t.status === 'interrupted') return { kind: 'interrupted', label: 'Interrupted', detail: 'The app restarted before this task finished', mark: '–' };
        if (t.status === 'failed') return { kind: 'failed', label: 'Failed', detail: t.exit_code == null ? 'Task failed' : `Task ended with exit code ${t.exit_code}`, mark: '!' };
        return { kind: 'active', label: 'Active', detail: 'Harness is running', mark: '•' };
    },

    /** Whether this task is being checked, and on what basis. The board is
     *  the triage surface, so it has to answer "which of these am I actually
     *  watching" without opening any of them. */
    _guardState(t) {
        if (t.origin === 'linked') {
            return { kind: 'linked', label: 'linked', detail: 'A session you linked; the app does not own this process' };
        }
        if (t.governed_at_launch === false) {
            return { kind: 'ungoverned', label: 'not governed', detail: 'Launched without SecureVector Guard: its calls are not being checked or recorded' };
        }
        return { kind: 'governed', label: 'governed', detail: 'Launched with SecureVector Guard in place: every call is checked and recorded' };
    },

    /** One line of state over the whole board. Every number here is counted
     *  from the task list already in hand, so it costs no extra request. */
    _renderBoardSummary(shown) {
        const el = document.getElementById('terminals-board-summary');
        if (!el) return;
        if (!shown || shown.length < 2) { el.hidden = true; el.innerHTML = ''; return; }
        const running = shown.filter(t => this._RUNNING_STATUSES.includes(t.status)).length;
        const waiting = shown.filter(t => this._hasPendingApproval(t)).length;
        const blocked = shown.filter(t => t.status === 'blocked').length;
        const ungoverned = shown.filter(t => this._guardState(t).kind === 'ungoverned').length;
        const cell = (n, word, cls, title) => `<span class="terminals-board-stat${n > 0 && cls ? ' ' + cls : ''}" title="${this._esc(title)}"><b>${n}</b> ${this._esc(word)}</span>`;
        el.hidden = false;
        el.innerHTML = cell(running, 'running', '', 'Tasks whose harness is still alive')
            + cell(waiting, 'waiting on you', 'is-amber', 'Tasks paused for your decision')
            + cell(blocked, 'blocked', 'is-red', 'Tasks the harness stopped')
            + cell(ungoverned, 'not governed', 'is-amber', 'Tasks launched without SecureVector Guard');
    },

    _activityLine(t) {
        const hasCode = t.exit_code !== null && t.exit_code !== undefined;
        if (t.status === 'done') return hasCode ? `Finished with exit code ${t.exit_code}` : 'Finished';
        if (t.status === 'failed') return hasCode ? `Stopped with exit code ${t.exit_code}` : 'Stopped';
        if (t.status === 'interrupted') return 'Interrupted when the app restarted';
        if (t.status === 'starting') return 'Starting';
        return t.activity || t.status;
    },

    _hasPendingApproval(t) {
        return Boolean(t.session_id && this._pendingApprovalSessions.has(t.session_id));
    },

    /** Session lifecycle sentinels the Guard plugins emit around a run
     *  (__session_start__ / __session_end__). They are boundaries, not calls,
     *  so listing them as calls overstates what was actually checked. */
    _isBoundaryRow(row) {
        const sentinel = (name) => {
            const s = String(name || '');
            return s.length >= 4 && s.slice(0, 2) === '__' && s.slice(-2) === '__';
        };
        return sentinel(row && row.function_name) || sentinel(row && row.tool_id);
    },
    _statusLabel(status) {
        return { starting: 'Starting', working: 'Running', blocked: 'Blocked', idle: 'Waiting', done: 'Finished', failed: 'Stopped', interrupted: 'Interrupted' }[status] || status;
    },

    // --- attached terminals: the pane layout -----------------------------
    //
    // The workspace is a tree of panes (the model lives in terminals-layout.js).
    // A pane holds a group of tasks as tabs and shows one of them, and it is
    // that one that owns the pane's single xterm and its single WebSocket:
    // switching tab hangs up and reconnects exactly as changing a pane's task
    // always did. `_attached` is
    // the focused pane's task, which is what the tab strip, the status footer,
    // the Guard banner, the governance panel, and the rail all key off, so
    // none of them had to learn what a pane is.

    _layout: null,          // root node of the pane tree, or null
    _panes: new Map(),      // pane id -> { taskId, ws, view, el, ... }
    _focused: null,         // pane id
    _splitEls: new Map(),   // split id -> its element, for ratio updates
    LAYOUT_KEY: 'sv-terminals-layout',
    // One terminal and one socket per pane; past six a restore costs more
    // than the layout is worth.
    MAX_RESTORED_PANES: 6,
    // A pane's tabs are cheap until one is brought forward, and then each is a
    // socket of its own, so the tasks are capped across the whole restore as
    // well as the panes.
    MAX_RESTORED_TASKS: 8,
    // Arrow keys nudge a gutter by this much, which is a visible step without
    // being a jump.
    GUTTER_STEP: 0.05,
    // The gutter between two panes, matching .terminals-gutter in the CSS.
    // The pixels it takes are not available to either side, so the width
    // checks have to subtract it before they halve anything.
    GUTTER_W: 6,

    // --- governance dock -------------------------------------------------
    // Governance is a right column again, which is where the eye expects a
    // trace to sit beside the thing it traces. What it is not is the old
    // fixed column: the width here is dragged, persisted, and genuinely
    // given back when the column collapses to its strip.
    //
    // Stored as v: 2. The v: 1 shape held a height for the bottom dock, and
    // a height is not a width, so it is read as foreign and dropped: the
    // person lands on the default column instead of a 132px sliver.
    GOV_KEY: 'sv-terminals-gov',
    GOV_STATE_V: 2,
    GOV_MIN_W: 240,       // narrower than this and the section rows wrap badly
    GOV_DEFAULT_W: 320,
    PANE_MIN_W: 420,      // the panes never get dragged below a usable width
    // One pane's own floor, in CSS pixels, and a different number from the one
    // above: that one keeps the whole pane area usable while the governance
    // column is dragged, this one keeps a single pane readable.
    //
    // The terminal runs at 13px in an SF Mono stack, whose advance is 0.6em,
    // so a column costs 7.8px. Forty columns is the narrowest width at which
    // ordinary harness output still reads as sentences rather than as a
    // ladder of one and two letter fragments: 40 x 7.8 = 312px of glyphs,
    // plus the 12px the xterm mount is padded by and the pane's own 2px of
    // border, rounded up for the head's controls.
    PANE_USABLE_W: 340,
    GOV_GUTTER_W: 12,     // edge wrapper between the panes and governance
    GOV_STRIP_W: 34,      // the collapsed strip, matching the CSS
    GOV_STEP: 24,         // px an arrow key moves the column edge
    _govWidth: 0,         // px; 0 until restored or defaulted
    _govCollapsed: false, // effective state, expanded until the person collapses it
    _govUserSet: false,   // true once the person has clicked the toggle
    _govStacked: false,   // measured workspace cannot hold panes + governance
    _govDrag: null,       // one cancellable pointer gesture at a time
    _govResizeObserver: null,
    _govResizeHandler: null,

    /** The layout model, however this page was loaded. */
    _lay() {
        if (typeof TerminalsLayout !== 'undefined' && TerminalsLayout) return TerminalsLayout;
        return (typeof window !== 'undefined' && window.TerminalsLayout) || null;
    },

    // `_attached`, `_ws`, and `_view` read through to the focused pane rather
    // than being state of their own: one attached task was the old model, and
    // every caller that still speaks it means "the pane I am looking at".
    get _attached() {
        const rec = this._focusedPane();
        return rec ? rec.taskId : null;
    },
    set _attached(id) {
        if (id === null || id === undefined) { this._closeAllPanes(); return; }
        const rec = this._focusedPane();
        if (!rec) { this._claimFocusedPane(id); return; }
        rec.taskId = id;
        rec.headSig = null;
        const L = this._lay();
        if (L && this._layout) this._layout = L.replaceTask(this._layout, rec.id, id);
        this._syncPaneGroup(rec);
    },
    get _ws() {
        const rec = this._focusedPane();
        return rec ? rec.ws : null;
    },
    set _ws(sock) {
        const rec = this._focusedPane() || this._claimFocusedPane(null);
        if (rec) rec.ws = sock;
    },
    get _view() {
        const rec = this._focusedPane();
        return rec ? rec.view : null;
    },
    set _view(view) {
        const rec = this._focusedPane() || this._claimFocusedPane(null);
        if (rec) rec.view = view;
    },

    _focusedPane() {
        if (!this._panes || !this._focused) return null;
        return this._panes.get(this._focused) || null;
    },

    /** A task lives in one pane at a time; this is the pane holding it.
     *  The whole group counts, not just the tab on screen: a task behind a tab
     *  is still in that pane, and attaching it has to switch tabs there rather
     *  than open a second copy of it somewhere else. */
    _paneForTask(taskId) {
        if (!taskId || !this._panes) return null;
        for (const [id, rec] of this._panes) if (this._paneTasks(rec).includes(taskId)) return id;
        return null;
    },

    /** One pane's group in tab order. A copy: the record's own array is the
     *  layout's to change, and a caller holding it would see it move. */
    _paneTasks(rec) {
        if (!rec) return [];
        if (Array.isArray(rec.taskIds) && rec.taskIds.length) return rec.taskIds.slice();
        return rec.taskId ? [rec.taskId] : [];
    },

    /** The layout node owns a pane's group; the record carries a copy so the
     *  head can draw its tabs without walking the tree on every poll. */
    _syncPaneGroup(rec, node) {
        if (!rec) return;
        const L = this._lay();
        const n = node || (L && this._layout ? L.find(this._layout, rec.id) : null);
        const ids = n && Array.isArray(n.taskIds) ? n.taskIds : (rec.taskId ? [rec.taskId] : []);
        const was = rec.taskIds || [];
        if (was.length === ids.length && ids.every((x, i) => x === was[i])) return;
        rec.taskIds = ids.slice();
        rec.headSig = null;
    },

    _syncPaneGroups() {
        if (!this._panes) return;
        for (const rec of this._panes.values()) this._syncPaneGroup(rec);
    },

    _blankPane(id, taskId, taskIds) {
        return {
            id, taskId: taskId || null,
            taskIds: Array.isArray(taskIds) ? taskIds.slice() : (taskId ? [taskId] : []),
            ws: null, view: null, mountToken: null,
            gov: null, govSid: null, govAt: 0, govSig: null, guardSig: null, footSig: null,
            el: null, headEl: null, pickerEl: null, stageEl: null, bannerEl: null,
            headSig: null, mounted: false,
            // A pane with no task is normally something the page is about to
            // tidy away. This one is not: the operator split it open a moment
            // ago and is choosing what to put in it. The task poll reads this
            // so it prunes the leftovers and leaves that one alone.
            keepEmpty: false, emptyDir: null, emptySig: null,
        };
    },

    /** Point one named pane at a task, in place. A restart has to come back
     *  in the pane the user was looking at, not in whichever pane happens to
     *  hold the focus at the time. Falls back to the focused pane.
     *  `group` says what becomes of the tasks the pane already holds:
     *  'replace' lets them go, because the pane was claimed for this one task;
     *  'add' keeps them and puts this task beside them as a new tab;
     *  'activate' keeps them and brings a tab already in the group forward;
     *  'swap' puts the new task in the old one's place, which is how a
     *  restarted harness comes back without disbanding the group around it.
     *  `swapFor` names the task being replaced, for a swap of a task the pane
     *  holds but is not showing. */
    _claimPane(taskId, paneId, group = 'replace', swapFor = null) {
        const rec = paneId && this._panes ? this._panes.get(paneId) : null;
        if (!rec) return this._claimFocusedPane(taskId);
        const L = this._lay();
        // A restart says which task it replaces. Reading it off the record
        // instead would swap whichever tab the pane happens to be showing,
        // and a task can be restarted from a tab that is not the one on top.
        const was = (swapFor && this._paneTasks(rec).includes(swapFor)) ? swapFor : rec.taskId;
        this._closePaneSocket(rec);
        rec.taskId = taskId || null;
        // The pane has a task now, so it is no longer the transient blank the
        // poll has to be told to spare.
        if (rec.taskId) { rec.keepEmpty = false; rec.emptyDir = null; rec.emptySig = null; }
        rec.headSig = null;
        rec.guardSig = null;
        rec.footSig = null;
        rec.gov = null;
        rec.govSid = null;
        rec.govSig = null;
        if (L && this._layout) {
            if (group === 'add') this._layout = L.addTask(this._layout, rec.id, rec.taskId);
            else if (group === 'activate') this._layout = L.setActive(this._layout, rec.id, rec.taskId);
            else if (group === 'swap' && was && rec.taskId) {
                this._layout = L.swapTask(this._layout, was, rec.taskId);
                // The pane is about to mount the fresh session, so that is the
                // tab it shows, whether or not the task it replaced was.
                this._layout = L.setActive(this._layout, rec.id, rec.taskId);
            }
            else this._layout = L.replaceTask(this._layout, rec.id, rec.taskId);
        }
        this._syncPaneGroup(rec);
        return rec;
    },

    /** Point the focused pane at a task, or open the first pane. */
    _claimFocusedPane(taskId) {
        const L = this._lay();
        if (!this._panes) this._panes = new Map();
        const rec = this._focusedPane();
        if (rec) {
            this._closePaneSocket(rec);
            rec.taskId = taskId || null;
            if (rec.taskId) { rec.keepEmpty = false; rec.emptyDir = null; rec.emptySig = null; }
            rec.headSig = null;
            if (L && this._layout) this._layout = L.replaceTask(this._layout, rec.id, rec.taskId);
            this._syncPaneGroup(rec);
            return rec;
        }
        // The first attach of a visit legitimately opens the first pane from
        // nothing. A torn down page must not: every await in this file can
        // come back to one, and a pane built then is a socket nobody owns.
        if (!L || this._destroyed) return null;
        const node = L.create(taskId);
        this._layout = node;
        const made = this._blankPane(node.id, taskId);
        this._panes.set(node.id, made);
        this._focused = node.id;
        return made;
    },

    _closePaneSocket(rec) {
        if (!rec) return;
        if (rec.ws) {
            const ws = rec.ws;
            // Null the handlers before closing so frames from the old task
            // queued on this socket cannot land in a newly attached terminal.
            ws.onmessage = ws.onclose = ws.onopen = ws.onerror = null;
            try { ws.close(); } catch (e) { /* closing */ }
        }
        if (rec.view) { try { rec.view.dispose(); } catch (e) { /* already gone */ } }
        rec.ws = null;
        rec.view = null;
        rec.mounted = false;
    },

    /** Open a task in the focused pane, or focus the pane already showing it.
     *  `paneId` names a pane to open it in instead of the focused one, and
     *  `group` what becomes of the tasks that pane holds, and `swapFor` the
     *  task a swap replaces (see _claimPane). */
    async _attach(id, paneId, group = 'replace', swapFor = null) {
        const L = this._lay();
        if (!L || !id) return;
        if (!this._panes) this._panes = new Map();
        const holder = this._paneForTask(id);
        const held = holder ? this._panes.get(holder) : null;
        // The task is in that pane's group but is not the tab on screen, so
        // this is a tab switch: the pane keeps its group and changes socket.
        const activate = !!held && held.taskId !== id;
        if (holder && !activate) {
            if (holder !== this._focused) {
                this._focusPane(holder);
                this._refreshRail();
                return;
            }
            if (held.ws && held.ws.readyState <= WebSocket.OPEN) return;
        }
        // A group is something the user assembled deliberately: adding to it
        // is recoverable by closing a tab, replacing it is not. So an attach
        // that names no pane joins a focused pane that holds a group, and
        // replaces only when that pane holds one task or none, which leaves
        // clicking through the task list feeling exactly as it did.
        const focused = !activate && !paneId && this._focused ? this._panes.get(this._focused) : null;
        const joins = !!focused && this._paneTasks(focused).length > 1;
        if (joins && this._paneTasks(focused).length >= (L.MAX_GROUP || 8)) {
            this._banner('This pane is full. Close a tab first.', this._focused);
            return;
        }
        const rec = activate
            ? this._claimPane(id, holder, 'activate')
            : this._claimPane(id, joins ? this._focused : paneId, joins ? 'add' : group, swapFor);
        if (!rec) return;
        this._attachedAt = Date.now();
        this._focusPane(rec.id, { force: true });
        this._renderLayout();
        this._renderTaskList();
        this._renderAttachedHead();
        await this._mountPane(rec.id);
        // A mount waits on the board when it cannot describe the task, and a
        // destroy() inside that wait nulls the layout. Persisting then would
        // remove the stored layout the next visit is meant to bring back.
        if (!this._layout) return;
        this._persistLayout();
        // A task is attached now, so the column earns its body width unless the
        // person has said otherwise.
        this._syncGovDock();
    },

    /** Split the focused pane and open a task in the half that appeared. */
    async _openInNewPane(taskId, dir) {
        const L = this._lay();
        if (!L || !taskId) return;
        const holder = this._paneForTask(taskId);
        if (holder) {
            // The task already has a pane, so this is a focus or, when it is
            // behind one of that pane's tabs, a tab switch. Never a copy.
            const held = this._panes.get(holder);
            if (held && held.taskId !== taskId) { await this._attach(taskId, holder); return; }
            this._focusPane(holder);
            this._refreshRail();
            return;
        }
        if (!this._layout || !this._focused) { await this._attach(taskId); return; }
        // Same floor as a pointer split: an unreadable pane is not a place to
        // put a task, so the task stays where it is and the operator is told.
        if (this._splitWouldCrush(this._focused, dir)) { this._refuseSplit(this._focused); return; }
        const before = new Set(L.panes(this._layout).map(p => p.id));
        const next = L.split(this._layout, this._focused, dir, taskId);
        if (next === this._layout) return;
        if (dir === 'row' && !this._canUseLayout(next, this._focused)) return;
        this._layout = next;
        const added = L.panes(next).find(p => !before.has(p.id));
        this._panes.set(added.id, this._blankPane(added.id, taskId));
        this._focusPane(added.id, { force: true });
        this._renderLayout();
        this._renderTaskList();
        this._renderAttachedHead();
        await this._mountPane(added.id);
        if (!this._layout) return;
        this._persistLayout();
        this._fitAll();
    },

    /** Bring one of a pane's tabs forward. The pane keeps its group; only its
     *  socket and its terminal change, which is the same claim any other
     *  change of a pane's task makes. */
    _activatePaneTask(paneId, taskId) {
        const rec = paneId && this._panes ? this._panes.get(paneId) : null;
        if (!rec || !taskId || rec.taskId === taskId) return Promise.resolve();
        if (!this._paneTasks(rec).includes(taskId)) return Promise.resolve();
        return this._attach(taskId, paneId);
    },

    /** Close one tab. The task keeps running; only the view of it goes. */
    _closePaneTask(paneId, taskId) {
        const L = this._lay();
        const rec = paneId && this._panes ? this._panes.get(paneId) : null;
        if (!L || !rec || !taskId) return Promise.resolve();
        const group = this._paneTasks(rec);
        if (!group.includes(taskId)) return Promise.resolve();
        // The last tab going takes the pane with it, which is the same event
        // as closing the pane outright: same tidy up, empty workspace and all.
        if (group.length <= 1) { this._closePane(paneId); return Promise.resolve(); }
        const next = L.removeTask(this._layout, taskId);
        if (next === this._layout) return Promise.resolve();
        this._layout = next;
        this._syncPaneGroups();
        if (rec.taskId !== taskId) {
            this._renderLayout();
            this._persistLayout();
            this._refreshRail();
            return Promise.resolve();
        }
        // The tab on screen went, so the neighbour the model picked takes over.
        return this._settlePaneAfterLeave(paneId, taskId);
    },

    /** Close one pane. The task keeps running; only the view of it goes. */
    _closePane(paneId) {
        const L = this._lay();
        if (!L || !this._panes || !this._panes.has(paneId)) return;
        this._closePaneSocket(this._panes.get(paneId));
        const next = L.close(this._layout, paneId);
        this._layout = next;
        this._reapPanes();
        if (!next) {
            this._detach();
            this._clearStoredLayout();
            try { sessionStorage.removeItem('sv-agent-task-id'); } catch (e) { /* storage unavailable */ }
            const body = document.getElementById('terminals-attached-body');
            if (body) body.innerHTML = this.STAGE_EMPTY_HTML;
            if (window.Sidebar?.setActive) Sidebar.setActive('terminals');
            this._renderAttachedHead();
            this._renderTaskList();
            return;
        }
        if (this._focused === paneId || !this._panes.has(this._focused)) {
            this._focused = null;
            this._focusPane(L.panes(next)[0].id, { force: true });
        }
        this._renderLayout();
        this._persistLayout();
        this._refreshRail();
        this._fitAll();
    },

    /** A task that left the board takes its own pane with it, and nothing
     *  else: one task vanishing must never tear down the whole workspace. */
    _pruneLayoutToTasks() {
        const L = this._lay();
        if (!L || !this._layout) return;
        // The panes the operator has just split open and not yet filled are
        // spared. Only this caller passes them: a restore prunes without the
        // set, so a blank pane that reached storage still collapses.
        const next = L.prune(this._layout, new Set(this._tasks.map(t => t.id)), this._transientEmptyPanes());
        if (next === this._layout) return;
        this._layout = next;
        this._reapPanes();
        if (!next) {
            // Every pane's task is gone, so the workspace goes back to the board.
            this._detach();
            this._clearStoredLayout();
            try { sessionStorage.removeItem('sv-agent-task-id'); } catch (e) { /* storage unavailable */ }
            const body = document.getElementById('terminals-attached-body');
            if (body) body.innerHTML = this.STAGE_EMPTY_HTML;
            this._renderAttachedHead();
            return;
        }
        if (!this._panes.has(this._focused)) {
            this._focused = null;
            this._focusPane(L.panes(next)[0].id, { force: true });
        }
        this._renderLayout();
        this._persistLayout();
        // A pane that lost a neighbour is wider than the terminal inside it
        // still believes it is. Without this the survivor keeps drawing at
        // the old column count and the space it gained stays a dark band.
        this._fitAll();
    },

    /** The panes that are empty on purpose right now: split open by hand and
     *  still waiting for a task. Everything else with no task is a leftover. */
    _transientEmptyPanes() {
        const out = new Set();
        if (!this._panes) return out;
        for (const [id, rec] of this._panes) if (rec && rec.keepEmpty && !rec.taskId) out.add(id);
        return out;
    },

    /** Dispose the runtime of every pane the tree no longer contains. */
    _reapPanes() {
        const L = this._lay();
        const live = new Set(L ? L.panes(this._layout).map(p => p.id) : []);
        for (const [id, rec] of Array.from(this._panes)) {
            if (live.has(id)) continue;
            this._closePaneSocket(rec);
            this._panes.delete(id);
        }
        // A pane that went while the pointer was down leaves the drag holding
        // or aiming at nothing.
        this._checkDragAlive();
    },

    _closeAllPanes() {
        if (this._panes) for (const rec of this._panes.values()) this._closePaneSocket(rec);
        this._panes = new Map();
        this._splitEls = new Map();
        this._layout = null;
        this._focused = null;
    },

    /** Move the focus. Everything the governance panels cached belongs to the
     *  pane that had it, so a move clears them exactly as attaching did. */
    _focusPane(paneId, { force = false } = {}) {
        const rec = this._panes ? this._panes.get(paneId) : null;
        if (!rec) return;
        const changed = force || this._focused !== paneId;
        const prev = this._focused;
        this._focused = paneId;
        if (!changed) return;
        const before = prev ? this._panes.get(prev) : null;
        if (before) before.headSig = null;
        rec.headSig = null;
        this._resetSessionPanels();
        this._sessionReported = null;
        this._govCounts = { governed: 0, blocked: 0 };
        this._govHas = {};
        this._headSig = null;
        this._footSig = null;
        this._guardBannerSig = null;
        if (rec.taskId) {
            try { sessionStorage.setItem('sv-agent-task-id', rec.taskId); } catch (e) { /* storage unavailable */ }
        }
        if (window.Sidebar?.setActive) Sidebar.setActive('terminals');
        document.querySelector('.terminals-page')?.classList.add('is-focused');
        this._applyFocusClasses();
        this._renderPaneHead(prev);
        this._renderPaneHead(paneId);
        this._renderTaskList();
        this._renderAttachedHead();
        this._persistLayout();
        // Clicking a different pane used to change only its visual focus.
        // The workspace-level Governance Activity panel still held the prior
        // session's cached data until the next poll. Refresh immediately so
        // its verdicts, traces, egress and context always belong to the pane
        // the operator just selected.
        this._refreshRail();
        this._refreshPaneGov();
        if (rec.view) { try { rec.view.focus(); } catch (e) { /* not mounted yet */ } }
    },

    _applyFocusClasses() {
        if (!this._panes) return;
        for (const [id, rec] of this._panes) {
            if (!rec.el || !rec.el.classList) continue;
            if (id === this._focused) rec.el.classList.add('is-focused');
            else rec.el.classList.remove('is-focused');
        }
    },

    // --- pane DOM -------------------------------------------------------

    /** Rebuild the layout DOM. Pane elements are reused and moved rather than
     *  recreated, because recreating one would restart its terminal. */
    _renderLayout() {
        const body = document.getElementById('terminals-attached-body');
        if (!body) return;
        if (body.classList) {
            if (this._layout) body.classList.add('is-layout');
            else body.classList.remove('is-layout');
        }
        this._splitEls = new Map();
        const root = this._buildNode(this._layout);
        if (body.replaceChildren) body.replaceChildren(...(root ? [root] : []));
        this._applyFocusClasses();
        this._renderEmptyPaneChoices();
        this._syncGovLayoutMode();
    },

    _buildNode(node) {
        if (!node) return null;
        if (node.type === 'pane') return this._paneEl(node);
        const el = document.createElement('div');
        el.className = 'terminals-split terminals-split-' + node.dir;
        if (el.dataset) el.dataset.splitId = node.id;
        if (el.style && el.style.setProperty) el.style.setProperty('--ratio', String(node.ratio));
        this._splitEls.set(node.id, el);
        const a = this._buildNode(node.a);
        const gutter = this._gutterEl(node);
        const b = this._buildNode(node.b);
        if (el.appendChild) {
            if (a) el.appendChild(a);
            if (gutter) el.appendChild(gutter);
            if (b) el.appendChild(b);
        }
        return el;
    },

    _gutterEl(node) {
        const g = document.createElement('div');
        if (!g) return null;
        g.className = 'terminals-gutter';
        if (g.setAttribute) {
            g.setAttribute('role', 'separator');
            g.setAttribute('aria-orientation', node.dir === 'row' ? 'vertical' : 'horizontal');
            g.setAttribute('aria-label', node.dir === 'row' ? 'Resize panes left and right' : 'Resize panes up and down');
        }
        g.tabIndex = 0;
        if (g.dataset) g.dataset.splitId = node.id;
        g.onpointerdown = (ev) => this._startGutterDrag(ev, node.id);
        g.ondblclick = () => this._setSplitRatio(node.id, 0.5);
        g.onkeydown = (ev) => this._onGutterKey(ev, node.id);
        return g;
    },

    /** The pane shell is built once and kept: its head, picker, stage, and
     *  banner are addressed directly afterwards so nothing ever rewrites the
     *  element the terminal is drawing into. */
    _paneEl(node) {
        if (!this._panes) this._panes = new Map();
        let rec = this._panes.get(node.id);
        if (!rec) { rec = this._blankPane(node.id, node.taskId, node.taskIds); this._panes.set(node.id, rec); }
        this._syncPaneGroup(rec, node);
        if (!rec.el) {
            const el = document.createElement('section');
            el.className = 'terminals-pane';
            if (el.dataset) el.dataset.paneId = node.id;
            el.tabIndex = -1;
            el.onmousedown = () => { this._focusPane(node.id); };
            rec.headEl = document.createElement('div');
            rec.headEl.className = 'terminals-pane-head';
            // The handle is the head, not the pane: a drag that started over
            // the terminal would swallow a text selection.
            rec.headEl.draggable = false;
            rec.headEl.onpointerdown = (ev) => this._onHeadPointerDown(ev, node.id);
            rec.govEl = document.createElement('div');
            rec.govEl.className = 'terminals-pane-gov';
            rec.govEl.hidden = true;
            rec.guardEl = document.createElement('div');
            rec.guardEl.className = 'terminals-guard-banner';
            rec.guardEl.hidden = true;
            rec.guardEl.innerHTML = `
              <span class="terminals-guard-banner-text"></span>
              <span class="terminals-guard-banner-actions">
                <button type="button" class="btn btn-sm btn-primary" data-guard="install">Install SecureVector Guard</button>
                <button type="button" class="btn btn-sm" data-guard="recheck" hidden>Check again</button>
                <button type="button" class="btn btn-sm btn-primary" data-guard="restart" hidden>Restart harness</button>
              </span>`;
            rec.guardCmdEl = document.createElement('pre');
            rec.guardCmdEl.className = 'terminals-guard-commands';
            rec.guardCmdEl.hidden = true;
            rec.footEl = document.createElement('div');
            rec.footEl.className = 'terminals-pane-foot';
            rec.footEl.hidden = true;
            rec.pickerEl = document.createElement('div');
            rec.pickerEl.className = 'terminals-pane-picker';
            rec.pickerEl.hidden = true;
            rec.stageEl = document.createElement('div');
            rec.stageEl.className = 'terminals-pane-stage';
            rec.bannerEl = document.createElement('div');
            rec.bannerEl.className = 'terminals-banner';
            rec.bannerEl.hidden = true;
            if (el.appendChild) {
                el.appendChild(rec.headEl);
                el.appendChild(rec.guardEl);
                el.appendChild(rec.guardCmdEl);
                el.appendChild(rec.pickerEl);
                el.appendChild(rec.stageEl);
                el.appendChild(rec.bannerEl);
                el.appendChild(rec.footEl);
            }
            rec.el = el;
            rec.headSig = null;
        }
        this._renderPaneHead(node.id);
        this._renderPaneGov(node.id);
        this._renderGuardBanner(node.id);
        this._renderPaneFoot(node.id);
        return rec.el;
    },

    /** Each pane head carries its own task's state, so the poll has to reach
     *  all of them. Every head keeps its own signature, so this is cheap. */
    _renderPaneHeads() {
        if (!this._panes) return;
        for (const id of this._panes.keys()) this._renderPaneHead(id);
        this._renderEmptyPaneChoices();
    },

    /** Split and close controls. The same three buttons serve a pane head and,
     *  when a single pane hides its head, the page head above it. */
    _paneActButtons(chords) {
        const box = 'viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false"';
        const frame = '<rect x=".5" y=".5" width="11" height="11" rx="1.5" fill="none" stroke="currentColor"/>';
        return `<button type="button" class="terminals-pane-act" data-act="row" aria-label="Split right" title="Split right (${this._esc(chords.splitRight.label)})"><svg ${box}>${frame}<line x1="6" y1=".5" x2="6" y2="11.5" stroke="currentColor"/></svg></button>`
            + `<button type="button" class="terminals-pane-act" data-act="col" aria-label="Split down" title="Split down (${this._esc(chords.splitDown.label)})"><svg ${box}>${frame}<line x1=".5" y1="6" x2="11.5" y2="6" stroke="currentColor"/></svg></button>`
            + `<button type="button" class="terminals-pane-act" data-act="close" aria-label="Close pane" title="Close pane (${this._esc(chords.close.label)}); the task keeps running"><svg ${box}><line x1="2.5" y1="2.5" x2="9.5" y2="9.5" stroke="currentColor"/><line x1="9.5" y1="2.5" x2="2.5" y2="9.5" stroke="currentColor"/></svg></button>`;
    },

    /** Wire a set of split/close buttons to one pane, wherever they were drawn. */
    _bindPaneActs(root, paneId) {
        const acts = root && root.querySelectorAll ? root.querySelectorAll('.terminals-pane-act') : [];
        acts.forEach((b) => {
            b.onclick = (ev) => {
                if (ev && ev.stopPropagation) ev.stopPropagation();
                const act = b.dataset ? b.dataset.act : null;
                if (act === 'close') this._closePane(paneId);
                else if (act === 'row' || act === 'col') this._splitIntoEmptyPane(paneId, act);
            };
        });
    },

    /** A single pane hides its own head, so its governance chip is re-homed in
     *  the page head. The chip element is the pane's either way, so whichever
     *  head renders last simply re-parents the same node. */
    _placeSoloGov(paneId) {
        const rec = paneId && this._panes ? this._panes.get(paneId) : null;
        const slot = document.getElementById('terminals-head-pane-gov');
        if (!rec || !rec.govEl || !slot || !slot.appendChild) return;
        if (rec.govEl.parentNode !== slot) { slot.appendChild(rec.govEl); rec.govSig = null; }
        this._renderPaneGov(paneId);
    },

    /** One tab per task the pane holds, in the order the group is in. */
    _paneTabsHtml(rec) {
        return this._paneTasks(rec).map((id) => {
            const t = this._tasks.find(x => x.id === id);
            const state = t ? this._taskState(t) : null;
            const name = t ? (t.title || this._label(t.executor_id)) : 'No task';
            const on = id === rec.taskId;
            const avatar = t && window.TaskAvatar
                ? TaskAvatar.html({ id: t.id, harness: t.executor_id, state: state.kind, size: 16 })
                : '';
            const live = state && state.kind === 'active' ? '<i class="terminals-pane-live" aria-hidden="true"></i>' : '';
            // The tab is the wrapper, not the button inside it: a tablist
            // whose children are anything but tabs is a broken tablist, and
            // the close control has to sit inside the tab it belongs to.
            return `<span class="terminals-pane-session${on ? ' is-active' : ''}" role="tab" aria-selected="${on ? 'true' : 'false'}">`
                + `<button type="button" class="terminals-pane-session-open" data-tab-id="${this._esc(id)}" title="${this._esc(name)}">${avatar}<span class="terminals-pane-session-title">${this._esc(name)}</span>${live}</button>`
                + `<button type="button" class="terminals-pane-session-close" data-tab-close-id="${this._esc(id)}" aria-label="Close ${this._esc(name)}" title="Close ${this._esc(name)}; the task keeps running"><svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true" focusable="false"><line x1="3" y1="3" x2="9" y2="9" stroke="currentColor"/><line x1="9" y1="3" x2="3" y2="9" stroke="currentColor"/></svg></button>`
                + '</span>';
        }).join('');
    },

    _renderPaneHead(paneId) {
        const rec = paneId && this._panes ? this._panes.get(paneId) : null;
        if (!rec || !rec.headEl) return;
        const group = this._paneTasks(rec);
        // One pane needs no head of its own: the tab strip above already names
        // the task, and a second bar repeating it reads as a duplicate header.
        // A pane holding a group keeps its head whatever else is on screen,
        // because that head is where the group's tabs live.
        const solo = this._panes.size === 1 && group.length <= 1;
        const t = this._tasks.find(x => x.id === rec.taskId);
        const state = t ? this._taskState(t) : null;
        const name = t ? (t.title || this._label(t.executor_id)) : 'No task';
        const harness = t ? this._label(t.executor_id) : '';
        const focused = this._focused === paneId;
        const chords = this._chords();
        // The group is part of the signature, so the 3 s poll still skips the
        // rebuild when neither the tabs nor their states have moved.
        const groupSig = group.map((id) => {
            const g = this._tasks.find(x => x.id === id);
            return [id, g ? this._taskState(g).kind : '', g ? (g.title || this._label(g.executor_id)) : ''].join(':');
        }).join(',');
        const sig = [rec.taskId || '', state ? state.kind : '', name, harness, focused ? 'on' : 'off', chords.close.label, chords.move.label, solo ? 'solo' : 'split', groupSig].join('|');
        if (sig === rec.headSig) return;
        rec.headSig = sig;
        if (solo) {
            rec.headEl.hidden = true;
            rec.headEl.innerHTML = '';
            this._placeSoloGov(paneId);
            return;
        }
        rec.headEl.hidden = false;
        const avatar = t && window.TaskAvatar
            ? TaskAvatar.html({ id: t.id, harness: t.executor_id, state: state.kind, size: 16 })
            : '';
        const live = state && state.kind === 'active' ? '<i class="terminals-pane-live" aria-hidden="true"></i>' : '';
        const named = group.length > 1
            ? `<span class="terminals-pane-sessions" role="tablist" aria-label="Tasks in this pane">${this._paneTabsHtml(rec)}</span>`
            : `${avatar}
          <span class="terminals-pane-name" title="${this._esc(name)}; drag to move, or ${this._esc(chords.move.label)}">${this._esc(name)}</span>
          ${harness ? `<span class="terminals-pane-harness">${this._esc(harness)}</span>` : ''}
          ${live}`;
        rec.headEl.innerHTML = `
          ${named}
          <span class="terminals-head-spacer"></span>
          <span class="terminals-pane-gov-slot"></span>
          ${this._paneActButtons(chords)}`;
        const slot = rec.headEl.querySelector ? rec.headEl.querySelector('.terminals-pane-gov-slot') : null;
        if (slot && slot.appendChild && rec.govEl) { slot.appendChild(rec.govEl); rec.govSig = null; this._renderPaneGov(paneId); }
        this._bindPaneActs(rec.headEl, paneId);
        if (group.length > 1) this._bindPaneTabs(rec.headEl, paneId);
    },

    /** Wire one pane's tabs: the tab itself brings its task forward, the small
     *  control beside it closes that tab only. */
    _bindPaneTabs(root, paneId) {
        const all = (sel) => (root && root.querySelectorAll ? root.querySelectorAll(sel) : []);
        // Nothing awaits a click, so a failure has to land on the pane's own
        // banner rather than in an unhandled rejection nobody ever sees.
        const owned = (work) => work.catch((e) => {
            this._banner((e && e.message) || 'Could not switch task.', paneId);
        });
        all('[data-tab-id]').forEach((b) => {
            // The same chip as the strip above the workspace: it names a task,
            // so it picks that task up. The close control beside it is a
            // sibling button and never starts a drag.
            b.onpointerdown = (ev) => this._onTabPointerDown(ev, b.dataset.tabId);
            b.onclick = (ev) => {
                if (ev && ev.stopPropagation) ev.stopPropagation();
                if (this.consumeDragClick()) return;
                return owned(this._activatePaneTask(paneId, b.dataset.tabId));
            };
        });
        all('[data-tab-close-id]').forEach((b) => {
            b.onclick = (ev) => {
                if (ev && ev.stopPropagation) ev.stopPropagation();
                return owned(this._closePaneTask(paneId, b.dataset.tabCloseId));
            };
        });
    },

    /** Splitting needs a task for the new half, so the pane head offers the
     *  running tasks that are not already in a pane. */
    _splitCandidates() {
        const live = ['starting', 'working', 'blocked', 'idle'];
        // Every task in every group, not just the tabs on screen: a task in a
        // group already has a pane, and offering it would open a second one.
        const taken = new Set();
        for (const rec of this._panes.values()) for (const id of this._paneTasks(rec)) taken.add(id);
        return this._tasks.filter(t => live.includes(t.status) && !taken.has(t.id));
    },

    _openSplitPicker(paneId, dir) {
        const rec = paneId && this._panes ? this._panes.get(paneId) : null;
        if (!rec || !rec.pickerEl) return;
        this._focusPane(paneId);
        const options = this._splitCandidates();
        const label = dir === 'row' ? 'Open to the right' : 'Open below';
        rec.pickerEl.hidden = false;
        rec.pickerEl.innerHTML = `
          <span class="terminals-pane-picker-label">${label}</span>
          ${options.length
            ? options.map(t => `<button type="button" class="terminals-pane-picker-opt" data-pick-id="${this._esc(t.id)}">${this._esc(t.title || this._label(t.executor_id))}</button>`).join('')
            : '<span class="terminals-empty">No other running task. Launch one first.</span>'}
          <span class="terminals-head-spacer"></span>
          <button type="button" class="terminals-pane-picker-cancel" aria-label="Cancel the split">Cancel</button>`;
        const opts = rec.pickerEl.querySelectorAll ? rec.pickerEl.querySelectorAll('[data-pick-id]') : [];
        opts.forEach((b) => {
            b.onclick = () => {
                this._closeSplitPicker(paneId);
                this._openInNewPane(b.dataset.pickId, dir);
            };
        });
        const cancel = rec.pickerEl.querySelector ? rec.pickerEl.querySelector('.terminals-pane-picker-cancel') : null;
        if (cancel) cancel.onclick = () => this._closeSplitPicker(paneId);
    },

    /** A pointer split changes the workspace first. The new half then asks
     * for a task in its own space, instead of making the operator choose in a
     * transient bar before they can see whether they asked for right or down. */
    _splitIntoEmptyPane(paneId, dir) {
        const L = this._lay();
        if (!L || !this._layout || !this._panes || !this._panes.has(paneId)) return;
        // Two unreadable panes are worse than one usable one, so a split that
        // cannot leave both halves wide enough is declined out loud.
        if (this._splitWouldCrush(paneId, dir)) { this._refuseSplit(paneId); return; }
        const before = new Set(L.panes(this._layout).map(p => p.id));
        const next = L.split(this._layout, paneId, dir, null);
        if (next === this._layout) return;
        if (dir === 'row' && !this._canUseLayout(next, paneId)) return;
        this._layout = next;
        const added = L.panes(next).find(p => !before.has(p.id));
        if (!added) return;
        const blank = this._blankPane(added.id, null);
        // Deliberately empty: the task poll leaves it standing until the
        // operator has chosen what goes in it, or closed it.
        blank.keepEmpty = true;
        blank.emptyDir = dir;
        this._panes.set(added.id, blank);
        this._focusPane(added.id, { force: true });
        this._renderLayout();
        this._renderTaskList();
        this._renderAttachedHead();
        this._renderEmptyPaneChoice(added.id, dir);
        this._persistLayout();
        this._fitAll();
    },

    /** Every pane that is waiting for a task keeps its chooser on screen. The
     *  chooser is the only thing in such a pane, so losing it leaves a dark
     *  rectangle with no way out of it; this runs on every render and on
     *  every poll so it comes back whatever cleared it, and it tracks the
     *  task list, which moves under it. */
    _renderEmptyPaneChoices() {
        if (!this._panes) return;
        for (const [id, rec] of this._panes) {
            if (!rec || rec.taskId) continue;
            this._renderEmptyPaneChoice(id);
        }
    },

    _renderEmptyPaneChoice(paneId, dir) {
        const rec = this._panes && this._panes.get(paneId);
        if (!rec || rec.taskId || !rec.stageEl) return;
        if (dir === 'row' || dir === 'col') rec.emptyDir = dir;
        const options = this._splitCandidates();
        const placement = rec.emptyDir === 'col' ? 'lower' : (rec.emptyDir === 'row' ? 'right-hand' : 'empty');
        // Cheap enough to run on the poll: the markup is only rewritten when
        // the offered tasks or the placement have actually moved, and the
        // stage having been emptied by anything else counts as a move.
        const sig = [placement, options.map(t => t.id).join(',')].join('|');
        if (sig === rec.emptySig && rec.stageEl.innerHTML
            && String(rec.stageEl.innerHTML).indexOf('terminals-empty-pane') >= 0) return;
        rec.emptySig = sig;
        rec.stageEl.innerHTML = `<div class="terminals-empty-pane">
          <span class="terminals-empty-pane-kicker">${placement === 'empty' ? 'Empty pane' : 'New ' + placement + ' pane'}</span>
          <h3>Choose a running task</h3>
          <p>This layout is ready. Select a task to view it here.</p>
          <div class="terminals-empty-pane-options">${options.length
            ? options.map(t => `<button type="button" data-empty-pane-task="${this._esc(t.id)}">${this._esc(t.title || this._label(t.executor_id))}<span>${this._esc(this._label(t.executor_id))}</span></button>`).join('')
            : '<span class="terminals-empty">No other running task. Launch one, then select it here.</span>'}</div>
          <button type="button" class="btn btn-sm" data-empty-pane-close="1">Close this pane</button>
        </div>`;
        const buttons = rec.stageEl.querySelectorAll ? rec.stageEl.querySelectorAll('[data-empty-pane-task]') : [];
        buttons.forEach((button) => {
            button.onclick = () => this._attach(button.dataset.emptyPaneTask, paneId)
                .catch((e) => this._banner((e && e.message) || 'Could not open task.', paneId));
        });
        // With no task to offer, the chooser would otherwise be a dead end.
        // The way out is always on screen, beside the choices when there are
        // any and on its own when there are not.
        const shut = rec.stageEl.querySelectorAll ? rec.stageEl.querySelectorAll('[data-empty-pane-close]') : [];
        shut.forEach((button) => { button.onclick = () => this._closePane(paneId); });
    },

    _closeSplitPicker(paneId) {
        const rec = paneId && this._panes ? this._panes.get(paneId) : null;
        if (!rec || !rec.pickerEl) return;
        rec.pickerEl.hidden = true;
        rec.pickerEl.innerHTML = '';
    },

    // --- one pane's terminal --------------------------------------------

    /** Give a pane its task: the linked stage, or an xterm on its own socket. */
    async _mountPane(paneId) {
        const rec = this._panes ? this._panes.get(paneId) : null;
        if (!rec || !rec.taskId) return;
        const id = rec.taskId;
        // Two mounts of the same pane can overlap across the refetch below.
        // The later one owns the pane; the earlier one stops rather than
        // opening a second socket nothing will ever close.
        const token = {};
        rec.mountToken = token;
        this._closePaneSocket(rec);
        let task = this._tasks.find(x => x.id === id);
        if (!task) {
            // Opening a socket for a task the board cannot describe would
            // attach blind: no harness, no folder, no idea whether it even
            // has a PTY. The board may just be stale (something launched or
            // linked in another window), so re-read it once before refusing.
            try {
                const r = await API.terminalsTasks();
                this._tasks = r.items || [];
            } catch (e) { /* keep whatever the board last had */ }
            const still = this._panes.get(paneId);
            if (!still || still.taskId !== id || still.mountToken !== token) return;
            task = this._tasks.find(x => x.id === id);
        }
        rec.headSig = null;
        this._renderPaneHead(paneId);
        if (!task) {
            rec.mounted = true;
            if (rec.stageEl) rec.stageEl.innerHTML = '';
            this._banner('Task not found.', paneId);
            this._renderTaskList();
            this._renderAttachedHead();
            return;
        }
        if (rec.bannerEl) { rec.bannerEl.hidden = true; rec.bannerEl.textContent = ''; }
        if (task.origin === 'linked') {
            // No PTY, so no socket: the governance panel keys off the
            // session id and works exactly as it does for a launched task.
            rec.mounted = true;
            if (rec.stageEl) rec.stageEl.innerHTML = this._linkedStageHtml(task);
            this._bindLinkedStage(paneId, task);
            this._refreshRail();
            return;
        }
        if (rec.stageEl) rec.stageEl.innerHTML = '<div class="terminals-xterm"></div>';
        const mount = rec.stageEl && rec.stageEl.querySelector
            ? (rec.stageEl.querySelector('.terminals-xterm') || rec.stageEl)
            : rec.stageEl;
        const ws = new WebSocket(API.terminalsSocketUrl(id));
        rec.ws = ws;
        rec.mounted = true;
        // A task the host still holds replays its scrollback; one it has
        // forgotten replays an empty string. The difference decides whether
        // the exit frame leaves the terminal alone or explains itself.
        rec.sawOutput = false;
        const view = new TerminalView(mount, {
            onInput: (b64) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'input', data: b64 })); },
            onResize: (rows, cols) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'resize', rows, cols })); },
        });
        rec.view = view;
        ws.onopen = () => {
            const { rows, cols } = view.size;
            ws.send(JSON.stringify({ t: 'resize', rows, cols }));
            if (this._focused === paneId) view.focus();
        };
        ws.onmessage = (ev) => {
            let f;
            try { f = JSON.parse(ev.data); } catch (e) { return; }
            if (f.t === 'replay' || f.t === 'out') { if (f.data) rec.sawOutput = true; view.write(f.data); }
            else if (f.t === 'ping') ws.send(JSON.stringify({ t: 'pong' }));
            else if (f.t === 'dropped') this._banner(`Output fell behind, ${f.n} chunks skipped. Reattach to replay.`, paneId);
            else if (f.t === 'exit') {
                this._banner(f.code === 0 ? 'Task finished.' : `Task ended with exit code ${f.code}.`, paneId);
                // Output that did arrive is the session's record and worth
                // keeping on screen. With none, the pane is a black rectangle
                // that names nothing, so replace it with something that says
                // which session this was and offers to start it again here.
                if (!rec.sawOutput) this._showEndedStage(paneId, task, f.code);
            }
        };
        ws.onclose = (ev) => {
            if (ev.code === 4001) this._banner('Not authorised to attach from this origin.', paneId);
            else if (ev.code === 4004) this._banner('Task no longer exists.', paneId);
            else if (ev.code === 4008) this._banner('Connection timed out. Click the task to reattach.', paneId);
        };
        this._refreshRail();
    },

    /** The stage for a session the app does not own. Beyond saying why there
     *  is no terminal, it offers a governed one in the same folder with the
     *  same harness, but only when the outside session looks quiet.
     *
     *  The gate is the hazard `_relaunchTask` already refuses to create: two
     *  harnesses in one working folder editing the same files is worse than
     *  the ungoverned session the offer was meant to replace. A task that is
     *  still reporting gets no button at all.
     */
    _linkedStageHtml(task) {
        // The backend derives a linked task's status from its audit trail:
        // `working` while calls arrive, `idle` after a long silence, and an
        // ended status only when a session end was actually reported.
        const ended = this._isEnded(task);
        const quiet = task.status === 'idle';
        let note;
        if (ended) {
            // The Guard reported an end, so nothing is left running to collide
            // with. This is the only strong evidence of the three.
            note = '<p class="terminals-linked-note">This session has ended.</p>';
        } else if (quiet) {
            // Silence is not proof. No end was reported, so the agent may still
            // be sitting at a prompt in the person's own terminal. Say what is
            // actually known and let them decide, rather than implying safety.
            // `_ago` gives '' for a row with no timestamp, which would leave the
            // sentence dangling, so name the gap loosely instead of not at all.
            const when = this._ago(task.last_activity_at) || 'a while';
            note = `<p class="terminals-linked-note">No activity reported for ${this._esc(when)}.</p>`
                + '<p class="terminals-linked-warn">Opening a terminal here starts a separate session in this folder. Close the other one first if it is still open.</p>';
        } else {
            note = '<p class="terminals-linked-note">This session is active. Its terminal is in the window you started it in.</p>';
        }
        const action = (ended || quiet)
            ? `<button type="button" class="btn btn-sm btn-primary" data-linked-open="${this._esc(task.id)}">Open a governed terminal here</button>`
            : '';
        return `
              <div class="terminals-linked-stage">
                <div class="terminals-linked-bot">${window.TaskAvatar ? TaskAvatar.html({ id: task.id, harness: task.executor_id, state: this._taskState(task).kind, size: 56 }) : ''}</div>
                <h3>Runs outside SecureVector</h3>
                <p>This session was started in your own terminal. There is no terminal here; governance is live.</p>
                ${note}
                ${action}
              </div>`;
    },

    /** Wire the linked stage's offer of a governed terminal. Launching is the
     *  same shape as a relaunch, so it ends the same way: the fresh session
     *  swaps into this pane's tab in place of the linked task rather than
     *  growing the tab group by one every time the button is pressed.
     */
    _bindLinkedStage(paneId, task) {
        const rec = this._panes ? this._panes.get(paneId) : null;
        if (!rec || !rec.stageEl || !rec.stageEl.querySelectorAll) return;
        const buttons = rec.stageEl.querySelectorAll('[data-linked-open]');
        buttons.forEach(b => {
            b.onclick = async () => {
                // Its own flag rather than `_relaunchingId`: a restart running
                // in some other pane must not silently swallow this click, and
                // this launch must not block that restart.
                if (this._openingHereId) return;
                this._openingHereId = task.id;
                b.disabled = true;
                b.textContent = 'Opening…';
                try {
                    // Same harness, same folder, swapped into this pane: that
                    // is `_relaunchTask` exactly, so it is called rather than
                    // copied. `stopFirst` stays off because the app owns no
                    // process here; there is nothing of ours left to stop.
                    await this._relaunchTask(task, { pane: paneId });
                } catch (e) {
                    this._banner(e.message || 'Could not open a terminal here.', paneId);
                    b.disabled = false;
                    b.textContent = 'Open a governed terminal here';
                } finally {
                    this._openingHereId = null;
                }
            };
        });
    },

    /** Stand in for a terminal whose output the app no longer holds. The
     *  banner alone said only that something ended; this says which session
     *  ended, how, and puts the restart in the pane the person is looking at
     *  rather than sending them back to the board to find the card.
     */
    _showEndedStage(paneId, task, exitCode) {
        const rec = this._panes ? this._panes.get(paneId) : null;
        if (!rec || !rec.stageEl || !task) return;
        const code = typeof exitCode === 'number' ? exitCode
            : (typeof task.exit_code === 'number' ? task.exit_code : null);
        // A blank title would leave the identity line saying nothing, and the
        // harness name is the one thing every row is guaranteed to carry.
        const name = task.title || this._label(task.executor_id);
        const exitLine = code === null
            ? 'Stopped before it reported an exit code'
            : `Exit code ${code}`;
        rec.stageEl.innerHTML = `
          <div class="terminals-ended-stage">
            <div class="terminals-ended-bot">${window.TaskAvatar ? TaskAvatar.html({ id: task.id, harness: task.executor_id, state: this._taskState(task).kind, size: 56 }) : ''}</div>
            <h3>This session has ended</h3>
            <p class="terminals-ended-who">${this._esc(name)} · ${this._esc(this._label(task.executor_id))} · ${this._esc(task.workspace)}</p>
            <p class="terminals-ended-exit">${this._esc(exitLine)}</p>
            <p>The terminal output is no longer held by the app, so there is nothing to replay.</p>
            <button type="button" class="btn btn-sm btn-primary" data-ended-restart="${this._esc(paneId)}">Restart in this pane</button>
          </div>`;
        const buttons = rec.stageEl.querySelectorAll ? rec.stageEl.querySelectorAll('[data-ended-restart]') : [];
        buttons.forEach(b => {
            b.onclick = async () => {
                // Same guard the board card uses: one launch at a time, or a
                // double click puts two harnesses in one working folder.
                if (this._relaunchingId) return;
                this._relaunchingId = task.id;
                b.disabled = true;
                b.textContent = 'Restarting…';
                try {
                    await this._relaunchTask(task, { pane: paneId });
                } catch (e) {
                    this._banner(e.message || 'Could not restart the task.', paneId);
                    b.disabled = false;
                    b.textContent = 'Restart in this pane';
                } finally {
                    this._relaunchingId = null;
                }
            };
        });
    },

    // --- per-pane governance strip ----------------------------------------
    //
    // Every pane answers "what has governance done here" without the person
    // having to focus it first. One batched read per pane, throttled, cached
    // against the session id so a pane that changed task starts clean.

    PANE_GOV_TTL_MS: 10000,
    // Below this a pane cannot hold the words; below PANE_GOV_HIDE_PX it
    // cannot hold the counts either, and a truncated number is worse than none.
    PANE_GOV_COMPACT_PX: 720,
    PANE_GOV_HIDE_PX: 420,

    async _refreshPaneGov() {
        if (!this._panes || !this._panes.size) return;
        const now = Date.now();
        // The tab on screen, deliberately: the strip sits under one terminal
        // and answers for the task that terminal is showing.
        for (const [paneId, rec] of Array.from(this._panes)) {
            const t = this._tasks.find(x => x.id === rec.taskId);
            const sid = t && t.session_id;
            if (!sid) {
                if (rec.gov || rec.govSid) { rec.gov = null; rec.govSid = null; this._renderPaneGov(paneId); }
                continue;
            }
            if (rec.govSid === sid && now - (rec.govAt || 0) < this.PANE_GOV_TTL_MS) continue;
            // A pane that changed task must not show the previous one's counts
            // for a tick: they would read as evidence about the wrong agent.
            if (rec.govSid !== sid) { rec.gov = null; rec.govSig = null; }
            rec.govSid = sid;
            rec.govAt = now;
            const taskId = rec.taskId;
            let verdicts = null;
            let egress = null;
            try {
                [verdicts, egress] = await Promise.all([
                    API.terminalsVerdicts(taskId).catch(() => null),
                    API.getEgressSessionDestinations
                        ? API.getEgressSessionDestinations(sid).catch(() => null)
                        : Promise.resolve(null),
                ]);
            } catch (e) { /* a failed tick keeps the last good counts */ }
            const still = this._panes.get(paneId);
            if (!still || still.taskId !== taskId) continue;
            if (verdicts || egress) {
                const items = (verdicts && verdicts.items) || [];
                const dests = (egress && egress.destinations) || [];
                still.gov = {
                    calls: items.length,
                    blocked: items.filter(x => x.action === 'block').length,
                    hosts: dests.length,
                };
            }
            this._renderPaneGov(paneId);
        }
    },

    _renderPaneGov(paneId) {
        const rec = paneId && this._panes ? this._panes.get(paneId) : null;
        if (!rec || !rec.govEl) return;
        const g = rec.gov;
        const width = rec.el && rec.el.getBoundingClientRect
            ? (rec.el.getBoundingClientRect().width || 0) : 0;
        const hidden = !g || (width > 0 && width < this.PANE_GOV_HIDE_PX);
        const compact = width > 0 && width < this.PANE_GOV_COMPACT_PX;
        const sig = [hidden ? 'off' : 'on', compact ? 'icon' : 'full',
            g ? `${g.calls}:${g.blocked}:${g.hosts}` : ''].join('|');
        if (sig === rec.govSig) return;
        rec.govSig = sig;
        rec.govEl.hidden = hidden;
        if (rec.govEl.classList) rec.govEl.classList[compact ? 'add' : 'remove']('is-compact');
        if (hidden) { rec.govEl.innerHTML = ''; return; }
        const dot = '<span class="terminals-pane-gov-sep" aria-hidden="true">·</span>';
        const cell = (n, word, cls) => compact
            ? `<span class="terminals-pane-gov-item${cls}" title="${n} ${word}"><span class="terminals-pane-gov-n">${n}</span><span class="terminals-pane-gov-w">${word}</span></span>`
            : `<span class="terminals-pane-gov-item${cls}">${n} ${word}</span>`;
        rec.govEl.innerHTML = cell(g.calls, 'calls', '')
            + dot + cell(g.blocked, 'blocked', g.blocked > 0 ? ' is-blocked' : '')
            + dot + cell(g.hosts, 'hosts', '');
    },

    // --- stopping every task in the layout --------------------------------

    _stoppablePanes() {
        if (!this._panes) return [];
        const seen = new Set();
        const out = [];
        // The whole group, not just the tab on screen: a task behind a tab is
        // still running, and Stop all that left it running would be a lie.
        for (const rec of this._panes.values()) {
            for (const taskId of this._paneTasks(rec)) {
                const t = this._tasks.find(x => x.id === taskId);
                if (!t || seen.has(t.id)) continue;
                if (!this._RUNNING_STATUSES.includes(t.status) || t.origin === 'linked') continue;
                seen.add(t.id);
                out.push(t);
            }
        }
        return out;
    },

    _askStopAll() {
        this._stopAllArmed = true;
        clearTimeout(this._stopAllTimer);
        this._stopAllTimer = setTimeout(() => {
            this._stopAllArmed = false;
            this._headSig = null;
            this._renderAttachedHead();
        }, this.REMOVE_CONFIRM_MS);
        this._headSig = null;
        this._renderAttachedHead();
    },

    _cancelStopAll() {
        clearTimeout(this._stopAllTimer);
        this._stopAllTimer = null;
        this._stopAllArmed = false;
        this._headSig = null;
        this._renderAttachedHead();
    },

    /** Stop every running task that has a pane. The panes stay: the terminals
     *  keep their scrollback, and the audit trail is untouched. */
    async _stopAllPanes() {
        const targets = this._stoppablePanes();
        this._cancelStopAll();
        for (const t of targets) {
            try {
                await API.terminalsStop(t.id);
            } catch (e) {
                this._banner(e.message || 'Could not stop that task.', this._paneForTask(t.id));
            }
        }
        await this._refreshTasks();
    },

    // --- dragging a pane, or a task, onto a pane --------------------------
    //
    // Pointer events rather than HTML5 drag and drop: a dragstart on the head
    // would also reach the terminal underneath, and the native drag image
    // cannot be styled to match the drop zone it belongs to.
    //
    // One lifecycle serves every drag, because the part that has to be right
    // is the teardown: a ghost, a drop zone, window listeners and a pointer
    // capture that outlive their gesture are the bugs worth preventing, and
    // they are the same bugs whatever was being dragged. What differs is
    // where the drop is looked for and what the drop does, so those are the
    // hooks each source hands in.

    // Far enough that a click on the head or on a card is never read as a drag.
    DRAG_THRESHOLD_PX: 6,
    // How much of a pane's width or height counts as its edge. Inside the
    // band the pane splits; the middle joins the group, and the zone drawn
    // before the release says which.
    DROP_EDGE_FRACTION: 0.28,

    _beginDrag(spec, ev, hooks) {
        if (this._drag || !ev) return false;
        // Whatever the last gesture left behind is spent: this pointerdown is
        // a fresh one, and a flag held over from an earlier drag would eat the
        // click that ends this one.
        this._clickAfterDrag = false;
        const capture = hooks.capture || null;
        const pointerId = ev.pointerId;
        const start = { x: ev.clientX, y: ev.clientY };
        const drag = Object.assign({ started: false, hit: null, finish: null }, spec);
        this._drag = drag;

        const move = (e) => {
            if (!drag.started) {
                // At the threshold it is still a click: a drag has to travel
                // further than the hand wobbles on the way to a button.
                if (Math.abs(e.clientX - start.x) <= this.DRAG_THRESHOLD_PX
                    && Math.abs(e.clientY - start.y) <= this.DRAG_THRESHOLD_PX) return;
                drag.started = true;
                if (hooks.onStart) hooks.onStart();
                // One class on body, not one per source: the grabbing cursor
                // has to hold everywhere the pointer travels, including past
                // the edge of whatever started the drag, and every draggable
                // surface goes through this same helper.
                if (document.body && document.body.classList) document.body.classList.add('terminals-dragging');
                if (capture && capture.setPointerCapture && pointerId !== undefined) {
                    try { capture.setPointerCapture(pointerId); } catch (err) { /* no capture available */ }
                }
                this._showDragGhost(hooks.label);
            }
            this._moveDragGhost(e);
            const hit = hooks.hit(e.clientX, e.clientY);
            drag.hit = hit;
            hooks.paint(hit);
        };
        const finish = (commit) => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', cancel);
            window.removeEventListener('keydown', onEscape, true);
            if (capture && capture.releasePointerCapture && pointerId !== undefined) {
                try { capture.releasePointerCapture(pointerId); } catch (err) { /* never captured */ }
            }
            if (hooks.onStop) hooks.onStop();
            if (document.body && document.body.classList) document.body.classList.remove('terminals-dragging');
            this._clearDragGhost();
            hooks.paint(null);
            const hit = commit && drag.started ? drag.hit : null;
            // A release is followed by a click on the element the pointer was
            // captured by, and after a drag that click is the tail of the
            // gesture rather than a request to open anything. Only the sources
            // whose element opens something on click need it swallowed, and
            // only when the gesture actually ended in a release: a cancelled
            // drag, an Escape, or a teardown is followed by no click at all,
            // and a flag left standing would eat an unrelated one later.
            if (commit && drag.started && hooks.suppressClick) this._clickAfterDrag = true;
            this._drag = null;
            if (hit) hooks.drop(hit);
        };
        drag.finish = finish;
        const up = () => finish(true);
        const cancel = () => finish(false);
        const onEscape = (e) => {
            if (!e || e.key !== 'Escape') return;
            if (e.preventDefault) e.preventDefault();
            finish(false);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', cancel);
        window.addEventListener('keydown', onEscape, true);
        return true;
    },

    /** True once, straight after a drag that actually moved. The rail and the
     *  board ask before treating a click as a request to open a task. */
    consumeDragClick() {
        const was = !!this._clickAfterDrag;
        this._clickAfterDrag = false;
        return was;
    },

    /** A drag must not outlive what it is dragging. The 3 s poll can end the
     *  task under the pointer, and a pane can go with it, which would leave
     *  the drop committing against something that is no longer there. */
    _checkDragAlive() {
        const d = this._drag;
        if (!d || !d.finish) return;
        if (d.kind === 'task' && !this._tasks.some(t => t.id === d.taskId)) { d.finish(false); return; }
        if (d.kind === 'pane' && !(this._panes && this._panes.has(d.paneId))) { d.finish(false); return; }
        const hitPane = d.hit && d.hit.paneId;
        if (hitPane && this._panes && !this._panes.has(hitPane)) d.finish(false);
    },

    _onHeadPointerDown(ev, paneId) {
        if (!ev) return;
        if (ev.button !== undefined && ev.button !== 0) return;
        const target = ev.target;
        if (target && target.closest && target.closest('.terminals-pane-act, .terminals-pane-picker, button')) return;
        const rec = this._panes ? this._panes.get(paneId) : null;
        if (!rec) return;
        this._focusPane(paneId);
        const L = this._lay();
        if (!L || !this._layout || L.panes(this._layout).length < 2) return;
        this._beginDrag({ kind: 'pane', paneId }, ev, {
            capture: rec.headEl,
            label: this._dragLabel(rec.taskId) || 'Pane',
            onStart: () => { if (rec.el && rec.el.classList) rec.el.classList.add('is-dragging'); },
            onStop: () => { if (rec.el && rec.el.classList) rec.el.classList.remove('is-dragging'); },
            hit: (x, y) => this._paneDropAt(x, y, paneId),
            paint: (hit) => this._showDropZone(hit),
            drop: (hit) => {
                if (hit.edge === 'centre') this._mergePanes(paneId, hit.paneId);
                else this._movePane(paneId, hit.paneId, hit.edge);
            },
        });
    },

    /** Pick a task up from the rail and drop it into a pane. The rail offers
     *  every task it lists and does not know whether there is anywhere to put
     *  one, so the refusal lives here. */
    beginTaskDrag(taskId, ev) {
        // Before the refusals, not after: a source that declines to drag must
        // still not leave a click owed from some earlier drag.
        this._clickAfterDrag = false;
        if (!ev || !taskId) return false;
        if (ev.button !== undefined && ev.button !== 0) return false;
        // No panes means no workspace on screen, which is also what a page
        // that has been torn down looks like.
        if (!this._layout || !this._panes || !this._panes.size) return false;
        if (!document.getElementById('terminals-attached-body')) return false;
        if (!this._tasks.some(t => t.id === taskId)) return false;
        return this._beginDrag({ kind: 'task', taskId }, ev, {
            capture: ev.currentTarget || null,
            label: this._dragLabel(taskId),
            // The row opens its task on click, and the release lands on it.
            suppressClick: true,
            hit: (x, y) => this._taskDropAt(x, y, taskId),
            paint: (hit) => this._showDropZone(hit),
            drop: (hit) => { this._dropTaskOnPane(taskId, hit.paneId, hit.edge); },
        });
    },

    /** Where a pane may be dropped: an edge of another pane, or its centre,
     *  which joins that pane's group. Null when there is nothing under the
     *  pointer to drop onto. */
    _paneDropAt(x, y, paneId) {
        const hit = this._dropTargetAt(x, y, paneId);
        return hit.paneId && hit.edge ? hit : null;
    },

    /** The same, for a task. A task dropped on the centre of the pane that
     *  already holds it changes nothing, so that is not offered as a target:
     *  a drop zone has to promise something real. */
    _taskDropAt(x, y, taskId) {
        const hit = this._dropTargetAt(x, y, null);
        if (!hit.paneId || !hit.edge) return null;
        if (hit.edge === 'centre' && this._paneForTask(taskId) === hit.paneId) return null;
        return hit;
    },

    _dragLabel(taskId) {
        const t = taskId ? this._tasks.find(x => x.id === taskId) : null;
        return t ? (t.title || this._label(t.executor_id)) : '';
    },

    /** Which pane is under the pointer, and which of its edges the pointer is
     *  close enough to count as a drop. The centre is a drop of its own: it
     *  is what joins a group rather than splitting the pane. */
    _dropTargetAt(x, y, sourceId) {
        const none = { paneId: null, edge: null, el: null };
        if (!document.elementFromPoint) return none;
        let el = document.elementFromPoint(x, y);
        while (el && !(el.classList && el.classList.contains && el.classList.contains('terminals-pane'))) {
            el = el.parentNode;
        }
        if (!el || !el.dataset || !el.getBoundingClientRect) return none;
        const paneId = el.dataset.paneId;
        if (!paneId || paneId === sourceId || !this._panes.has(paneId)) return none;
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return none;
        const fx = (x - r.left) / r.width;
        const fy = (y - r.top) / r.height;
        const f = this.DROP_EDGE_FRACTION;
        const bands = [
            { edge: 'left', d: fx },
            { edge: 'right', d: 1 - fx },
            { edge: 'top', d: fy },
            { edge: 'bottom', d: 1 - fy },
        ].filter(b => b.d < f).sort((a, b) => a.d - b.d);
        if (!bands.length) return { paneId, edge: 'centre', el };
        return { paneId, edge: bands[0].edge, el };
    },

    // What each drop actually does, said plainly before the release commits
    // to it. The centre reads as joining the target's tab group, since that
    // is easy to mistake for the source pane disappearing; an edge reads as
    // the split it produces.
    DROP_ZONE_LABELS: {
        centre: 'Add as tab',
        left: 'Split left',
        right: 'Split right',
        top: 'Split top',
        bottom: 'Split bottom',
    },

    _showDropZone(hit) {
        if (!hit || !hit.edge || !hit.paneId) { this._clearDropZone(); return; }
        const rec = this._panes.get(hit.paneId);
        if (!rec || !rec.el || !rec.el.appendChild) return;
        if (!this._dropEl) {
            this._dropEl = document.createElement('div');
            this._dropEl.className = 'terminals-drop-zone';
            if (this._dropEl.setAttribute) this._dropEl.setAttribute('aria-hidden', 'true');
        }
        const z = this._dropEl;
        const s = z.style;
        if (s) {
            // The shape is decided before the release, so the zone covers
            // exactly what the drop would claim: half the pane for an edge,
            // the whole of it for the centre, which takes the pane as it is.
            const centre = hit.edge === 'centre';
            const sideways = hit.edge === 'left' || hit.edge === 'right';
            s.left = hit.edge === 'right' ? '50%' : '0';
            s.top = hit.edge === 'bottom' ? '50%' : '0';
            s.width = centre || !sideways ? '100%' : '50%';
            s.height = centre || sideways ? '100%' : '50%';
        }
        if (z.dataset) z.dataset.edge = hit.edge;
        // The zone itself is aria-hidden and pointer-events: none, so the
        // label is decoration, not content: it cannot be announced or hit,
        // it can only be seen.
        if (!this._dropLabelEl) {
            this._dropLabelEl = document.createElement('span');
            this._dropLabelEl.className = 'terminals-drop-zone-label';
            z.appendChild(this._dropLabelEl);
        }
        this._dropLabelEl.textContent = this.DROP_ZONE_LABELS[hit.edge] || '';
        if (z.parentNode !== rec.el) rec.el.appendChild(z);
    },

    _clearDropZone() {
        const z = this._dropEl;
        if (z && z.parentNode && z.parentNode.removeChild) {
            try { z.parentNode.removeChild(z); } catch (e) { /* already detached */ }
        }
    },

    _showDragGhost(label) {
        if (!this._ghostEl) {
            this._ghostEl = document.createElement('div');
            this._ghostEl.className = 'terminals-drag-ghost';
            if (this._ghostEl.setAttribute) this._ghostEl.setAttribute('aria-hidden', 'true');
        }
        // textContent, not innerHTML: a task title is the user's text.
        this._ghostEl.textContent = label || 'Task';
        const host = document.body;
        if (host && host.appendChild && this._ghostEl.parentNode !== host) host.appendChild(this._ghostEl);
    },

    _moveDragGhost(ev) {
        const g = this._ghostEl;
        if (!g || !g.style || !ev) return;
        g.style.left = (ev.clientX + 12) + 'px';
        g.style.top = (ev.clientY + 12) + 'px';
    },

    _clearDragGhost() {
        const g = this._ghostEl;
        if (g && g.parentNode && g.parentNode.removeChild) {
            try { g.parentNode.removeChild(g); } catch (e) { /* already detached */ }
        }
    },

    /** Drop a pane on another pane's centre: everything it holds joins that
     *  pane's group as tabs, and the pane itself goes. */
    _mergePanes(paneId, targetPaneId) {
        const L = this._lay();
        if (!L || !this._layout || !this._panes) return;
        if (!this._panes.has(targetPaneId) || !this._panes.has(paneId)) return;
        const next = L.mergePane(this._layout, paneId, targetPaneId);
        // The model decides whether the two groups fit, so it is the only
        // place that rule lives. A drop names two panes that exist and differ,
        // so the one way it can refuse is that they would not fit.
        if (next === this._layout) {
            this._banner('This pane is full. Close a tab first.', targetPaneId);
            return;
        }
        this._layout = next;
        // The source pane left the tree, so _reapPanes hangs up its socket and
        // disposes its terminal; the task it was showing is a tab now.
        this._reapPanes();
        this._syncPaneGroups();
        if (!this._panes.has(this._focused)) {
            this._focused = null;
            this._focusPane(targetPaneId, { force: true });
        }
        this._renderLayout();
        this._renderTaskList();
        this._renderAttachedHead();
        this._persistLayout();
        this._refreshRail();
        this._fitAll();
    },

    /** A task left a pane. If it was the tab that pane was showing, the pane
     *  picks up the neighbour the model chose, with the socket swap any other
     *  tab switch makes. */
    _settlePaneAfterLeave(paneId, taskId) {
        const L = this._lay();
        const rec = paneId && this._panes ? this._panes.get(paneId) : null;
        if (!L || !rec || rec.taskId !== taskId) return Promise.resolve();
        const node = this._layout ? L.find(this._layout, paneId) : null;
        if (!node || !node.taskId) return Promise.resolve();
        return this._attach(node.taskId, paneId);
    },

    /** Drop a task on a pane. The centre joins that pane's group and shows it;
     *  an edge opens it in a half of its own. Either way the task leaves the
     *  pane that held it first, because a task lives in exactly one pane. */
    async _dropTaskOnPane(taskId, targetPaneId, edge) {
        const L = this._lay();
        if (!L || !this._layout || !taskId || !edge) return;
        if (!this._panes || !this._panes.has(targetPaneId)) return;
        const from = this._paneForTask(taskId);
        if (edge === 'centre') {
            if (from === targetPaneId) return;
            const next = L.addTask(this._layout, targetPaneId, taskId);
            if (next === this._layout) {
                this._banner('This pane is full. Close a tab first.', targetPaneId);
                return;
            }
            this._layout = next;
            this._reapPanes();
            this._syncPaneGroups();
            await this._settlePaneAfterLeave(from, taskId);
            // A mount inside that wait can re-read the board, and a destroy()
            // inside it leaves no layout to put anything in. Attaching anyway
            // would build a fresh pane and a socket on a page that is gone.
            if (!this._layout) return;
            await this._attach(taskId, targetPaneId);
            if (!this._layout) return;
            this._fitAll();
            return;
        }
        const dir = L.EDGE_DIRS[edge];
        if (!dir) return;
        let tree = from ? L.removeTask(this._layout, taskId) : this._layout;
        // The task was the only one in the only pane, so there is nothing for
        // the half it would open in to sit beside.
        if (!tree || !L.find(tree, targetPaneId)) return;
        const before = new Set(L.panes(tree).map(p => p.id));
        tree = L.split(tree, targetPaneId, dir, taskId);
        const added = L.panes(tree).find(p => !before.has(p.id));
        if (!added) return;
        // split() always puts the new pane second; these two edges want it
        // first, and move() is what knows how to put a pane on a given side.
        if (edge === 'left' || edge === 'top') tree = L.move(tree, added.id, targetPaneId, edge);
        if (dir === 'row' && !this._canUseLayout(tree, targetPaneId)) return;
        this._layout = tree;
        this._panes.set(added.id, this._blankPane(added.id, taskId));
        this._reapPanes();
        this._syncPaneGroups();
        await this._settlePaneAfterLeave(from, taskId);
        if (!this._layout || !this._panes.has(added.id)) return;
        this._focusPane(added.id, { force: true });
        this._renderLayout();
        this._renderTaskList();
        this._renderAttachedHead();
        await this._mountPane(added.id);
        if (!this._layout) return;
        this._persistLayout();
        this._fitAll();
    },

    /** Two cards on the board become one pane holding both: the card that was
     *  dropped on opens first, and the card that was dragged joins it as the
     *  tab on screen. This is how sessions are grouped without first opening
     *  one of them, which is the only way to do it while the board is up. */
    async _openTasksTogether(targetTaskId, draggedTaskId) {
        if (!targetTaskId || !draggedTaskId || targetTaskId === draggedTaskId) return;
        if (!this._tasks.some(t => t.id === targetTaskId)) return;
        if (!this._tasks.some(t => t.id === draggedTaskId)) return;
        await this._attach(targetTaskId);
        const pane = this._paneForTask(targetTaskId);
        if (!pane) return;
        await this._dropTaskOnPane(draggedTaskId, pane, 'centre');
    },

    /** A tab chip is a drag source too, and the one the owner reaches for
     *  first: the chip is the task on screen, so dragging it onto a pane edge
     *  is the obvious way to give that task a half of its own. Both strips
     *  hand their chips here (the tab row above the workspace, and the tabs
     *  inside a grouped pane's head) because both name a task and both open
     *  that task on click. The click that ends a drag is swallowed by
     *  consumeDragClick() in the chip's own click handler, the same bargain
     *  the rail rows and the board cards already keep. */
    _onTabPointerDown(ev, taskId) {
        if (!ev || !taskId) return;
        if (ev.button !== undefined && ev.button !== 0) return;
        const target = ev.target;
        // A control that lives in or beside a chip is a button in its own
        // right: closing a tab, launching a task or opening the overflow is
        // never the opening move of a drag.
        if (target && target.closest && target.closest(
            '.terminals-pane-session-close, [data-tab-close-id], .terminals-pane-tab-new, .terminals-pane-tab-more')) return;
        this.beginTaskDrag(taskId, ev);
    },

    /** A card on the board is a drag source too. There are no panes to drop
     *  onto while the board is showing, so the target is another card. */
    _onCardPointerDown(ev, taskId) {
        // Before the refusals, for the same reason beginTaskDrag clears here.
        this._clickAfterDrag = false;
        if (!ev || !taskId) return;
        if (ev.button !== undefined && ev.button !== 0) return;
        const target = ev.target;
        if (target && target.closest && target.closest('.terminals-task-remove, .terminals-task-relaunch, .terminals-task-confirm')) return;
        this._beginDrag({ kind: 'task', taskId }, ev, {
            capture: ev.currentTarget || null,
            label: this._dragLabel(taskId),
            // A card opens its task on click, the same as a rail row.
            suppressClick: true,
            hit: (x, y) => this._cardDropAt(x, y, taskId),
            paint: (hit) => this._paintCardTarget(hit),
            drop: (hit) => { this._openTasksTogether(hit.taskId, taskId); },
        });
    },

    /** The card under the pointer, when it is a different one from the card
     *  being dragged. Empty space and the card itself are no drop. */
    _cardDropAt(x, y, sourceTaskId) {
        if (!document.elementFromPoint) return null;
        let el = document.elementFromPoint(x, y);
        while (el && !(el.classList && el.classList.contains && el.classList.contains('terminals-task'))) {
            el = el.parentNode;
        }
        if (!el || !el.dataset) return null;
        const taskId = el.dataset.id;
        if (!taskId || taskId === sourceTaskId) return null;
        if (!this._tasks.some(t => t.id === taskId)) return null;
        return { taskId, el };
    },

    /** Hold the task id rather than the card element: the 3 s poll rebuilds
     *  the board mid drag, and the node that was highlighted is detached by
     *  the time the highlight comes off. */
    _paintCardTarget(hit) {
        const next = hit ? hit.taskId : null;
        if (this._cardTargetId && this._cardTargetId !== next) {
            const was = this._cardElFor(this._cardTargetId);
            if (was && was.classList) was.classList.remove('is-drop-target');
        }
        this._cardTargetId = next;
        const el = next ? this._cardElFor(next) : null;
        if (el && el.classList) el.classList.add('is-drop-target');
    },

    _cardElFor(taskId) {
        const list = document.getElementById('terminals-task-list');
        const cards = list && list.querySelectorAll ? list.querySelectorAll('.terminals-task[data-id]') : [];
        // Matched on the dataset rather than built into a selector: a task id
        // is opaque and has no business being spliced into one.
        return Array.from(cards).find(c => c.dataset && c.dataset.id === taskId) || null;
    },

    /** Commit a move: the pane keeps its id, so _renderLayout() moves its
     *  element rather than building a new one and its terminal survives. */
    _movePane(paneId, targetPaneId, edge) {
        const L = this._lay();
        if (!L || !this._layout) return;
        const next = L.move(this._layout, paneId, targetPaneId, edge);
        if (next === this._layout) return;
        if (L.EDGE_DIRS[edge] === 'row' && !this._canUseLayout(next, targetPaneId)) return;
        this._layout = next;
        this._renderLayout();
        this._focusPane(paneId);
        this._persistLayout();
        this._fitAll();
    },

    /** The keyboard equivalent: move the focused pane against that edge of
     *  the nearest pane lying that way in the tree. */
    _moveFocusedPane(edge) {
        const L = this._lay();
        if (!L || !this._focused || !this._layout) return;
        const dir = L.EDGE_DIRS[edge];
        if (!dir) return;
        const wantA = edge === 'left' || edge === 'top';
        let id = this._focused;
        let holder = L.parent(this._layout, id);
        while (holder) {
            const onB = holder.b.id === id;
            if (holder.dir === dir && (wantA ? onB : !onB)) {
                const neighbour = L.panes(wantA ? holder.a : holder.b)[0];
                if (neighbour && neighbour.id !== this._focused) {
                    this._movePane(this._focused, neighbour.id, edge);
                }
                return;
            }
            id = holder.id;
            holder = L.parent(this._layout, id);
        }
    },

    // --- usable width ----------------------------------------------------
    //
    // Every measurement here is taken off the element that is actually on
    // screen, never off the window: the panes live inside the centre column,
    // so an expanded governance column has already been subtracted by the
    // time a pane or a split reports its width. The fallback below does the
    // same subtraction by hand for the moment before anything has been laid
    // out.

    /** The width the panes have between them right now, in CSS pixels, or 0
     *  when nothing is measurable yet. */
    _availablePaneWidth() {
        const ws = this._workspaceEl();
        const r = ws && ws.getBoundingClientRect ? ws.getBoundingClientRect() : null;
        if (!r || !(r.width > 0)) return 0;
        if (this._govStacked && !this._govCollapsed) return r.width;
        const gov = this._govCollapsed ? this.GOV_STRIP_W : (this._govWidth || this.GOV_DEFAULT_W);
        return Math.max(0, r.width - gov - this.GOV_GUTTER_W);
    },

    /** Leaf widths compose through the pane tree: side-by-side children add,
     *  while vertically stacked children share the same horizontal space. */
    _treeMinWidth(node) {
        if (!node) return 0;
        if (node.type === 'pane') return this.PANE_USABLE_W;
        if (node.type !== 'split') return 0;
        const a = this._treeMinWidth(node.a);
        const b = this._treeMinWidth(node.b);
        return node.dir === 'row' ? a + this.GUTTER_W + b : Math.max(a, b);
    },

    _paneAreaMinWidth(tree) {
        return Math.max(this.PANE_MIN_W, this._treeMinWidth(tree || this._layout));
    },

    /** Test the real ratios as well as the aggregate minimum: a nested child
     *  can be too narrow even when the root has enough total pixels. */
    _layoutFitsWidth(node, width) {
        if (!node || !(width > 0)) return true;
        if (node.type === 'pane') return width >= this.PANE_USABLE_W;
        if (node.type !== 'split') return true;
        if (node.dir === 'col') {
            return this._layoutFitsWidth(node.a, width)
                && this._layoutFitsWidth(node.b, width);
        }
        const span = width - this.GUTTER_W;
        if (!(span >= 0)) return false;
        const ratio = typeof node.ratio === 'number' && isFinite(node.ratio) ? node.ratio : 0.5;
        return this._layoutFitsWidth(node.a, span * ratio)
            && this._layoutFitsWidth(node.b, span * (1 - ratio));
    },

    /** A prospective horizontal operation is committed only after its final
     *  tree fits. The caller has already removed any source pane, so reclaimed
     *  width participates in this same check. */
    _canUseLayout(tree, paneId) {
        const width = this._availablePaneWidth();
        if (!(width > 0) || this._layoutFitsWidth(tree, width)) return true;
        this._refuseSplit(paneId);
        return false;
    },

    /** One pane's width on screen, falling back to the whole pane area. */
    _paneWidth(paneId) {
        const rec = paneId && this._panes ? this._panes.get(paneId) : null;
        const el = rec && rec.el;
        const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        if (r && r.width > 0) return r.width;
        return this._availablePaneWidth();
    },

    /** Would splitting this pane that way leave a half too narrow to read?
     *  Only a side-by-side split changes a pane's width, so a split downwards
     *  is never refused on width. Unmeasurable geometry answers no: refusing
     *  a split because the page has not been laid out yet would be a worse
     *  failure than the one this guards against. */
    _splitWouldCrush(paneId, dir) {
        if (dir !== 'row') return false;
        const width = this._paneWidth(paneId);
        if (!(width > 0)) return false;
        const half = (width - this.GUTTER_W) / 2;
        // An already-too-narrow pane is not made worse by the check refusing;
        // it is made worse by the split, which is exactly what is refused.
        return half < this.PANE_USABLE_W;
    },

    /** Say no, in the pane the operator asked in, and say why. */
    _refuseSplit(paneId) {
        this._banner('Not enough width to split. The panes need at least '
            + this.PANE_USABLE_W + 'px each; even out or close a pane first.', paneId);
    },

    /** Null means unmeasurable/vertical. An infeasible measured row is an
     *  explicit result so ratio changes can be rejected rather than escaping
     *  the clamp. Child subtree minima make nested layouts safe too. */
    _ratioBounds(splitId) {
        const L = this._lay();
        const node = L ? L.find(this._layout, splitId) : null;
        if (!node || node.type !== 'split' || node.dir !== 'row') return null;
        const el = this._splitEls ? this._splitEls.get(splitId) : null;
        const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        const span = r && r.width > 0 ? r.width - this.GUTTER_W : 0;
        if (!(span > 0)) return null;
        const lo = this._treeMinWidth(node.a) / span;
        const hi = 1 - (this._treeMinWidth(node.b) / span);
        return { lo, hi, infeasible: lo > hi };
    },

    // --- gutters ---------------------------------------------------------

    _setSplitRatio(splitId, ratio) {
        const L = this._lay();
        if (!L) return false;
        const bounds = this._ratioBounds(splitId);
        if (bounds && bounds.infeasible) return false;
        let want = ratio;
        if (bounds && typeof want === 'number' && isFinite(want)) {
            want = Math.min(bounds.hi, Math.max(bounds.lo, want));
        }
        const next = L.setRatio(this._layout, splitId, want);
        if (next === this._layout) return false;
        this._layout = next;
        this._applyRatios();
        return true;
    },

    /** Put every split back to an even share. Ratios only: nothing detaches,
     *  nothing closes, every terminal keeps its socket and is simply refitted
     *  into the width it ends up with. */
    _rebalancePanes() {
        const L = this._lay();
        if (!L || !this._layout || !L.rebalance) return false;
        const next = L.rebalance(this._layout);
        if (next === this._layout) return false;
        this._layout = next;
        this._applyRatios();
        this._persistLayout();
        this._fitAll();
        return true;
    },

    /** Write the ratios onto the split elements without rebuilding the tree:
     *  a rebuild during a drag would move the terminals on every frame. */
    _applyRatios() {
        const L = this._lay();
        if (!L || !this._layout) return;
        const walk = (n) => {
            if (!n || n.type !== 'split') return;
            const el = this._splitEls.get(n.id);
            if (el && el.style && el.style.setProperty) el.style.setProperty('--ratio', String(n.ratio));
            walk(n.a);
            walk(n.b);
        };
        walk(this._layout);
    },

    _startGutterDrag(ev, splitId) {
        const L = this._lay();
        const node = L ? L.find(this._layout, splitId) : null;
        if (!node || node.type !== 'split') return;
        const gutter = ev && ev.currentTarget;
        if (!gutter) return;
        const dir = node.dir;
        const pointerId = ev.pointerId;
        // The split element is looked up per frame rather than captured: a
        // re-render mid drag replaces it, and measuring the detached one would
        // read a zero rect and snap the ratio to its clamp.
        const hostOf = () => {
            const el = this._splitEls.get(splitId);
            return el && el.getBoundingClientRect ? el : null;
        };
        if (!hostOf()) return;
        if (ev.preventDefault) ev.preventDefault();
        if (gutter.setPointerCapture && pointerId !== undefined) {
            try { gutter.setPointerCapture(pointerId); } catch (e) { /* no capture available */ }
        }
        const move = (e) => {
            const host = hostOf();
            if (!host) return;
            const r = host.getBoundingClientRect();
            const span = dir === 'row' ? r.width : r.height;
            if (!span) return;
            const ratio = dir === 'row' ? (e.clientX - r.left) / span : (e.clientY - r.top) / span;
            this._setSplitRatio(splitId, ratio);
        };
        // A cancelled pointer (a gesture taken over by the browser, a lost
        // device) ends the drag exactly like a release: leaving the move
        // listener behind would resize the panes on every later mouse move.
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            if (gutter.releasePointerCapture && pointerId !== undefined) {
                try { gutter.releasePointerCapture(pointerId); } catch (e) { /* never captured */ }
            }
            this._persistLayout();
            this._fitAll();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
    },

    _onGutterKey(ev, splitId) {
        const L = this._lay();
        const node = L ? L.find(this._layout, splitId) : null;
        if (!node || node.type !== 'split') return;
        const back = node.dir === 'row' ? 'ArrowLeft' : 'ArrowUp';
        const fwd = node.dir === 'row' ? 'ArrowRight' : 'ArrowDown';
        let step = 0;
        if (ev.key === back) step = -this.GUTTER_STEP;
        else if (ev.key === fwd) step = this.GUTTER_STEP;
        else return;
        if (ev.preventDefault) ev.preventDefault();
        if (this._setSplitRatio(splitId, node.ratio + step)) {
            this._persistLayout();
            this._fitAll();
        }
    },

    // --- governance dock -------------------------------------------------
    //
    // The dock is the pane gutter's sibling in spirit: same pointer drag, same
    // arrow-key nudge, same "persist on release, then refit" ending. It moves
    // one CSS variable (--gov-w) rather than a ratio because the pane area,
    // not the column, is what should absorb a window resize.

    /** The flex row the column lives in. Looked up rather than held: the page
     *  rebuilds its markup on every render. */
    _workspaceEl() {
        if (typeof document === 'undefined' || !document || !document.querySelector) return null;
        return document.querySelector('.terminals-workspace');
    },

    _govEls() {
        return {
            dock: document.getElementById('terminals-governance'),
            edge: document.getElementById('terminals-gov-edge'),
            gutter: document.getElementById('terminals-gov-gutter'),
            toggle: document.getElementById('terminals-governance-toggle'),
            body: document.getElementById('terminals-governance-body'),
        };
    },

    _bindGovDock() {
        const { gutter, toggle } = this._govEls();
        if (toggle) toggle.onclick = () => this._toggleGovDock();
        if (gutter) {
            gutter.onpointerdown = (ev) => this._startGovDrag(ev);
            gutter.ondblclick = () => { this._setGovWidth(this.GOV_DEFAULT_W); this._persistGov(); this._fitAll(); };
            gutter.onkeydown = (ev) => this._onGovKey(ev);
        }
        this._restoreGov();
        this._syncGovDock();
        this._bindGovLayoutObserver();
    },

    /** Switch to the vertical arrangement from the space this workspace
     *  actually owns, not the viewport. Sidebar and parent layout changes are
     *  therefore handled the same way as a window resize. */
    _syncGovLayoutMode() {
        const ws = this._workspaceEl();
        const rect = ws && ws.getBoundingClientRect ? ws.getBoundingClientRect() : null;
        const width = rect && rect.width > 0 ? rect.width : 0;
        const stacked = !this._govCollapsed && width > 0
            && width < this._paneAreaMinWidth() + this.GOV_GUTTER_W + this.GOV_MIN_W;
        const changed = stacked !== !!this._govStacked;
        if (changed && stacked) this._cancelGovDrag();
        this._govStacked = stacked;
        if (ws && ws.classList) ws.classList[stacked ? 'add' : 'remove']('is-gov-stacked');
        const { gutter } = this._govEls();
        if (gutter) gutter.hidden = !!this._govCollapsed || stacked;
        if (changed && !stacked && !this._govCollapsed) {
            this._setGovWidth(this._govWidth || this.GOV_DEFAULT_W);
        }
        return changed;
    },

    _bindGovLayoutObserver() {
        this._unbindGovLayoutObserver();
        const ws = this._workspaceEl();
        if (!ws) return;
        const update = () => {
            if (this._destroyed) return;
            const changed = this._syncGovLayoutMode();
            if (!this._govCollapsed && !this._govStacked) this._setGovWidth(this._govWidth || this.GOV_DEFAULT_W);
            if (changed) this._fitAll();
        };
        this._govResizeHandler = update;
        if (typeof ResizeObserver !== 'undefined') {
            try {
                this._govResizeObserver = new ResizeObserver(update);
                this._govResizeObserver.observe(ws);
                return;
            } catch (e) { this._govResizeObserver = null; }
        }
        if (typeof window !== 'undefined' && window.addEventListener) {
            window.addEventListener('resize', update);
        }
    },

    _unbindGovLayoutObserver() {
        if (this._govResizeObserver && this._govResizeObserver.disconnect) {
            try { this._govResizeObserver.disconnect(); } catch (e) { /* already detached */ }
        }
        if (this._govResizeHandler && typeof window !== 'undefined' && window.removeEventListener) {
            window.removeEventListener('resize', this._govResizeHandler);
        }
        this._govResizeObserver = null;
        this._govResizeHandler = null;
    },

    /** Clamp a column width against the space the workspace actually has, so
     *  neither the panes nor the column can be dragged to nothing. */
    _clampGovWidth(px) {
        let w = Number(px);
        if (!isFinite(w)) w = this.GOV_DEFAULT_W;
        const ws = this._workspaceEl();
        const rect = ws && ws.getBoundingClientRect ? ws.getBoundingClientRect() : null;
        let max = this.GOV_DEFAULT_W * 3;
        if (rect && rect.width > 0) {
            max = Math.max(0, rect.width - this._paneAreaMinWidth() - this.GOV_GUTTER_W);
        }
        // A transient infeasible row must not invent pixels. The measured
        // layout-mode check will stack it; until then its honest max may be
        // below the normal governance minimum.
        if (max < this.GOV_MIN_W) return Math.max(0, Math.min(max, w));
        return Math.max(this.GOV_MIN_W, Math.min(max, w));
    },

    _setGovWidth(px) {
        if (this._govStacked) return;
        this._govWidth = this._clampGovWidth(px);
        const { dock } = this._govEls();
        if (dock && dock.style && dock.style.setProperty) {
            dock.style.setProperty('--gov-w', this._govWidth + 'px');
        }
    },

    /** The one place that decides collapsed or expanded.
     *
     *  Governance is expanded by default: the activity is the point of the
     *  page, and a panel that hides itself until a task attaches is a panel
     *  people never learn they have. Once the person clicks the toggle their
     *  choice wins in both directions, attached or not. */
    _syncGovDock() {
        const { dock, edge, gutter, toggle, body } = this._govEls();
        const collapsed = this._govUserSet ? !!this._govCollapsed : false;
        this._govCollapsed = collapsed;
        if (!this._govWidth) this._govWidth = this.GOV_DEFAULT_W;
        if (dock) {
            if (dock.classList) dock.classList[collapsed ? 'add' : 'remove']('is-collapsed');
        }
        if (edge && edge.classList) edge.classList[collapsed ? 'add' : 'remove']('is-collapsed');
        this._syncGovLayoutMode();
        if (dock && !collapsed && !this._govStacked) this._setGovWidth(this._govWidth);
        // Hidden rather than merely unstyled: a collapsed column has no edge
        // to drag, and a focusable separator that resizes nothing is a trap.
        // The separate edge toggle stays reachable while the static strip
        // keeps the panel named.
        if (gutter) gutter.hidden = collapsed || this._govStacked;
        if (body) body.hidden = collapsed;
        if (toggle && toggle.setAttribute) {
            toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            toggle.setAttribute('aria-label', collapsed ? 'Expand governance activity' : 'Collapse governance activity');
        }
    },

    _toggleGovDock() {
        this._govUserSet = true;
        this._govCollapsed = !this._govCollapsed;
        this._syncGovDock();
        this._persistGov();
        this._fitAll();
    },

    /** Open the column without recording a preference: the approval Review
     *  button needs the inbox on screen, which is not the same as the person
     *  choosing to keep it open. */
    _expandGovDock() {
        if (!this._govCollapsed) return;
        this._govCollapsed = false;
        if (this._govUserSet) this._govUserSet = false;
        this._syncGovDock();
        this._fitAll();
    },

    _startGovDrag(ev) {
        if (!ev || (ev.button !== undefined && ev.button !== 0)) return;
        if (this._govCollapsed || this._govStacked) return;
        this._cancelGovDrag();
        const gutter = ev.currentTarget;
        if (!gutter) return;
        const pointerId = ev.pointerId;
        if (ev.preventDefault) ev.preventDefault();
        if (gutter.setPointerCapture && pointerId !== undefined) {
            try { gutter.setPointerCapture(pointerId); } catch (e) { /* no capture available */ }
        }
        // Measured per frame, like the pane gutter: a re-render mid drag would
        // otherwise leave us reading a detached rect and snapping to a clamp.
        // The column is dragged by its left edge, so the width is whatever is
        // left between the pointer and the workspace's right edge.
        const startWidth = this._govWidth || this.GOV_DEFAULT_W;
        let done = false;
        const move = (e) => {
            const ws = this._workspaceEl();
            const r = ws && ws.getBoundingClientRect ? ws.getBoundingClientRect() : null;
            if (!r || !r.width) return;
            this._setGovWidth(r.right - e.clientX);
        };
        const finish = (commit) => {
            if (done) return;
            done = true;
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onCancel);
            if (gutter.removeEventListener) gutter.removeEventListener('lostpointercapture', onLost);
            if (gutter.releasePointerCapture && pointerId !== undefined) {
                try { gutter.releasePointerCapture(pointerId); } catch (e) { /* never captured */ }
            }
            if (this._govDrag && this._govDrag.finish === finish) this._govDrag = null;
            if (!commit) {
                this._govWidth = startWidth;
                const { dock } = this._govEls();
                if (dock && dock.style && dock.style.setProperty) {
                    dock.style.setProperty('--gov-w', startWidth + 'px');
                }
                return;
            }
            if (!this._destroyed && !this._govStacked) {
                this._persistGov();
                this._fitAll();
            }
        };
        const onUp = () => finish(true);
        const onCancel = () => finish(false);
        const onLost = () => finish(false);
        this._govDrag = { finish };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onCancel);
        if (gutter.addEventListener) gutter.addEventListener('lostpointercapture', onLost);
    },

    _cancelGovDrag() {
        if (this._govDrag && this._govDrag.finish) this._govDrag.finish(false);
        this._govDrag = null;
    },

    _onGovKey(ev) {
        if (!ev || this._govStacked) return;
        // Left widens because the edge being moved is the column's left one:
        // pushing it left gives governance more room.
        let step = 0;
        if (ev.key === 'ArrowLeft') step = this.GOV_STEP;
        else if (ev.key === 'ArrowRight') step = -this.GOV_STEP;
        else return;
        if (ev.preventDefault) ev.preventDefault();
        this._setGovWidth((this._govWidth || this.GOV_DEFAULT_W) + step);
        this._persistGov();
        this._fitAll();
    },

    _persistGov() {
        const store = this._store();
        if (!store) return;
        try {
            store.setItem(this.GOV_KEY, JSON.stringify({
                v: this.GOV_STATE_V, w: Math.round(this._govWidth || this.GOV_DEFAULT_W),
                collapsed: !!this._govCollapsed, userSet: !!this._govUserSet,
            }));
        } catch (e) { /* storage unavailable or full */ }
    },

    _restoreGov() {
        const store = this._store();
        this._govWidth = this.GOV_DEFAULT_W;
        this._govUserSet = false;
        this._govCollapsed = false;
        if (!store) return;
        try {
            const raw = store.getItem(this.GOV_KEY);
            const saved = raw ? JSON.parse(raw) : null;
            // Anything that is not v: 2 is dropped, which includes the bottom
            // dock's saved height: restoring it as a width would hand someone
            // a column too narrow to read.
            if (!saved || saved.v !== this.GOV_STATE_V) return;
            if (typeof saved.w === 'number' && isFinite(saved.w)) this._govWidth = saved.w;
            this._govUserSet = !!saved.userSet;
            this._govCollapsed = !!saved.collapsed;
        } catch (e) { /* unreadable or not ours */ }
    },

    /** Refit every terminal to the space it now has, which also sends each
     *  pane's PTY its new size. */
    _fitAll() {
        if (!this._panes) return;
        for (const rec of this._panes.values()) {
            if (rec.view && rec.view.fitNow) { try { rec.view.fitNow(); } catch (e) { /* not laid out yet */ } }
        }
    },

    // --- keyboard --------------------------------------------------------

    // Ctrl is load-bearing inside a terminal: Ctrl+W kills a word, Ctrl+\
    // sends SIGQUIT, Ctrl+digits belong to the harness. Only Cmd is free, so
    // the pane chords use it on macOS and take Shift as well everywhere else,
    // leaving the bare Ctrl keys to reach the PTY untouched. One table, read
    // both by the key handler and by the pane head tooltips.
    PANE_CHORDS: {
        mac: {
            splitRight: { mod: true, shift: false, key: '\\', code: 'Backslash', label: 'Cmd+\\' },
            splitDown: { mod: true, shift: true, key: '\\', code: 'Backslash', label: 'Cmd+Shift+\\' },
            close: { mod: true, shift: false, key: 'w', code: 'KeyW', label: 'Cmd+W' },
            focus: { mod: true, shift: false, label: 'Cmd+1 to Cmd+9' },
            move: { mod: true, shift: true, alt: false, label: 'Cmd+Shift+Arrow' },
        },
        other: {
            splitRight: { mod: true, shift: true, key: '\\', code: 'Backslash', label: 'Ctrl+Shift+\\' },
            splitDown: { mod: true, shift: true, key: '-', code: 'Minus', label: 'Ctrl+Shift+-' },
            close: { mod: true, shift: true, key: 'w', code: 'KeyW', label: 'Ctrl+Shift+W' },
            focus: { mod: true, shift: true, label: 'Ctrl+Shift+1 to Ctrl+Shift+9' },
            move: { mod: true, shift: true, alt: true, label: 'Ctrl+Shift+Alt+Arrow' },
        },
    },

    /** Read the platform once. userAgentData is the modern answer and says
     *  "macOS"; navigator.platform is the old one and says "MacIntel". */
    _onMac() {
        if (typeof this._mac !== 'boolean') {
            let p = '';
            try {
                const nav = (typeof navigator !== 'undefined' && navigator) ? navigator : null;
                p = (nav && nav.userAgentData && nav.userAgentData.platform)
                    || (nav && nav.platform) || '';
            } catch (e) { p = ''; }
            this._mac = /mac/i.test(String(p));
        }
        return this._mac;
    },

    _chords() {
        return this._onMac() ? this.PANE_CHORDS.mac : this.PANE_CHORDS.other;
    },

    /** The modifier the platform's chords use, and only it: Cmd+Ctrl+W on a
     *  Mac is not Cmd+W, and Ctrl+Meta+Shift+W elsewhere is not Ctrl+Shift+W.
     *  Either would steal a combo the harness or the window manager owns. */
    _modKey(ev) {
        return this._onMac()
            ? (!!ev.metaKey && !ev.ctrlKey)
            : (!!ev.ctrlKey && !ev.metaKey);
    },

    /** Shift rewrites the character a key produces, so a shifted chord is
     *  matched on the physical key first and only falls back to the glyph. */
    _chordHit(ev, spec) {
        if (!spec || !spec.key) return false;
        if (this._modKey(ev) !== !!spec.mod) return false;
        if (!!ev.shiftKey !== !!spec.shift) return false;
        if (!!ev.altKey !== !!spec.alt) return false;
        if (ev.code && spec.code) return ev.code === spec.code;
        return String(ev.key || '').toLowerCase() === spec.key;
    },

    /** Which pane a focus chord names, or 0 when it names none. */
    _chordDigit(ev, spec) {
        if (!spec) return 0;
        if (this._modKey(ev) !== !!spec.mod) return 0;
        if (!!ev.shiftKey !== !!spec.shift) return 0;
        if (!!ev.altKey !== !!spec.alt) return 0;
        const byCode = /^Digit([1-9])$/.exec(ev.code || '');
        if (byCode) return Number(byCode[1]);
        return /^[1-9]$/.test(ev.key) ? Number(ev.key) : 0;
    },

    /** Which edge an arrow chord names, or null when it is not one. */
    _chordArrow(ev, spec) {
        if (!spec) return null;
        if (this._modKey(ev) !== !!spec.mod) return null;
        if (!!ev.shiftKey !== !!spec.shift) return null;
        if (!!ev.altKey !== !!spec.alt) return null;
        return { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'top', ArrowDown: 'bottom' }[ev.key] || null;
    },

    _bindPaneKeys() {
        if (this._keyHandler || !document.addEventListener) return;
        this._keyHandler = (ev) => this._onPaneKey(ev);
        document.addEventListener('keydown', this._keyHandler, true);
    },

    _unbindPaneKeys() {
        if (this._keyHandler && document.removeEventListener) {
            document.removeEventListener('keydown', this._keyHandler, true);
        }
        this._keyHandler = null;
    },

    _onPaneKey(ev) {
        if (!ev) return;
        const L = this._lay();
        if (!L) return;
        const chords = this._chords();
        const edge = this._chordArrow(ev, chords.move);
        if (edge) {
            if (!this._focused) return;
            if (ev.preventDefault) ev.preventDefault();
            this._moveFocusedPane(edge);
            return;
        }
        const dir = this._chordHit(ev, chords.splitDown) ? 'col'
            : (this._chordHit(ev, chords.splitRight) ? 'row' : null);
        if (dir) {
            if (!this._focused) return;
            if (ev.preventDefault) ev.preventDefault();
            this._openSplitPicker(this._focused, dir);
            return;
        }
        if (this._chordHit(ev, chords.close)) {
            if (!this._focused) return;
            if (ev.preventDefault) ev.preventDefault();
            this._closePane(this._focused);
            return;
        }
        const nth = this._chordDigit(ev, chords.focus);
        if (!nth) return;
        const target = L.panes(this._layout)[nth - 1];
        if (!target) return;
        if (ev.preventDefault) ev.preventDefault();
        this._focusPane(target.id);
        this._refreshRail();
    },

    // --- persistence -----------------------------------------------------

    _store() {
        try {
            return (typeof localStorage !== 'undefined' && localStorage) ? localStorage : null;
        } catch (e) { return null; }
    },

    _persistLayout() {
        const L = this._lay();
        const store = this._store();
        if (!L || !store) return;
        try {
            if (!this._layout) { store.removeItem(this.LAYOUT_KEY); return; }
            store.setItem(this.LAYOUT_KEY, JSON.stringify({
                v: 2, root: L.serialize(this._layout), focused: this._focused,
            }));
        } catch (e) { /* storage unavailable or full */ }
    },

    _clearStoredLayout() {
        const store = this._store();
        if (!store) return;
        try { store.removeItem(this.LAYOUT_KEY); } catch (e) { /* storage unavailable */ }
    },

    /** Rebuild the panes a previous visit left behind. Panes whose task is
     *  gone are pruned first: a restored layout must never open a socket for
     *  a task the server has forgotten. */
    async _restoreLayout() {
        const L = this._lay();
        const store = this._store();
        if (!L || !store || this._layout) return;
        let stored = null;
        let root = null;
        try {
            const raw = store.getItem(this.LAYOUT_KEY);
            stored = raw ? JSON.parse(raw) : null;
            // v1 stored one task per pane; parse() reads it back as a group of
            // one, so a layout written before panes held groups still restores.
            if (!stored || (stored.v !== 1 && stored.v !== 2)) return;
            // Reading the tree back is part of the same untrusted read, so it
            // belongs inside the same try: a stored shape that makes the
            // parser give up must leave the page on the board, not throw out
            // of the render before it has set its timers up.
            //
            // The board holds every task that still exists, archived ones
            // having already been dropped from it, so this keeps running,
            // finished, and interrupted panes and forgets only what the
            // server no longer has.
            root = L.prune(L.parse(stored.root), new Set(this._tasks.map(t => t.id)));
        } catch (e) { root = null; }
        if (!root) { this._clearStoredLayout(); return; }
        // Every pane costs a terminal and a socket. Past six the restore is a
        // memory bill nobody asked for, so the extras are dropped from the end
        // and the last pane kept says so.
        let trimmed = false;
        for (let list = L.panes(root); list.length > this.MAX_RESTORED_PANES; list = L.panes(root)) {
            root = L.close(root, list[list.length - 1].id);
            trimmed = true;
        }
        // Panes are the memory bill only until a tab is brought forward, and
        // then every task is a socket of its own, so the tasks are capped too,
        // dropped from the end exactly as the panes are.
        let trimmedTasks = false;
        // Through the model, not the field: prune hands a node straight back
        // when it drops nothing, so a pane can still be in the older shape.
        const held = (tree) => L.panes(tree).reduce((n, p) => n + L._ids(p).length, 0);
        while (held(root) > this.MAX_RESTORED_TASKS) {
            const list = L.panes(root);
            const last = list[list.length - 1];
            const ids = last.taskIds || [];
            const drop = ids[ids.length - 1];
            const shorter = drop ? L.removeTask(root, drop) : null;
            if (!shorter || shorter === root) break;
            root = shorter;
            trimmedTasks = true;
        }
        this._layout = root;
        this._panes = new Map();
        const nodes = L.panes(root);
        for (const node of nodes) this._panes.set(node.id, this._blankPane(node.id, node.taskId, node.taskIds));
        this._focused = null;
        this._focusPane(this._panes.has(stored.focused) ? stored.focused : nodes[0].id, { force: true });
        this._renderLayout();
        this._renderTaskList();
        this._renderAttachedHead();
        for (const node of nodes) {
            // destroy() clears the layout; a mount that resumes after it must
            // not reopen a socket, and must not write the layout back out.
            if (!this._layout) return;
            await this._mountPane(node.id);
        }
        if (!this._layout) return;
        if (trimmed) this._banner('Layout trimmed to six panes.', nodes[nodes.length - 1].id);
        else if (trimmedTasks) this._banner('Layout trimmed to eight tasks.', nodes[nodes.length - 1].id);
        this._persistLayout();
        this._fitAll();
        this._refreshPaneGov();
    },

    /** Drop everything the governance panels cached for one session. */
    _resetSessionPanels() {
        this._optLive = null;
        this._optLiveAt = 0;
        this._contextSig = null;
        this._compactUntil = 0;
        this._egress = null;
        this._egressAt = 0;
        this._egressSid = null;
        this._egressSig = null;
        const ctx = document.getElementById('terminals-context');
        if (ctx) ctx.innerHTML = '<span class="terminals-empty">No context data yet. The Guard reports context use once the harness starts working.</span>';
        const stage = document.getElementById('terminals-context-stage');
        if (stage) { stage.textContent = ''; stage.className = 'terminals-gov-stage'; }
        const eg = document.getElementById('terminals-egress');
        if (eg) eg.innerHTML = '<span class="terminals-empty">No egress recorded yet.</span>';
        const egCount = document.getElementById('terminals-egress-count');
        if (egCount) { egCount.textContent = ''; egCount.className = 'terminals-gov-count'; }
        if (this._govHas) { this._govHas.context = false; this._govHas.egress = false; }
    },

    /** Close every pane. The tasks keep running; only the workspace goes. */
    _detach() {
        this._closeAllPanes();
        // Counts belong to one task; a stale pair on the footer would read as
        // governance evidence for a task it never came from.
        this._govCounts = { governed: 0, blocked: 0 };
        this._govHas = {};
        this._sessionReported = null;
        this._resetSessionPanels();
        this._renderGovHero();
        this._headSig = null;
        this._footSig = null;
        this._guardBannerSig = null;
        const body = document.getElementById('terminals-attached-body');
        if (body && body.classList) body.classList.remove('is-layout');
        document.querySelector('.terminals-page')?.classList.remove('is-focused');
        // Nothing attached, so the column goes back to its vertical strip and
        // reserves no body width.
        this._syncGovDock();
    },

    _banner(text, paneId) {
        const rec = paneId && this._panes ? this._panes.get(paneId) : this._focusedPane();
        const b = rec && rec.bannerEl;
        if (!b) return;
        b.textContent = text;
        b.hidden = false;
    },

    // Tabs are the tasks a person could switch to right now, plus whatever is
    // attached even after it finishes, so the pane never loses its own tab.
    _tabTasks() {
        const live = ['starting', 'working', 'blocked', 'idle'];
        const all = this._tasks.filter(t => live.includes(t.status) || t.id === this._attached);
        let shown = all.slice(0, this.TAB_LIMIT);
        if (this._attached && !shown.some(t => t.id === this._attached)) {
            // The attached task owns the pane, so it is the one tab that can
            // never fall off the end into the overflow count.
            const attached = all.find(t => t.id === this._attached);
            if (attached) shown = [attached, ...all.slice(0, this.TAB_LIMIT - 1)];
        }
        return { shown, overflow: Math.max(0, all.length - shown.length) };
    },

    /** Leave the attached task and show the board. The rail's Agent Tasks row
     *  calls this too, so it cannot live inside the head renderer. */
    showAllTasks() {
        try { sessionStorage.removeItem('sv-agent-task-id'); } catch (e) { /* storage unavailable */ }
        this._detach();
        this._clearStoredLayout();
        const body = document.getElementById('terminals-attached-body');
        if (body) body.innerHTML = this.STAGE_EMPTY_HTML;
        if (window.Sidebar?.setActive) Sidebar.setActive('terminals');
        this._renderAttachedHead();
        this._renderTaskList();
    },

    _renderAttachedHead() {
        const head = document.getElementById('terminals-attached-head');
        if (!head) return;
        const t = this._tasks.find(x => x.id === this._attached) || null;
        // A focused pane with no task in it yet is still a workspace, and a
        // workspace keeps its controls. Dropping them here is how someone
        // ends up in front of a blank pane with no way to even the layout
        // out or get back to the board, so the strip only stands down when
        // there are no panes at all.
        if (!t && !(this._panes && this._panes.size)) {
            if (this._headSig !== 'empty') {
                this._headSig = 'empty';
                head.innerHTML = '<span class="terminals-empty">Pick a task to attach, or launch one.</span>';
            }
            this._renderPaneFoot();
            this._renderGuardBanner();
            return;
        }
        // A linked session has no process the app owns, so there is nothing
        // here to stop; the Stop button would be a lie.
        const running = !!t && ['starting', 'working', 'blocked', 'idle'].includes(t.status)
            && t.origin !== 'linked';
        const { shown, overflow } = this._tabTasks();
        const stoppable = this._stoppablePanes();
        // With one pane holding one task the pane head is hidden, so its
        // controls belong here. A pane holding a group keeps its own head, and
        // keeps its controls with it.
        const onlyId = this._panes && this._panes.size === 1
            ? (this._focused && this._panes.has(this._focused) ? this._focused : this._panes.keys().next().value)
            : null;
        const soloId = onlyId && this._paneTasks(this._panes.get(onlyId)).length <= 1 ? onlyId : null;
        // Exactly one place names the open sessions. A pane head that carries
        // tabs of its own, or several panes each naming their task, already
        // does it, and a second row of the same names above them reads as a
        // duplicate header. The one layout with nothing to say for itself is
        // the lone pane holding a lone task, and that is this strip's row.
        const tabbed = !!soloId;
        // Several panes bring the even-out control with them, so the count
        // has to be in the signature or the strip would not redraw when a
        // split appears or a pane closes.
        const panes = this._panes ? this._panes.size : 0;
        const headSig = [this._attached || '', running ? 'run' : 'idle', tabbed ? overflow : 'untabbed',
            stoppable.length, this._stopAllArmed ? 'armed' : '', soloId || '', panes]
            .concat(tabbed ? shown.map(x => [x.id, this._taskState(x).kind, x.title || this._label(x.executor_id)].join(':')) : [])
            .join('|');
        if (headSig === this._headSig) { this._renderPaneFoot(); this._renderGuardBanner(); return; }
        this._headSig = headSig;
        const tabs = !tabbed ? '' : shown.map(x => {
            const st = this._taskState(x);
            const name = x.title || this._label(x.executor_id);
            const isActive = x.id === this._attached;
            return `<button type="button" class="terminals-pane-tab${isActive ? ' is-active' : ''}" role="tab" data-id="${this._esc(x.id)}" aria-selected="${isActive ? 'true' : 'false'}" title="${this._esc(name + ' · ' + this._label(x.executor_id))}">${window.TaskAvatar ? TaskAvatar.html({ id: x.id, harness: x.executor_id, state: st.kind, size: 18 }) : ''}<span class="terminals-pane-tab-title">${this._esc(name)}</span>${st.kind === 'active' ? '<i class="terminals-pane-live" aria-hidden="true"></i>' : ''}</button>`;
        }).join('');
        head.innerHTML = `
          ${tabbed ? `<div class="terminals-pane-tabs" role="tablist" aria-label="Running tasks">${tabs}</div>` : ''}
          <div class="terminals-pane-tab-actions">${tabbed && overflow ? `<button type="button" class="terminals-pane-tab terminals-pane-tab-more" title="Show all tasks">+${overflow}</button>` : ''}<button type="button" class="terminals-pane-tab terminals-pane-tab-new" title="Launch a task" aria-label="Launch a task">+</button></div>
          <span class="terminals-head-spacer"></span>
          ${soloId ? `<span class="terminals-head-pane-gov" id="terminals-head-pane-gov"></span><span class="terminals-head-pane-acts" id="terminals-head-pane-acts">${this._paneActButtons(this._chords())}</span>` : ''}
          <button class="btn btn-sm" id="terminals-all-tasks-btn">All tasks</button>
          ${panes > 1 ? '<button class="btn btn-sm" id="terminals-even-panes-btn" title="Give every pane an equal share; no task is closed or detached">Even panes</button>' : ''}
          ${stoppable.length > 1
            ? (this._stopAllArmed
                ? `<span class="terminals-stop-all-confirm">Stop ${stoppable.length} running tasks? <button type="button" class="btn btn-sm" id="terminals-stop-all-keep">Keep</button><button type="button" class="btn btn-sm" id="terminals-stop-all-yes">Stop all</button></span>`
                : '<button class="btn btn-sm" id="terminals-stop-all-btn">Stop all</button>')
            : ''}
          ${running ? '<button class="btn btn-sm" id="terminals-stop-btn">Stop</button>' : ''}`;
        if (soloId) {
            this._bindPaneActs(head.querySelector('#terminals-head-pane-acts'), soloId);
            this._placeSoloGov(soloId);
        }
        const showAllTasks = () => this.showAllTasks();
        const allTasksBtn = head.querySelector('#terminals-all-tasks-btn');
        if (allTasksBtn) allTasksBtn.onclick = showAllTasks;
        // The way back from slivers: a layout dragged or split into unusable
        // strips is recoverable without giving up a single running task.
        const evenBtn = head.querySelector('#terminals-even-panes-btn');
        if (evenBtn) evenBtn.onclick = () => { if (!this._rebalancePanes()) this._banner('The panes are already even.'); };
        // Only the chips carrying a task id are drag sources: the `+` new-task
        // button and the `+N` overflow button share the class but have no
        // data-id, so the selector leaves them out of both handlers.
        head.querySelectorAll('.terminals-pane-tab[data-id]').forEach(b => {
            b.onpointerdown = (ev) => this._onTabPointerDown(ev, b.dataset.id);
            b.onclick = () => {
                // The release at the end of a drag lands here as a click, and
                // that click is the tail of the gesture, not a request to
                // bring the chip's task forward.
                if (this.consumeDragClick()) return;
                if (b.dataset.id !== this._attached) this._attach(b.dataset.id);
            };
        });
        const moreTab = head.querySelector('.terminals-pane-tab-more');
        if (moreTab) moreTab.onclick = showAllTasks;
        const newTab = head.querySelector('.terminals-pane-tab-new');
        if (newTab) newTab.onclick = () => {
            showAllTasks();
            const form = document.getElementById('terminals-launch');
            if (form) form.hidden = false;
            document.getElementById('terminals-workspace')?.focus();
        };
        const stopAllBtn = head.querySelector('#terminals-stop-all-btn');
        if (stopAllBtn) stopAllBtn.onclick = () => this._askStopAll();
        const stopAllKeep = head.querySelector('#terminals-stop-all-keep');
        if (stopAllKeep) stopAllKeep.onclick = () => this._cancelStopAll();
        const stopAllYes = head.querySelector('#terminals-stop-all-yes');
        if (stopAllYes) stopAllYes.onclick = () => this._stopAllPanes();
        const stop = head.querySelector('#terminals-stop-btn');
        if (stop) stop.onclick = async () => {
            try {
                await API.terminalsStop(t.id);
                await this._refreshTasks();
            } catch (e) { this._banner(e.message); }
        };
        this._renderPaneFoot();
        this._renderGuardBanner();
    },

    // The status line answers "where am I and what has governance done here"
    // without costing a row of the terminal itself.
    _renderPaneFoot(paneId) {
        if (paneId === undefined && this._panes && this._panes.size) {
            for (const id of this._panes.keys()) this._renderPaneFoot(id);
            return;
        }
        const rec = paneId && this._panes ? this._panes.get(paneId) : this._focusedPane();
        const own = rec && rec.footEl ? rec : null;
        const foot = own ? own.footEl : document.getElementById('terminals-pane-foot');
        if (!foot) return;
        // A pane carries its own footer once its shell is built. The page
        // level element is the fallback for the moment before that, so it has
        // to go dark here or the workspace ends up showing the line twice.
        if (own) {
            const pageFoot = document.getElementById('terminals-pane-foot');
            if (pageFoot && !pageFoot.hidden) {
                pageFoot.hidden = true;
                pageFoot.innerHTML = '';
                this._footSig = null;
            }
        }
        const setSig = (v) => { if (own) own.footSig = v; else this._footSig = v; };
        const taskId = own ? own.taskId : this._attached;
        const t = this._tasks.find(x => x.id === taskId);
        if (!t) { foot.hidden = true; foot.innerHTML = ''; setSig(null); return; }
        foot.hidden = false;
        const state = this._taskState(t);
        const elapsed = this._elapsed(t.created_at, t.ended_at);
        // A pane's counts are its own; the page level pair belongs to the
        // focused pane, which is what the fallback element shows.
        const counts0 = own
            ? (own.gov ? { governed: own.gov.calls, blocked: own.gov.blocked } : { governed: 0, blocked: 0 })
            : (this._govCounts || { governed: 0, blocked: 0 });
        const footSig = [t.id, t.workspace, t.branch || '', t.executor_id, state.kind, counts0.governed, counts0.blocked].join('|');
        if (footSig === (own ? own.footSig : this._footSig)) {
            // Only the clock moved. Patching one text node keeps the rest of
            // the line, including its title attributes, exactly as it was.
            const clock = (foot.querySelector && foot.querySelector('.terminals-foot-elapsed'))
                || document.getElementById('terminals-foot-elapsed');
            if (clock) clock.textContent = elapsed;
            return;
        }
        setSig(footSig);
        const dot = '<span class="terminals-foot-dot" aria-hidden="true">\u00b7</span>';
        const branch = typeof t.branch === 'string' && t.branch
            ? `<span class="terminals-foot-sep" aria-hidden="true">\u203a</span><span class="terminals-foot-item terminals-foot-branch">${this._esc(t.branch)}</span>`
            : '';
        const counts = counts0;
        foot.innerHTML = `
          <span class="terminals-foot-item terminals-foot-path" title="${this._esc(t.workspace)}">${this._esc(this._shortPath(t.workspace))}</span>
          ${branch}
          ${dot}<span class="terminals-foot-item">${this._esc(this._label(t.executor_id))}</span>
          ${dot}<span class="terminals-foot-item terminals-foot-state terminals-foot-state-${state.kind}">${this._esc(state.label.toLowerCase())}</span>
          ${dot}<span class="terminals-foot-item terminals-foot-elapsed" id="terminals-foot-elapsed">${this._esc(elapsed)}</span>
          <span class="terminals-head-spacer"></span>
          <span class="terminals-foot-item terminals-foot-gov">${counts.governed} governed \u00b7 ${counts.blocked} blocked</span>`;
    },

    // Statuses in which the PTY is still alive. A restart has to wait for the
    // task to leave this set before launching, or the new harness races the
    // old one for the same working folder.
    _RUNNING_STATUSES: ['starting', 'working', 'blocked', 'idle'],

    // The other side of the same coin. Stopping a task yourself leaves it
    // `interrupted` and a crash leaves it `failed`, so gating a restart on
    // `done` alone hid the button on exactly the tasks worth restarting.
    _ENDED_STATUSES: ['done', 'failed', 'interrupted'],

    /** Ended means the session is over for good: no more output is
     *  coming, and the harness and folder on the row are all that is
     *  needed to start a fresh one in its place. */
    _isEnded(t) { return !!t && this._ENDED_STATUSES.includes(t.status); },

    // Counted attempts rather than a wall-clock deadline: the same ten seconds
    // in practice, but the wait cannot be shortened or stretched by a slow
    // event loop, and it is drivable in a test without ten seconds of sleeping.
    STOP_POLL_MS: 500,
    STOP_POLL_ATTEMPTS: 20,

    /** Launch a fresh task with the same harness, folder, and title, and
     *  attach to it. A relaunch deliberately creates a new task/session: the
     *  old audit trail remains immutable and still attachable.
     *  `stopFirst` is for restarting a task that is still running, where the
     *  old process has to be gone before the new one starts. `pane` keeps the
     *  fresh session in the pane the restart came from.
     */
    async _relaunchTask(task, { stopFirst = false, pane = null } = {}) {
        // The task list's Relaunch names no pane, so the pane the task is
        // already in stands in for one. Without it the fresh session would
        // join the focused pane's group as one more tab beside the dead task
        // it was meant to replace, and every relaunch would grow that group.
        const holder = pane || this._paneForTask(task.id);
        if (stopFirst) {
            await API.terminalsStop(task.id);
            let stopped = false;
            for (let i = 0; i < this.STOP_POLL_ATTEMPTS && !stopped; i += 1) {
                await new Promise(r => setTimeout(r, this.STOP_POLL_MS));
                let list;
                try { list = await API.terminalsTasks(); } catch (e) { list = null; }
                const cur = (list && list.items || []).find(x => x.id === task.id);
                if (!cur || !this._RUNNING_STATUSES.includes(cur.status)) stopped = true;
            }
            // Launching anyway would leave two harnesses in one working folder
            // editing the same files, which is worse than the ungoverned
            // session the restart was meant to end. Say so and stop.
            if (!stopped) throw new Error('The task did not stop; try again.');
        }
        const fresh = await API.terminalsLaunch(task.executor_id, task.workspace, task.title || '');
        await this._refreshTasks();
        if (window.Sidebar?.refreshAgentTaskViews) Sidebar.refreshAgentTaskViews();
        // A restart is the same tab with a new session behind it, so the new
        // task takes the old one's place rather than disbanding the group.
        await this._attach(fresh.id, holder, 'swap', task.id);
        return fresh;
    },

    /** Restart the attached task from the Guard banner's pending state.
     *  A harness only loads a newly installed plugin at startup, so for the
     *  harnesses without a reload command this is the only way out of the
     *  ungoverned window without leaving the app.
     */
    async _restartHarnessFromBanner(paneId) {
        const els = this._guardEls(paneId);
        const btn = els.restart;
        const text = els.text;
        // The banner belongs to a pane, so the task it restarts is that pane's,
        // whether or not the pane happens to be the focused one.
        const rec = paneId && this._panes ? this._panes.get(paneId) : null;
        const taskId = rec ? rec.taskId : this._attached;
        const t = this._tasks.find(x => x.id === taskId);
        if (!t) return;
        if (btn) { btn.disabled = true; btn.textContent = 'Restarting…'; }
        try {
            // Same pane, same place on screen: the restarted harness comes
            // back where the banner was, not in whichever pane had the focus.
            await this._relaunchTask(t, { stopFirst: true, pane: paneId });
        } catch (e) {
            if (text) text.textContent = e.message || 'Could not restart the harness.';
            if (btn) { btn.disabled = false; btn.textContent = 'Restart harness'; }
        }
    },

    // A task may launch before its Guard plugin is in place. Nothing is
    // silently ungoverned: the session carries this strip until the Guard
    // reports in (the first hook event gives the task a session_id).
    /** The banner's elements for one pane, falling back to the page level
     *  pair while no pane has been built yet. */
    _guardEls(paneId) {
        const rec = paneId && this._panes ? this._panes.get(paneId) : this._focusedPane();
        const own = rec && rec.guardEl;
        const q = (sel, id) => {
            const el = own && rec.guardEl.querySelector ? rec.guardEl.querySelector(sel) : null;
            return el || document.getElementById(id);
        };
        return {
            rec: own ? rec : null,
            banner: own ? rec.guardEl : document.getElementById('terminals-guard-banner'),
            text: q('.terminals-guard-banner-text', 'terminals-guard-banner-text'),
            install: q('[data-guard="install"]', 'terminals-guard-banner-install'),
            recheck: q('[data-guard="recheck"]', 'terminals-guard-banner-recheck'),
            restart: q('[data-guard="restart"]', 'terminals-guard-banner-restart'),
            commands: (own && rec.guardCmdEl) || document.getElementById('terminals-guard-banner-commands'),
        };
    },

    /** Put the Install button away in its resting state. A finished install
     *  leaves the label reading "Installing..." and the button disabled, and
     *  the banner that comes back for the next task must not inherit that. */
    _resetInstallButton(install) {
        install.hidden = true;
        install.disabled = false;
        install.textContent = 'Install SecureVector Guard';
    },

    _renderGuardBanner(paneId) {
        if (paneId === undefined && this._panes && this._panes.size) {
            // The page-level notice only exists while no terminal pane has
            // been mounted. Hide it before rendering the pane-local notices:
            // otherwise a refresh can leave two identical Guard messages on
            // screen (the fallback plus the selected pane's message).
            const pageBanner = document.getElementById('terminals-guard-banner');
            const pageCmds = document.getElementById('terminals-guard-banner-commands');
            if (pageBanner) pageBanner.hidden = true;
            if (pageCmds) pageCmds.hidden = true;
            this._guardBannerSig = null;
            for (const id of this._panes.keys()) this._renderGuardBanner(id);
            return;
        }
        const els = this._guardEls(paneId);
        const banner = els.banner;
        if (!banner) return;
        // The page level banner is the fallback for the moment before a pane
        // has built its own. Once the pane has one, the page level element has
        // to go dark or the same Guard notice shows twice, stacked.
        if (els.rec) {
            const pageBanner = document.getElementById('terminals-guard-banner');
            if (pageBanner && !pageBanner.hidden) {
                pageBanner.hidden = true;
                this._guardBannerSig = null;
            }
            const pageCmds = document.getElementById('terminals-guard-banner-commands');
            if (pageCmds && pageCmds !== els.commands) pageCmds.hidden = true;
        }
        const text = els.text;
        const install = els.install;
        const recheck = els.recheck;
        const restart = els.restart;
        const commands = els.commands;
        const own = els.rec;
        const setSig = (v) => { if (own) own.guardSig = v; else this._guardBannerSig = v; };
        const getSig = () => (own ? own.guardSig : this._guardBannerSig);
        const hide = () => {
            banner.hidden = true;
            if (commands) commands.hidden = true;
            setSig(null);
        };
        const taskId = own ? own.taskId : this._attached;
        const t = this._tasks.find(x => x.id === taskId);
        if (!t) { hide(); return; }
        if (!['starting', 'working', 'blocked', 'idle'].includes(t.status)) { hide(); return; }
        if (this._guardReportedIn(t)) { hide(); return; }
        const ex = this._executors.find(e => e.id === t.executor_id);
        if (!ex) { hide(); return; }
        if (ex.governed && this._guardBannerPending) this._guardBannerPending = null;
        const pending = this._guardBannerPending && this._guardBannerPending.executorId === ex.id
            ? this._guardBannerPending
            : null;
        // The 3 s poll calls this; only rewrite when the state actually moved,
        // so focus on Install or Check again survives a tick.
        const linked = t.origin === 'linked';
        const sig = [t.id, ex.governed ? 'gov' : 'ungov', pending ? 'pending' : '', linked ? 'linked' : ''].join('|');
        if (sig === getSig()) return;
        setSig(sig);
        banner.hidden = false;
        const pane = own ? own.id : undefined;
        if (install) install.onclick = () => this._installGuardFromBanner(ex.id, pane);
        if (recheck) recheck.onclick = () => this._recheckGuardFromBanner(pane);
        if (restart) restart.onclick = () => this._restartHarnessFromBanner(pane);
        if (!ex.governed) {
            banner.classList.remove('is-pending');
            if (pending) {
                if (text) text.textContent = pending.text;
                if (commands) { commands.textContent = pending.commands.join('\n'); commands.hidden = false; }
                if (install) this._resetInstallButton(install);
                if (recheck) { recheck.hidden = false; recheck.disabled = false; recheck.textContent = 'Check again'; }
                if (restart) restart.hidden = true;
                return;
            }
            if (text) text.textContent = `This task is running without SecureVector Guard for ${ex.label}. Nothing is being checked, recorded, or held for approval.`;
            if (commands) commands.hidden = true;
            if (install) { install.hidden = false; install.disabled = false; install.textContent = 'Install SecureVector Guard'; }
            if (recheck) recheck.hidden = true;
            if (restart) restart.hidden = true;
            return;
        }
        // Installed, but this session was started before it: the harness has
        // to load the plugin before any hook reaches the app.
        banner.classList.add('is-pending');
        // Only Claude Code can reload plugins in place; every other harness has
        // to come back up, so the button is the whole answer there.
        // A linked session belongs to the user's own terminal: the app cannot
        // restart it, and a reloaded harness may mint a new session id, so the
        // instruction names that instead of offering a button that cannot work.
        if (text) text.textContent = linked
            ? 'SecureVector Guard installed. Run /reload-plugins in that terminal (Claude Code) or restart the harness in your terminal, then link the new session id if it changed.'
            : (t.executor_id === 'claude-code'
                ? 'SecureVector Guard installed. This session started before it, so run /reload-plugins in the terminal, or restart the harness.'
                : 'SecureVector Guard installed. This session started before it, so restart the harness to load it.');
        if (commands) commands.hidden = true;
        if (install) this._resetInstallButton(install);
        if (recheck) { recheck.hidden = false; recheck.disabled = false; recheck.textContent = 'Check again'; }
        if (restart) {
            restart.hidden = linked;
            if (!linked) { restart.disabled = false; restart.textContent = 'Restart harness'; }
        }
    },

    /** Has the Guard reported anything for this task's session yet?
     *  A launched task gets a session id the moment its first hook arrives,
     *  so the id itself is the answer. A linked task carries the id the user
     *  pasted from the start, so only the audit trail can answer it. */
    _guardReportedIn(t) {
        if (!t) return false;
        if (t.origin === 'linked') return this._sessionReported !== false;
        // A task spawned while the Guard was already in place is governed from
        // its first call. The gap before that call is not an ungoverned
        // window, so a banner telling the user to restart the harness in it
        // would be telling them to throw away a session that is already fine.
        if (t.governed_at_launch) return true;
        return Boolean(t.session_id);
    },

    async _installGuardFromBanner(executorId, paneId) {
        const els0 = this._guardEls(paneId);
        const banner = els0.banner;
        const text = els0.text;
        const install = els0.install;
        const recheck = els0.recheck;
        if (install) { install.disabled = true; install.textContent = 'Installing…'; }
        try {
            const res = await API.installGuard(executorId);
            const ex = await API.terminalsExecutors();
            this._executors = ex.items || [];
            const cur = this._executors.find(e => e.id === executorId);
            const label = cur ? cur.label : this._label(executorId);
            if (cur && cur.governed) {
                this._guardBannerPending = null;
            } else if (res.commands && res.commands.length) {
                let msg = `Finish in ${label}: run the commands below, then click Check again.`;
                if (res.next_step) msg += ` ${res.next_step}`;
                this._guardBannerPending = { executorId, text: msg, commands: res.commands };
            } else {
                this._guardBannerPending = null;
            }
            if (this._container) {
                this._renderExecutorOptions(this._container);
                this._showExecutorState(this._container);
            }
            this._forgetGuardSigs();
            this._renderGuardBanner();
            if (!cur || (!cur.governed && !(res.commands && res.commands.length))) {
                if (banner) banner.hidden = false;
                if (text) text.textContent = res.next_step || `Guard install did not finish for ${label}. Try again.`;
                if (install) { install.hidden = false; install.disabled = false; install.textContent = 'Install SecureVector Guard'; }
                if (recheck) recheck.hidden = true;
            }
        } catch (e) {
            if (banner) banner.hidden = false;
            if (text) text.textContent = e.message || 'Guard install failed.';
            if (install) { install.hidden = false; install.disabled = false; install.textContent = 'Install SecureVector Guard'; }
            if (recheck) recheck.hidden = true;
            this._forgetGuardSigs();
        }
    },

    /** Drop every banner signature so the next render rewrites them all. */
    _forgetGuardSigs() {
        this._guardBannerSig = null;
        if (this._panes) for (const rec of this._panes.values()) rec.guardSig = null;
    },

    async _recheckGuardFromBanner(paneId) {
        const recheck = this._guardEls(paneId).recheck;
        if (recheck) { recheck.disabled = true; recheck.textContent = 'Checking…'; }
        try {
            const ex = await API.terminalsExecutors();
            this._executors = ex.items || [];
            if (this._container) {
                this._renderExecutorOptions(this._container);
                this._showExecutorState(this._container);
            }
            await this._refreshTasks();
            this._forgetGuardSigs();
            this._renderGuardBanner();
            // The check is about this session, not about the install. Saying
            // what it found is the difference between a button that works and
            // a button that looks dead, because an installed Guard that this
            // session has not loaded leaves the banner exactly as it was.
            const after = this._guardEls(paneId);
            if (after.banner && !after.banner.hidden && after.text
                && after.banner.classList && after.banner.classList.contains('is-pending')) {
                after.text.textContent += ' Checked just now: no call from this session yet.';
            }
        } catch (e) {
            const text = this._guardEls(paneId).text;
            if (text) text.textContent = e.message || 'Could not check the Guard.';
        } finally {
            const btn = this._guardEls(paneId).recheck;
            if (btn && !btn.hidden) { btn.disabled = false; btn.textContent = 'Check again'; }
        }
    },

    // --- governance drawer ---------------------------------------------

    async _refreshRail() {
        const id = this._attached;
        const vEl = document.getElementById('terminals-verdicts');
        const aEl = document.getElementById('terminals-approvals');
        const tEl = document.getElementById('terminals-traces');
        const attention = document.getElementById('terminals-attention');
        const summary = document.getElementById('terminals-governance-summary');
        // Cheap and idempotent, and it costs no extra request: whatever ended
        // the last attachment (a closed pane, a task the poll dropped), the
        // dock settles back to the right state here.
        this._syncGovDock();
        if (!vEl || !aEl) return;
        // Section counts live in the summaries; the traces test stubs
        // getElementById with a fixed id map, so guard every lookup.
        const setCount = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n > 0 ? String(n) : ''; };
        if (!this._govHas) this._govHas = {};
        this._renderContextCost();
        this._renderEgress();
        if (!id) {
            vEl.innerHTML = '<span class="terminals-empty">No task attached.</span>';
            aEl.innerHTML = '<span class="terminals-empty">Nothing waiting.</span>';
            if (tEl) tEl.innerHTML = '<span class="terminals-empty">No task attached.</span>';
            this._tracesCache = null;
            setCount('terminals-verdicts-count', 0);
            setCount('terminals-traces-count', 0);
            setCount('terminals-approvals-count', 0);
            this._govCounts = { governed: 0, blocked: 0 };
            this._govHas = {};
            this._sessionReported = null;
            this._renderPaneFoot();
            this._renderGovHero();
            if (attention) attention.hidden = true;
            if (summary) summary.textContent = 'Attach a task to inspect its trace';
            return;
        }
        try {
            const v = await API.terminalsVerdicts(id);
            if (this._attached !== id) return;
            const rows = v.items || [];
            // A session start row is not a tool call, but it IS proof the
            // Guard reported in, which is what the banner and the hero need.
            this._sessionReported = rows.length > 0;
            const items = rows.filter(i => !this._isBoundaryRow(i));
            vEl.innerHTML = items.length ? items.map(i => {
                const kind = i.action === 'block' ? 'block' : (i.risk === 'amber' ? 'amber' : 'allow');
                const dot = kind === 'block' ? 'red' : (kind === 'amber' ? 'amber' : 'green');
                return `
              <div class="terminals-verdict terminals-verdict-${kind}">
                <span class="terminals-dot sv-status-${dot}"></span>
                <span class="terminals-verdict-main">
                  <span class="terminals-verdict-top"><span class="terminals-verdict-tool">${this._esc(i.function_name || i.tool_id)}</span><span class="terminals-verdict-action">${this._esc(i.action)}</span></span>
                  ${i.reason ? `<span class="terminals-verdict-reason">${this._esc(i.reason)}</span>` : ''}
                </span>
              </div>`;
            }).join('') : '<span class="terminals-empty">No tool calls yet.</span>';
            setCount('terminals-verdicts-count', items.length);
            this._govHas.verdicts = items.length > 0;
            this._govCounts = { governed: items.length, blocked: items.filter(i => i.action === 'block').length };
            this._renderPaneFoot();
            const sessionId = v.session_id;
            let traceRuns = [];
            let fetchFailed = false;
            if (tEl) {
                if (!sessionId) {
                    tEl.innerHTML = '<span class="terminals-empty">Traces appear after the first governed call.</span>';
                    this._tracesCache = null;
                } else {
                    const cache = this._tracesCache;
                    if (cache && cache.taskId === id && cache.sessionId === sessionId
                        && (cache.pending ? Date.now() - cache.at < 20000 : Date.now() - cache.at < 12000)) {
                        traceRuns = cache.runs;
                    } else {
                        // Stamp the cache before awaiting so a concurrent caller (the 4s
                        // rail timer racing the attach path) sees a pending entry instead
                        // of also missing the cache and firing a duplicate fetch.
                        this._tracesCache = { taskId: id, sessionId, at: Date.now(), runs: [], pending: true };
                        let tr = null;
                        let requestFailed = false;
                        try {
                            tr = await this._fetchTraceRuns({ window_days: 7, limit: 200 });
                        } catch (e) {
                            requestFailed = true;
                        }
                        if (this._attached !== id) {
                            // We're no longer attached to the task this fetch was for.
                            // Discard the pending stamp (rather than leaving it in
                            // place) so a later re-attach to this same task/session
                            // triggers a fresh fetch instead of reusing, or being
                            // stuck on, this now-irrelevant in-flight result.
                            if (this._tracesCache && this._tracesCache.pending
                                && this._tracesCache.taskId === id && this._tracesCache.sessionId === sessionId) {
                                this._tracesCache = null;
                            }
                            return;
                        }
                        if (requestFailed) {
                            // Don't cache a failed fetch as "no traces" for 12s; drop
                            // the cache so the next tick retries instead of hiding it.
                            this._tracesCache = null;
                            fetchFailed = true;
                        } else {
                            traceRuns = (tr.runs || [])
                                .filter(r => r.session_id === sessionId)
                                .sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')))
                                .slice(0, 6);
                            this._tracesCache = { taskId: id, sessionId, at: Date.now(), runs: traceRuns };
                        }
                    }
                    tEl.innerHTML = fetchFailed
                        ? '<span class="terminals-error">Traces unavailable.</span>'
                        : (traceRuns.length ? `<div class="terminals-trace-session">
                          <div class="terminals-trace-session-head"><span>Session</span><code>${this._esc(String(sessionId).slice(0, 12))}</code><span class="terminals-trace-session-path">› traces › spans</span></div>${traceRuns.map(r => {
                        const risk = (r.blocked > 0 || r.risk === 'red') ? 'red' : (r.risk === 'amber' ? 'amber' : 'green');
                        const riskLabel = risk === 'red' ? 'blocked' : (risk === 'amber' ? 'flagged' : 'clean');
                        const shortId = String(r.trace_id || '').slice(0, 12);
                        const metaParts = [
                            `${Number(r.spans) || 0} spans`,
                            `${Number(r.blocked) || 0} blocked`,
                            `${Number(r.detections) || 0} detections`,
                            this._ago(r.started_at),
                        ].filter(Boolean);
                        return `
                      <div class="terminals-trace" data-trace-id="${this._esc(r.trace_id)}">
                        <span class="terminals-dot sv-status-${risk}" role="img" aria-label="${this._esc(riskLabel)}"></span>
                        <span class="terminals-trace-main">
                          <span class="terminals-trace-top"><button type="button" class="terminals-trace-id" data-trace-id="${this._esc(r.trace_id)}" title="Open trace and nested spans">trace ${this._esc(shortId)}</button><span class="terminals-trace-risk terminals-trace-risk-${risk}">${this._esc(riskLabel)}</span></span>
                          <span class="terminals-trace-meta">${this._esc(metaParts.join(' · '))}</span>
                        </span>
                        <button type="button" class="terminals-trace-open" data-trace-id="${this._esc(r.trace_id)}">Spans</button>
                      </div>`;
                    }).join('')}</div>` : '<span class="terminals-empty">No traces yet.</span>');
                    setCount('terminals-traces-count', fetchFailed ? 0 : traceRuns.length);
                    // A transient fetch failure is not "no traces". Flipping
                    // this to false would let the hero pop over live sections
                    // mid-poll and then vanish again on the next tick.
                    if (!fetchFailed) this._govHas.traces = traceRuns.length > 0;
                    if (!fetchFailed) {
                        // The id and the Details button are the same control.
                        tEl.querySelectorAll('.terminals-trace-open, button.terminals-trace-id').forEach(b => {
                            b.onclick = () => {
                                const traceId = b.dataset.traceId;
                                if (window.AgentRunsPage) AgentRunsPage._pendingTrace = traceId;
                                if (window.Sidebar?.navigate) Sidebar.navigate('agent-runs');
                            };
                        });
                    }
                }
            }
            const jit = await API.getJitRequests('pending');
            if (this._attached !== id) return;
            const mine = (jit.items || []).filter(r => !sessionId || r.session_id === sessionId);
            const summaryParts = [
                `${items.length} call${items.length === 1 ? '' : 's'} checked`,
                fetchFailed ? null : `${traceRuns.length} trace${traceRuns.length === 1 ? '' : 's'}`,
                mine.length ? `${mine.length} approval waiting` : 'no approvals waiting',
            ].filter(Boolean);
            if (summary) summary.textContent = summaryParts.join(' · ');
            if (attention) {
                attention.hidden = !mine.length;
                attention.innerHTML = mine.length
                    ? `<span><strong>Approval needed</strong> · This task is paused until you decide.</span><button class="btn btn-sm btn-primary" id="terminals-review-approval">Review</button>`
                    : '';
                const review = attention.querySelector('#terminals-review-approval');
                if (review) review.onclick = () => {
                    this._expandGovDock();
                    const sec = aEl.closest('details');
                    if (sec) sec.open = true;
                    aEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                };
            }
            aEl.innerHTML = mine.length ? mine.map(r => `
              <div class="terminals-approval" data-id="${this._esc(r.id)}">
                <div class="terminals-approval-tool">${this._esc(r.function_name || r.tool_id)}</div>
                <div class="terminals-approval-why">${this._esc(r.justification || 'No justification given')}</div>
                <div class="terminals-approval-actions">
                  <button class="btn btn-sm btn-primary" data-act="approve">Allow 15 min</button>
                  <button class="btn btn-sm" data-act="deny">Deny</button>
                </div>
              </div>`).join('') : '<span class="terminals-empty">Nothing waiting.</span>';
            setCount('terminals-approvals-count', mine.length);
            this._govHas.approvals = mine.length > 0;
            this._renderGovHero();
            aEl.querySelectorAll('button[data-act]').forEach(b => {
                b.onclick = async () => {
                    const reqId = b.closest('.terminals-approval').dataset.id;
                    const act = b.dataset.act;
                    try {
                        if (act === 'approve') await API.approveJitRequest(reqId, '15m');
                        else await API.denyJitRequest(reqId, 'Denied from Terminals');
                    } catch (e) { this._banner(e.message); }
                    this._refreshRail();
                };
            });
        } catch (e) {
            if (this._attached !== id) return;
            aEl.innerHTML = `<div class="terminals-error">${this._esc(e.message)}</div>`;
            setCount('terminals-verdicts-count', 0);
            setCount('terminals-traces-count', 0);
            setCount('terminals-approvals-count', 0);
            this._govCounts = { governed: 0, blocked: 0 };
            this._renderPaneFoot();
            this._renderGovHero();
        }
    },

    /** One empty state instead of five.
     *  A fresh session has nothing in any governance section, and five rows
     *  of "No X yet" reads as a broken panel rather than a waiting one. The
     *  hero says what will land where, and the sections come back the moment
     *  anything actually arrives.
     */
    _renderGovHero() {
        const hero = document.getElementById('terminals-gov-hero');
        const body = document.getElementById('terminals-governance-body');
        const bot = document.getElementById('terminals-gov-hero-bot');
        const title = document.getElementById('terminals-gov-hero-title');
        const text = document.getElementById('terminals-gov-hero-text');
        const summary = document.getElementById('terminals-governance-summary');
        if (!hero) return;
        const has = this._govHas || {};
        const t = this._tasks.find(x => x.id === this._attached);
        const empty = !(has.verdicts || has.traces || has.egress || has.context || has.approvals);
        const show = (on) => {
            hero.hidden = !on;
            if (body) body.classList[on ? 'add' : 'remove']('is-empty');
        };
        if (!t) {
            show(true);
            if (bot) bot.innerHTML = '';
            if (title) title.textContent = 'Pick a task';
            if (text) text.textContent = 'Its verdicts, traces, egress, and context show here.';
            return;
        }
        if (!empty) { show(false); return; }
        show(true);
        if (bot) bot.innerHTML = window.TaskAvatar
            ? TaskAvatar.html({ id: t.id, harness: t.executor_id, state: 'active', size: 56 })
            : '';
        const ex = this._executors.find(e => e.id === t.executor_id);
        // Ungoverned is a different empty: nothing is coming until the Guard
        // is in place, so saying "listening" there would be a lie.
        const ungoverned = !!(ex && !ex.governed) && !this._guardReportedIn(t);
        // So is a task that has already ended: nothing more is coming at all,
        // and a listening ring over a finished session is a false promise.
        const ended = this._isEnded(t);
        if (bot && bot.classList) bot.classList[ended && !ungoverned ? 'add' : 'remove']('is-quiet');
        if (ended && !ungoverned) {
            if (title) title.textContent = 'No governed activity recorded';
            if (text) text.textContent = 'This task ended without a governed call.';
            if (summary) summary.textContent = 'nothing recorded';
            return;
        }
        if (title) title.textContent = ungoverned
            ? 'Running without SecureVector Guard'
            : 'Governed session, listening';
        if (text) text.textContent = ungoverned
            ? 'Install it from the banner above; governance starts the moment the Guard reports in.'
            : 'The first tool call lands here with its verdict. Traces, egress, and context follow.';
        if (summary) summary.textContent = 'listening';
    },

    // --- context & cost -------------------------------------------------

    // Harnesses that take /compact as a slash command. Copilot CLI has no
    // equivalent the app can type, so it gets a note instead of a button that
    // would send a line the harness treats as a prompt.
    _COMPACT_HARNESSES: ['claude-code', 'codex', 'opencode'],

    _fmtTok(n) {
        if (n == null) return '?';
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return Math.round(n / 1e3) + 'K';
        return String(Math.round(n));
    },

    // The Cost & Tokens page owns this wording. Borrow it when that page is
    // loaded so the two surfaces never describe the same waste differently,
    // and keep a short equivalent for when it is not.
    _advText(a) {
        const shared = window.CostsPage && window.CostsPage._optLiveAdvText;
        if (shared) { try { return shared.call(window.CostsPage, a); } catch (e) { /* fall through */ } }
        const tok = (n) => this._fmtTok(n || 0);
        if (a.type === 'tool_result_carry') return `A ${tok(a.tokens)} token result from ${a.tool || 'a tool'} is in this context. Every later turn re-bills it.`;
        if (a.type === 'resend_growth') return `Context re-sent per turn grew from ${tok(a.from_tokens)} to ${tok(a.to_tokens)} tokens.`;
        if (a.type === 'duplicate_calls') return `The same ${a.tool || 'tool'} call ran ${a.count} times in a row.`;
        if (a.type === 'failure_loop') return `${a.streak} tool calls failed back to back: this session is paying to fail repeatedly.`;
        if (a.type === 'long_session') return 'Long session: its whole history is re-billed on every turn.';
        return '';
    },

    _stageBadge(stage) {
        if (stage === 'heads_up') return { text: 'heads up', cls: 'is-amber' };
        if (stage === 'act_now') return { text: 'compact soon', cls: 'is-amber' };
        if (stage === 'last_call') return { text: 'compact now', cls: 'is-red' };
        return { text: '', cls: '' };
    },

    /** Read-only context gauge for the attached task, plus the one action
     *  worth having here. Everything it shows comes from the Cost Optimizer's
     *  live advisor, so the terminal and the Cost & Tokens page agree.
     */
    async _renderContextCost() {
        const el = document.getElementById('terminals-context');
        const badge = document.getElementById('terminals-context-stage');
        const setBadge = (b) => {
            if (!badge) return;
            badge.textContent = b.text;
            badge.className = 'terminals-gov-stage' + (b.cls ? ' ' + b.cls : '');
        };
        if (!el) return;
        if (!this._govHas) this._govHas = {};
        const t = this._tasks.find(x => x.id === this._attached);
        if (!t) {
            el.innerHTML = '<span class="terminals-empty">No task attached.</span>';
            this._contextSig = null;
            this._govHas.context = false;
            setBadge({ text: '', cls: '' });
            this._renderGovHero();
            return;
        }
        // The advisor tails transcripts on disk; polling it faster than this
        // would read the same file over and over for the same answer.
        const now = Date.now();
        if (!this._optLive || now - (this._optLiveAt || 0) > 10000) {
            this._optLiveAt = now;
            try { this._optLive = await API.getOptimizerLive(); } catch (e) { this._optLive = this._optLive || null; }
        }
        if (this._attached !== t.id) return;
        const s = t.session_id
            ? ((this._optLive && this._optLive.sessions) || []).find(x => x.session_id === t.session_id)
            : null;
        if (!s) {
            el.innerHTML = '<span class="terminals-empty">No context data yet. The Guard reports context use once the harness starts working.</span>';
            this._contextSig = null;
            this._govHas.context = false;
            setBadge({ text: '', cls: '' });
            this._renderGovHero();
            return;
        }
        this._govHas.context = true;
        this._renderGovHero();
        const stage = s.compact_stage || 'quiet';
        const badgeSpec = this._stageBadge(stage);
        setBadge(badgeSpec);
        const pct = Math.max(0, Math.min(100, Math.round(s.fill_pct || 0)));
        const advisories = (s.advisories || []).slice(0, 4)
            .map(a => this._advText(a)).filter(Boolean);
        const canCompact = this._COMPACT_HARNESSES.includes(t.executor_id);
        // The cooldown is a deadline on the page, not a flag on a DOM node the
        // next poll throws away; it goes into the signature so a re-render
        // inside the window repaints a button that is still disabled.
        const cooling = Date.now() < (this._compactUntil || 0);
        const sig = [t.id, pct, stage, s.model || '', advisories.join('|'), canCompact, cooling].join('~');
        if (sig === this._contextSig) return;
        this._contextSig = sig;
        const meta = `${pct}% of ${this._fmtTok(s.context_window || 200000)} context · ${this._fmtTok(s.context_tokens_now || 0)} tokens`
            + (s.model ? ' · ' + s.model : '');
        const list = advisories.length
            ? `<ul class="terminals-context-advice">${advisories.map(x => `<li>${this._esc(x)}</li>`).join('')}</ul>`
            : '';
        el.innerHTML = `
          <div class="terminals-context-fill"><div class="terminals-context-bar"><i class="${badgeSpec.cls}" style="width:${pct}%"></i></div><span>${this._esc(meta)}</span></div>
          ${list}
          <div class="terminals-context-actions">
            ${canCompact ? `<button type="button" class="btn btn-sm btn-primary" id="terminals-compact-btn"${cooling ? ' disabled' : ''}>Compact now</button>` : ''}
            <button type="button" class="btn btn-sm" id="terminals-optimizer-btn">Open Cost Optimizer</button>
          </div>
          <p class="terminals-context-note" id="terminals-context-note">${canCompact ? '' : 'Compact from inside the Copilot CLI session; SecureVector cannot send it for this harness.'}</p>`;
        const optBtn = document.getElementById('terminals-optimizer-btn');
        if (optBtn) optBtn.onclick = () => { if (window.Sidebar?.navigate) Sidebar.navigate('costs'); };
        const btn = document.getElementById('terminals-compact-btn');
        if (btn) btn.onclick = () => this._sendCompact();
    },

    /** Type /compact into the attached terminal.
     *  Deliberately a keystroke: it travels the same audited input path the
     *  keyboard uses, so it is recorded like any typed line and cannot slip
     *  past a Guard decision. There is no second way to write to the PTY.
     */
    COMPACT_COOLDOWN_MS: 15000,

    _sendCompact() {
        const note = document.getElementById('terminals-context-note');
        const btn = document.getElementById('terminals-compact-btn');
        const open = this._ws && this._ws.readyState === WebSocket.OPEN;
        if (!open) {
            if (note) note.textContent = 'Attach the task first.';
            return;
        }
        if (Date.now() < (this._compactUntil || 0)) return;
        this._ws.send(JSON.stringify({ t: 'input', data: btoa('/compact\r') }));
        this._compactUntil = Date.now() + this.COMPACT_COOLDOWN_MS;
        if (note) note.textContent = 'Sent /compact to the terminal. The audit trail records it as a typed line.';
        if (btn) btn.disabled = true;
        // Force the next render past the signature check so the button comes
        // back on its own rather than waiting for the gauge to move.
        setTimeout(() => {
            this._contextSig = null;
            this._renderContextCost();
        }, this.COMPACT_COOLDOWN_MS);
    },

    // --- egress ---------------------------------------------------------

    /** Where the attached task reached, blocked hosts first. The count badge
     *  is the distinct-host number, which stays meaningful when the policy is
     *  working and nothing is being blocked.
     */
    async _renderEgress() {
        const el = document.getElementById('terminals-egress');
        const badge = document.getElementById('terminals-egress-count');
        const setBadge = (n, warn) => {
            if (!badge) return;
            badge.textContent = n > 0 ? String(n) : '';
            badge.className = 'terminals-gov-count' + (warn ? ' is-warn' : '');
        };
        if (!el) return;
        if (!this._govHas) this._govHas = {};
        const t = this._tasks.find(x => x.id === this._attached);
        if (!t) {
            el.innerHTML = '<span class="terminals-empty">No task attached.</span>';
            this._egressSig = null;
            this._govHas.egress = false;
            setBadge(0, false);
            this._renderGovHero();
            return;
        }
        if (!t.session_id) {
            el.innerHTML = '<span class="terminals-empty">No egress recorded yet.</span>';
            this._egressSig = null;
            this._govHas.egress = false;
            setBadge(0, false);
            this._renderGovHero();
            return;
        }
        const now = Date.now();
        // A failed fetch is not "this task reached nothing". Caching the
        // failure as an empty result would state, for the next ten seconds and
        // in the same words, something the app does not know. The last good
        // rows stay on screen and the line below says the reading is stale;
        // the timestamp is deliberately left alone so the next poll retries.
        let failed = false;
        if (this._egressSid !== t.session_id || now - (this._egressAt || 0) > 10000) {
            if (this._egressSid !== t.session_id) { this._egress = null; this._egressSig = null; }
            this._egressSid = t.session_id;
            try {
                this._egress = await API.getEgressSessionDestinations(t.session_id);
                this._egressAt = now;
            } catch (e) {
                failed = true;
            }
        }
        if (this._attached !== t.id) return;
        const rows = (this._egress && this._egress.destinations) || [];
        const blocked = rows.filter(r => (r.blocked || 0) > 0).length;
        setBadge(rows.length, blocked > 0);
        this._govHas.egress = rows.length > 0;
        this._renderGovHero();
        // Codex's own web tool never reaches a hook, so its destinations are
        // read back from the local transcript afterwards. That reading is the
        // same consent the Cost Optimizer asks for once; without it the list
        // is not "nothing happened", so the note says which of the two it is.
        const isCodex = (t.executor_id || '') === 'codex';
        const consent = !this._egress || this._egress.transcript_consent !== false;
        const note = !isCodex ? '' : (consent
            ? '<div class="terminals-egress-note">Codex\'s built-in web search is not hookable; its activity is listed here after the fact from the local transcript.</div>'
            : '<div class="terminals-egress-note">Turn on transcript reading in Cost &amp; Tokens to list Codex web activity.</div>');
        const sig = [t.session_id, rows.length, blocked, failed, isCodex, consent,
            rows.slice(0, 12).map(r => `${r.host}:${r.calls}:${r.blocked}:${r.writes}:${r.observed}`).join('|')].join('~');
        if (sig === this._egressSig) return;
        this._egressSig = sig;
        const stale = failed
            ? '<span class="terminals-empty">Egress unavailable right now.</span>' : '';
        if (!rows.length) {
            el.innerHTML = (failed
                ? stale : '<span class="terminals-empty">No egress recorded yet.</span>') + note;
            return;
        }
        const shown = rows.slice(0, 12);
        const more = rows.length - shown.length;
        el.innerHTML = shown.map(r => {
            const isBlocked = (r.blocked || 0) > 0;
            const observed = r.observed || 0;
            // Observed only: nothing here was evaluated, so the row carries no
            // status colour at all. A green dot would read as "allowed", which
            // is a verdict no policy gave.
            const isObserved = observed > 0 && observed >= (r.calls || 0);
            const host = r.host === 'web-search' ? 'Codex web search' : r.host;
            const meta = `${r.calls} call${r.calls === 1 ? '' : 's'}`
                + (r.writes ? ` · ${r.writes} write${r.writes === 1 ? '' : 's'}` : '')
                + (isBlocked ? ` · ${r.blocked} blocked` : '')
                + (isObserved ? ' · observed, not governed' : '');
            const cls = isBlocked ? 'blocked' : (isObserved ? 'observed' : 'allowed');
            const dot = isObserved ? '' : ` sv-status-${isBlocked ? 'red' : 'green'}`;
            return `
              <div class="terminals-egress-row terminals-egress-${cls}">
                <span class="terminals-dot${dot}"></span>
                <span class="terminals-egress-host" title="${this._esc(r.host)}">${this._esc(host)}</span>
                <span class="terminals-egress-meta">${this._esc(meta)}</span>
              </div>`;
        }).join('') + stale + note + (more > 0
            ? `<button type="button" class="terminals-egress-more" id="terminals-egress-more">+${more} more</button>`
            : '');
        const moreBtn = document.getElementById('terminals-egress-more');
        if (moreBtn) moreBtn.onclick = () => { if (window.Sidebar?.navigate) Sidebar.navigate('egress'); };
    },

    // --- helpers --------------------------------------------------------

    // API.getTraces() swallows its own errors and returns { runs: [] } on
    // failure, which is indistinguishable from "no traces". Call the same
    // endpoint directly so a real failure rejects and the rail can tell the
    // two apart instead of caching an error as "No traces yet." for 12s.
    async _fetchTraceRuns(params = {}) {
        const q = new URLSearchParams();
        if (params.window_days) q.set('window_days', params.window_days);
        if (params.limit) q.set('limit', params.limit);
        const qs = q.toString();
        return API.request(`/api/traces${qs ? '?' + qs : ''}`);
    },

    _label(executorId) {
        const e = this._executors.find(x => x.id === executorId);
        return e ? e.label : executorId;
    },
    _launchable(e) {
        return e.installed !== false && e.governed !== false;
    },
    _renderExecutorOptions(container) {
        const sel = container.querySelector('#terminals-executor');
        if (!sel) return;
        sel.innerHTML = this._executors.map(e => {
            const ok = this._launchable(e);
            // Installed-but-ungoverned stays selectable so the user can pick
            // it and install its Guard plugin in place; only "not installed"
            // is a hard stop.
            const selectable = e.installed !== false;
            const suffix = ok ? '' : (e.installed === false ? ' (not installed)' : ' (Guard not enabled)');
            return `<option value="${this._esc(e.id)}"${selectable ? '' : ' disabled'}>${this._esc(e.label + suffix)}</option>`;
        }).join('');
        // Prefer a fully governed executor by default; fall back to any
        // installed one so the form still opens on something the user can
        // launch (ungoverned) rather than nothing.
        const first = this._executors.find(e => this._launchable(e)) || this._executors.find(e => e.installed !== false);
        if (first) sel.value = first.id;
        sel.onchange = () => this._showExecutorState(container);
        this._showExecutorState(container);
    },
    // Renders the hint / guard row / submit state for whichever executor is
    // currently selected. Shared by _renderExecutorOptions (on change and on
    // every executors refetch) and by the install/recheck flow, which
    // reselects an executor programmatically and must re-run the same logic.
    _showExecutorState(container) {
        // A pending "ready" auto-hide must not hide the row for a different harness.
        if (this._guardReadyTimer) { clearTimeout(this._guardReadyTimer); this._guardReadyTimer = null; }
        const sel = container.querySelector('#terminals-executor');
        const hint = container.querySelector('#terminals-executor-hint');
        const submit = container.querySelector('#terminals-launch button[type="submit"]');
        const guardRow = container.querySelector('#terminals-guard-row');
        const guardText = container.querySelector('#terminals-guard-text');
        const guardInstall = container.querySelector('#terminals-guard-install');
        const guardRecheck = container.querySelector('#terminals-guard-recheck');
        const guardCommands = container.querySelector('#terminals-guard-commands');
        if (!sel) return;
        const cur = this._executors.find(e => e.id === sel.value);
        // A task can launch on an installed-but-ungoverned harness (it just
        // runs without verdicts, traces, or approvals until the Guard is
        // installed); only a harness that is not installed at all blocks
        // submit.
        if (submit) submit.disabled = !cur || cur.installed === false;
        if (this._mode === 'link') {
            // Linking says nothing about how a task would launch, so the
            // launch-time Guard copy would be wrong here. The in-session
            // banner is where a linked session's Guard gets installed.
            if (hint) hint.hidden = true;
            if (guardRow) guardRow.hidden = true;
            if (guardCommands) guardCommands.hidden = true;
            if (cur && cur.installed === false && hint) {
                hint.textContent = cur.hint || '';
                hint.hidden = !cur.hint;
            }
            return;
        }
        if (!cur) {
            const fallback = this._executors.some(e => e.installed !== false)
                ? ''
                : 'No harness is ready to launch. Install one and enable its Guard plugin in Integrations.';
            if (hint) { hint.textContent = fallback; hint.hidden = !fallback; }
            if (guardRow) guardRow.hidden = true;
            return;
        }
        if (cur.installed === false) {
            if (hint) { hint.textContent = cur.hint || ''; hint.hidden = !cur.hint; }
            if (guardRow) guardRow.hidden = true;
            return;
        }
        if (hint) hint.hidden = true;
        if (!cur.governed) {
            if (guardRow) guardRow.hidden = false;
            if (this._guardPending && this._guardPending.executorId === cur.id) {
                if (guardText) guardText.textContent = this._guardPending.text;
                if (guardCommands) { guardCommands.textContent = this._guardPending.commands.join('\n'); guardCommands.hidden = false; }
                if (guardInstall) guardInstall.hidden = true;
                if (guardRecheck) { guardRecheck.hidden = false; guardRecheck.disabled = false; guardRecheck.textContent = 'Check again'; }
            } else {
                if (guardText) guardText.textContent = `SecureVector Guard is not enabled for ${cur.label}. The task launches ungoverned: no verdicts, traces, or approvals until you install it.`;
                if (guardCommands) guardCommands.hidden = true;
                if (guardInstall) { guardInstall.hidden = false; guardInstall.disabled = false; guardInstall.textContent = 'Install SecureVector Guard'; }
                if (guardRecheck) guardRecheck.hidden = true;
            }
        } else {
            if (this._guardPending && this._guardPending.executorId === cur.id) this._guardPending = null;
            if (guardRow) guardRow.hidden = true;
        }
    },
    _renderGuardReady(container, label, autoHide) {
        const guardRow = container.querySelector('#terminals-guard-row');
        const guardText = container.querySelector('#terminals-guard-text');
        const guardInstall = container.querySelector('#terminals-guard-install');
        const guardRecheck = container.querySelector('#terminals-guard-recheck');
        const guardCommands = container.querySelector('#terminals-guard-commands');
        if (guardRow) guardRow.hidden = false;
        if (guardText) guardText.textContent = `SecureVector Guard enabled. ${label} is ready to launch.`;
        if (guardInstall) guardInstall.hidden = true;
        if (guardRecheck) guardRecheck.hidden = true;
        if (guardCommands) guardCommands.hidden = true;
        if (autoHide) {
            // One timer at a time: switching harness clears it (see _showExecutorState).
            if (this._guardReadyTimer) clearTimeout(this._guardReadyTimer);
            this._guardReadyTimer = setTimeout(() => { this._guardReadyTimer = null; if (guardRow && !guardRow.hidden) guardRow.hidden = true; }, 4000);
        }
    },
    async _installGuard(executorId, container) {
        const guardRow = container.querySelector('#terminals-guard-row');
        const guardText = container.querySelector('#terminals-guard-text');
        const guardInstall = container.querySelector('#terminals-guard-install');
        const guardRecheck = container.querySelector('#terminals-guard-recheck');
        if (guardInstall) { guardInstall.disabled = true; guardInstall.textContent = 'Installing…'; }
        try {
            const res = await API.installGuard(executorId);
            const ex = await API.terminalsExecutors();
            this._executors = ex.items || [];
            this._renderExecutorOptions(container);
            const sel = container.querySelector('#terminals-executor');
            if (sel) sel.value = executorId;
            const cur = this._executors.find(e => e.id === executorId);
            const label = cur ? cur.label : this._label(executorId);
            if (cur && cur.governed) {
                this._guardPending = null;
                this._showExecutorState(container);
                this._renderGuardReady(container, label, true);
            } else if (res.commands && res.commands.length) {
                let text = `Finish in ${label}: run the commands below, then click Check again.`;
                if (res.next_step) text += ` ${res.next_step}`;
                this._guardPending = { executorId, text, commands: res.commands };
                this._showExecutorState(container);
            } else {
                this._guardPending = null;
                if (guardText) guardText.textContent = res.next_step || `Guard install did not finish for ${label}. Try again.`;
                if (guardRow) guardRow.hidden = false;
                if (guardInstall) { guardInstall.hidden = false; guardInstall.disabled = false; guardInstall.textContent = 'Install SecureVector Guard'; }
                if (guardRecheck) guardRecheck.hidden = true;
            }
        } catch (e) {
            if (guardRow) guardRow.hidden = false;
            if (guardText) guardText.textContent = e.message || 'Guard install failed.';
            if (guardInstall) { guardInstall.hidden = false; guardInstall.disabled = false; guardInstall.textContent = 'Install SecureVector Guard'; }
            if (guardRecheck) guardRecheck.hidden = true;
        }
    },
    async _recheckGuard(executorId, container) {
        const guardRecheck = container.querySelector('#terminals-guard-recheck');
        if (guardRecheck) { guardRecheck.disabled = true; guardRecheck.textContent = 'Checking…'; }
        try {
            const ex = await API.terminalsExecutors();
            this._executors = ex.items || [];
            const cur = this._executors.find(e => e.id === executorId);
            if (cur && cur.governed) this._guardPending = null;
            this._renderExecutorOptions(container);
            const sel = container.querySelector('#terminals-executor');
            if (sel) sel.value = executorId;
            this._showExecutorState(container);
            if (cur && cur.governed) this._renderGuardReady(container, cur.label, true);
        } catch (e) {
            const guardText = container.querySelector('#terminals-guard-text');
            if (guardText) guardText.textContent = e.message || 'Could not check the Guard.';
        } finally {
            const recheckBtn = container.querySelector('#terminals-guard-recheck');
            if (recheckBtn && !recheckBtn.hidden) { recheckBtn.disabled = false; recheckBtn.textContent = 'Check again'; }
        }
    },
    _shortPath(p) {
        const parts = (p || '').split('/').filter(Boolean);
        return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
    },
    _elapsed(start, end) {
        const s = Date.parse(start);
        if (!s) return '';
        const ms = (end ? Date.parse(end) : Date.now()) - s;
        const m = Math.floor(ms / 60000), sec = Math.floor((ms % 60000) / 1000);
        if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
        return m ? `${m}m ${sec}s` : `${sec}s`;
    },
    _ago(iso) {
        const s = Date.parse(iso);
        if (!s) return '';
        const ms = Date.now() - s;
        if (ms < 60000) return 'just now';
        const m = Math.floor(ms / 60000);
        if (m < 60) return `${m}m ago`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h}h ago`;
        const d = Math.floor(h / 24);
        return `${d}d ago`;
    },
    _esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
};
window.TerminalsPage = TerminalsPage;
