/**
 * Proxy Page
 * Proxy control and settings for Block Mode and Output Scan
 */

const ProxyPage = {
    settings: null,
    proxyStatus: 'stopped', // 'stopped', 'starting', 'running', 'stopping'
    statusCheckInterval: null,

    async render(container) {
        container.textContent = '';

        // Loading state
        const loading = document.createElement('div');
        loading.className = 'loading-container';
        const spinner = document.createElement('div');
        spinner.className = 'spinner';
        loading.appendChild(spinner);
        container.appendChild(loading);

        try {
            this.settings = await API.getSettings();
            await this.checkProxyStatus();
            this.renderContent(container);
            this.startStatusPolling();
        } catch (error) {
            this.settings = { block_threats: false, scan_llm_responses: true };
            this.renderContent(container);
        }
    },

    async checkProxyStatus() {
        try {
            const response = await fetch('/api/proxy/status');
            if (response.ok) {
                const data = await response.json();
                this.proxyStatus = data.running ? 'running' : 'stopped';
            }
        } catch (e) {
            this.proxyStatus = 'stopped';
        }
    },

    startStatusPolling() {
        if (this.statusCheckInterval) clearInterval(this.statusCheckInterval);
        this.statusCheckInterval = setInterval(async () => {
            const oldStatus = this.proxyStatus;
            await this.checkProxyStatus();
            if (oldStatus !== this.proxyStatus) {
                this.updateProxyStatusUI();
            }
        }, 3000);
    },

    stopStatusPolling() {
        if (this.statusCheckInterval) {
            clearInterval(this.statusCheckInterval);
            this.statusCheckInterval = null;
        }
    },

    renderContent(container) {
        container.textContent = '';

        // Page header
        const header = document.createElement('div');
        header.style.cssText = 'margin-bottom: 20px;';

        const pageTitle = document.createElement('h1');
        pageTitle.style.cssText = 'font-size: 24px; font-weight: 600; color: var(--text-primary); margin: 0 0 4px 0;';
        pageTitle.textContent = 'Agent Proxy';
        header.appendChild(pageTitle);

        const pageSubtitle = document.createElement('p');
        pageSubtitle.style.cssText = 'font-size: 14px; color: var(--text-secondary); margin: 0;';
        pageSubtitle.textContent = 'Secure your OpenClaw/ClaudBot setup';
        header.appendChild(pageSubtitle);

        container.appendChild(header);

        // Page intro with why proxy explanation
        const intro = document.createElement('div');
        intro.className = 'page-intro';
        intro.style.cssText = 'margin-bottom: 24px;';

        const introTitle = document.createElement('div');
        introTitle.style.cssText = 'color: var(--text-primary); font-size: 14px; margin-bottom: 12px;';
        introTitle.textContent = 'WebSocket proxy for intercepting and scanning agent messages in real-time.';
        intro.appendChild(introTitle);

        // Why proxy box
        const whyBox = document.createElement('div');
        whyBox.style.cssText = 'background: var(--bg-tertiary); border-radius: 8px; padding: 16px; font-size: 13px;';

        const whyTitle = document.createElement('div');
        whyTitle.style.cssText = 'font-weight: 600; margin-bottom: 8px; color: var(--accent-primary);';
        whyTitle.textContent = 'Why Proxy Mode?';
        whyBox.appendChild(whyTitle);

        const whyList = document.createElement('ul');
        whyList.style.cssText = 'margin: 0; padding-left: 20px; color: var(--text-secondary); line-height: 1.8;';

        const reasons = [
            'Detects & prevents: prompt injection, jailbreaks, data leaks, PII, social engineering, OWASP LLM Top 10',
            'OpenClaw has no built-in message interception hooks',
            'Hooks only fire AFTER messages reach the LLM (too late for blocking)',
            'Skills require LLM cooperation which is unreliable',
            'Proxy intercepts at network level = 100% coverage before LLM sees the message'
        ];

        reasons.forEach(reason => {
            const li = document.createElement('li');
            li.textContent = reason;
            whyList.appendChild(li);
        });

        whyBox.appendChild(whyList);

        intro.appendChild(whyBox);
        container.appendChild(intro);

        // Proxy Control Section
        const proxySection = this.createSection('OpenClaw Proxy', 'WebSocket proxy for intercepting and scanning OpenClaw messages');
        const proxyCard = this.createCard();
        const proxyBody = proxyCard.querySelector('.card-body');
        this.renderProxyControl(proxyBody);
        proxySection.appendChild(proxyCard);
        container.appendChild(proxySection);

        // Block Mode Section
        const blockSection = this.createSection('Block Mode', 'When enabled, detected threats are blocked (inputs not sent to agents, outputs not sent to user)');
        const blockCard = this.createCard();
        const blockBody = blockCard.querySelector('.card-body');
        this.renderBlockMode(blockBody);
        blockSection.appendChild(blockCard);
        container.appendChild(blockSection);

        // Output Scan Section - Highlighted
        const outputSection = this.createSection('Scan LLM Responses for Leaks', 'Scan LLM responses for data leakage, credentials, and PII exposure', true);
        const outputCard = this.createCard();
        const outputBody = outputCard.querySelector('.card-body');
        this.renderOutputScan(outputBody);
        outputSection.appendChild(outputCard);
        container.appendChild(outputSection);

    },

    renderProxyControl(container) {
        // Prerequisites section
        const prereqBox = document.createElement('div');
        prereqBox.style.cssText = 'background: rgba(255, 193, 7, 0.1); border: 1px solid var(--warning); border-radius: 8px; padding: 16px; margin-bottom: 20px;';

        const prereqTitle = document.createElement('div');
        prereqTitle.style.cssText = 'font-weight: 600; margin-bottom: 8px; color: var(--warning);';
        prereqTitle.textContent = '⚠️ Prerequisites';

        const prereqList = document.createElement('ol');
        prereqList.style.cssText = 'margin: 0; padding-left: 20px; color: var(--text-secondary); font-size: 13px; line-height: 1.8;';

        const prereq1 = document.createElement('li');
        prereq1.textContent = 'OpenClaw must be installed and configured';
        prereqList.appendChild(prereq1);

        const prereq2 = document.createElement('li');
        const prereq2Text = document.createTextNode('Start OpenClaw gateway on port 18790: ');
        const prereq2Code = document.createElement('code');
        prereq2Code.style.cssText = 'background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px;';
        prereq2Code.textContent = 'openclaw gateway --port 18790';
        prereq2.appendChild(prereq2Text);
        prereq2.appendChild(prereq2Code);
        prereqList.appendChild(prereq2);

        prereqBox.appendChild(prereqTitle);
        prereqBox.appendChild(prereqList);
        container.appendChild(prereqBox);

        // Status row
        const statusRow = document.createElement('div');
        statusRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 16px 0; border-bottom: 1px solid var(--border-default);';

        const statusInfo = document.createElement('div');

        const statusLabel = document.createElement('div');
        statusLabel.style.cssText = 'font-weight: 600; font-size: 15px; margin-bottom: 4px;';
        statusLabel.textContent = 'Proxy Status';
        statusInfo.appendChild(statusLabel);

        const statusDesc = document.createElement('div');
        statusDesc.id = 'proxy-status-text';
        statusDesc.style.cssText = 'font-size: 13px; display: flex; align-items: center; gap: 8px;';
        this.updateStatusText(statusDesc);
        statusInfo.appendChild(statusDesc);

        statusRow.appendChild(statusInfo);

        // Start/Stop button
        const actionBtn = document.createElement('button');
        actionBtn.id = 'proxy-action-btn';
        actionBtn.style.cssText = 'padding: 10px 24px; border-radius: 8px; font-weight: 600; font-size: 14px; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; gap: 8px;';
        this.updateActionButton(actionBtn);
        actionBtn.addEventListener('click', () => this.toggleProxy());
        statusRow.appendChild(actionBtn);

        container.appendChild(statusRow);

        // Connection info
        const connInfo = document.createElement('div');
        connInfo.style.cssText = 'padding: 16px 0;';

        const connGrid = document.createElement('div');
        connGrid.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 16px;';

        // Proxy Port
        const proxyPortBox = document.createElement('div');
        proxyPortBox.style.cssText = 'background: var(--bg-tertiary); border-radius: 8px; padding: 12px 16px;';
        const proxyPortLabel = document.createElement('div');
        proxyPortLabel.style.cssText = 'color: var(--text-secondary); font-size: 12px; margin-bottom: 4px;';
        proxyPortLabel.textContent = 'Proxy Listen Port';
        const proxyPortValue = document.createElement('div');
        proxyPortValue.style.cssText = 'font-family: monospace; font-size: 14px; color: var(--accent-primary);';
        proxyPortValue.textContent = 'ws://127.0.0.1:18789';
        proxyPortBox.appendChild(proxyPortLabel);
        proxyPortBox.appendChild(proxyPortValue);
        connGrid.appendChild(proxyPortBox);

        // OpenClaw Port
        const openclawPortBox = document.createElement('div');
        openclawPortBox.style.cssText = 'background: var(--bg-tertiary); border-radius: 8px; padding: 12px 16px;';
        const openclawPortLabel = document.createElement('div');
        openclawPortLabel.style.cssText = 'color: var(--text-secondary); font-size: 12px; margin-bottom: 4px;';
        openclawPortLabel.textContent = 'OpenClaw Gateway Port';
        const openclawPortValue = document.createElement('div');
        openclawPortValue.style.cssText = 'font-family: monospace; font-size: 14px; color: var(--text-primary);';
        openclawPortValue.textContent = 'ws://127.0.0.1:18790';
        openclawPortBox.appendChild(openclawPortLabel);
        openclawPortBox.appendChild(openclawPortValue);
        connGrid.appendChild(openclawPortBox);

        connInfo.appendChild(connGrid);
        container.appendChild(connInfo);

        // Stop proxy note
        const stopNote = document.createElement('div');
        stopNote.style.cssText = 'background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: 8px; padding: 12px 16px; margin-top: 12px; font-size: 13px;';

        const stopNoteTitle = document.createElement('div');
        stopNoteTitle.style.cssText = 'font-weight: 600; margin-bottom: 6px; color: var(--text-primary);';
        stopNoteTitle.textContent = 'When stopping the proxy:';
        stopNote.appendChild(stopNoteTitle);

        const stopNoteText = document.createElement('div');
        stopNoteText.style.cssText = 'color: var(--text-secondary);';
        stopNoteText.textContent = 'Restart OpenClaw gateway on default port so TUI can connect directly: ';
        const stopNoteCode = document.createElement('code');
        stopNoteCode.style.cssText = 'background: var(--bg-secondary); padding: 2px 6px; border-radius: 4px;';
        stopNoteCode.textContent = 'openclaw gateway';
        stopNoteText.appendChild(stopNoteCode);
        stopNote.appendChild(stopNoteText);

        container.appendChild(stopNote);
    },

    updateStatusText(element) {
        const el = element || document.getElementById('proxy-status-text');
        if (!el) return;

        el.textContent = '';

        const statusColors = {
            'stopped': 'var(--text-secondary)',
            'starting': 'var(--warning)',
            'running': 'var(--success)',
            'stopping': 'var(--warning)'
        };

        const statusIcons = {
            'stopped': '⚫',
            'starting': '🟡',
            'running': '🟢',
            'stopping': '🟡'
        };

        const statusTextMap = {
            'stopped': 'Not Running',
            'starting': 'Starting...',
            'running': 'Running',
            'stopping': 'Stopping...'
        };

        const icon = document.createElement('span');
        icon.style.fontSize = '10px';
        icon.textContent = statusIcons[this.proxyStatus];

        const text = document.createElement('span');
        text.style.color = statusColors[this.proxyStatus];
        text.textContent = statusTextMap[this.proxyStatus];

        el.appendChild(icon);
        el.appendChild(text);
    },

    updateActionButton(button) {
        const btn = button || document.getElementById('proxy-action-btn');
        if (!btn) return;

        btn.textContent = '';

        if (this.proxyStatus === 'running') {
            btn.style.background = 'var(--danger)';
            btn.style.color = 'white';
            btn.style.border = 'none';
            btn.textContent = '⏹ Stop Proxy';
            btn.disabled = false;
        } else if (this.proxyStatus === 'stopped') {
            btn.style.background = 'var(--success)';
            btn.style.color = 'white';
            btn.style.border = 'none';
            btn.textContent = '▶ Start Proxy';
            btn.disabled = false;
        } else {
            btn.style.background = 'var(--bg-tertiary)';
            btn.style.color = 'var(--text-secondary)';
            btn.style.border = '1px solid var(--border-default)';
            btn.textContent = '⏳ ' + (this.proxyStatus === 'starting' ? 'Starting...' : 'Stopping...');
            btn.disabled = true;
        }
    },

    updateProxyStatusUI() {
        this.updateStatusText();
        this.updateActionButton();
    },

    async toggleProxy() {
        if (this.proxyStatus === 'running') {
            this.proxyStatus = 'stopping';
            this.updateProxyStatusUI();
            try {
                const response = await fetch('/api/proxy/stop', { method: 'POST' });
                if (response.ok) {
                    this.proxyStatus = 'stopped';
                    Toast.success('Proxy stopped');
                } else {
                    throw new Error('Failed to stop proxy');
                }
            } catch (e) {
                Toast.error('Failed to stop proxy');
                this.proxyStatus = 'running';
            }
        } else if (this.proxyStatus === 'stopped') {
            this.proxyStatus = 'starting';
            this.updateProxyStatusUI();
            try {
                const response = await fetch('/api/proxy/start', { method: 'POST' });
                if (response.ok) {
                    this.proxyStatus = 'running';
                    Toast.success('Proxy started on port 18789');
                } else {
                    throw new Error('Failed to start proxy');
                }
            } catch (e) {
                Toast.error('Failed to start proxy');
                this.proxyStatus = 'stopped';
            }
        }
        this.updateProxyStatusUI();
    },

    renderBlockMode(container) {
        const row = document.createElement('div');
        row.className = 'settings-row';
        row.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 16px 0;';

        const info = document.createElement('div');

        const label = document.createElement('div');
        label.style.cssText = 'font-weight: 600; font-size: 15px; margin-bottom: 4px;';
        label.textContent = 'Enable Block Mode';
        info.appendChild(label);

        const desc = document.createElement('div');
        desc.style.cssText = 'color: var(--text-secondary); font-size: 13px;';
        desc.textContent = 'Block threats instead of just logging them';
        info.appendChild(desc);

        row.appendChild(info);

        // Toggle
        const toggle = document.createElement('label');
        toggle.className = 'toggle';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = this.settings.block_threats;
        checkbox.addEventListener('change', async (e) => {
            const newState = e.target.checked;
            const message = newState
                ? 'Enable Block Mode?\n\nInput threats will be BLOCKED (not sent to agents).\nOutput threats will be BLOCKED (not sent to user).\n\nNote: Output blocking disables streaming.'
                : 'Disable Block Mode?\n\nThreats will be logged but NOT blocked.';

            if (!confirm(message)) {
                e.target.checked = !newState;
                return;
            }

            try {
                await API.updateSettings({ block_threats: newState });
                Toast.success(newState ? 'Block mode enabled' : 'Block mode disabled');
            } catch (err) {
                Toast.error('Failed to update setting');
                e.target.checked = !newState;
            }
        });
        toggle.appendChild(checkbox);

        const slider = document.createElement('span');
        slider.className = 'toggle-slider';
        toggle.appendChild(slider);

        row.appendChild(toggle);
        container.appendChild(row);

        // Warning note
        const note = document.createElement('div');
        note.style.cssText = 'background: rgba(239, 68, 68, 0.1); border: 1px solid var(--danger); border-radius: 8px; padding: 12px 16px; margin-top: 12px; font-size: 13px; color: var(--danger);';
        note.textContent = 'When enabled, input threats are blocked from agents and output threats are blocked from users.';
        container.appendChild(note);
    },

    renderOutputScan(container) {
        const row = document.createElement('div');
        row.className = 'settings-row';
        row.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 16px 0;';

        const info = document.createElement('div');

        const label = document.createElement('div');
        label.style.cssText = 'font-weight: 600; font-size: 15px; margin-bottom: 4px;';
        label.textContent = 'Enable Output Scanning';
        info.appendChild(label);

        const desc = document.createElement('div');
        desc.style.cssText = 'color: var(--text-secondary); font-size: 13px;';
        desc.textContent = 'Scan LLM responses for sensitive data';
        info.appendChild(desc);

        row.appendChild(info);

        // Toggle
        const toggle = document.createElement('label');
        toggle.className = 'toggle';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = this.settings.scan_llm_responses;
        checkbox.addEventListener('change', async (e) => {
            const newState = e.target.checked;
            const message = newState
                ? 'Enable Output Scanning?\n\nLLM responses will be scanned for:\n• Credential leakage\n• System prompt exposure\n• PII disclosure'
                : 'Disable Output Scanning?\n\nLLM responses will not be monitored for data leakage.';

            if (!confirm(message)) {
                e.target.checked = !newState;
                return;
            }

            try {
                await API.updateSettings({ scan_llm_responses: newState });
                Toast.success(newState ? 'Output scan enabled' : 'Output scan disabled');
            } catch (err) {
                Toast.error('Failed to update setting');
                e.target.checked = !newState;
            }
        });
        toggle.appendChild(checkbox);

        const slider = document.createElement('span');
        slider.className = 'toggle-slider';
        toggle.appendChild(slider);

        row.appendChild(toggle);
        container.appendChild(row);

        // Info note
        const note = document.createElement('div');
        note.style.cssText = 'background: linear-gradient(135deg, rgba(0, 188, 212, 0.1), rgba(244, 67, 54, 0.1)); border: 1px solid var(--accent-primary); border-radius: 8px; padding: 12px 16px; margin-top: 12px; font-size: 13px;';
        note.textContent = 'Detects credential leakage, system prompt exposure, PII disclosure, and encoded data in AI responses.';
        container.appendChild(note);
    },

    createSection(title, subtitle, highlight = false) {
        const section = document.createElement('div');
        section.className = 'settings-section';
        section.style.cssText = 'margin-bottom: 32px;';

        const header = document.createElement('div');
        header.style.cssText = 'margin-bottom: 16px;';

        const titleEl = document.createElement('h2');
        if (highlight) {
            titleEl.style.cssText = 'font-size: 18px; font-weight: 600; margin-bottom: 4px; color: var(--accent-primary); animation: pulse-glow 2s ease-in-out infinite;';
            // Add keyframe animation via style tag if not already present
            if (!document.getElementById('pulse-glow-style')) {
                const style = document.createElement('style');
                style.id = 'pulse-glow-style';
                style.textContent = '@keyframes pulse-glow { 0%, 100% { text-shadow: 0 0 5px var(--accent-primary); } 50% { text-shadow: 0 0 20px var(--accent-primary), 0 0 30px var(--accent-primary); } }';
                document.head.appendChild(style);
            }
        } else {
            titleEl.style.cssText = 'font-size: 18px; font-weight: 600; margin-bottom: 4px;';
        }
        titleEl.textContent = title;
        header.appendChild(titleEl);

        if (subtitle) {
            const subtitleEl = document.createElement('p');
            subtitleEl.style.cssText = 'color: var(--text-secondary); font-size: 14px; margin: 0;';
            subtitleEl.textContent = subtitle;
            header.appendChild(subtitleEl);
        }

        section.appendChild(header);
        return section;
    },

    createCard() {
        const card = document.createElement('div');
        card.className = 'card';
        card.style.cssText = 'background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 12px; overflow: hidden;';

        const body = document.createElement('div');
        body.className = 'card-body';
        body.style.cssText = 'padding: 20px;';
        card.appendChild(body);

        return card;
    },
};

window.ProxyPage = ProxyPage;
