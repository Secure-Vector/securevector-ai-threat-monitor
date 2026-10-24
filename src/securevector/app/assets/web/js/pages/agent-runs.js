/**
 * Agent Runs — active-agent-observability #142 (the trace waterfall)
 *
 * The *time* view to the Agent Map's *topology* view: a list of agent RUNS
 * (one per runtime session) and, for the selected run, the ordered SPANS —
 * each an enforced tool call stamped with its allow / block / log_only
 * verdict. "What did this agent try to do, turn by turn, and what did we
 * stop?" — the enforcement verdict on each span is the differentiator.
 *
 * Local-first, read-only. Hand-rolled DOM + SVG icons (no emoji), themed via
 * the app's CSS variables (dark + light).
 */

// v5 color policy: runtimes are LABELS, not statuses — every runtime gets
// the same neutral dot. Color on these pages is reserved for security
// outcomes (blocked/threat red, secret/warn amber, allowed green).
const RUNTIME_NEUTRAL = '#8b949e';
const RUNTIME_COLOR = {
    'claude-code': RUNTIME_NEUTRAL, codex: RUNTIME_NEUTRAL, openclaw: RUNTIME_NEUTRAL,
    cursor: RUNTIME_NEUTRAL, 'copilot-cli': RUNTIME_NEUTRAL, opencode: RUNTIME_NEUTRAL,
    antigravity: RUNTIME_NEUTRAL,
    langchain: RUNTIME_NEUTRAL, langgraph: RUNTIME_NEUTRAL, crewai: RUNTIME_NEUTRAL,
    hermes: RUNTIME_NEUTRAL, python: RUNTIME_NEUTRAL, node: RUNTIME_NEUTRAL,
};
const OUTCOME = {
    blocked: { color: '#ef4444', label: 'BLOCKED' },
    log_only: { color: '#94a3b8', label: 'LOG' },
    allow: { color: '#10b981', label: 'ALLOW' },
};
const RISK_DOT = { red: '#ef4444', amber: '#f59e0b', green: '#10b981' };
const BAN_SVG = (c, s = 11) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" style="vertical-align:-2px"><path fill="${c}" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2c1.8 0 3.5.6 4.9 1.7L5.7 16.9A8 8 0 0 1 12 4zm0 16a8 8 0 0 1-4.9-1.7L18.3 7.1A8 8 0 0 1 12 20z"/></svg>`;
// Threat (virus) + secret (lock) glyphs for the detection sub-row. Virus is
// red to match the map; lock is amber. Distinct from the BAN (blocked) glyph.
// Prefixed AR_ to avoid colliding with the map's global VIRUS_SVG — these are
// plain <script> globals, not modules, so a bare `const VIRUS_SVG` would be a
// duplicate-declaration SyntaxError that breaks this whole file.
const AR_VIRUS_SVG = (c = '#ef4444', s = 12) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" style="vertical-align:-2px"><circle cx="12" cy="12" r="4.5" fill="${c}" fill-opacity="0.2"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><line x1="4.9" y1="4.9" x2="7" y2="7"/><line x1="17" y1="17" x2="19.1" y2="19.1"/><line x1="19.1" y1="4.9" x2="17" y2="7"/><line x1="7" y1="17" x2="4.9" y2="19.1"/></svg>`;
const AR_LOCK_SVG = (c = '#f59e0b', s = 12) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" style="vertical-align:-2px"><path fill="${c}" d="M12 1a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5zm3 8H9V6a3 3 0 0 1 6 0z"/></svg>`;
// Robot glyph for Generation (LLM turn) spans — mirrors the header Guardian
// robot so "LLM" reads consistently across the app. Teal, not a security colour.
const AR_ROBOT_SVG = (c = '#5eadb8', s = 12) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><rect x="4" y="8" width="16" height="11" rx="2.5"/><path d="M12 8V4M9 4h6"/><circle cx="9" cy="13" r="1.3" fill="${c}" stroke="none"/><circle cx="15" cy="13" r="1.3" fill="${c}" stroke="none"/></svg>`;

// Small stroke glyphs for the Runs list: allowed, waiting, blocked, and the
// tick on a chosen menu option. SVG, not text symbols, like the rest.
const RL_SVG = (d) => `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-1px"><path d="${d}"/></svg>`;
const RL_ICON_OK = RL_SVG('M5 12l5 5 9-10');
const RL_ICON_WAIT = RL_SVG('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2');
const RL_ICON_X = RL_SVG('M6 6l12 12M18 6L6 18');
const RL_CALLS_HEAD = `Tool calls ${RL_ICON_OK} · ${RL_ICON_WAIT} · ${RL_ICON_X}`;

