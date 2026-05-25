/**
 * Redactions page — audit log of redact_secrets() matches.
 *
 * Sibling to Bill of Tools under Agent Activity. Shows what got
 * redacted, from which tool, when, and in which scan direction. The
 * raw secret values are NEVER displayed — only a SHA-256 hash and the
 * pattern_id + secret_type metadata. See backend route /api/redactions
 * and RedactionsRepository for the storage posture.
 *
 * Exports two reports identical in shape to the Bill of Tools page:
 *  - CSV (9 columns; hash, not raw value)
 *  - PDF (via window.print() in a popup; auditor-grade layout with
 *    headline + by-secret-type + by-direction + event log + methodology)
 */

const RedactionsPage = {
    activeTab: 'redactions',
    _state: { windowDays: 7, direction: '', secretType: '', summary: null, events: [] },

    async render(container) {
        const page = document.createElement('div');
        page.className = 'page-wrapper';
        container.appendChild(page);

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px;';

        const titleWrap = document.createElement('div');
        const title = document.createElement('h2');
        title.textContent = 'Redactions';
        title.style.cssText = 'margin:0 0 4px;font-size:18px;';
        const subtitle = document.createElement('div');
        subtitle.style.cssText = 'font-size:12px;color:var(--text-secondary);max-width:680px;line-height:1.45;';
        subtitle.textContent = 'Secret matches scrubbed from scanned content before persistence. Direction-aware: PEM-key redactions only fire on incoming tool responses; sk-/AKIA/ghp_/JWT/password patterns fire on every direction. Raw secret values never appear in this report — only a SHA-256 hash of the matched substring.';
        titleWrap.appendChild(title);
        titleWrap.appendChild(subtitle);
        header.appendChild(titleWrap);

        const controls = document.createElement('div');
        controls.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';

        const windowSelect = document.createElement('select');
        windowSelect.style.cssText = 'padding:5px 8px;border-radius:6px;border:1px solid var(--border-default);background:var(--bg-secondary);color:var(--text-primary);font-size:12px;';
        [
            { v: 7,  l: '7 days' },
            { v: 14, l: '14 days' },
            { v: 30, l: '30 days' },
            { v: 90, l: '90 days' },
            { v: 365, l: '1 year' },
        ].forEach(({ v, l }) => {
            const opt = document.createElement('option');
            opt.value = String(v);
            opt.textContent = l;
            if (v === this._state.windowDays) opt.selected = true;
            windowSelect.appendChild(opt);
        });
        windowSelect.addEventListener('change', async () => {
            this._state.windowDays = parseInt(windowSelect.value, 10) || 7;
            await this._reload(tableMount, summaryMount, breakdownMount);
        });
        controls.appendChild(this._labelled('Window:', windowSelect));

        const directionSelect = document.createElement('select');
        directionSelect.style.cssText = windowSelect.style.cssText;
        [
            { v: '',             l: 'All directions' },
            { v: 'incoming',     l: 'incoming (tool responses)' },
            { v: 'outgoing',     l: 'outgoing (user prompts)' },
            { v: 'llm_response', l: 'llm_response' },
        ].forEach(({ v, l }) => {
            const opt = document.createElement('option');
            opt.value = v;
            opt.textContent = l;
            directionSelect.appendChild(opt);
        });
        directionSelect.addEventListener('change', async () => {
            this._state.direction = directionSelect.value || '';
            await this._reload(tableMount, summaryMount, breakdownMount);
        });
        controls.appendChild(this._labelled('Direction:', directionSelect));

        const csvBtn = document.createElement('button');
        csvBtn.className = 'sv-btn-secondary';
        csvBtn.textContent = 'Export CSV';
        csvBtn.style.cssText = 'padding:6px 12px;font-size:12px;';
        csvBtn.title = 'Download the visible redaction events as CSV (hash only, never raw)';
        csvBtn.addEventListener('click', () => this._exportCsv());
        controls.appendChild(csvBtn);

        const pdfBtn = document.createElement('button');
        pdfBtn.className = 'sv-btn-secondary';
        pdfBtn.textContent = 'Export PDF';
        pdfBtn.style.cssText = 'padding:6px 12px;font-size:12px;';
        pdfBtn.title = 'Open a print-ready view; use the browser print dialog to save as PDF';
        pdfBtn.addEventListener('click', () => this._exportPdf());
        controls.appendChild(pdfBtn);

        header.appendChild(controls);
        page.appendChild(header);

        const summaryMount = document.createElement('div');
        summaryMount.style.cssText = 'font-size:12px;color:var(--text-secondary);margin-bottom:10px;';
        page.appendChild(summaryMount);

        const breakdownMount = document.createElement('div');
        breakdownMount.style.cssText = 'display:flex;gap:24px;flex-wrap:wrap;margin-bottom:14px;';
        page.appendChild(breakdownMount);

        const tableMount = document.createElement('div');
        page.appendChild(tableMount);

        await this._reload(tableMount, summaryMount, breakdownMount);
    },

    _labelled(text, control) {
        const wrap = document.createElement('span');
        wrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;';
        const label = document.createElement('label');
        label.textContent = text;
        label.style.cssText = 'font-size:12px;color:var(--text-secondary);';
        wrap.appendChild(label);
        wrap.appendChild(control);
        return wrap;
    },

    async _reload(tableMount, summaryMount, breakdownMount) {
        tableMount.textContent = '';
        const loading = document.createElement('div');
        loading.textContent = 'Loading…';
        loading.style.cssText = 'padding:24px;text-align:center;color:var(--text-secondary);font-size:13px;';
        tableMount.appendChild(loading);

        const data = await API.getRedactions(this._state.windowDays, {
            direction: this._state.direction || null,
            secretType: this._state.secretType || null,
        });
        this._state.summary = data.summary;
        this._state.events = data.events || [];

        // Headline summary line
        if (summaryMount) {
            const s = data.summary || {};
            summaryMount.textContent =
                `${s.total ?? 0} redaction${s.total === 1 ? '' : 's'} in the last ` +
                `${s.window_days ?? this._state.windowDays} day${s.window_days === 1 ? '' : 's'} · ` +
                `${s.distinct_tools ?? 0} distinct tool${s.distinct_tools === 1 ? '' : 's'}`;
        }

        // Two small breakdown cards (by direction + by secret type)
        breakdownMount.textContent = '';
        breakdownMount.appendChild(this._buildBreakdownCard('By direction', data.summary?.by_direction || {}));
        breakdownMount.appendChild(this._buildBreakdownCard('By secret type', data.summary?.by_secret_type || {}));

        // Table
        tableMount.textContent = '';
        if (!this._state.events.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding:36px;text-align:center;color:var(--text-secondary);font-size:13px;border:1px dashed var(--border-default);border-radius:8px;';
            empty.textContent = 'No redactions in this window. Nothing to scrub means nothing slipped through — or no scans ran yet.';
            tableMount.appendChild(empty);
            return;
        }

        const table = document.createElement('table');
        table.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px;';

        const thead = document.createElement('thead');
        const trh = document.createElement('tr');
        ['Time', 'Direction', 'Pattern', 'Secret type', 'Source tool', 'Request', 'Hash'].forEach((l) => {
            const th = document.createElement('th');
            th.textContent = l;
            th.style.cssText = 'text-align:left;padding:8px 10px;border-bottom:2px solid var(--border-default);font-weight:600;color:var(--text-primary);';
            trh.appendChild(th);
        });
        thead.appendChild(trh);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        this._state.events.forEach((ev) => {
            const tr = document.createElement('tr');
            tr.style.cssText = 'border-bottom:1px solid var(--border-default);';
            const cell = (text, opts = {}) => {
                const td = document.createElement('td');
                td.style.cssText = `padding:7px 10px;${opts.mono ? 'font-family:monospace;font-size:11px;' : ''}`;
                if (opts.html) td.innerHTML = text;
                else td.textContent = text;
                return td;
            };
            tr.appendChild(cell(this._fmtTime(ev.redacted_at)));

            const dirBadge =
                ev.direction === 'incoming' ? 'background:rgba(220,38,38,0.15);color:#dc2626'
              : ev.direction === 'outgoing' ? 'background:rgba(96,165,250,0.15);color:#2563eb'
              : 'background:rgba(148,163,184,0.15);color:var(--text-secondary)';
            tr.appendChild(cell(
                `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;${dirBadge};">${ev.direction}</span>`,
                { html: true }
            ));

            tr.appendChild(cell(ev.pattern_id || '—', { mono: true }));
            tr.appendChild(cell(ev.secret_type || '—'));
            tr.appendChild(cell(ev.source_tool_id || ev.source_tool || '—', { mono: true }));
            tr.appendChild(cell(ev.request_id || '—', { mono: true }));

            const shortHash = (ev.redaction_hash || '').replace(/^sha256:/, '').slice(0, 12);
            tr.appendChild(cell(
                `<span style="font-family:monospace;font-size:10px;color:var(--text-secondary);" title="${ev.redaction_hash || ''}">${shortHash || '—'}…</span>`,
                { html: true }
            ));

            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        tableMount.appendChild(table);
    },

    _buildBreakdownCard(title, dict) {
        const card = document.createElement('div');
        card.style.cssText = 'flex:1;min-width:280px;max-width:480px;background:var(--bg-secondary);border:1px solid var(--border-default);border-radius:8px;padding:12px 14px;';
        const h = document.createElement('div');
        h.textContent = title;
        h.style.cssText = 'font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-secondary);margin-bottom:8px;';
        card.appendChild(h);

        const entries = Object.entries(dict).sort((a, b) => b[1] - a[1]);
        if (entries.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = '—';
            empty.style.cssText = 'font-size:12px;color:var(--text-secondary);';
            card.appendChild(empty);
            return card;
        }
        const max = entries[0][1] || 1;
        entries.forEach(([k, v]) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:12px;';
            const lbl = document.createElement('span');
            lbl.textContent = k;
            lbl.style.cssText = 'flex:0 0 140px;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            const bar = document.createElement('span');
            bar.style.cssText = `flex:1;height:8px;background:linear-gradient(90deg, #3057f5 ${(v / max) * 100}%, var(--border-default) ${(v / max) * 100}%);border-radius:4px;`;
            const cnt = document.createElement('span');
            cnt.textContent = String(v);
            cnt.style.cssText = 'flex:0 0 36px;text-align:right;color:var(--text-primary);font-variant-numeric:tabular-nums;';
            row.appendChild(lbl);
            row.appendChild(bar);
            row.appendChild(cnt);
            card.appendChild(row);
        });
        return card;
    },

    _fmtTime(iso) {
        if (!iso) return '—';
        try {
            const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
            if (isNaN(d.getTime())) return iso;
            return d.toLocaleString();
        } catch { return iso; }
    },

    _exportCsv() {
        const rows = this._state.events || [];
        if (rows.length === 0) {
            if (window.Toast) Toast.show('No redactions in the selected window', 'info');
            return;
        }
        const headers = ['time', 'direction', 'pattern_id', 'secret_type', 'source_tool', 'source_tool_id', 'request_id', 'redaction_hash'];
        const escape = (v) => {
            const s = String(v ?? '');
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const body = rows.map((r) => [
            r.redacted_at || '',
            r.direction || '',
            r.pattern_id || '',
            r.secret_type || '',
            r.source_tool || '',
            r.source_tool_id || '',
            r.request_id || '',
            r.redaction_hash || '',
        ].map(escape).join(',')).join('\n');
        const csv = headers.join(',') + '\n' + body;
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const stamp = new Date().toISOString().slice(0, 10);
        a.download = `securevector-redactions-${stamp}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    },

    _exportPdf() {
        const rows = this._state.events || [];
        const summary = this._state.summary || {};
        if (rows.length === 0) {
            if (window.Toast) Toast.show('No redactions in the selected window', 'info');
            return;
        }
        const win = window.open('', '_blank');
        if (!win) {
            if (window.Toast) Toast.show('Popup blocked — allow popups to export PDF', 'error');
            return;
        }
        const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
        const stamp = new Date().toISOString();

        const breakdown = (title, dict) => {
            const entries = Object.entries(dict || {}).sort((a, b) => b[1] - a[1]);
            if (entries.length === 0) return `<div><h3>${esc(title)}</h3><p style="color:#888">—</p></div>`;
            const max = entries[0][1] || 1;
            const items = entries.map(([k, v]) =>
                `<div style="display:flex;align-items:center;gap:8px;margin:3px 0;">
                    <span style="flex:0 0 220px;">${esc(k)}</span>
                    <span style="flex:1;height:6px;background:linear-gradient(90deg,#3057f5 ${(v / max) * 100}%, #e3e6ee ${(v / max) * 100}%);"></span>
                    <span style="flex:0 0 40px;text-align:right;">${v}</span>
                 </div>`).join('');
            return `<div style="margin-bottom:12px;"><h3 style="font-size:12px;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.08em;color:#666;">${esc(title)}</h3>${items}</div>`;
        };

        const rowsHtml = rows.map((r) => `<tr>
            <td>${esc(r.redacted_at || '')}</td>
            <td>${esc(r.direction || '')}</td>
            <td>${esc(r.pattern_id || '')}</td>
            <td>${esc(r.secret_type || '')}</td>
            <td>${esc(r.source_tool_id || r.source_tool || '')}</td>
            <td style="font-family:monospace;font-size:9px;">${esc(r.redaction_hash || '')}</td>
        </tr>`).join('');

        win.document.write(`<!doctype html><html><head><meta charset="utf-8">
            <title>SecureVector — Redactions Report (${esc(stamp)})</title>
            <style>
                body{font-family:-apple-system,Segoe UI,sans-serif;margin:24px;color:#111;}
                h1{font-size:20px;margin:0 0 4px;}
                .meta{font-size:11px;color:#666;margin-bottom:14px;}
                .headline{font-size:14px;margin:8px 0 16px;padding:10px 12px;background:#f4f4f7;border-radius:6px;}
                table{width:100%;border-collapse:collapse;font-size:11px;margin-top:14px;}
                th,td{border:1px solid #ddd;padding:5px 7px;text-align:left;vertical-align:top;}
                th{background:#f4f4f7;font-weight:600;}
                .note{font-size:10px;color:#888;margin-top:14px;}
            </style></head><body>
            <h1>SecureVector — Redactions Report</h1>
            <div class="meta">Generated ${esc(stamp)} · Window: trailing ${esc(summary.window_days ?? this._state.windowDays)} days · Direction filter: ${esc(this._state.direction || 'all')}</div>
            <div class="headline"><strong>${summary.total ?? 0}</strong> redactions · <strong>${summary.distinct_tools ?? 0}</strong> distinct tools</div>
            ${breakdown('By direction', summary.by_direction)}
            ${breakdown('By secret type', summary.by_secret_type)}
            <h3 style="margin-top:18px;">Full event log</h3>
            <table><thead><tr>
                <th>Time</th><th>Direction</th><th>Pattern</th><th>Secret type</th><th>Source tool</th><th>Hash (SHA-256)</th>
            </tr></thead><tbody>${rowsHtml}</tbody></table>
            <div class="note">Methodology — All redactions performed by <code>redact_secrets()</code> in <code>src/securevector/app/utils/redaction.py</code>. PEM private-key and OpenSSH-binary patterns apply only to <code>direction='incoming'</code> (tool responses, RAG content). Always-on patterns (sk-, AKIA, ghp_, JWT, kv-pair, password) apply to every direction. PUBLIC KEY blocks are not redacted (not secrets). No raw secret values appear in this report — the Hash column is SHA-256 of the matched substring, persisted that way in <code>redaction_events</code>.</div>
            <script>setTimeout(()=>window.print(),200);<\/script>
            </body></html>`);
        win.document.close();
    },
};

window.RedactionsPage = RedactionsPage;
