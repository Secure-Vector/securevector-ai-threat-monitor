/**
 * Observability > Health: run health findings across runs in a window.
 *
 * Loops, failing steps and waste, grouped by category with counts at the
 * top. Each row names the run, the agent, what happened and when, and opens
 * the run on the Runs view with its steps and findings shown. Findings come
 * from GET /api/run-health, the same single pass as the runs list: the
 * tool-call checks for every run, the full checks for runs already opened.
 *
 * Colour means security state only: rows are neutral, a Failing count may
 * be amber. Every server string is escaped, attributes included.
 */
const RunHealthPage = {
    windowDays: 7,
    data: null,
    GROUPS: [
        { key: 'loop', label: 'Loop' },
        { key: 'failing', label: 'Failing' },
        { key: 'wasteful', label: 'Wasteful' },
    ],

    esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },

    /** "5 min ago", "3 h ago", "2 d ago"; '' for no time. */
    ago(ts, now) {
        const t = window.TraceSteps ? TraceSteps.time(ts) : Date.parse(ts);
        if (t == null || !Number.isFinite(t)) return '';
        const s = Math.max(0, Math.round(((now || Date.now()) - t) / 1000));
        if (s < 60) return 'just now';
        if (s < 3600) return `${Math.floor(s / 60)} min ago`;
        if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
        return `${Math.floor(s / 86400)} d ago`;
    },

    /** A run's display name: its Map name, else a short trace id. */
    runLabel(f) {
        const nm = window.ObsTabs && ObsTabs.agentName ? ObsTabs.agentName(f.trace_id) : null;
        return nm || `Run ${String(f.session_id || f.trace_id || '').slice(0, 8)}`;
    },

    /** The page body for a /api/run-health payload (pure; tests drive it). */
    html(data) {
        if (!data) return '<div class="ar-empty">Health findings unavailable.</div>';
        const all = (Array.isArray(data.findings) ? data.findings : []).filter(f => f && f.category !== 'blocked');
        const icon = { loop: '', failing: '', wasteful: '' };
        if (window.TraceSteps) Object.keys(icon).forEach(k => { icon[k] = TraceSteps.healthIcon(k); });
        const counts = {};
        this.GROUPS.forEach(g => { counts[g.key] = all.filter(f => f.category === g.key).length; });
        const top = `<div class="sv-health-counts">${this.GROUPS.map(g =>
            `<span class="sv-health-badge sv-health-badge-${g.key}">${icon[g.key]} ${this.esc(g.label)} ${counts[g.key]}</span>`).join('')}</div>`;
        const partial = Number(data.partial_runs) > 0
            ? `<p class="sv-health-row-sub">${Number(data.partial_runs)} run${Number(data.partial_runs) === 1 ? ' was' : 's were'} checked from tool calls only. Open a run for the full check, including failures and waste.</p>`
            : '';
        if (!all.length) {
            return `${top}<div class="ar-empty"><div style="font-size:15px;margin-bottom:6px;">No health findings in this window.</div>
              <div style="font-size:13px;">Health watches each run for the same call repeated, a sequence of calls going round, a file read again with no edit between, retries after errors, failing streaks, oversized context and runs far larger than usual.</div></div>${partial}`;
        }
        const now = Date.now();
        const groups = this.GROUPS.filter(g => counts[g.key]).map(g => {
            const rows = all.filter(f => f.category === g.key).map(f => `
              <li class="sv-health-row">
                <span class="trace-steps-finding-icon" aria-hidden="true">${icon[g.key]}</span>
                <span class="sv-health-row-main">
                  <span class="sv-health-row-title">${this.esc(f.title)}</span>
                  <span class="sv-health-row-sub">${this.esc([this.runLabel(f), f.runtime_kind, this.ago(f.ended_at, now)].filter(Boolean).join(' · '))}</span>
                </span>
                <button type="button" class="sv-health-open" data-trace-id="${this.esc(f.trace_id)}">Open run</button>
              </li>`).join('');
            return `<h3 class="sv-health-group-title">${this.esc(g.label)} (${counts[g.key]})</h3><ul class="sv-health-list">${rows}</ul>`;
        }).join('');
        return top + partial + groups;
    },

    /** Open a run on the Runs view with its steps and findings shown. */
    openRun(traceId) {
        if (window.AgentRunsPage) {
            AgentRunsPage._pendingTrace = traceId;
            AgentRunsPage._pendingHealthOpen = true;
        }
        if (window.Sidebar && Sidebar.navigate) Sidebar.navigate('agent-runs');
        else if (window.App) App.loadPage('agent-runs');
    },

    async render(container) {
        container.textContent = '';
        this._warmed = false;
        if (window.Header) {
            Header.setPageInfo('Observability: Health', 'Loops, failing steps and waste in agent runs, each linked to the step it happened on.');
        }
        const header = document.createElement('div');
        header.className = 'obs-header';
        if (window.ObsTabs) ObsTabs.render(header, 'health');
        const bar = document.createElement('div');
        bar.className = 'filters-bar';
        const grp = document.createElement('div');
        grp.className = 'filter-group';
        const lbl = document.createElement('label');
        lbl.textContent = 'Window';
        grp.appendChild(lbl);
        const sel = document.createElement('select');
        sel.className = 'filter-select';
        [['1', '24h'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days']].forEach(([v, t]) => {
            const o = document.createElement('option');
            o.value = v; o.textContent = t;
            if (Number(v) === this.windowDays) o.selected = true;
            sel.appendChild(o);
        });
        sel.addEventListener('change', () => { this.windowDays = Number(sel.value); this.load(); });
        grp.appendChild(sel);
        bar.appendChild(grp);
        header.appendChild(bar);
        container.appendChild(header);
        const body = document.createElement('div');
        body.id = 'run-health-body';
        body.innerHTML = '<div class="ar-empty">Loading health findings…</div>';
        container.appendChild(body);
        await this.load();
    },

    async load() {
        const body = document.getElementById('run-health-body');
        if (!body) return;
        this.data = await API.getRunHealth({ window_days: this.windowDays, limit: 200 });
        // Runs checked from tool calls only (just after a restart, say): ask
        // for one on-demand warm-up of the recent ones, then show that.
        if (this.data && Number(this.data.partial_runs) > 0 && !this._warmed) {
            this._warmed = true;
            body.innerHTML = this.html(this.data);
            const warmed = await API.getRunHealth({ window_days: this.windowDays, limit: 200, warm: true });
            if (warmed && document.getElementById('run-health-body') === body) this.data = warmed;
        }
        body.innerHTML = this.html(this.data);
        body.querySelectorAll('button.sv-health-open').forEach(b => {
            b.addEventListener('click', () => this.openRun(b.dataset.traceId));
        });
    },
};
if (typeof window !== 'undefined') window.RunHealthPage = RunHealthPage;
