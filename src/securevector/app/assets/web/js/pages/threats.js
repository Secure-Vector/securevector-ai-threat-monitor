/**
 * Threats Page
 * Threat analytics and intel listing
 */

const ThreatsPage = {
    data: null,
    categories: [],
    autoRefreshInterval: null,
    autoRefreshEnabled: false,
    selectedIds: new Set(),
    sortColumn: 'first_seen',
    sortDirection: 'desc',
    filters: {
        page: 1,
        page_size: 20,
        threat_type: '',
        min_risk: 0,
        // Bundle 0.3 — multi-agent dashboard slice. Filter the threats table
        // by source identifier (the `source` arg the SDK passes on /analyze
        // calls — typically the agent / process / project name). Backend
        // route already accepts ?source= so this is purely a UI surfacing.
        source: '',
    },

    // Deep-link target — set by Agent Runs when the user clicks a detection
    // ("view details →"). Filters the table to that one record's request_id.
    pendingRequestId: null,

    /** v5 look — masthead stat strip + toolbar pills. Shared export-menu CSS
     *  (`sv-export-*`) lives in ObsTabs' stylesheet, injected explicitly
     *  because this page doesn't render the obs tab strip. */
    _injectStyle() {
        if (window.ObsTabs) ObsTabs._injectStyle();
        if (document.getElementById('threats-style')) return;
        const st = document.createElement('style');
        st.id = 'threats-style';
        st.textContent = `
            .tm-masthead { display:flex; align-items:stretch; gap:0; margin:0 0 14px;
                border:1px solid var(--border-default,#30363d); border-radius:10px;
                background:var(--bg-card,#161b22); overflow:hidden; }
            .tm-stat { flex:1 1 0; padding:14px 18px 12px; border-left:1px solid var(--border-default,#30363d); }
            .tm-stat:first-child { border-left:none; }
            .tm-stat-v { font:700 22px ui-monospace,'JetBrains Mono',Menlo,monospace;
                color:var(--text-primary,#e6edf3); letter-spacing:.3px; }
            .tm-stat-l { font:700 10.5px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.8px;
                text-transform:uppercase; color:var(--text-secondary,#b1bac4); margin-top:3px; }
            .tm-stat-d { font:500 11px 'Avenir Next',Avenir,system-ui,sans-serif;
                color:var(--text-muted,#7d8590); margin-top:2px; }
            .tm-stat.danger { background:rgba(239,68,68,0.07); }
            .tm-stat.danger .tm-stat-v, .tm-stat.danger .tm-stat-l { color:#ef4444; }
            /* Auto-refresh pill — teal = activity accent when armed. */
            .tm-auto { display:inline-flex; align-items:center; gap:7px; cursor:pointer;
                border:1px solid var(--border-default,#30363d); border-radius:999px; padding:6px 13px;
                background:var(--bg-tertiary,#21262d); color:var(--text-secondary,#b1bac4);
                font:600 12px 'Avenir Next',Avenir,system-ui,sans-serif; white-space:nowrap;
                transition:border-color .14s,color .14s,background .14s; }
            .tm-auto:hover { border-color:var(--accent-primary,#5eadb8); color:var(--text-primary,#e6edf3); }
            .tm-auto .tm-auto-dot { width:7px; height:7px; border-radius:50%;
                background:var(--text-muted,#7d8590); flex:0 0 auto; }
            .tm-auto.on { border-color:var(--accent-primary,#5eadb8); color:var(--accent-primary,#5eadb8);
                background:color-mix(in srgb, var(--accent-primary,#5eadb8) 10%, var(--bg-tertiary,#21262d)); }
            .tm-auto.on .tm-auto-dot { background:var(--accent-primary,#5eadb8);
                animation:tmAutoPulse 1.6s ease-in-out infinite; }
            @keyframes tmAutoPulse { 0%,100% { opacity:1; } 50% { opacity:.35; } }
            @media (prefers-reduced-motion: reduce) { .tm-auto.on .tm-auto-dot { animation:none; } }
            /* Content preview — mono, quiet; JSON payloads get a small tag so
               a raw envelope reads as intentional, not broken. */
            /* Cap the Content column so Time + Action never get pushed off
               the right edge — the full text lives in the tooltip + details. */
            .tm-preview { display:inline-flex; align-items:center; gap:7px; max-width:340px; }
            .tm-preview code { min-width:0; }
            .tm-payload-tag { font:700 9px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.6px;
                text-transform:uppercase; color:var(--text-muted,#7d8590);
                border:1px solid var(--border-default,#30363d); border-radius:4px;
                padding:1px 5px; flex:0 0 auto; }
            .tm-preview code { font:12px ui-monospace,'JetBrains Mono',Menlo,monospace;
                color:var(--text-secondary,#b1bac4); overflow:hidden; text-overflow:ellipsis;
                white-space:nowrap; background:none; padding:0; }
        `;
        document.head.appendChild(st);
    },

    async render(container) {
        container.textContent = '';
        this.selectedIds.clear();
        this._injectStyle();

        if (window.Header) Header.setPageInfo('Threat Monitor', 'All LLM requests analyzed for threats');

        // Honor a deep-link from Agent Runs: scope the table to the clicked
        // detection's request_id and show a dismissable banner.
        if (this.pendingRequestId) {
            this.filters.request_id = this.pendingRequestId;
            this.filters.page = 1;
            this.pendingRequestId = null;
        } else {
            // Normal navigation — don't carry a stale deep-link filter forward.
            this.filters.request_id = null;
        }
        if (this.filters.request_id) {
            const banner = document.createElement('div');
            banner.className = 'deep-link-banner';
            banner.innerHTML = `<span>Showing the detection from Traces (<code>${String(this.filters.request_id).replace(/[<>&"]/g, '')}</code>).</span>`;
            const clear = document.createElement('button');
            clear.textContent = '✕ show all threats';
            clear.className = 'deep-link-clear';
            clear.addEventListener('click', () => { this.filters.request_id = null; this.render(container); });
            banner.appendChild(clear);
            container.appendChild(banner);
        }

        // Filters bar (will be populated after loading categories)
        const filtersBar = document.createElement('div');
        filtersBar.className = 'filters-bar';
        filtersBar.id = 'threats-filters';
        container.appendChild(filtersBar);

        // Content area
        const content = document.createElement('div');
        content.id = 'threats-content';
        container.appendChild(content);

        // Load data first, then build filters from available categories
        await this.loadData();
        this.buildFiltersBar();
    },

    buildFiltersBar() {
        const bar = document.getElementById('threats-filters');
        if (!bar) return;

        bar.textContent = '';

        // Threat type filter - populated from database categories
        const typeGroup = document.createElement('div');
        typeGroup.className = 'filter-group';

        const typeLabel = document.createElement('label');
        typeLabel.textContent = 'Type';
        typeGroup.appendChild(typeLabel);

        const typeSelect = document.createElement('select');
        typeSelect.className = 'filter-select';
        typeSelect.id = 'threat-type-filter';

        // Default option
        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = 'All Types';
        typeSelect.appendChild(defaultOption);

        // Add categories from data
        const uniqueTypes = this.getUniqueCategories();
        uniqueTypes.forEach(type => {
            const option = document.createElement('option');
            option.value = type;
            option.textContent = this.formatCategoryLabel(type);
            if (type === this.filters.threat_type) {
                option.selected = true;
            }
            typeSelect.appendChild(option);
        });

        typeSelect.addEventListener('change', (e) => {
            this.filters.threat_type = e.target.value;
            this.filters.page = 1;
            this.loadData();
        });

        typeGroup.appendChild(typeSelect);
        bar.appendChild(typeGroup);

        // Source / Agent filter — populated from distinct sources in the
        // currently-loaded page of threats. For larger fleets this stops
        // being exhaustive (only sees the current page); the dropdown
        // gains an "(All sources)" entry plus whatever appeared in the
        // last load. Refines without a server round-trip.
        const srcGroup = document.createElement('div');
        srcGroup.className = 'filter-group';

        const srcLabel = document.createElement('label');
        srcLabel.textContent = 'Agent / Source';
        srcGroup.appendChild(srcLabel);

        const srcSelect = document.createElement('select');
        srcSelect.className = 'filter-select';
        srcSelect.id = 'threat-source-filter';

        const srcDefault = document.createElement('option');
        srcDefault.value = '';
        srcDefault.textContent = 'All Sources';
        srcSelect.appendChild(srcDefault);

        const uniqueSources = this.getUniqueSources();
        uniqueSources.forEach(src => {
            const option = document.createElement('option');
            option.value = src;
            option.textContent = src;
            if (src === this.filters.source) {
                option.selected = true;
            }
            srcSelect.appendChild(option);
        });

        srcSelect.addEventListener('change', (e) => {
            this.filters.source = e.target.value;
            this.filters.page = 1;
            this.loadData();
        });

        srcGroup.appendChild(srcSelect);
        bar.appendChild(srcGroup);

        // Min risk filter
        const riskGroup = document.createElement('div');
        riskGroup.className = 'filter-group';

        const riskLabel = document.createElement('label');
        riskLabel.textContent = 'Min Risk';
        riskGroup.appendChild(riskLabel);

        const riskSelect = document.createElement('select');
        riskSelect.className = 'filter-select';

        const risks = [
            { value: 0, label: 'All' },
            { value: 40, label: 'Medium+' },
            { value: 60, label: 'High+' },
            { value: 80, label: 'Critical' },
        ];

        risks.forEach(risk => {
            const option = document.createElement('option');
            option.value = risk.value;
            option.textContent = risk.label;
            if (risk.value === this.filters.min_risk) {
                option.selected = true;
            }
            riskSelect.appendChild(option);
        });

        riskSelect.addEventListener('change', (e) => {
            this.filters.min_risk = parseInt(e.target.value, 10);
            this.filters.page = 1;
            this.loadData();
        });

        riskGroup.appendChild(riskSelect);
        bar.appendChild(riskGroup);

        // Spacer to push buttons to right
        const spacer = document.createElement('div');
        spacer.className = 'filter-spacer';
        bar.appendChild(spacer);

        // Delete Selected button (hidden by default)
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'btn btn-danger';
        deleteBtn.id = 'delete-selected-btn';
        deleteBtn.style.display = 'none';
        deleteBtn.textContent = 'Delete Selected (0)';
        const self = this;
        deleteBtn.onclick = function() {
            self.confirmDeleteSelected();
        };
        bar.appendChild(deleteBtn);

        // Auto-refresh pill — teal + pulsing dot while armed (activity accent,
        // matching the LIVE treatment on Traces).
        const refreshBtn = document.createElement('button');
        refreshBtn.type = 'button';
        refreshBtn.className = 'tm-auto' + (this.autoRefreshEnabled ? ' on' : '');
        refreshBtn.innerHTML = '<span class="tm-auto-dot"></span>Auto-refresh';
        refreshBtn.title = 'Refresh the table every 30 seconds';
        refreshBtn.addEventListener('click', () => {
            this.toggleAutoRefresh();
            refreshBtn.classList.toggle('on', this.autoRefreshEnabled);
        });
        bar.appendChild(refreshBtn);

        // One Export dropdown — same component as Traces / Blocked Actions.
        bar.appendChild(ObsTabs.exportMenu([
            { label: 'CSV', onClick: () => this.exportToCSV() },
            { label: 'PDF report', onClick: () => this.exportToPDF() },
        ]));
    },

    async exportToCSV() {
        // Always fetch fresh so the export doesn't depend on what's currently
        // paginated in the table. Applies the active filters so exported rows
        // match what the user is filtering.
        let items = [];
        try {
            const params = Object.assign({}, this.filters || {}, { page: 1, page_size: 5000 });
            const data = await API.getThreats(params);
            items = (data && (data.items || data.threats)) || [];
        } catch (e) {
            items = (this.data && (this.data.items || this.data.threats)) || [];
        }

        if (items.length === 0) {
            alert('No threats to export.');
            return;
        }

        const headers = [
            'id', 'created_at', 'is_threat', 'threat_type', 'risk_score',
            'confidence', 'action_taken', 'source_identifier', 'text_preview', 'matched_rules'
        ];
        const esc = (v) => {
            if (v === null || v === undefined) return '';
            const s = String(v);
            if (s.includes('"') || s.includes(',') || s.includes('\n')) {
                return '"' + s.replace(/"/g, '""') + '"';
            }
            return s;
        };
        const rows = items.map(t => {
            const rules = (t.matched_rules || []).map(r => r.rule_id || r.rule_name || '').join('; ');
            return [
                t.id, t.created_at, t.is_threat, t.threat_type, t.risk_score,
                t.confidence, t.action_taken, t.source_identifier, (t.text_preview || '').slice(0, 500),
                rules,
            ].map(esc).join(',');
        });
        const csv = headers.join(',') + '\n' + rows.join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `securevector-threats-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    },

    updateDeleteButton() {
        const btn = document.getElementById('delete-selected-btn');
        if (!btn) return;

        const count = this.selectedIds.size;
        if (count > 0) {
            btn.style.display = 'inline-flex';
            btn.textContent = `Delete Selected (${count})`;
        } else {
            btn.style.display = 'none';
        }
        const tbl = document.getElementById('threats-data-table');
        if (tbl) tbl.classList.toggle('has-selection', count > 0);
    },

    toggleSelectAll(checked) {
        const threats = this.data?.items || [];
        if (checked) {
            threats.forEach(t => this.selectedIds.add(t.id));
        } else {
            this.selectedIds.clear();
        }

        // Update all checkboxes
        document.querySelectorAll('.threat-checkbox').forEach(cb => {
            cb.checked = checked;
        });

        this.updateDeleteButton();
    },

    toggleSelect(id, checked) {
        if (checked) {
            this.selectedIds.add(id);
        } else {
            this.selectedIds.delete(id);
        }

        // Update select-all checkbox state
        const selectAllCb = document.getElementById('select-all-checkbox');
        if (selectAllCb) {
            const threats = this.data?.items || [];
            selectAllCb.checked = threats.length > 0 && this.selectedIds.size === threats.length;
            selectAllCb.indeterminate = this.selectedIds.size > 0 && this.selectedIds.size < threats.length;
        }

        this.updateDeleteButton();
    },

    confirmDeleteSelected() {
        const count = this.selectedIds.size;

        if (count === 0) {
            alert('No records selected');
            return;
        }

        // Use native confirm for reliability
        const confirmed = confirm(`Delete ${count} selected record${count !== 1 ? 's' : ''}?\n\nThis action cannot be undone.`);

        if (confirmed) {
            this.deleteSelectedRecords();
        }
    },

    async deleteSelectedRecords() {
        try {
            const ids = Array.from(this.selectedIds);
            const response = await fetch('/api/threat-intel', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: ids })
            });

            if (!response.ok) {
                throw new Error('Failed to delete records');
            }

            const result = await response.json();
            if (window.Toast) Toast.success(`Deleted ${result.deleted} record${result.deleted !== 1 ? 's' : ''}`);
            this.selectedIds.clear();
            this.filters.page = 1;
            await this.loadData();
            this.buildFiltersBar();
        } catch (error) {
            console.error('Failed to delete records:', error);
            if (window.Toast) Toast.error('Failed to delete records');
        }
    },

    toggleAutoRefresh() {
        this.autoRefreshEnabled = !this.autoRefreshEnabled;
        if (this.autoRefreshEnabled) {
            this.autoRefreshInterval = setInterval(() => {
                this.loadData();
            }, getPollInterval());
            const _sec = Math.round(getPollInterval() / 1000);
            if (window.Toast) Toast.info(`Auto refresh enabled (${_sec}s)`);
        } else {
            if (this.autoRefreshInterval) {
                clearInterval(this.autoRefreshInterval);
                this.autoRefreshInterval = null;
            }
            if (window.Toast) Toast.info('Auto refresh disabled');
        }
    },

    exportToPDF() {
        const threats = this.data?.items || [];
        if (threats.length === 0) {
            if (window.Toast) Toast.warning('No threats to export');
            return;
        }
        const pdfContent = this.generatePDFContent(threats);
        const blob = new Blob([pdfContent], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const printWindow = window.open(url, '_blank');
        if (printWindow) {
            printWindow.onload = function() {
                setTimeout(() => {
                    printWindow.print();
                    URL.revokeObjectURL(url);
                }, 500);
            };
        }
    },

    generatePDFContent(threats) {
        const escapeHtml = (text) => {
            if (!text) return '';
            return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        };
        let rows = '';
        threats.forEach(threat => {
            const riskClass = threat.risk_score >= 80 ? 'risk-high' : threat.risk_score >= 40 ? 'risk-medium' : 'risk-low';
            const content = escapeHtml((threat.text_preview || threat.text_content || '').substring(0, 100));
            const llmStatus = threat.llm_reviewed ? (threat.llm_agrees ? 'Confirmed' : 'Disputed') : 'Not Reviewed';
            const date = threat.created_at ? this.formatDate(threat.created_at).split(' ')[0] : '-';
            rows += '<tr><td>' + content + '</td><td>' + escapeHtml(threat.threat_type || 'No Threat Detected') + '</td><td class="' + riskClass + '">' + threat.risk_score + '%</td><td>' + llmStatus + '</td><td>' + date + '</td></tr>';
        });
        let details = '';
        threats.filter(t => t.risk_score >= 60).forEach(threat => {
            const riskClass = threat.risk_score >= 80 ? 'risk-high' : 'risk-medium';
            details += '<div class="threat"><div class="threat-header"><strong>' + escapeHtml(threat.threat_type || 'No Threat Detected') + '</strong><span class="' + riskClass + '">' + threat.risk_score + '% Risk</span></div>';
            details += '<p><span class="label">Content:</span> ' + escapeHtml(threat.text_content || threat.text_preview || '') + '</p>';
            if (threat.llm_reviewed) {
                details += '<div class="llm-section"><strong>LLM Analysis (' + escapeHtml(threat.llm_model_used || 'AI') + '):</strong><br>' + escapeHtml(threat.llm_explanation || threat.llm_reasoning || 'No explanation') + '<br><em>Recommendation: ' + escapeHtml(threat.llm_recommendation || 'N/A') + '</em></div>';
            }
            details += '</div>';
        });
        return '<!DOCTYPE html><html><head><title>SecureVector Threat Report</title><style>body{font-family:Arial,sans-serif;padding:20px}h1{color:#1a1a2e;border-bottom:2px solid #5eadb8;padding-bottom:10px}h2{color:#16213e;margin-top:30px}.threat{border:1px solid #ddd;padding:15px;margin:10px 0;border-radius:8px}.threat-header{display:flex;justify-content:space-between;margin-bottom:10px}.risk-high{color:#ef4444;font-weight:bold}.risk-medium{color:#f59e0b;font-weight:bold}.risk-low{color:#22c55e;font-weight:bold}.label{color:#666;font-size:12px}.llm-section{background:#f5f5f5;padding:10px;margin-top:10px;border-radius:4px}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#1a1a2e;color:white}.summary{background:#e8f4f8;padding:15px;border-radius:8px;margin-bottom:20px}</style></head><body><h1>SecureVector Threat Report</h1><p>Generated: ' + new Date().toLocaleString() + '</p><div class="summary"><strong>Summary:</strong> ' + threats.length + ' threats<br>Critical: ' + threats.filter(t => t.risk_score >= 80).length + ' | High: ' + threats.filter(t => t.risk_score >= 60 && t.risk_score < 80).length + ' | Medium: ' + threats.filter(t => t.risk_score >= 40 && t.risk_score < 60).length + ' | Low: ' + threats.filter(t => t.risk_score < 40).length + '</div><table><thead><tr><th>Content</th><th>Type</th><th>Risk</th><th>LLM</th><th>Date</th></tr></thead><tbody>' + rows + '</tbody></table><h2>High Risk Details</h2>' + details + '</body></html>';
    },

    getUniqueCategories() {
        // Get unique threat types from loaded data
        const items = this.data?.items || [];
        const types = new Set();

        items.forEach(item => {
            if (item.threat_type) {
                types.add(item.threat_type);
            }
        });

        return Array.from(types).sort();
    },

    getUniqueSources() {
        // Bundle 0.3 — collect distinct source identifiers from the loaded
        // page of threats so the filter dropdown is self-populating. Falls
        // through to an empty list on first render before any data lands.
        const items = this.data?.items || [];
        const sources = new Set();
        items.forEach(item => {
            if (item.source_identifier && String(item.source_identifier).trim()) {
                sources.add(String(item.source_identifier));
            }
        });
        return Array.from(sources).sort();
    },

    formatCategoryLabel(category) {
        // Convert snake_case to Title Case
        if (!category) return 'No Threat Detected';
        return category
            .split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    },

    async loadData() {
        const content = document.getElementById('threats-content');
        if (!content) return;

        content.textContent = '';

        // Loading state
        const loading = document.createElement('div');
        loading.className = 'loading-container';
        const spinner = document.createElement('div');
        spinner.className = 'spinner';
        loading.appendChild(spinner);
        content.appendChild(loading);

        try {
            this.data = await API.getThreats(this.filters);
            this.renderContent(content);
        } catch (error) {
            this.renderError(content, error);
        }
    },

    renderContent(container) {
        container.textContent = '';

        const threats = this.data.items || this.data.threats || [];

        if (threats.length === 0) {
            this.renderEmptyState(container);
            return;
        }

        // Masthead stat strip — same treatment as the Traces detail masthead.
        // Reviewed/token/high-risk counts come from the loaded page of rows,
        // so they say "on this page" whenever pagination truncates the view.
        const paged = (this.data.total_pages || 1) > 1;
        const pageNote = paged ? 'on this page · ' : '';
        const llmReviewed = threats.filter(t => t.llm_reviewed).length;
        const totalTokens = threats.reduce((sum, t) => sum + (t.llm_tokens_used || 0), 0);
        const highRisk = threats.filter(t => t.risk_score >= 60).length;
        const stat = (v, label, det, cls) =>
            `<div class="tm-stat${cls ? ' ' + cls : ''}"><div class="tm-stat-v">${v}</div>` +
            `<div class="tm-stat-l">${label}</div>` + (det ? `<div class="tm-stat-d">${det}</div>` : '') + `</div>`;
        const mast = document.createElement('div');
        mast.className = 'tm-masthead';
        mast.innerHTML =
            stat((this.data.total || threats.length).toLocaleString(), 'analyzed requests',
                (this.filters.threat_type || this.filters.source || this.filters.min_risk || this.filters.request_id)
                    ? 'matching your filters' : 'everything scanned') +
            stat(highRisk.toLocaleString(), 'high risk',
                pageNote + 'risk ≥ 60% — review these first', highRisk ? 'danger' : '') +
            stat(llmReviewed.toLocaleString(), 'AI-reviewed',
                pageNote + (llmReviewed ? totalTokens.toLocaleString() + ' analysis tokens' : 'AI Analysis adds a second opinion'));
        container.appendChild(mast);

        // Threats table
        const self = this;
        const threatsDt = new DataTable({
            columns: [
                { key: 'indicator', label: 'Content', sortable: true, render: (_, threat) => {
                    // JSON envelopes (tool payloads) get a small "payload" tag
                    // so a raw `{"type":"text"…` preview reads as intentional.
                    // The full (redacted) text stays in the tooltip either way.
                    const text = threat.indicator || threat.name || threat.text_preview || threat.text || 'Unknown';
                    const wrap = document.createElement('span');
                    wrap.className = 'tm-preview';
                    wrap.title = text;
                    if (/^[\[{]/.test(text.trim())) {
                        const tag = document.createElement('span');
                        tag.className = 'tm-payload-tag';
                        tag.textContent = 'payload';
                        tag.title = 'The analyzed content was a structured tool payload — this is its raw (redacted) preview';
                        wrap.appendChild(tag);
                    }
                    const code = document.createElement('code');
                    code.textContent = text.length > 60 ? text.substring(0, 60) + '...' : text;
                    wrap.appendChild(code);
                    return wrap;
                }},
                { key: 'threat_type', label: 'Type', sortable: true, render: (_, threat) => {
                    const wrap = document.createDocumentFragment();
                    const threatType = threat.threat_type || 'No Threat Detected';
                    const isOutput = threatType.startsWith('output_');
                    if (isOutput) {
                        const lbl = document.createElement('span');
                        lbl.className = 'output-scan-label'; lbl.textContent = 'OUTPUT';
                        wrap.appendChild(lbl);
                    }
                    const badge = document.createElement('span');
                    badge.className = 'type-badge' + (isOutput ? ' output-scan' : '');
                    badge.textContent = isOutput ? threatType.replace('output_', '') : threatType;
                    const phrase = self._TYPE_PHRASE[threatType.replace('output_', '')];
                    if (phrase) {
                        badge.title = 'In plain terms: ' + phrase
                            + (isOutput ? ' — found in a tool/LLM response, not the prompt.' : '.');
                    }
                    wrap.appendChild(badge);
                    return wrap;
                }},
                { key: 'detected_by', label: 'Detected by', sortable: false, render: (_, threat) => {
                    // Rule / ML / Rule+ML badge — hover says exactly what caught
                    // it (+ ML score). Derived from the persisted matched_rules.
                    return DetectionLabel.badge(threat.matched_rules) || '-';
                }},
                { key: 'risk_score', label: 'Risk Score', sortable: true, defaultDir: 'desc', render: (_, threat) => {
                    const wrap = document.createDocumentFragment();
                    const row = document.createElement('div');
                    row.style.cssText = 'display: flex; align-items: center; gap: 8px;';
                    const badge = document.createElement('span');
                    badge.className = 'risk-badge risk-' + self.getRiskLevel(threat.risk_score);
                    badge.textContent = (threat.risk_score || 0) + '%';
                    badge.title = 'Rule-driven risk score: 70%+ reads high (red), 40–69% medium (amber), under 40 low (green).';
                    row.appendChild(badge);
                    const pct = Math.min(threat.risk_score || 0, 100);
                    const barColor = pct >= 70 ? '#ef4444' : pct >= 40 ? '#f59e0b' : '#10b981';
                    const bar = document.createElement('div');
                    bar.style.cssText = 'width: 40px; height: 4px; border-radius: 2px; background: var(--bg-tertiary); overflow: hidden; flex-shrink: 0;';
                    const fill = document.createElement('div');
                    fill.style.cssText = `height: 100%; border-radius: 2px; background: ${barColor}; width: ${pct}%;`;
                    bar.appendChild(fill); row.appendChild(bar); wrap.appendChild(row);
                    if (threat.llm_reviewed) {
                        const llm = document.createElement('span'); llm.className = 'llm-badge'; llm.textContent = 'LLM';
                        llm.title = 'Reviewed by ' + (threat.llm_model_used || 'LLM'); wrap.appendChild(llm);
                        if (threat.llm_tokens_used > 0) {
                            const tok = document.createElement('span'); tok.className = 'tokens-badge';
                            tok.textContent = threat.llm_tokens_used.toLocaleString() + ' tokens'; wrap.appendChild(tok);
                        }
                    }
                    return wrap;
                }},
                { key: 'user_agent', label: 'Client', sortable: true, render: (_, threat) => {
                    const name = self.parseUserAgent(threat.user_agent);
                    if (name) {
                        const b = document.createElement('span'); b.className = 'client-badge';
                        b.textContent = name; b.title = threat.user_agent || ''; return b;
                    }
                    return '-';
                }},
                { key: 'first_seen', label: 'Time', sortable: true, defaultDir: 'desc', render: (_, threat) =>
                    self.formatDate(threat.first_seen || threat.created_at)
                },
                { key: 'action_taken', label: 'Action', render: (_, threat) => {
                    const action = threat.action_taken || 'logged';
                    const ab = document.createElement('span');
                    ab.className = 'action-badge action-' + action;
                    ab.textContent = action.charAt(0).toUpperCase() + action.slice(1);
                    if (self._ACTION_HELP[action]) ab.title = self._ACTION_HELP[action];
                    return ab;
                }},
            ],
            data: threats,
            selectable: true,
            rowActions: [
                { icon: '\u{1F441}', title: 'View details', onClick: (t) => self.showThreatDetails(t) },
            ],
            bulkActions: [
                { label: 'Delete', className: 'btn btn-sm btn-danger', onClick: (ids) => self.bulkDelete(ids) },
            ],
            idField: 'id',
            sortKey: this.sortColumn,
            sortDir: this.sortDirection,
            customSort: (data, key, dir) => {
                const d = dir === 'asc' ? 1 : -1;
                return data.sort((a, b) => {
                    let va, vb;
                    if (key === 'indicator') {
                        va = (a.indicator || a.name || a.text_preview || a.text || '').toLowerCase();
                        vb = (b.indicator || b.name || b.text_preview || b.text || '').toLowerCase();
                    } else if (key === 'risk_score') {
                        return ((a.risk_score || 0) - (b.risk_score || 0)) * d;
                    } else if (key === 'first_seen') {
                        // parseTs: same UTC normalisation as formatDate so
                        // sort ordering matches displayed time.
                        const parseTs = (s) => {
                            if (!s) return 0;
                            if (/[Z+\-]\d?\d?(:?\d\d)?$/.test(s)) return new Date(s).getTime();
                            return new Date(s.includes('T') ? s + 'Z' : s.replace(' ', 'T') + 'Z').getTime();
                        };
                        return (parseTs(a.first_seen || a.created_at) - parseTs(b.first_seen || b.created_at)) * d;
                    } else {
                        va = (a[key] || '').toString().toLowerCase();
                        vb = (b[key] || '').toString().toLowerCase();
                    }
                    if (va < vb) return -1 * d;
                    if (va > vb) return 1 * d;
                    return 0;
                });
            },
            onSort: (key, dir) => {
                self.sortColumn = key; self.sortDirection = dir;
                self.renderContent(document.getElementById('threats-content'));
            },
            onRowClick: (threat) => self.showThreatDetails(threat),
            onSelectChange: (ids) => {
                self.selectedIds = ids;
                self.updateDeleteButton();
            },
            tableId: 'threats-data-table',
            emptyText: 'No threats detected.',
        });
        threatsDt.selectedIds = new Set(this.selectedIds);
        container.appendChild(threatsDt.el);

        // Pagination
        if (this.data.total_pages > 1) {
            const pagination = this.createPagination();
            container.appendChild(pagination);
        }

        // Update delete button visibility
        this.updateDeleteButton();
    },

    createPagination() {
        const pagination = document.createElement('div');
        pagination.className = 'pagination';

        const prevBtn = document.createElement('button');
        prevBtn.className = 'btn btn-small';
        prevBtn.textContent = 'Previous';
        prevBtn.disabled = this.filters.page <= 1;
        prevBtn.addEventListener('click', () => {
            this.filters.page--;
            this.loadData();
        });
        pagination.appendChild(prevBtn);

        const pageInfo = document.createElement('span');
        pageInfo.className = 'page-info';
        pageInfo.textContent = 'Page ' + this.filters.page + ' of ' + (this.data.total_pages || 1);
        pagination.appendChild(pageInfo);

        const nextBtn = document.createElement('button');
        nextBtn.className = 'btn btn-small';
        nextBtn.textContent = 'Next';
        nextBtn.disabled = this.filters.page >= (this.data.total_pages || 1);
        nextBtn.addEventListener('click', () => {
            this.filters.page++;
            this.loadData();
        });
        pagination.appendChild(nextBtn);

        return pagination;
    },

    // Extract the Guardian ML signal for a threat record. Prefers the
    // analyze-pipeline metadata (ml_agreement / ml_malicious_score); falls
    // back to the Guardian entry inside matched_rules for older records that
    // only carried the per-rule score. Returns {agree, score} or null when
    // no ML signal is available (rule-only / pre-Guardian rows).
    _mlSignal(threat) {
        const md = (threat && threat.metadata) || {};
        let agree = md.ml_agreement || null;
        let score = (typeof md.ml_malicious_score === 'number') ? md.ml_malicious_score : null;
        if (score === null && Array.isArray(threat.matched_rules)) {
            const g = threat.matched_rules.find(r => r.source === 'model' || r.rule_id === 'sv_guardian_model');
            if (g && typeof g.confidence === 'number') score = g.confidence;
        }
        // Derive the agreement tier from the score if metadata didn't carry it.
        // Bars mirror the engine: <0.20 disagrees, >=0.60 corroborates, else uncertain.
        if (!agree && score !== null) {
            agree = (score < 0.20) ? 'ml_disagrees' : (score >= 0.60 ? 'corroborated' : 'ml_uncertain');
        }
        return (agree || score !== null) ? { agree, score } : null;
    },

    // Plain-language phrase per threat type — used for the drawer's verdict
    // sentence AND as hover help on the table's Type badges, so both surfaces
    // explain a row in the same words.
    _TYPE_PHRASE: {
        prompt_injection: 'what looks like a prompt-injection attempt',
        jailbreak: 'what looks like a jailbreak attempt',
        data_exfiltration: 'signs of data being exfiltrated',
        data_leakage: 'signs of internal data being leaked',
        sensitive_data_exposure: 'sensitive data being exposed',
        model_extraction: 'an attempt to extract or clone the model’s behavior',
        credential_leak: 'what looks like a credential or secret',
        credentials: 'what looks like a credential or secret',
        pii: 'personal information (PII)',
        sensitive_info: 'sensitive information',
        system_file_tamper: 'an attempt to modify a protected system file',
        code_injection: 'what looks like injected code',
        malicious_url: 'a link to a known-risky destination',
    },

    // Plain-language meaning of each Action value — hover help on the table's
    // Action badges. Copy only; the stored action is unchanged.
    _ACTION_HELP: {
        blocked: 'SecureVector stopped this content — it never went through.',
        redacted: 'Sensitive parts were scrubbed out; the rest went through.',
        logged: 'Recorded for review only — nothing was stopped.',
        flagged: 'Marked for attention — the content still went through.',
        allowed: 'Analyzed and allowed through.',
    },

    /** One human sentence summarizing the verdict — shown FIRST in the
     *  drawer (v5 plain-language presentation). Copy only: composed from the
     *  stored action / threat_type / matched rules; the data is unchanged and
     *  the technical breakdown still follows below. */
    _plainVerdict(threat) {
        const TYPE_PHRASE = this._TYPE_PHRASE;
        if (!threat.is_threat) {
            return 'Scanned and clean — no security rule or model flagged this content.';
        }
        const action = threat.action_taken === 'blocked' ? 'Blocked'
            : threat.action_taken === 'redacted' ? 'Redacted'
            : 'Detected (logged, not stopped)';
        const rules = threat.matched_rules || [];
        const firstRule = rules[0] && (rules[0].rule_name || rules[0].name || rules[0].rule_id);
        const what = TYPE_PHRASE[threat.threat_type]
            || (firstRule ? `content matching the “${firstRule}” rule`
                          : 'content matching a security rule');
        return `${action}: this ${threat.source_identifier ? 'traffic' : 'content'} contained ${what}.`;
    },

    showThreatDetails(threat) {
        const content = document.createElement('div');
        content.className = 'threat-details';

        // v5: lead with one human sentence; rule ids / scores / direction
        // keep their place below for the analyst.
        {
            const isBlocked = threat.action_taken === 'blocked' || threat.action_taken === 'redacted';
            const accent = !threat.is_threat ? 'var(--success, #10b981)'
                : isBlocked ? 'var(--error, #ef4444)' : 'var(--warning, #f59e0b)';
            const plain = document.createElement('div');
            plain.style.cssText = 'font-size: 14px; font-weight: 600; line-height: 1.55; color: var(--text-primary); '
                + 'padding: 12px 14px; margin-bottom: 14px; border-radius: 10px; '
                + 'border: 1px solid color-mix(in srgb, ' + accent + ' 40%, transparent); '
                + 'background: color-mix(in srgb, ' + accent + ' 8%, transparent);';
            plain.textContent = this._plainVerdict(threat);
            content.appendChild(plain);
        }

        // Risk header: rule-driven risk score on top, with the Guardian ML
        // signal shown alongside (an "ML-adjusted" chip) and below (the
        // corroborate / likely-FP badge). The ML view never overrides the
        // stored verdict — it's surfaced so the analyst sees both numbers.
        const ml = this._mlSignal(threat);
        const riskHeader = document.createElement('div');
        riskHeader.className = 'threat-detail-risk';

        const riskMain = document.createElement('div');
        riskMain.className = 'threat-detail-risk-main';

        const riskBadge = document.createElement('span');
        riskBadge.className = 'risk-badge risk-' + this.getRiskLevel(threat.risk_score);
        // When an ML number sits next to it, label the rule score explicitly so
        // "Rule risk 90%" vs "ML-adjusted 12%" reads as a contrast, not a glitch.
        riskBadge.textContent = (ml ? 'Rule risk ' : '') + (threat.risk_score || 0) + '%' + (ml ? '' : ' Risk');
        riskMain.appendChild(riskBadge);

        if (ml && typeof ml.score === 'number') {
            const mlPct = Math.round(ml.score * 100);
            const mlAdj = document.createElement('span');
            mlAdj.className = 'risk-badge ml-adjusted';
            mlAdj.textContent = 'ML-adjusted ' + mlPct + '%';
            mlAdj.title = 'Guardian ML model probability that this is a real threat. Shown for context — it does not change the stored verdict.';
            riskMain.appendChild(mlAdj);
        }

        const typeBadge = document.createElement('span');
        typeBadge.className = 'type-badge';
        typeBadge.textContent = threat.threat_type || 'No Threat Detected';
        riskMain.appendChild(typeBadge);

        riskHeader.appendChild(riskMain);

        // ML corroborate / likely-false-positive badge, promoted to the top
        // (below the risk row) so the triage signal is the first thing seen.
        if (ml && ml.agree) {
            const TIER = {
                corroborated: { cls: 'mlassess-ok',   icon: '✓', text: 'ML corroborated this detection' },
                ml_uncertain: { cls: 'mlassess-warn', icon: '⚠', text: 'ML uncertain — worth a review' },
                ml_disagrees: { cls: 'mlassess-fp',   icon: '⚠', text: 'Likely false positive — ML disagrees' },
            };
            const t = TIER[ml.agree];
            if (t) {
                const assess = document.createElement('div');
                assess.className = 'ml-assessment ' + t.cls + ' threat-detail-ml-badge';
                const scoreTxt = (typeof ml.score === 'number') ? ' · model score ' + ml.score.toFixed(2) : '';
                assess.textContent = t.icon + ' ' + t.text + scoreTxt;
                riskHeader.appendChild(assess);
            }
        }

        content.appendChild(riskHeader);

        // LLM Review Analytics (if LLM review was performed) - at top for visibility
        if (threat.llm_reviewed) {
            const llmSection = document.createElement('div');
            llmSection.className = 'threat-detail-section llm-review-section llm-expandable';

            // Clickable header for expand/collapse
            const llmHeader = document.createElement('div');
            llmHeader.className = 'detail-section-label llm-section-header llm-toggle';
            llmHeader.style.cursor = 'pointer';

            const llmIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            llmIcon.setAttribute('viewBox', '0 0 24 24');
            llmIcon.setAttribute('fill', 'none');
            llmIcon.setAttribute('stroke', 'currentColor');
            llmIcon.setAttribute('stroke-width', '2');
            llmIcon.setAttribute('class', 'llm-icon');
            const llmPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            llmPath.setAttribute('d', 'M12 2a10 10 0 1 0 10 10H12V2zM12 12l6-6');
            llmIcon.appendChild(llmPath);
            llmHeader.appendChild(llmIcon);

            const llmTitle = document.createElement('span');
            llmTitle.textContent = 'LLM Review';
            llmHeader.appendChild(llmTitle);

            // Model badge
            if (threat.llm_model_used) {
                const modelBadge = document.createElement('span');
                modelBadge.className = 'llm-model-badge';
                modelBadge.textContent = threat.llm_model_used;
                llmHeader.appendChild(modelBadge);
            }

            // Expand/collapse arrow
            const expandArrow = document.createElement('span');
            expandArrow.className = 'llm-expand-arrow';
            expandArrow.textContent = '▼';
            llmHeader.appendChild(expandArrow);

            llmSection.appendChild(llmHeader);

            // Collapsible content wrapper
            const llmContent = document.createElement('div');
            llmContent.className = 'llm-content expanded';

            // LLM Verdict
            const verdictRow = document.createElement('div');
            verdictRow.className = 'llm-verdict-row';

            const verdictLabel = document.createElement('span');
            verdictLabel.className = 'llm-verdict-label';
            verdictLabel.textContent = 'LLM Verdict:';
            verdictRow.appendChild(verdictLabel);

            const verdictBadge = document.createElement('span');
            verdictBadge.className = 'llm-verdict-badge ' + (threat.llm_agrees ? 'agrees' : 'disagrees');
            verdictBadge.textContent = threat.llm_agrees ? 'Agrees with Detection' : 'Disagrees';
            verdictRow.appendChild(verdictBadge);

            llmContent.appendChild(verdictRow);

            // LLM Confidence
            if (threat.llm_confidence !== undefined && threat.llm_confidence > 0) {
                const confRow = document.createElement('div');
                confRow.className = 'llm-stat-row';

                const confLabel = document.createElement('span');
                confLabel.className = 'llm-stat-label';
                confLabel.textContent = 'LLM Confidence';
                confRow.appendChild(confLabel);

                const confValue = document.createElement('span');
                confValue.className = 'llm-stat-value';
                confValue.textContent = Math.round(threat.llm_confidence * 100) + '%';
                confRow.appendChild(confValue);

                llmContent.appendChild(confRow);
            }

            // Risk Adjustment
            if (threat.llm_risk_adjustment && threat.llm_risk_adjustment !== 0) {
                const adjRow = document.createElement('div');
                adjRow.className = 'llm-stat-row';

                const adjLabel = document.createElement('span');
                adjLabel.className = 'llm-stat-label';
                adjLabel.textContent = 'Risk Adjustment';
                adjRow.appendChild(adjLabel);

                const adjValue = document.createElement('span');
                adjValue.className = 'llm-stat-value ' + (threat.llm_risk_adjustment > 0 ? 'risk-up' : 'risk-down');
                adjValue.textContent = (threat.llm_risk_adjustment > 0 ? '+' : '') + threat.llm_risk_adjustment + '%';
                adjRow.appendChild(adjValue);

                llmContent.appendChild(adjRow);
            }

            // Tokens Used
            if (threat.llm_tokens_used && threat.llm_tokens_used > 0) {
                const tokensRow = document.createElement('div');
                tokensRow.className = 'llm-stat-row';

                const tokensLabel = document.createElement('span');
                tokensLabel.className = 'llm-stat-label';
                tokensLabel.textContent = 'Tokens Used';
                tokensRow.appendChild(tokensLabel);

                const tokensValue = document.createElement('span');
                tokensValue.className = 'llm-stat-value';
                tokensValue.textContent = threat.llm_tokens_used.toLocaleString();
                tokensRow.appendChild(tokensValue);

                llmContent.appendChild(tokensRow);
            }

            // LLM Recommendation
            if (threat.llm_recommendation) {
                const recBox = document.createElement('div');
                recBox.className = 'llm-recommendation-box';

                const recLabel = document.createElement('div');
                recLabel.className = 'llm-recommendation-label';
                recLabel.textContent = 'Recommended Action';
                recBox.appendChild(recLabel);

                const recText = document.createElement('div');
                recText.className = 'llm-recommendation-text';
                recText.textContent = threat.llm_recommendation;
                recBox.appendChild(recText);

                llmContent.appendChild(recBox);
            }

            // LLM Reasoning
            if (threat.llm_reasoning || threat.llm_explanation) {
                const reasoningBox = document.createElement('div');
                reasoningBox.className = 'llm-reasoning-box';

                const reasoningLabel = document.createElement('div');
                reasoningLabel.className = 'llm-reasoning-label';
                reasoningLabel.textContent = 'LLM Analysis';
                reasoningBox.appendChild(reasoningLabel);

                const reasoningText = document.createElement('div');
                reasoningText.className = 'llm-reasoning-text';
                reasoningText.textContent = threat.llm_reasoning || threat.llm_explanation;
                reasoningBox.appendChild(reasoningText);

                llmContent.appendChild(reasoningBox);
            }

            // Save button
            const saveRow = document.createElement('div');
            saveRow.className = 'llm-save-row';
            const saveBtn = document.createElement('button');
            saveBtn.className = 'btn btn-primary llm-save-btn';
            saveBtn.textContent = 'Save Analysis';
            saveBtn.addEventListener('click', () => {
                // Copy analysis to clipboard
                const analysisText = [
                    'LLM Review: ' + (threat.llm_model_used || 'Unknown'),
                    'Verdict: ' + (threat.llm_agrees ? 'Agrees' : 'Disagrees'),
                    'Confidence: ' + Math.round((threat.llm_confidence || 0) * 100) + '%',
                    'Recommendation: ' + (threat.llm_recommendation || 'N/A'),
                    'Analysis: ' + (threat.llm_reasoning || threat.llm_explanation || 'N/A'),
                ].join('\n');
                navigator.clipboard.writeText(analysisText).then(() => {
                    saveBtn.textContent = 'Copied!';
                    setTimeout(() => { saveBtn.textContent = 'Save Analysis'; }, 2000);
                });
            });
            saveRow.appendChild(saveBtn);
            llmContent.appendChild(saveRow);

            llmSection.appendChild(llmContent);

            // Toggle expand/collapse
            llmHeader.addEventListener('click', () => {
                const isExpanded = llmContent.classList.contains('expanded');
                llmContent.classList.toggle('expanded');
                expandArrow.textContent = isExpanded ? '▶' : '▼';
            });

            content.appendChild(llmSection);
        }

        // Content preview — show Context and Prompt separately when available
        const textContent = threat.text_content || threat.text_preview || threat.indicator || threat.name || '';
        const contextText = threat.metadata && threat.metadata.context_text;

        if (contextText) {
            // Show Context section (injected by plugins / platform metadata)
            const ctxSection = document.createElement('div');
            ctxSection.className = 'threat-detail-section';

            const ctxLabel = document.createElement('div');
            ctxLabel.className = 'detail-section-label';
            ctxLabel.textContent = 'Context (injected by plugin)';
            ctxSection.appendChild(ctxLabel);

            const ctxBox = document.createElement('div');
            ctxBox.className = 'threat-detail-text';
            ctxBox.style.cssText = 'opacity: 0.7; font-size: 12px;';
            ctxBox.textContent = contextText;
            ctxSection.appendChild(ctxBox);

            content.appendChild(ctxSection);
        }

        if (textContent) {
            const textSection = document.createElement('div');
            textSection.className = 'threat-detail-section';

            const textLabel = document.createElement('div');
            textLabel.className = 'detail-section-label';
            textLabel.textContent = contextText ? 'Prompt (scanned)' : 'Analyzed Content';
            textSection.appendChild(textLabel);

            const textBox = document.createElement('div');
            textBox.className = 'threat-detail-text';
            textBox.textContent = textContent;
            textSection.appendChild(textBox);

            content.appendChild(textSection);
        }

        // Details grid
        const detailsSection = document.createElement('div');
        detailsSection.className = 'threat-detail-section';

        const detailsLabel = document.createElement('div');
        detailsLabel.className = 'detail-section-label';
        detailsLabel.textContent = 'Details';
        detailsSection.appendChild(detailsLabel);

        const fields = [
            // confidence is a 0..1 float; render it as a percentage. Guard the
            // rare legacy row that stored an already-0..100 value (> 1).
            { label: 'Confidence', value: Math.round((threat.confidence > 1 ? threat.confidence : (threat.confidence || 0) * 100)) + '%' },
            { label: 'First Seen', value: this.formatDate(threat.first_seen || threat.created_at) },
            { label: 'Processing Time', value: (threat.processing_time_ms || 0) + 'ms' },
            { label: 'Source', value: threat.source_identifier || 'Local' },
            { label: 'Client', value: this.parseUserAgent(threat.user_agent) },
            // Per-machine attribution: the hashed device_id tells a SOC which
            // laptop saw this threat when the same n8n/agent account is used
            // across a fleet. Null for pre-v21 rows — skip in that case.
            { label: 'Device', value: threat.device_id || null, mono: true, tooltip: 'Stable per-device identifier (SHA-256-hashed from the OS machine UUID). Survives app reinstall on the same hardware.' },
        ];

        const grid = document.createElement('div');
        grid.className = 'detail-grid';

        fields.forEach(field => {
            if (!field.value) return;

            const row = document.createElement('div');
            row.className = 'detail-row';

            const label = document.createElement('span');
            label.className = 'detail-label';
            label.textContent = field.label;
            row.appendChild(label);

            const value = document.createElement('span');
            value.className = 'detail-value';
            if (field.mono) {
                value.style.fontFamily = 'monospace';
                value.style.fontSize = '12px';
            }
            if (field.tooltip) {
                value.title = field.tooltip;
            }
            value.textContent = field.value;
            row.appendChild(value);

            grid.appendChild(row);
        });

        detailsSection.appendChild(grid);
        content.appendChild(detailsSection);

        // Matched rules
        if (threat.matched_rules && threat.matched_rules.length > 0) {
            const rulesSection = document.createElement('div');
            rulesSection.className = 'threat-detail-section';

            const rulesLabel = document.createElement('div');
            rulesLabel.className = 'detail-section-label';
            rulesLabel.textContent = 'Matched Rules (' + threat.matched_rules.length + ')';
            // Source summary badge (Rule / ML / Rule+ML) with the "detected by"
            // tooltip, right next to the section header.
            const srcBadge = DetectionLabel.badge(threat.matched_rules);
            if (srcBadge) { srcBadge.style.marginLeft = '8px'; rulesLabel.appendChild(srcBadge); }
            rulesSection.appendChild(rulesLabel);

            const rulesList = document.createElement('div');
            rulesList.className = 'matched-rules-list';

            threat.matched_rules.forEach(rule => {
                const ruleItem = document.createElement('div');
                ruleItem.className = 'matched-rule-item';

                const ruleName = document.createElement('div');
                ruleName.className = 'matched-rule-name';
                ruleName.textContent = rule.rule_name || rule.name || rule.rule_id || 'Unknown Rule';
                ruleItem.appendChild(ruleName);

                // Per-rule origin chip: the Guardian model entry reads "ML"
                // with its score; everything else reads "Rule".
                const isMl = rule.source === 'model' || rule.rule_id === 'sv_guardian_model';
                const origin = document.createElement('span');
                origin.className = 'matched-rule-origin ' + (isMl ? 'origin-ml' : 'origin-rule');
                if (isMl && typeof rule.confidence === 'number') {
                    origin.textContent = 'ML · ' + rule.confidence.toFixed(2);
                    origin.title = 'Detected by Guardian ML — score ' + rule.confidence.toFixed(2);
                } else {
                    origin.textContent = isMl ? 'ML' : 'Rule';
                    origin.title = isMl ? 'Detected by Guardian ML' : 'Detected by a regex rule';
                }
                ruleItem.appendChild(origin);

                if (rule.category) {
                    const ruleCat = document.createElement('span');
                    ruleCat.className = 'matched-rule-cat';
                    ruleCat.textContent = rule.category;
                    ruleItem.appendChild(ruleCat);
                }

                rulesList.appendChild(ruleItem);
            });

            rulesSection.appendChild(rulesList);

            // (The ML corroborate / likely-false-positive badge that used to
            // live here has been promoted to the risk header at the top of the
            // drawer — see showThreatDetails() above — so it isn't duplicated.)

            content.appendChild(rulesSection);
        }

        // Use side drawer instead of modal
        SideDrawer.show({
            title: 'Threat Details',
            content: content,
        });
    },

    getRiskLevel(score) {
        if (score >= 80) return 'critical';
        if (score >= 60) return 'high';
        if (score >= 40) return 'medium';
        return 'low';
    },

    formatDate(dateStr) {
        if (!dateStr) return '-';
        try {
            // Backend serialises UTC timestamps without a trailing 'Z'
            // (`2026-05-20T03:19:55.155752`). ECMA-262 parses bare
            // date-time strings as LOCAL, so without normalisation we
            // render the UTC clock-numbers in the user's locale (off
            // by their UTC offset). Append 'Z' so JS converts to local.
            const norm = /[Z+\-]\d?\d?(:?\d\d)?$/.test(dateStr)
                ? dateStr
                : (dateStr.includes('T') ? dateStr + 'Z' : dateStr.replace(' ', 'T') + 'Z');
            const date = new Date(norm);
            return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } catch (e) {
            return dateStr;
        }
    },

    parseUserAgent(userAgent) {
        if (!userAgent) return null;
        // Extract friendly client name from user agent
        if (userAgent.includes('SecureVector-Proxy') || userAgent.includes('OpenClaw')) return 'OpenClaw';
        if (userAgent.includes('LangGraph')) return 'LangGraph';
        if (userAgent.includes('LangChain')) return 'LangChain';
        if (userAgent.includes('Claude')) return 'Claude';
        if (userAgent.includes('python-requests')) return 'Python Requests';
        if (userAgent.includes('curl')) return 'cURL';
        if (userAgent.includes('Chrome')) {
            const match = userAgent.match(/Chrome\/([\d.]+)/);
            return match ? 'Chrome ' + match[1].split('.')[0] : 'Chrome';
        }
        if (userAgent.includes('Firefox')) {
            const match = userAgent.match(/Firefox\/([\d.]+)/);
            return match ? 'Firefox ' + match[1].split('.')[0] : 'Firefox';
        }
        if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) return 'Safari';
        if (userAgent.includes('Edge')) return 'Edge';
        // Return first 30 chars if unknown
        return userAgent.substring(0, 30) + (userAgent.length > 30 ? '...' : '');
    },

    renderEmptyState(container) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';

        // Icon
        const iconWrapper = document.createElement('div');
        iconWrapper.className = 'empty-state-icon';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.5');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z');
        svg.appendChild(path);
        iconWrapper.appendChild(svg);
        empty.appendChild(iconWrapper);

        const title = document.createElement('div');
        title.className = 'empty-state-title';
        title.textContent = 'No Threat Analytics';
        empty.appendChild(title);

        const text = document.createElement('p');
        text.className = 'empty-state-text';
        text.textContent = 'No threats have been detected yet. Start the proxy from Integrations and route traffic through SecureVector to begin detecting threats.';
        empty.appendChild(text);

        const btn = document.createElement('button');
        btn.className = 'btn btn-primary';
        btn.textContent = 'Get Started';
        btn.addEventListener('click', () => {
            if (window.Sidebar) {
                Sidebar._pendingScroll = 'section-getting-started';
                Sidebar.navigate('guide');
            }
        });
        empty.appendChild(btn);

        container.appendChild(empty);
    },

    renderError(container, error) {
        container.textContent = '';

        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-state';

        const message = document.createElement('p');
        message.textContent = 'Failed to load threats';
        errorDiv.appendChild(message);

        const retry = document.createElement('button');
        retry.className = 'btn btn-primary';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => this.loadData());
        errorDiv.appendChild(retry);

        container.appendChild(errorDiv);
    },
};

window.ThreatsPage = ThreatsPage;
