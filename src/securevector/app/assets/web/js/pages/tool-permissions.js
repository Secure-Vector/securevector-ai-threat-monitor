/**
 * Tool Permissions Page
 * Browse essential tools by category, toggle block/allow per tool
 */

const ToolPermissionsPage = {
    tools: [],
    customTools: [],
    settings: null,

    // ==================== Shared Constants ====================

    RISK_COLORS: {
        read: { bg: 'rgba(96,165,250,0.15)', text: '#60a5fa', border: 'rgba(96,165,250,0.3)' },
        write: { bg: 'rgba(245,158,11,0.15)', text: '#f59e0b', border: 'rgba(245,158,11,0.3)' },
        delete: { bg: 'rgba(239,68,68,0.15)', text: '#ef4444', border: 'rgba(239,68,68,0.3)' },
        admin: { bg: 'rgba(220,38,38,0.15)', text: '#dc2626', border: 'rgba(220,38,38,0.3)' },
    },

    PROVIDER_ICONS: {
        gmail: '\u2709\uFE0F', slack: '\uD83D\uDCAC', twilio: '\uD83D\uDCDE', sendgrid: '\u2709\uFE0F',
        github: '\uD83D\uDC19', gitlab: '\uD83E\uDD8A',
        fs: '\uD83D\uDCC4', gdrive: '\uD83D\uDCC1',
        postgres: '\uD83D\uDDC4\uFE0F', mysql: '\uD83D\uDDC4\uFE0F', mongodb: '\uD83C\uDF43', redis: '\u26A1', sqlite: '\uD83D\uDDC3\uFE0F',
        aws: '\u2601\uFE0F', terraform: '\uD83C\uDFD7\uFE0F', k8s: '\u2699\uFE0F',
        stripe: '\uD83D\uDCB3', paypal: '\uD83D\uDCB0',
        twitter: '\uD83D\uDC26', linkedin: '\uD83D\uDCBC', facebook: '\uD83D\uDC4D',
        vault: '\uD83D\uDD10', onepassword: '\uD83D\uDD11',
    },

    // ==================== Shared Helpers ====================

    _applyActionBtnStyle(btn, isBlocked) {
        btn.style.cssText = 'display: flex; align-items: center; gap: 6px; padding: 7px 16px; border-radius: var(--radius-full); font-size: 12px; font-weight: 600; border: none; cursor: pointer; transition: all 0.2s; min-width: 90px; justify-content: center; ' +
            (isBlocked
                ? 'background: rgba(239,68,68,0.15); color: #ef4444;'
                : 'background: rgba(16,185,129,0.15); color: #10b981;');
    },

    _setBtnContent(btn, blocked) {
        btn.textContent = '';
        const ico = document.createElement('span');
        ico.style.cssText = 'font-size: 12px;';
        ico.textContent = blocked ? '\uD83D\uDEAB' : '\u2705';
        btn.appendChild(ico);
        const lbl = document.createElement('span');
        lbl.textContent = blocked ? 'Blocked' : 'Allowed';
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

    _createRiskBadge(risk) {
        const rc = this.RISK_COLORS[risk] || this.RISK_COLORS.write;
        const badge = document.createElement('span');
        badge.style.cssText = 'font-size: 10px; padding: 2px 8px; border-radius: var(--radius-full); font-weight: 600; text-transform: uppercase; flex-shrink: 0; letter-spacing: 0.3px; border: 1px solid ' + rc.border + '; background: ' + rc.bg + '; color: ' + rc.text + ';';
        badge.textContent = risk;
        return badge;
    },

    _formatRateLimit(maxCalls, windowSeconds) {
        if (!maxCalls || !windowSeconds) return null;
        if (windowSeconds >= 86400) return maxCalls + '/day';
        if (windowSeconds >= 3600) return maxCalls + '/hr';
        if (windowSeconds >= 60) return maxCalls + '/' + (windowSeconds / 60) + 'min';
        return maxCalls + '/' + windowSeconds + 's';
    },

    _createRateLimitBadge(tool) {
        const label = this._formatRateLimit(tool.rate_limit_max_calls, tool.rate_limit_window_seconds);
        if (!label) return null;

        const badge = document.createElement('span');
        badge.style.cssText = 'font-size: 10px; padding: 2px 8px; border-radius: var(--radius-full); font-weight: 600; flex-shrink: 0; letter-spacing: 0.3px; border: 1px solid rgba(6,182,212,0.3); background: rgba(6,182,212,0.12); color: #06b6d4; cursor: pointer; transition: all 0.15s;';
        badge.textContent = '\u23F1 ' + label;
        badge.title = 'Click to edit rate limit';

        badge.addEventListener('mouseenter', () => {
            badge.style.background = 'rgba(6,182,212,0.2)';
        });
        badge.addEventListener('mouseleave', () => {
            badge.style.background = 'rgba(6,182,212,0.12)';
        });

        return badge;
    },

    _showRateLimitEditorInline(tool, badge, metaRow, saveCallback, reopenCallback) {
        // Save original values so cancel can restore them
        const origMaxCalls = tool.rate_limit_max_calls;
        const origWindowSecs = tool.rate_limit_window_seconds;

        // Use recommended values for initial display if no user override
        const displayMax = tool.rate_limit_max_calls || tool.recommended_max_calls || '';
        const displayWindow = tool.rate_limit_window_seconds || tool.recommended_window_seconds || '';

        const editor = document.createElement('span');
        editor.style.cssText = 'display: inline-flex; align-items: center; gap: 4px; font-size: 11px;';

        const maxInput = document.createElement('input');
        maxInput.type = 'number';
        maxInput.min = '1';
        maxInput.max = '10000';
        maxInput.value = displayMax;
        maxInput.placeholder = '#';
        maxInput.style.cssText = 'width: 50px; padding: 2px 4px; border-radius: 4px; border: 1px solid var(--border-default); background: var(--bg-secondary); color: var(--text-primary); font-size: 11px; text-align: center;';

        const sep = document.createElement('span');
        sep.style.cssText = 'color: var(--text-muted); font-size: 10px;';
        sep.textContent = '/';

        const windowSel = document.createElement('select');
        windowSel.style.cssText = 'padding: 2px 4px; border-radius: 4px; border: 1px solid var(--border-default); background: var(--bg-secondary); color: var(--text-primary); font-size: 11px;';
        [
            { value: '', label: 'None' },
            { value: '60', label: '1m' },
            { value: '300', label: '5m' },
            { value: '900', label: '15m' },
            { value: '3600', label: '1h' },
            { value: '86400', label: '24h' },
        ].forEach(w => {
            const opt = document.createElement('option');
            opt.value = w.value;
            opt.textContent = w.label;
            if (String(displayWindow) === w.value) opt.selected = true;
            windowSel.appendChild(opt);
        });

        const saveIcon = document.createElement('span');
        saveIcon.textContent = '\u2714';
        saveIcon.style.cssText = 'cursor: pointer; color: #10b981; font-size: 12px; padding: 0 2px;';
        saveIcon.title = 'Save';

        const cancelIcon = document.createElement('span');
        cancelIcon.textContent = '\u2716';
        cancelIcon.style.cssText = 'cursor: pointer; color: #ef4444; font-size: 12px; padding: 0 2px;';
        cancelIcon.title = 'Cancel';

        editor.appendChild(maxInput);
        editor.appendChild(sep);
        editor.appendChild(windowSel);
        editor.appendChild(saveIcon);
        editor.appendChild(cancelIcon);

        badge.replaceWith(editor);
        maxInput.focus();

        const restoreBadge = () => {
            const newBadge = this._createRateLimitBadge(tool);
            if (newBadge) {
                newBadge.addEventListener('click', (e) => {
                    e.stopPropagation();
                    reopenCallback(tool, newBadge, metaRow);
                });
                editor.replaceWith(newBadge);
            } else if (tool.recommended_max_calls && tool.recommended_window_seconds) {
                // Restore recommended badge (dashed style)
                const recLabel = this._formatRateLimit(tool.recommended_max_calls, tool.recommended_window_seconds);
                const recBadge = document.createElement('span');
                recBadge.style.cssText = 'font-size: 10px; padding: 2px 8px; border-radius: var(--radius-full); font-weight: 500; flex-shrink: 0; letter-spacing: 0.3px; border: 1px dashed rgba(6,182,212,0.25); background: transparent; color: var(--text-muted); cursor: pointer; transition: all 0.15s;';
                recBadge.textContent = '\u23F1 ' + recLabel;
                recBadge.title = 'Recommended limit (click to apply): ' + (tool.rate_limit_note || '');
                recBadge.addEventListener('mouseenter', () => {
                    recBadge.style.borderColor = 'rgba(6,182,212,0.4)';
                    recBadge.style.color = '#06b6d4';
                    recBadge.style.background = 'rgba(6,182,212,0.08)';
                });
                recBadge.addEventListener('mouseleave', () => {
                    recBadge.style.borderColor = 'rgba(6,182,212,0.25)';
                    recBadge.style.color = 'var(--text-muted)';
                    recBadge.style.background = 'transparent';
                });
                recBadge.addEventListener('click', (e) => {
                    e.stopPropagation();
                    reopenCallback(tool, recBadge, metaRow);
                });
                editor.replaceWith(recBadge);
            } else {
                // No rate limit at all — show "+ rate limit" link
                const addRlLink = document.createElement('span');
                addRlLink.style.cssText = 'font-size: 10px; color: var(--text-muted); cursor: pointer; transition: color 0.15s; flex-shrink: 0;';
                addRlLink.textContent = '+ rate limit';
                addRlLink.addEventListener('mouseenter', () => { addRlLink.style.color = '#06b6d4'; });
                addRlLink.addEventListener('mouseleave', () => { addRlLink.style.color = 'var(--text-muted)'; });
                addRlLink.addEventListener('click', (e) => {
                    e.stopPropagation();
                    reopenCallback(tool, addRlLink, metaRow);
                });
                editor.replaceWith(addRlLink);
            }
        };

        cancelIcon.addEventListener('click', (e) => {
            e.stopPropagation();
            // Restore original values (undo any pre-population)
            tool.rate_limit_max_calls = origMaxCalls;
            tool.rate_limit_window_seconds = origWindowSecs;
            restoreBadge();
        });

        saveIcon.addEventListener('click', async (e) => {
            e.stopPropagation();
            const maxCalls = parseInt(maxInput.value) || null;
            const windowSecs = parseInt(windowSel.value) || null;

            try {
                await saveCallback(tool.tool_id, maxCalls, windowSecs);
                tool.rate_limit_max_calls = maxCalls;
                tool.rate_limit_window_seconds = windowSecs;
                restoreBadge();
                if (window.Toast) Toast.show('Rate limit updated', 'success');
            } catch (err) {
                if (window.Toast) Toast.show(err.message || 'Failed to update rate limit', 'error');
            }
        });
    },

    _showRateLimitEditor(tool, badge, metaRow) {
        this._showRateLimitEditorInline(
            tool, badge, metaRow,
            (toolId, maxCalls, windowSecs) => API.updateCustomToolRateLimit(toolId, maxCalls, windowSecs),
            (t, b, m) => this._showRateLimitEditor(t, b, m),
        );
    },

    _showEssentialRateLimitEditor(tool, badge, metaRow) {
        this._showRateLimitEditorInline(
            tool, badge, metaRow,
            (toolId, maxCalls, windowSecs) => API.updateEssentialToolRateLimit(toolId, maxCalls, windowSecs),
            (t, b, m) => this._showEssentialRateLimitEditor(t, b, m),
        );
    },

    // ==================== Render ====================

    async render(container) {
        container.textContent = '';

        // Page wrapper
        const page = document.createElement('div');
        page.className = 'page-wrapper';

        // Compact toolbar: title + toggle + cloud info — single row
        const toolbar = document.createElement('div');
        toolbar.style.cssText = 'display: flex; align-items: center; gap: 16px; margin-bottom: 16px; flex-wrap: wrap;';

        // Title + subtitle
        const titleWrap = document.createElement('div');

        const title = document.createElement('h1');
        title.style.cssText = 'margin: 0; font-size: 20px; font-weight: 700;';
        title.textContent = 'Tool Permissions';
        titleWrap.appendChild(title);

        const subtitle = document.createElement('p');
        subtitle.style.cssText = 'margin: 2px 0 0 0; font-size: 12px; color: var(--text-secondary); line-height: 1.3;';
        subtitle.textContent = 'Control which tools AI agents can use. Block or allow essential and custom tools to enforce security policies at the proxy level.';
        titleWrap.appendChild(subtitle);

        toolbar.appendChild(titleWrap);

        // Enforcement toggle (inline)
        const toggleWrap = document.createElement('div');
        toggleWrap.style.cssText = 'display: flex; align-items: center; gap: 8px;';

        const toggleLabelText = document.createElement('span');
        toggleLabelText.style.cssText = 'font-size: 12px; color: var(--text-secondary);';
        toggleLabelText.textContent = 'Enforcement';
        toggleWrap.appendChild(toggleLabelText);

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
        toolbar.appendChild(toggleWrap);

        // Spacer
        const spacer = document.createElement('div');
        spacer.style.cssText = 'flex: 1;';
        toolbar.appendChild(spacer);

        // Cloud info pill (compact)
        const cloudPill = document.createElement('div');
        cloudPill.id = 'cloud-mode-pill';
        cloudPill.style.cssText = 'display: none; align-items: center; gap: 6px; font-size: 11px; color: var(--text-secondary); padding: 4px 10px; border-radius: var(--radius-full); border: 1px solid var(--border-default); background: var(--bg-secondary);';
        toolbar.appendChild(cloudPill);

        page.appendChild(toolbar);

        // Tools list container
        const toolsContainer = document.createElement('div');
        toolsContainer.id = 'tools-list-container';

        // Loading state
        const loading = document.createElement('div');
        loading.style.cssText = 'text-align: center; padding: 20px; color: var(--text-secondary); font-size: 13px;';
        loading.textContent = 'Loading essential tools...';
        toolsContainer.appendChild(loading);

        page.appendChild(toolsContainer);
        container.appendChild(page);

        // Load data
        await this.loadData(toggleInput, toolsContainer, cloudPill);
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
            pill.textContent = '\uD83D\uDCE6 ' + toolCount + ' local tools \u2022 200+ with Cloud';
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
            communication: 'Communication',
            code_devops: 'Code & DevOps',
            file_system: 'File System',
            database: 'Database',
            cloud_infra: 'Cloud & Infrastructure',
            payment: 'Payment',
            social_media: 'Social Media',
            security: 'Security',
        };

        // Category accent colors for left border + icon background
        const categoryAccents = {
            communication: { color: '#00bcd4', bg: 'rgba(0,188,212,0.12)' },
            code_devops: { color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)' },
            file_system: { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
            database: { color: '#22d3ee', bg: 'rgba(34,211,238,0.12)' },
            cloud_infra: { color: '#06b6d4', bg: 'rgba(6,182,212,0.12)' },
            payment: { color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
            social_media: { color: '#ec4899', bg: 'rgba(236,72,153,0.12)' },
            security: { color: '#ff6b6b', bg: 'rgba(255,107,107,0.15)' },
        };

        // ==================== Custom Tools Section (top) ====================
        this.renderCustomToolsSection(container);

        Object.entries(categories).forEach(([catKey, tools]) => {
            const accent = categoryAccents[catKey] || { color: '#64748b', bg: 'rgba(100,116,139,0.12)' };

            const section = document.createElement('div');
            section.style.cssText = 'margin-bottom: 32px;';

            // Category header with accent bar
            const catHeader = document.createElement('div');
            catHeader.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 16px; padding-bottom: 10px; border-bottom: 1px solid var(--border-default);';

            // Colored dot indicator
            const catDot = document.createElement('span');
            catDot.style.cssText = 'width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: ' + accent.color + ';';
            catHeader.appendChild(catDot);

            const catTitle = document.createElement('span');
            catTitle.style.cssText = 'font-weight: 700; font-size: 13px; text-transform: uppercase; letter-spacing: 0.8px; color: var(--text-primary);';
            catTitle.textContent = categoryLabels[catKey] || catKey;
            catHeader.appendChild(catTitle);

            const catCount = document.createElement('span');
            catCount.style.cssText = 'font-size: 11px; color: var(--text-muted); margin-left: auto; padding: 2px 8px; background: var(--bg-tertiary); border-radius: var(--radius-full);';
            catCount.textContent = tools.length;
            catHeader.appendChild(catCount);

            section.appendChild(catHeader);

            // Tools grid
            const grid = document.createElement('div');
            grid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px;';

            tools.forEach(tool => {
                grid.appendChild(this.createToolCard(tool, accent));
            });

            section.appendChild(grid);
            container.appendChild(section);
        });

        // Attribution footer
        const attribution = document.createElement('div');
        attribution.style.cssText = 'margin-top: 40px; padding: 16px 20px; text-align: center; font-size: 11px; color: var(--text-muted); border-top: 1px solid var(--border-default);';
        attribution.textContent = 'Tool names are trademarks of their respective owners. SecureVector is not affiliated with or endorsed by these providers.';
        container.appendChild(attribution);
    },

    createToolCard(tool, accent) {
        const card = document.createElement('div');
        card.style.cssText = 'background: var(--bg-card); border: 1px solid var(--border-default); border-radius: var(--radius-lg); overflow: hidden; transition: all 0.2s ease; cursor: default; border-left: 3px solid ' + accent.color + ';';
        this._applyCardHover(card, accent);

        // Top row: icon + name + action button
        const topRow = document.createElement('div');
        topRow.style.cssText = 'display: flex; align-items: center; gap: 12px; padding: 12px 14px 0 14px;';

        // Provider icon circle
        const provider = tool.tool_id.split('.')[0];
        const iconCircle = document.createElement('div');
        iconCircle.style.cssText = 'width: 36px; height: 36px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 16px; flex-shrink: 0; background: ' + accent.bg + ';';
        iconCircle.textContent = this.PROVIDER_ICONS[provider] || '\uD83D\uDD27';
        topRow.appendChild(iconCircle);

        // Name + description block
        const info = document.createElement('div');
        info.style.cssText = 'flex: 1; min-width: 0;';

        const nameRow = document.createElement('div');
        nameRow.style.cssText = 'display: flex; align-items: center; gap: 5px;';

        const parts = tool.tool_id.split('.');
        if (parts.length === 2) {
            const providerName = document.createElement('span');
            providerName.style.cssText = 'font-size: 11px; color: var(--text-muted); font-weight: 500;';
            providerName.textContent = tool.provider || parts[0];
            nameRow.appendChild(providerName);

            const dot = document.createElement('span');
            dot.style.cssText = 'font-size: 8px; color: var(--text-muted);';
            dot.textContent = '\u2022';
            nameRow.appendChild(dot);

            const funcName = document.createElement('span');
            funcName.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--text-primary);';
            funcName.textContent = tool.name || parts[1];
            nameRow.appendChild(funcName);
        } else {
            const funcName = document.createElement('span');
            funcName.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--text-primary);';
            funcName.textContent = tool.name || tool.tool_id;
            nameRow.appendChild(funcName);
        }

        info.appendChild(nameRow);

        const desc = document.createElement('div');
        desc.style.cssText = 'font-size: 11px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px;';
        desc.textContent = tool.description || '';
        desc.title = tool.description || '';
        info.appendChild(desc);

        topRow.appendChild(info);

        // Action button
        const actionContainer = document.createElement('div');
        actionContainer.style.cssText = 'flex-shrink: 0; display: flex; flex-direction: column; align-items: center; gap: 3px;';

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
        resetBtn.style.cssText = 'padding: 0; font-size: 10px; background: transparent; color: var(--text-muted); border: none; cursor: pointer; transition: color 0.15s; ' +
            (tool.has_override ? '' : 'display: none;');
        resetBtn.textContent = 'Reset';
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
        topRow.appendChild(actionContainer);

        card.appendChild(topRow);

        // Bottom row: badges + rate limit
        const badgeRow = document.createElement('div');
        badgeRow.style.cssText = 'display: flex; align-items: center; gap: 6px; padding: 8px 14px 10px 14px; flex-wrap: wrap;';

        badgeRow.appendChild(this._createRiskBadge(tool.risk));

        // Rate limit: show user override if set, else show recommended from YAML
        const hasUserRl = tool.rate_limit_max_calls && tool.rate_limit_window_seconds;
        const hasRecommended = tool.recommended_max_calls && tool.recommended_window_seconds;

        if (hasUserRl) {
            const rlBadge = this._createRateLimitBadge(tool);
            rlBadge.addEventListener('click', (e) => {
                e.stopPropagation();
                this._showEssentialRateLimitEditor(tool, rlBadge, badgeRow);
            });
            badgeRow.appendChild(rlBadge);
        } else if (hasRecommended) {
            // Show recommended as a muted badge users can click to apply
            const recLabel = this._formatRateLimit(tool.recommended_max_calls, tool.recommended_window_seconds);
            const recBadge = document.createElement('span');
            recBadge.style.cssText = 'font-size: 10px; padding: 2px 8px; border-radius: var(--radius-full); font-weight: 500; flex-shrink: 0; letter-spacing: 0.3px; border: 1px dashed rgba(6,182,212,0.25); background: transparent; color: var(--text-muted); cursor: pointer; transition: all 0.15s;';
            recBadge.textContent = '\u23F1 ' + recLabel;
            recBadge.title = 'Recommended limit (click to apply): ' + (tool.rate_limit_note || '');
            recBadge.addEventListener('mouseenter', () => {
                recBadge.style.borderColor = 'rgba(6,182,212,0.4)';
                recBadge.style.color = '#06b6d4';
                recBadge.style.background = 'rgba(6,182,212,0.08)';
            });
            recBadge.addEventListener('mouseleave', () => {
                recBadge.style.borderColor = 'rgba(6,182,212,0.25)';
                recBadge.style.color = 'var(--text-muted)';
                recBadge.style.background = 'transparent';
            });
            recBadge.addEventListener('click', (e) => {
                e.stopPropagation();
                this._showEssentialRateLimitEditor(tool, recBadge, badgeRow);
            });
            badgeRow.appendChild(recBadge);
        } else {
            const addRlLink = document.createElement('span');
            addRlLink.style.cssText = 'font-size: 10px; color: var(--text-muted); cursor: pointer; transition: color 0.15s; flex-shrink: 0;';
            addRlLink.textContent = '+ rate limit';
            addRlLink.addEventListener('mouseenter', () => { addRlLink.style.color = '#06b6d4'; });
            addRlLink.addEventListener('mouseleave', () => { addRlLink.style.color = 'var(--text-muted)'; });
            addRlLink.addEventListener('click', (e) => {
                e.stopPropagation();
                this._showEssentialRateLimitEditor(tool, addRlLink, badgeRow);
            });
            badgeRow.appendChild(addRlLink);
        }

        // Rate limit note (if available from YAML)
        if (tool.rate_limit_note) {
            const noteSpan = document.createElement('span');
            noteSpan.style.cssText = 'font-size: 10px; color: var(--text-muted); margin-left: auto; max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
            noteSpan.textContent = tool.rate_limit_note;
            noteSpan.title = tool.rate_limit_note;
            badgeRow.appendChild(noteSpan);
        }

        card.appendChild(badgeRow);
        return card;
    },

    // ==================== Custom Tools ====================

    renderCustomToolsSection(container) {
        const customAccent = { color: '#a855f7', bg: 'rgba(168,85,247,0.12)' };

        const section = document.createElement('div');
        section.style.cssText = 'margin-bottom: 32px;';

        // Section header
        const catHeader = document.createElement('div');
        catHeader.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 16px; padding-bottom: 10px; border-bottom: 1px solid var(--border-default);';

        const catDot = document.createElement('span');
        catDot.style.cssText = 'width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: ' + customAccent.color + ';';
        catHeader.appendChild(catDot);

        const catTitle = document.createElement('span');
        catTitle.style.cssText = 'font-weight: 700; font-size: 13px; text-transform: uppercase; letter-spacing: 0.8px; color: var(--text-primary);';
        catTitle.textContent = 'Custom Tools';
        catHeader.appendChild(catTitle);

        const catCount = document.createElement('span');
        catCount.style.cssText = 'font-size: 11px; color: var(--text-muted); padding: 2px 8px; background: var(--bg-tertiary); border-radius: var(--radius-full);';
        catCount.textContent = this.customTools.length;
        catHeader.appendChild(catCount);

        const headerSpacer = document.createElement('div');
        headerSpacer.style.cssText = 'flex: 1;';
        catHeader.appendChild(headerSpacer);

        // Add Tool button
        const addBtn = document.createElement('button');
        addBtn.style.cssText = 'display: flex; align-items: center; gap: 5px; padding: 5px 14px; border-radius: var(--radius-full); font-size: 12px; font-weight: 600; border: 1px solid ' + customAccent.color + '; background: transparent; color: ' + customAccent.color + '; cursor: pointer; transition: all 0.15s;';
        addBtn.textContent = '+ Add Tool';
        addBtn.addEventListener('mouseenter', () => {
            addBtn.style.background = customAccent.bg;
        });
        addBtn.addEventListener('mouseleave', () => {
            addBtn.style.background = 'transparent';
        });
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

        // Rate Limit: Max Calls
        const maxCallsField = makeField('Max Calls', 'text', 'e.g. 10', '80px');
        maxCallsField.input.type = 'number';
        maxCallsField.input.min = '1';
        maxCallsField.input.max = '10000';
        formRow.appendChild(maxCallsField.wrap);

        // Rate Limit: Window
        const windowField = makeField('Window', 'select', '', '90px');
        const windowOptions = [
            { value: '', label: 'No limit' },
            { value: '60', label: '1 min' },
            { value: '300', label: '5 min' },
            { value: '900', label: '15 min' },
            { value: '3600', label: '1 hour' },
            { value: '86400', label: '24 hours' },
        ];
        windowOptions.forEach(w => {
            const opt = document.createElement('option');
            opt.value = w.value;
            opt.textContent = w.label;
            windowField.input.appendChild(opt);
        });
        formRow.appendChild(windowField.wrap);

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
        grid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px;';

        if (this.customTools.length === 0) {
            const empty = document.createElement('div');
            empty.setAttribute('data-empty-state', '1');
            empty.style.cssText = 'grid-column: 1 / -1; text-align: center; padding: 30px; color: var(--text-muted); font-size: 13px; border: 1px dashed var(--border-default); border-radius: var(--radius-lg);';
            empty.textContent = 'No custom tools. Add your agent\'s tools to control their permissions.';
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
            maxCallsField.input.value = '';
            windowField.input.value = '';
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

                // Add rate limit if both fields are set
                const maxCalls = parseInt(maxCallsField.input.value);
                const windowSecs = parseInt(windowField.input.value);
                if (maxCalls > 0 && windowSecs > 0) {
                    payload.rate_limit_max_calls = maxCalls;
                    payload.rate_limit_window_seconds = windowSecs;
                }

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

    createCustomToolCard(tool, accent, grid, catCount) {
        const card = document.createElement('div');
        card.style.cssText = 'background: var(--bg-card); border: 1px solid var(--border-default); border-radius: var(--radius-lg); overflow: hidden; transition: all 0.2s ease; cursor: default; border-left: 3px solid ' + accent.color + ';';
        this._applyCardHover(card, accent);

        // Top row: icon + name/desc + action
        const topRow = document.createElement('div');
        topRow.style.cssText = 'display: flex; align-items: center; gap: 12px; padding: 12px 14px 0 14px;';

        const iconCircle = document.createElement('div');
        iconCircle.style.cssText = 'width: 36px; height: 36px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 16px; flex-shrink: 0; background: ' + accent.bg + ';';
        iconCircle.textContent = '\uD83D\uDD27';
        topRow.appendChild(iconCircle);

        const info = document.createElement('div');
        info.style.cssText = 'flex: 1; min-width: 0;';

        const nameRow = document.createElement('div');
        nameRow.style.cssText = 'display: flex; align-items: center; gap: 5px;';

        const funcName = document.createElement('span');
        funcName.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--text-primary);';
        funcName.textContent = tool.name || tool.tool_id;
        nameRow.appendChild(funcName);

        const idBadge = document.createElement('span');
        idBadge.style.cssText = 'font-size: 10px; color: var(--text-muted); font-family: monospace; background: var(--bg-tertiary); padding: 1px 6px; border-radius: var(--radius-sm);';
        idBadge.textContent = tool.tool_id;
        nameRow.appendChild(idBadge);
        info.appendChild(nameRow);

        const desc = document.createElement('div');
        desc.style.cssText = 'font-size: 11px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px;';
        desc.textContent = tool.description || 'Custom tool';
        desc.title = tool.description || 'Custom tool';
        info.appendChild(desc);

        topRow.appendChild(info);

        // Action button + delete
        const actionContainer = document.createElement('div');
        actionContainer.style.cssText = 'flex-shrink: 0; display: flex; flex-direction: column; align-items: center; gap: 3px;';

        let isBlocked = tool.default_permission === 'block';
        const actionBtn = document.createElement('button');
        this._applyActionBtnStyle(actionBtn, isBlocked);
        this._setBtnContent(actionBtn, isBlocked);

        actionBtn.addEventListener('click', async () => {
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
        deleteBtn.style.cssText = 'padding: 0; font-size: 10px; background: transparent; color: var(--text-muted); border: none; cursor: pointer; transition: color 0.15s;';
        deleteBtn.textContent = 'Delete';
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
                    empty.style.cssText = 'grid-column: 1 / -1; text-align: center; padding: 30px; color: var(--text-muted); font-size: 13px; border: 1px dashed var(--border-default); border-radius: var(--radius-lg);';
                    empty.textContent = 'No custom tools. Add your agent\'s tools to control their permissions.';
                    grid.appendChild(empty);
                }
                if (window.Toast) Toast.show('Custom tool deleted', 'success');
            } catch (e2) {
                if (window.Toast) Toast.show(e2.message || 'Failed to delete tool', 'error');
            }
        });
        actionContainer.appendChild(deleteBtn);
        topRow.appendChild(actionContainer);

        card.appendChild(topRow);

        // Bottom row: badges + rate limit
        const badgeRow = document.createElement('div');
        badgeRow.style.cssText = 'display: flex; align-items: center; gap: 6px; padding: 8px 14px 10px 14px; flex-wrap: wrap;';

        badgeRow.appendChild(this._createRiskBadge(tool.risk));

        const rlBadge = this._createRateLimitBadge(tool);
        if (rlBadge) {
            rlBadge.addEventListener('click', (e) => {
                e.stopPropagation();
                this._showRateLimitEditor(tool, rlBadge, badgeRow);
            });
            badgeRow.appendChild(rlBadge);
        } else {
            const addRlLink = document.createElement('span');
            addRlLink.style.cssText = 'font-size: 10px; color: var(--text-muted); cursor: pointer; transition: color 0.15s; flex-shrink: 0;';
            addRlLink.textContent = '+ rate limit';
            addRlLink.addEventListener('mouseenter', () => { addRlLink.style.color = '#06b6d4'; });
            addRlLink.addEventListener('mouseleave', () => { addRlLink.style.color = 'var(--text-muted)'; });
            addRlLink.addEventListener('click', (e) => {
                e.stopPropagation();
                this._showRateLimitEditor(tool, addRlLink, badgeRow);
            });
            badgeRow.appendChild(addRlLink);
        }

        card.appendChild(badgeRow);
        return card;
    },
};

window.ToolPermissionsPage = ToolPermissionsPage;
