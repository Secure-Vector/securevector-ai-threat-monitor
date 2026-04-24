/**
 * Getting Started Page
 * All sections are collapsible, collapsed by default
 */

const GettingStartedPage = {
    async render(container) {
        container.textContent = '';

        if (window.Header) Header.setPageInfo('Guide', 'Everything you need to protect your AI agents.');

        // === Welcome hero ===
        container.appendChild(this.buildWelcomeHero());

        // === SECTIONS (all collapsible, collapsed by default) ===

        container.appendChild(this.createCollapsibleCard(
            'Getting Started', 'No code changes — just set an environment variable',
            'section-getting-started', () => this.buildProxyContent()
        ));


        container.appendChild(this.createCollapsibleCard(
            'How Detection Works', 'Input/output scanning, threat modes, and AI analysis',
            'section-scanning', () => this.buildDetectionContent()
        ));

        container.appendChild(this.createCollapsibleCard(
            'Cloud Mode (Optional)', 'Multi-stage ML-powered analysis',
            'section-cloud', () => this.buildCloudContent()
        ));

        container.appendChild(this.createCollapsibleCard(
            'Tool Permissions', 'Control which tools agents are allowed to call',
            'section-tool-permissions', () => this.buildToolPermissionsContent(), true
        ));

        container.appendChild(this.createCollapsibleCard(
            'Cost Tracking', 'Track LLM token spend and set daily budget limits',
            'section-costs', () => this.buildCostIntelligenceContent(), true
        ));

        container.appendChild(this.createCollapsibleCard(
            'SIEM Forwarder', 'Forward OCSF events to Splunk, Datadog, Sentinel, Chronicle, QRadar, or any HTTPS webhook',
            'section-siem-forwarder', () => this.buildSiemForwarderContent()
        ));

        container.appendChild(this.createCollapsibleCard(
            'Skill Scanner', 'Static security analysis for skill directories',
            'section-skill-scanner', () => this.buildSkillScannerContent()
        ));

        container.appendChild(this.createCollapsibleCard(
            'API Reference', 'REST API and interactive documentation',
            'section-api', () => this.buildAPIContent()
        ));

        container.appendChild(this.createCollapsibleCard(
            'Troubleshooting', 'Common issues and how to fix them',
            'section-troubleshooting', () => this.buildTroubleshootingContent()
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

    // === Welcome hero ===

    buildWelcomeHero() {
        const hero = document.createElement('div');
        hero.style.cssText = 'background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 10px; padding: 20px; margin-bottom: 16px;';

        const title = document.createElement('div');
        title.style.cssText = 'font-size: 20px; font-weight: 800; color: var(--text-primary); margin-bottom: 4px;';
        title.textContent = 'Welcome to SecureVector';
        hero.appendChild(title);

        const subtitle = document.createElement('div');
        subtitle.style.cssText = 'font-size: 14px; color: var(--text-primary); line-height: 1.7; margin-bottom: 20px;';
        subtitle.textContent = 'SecureVector is a local security proxy for your AI agents. It sits between your agent and the LLM, scanning every request and response for threats, tracking costs, and monitoring tool usage.';
        hero.appendChild(subtitle);

        // Proxy status bar
        const proxyBar = document.createElement('div');
        proxyBar.style.cssText = 'padding: 14px 18px; background: var(--bg-secondary); border: 1px solid rgba(94,173,184,0.3); border-radius: 8px; margin-bottom: 20px;';

        const proxyStatus = document.createElement('div');
        proxyStatus.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 10px;';
        const proxyDot = document.createElement('span');
        proxyDot.style.cssText = 'width: 7px; height: 7px; border-radius: 50%; background: #10b981; flex-shrink: 0;';
        const proxyLabel = document.createElement('span');
        proxyLabel.style.cssText = 'font-size: 14px; font-weight: 700; color: var(--success-text);';
        proxyLabel.textContent = 'Proxy is running';
        proxyStatus.appendChild(proxyDot);
        proxyStatus.appendChild(proxyLabel);
        proxyBar.appendChild(proxyStatus);

        const featureList = document.createElement('div');
        featureList.style.cssText = 'display: flex; flex-wrap: wrap; gap: 6px 16px; margin-bottom: 12px;';
        ['Threat Detection', 'Cost Tracking', 'Tool Monitoring'].forEach(f => {
            const tag = document.createElement('span');
            tag.style.cssText = 'font-size: 12px; color: var(--text-secondary); display: flex; align-items: center; gap: 5px;';
            const check = document.createElement('span');
            check.style.cssText = 'color: var(--success-text); font-size: 10px;';
            check.textContent = '\u2713';
            tag.appendChild(check);
            tag.appendChild(document.createTextNode(f));
            featureList.appendChild(tag);
        });
        proxyBar.appendChild(featureList);
        hero.appendChild(proxyBar);

        // OpenClaw promo banner — native plugin, no proxy needed
        const ocBanner = document.createElement('div');
        ocBanner.style.cssText = 'display: flex; align-items: center; gap: 14px; padding: 12px 16px; background: linear-gradient(90deg, rgba(94,173,184,0.10) 0%, rgba(94,173,184,0.04) 100%); border: 1px solid rgba(94,173,184,0.35); border-radius: 8px; margin-bottom: 20px; cursor: pointer; transition: border-color 0.15s;';
        ocBanner.addEventListener('mouseenter', () => { ocBanner.style.borderColor = 'rgba(94,173,184,0.6)'; });
        ocBanner.addEventListener('mouseleave', () => { ocBanner.style.borderColor = 'rgba(94,173,184,0.35)'; });
        ocBanner.addEventListener('click', () => {
            if (window.Sidebar) { Sidebar.expandSection('integrations'); Sidebar.navigate('proxy-openclaw'); }
        });

        const ocIcon = document.createElement('div');
        ocIcon.style.cssText = 'flex-shrink: 0; width: 32px; height: 32px; background: rgba(94,173,184,0.15); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 16px;';
        ocIcon.textContent = '\u26A1';
        ocBanner.appendChild(ocIcon);

        const ocText = document.createElement('div');
        ocText.style.cssText = 'flex: 1; min-width: 0;';
        const ocTitle = document.createElement('div');
        ocTitle.style.cssText = 'font-size: 13px; font-weight: 700; color: var(--text-primary); margin-bottom: 2px;';
        ocTitle.textContent = 'Using OpenClaw? Skip the proxy.';
        ocText.appendChild(ocTitle);
        const ocDesc = document.createElement('div');
        ocDesc.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.4;';
        ocDesc.textContent = 'Install the native SecureVector Guard plugin \u2014 zero latency, no env vars, no proxy restart. Monitoring starts the moment OpenClaw reloads.';
        ocText.appendChild(ocDesc);
        ocBanner.appendChild(ocText);

        const ocCta = document.createElement('div');
        ocCta.style.cssText = 'flex-shrink: 0; font-size: 12px; font-weight: 700; color: var(--accent-primary); white-space: nowrap;';
        ocCta.textContent = 'Install plugin \u2192';
        ocBanner.appendChild(ocCta);

        hero.appendChild(ocBanner);

        // SIEM Forwarder promo banner — same visual pattern as the
        // OpenClaw nudge above, pointing at the v4.0 Connect feature.
        // Clickable card that expands Connect section + navigates.
        const siemBanner = document.createElement('div');
        siemBanner.style.cssText = 'display: flex; align-items: center; gap: 14px; padding: 12px 16px; background: linear-gradient(90deg, rgba(16,185,129,0.10) 0%, rgba(16,185,129,0.04) 100%); border: 1px solid rgba(16,185,129,0.35); border-radius: 8px; margin-bottom: 20px; cursor: pointer; transition: border-color 0.15s;';
        siemBanner.addEventListener('mouseenter', () => { siemBanner.style.borderColor = 'rgba(16,185,129,0.6)'; });
        siemBanner.addEventListener('mouseleave', () => { siemBanner.style.borderColor = 'rgba(16,185,129,0.35)'; });
        siemBanner.addEventListener('click', () => {
            if (window.Sidebar) { Sidebar.expandSection('integrations'); Sidebar.navigate('siem-export'); }
        });

        const siemIcon = document.createElement('div');
        siemIcon.style.cssText = 'flex-shrink: 0; width: 32px; height: 32px; background: rgba(16,185,129,0.15); border-radius: 8px; display: flex; align-items: center; justify-content: center; color: #10b981;';
        // Outline arrow-up-right — "send to external system"
        siemIcon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17l10-10"/><path d="M8 7h9v9"/></svg>';
        siemBanner.appendChild(siemIcon);

        const siemText = document.createElement('div');
        siemText.style.cssText = 'flex: 1; min-width: 0;';
        const siemTitle = document.createElement('div');
        siemTitle.style.cssText = 'font-size: 13px; font-weight: 700; color: var(--text-primary); margin-bottom: 2px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;';
        const siemTitleText = document.createElement('span');
        siemTitleText.textContent = 'Forward threats + tool audits to your SIEM';
        siemTitle.appendChild(siemTitleText);
        const siemPill = document.createElement('span');
        siemPill.style.cssText = 'font-size: 9.5px; font-weight: 700; letter-spacing: 0.5px; color: #10b981; background: rgba(16,185,129,0.12); border: 1px solid rgba(16,185,129,0.3); padding: 2px 6px; border-radius: 4px; text-transform: uppercase;';
        siemPill.textContent = 'New · v4.0';
        siemTitle.appendChild(siemPill);
        siemText.appendChild(siemTitle);
        const siemDesc = document.createElement('div');
        siemDesc.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.4;';
        siemDesc.textContent = 'OCSF 1.3.0 events to Splunk, Datadog, Sentinel, Chronicle, QRadar, OTLP — or a local NDJSON file. Metadata-only by default; raw data opt-in per destination.';
        siemText.appendChild(siemDesc);
        siemBanner.appendChild(siemText);

        const siemCta = document.createElement('div');
        siemCta.style.cssText = 'flex-shrink: 0; font-size: 12px; font-weight: 700; color: #10b981; white-space: nowrap;';
        siemCta.textContent = 'Open SIEM Forwarder \u2192';
        siemBanner.appendChild(siemCta);

        hero.appendChild(siemBanner);

        // Two action cards — matching the popup structure
        const columns = document.createElement('div');
        columns.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; min-width: 0;';

        // Shared env var value
        const envValue = `OPENAI_BASE_URL=http://localhost:${window.__SV_PROXY_PORT || 8742}/openai/v1`;

        // --- LEFT: Set up your integration ---
        const setupBox = document.createElement('div');
        setupBox.style.cssText = 'background: var(--bg-secondary); border-radius: 8px; padding: 16px; border: 1px solid var(--border-default); min-width: 0; cursor: pointer; transition: border-color 0.15s; overflow: hidden;';
        setupBox.addEventListener('mouseenter', () => setupBox.style.borderColor = 'rgba(94,173,184,0.3)');
        setupBox.addEventListener('mouseleave', () => setupBox.style.borderColor = 'var(--border-default)');
        setupBox.addEventListener('click', () => { if (window.Sidebar) { Sidebar.expandSection('integrations'); Sidebar.navigate('proxy-openclaw'); } });

        const setupTitle = document.createElement('div');
        setupTitle.style.cssText = 'font-size: 14px; font-weight: 700; color: var(--text-primary); margin-bottom: 6px;';
        setupTitle.textContent = 'Set up your integration';
        setupBox.appendChild(setupTitle);

        const setupDesc = document.createElement('div');
        setupDesc.style.cssText = 'font-size: 13px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 10px;';
        setupDesc.textContent = 'Point your agent\u2019s base URL to the proxy. Step-by-step setup for each framework.';
        setupBox.appendChild(setupDesc);

        const codeWrap = document.createElement('div');
        codeWrap.style.cssText = 'display: flex; align-items: center; background: var(--bg-tertiary); border-radius: 4px; margin-bottom: 10px; min-width: 0;';
        const codeText = document.createElement('div');
        codeText.style.cssText = 'font-size: 11px; font-family: monospace; color: var(--accent-primary); padding: 6px 10px; word-break: break-all; flex: 1; min-width: 0;';
        codeText.textContent = envValue;
        const copyBtn = document.createElement('button');
        copyBtn.style.cssText = 'background: none; border: none; color: var(--text-muted); cursor: pointer; padding: 6px 8px; font-size: 11px; flex-shrink: 0; transition: color 0.15s;';
        copyBtn.textContent = 'Copy';
        copyBtn.title = 'Copy to clipboard';
        copyBtn.addEventListener('mouseenter', () => copyBtn.style.color = 'var(--accent-primary)');
        copyBtn.addEventListener('mouseleave', () => copyBtn.style.color = 'var(--text-muted)');
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(envValue).then(() => {
                copyBtn.textContent = 'Copied!';
                copyBtn.style.color = '#10b981';
                setTimeout(() => { copyBtn.textContent = 'Copy'; copyBtn.style.color = 'var(--text-muted)'; }, 1500);
            });
        });
        codeWrap.appendChild(codeText);
        codeWrap.appendChild(copyBtn);
        setupBox.appendChild(codeWrap);

        const setupLink = document.createElement('span');
        setupLink.style.cssText = 'font-size: 12px; font-weight: 600; color: var(--accent-primary);';
        setupLink.textContent = 'LangChain \u00b7 CrewAI \u00b7 OpenClaw \u00b7 Ollama \u00b7 more \u2192';
        setupBox.appendChild(setupLink);

        // --- RIGHT: Skill Scanner ---
        const scanBox = document.createElement('div');
        scanBox.style.cssText = 'background: var(--bg-secondary); border-radius: 8px; padding: 16px; border: 1px solid var(--border-default); min-width: 0; cursor: pointer; transition: border-color 0.15s; overflow: hidden;';
        scanBox.addEventListener('mouseenter', () => scanBox.style.borderColor = 'rgba(94,173,184,0.3)');
        scanBox.addEventListener('mouseleave', () => scanBox.style.borderColor = 'var(--border-default)');
        scanBox.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate('skill-scanner'); });

        const scanTitle = document.createElement('div');
        scanTitle.style.cssText = 'font-size: 14px; font-weight: 700; color: var(--text-primary); margin-bottom: 6px;';
        scanTitle.textContent = 'Scan a skill before you install it';
        scanBox.appendChild(scanTitle);

        const scanDesc = document.createElement('div');
        scanDesc.style.cssText = 'font-size: 13px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 10px;';
        scanDesc.textContent = 'Check any skill for risky patterns \u2014 network calls, shell commands, file writes \u2014 before adding it to your agent.';
        scanBox.appendChild(scanDesc);

        const scanLink = document.createElement('span');
        scanLink.style.cssText = 'font-size: 12px; font-weight: 600; color: var(--accent-primary);';
        scanLink.textContent = 'Open Skill Scanner \u2192';
        scanBox.appendChild(scanLink);

        columns.appendChild(setupBox);
        columns.appendChild(scanBox);
        hero.appendChild(columns);
        return hero;
    },

    // === Collapsible card wrapper ===

    createCollapsibleCard(title, subtitle, sectionId, contentBuilder, isNew = false) {
        const card = document.createElement('div');
        card.className = 'card';
        card.id = sectionId;
        card.style.cssText = 'padding: 0; overflow: hidden; margin-bottom: 12px;' + (isNew ? ' border-color: rgba(94,173,184,0.35);' : '');

        // Clickable header
        const header = document.createElement('div');
        header.style.cssText = 'padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; cursor: pointer; user-select: none; transition: background 0.15s;';
        header.addEventListener('mouseenter', () => { header.style.background = 'rgba(94, 173, 184, 0.04)'; });
        header.addEventListener('mouseleave', () => { header.style.background = ''; });

        const headerLeft = document.createElement('div');
        const titleRow = document.createElement('div');
        titleRow.style.cssText = 'display: flex; align-items: center; gap: 8px;';
        const headerTitle = document.createElement('div');
        headerTitle.style.cssText = 'font-weight: 700; font-size: 15px; color: var(--text-primary);';
        headerTitle.textContent = title;
        titleRow.appendChild(headerTitle);
        if (isNew) {
            const badge = document.createElement('span');
            badge.style.cssText = 'font-size: 8px; font-weight: 700; padding: 1px 5px; border-radius: 3px; background: rgba(94,173,184,0.15); color: var(--accent-primary); letter-spacing:0.5px; line-height:1.6;';
            badge.textContent = 'NEW';
            titleRow.appendChild(badge);
        }
        headerLeft.appendChild(titleRow);

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

        // Default state note
        const defaultNote = document.createElement('div');
        defaultNote.style.cssText = 'padding: 10px 14px; background: var(--bg-secondary); border-radius: 6px; font-size: 13px; color: var(--text-secondary); border-left: 3px solid var(--accent-primary); margin-bottom: 20px; line-height: 1.5;';
        const defaultStrong = document.createElement('strong');
        defaultStrong.style.color = 'var(--text-primary)';
        defaultStrong.textContent = 'The OpenClaw proxy runs by default ';
        defaultNote.appendChild(defaultStrong);
        defaultNote.appendChild(document.createTextNode('when SecureVector starts. Choose your path below:'));
        frag.appendChild(defaultNote);

        // Two-path layout
        const paths = document.createElement('div');
        paths.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-bottom: 20px;';

        // Path A: Using OpenClaw
        const pathA = document.createElement('div');
        pathA.style.cssText = 'padding: 16px; background: var(--bg-secondary); border-radius: 8px; border-top: 3px solid var(--accent-primary); display: flex; flex-direction: column; gap: 10px;';

        const pathATitle = document.createElement('div');
        pathATitle.style.cssText = 'font-weight: 700; font-size: 14px; color: var(--text-primary);';
        pathATitle.textContent = 'Using OpenClaw or ClawdBot';
        pathA.appendChild(pathATitle);

        const pathADesc = document.createElement('div');
        pathADesc.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.5;';
        pathADesc.textContent = 'The SecureVector proxy is already running for OpenClaw. Now start the OpenClaw gateway and point it at SecureVector.';
        pathA.appendChild(pathADesc);

        const pathASteps = document.createElement('ol');
        pathASteps.style.cssText = 'margin: 0; padding-left: 18px; font-size: 12px; color: var(--text-secondary); line-height: 1.7; display: flex; flex-direction: column; gap: 2px;';
        [
            'Open the OpenClaw integration page below',
            'Follow from Step\u00a02 (Set environment variables) in another terminal to configure and start the OpenClaw gateway',
            'Your traffic will route: OpenClaw \u2192 SecureVector (scans) \u2192 Claude',
        ].forEach(text => {
            const li = document.createElement('li');
            li.textContent = text;
            pathASteps.appendChild(li);
        });
        pathA.appendChild(pathASteps);

        const openClawBtn = document.createElement('button');
        openClawBtn.className = 'btn btn-primary';
        openClawBtn.style.cssText = 'font-size: 12px; padding: 6px 14px; align-self: flex-start; margin-top: 4px;';
        openClawBtn.textContent = 'Open OpenClaw Integration \u2192';
        openClawBtn.addEventListener('click', () => {
            if (window.Sidebar) Sidebar.expandSection('integrations');
            setTimeout(() => {
                const el = document.querySelector('[data-integration="openclaw"]');
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 200);
        });
        pathA.appendChild(openClawBtn);
        paths.appendChild(pathA);

        // Path B: Different framework
        const pathB = document.createElement('div');
        pathB.style.cssText = 'padding: 16px; background: var(--bg-secondary); border-radius: 8px; border-top: 3px solid var(--border-color); display: flex; flex-direction: column; gap: 10px;';

        const pathBTitle = document.createElement('div');
        pathBTitle.style.cssText = 'font-weight: 700; font-size: 14px; color: var(--text-primary);';
        pathBTitle.textContent = 'Using Another Framework';
        pathB.appendChild(pathBTitle);

        const pathBDesc = document.createElement('div');
        pathBDesc.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.5;';
        pathBDesc.textContent = 'Go to Integrations, select your framework (LangChain, CrewAI, Ollama, n8n…), and start its proxy. If a proxy is already running, stop it first.';
        pathB.appendChild(pathBDesc);

        const pathBSteps = document.createElement('ol');
        pathBSteps.style.cssText = 'margin: 0; padding-left: 18px; font-size: 12px; color: var(--text-secondary); line-height: 1.7; display: flex; flex-direction: column; gap: 2px;';
        [
            'Open Integrations \u2192 stop any running proxy',
            'Select your agent framework and LLM provider',
            'Click Start Proxy and follow the on-screen env var instructions',
        ].forEach(text => {
            const li = document.createElement('li');
            li.textContent = text;
            pathBSteps.appendChild(li);
        });
        pathB.appendChild(pathBSteps);

        const intBtn = document.createElement('button');
        intBtn.className = 'btn btn-secondary';
        intBtn.style.cssText = 'font-size: 12px; padding: 6px 14px; align-self: flex-start; margin-top: 4px;';
        intBtn.textContent = 'Open Integrations \u2192';
        intBtn.addEventListener('click', () => {
            if (window.Sidebar) Sidebar.navigate('proxy-openclaw');
        });
        pathB.appendChild(intBtn);
        paths.appendChild(pathB);

        frag.appendChild(paths);

        const doneNote = document.createElement('div');
        doneNote.style.cssText = 'padding: 10px 14px; background: var(--bg-secondary); border-radius: 6px; font-size: 12px; color: var(--text-secondary); border-left: 3px solid var(--accent-primary); margin-bottom: 20px;';
        doneNote.textContent = 'Once your proxy is running and your agent is connected, all LLM traffic is scanned for prompt injection and data leaks automatically.';
        frag.appendChild(doneNote);

        // Examples
        const examplesTitle = document.createElement('div');
        examplesTitle.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--text-primary); margin-bottom: 10px;';
        examplesTitle.textContent = 'Examples';
        frag.appendChild(examplesTitle);

        frag.appendChild(this.createExampleBox(
            'OpenClaw + Telegram',
            'You run OpenClaw as a Claude-powered gateway agent. Users chat with your bot on Telegram. SecureVector sits between OpenClaw and Claude, scanning every message for prompt injection before it reaches the LLM.',
            [
                'OpenClaw integration page \u2192 SecureVector proxy is already running',
                'Follow Step\u00a02 onwards: set environment variables in a new terminal',
                ['Start OpenClaw pointing to SecureVector: ', { copy: 'ANTHROPIC_BASE_URL=http://localhost:8742' }],
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
                'Stop any running proxy, then click Start Proxy',
                ['In Open WebUI: Settings \u2192 Connections \u2192 set Ollama URL to ', { copy: 'http://localhost:8742/ollama' }],
                'Send a chat message to test',
            ],
            'Open WebUI \u2192 SecureVector (scans) \u2192 Ollama'
        ));

        return frag;
    },

    buildDetectionContent() {
        const frag = document.createElement('div');
        frag.style.cssText = 'padding-top: 16px; display: flex; flex-direction: column; gap: 20px;';

        // Section 1: Input & Output scanning
        const scanDesc = document.createElement('p');
        scanDesc.style.cssText = 'color: var(--text-secondary); margin: 0; font-size: 13px; line-height: 1.5;';
        scanDesc.textContent = 'SecureVector scans traffic in both directions. Input scanning runs on every request by default. Output scanning is optional and can be toggled from the header.';
        frag.appendChild(scanDesc);

        const scanGrid = document.createElement('div');
        scanGrid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px;';

        const inputCol = document.createElement('div');
        inputCol.style.cssText = 'padding: 14px; background: var(--bg-secondary); border-radius: 8px; border-top: 3px solid var(--accent-primary);';
        const inputTitle = document.createElement('div');
        inputTitle.style.cssText = 'font-weight: 700; font-size: 13px; color: var(--text-primary); margin-bottom: 8px;';
        inputTitle.textContent = 'Input Scanning (User \u2192 LLM)';
        inputCol.appendChild(inputTitle);
        inputCol.appendChild(this.createBulletList(['Prompt injection', 'Jailbreak attempts', 'Data exfiltration requests', 'Social engineering']));
        scanGrid.appendChild(inputCol);

        const outputCol = document.createElement('div');
        outputCol.style.cssText = 'padding: 14px; background: var(--bg-secondary); border-radius: 8px; border-top: 3px solid var(--accent-secondary, #c0655e);';
        const outputTitle = document.createElement('div');
        outputTitle.style.cssText = 'font-weight: 700; font-size: 13px; color: var(--text-primary); margin-bottom: 8px;';
        outputTitle.textContent = 'Output Scanning (LLM \u2192 User)';
        outputCol.appendChild(outputTitle);
        outputCol.appendChild(this.createBulletList(['Credential leakage (API keys, tokens)', 'System prompt exposure', 'PII disclosure (SSN, credit cards)', 'Encoded malicious content']));
        scanGrid.appendChild(outputCol);
        frag.appendChild(scanGrid);

        // Section 2: Threat modes (inline)
        const modesGrid = document.createElement('div');
        modesGrid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px;';

        const blockBox = document.createElement('div');
        blockBox.style.cssText = 'padding: 14px; background: var(--bg-secondary); border-radius: 8px; border-left: 3px solid var(--accent-secondary, #c0655e);';
        const blockTitle = document.createElement('div');
        blockTitle.style.cssText = 'font-weight: 700; font-size: 13px; color: var(--text-primary); margin-bottom: 4px;';
        blockTitle.textContent = 'Block Mode (Default)';
        blockBox.appendChild(blockTitle);
        const blockDesc = document.createElement('div');
        blockDesc.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.4;';
        blockDesc.textContent = 'Threats are actively blocked before reaching LLM or client. All threats are still logged.';
        blockBox.appendChild(blockDesc);
        modesGrid.appendChild(blockBox);

        const logBox = document.createElement('div');
        logBox.style.cssText = 'padding: 14px; background: var(--bg-secondary); border-radius: 8px; border-left: 3px solid var(--accent-primary);';
        const logTitle = document.createElement('div');
        logTitle.style.cssText = 'font-weight: 700; font-size: 13px; color: var(--text-primary); margin-bottom: 4px;';
        logTitle.textContent = 'Log Mode';
        logBox.appendChild(logTitle);
        const logDesc = document.createElement('div');
        logDesc.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.4;';
        logDesc.textContent = 'Threats are detected and recorded but traffic is not interrupted. Good for initial monitoring.';
        logBox.appendChild(logDesc);
        modesGrid.appendChild(logBox);
        frag.appendChild(modesGrid);

        // Section 3: Two-stage detection (AI Analysis)
        const aiDesc = document.createElement('p');
        aiDesc.style.cssText = 'color: var(--text-secondary); margin: 0; font-size: 13px; line-height: 1.5;';
        aiDesc.textContent = 'Two-stage pipeline: Stage 1 (pattern matching, <5ms, always active) + Stage 2 (optional AI Analysis via secondary LLM, 1-3s, reduces false positives). Enable AI Analysis from the header bar.';
        frag.appendChild(aiDesc);

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
        outputCol.style.cssText = 'padding: 14px; background: var(--bg-secondary); border-radius: 8px; border-top: 3px solid var(--accent-secondary, #c0655e);';

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
        blockBox.style.cssText = 'padding: 14px; background: var(--bg-secondary); border-radius: 8px; border-left: 3px solid var(--accent-secondary, #c0655e);';

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
        desc.textContent = 'Optionally connect to SecureVector Cloud for multi-stage ML-powered analysis designed to minimize false positives through proprietary threat intelligence. When enabled, scans are routed to the cloud API and results appear in a centralized dashboard in your account.';
        frag.appendChild(desc);

        frag.appendChild(this.createBulletList(['**Advanced ML-powered threat detection beyond regex**', 'Centralized dashboard at app.securevector.io', '**Industry-specific rule creation**', '**Notification system for webhook and email alerts**', 'Replaces local AI Analysis when active', 'Falls back to local analysis if cloud is unreachable']));

        const stepsWrapper = document.createElement('div');
        stepsWrapper.className = 'cloud-steps';
        stepsWrapper.style.cssText = 'margin-top: 14px;';

        [
            { num: '1', title: 'Create Account', desc: ['Sign up at ', { copy: 'app.securevector.io' }, ' (free tier available)'] },
            { num: '2', title: 'Get API Key', desc: 'Go to Access Management, accept the Terms of Service and Privacy Policy, then create a new API key' },
            { num: '3', title: 'Add Key', desc: ['Go to ', { copy: 'localhost/settings' }, ' and add the key you just created on ', { copy: 'app.securevector.io' }] },
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
            if (Array.isArray(step.desc)) {
                step.desc.forEach(part => {
                    if (typeof part === 'string') {
                        descEl.appendChild(document.createTextNode(part));
                    } else if (part && part.copy) {
                        descEl.appendChild(this.createInlineCopy(part.copy));
                    }
                });
            } else {
                descEl.textContent = step.desc;
            }
            textEl.appendChild(descEl);

            stepEl.appendChild(textEl);
            stepsWrapper.appendChild(stepEl);
        });

        frag.appendChild(stepsWrapper);
        return frag;
    },

    buildToolPermissionsContent() {
        const frag = document.createElement('div');
        frag.style.cssText = 'padding-top: 16px;';

        const desc = document.createElement('p');
        desc.style.cssText = 'color: var(--text-secondary); margin: 0 0 16px 0; font-size: 13px; line-height: 1.5;';
        desc.textContent = 'Tool Permissions lets you control exactly which tools (function calls) your AI agents are allowed to invoke. Set allow or deny rules per tool, per agent \u2014 so agents can only call what they need.';
        frag.appendChild(desc);

        const grid = document.createElement('div');
        grid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin-bottom: 16px;';

        const allowBox = document.createElement('div');
        allowBox.style.cssText = 'padding: 14px; background: var(--bg-secondary); border-radius: 8px; border-left: 3px solid #10b981;';
        const allowTitle = document.createElement('div');
        allowTitle.style.cssText = 'font-weight: 700; font-size: 13px; color: var(--text-primary); margin-bottom: 6px;';
        allowTitle.textContent = 'Allowlist Mode';
        allowBox.appendChild(allowTitle);
        allowBox.appendChild(this.createBulletList([
            'Only explicitly listed tools can be called',
            'Everything else is blocked by default',
            'Best for production agents with known tool sets',
            'Prevents agents calling unexpected APIs',
        ]));
        grid.appendChild(allowBox);

        const denyBox = document.createElement('div');
        denyBox.style.cssText = 'padding: 14px; background: var(--bg-secondary); border-radius: 8px; border-left: 3px solid #f59e0b;';
        const denyTitle = document.createElement('div');
        denyTitle.style.cssText = 'font-weight: 700; font-size: 13px; color: var(--text-primary); margin-bottom: 6px;';
        denyTitle.textContent = 'Denylist Mode';
        denyBox.appendChild(denyTitle);
        denyBox.appendChild(this.createBulletList([
            'All tools allowed except explicitly listed ones',
            'Useful for blocking dangerous tools (shell exec, file write)',
            'Lower friction during development',
            'Easy to add exceptions without listing all tools',
        ]));
        grid.appendChild(denyBox);

        frag.appendChild(grid);

        const stepsTitle = document.createElement('div');
        stepsTitle.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--text-primary); margin-bottom: 10px;';
        stepsTitle.textContent = 'How to configure';
        frag.appendChild(stepsTitle);

        frag.appendChild(this.createMiniStep('1', 'Open Tool Permissions', 'Navigate to Tool Permissions in the sidebar.'));
        frag.appendChild(this.createMiniStep('2', 'Add rules', 'Click "\u002b Add Rule" and enter the tool name (e.g. run_python, search_web). Set the action to Allow or Deny.'));
        frag.appendChild(this.createMiniStep('3', 'Set default', 'Choose the default action for tools not in your list \u2014 "Allow all" or "Block all".'));

        const tpBtn = document.createElement('button');
        tpBtn.className = 'btn btn-primary';
        tpBtn.style.cssText = 'font-size: 12px; margin: 12px 0 0 42px; padding: 6px 14px;';
        tpBtn.textContent = 'Open Tool Permissions';
        tpBtn.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate('tool-permissions'); });
        frag.appendChild(tpBtn);

        // === Tool Activity: allow vs block vs log_only ===
        const activityAnchor = document.createElement('div');
        activityAnchor.id = 'section-tool-activity';
        activityAnchor.style.cssText = 'margin-top: 28px; padding-top: 20px; border-top: 1px solid var(--border-default);';
        frag.appendChild(activityAnchor);

        const actTitle = document.createElement('div');
        actTitle.style.cssText = 'font-weight: 700; font-size: 14px; color: var(--text-primary); margin-bottom: 6px;';
        actTitle.textContent = 'Tool Activity: allow vs block vs log_only';
        activityAnchor.appendChild(actTitle);

        const actDesc = document.createElement('p');
        actDesc.style.cssText = 'color: var(--text-secondary); margin: 0 0 12px 0; font-size: 13px; line-height: 1.5;';
        actDesc.textContent = 'Every tool call the agent makes is recorded on the Tool Activity tab. The action column reflects the combined decision of the tool\u2019s permission policy and whether block mode is enabled.';
        activityAnchor.appendChild(actDesc);

        // Behavior table
        const table = document.createElement('table');
        table.style.cssText = 'width: 100%; border-collapse: collapse; margin-bottom: 14px; font-size: 12px;';
        const thead = document.createElement('thead');
        const thr = document.createElement('tr');
        ['Tool policy', 'Block mode', 'Recorded action', 'What actually happens'].forEach(h => {
            const th = document.createElement('th');
            th.style.cssText = 'text-align: left; padding: 8px 10px; background: var(--bg-tertiary); border-bottom: 1px solid var(--border-default); color: var(--text-primary); font-weight: 600;';
            th.textContent = h;
            thr.appendChild(th);
        });
        thead.appendChild(thr);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        const rows = [
            ['allow',     'either',       'allow',    'Tool call runs. Logged as allowed.'],
            ['block',     'ON',           'block',    'Proxy rejects the tool call before the LLM sees a result. Gateway log: TOOL BLOCKED.'],
            ['block',     'OFF',          'log_only', 'Tool call still runs. Logged with note "(audit only \u2014 enable proxy to block)".'],
            ['log_only',  'either',       'log_only', 'Tool call runs. Always logged for audit trail.'],
        ];
        const colorMap = { allow: '#10b981', block: '#ef4444', log_only: '#f59e0b' };
        rows.forEach(row => {
            const tr = document.createElement('tr');
            row.forEach((cell, idx) => {
                const td = document.createElement('td');
                td.style.cssText = 'padding: 8px 10px; border-bottom: 1px solid var(--border-default); color: var(--text-secondary); vertical-align: top;';
                if (idx === 2) {
                    const badge = document.createElement('strong');
                    badge.style.color = colorMap[cell] || 'var(--text-primary)';
                    badge.textContent = cell;
                    td.appendChild(badge);
                } else {
                    td.textContent = cell;
                }
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        activityAnchor.appendChild(table);

        const quickGuide = document.createElement('div');
        quickGuide.style.cssText = 'padding: 12px 14px; background: var(--bg-secondary); border-radius: 8px; border-left: 3px solid var(--accent-primary); font-size: 12px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 16px;';
        const qgTitle = document.createElement('strong');
        qgTitle.style.cssText = 'color: var(--text-primary); font-size: 12px;';
        qgTitle.textContent = 'Quick guide';
        quickGuide.appendChild(qgTitle);
        const qgUl = document.createElement('ul');
        qgUl.style.cssText = 'margin: 6px 0 0 18px; padding: 0;';
        [
            'Want a passive audit trail without changing agent behavior? Keep block mode OFF \u2014 everything gets captured as log_only or allow.',
            'Want hard enforcement? Turn block mode ON and start the proxy \u2014 block policies start rejecting tool calls at the proxy layer.',
            'SecureVector ships 66 essential tool definitions (54 default to block). Custom tools can be added per project on the Tool Permissions page.',
        ].forEach(t => {
            const li = document.createElement('li');
            li.style.cssText = 'margin-bottom: 4px;';
            li.textContent = t;
            qgUl.appendChild(li);
        });
        quickGuide.appendChild(qgUl);
        activityAnchor.appendChild(quickGuide);

        // === Which integrations log tool calls? ===
        const whichTitle = document.createElement('div');
        whichTitle.style.cssText = 'font-weight: 700; font-size: 13px; color: var(--text-primary); margin-top: 18px; margin-bottom: 6px;';
        whichTitle.textContent = 'Which integrations log tool calls?';
        activityAnchor.appendChild(whichTitle);

        const whichDesc = document.createElement('p');
        whichDesc.style.cssText = 'color: var(--text-secondary); margin: 0 0 12px 0; font-size: 12px; line-height: 1.5;';
        whichDesc.textContent = 'The allow / block / log_only decision is universal \u2014 it\u2019s SecureVector\u2019s policy engine. Whether a tool call actually lands in the Tool Activity log depends on the path it takes.';
        activityAnchor.appendChild(whichDesc);

        const whichTable = document.createElement('table');
        whichTable.style.cssText = 'width: 100%; border-collapse: collapse; font-size: 12px;';
        const whThead = document.createElement('thead');
        const whThr = document.createElement('tr');
        ['Integration path', 'Logged?', 'Captured by'].forEach(h => {
            const th = document.createElement('th');
            th.style.cssText = 'text-align: left; padding: 8px 10px; background: var(--bg-tertiary); border-bottom: 1px solid var(--border-default); color: var(--text-primary); font-weight: 600;';
            th.textContent = h;
            whThr.appendChild(th);
        });
        whThead.appendChild(whThr);
        whichTable.appendChild(whThead);

        const whTbody = document.createElement('tbody');
        const whichRows = [
            ['OpenClaw / ClawdBot with plugin installed',                          'yes',     'Plugin \u2014 captures MCP tools (read, exec, write) and LLM tool calls'],
            ['LangChain / LangGraph / CrewAI / n8n / direct SDK via proxy',        'yes',     'Proxy \u2014 captures LLM function calls (requires OPENAI_BASE_URL or equivalent pointing at localhost:8742)'],
            ['Direct SDK to provider (no proxy, no plugin)',                       'no',      '\u2014'],
            ['Ollama local calls that bypass both',                                'no',      '\u2014'],
            ['Custom integration',                                                 'optional','POST to /api/tool-permissions/call-audit from your own callback'],
        ];
        whichRows.forEach(row => {
            const tr = document.createElement('tr');
            row.forEach((cell, idx) => {
                const td = document.createElement('td');
                td.style.cssText = 'padding: 8px 10px; border-bottom: 1px solid var(--border-default); color: var(--text-secondary); vertical-align: top;';
                if (idx === 1) {
                    const badge = document.createElement('strong');
                    if (cell === 'yes') { badge.style.color = '#10b981'; badge.textContent = 'Yes'; }
                    else if (cell === 'no') { badge.style.color = '#ef4444'; badge.textContent = 'No'; }
                    else { badge.style.color = '#f59e0b'; badge.textContent = 'Optional'; }
                    td.appendChild(badge);
                } else {
                    td.textContent = cell;
                }
                tr.appendChild(td);
            });
            whTbody.appendChild(tr);
        });
        whichTable.appendChild(whTbody);
        activityAnchor.appendChild(whichTable);

        const whichNote = document.createElement('div');
        whichNote.style.cssText = 'margin-top: 10px; font-size: 11px; color: var(--text-muted); line-height: 1.5;';
        whichNote.textContent = 'OpenClaw users get the richest audit because the plugin also captures MCP-only tools (file reads, shell execs, workspace edits) that never touch the proxy. Other integrations see their function-calling tool calls when traffic routes through the multi-provider proxy.';
        activityAnchor.appendChild(whichNote);

        return frag;
    },

    buildCostIntelligenceContent() {
        const frag = document.createElement('div');
        frag.style.cssText = 'padding-top: 16px;';

        const desc = document.createElement('p');
        desc.style.cssText = 'color: var(--text-secondary); margin: 0 0 14px 0; font-size: 13px; line-height: 1.5;';
        desc.textContent = 'Cost Tracking records every token your agents spend \u2014 automatically, for every provider. See per-request costs, set daily budget limits, and get warned or blocked before bills spiral.';
        frag.appendChild(desc);

        const featureGrid = document.createElement('div');
        featureGrid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin-bottom: 16px;';

        [
            { title: 'Cost Summary', body: 'Total spend, per-provider breakdown, and cost trend across all agents \u2014 updated per request.' },
            { title: 'Request History', body: 'Per-request log: model, input/output tokens, cached token savings, and exact USD cost.' },
            { title: 'Budget Limits', body: 'Set a daily wallet cap (all agents combined) or per-agent limits. Action: warn or block the request.' },
            { title: 'Pricing Reference', body: 'Live pricing for all supported providers and models, with input/output rates per million tokens.' },
        ].forEach(({ title, body }) => {
            const box = document.createElement('div');
            box.style.cssText = 'padding: 12px 14px; background: var(--bg-secondary); border-radius: 8px;';
            const ttl = document.createElement('div');
            ttl.style.cssText = 'font-weight: 700; font-size: 12px; color: var(--text-primary); margin-bottom: 4px;';
            ttl.textContent = title;
            box.appendChild(ttl);
            const bdy = document.createElement('div');
            bdy.style.cssText = 'font-size: 11px; color: var(--text-secondary); line-height: 1.4;';
            bdy.textContent = body;
            box.appendChild(bdy);
            featureGrid.appendChild(box);
        });

        frag.appendChild(featureGrid);

        const providersTitle = document.createElement('div');
        providersTitle.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--text-primary); margin-bottom: 6px;';
        providersTitle.textContent = 'Supported providers';
        frag.appendChild(providersTitle);

        frag.appendChild(this.createBulletList([
            'OpenAI (GPT-4o, o1, o3, GPT-3.5 \u2014 Chat & Responses API)',
            'Anthropic (Claude 3.5/4, Haiku, Sonnet, Opus)',
            'Google (Gemini 1.5/2.0 Flash, Pro, Ultra)',
            'Groq, Mistral, xAI (Grok), DeepSeek, Cerebras',
            'Ollama (local models \u2014 free, $0.00 cost tracked)',
        ]));

        const budgetNote = document.createElement('div');
        budgetNote.style.cssText = 'margin-top: 14px; padding: 10px 14px; background: var(--bg-secondary); border-radius: 6px; font-size: 12px; color: var(--text-secondary); border-left: 3px solid var(--accent-primary); line-height: 1.5;';
        const noteLabel = document.createElement('strong');
        noteLabel.style.cssText = 'color: var(--text-primary);';
        noteLabel.textContent = 'Budget check timing: ';
        budgetNote.appendChild(noteLabel);
        budgetNote.appendChild(document.createTextNode('The proxy checks your daily budget before each request using today\u2019s recorded spend (UTC day). The \u201cTotal Cost\u201d card includes all historical costs \u2014 your daily budget limit is compared against today\u2019s spend only.'));
        frag.appendChild(budgetNote);

        const costsBtn = document.createElement('button');
        costsBtn.className = 'btn btn-primary';
        costsBtn.style.cssText = 'font-size: 12px; margin: 14px 0 0 0; padding: 6px 14px;';
        costsBtn.textContent = 'Open Cost Tracking';
        costsBtn.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate('costs'); });
        frag.appendChild(costsBtn);

        return frag;
    },

    _enterpriseDeploymentSvg() {
        // Standalone SVG showing enterprise deployment topology:
        //   N agent hosts → each runs SecureVector locally → OCSF events
        //   land in ONE enterprise SIEM. No cloud hop via SecureVector.
        //
        // Colors picked to read in both dark and light themes (accent
        // cyan + green + neutral grays). Wrapped in a themed container
        // so the caption inherits --text-muted. Fixed width on desktop;
        // scales down to container on narrow screens.
        return `
<div style="margin:14px 0;padding:14px;background:var(--bg-tertiary);border:1px solid var(--border-default);border-radius:10px;">
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 820 360" role="img" aria-label="Enterprise deployment: agent hosts forward OCSF events to the company SIEM" style="width:100%;height:auto;max-width:820px;display:block;">
    <defs>
      <marker id="svArrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 Z" fill="#5eadb8"/>
      </marker>
      <marker id="svArrowRed" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 Z" fill="#ef4444" opacity="0.5"/>
      </marker>
    </defs>

    <!-- Host cards (left column) -->
    <g font-family="ui-sans-serif, system-ui, sans-serif">
      <!-- Host 1: developer laptop -->
      <g transform="translate(20,30)">
        <rect x="0" y="0" width="240" height="70" rx="10" fill="#1a1f26" stroke="#2a3139" stroke-width="1.2"/>
        <g transform="translate(14,20)" stroke="#5eadb8" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 20h28V4H2z"/>
          <path d="M0 24h32"/>
        </g>
        <text x="56" y="27" fill="#e6e8ea" font-size="13" font-weight="600">Developer laptop</text>
        <text x="56" y="46" fill="#8b95a1" font-size="11">AI agent · SecureVector local</text>
        <rect x="176" y="12" width="56" height="18" rx="9" fill="rgba(94,173,184,0.14)" stroke="rgba(94,173,184,0.4)" stroke-width="0.8"/>
        <text x="204" y="25" fill="#5eadb8" font-size="9.5" font-weight="700" text-anchor="middle">OCSF</text>
      </g>

      <!-- Host 2: CI runner -->
      <g transform="translate(20,120)">
        <rect x="0" y="0" width="240" height="70" rx="10" fill="#1a1f26" stroke="#2a3139" stroke-width="1.2"/>
        <g transform="translate(14,20)" stroke="#5eadb8" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="4" width="28" height="22" rx="2"/>
          <path d="M8 12h16M8 18h10"/>
        </g>
        <text x="56" y="27" fill="#e6e8ea" font-size="13" font-weight="600">CI runner / container</text>
        <text x="56" y="46" fill="#8b95a1" font-size="11">Agent-as-a-service · sidecar</text>
        <rect x="176" y="12" width="56" height="18" rx="9" fill="rgba(94,173,184,0.14)" stroke="rgba(94,173,184,0.4)" stroke-width="0.8"/>
        <text x="204" y="25" fill="#5eadb8" font-size="9.5" font-weight="700" text-anchor="middle">OCSF</text>
      </g>

      <!-- Host 3: production server -->
      <g transform="translate(20,210)">
        <rect x="0" y="0" width="240" height="70" rx="10" fill="#1a1f26" stroke="#2a3139" stroke-width="1.2"/>
        <g transform="translate(14,18)" stroke="#5eadb8" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="2" width="28" height="10" rx="1.5"/>
          <rect x="2" y="16" width="28" height="10" rx="1.5"/>
          <circle cx="7" cy="7" r="1.2" fill="#5eadb8"/>
          <circle cx="7" cy="21" r="1.2" fill="#5eadb8"/>
        </g>
        <text x="56" y="27" fill="#e6e8ea" font-size="13" font-weight="600">Production server</text>
        <text x="56" y="46" fill="#8b95a1" font-size="11">Customer-facing agent · N instances</text>
        <rect x="176" y="12" width="56" height="18" rx="9" fill="rgba(94,173,184,0.14)" stroke="rgba(94,173,184,0.4)" stroke-width="0.8"/>
        <text x="204" y="25" fill="#5eadb8" font-size="9.5" font-weight="700" text-anchor="middle">OCSF</text>
      </g>

      <!-- Flow arrows (converging to SIEM) -->
      <path d="M 260 65  C 380 65, 430 170, 540 170" fill="none" stroke="#5eadb8" stroke-width="1.8" marker-end="url(#svArrow)"/>
      <path d="M 260 155 L 540 170"                   fill="none" stroke="#5eadb8" stroke-width="1.8" marker-end="url(#svArrow)"/>
      <path d="M 260 245 C 380 245, 430 170, 540 170" fill="none" stroke="#5eadb8" stroke-width="1.8" marker-end="url(#svArrow)"/>

      <!-- Flow label -->
      <g transform="translate(320,140)">
        <rect x="0" y="0" width="160" height="22" rx="11" fill="#0b1117" stroke="#2a3139" stroke-width="1"/>
        <text x="80" y="15" fill="#5eadb8" font-size="11" font-weight="700" text-anchor="middle">OCSF 1.3.0 · metadata</text>
      </g>

      <!-- SIEM card (right) -->
      <g transform="translate(540,100)">
        <rect x="0" y="0" width="260" height="140" rx="12" fill="#1a1f26" stroke="#10b981" stroke-width="1.8"/>
        <text x="130" y="28" fill="#10b981" font-size="13" font-weight="800" text-anchor="middle">ENTERPRISE SIEM</text>
        <text x="130" y="46" fill="#8b95a1" font-size="10.5" text-anchor="middle">(you control, you query, you own)</text>
        <!-- Vendor pills -->
        <g font-size="11" font-weight="600">
          <g transform="translate(16,62)">
            <rect x="0" y="0" width="110" height="22" rx="5" fill="#0b1117" stroke="#2a3139" stroke-width="1"/>
            <text x="55" y="15" fill="#e6e8ea" text-anchor="middle">Splunk HEC</text>
          </g>
          <g transform="translate(134,62)">
            <rect x="0" y="0" width="110" height="22" rx="5" fill="#0b1117" stroke="#2a3139" stroke-width="1"/>
            <text x="55" y="15" fill="#e6e8ea" text-anchor="middle">MS Sentinel</text>
          </g>
          <g transform="translate(16,92)">
            <rect x="0" y="0" width="110" height="22" rx="5" fill="#0b1117" stroke="#2a3139" stroke-width="1"/>
            <text x="55" y="15" fill="#e6e8ea" text-anchor="middle">Chronicle</text>
          </g>
          <g transform="translate(134,92)">
            <rect x="0" y="0" width="110" height="22" rx="5" fill="#0b1117" stroke="#2a3139" stroke-width="1"/>
            <text x="55" y="15" fill="#e6e8ea" text-anchor="middle">QRadar · Datadog</text>
          </g>
        </g>
        <text x="130" y="130" fill="#8b95a1" font-size="10" text-anchor="middle">Dashboards · Correlation · Retention</text>
      </g>

      <!-- Central SOC callout -->
      <g transform="translate(540,12)">
        <text x="130" y="18" fill="#5eadb8" font-size="11" font-weight="700" text-anchor="middle">→ one pane of glass for the SOC</text>
      </g>
    </g>
  </svg>
  <div style="margin-top:8px;font-size:11.5px;color:var(--text-muted);line-height:1.55;text-align:center;">
    Every event carries <code>device.uid</code>, <code>actor.user.name</code>, and MITRE ATT&amp;CK technique IDs. Filter and correlate in your existing SIEM dashboards.
  </div>
</div>
        `;
    },

    buildSiemForwarderContent() {
        // SIEM Forwarder deep-dive. Lives in the Guide so the actual
        // forwarder page stays minimal + action-focused. This block is
        // reference material the operator reads once to pick a redaction
        // tier / vendor / dashboard template, then comes back to only
        // when onboarding a new destination.
        const frag = document.createElement('div');
        frag.style.cssText = 'padding-top: 16px;';

        const sectionHead = (text, mt = '0') => {
            const el = document.createElement('div');
            el.style.cssText = 'font-weight: 700; font-size: 13px; color: var(--text-primary); margin: ' + mt + ' 0 8px 0;';
            el.textContent = text;
            return el;
        };
        const p = (html, mt = '0') => {
            const el = document.createElement('div');
            el.style.cssText = 'font-size: 13px; color: var(--text-secondary); line-height: 1.6; margin: ' + mt + ' 0 10px 0;';
            el.innerHTML = html;
            return el;
        };
        // collapsibleSection — wraps a subsection in a native <details>
        // so the Guide's SIEM Forwarder content stays scannable. Reference
        // blocks (OCSF schema, examples, supported destinations,
        // dashboards, field reference, credential storage) default to
        // collapsed; primary narrative (Overview, Why-forward FAQ, tier
        // reference) stays open so first-time readers don't miss the
        // critical pick-a-tier decision.
        //
        // Returns the body container into which the caller appends its
        // content — so the existing flat frag.append(...) chain becomes
        // body.append(...) for each section without further rewrites.
        const collapsibleSection = (title, { open = false, mt = '18px' } = {}) => {
            const details = document.createElement('details');
            if (open) details.open = true;
            details.style.cssText = 'margin-top:' + mt + ';margin-bottom:10px;border:1px solid var(--border-default);border-radius:8px;background:var(--bg-card);overflow:hidden;';
            const summary = document.createElement('summary');
            summary.style.cssText = 'cursor:pointer;padding:10px 14px;font-size:13px;font-weight:700;color:var(--text-primary);list-style:none;display:flex;align-items:center;gap:8px;user-select:none;';
            summary.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent-primary);flex-shrink:0;transition:transform 0.15s;"><polyline points="9 18 15 12 9 6"/></svg><span>${title}</span>`;
            details.addEventListener('toggle', () => {
                const chev = summary.querySelector('svg');
                if (chev) chev.style.transform = details.open ? 'rotate(90deg)' : 'rotate(0)';
            });
            const body = document.createElement('div');
            body.style.cssText = 'padding:2px 14px 14px;border-top:1px solid var(--border-default);';
            details.appendChild(summary);
            details.appendChild(body);
            frag.appendChild(details);
            return body;
        };

        // ── Overview ─────────────────────────────────────────────────
        frag.appendChild(sectionHead('Overview'));
        frag.appendChild(p(`
            The SIEM Forwarder forwards every threat scan and tool-call audit
            from this machine to a destination of your choice — Splunk,
            Datadog, Sentinel, Chronicle, QRadar, an OpenTelemetry
            collector, or any generic HTTPS webhook. Events use the
            <strong>OCSF 1.3.0</strong> schema so your SOC dashboards
            understand them out of the box. Enqueue is at-least-once via
            a local SQLite outbox with exponential-backoff retries; a
            failing destination never blocks a healthy one.
        `));

        // ── Shared-environment RBAC guidance ─────────────────────────
        // Surface this in the Guide rather than on the SIEM Forwarder
        // page — most operators are on a personal laptop and don't need
        // the warning. Shared-host users arrive here during onboarding
        // via the page's trust-pill link.
        const rbacBlock = document.createElement('div');
        rbacBlock.style.cssText = 'display:flex;align-items:flex-start;gap:10px;padding:10px 14px;margin:0 0 14px;border:1px solid var(--border-default);border-left:3px solid var(--accent-primary);background:var(--bg-tertiary);border-radius:8px;font-size:13px;color:var(--text-secondary);line-height:1.55;';
        rbacBlock.innerHTML = `
            <span aria-hidden="true" style="color:var(--accent-primary);font-weight:800;flex-shrink:0;">!</span>
            <span>
                <strong style="color:var(--text-primary);">Shared machine?</strong>
                The local API on <code>127.0.0.1</code> has no per-user access control — anyone on that loopback can add, edit, or delete a SIEM destination. That's fine for a personal laptop, not for a shared dev or jump host. If multiple people share this host and you need RBAC, use the
                <a href="https://app.securevector.io" target="_blank" rel="noopener" style="color:var(--accent-primary);text-decoration:underline;">SecureVector Cloud app</a>
                — teams, roles, and an audit trail of who changed what.
            </span>
        `;
        frag.appendChild(rbacBlock);

        // faqCard must be defined before the first FAQ that uses it —
        // the enterprise-deployment one below opens the section.
        const faqCard = (q, a, { open = false } = {}) => {
            const el = document.createElement('details');
            if (open) el.open = true;
            el.style.cssText = 'margin-bottom:10px;border:1px solid var(--border-default);border-radius:8px;background:var(--bg-card);overflow:hidden;';
            const sum = document.createElement('summary');
            sum.style.cssText = 'cursor:pointer;padding:10px 14px;font-size:13px;font-weight:700;color:var(--text-primary);list-style:none;display:flex;align-items:center;gap:8px;user-select:none;';
            sum.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent-primary);flex-shrink:0;transition:transform 0.15s;transform:${open ? 'rotate(90deg)' : 'rotate(0)'};"><polyline points="9 18 15 12 9 6"/></svg><span>${q}</span>`;
            el.addEventListener('toggle', () => {
                const chev = sum.querySelector('svg');
                if (chev) chev.style.transform = el.open ? 'rotate(90deg)' : 'rotate(0)';
            });
            const ans = document.createElement('div');
            ans.style.cssText = 'padding:4px 14px 14px;border-top:1px solid var(--border-default);font-size:12.5px;color:var(--text-secondary);line-height:1.65;';
            ans.innerHTML = a;
            el.appendChild(sum);
            el.appendChild(ans);
            return el;
        };

        // ── Enterprise deployment topology — opens the section ───────
        // The first question every evaluator asks. Expanded by default,
        // diagram visible on first scroll. Sets context before the
        // "Why forward" positioning + the OCSF/tier deep-dive below.
        frag.appendChild(sectionHead('Enterprise deployment'));
        frag.appendChild(faqCard(
            'How can an enterprise deploy SecureVector across its agents with SIEM forwarding?',
            `
                <p style="margin:10px 0 8px;">Every workstation, VM, or container running an AI agent installs SecureVector locally. Each instance scans its own agent's prompts + tool calls and forwards OCSF 1.3.0 events to the company's existing SIEM. Central SOC sees every AI agent in one dashboard via <code>device.uid</code>.</p>
                ${this._enterpriseDeploymentSvg()}
                <ul style="margin:10px 0 10px;padding-left:18px;line-height:1.7;">
                    <li><strong>Deploy.</strong> Install SecureVector on every host that runs an agent (laptops, CI runners, prod servers, containers). Company-managed via MDM or config-mgmt (Ansible / Salt / Intune).</li>
                    <li><strong>Configure once, centrally.</strong> Point every instance at the same enterprise SIEM destination via the Add Destination flow, or pre-seed the config alongside the binary in your deployment pipeline.</li>
                    <li><strong>Observe.</strong> Splunk / Sentinel / Chronicle / QRadar receives events from N devices. Filter by <code>device.uid</code> for per-host; filter by <code>actor.user.name</code> for per-user; cluster on <code>finding.related_events_uid</code> for attack campaigns.</li>
                    <li><strong>Correlate.</strong> AI events sit alongside EDR / SSO / network signals in the same SIEM — one pane of glass, one on-call rotation, one runbook.</li>
                    <li><strong>Comply.</strong> OCSF + MITRE ATT&CK + tamper-evident tool audit chain satisfy AI governance controls for SOC 2 / HIPAA / FINRA / EU AI Act audits.</li>
                </ul>
                <p style="margin:0;">For fleet-wide RBAC, teams, and a shared audit trail of who changed what across many devices, pair this with the <a href="https://app.securevector.io" target="_blank" rel="noopener" style="color:var(--accent-primary);text-decoration:underline;">SecureVector Cloud app</a> — local agents keep scanning and forwarding; the cloud federates policy and access control across the fleet.</p>
            `,
            { open: true },
        ));

        // ── Why send AI events to your SIEM? ─────────────────────────
        // Positioning questions for SOC analysts evaluating the feature.
        frag.appendChild(sectionHead('Why forward AI events to your SIEM?', '18px'));

        frag.appendChild(faqCard(
            'How and when does a SOC use this?',
            `
                <p style="margin:10px 0 8px;">AI agents are a new attack surface — one your existing EDR, CASB, DLP, and network IDS don't see. Adopting agents without visibility means:</p>
                <ul style="margin:0 0 10px;padding-left:18px;line-height:1.7;">
                    <li><strong>Prompt injection attempts</strong> go unlogged until damage is visible downstream.</li>
                    <li><strong>Sensitive tool calls</strong> (Gmail.send, ShellExec, DB.query) aren't gated by the same policy engine that governs human actions.</li>
                    <li><strong>Data exfiltration via LLM output</strong> (PII / secrets echoed back, RAG over sensitive corpora) bypasses content DLP which inspects files, not prompts.</li>
                </ul>
                <p style="margin:0 0 8px;">Typical use cases:</p>
                <ul style="margin:0;padding-left:18px;line-height:1.7;">
                    <li><strong>Triage & IR:</strong> prompt injection blocks and jailbreak attempts show up in the same queue as phishing and endpoint alerts — the analyst doesn't learn a second tool.</li>
                    <li><strong>Correlation:</strong> "Okta login from new geo → SecureVector PII block on the same user within 10 min" becomes a single detection rule instead of two disconnected signals.</li>
                    <li><strong>Audit & compliance:</strong> SOC 2 / HIPAA / FINRA / EU AI Act increasingly require evidence of AI guardrails and tamper-evident tool-call logs. The SIEM is where auditors look.</li>
                    <li><strong>Fleet visibility:</strong> each event carries <code>device.uid</code>, so one dashboard covers every laptop or container running SecureVector.</li>
                </ul>
            `,
        ));

        frag.appendChild(faqCard(
            'How does it benefit the SOC?',
            `
                <ul style="margin:10px 0 0;padding-left:18px;line-height:1.7;">
                    <li><strong>One pane of glass.</strong> AI security events live in Splunk / Sentinel / Chronicle alongside every other detection. No new dashboard, no new on-call rotation.</li>
                    <li><strong>MITRE ATT&CK coverage</strong> — events carry <code>finding.techniques</code> (T1659 Content Injection, T1567 Exfiltration over Web Service, etc.) so AI detections slot into existing ATT&CK dashboards and coverage reports.</li>
                    <li><strong>Actor attribution.</strong> <code>actor.user</code> + <code>actor.process</code> on every event means pivoting to IAM/EDR context works the same as for any other alert.</li>
                    <li><strong>Tamper-evident audit chain</strong> for tool calls — the SOC can re-verify the SHA-256 hash chain off-host, so a compromised endpoint can't rewrite history without detection.</li>
                    <li><strong>Alert-fatigue defense</strong> — per-destination severity floor drops low-confidence noise before it hits the feed; burst guard collapses loops into a single <code>suppressed_count</code> event.</li>
                    <li><strong>Finding clustering</strong> via <code>finding.related_events_uid</code> — ten attempts of the same attack from the same user become one triage finding, not ten.</li>
                </ul>
            `,
        ));

        frag.appendChild(faqCard(
            'Is there a real point to sending these from SecureVector → SIEM?',
            `
                <p style="margin:10px 0 8px;">Short version: yes, when the SOC is the workflow home for IR, audit, and correlation. Long version:</p>
                <ul style="margin:0 0 10px;padding-left:18px;line-height:1.7;">
                    <li><strong>Correlation with non-AI signals.</strong> SecureVector alone can't tell you the compromised agent shares an identity with a just-failed SSO login. The SIEM can — once both signals arrive there.</li>
                    <li><strong>Historical search.</strong> "Has this exact prompt-injection pattern been tried before?" is a 30-second Splunk query, not a custom tool.</li>
                    <li><strong>Existing paging & ticketing.</strong> Your PagerDuty / ServiceNow / Jira bridges already consume SIEM alerts. Forwarding plugs AI events into the runbook you already have.</li>
                    <li><strong>Long-term retention.</strong> SecureVector keeps scans locally with fixed retention; your SIEM is the system of record for compliance-grade retention (usually 12+ months).</li>
                    <li><strong>Reporting.</strong> "We blocked N prompt injections this quarter, clustered into M campaigns" — that report comes out of the SIEM, not a vendor dashboard.</li>
                </ul>
                <p style="margin:0;">When NOT to forward: indie operators running on a personal laptop with no SOC. That's what the <strong>Local NDJSON file</strong> destination is for — every benefit of forwarding (append-only log, tamper-evidence on tool calls, searchability with <code>jq</code>) without the overhead.</p>
            `,
        ));

        // (Enterprise deployment FAQ moved to the top of the SIEM
        // Forwarder section — it's the first question an evaluator
        // asks, so it's positioned above "Why forward" with the
        // diagram expanded by default.)

        // ── What gets forwarded at each tier ─────────────────────────
        // Tier reference — the critical pick-a-tier decision. Open by
        // default so first-time readers see the ships/strips trade-off
        // without clicking.
        const tierSectionBody = collapsibleSection('What gets forwarded at each redaction tier', { open: true });
        tierSectionBody.appendChild(p(`
            Pick a redaction tier per destination when you add it. The
            forwarder strips fields at <em>enqueue time</em>, so a
            <code>standard</code> destination never has prompt text sitting
            in its outbox rows even momentarily.
        `));

        const tierGrid = document.createElement('div');
        tierGrid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;margin-bottom:14px;';

        const tierCard = ({ name, subtitle, accent, ships, strips, useCase }) => {
            const card = document.createElement('div');
            card.style.cssText = `background:var(--bg-card);border:1px solid var(--border-default);border-top:3px solid ${accent};border-radius:10px;padding:14px 16px;`;
            card.innerHTML = `
                <div style="font-size:12px;font-weight:800;letter-spacing:0.8px;text-transform:uppercase;color:${accent};margin-bottom:2px;">${name}</div>
                <div style="font-size:11.5px;color:var(--text-muted);margin-bottom:10px;">${subtitle}</div>
                <div style="font-size:12px;color:var(--text-primary);font-weight:700;margin-bottom:4px;">Forwards</div>
                <ul style="margin:0 0 12px;padding-left:16px;font-size:12px;color:var(--text-secondary);line-height:1.65;">${ships.map(s => `<li>${s}</li>`).join('')}</ul>
                <div style="font-size:12px;color:var(--text-primary);font-weight:700;margin-bottom:4px;">Strips</div>
                <ul style="margin:0 0 12px;padding-left:16px;font-size:12px;color:var(--text-secondary);line-height:1.65;">${strips.map(s => `<li>${s}</li>`).join('')}</ul>
                <div style="font-size:11.5px;color:var(--text-muted);line-height:1.5;padding-top:8px;border-top:1px dashed var(--border-default);"><strong style="color:var(--text-secondary);">Use when:</strong> ${useCase}</div>
            `;
            return card;
        };

        tierGrid.appendChild(tierCard({
            name: 'Minimal',
            subtitle: 'Lowest-volume · ops dashboards',
            accent: '#6ee7b7',
            ships: [
                'verdict (BLOCK / DETECTED / ALLOW)',
                'risk_level, detected_items_count',
                '<code>device.uid</code> (stable per machine)',
                '<code>actor.user.name</code> + <code>actor.process.name</code>',
                'MITRE ATT&CK technique IDs',
                '<code>finding.related_events_uid</code> (clustering)',
                '<code>suppressed_count</code> (burst-guard summary)',
            ],
            strips: [
                'threat_score, confidence_score',
                'matched rule IDs, model_id, conversation_id',
                'hash-chain witness (<code>prev_hash</code>, <code>row_hash</code>)',
                'prompt text, LLM output, matched patterns',
            ],
            useCase: 'You just need counts and attribution. Real-time ops dashboards where volume and latency matter more than forensic depth.',
        }));

        tierGrid.appendChild(tierCard({
            name: 'Standard · Default',
            subtitle: 'Most commonly forwarded',
            accent: '#5eadb8',
            ships: [
                'Everything from Minimal, plus:',
                '<code>threat_score</code>, <code>confidence_score</code>',
                'matched rule IDs, <code>worst_rule_severity</code>',
                '<code>model_id</code>, <code>conversation_id</code>',
                'scan duration, ML status',
                'hash-chain witness on tool-call audits (SIEM can re-verify integrity off-host)',
            ],
            strips: [
                'prompt text',
                'LLM output',
                'matched pattern strings',
                'full tool-call arguments',
            ],
            useCase: 'Most production SOC feeds. Enough to triage, correlate, and pivot without any raw payload leaving the host.',
        }));

        tierGrid.appendChild(tierCard({
            name: 'Full · Forensic',
            subtitle: 'Opt-in with confirmation',
            accent: '#f59e0b',
            ships: [
                'Everything from Standard, plus:',
                '<code>raw_data</code> = prompt text (8&nbsp;KB cap)',
                '<code>unmapped.llm_output</code> (8&nbsp;KB cap)',
                'Matched pattern strings (1&nbsp;KB each)',
                'Tool-call args + full policy reason (8&nbsp;KB cap)',
                '<strong>Truncation marker appended</strong> when a field is capped — no silent loss.',
            ],
            strips: [
                '(nothing — this is the forensic tier)',
            ],
            useCase: 'Regulated environments with an explicit data-handling plan (GDPR / HIPAA / SOC 2 reviewed). Size caps keep per-event overhead bounded, but high volume still costs — check ingest budget.',
        }));

        tierSectionBody.appendChild(tierGrid);

        const tierNote = document.createElement('div');
        tierNote.style.cssText = 'padding:10px 12px;margin-bottom:16px;border-radius:6px;font-size:12px;line-height:1.55;background:rgba(239,68,68,0.08);color:#fca5a5;border:1px solid rgba(239,68,68,0.25);';
        tierNote.innerHTML = `
            <strong>Escalating to Full requires confirmation.</strong>
            The editor shows a blocking dialog listing exactly what will
            start leaving the machine. Minimum-severity filter and per-
            destination rate limit apply at every tier.
        `;
        tierSectionBody.appendChild(tierNote);

        // ── OCSF schema + timestamps ─────────────────────────────────
        const schemaBody = collapsibleSection('OCSF schema');
        schemaBody.appendChild(p(`
            <strong>OCSF 1.3.0</strong> — the Open Cybersecurity Schema
            Framework adopted by AWS Security Lake, Splunk, Palo Alto, and
            CrowdStrike. Two event classes cover everything:
        `));

        const schemaTable = document.createElement('div');
        schemaTable.style.cssText = 'border:1px solid var(--border-default);border-radius:8px;overflow:hidden;margin-bottom:14px;';
        schemaTable.innerHTML = `
            <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
                <thead>
                    <tr style="background:var(--bg-tertiary);">
                        <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;font-size:11px;letter-spacing:0.6px;">Class</th>
                        <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;font-size:11px;letter-spacing:0.6px;">Event</th>
                        <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;font-size:11px;letter-spacing:0.6px;">Fired on</th>
                    </tr>
                </thead>
                <tbody>
                    <tr style="border-top:1px solid var(--border-default);">
                        <td style="padding:10px 12px;"><code>2001</code></td>
                        <td style="padding:10px 12px;"><strong>Security Finding</strong></td>
                        <td style="padding:10px 12px;">Every scan verdict (prompt injection, PII detection, jailbreak). Uses <code>finding.techniques</code> for ATT&CK, <code>finding.related_events_uid</code> for clustering.</td>
                    </tr>
                    <tr style="border-top:1px solid var(--border-default);">
                        <td style="padding:10px 12px;"><code>1007</code></td>
                        <td style="padding:10px 12px;"><strong>Process Activity</strong></td>
                        <td style="padding:10px 12px;">Every tool-call audit row. Hash-chain witness in <code>unmapped</code> (<code>seq</code>, <code>prev_hash</code>, <code>row_hash</code>) lets the SIEM re-verify integrity.</td>
                    </tr>
                </tbody>
            </table>
        `;
        schemaBody.appendChild(schemaTable);

        const tzNote = document.createElement('div');
        tzNote.style.cssText = 'font-size:12px;color:var(--text-secondary);line-height:1.55;margin-bottom:14px;';
        tzNote.innerHTML = `
            <strong style="color:var(--text-primary);">Timestamps</strong> are UTC (<code>time</code> = Unix epoch milliseconds). Your SIEM dashboard renders in the viewer's local zone; raw events do not.<br>
            <strong style="color:var(--text-primary);">Schema revision</strong> is carried in <code>metadata.extension.version</code> — currently <code>securevector:4.0</code>. Bumped on any breaking shape change so downstream parsers can branch.
        `;
        schemaBody.appendChild(tzNote);

        // ── Example payloads ─────────────────────────────────────────
        const exBody = collapsibleSection('Example payloads');
        exBody.appendChild(p('Concrete OCSF events — one scan, one tool-call audit. Copy/paste into your SIEM search to sanity-check field paths.'));

        const exGrid = document.createElement('div');
        exGrid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:12px;margin-bottom:16px;';

        const scanExample = {
            metadata: {
                version: '1.3.0',
                product: { name: 'SecureVector Local Threat Monitor', vendor_name: 'SecureVector' },
                log_name: 'securevector-local-scan',
                extension: { name: 'securevector', version: 'securevector:4.0' },
            },
            category_uid: 2, class_uid: 2001, class_name: 'Security Finding',
            activity_id: 1, severity_id: 5, severity: 'BLOCK',
            confidence: 87, confidence_score: 0.87,
            time: 1745352300000,
            device: { uid: 'sv-89ec5d06412c3e674073b860', type_id: 0, type: 'Endpoint' },
            actor: {
                user: { name: 'yashs' },
                process: { name: 'customer-support-bot' },
            },
            finding: {
                uid: '0e5325f1-37d7-49e4-a1c0-23254038781a',
                title: 'BLOCK: Prompt Injection',
                types: ['prompt_injection'],
                techniques: [{ uid: 'T1659', name: 'Content Injection' }],
                related_events_uid: ['a3f82b9c1d4e7058'],
                related_events: [
                    { type_uid: 2, type: 'Rule Match', uid: 'rule-inj-001' },
                ],
            },
            observables: [
                { type_id: 0, name: 'verdict', value: 'BLOCK' },
                { type_id: 0, name: 'risk_level', value: 'critical' },
            ],
            raw_data: null,
            unmapped: {
                threat_score: 0.92,
                detected_items_count: 1,
                detected_types: ['prompt_injection'],
                ml_status: 'reviewed',
                scan_duration_ms: 12.4,
                model_id: 'gpt-4o',
                conversation_id: 'sess-demo-1',
                matched_rule_ids: ['rule-inj-001'],
                worst_rule_severity: 'critical',
            },
        };

        const auditExample = {
            metadata: {
                version: '1.3.0',
                product: { name: 'SecureVector Local Threat Monitor', vendor_name: 'SecureVector' },
                log_name: 'securevector-local-scan',
                extension: { name: 'securevector', version: 'securevector:4.0' },
            },
            category_uid: 1, class_uid: 1007, class_name: 'Process Activity',
            activity_id: 1, severity_id: 4,
            time: 1745352300500,
            device: { uid: 'sv-89ec5d06412c3e674073b860', type_id: 0, type: 'Endpoint' },
            actor: {
                user: { name: 'yashs' },
                process: { name: 'Gmail.send' },
            },
            process: { name: 'send', uid: 'Gmail.send' },
            techniques: [{ uid: 'T1567', name: 'Exfiltration Over Web Service' }],
            related_events_uid: ['b1c4d7e2f5a80931'],
            raw_data: null,
            unmapped: {
                audit_id: 17, action: 'block', risk: 'high',
                is_essential: false, seq: 17,
                prev_hash: '4e9a2b1d7c3f5a8e1b4c7d9f2a6e3c8b5d1f7a0e9c3b6d2f4a8e5c1b9d7f3a6e',
                row_hash: 'a7c3e9f1b5d2a8e4c6b9f1d3a7e5c8b2d4f6a1e9c3b7d5f2a8e6c4b1d9f3a5e7',
            },
        };

        const eventCard = (title, body, payload) => {
            const card = document.createElement('div');
            card.style.cssText = 'background:var(--bg-card);border:1px solid var(--border-default);border-radius:10px;overflow:hidden;display:flex;flex-direction:column;';
            const header = document.createElement('div');
            header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border-bottom:1px solid var(--border-default);';
            const titleWrap = document.createElement('div');
            titleWrap.style.cssText = 'flex:1;min-width:0;';
            titleWrap.innerHTML = `
                <div style="font-size:13px;font-weight:700;color:var(--text-primary);">${title}</div>
                <div style="font-size:11.5px;color:var(--text-muted);margin-top:2px;line-height:1.4;">${body}</div>
            `;
            header.appendChild(titleWrap);
            const copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.className = 'btn btn-secondary btn-compact';
            copyBtn.textContent = 'Copy JSON';
            copyBtn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
                    const prev = copyBtn.textContent;
                    copyBtn.textContent = '✓ Copied';
                    setTimeout(() => { copyBtn.textContent = prev; }, 1400);
                } catch (_) { /* ignore */ }
            });
            header.appendChild(copyBtn);
            card.appendChild(header);
            const pre = document.createElement('pre');
            pre.style.cssText = 'margin:0;padding:12px 14px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.5;color:var(--accent-primary);background:var(--bg-tertiary);overflow:auto;max-height:360px;white-space:pre;word-break:normal;';
            pre.textContent = JSON.stringify(payload, null, 2);
            card.appendChild(pre);
            return card;
        };

        exGrid.appendChild(eventCard(
            'Scan finding — class 2001',
            'Emitted whenever /analyze produces a verdict that clears the destination\'s min_severity filter.',
            scanExample,
        ));
        exGrid.appendChild(eventCard(
            'Tool-call audit — class 1007',
            'Emitted on every tool-call audit row. Hash-chain witness in unmapped lets the SIEM re-verify integrity off-host.',
            auditExample,
        ));
        exBody.appendChild(exGrid);

        // ── Supported destinations ───────────────────────────────────
        const destBody = collapsibleSection('Supported destinations');
        const destTable = document.createElement('div');
        destTable.style.cssText = 'border:1px solid var(--border-default);border-radius:8px;overflow:hidden;margin-bottom:16px;';
        destTable.innerHTML = `
            <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
                <thead>
                    <tr style="background:var(--bg-tertiary);">
                        <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;font-size:11px;letter-spacing:0.6px;">Destination</th>
                        <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;font-size:11px;letter-spacing:0.6px;">URL shape</th>
                        <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;font-size:11px;letter-spacing:0.6px;">Auth</th>
                        <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;font-size:11px;letter-spacing:0.6px;">Status</th>
                    </tr>
                </thead>
                <tbody>
                    <tr style="border-top:1px solid var(--border-default);">
                        <td style="padding:10px 12px;"><strong>Splunk HEC</strong></td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:11.5px;">https://&lt;host&gt;/services/collector/event</td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:11.5px;">Authorization: Splunk &lt;HEC-token&gt;</td>
                        <td style="padding:10px 12px;"><span style="background:rgba(16,185,129,0.18);color:#10b981;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;">NATIVE</span></td>
                    </tr>
                    <tr style="border-top:1px solid var(--border-default);">
                        <td style="padding:10px 12px;"><strong>Datadog Logs</strong></td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:11.5px;">https://http-intake.logs.&lt;site&gt;/api/v2/logs</td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:11.5px;">DD-API-KEY: &lt;key&gt;</td>
                        <td style="padding:10px 12px;"><span style="background:rgba(16,185,129,0.18);color:#10b981;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;">NATIVE</span></td>
                    </tr>
                    <tr style="border-top:1px solid var(--border-default);">
                        <td style="padding:10px 12px;"><strong>OTLP / HTTP</strong><br><span style="color:var(--text-muted);font-size:11px;">Any OpenTelemetry collector</span></td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:11.5px;">https://&lt;collector&gt;/v1/logs</td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:11.5px;">optional Bearer token</td>
                        <td style="padding:10px 12px;"><span style="background:rgba(16,185,129,0.18);color:#10b981;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;">NATIVE</span></td>
                    </tr>
                    <tr style="border-top:1px solid var(--border-default);">
                        <td style="padding:10px 12px;"><strong>Generic Webhook</strong><br><span style="color:var(--text-muted);font-size:11px;">Lambda · Cloudflare · Tines · n8n</span></td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:11.5px;">any HTTPS endpoint that accepts JSON POST</td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:11.5px;">optional Bearer token</td>
                        <td style="padding:10px 12px;"><span style="background:rgba(16,185,129,0.18);color:#10b981;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;">NATIVE</span></td>
                    </tr>
                    <tr style="border-top:1px solid var(--border-default);">
                        <td style="padding:10px 12px;"><strong>IBM QRadar</strong></td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:11.5px;">https://&lt;qradar-host&gt;/api/siem/events</td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:11.5px;">SEC: &lt;api-token&gt; · via webhook</td>
                        <td style="padding:10px 12px;"><span style="background:rgba(99,102,241,0.18);color:#818cf8;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;">VIA WEBHOOK</span></td>
                    </tr>
                    <tr style="border-top:1px solid var(--border-default);">
                        <td style="padding:10px 12px;"><strong>Microsoft Sentinel</strong></td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:11.5px;">https://&lt;dce&gt;.ingest.monitor.azure.com/…/streams/Custom-SecureVector</td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:11.5px;">Bearer AAD token · via webhook</td>
                        <td style="padding:10px 12px;"><span style="background:rgba(99,102,241,0.18);color:#818cf8;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;">VIA WEBHOOK</span></td>
                    </tr>
                    <tr style="border-top:1px solid var(--border-default);">
                        <td style="padding:10px 12px;"><strong>Google Chronicle SIEM</strong></td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:11.5px;">https://malachiteingestion-pa.googleapis.com/v2/udmevents:batchCreate</td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:11.5px;">Bearer GCP token · via webhook</td>
                        <td style="padding:10px 12px;"><span style="background:rgba(99,102,241,0.18);color:#818cf8;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;">VIA WEBHOOK</span></td>
                    </tr>
                </tbody>
            </table>
        `;
        destBody.appendChild(destTable);

        destBody.appendChild(p(`
            <strong>"Via webhook"</strong> vendors accept JSON over HTTPS
            with a bearer-style auth header — the same shape the Generic
            Webhook destination sends. Choose <em>Webhook</em> as the kind,
            paste the endpoint URL, provide the token. Native one-click
            adapters are on the roadmap.
        `));

        // ── Credential storage disclosure ────────────────────────────
        const credBody = collapsibleSection('How are SIEM credentials stored?');
        credBody.appendChild(p(`
            Your HEC tokens, API keys, and bearer tokens <strong>never
            land in the SQLite database</strong>. The destination row
            carries only an opaque <code>secret_ref</code>; the plaintext
            value lives in a separate file with OS-level access control.
        `));

        const credGrid = document.createElement('div');
        credGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:10px;';
        const credCard = (title, lines) => {
            const c = document.createElement('div');
            c.style.cssText = 'background:var(--bg-card);border:1px solid var(--border-default);border-radius:10px;padding:12px 14px;';
            c.innerHTML = `<div style="font-size:12px;font-weight:700;color:var(--text-primary);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">${title}</div>` +
                `<ul style="margin:0;padding-left:16px;font-size:12px;color:var(--text-secondary);line-height:1.6;">${lines.map(l => `<li>${l}</li>`).join('')}</ul>`;
            return c;
        };
        credGrid.appendChild(credCard('File location (by OS)', [
            'macOS: <code>~/Library/Application&nbsp;Support/SecureVector/.forwarder-secrets.json</code>',
            'Linux: <code>~/.local/share/SecureVector/.forwarder-secrets.json</code>',
            'Windows: <code>%LOCALAPPDATA%\\SecureVector\\.forwarder-secrets.json</code>',
        ]));
        credGrid.appendChild(credCard('Access control', [
            'File permissions: <code>0600</code> (owner read/write only)',
            'Parent directory: <code>0700</code>',
            'Created with restricted perms from the start — no race window',
            'Plaintext inside the file (rely on OS perms + disk encryption at rest)',
        ]));
        credBody.appendChild(credGrid);

        credBody.appendChild(p(`
            <strong>Lifecycle:</strong> deleting a destination deletes its
            secret from this file. Updating the secret removes the old
            entry and writes a fresh one. Rotating credentials in your
            SIEM? Edit the destination, paste the new token, save — the
            old ref is purged.
        `));

        const credThreat = document.createElement('div');
        credThreat.style.cssText = 'padding:10px 12px;margin-bottom:16px;border-radius:6px;font-size:12px;line-height:1.55;background:var(--bg-tertiary);border:1px solid var(--border-default);color:var(--text-secondary);';
        credThreat.innerHTML = `
            <strong style="color:var(--text-primary);">Threat model — what this protects against:</strong>
            <ul style="margin:6px 0 0;padding-left:16px;line-height:1.7;">
                <li><strong>SQLite exfil alone</strong> → attacker gets URLs and names, no tokens.</li>
                <li><strong>Secrets file exfil alone</strong> → attacker gets tokens but no URLs / context to use them.</li>
                <li><strong>Both</strong> → equivalent to running code as the user account — outside this layer's scope (use FileVault / LUKS / BitLocker + a supervised login).</li>
            </ul>
        `;
        credBody.appendChild(credThreat);

        // ── Dashboards & workbooks ───────────────────────────────────
        const dashBody = collapsibleSection('Ready-made dashboards');
        dashBody.appendChild(p(`
            Two templates ship with the repo, wired to the OCSF field
            paths the encoder emits. Both cover the same tiles —
            severity counters, MITRE top-N, actor breakdown, finding
            clusters, burst suppression, hash-chain integrity.
        `));

        const dashGrid = document.createElement('div');
        dashGrid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-bottom:16px;';

        // Cards open the same preview-and-copy Modal exposed by
        // SiemExportPage.openTemplateModal(). Single source of truth
        // for install steps + template content, works offline, no
        // GitHub URL pinning.
        const dashCard = (vendor, templateKey, summary) => {
            const card = document.createElement('div');
            card.style.cssText = 'background:var(--bg-card);border:1px solid var(--border-default);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:8px;';
            card.innerHTML = `
                <div style="font-size:13px;font-weight:700;color:var(--text-primary);">${vendor}</div>
                <div style="font-size:12.5px;color:var(--text-secondary);line-height:1.6;">${summary}</div>
            `;
            const openBtn = document.createElement('button');
            openBtn.type = 'button';
            openBtn.className = 'btn btn-primary btn-compact';
            openBtn.textContent = 'Preview + copy / download';
            openBtn.style.cssText = 'align-self:flex-start;';
            openBtn.addEventListener('click', () => {
                if (window.SiemExportPage && typeof SiemExportPage.openTemplateModal === 'function') {
                    SiemExportPage.openTemplateModal(templateKey);
                }
            });
            card.appendChild(openBtn);
            return card;
        };

        dashGrid.appendChild(dashCard(
            'Microsoft Sentinel',
            'sentinel',
            'KQL workbook for <code>Custom-SecureVector_CL</code> — severity tiles, MITRE top-N, actor breakdown, finding clusters, burst suppression.',
        ));

        dashGrid.appendChild(dashCard(
            'Splunk',
            'splunk',
            '10-panel dashboard for <code>sourcetype=securevector:ocsf</code> — same tile set as the Sentinel workbook, plus hash-chain integrity check.',
        ));

        dashGrid.appendChild(dashCard(
            'Datadog',
            'datadog',
            'Log-based dashboard for the Datadog destination kind. Total + BLOCK + DETECTED query-values, severity timeseries, top MITRE + top actors toplists, recent high-severity log stream. Requires facets configured for the OCSF attributes (@severity, @class_uid, @actor.user.name, etc.).',
        ));

        dashGrid.appendChild(dashCard(
            'Grafana (Loki)',
            'grafana',
            'For the indie / homelab path: Local NDJSON file → Promtail/Alloy → Loki → Grafana. Total + BLOCK + DETECTED counters, severity timeseries, top findings, top actors, recent high-severity logs panel.',
        ));


        dashBody.appendChild(dashGrid);

        const tplNote = document.createElement('div');
        tplNote.style.cssText = 'margin-top:4px;padding:10px 12px;font-size:11.5px;color:var(--text-muted);line-height:1.55;background:var(--bg-tertiary);border:1px solid var(--border-default);border-radius:6px;';
        tplNote.innerHTML = `
            <strong style="color:var(--text-secondary);">Starter templates, not production-validated.</strong>
            All four are MIT-licensed and provided AS-IS. Import into your own stack, verify panels render against real events, and adjust queries / facets to match your environment. See the <a href="https://github.com/Secure-Vector/securevector-ai-threat-monitor/blob/master/docs/siem/NOTICE" target="_blank" rel="noopener" style="color:var(--accent-primary);text-decoration:underline;">NOTICE</a> for trademark + upstream-license attributions.
        `;
        dashBody.appendChild(tplNote);

        // ── Field reference ──────────────────────────────────────────
        const fieldBody = collapsibleSection('Field reference');
        const fieldTable = document.createElement('div');
        fieldTable.style.cssText = 'border:1px solid var(--border-default);border-radius:8px;overflow:hidden;margin-bottom:16px;';
        fieldTable.innerHTML = `
            <table style="width:100%;border-collapse:collapse;font-size:12.5px;">
                <thead>
                    <tr style="background:var(--bg-tertiary);">
                        <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;font-size:11px;letter-spacing:0.6px;">OCSF path</th>
                        <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;font-size:11px;letter-spacing:0.6px;">Source</th>
                        <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;font-size:11px;letter-spacing:0.6px;">Why</th>
                    </tr>
                </thead>
                <tbody>
                    ${[
                        ['<code>class_uid</code>', 'encoder', '2001 = scan finding · 1007 = tool-call audit'],
                        ['<code>severity</code> / <code>severity_id</code>', 'encoder', 'BLOCK / DETECTED / ALLOW + OCSF 1–5 severity'],
                        ['<code>device.uid</code>', 'scanner', 'Stable per-machine hash <code>sv-&lt;24 hex&gt;</code>'],
                        ['<code>actor.user.name</code>', 'scanner', 'OS login of the user who triggered the scan'],
                        ['<code>actor.process.name</code>', 'scanner', 'The <code>source</code> identifier from /analyze'],
                        ['<code>finding.techniques[].uid</code>', 'rule metadata', 'MITRE ATT&CK technique IDs'],
                        ['<code>finding.related_events_uid[]</code>', 'scanner', '<code>finding_group_id</code> — clusters repeat attacks'],
                        ['<code>confidence</code> / <code>confidence_score</code>', 'scanner', '0–100 int + 0.0–1.0 float'],
                        ['<code>unmapped.matched_rule_ids[]</code>', 'scanner', 'IDs of every rule that fired'],
                        ['<code>unmapped.worst_rule_severity</code>', 'scanner', 'Highest per-rule severity among matches'],
                        ['<code>unmapped.seq</code> / <code>prev_hash</code> / <code>row_hash</code>', 'tool-call audit', 'SHA-256 hash chain — verify off-host'],
                        ['<code>suppressed_count</code>', 'forwarder burst guard', 'Events dropped by per-destination rate limit'],
                        ['<code>metadata.extension.version</code>', 'encoder', 'Vendor schema revision (<code>securevector:4.0</code>)'],
                    ].map(([path, src, why]) => `
                        <tr style="border-top:1px solid var(--border-default);">
                            <td style="padding:8px 12px;font-family:monospace;font-size:11.5px;">${path}</td>
                            <td style="padding:8px 12px;font-size:12px;color:var(--text-muted);">${src}</td>
                            <td style="padding:8px 12px;font-size:12.5px;">${why}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
        fieldBody.appendChild(fieldTable);

        // ── Open SIEM Forwarder CTA ──────────────────────────────────
        const openBtn = document.createElement('button');
        openBtn.className = 'btn btn-primary';
        openBtn.style.cssText = 'font-size: 12px; margin: 8px 0 0 0; padding: 8px 16px;';
        openBtn.textContent = 'Open SIEM Forwarder →';
        openBtn.addEventListener('click', () => {
            if (window.Sidebar) {
                Sidebar.expandSection('integrations');
                Sidebar.navigate('siem-export');
            }
        });
        frag.appendChild(openBtn);

        return frag;
    },

    buildSkillScannerContent() {
        const frag = document.createElement('div');
        frag.style.cssText = 'padding-top: 16px;';

        // Helper: section heading
        const sectionHead = (text, mt = '0') => {
            const el = document.createElement('div');
            el.style.cssText = 'font-weight: 700; font-size: 13px; color: var(--text-primary); margin: ' + mt + ' 0 8px 0;';
            el.textContent = text;
            return el;
        };

        // Helper: small descriptive paragraph
        const para = (text) => {
            const el = document.createElement('div');
            el.style.cssText = 'font-size: 12px; color: var(--text-secondary); margin-bottom: 10px; line-height: 1.5;';
            el.textContent = text;
            return el;
        };

        // Helper: callout note
        const note = (strong, body, color) => {
            const el = document.createElement('div');
            el.style.cssText = 'margin: 10px 0 14px 0; font-size: 12px; color: var(--text-secondary); padding: 8px 12px; background: var(--bg-secondary); border-radius: 6px; border-left: 2px solid ' + (color || 'var(--accent-primary)') + '; line-height: 1.5;';
            if (strong) {
                const s = document.createElement('strong');
                s.style.color = 'var(--text-primary)';
                s.textContent = strong;
                el.appendChild(s);
            }
            el.appendChild(document.createTextNode(body));
            return el;
        };

        // ── Intro ─────────────────────────────────────────────────────────
        const intro = document.createElement('p');
        intro.style.cssText = 'color: var(--text-secondary); margin: 0 0 16px 0; font-size: 13px; line-height: 1.5;';
        intro.textContent = 'The Skill Scanner performs static security analysis on skill directories before installation. It inspects Python, JavaScript, TypeScript, and shell scripts without executing any code. You can scan local paths, GitHub repos, npm packages, or archive URLs. After scanning, the Policy Engine classifies each finding using your permission rules and produces an ALLOW / WARN / BLOCK decision.';
        frag.appendChild(intro);

        // ── What it scans ─────────────────────────────────────────────────
        frag.appendChild(sectionHead('What it scans'));
        frag.appendChild(para('Walks every file recursively and inspects source files:'));
        frag.appendChild(this.createCodeBlock('.py  .js  .mjs  .cjs  .ts  .sh  .bash'));
        frag.appendChild(note('Limits: ', 'Max 500 source files, 1 MB per file. Binary files (.pyc, .so, .dll, .whl, .egg, .class) are flagged regardless.', '#f59e0b'));

        // ── Finding categories ────────────────────────────────────────────
        frag.appendChild(sectionHead('Finding categories', '6px'));

        const categories = [
            { name: 'Network call',       id: 'network_domain',   severity: 'HIGH',    color: '#ef4444', desc: 'HTTP/HTTPS calls to domains not in the manifest.' },
            { name: 'Dynamic code',       id: 'code_exec',        severity: 'HIGH',    color: '#ef4444', desc: 'Dynamic code execution \u2014 arbitrary runtime code.' },
            { name: 'Obfuscated import',  id: 'dynamic_import',   severity: 'HIGH',    color: '#ef4444', desc: '__import__(), importlib, or getattr() hiding module loads.' },
            { name: 'Shell command',      id: 'shell_exec',       severity: 'HIGH/LOW', color: '#ef4444', desc: 'HIGH if dynamic args or unknown command, LOW if known safe tool (claude, git, npm, python).' },
            { name: 'File write',         id: 'file_write',       severity: 'HIGH/LOW', color: '#ef4444', desc: 'HIGH for absolute paths or executables, LOW for relative paths with safe extensions (.json, .html, .log).' },
            { name: 'Env variable read',  id: 'env_var_read',     severity: 'MED/LOW',  color: '#f59e0b', desc: 'MEDIUM for unknown vars, LOW for standard config (PATH, HOME) or env iteration.' },
            { name: 'Base64 obfuscation', id: 'base64_literal',   severity: 'MEDIUM',  color: '#f59e0b', desc: 'Base64 encode/decode or large embedded strings (40+ chars).' },
            { name: 'Compiled binary',    id: 'compiled_code',    severity: 'MEDIUM',  color: '#f59e0b', desc: 'Pre-compiled files that cannot be statically analysed.' },
            { name: 'Symlink escape',     id: 'symlink_escape',   severity: 'MEDIUM',  color: '#f59e0b', desc: 'Symlink resolves outside the skill directory.' },
            { name: 'Missing manifest',   id: 'missing_manifest', severity: 'INFO',    color: '#3b82f6', desc: 'No permissions.yml found. Informational \u2014 does not affect risk level.' },
        ];

        const catGrid = document.createElement('div');
        catGrid.style.cssText = 'display: flex; flex-direction: column; gap: 5px; margin-bottom: 18px;';

        categories.forEach(cat => {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; align-items: flex-start; gap: 10px; padding: 9px 12px; background: var(--bg-secondary); border-radius: 7px;';

            const left = document.createElement('div');
            left.style.cssText = 'flex-shrink: 0; width: 130px;';

            const nameEl = document.createElement('div');
            nameEl.style.cssText = 'font-weight: 600; font-size: 12px; color: var(--text-primary); margin-bottom: 3px; line-height: 1.3;';
            nameEl.textContent = cat.name;
            left.appendChild(nameEl);

            const idEl = document.createElement('div');
            idEl.style.cssText = 'font-family: monospace; font-size: 10px; color: var(--text-secondary); margin-bottom: 3px;';
            idEl.textContent = cat.id;
            left.appendChild(idEl);

            const badge = document.createElement('span');
            badge.style.cssText = 'display: inline-block; font-size: 9px; font-weight: 700; color: ' + cat.color + '; background: ' + cat.color + '1a; padding: 1px 5px; border-radius: 3px;';
            badge.textContent = cat.severity;
            left.appendChild(badge);
            row.appendChild(left);

            const descEl = document.createElement('div');
            descEl.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.5;';
            descEl.textContent = cat.desc;
            row.appendChild(descEl);

            catGrid.appendChild(row);
        });
        frag.appendChild(catGrid);

        // ── Risk levels ───────────────────────────────────────────────────
        frag.appendChild(sectionHead('Risk levels'));
        frag.appendChild(para('Findings are aggregated into one risk level. INFO findings do not affect risk.'));

        const riskLevels = [
            { level: 'HIGH',   color: '#ef4444', rule: 'Any CRITICAL or HIGH severity finding' },
            { level: 'MEDIUM', color: '#f59e0b', rule: 'MEDIUM findings only (no HIGH/CRITICAL)' },
            { level: 'LOW',    color: '#10b981', rule: 'No findings, or only LOW/INFO findings' },
        ];

        const riskGrid = document.createElement('div');
        riskGrid.style.cssText = 'display: flex; flex-direction: column; gap: 6px; margin-bottom: 18px;';
        riskLevels.forEach(r => {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; align-items: center; gap: 12px; padding: 10px 12px; background: var(--bg-secondary); border-radius: 8px; border-left: 3px solid ' + r.color + ';';
            const lbl = document.createElement('span');
            lbl.style.cssText = 'flex-shrink: 0; font-size: 12px; font-weight: 800; color: ' + r.color + '; min-width: 64px;';
            lbl.textContent = r.level;
            row.appendChild(lbl);
            const ruleEl = document.createElement('div');
            ruleEl.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.4;';
            ruleEl.textContent = r.rule;
            row.appendChild(ruleEl);
            riskGrid.appendChild(row);
        });
        frag.appendChild(riskGrid);

        // ── Policy Engine ─────────────────────────────────────────────────
        frag.appendChild(sectionHead('Policy Engine'));
        frag.appendChild(para('After scanning, the Policy Engine classifies findings against your permission rules and produces a decision:'));

        const policyDecisions = [
            { action: 'ALLOW', color: '#10b981', bg: 'rgba(16,185,129,0.07)', desc: 'Total score \u2264 3. Safe to install.' },
            { action: 'WARN',  color: '#f59e0b', bg: 'rgba(245,158,11,0.07)', desc: 'Total score 4\u20136. Review findings before installing.' },
            { action: 'BLOCK', color: '#ef4444', bg: 'rgba(239,68,68,0.07)',  desc: 'Total score 7+. Adjust your permission rules or do not install.' },
        ];

        const polGrid = document.createElement('div');
        polGrid.style.cssText = 'display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px;';
        policyDecisions.forEach(p => {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; align-items: center; gap: 12px; padding: 10px 12px; background: ' + p.bg + '; border-radius: 8px; border-left: 3px solid ' + p.color + ';';
            const lbl = document.createElement('span');
            lbl.style.cssText = 'flex-shrink: 0; font-size: 12px; font-weight: 800; color: ' + p.color + '; min-width: 64px;';
            lbl.textContent = p.action;
            row.appendChild(lbl);
            const descEl = document.createElement('div');
            descEl.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.4;';
            descEl.textContent = p.desc;
            row.appendChild(descEl);
            polGrid.appendChild(row);
        });
        frag.appendChild(polGrid);

        frag.appendChild(para('Each finding is matched against your permission rules (Safe +0, Review +2, Dangerous +5). Unclassified findings default to Review (+2). The total score across all findings determines the policy decision.'));

        // ── Skill Permissions ─────────────────────────────────────────────
        frag.appendChild(sectionHead('Your Permission Rules'));
        frag.appendChild(para('Permission rules classify scan findings as Safe (+0), Review (+2), or Dangerous (+5). The total score determines the policy decision: ALLOW (\u22643), WARN (4\u20136), or BLOCK (7+). Rules use glob patterns organized by category: Network, Env Vars, File Paths, and Shell Commands. 218 defaults are pre-loaded.'));
        frag.appendChild(para('Manage rules from the Skill Permissions page \u2014 add custom rules, toggle them, export/import as JSON, or reset to defaults.'));

        // ── How to scan ───────────────────────────────────────────────────
        frag.appendChild(sectionHead('How to scan'));
        frag.appendChild(para('Skills installed in standard locations (~/.openclaw/skills, ~/.mcp/skills, ~/.claude/skills) are auto-detected and shown on the Scanner tab. Select any and click Scan Selected or Scan All. On WSL, Windows-side skill directories are also searched.'));
        frag.appendChild(para('For other sources, use the unified scan input \u2014 paste a local path or a URL (GitHub repo, npm package, .zip/.tar.gz archive) and click Scan. URL skills are downloaded to a temp directory, scanned, and can be installed to ~/.openclaw/skills/ if the policy allows. Results show inline with policy badges. Click any result for the detail drawer. The History tab shows past scans.'));

        frag.appendChild(this.createCodeBlock(
            '# CLI usage\nsecurevector-app scan-skill ~/.openclaw/skills/my-skill\nsecurevector-app scan-skill ./my-skill --output json\nsecurevector-app scan-skill ./my-skill --fail-on medium'
        ));

        // ── Safety limits ─────────────────────────────────────────────────
        frag.appendChild(sectionHead('Safety limits'));

        const limits = [
            ['Max files', '500 source files per scan'],
            ['Max file size', '1 MB per file'],
            ['Max UI paths', '20 directories per request'],
            ['URL download', '50 MB max, HTTPS only, 60s timeout'],
            ['Archive extract', '500 files max, path traversal protection'],
            ['Blocked paths', '/etc, /proc, /sys, /dev, /root, /bin, /sbin, /usr/bin'],
        ];

        const limitsGrid = document.createElement('div');
        limitsGrid.style.cssText = 'display: flex; flex-direction: column; gap: 5px; margin-bottom: 18px;';
        limits.forEach(([label, desc]) => {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; align-items: flex-start; gap: 12px; padding: 8px 12px; background: var(--bg-secondary); border-radius: 6px;';
            const lbl = document.createElement('div');
            lbl.style.cssText = 'flex-shrink: 0; width: 120px; font-size: 12px; font-weight: 600; color: var(--text-primary); line-height: 1.4;';
            lbl.textContent = label;
            row.appendChild(lbl);
            const dsc = document.createElement('div');
            dsc.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.4;';
            dsc.textContent = desc;
            row.appendChild(dsc);
            limitsGrid.appendChild(row);
        });
        frag.appendChild(limitsGrid);

        // ── Skill manifest ────────────────────────────────────────────────
        frag.appendChild(sectionHead('Skill manifest (optional, by skill author)'));
        frag.appendChild(para('Skill authors can ship a permissions.yml inside their skill directory declaring what the skill needs. When present, declared network domains and file paths are automatically allowed (not flagged as findings). Everything else is classified by your permission rules.'));
        frag.appendChild(this.createCodeBlock(
            '# <skill-dir>/permissions.yml\npermissions:\n  networks:\n    - api.openai.com\n  files:\n    - ./output/\n  env_vars:\n    - OPENAI_API_KEY'
        ));
        frag.appendChild(note('Note: ', 'A missing manifest produces an INFO finding only \u2014 it does not affect risk level. You don\'t create this file \u2014 it comes with the skill. Without a manifest, all behavior is classified by your permission rules.', 'var(--accent-primary)'));

        // ── AI Analysis section ──────────────────────────────────────────
        frag.appendChild(sectionHead('AI-Powered False-Positive Reduction'));
        frag.appendChild(para('Static analysis is fast but context-blind \u2014 it flags patterns like subprocess.Popen or os.environ without understanding intent. Enable AI Analysis to have an LLM review each finding and mark false positives automatically.'));

        const aiSteps = document.createElement('ol');
        aiSteps.style.cssText = 'margin: 8px 0 8px 20px; font-size: 13px; color: var(--text-primary); line-height: 1.8;';
        const stepTexts = [
            ['Go to ', 'Settings \u2192 AI / LLM', ' and enable AI analysis'],
            ['Choose a provider: Ollama (free, local), OpenAI, Anthropic, Azure, or Bedrock'],
            ['Configure the model and API key (Ollama needs no key)'],
            ['Scan a skill \u2014 AI review runs automatically on every scan'],
        ];
        stepTexts.forEach(parts => {
            const li = document.createElement('li');
            parts.forEach((p, i) => {
                if (i === 1 && parts.length === 3) {
                    const b = document.createElement('strong');
                    b.textContent = p;
                    li.appendChild(b);
                } else {
                    li.appendChild(document.createTextNode(p));
                }
            });
            aiSteps.appendChild(li);
        });
        frag.appendChild(aiSteps);

        frag.appendChild(para('When AI is enabled, you\u2019ll see \u201C\u2728 AI Analysis Enabled\u201D in the Skill Scanner and Threat Monitor headers. Each finding shows an AI verdict: CONFIRMED (real threat) or FALSE POSITIVE (struck through with explanation). The risk level is recalculated using only confirmed findings.'));

        frag.appendChild(note('Tip: ', 'Use a local Ollama model (e.g. llama3) for zero-cost AI review. Cloud APIs cost ~$0.001 per scan.', '#10b981'));

        // ── Nav button ────────────────────────────────────────────────────
        const navBtn = document.createElement('button');
        navBtn.className = 'btn btn-primary';
        navBtn.style.cssText = 'font-size: 12px; padding: 6px 14px;';
        navBtn.textContent = 'Open Skill Scanner';
        navBtn.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate('skill-scanner'); });
        frag.appendChild(navBtn);

        return frag;
    },

    buildTroubleshootingContent() {
        const frag = document.createElement('div');
        frag.style.cssText = 'padding-top: 16px;';

        const issues = [
            {
                title: 'App is running but not analyzing anything',
                cause: 'Your agent or OpenClaw gateway was started without the environment variable pointing to the SecureVector proxy.',
                fix: [
                    'Stop your agent/gateway if running.',
                    'In the same terminal session, set the proxy URL:',
                    { code: 'export OPENAI_BASE_URL=http://localhost:8742/openai/v1\nexport ANTHROPIC_BASE_URL=http://localhost:8742/anthropic' },
                    'Restart your agent in the same terminal. Traffic should now appear in the Threat Monitor.',
                ],
                note: 'OpenClaw users: use ANTHROPIC_BASE_URL=http://localhost:8742/anthropic when starting the gateway.',
            },
            {
                title: 'Google Gemini API key — 401 Unauthorized error',
                cause: 'The Google API key must be available in the environment where SecureVector is running, not just where your agent runs.',
                fix: [
                    'Stop SecureVector.',
                    'In the same terminal where you will run SecureVector, set your key:',
                    { code: 'export GOOGLE_API_KEY=your-key-here' },
                    'Then start SecureVector in that terminal:',
                    { code: 'securevector-app --web' },
                    'Your agent can now route Gemini calls through the proxy.',
                ],
                note: 'This applies to any provider key that SecureVector needs to forward: set it before starting the app.',
            },
            {
                title: 'Dashboard shows no data / Threat Monitor is empty',
                cause: 'The proxy may not be running, or your agent is still pointing at the provider directly.',
                fix: [
                    'Check the sidebar bottom — you should see a coloured "proxy running" banner.',
                    'If not, go to Integrations in the sidebar and start the proxy for your framework.',
                    'Verify your agent\'s base URL points to localhost:8742 (not the provider\'s URL).',
                    'Send a test request from your agent and refresh the dashboard.',
                ],
            },
            {
                title: 'Threats are detected but not being blocked',
                cause: 'Block Mode may be toggled off — in Log Mode, threats are recorded but not stopped.',
                fix: [
                    'Look at the header bar — the "Block" toggle should show red/active.',
                    'Click the toggle to switch from Log Mode to Block Mode.',
                    'Block Mode is the default; it gets reset to Log Mode only if you toggled it manually.',
                ],
            },
            {
                title: 'Cost Tracking shows $0.00 for all requests',
                cause: 'The model name returned by the provider does not match a known pricing entry, or token counts were not included in the response.',
                fix: [
                    'Go to Cost Tracking → Pricing Reference and check if your model is listed.',
                    'Some providers return snapshot model names (e.g. gpt-4o-2024-08-06) instead of aliases — both are matched.',
                    'For Ollama, $0.00 is correct — local models have no API cost.',
                    'If a model is missing, open an issue on GitHub with the model name and provider.',
                ],
            },
            {
                title: 'Tool permissions rules are not being enforced',
                cause: 'Tool enforcement may be disabled in settings, or your agent framework does not route tool call decisions through the proxy.',
                fix: [
                    'Go to Settings and check that "Tool Enforcement" is enabled.',
                    'Tool permissions work by intercepting tool calls forwarded through the SecureVector proxy.',
                    'If your agent calls tools directly (not via the LLM proxy response), they bypass the proxy and cannot be intercepted.',
                    'For MCP tools, use the MCP Server integration — see Guide → API Reference for the MCP setup.',
                ],
            },
            {
                title: 'Port 8741 or 8742 is already in use',
                cause: 'Another process is using the SecureVector app port (8741) or proxy port (8742).',
                fix: [
                    'Find and stop the conflicting process:',
                    { code: 'lsof -i :8741\nlsof -i :8742' },
                    'Or start SecureVector on a custom port — the proxy starts automatically on app port + 1:',
                    { code: 'securevector-app --web --port 8800\n# App runs on 8800, proxy runs automatically on 8801' },
                    'To override the proxy port explicitly, use --proxy-port:',
                    { code: 'securevector-app --web --port 8800 --proxy-port 8900\n# App on 8800, proxy on 8900' },
                    'Update your agent\'s provider URL to point at the proxy port:',
                    { code: 'export OPENAI_BASE_URL=http://localhost:8801/openai/v1\nexport ANTHROPIC_BASE_URL=http://localhost:8801/anthropic' },
                ],
                note: 'The proxy port is always app port + 1 by default. App on 8800 → proxy on 8801. Use --proxy-port to set a different port.',
            },
        ];

        issues.forEach((issue, idx) => {
            const box = document.createElement('div');
            box.style.cssText = 'background: var(--bg-secondary); border-radius: 8px; margin-bottom: 8px; overflow: hidden; border-left: 3px solid ' + (idx < 2 ? '#f59e0b' : 'var(--border-color)') + ';';

            // Clickable header
            const header = document.createElement('div');
            header.style.cssText = 'padding: 10px 16px; display: flex; align-items: flex-start; justify-content: space-between; cursor: pointer; user-select: none; gap: 12px;';
            header.addEventListener('mouseenter', () => { header.style.background = 'rgba(94,173,184,0.04)'; });
            header.addEventListener('mouseleave', () => { header.style.background = ''; });

            const titleEl = document.createElement('div');
            titleEl.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--text-primary); line-height: 1.4;';
            titleEl.textContent = issue.title;
            header.appendChild(titleEl);

            const indicator = document.createElement('span');
            indicator.style.cssText = 'font-size: 16px; font-weight: 300; color: var(--text-secondary); flex-shrink: 0; margin-top: 1px;';
            indicator.textContent = '+';
            header.appendChild(indicator);
            box.appendChild(header);

            // Body
            const body = document.createElement('div');
            body.style.cssText = 'display: none; padding: 0 16px 14px 16px;';

            if (issue.cause) {
                const causeEl = document.createElement('div');
                causeEl.style.cssText = 'font-size: 12px; color: var(--text-secondary); margin-bottom: 10px; line-height: 1.5; padding: 8px 10px; background: var(--bg-tertiary); border-radius: 6px; border-left: 2px solid #f59e0b;';
                const causeLabel = document.createElement('strong');
                causeLabel.style.color = 'var(--text-primary)';
                causeLabel.textContent = 'Likely cause: ';
                causeEl.appendChild(causeLabel);
                causeEl.appendChild(document.createTextNode(issue.cause));
                body.appendChild(causeEl);
            }

            const fixLabel = document.createElement('div');
            fixLabel.style.cssText = 'font-size: 11px; font-weight: 700; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px;';
            fixLabel.textContent = 'Fix:';
            body.appendChild(fixLabel);

            const olCss = 'margin: 0; padding-left: 18px; font-size: 12px; color: var(--text-secondary); line-height: 1.7; display: flex; flex-direction: column; gap: 4px;';
            let currentOl = document.createElement('ol');
            currentOl.style.cssText = olCss;
            let olHasItems = false;

            issue.fix.forEach(step => {
                if (step && step.code) {
                    if (olHasItems) {
                        body.appendChild(currentOl);
                        currentOl = document.createElement('ol');
                        currentOl.style.cssText = olCss;
                        currentOl.style.marginTop = '6px';
                        olHasItems = false;
                    }
                    body.appendChild(this.createCodeBlock(step.code));
                } else {
                    const li = document.createElement('li');
                    li.textContent = step;
                    currentOl.appendChild(li);
                    olHasItems = true;
                }
            });

            if (olHasItems) {
                body.appendChild(currentOl);
            }

            if (issue.note) {
                const noteEl = document.createElement('div');
                noteEl.style.cssText = 'margin-top: 10px; font-size: 11.5px; color: var(--text-secondary); padding: 7px 10px; background: rgba(94,173,184,0.05); border-radius: 6px; border-left: 2px solid var(--accent-primary); line-height: 1.5;';
                const noteLabel = document.createElement('strong');
                noteLabel.style.color = 'var(--accent-primary)';
                noteLabel.textContent = 'Note: ';
                noteEl.appendChild(noteLabel);
                noteEl.appendChild(document.createTextNode(issue.note));
                body.appendChild(noteEl);
            }

            box.appendChild(body);

            header.addEventListener('click', () => {
                const hidden = body.style.display === 'none';
                body.style.display = hidden ? 'block' : 'none';
                indicator.textContent = hidden ? '\u2212' : '+';
            });

            frag.appendChild(box);
        });

        // Footer link to GitHub issues
        const footer = document.createElement('div');
        footer.style.cssText = 'margin-top: 12px; font-size: 12px; color: var(--text-secondary);';
        footer.appendChild(document.createTextNode('Still stuck? '));
        const issueLink = document.createElement('a');
        issueLink.href = 'https://github.com/Secure-Vector/securevector-ai-threat-monitor/issues';
        issueLink.target = '_blank';
        issueLink.style.cssText = 'color: var(--accent-primary); text-decoration: none;';
        issueLink.textContent = 'Open an issue on GitHub';
        issueLink.addEventListener('mouseenter', () => { issueLink.style.textDecoration = 'underline'; });
        issueLink.addEventListener('mouseleave', () => { issueLink.style.textDecoration = 'none'; });
        footer.appendChild(issueLink);
        footer.appendChild(document.createTextNode(' or join our Discord for help.'));
        frag.appendChild(footer);

        return frag;
    },

    buildAPIContent() {
        const frag = document.createElement('div');
        frag.style.cssText = 'padding-top: 16px;';

        // ── OpenAPI docs — highlighted hero card ─────────────────────────
        const docsCard = document.createElement('div');
        docsCard.style.cssText = 'padding: 16px 20px; background: var(--bg-secondary); border: 1px solid var(--accent-primary); border-radius: 10px; margin-bottom: 14px; cursor: pointer; transition: background 0.15s;';
        docsCard.addEventListener('mouseenter', () => { docsCard.style.background = 'rgba(94,173,184,0.06)'; });
        docsCard.addEventListener('mouseleave', () => { docsCard.style.background = 'var(--bg-secondary)'; });
        docsCard.addEventListener('click', () => { window.open('/docs', '_blank'); });

        const docsTop = document.createElement('div');
        docsTop.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;';

        const docsTitleWrap = document.createElement('div');
        docsTitleWrap.style.cssText = 'display: flex; align-items: center; gap: 10px;';

        const docsTitle = document.createElement('div');
        docsTitle.style.cssText = 'font-weight: 700; font-size: 15px; color: var(--accent-primary);';
        docsTitle.textContent = 'OpenAPI Interactive Docs';
        docsTitleWrap.appendChild(docsTitle);

        const docsBadge = document.createElement('span');
        docsBadge.className = 'badge badge-success';
        docsBadge.textContent = 'Live';
        docsTitleWrap.appendChild(docsBadge);

        docsTop.appendChild(docsTitleWrap);

        const docsArrow = document.createElement('span');
        docsArrow.style.cssText = 'font-size: 16px; color: var(--accent-primary); opacity: 0.7;';
        docsArrow.textContent = '↗';
        docsTop.appendChild(docsArrow);

        docsCard.appendChild(docsTop);

        const docsDesc = document.createElement('div');
        docsDesc.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 12px;';
        docsDesc.textContent = 'Browse and test every REST endpoint directly in your browser. No extra tools needed — authentication, request bodies, and live responses all in one place.';
        docsCard.appendChild(docsDesc);

        const docsBtn = document.createElement('button');
        docsBtn.className = 'btn btn-primary';
        docsBtn.style.cssText = 'font-size: 12px; padding: 6px 16px; pointer-events: none;';
        docsBtn.textContent = 'Open API Docs';
        docsCard.appendChild(docsBtn);

        frag.appendChild(docsCard);

        // ── Secondary links ──────────────────────────────────────────────
        const linksGrid = document.createElement('div');
        linksGrid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px;';

        [
            { title: 'Integrations', desc: 'Framework-specific setup guides', page: 'integrations' },
            { title: 'Settings', desc: 'Configure scanning, modes, and providers', page: 'settings' },
        ].forEach(link => {
            const item = document.createElement('div');
            item.style.cssText = 'padding: 12px 14px; background: var(--bg-secondary); border-radius: 8px; cursor: pointer; transition: border-color 0.15s; border: 1px solid var(--border-color);';
            item.addEventListener('mouseenter', () => { item.style.borderColor = 'var(--accent-primary)'; });
            item.addEventListener('mouseleave', () => { item.style.borderColor = 'var(--border-color)'; });
            item.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate(link.page); });

            const titleEl = document.createElement('div');
            titleEl.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--accent-primary); margin-bottom: 2px;';
            titleEl.textContent = link.title;
            item.appendChild(titleEl);

            const descEl = document.createElement('div');
            descEl.style.cssText = 'font-size: 11px; color: var(--text-secondary);';
            descEl.textContent = link.desc;
            item.appendChild(descEl);

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

            if (text.startsWith('**') && text.endsWith('**')) {
                const bold = document.createElement('strong');
                bold.style.cssText = 'color: var(--text-primary); font-weight: 700;';
                bold.textContent = text.slice(2, -2);
                item.appendChild(bold);
            } else {
                item.appendChild(document.createTextNode(text));
            }
            list.appendChild(item);
        });
        return list;
    },

    createExampleBox(title, scenario, steps, flow) {
        const box = document.createElement('div');
        box.style.cssText = 'background: var(--bg-secondary); border-radius: 8px; margin-bottom: 10px; overflow: hidden; border-left: 3px solid var(--accent-primary);';

        // Clickable header
        const header = document.createElement('div');
        header.style.cssText = 'padding: 10px 16px; display: flex; align-items: center; justify-content: space-between; cursor: pointer; user-select: none;';

        const titleEl = document.createElement('div');
        titleEl.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--text-primary);';
        titleEl.textContent = title;
        header.appendChild(titleEl);

        const indicator = document.createElement('span');
        indicator.style.cssText = 'font-size: 16px; font-weight: 300; color: var(--text-secondary); flex-shrink: 0;';
        indicator.textContent = '+';
        header.appendChild(indicator);

        box.appendChild(header);

        // Collapsible body
        const body = document.createElement('div');
        body.style.cssText = 'display: none; padding: 0 16px 14px 16px;';

        const desc = document.createElement('div');
        desc.style.cssText = 'font-size: 12px; color: var(--text-secondary); margin-bottom: 10px; line-height: 1.4;';
        desc.textContent = scenario;
        body.appendChild(desc);

        if (Array.isArray(steps)) {
            const ol = document.createElement('ol');
            ol.style.cssText = 'margin: 0; padding-left: 18px; font-size: 12px; color: var(--text-secondary); line-height: 1.6;';
            steps.forEach(step => {
                const li = document.createElement('li');
                li.style.cssText = 'margin-bottom: 2px;';
                if (Array.isArray(step)) {
                    step.forEach(part => {
                        if (typeof part === 'string') {
                            li.appendChild(document.createTextNode(part));
                        } else if (part && part.copy) {
                            li.appendChild(this.createInlineCopy(part.copy));
                        }
                    });
                } else {
                    li.textContent = step;
                }
                ol.appendChild(li);
            });
            body.appendChild(ol);
        } else {
            body.appendChild(this.createCodeBlock(steps));
        }

        if (flow) {
            const flowEl = document.createElement('div');
            flowEl.style.cssText = 'margin-top: 8px; font-size: 11px; color: var(--text-secondary); font-family: monospace; padding: 6px 10px; background: var(--bg-tertiary); border-radius: 4px; text-align: center;';
            flowEl.textContent = flow;
            body.appendChild(flowEl);
        }

        box.appendChild(body);

        header.addEventListener('click', () => {
            const hidden = body.style.display === 'none';
            body.style.display = hidden ? 'block' : 'none';
            indicator.textContent = hidden ? '\u2212' : '+';
        });

        return box;
    },

    createMiniStep(number, title, description) {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display: flex; gap: 12px; margin-bottom: 4px;';

        const num = document.createElement('span');
        num.style.cssText = 'width: 26px; height: 26px; background: var(--bg-tertiary); color: var(--text-secondary); border: 1px solid var(--border-light); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; flex-shrink: 0; margin-top: 1px;';
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

    createInlineCopy(text) {
        const wrapper = document.createElement('span');
        wrapper.style.cssText = 'display: inline-flex; align-items: center; gap: 4px;';

        const code = document.createElement('code');
        code.style.cssText = 'font-family: monospace; font-size: 11px; background: var(--bg-tertiary); padding: 1px 6px; border-radius: 3px; color: var(--accent-primary); border: 1px solid var(--border-color);';
        code.textContent = text;
        wrapper.appendChild(code);

        const btn = document.createElement('button');
        btn.style.cssText = 'border: none; background: none; cursor: pointer; padding: 0 2px; color: var(--text-secondary); font-size: 12px; line-height: 1; vertical-align: middle; opacity: 0.6; transition: opacity 0.15s;';
        btn.textContent = '\u2398';
        btn.title = 'Copy';
        btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
        btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.6'; });
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(text).then(() => {
                btn.textContent = '\u2713';
                btn.style.color = 'var(--success, #10b981)';
                btn.style.opacity = '1';
                setTimeout(() => {
                    btn.textContent = '\u2398';
                    btn.style.color = 'var(--text-secondary)';
                    btn.style.opacity = '0.6';
                }, 1500);
            });
        });
        wrapper.appendChild(btn);

        return wrapper;
    },

    createCodeBlock(code) {
        // Substitute actual running ports and host so display and Copy both show the right values
        const _pp = window.__SV_PROXY_PORT; const _wp = window.__SV_WEB_PORT;
        const _host = window.__SV_HOST;
        if (_pp && _pp !== 8742) code = code.replaceAll(':8742', ':' + _pp);
        if (_wp && _wp !== 8741) code = code.replaceAll(':8741', ':' + _wp);
        if (_host && _host !== 'localhost' && _host !== '127.0.0.1') {
            code = code.replaceAll('://localhost:', '://' + _host + ':').replaceAll('://127.0.0.1:', '://' + _host + ':');
        }

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
