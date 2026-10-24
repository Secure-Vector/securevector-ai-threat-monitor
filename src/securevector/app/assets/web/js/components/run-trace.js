/**
 * RunTrace: the run trace view inside Observability (6.0).
 *
 * A Run is one trace inside a Session; a Span is one model turn or tool
 * call. The view has a header (back, run, session, coverage, run stepping,
 * stop), the session governance strip, the span tree with a waterfall, and
 * a right panel: the selected span's detail, or the session governance
 * summary when nothing is selected.
 *
 * Approvals happen here and nowhere else: Allow and Deny exist only in the
 * span panel, next to the one held call they apply to, its rule, data,
 * destination, effect, coverage and expiry. Every approval is scoped to the
 * session it was asked in, and the panel says so.
 *
 * The pure part (tree, guides, filters, strip tiles, decision words, scope
 * text) takes plain data and is tested on its own. Every server string is
 * escaped before it reaches markup.
 */
(function (root) {
    const RunTrace = {
        SAME_CALL_MS: 60000,   // a request within this long of a block of the same tool is that call
        REPEAT_MS: 60000,      // a block after another block to a different target within this is a repeat
        HOSTS_SHOWN: 5,
        HELD_RULES: {
            cred_then_net: 'Credential, then network',
            outside_then_reach: 'Outside content, then credential or network',
            step_up: 'Session at step-up',
        },
        DURATIONS: [['once', 'Allow once'], ['15m', '15 min'], ['1h', '1 h'], ['session', 'This session']],
        SEGMENTS: [['all', 'All'], ['tools', 'Tool calls'], ['held', 'Waiting or blocked']],

        _state: {},

        esc(s) {
            return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        },

        /** Epoch ms for a server timestamp (SQLite UTC with no zone reads as UTC), or null. */
        ms(ts) {
            if (ts == null || ts === '') return null;
            const s = String(ts);
            const t = Date.parse(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
            return Number.isFinite(t) ? t : null;
        },

        /** Per-trace view state, kept across live rebuilds. */
        state(traceId) {
            const k = String(traceId || '');
            if (!this._state[k]) this._state[k] = { sel: null, collapsed: {}, filter: 'all', search: '', busy: false };
            return this._state[k];
        },

        short(id, n = 8) { return String(id || '').slice(0, n); },

        fmtDur(ms) {
            if (ms == null || !Number.isFinite(ms) || ms < 0) return '';
            if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`;
            const s = Math.round(ms / 1000);
            if (s < 60) return `${s}s`;
            const m = Math.floor(s / 60);
            if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
            return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
        },

        fmtTok(n) {
            n = Number(n || 0);
            if (!n) return '';
            if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
            if (n >= 1000) return `${Math.round(n / 1000)}k`;
            return String(n);
        },

        fmtUsd(v) {
            if (v == null || !Number.isFinite(Number(v))) return '';
            const n = Number(v);
            return n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
        },

        clock(ts, seconds) {
            const t = typeof ts === 'number' ? ts : this.ms(ts);
            if (t == null) return '';
            const d = new Date(t);
            const p = (x) => String(x).padStart(2, '0');
            return `${p(d.getHours())}:${p(d.getMinutes())}${seconds ? ':' + p(d.getSeconds()) : ''}`;
        },

        // ------------------------------------------------------------- spans

        isTool(s) { return !!s && s.span_kind !== 'generation'; },

        spanKey(s, i) {
            if (s && s.span_id) return 's:' + s.span_id;
            if (s && s.row_hash) return 'h:' + s.row_hash;
            const n = s && (s._seq != null ? s._seq : s.turn_index);
            return 'i:' + (n != null ? n : i);
        },

        /** The tree caret, the same chevron the Runs list uses; CSS turns it
         *  a quarter for an expanded row. */
        CARET_SVG: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',

        toolName(s) { return String((s && (s.tool_id || s.function_name)) || 'tool'); },

        spanName(n) {
            const s = n.span || {};
            if (n.kind === 'run') return n.title || 'Run';
            if (n.kind === 'llm') return `${s.model || 'model'} · turn ${n.turn || 1}`;
            const arg = this.previewText(s.args_preview || (n.req && n.req.call_preview) || '');
            const a = String(arg).replace(/\s+/g, ' ').trim();
            return a ? `${this.toolName(s)} · ${a.length > 70 ? a.slice(0, 70) + '…' : a}` : this.toolName(s);
        },

        /** A call's arguments as a person reads them: from a JSON preview the
         *  command, else the url, else the file path; else the raw text. A
         *  JSON preview cut short still gives its leading field. */
        previewText(x) {
            const raw = String(x == null ? '' : x);
            const t = raw.trim();
            if (!t.startsWith('{')) return raw;
            const FIELDS = ['command', 'cmd', 'url', 'file_path', 'path'];
            try {
                const o = JSON.parse(t);
                if (o && typeof o === 'object') {
                    for (const k of FIELDS) if (typeof o[k] === 'string' && o[k]) return o[k];
                }
                return raw;
            } catch (_) {
                for (const k of FIELDS) {
                    const m = t.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`));
                    if (m && m[1]) return m[1].replace(/\\(["\\/])/g, '$1').replace(/\\n/g, ' ');
                }
                return raw;
            }
        },

        _norm(x) { return String(this.previewText(x) || '').replace(/\s+/g, ' ').trim().toLowerCase(); },

        // Server preview caps: call_preview (CALL_PREVIEW_CHARS, ends in
        // "...") and args_preview (TRACE_TEXT_CAP, cut with no marker).
        PREVIEW_CAPS: [160, 8192],

        _cut(x) { return String(x).replace(/(…|\.\.\.)$/, ''); },

        /** Was this preview visibly cut short: an ellipsis, a length equal to
         *  a server cap, or JSON that no longer parses. */
        truncated(raw) {
            const r = String(raw == null ? '' : raw).trim();
            if (!r) return false;
            if (/(…|\.\.\.)("?\s*\}?)$/.test(r) || /(…|\.\.\.)$/.test(String(this.previewText(r)).trim())) return true;
            if (this.PREVIEW_CAPS.includes(String(raw).length)) return true;
            if (r.startsWith('{')) { try { JSON.parse(r); } catch (_) { return true; } }
            return false;
        },

        /** How a blocked span and a request agree on content: 2 exact (the
         *  fingerprint when both carry one, else equal readable arguments),
         *  1 a prefix where the shorter side was visibly cut short, 0 none. */
        contentTier(span, req) {
            if (span && req && span.call_fingerprint && req.call_fingerprint) return span.call_fingerprint === req.call_fingerprint ? 2 : 0;
            const ra = span && span.args_preview, rb = req && req.call_preview;
            const a = this._norm(ra), b = this._norm(rb);
            if (!a || !b) return 0;
            if (a === b) return 2;
            const [lo, loRaw, hi] = a.length < b.length ? [a, ra, b] : [b, rb, a];
            if (!this.truncated(loRaw)) return 0;
            const cut = this._cut(lo);
            return cut.length >= 12 && hi.startsWith(cut) ? 1 : 0;
        },

        sameContent(span, req) { return this.contentTier(span, req) > 0; },

        _keys(x) {
            return new Set([x && x.tool_id, x && x.function_name].filter(Boolean).map(v => String(v).toLowerCase()));
        },

        hostOf(text) {
            const t = String(this.previewText(text) || '');
            if (t.toLowerCase().startsWith('egress:')) return t.slice(7);
            const m = t.match(/\b(?:https?|wss?):\/\/([^\/\s'"@:]+)/i);
            return m ? m[1] : null;
        },

        /** Match the session's approval requests to the trace's blocked tool
         *  spans (same tool or host, within SAME_CALL_MS). Returns
         *  { bySpan: Map(key -> request), orphans: [waiting requests with no span] }.
         *  Only waiting requests of this run become orphans. */
        matchRequests(trace, requests, opts = {}) {
            const out = { bySpan: new Map(), orphans: [] };
            const sid = trace && trace.session_id;
            const keyOf = opts.keyOf || null;
            const mine = (Array.isArray(requests) ? requests : []).filter(r => r && r.rule_source !== 'delegate'
                && ((sid && r.session_id === sid) || (r.trace_id && r.trace_id === trace.trace_id))
                && (!r.trace_id || r.trace_id === trace.trace_id));
            const blocks = (trace && trace.spans || []).map((s, i) => ({ s, i, key: (keyOf && keyOf.get(s)) || this.spanKey(s, i) }))
                .filter(x => this.isTool(x.s) && x.s.action === 'block');
            const used = new Set();
            const sorted = mine.slice().sort((a, b) => (this.ms(a.requested_at) || 0) - (this.ms(b.requested_at) || 0));
            // Same tool (or host) within SAME_CALL_MS, nearest first.
            const near = (r) => {
                const rk = this._keys(r);
                const host = this.hostOf(r.tool_id);
                const at = this.ms(r.requested_at);
                return blocks.filter(x => {
                    if (used.has(x.key)) return false;
                    const t = this.ms(x.s.called_at);
                    if (at != null && t != null && Math.abs(at - t) > this.SAME_CALL_MS) return false;
                    if (host) return String(this.previewText(x.s.args_preview) || '').toLowerCase().includes(host.toLowerCase());
                    return [...this._keys(x.s)].some(k => rk.has(k));
                }).sort((a, b) => Math.abs((this.ms(a.s.called_at) || 0) - (at || 0)) - Math.abs((this.ms(b.s.called_at) || 0) - (at || 0)));
            };
            const take = (r, x) => { used.add(x.key); out.bySpan.set(x.key, r); };
            // Pass 1, for every request: exact content (fingerprint, else the
            // same arguments). Pass 2: a prefix of a visibly cut preview.
            let left = sorted;
            [2, 1].forEach(tier => {
                const next = [];
                left.forEach(r => {
                    const hit = near(r).find(x => this.contentTier(x.s, r) >= tier);
                    if (hit) take(r, hit); else next.push(r);
                });
                left = next;
            });
            // Pass 3: time alone, only when nothing matched by content.
            left.forEach(r => {
                const hit = near(r)[0];
                if (hit) take(r, hit);
                else if (r.status === 'pending' && (r.trace_id === trace.trace_id || opts.newest)) out.orphans.push(r);
            });
            return out;
        },

        /** Keys of blocked tool spans that follow another block to a different
         *  target within REPEAT_MS (the session summary's repeat rule). */
        repeatKeys(spans, keyOf) {
            const out = new Set();
            let prev = null;
            (spans || []).map((s, i) => ({ s, i })).filter(x => this.isTool(x.s) && x.s.action === 'block')
                .sort((a, b) => (this.ms(a.s.called_at) || 0) - (this.ms(b.s.called_at) || 0))
                .forEach(x => {
                    const target = `${this.toolName(x.s)}:${x.s.args_preview || ''}`;
                    const t = this.ms(x.s.called_at);
                    if (prev && t != null && prev.t != null && t - prev.t >= 0 && t - prev.t <= this.REPEAT_MS && target !== prev.target) {
                        out.add((keyOf && keyOf.get(x.s)) || this.spanKey(x.s, x.i));
                    }
                    prev = { t, target };
                });
            return out;
        },

        /** The decision word for a span node: waiting, used, allowed once,
         *  approved, blocked, blocked · repeat attempt, or null (allowed). */
        decision(n) {
            if (!n || n.kind !== 'tool') return null;
            const r = n.req;
            const s = n.span || {};
            if (r) {
                if (r.status === 'pending') return { key: 'waiting', label: 'waiting for approval' };
                if (r.status === 'approved') {
                    const g = n.grant;
                    if (g && g.state === 'used') return { key: 'used', label: 'allowed once · used' };
                    if (g && g.duration === 'once') return { key: 'once', label: 'allowed once' };
                    const d = g && this.DURATIONS.find(x => x[0] === g.duration);
                    return { key: 'approved', label: d ? `approved · ${d[1]}` : 'approved' };
                }
            }
            if (s.action === 'block' || (r && (r.status === 'denied' || r.status === 'expired'))) {
                return n.repeat ? { key: 'repeat', label: 'blocked · repeat attempt' } : { key: 'blocked', label: 'blocked' };
            }
            return null;
        },

        /** The span tree: the run at the root, model turns under it and the
         *  tool calls each turn issued under the turn (parent_span_id, else
         *  turn order, via TraceSteps.build); calls with no turn sit flat
         *  under the run. Waiting requests with no span of their own join as
         *  tool rows. */
        buildTree(trace, opts = {}) {
            const spans = (trace && Array.isArray(trace.spans) ? trace.spans : []).filter(s => s && typeof s === 'object');
            const keyOf = new Map();
            const seen = {};
            spans.forEach((s, i) => {
                let k = this.spanKey(s, i);
                if (seen[k]) k = `${k}#${seen[k]++}`; else seen[k] = 1;
                keyOf.set(s, k);
            });
            const match = this.matchRequests(trace, opts.requests, { newest: opts.newest, keyOf });
            const grants = Array.isArray(opts.grants) ? opts.grants : [];
            const repeat = this.repeatKeys(spans, keyOf);
            const mk = (s, kind) => {
                const key = keyOf.get(s) || this.spanKey(s, 0);
                const n = { key, kind, span: s, children: [] };
                if (kind === 'tool') {
                    n.req = match.bySpan.get(key) || null;
                    n.repeat = repeat.has(key);
                    n.grant = n.req ? (grants.find(g => g && g.request_id === n.req.id) || null) : null;
                }
                return n;
            };
            const run = { key: 'run', kind: 'run', span: null, title: opts.title || 'Run', children: [] };
            const TS = root.TraceSteps;
            let steps;
            if (TS && TS.build) steps = TS.build(spans);
            else {
                steps = [];
                let cur = null;
                spans.slice().sort((a, b) => (this.ms(a.called_at) || 0) - (this.ms(b.called_at) || 0)).forEach(s => {
                    if (s.span_kind === 'generation') { cur = { gen: s, tools: [] }; steps.push(cur); return; }
                    if (!cur) { cur = { gen: null, tools: [] }; steps.push(cur); }
                    cur.tools.push(s);
                });
            }
            let turn = 0;
            const turns = [];
            steps.forEach(step => {
                if (step.gen) {
                    const g = mk(step.gen, 'llm');
                    g.turn = ++turn;
                    g.children = step.tools.map(t => mk(t, 'tool'));
                    run.children.push(g);
                    turns.push(g);
                } else {
                    step.tools.forEach(t => run.children.push(mk(t, 'tool')));
                }
            });
            match.orphans.forEach(r => {
                const s = { span_kind: 'tool_call', tool_id: r.tool_id, function_name: r.function_name,
                    args_preview: r.call_preview, called_at: r.requested_at, action: 'hold', _request: true };
                const n = { key: 'req:' + r.id, kind: 'tool', span: s, children: [], req: r, grant: null, repeat: false };
                const at = this.ms(r.requested_at);
                const owner = turns.filter(g => at != null && (this.ms(g.span.called_at) || 0) <= at).pop();
                (owner || run).children.push(n);
            });
            return run;
        },

        /** Every node, depth first. */
        walk(node, fn, parent) {
            fn(node, parent);
            (node.children || []).forEach(c => this.walk(c, fn, node));
        },

        find(rootNode, key) {
            let hit = null;
            let par = null;
            this.walk(rootNode, (n, p) => { if (!hit && n.key === key) { hit = n; par = p; } });
            return hit ? { node: hit, parent: par } : null;
        },

        countBelow(node) {
            let n = 0;
            (node.children || []).forEach(c => { n += 1 + this.countBelow(c); });
            return n;
        },

        /** Does a node match the active filter? Filters: all, tools, held,
         *  llm, egress, findings. */
        matchFilter(n, filter) {
            const d = this.decision(n);
            const s = n.span || {};
            switch (filter) {
                case 'tools': return n.kind === 'tool';
                case 'held': return !!d && (d.key === 'waiting' || d.key === 'blocked' || d.key === 'repeat');
                case 'llm': return n.kind === 'llm';
                case 'egress': return n.kind === 'tool' && !!(this.hostOf(s.args_preview) || this.hostOf(n.req && n.req.tool_id) || this.hostOf(n.req && n.req.call_preview));
                case 'findings': return n.kind === 'tool' && !!(s.detection_source || s.risk === 'secret' || s.action === 'log_only' || (s.risk && s.risk !== 'low' && s.risk !== 'none'));
                default: return true;
            }
        },

        matchSearch(n, q) {
            if (!q) return true;
            const s = n.span || {};
            const hay = [this.spanName(n), s.tool_id, s.function_name, s.args_preview, s.model, s.reason,
                s.span_id, s.row_hash, n.req && n.req.call_preview].filter(Boolean).join(' ').toLowerCase();
            return hay.includes(String(q).toLowerCase());
        },

        /** Rows to draw: depth, guide lines and caret state. With a filter
         *  or search, a node shows when it or a descendant matches, every
         *  ancestor stays for context, and collapse is ignored so a match is
         *  never hidden. Each row's `guides` says, per ancestor level below
         *  the run, whether that level's vertical line continues past it;
         *  `last` says whether its own connector ends here. */
        rows(rootNode, st = {}) {
            const filter = st.filter || 'all';
            const q = String(st.search || '').trim();
            const filtering = filter !== 'all' || !!q;
            const keep = (n) => {
                if (!filtering) return true;
                const self = n.kind !== 'run' && this.matchFilter(n, filter) && this.matchSearch(n, q);
                return self || (n.children || []).some(keep);
            };
            const collapsed = st.collapsed || {};
            const out = [];
            const visit = (n, depth, guides, last) => {
                const kids = (n.children || []).filter(keep);
                const expanded = filtering || !collapsed[n.key];
                out.push({ node: n, key: n.key, depth, guides, last, hasKids: kids.length > 0,
                    expanded, hidden: expanded ? 0 : this.countBelow(n),
                    match: !filtering || (n.kind !== 'run' && this.matchFilter(n, filter) && this.matchSearch(n, q)) });
                if (!expanded) return;
                kids.forEach((c, i) => visit(c, depth + 1, depth === 0 ? [] : guides.concat([!last]), i === kids.length - 1));
            };
            visit(rootNode, 0, [], true);
            return out;
        },

        // ------------------------------------------------------- waterfall

        /** Start and duration (ms) of a node; a waiting call runs to now. */
        timing(n, now) {
            const s = n.span || {};
            const start = this.ms(s.called_at);
            let dur = Number(s.duration_ms);
            if (!Number.isFinite(dur) || dur < 0) dur = 0;
            const d = this.decision(n);
            if (d && d.key === 'waiting' && start != null && now) dur = Math.max(dur, now - start);
            return { start, dur };
        },

        /** The relative axis: run start to the latest span end (or now while
         *  something waits), five ticks. */
        axis(rootNode, opts = {}) {
            let lo = this.ms(opts.started_at);
            let hi = this.ms(opts.ended_at);
            this.walk(rootNode, (n) => {
                if (n.kind === 'run') return;
                const t = this.timing(n, opts.now);
                if (t.start == null) return;
                if (lo == null || t.start < lo) lo = t.start;
                const end = t.start + t.dur;
                if (hi == null || end > hi) hi = end;
            });
            if (lo == null) lo = opts.now || 0;
            if (hi == null || hi < lo) hi = lo;
            const span = Math.max(1000, hi - lo);
            const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => ({ frac: f, label: f === 0 ? '0s' : this.fmtDur(span * f) }));
            return { start: lo, end: lo + span, span, ticks };
        },

        bar(n, ax, now) {
            if (n.kind === 'run') return { left: 0, width: 100 };
            const t = this.timing(n, now);
            if (t.start == null) return null;
            const left = Math.max(0, Math.min(100, ((t.start - ax.start) / ax.span) * 100));
            const width = Math.max(0.6, Math.min(100 - left, (t.dur / ax.span) * 100));
            return { left, width };
        },

        nodeTokens(n) {
            if (n.kind === 'llm') { const s = n.span; return Number(s.input_tokens || 0) + Number(s.output_tokens || 0); }
            if (n.kind === 'run') { let t = 0; this.walk(n, c => { if (c.kind === 'llm') t += this.nodeTokens(c); }); return t; }
            return 0;
        },

        nodeCost(n) {
            if (n.kind === 'llm') return n.span.cost != null ? Number(n.span.cost) : null;
            if (n.kind === 'run') {
                let c = 0, any = false;
                this.walk(n, x => { if (x.kind === 'llm' && x.span.cost != null) { c += Number(x.span.cost); any = true; } });
                return any ? c : null;
            }
            return null;
        },

        // ---------------------------------------------------- governance strip

        /** The five strip tiles from the session summary. Each tile names the
         *  span filter it applies. */
        /** The session's hosts: the network check's hosts plus hosts named in
         *  blocked tool calls (stopped by a tool rule before any connection). */
        egressHosts(gov) {
            const eg = (gov && gov.egress) || {};
            const hosts = (Array.isArray(eg.hosts) ? eg.hosts : []).map(h => Object.assign({}, h));
            const seen = new Set(hosts.map(h => String(h.host || '').toLowerCase()));
            const tool = {};
            ((gov && gov.blocked_calls) || []).forEach(b => {
                if (!b || b.kind === 'egress') return;
                const h = this.hostOf(b.args_preview);
                if (!h || seen.has(h.toLowerCase())) return;
                tool[h] = (tool[h] || 0) + 1;
            });
            Object.keys(tool).forEach(h => hosts.push({ host: h, calls: tool[h], status: 'tool' }));
            const count = (st) => hosts.filter(h => h.status === st).length;
            return { hosts, waiting: count('waiting'), blocked: count('blocked'), tool: count('tool') };
        },

        egressParts(eh) {
            const parts = [eh.waiting ? { t: `${eh.waiting} waiting`, tone: 'warn' } : null,
                eh.blocked ? { t: `${eh.blocked} blocked`, tone: 'bad' } : null,
                eh.tool ? { t: `${eh.tool} stopped by a tool rule`, tone: 'bad' } : null].filter(Boolean);
            return parts.length ? parts : [{ t: 'none blocked at the network check' }];
        },

        stripTiles(gov) {
            if (!gov) return [];
            const tc = gov.tool_calls || {};
            const eg = gov.egress || {};
            const f = gov.findings || {};
            const num = (v) => (Array.isArray(v) ? v.length : Number(v || 0));
            const secrets = num(f.secrets), threats = num(f.threats);
            const c = gov.cost || {};
            const cov = gov.coverage || {};
            const eh = this.egressHosts(gov);
            const sc = gov.score;
            const tiles = [
                { key: 'calls', label: 'Tool calls', value: String(Number(tc.total || 0)), filter: 'tools',
                    parts: [{ t: `${Number(tc.allowed || 0)} allowed` },
                        Number(tc.waiting) > 0 ? { t: `${Number(tc.waiting)} waiting`, tone: 'warn' } : null,
                        Number(tc.blocked) > 0 ? { t: `${Number(tc.blocked)} blocked`, tone: 'bad' } : null].filter(Boolean) },
                eg.visible === false
                    ? { key: 'egress', label: 'Egress', value: 'not checked', filter: 'egress', muted: true,
                        parts: [{ t: 'no egress view for this harness' }].concat(eh.tool ? [{ t: `${eh.tool} stopped by a tool rule`, tone: 'bad' }] : []),
                        title: 'This harness does not report its network destinations to SecureVector, so egress is not checked.' }
                    : { key: 'egress', label: 'Egress', value: `${eh.hosts.length} host${eh.hosts.length === 1 ? '' : 's'}`, filter: 'egress',
                        parts: this.egressParts(eh),
                        title: 'Network destinations this session reached, as the Guard saw them before each call.' },
                { key: 'cost', label: 'Cost', value: c.usd == null ? 'not recorded' : (this.fmtUsd(c.usd) || '$0.00'), filter: 'llm', muted: c.usd == null,
                    title: c.usd == null ? 'No cost was recorded for this session: only calls through the SecureVector proxy carry a price. Tokens come from the transcript.' : undefined,
                    parts: [{ t: `${this.fmtTok(c.tokens) || '0'} tokens` }] },
                { key: 'findings', label: 'Findings', value: String(secrets + threats), filter: 'findings',
                    parts: [{ t: secrets + threats ? `${secrets} secrets, ${threats} threats` : 'secrets, threats' }] },
                sc && typeof sc.score === 'number'
                    ? { key: 'score', label: 'Score', value: String(sc.score), filter: 'held',
                        tone: sc.score >= 70 ? 'bad' : null,
                        parts: [{ t: sc.band || sc.status || '' }].filter(p => p.t),
                        title: 'How unusual this session is next to your usual sessions, 0 to 100. 70 or more needs review.' }
                    : { key: 'score', label: 'Score', value: 'no score', filter: 'held', muted: true,
                        parts: [{ t: cov.enforced === 'before_call' ? 'not scored yet' : 'not enforced' }],
                        title: cov.enforced === 'before_call'
                            ? 'This session has no score yet.'
                            : 'Calls here are recorded after they run, so the session is not scored.' },
            ];
            return tiles;
        },

        // ------------------------------------------------------- approvals

        heldIds(req) {
            return String((req && req.held_by) || '').split(',').map(x => x.trim()).filter(Boolean);
        },

        /** Deny is the primary button when the effect is credentials leaving
         *  the machine: the credential-then-network rule held it, or its
         *  reason says a credential was read before a network call. */
        denyPrimary(req, span) {
            if (!req) return false;
            if (this.heldIds(req).includes('cred_then_net')) return true;
            const text = [req.justification, span && span.reason].filter(Boolean).join(' ').toLowerCase();
            return /credential|secret/.test(text) && /network|upload|send|leave|egress/.test(text);
        },

        effectText(req, span) {
            const ids = this.heldIds(req);
            if (this.denyPrimary(req, span)) return 'Credentials would leave this machine';
            if (ids.includes('outside_then_reach')) return 'Outside content could reach a credential or the network';
            const host = this.hostOf(req && req.tool_id);
            if (host) return `Opens a connection to ${host}`;
            if (ids.includes('step_up')) return 'Runs while the session is at step-up';
            return `Runs ${this.toolName(req || span)}`;
        },

        /** Which durations the panel offers: "once" only when the server held
         *  this exact call with its arguments (a fingerprint). */
        durations(req) {
            return this.DURATIONS.filter(d => d[0] !== 'once' || !!(req && req.call_fingerprint));
        },

        scopeText(sessionId, req, expiresAt) {
            const sid = this.short(sessionId) || 'this session';
            const fp = req && req.call_fingerprint ? ` (command ${String(req.call_fingerprint).slice(0, 4)}…)` : '';
            const exp = expiresAt ? ` Denied at ${this.clock(expiresAt)} if unanswered.` : '';
            return `Applies only to this command in session ${sid}${fp}.${exp}`;
        },

        /** "approved from the cloud by <user>" for a decision applied from
         *  SecureVector Cloud. */
        cloudDecisionText(req) {
            const who = String((req && req.decided_by) || 'a cloud user').slice(0, 120);
            return `${req && req.status === 'denied' ? 'denied' : 'approved'} from the cloud by ${who}`;
        },

        timedScopeText(sessionId, req) {
            return `15 min, 1 h and This session allow ${this.toolName(req)} in session ${this.short(sessionId) || 'this session'} only, never in another session.`;
        },

        /** Credential names in a call's preview (file names and variable
         *  names only; values are never shown). */
        dataNames(text) {
            const t = String(text || '');
            const out = [];
            const add = (x) => { if (x && !out.includes(x)) out.push(x); };
            (t.match(/(?:^|[\s@'"=\/])(\.env[\w.-]*|id_rsa|id_ed25519|\.npmrc|\.pypirc|\.netrc|credentials(?:\.json)?|[\w.-]+\.pem|[\w.-]+\.key)\b/g) || [])
                .forEach(m => add(m.replace(/^[\s@'"=\/]/, '')));
            (t.match(/\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|URL)[A-Z0-9_]*\b/g) || []).forEach(add);
            return out.slice(0, 8);
        },

        ruleText(req, span) {
            const ids = this.heldIds(req);
            const names = ids.map(id => this.HELD_RULES[id] || id);
            const src = req && req.rule_source;
            const source = src === 'synced' ? 'synced policy' : src === 'rung' ? 'step-up' : src === 'local' ? 'local policy' : (src || '');
            const version = req && (req.rule_version || req.policy_version);
            if (names.length) return { name: names.join('; '), id: ids.join(', '), version: version ? `v${version}` : '', source };
            const just = req && req.justification ? String(req.justification).replace(/^Held by rule:\s*/, '') : '';
            const rules = span && Array.isArray(span.detection_rules) ? span.detection_rules.join(', ') : '';
            return { name: just || (span && span.reason) || 'Tool permission', id: rules, version: version ? `v${version}` : '', source };
        },

        // ---------------------------------------------------------- render

        badge(d, extra) {
            if (!d) return '';
            const tone = d.key === 'waiting' ? 'warn' : (d.key === 'blocked' || d.key === 'repeat') ? 'bad' : 'ok';
            return `<span class="rt-badge ${tone}">${this.esc(d.label)}${extra ? ' · ' + this.esc(extra) : ''}</span>`;
        },

        copyBtn(text, label) {
            if (!text) return '';
            return `<button type="button" class="rt-copy" data-act="copy" data-copy="${this.esc(text)}" aria-label="${this.esc(label)}" title="${this.esc(label)}: ${this.esc(text)}"><span aria-hidden="true">⧉</span></button>`;
        },

        headerHtml(ctx) {
            const e = (s) => this.esc(s);
            const tr = ctx.trace || {};
            const st = ctx.status || 'ok';
            const rootNode = ctx.tree;
            const tok = this.nodeTokens(rootNode);
            const cost = this.nodeCost(rootNode);
            const nSpans = (tr.spans || []).length;
            const parts = [`<span class="rt-st ${e(st)}">${st === 'running' ? '<span class="rt-dot" aria-hidden="true"></span>' : ''}${e(st)}</span>`];
            const dur = ctx.durationMs != null ? this.fmtDur(ctx.durationMs) : '';
            if (dur) parts.push(e(dur));
            parts.push(`${nSpans} span${nSpans === 1 ? '' : 's'}`);
            if (tok) parts.push(`${this.fmtTok(tok)} tokens`);
            if (cost != null) parts.push(e(this.fmtUsd(cost)));
            else if (tok) parts.push('cost not recorded');
            // Decision summary.
            let waiting = 0, blocked = 0, repeat = false, soonest = null;
            this.walk(rootNode, n => {
                const d = this.decision(n);
                if (!d) return;
                if (d.key === 'waiting') {
                    waiting++;
                    const x = this.ms(ctx.expiryOf ? ctx.expiryOf(n.req) : null);
                    if (x != null && (soonest == null || x < soonest)) soonest = x;
                }
                if (d.key === 'blocked' || d.key === 'repeat') blocked++;
                if (d.key === 'repeat') repeat = true;
            });
            const dec = [];
            if (waiting) dec.push(`<span class="rt-warn">${waiting} waiting for approval${soonest != null ? ', expires ' + e(this.clock(soonest)) : ''}</span>`);
            if (blocked) dec.push(`<span class="rt-bad">${blocked} blocked${repeat ? ' · retried after a block' : ''}</span>`);
            if (dec.length) parts.push(dec.join(' · '));
            const cov = ctx.coverage || null;
            const unchecked = cov && Array.isArray(cov.unchecked) ? cov.unchecked : [];
            const covLabel = cov ? (cov.level === 'partial' ? 'partial' : cov.level === 'full' ? 'enforced before the call' : (cov.label || 'not enforced')) : '';
            const sess = [];
            if (tr.session_id) sess.push(`Session <span class="rt-mono">${e(this.short(tr.session_id))}</span>${this.copyBtn(tr.session_id, 'Copy session id')}`);
            if (ctx.harness) sess.push(e(ctx.harness));
            if (ctx.project) sess.push(`<span class="rt-mono">${e(ctx.project)}</span>`);
            if (tr.started_at) sess.push(`started ${e(this.clock(tr.started_at))}`);
            if (ctx.host) sess.push(e(ctx.host));
            if (ctx.user) sess.push(e(ctx.user));
            if (cov) {
                sess.push(unchecked.length && cov.level === 'partial'
                    ? `coverage: ${e(covLabel)}, <button type="button" class="rt-link" data-act="coverage">${unchecked.length} path${unchecked.length === 1 ? '' : 's'} not checked</button>: ${e(unchecked.join(', '))}`
                    : `coverage: ${e(covLabel)}`);
            }
            const nav = ctx.runTotal > 1
                ? `<span class="rt-runof">Run ${ctx.runIndex || '?'} of ${ctx.runTotal} in this session</span>` +
                  `<button type="button" class="rt-nav" data-act="run" data-run="${e(ctx.prevRun || '')}" aria-label="Previous run in this session"${ctx.prevRun ? '' : ' disabled'}>‹</button>` +
                  `<button type="button" class="rt-nav" data-act="run" data-run="${e(ctx.nextRun || '')}" aria-label="Next run in this session"${ctx.nextRun ? '' : ' disabled'}>›</button>`
                : '';
            const stop = ctx.canStop ? '<button type="button" class="rt-stop" data-act="stop">Stop session</button>' : '';
            return `<div class="rt-head">` +
                `<button type="button" class="rt-back" id="ar-back" data-act="back">← Observability</button>` +
                `<div class="rt-head-main">` +
                `<div class="rt-title-row"><h2 class="rt-title">${e(rootNode.title)}</h2>` +
                (tr.trace_id ? `<span class="rt-traceid"><span class="rt-mono">trace ${e(this.short(tr.trace_id, 12))}</span>${this.copyBtn(tr.trace_id, 'Copy trace id')}</span>` : '') +
                (ctx.extraHtml || '') + `</div>` +
                `<div class="rt-status">${parts.join(' · ')}</div>` +
                (sess.length ? `<div class="rt-sess">${sess.join(' · ')}</div>` : '') +
                `</div><div class="rt-head-side">${nav}${stop}</div></div>`;
        },

        stripHtml(gov, filter) {
            const tiles = this.stripTiles(gov);
            if (!tiles.length) return gov === null ? '' : '<div class="rt-gov rt-gov-loading" aria-busy="true"><div class="rt-gov-lbl">Governance · session</div><div class="rt-gov-wait">Loading the session summary…</div></div>';
            const e = (s) => this.esc(s);
            return '<div class="rt-gov" role="group" aria-label="Governance for this session"><div class="rt-gov-lbl">Governance · session</div>' +
                tiles.map(t => `<button type="button" class="rt-tile${t.muted ? ' muted' : ''}" data-act="tile" data-filter="${e(t.filter)}" aria-pressed="${filter === t.filter && filter !== 'all' ? 'true' : 'false'}"${t.title ? ` title="${e(t.title)}"` : ''}>` +
                    `<small>${e(t.label)}</small><b class="${t.tone ? 'rt-' + t.tone : ''}">${e(t.value)}</b>` +
                    `<small>${t.parts.map(p => `<span class="${p.tone ? 'rt-' + p.tone : ''}">${e(p.t)}</span>`).join(' · ')}</small></button>`).join('') +
                '</div>';
        },

        toolbarHtml(st, count) {
            const e = (s) => this.esc(s);
            return `<div class="rt-tools"><span class="rt-h">Trace</span><span class="rt-muted">${count} span${count === 1 ? '' : 's'}</span>` +
                `<input type="search" class="rt-search" data-act="search" placeholder="Search spans" aria-label="Search spans" value="${e(st.search || '')}">` +
                `<div class="rt-seg" role="group" aria-label="Show spans">` +
                this.SEGMENTS.map(([k, l]) => `<button type="button" data-act="seg" data-filter="${k}" aria-pressed="${(st.filter || 'all') === k ? 'true' : 'false'}">${e(l)}</button>`).join('') +
                `</div></div>`;
        },

        treeHtml(ctx, st) {
            const e = (s) => this.esc(s);
            const rows = this.rows(ctx.tree, st);
            const ax = this.axis(ctx.tree, { now: ctx.now, started_at: (ctx.trace || {}).started_at, ended_at: (ctx.trace || {}).ended_at });
            const head = `<div class="rt-tr rt-thead" aria-hidden="true"><span>Span</span><span class="num">Duration</span><span class="num">Tokens</span><span class="num">Cost</span>` +
                `<span class="rt-axis">${ax.ticks.map(t => `<i style="left:${t.frac * 100}%">${e(t.label)}</i>`).join('')}</span></div>`;
            if (rows.length <= 1 && (st.filter !== 'all' || st.search)) {
                return head + rows.map(r => this._rowHtml(r, ctx, st, ax)).join('') + '<div class="rt-empty">No spans match.</div>';
            }
            return head + rows.map(r => this._rowHtml(r, ctx, st, ax)).join('');
        },

        _rowHtml(r, ctx, st, ax) {
            const e = (s) => this.esc(s);
            const n = r.node;
            const d = this.decision(n);
            const t = this.timing(n, ctx.now);
            let durMs = n.kind === 'run' ? ctx.durationMs : t.dur;
            if (n.kind === 'tool' && !(Number(n.span.duration_ms) >= 0) && !(d && d.key === 'waiting')) durMs = null;
            const tok = this.nodeTokens(n);
            const cost = this.nodeCost(n);
            const b = this.bar(n, ax, ctx.now);
            const guides = r.guides.map(on => `<i class="rt-g${on ? ' on' : ''}" aria-hidden="true"></i>`).join('') +
                (r.depth > 0 ? `<i class="rt-c${r.last ? ' last' : ''}" aria-hidden="true"></i>` : '');
            const caret = r.hasKids || r.hidden
                ? `<button type="button" class="rt-caret" data-act="caret" data-key="${e(n.key)}" aria-expanded="${r.expanded ? 'true' : 'false'}" aria-label="${r.expanded ? 'Collapse' : 'Expand'} ${e(this.spanName(n))}">${this.CARET_SVG}</button>`
                : '<span class="rt-caret-sp" aria-hidden="true"></span>';
            const sel = st.sel === n.key;
            const tone = d ? (d.key === 'waiting' ? 'warn' : (d.key === 'blocked' || d.key === 'repeat') ? 'bad' : '') : '';
            return `<div class="rt-tr rt-row${sel ? ' sel' : ''}${tone ? ' ' + tone : ''}${r.match ? '' : ' ctx'}" data-key="${e(n.key)}">` +
                `<span class="rt-name">${guides}${caret}<button type="button" class="rt-pick" data-act="pick" data-key="${e(n.key)}"${sel ? ' aria-current="true"' : ''}>` +
                `<span class="rt-chip">${n.kind}</span><span class="rt-nm" title="${e(this.spanName(n))}">${e(this.spanName(n))}</span></button>` +
                (d ? this.badge(d) : '') + (r.hidden ? `<span class="rt-muted rt-hid">${r.hidden} hidden</span>` : '') + `</span>` +
                `<span class="num">${e(this.fmtDur(durMs))}</span><span class="num">${e(this.fmtTok(tok))}</span><span class="num">${cost != null ? e(this.fmtUsd(cost)) : ''}</span>` +
                `<span class="rt-wf">${b ? `<i class="rt-bar ${n.kind}${tone ? ' ' + tone : ''}" style="left:${b.left.toFixed(2)}%;width:${b.width.toFixed(2)}%"></i>` : ''}</span></div>`;
        },

        _dl(rows) {
            return '<dl class="rt-dl">' + rows.filter(Boolean).map(([k, v, cls]) => `<dt>${this.esc(k)}</dt><dd${cls ? ` class="${cls}"` : ''}>${v}</dd>`).join('') + '</dl>';
        },

        /** The selected span's detail. Decision controls appear only for a
         *  span waiting for approval, and only here. */
        spanPanelHtml(ctx, found) {
            const e = (s) => this.esc(s);
            const n = found.node;
            const par = found.parent;
            const s = n.span || {};
            const d = this.decision(n);
            const req = n.req;
            const close = '<button type="button" class="rt-x" data-act="unpick" aria-label="Close span detail, show session governance">×</button>';
            if (n.kind === 'run') {
                return `<div class="rt-ph"><h3>${e(n.title)}</h3>${close}</div>` + this._dl([
                    ['Spans', String((ctx.trace.spans || []).length)],
                    ['Started', e(this.clock(ctx.trace.started_at, true))],
                    ['Trace id', `<span class="rt-mono">${e(this.short(ctx.trace.trace_id, 12))}…</span>${this.copyBtn(ctx.trace.trace_id, 'Copy trace id')}`],
                ]);
            }
            if (n.kind === 'llm') {
                return `<div class="rt-ph"><h3>${e(s.model || 'Model turn')}</h3>${close}</div>` + this._dl([
                    ['Turn', String(n.turn || '')],
                    ['Tokens', `${Number(s.input_tokens || 0).toLocaleString()} in · ${Number(s.output_tokens || 0).toLocaleString()} out`],
                    ['Cost', s.cost != null ? e(this.fmtUsd(s.cost)) : 'price not known'],
                    ['Duration', e(this.fmtDur(Number(s.duration_ms)) || 'not recorded')],
                    ['Tool calls', String((n.children || []).length)],
                    ['Started', `<span class="rt-mono">${e(this.clock(s.called_at, true))}</span>`],
                    s.span_id ? ['Span id', `<span class="rt-mono">${e(this.short(s.span_id, 12))}…</span>${this.copyBtn(s.span_id, 'Copy span id')}`] : null,
                ]);
            }
            const expiry = req && ctx.expiryOf ? ctx.expiryOf(req) : null;
            const rawCmd = (req && req.call_preview) || s.args_preview || '';
            const cmd = this.previewText(rawCmd);
            // A held call names the rule that held it; a plain block names
            // its detection rules when it has any, and its reason below.
            const rule = req ? this.ruleText(req, s)
                : (Array.isArray(s.detection_rules) && s.detection_rules.length ? { name: s.detection_rules.join(', '), id: '', version: '', source: '' } : null);
            const names = this.dataNames(cmd);
            const host = this.hostOf(req && req.tool_id) || this.hostOf(cmd);
            const cov = ctx.coverage || null;
            const unchecked = cov && Array.isArray(cov.unchecked) ? cov.unchecked : [];
            const waiting = d && d.key === 'waiting';
            const badgeExtra = waiting && expiry ? `expires ${this.clock(expiry)}` : '';
            let html = `<div class="rt-ph"><h3>${e(this.toolName(s))}</h3>${d ? this.badge(d, badgeExtra) : ''}${close}</div>`;
            if (cmd) html += `<pre class="rt-cmd">${e(cmd)}</pre>`;
            if (rawCmd && String(rawCmd) !== String(cmd)) html += `<details class="rt-raw"><summary>Raw arguments</summary><pre class="rt-cmd">${e(rawCmd)}</pre></details>`;
            html += this._dl([
                rule ? ['Rule', `${e(rule.name)}${rule.id ? ` <span class="rt-mono">${e(rule.id)}${rule.version ? ' ' + e(rule.version) : ''}</span>` : ''}${rule.source ? ` · ${e(rule.source)}` : ''}`, waiting || (d && d.key !== 'used') ? 'rt-warn-t' : ''] : null,
                !req && s.reason ? ['Reason', e(s.reason)] : null,
                names.length ? ['Data', `<span class="rt-mono">${names.map(e).join(', ')}</span> <span class="rt-muted">(values hidden)</span>`] : null,
                host ? ['Destination', `<span class="rt-mono">${e(host)}</span>`] : null,
                req ? ['Effect', e(this.effectText(req, s))] : null,
                cov && cov.level !== 'full' && (req || d) ? ['Coverage', cov.level === 'partial'
                    ? `Partial: ${waiting ? 'approving with ' : ''}${unchecked.length} path${unchecked.length === 1 ? '' : 's'} in this session not checked`
                    : e(cov.label || 'not enforced'), 'rt-warn-t'] : null,
                req ? ['Asked', `${e(ctx.user || 'you')}, on ${e(ctx.host || 'this machine')} (Approvals)`] : null,
                req && req.decision_source === 'cloud' && (req.status === 'approved' || req.status === 'denied')
                    ? ['Decided', e(this.cloudDecisionText(req))] : null,
            ]);
            if (waiting) {
                const primaryDeny = this.denyPrimary(req, s);
                const busy = this.state(ctx.trace.trace_id).busy ? ' disabled' : '';
                html += `<div class="rt-actions" role="group" aria-label="Decide this held call">` +
                    `<button type="button" class="rt-btn${primaryDeny ? ' primary' : ''}" data-act="deny" data-req="${e(req.id)}"${busy}>Deny</button>` +
                    this.durations(req).map(([k, l]) => `<button type="button" class="rt-btn${!primaryDeny && k === 'once' ? ' primary' : ''}" data-act="approve" data-dur="${k}" data-req="${e(req.id)}"${busy}>${e(l)}</button>`).join('') +
                    `</div><p class="rt-scope">${e(this.scopeText(ctx.trace.session_id, req, expiry))}</p>` +
                    `<p class="rt-scope">${e(this.timedScopeText(ctx.trace.session_id, req))}</p>`;
                if (!req.call_fingerprint) html += '<p class="rt-scope rt-muted">Allow once is not offered: the held call\'s arguments were not recorded.</p>';
            } else if (d && (d.key === 'used' || d.key === 'once' || d.key === 'approved') && n.grant) {
                html += this._dl([
                    ['Approval', `${e(d.label)}, scoped to session <span class="rt-mono">${e(this.short(ctx.trace.session_id))}</span>`],
                    n.grant.used_at ? ['Used', e(this.clock(n.grant.used_at, true))] : null,
                ]);
            }
            html += '<hr class="rt-hr">' + this._dl([
                ['Started', `<span class="rt-mono">${e(this.clock(s.called_at, true))}</span>`],
                (s.span_id || s.row_hash) ? ['Span id', `<span class="rt-mono">${e(this.short(s.span_id || s.row_hash, 12))}…</span>${this.copyBtn(s.span_id || s.row_hash, 'Copy span id')}`] : null,
                par ? ['Parent', e(this.spanName(par))] : null,
            ]);
            return html;
        },

        /** Nothing selected: the session governance summary. */
        govPanelHtml(ctx, gov) {
            const e = (s) => this.esc(s);
            let html = '<div class="rt-ph"><h3>Session governance</h3><span class="rt-muted">select a span for its details</span></div>';
            if (gov === null || gov === undefined) return html + '<p class="rt-muted">Loading…</p>';
            if (gov === false) return html + '<p class="rt-muted">No governance summary for this session.</p>';
            const tc = gov.tool_calls || {};
            const blocked = Array.isArray(gov.blocked_calls) ? gov.blocked_calls : [];
            const runIdx = ctx.runIndexOf || (() => null);
            html += this._dl([['Tool calls', `${Number(tc.total || 0)} · ${Number(tc.allowed || 0)} allowed${Number(tc.waiting) ? ` · <span class="rt-warn">${Number(tc.waiting)} waiting</span>` : ''}${Number(tc.blocked) ? ` · <span class="rt-bad">${Number(tc.blocked)} blocked</span>` : ''}`]]);
            if (blocked.length) {
                html += '<ul class="rt-blist">' + blocked.slice(0, 8).map(b => {
                    const n = runIdx(b.trace_id);
                    const label = `${b.tool_id || 'call'}${b.args_preview ? ' ' + String(b.args_preview).slice(0, 60) : ''}${n ? ' · Run ' + n : ''}${b.repeat_attempt ? ' · repeat attempt' : ''}`;
                    return `<li><button type="button" class="rt-link rt-bad" data-act="goto" data-trace="${e(b.trace_id || '')}" data-span="${e(b.span_id || '')}"><span aria-hidden="true">✕</span> ${e(label)}</button></li>`;
                }).join('') + (blocked.length > 8 ? `<li class="rt-muted">${blocked.length - 8} more</li>` : '') + '</ul>';
            }
            const eg = gov.egress || {};
            const eh = this.egressHosts(gov);
            const hosts = eg.visible === false ? eh.hosts.filter(h => h.status === 'tool') : eh.hosts;
            html += '<hr class="rt-hr">';
            if (eg.visible === false) html += this._dl([['Egress', 'not checked: this harness has no egress view']]);
            {
                if (eg.visible !== false) html += this._dl([['Egress', `${hosts.length} host${hosts.length === 1 ? '' : 's'} · ` + this.egressParts(eh).map(p => `<span class="${p.tone ? 'rt-' + p.tone : ''}">${e(p.t)}</span>`).join(' · ')]]);
                const ordered = hosts.slice().sort((a, b) => (a.status === 'allowed') - (b.status === 'allowed') || (b.calls || 0) - (a.calls || 0));
                const shown = ctx.allHosts ? ordered : ordered.slice(0, this.HOSTS_SHOWN);
                if (shown.length) {
                    html += '<ul class="rt-hosts">' + shown.map(h => `<li class="${h.status === 'blocked' || h.status === 'tool' ? 'rt-bad' : h.status === 'waiting' ? 'rt-warn' : ''}"><span class="rt-mono">${e(h.host)}</span><span>${h.status === 'allowed' ? `${Number(h.calls || 0)} call${Number(h.calls) === 1 ? '' : 's'}` : e(h.status === 'waiting' ? 'waiting for approval' : h.status === 'tool' ? 'stopped by a tool rule' : h.status)}</span></li>`).join('') + '</ul>';
                }
                if (!ctx.allHosts && ordered.length > shown.length) html += `<button type="button" class="rt-link" data-act="hosts">${ordered.length - shown.length} more host${ordered.length - shown.length === 1 ? '' : 's'}</button>`;
            }
            const c = gov.cost || {};
            const f = gov.findings || {};
            const num = (v) => (Array.isArray(v) ? v.length : Number(v || 0));
            const sc = gov.score;
            const cov = gov.coverage || ctx.coverage || {};
            const unchecked = Array.isArray(cov.unchecked) ? cov.unchecked : [];
            html += '<hr class="rt-hr">' + this._dl([
                ['Cost', `${c.usd == null ? 'not recorded' : e(this.fmtUsd(c.usd) || '$0.00')} · ${e(this.fmtTok(c.tokens) || '0')} tokens${(c.models || []).length ? ' · ' + e(c.models.join(', ')) : ''}`],
                ['Findings', `${num(f.secrets)} secrets, ${num(f.threats)} threats`],
                ['Score', sc && typeof sc.score === 'number'
                    ? `${sc.score}${sc.band ? ' ' + e(sc.band) : ''}${Array.isArray(sc.reasons) && sc.reasons.length ? ' · ' + e(sc.reasons.join(', ')) : ''}`
                    : `no score${cov.enforced === 'before_call' ? ' yet' : ': not enforced'}`],
            ]);
            html += `<hr class="rt-hr"><div id="rt-cov">` + this._dl([
                ['Coverage', e(cov.enforced === 'before_call' ? (cov.level === 'partial' ? 'Partial: enforced before each call' : 'Enforced before each call') : (cov.label || 'not enforced'))],
                unchecked.length ? ['Not checked', e(unchecked.join(' · ')), 'rt-warn-t'] : null,
            ]) + '</div>';
            const ap = gov.approvals || {};
            const grants = (Array.isArray(ap.grants) ? ap.grants : []);
            const pend = Array.isArray(ap.pending) ? ap.pending : [];
            if (!grants.length && !pend.length) html += this._dl([['Approvals', 'None active']]);
            else {
                html += this._dl([['Approvals', `${grants.filter(g => g.state === 'active').length} active${pend.length ? ` · <span class="rt-warn">${pend.length} waiting</span>` : ''}`]]);
                html += '<ul class="rt-grants">' + grants.map(g => {
                    const d = this.DURATIONS.find(x => x[0] === g.duration);
                    const what = `${g.tool_id || 'tool'}${g.call_preview ? ' · ' + String(g.call_preview).slice(0, 60) : ''}`;
                    const state = g.state === 'used' ? 'used' : g.state === 'revoked' ? 'revoked' : (d ? d[1] : g.duration) + (g.expires_at ? `, until ${this.clock(g.expires_at)}` : '');
                    return `<li><span class="rt-mono">${e(what)}</span><span class="rt-muted">${e(state)}</span>` +
                        (g.state === 'active' ? `<button type="button" class="rt-btn sm" data-act="revoke" data-grant="${e(g.id)}">Revoke</button>` : '') + '</li>';
                }).join('') + '</ul>';
                html += '<p class="rt-scope">Every approval here applies only to this session.</p>';
            }
            return html;
        },

        // ----------------------------------------------------------- mount

        /** Draw the view into `box` and wire it. `ctx` carries the trace,
         *  the tree inputs and the callbacks (onBack, onOpenRun, onStop,
         *  onDecide, onRevoke, onGoto, onPause, onTerminal). */
        mount(box, ctx) {
            this.injectStyle();
            const st = this.state(ctx.trace.trace_id);
            ctx.tree = this.buildTree(ctx.trace, { requests: ctx.requests, grants: ctx.grants, newest: ctx.newest, title: ctx.title });
            if (st.sel && !this.find(ctx.tree, st.sel)) {
                // A span named by its id may be keyed by its row hash.
                const alt = /^s:/.test(st.sel) ? 'h:' + st.sel.slice(2) : null;
                st.sel = alt && this.find(ctx.tree, alt) ? alt : null;
            }
            box._rt = ctx;
            box.innerHTML = this.headerHtml(ctx) +
                `<div class="rt-strip" data-part="strip">${this.stripHtml(ctx.gov, st.filter)}</div>` +
                `<div class="rt-body"><section class="rt-main" aria-label="Spans">${this.toolbarHtml(st, (ctx.trace.spans || []).length)}` +
                `<div class="rt-tree" data-part="tree" role="list">${this.treeHtml(ctx, st)}</div></section>` +
                `<aside class="rt-panel" data-part="panel" aria-label="Span detail" aria-live="polite">${this._panel(ctx, st)}</aside></div>`;
            if (!box._rtWired) {
                box._rtWired = true;
                box.addEventListener('click', (ev) => this._onClick(box, ev));
                box.addEventListener('input', (ev) => {
                    const t = ev.target;
                    if (!t || t.dataset.act !== 'search') return;
                    const c = box._rt;
                    this.state(c.trace.trace_id).search = t.value;
                    this.paint(box);
                });
            }
        },

        _panel(ctx, st) {
            const found = st.sel ? this.find(ctx.tree, st.sel) : null;
            return found ? this.spanPanelHtml(ctx, found) : this.govPanelHtml(ctx, ctx.gov);
        },

        /** Repaint the strip, tree and panel (not the toolbar, so the search
         *  box keeps focus). */
        paint(box) {
            const ctx = box._rt;
            if (!ctx) return;
            const st = this.state(ctx.trace.trace_id);
            const q = (sel) => box.querySelector(`[data-part="${sel}"]`);
            const strip = q('strip'), tree = q('tree'), panel = q('panel');
            if (strip) strip.innerHTML = this.stripHtml(ctx.gov, st.filter);
            if (tree) tree.innerHTML = this.treeHtml(ctx, st);
            if (panel) panel.innerHTML = this._panel(ctx, st);
            box.querySelectorAll('.rt-seg [data-filter]').forEach(b => b.setAttribute('aria-pressed', b.dataset.filter === st.filter ? 'true' : 'false'));
        },

        /** New data arrived (governance summary, requests, grants): rebuild
         *  the tree and redraw, keeping selection, filter and collapse. */
        update(box, patch) {
            const ctx = box && box._rt;
            if (!ctx) return;
            Object.assign(ctx, patch || {});
            const st = this.state(ctx.trace.trace_id);
            const search = box.querySelector('.rt-search');
            const focused = search && root.document && root.document.activeElement === search;
            this.mount(box, ctx);
            if (focused) { const s = box.querySelector('.rt-search'); if (s) { s.focus(); s.setSelectionRange && s.setSelectionRange(st.search.length, st.search.length); } }
        },

        select(box, key) {
            const ctx = box && box._rt;
            if (!ctx) return;
            this.state(ctx.trace.trace_id).sel = key;
            this.paint(box);
        },

        _onClick(box, ev) {
            const ctx = box._rt;
            if (!ctx) return;
            const pause = ev.target.closest && ev.target.closest('.ar-live-pause');
            if (pause) { if (ctx.onPause) ctx.onPause(pause); return; }
            const term = ev.target.closest && ev.target.closest('.ar-terminal-open');
            if (term) { ev.stopPropagation(); if (ctx.onTerminal) ctx.onTerminal(); return; }
            const el = ev.target.closest && ev.target.closest('[data-act]');
            if (!el || !box.contains(el)) return;
            const st = this.state(ctx.trace.trace_id);
            const act = el.dataset.act;
            switch (act) {
                case 'back': if (ctx.onBack) ctx.onBack(); break;
                case 'run': if (el.dataset.run && ctx.onOpenRun) ctx.onOpenRun(el.dataset.run); break;
                case 'stop': if (ctx.onStop) ctx.onStop(); break;
                case 'copy': this._copy(el); break;
                case 'caret': {
                    const k = el.dataset.key;
                    st.collapsed[k] = !st.collapsed[k];
                    this.paint(box);
                    const again = box.querySelector(`.rt-caret[data-key="${this._cssEsc(k)}"]`);
                    if (again) again.focus();
                    break;
                }
                case 'pick': st.sel = el.dataset.key; this.paint(box); break;
                case 'unpick': st.sel = null; this.paint(box); break;
                case 'seg':
                case 'tile': {
                    const f = el.dataset.filter || 'all';
                    st.filter = act === 'tile' && st.filter === f ? 'all' : f;
                    this.paint(box);
                    break;
                }
                case 'coverage': {
                    st.sel = null;
                    this.paint(box);
                    const c = box.querySelector('#rt-cov');
                    if (c && c.scrollIntoView) c.scrollIntoView({ block: 'nearest' });
                    break;
                }
                case 'hosts': ctx.allHosts = true; this.paint(box); break;
                case 'goto': {
                    const tid = el.dataset.trace, sid = el.dataset.span;
                    if (tid && tid !== ctx.trace.trace_id) { if (ctx.onGoto) ctx.onGoto(tid, sid); break; }
                    let key = null;
                    this.walk(ctx.tree, n => { const s = n.span || {}; if (!key && sid && (s.span_id === sid || s.row_hash === sid)) key = n.key; });
                    if (key) { st.sel = key; st.filter = 'all'; st.search = ''; this.paint(box); }
                    break;
                }
                case 'approve':
                case 'deny': {
                    if (st.busy || !ctx.onDecide) break;
                    const found = this.find(ctx.tree, st.sel);
                    const req = found && found.node.req;
                    if (!req || req.id !== el.dataset.req) break;
                    ctx.onDecide(act, req, el.dataset.dur || null);
                    break;
                }
                case 'revoke': if (ctx.onRevoke && !el.disabled) { el.disabled = true; ctx.onRevoke(el.dataset.grant, el); } break;
                default: break;
            }
        },

        _cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); },

        _copy(btn) {
            const text = btn.dataset.copy || '';
            const face = btn.innerHTML;
            const done = () => { btn.textContent = 'copied'; setTimeout(() => { btn.innerHTML = face; }, 1200); };
            try {
                const nav = root.navigator;
                if (nav && nav.clipboard && nav.clipboard.writeText) nav.clipboard.writeText(text).then(done, () => {});
            } catch (_) { /* clipboard blocked: the id stays in the tooltip */ }
        },

        injectStyle() {
            const doc = root.document;
            if (!doc || !doc.getElementById || doc.getElementById('rt-style')) return;
            const s = doc.createElement('style');
            s.id = 'rt-style';
            s.textContent = `
.rt { display:flex; flex-direction:column; gap:12px; color:var(--text-primary); }
.rt-mono { font-family:ui-monospace,'SF Mono',Menlo,monospace; }
.rt-muted { color:var(--text-muted); }
.rt-warn, .rt-warn-t { color:var(--warning-text); }
.rt-bad { color:color-mix(in srgb, var(--danger) 55%, var(--text-primary)); }
.rt-head { display:flex; align-items:flex-start; gap:16px; padding-bottom:12px; border-bottom:1px solid var(--border-default); }
.rt-back, .rt-nav, .rt-stop, .rt-btn { font:inherit; font-size:13px; min-height:34px; padding:6px 12px; border-radius:6px;
  border:1px solid var(--border-default); background:var(--bg-card); color:var(--text-secondary); cursor:pointer; white-space:nowrap; }
.rt-back:hover, .rt-nav:hover:not(:disabled), .rt-btn:hover:not(:disabled) { color:var(--text-primary); border-color:var(--accent-primary); }
.rt-nav { padding:6px 10px; }
.rt-nav:disabled { opacity:.45; cursor:default; }
.rt-stop { border-color:color-mix(in srgb, var(--danger) 55%, var(--border-default)); color:color-mix(in srgb, var(--danger) 55%, var(--text-primary)); }
.rt-head-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:4px; }
.rt-head-side { display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
.rt-runof { font-size:13px; color:var(--text-secondary); }
.rt-title-row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.rt-title { margin:0; font-size:19px; font-weight:650; overflow-wrap:anywhere; }
.rt-traceid { display:inline-flex; align-items:center; gap:4px; font-size:12px; padding:2px 8px; border:1px solid var(--border-default); border-radius:6px; background:var(--bg-card); color:var(--text-secondary); }
.rt-copy { font:inherit; font-size:12px; background:none; border:0; color:var(--text-muted); cursor:pointer; padding:0 3px; }
.rt-copy:hover { color:var(--accent-primary); }
.rt-status { font-size:13px; color:var(--text-secondary); }
.rt-st.running { color:var(--text-primary); }
.rt-dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--accent-primary); margin-right:5px; vertical-align:0; }
.rt-sess { font-size:12.5px; color:var(--text-muted); overflow-wrap:anywhere; }
.rt-link { font:inherit; background:none; border:0; padding:0; color:var(--accent-primary); text-decoration:underline; cursor:pointer; text-align:left; }
.rt-link.rt-bad { color:color-mix(in srgb, var(--danger) 55%, var(--text-primary)); }
.rt-gov { display:flex; flex-wrap:wrap; align-items:stretch; border:1px solid var(--accent-secondary); border-radius:8px; overflow:hidden;
  background:color-mix(in srgb, var(--accent-primary) 6%, var(--bg-primary)); }
.rt-gov-lbl { display:flex; align-items:center; padding:0 14px; font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--accent-primary);
  border-right:1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent); background:color-mix(in srgb, var(--accent-primary) 12%, var(--bg-primary)); }
.rt-gov-wait { padding:12px 16px; font-size:12px; color:var(--text-muted); }
.rt-tile { font:inherit; display:flex; flex-direction:column; gap:2px; align-items:flex-start; padding:8px 16px; min-height:44px; border:0;
  border-right:1px solid color-mix(in srgb, var(--accent-primary) 22%, transparent); background:none; color:var(--text-primary); cursor:pointer; text-align:left; }
.rt-tile:hover, .rt-tile[aria-pressed="true"] { background:color-mix(in srgb, var(--accent-primary) 14%, var(--bg-primary)); }
.rt-tile[aria-pressed="true"] { box-shadow:inset 0 -2px 0 var(--accent-primary); }
.rt-tile b { font-size:15px; font-weight:650; }
.rt-tile small { font-size:11px; color:var(--text-muted); }
.rt-tile.muted b { color:var(--text-secondary); font-weight:500; }
.rt-body { display:grid; grid-template-columns:minmax(0,1fr) 320px; gap:18px; align-items:start; }
.rt-main { min-width:0; display:flex; flex-direction:column; gap:10px; }
.rt-tools { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.rt-h { font-weight:650; font-size:14px; }
.rt-search { font:inherit; font-size:13px; min-height:34px; padding:6px 10px; width:220px; border-radius:6px; border:1px solid var(--border-default); background:var(--bg-card); color:var(--text-primary); }
.rt-seg { display:flex; margin-left:auto; border:1px solid var(--border-default); border-radius:6px; overflow:hidden; }
.rt-seg button { font:inherit; font-size:13px; min-height:34px; padding:6px 14px; border:0; background:var(--bg-card); color:var(--text-secondary); cursor:pointer; }
.rt-seg button[aria-pressed="true"] { background:color-mix(in srgb, var(--accent-primary) 18%, var(--bg-card)); color:var(--text-primary); }
.rt-tree { border:1px solid var(--border-default); border-radius:8px; background:var(--bg-card); overflow:hidden; }
.rt-tr { display:grid; grid-template-columns:minmax(0,2.4fr) 58px 48px 54px minmax(100px,1fr); gap:10px; align-items:center; min-height:34px; padding:0 14px 0 8px;
  border-bottom:1px solid var(--border-default); font-size:13px; }
.rt-thead { font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); min-height:30px; }
.rt-tr .num { text-align:right; font-variant-numeric:tabular-nums; color:var(--text-secondary); }
.rt-axis { position:relative; height:14px; text-transform:none; letter-spacing:0; }
.rt-axis i { position:absolute; top:0; transform:translateX(-50%); font-style:normal; white-space:nowrap; }
.rt-axis i:first-child { transform:none; }
.rt-axis i:last-child { transform:translateX(-100%); }
.rt-row:hover { background:var(--bg-hover); }
.rt-row.sel { background:color-mix(in srgb, var(--accent-primary) 10%, var(--bg-card)); box-shadow:inset 3px 0 0 var(--accent-primary); }
.rt-row.ctx { opacity:.6; }
.rt-name { display:flex; align-items:stretch; min-width:0; align-self:stretch; gap:0; overflow:hidden; }
/* One level is 24px, the caret's width, so a guide sits under its
   parent's caret centre (12px). */
.rt-g, .rt-c { position:relative; flex:0 0 24px; display:block; }
.rt-g.on::before, .rt-c::before { content:''; position:absolute; left:12px; top:0; bottom:0; border-left:1px solid var(--border-light); }
.rt-c.last::before { bottom:50%; }
.rt-c::after { content:''; position:absolute; left:12px; right:2px; top:50%; border-top:1px solid var(--border-light); }
.rt-caret, .rt-caret-sp { flex:0 0 24px; align-self:center; }
.rt-caret { font:inherit; width:24px; height:24px; display:inline-flex; align-items:center; justify-content:center; background:none; border:0; border-radius:4px;
  color:var(--text-secondary); cursor:pointer; padding:0; }
.rt-caret:hover { background:var(--bg-hover); color:var(--text-primary); }
.rt-caret svg { transition:transform .12s ease; }
.rt-caret[aria-expanded="true"] svg { transform:rotate(90deg); }
.rt-pick { font:inherit; display:flex; align-items:center; gap:8px; min-width:0; background:none; border:0; padding:0 4px; color:var(--text-primary); cursor:pointer; text-align:left; }
.rt-nm { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.rt-chip { font-family:ui-monospace,'SF Mono',Menlo,monospace; font-size:11px; padding:0 6px; border:1px solid var(--border-light); border-radius:4px; color:var(--text-secondary); flex:none; }
.rt-badge { align-self:center; flex:none; font-size:12px; padding:1px 7px; border-radius:4px; white-space:nowrap; margin-left:6px; }
.rt-badge.warn { background:var(--warning-chip-bg); border:1px solid var(--warning-chip-border); color:var(--warning-text); }
.rt-badge.bad { background:color-mix(in srgb, var(--danger) 14%, transparent); border:1px solid color-mix(in srgb, var(--danger) 45%, transparent); color:color-mix(in srgb, var(--danger) 55%, var(--text-primary)); }
.rt-badge.ok { border:1px solid var(--border-light); color:var(--text-secondary); }
.rt-hid { align-self:center; font-size:12px; margin-left:8px; white-space:nowrap; }
.rt-wf { position:relative; height:10px; }
.rt-bar { position:absolute; top:2px; height:6px; border-radius:3px; background:var(--text-muted); opacity:.55; }
.rt-bar.run { background:var(--border-light); opacity:1; }
.rt-bar.tool { background:var(--accent-primary); opacity:.8; }
.rt-bar.warn { background:var(--warning); opacity:.9; }
.rt-bar.bad { background:var(--danger); opacity:.9; }
.rt-empty { padding:14px; color:var(--text-muted); font-size:13px; }
.rt-panel { position:sticky; top:8px; border-left:1px solid var(--border-default); padding:0 0 88px 18px; font-size:13px; max-height:calc(100vh - 120px); overflow:auto; }
.rt-ph { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:4px 0 10px; }
.rt-ph h3 { margin:0; font-size:15px; font-weight:650; flex:1 1 auto; min-width:0; overflow-wrap:anywhere; }
.rt-ph > .rt-muted { flex:1 0 100%; font-size:12px; }
.rt-ph .rt-badge { margin-left:0; }
.rt-x { font:inherit; font-size:16px; background:none; border:0; color:var(--text-muted); cursor:pointer; padding:0 4px; }
.rt-cmd { margin:0 0 12px; padding:8px 10px; border:1px solid var(--border-default); border-radius:6px; background:var(--bg-primary);
  font-family:ui-monospace,'SF Mono',Menlo,monospace; font-size:12px; white-space:pre-wrap; overflow-wrap:anywhere; }
.rt-dl { display:grid; grid-template-columns:100px minmax(0,1fr); gap:8px 12px; margin:0 0 10px; }
.rt-dl dt { color:var(--text-muted); }
.rt-dl dd { margin:0; overflow-wrap:anywhere; }
.rt-hr { border:0; border-top:1px solid var(--border-default); margin:12px 0; }
.rt-actions { display:flex; flex-wrap:wrap; gap:8px; margin:8px 0; }
.rt-btn.primary { border-color:var(--accent-primary); background:color-mix(in srgb, var(--accent-primary) 18%, var(--bg-card)); color:var(--text-primary); }
.rt-btn.sm { min-height:26px; padding:2px 8px; font-size:12px; }
.rt-btn:disabled { opacity:.5; cursor:default; }
.rt-scope { margin:4px 0; font-size:12.5px; color:var(--text-secondary); }
.rt-blist, .rt-hosts, .rt-grants { list-style:none; margin:0 0 8px; padding:0; display:flex; flex-direction:column; gap:6px; }
.rt-hosts li, .rt-grants li { display:flex; justify-content:space-between; gap:10px; align-items:center; }
.rt-hosts li .rt-mono { overflow:hidden; text-overflow:ellipsis; }
.rt-grants li .rt-mono { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.rt-raw { margin:0 0 12px; font-size:12px; color:var(--text-muted); }
.rt-raw summary { cursor:pointer; }
.rt-raw .rt-cmd { margin-top:6px; }
.rt-legacy-h { margin:8px 0 0; font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); font-weight:600; }
@media (max-width: 1600px) { .rt-axis i:nth-child(2), .rt-axis i:nth-child(4) { display:none; } }
@media (max-width: 1100px) { .rt-body { grid-template-columns:minmax(0,1fr); } .rt-panel { position:static; border-left:0; border-top:1px solid var(--border-default); padding:12px 0 0; max-height:none; padding-bottom:88px; } }
@media (max-width: 760px) { .rt-head { flex-direction:column; } .rt-tr { grid-template-columns:minmax(0,1fr) 60px; } .rt-tr > :nth-child(3), .rt-tr > :nth-child(4), .rt-tr > :nth-child(5) { display:none; } .rt-seg { margin-left:0; } }
`;
            (doc.head || doc.body).appendChild(s);
        },
    };
    root.RunTrace = RunTrace;
})(typeof window !== 'undefined' ? window : globalThis);
