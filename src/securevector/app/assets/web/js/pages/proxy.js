/**
 * Proxy Page
 * Proxy control and settings for Block Mode and Output Scan
 */

const ProxyPage = {
    settings: null,
    proxyStatus: 'stopped', // 'stopped', 'starting', 'running', 'stopping'
    statusCheckInterval: null,
    currentIntegration: null, // Which integration started the proxy
    currentProvider: null,
    pageIntegration: null, // Which integration page we're on (set by page routing)

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
                this.openclawMode = data.openclaw || false;
                this.inProcessMode = data.in_process || false;
                this.currentIntegration = data.integration || null;
                this.currentProvider = data.provider || null;
            }
        } catch (e) {
            this.proxyStatus = 'stopped';
            this.openclawMode = false;
            this.inProcessMode = false;
            this.currentIntegration = null;
            this.currentProvider = null;
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

        // Main card
        const mainCard = document.createElement('div');
        mainCard.style.cssText = 'background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 8px; padding: 20px;';

        // Title
        const title = document.createElement('div');
        title.style.cssText = 'font-weight: 600; font-size: 16px; color: var(--text-primary); margin-bottom: 16px;';
        title.textContent = 'Agent Proxy';
        mainCard.appendChild(title);

        // Provider dropdown at top
        const providerRow = document.createElement('div');
        providerRow.style.cssText = 'display: flex; align-items: center; gap: 12px; margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--border-default);';

        const providerLabel = document.createElement('span');
        providerLabel.style.cssText = 'font-weight: 500; font-size: 13px; color: var(--text-secondary);';
        providerLabel.textContent = 'Select your LLM provider:';
        providerRow.appendChild(providerLabel);

        const providerSelect = document.createElement('select');
        providerSelect.id = 'proxy-provider-select';
        providerSelect.style.cssText = 'padding: 8px 16px; border-radius: 6px; border: 2px solid var(--accent-primary); background: var(--bg-tertiary); color: var(--text-primary); font-size: 13px; cursor: pointer; font-weight: 600; flex: 1; max-width: 200px;';

        Object.entries(this.providerConfigs).forEach(([value, config]) => {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = config.label;
            providerSelect.appendChild(opt);
        });

        providerSelect.addEventListener('change', () => this.updateInstructions());
        providerRow.appendChild(providerSelect);
        mainCard.appendChild(providerRow);

        // Instructions box (dynamic based on provider)
        const instructionsBox = document.createElement('div');
        instructionsBox.id = 'proxy-instructions-box';
        instructionsBox.style.cssText = 'background: var(--bg-tertiary); border-radius: 6px; padding: 16px; margin-bottom: 16px;';
        mainCard.appendChild(instructionsBox);

        // Why proxy section
        const whySection = document.createElement('div');
        whySection.style.cssText = 'background: var(--bg-secondary); border-radius: 6px; padding: 14px; border-left: 3px solid var(--accent-primary);';

        const whyTitle = document.createElement('div');
        whyTitle.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--accent-primary); margin-bottom: 8px;';
        whyTitle.textContent = 'Why use a proxy?';
        whySection.appendChild(whyTitle);

        const whyList = document.createElement('div');
        whyList.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.6;';
        whyList.innerHTML = `
            <div style="margin-bottom: 4px;">✓ <strong>Captures ALL traffic</strong> - TUI, Telegram, API, MCP tools</div>
            <div style="margin-bottom: 4px;">✓ <strong>Scans BEFORE provider</strong> - Block threats before they reach the LLM</div>
            <div style="margin-bottom: 4px;">✓ <strong>Output scanning</strong> - Detect data leaks in LLM responses</div>
            <div style="margin-bottom: 4px;">✓ <strong>18+ providers</strong> - OpenAI, Anthropic, Ollama, Groq, and more</div>
            <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border-default); font-size: 11px;">
                <strong>Latency:</strong> ~50ms (rule-based) · 2-3s with AI analysis (depends on LLM provider)
            </div>
        `;
        whySection.appendChild(whyList);

        mainCard.appendChild(whySection);
        container.appendChild(mainCard);

        // Settings row - Block Mode and Output Scan side by side
        const settingsRow = document.createElement('div');
        settingsRow.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 16px;';

        // Block Mode Card
        const blockCard = document.createElement('div');
        blockCard.style.cssText = 'background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 8px; padding: 14px;';
        this.renderBlockMode(blockCard);
        settingsRow.appendChild(blockCard);

        // Output Scan Card
        const outputCard = document.createElement('div');
        outputCard.style.cssText = 'background: var(--bg-card); border: 1px solid var(--accent-primary); border-radius: 8px; padding: 14px;';
        this.renderOutputScan(outputCard);
        settingsRow.appendChild(outputCard);

        container.appendChild(settingsRow);

        // Uninstall / Revert Proxy box (dynamic, updates with provider)
        const revertCard = document.createElement('div');
        revertCard.id = 'proxy-revert-box';
        revertCard.style.cssText = 'background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 8px; padding: 16px; margin-top: 16px;';
        container.appendChild(revertCard);

        // Render instructions now that all DOM elements exist
        this.updateInstructions();
    },

    // Provider configurations (all OpenClaw-supported providers)
    // envVar: the env var pi-ai's SDK checks (OPENAI_BASE_URL for all OpenAI-compatible, ANTHROPIC_BASE_URL for Anthropic)
    // basePath: the path suffix the SDK appends to differentiate API versions
    providerConfigs: {
        openai: { envVar: 'OPENAI_BASE_URL', basePath: '/v1', label: 'OpenAI' },
        anthropic: { envVar: 'ANTHROPIC_BASE_URL', basePath: '', label: 'Anthropic' },
        ollama: { envVar: 'OPENAI_BASE_URL', basePath: '/v1', label: 'Ollama' },
        groq: { envVar: 'OPENAI_BASE_URL', basePath: '/v1', label: 'Groq' },
        openrouter: { envVar: 'OPENAI_BASE_URL', basePath: '/v1', label: 'OpenRouter' },
        cerebras: { envVar: 'OPENAI_BASE_URL', basePath: '/v1', label: 'Cerebras' },
        mistral: { envVar: 'OPENAI_BASE_URL', basePath: '/v1', label: 'Mistral' },
        xai: { envVar: 'OPENAI_BASE_URL', basePath: '/v1', label: 'xAI' },
        gemini: { envVar: 'GOOGLE_GENAI_BASE_URL', basePath: '/v1beta', label: 'Gemini' },
        azure: { envVar: 'OPENAI_BASE_URL', basePath: '', label: 'Azure' },
        lmstudio: { envVar: 'OPENAI_BASE_URL', basePath: '/v1', label: 'LM Studio' },
        litellm: { envVar: 'OPENAI_BASE_URL', basePath: '/v1', label: 'LiteLLM' },
        moonshot: { envVar: 'OPENAI_BASE_URL', basePath: '/v1', label: 'Moonshot' },
        minimax: { envVar: 'OPENAI_BASE_URL', basePath: '/v1', label: 'MiniMax' },
        deepseek: { envVar: 'OPENAI_BASE_URL', basePath: '/v1', label: 'DeepSeek' },
        together: { envVar: 'OPENAI_BASE_URL', basePath: '/v1', label: 'Together' },
        fireworks: { envVar: 'OPENAI_BASE_URL', basePath: '/v1', label: 'Fireworks' },
        perplexity: { envVar: 'OPENAI_BASE_URL', basePath: '/v1', label: 'Perplexity' },
        cohere: { envVar: 'OPENAI_BASE_URL', basePath: '/v1', label: 'Cohere' },
    },

    renderProxyControl(container) {
        // Title row with provider dropdown
        const titleRow = document.createElement('div');
        titleRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;';

        const title = document.createElement('div');
        title.style.cssText = 'font-weight: 600; font-size: 15px; color: var(--text-primary);';
        title.textContent = 'Agent Proxy';
        titleRow.appendChild(title);

        // Provider dropdown
        const providerGroup = document.createElement('div');
        providerGroup.style.cssText = 'display: flex; align-items: center; gap: 8px;';

        const providerLabel = document.createElement('span');
        providerLabel.style.cssText = 'font-weight: 500; font-size: 13px; color: var(--text-secondary);';
        providerLabel.textContent = 'Provider:';
        providerGroup.appendChild(providerLabel);

        const providerSelect = document.createElement('select');
        providerSelect.id = 'proxy-provider-select';
        providerSelect.style.cssText = 'padding: 6px 12px; border-radius: 4px; border: 1px solid var(--border-default); background: var(--bg-secondary); color: var(--text-primary); font-size: 13px; cursor: pointer; font-weight: 500;';

        Object.entries(this.providerConfigs).forEach(([value, config]) => {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = config.label;
            providerSelect.appendChild(opt);
        });

        providerSelect.addEventListener('change', () => this.updateInstructions());
        providerGroup.appendChild(providerSelect);
        titleRow.appendChild(providerGroup);

        container.appendChild(titleRow);

        // Instructions box (dynamic based on provider)
        const instructionsBox = document.createElement('div');
        instructionsBox.id = 'proxy-instructions-box';
        instructionsBox.style.cssText = 'background: var(--bg-tertiary); border-radius: 6px; padding: 12px; margin-bottom: 12px;';
        container.appendChild(instructionsBox);

        // Render initial instructions
        this.updateInstructions();

        // Control row - status + button
        const controlRow = document.createElement('div');
        controlRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding-top: 12px; border-top: 1px solid var(--border-default);';

        // Status info
        const statusInfo = document.createElement('div');
        statusInfo.style.cssText = 'display: flex; align-items: center; gap: 6px;';

        const statusLabel = document.createElement('span');
        statusLabel.style.cssText = 'font-weight: 500; font-size: 13px; color: var(--text-secondary);';
        statusLabel.textContent = 'Status:';
        statusInfo.appendChild(statusLabel);

        const statusDesc = document.createElement('span');
        statusDesc.id = 'proxy-status-text';
        statusDesc.style.cssText = 'font-size: 13px; display: flex; align-items: center; gap: 6px;';
        this.updateStatusText(statusDesc);
        statusInfo.appendChild(statusDesc);

        controlRow.appendChild(statusInfo);

        // Start/Stop button
        const actionBtn = document.createElement('button');
        actionBtn.id = 'proxy-action-btn';
        actionBtn.style.cssText = 'padding: 8px 24px; border-radius: 6px; font-weight: 600; font-size: 13px; cursor: pointer; transition: all 0.2s;';
        this.updateActionButton(actionBtn);
        actionBtn.addEventListener('click', () => this.toggleProxy());
        controlRow.appendChild(actionBtn);

        container.appendChild(controlRow);
    },

    updateInstructions() {
        const box = document.getElementById('proxy-instructions-box');
        const select = document.getElementById('proxy-provider-select');
        if (!box || !select) return;

        const provider = select.value;
        const config = this.providerConfigs[provider];

        box.innerHTML = '';

        // Step 1 - Start SecureVector + LLM Proxy (combined)
        const step1 = document.createElement('div');
        step1.style.cssText = 'margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--border-default);';

        const step1Label = document.createElement('div');
        step1Label.style.cssText = 'font-weight: 600; font-size: 12px; color: var(--accent-primary); margin-bottom: 6px;';
        step1Label.textContent = `Step 1: Start SecureVector + LLM Proxy (${config.label})`;
        step1.appendChild(step1Label);

        const step1Code = document.createElement('code');
        step1Code.style.cssText = 'display: block; background: var(--bg-secondary); padding: 10px 12px; border-radius: 4px; font-size: 12px; font-family: monospace; margin-bottom: 8px;';
        step1Code.textContent = `securevector-app --proxy --provider ${provider} --web`;
        step1.appendChild(step1Code);

        const step1Desc = document.createElement('div');
        step1Desc.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 8px; line-height: 1.6;';
        step1Desc.innerHTML = `
            Starts the dashboard (port 8741) and LLM proxy (port 8742). All traffic is scanned for threats.<br>
            <strong>OpenClaw users:</strong> Add <code style="background: var(--bg-secondary); padding: 2px 4px; border-radius: 3px;">--openclaw</code> flag to auto-patch pi-ai.
        `;
        step1.appendChild(step1Desc);

        // Start/Stop button + status inline
        const step1Controls = document.createElement('div');
        step1Controls.style.cssText = 'display: flex; align-items: center; gap: 12px;';

        const actionBtn = document.createElement('button');
        actionBtn.id = 'proxy-action-btn';
        actionBtn.style.cssText = 'padding: 6px 20px; border-radius: 6px; font-weight: 600; font-size: 12px; cursor: pointer; transition: all 0.2s;';
        this.updateActionButton(actionBtn);
        actionBtn.addEventListener('click', () => this.toggleProxy());
        step1Controls.appendChild(actionBtn);

        const statusInfo = document.createElement('div');
        statusInfo.style.cssText = 'display: flex; align-items: center; gap: 6px;';

        const statusDesc = document.createElement('span');
        statusDesc.id = 'proxy-status-text';
        statusDesc.style.cssText = 'font-size: 12px; display: flex; align-items: center; gap: 4px;';
        this.updateStatusText(statusDesc);
        statusInfo.appendChild(statusDesc);

        step1Controls.appendChild(statusInfo);
        step1.appendChild(step1Controls);

        box.appendChild(step1);

        // Step 2 - Start your app through the proxy
        const step2 = document.createElement('div');

        const step2Label = document.createElement('div');
        step2Label.style.cssText = 'font-weight: 600; font-size: 12px; color: var(--accent-primary); margin-bottom: 6px;';
        step2Label.textContent = 'Step 2: Point your app to the proxy';
        step2.appendChild(step2Label);

        const step2Code = document.createElement('code');
        step2Code.style.cssText = 'display: block; background: var(--bg-secondary); padding: 10px 12px; border-radius: 4px; font-size: 12px; font-family: monospace;';
        step2Code.textContent = `${config.envVar}=http://localhost:8742${config.basePath} your-app`;
        step2.appendChild(step2Code);

        const step2Note = document.createElement('div');
        step2Note.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-top: 6px; line-height: 1.6;';
        step2Note.innerHTML = `Works with LangChain, CrewAI, custom Python apps, or any OpenAI-compatible client.`;
        step2.appendChild(step2Note);

        box.appendChild(step2);

        // Update revert box
        this.updateRevertBox();
    },

    updateRevertBox() {
        const revertCard = document.getElementById('proxy-revert-box');
        if (!revertCard) return;

        revertCard.innerHTML = '';

        const revertTitle = document.createElement('div');
        revertTitle.style.cssText = 'font-weight: 600; font-size: 14px; color: var(--text-primary); margin-bottom: 10px;';
        revertTitle.textContent = 'Remove SecureVector Proxy';
        revertCard.appendChild(revertTitle);

        const revertDesc = document.createElement('div');
        revertDesc.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.6; margin-bottom: 12px;';
        revertDesc.innerHTML = '<strong>Optional but recommended</strong> - removes SecureVector traces from pi-ai files.<br>A simple restart of <code style="background: var(--bg-secondary); padding: 2px 4px; border-radius: 3px;">openclaw gateway</code> without OPENAI_BASE_URL will also work.';
        revertCard.appendChild(revertDesc);

        // Revert button
        const revertBtn = document.createElement('button');
        revertBtn.className = 'btn btn-danger';
        revertBtn.style.cssText = 'margin-bottom: 12px;';
        revertBtn.textContent = 'Remove SecureVector Proxy';
        revertBtn.addEventListener('click', () => this.revertProxy());
        revertCard.appendChild(revertBtn);

        // Or use CLI
        const cliNote = document.createElement('div');
        cliNote.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 12px;';
        cliNote.textContent = 'Or run from terminal:';
        revertCard.appendChild(cliNote);

        const revertCode = document.createElement('code');
        revertCode.style.cssText = 'display: block; background: var(--bg-secondary); padding: 10px 12px; border-radius: 4px; font-size: 12px; font-family: monospace; margin-bottom: 12px;';
        revertCode.textContent = 'securevector-app --revert-proxy';
        revertCard.appendChild(revertCode);

        const revertDetails = document.createElement('div');
        revertDetails.style.cssText = 'font-size: 11px; color: var(--text-secondary); line-height: 1.6;';
        revertDetails.innerHTML = 'After removing, restart OpenClaw: <code style="background: var(--bg-secondary); padding: 2px 4px; border-radius: 3px;">openclaw gateway</code>';
        revertCard.appendChild(revertDetails);
    },

    async revertProxy() {
        if (!confirm('Remove SecureVector Proxy?\n\nThis will restore OpenClaw to its original state.\nAPI keys and environment variables will not be modified.')) {
            return;
        }

        try {
            const response = await fetch('/api/proxy/revert', { method: 'POST' });
            const data = await response.json();

            if (data.status === 'success') {
                Toast.success('SecureVector proxy removed successfully');
                this.showRestartInstructions();
            } else {
                Toast.error(data.message || 'Failed to remove proxy');
            }
        } catch (e) {
            Toast.error('Failed to remove proxy: ' + e.message);
        }
    },

    showRestartInstructions() {
        // Show modal with restart instructions
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 1000; display: flex; align-items: center; justify-content: center;';

        const modal = document.createElement('div');
        modal.style.cssText = 'background: var(--bg-card); border-radius: 12px; padding: 24px; max-width: 480px; width: 90%; box-shadow: 0 4px 20px rgba(0,0,0,0.3);';

        const title = document.createElement('div');
        title.style.cssText = 'font-weight: 600; font-size: 16px; color: var(--success); margin-bottom: 16px; display: flex; align-items: center; gap: 8px;';
        title.innerHTML = '✓ SecureVector Proxy Removed';
        modal.appendChild(title);

        const desc = document.createElement('div');
        desc.style.cssText = 'font-size: 13px; color: var(--text-secondary); margin-bottom: 16px; line-height: 1.6;';
        desc.textContent = 'To use OpenClaw without SecureVector, simply restart without the OPENAI_BASE_URL:';
        modal.appendChild(desc);

        // Step 1
        const step1 = document.createElement('div');
        step1.style.cssText = 'margin-bottom: 12px;';
        const step1Label = document.createElement('div');
        step1Label.style.cssText = 'font-weight: 600; font-size: 12px; color: var(--accent-primary); margin-bottom: 4px;';
        step1Label.textContent = 'Step 1: Stop OpenClaw (if running)';
        step1.appendChild(step1Label);
        const step1Code = document.createElement('code');
        step1Code.style.cssText = 'display: block; background: var(--bg-secondary); padding: 10px 12px; border-radius: 4px; font-size: 12px; font-family: monospace;';
        step1Code.textContent = 'Ctrl+C in the OpenClaw terminal';
        step1.appendChild(step1Code);
        modal.appendChild(step1);

        // Step 2
        const step2 = document.createElement('div');
        step2.style.cssText = 'margin-bottom: 16px;';
        const step2Label = document.createElement('div');
        step2Label.style.cssText = 'font-weight: 600; font-size: 12px; color: var(--accent-primary); margin-bottom: 4px;';
        step2Label.textContent = 'Step 2: Restart OpenClaw without proxy';
        step2.appendChild(step2Label);
        const step2Code = document.createElement('code');
        step2Code.style.cssText = 'display: block; background: var(--bg-secondary); padding: 10px 12px; border-radius: 4px; font-size: 12px; font-family: monospace;';
        step2Code.textContent = 'openclaw gateway';
        step2.appendChild(step2Code);
        modal.appendChild(step2);

        const note = document.createElement('div');
        note.style.cssText = 'font-size: 11px; color: var(--text-secondary); padding: 10px; background: var(--bg-tertiary); border-radius: 6px; margin-bottom: 16px; line-height: 1.5;';
        note.innerHTML = 'Without OPENAI_BASE_URL set, OpenClaw connects directly to your LLM provider.<br><br><strong>Optional:</strong> Run <code style="background: var(--bg-secondary); padding: 2px 4px; border-radius: 3px;">securevector-app --revert-proxy</code> to fully remove SecureVector traces from pi-ai files.';
        modal.appendChild(note);

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.style.cssText = 'width: 100%; padding: 10px; border-radius: 6px; background: var(--accent-primary); color: white; font-weight: 600; font-size: 13px; border: none; cursor: pointer;';
        closeBtn.textContent = 'Got it';
        closeBtn.addEventListener('click', () => overlay.remove());
        modal.appendChild(closeBtn);

        overlay.appendChild(modal);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });
        document.body.appendChild(overlay);
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
            // If running in-process with openclaw, show different state
            if (this.inProcessMode && this.openclawMode) {
                btn.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
                btn.style.color = 'white';
                btn.style.border = 'none';
                btn.textContent = '🦎 OpenClaw Proxy ON';
                btn.disabled = true;
                btn.title = 'Stop the app with Ctrl+C to stop this proxy';
            } else if (this.inProcessMode) {
                btn.style.background = 'var(--bg-tertiary)';
                btn.style.color = 'var(--text-secondary)';
                btn.style.border = '1px solid var(--border-default)';
                btn.textContent = '🟢 Running (CLI)';
                btn.disabled = true;
                btn.title = 'Stop the app with Ctrl+C to stop this proxy';
            } else {
                btn.style.background = 'var(--danger)';
                btn.style.color = 'white';
                btn.style.border = 'none';
                btn.textContent = '⏹ Stop Proxy';
                btn.disabled = false;
                btn.title = '';
            }
        } else if (this.proxyStatus === 'stopped') {
            btn.style.background = 'var(--success)';
            btn.style.color = 'white';
            btn.style.border = 'none';
            btn.textContent = '▶ Start Proxy';
            btn.disabled = false;
            btn.title = '';
        } else if (this.proxyStatus === 'running' && this.currentIntegration && this.currentIntegration !== this.pageIntegration) {
            // Another integration is using the proxy
            const integrationName = this.currentIntegration.charAt(0).toUpperCase() + this.currentIntegration.slice(1);
            btn.style.background = 'var(--bg-tertiary)';
            btn.style.color = 'var(--text-secondary)';
            btn.style.border = '1px solid var(--border-default)';
            btn.textContent = `🔒 ${integrationName} Proxy Active`;
            btn.disabled = true;
            btn.title = `Stop the ${integrationName} proxy first to use this integration`;
        } else {
            btn.style.background = 'var(--bg-tertiary)';
            btn.style.color = 'var(--text-secondary)';
            btn.style.border = '1px solid var(--border-default)';
            btn.textContent = '⏳ ' + (this.proxyStatus === 'starting' ? 'Starting...' : 'Stopping...');
            btn.disabled = true;
            btn.title = '';
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
                const wasOpenclawMode = this.openclawMode;
                const response = await fetch('/api/proxy/stop', { method: 'POST' });
                const data = await response.json();
                if (response.ok && data.status === 'stopped') {
                    this.proxyStatus = 'stopped';
                    this.openclawMode = false;
                    Toast.success('Proxy stopped');
                    // Show restart instructions if was running with OpenClaw
                    if (wasOpenclawMode || data.reverted) {
                        this.showRestartInstructions();
                    }
                } else if (data.status === 'error') {
                    // Proxy running in-process or externally - can't stop from UI
                    Toast.error(data.message || 'Cannot stop proxy from UI');
                    this.proxyStatus = 'running';
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
                const provider = document.getElementById('proxy-provider-select')?.value || 'openai';
                const integration = this.pageIntegration || null;
                const response = await fetch('/api/proxy/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ provider, integration }),
                });
                if (response.ok) {
                    const data = await response.json();
                    this.proxyStatus = 'running';
                    this.currentIntegration = data.integration;
                    Toast.success(`Proxy started (${provider}) on port 8742`);
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
        row.style.cssText = 'display: flex; justify-content: space-between; align-items: center;';

        const info = document.createElement('div');

        const label = document.createElement('div');
        label.style.cssText = 'font-weight: 600; font-size: 13px; margin-bottom: 2px;';
        label.textContent = 'Block Mode';
        info.appendChild(label);

        const desc = document.createElement('div');
        desc.style.cssText = 'color: var(--text-secondary); font-size: 11px;';
        desc.textContent = 'Block threats on input and output';
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
                ? 'Enable Block Mode?\n\nINPUT: Threats will be BLOCKED before reaching the LLM.\nOUTPUT: Threats will be BLOCKED before reaching the client.\n\nAll threats are logged.'
                : 'Disable Block Mode?\n\nAll threats will be logged only.\nNo blocking will occur.';

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
    },

    renderOutputScan(container) {
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; justify-content: space-between; align-items: center;';

        const info = document.createElement('div');

        const label = document.createElement('div');
        label.style.cssText = 'font-weight: 600; font-size: 13px; margin-bottom: 2px;';
        label.textContent = 'Output Scan';
        info.appendChild(label);

        const desc = document.createElement('div');
        desc.style.cssText = 'color: var(--text-secondary); font-size: 11px;';
        desc.textContent = 'Scan LLM responses for leaks';
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
