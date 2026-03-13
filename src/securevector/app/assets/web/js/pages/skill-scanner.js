/**
 * Skill Scanner Page
 * Top: multi-path scan form. Bottom: history table (latest first).
 * Row click → SideDrawer with full scan detail.
 */

const SkillScannerPage = {
    _scanInProgress: false,

    async render(container) {
        container.textContent = '';
        if (window.Header) Header.setPageInfo('Skill Scanner', 'Scan OpenClaw skills for security risks before installing');

        // ── Scan form card ────────────────────────────────────────────────
        const formCard = document.createElement('div');
        formCard.className = 'card';
        formCard.style.cssText = 'margin-bottom: 20px;';
        container.appendChild(formCard);

        // Title row
        const titleRow = document.createElement('div');
        titleRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;';
        formCard.appendChild(titleRow);

        const formTitle = document.createElement('div');
        formTitle.style.cssText = 'font-size: 13px; font-weight: 600; color: var(--text-primary);';
        formTitle.textContent = 'Skill directory paths';
        titleRow.appendChild(formTitle);

        const addBtn = document.createElement('button');
        addBtn.className = 'btn';
        addBtn.style.cssText = 'font-size: 11px; padding: 3px 10px;';
        addBtn.textContent = '+ Add path';
        titleRow.appendChild(addBtn);

        // Dynamic path inputs container
        const pathsContainer = document.createElement('div');
        pathsContainer.style.cssText = 'display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px;';
        formCard.appendChild(pathsContainer);

        // Add a path input row and return its input element
        const addPathRow = (placeholder) => {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; align-items: center; gap: 6px;';

            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = placeholder || '~/.openclaw/skills/my-skill';
            input.className = 'form-input';
            input.style.cssText = 'flex: 1;';
            row.appendChild(input);

            const removeBtn = document.createElement('button');
            removeBtn.className = 'btn';
            removeBtn.style.cssText = 'font-size: 11px; padding: 3px 8px; flex-shrink: 0; color: var(--text-secondary);';
            removeBtn.title = 'Remove';
            removeBtn.textContent = '\u00D7';
            removeBtn.addEventListener('click', () => {
                if (pathsContainer.children.length > 1) row.remove();
            });
            row.appendChild(removeBtn);

            pathsContainer.appendChild(row);
            input.addEventListener('keydown', e => { if (e.key === 'Enter') scanBtn.click(); });
            return input;
        };

        // Start with one input row
        addPathRow();
        addBtn.addEventListener('click', () => {
            if (pathsContainer.children.length < 20) addPathRow();
        });

        // Scan button + status
        const actionRow = document.createElement('div');
        actionRow.style.cssText = 'display: flex; align-items: center; gap: 10px;';
        formCard.appendChild(actionRow);

        const scanBtn = document.createElement('button');
        scanBtn.className = 'btn btn-primary';
        scanBtn.textContent = 'Scan Skills';
        actionRow.appendChild(scanBtn);

        const statusSpan = document.createElement('span');
        statusSpan.style.cssText = 'font-size: 12px; color: var(--text-secondary); display: none;';
        actionRow.appendChild(statusSpan);

        const hint = document.createElement('div');
        hint.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-top: 8px;';
        hint.textContent = 'Static analysis only \u2014 no code is executed. Up to 20 paths at once. Results are saved to history.';
        formCard.appendChild(hint);

        // ── History table ─────────────────────────────────────────────────
        await this._renderHistoryTable(container);

        // ── Wire up scan button ───────────────────────────────────────────
        scanBtn.addEventListener('click', () => {
            const paths = Array.from(pathsContainer.querySelectorAll('input'))
                .map(i => i.value.trim())
                .filter(Boolean);
            this._runScan(paths, scanBtn, statusSpan, container);
        });
    },

    // =====================================================================
    // History table
    // =====================================================================

    async _renderHistoryTable(container) {
        const old = container.querySelector('.skill-scanner-table-section');
        if (old) old.remove();

        const section = document.createElement('div');
        section.className = 'skill-scanner-table-section';
        container.appendChild(section);

        // Toolbar
        const toolbar = document.createElement('div');
        toolbar.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;';
        section.appendChild(toolbar);

        const toolbarTitle = document.createElement('div');
        toolbarTitle.style.cssText = 'font-size: 14px; font-weight: 700; color: var(--text-primary);';
        toolbarTitle.textContent = 'Scan History';
        toolbar.appendChild(toolbarTitle);

        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'btn';
        refreshBtn.style.cssText = 'font-size: 11px; padding: 4px 10px;';
        refreshBtn.textContent = '\u21bb Refresh';
        refreshBtn.addEventListener('click', () => this._renderHistoryTable(container));
        toolbar.appendChild(refreshBtn);

        let data;
        try {
            const resp = await fetch('/api/skill-scans/history?limit=50&offset=0');
            data = await resp.json();
        } catch (e) {
            const err = document.createElement('div');
            err.style.cssText = 'color: var(--text-secondary); font-size: 13px; padding: 16px 0;';
            err.textContent = 'Failed to load scan history.';
            section.appendChild(err);
            return;
        }

        const records = data.records || [];

        if (records.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            const icon = document.createElement('div');
            icon.className = 'empty-state-icon';
            icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"/></svg>';
            const msg = document.createElement('div');
            msg.className = 'empty-state-text';
            msg.textContent = 'No scans yet \u2014 enter a skill path above and click Scan Skills.';
            empty.appendChild(icon);
            empty.appendChild(msg);
            section.appendChild(empty);
            return;
        }

        const wrapper = document.createElement('div');
        wrapper.className = 'table-wrapper';
        section.appendChild(wrapper);

        const table = document.createElement('table');
        table.className = 'data-table';
        wrapper.appendChild(table);

        const thead = document.createElement('thead');
        const hrow = document.createElement('tr');
        ['Skill', 'Path', 'Scanned', 'Risk', 'Findings', 'Manifest', 'Source'].forEach(h => {
            const th = document.createElement('th');
            th.textContent = h;
            hrow.appendChild(th);
        });
        thead.appendChild(hrow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        records.forEach(rec => tbody.appendChild(this._buildRow(rec, container)));
        table.appendChild(tbody);
    },

    _buildRow(rec, container) {
        const RISK_COLOR = { HIGH: '#ef4444', MEDIUM: '#f59e0b', LOW: '#10b981' };
        const rc = RISK_COLOR[rec.risk_level] || '#888';

        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';
        tr.title = 'Click to view full scan detail';

        const tdName = document.createElement('td');
        tdName.style.fontWeight = '600';
        tdName.textContent = rec.skill_name;
        tr.appendChild(tdName);

        const tdPath = document.createElement('td');
        const pathCode = document.createElement('code');
        pathCode.style.cssText = 'font-size: 11px; color: var(--text-secondary);';
        const maxLen = 38;
        pathCode.textContent = rec.scanned_path.length > maxLen
            ? '\u2026' + rec.scanned_path.slice(-maxLen) : rec.scanned_path;
        pathCode.title = rec.scanned_path;
        tdPath.appendChild(pathCode);
        tr.appendChild(tdPath);

        const tdTs = document.createElement('td');
        tdTs.style.cssText = 'white-space: nowrap; color: var(--text-secondary); font-size: 12px;';
        tdTs.textContent = this._relTime(rec.scan_timestamp);
        tdTs.title = new Date(rec.scan_timestamp).toLocaleString();
        tr.appendChild(tdTs);

        const tdRisk = document.createElement('td');
        const riskBadge = document.createElement('span');
        riskBadge.style.cssText = `background: ${rc}; color: #fff; border-radius: 3px; padding: 2px 8px; font-size: 11px; font-weight: 700;`;
        riskBadge.textContent = rec.risk_level;
        tdRisk.appendChild(riskBadge);
        tr.appendChild(tdRisk);

        const tdCount = document.createElement('td');
        tdCount.textContent = rec.findings_count;
        tr.appendChild(tdCount);

        const tdManifest = document.createElement('td');
        tdManifest.style.cssText = 'font-size: 12px; color: ' + (rec.manifest_present ? '#10b981' : 'var(--text-secondary)') + ';';
        tdManifest.textContent = rec.manifest_present ? '\u2713' : '\u2013';
        tr.appendChild(tdManifest);

        const tdSrc = document.createElement('td');
        const srcBadge = document.createElement('span');
        const isCli = rec.invocation_source === 'cli';
        srcBadge.style.cssText = 'font-size: 10px; font-weight: 600; border-radius: 3px; padding: 1px 6px; ' +
            (isCli ? 'background: rgba(99,102,241,0.15); color: #818cf8;'
                   : 'background: rgba(0,188,212,0.1); color: var(--accent-primary);');
        srcBadge.textContent = rec.invocation_source.toUpperCase();
        tdSrc.appendChild(srcBadge);
        tr.appendChild(tdSrc);

        tr.addEventListener('click', () => this._openDrawer(rec, container));
        return tr;
    },

    // =====================================================================
    // Side drawer
    // =====================================================================

    async _openDrawer(rec, container) {
        let data;
        try {
            const resp = await fetch(`/api/skill-scans/history/${rec.id}`);
            if (!resp.ok) return;
            data = await resp.json();
        } catch (e) { return; }

        const RISK_COLOR = { HIGH: '#ef4444', MEDIUM: '#f59e0b', LOW: '#10b981' };
        const RECS = {
            HIGH:   'DO NOT INSTALL',
            MEDIUM: 'REVIEW CAREFULLY \u2014 inspect all findings before installing',
            LOW:    'SAFE TO INSTALL',
        };
        const rc = RISK_COLOR[data.risk_level] || '#888';

        const wrap = document.createElement('div');
        wrap.style.cssText = 'display: flex; flex-direction: column; gap: 16px;';

        const section = (label, node) => {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';
            const lbl = document.createElement('div');
            lbl.style.cssText = 'font-size: 11px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.6px;';
            lbl.textContent = label;
            row.appendChild(lbl);
            if (typeof node === 'string') {
                const val = document.createElement('div');
                val.style.cssText = 'font-size: 13px; color: var(--text-primary);';
                val.textContent = node;
                row.appendChild(val);
            } else {
                row.appendChild(node);
            }
            return row;
        };

        // Risk banner
        const banner = document.createElement('div');
        banner.style.cssText = `display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-radius: 8px; background: ${rc}12; border: 1px solid ${rc}44;`;
        const riskLabel = document.createElement('div');
        riskLabel.style.cssText = `font-size: 22px; font-weight: 800; color: ${rc};`;
        riskLabel.textContent = data.risk_level;
        banner.appendChild(riskLabel);
        const recBadge = document.createElement('div');
        recBadge.style.cssText = `font-size: 12px; font-weight: 700; color: ${rc};`;
        recBadge.textContent = RECS[data.risk_level];
        banner.appendChild(recBadge);
        wrap.appendChild(banner);

        const metaGrid = document.createElement('div');
        metaGrid.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 10px;';
        metaGrid.appendChild(section('Skill', data.skill_name));
        metaGrid.appendChild(section('Scanned', new Date(data.scan_timestamp).toLocaleString()));
        metaGrid.appendChild(section('Findings', `${data.findings_count} finding${data.findings_count !== 1 ? 's' : ''}`));
        metaGrid.appendChild(section('Manifest', data.manifest_present ? 'Present \u2713' : 'Absent \u2013'));
        wrap.appendChild(metaGrid);
        wrap.appendChild(section('Path', data.scanned_path));

        if (data.findings && data.findings.length > 0) {
            const findingsWrap = document.createElement('div');
            const findingsLabel = document.createElement('div');
            findingsLabel.style.cssText = 'font-size: 11px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 6px;';
            findingsLabel.textContent = 'Findings';
            findingsWrap.appendChild(findingsLabel);

            data.findings.forEach(f => {
                const item = document.createElement('div');
                item.style.cssText = 'border-bottom: 1px solid var(--border-default, #333); padding: 8px 0;';
                const sevColor = { critical: '#ef4444', high: '#ef4444', medium: '#f59e0b', low: '#6b7280' }[f.severity] || '#6b7280';
                const loc = f.line_number ? `${f.file_path}:${f.line_number}` : (f.file_path || '');

                const topRow = document.createElement('div');
                topRow.style.cssText = 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;';

                const sevBadge = document.createElement('span');
                sevBadge.style.cssText = `background: ${sevColor}; color: #fff; border-radius: 3px; padding: 1px 5px; font-size: 10px; font-weight: 700;`;
                sevBadge.textContent = f.severity.toUpperCase();
                topRow.appendChild(sevBadge);

                const cat = document.createElement('strong');
                cat.style.cssText = 'font-size: 12px; color: var(--text-primary);';
                cat.textContent = f.category;
                topRow.appendChild(cat);

                if (loc) {
                    const locEl = document.createElement('span');
                    locEl.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-left: auto;';
                    locEl.textContent = loc;
                    topRow.appendChild(locEl);
                }
                item.appendChild(topRow);

                if (f.excerpt) {
                    const exc = document.createElement('code');
                    exc.style.cssText = 'display: block; font-size: 11px; color: var(--text-secondary); margin-top: 3px; white-space: pre-wrap; word-break: break-all;';
                    exc.textContent = f.excerpt;
                    item.appendChild(exc);
                }
                findingsWrap.appendChild(item);
            });
            wrap.appendChild(findingsWrap);
        } else {
            wrap.appendChild(section('Findings', 'No suspicious patterns detected.'));
        }

        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-danger';
        delBtn.style.cssText = 'margin-top: 4px; align-self: flex-start;';
        delBtn.textContent = 'Delete Record';
        delBtn.addEventListener('click', async () => {
            if (!confirm('Delete this scan record? This cannot be undone.')) return;
            await fetch(`/api/skill-scans/history/${data.id}`, { method: 'DELETE' });
            SideDrawer.close();
            await this._renderHistoryTable(container);
        });
        wrap.appendChild(delBtn);

        SideDrawer.show({ title: 'Scan Detail \u2014 ' + data.skill_name, content: wrap });
    },

    // =====================================================================
    // Scan execution (multi-path)
    // =====================================================================

    async _runScan(paths, btn, statusSpan, container) {
        if (this._scanInProgress) return;
        if (!paths.length) return;

        this._scanInProgress = true;
        btn.disabled = true;
        const label = paths.length === 1 ? 'Scanning\u2026' : `Scanning ${paths.length} skills\u2026`;
        btn.textContent = label;
        statusSpan.textContent = label;
        statusSpan.style.display = 'inline';

        try {
            const resp = await fetch('/api/skill-scans/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paths }),
            });

            if (!resp.ok) {
                const err = await resp.json().catch(() => ({ detail: resp.statusText }));
                if (window.Toast) Toast.show(err.detail || 'Scan failed.', 'error');
                return;
            }

            const data = await resp.json();

            // Show errors via toast
            data.results.filter(r => !r.success).forEach(r => {
                if (window.Toast) Toast.show(`${r.path}: ${r.error}`, 'error');
            });

            // Show warnings via toast
            data.results.filter(r => r.warning).forEach(r => {
                if (window.Toast) Toast.show(r.warning, 'warning');
            });

            // Open drawer for first successful result; if multiple open the last one
            const successes = data.results.filter(r => r.success && r.result);
            if (successes.length === 1) {
                await this._openDrawer(successes[0].result, container);
            } else if (successes.length > 1) {
                // Show summary toast then open last result
                if (window.Toast) Toast.show(`${successes.length} scans complete — showing last result`, 'success');
                await this._openDrawer(successes[successes.length - 1].result, container);
            }

            // Refresh history table
            await this._renderHistoryTable(container);

        } catch (e) {
            if (window.Toast) Toast.show(`Network error: ${e.message}`, 'error');
        } finally {
            this._scanInProgress = false;
            btn.disabled = false;
            btn.textContent = 'Scan Skills';
            statusSpan.style.display = 'none';
        }
    },

    // =====================================================================
    // Helpers
    // =====================================================================

    _relTime(isoStr) {
        const ms = Date.now() - new Date(isoStr).getTime();
        const s = Math.floor(ms / 1000);
        if (s < 60) return 'just now';
        const m = Math.floor(s / 60);
        if (m < 60) return `${m}m ago`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h}h ago`;
        const d = Math.floor(h / 24);
        return d < 7 ? `${d}d ago` : new Date(isoStr).toLocaleDateString();
    },

    destroy() {},
};

window.SkillScannerPage = SkillScannerPage;
