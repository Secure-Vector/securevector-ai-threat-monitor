/**
 * Header Component
 * Displays AI Analysis, Cloud Connect, and status
 */

const Header = {
    serverStatus: 'checking',
    dropdownOpen: false,
    cloudModeEnabled: false,

    // Agent integration instructions
    agents: [
        { id: 'n8n', name: 'n8n' },
        { id: 'dify', name: 'Dify' },
        { id: 'crewai', name: 'CrewAI' },
        { id: 'claude-desktop', name: 'Claude Desktop' },
        { id: 'openclaw', name: 'OpenClaw' },
        { id: 'langchain', name: 'LangChain' },
        { id: 'langgraph', name: 'LangGraph' },
    ],

    render() {
        const container = document.getElementById('header');
        if (!container) return;

        container.textContent = '';

        // Mobile hamburger menu button (hidden on desktop via CSS)
        const mobileMenuBtn = document.createElement('button');
        mobileMenuBtn.className = 'mobile-menu-btn';
        mobileMenuBtn.id = 'mobile-menu-btn';
        mobileMenuBtn.setAttribute('aria-label', 'Toggle navigation menu');
        for (let i = 0; i < 3; i++) {
            const line = document.createElement('span');
            line.className = 'hamburger-line';
            mobileMenuBtn.appendChild(line);
        }
        mobileMenuBtn.addEventListener('click', () => this.toggleMobileMenu());
        container.appendChild(mobileMenuBtn);

        // Left side — page title + subtitle stacked vertically
        const left = document.createElement('div');
        left.className = 'header-left';

        const titleGroup = document.createElement('div');
        titleGroup.style.cssText = 'display: flex; flex-direction: column; justify-content: center;';

        const headerTitleEl = document.createElement('div');
        headerTitleEl.id = 'header-page-title';
        headerTitleEl.style.cssText = 'font-size: 21px; font-weight: 700; color: var(--text-primary); line-height: 1.2; white-space: nowrap;';
        titleGroup.appendChild(headerTitleEl);

        const headerSubtitleEl = document.createElement('div');
        headerSubtitleEl.id = 'header-page-subtitle';
        headerSubtitleEl.style.cssText = 'font-size: 13px; color: var(--text-secondary); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 620px;';
        titleGroup.appendChild(headerSubtitleEl);

        left.appendChild(titleGroup);
        container.appendChild(left);

        // Right side - Help, AI Analysis, agent dropdown, cloud mode (rightmost)
        const right = document.createElement('div');
        right.className = 'header-right';

        // Theme toggle button (sun/moon)
        const themeBtn = this.createThemeToggle();
        right.appendChild(themeBtn);

        // Help button (question mark)
        const helpBtn = this.createHelpButton();
        right.appendChild(helpBtn);

        // AI Analysis button (opens modal)
        const llmToggle = this.createLLMToggle();
        right.appendChild(llmToggle);

        // Cloud Mode toggle - rightmost
        const cloudToggle = this.createCloudToggle();
        right.appendChild(cloudToggle);

        container.appendChild(right);

        // Check cloud mode and LLM mode
        this.checkCloudMode();
        this.checkLLMMode();
    },

    toggleMobileMenu() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('mobile-overlay');
        const btn = document.getElementById('mobile-menu-btn');

        if (!sidebar) return;

        const isOpen = sidebar.classList.contains('mobile-open');

        if (isOpen) {
            sidebar.classList.remove('mobile-open');
            if (overlay) overlay.classList.remove('active');
            if (btn) btn.classList.remove('active');
            document.body.classList.remove('mobile-menu-open');
        } else {
            sidebar.classList.add('mobile-open');
            // Create overlay if it doesn't exist
            let overlayEl = overlay;
            if (!overlayEl) {
                overlayEl = document.createElement('div');
                overlayEl.id = 'mobile-overlay';
                overlayEl.className = 'mobile-overlay';
                overlayEl.addEventListener('click', () => this.toggleMobileMenu());
                document.body.appendChild(overlayEl);
            }
            overlayEl.classList.add('active');
            if (btn) btn.classList.add('active');
            document.body.classList.add('mobile-menu-open');
        }
    },

    createThemeToggle() {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        const btn = document.createElement('button');
        btn.style.cssText = 'background: transparent; border: 2px solid var(--text-secondary); color: var(--text-secondary); width: 28px; height: 28px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s; margin-right: 8px; padding: 0;';
        btn.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
        btn.setAttribute('aria-label', 'Toggle theme');

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.style.cssText = 'width: 14px; height: 14px;';

        if (isDark) {
            // Sun icon
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', '12');
            circle.setAttribute('cy', '12');
            circle.setAttribute('r', '5');
            svg.appendChild(circle);
            ['M12 1v2', 'M12 21v2', 'M4.22 4.22l1.42 1.42', 'M18.36 18.36l1.42 1.42', 'M1 12h2', 'M21 12h2', 'M4.22 19.78l1.42-1.42', 'M18.36 5.64l1.42-1.42'].forEach(d => {
                const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                p.setAttribute('d', d);
                svg.appendChild(p);
            });
        } else {
            // Moon icon
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z');
            svg.appendChild(path);
        }

        btn.appendChild(svg);

        btn.addEventListener('mouseenter', () => {
            btn.style.borderColor = 'var(--accent-primary)';
            btn.style.color = 'var(--accent-primary)';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.borderColor = 'var(--text-secondary)';
            btn.style.color = 'var(--text-secondary)';
        });

        btn.addEventListener('click', () => {
            if (window.Sidebar) Sidebar.toggleTheme();
        });

        return btn;
    },

    createHelpButton() {
        const btn = document.createElement('button');
        btn.className = 'help-btn';
        btn.style.cssText = 'background: transparent; border: 2px solid var(--text-secondary); color: var(--text-secondary); width: 28px; height: 28px; border-radius: 50%; font-size: 14px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.2s; margin-right: 12px;';
        btn.textContent = '?';
        btn.title = 'How to use SecureVector';

        btn.addEventListener('mouseenter', () => {
            btn.style.borderColor = 'var(--accent-primary)';
            btn.style.color = 'var(--accent-primary)';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.borderColor = 'var(--text-secondary)';
            btn.style.color = 'var(--text-secondary)';
        });

        btn.addEventListener('click', () => this.showHelpModal());
        return btn;
    },

    showHelpModal() {
        const content = document.createElement('div');
        content.style.cssText = 'padding: 8px 0;';

        const stepsList = document.createElement('div');
        stepsList.className = 'cloud-steps';

        // Step 1 — Proxy already running
        const step1El = document.createElement('div');
        step1El.className = 'cloud-step';
        const step1Num = document.createElement('span');
        step1Num.className = 'step-number';
        step1Num.textContent = '1';
        step1El.appendChild(step1Num);
        const step1Text = document.createElement('div');
        step1Text.className = 'step-text';
        const step1Title = document.createElement('div');
        step1Title.style.cssText = 'font-weight: 600; display: flex; align-items: center; gap: 6px;';
        step1Title.appendChild(document.createTextNode('Proxy Already Running'));
        const step1Badge = document.createElement('span');
        step1Badge.style.cssText = 'font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; background: rgba(16,185,129,0.15); color: #10b981; letter-spacing: 0.4px; text-transform: uppercase;';
        step1Badge.textContent = '\u25CF Active';
        step1Title.appendChild(step1Badge);
        step1Text.appendChild(step1Title);
        const step1Desc = document.createElement('p');
        step1Desc.textContent = "Your AI Firewall is live. Point your agent's LLM calls to the proxy by setting one environment variable:";
        step1Text.appendChild(step1Desc);
        const step1Code = document.createElement('div');
        step1Code.style.cssText = 'font-size: 11px; font-family: monospace; background: var(--bg-tertiary); color: var(--accent-primary); padding: 3px 8px; border-radius: 4px; display: inline-block; margin-top: 2px;';
        step1Code.textContent = `OPENAI_BASE_URL=http://localhost:${window.__SV_PROXY_PORT || 8742}/openai/v1`;
        step1Text.appendChild(step1Code);
        step1El.appendChild(step1Text);
        stepsList.appendChild(step1El);

        // Step 2 — Rules already enabled
        const step2El = document.createElement('div');
        step2El.className = 'cloud-step';
        const step2Num = document.createElement('span');
        step2Num.className = 'step-number';
        step2Num.textContent = '2';
        step2El.appendChild(step2Num);
        const step2Text = document.createElement('div');
        step2Text.className = 'step-text';
        const step2Title = document.createElement('div');
        step2Title.style.cssText = 'font-weight: 600; display: flex; align-items: center; gap: 6px;';
        step2Title.appendChild(document.createTextNode('Threat Detection Rules Enabled'));
        const step2Badge = document.createElement('span');
        step2Badge.style.cssText = 'font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; background: rgba(16,185,129,0.15); color: #10b981; letter-spacing: 0.4px; text-transform: uppercase;';
        step2Badge.textContent = '\u25CF Ready';
        step2Title.appendChild(step2Badge);
        step2Text.appendChild(step2Title);
        const step2Desc = document.createElement('p');
        step2Desc.textContent = 'Prompt injection, jailbreak, data exfiltration, and 300+ other threat patterns are pre-loaded and scanning every request automatically.';
        step2Text.appendChild(step2Desc);
        step2El.appendChild(step2Text);
        stepsList.appendChild(step2El);

        // Step 3 — Tool Permissions & Budgets
        const step3El = document.createElement('div');
        step3El.className = 'cloud-step';
        const step3Num = document.createElement('span');
        step3Num.className = 'step-number';
        step3Num.textContent = '3';
        step3El.appendChild(step3Num);
        const step3Text = document.createElement('div');
        step3Text.className = 'step-text';
        const step3Title = document.createElement('strong');
        step3Title.textContent = 'Configure Tool Permissions & Budgets';
        step3Text.appendChild(step3Title);
        const step3Desc = document.createElement('p');
        const step3b1 = document.createElement('strong'); step3b1.textContent = 'Tool Permissions';
        const step3b2 = document.createElement('strong'); step3b2.textContent = 'Cost Settings';
        step3Desc.appendChild(document.createTextNode('Go to '));
        step3Desc.appendChild(step3b1);
        step3Desc.appendChild(document.createTextNode(' to block risky agent actions, and '));
        step3Desc.appendChild(step3b2);
        step3Desc.appendChild(document.createTextNode(' to set daily spend limits.'));
        step3Text.appendChild(step3Desc);
        step3El.appendChild(step3Text);
        stepsList.appendChild(step3El);

        // Step 4 — Monitor
        const step4El = document.createElement('div');
        step4El.className = 'cloud-step';
        const step4Num = document.createElement('span');
        step4Num.className = 'step-number';
        step4Num.textContent = '4';
        step4El.appendChild(step4Num);
        const step4Text = document.createElement('div');
        step4Text.className = 'step-text';
        const step4Title = document.createElement('strong');
        step4Title.textContent = "Run Your Agent \u2014 Watch It Live";
        step4Text.appendChild(step4Title);
        const step4Desc = document.createElement('p');
        const step4b1 = document.createElement('strong'); step4b1.textContent = 'Monitor';
        step4Desc.appendChild(document.createTextNode('Threats, tool calls, and costs appear in real time in the '));
        step4Desc.appendChild(step4b1);
        step4Desc.appendChild(document.createTextNode(' section as your agent runs.'));
        step4Text.appendChild(step4Desc);
        step4El.appendChild(step4Text);
        stepsList.appendChild(step4El);

        content.appendChild(stepsList);

        // Link to Docs
        const docsLink = document.createElement('div');
        docsLink.style.cssText = 'margin-top: 12px; text-align: center; display: flex; align-items: center; justify-content: center; gap: 16px;';
        const docsBtn = document.createElement('a');
        docsBtn.style.cssText = 'color: var(--accent-primary); cursor: pointer; font-size: 13px; font-weight: 500;';
        docsBtn.textContent = 'View Guide \u2192';
        docsBtn.addEventListener('click', () => {
            Modal.close();
            if (window.Sidebar) Sidebar.navigate('guide');
        });
        docsLink.appendChild(docsBtn);

        const issuesSep = document.createElement('span');
        issuesSep.style.cssText = 'color: var(--text-muted); font-size: 13px;';
        issuesSep.textContent = '·';
        docsLink.appendChild(issuesSep);

        const issuesBtn = document.createElement('a');
        issuesBtn.href = 'https://github.com/Secure-Vector/securevector-ai-threat-monitor/issues';
        issuesBtn.target = '_blank';
        issuesBtn.rel = 'noopener noreferrer';
        issuesBtn.style.cssText = 'color: var(--text-secondary); font-size: 13px; font-weight: 500; text-decoration: none;';
        issuesBtn.textContent = 'Report an Issue';
        docsLink.appendChild(issuesBtn);

        content.appendChild(docsLink);

        Modal.show({
            title: 'Welcome to SecureVector',
            content: content,
            size: 'small',
        });
    },

    createBlockModeToggle() {
        const wrapper = document.createElement('div');
        wrapper.className = 'block-mode-toggle-wrapper';
        wrapper.id = 'block-mode-toggle-wrapper';

        const btn = document.createElement('button');
        btn.className = 'block-mode-toggle-btn';
        btn.id = 'block-mode-toggle-btn';
        btn.title = 'Block Mode - Block threats on both input (before LLM) and output (before client).';

        // Block/Stop icon
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('stroke-width', '2');
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', '12');
        circle.setAttribute('cy', '12');
        circle.setAttribute('r', '10');
        icon.appendChild(circle);
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', '4.93');
        line.setAttribute('y1', '4.93');
        line.setAttribute('x2', '19.07');
        line.setAttribute('y2', '19.07');
        icon.appendChild(line);
        btn.appendChild(icon);

        const text = document.createElement('span');
        text.textContent = 'Block';
        text.id = 'block-mode-toggle-text';
        btn.appendChild(text);

        // Toggle switch
        const toggle = document.createElement('span');
        toggle.className = 'mini-toggle';
        toggle.id = 'block-mode-mini-toggle';
        const toggleKnob = document.createElement('span');
        toggleKnob.className = 'mini-toggle-knob';
        toggle.appendChild(toggleKnob);
        btn.appendChild(toggle);

        btn.addEventListener('click', () => this.toggleBlockMode());

        wrapper.appendChild(btn);
        return wrapper;
    },

    async checkBlockMode() {
        try {
            const settings = await API.getSettings();
            this.updateBlockModeToggle(settings.block_threats);
        } catch (e) {
            this.updateBlockModeToggle(false); // Default to disabled
        }
    },

    updateBlockModeToggle(enabled) {
        const btn = document.getElementById('block-mode-toggle-btn');
        const toggle = document.getElementById('block-mode-mini-toggle');
        if (!btn) return;

        if (enabled) {
            btn.className = 'block-mode-toggle-btn active';
            if (toggle) toggle.className = 'mini-toggle on';
        } else {
            btn.className = 'block-mode-toggle-btn';
            if (toggle) toggle.className = 'mini-toggle';
        }
    },

    async toggleBlockMode() {
        try {
            const settings = await API.getSettings();
            const newState = !settings.block_threats;

            // Show confirmation
            const message = newState
                ? 'Enable Block Mode?\n\nINPUT: Threats will be BLOCKED before reaching the LLM.\nOUTPUT: Threats will be BLOCKED before reaching the client.\n\nAll threats are logged.'
                : 'Disable Block Mode?\n\nAll threats will be logged only.\nNo blocking will occur.';

            if (!confirm(message)) {
                return;
            }

            await API.updateSettings({ block_threats: newState });
            this.updateBlockModeToggle(newState);
            if (newState) {
                Toast.success('Block mode enabled - threats will be blocked');
            } else {
                Toast.info('Block mode disabled - threats will be logged only');
            }
        } catch (error) {
            Toast.error('Failed to toggle block mode');
        }
    },

    createOutputScanToggle() {
        const wrapper = document.createElement('div');
        wrapper.className = 'output-scan-toggle-wrapper';
        wrapper.id = 'output-scan-toggle-wrapper';

        const btn = document.createElement('button');
        btn.className = 'output-scan-toggle-btn';
        btn.id = 'output-scan-toggle-btn';
        btn.title = 'Output Scan (Redact Sensitive Info) - Scan LLM responses for data leakage. Sensitive information is redacted when stored.';

        // Shield icon
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('stroke-width', '2');
        const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path1.setAttribute('d', 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z');
        icon.appendChild(path1);
        btn.appendChild(icon);

        const text = document.createElement('span');
        text.textContent = 'Output';
        text.id = 'output-scan-toggle-text';
        btn.appendChild(text);

        // Toggle switch
        const toggle = document.createElement('span');
        toggle.className = 'mini-toggle';
        toggle.id = 'output-scan-mini-toggle';
        const toggleKnob = document.createElement('span');
        toggleKnob.className = 'mini-toggle-knob';
        toggle.appendChild(toggleKnob);
        btn.appendChild(toggle);

        btn.addEventListener('click', () => this.toggleOutputScanMode());

        wrapper.appendChild(btn);
        return wrapper;
    },

    async checkOutputScanMode() {
        try {
            const settings = await API.getSettings();
            this.updateOutputScanToggle(settings.scan_llm_responses);
        } catch (e) {
            this.updateOutputScanToggle(true); // Default to enabled
        }
    },

    updateOutputScanToggle(enabled) {
        const btn = document.getElementById('output-scan-toggle-btn');
        const toggle = document.getElementById('output-scan-mini-toggle');
        if (!btn) return;

        if (enabled) {
            btn.className = 'output-scan-toggle-btn active';
            if (toggle) toggle.className = 'mini-toggle on';
        } else {
            btn.className = 'output-scan-toggle-btn';
            if (toggle) toggle.className = 'mini-toggle';
        }
    },

    async toggleOutputScanMode() {
        try {
            const settings = await API.getSettings();
            const newState = !settings.scan_llm_responses;

            // Show confirmation
            const action = newState ? 'enable' : 'disable';
            const message = newState
                ? 'Enable output scanning?\n\nLLM responses will be scanned for:\n• Credential leakage\n• System prompt exposure\n• PII disclosure\n\nSecrets are REDACTED when stored. Threats are logged.'
                : 'Disable output scanning?\n\nLLM responses will not be monitored for data leakage.';

            if (!confirm(message)) {
                return;
            }

            await API.updateSettings({ scan_llm_responses: newState });
            this.updateOutputScanToggle(newState);
            if (newState) {
                Toast.success('Output scan enabled');
            } else {
                Toast.info('Output scan disabled');
            }
        } catch (error) {
            Toast.error('Failed to toggle output scan');
        }
    },

    createLLMToggle() {
        const wrapper = document.createElement('div');
        wrapper.className = 'llm-toggle-wrapper';
        wrapper.id = 'llm-toggle-wrapper';

        const btn = document.createElement('button');
        btn.className = 'llm-toggle-btn';
        btn.id = 'llm-toggle-btn';

        // AI/Brain icon
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('stroke-width', '2');
        const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        path1.setAttribute('cx', '12');
        path1.setAttribute('cy', '12');
        path1.setAttribute('r', '3');
        icon.appendChild(path1);
        const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path2.setAttribute('d', 'M12 1v4M12 19v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M1 12h4M19 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83');
        icon.appendChild(path2);
        btn.appendChild(icon);

        const text = document.createElement('span');
        text.textContent = 'AI Analysis';
        text.id = 'llm-toggle-text';
        btn.appendChild(text);

        btn.addEventListener('click', () => {
            if (this.cloudModeEnabled) {
                Toast.info('AI Analysis disabled - Cloud ML analysis is active');
                return;
            }
            this.showLLMConfigModal();
        });

        wrapper.appendChild(btn);
        return wrapper;
    },

    async showLLMConfigModal() {
        // Fetch current settings
        let settings;
        try {
            settings = await API.getLLMSettings();
        } catch (e) {
            settings = { enabled: false, provider: 'ollama', model: 'llama3', endpoint: 'http://localhost:11434' };
        }

        const content = document.createElement('div');
        content.className = 'llm-config-modal';

        // Enable toggle section
        const enableSection = document.createElement('div');
        enableSection.className = 'llm-config-section';

        const enableRow = document.createElement('div');
        enableRow.className = 'llm-config-row main-toggle';

        const enableInfo = document.createElement('div');
        enableInfo.className = 'llm-config-info';

        const enableLabel = document.createElement('div');
        enableLabel.className = 'llm-config-label';
        enableLabel.textContent = 'Enable AI Analysis';
        enableInfo.appendChild(enableLabel);

        const enableDesc = document.createElement('div');
        enableDesc.className = 'llm-config-desc';
        enableDesc.textContent = 'AI-powered threat analysis using your LLM';
        enableInfo.appendChild(enableDesc);

        enableRow.appendChild(enableInfo);

        const enableToggle = document.createElement('label');
        enableToggle.className = 'toggle';

        const enableCheckbox = document.createElement('input');
        enableCheckbox.type = 'checkbox';
        enableCheckbox.id = 'llm-enabled-checkbox';
        enableCheckbox.checked = settings.enabled;
        enableCheckbox.addEventListener('change', (e) => {
            const saveBtn = document.getElementById('llm-save-btn');
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.classList.remove('disabled');
            }
            Toast.info(e.target.checked ? 'AI Analysis enabled - click Save to apply' : 'AI Analysis disabled - click Save to apply');
        });
        enableToggle.appendChild(enableCheckbox);

        const enableSlider = document.createElement('span');
        enableSlider.className = 'toggle-slider';
        enableToggle.appendChild(enableSlider);

        enableRow.appendChild(enableToggle);
        enableSection.appendChild(enableRow);
        content.appendChild(enableSection);

        // Provider selection with cards
        const providerSection = document.createElement('div');
        providerSection.className = 'llm-config-section';

        const providerLabel = document.createElement('div');
        providerLabel.className = 'llm-section-label';
        providerLabel.textContent = 'Select Provider';
        providerSection.appendChild(providerLabel);

        const providerGrid = document.createElement('div');
        providerGrid.className = 'llm-provider-grid';

        const providers = [
            { id: 'ollama', name: 'Ollama', desc: 'Local models', icon: '🦙' },
            { id: 'openai', name: 'OpenAI', desc: 'GPT-4, GPT-4o', icon: '🤖' },
            { id: 'anthropic', name: 'Anthropic', desc: 'Claude 3.5', icon: '🧠' },
            { id: 'azure', name: 'Azure', desc: 'Azure OpenAI', icon: '☁️' },
            { id: 'bedrock', name: 'Bedrock', desc: 'AWS Models', icon: '🪨' },
            { id: 'custom', name: 'Custom', desc: 'OpenAI-compatible', icon: '⚙️' },
        ];

        providers.forEach(p => {
            const card = document.createElement('div');
            card.className = 'llm-provider-card' + (p.id === settings.provider ? ' selected' : '');
            card.dataset.provider = p.id;

            const cardIcon = document.createElement('div');
            cardIcon.className = 'provider-icon';
            cardIcon.textContent = p.icon;
            card.appendChild(cardIcon);

            const cardName = document.createElement('div');
            cardName.className = 'provider-name';
            cardName.textContent = p.name;
            card.appendChild(cardName);

            const cardDesc = document.createElement('div');
            cardDesc.className = 'provider-desc';
            cardDesc.textContent = p.desc;
            card.appendChild(cardDesc);

            card.addEventListener('click', () => {
                providerGrid.querySelectorAll('.llm-provider-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                this.updateLLMConfigFields(p.id);
            });

            providerGrid.appendChild(card);
        });

        providerSection.appendChild(providerGrid);
        content.appendChild(providerSection);

        // Configuration fields section
        const configSection = document.createElement('div');
        configSection.className = 'llm-config-section';
        configSection.id = 'llm-config-fields';

        // Model dropdown (for predefined providers)
        const modelGroup = document.createElement('div');
        modelGroup.className = 'llm-form-group';
        modelGroup.id = 'llm-model-group';

        const modelLabel = document.createElement('label');
        modelLabel.textContent = 'Model';
        modelGroup.appendChild(modelLabel);

        const modelSelect = document.createElement('select');
        modelSelect.id = 'llm-config-model-select';
        modelSelect.className = 'llm-form-select';
        modelGroup.appendChild(modelSelect);

        configSection.appendChild(modelGroup);

        // Custom model input (only for custom provider)
        const customModelGroup = document.createElement('div');
        customModelGroup.className = 'llm-form-group';
        customModelGroup.id = 'llm-custom-model-group';
        customModelGroup.style.display = 'none';

        const customModelLabel = document.createElement('label');
        customModelLabel.textContent = 'Model Name';
        customModelGroup.appendChild(customModelLabel);

        const customModelInput = document.createElement('input');
        customModelInput.type = 'text';
        customModelInput.id = 'llm-config-model-custom';
        customModelInput.className = 'llm-form-input';
        customModelInput.value = settings.model || '';
        customModelInput.placeholder = 'e.g., my-custom-model';
        customModelGroup.appendChild(customModelInput);

        configSection.appendChild(customModelGroup);

        // Endpoint input
        const endpointGroup = document.createElement('div');
        endpointGroup.className = 'llm-form-group';
        endpointGroup.id = 'llm-endpoint-group';

        const endpointLabel = document.createElement('label');
        endpointLabel.textContent = 'Endpoint URL';
        endpointGroup.appendChild(endpointLabel);

        const endpointInput = document.createElement('input');
        endpointInput.type = 'text';
        endpointInput.id = 'llm-config-endpoint';
        endpointInput.className = 'llm-form-input';
        endpointInput.value = settings.endpoint || '';
        endpointInput.placeholder = 'http://localhost:11434';
        endpointGroup.appendChild(endpointInput);

        configSection.appendChild(endpointGroup);

        // API Key input
        const apiKeyGroup = document.createElement('div');
        apiKeyGroup.className = 'llm-form-group';
        apiKeyGroup.id = 'llm-apikey-group';

        const apiKeyLabel = document.createElement('label');
        apiKeyLabel.textContent = 'API Key';
        apiKeyGroup.appendChild(apiKeyLabel);

        const apiKeyInput = document.createElement('input');
        apiKeyInput.type = 'password';
        apiKeyInput.id = 'llm-config-apikey';
        apiKeyInput.className = 'llm-form-input';
        apiKeyInput.placeholder = settings.api_key_configured ? '••••••••' : 'sk-...';
        apiKeyGroup.appendChild(apiKeyInput);

        configSection.appendChild(apiKeyGroup);

        // AWS Region (for Bedrock)
        const regionGroup = document.createElement('div');
        regionGroup.className = 'llm-form-group';
        regionGroup.id = 'llm-region-group';
        regionGroup.style.display = 'none';

        const regionLabel = document.createElement('label');
        regionLabel.textContent = 'AWS Region';
        regionGroup.appendChild(regionLabel);

        const regionSelect = document.createElement('select');
        regionSelect.id = 'llm-config-region';
        regionSelect.className = 'llm-form-select';

        ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-northeast-1'].forEach(r => {
            const opt = document.createElement('option');
            opt.value = r;
            opt.textContent = r;
            if (r === (settings.aws_region || 'us-east-1')) opt.selected = true;
            regionSelect.appendChild(opt);
        });
        regionGroup.appendChild(regionSelect);

        configSection.appendChild(regionGroup);

        content.appendChild(configSection);

        // Show/hide fields based on current provider (don't update values on initial load)
        // Populate model dropdown for initial provider (use true to populate)
        setTimeout(() => {
            this.updateLLMConfigFields(settings.provider, true);
            // Set the currently saved model as selected
            const modelSelect = document.getElementById('llm-config-model-select');
            if (modelSelect && settings.model) {
                modelSelect.value = settings.model;
            }
        }, 0);

        // Actions
        const actions = document.createElement('div');
        actions.className = 'llm-config-actions';

        // Test status indicator
        const testStatus = document.createElement('span');
        testStatus.className = 'llm-test-status';
        testStatus.id = 'llm-test-status';
        actions.appendChild(testStatus);

        const testBtn = document.createElement('button');
        testBtn.className = 'btn btn-secondary';
        testBtn.textContent = 'Test Connection';
        testBtn.addEventListener('click', async () => {
            testBtn.textContent = 'Testing...';
            testBtn.disabled = true;
            testStatus.textContent = '';
            testStatus.className = 'llm-test-status';
            saveBtn.disabled = true;
            saveBtn.classList.add('disabled');

            try {
                await this.saveLLMConfig(false); // Save without closing
                const result = await API.testLLMConnection();
                if (result.success) {
                    testStatus.textContent = '✓ Connected';
                    testStatus.className = 'llm-test-status success';
                    saveBtn.disabled = false;
                    saveBtn.classList.remove('disabled');
                    // Auto-enable LLM when test passes
                    const enableCheckbox = document.getElementById('llm-enabled-checkbox');
                    if (enableCheckbox && !enableCheckbox.checked) {
                        enableCheckbox.checked = true;
                    }
                    Toast.success(result.message);
                } else {
                    testStatus.textContent = '✗ Failed';
                    testStatus.className = 'llm-test-status error';
                    Toast.error(result.message);
                }
            } catch (err) {
                testStatus.textContent = '✗ Error';
                testStatus.className = 'llm-test-status error';
                Toast.error('Test failed: ' + err.message);
            }
            testBtn.textContent = 'Test Connection';
            testBtn.disabled = false;
        });
        actions.appendChild(testBtn);

        const saveBtn = document.createElement('button');
        saveBtn.className = 'btn btn-primary disabled';
        saveBtn.id = 'llm-save-btn';
        saveBtn.textContent = 'Save';
        saveBtn.disabled = true;
        saveBtn.addEventListener('click', async () => {
            try {
                await this.saveLLMConfig(false);
                Modal.close();
                Toast.success('LLM settings saved');
                this.checkLLMMode();
            } catch (err) {
                Toast.error('Failed to save: ' + err.message);
            }
        });
        actions.appendChild(saveBtn);

        // Enable save button if configured (Ollama doesn't need API key)
        const isOllama = settings.provider === 'ollama';
        const isConfigured = isOllama || settings.api_key_configured;
        if (isConfigured) {
            saveBtn.disabled = false;
            saveBtn.classList.remove('disabled');
            testStatus.textContent = '✓ Configured';
            testStatus.className = 'llm-test-status success';
        }

        content.appendChild(actions);

        Modal.show({
            title: 'AI Analysis Configuration',
            content: content,
            size: 'medium',
        });
    },

    updateLLMConfigFields(provider, updateValues = true) {
        const endpointGroup = document.getElementById('llm-endpoint-group');
        const apiKeyGroup = document.getElementById('llm-apikey-group');
        const regionGroup = document.getElementById('llm-region-group');
        const modelGroup = document.getElementById('llm-model-group');
        const customModelGroup = document.getElementById('llm-custom-model-group');
        const modelSelect = document.getElementById('llm-config-model-select');
        const endpointInput = document.getElementById('llm-config-endpoint');

        // Models available per provider
        const providerModels = {
            ollama: ['llama3', 'llama3.1', 'llama3.2', 'mistral', 'mixtral', 'codellama', 'gemma2', 'qwen2.5'],
            openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'],
            anthropic: ['claude-3-5-sonnet-20241022', 'claude-3-opus-20240229', 'claude-3-haiku-20240307'],
            azure: ['gpt-4o', 'gpt-4-turbo', 'gpt-4', 'gpt-35-turbo'],
            bedrock: ['anthropic.claude-3-5-sonnet-20241022-v2:0', 'anthropic.claude-3-opus-20240229-v1:0', 'anthropic.claude-3-haiku-20240307-v1:0', 'amazon.titan-text-express-v1'],
            custom: [],
        };

        const defaults = {
            ollama: { model: 'llama3', endpoint: 'http://localhost:11434', showEndpoint: true, showApiKey: false, showRegion: false },
            openai: { model: 'gpt-4o', endpoint: '', showEndpoint: false, showApiKey: true, showRegion: false },
            anthropic: { model: 'claude-3-5-sonnet-20241022', endpoint: '', showEndpoint: false, showApiKey: true, showRegion: false },
            azure: { model: 'gpt-4o', endpoint: 'https://YOUR-RESOURCE.openai.azure.com', showEndpoint: true, showApiKey: true, showRegion: false },
            bedrock: { model: 'anthropic.claude-3-5-sonnet-20241022-v2:0', endpoint: '', showEndpoint: false, showApiKey: true, showRegion: true },
            custom: { model: '', endpoint: 'http://localhost:8080/v1', showEndpoint: true, showApiKey: true, showRegion: false },
        };

        const config = defaults[provider] || defaults.ollama;
        const models = providerModels[provider] || [];
        const isCustom = provider === 'custom';

        if (endpointGroup) endpointGroup.style.display = config.showEndpoint ? 'block' : 'none';
        if (apiKeyGroup) apiKeyGroup.style.display = config.showApiKey ? 'block' : 'none';
        if (regionGroup) regionGroup.style.display = config.showRegion ? 'block' : 'none';

        // Show dropdown for predefined providers, text input for custom
        if (modelGroup) modelGroup.style.display = isCustom ? 'none' : 'block';
        if (customModelGroup) customModelGroup.style.display = isCustom ? 'block' : 'none';

        // Populate model dropdown
        if (modelSelect && updateValues) {
            while (modelSelect.firstChild) {
                modelSelect.removeChild(modelSelect.firstChild);
            }
            models.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m;
                opt.textContent = m;
                if (m === config.model) opt.selected = true;
                modelSelect.appendChild(opt);
            });
        }

        // Update endpoint
        if (updateValues && endpointInput && config.endpoint) {
            endpointInput.value = config.endpoint;
            endpointInput.placeholder = config.endpoint;
        }
    },

    async saveLLMConfig(validateApiKey = true) {
        const enabled = document.getElementById('llm-enabled-checkbox')?.checked || false;
        const provider = document.querySelector('.llm-provider-card.selected')?.dataset.provider || 'ollama';
        // Get model from dropdown or custom input based on provider
        const model = provider === 'custom'
            ? (document.getElementById('llm-config-model-custom')?.value || '')
            : (document.getElementById('llm-config-model-select')?.value || '');
        const endpoint = document.getElementById('llm-config-endpoint')?.value || '';
        const apiKey = document.getElementById('llm-config-apikey')?.value || '';
        const awsRegion = document.getElementById('llm-config-region')?.value || 'us-east-1';

        // Validate: API key required for cloud providers
        const requiresApiKey = ['openai', 'anthropic', 'azure', 'bedrock'].includes(provider);
        if (validateApiKey && requiresApiKey) {
            const settings = await API.getLLMSettings();
            if (!apiKey && !settings.api_key_configured) {
                throw new Error('API key is required for ' + this.formatProvider(provider));
            }
        }

        const update = { enabled, provider };
        if (model) update.model = model;
        if (endpoint) update.endpoint = endpoint;
        if (apiKey) update.api_key = apiKey;
        if (provider === 'bedrock') update.aws_region = awsRegion;

        await API.updateLLMSettings(update);
    },

    formatProvider(provider) {
        const names = {
            ollama: 'Ollama',
            openai: 'OpenAI',
            anthropic: 'Anthropic',
            azure: 'Azure',
            bedrock: 'Bedrock',
            custom: 'Custom',
        };
        return names[provider] || provider;
    },

    async checkLLMMode() {
        try {
            const settings = await API.getLLMSettings();
            this.updateLLMToggle(settings.enabled, settings.provider, settings.model);
        } catch (e) {
            this.updateLLMToggle(false);
        }
    },

    updateLLMToggle(enabled, provider, model) {
        const btn = document.getElementById('llm-toggle-btn');
        const text = document.getElementById('llm-toggle-text');
        const indicator = document.getElementById('llm-toggle-indicator');
        if (!btn) return;

        if (enabled) {
            btn.className = 'llm-toggle-btn active';
            btn.classList.remove('flashing-border');
            if (text) {
                // Show "AI Analysis - ON (MODEL)" format
                const modelShort = model ? model.split('-')[0].split('/').pop().toUpperCase() : 'LLM';
                text.textContent = `AI Analysis - ON (${modelShort})`;
            }
            if (indicator) {
                indicator.className = 'llm-toggle-indicator on';
                indicator.textContent = '';
            }
        } else {
            btn.className = 'llm-toggle-btn';
            if (text) text.textContent = 'AI Analysis';
            if (indicator) {
                indicator.className = 'llm-toggle-indicator';
                indicator.textContent = '';
            }
        }
    },

    async toggleLLMMode() {
        try {
            const settings = await API.getLLMSettings();
            const newState = !settings.enabled;

            // If enabling and no provider configured, redirect to settings
            if (newState && !settings.provider) {
                if (window.Sidebar) Sidebar.navigate('settings');
                Toast.info('Configure your LLM provider first');
                return;
            }

            await API.updateLLMSettings({ enabled: newState });
            this.updateLLMToggle(newState, settings.provider, settings.model);
            Toast.success(newState ? 'AI Analysis enabled' : 'AI Analysis disabled');
        } catch (error) {
            Toast.error('Failed to toggle AI Analysis');
        }
    },

    createCloudToggle() {
        const wrapper = document.createElement('div');
        wrapper.className = 'cloud-toggle-wrapper';
        wrapper.id = 'cloud-toggle-wrapper';

        const btn = document.createElement('button');
        btn.className = 'cloud-toggle-btn gradient-btn';
        btn.id = 'cloud-toggle-btn';

        // Cloud icon
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('stroke-width', '2');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z');
        icon.appendChild(path);
        btn.appendChild(icon);

        // Text label
        const text = document.createElement('span');
        text.textContent = 'Cloud Connect';
        text.id = 'cloud-toggle-text';
        btn.appendChild(text);

        btn.addEventListener('click', () => this.toggleCloudMode());

        wrapper.appendChild(btn);
        return wrapper;
    },

    async checkCloudMode() {
        try {
            const settings = await API.getCloudSettings();
            this.cloudModeEnabled = settings.cloud_mode_enabled && settings.credentials_configured;
            this.updateCloudToggle(settings.cloud_mode_enabled, settings.credentials_configured);
            this.updateLLMButtonState();
        } catch (e) {
            this.cloudModeEnabled = false;
            this.updateCloudToggle(false, false);
        }
    },

    updateLLMButtonState() {
        const btn = document.getElementById('llm-toggle-btn');
        const text = document.getElementById('llm-toggle-text');
        if (!btn) return;

        if (this.cloudModeEnabled) {
            btn.disabled = true;
            btn.style.opacity = '0.5';
            btn.style.cursor = 'not-allowed';
            btn.classList.remove('flashing-border');
            btn.className = 'llm-toggle-btn disabled';
            if (text) text.textContent = 'AI Analysis (Cloud Active)';
            btn.title = 'Disabled - Cloud ML analysis is active';
        } else {
            btn.disabled = false;
            btn.style.opacity = '1';
            btn.style.cursor = 'pointer';
            btn.title = '';
        }
    },

    updateCloudToggle(enabled, configured) {
        const btn = document.getElementById('cloud-toggle-btn');
        const text = document.getElementById('cloud-toggle-text');
        const wrapper = document.getElementById('cloud-toggle-wrapper');
        if (!btn) return;

        // Remove existing indicator and tooltip if any
        const existingIndicator = document.getElementById('cloud-mode-indicator');
        if (existingIndicator) existingIndicator.remove();
        const existingTooltip = document.getElementById('cloud-mode-tooltip');
        if (existingTooltip) existingTooltip.remove();

        if (enabled) {
            btn.className = 'cloud-toggle-btn gradient-btn active';
            if (text) text.textContent = 'Connected';

            if (wrapper) {
                wrapper.style.position = 'relative';

                // Add "ON" badge
                const indicator = document.createElement('div');
                indicator.id = 'cloud-mode-indicator';
                indicator.style.cssText = 'position: absolute; top: -8px; right: -8px; background: linear-gradient(135deg, #10b981, #059669); color: white; font-size: 9px; font-weight: 700; padding: 2px 6px; border-radius: 8px; text-transform: uppercase; letter-spacing: 0.5px; box-shadow: 0 2px 8px rgba(16, 185, 129, 0.4);';
                indicator.textContent = 'ON';
                wrapper.appendChild(indicator);

                // Add hover tooltip
                const tooltip = document.createElement('div');
                tooltip.id = 'cloud-mode-tooltip';
                tooltip.style.cssText = 'position: absolute; top: 100%; right: 0; margin-top: 8px; background: linear-gradient(135deg, #10b981, #059669); color: white; padding: 10px 14px; border-radius: 8px; font-size: 12px; white-space: nowrap; opacity: 0; visibility: hidden; transition: all 0.2s; z-index: 1000; box-shadow: 0 4px 12px rgba(0,0,0,0.2);';

                const titleLine = document.createElement('div');
                titleLine.style.cssText = 'font-weight: 600; margin-bottom: 4px;';
                titleLine.textContent = 'CLOUD MODE ON';
                tooltip.appendChild(titleLine);

                const routeLine = document.createElement('div');
                routeLine.style.cssText = 'font-size: 11px; opacity: 0.9;';
                routeLine.textContent = 'Scans routed to scan.securevector.io';
                tooltip.appendChild(routeLine);

                const linkLine = document.createElement('div');
                linkLine.style.cssText = 'font-size: 11px; margin-top: 4px;';
                const link = document.createElement('a');
                link.href = 'https://app.securevector.io';
                link.target = '_blank';
                link.style.cssText = 'color: white; text-decoration: underline;';
                link.textContent = 'View threat analysis dashboard →';
                linkLine.appendChild(link);
                tooltip.appendChild(linkLine);

                wrapper.appendChild(tooltip);

                wrapper.addEventListener('mouseenter', () => {
                    tooltip.style.opacity = '1';
                    tooltip.style.visibility = 'visible';
                });
                wrapper.addEventListener('mouseleave', () => {
                    tooltip.style.opacity = '0';
                    tooltip.style.visibility = 'hidden';
                });
            }
        } else {
            btn.className = 'cloud-toggle-btn gradient-btn';
            if (text) text.textContent = 'Cloud Connect';
        }
    },

    async toggleCloudMode() {
        try {
            const settings = await API.getCloudSettings();

            if (!settings.credentials_configured) {
                // Show cloud connect guidance modal
                this.showCloudConnectGuide();
                return;
            }

            const newState = !settings.cloud_mode_enabled;
            await API.setCloudMode(newState);
            this.updateCloudToggle(newState, true);
            Toast.success(newState ? 'Cloud mode enabled' : 'Cloud mode disabled');
        } catch (error) {
            Toast.error('Failed to toggle cloud mode');
        }
    },

    showCloudConnectGuide() {
        const content = document.createElement('div');
        content.className = 'cloud-connect-guide';

        // Highlight banner for proprietary algorithm
        const highlight = document.createElement('div');
        highlight.className = 'cloud-highlight-banner';
        highlight.innerHTML = `
            <strong>Proprietary Multi-Stage Review Process</strong>
            <p>Our specialized algorithms are designed to minimize false positives through enterprise-grade threat intelligence.</p>
        `;
        content.appendChild(highlight);

        const intro = document.createElement('p');
        intro.textContent = 'Connect to SecureVector Cloud for advanced ML-powered threat detection, real-time dashboard, and centralized rule management.';
        intro.style.marginBottom = '20px';
        content.appendChild(intro);

        const steps = [
            { num: '1', title: 'Create Account', desc: 'Sign up at app.securevector.io (free tier available)' },
            { num: '2', title: 'Get API Key', desc: 'Go to Access Management -> Create a new key' },
            { num: '3', title: 'Add API Key', desc: 'Go to Settings and add your API key' },
            { num: '4', title: 'Connect', desc: 'Click Cloud Connect to enable cloud analysis' },
        ];

        const stepsList = document.createElement('div');
        stepsList.className = 'cloud-steps';

        steps.forEach(step => {
            const stepEl = document.createElement('div');
            stepEl.className = 'cloud-step';

            const numEl = document.createElement('span');
            numEl.className = 'step-number';
            numEl.textContent = step.num;
            stepEl.appendChild(numEl);

            const textEl = document.createElement('div');
            textEl.className = 'step-text';

            const titleEl = document.createElement('strong');
            titleEl.textContent = step.title;
            textEl.appendChild(titleEl);

            const descEl = document.createElement('p');
            descEl.textContent = step.desc;
            textEl.appendChild(descEl);

            stepEl.appendChild(textEl);
            stepsList.appendChild(stepEl);
        });

        content.appendChild(stepsList);

        // CTA button
        const cta = document.createElement('div');
        cta.style.marginTop = '20px';
        cta.style.textAlign = 'center';

        const ctaBtn = document.createElement('button');
        ctaBtn.className = 'btn btn-primary';
        ctaBtn.textContent = 'Go to app.securevector.io';
        ctaBtn.addEventListener('click', () => {
            window.open('https://app.securevector.io/login?redirect=desktop', '_blank');
        });
        cta.appendChild(ctaBtn);

        const localNote = document.createElement('div');
        localNote.className = 'local-mode-highlight';
        localNote.style.marginTop = '20px';
        localNote.style.padding = '12px 16px';
        localNote.style.background = 'linear-gradient(135deg, rgba(0, 188, 212, 0.1), rgba(244, 67, 54, 0.1))';
        localNote.style.border = '1px solid var(--accent-primary)';
        localNote.style.borderRadius = '8px';
        localNote.style.fontSize = '13px';
        localNote.style.textAlign = 'left';

        const noteIcon = document.createElement('span');
        noteIcon.textContent = '\u2713 ';
        noteIcon.style.color = 'var(--success)';
        noteIcon.style.fontWeight = 'bold';
        localNote.appendChild(noteIcon);

        const noteText = document.createElement('span');
        noteText.textContent = 'The desktop app works 100% locally without cloud. Cloud mode is optional and adds ML-powered detection.';
        localNote.appendChild(noteText);

        cta.appendChild(localNote);

        content.appendChild(cta);

        Modal.show({
            title: 'Connect to SecureVector Cloud',
            content: content,
            size: 'medium',
        });
    },

    openCloudConnect() {
        // Close LLM modal first, then show cloud connect
        Modal.close();
        setTimeout(() => this.showCloudConnectGuide(), 200);
    },

    createAgentDropdown() {
        const wrapper = document.createElement('div');
        wrapper.className = 'agent-dropdown-wrapper';

        const btn = document.createElement('button');
        btn.className = 'agent-dropdown-btn flashing-border';

        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('stroke-width', '2');
        // Robot/Agent icon
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x', '3');
        rect.setAttribute('y', '11');
        rect.setAttribute('width', '18');
        rect.setAttribute('height', '10');
        rect.setAttribute('rx', '2');
        icon.appendChild(rect);
        const circle1 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle1.setAttribute('cx', '12');
        circle1.setAttribute('cy', '5');
        circle1.setAttribute('r', '2');
        icon.appendChild(circle1);
        const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path1.setAttribute('d', 'M12 7v4');
        icon.appendChild(path1);
        const circle2 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle2.setAttribute('cx', '8');
        circle2.setAttribute('cy', '16');
        circle2.setAttribute('r', '1');
        circle2.setAttribute('fill', 'currentColor');
        icon.appendChild(circle2);
        const circle3 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle3.setAttribute('cx', '16');
        circle3.setAttribute('cy', '16');
        circle3.setAttribute('r', '1');
        circle3.setAttribute('fill', 'currentColor');
        icon.appendChild(circle3);
        btn.appendChild(icon);

        const text = document.createElement('span');
        text.textContent = 'Agent Integrations';
        btn.appendChild(text);

        const arrow = document.createElement('span');
        arrow.className = 'dropdown-arrow';
        arrow.textContent = '\u25BC';
        btn.appendChild(arrow);

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleDropdown(wrapper);
        });

        wrapper.appendChild(btn);

        // Dropdown menu
        const menu = document.createElement('div');
        menu.className = 'agent-dropdown-menu';

        this.agents.forEach(agent => {
            const item = document.createElement('div');
            item.className = 'agent-dropdown-item';
            item.textContent = agent.name;
            item.addEventListener('click', () => {
                this.showAgentInstructions(agent.id);
                this.closeDropdown(wrapper);
            });
            menu.appendChild(item);
        });

        wrapper.appendChild(menu);

        // Close dropdown when clicking outside
        document.addEventListener('click', () => this.closeDropdown(wrapper));

        return wrapper;
    },

    toggleDropdown(wrapper) {
        const menu = wrapper.querySelector('.agent-dropdown-menu');
        const isOpen = menu.classList.contains('active');
        if (isOpen) {
            this.closeDropdown(wrapper);
        } else {
            menu.classList.add('active');
            this.dropdownOpen = true;
        }
    },

    closeDropdown(wrapper) {
        const menu = wrapper.querySelector('.agent-dropdown-menu');
        if (menu) {
            menu.classList.remove('active');
        }
        this.dropdownOpen = false;
    },

    showAgentInstructions(agentId) {
        const instructions = this.getAgentInstructions(agentId);
        if (!instructions) return;

        const content = document.createElement('div');
        content.className = 'agent-instructions';

        // Description
        const desc = document.createElement('p');
        desc.className = 'agent-description';
        desc.textContent = instructions.description;
        desc.style.marginBottom = '20px';
        desc.style.color = 'var(--text-secondary)';
        content.appendChild(desc);

        // Why Proxy section (if present)
        if (instructions.whyProxy) {
            const whyBox = document.createElement('div');
            whyBox.className = 'cloud-highlight-banner';
            whyBox.style.cssText = 'margin-bottom:20px;padding:16px;background:linear-gradient(135deg, rgba(244, 67, 54, 0.1), rgba(255, 152, 0, 0.1));border:1px solid var(--warning, #ff9800);border-radius:8px;';

            const whyTitle = document.createElement('strong');
            whyTitle.textContent = instructions.whyProxy.title;
            whyTitle.style.display = 'block';
            whyTitle.style.marginBottom = '10px';
            whyTitle.style.color = 'var(--warning, #ff9800)';
            whyBox.appendChild(whyTitle);

            const reasonsList = document.createElement('ul');
            reasonsList.style.cssText = 'margin:0;padding-left:20px;font-size:13px;color:var(--text-secondary);';
            instructions.whyProxy.reasons.forEach(reason => {
                const li = document.createElement('li');
                li.textContent = reason;
                li.style.marginBottom = '4px';
                reasonsList.appendChild(li);
            });
            whyBox.appendChild(reasonsList);

            content.appendChild(whyBox);
        }

        // Steps
        if (instructions.steps && instructions.steps.length > 0) {
            const stepsList = document.createElement('div');
            stepsList.className = 'cloud-steps';

            instructions.steps.forEach(step => {
                const stepEl = document.createElement('div');
                stepEl.className = 'cloud-step';

                const numEl = document.createElement('span');
                numEl.className = 'step-number';
                numEl.textContent = step.num;
                stepEl.appendChild(numEl);

                const textEl = document.createElement('div');
                textEl.className = 'step-text';

                const titleEl = document.createElement('strong');
                titleEl.textContent = step.title;
                textEl.appendChild(titleEl);

                const descEl = document.createElement('p');
                descEl.textContent = step.desc;
                textEl.appendChild(descEl);

                // Code snippet for this step
                if (step.code) {
                    const codeBlock = document.createElement('pre');
                    codeBlock.className = 'step-code';
                    codeBlock.style.cssText = 'background:var(--bg-tertiary);padding:8px 12px;border-radius:6px;margin-top:8px;font-size:12px;overflow-x:auto;';
                    const codeEl = document.createElement('code');
                    codeEl.textContent = step.code;
                    codeBlock.appendChild(codeEl);
                    textEl.appendChild(codeBlock);
                }

                stepEl.appendChild(textEl);
                stepsList.appendChild(stepEl);
            });

            content.appendChild(stepsList);
        }

        // Full code block (if provided)
        if (instructions.code) {
            const codeSection = document.createElement('div');
            codeSection.style.marginTop = '20px';

            const codeLabel = document.createElement('div');
            codeLabel.style.cssText = 'font-size:12px;color:var(--text-secondary);margin-bottom:8px;';
            codeLabel.textContent = 'Full Code:';
            codeSection.appendChild(codeLabel);

            const block = document.createElement('div');
            block.className = 'instructions-block';

            const pre = document.createElement('pre');
            const code = document.createElement('code');
            code.textContent = instructions.code;
            pre.appendChild(code);
            block.appendChild(pre);

            const copyBtn = document.createElement('button');
            copyBtn.className = 'btn btn-small btn-primary copy-btn';
            copyBtn.textContent = 'Copy';
            copyBtn.addEventListener('click', () => {
                navigator.clipboard.writeText(instructions.code).then(() => {
                    copyBtn.textContent = 'Copied!';
                    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
                });
            });
            block.appendChild(copyBtn);

            codeSection.appendChild(block);
            content.appendChild(codeSection);
        }

        // Note section (if provided)
        if (instructions.note) {
            const noteEl = document.createElement('div');
            noteEl.className = 'local-mode-highlight';
            noteEl.style.cssText = 'margin-top:20px;padding:12px 16px;background:linear-gradient(135deg, rgba(0, 188, 212, 0.1), rgba(244, 67, 54, 0.1));border:1px solid var(--accent-primary);border-radius:8px;font-size:13px;';

            const noteIcon = document.createElement('span');
            noteIcon.textContent = '💡 ';
            noteEl.appendChild(noteIcon);

            const noteText = document.createElement('span');
            noteText.textContent = instructions.note;
            noteEl.appendChild(noteText);

            content.appendChild(noteEl);
        }

        Modal.show({
            title: instructions.name + ' Integration',
            content: content,
            size: 'medium',
        });
    },

    getAgentInstructions(agentId) {
        const instructions = {
            'n8n': {
                name: 'n8n',
                description: 'Workflow automation platform with visual workflow builder',
                steps: [
                    { num: '1', title: 'Open Settings', desc: 'Go to Settings → Community Nodes' },
                    { num: '2', title: 'Install Node', desc: 'Search and install: n8n-nodes-securevector' },
                    { num: '3', title: 'Add to Workflow', desc: 'Drag SecureVector node into your workflow' },
                    { num: '4', title: 'Configure Endpoint', desc: 'Paste your endpoint URL', code: 'Local: http://localhost:8741/analyze\nCloud: https://scan.securevector.io/analyze' },
                ],
                note: 'Enable "Output Scan" in header to scan LLM responses for data leakage, PII, and credential exposure.',
            },
            'dify': {
                name: 'Dify',
                description: 'LLM application development platform',
                steps: [
                    { num: '1', title: 'Open Settings', desc: 'Navigate to Settings → Triggers' },
                    { num: '2', title: 'Add Webhook', desc: 'Click "Add Webhook" button' },
                    { num: '3', title: 'Configure URL', desc: 'Paste your endpoint URL', code: 'Local: http://localhost:8741/analyze\nCloud: https://scan.securevector.io/analyze' },
                    { num: '4', title: 'Set Headers', desc: 'Content-Type: application/json' },
                    { num: '5', title: 'Configure Body', desc: 'Set request body format', code: '{"text": "<message>"}' },
                ],
            },
            'crewai': {
                name: 'CrewAI Enterprise',
                description: 'AI agent orchestration framework',
                steps: [
                    { num: '1', title: 'Open Crew Settings', desc: 'Navigate to your Crew configuration' },
                    { num: '2', title: 'Set Webhook URL', desc: 'Configure stepWebhookUrl parameter', code: 'Local: http://localhost:8741/analyze\nCloud: https://scan.securevector.io/analyze' },
                    { num: '3', title: 'Deploy', desc: 'Save and deploy your Crew' },
                ],
                note: 'The webhook receives {"text": "..."} and returns threat analysis for each agent step.',
            },
            'claude-desktop': {
                name: 'Claude Desktop',
                description: 'MCP integration for Claude Desktop & Cursor IDE',
                steps: [
                    { num: '1', title: 'Install Package', desc: 'Install SecureVector with MCP support', code: 'pip install securevector-ai-monitor[mcp]' },
                    { num: '2', title: 'Edit Config', desc: 'Open claude_desktop_config.json' },
                    { num: '3', title: 'Add Server', desc: 'Add SecureVector MCP server', code: '{\n  "mcpServers": {\n    "securevector": {\n      "command": "securevector-mcp"\n    }\n  }\n}' },
                    { num: '4', title: 'Restart Claude', desc: 'Restart Claude Desktop to apply changes' },
                ],
                note: 'See docs/MCP_GUIDE.md for full setup instructions.',
            },
            'openclaw': {
                name: 'OpenClaw',
                description: 'Open-source AI agent platform with Smart Output Detection',
                whyProxy: {
                    title: 'Why Proxy Mode?',
                    reasons: [
                        'OpenClaw has no message interception hooks',
                        'Hooks only fire AFTER messages reach the LLM (too late)',
                        'Skills require LLM cooperation (unreliable)',
                        'Proxy intercepts at network level = 100% coverage'
                    ]
                },
                steps: [
                    { num: '1', title: 'Start OpenClaw', desc: 'Run OpenClaw gateway on alternate port', code: 'openclaw gateway --port 18790' },
                    { num: '2', title: 'Start Proxy', desc: 'Go to OpenClaw Proxy page in sidebar and click Start Proxy, or run from terminal:', code: '# Option 1: Use the Proxy page in sidebar\n# Option 2: Run from terminal:\npython -m securevector.integrations.openclaw_proxy' },
                    { num: '3', title: 'Connect Client', desc: 'Use OpenClaw TUI normally - it connects through proxy automatically', code: 'openclaw tui' },
                ],
                note: 'Manage proxy from the OpenClaw Proxy page in sidebar. Configure Block Mode and Output Scanning for threat detection.',
            },
            'langchain': {
                name: 'LangChain',
                description: 'LLM application framework with callback support',
                steps: [
                    { num: '1', title: 'Install Package', desc: 'Install SecureVector client', code: 'pip install securevector-ai-monitor' },
                    { num: '2', title: 'Create Callback', desc: 'Implement SecureVectorCallback class with input/output scanning' },
                    { num: '3', title: 'Add to Chain', desc: 'Pass callback to your chain invocation' },
                ],
                code: `from langchain_core.callbacks import BaseCallbackHandler
from securevector import SecureVectorClient

class SecureVectorCallback(BaseCallbackHandler):
    def __init__(self):
        self.client = SecureVectorClient()

    def on_chat_model_start(self, serialized, messages, **kwargs):
        # Scan input (prompt injection detection)
        for msg_list in messages:
            for msg in msg_list:
                if self.client.analyze(msg.content).is_threat:
                    raise ValueError("Blocked by SecureVector")

    def on_llm_end(self, response, **kwargs):
        # Scan output (data leakage detection)
        for gen in response.generations:
            for g in gen:
                result = self.client.analyze(g.text, llm_response=True)
                if result.is_threat:
                    print(f"⚠️ Output leakage: {result.threat_type}")

# Usage:
response = chain.invoke(input, config={
    "callbacks": [SecureVectorCallback()]
})`,
                note: 'Scans both input (prompt injection) and output (data leakage, PII exposure).',
            },
            'langgraph': {
                name: 'LangGraph',
                description: 'Stateful agent orchestration with graph-based workflows',
                steps: [
                    { num: '1', title: 'Install Package', desc: 'Install SecureVector client', code: 'pip install securevector-ai-monitor' },
                    { num: '2', title: 'Create Security Nodes', desc: 'Define input and output security check nodes' },
                    { num: '3', title: 'Add to Graph', desc: 'Insert nodes before and after LLM' },
                ],
                code: `from langgraph.graph import StateGraph, START, END
from securevector import SecureVectorClient

client = SecureVectorClient()

def input_security(state: dict) -> dict:
    """Scan input for prompt injection"""
    last_msg = state["messages"][-1].content
    if client.analyze(last_msg).is_threat:
        raise ValueError("Blocked by SecureVector")
    return state

def output_security(state: dict) -> dict:
    """Scan output for data leakage"""
    if "response" in state:
        result = client.analyze(state["response"], llm_response=True)
        if result.is_threat:
            state["security_warning"] = result.threat_type
    return state

# Add to your graph:
graph.add_edge(START, "input_security")
graph.add_edge("input_security", "llm")
graph.add_edge("llm", "output_security")
graph.add_edge("output_security", END)`,
                note: 'Smart Output Detection: scans for credentials, PII, system prompt leaks, and encoded data in responses.',
            },
        };
        return instructions[agentId];
    },

    getPageTitle() {
        const titles = {
            'guide': 'Guide',
            dashboard: 'Dashboard',
            threats: 'Threat Analytics',
            rules: 'Rules',
            'tool-permissions': 'Tool Permissions',
            proxy: 'Security',
            settings: 'Settings',
        };
        const currentPage = window.Sidebar ? Sidebar.currentPage : 'dashboard';
        return titles[currentPage] || 'Dashboard';
    },

    getStatusText() {
        const texts = {
            checking: 'Checking...',
            healthy: 'Server Online',
            degraded: 'Degraded',
            offline: 'Offline',
        };
        return texts[this.serverStatus] || 'Unknown';
    },

    createThemeIcon() {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');

        if (isDark) {
            // Sun icon
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', '12');
            circle.setAttribute('cy', '12');
            circle.setAttribute('r', '5');
            svg.appendChild(circle);

            const rays = [
                'M12 1v2', 'M12 21v2', 'M4.22 4.22l1.42 1.42',
                'M18.36 18.36l1.42 1.42', 'M1 12h2', 'M21 12h2',
                'M4.22 19.78l1.42-1.42', 'M18.36 5.64l1.42-1.42'
            ];
            rays.forEach(d => {
                const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                line.setAttribute('d', d);
                svg.appendChild(line);
            });
        } else {
            // Moon icon
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z');
            svg.appendChild(path);
        }

        return svg;
    },

    async toggleTheme() {
        const html = document.documentElement;
        const currentTheme = html.getAttribute('data-theme') || 'dark';
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

        html.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);

        // Re-render to update icon
        this.render();
    },

    async checkStatus() {
        try {
            const health = await API.health();
            this.serverStatus = health.status || 'healthy';
        } catch (e) {
            this.serverStatus = 'offline';
        }
        this.updateStatusBadge();
    },

    updateStatusBadge() {
        const badge = document.getElementById('server-status');
        if (!badge) return;

        badge.className = 'status-badge ' + this.serverStatus;
        const textSpan = badge.querySelector('span:last-child');
        if (textSpan) {
            textSpan.textContent = this.getStatusText();
        }
    },

    PAGE_INFO: {
        dashboard:         { title: 'Dashboard',           subtitle: 'Scanned requests, active threats, cost trends, and recent activity' },
        threats:           { title: 'Threat Monitor',      subtitle: 'All LLM requests analyzed for threats' },
        rules:             { title: 'Detection Rules',     subtitle: 'Manage community and custom threat detection rules' },
        'tool-permissions':{ title: 'Tool Permissions',   subtitle: 'Control which tools your agent is allowed to call' },
        costs:             { title: 'Cost Tracking',       subtitle: 'Track LLM token spend per agent' },
        integrations:      { title: 'Integrations',        subtitle: 'Connect SecureVector to your AI framework' },
        guide:             { title: 'Guide',               subtitle: 'Setup instructions and integration examples' },
        settings:          { title: 'Settings',            subtitle: 'Configure SecureVector for your environment' },
        'proxy-langchain': { title: 'LangChain Proxy',     subtitle: 'Proxy setup for LangChain agents' },
        'proxy-langgraph': { title: 'LangGraph Proxy',     subtitle: 'Proxy setup for LangGraph agents' },
        'proxy-crewai':    { title: 'CrewAI Proxy',        subtitle: 'Proxy setup for CrewAI agents' },
        'proxy-ollama':    { title: 'Ollama Proxy',        subtitle: 'Proxy setup for Ollama agents' },
        'proxy-openclaw':  { title: 'OpenClaw Proxy',      subtitle: 'Proxy setup for OpenClaw agents' },
        'proxy-n8n':       { title: 'n8n Proxy',           subtitle: 'Proxy setup for n8n workflows' },
    },

    updateTitle() {
        const currentPage = window.Sidebar ? Sidebar.currentPage : 'dashboard';
        const info = this.PAGE_INFO[currentPage] || { title: this.getPageTitle(), subtitle: '' };

        const hpt = document.getElementById('header-page-title');
        if (hpt) hpt.textContent = info.title;
        const hps = document.getElementById('header-page-subtitle');
        if (hps) hps.textContent = info.subtitle;
    },

    setPageInfo(title, subtitle) {
        const hpt = document.getElementById('header-page-title');
        if (hpt) hpt.textContent = title || '';
        const hps = document.getElementById('header-page-subtitle');
        if (hps) hps.textContent = subtitle !== undefined ? subtitle : '';
    },
};

window.Header = Header;
