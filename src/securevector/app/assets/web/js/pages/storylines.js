/**
 * Agent Sessions — step → session → agent lifeline (v5.0.0).
 *
 * (Internal id/file stays "storylines"; the user-facing name is "Sessions",
 * matching the Sessions concept in LangSmith / Langfuse / Phoenix.)
 *
 * Completes the observability hierarchy the Map/Runs/Timeline lenses left
 * open: the multi-session level. Every runtime gets a lifeline of its
 * sessions over time — with the security verdict first-class at every
 * level: per-agent totals (sessions / steps / blocked), session dots colored
 * by the run's existing green/amber/red risk, and a drill-down into the
 * ordered enforced-call spans of any session.
 *
 * "What changed" chips surface behavioral drift within the loaded window —
 * first-seen tools and the first blocked call — computed client-side from
 * the same runs list.
 *
 * The session drill-down IS the complete trace (no hand-off to Runs): tool
 * calls from /api/traces/{id} are merged, in execution order, with the
 * session's scanned LLM exchanges from /api/threat-intel?session_id=… — so
 * one waterfall shows what went INTO the LLM, what came OUT, and every tool
 * call between, each with its enforcement verdict. Pure frontend over
 * existing read APIs; no new backend, no new data collection.
 */

// Keep in sync with agent-map.js HARNESS_FIXED / agent-runs.js RUNTIME_COLOR /
// agent-timeline.js TL_RUNTIME_COLOR so a harness reads the same colour in
// every observability lens.
const STORY_RUNTIME_COLOR = {
    // v5: runtimes are labels, not statuses — one neutral dot for all.
    'claude-code': '#8b949e', codex: '#8b949e', openclaw: '#8b949e',
    'copilot-cli': '#8b949e', cursor: '#8b949e',
    langchain: '#8b949e', langgraph: '#8b949e', crewai: '#8b949e',
    hermes: '#8b949e',
};
const STORY_RUNTIME_LABEL = {
    'claude-code': 'Claude Code', codex: 'Codex', openclaw: 'OpenClaw',
    'copilot-cli': 'Copilot CLI', cursor: 'Cursor',
    langchain: 'LangChain', langgraph: 'LangGraph', crewai: 'CrewAI',
    hermes: 'Hermes',
};
const STORY_RISK_COLOR = { green: '#10b981', amber: '#f59e0b', red: '#ef4444' };
const STORY_VERDICT = {
    // v5 color policy: only Block earns color. Allow reads neutral — same
    // convention as the Tool Permissions action pills — so a blocked step
    // is the only red thing on the spine.
    block: { color: '#ef4444', label: 'BLOCKED' },
    log_only: { color: '#94a3b8', label: 'LOG' },
    allow: { color: '#8b949e', label: 'ALLOW' },
};

