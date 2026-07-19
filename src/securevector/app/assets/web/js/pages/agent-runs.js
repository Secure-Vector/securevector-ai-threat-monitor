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
    cursor: RUNTIME_NEUTRAL,
    langchain: RUNTIME_NEUTRAL, langgraph: RUNTIME_NEUTRAL, crewai: RUNTIME_NEUTRAL,
    hermes: RUNTIME_NEUTRAL,
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

const AgentRunsPage = {
    windowDays: 7,
    kinds: { builtin: true, external: true }, // checkbox filter for the waterfall steps
    runs: [],
    selected: null,
    runtimeFilter: null,   // active "only this runtime" filter (from a Map agent-node click)
    _pendingRuntime: null, // one-shot runtime filter handed off by the Map; consumed on render
    _pendingKinds: null,   // one-shot built-in/external filter handed off by a Map tool-node click
    _pendingTrace: null,   // one-shot: open THIS exact run (trace_id) from a Map agent-node click
    toolFilter: null,      // filter spans to one tool_id (from a Map tool-node click)
    _pendingTool: null,    // one-shot tool_id handed off by a Map tool-node click
    outcomeFilter: 'all',  // span verdict filter: all | allow | blocked | log_only | threat | secret
    collapseGens: true,    // fold consecutive LLM turns into a summary (persona #1 ask)
    runSearch: '',         // in-trace filter: match runs by tool / model / reason
    // Session replay (§3.1): step/play through the trace's event stream in
    // chronological order. `idx` = how many events are revealed (playhead at
    // idx-1); the unit is the event, so replay respects the 200-char redacted
    // preview budget — we never store or replay full bodies.
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
    _live: { timer: null, pendingDetail: false, lastDetail: 0 },

    _ms(ts) {
        if (!ts) return 0;
        const d = new Date(String(ts).replace(' ', 'T') + (String(ts).endsWith('Z') ? '' : 'Z'));
        return isNaN(d) ? 0 : d.getTime();
    },

    _isLive(ts) { return ts ? (Date.now() - this._ms(ts)) < this._LIVE_MS : false; },

    _liveBadge(title) {
        return `<span class="ar-live" title="${title || 'Activity in the last 2 minutes'}">live</span>`;
    },

    _liveStart() {
        if (this._live.timer) return;
        this._live.timer = setInterval(() => { this._liveTick(); }, this._POLL_MS);
    },

    _liveStop() {
        if (this._live.timer) { clearInterval(this._live.timer); this._live.timer = null; }
        this._live.pendingDetail = false;
    },

    async _liveTick() {
        // Self-teardown: there is no page-destroy hook, so the poller checks
        // every tick that Traces is still mounted and stops itself otherwise.
        if (!document.getElementById('ar-runlist') || (window.App && App.currentPage !== 'agent-runs')) {
            this._liveStop();
            return;
        }
        if (document.hidden) return; // don't poll a background tab
        const data = await API.getTraces({ window_days: this.windowDays });
        const list = document.getElementById('ar-runlist');
        if (!data || !data.runs || !list) return; // unmounted / failed mid-fetch
        // Re-render the card list when the data changed OR a badge expired
        // (a trace goes quiet with no new rows — same data, different state).
        const liveKey = data.runs.filter(r => this._isLive(r.ended_at)).map(r => r.trace_id).join(',');
        const changed = JSON.stringify(this.runs) !== JSON.stringify(data.runs) || liveKey !== (this._liveIds || '');
        if (changed) {
            this.runs = data.runs;
            this._computeAgentNums();
            const keepScroll = list.scrollTop;
            this.renderRuns();
            list.scrollTop = keepScroll;
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
        if (!sel || !t || t.trace_id !== this.selected) return;
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
        const det = document.getElementById('ar-detail');
        return !!(det && (det.querySelector('.ar-span.open')
            || (det.contains(document.activeElement) && document.activeElement !== document.body)));
    },

    async _liveRefreshDetail() {
        const id = this.selected;
        if (!id) return;
        this._live.lastDetail = Date.now();
        const trace = await API.getTrace(id);
        if (!trace || this.selected !== id || !document.getElementById('ar-detail')) return;
        this._trace = trace;
        this._live.pendingDetail = false;
        this.renderWaterfall(trace);
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
        pill.title = 'This trace has new runs — click to load them';
        pill.textContent = 'new activity — refresh';
        pill.onclick = () => { this._live.pendingDetail = false; this._liveRefreshDetail(); };
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
        else if (this._trace) this.renderWaterfall(this._trace);
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
            Header.setPageInfo('Traces', 'One trace per agent session — every LLM and tool run with its verdict, tokens and cost.');
        }
        this._injectStyle();

        const header = document.createElement('div');
        header.className = 'obs-header';
        ObsTabs.render(header, 'runs');
        // "How to read traces" — sits right after the tabs, before the filter
        // cluster (which is pushed right via margin-left:auto on .filters-bar).
        const howto = ObsTabs.howToReadLink('How to read traces', 'section-read-runs', 'gs-read-runs');
        howto.style.alignSelf = 'center';
        header.appendChild(howto);
        const toolbar = document.createElement('div');
        toolbar.className = 'filters-bar';
        toolbar.id = 'agent-runs-toolbar';
        header.appendChild(toolbar);
        container.appendChild(header);
        this._buildToolbar(toolbar);

        const away = document.createElement('div');
        away.id = 'ar-away';
        container.appendChild(away);

        const layout = document.createElement('div');
        layout.className = 'ar-layout';
        layout.innerHTML = '<div class="ar-rail"><div class="ar-rail-head" id="ar-rail-head"></div>' +
            '<div class="ar-runlist" id="ar-runlist"></div></div><div class="ar-detail" id="ar-detail"></div>';
        container.appendChild(layout);

        await this.loadData();
        this._liveStart();
    },

    _injectStyle() {
        if (document.getElementById('agent-runs-style')) return;
        const st = document.createElement('style');
        st.id = 'agent-runs-style';
        st.textContent = `
            @keyframes arFade { from { opacity:0; transform:translateY(-3px); } to { opacity:1; transform:none; } }
            .ar-layout { display:flex; gap:16px; align-items:flex-start; }
            .ar-rail { width:308px; flex:0 0 308px; display:flex; flex-direction:column; gap:8px; }
            .ar-rail-head { display:flex; align-items:baseline; gap:8px; padding:2px 4px 0;
                font:600 11px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.6px; text-transform:uppercase;
                color:var(--text-muted,#7d8590); }
            .ar-rail-head b { font:700 12px ui-monospace,'JetBrains Mono',Menlo,monospace; color:var(--text-primary,#e6edf3);
                font-variant-numeric:tabular-nums; }
            .ar-rail-live { display:inline-flex; align-items:center; gap:5px; color:var(--accent-primary,#5eadb8);
                font-weight:700; letter-spacing:.8px; }
            .ar-rail-live::before { content:''; width:5px; height:5px; border-radius:50%; background:var(--accent-primary,#5eadb8);
                animation:arLivePulse 1.6s ease-in-out infinite; }
            .ar-rail-win { margin-left:auto; letter-spacing:.4px; }
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
            .ar-runlist { max-height:680px; overflow:auto; display:flex; flex-direction:column; gap:9px; padding:2px; }
            .ar-detail { flex:1; min-width:0; border:1px solid var(--border-default,#30363d); border-radius:14px;
                background:linear-gradient(180deg, var(--bg-card,#161b22), color-mix(in srgb, var(--bg-card,#161b22) 88%, #000)); padding:18px 20px; min-height:320px; }
            /* Run cards: runtime-coloured left rail, lift on hover, accent when selected.
               flex:0 0 auto is load-bearing — the runlist is a flex column with max-height,
               so without it many runs flex-shrink every card to ~24px and crush the text. */
            .ar-run { position:relative; flex:0 0 auto; text-align:left; cursor:pointer; border:1px solid var(--border-default,#30363d); border-radius:12px;
                background:var(--bg-card,#161b22); padding:11px 13px 11px 16px; overflow:hidden;
                transition:border-color .14s,background .14s,box-shadow .14s,transform .14s; }
            .ar-run::before { content:''; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--ar-accent,#5eadb8); opacity:.5; transition:opacity .14s,width .14s; }
            .ar-run:hover { border-color:var(--accent-primary,#5eadb8); box-shadow:0 4px 14px rgba(0,0,0,.22); transform:translateY(-1px); }
            .ar-run:hover::before { opacity:.9; }
            .ar-run.sel { border-color:var(--accent-primary,#5eadb8); background:color-mix(in srgb, var(--accent-primary,#5eadb8) 9%, var(--bg-card,#161b22)); }
            .ar-run.sel::before { opacity:1; width:4px; }
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
               the previous run (wall clock between starts — we don't have
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
            @media (max-width:1180px) { .ar-tl { display:none; } .ar-delta { min-width:0; } }
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
        `;
        document.head.appendChild(st);
    },

    _buildToolbar(bar) {
        bar.textContent = '';
        const grp = document.createElement('div');
        grp.className = 'filter-group';
        const lbl = document.createElement('label');
        lbl.textContent = 'Window';
        grp.appendChild(lbl);
        const sel = document.createElement('select');
        sel.className = 'filter-select';
        [['1', '24h'], ['7', '7 days'], ['30', '30 days']].forEach(([v, t]) => {
            const o = document.createElement('option');
            o.value = v; o.textContent = t;
            if (Number(v) === this.windowDays) o.selected = true;
            sel.appendChild(o);
        });
        sel.addEventListener('change', () => { this.windowDays = Number(sel.value); this.loadData(); });
        grp.appendChild(sel);
        bar.appendChild(grp);

        // Harness filter — narrow the run list to one runtime (claude-code /
        // codex / openclaw / …). Options are populated from the loaded runs in
        // _populateHarnessFilter(); stays in sync with a Map drill-down's
        // runtimeFilter.
        const hgrp = document.createElement('div');
        hgrp.className = 'filter-group';
        const hlbl = document.createElement('label');
        hlbl.textContent = 'Harness';
        hgrp.appendChild(hlbl);
        const hsel = document.createElement('select');
        hsel.className = 'filter-select';
        const allOpt = document.createElement('option');
        allOpt.value = ''; allOpt.textContent = 'All harnesses';
        hsel.appendChild(allOpt);
        hsel.addEventListener('change', () => {
            this.runtimeFilter = hsel.value || null;
            this.renderRuns();
            const shown = this._filteredRuns();
            if (shown.length) this.selectRun((shown.find(r => r.trace_id === this.selected) || shown[0]).trace_id);
            else this._detailEmpty(`No ${this.runtimeFilter} runs in this window.`, 'Pick another harness or widen the Window.');
        });
        hgrp.appendChild(hsel);
        bar.appendChild(hgrp);
        this._harnessSel = hsel;

        // Built-in vs external filter — checkboxes so each kind toggles
        // independently (isolate external MCP calls, or hide them entirely).
        const kgrp = document.createElement('div');
        kgrp.className = 'filter-group';
        const klbl = document.createElement('label');
        klbl.textContent = 'Tool';
        kgrp.appendChild(klbl);
        const kwrap = document.createElement('div');
        kwrap.className = 'ar-kind-checks';
        [
            { key: 'builtin', label: 'Built-in', color: '#64748b' },
            { key: 'external', label: 'External MCP', color: 'var(--accent-primary,#5eadb8)' },
        ].forEach(k => {
            const lab = document.createElement('label');
            lab.className = 'ar-check';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!this.kinds[k.key];
            cb.addEventListener('change', () => {
                this.kinds[k.key] = cb.checked;
                if (this._trace) this.renderWaterfall(this._trace);
            });
            const dot = document.createElement('span');
            dot.className = 'ar-check-dot';
            dot.style.background = k.color;
            const txt = document.createElement('span');
            txt.textContent = k.label;
            lab.appendChild(cb); lab.appendChild(dot); lab.appendChild(txt);
            kwrap.appendChild(lab);
        });
        kgrp.appendChild(kwrap);
        bar.appendChild(kgrp);

        // Verdict filter — show only allowed / blocked / log-only / threat /
        // secret-touching spans. Matches the Map's Outcome filter so a tool-node
        // drill that lands here can be narrowed the same way.
        const ogrp = document.createElement('div');
        ogrp.className = 'filter-group';
        const olbl = document.createElement('label');
        olbl.textContent = 'Outcome';
        ogrp.appendChild(olbl);
        const osel = document.createElement('select');
        osel.className = 'filter-select';
        [['all', 'All'], ['allow', 'Allowed'], ['blocked', 'Blocked'], ['log_only', 'Logged only'], ['threat', 'Threats'], ['secret', 'Secret-touching']].forEach(([v, t]) => {
            const o = document.createElement('option');
            o.value = v; o.textContent = t;
            if (v === this.outcomeFilter) o.selected = true;
            osel.appendChild(o);
        });
        osel.addEventListener('change', () => { this.outcomeFilter = osel.value; if (this._trace) this.renderWaterfall(this._trace); });
        ogrp.appendChild(osel);
        bar.appendChild(ogrp);
        this._outcomeSel = osel;

        const exp = ObsTabs.exportMenu([
            { label: 'Audit report (PDF)', onClick: () => this._exportAuditReport() },
            { label: 'This trace (CSV)', onClick: () => this._exportCSV() },
            { label: 'This trace (PDF)', onClick: () => this._exportPDF() },
        ]);
        bar.appendChild(exp);
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
            [{ label: 'runtime', get: r => r.runtime }, { label: 'session_id', get: r => r.session_id }, { label: 'trace_id', get: r => r.trace_id }, { label: 'steps', get: r => r.steps }, { label: 'blocked', get: r => r.blocked }, { label: 'risk', get: r => r.risk }, { label: 'started', get: r => r.started }, { label: 'ended', get: r => r.ended }],
            rows);
        let policyTable = '<p style="color:#666;font-size:12px;">No tool calls were blocked in this window.</p>';
        if (ledger && (ledger.by_reason || []).length) {
            policyTable = ObsTabs.tableHTML([{ label: 'policy / rule that fired', get: r => r.reason }, { label: 'blocks', get: r => r.count }, { label: 'tools', get: r => r.tools }, { label: 'agents', get: r => r.agents }], ledger.by_reason);
        }
        const win = this.windowDays === 1 ? '24 hours' : this.windowDays + ' days';
        const methodology = `<h2>Methodology &amp; data posture</h2><p style="font-size:12px;line-height:1.6;color:#333;">Generated locally from the tamper-evident tool-call audit log and agent transcripts. Tool argument and LLM input/output previews are capped at 200 characters and secret-redacted before storage — SecureVector never stores full prompts, responses, or command bodies.</p>`;
        ObsTabs.printDoc('SecureVector — Agent Activity Audit Report',
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
    /** Export the selected trace's tool-call spans as CSV. */
    _exportCSV() {
        const t = this._trace;
        const rows = this._auditSpans();
        if (!t || !rows.length) return;
        ObsTabs.download(`agent-trace-${String(t.trace_id).slice(0, 8)}.csv`,
            ObsTabs.toCSV(this._exportCols(), rows), 'text/csv');
    },
    /** PDF = printable page with the trace header + the step table. */
    _exportPDF() {
        const t = this._trace;
        const rows = this._auditSpans();
        if (!t || !rows.length) return;
        const gens = t.generation_count || 0;
        const sub = `${t.runtime_kind || 'unknown'} · ${rows.length} tool runs` +
            (gens ? ` · ${gens} LLM runs` : '') + ` · ${t.blocked || 0} blocked · trace ${String(t.trace_id).slice(0, 12)}…`;
        ObsTabs.printDoc('SecureVector — Agent Trace',
            `<h1>Agent Trace</h1><div class="sub">${sub}</div>` +
            ObsTabs.tableHTML(this._exportCols(), rows));
    },

    async loadData() {
        const list = document.getElementById('ar-runlist');
        if (list) list.innerHTML = '<div class="ar-empty">Loading traces…</div>';
        const wantTrace = this._pendingTrace; this._pendingTrace = null;
        const data = await API.getTraces({ window_days: this.windowDays });
        this.runs = (data && data.runs) || [];
        this._computeAgentNums();
        this._populateHarnessFilter();
        this._awayDigest(); // diff BEFORE the snapshot below overwrites it
        this._snapSave();
        this.renderRuns();
        const shown = this._filteredRuns();
        if (wantTrace && this.runs.some(r => r.trace_id === wantTrace)) {
            // A Map agent-node click → open that exact session's run.
            this.selectRun(wantTrace);
        } else if (wantTrace) {
            this._detailEmpty('That trace isn’t in this window.',
                `Session ${this._esc(String(wantTrace).slice(0, 12))}… — widen the Window to load older traces.`);
        } else if (shown.length) {
            // An outcome drill (Blocked Actions → Traces) prefers the first
            // trace that actually contains such runs over a stale selection.
            const flagKey = { blocked: 'blocked', threat: 'detections', secret: 'secrets' }[this._wantFlagged];
            this._wantFlagged = null;
            const flagged = flagKey ? shown.find(r => (r[flagKey] || 0) > 0) : null;
            const keep = flagged || shown.find(r => r.trace_id === this.selected);
            this.selectRun((keep || shown[0]).trace_id);
        } else if (this.runtimeFilter) {
            this._detailEmpty(`No ${this.runtimeFilter} traces in this window.`, 'Clear the filter to see traces from other runtimes.');
        } else {
            this._detailEmpty('No traces in this window.', 'Install a Guard plugin and run an agent — each session becomes a trace here.');
        }
    },

    /** Assign each trace a GLOBAL "agent #N", newest-first — unique across
     *  harnesses. (Per-harness numbering collided on this flat list: three
     *  "agent #1"s, one per harness, told apart only by a small tag.) Mirrors
     *  the Agent Map's global numbering so an "agent #N" clicked there is the
     *  same "agent #N" here. */
    _computeAgentNums() {
        this._agentNum = {};
        (this.runs || []).slice()
            .sort((a, b) => String(b.ended_at || '').localeCompare(String(a.ended_at || '')))
            .forEach((r, i) => { this._agentNum[r.trace_id] = i + 1; });
    },

    /** Display label for a run: custom name (set on the Map) → "agent #N" →
     *  runtime kind. The runtime is still shown as a small sub-tag alongside. */
    _agentLabel(r) {
        if (!r) return 'trace';
        const nm = ObsTabs.agentName(r.trace_id);
        if (nm) return nm;
        const n = this._agentNum ? this._agentNum[r.trace_id] : null;
        return n != null ? ('agent #' + n) : (r.runtime_kind || 'trace');
    },

    /** Fill the Harness dropdown with the distinct runtimes present in the
     *  loaded runs, preserving the current selection (a Map drill-down may have
     *  set runtimeFilter before the options existed). */
    _populateHarnessFilter() {
        const sel = this._harnessSel;
        if (!sel) return;
        const kinds = [...new Set((this.runs || []).map(r => r.runtime_kind).filter(Boolean))].sort();
        sel.innerHTML = '';
        const all = document.createElement('option');
        all.value = ''; all.textContent = 'All harnesses';
        sel.appendChild(all);
        kinds.forEach(k => { const o = document.createElement('option'); o.value = k; o.textContent = k; sel.appendChild(o); });
        sel.value = this.runtimeFilter || '';
    },

    /** Runs after applying the active runtime filter (Map drill-down). */
    _filteredRuns() {
        return this.runtimeFilter
            ? this.runs.filter(r => (r.runtime_kind || '') === this.runtimeFilter)
            : this.runs;
    },

    clearRuntimeFilter() {
        this.runtimeFilter = null;
        this.renderRuns();
        const shown = this._filteredRuns();
        if (shown.length) this.selectRun((shown.find(r => r.trace_id === this.selected) || shown[0]).trace_id);
    },

    renderRuns() {
        const list = document.getElementById('ar-runlist');
        if (!list) return;
        list.textContent = '';
        // Rail header — names the column (this is the list of TRACES) and
        // carries the pulse: how many, how many live right now, the window.
        const rh = document.getElementById('ar-rail-head');
        if (rh) {
            const all = this._filteredRuns();
            const nLive = all.filter(r => this._isLive(r.ended_at)).length;
            rh.innerHTML = `<b>${all.length}</b>&nbsp;trace${all.length === 1 ? '' : 's'}` +
                (nLive ? `<span class="ar-rail-live">${nLive} live</span>` : '') +
                `<span class="ar-rail-win">last ${this.windowDays === 1 ? '24h' : this.windowDays + 'd'}</span>`;
        }
        // Active filter chip — clickable to clear, so the Map drill-down is reversible.
        if (this.runtimeFilter) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'ar-filter-chip';
            chip.title = 'Clear runtime filter';
            chip.innerHTML = `<span class="ar-chip-dot" style="background:${RUNTIME_COLOR[this.runtimeFilter] || '#64748b'}"></span>` +
                `Only <b>${this._esc(this.runtimeFilter)}</b><span class="ar-chip-x">×</span>`;
            chip.addEventListener('click', () => this.clearRuntimeFilter());
            list.appendChild(chip);
        }
        if (this.toolFilter) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'ar-filter-chip';
            chip.title = 'Clear tool filter';
            chip.innerHTML = `Tool <b>${this._esc(String(this.toolFilter).split(':').pop())}</b><span class="ar-chip-x">×</span>`;
            chip.addEventListener('click', () => { this.toolFilter = null; this.renderRuns(); if (this._trace) this.renderWaterfall(this._trace); });
            list.appendChild(chip);
        }
        const shown = this._filteredRuns();
        if (!shown.length) {
            const msg = document.createElement('div');
            msg.className = 'ar-empty';
            msg.textContent = this.runtimeFilter ? `No ${this.runtimeFilter} runs.` : 'No runs.';
            list.appendChild(msg);
            return;
        }
        const prevCounts = this._prevCounts || {};
        const nextCounts = {};
        shown.forEach(r => {
            const card = document.createElement('button');
            card.className = 'ar-run' + (r.trace_id === this.selected ? ' sel' : '');
            card.type = 'button';
            const color = RUNTIME_COLOR[r.runtime_kind] || '#64748b';
            card.style.setProperty('--ar-accent', color);
            // Count-tick flash: when a live update raised this card's numbers,
            // pulse the card once so the change is visible without reading.
            const countKey = `${r.spans}|${r.blocked}|${r.detections}|${r.secrets}`;
            nextCounts[r.trace_id] = countKey;
            if (prevCounts[r.trace_id] && prevCounts[r.trace_id] !== countKey) card.classList.add('ar-card-tick');
            // Label leads with the custom name or "agent #N" (matching the Map);
            // the runtime/harness is always shown as a small secondary tag.
            const rtMain = `<span class="ar-run-rt">${this._esc(this._agentLabel(r))}</span>` +
                `<span class="ar-run-sub">${this._esc(r.runtime_kind)}</span>` +
                (this._isLive(r.ended_at) ? this._liveBadge() : '');
            card.innerHTML =
                `<div class="ar-run-top"><span class="ar-run-dot" style="background:${color}"></span>` +
                rtMain +
                `<span class="ar-risk" style="background:${RISK_DOT[r.risk] || RISK_DOT.green}" title="risk: ${r.risk}"></span></div>` +
                `<div class="ar-run-meta"><span><span class="ar-num">${r.spans}</span> tool ${r.spans === 1 ? 'run' : 'runs'}</span>` +
                (r.blocked ? `<span class="ar-blk">${BAN_SVG('#ef4444')} <span class="ar-num ar-blk">${r.blocked}</span> blocked</span>` : '') +
                (r.detections ? `<span class="ar-thr" title="threats detected in this trace">${AR_VIRUS_SVG('#ef4444', 12)}<span class="ar-num" style="color:#ef4444">${r.detections}</span> detected</span>` : '') +
                (r.secrets ? `<span class="ar-sec" title="secret/credential detections in this trace">${AR_LOCK_SVG('#f59e0b', 12)}<span class="ar-num" style="color:#f59e0b">${r.secrets}</span> secret</span>` : '') +
                `<span class="ar-run-time">${this._fmtTime(r.ended_at)}</span></div>`;
            card.addEventListener('click', () => this.selectRun(r.trace_id));
            list.appendChild(card);
        });
        this._prevCounts = { ...prevCounts, ...nextCounts };
        // Snapshot which traces rendered as live, so a badge expiring (trace
        // goes quiet, data unchanged) still triggers a repaint on the next poll.
        this._liveIds = (this.runs || []).filter(r => this._isLive(r.ended_at)).map(r => r.trace_id).join(',');
    },

    async selectRun(traceId) {
        this.selected = traceId;
        this.runSearch = '';  // a new trace starts unfiltered
        this._replayStop();   // a new trace resets any in-progress replay
        this._live.pendingDetail = false; // stale "new activity" pull is void
        this._live.lastDetail = Date.now();
        document.querySelectorAll('.ar-run').forEach(el => el.classList.remove('sel'));
        this.renderRuns();
        const detail = document.getElementById('ar-detail');
        if (detail) detail.innerHTML = '<div class="ar-empty">Loading trace…</div>';
        const trace = await API.getTrace(traceId);
        if (this.selected !== traceId) return; // a newer run was clicked mid-fetch
        if (!trace) { this._detailEmpty('Trace unavailable.', ''); return; }
        this._trace = trace;
        this.renderWaterfall(trace);
    },

    renderWaterfall(trace) {
        const detail = document.getElementById('ar-detail');
        if (!detail) return;
        detail.textContent = '';
        const color = RUNTIME_COLOR[trace.runtime_kind] || '#64748b';

        const head = document.createElement('div');
        head.className = 'ar-det-head';
        head.innerHTML = `<span class="ar-run-dot" style="background:${color}"></span>` +
            `<span class="ar-det-title">${this._esc(this._agentLabel(trace))}</span>` +
            `<span class="ar-run-sub">${this._esc(trace.runtime_kind)}</span>` +
            (this._isLive(trace.ended_at) ? this._liveBadge('This agent is still running — the trace refreshes itself while activity continues') : '') +
            `<span class="ar-det-eyebrow" title="One recorded agent execution. Every row below is a run inside this trace.">Trace</span>`;
        detail.appendChild(head);

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
            });
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
                ? stat(`≈$${totalCost.toFixed(totalCost < 0.01 ? 4 : 2)}`, 'LLM cost · est.',
                    '<span title="Estimated from transcript token counts × API list prices — total across every LLM run in this trace. Not metered billing: on a subscription plan (e.g. Claude Pro/Max) this usage is included, not invoiced.">list-price equivalent</span>')
                : '') +
            (dur && dur !== '0s'
                ? stat(dur, 'wall clock', '<span title="Time from the first to the last run — not per-run latency">first → last run</span>')
                : '') +
            (trace.blocked
                ? stat(Number(trace.blocked).toLocaleString(), 'blocked', 'enforcement stopped these', 'danger')
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
                this._detailEmpty(`No ${what} calls in this trace.`, 'Clear the Tool/Outcome filter to see the full trace.');
                return;
            }
            const msg = none ? 'No tool kind selected.'
                : !this.kinds.builtin ? 'No external MCP calls in this trace.'
                    : 'No built-in tool calls in this trace.';
            this._detailEmpty(msg, none ? 'Tick Built-in or External MCP to show steps.' : 'Tick the other Tool checkbox to see everything.');
            return;
        }

        // Heading that names the containment: everything below is a run that
        // belongs to THIS trace — the direct answer to "which run is whose".
        const runsHead = document.createElement('div');
        runsHead.className = 'ar-runs-heading';
        const hb = document.createElement('b');
        hb.textContent = 'Runs in this trace';
        runsHead.appendChild(hb);
        // In-trace search — filter the loaded runs by tool / model / reason.
        // Hidden during replay (replay owns row visibility). Typing toggles row
        // visibility in place (no rebuild) so focus/caret are never lost.
        if (!this._replay.on) {
            const search = document.createElement('input');
            search.type = 'search';
            search.className = 'ar-run-search';
            search.placeholder = 'Filter runs — tool, model, reason…';
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
        chrono.forEach(s => {
            if (s.span_kind === 'generation') { cur = { gen: s, tools: [] }; turns.push(cur); }
            else {
                if (!cur) { cur = { gen: null, tools: [] }; turns.push(cur); }
                cur.tools.push(s);
            }
        });
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
    _searchText(s) {
        if (s.span_kind === 'generation') {
            return [s.model, s.stop_reason, ...(s.tools_called || [])].join(' ').toLowerCase();
        }
        // Include outcome ("blocked"/"allow"/"log_only") so the natural word for
        // a verdict is searchable, not just the raw action ("block").
        return [s.function_name, s.tool_id, s.reason, s.action, s.outcome, s.risk].join(' ').toLowerCase();
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
        const s = (t + ' ' + r).toLowerCase();
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
    _genSpan(s, stepN) {
        const span = document.createElement('div');
        span.className = 'ar-span ar-span-gen';
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
            `<span class="ar-gen-cost" title="Estimated: transcript token counts × API list price. Not metered billing — on a subscription plan this usage is included.">${cost}</span>${stop}` +
            `<span class="ar-time">${this._fmtTime(s.called_at)}</span>` +
            this._timingHtml(s, '#5eadb8') + `</div>` +
            this._genDetail(s);
        span.querySelector('.ar-span-row').addEventListener('click', () => span.classList.toggle('open'));
        return span;
    },

    /** Expandable body for a generation: the redacted prompt (input) and model
     *  response (output) previews, plus the token/model metadata. Honest about
     *  the privacy contract — 200-char cap, secret-redacted, and the
     *  "not stored" state when the user's Store-text-content setting is off. */
    _genDetail(s) {
        const box = (label, preview, truncated, isTool) => {
            let bodyHtml;
            if (preview == null) {
                bodyHtml = `<div class="ar-gen-note">Text preview off — enable “Store text content” in Settings to capture a redacted excerpt. Tokens and cost are always recorded.</div>`;
            } else if (!preview) {
                bodyHtml = `<div class="ar-gen-note">${isTool ? 'Turn driven by a tool result (no prompt text).' : 'No text in this turn (tool call / reasoning only).'}</div>`;
            } else {
                bodyHtml = `<pre class="ar-gen-pre">${this._esc(preview)}${truncated ? '<span class="ar-gen-ellipsis">…</span>' : ''}</pre>`;
            }
            return `<div class="ar-gen-io"><div class="ar-args-label">${label}</div>${bodyHtml}</div>`;
        };
        const kv = (k, v) => v ? `<dt>${k}</dt><dd>${this._esc(v)}</dd>` : '';
        const cache = (s.cache_read_tokens || s.cache_creation_tokens)
            ? `${this._fmtTok(s.cache_read_tokens)} read · ${this._fmtTok(s.cache_creation_tokens)} created` : '';
        // Tool results (Pillar 3) — what the tools this run called returned,
        // matched by tool_use_id in the transcript. Redacted + capped like every
        // other preview; honest "not stored" / "(empty)" states.
        const results = Array.isArray(s.tool_results) ? s.tool_results : [];
        const resultsHtml = results.length
            ? `<div class="ar-gen-io"><div class="ar-args-label">Tool results returned (${results.length})</div>` +
                results.map(r => {
                    const nm = this._esc(this._prettyTool(r.name || 'tool'));
                    const err = r.is_error ? '<span class="ar-tr-err">error</span>' : '';
                    let body;
                    if (r.preview == null) body = `<div class="ar-gen-note">Not stored — enable “Store text content” in Settings to capture a redacted excerpt.</div>`;
                    else if (!r.preview) body = `<div class="ar-gen-note">(empty result)</div>`;
                    else body = `<pre class="ar-gen-pre">${this._esc(r.preview)}${r.truncated ? '<span class="ar-gen-ellipsis">…</span>' : ''}</pre>`;
                    return `<div class="ar-tr"><div class="ar-tr-head"><span class="ar-tr-arrow">&#8592;</span><b>${nm}</b>${err}</div>${body}</div>`;
                }).join('') +
              `</div>`
            : '';
        return `<div class="ar-detail-body">` +
            box('LLM input — prompt (redacted preview)', s.input_preview, s.input_truncated, s.input_is_tool_result) +
            box('LLM output — response (redacted preview)', s.output_preview, s.output_truncated, false) +
            resultsHtml +
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
            `<div class="ar-gen-privacy">Preview only — first 200 characters, secrets redacted. SecureVector never stores the full prompt or response.</div>` +
            `</div>`;
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
            ? '<span class="ar-det-outcome blocked">blocked — stopped</span>'
            : '<span class="ar-det-outcome allowed">allowed — ran anyway</span>';
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
        const args = s.args_preview
            ? `<div class="ar-args"><div class="ar-args-label">Arguments (redacted preview)</div><pre>${this._esc(s.args_preview)}</pre></div>`
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
              `<div class="ar-args-label">Scanned content — LLM input/output excerpt</div>` +
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
            `</dl>${args}${scan}</div>`;
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
                'scanned — never full prompt/response bodies — and only when "Store text content" is on in Settings.';
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

    _detailEmpty(title, sub) {
        const detail = document.getElementById('ar-detail');
        if (detail) detail.innerHTML = `<div class="ar-empty"><div style="font-size:15px;margin-bottom:6px;">${title}</div><div style="font-size:13px;">${sub}</div></div>`;
    },

    _fmtTime(iso) {
        if (!iso) return '';
        const t = String(iso).replace(' ', 'T') + (String(iso).endsWith('Z') ? '' : 'Z');
        const d = new Date(t);
        if (isNaN(d)) return String(iso);
        return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
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
            : `<span class="ar-delta" title="Started ${this._fmtGap(s._gap).slice(1)} after the previous run (start-to-start — not this run’s latency)">${this._fmtGap(s._gap)}</span>`;
        const p = Math.max(4, Math.min(96, (s._pos || 0) * 100)); // keep the tick fully visible at the rails
        const pos = (typeof s._pos === 'number')
            ? `<span class="ar-tl" title="When this run started within the trace (${Math.round(s._pos * 100)}% through)">` +
              `<i style="left:calc(${p.toFixed(1)}% - 3px);background:${tickColor}"></i></span>`
            : '';
        return gap + pos;
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
};

window.AgentRunsPage = AgentRunsPage;
