/**
 * Getting Started Page
 * All sections are collapsible, collapsed by default
 */

const GettingStartedPage = {
    async render(container) {
        container.textContent = '';

        // Page header
        const header = document.createElement('div');
        header.className = 'dashboard-header';

        const title = document.createElement('h1');
        title.className = 'dashboard-title';
        title.textContent = 'Guide';
        header.appendChild(title);

        const subtitle = document.createElement('p');
        subtitle.className = 'dashboard-subtitle';
        subtitle.textContent = 'Everything you need to protect your AI agents.';
        header.appendChild(subtitle);

        container.appendChild(header);

        // === SECTIONS (all collapsible, collapsed by default) ===

        container.appendChild(this.createCollapsibleCard(
            'Getting Started', 'No code changes — just set an environment variable',
            'section-getting-started', () => this.buildProxyContent()
        ));

        container.appendChild(this.createCollapsibleCard(
            'How Scanning Works', 'Input and output threat detection',
            'section-scanning', () => this.buildScanningContent()
        ));

        container.appendChild(this.createCollapsibleCard(
            'Threat Modes', 'Block Mode (default) and Log Mode',
            'section-modes', () => this.buildModesContent()
        ));

        container.appendChild(this.createCollapsibleCard(
            'AI Analysis (Optional)', 'Two-stage detection pipeline',
            'section-ai-analysis', () => this.buildAIAnalysisContent()
        ));

        container.appendChild(this.createCollapsibleCard(
            'Cloud Mode (Optional)', 'Multi-stage ML-powered analysis',
            'section-cloud', () => this.buildCloudContent()
        ));

        container.appendChild(this.createCollapsibleCard(
            'API Reference', 'REST API and interactive documentation',
            'section-api', () => this.buildAPIContent()
        ));

        // Handle pending scroll from sidebar section navigation
        if (Sidebar._pendingScroll) {
            const sectionId = Sidebar._pendingScroll;
            Sidebar._pendingScroll = null;
            setTimeout(() => {
                const target = document.getElementById(sectionId);
                if (target) {
                    // Expand the section first
                    const body = target.querySelector('.gs-card-body');
                    const indicator = target.querySelector('.gs-toggle-indicator');
                    if (body && body.style.display === 'none') {
                        body.style.display = 'block';
                        if (indicator) indicator.textContent = '\u2212';
                    }
                    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            }, 100);
        }
    },

    // === Collapsible card wrapper ===

    createCollapsibleCard(title, subtitle, sectionId, contentBuilder) {
        const card = document.createElement('div');
        card.className = 'card';
        card.id = sectionId;
        card.style.cssText = 'padding: 0; overflow: hidden; margin-bottom: 12px;';

        // Clickable header
        const header = document.createElement('div');
        header.style.cssText = 'padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; cursor: pointer; user-select: none; transition: background 0.15s;';
        header.addEventListener('mouseenter', () => { header.style.background = 'rgba(0, 188, 212, 0.04)'; });
        header.addEventListener('mouseleave', () => { header.style.background = ''; });

        const headerLeft = document.createElement('div');
        const headerTitle = document.createElement('div');
        headerTitle.style.cssText = 'font-weight: 700; font-size: 15px; color: var(--text-primary);';
        headerTitle.textContent = title;
        headerLeft.appendChild(headerTitle);

        const headerDesc = document.createElement('div');
        headerDesc.style.cssText = 'font-size: 12px; color: var(--text-secondary); margin-top: 2px;';
        headerDesc.textContent = subtitle;
        headerLeft.appendChild(headerDesc);

        header.appendChild(headerLeft);

        // Toggle indicator (+/-)
        const indicator = document.createElement('span');
        indicator.className = 'gs-toggle-indicator';
        indicator.style.cssText = 'font-size: 20px; font-weight: 300; color: var(--text-secondary); flex-shrink: 0; width: 24px; text-align: center; line-height: 1;';
        indicator.textContent = '+';
        header.appendChild(indicator);

        card.appendChild(header);

        // Collapsible body (hidden by default)
        const body = document.createElement('div');
        body.className = 'gs-card-body';
        body.style.cssText = 'display: none; padding: 0 20px 20px 20px; border-top: 1px solid var(--border-color);';
        body.appendChild(contentBuilder());
        card.appendChild(body);

        // Toggle on click
        header.addEventListener('click', () => {
            const isHidden = body.style.display === 'none';
            body.style.display = isHidden ? 'block' : 'none';
            indicator.textContent = isHidden ? '\u2212' : '+';
        });

        return card;
    },

    // === Section content builders ===

    buildProxyContent() {
        const frag = document.createElement('div');
        frag.style.cssText = 'padding-top: 16px;';

        // Step 1
        frag.appendChild(this.createMiniStep('1', 'Go to Integrations', 'Open the Integrations page in the sidebar.'));

        const intBtn = document.createElement('button');
        intBtn.className = 'btn btn-primary';
        intBtn.style.cssText = 'font-size: 12px; margin: 0 0 16px 42px; padding: 6px 14px;';
        intBtn.textContent = 'Open Integrations';
        intBtn.addEventListener('click', () => {
            if (window.Sidebar) Sidebar.navigate('integrations');
        });
        frag.appendChild(intBtn);

        // Step 2
        frag.appendChild(this.createMiniStep('2', 'Select Your Integration', 'Choose your AI agent framework (LangChain, CrewAI, Ollama, OpenClaw) and select your LLM provider.'));

        // Step 3
        frag.appendChild(this.createMiniStep('3', 'Start Proxy', 'Click "Start Proxy" on the integration page. The proxy launches on port 8742. Then follow the on-screen instructions to configure your client app.'));

        const cmdBlock = document.createElement('div');
        cmdBlock.style.cssText = 'margin: 8px 0 12px 42px;';
        cmdBlock.appendChild(this.createCodeBlock('# Example env var shown on integration page:\nexport OPENAI_BASE_URL=http://localhost:8742/openai/v1'));
        frag.appendChild(cmdBlock);

        // Examples
        const examplesTitle = document.createElement('div');
        examplesTitle.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--text-primary); margin: 16px 0 10px 0;';
        examplesTitle.textContent = 'Examples';
        frag.appendChild(examplesTitle);

        frag.appendChild(this.createExampleBox(
            'OpenClaw + Telegram',
            'You run OpenClaw as a Claude-powered gateway agent. Users chat with your bot on Telegram. SecureVector sits between OpenClaw and Claude, scanning every message for prompt injection before it reaches the LLM.',
            [
                'Go to Integrations \u2192 OpenClaw in the sidebar',
                'Select Anthropic as the provider',
                'Click Start Proxy',
                'Start OpenClaw gateway \u2014 it routes through SecureVector automatically',
                'Send a message from Telegram to test',
            ],
            'Telegram \u2192 OpenClaw gateway \u2192 SecureVector (scans) \u2192 Claude'
        ));

        frag.appendChild(this.createExampleBox(
            'Ollama + Open WebUI',
            'You run Ollama locally and chat through Open WebUI. Point Open WebUI at the SecureVector proxy instead of Ollama directly \u2014 every chat message is scanned before reaching your model.',
            [
                'Go to Integrations \u2192 Ollama in the sidebar',
                'Select Ollama as the provider',
                'Click Start Proxy',
                'In Open WebUI: Settings \u2192 Connections \u2192 set Ollama URL to http://localhost:8742/ollama',
                'Send a chat message to test',
            ],
            'Open WebUI \u2192 SecureVector (scans) \u2192 Ollama'
        ));

        const doneNote = document.createElement('div');
        doneNote.style.cssText = 'margin: 12px 0 0 0; padding: 10px 14px; background: var(--bg-secondary); border-radius: 6px; font-size: 12px; color: var(--text-secondary); border-left: 3px solid var(--accent-primary);';
        doneNote.textContent = 'All LLM traffic is now scanned for prompt injection and data leaks.';
        frag.appendChild(doneNote);

        return frag;
    },

    buildScanningContent() {
        const frag = document.createElement('div');
        frag.style.cssText = 'padding-top: 16px;';

        const desc = document.createElement('p');
        desc.style.cssText = 'color: var(--text-secondary); margin: 0 0 16px 0; font-size: 13px; line-height: 1.5;';
        desc.textContent = 'SecureVector scans traffic in both directions. Input scanning runs on every request by default. Output scanning is optional and can be toggled from the header.';
        frag.appendChild(desc);

        const grid = document.createElement('div');
        grid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px;';

        // Input column
        const inputCol = document.createElement('div');
        inputCol.style.cssText = 'padding: 14px; background: var(--bg-secondary); border-radius: 8px; border-top: 3px solid var(--accent-primary);';

        const inputTitle = document.createElement('div');
        inputTitle.style.cssText = 'font-weight: 700; font-size: 13px; color: var(--text-primary); margin-bottom: 8px;';
        inputTitle.textContent = 'Input Scanning (User \u2192 LLM)';
        inputCol.appendChild(inputTitle);

        const inputDesc = document.createElement('div');
        inputDesc.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 8px;';
        inputDesc.textContent = 'Scans the last user message before it reaches the LLM. Always active.';
        inputCol.appendChild(inputDesc);

        inputCol.appendChild(this.createBulletList(['Prompt injection', 'Jailbreak attempts', 'Data exfiltration requests', 'Social engineering', 'System override attempts']));
        grid.appendChild(inputCol);

        // Output column
        const outputCol = document.createElement('div');
        outputCol.style.cssText = 'padding: 14px; background: var(--bg-secondary); border-radius: 8px; border-top: 3px solid var(--accent-secondary, #f44336);';

        const outputTitle = document.createElement('div');
        outputTitle.style.cssText = 'font-weight: 700; font-size: 13px; color: var(--text-primary); margin-bottom: 8px;';
        outputTitle.textContent = 'Output Scanning (LLM \u2192 User)';
        outputCol.appendChild(outputTitle);

        const outputDesc = document.createElement('div');
        outputDesc.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 8px;';
        outputDesc.textContent = 'Scans LLM responses before they reach the client. Toggle with "Output" button in header. Sensitive data is redacted when stored.';
        outputCol.appendChild(outputDesc);

        outputCol.appendChild(this.createBulletList(['Credential leakage (API keys, tokens)', 'System prompt exposure', 'PII disclosure (SSN, credit cards)', 'Jailbreak success indicators', 'Encoded malicious content']));
        grid.appendChild(outputCol);

        frag.appendChild(grid);
        return frag;
    },

    buildModesContent() {
        const frag = document.createElement('div');
        frag.style.cssText = 'padding-top: 16px;';

        const desc = document.createElement('p');
        desc.style.cssText = 'color: var(--text-secondary); margin: 0 0 16px 0; font-size: 13px; line-height: 1.5;';
        desc.textContent = 'Control what happens when a threat is detected. Toggle Block Mode from the header bar.';
        frag.appendChild(desc);

        const grid = document.createElement('div');
        grid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px;';

        // Block mode (default)
        const blockBox = document.createElement('div');
        blockBox.style.cssText = 'padding: 14px; background: var(--bg-secondary); border-radius: 8px; border-left: 3px solid var(--accent-secondary, #f44336);';

        const blockTitle = document.createElement('div');
        blockTitle.style.cssText = 'font-weight: 700; font-size: 13px; color: var(--text-primary); margin-bottom: 4px;';
        blockTitle.textContent = 'Block Mode (Default)';
        blockBox.appendChild(blockTitle);

        const blockDesc = document.createElement('div');
        blockDesc.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.4;';
        blockDesc.textContent = 'Threats are actively blocked. Input threats are stopped before reaching the LLM. Output threats are stopped before reaching the client. All threats are still logged.';
        blockBox.appendChild(blockDesc);
        grid.appendChild(blockBox);

        // Log mode
        const logBox = document.createElement('div');
        logBox.style.cssText = 'padding: 14px; background: var(--bg-secondary); border-radius: 8px; border-left: 3px solid var(--accent-primary);';

        const logTitle = document.createElement('div');
        logTitle.style.cssText = 'font-weight: 700; font-size: 13px; color: var(--text-primary); margin-bottom: 4px;';
        logTitle.textContent = 'Log Mode';
        logBox.appendChild(logTitle);

        const logDesc = document.createElement('div');
        logDesc.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.4;';
        logDesc.textContent = 'Threats are detected and recorded in the dashboard. Traffic is not interrupted. Use this to monitor your AI agent\'s traffic and understand threat patterns before enabling blocking.';
        logBox.appendChild(logDesc);
        grid.appendChild(logBox);

        frag.appendChild(grid);
        return frag;
    },

    buildAIAnalysisContent() {
        const frag = document.createElement('div');
        frag.style.cssText = 'padding-top: 16px;';

        const desc = document.createElement('p');
        desc.style.cssText = 'color: var(--text-secondary); margin: 0 0 16px 0; font-size: 13px; line-height: 1.5;';
        desc.textContent = 'SecureVector uses a two-stage detection pipeline. Stage 1 (pattern matching) is always active and runs in under 5ms. Stage 2 (AI Analysis) is optional and uses a secondary LLM to evaluate flagged input.';
        frag.appendChild(desc);

        const grid = document.createElement('div');
        grid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-bottom: 16px;';

        // Pattern matching
        const patternBox = document.createElement('div');
        patternBox.style.cssText = 'padding: 14px; background: var(--bg-secondary); border-radius: 8px;';

        const patternTitle = document.createElement('div');
        patternTitle.style.cssText = 'font-weight: 700; font-size: 13px; color: var(--text-primary); margin-bottom: 6px;';
        patternTitle.textContent = 'Stage 1: Pattern Matching';
        patternBox.appendChild(patternTitle);

        patternBox.appendChild(this.createBulletList(['Always active (default)', 'Regex-based community + custom rules', 'Processing time: < 5ms', 'No external dependencies', 'Covers 90-97% of known attack patterns']));
        grid.appendChild(patternBox);

        // AI Analysis
        const aiBox = document.createElement('div');
        aiBox.style.cssText = 'padding: 14px; background: var(--bg-secondary); border-radius: 8px;';

        const aiTitle = document.createElement('div');
        aiTitle.style.cssText = 'font-weight: 700; font-size: 13px; color: var(--text-primary); margin-bottom: 6px;';
        aiTitle.textContent = 'Stage 2: AI Analysis';
        aiBox.appendChild(aiTitle);

        aiBox.appendChild(this.createBulletList(['Optional \u2014 enable in the header', 'Uses a secondary LLM for semantic analysis', 'Runs on input scans only', 'Adds 1-3s latency (depends on model)', 'Reduces false positives']));
        grid.appendChild(aiBox);

        frag.appendChild(grid);

        // When to enable
        const whenBox = document.createElement('div');
        whenBox.style.cssText = 'padding: 12px 14px; background: var(--bg-secondary); border-radius: 8px; font-size: 12px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 14px;';

        const whenTitle = document.createElement('div');
        whenTitle.style.cssText = 'font-weight: 700; color: var(--text-primary); margin-bottom: 4px; font-size: 12px;';
        whenTitle.textContent = 'When to enable AI Analysis:';
        whenBox.appendChild(whenTitle);

        whenBox.appendChild(document.createTextNode('Enable it when you need to reduce false positives and can tolerate additional latency (1-3s per scan). Use pattern matching alone when you need maximum throughput with minimal latency. AI Analysis only runs on input scans \u2014 output scanning always uses fast regex rules.'));
        frag.appendChild(whenBox);

        // How to enable steps
        const stepsRow = document.createElement('div');
        stepsRow.style.cssText = 'display: flex; gap: 16px; flex-wrap: wrap;';

        ['Click "AI Analysis" in the header', 'Select a provider (Ollama for local, or OpenAI/Anthropic)', 'Test Connection, then Save'].forEach((text, i) => {
            const item = document.createElement('div');
            item.style.cssText = 'display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary);';

            const num = document.createElement('span');
            num.style.cssText = 'color: var(--accent-primary); font-weight: 700;';
            num.textContent = (i + 1) + '.';
            item.appendChild(num);

            const t = document.createElement('span');
            t.textContent = text;
            item.appendChild(t);

            stepsRow.appendChild(item);
        });

        frag.appendChild(stepsRow);
        return frag;
    },

    buildCloudContent() {
        const frag = document.createElement('div');
        frag.style.cssText = 'padding-top: 16px;';

        const desc = document.createElement('p');
        desc.style.cssText = 'color: var(--text-secondary); margin: 0 0 14px 0; font-size: 13px; line-height: 1.5;';
        desc.textContent = 'SecureVector works 100% locally by default. Optionally connect to SecureVector Cloud for multi-stage ML-powered analysis designed to minimize false positives through proprietary threat intelligence. When enabled, scans are routed to the cloud API and results appear in a centralized dashboard.';
        frag.appendChild(desc);

        frag.appendChild(this.createBulletList(['Advanced ML-powered threat detection beyond regex', 'Centralized dashboard at app.securevector.io', 'Replaces local AI Analysis when active', 'Falls back to local analysis if cloud is unreachable']));

        const stepsWrapper = document.createElement('div');
        stepsWrapper.className = 'cloud-steps';
        stepsWrapper.style.cssText = 'margin-top: 14px;';

        [
            { num: '1', title: 'Create Account', desc: 'Sign up at app.securevector.io (free tier available)' },
            { num: '2', title: 'Get API Key', desc: 'Go to Access Management and create a new key' },
            { num: '3', title: 'Add Key', desc: 'Go to Settings in the sidebar and paste your key under Cloud' },
            { num: '4', title: 'Connect', desc: 'Click "Cloud Connect" in the header' },
        ].forEach(step => {
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
            stepsWrapper.appendChild(stepEl);
        });

        frag.appendChild(stepsWrapper);
        return frag;
    },

    buildAPIContent() {
        const frag = document.createElement('div');
        frag.style.cssText = 'padding-top: 16px;';

        const desc = document.createElement('p');
        desc.style.cssText = 'color: var(--text-secondary); margin: 0 0 14px 0; font-size: 13px; line-height: 1.5;';
        desc.textContent = 'SecureVector exposes a full REST API with interactive documentation.';
        frag.appendChild(desc);

        const linksGrid = document.createElement('div');
        linksGrid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px;';

        [
            { title: 'OpenAPI Spec (Swagger)', desc: 'Interactive API explorer with all endpoints', href: '/docs' },
            { title: 'Integrations', desc: 'Framework-specific setup guides', page: 'integrations' },
            { title: 'Settings', desc: 'Configure scanning, modes, and providers', page: 'settings' },
        ].forEach(link => {
            const item = document.createElement('div');
            item.style.cssText = 'padding: 12px 14px; background: var(--bg-secondary); border-radius: 8px; cursor: pointer; transition: border-color 0.15s; border: 1px solid var(--border-color);';

            item.addEventListener('mouseenter', () => { item.style.borderColor = 'var(--accent-primary)'; });
            item.addEventListener('mouseleave', () => { item.style.borderColor = 'var(--border-color)'; });

            const titleEl = document.createElement('div');
            titleEl.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--accent-primary); margin-bottom: 2px;';
            titleEl.textContent = link.title;
            item.appendChild(titleEl);

            const descEl = document.createElement('div');
            descEl.style.cssText = 'font-size: 11px; color: var(--text-secondary);';
            descEl.textContent = link.desc;
            item.appendChild(descEl);

            if (link.page) {
                item.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate(link.page); });
            } else if (link.href) {
                item.addEventListener('click', () => { window.open(link.href, '_blank'); });
            }

            linksGrid.appendChild(item);
        });

        frag.appendChild(linksGrid);
        return frag;
    },

    // === Helpers ===

    createBulletList(items) {
        const list = document.createElement('div');
        list.style.cssText = 'display: grid; gap: 3px;';
        items.forEach(text => {
            const item = document.createElement('div');
            item.style.cssText = 'font-size: 12px; color: var(--text-secondary); padding-left: 12px; position: relative; line-height: 1.4;';

            const bullet = document.createElement('span');
            bullet.style.cssText = 'position: absolute; left: 0; color: var(--accent-primary);';
            bullet.textContent = '\u2022';
            item.appendChild(bullet);

            item.appendChild(document.createTextNode(text));
            list.appendChild(item);
        });
        return list;
    },

    createExampleBox(title, scenario, steps, flow) {
        const box = document.createElement('div');
        box.style.cssText = 'background: var(--bg-secondary); border-radius: 8px; padding: 14px 16px; margin-bottom: 10px;';

        const titleEl = document.createElement('div');
        titleEl.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--text-primary); margin-bottom: 4px;';
        titleEl.textContent = title;
        box.appendChild(titleEl);

        const desc = document.createElement('div');
        desc.style.cssText = 'font-size: 12px; color: var(--text-secondary); margin-bottom: 10px; line-height: 1.4;';
        desc.textContent = scenario;
        box.appendChild(desc);

        if (Array.isArray(steps)) {
            const ol = document.createElement('ol');
            ol.style.cssText = 'margin: 0; padding-left: 18px; font-size: 12px; color: var(--text-secondary); line-height: 1.6;';
            steps.forEach(text => {
                const li = document.createElement('li');
                li.style.cssText = 'margin-bottom: 2px;';
                li.textContent = text;
                ol.appendChild(li);
            });
            box.appendChild(ol);
        } else {
            box.appendChild(this.createCodeBlock(steps));
        }

        if (flow) {
            const flowEl = document.createElement('div');
            flowEl.style.cssText = 'margin-top: 8px; font-size: 11px; color: var(--text-secondary); font-family: monospace; padding: 6px 10px; background: var(--bg-tertiary); border-radius: 4px; text-align: center;';
            flowEl.textContent = flow;
            box.appendChild(flowEl);
        }

        return box;
    },

    createMiniStep(number, title, description) {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display: flex; gap: 12px; margin-bottom: 4px;';

        const num = document.createElement('span');
        num.style.cssText = 'width: 26px; height: 26px; background: var(--accent-primary); color: white; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; flex-shrink: 0; margin-top: 1px;';
        num.textContent = number;
        wrapper.appendChild(num);

        const textDiv = document.createElement('div');

        const titleEl = document.createElement('div');
        titleEl.style.cssText = 'font-weight: 600; font-size: 14px; color: var(--text-primary); margin-bottom: 2px;';
        titleEl.textContent = title;
        textDiv.appendChild(titleEl);

        const descEl = document.createElement('div');
        descEl.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.4;';
        descEl.textContent = description;
        textDiv.appendChild(descEl);

        wrapper.appendChild(textDiv);
        return wrapper;
    },

    createCodeBlock(code) {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'position: relative;';

        const pre = document.createElement('pre');
        pre.style.cssText = 'background: var(--bg-tertiary); padding: 10px 14px; padding-right: 60px; border-radius: 6px; overflow-x: auto; font-size: 11px; line-height: 1.5; margin: 0; border: 1px solid var(--border-color);';

        const codeEl = document.createElement('code');
        codeEl.style.cssText = 'color: var(--text-primary); font-family: monospace; white-space: pre;';
        codeEl.textContent = code;
        pre.appendChild(codeEl);

        const copyBtn = document.createElement('button');
        copyBtn.style.cssText = 'position: absolute; top: 6px; right: 6px; padding: 2px 8px; font-size: 10px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 3px; color: var(--text-secondary); cursor: pointer;';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(code).then(() => {
                copyBtn.textContent = 'Copied!';
                copyBtn.style.color = 'var(--success, #10b981)';
                setTimeout(() => {
                    copyBtn.textContent = 'Copy';
                    copyBtn.style.color = 'var(--text-secondary)';
                }, 2000);
            });
        });

        wrapper.appendChild(pre);
        wrapper.appendChild(copyBtn);
        return wrapper;
    },
};

window.GettingStartedPage = GettingStartedPage;