const StorylinesPage = {
    windowDays: 30,
    runs: [],
    openTrace: null, // trace_id of the expanded chapter

    async render(container) {
        this._injectStyles();
        if (window.Header) Header.setPageInfo(
            'Sessions',
            'The overview — every agent’s sessions over time, with the security verdict at a glance. Open one to walk it step-by-step in Traces.'
        );

        container.textContent = '';
        const root = document.createElement('div');
        root.className = 'story';
        this.root = root;
        container.appendChild(root);

        const header = document.createElement('div');
        header.className = 'obs-header';
        if (window.ObsTabs) ObsTabs.render(header, 'storylines');
        header.appendChild(this._windowPills());
        // Audit report export (§3.10 / the queued "Export PDF on Sessions"):
        // one click → a compliance-grade report of EVERY session on the page.
        if (window.ObsTabs) {
            const wrap = document.createElement('div');
            wrap.className = 'story-export';
            wrap.style.marginLeft = 'auto';
            wrap.appendChild(ObsTabs.exportMenu([
                { label: 'Audit report (PDF)', onClick: () => this._exportReport() },
                { label: 'Sessions (CSV)', onClick: () => this._exportCSV() },
            ]));
            header.appendChild(wrap);
        }
        root.appendChild(header);

        const body = document.createElement('div');
        body.className = 'story-body';
        body.innerHTML = '<div class="loading-container"><div class="spinner"></div></div>';
        root.appendChild(body);

        await this._load();
        this._renderBody(body);
    },

    async _load() {
        const data = await API.getTraces({ window_days: this.windowDays, limit: 500 });
        // Oldest-first so what-changed chips read the window chronologically.
        this.runs = (data.runs || []).slice().sort((a, b) =>
            String(a.started_at).localeCompare(String(b.started_at)));
    },

    _parseTs(iso) {
        if (!iso) return null;
        const d = new Date(String(iso).replace(' ', 'T') + (String(iso).endsWith('Z') ? '' : 'Z'));
        return isNaN(d) ? null : d;
    },

    _rel(d) {
        const m = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
        if (m < 1) return 'just now';
        if (m < 60) return `${m}m ago`;
        if (m < 1440) return `${Math.round(m / 60)}h ago`;
        return `${Math.round(m / 1440)}d ago`;
    },

    // ------------------------------------------------------------- exports

    _esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    },
    _fmtTs(iso) {
        const d = this._parseTs(iso);
        return d ? d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
    },
    _winLabel() { return this.windowDays === 1 ? '24 hours' : this.windowDays + ' days'; },

    /** Flat per-session rows — the shared basis for the CSV and the PDF table. */
    _sessionRows() {
        return (this.runs || []).slice()
            .sort((a, b) => String(b.ended_at).localeCompare(String(a.ended_at)))
            .map(r => ({
                runtime: STORY_RUNTIME_LABEL[r.runtime_kind] || r.runtime_kind || 'unknown',
                session_id: r.session_id || '',
                trace_id: r.trace_id || '',
                steps: r.spans || 0,
                blocked: r.blocked || 0,
                log_only: r.log_only || 0,
                risk: r.risk || 'green',
                started: this._fmtTs(r.started_at),
                ended: this._fmtTs(r.ended_at),
            }));
    },
    _sessionCols() {
        return [
            { label: 'runtime', get: r => r.runtime },
            { label: 'session_id', get: r => r.session_id },
            { label: 'trace_id', get: r => r.trace_id },
            { label: 'steps', get: r => r.steps },
            { label: 'blocked', get: r => r.blocked },
            { label: 'log_only', get: r => r.log_only },
            { label: 'risk', get: r => r.risk },
            { label: 'started', get: r => r.started },
            { label: 'ended', get: r => r.ended },
        ];
    },
    _exportCSV() {
        const rows = this._sessionRows();
        if (!rows.length) { if (window.Toast) Toast.error('No sessions to export'); return; }
        ObsTabs.download(`securevector-sessions-${this.windowDays}d.csv`,
            ObsTabs.toCSV(this._sessionCols(), rows), 'text/csv');
    },

    /** The compliance-grade PDF: totals, per-agent rollup, every session, the
     *  policies that fired (from the blocked-action ledger), and the redaction
     *  posture — everything on the page, in one auditable artifact. */
    async _exportReport() {
        const rows = this._sessionRows();
        if (!rows.length) { if (window.Toast) Toast.error('No sessions to export'); return; }
        const stories = this._storylines();
        const totals = {
            agents: stories.length,
            sessions: rows.length,
            steps: rows.reduce((s, r) => s + r.steps, 0),
            blocked: rows.reduce((s, r) => s + r.blocked, 0),
        };
        // Enrich with the blocked-action ledger so "policies fired" is real.
        let ledger = null;
        try { ledger = await API.getBlockedLedger({ window_days: this.windowDays }); } catch (_) { /* optional */ }

        const summary =
            `<div class="sub">Window: last ${this._winLabel()} · ${totals.agents} agents · ${totals.sessions} sessions · ` +
            `${totals.steps.toLocaleString()} enforced calls · ${totals.blocked} blocked</div>`;

        // Per-agent rollup
        const agentRows = stories.map(s => ({
            runtime: s.label, sessions: s.sessions, steps: s.steps,
            blocked: s.blocked, tools: s.tools,
            last: s.lastAt ? s.lastAt.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—',
        }));
        const agentTable = ObsTabs.tableHTML([
            { label: 'runtime', get: r => r.runtime },
            { label: 'sessions', get: r => r.sessions },
            { label: 'enforced calls', get: r => r.steps },
            { label: 'blocked', get: r => r.blocked },
            { label: 'distinct tools', get: r => r.tools },
            { label: 'last active', get: r => r.last },
        ], agentRows);

        const sessionTable = ObsTabs.tableHTML(this._sessionCols(), rows);

        // Policies fired (blocked-action ledger)
        let policyTable = '<p style="color:#666;font-size:12px;">No tool calls were blocked in this window.</p>';
        if (ledger && (ledger.by_reason || []).length) {
            policyTable = ObsTabs.tableHTML([
                { label: 'policy / rule that fired', get: r => r.reason },
                { label: 'blocks', get: r => r.count },
                { label: 'tools', get: r => r.tools },
                { label: 'agents', get: r => r.agents },
                { label: 'high-risk', get: r => r.high_risk ? 'yes' : 'no' },
            ], ledger.by_reason);
        }

        const methodology =
            `<h2>Methodology &amp; data posture</h2>` +
            `<p style="font-size:12px;line-height:1.6;color:#333;">` +
            `This report is generated locally on the device from the tool-call audit log and agent transcripts. ` +
            `Every enforced tool call is recorded in a SHA-256 hash chain (tamper-evident). ` +
            `Argument and LLM input/output previews are capped at 200 characters and secret-redacted before storage — ` +
            `SecureVector never stores full prompts, responses, or command bodies. ` +
            `"Enforced calls" counts tool invocations that passed through policy; "blocked" counts those a deny policy or ` +
            `blocking threat rule stopped. Session and trace identifiers are the runtime's own session ids.</p>`;

        const generatedAt = new Date().toLocaleString();
        ObsTabs.printDoc('SecureVector — Agent Session Audit Report',
            `<h1>Agent Session Audit Report</h1>${summary}` +
            `<div class="sub">Generated ${this._esc(generatedAt)}</div>` +
            `<h2>By agent</h2>${agentTable}` +
            `<h2>Policies that fired</h2>${policyTable}` +
            `<h2>All sessions (${rows.length})</h2>${sessionTable}` +
            methodology);
    },

    // ------------------------------------------------------------- storylines

    /** Group runs into storylines (one per runtime) and annotate drift:
     *  chips = what changed in each session vs. the agent's own earlier
     *  sessions IN THIS WINDOW (honest scope — no hidden lookback). */
    _storylines() {
        const groups = new Map();
        this.runs.forEach(r => {
            if (!groups.has(r.runtime_kind)) groups.set(r.runtime_kind, []);
            groups.get(r.runtime_kind).push(r);
        });
        const stories = [];
        groups.forEach((runs, kind) => {
            const seenTools = new Set();
            let blockedSeen = false;
            const chapters = runs.map(r => {
                const newTools = (r.tools || []).filter(t => !seenTools.has(t));
                (r.tools || []).forEach(t => seenTools.add(t));
                const firstBlock = !blockedSeen && (r.blocked || 0) > 0;
                if (firstBlock) blockedSeen = true;
                return { run: r, newTools, firstBlock, isFirst: r === runs[0] };
            });
            stories.push({
                kind,
                label: STORY_RUNTIME_LABEL[kind] || kind,
                color: STORY_RUNTIME_COLOR[kind] || 'var(--accent-primary, #5eadb8)',
                chapters,
                sessions: runs.length,
                steps: runs.reduce((s, r) => s + (r.spans || 0), 0),
                blocked: runs.reduce((s, r) => s + (r.blocked || 0), 0),
                tools: seenTools.size,
                lastAt: this._parseTs(runs[runs.length - 1].ended_at || runs[runs.length - 1].started_at),
            });
        });
        // Most recently active storyline first.
        stories.sort((a, b) => (b.lastAt?.getTime() || 0) - (a.lastAt?.getTime() || 0));
        return stories;
    },

    _renderBody(body) {
        body.textContent = '';
        const stories = this._storylines();

        if (!stories.length) {
            const empty = document.createElement('div');
            empty.className = 'story-empty';
            empty.innerHTML =
                '<div class="story-empty-title">No agent sessions in this window yet</div>' +
                '<div class="story-empty-sub">Protect a runtime with the Connect Wizard — its sessions will appear here, grouped per agent.</div>';
            const cta = document.createElement('button');
            cta.className = 'story-btn story-btn-primary';
            cta.textContent = 'Open the Connect Wizard →';
            cta.addEventListener('click', () => { if (window.App) App.loadPage('connect-wizard'); });
            empty.appendChild(cta);
            body.appendChild(empty);
            return;
        }

        // Summary strip — the page-level TL;DR before the per-agent cards,
        // so the default Observability landing answers "how much, how bad"
        // in one glance. Red appears only when something was actually
        // blocked (SOC discipline: color = security state).
        const agg = stories.reduce((a, s) => ({
            agents: a.agents + 1,
            sessions: a.sessions + (s.sessions || 0),
            steps: a.steps + (s.steps || 0),
            blocked: a.blocked + (s.blocked || 0),
            lastAt: (!a.lastAt || (s.lastAt && s.lastAt > a.lastAt)) ? s.lastAt : a.lastAt,
        }), { agents: 0, sessions: 0, steps: 0, blocked: 0, lastAt: null });
        const strip = document.createElement('div');
        strip.className = 'story-summary';
        const cell = (val, lbl, cls) =>
            `<div class="story-sum-cell${cls ? ' ' + cls : ''}">` +
            `<div class="story-sum-val">${val}</div><div class="story-sum-lbl">${lbl}</div></div>`;
        strip.innerHTML =
            cell(agg.agents, agg.agents === 1 ? 'agent' : 'agents') +
            cell(agg.sessions, agg.sessions === 1 ? 'session' : 'sessions') +
            cell(agg.steps, 'enforced calls') +
            cell(agg.blocked, 'blocked', agg.blocked ? 'story-sum-red' : '') +
            (agg.lastAt ? cell(this._rel(agg.lastAt), 'last activity') : '');
        body.appendChild(strip);

        stories.forEach((s, i) => body.appendChild(this._storylineCard(s, i)));
    },

    _storylineCard(story, index) {
        const card = document.createElement('div');
        card.className = 'story-card';
        if (!this._reducedMotion()) card.style.animationDelay = `${index * 80}ms`;

        // Collapsible agent group — the most recently active agent opens by
        // default; the rest start collapsed so a many-agent device stays
        // scannable. State survives re-renders within the page instance.
        if (!this._openStories) this._openStories = new Set([story.kind]);
        if (index === 0 && !this._touchedStories) this._openStories.add(story.kind);
        const isOpen = this._openStories.has(story.kind);

        // -- Header: identity + verdict totals (click to collapse/expand) --
        const head = document.createElement('button');
        head.type = 'button';
        head.className = 'story-head';
        head.setAttribute('aria-expanded', String(isOpen));
        const chev = document.createElement('span');
        chev.className = 'story-head-chev';
        chev.textContent = '›';
        head.appendChild(chev);
        const dot = document.createElement('span');
        dot.className = 'story-dot';
        dot.style.background = story.color;
        head.appendChild(dot);
        const name = document.createElement('span');
        name.className = 'story-name';
        name.textContent = story.label;
        head.appendChild(name);
        const totals = document.createElement('span');
        totals.className = 'story-totals';
        const blockedBit = story.blocked
            ? ` · <b class="story-red">${story.blocked} blocked</b>` : ' · 0 blocked';
        totals.innerHTML =
            `${story.sessions} session${story.sessions === 1 ? '' : 's'}` +
            ` · ${story.steps} step${story.steps === 1 ? '' : 's'}` +
            blockedBit +
            ` · ${story.tools} tool${story.tools === 1 ? '' : 's'}`;
        head.appendChild(totals);
        if (story.lastAt) {
            const last = document.createElement('span');
            last.className = 'story-last';
            last.textContent = `last active ${this._rel(story.lastAt)}`;
            head.appendChild(last);
        }
        card.appendChild(head);

        // -- Collapsible body: lifeline + chapters --
        const bodyWrap = document.createElement('div');
        bodyWrap.className = 'story-card-body';
        bodyWrap.hidden = !isOpen;

        // Lifeline: chapters positioned on the window's time axis. Skipped
        // when it carries no information (single session, or all sessions
        // clustered at one instant) — otherwise it reads as an empty box.
        const lifeline = this._lifeline(story);
        if (lifeline) bodyWrap.appendChild(lifeline);

        // Chapters (newest first).
        const list = document.createElement('div');
        list.className = 'story-chapters';
        story.chapters.slice().reverse().forEach(ch => list.appendChild(this._chapterRow(ch, story)));
        bodyWrap.appendChild(list);
        card.appendChild(bodyWrap);

        head.addEventListener('click', () => {
            this._touchedStories = true;
            const nowOpen = bodyWrap.hidden;
            bodyWrap.hidden = !nowOpen;
            head.setAttribute('aria-expanded', String(nowOpen));
            if (nowOpen) this._openStories.add(story.kind);
            else this._openStories.delete(story.kind);
        });

        return card;
    },

    _lifeline(story) {
        // Only draw the time axis when it can actually separate sessions:
        // ≥2 sessions spread across ≥3% of the window. Below that the strip
        // is a wide empty box with one dot — noise, not signal.
        const times = story.chapters
            .map(ch => this._parseTs(ch.run.started_at))
            .filter(Boolean)
            .map(d => d.getTime());
        if (times.length < 2) return null;
        const spread = Math.max(...times) - Math.min(...times);
        if (spread < this.windowDays * 86400000 * 0.03) return null;

        const wrap = document.createElement('div');
        wrap.className = 'story-lifeline';
        const track = document.createElement('div');
        track.className = 'story-track';
        wrap.appendChild(track);

        const now = Date.now();
        const start = now - this.windowDays * 86400000;
        story.chapters.forEach(ch => {
            const t = this._parseTs(ch.run.started_at);
            if (!t) return;
            const pct = Math.min(99, Math.max(1, ((t.getTime() - start) / (now - start)) * 100));
            const d = document.createElement('button');
            d.type = 'button';
            d.className = 'story-chapter-dot';
            const size = Math.max(10, Math.min(22, 8 + Math.sqrt(ch.run.spans || 1) * 3));
            d.style.cssText = `left:${pct}%; width:${size}px; height:${size}px;` +
                `background:${STORY_RISK_COLOR[ch.run.risk] || STORY_RISK_COLOR.green};`;
            d.title = `${this._parseTs(ch.run.started_at)?.toLocaleString() || ''} — ` +
                `${ch.run.spans} step${ch.run.spans === 1 ? '' : 's'}` +
                (ch.run.blocked ? `, ${ch.run.blocked} blocked` : '');
            d.setAttribute('aria-label', d.title);
            d.addEventListener('click', () => this._toggleChapter(ch.run.trace_id));
            track.appendChild(d);
        });

        const axis = document.createElement('div');
        axis.className = 'story-axis';
        axis.innerHTML = `<span>${this.windowDays}d ago</span><span>now</span>`;
        wrap.appendChild(axis);
        return wrap;
    },

    _chapterRow(ch, story) {
        const r = ch.run;
        const row = document.createElement('div');
        row.className = 'story-chapter';
        row.dataset.traceId = r.trace_id;

        const line = document.createElement('button');
        line.type = 'button';
        line.className = 'story-chapter-line';
        line.setAttribute('aria-expanded', 'false');

        const risk = document.createElement('span');
        risk.className = 'story-risk';
        risk.style.background = STORY_RISK_COLOR[r.risk] || STORY_RISK_COLOR.green;
        line.appendChild(risk);

        const when = document.createElement('span');
        when.className = 'story-when';
        const t = this._parseTs(r.started_at);
        when.textContent = t ? `${t.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
        line.appendChild(when);

        const label = document.createElement('span');
        label.className = 'story-chapter-label';
        const custom = window.ObsTabs && ObsTabs.agentName(r.trace_id);
        label.textContent = custom || (r.session_id ? `session ${String(r.session_id).slice(0, 18)}` : 'session');
        line.appendChild(label);

        const stats = document.createElement('span');
        stats.className = 'story-chapter-stats';
        stats.innerHTML = `${r.spans} step${r.spans === 1 ? '' : 's'}` +
            (r.blocked ? ` · <b class="story-red">${r.blocked} blocked</b>` : '');
        line.appendChild(stats);

        // What-changed drift chips — the storyline's whole point.
        if (ch.isFirst) {
            line.appendChild(this._chip('first session', 'var(--accent-primary, #5eadb8)'));
        } else if (ch.newTools.length) {
            const shown = ch.newTools.slice(0, 2);
            shown.forEach(tname => line.appendChild(this._chip(`new tool: ${tname}`, '#f59e0b')));
            if (ch.newTools.length > shown.length) {
                line.appendChild(this._chip(`+${ch.newTools.length - shown.length} more new`, '#f59e0b'));
            }
        }
        if (ch.firstBlock) line.appendChild(this._chip('first blocked call', '#ef4444'));

        const chev = document.createElement('span');
        chev.className = 'story-chev';
        chev.textContent = '›';
        line.appendChild(chev);

        line.addEventListener('click', () => this._toggleChapter(r.trace_id));
        row.appendChild(line);

        const detail = document.createElement('div');
        detail.className = 'story-detail';
        detail.hidden = true;
        row.appendChild(detail);

        return row;
    },

    _chip(text, color) {
        const c = document.createElement('span');
        c.className = 'story-chip';
        c.style.cssText = `color:${color}; border-color: color-mix(in srgb, ${color} 45%, transparent);` +
            `background: color-mix(in srgb, ${color} 10%, transparent);`;
        c.textContent = text;
        return c;
    },

    // ------------------------------------------------------------- drill-down

    async _toggleChapter(traceId) {
        const row = this.root.querySelector(`.story-chapter[data-trace-id="${traceId}"]`);
        if (!row) return;
        const detail = row.querySelector('.story-detail');
        const line = row.querySelector('.story-chapter-line');
        const isOpen = !detail.hidden;

        // Close any open chapter first (one story at a time keeps focus).
        this.root.querySelectorAll('.story-detail').forEach(d => { d.hidden = true; });
        this.root.querySelectorAll('.story-chapter-line').forEach(l => l.setAttribute('aria-expanded', 'false'));
        if (isOpen) return;

        detail.hidden = false;
        line.setAttribute('aria-expanded', 'true');
        row.scrollIntoView({ behavior: this._reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
        if (detail.dataset.loaded) return;

        detail.innerHTML = '<div class="loading-container" style="padding:14px 0"><div class="spinner"></div></div>';

        // The complete trace, in place: tool-call spans + every LLM exchange
        // SecureVector scanned for this session (correlated on session_id),
        // fetched in parallel and merged into one execution-ordered waterfall.
        const run = this.runs.find(r => r.trace_id === traceId);
        const [trace, scans] = await Promise.all([
            API.getTrace(traceId).catch(() => null),
            run && run.session_id
                ? API.getThreats({ session_id: run.session_id, page_size: 100, sort: 'created_at', order: 'asc' }).catch(() => null)
                : Promise.resolve(null),
        ]);
        detail.textContent = '';
        detail.dataset.loaded = '1';

        const spans = (trace && trace.spans) || [];
        const records = (scans && scans.items) || [];

        // Records that share a request_id with a tool span ARE that span's
        // detection — they render inside its anatomy, not as separate nodes.
        // The rest are standalone LLM exchanges (prompt / response scans).
        const spanReqIds = new Set(spans.map(sp => sp.request_id).filter(Boolean));
        const recsByReq = {};
        records.forEach(rec => {
            if (!rec.request_id) return;
            (recsByReq[rec.request_id] = recsByReq[rec.request_id] || []).push(rec);
        });
        const llmEvents = records.filter(rec => !(rec.request_id && spanReqIds.has(rec.request_id)));

        if (!spans.length && !llmEvents.length) {
            detail.innerHTML = '<div class="story-detail-empty">No enforced calls or scanned LLM I/O recorded for this session.</div>';
            return;
        }

        // Merge by timestamp; the sort is stable, so same-second tool spans
        // keep their reliable seq order from the trace API. Generation spans
        // (LLM turns reconstructed from the transcript, §2) carry their own
        // kind so they render as LLM nodes, not tool calls — otherwise they'd
        // show a bare "call" with no tool name.
        const events = [];
        spans.forEach(sp => {
            if (sp.span_kind === 'generation') events.push({ kind: 'gen', at: this._parseTs(sp.called_at), sp });
            else events.push({ kind: 'tool', at: this._parseTs(sp.called_at), sp });
        });
        llmEvents.forEach(rec => events.push({ kind: 'llm', at: this._parseTs(rec.created_at), rec }));
        events.sort((a, b) => (a.at ? a.at.getTime() : 0) - (b.at ? b.at.getTime() : 0));

        const steps = document.createElement('div');
        steps.className = 'story-steps';
        events.forEach((ev, i) => steps.appendChild(
            ev.kind === 'tool' ? this._stepNode(ev.sp, i, recsByReq)
                : ev.kind === 'gen' ? this._genNode(ev.sp, i)
                    : this._llmNode(ev.rec, i)));
        detail.appendChild(steps);

        // Honest trace summary instead of a hand-off button — this view IS
        // the complete trace for the session.
        const foot = document.createElement('div');
        foot.className = 'story-detail-foot story-trace-note';
        const genN = spans.filter(sp => sp.span_kind === 'generation').length;
        const toolN = spans.length - genN;
        const llmN = llmEvents.length;
        // Honest scope: the engine persists a scanned exchange only when it
        // flags a threat, so "no flagged LLM I/O" ≠ "no LLM traffic".
        const genTotal = trace && trace.generation_total;
        const genLabel = (trace && trace.generation_truncated)
            ? ` · latest ${genN} of ${genTotal} LLM turns`
            : (genN ? ` · ${genN} LLM turn${genN === 1 ? '' : 's'}` : '');
        foot.textContent = `Complete trace · ${toolN} tool call${toolN === 1 ? '' : 's'}` +
            genLabel +
            (llmN
                ? ` · ${llmN} flagged LLM exchange${llmN === 1 ? '' : 's'}`
                : ' · no flagged LLM I/O in this session (clean exchanges are scanned but not stored)');
        detail.appendChild(foot);
    },

    /** One waterfall node: header row (verdict dot on the spine, tool name,
     *  kind, time) + an expandable anatomy panel with labelled sections —
     *  Tool input (args preview), Decision (verdict + reason), and the
     *  scanned LLM input/output excerpt when a correlated record exists.
     *  `recsByReq` carries the session's prefetched scan records so the
     *  anatomy renders without a second fetch. */
    _stepNode(sp, i, recsByReq) {
        const v = STORY_VERDICT[sp.action] || STORY_VERDICT.allow;
        const node = document.createElement('div');
        node.className = 'story-wf';

        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'story-wf-row';
        row.setAttribute('aria-expanded', 'false');

        const dot = document.createElement('span');
        dot.className = 'story-wf-dot';
        dot.style.background = v.color;
        row.appendChild(dot);

        const idx = document.createElement('span');
        idx.className = 'story-wf-idx';
        idx.textContent = '#' + i;
        row.appendChild(idx);

        // Kind pill — same visual family as the LLM INPUT / LLM OUTPUT pills
        // so every node on the spine declares what it is at a glance. MCP
        // tools get their own pill; harness built-ins read TOOL.
        const isMcp = window.ObsTabs && ObsTabs.isExternalTool(sp.tool_id);
        const tag = document.createElement('span');
        tag.className = 'story-llm-tag';
        tag.textContent = isMcp ? 'MCP' : 'TOOL';
        tag.title = isMcp
            ? 'External MCP tool — served by an MCP server, not the agent harness'
            : 'Built-in harness tool';
        row.appendChild(tag);

        const fn = document.createElement('span');
        fn.className = 'story-step-fn';
        fn.textContent = sp.function_name || sp.tool_id || 'call';
        row.appendChild(fn);

        const badge = document.createElement('span');
        badge.className = 'story-verdict';
        badge.style.cssText = `color:${v.color}; border-color: color-mix(in srgb, ${v.color} 45%, transparent);`;
        badge.textContent = v.label;
        row.appendChild(badge);

        const at = document.createElement('span');
        at.className = 'story-step-at';
        const ts = this._parseTs(sp.called_at);
        at.textContent = ts ? ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
        row.appendChild(at);

        node.appendChild(row);

        const panel = document.createElement('div');
        panel.className = 'story-wf-panel';
        panel.hidden = true;
        node.appendChild(panel);

        row.addEventListener('click', () => {
            const opening = panel.hidden;
            panel.hidden = !opening;
            row.setAttribute('aria-expanded', String(opening));
            if (opening && !panel.dataset.built) {
                panel.dataset.built = '1';
                this._buildStepAnatomy(panel, sp,
                    recsByReq && sp.request_id ? recsByReq[sp.request_id] : null);
            }
        });

        return node;
    },

    _anatomySection(panel, label, contentEl) {
        const sec = document.createElement('div');
        sec.className = 'story-wf-sec';
        const lab = document.createElement('div');
        lab.className = 'story-wf-sec-label';
        lab.textContent = label;
        sec.appendChild(lab);
        sec.appendChild(contentEl);
        panel.appendChild(sec);
        return sec;
    },

    _buildStepAnatomy(panel, sp, recs) {
        // Tool input — the args the agent passed. This is what SecureVector
        // actually inspected at enforcement time. When nothing was recorded,
        // a quiet note — not an empty box.
        if (sp.args_preview) {
            const input = document.createElement('pre');
            input.className = 'story-wf-pre';
            input.textContent = sp.args_preview;
            const sec = this._anatomySection(panel, 'Tool input', input);
            // The plugin sends only the first 200 chars, secrets redacted —
            // SecureVector never stores full tool arguments (privacy). When the
            // preview is at that cap, say so, so a truncated command doesn't
            // read as a bug.
            if ((sp.args_preview || '').length >= 200) {
                const cap = document.createElement('div');
                cap.className = 'story-wf-note';
                cap.style.marginTop = '5px';
                cap.textContent = 'Preview only — first 200 characters, secrets redacted. SecureVector never stores the full command.';
                sec.appendChild(cap);
            }
        } else {
            const note = document.createElement('div');
            note.className = 'story-wf-note';
            note.textContent = 'No arguments were recorded for this call.';
            this._anatomySection(panel, 'Tool input', note);
        }

        // Decision — what the engine did and why.
        const v = STORY_VERDICT[sp.action] || STORY_VERDICT.allow;
        const dec = document.createElement('div');
        dec.className = 'story-wf-decision';
        const decBadge = document.createElement('span');
        decBadge.className = 'story-verdict';
        decBadge.style.cssText = `color:${v.color}; border-color: color-mix(in srgb, ${v.color} 45%, transparent);`;
        decBadge.textContent = v.label;
        dec.appendChild(decBadge);
        const why = document.createElement('span');
        why.className = 'story-step-why';
        why.textContent = sp.reason || (sp.action === 'allow' ? 'Allowed by the effective tool policy.' : '');
        dec.appendChild(why);
        this._anatomySection(panel, 'Decision', dec);

        // Scanned LLM I/O — the excerpt from the correlated threat record,
        // when one exists. Prefetched with the session's scans; falls back to
        // a lazy fetch for records outside the session correlation. Secure-
        // Vector stores only what it scanned, never full prompt/response bodies.
        if (sp.request_id) {
            const box = document.createElement('div');
            box.className = 'story-wf-scan';
            this._anatomySection(panel, 'Scanned LLM I/O', box);
            if (recs && recs.length) {
                this._renderScanRecords(box, recs);
            } else {
                box.textContent = 'Loading scanned excerpt…';
                API.getThreats({ request_id: sp.request_id, page_size: 5 }).then(res => {
                    this._renderScanRecords(box, (res && res.items) || []);
                }).catch(() => {
                    box.textContent = 'Scanned excerpt unavailable.';
                });
            }
        }
    },

    _renderScanRecords(box, items) {
        box.textContent = '';
        if (!items.length) {
            box.textContent = 'No scanned excerpt stored for this call. SecureVector keeps only what it scanned — never full prompt/response bodies — and only when "Store text content" is on in Settings.';
            return;
        }
        items.forEach(rec => {
            const meta = document.createElement('div');
            meta.className = 'story-wf-scan-meta';
            meta.textContent = [
                rec.action_taken ? `action: ${rec.action_taken}` : '',
                rec.is_threat && rec.threat_type ? `threat: ${rec.threat_type}` : '',
                Number.isFinite(rec.risk_score) ? `risk ${rec.risk_score}` : '',
                rec.text_length ? `${rec.text_length} chars scanned` : '',
            ].filter(Boolean).join(' · ');
            const pre = document.createElement('pre');
            pre.className = 'story-wf-pre';
            pre.textContent = rec.text_content || rec.text_preview || '(content not stored)';
            box.appendChild(meta);
            box.appendChild(pre);
        });
    },

    /** Direction of a scan record: what the agent sent INTO the model
     *  (prompt / incoming context) vs. what came OUT (response). Derived
     *  from the client-supplied scan_type, with the output_ threat-type
     *  prefix as the fallback for older records. */
    _llmDirection(rec) {
        const st = String(((rec.metadata || {}).scan_type) || '').toLowerCase();
        if (st === 'output' || String(rec.threat_type || '').startsWith('output_')) {
            return { tag: 'LLM OUTPUT', section: 'Scanned model response' };
        }
        if (st === 'incoming_context') {
            return { tag: 'CONTEXT', section: 'Scanned incoming context' };
        }
        return { tag: 'LLM INPUT', section: 'Scanned prompt' };
    },

    /** One LLM-exchange node on the same waterfall spine: a scan record not
     *  tied to any tool call — the prompt going into the model or the
     *  response coming back. Verdict coloring follows the SOC policy: red
     *  only when blocked, amber for a logged threat / redaction, neutral
     *  when clean. */
    _llmNode(rec, i) {
        const dir = this._llmDirection(rec);
        const blocked = rec.action_taken === 'blocked';
        const redacted = rec.action_taken === 'redacted';
        const v = blocked
            ? { color: '#ef4444', label: 'BLOCKED' }
            : redacted
                ? { color: '#f59e0b', label: 'REDACTED' }
                : rec.is_threat
                    ? { color: '#f59e0b', label: 'THREAT' }
                    : { color: '#8b949e', label: 'CLEAN' };

        const node = document.createElement('div');
        node.className = 'story-wf';

        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'story-wf-row';
        row.setAttribute('aria-expanded', 'false');

        const dot = document.createElement('span');
        dot.className = 'story-wf-dot';
        dot.style.background = v.color;
        row.appendChild(dot);

        const idx = document.createElement('span');
        idx.className = 'story-wf-idx';
        idx.textContent = '#' + i;
        row.appendChild(idx);

        const tag = document.createElement('span');
        tag.className = 'story-llm-tag';
        tag.textContent = dir.tag;
        row.appendChild(tag);

        const excerpt = document.createElement('span');
        excerpt.className = 'story-step-args';
        excerpt.textContent = rec.text_preview || '';
        row.appendChild(excerpt);

        const badge = document.createElement('span');
        badge.className = 'story-verdict';
        badge.style.cssText = `color:${v.color}; border-color: color-mix(in srgb, ${v.color} 45%, transparent);`;
        badge.textContent = v.label;
        row.appendChild(badge);

        const at = document.createElement('span');
        at.className = 'story-step-at';
        const ts = this._parseTs(rec.created_at);
        at.textContent = ts ? ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
        row.appendChild(at);

        node.appendChild(row);

        const panel = document.createElement('div');
        panel.className = 'story-wf-panel';
        panel.hidden = true;
        node.appendChild(panel);

        row.addEventListener('click', () => {
            const opening = panel.hidden;
            panel.hidden = !opening;
            row.setAttribute('aria-expanded', String(opening));
            if (opening && !panel.dataset.built) {
                panel.dataset.built = '1';
                this._buildLlmAnatomy(panel, rec, dir, v);
            }
        });

        return node;
    },

    _buildLlmAnatomy(panel, rec, dir, v) {
        // The scanned text — as much of the exchange as SecureVector kept.
        const pre = document.createElement('pre');
        pre.className = 'story-wf-pre';
        pre.textContent = rec.text_content || rec.text_preview || '(content not stored — enable "Store text content" in Settings to keep scanned excerpts)';
        this._anatomySection(panel, dir.section, pre);

        // Verdict — what the engine concluded about this exchange.
        const dec = document.createElement('div');
        dec.className = 'story-wf-decision';
        const decBadge = document.createElement('span');
        decBadge.className = 'story-verdict';
        decBadge.style.cssText = `color:${v.color}; border-color: color-mix(in srgb, ${v.color} 45%, transparent);`;
        decBadge.textContent = v.label;
        dec.appendChild(decBadge);
        const why = document.createElement('span');
        why.className = 'story-step-why';
        const bits = [
            rec.is_threat && rec.threat_type ? `threat: ${rec.threat_type.replace(/^output_/, '')}` : '',
            Number.isFinite(rec.risk_score) && rec.risk_score ? `risk ${rec.risk_score}` : '',
            (rec.matched_rules || []).length ? `${rec.matched_rules.length} rule${rec.matched_rules.length === 1 ? '' : 's'} matched` : '',
            rec.text_length ? `${rec.text_length} chars scanned` : '',
        ].filter(Boolean);
        why.textContent = bits.length ? bits.join(' · ') : 'No threat detected in this exchange.';
        dec.appendChild(why);
        this._anatomySection(panel, 'Verdict', dec);
    },

    /** Compact token formatter: 16571 → "16.6k". */
    _fmtTok(n) {
        n = Number(n) || 0;
        if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k';
        return String(n);
    },

    /** A Generation (LLM turn) node on the session spine — reconstructed from
     *  the transcript (§2). No enforcement verdict (a model turn isn't
     *  allowed/blocked); shows model + token flow, and on expand the redacted
     *  input/output preview + token/cost metadata. Currently populated for
     *  Claude Code sessions (the runtime whose transcript we parse). */
    _genNode(sp, i) {
        const node = document.createElement('div');
        node.className = 'story-wf story-wf-gen';

        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'story-wf-row';
        row.setAttribute('aria-expanded', 'false');

        const dot = document.createElement('span');
        dot.className = 'story-wf-dot';
        dot.style.background = 'var(--accent-primary, #5eadb8)';
        row.appendChild(dot);

        const idx = document.createElement('span');
        idx.className = 'story-wf-idx';
        idx.textContent = '#' + i;
        row.appendChild(idx);

        const tag = document.createElement('span');
        tag.className = 'story-llm-tag';
        tag.textContent = 'LLM';
        tag.title = 'LLM turn — a model generation reconstructed from the session transcript';
        row.appendChild(tag);

        const fn = document.createElement('span');
        fn.className = 'story-step-fn';
        fn.textContent = sp.model || 'model';
        row.appendChild(fn);

        const flow = document.createElement('span');
        flow.className = 'story-gen-flow';
        flow.textContent = `${this._fmtTok(sp.input_tokens)} → ${this._fmtTok(sp.output_tokens)} tok`;
        row.appendChild(flow);

        const at = document.createElement('span');
        at.className = 'story-step-at';
        const ts = this._parseTs(sp.called_at);
        at.textContent = ts ? ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
        row.appendChild(at);

        node.appendChild(row);

        const panel = document.createElement('div');
        panel.className = 'story-wf-panel';
        panel.hidden = true;
        node.appendChild(panel);

        row.addEventListener('click', () => {
            const opening = panel.hidden;
            panel.hidden = !opening;
            row.setAttribute('aria-expanded', String(opening));
            if (opening && !panel.dataset.built) {
                panel.dataset.built = '1';
                this._buildGenAnatomy(panel, sp);
            }
        });

        return node;
    },

    _buildGenAnatomy(panel, sp) {
        const ioBox = (label, preview, truncated, isTool) => {
            const pre = document.createElement('pre');
            pre.className = 'story-wf-pre';
            if (preview == null) {
                pre.textContent = 'Text preview off — enable “Store text content” in Settings to capture a redacted excerpt. Tokens and cost are always recorded.';
                pre.classList.add('story-wf-note');
            } else if (!preview) {
                pre.textContent = isTool ? 'Turn driven by a tool result (no prompt text).' : 'No text in this turn (tool call / reasoning only).';
                pre.classList.add('story-wf-note');
            } else {
                pre.textContent = preview + (truncated ? ' …' : '');
            }
            this._anatomySection(panel, label, pre);
        };
        ioBox('LLM input — prompt (redacted preview)', sp.input_preview, sp.input_truncated, sp.input_is_tool_result);
        ioBox('LLM output — response (redacted preview)', sp.output_preview, sp.output_truncated, false);

        // Metadata line — model, tokens, cost, stop reason.
        const meta = document.createElement('div');
        meta.className = 'story-wf-note';
        const cost = (sp.cost != null) ? ('$' + Number(sp.cost).toFixed(sp.cost < 0.01 ? 4 : 2)) : 'model not in price table';
        meta.textContent = [
            sp.model,
            `${(sp.input_tokens || 0).toLocaleString()} in · ${(sp.output_tokens || 0).toLocaleString()} out`,
            (sp.cache_read_tokens || sp.cache_creation_tokens) ? `${this._fmtTok(sp.cache_read_tokens)} cache read` : '',
            cost,
            sp.stop_reason ? `stop: ${sp.stop_reason}` : '',
        ].filter(Boolean).join(' · ');
        this._anatomySection(panel, 'Generation', meta);

        const priv = document.createElement('div');
        priv.className = 'story-wf-note';
        priv.style.marginTop = '5px';
        priv.textContent = 'Preview only — first 200 characters, secrets redacted. SecureVector never stores the full prompt or response.';
        panel.appendChild(priv);
    },

    // ------------------------------------------------------------------ misc

    _windowPills() {
        const pills = document.createElement('div');
        pills.className = 'story-pills';
        [[7, '7 days'], [30, '30 days'], [90, '90 days']].forEach(([v, label]) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'story-pill' + (v === this.windowDays ? ' on' : '');
            b.textContent = label;
            b.addEventListener('click', async () => {
                if (v === this.windowDays) return;
                this.windowDays = v;
                pills.querySelectorAll('.story-pill').forEach(p => p.classList.toggle('on', p === b));
                const body = this.root.querySelector('.story-body');
                body.innerHTML = '<div class="loading-container"><div class="spinner"></div></div>';
                await this._load();
                this._renderBody(body);
            });
            pills.appendChild(b);
        });
        return pills;
    },

    _reducedMotion() {
        return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    },

    _injectStyles() {
        if (document.getElementById('story-styles')) return;
        const style = document.createElement('style');
        style.id = 'story-styles';
        style.textContent = `
.story { max-width: 1060px; }
.story-pills { display: inline-flex; gap: 2px; background: var(--bg-card); border: 1px solid var(--border-default);
    border-radius: 8px; padding: 2px; margin-left: auto; }
.story-pill { border: none; cursor: pointer; font-size: 11.5px; font-weight: 600; padding: 5px 11px;
    border-radius: 6px; background: transparent; color: var(--text-secondary); }
.story-pill.on { background: var(--accent-primary); color: #fff; }

.story-card { background: var(--bg-card); border: 1px solid var(--border-default); border-radius: var(--radius-lg, 12px);
    padding: 16px 18px 12px; margin-bottom: 14px; animation: story-in .32s ease both; }
@keyframes story-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

.story-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; width: 100%;
    background: transparent; border: none; cursor: pointer; text-align: left; padding: 2px 0;
    font: inherit; color: inherit; border-radius: 6px; }
.story-head:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
.story-head-chev { align-self: center; color: var(--text-muted); font-size: 15px; flex: none;
    transition: transform .15s; }
.story-head[aria-expanded="true"] .story-head-chev { transform: rotate(90deg); }
.story-card-body[hidden] { display: none; }
.story-dot { width: 10px; height: 10px; border-radius: 50%; align-self: center; flex: none; }
.story-name { font-size: 15px; font-weight: 700; color: var(--text-primary); }
.story-totals { font-size: 12.5px; color: var(--text-secondary); }
.story-red { color: #ef4444; font-weight: 700; }
.story-last { margin-left: auto; font-size: 11.5px; color: var(--text-muted); }

.story-lifeline { margin: 14px 2px 6px; }
.story-track { position: relative; height: 34px; border-bottom: 1px solid var(--border-default); }
.story-track::before { content: ''; position: absolute; left: 0; right: 0; top: 50%; height: 1px;
    background: color-mix(in srgb, var(--border-default) 60%, transparent); }
.story-chapter-dot { position: absolute; top: 50%; transform: translate(-50%, -50%); border-radius: 50%;
    border: 2px solid var(--bg-card); cursor: pointer; padding: 0; transition: transform .12s; }
.story-chapter-dot:hover { transform: translate(-50%, -50%) scale(1.25); }
.story-chapter-dot:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
.story-axis { display: flex; justify-content: space-between; font-size: 10.5px; color: var(--text-muted); padding-top: 4px; }

.story-chapters { margin-top: 8px; }
.story-chapter { border-top: 1px solid color-mix(in srgb, var(--border-default) 55%, transparent); }
.story-chapter-line { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
    background: transparent; border: none; cursor: pointer; padding: 9px 4px; border-radius: 6px; flex-wrap: wrap; }
.story-chapter-line:hover { background: var(--bg-hover, rgba(128,128,128,0.06)); }
.story-chapter-line:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: -2px; }
.story-risk { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.story-when { font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums; min-width: 108px; }
.story-chapter-label { font-size: 12.5px; font-weight: 600; color: var(--text-primary);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
.story-chapter-stats { font-size: 12px; color: var(--text-secondary); }
.story-chip { font-size: 10.5px; font-weight: 700; padding: 1px 8px; border-radius: 999px; border: 1px solid; }
.story-chev { margin-left: auto; color: var(--text-muted); font-size: 15px;
    transition: transform .15s; }
.story-chapter-line[aria-expanded="true"] .story-chev { transform: rotate(90deg); }

.story-detail { padding: 2px 4px 12px 30px; }
.story-detail-empty { font-size: 12px; color: var(--text-muted); padding: 8px 0; }

/* Waterfall spine — vertical rail with a verdict dot per tool call, matching
   the Agent Runs visual language so the two lenses read as one system. */
.story-steps { display: flex; flex-direction: column; }
.story-wf { position: relative; padding: 0 0 2px 22px; }
.story-wf::before { content: ''; position: absolute; left: 5px; top: 14px; bottom: -4px; width: 2px;
    background: color-mix(in srgb, var(--border-default) 70%, transparent); }
.story-wf:last-child::before { display: none; }
.story-wf-row { display: flex; align-items: center; gap: 9px; width: 100%; text-align: left;
    background: transparent; border: none; cursor: pointer; padding: 5px 6px; border-radius: 6px;
    font: inherit; color: inherit; flex-wrap: wrap; }
.story-wf-row:hover { background: var(--bg-hover, rgba(128,128,128,0.06)); }
.story-wf-row:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: -2px; }
.story-wf-dot { position: absolute; left: 0; width: 12px; height: 12px; border-radius: 50%;
    border: 2px solid var(--bg-card); box-sizing: content-box; flex: none; }
.story-wf-idx { font-size: 10.5px; color: var(--text-muted); font-family: ui-monospace, Menlo, monospace; flex: none; }
.story-wf-panel { margin: 2px 0 10px 24px; padding: 10px 12px; border: 1px solid var(--border-default);
    border-radius: 8px; background: var(--bg-tertiary); display: flex; flex-direction: column; gap: 10px; }
/* display:flex above beats the UA's [hidden] rule — without this guard every
   collapsed step renders as an empty gray box. */
.story-wf-panel[hidden] { display: none; }
.story-wf-sec-label { font-size: 10px; font-weight: 700; letter-spacing: .6px; text-transform: uppercase;
    color: var(--text-muted); margin-bottom: 4px; }
/* Content boxes (tool input, scanned LLM prompt/response) sit INSIDE the
   bg-tertiary panel. On the v5 deeper palette bg-card was too close to the
   panel and the faded border vanished — the boxes blended together. Use the
   darkest surface + a clear light border so each box reads as its own framed
   block, distinct from the panel and from each other. */
.story-wf-pre { margin: 0; font: 11.5px var(--font-mono, ui-monospace), Menlo, monospace; color: var(--text-primary);
    white-space: pre-wrap; word-break: break-word; max-height: 180px; overflow: auto;
    background: var(--bg-primary); border: 1px solid var(--border-light);
    border-radius: 6px; padding: 9px 11px; box-shadow: var(--elevate-1); }
.story-wf-decision { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
/* Scanned LLM I/O wrapper — a framed block so the input/output exchange is
   clearly separated from the Tool input / Decision sections above it. */
.story-wf-scan { font-size: 11.5px; color: var(--text-secondary); display: flex; flex-direction: column; gap: 8px; }
.story-wf-scan-meta { font-size: 10.5px; color: var(--text-muted); font-family: var(--font-mono, ui-monospace), Menlo, monospace; }

.story-verdict { font-size: 10px; font-weight: 800; letter-spacing: .4px; padding: 1px 7px;
    border-radius: 4px; border: 1px solid; flex: none; }
.story-step-fn { color: var(--text-primary); font-weight: 600; font-family: ui-monospace, Menlo, monospace; }
.story-step-why { color: var(--text-secondary); font-size: 11.5px; }
.story-step-args { color: var(--text-muted); font-size: 11px; font-family: ui-monospace, Menlo, monospace;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px; flex: 1 1 120px; min-width: 0; }
.story-step-at { margin-left: auto; color: var(--text-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
/* Generation (LLM turn) node — teal LLM tag + token flow. */
.story-gen-flow { color: var(--text-secondary); font-size: 11px; font-family: ui-monospace, Menlo, monospace;
    font-variant-numeric: tabular-nums; flex: none; }
.story-wf-gen .story-llm-tag { color: var(--accent-primary, #5eadb8);
    border-color: color-mix(in srgb, var(--accent-primary, #5eadb8) 55%, transparent);
    background: color-mix(in srgb, var(--accent-primary, #5eadb8) 12%, transparent); }
.story-detail-foot { margin-top: 10px; }
.story-trace-note { font-size: 11px; color: var(--text-muted); letter-spacing: .2px; padding-left: 22px; }
.story-llm-tag { font-size: 9.5px; font-weight: 800; letter-spacing: .7px; color: var(--text-secondary);
    border: 1px solid var(--border-default); background: var(--bg-tertiary); padding: 1px 6px;
    border-radius: 4px; flex: none; font-family: ui-monospace, Menlo, monospace; }
.story-wf-note { font-size: 11.5px; color: var(--text-muted); font-style: italic; }

.story-btn { border: 1px solid var(--border-default); background: var(--bg-tertiary); color: var(--text-primary);
    padding: 6px 12px; border-radius: var(--radius-md, 8px); font-size: 12px; font-weight: 600; cursor: pointer; }
.story-btn:hover { background: var(--bg-hover); }
.story-btn-primary { background: var(--accent-primary); border-color: var(--accent-primary); color: #fff; }

.story-empty { text-align: center; padding: 56px 0; }
.story-empty-title { font-size: 15px; font-weight: 700; color: var(--text-primary); margin-bottom: 6px; }
.story-empty-sub { font-size: 13px; color: var(--text-secondary); margin-bottom: 18px; }

/* Page-level summary strip above the agent cards. */
.story-summary { display: flex; flex-wrap: wrap; gap: 6px 36px; padding: 13px 20px;
    background: var(--bg-card); border: 1px solid var(--border-default);
    border-radius: 10px; margin-bottom: 14px; }
.story-sum-cell { min-width: 64px; }
.story-sum-val { font-size: 19px; font-weight: 750; color: var(--text-primary); line-height: 1.2;
    font-variant-numeric: tabular-nums; }
.story-sum-lbl { font-size: 10px; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase;
    color: var(--text-muted); margin-top: 1px; }
.story-sum-red .story-sum-val { color: var(--danger, #f85149); }

@media (prefers-reduced-motion: reduce) {
    .story-card { animation: none !important; }
}
`;
        document.head.appendChild(style);
    },
};

window.StorylinesPage = StorylinesPage;
