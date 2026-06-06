/**
 * Agent Timeline — active-agent-observability (the chronological lens)
 *
 * The third view alongside Agent Map (topology) and Agent Runs (per-session
 * trace): a single newest-first stream of EVERY enforced tool call across all
 * runs, on one time axis. "What happened, in order, fleet-wide?" — each event
 * carries its runtime, whether the tool was a built-in or an external MCP, its
 * enforcement verdict, and (for blocked calls) why.
 *
 * Local-first, read-only. Reuses the existing call-audit log. Hand-rolled DOM +
 * SVG icons (no emoji), themed via the app's CSS variables (dark + light).
 */

// Keep in sync with agent-map.js HARNESS_FIXED / agent-runs.js RUNTIME_COLOR
// so a harness reads the same colour across Map, Runs and Timeline.
const TL_RUNTIME_COLOR = {
    'claude-code': '#fba35a', codex: '#3b82f6', openclaw: '#ef4444',
    langchain: '#06b6d4', langgraph: '#0ea5e9', crewai: '#0d9488',
};
const TL_OUTCOME = {
    block: { color: '#ef4444', label: 'BLOCKED' },
    log_only: { color: '#94a3b8', label: 'LOG' },
    allow: { color: '#10b981', label: 'ALLOW' },
};
const TL_RISK = { delete: '#ef4444', admin: '#f59e0b', write: '#f59e0b' };
const TL_HIGH_RISK = new Set(['delete', 'admin', 'write']);
const TL_SVG_NS = 'http://www.w3.org/2000/svg';
const TL_BAN = (c, s = 11) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" style="vertical-align:-2px"><path fill="${c}" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2c1.8 0 3.5.6 4.9 1.7L5.7 16.9A8 8 0 0 1 12 4zm0 16a8 8 0 0 1-4.9-1.7L18.3 7.1A8 8 0 0 1 12 20z"/></svg>`;

const AgentTimelinePage = {
    windowDays: 7,
    action: '',
    kinds: { builtin: true, external: true }, // built-in / external checkbox filter
    entries: [],

    async render(container) {
        container.textContent = '';
        if (window.Header) {
            Header.setPageInfo('Timeline', 'Every enforced tool call, newest first — built-in vs external MCP, with the tool permission applied');
        }
        this._injectStyle();

        const header = document.createElement('div');
        header.className = 'obs-header';
        ObsTabs.render(header, 'timeline');
        const toolbar = document.createElement('div');
        toolbar.className = 'filters-bar';
        toolbar.id = 'agent-tl-toolbar';
        header.appendChild(toolbar);
        container.appendChild(header);
        this._buildToolbar(toolbar);

        // Activity chart (allow / block / threat-risk over time) above the feed.
        const chart = document.createElement('div');
        chart.id = 'agent-tl-chart';
        container.appendChild(chart);

        const feed = document.createElement('div');
        feed.id = 'agent-tl-feed';
        feed.className = 'tl-feed';
        container.appendChild(feed);

        await this.loadData();
    },

    _injectStyle() {
        if (document.getElementById('agent-tl-style')) return;
        const st = document.createElement('style');
        st.id = 'agent-tl-style';
        st.textContent = `
            .tl-feed { position:relative; margin:4px 2px; padding-left:22px; }
            .tl-feed::before { content:''; position:absolute; left:5px; top:6px; bottom:6px; width:2px; background:var(--border-default,#30363d); }
            .tl-day { position:relative; margin:18px 0 10px -22px; padding-left:22px; font:700 11px 'Avenir Next',Avenir,system-ui,sans-serif;
                letter-spacing:.6px; text-transform:uppercase; color:var(--text-muted,#7d8590); }
            .tl-day:first-child { margin-top:2px; }
            .tl-row { position:relative; display:flex; align-items:center; gap:11px; padding:8px 8px; border-radius:8px;
                margin:0 -8px; transition:background .12s; }
            .tl-row:hover { background:var(--bg-hover,#21262d); }
            .tl-dot { position:absolute; left:-22px; top:13px; width:11px; height:11px; border-radius:50%;
                border:2.5px solid var(--bg-page,#0d1117); box-sizing:content-box;
                box-shadow:0 0 0 3px color-mix(in srgb, currentColor 0%, transparent); }
            .tl-time { font-family:ui-monospace,'JetBrains Mono','SF Mono',Menlo,monospace; font-size:11px;
                color:var(--text-muted,#7d8590); width:52px; flex:0 0 auto; }
            .tl-rt { font-size:11px; color:var(--text-secondary,#b1bac4); width:88px; flex:0 0 auto; overflow:hidden;
                text-overflow:ellipsis; white-space:nowrap; }
            .tl-tool { font:600 13px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3);
                overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            .tl-kind { font:600 9.5px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.5px; text-transform:uppercase;
                padding:2px 7px; border-radius:5px; border:1px solid var(--border-default,#30363d); color:var(--text-secondary,#b1bac4); flex:0 0 auto; }
            .tl-kind.ext { color:var(--accent-primary,#5eadb8); border-color:var(--accent-primary,#5eadb8); }
            .tl-badge { font:600 10px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.4px; padding:2px 8px; border-radius:20px;
                display:inline-flex; align-items:center; gap:4px; margin-left:auto; flex:0 0 auto; }
            .tl-reason { margin:-2px 0 6px 0; padding-left:0; font-size:11.5px; color:var(--text-secondary,#b1bac4); }
            .tl-reason.blk { color:var(--danger,#ef4444); }
            .tl-chart-wrap { background:var(--bg-card,#161b22); border:1px solid var(--border-default,#30363d);
                border-radius:11px; padding:10px 12px 6px; margin:0 2px 14px; }
            .tl-chart-legend { display:flex; gap:16px; align-items:center; flex-wrap:wrap; margin-bottom:4px;
                font-size:11.5px; color:var(--text-secondary,#b1bac4); }
            .tl-chart-title { font-weight:700; color:var(--text-primary,#e6edf3); }
            .tl-leg { display:inline-flex; align-items:center; gap:6px; }
            .tl-leg i { display:inline-block; width:11px; height:2.5px; border-radius:2px; }
            .tl-empty { padding:54px 18px; text-align:center; color:var(--text-secondary,#94a3b8); }
            .tl-empty .t1 { font-size:15px; margin-bottom:6px; }
            .tl-empty .t2 { font-size:13px; }
            .tl-trunc { margin:18px 0 6px; padding:10px 12px; border-radius:9px; font-size:12px;
                color:var(--text-muted,#7d8590); background:var(--bg-subtle,rgba(125,133,144,.06));
                border:1px dashed var(--border-default,#30363d); text-align:center; }
            /* Tool-kind checkbox filter */
            .tl-kind-checks { display:inline-flex; align-items:center; gap:14px; }
            .tl-check { display:inline-flex; align-items:center; gap:6px; cursor:pointer;
                font:600 12.5px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3); user-select:none; }
            .tl-check input { width:14px; height:14px; cursor:pointer; accent-color:var(--accent-primary,#5eadb8); margin:0; }
            .tl-check-dot { width:9px; height:9px; border-radius:50%; flex:0 0 auto; }
        `;
        document.head.appendChild(st);
    },

    _buildToolbar(bar) {
        bar.textContent = '';
        const mkSelect = (label, opts, cur, onChange) => {
            const grp = document.createElement('div');
            grp.className = 'filter-group';
            const lbl = document.createElement('label');
            lbl.textContent = label;
            grp.appendChild(lbl);
            const sel = document.createElement('select');
            sel.className = 'filter-select';
            opts.forEach(([v, t]) => {
                const o = document.createElement('option');
                o.value = v; o.textContent = t;
                if (String(v) === String(cur)) o.selected = true;
                sel.appendChild(o);
            });
            sel.addEventListener('change', () => onChange(sel.value));
            grp.appendChild(sel);
            bar.appendChild(grp);
            return grp;
        };
        const wGrp = mkSelect('Window', [['1', '24h'], ['7', '7 days'], ['30', '30 days']], this.windowDays,
            v => { this.windowDays = Number(v); this.render2(); });
        mkSelect('Show', [['', 'All'], ['threat', 'Threats (high-risk)'], ['block', 'Blocked'], ['allow', 'Allowed'], ['log_only', 'Log-only']], this.action,
            v => { this.action = v; this.render2(); });

        // Built-in vs external tool-kind checkboxes (filters the feed only).
        const kgrp = document.createElement('div');
        kgrp.className = 'filter-group';
        const klbl = document.createElement('label');
        klbl.textContent = 'Tool';
        kgrp.appendChild(klbl);
        const kwrap = document.createElement('div');
        kwrap.className = 'tl-kind-checks';
        [
            { key: 'builtin', label: 'Built-in', color: '#64748b' },
            { key: 'external', label: 'External MCP', color: 'var(--accent-primary,#5eadb8)' },
        ].forEach(k => {
            const lab = document.createElement('label');
            lab.className = 'tl-check';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!this.kinds[k.key];
            cb.addEventListener('change', () => { this.kinds[k.key] = cb.checked; this.renderFeed(); });
            const dot = document.createElement('span');
            dot.className = 'tl-check-dot';
            dot.style.background = k.color;
            const txt = document.createElement('span');
            txt.textContent = k.label;
            lab.appendChild(cb); lab.appendChild(dot); lab.appendChild(txt);
            kwrap.appendChild(lab);
        });
        kgrp.appendChild(kwrap);
        bar.appendChild(kgrp);

        const exp = ObsTabs.exportMenu([
            { label: 'CSV', onClick: () => this._exportCSV() },
            { label: 'PDF', onClick: () => this._exportPDF() },
        ]);
        bar.appendChild(exp);
    },

    async loadData() {
        const feed = document.getElementById('agent-tl-feed');
        if (feed) feed.innerHTML = '<div class="tl-empty"><div class="t2">Loading timeline…</div></div>';
        // Two fetches:
        //  - feed: the latest 200 enforced calls (a page, newest-first).
        //  - activity: per-bucket verdict counts aggregated server-side over
        //    the FULL window. The overview chart is driven by THIS, never the
        //    200-row page — otherwise it silently under-counts blocks past the
        //    cap (it once read "Blocked 0" while the Map said "7 blocked").
        const [data, act] = await Promise.all([
            API.getCallAudit({ limit: 200 }),
            API.getCallAuditActivity({ windowDays: this.windowDays }),
        ]);
        this.entries = (data && data.entries) || [];
        this.total = (data && data.total) || this.entries.length;
        this.activity = (act && act.buckets) || [];
        this.renderFeed();
    },

    render2() { this.loadData(); },

    _withinWindow(iso) {
        if (!iso) return true;
        const t = this._parse(iso);
        if (!t) return true;
        const cutoff = Date.now() - this.windowDays * 86400000;
        return t.getTime() >= cutoff;
    },

    _isThreat(e) {
        return (e.action === 'block') || TL_HIGH_RISK.has((e.risk || '').toLowerCase());
    },

    /** Does an entry pass the current Show filter? */
    _matchFilter(e) {
        const f = this.action;
        if (!f) return true;
        if (f === 'threat') return this._isThreat(e);
        return (e.action || 'allow') === f;
    },

    /** Does an entry pass the built-in / external checkbox filter? */
    _matchKind(e) {
        return ObsTabs.isExternalTool(e.tool_id) ? this.kinds.external : this.kinds.builtin;
    },

    renderFeed() {
        const feed = document.getElementById('agent-tl-feed');
        if (!feed) return;
        const windowRows = this.entries.filter(e => this._withinWindow(e.called_at));

        // Overview chart is driven by the server-side full-window aggregate
        // (every enforced call in the window), NOT the 200-row feed page.
        const chart = document.getElementById('agent-tl-chart');
        const buckets = this.activity || [];
        if (chart) { chart.textContent = ''; if (buckets.length) chart.appendChild(this._buildChart(buckets)); }

        const rows = windowRows.filter(e => this._matchFilter(e) && this._matchKind(e));
        if (!rows.length) {
            const noKind = !this.kinds.builtin && !this.kinds.external;
            feed.innerHTML = '<div class="tl-empty"><div class="t1">' +
                (noKind ? 'No tool kind selected.' : 'No matching tool calls in this window.') + '</div>' +
                '<div class="t2">' + (noKind ? 'Tick Built-in or External MCP to show calls.'
                    : 'Adjust the Show / Tool filters, or run an agent — every tool call lands here in order.') + '</div></div>';
            return;
        }
        feed.textContent = '';
        let lastDay = null;
        rows.forEach(e => {
            const day = this._fmtDay(e.called_at);
            if (day !== lastDay) {
                lastDay = day;
                const h = document.createElement('div');
                h.className = 'tl-day';
                h.textContent = day;
                feed.appendChild(h);
            }
            const action = e.action || 'allow';
            const o = TL_OUTCOME[action] || TL_OUTCOME.allow;
            const external = ObsTabs.isExternalTool(e.tool_id);
            const rtColor = TL_RUNTIME_COLOR[e.runtime_kind] || '#64748b';
            const riskColor = TL_RISK[(e.risk || '').toLowerCase()];

            const row = document.createElement('div');
            row.className = 'tl-row';
            row.innerHTML =
                `<span class="tl-dot" style="background:${rtColor}"></span>` +
                `<span class="tl-time">${this._fmtClock(e.called_at)}</span>` +
                `<span class="tl-rt">${this._esc(e.runtime_kind || 'unknown')}</span>` +
                `<span class="tl-tool"${riskColor ? ` title="risk: ${this._esc(e.risk)}"` : ''}>${this._esc(e.function_name || e.tool_id || 'tool')}</span>` +
                `<span class="tl-kind ${external ? 'ext' : ''}">${external ? 'External MCP' : 'Built-in'}</span>` +
                `<span class="tl-badge" style="background:${o.color}22;color:${o.color}">` +
                `${action === 'block' ? TL_BAN(o.color, 10) : ''}${o.label}</span>`;
            feed.appendChild(row);
            if (e.reason) {
                const r = document.createElement('div');
                r.className = 'tl-reason' + (action === 'block' ? ' blk' : '');
                r.style.marginLeft = '52px';
                r.textContent = e.reason;
                feed.appendChild(r);
            }
        });

        // Honesty notice: the list is a 200-row page. When the window holds
        // more, say so — and point at the chart, which counts them all. Never
        // let a truncated list read as "this is everything".
        if (this.total > this.entries.length) {
            const note = document.createElement('div');
            note.className = 'tl-trunc';
            note.textContent =
                `Showing the latest ${this.entries.length} of ${this.total} enforced calls in this window. ` +
                `Older calls aren't listed here — the chart above counts all of them.`;
            feed.appendChild(note);
        }
    },

    /**
     * Compact overview chart above the feed: three count-per-bucket lines —
     * Allowed (green), Blocked (red), Threat / high-risk (amber) — over the
     * active window. Pure SVG, no chart library. Mirrors the spirit of the
     * legacy replay overview chart but on the enforcement axis.
     */
    _buildChart(rows) {
        const SERIES = [
            { key: 'allow',  label: 'Allowed', color: '#10b981', test: e => (e.action || 'allow') === 'allow' && !this._isThreat(e) },
            { key: 'block',  label: 'Blocked', color: '#ef4444', test: e => e.action === 'block' },
            { key: 'threat', label: 'Threat / high-risk', color: '#f59e0b', test: e => e.action !== 'block' && TL_HIGH_RISK.has((e.risk || '').toLowerCase()) },
        ];
        const ts = rows.map(e => this._parse(e.called_at)).filter(Boolean).map(d => d.getTime());
        const endMs = Date.now();
        const startMs = Math.min(endMs - this.windowDays * 86400000, ts.length ? Math.min(...ts) : endMs);
        const N = this.windowDays <= 1 ? 12 : (this.windowDays <= 7 ? 7 : 10);
        const bucket = Math.max(1, (endMs - startMs) / N);
        const data = SERIES.map(s => ({ ...s, counts: new Array(N).fill(0) }));
        // `rows` are server-side aggregate buckets ({called_at, action, risk,
        // n}); weight each by its count n (defaults to 1 if a raw row sneaks in).
        rows.forEach(e => {
            const d = this._parse(e.called_at); if (!d) return;
            const i = Math.min(N - 1, Math.max(0, Math.floor((d.getTime() - startMs) / bucket)));
            const n = e.n || 1;
            data.forEach(s => { if (s.test(e)) s.counts[i] += n; });
        });
        let yMax = 1;
        data.forEach(s => s.counts.forEach(v => { if (v > yMax) yMax = v; }));

        const W = 1100, H = 120, PL = 26, PR = 12, PT = 10, PB = 20;
        const pw = W - PL - PR, ph = H - PT - PB;
        const xAt = i => PL + (N === 1 ? 0 : (pw * i) / (N - 1));
        const yAt = v => PT + ph - (v / yMax) * ph;

        const wrap = document.createElement('div');
        wrap.className = 'tl-chart-wrap';

        const legend = document.createElement('div');
        legend.className = 'tl-chart-legend';
        legend.innerHTML = `<span class="tl-chart-title">Activity · last ${this.windowDays === 1 ? '24h' : this.windowDays + ' days'}</span>` +
            data.map(s => `<span class="tl-leg"><i style="background:${s.color}"></i>${s.label} (${s.counts.reduce((a, b) => a + b, 0)})</span>`).join('');
        wrap.appendChild(legend);

        const svg = document.createElementNS(TL_SVG_NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.setAttribute('width', '100%'); svg.setAttribute('height', H);
        svg.style.display = 'block';

        // Y axis line.
        const yax = document.createElementNS(TL_SVG_NS, 'line');
        yax.setAttribute('x1', PL); yax.setAttribute('x2', PL);
        yax.setAttribute('y1', PT); yax.setAttribute('y2', PT + ph);
        yax.setAttribute('stroke', 'var(--border-default,#30363d)'); yax.setAttribute('opacity', '0.8');
        svg.appendChild(yax);

        // Horizontal gridlines at "nice" y ticks (0 … yMax), each labelled.
        const niceStep = (raw) => {
            const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
            const n = (raw || 1) / p;
            return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
        };
        const step = niceStep(yMax / 4);
        for (let v = 0; v <= yMax + 0.5; v += step) {
            const ln = document.createElementNS(TL_SVG_NS, 'line');
            ln.setAttribute('x1', PL); ln.setAttribute('x2', W - PR);
            ln.setAttribute('y1', yAt(v)); ln.setAttribute('y2', yAt(v));
            ln.setAttribute('stroke', 'var(--border-default,#30363d)');
            ln.setAttribute('stroke-dasharray', v === 0 ? '0' : '2,3');
            ln.setAttribute('opacity', v === 0 ? '0.8' : '0.4');
            svg.appendChild(ln);
            const t = document.createElementNS(TL_SVG_NS, 'text');
            t.setAttribute('x', PL - 5); t.setAttribute('y', yAt(v) + 3);
            t.setAttribute('text-anchor', 'end'); t.setAttribute('font-size', '9');
            t.setAttribute('fill', 'var(--text-muted,#7d8590)');
            t.setAttribute('font-family', 'ui-monospace,Menlo,monospace');
            t.textContent = String(Math.round(v)); svg.appendChild(t);
        }

        // X axis time labels at bucket midpoints.
        // X-axis shows clock times for a 24h window, otherwise calendar dates
        // (e.g. "Jun 5") — never weekday names.
        const xfmt = this.windowDays <= 1
            ? (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : (d) => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
        for (let i = 0; i < N; i++) {
            if (N > 8 && i % 2 !== 0) continue;
            const mid = startMs + bucket * (i + 0.5);
            const t = document.createElementNS(TL_SVG_NS, 'text');
            t.setAttribute('x', xAt(i)); t.setAttribute('y', H - 6);
            t.setAttribute('text-anchor', 'middle'); t.setAttribute('font-size', '9.5');
            t.setAttribute('fill', 'var(--text-muted,#7d8590)');
            t.setAttribute('font-family', 'ui-monospace,Menlo,monospace');
            t.textContent = xfmt(new Date(mid)); svg.appendChild(t);
        }
        // Gradient fills (one per series) → soft area under each line for depth.
        const defs = document.createElementNS(TL_SVG_NS, 'defs');
        data.forEach((s, gi) => {
            const g = document.createElementNS(TL_SVG_NS, 'linearGradient');
            g.setAttribute('id', `tl-grad-${gi}`); g.setAttribute('x1', '0'); g.setAttribute('y1', '0');
            g.setAttribute('x2', '0'); g.setAttribute('y2', '1');
            const a = document.createElementNS(TL_SVG_NS, 'stop');
            a.setAttribute('offset', '0%'); a.setAttribute('stop-color', s.color); a.setAttribute('stop-opacity', '0.28');
            const b = document.createElementNS(TL_SVG_NS, 'stop');
            b.setAttribute('offset', '100%'); b.setAttribute('stop-color', s.color); b.setAttribute('stop-opacity', '0');
            g.appendChild(a); g.appendChild(b); defs.appendChild(g);
        });
        svg.appendChild(defs);

        data.forEach((s, gi) => {
            const line = s.counts.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');
            // Area fill (behind the line).
            const area = document.createElementNS(TL_SVG_NS, 'polygon');
            area.setAttribute('points', `${xAt(0).toFixed(1)},${yAt(0).toFixed(1)} ${line} ${xAt(N - 1).toFixed(1)},${yAt(0).toFixed(1)}`);
            area.setAttribute('fill', `url(#tl-grad-${gi})`);
            svg.appendChild(area);
            // Line on top.
            const pl = document.createElementNS(TL_SVG_NS, 'polyline');
            pl.setAttribute('fill', 'none'); pl.setAttribute('stroke', s.color);
            pl.setAttribute('stroke-width', '2'); pl.setAttribute('stroke-opacity', '0.95');
            pl.setAttribute('stroke-linejoin', 'round'); pl.setAttribute('stroke-linecap', 'round');
            pl.setAttribute('points', line); svg.appendChild(pl);
            s.counts.forEach((v, i) => {
                if (!v) return;
                const c = document.createElementNS(TL_SVG_NS, 'circle');
                c.setAttribute('cx', xAt(i)); c.setAttribute('cy', yAt(v)); c.setAttribute('r', '2.6');
                c.setAttribute('fill', s.color); c.setAttribute('stroke', 'var(--bg-card,#161b22)'); c.setAttribute('stroke-width', '1.5');
                svg.appendChild(c);
            });
        });
        wrap.appendChild(svg);
        return wrap;
    },

    _exportRows() {
        return this.entries.filter(e => this._withinWindow(e.called_at) && this._matchFilter(e) && this._matchKind(e));
    },
    _exportCols() {
        return [
            { label: 'called_at', get: e => e.called_at },
            { label: 'runtime', get: e => e.runtime_kind },
            { label: 'tool_id', get: e => e.tool_id },
            { label: 'function', get: e => e.function_name },
            { label: 'kind', get: e => ObsTabs.isExternalTool(e.tool_id) ? 'external' : 'built-in' },
            { label: 'action', get: e => e.action },
            { label: 'risk', get: e => e.risk },
            { label: 'reason', get: e => e.reason },
        ];
    },
    /** Export the filtered timeline as CSV. */
    _exportCSV() {
        const rows = this._exportRows();
        if (!rows.length) return;
        ObsTabs.download('agent-timeline.csv', ObsTabs.toCSV(this._exportCols(), rows), 'text/csv');
    },
    /** PDF = printable page with the events table. */
    _exportPDF() {
        const rows = this._exportRows();
        if (!rows.length) return;
        const shown = this.action ? this.action : 'all';
        ObsTabs.printDoc('SecureVector — Timeline',
            `<h1>Timeline</h1><div class="sub">${rows.length} events · last ${this.windowDays} day(s) · show: ${shown}</div>` +
            ObsTabs.tableHTML(this._exportCols(), rows));
    },

    _parse(iso) {
        const t = String(iso).replace(' ', 'T') + (String(iso).endsWith('Z') ? '' : 'Z');
        const d = new Date(t);
        return isNaN(d) ? null : d;
    },
    _fmtClock(iso) {
        const d = this._parse(iso);
        return d ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
    },
    _fmtDay(iso) {
        const d = this._parse(iso);
        return d ? d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '—';
    },
    _esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    },
};

window.AgentTimelinePage = AgentTimelinePage;
