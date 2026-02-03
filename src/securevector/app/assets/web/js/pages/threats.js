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
    filters: {
        page: 1,
        page_size: 20,
        threat_type: '',
        min_risk: 0,
    },

    async render(container) {
        container.textContent = '';
        this.selectedIds.clear();

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
            console.log('Delete button clicked, selected:', self.selectedIds.size);
            self.confirmDeleteSelected();
        };
        bar.appendChild(deleteBtn);

        // Auto-refresh toggle
        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'btn btn-secondary auto-refresh-btn' + (this.autoRefreshEnabled ? ' active' : '');
        refreshBtn.textContent = '↻ Auto Refresh';
        refreshBtn.title = 'Auto refresh every 30 seconds';
        refreshBtn.addEventListener('click', () => {
            this.toggleAutoRefresh();
            refreshBtn.classList.toggle('active', this.autoRefreshEnabled);
        });
        bar.appendChild(refreshBtn);

        // Export PDF button
        const exportBtn = document.createElement('button');
        exportBtn.className = 'btn btn-primary';
        exportBtn.textContent = 'Export PDF';
        exportBtn.title = 'Download threat report as PDF';
        exportBtn.addEventListener('click', () => this.exportToPDF());
        bar.appendChild(exportBtn);
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
            }, 30000);
            if (window.Toast) Toast.info('Auto refresh enabled (30s)');
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
            const date = threat.created_at ? new Date(threat.created_at).toLocaleDateString() : '-';
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
        return '<!DOCTYPE html><html><head><title>SecureVector Threat Report</title><style>body{font-family:Arial,sans-serif;padding:20px}h1{color:#1a1a2e;border-bottom:2px solid #00bcd4;padding-bottom:10px}h2{color:#16213e;margin-top:30px}.threat{border:1px solid #ddd;padding:15px;margin:10px 0;border-radius:8px}.threat-header{display:flex;justify-content:space-between;margin-bottom:10px}.risk-high{color:#ef4444;font-weight:bold}.risk-medium{color:#f59e0b;font-weight:bold}.risk-low{color:#22c55e;font-weight:bold}.label{color:#666;font-size:12px}.llm-section{background:#f5f5f5;padding:10px;margin-top:10px;border-radius:4px}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#1a1a2e;color:white}.summary{background:#e8f4f8;padding:15px;border-radius:8px;margin-bottom:20px}</style></head><body><h1>SecureVector Threat Report</h1><p>Generated: ' + new Date().toLocaleString() + '</p><div class="summary"><strong>Summary:</strong> ' + threats.length + ' threats<br>Critical: ' + threats.filter(t => t.risk_score >= 80).length + ' | High: ' + threats.filter(t => t.risk_score >= 60 && t.risk_score < 80).length + ' | Medium: ' + threats.filter(t => t.risk_score >= 40 && t.risk_score < 60).length + ' | Low: ' + threats.filter(t => t.risk_score < 40).length + '</div><table><thead><tr><th>Content</th><th>Type</th><th>Risk</th><th>LLM</th><th>Date</th></tr></thead><tbody>' + rows + '</tbody></table><h2>High Risk Details</h2>' + details + '</body></html>';
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

        // Summary stats bar
        const statsBar = document.createElement('div');
        statsBar.className = 'threats-stats-bar';
        statsBar.style.cssText = 'display:flex;gap:24px;padding:12px 16px;background:var(--bg-card);border:1px solid var(--border-default);border-radius:8px;margin-bottom:16px;font-size:13px;';

        // Total records
        const recordsStat = document.createElement('div');
        recordsStat.innerHTML = '<span style="color:var(--text-secondary)">Records:</span> <strong>' + (this.data.total || threats.length) + '</strong>';
        statsBar.appendChild(recordsStat);

        // Total LLM reviewed
        const llmReviewed = threats.filter(t => t.llm_reviewed).length;
        const llmStat = document.createElement('div');
        llmStat.innerHTML = '<span style="color:var(--text-secondary)">LLM Reviewed:</span> <strong>' + llmReviewed + '</strong>';
        statsBar.appendChild(llmStat);

        // Total tokens used
        const totalTokens = threats.reduce((sum, t) => sum + (t.llm_tokens_used || 0), 0);
        const tokensStat = document.createElement('div');
        tokensStat.innerHTML = '<span style="color:var(--text-secondary)">Total Tokens:</span> <strong style="color:var(--accent-primary)">' + totalTokens.toLocaleString() + '</strong>';
        statsBar.appendChild(tokensStat);

        // High risk count
        const highRisk = threats.filter(t => t.risk_score >= 60).length;
        const riskStat = document.createElement('div');
        riskStat.innerHTML = '<span style="color:var(--text-secondary)">High Risk:</span> <strong style="color:var(--danger)">' + highRisk + '</strong>';
        statsBar.appendChild(riskStat);

        container.appendChild(statsBar);

        // Threats table
        const tableWrapper = document.createElement('div');
        tableWrapper.className = 'table-wrapper';

        const table = document.createElement('table');
        table.className = 'data-table';

        // Header
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');

        // Checkbox header
        const checkboxTh = document.createElement('th');
        checkboxTh.style.width = '40px';
        const selectAllCb = document.createElement('input');
        selectAllCb.type = 'checkbox';
        selectAllCb.id = 'select-all-checkbox';
        selectAllCb.className = 'threat-select-all';
        selectAllCb.title = 'Select all';
        selectAllCb.addEventListener('change', (e) => this.toggleSelectAll(e.target.checked));
        checkboxTh.appendChild(selectAllCb);
        headerRow.appendChild(checkboxTh);

        const headers = ['Indicator', 'Type', 'Risk Score', 'Client', 'First Seen', 'Actions'];
        headers.forEach(text => {
            const th = document.createElement('th');
            th.textContent = text;
            headerRow.appendChild(th);
        });

        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Body
        const tbody = document.createElement('tbody');

        threats.forEach(threat => {
            const row = document.createElement('tr');
            row.className = 'clickable-row';
            row.style.cursor = 'pointer';
            row.addEventListener('click', (e) => {
                // Don't trigger if clicking checkbox or button
                if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
                this.showThreatDetails(threat);
            });

            // Checkbox cell
            const checkboxCell = document.createElement('td');
            checkboxCell.className = 'checkbox-cell';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'threat-checkbox';
            checkbox.checked = this.selectedIds.has(threat.id);
            checkbox.addEventListener('change', (e) => {
                e.stopPropagation();
                this.toggleSelect(threat.id, e.target.checked);
            });
            checkbox.addEventListener('click', (e) => e.stopPropagation());
            checkboxCell.appendChild(checkbox);
            row.appendChild(checkboxCell);

            // Indicator (use text content if available)
            const indicatorCell = document.createElement('td');
            indicatorCell.className = 'indicator-cell';
            const indicator = document.createElement('code');
            indicator.className = 'indicator';
            const indicatorText = threat.indicator || threat.name || threat.text_preview || threat.text || 'Unknown';
            indicator.textContent = indicatorText.length > 60 ? indicatorText.substring(0, 60) + '...' : indicatorText;
            indicator.title = indicatorText;
            indicatorCell.appendChild(indicator);
            row.appendChild(indicatorCell);

            // Type
            const typeCell = document.createElement('td');
            const typeBadge = document.createElement('span');
            const threatType = threat.threat_type || 'No Threat Detected';
            const isOutputScan = threatType.startsWith('output_');
            typeBadge.className = 'type-badge' + (isOutputScan ? ' output-scan' : '');
            // Format: remove output_ prefix and display nicely
            typeBadge.textContent = isOutputScan ? threatType.replace('output_', '') : threatType;
            if (isOutputScan) {
                const outputLabel = document.createElement('span');
                outputLabel.className = 'output-scan-label';
                outputLabel.textContent = 'OUTPUT';
                typeCell.appendChild(outputLabel);
            }
            typeCell.appendChild(typeBadge);
            row.appendChild(typeCell);

            // Risk Score
            const riskCell = document.createElement('td');
            const riskBadge = document.createElement('span');
            riskBadge.className = 'risk-badge risk-' + this.getRiskLevel(threat.risk_score);
            riskBadge.textContent = (threat.risk_score || 0) + '%';
            riskCell.appendChild(riskBadge);
            // LLM badge if reviewed
            if (threat.llm_reviewed) {
                const llmBadge = document.createElement('span');
                llmBadge.className = 'llm-badge';
                llmBadge.textContent = 'LLM';
                llmBadge.title = 'Reviewed by ' + (threat.llm_model_used || 'LLM');
                riskCell.appendChild(llmBadge);
                // Tokens badge
                if (threat.llm_tokens_used && threat.llm_tokens_used > 0) {
                    const tokensBadge = document.createElement('span');
                    tokensBadge.className = 'tokens-badge';
                    tokensBadge.textContent = threat.llm_tokens_used.toLocaleString() + ' tokens';
                    riskCell.appendChild(tokensBadge);
                }
            }
            row.appendChild(riskCell);

            // Client (User Agent)
            const clientCell = document.createElement('td');
            const clientName = this.parseUserAgent(threat.user_agent);
            if (clientName) {
                const clientBadge = document.createElement('span');
                clientBadge.className = 'client-badge';
                clientBadge.textContent = clientName;
                clientBadge.title = threat.user_agent || '';
                clientCell.appendChild(clientBadge);
            } else {
                clientCell.textContent = '-';
            }
            row.appendChild(clientCell);

            // First Seen
            const dateCell = document.createElement('td');
            dateCell.textContent = this.formatDate(threat.first_seen || threat.created_at);
            row.appendChild(dateCell);

            // Actions
            const actionsCell = document.createElement('td');
            const viewBtn = document.createElement('button');
            viewBtn.className = 'btn btn-small';
            viewBtn.textContent = 'View';
            viewBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showThreatDetails(threat);
            });
            actionsCell.appendChild(viewBtn);
            row.appendChild(actionsCell);

            tbody.appendChild(row);
        });

        table.appendChild(tbody);
        tableWrapper.appendChild(table);
        container.appendChild(tableWrapper);

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

    showThreatDetails(threat) {
        const content = document.createElement('div');
        content.className = 'threat-details';

        // Risk badge at top
        const riskHeader = document.createElement('div');
        riskHeader.className = 'threat-detail-risk';
        const riskBadge = document.createElement('span');
        riskBadge.className = 'risk-badge risk-' + this.getRiskLevel(threat.risk_score);
        riskBadge.textContent = (threat.risk_score || 0) + '% Risk';
        riskHeader.appendChild(riskBadge);
        const typeBadge = document.createElement('span');
        typeBadge.className = 'type-badge';
        typeBadge.textContent = threat.threat_type || 'No Threat Detected';
        typeBadge.style.marginLeft = '8px';
        riskHeader.appendChild(typeBadge);
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

        // Content preview
        const textContent = threat.text_content || threat.text_preview || threat.indicator || threat.name || '';
        if (textContent) {
            const textSection = document.createElement('div');
            textSection.className = 'threat-detail-section';

            const textLabel = document.createElement('div');
            textLabel.className = 'detail-section-label';
            textLabel.textContent = 'Analyzed Content';
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
            { label: 'Confidence', value: (threat.confidence || 0) + '%' },
            { label: 'First Seen', value: this.formatDate(threat.first_seen || threat.created_at) },
            { label: 'Processing Time', value: (threat.processing_time_ms || 0) + 'ms' },
            { label: 'Source', value: threat.source_identifier || 'Local' },
            { label: 'Client', value: this.parseUserAgent(threat.user_agent) },
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

                if (rule.category) {
                    const ruleCat = document.createElement('span');
                    ruleCat.className = 'matched-rule-cat';
                    ruleCat.textContent = rule.category;
                    ruleItem.appendChild(ruleCat);
                }

                rulesList.appendChild(ruleItem);
            });

            rulesSection.appendChild(rulesList);
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
            const date = new Date(dateStr);
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
        text.textContent = 'No threats have been detected yet. Use the Test Analyze feature in Settings to analyze content.';
        empty.appendChild(text);

        const btn = document.createElement('button');
        btn.className = 'btn btn-primary';
        btn.textContent = 'Go to Settings';
        btn.addEventListener('click', () => {
            if (window.Sidebar) Sidebar.navigate('settings');
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
