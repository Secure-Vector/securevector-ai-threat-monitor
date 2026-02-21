/**
 * Dashboard Page
 * Enhanced overview with stats, charts, and recent activity
 */

const DashboardPage = {
    data: null,
    threats: null,
    autoRefreshInterval: null,
    autoRefreshEnabled: false,
    currentContainer: null,

    async render(container) {
        this.currentContainer = container;
        container.textContent = '';

        // Loading state
        const loading = document.createElement('div');
        loading.className = 'loading-container';
        const spinner = document.createElement('div');
        spinner.className = 'spinner';
        loading.appendChild(spinner);
        container.appendChild(loading);

        try {
            // Fetch analytics and recent threats
            const [analytics, threats] = await Promise.all([
                API.getThreatAnalytics(),
                API.getThreats({ page_size: 50 }),
            ]);
            this.data = analytics;
            this.threats = threats.items || [];
            this.renderContent(container);
        } catch (error) {
            this.renderError(container, error);
        }
    },

    async renderContent(container) {
        container.textContent = '';

        // Budget guardian alerts — rendered first so they're impossible to miss
        try {
            const gd = await API.getBudgetGuardian();
            if (gd) {
                const hasGlobalAlert = gd.global_budget_usd != null && (gd.global_over_budget || gd.global_warning);
                const hasAgentAlerts = gd.agent_alerts && gd.agent_alerts.some(a => a.over_budget || a.warning);
                if (hasGlobalAlert || hasAgentAlerts) {
                    const alertsBox = document.createElement('div');
                    alertsBox.style.cssText = 'margin-bottom: 16px; display: flex; flex-direction: column; gap: 8px;';

                    const buildBudgetBar = (label, today, budget, pct, over, action) => {
                        const overColor = 'rgba(220,38,38,0.75)';
                        const warnColor = 'rgba(180,130,0,0.75)';
                        const color = over ? overColor : warnColor;
                        const bar = document.createElement('div');
                        bar.style.cssText = `padding: 10px 14px; border-radius: 8px; border: 1px solid ${color}; background: ${over ? 'rgba(220,38,38,0.06)' : 'rgba(180,130,0,0.06)'}; display: flex; align-items: center; gap: 12px;`;

                        const info = document.createElement('div');
                        info.style.cssText = 'flex: 1; min-width: 0;';

                        const infoTop = document.createElement('div');
                        infoTop.style.cssText = 'font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px;';
                        infoTop.textContent = `${label}: $${today.toFixed(4)} of $${budget.toFixed(2)} today (${Math.round(pct * 100)}%)`;
                        info.appendChild(infoTop);

                        const track = document.createElement('div');
                        track.style.cssText = 'height: 5px; border-radius: 3px; background: var(--bg-tertiary); overflow: hidden;';
                        const fill = document.createElement('div');
                        fill.style.cssText = `height: 100%; border-radius: 3px; background: ${color}; width: ${Math.min(pct * 100, 100)}%;`;
                        track.appendChild(fill);
                        info.appendChild(track);
                        bar.appendChild(info);

                        const badge = document.createElement('span');
                        badge.className = over && action === 'block' ? 'badge badge-error' : 'badge badge-warning';
                        badge.textContent = over && action === 'block' ? 'Blocked' : over ? 'Over limit' : '80%+ used';
                        bar.appendChild(badge);

                        const goBtn = document.createElement('button');
                        goBtn.className = 'btn btn-secondary btn-sm';
                        goBtn.textContent = 'View →';
                        goBtn.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate('cost-settings'); });
                        bar.appendChild(goBtn);

                        return bar;
                    };

                    if (hasGlobalAlert) {
                        alertsBox.appendChild(buildBudgetBar(
                            'Global budget', gd.global_today_spend_usd,
                            gd.global_budget_usd, gd.global_pct_used,
                            gd.global_over_budget, gd.global_budget_action
                        ));
                    }
                    if (hasAgentAlerts) {
                        gd.agent_alerts.filter(a => a.over_budget || a.warning).forEach(a => {
                            alertsBox.appendChild(buildBudgetBar(
                                a.agent_id.length > 28 ? a.agent_id.slice(0, 28) + '…' : a.agent_id,
                                a.today_spend_usd, a.budget_usd, a.pct_used,
                                a.over_budget, a.budget_action
                            ));
                        });
                    }
                    container.appendChild(alertsBox);
                }
            }
        } catch (e) { /* budget alerts are non-critical */ }


        // First-run onboarding — show when no threats have been analyzed yet
        if (!this.data.total_threats && (!this.threats || this.threats.length === 0)) {
            const onboard = document.createElement('div');
            onboard.style.cssText = 'background: var(--bg-card); border: 1px solid var(--accent-primary); border-radius: 8px; padding: 20px; margin-bottom: 16px;';

            const onboardTitle = document.createElement('div');
            onboardTitle.style.cssText = 'font-size: 16px; font-weight: 700; color: var(--text-primary); margin-bottom: 4px;';
            onboardTitle.textContent = 'No traffic detected yet';
            onboard.appendChild(onboardTitle);

            const onboardDesc = document.createElement('div');
            onboardDesc.style.cssText = 'font-size: 13px; color: var(--text-secondary); margin-bottom: 16px;';
            onboardDesc.textContent = 'The SecureVector proxy is running. Choose the path that matches your setup:';
            onboard.appendChild(onboardDesc);

            // Two-path layout
            const pathsRow = document.createElement('div');
            pathsRow.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 12px;';

            // Path 1 — OpenClaw (default)
            const pathA = document.createElement('div');
            pathA.style.cssText = 'background: var(--bg-secondary); border: 1px solid var(--border-default); border-radius: 6px; padding: 14px;';

            const pathABadge = document.createElement('div');
            pathABadge.style.cssText = 'display: inline-block; font-size: 10px; font-weight: 700; background: var(--accent-primary); color: white; border-radius: 4px; padding: 2px 7px; margin-bottom: 8px; letter-spacing: 0.4px; text-transform: uppercase;';
            pathABadge.textContent = 'Quickest';
            pathA.appendChild(pathABadge);

            const pathATitle = document.createElement('div');
            pathATitle.style.cssText = 'font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 6px;';
            pathATitle.textContent = 'Point your agent to the proxy';
            pathA.appendChild(pathATitle);

            const pathADesc = document.createElement('div');
            pathADesc.style.cssText = 'font-size: 12px; color: var(--text-secondary); margin-bottom: 10px; line-height: 1.5;';
            pathADesc.textContent = 'Set one environment variable and traffic flows through SecureVector automatically:';
            pathA.appendChild(pathADesc);

            const pathACode = document.createElement('div');
            pathACode.style.cssText = 'font-size: 11px; font-family: monospace; background: var(--bg-tertiary); color: var(--accent-primary); padding: 5px 8px; border-radius: 4px; margin-bottom: 10px; word-break: break-all;';
            pathACode.textContent = 'OPENAI_BASE_URL=http://localhost:8742/openai/v1';
            pathA.appendChild(pathACode);

            const pathABtn = document.createElement('button');
            pathABtn.className = 'btn btn-primary';
            pathABtn.style.cssText = 'font-size: 11px; padding: 5px 12px; width: 100%;';
            pathABtn.textContent = 'Getting Started Guide →';
            pathABtn.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate('guide'); });
            pathA.appendChild(pathABtn);

            // Path 2 — Pick an integration
            const pathB = document.createElement('div');
            pathB.style.cssText = 'background: var(--bg-secondary); border: 1px solid var(--border-default); border-radius: 6px; padding: 14px;';

            const pathBTitle = document.createElement('div');
            pathBTitle.style.cssText = 'font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 6px; margin-top: 22px;';
            pathBTitle.textContent = 'Using a specific framework?';
            pathB.appendChild(pathBTitle);

            const pathBDesc = document.createElement('div');
            pathBDesc.style.cssText = 'font-size: 12px; color: var(--text-secondary); margin-bottom: 10px; line-height: 1.5;';
            pathBDesc.textContent = 'LangChain, LangGraph, CrewAI, n8n, Ollama, or OpenClaw — step-by-step guides in the Integrations section.';
            pathB.appendChild(pathBDesc);

            const pathBBtn = document.createElement('button');
            pathBBtn.className = 'btn btn-secondary';
            pathBBtn.style.cssText = 'font-size: 11px; padding: 5px 12px; width: 100%;';
            pathBBtn.textContent = 'View All Integrations →';
            pathBBtn.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate('integrations'); });
            pathB.appendChild(pathBBtn);

            pathsRow.appendChild(pathA);
            pathsRow.appendChild(pathB);
            onboard.appendChild(pathsRow);

            const guideLink = document.createElement('div');
            guideLink.style.cssText = 'margin-top: 12px; font-size: 12px; color: var(--text-muted);';
            const guideText = document.createTextNode('Need more details? ');
            guideLink.appendChild(guideText);
            const guideBtn = document.createElement('a');
            guideBtn.style.cssText = 'color: var(--accent-primary); cursor: pointer; text-decoration: underline;';
            guideBtn.textContent = 'Read the Guide';
            guideBtn.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate('guide'); });
            guideLink.appendChild(guideBtn);
            onboard.appendChild(guideLink);

            container.appendChild(onboard);
        }

        // "What's New" feature discovery strip — shown until dismissed
        if (!localStorage.getItem('sv-newfeatures-dismissed')) {
            const strip = document.createElement('div');
            strip.style.cssText = 'margin-bottom: 16px;';

            const stripHeader = document.createElement('div');
            stripHeader.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;';

            const stripTitle = document.createElement('div');
            stripTitle.style.cssText = 'display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px;';
            const pulseDot = document.createElement('span');
            pulseDot.style.cssText = 'display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #f97316; flex-shrink: 0;';
            stripTitle.appendChild(pulseDot);
            stripTitle.appendChild(document.createTextNode("What's New"));
            stripHeader.appendChild(stripTitle);

            const dismissBtn = document.createElement('button');
            dismissBtn.style.cssText = 'display: flex; align-items: center; gap: 4px; padding: 2px 10px; border-radius: var(--radius-full); font-size: 11px; font-weight: 600; border: 1px solid var(--border-default); background: var(--bg-secondary); color: var(--text-secondary); cursor: pointer; transition: all 0.15s;';
            dismissBtn.textContent = '✕ Dismiss';
            dismissBtn.title = 'Dismiss';
            dismissBtn.addEventListener('mouseenter', () => { dismissBtn.style.borderColor = '#ef4444'; dismissBtn.style.color = '#ef4444'; });
            dismissBtn.addEventListener('mouseleave', () => { dismissBtn.style.borderColor = 'var(--border-default)'; dismissBtn.style.color = 'var(--text-secondary)'; });
            dismissBtn.addEventListener('click', () => {
                localStorage.setItem('sv-newfeatures-dismissed', '1');
                strip.remove();
            });
            stripHeader.appendChild(dismissBtn);
            strip.appendChild(stripHeader);

            const featureCards = document.createElement('div');
            featureCards.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 10px;';

            const makeFeatureCard = (title, desc, page) => {
                const card = document.createElement('div');
                card.style.cssText = 'background: var(--bg-card); border: 1px solid rgba(0,188,212,0.22); border-radius: 8px; padding: 14px; cursor: pointer; transition: border-color 0.15s;';
                card.addEventListener('mouseenter', () => card.style.borderColor = 'rgba(0,188,212,0.5)');
                card.addEventListener('mouseleave', () => card.style.borderColor = 'rgba(0,188,212,0.22)');

                const badge = document.createElement('div');
                badge.style.cssText = 'display: inline-block; font-size: 9px; font-weight: 700; background: rgba(249,115,22,0.12); color: #f97316; border-radius: 3px; padding: 1px 6px; margin-bottom: 8px; letter-spacing: 0.4px; text-transform: uppercase;';
                badge.textContent = 'New';
                card.appendChild(badge);

                const cardTitle = document.createElement('div');
                cardTitle.style.cssText = 'font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 5px;';
                cardTitle.textContent = title;
                card.appendChild(cardTitle);

                const cardDesc = document.createElement('div');
                cardDesc.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 10px;';
                cardDesc.textContent = desc;
                card.appendChild(cardDesc);

                const link = document.createElement('span');
                link.style.cssText = 'font-size: 11px; font-weight: 600; color: var(--accent-primary);';
                link.textContent = 'Set up →';
                card.appendChild(link);

                card.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate(page); });
                return card;
            };

            featureCards.appendChild(makeFeatureCard(
                'Tool Permissions',
                'Control exactly which tools your agent is allowed to call. Block risky file, shell, or network operations before they run.',
                'tool-permissions'
            ));
            featureCards.appendChild(makeFeatureCard(
                'Cost Tracking',
                'Track every dollar your agents spend per model and session. Set daily budgets to hard-stop runaway LLM costs.',
                'cost-settings'
            ));

            strip.appendChild(featureCards);
            container.appendChild(strip);
        }

        // 1. Security Controls — most actionable, show first
        const securityControls = await this.renderSecurityControls();
        container.appendChild(securityControls);

        // 2. Stats row — Analyzed Requests, Critical, Today's Cost
        const statsGrid = document.createElement('div');
        statsGrid.className = 'stats-grid';

        let todayCostStr = '—';
        let totalCostStr = '—';
        try {
            const [summary, costSummary] = await Promise.all([
                API.getDashboardCostSummary(),
                API.getCostSummary().catch(() => null),
            ]);
            todayCostStr = '$' + (summary.today_cost_usd || 0).toFixed(4);
            if (costSummary && costSummary.totals && costSummary.totals.total_cost_usd != null) {
                totalCostStr = '$' + Number(costSummary.totals.total_cost_usd).toFixed(4);
            }
        } catch (e) {}

        const avgLatencyMs = this.data.avg_latency_ms;
        let latencyStr = '—';
        if (avgLatencyMs != null) {
            latencyStr = avgLatencyMs >= 1000
                ? (avgLatencyMs / 1000).toFixed(1) + 's'
                : Math.round(avgLatencyMs) + 'ms';
        }

        const stats = [
            { value: this.data.total_threats || 0, label: 'Analyzed Requests', icon: 'shield', color: 'primary', tooltip: 'Total number of LLM requests intercepted and scanned by SecureVector since installation.' },
            { value: this.data.critical_count || 0, label: 'Critical', icon: 'alert', color: 'danger', tooltip: 'Requests flagged as high-risk (risk score ≥ 75). These may indicate prompt injection, jailbreak attempts, or data exfiltration.' },
            { value: latencyStr, label: 'Avg Analysis Time', icon: 'activity', color: 'primary', raw: true, tooltip: 'Average time SecureVector adds per request (rule-based only). Typically 10–50ms. Enabling AI analysis adds 1–3s per request.' },
            { value: todayCostStr, label: "Today's Cost", icon: 'clock', color: 'primary', raw: true, tooltip: "Estimated LLM provider cost (USD) for today's requests, based on token usage and model pricing." },
            { value: totalCostStr, label: 'Total Cost', icon: 'gauge', color: 'primary', raw: true, tooltip: 'Cumulative estimated LLM provider cost (USD) across all intercepted requests since installation.' },
        ];

        statsGrid.style.marginBottom = '16px';
        stats.forEach(stat => statsGrid.appendChild(this.createStatCard(stat)));
        container.appendChild(statsGrid);

        // 2b. Tool Permissions quick-stats widget
        try {
            const [toolsData, settings] = await Promise.all([
                API.getEssentialTools().catch(() => null),
                API.getSettings().catch(() => null),
            ]);
            if (toolsData && toolsData.tools) {
                const tools = toolsData.tools;
                const blocked = tools.filter(t => t.effective_action === 'block').length;
                const allowed = tools.filter(t => t.effective_action === 'allow').length;
                const enforcementOn = settings && settings.tool_permissions_enabled;

                const toolWidget = document.createElement('div');
                toolWidget.style.cssText = 'margin-bottom: 16px; background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 10px; padding: 14px 18px; display: flex; align-items: center; gap: 20px; flex-wrap: wrap; cursor: pointer; transition: border-color 0.15s;';
                toolWidget.addEventListener('mouseenter', () => { toolWidget.style.borderColor = 'rgba(6,182,212,0.4)'; });
                toolWidget.addEventListener('mouseleave', () => { toolWidget.style.borderColor = 'var(--border-default)'; });
                toolWidget.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate('tool-permissions'); });

                // Icon + title
                const titlePart = document.createElement('div');
                titlePart.style.cssText = 'display: flex; align-items: center; gap: 8px; flex-shrink: 0;';
                const toolIcon = document.createElement('span');
                toolIcon.style.cssText = 'font-size: 18px;';
                toolIcon.textContent = '🎛️';
                const titleText = document.createElement('div');
                titleText.style.cssText = 'font-size: 12px; font-weight: 700; color: var(--text-primary); text-transform: uppercase; letter-spacing: 0.5px;';
                titleText.textContent = 'Tool Permissions';
                titlePart.appendChild(toolIcon);
                titlePart.appendChild(titleText);
                toolWidget.appendChild(titlePart);

                // Divider
                const div1 = document.createElement('div');
                div1.style.cssText = 'width: 1px; height: 28px; background: var(--border-default); flex-shrink: 0;';
                toolWidget.appendChild(div1);

                // Enforcement badge
                const enfBadge = document.createElement('span');
                enfBadge.style.cssText = 'font-size: 11px; font-weight: 700; padding: 2px 10px; border-radius: var(--radius-full); border: 1px solid; flex-shrink: 0; ' +
                    (enforcementOn
                        ? 'color: #06b6d4; background: rgba(6,182,212,0.1); border-color: rgba(6,182,212,0.3);'
                        : 'color: var(--text-muted); background: var(--bg-secondary); border-color: var(--border-default);');
                enfBadge.textContent = enforcementOn ? '⚡ Enforcement ON' : '○ Enforcement OFF';
                toolWidget.appendChild(enfBadge);

                // Stats pills
                const statsRow = document.createElement('div');
                statsRow.style.cssText = 'display: flex; gap: 10px; flex-wrap: wrap;';
                [
                    { label: tools.length + ' Total', color: '#94a3b8', bg: 'var(--bg-secondary)' },
                    { label: blocked + ' Blocked',   color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
                    { label: allowed + ' Allowed',   color: '#06b6d4', bg: 'rgba(6,182,212,0.1)' },
                ].forEach(item => {
                    const pill = document.createElement('span');
                    pill.style.cssText = 'font-size: 12px; font-weight: 700; color: ' + item.color + '; padding: 2px 10px; border-radius: var(--radius-full); background: ' + item.bg + '; border: 1px solid ' + item.color + '33;';
                    pill.textContent = item.label;
                    statsRow.appendChild(pill);
                });
                toolWidget.appendChild(statsRow);

                // Spacer + link
                const spacerEl = document.createElement('div');
                spacerEl.style.cssText = 'flex: 1;';
                toolWidget.appendChild(spacerEl);

                const linkEl = document.createElement('span');
                linkEl.style.cssText = 'font-size: 11px; font-weight: 600; color: var(--accent-primary); flex-shrink: 0; white-space: nowrap;';
                linkEl.textContent = 'Manage →';
                toolWidget.appendChild(linkEl);

                container.appendChild(toolWidget);
            }
        } catch (_) {}

        // 3. Charts row — threat trend + cost trend side by side
        const chartsRow = document.createElement('div');
        chartsRow.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 16px;';

        const trendCard = Card.create({ title: 'LLM Requests — Last 7 Days', gradient: true });
        this.renderTrendChart(trendCard.querySelector('.card-body'));
        chartsRow.appendChild(trendCard);

        const costTrendCard = Card.create({ title: 'Provider Cost — Last 7 Days', gradient: true });
        await this.renderCostTrendChart(costTrendCard.querySelector('.card-body'));
        chartsRow.appendChild(costTrendCard);

        container.appendChild(chartsRow);

        // 4. Recent activity
        const activityCard = Card.create({ title: 'Recent Threat Activity', gradient: true });
        this.renderRecentActivity(activityCard.querySelector('.card-body'));
        container.appendChild(activityCard);
    },

    createStatCard(stat) {
        const card = document.createElement('div');
        card.className = 'stat-card stat-' + (stat.color || 'primary');
        if (stat.tooltip) {
            card.style.cursor = 'help';
            card.title = stat.tooltip;
        }

        const iconWrap = document.createElement('div');
        iconWrap.className = 'stat-icon';
        iconWrap.appendChild(this.createIcon(stat.icon));
        card.appendChild(iconWrap);

        const content = document.createElement('div');
        content.className = 'stat-content';

        const value = document.createElement('div');
        value.className = 'stat-value';
        value.textContent = stat.raw ? stat.value : stat.value + (stat.suffix || '');
        content.appendChild(value);

        const labelRow = document.createElement('div');
        labelRow.style.cssText = 'display: flex; align-items: center; gap: 4px;';

        const label = document.createElement('div');
        label.className = 'stat-label';
        label.textContent = stat.label;
        labelRow.appendChild(label);

        if (stat.tooltip) {
            const hint = document.createElement('span');
            hint.style.cssText = 'font-size: 10px; color: var(--text-muted); line-height: 1; flex-shrink: 0;';
            hint.textContent = 'ⓘ';
            labelRow.appendChild(hint);
        }

        content.appendChild(labelRow);
        card.appendChild(content);
        return card;
    },

    createIcon(name) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');

        const paths = {
            shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
            alert: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
            activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
            gauge: 'M12 2a10 10 0 1 0 10 10H12V2zM12 12l6-6',
            check: 'M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4L12 14.01l-3-3',
            clock: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM12 6v6l4 2',
        };

        const pathData = paths[name] || paths.shield;
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', pathData);
        svg.appendChild(path);

        return svg;
    },

    getAverageRiskScore() {
        if (!this.threats || this.threats.length === 0) return 0;
        const total = this.threats.reduce((sum, t) => sum + (t.risk_score || 0), 0);
        return Math.round(total / this.threats.length);
    },

    getAverageLatency() {
        if (!this.threats || this.threats.length === 0) return 0;
        const total = this.threats.reduce((sum, t) => sum + (t.processing_time_ms || 0), 0);
        return Math.round(total / this.threats.length);
    },

    getRiskColor(score) {
        if (score >= 80) return 'danger';
        if (score >= 60) return 'warning';
        if (score >= 40) return 'info';
        return 'success';
    },

    renderRiskDistribution(container) {
        // Group threats by risk level
        const levels = { critical: 0, high: 0, medium: 0, low: 0 };

        this.threats.forEach(t => {
            const score = t.risk_score || 0;
            if (score >= 80) levels.critical++;
            else if (score >= 60) levels.high++;
            else if (score >= 40) levels.medium++;
            else levels.low++;
        });

        const total = Object.values(levels).reduce((a, b) => a + b, 0);

        if (total === 0) {
            const empty = document.createElement('p');
            empty.className = 'empty-state-inline';
            empty.textContent = 'No threat data yet';
            container.appendChild(empty);
            return;
        }

        const chart = document.createElement('div');
        chart.className = 'risk-donut-chart';

        // Donut chart visualization
        const donut = document.createElement('div');
        donut.className = 'donut-container';

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('class', 'donut-svg');

        let currentAngle = -90;
        const colors = { critical: '#ef4444', high: '#f97316', medium: '#f59e0b', low: '#60a5fa' };
        const radius = 40;
        const cx = 50, cy = 50;

        Object.entries(levels).forEach(([level, count]) => {
            if (count === 0) return;

            const angle = (count / total) * 360;
            const startAngle = currentAngle;
            const endAngle = currentAngle + angle;

            const x1 = cx + radius * Math.cos((startAngle * Math.PI) / 180);
            const y1 = cy + radius * Math.sin((startAngle * Math.PI) / 180);
            const x2 = cx + radius * Math.cos((endAngle * Math.PI) / 180);
            const y2 = cy + radius * Math.sin((endAngle * Math.PI) / 180);

            const largeArc = angle > 180 ? 1 : 0;

            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'M ' + cx + ' ' + cy + ' L ' + x1 + ' ' + y1 + ' A ' + radius + ' ' + radius + ' 0 ' + largeArc + ' 1 ' + x2 + ' ' + y2 + ' Z');
            path.setAttribute('fill', colors[level]);
            path.setAttribute('class', 'donut-segment');
            svg.appendChild(path);

            currentAngle = endAngle;
        });

        // Center hole
        const hole = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        hole.setAttribute('cx', '50');
        hole.setAttribute('cy', '50');
        hole.setAttribute('r', '25');
        hole.setAttribute('fill', 'var(--bg-secondary)');
        svg.appendChild(hole);

        // Center text
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', '50');
        text.setAttribute('y', '53');
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('fill', 'var(--text-primary)');
        text.setAttribute('font-size', '14');
        text.setAttribute('font-weight', '600');
        text.textContent = total;
        svg.appendChild(text);

        donut.appendChild(svg);
        chart.appendChild(donut);

        // Legend
        const legend = document.createElement('div');
        legend.className = 'chart-legend';

        Object.entries(levels).forEach(([level, count]) => {
            const item = document.createElement('div');
            item.className = 'legend-item';

            const dot = document.createElement('span');
            dot.className = 'legend-dot';
            dot.style.background = colors[level];
            item.appendChild(dot);

            const label = document.createElement('span');
            label.className = 'legend-label';
            label.textContent = level.charAt(0).toUpperCase() + level.slice(1);
            item.appendChild(label);

            const value = document.createElement('span');
            value.className = 'legend-value';
            value.textContent = count;
            item.appendChild(value);

            legend.appendChild(item);
        });

        chart.appendChild(legend);
        container.appendChild(chart);
    },

    renderThreatTypes(container) {
        const types = this.data.threat_types || {};

        if (Object.keys(types).length === 0) {
            const empty = document.createElement('p');
            empty.className = 'empty-state-inline';
            empty.textContent = 'No threat categories yet';
            container.appendChild(empty);
            return;
        }

        const entries = Object.entries(types).sort((a, b) => b[1] - a[1]);
        const maxCount = Math.max(...entries.map(e => e[1]));

        const chart = document.createElement('div');
        chart.className = 'horizontal-bar-chart';

        entries.slice(0, 5).forEach(([type, count], index) => {
            const row = document.createElement('div');
            row.className = 'bar-row';

            const label = document.createElement('div');
            label.className = 'bar-label';
            label.textContent = this.formatType(type);
            row.appendChild(label);

            const barWrap = document.createElement('div');
            barWrap.className = 'bar-wrap';

            const bar = document.createElement('div');
            bar.className = 'bar bar-' + (index % 4);
            const percentage = maxCount > 0 ? (count / maxCount) * 100 : 0;
            bar.style.width = '0%';
            // Animate bar
            setTimeout(() => {
                bar.style.width = percentage + '%';
            }, 100 + index * 50);
            barWrap.appendChild(bar);

            const countEl = document.createElement('span');
            countEl.className = 'bar-count';
            countEl.textContent = count;
            barWrap.appendChild(countEl);

            row.appendChild(barWrap);
            chart.appendChild(row);
        });

        container.appendChild(chart);
    },

    renderTrendChart(container) {
        // Build last-7-days buckets from loaded threats
        const days = 7;
        const buckets = [];
        const now = new Date();
        // Use local dates so chart labels match timestamps shown in the UI
        const toLocalDateStr = ts => {
            const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
            return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        };
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
            buckets.push({
                label: (d.getMonth()+1).toString().padStart(2,'0') + '/' + d.getDate().toString().padStart(2,'0'),
                dateStr,
                total: 0,
                threats: 0,
            });
        }

        (this.threats || []).forEach(t => {
            const dateStr = toLocalDateStr(t.created_at || new Date().toISOString());
            const bucket = buckets.find(b => b.dateStr === dateStr);
            if (bucket) {
                bucket.total++;
                if ((t.risk_score || 0) >= 60) bucket.threats++;
            }
        });

        const maxVal = Math.max(...buckets.map(b => b.total), 1);

        // Fixed-height chart: value(12px) + bar(flex) + day label(16px)
        const wrap = document.createElement('div');
        wrap.style.cssText = 'display: flex; align-items: stretch; gap: 5px; height: 110px;';

        buckets.forEach(bucket => {
            const col = document.createElement('div');
            col.style.cssText = 'flex: 1; display: flex; flex-direction: column; align-items: center; min-width: 0;';

            // Value label (top, fixed height)
            const valLbl = document.createElement('div');
            valLbl.style.cssText = 'height: 14px; font-size: 9px; color: var(--text-secondary); text-align: center; line-height: 14px; white-space: nowrap;';
            valLbl.textContent = bucket.total > 0 ? bucket.total : '';
            col.appendChild(valLbl);

            // Bar area (grows to fill)
            const barArea = document.createElement('div');
            barArea.style.cssText = 'flex: 1; width: 100%; position: relative;';
            barArea.title = `${bucket.dateStr}: ${bucket.total} requests, ${bucket.threats} threats`;

            const pct = (bucket.total / maxVal) * 100;
            const barTotal = document.createElement('div');
            barTotal.style.cssText = `position: absolute; bottom: 0; left: 0; right: 0; height: ${pct}%; background: var(--accent-primary); opacity: 0.3; border-radius: 3px 3px 0 0; min-height: ${bucket.total > 0 ? 3 : 0}px;`;
            barArea.appendChild(barTotal);

            if (bucket.threats > 0) {
                const threatPct = (bucket.threats / maxVal) * 100;
                const barThreat = document.createElement('div');
                barThreat.style.cssText = `position: absolute; bottom: 0; left: 0; right: 0; height: ${threatPct}%; background: #ef4444; opacity: 0.7; border-radius: 3px 3px 0 0; min-height: 3px;`;
                barArea.appendChild(barThreat);
            }
            col.appendChild(barArea);

            // Day label (bottom, fixed height)
            const lbl = document.createElement('div');
            lbl.style.cssText = 'height: 16px; font-size: 10px; color: var(--text-secondary); text-align: center; line-height: 16px; white-space: nowrap;';
            lbl.textContent = bucket.label;
            col.appendChild(lbl);

            wrap.appendChild(col);
        });

        container.appendChild(wrap);

        // Legend
        const legend = document.createElement('div');
        legend.style.cssText = 'display: flex; gap: 12px; margin-top: 4px; font-size: 11px; color: var(--text-secondary);';
        [['var(--accent-primary)', 'Requests'], ['#ef4444', 'Threats (risk ≥60%)']]
            .forEach(([color, label]) => {
                const item = document.createElement('span');
                item.style.cssText = 'display: flex; align-items: center; gap: 4px;';
                const dot = document.createElement('span');
                dot.style.cssText = `width: 8px; height: 8px; border-radius: 2px; background: ${color}; opacity: 0.75; flex-shrink: 0;`;
                item.appendChild(dot);
                item.appendChild(document.createTextNode(label));
                legend.appendChild(item);
            });
        container.appendChild(legend);
    },

    async renderCostTrendChart(container) {
        // Fetch last 7 days of cost records
        const days = 7;
        const buckets = [];
        const now = new Date();
        const toLocalDateStr2 = ts => {
            const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
            return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
        };
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
            buckets.push({ label: (d.getMonth()+1).toString().padStart(2,'0') + '/' + d.getDate().toString().padStart(2,'0'), dateStr, cost: 0 });
        }

        try {
            const start = new Date(now);
            start.setDate(start.getDate() - 7);
            const records = await API.getCostRecords({ start: start.toISOString(), page_size: 200 });
            (records.items || []).forEach(r => {
                const dateStr = toLocalDateStr2(r.recorded_at || new Date().toISOString());
                const bucket = buckets.find(b => b.dateStr === dateStr);
                if (bucket) bucket.cost += r.total_cost_usd || 0;
            });
        } catch (e) {}

        const maxVal = Math.max(...buckets.map(b => b.cost), 0.000001);

        const wrap = document.createElement('div');
        wrap.style.cssText = 'display: flex; align-items: stretch; gap: 5px; height: 110px;';

        buckets.forEach(bucket => {
            const col = document.createElement('div');
            col.style.cssText = 'flex: 1; display: flex; flex-direction: column; align-items: center; min-width: 0;';

            // Value label (top, fixed height)
            const valLbl = document.createElement('div');
            valLbl.style.cssText = 'height: 14px; font-size: 9px; color: var(--text-secondary); text-align: center; line-height: 14px; white-space: nowrap;';
            valLbl.textContent = bucket.cost > 0 ? '$' + bucket.cost.toFixed(2) : '';
            col.appendChild(valLbl);

            // Bar area (grows)
            const barArea = document.createElement('div');
            barArea.style.cssText = 'flex: 1; width: 100%; position: relative;';
            barArea.title = `${bucket.dateStr}: $${bucket.cost.toFixed(4)}`;

            const pct = (bucket.cost / maxVal) * 100;
            const bar = document.createElement('div');
            bar.style.cssText = `position: absolute; bottom: 0; left: 0; right: 0; height: ${pct}%; background: #10b981; opacity: 0.6; border-radius: 3px 3px 0 0; min-height: ${bucket.cost > 0 ? 3 : 0}px;`;
            barArea.appendChild(bar);
            col.appendChild(barArea);

            // Day label (bottom, fixed height)
            const lbl = document.createElement('div');
            lbl.style.cssText = 'height: 16px; font-size: 10px; color: var(--text-secondary); text-align: center; line-height: 16px; white-space: nowrap;';
            lbl.textContent = bucket.label;
            col.appendChild(lbl);

            wrap.appendChild(col);
        });

        container.appendChild(wrap);

        const legend = document.createElement('div');
        legend.style.cssText = 'display: flex; gap: 12px; margin-top: 4px; font-size: 11px; color: var(--text-secondary);';
        const item = document.createElement('span');
        item.style.cssText = 'display: flex; align-items: center; gap: 4px;';
        const dot = document.createElement('span');
        dot.style.cssText = 'width: 8px; height: 8px; border-radius: 2px; background: #10b981; opacity: 0.75; flex-shrink: 0;';
        item.appendChild(dot);
        item.appendChild(document.createTextNode('Daily spend (USD)'));
        legend.appendChild(item);
        container.appendChild(legend);
    },

    renderRecentActivity(container) {
        const threats = this.threats.slice(0, 8);

        if (threats.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty-state-inline';

            const emptyText = document.createElement('p');
            emptyText.textContent = 'No recent activity';
            empty.appendChild(emptyText);

            const emptySubtext = document.createElement('p');
            emptySubtext.className = 'empty-subtext';
            emptySubtext.textContent = 'Threats will appear here when detected';
            empty.appendChild(emptySubtext);

            container.appendChild(empty);
            return;
        }

        const table = document.createElement('div');
        table.className = 'activity-table';

        // Header
        const header = document.createElement('div');
        header.className = 'activity-header';

        const cols = ['Content', 'Type', 'Risk', 'Time'];
        cols.forEach(col => {
            const cell = document.createElement('div');
            cell.className = 'activity-cell';
            cell.textContent = col;
            header.appendChild(cell);
        });
        table.appendChild(header);

        // Rows
        threats.forEach(threat => {
            const row = document.createElement('div');
            row.className = 'activity-row';

            // Content preview
            const contentCell = document.createElement('div');
            contentCell.className = 'activity-cell content-cell';
            const content = threat.text_preview || threat.text_content || threat.indicator || threat.name || 'Analyzed content';
            contentCell.textContent = content.length > 50 ? content.substring(0, 50) + '...' : content;
            contentCell.title = content;
            row.appendChild(contentCell);

            // Type
            const typeCell = document.createElement('div');
            typeCell.className = 'activity-cell';
            const typeBadge = document.createElement('span');
            typeBadge.className = 'type-badge-small';
            typeBadge.textContent = this.formatType(threat.threat_type || 'detected');
            typeCell.appendChild(typeBadge);
            row.appendChild(typeCell);

            // Risk
            const riskCell = document.createElement('div');
            riskCell.className = 'activity-cell';
            const riskBadge = document.createElement('span');
            riskBadge.className = 'risk-badge risk-' + this.getRiskLevel(threat.risk_score);
            riskBadge.textContent = (threat.risk_score || 0) + '%';
            riskCell.appendChild(riskBadge);
            row.appendChild(riskCell);

            // Time
            const timeCell = document.createElement('div');
            timeCell.className = 'activity-cell time-cell';
            timeCell.textContent = this.formatTime(threat.created_at || threat.first_seen);
            row.appendChild(timeCell);

            row.addEventListener('click', () => {
                if (window.Sidebar) Sidebar.navigate('threats');
            });

            table.appendChild(row);
        });

        container.appendChild(table);
    },

    formatType(type) {
        if (!type || type === 'unknown') return 'Detected';
        return type
            .split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    },

    formatTime(dateStr) {
        if (!dateStr) return '-';
        try {
            const date = new Date(dateStr);
            const now = new Date();
            const diffMs = now - date;
            const diffMins = Math.floor(diffMs / 60000);

            if (diffMins < 1) return 'Just now';
            if (diffMins < 60) return diffMins + 'm ago';
            if (diffMins < 1440) return Math.floor(diffMins / 60) + 'h ago';
            return Math.floor(diffMins / 1440) + 'd ago';
        } catch (e) {
            return '-';
        }
    },

    getRiskLevel(score) {
        if (score >= 80) return 'critical';
        if (score >= 60) return 'high';
        if (score >= 40) return 'medium';
        return 'low';
    },

    toggleAutoRefresh() {
        this.autoRefreshEnabled = !this.autoRefreshEnabled;
        if (this.autoRefreshEnabled) {
            this.autoRefreshInterval = setInterval(() => {
                if (this.currentContainer) {
                    this.render(this.currentContainer);
                }
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

    async renderCostWidget() {
        const widget = document.createElement('div');
        widget.style.cssText = 'background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 8px; padding: 16px; margin-bottom: 20px; cursor: pointer;';
        widget.title = 'Click to open Cost Tracking';
        widget.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate('costs'); });

        const header = document.createElement('div');
        header.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;';

        const titleEl = document.createElement('div');
        titleEl.style.cssText = 'font-size: 14px; font-weight: 600; color: var(--text-primary);';
        titleEl.textContent = '💰 Cost Tracking';
        header.appendChild(titleEl);

        const viewLink = document.createElement('span');
        viewLink.style.cssText = 'font-size: 12px; color: var(--accent-primary); cursor: pointer;';
        viewLink.textContent = 'View all →';
        header.appendChild(viewLink);

        widget.appendChild(header);

        try {
            const summary = await API.getDashboardCostSummary();

            const grid = document.createElement('div');
            grid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px;';

            const items = [
                { label: "Today's Cost", value: `$${(summary.today_cost_usd || 0).toFixed(4)}` },
                { label: "Today's Requests", value: (summary.today_requests || 0).toLocaleString() },
                { label: 'Top Agent', value: summary.top_agent || '—' },
                { label: 'Top Model', value: summary.top_model || '—' },
            ];

            items.forEach(({ label, value }) => {
                const cell = document.createElement('div');
                cell.style.cssText = 'text-align: center;';
                const v = document.createElement('div');
                v.style.cssText = 'font-size: 18px; font-weight: 700; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
                v.textContent = value;
                v.title = value;
                const l = document.createElement('div');
                l.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-top: 2px;';
                l.textContent = label;
                cell.appendChild(v);
                cell.appendChild(l);
                grid.appendChild(cell);
            });

            widget.appendChild(grid);

            if (summary.has_unknown_pricing) {
                const warn = document.createElement('div');
                warn.style.cssText = 'margin-top: 10px; font-size: 11px; color: var(--color-warning, #f59e0b);';
                warn.textContent = '⚠ Some models have unknown pricing — costs may be understated.';
                widget.appendChild(warn);
            }
        } catch (e) {
            const err = document.createElement('div');
            err.style.cssText = 'font-size: 13px; color: var(--text-secondary);';
            err.textContent = 'Cost data unavailable.';
            widget.appendChild(err);
        }

        return widget;
    },

    async renderSecurityControls() {
        const section = document.createElement('div');
        section.className = 'security-controls-section';
        section.style.cssText = 'display: flex; gap: 16px; margin-bottom: 24px;';

        // Fetch current settings
        let settings = { block_threats: false, scan_llm_responses: true };
        try {
            settings = await API.getSettings();
        } catch (e) {}

        // Block Mode Card
        const blockCard = document.createElement('div');
        blockCard.className = 'security-control-card';
        blockCard.style.cssText = 'flex: 1; background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 12px; padding: 20px; display: flex; justify-content: space-between; align-items: center;';
        if (!settings.block_threats) blockCard.classList.add('flashing-border');

        const blockInfo = document.createElement('div');
        const blockTitle = document.createElement('div');
        blockTitle.style.cssText = 'font-weight: 600; font-size: 15px; margin-bottom: 4px;';
        blockTitle.textContent = 'Block Mode';
        blockInfo.appendChild(blockTitle);
        const blockDesc = document.createElement('div');
        blockDesc.style.cssText = 'color: var(--text-secondary); font-size: 13px;';
        blockDesc.textContent = 'Block threats on input and output';
        blockInfo.appendChild(blockDesc);
        blockCard.appendChild(blockInfo);

        const blockToggle = document.createElement('label');
        blockToggle.className = 'toggle';
        const blockCheckbox = document.createElement('input');
        blockCheckbox.type = 'checkbox';
        blockCheckbox.checked = settings.block_threats;
        blockCheckbox.addEventListener('change', async (e) => {
            const newState = e.target.checked;
            if (!confirm(newState ? 'Enable Block Mode?\n\nInput threats will be BLOCKED before reaching the LLM.\nOutput threats will be BLOCKED before reaching the client.' : 'Disable Block Mode?\n\nAll threats will be logged only.')) {
                e.target.checked = !newState;
                return;
            }
            try {
                await API.updateSettings({ block_threats: newState });
                Toast.success(newState ? 'Block mode enabled' : 'Block mode disabled');
            } catch (err) {
                Toast.error('Failed to update');
                e.target.checked = !newState;
            }
        });
        blockToggle.appendChild(blockCheckbox);
        const blockSlider = document.createElement('span');
        blockSlider.className = 'toggle-slider';
        blockToggle.appendChild(blockSlider);
        blockCard.appendChild(blockToggle);
        section.appendChild(blockCard);

        // Output Scan Card
        const outputCard = document.createElement('div');
        outputCard.className = 'security-control-card';
        outputCard.style.cssText = 'flex: 1; background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 12px; padding: 20px; display: flex; justify-content: space-between; align-items: center;';
        if (!settings.scan_llm_responses) outputCard.classList.add('flashing-border');

        const outputInfo = document.createElement('div');
        const outputTitle = document.createElement('div');
        outputTitle.style.cssText = 'font-weight: 600; font-size: 15px; margin-bottom: 4px;';
        outputTitle.textContent = 'Output Scan (Redact Sensitive Info)';
        outputInfo.appendChild(outputTitle);
        const outputDesc = document.createElement('div');
        outputDesc.style.cssText = 'color: var(--text-secondary); font-size: 13px;';
        outputDesc.textContent = 'Scan LLM responses, redact secrets when stored';
        outputInfo.appendChild(outputDesc);
        outputCard.appendChild(outputInfo);

        const outputToggle = document.createElement('label');
        outputToggle.className = 'toggle';
        const outputCheckbox = document.createElement('input');
        outputCheckbox.type = 'checkbox';
        outputCheckbox.checked = settings.scan_llm_responses;
        outputCheckbox.addEventListener('change', async (e) => {
            const newState = e.target.checked;
            if (!confirm(newState ? 'Enable Output Scan?\n\nLLM responses will be scanned.' : 'Disable Output Scan?\n\nResponses will not be monitored.')) {
                e.target.checked = !newState;
                return;
            }
            try {
                await API.updateSettings({ scan_llm_responses: newState });
                Toast.success(newState ? 'Output scan enabled' : 'Output scan disabled');
            } catch (err) {
                Toast.error('Failed to update');
                e.target.checked = !newState;
            }
        });
        outputToggle.appendChild(outputCheckbox);
        const outputSlider = document.createElement('span');
        outputSlider.className = 'toggle-slider';
        outputToggle.appendChild(outputSlider);
        outputCard.appendChild(outputToggle);
        section.appendChild(outputCard);

        return section;
    },

    renderError(container, error) {
        container.textContent = '';

        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-state';

        const icon = document.createElement('div');
        icon.className = 'error-icon';
        icon.textContent = '!';
        errorDiv.appendChild(icon);

        const message = document.createElement('p');
        message.textContent = 'Failed to load dashboard data';
        errorDiv.appendChild(message);

        const retry = document.createElement('button');
        retry.className = 'btn btn-primary';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => this.render(container));
        errorDiv.appendChild(retry);

        container.appendChild(errorDiv);
    },
};

window.DashboardPage = DashboardPage;
