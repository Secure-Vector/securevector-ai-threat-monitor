/**
 * Tool Permissions Page
 * Browse essential tools by category, toggle block/allow per tool
 */

const ToolPermissionsPage = {
    activeTab: 'permissions',
    tools: [],
    customTools: [],
    settings: null,
    auditSelectedIds: new Set(),

    _updateAuditDeleteBtn() {
        const btn = document.getElementById('audit-delete-selected-btn');
        if (!btn) return;
        const count = this.auditSelectedIds.size;
        if (count > 0) {
            btn.style.display = '';
            btn.textContent = `Delete Selected (${count})`;
        } else {
            btn.style.display = 'none';
        }
        const tbl = document.getElementById('audit-activity-table');
        if (tbl) tbl.classList.toggle('has-selection', count > 0);
    },

    _toggleSelectAllAudit(checked, entries) {
        if (checked) {
            entries.forEach(e => this.auditSelectedIds.add(e.id));
        } else {
            entries.forEach(e => this.auditSelectedIds.delete(e.id));
        }
        document.querySelectorAll('.audit-row-cb').forEach(cb => { cb.checked = checked; });
        document.querySelectorAll('[data-audit-row]').forEach(tr => tr.classList.toggle('sv-selected', checked));
        this._updateAuditDeleteBtn();
    },

    _toggleSelectAuditRecord(id, checked, entries) {
        if (checked) this.auditSelectedIds.add(id);
        else this.auditSelectedIds.delete(id);
        const allCb = document.getElementById('audit-select-all');
        if (allCb) {
            allCb.checked = entries.length > 0 && this.auditSelectedIds.size === entries.length;
            allCb.indeterminate = this.auditSelectedIds.size > 0 && this.auditSelectedIds.size < entries.length;
        }
        this._updateAuditDeleteBtn();
    },

    async _confirmDeleteAuditSelected(reloadFn) {
        const count = this.auditSelectedIds.size;
        if (!count) return;
        const confirmed = confirm(`Delete ${count} selected record${count !== 1 ? 's' : ''}?\n\nThis action cannot be undone.`);
        if (!confirmed) return;
        try {
            await API.deleteToolCallAuditEntries([...this.auditSelectedIds]);
            this.auditSelectedIds.clear();
            this._updateAuditDeleteBtn();
            await reloadFn();
            if (window.Toast) Toast.show(`Deleted ${count} record${count !== 1 ? 's' : ''}`, 'success');
        } catch (e) {
            if (window.Toast) Toast.show('Failed to delete records', 'error');
        }
    },

    // ==================== Shared Constants ====================

    RISK_COLORS: {
        read: { bg: 'rgba(96,165,250,0.15)', text: '#60a5fa', border: 'rgba(96,165,250,0.3)' },
        write: { bg: 'rgba(245,158,11,0.15)', text: '#f59e0b', border: 'rgba(245,158,11,0.3)' },
        delete: { bg: 'rgba(239,68,68,0.15)', text: '#ef4444', border: 'rgba(239,68,68,0.3)' },
        admin: { bg: 'rgba(220,38,38,0.15)', text: '#dc2626', border: 'rgba(220,38,38,0.3)' },
    },

    PROVIDER_ICONS: {
        openclaw: '\uD83E\uDD8E',
        gmail: '\u2709\uFE0F', slack: '\uD83D\uDCAC', twilio: '\uD83D\uDCDE', sendgrid: '\u2709\uFE0F',
        github: '\uD83D\uDC19', gitlab: '\uD83E\uDD8A',
        fs: '\uD83D\uDCC4', gdrive: '\uD83D\uDCC1',
        postgres: '\uD83D\uDDC4\uFE0F', mysql: '\uD83D\uDDC4\uFE0F', mongodb: '\uD83C\uDF43', redis: '\u26A1', sqlite: '\uD83D\uDDC3\uFE0F',
        aws: '\u2601\uFE0F', terraform: '\uD83C\uDFD7\uFE0F', k8s: '\u2699\uFE0F',
        stripe: '\uD83D\uDCB3', paypal: '\uD83D\uDCB0',
        aws: '\u2601\uFE0F', 'aws iam': '\uD83D\uDD11', 'aws iam': '\uD83D\uDD11', awsiam: '\uD83D\uDD11',
        atlassian: '\uD83D\uDCCB', notion: '\uD83D\uDCDD', linear: '\uD83D\uDFE3',
        salesforce: '\u2601\uFE0F',
        twitter: '\uD83D\uDC26', linkedin: '\uD83D\uDCBC', facebook: '\uD83D\uDC4D',
        vault: '\uD83D\uDD10', onepassword: '\uD83D\uDD11',
        // Aliases for provider field values (mixed case, spaces, special chars)
        'local filesystem': '\uD83D\uDCC4', localfilesystem: '\uD83D\uDCC4',
        'google drive': '\uD83D\uDCC1', googledrive: '\uD83D\uDCC1',
        'google calendar': '\uD83D\uDCC5', googlecalendar: '\uD83D\uDCC5',
        'google chat': '\uD83D\uDCAC', googlechat: '\uD83D\uDCAC',
        postgresql: '\uD83D\uDDC4\uFE0F',
        kubernetes: '\u2699\uFE0F',
        'twitter/x': '\uD83D\uDC26', twitterx: '\uD83D\uDC26',
        'hashicorp vault': '\uD83D\uDD10', hashicorpvault: '\uD83D\uDD10',
        '1password': '\uD83D\uDD11',
    },

    SOURCE_META: {
        official:     { label: 'Official MCP',  bg: 'rgba(6,182,212,0.12)',  text: '#06b6d4', border: 'rgba(6,182,212,0.3)',  icon: '\u2713' },
        openclaw:     { label: 'Google Workspace MCP', bg: 'rgba(0,188,212,0.12)', text: '#00bcd4', border: 'rgba(0,188,212,0.3)', icon: '\uD83D\uDCE7' },
        community:    { label: 'Community MCP',  bg: 'rgba(16,185,129,0.12)', text: '#10b981', border: 'rgba(16,185,129,0.3)', icon: '\u2665' },
        conventional: { label: 'Conventional',   bg: 'rgba(100,116,139,0.1)', text: '#94a3b8', border: 'rgba(100,116,139,0.2)', icon: '~' },
    },

    // ==================== Shared Helpers ====================

    _applyActionBtnStyle(btn, isBlocked) {
        btn.style.cssText = 'display: flex; align-items: center; gap: 3px; padding: 3px 8px; border-radius: var(--radius-full); font-size: 10px; font-weight: 600; border: none; cursor: pointer; transition: all 0.2s; min-width: 64px; justify-content: center; flex-shrink: 0; ' +
            (isBlocked
                ? 'background: rgba(239,68,68,0.15); color: #ef4444;'
                : 'background: rgba(16,185,129,0.15); color: #10b981;');
    },

    _setBtnContent(btn, blocked) {
        btn.textContent = '';
        const ico = document.createElement('span');
        ico.style.cssText = 'font-size: 10px;';
        ico.textContent = blocked ? '✕' : '✓';
        btn.appendChild(ico);
        const lbl = document.createElement('span');
        lbl.textContent = blocked ? 'Block' : 'Allow';
        btn.appendChild(lbl);
    },

    _applyCardHover(card, accent) {
        card.addEventListener('mouseenter', () => {
            card.style.borderColor = accent.color;
            card.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
            card.style.transform = 'translateY(-1px)';
        });
        card.addEventListener('mouseleave', () => {
            card.style.borderColor = 'var(--border-default)';
            card.style.borderLeftColor = accent.color;
            card.style.boxShadow = 'none';
            card.style.transform = 'none';
        });
    },

    _showToolDetail(tool, anchor, accent) {
        // Toggle off if already open for this tool
        const existing = document.getElementById('sv-tool-detail-popup');
        if (existing) {
            if (existing.dataset.toolId === tool.tool_id) { existing.remove(); return; }
            existing.remove();
        }

        const sm = this.SOURCE_META[tool.source] || this.SOURCE_META.conventional;
        const rc = this.RISK_COLORS[tool.risk] || this.RISK_COLORS.write;

        const panel = document.createElement('div');
        panel.id = 'sv-tool-detail-popup';
        panel.dataset.toolId = tool.tool_id;
        panel.style.cssText = 'position: fixed; z-index: 9999; width: 300px; background: var(--bg-card); border: 1px solid ' + accent.color + '; border-radius: 12px; padding: 16px; box-shadow: 0 8px 32px rgba(0,0,0,0.35); animation: fadeInUp 0.15s ease;';

        // Position anchored to the card
        const rect = anchor.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceRight = window.innerWidth - rect.left;
        panel.style.left = (spaceRight >= 310 ? rect.left : Math.max(8, rect.right - 300)) + 'px';
        if (spaceBelow >= 240) {
            panel.style.top = (rect.bottom + 6) + 'px';
        } else {
            panel.style.bottom = (window.innerHeight - rect.top + 6) + 'px';
        }

        // Header row: icon + name + close
        const headerRow = document.createElement('div');
        headerRow.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 12px;';

        const iconEl = document.createElement('div');
        iconEl.style.cssText = 'width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 15px; flex-shrink: 0; background: ' + accent.bg + ';';
        iconEl.textContent = this._getProviderIcon(tool);
        headerRow.appendChild(iconEl);

        const titleCol = document.createElement('div');
        titleCol.style.cssText = 'flex: 1; min-width: 0;';

        const nameEl = document.createElement('div');
        nameEl.style.cssText = 'font-weight: 700; font-size: 13px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
        nameEl.textContent = tool.name || tool.tool_id;
        titleCol.appendChild(nameEl);

        if (tool.tool_id) {
            const idEl = document.createElement('div');
            idEl.style.cssText = 'font-size: 10px; font-family: monospace; color: var(--text-muted); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
            idEl.textContent = tool.tool_id;
            titleCol.appendChild(idEl);
        }
        headerRow.appendChild(titleCol);

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        closeBtn.style.cssText = 'background: none; border: none; color: var(--text-muted); font-size: 18px; cursor: pointer; padding: 0 2px; line-height: 1; flex-shrink: 0;';
        closeBtn.addEventListener('click', () => panel.remove());
        headerRow.appendChild(closeBtn);
        panel.appendChild(headerRow);

        // Description
        if (tool.description) {
            const desc = document.createElement('p');
            desc.style.cssText = 'margin: 0 0 12px 0; font-size: 12px; color: var(--text-secondary); line-height: 1.5;';
            desc.textContent = tool.description;
            panel.appendChild(desc);
        }

        // MCP server
        if (tool.mcp_server) {
            const serverRow = document.createElement('div');
            serverRow.style.cssText = 'margin-bottom: 10px; font-size: 11px; color: var(--text-muted);';
            serverRow.innerHTML = '<span style="color:var(--text-secondary);font-weight:600;">MCP Server</span>&nbsp;&nbsp;' + tool.mcp_server;
            panel.appendChild(serverRow);
        }

        // Badges row
        const badgeRow = document.createElement('div');
        badgeRow.style.cssText = 'display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px;';
        badgeRow.appendChild(this._createRiskBadge(tool.risk || 'write'));
        badgeRow.appendChild(this._createSourceBadge(tool.source || 'conventional'));
        panel.appendChild(badgeRow);

        // Allow / Block button (full width)
        let isBlocked = tool.effective_action === 'block';
        const actionBtn = document.createElement('button');
        actionBtn.style.cssText = 'width: 100%; padding: 7px; border-radius: 8px; font-size: 12px; font-weight: 600; border: none; cursor: pointer; transition: all 0.15s;';
        const applyBtnStyle = (blocked) => {
            actionBtn.style.background = blocked ? 'rgba(239,68,68,0.15)' : 'rgba(16,185,129,0.15)';
            actionBtn.style.color = blocked ? '#ef4444' : '#10b981';
            actionBtn.textContent = (blocked ? '✕  Block — click to allow' : '✓  Allow — click to block');
        };
        applyBtnStyle(isBlocked);
        actionBtn.addEventListener('click', async () => {
            const newAction = isBlocked ? 'allow' : 'block';
            try {
                await API.setToolOverride(tool.tool_id, newAction);
                tool.effective_action = newAction;
                tool.has_override = true;
                isBlocked = newAction === 'block';
                applyBtnStyle(isBlocked);
                // Sync the mini card button in the list
                const miniCard = document.querySelector('[data-tool-id="' + tool.tool_id + '"]');
                if (miniCard) {
                    const miniBtn = miniCard.querySelector('button');
                    if (miniBtn) {
                        this._applyActionBtnStyle(miniBtn, isBlocked);
                        this._setBtnContent(miniBtn, isBlocked);
                    }
                }
            } catch (e) {
                if (window.Toast) Toast.show(e.message || 'Failed to update permission', 'error');
            }
        });
        panel.appendChild(actionBtn);

        document.body.appendChild(panel);

        // Close on outside click (deferred so this click doesn't immediately close)
        const closeOnOutside = (e) => {
            if (!panel.contains(e.target) && !anchor.contains(e.target)) {
                panel.remove();
                document.removeEventListener('click', closeOnOutside, true);
            }
        };
        setTimeout(() => document.addEventListener('click', closeOnOutside, true), 10);

        // Close on Escape
        const closeOnEsc = (e) => {
            if (e.key === 'Escape') { panel.remove(); document.removeEventListener('keydown', closeOnEsc); }
        };
        document.addEventListener('keydown', closeOnEsc);
    },

    _createRiskBadge(risk) {
        const rc = this.RISK_COLORS[risk] || this.RISK_COLORS.write;
        const badge = document.createElement('span');
        badge.style.cssText = 'font-size: 10px; padding: 2px 8px; border-radius: var(--radius-full); font-weight: 600; text-transform: uppercase; flex-shrink: 0; letter-spacing: 0.3px; border: 1px solid ' + rc.border + '; background: ' + rc.bg + '; color: ' + rc.text + ';';
        badge.textContent = risk;
        return badge;
    },

    _createSourceBadge(source) {
        const sm = this.SOURCE_META[source] || this.SOURCE_META.conventional;
        const badge = document.createElement('span');
        badge.style.cssText = 'font-size: 10px; padding: 2px 8px; border-radius: var(--radius-full); font-weight: 500; flex-shrink: 0; border: 1px solid ' + sm.border + '; background: ' + sm.bg + '; color: ' + sm.text + '; cursor: default;';
        badge.textContent = sm.icon + ' ' + sm.label;
        return badge;
    },

    _getProviderIcon(tool) {
        const key = (tool.provider || '').toLowerCase();
        return this.PROVIDER_ICONS[key]
            || this.PROVIDER_ICONS[key.replace(/[^a-z0-9]/g, '')]
            || this.PROVIDER_ICONS[tool.tool_id.split('.')[0]]
            || '\uD83D\uDD27';
    },

    // ==================== Render ====================

    async render(container) {
        container.textContent = '';

        if (this.activeTab === 'activity') {
            if (window.Header) Header.setPageInfo('Tool Activity', 'Log of every tool call made by your agents');
        } else {
            if (window.Header) Header.setPageInfo('Tool Permissions', 'Control which tools your agent is allowed to call');
        }

        if (!this.hideTabBar) {
            // Tab bar
            const tabs = document.createElement('div');
            tabs.className = 'tab-bar';
            tabs.id = 'tp-tabs';
            container.appendChild(tabs);
        }

        // Tab content area
        const content = document.createElement('div');
        content.id = 'tp-content';
        container.appendChild(content);

        if (!this.hideTabBar) {
            this._renderTabBar();
        }
        await this._renderActiveTab();
    },

    _renderTabBar() {
        const bar = document.getElementById('tp-tabs');
        if (!bar) return;
        bar.textContent = '';

        const defs = [
            { id: 'permissions', label: 'Tool Permissions' },
            { id: 'activity',    label: 'Tool Call History' },
        ];

        defs.forEach(({ id, label }) => {
            const btn = document.createElement('button');
            const isActive = this.activeTab === id;
            const isSeen = !!localStorage.getItem('sv-tab-seen-tp-' + id);
            if (isActive) localStorage.setItem('sv-tab-seen-tp-' + id, '1');
            btn.className = `tab-btn${isActive ? ' active' : ''}`;
            btn.textContent = label;
            btn.addEventListener('click', async () => {
                this.activeTab = id;
                this._renderTabBar();
                await this._renderActiveTab();
            });
            bar.appendChild(btn);
        });
    },

    async _renderActiveTab() {
        const content = document.getElementById('tp-content');
        if (!content) return;
        content.textContent = '';

        if (this.activeTab === 'permissions') await this._renderPermissionsTab(content);
        else if (this.activeTab === 'activity') await this._renderActivityTab(content);
    },

    async _renderPermissionsTab(content) {
        // Page wrapper
        const page = document.createElement('div');
        page.className = 'page-wrapper';

        // Compact toolbar: toggle + cloud info + add button
        const toolbar = document.createElement('div');
        toolbar.style.cssText = 'display: flex; align-items: flex-start; gap: 16px; margin-bottom: 16px; flex-wrap: wrap;';

        // Enforcement toggle with label + description
        const toggleWrap = document.createElement('div');
        toggleWrap.style.cssText = 'display: flex; align-items: center; gap: 10px;';

        const toggleLabel = document.createElement('label');
        toggleLabel.className = 'toggle';
        toggleLabel.style.cssText = 'flex-shrink: 0;';

        const toggleInput = document.createElement('input');
        toggleInput.type = 'checkbox';
        toggleInput.id = 'tool-permissions-toggle';

        const toggleSlider = document.createElement('span');
        toggleSlider.className = 'toggle-slider';

        toggleLabel.appendChild(toggleInput);
        toggleLabel.appendChild(toggleSlider);
        toggleWrap.appendChild(toggleLabel);

        const toggleTextCol = document.createElement('div');
        toggleTextCol.style.cssText = 'display: flex; flex-direction: column; gap: 1px;';

        const toggleLabelText = document.createElement('span');
        toggleLabelText.style.cssText = 'font-size: 12px; font-weight: 600; color: var(--text-primary); line-height: 1.3;';
        toggleLabelText.textContent = 'Enforcement';
        toggleTextCol.appendChild(toggleLabelText);

        const toggleDesc = document.createElement('span');
        toggleDesc.style.cssText = 'font-size: 11px; color: var(--text-muted); line-height: 1.4; max-width: 320px;';
        toggleDesc.textContent = 'When ON, the proxy actively intercepts tool calls and enforces your block/allow rules. When OFF, all tool calls pass through unblocked (monitor only).';
        toggleTextCol.appendChild(toggleDesc);

        toggleWrap.appendChild(toggleTextCol);
        toolbar.appendChild(toggleWrap);

        // Spacer
        const spacer = document.createElement('div');
        spacer.style.cssText = 'flex: 1;';
        toolbar.appendChild(spacer);

        // Add Custom Tool button
        const topAddBtn = document.createElement('button');
        topAddBtn.id = 'top-add-custom-tool-btn';
        topAddBtn.style.cssText = 'display: flex; align-items: center; gap: 5px; padding: 5px 14px; border-radius: var(--radius-full); font-size: 12px; font-weight: 600; border: none; background: linear-gradient(135deg, #06b6d4, #ef4444); color: #fff; cursor: pointer; transition: opacity 0.15s; flex-shrink: 0;';
        const topAddPlus = document.createElement('span');
        topAddPlus.textContent = '+';
        const topAddLabel = document.createElement('span');
        topAddLabel.textContent = 'Add Custom Tool';
        topAddBtn.appendChild(topAddPlus);
        topAddBtn.appendChild(topAddLabel);
        topAddBtn.addEventListener('mouseenter', () => { topAddBtn.style.opacity = '0.88'; });
        topAddBtn.addEventListener('mouseleave', () => { topAddBtn.style.opacity = '1'; });
        topAddBtn.addEventListener('click', () => {
            const addBtn = document.getElementById('custom-tools-add-btn');
            if (addBtn) {
                addBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                setTimeout(() => addBtn.click(), 300);
            }
        });
        toolbar.appendChild(topAddBtn);

        // Cloud info pill (compact)
        const cloudPill = document.createElement('div');
        cloudPill.id = 'cloud-mode-pill';
        cloudPill.style.cssText = 'display: none; align-items: center; gap: 6px; font-size: 11px; color: var(--text-secondary); padding: 4px 10px; border-radius: var(--radius-full); border: 1px solid var(--border-default); background: var(--bg-secondary);';
        toolbar.appendChild(cloudPill);

        page.appendChild(toolbar);

        // Tools list container
        const toolsContainer = document.createElement('div');
        toolsContainer.id = 'tools-list-container';

        const loading = document.createElement('div');
        loading.style.cssText = 'text-align: center; padding: 20px; color: var(--text-secondary); font-size: 13px;';
        loading.textContent = 'Loading essential tools...';
        toolsContainer.appendChild(loading);

        page.appendChild(toolsContainer);
        content.appendChild(page);

        // Load data
        await this.loadData(toggleInput, toolsContainer, cloudPill);
    },

    async _renderActivityTab(content) {
        const page = document.createElement('div');
        page.className = 'page-wrapper';
        content.appendChild(page);
        await this.renderAuditSection(page);
    },

    async loadData(toggleInput, toolsContainer, cloudPill) {
        try {
            const [settings, toolsData, customToolsData, cloudSettings] = await Promise.all([
                API.getSettings(),
                API.getEssentialTools(),
                API.getCustomTools(),
                API.getCloudSettings().catch(() => null),
            ]);

            this.settings = settings;
            this.tools = toolsData.tools || [];
            this.customTools = customToolsData.tools || [];

            // Set toggle state
            toggleInput.checked = settings.tool_permissions_enabled || false;
            toggleInput.addEventListener('change', async () => {
                try {
                    await API.updateSettings({
                        tool_permissions_enabled: toggleInput.checked,
                    });
                    if (window.Toast) Toast.show(
                        toggleInput.checked ? 'Tool permissions enabled' : 'Tool permissions disabled',
                        'success'
                    );
                } catch (e) {
                    toggleInput.checked = !toggleInput.checked;
                    if (window.Toast) Toast.show('Failed to update setting', 'error');
                }
            });

            // Cloud mode pill (compact)
            this.renderCloudPill(cloudPill, cloudSettings, this.tools.length);

            // Render tools
            this.renderTools(toolsContainer);

        } catch (e) {
            toolsContainer.textContent = '';
            const error = document.createElement('div');
            error.style.cssText = 'text-align: center; padding: 40px; color: var(--text-secondary);';
            error.textContent = 'Failed to load tools: ' + (e.message || 'Unknown error');
            toolsContainer.appendChild(error);
        }
    },

    renderCloudPill(pill, cloudSettings, toolCount) {
        const isCloudActive = cloudSettings &&
            cloudSettings.credentials_configured &&
            cloudSettings.cloud_mode_enabled;

        pill.style.display = 'flex';

        if (isCloudActive) {
            pill.style.cssText = 'display: flex; align-items: center; gap: 6px; font-size: 11px; color: #10b981; padding: 4px 10px; border-radius: var(--radius-full); border: 1px solid rgba(16,185,129,0.3); background: rgba(16,185,129,0.08); cursor: default;';
            pill.textContent = '\u2601\uFE0F Cloud \u2022 ' + toolCount + ' tools + 200+ coming soon';
        } else {
            pill.style.cssText = 'display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-secondary); padding: 4px 10px; border-radius: var(--radius-full); border: 1px solid var(--border-default); background: var(--bg-secondary); cursor: pointer; transition: all 0.15s;';
            pill.textContent = '\uD83D\uDCE6 ' + toolCount + ' local tools';
            pill.title = 'Enable Cloud Mode in Settings';
            pill.addEventListener('mouseenter', () => {
                pill.style.borderColor = 'rgba(6,182,212,0.4)';
                pill.style.color = '#06b6d4';
            });
            pill.addEventListener('mouseleave', () => {
                pill.style.borderColor = 'var(--border-default)';
                pill.style.color = 'var(--text-secondary)';
            });
            pill.addEventListener('click', () => {
                if (window.App) App.loadPage('settings');
            });
        }
    },

    // ==================== Essential Tools ====================

    renderTools(container) {
        container.textContent = '';

        if (!this.tools.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'text-align: center; padding: 40px; color: var(--text-secondary);';
            empty.textContent = 'No essential tools found.';
            container.appendChild(empty);
            return;
        }

        // Group by category
        const categories = {};
        this.tools.forEach(tool => {
            const cat = tool.category || 'unknown';
            if (!categories[cat]) categories[cat] = [];
            categories[cat].push(tool);
        });

        const categoryLabels = {
            openclaw: 'OpenClaw',
            communication: 'Communication',
            project_management: 'Project Management',
            code_devops: 'Code & DevOps',
            file_system: 'File System',
            database: 'Database',
            cloud_infra: 'Cloud & Infrastructure',
            payment: 'Payment',
            social_media: 'Social Media',
            security: 'Security',
            browser_automation: 'Browser Automation',
        };

        // Category accent colors for left border + icon background
        const categoryAccents = {
            openclaw: { color: '#f97316', bg: 'rgba(249,115,22,0.12)' },
            communication: { color: '#00bcd4', bg: 'rgba(0,188,212,0.12)' },
            project_management: { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
            code_devops: { color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)' },
            file_system: { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
            database: { color: '#22d3ee', bg: 'rgba(34,211,238,0.12)' },
            cloud_infra: { color: '#06b6d4', bg: 'rgba(6,182,212,0.12)' },
            payment: { color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
            social_media: { color: '#ec4899', bg: 'rgba(236,72,153,0.12)' },
            security: { color: '#ff6b6b', bg: 'rgba(255,107,107,0.15)' },
            browser_automation: { color: '#a78bfa', bg: 'rgba(167,139,250,0.12)' },
        };

        // Pairs: child stacks directly below parent in same grid slot
        const STACKED_UNDER = {
            project_management: 'communication',
            payment: 'cloud_infra',
        };
        const STACKED_CHILDREN = { communication: 'project_management', cloud_infra: 'payment' };

        const CATEGORY_ORDER = [
            'openclaw', 'browser_automation',
            'communication',   // project_management renders inside its slot
            'cloud_infra',     // payment renders inside its slot
            'code_devops', 'file_system', 'database', 'social_media', 'security',
        ];
        const sortedCategories = [
            ...CATEGORY_ORDER.filter(k => categories[k]),
            ...Object.keys(categories).filter(k => !CATEGORY_ORDER.includes(k) && !STACKED_UNDER[k]),
        ];

        // ==================== Categories as columns ====================
        const columnsWrap = document.createElement('div');
        columnsWrap.className = 'tool-permissions-grid';
        columnsWrap.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 14px; align-items: start;';

        const buildCategoryCol = (catKey) => {
            const tools = categories[catKey];
            if (!tools) return null;
            const accent = categoryAccents[catKey] || { color: '#64748b', bg: 'rgba(100,116,139,0.12)' };
            const isOpenClaw = catKey === 'openclaw';
            const isCodeDevops = catKey === 'code_devops';

            const col = document.createElement('div');
            if (isOpenClaw) {
                col.id = 'openclaw-column';
                col.style.cssText = 'min-width: 0; border-radius: 10px; padding: 8px; background: rgba(249,115,22,0.07); border: 1px solid rgba(249,115,22,0.30);';
            } else {
                col.style.cssText = 'min-width: 0;';
            }

            // Column header
            const catHeader = document.createElement('div');
            if (isOpenClaw) {
                catHeader.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 6px; padding-bottom: 6px; border-bottom: 2px solid #f97316;';
                const flame = document.createElement('span');
                flame.style.cssText = 'font-size: 13px; line-height: 1;';
                flame.textContent = '🔥';
                catHeader.appendChild(flame);
            } else {
                catHeader.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 6px; padding-bottom: 6px; border-bottom: 2px solid ' + accent.color + ';';
                const catDot = document.createElement('span');
                catDot.style.cssText = 'width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; background: ' + accent.color + ';';
                catHeader.appendChild(catDot);
            }

            const catTitle = document.createElement('span');
            catTitle.style.cssText = 'font-weight: 700; font-size: 11px; text-transform: uppercase; letter-spacing: 0.7px; color: var(--text-primary);';
            catTitle.textContent = categoryLabels[catKey] || catKey;
            catHeader.appendChild(catTitle);

            const catCount = document.createElement('span');
            catCount.style.cssText = 'font-size: 10px; color: var(--text-muted); margin-left: auto; padding: 1px 5px; background: var(--bg-tertiary); border-radius: var(--radius-full);';
            catCount.textContent = tools.length;
            catHeader.appendChild(catCount);

            col.appendChild(catHeader);

            // OpenClaw info note (dismissible)
            if (isOpenClaw && !sessionStorage.getItem('sv-openclaw-note-dismissed')) {
                const note = document.createElement('div');
                note.style.cssText = 'position: relative; font-size: 11px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 8px; padding: 6px 28px 6px 8px; background: rgba(249,115,22,0.06); border-radius: 6px;';

                const noteText = document.createElement('div');
                noteText.innerHTML = '<strong style="color:#f97316;">Where did these come from?</strong><br>These tools were auto-detected from your running <strong>OpenClaw proxy</strong>. OpenClaw exposes Google Workspace tools (Gmail, Drive, Calendar, Meet, etc.) as MCP tool calls — SecureVector intercepts those calls and lists them here so you can allow or block each one.';
                note.appendChild(noteText);

                const closeNote = document.createElement('button');
                closeNote.textContent = '×';
                closeNote.style.cssText = 'position: absolute; top: 4px; right: 6px; background: none; border: none; color: var(--text-muted); font-size: 14px; cursor: pointer; line-height: 1; padding: 0;';
                closeNote.addEventListener('click', () => {
                    sessionStorage.setItem('sv-openclaw-note-dismissed', '1');
                    note.remove();
                });
                note.appendChild(closeNote);
                col.appendChild(note);
            }

            // Tool rows (ultra-compact)
            const list = document.createElement('div');
            list.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';

            tools.forEach(tool => {
                list.appendChild(this.createToolCard(tool, accent));
            });

            col.appendChild(list);

            // Custom Tools section appended inside Code & DevOps column
            if (isCodeDevops) {
                this.renderCustomToolsSection(col);
            }

            return col;
        };

        sortedCategories.forEach(catKey => {
            const col = buildCategoryCol(catKey);
            if (!col) return;

            // If this category has a child stacked below it, wrap both in a vertical stack
            const childKey = STACKED_CHILDREN[catKey];
            if (childKey && categories[childKey]) {
                const stack = document.createElement('div');
                stack.style.cssText = 'display: flex; flex-direction: column; gap: 14px; min-width: 0;';
                stack.appendChild(col);
                stack.appendChild(buildCategoryCol(childKey));
                columnsWrap.appendChild(stack);
            } else {
                columnsWrap.appendChild(col);
            }
        });

        // If code_devops column didn't exist, render custom tools as last column
        if (!categories.code_devops) {
            this.renderCustomToolsSection(columnsWrap);
        }

        container.appendChild(columnsWrap);

        // Attribution footer
        const attribution = document.createElement('div');
        attribution.style.cssText = 'margin-top: 24px; padding: 16px 20px; text-align: center; font-size: 11px; color: var(--text-muted); border-top: 1px solid var(--border-default);';
        attribution.textContent = 'Essential tools are sourced from official MCP servers and verified OpenClaw integrations. Tool names are trademarks of their respective owners. SecureVector is not affiliated with or endorsed by these providers.';
        container.appendChild(attribution);
    },

    // ==================== Tool Call Audit Log ====================

    async renderAuditSection(container) {
        const RISK_COLORS = this.RISK_COLORS;
        const self = this;
        const PAGE_SIZE = 50;
        let currentPage = 1;
        let totalEntries = 0;
        this.auditSelectedIds = new Set();

        // ── 7-day activity chart ─────────────────────────────────────────
        const chartCard = document.createElement('div');
        chartCard.style.cssText = 'background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 10px; padding: 16px 20px; margin-bottom: 20px;';

        const chartTitle = document.createElement('div');
        chartTitle.style.cssText = 'font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 14px;';
        chartTitle.textContent = 'Tool Call Activity — Last 7 Days';
        chartCard.appendChild(chartTitle);

        const chartBody = document.createElement('div');
        chartCard.appendChild(chartBody);
        container.appendChild(chartCard);

        // Fetch daily stats and render chart async (non-blocking)
        API.getToolCallAuditDaily(7).then(data => {
            const rows = data.days || [];

            // Build full 7-day buckets using local dates (matches SQL 'localtime' grouping)
            const buckets = [];
            for (let i = 6; i >= 0; i--) {
                const d = new Date();
                d.setDate(d.getDate() - i);
                const dateStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
                const match = rows.find(r => r.day === dateStr) || {};
                buckets.push({
                    label: (d.getMonth() + 1) + '/' + d.getDate(),
                    blocked: match.blocked || 0,
                    allowed: match.allowed || 0,
                    logged:  match.logged  || 0,
                });
            }

            const maxVal = Math.max(...buckets.map(b => b.blocked + b.allowed + b.logged), 1);

            const wrap = document.createElement('div');
            wrap.style.cssText = 'display: flex; align-items: stretch; gap: 6px; height: 120px;';

            buckets.forEach(bucket => {
                const total = bucket.blocked + bucket.allowed + bucket.logged;
                const col = document.createElement('div');
                col.style.cssText = 'flex: 1; display: flex; flex-direction: column; align-items: center; min-width: 0;';
                col.title = bucket.label + '\nBlocked: ' + bucket.blocked + '\nAllowed: ' + bucket.allowed + '\nLogged: ' + bucket.logged;

                // Value label
                const valLbl = document.createElement('div');
                valLbl.style.cssText = 'height: 16px; font-size: 10px; color: var(--text-secondary); text-align: center; line-height: 16px;';
                valLbl.textContent = total > 0 ? total : '';
                col.appendChild(valLbl);

                // Bar area — stacked segments
                const barArea = document.createElement('div');
                barArea.style.cssText = 'flex: 1; width: 80%; position: relative; border-radius: 3px 3px 0 0; overflow: hidden;';

                const pctBlock   = (bucket.blocked / maxVal) * 100;
                const pctAllow   = (bucket.allowed / maxVal) * 100;
                const pctLogged  = (bucket.logged  / maxVal) * 100;
                const pctTotal   = pctBlock + pctAllow + pctLogged;

                if (pctTotal > 0) {
                    // Stacked from bottom: logged (muted) → allowed (cyan) → blocked (red)
                    const stack = document.createElement('div');
                    stack.style.cssText = 'position: absolute; bottom: 0; left: 0; right: 0; height: ' + pctTotal + '%; display: flex; flex-direction: column-reverse; border-radius: 3px 3px 0 0; overflow: hidden;';

                    if (pctBlock > 0) {
                        const seg = document.createElement('div');
                        seg.style.cssText = 'background: #ef4444; flex: ' + bucket.blocked + ';';
                        stack.appendChild(seg);
                    }
                    if (pctAllow > 0) {
                        const seg = document.createElement('div');
                        seg.style.cssText = 'background: #06b6d4; flex: ' + bucket.allowed + ';';
                        stack.appendChild(seg);
                    }
                    if (pctLogged > 0) {
                        const seg = document.createElement('div');
                        seg.style.cssText = 'background: #475569; flex: ' + bucket.logged + ';';
                        stack.appendChild(seg);
                    }
                    barArea.appendChild(stack);
                } else {
                    // Empty day — faint baseline
                    const base = document.createElement('div');
                    base.style.cssText = 'position: absolute; bottom: 0; left: 0; right: 0; height: 2px; background: var(--border-default);';
                    barArea.appendChild(base);
                }

                col.appendChild(barArea);

                // Day label
                const lbl = document.createElement('div');
                lbl.style.cssText = 'height: 18px; font-size: 10px; color: var(--text-muted); text-align: center; line-height: 18px; white-space: nowrap;';
                lbl.textContent = bucket.label;
                col.appendChild(lbl);

                wrap.appendChild(col);
            });

            chartBody.appendChild(wrap);

            // Legend
            const legend = document.createElement('div');
            legend.style.cssText = 'display: flex; gap: 14px; margin-top: 8px; font-size: 11px; color: var(--text-secondary);';
            [['#ef4444', 'Blocked'], ['#06b6d4', 'Allowed'], ['#475569', 'Logged']]
                .forEach(([color, label]) => {
                    const item = document.createElement('span');
                    item.style.cssText = 'display: flex; align-items: center; gap: 5px;';
                    const dot = document.createElement('span');
                    dot.style.cssText = 'width: 10px; height: 10px; border-radius: 2px; background: ' + color + '; flex-shrink: 0;';
                    item.appendChild(dot);
                    item.appendChild(document.createTextNode(label));
                    legend.appendChild(item);
                });
            chartBody.appendChild(legend);
        });

        // Stat cards row (like costs page)
        const statsGrid = document.createElement('div');
        statsGrid.className = 'stats-grid';
        statsGrid.style.marginBottom = '20px';
        container.appendChild(statsGrid);

        const statsWrapEl = { total: null, blocked: null, allowed: null, logged: null };
        const makeStatCard = (key, label, color) => {
            const card = document.createElement('div');
            card.className = 'stat-card';
            const val = document.createElement('div');
            val.className = 'stat-value';
            val.style.color = color || '';
            val.textContent = '—';
            const lbl = document.createElement('div');
            lbl.className = 'stat-label';
            lbl.textContent = label;
            card.appendChild(val);
            card.appendChild(lbl);
            statsWrapEl[key] = val;
            statsGrid.appendChild(card);
        };
        makeStatCard('total',   'Total Calls',    '');
        makeStatCard('blocked', 'Blocked',        '#ef4444');
        makeStatCard('allowed', 'Allowed',        '#06b6d4');
        makeStatCard('logged',  'Logged (Pass)',  '#94a3b8');

        // Toolbar: filter buttons + refresh
        const toolbar = document.createElement('div');
        toolbar.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap;';

        const filters = [
            { label: 'All',     value: null,       color: '#94a3b8' },
            { label: 'Blocked', value: 'block',    color: '#ef4444' },
            { label: 'Allowed', value: 'allow',    color: '#06b6d4' },
            { label: 'Logged',  value: 'log_only', color: '#64748b' },
        ];
        let activeFilter = null;
        const filterBtns = [];

        const applyFilterStyle = (btn, fi, isActive) => {
            btn.style.cssText = 'padding: 3px 12px; border-radius: var(--radius-full); font-size: 12px; font-weight: 600; border: 1px solid; cursor: pointer; transition: all 0.15s; ' +
                (isActive
                    ? 'background: ' + fi.color + '22; color: ' + fi.color + '; border-color: ' + fi.color + '55;'
                    : 'background: transparent; color: var(--text-muted); border-color: var(--border-default);');
        };

        filters.forEach((f, fi) => {
            const btn = document.createElement('button');
            applyFilterStyle(btn, f, f.value === activeFilter);
            btn.textContent = f.label;
            btn.addEventListener('click', async () => {
                activeFilter = f.value;
                currentPage = 1;
                filterBtns.forEach((b, i) => applyFilterStyle(b, filters[i], filters[i].value === activeFilter));
                await loadAuditData(f.value);
            });
            filterBtns.push(btn);
            toolbar.appendChild(btn);
        });

        const spacer = document.createElement('div');
        spacer.style.cssText = 'flex: 1;';
        toolbar.appendChild(spacer);

        const refreshBtn = document.createElement('button');
        refreshBtn.style.cssText = 'padding: 3px 10px; border-radius: var(--radius-full); font-size: 12px; border: 1px solid var(--border-default); background: transparent; color: var(--text-muted); cursor: pointer; transition: color 0.15s;';
        refreshBtn.title = 'Refresh';
        refreshBtn.textContent = '↻ Refresh';
        refreshBtn.addEventListener('mouseenter', () => { refreshBtn.style.color = 'var(--text-primary)'; });
        refreshBtn.addEventListener('mouseleave', () => { refreshBtn.style.color = 'var(--text-muted)'; });
        toolbar.appendChild(refreshBtn);

        const deleteSelectedBtn = document.createElement('button');
        deleteSelectedBtn.id = 'audit-delete-selected-btn';
        deleteSelectedBtn.className = 'btn btn-danger';
        deleteSelectedBtn.style.cssText = 'display: none; margin-left: 4px;';
        deleteSelectedBtn.textContent = 'Delete Selected (0)';
        deleteSelectedBtn.addEventListener('click', () => self._confirmDeleteAuditSelected(() => loadAuditData(activeFilter)));
        toolbar.appendChild(deleteSelectedBtn);

        container.appendChild(toolbar);

        // Table wrapper
        const tableWrap = document.createElement('div');
        tableWrap.style.cssText = 'overflow-x: auto; overflow-y: auto; max-height: 600px; border: 1px solid var(--border-default); border-radius: var(--radius-lg); background: var(--bg-card);';
        container.appendChild(tableWrap);

        const table = document.createElement('table');
        table.id = 'audit-activity-table';
        table.style.cssText = 'width: 100%; border-collapse: collapse; font-size: 13px;';

        // Sort state
        let sortKey = 'called_at';
        let sortDir = 'desc'; // 'asc' | 'desc'
        let lastEntries = [];

        const COLS = [
            { label: 'Decision',     key: 'action',        width: '100px' },
            { label: 'Tool',         key: 'function_name', width: '200px' },
            { label: 'Risk',         key: 'risk',          width: '75px'  },
            { label: 'Type',         key: 'is_essential',  width: '85px'  },
            { label: 'Reason',       key: 'reason',        width: '240px' },
            { label: 'Args Preview', key: null,            width: '160px' },
            { label: 'Date',         key: 'called_at',     width: '100px' },
            { label: 'Time',         key: 'called_at',     width: '80px'  },
        ];

        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        headRow.style.cssText = 'border-bottom: 1px solid var(--border-default); position: sticky; top: 0; background: var(--bg-card); z-index: 1;';

        // Select-all checkbox column header
        const selectAllTh = document.createElement('th');
        selectAllTh.style.cssText = 'padding: 9px 8px; width: 28px; text-align: center;';
        const selectAllCb = document.createElement('input');
        selectAllCb.type = 'checkbox';
        selectAllCb.id = 'audit-select-all';
        selectAllCb.addEventListener('change', (e) => {
            self._toggleSelectAllAudit(e.target.checked, lastEntries);
        });
        selectAllTh.appendChild(selectAllCb);
        headRow.appendChild(selectAllTh);

        const thEls = [];
        const updateSortIndicators = () => {
            thEls.forEach((th, i) => {
                const col = COLS[i];
                if (!col.key) return;
                const isActive = col.key === sortKey && !(col.label === 'Time' && sortKey !== 'called_at');
                th.style.color = isActive ? 'var(--text-primary)' : 'var(--text-muted)';
                th.style.cursor = 'pointer';
                const arrow = isActive ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ⇅';
                th.textContent = col.label + arrow;
            });
        };

        const sortAndRender = () => {
            const sorted = [...lastEntries].sort((a, b) => {
                let av = a[sortKey] ?? '';
                let bv = b[sortKey] ?? '';
                if (typeof av === 'number' || typeof bv === 'number') {
                    av = Number(av); bv = Number(bv);
                } else {
                    av = String(av).toLowerCase(); bv = String(bv).toLowerCase();
                }
                if (av < bv) return sortDir === 'asc' ? -1 : 1;
                if (av > bv) return sortDir === 'asc' ? 1 : -1;
                return 0;
            });
            Array.from(tbody.querySelectorAll('[data-audit-row]')).forEach(r => r.remove());
            sorted.forEach((entry, idx) => tbody.appendChild(makeRow(entry, idx)));
        };

        COLS.forEach((col, i) => {
            const th = document.createElement('th');
            th.style.cssText = 'padding: 9px 12px; text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); font-weight: 600; white-space: nowrap; width:' + col.width + '; user-select: none;';
            th.textContent = col.label;
            if (col.key) {
                th.style.cursor = 'pointer';
                th.addEventListener('click', () => {
                    if (sortKey === col.key) {
                        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
                    } else {
                        sortKey = col.key;
                        sortDir = 'asc';
                    }
                    updateSortIndicators();
                    sortAndRender();
                });
                th.addEventListener('mouseenter', () => { if (col.key !== sortKey) th.style.color = 'var(--text-secondary)'; });
                th.addEventListener('mouseleave', () => { updateSortIndicators(); });
            }
            thEls.push(th);
            headRow.appendChild(th);
        });

        thead.appendChild(headRow);
        table.appendChild(thead);
        updateSortIndicators();

        const tbody = document.createElement('tbody');
        table.appendChild(tbody);
        tableWrap.appendChild(table);

        // Pagination bar (below table)
        const paginationBar = document.createElement('div');
        paginationBar.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-top: 10px; justify-content: flex-end;';
        container.appendChild(paginationBar);

        const pageInfo = document.createElement('span');
        pageInfo.style.cssText = 'font-size: 12px; color: var(--text-muted);';
        pageInfo.textContent = '';

        const prevBtn = document.createElement('button');
        prevBtn.style.cssText = 'padding: 3px 12px; border-radius: var(--radius-full); font-size: 12px; font-weight: 600; border: 1px solid var(--border-default); background: transparent; color: var(--text-muted); cursor: pointer; transition: all 0.15s;';
        prevBtn.textContent = '← Prev';
        prevBtn.disabled = true;

        const nextBtn = document.createElement('button');
        nextBtn.style.cssText = 'padding: 3px 12px; border-radius: var(--radius-full); font-size: 12px; font-weight: 600; border: 1px solid var(--border-default); background: transparent; color: var(--text-muted); cursor: pointer; transition: all 0.15s;';
        nextBtn.textContent = 'Next →';
        nextBtn.disabled = true;

        paginationBar.appendChild(prevBtn);
        paginationBar.appendChild(pageInfo);
        paginationBar.appendChild(nextBtn);

        prevBtn.addEventListener('click', async () => {
            if (currentPage > 1) { currentPage--; await loadAuditData(activeFilter); }
        });
        nextBtn.addEventListener('click', async () => {
            if (currentPage * PAGE_SIZE < totalEntries) { currentPage++; await loadAuditData(activeFilter); }
        });

        // Empty / loading row
        const emptyRow = document.createElement('tr');
        const emptyCell = document.createElement('td');
        emptyCell.colSpan = 9;
        emptyCell.style.cssText = 'padding: 40px; text-align: center; color: var(--text-muted); font-size: 13px;';
        emptyCell.textContent = 'Loading tool call history…';
        emptyRow.appendChild(emptyCell);
        tbody.appendChild(emptyRow);

        // Helpers
        const fmtDate = (iso) => {
            const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        };
        const fmtTime = (iso) => {
            const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
            return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        };

        // Action badge configs — cyan for allowed, red for blocked
        const ACTION_CFG = {
            block:    { icon: '🔒', label: 'Blocked', color: '#ef4444', bg: 'rgba(239,68,68,0.12)'   },
            allow:    { icon: '✓',  label: 'Allowed', color: '#06b6d4', bg: 'rgba(6,182,212,0.12)'   },
            log_only: { icon: '~',  label: 'Logged',  color: '#94a3b8', bg: 'rgba(148,163,184,0.1)'  },
        };

        // Build detail drawer content for a single audit entry
        const buildDrawerContent = (entry) => {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'display: flex; flex-direction: column; gap: 16px;';

            const cfg = ACTION_CFG[entry.action] || { icon: '?', label: entry.action, color: '#94a3b8', bg: 'transparent' };

            // ── Decision banner ─────────────────────────────────────────
            const banner = document.createElement('div');
            banner.style.cssText = 'display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-radius: 8px; background: ' + cfg.bg + '; border: 1px solid ' + cfg.color + '44;';
            const bannerIcon = document.createElement('span');
            bannerIcon.style.cssText = 'font-size: 20px;';
            bannerIcon.textContent = cfg.icon;
            const bannerText = document.createElement('div');
            const bannerTitle = document.createElement('div');
            bannerTitle.style.cssText = 'font-size: 16px; font-weight: 700; color: ' + cfg.color + ';';
            bannerTitle.textContent = cfg.label;
            bannerText.appendChild(bannerTitle);
            if (entry.reason) {
                const bannerReason = document.createElement('div');
                bannerReason.style.cssText = 'font-size: 12px; color: var(--text-secondary); margin-top: 2px;';
                bannerReason.textContent = entry.reason;
                bannerText.appendChild(bannerReason);
            }
            banner.appendChild(bannerIcon);
            banner.appendChild(bannerText);
            wrap.appendChild(banner);

            // ── Tool info ────────────────────────────────────────────────
            const section = (label, node) => {
                const row = document.createElement('div');
                row.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';
                const lbl = document.createElement('div');
                lbl.style.cssText = 'font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.6px;';
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

            // Tool name
            const toolNameEl = document.createElement('div');
            toolNameEl.style.cssText = 'font-family: monospace; font-size: 14px; font-weight: 700; color: var(--text-primary); word-break: break-all;';
            toolNameEl.textContent = entry.function_name;
            wrap.appendChild(section('Tool', toolNameEl));

            // Resolved tool_id (if different)
            if (entry.tool_id && entry.tool_id !== entry.function_name) {
                const tidEl = document.createElement('div');
                tidEl.style.cssText = 'font-family: monospace; font-size: 12px; color: var(--text-secondary);';
                tidEl.textContent = entry.tool_id;
                wrap.appendChild(section('Resolved Tool ID', tidEl));
            }

            // Timestamp
            const ts = new Date(entry.called_at.endsWith('Z') ? entry.called_at : entry.called_at + 'Z');
            const tsStr = ts.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })
                + ' at ' + ts.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            wrap.appendChild(section('Time', tsStr));

            // Risk + Type row
            const metaRow = document.createElement('div');
            metaRow.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 12px;';

            if (entry.risk) {
                const rc = RISK_COLORS[entry.risk] || RISK_COLORS.write;
                const riskEl = document.createElement('span');
                riskEl.style.cssText = 'display: inline-block; font-size: 12px; padding: 3px 10px; border-radius: var(--radius-full); font-weight: 700; text-transform: uppercase; border: 1px solid ' + rc.border + '; background: ' + rc.bg + '; color: ' + rc.text + ';';
                riskEl.textContent = entry.risk;
                metaRow.appendChild(section('Risk Level', riskEl));
            }

            const typeColor = entry.is_essential ? '#06b6d4' : 'var(--text-secondary)';
            const typeText = entry.is_essential ? 'Essential' : (entry.action !== 'log_only' ? 'Custom' : 'Unknown');
            const typeEl = document.createElement('span');
            typeEl.style.cssText = 'font-size: 13px; font-weight: 600; color: ' + typeColor + ';';
            typeEl.textContent = typeText;
            metaRow.appendChild(section('Type', typeEl));
            wrap.appendChild(metaRow);

            // Args preview
            if (entry.args_preview) {
                const codeWrap = document.createElement('div');
                codeWrap.style.cssText = 'background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: 6px; padding: 10px 12px; overflow-x: auto;';
                const code = document.createElement('pre');
                code.style.cssText = 'margin: 0; font-family: monospace; font-size: 12px; color: var(--accent-primary); white-space: pre-wrap; word-break: break-all;';
                // Try to pretty-print JSON
                try {
                    const parsed = JSON.parse(entry.args_preview);
                    code.textContent = JSON.stringify(parsed, null, 2);
                } catch (_) {
                    code.textContent = entry.args_preview;
                }
                codeWrap.appendChild(code);
                wrap.appendChild(section('Arguments', codeWrap));
            } else {
                wrap.appendChild(section('Arguments', 'No arguments recorded'));
            }

            return wrap;
        };

        const makeRow = (entry, idx) => {
            const tr = document.createElement('tr');
            tr.dataset.auditRow = '1';
            tr.title = 'Click to view details';
            const rowBg = idx % 2 === 1 ? 'var(--bg-secondary)' : 'transparent';
            tr.style.cssText = 'border-bottom: 1px solid var(--border-default); transition: background 0.1s; background: ' + rowBg + '; cursor: pointer;';
            if (self.auditSelectedIds.has(entry.id)) { tr.classList.add('sv-selected'); tr.style.background = 'rgba(6,182,212,0.06)'; }
            tr.addEventListener('mouseenter', () => { if (!tr.classList.contains('sv-selected')) tr.style.background = 'var(--bg-tertiary)'; });
            tr.addEventListener('mouseleave', () => { tr.style.background = tr.classList.contains('sv-selected') ? 'rgba(6,182,212,0.06)' : rowBg; });

            // Checkbox cell
            const tdCb = document.createElement('td');
            tdCb.style.cssText = 'padding: 8px 8px; width: 28px; text-align: center;';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'audit-row-cb';
            cb.checked = self.auditSelectedIds.has(entry.id);
            cb.addEventListener('click', (e) => e.stopPropagation());
            cb.addEventListener('change', () => {
                if (cb.checked) tr.style.background = 'rgba(6,182,212,0.06)';
                else tr.style.background = rowBg;
                tr.classList.toggle('sv-selected', cb.checked);
                self._toggleSelectAuditRecord(entry.id, cb.checked, lastEntries);
            });
            tdCb.appendChild(cb);
            tr.appendChild(tdCb);

            tr.addEventListener('click', (e) => {
                if (e.target.type === 'checkbox') return;
                SideDrawer.show({ title: 'Tool Call Detail', content: buildDrawerContent(entry) });
            });

            // Decision badge
            const tdAction = document.createElement('td');
            tdAction.style.cssText = 'padding: 8px 12px; white-space: nowrap;';
            const cfg = ACTION_CFG[entry.action] || { icon: '?', label: entry.action, color: '#94a3b8', bg: 'transparent' };
            const badge = document.createElement('span');
            badge.style.cssText = 'display: inline-flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: var(--radius-full); font-size: 11px; font-weight: 700; color: ' + cfg.color + '; background: ' + cfg.bg + '; border: 1px solid ' + cfg.color + '44;';
            const iconSpan = document.createElement('span');
            iconSpan.textContent = cfg.icon;
            const labelSpan = document.createElement('span');
            labelSpan.textContent = cfg.label;
            badge.appendChild(iconSpan);
            badge.appendChild(labelSpan);
            tdAction.appendChild(badge);
            tr.appendChild(tdAction);

            // Tool name
            const tdTool = document.createElement('td');
            tdTool.style.cssText = 'padding: 8px 12px; max-width: 200px;';
            const toolName = document.createElement('span');
            toolName.style.cssText = 'font-family: monospace; font-size: 12px; color: var(--text-primary); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block;';
            toolName.textContent = entry.function_name;
            tdTool.appendChild(toolName);
            if (entry.tool_id && entry.tool_id !== entry.function_name) {
                const resolved = document.createElement('span');
                resolved.style.cssText = 'font-size: 10px; color: var(--text-muted); font-family: monospace;';
                resolved.textContent = '\u2192 ' + entry.tool_id;
                tdTool.appendChild(resolved);
            }
            tr.appendChild(tdTool);

            // Risk
            const tdRisk = document.createElement('td');
            tdRisk.style.cssText = 'padding: 8px 12px; white-space: nowrap;';
            if (entry.risk) {
                const rc = RISK_COLORS[entry.risk] || RISK_COLORS.write;
                const riskBadge = document.createElement('span');
                riskBadge.style.cssText = 'font-size: 11px; padding: 2px 7px; border-radius: var(--radius-full); font-weight: 600; text-transform: uppercase; border: 1px solid ' + rc.border + '; background: ' + rc.bg + '; color: ' + rc.text + ';';
                riskBadge.textContent = entry.risk;
                tdRisk.appendChild(riskBadge);
            } else {
                tdRisk.textContent = '\u2014';
                tdRisk.style.color = 'var(--text-muted)';
            }
            tr.appendChild(tdRisk);

            // Type
            const tdType = document.createElement('td');
            tdType.style.cssText = 'padding: 8px 12px; white-space: nowrap; font-size: 12px;';
            const typeColor = entry.is_essential ? '#06b6d4' : (entry.action !== 'log_only' ? '#00bcd4' : 'var(--text-muted)');
            const typeText = entry.is_essential ? 'Essential' : (entry.action !== 'log_only' ? 'Custom' : 'Unknown');
            const typeSpan = document.createElement('span');
            typeSpan.style.color = typeColor;
            typeSpan.textContent = typeText;
            tdType.appendChild(typeSpan);
            tr.appendChild(tdType);

            // Reason (fixed width, truncated with tooltip)
            const tdReason = document.createElement('td');
            tdReason.style.cssText = 'padding: 8px 12px; font-size: 12px; color: var(--text-secondary); max-width: 240px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
            tdReason.textContent = entry.reason || '\u2014';
            if (entry.reason) tdReason.title = entry.reason;
            tr.appendChild(tdReason);

            // Args preview
            const tdArgs = document.createElement('td');
            tdArgs.style.cssText = 'padding: 8px 12px; max-width: 160px;';
            if (entry.args_preview) {
                const args = document.createElement('code');
                args.style.cssText = 'font-size: 11px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; max-width: 160px;';
                args.textContent = entry.args_preview;
                args.title = entry.args_preview;
                tdArgs.appendChild(args);
            } else {
                tdArgs.textContent = '\u2014';
                tdArgs.style.color = 'var(--text-muted)';
            }
            tr.appendChild(tdArgs);

            // Date
            const tdDate = document.createElement('td');
            tdDate.style.cssText = 'padding: 8px 12px; color: var(--text-secondary); font-size: 12px; white-space: nowrap;';
            tdDate.textContent = fmtDate(entry.called_at);
            tr.appendChild(tdDate);

            // Time
            const tdTime = document.createElement('td');
            tdTime.style.cssText = 'padding: 8px 12px; color: var(--text-muted); font-size: 12px; white-space: nowrap; font-family: monospace;';
            tdTime.textContent = fmtTime(entry.called_at);
            tdTime.title = entry.called_at;
            tr.appendChild(tdTime);

            return tr;
        };

        refreshBtn.addEventListener('click', () => { currentPage = 1; loadAuditData(activeFilter); });

        // Load & render table body
        const loadAuditData = async (filter) => {
            emptyRow.style.display = 'table-row';
            emptyCell.textContent = 'Loading\u2026';
            Array.from(tbody.querySelectorAll('[data-audit-row]')).forEach(r => r.remove());
            self.auditSelectedIds.clear();
            self._updateAuditDeleteBtn();
            const allCbEl = document.getElementById('audit-select-all');
            if (allCbEl) { allCbEl.checked = false; allCbEl.indeterminate = false; }
            prevBtn.disabled = true;
            nextBtn.disabled = true;
            pageInfo.textContent = '';

            try {
                const offset = (currentPage - 1) * PAGE_SIZE;
                const [data, stats] = await Promise.all([
                    API.getToolCallAudit(PAGE_SIZE, filter, offset),
                    API.getToolCallAuditStats(),
                ]);

                // Update stat cards
                const statTotal = (stats.blocked || 0) + (stats.allowed || 0) + (stats.log_only || 0);
                if (statsWrapEl.total)   statsWrapEl.total.textContent   = statTotal.toLocaleString();
                if (statsWrapEl.blocked) statsWrapEl.blocked.textContent = (stats.blocked  || 0).toLocaleString();
                if (statsWrapEl.allowed) statsWrapEl.allowed.textContent = (stats.allowed  || 0).toLocaleString();
                if (statsWrapEl.logged)  statsWrapEl.logged.textContent  = (stats.log_only || 0).toLocaleString();

                const entries = data.entries || [];
                totalEntries = data.total || entries.length;

                if (!entries.length) {
                    emptyCell.textContent = filter
                        ? 'No "' + filter + '" tool calls recorded yet.'
                        : 'No tool calls recorded yet. Calls will appear here once the proxy intercepts them.';
                    pageInfo.textContent = '';
                    return;
                }

                lastEntries = entries;
                emptyRow.style.display = 'none';

                // Apply current sort then render
                const sorted = [...lastEntries].sort((a, b) => {
                    let av = a[sortKey] ?? '';
                    let bv = b[sortKey] ?? '';
                    if (typeof av === 'number' || typeof bv === 'number') {
                        av = Number(av); bv = Number(bv);
                    } else {
                        av = String(av).toLowerCase(); bv = String(bv).toLowerCase();
                    }
                    if (av < bv) return sortDir === 'asc' ? -1 : 1;
                    if (av > bv) return sortDir === 'asc' ? 1 : -1;
                    return 0;
                });
                sorted.forEach((entry, idx) => tbody.appendChild(makeRow(entry, idx)));

                // Update pagination
                const totalPages = Math.ceil(totalEntries / PAGE_SIZE);
                pageInfo.textContent = 'Page ' + currentPage + ' of ' + totalPages + ' (' + totalEntries + ' total)';
                prevBtn.disabled = currentPage <= 1;
                nextBtn.disabled = currentPage >= totalPages;
                prevBtn.style.color = prevBtn.disabled ? 'var(--text-muted)' : 'var(--text-primary)';
                nextBtn.style.color = nextBtn.disabled ? 'var(--text-muted)' : 'var(--text-primary)';

            } catch (e) {
                emptyCell.textContent = 'Failed to load: ' + (e.message || 'Unknown error');
            }
        };

        await loadAuditData(null);
    },

    createToolCard(tool, accent) {
        // Card layout:
        //   [icon] [name  [risk]  [★ popular?]]  [action btn]
        //          [tool_id monospace           ]
        //          [mcp_server label            ]
        const isPopular = tool.popular === true;
        const sm = this.SOURCE_META[tool.source] || this.SOURCE_META.conventional;

        const row = document.createElement('div');
        row.dataset.toolId = tool.tool_id;
        const leftBorder = isPopular ? '#f59e0b' : accent.color;
        row.style.cssText = 'display: flex; align-items: center; gap: 6px; padding: 4px 6px; background: var(--bg-card); border: 1px solid var(--border-default); border-radius: var(--radius-md); border-left: 3px solid ' + leftBorder + '; transition: background 0.12s ease, border-color 0.12s ease; cursor: pointer;';
        row.addEventListener('mouseenter', () => { row.style.background = 'var(--bg-secondary)'; row.style.borderColor = accent.color; });
        row.addEventListener('mouseleave', () => { row.style.background = 'var(--bg-card)'; row.style.borderColor = 'var(--border-default)'; row.style.borderLeftColor = leftBorder; });
        row.addEventListener('click', (e) => {
            if (e.target.closest('button')) return; // let button clicks through
            this._showToolDetail(tool, row, accent);
        });

        // Icon — small, 20px
        const icon = document.createElement('div');
        icon.style.cssText = 'width: 20px; height: 20px; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 11px; flex-shrink: 0; background: ' + accent.bg + ';';
        icon.textContent = this._getProviderIcon(tool);
        row.appendChild(icon);

        // Name + popular star — single line, truncated
        const info = document.createElement('div');
        info.style.cssText = 'flex: 1; min-width: 0; display: flex; align-items: center; gap: 3px; overflow: hidden;';

        const nameEl = document.createElement('span');
        nameEl.style.cssText = 'font-weight: 600; font-size: 11px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
        nameEl.textContent = tool.name || tool.tool_id;
        info.appendChild(nameEl);

        if (isPopular) {
            const star = document.createElement('span');
            star.style.cssText = 'font-size: 9px; color: #f59e0b; flex-shrink: 0;';
            star.title = 'Commonly used by agents';
            star.textContent = '★';
            info.appendChild(star);
        }

        row.appendChild(info);

        // Action button + reset (inline row)
        const actionContainer = document.createElement('div');
        actionContainer.style.cssText = 'flex-shrink: 0; display: flex; align-items: center; gap: 3px;';

        let isBlocked = tool.effective_action === 'block';
        const actionBtn = document.createElement('button');
        this._applyActionBtnStyle(actionBtn, isBlocked);
        this._setBtnContent(actionBtn, isBlocked);

        actionBtn.addEventListener('click', async () => {
            const newAction = isBlocked ? 'allow' : 'block';
            try {
                await API.setToolOverride(tool.tool_id, newAction);
                tool.effective_action = newAction;
                tool.has_override = true;
                isBlocked = newAction === 'block';
                this._applyActionBtnStyle(actionBtn, isBlocked);
                this._setBtnContent(actionBtn, isBlocked);
                resetBtn.style.display = 'inline-block';
            } catch (e) {
                if (window.Toast) Toast.show(e.message || 'Failed to update permission', 'error');
            }
        });
        actionContainer.appendChild(actionBtn);

        const resetBtn = document.createElement('button');
        resetBtn.style.cssText = 'padding: 0; font-size: 9px; background: transparent; color: var(--text-muted); border: none; cursor: pointer; transition: color 0.15s; line-height: 1; ' +
            (tool.has_override ? '' : 'display: none;');
        resetBtn.textContent = '↺';
        resetBtn.addEventListener('mouseenter', () => { resetBtn.style.color = 'var(--text-primary)'; });
        resetBtn.addEventListener('mouseleave', () => { resetBtn.style.color = 'var(--text-muted)'; });
        resetBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                await API.deleteToolOverride(tool.tool_id);
                tool.effective_action = tool.default_permission;
                tool.has_override = false;
                isBlocked = tool.effective_action === 'block';
                this._applyActionBtnStyle(actionBtn, isBlocked);
                this._setBtnContent(actionBtn, isBlocked);
                resetBtn.style.display = 'none';
            } catch (e2) {
                if (window.Toast) Toast.show(e2.message || 'Failed to reset', 'error');
            }
        });
        actionContainer.appendChild(resetBtn);
        row.appendChild(actionContainer);

        return row;
    },

    // ==================== Custom Tools ====================

    renderCustomToolsSection(container) {
        const customAccent = { color: '#00bcd4', bg: 'rgba(0,188,212,0.12)' };

        // Section wrapper — either a grid item or nested under code_devops
        const section = document.createElement('div');
        section.style.cssText = 'min-width: 0; margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border-default);';

        // Column header — matches category column header style
        const catHeader = document.createElement('div');
        catHeader.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 8px; padding-bottom: 8px; border-bottom: 2px solid ' + customAccent.color + ';';

        const catDot = document.createElement('span');
        catDot.style.cssText = 'width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: ' + customAccent.color + ';';
        catHeader.appendChild(catDot);

        const catTitle = document.createElement('span');
        catTitle.style.cssText = 'font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: 0.8px; color: var(--text-primary);';
        catTitle.textContent = 'Custom Tools';
        catHeader.appendChild(catTitle);

        const catCount = document.createElement('span');
        catCount.style.cssText = 'font-size: 10px; color: var(--text-muted); margin-left: auto; padding: 1px 6px; background: var(--bg-tertiary); border-radius: var(--radius-full);';
        catCount.textContent = this.customTools.length;
        catHeader.appendChild(catCount);

        // Add Tool button — compact to fit column header
        const addBtn = document.createElement('button');
        addBtn.id = 'custom-tools-add-btn';
        addBtn.style.cssText = 'display: flex; align-items: center; gap: 4px; padding: 2px 10px; border-radius: var(--radius-full); font-size: 11px; font-weight: 600; border: none; background: linear-gradient(135deg, #06b6d4, #ef4444); color: #fff; cursor: pointer; transition: opacity 0.15s; flex-shrink: 0;';
        addBtn.textContent = '+ Add';
        addBtn.addEventListener('mouseenter', () => { addBtn.style.opacity = '0.85'; });
        addBtn.addEventListener('mouseleave', () => { addBtn.style.opacity = '1'; });
        catHeader.appendChild(addBtn);

        section.appendChild(catHeader);

        // Inline add form (hidden by default)
        const formRow = document.createElement('div');
        formRow.style.cssText = 'display: none; background: var(--bg-card); border: 1px dashed ' + customAccent.color + '; border-radius: var(--radius-lg); padding: 16px; margin-bottom: 16px; gap: 12px; flex-wrap: wrap; align-items: flex-end;';

        const makeField = (label, type, placeholder, minWidth) => {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'display: flex; flex-direction: column; gap: 4px; min-width: ' + minWidth + '; flex: 1;';
            const lbl = document.createElement('label');
            lbl.style.cssText = 'font-size: 11px; color: var(--text-secondary); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;';
            lbl.textContent = label;
            wrap.appendChild(lbl);

            const inputStyle = 'padding: 7px 10px; border-radius: var(--radius-md); border: 1px solid var(--border-default); background: var(--bg-secondary); color: var(--text-primary); font-size: 13px; width: 100%; box-sizing: border-box;';

            if (type === 'select') {
                const sel = document.createElement('select');
                sel.style.cssText = inputStyle;
                wrap.appendChild(sel);
                return { wrap, input: sel };
            }

            const inp = document.createElement('input');
            inp.type = 'text';
            inp.placeholder = placeholder || '';
            inp.style.cssText = inputStyle;
            wrap.appendChild(inp);
            return { wrap, input: inp };
        };

        // Tool ID
        const toolIdField = makeField('Tool ID', 'text', 'e.g. research', '120px');
        formRow.appendChild(toolIdField.wrap);

        // Name
        const nameField = makeField('Name', 'text', 'e.g. Research Tool', '140px');
        formRow.appendChild(nameField.wrap);

        // Risk dropdown
        const riskField = makeField('Risk', 'select', '', '80px');
        ['read', 'write', 'delete', 'admin'].forEach(r => {
            const opt = document.createElement('option');
            opt.value = r;
            opt.textContent = r;
            if (r === 'write') opt.selected = true;
            riskField.input.appendChild(opt);
        });
        formRow.appendChild(riskField.wrap);

        // Permission dropdown
        const permField = makeField('Permission', 'select', '', '80px');
        ['block', 'allow'].forEach(p => {
            const opt = document.createElement('option');
            opt.value = p;
            opt.textContent = p;
            permField.input.appendChild(opt);
        });
        formRow.appendChild(permField.wrap);

        // Description
        const descField = makeField('Description', 'text', 'What does this tool do?', '160px');
        formRow.appendChild(descField.wrap);

        // Buttons
        const btnWrap = document.createElement('div');
        btnWrap.style.cssText = 'display: flex; gap: 8px; align-items: center; flex-shrink: 0;';

        const saveBtn = document.createElement('button');
        saveBtn.style.cssText = 'padding: 7px 18px; border-radius: var(--radius-md); font-size: 12px; font-weight: 600; border: none; cursor: pointer; background: ' + customAccent.color + '; color: #fff; transition: opacity 0.15s;';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('mouseenter', () => { if (!saveBtn.disabled) saveBtn.style.opacity = '0.85'; });
        saveBtn.addEventListener('mouseleave', () => { saveBtn.style.opacity = '1'; });

        const cancelBtn = document.createElement('button');
        cancelBtn.style.cssText = 'padding: 7px 14px; border-radius: var(--radius-md); font-size: 12px; font-weight: 500; border: 1px solid var(--border-default); cursor: pointer; background: transparent; color: var(--text-secondary); transition: all 0.15s;';
        cancelBtn.textContent = 'Cancel';

        btnWrap.appendChild(saveBtn);
        btnWrap.appendChild(cancelBtn);
        formRow.appendChild(btnWrap);

        section.appendChild(formRow);

        // Tools grid
        const grid = document.createElement('div');
        grid.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';

        if (this.customTools.length === 0) {
            const empty = document.createElement('div');
            empty.setAttribute('data-empty-state', '1');
            empty.style.cssText = 'text-align: center; padding: 30px; color: var(--text-muted); font-size: 13px; border: 1px dashed var(--border-default); border-radius: var(--radius-lg);';
            empty.textContent = 'No custom tools yet. If your agent uses tool calls not listed above (e.g. your own MCP server or custom functions), add them here to control their permissions.';
            grid.appendChild(empty);
        } else {
            this.customTools.forEach(tool => {
                grid.appendChild(this.createCustomToolCard(tool, customAccent, grid, catCount));
            });
        }

        section.appendChild(grid);
        container.appendChild(section);

        // ---- Form logic ----

        const resetForm = () => {
            formRow.style.display = 'none';
            toolIdField.input.value = '';
            nameField.input.value = '';
            descField.input.value = '';
            riskField.input.value = 'write';
            permField.input.value = 'block';
        };

        // Toggle form visibility
        addBtn.addEventListener('click', () => {
            const isVisible = formRow.style.display === 'flex';
            formRow.style.display = isVisible ? 'none' : 'flex';
            if (!isVisible) toolIdField.input.focus();
        });

        cancelBtn.addEventListener('click', resetForm);

        // Save handler
        const handleSave = async () => {
            const toolId = toolIdField.input.value.trim().replace(/\s+/g, '_').toLowerCase();
            const name = nameField.input.value.trim();
            if (!toolId || !name) {
                if (window.Toast) Toast.show('Tool ID and Name are required', 'error');
                return;
            }

            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving...';
            saveBtn.style.opacity = '0.6';
            saveBtn.style.cursor = 'not-allowed';

            try {
                const payload = {
                    tool_id: toolId,
                    name: name,
                    risk: riskField.input.value,
                    default_permission: permField.input.value,
                    description: descField.input.value.trim(),
                };

                const tool = await API.createCustomTool(payload);

                this.customTools.push(tool);
                catCount.textContent = this.customTools.length;

                // Add card to grid
                const card = this.createCustomToolCard(tool, customAccent, grid, catCount);
                grid.appendChild(card);

                // Hide empty state
                const emptyState = grid.querySelector('[data-empty-state]');
                if (emptyState) emptyState.remove();

                resetForm();

                if (window.Toast) Toast.show('Custom tool added', 'success');
            } catch (e) {
                if (window.Toast) Toast.show(e.message || 'Failed to create tool', 'error');
            } finally {
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save';
                saveBtn.style.opacity = '1';
                saveBtn.style.cursor = 'pointer';
            }
        };

        saveBtn.addEventListener('click', handleSave);

        // Enter key submits form from any text input
        [toolIdField.input, nameField.input, descField.input].forEach(inp => {
            inp.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    handleSave();
                }
            });
        });
    },

    _showCustomToolDetail(tool, anchor, accent, grid, catCount) {
        const existing = document.getElementById('sv-tool-detail-popup');
        if (existing) { if (existing.dataset.toolId === tool.tool_id) { existing.remove(); return; } existing.remove(); }

        const panel = document.createElement('div');
        panel.id = 'sv-tool-detail-popup';
        panel.dataset.toolId = tool.tool_id;
        panel.style.cssText = 'position: fixed; z-index: 9999; width: 300px; background: var(--bg-card); border: 1px solid ' + accent.color + '; border-radius: 12px; padding: 16px; box-shadow: 0 8px 32px rgba(0,0,0,0.35); animation: fadeInUp 0.15s ease;';

        const rect = anchor.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceRight = window.innerWidth - rect.left;
        panel.style.left = (spaceRight >= 310 ? rect.left : Math.max(8, rect.right - 300)) + 'px';
        if (spaceBelow >= 280) { panel.style.top = (rect.bottom + 6) + 'px'; }
        else { panel.style.bottom = (window.innerHeight - rect.top + 6) + 'px'; }

        // Header
        const headerRow = document.createElement('div');
        headerRow.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 12px;';
        const iconEl = document.createElement('div');
        iconEl.style.cssText = 'width: 32px; height: 32px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 15px; flex-shrink: 0; background: ' + accent.bg + ';';
        iconEl.textContent = '⚙️';
        headerRow.appendChild(iconEl);
        const titleCol = document.createElement('div');
        titleCol.style.cssText = 'flex: 1; min-width: 0;';
        const nameEl = document.createElement('div');
        nameEl.style.cssText = 'font-weight: 700; font-size: 13px; color: var(--text-primary);';
        nameEl.textContent = tool.name || tool.tool_id;
        titleCol.appendChild(nameEl);
        const idEl = document.createElement('div');
        idEl.style.cssText = 'font-size: 10px; font-family: monospace; color: var(--text-muted); margin-top: 1px;';
        idEl.textContent = tool.tool_id;
        titleCol.appendChild(idEl);
        headerRow.appendChild(titleCol);
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        closeBtn.style.cssText = 'background: none; border: none; color: var(--text-muted); font-size: 18px; cursor: pointer; padding: 0 2px; line-height: 1; flex-shrink: 0;';
        closeBtn.addEventListener('click', () => panel.remove());
        headerRow.appendChild(closeBtn);
        panel.appendChild(headerRow);

        // Editable fields
        const makeEditField = (label, value, type) => {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'margin-bottom: 8px;';
            const lbl = document.createElement('label');
            lbl.style.cssText = 'display: block; font-size: 10px; color: var(--text-muted); margin-bottom: 2px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px;';
            lbl.textContent = label;
            wrap.appendChild(lbl);
            let input;
            if (type === 'select-risk') {
                input = document.createElement('select');
                ['read','write','delete','admin'].forEach(v => {
                    const o = document.createElement('option'); o.value = v; o.textContent = v; if (v === value) o.selected = true;
                    input.appendChild(o);
                });
            } else {
                input = document.createElement('input');
                input.type = 'text';
                input.value = value || '';
            }
            input.style.cssText = 'width: 100%; padding: 4px 8px; background: var(--bg-secondary); border: 1px solid var(--border-default); border-radius: 4px; color: var(--text-primary); font-size: 12px; box-sizing: border-box;';
            wrap.appendChild(input);
            return { wrap, input };
        };

        const nameField = makeEditField('Name', tool.name, 'text');
        const descField = makeEditField('Description', tool.description, 'text');
        const riskField = makeEditField('Risk', tool.risk, 'select-risk');
        panel.appendChild(nameField.wrap);
        panel.appendChild(descField.wrap);
        panel.appendChild(riskField.wrap);

        // Save button
        const saveBtn = document.createElement('button');
        saveBtn.style.cssText = 'width: 100%; padding: 6px; border-radius: 6px; font-size: 12px; font-weight: 600; border: none; cursor: pointer; background: ' + accent.bg + '; color: ' + accent.color + '; margin-bottom: 6px; transition: opacity 0.15s;';
        saveBtn.textContent = 'Save Changes';
        saveBtn.addEventListener('click', async () => {
            const newName = nameField.input.value.trim();
            if (!newName) { if (window.Toast) Toast.show('Name is required', 'error'); return; }
            saveBtn.disabled = true; saveBtn.textContent = 'Saving...';
            try {
                await API.updateCustomTool(tool.tool_id, { name: newName, description: descField.input.value.trim(), risk: riskField.input.value });
                tool.name = newName; tool.description = descField.input.value.trim(); tool.risk = riskField.input.value;
                const cardName = anchor.querySelector('span');
                if (cardName) cardName.textContent = newName;
                if (window.Toast) Toast.show('Tool updated', 'success');
                panel.remove();
            } catch (e) { if (window.Toast) Toast.show(e.message || 'Failed to update', 'error'); }
            finally { saveBtn.disabled = false; saveBtn.textContent = 'Save Changes'; }
        });
        panel.appendChild(saveBtn);

        // Allow/Block button
        let isBlocked = tool.default_permission === 'block';
        const actionBtn = document.createElement('button');
        actionBtn.style.cssText = 'width: 100%; padding: 7px; border-radius: 8px; font-size: 12px; font-weight: 600; border: none; cursor: pointer; transition: all 0.15s;';
        const applyBtnStyle = (blocked) => {
            actionBtn.style.background = blocked ? 'rgba(239,68,68,0.15)' : 'rgba(16,185,129,0.15)';
            actionBtn.style.color = blocked ? '#ef4444' : '#10b981';
            actionBtn.textContent = blocked ? '✕  Blocked — click to allow' : '✓  Allowed — click to block';
        };
        applyBtnStyle(isBlocked);
        actionBtn.addEventListener('click', async () => {
            const newAction = isBlocked ? 'allow' : 'block';
            try {
                await API.updateCustomToolPermission(tool.tool_id, newAction);
                tool.default_permission = newAction; isBlocked = newAction === 'block';
                applyBtnStyle(isBlocked);
                const miniBtn = anchor.querySelector('button');
                if (miniBtn) { this._applyActionBtnStyle(miniBtn, isBlocked); this._setBtnContent(miniBtn, isBlocked); }
            } catch (e) { if (window.Toast) Toast.show(e.message || 'Failed to update', 'error'); }
        });
        panel.appendChild(actionBtn);

        document.body.appendChild(panel);
        const dismiss = (e) => { if (!panel.contains(e.target) && e.target !== anchor) { panel.remove(); document.removeEventListener('mousedown', dismiss); } };
        setTimeout(() => document.addEventListener('mousedown', dismiss), 10);
        const escDismiss = (e) => { if (e.key === 'Escape') { panel.remove(); document.removeEventListener('keydown', escDismiss); } };
        document.addEventListener('keydown', escDismiss);
    },

    createCustomToolCard(tool, accent, grid, catCount) {
        // Match the compact row style of createToolCard exactly
        const card = document.createElement('div');
        card.dataset.toolId = tool.tool_id;
        card.style.cssText = 'display: flex; align-items: center; gap: 6px; padding: 4px 6px; background: var(--bg-card); border: 1px solid var(--border-default); border-radius: var(--radius-md); border-left: 3px solid ' + accent.color + '; transition: background 0.12s ease, border-color 0.12s ease; cursor: pointer;';
        card.addEventListener('mouseenter', () => { card.style.background = 'var(--bg-secondary)'; card.style.borderColor = accent.color; });
        card.addEventListener('mouseleave', () => { card.style.background = 'var(--bg-card)'; card.style.borderColor = 'var(--border-default)'; card.style.borderLeftColor = accent.color; });
        card.addEventListener('click', (e) => {
            if (e.target.closest('button')) return;
            this._showCustomToolDetail(tool, card, accent, grid, catCount);
        });

        // Icon — 20px matching standard cards
        const icon = document.createElement('div');
        icon.style.cssText = 'width: 20px; height: 20px; border-radius: 4px; display: flex; align-items: center; justify-content: center; font-size: 11px; flex-shrink: 0; background: ' + accent.bg + ';';
        icon.textContent = '⚙️';
        card.appendChild(icon);

        // Name — single line truncated
        const info = document.createElement('div');
        info.style.cssText = 'flex: 1; min-width: 0; overflow: hidden;';

        const nameEl = document.createElement('span');
        nameEl.style.cssText = 'font-weight: 600; font-size: 11px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block;';
        nameEl.textContent = tool.name || tool.tool_id;
        nameEl.title = tool.description || tool.tool_id;
        info.appendChild(nameEl);
        card.appendChild(info);

        // Action btn + delete inline
        const actionContainer = document.createElement('div');
        actionContainer.style.cssText = 'flex-shrink: 0; display: flex; align-items: center; gap: 4px;';

        let isBlocked = tool.default_permission === 'block';
        const actionBtn = document.createElement('button');
        this._applyActionBtnStyle(actionBtn, isBlocked);
        this._setBtnContent(actionBtn, isBlocked);

        actionBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const newAction = isBlocked ? 'allow' : 'block';
            try {
                await API.updateCustomToolPermission(tool.tool_id, newAction);
                tool.default_permission = newAction;
                isBlocked = newAction === 'block';
                this._applyActionBtnStyle(actionBtn, isBlocked);
                this._setBtnContent(actionBtn, isBlocked);
            } catch (e) {
                if (window.Toast) Toast.show(e.message || 'Failed to update permission', 'error');
            }
        });
        actionContainer.appendChild(actionBtn);

        const deleteBtn = document.createElement('button');
        deleteBtn.style.cssText = 'padding: 2px 4px; font-size: 11px; background: transparent; color: var(--text-muted); border: none; cursor: pointer; transition: color 0.15s; line-height: 1;';
        deleteBtn.textContent = '✕';
        deleteBtn.title = 'Delete tool';
        deleteBtn.addEventListener('mouseenter', () => { deleteBtn.style.color = '#ef4444'; });
        deleteBtn.addEventListener('mouseleave', () => { deleteBtn.style.color = 'var(--text-muted)'; });
        deleteBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!confirm('Delete custom tool "' + (tool.name || tool.tool_id) + '"?')) return;
            try {
                await API.deleteCustomTool(tool.tool_id);
                this.customTools = this.customTools.filter(t => t.tool_id !== tool.tool_id);
                catCount.textContent = this.customTools.length;
                card.remove();
                if (this.customTools.length === 0) {
                    const empty = document.createElement('div');
                    empty.setAttribute('data-empty-state', '1');
                    empty.style.cssText = 'text-align: center; padding: 30px; color: var(--text-muted); font-size: 13px; border: 1px dashed var(--border-default); border-radius: var(--radius-lg);';
                    empty.textContent = 'No custom tools yet. If your agent uses tool calls not listed above (e.g. your own MCP server or custom functions), add them here to control their permissions.';
                    grid.appendChild(empty);
                }
                if (window.Toast) Toast.show('Custom tool deleted', 'success');
            } catch (e2) {
                if (window.Toast) Toast.show(e2.message || 'Failed to delete tool', 'error');
            }
        });
        actionContainer.appendChild(deleteBtn);
        card.appendChild(actionContainer);

        return card;
    },
};

window.ToolPermissionsPage = ToolPermissionsPage;
