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
    _taskQuery: '',
    _gen: 0,

    async render(container) {
        const gen = ++this._gen;
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
                <section><h3>Recent verdicts</h3><div id="terminals-verdicts" class="terminals-verdicts"><span class="terminals-empty">No task attached.</span></div></section>
                <section><h3>Approval inbox</h3><div id="terminals-approvals" class="terminals-approvals"><span class="terminals-empty">Nothing waiting.</span></div></section>
              </div>
            </details>
            </div>
          </div>`;

        this._bindLaunchForm(container);
        container.querySelector('#terminals-task-search').oninput = (ev) => {
            this._taskQuery = ev.target.value.trim().toLowerCase();
            this._renderTaskList();
        };
        try {
            const ex = await API.terminalsExecutors();
            if (gen !== this._gen) return;
            this._executors = ex.items || [];
            const sel = container.querySelector('#terminals-executor');
            if (sel) sel.innerHTML = this._executors.map(e => `<option value="${this._esc(e.id)}">${this._esc(e.label)}</option>`).join('');
        } catch (e) {
            console.warn('Terminals: executors unavailable', e);
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
        try {
            const r = await API.terminalsTasks();
            this._tasks = r.items || [];
            this._error = null;
        } catch (e) {
            this._error = e.message;
        }
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
        this._renderTaskList();
        this._renderAttachedHead();
        const requested = sessionStorage.getItem('sv-agent-task-id');
        if (requested && requested !== this._attached && this._tasks.some(task => task.id === requested)) {
            this._attach(requested);
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
                      <span class="terminals-task-title-row"><span class="terminals-task-title">${this._esc(t.title || this._label(t.executor_id))}</span></span>
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
        head.innerHTML = `
          <span class="terminals-head-item">${this._esc(this._label(t.executor_id))}</span>
          <span class="terminals-head-item" title="${this._esc(t.workspace)}">${this._esc(this._shortPath(t.workspace))}</span>
          <span class="terminals-head-item terminals-head-status">${this._esc(t.status)}</span>
          <span class="terminals-head-item">${this._esc(elapsed)}</span>
          <span class="terminals-head-spacer"></span>
          ${running ? '<button class="btn btn-sm" id="terminals-stop-btn">Stop</button>' : ''}`;
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
        const attention = document.getElementById('terminals-attention');
        const summary = document.getElementById('terminals-governance-summary');
        if (!vEl || !aEl) return;
        if (!id) {
            vEl.innerHTML = '<span class="terminals-empty">No task attached.</span>';
            aEl.innerHTML = '<span class="terminals-empty">Nothing waiting.</span>';
            if (attention) attention.hidden = true;
            if (summary) summary.textContent = 'Attach a task to inspect its trace';
            return;
        }
        try {
            const v = await API.terminalsVerdicts(id);
            if (this._attached !== id) return;
            const items = v.items || [];
            vEl.innerHTML = items.length ? items.map(i => `
              <div class="terminals-verdict">
                <span class="terminals-dot sv-status-${i.action === 'block' ? 'red' : (i.risk === 'amber' ? 'amber' : 'green')}"></span>
                <span class="terminals-verdict-main">
                  <span class="terminals-verdict-tool">${this._esc(i.function_name || i.tool_id)}</span>
                  <span class="terminals-verdict-reason">${this._esc(i.action)}${i.reason ? ', ' + this._esc(i.reason) : ''}</span>
                </span>
              </div>`).join('') : '<span class="terminals-empty">No verdicts yet.</span>';
            const sessionId = v.session_id;
            const jit = await API.getJitRequests('pending');
            if (this._attached !== id) return;
            const mine = (jit.items || []).filter(r => !sessionId || r.session_id === sessionId);
            if (summary) summary.textContent = `${items.length} verdict${items.length === 1 ? '' : 's'} · ${mine.length ? `${mine.length} approval waiting` : 'no approvals waiting'}`;
            if (attention) {
                attention.hidden = !mine.length;
                attention.innerHTML = mine.length
                    ? `<span><strong>Approval needed</strong> · This task is paused until you decide.</span><button class="btn btn-sm btn-primary" id="terminals-review-approval">Review</button>`
                    : '';
                const review = attention.querySelector('#terminals-review-approval');
                if (review) review.onclick = () => {
                    document.getElementById('terminals-governance').open = true;
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
        }
    },

    // --- helpers --------------------------------------------------------

    _label(executorId) {
        const e = this._executors.find(x => x.id === executorId);
        return e ? e.label : executorId;
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
    _esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
};
window.TerminalsPage = TerminalsPage;
