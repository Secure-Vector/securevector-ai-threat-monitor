// Agent Detection & Response: one page for the agent checks that run on this device.
// Kept simple on purpose (owner, 2026-10-14): what it is for (the header
// subtitle plus the highest score this week), how to read it (Sessions to
// review) and how to fix it (the row actions). Everything else sits in one
// closed Details disclosure:
//   Why this score          the full spotlight, its signals and trend chart
//   Automatic actions       steps taken (test mode until a mode is switched on)
//   Permission checks       check_policy answers, and the denials they avoided
//   Across your devices     the fleet row
//   Config changes          agent config changes waiting for approval
//   How it works            the short loop and the docs link
// Counts stay neutral; colour is used only for security state.

// A deep link like /detection-response?session=<task id> loses its query when
// the router rewrites the URL, so read it once while the script loads.
const _drInitialFocus = (() => {
    try { return new URLSearchParams(window.location.search).get('session'); } catch (e) { return null; }
})();

const DetectionResponsePage = {
    DOCS_URL: 'https://docs.securevector.io/agent-detection-response',
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
        { verb: 'Unusual activity', text: 'Each session is compared with your own recent sessions, and the ones that look unusual are listed for review.' },
        { verb: 'Config changes', text: 'Changes to agent config, MCP servers, hooks and rules wait for your approval before they count as trusted.' },
        { verb: 'Automatic actions', text: 'Automatic actions start in test mode: they log what they would do before anything is enforced.' },
        { verb: 'Permission checks', text: 'Agents can ask whether a tool call is allowed before trying it, so a refusal costs nothing.' },
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

    _tile(label, value, sub, extra, id) {
        return `<section class="dr-tile"${id ? ` id="${this._esc(id)}"` : ''} aria-label="${this._esc(label)}">
            <div class="dr-tile-label">${this._esc(label)}</div>
            <div class="dr-tile-value">${value}</div>
            ${sub ? `<div class="dr-tile-sub">${sub}</div>` : ''}
            ${extra || ''}
        </section>`;
    },

    _detectTile(d) {
        d = d || {};
        const b = d.baseline || {};
        const n = d.to_review || 0;
        if (b.state === 'building' && !n) {
            return this._tile('Unusual sessions', this._esc(this._num(n)),
                'A score appears after the first tool calls',
                '<a href="/terminals" class="dr-link" data-dr-launch>Launch a session</a>');
        }
        const sub = b.state === 'partial'
            ? 'comparison still settling'
            : `in the last ${this._esc((this._data && this._data.window_days) || 7)} days`;
        const normal = d.marked_normal ? ` · ${this._esc(d.marked_normal)} marked normal` : '';
        return this._tile('Unusual sessions', this._esc(this._num(n)), sub + normal);
    },

    _hardenTile(h) {
        h = h || {};
        if (!h.available) return this._tile('Config changes to review', '<span class="dr-tile-state">Not checked</span>', 'The config scan did not answer');
        const n = h.changes || 0;
        let sub;
        if (!h.harnesses) sub = 'No agent config found on this device';
        else if (!n) sub = `Matches what you approved, ${this._esc(h.harnesses)} ${h.harnesses === 1 ? 'agent tool' : 'agent tools'}`;
        else sub = `waiting for approval across ${this._esc(h.harnesses)} ${h.harnesses === 1 ? 'agent tool' : 'agent tools'}`;
        return this._tile('Config changes to review', this._esc(this._num(n)), sub);
    },

    _respondTile(r) {
        // The response modes route may not exist yet on this install: that
        // reads as test mode, never as a failure. `taken` counts real holds
        // (On mode) and `would_have` counts what test mode would have held,
        // both over the last 7 days.
        const o = r && typeof r === 'object' ? r : {};
        const num = (v) => (Number.isFinite(v) ? v : 0);
        const anyOn = Array.isArray(o.modes)
            ? o.modes.some(m => m && String(m.mode).toLowerCase() === 'active')
            : String(o.mode || o.global_mode || 'shadow').toLowerCase() !== 'shadow';
        const taken = num([o.steps_taken, o.taken, o.count].find(x => Number.isFinite(x)));
        const would = num(o.would_have);
        let shown; let cap;
        if (anyOn) {
            shown = taken;
            cap = taken > 0 ? `${this._esc(this._num(taken))} held` : `<span class="dr-rung is-active">on</span>`;
            if (would > 0) cap = `${taken > 0 ? `${this._esc(this._num(taken))} held` : 'none held'}, would have held ${this._esc(this._num(would))} (test mode)`;
        } else {
            shown = would;
            cap = would > 0 ? `would have held ${this._esc(this._num(would))} (test mode)` : 'nothing enforced (test mode)';
        }
        return this._tile('Automatic actions', this._esc(this._num(shown)), cap, '', 'dr-sec-actions');
    },

    _preflightTile(p) {
        p = p || {};
        const n = p.checked || 0;
        if (!n && p.registered === false) {
            return this._tile('Permission checks', '<span class="dr-tile-state">0</span>', 'MCP tools not registered',
                '<a href="/guide-connect-agents" class="dr-link" data-dr-nav="guide-connect-agents">Register the MCP tools</a>', 'dr-sec-checks');
        }
        const avoided = p.avoided_denials || 0;
        return this._tile('Permission checks', this._esc(this._num(n)),
            `${this._esc(this._num(n))} ${n === 1 ? 'check' : 'checks'} \u00b7 ${this._esc(this._num(avoided))} denied before ${avoided === 1 ? 'it' : 'they'} ran`, '', 'dr-sec-checks');
    },

    _skeletonHtml() {
        const t = ['Unusual sessions', 'Config changes to review', 'Automatic actions', 'Permission checks']
            .map((l) => this._tile(l, '<span class="dr-tile-state dr-muted">…</span>', '', '',
                { 'Automatic actions': 'dr-sec-actions', 'Permission checks': 'dr-sec-checks' }[l])).join('');
        return `<div class="dr-tiles is-loading" aria-busy="true">${t}</div>`;
    },

    _tilesHtml(data, rungs) {
        data = data || {};
        return `<div class="dr-tiles">${this._detectTile(data.detect)}${this._hardenTile(data.harden)}${this._respondTile(rungs)}${this._preflightTile(data.preflight)}</div>`;
    },

    /** Config changes waiting for approval, as their own short section. */
    _configHtml(data) {
        const h = (data && data.harden) || {};
        const n = h.changes || 0;
        const body = !h.available ? 'The config scan did not answer.'
            : n ? `${this._esc(this._num(n))} agent config ${n === 1 ? 'change is' : 'changes are'} waiting for approval. Approve them from the sessions above, or open <a href="/guide-connect-agents" class="dr-link" data-dr-nav="guide-connect-agents">Connect Agents</a>.`
            : 'No agent config changes to review.';
        const bulk = h.available && n > 0
            ? `<div class="dr-bulk"><button type="button" class="btn btn-sm" data-dr-bulk>Approve all ${this._esc(this._num(n))} config ${n === 1 ? 'change' : 'changes'}</button><div data-dr-bulk-panel></div></div>` : '';
        return `<p class="dr-muted dr-config-caption">${body}</p>${bulk}`;
    },

    // --- spotlight ------------------------------------------------------------

    BAND_RANGE: { high: 'High \u00b7 70 and above', watch: 'Worth a look \u00b7 40 to 69', calm: 'Low \u00b7 below 40' },

    _hhmm(iso) {
        const t = new Date(iso || '');
        if (!Number.isFinite(t.getTime())) return '';
        return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    },

    _bandWord(b) { return b === 'high' ? 'high' : b === 'watch' ? 'worth a look' : 'low'; },

    _bandOf(b) { return b === 'high' || b === 'watch' ? b : 'calm'; },

    /** The plain sentence for one feature, from its stored counts. */
    _featureSentence(f) {
        const c = f.counts || {};
        const n = (v) => Number(v) || 0;
        const times = (v) => `${n(v)} ${n(v) === 1 ? 'time' : 'times'}`;
        switch (f.id) {
            case 'tool_novelty': return `Used ${n(c.unseen_tools)} ${n(c.unseen_tools) === 1 ? 'tool' : 'tools'} it had never used here before.`;
            case 'errors_after_block': return `Hit ${n(c.errors)} ${n(c.errors) === 1 ? 'error' : 'errors'} right after a blocked call.`;
            case 'enumeration': return n(c.loop_calls) > 0 ? `Repeated the same call ${n(c.loop_calls)} times.` : `Called ${n(c.distinct_hosts)} different hosts in one session.`;
            case 'secrets_reach': return `Reached credential locations ${times(c.locations)}.`;
            case 'new_hosts': return `Called ${n(c.hosts)} ${n(c.hosts) === 1 ? 'host' : 'hosts'} new for this folder.`;
            case 'persistence': return `Kept asking after a denial ${times(c.repeats)}.`;
            default: return f.label ? String(f.label).charAt(0).toUpperCase() + String(f.label).slice(1) + '.' : '';
        }
    },

    /** Scores of this folder, oldest to newest, this session last. */
    _sparkHtml(sp, endLabel) {
        const pts = (sp.recent_scores || []).filter(r => Number.isFinite(r.score));
        if (pts.length < 2) return '';
        const W = 500, H = 80, padL = 30, padR = 8, padT = 9, padB = 10;
        const x = (i) => padL + (i * (W - padL - padR)) / (pts.length - 1);
        const y = (v) => H - padB - (Math.max(0, Math.min(100, v)) / 100) * (H - padT - padB);
        const xy = (i) => `${x(i).toFixed(1)},${y(pts[i].score).toFixed(1)}`;
        const last = pts.length - 1;
        const band = this._bandOf(sp.band);
        const base = pts.slice(0, last).map((_, i) => xy(i)).join(' ');
        const rise = `${xy(last - 1)} ${xy(last)}`;
        const fill = `${x(last - 1).toFixed(1)},${H - padB} ${rise} ${x(last).toFixed(1)},${H - padB}`;
        const normal = pts.filter(r => !r.current).length;
        const startT = this._hhmm(sp.started_at);
        const axis = [0, 40, 70, 100].map(v => `<g class="dr-spark-tick"><line class="dr-spark-grid" x1="${padL}" x2="${W - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${padL - 6}" y="${(y(v) + 3).toFixed(1)}" text-anchor="end">${v}</text></g>`).join('');
        const pointLabels = pts.map((p, i) => {
            if (p.current) return `<li>Current session: score ${this._esc(p.score)}</li>`;
            const time = this._hhmm(p.at || p.computed_at || p.timestamp);
            const label = time ? `Session ${i + 1} at ${time}` : `Session ${i + 1}`;
            return `<li>${this._esc(label)}: score ${this._esc(p.score)}</li>`;
        }).join('');
        return `<div class="dr-spark is-${band}">
            <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Recent session scores on a scale from 0 to 100, oldest to newest" preserveAspectRatio="xMidYMid meet">
              ${axis}
              ${pts.length > 2 ? `<polyline class="dr-spark-base" fill="none" points="${base}"/>` : ''}
              <polygon class="dr-spark-fill" points="${fill}"/>
              <polyline class="dr-spark-rise" fill="none" points="${rise}"/>
              <circle class="dr-spark-dot" cx="${x(last).toFixed(1)}" cy="${y(pts[last].score).toFixed(1)}" r="3.5"/>
            </svg>
            <ol class="dr-spark-a11y">${pointLabels}</ol>
            <div class="dr-spark-x"><span>${this._esc(normal)} ${normal === 1 ? 'session' : 'sessions'} of normal</span>${startT ? `<span>${this._esc(startT)}</span>` : ''}<span>${this._esc(endLabel || 'now')}</span></div>
            <div class="dr-spark-last">${this._esc(pts[last].score)}</div>
        </div>`;
    },

    /** The honest pending-work line: sessions to review and config changes. */
    _pendingLine(data) {
        if (!data) return '';
        // One count everywhere: the server's sessions to review (watch or
        // high, rung 2 or above, or a red config change). Config changes to
        // approve are a breakdown, not a second count of sessions.
        const n = Math.max(0, Number(data.detect && data.detect.to_review) || 0);
        const m = Number(data.harden && data.harden.changes) || 0;
        const parts = [];
        if (n) parts.push(`${n} ${n === 1 ? 'session needs' : 'sessions need'} a look.`);
        if (m) parts.push(`${m} config ${m === 1 ? 'change' : 'changes'} to approve.`);
        if (!parts.length) return '';
        return `<p class="dr-spot-pending">${this._esc(parts.join(' '))}</p>`;
    },

    // --- getting started -----------------------------------------------------

    START_NOTE: 'Then it fills in on its own: launching from here registers the policy check tools, you are asked once to approve the agent\'s config, a score appears after the first tool calls and settles as more sessions finish, and automatic actions stay in test mode until you turn them on.',

    /** Two first steps with done marks, then one plain paragraph. Full list
     *  until a session is scored (it is the empty state); after that one
     *  muted line while a step is still open, and nothing once both are done. */
    _startHtml(data, expanded) {
        const st = data && data.setup;
        if (!st) return '';
        const steps = [
            { done: st.guard_installed === true, text: 'Connect the Guard for your agent tool',
              link: '<a href="/guide-connect-agents" class="dr-link" data-dr-start-connect>Connect Agents</a>' },
            { done: st.governed_session === true, text: 'Launch a session from this app',
              link: '<a href="/terminals" class="dr-link" data-dr-start-launch>Launch</a>' },
        ];
        const done = steps.filter(x => x.done).length;
        if (st.scored && done === steps.length) return '';
        if (st.scored && !expanded) {
            return `<p class="dr-muted dr-start-line">Set up: ${done} of ${steps.length} done \u00b7 <a href="#" class="dr-link" data-dr-start-show>Show</a></p>`;
        }
        const rows = steps.map(x => `<li class="dr-start-row${x.done ? ' is-done' : ''}">
              <span class="dr-start-mark" aria-hidden="true">${x.done ? '\u2713' : ''}</span>
              <span class="dr-start-text">${this._esc(x.text)}</span>
              <span class="dr-start-state">${x.done ? 'Done' : 'Not yet'}</span>
              ${x.link}</li>`).join('');
        const b = st.baseline;
        const progress = st.governed_session && !st.scored && b && b.folder
            ? `<p class="dr-muted dr-start-progress">${this._esc(`${b.sessions} session${b.sessions === 1 ? '' : 's'} finished in ${b.folder}${b.harness_label ? ` with ${b.harness_label}` : ''}`)}</p>` : '';
        return `<section class="dr-card dr-start" aria-labelledby="dr-start-h">
            <div class="dr-card-head"><h3 id="dr-start-h">Getting started</h3><span class="dr-muted">${this._esc(`${done} of ${steps.length} done`)}</span></div>
            <ol class="dr-start-list">${rows}</ol>
            ${progress}
            <p class="dr-muted dr-start-note">${this._esc(this.START_NOTE)}</p>
        </section>`;
    },

    _bindStart(host, data) {
        if (!host || !host.querySelector) return;
        const show = host.querySelector('[data-dr-start-show]');
        if (show) show.onclick = (ev) => { ev.preventDefault(); host.innerHTML = this._startHtml(data, true); this._bindStart(host, data); };
        const connect = host.querySelector('[data-dr-start-connect]');
        if (connect) connect.onclick = (ev) => { ev.preventDefault(); if (window.Sidebar && Sidebar.navigate) Sidebar.navigate('guide-connect-agents'); };
        const launch = host.querySelector('[data-dr-start-launch]');
        if (launch) launch.onclick = (ev) => {
            ev.preventDefault();
            // Opens the board with the launch form open.
            if (window.TerminalsPage && !TerminalsPage._launchDraft) TerminalsPage._launchDraft = { executor: '', workspace: '', title: '', session: '' };
            try { sessionStorage.setItem('sv-agent-tasks-board', '1'); } catch (e) { /* storage unavailable */ }
            if (window.Sidebar && Sidebar.navigate) Sidebar.navigate('terminals');
        };
    },

    /** "Compared with N earlier sessions" or the first-session line, plus
     *  "comparison still settling" while the comparison is not fully trusted. */
    _compareText(sessions, confidence) {
        const n = Number(sessions) || 0;
        const base = n > 0 ? `Compared with ${n} earlier session${n === 1 ? '' : 's'}` : 'First session here, nothing to compare with yet';
        const c = Number(confidence);
        return n > 0 && Number.isFinite(c) && c < 1 ? `${base}, comparison still settling` : base;
    },

    /** The top of the page: the highest score this week with its band word,
     *  the one top reason and the compare line. Nothing else; the full
     *  spotlight sits under Details. */
    /** The label over the top score. The spotlight is the highest score
     *  still to review; with nothing to review it is the highest score this
     *  week among sessions not marked normal, and says so when any were. */
    _topLabel(data) {
        const sp = data && data.spotlight;
        if (sp && sp.to_review !== false) return 'Highest score to review';
        const normal = Number(data && data.detect && data.detect.marked_normal) || 0;
        return normal > 0 ? 'Highest score this week, not counting sessions marked normal' : 'Highest score this week';
    },

    _hasNumericScore(value) {
        return value !== null && value !== '' && Number.isFinite(Number(value));
    },

    /** Highest numeric score in the listed sessions, for honest no-spotlight states. */
    _highestListedScore(data) {
        const sessions = (data && Array.isArray(data.sessions) ? data.sessions : [])
            .filter(s => s && this._hasNumericScore(s.score));
        if (!sessions.length) return null;
        const session = sessions.reduce((best, current) => Number(current.score) > Number(best.score) ? current : best);
        const score = Number(session.score);
        const band = score >= 70 ? 'high' : score >= 40 ? 'watch' : 'calm';
        return { score, band };
    },

    _topHtml(data) {
        if (!data) return '';
        const sp = data.spotlight;
        if (!sp || !this._hasNumericScore(sp.score)) {
            const listed = this._highestListedScore(data);
            if (listed) {
                const { score, band } = listed;
                return `<section class="dr-top" aria-label="Highest listed session score">
                    <div class="dr-caps">Highest listed session score</div>
                    <div class="dr-top-line"><span class="dr-top-score is-${band}">${this._esc(score)}</span><span class="dr-band dr-top-band is-${band}">${this._esc(this._bandWord(band))}</span></div>
                    <p class="dr-muted dr-top-compare">There is not enough same-folder history to show a trend yet.</p>
                </section>`;
            }
            return '<section class="dr-top is-empty" aria-label="Highest score this week" data-dr-top-empty><p class="dr-top-empty">No score yet. A score appears after the first tool calls.</p></section>';
        }
        const band = this._bandOf(sp.band);
        const f = (sp.features || [])[0];
        const reason = f ? this._featureSentence(f) : 'No signal stood out.';
        const plotted = (sp.recent_scores || []).filter(r => !r.current && Number.isFinite(r.score)).length;
        const n = plotted || Number(sp.baseline && sp.baseline.sessions) || 0;
        const cmp = this._compareText(n, sp.baseline && sp.baseline.confidence) + '.';
        return `<section class="dr-top" aria-label="Highest score this week">
            <div class="dr-caps" data-dr-top-label>${this._esc(this._topLabel(data))}</div>
            <div class="dr-top-line"><span class="dr-top-score is-${band}" data-dr-top-score>${this._esc(sp.score)}</span><span class="dr-band dr-top-band is-${band}" data-dr-top-band>${this._esc(this._bandWord(band))}</span></div>
            <p class="dr-top-reason" data-dr-top-reason>${this._esc(reason)}</p>
            <p class="dr-muted dr-top-compare" data-dr-top-compare>${this._esc(cmp)}</p>
        </section>`;
    },

    _spotlightHtml(data) {
        const sp = data && data.spotlight;
        const pending = this._pendingLine(data);
        if (!sp || !this._hasNumericScore(sp.score)) {
            if (!data) return '';
            const listed = this._highestListedScore(data);
            if (listed) {
                return `<section class="dr-spot dr-spot-empty" aria-label="Spotlight">${pending}
                    <h2 class="dr-spot-h">Highest listed session: <span class="dr-top-score is-${listed.band}">${this._esc(listed.score)}</span>, ${this._esc(this._bandWord(listed.band))}.</h2>
                    <p class="dr-spot-sub">There is not enough same-folder history to show a trend yet.</p>
                </section>`;
            }
            return `<section class="dr-spot dr-spot-empty" aria-label="Spotlight">${pending}
                <h2 class="dr-spot-h">No scored sessions yet.</h2>
                <p class="dr-spot-sub">A score appears after the first tool calls.</p>
            </section>`;
        }
        const band = this._bandOf(sp.band);
        const when = this._hhmm(sp.crossed_at || sp.computed_at);
        const who = sp.harness_label || 'This agent tool';
        const where = sp.folder ? ` in ${sp.folder}` : '';
        const plotted = (sp.recent_scores || []).filter(r => !r.current && Number.isFinite(r.score)).length;
        const n = plotted || Number(sp.baseline && sp.baseline.sessions) || 0;
        // One N for the chart and the subline (the sessions plotted).
        const cmp = this._compareText(n, sp.baseline && sp.baseline.confidence) + '.';
        const sub = (when ? `Scored at ${when}. ` : '') + cmp
            + (sp.had_blocks === false && sp.to_review !== false ? ' No rule had to fire.' : '');
        const median = sp.baseline && Number.isFinite(sp.baseline.median) ? Math.round(sp.baseline.median) : null;
        const why = (sp.features || []).slice(0, 5).map(f => `<li class="dr-why-row">
            <span class="dr-why-pts">+${this._esc(f.points)}</span>
            <span class="dr-why-text"><span>${this._esc(this._featureSentence(f))}</span>
            <span class="dr-muted">${this._esc([f.signal, f.detail].filter(Boolean).join(' \u00b7 '))}</span></span></li>`).join('');
        return `<section class="dr-spot" aria-label="Spotlight">
            ${pending}
            <h2 class="dr-spot-h">${this._esc(sp.to_review === false ? `${this._topLabel(data)}: ${sp.score}, ${this._bandWord(sp.band)}. ${who}${where}.` : `${who}${where} stopped behaving like itself.`)}</h2>
            <p class="dr-spot-sub">${this._esc(sub)}</p>
            <div class="dr-spot-cards">
              <div class="dr-spot-card">
                <div class="dr-caps">Score</div>
                <div class="dr-spot-score is-${band}">${this._esc(sp.score)}</div>
                <span class="dr-spot-chip is-${band}">${this._esc(this.BAND_RANGE[band])}</span>
                ${median !== null ? `<p class="dr-muted">Typical score for this folder over ${this._esc(n)} sessions: ${this._esc(median)}.</p>` : ''}
                <p class="dr-muted">Same agent tool. Same folder. Same permissions.</p>
                ${this._sparkHtml(sp, when || (sp.ended_at ? this._hhmm(sp.ended_at) : 'now'))}
              </div>
              <div class="dr-spot-card">
                <div class="dr-caps">Why</div>
                <p class="dr-muted">Top contributing signals, in the order they mattered.</p>
                ${why ? `<ul class="dr-why">${why}</ul>` : '<p class="dr-muted">No signal stood out.</p>'}
              </div>
            </div>
            <p class="dr-muted dr-spot-trust">Scored on this device from its own history. Nothing leaves your machine.</p>
        </section>`;
    },

    // --- review list --------------------------------------------------------

    _bandHtml(row) {
        if (typeof row.score !== 'number' || !row.band) {
            return `<span class="dr-row-drift">${row.status === 'building_baseline' ? 'no score yet, a score appears after the first tool calls' : 'no score'}</span>`;
        }
        const band = ['calm', 'watch', 'high'].includes(row.band) ? row.band : 'calm';
        const partial = row.status === 'partial' ? ' <span class="dr-row-partial">(comparison still settling)</span>' : '';
        return `<span class="dr-row-drift" title="Score ${this._esc(row.score)} of 100. Compared with this agent's earlier sessions in this folder."><span class="dr-row-score">${this._esc(row.score)}</span> <span class="dr-band is-${band}">${this._bandWord(band)}</span>${partial}</span>`;
    },

    /** A config mark only when the session's agent config changed or was
     *  never approved; an approved or unchecked config adds nothing. */
    _setupHtml(row) {
        if (row.setup_state === 'changed') return `<span class="dr-setup is-amber">Agent config changed (${this._esc(row.setup_changes || 0)})</span>`;
        if (row.setup_state === 'new') return '<span class="dr-setup is-amber">Agent config not reviewed yet</span>';
        return '';
    },

    /** Backend change text in plain words; paths shrink to the file name. */
    _plainReason(text, harness) {
        let m;
        text = String(text || '');
        if ((m = /^Mod (.+?) changed \(manifest or files\)\.?$/.exec(text))) return m[1] === 'settings' ? `${harness || 'Agent'} settings changed.` : `The ${m[1]} plugin changed.`;
        if ((m = /^New mod (.+?), not approved yet\.?$/.exec(text))) return `New ${m[1]} plugin, not approved yet.`;
        if ((m = /^(.+?) changed in (\S+?)\.$/.exec(text))) {
            const word = m[1] === 'Mod settings' ? `${harness || 'Agent'} settings` : m[1];
            return `${word} changed (${m[2]}).`;
        }
        return text;
    },

    _reasonHtml(row) {
        const texts = (row.setup_texts || []).map(t => this._plainReason(t, row.harness_label));
        const isSetup = texts.length > 1 && (row.setup_texts || [])[0] === row.reason;
        if (!isSetup) return this._esc(this._plainReason(row.reason, row.harness_label));
        const rest = texts.slice(1);
        return `${this._esc(texts[0].replace(/\.$/, ''))}<button type="button" class="dr-more" data-dr-more aria-expanded="false">, +${rest.length} more</button><ul class="dr-more-list" hidden>${rest.map(t => `<li>${this._esc(t)}</li>`).join('')}</ul>`;
    },

    /** One row: who and where, when, the score with its band word, a config
     *  mark when the config changed, the one reason, and the fixes: the row
     *  itself opens the session, then Looks normal and Review config change. */
    _rowHtml(row, focused) {
        const id = this._esc(row.task_id);
        const canNormal = row.ended && typeof row.score === 'number';
        const canApprove = !!row.setup_harness && (row.setup_state === 'changed' || row.setup_state === 'new');
        const who = row.harness_label || row.harness || 'Session';
        const setup = this._setupHtml(row);
        return `<li class="dr-row${focused ? ' is-focused' : ''}" data-dr-row="${id}">
            <button type="button" class="dr-row-open" data-dr-open="${id}" aria-label="Open the session summary for ${this._esc(who)} in ${this._esc(row.folder || 'this folder')}">
              <span class="dr-row-head"><strong>${this._esc(who)}</strong><span class="dr-row-folder" title="${this._esc(row.folder || '')}">${this._esc(row.folder || 'unknown folder')}</span><span class="dr-row-when">${this._esc(this._ago(row.at))}</span></span>
              <span class="dr-row-facts">${this._bandHtml(row)}${setup ? `<span class="dr-sep" aria-hidden="true"> · </span>${setup}` : ''}</span>
              <span class="dr-row-reason">${this._reasonHtml(row)}</span>
            </button>
            <div class="dr-row-actions" data-dr-actions="${id}">
              <div class="dr-act">${canNormal ? `<button type="button" class="btn btn-sm btn-secondary" data-dr-normal="${id}">Looks normal</button><span class="dr-act-cap">Hide from this list and count it as normal for future scores</span>` : ''}</div>
              <div class="dr-act">${canApprove ? `<button type="button" class="btn btn-sm" data-dr-approve="${id}">Review config change</button>` : ''}</div>
            </div>
        </li>`;
    },

    _listHtml(data, focus) {
        // Every session to review is listed, the top one included: the
        // fixes live on the rows.
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

    // --- details ------------------------------------------------------------

    /** One closed disclosure at the bottom, in this order: why this score,
     *  automatic actions, permission checks, across your devices, config
     *  changes, how it works. The rail's deep links open it. */
    _detailsHtml() {
        return `<details class="dr-loop dr-details" id="dr-sec-details">
            <summary>Details</summary>
            <div class="dr-details-body">
              <div data-dr-spot id="dr-sec-why"></div>
              <div data-dr-tiles>${this._skeletonHtml()}</div>
              <div data-dr-cloud id="dr-sec-fleet"></div>
              <div data-dr-config id="dr-sec-config"></div>
              ${this._loopHtml(false)}
              <div class="dr-footer"><button type="button" class="dr-copy-stats" data-dr-copy-stats>Copy stats</button></div>
            </div>
        </details>`;
    },

    // --- loop card ----------------------------------------------------------

    _loopHtml(open) {
        const items = this.LOOP.map(s => `<li><strong>${this._esc(s.verb)}</strong><span>${this._esc(s.text)}</span></li>`).join('');
        return `<details class="dr-loop" id="dr-sec-how"${open ? ' open' : ''}>
            <summary>How it works</summary>
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
            `Review stats, week ${this._isoWeek(new Date())}`,
            `Page opens: ${n('opens')}`,
            `Sessions to review: ${toReview}`,
            `Reviewed: ${reviewed} of ${Math.max(toReview, reviewed)}`,
            `Config approvals: ${n('approvals')}`,
            `False-flag rate (${(data && data.window_days) || 7} days): ${Number(d.marked_normal) || 0} of ${Number(d.flagged) || 0}`,
            `Permission checks Register clicks: ${n('register')}`,
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
                <p class="dr-muted">See unusual sessions and config changes from every device in one list.</p>
                <div class="dr-fleet-actions"><a class="btn btn-sm" href="${this.FLEET_URL}" target="_blank" rel="noopener noreferrer" data-dr-fleet-open>Open fleet view</a></div>
            </section>`;
        }
        return `<section class="dr-fleet" aria-labelledby="dr-fleet-h" data-dr-fleet="community">
            <h3 id="dr-fleet-h">Across your devices</h3>
            <p class="dr-muted">See unusual sessions and config changes from every device in one list.</p>
            <div class="dr-fleet-actions">
              <button type="button" class="btn btn-sm" data-dr-fleet-open>Preview fleet view (30-day trial)</button>
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
            if (window.Sidebar && Sidebar._drHideEmpty) Sidebar._drHideEmpty();
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

    UNDO_MS: 6000,

    async _markNormal(btn, row) {
        // Nothing is posted for 6 seconds, so Undo is a plain cancel.
        const cap = btn.nextElementSibling && btn.nextElementSibling.classList && btn.nextElementSibling.classList.contains('dr-act-cap') ? btn.nextElementSibling : null;
        const box = document.createElement('span');
        box.className = 'dr-done';
        box.innerHTML = 'Marked normal \u00b7 <a href="#" class="dr-link" data-dr-undo>Undo</a>';
        const holder = btn.parentNode;
        btn.hidden = true;
        if (cap) cap.hidden = true;
        holder.appendChild(box);
        let undone = false;
        const undo = box.querySelector('[data-dr-undo]');
        const timer = setTimeout(async () => {
            if (undone) return;
            try {
                await API.terminalsDriftFeedback(row.task_id);
                this._bump('normal');
                box.textContent = 'Marked normal';
            } catch (e) {
                box.remove(); btn.hidden = false; if (cap) cap.hidden = false;
                btn.textContent = 'Could not save, try again';
            }
        }, this.UNDO_MS);
        if (undo) undo.onclick = (ev) => {
            ev.preventDefault(); undone = true; clearTimeout(timer);
            box.remove(); btn.hidden = false; if (cap) cap.hidden = false;
        };
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
                kind: 'setup', state: view.state, title: `${view.label || row.harness_label || row.setup_harness} config`,
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
            : `<p class="dr-muted">Trusts the current config: ${this._esc(this._countsText(t.counts))}.</p>`;
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
        btn.textContent = 'Reading config…';
        let targets;
        try { targets = await this._approveTargets(row); } catch (e) { targets = null; }
        const actions = host.querySelector(`[data-dr-actions="${CSS.escape(row.task_id)}"]`);
        if (!actions) return;
        if (!targets) { btn.disabled = false; btn.textContent = 'Could not read config, try again'; return; }
        if (!targets.length) { btn.outerHTML = '<span class="dr-done">Config already approved</span>'; return; }
        const panel = document.createElement('div');
        panel.className = 'dr-confirm';
        panel.innerHTML = targets.map((t, i) => this._targetHtml(t, i)).join('')
            + '<p class="dr-muted dr-approve-note">Approving trusts these files until they change again.</p>'
            + '<div class="dr-confirm-actions"><button type="button" class="btn btn-sm" data-dr-cancel>Close</button></div>';
        btn.hidden = true;
        actions.appendChild(panel);
        const left = new Set(targets.map((t, i) => i).filter(i => !targets[i].truncated));
        panel.querySelector('[data-dr-cancel]').onclick = () => {
            panel.remove(); btn.hidden = false; btn.disabled = false; btn.textContent = 'Review config change';
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
                    if (/Not confirmed/i.test(String(e && e.message))) { b.disabled = false; return; }
                    b.outerHTML = '<span class="dr-done">The config changed after it was shown. Close and open again to see the current changes.</span>';
                }
            };
        });
    },

    /** What a bulk approve would trust: one entry per agent tool whose config
     *  is new or changed, read fresh from the status route. */
    async _bulkTargets() {
        const status = await API.configTrustStatus(true);
        return ((status && status.harnesses) || [])
            .filter(v => ['new', 'changed'].includes(v.state) && v.view_hash)
            .map(v => ({
                label: v.label || v.harness, changes: (v.changes || []).length || 1,
                body: { harness: v.harness, target: 'setup', key: null, workspace: null, expected: v.view_hash },
            }));
    },

    /** Nothing is trusted until the person confirms here. The approvals go
     *  through the same UI-token call as the single Approve button. */
    async _askBulk(btn, host) {
        const panel = host.querySelector('[data-dr-bulk-panel]');
        if (!panel) return;
        btn.disabled = true;
        let targets;
        try { targets = await this._bulkTargets(); } catch (e) { targets = null; }
        btn.disabled = false;
        if (!targets) { panel.innerHTML = '<span class="dr-done">Could not read config, try again.</span>'; return; }
        if (!targets.length) { panel.innerHTML = '<span class="dr-done">Config already approved.</span>'; return; }
        // One source for the total: the same live count the button shows.
        const total = Number(this._data && this._data.harden && this._data.harden.changes) || targets.reduce((a, t) => a + t.changes, 0);
        const lines = targets.map(t => `<li>${this._esc(t.label)}: ${this._esc(t.changes)} ${t.changes === 1 ? 'change' : 'changes'}</li>`).join('');
        panel.innerHTML = `<div class="dr-confirm"><p>These ${this._esc(total)} config ${total === 1 ? 'change' : 'changes'} will be trusted from now on:</p><ul class="dr-approve-list">${lines}</ul>
            <div class="dr-confirm-actions"><button type="button" class="btn btn-sm" data-dr-bulk-yes>Approve all</button><button type="button" class="btn btn-sm" data-dr-bulk-no>Cancel</button></div></div>`;
        btn.hidden = true;
        panel.querySelector('[data-dr-bulk-no]').onclick = () => { panel.innerHTML = ''; btn.hidden = false; };
        const yes = panel.querySelector('[data-dr-bulk-yes]');
        yes.onclick = async () => {
            yes.disabled = true;
            try {
                // One call: the person confirms the whole batch once.
                await API.configTrustApproveAll(targets.map(t => t.body));
                this._bump('approvals');
                panel.innerHTML = `<span class="dr-done">Approved ${this._esc(total)} config ${total === 1 ? 'change' : 'changes'}.</span>`;
            } catch (e) {
                panel.innerHTML = /Not confirmed/i.test(String(e && e.message))
                    ? '<span class="dr-done">Not confirmed</span>'
                    : '<span class="dr-done">The config changed after it was shown. Reload and try again.</span>';
                btn.hidden = false;
            }
        };
    },

    _bind(host) {
        const bulkBtn = host.querySelector('[data-dr-bulk]');
        if (bulkBtn) bulkBtn.onclick = () => this._askBulk(bulkBtn, host);
        const rows = (this._data && this._data.sessions) || [];
        const byId = (id) => rows.find(r => r.task_id === id);
        host.querySelectorAll('[data-dr-open]').forEach(b => { b.onclick = () => this._openSession(b.dataset.drOpen); });
        host.querySelectorAll('[data-dr-more]').forEach(m => {
            m.onclick = (ev) => {
                ev.stopPropagation(); if (ev.preventDefault) ev.preventDefault();
                const l = m.nextElementSibling;
                if (l) { l.hidden = !l.hidden; m.setAttribute('aria-expanded', l.hidden ? 'false' : 'true'); }
            };
        });
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
        container.innerHTML = `<div class="dr-wrap">
            <div data-dr-start id="dr-sec-start"></div>
            <div data-dr-top></div>
            <div id="dr-sec-sessions">
            <section class="dr-card" aria-labelledby="dr-review-h">
              <div class="dr-card-head"><h3 id="dr-review-h">Sessions to review</h3><span class="dr-muted">Newest first. A higher score means less like earlier sessions.</span></div>
              <div data-dr-list><p class="dr-muted">Loading sessions…</p></div>
            </section>
            </div>
            ${this._detailsHtml()}
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
        const cfg = container.querySelector('[data-dr-config]');
        const spotEl = container.querySelector('[data-dr-spot]');
        const topEl = container.querySelector('[data-dr-top]');
        if (!data) {
            tiles.innerHTML = this._tilesHtml(null, rungs);
            list.innerHTML = '<p class="dr-muted">Could not read sessions. Try again in a moment.</p>';
            this._bind(container);
            this._sectionsReady();
            return;
        }
        tiles.innerHTML = this._tilesHtml(data, rungs);
        list.innerHTML = this._listHtml(data, focus);
        if (cfg) cfg.innerHTML = this._configHtml(data);
        if (spotEl) spotEl.innerHTML = this._spotlightHtml(data);
        if (topEl) topEl.innerHTML = this._topHtml(data);
        const startEl = container.querySelector('[data-dr-start]');
        if (startEl) { startEl.innerHTML = this._startHtml(data); this._bindStart(startEl, data); }
        this._bind(container);
        this._renderFleet(container);
        const hit = focus ? container.querySelector(`[data-dr-row="${CSS.escape(focus)}"]`) : null;
        if (hit && hit.scrollIntoView) hit.scrollIntoView({ block: 'center' });
        this._sectionsReady();
    },

    /** Sections are filled in: the panel scrolls to a section it was asked
     *  for and lights the one in view. */
    _sectionsReady() {
        if (window.Sidebar && Sidebar.drPageReady) Sidebar.drPageReady();
    },
};

window.DetectionResponsePage = DetectionResponsePage;
