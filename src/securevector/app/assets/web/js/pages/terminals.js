// src/securevector/app/assets/web/js/pages/terminals.js
// Agent Tasks: launch a governed task, attach to one at a time, and keep
// governance available without taking over the workspace.
const TerminalsPage = {
    _tasks: [],
    _executors: [],
    _attached: null,      // task id
    _ws: null,
    _view: null,
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

    async render(container) {
        const gen = ++this._gen;
        // navigating terminals -> terminals re-renders without calling destroy(),
        // so a stale attachment/timers from the outgoing DOM must be torn down here too.
        clearInterval(this._pollTimer);
        clearInterval(this._railTimer);
        this._pollTimer = null;
        this._railTimer = null;
        clearTimeout(this._removeConfirmTimer);
        this._removeConfirmTimer = null;
        this._removeConfirmId = null;
        this._detach();
        // The form is rebuilt below in launch mode, so the remembered mode
        // must not outlive the DOM that showed it.
        this._mode = 'launch';
        this._unlinked = null;
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
              <div class="terminals-attached-body" id="terminals-attached-body">
                <div class="terminals-stage-empty">
                  <h3>Your governed agent workspace</h3>
                  <p>Launch a harness or select a task to return to its live terminal, verdicts, and approvals.</p>
                </div>
              </div>
              <div class="terminals-pane-foot" id="terminals-pane-foot" hidden></div>
            </section>
            <details class="terminals-governance" id="terminals-governance" open>
              <summary><span>Governance activity</span><span class="terminals-governance-summary" id="terminals-governance-summary">Attach a task to inspect its trace</span></summary>
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
            </details>
            </div>
          </div>`;

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
        this._railTimer = setInterval(() => this._refreshRail(), 4000);
    },

    destroy() {
        this._gen = (this._gen || 0) + 1;
        clearInterval(this._pollTimer);
        clearInterval(this._railTimer);
        this._pollTimer = null;
        this._railTimer = null;
        clearTimeout(this._removeConfirmTimer);
        this._removeConfirmTimer = null;
        this._removeConfirmId = null;
        this._detach();
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
        const sig = this._tasks.map(t => t.id + ':' + this._taskState(t).kind).join('|');
        if (sig !== this._railSig) {
            this._railSig = sig;
            if (window.Sidebar?.refreshAgentTaskViews) Sidebar.refreshAgentTaskViews();
        }
        this._renderAttachedHead();
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
            const attachedBody = document.getElementById('terminals-attached-body');
            if (attachedBody) attachedBody.innerHTML = '';
            if (window.Sidebar?.setActive) Sidebar.setActive('terminals');
            this._renderAttachedHead();
            this._renderTaskList();
        }
    },

    _renderTaskList() {
        const el = document.getElementById('terminals-task-list');
        if (!el) return;
        if (this._error) { el.innerHTML = `<div class="terminals-error">${this._esc(this._error)}</div>`; return; }
        if (!this._tasks.length) {
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
            el.innerHTML = '<div class="terminals-task-empty"><strong>No matching tasks</strong><span>Try a task name, workspace, harness, or state.</span></div>';
            return;
        }
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
                const canRelaunch = t.status === 'done';
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
                html += `
                  <article class="terminals-task${active}" data-id="${this._esc(t.id)}">
                    <button class="terminals-task-select" data-id="${this._esc(t.id)}" aria-label="Open ${this._esc(t.title || this._label(t.executor_id))}">
                      <span class="terminals-task-title-row">${window.TaskAvatar ? TaskAvatar.html({ id: t.id, harness: t.executor_id, state: state.kind, size: 44 }) : ''}<span class="terminals-task-title">${this._esc(t.title || this._label(t.executor_id))}</span>${t.origin === 'linked' ? '<span class="terminals-task-linked">linked</span>' : ''}</span>
                      <span class="terminals-task-sub" title="${this._esc(state.detail)}">${this._esc(this._label(t.executor_id))} · ${this._esc(state.label)}</span>
                      <span class="terminals-task-when">${this._esc(elapsed)}</span>
                    </button>
                    ${relaunch}
                    ${removable}
                  </article>`;
            }
            html += '</div>';
        }
        el.innerHTML = html;
        el.querySelectorAll('.terminals-task-select').forEach(b => { b.onclick = () => this._attach(b.dataset.id); });
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
                    if (this._attached === task.id) this._detach();
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

    // --- attached terminal ----------------------------------------------

    async _attach(id) {
        if (this._attached === id && this._ws && this._ws.readyState <= WebSocket.OPEN) return;
        this._detach();
        const body = document.getElementById('terminals-attached-body');
        if (!body) return;
        this._attached = id;
        // Both panels are cached reads keyed to a session. Carrying either
        // across an attach would put the previous task's context gauge and
        // destination list under the new task's name, which reads as evidence
        // about the wrong agent. Clear the containers as well as the caches:
        // a stale gauge is visible until the next fetch returns.
        this._resetSessionPanels();
        this._sessionReported = null;
        sessionStorage.setItem('sv-agent-task-id', id);
        if (window.Sidebar?.setActive) Sidebar.setActive('terminals');
        document.querySelector('.terminals-page')?.classList.add('is-focused');
        this._attachedAt = Date.now();
        this._renderTaskList();
        this._renderAttachedHead();
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
            if (this._attached !== id) return;
            task = this._tasks.find(x => x.id === id);
        }
        if (!task) {
            body.innerHTML = '<div class="terminals-banner" id="terminals-banner" hidden></div>';
            this._banner('Task not found.');
            this._renderTaskList();
            this._renderAttachedHead();
            return;
        }
        if (task.origin === 'linked') {
            // No PTY, so no socket: the governance panel keys off the
            // session id and works exactly as it does for a launched task.
            body.innerHTML = `
              <div class="terminals-linked-stage">
                <div class="terminals-linked-bot">${window.TaskAvatar ? TaskAvatar.html({ id: task.id, harness: task.executor_id, state: this._taskState(task).kind, size: 56 }) : ''}</div>
                <h3>Runs outside SecureVector</h3>
                <p>This session was started in your own terminal. There is no terminal here; governance is live.</p>
              </div>
              <div class="terminals-banner" id="terminals-banner" hidden></div>`;
            this._refreshRail();
            return;
        }
        body.innerHTML = '<div class="terminals-xterm" id="terminals-xterm"></div><div class="terminals-banner" id="terminals-banner" hidden></div>';
        const mount = body.querySelector('#terminals-xterm');
        const ws = new WebSocket(API.terminalsSocketUrl(id));
        this._ws = ws;
        this._view = new TerminalView(mount, {
            onInput: (b64) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'input', data: b64 })); },
            onResize: (rows, cols) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'resize', rows, cols })); },
        });
        ws.onopen = () => {
            const { rows, cols } = this._view.size;
            ws.send(JSON.stringify({ t: 'resize', rows, cols }));
            this._view.focus();
        };
        ws.onmessage = (ev) => {
            let f;
            try { f = JSON.parse(ev.data); } catch (e) { return; }
            if (f.t === 'replay' || f.t === 'out') this._view.write(f.data);
            else if (f.t === 'ping') ws.send(JSON.stringify({ t: 'pong' }));
            else if (f.t === 'dropped') this._banner(`Output fell behind, ${f.n} chunks skipped. Reattach to replay.`);
            else if (f.t === 'exit') this._banner(f.code === 0 ? 'Task finished.' : `Task ended with exit code ${f.code}.`);
        };
        ws.onclose = (ev) => {
            if (ev.code === 4001) this._banner('Not authorised to attach from this origin.');
            else if (ev.code === 4004) this._banner('Task no longer exists.');
            else if (ev.code === 4008) this._banner('Connection timed out. Click the task to reattach.');
        };
        this._refreshRail();
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

    _detach() {
        if (this._ws) {
            const ws = this._ws;
            // Null the handlers before closing so frames from the old task
            // queued on this socket cannot land in a newly attached terminal.
            ws.onmessage = ws.onclose = ws.onopen = ws.onerror = null;
            try { ws.close(); } catch (e) { /* closing */ }
        }
        if (this._view) { try { this._view.dispose(); } catch (e) { /* already gone */ } }
        this._ws = null;
        this._view = null;
        this._attached = null;
        // Counts belong to one task; a stale pair on the footer would read as
        // governance evidence for a task it never came from.
        this._govCounts = { governed: 0, blocked: 0 };
        this._govHas = {};
        this._sessionReported = null;
        this._resetSessionPanels();
        this._renderGovHero();
        this._headSig = null;
        this._footSig = null;
        document.querySelector('.terminals-page')?.classList.remove('is-focused');
    },

    _banner(text) {
        const b = document.getElementById('terminals-banner');
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

    _renderAttachedHead() {
        const head = document.getElementById('terminals-attached-head');
        if (!head) return;
        const t = this._tasks.find(x => x.id === this._attached);
        if (!t) {
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
        const running = ['starting', 'working', 'blocked', 'idle'].includes(t.status)
            && t.origin !== 'linked';
        const { shown, overflow } = this._tabTasks();
        const headSig = [this._attached, running ? 'run' : 'idle', overflow]
            .concat(shown.map(x => [x.id, this._taskState(x).kind, x.title || this._label(x.executor_id)].join(':')))
            .join('|');
        if (headSig === this._headSig) { this._renderPaneFoot(); this._renderGuardBanner(); return; }
        this._headSig = headSig;
        const tabs = shown.map(x => {
            const st = this._taskState(x);
            const name = x.title || this._label(x.executor_id);
            const isActive = x.id === this._attached;
            return `<button type="button" class="terminals-pane-tab${isActive ? ' is-active' : ''}" role="tab" data-id="${this._esc(x.id)}" aria-selected="${isActive ? 'true' : 'false'}" title="${this._esc(name + ' · ' + this._label(x.executor_id))}">${window.TaskAvatar ? TaskAvatar.html({ id: x.id, harness: x.executor_id, state: st.kind, size: 18 }) : ''}<span class="terminals-pane-tab-title">${this._esc(name)}</span>${st.kind === 'active' ? '<i class="terminals-pane-live" aria-hidden="true"></i>' : ''}</button>`;
        }).join('');
        head.innerHTML = `
          <div class="terminals-pane-tabs" role="tablist" aria-label="Running tasks">${tabs}</div>
          <div class="terminals-pane-tab-actions">${overflow ? `<button type="button" class="terminals-pane-tab terminals-pane-tab-more" title="Show all tasks">+${overflow}</button>` : ''}<button type="button" class="terminals-pane-tab terminals-pane-tab-new" title="Launch a task" aria-label="Launch a task">+</button></div>
          <span class="terminals-head-spacer"></span>
          <button class="btn btn-sm" id="terminals-all-tasks-btn">All tasks</button>
          ${running ? '<button class="btn btn-sm" id="terminals-stop-btn">Stop</button>' : ''}`;
        const showAllTasks = () => {
            sessionStorage.removeItem('sv-agent-task-id');
            this._detach();
            const attachedBody = document.getElementById('terminals-attached-body');
            if (attachedBody) attachedBody.innerHTML = '';
            if (window.Sidebar?.setActive) Sidebar.setActive('terminals');
            this._renderAttachedHead();
            this._renderTaskList();
        };
        const allTasksBtn = head.querySelector('#terminals-all-tasks-btn');
        if (allTasksBtn) allTasksBtn.onclick = showAllTasks;
        head.querySelectorAll('.terminals-pane-tab[data-id]').forEach(b => {
            b.onclick = () => { if (b.dataset.id !== this._attached) this._attach(b.dataset.id); };
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
    _renderPaneFoot() {
        const foot = document.getElementById('terminals-pane-foot');
        if (!foot) return;
        const t = this._tasks.find(x => x.id === this._attached);
        if (!t) { foot.hidden = true; foot.innerHTML = ''; this._footSig = null; return; }
        foot.hidden = false;
        const state = this._taskState(t);
        const elapsed = this._elapsed(t.created_at, t.ended_at);
        const counts0 = this._govCounts || { governed: 0, blocked: 0 };
        const footSig = [t.id, t.workspace, t.branch || '', t.executor_id, state.kind, counts0.governed, counts0.blocked].join('|');
        if (footSig === this._footSig) {
            // Only the clock moved. Patching one text node keeps the rest of
            // the line, including its title attributes, exactly as it was.
            const clock = document.getElementById('terminals-foot-elapsed');
            if (clock) clock.textContent = elapsed;
            return;
        }
        this._footSig = footSig;
        const dot = '<span class="terminals-foot-dot" aria-hidden="true">\u00b7</span>';
        const branch = typeof t.branch === 'string' && t.branch
            ? `<span class="terminals-foot-sep" aria-hidden="true">\u203a</span><span class="terminals-foot-item terminals-foot-branch">${this._esc(t.branch)}</span>`
            : '';
        const counts = this._govCounts || { governed: 0, blocked: 0 };
        foot.innerHTML = `
          <span class="terminals-foot-item terminals-foot-path" title="${this._esc(t.workspace)}">${this._esc(this._shortPath(t.workspace))}</span>
          ${branch}
          ${dot}<span class="terminals-foot-item">${this._esc(this._label(t.executor_id))}</span>
          ${dot}<span class="terminals-foot-item terminals-foot-state terminals-foot-state-${state.kind}">${this._esc(state.label.toLowerCase())}</span>
          ${dot}<span class="terminals-foot-item" id="terminals-foot-elapsed">${this._esc(elapsed)}</span>
          <span class="terminals-head-spacer"></span>
          <span class="terminals-foot-item terminals-foot-gov" id="terminals-foot-gov">${counts.governed} governed \u00b7 ${counts.blocked} blocked</span>`;
    },

    // Statuses in which the PTY is still alive. A restart has to wait for the
    // task to leave this set before launching, or the new harness races the
    // old one for the same working folder.
    _RUNNING_STATUSES: ['starting', 'working', 'blocked', 'idle'],

    // Counted attempts rather than a wall-clock deadline: the same ten seconds
    // in practice, but the wait cannot be shortened or stretched by a slow
    // event loop, and it is drivable in a test without ten seconds of sleeping.
    STOP_POLL_MS: 500,
    STOP_POLL_ATTEMPTS: 20,

    /** Launch a fresh task with the same harness, folder, and title, and
     *  attach to it. A relaunch deliberately creates a new task/session: the
     *  old audit trail remains immutable and still attachable.
     *  `stopFirst` is for restarting a task that is still running, where the
     *  old process has to be gone before the new one starts.
     */
    async _relaunchTask(task, { stopFirst = false } = {}) {
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
        await this._attach(fresh.id);
        return fresh;
    },

    /** Restart the attached task from the Guard banner's pending state.
     *  A harness only loads a newly installed plugin at startup, so for the
     *  harnesses without a reload command this is the only way out of the
     *  ungoverned window without leaving the app.
     */
    async _restartHarnessFromBanner() {
        const btn = document.getElementById('terminals-guard-banner-restart');
        const text = document.getElementById('terminals-guard-banner-text');
        const t = this._tasks.find(x => x.id === this._attached);
        if (!t) return;
        if (btn) { btn.disabled = true; btn.textContent = 'Restarting…'; }
        try {
            await this._relaunchTask(t, { stopFirst: true });
        } catch (e) {
            if (text) text.textContent = e.message || 'Could not restart the harness.';
            if (btn) { btn.disabled = false; btn.textContent = 'Restart harness'; }
        }
    },

    // A task may launch before its Guard plugin is in place. Nothing is
    // silently ungoverned: the session carries this strip until the Guard
    // reports in (the first hook event gives the task a session_id).
    _renderGuardBanner() {
        const banner = document.getElementById('terminals-guard-banner');
        if (!banner) return;
        const text = document.getElementById('terminals-guard-banner-text');
        const install = document.getElementById('terminals-guard-banner-install');
        const recheck = document.getElementById('terminals-guard-banner-recheck');
        const restart = document.getElementById('terminals-guard-banner-restart');
        const commands = document.getElementById('terminals-guard-banner-commands');
        const hide = () => {
            banner.hidden = true;
            if (commands) commands.hidden = true;
            this._guardBannerSig = null;
        };
        const t = this._tasks.find(x => x.id === this._attached);
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
        if (sig === this._guardBannerSig) return;
        this._guardBannerSig = sig;
        banner.hidden = false;
        if (install) install.onclick = () => this._installGuardFromBanner(ex.id);
        if (recheck) recheck.onclick = () => this._recheckGuardFromBanner();
        if (restart) restart.onclick = () => this._restartHarnessFromBanner();
        if (!ex.governed) {
            banner.classList.remove('is-pending');
            if (pending) {
                if (text) text.textContent = pending.text;
                if (commands) { commands.textContent = pending.commands.join('\n'); commands.hidden = false; }
                if (install) install.hidden = true;
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
                ? 'SecureVector Guard installed. Run /reload-plugins in the terminal, or restart the harness to load it.'
                : 'SecureVector Guard installed. Restart the harness to load it.');
        if (commands) commands.hidden = true;
        if (install) install.hidden = true;
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
        return Boolean(t.session_id);
    },

    async _installGuardFromBanner(executorId) {
        const banner = document.getElementById('terminals-guard-banner');
        const text = document.getElementById('terminals-guard-banner-text');
        const install = document.getElementById('terminals-guard-banner-install');
        const recheck = document.getElementById('terminals-guard-banner-recheck');
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
            this._guardBannerSig = null;
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
            this._guardBannerSig = null;
        }
    },

    async _recheckGuardFromBanner() {
        const recheck = document.getElementById('terminals-guard-banner-recheck');
        if (recheck) { recheck.disabled = true; recheck.textContent = 'Checking…'; }
        try {
            const ex = await API.terminalsExecutors();
            this._executors = ex.items || [];
            if (this._container) {
                this._renderExecutorOptions(this._container);
                this._showExecutorState(this._container);
            }
            await this._refreshTasks();
            this._guardBannerSig = null;
            this._renderGuardBanner();
        } catch (e) {
            const text = document.getElementById('terminals-guard-banner-text');
            if (text) text.textContent = e.message || 'Could not check the Guard.';
        } finally {
            const btn = document.getElementById('terminals-guard-banner-recheck');
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
                        : (traceRuns.length ? traceRuns.map(r => {
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
                          <span class="terminals-trace-top"><button type="button" class="terminals-trace-id" data-trace-id="${this._esc(r.trace_id)}" title="Open trace">trace ${this._esc(shortId)}</button><span class="terminals-trace-risk terminals-trace-risk-${risk}">${this._esc(riskLabel)}</span></span>
                          <span class="terminals-trace-meta">${this._esc(metaParts.join(' · '))}</span>
                        </span>
                        <button type="button" class="terminals-trace-open" data-trace-id="${this._esc(r.trace_id)}">Details</button>
                      </div>`;
                    }).join('') : '<span class="terminals-empty">No traces yet.</span>');
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
                    document.getElementById('terminals-governance').open = true;
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
        const sig = [t.session_id, rows.length, blocked, failed,
            rows.slice(0, 12).map(r => `${r.host}:${r.calls}:${r.blocked}:${r.writes}`).join('|')].join('~');
        if (sig === this._egressSig) return;
        this._egressSig = sig;
        const stale = failed
            ? '<span class="terminals-empty">Egress unavailable right now.</span>' : '';
        if (!rows.length) {
            el.innerHTML = failed
                ? stale : '<span class="terminals-empty">No egress recorded yet.</span>';
            return;
        }
        const shown = rows.slice(0, 12);
        const more = rows.length - shown.length;
        el.innerHTML = shown.map(r => {
            const isBlocked = (r.blocked || 0) > 0;
            const meta = `${r.calls} call${r.calls === 1 ? '' : 's'}`
                + (r.writes ? ` · ${r.writes} write${r.writes === 1 ? '' : 's'}` : '')
                + (isBlocked ? ` · ${r.blocked} blocked` : '');
            return `
              <div class="terminals-egress-row terminals-egress-${isBlocked ? 'blocked' : 'allowed'}">
                <span class="terminals-dot sv-status-${isBlocked ? 'red' : 'green'}"></span>
                <span class="terminals-egress-host" title="${this._esc(r.host)}">${this._esc(r.host)}</span>
                <span class="terminals-egress-meta">${this._esc(meta)}</span>
              </div>`;
        }).join('') + stale + (more > 0
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
