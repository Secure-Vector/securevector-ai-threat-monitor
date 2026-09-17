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

    async render(container) {
        const gen = ++this._gen;
        // navigating terminals -> terminals re-renders without calling destroy(),
        // so a stale attachment/timers from the outgoing DOM must be torn down here too.
        clearInterval(this._pollTimer);
        clearInterval(this._railTimer);
        this._pollTimer = null;
        this._railTimer = null;
        this._detach();
        container.innerHTML = `
          <div class="terminals-page">
            <section class="terminals-tasks">
              <div class="terminals-tasks-head">
                <div>
                  <span class="terminals-eyebrow">Governed workspace</span>
                  <h2>Agent Tasks</h2>
                  <p>Every harness call is checked, recorded, and ready for approval.</p>
                </div>
                <div class="terminals-tasks-actions">
                  <input class="terminals-task-search" id="terminals-task-search" type="search" placeholder="Find a task" aria-label="Find a task">
                  <button class="btn btn-primary btn-sm terminals-launch-button" id="terminals-launch-btn">+ Launch</button>
                </div>
              </div>
              <form class="terminals-launch" id="terminals-launch" hidden>
                <label>Harness
                  <select id="terminals-executor"></select>
                </label>
                <label>Folder
                  <input id="terminals-workspace" type="text" placeholder="/path/to/project" autocomplete="off" spellcheck="false">
                </label>
                <label>Title (optional)
                  <input id="terminals-title" type="text" maxlength="120">
                </label>
                <div class="terminals-launch-actions">
                  <button type="submit" class="btn btn-primary btn-sm">Launch task</button>
                  <button type="button" class="btn btn-sm" id="terminals-launch-cancel">Cancel</button>
                </div>
                <div class="terminals-launch-error" id="terminals-launch-error" hidden></div>
                <div class="terminals-executor-hint" id="terminals-executor-hint" hidden></div>
              </form>
              <div id="terminals-task-list" class="terminals-task-list"></div>
            </section>
            <div class="terminals-workspace">
            <section class="terminals-centre">
              <div class="terminals-attached-head" id="terminals-attached-head">
                <span class="terminals-empty">Pick a task to attach, or launch one.</span>
              </div>
              <div class="terminals-attention" id="terminals-attention" hidden></div>
              <div class="terminals-attached-body" id="terminals-attached-body">
                <div class="terminals-stage-empty">
                  <span class="terminals-stage-mark">SV</span>
                  <h3>Your governed agent workspace</h3>
                  <p>Launch a harness or select a task to return to its live terminal, verdicts, and approvals.</p>
                </div>
              </div>
            </section>
            <details class="terminals-governance" id="terminals-governance" open>
              <summary><span>Governance activity</span><span class="terminals-governance-summary" id="terminals-governance-summary">Attach a task to inspect its trace</span></summary>
              <div class="terminals-governance-body">
                <details class="terminals-gov-section" open><summary><h3>Recent verdicts</h3><span class="terminals-gov-count" id="terminals-verdicts-count"></span></summary><div id="terminals-verdicts" class="terminals-verdicts"><span class="terminals-empty">No task attached.</span></div></details>
                <details class="terminals-gov-section" open><summary class="terminals-traces-head"><h3>Traces</h3><a href="#" class="terminals-traces-all" id="terminals-traces-all">All traces</a><span class="terminals-gov-count" id="terminals-traces-count"></span></summary><div id="terminals-traces" class="terminals-traces"><span class="terminals-empty">No task attached.</span></div></details>
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
        } catch (e) {
            console.warn('Terminals: executors unavailable', e);
            this._executors = [];
            this._renderExecutorOptions(container);
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
        this._detach();
        this._tasks = [];
        this._executors = [];
        this._attachedAt = null;
        this._error = null;
        this._pendingApprovalSessions = new Set();
        this._taskQuery = '';
        this._tracesCache = null;
    },

    // --- task strip -----------------------------------------------------

    _bindLaunchForm(container) {
        const form = container.querySelector('#terminals-launch');
        container.querySelector('#terminals-launch-btn').onclick = () => {
            form.hidden = !form.hidden;
            if (!form.hidden) container.querySelector('#terminals-workspace').focus();
        };
        container.querySelector('#terminals-launch-cancel').onclick = () => { form.hidden = true; };
        form.onsubmit = async (ev) => {
            ev.preventDefault();
            const err = container.querySelector('#terminals-launch-error');
            err.hidden = true;
            const executor = container.querySelector('#terminals-executor').value;
            const chosen = this._executors.find(e => e.id === executor);
            if (!chosen || !this._launchable(chosen)) { err.textContent = (chosen && chosen.hint) || 'This harness is not ready to launch.'; err.hidden = false; return; }
            const workspace = container.querySelector('#terminals-workspace').value.trim();
            const title = container.querySelector('#terminals-title').value.trim();
            if (!workspace) { err.textContent = 'Enter the folder the task should run in.'; err.hidden = false; return; }
            try {
                const task = await API.terminalsLaunch(executor, workspace, title);
                form.hidden = true;
                await this._refreshTasks();
                if (window.Sidebar?.refreshAgentTaskViews) Sidebar.refreshAgentTaskViews();
                this._attach(task.id);
            } catch (e) {
                err.textContent = e.message || 'Launch failed.';
                err.hidden = false;
            }
        };
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
        for (const [ws, tasks] of groups) {
            html += `<div class="terminals-group"><div class="terminals-group-name" title="${this._esc(ws)}">${this._esc(this._shortPath(ws))}</div>`;
            for (const t of tasks) {
                const active = t.id === this._attached ? ' is-attached' : '';
                const state = this._taskState(t);
                const canRelaunch = t.status === 'done';
                const relaunch = canRelaunch
                    ? `<button class="terminals-task-relaunch" data-relaunch-id="${this._esc(t.id)}" aria-label="Relaunch task" title="Relaunch with the same harness and folder">↻</button>` : '';
                const removable = !['starting', 'working', 'blocked', 'idle'].includes(t.status)
                    ? `<button class="terminals-task-remove" data-remove-id="${this._esc(t.id)}" title="Remove from board; the audit record remains">Remove</button>` : '';
                html += `
                  <article class="terminals-task${active}" data-id="${this._esc(t.id)}">
                    <button class="terminals-task-select" data-id="${this._esc(t.id)}" aria-label="Open ${this._esc(t.title || this._label(t.executor_id))}">
                    <span class="terminals-task-card-head">
                      <span class="terminals-task-title-row">${window.TaskAvatar ? TaskAvatar.html({ id: t.id, state: state.kind, size: 34 }) : ''}<span class="terminals-task-title">${this._esc(t.title || this._label(t.executor_id))}</span></span>
                      <span class="terminals-task-state terminals-state-${state.kind}" title="${this._esc(state.detail)}"><span class="terminals-task-state-mark" aria-hidden="true">${state.mark}</span><span>${this._esc(state.label)}</span></span>
                    </span>
                    <span class="terminals-task-meta">${this._esc(this._label(t.executor_id))}</span>
                    <span class="terminals-task-activity">${this._esc(this._activityLine(t))}</span>
                    <span class="terminals-task-open">${active ? 'Attached' : 'Open task'} →</span>
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
                const task = this._tasks.find(t => t.id === b.dataset.relaunchId);
                if (!task) return;
                b.disabled = true;
                b.textContent = 'Launching…';
                try {
                    // A relaunch deliberately creates a new task/session: the old
                    // audit trail remains immutable and still attachable.
                    const fresh = await API.terminalsLaunch(task.executor_id, task.workspace, task.title || '');
                    await this._refreshTasks();
                    if (window.Sidebar?.refreshAgentTaskViews) Sidebar.refreshAgentTaskViews();
                    this._attach(fresh.id);
                } catch (e) {
                    b.disabled = false;
                    b.textContent = '↻';
                    this._banner(e.message || 'Could not relaunch task.');
                }
            };
        });
        el.querySelectorAll('[data-remove-id]').forEach(b => {
            b.onclick = async (ev) => {
                ev.stopPropagation();
                const task = this._tasks.find(t => t.id === b.dataset.removeId);
                if (!task || !window.confirm(`Remove “${task.title || this._label(task.executor_id)}” from Agent Tasks? Its audit trace will be kept.`)) return;
                b.disabled = true;
                try {
                    await API.terminalsArchive(task.id);
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
    _statusLabel(status) {
        return { starting: 'Starting', working: 'Running', blocked: 'Blocked', idle: 'Waiting', done: 'Finished', failed: 'Stopped', interrupted: 'Interrupted' }[status] || status;
    },

    // --- attached terminal ----------------------------------------------

    _attach(id) {
        if (this._attached === id && this._ws && this._ws.readyState <= WebSocket.OPEN) return;
        this._detach();
        const body = document.getElementById('terminals-attached-body');
        if (!body) return;
        this._attached = id;
        sessionStorage.setItem('sv-agent-task-id', id);
        if (window.Sidebar?.setActive) Sidebar.setActive('terminals');
        document.querySelector('.terminals-page')?.classList.add('is-focused');
        this._attachedAt = Date.now();
        this._renderTaskList();
        this._renderAttachedHead();
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
        document.querySelector('.terminals-page')?.classList.remove('is-focused');
    },

    _banner(text) {
        const b = document.getElementById('terminals-banner');
        if (!b) return;
        b.textContent = text;
        b.hidden = false;
    },

    _renderAttachedHead() {
        const head = document.getElementById('terminals-attached-head');
        if (!head) return;
        const t = this._tasks.find(x => x.id === this._attached);
        if (!t) { head.innerHTML = '<span class="terminals-empty">Pick a task to attach, or launch one.</span>'; return; }
        const elapsed = this._elapsed(t.created_at, t.ended_at);
        const running = ['starting', 'working', 'blocked', 'idle'].includes(t.status);
        const headState = this._taskState(t);
        head.innerHTML = `
          ${window.TaskAvatar ? TaskAvatar.html({ id: t.id, state: headState.kind, size: 28, label: headState.label }) : ''}
          <span class="terminals-head-item terminals-head-title">${this._esc(t.title || this._label(t.executor_id))}</span>
          <span class="terminals-head-item">${this._esc(this._label(t.executor_id))}</span>
          <span class="terminals-head-item" title="${this._esc(t.workspace)}">${this._esc(this._shortPath(t.workspace))}</span>
          <span class="terminals-head-item terminals-head-status">${this._esc(t.status)}</span>
          <span class="terminals-head-item">${this._esc(elapsed)}</span>
          <span class="terminals-head-spacer"></span>
          <button class="btn btn-sm" id="terminals-all-tasks-btn">All tasks</button>
          ${running ? '<button class="btn btn-sm" id="terminals-stop-btn">Stop</button>' : ''}`;
        const allTasksBtn = head.querySelector('#terminals-all-tasks-btn');
        if (allTasksBtn) allTasksBtn.onclick = () => {
            sessionStorage.removeItem('sv-agent-task-id');
            this._detach();
            const attachedBody = document.getElementById('terminals-attached-body');
            if (attachedBody) attachedBody.innerHTML = '';
            if (window.Sidebar?.setActive) Sidebar.setActive('terminals');
            this._renderAttachedHead();
            this._renderTaskList();
        };
        const stop = head.querySelector('#terminals-stop-btn');
        if (stop) stop.onclick = async () => {
            try {
                await API.terminalsStop(t.id);
                await this._refreshTasks();
            } catch (e) { this._banner(e.message); }
        };
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
        if (!id) {
            vEl.innerHTML = '<span class="terminals-empty">No task attached.</span>';
            aEl.innerHTML = '<span class="terminals-empty">Nothing waiting.</span>';
            if (tEl) tEl.innerHTML = '<span class="terminals-empty">No task attached.</span>';
            this._tracesCache = null;
            setCount('terminals-verdicts-count', 0);
            setCount('terminals-traces-count', 0);
            setCount('terminals-approvals-count', 0);
            if (attention) attention.hidden = true;
            if (summary) summary.textContent = 'Attach a task to inspect its trace';
            return;
        }
        try {
            const v = await API.terminalsVerdicts(id);
            if (this._attached !== id) return;
            const items = v.items || [];
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
            }).join('') : '<span class="terminals-empty">No verdicts yet.</span>';
            setCount('terminals-verdicts-count', items.length);
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
                          <span class="terminals-trace-top"><span class="terminals-trace-id">trace ${this._esc(shortId)}</span><span class="terminals-trace-risk terminals-trace-risk-${risk}">${this._esc(riskLabel)}</span></span>
                          <span class="terminals-trace-meta">${this._esc(metaParts.join(' · '))}</span>
                        </span>
                        <button type="button" class="terminals-trace-open" data-trace-id="${this._esc(r.trace_id)}">Details</button>
                      </div>`;
                    }).join('') : '<span class="terminals-empty">No traces yet.</span>');
                    setCount('terminals-traces-count', fetchFailed ? 0 : traceRuns.length);
                    if (!fetchFailed) {
                        tEl.querySelectorAll('.terminals-trace-open').forEach(b => {
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
                `${items.length} verdict${items.length === 1 ? '' : 's'}`,
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
        }
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
        const hint = container.querySelector('#terminals-executor-hint');
        const submit = container.querySelector('#terminals-launch button[type="submit"]');
        if (!sel) return;
        sel.innerHTML = this._executors.map(e => {
            const ok = this._launchable(e);
            const suffix = ok ? '' : (e.installed === false ? ' (not installed)' : ' (Guard not enabled)');
            return `<option value="${this._esc(e.id)}"${ok ? '' : ' disabled'}>${this._esc(e.label + suffix)}</option>`;
        }).join('');
        const first = this._executors.find(e => this._launchable(e));
        if (first) sel.value = first.id;
        if (submit) submit.disabled = !first;
        const show = () => {
            const cur = this._executors.find(e => e.id === sel.value);
            const text = cur ? (cur.hint || '') : (first ? '' : 'No harness is ready to launch. Install one and enable its Guard plugin in Integrations.');
            if (hint) { hint.textContent = text; hint.hidden = !text; }
        };
        sel.onchange = show;
        show();
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
