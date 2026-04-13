/**
 * Sandbox Page — Flagship Feature
 * Run any AI agent safely in one command.
 *
 * Tabs:
 *   Sessions — Live agent cards with status, output preview, actions
 *   Launch   — Start a new sandboxed agent
 */

const SandboxPage = {
    activeTab: 'sessions',
    sessions: [],
    pollInterval: null,

    async render(container) {
        container.textContent = '';
        if (this.pollInterval) clearInterval(this.pollInterval);

        if (window.Header) Header.setPageInfo('Sandbox', 'Run any AI agent safely in one command');

        // Hero stats
        var statsGrid = document.createElement('div');
        statsGrid.className = 'stats-grid';
        statsGrid.id = 'sandbox-stats';
        container.appendChild(statsGrid);

        // Tab bar
        var tabs = document.createElement('div');
        tabs.className = 'tab-bar';
        tabs.id = 'sandbox-tabs';
        container.appendChild(tabs);

        // Content area
        var content = document.createElement('div');
        content.id = 'sandbox-tab-content';
        container.appendChild(content);

        this._renderTabBar();
        await this._renderActiveTab();

        // Live poll every 3s
        this.pollInterval = setInterval(async function () {
            if (document.hidden) return;
            await SandboxPage._loadSessions();
            SandboxPage._renderStats();
            if (SandboxPage.activeTab === 'sessions') SandboxPage._renderSessionCards();
        }, 3000);
    },

    // ── Stats ──────────────────────────────────────────────

    _renderStats() {
        var grid = document.getElementById('sandbox-stats');
        if (!grid) return;
        grid.textContent = '';

        var total = this.sessions.length;
        var running = this.sessions.filter(function (s) { return s.status === 'running'; }).length;
        var completed = this.sessions.filter(function (s) { return s.status === 'completed'; }).length;
        var failed = this.sessions.filter(function (s) { return s.status === 'failed' || s.status === 'timed_out'; }).length;

        var stats = [
            { label: 'Total Sessions', value: total, color: null },
            { label: 'Running', value: running, color: 'var(--info)' },
            { label: 'Completed', value: completed, color: 'var(--success)' },
            { label: 'Failed', value: failed, color: 'var(--danger)' },
        ];

        stats.forEach(function (s) {
            var card = document.createElement('div');
            card.className = 'stat-card';
            var title = document.createElement('div');
            title.className = 'stat-card-title';
            title.textContent = s.label;
            var val = document.createElement('div');
            val.className = 'stat-card-value';
            val.textContent = s.value;
            if (s.color) val.style.color = s.color;
            card.appendChild(title);
            card.appendChild(val);
            grid.appendChild(card);
        });
    },

    // ── Tab Bar ────────────────────────────────────────────

    _renderTabBar() {
        var bar = document.getElementById('sandbox-tabs');
        if (!bar) return;
        bar.textContent = '';
        var self = this;

        [{ id: 'sessions', label: 'Sessions' }, { id: 'launch', label: 'Launch' }].forEach(function (def) {
            var btn = document.createElement('button');
            btn.className = 'tab-btn' + (self.activeTab === def.id ? ' active' : '');
            btn.textContent = def.label;
            btn.addEventListener('click', function () {
                self.activeTab = def.id;
                self._renderTabBar();
                self._renderActiveTab();
            });
            bar.appendChild(btn);
        });
    },

    async _renderActiveTab() {
        var content = document.getElementById('sandbox-tab-content');
        if (!content) return;
        content.textContent = '';

        if (this.activeTab === 'sessions') {
            await this._loadSessions();
            this._renderStats();
            this._renderSessionCards();
        } else if (this.activeTab === 'launch') {
            this._renderStats();
            this._renderLaunchForm();
        }
    },

    // ── Sessions Tab — Card Grid ───────────────────────────

    async _loadSessions() {
        try {
            var data = await API.getSandboxSessions();
            this.sessions = data.sessions || data || [];
        } catch (e) { /* keep existing */ }
    },

    _renderSessionCards() {
        var content = document.getElementById('sandbox-tab-content');
        if (!content || this.activeTab !== 'sessions') return;
        content.textContent = '';
        var self = this;

        if (!this.sessions.length) {
            var empty = document.createElement('div');
            empty.className = 'sandbox-empty';

            var icon = document.createElement('div');
            icon.className = 'sandbox-empty-icon';
            var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '1.2');
            svg.setAttribute('width', '56');
            svg.setAttribute('height', '56');
            var r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            r.setAttribute('x', '2'); r.setAttribute('y', '4'); r.setAttribute('width', '20');
            r.setAttribute('height', '16'); r.setAttribute('rx', '2');
            var l1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            l1.setAttribute('d', 'M2 10h20');
            var c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            c.setAttribute('cx', '12'); c.setAttribute('cy', '15'); c.setAttribute('r', '2');
            svg.appendChild(r); svg.appendChild(l1); svg.appendChild(c);
            icon.appendChild(svg);

            var title = document.createElement('div');
            title.className = 'sandbox-empty-title';
            title.textContent = 'No agents running';

            var text = document.createElement('div');
            text.className = 'sandbox-empty-text';
            text.textContent = 'Launch an agent from the Launch tab or run sv-sandbox from your terminal.';

            empty.appendChild(icon);
            empty.appendChild(title);
            empty.appendChild(text);
            content.appendChild(empty);
            return;
        }

        var grid = document.createElement('div');
        grid.className = 'sandbox-card-grid';

        this.sessions.forEach(function (session) {
            var card = document.createElement('div');
            card.className = 'sandbox-card';
            card.dataset.status = session.status;
            card.addEventListener('click', function () { self._showSessionDetail(session); });

            // Top row: status + duration
            var top = document.createElement('div');
            top.className = 'sandbox-card-top';

            var badge = document.createElement('span');
            badge.className = 'sandbox-status-badge';
            badge.dataset.status = session.status;
            var dot = document.createElement('span');
            dot.className = 'sandbox-status-dot';
            badge.appendChild(dot);
            badge.appendChild(document.createTextNode(' ' + self._formatStatus(session.status)));
            top.appendChild(badge);

            var dur = document.createElement('span');
            dur.className = 'sandbox-card-duration';
            if (session.status === 'running') {
                var elapsed = Date.now() - new Date(session.started_at).getTime();
                dur.textContent = self._formatDuration(elapsed);
            } else {
                dur.textContent = session.duration_ms ? self._formatDuration(session.duration_ms) : '\u2014';
            }
            top.appendChild(dur);
            card.appendChild(top);

            // Command
            var cmdBlock = document.createElement('div');
            cmdBlock.className = 'sandbox-card-command';
            cmdBlock.textContent = session.command;
            cmdBlock.title = session.command;
            card.appendChild(cmdBlock);

            // Agent type + info row
            var info = document.createElement('div');
            info.className = 'sandbox-card-info';

            var agentBadge = document.createElement('span');
            agentBadge.className = 'sandbox-agent-badge';
            agentBadge.textContent = session.agent_type || 'Custom';
            info.appendChild(agentBadge);

            if (session.exit_code != null && session.status !== 'running') {
                var exitBadge = document.createElement('span');
                exitBadge.className = 'sandbox-card-exit';
                exitBadge.textContent = 'exit ' + session.exit_code;
                info.appendChild(exitBadge);
            }

            if (session.started_at) {
                var time = document.createElement('span');
                time.className = 'sandbox-card-time';
                time.textContent = self._formatTime(session.started_at);
                info.appendChild(time);
            }

            card.appendChild(info);

            // Error/output preview
            if (session.error) {
                var errPreview = document.createElement('div');
                errPreview.className = 'sandbox-card-preview sandbox-card-preview-error';
                errPreview.textContent = session.error;
                card.appendChild(errPreview);
            } else if (session.stdout && session.status !== 'running') {
                var outPreview = document.createElement('div');
                outPreview.className = 'sandbox-card-preview';
                var previewText = session.stdout.trim();
                if (previewText.length > 120) previewText = previewText.substring(0, 120) + '\u2026';
                outPreview.textContent = previewText;
                card.appendChild(outPreview);
            }

            // Actions
            var actions = document.createElement('div');
            actions.className = 'sandbox-card-actions';

            if (session.status === 'running') {
                var killBtn = document.createElement('button');
                killBtn.className = 'sandbox-action-btn sandbox-action-kill';
                killBtn.textContent = 'Kill';
                killBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    API.killSandbox(session.id).then(function () {
                        if (window.Toast) Toast.success('Session killed');
                        self._loadSessions().then(function () {
                            self._renderStats();
                            self._renderSessionCards();
                        });
                    }).catch(function (err) {
                        if (window.Toast) Toast.error('Failed: ' + err.message);
                    });
                });
                actions.appendChild(killBtn);
            } else {
                var viewBtn = document.createElement('button');
                viewBtn.className = 'sandbox-action-btn sandbox-action-view';
                viewBtn.textContent = 'View';
                viewBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    self._showSessionDetail(session);
                });
                actions.appendChild(viewBtn);

                var delBtn = document.createElement('button');
                delBtn.className = 'sandbox-action-btn sandbox-action-delete';
                delBtn.textContent = 'Delete';
                delBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    API.deleteSandbox(session.id).then(function () {
                        self._loadSessions().then(function () {
                            self._renderStats();
                            self._renderSessionCards();
                        });
                    }).catch(function (err) {
                        if (window.Toast) Toast.error('Failed: ' + err.message);
                    });
                });
                actions.appendChild(delBtn);
            }

            card.appendChild(actions);
            grid.appendChild(card);
        });

        content.appendChild(grid);
    },

    // ── Launch Tab ─────────────────────────────────────────

    _renderLaunchForm() {
        var content = document.getElementById('sandbox-tab-content');
        if (!content) return;
        content.textContent = '';
        var self = this;

        var form = document.createElement('div');
        form.className = 'sandbox-launch-form';

        // Form title
        var formTitle = document.createElement('div');
        formTitle.className = 'sandbox-form-title';
        formTitle.textContent = 'Launch Agent in Sandbox';
        form.appendChild(formTitle);

        var formDesc = document.createElement('div');
        formDesc.className = 'sandbox-form-desc';
        formDesc.textContent = 'The agent runs in an isolated workspace with filtered environment variables and enforced timeouts.';
        form.appendChild(formDesc);

        // Command
        form.appendChild(this._buildField('Command', 'sandbox-cmd',
            'text', 'openclaw agent --agent main -m "find CVEs"',
            'Any command — OpenClaw, Claude Code, Codex, Python, Node.js'));

        // Two columns
        var row = document.createElement('div');
        row.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 16px;';
        row.appendChild(this._buildField('Timeout', 'sandbox-timeout',
            'text', '5m', '0 = no timeout (for interactive agents)'));
        row.appendChild(this._buildField('Allow Env Vars', 'sandbox-env',
            'text', 'OPENAI_API_KEY', 'Comma-separated vars to pass through'));
        form.appendChild(row);

        // Keep workspace
        var checkRow = document.createElement('label');
        checkRow.className = 'sandbox-checkbox-row';
        var check = document.createElement('input');
        check.type = 'checkbox';
        check.id = 'sandbox-keep';
        check.className = 'sandbox-checkbox';
        checkRow.appendChild(check);
        checkRow.appendChild(document.createTextNode('Keep workspace after exit'));
        form.appendChild(checkRow);

        // Launch button
        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'margin-top: 24px;';
        var launchBtn = document.createElement('button');
        launchBtn.className = 'sandbox-launch-btn';
        var iconSpan = document.createElement('span');
        iconSpan.className = 'sandbox-launch-icon';
        iconSpan.textContent = '\u25B6';
        launchBtn.appendChild(iconSpan);
        launchBtn.appendChild(document.createTextNode(' Launch in Sandbox'));
        launchBtn.addEventListener('click', function () { self._handleLaunch(); });
        btnRow.appendChild(launchBtn);
        form.appendChild(btnRow);

        // Status
        var statusArea = document.createElement('div');
        statusArea.id = 'sandbox-launch-status';
        form.appendChild(statusArea);

        content.appendChild(form);
    },

    _buildField(label, id, type, placeholder, help) {
        var wrapper = document.createElement('div');
        wrapper.className = 'sandbox-field';

        var lbl = document.createElement('label');
        lbl.className = 'sandbox-field-label';
        lbl.textContent = label;
        lbl.setAttribute('for', id);

        var input = document.createElement('input');
        input.type = type;
        input.id = id;
        input.placeholder = placeholder;
        input.className = 'sandbox-input';

        wrapper.appendChild(lbl);
        wrapper.appendChild(input);

        if (help) {
            var helpText = document.createElement('div');
            helpText.className = 'sandbox-field-help';
            helpText.textContent = help;
            wrapper.appendChild(helpText);
        }
        return wrapper;
    },

    async _handleLaunch() {
        var self = this;
        var cmdEl = document.getElementById('sandbox-cmd');
        var cmdVal = cmdEl ? cmdEl.value.trim() : '';
        if (!cmdVal) {
            if (window.Toast) Toast.error('Command is required');
            return;
        }

        var timeoutEl = document.getElementById('sandbox-timeout');
        var timeout = timeoutEl ? timeoutEl.value.trim() || '5m' : '5m';
        var envEl = document.getElementById('sandbox-env');
        var allowEnv = envEl ? envEl.value.trim() : '';
        var keepEl = document.getElementById('sandbox-keep');
        var keep = keepEl ? keepEl.checked : false;

        var status = document.getElementById('sandbox-launch-status');
        if (status) {
            status.className = 'sandbox-launch-status sandbox-launch-status-pending';
            status.textContent = 'Launching sandbox\u2026';
        }

        try {
            var result = await API.launchSandbox({ command: cmdVal, timeout: timeout, allow_env: allowEnv, keep: keep });
            if (status) {
                status.className = 'sandbox-launch-status sandbox-launch-status-success';
                status.textContent = 'Agent launched: ' + (result.id || 'running');
            }
            if (window.Toast) Toast.success('Agent launched in sandbox');

            setTimeout(function () {
                self.activeTab = 'sessions';
                self._renderTabBar();
                self._renderActiveTab();
            }, 800);
        } catch (e) {
            if (status) {
                status.className = 'sandbox-launch-status sandbox-launch-status-error';
                status.textContent = 'Failed: ' + e.message;
            }
        }
    },

    // ── Session Detail Modal ───────────────────────────────

    async _showSessionDetail(session) {
        if (!window.Modal) return;

        try {
            var fresh = await API.getSandboxSession(session.id);
            if (fresh && fresh.id) session = fresh;
        } catch (e) { /* fall back */ }

        var body = document.createElement('div');
        body.className = 'sandbox-detail';

        var fields = [
            ['ID', session.id],
            ['Status', this._formatStatus(session.status)],
            ['Command', session.command],
            ['Agent Type', session.agent_type || 'Custom'],
            ['Duration', session.duration_ms ? this._formatDuration(session.duration_ms) : '\u2014'],
            ['Exit Code', session.exit_code != null ? String(session.exit_code) : '\u2014'],
            ['Workspace', session.workspace || '\u2014'],
            ['Started', session.started_at || '\u2014'],
            ['Finished', session.finished_at || '\u2014'],
        ];
        if (session.error) fields.push(['Error', session.error]);

        var table = document.createElement('div');
        table.className = 'sandbox-detail-fields';
        fields.forEach(function (pair) {
            var row = document.createElement('div');
            row.className = 'sandbox-detail-row';
            var k = document.createElement('span');
            k.className = 'sandbox-detail-key';
            k.textContent = pair[0];
            var v = document.createElement('span');
            v.className = 'sandbox-detail-value';
            if (pair[0] === 'Command' || pair[0] === 'Workspace') v.classList.add('sandbox-detail-mono');
            v.textContent = pair[1];
            row.appendChild(k);
            row.appendChild(v);
            table.appendChild(row);
        });
        body.appendChild(table);

        if (session.stdout) body.appendChild(this._buildOutputBlock('Stdout', session.stdout, false));
        if (session.stderr) body.appendChild(this._buildOutputBlock('Stderr', session.stderr, true));

        Modal.show({ title: 'Session Details', content: body, size: 'large' });
    },

    _buildOutputBlock(label, text, isError) {
        var block = document.createElement('div');
        block.className = 'sandbox-output-block';
        var heading = document.createElement('div');
        heading.className = 'sandbox-output-label';
        heading.textContent = label;
        var pre = document.createElement('pre');
        pre.className = 'sandbox-output-pre' + (isError ? ' sandbox-output-error' : '');
        pre.textContent = text;
        block.appendChild(heading);
        block.appendChild(pre);
        return block;
    },

    // ── Helpers ─────────────────────────────────────────────

    _formatStatus(s) {
        return { running: 'Running', completed: 'Completed', failed: 'Failed', timed_out: 'Timed Out', killed: 'Killed' }[s] || s;
    },
    _formatDuration(ms) {
        if (ms < 1000) return ms + 'ms';
        if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
        return Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's';
    },
    _formatTime(iso) {
        try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
        catch (e) { return iso; }
    },
};