const AgentRunsPage = {
    windowDays: 1,
    kinds: { builtin: true, external: true }, // checkbox filter for the waterfall steps
    runs: [],
    selected: null,
    runtimeFilter: null,   // active "only this runtime" filter (from a Map agent-node click)
    _pendingRuntime: null, // one-shot runtime filter handed off by the Map; consumed on render
    _pendingKinds: null,   // one-shot built-in/external filter handed off by a Map tool-node click
    _pendingReq: null,     // one-shot: select THIS waiting request's span once the trace loads (Live grid Review)
    _pendingTrace: null,   // one-shot: open THIS exact run (trace_id) from a Map agent-node click
    _pendingGenRid: null,  // one-shot: after opening, jump to the generation with this request_id (Optimizer finding click-through)
    _timelineMem: null,    // { traceId, open }: the timeline state last set on this page, kept across rebuilds
    _detailPointerAt: 0,   // time of the last pointerdown inside #ar-detail
    _timelineForce: null,  // trace id whose full timeline opens regardless of the saved choice (deep link, View in timeline)
    _stepsDetail: null,    // { traceId, key } the open chip in the step list (key '' = shut by hand)
    _health: null,         // trace id -> { key, data } run health findings (GET /api/traces/{id}/health), fetched once per opened run
    _healthOpen: null,     // trace id whose findings strip is expanded past its one-line summary
    _stepsFocus: null,     // { traceId, step } the step a "Jump to step N" asked for
    _pendingHealthOpen: false, // one-shot: a health link (Dashboard, Health view) opens the run with its findings shown
    _optReport: undefined, // Cost Optimizer report, fetched once per page life for per-turn annotations (null = fetched, none)
    toolFilter: null,      // filter spans to one tool_id (from a Map tool-node click)
    _pendingTool: null,    // one-shot tool_id handed off by a Map tool-node click
    outcomeFilter: 'all',  // span verdict filter: all | allow | blocked | log_only | threat | secret
    collapseGens: true,    // fold consecutive LLM turns into a summary (persona #1 ask)
    runSearch: '',         // in-trace filter: match runs by tool / model / reason
    // Runs list (6.0): range, list filters, grouping, sort and paging.
    range: '24h',
    filters: null,         // RunsList.emptyFilters() once the page renders
    groupBySession: true,
    sortKey: 'started',
    sortDir: 'desc',
    pageIdx: 0,
    _collapsedSessions: {},
    _expandedSessions: {},
    _extraDims: null,      // + Filter dimensions the person added (model, host, user, health)
    _liveData: null,       // GET observability/live: running sessions and their scores
    _pending: null,        // GET /api/jit/requests?status=pending: waiting request ages
    _coverage: null,       // runtime_kind -> coverage entry
    _listUpdatedAt: 0,
    // Session replay (§3.1): step/play through the trace's event stream in
    // chronological order. `idx` = how many events are revealed (playhead at
    // idx-1); the unit is the event, so replay respects the 8 KB redacted
    // text budget — bodies beyond that are never stored or replayed.
    _replay: { on: false, idx: 0, playing: false, speed: 1, timer: null, count: 0 },

    /** Stop the replay timer + reset state (called on trace change / leave). */
    _replayStop() {
        if (this._replay.timer) { clearInterval(this._replay.timer); this._replay.timer = null; }
        this._replay.on = false;
        this._replay.playing = false;
        this._replay.idx = 0;
    },

    // ── Live following ────────────────────────────────────────────────────
    // A trace with activity in the last LIVE_MS is "live": its card gets a
    // pulsing badge and the page polls /traces every POLL_MS so counts tick
    // up in place while the agent is still running. The open trace refreshes
    // itself too — but only when a rebuild wouldn't destroy anything the user
    // is interacting with (replay, an expanded run, in-trace search); in that
    // case a "new activity" pill appears instead and the user pulls.
    _LIVE_MS: 120000,
    _POLL_MS: 5000,
    _live: { timer: null, pendingDetail: false, lastDetail: 0, paused: false },

    _ms(ts) {
        if (!ts) return 0;
        const d = new Date(String(ts).replace(' ', 'T') + (String(ts).endsWith('Z') ? '' : 'Z'));
        return isNaN(d) ? 0 : d.getTime();
    },

    _isLive(ts) { return ts ? (Date.now() - this._ms(ts)) < this._LIVE_MS : false; },

    _liveBadge(title) {
        return `<span class="ar-live" title="${title || 'Activity in the last 2 minutes'}">live</span>`;
    },

    /** The hold-still control next to the LIVE badge on an open trace. While
     *  a session is running, live refreshes re-sort the list and grow the
     *  waterfall under the reader; this is the explicit "stop moving the
     *  page" switch. Pausing freezes ALL live updates on the page (nothing is
     *  lost; resume catches up immediately). */
    _pauseBtnHtml() {
        const paused = !!this._live.paused;
        return `<button type="button" class="ar-live-pause${paused ? ' paused' : ''}" ` +
            `title="${paused ? 'Resume live updates' : 'Hold this view still while you read. Live updates stop until you resume.'}">` +
            this._pauseBtnFace(paused) + `</button>`;
    },
    _pauseBtnFace(paused) {
        return paused
            ? `<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M8 5v14l11-7z"/></svg><span>Resume</span>`
            : `<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg><span>Pause</span>`;
    },
    _livePauseToggle(btn) {
        this._live.paused = !this._live.paused;
        const paused = this._live.paused;
        if (btn) {
            btn.classList.toggle('paused', paused);
            btn.title = paused ? 'Resume live updates' : 'Hold this view still while you read. Live updates stop until you resume.';
            btn.innerHTML = this._pauseBtnFace(paused);
        }
        if (!paused) {
            // Catch up right away: refresh the open trace (explicit ask, so it
            // may rebuild) and let the next tick bring the list up to date.
            this._livePill(false);
            this._liveRefreshDetail(true);
        }
    },

    _liveStart() {
        if (!this._agoTimer) {
            // "updated Ns ago" on the list, once a second.
            this._agoTimer = setInterval(() => {
                const el = document.getElementById('rl-ago');
                if (!el) { clearInterval(this._agoTimer); this._agoTimer = null; return; }
                el.textContent = this._agoText();
            }, 1000);
        }
        if (this._live.timer) return;
        this._live.timer = setInterval(() => { this._liveTick(); }, this._POLL_MS);
    },

    _liveStop() {
        if (this._agoTimer) { clearInterval(this._agoTimer); this._agoTimer = null; }
        if (this._live.timer) { clearInterval(this._live.timer); this._live.timer = null; }
        this._live.pendingDetail = false;
    },

    async _liveTick(force) {
        // Self-teardown: there is no page-destroy hook, so the poller checks
        // every tick that Traces is still mounted and stops itself otherwise.
        if (!document.getElementById('ar-runlist') || (window.App && App.currentPage !== 'agent-runs')) {
            this._liveStop();
            return;
        }
        if (document.hidden) return; // don't poll a background tab
        // User-requested pause: hold the whole page still — no list rebuild,
        // no detail refresh — until they resume. Nothing is lost; resume pulls.
        if (this._live.paused) return;
        // Only what the list shows: pending request ids, and each running
        // session with its score (quiet seconds tick every poll).
        const extrasKey = () => JSON.stringify([
            // The minute, so "waiting 2m" and "quiet 6m" move on their own.
            Math.floor(Date.now() / 60000),
            ((this._pending && this._pending.items) || []).map(p => p.id),
            ((this._liveData && this._liveData.sessions) || []).map(x => [x.session_id, x.score, Number(x.quiet_seconds) >= 300]),
        ]);
        const before = extrasKey();
        const [data] = await Promise.all([API.getTraces({ window_days: this.windowDays }), this._loadListExtras(false)]);
        const list = document.getElementById('ar-runlist');
        if (!data || !data.runs || !list) return; // unmounted / failed mid-fetch
        if (this._live.paused) return; // paused while the fetch was in flight
        this._listUpdatedAt = Date.now();
        // Re-render the list when the data changed OR a badge expired
        // (a trace goes quiet with no new rows — same data, different state).
        const liveKey = data.runs.filter(r => this._isLive(r.ended_at)).map(r => r.trace_id).join(',');
        const changed = force || JSON.stringify(this.runs) !== JSON.stringify(data.runs)
            || liveKey !== (this._liveIds || '') || extrasKey() !== before;
        // An open filter menu would close under the reader: wait for it.
        const menuOpen = !!document.querySelector('#ar-listview .rl-dd.open');
        if (changed && menuOpen) this._listStale = true;
        if ((changed || this._listStale) && !menuOpen) {
            this._listStale = false;
            this.runs = data.runs;
            // Restore every scroll owner: a live re-sort (a running agent
            // bubbles up) must not move the view.
            const keepScroll = list.scrollTop;
            const se = document.scrollingElement || document.documentElement;
            const keepPage = se.scrollTop;
            const pc = list.closest ? list.closest('.page-content') : null;
            const keepPc = pc ? pc.scrollTop : 0;
            this.renderRuns();
            list.scrollTop = keepScroll;
            se.scrollTop = keepPage;
            if (pc) pc.scrollTop = keepPc;
        }
        // Tab-return digest: while hidden the ticks (and snapshot saves) stop,
        // so a long-hidden tab comes back to a stale snapshot — same "away"
        // semantics as a fresh page load. Diff first, then refresh the snapshot.
        this._awayDigest();
        this._snapSave();
        // Open-trace refresh: when its row advanced (new tool runs / later
        // activity), or on a slow heartbeat while it's live (LLM runs don't
        // touch the audit table, so the row alone can't see them).
        const sel = (this.runs || []).find(r => r.trace_id === this.selected);
        const t = this._trace;
        if (!sel || !t || t.trace_id !== this.selected || !this._inDetail()) return;
        const advanced = (sel.spans || 0) !== (t.tool_call_count || 0)
            || this._ms(sel.ended_at) > this._ms(t.ended_at);
        const heartbeat = this._isLive(sel.ended_at) && (Date.now() - (this._live.lastDetail || 0)) > 15000;
        if (advanced || this._live.pendingDetail) {
            // Hard evidence of new runs. If a rebuild would destroy user state,
            // offer the pull-pill instead of yanking the DOM out from under them.
            if (this._detailBusy()) { this._live.pendingDetail = true; this._livePill(true); return; }
            await this._liveRefreshDetail();
        } else if (heartbeat && !this._detailBusy()) {
            // Soft refresh while live: LLM runs never touch the audit table, so
            // the row can't prove them — refresh quietly, but never pill for it.
            await this._liveRefreshDetail();
        }
    },

    /** True when rebuilding the waterfall would destroy in-progress user
     *  interaction: replay owns the view, an expanded run would snap shut,
     *  or focus (search box, a button) would be lost. */
    _detailBusy() {
        if (this._replay.on || this.runSearch) return true;
        // A decision in flight in the trace view's span panel.
        const rt = document.getElementById('ar-rt');
        if (rt && rt._rt && window.RunTrace && RunTrace.state(rt._rt.trace.trace_id).busy) return true;
        // An open full timeline would be rebuilt (and lose its scroll), and a
        // click that just landed in the detail may be aimed at a node that a
        // rebuild would replace: offer the pull-pill instead.
        const tl = document.getElementById('ar-timeline');
        if (tl && !tl.hidden) return true;
        if (this._detailPointerAt && (Date.now() - this._detailPointerAt) < 1500) return true;
        const det = document.getElementById('ar-detail');
        return !!(det && (det.querySelector('.ar-span.open')
            || (det.contains(document.activeElement) && document.activeElement !== document.body)));
    },

    async _liveRefreshDetail(force) {
        const id = this.selected;
        if (!id) return;
        this._live.lastDetail = Date.now();
        const trace = await API.getTrace(id);
        if (!trace || this.selected !== id || !document.getElementById('ar-detail')) return;
        this._trace = trace;
        // Re-check AFTER the fetch: the user may have entered replay, focused
        // a control, or hit pause while it was in flight. A stale render here
        // is exactly the "page keeps moving" yank — pill instead. An explicit
        // pill click (force) is the user asking, so it always goes through.
        if (!force && (this._detailBusy() || this._live.paused)) {
            this._live.pendingDetail = true;
            this._livePill(true);
            return;
        }
        this._live.pendingDetail = false;
        const se = document.scrollingElement || document.documentElement;
        const keepPage = se.scrollTop;
        // Inner scroll owners (the detail, the step list, the full timeline)
        // keep their position across the rebuild too.
        const inner = ['ar-detail', 'ar-steps', 'ar-timeline'].map(id => {
            const el = document.getElementById(id);
            return [id, el ? el.scrollTop || 0 : 0];
        });
        this.renderWaterfall(trace);
        inner.forEach(([id, top]) => {
            const el = document.getElementById(id);
            if (el && top) el.scrollTop = top;
        });
        se.scrollTop = keepPage;
    },

    /** Show/remove the "new activity" pull-pill on the runs heading. */
    _livePill(show) {
        const head = document.querySelector('#ar-detail .ar-runs-heading');
        if (!head) return;
        let pill = head.querySelector('.ar-live-pill');
        if (!show) { if (pill) pill.remove(); return; }
        if (pill) return;
        pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'ar-live-pill';
        pill.title = 'This trace has new runs: click to load them';
        pill.textContent = 'new activity: refresh';
        pill.onclick = () => { this._live.pendingDetail = false; this._liveRefreshDetail(true); };
        head.insertBefore(pill, head.firstChild.nextSibling);
    },

    // ── "While you were away" digest ──────────────────────────────────────
    // A localStorage snapshot of per-trace counts is refreshed on every data
    // load while the tab is visible. When the page next loads (or the tab
    // returns) after AWAY_MS of silence, the diff against that snapshot is
    // shown as a one-line strip: new traces, new tool runs, and — clickable —
    // any new blocked / threat / secret hits. Only provable deltas are shown
    // (the list endpoint can't see LLM runs, so they are never claimed).
    _AWAY_MS: 600000, // 10 min — shorter gaps aren't "away", they're a coffee
    _snapKey: 'sv-away-traces',

    _snapLoad() {
        try { return JSON.parse(localStorage.getItem(this._snapKey)); } catch (e) { return null; }
    },

    _snapSave() {
        const counts = {};
        (this.runs || []).forEach(r => {
            counts[r.trace_id] = [r.spans || 0, r.blocked || 0, r.detections || 0, r.secrets || 0];
        });
        try { localStorage.setItem(this._snapKey, JSON.stringify({ ts: Date.now(), counts })); } catch (e) { /* private mode */ }
    },

    /** Diff current runs against the stored snapshot; render the strip when
     *  the user was genuinely away AND something actually happened. */
    _awayDigest() {
        const slot = document.getElementById('ar-away');
        const snap = this._snapLoad();
        if (!slot || !snap || !snap.counts) return;
        if (Date.now() - (snap.ts || 0) < this._AWAY_MS) return;
        let newTraces = 0, dSpans = 0, dBlk = 0, dThr = 0, dSec = 0;
        const hits = { blocked: [], threat: [], secret: [] };
        (this.runs || []).forEach(r => {
            const prev = snap.counts[r.trace_id];
            if (!prev) {
                // Unseen trace: count it as new only if it ran after the
                // snapshot (a widened Window resurfaces OLD traces — not news).
                if (this._ms(r.ended_at) > snap.ts) {
                    newTraces++;
                    dSpans += r.spans || 0;
                    if (r.blocked) { dBlk += r.blocked; hits.blocked.push(r.trace_id); }
                    if (r.detections) { dThr += r.detections; hits.threat.push(r.trace_id); }
                    if (r.secrets) { dSec += r.secrets; hits.secret.push(r.trace_id); }
                }
                return;
            }
            const s = Math.max(0, (r.spans || 0) - prev[0]);
            const b = Math.max(0, (r.blocked || 0) - prev[1]);
            const t = Math.max(0, (r.detections || 0) - prev[2]);
            const x = Math.max(0, (r.secrets || 0) - prev[3]);
            dSpans += s;
            if (b) { dBlk += b; hits.blocked.push(r.trace_id); }
            if (t) { dThr += t; hits.threat.push(r.trace_id); }
            if (x) { dSec += x; hits.secret.push(r.trace_id); }
        });
        if (!newTraces && !dSpans && !dBlk && !dThr && !dSec) return;
        this._awayHits = hits;
        const chip = (n, noun, cls, drill, title) =>
            `<${drill ? 'button type="button"' : 'span'} class="ar-away-chip${cls ? ' ' + cls : ''}"` +
            (drill ? ` data-drill="${drill}" title="${title}"` : '') +
            `><b>${n.toLocaleString()}</b> ${noun}</${drill ? 'button' : 'span'}>`;
        slot.innerHTML = `<div class="ar-away" role="status">` +
            `<span class="ar-away-k">while you were away</span>` +
            `<span class="ar-away-since">since ${this._fmtSince(snap.ts)}</span>` +
            (newTraces ? chip(newTraces, `new trace${newTraces === 1 ? '' : 's'}`) : '') +
            (dSpans ? chip(dSpans, `tool run${dSpans === 1 ? '' : 's'}`) : '') +
            (dBlk ? chip(dBlk, 'blocked', 'danger', 'blocked', 'Jump to a trace with the new blocked runs') : '') +
            (dThr ? chip(dThr, `threat${dThr === 1 ? '' : 's'} detected`, 'danger', 'threat', 'Jump to a trace with the new detections') : '') +
            (dSec ? chip(dSec, `secret${dSec === 1 ? '' : 's'}`, 'warn', 'secret', 'Jump to a trace with the new secret detections') : '') +
            `<button type="button" class="ar-away-x" title="Dismiss">×</button></div>`;
        slot.querySelectorAll('[data-drill]').forEach(el =>
            el.addEventListener('click', () => this._awayDrill(el.dataset.drill)));
        slot.querySelector('.ar-away-x').addEventListener('click', () => this._awayDismiss());
    },

    /** Security-chip click → filter runs to that outcome and open a trace
     *  that gained such runs while away (falls back to any flagged trace). */
    _awayDrill(outcome) {
        this.outcomeFilter = outcome;
        if (this._outcomeSel) this._outcomeSel.value = outcome;
        const flagKey = { blocked: 'blocked', threat: 'detections', secret: 'secrets' }[outcome];
        const shown = this._filteredRuns();
        const fresh = (this._awayHits && this._awayHits[outcome]) || [];
        const hit = shown.find(r => fresh.includes(r.trace_id))
            || shown.find(r => (r[flagKey] || 0) > 0);
        this._awayDismiss();
        if (hit) this.selectRun(hit.trace_id);
        else if (this._inDetail() && this._trace) this.renderWaterfall(this._trace);
    },

    _awayDismiss() {
        const slot = document.getElementById('ar-away');
        if (slot) slot.innerHTML = '';
        this._snapSave(); // caught up — the next digest starts from now
    },

    _fmtSince(ms) {
        const d = new Date(ms);
        const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        return new Date().toDateString() === d.toDateString()
            ? t
            : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + t;
    },

    async render(container) {
        container.textContent = '';
        // Consume one-shot filters handed off by a Map node click. A plain tab
        // navigation leaves them null → no change (avoids a stale filter sticking
        // around when the user opens Runs directly). Agent node → runtime filter;
        // tool node → tool-kind filter (gear=external, dot=built-in).
        this.runtimeFilter = this._pendingRuntime || null;
        this._pendingRuntime = null;
        if (this._pendingKinds) { this.kinds = this._pendingKinds; this._pendingKinds = null; }
        // Tool-node drill → scope the run's spans to that one tool (one-shot, so
        // a plain tab nav clears it). Resets the verdict filter to "all" so the
        // tool's own outcomes (allow AND block) all show.
        if (this._pendingTool) { this.toolFilter = this._pendingTool; this._pendingTool = null; this.outcomeFilter = 'all'; }
        else { this.toolFilter = null; }
        // Blocked-Actions drill-through → land on Traces pre-filtered to that
        // outcome, and prefer a trace that actually HAS such runs (one-shot).
        this._wantFlagged = null;
        if (this._pendingOutcome) {
            this.outcomeFilter = this._pendingOutcome;
            this._wantFlagged = this._pendingOutcome;
            this._pendingOutcome = null;
        }
        if (window.Header) {
            Header.setPageInfo('Observability', 'Every agent run, grouped by session, with its decisions, tokens and cost. Open a run to see its spans.');
        }
        this._injectStyle();

        if (!this.filters) this.filters = RunsList.emptyFilters();
        // A Map agent-node drill arrives as a runtime filter: it becomes the
        // Harness filter. A plain visit leaves the list filters as they were.
        if (this.runtimeFilter) { this.filters.harness = [this.runtimeFilter]; this.pageIdx = 0; }
        const header = document.createElement('div');
        header.className = 'obs-header';
        ObsTabs.render(header, 'runs');
        // "How to read traces" — sits right after the tabs.
        const howto = ObsTabs.howToReadLink('How sessions, runs and spans work', 'section-read-runs', 'gs-read-runs');
        howto.style.alignSelf = 'center';
        howto.title = 'How sessions, runs and spans work';
        header.appendChild(howto);
        container.appendChild(header);

        const away = document.createElement('div');
        away.id = 'ar-away';
        container.appendChild(away);

        // The list (heading, toolbar, filters, summary cards, the runs and
        // the pager) and the open run's trace share one layout. Opening a
        // run hides the list and shows the trace full width; closing the
        // trace brings the list back where it was.
        const layout = document.createElement('div');
        layout.className = 'ar-layout runs-v2';
        layout.innerHTML = '<div class="ar-listview" id="ar-listview">' +
            '<div class="rl-head"><h2 class="rl-title">Runs</h2><div class="rl-toolbar" id="agent-runs-toolbar"></div></div>' +
            '<div class="rl-filters" id="rl-filters" role="toolbar" aria-label="Run filters"></div>' +
            '<section class="rl-cards" id="rl-cards" aria-label="Summary for the runs in view"></section>' +
            '<div class="rl-status" id="rl-status" aria-live="polite"></div>' +
            '<div class="rl-tablewrap"><div class="ar-runlist rl-table" id="ar-runlist" aria-label="Runs"></div></div>' +
            '<nav class="rl-pager" id="rl-pager" aria-label="Pages of runs"></nav></div>' +
            // The trace header carries the back control (#ar-back, "← Observability").
            '<div class="ar-pane" id="ar-pane">' +
            '<div class="ar-pane-empty" id="ar-pane-empty">' +
            '<div class="ar-pane-empty-t">Select a run</div>' +
            '<div class="ar-pane-empty-s">The run trace opens here with model and tool spans in order.</div></div>' +
            '<div class="ar-detail" id="ar-detail" hidden></div></div>';
        container.appendChild(layout);
        this._buildToolbar(layout.querySelector('#agent-runs-toolbar'));
        this._splitSetup(layout);

        await this.loadData();
        this._liveStart();
    },

    _injectStyle() {
        if (document.getElementById('agent-runs-style')) return;
        const st = document.createElement('style');
        st.id = 'agent-runs-style';
        st.textContent = `
            @keyframes arFade { from { opacity:0; transform:translateY(-3px); } to { opacity:1; transform:none; } }
            .ar-layout { display:block; }
            .ar-listview { display:flex; flex-direction:column; gap:8px; }
            .ar-detail[hidden] { display:none; }
            .ar-pane-empty { display:none; }
            /* Split pane (>=1100px): agent rail left, trace pane right, each
               scrolling inside the viewport height left under the header. */
            /* The page reserves room at the bottom for the Guardian; in split
               mode the panes scroll inside themselves, so a small gap is enough. */
            .page-content:has(.ar-layout.split), body.sv-ga-on #page-content:has(.ar-layout.split) { padding-bottom:40px; }
            .ar-layout.split { display:grid; grid-template-columns:296px minmax(0,1fr); gap:12px; align-items:start; }
            .ar-layout.split .ar-listview { position:sticky; top:0; max-height:var(--ar-pane-h,72vh); overflow:auto;
                overscroll-behavior:contain; padding-right:3px; }
            .ar-layout.split .ar-pane { position:sticky; top:0; max-height:var(--ar-pane-h,72vh); min-width:0;
                display:flex; flex-direction:column; }
            .ar-layout.split .ar-detail { flex:1 1 auto; min-height:0; overflow:auto; overscroll-behavior:contain;
                margin:0; animation:none; }
            .ar-layout.split .ar-det-head { position:sticky; top:-18px; z-index:3; margin:-18px -20px 3px;
                padding:16px 20px 8px; background:var(--bg-card,#161b22);
                border-bottom:1px solid var(--border-default,#30363d); }
            .ar-layout.split .ar-pane:not(.has-trace) .ar-pane-empty { display:flex; flex-direction:column;
                align-items:center; justify-content:center; text-align:center; gap:6px; min-height:320px;
                border:1px dashed var(--border-default,#30363d); border-radius:14px; padding:24px;
                color:var(--text-muted,#7d8590); }
            .ar-pane-empty-t { font:700 15px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-secondary,#b1bac4); }
            .ar-pane-empty-s { font-size:12.5px; max-width:380px; line-height:1.45; }
            .obs-header { row-gap:8px; margin-bottom:6px; }
            .ar-command-strip { display:flex; align-items:center; justify-content:space-between; gap:6px 12px;
                flex-wrap:wrap; margin-bottom:10px; }
            .ar-triage { display:flex; align-items:center; gap:4px; flex-wrap:wrap; min-width:0; }
            #agent-runs-toolbar.filters-bar { margin:0 0 0 auto; gap:8px; align-items:center; min-height:30px; }
            #agent-runs-toolbar .filter-group { position:relative; flex-direction:row; align-items:center; gap:0; }
            #agent-runs-toolbar .filter-group > label { position:absolute; width:1px; height:1px; overflow:hidden;
                clip:rect(0 0 0 0); white-space:nowrap; }
            #agent-runs-toolbar .filter-select { height:30px; padding:4px 26px 4px 10px; font-size:12.5px;
                background-position:right 8px center; }
            #agent-runs-toolbar .btn { height:30px; padding:0 10px; font-size:12.5px; }
            #agent-runs-toolbar .filter-select { width:auto; min-width:0; }
            .obs-header .sv-howto-link span { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }
            .obs-header .sv-howto-link { padding:5px 9px; }
            .ar-command-strip .ar-view-chip { padding:4px 6px; }
            .ar-command-strip .ar-view-chips { gap:4px; padding:0; }
            .ar-command-strip .ar-more-views summary { padding:4px 7px; }
            /* Two equal panels sharing one top edge and one bottom edge. */
            .ar-layout.split .ar-listview, .ar-layout.split .ar-pane { height:var(--ar-pane-h,72vh); box-sizing:border-box; }
            .ar-layout.split .ar-listview { background:var(--bg-card,#161b22); border:1px solid var(--border-default,#30363d);
                border-radius:14px; padding:12px 12px 8px; gap:6px; }
            .ar-layout.split .ar-pane:not(.has-trace) .ar-pane-empty { flex:1 1 auto; border-style:solid;
                background:var(--bg-card,#161b22); }
            .ar-layout.split .ar-cols { display:none; }
            .ar-layout.split .ar-run { display:flex; flex-direction:column; align-items:stretch; justify-content:center;
                gap:5px; min-height:58px; padding:7px 9px 7px 12px; }
            .ar-layout.split .ar-run-primary, .ar-layout.split .ar-run-secondary { display:flex; align-items:center; gap:5px; min-width:0; }
            .ar-layout.split .ar-run-primary .ar-row-name { flex:1 1 auto; }
            .ar-layout.split .ar-run-primary .ar-run-rt { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            .ar-layout.split .ar-run-secondary { padding-left:17px; color:var(--text-muted,#7d8590); font-size:10.5px; }
            .ar-layout.split .ar-run-secondary .ar-row-id { display:inline; opacity:1; }
            .ar-layout.split .ar-run-secondary .ar-row-time { display:none; }
            .ar-layout.split .ar-group-body { padding-left:5px; }
            .ar-layout.split .ar-group-head { flex-wrap:wrap; row-gap:2px; }
            .ar-layout.split .ar-group-flag { display:none; }
            .ar-layout.split .ar-tl { width:128px; }
            /* Trace TABLE (the Langfuse/LangSmith/Datadog pattern): one
               full-width row per agent with aligned columns; the shared grid
               template keeps the header and every row in lockstep. */
            .ar-cols, .ar-run { display:grid; align-items:center; gap:10px;
                grid-template-columns:14px 10px minmax(160px,1fr) 90px 90px 90px 90px 96px 150px; }
            .ar-cols { padding:0 13px 0 42px; margin-top:2px;
                font:700 9.5px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.9px;
                text-transform:uppercase; color:var(--text-muted,#7d8590); }
            .ar-cols span { text-align:right; }
            .ar-cols .col-name { text-align:left; }
            .ar-row-caret { width:12px; height:12px; color:var(--text-muted,#7d8590); transition:transform .16s; }
            .ar-run.open .ar-row-caret { transform:rotate(90deg); color:var(--accent-primary,#5eadb8); }
            .ar-row-name { display:flex; align-items:center; gap:8px; min-width:0; }
            /* The agent label keeps its place when health badges follow it:
               it truncates with an ellipsis before it is ever pushed out. */
            .ar-row-name .ar-run-rt { flex:0 1 auto; min-width:52px; }
            .ar-row-health { display:inline-flex; align-items:center; gap:4px; flex:0 1 auto; min-width:0; overflow:hidden; }
            .ar-layout.split .ar-row-health .sv-health-badge-text { display:none; }
            .ar-layout.split .ar-row-health .sv-health-badge { padding:0 3px; }
            .ar-row-id { font-family:var(--font-mono,monospace); font-size:10.5px; color:var(--text-secondary,#8b949e); opacity:.65; letter-spacing:.02em; flex:0 0 auto; }
            .ar-row-c { text-align:right; font-size:11.5px; color:var(--text-secondary,#b1bac4); white-space:nowrap; }
            .ar-row-c .ar-dim0 { color:var(--text-muted,#7d8590); opacity:.5; }
            .ar-row-time { text-align:right; color:var(--text-muted,#7d8590); font-size:11px; white-space:nowrap; }
            .ar-costly { display:inline-block; margin-left:5px; min-width:14px; height:14px; line-height:14px; border-radius:7px; text-align:center;
                font:700 10px ui-monospace,Menlo,monospace; color:var(--text-primary,#e6edf3); background:var(--bg-tertiary,#30363d); }
            .ar-gen-verdict { font:700 9.5px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.6px; padding:1px 6px; border-radius:4px; margin-left:6px; }
            .ar-gen-verdict.grey { color:var(--text-secondary,#b1bac4); background:var(--bg-tertiary,#30363d); }
            .ar-gen-verdict.green { color:#3fb950; background:rgba(63,185,80,.12); }
            .ar-gen-verdict.red { color:#ef4444; background:rgba(239,68,68,.12); }
            .ar-gen-top { font:700 9.5px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.6px; padding:1px 6px; border-radius:4px; margin-left:6px;
                color:var(--text-primary,#e6edf3); background:var(--bg-tertiary,#30363d); }
            .ar-gen-dur { font-family:ui-monospace,Menlo,monospace; font-size:11px; color:var(--text-muted,#7d8590); margin-left:6px; }
            @media (max-width:900px) {
                .ar-cols, .ar-run { grid-template-columns:14px 10px minmax(120px,1fr) 70px 70px 80px 120px; }
                .col-det, .col-sec { display:none; }
            }
            .ar-rail-head { display:flex; align-items:baseline; gap:8px; padding:2px 4px 0;
                font:600 11px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.6px; text-transform:uppercase;
                color:var(--text-muted,#7d8590); }
            .ar-rail-head b { font:700 12px ui-monospace,'JetBrains Mono',Menlo,monospace; color:var(--text-primary,#e6edf3);
                font-variant-numeric:tabular-nums; }
            .ar-rail-live { display:inline-flex; align-items:center; gap:5px; color:var(--accent-primary,#5eadb8);
                font-weight:700; letter-spacing:.8px; background:none; border:none; padding:0; cursor:pointer; font:inherit; font-weight:700; }
            .ar-rail-live:hover { text-decoration:underline; }
            .ar-rail-live::before { content:''; width:5px; height:5px; border-radius:50%; background:var(--accent-primary,#5eadb8);
                animation:arLivePulse 1.6s ease-in-out infinite; }
            .ar-rail-win { margin-left:auto; letter-spacing:.4px; }
            /* --- Runtime group headers: the list's first level is the
               runtime/harness; its agents grid underneath. --- */
            .ar-group-head { display:flex; align-items:center; gap:7px; width:100%; text-align:left; cursor:pointer;
                margin:10px 0 4px; padding:6px 8px; border:none; border-radius:8px; background:transparent;
                color:var(--text-secondary,#b1bac4); transition:background .12s; }
            .ar-group-head:first-of-type { margin-top:2px; }
            .ar-group-head:hover { background:var(--bg-hover,#21262d); }
            .ar-group-head .ar-caret { transform:rotate(90deg); }
            .ar-group-head.closed .ar-caret { transform:none; }
            .ar-group-rt { font:700 12.5px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3); }
            .ar-group-n { font:11px ui-monospace,'JetBrains Mono',Menlo,monospace; color:var(--text-muted,#7d8590);
                font-variant-numeric:tabular-nums; }
            .ar-group-flag { font:600 10.5px 'Avenir Next',Avenir,system-ui,sans-serif; white-space:nowrap; }
            .ar-group-body { display:flex; flex-direction:column; gap:6px; padding-left:26px; }
            .ar-group-body[hidden] { display:none; }
            .ar-group-body .ar-run { margin:0; }
            /* Inline drill-down: the waterfall expands directly beneath its
               row and collapses on a second click (accordion). */
            .ar-group-body .ar-detail { margin:2px 0 10px; animation:arFade .18s ease-out; }
            /* "While you were away" digest strip — one line, above the layout.
               Neutral by default; red/amber ONLY on the security chips. */
            .ar-away { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin:0 0 12px;
                padding:8px 12px; border:1px solid var(--border-default,#30363d); border-radius:8px;
                background:var(--bg-card,#161b22); border-left:3px solid var(--accent-primary,#5eadb8);
                animation:arAwayIn .25s ease-out; }
            @keyframes arAwayIn { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:none; } }
            .ar-away-k { font:700 10.5px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.8px;
                text-transform:uppercase; color:var(--accent-primary,#5eadb8); }
            .ar-away-since { font:500 11.5px 'Avenir Next',Avenir,system-ui,sans-serif;
                color:var(--text-muted,#7d8590); margin-right:4px; }
            .ar-away-chip { display:inline-flex; align-items:center; gap:5px; border-radius:20px;
                padding:3px 10px; border:1px solid var(--border-default,#30363d);
                background:var(--bg-secondary,#0d1117); color:var(--text-secondary,#b1bac4);
                font:500 12px 'Avenir Next',Avenir,system-ui,sans-serif; }
            .ar-away-chip b { font:700 12px ui-monospace,'JetBrains Mono',Menlo,monospace;
                color:var(--text-primary,#e6edf3); }
            button.ar-away-chip { cursor:pointer; transition:background .12s,border-color .12s; }
            .ar-away-chip.danger { border-color:rgba(239,68,68,0.45); color:#ef4444; }
            .ar-away-chip.danger b { color:#ef4444; }
            button.ar-away-chip.danger:hover { background:rgba(239,68,68,0.12); border-color:#ef4444; }
            .ar-away-chip.warn { border-color:rgba(245,158,11,0.45); color:#f59e0b; }
            .ar-away-chip.warn b { color:#f59e0b; }
            button.ar-away-chip.warn:hover { background:rgba(245,158,11,0.12); border-color:#f59e0b; }
            .ar-away-x { margin-left:auto; cursor:pointer; border:none; background:none;
                color:var(--text-muted,#7d8590); font-size:16px; line-height:1; padding:2px 6px;
                border-radius:4px; }
            .ar-away-x:hover { color:var(--text-primary,#e6edf3); background:var(--bg-hover,#21262d); }
            @media (prefers-reduced-motion: reduce) { .ar-away { animation:none; } }
            .ar-runlist { display:flex; flex-direction:column; gap:9px; padding:2px; }
            .ar-run-primary, .ar-run-secondary { display:contents; }
            .ar-compact-meta { display:none; }
            .ar-layout.split .ar-run-secondary .ar-compact-meta { display:flex; align-items:center; gap:5px; min-width:0;
                white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            .ar-layout.split .ar-run-secondary > .ar-row-c { display:none; }
            /* The tool-call count never gives way: the id, runtime, Terminal cue, blocked and cost shrink first. */
            .ar-layout.split .ar-compact-meta > span { flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; }
            .ar-layout.split .ar-compact-meta > .ar-meta-count { flex:0 0 auto; overflow:visible; }
            .ar-layout.split .ar-compact-meta > .ar-row-health { flex:0 0 auto; }
            .ar-layout.split .ar-run-primary .ar-row-id { display:none; }
            .ar-layout.split .ar-run-primary .ar-row-health { display:none; }
            .ar-layout.split .ar-run-primary .ar-live { width:8px; height:8px; padding:0; border:0; font-size:0; letter-spacing:0; }
            .ar-layout.split .ar-run-primary .ar-live::before { width:8px; height:8px; }
            .ar-layout.split .ar-compact-meta .sv-health-badge-text { display:none; }
            .ar-layout.split .ar-compact-meta .sv-health-badge { padding:0 2px; }
            .ar-relative { display:none; }
            .ar-layout.split .ar-relative { display:inline; margin-left:auto; flex:0 0 auto; color:var(--text-muted,#7d8590); font-size:10.5px; }
            .ar-run:focus-visible, .ar-view-chip:focus-visible, .ar-filter-chip:focus-visible { outline:2px solid var(--accent-primary,#5eadb8); outline-offset:2px; }
            .ar-terminal-cue { color:var(--accent-primary,#5eadb8); font-weight:700; }
            .ar-terminal-open { border:1px solid var(--border-default,#30363d); border-radius:6px; padding:4px 8px;
                color:var(--accent-primary,#5eadb8); background:var(--bg-card,#161b22); font:600 11px 'Avenir Next',Avenir,system-ui,sans-serif; cursor:pointer; }
            .ar-terminal-open:hover { border-color:var(--accent-primary,#5eadb8); background:var(--bg-hover,#21262d); }
            .ar-terminal-open:focus-visible { outline:2px solid var(--accent-primary,#5eadb8); outline-offset:2px; }
            .ar-detail { min-width:0; border:1px solid var(--border-default,#30363d); border-radius:14px;
                background:var(--bg-card,#161b22); padding:18px 20px; min-height:320px; }
            /* Run cards: runtime-coloured left rail, lift on hover, accent when selected.
               flex:0 0 auto is load-bearing, the runlist is a flex column with max-height,
               so without it many runs flex-shrink every card to ~24px and crush the text. */
            .ar-run { position:relative; flex:0 0 auto; text-align:left; cursor:pointer; border:1px solid var(--border-default,#30363d); border-radius:12px;
                background:var(--bg-card,#161b22); padding:9px 13px 9px 16px; overflow:hidden;
                transition:border-color .14s,background .14s,box-shadow .14s,transform .14s; }
            .ar-run::before { content:''; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--ar-accent,#5eadb8); opacity:.5; transition:opacity .14s,width .14s; }
            .ar-run:hover { border-color:var(--accent-primary,#5eadb8); box-shadow:0 4px 14px rgba(0,0,0,.22); transform:translateY(-1px); }
            .ar-run:hover::before { opacity:.9; }
            .ar-run.sel { border-color:var(--accent-primary,#5eadb8); background:color-mix(in srgb, var(--accent-primary,#5eadb8) 9%, var(--bg-card,#161b22)); }
            .ar-run.sel::before { opacity:1; width:4px; background:var(--accent-primary,#5eadb8); }
            @media (prefers-reduced-motion: reduce) {
                .ar-run, .ar-live, .ar-rail-live::before, .ar-card-tick { animation:none !important; transition:none !important; }
                .ar-run:hover { transform:none; }
            }
            .ar-run-top { display:flex; align-items:center; gap:8px; margin-bottom:5px; }
            .ar-run-rt { font:700 13px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3); letter-spacing:.2px;
                min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            .ar-run-sub { font:600 10px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-muted,#7d8590); text-transform:lowercase;
                border:1px solid var(--border-default,#30363d); border-radius:999px; padding:1px 7px; letter-spacing:.2px; flex:0 0 auto; white-space:nowrap; }
            .ar-run-dot { width:9px; height:9px; border-radius:50%; flex:0 0 auto; box-shadow:0 0 0 3px color-mix(in srgb, var(--ar-accent,#5eadb8) 22%, transparent); }
            .ar-run-meta { font-size:11.5px; color:var(--text-secondary,#b1bac4); display:flex; gap:11px; flex-wrap:wrap; align-items:center; }
            .ar-run-time { margin-left:auto; color:var(--text-muted,#7d8590); font-size:11px; white-space:nowrap; }
            .ar-num { font-family:ui-monospace,'JetBrains Mono','SF Mono',Menlo,monospace; font-variant-numeric:tabular-nums; color:var(--text-primary,#e6edf3); }
            .ar-blk { color:var(--danger,#ef4444); }
            /* Per-trace security signal on the list card — red threat, amber
               secret (SOC colour discipline). Turns the list into triage. */
            .ar-thr { color:#ef4444; display:inline-flex; align-items:center; gap:4px; }
            .ar-sec { color:#f59e0b; display:inline-flex; align-items:center; gap:4px; }
            .ar-risk { margin-left:auto; width:10px; height:10px; border-radius:50%; }
            .ar-det-head { display:flex; align-items:center; gap:10px; margin-bottom:3px; }
            .ar-det-title { font:700 17px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3); letter-spacing:.2px; }
            /* Masthead — the trace's vitals as a stat strip: monospace values,
               small-caps labels, one dim detail line. Numbers you scan, not a
               sentence you parse. Danger cell (blocked) is the only red. */
            .ar-masthead { display:flex; flex-wrap:wrap; margin:12px 0 10px; border:1px solid var(--border-default,#30363d);
                border-radius:12px; overflow:hidden;
                background:color-mix(in srgb, var(--bg-primary,#010409) 45%, var(--bg-card,#161b22)); }
            .ar-stat { flex:1 1 auto; min-width:118px; padding:11px 16px 10px;
                border-right:1px solid var(--border-default,#30363d); }
            .ar-stat:last-child { border-right:0; }
            .ar-stat-v { font:700 17px ui-monospace,'JetBrains Mono','SF Mono',Menlo,monospace; line-height:1.15;
                color:var(--text-primary,#e6edf3); font-variant-numeric:tabular-nums; }
            .ar-stat-l { margin-top:3px; font:700 9.5px 'Avenir Next',Avenir,system-ui,sans-serif;
                letter-spacing:.9px; text-transform:uppercase; color:var(--text-muted,#7d8590); }
            .ar-stat-d { margin-top:2px; font-size:10.5px; color:var(--text-muted,#7d8590); white-space:nowrap; }
            .ar-stat.danger { background:color-mix(in srgb, #ef4444 7%, transparent); }
            .ar-stat.danger .ar-stat-v { color:#ef4444; }
            .ar-det-sub { font-size:12px; color:var(--text-secondary,#b1bac4); margin-bottom:16px; line-height:1.7; }
            .ar-det-dim { color:var(--text-muted,#7d8590); }
            /* "TRACE" eyebrow on the detail header — names what this panel IS, so
               the left list reads as a list of traces and the right as its runs. */
            .ar-det-x { cursor:pointer; border:none; background:none; color:var(--text-muted,#7d8590);
                font-size:17px; line-height:1; padding:2px 7px; border-radius:6px; }
            .ar-det-x:hover { color:var(--text-primary,#e6edf3); background:var(--bg-hover,#21262d); }
            .ar-det-eyebrow { margin-left:auto; font:700 9.5px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:1.2px;
                text-transform:uppercase; color:var(--accent-primary,#5eadb8); border-radius:999px; padding:3px 10px;
                border:1px solid color-mix(in srgb, var(--accent-primary,#5eadb8) 50%, transparent);
                background:color-mix(in srgb, var(--accent-primary,#5eadb8) 10%, transparent); }
            /* "Runs in this trace" heading over the waterfall — makes the
               trace→run containment explicit (answers "which run is whose"). */
            .ar-runs-heading { display:flex; align-items:center; gap:10px; margin:4px 0 10px; }
            .ar-runs-heading b { font:700 12.5px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3);
                letter-spacing:.2px; flex:0 0 auto; }
            .ar-runs-count { font-size:11px; color:var(--text-muted,#7d8590); margin-left:auto; flex:0 0 auto; white-space:nowrap; }
            /* Live following: teal = the app's single accent — "running" is an
               activity state, not a security outcome, so it must not be green/red. */
            .ar-live { display:inline-flex; align-items:center; gap:4px; flex:0 0 auto;
                font:700 9px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:1.2px; text-transform:uppercase;
                color:var(--accent-primary,#5eadb8); border:1px solid rgba(94,173,184,0.45); border-radius:9px; padding:1px 7px 1px 6px; }
            .ar-live::before { content:''; width:5px; height:5px; border-radius:50%; background:var(--accent-primary,#5eadb8);
                animation:arLivePulse 1.6s ease-in-out infinite; }
            @keyframes arLivePulse { 0%,100% { opacity:1; } 50% { opacity:0.2; } }
            @keyframes arCardTick { from { box-shadow:0 0 0 1px rgba(94,173,184,0.7) inset; background:rgba(94,173,184,0.10); } to { box-shadow:none; } }
            .ar-card-tick { animation:arCardTick 1.2s ease-out; }
            .ar-live-pill { display:inline-flex; align-items:center; gap:5px; cursor:pointer; flex:0 0 auto;
                font:600 10.5px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--accent-primary,#5eadb8);
                background:rgba(94,173,184,0.10); border:1px solid rgba(94,173,184,0.45); border-radius:11px; padding:2px 9px;
                animation:arFade .16s ease-out; }
            .ar-live-pill::before { content:''; width:5px; height:5px; border-radius:50%; background:var(--accent-primary,#5eadb8);
                animation:arLivePulse 1.6s ease-in-out infinite; }
            .ar-live-pill:hover { background:rgba(94,173,184,0.18); }
            /* Hold-still switch beside the LIVE badge: neutral chrome, teal on
               hover; the "paused" state carries the accent so it can't be
               missed while updates are frozen. */
            .ar-live-pause { display:inline-flex; align-items:center; gap:4px; cursor:pointer; flex:0 0 auto;
                font:600 10px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.3px;
                color:var(--text-secondary,#b1bac4); background:var(--bg-tertiary,#21262d);
                border:1px solid var(--border-default,#30363d); border-radius:9px; padding:2px 8px; }
            .ar-live-pause:hover { color:var(--text-primary,#e6edf3); border-color:var(--accent-primary,#5eadb8); }
            .ar-live-pause.paused { color:var(--accent-primary,#5eadb8);
                border-color:color-mix(in srgb, var(--accent-primary,#5eadb8) 55%, transparent);
                background:color-mix(in srgb, var(--accent-primary,#5eadb8) 12%, transparent); }
            @media (prefers-reduced-motion: reduce) {
                .ar-live::before, .ar-live-pill::before { animation:none; }
                .ar-card-tick { animation:none; }
            }
            /* In-trace search — filter the loaded runs without a round-trip. */
            .ar-run-search { flex:0 1 250px; min-width:120px; box-sizing:border-box; padding:5px 10px;
                border:1px solid var(--border-default,#30363d); border-radius:7px; background:var(--bg-primary,#010409);
                color:var(--text-primary,#e6edf3); font:500 12px 'Avenir Next',Avenir,system-ui,sans-serif; outline:none;
                transition:border-color .12s; }
            .ar-run-search::placeholder { color:var(--text-muted,#7d8590); }
            .ar-run-search:focus { border-color:var(--accent-primary,#5eadb8); }
            .ar-search-hidden { display:none !important; }
            .ar-sid { display:inline-flex; align-items:center; gap:6px; margin-top:6px; }
            .ar-sid code { font:600 11px ui-monospace,'JetBrains Mono',Menlo,monospace; color:var(--text-primary,#e6edf3); user-select:all; }
            .ar-copy { border:1px solid var(--border-default,#30363d); background:var(--bg-card,#161b22); color:var(--text-secondary,#b1bac4);
                border-radius:6px; padding:2px 7px; font:600 10px 'Avenir Next',Avenir,system-ui,sans-serif; cursor:pointer; }
            .ar-span-hash { display:flex; align-items:center; gap:6px; margin:8px 0 0; font-size:11px; }
            .ar-span-hash code { font:600 11px ui-monospace,'JetBrains Mono',Menlo,monospace; color:var(--text-secondary,#b1bac4); }
            .ar-copy:hover { border-color:var(--accent-primary,#5eadb8); color:var(--text-primary,#e6edf3); }
            /* Waterfall spine — gradient rail, glowing verdict dots. */
            .ar-span { position:relative; padding:0 0 20px 30px; }
            .ar-span::before { content:''; position:absolute; left:7px; top:16px; bottom:-3px; width:2px;
                background:linear-gradient(180deg, var(--border-default,#30363d), color-mix(in srgb, var(--border-default,#30363d) 40%, transparent)); }
            .ar-span:last-child::before { display:none; }
            .ar-span-dot { position:absolute; left:0; top:4px; width:15px; height:15px; border-radius:50%;
                border:3px solid var(--bg-card,#161b22); box-sizing:content-box; box-shadow:0 0 0 4px color-mix(in srgb, currentColor 0%, transparent); }
            .ar-span-row { display:flex; align-items:center; gap:11px; cursor:pointer; border-radius:8px;
                padding:5px 8px; margin:-5px -8px; transition:background .12s; }
            .ar-span-row:hover { background:var(--bg-hover,#21262d); }
            .ar-caret { width:13px; height:13px; flex:0 0 auto; color:var(--text-muted,#7d8590); transition:transform .14s; }
            .ar-span.open .ar-caret { transform:rotate(90deg); color:var(--accent-primary,#5eadb8); }
            .ar-span-tool { font:600 13.5px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3);
                min-width:0; flex:0 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            /* Built-in (harness) vs external (MCP/plugin) tool chip. */
            .ar-kind { font:700 9.5px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.6px; text-transform:uppercase;
                padding:2px 8px; border-radius:6px; border:1px solid var(--border-default,#30363d); color:var(--text-secondary,#b1bac4); }
            .ar-kind.ext { color:var(--accent-primary,#5eadb8); border-color:color-mix(in srgb, var(--accent-primary,#5eadb8) 55%, transparent);
                background:color-mix(in srgb, var(--accent-primary,#5eadb8) 12%, transparent); }
            /* --- Generation (LLM turn) spans — teal accent, no verdict --- */
            .ar-span-gen .ar-span-dot.ar-gen-dot { display:flex; align-items:center; justify-content:center;
                background:color-mix(in srgb, var(--accent-primary,#5eadb8) 16%, var(--bg-card,#161b22));
                border-color:var(--bg-card,#161b22); }
            .ar-span-gen .ar-gen-model { font-family:ui-monospace,'JetBrains Mono','SF Mono',Menlo,monospace;
                font-size:12.5px; font-weight:600; color:var(--text-primary,#e6edf3); }
            .ar-kind.ar-gen-kind { color:var(--accent-primary,#5eadb8);
                border-color:color-mix(in srgb, var(--accent-primary,#5eadb8) 55%, transparent);
                background:color-mix(in srgb, var(--accent-primary,#5eadb8) 12%, transparent); }
            .ar-gen-flow { display:inline-flex; align-items:center; gap:5px; font-family:ui-monospace,'JetBrains Mono',Menlo,monospace;
                font-size:11.5px; color:var(--text-secondary,#b1bac4); }
            .ar-gen-arrow { color:var(--text-muted,#7d8590); }
            .ar-gen-toklabel { font-size:9.5px; text-transform:uppercase; letter-spacing:.5px; color:var(--text-muted,#7d8590); }
            .ar-gen-cost { font-family:ui-monospace,'JetBrains Mono',Menlo,monospace; font-size:11.5px;
                color:var(--text-primary,#e6edf3); font-variant-numeric:tabular-nums; }
            .ar-gen-stop { font:600 9.5px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.4px; text-transform:uppercase;
                padding:2px 7px; border-radius:6px; color:var(--text-muted,#7d8590);
                border:1px solid var(--border-default,#30363d); }
            /* "→ Bash" — the tool(s) this LLM run asked to call. Teal (the one
               interactive accent), not a security colour; text-case preserved so
               tool names read naturally (Bash, WebFetch). */
            .ar-gen-stop.ar-gen-tooluse { text-transform:none; letter-spacing:0; color:var(--accent-primary,#5eadb8);
                border-color:color-mix(in srgb, var(--accent-primary,#5eadb8) 45%, transparent);
                background:color-mix(in srgb, var(--accent-primary,#5eadb8) 10%, transparent);
                font-family:ui-monospace,'JetBrains Mono','SF Mono',Menlo,monospace; font-size:11px; }
            .ar-gen-toolarrow { opacity:.7; }
            .ar-gen-io { margin-top:11px; }
            .ar-gen-io:first-child { margin-top:0; }
            .ar-gen-pre { margin:0; padding:9px 11px; border-radius:8px; background:var(--bg-primary,#010409);
                border:1px solid var(--border-light,var(--border-default,#30363d)); color:var(--text-primary,#e6edf3);
                box-shadow:var(--elevate-1,none);
                font:11.5px ui-monospace,'JetBrains Mono','SF Mono',Menlo,monospace; white-space:pre-wrap; word-break:break-word;
                max-height:220px; overflow:auto; }
            .ar-gen-ellipsis { color:var(--text-muted,#7d8590); }
            .ar-gen-note { font-size:11.5px; color:var(--text-muted,#7d8590); line-height:1.5; font-style:italic; }
            .ar-gen-privacy { margin-top:10px; font-size:10.5px; color:var(--text-muted,#7d8590); line-height:1.5;
                padding-top:8px; border-top:1px dashed var(--border-default,#30363d); }
            /* Tool results (Pillar 3) — what each called tool returned. */
            .ar-tr { margin-top:8px; }
            .ar-tr:first-child { margin-top:4px; }
            .ar-tr-head { display:flex; align-items:center; gap:6px; margin-bottom:3px;
                font:600 11.5px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-secondary,#b1bac4); }
            .ar-tr-head b { color:var(--text-primary,#e6edf3); font-family:ui-monospace,'JetBrains Mono',Menlo,monospace; font-size:11.5px; }
            .ar-tr-arrow { color:var(--accent-primary,#5eadb8); font-weight:700; }
            .ar-tr-err { font:700 9px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.4px; text-transform:uppercase;
                padding:1px 6px; border-radius:5px; color:#ef4444; background:rgba(239,68,68,0.13); }
            /* --- Session replay bar (§3.1) --- */
            .ar-replay { display:flex; align-items:center; gap:10px; margin:2px 0 14px; }
            .ar-replay-enter { display:inline-flex; align-items:center; gap:7px; padding:6px 13px; border-radius:8px;
                border:1px solid var(--border-default,#30363d); background:var(--bg-card,#161b22); color:var(--text-primary,#e6edf3);
                font:600 12.5px 'Avenir Next',Avenir,system-ui,sans-serif; cursor:pointer; transition:background .12s,border-color .12s; }
            .ar-replay-enter:hover:not(:disabled) { border-color:var(--accent-primary,#5eadb8); background:var(--bg-hover,#21262d); }
            .ar-replay-enter svg { color:var(--accent-primary,#5eadb8); }
            .ar-replay-enter:disabled { opacity:.45; cursor:default; }
            .ar-replay.on { padding:8px 12px; border-radius:11px; background:var(--bg-tertiary,#0d1117);
                border:1px solid var(--border-default,#30363d); box-shadow:var(--elevate-1,none); }
            .ar-rp-btn { display:inline-flex; align-items:center; justify-content:center; width:30px; height:30px; flex:0 0 auto;
                border:1px solid var(--border-default,#30363d); border-radius:7px; background:var(--bg-card,#161b22);
                color:var(--text-secondary,#b1bac4); cursor:pointer; transition:color .12s,background .12s,border-color .12s; }
            .ar-rp-btn:hover:not(:disabled) { color:var(--text-primary,#e6edf3); background:var(--bg-hover,#21262d); }
            .ar-rp-btn:disabled { opacity:.35; cursor:default; }
            .ar-rp-btn.play { color:#fff; background:var(--accent-primary,#5eadb8); border-color:var(--accent-primary,#5eadb8); }
            .ar-rp-btn.play:hover:not(:disabled) { filter:brightness(1.08); background:var(--accent-primary,#5eadb8); }
            .ar-rp-btn.exit { margin-left:2px; }
            .ar-rp-scrub { flex:1 1 auto; min-width:80px; accent-color:var(--accent-primary,#5eadb8); cursor:pointer; height:4px; }
            .ar-rp-read { display:flex; flex-direction:column; align-items:flex-end; line-height:1.25; flex:0 0 auto; }
            .ar-rp-pos { font:700 12px ui-monospace,'JetBrains Mono',Menlo,monospace; color:var(--text-primary,#e6edf3); font-variant-numeric:tabular-nums; }
            .ar-rp-clock { font-size:10px; color:var(--text-muted,#7d8590); white-space:nowrap; }
            .ar-rp-speed { display:inline-flex; gap:2px; flex:0 0 auto; }
            .ar-rp-sp { border:1px solid var(--border-default,#30363d); background:var(--bg-card,#161b22); color:var(--text-secondary,#b1bac4);
                font:700 10.5px ui-monospace,'JetBrains Mono',Menlo,monospace; padding:5px 7px; border-radius:6px; cursor:pointer; }
            .ar-rp-sp.on { color:#fff; background:var(--accent-primary,#5eadb8); border-color:var(--accent-primary,#5eadb8); }
            /* --- Collapsed LLM-turn group + toggle --- */
            .ar-gentoggle { display:inline-flex; align-items:center; gap:7px; margin:0 0 10px; padding:5px 11px; border-radius:8px;
                border:1px dashed var(--border-default,#30363d); background:transparent; color:var(--text-secondary,#b1bac4);
                font:600 11.5px 'Avenir Next',Avenir,system-ui,sans-serif; cursor:pointer; transition:border-color .12s,color .12s; }
            .ar-gentoggle:hover { border-color:var(--accent-primary,#5eadb8); color:var(--text-primary,#e6edf3); }
            .ar-gentoggle-act { color:var(--accent-primary,#5eadb8); font-weight:700; }
            .ar-gen-group { position:relative; margin:2px 0; }
            /* Collapsed group sits on the SAME spine as individual run rows:
               30px left gutter holds its robot marker, content starts at the
               row grid (matching .ar-span's caret) so the left column doesn't
               zigzag when groups and single rows interleave. */
            .ar-gen-group-head { position:relative; display:flex; align-items:center; gap:9px; width:100%; text-align:left; cursor:pointer;
                padding:7px 11px 7px 30px; border-radius:8px; border:1px solid var(--border-default,#30363d);
                background:color-mix(in srgb, var(--accent-primary,#5eadb8) 6%, var(--bg-card,#161b22));
                color:var(--text-secondary,#b1bac4); transition:background .12s,border-color .12s; }
            .ar-gen-group-dot { position:absolute; left:3px; top:50%; transform:translateY(-50%);
                display:flex; align-items:center; justify-content:center; width:16px; height:16px; }
            .ar-gen-group-head:hover { border-color:var(--accent-primary,#5eadb8); background:var(--bg-hover,#21262d); }
            .ar-gen-group.open > .ar-gen-group-head .ar-caret { transform:rotate(90deg); color:var(--accent-primary,#5eadb8); }
            .ar-gen-group-n { font:700 12px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3); }
            .ar-gen-group-meta { font:11px ui-monospace,'JetBrains Mono',Menlo,monospace; color:var(--text-muted,#7d8590);
                font-variant-numeric:tabular-nums; }
            .ar-gen-group-body { padding-left:14px; margin-top:2px; border-left:2px solid color-mix(in srgb, var(--accent-primary,#5eadb8) 30%, transparent); }
            /* --- Nested trace tree (Pillar 1): tool runs indented under the LLM
               run that requested them. v5.1 stepped drilldown: each child hangs
               off the parent spine with an explicit ELBOW connector (vertical
               rail + horizontal tick into the child's dot), so parent→child
               reads as drawn structure, not just indentation. --- */
            .ar-turn-children { margin-left:7px; padding-left:24px; }
            .ar-turn-children .ar-span::before { display:block; left:-24px; top:-20px; bottom:0; width:2px;
                background:color-mix(in srgb, var(--accent-primary,#5eadb8) 30%, transparent); }
            /* Rail stops AT the last child's elbow — no dangling tail. */
            .ar-turn-children .ar-span:last-child::before { display:block; height:34px; bottom:auto; }
            .ar-turn-children .ar-span::after { content:''; position:absolute; left:-24px; top:12px; width:22px; height:2px;
                background:color-mix(in srgb, var(--accent-primary,#5eadb8) 30%, transparent); }
            .ar-turn-children .ar-span:last-child { padding-bottom:6px; }
            /* One STEP = one LLM turn + the tool calls it triggered. The wrapper
               breaks the spine between steps so the trace reads as numbered,
               bounded steps (CrowdStrike-drilldown style) instead of one
               undifferentiated column. */
            .ar-step { margin:0 0 10px; border-radius:10px; transition:background .14s; }
            .ar-step:hover { background:color-mix(in srgb, var(--bg-hover,#21262d) 45%, transparent); }
            /* The children's rail is the step's connector — drop the parent
               row's own gray spine so the two don't double-draw. */
            .ar-step > .ar-span-gen::before { display:none; }
            /* Numbered step node on the spine — the step's chronological index
               (1 = first thing that happened), replacing the anonymous robot
               dot when tree view can number the turn. */
            .ar-step-dot { display:flex; align-items:center; justify-content:center;
                font:700 9px ui-monospace,'JetBrains Mono',Menlo,monospace; letter-spacing:-.3px;
                color:var(--accent-primary,#5eadb8); font-variant-numeric:tabular-nums; }
            /* Honest per-run timing: "+2.3s" = this run STARTED that long after
               the previous run (wall clock between starts: we don't have
               per-run latency and never fake it). */
            .ar-delta { flex:0 0 auto; font:600 10px ui-monospace,'JetBrains Mono',Menlo,monospace;
                color:var(--text-muted,#7d8590); font-variant-numeric:tabular-nums; min-width:46px; text-align:right; }
            .ar-delta.first { color:color-mix(in srgb, var(--accent-primary,#5eadb8) 70%, var(--text-muted,#7d8590));
                letter-spacing:.5px; text-transform:uppercase; font-size:9px; }
            /* Position mini-timeline: WHERE in the trace window this run
               happened (tick position = start time, not a duration bar). */
            .ar-tl { flex:0 0 auto; position:relative; width:72px; height:6px; border-radius:3px;
                background:color-mix(in srgb, var(--border-default,#30363d) 60%, transparent); overflow:hidden; }
            .ar-tl i { position:absolute; top:0; bottom:0; width:5px; border-radius:2px; }
            .ar-tl i.ar-tl-bar { min-width:3px; border-radius:3px; opacity:.92; }
            @media (max-width:980px) { .ar-tl { display:none; } .ar-delta { min-width:0; } }
            /* Replay visibility: hide events past the playhead; spotlight current. */
            .ar-replay-hidden { display:none !important; }
            .ar-replay-current > .ar-span-row { background:color-mix(in srgb, var(--accent-primary,#5eadb8) 15%, transparent);
                box-shadow:inset 3px 0 0 var(--accent-primary,#5eadb8); border-radius:8px; }
            /* Expandable per-step detail panel. */
            .ar-detail-body { margin-top:10px; padding:12px 14px; border:1px solid var(--border-default,#30363d);
                border-radius:10px; background:var(--bg-tertiary,#0d1117); display:none; }
            .ar-span.open .ar-detail-body { display:block; animation:arFade .16s ease-out; }
            .ar-kv { display:grid; grid-template-columns:104px 1fr; gap:6px 14px; font-size:12px; }
            .ar-kv dt { color:var(--text-muted,#7d8590); font-weight:600; }
            .ar-kv dd { margin:0; color:var(--text-primary,#e6edf3); word-break:break-word;
                font-family:ui-monospace,'JetBrains Mono','SF Mono',Menlo,monospace; }
            .ar-args { margin-top:11px; }
            .ar-args-label { font-size:10px; letter-spacing:.5px; text-transform:uppercase; color:var(--text-muted,#7d8590); margin-bottom:4px; }
            .ar-args pre { margin:0; padding:9px 11px; border-radius:8px; background:var(--bg-card,#161b22);
                border:1px solid var(--border-default,#30363d); color:var(--text-secondary,#b1bac4);
                font:11.5px ui-monospace,'JetBrains Mono','SF Mono',Menlo,monospace; white-space:pre-wrap; word-break:break-word;
                max-height:220px; overflow:auto; }
            /* Scanned-content panel: the LLM I/O excerpt SecureVector actually
               inspected for this call (lazy-loaded from threat-intel records). */
            .ar-scan { margin-top:11px; }
            .ar-scan-note { font-size:11.5px; color:var(--text-muted,#7d8590); line-height:1.5; }
            .ar-scan-item { margin-bottom:8px; }
            .ar-scan-item:last-child { margin-bottom:0; }
            .ar-scan-meta { font-size:10.5px; color:var(--text-muted,#7d8590); margin-bottom:3px; }
            .ar-scan-item pre { margin:0; padding:9px 11px; border-radius:8px; background:var(--bg-card,#161b22);
                border:1px solid var(--border-default,#30363d); color:var(--text-secondary,#b1bac4);
                font:11.5px ui-monospace,'JetBrains Mono','SF Mono',Menlo,monospace; white-space:pre-wrap; word-break:break-word;
                max-height:260px; overflow:auto; }
            .ar-turn { font-family:ui-monospace,'JetBrains Mono',Menlo,monospace; font-size:11px; color:var(--text-muted,#7d8590); min-width:26px; }
            .ar-badge { font:700 10px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.5px; padding:3px 9px; border-radius:20px; display:inline-flex; align-items:center; gap:4px; }
            .ar-time { margin-left:auto; font-size:11px; color:var(--text-muted,#7d8590); white-space:nowrap; font-variant-numeric:tabular-nums; }
            .ar-reason { margin-top:4px; margin-left:30px; font-size:11.5px; color:var(--text-secondary,#b1bac4); }
            .ar-reason.blk { color:var(--danger,#ef4444); }
            /* Inline reason on the span row (same line as tool/verdict). */
            .ar-reason-inline { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
                font-size:11.5px; color:var(--text-secondary,#b1bac4); }
            .ar-reason-inline.blk { color:var(--danger,#ef4444); }
            /* Detection sub-row — nested under the tool-call span as its own
               activity. Coloured left-rail (red threat / amber secret) so it
               reads as a flag ON the call, never as the call's own verdict. */
            .ar-span-detection { display:flex; align-items:center; gap:8px; flex-wrap:wrap;
                margin:5px 0 0 6px; padding:4px 10px 4px 9px; border-radius:7px; font-size:12px;
                border-left:2.5px solid; width:fit-content; max-width:100%; }
            .ar-span-detection.det-threat { border-left-color:#ef4444; background:rgba(239,68,68,0.09); }
            .ar-span-detection.det-secret { border-left-color:#f59e0b; background:rgba(245,158,11,0.09); }
            .ar-det-what { font:700 11.5px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3); }
            .ar-det-rules { font-size:11px; color:var(--text-secondary,#b1bac4); }
            /* Mechanism 1 FP-triage pill on the detection row. */
            .ar-det-fp { font:700 10px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.2px;
                padding:2px 7px; border-radius:20px; color:#f59e0b; background:rgba(245,158,11,0.15); }
            .ar-det-fp.uncertain { color:var(--text-muted,#7d8590); background:rgba(125,133,144,0.15); }
            .ar-det-clickable { cursor:pointer; }
            .ar-det-clickable:hover { filter:brightness(1.15); }
            .ar-det-view { font:600 11px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--accent-primary,#5eadb8); opacity:.85; }
            .ar-det-clickable:hover .ar-det-view { opacity:1; text-decoration:underline; }
            /* Allowed-vs-blocked outcome pill ON the detection — the key
               "detected ≠ blocked" clarity fix. Amber = ran anyway (act on it),
               muted green = stopped. */
            .ar-det-outcome { font:700 10px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.3px;
                padding:2px 7px; border-radius:20px; text-transform:uppercase; }
            .ar-det-outcome.allowed { color:#f59e0b; background:rgba(245,158,11,0.15); }
            .ar-det-outcome.blocked { color:#10b981; background:rgba(16,185,129,0.15); }
            /* Flag strip — one-click jump-to-detections in a long run. */
            .ar-flag-strip { display:flex; flex-wrap:wrap; gap:8px; margin:10px 0 4px; }
            .ar-flag-chip { display:inline-flex; align-items:center; gap:5px; cursor:pointer;
                font:600 12px 'Avenir Next',Avenir,system-ui,sans-serif; padding:4px 11px; border-radius:20px;
                border:1px solid var(--border-default,#30363d); background:var(--bg-secondary,#161b22);
                color:var(--text-secondary,#b1bac4); transition:background .12s,border-color .12s; }
            .ar-flag-chip b { color:var(--text-primary,#e6edf3); }
            .ar-flag-chip:hover { background:var(--bg-hover,#21262d); }
            .ar-flag-chip.threat.active { border-color:#ef4444; background:rgba(239,68,68,0.12); }
            .ar-flag-chip.secret.active { border-color:#f59e0b; background:rgba(245,158,11,0.12); }
            .ar-flag-chip.blocked.active { border-color:#10b981; background:rgba(16,185,129,0.12); }
            .ar-flag-chip.clear { color:var(--text-muted,#7d8590); }
            .ar-empty { padding:60px 18px; text-align:center; color:var(--text-secondary,#94a3b8); }
            /* Runtime drill-down filter chip (set by a Map agent-node click) */
            .ar-filter-chip { display:inline-flex; align-items:center; gap:7px; cursor:pointer; align-self:flex-start;
                border:1px solid var(--accent-primary,#5eadb8); border-radius:999px; padding:5px 11px; margin-bottom:3px;
                background:color-mix(in srgb, var(--accent-primary,#5eadb8) 12%, var(--bg-card,#161b22));
                color:var(--text-primary,#e6edf3); font:600 12px 'Avenir Next',Avenir,system-ui,sans-serif;
                transition:background .14s,border-color .14s; }
            .ar-filter-chip:hover { background:color-mix(in srgb, var(--accent-primary,#5eadb8) 20%, var(--bg-card,#161b22)); }
            .ar-filter-chip b { font-weight:700; }
            .ar-chip-dot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; }
            .ar-chip-x { margin-left:2px; font-size:11px; color:var(--text-secondary,#b1bac4); }
            .ar-filter-chip:hover .ar-chip-x { color:var(--text-primary,#e6edf3); }
            /* Tool-kind checkbox filter */
            .ar-kind-checks { display:inline-flex; align-items:center; gap:14px; }
            .ar-check { display:inline-flex; align-items:center; gap:6px; cursor:pointer;
                font:600 12.5px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3); user-select:none; }
            .ar-check input { width:14px; height:14px; cursor:pointer; accent-color:var(--accent-primary,#5eadb8); margin:0; }
            .ar-check-dot { width:9px; height:9px; border-radius:50%; flex:0 0 auto; }
            /* --- Triage quick views (list-level saved views) --- */
            .ar-view-chips { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:2px 0 4px; }
            .ar-view-chip { display:inline-flex; align-items:center; cursor:pointer;
                font:600 11.5px 'Avenir Next',Avenir,system-ui,sans-serif; padding:4px 12px; border-radius:999px;
                border:1px solid var(--border-default,#30363d); background:var(--bg-secondary,#161b22);
                color:var(--text-secondary,#b1bac4); transition:background .12s,border-color .12s,color .12s; }
            .ar-view-chip b { font:700 11.5px ui-monospace,'JetBrains Mono',Menlo,monospace;
                font-variant-numeric:tabular-nums; color:var(--text-primary,#e6edf3); }
            .ar-view-chip:hover { background:var(--bg-hover,#21262d); }
            .ar-view-chip.active { border-color:var(--accent-primary,#5eadb8);
                background:color-mix(in srgb, var(--accent-primary,#5eadb8) 14%, var(--bg-card,#161b22));
                color:var(--text-primary,#e6edf3); }
            .ar-more-views { position:relative; }
            .ar-more-views summary { list-style:none; cursor:pointer; border:1px solid var(--border-default,#30363d);
                border-radius:999px; padding:4px 10px; color:var(--text-secondary,#b1bac4);
                background:var(--bg-card,#161b22); font:600 11.5px 'Avenir Next',Avenir,system-ui,sans-serif; }
            .ar-more-views summary::-webkit-details-marker { display:none; }
            .ar-more-views summary::after { content:'⌄'; margin-left:6px; }
            .ar-more-views summary:hover, .ar-more-views[open] summary { border-color:var(--accent-primary,#5eadb8); color:var(--text-primary,#e6edf3); }
            .ar-more-views summary:focus-visible { outline:2px solid var(--accent-primary,#5eadb8); outline-offset:2px; }
            .ar-more-menu { position:absolute; z-index:30; top:calc(100% + 4px); left:0; min-width:150px;
                display:flex; flex-direction:column; gap:3px; padding:5px; border:1px solid var(--border-default,#30363d);
                border-radius:8px; background:var(--bg-card,#161b22); box-shadow:var(--shadow-lg,0 8px 24px rgba(0,0,0,.4)); }
            .ar-more-menu .ar-view-chip { justify-content:space-between; border-radius:6px; }
            /* --- Session minimap (trace summary strip) --- */
            .ar-minimap { display:flex; align-items:center; gap:10px; margin:8px 0 2px;
                padding:6px 10px; border:1px solid var(--border-default,#30363d); border-radius:10px;
                background:var(--bg-secondary,#161b22); }
            .ar-mini-track { position:relative; flex:1; height:34px; min-width:0; cursor:pointer; }
            .ar-mini-canvas { position:absolute; inset:0; width:100%; height:100%; display:block; }
            .ar-mini-tick { position:absolute; top:2px; bottom:2px; width:5px; margin-left:-2.5px;
                padding:0; border:none; border-radius:2px; cursor:pointer; background:#ef4444; opacity:.9;
                transition:opacity .12s, transform .12s; }
            .ar-mini-tick.sec { background:#f59e0b; }
            .ar-mini-tick:hover { opacity:1; transform:scaleX(1.6); }
            .ar-mini-time { flex:0 0 auto; font:10.5px ui-monospace,'JetBrains Mono',Menlo,monospace;
                color:var(--text-muted,#7d8590); white-space:nowrap; font-variant-numeric:tabular-nums; }
            .ar-mini-nav { display:inline-flex; align-items:center; gap:4px; flex:0 0 auto; margin-left:2px; }
            .ar-mini-navbtn { width:22px; height:22px; display:inline-flex; align-items:center; justify-content:center;
                cursor:pointer; border:1px solid var(--border-default,#30363d); border-radius:6px;
                background:var(--bg-card,#161b22); color:var(--text-secondary,#b1bac4);
                font:700 13px 'Avenir Next',Avenir,system-ui,sans-serif; line-height:1; padding:0 0 2px; }
            .ar-mini-navbtn:hover { background:var(--bg-hover,#21262d); color:var(--text-primary,#e6edf3);
                border-color:var(--accent-primary,#5eadb8); }
            .ar-mini-count { font:600 10.5px ui-monospace,'JetBrains Mono',Menlo,monospace;
                color:var(--text-secondary,#b1bac4); white-space:nowrap; font-variant-numeric:tabular-nums;
                min-width:52px; text-align:center; }
            /* Jump-flash: two soft pulses on the row the minimap landed on.
               Teal (attention), not a security color. */
            @keyframes arJumpHit {
                0%, 55% { box-shadow:0 0 0 2px color-mix(in srgb, var(--accent-primary,#5eadb8) 65%, transparent);
                          background:color-mix(in srgb, var(--accent-primary,#5eadb8) 10%, transparent); }
                27%, 100% { box-shadow:0 0 0 2px transparent; background:transparent; }
            }
            .ar-jump-hit { animation:arJumpHit 1.6s ease-out 1; border-radius:8px; }
            /* --- Chat-style LLM turn I/O --- */
            .ar-chat { display:flex; flex-direction:column; gap:8px; margin-bottom:10px; }
            .ar-msg { max-width:88%; border:1px solid var(--border-default,#30363d); border-radius:12px;
                padding:7px 10px 8px; background:var(--bg-secondary,#161b22); }
            .ar-msg.prompt { align-self:flex-start; border-top-left-radius:4px; }
            .ar-msg.model { align-self:flex-end; border-top-right-radius:4px;
                border-color:color-mix(in srgb, var(--accent-primary,#5eadb8) 45%, var(--border-default,#30363d));
                background:color-mix(in srgb, var(--accent-primary,#5eadb8) 7%, var(--bg-secondary,#161b22)); }
            .ar-msg.tool { align-self:flex-start; max-width:82%; margin-left:14px; border-radius:10px;
                border-style:dashed; background:transparent; }
            .ar-msg-role { display:flex; align-items:center; gap:5px; margin-bottom:4px;
                font:700 9.5px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.8px;
                text-transform:uppercase; color:var(--text-muted,#7d8590); }
            .ar-msg.model .ar-msg-role { color:var(--accent-primary,#5eadb8); }
            .ar-msg .ar-gen-pre { margin:0; border:none; background:transparent; padding:0; }
            .ar-msg .ar-gen-note { margin:0; }
            /* --- Per-row gap bar (inline duration signal) --- */
            .ar-gapbar { flex:0 0 auto; width:52px; height:3.5px; border-radius:2px; overflow:hidden;
                background:color-mix(in srgb, var(--border-default,#30363d) 60%, transparent); }
            .ar-gapbar i { display:block; height:100%; border-radius:2px;
                background:var(--text-muted,#7d8590); opacity:.75; }
            .ar-gapbar.first { visibility:hidden; }
            @media (max-width:1100px) { .ar-gapbar { display:none; } }
            /* ---- Runs list (6.0) ------------------------------------------ */
            .ar-layout.runs-v2.split { display:block; }
            .ar-layout.runs-v2.trace-open .ar-listview { display:none; }
            .ar-layout.runs-v2:not(.trace-open) .ar-pane { display:none; }
            .ar-layout.runs-v2 .ar-listview { position:static; height:auto; max-height:none; overflow:visible;
                background:none; border:0; border-radius:0; padding:0; gap:12px; }
            .ar-layout.runs-v2 .ar-pane-empty { display:none !important; }
            .rl-back { align-self:flex-start; margin:0 0 8px; font:inherit; font-size:13px; padding:4px 10px; min-height:30px;
                border:1px solid var(--border-default,#232a33); border-radius:6px; background:var(--bg-card,#12171e);
                color:var(--text-secondary,#aeb7c2); cursor:pointer; }
            .rl-back:hover { color:var(--text-primary,#eef2f7); border-color:var(--accent-primary,#5eadb8); }
            .rl-head { display:flex; align-items:center; gap:10px 14px; flex-wrap:wrap; }
            .rl-title { margin:0; font-size:20px; font-weight:650; color:var(--text-primary,#eef2f7); }
            .rl-toolbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-left:auto; }
            .rl-search { font:inherit; font-size:13px; min-height:34px; width:260px; max-width:100%; padding:6px 10px; box-sizing:border-box;
                border:1px solid var(--border-default,#232a33); border-radius:6px; background:var(--bg-card,#12171e); color:var(--text-primary,#eef2f7); }
            .rl-search:focus-visible, .rl-btn:focus-visible, .rl-link:focus-visible, .rl-row:focus-visible, .rl-sort:focus-visible,
            .rl-copy:focus-visible, .rl-caret-btn:focus-visible, .rl-opt:focus-visible, .rl-back:focus-visible {
                outline:2px solid var(--accent-primary,#5eadb8); outline-offset:1px; }
            .rl-check { display:inline-flex; align-items:center; gap:6px; font-size:13px; color:var(--text-secondary,#aeb7c2); cursor:pointer; white-space:nowrap; }
            .rl-check input { accent-color:var(--accent-primary,#5eadb8); width:15px; height:15px; margin:0; }
            .rl-toolbar .rl-range { height:34px; width:auto; font-size:13px; }
            .rl-btn { font:inherit; font-size:13px; padding:6px 12px; min-height:34px; border-radius:6px; box-sizing:border-box;
                border:1px solid var(--border-default,#232a33); background:var(--bg-card,#12171e); color:var(--text-secondary,#aeb7c2);
                cursor:pointer; white-space:nowrap; display:inline-flex; align-items:center; gap:4px; }
            .rl-btn:hover:not(:disabled) { color:var(--text-primary,#eef2f7); }
            .rl-btn:disabled { opacity:.45; cursor:default; }
            .rl-btn.on { border-color:var(--accent-primary,#5eadb8); color:var(--text-primary,#eef2f7);
                background:color-mix(in srgb, var(--accent-primary,#5eadb8) 16%, var(--bg-card,#12171e)); }
            .rl-k { color:var(--text-muted,#7f8a97); }
            .rl-btn.on .rl-k { color:var(--text-secondary,#aeb7c2); }
            .rl-caret { font-size:10px; margin-left:2px; }
            .rl-dd { position:relative; display:inline-flex; }
            .rl-menu { position:absolute; left:0; top:calc(100% + 4px); z-index:40; min-width:210px; max-height:320px; overflow:auto;
                padding:4px; border-radius:8px; background:var(--bg-elevated,#1a2029); border:1px solid var(--border-light,#303844);
                box-shadow:var(--shadow-lg,0 8px 24px rgba(0,0,0,.4)); display:flex; flex-direction:column; }
            .rl-menu[hidden] { display:none; }
            .rl-toolbar .rl-menu { left:auto; right:0; }
            .rl-opt { display:flex; align-items:center; gap:8px; width:100%; text-align:left; font:inherit; font-size:13px; min-height:30px;
                padding:4px 8px; border:0; border-radius:5px; background:none; color:var(--text-secondary,#aeb7c2); cursor:pointer; }
            .rl-opt:hover { background:var(--bg-hover,#1b212b); color:var(--text-primary,#eef2f7); }
            .rl-opt[aria-pressed="true"] { color:var(--text-primary,#eef2f7); }
            .rl-tick { width:12px; color:var(--accent-primary,#5eadb8); }
            .rl-opt-l { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            .rl-opt-n { color:var(--text-muted,#7f8a97); font-size:12px; font-variant-numeric:tabular-nums; }
            .rl-opt-empty { padding:8px; font-size:12.5px; color:var(--text-muted,#7f8a97); }
            .rl-view-line { display:flex; align-items:center; }
            .rl-view-del { font:inherit; border:0; background:none; color:var(--text-muted,#7f8a97); cursor:pointer; padding:2px 8px; }
            .rl-view-del:hover { color:var(--text-primary,#eef2f7); }
            .rl-view-form { display:flex; gap:6px; padding:6px 4px 2px; border-top:1px solid var(--border-default,#232a33); margin-top:4px; }
            .rl-view-form input { flex:1 1 auto; min-width:0; font:inherit; font-size:13px; padding:4px 8px; border-radius:5px;
                border:1px solid var(--border-default,#232a33); background:var(--bg-card,#12171e); color:var(--text-primary,#eef2f7); }
            .rl-filters { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
            .rl-chip { display:inline-flex; align-items:center; gap:6px; font-size:12px; padding:4px 8px; border-radius:14px;
                border:1px solid var(--accent-primary,#5eadb8); color:var(--text-primary,#eef2f7);
                background:color-mix(in srgb, var(--accent-primary,#5eadb8) 16%, var(--bg-card,#12171e)); }
            .rl-chip button { font:inherit; background:none; border:0; color:var(--text-secondary,#aeb7c2); cursor:pointer; padding:0 2px; }
            .rl-link { font:inherit; font-size:13px; background:none; border:0; padding:0; cursor:pointer; color:var(--accent-primary,#5eadb8); }
            .rl-link:hover { text-decoration:underline; }
            .rl-cards { display:grid; grid-template-columns:repeat(5, minmax(0,1fr)); gap:10px; }
            @media (max-width:900px) { .rl-cards { grid-template-columns:repeat(2, minmax(0,1fr)); } }
            .rl-card { display:flex; flex-direction:column; gap:6px; padding:12px 14px; min-width:0;
                border:1px solid var(--border-default,#232a33); border-radius:8px; background:var(--bg-card,#12171e); }
            .rl-card-k { font-size:12px; color:var(--text-muted,#7f8a97); }
            .rl-card-v { font-size:20px; font-weight:650; color:var(--text-primary,#eef2f7); }
            .rl-card-sub { font-size:13px; font-weight:400; color:var(--text-muted,#7f8a97); }
            .rl-card svg { width:100%; height:32px; display:block; }
            .rl-amb-t { color:color-mix(in srgb, var(--warning,#f59e0b) 75%, var(--text-primary,#eef2f7)); }
            .rl-red-t { color:color-mix(in srgb, var(--danger,#ef4444) 70%, var(--text-primary,#eef2f7)); }
            .rl-status { display:flex; align-items:center; gap:10px; flex-wrap:wrap; font-size:12px; color:var(--text-muted,#7f8a97); }
            .rl-status .rl-link { font-size:12px; }
            .rl-dot { color:var(--text-muted,#7f8a97); }
            .rl-dot.on { color:var(--accent-primary,#5eadb8); }
            .rl-tablewrap { border:1px solid var(--border-default,#232a33); border-radius:8px; overflow-x:auto; background:var(--bg-card,#12171e); }
            .ar-runlist.rl-table { display:block; gap:0; padding:0; min-width:940px; }
            .rl-table { --rl-cols:62px minmax(0,1.4fr) minmax(0,1.5fr) 150px 74px 62px 62px; }
            .rl-table.rl-flatlist { --rl-cols:56px minmax(0,1fr) minmax(0,1.1fr) minmax(0,.7fr) minmax(0,1.5fr) 150px 66px 56px 60px; min-width:1040px; }
            .rl-hd, .rl-row { display:grid; grid-template-columns:var(--rl-cols); gap:12px; align-items:center; padding:9px 14px; }
            .rl-hd { font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted,#7f8a97);
                border-bottom:1px solid var(--border-default,#232a33); }
            .rl-hd .rl-c { white-space:nowrap; }
            .rl-sort { font:inherit; letter-spacing:inherit; text-transform:inherit; background:none; border:0; padding:0; color:inherit; cursor:pointer; text-align:left; }
            .rl-sort.rl-r { text-align:right; }
            .rl-sort[aria-pressed="true"], .rl-sort:hover { color:var(--text-primary,#eef2f7); }
            .rl-row { position:relative; width:100%; font:inherit; font-size:13px; text-align:left; color:var(--text-primary,#eef2f7);
                background:none; border:0; border-bottom:1px solid var(--border-default,#232a33); cursor:pointer; }
            .rl-row:hover { background:var(--bg-hover,#1b212b); }
            .rl-row.sel { background:color-mix(in srgb, var(--accent-primary,#5eadb8) 10%, transparent); }
            /* Session tree, drawn like the trace span tree: a guide from the
               session caret (centre 26px) down through its runs, a connector
               into each run, an elbow on the last one. */
            .rl-guide { position:absolute; left:26px; top:0; bottom:0; border-left:1px solid var(--border-light,#303844); }
            .rl-conn { position:absolute; left:26px; top:50%; width:22px; border-top:1px solid var(--border-light,#303844); }
            .rl-last > .rl-guide { bottom:50%; }
            .rl-row.rl-child { padding-left:58px; }
            .rl-table:not(.rl-flatlist) .rl-hd { padding-left:58px; }
            .rl-morerow { position:relative; display:flex; align-items:center; min-height:34px; padding:4px 14px 4px 54px; font-size:12.5px;
                border-bottom:1px solid var(--border-default,#232a33); }
            .rl-sh-guide { position:absolute; left:26px; top:calc(50% + 12px); bottom:-1px; border-left:1px solid var(--border-light,#303844); pointer-events:none; }
            .rl-c { min-width:0; }
            .rl-r { text-align:right; font-variant-numeric:tabular-nums; }
            .rl-num { font-variant-numeric:tabular-nums; }
            .rl-sub { color:var(--text-secondary,#aeb7c2); }
            .rl-mute { color:var(--text-muted,#7f8a97); }
            .rl-mono { font-family:ui-monospace,'SF Mono',Menlo,monospace; }
            .rl-ell { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            .rl-name { display:flex; align-items:center; gap:6px; overflow:hidden; }
            .rl-name .ar-run-rt { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:0 1 auto; min-width:52px; }
            .rl-stcell { display:flex; gap:6px; flex-wrap:wrap; align-items:center; font-size:12px; }
            .rl-st { color:var(--text-muted,#7f8a97); font-size:13px; }
            .rl-b { font-size:12px; padding:1px 7px; border-radius:4px; white-space:nowrap; }
            .rl-amb { background:color-mix(in srgb, var(--warning,#f59e0b) 15%, transparent); border:1px solid color-mix(in srgb, var(--warning,#f59e0b) 45%, transparent);
                color:color-mix(in srgb, var(--warning,#f59e0b) 75%, var(--text-primary,#eef2f7)); }
            .rl-red { background:color-mix(in srgb, var(--danger,#ef4444) 14%, transparent); border:1px solid color-mix(in srgb, var(--danger,#ef4444) 45%, transparent);
                color:color-mix(in srgb, var(--danger,#ef4444) 70%, var(--text-primary,#eef2f7)); }
            .rl-sh { position:relative; display:flex; align-items:center; gap:8px 12px; flex-wrap:wrap; padding:9px 14px; font-size:13px;
                background:var(--bg-secondary,#0e1218); border-bottom:1px solid var(--border-default,#232a33); color:var(--text-primary,#eef2f7); }
            .rl-caret-btn { font:inherit; font-size:12px; line-height:1; flex:0 0 24px; width:24px; height:24px; display:inline-flex; align-items:center; justify-content:center;
                border:0; border-radius:4px; background:none; color:var(--text-secondary,#aeb7c2); cursor:pointer; padding:0; margin-right:-4px; }
            .rl-caret-btn:hover { background:var(--bg-hover,#1b212b); color:var(--text-primary,#eef2f7); }
            .rl-caret-btn svg { transition:transform .12s ease; }
            .rl-caret-btn[aria-expanded="true"] svg { transform:rotate(90deg); }
            .rl-copy { font:inherit; font-size:12px; min-height:24px; padding:1px 7px; border-radius:6px; cursor:pointer;
                border:1px solid var(--border-default,#232a33); background:var(--bg-card,#12171e); color:var(--text-secondary,#aeb7c2); }
            .rl-cov { font-size:11px; padding:1px 7px; border-radius:10px; white-space:nowrap;
                border:1px solid var(--border-light,#303844); color:var(--text-secondary,#aeb7c2); }
            .rl-sh-right { margin-left:auto; display:flex; gap:14px; }
            .rl-pager { display:flex; align-items:center; gap:8px; justify-content:flex-start; font-size:12.5px; }
            .rl-pager .rl-sub { margin-right:4px; }
            .ar-layout.runs-v2 .ar-listview { padding-bottom:80px; }
            .rl-page { min-width:34px; justify-content:center; }
            .live-grid-placeholder { margin:0; }
        `;
        document.head.appendChild(st);
    },

    _buildToolbar(bar) {
        bar.textContent = '';
        const RL = RunsList;
        // Search: free text, session:, harness:, project:, decision:, or a
        // span hash (Enter looks it up inside the runs in view).
        const search = document.createElement('input');
        search.type = 'search';
        search.id = 'rl-search';
        search.className = 'rl-search';
        search.placeholder = 'Search runs';
        search.setAttribute('aria-label', 'Search runs. Use session:, harness:, project:, decision:, or paste a span hash');
        search.title = 'Search runs. session:<id> harness:<name> project:<name> decision:waiting|blocked|allowed, or a span hash';
        search.value = this.filters.search || '';
        clearTimeout(this._searchTimer);
        search.addEventListener('input', () => {
            clearTimeout(this._searchTimer);
            this._searchTimer = setTimeout(() => { this._searchTimer = null; this.filters.search = search.value; this.pageIdx = 0; this.renderRuns(); }, 180);
        });
        search.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            clearTimeout(this._searchTimer);
            this.filters.search = search.value;
            this.pageIdx = 0;
            this.renderRuns();
            const q = RL.parseSearch(search.value);
            if (q.text && RL.looksLikeHash(q.text) && !this._filteredRuns().length) this._findSpanHash(q.text);
        });
        bar.appendChild(search);

        const grp = document.createElement('label');
        grp.className = 'rl-check';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!this.groupBySession;
        cb.addEventListener('change', () => { this.groupBySession = cb.checked; this.pageIdx = 0; this.renderRuns(); });
        grp.appendChild(cb);
        grp.appendChild(document.createTextNode(' Group by session'));
        bar.appendChild(grp);

        const sel = document.createElement('select');
        sel.className = 'filter-select rl-range';
        sel.setAttribute('aria-label', 'Time range');
        Object.entries(RL.RANGES).forEach(([k, r]) => {
            if (r.hidden && k !== this.range) return;
            const o = document.createElement('option');
            o.value = k; o.textContent = r.label;
            if (k === this.range) o.selected = true;
            sel.appendChild(o);
        });
        sel.addEventListener('change', () => {
            this.range = sel.value;
            this.pageIdx = 0;
            const days = (RL.RANGES[this.range] || RL.RANGES['24h']).days;
            if (days !== this.windowDays) { this.windowDays = days; this.loadData(); }
            else this.renderRuns();
        });
        bar.appendChild(sel);
        this._rangeSel = sel;

        // Saved views: name plus the current filters, kept in this browser.
        bar.appendChild(this._dropdown({
            value: 'Views', title: 'Saved views in this browser',
            build: (menu, close) => {
                const views = RL.loadViews();
                if (!views.length) {
                    const e = document.createElement('div');
                    e.className = 'rl-opt-empty';
                    e.textContent = 'No saved views yet';
                    menu.appendChild(e);
                }
                views.forEach(v => {
                    const line = document.createElement('div');
                    line.className = 'rl-view-line';
                    const b = this._menuOption(line, v.name, null, false, () => { close(); this._applyView(v); });
                    b.title = `Apply the view ${v.name}`;
                    const del = document.createElement('button');
                    del.type = 'button';
                    del.className = 'rl-view-del';
                    del.setAttribute('aria-label', `Delete the view ${v.name}`);
                    del.textContent = '×';
                    del.addEventListener('click', () => { RL.deleteView(v.name); line.remove(); });
                    line.appendChild(del);
                    menu.appendChild(line);
                });
                const form = document.createElement('form');
                form.className = 'rl-view-form';
                form.innerHTML = '<input type="text" maxlength="40" placeholder="View name" aria-label="Name for this view">' +
                    '<button type="submit" class="rl-btn">Save current</button>';
                form.addEventListener('submit', (e) => {
                    e.preventDefault();
                    const name = form.querySelector('input').value;
                    const ok = RL.saveView(name, this._viewState());
                    if (window.Toast) (ok ? Toast.success || Toast.info : Toast.error).call(Toast, ok ? `Saved the view ${name.trim()}` : 'This browser did not let the view be saved');
                    if (ok) close();
                });
                menu.appendChild(form);
            },
        }));

        const exp = ObsTabs.exportMenu([
            { label: 'Audit report (PDF)', onClick: () => this._exportAuditReport() },
            { label: 'This trace (CSV)', onClick: () => this._exportCSV() },
            { label: 'This trace (PDF)', onClick: () => this._exportPDF() },
        ]);
        bar.appendChild(exp);
    },

    _viewState() {
        return { filters: this.filters, range: this.range, groupBySession: this.groupBySession, sortKey: this.sortKey, sortDir: this.sortDir };
    },

    _applyView(v) {
        const s = (v && v.filters) || {};
        const base = RunsList.emptyFilters();
        const f = Object.assign(base, s.filters || {});
        Object.keys(base).forEach(k => { if (Array.isArray(base[k]) && !Array.isArray(f[k])) f[k] = []; });
        this.filters = f;
        this.groupBySession = s.groupBySession !== false;
        if (s.sortKey) { this.sortKey = s.sortKey; this.sortDir = s.sortDir === 'asc' ? 'asc' : 'desc'; }
        this.pageIdx = 0;
        const range = RunsList.RANGES[s.range] ? s.range : this.range;
        const days = RunsList.RANGES[range].days;
        this.range = range;
        const bar = document.getElementById('agent-runs-toolbar');
        if (bar) this._buildToolbar(bar);
        if (days !== this.windowDays) { this.windowDays = days; this.loadData(); } else this.renderRuns();
    },

    /** Page-level compliance report over EVERY session in the window (folded in
     *  from the retired Sessions page): totals, per-agent rollup, policies
     *  fired (blocked-action ledger), all sessions, and the redaction posture. */
    async _exportAuditReport() {
        const runs = this.runs || [];
        if (!runs.length) { if (window.Toast) Toast.error('No sessions to export'); return; }
        const rows = runs.slice().sort((a, b) => String(b.ended_at).localeCompare(String(a.ended_at))).map(r => ({
            runtime: r.runtime_kind || 'unknown', session_id: r.session_id || '', trace_id: r.trace_id || '',
            steps: r.spans || 0, blocked: r.blocked || 0, risk: r.risk || 'green',
            started: this._fmtTime(r.started_at), ended: this._fmtTime(r.ended_at),
        }));
        const byRt = {};
        runs.forEach(r => { const k = r.runtime_kind || 'unknown'; (byRt[k] = byRt[k] || { sessions: 0, steps: 0, blocked: 0 }); byRt[k].sessions++; byRt[k].steps += r.spans || 0; byRt[k].blocked += r.blocked || 0; });
        const totals = { sessions: rows.length, steps: rows.reduce((a, r) => a + r.steps, 0), blocked: rows.reduce((a, r) => a + r.blocked, 0) };
        let ledger = null;
        try { ledger = await API.getBlockedLedger({ window_days: this.windowDays }); } catch (_) {}
        const agentTable = ObsTabs.tableHTML(
            [{ label: 'runtime', get: r => r[0] }, { label: 'sessions', get: r => r[1].sessions }, { label: 'enforced calls', get: r => r[1].steps }, { label: 'blocked', get: r => r[1].blocked }],
            Object.entries(byRt));
        const sessionTable = ObsTabs.tableHTML(
            [{ label: 'runtime', get: r => r.runtime }, { label: 'session_id', get: r => r.session_id }, { label: 'trace_id', get: r => r.trace_id }, { label: 'enforced calls', get: r => r.steps }, { label: 'blocked', get: r => r.blocked }, { label: 'risk', get: r => r.risk }, { label: 'started', get: r => r.started }, { label: 'ended', get: r => r.ended }],
            rows);
        let policyTable = '<p style="color:#666;font-size:12px;">No tool calls were blocked in this window.</p>';
        if (ledger && (ledger.by_reason || []).length) {
            policyTable = ObsTabs.tableHTML([{ label: 'policy / rule that fired', get: r => r.reason }, { label: 'blocks', get: r => r.count }, { label: 'tools', get: r => r.tools }, { label: 'agents', get: r => r.agents }], ledger.by_reason);
        }
        const win = this.windowDays === 1 ? '24 hours' : this.windowDays + ' days';
        const methodology = `<h2>Methodology &amp; data posture</h2><p style="font-size:12px;line-height:1.6;color:#333;">Generated locally from the tamper-evident tool-call audit log and agent transcripts. Tool arguments and LLM input/output are secret-redacted before storage and kept up to 8 KB per field, on this device only; nothing beyond that is stored.</p>`;
        ObsTabs.printDoc('SecureVector: Agent Activity Audit Report',
            `<h1>Agent Activity Audit Report</h1><div class="sub">Last ${win} · ${totals.sessions} sessions · ${totals.steps.toLocaleString()} enforced calls · ${totals.blocked} blocked</div>` +
            `<h2>By agent</h2>${agentTable}<h2>Policies that fired</h2>${policyTable}<h2>All sessions (${rows.length})</h2>${sessionTable}` + methodology);
    },

    /** Does a span match the active Outcome (verdict) filter? */
    _outcomeMatch(s) {
        const f = this.outcomeFilter || 'all';
        if (f === 'all') return true;
        const act = s.action || s.outcome;
        if (f === 'allow') return s.outcome === 'allow' || act === 'allow';
        if (f === 'blocked') return s.outcome === 'blocked' || act === 'block';
        if (f === 'log_only') return s.outcome === 'log_only' || act === 'log_only';
        if (f === 'secret') return this._isSecret(s);
        // "Threats" = spans that actually carry a detection (Rule / ML / Rule+ML),
        // keyed off the same `detection_source` signal that draws the virus glyph
        // and the detection sub-row. The old definition (blocked OR reason-regex
        // OR risk∈{delete,admin,write}) silently EXCLUDED real ML-only detections
        // — which have no rule, no reason — and pulled in unflagged write calls.
        if (f === 'threat') return !!s.detection_source;
        return true;
    },
    _isSecret(s) {
        // Prefer the real detection signal (matched rule names) over a reason
        // regex, so the secret filter agrees with the lock glyph and the map.
        if (s.detection_source) {
            return (s.detection_rules || []).some(
                r => /credential|secret|api[_ ]?key|token|password|exfil|pii/i.test(String(r)));
        }
        return /credential|secret|api[_ ]?key|token|password|exfil|pii/.test(String(s.reason || '').toLowerCase());
    },

    _exportCols() {
        return [
            { label: 'turn', get: s => s.turn_index },
            { label: 'tool_id', get: s => s.tool_id },
            { label: 'function', get: s => s.function_name },
            { label: 'kind', get: s => ObsTabs.isExternalTool(s.tool_id) ? 'external' : 'built-in' },
            { label: 'action', get: s => s.action },
            { label: 'tool_permission', get: s => s.verdict },
            { label: 'risk', get: s => s.risk },
            { label: 'called_at', get: s => s.called_at },
            { label: 'reason', get: s => s.reason },
        ];
    },
    /** Tool-call spans only — the enforcement audit rows. Generation (LLM turn)
     *  spans are excluded from the CSV/PDF audit export (they carry no verdict
     *  and would leave the tool columns blank). */
    _auditSpans() {
        return ((this._trace && this._trace.spans) || []).filter(s => s.span_kind !== 'generation');
    },
    /** A trace's blocks: tool-call blocks plus egress denies, which are
     *  recorded apart (egress_audit) and reported as egress_blocked. */
    _blockedTotal(t) {
        return (Number(t && t.blocked) || 0) + (Number(t && t.egress_blocked) || 0);
    },
    /** The open trace's step view for exports: the same grouping as the
     *  step list (TraceSteps.records), plus which step each call landed in.
     *  Carries tool names, rule ids and reasons only, never arguments. */
    _exportSteps(t) {
        if (!t || !window.TraceSteps) return null;
        const rec = TraceSteps.records(t);
        const bySpan = new Map();
        TraceSteps.build(t.spans, { egressBlocks: t.egress_blocks }).forEach((st, i) => st.tools.forEach(sp => bySpan.set(sp, rec.steps[i])));
        return Object.assign(rec, { bySpan });
    },
    /** Per-call step columns for the CSV: the call's step number, that
     *  step's model / tool / step time in ms, and its merged tool list. */
    _exportStepCols(view) {
        const st = (s) => (view && view.bySpan.get(s)) || null;
        const ms = (v) => (v == null ? '' : Math.round(v));
        return [
            { label: 'step', get: s => (st(s) ? st(s).index : '') },
            { label: 'step_model_ms', get: s => (st(s) ? ms(st(s).model_ms) : '') },
            { label: 'step_model_estimated', get: s => (st(s) ? st(s).model_estimated : '') },
            { label: 'step_tool_ms', get: s => (st(s) ? ms(st(s).tool_ms) : '') },
            { label: 'step_tool_capped', get: s => (st(s) ? st(s).tool_capped : '') },
            { label: 'step_time_ms', get: s => (st(s) ? ms(st(s).step_ms) : '') },
            { label: 'step_tools', get: s => (st(s) ? TraceSteps.toolsText(st(s).tools, st(s).unchecked) : '') },
        ];
    },
    /** A "Steps" section for the printable trace: summary line + one row
     *  per step. Everything goes through tableHTML, which escapes it. */
    _exportStepsHTML(view) {
        if (!view || !view.steps.length) return '';
        const f = (v) => TraceSteps.fmtDur(v);
        const sm = view.summary;
        const line = [
            sm.took_ms != null ? `Took ${f(sm.took_ms)}` : null,
            `${sm.steps} step${sm.steps === 1 ? '' : 's'}`,
            sm.blocked ? `${sm.blocked} blocked` : null,
            sm.flagged ? `${sm.flagged} flagged` : null,
            sm.cost > 0 ? `$${sm.cost < 0.01 ? sm.cost.toFixed(4) : sm.cost.toFixed(2)}` : null,
        ].filter(Boolean).join(' · ');
        const table = ObsTabs.tableHTML([
            { label: 'step', get: r => r.index },
            { label: 'model time', get: r => (r.model_ms != null ? `${f(r.model_ms)}${r.model_estimated ? ' (est.)' : ''}` : '') },
            { label: 'tool time', get: r => (r.tool_ms != null ? `${r.tool_capped ? '≥' : ''}${f(r.tool_ms)}` : '') },
            { label: 'step time', get: r => (r.step_ms != null ? `${r.tool_capped ? '≥' : ''}${f(r.step_ms)}` : '') },
            { label: 'tool calls', get: r => TraceSteps.toolsText(r.tools, r.unchecked) },
        ], view.steps);
        return `<h2>Steps</h2><div class="sub">${this._esc(line)}</div>${table}`;
    },
    /** The open run's findings as one line each: "Title (why. action)". */
    _exportFindings(t) {
        const h = t ? this._healthFor(t.trace_id) : null;
        return window.TraceSteps ? TraceSteps.findingsRecords(h) : [];
    },
    /** A "Findings" section for the printable trace. */
    _exportFindingsHTML(t) {
        const list = this._exportFindings(t);
        if (!list.length) return '';
        return '<h2>Findings</h2>' + ObsTabs.tableHTML([
            { label: 'category', get: f => f.category },
            { label: 'severity', get: f => f.severity },
            { label: 'finding', get: f => f.title },
            { label: 'why', get: f => f.why },
            { label: 'what to do', get: f => f.action },
        ], list);
    },
    /** Export the selected trace's tool-call spans as CSV. */
    _exportCSV() {
        const t = this._trace;
        const rows = this._auditSpans();
        if (!t || !rows.length) return;
        // Findings summary on the first row only, in its own column.
        const findings = this._exportFindings(t).map(f => `[${f.category}] ${f.title}`).join('; ');
        const cols = this._exportCols().concat(this._exportStepCols(this._exportSteps(t)))
            .concat([{ label: 'findings', get: s => (s === rows[0] ? findings : '') }]);
        ObsTabs.download(`agent-trace-${String(t.trace_id).slice(0, 8)}.csv`,
            ObsTabs.toCSV(cols, rows), 'text/csv');
    },
    /** PDF = printable page with the trace header + the step table. */
    _exportPDF() {
        const t = this._trace;
        const rows = this._auditSpans();
        if (!t || !rows.length) return;
        const gens = t.generation_count || 0;
        const sub = `${this._esc(t.runtime_kind || 'unknown')} · ${rows.length} tool runs` +
            (gens ? ` · ${gens} LLM runs` : '') + ` · ${this._blockedTotal(t)} blocked · trace ${String(t.trace_id).slice(0, 12)}…`;
        const view = this._exportSteps(t);
        const cols = view ? [{ label: 'step', get: s => { const st = view.bySpan.get(s); return st ? st.index : ''; } }].concat(this._exportCols()) : this._exportCols();
        ObsTabs.printDoc('SecureVector: Agent Trace',
            `<h1>Agent Trace</h1><div class="sub">${sub}</div>` +
            this._exportFindingsHTML(t) +
            this._exportStepsHTML(view) +
            (view ? '<h2>Tool calls</h2>' : '') +
            ObsTabs.tableHTML(cols, rows));
    },

    /** What the list needs beside the runs: pending approvals (for the age
     *  of a wait), running sessions with their scores, and the coverage
     *  table. Each is best effort; the list renders without them. */
    async _loadListExtras(withCoverage) {
        const jobs = [
            API.getJitRequests('pending').then(r => { this._pending = r; }, () => {}),
            API.getObservabilityLive({ limit: 500 }).then(r => { this._liveData = r; }, () => {}),
        ];
        if (withCoverage && !this._coverage) {
            jobs.push(API.getObservabilityCoverage().then(r => { this._coverage = (r && r.runtimes) || null; }, () => {}));
        }
        await Promise.all(jobs);
    },

    async loadData() {
        const list = document.getElementById('ar-runlist');
        if (list) list.innerHTML = '<div class="ar-empty">Loading sessions…</div>';
        const wantTrace = this._pendingTrace; this._pendingTrace = null;
        const [data] = await Promise.all([
            API.getTraces({ window_days: this.windowDays }),
            this._loadListExtras(true),
        ]);
        this.runs = (data && data.runs) || [];
        this._listUpdatedAt = Date.now();
        this._awayDigest(); // diff BEFORE the snapshot below overwrites it
        this._snapSave();
        this.renderRuns();
        const shown = this._filteredRuns();
        // Land on the full-width agent LIST. Only drill straight into a trace
        // when a click demanded one: a Map agent-node (wantTrace), an outcome
        // drill (Blocked Actions → first flagged trace), or the user is
        // already inside a trace that's still present (window change).
        const flagKey = { blocked: 'blocked', threat: 'detections', secret: 'secrets' }[this._wantFlagged];
        this._wantFlagged = null;
        const flagged = flagKey ? shown.find(r => (r[flagKey] || 0) > 0) : null;
        if (wantTrace && this.runs.some(r => r.trace_id === wantTrace)) {
            // A deep link ("See full run") asked for the whole run. A health
            // link asked for the steps and their findings instead.
            if (this._pendingHealthOpen) { this._healthOpen = wantTrace; this._pendingHealthOpen = false; }
            else this._timelineForce = wantTrace;
            this.selectRun(wantTrace);
        } else if (wantTrace) {
            // Deep-linked trace is older than the current window. Widen to the
            // API's 90-day max and retry once before giving up — an Instant
            // Audit or Map click should land on its trace, not on an error.
            if (this.windowDays < 90) {
                this.windowDays = 90;
                this.range = '90d';
                const bar = document.getElementById('agent-runs-toolbar');
                if (bar) this._buildToolbar(bar);
                this._pendingTrace = wantTrace;
                if (window.Toast) Toast.info('Trace is older than the current window, widened to 90 days.');
                return this.loadData();
            }
            if (window.Toast) Toast.error('No trace found in the last 90 days for that session.');
            this._showList();
        } else if (flagged) {
            this.selectRun(flagged.trace_id);
        } else if (this._inDetail() && this.selected && shown.some(r => r.trace_id === this.selected)) {
            this.selectRun(this.selected, { refresh: true }); // refresh the open drill-down in place
        } else {
            this._showList();
        }
    },

    /** Cost cell for the run list: list-price estimate of the run's model
     *  spend, plus a quiet "costly turn" mark when one model turn is more
     *  than half of the whole run (the thing to look at first). */
    _costCell(r, dash) {
        const cost = Number(r.cost || 0);
        if (!(cost > 0)) return dash;
        const txt = '≈$' + cost.toFixed(cost < 0.01 ? 4 : 2);
        const heavy = (r.generations || 0) > 1 && Number(r.max_turn_cost || 0) > cost / 2;
        return `<span class="ar-num">${txt}</span>` + (heavy ? `<span class="ar-costly" title="One model turn is more than half of this run's spend">!</span>` : '');
    },
    _costTitle(r) {
        const tok = Number(r.tokens || 0);
        const gens = Number(r.generations || 0);
        if (!gens) return 'No model turns recorded for this run';
        return `${gens} model turn${gens === 1 ? '' : 's'} · ${tok.toLocaleString()} tokens · list-price estimate`;
    },

    /** A stable name; a verified Terminal match can supply the task or workspace. */
    _agentLabel(r) {
        if (!r) return 'Session';
        const nm = ObsTabs.agentName(r.trace_id);
        if (nm) return nm;
        const task = r.terminal_task;
        if (task && task.id && task.title && String(task.title).trim()) return String(task.title).trim();
        if (task && task.id && task.workspace_name) return task.workspace_name;
        return r.session_id ? `Session ${String(r.session_id).slice(0, 8)}`
            : `Trace ${String(r.trace_id || '?').slice(0, 8)}`;
    },

    /** Runs after applying the active runtime filter (Map drill-down). */
    /** Runs after the harness filter but BEFORE the triage view — the set the
     *  triage chips count over, so counts don't change as views are clicked. */
    _baseRuns() {
        return this.runtimeFilter
            ? this.runs.filter(r => (r.runtime_kind || '') === this.runtimeFilter)
            : this.runs;
    },

    /** Does a run belong to the given triage view? */
    _viewMatch(r, v) {
        if (v === 'live') return this._isLive(r.ended_at);
        if (v === 'flagged') return (r.blocked || 0) + (r.detections || 0) + (r.secrets || 0) > 0;
        if (v === 'blocked') return (r.blocked || 0) > 0;
        if (v === 'detected') return (r.detections || 0) > 0;
        if (v === 'secret') return (r.secrets || 0) > 0;
        // Run health (loop / failing / wasteful): counts from the runs list.
        if (v === 'loop' || v === 'failing' || v === 'wasteful') return Number((r.health || {})[v]) > 0;
        return true;
    },

    /** Collapse the inline drill-down and show the plain list. */
    /** Split pane on wide screens, accordion below 1100px. The media query
     *  flips the class live; the detail node is re-seated so a resize never
     *  strands an open trace in the wrong place. */
    _splitSetup(layout) {
        this._splitMq = (typeof window.matchMedia === 'function') ? window.matchMedia('(min-width: 1100px)') : null;
        const apply = () => {
            // The runs list is full width at every size and the trace opens
            // in the pane in its place, so the pane layout is always on.
            layout.classList.toggle('split', layout.classList.contains('runs-v2') || !!(this._splitMq && this._splitMq.matches));
            const det = document.getElementById('ar-detail');
            if (det && !det.hidden && this.selected) this._expandUnder(this.selected, false);
            else if (det) { const home = this._detailHome(); if (home && det.parentElement !== home) home.appendChild(det); }
            this._paneState();
            this._fitPanes();
        };
        this._splitApply = apply;
        if (this._splitMq) {
            if (this._splitMq.addEventListener) this._splitMq.addEventListener('change', apply);
            else if (this._splitMq.addListener) this._splitMq.addListener(apply);
        }
        this._fitHandler = () => this._fitPanes();
        window.addEventListener('resize', this._fitHandler);
        // Anything above the layout that grows or shrinks (the away strip,
        // the page itself) re-fits the panes.
        if (typeof ResizeObserver === 'function') {
            this._fitRo = new ResizeObserver(() => this._fitPanes());
            const away = document.getElementById('ar-away');
            if (away) this._fitRo.observe(away);
            const pc = layout.closest('.page-content');
            if (pc) this._fitRo.observe(pc);
        }
        apply();
    },

    _isSplit() {
        const l = document.querySelector('.ar-layout');
        return !!(l && l.classList.contains('split'));
    },

    /** Where the detail node lives when it is not under a row: the right
     *  pane in split mode, the layout root in accordion mode. */
    _detailHome() {
        return (this._isSplit() && document.getElementById('ar-pane')) || document.querySelector('.ar-layout');
    },

    /** The right pane shows its placeholder until a trace is open. */
    _paneState() {
        const pane = document.getElementById('ar-pane');
        const det = document.getElementById('ar-detail');
        if (pane) pane.classList.toggle('has-trace', !!(det && !det.hidden));
    },

    /** Both panes get the viewport height left below the page header, so
     *  each scrolls inside itself and the page never grows. */
    _fitPanes() {
        const l = document.querySelector('.ar-layout');
        if (!l || !l.classList.contains('split')) return;
        // Height left inside the page's scroll container, so the page itself
        // has nothing to scroll: both panes scroll inside.
        const pc = l.closest('.page-content');
        let h;
        if (pc) {
            // Measured relative to the scroll container, so the page's
            // slide-in transform cannot skew the number.
            const top = l.getBoundingClientRect().top - pc.getBoundingClientRect().top + pc.scrollTop;
            h = pc.clientHeight - (parseFloat(getComputedStyle(pc).paddingBottom) || 0) - top;
        } else {
            h = window.innerHeight - l.getBoundingClientRect().top - 14;
        }
        l.style.setProperty('--ar-pane-h', `${Math.max(320, Math.round(h))}px`);
    },

    _showList() {
        const det = document.getElementById('ar-detail');
        if (det) {
            det.hidden = true;
            const home = this._detailHome();
            if (home && det.parentElement !== home) home.appendChild(det); // park it outside the list
        }
        this._paneState();
        this.selected = null;
        this._live.paused = false; // leaving the trace releases the hold
        const layout = document.querySelector('.ar-layout');
        const reopening = !!(layout && layout.classList.contains('trace-open'));
        if (layout) layout.classList.remove('trace-open');
        this.renderRuns();
        // Back to the list where the reader left it.
        const pc = layout && layout.closest('.page-content');
        if (reopening && pc && typeof this._listScroll === 'number') pc.scrollTop = this._listScroll;
    },

    /** Move the single detail node directly beneath the clicked row and show
     *  it (the accordion expansion). Falls back to end-of-list if the row is
     *  gone (e.g. filtered out between click and render). */
    _expandUnder(traceId, scroll = true) {
        const det = document.getElementById('ar-detail');
        if (!det) return;
        const row = [...document.querySelectorAll('.rl-row')].find(c => c.dataset.trace === traceId);
        const layout = document.querySelector('.ar-layout');
        if (layout && !layout.classList.contains('trace-open')) {
            const pc = layout.closest('.page-content');
            this._listScroll = pc ? pc.scrollTop : 0;
            layout.classList.add('trace-open');
            if (pc && scroll) pc.scrollTop = 0;
        }
        if (this._isSplit()) {
            // Split pane: the detail stays in the right pane; only the
            // selection highlight moves.
            const home = this._detailHome();
            if (home && det.parentElement !== home) home.appendChild(det);
            if (scroll) det.scrollTop = 0;
        } else if (row) row.after(det); else (document.getElementById('ar-runlist') || document.body).appendChild(det);
        det.hidden = false;
        this._paneState();
        document.querySelectorAll('.rl-row.sel').forEach(el => { el.classList.remove('sel'); el.removeAttribute('aria-current'); });
        if (row) {
            row.classList.add('sel');
            row.setAttribute('aria-current', 'true');
        }
        this._fitPanes();
    },

    _inDetail() {
        const det = document.getElementById('ar-detail');
        return !!(det && !det.hidden);
    },

    /** The runs in range after every list filter (search included). */
    _filteredRuns() {
        const RL = window.RunsList;
        const ctx = this._ctx || (RL ? RL.buildCtx(this.runs) : null);
        if (!RL) return this._baseRuns();
        const now = ctx.now;
        return (this.runs || []).filter(r => RL.inRange(r, this.range, now) && RL.matches(r, this.filters, ctx));
    },

    clearRuntimeFilter() {
        this.runtimeFilter = null;
        if (this.filters) this.filters.harness = [];
        this.renderRuns();
    },

    _clearAllFilters() {
        this.filters = RunsList.emptyFilters();
        this.runtimeFilter = null;
        this.toolFilter = null;
        this.outcomeFilter = 'all';
        this._extraDims = new Set();
        this.pageIdx = 0;
        const s = document.getElementById('rl-search');
        if (s) s.value = '';
        this.renderRuns();
        if (this._inDetail() && this._trace) this.renderWaterfall(this._trace);
    },

    // ---- list chrome: dropdowns, filters, cards, table, pager -------------

    /** One dropdown button with a menu. The menu is rebuilt on every open
     *  so its counts are current. */
    _dropdown(opts) {
        const wrap = document.createElement('div');
        wrap.className = 'rl-dd';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'rl-btn' + (opts.active ? ' on' : '');
        btn.setAttribute('aria-expanded', 'false');
        btn.setAttribute('aria-haspopup', 'true');
        btn.innerHTML = (opts.label ? `<span class="rl-k">${this._esc(opts.label)}:</span> ` : '') +
            `<span class="rl-v">${this._esc(opts.value)}</span><span class="rl-caret" aria-hidden="true">▾</span>`;
        if (opts.title) btn.title = opts.title;
        const menu = document.createElement('div');
        menu.className = 'rl-menu';
        menu.hidden = true;
        if (opts.label) menu.setAttribute('aria-label', opts.label);
        const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); wrap.classList.remove('open'); };
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const opening = menu.hidden;
            document.querySelectorAll('.rl-dd.open').forEach(d => { if (d !== wrap && d._rlClose) d._rlClose(); });
            if (!opening) { close(); return; }
            menu.textContent = '';
            opts.build(menu, close);
            menu.hidden = false;
            wrap.classList.add('open');
            btn.setAttribute('aria-expanded', 'true');
        });
        menu.addEventListener('click', (e) => e.stopPropagation());
        menu.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); btn.focus(); } });
        wrap._rlClose = close;
        wrap.appendChild(btn);
        wrap.appendChild(menu);
        if (!this._rlDocWired) {
            this._rlDocWired = true;
            document.addEventListener('click', () => {
                document.querySelectorAll('.rl-dd.open').forEach(d => { if (d._rlClose) d._rlClose(); });
            });
        }
        return wrap;
    },

    /** A menu option: a real button with aria-pressed. */
    _menuOption(menu, label, count, pressed, onPick) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'rl-opt';
        b.setAttribute('aria-pressed', pressed ? 'true' : 'false');
        b.innerHTML = `<span class="rl-tick" aria-hidden="true">${pressed ? RL_ICON_OK : ''}</span><span class="rl-opt-l">${this._esc(label)}</span>` +
            (count != null ? `<span class="rl-opt-n">${count}</span>` : '');
        b.addEventListener('click', onPick);
        menu.appendChild(b);
        return b;
    },

    _toggleIn(list, value) {
        const at = list.indexOf(value);
        if (at >= 0) list.splice(at, 1); else list.push(value);
    },

    _distinct(runs, fn) {
        const m = new Map();
        runs.forEach(r => { [].concat(fn(r)).forEach(v => { if (v) m.set(v, (m.get(v) || 0) + 1); }); });
        return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
    },

    _renderFilterBar(inRange) {
        const bar = document.getElementById('rl-filters');
        if (!bar) return;
        bar.textContent = '';
        const RL = RunsList;
        const f = this.filters;
        const ctx = this._ctx;
        const refresh = () => { this.pageIdx = 0; this.runtimeFilter = (f.harness.length === 1 ? f.harness[0] : null); this.renderRuns(); };

        // Status: one choice.
        const stLabel = f.status ? (RL.STATUS.find(s => s[0] === f.status) || [0, f.status])[1] : 'All';
        const nReview = inRange.filter(r => RL.needsReview(r, ctx)).length;
        bar.appendChild(this._dropdown({
            label: 'Status', value: f.status === 'review' ? `Needs review (${nReview})` : stLabel, active: !!f.status,
            build: (menu, close) => {
                this._menuOption(menu, 'All', inRange.length, !f.status, () => { f.status = ''; close(); refresh(); });
                RL.STATUS.forEach(([k, l]) => {
                    const n = k === 'review' ? nReview : inRange.filter(r => RL.status(r, ctx) === k).length;
                    this._menuOption(menu, l, n, f.status === k, () => { f.status = (f.status === k ? '' : k); close(); refresh(); });
                });
            },
        }));

        // Decision: several choices.
        const decText = f.decision.length
            ? f.decision.map(d => ({ waiting: 'Waiting', blocked: 'blocked', allowed: 'allowed only' }[d])).join(', ').replace(/^./, c => c.toUpperCase())
            : 'All';
        bar.appendChild(this._dropdown({
            label: 'Decision', value: decText, active: f.decision.length > 0,
            build: (menu) => {
                RL.DECISION.forEach(([k, l]) => {
                    const n = inRange.filter(r => RL._decisionMatch(r, k)).length;
                    this._menuOption(menu, l, n, f.decision.includes(k), () => { this._toggleIn(f.decision, k); refresh(); });
                });
            },
        }));

        const multi = (key, label, values, noneLabel) => {
            const sel = f[key];
            const value = sel.length ? (sel.length === 1 ? sel[0] : `${sel.length} selected`) : `All ${values.length}`;
            bar.appendChild(this._dropdown({
                label, value, active: sel.length > 0,
                build: (menu) => {
                    if (!values.length) {
                        const e = document.createElement('div');
                        e.className = 'rl-opt-empty';
                        e.textContent = noneLabel;
                        menu.appendChild(e);
                    }
                    values.forEach(([v, n]) => this._menuOption(menu, v, n, sel.includes(v), () => { this._toggleIn(sel, v); refresh(); }));
                },
            }));
        };
        multi('harness', 'Harness', this._distinct(inRange, r => r.runtime_kind || 'unknown'), 'No harnesses in this range');
        multi('project', 'Project', this._distinct(inRange, r => RL.project(r) || 'none'), 'No projects in this range');

        const extra = {
            model: ['Model', () => this._distinct(inRange, r => r.models || []), 'No models recorded'],
            host: ['Host', () => this._distinct(inRange, r => RL.host(r) || 'this device'), 'No hosts recorded'],
            user: ['User', () => this._distinct(inRange, r => RL.user(r) || 'unknown'), 'No users recorded'],
        };
        if (!this._extraDims) this._extraDims = new Set();
        Object.keys(extra).forEach(k => { if (f[k].length) this._extraDims.add(k); });
        if (f.health.length) this._extraDims.add('health');
        Object.entries(extra).forEach(([k, [label, values, none]]) => { if (this._extraDims.has(k)) multi(k, label, values(), none); });
        if (this._extraDims.has('health')) {
            const sel = f.health;
            bar.appendChild(this._dropdown({
                label: 'Health', value: sel.length ? sel.join(', ') : 'All', active: sel.length > 0,
                build: (menu) => {
                    [['loop', 'Loop'], ['failing', 'Failing'], ['wasteful', 'Wasteful']].forEach(([key, label]) => {
                        const n = inRange.filter(r => this._viewMatch(r, key)).length;
                        const b = this._menuOption(menu, label, n, sel.includes(key), () => { this._toggleIn(sel, key); refresh(); });
                        if (window.TraceSteps) b.querySelector('.rl-opt-l').insertAdjacentHTML('afterbegin', `${TraceSteps.healthIcon(key)} `);
                    });
                },
            }));
        }
        const left = ['model', 'host', 'user', 'health'].filter(k => !this._extraDims.has(k));
        if (left.length) {
            bar.appendChild(this._dropdown({
                value: '+ Filter',
                build: (menu, close) => {
                    left.forEach(k => this._menuOption(menu, { model: 'Model', host: 'Host', user: 'User', health: 'Health' }[k], null, false, () => {
                        this._extraDims.add(k); close(); this.renderRuns();
                    }));
                },
            }));
        }

        // Span-level filters handed off by the Map or Blocked Actions: they
        // narrow the open trace, so they show here and clear here.
        const chip = (text, onClear) => {
            const c = document.createElement('span');
            c.className = 'rl-chip';
            c.innerHTML = `${text}<button type="button" aria-label="Clear this filter">×</button>`;
            c.querySelector('button').addEventListener('click', onClear);
            bar.appendChild(c);
        };
        if (this.toolFilter) chip(`Tool <b>${this._esc(String(this.toolFilter).split(':').pop())}</b>`, () => {
            this.toolFilter = null; this.renderRuns(); if (this._inDetail() && this._trace) this.renderWaterfall(this._trace);
        });
        if (this.outcomeFilter && this.outcomeFilter !== 'all') chip(`Spans <b>${this._esc(this.outcomeFilter.replace('_', ' '))}</b>`, () => {
            this.outcomeFilter = 'all'; this.renderRuns(); if (this._inDetail() && this._trace) this.renderWaterfall(this._trace);
        });

        if (RL.activeCount(f) || this.toolFilter || (this.outcomeFilter && this.outcomeFilter !== 'all')) {
            const clr = document.createElement('button');
            clr.type = 'button';
            clr.className = 'rl-link';
            clr.textContent = 'Clear filters';
            clr.addEventListener('click', () => this._clearAllFilters());
            bar.appendChild(clr);
        }
    },

    _spark(values, kind, color, label) {
        const W = 240, H = 32;
        const max = Math.max(...values, 0);
        let body = '';
        if (kind === 'bars') {
            const w = W / values.length;
            values.forEach((v, i) => {
                if (!v || !max) return;
                const h = Math.max(2, Math.round((v / max) * (H - 2)));
                body += `<rect x="${(i * w).toFixed(1)}" y="${H - h}" width="${Math.max(1, w - 1).toFixed(1)}" height="${h}"/>`;
            });
            body = `<g fill="${color}">${body}</g>`;
        } else {
            const pts = values.map((v, i) => `${(values.length > 1 ? (i / (values.length - 1)) * W : 0).toFixed(1)},${(H - 2 - (max ? (v / max) * (H - 6) : 0)).toFixed(1)}`).join(' ');
            body = `<polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}"/>`;
        }
        return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${this._esc(label)}">${body}` +
            `<line x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}" stroke="var(--border-default,#232a33)"/></svg>`;
    },

    _renderCards(shown) {
        const box = document.getElementById('rl-cards');
        if (!box) return;
        const RL = RunsList;
        const now = this._ctx.now;
        const per = this.range === '1h' ? 'by 5 minutes' : 'by hour';
        const sum = (k) => shown.reduce((a, r) => a + Number(r[k] || 0), 0);
        const waiting = sum('waiting'), blocked = sum('blocked'), cost = sum('cost'), tokens = sum('tokens');
        const p95 = RL.p95(RL.finishedDurations(shown, this._ctx));
        const b = (fn, agg) => RL.buckets(shown, this.range, now, fn, agg);
        const muted = 'var(--text-secondary,#aeb7c2)';
        const cards = [
            ['Runs', `${shown.length.toLocaleString()}`, '', this._spark(b(() => 1, 'count'), 'line', muted, `Runs ${per}`)],
            ['Waiting for approval', String(waiting), waiting ? 'rl-amb-t' : '', this._spark(b(r => Number(r.waiting || 0), 'sum'), 'bars', 'var(--warning,#f59e0b)', `Waiting for approval ${per}`)],
            ['Blocked calls', String(blocked), blocked ? 'rl-red-t' : '', this._spark(b(r => Number(r.blocked || 0), 'sum'), 'bars', 'var(--danger,#ef4444)', `Blocked calls ${per}`)],
            ['Cost · tokens', `${cost > 0 ? '$' + cost.toFixed(2) : '$0'} <span class="rl-card-sub">${this._fmtTokens(tokens)}</span>`, '', this._spark(b(r => Number(r.cost || 0), 'sum'), 'line', muted, `Cost ${per}`)],
            ['Run duration, p95', p95 ? this._fmtDur(p95) : '—', '', this._spark(b(r => (RL.status(r, this._ctx) === 'running' ? null : RL.duration(r)), 'p95'), 'line', muted, `p95 run duration ${per}`)],
        ];
        box.innerHTML = cards.map(([k, v, cls, svg]) =>
            `<div class="rl-card"><span class="rl-card-k">${k}</span><span class="rl-card-v ${cls}">${v}</span>${svg}</div>`).join('');
    },

    _fmtTokens(n) {
        n = Number(n || 0);
        if (!n) return '—';
        if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
        if (n >= 1e3) return Math.round(n / 1e3) + 'k';
        return String(n);
    },

    _fmtDur(ms) {
        if (ms == null) return '—';
        if (ms < 1000) return '<1s';
        const s = Math.round(ms / 1000);
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60), r = s % 60;
        if (m < 10) return r ? `${m}m ${String(r).padStart(2, '0')}s` : `${m}m`;
        if (m < 60) return `${m}m`;
        const h = Math.floor(m / 60);
        return `${h}h ${m % 60}m`;
    },

    _clock(ms) {
        if (!ms) return '—';
        const d = new Date(ms);
        const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const today = new Date(this._ctx ? this._ctx.now : Date.now());
        return d.toDateString() === today.toDateString() ? hm : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${hm}`;
    },

    _ago(ms) {
        const s = Math.max(0, Math.round(((this._ctx ? this._ctx.now : Date.now()) - ms) / 1000));
        if (s < 60) return `${s}s`;
        const m = Math.round(s / 60);
        return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
    },

    /** Status word plus decision badges. Never a control: approving happens
     *  only in the trace span panel. */
    _statusCell(r) {
        const RL = RunsList;
        const ctx = this._ctx;
        const st = RL.status(r, ctx);
        const c = RL.calls(r);
        const quiet = st === 'running' && r.session_id && ctx.live[r.session_id] && Number(ctx.live[r.session_id].quiet_seconds) >= 300
            ? `, quiet ${Math.round(ctx.live[r.session_id].quiet_seconds / 60)}m` : '';
        let html = `<span class="rl-st">${st}${quiet}</span>`;
        if (c.waiting) {
            const since = ctx.waitingSince[r.trace_id];
            const exp = RL.ms(r.oldest_waiting_expires_at);
            const parts = ['waiting for approval'];
            if (since) parts.push(this._ago(since));
            if (exp) parts.push('expires ' + this._clock(exp).split(' ').pop());
            html += `<span class="rl-b rl-amb" title="${c.waiting} call${c.waiting === 1 ? '' : 's'} waiting for approval. Open the run to decide.">${this._esc(parts.join(' · '))}</span>`;
        }
        if (c.blocked) html += `<span class="rl-b rl-red">${c.blocked} blocked</span>`;
        if (Number(r.repeat_attempts || r.repeats || 0) > 0) html += '<span class="rl-b rl-red">repeat attempt</span>';
        const sc = RL.score(r, ctx);
        if (sc != null && sc >= 70) html += `<span class="rl-b rl-amb" title="Session score from its usual behaviour">score ${sc}</span>`;
        return html;
    },

    _callsCell(r) {
        const c = RunsList.calls(r);
        return `<span class="rl-num" title="allowed · waiting for approval · blocked">${c.allowed} · ` +
            `<span class="${c.waiting ? 'rl-amb-t' : 'rl-mute'}">${c.waiting}</span> · ` +
            `<span class="${c.blocked ? 'rl-red-t' : 'rl-mute'}">${c.blocked}</span></span>`;
    },

    _sessionText(r) {
        const RL = RunsList;
        return [r.runtime_kind || 'unknown', RL.project(r), String(r.session_id || r.trace_id || '').slice(0, 8)].filter(Boolean).join(' · ');
    },

    _hostText(r) {
        const RL = RunsList;
        return [RL.host(r) || 'this device', RL.user(r)].filter(Boolean).join(' · ');
    },

    _runRow(r, flat, guide, last) {
        const RL = RunsList;
        const ctx = this._ctx;
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'rl-row' + (flat ? ' rl-flat' : '') + (guide ? ' rl-child' : '') + (guide && last ? ' rl-last' : '') + (r.trace_id === this.selected ? ' sel' : '');
        row.dataset.trace = r.trace_id;
        if (r.trace_id === this.selected) row.setAttribute('aria-current', 'true');
        const name = RL.name(r, ctx);
        row.setAttribute('aria-label', `${name}, ${this._sessionText(r)}. Open its trace.`);
        const started = RL.ms(r.started_at) || RL.ms(r.ended_at);
        const health = window.TraceSteps && TraceSteps.badgesHtml(r.health);
        const cells = [
            `<span class="rl-c rl-mono rl-sub">${this._esc(this._clock(started))}</span>`,
            `<span class="rl-c rl-name"><span class="ar-run-rt">${this._esc(name)}</span>` +
                (health ? `<span class="ar-row-health">${TraceSteps.badgesHtml(r.health)}</span>` : '') + '</span>',
        ];
        if (flat) {
            cells.push(`<span class="rl-c rl-ell rl-sub">${this._esc(this._sessionText(r))}</span>`);
            cells.push(`<span class="rl-c rl-ell rl-sub">${this._esc(this._hostText(r))}</span>`);
        }
        cells.push(`<span class="rl-c rl-stcell">${this._statusCell(r)}</span>`);
        cells.push(`<span class="rl-c rl-r">${this._callsCell(r)}</span>`);
        cells.push(`<span class="rl-c rl-r rl-sub">${this._esc(this._fmtDur(RL.shownDuration(r, ctx)))}</span>`);
        cells.push(`<span class="rl-c rl-r">${this._esc(this._fmtTokens(r.tokens))}</span>`);
        cells.push(`<span class="rl-c rl-r" title="${this._esc(this._costTitle(r))}">${Number(r.cost) > 0 ? '$' + Number(r.cost).toFixed(2) : '—'}</span>`);
        row.innerHTML = (guide ? '<span class="rl-guide" aria-hidden="true"></span><span class="rl-conn" aria-hidden="true"></span>' : '') + cells.join('');
        row.addEventListener('click', () => this.selectRun(r.trace_id));
        return row;
    },

    _copyBtn(text, label) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'rl-copy';
        b.setAttribute('aria-label', label);
        b.title = `${label}: ${text}`;
        b.innerHTML = `<span class="rl-mono">${this._esc(String(text).slice(0, 8))}</span> <span aria-hidden="true">⧉</span>`;
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            const face = b.innerHTML;
            const done = () => { b.textContent = 'copied'; setTimeout(() => { b.innerHTML = face; }, 1200); };
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(String(text)).then(done, () => {});
            } catch (_) { /* clipboard blocked: the id stays in the tooltip */ }
        });
        return b;
    },

    _sessionHead(g, hiddenCount) {
        const sessRuns = g.runs;
        const RL = RunsList;
        const ctx = this._ctx;
        const all = (this.runs || []).filter(r => (r.session_id || ('trace:' + r.trace_id)) === g.key);
        const first = g.runs[0];
        const running = all.some(r => RL.isRunning(r, ctx));
        const started = Math.min(...all.map(r => RL.ms(r.started_at) || RL.ms(r.ended_at)).filter(Boolean));
        const cost = sessRuns.reduce((a, r) => a + Number(r.cost || 0), 0);
        const cov = RL.coverageFor(first.runtime_kind, ctx);
        const closed = !!this._collapsedSessions[g.key] && !g.runs.some(r => r.trace_id === this.selected);
        const head = document.createElement('div');
        head.className = 'rl-sh' + (closed ? ' closed' : '');
        head.setAttribute('role', 'group');
        head.setAttribute('aria-label', `Session ${first.session_id || first.trace_id}`);
        const caret = document.createElement('button');
        caret.type = 'button';
        caret.className = 'rl-caret-btn';
        caret.setAttribute('aria-expanded', closed ? 'false' : 'true');
        caret.setAttribute('aria-label', closed ? 'Expand session' : 'Collapse session');
        caret.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        head.appendChild(caret);
        // The tree guide starts under the caret and runs down through the
        // session's runs, as in the trace span tree.
        if (!closed) head.insertAdjacentHTML('beforeend', '<span class="rl-sh-guide" aria-hidden="true"></span>');
        head.insertAdjacentHTML('beforeend',
            `<span class="rl-dot${running ? ' on' : ''}" role="img" aria-label="${running ? 'running' : 'ended'}">${running ? '●' : '○'}</span>` +
            `<b>${this._esc(first.runtime_kind || 'unknown')}</b>` +
            (RL.project(first) ? `<span class="rl-mono">${this._esc(RL.project(first))}</span>` : ''));
        if (first.session_id) head.appendChild(this._copyBtn(first.session_id, 'Copy session id'));
        head.insertAdjacentHTML('beforeend',
            `<span class="rl-sub">${this._esc(this._hostText(first))}</span>` +
            (started && isFinite(started) ? `<span class="rl-sub">session started ${this._esc(this._clock(started))}</span>` : '') +
            `<span class="rl-sub">${sessRuns.length} run${sessRuns.length === 1 ? '' : 's'} · ${cost > 0 ? '$' + cost.toFixed(2) : '—'}</span>`);
        if (cov || ctx.coverage) {
            const badge = document.createElement('span');
            badge.className = 'rl-cov';
            badge.textContent = RL.coverageLabel(cov);
            const paths = (cov && cov.unchecked) || [];
            badge.title = 'What SecureVector can check for this session' + (paths.length ? `. Not checked: ${paths.join(', ')}` : '');
            head.appendChild(badge);
        }
        const right = document.createElement('span');
        right.className = 'rl-sh-right';
        // A session is never split across pages, so the header total and
        // the "earlier runs" row agree: the session's matching runs minus
        // the rows shown. That row sits on the tree guide under the runs.
        const hidden = hiddenCount;
        let moreRow = null;
        if (hidden > 0 || this._expandedSessions[g.key]) {
            moreRow = document.createElement('div');
            moreRow.className = 'rl-morerow rl-last';
            moreRow.innerHTML = '<span class="rl-guide" aria-hidden="true"></span><span class="rl-conn" aria-hidden="true"></span>';
            const more = document.createElement('button');
            more.type = 'button';
            more.className = 'rl-link';
            more.textContent = this._expandedSessions[g.key] ? 'Show fewer runs' : `${hidden} earlier run${hidden === 1 ? '' : 's'}`;
            more.addEventListener('click', () => { this._expandedSessions[g.key] = !this._expandedSessions[g.key]; this.renderRuns(); });
            moreRow.appendChild(more);
        }
        if (first.session_id) {
            const only = document.createElement('button');
            only.type = 'button';
            only.className = 'rl-link';
            only.textContent = 'Only this session';
            only.addEventListener('click', () => {
                this.filters.search = `session:${first.session_id}`;
                const s = document.getElementById('rl-search');
                if (s) s.value = this.filters.search;
                this.pageIdx = 0;
                this.renderRuns();
            });
            right.appendChild(only);
        }
        head.appendChild(right);
        caret.addEventListener('click', () => {
            const closing = !this._collapsedSessions[g.key];
            this._collapsedSessions[g.key] = closing;
            // Collapsing the session that holds the open trace closes the
            // trace too, so the collapse sticks on the next live tick.
            if (closing && g.runs.some(r => r.trace_id === this.selected)) this._showList();
            else this.renderRuns();
        });
        return { head, closed, moreRow };
    },

    _sortHeader(cols) {
        const hd = document.createElement('div');
        hd.className = 'rl-hd';
        cols.forEach(([key, label, right, spoken]) => {
            if (!key) { hd.insertAdjacentHTML('beforeend', `<span class="rl-c${right ? ' rl-r' : ''}">${label}</span>`); return; }
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'rl-c rl-sort' + (right ? ' rl-r' : '');
            const on = this.sortKey === key && !this._reviewMode();
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
            b.setAttribute('aria-label', `Sort by ${spoken || label}${on ? (this.sortDir === 'asc' ? ', ascending' : ', descending') : ''}`);
            b.innerHTML = `${label} <span aria-hidden="true">${on ? (this.sortDir === 'asc' ? '↑' : '↓') : '↕'}</span>`;
            b.addEventListener('click', () => {
                if (this.sortKey === key) this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
                else { this.sortKey = key; this.sortDir = key === 'session' || key === 'host' ? 'asc' : 'desc'; }
                if (this._reviewMode()) this.filters.status = '';
                this.pageIdx = 0;
                this.renderRuns();
            });
            hd.appendChild(b);
        });
        return hd;
    },

    _reviewMode() { return this.filters && this.filters.status === 'review'; },

    _renderStatusLine(text) {
        const el = document.getElementById('rl-status');
        if (!el) return;
        const paused = !!this._live.paused;
        el.innerHTML = `<span>${this._esc(text)} · <span class="rl-dot on" aria-hidden="true">●</span> ` +
            `<span id="rl-ago">${this._agoText()}</span> · </span>`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'rl-link';
        btn.setAttribute('aria-pressed', paused ? 'true' : 'false');
        btn.textContent = paused ? 'Resume' : 'Pause';
        btn.title = paused ? 'Resume live updates' : 'Hold the list still while you read. Live updates stop until you resume.';
        btn.addEventListener('click', () => {
            this._live.paused = !this._live.paused;
            if (!this._live.paused) { this._livePill(false); this._liveTick(true); }
            this._renderStatusLine(text);
        });
        el.querySelector('span').appendChild(btn);
    },

    _agoText() {
        if (this._live.paused) return 'paused';
        if (!this._listUpdatedAt) return 'updating';
        return `updated ${Math.max(0, Math.round((Date.now() - this._listUpdatedAt) / 1000))}s ago`;
    },

    _renderPager(info, label) {
        const el = document.getElementById('rl-pager');
        if (!el) return;
        el.textContent = '';
        const span = document.createElement('span');
        span.className = 'rl-sub';
        span.textContent = label;
        el.appendChild(span);
        const mk = (txt, aria, disabled, to) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'rl-btn rl-page';
            b.textContent = txt;
            b.setAttribute('aria-label', aria);
            b.disabled = disabled;
            b.addEventListener('click', () => { this.pageIdx = to; this.renderRuns(); const l = document.getElementById('ar-listview'); if (l && l.scrollIntoView) l.scrollIntoView({ block: 'start' }); });
            el.appendChild(b);
        };
        mk('‹', 'Previous page', info.page <= 0, info.page - 1);
        mk('›', 'Next page', info.page >= info.pages - 1, info.page + 1);
    },

    renderRuns() {
        const list = document.getElementById('ar-runlist');
        if (!list) return;
        const RL = window.RunsList;
        if (!RL) return;
        if (!this.filters) this.filters = RL.emptyFilters();
        this._ctx = RL.buildCtx(this.runs, { live: this._liveData, pending: this._pending, coverage: this._coverage });
        const ctx = this._ctx;
        // Keep the detail node out of the list while it is rebuilt.
        const det = document.getElementById('ar-detail');
        const home = this._detailHome();
        if (det && home && det.parentElement !== home) home.appendChild(det);
        const inRange = (this.runs || []).filter(r => RL.inRange(r, this.range, ctx.now));
        this._renderFilterBar(inRange);
        const shown = inRange.filter(r => RL.matches(r, this.filters, ctx));
        this._renderCards(shown);
        list.textContent = '';
        const review = this._reviewMode();
        const flat = review || !this.groupBySession;
        const rangeLabel = (RL.RANGES[this.range] || RL.RANGES['24h']).label.toLowerCase();
        if (!shown.length) {
            const msg = document.createElement('div');
            msg.className = 'ar-empty';
            msg.innerHTML = RL.activeCount(this.filters)
                ? `<div style="font-size:15px;margin-bottom:6px;">No runs match these filters.</div><div style="font-size:13px;">Clear filters to see every run in the ${this._esc(rangeLabel)}.</div>`
                : `<div style="font-size:15px;margin-bottom:6px;">No runs in the ${this._esc(rangeLabel)}.</div><div style="font-size:13px;">Connect a Guard plugin and start a session to see its runs here.</div>`;
            list.appendChild(msg);
            this._renderStatusLine('No runs');
            this._renderPager({ page: 0, pages: 1 }, `Runs 0 of 0 in the ${rangeLabel}`);
            this._liveIds = (this.runs || []).filter(r => this._isLive(r.ended_at)).map(r => r.trace_id).join(',');
            return;
        }
        const ordered = review ? RL.reviewOrder(shown, ctx) : RL.sortRuns(shown, this.sortKey, this.sortDir, ctx);
        // Grouped: page by session, so no session is split across pages.
        // Flat (and Needs review): page by run.
        const info = flat ? RL.page(ordered, this.pageIdx, RL.PAGE_SIZE) : RL.pageSessions(ordered, this.pageIdx, RL.PAGE_SIZE);
        this.pageIdx = info.page;
        const sortName = { started: 'newest first', duration: 'by duration', tokens: 'by tokens', cost: 'by cost', calls: 'by tool calls', status: 'by status', session: 'by session', host: 'by host' }[this.sortKey] || 'newest first';
        const sortText = this.sortKey === 'started' && this.sortDir === 'asc' ? 'oldest first' : sortName;
        this._renderStatusLine(review ? 'Waiting first, oldest first, then blocked'
            : `Runs, ${sortText}${flat ? '' : ', grouped by session'}`);
        list.classList.toggle('rl-flatlist', flat);
        if (flat) {
            list.appendChild(this._sortHeader([['started', 'Started'], [null, 'Run'], ['session', 'Session'], ['host', 'Host · user'],
                ['status', review ? 'Decision' : 'Status · decision'], ['calls', RL_CALLS_HEAD, true, 'tool calls: allowed, waiting, blocked'],
                ['duration', 'Duration', true], ['tokens', 'Tokens', true], ['cost', 'Cost', true]]));
            info.items.forEach(r => list.appendChild(this._runRow(r, true, false)));
        } else {
            list.appendChild(this._sortHeader([['started', 'Started'], [null, 'Run'], ['status', 'Status · decision'],
                ['calls', RL_CALLS_HEAD, true, 'tool calls: allowed, waiting, blocked'], ['duration', 'Duration', true], ['tokens', 'Tokens', true], ['cost', 'Cost', true]]));
            info.groups.forEach(g => {
                // The open run always shows, even when it is an earlier one.
                const { rows, hidden } = RL.sessionRows(g, !!this._expandedSessions[g.key], this.selected);
                const { head, closed, moreRow } = this._sessionHead(g, hidden);
                list.appendChild(head);
                if (closed) return;
                rows.forEach((r, i) => list.appendChild(this._runRow(r, false, true, !moreRow && i === rows.length - 1)));
                if (moreRow) list.appendChild(moreRow);
            });
        }
        if (review) {
            const sessions = new Set(shown.map(r => r.session_id || r.trace_id)).size;
            this._renderPager(info, `${shown.length} run${shown.length === 1 ? '' : 's'} in ${sessions} session${sessions === 1 ? '' : 's'} need${shown.length === 1 ? 's' : ''} review`);
        } else if (flat) {
            this._renderPager(info, `Runs ${info.from}–${info.to} of ${info.total.toLocaleString()} in the ${rangeLabel}`);
        } else {
            this._renderPager(info, `Sessions ${info.from}–${info.to} of ${info.total.toLocaleString()} · ${info.totalRuns.toLocaleString()} run${info.totalRuns === 1 ? '' : 's'} in the ${rangeLabel}`);
        }
        this._liveIds = (this.runs || []).filter(r => this._isLive(r.ended_at)).map(r => r.trace_id).join(',');
        this._fitPanes();
    },

    /** A span hash typed in the search box: look through the runs in view
     *  for a span with that hash and open its run with the span found. */
    async _findSpanHash(hash) {
        const q = String(hash || '').trim().toLowerCase();
        if (!RunsList.looksLikeHash(q)) return false;
        const RL = RunsList;
        const ctx = this._ctx || RL.buildCtx(this.runs);
        const f = Object.assign({}, this.filters, { search: '' });
        const pool = (this.runs || []).filter(r => RL.inRange(r, this.range, ctx.now) && RL.matches(r, f, ctx)).slice(0, 40);
        if (window.Toast) Toast.info(`Looking for span ${q.slice(0, 12)} in ${pool.length} runs…`);
        for (const r of pool) {
            const t = await API.getTrace(r.trace_id);
            const hit = t && (t.spans || []).find(s => s.row_hash && String(s.row_hash).toLowerCase().startsWith(q));
            if (hit) {
                this.filters.search = '';
                const s = document.getElementById('rl-search');
                if (s) s.value = '';
                this._timelineForce = r.trace_id;
                await this.selectRun(r.trace_id);
                // The trace view selects the span the hash names.
                if (window.RunTrace) RunTrace.state(r.trace_id).sel = RunTrace.spanKey(hit, 0);
                this.runSearch = q;
                if (this._trace) this.renderWaterfall(this._trace);
                return true;
            }
        }
        if (window.Toast) Toast.info('No span with that hash in the runs in view.');
        return false;
    },

    async selectRun(traceId, opts) {
        // Accordion toggle: clicking the already-open row collapses it. A
        // programmatic refresh (live tick / window change) must NOT toggle.
        if (!(opts && opts.refresh) && this.selected === traceId && this._inDetail()) {
            this._showList();
            return;
        }
        this.selected = traceId;
        this.runSearch = '';  // a new trace starts unfiltered
        this._replayStop();   // a new trace resets any in-progress replay
        this._live.pendingDetail = false; // stale "new activity" pull is void
        this._live.paused = false;        // pause is per-viewing, not sticky
        this._live.lastDetail = Date.now();
        this._expandUnder(traceId, !(opts && opts.refresh));
        const detail = document.getElementById('ar-detail');
        if (detail) detail.innerHTML = '<div class="ar-empty">Loading trace…</div>';
        const trace = await API.getTrace(traceId);
        if (this.selected !== traceId) return; // a newer run was clicked mid-fetch
        if (!trace) { this._detailEmpty('Trace unavailable.', ''); return; }
        this._trace = trace;
        this.renderWaterfall(trace);
        this._consumePendingGenJump(trace);
    },

    /** Optimizer finding → turn click-through: resolve the one-shot
     *  request_id to the generation span's seq and jump to it. */
    _consumePendingGenJump(trace) {
        const rid = this._pendingGenRid;
        if (!rid) return;
        this._pendingGenRid = null;
        const hit = (trace.spans || []).find(
            s => s.span_kind === 'generation' && s.request_id === rid);
        if (hit && hit._seq != null) { this._setTimeline(true); this._jumpToSpan(hit._seq); }
    },

    /** Per-turn Cost Optimizer annotations — the findings list is discovery,
     *  this is proof: the claim renders on the exact turns it refers to, where
     *  the evidence lives. Best-effort: no report, no chips, no errors. */
    async _annotateOptimizer(trace) {
        if (this._optReport === undefined) {
            // Ask the status route first: the report route answers 404 until
            // a scan has run, which would show as a failed request.
            const st = await fetch('/api/cost-optimizer/status')
                .then(r => (r.ok ? r.json() : null)).catch(() => null);
            this._optReport = (st && st.has_report)
                ? await fetch('/api/cost-optimizer/report')
                    .then(r => (r.ok ? r.json() : null)).catch(() => null)
                : null;
        }
        const rep = this._optReport;
        if (!rep || !trace.session_id || this._trace !== trace) return;
        const findings = (rep.findings || []).filter(f => f.session_id === trace.session_id);
        if (!findings.length) return;
        const byRid = new Map();
        (trace.spans || []).forEach(s => {
            if (s.span_kind === 'generation' && s.request_id) byRid.set(s.request_id, s);
        });
        const LABELS = this._OPT_LABELS;
        findings.forEach(f => {
            (f.evidence && f.evidence.sample_turns || []).forEach(t => {
                const span = t.request_id && byRid.get(t.request_id);
                if (!span || span._seq == null) return;
                const row = document.querySelector(
                    `#ar-detail .ar-span[data-seq="${span._seq}"] .ar-span-row`);
                if (!row || row.querySelector('.ar-opt-chip')) return;
                const chip = document.createElement('span');
                chip.className = 'ar-opt-chip';
                chip.style.cssText =
                    'display:inline-flex;align-items:center;gap:4px;margin-left:6px;' +
                    'padding:1px 7px;border-radius:9999px;font-size:10px;font-weight:600;' +
                    'letter-spacing:0.3px;cursor:pointer;white-space:nowrap;' +
                    'border:1px solid color-mix(in srgb, var(--accent-primary,#5eadb8) 45%, transparent);' +
                    'color:var(--accent-primary,#5eadb8);' +
                    'background:color-mix(in srgb, var(--accent-primary,#5eadb8) 9%, transparent);';
                chip.textContent = LABELS[f.type] || 'Optimizer finding';
                chip.title = (f.evidence && f.evidence.observed) ||
                    'This turn appears in a Cost Optimizer finding.';
                chip.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    if (window.CostsPage) CostsPage._pendingTab = 'optimizer';
                    if (window.Sidebar && Sidebar.navigate) Sidebar.navigate('costs');
                });
                row.appendChild(chip);
            });
        });
    },

    _OPT_LABELS: {
        repeated_context: 'Optimizer: repeated context',
        tool_result_carry: 'Optimizer: result carried',
        low_cache_utilization: 'Optimizer: cache misses',
        retry_loop: 'Optimizer: retry loop',
        duplicate_llm: 'Optimizer: duplicate request',
        excessive_output: 'Optimizer: long output',
        abnormal_loop: 'Optimizer: loop shape',
    },

    renderWaterfall(trace) {
        const detail = document.getElementById('ar-detail');
        if (!detail) return;
        // #ar-detail itself outlives each rebuild, so one listener is enough.
        if (!detail._arPointerWired && detail.addEventListener) {
            detail._arPointerWired = true;
            detail.addEventListener('pointerdown', () => { this._detailPointerAt = Date.now(); }, true);
        }
        detail.textContent = '';
        const color = RUNTIME_COLOR[trace.runtime_kind] || '#64748b';
        const listed = (this.runs || []).find(r => r.trace_id === trace.trace_id);
        const named = Object.assign({}, trace, { terminal_task: listed && listed.terminal_task });
        const taskId = named.terminal_task && named.terminal_task.id;

        // 6.0 run trace view: header, session governance strip, span tree
        // with waterfall and the span / governance panel (js/components/
        // run-trace.js). The step list and the full timeline follow it.
        if (window.RunTrace) {
            this._mountRunTrace(detail, trace, named, taskId);
        } else {
        const head = document.createElement('div');
        head.className = 'ar-det-head';
        head.innerHTML = `<span class="ar-run-dot" style="background:${color}"></span>` +
            `<span class="ar-det-title">${this._esc(this._agentLabel(named))}</span>` +
            `<span class="ar-run-sub">${this._esc(trace.runtime_kind)}</span>` +
            (this._isLive(trace.ended_at) ? this._liveBadge('This session is still running: the trace refreshes itself while activity continues') + this._pauseBtnHtml() : '') +
            `<span class="ar-det-eyebrow" title="One trace per runtime session, with model and tool spans.">SESSION TRACE</span>` +
            (taskId ? '<button type="button" class="ar-terminal-open">Open Terminal task ↗</button>' : '') +
            `<button type="button" class="ar-det-x" title="Close this session trace">×</button>`;
        head.querySelector('.ar-det-x').addEventListener('click', () => this._showList());
        const terminalOpen = head.querySelector('.ar-terminal-open');
        if (terminalOpen) terminalOpen.addEventListener('click', (event) => {
            event.stopPropagation();
            try { sessionStorage.setItem('sv-agent-task-id', taskId); } catch (_) { /* navigation still works */ }
            if (window.Sidebar && Sidebar.navigate) Sidebar.navigate('terminals');
            else if (window.App) App.loadPage('terminals');
        });
        const pauseBtn = head.querySelector('.ar-live-pause');
        if (pauseBtn) pauseBtn.addEventListener('click', () => this._livePauseToggle(pauseBtn));
        detail.appendChild(head);
        }

        // The step list comes first; the full timeline (everything below,
        // unchanged) sits behind "Show full timeline".
        const stepsBox = document.createElement('div');
        if (window.RunTrace) {
            const legacyH = document.createElement('h3');
            legacyH.className = 'rt-legacy-h';
            legacyH.textContent = 'Steps and full timeline';
            detail.appendChild(legacyH);
        }
        stepsBox.className = 'trace-steps';
        stepsBox.id = 'ar-steps';
        detail.appendChild(stepsBox);
        const open = this._timelineIsOpen(trace.trace_id);
        const tBtn = document.createElement('button');
        tBtn.type = 'button';
        tBtn.className = 'ar-timeline-toggle';
        tBtn.setAttribute('aria-controls', 'ar-timeline');
        tBtn.addEventListener('click', () => this._setTimeline(!this._timelineIsOpen(trace.trace_id), { persist: true }));
        detail.appendChild(tBtn);
        const timeline = document.createElement('div');
        timeline.id = 'ar-timeline';
        timeline.className = 'ar-timeline';
        detail.appendChild(timeline);
        this._timelineSync(open);
        this._renderTimeline(trace, timeline);
        // After the timeline so each span carries its _seq for "View in timeline".
        this._renderSteps(trace);
        this._loadHealth(trace);
    },

    /** The run trace view's inputs from the list data, then the session
     *  summary, the requests and the grants (async; the view repaints). */
    _mountRunTrace(detail, trace, named, taskId) {
        const RL = window.RunsList;
        const RT = window.RunTrace;
        const listed = (this.runs || []).find(r => r.trace_id === trace.trace_id) || null;
        const ctx = this._ctx || (RL ? RL.buildCtx(this.runs || []) : null);
        const sid = trace.session_id;
        const ms = (t) => (RL ? RL.ms(t) : this._ms(t)) || 0;
        const sessionRuns = sid ? (this.runs || []).filter(r => r.session_id === sid)
            .sort((a, b) => (ms(a.started_at) || ms(a.ended_at)) - (ms(b.started_at) || ms(b.ended_at))) : [];
        const pos = sessionRuns.findIndex(r => r.trace_id === trace.trace_id);
        const status = listed && RL ? RL.status(listed, ctx) : (this._isLive(trace.ended_at) ? 'running' : 'ok');
        const started = ms(trace.started_at), ended = ms(trace.ended_at);
        const durationMs = status === 'running' && started ? Date.now() - started : (started && ended >= started ? ended - started : null);
        const live = sid && this._liveData && (this._liveData.sessions || []).some(s => s && s.session_id === sid);
        const box = document.createElement('div');
        box.className = 'rt';
        box.id = 'ar-rt';
        detail.appendChild(box);
        const prev = this._rtData && this._rtData.traceId === trace.trace_id ? this._rtData : null;
        const rc = {
            trace,
            title: listed && RL ? RL.name(listed, ctx) : this._agentLabel(named),
            status, durationMs, now: Date.now(),
            harness: (window.DelegationUI && DelegationUI.harnessLabel(trace.runtime_kind)) || trace.runtime_kind,
            project: listed && RL ? RL.project(listed) : null,
            host: listed && listed.host, user: listed && listed.user,
            coverage: (prev && prev.gov && prev.gov.coverage) || (RL ? RL.coverageFor(trace.runtime_kind, ctx) : null),
            runIndex: pos >= 0 ? pos + 1 : null, runTotal: sessionRuns.length,
            prevRun: pos > 0 ? sessionRuns[pos - 1].trace_id : null,
            nextRun: pos >= 0 && pos < sessionRuns.length - 1 ? sessionRuns[pos + 1].trace_id : null,
            newest: !sessionRuns.length || pos === sessionRuns.length - 1,
            canStop: !!(live && taskId),
            gov: prev ? prev.gov : undefined, requests: prev ? prev.requests : [], grants: prev ? prev.grants : [],
            runIndexOf: (tid) => { const i = sessionRuns.findIndex(r => r.trace_id === tid); return i >= 0 ? i + 1 : null; },
            expiryOf: (req) => {
                const g = this._rtData && this._rtData.gov;
                const p = g && g.approvals && (g.approvals.pending || []).find(x => x.id === (req && req.id));
                return (p && p.expires_at) || (req && req.expires_at) || null;
            },
            extraHtml: (status === 'running' ? this._liveBadge('This session is still running: the trace refreshes itself while activity continues') + this._pauseBtnHtml() : '') +
                (taskId ? '<button type="button" class="ar-terminal-open">Open Terminal task ↗</button>' : ''),
            onBack: () => this._showList(),
            onOpenRun: (id) => this.selectRun(id, { refresh: true }),
            onGoto: (id, spanId) => {
                if (spanId && RT) { RT.state(id).sel = 's:' + spanId; }
                this.selectRun(id, { refresh: true });
            },
            onPause: (btn) => this._livePauseToggle(btn),
            onTerminal: () => {
                try { sessionStorage.setItem('sv-agent-task-id', taskId); } catch (_) { /* navigation still works */ }
                if (window.Sidebar && Sidebar.navigate) Sidebar.navigate('terminals');
                else if (window.App) App.loadPage('terminals');
            },
            onStop: () => this._rtStop(taskId, sid),
            onDecide: (act, req, duration) => this._rtDecide(box, act, req, duration),
            onRevoke: (grantId, btn) => this._rtRevoke(box, grantId, btn),
        };
        RT.mount(box, rc);
        this._rtLoad(box, trace);
    },

    /** Fetch the session summary, the session's requests and grants, and
     *  repaint the trace view. Read only. */
    async _rtLoad(box, trace) {
        const sid = trace.session_id;
        const [gov, reqs, grants] = await Promise.all([
            sid && API.getSessionGovernance ? API.getSessionGovernance(sid).catch(() => false) : Promise.resolve(false),
            API.getJitRequests ? API.getJitRequests() : Promise.resolve({ items: [] }),
            API.getJitGrants ? API.getJitGrants() : Promise.resolve({ items: [] }),
        ]);
        if (this.selected !== trace.trace_id || !box.isConnected) return;
        const mine = (x) => x && (x.session_id === sid || x.trace_id === trace.trace_id);
        const data = {
            traceId: trace.trace_id,
            gov: gov || false,
            requests: ((reqs && reqs.items) || []).filter(mine),
            grants: ((grants && grants.items) || []).filter(mine),
        };
        this._rtData = data;
        const patch = { gov: data.gov, requests: data.requests, grants: data.grants, now: Date.now() };
        if (data.gov && data.gov.coverage) patch.coverage = data.gov.coverage;
        window.RunTrace.update(box, patch);
        // One-shot from the Live grid's Review: select the held call's span
        // so the decision is made in the span panel with its full context.
        const wantReq = this._pendingReq;
        this._pendingReq = null;
        if (wantReq && box._rt && box._rt.tree) {
            let key = null;
            window.RunTrace.walk(box._rt.tree, n => { if (!key && n.req && n.req.id === wantReq) key = n.key; });
            if (key) window.RunTrace.select(box, key);
        }
    },

    /** Allow or Deny one held call: only from the span panel, through the
     *  JIT approve / deny routes (UI token and the app's confirmation). */
    async _rtDecide(box, act, req, duration) {
        const RT = window.RunTrace;
        if (!box._rt) return;
        // Busy lives in the per-trace view state, so a live rebuild during
        // the decision keeps the buttons disabled.
        const st = RT.state(box._rt.trace.trace_id);
        if (st.busy) return;
        st.busy = true;
        RT.paint(box);
        try {
            if (act === 'deny') await API.denyJitRequest(req.id, 'Denied from the run trace');
            else await API.approveJitRequest(req.id, duration);
            const what = act === 'deny' ? 'Denied' : (duration === 'once' ? 'Allowed once' : 'Allowed');
            if (window.Toast) (Toast.success || Toast.info).call(Toast, `${what}: ${req.tool_id || 'the call'}, in this session only`);
        } catch (e) {
            if (window.Toast) Toast.error((e && e.message) || 'The decision did not go through');
        } finally {
            st.busy = false;
            if (box._rt && this._trace && this._trace.trace_id === box._rt.trace.trace_id) await this._rtLoad(box, this._trace);
            else RT.paint(box);
        }
    },

    async _rtRevoke(box, grantId, btn) {
        if (!grantId) return;
        if (btn) btn.disabled = true; // one revoke in flight per button
        try {
            await API.revokeJitGrant(grantId);
            if (window.Toast) (Toast.success || Toast.info).call(Toast, 'Approval revoked');
        } catch (e) {
            if (window.Toast) Toast.error((e && e.message) || 'Could not revoke');
        }
        if (this._trace) await this._rtLoad(box, this._trace);
    },

    /** Stop the live session through the Terminals stop route, after a
     *  confirmation. Shown only for a running app-owned task. */
    _rtStop(taskId, sid) {
        if (!taskId) return;
        const go = async () => {
            try {
                await API.terminalsStop(taskId);
                if (window.Toast) (Toast.success || Toast.info).call(Toast, 'Session stopped');
            } catch (e) {
                if (window.Toast) Toast.error((e && e.message) || 'Could not stop the session');
            }
        };
        const msg = `Stop session ${String(sid || '').slice(0, 8)}? The agent's terminal task ends now.`;
        if (window.Modal && Modal.confirm) Modal.confirm({ title: 'Stop session', message: msg, confirmLabel: 'Stop session', onConfirm: go });
        else if (window.confirm(msg)) go();
    },

    /** The open run's health findings, or null until fetched. */
    _healthFor(traceId) {
        const e = this._health && this._health[traceId];
        return e && e.data ? e.data : null;
    },

    /** Fetch a run's health once per opened run, and again only when the
     *  run has grown (a live refresh). Repaints the step list on arrival. */
    _loadHealth(trace) {
        const id = trace && trace.trace_id;
        if (!id) return;
        const key = `${trace.ended_at || ''}|${trace.span_count || 0}`;
        const cache = this._health || (this._health = {});
        const e = cache[id];
        if (e && e.key === key && (e.data || e.pending || e.failed)) return;
        const had = e && e.data ? e.data : null;
        cache[id] = { key, data: had, pending: true };
        Promise.resolve()
            .then(() => API.request(`/api/traces/${encodeURIComponent(id)}/health`))
            .then((data) => { cache[id] = { key, data: data || null }; })
            .catch(() => { cache[id] = { key, data: had, failed: true }; })
            .then(() => {
                if (this.selected === id && this._trace && this._trace.trace_id === id) this._renderSteps(this._trace);
            });
    },

    /** Copy a finding's nudge; the button says so. */
    _copyNudge(btn, text) {
        const done = () => { btn.textContent = 'Copied'; if (window.Toast) Toast.success('Nudge copied, paste it into your session'); };
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(String(text)).then(done, () => { if (window.Toast) Toast.error('Could not copy'); });
                return;
            }
        } catch (e) { /* fall through */ }
        if (window.Toast) Toast.error('Could not copy');
    },

    // --- the step list and the full timeline toggle ------------------------

    /** Saved choice: the full timeline starts collapsed unless the user
     *  opened it last time, or a deep link asked for this trace. */
    _timelineIsOpen(traceId) {
        if (this._timelineForce && this._timelineForce === traceId) return true;
        // Within this page, the state last set for this trace wins, so a
        // rebuild keeps it even when the saved choice could not be stored.
        if (this._timelineMem && this._timelineMem.traceId === traceId) return this._timelineMem.open;
        try { return localStorage.getItem('sv-ar-timeline') === 'open'; } catch (e) { return false; }
    },

    /** Show or hide the full timeline in place (no rebuild, so nothing below
     *  loses its state). `persist` records the user's own choice. */
    _setTimeline(open, opts = {}) {
        const traceId = this._trace && this._trace.trace_id;
        if (opts.persist) {
            this._timelineForce = null;
            try { localStorage.setItem('sv-ar-timeline', open ? 'open' : 'closed'); } catch (e) { /* private mode */ }
        } else if (open) {
            this._timelineForce = traceId || null;
        } else if (this._timelineForce && this._timelineForce === traceId) {
            this._timelineForce = null;
        }
        this._timelineMem = traceId ? { traceId, open: !!open } : null;
        this._timelineSync(open);
        if (!open && this._stepsFocus && this._stepsFocus.traceId === traceId) {
            this._stepsFocus = null;
            if (this._trace) this._renderSteps(this._trace);
        }
        // Replay drives rows the user can no longer see: stop it.
        if (!open && this._replay && this._replay.on && this._trace) this._replayExit();
    },

    _timelineSync(open) {
        const tl = document.getElementById('ar-timeline');
        const btn = document.querySelector('#ar-detail .ar-timeline-toggle');
        if (tl) tl.hidden = !open;
        if (btn) {
            btn.setAttribute('aria-expanded', open ? 'true' : 'false');
            btn.textContent = open ? 'Hide full timeline ▴' : 'Show full timeline ▾';
        }
    },

    /** Paint the step list from the trace already fetched (no extra fetch). */
    _renderSteps(trace) {
        const box = document.getElementById('ar-steps');
        if (!box || !window.TraceSteps) return;
        const traceId = trace.trace_id;
        const sd = this._stepsDetail && this._stepsDetail.traceId === traceId ? this._stepsDetail : null;
        const active = document.activeElement;
        const focusKey = active && box.contains(active) && active.getAttribute ? active.getAttribute('data-fk') : null;
        box.innerHTML = TraceSteps.html(traceId, trace, {
            prefix: 'trace-steps',
            stepsMax: 8,
            chipsMax: 8,
            detailKey: sd ? sd.key : undefined,
            fullRunLabel: '',
            moreLabel: 'see full timeline',
            modelLabel: trace.runtime_kind === 'claude-code' ? 'Claude thinking' : 'Model thinking',
            jumpLabel: 'View in timeline',
            health: this._healthFor(traceId),
            findingsOpen: this._healthOpen === traceId,
            focusStep: this._stepsFocus && this._stepsFocus.traceId === traceId ? this._stepsFocus.step : undefined,
        });
        box.querySelectorAll('button.trace-steps-findings-toggle').forEach(b => {
            b.addEventListener('click', () => {
                this._healthOpen = this._healthOpen === traceId ? null : traceId;
                this._renderSteps(trace);
            });
        });
        box.querySelectorAll('button.trace-steps-finding-jump').forEach(b => {
            b.addEventListener('click', () => {
                const step = Number(b.dataset.step);
                this._stepsFocus = { traceId, step };
                this._renderSteps(trace);
                const row = box.querySelector(`.trace-steps-row[data-step="${step}"]`);
                if (row && row.scrollIntoView) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
        });
        box.querySelectorAll('button.trace-steps-finding-copy').forEach(b => {
            b.addEventListener('click', () => {
                const f = TraceSteps.findingById(this._healthFor(traceId), b.dataset.findingId);
                if (f && f.nudge) this._copyNudge(b, f.nudge);
            });
        });
        box.querySelectorAll('button.trace-steps-chip:not(.trace-steps-more)').forEach(b => {
            b.addEventListener('click', () => {
                const on = b.getAttribute('aria-pressed') === 'true';
                this._stepsDetail = { traceId, key: on ? '' : b.dataset.stepKey };
                this._renderSteps(trace);
            });
        });
        box.querySelectorAll('button.trace-steps-more').forEach(b => {
            b.addEventListener('click', () => this._setTimeline(true));
        });
        box.querySelectorAll('button.trace-steps-jump').forEach(b => {
            b.addEventListener('click', () => {
                const span = TraceSteps.spanForKey(TraceSteps.build(trace.spans, { egressBlocks: trace.egress_blocks }), b.dataset.stepKey);
                this._setTimeline(true);
                if (span && span._seq != null) this._jumpToSpan(span._seq);
            });
        });
        if (focusKey) {
            const again = Array.from(box.querySelectorAll('[data-fk]')).find(x => x.getAttribute('data-fk') === focusKey);
            if (again && again.focus) again.focus();
        }
    },

    /** The full timeline: masthead, filters, minimap, replay and the span
     *  waterfall, exactly as the trace view has always drawn them. */
    _renderTimeline(trace, detail) {
        const allSpans = trace.spans || [];
        // Honest per-run timing annotations (spans arrive oldest→newest by seq).
        // We have each run's START timestamp but not its latency, so we show
        //   _gap: wall-clock since the PREVIOUS event started ("+2.3s"), and
        //   _pos: 0..1 position within the trace window (the mini timeline) —
        // never a fabricated duration bar. Gaps are computed on the UNFILTERED
        // chronology so a filtered view can't misattribute time.
        {
            const t0 = allSpans.length ? this._ms(allSpans[0].called_at) : 0;
            const t1 = allSpans.length ? this._ms(allSpans[allSpans.length - 1].called_at) : 0;
            allSpans.forEach((s, i) => {
                s._gap = i > 0 ? Math.max(0, this._ms(s.called_at) - this._ms(allSpans[i - 1].called_at)) : null;
                s._pos = (t1 > t0) ? (this._ms(s.called_at) - t0) / (t1 - t0) : 0;
                s._seq = i; // chronological id — the minimap jumps by it
            });
            // Largest start-to-start gap — scales the per-row gap bars so the
            // slow steps are visually scannable (log scale in _timingHtml).
            this._maxGap = allSpans.reduce((a, s) => Math.max(a, s._gap || 0), 0);
            // Trace window (first start to last start) scales the duration
            // bars on the per-row timeline.
            this._traceWin = Math.max(0, t1 - t0);
        }
        const toolSpans = allSpans.filter(s => s.span_kind !== 'generation');
        const genCount = trace.generation_count != null
            ? trace.generation_count : allSpans.length - toolSpans.length;
        const toolCount = trace.tool_call_count != null ? trace.tool_call_count : toolSpans.length;
        const extCount = toolSpans.filter(s => ObsTabs.isExternalTool(s.tool_id)).length;
        const run = (this.runs || []).find(r => r.trace_id === trace.trace_id) || {};
        const sid = String(run.session_id || trace.trace_id || '');
        // Masthead — the trace's vitals as a scannable stat strip (was a
        // dotted inline sentence the eye had to parse word by word). Values
        // are monospace/tabular; labels are small caps; a third dim line
        // carries the detail (built-in/external split, display truncation).
        const totalCost = Number(trace.generation_total_cost || 0);
        const dur = this._fmtDuration(trace.started_at, trace.ended_at);
        const stat = (v, label, det, cls) =>
            `<div class="ar-stat${cls ? ' ' + cls : ''}"><div class="ar-stat-v">${v}</div>` +
            `<div class="ar-stat-l">${label}</div>` + (det ? `<div class="ar-stat-d">${det}</div>` : '') + `</div>`;
        const mast = document.createElement('div');
        mast.className = 'ar-masthead';
        mast.innerHTML =
            (genCount || trace.generation_total
                ? stat(Number(trace.generation_total || genCount).toLocaleString(),
                    (trace.generation_total || genCount) === 1 ? 'LLM run' : 'LLM runs',
                    trace.generation_truncated ? `latest ${genCount.toLocaleString()} shown` : '')
                : '') +
            stat(toolCount.toLocaleString(), toolCount === 1 ? 'tool run' : 'tool runs',
                `${toolCount - extCount} built-in · ${extCount} external`) +
            (totalCost > 0
                ? (() => {
                    // Multi-day session: the lifetime figure can't match the
                    // dashboard's "Spend today", so surface today's slice to
                    // make the two numbers reconcilable at a glance.
                    const todayCost = Number(trace.generation_today_cost || 0);
                    const multiDay = totalCost - todayCost > 0.005;
                    const det = (multiDay
                        ? `≈$${todayCost.toFixed(todayCost < 0.01 ? 4 : 2)} of it today · `
                        : '') + 'list-price equivalent';
                    const tip = 'Estimated from transcript token counts × API list prices, total across every LLM run in this trace. Not metered billing: on a subscription plan (e.g. Claude Pro/Max) this usage is included, not invoiced.'
                        + (multiDay ? ' The dashboard\'s Spend today counts only the today slice.' : '');
                    return stat(`≈$${totalCost.toFixed(totalCost < 0.01 ? 4 : 2)}`, 'LLM cost · est.',
                        `<span title="${tip}">${det}</span>`);
                })()
                : '') +
            (trace.expensive_turn && trace.expensive_turn.cost > 0 && (trace.generation_count || 0) > 1
                ? stat(`#${trace.expensive_turn.turn_index} · ≈$${Number(trace.expensive_turn.cost).toFixed(trace.expensive_turn.cost < 0.01 ? 4 : 2)}`,
                    'costliest turn', `<span title="The single model turn that cost the most in this run">${this._esc(trace.expensive_turn.model || '')}</span>`)
                : '') +
            ((trace.cost_by_model || []).length > 1
                ? stat(String(trace.cost_by_model.length), 'models',
                    this._esc(trace.cost_by_model.slice(0, 3).map(m => `${m.model} ≈$${Number(m.cost).toFixed(m.cost < 0.01 ? 4 : 2)}`).join(' · ')))
                : '') +
            (dur && dur !== '0s'
                ? stat(dur, 'wall clock', '<span title="Time from the first to the last run: not per-run latency">first → last run</span>')
                : '') +
            (this._blockedTotal(trace)
                ? stat(Number(this._blockedTotal(trace)).toLocaleString(), 'blocked', 'enforcement stopped these', 'danger')
                : '');
        detail.appendChild(mast);
        // Provenance — which session produced this trace. One quiet line.
        const sub = document.createElement('div');
        sub.className = 'ar-det-sub';
        sub.innerHTML =
            `<span class="ar-sid ar-det-dim">from session ` +
            (sid ? `<code>${this._esc(sid)}</code><button class="ar-copy" data-copy="${this._esc(sid)}" title="Copy session id">copy</button>` : '<code>—</code>') +
            ` · trace <code>${this._esc(String(trace.trace_id).slice(0, 12))}…</code></span>`;
        detail.appendChild(sub);
        const cp = sub.querySelector('.ar-copy');
        if (cp) cp.onclick = () => {
            const txt = cp.dataset.copy, done = () => { cp.textContent = 'copied'; setTimeout(() => { cp.textContent = 'copy'; }, 1200); };
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done).catch(() => {});
            else { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) { } document.body.removeChild(ta); }
        };

        // Flag strip — in a 400-span run the few flagged steps are invisible.
        // Surface the counts (from the FULL run) as one-click filters so an
        // analyst jumps straight to the threats / secrets / blocks. Keyed off
        // detection_source so it matches the virus/lock glyphs and the filter.
        const nDetect = allSpans.filter(s => s.detection_source).length;
        const nSecret = allSpans.filter(s => s.detection_source && this._isSecret(s)).length;
        const nBlocked = allSpans.filter(s => s.outcome === 'blocked' || s.action === 'block').length;
        if (nDetect || nBlocked) {
            const strip = document.createElement('div');
            strip.className = 'ar-flag-strip';
            const chip = (cls, icon, n, label, filter) => {
                if (!n) return;
                const c = document.createElement('button');
                c.type = 'button';
                c.className = 'ar-flag-chip ' + cls + (this.outcomeFilter === filter ? ' active' : '');
                c.innerHTML = `${icon}<b>${n}</b>&nbsp;${label}`;
                c.onclick = () => {
                    this.outcomeFilter = (this.outcomeFilter === filter ? 'all' : filter);
                    if (this._outcomeSel) this._outcomeSel.value = this.outcomeFilter;
                    this.renderWaterfall(this._trace);
                };
                strip.appendChild(c);
            };
            chip('threat', AR_VIRUS_SVG('#ef4444', 13), nDetect, `detected${nDetect > 1 ? '' : ''}`, 'threat');
            chip('secret', AR_LOCK_SVG('#f59e0b', 13), nSecret, 'secret', 'secret');
            chip('blocked', BAN_SVG('#ef4444', 12), nBlocked, 'blocked', 'blocked');
            if (this.outcomeFilter !== 'all') {
                const clr = document.createElement('button');
                clr.type = 'button'; clr.className = 'ar-flag-chip clear';
                clr.textContent = '× show all'; // multiplication sign, not a dingbat — page is emoji-free by test
                clr.onclick = () => { this.outcomeFilter = 'all'; if (this._outcomeSel) this._outcomeSel.value = 'all'; this.renderWaterfall(this._trace); };
                strip.appendChild(clr);
            }
            detail.appendChild(strip);
        }

        // Session minimap (the Honeycomb trace-summary pattern): the whole
        // session as one horizontal strip, flagged runs as clickable ticks,
        // prev/next navigation across them. Long traces stop being a scroll
        // hunt: the strip shows WHERE the trouble is before you scroll.
        const mini = this._miniMap(allSpans);
        if (mini) detail.appendChild(mini);

        // Apply the built-in / external checkbox filter. The API returns spans
        // oldest→newest by seq. Normal view shows NEWEST first; replay shows
        // OLDEST first so the session plays forward in time.
        const chrono = allSpans.filter(s => {
            // Generations aren't tools — they bypass the built-in/external
            // checkbox, but a tool-scope or outcome-scope filter (threats,
            // secrets, blocked, or one tool) hides them since they carry no
            // outcome. So the default interleaved view shows LLM turns +
            // tool calls; any active filter narrows to tool calls.
            if (s.span_kind === 'generation') {
                return !this.toolFilter && this.outcomeFilter === 'all';
            }
            return (ObsTabs.isExternalTool(s.tool_id) ? this.kinds.external : this.kinds.builtin)
                && (!this.toolFilter || s.tool_id === this.toolFilter)
                && this._outcomeMatch(s);
        });
        this._replay.count = chrono.length;
        const spans = this._replay.on ? chrono : chrono.slice().reverse();

        if (!spans.length) {
            const none = !this.kinds.builtin && !this.kinds.external;
            if (this.toolFilter || this.outcomeFilter !== 'all') {
                const what = [this.toolFilter ? this._esc(String(this.toolFilter).split(':').pop()) : '',
                this.outcomeFilter !== 'all' ? this.outcomeFilter.replace('_', '-') : ''].filter(Boolean).join(' · ');
                this._detailEmpty(`No ${what} calls in this trace.`, 'Clear the Tool/Outcome filter to see the full trace.', detail);
                return;
            }
            const msg = none ? 'No tool kind selected.'
                : !this.kinds.builtin ? 'No external MCP calls in this trace.'
                    : 'No built-in tool calls in this trace.';
            this._detailEmpty(msg, none ? 'Tick Built-in or External MCP to show steps.' : 'Tick the other Tool checkbox to see everything.', detail);
            return;
        }

        // Heading that names the containment: everything below is a run that
        // belongs to THIS trace — the direct answer to "which run is whose".
        const runsHead = document.createElement('div');
        runsHead.className = 'ar-runs-heading';
        const hb = document.createElement('b');
        hb.textContent = 'Spans in this trace';
        runsHead.appendChild(hb);
        // In-trace search — filter the loaded runs by tool / model / reason.
        // Hidden during replay (replay owns row visibility). Typing toggles row
        // visibility in place (no rebuild) so focus/caret are never lost.
        if (!this._replay.on) {
            const search = document.createElement('input');
            search.type = 'search';
            search.className = 'ar-run-search';
            search.placeholder = 'Filter runs: tool, model, reason, span…';
            search.value = this.runSearch;
            search.addEventListener('input', () => {
                const was = this.runSearch;
                this.runSearch = search.value;
                // Entering/leaving search flips collapse (groups vs individual
                // rows), which needs a rebuild; a keystroke within search just
                // re-filters the existing rows.
                if ((!was) !== (!this.runSearch)) { this._searchRefocus = true; this.renderWaterfall(this._trace); }
                else { this._applySearch(); }
            });
            runsHead.appendChild(search);
        }
        const cnt = document.createElement('span');
        cnt.className = 'ar-runs-count';
        const orderNote = this._replay.on ? 'oldest first' : 'newest first';
        const scoped = (this.toolFilter || this.outcomeFilter !== 'all') ? 'matching · ' : '';
        cnt.textContent = `${scoped}${chrono.length} shown · ${orderNote}`;
        runsHead.appendChild(cnt);
        detail.appendChild(runsHead);

        // Replay controls sit above the waterfall (only when there are events).
        detail.appendChild(this._replayBar(chrono.length));

        // LLM-turn collapse toggle — only meaningful when there are generations
        // and we're not in replay / a scoped filter (which show everything).
        if (genCount > 0 && !this._replay.on && !this.toolFilter && this.outcomeFilter === 'all') {
            const t = document.createElement('button');
            t.type = 'button';
            t.className = 'ar-gentoggle';
            t.innerHTML = this.collapseGens
                ? `${AR_ROBOT_SVG('#8b949e', 12)}<span>LLM runs collapsed</span><span class="ar-gentoggle-act">Expand all</span>`
                : `${AR_ROBOT_SVG('#5eadb8', 12)}<span>LLM runs expanded</span><span class="ar-gentoggle-act">Collapse</span>`;
            t.addEventListener('click', () => { this.collapseGens = !this.collapseGens; this.renderWaterfall(this._trace); });
            detail.appendChild(t);
        }

        // Chronological index for replay: the playhead reveals events oldest→
        // newest regardless of the current display order. In replay mode `spans`
        // is already oldest-first (i === ridx); in normal (newest-first) mode we
        // map back so a span keeps its true time position.
        const ridxOf = (i) => this._replay.on ? i : (spans.length - 1 - i);
        // Persona feedback (unanimous): a long session buries tool calls under a
        // wall of near-identical LLM turns. So we COLLAPSE consecutive
        // generation spans into one expandable summary by default, keeping the
        // security signal (tool calls + verdicts) as the primary rows. Replay
        // and an active tool/outcome filter show everything un-grouped.
        const collapse = this.collapseGens !== false && !this._replay.on
            && !this.toolFilter && this.outcomeFilter === 'all' && !this.runSearch;
        // Default view → the NESTED tree (Pillar 1): tool runs indented under
        // their LLM run. Replay (chronological playback), an active filter, or a
        // search keep the FLAT list — those are lookups, not structure views.
        const treeView = !this._replay.on && !this.toolFilter
            && this.outcomeFilter === 'all' && !this.runSearch && genCount > 0;
        if (treeView) {
            this._renderTurns(detail, chrono, collapse);
        } else {
            let i = 0;
            while (i < spans.length) {
                const s = spans[i];
                if (collapse && s.span_kind === 'generation') {
                    let j = i;
                    const group = [];
                    while (j < spans.length && spans[j].span_kind === 'generation') { group.push(spans[j]); j++; }
                    if (group.length >= 2) {
                        detail.appendChild(this._genGroup(group, ridxOf, i));
                        i = j;
                        continue;
                    }
                }
                const el = s.span_kind === 'generation' ? this._genSpan(s) : this._toolSpanEl(s);
                el.dataset.ridx = ridxOf(i);
                if (this.runSearch) el.dataset.search = this._searchText(s);
                detail.appendChild(el);
                i++;
            }
        }

        // In replay mode, hide everything past the playhead and highlight the
        // current event (class-toggle only — no re-render on each tick).
        if (this._replay.on) this._applyReplay();
        // Apply an active in-trace search to the freshly rendered rows, and
        // restore focus to the search box after a mode-flip rebuild.
        if (this.runSearch) this._applySearch();
        if (this._searchRefocus) {
            this._searchRefocus = false;
            const el = detail.querySelector('.ar-run-search');
            if (el) { el.focus(); const v = el.value; try { el.setSelectionRange(v.length, v.length); } catch (_) {} }
        }
        // Optimizer chips survive filter/replay re-renders because they're
        // re-applied here, after every rebuild of the span rows.
        this._annotateOptimizer(trace);
    },

    /** Render the trace as a NESTED tree (best-practice Pillar 1): group the
     *  chronological runs into turns — each LLM run + the tool runs it triggered
     *  (until the next LLM run) — and indent the tool runs under their parent.
     *  Turns display newest-first; within a turn, the parent LLM run then its
     *  tool runs in execution order. Consecutive childless LLM turns (thinking /
     *  end_turn, no tool) fold into one "N LLM runs" summary. */
    _renderTurns(detail, chrono, collapse) {
        const turns = [];
        let cur = null;
        // generation span_id -> its turn (5.3.0 parent links). Built first so a
        // tool run links to its turn even when the two rows sort out of order
        // (the SDK stamps the model call, the app stamps the tool call).
        const bySpan = new Map();
        chrono.forEach(s => {
            if (s.span_kind === 'generation') {
                const turn = { gen: s, tools: [] };
                turns.push(turn);
                if (s.span_id) bySpan.set(s.span_id, turn);
            }
        });
        const linked = new Set();
        chrono.forEach(s => {
            if (s.span_kind === 'generation') return;
            const parent = s.parent_span_id ? bySpan.get(s.parent_span_id) : null;
            if (parent) { parent.tools.push(s); linked.add(s); }
        });
        // Unlinked tool runs fall under the most recent model turn before them.
        const ordered = [];
        chrono.forEach(s => {
            if (s.span_kind === 'generation') { cur = bySpan.get(s.span_id) || turns.find(t => t.gen === s); ordered.push(cur); return; }
            if (linked.has(s)) return;
            if (!cur) { cur = { gen: null, tools: [] }; ordered.push(cur); }
            cur.tools.push(s);
        });
        turns.length = 0; ordered.forEach(t => turns.push(t));
        // Chronological step numbers BEFORE reversing: step 1 = the first thing
        // that happened, whatever the display order.
        turns.forEach((t, i) => { t.step = i + 1; });
        turns.reverse(); // most-recent turn on top (matches the flat default)

        let k = 0;
        while (k < turns.length) {
            const turn = turns[k];
            if (collapse && turn.gen && turn.tools.length === 0) {
                const grp = [];
                while (k < turns.length && turns[k].gen && turns[k].tools.length === 0) { grp.push(turns[k]); k++; }
                if (grp.length >= 2) { detail.appendChild(this._genGroup(grp.map(t => t.gen), (x) => x, 0)); continue; }
                detail.appendChild(this._genSpan(grp[0].gen, grp[0].step));
                continue;
            }
            if (turn.gen && turn.tools.length) {
                // One STEP block: the LLM turn + the tool calls it triggered,
                // joined by the elbow rail and numbered on the spine.
                const step = document.createElement('div');
                step.className = 'ar-step';
                step.appendChild(this._genSpan(turn.gen, turn.step));
                const kids = document.createElement('div');
                kids.className = 'ar-turn-children';
                turn.tools.forEach(t => kids.appendChild(this._toolSpanEl(t)));
                step.appendChild(kids);
                detail.appendChild(step);
            } else if (turn.gen) {
                detail.appendChild(this._genSpan(turn.gen, turn.step));
            } else if (turn.tools.length) {
                // Rootless tool runs (before the first LLM run, or a trace
                // with no readable transcript) render at the root level.
                turn.tools.forEach(t => detail.appendChild(this._toolSpanEl(t)));
            }
            k++;
        }
    },

    /** Lower-cased searchable text for a run: tool/model/reason/verdict. */
    // ---------------- session minimap ----------------

    /** One horizontal strip = the whole session. Every run is a faint tick on
     *  a canvas (LLM runs shorter, tool runs taller); flagged runs (blocked /
     *  threat / secret) are real buttons on top, colored by security state.
     *  Click anywhere to jump to the nearest run; ‹ › steps through flags.
     *  Returns null for short traces where the waterfall is scannable as-is. */
    _miniMap(allSpans) {
        if ((allSpans || []).length < 20) return null;
        const flagged = allSpans.filter(s => s.span_kind !== 'generation'
            && (s.outcome === 'blocked' || s.action === 'block' || !!s.detection_source));
        this._flagged = flagged;
        this._flagIdx = -1;
        const wrap = document.createElement('div');
        wrap.className = 'ar-minimap';
        const track = document.createElement('div');
        track.className = 'ar-mini-track';
        track.title = 'The whole session, first run to last. Click to jump there in the waterfall.';
        // Density layer: a fixed-resolution canvas scaled by CSS, so we never
        // have to measure the container or re-draw on resize.
        const W = 1200, H = 34;
        const cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        cv.className = 'ar-mini-canvas';
        const ctx = cv.getContext('2d');
        allSpans.forEach(s => {
            const gen = s.span_kind === 'generation';
            const h = gen ? 10 : 18;
            ctx.fillStyle = gen ? 'rgba(139,148,158,0.20)' : 'rgba(139,148,158,0.42)';
            ctx.fillRect(Math.round(s._pos * (W - 3)) + 1, (H - h) / 2, 2, h);
        });
        track.appendChild(cv);
        flagged.forEach((s, i) => {
            const blocked = s.outcome === 'blocked' || s.action === 'block';
            const sec = !blocked && this._isSecret(s);
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'ar-mini-tick' + (sec ? ' sec' : '');
            b.style.left = ((s._pos || 0) * 100) + '%';
            b.title = `#${s.turn_index ?? '?'} ${s.function_name || s.tool_id || 'tool'} · ` +
                (blocked ? 'blocked' : sec ? 'secret detected' : 'threat detected');
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                this._flagIdx = i;
                this._flagCountSync();
                this._jumpToSpan(s._seq);
            });
            track.appendChild(b);
        });
        track.addEventListener('click', (e) => {
            const r = track.getBoundingClientRect();
            if (!r.width) return;
            const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
            let best = null, bd = 2;
            allSpans.forEach(s => {
                const d = Math.abs((s._pos || 0) - frac);
                if (d < bd) { bd = d; best = s; }
            });
            if (best) this._jumpToSpan(best._seq);
        });
        const lab = (txt) => {
            const el = document.createElement('span');
            el.className = 'ar-mini-time';
            el.textContent = txt;
            return el;
        };
        wrap.appendChild(lab(this._fmtTime(allSpans[0].called_at)));
        wrap.appendChild(track);
        wrap.appendChild(lab(this._fmtTime(allSpans[allSpans.length - 1].called_at)));
        if (flagged.length) {
            const nav = document.createElement('span');
            nav.className = 'ar-mini-nav';
            const mk = (glyph, dir, title) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'ar-mini-navbtn';
                b.textContent = glyph;
                b.title = title;
                b.addEventListener('click', () => this._flagNav(dir));
                return b;
            };
            nav.appendChild(mk('‹', -1, 'Previous flagged run'));
            const count = document.createElement('span');
            count.className = 'ar-mini-count';
            count.textContent = flagged.length + ' flagged';
            this._flagCountEl = count;
            nav.appendChild(count);
            nav.appendChild(mk('›', 1, 'Next flagged run'));
            wrap.appendChild(nav);
        }
        return wrap;
    },

    /** Step the flag cursor and jump. Wraps at both ends. */
    _flagNav(dir) {
        const flags = this._flagged || [];
        if (!flags.length) return;
        this._flagIdx = ((this._flagIdx == null ? -1 : this._flagIdx) + dir + flags.length) % flags.length;
        this._flagCountSync();
        this._jumpToSpan(flags[this._flagIdx]._seq);
    },

    _flagCountSync() {
        const flags = this._flagged || [];
        if (this._flagCountEl && flags.length) {
            this._flagCountEl.textContent = this._flagIdx >= 0
                ? `${this._flagIdx + 1} / ${flags.length}` : flags.length + ' flagged';
        }
    },

    /** Scroll the waterfall to the run with this chronological id and flash
     *  it. Falls back to the nearest VISIBLE run when the exact row is folded
     *  into a collapsed LLM group or hidden by search/filters. */
    _jumpToSpan(seq) {
        const detail = document.getElementById('ar-detail');
        if (!detail) return;
        let el = detail.querySelector(`.ar-span[data-seq="${seq}"]`);
        if (el && (el.offsetParent === null || el.classList.contains('ar-search-hidden'))) el = null;
        if (!el) {
            const rows = [...detail.querySelectorAll('.ar-span[data-seq]')]
                .filter(r => r.offsetParent !== null && !r.classList.contains('ar-search-hidden'));
            if (!rows.length) return;
            el = rows.reduce((a, r) =>
                Math.abs(+r.dataset.seq - seq) < Math.abs(+a.dataset.seq - seq) ? r : a, rows[0]);
        }
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.remove('ar-jump-hit');
        void el.offsetWidth; // restart the flash animation
        el.classList.add('ar-jump-hit');
    },

    _searchText(s) {
        if (s.span_kind === 'generation') {
            return [s.model, s.stop_reason, ...(s.tools_called || [])].join(' ').toLowerCase();
        }
        // Include outcome ("blocked"/"allow"/"log_only") so the natural word for
        // a verdict is searchable, not just the raw action ("block").
        return [s.function_name, s.tool_id, s.reason, s.action, s.outcome, s.risk, s.row_hash].join(' ').toLowerCase();
    },

    /** Filter the rendered runs to those matching runSearch — pure show/hide,
     *  no rebuild, so the search box keeps focus while typing. Updates the count. */
    _applySearch() {
        const detail = document.getElementById('ar-detail');
        if (!detail) return;
        const q = (this.runSearch || '').trim().toLowerCase();
        let shown = 0, total = 0;
        detail.querySelectorAll('.ar-span[data-ridx]').forEach(el => {
            total++;
            const hit = !q || (el.dataset.search || this._deriveSearch(el)).includes(q);
            el.classList.toggle('ar-search-hidden', !hit);
            if (hit) shown++;
        });
        const cnt = detail.querySelector('.ar-runs-count');
        if (cnt) cnt.textContent = q
            ? `${shown} of ${total} match “${this.runSearch.trim()}”`
            : `${total} shown · newest first`;
    },

    /** Fallback searchable text from a rendered row (if dataset.search unset). */
    _deriveSearch(el) {
        const t = (el.querySelector('.ar-span-tool') || {}).textContent || '';
        const r = (el.querySelector('.ar-reason-inline') || {}).textContent || '';
        const h = (el.dataset && el.dataset.rowHash) || '';
        const s = (t + ' ' + r + ' ' + h).toLowerCase();
        el.dataset.search = s;
        return s;
    },

    /** Build one tool-call span element (extracted so the render loop can also
     *  group generations around it). */
    _toolSpanEl(s) {
        const o = OUTCOME[s.outcome] || OUTCOME.allow;
        const external = ObsTabs.isExternalTool(s.tool_id);
        const span = document.createElement('div');
        span.className = 'ar-span';
        if (s._seq != null) span.dataset.seq = s._seq; // minimap jump target
        if (s.row_hash) span.dataset.rowHash = String(s.row_hash);
        const dot = `<span class="ar-span-dot" style="background:${o.color}"></span>`;
        const caret = `<svg class="ar-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`;
        const badge = `<span class="ar-badge" style="background:${o.color}22;color:${o.color}">` +
            `${s.outcome === 'blocked' ? BAN_SVG(o.color, 10) : ''}${o.label}</span>`;
        const kind = `<span class="ar-kind ${external ? 'ext' : ''}">${external ? 'External MCP' : 'Built-in'}</span>`;
        const reason = s.reason
            ? `<span class="ar-reason-inline ${s.outcome === 'blocked' ? 'blk' : ''}">${this._esc(s.reason)}</span>`
            : '';
        span.innerHTML = dot +
            `<div class="ar-span-row">${caret}<span class="ar-turn">#${s.turn_index ?? '–'}</span>` +
            `<span class="ar-span-tool">${this._esc(s.function_name || s.tool_id || 'tool')}</span>` +
            kind + badge + reason +
            `<span class="ar-time">${this._fmtTime(s.called_at)}</span>` +
            this._timingHtml(s, o.color) + `</div>` +
            this._detectionRow(s) +
            this._spanDetail(s, external);
        const row = span.querySelector('.ar-span-row');
        row.addEventListener('click', () => {
            span.classList.toggle('open');
            if (span.classList.contains('open')) this._loadScan(span);
        });
        const hashCopy = span.querySelector('.ar-span-hash .ar-copy');
        if (hashCopy) this._wireCopy(hashCopy);
        const detEl = span.querySelector('.ar-span-detection');
        if (detEl && detEl.dataset.rid) {
            detEl.classList.add('ar-det-clickable');
            detEl.addEventListener('click', (e) => {
                e.stopPropagation();
                this._openDetection(detEl.dataset.kind, detEl.dataset.rid);
            });
        }
        return span;
    },

    /** A collapsed run of consecutive LLM turns: one summary row ("N LLM turns
     *  · Σin→Σout tok · $Σ") that expands in place to the individual
     *  generation spans. Keeps tool calls the visual lead on long traces. */
    _genGroup(group, ridxOf, startI) {
        const wrap = document.createElement('div');
        wrap.className = 'ar-gen-group';
        const inTok = group.reduce((a, g) => a + (g.input_tokens || 0), 0);
        const outTok = group.reduce((a, g) => a + (g.output_tokens || 0), 0);
        const cost = group.reduce((a, g) => a + (g.cost || 0), 0);
        const models = [...new Set(group.map(g => g.model).filter(Boolean))];
        const modelLabel = models.length === 1 ? models[0] : `${models.length} models`;
        const costLabel = cost > 0 ? ` · $${cost.toFixed(cost < 0.01 ? 4 : 2)}` : '';
        const head = document.createElement('button');
        head.type = 'button';
        head.className = 'ar-gen-group-head';
        head.innerHTML =
            `<span class="ar-gen-group-dot">${AR_ROBOT_SVG('#5eadb8', 13)}</span>` +
            `<svg class="ar-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>` +
            `<span class="ar-gen-group-n">${group.length} LLM runs</span>` +
            `<span class="ar-gen-group-meta">${this._esc(modelLabel)} · ${this._fmtTok(inTok)}→${this._fmtTok(outTok)} tok${costLabel}</span>`;
        const body = document.createElement('div');
        body.className = 'ar-gen-group-body';
        body.hidden = true;
        head.addEventListener('click', () => {
            const opening = body.hidden;
            body.hidden = !opening;
            wrap.classList.toggle('open', opening);
            if (opening && !body.dataset.built) {
                body.dataset.built = '1';
                group.forEach((g, k) => {
                    const el = this._genSpan(g);
                    el.dataset.ridx = ridxOf(startI + k);
                    body.appendChild(el);
                });
                // The rows inside this group only just entered the DOM, so
                // the Optimizer's per-turn chips must be re-applied now —
                // the render-time pass couldn't have found them.
                if (this._trace) this._annotateOptimizer(this._trace);
            }
        });
        wrap.appendChild(head);
        wrap.appendChild(body);
        return wrap;
    },

    // ---------------- session replay (§3.1) ----------------

    /** The replay control bar above the waterfall: a Replay toggle, and when
     *  active the transport (reset / step-back / play-pause / step-forward),
     *  a speed selector, a scrubber, and the position/clock readout. */
    _replayBar(count) {
        const bar = document.createElement('div');
        bar.className = 'ar-replay' + (this._replay.on ? ' on' : '');
        if (!this._replay.on) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ar-replay-enter';
            btn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>` +
                `<span>Replay session</span>`;
            btn.title = 'Step or play through this session in order';
            btn.disabled = !count;
            btn.addEventListener('click', () => this._replayEnter());
            bar.appendChild(btn);
            return bar;
        }
        const R = this._replay;
        const tbtn = (cls, svg, title, fn, disabled) => {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'ar-rp-btn ' + cls; b.title = title;
            b.innerHTML = svg; b.disabled = !!disabled;
            b.addEventListener('click', fn);
            return b;
        };
        // transport
        bar.appendChild(tbtn('reset', '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>', 'Reset to start', () => this._replaySeek(0)));
        bar.appendChild(tbtn('step', '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M14 6 8.5 12 14 18zM16 6h2v12h-2z"/></svg>', 'Step back', () => this._replaySeek(R.idx - 1), R.idx <= 0));
        const play = tbtn('play',
            R.playing
                ? '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>'
                : '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
            R.playing ? 'Pause' : 'Play', () => this._replayPlayPause());
        bar.appendChild(play);
        bar.appendChild(tbtn('step', '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M10 6 15.5 12 10 18zM6 6h2v12H6z"/></svg>', 'Step forward', () => this._replaySeek(R.idx + 1), R.idx >= count));

        // scrubber
        const scrub = document.createElement('input');
        scrub.type = 'range'; scrub.className = 'ar-rp-scrub';
        scrub.min = '0'; scrub.max = String(count); scrub.value = String(R.idx);
        scrub.setAttribute('aria-label', 'Replay position');
        scrub.addEventListener('input', () => this._replaySeek(parseInt(scrub.value, 10), true));
        bar.appendChild(scrub);

        // position + clock readout
        const read = document.createElement('div');
        read.className = 'ar-rp-read';
        read.innerHTML = `<span class="ar-rp-pos">${R.idx}/${count}</span><span class="ar-rp-clock" id="ar-rp-clock">${this._replayClock()}</span>`;
        bar.appendChild(read);

        // speed
        const speeds = [1, 2, 4];
        const sp = document.createElement('div'); sp.className = 'ar-rp-speed';
        speeds.forEach(x => {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'ar-rp-sp' + (R.speed === x ? ' on' : '');
            b.textContent = x + '×';
            b.addEventListener('click', () => { R.speed = x; if (R.playing) this._replayPlay(); this.renderWaterfall(this._trace); });
            sp.appendChild(b);
        });
        bar.appendChild(sp);

        // exit
        bar.appendChild(tbtn('exit', '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>', 'Exit replay', () => this._replayExit()));
        return bar;
    },

    _replayEnter() {
        this._replay.on = true;
        this._replay.idx = 0;
        this._replay.playing = false;
        this.renderWaterfall(this._trace);
    },
    _replayExit() {
        this._replayStop();
        this.renderWaterfall(this._trace);
    },
    _replayPlayPause() {
        if (this._replay.playing) { this._replayPause(); } else { this._replayStartOrPlay(); }
    },
    _replayStartOrPlay() {
        // From the end, Play restarts from the top.
        if (this._replay.idx >= this._replay.count) this._replay.idx = 0;
        this._replay.playing = true;
        this._replayPlay();
        this._refreshReplayBar();
    },
    _replayPlay() {
        if (this._replay.timer) clearInterval(this._replay.timer);
        const base = 700; // ms per event at 1×
        this._replay.timer = setInterval(() => {
            if (this._replay.idx >= this._replay.count) { this._replayPause(); return; }
            this._replay.idx += 1;
            this._applyReplay();
            this._refreshReplayBar();
        }, base / this._replay.speed);
    },
    _replayPause() {
        this._replay.playing = false;
        if (this._replay.timer) { clearInterval(this._replay.timer); this._replay.timer = null; }
        this._refreshReplayBar();
    },
    /** Seek to a position; `fromScrub` avoids a redundant scrubber write. */
    _replaySeek(idx, fromScrub) {
        this._replay.idx = Math.max(0, Math.min(idx, this._replay.count));
        if (this._replay.playing) this._replayPause();
        this._applyReplay(!fromScrub);   // scrub drag shouldn't yank the scroll
        this._refreshReplayBar(fromScrub);
    },
    /** Toggle span visibility to the playhead + spotlight the current event. */
    _applyReplay(scroll = true) {
        const detail = document.getElementById('ar-detail');
        if (!detail) return;
        const cur = this._replay.idx - 1;   // playhead = last revealed event
        let curEl = null;
        detail.querySelectorAll('.ar-span[data-ridx]').forEach(el => {
            const r = parseInt(el.dataset.ridx, 10);
            el.classList.toggle('ar-replay-hidden', r > cur);
            const isCur = (r === cur);
            el.classList.toggle('ar-replay-current', isCur);
            if (isCur) curEl = el;
        });
        if (curEl && scroll) curEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    /** Update the replay bar in place (transport icon, disabled states,
     *  scrubber, clock) without re-rendering the waterfall — keeps play smooth
     *  on big traces and doesn't fight an in-progress scrubber drag. */
    _refreshReplayBar(fromScrub) {
        const detail = document.getElementById('ar-detail');
        if (!detail) return;
        const bar = detail.querySelector('.ar-replay');
        if (!bar) return;
        const R = this._replay;
        const play = bar.querySelector('.ar-rp-btn.play');
        if (play) play.innerHTML = R.playing
            ? '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>'
            : '<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
        const btns = bar.querySelectorAll('.ar-rp-btn.step');
        if (btns[0]) btns[0].disabled = R.idx <= 0;         // step back
        if (btns[1]) btns[1].disabled = R.idx >= R.count;   // step forward
        const scrub = bar.querySelector('.ar-rp-scrub');
        if (scrub && !fromScrub) scrub.value = String(R.idx);
        const pos = bar.querySelector('.ar-rp-pos');
        if (pos) pos.textContent = `${R.idx}/${R.count}`;
        const clock = bar.querySelector('.ar-rp-clock');
        if (clock) clock.textContent = this._replayClock();
    },
    /** The wall-clock label of the current event + elapsed-since-start. */
    _replayClock() {
        const cur = this._replay.idx - 1;
        if (cur < 0) return 'start';
        const el = document.querySelector(`.ar-span[data-ridx="${cur}"] .ar-time`);
        return el ? el.textContent : '';
    },

    /** A Generation (LLM turn) span — reconstructed from the session
     *  transcript (§2 agent-observability). Unlike tool spans it carries no
     *  enforcement verdict; it shows model · token flow · cost, with the
     *  redacted input/output preview revealed on expand. Neutral/teal accent
     *  (a generation is not a security state — SOC colour discipline). */
    _fmtMs(ms) {
        const n = Number(ms);
        if (!(n >= 0)) return '';
        if (n < 1000) return `${Math.round(n)} ms`;
        return `${(n / 1000).toFixed(n < 10000 ? 2 : 1)} s`;
    },

    _genSpan(s, stepN) {
        const span = document.createElement('div');
        span.className = 'ar-span ar-span-gen';
        if (s._seq != null) span.dataset.seq = s._seq; // minimap jump target
        const inTok = this._fmtTok(s.input_tokens);
        const outTok = this._fmtTok(s.output_tokens);
        const cost = (s.cost != null) ? ('$' + Number(s.cost).toFixed(s.cost < 0.01 ? 4 : 2)) : '—';
        const caret = `<svg class="ar-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`;
        // A "tool_use" stop means the model ended its turn to call a tool —
        // show WHICH tool(s) it asked for ("→ Bash") instead of a bare
        // "tool use", so the LLM run points at the tool runs it triggered.
        const tools = Array.isArray(s.tools_called) ? s.tools_called : [];
        let stop;
        if (s.stop_reason === 'tool_use' && tools.length) {
            const shown = tools.slice(0, 3).map(t => this._esc(this._prettyTool(t))).join(', ');
            const more = tools.length > 3 ? ` +${tools.length - 3}` : '';
            stop = `<span class="ar-gen-stop ar-gen-tooluse" title="Tools this run asked to call: ${this._esc(tools.map(t => this._prettyTool(t)).join(', '))}">` +
                `<span class="ar-gen-toolarrow">&#8594;</span> ${shown}${more}</span>`;
        } else {
            stop = s.stop_reason
                ? `<span class="ar-gen-stop">${this._esc(String(s.stop_reason).replace(/_/g, ' '))}</span>` : '';
        }
        const dotHtml = (stepN != null)
            ? `<span class="ar-span-dot ar-gen-dot ar-step-dot" title="Step ${stepN} — chronological order within this trace">${stepN}</span>`
            : `<span class="ar-span-dot ar-gen-dot">${AR_ROBOT_SVG('#5eadb8', 12)}</span>`;
        span.innerHTML =
            dotHtml +
            `<div class="ar-span-row">${caret}<span class="ar-turn">#${s.turn_index ?? '–'}</span>` +
            `<span class="ar-span-tool ar-gen-model">${this._esc(s.model || 'model')}</span>` +
            `<span class="ar-kind ar-gen-kind">LLM</span>` +
            `<span class="ar-gen-flow"><span class="ar-gen-tok">${inTok}</span>` +
            `<span class="ar-gen-arrow">→</span><span class="ar-gen-tok">${outTok}</span>` +
            `<span class="ar-gen-toklabel">tok</span></span>` +
            `<span class="ar-gen-cost" title="Estimated: token counts × API list price. Not metered billing: on a subscription plan this usage is included.">${cost}</span>${stop}` +
            (s.verdict && s.verdict.label ? `<span class="ar-gen-verdict ${s.verdict.color || 'grey'}" title="${this._esc(s.verdict.reason || 'scanned: nothing found')}">${this._esc(s.verdict.label)}</span>` : '') +
            (s.duration_ms != null ? `<span class="ar-gen-dur" title="${s.duration_estimated ? 'Model call duration, estimated from the transcript' : 'Model call duration'}">${this._fmtMs(s.duration_ms)}</span>` : '') +
            (this._trace && this._trace.expensive_turn && this._trace.expensive_turn.turn_index === s.turn_index && (this._trace.generation_count || 0) > 1
                ? `<span class="ar-gen-top" title="The costliest model turn in this run">costliest</span>` : '') +
            `<span class="ar-time">${this._fmtTime(s.called_at)}</span>` +
            this._timingHtml(s, '#5eadb8') + `</div>` +
            this._genDetail(s);
        span.querySelector('.ar-span-row').addEventListener('click', () => span.classList.toggle('open'));
        return span;
    },

    /** Expandable body for a generation: the redacted prompt (input) and model
     *  response (output) previews, plus the token/model metadata. Honest about
     *  the privacy contract — 8 KB cap, secret-redacted, and the
     *  "not stored" state when the user's Store-text-content setting is off. */
    _genDetail(s) {
        // Chat-style I/O (the LangSmith/Langfuse/Braintrust convention): the
        // turn reads as a conversation — prompt bubble in, model bubble out,
        // tool results as return bubbles — instead of two labelled <pre>
        // blocks. Same redacted previews, same honesty notes, new shape.
        const OFF_NOTE = 'Text preview off: enable “Store text content” in Settings to capture a redacted excerpt. Tokens and cost are always recorded.';
        const bubble = (cls, roleHtml, title, preview, truncated, emptyTxt) => {
            let body;
            if (preview == null) body = `<div class="ar-gen-note">${OFF_NOTE}</div>`;
            else if (!preview) body = `<div class="ar-gen-note">${emptyTxt}</div>`;
            else body = `<pre class="ar-gen-pre">${this._esc(preview)}${truncated ? '<span class="ar-gen-ellipsis">…</span>' : ''}</pre>`;
            return `<div class="ar-msg ${cls}"><div class="ar-msg-role" title="${title}">${roleHtml}</div>${body}</div>`;
        };
        const kv = (k, v) => v ? `<dt>${k}</dt><dd>${this._esc(v)}</dd>` : '';
        const cache = (s.cache_read_tokens || s.cache_creation_tokens)
            ? `${this._fmtTok(s.cache_read_tokens)} read · ${this._fmtTok(s.cache_creation_tokens)} created` : '';
        const promptRole = s.input_is_tool_result ? 'Tool result &#8594; prompt' : 'Prompt';
        // Tool results (Pillar 3) — what the tools this run called returned,
        // matched by tool_use_id in the transcript. Redacted + capped like every
        // other preview; honest "not stored" / "(empty)" states.
        const results = Array.isArray(s.tool_results) ? s.tool_results : [];
        const resultsHtml = results.map(r => {
            const nm = this._esc(this._prettyTool(r.name || 'tool'));
            const err = r.is_error ? '<span class="ar-tr-err">error</span>' : '';
            let body;
            if (r.preview == null) body = `<div class="ar-gen-note">Not stored: enable “Store text content” in Settings to capture a redacted excerpt.</div>`;
            else if (!r.preview) body = `<div class="ar-gen-note">(empty result)</div>`;
            else body = `<pre class="ar-gen-pre">${this._esc(r.preview)}${r.truncated ? '<span class="ar-gen-ellipsis">…</span>' : ''}</pre>`;
            return `<div class="ar-msg tool"><div class="ar-msg-role" title="Result this tool returned to the model">` +
                `<span class="ar-tr-arrow">&#8592;</span>${nm}${err}</div>${body}</div>`;
        }).join('');
        return `<div class="ar-detail-body">` +
            `<div class="ar-chat">` +
            bubble('prompt', promptRole, 'LLM input: prompt (redacted preview)',
                s.input_preview, s.input_truncated,
                s.input_is_tool_result ? 'Turn driven by a tool result (no prompt text).' : 'No text in this turn (tool call / reasoning only).') +
            bubble('model', `${AR_ROBOT_SVG('#5eadb8', 11)} ${this._esc(this._prettyModel(s.model))}`,
                'LLM output: response (redacted preview)',
                s.output_preview, s.output_truncated, 'No text in this turn (tool call / reasoning only).') +
            resultsHtml +
            `</div>` +
            `<dl class="ar-kv">` +
            kv('Model', s.model) +
            kv('Input tokens', (s.input_tokens || 0).toLocaleString()) +
            kv('Output tokens', (s.output_tokens || 0).toLocaleString()) +
            kv('Cache tokens', cache) +
            kv('Estimated cost', s.cost != null ? ('$' + Number(s.cost).toFixed(6)) : 'model not in price table') +
            kv('Stop reason', s.stop_reason) +
            kv('Tools requested', (Array.isArray(s.tools_called) && s.tools_called.length)
                ? s.tools_called.map(t => this._prettyTool(t)).join(', ') : '') +
            kv('Time', this._fmtTime(s.called_at)) +
            `</dl>` +
            `<div class="ar-gen-privacy">Secrets redacted. Prompts and responses are kept up to 8 KB each and stay on this device.</div>` +
            `</div>`;
    },

    /** Model chip text for the chat bubble role; a bare "Model" when the
     *  transcript row carried no model name. */
    _prettyModel(m) {
        return m ? String(m) : 'Model';
    },

    /** Shorten a raw tool name for display: an MCP tool `mcp__server__tool`
     *  becomes its bare `tool`; a built-in (Bash, Read) is left as-is. */
    _prettyTool(n) {
        if (typeof n !== 'string') return String(n ?? '');
        if (n.startsWith('mcp__')) { const p = n.split('__').filter(Boolean); return p[p.length - 1] || n; }
        return n;
    },

    /** Compact token formatter: 16571 → "16.6k". */
    _fmtTok(n) {
        n = Number(n) || 0;
        if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
        return String(n);
    },

    /** Detection sub-row nested under a tool-call span — a SEPARATE activity
     *  from the call itself. Virus = threat, lock = secret leak. Secret is
     *  inferred from the matched rule names (mirrors the backend heuristic).
     *  Empty string when the step produced no correlated detection. */
    _detectionRow(s) {
        if (!s.detection_source) return '';
        const rules = s.detection_rules || [];
        const isSecret = rules.some(r => /credential|secret|leak|sensitive info|exfil|\bpii\b/i.test(String(r)));
        const icon = isSecret ? AR_LOCK_SVG('#f59e0b', 12) : AR_VIRUS_SVG('#ef4444', 12);
        // "Secret touched", not "Secret leak" — an allowed call that handled a
        // credential hasn't necessarily exfiltrated it; "leak" overclaims.
        const what = isSecret ? 'Secret touched' : 'Threat detected';
        const cls = isSecret ? 'secret' : 'threat';
        const badge = DetectionLabel.htmlFromFields(s.detection_source, s.ml_score, s.detection_rules);
        // The single most important clarity fix from the CISO/indie/SOC review:
        // a detection on an ALLOWED call must not read as "blocked". Say plainly
        // whether the agent's call was stopped or ran anyway.
        const blocked = s.outcome === 'blocked';
        const outcome = blocked
            ? '<span class="ar-det-outcome blocked">blocked: stopped</span>'
            : '<span class="ar-det-outcome allowed">allowed: ran anyway</span>';
        const ruleTxt = rules.length
            ? `<span class="ar-det-rules">${this._esc(rules.slice(0, 3).join(', '))}</span>`
            : '';
        // Mechanism 1 FP-triage pill — let SOC deprioritise rule hits the model
        // rated benign (likely FP) or wasn't sure about, right on the row.
        const fp = s.ml_agreement === 'ml_disagrees'
            ? '<span class="ar-det-fp">likely FP · ML disagrees</span>'
            : s.ml_agreement === 'ml_uncertain'
                ? '<span class="ar-det-fp uncertain">ML uncertain</span>'
                : '';
        // Deep-link affordance — click the detection to see WHAT was detected on
        // its own page (Threat Monitor for threats, Secret Detections for secrets).
        const rid = s.request_id || '';
        const kind = isSecret ? 'secret' : 'threat';
        const view = rid ? '<span class="ar-det-view">view details →</span>' : '';
        return `<div class="ar-span-detection det-${cls}" data-rid="${this._esc(rid)}" data-kind="${kind}">${icon}` +
            `<span class="ar-det-what">${what}</span>${outcome}${badge}${fp}${ruleTxt}${view}</div>`;
    },

    /** Deep-link from a Runs detection to the record that explains WHAT was
     *  detected. Every detection (threat OR secret-flavored) is a
     *  threat_intel_record, so Threat Monitor — filtered to this request_id —
     *  always has it, with the redacted content + matched rules + ML assessment
     *  in the detail drawer. (Secret Detections is the redaction-audit log, a
     *  separate table that doesn't carry every credential-rule hit, so it isn't
     *  a reliable deep-link target here.) */
    _openDetection(kind, rid) {
        if (!rid) return;
        if (window.ThreatsPage) ThreatsPage.pendingRequestId = rid;
        if (window.Sidebar) Sidebar.navigate('threats');
    },

    /** The collapsible per-step detail panel revealed when a span is clicked. */
    _spanDetail(s, external) {
        const kv = (k, v) => v ? `<dt>${k}</dt><dd>${this._esc(v)}</dd>` : '';
        // Arguments are secret-redacted and capped at 8 KB on write. At the cap,
        // say so: a command that stops mid-word otherwise reads as a bug in the
        // trace rather than a limit on what was stored. Same note Storylines
        // shows for the same data.
        const argCap = (s.args_preview || '').length >= 8192
            ? '<div class="ar-args-note">Showing the first 8 KB, secrets redacted. The rest of this command was not stored.</div>'
            : '';
        const args = s.args_preview
            ? `<div class="ar-args"><div class="ar-args-label">Arguments (secrets redacted)</div><pre>${this._esc(s.args_preview)}</pre>${argCap}</div>`
            : '';
        // Detected-by row: raw HTML (badge), not escaped text — only when the
        // step is tied to a threat detection.
        const det = s.detection_source
            ? `<dt>Detected by</dt><dd>${DetectionLabel.htmlFromFields(s.detection_source, s.ml_score, s.detection_rules)}</dd>`
            : '';
        // Scanned-content panel: what SecureVector actually inspected for this
        // call (the LLM input/output excerpt), lazy-loaded on expand from the
        // threat-intel record correlated by request_id. Only rendered when the
        // step has a correlation id — steps the Guard didn't scan have none.
        const scan = s.request_id
            ? `<div class="ar-scan" data-rid="${this._esc(s.request_id)}">` +
              `<div class="ar-args-label">Scanned content: LLM input/output excerpt</div>` +
              `<div class="ar-scan-body ar-scan-note">Loading…</div></div>`
            : '';
        return `<div class="ar-detail-body">` +
            `<dl class="ar-kv">` +
            kv('Tool', s.tool_id) +
            kv('Function', s.function_name) +
            kv('Kind', external ? 'External MCP / plugin' : 'Built-in harness tool') +
            kv('Tool permission', s.verdict || (s.outcome || '').toUpperCase()) +
            kv('Risk', s.risk) +
            det +
            kv('Time', this._fmtTime(s.called_at)) +
            kv('Reason', s.reason) +
            `</dl>${this._spanHashLine(s)}${args}${scan}</div>`;
    },

    /** One quiet line with the span id the cloud shows for this call (the
     *  audit row hash), shortened, with a copy button for the full value. */
    _spanHashLine(s) {
        if (!s || !s.row_hash) return '';
        const full = String(s.row_hash);
        return `<div class="ar-span-hash ar-det-dim">span <code title="${this._esc(full)}">${this._esc(full.slice(0, 12))}…</code>` +
            `<button type="button" class="ar-copy" data-copy="${this._esc(full)}" title="Copy span id">copy</button></div>`;
    },

    /** Copy button: copies data-copy, shows "copied" briefly, and does not
     *  toggle the row it sits in. */
    _wireCopy(btn) {
        btn.addEventListener('click', (e) => {
            if (e && e.stopPropagation) e.stopPropagation();
            const txt = btn.dataset.copy, done = () => { btn.textContent = 'copied'; setTimeout(() => { btn.textContent = 'copy'; }, 1200); };
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done).catch(() => {});
            else { const ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (err) { /* copy unavailable */ } document.body.removeChild(ta); }
        });
    },

    /** Lazy-fetch the scanned LLM I/O excerpt for an expanded step. The app is
     *  privacy-first: it never records full prompt/response bodies — what
     *  exists is the excerpt the Guard scanned, stored on the correlated
     *  threat-intel record (and only when "Store text content" is enabled).
     *  Rendered inertly via textContent — scanned content is attacker-supplied. */
    async _loadScan(span) {
        const box = span.querySelector('.ar-scan');
        if (!box || box.dataset.loaded) return;
        box.dataset.loaded = '1';
        const body = box.querySelector('.ar-scan-body');
        let items = [];
        try {
            const res = await API.getThreats({ request_id: box.dataset.rid, page_size: 5 });
            items = (res && res.items) || [];
        } catch (_) { /* fall through to the empty note */ }
        if (!items.length) {
            body.textContent = 'No scanned excerpt stored for this call. SecureVector keeps only what it ' +
                'scanned (never full prompt/response bodies) and only when "Store text content" is on in Settings.';
            return;
        }
        body.className = 'ar-scan-body';
        body.textContent = '';
        items.forEach(rec => {
            const item = document.createElement('div');
            item.className = 'ar-scan-item';
            const meta = document.createElement('div');
            meta.className = 'ar-scan-meta';
            meta.textContent = [
                rec.action_taken ? `action: ${rec.action_taken}` : '',
                rec.is_threat && rec.threat_type ? `threat: ${rec.threat_type}` : '',
                Number.isFinite(rec.risk_score) ? `risk ${rec.risk_score}` : '',
                rec.text_length ? `${rec.text_length} chars scanned` : '',
            ].filter(Boolean).join(' · ');
            const pre = document.createElement('pre');
            pre.textContent = rec.text_content || rec.text_preview || '(content not stored)';
            item.appendChild(meta);
            item.appendChild(pre);
            body.appendChild(item);
        });
    },

    /** `into`: the node to fill; the whole #ar-detail by default. A filter
     *  with no matches passes #ar-timeline so the step list stays. */
    _detailEmpty(title, sub, into) {
        const detail = into || document.getElementById('ar-detail');
        if (!detail) return;
        // Inline under its row — the row click (or the ×) collapses it.
        detail.innerHTML = `<div class="ar-empty"><div style="font-size:15px;margin-bottom:6px;">${title}</div><div style="font-size:13px;">${sub}</div></div>`;
    },

    _fmtTime(iso) {
        if (!iso) return '';
        const t = String(iso).replace(' ', 'T') + (String(iso).endsWith('Z') ? '' : 'Z');
        const d = new Date(t);
        if (isNaN(d)) return String(iso);
        return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    },

    _relativeTime(iso) {
        const elapsed = Math.max(0, Date.now() - this._ms(iso));
        if (!iso || !Number.isFinite(elapsed)) return '';
        if (elapsed < 60000) return 'now';
        if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)}m ago`;
        if (elapsed < 86400000) return `${Math.floor(elapsed / 3600000)}h ago`;
        return `${Math.floor(elapsed / 86400000)}d ago`;
    },

    /** "+2.3s" — wall clock between this run's start and the previous run's
     *  start. Start-to-start gap, NOT per-run latency (we don't have that). */
    _fmtGap(ms) {
        if (ms < 1000) return '+' + Math.round(ms) + 'ms';
        if (ms < 10000) return '+' + (ms / 1000).toFixed(1) + 's';
        if (ms < 60000) return '+' + Math.round(ms / 1000) + 's';
        if (ms < 3600000) return '+' + Math.floor(ms / 60000) + 'm' + (Math.round((ms % 60000) / 1000) ? ' ' + Math.round((ms % 60000) / 1000) + 's' : '');
        return '+' + Math.floor(ms / 3600000) + 'h ' + Math.floor((ms % 3600000) / 60000) + 'm';
    },

    /** Shared right-edge timing cluster for a run row: the start-to-start gap
     *  chip ("+2.3s", or START on the trace's first event) and the position
     *  mini-timeline (tick = when this run started within the trace window). */
    _timingHtml(s, tickColor) {
        const gap = (s._gap == null)
            ? `<span class="ar-delta first" title="First event of this trace">start</span>`
            : `<span class="ar-delta" title="Started ${this._fmtGap(s._gap).slice(1)} after the previous run (start-to-start: not this run’s latency)">${this._fmtGap(s._gap)}</span>`;
        // Gap bar — the Phoenix inline-duration pattern, on the metric we
        // honestly have: log-scaled against the trace's largest gap, so the
        // slow steps pop out of a column of near-identical "+2s" chips.
        // Neutral fill: gap length is a performance signal, not a security one.
        let bar = '';
        if (s._gap != null && this._maxGap > 0) {
            const f = Math.max(0.05, Math.log1p(s._gap) / Math.log1p(this._maxGap));
            bar = `<span class="ar-gapbar" title="Relative wait before this run (log scale vs the trace's longest gap)">` +
                `<i style="width:${(f * 100).toFixed(0)}%"></i></span>`;
        } else if (s._gap == null) {
            bar = `<span class="ar-gapbar first"></span>`;
        }
        // Per-row timeline: a model turn with a measured duration draws a
        // real bar (start position, width = duration over the trace window);
        // a tool call, whose latency is not recorded, keeps the start tick.
        const p = Math.max(4, Math.min(96, (s._pos || 0) * 100)); // keep the tick fully visible at the rails
        let pos = '';
        if (typeof s._pos === 'number') {
            const win = this._traceWin || 0;
            const durF = (s.duration_ms > 0 && win > 0) ? Math.min(1, s.duration_ms / win) : 0;
            if (durF > 0) {
                let left = Math.max(0, Math.min(100, (s._pos || 0) * 100));
                let width = Math.max(2.5, Math.min(100 - left, durF * 100));
                // A transcript turn is stamped when its reply was written and
                // its duration estimated back from there, so the bar ends at
                // called_at: it runs from called_at - duration_ms.
                if (s.duration_estimated) {
                    const end = left;
                    left = Math.max(0, end - durF * 100);
                    width = Math.max(2.5, end - left);
                    if (left + width > 100) left = Math.max(0, 100 - width);
                }
                pos = `<span class="ar-tl" title="${s.duration_estimated ? `Ended ${Math.round(s._pos * 100)}% through the trace, ran about ${this._fmtMs(s.duration_ms)} (estimated)` : `Started ${Math.round(s._pos * 100)}% through the trace, ran ${this._fmtMs(s.duration_ms)}`}">` +
                    `<i class="ar-tl-bar" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%;background:${tickColor}"></i></span>`;
            } else {
                pos = `<span class="ar-tl" title="When this run started within the trace (${Math.round(s._pos * 100)}% through)">` +
                    `<i style="left:calc(${p.toFixed(1)}% - 3px);background:${tickColor}"></i></span>`;
            }
        }
        return gap + bar + pos;
    },

    /** Wall-clock duration between two timestamps → "42s" / "3m 20s" / "1h 5m".
     *  This is honest trace-level elapsed time (first run → last run) — NOT
     *  per-run latency, which we don't reliably have. */
    _fmtDuration(a, b) {
        const p = (x) => x ? new Date(String(x).replace(' ', 'T') + (String(x).endsWith('Z') ? '' : 'Z')) : null;
        const pa = p(a), pb = p(b);
        if (!pa || !pb || isNaN(pa) || isNaN(pb)) return '';
        let s = Math.max(0, Math.round((pb - pa) / 1000));
        if (s < 60) return s + 's';
        let m = Math.floor(s / 60); s = s % 60;
        if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
        const h = Math.floor(m / 60); m = m % 60;
        return m ? `${h}h ${m}m` : `${h}h`;
    },

    _esc(s) {
        return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    },
    /** Stop live-follow polling and replay playback on navigate-away.
     *
     * Called by App._destroyPage(). Traces owns two timers: the 15s live
     * tick and the replay transport. Both used to survive navigation, so
     * leaving the page left it polling and, if a replay was mid-flight,
     * still stepping through spans in the background. */
    destroy() {
        if (this._agoTimer) { clearInterval(this._agoTimer); this._agoTimer = null; }
        if (this._searchTimer) { clearTimeout(this._searchTimer); this._searchTimer = null; }
        if (this._live && this._live.timer) {
            clearInterval(this._live.timer);
            this._live.timer = null;
        }
        if (this._replay && this._replay.timer) {
            clearInterval(this._replay.timer);
            this._replay.timer = null;
        }
        if (this._splitMq && this._splitApply) {
            if (this._splitMq.removeEventListener) this._splitMq.removeEventListener('change', this._splitApply);
            else if (this._splitMq.removeListener) this._splitMq.removeListener(this._splitApply);
        }
        if (this._fitHandler) window.removeEventListener('resize', this._fitHandler);
        if (this._fitRo) { this._fitRo.disconnect(); this._fitRo = null; }
        this._splitMq = this._splitApply = this._fitHandler = null;
    },
};

window.AgentRunsPage = AgentRunsPage;
