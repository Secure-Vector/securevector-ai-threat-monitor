/**
 * Redactions page — audit log of redact_secrets() matches.
 *
 * Sibling to Bill of Tools under Observability. Shows what got
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
    _state: { windowDays: 7, direction: '', secretType: '', runtimeKind: '', summary: null, events: [] },

    _runtimeLabel(slug) {
        if (!slug) return '—';
        const map = {
            'claude-code': 'Claude Code',
            'claude_code': 'Claude Code',
            'openclaw':    'OpenClaw',
            'langchain':   'LangChain',
            'langgraph':   'LangGraph',
            'crewai':      'CrewAI',
            'hermes':      'Hermes',
            'n8n':         'n8n',
            'ollama':      'Ollama',
            'proxy':       'Proxy (unattributed)',
            'unknown':     'unknown',
        };
        return map[slug] || slug;
    },

    async render(container) {
        // Each page owns its container — sibling pages (e.g. Tool Inventory)
        // do not clear it for us, so a stale render would otherwise stack
        // below ours.
        container.textContent = '';

        // Deep-link from Agent Runs ("view details →"): scope to one secret on
        // arrival; normal navigation clears any stale scope.
        if (this.pendingRequestId) { this._activeRequestId = this.pendingRequestId; this.pendingRequestId = null; }
        else { this._activeRequestId = null; }

        if (window.Header) {
            Header.setPageInfo(
                'Secret Detections',
                'Credentials & PII caught and scrubbed — only SHA-256 hashes stored, never raw values.'
            );
        }

        const page = document.createElement('div');
        page.className = 'page-wrapper';
        container.appendChild(page);

        if (this._activeRequestId) {
            const banner = document.createElement('div');
            banner.className = 'deep-link-banner';
            banner.innerHTML = `<span>Showing the secret detection from Traces (<code>${String(this._activeRequestId).replace(/[<>&"]/g, '')}</code>).</span>`;
            const clr = document.createElement('button');
            clr.className = 'deep-link-clear';
            clr.textContent = '✕ show all secrets';
            clr.addEventListener('click', () => { this._activeRequestId = null; this.render(container); });
            banner.appendChild(clr);
            page.appendChild(banner);
        }

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px;';

        const titleWrap = document.createElement('div');
        const subtitle = document.createElement('div');
        subtitle.style.cssText = 'font-size:12px;color:var(--text-secondary);max-width:780px;line-height:1.5;';
        // Bulleted format — auditors skim this page for the storage posture
        // and direction guarantees. Each bullet should answer ONE question.
        subtitle.innerHTML = [
            '<div style="margin-bottom:6px;color:var(--text-primary);font-weight:600;">No raw secret values are stored — only redactions and SHA-256 hashes.</div>',
            '<ul style="margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px;">',
            '<li>Every credential / PII match caught by <code style="font-family:monospace;">redact_secrets()</code> is scrubbed before it lands in <code style="font-family:monospace;">threat_intel_records</code>.</li>',
            '<li>The audit log itself stores only a hash, so the trail is safe to forward to a SIEM.</li>',
            '<li><span style="color:var(--text-primary);font-weight:600;">Direction-aware:</span> PEM-key and OpenSSH-binary patterns fire <em>only on incoming tool responses</em>; sk- / AKIA / ghp_ / JWT / password patterns fire on every direction.</li>',
            '</ul>',
        ].join('');
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

        // Harness filter — disambiguates Claude Code from OpenClaw etc.
        // Options are populated from the live by_runtime breakdown after the
        // first fetch (see _reload), so we only show runtimes that actually
        // have events in the window.
        const runtimeSelect = document.createElement('select');
        runtimeSelect.id = 'redactions-runtime-select';
        runtimeSelect.style.cssText = windowSelect.style.cssText;
        const allOpt = document.createElement('option');
        allOpt.value = '';
        allOpt.textContent = 'All harnesses';
        runtimeSelect.appendChild(allOpt);
        runtimeSelect.addEventListener('change', async () => {
            this._state.runtimeKind = runtimeSelect.value || '';
            await this._reload(tableMount, summaryMount, breakdownMount);
        });
        controls.appendChild(this._labelled('Harness:', runtimeSelect));

        // Export buttons pinned to the far right of the control row via
        // `margin-left: auto` — keeps them visually grouped and anchored
        // even when filters wrap to a second line on narrow widths.
        const exportGroup = document.createElement('div');
        exportGroup.style.cssText = 'display:flex;align-items:center;gap:8px;margin-left:auto;';

        const csvBtn = document.createElement('button');
        csvBtn.className = 'sv-btn-secondary';
        csvBtn.textContent = 'Export CSV';
        csvBtn.style.cssText = 'padding:6px 12px;font-size:12px;';
        csvBtn.title = 'Download the visible secret detections as CSV (hash only, never raw)';
        csvBtn.addEventListener('click', () => this._exportCsv());
        exportGroup.appendChild(csvBtn);

        const pdfBtn = document.createElement('button');
        pdfBtn.className = 'sv-btn-secondary';
        pdfBtn.textContent = 'Export PDF';
        pdfBtn.style.cssText = 'padding:6px 12px;font-size:12px;';
        pdfBtn.title = 'Open a print-ready view; use the browser print dialog to save as PDF';
        pdfBtn.addEventListener('click', () => this._exportPdf());
        exportGroup.appendChild(pdfBtn);

        controls.appendChild(exportGroup);

        // The control row lives on its own line below the subtitle so it can
        // span the full page width — that's what makes margin-left:auto on
        // the export group actually pin to the page's right edge instead of
        // the title row's right edge.
        page.appendChild(header);
        controls.style.cssText += 'width:100%;margin-bottom:12px;';
        page.appendChild(controls);

        // Headline tile — large, prominent total count. Differentiates this
        // page from Tool Inventory (which leads with a wide table). On
        // Redactions the page's story is the event count + breakdown; the
        // table below is the detail.
        const headlineMount = document.createElement('div');
        headlineMount.style.cssText = 'display:flex;gap:18px;flex-wrap:wrap;margin-bottom:16px;';
        page.appendChild(headlineMount);

        const breakdownMount = document.createElement('div');
        breakdownMount.style.cssText = 'display:flex;gap:18px;flex-wrap:wrap;margin-bottom:18px;';
        page.appendChild(breakdownMount);

        // Section heading above the event table — frames the rows below as
        // "the log" rather than the primary content of the page.
        const tableHeading = document.createElement('div');
        tableHeading.style.cssText = 'font-size:11px;text-transform:uppercase;letter-spacing:0.12em;color:var(--text-secondary);margin:6px 0 10px;font-weight:600;';
        tableHeading.textContent = 'Event log';
        page.appendChild(tableHeading);

        const tableMount = document.createElement('div');
        page.appendChild(tableMount);

        // Compat: pass headlineMount as the "summary" slot the existing
        // _reload signature uses.
        const summaryMount = headlineMount;

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
            runtimeKind: this._state.runtimeKind || null,
        });
        this._state.summary = data.summary;
        this._state.events = data.events || [];
        // Deep-link from an Agent Runs detection — scope the table to that one
        // secret's request_id so the user lands on exactly what was detected.
        if (this._activeRequestId) {
            this._state.events = this._state.events.filter(e => e.request_id === this._activeRequestId);
        }

        // Refresh the Harness filter options from the live by_runtime
        // breakdown — we only show runtimes that have at least one event.
        const runtimeSelect = document.getElementById('redactions-runtime-select');
        if (runtimeSelect) {
            const desired = this._state.runtimeKind || '';
            runtimeSelect.textContent = '';
            const all = document.createElement('option');
            all.value = '';
            all.textContent = 'All harnesses';
            runtimeSelect.appendChild(all);
            const runtimes = Object.keys(data.summary?.by_runtime || {});
            runtimes.sort();
            runtimes.forEach((slug) => {
                const opt = document.createElement('option');
                opt.value = slug === 'unknown' ? '' : slug;
                opt.textContent = `${this._runtimeLabel(slug)} (${data.summary.by_runtime[slug]})`;
                if (slug === desired) opt.selected = true;
                runtimeSelect.appendChild(opt);
            });
            runtimeSelect.value = desired;
        }

        // Headline tiles — big number cards above the table, so the page
        // visually leads with the event-count story (not yet-another table).
        // This is what distinguishes Redactions from Tool Inventory: the
        // table is supporting detail, not the page's primary content.
        const s = data.summary || {};
        summaryMount.textContent = '';

        const tile = (label, value, sublabel, accent) => {
            const t = document.createElement('div');
            t.style.cssText = `flex:1;min-width:200px;padding:16px 18px;background:var(--bg-secondary);border:1px solid var(--border-default);border-left:3px solid ${accent};border-radius:8px;`;
            const v = document.createElement('div');
            v.style.cssText = 'font-size:28px;font-weight:600;color:var(--text-primary);line-height:1;font-variant-numeric:tabular-nums;';
            v.textContent = String(value);
            const l = document.createElement('div');
            l.style.cssText = 'font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-secondary);margin-top:6px;';
            l.textContent = label;
            const sl = document.createElement('div');
            sl.style.cssText = 'font-size:11px;color:var(--text-secondary);margin-top:4px;';
            sl.textContent = sublabel;
            t.appendChild(v);
            t.appendChild(l);
            if (sublabel) t.appendChild(sl);
            return t;
        };

        const days = s.window_days ?? this._state.windowDays;
        // Theme is cyan + red — Detected (the headline metric) takes cyan;
        // From tool responses (the "credential made it across the LLM
        // boundary" alert) takes red. Distinct tools is a neutral count, so
        // we use a muted cyan tint to keep the trio in-palette.
        summaryMount.appendChild(tile(
            'Detected',
            s.total ?? 0,
            `secrets caught in the last ${days} day${days === 1 ? '' : 's'} — all redacted before storage`,
            'var(--accent-primary)'
        ));
        summaryMount.appendChild(tile(
            'Distinct tools',
            s.distinct_tools ?? 0,
            'sources we scrubbed from',
            // Neutral count → muted cyan (green is reserved for security-safe
            // states; a tool count is not a verdict).
            'color-mix(in srgb, var(--accent-primary) 40%, transparent)'
        ));
        const incomingCount = (s.by_direction || {}).incoming || 0;
        summaryMount.appendChild(tile(
            'From tool responses',
            incomingCount,
            'incoming-direction catches',
            'var(--danger)'
        ));

        // Breakdown bars (by direction + by secret type + by harness)
        breakdownMount.textContent = '';
        breakdownMount.appendChild(this._buildBreakdownCard('By direction', data.summary?.by_direction || {}));
        breakdownMount.appendChild(this._buildBreakdownCard('By secret type', data.summary?.by_secret_type || {}));
        // Map runtime slugs to friendly labels for the breakdown bars.
        const runtimeRaw = data.summary?.by_runtime || {};
        const runtimePretty = Object.fromEntries(
            Object.entries(runtimeRaw).map(([k, v]) => [this._runtimeLabel(k), v])
        );
        breakdownMount.appendChild(this._buildBreakdownCard('By harness', runtimePretty));

        // Table
        tableMount.textContent = '';
        if (!this._state.events.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding:36px;text-align:center;color:var(--text-secondary);font-size:13px;border:1px dashed var(--border-default);border-radius:8px;';
            empty.textContent = 'No secret detections in this window. Nothing scrubbed means nothing slipped through — or no scans ran yet.';
            tableMount.appendChild(empty);
            return;
        }

        const table = document.createElement('table');
        table.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px;';

        const thead = document.createElement('thead');
        const trh = document.createElement('tr');
        ['Time', 'Direction', 'Harness', 'Pattern', 'Secret type', 'Detected by', 'Source tool', 'Request', 'Hash'].forEach((l) => {
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
                ev.direction === 'incoming' ? 'background:rgba(239,68,68,0.15);color:var(--danger)'
              : ev.direction === 'outgoing' ? 'background:rgba(94,173,184,0.18);color:var(--accent-primary)'
              : 'background:rgba(148,163,184,0.15);color:var(--text-secondary)';
            tr.appendChild(cell(
                `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;${dirBadge};">${ev.direction}</span>`,
                { html: true }
            ));

            tr.appendChild(cell(this._runtimeLabel(ev.runtime_kind)));
            tr.appendChild(cell(ev.pattern_id || '—', { mono: true }));
            tr.appendChild(cell(ev.secret_type || '—'));
            // Rule (regex secret) / Rule+ML (request also ML-flagged) — Option 2.
            tr.appendChild(cell(
                DetectionLabel.htmlFromFields(ev.detection_source, ev.ml_score, ev.detection_rules) || '—',
                { html: true }
            ));
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
            bar.style.cssText = `flex:1;height:8px;background:linear-gradient(90deg, var(--accent-primary) ${(v / max) * 100}%, var(--border-default) ${(v / max) * 100}%);border-radius:4px;`;
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
            if (window.Toast) Toast.show('No secret detections in the selected window', 'info');
            return;
        }
        const headers = ['time', 'direction', 'harness', 'pattern_id', 'secret_type', 'source_tool', 'source_tool_id', 'request_id', 'redaction_hash'];
        const escape = (v) => {
            const s = String(v ?? '');
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const body = rows.map((r) => [
            r.redacted_at || '',
            r.direction || '',
            this._runtimeLabel(r.runtime_kind),
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
        a.download = `securevector-secret-detections-${stamp}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    },

    async _fetchLogoDataUrl() {
        // Fetch the SecureVector favicon PNG and inline as a base64 data
        // URL so the print preview never races with image loading and
        // the resulting PDF is self-contained (no external fetches when
        // the user saves it). Falls back to null on any error — the PDF
        // still generates, just without the logo.
        if (this._logoDataUrl !== undefined) return this._logoDataUrl;
        try {
            const resp = await fetch('/images/favicon.png');
            if (!resp.ok) throw new Error('favicon fetch failed');
            const blob = await resp.blob();
            this._logoDataUrl = await new Promise((resolve, reject) => {
                const r = new FileReader();
                r.onload = () => resolve(r.result);
                r.onerror = reject;
                r.readAsDataURL(blob);
            });
        } catch {
            this._logoDataUrl = null;
        }
        return this._logoDataUrl;
    },

    async _exportPdf() {
        const rows = this._state.events || [];
        const summary = this._state.summary || {};
        if (rows.length === 0) {
            if (window.Toast) Toast.show('No secret detections in the selected window', 'info');
            return;
        }
        const logoDataUrl = await this._fetchLogoDataUrl();
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
                    <span style="flex:1;height:6px;background:linear-gradient(90deg,#5eadb8 ${(v / max) * 100}%, #e3e6ee ${(v / max) * 100}%);"></span>
                    <span style="flex:0 0 40px;text-align:right;">${v}</span>
                 </div>`).join('');
            return `<div style="margin-bottom:12px;"><h3 style="font-size:12px;margin:0 0 6px;text-transform:uppercase;letter-spacing:0.08em;color:#666;">${esc(title)}</h3>${items}</div>`;
        };

        const rowsHtml = rows.map((r) => `<tr>
            <td>${esc(r.redacted_at || '')}</td>
            <td>${esc(r.direction || '')}</td>
            <td>${esc(this._runtimeLabel(r.runtime_kind))}</td>
            <td>${esc(r.pattern_id || '')}</td>
            <td>${esc(r.secret_type || '')}</td>
            <td>${esc(r.source_tool_id || r.source_tool || '')}</td>
            <td style="font-family:monospace;font-size:9px;">${esc(r.redaction_hash || '')}</td>
        </tr>`).join('');

        const logoImg = logoDataUrl
            ? `<img src="${logoDataUrl}" alt="SecureVector" style="width:42px;height:42px;flex:0 0 42px;"/>`
            : '';
        win.document.write(`<!doctype html><html><head><meta charset="utf-8">
            <title>SecureVector — Secret Detections (${esc(stamp)})</title>
            <style>
                body{font-family:-apple-system,Segoe UI,sans-serif;margin:24px;color:#111;}
                .brand{display:flex;align-items:center;gap:14px;border-bottom:1px solid #e3e6ee;padding-bottom:14px;margin-bottom:18px;}
                .brand-text h1{font-size:20px;margin:0 0 2px;letter-spacing:-0.01em;}
                .brand-text .product{font-size:11px;text-transform:uppercase;letter-spacing:0.12em;color:#5eadb8;font-weight:600;}
                .meta{font-size:11px;color:#666;margin-bottom:14px;}
                .headline{font-size:14px;margin:8px 0 16px;padding:10px 12px;background:#f4f4f7;border-radius:6px;}
                table{width:100%;border-collapse:collapse;font-size:11px;margin-top:14px;}
                th,td{border:1px solid #ddd;padding:5px 7px;text-align:left;vertical-align:top;}
                th{background:#f4f4f7;font-weight:600;}
                .note{font-size:10px;color:#888;margin-top:14px;}
            </style></head><body>
            <div class="brand">
                ${logoImg}
                <div class="brand-text">
                    <div class="product">SecureVector · AI Threat Monitor</div>
                    <h1>Secret Detections</h1>
                </div>
            </div>
            <div class="meta">Generated ${esc(stamp)} · Window: trailing ${esc(summary.window_days ?? this._state.windowDays)} days · Direction filter: ${esc(this._state.direction || 'all')}</div>
            <div class="headline"><strong>${summary.total ?? 0}</strong> secrets detected and redacted · <strong>${summary.distinct_tools ?? 0}</strong> distinct tools · <strong>no raw secret values</strong> in this report</div>
            ${breakdown('By direction', summary.by_direction)}
            ${breakdown('By secret type', summary.by_secret_type)}
            ${breakdown('By harness', Object.fromEntries(Object.entries(summary.by_runtime || {}).map(([k, v]) => [this._runtimeLabel(k), v])))}
            <h3 style="margin-top:18px;">Full event log</h3>
            <table><thead><tr>
                <th>Time</th><th>Direction</th><th>Harness</th><th>Pattern</th><th>Secret type</th><th>Source tool</th><th>Hash (SHA-256)</th>
            </tr></thead><tbody>${rowsHtml}</tbody></table>
            <div class="note">Methodology — Every detection in this report was redacted from content before persistence; <strong>no raw secret values ever land in <code>threat_intel_records</code>, the audit log, or this PDF</strong>. Detection performed by <code>redact_secrets()</code> in <code>src/securevector/app/utils/redaction.py</code>. PEM private-key and OpenSSH-binary patterns apply only to <code>direction='incoming'</code> (tool responses, RAG content). Always-on patterns (sk-, AKIA, ghp_, JWT, kv-pair, password) apply to every direction. PUBLIC KEY blocks are not redacted (not secrets). The Hash column is SHA-256 of the matched substring, persisted that way in <code>redaction_events</code> — auditors can prove a specific match by hash without the underlying secret ever leaving the device.</div>
            <script>setTimeout(()=>window.print(),200);<\/script>
            </body></html>`);
        win.document.close();
    },
};

window.RedactionsPage = RedactionsPage;
