/**
 * Agent Replay — Bundle 0.4
 *
 * Vertical timeline of merged events per agent: threat scans, tool-call
 * audits, LLM cost records. Local-first observability wedge — same data
 * the cloud-first competitors (Braintrust, Langfuse, Helicone) make you
 * ship to a SaaS.
 */

const ReplayPage = {
    filters: {
        agent: '',
        kinds: ['scan', 'tool_audit', 'cost'],
        since: '',          // ISO; empty = no lower bound
        until: '',          // ISO; empty = no upper bound
        rangePreset: '7d',  // '1h' | '6h' | '24h' | '7d' | 'all' — default to 7d so the overview chart has enough buckets
        limit: 1000,        // bumped from 200 so a 7-day window doesn't truncate the chart
    },

    data: { items: [], agents: [] },

    async render(container) {
        container.textContent = '';
        if (window.Header) Header.setPageInfo('Agent Activity', 'Per-agent timeline of scans, tool calls, and LLM cost');

        // Filter bar
        const bar = document.createElement('div');
        bar.className = 'filters-bar';
        bar.id = 'replay-filters';
        container.appendChild(bar);

        // Body
        const body = document.createElement('div');
        body.id = 'replay-body';
        container.appendChild(body);

        await this.loadData();
        this.buildFilters();
    },

    buildFilters() {
        const bar = document.getElementById('replay-filters');
        if (!bar) return;
        bar.textContent = '';

        // Agent dropdown — populated from server's distinct list
        const agentGroup = document.createElement('div');
        agentGroup.className = 'filter-group';
        const agentLabel = document.createElement('label');
        agentLabel.textContent = 'Agent';
        agentGroup.appendChild(agentLabel);
        const agentSelect = document.createElement('select');
        agentSelect.className = 'filter-select';
        agentSelect.id = 'replay-agent-filter';
        // Cap the rendered width so a long agent ID like
        // 'agent:main:explicit:sv-realtest-direct' doesn't blow the
        // dropdown out to several hundred pixels. Full value still
        // available via the option's title attribute on hover.
        agentSelect.style.cssText = 'max-width:220px;min-width:160px;';
        const allOpt = document.createElement('option');
        allOpt.value = '';
        allOpt.textContent = 'All agents';
        agentSelect.appendChild(allOpt);
        (this.data.agents || []).forEach(a => {
            const o = document.createElement('option');
            o.value = a;
            o.textContent = a;
            o.title = a;
            if (a === this.filters.agent) o.selected = true;
            agentSelect.appendChild(o);
        });
        agentSelect.addEventListener('change', e => {
            this.filters.agent = e.target.value;
            this.loadData();
        });
        agentGroup.appendChild(agentSelect);
        bar.appendChild(agentGroup);

        // Time range preset
        const rangeGroup = document.createElement('div');
        rangeGroup.className = 'filter-group';
        const rangeLabel = document.createElement('label');
        rangeLabel.textContent = 'Range';
        rangeGroup.appendChild(rangeLabel);
        const rangeSelect = document.createElement('select');
        rangeSelect.className = 'filter-select';
        rangeSelect.style.cssText = 'max-width:140px;min-width:120px;';
        const ranges = [
            { v: '1h',  l: 'Last 1h'  },
            { v: '6h',  l: 'Last 6h'  },
            { v: '24h', l: 'Last 24h' },
            { v: '7d',  l: 'Last 7d'  },
            { v: 'all', l: 'All time' },
        ];
        ranges.forEach(r => {
            const o = document.createElement('option');
            o.value = r.v;
            o.textContent = r.l;
            if (r.v === this.filters.rangePreset) o.selected = true;
            rangeSelect.appendChild(o);
        });
        rangeSelect.addEventListener('change', e => {
            this.filters.rangePreset = e.target.value;
            this._applyRangePreset();
            this.loadData();
        });
        rangeGroup.appendChild(rangeSelect);
        bar.appendChild(rangeGroup);

        // Kind toggles — let operators hide noisy streams
        const kindGroup = document.createElement('div');
        kindGroup.className = 'filter-group';
        const kindLabel = document.createElement('label');
        kindLabel.textContent = 'Show';
        kindGroup.appendChild(kindLabel);
        const kindWrap = document.createElement('div');
        kindWrap.style.cssText = 'display:flex;gap:8px;align-items:center;';
        const KINDS = [
            { id: 'scan',       label: 'Threats',     color: '#ef4444' },
            { id: 'tool_audit', label: 'Tool calls',  color: '#f59e0b' },
            { id: 'cost',       label: 'LLM cost',    color: '#22c55e' },
        ];
        KINDS.forEach(k => {
            const lbl = document.createElement('label');
            lbl.style.cssText = 'display:inline-flex;align-items:center;gap:4px;font-size:12.5px;cursor:pointer;color:var(--text-primary);';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = this.filters.kinds.includes(k.id);
            cb.addEventListener('change', () => {
                if (cb.checked) {
                    if (!this.filters.kinds.includes(k.id)) this.filters.kinds.push(k.id);
                } else {
                    this.filters.kinds = this.filters.kinds.filter(x => x !== k.id);
                }
                this.loadData();
            });
            lbl.appendChild(cb);
            const dot = document.createElement('span');
            dot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;background:${k.color};`;
            lbl.appendChild(dot);
            const txt = document.createElement('span');
            txt.textContent = k.label;
            lbl.appendChild(txt);
            kindWrap.appendChild(lbl);
        });
        kindGroup.appendChild(kindWrap);
        bar.appendChild(kindGroup);

        // Refresh + Export buttons (manual)
        const spacer = document.createElement('div');
        spacer.className = 'filter-spacer';
        bar.appendChild(spacer);

        const exportBtn = document.createElement('button');
        exportBtn.className = 'btn btn-secondary btn-compact';
        exportBtn.style.cssText = 'margin-right:6px;';
        exportBtn.textContent = 'Export CSV';
        exportBtn.title = 'Download the current filtered timeline as CSV';
        exportBtn.addEventListener('click', () => this.exportCSV());
        bar.appendChild(exportBtn);

        const refresh = document.createElement('button');
        refresh.className = 'btn btn-secondary btn-compact';
        refresh.textContent = '↻ Refresh';
        refresh.addEventListener('click', () => this.loadData());
        bar.appendChild(refresh);
    },

    exportCSV() {
        const items = (this.data && this.data.items) || [];
        if (!items.length) {
            if (window.Toast) Toast.error('No events to export in the current view');
            return;
        }
        const cols = ['timestamp', 'kind', 'agent', 'severity', 'summary', 'id', 'details_endpoint'];
        const escape = (v) => {
            if (v === null || v === undefined) return '';
            const s = String(v);
            return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const lines = [cols.join(',')];
        items.forEach(it => lines.push(cols.map(c => escape(it[c])).join(',')));
        const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        // Filename pattern: replay-<agent-or-all>-<YYYYMMDDhhmm>.csv
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
        const agentSlug = (this.filters.agent || 'all').replace(/[^a-zA-Z0-9_.-]+/g, '_');
        a.href = url;
        a.download = `replay-${agentSlug}-${stamp}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        if (window.Toast) Toast.success(`Exported ${items.length} events to CSV`);
    },

    _applyRangePreset() {
        const presets = { '1h': 3600, '6h': 6 * 3600, '24h': 24 * 3600, '7d': 7 * 86400 };
        const sec = presets[this.filters.rangePreset];
        if (!sec) {
            this.filters.since = '';
            this.filters.until = '';
            return;
        }
        const now = Date.now();
        this.filters.since = new Date(now - sec * 1000).toISOString();
        this.filters.until = '';
    },

    async loadData() {
        const body = document.getElementById('replay-body');
        if (!body) return;

        body.textContent = '';
        const loading = document.createElement('div');
        loading.className = 'loading-container';
        const spinner = document.createElement('div');
        spinner.className = 'spinner';
        loading.appendChild(spinner);
        body.appendChild(loading);

        // Apply preset → since/until on every load (so the window slides forward).
        this._applyRangePreset();

        try {
            this.data = await API.getReplayTimeline({
                agent:  this.filters.agent || undefined,
                since:  this.filters.since || undefined,
                until:  this.filters.until || undefined,
                kinds:  this.filters.kinds,
                limit:  this.filters.limit,
            });
            this.renderContent(body);
            // Re-render filter bar to refresh agent dropdown contents
            this.buildFilters();
        } catch (err) {
            body.textContent = '';
            const e = document.createElement('div');
            e.style.cssText = 'padding:16px;color:var(--danger,#ef4444);';
            e.textContent = 'Failed to load replay timeline: ' + (err && err.message || err);
            body.appendChild(e);
        }
    },

    renderContent(container) {
        container.textContent = '';

        // Summary line
        const summary = document.createElement('div');
        summary.style.cssText = 'display:flex;gap:24px;padding:12px 16px;background:var(--bg-card);border:1px solid var(--border-default);border-radius:8px;margin-bottom:16px;font-size:13px;';
        const items = this.data.items || [];
        const counts = items.reduce((m, it) => { m[it.kind] = (m[it.kind] || 0) + 1; return m; }, {});
        const stat = (label, v, color) => {
            const s = document.createElement('div');
            s.innerHTML = `<span style="color:var(--text-secondary)">${label}:</span> <strong style="color:${color || 'var(--text-primary)'}">${v}</strong>`;
            return s;
        };
        summary.appendChild(stat('Events', items.length));
        summary.appendChild(stat('Threats',     counts.scan       || 0, '#ef4444'));
        summary.appendChild(stat('Tool calls',  counts.tool_audit || 0, '#f59e0b'));
        summary.appendChild(stat('Cost rows',   counts.cost       || 0, '#22c55e'));
        const distinct = new Set(items.map(i => i.agent)).size;
        summary.appendChild(stat('Distinct agents', distinct));
        container.appendChild(summary);

        // Overview line chart — three subtle lines (Threats / Tool calls /
        // LLM cost) over the active range. Uses event counts per bucket
        // (not dollars) so the three series share a single y-axis cleanly.
        if (items.length) {
            container.appendChild(this._buildOverviewChart(items));
        }

        if (!items.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding:32px 16px;text-align:center;background:var(--bg-card);border:1px solid var(--border-default);border-radius:8px;color:var(--text-secondary);';
            empty.innerHTML = '<div style="font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:6px;">No events in this window.</div><div style="font-size:12.5px;">Trigger a scan via <code>/analyze</code>, log a tool-call via <code>/api/tool-permissions/call-audit</code>, or record a cost via <code>/api/costs/track</code>.</div>';
            container.appendChild(empty);
            return;
        }

        // Vertical timeline
        const list = document.createElement('div');
        list.style.cssText = 'background:var(--bg-card);border:1px solid var(--border-default);border-radius:8px;overflow:hidden;';

        items.forEach((it, idx) => {
            list.appendChild(this._buildRow(it, idx));
        });

        container.appendChild(list);
    },

    _buildRow(it, idx) {
        const KIND_META = {
            scan:       { label: 'THREAT',    color: '#ef4444' },
            tool_audit: { label: 'TOOL',      color: '#f59e0b' },
            cost:       { label: 'COST',      color: '#22c55e' },
        };
        const SEVERITY_GLYPH = {
            block:  { ch: '●', tip: 'Block / critical' },
            high:   { ch: '●', tip: 'High' },
            medium: { ch: '●', tip: 'Medium' },
            low:    { ch: '●', tip: 'Low' },
            info:   { ch: '○', tip: 'Info' },
        };
        const kind = KIND_META[it.kind] || { label: it.kind, color: '#888' };
        const sev = SEVERITY_GLYPH[it.severity] || SEVERITY_GLYPH.info;

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:flex-start;gap:12px;padding:10px 14px;border-bottom:1px solid var(--border-light);cursor:pointer;font-size:13px;transition:background 0.12s;';
        row.addEventListener('mouseenter', () => row.style.background = 'var(--bg-hover, rgba(255,255,255,0.04))');
        row.addEventListener('mouseleave', () => row.style.background = 'transparent');

        // Severity dot
        const dotWrap = document.createElement('div');
        dotWrap.style.cssText = 'flex-shrink:0;width:14px;text-align:center;line-height:1;';
        const dot = document.createElement('span');
        dot.textContent = sev.ch;
        dot.title = sev.tip;
        dot.style.cssText = `color:${kind.color};font-size:14px;`;
        dotWrap.appendChild(dot);
        row.appendChild(dotWrap);

        // Time (always shows date + time so a multi-day timeline is unambiguous
        // at a glance — same-day rows still align cleanly because the date
        // column is fixed-width).
        const time = document.createElement('div');
        time.style.cssText = 'flex-shrink:0;width:180px;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--text-secondary);';
        time.textContent = this._fmtTime(it.timestamp);
        time.title = it.timestamp || '';
        row.appendChild(time);

        // Kind tag
        const tag = document.createElement('div');
        tag.style.cssText = `flex-shrink:0;width:72px;padding:1px 8px;border-radius:10px;background:${kind.color}22;color:${kind.color};font-size:10.5px;font-weight:700;letter-spacing:0.4px;text-align:center;align-self:center;`;
        tag.textContent = kind.label;
        row.appendChild(tag);

        // Agent
        const agent = document.createElement('div');
        agent.style.cssText = 'flex-shrink:0;width:160px;font-weight:600;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        agent.textContent = it.agent || '—';
        agent.title = it.agent || '';
        row.appendChild(agent);

        // Summary
        const summary = document.createElement('div');
        summary.style.cssText = 'flex:1;min-width:0;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        summary.textContent = it.summary || '';
        summary.title = it.summary || '';
        row.appendChild(summary);

        // Expand caret
        const caret = document.createElement('span');
        caret.textContent = '▸';
        caret.style.cssText = 'flex-shrink:0;color:var(--text-secondary);font-size:11px;';
        row.appendChild(caret);

        // Click to expand details inline
        const detailsId = `replay-detail-${idx}`;
        row.addEventListener('click', () => {
            const existing = document.getElementById(detailsId);
            if (existing) {
                existing.remove();
                caret.textContent = '▸';
                return;
            }
            caret.textContent = '▾';
            const det = document.createElement('div');
            det.id = detailsId;
            det.style.cssText = 'background:var(--bg-primary);padding:12px 16px 12px 56px;border-bottom:1px solid var(--border-light);font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--text-secondary);white-space:pre-wrap;word-break:break-word;line-height:1.45;';
            det.textContent = JSON.stringify(it, null, 2);
            row.parentNode.insertBefore(det, row.nextSibling);
        });

        return row;
    },

    /**
     * Build the overview line chart shown above the timeline.
     *
     * Three subtle lines: scan / tool_audit / cost — counts per time bucket.
     * Bucketing adapts to the active range preset:
     *   1h  -> 6 buckets of 10 min     (HH:MM labels)
     *   6h  -> 6 buckets of 1 hour     (HH:00 labels)
     *   24h -> 8 buckets of 3 hours    (HH:00 labels)
     *   7d  -> 7 buckets of 1 day      (Mon/Tue/... labels)
     *   all -> 7 buckets of (range/7)  (date labels)
     *
     * Pure SVG, no third-party chart library. Sized small (110px tall) so
     * it doesn't push the timeline rows below the fold.
     */
    _buildOverviewChart(items) {
        const KIND_META = {
            scan:       { label: 'Threats',    color: '#ef4444' },
            tool_audit: { label: 'Tool calls', color: '#f59e0b' },
            cost:       { label: 'LLM cost',   color: '#22c55e' },
        };

        // Resolve the active range to a (since, until) window in epoch ms.
        // Defaults are conservative — if no since/until is set we infer from
        // the data's min/max timestamp.
        const presets = { '1h': 3600, '6h': 6 * 3600, '24h': 24 * 3600, '7d': 7 * 86400 };
        const sec = presets[this.filters.rangePreset];
        const now = Date.now();
        let endMs = now;
        let startMs;
        if (sec) {
            startMs = endMs - sec * 1000;
        } else {
            // 'all' — derive from data
            const tss = items.map(it => Date.parse(it.timestamp || '')).filter(t => !Number.isNaN(t));
            if (!tss.length) return document.createElement('div');
            startMs = Math.min(...tss);
            endMs   = Math.max(...tss);
            if (endMs <= startMs) endMs = startMs + 1000;
        }

        // Bucket count + label format per preset.
        const bucketCfg = {
            '1h':  { count: 6, fmt: (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
            '6h':  { count: 6, fmt: (d) => d.toLocaleTimeString([], { hour: '2-digit' }) },
            '24h': { count: 8, fmt: (d) => d.toLocaleTimeString([], { hour: '2-digit' }) },
            '7d':  { count: 7, fmt: (d) => d.toLocaleDateString([], { weekday: 'short' }) },
        }[this.filters.rangePreset] || { count: 7, fmt: (d) => d.toLocaleDateString([], { month: 'short', day: '2-digit' }) };

        const N = bucketCfg.count;
        const bucketSize = (endMs - startMs) / N;

        // Three series, one per kind. Counts per bucket.
        const series = { scan: new Array(N).fill(0), tool_audit: new Array(N).fill(0), cost: new Array(N).fill(0) };
        items.forEach(it => {
            const t = Date.parse(it.timestamp || '');
            if (Number.isNaN(t) || t < startMs || t > endMs) return;
            const idx = Math.min(N - 1, Math.max(0, Math.floor((t - startMs) / bucketSize)));
            if (series[it.kind]) series[it.kind][idx] += 1;
        });

        // Scale: max count across all visible series sets the y-axis ceiling.
        const visibleKinds = this.filters.kinds.filter(k => series[k]);
        let yMax = 1;
        visibleKinds.forEach(k => series[k].forEach(v => { if (v > yMax) yMax = v; }));

        // SVG geometry.
        const W = 1100;
        const H = 110;
        const PAD_L = 28;
        const PAD_R = 12;
        const PAD_T = 8;
        const PAD_B = 22;
        const plotW = W - PAD_L - PAD_R;
        const plotH = H - PAD_T - PAD_B;

        const xAt = (i) => PAD_L + (N === 1 ? 0 : (plotW * i) / (N - 1));
        const yAt = (v) => PAD_T + plotH - (v / yMax) * plotH;

        // Container.
        const wrap = document.createElement('div');
        wrap.style.cssText = 'background:var(--bg-card);border:1px solid var(--border-default);border-radius:8px;padding:10px 12px 6px;margin-bottom:16px;';

        // Inline legend matching the kind colors.
        const legendBar = document.createElement('div');
        legendBar.style.cssText = 'display:flex;gap:14px;align-items:center;font-size:11.5px;color:var(--text-secondary);margin-bottom:4px;';
        const legendTitle = document.createElement('span');
        legendTitle.textContent = `Activity over ${this.filters.rangePreset === 'all' ? 'all time' : 'last ' + this.filters.rangePreset}:`;
        legendTitle.style.color = 'var(--text-secondary)';
        legendBar.appendChild(legendTitle);
        ['scan', 'tool_audit', 'cost'].forEach(k => {
            const meta = KIND_META[k];
            const item = document.createElement('span');
            item.style.cssText = 'display:inline-flex;align-items:center;gap:5px;';
            const dim = !visibleKinds.includes(k);
            const dot = document.createElement('span');
            dot.style.cssText = `display:inline-block;width:10px;height:2px;background:${meta.color};opacity:${dim ? 0.25 : 0.85};`;
            const lbl = document.createElement('span');
            lbl.textContent = `${meta.label} (${series[k].reduce((a,b)=>a+b,0)})`;
            lbl.style.opacity = dim ? '0.4' : '1';
            item.appendChild(dot);
            item.appendChild(lbl);
            legendBar.appendChild(item);
        });
        wrap.appendChild(legendBar);

        const SVG_NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', H);
        svg.style.display = 'block';

        // Faint baseline (0) + ceiling (max) grid lines.
        [0, yMax].forEach((v, i) => {
            const line = document.createElementNS(SVG_NS, 'line');
            line.setAttribute('x1', PAD_L);
            line.setAttribute('x2', W - PAD_R);
            line.setAttribute('y1', yAt(v));
            line.setAttribute('y2', yAt(v));
            line.setAttribute('stroke', 'var(--border-light, #2a2a2a)');
            line.setAttribute('stroke-width', '1');
            line.setAttribute('stroke-dasharray', i === 0 ? '0' : '2,3');
            line.setAttribute('opacity', '0.5');
            svg.appendChild(line);
            const lbl = document.createElementNS(SVG_NS, 'text');
            lbl.setAttribute('x', PAD_L - 4);
            lbl.setAttribute('y', yAt(v) + 3);
            lbl.setAttribute('text-anchor', 'end');
            lbl.setAttribute('fill', 'var(--text-secondary, #888)');
            lbl.setAttribute('font-size', '9');
            lbl.setAttribute('font-family', 'ui-monospace, Menlo, monospace');
            lbl.textContent = String(v);
            svg.appendChild(lbl);
        });

        // X-axis labels at bucket midpoints (every other to avoid clutter).
        for (let i = 0; i < N; i++) {
            const midMs = startMs + bucketSize * (i + 0.5);
            const showLabel = (N <= 8) || i % 2 === 0;
            if (!showLabel) continue;
            const lbl = document.createElementNS(SVG_NS, 'text');
            lbl.setAttribute('x', xAt(i));
            lbl.setAttribute('y', H - 6);
            lbl.setAttribute('text-anchor', 'middle');
            lbl.setAttribute('fill', 'var(--text-secondary, #888)');
            lbl.setAttribute('font-size', '9.5');
            lbl.setAttribute('font-family', 'ui-monospace, Menlo, monospace');
            lbl.textContent = bucketCfg.fmt(new Date(midMs));
            svg.appendChild(lbl);
        }

        // <defs> — one gradient per kind, line color → transparent at the
        // baseline. Same hue as the line, low alpha at the top fading out.
        const defs = document.createElementNS(SVG_NS, 'defs');
        ['scan', 'tool_audit', 'cost'].forEach(k => {
            const meta = KIND_META[k];
            const grad = document.createElementNS(SVG_NS, 'linearGradient');
            grad.setAttribute('id', `replay-grad-${k}`);
            grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
            grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
            const s1 = document.createElementNS(SVG_NS, 'stop');
            s1.setAttribute('offset', '0%');
            s1.setAttribute('stop-color', meta.color);
            s1.setAttribute('stop-opacity', '0.32');
            const s2 = document.createElementNS(SVG_NS, 'stop');
            s2.setAttribute('offset', '100%');
            s2.setAttribute('stop-color', meta.color);
            s2.setAttribute('stop-opacity', '0');
            grad.appendChild(s1); grad.appendChild(s2);
            defs.appendChild(grad);
        });
        svg.appendChild(defs);

        // Three lines + gradient area fills underneath. Lines animate in
        // left-to-right on first render via stroke-dashoffset trick.
        const lineEls = {};   // for hover lookup
        visibleKinds.forEach(k => {
            const meta = KIND_META[k];
            const linePoints = series[k].map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');
            const areaPoints = `${xAt(0).toFixed(1)},${yAt(0).toFixed(1)} ${linePoints} ${xAt(N - 1).toFixed(1)},${yAt(0).toFixed(1)}`;

            // Area fill (drawn first, sits behind the line).
            const area = document.createElementNS(SVG_NS, 'polygon');
            area.setAttribute('points', areaPoints);
            area.setAttribute('fill', `url(#replay-grad-${k})`);
            area.setAttribute('opacity', '0');
            svg.appendChild(area);
            requestAnimationFrame(() => {
                area.style.transition = 'opacity 0.6s ease 0.3s';
                area.setAttribute('opacity', '1');
            });

            // Line on top.
            const path = document.createElementNS(SVG_NS, 'polyline');
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke', meta.color);
            path.setAttribute('stroke-width', '1.6');
            path.setAttribute('stroke-opacity', '0.85');
            path.setAttribute('stroke-linejoin', 'round');
            path.setAttribute('stroke-linecap', 'round');
            path.setAttribute('points', linePoints);
            // Animated draw-in: stash the geometric path length, set
            // dasharray + offset to that length so the line is invisible,
            // then transition offset to 0 for a left-to-right draw.
            try {
                const len = Math.ceil(path.getTotalLength?.() || (plotW + 50));
                path.style.strokeDasharray = String(len);
                path.style.strokeDashoffset = String(len);
                requestAnimationFrame(() => {
                    path.style.transition = 'stroke-dashoffset 0.85s ease-out';
                    path.style.strokeDashoffset = '0';
                });
            } catch (_) { /* getTotalLength unavailable on polyline in some engines — silently skip */ }
            svg.appendChild(path);
            lineEls[k] = path;

            // Bucket dots (always visible — fade in with the area).
            series[k].forEach((v, i) => {
                if (v === 0) return;
                const dot = document.createElementNS(SVG_NS, 'circle');
                dot.setAttribute('cx', xAt(i));
                dot.setAttribute('cy', yAt(v));
                dot.setAttribute('r', '2.5');
                dot.setAttribute('fill', meta.color);
                dot.setAttribute('opacity', '0');
                svg.appendChild(dot);
                requestAnimationFrame(() => {
                    dot.style.transition = 'opacity 0.4s ease ' + (0.4 + i * 0.04) + 's';
                    dot.setAttribute('opacity', '0.9');
                });
            });
        });

        // Hover crosshair + floating tooltip — Sentry-grade interactivity.
        // An invisible overlay rect captures mousemove. We compute the
        // nearest bucket and surface the per-kind counts in a tooltip
        // pinned near the cursor.
        const crosshair = document.createElementNS(SVG_NS, 'line');
        crosshair.setAttribute('y1', PAD_T);
        crosshair.setAttribute('y2', PAD_T + plotH);
        crosshair.setAttribute('stroke', 'var(--text-secondary, #888)');
        crosshair.setAttribute('stroke-width', '1');
        crosshair.setAttribute('stroke-dasharray', '2,3');
        crosshair.setAttribute('opacity', '0');
        crosshair.style.pointerEvents = 'none';
        svg.appendChild(crosshair);

        const hoverDots = {};
        visibleKinds.forEach(k => {
            const meta = KIND_META[k];
            const c = document.createElementNS(SVG_NS, 'circle');
            c.setAttribute('r', '4');
            c.setAttribute('fill', meta.color);
            c.setAttribute('stroke', 'var(--bg-card, #fff)');
            c.setAttribute('stroke-width', '1.5');
            c.setAttribute('opacity', '0');
            c.style.pointerEvents = 'none';
            svg.appendChild(c);
            hoverDots[k] = c;
        });

        // Tooltip overlay sits in the same wrap div, positioned via inline style.
        const tooltip = document.createElement('div');
        tooltip.style.cssText = 'position:absolute;pointer-events:none;background:var(--bg-card,#fff);border:1px solid var(--border-default,#444);border-radius:6px;padding:7px 10px;font-size:11.5px;line-height:1.45;box-shadow:0 4px 12px rgba(0,0,0,0.25);opacity:0;transition:opacity 0.12s;white-space:nowrap;z-index:5;';
        wrap.style.position = 'relative';
        wrap.appendChild(tooltip);

        // Invisible overlay to capture pointer events.
        const overlay = document.createElementNS(SVG_NS, 'rect');
        overlay.setAttribute('x', PAD_L);
        overlay.setAttribute('y', PAD_T);
        overlay.setAttribute('width', plotW);
        overlay.setAttribute('height', plotH);
        overlay.setAttribute('fill', 'transparent');
        overlay.style.cursor = 'crosshair';
        svg.appendChild(overlay);

        const showHover = (clientX) => {
            const rect = svg.getBoundingClientRect();
            const xRatio = (clientX - rect.left) / rect.width;
            const xVB = xRatio * W;
            // Find the nearest bucket index.
            let bestIdx = 0, bestDist = Infinity;
            for (let i = 0; i < N; i++) {
                const dist = Math.abs(xAt(i) - xVB);
                if (dist < bestDist) { bestDist = dist; bestIdx = i; }
            }
            const cx = xAt(bestIdx);
            crosshair.setAttribute('x1', cx);
            crosshair.setAttribute('x2', cx);
            crosshair.setAttribute('opacity', '0.6');
            visibleKinds.forEach(k => {
                hoverDots[k].setAttribute('cx', cx);
                hoverDots[k].setAttribute('cy', yAt(series[k][bestIdx]));
                hoverDots[k].setAttribute('opacity', '1');
            });
            // Tooltip body.
            const midMs = startMs + bucketSize * (bestIdx + 0.5);
            const dateLbl = new Date(midMs).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
            const lines = [`<div style="font-weight:600;margin-bottom:4px;">${dateLbl}</div>`];
            ['scan', 'tool_audit', 'cost'].forEach(k => {
                if (!visibleKinds.includes(k)) return;
                const meta = KIND_META[k];
                lines.push(`<div style="display:flex;align-items:center;gap:6px;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${meta.color};"></span><span>${meta.label}: <strong>${series[k][bestIdx]}</strong></span></div>`);
            });
            tooltip.innerHTML = lines.join('');
            // Position tooltip near the cursor but constrain inside the wrap.
            const wrapRect = wrap.getBoundingClientRect();
            const tipX = (cx / W) * rect.width + (rect.left - wrapRect.left) + 12;
            const tipY = (rect.top - wrapRect.top) + 4;
            tooltip.style.left = `${tipX}px`;
            tooltip.style.top = `${tipY}px`;
            tooltip.style.opacity = '1';
        };
        const hideHover = () => {
            crosshair.setAttribute('opacity', '0');
            visibleKinds.forEach(k => hoverDots[k].setAttribute('opacity', '0'));
            tooltip.style.opacity = '0';
        };
        overlay.addEventListener('mousemove', (e) => showHover(e.clientX));
        overlay.addEventListener('mouseleave', hideHover);

        wrap.appendChild(svg);
        return wrap;
    },

    _fmtTime(ts) {
        if (!ts) return '—';
        try {
            const d = new Date(ts);
            // Always show date + time so a multi-day window is unambiguous.
            // "Apr 26 11:08:20 PM" — short month, 2-digit day, 12h time.
            const date = d.toLocaleDateString([], { month: 'short', day: '2-digit' });
            const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            return `${date}  ${time}`;
        } catch {
            return ts;
        }
    },
};

window.ReplayPage = ReplayPage;
