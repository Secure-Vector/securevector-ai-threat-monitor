// Agent Detection & Response: one page for the loop that runs on this device.
//   Detect      sessions whose drift or setup state needs a look
//   Harden      agent setup changes waiting for approval
//   Respond     response steps taken (shadow until a mode is enforced)
//   Pre-flight  check_policy answers, and the denials they avoided
// Counts stay neutral; colour is used only for security state (drift band,
// setup change state, response mode word).

// A deep link like /detection-response?session=<task id> loses its query when
// the router rewrites the URL, so read it once while the script loads.
const _drInitialFocus = (() => {
    try { return new URLSearchParams(window.location.search).get('session'); } catch (e) { return null; }
})();

const DetectionResponsePage = {
    DOCS_URL: 'https://docs.securevector.io/agent-detection-response',
    LOOP_SEEN_KEY: 'sv-dr-loop-seen',
    STATS_KEY: 'sv-dr-stats',
    CLOUD_DISMISS_KEY: 'sv-dr-cloud-dismissed',
    CLOUD_DISMISS_DAYS: 30,
    FLEET_URL: 'https://app.securevector.io',
    focusSession: null,
    _data: null,
    _rungs: null,
    _gen: 0,
    _cloud: null,

    LOOP: [
        { verb: 'Detect', text: 'Each session is scored against your own recent sessions, and the ones that look unusual are listed for review.' },
        { verb: 'Harden', text: 'Changes to agent config, MCP servers, hooks and rules wait for your approval before they count as trusted.' },
        { verb: 'Respond', text: 'Response steps start in shadow: they record what they would do before anything is enforced.' },
        { verb: 'Pre-flight', text: 'Agents can ask whether a tool call is allowed before trying it, so a denial costs nothing.' },
    ],

    _esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },

    _num(n) {
        return Number.isFinite(n) ? n.toLocaleString() : '0';
    },

    _ago(iso, now) {
        const t = Date.parse(iso || '');
        if (!Number.isFinite(t)) return '';
        const mins = Math.max(0, Math.round(((now || Date.now()) - t) / 60000));
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins} min ago`;
        const h = Math.round(mins / 60);
        if (h < 48) return `${h} h ago`;
        return `${Math.round(h / 24)} days ago`;
    },

    // --- tiles --------------------------------------------------------------

    _tile(verb, label, value, sub, extra) {
        return `<section class="dr-tile" aria-label="${this._esc(verb + ': ' + label)}">
            <div class="dr-tile-verb">${this._esc(verb)}</div>
            <div class="dr-tile-label">${this._esc(label)}</div>
            <div class="dr-tile-value">${value}</div>
            ${sub ? `<div class="dr-tile-sub">${sub}</div>` : ''}
            ${extra || ''}
        </section>`;
    },

    _detectTile(d) {
        d = d || {};
        const b = d.baseline || {};
        const needed = b.needed || 5;
        const n = d.to_review || 0;
        if (b.state === 'building' && !n) {
            const have = Math.min(b.ended_sessions || 0, needed);
            return this._tile('Detect', 'Sessions to review', '<span class="dr-tile-state">Building baseline</span>',
                `${this._esc(have)} of ${this._esc(needed)} sessions`,
                '<a href="/terminals" class="dr-link" data-dr-launch>Launch a session</a>');
        }
        const sub = b.state === 'partial'
            ? 'partial baseline'
            : `in the last ${this._esc((this._data && this._data.window_days) || 7)} days`;
        const normal = d.marked_normal ? ` · ${this._esc(d.marked_normal)} marked normal` : '';
        return this._tile('Detect', 'Sessions to review', this._esc(this._num(n)), sub + normal);
    },

    _hardenTile(h) {
        h = h || {};
        if (!h.available) return this._tile('Harden', 'Setup changes', '<span class="dr-tile-state">Not checked</span>', 'The setup scan did not answer');
        const n = h.changes || 0;
        let sub;
        if (!h.harnesses) sub = 'No agent setup found on this device';
        else if (!n) sub = `Matches what you approved, ${this._esc(h.harnesses)} ${h.harnesses === 1 ? 'harness' : 'harnesses'}`;
        else sub = `waiting for approval across ${this._esc(h.harnesses)} ${h.harnesses === 1 ? 'harness' : 'harnesses'}`;
        return this._tile('Harden', 'Setup changes', this._esc(this._num(n)), sub);
    },

    _respondTile(r) {
        // The response modes route may not exist yet on this install: that
        // reads as shadow, never as a failure.
        if (!r || typeof r !== 'object') {
            return this._tile('Respond', 'Steps taken', '<span class="dr-tile-state">Shadow</span>', 'watching, nothing enforced');
        }
        const taken = [r.steps_taken, r.taken, r.count].find(x => Number.isFinite(x));
        const mode = String(r.mode || r.global_mode || 'shadow').toLowerCase();
        const word = mode.charAt(0).toUpperCase() + mode.slice(1);
        const cls = mode === 'shadow' ? '' : ' is-active';
        const sub = mode === 'shadow' ? 'watching, nothing enforced' : `mode: <span class="dr-rung${cls}">${this._esc(word)}</span>`;
        return this._tile('Respond', 'Steps taken', Number.isFinite(taken) ? this._esc(this._num(taken))
            : `<span class="dr-tile-state dr-rung${cls}">${this._esc(word)}</span>`, sub);
    },

    _preflightTile(p) {
        p = p || {};
        const n = p.checked || 0;
        if (!n && p.registered === false) {
            return this._tile('Pre-flight', 'Checks answered', '<span class="dr-tile-state">0</span>', 'MCP tools not registered',
                '<a href="/guide-connect-agents" class="dr-link" data-dr-nav="guide-connect-agents">Register the MCP tools</a>');
        }
        const avoided = p.avoided_denials || 0;
        return this._tile('Pre-flight', 'Checks answered', this._esc(this._num(n)),
            `${this._esc(this._num(avoided))} ${avoided === 1 ? 'denial' : 'denials'} avoided`);
    },

    _skeletonHtml() {
        const t = [['Detect', 'Sessions to review'], ['Harden', 'Setup changes'], ['Respond', 'Steps taken'], ['Pre-flight', 'Checks answered']]
            .map(([v, l]) => this._tile(v, l, '<span class="dr-tile-state dr-muted">…</span>', '')).join('');
        return `<div class="dr-tiles is-loading" aria-busy="true">${t}</div>`;
    },

    _tilesHtml(data, rungs) {
        data = data || {};
        return `<div class="dr-tiles">${this._detectTile(data.detect)}${this._hardenTile(data.harden)}${this._respondTile(rungs)}${this._preflightTile(data.preflight)}</div>`;
    },

    // --- review list --------------------------------------------------------

    _bandHtml(row) {
        if (typeof row.score !== 'number' || !row.band) return '<span class="dr-row-drift">no score</span>';
        const band = ['calm', 'watch', 'high'].includes(row.band) ? row.band : 'calm';
        const partial = row.status === 'partial' ? ' <span class="dr-row-partial">(partial baseline)</span>' : '';
        return `<span class="dr-row-drift">drift <span class="dr-band is-${band}">${this._esc(row.score)}, ${band}</span>${partial}</span>`;
    },

    _setupHtml(row) {
        if (row.setup_state === 'changed') return `<span class="dr-setup is-red">setup changed (${this._esc(row.setup_changes || 0)})</span>`;
        if (row.setup_state === 'new') return '<span class="dr-setup is-amber">setup not approved</span>';
        if (row.setup_state === 'pinned') return '<span class="dr-setup">setup pinned</span>';
        return '<span class="dr-setup">setup not checked</span>';
    },

    _rowHtml(row, focused) {
        const id = this._esc(row.task_id);
        const canNormal = row.ended && typeof row.score === 'number';
        const canApprove = !!row.setup_harness && (row.setup_state === 'changed' || row.setup_state === 'new');
        const who = row.harness_label || row.harness || 'Session';
        return `<li class="dr-row${focused ? ' is-focused' : ''}" data-dr-row="${id}">
            <button type="button" class="dr-row-open" data-dr-open="${id}" aria-label="Open the session summary for ${this._esc(who)} in ${this._esc(row.folder || 'this folder')}">
              <span class="dr-row-head"><strong>${this._esc(who)}</strong><span class="dr-row-folder">${this._esc(row.folder || 'unknown folder')}</span><span class="dr-row-when">${this._esc(this._ago(row.at))}</span></span>
              <span class="dr-row-facts">${this._bandHtml(row)}<span class="dr-sep" aria-hidden="true"> · </span>${this._setupHtml(row)}</span>
              <span class="dr-row-reason">${this._esc(row.reason || '')}</span>
            </button>
            <div class="dr-row-actions" data-dr-actions="${id}">
              ${canNormal ? `<button type="button" class="btn btn-sm" data-dr-normal="${id}">Looks normal</button>` : ''}
              ${canApprove ? `<button type="button" class="btn btn-sm" data-dr-approve="${id}">Approve this setup</button>` : ''}
            </div>
        </li>`;
    },

    _listHtml(data, focus) {
        const rows = (data && data.sessions) || [];
        if (!rows.length) {
            const ago = this._ago(data && data.detect && data.detect.last_scored_at);
            const tail = ago ? ` Last scored ${this._esc(ago)}.` : '';
            const note = focus ? '<p class="dr-muted">That session is not on the review list.</p>' : '';
            return `<div class="dr-empty"><strong>No sessions need review.</strong><span>${tail.trim()}</span></div>${note}`;
        }
        const missing = focus && !rows.some(r => r.task_id === focus)
            ? '<p class="dr-muted">That session is not on the review list.</p>' : '';
        return `${missing}<ul class="dr-list">${rows.map(r => this._rowHtml(r, r.task_id === focus)).join('')}</ul>`;
    },

    // --- loop card ----------------------------------------------------------

    _loopOpen() {
        try { return localStorage.getItem(this.LOOP_SEEN_KEY) !== '1'; } catch (e) { return true; }
    },

    _loopHtml(open) {
        const items = this.LOOP.map(s => `<li><strong>${this._esc(s.verb)}</strong><span>${this._esc(s.text)}</span></li>`).join('');
        return `<details class="dr-loop"${open ? ' open' : ''}>
            <summary>How the loop works</summary>
            <ol class="dr-loop-list">${items}</ol>
            <a class="dr-link" href="${this.DOCS_URL}" target="_blank" rel="noopener noreferrer">Read the Agent Detection &amp; Response docs</a>
        </details>`;
    },

    // --- local engagement counters ------------------------------------------
    // Kept in this browser only, per ISO week. Nothing here is sent anywhere.

    _isoWeek(d) {
        const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        const day = t.getUTCDay() || 7;
        t.setUTCDate(t.getUTCDate() + 4 - day);
        const y = t.getUTCFullYear();
        const wk = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
        return `${y}-W${String(wk).padStart(2, '0')}`;
    },

    _readStats() {
        try {
            const v = JSON.parse(localStorage.getItem(this.STATS_KEY) || '{}');
            return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
        } catch (e) { return {}; }
    },

    _weekStats() {
        const w = this._readStats()[this._isoWeek(new Date())];
        return (w && typeof w === 'object') ? w : {};
    },

    _bump(name) {
        try {
            const all = this._readStats();
            const wk = this._isoWeek(new Date());
            const cur = all[wk] && typeof all[wk] === 'object' ? all[wk] : {};
            cur[name] = (Number(cur[name]) || 0) + 1;
            all[wk] = cur;
            const keep = {};
            Object.keys(all).sort().slice(-8).forEach(k => { keep[k] = all[k]; });
            localStorage.setItem(this.STATS_KEY, JSON.stringify(keep));
        } catch (e) { /* storage unavailable: counters are optional */ }
    },

    _since(iso1, iso2) {
        const a = Date.parse(iso1 || ''), b = Date.parse(iso2 || '');
        if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '';
        const h = Math.round((b - a) / 3600000);
        return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
    },

    /** Counts-only text: no folder, path or session id ever enters it. */
    _statsText(data) {
        const d = (data && data.detect) || {};
        const w = this._weekStats();
        const n = (k) => Number(w[k]) || 0;
        const toReview = Number(d.to_review) || 0;
        const reviewed = n('normal') + n('approvals');
        const lines = [
            `Agent Detection & Response stats, week ${this._isoWeek(new Date())}`,
            `Page opens: ${n('opens')}`,
            `Sessions to review: ${toReview}`,
            `Reviewed: ${reviewed} of ${Math.max(toReview, reviewed)}`,
            `Setup approvals: ${n('approvals')}`,
            `False-flag rate (${(data && data.window_days) || 7} days): ${Number(d.marked_normal) || 0} of ${Number(d.flagged) || 0}`,
            `Pre-flight Register clicks: ${n('register')}`,
            `Cloud row: shown ${n('cloudShown')}, dismissed ${n('cloudDismissed')}, clicked ${n('cloudClicked')}`,
        ];
        const gap = this._since(d.first_task_at, d.first_scored_at);
        if (gap) lines.push(`Install to first scored session: ${gap}`);
        return lines.join('\n');
    },

    async _copyStats() {
        const text = this._statsText(this._data);
        let ok = false;
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); ok = true; }
        } catch (e) { ok = false; }
        if (!ok) {
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.setAttribute('readonly', '');
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                ok = !!document.execCommand('copy');
                ta.remove();
            } catch (e) { ok = false; }
        }
        if (window.Toast) { if (ok) Toast.success('Stats copied'); else Toast.error('Could not copy stats'); }
    },

    // --- across your devices ------------------------------------------------

    _fleetDismissed() {
        try {
            const t = Number(localStorage.getItem(this.CLOUD_DISMISS_KEY));
            return Number.isFinite(t) && t > 0 && Date.now() - t < this.CLOUD_DISMISS_DAYS * 86400000;
        } catch (e) { return false; }
    },

    _fleetDue(data, cloud) {
        if (!data) return false;
        const b = (data.detect && data.detect.baseline) || {};
        const scored = !!b.state && b.state !== 'building';
        const changes = !!(data.harden && data.harden.changes > 0);
        if (!scored && !changes) return false;
        const enrolled = !!(cloud && cloud.credentials_configured);
        return enrolled || !this._fleetDismissed();
    },

    _fleetHtml(cloud) {
        const enrolled = !!(cloud && cloud.credentials_configured);
        if (enrolled) {
            return `<section class="dr-fleet" aria-labelledby="dr-fleet-h" data-dr-fleet="enrolled">
                <h3 id="dr-fleet-h">Across your devices</h3>
                <p class="dr-muted">Drift, setup changes and response activity across every device you enrolled.</p>
                <div class="dr-fleet-actions"><a class="btn btn-sm" href="${this.FLEET_URL}" target="_blank" rel="noopener noreferrer" data-dr-fleet-open>Open fleet view</a></div>
            </section>`;
        }
        return `<section class="dr-fleet" aria-labelledby="dr-fleet-h" data-dr-fleet="community">
            <h3 id="dr-fleet-h">Across your devices</h3>
            <p class="dr-muted">Pro shows drift, setup changes and response activity across every device you enrol. 30-day trial.</p>
            <div class="dr-fleet-actions">
              <button type="button" class="btn btn-sm" data-dr-fleet-open>See the fleet view</button>
              <a class="btn btn-sm" href="${this.DOCS_URL}" target="_blank" rel="noopener noreferrer">How it works</a>
              <button type="button" class="dr-fleet-dismiss" data-dr-fleet-dismiss aria-label="Hide this row for 30 days">Dismiss</button>
            </div>
        </section>`;
    },

    _bindFleet(slot) {
        const open = slot.querySelector('[data-dr-fleet-open]');
        const community = slot.querySelector('[data-dr-fleet="community"]');
        if (open) open.onclick = (ev) => {
            this._bump('cloudClicked');
            if (!community) return;
            ev.preventDefault();
            if (window.Header && Header.showCloudConnectGuide) Header.showCloudConnectGuide();
            else window.open(this.FLEET_URL, '_blank', 'noopener');
        };
        const dismiss = slot.querySelector('[data-dr-fleet-dismiss]');
        if (dismiss) dismiss.onclick = () => {
            try { localStorage.setItem(this.CLOUD_DISMISS_KEY, String(Date.now())); } catch (e) { /* storage unavailable */ }
            this._bump('cloudDismissed');
            slot.innerHTML = '';
        };
    },

    _renderFleet(container) {
        const slot = container.querySelector('[data-dr-cloud]');
        if (!slot) return;
        if (!this._fleetDue(this._data, this._cloud)) { slot.innerHTML = ''; return; }
        slot.innerHTML = this._fleetHtml(this._cloud);
        this._bump('cloudShown');
        this._bindFleet(slot);
    },

    // --- actions ------------------------------------------------------------

    _openSession(taskId) {
        if (!taskId) return;
        try { sessionStorage.setItem('sv-agent-task-id', taskId); } catch (e) { /* storage unavailable */ }
        if (window.Sidebar && Sidebar.navigate) Sidebar.navigate('terminals');
        else if (window.App) App.loadPage('terminals');
    },

    async _markNormal(btn, row) {
        btn.disabled = true;
        try {
            await API.terminalsDriftFeedback(row.task_id);
            this._bump('normal');
            btn.outerHTML = '<span class="dr-done">Marked normal</span>';
        } catch (e) {
            btn.disabled = false;
            btn.textContent = 'Could not save, try again';
        }
    },

    APPROVE_SCROLL_AT: 8,

    _countsText(c) {
        if (window.ConfigTrust && ConfigTrust._countsLine) return ConfigTrust._countsLine(c);
        if (!c) return '';
        return `${c.mcp_servers || 0} MCP servers · ${c.hooks || 0} hooks · ${c.rules || 0} rules files`;
    },

    /** What one Approve would pin, read fresh: the harness setup (user
     *  scope) and the session's folder, each listed with all of its changes
     *  and risks. The folder path comes from the task read, never from the
     *  summary payload. */
    async _approveTargets(row) {
        const out = [];
        const status = await API.configTrustStatus(true);
        const view = ((status && status.harnesses) || []).find(v => v.harness === row.setup_harness);
        if (view && ['new', 'changed'].includes(view.state) && view.view_hash) {
            out.push({
                kind: 'setup', state: view.state, title: `${view.label || row.harness_label || row.setup_harness} setup`,
                items: (view.changes || []).map(c => ({ severity: c.severity, text: c.text }))
                    .concat((view.risks || []).map(r => ({ severity: r.severity, text: r.text }))),
                counts: view.counts, truncated: 0,
                body: { harness: row.setup_harness, target: 'setup', key: null, workspace: null, expected: view.view_hash },
            });
        }
        let workspace = null;
        try {
            const task = await API.terminalsTask(row.task_id);
            workspace = task && typeof task.workspace === 'string' ? task.workspace : null;
        } catch (e) { workspace = null; }
        if (workspace && API.configTrustRepoCheck) {
            try {
                const v = await API.configTrustRepoCheck(row.setup_harness, workspace);
                if (v && ['new', 'changed'].includes(v.state) && v.view_hash) {
                    const items = (v.reasons || []).map(r => ({ severity: r.severity, text: r.text }));
                    out.push({
                        kind: 'folder', state: v.state, title: `This folder: ${v.workspace_name || row.folder || 'unknown'}`,
                        items, counts: v.counts, truncated: Math.max(0, (v.reasons_total || 0) - items.length),
                        body: { harness: row.setup_harness, target: 'setup', key: null, workspace, expected: v.view_hash },
                    });
                }
            } catch (e) { /* folder gone: the harness setup still lists */ }
        }
        // Never offer an Approve with nothing to show for it.
        return out.filter(t => t.items.length || this._countsText(t.counts));
    },

    /** One target in the approve panel: its state, every change and risk
     *  (scrollable past APPROVE_SCROLL_AT), or what is being pinned when a
     *  new setup has no changes, and its own Approve button. */
    _targetHtml(t, i) {
        const ct = window.ConfigTrust;
        const sev = (v) => (ct && ct._sev ? ct._sev(v) : (v === 'red' ? 'is-red' : v === 'amber' ? 'is-amber' : 'is-neutral'));
        const stateWord = t.state === 'changed' ? 'Changed' : 'Not approved yet';
        const stateCls = t.state === 'changed' ? 'is-red' : 'is-amber';
        const scroll = t.items.length > this.APPROVE_SCROLL_AT ? ' is-scroll' : '';
        const list = t.items.length
            ? `<ul class="ct-risks dr-approve-list${scroll}">${t.items.map(x => `<li class="${sev(x.severity)}"><span class="ct-dot" aria-hidden="true"></span>${this._esc(x.text)}</li>`).join('')}</ul>`
            : `<p class="dr-muted">Pins the current setup: ${this._esc(this._countsText(t.counts))}.</p>`;
        const label = t.kind === 'folder' ? 'Approve this folder' : 'Approve this setup';
        // A folder check returns its top reasons only. When some are not
        // shown, approving here would pin changes nobody saw.
        const action = t.truncated
            ? `<p class="dr-muted">${this._esc(t.truncated)} more not shown here. Review the full list in the folder check when you launch in this folder from <a href="/terminals" class="dr-link" data-dr-nav="terminals">Agent Sessions</a>.</p>`
            : `<button type="button" class="btn btn-sm btn-primary" data-dr-confirm="${i}">${label}</button>`;
        return `<div class="dr-approve-target" data-dr-target="${i}">
            <div class="dr-approve-head"><strong>${this._esc(t.title)}</strong><span class="ct-state ${stateCls}">${stateWord}</span></div>
            ${list}${action}
        </div>`;
    },

    async _askApprove(btn, row, host) {
        btn.disabled = true;
        btn.textContent = 'Reading setup…';
        let targets;
        try { targets = await this._approveTargets(row); } catch (e) { targets = null; }
        const actions = host.querySelector(`[data-dr-actions="${CSS.escape(row.task_id)}"]`);
        if (!actions) return;
        if (!targets) { btn.disabled = false; btn.textContent = 'Could not read setup, try again'; return; }
        if (!targets.length) { btn.outerHTML = '<span class="dr-done">Setup already approved</span>'; return; }
        const panel = document.createElement('div');
        panel.className = 'dr-confirm';
        panel.innerHTML = targets.map((t, i) => this._targetHtml(t, i)).join('')
            + '<div class="dr-confirm-actions"><button type="button" class="btn btn-sm" data-dr-cancel>Close</button></div>';
        btn.hidden = true;
        actions.appendChild(panel);
        const left = new Set(targets.map((t, i) => i).filter(i => !targets[i].truncated));
        panel.querySelector('[data-dr-cancel]').onclick = () => {
            panel.remove(); btn.hidden = false; btn.disabled = false; btn.textContent = 'Approve this setup';
        };
        panel.querySelectorAll('[data-dr-nav]').forEach(a => {
            a.onclick = (ev) => { ev.preventDefault(); if (window.Sidebar && Sidebar.navigate) Sidebar.navigate(a.dataset.drNav); };
        });
        panel.querySelectorAll('[data-dr-confirm]').forEach(b => {
            b.onclick = async () => {
                const i = Number(b.dataset.drConfirm);
                b.disabled = true;
                try {
                    await API.configTrustApprove(targets[i].body);
                    this._bump('approvals');
                    b.outerHTML = '<span class="dr-done">Approved</span>';
                    left.delete(i);
                    if (!left.size) this.render(document.getElementById('page-content'), true);
                } catch (e) {
                    b.outerHTML = '<span class="dr-done">The setup changed after it was shown. Close and open again to see the current changes.</span>';
                }
            };
        });
    },

    _bind(host) {
        const rows = (this._data && this._data.sessions) || [];
        const byId = (id) => rows.find(r => r.task_id === id);
        host.querySelectorAll('[data-dr-open]').forEach(b => { b.onclick = () => this._openSession(b.dataset.drOpen); });
        host.querySelectorAll('[data-dr-normal]').forEach(b => {
            b.onclick = (ev) => { ev.stopPropagation(); const r = byId(b.dataset.drNormal); if (r) this._markNormal(b, r); };
        });
        host.querySelectorAll('[data-dr-approve]').forEach(b => {
            b.onclick = (ev) => { ev.stopPropagation(); const r = byId(b.dataset.drApprove); if (r) this._askApprove(b, r, host); };
        });
        host.querySelectorAll('[data-dr-launch]').forEach(a => {
            a.onclick = (ev) => {
                ev.preventDefault();
                try { sessionStorage.setItem('sv-agent-tasks-board', '1'); } catch (e) { /* storage unavailable */ }
                if (window.Sidebar && Sidebar.navigate) Sidebar.navigate('terminals');
            };
        });
        host.querySelectorAll('[data-dr-nav]').forEach(a => {
            a.onclick = (ev) => {
                ev.preventDefault();
                if (a.dataset.drNav === 'guide-connect-agents') this._bump('register');
                if (window.Sidebar && Sidebar.navigate) Sidebar.navigate(a.dataset.drNav);
            };
        });
        const copy = host.querySelector('[data-dr-copy-stats]');
        if (copy) copy.onclick = () => this._copyStats();
        const loop = host.querySelector('.dr-loop');
        if (loop) {
            try { localStorage.setItem(this.LOOP_SEEN_KEY, '1'); } catch (e) { /* storage unavailable */ }
        }
    },

    /** Open this page with one session highlighted (the element links on
     *  Agent Sessions call this). */
    openFor(taskId) {
        this.focusSession = taskId || null;
        if (window.Sidebar && Sidebar.navigate) Sidebar.navigate('detection-response');
        else if (window.App) App.loadPage('detection-response');
    },

    async render(container, refresh) {
        if (!container) return;
        if (!refresh) this._bump('opens');
        try { localStorage.setItem('sv-dr-page-opened', '1'); } catch (e) { /* storage unavailable */ }
        const gen = ++this._gen;
        const focus = this.focusSession || _drInitialFocus || null;
        this.focusSession = null;
        const loopOpen = this._loopOpen();
        container.innerHTML = `<div class="dr-wrap">
            <div data-dr-tiles>${this._skeletonHtml()}</div>
            <section class="dr-card" aria-labelledby="dr-review-h">
              <div class="dr-card-head"><h3 id="dr-review-h">Sessions to review</h3><span class="dr-muted">Newest first. Open a row for its session summary.</span></div>
              <div data-dr-list><p class="dr-muted">Loading sessions…</p></div>
            </section>
            ${this._loopHtml(loopOpen)}
            <div data-dr-cloud></div>
            <div class="dr-footer"><button type="button" class="dr-copy-stats" data-dr-copy-stats>Copy stats</button></div>
        </div>`;
        const soft = (f) => { try { return Promise.resolve(f()).catch(() => null); } catch (e) { return Promise.resolve(null); } };
        const [data, rungs, cloud] = await Promise.all([
            soft(() => API.detectionResponseSummary()),
            API.terminalsRungModes ? soft(() => API.terminalsRungModes()) : null,
            API.getCloudSettings ? soft(() => API.getCloudSettings()) : null,
        ]);
        if (gen !== this._gen || !container.isConnected) return;
        this._data = data;
        this._rungs = rungs;
        this._cloud = cloud;
        const tiles = container.querySelector('[data-dr-tiles]');
        const list = container.querySelector('[data-dr-list]');
        if (!data) {
            tiles.innerHTML = this._tilesHtml(null, rungs);
            list.innerHTML = '<p class="dr-muted">Could not read sessions. Try again in a moment.</p>';
            this._bind(container);
            return;
        }
        tiles.innerHTML = this._tilesHtml(data, rungs);
        list.innerHTML = this._listHtml(data, focus);
        this._bind(container);
        this._renderFleet(container);
        const hit = focus ? container.querySelector(`[data-dr-row="${CSS.escape(focus)}"]`) : null;
        if (hit && hit.scrollIntoView) hit.scrollIntoView({ block: 'center' });
    },
};

window.DetectionResponsePage = DetectionResponsePage;
