/**
 * Skill Scanner Page
 * Tabbed interface: Scanner | History | Permissions
 * Policy engine evaluation runs automatically on every scan.
 */

const SkillScannerPage = {
    _scanInProgress: false,
    activeTab: 'scanner',
    _lastScanResults: null,

    async render(container) {
        this._currentContainer = container;
        container.textContent = '';
        if (this.activeTab === 'permissions') {
            if (window.Header) Header.setPageInfo('Skill Permissions', 'Manage scan policy permissions and trusted publishers');
        } else {
            if (window.Header) Header.setPageInfo('Skill Scanner', 'Static security analysis for skill directories');
        }

        const content = document.createElement('div');
        content.id = 'ss-tab-content';
        container.appendChild(content);

        if (this.activeTab === 'permissions') {
            await this._renderPermissionsTab(content);
        } else {
            await this._renderScannerTab(content);
            await this._renderHistoryTab(content);
        }
    },

    // =====================================================================
    // Scanner Tab
    // =====================================================================

    async _renderScannerTab(container) {
        // Inject "How it works" link into the page header subtitle area
        const headerSubtitle = document.getElementById('header-page-subtitle');
        if (headerSubtitle) {
            // Preserve existing text and append link
            const existingText = headerSubtitle.textContent;
            headerSubtitle.textContent = '';
            headerSubtitle.appendChild(document.createTextNode(existingText));
            const sep = document.createTextNode('  \u00B7  ');
            headerSubtitle.appendChild(sep);
            const guideLink = document.createElement('a');
            guideLink.style.cssText = 'font-size: 12px; color: var(--accent-primary); cursor: pointer; text-decoration: none; opacity: 0.8;';
            guideLink.textContent = 'How it works \u2192';
            guideLink.addEventListener('mouseenter', () => { guideLink.style.opacity = '1'; });
            guideLink.addEventListener('mouseleave', () => { guideLink.style.opacity = '0.8'; });
            guideLink.addEventListener('click', (e) => {
                e.preventDefault();
                if (window.Sidebar) Sidebar.navigateToSection('guide', 'section-skill-scanner', 'gs-skill-scanner');
            });
            headerSubtitle.appendChild(guideLink);
        }

        const statusSpan = document.createElement('span');
        statusSpan.style.cssText = 'font-size: 12px; color: var(--text-secondary); display: none;';

        // Auto-discover skills from all platform-specific locations
        let discovered = [];
        let searchedDirs = [];
        let isWsl = false;
        try {
            const resp = await fetch('/api/skill-scans/discover');
            if (resp.ok) {
                const data = await resp.json();
                discovered = data.skills || [];
                searchedDirs = data.searched_dirs || [];
                isWsl = data.is_wsl || false;
            }
        } catch (e) { /* ignore */ }

        const selectedPaths = new Set();

        // Skills Detected section — compact summary with expand toggle
        const section = document.createElement('div');
        section.style.cssText = 'margin-bottom: 20px;';
        let summaryToggle = null;

        const sectionHeader = document.createElement('div');
        sectionHeader.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 12px;';

        // Count unique directories
        const uniqueSourceDirs = new Set(discovered.map(s => {
            const parts = s.path.split('/');
            return parts.slice(0, -1).join('/');
        }));

        if (discovered.length > 0) {
            // Compact summary row with expand toggle — prominent count badge
            summaryToggle = document.createElement('div');
            summaryToggle.style.cssText = 'display: flex; align-items: center; gap: 10px; cursor: pointer; user-select: none; padding: 10px 16px; border-radius: 8px; background: var(--bg-card); border: 1px solid var(--border-default); transition: border-color 0.15s;';
            summaryToggle.addEventListener('mouseenter', () => { summaryToggle.style.borderColor = 'var(--accent-primary)'; });
            summaryToggle.addEventListener('mouseleave', () => { summaryToggle.style.borderColor = 'var(--border-default)'; });
            const countBubble = document.createElement('span');
            countBubble.style.cssText = 'min-width: 28px; height: 28px; border-radius: var(--radius-full); background: rgba(94,173,184,0.15); color: var(--accent-primary); border: 1px solid rgba(94,173,184,0.3); font-size: 13px; font-weight: 800; display: flex; align-items: center; justify-content: center; flex-shrink: 0;';
            countBubble.textContent = discovered.length;
            summaryToggle.appendChild(countBubble);
            const summaryText = document.createElement('span');
            summaryText.style.cssText = 'font-size: 14px; font-weight: 600; color: var(--text-primary);';
            summaryText.textContent = `skill${discovered.length !== 1 ? 's' : ''} detected`;
            summaryToggle.appendChild(summaryText);
            const chevron = document.createElement('span');
            chevron.className = 'skills-chevron';
            chevron.style.cssText = 'font-size: 10px; color: var(--text-muted); transition: transform 0.2s; display: inline-block;';
            chevron.textContent = '\u25B6';
            summaryToggle.appendChild(chevron);
            const expandHint = document.createElement('span');
            expandHint.style.cssText = 'font-size: 11px; color: var(--text-muted);';
            expandHint.textContent = 'click to expand';
            summaryToggle.appendChild(expandHint);
            sectionHeader.appendChild(summaryToggle);
        } else {
            const sTitle = document.createElement('div');
            sTitle.style.cssText = 'font-size: 13px; font-weight: 700; color: var(--text-primary);';
            sTitle.textContent = 'Skills Auto Detected';
            sectionHeader.appendChild(sTitle);
            const countBadge = document.createElement('span');
            countBadge.style.cssText = 'font-size: 11px; color: var(--text-secondary); background: var(--bg-secondary); padding: 2px 8px; border-radius: 10px; border: 1px solid var(--border-default);';
            countBadge.textContent = '0 found';
            sectionHeader.appendChild(countBadge);
        }

        // Spacer to push buttons right
        const headerSpacer = document.createElement('div');
        headerSpacer.style.cssText = 'flex: 1;';
        sectionHeader.appendChild(headerSpacer);
        sectionHeader.appendChild(statusSpan);

        if (discovered.length > 0) {
            const scanSelectedBtn = document.createElement('button');
            scanSelectedBtn.className = 'btn btn-primary';
            scanSelectedBtn.style.cssText = 'font-size: 12px; padding: 5px 14px;';
            scanSelectedBtn.textContent = 'Scan Selected';
            scanSelectedBtn.addEventListener('click', () => {
                const paths = Array.from(selectedPaths);
                if (!paths.length) { if (window.Toast) Toast.show('Select at least one skill', 'error'); return; }
                this._runScan(paths, scanSelectedBtn, statusSpan, container);
            });
            sectionHeader.appendChild(scanSelectedBtn);

            const scanAllBtn = document.createElement('button');
            scanAllBtn.className = 'btn';
            scanAllBtn.style.cssText = 'font-size: 12px; padding: 5px 14px;';
            scanAllBtn.textContent = 'Scan All';
            scanAllBtn.addEventListener('click', () => {
                this._runScan(discovered.map(s => s.path), scanAllBtn, statusSpan, container);
            });
            sectionHeader.appendChild(scanAllBtn);
        }

        section.appendChild(sectionHeader);

        if (discovered.length > 0) {
            // Collapsible grid area (collapsed by default)
            const gridArea = document.createElement('div');
            gridArea.style.cssText = 'display: none;';

            // Show searched directories inside collapsible
            if (searchedDirs.length > 0) {
                const dirsHint = document.createElement('div');
                dirsHint.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 10px; line-height: 1.5;';
                const codeCss = 'font-size: 10px; background: var(--bg-secondary); padding: 1px 5px; border-radius: 3px; border: 1px solid var(--border-default);';
                const displayDirs = searchedDirs
                    .map(d => d.replace(/^\/home\/[^/]+/, '~').replace(/^\/mnt\/c\/Users\/[^/]+/, '(Win) ~'));
                const uniqueDirs = [...new Set(displayDirs)].slice(0, 6);
                // Build dirs display using safe DOM methods
                uniqueDirs.forEach((d, i) => {
                    if (i > 0) dirsHint.appendChild(document.createTextNode(' '));
                    const code = document.createElement('code');
                    code.style.cssText = codeCss;
                    code.textContent = d;
                    dirsHint.appendChild(code);
                });
                if (searchedDirs.length > 6) {
                    const extra = document.createElement('span');
                    extra.style.opacity = '0.6';
                    extra.textContent = ` +${searchedDirs.length - 6} more`;
                    dirsHint.appendChild(extra);
                }
                gridArea.appendChild(dirsHint);
            }

            const sourceColors = { openclaw: '#5eadb8', mcp: '#8b5cf6', claude: '#f59e0b', custom: '#6b7280' };
            const grid = document.createElement('div');
            grid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; margin-bottom: 14px;';

            discovered.forEach(skill => {
                const card = document.createElement('div');
                card.style.cssText = 'display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 8px; border: 1.5px solid var(--accent-primary); background: rgba(94,173,184,0.06); cursor: pointer; transition: all 0.15s; user-select: none;';
                selectedPaths.add(skill.path);

                const check = document.createElement('span');
                check.style.cssText = 'width: 16px; height: 16px; border-radius: 4px; border: 2px solid var(--accent-primary); background: var(--accent-primary); display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 10px; color: #fff; font-weight: 700;';
                check.textContent = '\u2713';

                const info = document.createElement('div');
                info.style.cssText = 'min-width: 0; flex: 1;';
                const nameRow = document.createElement('div');
                nameRow.style.cssText = 'display: flex; align-items: center; gap: 6px;';
                const nameEl = document.createElement('span');
                nameEl.style.cssText = 'font-size: 13px; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
                nameEl.textContent = skill.name;
                nameRow.appendChild(nameEl);
                if (skill.source) {
                    const srcBadge = document.createElement('span');
                    const sc = sourceColors[skill.source] || sourceColors.custom;
                    srcBadge.style.cssText = `font-size: 9px; padding: 1px 5px; border-radius: 3px; background: ${sc}18; color: ${sc}; font-weight: 600; text-transform: uppercase; flex-shrink: 0;`;
                    srcBadge.textContent = skill.source;
                    nameRow.appendChild(srcBadge);
                }
                info.appendChild(nameRow);
                const pathEl = document.createElement('div');
                pathEl.style.cssText = 'font-size: 10px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.7;';
                pathEl.textContent = skill.path.replace(/^\/home\/[^/]+/, '~');
                pathEl.title = skill.path;
                info.appendChild(pathEl);

                card.appendChild(check);
                card.appendChild(info);

                const setSelected = (sel) => {
                    if (sel) {
                        card.style.borderColor = 'var(--accent-primary)';
                        card.style.background = 'rgba(94,173,184,0.06)';
                        check.style.background = 'var(--accent-primary)';
                        check.style.borderColor = 'var(--accent-primary)';
                        check.textContent = '\u2713';
                    } else {
                        card.style.borderColor = 'var(--border-default)';
                        card.style.background = 'transparent';
                        check.style.background = 'transparent';
                        check.style.borderColor = 'var(--border-default)';
                        check.textContent = '';
                    }
                };

                card.addEventListener('click', () => {
                    if (selectedPaths.has(skill.path)) {
                        selectedPaths.delete(skill.path);
                        setSelected(false);
                    } else {
                        selectedPaths.add(skill.path);
                        setSelected(true);
                    }
                });
                card.addEventListener('mouseenter', () => { card.style.transform = 'translateY(-1px)'; });
                card.addEventListener('mouseleave', () => { card.style.transform = ''; });

                grid.appendChild(card);
            });
            gridArea.appendChild(grid);
            section.appendChild(gridArea);

            // Toggle expand/collapse on the summary row
            sectionHeader.querySelector('div').addEventListener('click', () => {
                const expanded = gridArea.style.display !== 'none';
                gridArea.style.display = expanded ? 'none' : 'block';
                const chev = sectionHeader.querySelector('.skills-chevron');
                if (chev) chev.style.transform = expanded ? '' : 'rotate(90deg)';
            });
        } else {
            // Empty state — no skills detected
            const empty = document.createElement('div');
            empty.style.cssText = 'padding: 16px 20px; border-radius: 8px; border: 1px dashed var(--border-default); color: var(--text-secondary); font-size: 12px; line-height: 1.6;';
            const codeCss = 'font-size: 11px; background: var(--bg-secondary); padding: 1px 4px; border-radius: 3px;';
            const displayDirs = (searchedDirs.length > 0 ? searchedDirs : ['~/.openclaw/skills', '~/.mcp/skills', '~/.claude/skills'])
                .map(d => d.replace(/^\/home\/[^/]+/, '~').replace(/^\/mnt\/c\/Users\/[^/]+/, '(Win) ~'))
                .slice(0, 4);
            empty.textContent = 'No skills detected. Use Scan Path below to scan any directory before installing.';
            section.appendChild(empty);
        }
        container.appendChild(section);

        // ── Scan (unified: URL or path) ──────────────────────────────
        const scanSection = document.createElement('div');
        scanSection.style.cssText = 'margin-bottom: 20px; border-radius: 8px;';

        const scanHeader = document.createElement('div');
        scanHeader.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 10px;';
        const scanTitle = document.createElement('div');
        scanTitle.style.cssText = 'font-size: 13px; font-weight: 700; color: var(--text-primary);';
        scanTitle.textContent = 'Scan URL or Path';
        scanHeader.appendChild(scanTitle);
        const scanHintBadge = document.createElement('span');
        scanHintBadge.style.cssText = 'font-size: 10px; color: var(--text-secondary); background: var(--bg-secondary); padding: 2px 8px; border-radius: 10px; border: 1px solid var(--border-default);';
        scanHintBadge.textContent = 'GitHub \u2022 npm \u2022 .zip/.tar.gz \u2022 local path';
        scanHeader.appendChild(scanHintBadge);
        const scanSpacer = document.createElement('div');
        scanSpacer.style.cssText = 'flex: 1;';
        scanHeader.appendChild(scanSpacer);
        const scanHint = document.createElement('span');
        scanHint.style.cssText = 'font-size: 11px; color: var(--text-secondary); opacity: 0.7;';
        scanHint.textContent = 'Scan skills before you install or run them';
        scanHeader.appendChild(scanHint);
        scanSection.appendChild(scanHeader);

        // Input row: text field + Add + Scan
        const scanRow = document.createElement('div');
        scanRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 8px;';
        const scanInput = document.createElement('input');
        scanInput.type = 'text';
        scanInput.placeholder = 'https://github.com/owner/skill-name or ~/.openclaw/skills/my-skill';
        scanInput.className = 'form-input';
        scanInput.style.cssText = 'flex: 1; font-size: 13px;';
        scanRow.appendChild(scanInput);

        const addBtn = document.createElement('button');
        addBtn.className = 'btn';
        addBtn.style.cssText = 'font-size: 13px; padding: 7px 16px; white-space: nowrap;';
        addBtn.textContent = '+ Add';
        scanRow.appendChild(addBtn);

        const scanBtn = document.createElement('button');
        scanBtn.className = 'btn btn-primary';
        scanBtn.style.cssText = 'font-size: 13px; padding: 7px 20px; white-space: nowrap;';
        scanBtn.textContent = 'Scan';
        scanRow.appendChild(scanBtn);
        scanSection.appendChild(scanRow);

        // Queue list (hidden when empty)
        const scanQueue = [];
        const queueList = document.createElement('div');
        queueList.style.cssText = 'display: none; flex-direction: column; gap: 4px; margin-bottom: 10px;';
        scanSection.appendChild(queueList);

        const _renderQueue = () => {
            queueList.textContent = '';
            queueList.style.display = scanQueue.length ? 'flex' : 'none';
            scanQueue.forEach((entry, idx) => {
                const row = document.createElement('div');
                row.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--bg-secondary); border: 1px solid var(--border-default); border-radius: 6px; font-size: 12px;';

                // Status icon (pending by default)
                const statusIcon = document.createElement('span');
                statusIcon.style.cssText = 'flex-shrink: 0; width: 16px; text-align: center; color: var(--text-muted);';
                statusIcon.textContent = '\u25CB';
                statusIcon.dataset.queueIdx = idx;
                row.appendChild(statusIcon);

                const label = document.createElement('span');
                label.style.cssText = 'flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary);';
                label.textContent = entry;
                label.title = entry;
                row.appendChild(label);

                // Result area (filled after scan)
                const resultSpan = document.createElement('span');
                resultSpan.style.cssText = 'font-size: 11px; color: var(--text-secondary); white-space: nowrap;';
                resultSpan.dataset.queueResult = idx;
                row.appendChild(resultSpan);

                const removeBtn = document.createElement('span');
                removeBtn.style.cssText = 'cursor: pointer; color: var(--text-muted); font-size: 14px; flex-shrink: 0; line-height: 1;';
                removeBtn.textContent = '\u00D7';
                removeBtn.title = 'Remove';
                removeBtn.addEventListener('click', () => {
                    scanQueue.splice(idx, 1);
                    _renderQueue();
                });
                row.appendChild(removeBtn);

                queueList.appendChild(row);
            });
        };

        const _addToQueue = () => {
            const val = scanInput.value.trim();
            const err = _validateInput(val);
            if (err) {
                if (window.Toast) Toast.show(err, 'error');
                return;
            }
            if (scanQueue.includes(val)) {
                if (window.Toast) Toast.show('Already in queue', 'error');
                return;
            }
            scanQueue.push(val);
            scanInput.value = '';
            scanInput.focus();
            _renderQueue();
        };

        addBtn.addEventListener('click', _addToQueue);
        scanInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                // If queue has items, add to queue; otherwise scan directly
                if (scanQueue.length > 0 || scanInput.value.trim()) {
                    if (scanQueue.length > 0) {
                        // Add current input if non-empty, then scan all
                        if (scanInput.value.trim()) _addToQueue();
                        scanBtn.click();
                    } else {
                        // Single item — scan directly
                        scanBtn.click();
                    }
                }
            }
        });

        const scanStatus = document.createElement('div');
        scanStatus.style.cssText = 'font-size: 12px; color: var(--text-secondary); display: none; padding: 8px 12px; background: var(--bg-secondary); border-radius: 6px; border: 1px solid var(--border-default);';
        scanSection.appendChild(scanStatus);

        // Progress bar (hidden by default)
        const progressWrap = document.createElement('div');
        progressWrap.style.cssText = 'display: none; margin-bottom: 10px;';
        const progressBarOuter = document.createElement('div');
        progressBarOuter.style.cssText = 'width: 100%; height: 6px; border-radius: 3px; background: var(--bg-tertiary); overflow: hidden;';
        const progressBarInner = document.createElement('div');
        progressBarInner.style.cssText = 'width: 0%; height: 100%; border-radius: 3px; background: var(--accent-primary); transition: width 0.3s ease;';
        progressBarOuter.appendChild(progressBarInner);
        const progressLabel = document.createElement('div');
        progressLabel.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-top: 4px; text-align: right;';
        progressWrap.appendChild(progressBarOuter);
        progressWrap.appendChild(progressLabel);
        scanSection.appendChild(progressWrap);

        const _updateProgress = (completed, total) => {
            progressWrap.style.display = 'block';
            const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
            progressBarInner.style.width = pct + '%';
            progressLabel.textContent = `${completed}/${total} completed`;
            if (completed >= total) {
                progressBarInner.style.background = '#10b981';
                progressLabel.textContent = `${total}/${total} done`;
            } else {
                progressBarInner.style.background = 'var(--accent-primary)';
            }
        };

        const urlResultArea = document.createElement('div');
        scanSection.appendChild(urlResultArea);

        const _isUrl = (v) => /^https?:\/\//i.test(v);

        // Basic input validation — reject values that are clearly not a URL or filesystem path
        const _validateInput = (val) => {
            if (!val) return 'Enter a URL or path first';
            if (_isUrl(val)) {
                // Must have a domain after the protocol
                if (!/^https?:\/\/[a-zA-Z0-9.-]+/.test(val)) return 'Invalid URL format';
                return null;
            }
            // Path: must start with / ~ . or a drive letter (C:\)
            if (/^[\/~.]/.test(val) || /^[a-zA-Z]:[\\\/]/.test(val)) return null;
            // Reject anything else (plain text, random words, etc.)
            return 'Enter a valid URL (https://...) or filesystem path (/path/to/skill)';
        };

        // Helper to update status with step indicator
        const _setStatus = (step, msg, color) => {
            scanStatus.style.display = 'block';
            scanStatus.style.color = color || 'var(--text-secondary)';
            scanStatus.textContent = '';
            const stepEl = document.createElement('span');
            stepEl.style.cssText = 'font-weight: 600; margin-right: 6px;';
            stepEl.textContent = step;
            scanStatus.appendChild(stepEl);
            scanStatus.appendChild(document.createTextNode(msg));
        };

        // Update a queue row's status icon and result text
        const _updateQueueRow = (idx, icon, iconColor, resultText, resultColor) => {
            const iconEl = queueList.querySelector(`[data-queue-idx="${idx}"]`);
            if (iconEl) { iconEl.textContent = icon; iconEl.style.color = iconColor; }
            const resultEl = queueList.querySelector(`[data-queue-result="${idx}"]`);
            if (resultEl) { resultEl.textContent = resultText; resultEl.style.color = resultColor || 'var(--text-secondary)'; }
        };

        // Scan a single URL and return result data
        const _scanOneUrl = async (url, idx) => {
            _updateQueueRow(idx, '\u21BB', 'var(--accent-primary)', 'downloading\u2026', 'var(--text-muted)');

            try {
                const downloadTimer = setTimeout(() => {
                    _updateQueueRow(idx, '\u2699', 'var(--accent-primary)', 'scanning\u2026', 'var(--text-muted)');
                }, 3000);

                const resp = await fetch('/api/skill-scans/scan-url', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url }),
                });
                clearTimeout(downloadTimer);
                const data = resp.ok ? await resp.json() : null;

                if (!data || !data.success) {
                    const errMsg = (data && data.error) ? data.error : `HTTP ${resp.status}`;
                    _updateQueueRow(idx, '\u2717', '#ef4444', errMsg, '#ef4444');
                    return null;
                }

                const RISK_COLOR = { HIGH: '#ef4444', MEDIUM: '#f59e0b', LOW: '#10b981' };
                const risk = (data.result && data.result.risk_level) || 'LOW';
                const rc = RISK_COLOR[risk] || '#10b981';
                const findings = (data.result && data.result.findings_count) || 0;
                const action = (data.policy && data.policy.action) ? data.policy.action.toUpperCase() : '';
                const ai = data.ai_review;
                let aiTag = '';
                if (ai && ai.reviewed) {
                    const aiRisk = ai.ai_risk_level || risk;
                    aiTag = ai.false_positives > 0
                        ? ` \u00B7 AI: ${aiRisk} (${ai.false_positives} FP)`
                        : ` \u00B7 AI: confirmed`;
                }
                const summary = `${risk} \u00B7 ${findings} finding${findings !== 1 ? 's' : ''}${action ? ' \u00B7 ' + action : ''}${aiTag}`;
                _updateQueueRow(idx, '\u2713', rc, summary, rc);
                return data;
            } catch (e) {
                _updateQueueRow(idx, '\u2717', '#ef4444', 'network error', '#ef4444');
                return null;
            }
        };

        scanBtn.addEventListener('click', async () => {
            // If queue is empty, treat the input as a single scan (original behavior)
            if (scanQueue.length === 0) {
                const val = scanInput.value.trim();
                const valErr = _validateInput(val);
                if (valErr) { if (window.Toast) Toast.show(valErr, 'error'); return; }

                if (_isUrl(val)) {
                    scanQueue.push(val);
                    scanInput.value = '';
                    _renderQueue();
                    // Fall through to batch scan below
                } else {
                    // Path scan
                    scanStatus.style.display = 'none';
                    urlResultArea.textContent = '';
                    this._runScan([val], scanBtn, statusSpan, container);
                    return;
                }
            } else if (scanInput.value.trim()) {
                // Add any remaining input to queue
                _addToQueue();
            }

            // Batch scan all queued items
            scanBtn.disabled = true;
            addBtn.disabled = true;
            scanInput.disabled = true;
            const totalItems = scanQueue.length;
            scanBtn.textContent = `Scanning 0/${totalItems}\u2026`;
            urlResultArea.textContent = '';
            scanStatus.style.display = 'none';
            _updateProgress(0, totalItems);

            // Separate URLs and paths
            const urls = [];
            const paths = [];
            scanQueue.forEach((val, idx) => {
                if (_isUrl(val)) urls.push({ val, idx });
                else paths.push({ val, idx });
            });

            // Scan URLs sequentially (they download, so no parallel to avoid overload)
            const urlResults = [];
            let completed = 0;
            for (const { val, idx } of urls) {
                scanBtn.textContent = `Scanning ${completed + 1}/${totalItems}\u2026`;
                const data = await _scanOneUrl(val, idx);
                if (data) urlResults.push(data);
                completed++;
                _updateProgress(completed, totalItems);
            }

            // Scan local paths in one batch
            if (paths.length > 0) {
                paths.forEach(({ idx }) => _updateQueueRow(idx, '\u2699', 'var(--accent-primary)', 'scanning\u2026', 'var(--text-muted)'));
                scanBtn.textContent = `Scanning ${completed + 1}/${totalItems}\u2026`;

                try {
                    const pathVals = paths.map(p => p.val);
                    // Use the existing batch scan endpoint
                    const resp = await fetch('/api/skill-scans/scan', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ paths: pathVals }),
                    });
                    const results = resp.ok ? await resp.json() : [];
                    const resultArr = Array.isArray(results) ? results : (results.results || []);

                    resultArr.forEach((item, i) => {
                        const idx = paths[i].idx;
                        if (item.success && item.result) {
                            const RISK_COLOR = { HIGH: '#ef4444', MEDIUM: '#f59e0b', LOW: '#10b981' };
                            const risk = item.result.risk_level || 'LOW';
                            const rc = RISK_COLOR[risk] || '#10b981';
                            const findings = item.result.findings_count || 0;
                            const action = (item.policy && item.policy.action) ? item.policy.action.toUpperCase() : '';
                            _updateQueueRow(idx, '\u2713', rc, `${risk} \u00B7 ${findings} finding${findings !== 1 ? 's' : ''}${action ? ' \u00B7 ' + action : ''}`, rc);
                        } else {
                            _updateQueueRow(idx, '\u2717', '#ef4444', item.error || 'scan failed', '#ef4444');
                        }
                    });

                    completed += paths.length;
                    _updateProgress(completed, totalItems);

                    // Store for inline results display
                    if (resultArr.length > 0) {
                        this._lastScanResults = resultArr;
                        const resultsArea = document.getElementById('ss-scan-results');
                        if (resultsArea) this._renderScanResults(resultsArea, resultArr);
                    }
                } catch (e) {
                    paths.forEach(({ idx }) => _updateQueueRow(idx, '\u2717', '#ef4444', 'network error', '#ef4444'));
                    completed += paths.length;
                    _updateProgress(completed, totalItems);
                }
            }

            // Collect all successful results for selection UI
            const allResults = urlResults.filter(Boolean);

            // Summary status
            const total = scanQueue.length;
            _setStatus('\u2713', `Scanned ${total} item${total !== 1 ? 's' : ''}`);

            scanBtn.disabled = false;
            addBtn.disabled = false;
            scanInput.disabled = false;
            scanBtn.textContent = 'Scan';

            // Clear queue
            scanQueue.length = 0;

            // Render selection UI for URL results that have temp_path (installable)
            if (allResults.length > 0) {
                this._renderInstallSelection(urlResultArea, allResults);
            }
        });

        container.appendChild(scanSection);

        // Inline results area
        const resultsArea = document.createElement('div');
        resultsArea.id = 'ss-scan-results';
        container.appendChild(resultsArea);

        if (this._lastScanResults) {
            this._renderScanResults(resultsArea, this._lastScanResults);
        }

        // Flash cyan highlight on key sections — once per session, staggered
        if (!sessionStorage.getItem('sv-scanner-flashed')) {
            sessionStorage.setItem('sv-scanner-flashed', '1');
            if (!document.getElementById('sv-flash-style')) {
                const flashStyle = document.createElement('style');
                flashStyle.id = 'sv-flash-style';
                flashStyle.textContent = '@keyframes sv-cyan-flash { 0%, 100% { box-shadow: none; } 50% { box-shadow: 0 0 0 2px rgba(94,173,184,0.5), 0 0 12px rgba(94,173,184,0.2); } }';
                document.head.appendChild(flashStyle);
            }
            const flashAnim = 'sv-cyan-flash 0.8s ease-in-out 3';
            // Skills Detected first (after page settles)
            if (summaryToggle) {
                setTimeout(() => { summaryToggle.style.animation = flashAnim; }, 400);
            }
            // Scan section second (staggered)
            setTimeout(() => { scanSection.style.animation = flashAnim; }, 1900);
        }
    },

    _renderInstallSelection(container, allResults) {
        container.textContent = '';
        const RISK_COLOR = { HIGH: '#ef4444', MEDIUM: '#f59e0b', LOW: '#10b981' };
        const POLICY_COLOR = { allow: '#10b981', warn: '#f59e0b', block: '#ef4444' };

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'margin-top: 16px; padding: 16px; border-radius: 10px; border: 1px solid rgba(94, 173, 184, 0.25); background: rgba(94, 173, 184, 0.04); border-left: 3px solid var(--accent-primary);';

        // Header
        const header = document.createElement('div');
        header.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;';
        const title = document.createElement('div');
        title.style.cssText = 'font-size: 15px; font-weight: 800; color: var(--accent-primary); letter-spacing: 0.3px;';
        title.textContent = 'Scan Results';
        header.appendChild(title);

        const installBtn = document.createElement('button');
        installBtn.className = 'btn btn-primary';
        installBtn.style.cssText = 'font-size: 12px; padding: 6px 18px;';
        installBtn.textContent = 'Install Selected';
        header.appendChild(installBtn);
        wrapper.appendChild(header);

        // Selection state
        const selected = new Set();

        // Build rows
        const rows = [];
        allResults.forEach((data, idx) => {
            const rec = data.result;
            const policy = data.policy;
            if (!rec) return;

            const risk = rec.risk_level || 'LOW';
            const rc = RISK_COLOR[risk] || '#10b981';
            const isRisky = risk === 'MEDIUM' || risk === 'HIGH';
            const isBlocked = policy && policy.action === 'block';

            // Pre-select LOW risk only
            if (!isRisky && !isBlocked) selected.add(idx);

            const row = document.createElement('div');
            row.style.cssText = 'display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: 8px; border: 1px solid var(--border-light); background: var(--bg-tertiary); cursor: pointer; transition: all 0.15s; user-select: none; margin-bottom: 6px;';

            // Checkbox
            const check = document.createElement('span');
            check.style.cssText = 'width: 16px; height: 16px; border-radius: 4px; border: 2px solid var(--border-light); display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 10px; color: #fff; font-weight: 700;';

            const updateCheck = () => {
                const sel = selected.has(idx);
                if (sel) {
                    check.style.background = 'var(--accent-primary)';
                    check.style.borderColor = 'var(--accent-primary)';
                    check.textContent = '\u2713';
                    row.style.borderColor = 'var(--accent-primary)';
                } else {
                    check.style.background = 'transparent';
                    check.style.borderColor = 'var(--border-light)';
                    check.textContent = '';
                    row.style.borderColor = 'var(--border-light)';
                }
                // Update install button count
                installBtn.textContent = selected.size > 0 ? `Install Selected (${selected.size})` : 'Install Selected';
                installBtn.disabled = selected.size === 0;
            };

            row.addEventListener('click', () => {
                if (isBlocked) {
                    this._openDrawer(rec, policy, data.ai_review);
                    return;
                }
                if (selected.has(idx)) {
                    selected.delete(idx);
                } else {
                    // Confirm for risky skills
                    if (isRisky) {
                        if (!confirm(`${data.skill_name || rec.skill_name} is ${risk} risk with ${rec.findings_count ?? 0} finding${(rec.findings_count ?? 0) !== 1 ? 's' : ''}. Are you sure you want to install it?`)) return;
                    }
                    selected.add(idx);
                }
                updateCheck();
            });

            row.appendChild(check);

            // Skill info
            const info = document.createElement('div');
            info.style.cssText = 'flex: 1; min-width: 0;';
            const nameEl = document.createElement('span');
            nameEl.style.cssText = 'font-size: 13px; font-weight: 600; color: var(--text-primary);';
            nameEl.textContent = data.skill_name || rec.skill_name;
            info.appendChild(nameEl);

            if (data.source_url) {
                const urlEl = document.createElement('div');
                urlEl.style.cssText = 'font-size: 10px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.7; margin-top: 2px;';
                urlEl.textContent = data.source_url.length > 60 ? data.source_url.slice(0, 57) + '\u2026' : data.source_url;
                urlEl.title = data.source_url;
                info.appendChild(urlEl);
            }
            row.appendChild(info);

            // Risk badge
            const riskBadge = document.createElement('span');
            riskBadge.style.cssText = `background: ${rc}; color: #fff; border-radius: 3px; padding: 2px 8px; font-size: 11px; font-weight: 700;`;
            riskBadge.textContent = risk;
            row.appendChild(riskBadge);

            // Findings count
            const findingsEl = document.createElement('span');
            findingsEl.style.cssText = 'font-size: 12px; color: var(--text-secondary); white-space: nowrap;';
            findingsEl.textContent = `${rec.findings_count ?? 0} finding${(rec.findings_count ?? 0) !== 1 ? 's' : ''}`;
            row.appendChild(findingsEl);

            // Policy badge
            if (policy) {
                const pc = POLICY_COLOR[policy.action] || '#888';
                const pBadge = document.createElement('span');
                pBadge.style.cssText = `background: ${pc}; color: #fff; border-radius: 3px; padding: 2px 8px; font-size: 11px; font-weight: 700;`;
                pBadge.textContent = policy.action.toUpperCase();
                row.appendChild(pBadge);
            }

            // AI review badge with icon
            const aiReview = data.ai_review;
            if (aiReview && aiReview.reviewed) {
                const aiBadge = document.createElement('span');
                aiBadge.style.cssText = 'display: inline-flex; align-items: center; gap: 4px; background: var(--accent-primary); color: #fff; border-radius: 3px; padding: 2px 8px; font-size: 10px; font-weight: 700; white-space: nowrap;';
                const aiSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                aiSvg.setAttribute('viewBox', '0 0 24 24');
                aiSvg.setAttribute('fill', 'none');
                aiSvg.setAttribute('stroke', 'currentColor');
                aiSvg.setAttribute('stroke-width', '2.5');
                aiSvg.style.cssText = 'width: 10px; height: 10px; flex-shrink: 0;';
                const aiCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                aiCircle.setAttribute('cx', '12');
                aiCircle.setAttribute('cy', '12');
                aiCircle.setAttribute('r', '3');
                aiSvg.appendChild(aiCircle);
                const aiRays = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                aiRays.setAttribute('d', 'M12 1v4M12 19v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M1 12h4M19 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83');
                aiSvg.appendChild(aiRays);
                aiBadge.appendChild(aiSvg);
                const aiText = document.createElement('span');
                if (aiReview.false_positives > 0) {
                    aiText.textContent = `AI: ${aiReview.ai_risk_level} (${aiReview.false_positives} FP)`;
                    aiBadge.title = `AI analysis found ${aiReview.false_positives} false positive${aiReview.false_positives !== 1 ? 's' : ''}, adjusted risk to ${aiReview.ai_risk_level}`;
                } else {
                    aiText.textContent = 'AI: confirmed';
                    aiBadge.title = 'AI analysis confirmed all findings are genuine';
                }
                aiBadge.appendChild(aiText);
                row.appendChild(aiBadge);
            }

            // View details link
            const detailLink = document.createElement('span');
            detailLink.style.cssText = 'font-size: 11px; color: var(--accent-primary); cursor: pointer; white-space: nowrap;';
            detailLink.textContent = 'details';
            detailLink.addEventListener('click', (e) => {
                e.stopPropagation();
                this._openDrawer(rec, policy, data.ai_review);
            });
            row.appendChild(detailLink);

            // Inline expandable findings for MEDIUM+ risk
            const detailPanel = document.createElement('div');
            detailPanel.style.cssText = 'display: none; padding: 8px 14px 10px; border: 1px solid var(--border-light); border-top: none; border-radius: 0 0 8px 8px; background: var(--bg-tertiary); margin-top: -7px; margin-bottom: 6px;';

            if (isRisky && rec.findings && rec.findings.length > 0) {
                // Show "View findings" toggle instead of plain count
                findingsEl.style.cssText = 'font-size: 12px; color: var(--accent-primary); white-space: nowrap; cursor: pointer;';
                findingsEl.textContent = `${rec.findings_count} finding${rec.findings_count !== 1 ? 's' : ''} \u25BC`;
                let panelOpen = false;

                findingsEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    panelOpen = !panelOpen;
                    detailPanel.style.display = panelOpen ? 'block' : 'none';
                    findingsEl.textContent = `${rec.findings_count} finding${rec.findings_count !== 1 ? 's' : ''} ${panelOpen ? '\u25B2' : '\u25BC'}`;
                });

                // Render findings into panel
                const SEV_COLOR = { critical: '#ef4444', high: '#ef4444', medium: '#f59e0b', low: '#6b7280', info: '#3b82f6' };
                rec.findings.forEach(f => {
                    const isFP = f.ai_verdict === 'false_positive';
                    const item = document.createElement('div');
                    item.style.cssText = `padding: 5px 0; border-bottom: 1px solid var(--border-default);${isFP ? ' opacity: 0.5;' : ''}`;

                    const topRow = document.createElement('div');
                    topRow.style.cssText = 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;';

                    // AI verdict badge (if reviewed)
                    if (f.ai_verdict) {
                        const aiTag = document.createElement('span');
                        if (isFP) {
                            aiTag.style.cssText = 'background: #6b728822; color: #6b7280; border-radius: 3px; padding: 1px 5px; font-size: 9px; font-weight: 700; text-decoration: line-through;';
                            aiTag.textContent = 'FALSE POSITIVE';
                            aiTag.title = f.ai_explanation || 'AI determined this is not a genuine threat';
                        } else {
                            aiTag.style.cssText = 'background: #ef444422; color: #ef4444; border-radius: 3px; padding: 1px 5px; font-size: 9px; font-weight: 700;';
                            aiTag.textContent = 'CONFIRMED';
                            aiTag.title = f.ai_explanation || 'AI confirmed this finding';
                        }
                        topRow.appendChild(aiTag);
                    }

                    const sevBadge = document.createElement('span');
                    sevBadge.style.cssText = `background: ${SEV_COLOR[f.severity] || '#6b7280'}; color: #fff; border-radius: 3px; padding: 1px 5px; font-size: 10px; font-weight: 700;${isFP ? ' text-decoration: line-through;' : ''}`;
                    sevBadge.textContent = (f.severity || '').toUpperCase();
                    topRow.appendChild(sevBadge);

                    const cat = document.createElement('span');
                    cat.style.cssText = `font-size: 12px; font-weight: 600; color: var(--text-primary);${isFP ? ' text-decoration: line-through;' : ''}`;
                    cat.textContent = f.category;
                    topRow.appendChild(cat);

                    // Rule ID — clickable, navigates to Skill Policy
                    if (f.rule_id) {
                        const ruleTag = document.createElement('span');
                        ruleTag.style.cssText = 'font-size: 10px; color: var(--accent-primary); background: var(--bg-tertiary); border-radius: 3px; padding: 1px 5px; font-family: monospace; cursor: pointer;';
                        ruleTag.textContent = f.rule_id;
                        ruleTag.title = 'Click to manage this rule in Skill Policy';
                        ruleTag.addEventListener('click', (e) => {
                            e.stopPropagation();
                            if (window.Sidebar) Sidebar.navigate('skill-permissions');
                        });
                        topRow.appendChild(ruleTag);
                    }

                    const loc = f.line_number ? `${f.file_path}:${f.line_number}` : (f.file_path || '');
                    if (loc) {
                        const locEl = document.createElement('span');
                        locEl.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-left: auto;';
                        locEl.textContent = loc;
                        topRow.appendChild(locEl);
                    }
                    item.appendChild(topRow);

                    // AI explanation
                    if (f.ai_explanation) {
                        const aiReason = document.createElement('div');
                        aiReason.style.cssText = 'font-size: 10px; color: var(--text-secondary); margin-top: 2px; font-style: italic;';
                        aiReason.textContent = `AI: ${f.ai_explanation}`;
                        item.appendChild(aiReason);
                    }

                    if (f.excerpt) {
                        const exc = document.createElement('code');
                        exc.style.cssText = 'display: block; font-size: 11px; color: var(--text-secondary); margin-top: 3px; white-space: pre-wrap; word-break: break-all;';
                        exc.textContent = f.excerpt;
                        item.appendChild(exc);
                    }

                    // Fix guidance for missing_manifest
                    if (f.category === 'missing_manifest') {
                        const hint = document.createElement('div');
                        hint.style.cssText = 'font-size: 10px; color: var(--text-secondary); margin-top: 4px; line-height: 1.4;';
                        const hintText = document.createTextNode('Fix: Add a permissions.yml manifest to the skill, or ');
                        hint.appendChild(hintText);
                        const policyLink = document.createElement('span');
                        policyLink.style.cssText = 'color: var(--accent-primary); cursor: pointer; text-decoration: underline;';
                        policyLink.textContent = 'disable this check in Skill Policy';
                        policyLink.addEventListener('click', (e) => { e.stopPropagation(); if (window.Sidebar) Sidebar.navigate('skill-permissions'); });
                        hint.appendChild(policyLink);
                        hint.appendChild(document.createTextNode(', or add the publisher as a '));
                        const trustLink = document.createElement('span');
                        trustLink.style.cssText = 'color: var(--accent-primary); cursor: pointer; text-decoration: underline;';
                        trustLink.textContent = 'trusted publisher';
                        trustLink.addEventListener('click', (e) => { e.stopPropagation(); if (window.Sidebar) Sidebar.navigate('skill-permissions'); });
                        hint.appendChild(trustLink);
                        hint.appendChild(document.createTextNode('.'));
                        item.appendChild(hint);
                    }
                    detailPanel.appendChild(item);
                });
            }

            // Blocked overlay
            if (isBlocked) {
                row.style.opacity = '0.5';
                row.style.cursor = 'not-allowed';
            }

            // Entrance highlight animation
            row.style.opacity = '0';
            row.style.transform = 'translateY(8px)';
            setTimeout(() => {
                row.style.transition = 'opacity 0.4s ease, transform 0.4s ease, box-shadow 0.4s ease';
                row.style.opacity = isBlocked ? '0.5' : '1';
                row.style.transform = 'translateY(0)';
                row.style.boxShadow = `0 0 0 1px ${rc}66, 0 0 12px ${rc}22`;
            }, idx * 120);
            // Fade out the glow after a moment
            setTimeout(() => {
                row.style.boxShadow = 'none';
            }, idx * 120 + 2000);

            wrapper.appendChild(row);
            if (isRisky && rec.findings && rec.findings.length > 0) {
                wrapper.appendChild(detailPanel);
            }
            rows.push({ row, idx, data, updateCheck });
            updateCheck();
        });

        // Install handler
        installBtn.addEventListener('click', async () => {
            if (selected.size === 0) return;
            installBtn.disabled = true;
            installBtn.textContent = 'Installing\u2026';

            let installed = 0;
            let failed = 0;
            for (const idx of selected) {
                const data = allResults[idx];
                if (!data || !data.temp_path) { failed++; continue; }
                try {
                    const resp = await fetch('/api/skill-scans/install', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ source_path: data.temp_path, skill_name: data.skill_name }),
                    });
                    const result = await resp.json();
                    if (resp.ok && result.installed) {
                        installed++;
                    } else {
                        failed++;
                    }
                } catch (e) {
                    failed++;
                }
            }

            if (installed > 0 && window.Toast) Toast.show(`${installed} skill${installed !== 1 ? 's' : ''} installed`, 'success');
            if (failed > 0 && window.Toast) Toast.show(`${failed} failed to install`, 'error');

            installBtn.textContent = `\u2713 ${installed} installed`;
            installBtn.style.background = '#10b981';
        });

        // Update initial button state
        installBtn.disabled = selected.size === 0;
        installBtn.textContent = selected.size > 0 ? `Install Selected (${selected.size})` : 'Install Selected';

        // Disclaimer
        const disclaimer = document.createElement('div');
        disclaimer.style.cssText = 'margin-top: 12px; text-align: center;';
        const disclaimerText = document.createElement('span');
        disclaimerText.style.cssText = 'font-size: 10px; color: var(--text-secondary); opacity: 0.5;';
        disclaimerText.textContent = 'SecureVector scans can make mistakes. Review findings before deciding.';
        disclaimer.appendChild(disclaimerText);
        wrapper.appendChild(disclaimer);

        container.appendChild(wrapper);
    },

    _renderUrlScanResult(container, data) {
        container.textContent = '';
        const POLICY_COLOR = { allow: '#10b981', warn: '#f59e0b', block: '#ef4444' };
        const rec = data.result;
        const policy = data.policy;

        const card = document.createElement('div');
        card.className = 'card';
        card.style.cssText = 'margin-top: 12px; padding: 16px;';

        // Header row: skill name + badges
        const header = document.createElement('div');
        header.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap;';

        const nameEl = document.createElement('span');
        nameEl.style.cssText = 'font-size: 14px; font-weight: 700; color: var(--text-primary);';
        nameEl.textContent = data.skill_name;
        header.appendChild(nameEl);

        const typeBadge = document.createElement('span');
        typeBadge.style.cssText = 'font-size: 10px; padding: 2px 8px; border-radius: 4px; background: rgba(94,173,184,0.1); color: var(--accent-primary); font-weight: 600;';
        typeBadge.textContent = (data.url_type || 'url').toUpperCase();
        header.appendChild(typeBadge);

        const RISK_COLOR = { HIGH: '#ef4444', MEDIUM: '#f59e0b', LOW: '#10b981' };
        if (rec) {
            const riskBadge = document.createElement('span');
            const rc = RISK_COLOR[rec.risk_level] || '#888';
            riskBadge.style.cssText = `background: ${rc}; color: #fff; border-radius: 3px; padding: 2px 8px; font-size: 11px; font-weight: 700;`;
            riskBadge.textContent = rec.risk_level + ' RISK';
            header.appendChild(riskBadge);

            const countEl = document.createElement('span');
            countEl.style.cssText = 'font-size: 12px; color: var(--text-secondary);';
            countEl.textContent = rec.findings_count + ' finding' + (rec.findings_count !== 1 ? 's' : '');
            header.appendChild(countEl);
        }

        if (policy) {
            const pc = POLICY_COLOR[policy.action] || '#888';
            const policyBadge = document.createElement('span');
            policyBadge.style.cssText = `background: ${pc}; color: #fff; border-radius: 3px; padding: 2px 10px; font-size: 11px; font-weight: 700; margin-left: auto;`;
            policyBadge.textContent = policy.action.toUpperCase();
            header.appendChild(policyBadge);
        }
        card.appendChild(header);

        // Source URL
        const srcRow = document.createElement('div');
        srcRow.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 12px;';
        const srcLink = document.createElement('a');
        srcLink.href = data.source_url;
        srcLink.target = '_blank';
        srcLink.rel = 'noopener noreferrer';
        srcLink.style.cssText = 'color: var(--accent-primary); text-decoration: none;';
        srcLink.textContent = data.source_url.length > 60 ? data.source_url.slice(0, 60) + '\u2026' : data.source_url;
        srcLink.title = data.source_url;
        srcRow.appendChild(srcLink);
        card.appendChild(srcRow);

        // Policy breakdown
        if (policy) {
            const breakdown = document.createElement('div');
            breakdown.style.cssText = 'display: flex; gap: 12px; margin-bottom: 14px; font-size: 12px;';
            [
                { label: 'Safe', count: policy.safe_count, color: '#10b981' },
                { label: 'Review', count: policy.review_count, color: '#f59e0b' },
                { label: 'Dangerous', count: policy.dangerous_count, color: '#ef4444' },
                { label: 'Unknown', count: policy.unknown_count, color: '#6b7280' },
            ].forEach(s => {
                const el = document.createElement('span');
                el.style.cssText = `color: ${s.color}; font-weight: 600;`;
                el.textContent = `${s.label}: ${s.count}`;
                breakdown.appendChild(el);
            });
            const scoreEl = document.createElement('span');
            scoreEl.style.cssText = 'color: var(--text-secondary); margin-left: auto;';
            scoreEl.textContent = 'Risk score: ' + policy.risk_score;
            breakdown.appendChild(scoreEl);
            card.appendChild(breakdown);
        }

        // Action buttons
        const actions = document.createElement('div');
        actions.style.cssText = 'display: flex; align-items: center; gap: 10px; padding-top: 12px; border-top: 1px solid var(--border-default);';

        if (data.temp_path) {
            const installBtn = document.createElement('button');
            const canInstall = !policy || policy.action !== 'block';
            installBtn.className = 'btn btn-primary';
            installBtn.style.cssText = 'font-size: 12px; padding: 6px 18px;';
            installBtn.textContent = 'Install to ~/.openclaw/skills/';
            installBtn.disabled = !canInstall;

            if (policy && policy.action === 'block') {
                installBtn.title = 'Installation blocked by policy \u2014 skill has too many dangerous findings';
                installBtn.style.opacity = '0.5';
            } else if (policy && policy.action === 'warn') {
                installBtn.textContent = 'Install (with warnings)';
            }

            installBtn.addEventListener('click', async () => {
                if (policy && policy.action === 'warn') {
                    if (!confirm('This skill has warnings. Install anyway?')) return;
                }
                installBtn.disabled = true;
                installBtn.textContent = 'Installing\u2026';
                try {
                    const resp = await fetch('/api/skill-scans/install', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ source_path: data.temp_path, skill_name: data.skill_name }),
                    });
                    const result = await resp.json();
                    if (resp.ok && result.installed) {
                        installBtn.textContent = '\u2713 Installed';
                        installBtn.style.background = '#10b981';
                        if (window.Toast) Toast.show(`Skill installed to ${result.install_path}`, 'success');
                    } else {
                        installBtn.textContent = 'Install Failed';
                        installBtn.disabled = false;
                        if (window.Toast) Toast.show(result.detail || 'Installation failed', 'error');
                    }
                } catch (e) {
                    installBtn.textContent = 'Install Failed';
                    installBtn.disabled = false;
                    if (window.Toast) Toast.show('Network error', 'error');
                }
            });
            actions.appendChild(installBtn);
        }

        // View details button
        if (rec) {
            const detailBtn = document.createElement('button');
            detailBtn.className = 'btn';
            detailBtn.style.cssText = 'font-size: 12px; padding: 6px 14px;';
            detailBtn.textContent = 'View Findings';
            detailBtn.addEventListener('click', () => this._openDrawer(rec, policy));
            actions.appendChild(detailBtn);
        }

        // Dismiss button
        const dismissBtn = document.createElement('button');
        dismissBtn.className = 'btn';
        dismissBtn.style.cssText = 'font-size: 12px; padding: 6px 14px; margin-left: auto; color: var(--text-secondary);';
        dismissBtn.textContent = 'Dismiss';
        dismissBtn.addEventListener('click', () => {
            container.textContent = '';
            // Cleanup temp dir
            if (data.temp_path) {
                fetch('/api/skill-scans/scan-url', { method: 'DELETE' }).catch(() => {});
            }
        });
        actions.appendChild(dismissBtn);

        card.appendChild(actions);
        container.appendChild(card);
    },

    _renderScanResults(container, results) {
        container.textContent = '';
        const successes = results.filter(r => r.success && r.result);
        if (!successes.length) return;

        successes.forEach(item => {
            const rec = item.result;
            const policy = item.policy;
            const card = document.createElement('div');
            card.className = 'card';
            card.style.cssText = 'margin-bottom: 12px; cursor: pointer;';
            card.addEventListener('click', () => this._openDrawer(rec, policy));

            const row = document.createElement('div');
            row.style.cssText = 'display: flex; align-items: center; gap: 12px; flex-wrap: wrap;';
            card.appendChild(row);

            // Skill name
            const name = document.createElement('div');
            name.style.cssText = 'font-weight: 600; font-size: 14px; color: var(--text-primary); min-width: 100px;';
            name.textContent = rec.skill_name;
            row.appendChild(name);

            // Risk badge
            const RISK_COLOR = { HIGH: '#ef4444', MEDIUM: '#f59e0b', LOW: '#10b981' };
            const riskBadge = document.createElement('span');
            const rc = RISK_COLOR[rec.risk_level] || '#888';
            riskBadge.style.cssText = `background: ${rc}; color: #fff; border-radius: 3px; padding: 2px 8px; font-size: 11px; font-weight: 700;`;
            riskBadge.textContent = rec.risk_level;
            row.appendChild(riskBadge);

            // Policy decision badge
            if (policy) {
                row.appendChild(this._buildPolicyBadge(policy));
            }

            // Findings count
            const findingsLabel = document.createElement('span');
            findingsLabel.style.cssText = 'font-size: 12px; color: var(--text-secondary); margin-left: auto;';
            findingsLabel.textContent = `${rec.findings_count} finding${rec.findings_count !== 1 ? 's' : ''}`;
            row.appendChild(findingsLabel);

            // Click hint
            const arrow = document.createElement('span');
            arrow.style.cssText = 'font-size: 14px; color: var(--text-secondary); opacity: 0.5;';
            arrow.textContent = '\u203A';
            row.appendChild(arrow);

            container.appendChild(card);
        });
    },

    _buildPolicyBadge(policy) {
        const ACTION_STYLE = {
            allow: { bg: 'rgba(16, 185, 129, 0.12)', color: '#10b981', border: 'rgba(16, 185, 129, 0.3)', icon: '\u2713' },
            warn:  { bg: 'rgba(245, 158, 11, 0.12)', color: '#f59e0b', border: 'rgba(245, 158, 11, 0.3)', icon: '\u26A0' },
            block: { bg: 'rgba(239, 68, 68, 0.12)', color: '#ef4444', border: 'rgba(239, 68, 68, 0.3)', icon: '\u2717' },
        };
        const s = ACTION_STYLE[policy.action] || ACTION_STYLE.warn;
        const badge = document.createElement('span');
        badge.style.cssText = `display: inline-flex; align-items: center; gap: 4px; background: ${s.bg}; color: ${s.color}; border: 1px solid ${s.border}; border-radius: 4px; padding: 2px 8px; font-size: 11px; font-weight: 700; letter-spacing: 0.3px;`;
        badge.textContent = `${s.icon} ${policy.action.toUpperCase()}`;
        if (policy.trusted_publisher) {
            const trust = document.createElement('span');
            trust.style.cssText = 'font-size: 9px; opacity: 0.7; margin-left: 2px;';
            trust.textContent = '\u2022 trusted';
            badge.appendChild(trust);
        }
        return badge;
    },

    // =====================================================================
    // History Tab
    // =====================================================================

    async _renderHistoryTab(container) {
        // Section divider
        const divider = document.createElement('div');
        divider.style.cssText = 'border-top: 1px solid var(--border-default); margin: 24px 0 16px;';
        container.appendChild(divider);

        const toolbar = document.createElement('div');
        toolbar.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;';
        container.appendChild(toolbar);

        const toolbarLeft = document.createElement('div');
        toolbarLeft.style.cssText = 'display: flex; align-items: center; gap: 10px;';
        const toolbarTitle = document.createElement('div');
        toolbarTitle.style.cssText = 'font-size: 14px; font-weight: 700; color: var(--text-primary);';
        toolbarTitle.textContent = 'Scan History';
        toolbarLeft.appendChild(toolbarTitle);
        const totalBadge = document.createElement('span');
        totalBadge.style.cssText = 'font-size: 11px; color: var(--text-secondary); background: var(--bg-secondary); padding: 2px 8px; border-radius: 10px; border: 1px solid var(--border-default);';
        toolbarLeft.appendChild(totalBadge);
        toolbar.appendChild(toolbarLeft);

        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'btn';
        refreshBtn.style.cssText = 'font-size: 11px; padding: 4px 10px;';
        refreshBtn.textContent = '\u21bb Refresh';
        toolbar.appendChild(refreshBtn);

        const historyArea = document.createElement('div');
        container.appendChild(historyArea);

        // Pagination state
        const PAGE_SIZE = 15;
        let currentPage = 0;
        let sortCol = 'scan_timestamp';
        let sortDir = 'desc';

        const columns = [
            { key: 'skill_name', label: 'Skill' },
            { key: 'scanned_path', label: 'Path' },
            { key: 'scan_timestamp', label: 'Scanned' },
            { key: 'risk_level', label: 'Risk' },
            { key: 'findings_count', label: 'Findings' },
            { key: 'invocation_source', label: 'Source' },
        ];

        const loadHistory = async () => {
            historyArea.textContent = '';

            let data;
            try {
                const resp = await fetch(`/api/skill-scans/history?limit=${PAGE_SIZE}&offset=${currentPage * PAGE_SIZE}`);
                data = await resp.json();
            } catch (e) {
                const err = document.createElement('div');
                err.style.cssText = 'color: var(--text-secondary); font-size: 13px; padding: 16px 0;';
                err.textContent = 'Failed to load scan history.';
                historyArea.appendChild(err);
                return;
            }

            let records = data.records || [];
            const total = data.total || records.length;
            totalBadge.textContent = total + ' scans';

            if (total === 0) {
                const empty = document.createElement('div');
                empty.className = 'empty-state';
                const icon = document.createElement('div');
                icon.className = 'empty-state-icon';
                const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                svg.setAttribute('viewBox', '0 0 24 24');
                svg.setAttribute('fill', 'none');
                svg.setAttribute('stroke', 'currentColor');
                svg.setAttribute('stroke-width', '1.5');
                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                path.setAttribute('d', 'M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z');
                svg.appendChild(path);
                icon.appendChild(svg);
                const msg = document.createElement('div');
                msg.className = 'empty-state-text';
                msg.textContent = 'No scans yet \u2014 scan skills above to get started.';
                empty.appendChild(icon);
                empty.appendChild(msg);
                historyArea.appendChild(empty);
                return;
            }

            // Table
            const RISK_COLOR = { HIGH: '#ef4444', MEDIUM: '#f59e0b', LOW: '#10b981' };
            const riskOrder = { HIGH: 3, MEDIUM: 2, LOW: 1 };
            const self = this;

            const historyDt = new DataTable({
                columns: [
                    { key: 'skill_name', label: 'Skill', sortable: true, render: v => { const s = document.createElement('span'); s.style.fontWeight = '600'; s.textContent = v; return s; } },
                    { key: 'scanned_path', label: 'Path', sortable: true, render: v => {
                        const c = document.createElement('code');
                        c.style.cssText = 'font-size: 11px; color: var(--text-secondary);';
                        const maxLen = 38;
                        c.textContent = v.length > maxLen ? '\u2026' + v.slice(-maxLen) : v;
                        c.title = v;
                        return c;
                    }},
                    { key: 'scan_timestamp', label: 'Scanned', sortable: true, defaultDir: 'desc', render: v => {
                        const s = document.createElement('span');
                        s.style.cssText = 'white-space: nowrap; color: var(--text-secondary); font-size: 12px;';
                        s.textContent = self._relTime(v);
                        s.title = new Date(v).toLocaleString();
                        return s;
                    }},
                    { key: 'risk_level', label: 'Risk', sortable: true, render: v => {
                        const b = document.createElement('span');
                        b.style.cssText = `background: ${RISK_COLOR[v] || '#888'}; color: #fff; border-radius: 3px; padding: 2px 8px; font-size: 11px; font-weight: 700;`;
                        b.textContent = v;
                        return b;
                    }},
                    { key: 'findings_count', label: 'Findings', sortable: true },
                    { key: 'invocation_source', label: 'Source', sortable: true, render: v => {
                        const b = document.createElement('span');
                        const isCli = v === 'cli';
                        b.style.cssText = 'font-size: 10px; font-weight: 600; border-radius: 3px; padding: 1px 6px; ' +
                            (isCli ? 'background: rgba(99,102,241,0.15); color: #818cf8;'
                                   : 'background: rgba(94,173,184,0.1); color: var(--accent-primary);');
                        b.textContent = v.toUpperCase();
                        return b;
                    }},
                ],
                data: records,
                sortKey: sortCol,
                sortDir: sortDir,
                customSort: (data, key, dir) => {
                    return data.sort((a, b) => {
                        let va = a[key], vb = b[key];
                        if (key === 'risk_level') { va = riskOrder[va] || 0; vb = riskOrder[vb] || 0; }
                        else if (key === 'findings_count') { va = Number(va) || 0; vb = Number(vb) || 0; }
                        else if (key === 'scan_timestamp') { va = new Date(va).getTime(); vb = new Date(vb).getTime(); }
                        else { va = String(va || '').toLowerCase(); vb = String(vb || '').toLowerCase(); }
                        if (va < vb) return dir === 'asc' ? -1 : 1;
                        if (va > vb) return dir === 'asc' ? 1 : -1;
                        return 0;
                    });
                },
                onSort: (key, dir) => { sortCol = key; sortDir = dir; loadHistory(); },
                onRowClick: (rec) => self._openDrawer(rec),
                emptyText: 'No scans yet.',
            });
            historyArea.appendChild(historyDt.el);

            // Pagination controls (server-side)
            const totalPages = Math.ceil(total / PAGE_SIZE);
            if (totalPages > 1) {
                const pager = document.createElement('div');
                pager.className = 'sv-table-pager';

                const prevBtn = document.createElement('button');
                prevBtn.className = 'btn btn-sm';
                prevBtn.textContent = '\u2190 Prev';
                prevBtn.disabled = currentPage === 0;
                if (prevBtn.disabled) prevBtn.style.opacity = '0.4';
                prevBtn.addEventListener('click', () => { currentPage--; loadHistory(); });
                pager.appendChild(prevBtn);

                const pageInfo = document.createElement('span');
                pageInfo.className = 'sv-table-page-info';
                pageInfo.textContent = `Page ${currentPage + 1} of ${totalPages}`;
                pager.appendChild(pageInfo);

                const nextBtn = document.createElement('button');
                nextBtn.className = 'btn btn-sm';
                nextBtn.textContent = 'Next \u2192';
                nextBtn.disabled = currentPage >= totalPages - 1;
                if (nextBtn.disabled) nextBtn.style.opacity = '0.4';
                nextBtn.addEventListener('click', () => { currentPage++; loadHistory(); });
                pager.appendChild(nextBtn);

                historyArea.appendChild(pager);
            }
        };

        refreshBtn.addEventListener('click', () => { currentPage = 0; loadHistory(); });
        await loadHistory();
    },

    _buildHistoryRow(rec) {
        const RISK_COLOR = { HIGH: '#ef4444', MEDIUM: '#f59e0b', LOW: '#10b981' };
        const rc = RISK_COLOR[rec.risk_level] || '#888';

        const tr = document.createElement('tr');
        tr.style.cursor = 'pointer';
        tr.title = 'Click to view full scan detail';

        const tdName = document.createElement('td');
        tdName.style.fontWeight = '600';
        tdName.textContent = rec.skill_name;
        tr.appendChild(tdName);

        const tdPath = document.createElement('td');
        const pathCode = document.createElement('code');
        pathCode.style.cssText = 'font-size: 11px; color: var(--text-secondary);';
        const maxLen = 38;
        pathCode.textContent = rec.scanned_path.length > maxLen
            ? '\u2026' + rec.scanned_path.slice(-maxLen) : rec.scanned_path;
        pathCode.title = rec.scanned_path;
        tdPath.appendChild(pathCode);
        tr.appendChild(tdPath);

        const tdTs = document.createElement('td');
        tdTs.style.cssText = 'white-space: nowrap; color: var(--text-secondary); font-size: 12px;';
        tdTs.textContent = this._relTime(rec.scan_timestamp);
        tdTs.title = new Date(rec.scan_timestamp).toLocaleString();
        tr.appendChild(tdTs);

        const tdRisk = document.createElement('td');
        const riskBadge = document.createElement('span');
        riskBadge.style.cssText = `background: ${rc}; color: #fff; border-radius: 3px; padding: 2px 8px; font-size: 11px; font-weight: 700;`;
        riskBadge.textContent = rec.risk_level;
        tdRisk.appendChild(riskBadge);
        tr.appendChild(tdRisk);

        const tdCount = document.createElement('td');
        tdCount.textContent = rec.findings_count;
        tr.appendChild(tdCount);

        const tdSrc = document.createElement('td');
        const srcBadge = document.createElement('span');
        const isCli = rec.invocation_source === 'cli';
        srcBadge.style.cssText = 'font-size: 10px; font-weight: 600; border-radius: 3px; padding: 1px 6px; ' +
            (isCli ? 'background: rgba(99,102,241,0.15); color: #818cf8;'
                   : 'background: rgba(94,173,184,0.1); color: var(--accent-primary);');
        srcBadge.textContent = rec.invocation_source.toUpperCase();
        tdSrc.appendChild(srcBadge);
        tr.appendChild(tdSrc);

        tr.addEventListener('click', () => this._openDrawer(rec));
        return tr;
    },

    // =====================================================================
    // Permissions Tab
    // =====================================================================

    async _renderPermissionsTab(container) {
        const contentArea = document.createElement('div');
        let activeCategory = 'network';

        // Fetch skills dir for platform-aware manifest path
        let skillsDir = '~/.openclaw/skills';
        try {
            const resp = await fetch('/api/skill-scans/discover');
            if (resp.ok) {
                const d = await resp.json();
                skillsDir = (d.skills_dir || skillsDir).replace(/^\/home\/[^/]+/, '~');
            }
        } catch (e) { /* ignore */ }

        // Top toolbar with Add / Export / Import / Reset buttons (always visible)
        const topToolbar = document.createElement('div');
        topToolbar.style.cssText = 'display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-bottom: 10px;';

        // Add Permission button (primary, left-aligned via margin-right auto)
        const addPermBtn = document.createElement('button');
        addPermBtn.className = 'btn btn-primary';
        addPermBtn.style.cssText = 'font-size: 12px; padding: 5px 14px; margin-right: auto;';
        addPermBtn.textContent = '+ Add Permission';
        topToolbar.appendChild(addPermBtn);

        const exportBtn = document.createElement('button');
        exportBtn.className = 'btn';
        exportBtn.style.cssText = 'font-size: 12px; padding: 5px 14px;';
        exportBtn.textContent = 'Export';
        exportBtn.addEventListener('click', async () => {
            try {
                const resp = await fetch('/api/skill-permissions/export');
                const data = await resp.json();
                const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'skill-permissions.json';
                a.click();
                URL.revokeObjectURL(url);
                if (window.Toast) Toast.show('Permissions exported', 'success');
            } catch (e) {
                if (window.Toast) Toast.show('Export failed', 'error');
            }
        });
        topToolbar.appendChild(exportBtn);

        const importBtn = document.createElement('button');
        importBtn.className = 'btn';
        importBtn.style.cssText = 'font-size: 12px; padding: 5px 14px;';
        importBtn.textContent = 'Import';
        importBtn.addEventListener('click', () => this._showImportModal(loadPermissions, activeCategory));
        topToolbar.appendChild(importBtn);

        const resetBtn = document.createElement('button');
        resetBtn.className = 'btn';
        resetBtn.style.cssText = 'font-size: 12px; padding: 5px 14px;';
        resetBtn.textContent = 'Reset to Defaults';
        resetBtn.addEventListener('click', async () => {
            if (!confirm('Reset all permissions to defaults? Custom permissions will be removed.')) return;
            await fetch('/api/skill-permissions/reset', { method: 'POST' });
            if (window.Toast) Toast.show('Permissions reset to defaults', 'success');
            await loadPermissions(activeCategory);
        });
        topToolbar.appendChild(resetBtn);
        container.appendChild(topToolbar);

        // ── How Skill Permissions Work (collapsible, expanded by default) ──
        const banner = document.createElement('div');
        banner.style.cssText = 'background: var(--bg-secondary); border: 1px solid var(--border-default); border-radius: 10px; margin-bottom: 18px; position: relative; overflow: hidden;';

        // Left accent bar
        const accentBar = document.createElement('div');
        accentBar.style.cssText = 'position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: linear-gradient(180deg, #10b981, #f59e0b, #ef4444); border-radius: 10px 0 0 10px;';
        banner.appendChild(accentBar);

        // Clickable header
        const bannerHeader = document.createElement('div');
        bannerHeader.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; cursor: pointer; user-select: none;';
        const bannerTitle = document.createElement('div');
        bannerTitle.style.cssText = 'font-size: 13px; font-weight: 700; color: var(--text-primary);';
        bannerTitle.textContent = 'How Skill Permissions Work';
        bannerHeader.appendChild(bannerTitle);
        const bannerChevron = document.createElement('span');
        bannerChevron.style.cssText = 'font-size: 10px; color: var(--text-secondary); transition: transform 0.2s; display: inline-block;';
        bannerChevron.textContent = '\u25BC';
        bannerHeader.appendChild(bannerChevron);
        banner.appendChild(bannerHeader);

        // Collapsible body (collapsed by default)
        const bannerBody = document.createElement('div');
        bannerBody.style.cssText = 'padding: 0 20px 18px; transition: all 0.2s; display: none;';
        bannerChevron.style.transform = 'rotate(-90deg)';

        bannerHeader.addEventListener('click', () => {
            const collapsed = bannerBody.style.display === 'none';
            bannerBody.style.display = collapsed ? 'block' : 'none';
            bannerChevron.style.transform = collapsed ? '' : 'rotate(-90deg)';
        });

        // Compact summary: scoring + manifest note
        const summaryLine = document.createElement('div');
        summaryLine.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.6; margin-bottom: 8px;';
        summaryLine.textContent = 'Findings are classified as Safe (+0), Review (+2), or Dangerous (+5). Total score determines policy: ALLOW (\u22643), WARN (4\u20136), BLOCK (7+).';
        bannerBody.appendChild(summaryLine);

        const manifestNote = document.createElement('div');
        manifestNote.style.cssText = 'font-size: 11px; color: var(--text-secondary); line-height: 1.5; opacity: 0.7;';
        manifestNote.textContent = 'Skills with a permissions.yml get their declared access auto-allowed. See the Guide for full details and examples.';
        bannerBody.appendChild(manifestNote);

        banner.appendChild(bannerBody);
        container.appendChild(banner);

        // ── Category sub-tabs ────────────────────────────────────────
        const subBar = document.createElement('div');
        subBar.style.cssText = 'display: flex; gap: 0; margin-bottom: 16px; border-bottom: 1px solid var(--border-default);';
        container.appendChild(subBar);

        const categories = [
            { id: 'network', label: 'Network' },
            { id: 'env_var', label: 'Env Vars' },
            { id: 'file_path', label: 'File Paths' },
            { id: 'shell_command', label: 'Shell Commands' },
        ];

        const renderSubTabs = () => {
            subBar.textContent = '';
            categories.forEach(cat => {
                const btn = document.createElement('button');
                btn.style.cssText = `background: transparent; border: none; border-bottom: 2px solid ${activeCategory === cat.id ? 'var(--accent-primary)' : 'transparent'}; color: ${activeCategory === cat.id ? 'var(--accent-primary)' : 'var(--text-secondary)'}; cursor: pointer; font-size: 13px; font-weight: ${activeCategory === cat.id ? '600' : '500'}; padding: 6px 14px; margin-bottom: -1px; transition: all 0.15s;`;
                btn.textContent = cat.label;
                btn.addEventListener('click', async () => {
                    activeCategory = cat.id;
                    renderSubTabs();
                    await loadPermissions(cat.id);
                });
                subBar.appendChild(btn);
            });
        };

        container.appendChild(contentArea);

        const loadPermissions = async (category) => {
            contentArea.textContent = '';

            // Add permission form (hidden by default)
            const addForm = document.createElement('div');
            addForm.style.cssText = 'display: none; background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: 8px; padding: 12px; margin-bottom: 12px;';

            const formRow = document.createElement('div');
            formRow.style.cssText = 'display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap;';

            const patternInput = document.createElement('input');
            patternInput.className = 'form-input';
            patternInput.placeholder = category === 'network' ? '*.example.com' : category === 'env_var' ? 'MY_API_KEY' : category === 'file_path' ? '/path/to/dir/' : 'command';
            patternInput.style.cssText = 'flex: 2; min-width: 140px;';

            const labelInput = document.createElement('input');
            labelInput.className = 'form-input';
            labelInput.placeholder = 'Label (optional)';
            labelInput.style.cssText = 'flex: 1; min-width: 100px;';

            const classSelect = document.createElement('select');
            classSelect.className = 'form-input';
            classSelect.style.cssText = 'flex: 0 0 auto; width: 120px;';
            ['safe', 'review', 'dangerous'].forEach(c => {
                const opt = document.createElement('option');
                opt.value = c;
                opt.textContent = c.charAt(0).toUpperCase() + c.slice(1);
                classSelect.appendChild(opt);
            });

            const saveBtn = document.createElement('button');
            saveBtn.className = 'btn btn-primary';
            saveBtn.style.cssText = 'font-size: 12px; padding: 8px 16px;';
            saveBtn.textContent = 'Save';
            saveBtn.addEventListener('click', async () => {
                const pattern = patternInput.value.trim();
                if (!pattern) { if (window.Toast) Toast.show('Pattern is required', 'error'); return; }
                try {
                    const resp = await fetch('/api/skill-permissions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ category, pattern, classification: classSelect.value, label: labelInput.value.trim() }),
                    });
                    if (!resp.ok) {
                        const err = await resp.json().catch(() => ({}));
                        if (window.Toast) Toast.show(err.detail || 'Failed to add', 'error');
                        return;
                    }
                    if (window.Toast) Toast.show('Permission added', 'success');
                    addForm.style.display = 'none';
                    await loadPermissions(category);
                } catch (e) {
                    if (window.Toast) Toast.show('Error adding permission', 'error');
                }
            });

            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'btn';
            cancelBtn.style.cssText = 'font-size: 12px; padding: 8px 16px;';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.addEventListener('click', () => { addForm.style.display = 'none'; });

            formRow.appendChild(patternInput);
            formRow.appendChild(labelInput);
            formRow.appendChild(classSelect);
            formRow.appendChild(saveBtn);
            formRow.appendChild(cancelBtn);
            addForm.appendChild(formRow);
            contentArea.appendChild(addForm);

            addPermBtn.onclick = () => {
                addForm.style.display = addForm.style.display === 'none' ? 'block' : 'none';
                if (addForm.style.display === 'block') patternInput.focus();
            };

            // Fetch permissions
            let data;
            try {
                const resp = await fetch(`/api/skill-permissions?category=${category}&limit=500`);
                data = await resp.json();
            } catch (e) {
                const err = document.createElement('div');
                err.style.cssText = 'color: var(--text-secondary); font-size: 13px; padding: 16px;';
                err.textContent = 'Failed to load permissions.';
                contentArea.appendChild(err);
                return;
            }

            const perms = data.permissions || [];
            if (perms.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'empty-state';
                const msg = document.createElement('div');
                msg.className = 'empty-state-text';
                msg.textContent = 'No permissions defined for this category.';
                empty.appendChild(msg);
                contentArea.appendChild(empty);
                return;
            }

            // Group by classification
            const groups = { safe: [], review: [], dangerous: [] };
            perms.forEach(p => { if (groups[p.classification]) groups[p.classification].push(p); });

            const CLASS_STYLE = {
                safe:      { color: '#10b981', label: 'SAFE' },
                review:    { color: '#f59e0b', label: 'REVIEW' },
                dangerous: { color: '#ef4444', label: 'DANGEROUS' },
            };

            // 3-column grid layout
            const columnsWrap = document.createElement('div');
            columnsWrap.style.cssText = 'display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; align-items: start; margin-top: 12px;';

            Object.entries(CLASS_STYLE).forEach(([cls, s]) => {
                const items = groups[cls] || [];
                const col = document.createElement('div');
                col.style.cssText = 'display: flex; flex-direction: column; gap: 0; min-width: 0;';

                // Column header
                const header = document.createElement('div');
                header.style.cssText = `display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 2px solid ${s.color}; margin-bottom: 6px;`;
                const dot = document.createElement('span');
                dot.style.cssText = `width: 8px; height: 8px; border-radius: 50%; background: ${s.color}; flex-shrink: 0;`;
                header.appendChild(dot);
                const title = document.createElement('span');
                title.style.cssText = `font-size: 12px; font-weight: 700; color: ${s.color}; text-transform: uppercase; letter-spacing: 0.6px;`;
                title.textContent = s.label;
                header.appendChild(title);
                const countBadge = document.createElement('span');
                countBadge.style.cssText = `font-size: 11px; color: var(--text-secondary); margin-left: auto; background: var(--bg-secondary); padding: 1px 6px; border-radius: 8px;`;
                countBadge.textContent = items.length;
                header.appendChild(countBadge);
                col.appendChild(header);

                // Permission rows
                const list = document.createElement('div');
                list.style.cssText = 'display: flex; flex-direction: column; gap: 1px; max-height: 400px; overflow-y: auto;';

                if (!items.length) {
                    const empty = document.createElement('div');
                    empty.style.cssText = 'font-size: 12px; color: var(--text-secondary); padding: 10px; text-align: center; opacity: 0.6;';
                    empty.textContent = 'None';
                    list.appendChild(empty);
                }

                items.forEach(perm => {
                    const row = document.createElement('div');
                    row.style.cssText = 'display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 4px; font-size: 13px; transition: background 0.1s;';
                    row.addEventListener('mouseenter', () => { row.style.background = 'var(--bg-hover)'; });
                    row.addEventListener('mouseleave', () => { row.style.background = ''; });

                    // Enabled toggle
                    const toggle = document.createElement('input');
                    toggle.type = 'checkbox';
                    toggle.checked = perm.enabled;
                    toggle.style.cssText = 'cursor: pointer; flex-shrink: 0; width: 13px; height: 13px;';
                    toggle.addEventListener('change', async () => {
                        await fetch(`/api/skill-permissions/${perm.id}`, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ enabled: toggle.checked }),
                        });
                    });
                    row.appendChild(toggle);

                    // Pattern
                    const patternEl = document.createElement('code');
                    patternEl.style.cssText = `font-size: 12px; color: var(--text-primary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: ${perm.enabled ? '1' : '0.4'};`;
                    patternEl.textContent = perm.pattern;
                    patternEl.title = `${perm.pattern}${perm.label ? ' — ' + perm.label : ''}`;
                    row.appendChild(patternEl);

                    // Default badge
                    if (perm.is_default) {
                        const defBadge = document.createElement('span');
                        defBadge.style.cssText = 'font-size: 9px; color: var(--text-secondary); opacity: 0.5; flex-shrink: 0;';
                        defBadge.textContent = 'def';
                        row.appendChild(defBadge);
                    }

                    // Delete button (custom only)
                    if (!perm.is_default) {
                        const delBtn = document.createElement('button');
                        delBtn.className = 'btn';
                        delBtn.style.cssText = 'font-size: 10px; padding: 0 5px; color: var(--text-secondary); flex-shrink: 0; line-height: 1;';
                        delBtn.textContent = '\u00D7';
                        delBtn.title = 'Delete';
                        delBtn.addEventListener('click', async (e) => {
                            e.stopPropagation();
                            await fetch(`/api/skill-permissions/${perm.id}`, { method: 'DELETE' });
                            await loadPermissions(category);
                        });
                        row.appendChild(delBtn);
                    }

                    list.appendChild(row);
                });

                col.appendChild(list);
                columnsWrap.appendChild(col);
            });

            contentArea.appendChild(columnsWrap);
        };

        renderSubTabs();
        await loadPermissions('network');

        // Trusted Publishers section
        const pubDivider = document.createElement('div');
        pubDivider.style.cssText = 'border-top: 1px solid var(--border-default); margin: 24px 0 16px;';
        container.appendChild(pubDivider);

        const pubSection = document.createElement('div');
        container.appendChild(pubSection);
        await this._renderPublishers(pubSection);

        // Policy Config section
        const configDivider = document.createElement('div');
        configDivider.style.cssText = 'border-top: 1px solid var(--border-default); margin: 24px 0 16px;';
        container.appendChild(configDivider);

        const configSection = document.createElement('div');
        container.appendChild(configSection);
        await this._renderPolicyConfig(configSection);
    },

    async _renderPublishers(container) {
        container.textContent = '';

        const header = document.createElement('div');
        header.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;';

        const title = document.createElement('div');
        title.style.cssText = 'font-size: 13px; font-weight: 600; color: var(--text-primary);';
        title.textContent = 'Trusted Publishers';
        header.appendChild(title);

        const addBtn = document.createElement('button');
        addBtn.className = 'btn';
        addBtn.style.cssText = 'font-size: 11px; padding: 4px 10px;';
        addBtn.textContent = '+ Add';
        header.appendChild(addBtn);
        container.appendChild(header);

        const desc = document.createElement('div');
        desc.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 12px;';
        desc.textContent = 'Skills from trusted publishers get relaxed policy thresholds.';
        container.appendChild(desc);

        // Add form
        const addForm = document.createElement('div');
        addForm.style.cssText = 'display: none; margin-bottom: 10px;';
        const addRow = document.createElement('div');
        addRow.style.cssText = 'display: flex; gap: 6px;';
        const pubInput = document.createElement('input');
        pubInput.className = 'form-input';
        pubInput.placeholder = 'Publisher name';
        pubInput.style.cssText = 'flex: 1;';
        const pubSaveBtn = document.createElement('button');
        pubSaveBtn.className = 'btn btn-primary';
        pubSaveBtn.style.cssText = 'font-size: 12px;';
        pubSaveBtn.textContent = 'Add';
        pubSaveBtn.addEventListener('click', async () => {
            const name = pubInput.value.trim();
            if (!name) return;
            await fetch('/api/skill-permissions/publishers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ publisher_name: name }),
            });
            addForm.style.display = 'none';
            await this._renderPublishers(container);
        });
        addRow.appendChild(pubInput);
        addRow.appendChild(pubSaveBtn);
        addForm.appendChild(addRow);
        container.appendChild(addForm);

        addBtn.addEventListener('click', () => {
            addForm.style.display = addForm.style.display === 'none' ? 'block' : 'none';
            if (addForm.style.display === 'block') pubInput.focus();
        });

        // List publishers
        let publishers = [];
        try {
            const resp = await fetch('/api/skill-permissions/publishers');
            publishers = await resp.json();
        } catch (e) { /* ignore */ }

        if (!publishers.length) {
            const empty = document.createElement('div');
            empty.style.cssText = 'font-size: 12px; color: var(--text-secondary); padding: 8px 0;';
            empty.textContent = 'No trusted publishers configured.';
            container.appendChild(empty);
            return;
        }

        const list = document.createElement('div');
        list.style.cssText = 'display: flex; flex-wrap: wrap; gap: 6px;';
        publishers.forEach(pub => {
            const chip = document.createElement('span');
            chip.style.cssText = 'display: inline-flex; align-items: center; gap: 4px; background: rgba(16, 185, 129, 0.1); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.25); border-radius: 12px; padding: 3px 10px; font-size: 11px; font-weight: 600;';
            chip.textContent = pub.publisher_name;

            const delX = document.createElement('span');
            delX.style.cssText = 'cursor: pointer; font-size: 13px; opacity: 0.6; margin-left: 2px;';
            delX.textContent = '\u00D7';
            delX.addEventListener('click', async () => {
                await fetch(`/api/skill-permissions/publishers/${pub.id}`, { method: 'DELETE' });
                await this._renderPublishers(container);
            });
            chip.appendChild(delX);
            list.appendChild(chip);
        });
        container.appendChild(list);
    },

    async _renderPolicyConfig(container) {
        container.textContent = '';

        const title = document.createElement('div');
        title.style.cssText = 'font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 6px;';
        title.textContent = 'Policy Configuration';
        container.appendChild(title);

        const desc = document.createElement('div');
        desc.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 12px;';
        desc.textContent = 'Risk weights per finding category and score thresholds for allow/warn/block decisions.';
        container.appendChild(desc);

        let config;
        try {
            const resp = await fetch('/api/skill-permissions/policy-config');
            config = await resp.json();
        } catch (e) {
            container.appendChild(document.createTextNode('Failed to load policy config.'));
            return;
        }

        // Thresholds
        const threshRow = document.createElement('div');
        threshRow.style.cssText = 'display: flex; gap: 16px; margin-bottom: 16px; flex-wrap: wrap;';

        const makeThresh = (label, value, color) => {
            const box = document.createElement('div');
            box.style.cssText = 'display: flex; align-items: center; gap: 6px;';
            const lbl = document.createElement('span');
            lbl.style.cssText = 'font-size: 11px; color: var(--text-secondary);';
            lbl.textContent = label;
            const val = document.createElement('span');
            val.style.cssText = `font-size: 13px; font-weight: 700; color: ${color};`;
            val.textContent = value;
            box.appendChild(lbl);
            box.appendChild(val);
            return box;
        };

        threshRow.appendChild(makeThresh('Allow:', '\u2264 ' + config.threshold_allow, '#10b981'));
        threshRow.appendChild(makeThresh('Warn:', '\u2264 ' + config.threshold_warn, '#f59e0b'));
        threshRow.appendChild(makeThresh('Block:', '> ' + config.threshold_warn, '#ef4444'));
        container.appendChild(threshRow);

        // Risk weights grid
        const grid = document.createElement('div');
        grid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 6px;';

        const WEIGHT_LABELS = {
            network_domain: 'Network', env_var_read: 'Env Var', shell_exec: 'Shell Exec',
            code_exec: 'Code Exec', dynamic_import: 'Dyn Import', file_write: 'File Write',
            base64_literal: 'Base64', compiled_code: 'Compiled', rule_match: 'Rule Match',
            missing_manifest: 'No Manifest', symlink_escape: 'Symlink',
        };

        Object.entries(config.risk_weights).forEach(([key, weight]) => {
            const item = document.createElement('div');
            item.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 4px 8px; border-radius: 4px; background: var(--bg-tertiary); font-size: 11px;';
            const lbl = document.createElement('span');
            lbl.style.cssText = 'color: var(--text-secondary);';
            lbl.textContent = WEIGHT_LABELS[key] || key;
            const val = document.createElement('span');
            val.style.cssText = `font-weight: 700; color: ${weight >= 4 ? '#ef4444' : weight >= 2 ? '#f59e0b' : 'var(--text-secondary)'};`;
            val.textContent = weight;
            item.appendChild(lbl);
            item.appendChild(val);
            grid.appendChild(item);
        });
        container.appendChild(grid);
    },

    // =====================================================================
    // Side drawer (scan detail + policy decision)
    // =====================================================================

    _showImportModal(loadPermissions, activeCategory) {
        // Backdrop
        const backdrop = document.createElement('div');
        backdrop.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 9998; display: flex; align-items: center; justify-content: center; animation: fadeIn 0.15s ease;';
        const closeModal = () => backdrop.remove();
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });

        // Modal
        const modal = document.createElement('div');
        modal.style.cssText = 'background: var(--bg-primary); border: 1px solid var(--border-default); border-radius: 12px; width: 520px; max-width: 90vw; max-height: 85vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.3); animation: slideUp 0.2s ease;';

        // Add keyframe animations
        const styleEl = document.createElement('style');
        styleEl.textContent = '@keyframes fadeIn{from{opacity:0}to{opacity:1}}@keyframes slideUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}';
        modal.appendChild(styleEl);

        // Header
        const header = document.createElement('div');
        header.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid var(--border-default);';
        const title = document.createElement('div');
        title.style.cssText = 'font-size: 14px; font-weight: 700; color: var(--text-primary);';
        title.textContent = 'Import Permissions';
        header.appendChild(title);
        const closeBtn = document.createElement('button');
        closeBtn.style.cssText = 'background: none; border: none; font-size: 18px; color: var(--text-secondary); cursor: pointer; padding: 0 4px; line-height: 1;';
        closeBtn.textContent = '\u00D7';
        closeBtn.addEventListener('click', closeModal);
        header.appendChild(closeBtn);
        modal.appendChild(header);

        // Body
        const body = document.createElement('div');
        body.style.cssText = 'padding: 20px;';

        // Format section
        const fmtTitle = document.createElement('div');
        fmtTitle.style.cssText = 'font-size: 12px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px;';
        fmtTitle.textContent = 'Expected JSON format';
        body.appendChild(fmtTitle);

        const codeBlock = document.createElement('pre');
        codeBlock.style.cssText = 'background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: 8px; padding: 12px 14px; font-size: 11px; color: var(--text-primary); line-height: 1.6; margin: 0 0 14px; overflow-x: auto; white-space: pre;';
        codeBlock.textContent = '{\n  "permissions": [\n    {\n      "category": "network",\n      "pattern": "*.openai.com",\n      "classification": "safe",\n      "label": "OpenAI API"\n    },\n    {\n      "category": "env_var",\n      "pattern": "AWS_*",\n      "classification": "review",\n      "label": "AWS credentials"\n    }\n  ]\n}';
        body.appendChild(codeBlock);

        // Field reference
        const refWrap = document.createElement('div');
        refWrap.style.cssText = 'display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; font-size: 11px; margin-bottom: 18px; padding: 10px 12px; background: var(--bg-secondary); border-radius: 6px; border: 1px solid var(--border-default);';
        const fields = [
            ['category', 'network, env_var, file_path, shell_command'],
            ['pattern', 'Glob pattern to match (e.g. *.example.com)'],
            ['classification', 'safe, review, or dangerous'],
            ['label', 'Optional description'],
        ];
        fields.forEach(([field, desc]) => {
            const k = document.createElement('code');
            k.style.cssText = 'font-weight: 600; color: var(--accent-primary); font-size: 11px;';
            k.textContent = field;
            refWrap.appendChild(k);
            const v = document.createElement('span');
            v.style.cssText = 'color: var(--text-secondary);';
            v.textContent = desc;
            refWrap.appendChild(v);
        });
        body.appendChild(refWrap);

        // Upload area
        const dropZone = document.createElement('div');
        dropZone.style.cssText = 'border: 2px dashed var(--border-default); border-radius: 8px; padding: 28px 20px; text-align: center; cursor: pointer; transition: all 0.15s; margin-bottom: 6px;';

        const dropIcon = document.createElement('div');
        dropIcon.style.cssText = 'font-size: 28px; margin-bottom: 8px; opacity: 0.4;';
        dropIcon.textContent = '\uD83D\uDCC4';
        dropZone.appendChild(dropIcon);

        const dropText = document.createElement('div');
        dropText.style.cssText = 'font-size: 13px; color: var(--text-primary); font-weight: 500; margin-bottom: 4px;';
        dropText.textContent = 'Drop JSON file here or click to browse';
        dropZone.appendChild(dropText);

        const dropHint = document.createElement('div');
        dropHint.style.cssText = 'font-size: 11px; color: var(--text-secondary);';
        dropHint.textContent = '.json files only \u2022 max 1000 permissions per import';
        dropZone.appendChild(dropHint);

        // Status message area
        const statusArea = document.createElement('div');
        statusArea.style.cssText = 'display: none; margin-top: 10px; padding: 10px 14px; border-radius: 6px; font-size: 12px;';

        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json';
        fileInput.style.display = 'none';

        // Drag and drop handlers
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = 'var(--accent-primary)';
            dropZone.style.background = 'rgba(94,173,184,0.04)';
        });
        dropZone.addEventListener('dragleave', () => {
            dropZone.style.borderColor = 'var(--border-default)';
            dropZone.style.background = '';
        });
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = 'var(--border-default)';
            dropZone.style.background = '';
            const file = e.dataTransfer.files[0];
            if (file) processFile(file);
        });
        dropZone.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', () => {
            if (fileInput.files[0]) processFile(fileInput.files[0]);
            fileInput.value = '';
        });

        const showStatus = (msg, type) => {
            statusArea.style.display = 'block';
            statusArea.style.background = type === 'error' ? 'rgba(239,68,68,0.08)' : 'rgba(16,185,129,0.08)';
            statusArea.style.color = type === 'error' ? '#ef4444' : '#10b981';
            statusArea.style.border = `1px solid ${type === 'error' ? 'rgba(239,68,68,0.2)' : 'rgba(16,185,129,0.2)'}`;
            statusArea.textContent = msg;
        };

        const processFile = async (file) => {
            if (!file.name.endsWith('.json')) {
                showStatus('Only .json files are accepted', 'error');
                return;
            }
            try {
                const text = await file.text();
                const parsed = JSON.parse(text);
                if (!parsed.permissions || !Array.isArray(parsed.permissions)) {
                    showStatus('Invalid format: expected { "permissions": [...] }', 'error');
                    return;
                }
                const validCategories = ['network', 'env_var', 'file_path', 'shell_command'];
                const validClassifications = ['safe', 'review', 'dangerous'];
                for (const p of parsed.permissions) {
                    if (!p.category || !validCategories.includes(p.category)) {
                        showStatus(`Invalid category: "${p.category}". Must be: ${validCategories.join(', ')}`, 'error');
                        return;
                    }
                    if (!p.pattern || typeof p.pattern !== 'string') {
                        showStatus('Each permission must have a non-empty "pattern" string', 'error');
                        return;
                    }
                    if (!p.classification || !validClassifications.includes(p.classification)) {
                        showStatus(`Invalid classification: "${p.classification}". Must be: ${validClassifications.join(', ')}`, 'error');
                        return;
                    }
                }

                // Preview count
                dropText.textContent = `${file.name} \u2014 ${parsed.permissions.length} permissions`;
                dropIcon.textContent = '\u2705';

                const resp = await fetch('/api/skill-permissions/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(parsed),
                });
                const result = await resp.json();
                if (!resp.ok) {
                    showStatus(result.detail || 'Import failed', 'error');
                    return;
                }
                showStatus(`Imported ${result.imported} permissions, skipped ${result.skipped} duplicates`, 'success');
                if (window.Toast) Toast.show(`Imported ${result.imported} permissions`, 'success');
                await loadPermissions(activeCategory);
                setTimeout(closeModal, 1500);
            } catch (e) {
                showStatus('Invalid JSON file \u2014 could not parse', 'error');
            }
        };

        body.appendChild(dropZone);
        body.appendChild(fileInput);
        body.appendChild(statusArea);
        modal.appendChild(body);
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);
    },

    async _openDrawer(rec, policy, aiReview) {
        let data;
        try {
            const resp = await fetch(`/api/skill-scans/history/${rec.id}`);
            if (!resp.ok) return;
            data = await resp.json();
        } catch (e) { return; }

        const RISK_COLOR = { HIGH: '#ef4444', MEDIUM: '#f59e0b', LOW: '#10b981' };
        const RECS = {
            HIGH:   'DO NOT INSTALL',
            MEDIUM: 'REVIEW CAREFULLY \u2014 inspect all findings before installing',
            LOW:    'SAFE TO INSTALL',
        };
        const rc = RISK_COLOR[data.risk_level] || '#888';

        const wrap = document.createElement('div');
        wrap.style.cssText = 'display: flex; flex-direction: column; gap: 12px;';

        const section = (label, node) => {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';
            const lbl = document.createElement('div');
            lbl.style.cssText = 'font-size: 11px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.6px;';
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

        // Risk banner with animated score ring
        const banner = document.createElement('div');
        banner.style.cssText = `display: flex; align-items: center; gap: 14px; padding: 14px 16px; border-radius: 10px; background: ${rc}10; border: 1px solid ${rc}33; position: relative; overflow: hidden;`;

        // Animated background shimmer
        const shimmer = document.createElement('div');
        shimmer.style.cssText = `position: absolute; top: 0; left: -100%; width: 50%; height: 100%; background: linear-gradient(90deg, transparent, ${rc}08, transparent); animation: drawerShimmer 3s ease-in-out infinite;`;
        banner.appendChild(shimmer);

        // SVG risk ring
        const ringSize = 52;
        const ringStroke = 4;
        const ringRadius = (ringSize - ringStroke) / 2;
        const ringCirc = 2 * Math.PI * ringRadius;
        const riskPct = data.risk_level === 'HIGH' ? 0.9 : data.risk_level === 'MEDIUM' ? 0.55 : 0.2;
        const ringOffset = ringCirc * (1 - riskPct);

        const ringSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        ringSvg.setAttribute('viewBox', `0 0 ${ringSize} ${ringSize}`);
        ringSvg.style.cssText = `width: ${ringSize}px; height: ${ringSize}px; flex-shrink: 0; transform: rotate(-90deg);`;

        const ringBg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        ringBg.setAttribute('cx', ringSize / 2); ringBg.setAttribute('cy', ringSize / 2);
        ringBg.setAttribute('r', ringRadius);
        ringBg.setAttribute('fill', 'none'); ringBg.setAttribute('stroke', `${rc}22`);
        ringBg.setAttribute('stroke-width', ringStroke);
        ringSvg.appendChild(ringBg);

        const ringFg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        ringFg.setAttribute('cx', ringSize / 2); ringFg.setAttribute('cy', ringSize / 2);
        ringFg.setAttribute('r', ringRadius);
        ringFg.setAttribute('fill', 'none'); ringFg.setAttribute('stroke', rc);
        ringFg.setAttribute('stroke-width', ringStroke); ringFg.setAttribute('stroke-linecap', 'round');
        ringFg.setAttribute('stroke-dasharray', ringCirc);
        ringFg.setAttribute('stroke-dashoffset', ringCirc);
        ringSvg.appendChild(ringFg);

        // Animate the ring fill
        requestAnimationFrame(() => {
            ringFg.style.transition = 'stroke-dashoffset 1s ease-out';
            ringFg.setAttribute('stroke-dashoffset', ringOffset);
        });

        // Risk label centered on ring
        const ringWrap = document.createElement('div');
        ringWrap.style.cssText = 'position: relative; flex-shrink: 0;';
        ringWrap.appendChild(ringSvg);
        const ringText = document.createElement('div');
        ringText.style.cssText = `position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 11px; font-weight: 800; color: ${rc}; letter-spacing: 0.5px;`;
        ringText.textContent = data.risk_level;
        ringWrap.appendChild(ringText);
        banner.appendChild(ringWrap);

        // Right side — recommendation + score
        const bannerRight = document.createElement('div');
        bannerRight.style.cssText = 'flex: 1; min-width: 0;';
        const recBadge = document.createElement('div');
        recBadge.style.cssText = `font-size: 13px; font-weight: 700; color: ${rc}; margin-bottom: 2px;`;
        recBadge.textContent = RECS[data.risk_level];
        bannerRight.appendChild(recBadge);
        if (policy) {
            const scoreHint = document.createElement('div');
            scoreHint.style.cssText = 'font-size: 11px; color: var(--text-secondary);';
            scoreHint.textContent = `Risk score: ${policy.risk_score ?? 0} / threshold: ${policy.threshold_warn ?? '?'}`;
            bannerRight.appendChild(scoreHint);
        }
        banner.appendChild(bannerRight);
        wrap.appendChild(banner);

        // Resolution Options — blue box at top for MEDIUM/HIGH
        if ((data.risk_level === 'MEDIUM' || data.risk_level === 'HIGH') && data.findings && data.findings.length > 0) {
            const CATEGORY_TO_PERM = {
                network_domain: 'network', env_var_read: 'env_var',
                file_write: 'file_path', shell_exec: 'shell_command',
            };

            const resBox = document.createElement('div');
            resBox.style.cssText = 'padding: 14px 16px; border-radius: 8px; border: 1px solid rgba(59, 130, 246, 0.35); background: rgba(59, 130, 246, 0.08);';

            const resHeader = document.createElement('div');
            resHeader.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 10px;';
            const resIcon = document.createElement('span');
            resIcon.style.cssText = 'font-size: 14px; color: #3b82f6;';
            resIcon.textContent = '\u26A1';
            resHeader.appendChild(resIcon);
            const resTitle = document.createElement('span');
            resTitle.style.cssText = 'font-size: 12px; font-weight: 700; color: #3b82f6; text-transform: uppercase; letter-spacing: 0.5px;';
            resTitle.textContent = 'Resolution Options';
            resHeader.appendChild(resTitle);
            resBox.appendChild(resHeader);

            const resOptions = document.createElement('div');
            resOptions.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';

            // Trust publisher (from URL)
            const publisherMatch = (data.scanned_path || '').match(/github\.com\/([^/]+)/);
            if (publisherMatch) {
                const pubName = publisherMatch[1];
                resOptions.appendChild(this._buildResolutionOption(
                    '\u2713', '#10b981',
                    `Trust publisher "${pubName}"`,
                    'Auto-allow all future scans from this publisher',
                    async (btn) => {
                        btn.disabled = true; btn.textContent = 'Adding\u2026';
                        try {
                            const resp = await fetch('/api/skill-permissions/publishers', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ publisher_name: pubName, trust_level: 'trusted' }),
                            });
                            if (resp.ok) {
                                btn.textContent = 'Trusted \u2713'; btn.style.background = '#10b981'; btn.style.color = '#fff';
                                if (window.Toast) Toast.show(`Publisher "${pubName}" trusted`, 'success');
                            } else if (resp.status === 409) {
                                btn.textContent = 'Already trusted'; btn.style.opacity = '0.5';
                            } else { btn.textContent = 'Failed'; btn.disabled = false; }
                        } catch { btn.textContent = 'Error'; btn.disabled = false; }
                    }
                ));
            }

            // Mark finding categories as safe (deduplicated)
            // Extract classifiable pattern from excerpt (mirrors policy_engine._extract_pattern)
            const extractPattern = (category, excerpt) => {
                if (!excerpt) return null;
                let m;
                if (category === 'network_domain') {
                    m = excerpt.match(/https?:\/\/([^\s/'"]+)/);
                    if (m) return m[1];
                    m = excerpt.match(/[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,60}[a-zA-Z0-9])?\.[a-zA-Z]{2,10}/);
                    if (m) return m[0];
                } else if (category === 'env_var_read') {
                    m = excerpt.match(/(?:environ\[|getenv\(|env\.)["']?(\w+)/);
                    if (m) return m[1];
                } else if (category === 'file_write') {
                    m = excerpt.match(/open\(\s*["']([^"']+)["']/);
                    if (m) return m[1];
                } else if (category === 'shell_exec') {
                    m = excerpt.match(/(?:run|call|Popen|system)\(\s*(?:\[?\s*["'])?([^"')\]]{1,200})/);
                    if (m) return m[1].trim();
                }
                return null;
            };

            const seenCats = new Set();
            const classifiable = data.findings.filter(f => CATEGORY_TO_PERM[f.category]);
            classifiable.forEach(f => {
                const permCat = CATEGORY_TO_PERM[f.category];
                if (seenCats.has(permCat)) return;
                seenCats.add(permCat);

                const catFindings = classifiable.filter(x => x.category === f.category);
                const catCount = catFindings.length;
                const catLabel = f.category.replace(/_/g, ' ');

                // Collect unique extracted patterns for this category
                const patterns = new Set();
                catFindings.forEach(cf => {
                    const p = extractPattern(cf.category, cf.excerpt);
                    if (p) patterns.add(p);
                });

                resOptions.appendChild(this._buildResolutionOption(
                    '\u2691', '#f59e0b',
                    `Mark "${catLabel}" as safe (${catCount})`,
                    `Add permission rules classifying these patterns as safe`,
                    async (btn) => {
                        btn.disabled = true; btn.textContent = 'Adding\u2026';
                        let added = 0;
                        let skipped = 0;
                        for (const pattern of patterns) {
                            try {
                                const resp = await fetch('/api/skill-permissions', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ category: permCat, pattern, classification: 'safe', label: `Auto: ${f.category} from ${data.skill_name}` }),
                                });
                                if (resp.ok) added++;
                                else if (resp.status === 409) skipped++;
                            } catch { /* skip */ }
                        }
                        btn.textContent = `${added} added \u2713`; btn.style.background = '#10b981'; btn.style.color = '#fff';
                        if (added > 0 && window.Toast) Toast.show(`${added} permission${added !== 1 ? 's' : ''} added`, 'success');
                        else if (skipped > 0 && added === 0 && window.Toast) Toast.show('Patterns already exist as permissions', 'info');
                    }
                ));
            });

            // Configure in Skill Policy
            resOptions.appendChild(this._buildResolutionOption(
                '\u2699', '#94a3b8',
                'Configure in Skill Policy',
                'Adjust thresholds, weights, and per-pattern rules',
                () => { SideDrawer.close(); if (window.Sidebar) Sidebar.navigate('skill-permissions'); }
            ));

            // Re-scan with AI review
            if (!data.ai_reviewed) {
                resOptions.appendChild(this._buildResolutionOption(
                    '\u2726', '#3b82f6',
                    'Re-scan with AI review',
                    'Use AI to filter false positives and refine risk',
                    async (btn) => {
                        btn.disabled = true; btn.textContent = 'Scanning\u2026';
                        try {
                            const resp = await fetch('/api/skill-scans/scan', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ paths: [data.scanned_path], ai_review: true }),
                            });
                            if (resp.ok) {
                                btn.textContent = 'Done \u2713'; btn.style.background = '#3b82f6'; btn.style.color = '#fff';
                                if (window.Toast) Toast.show('AI review complete — refresh for updated results', 'success');
                            } else { btn.textContent = 'Failed'; btn.disabled = false; }
                        } catch { btn.textContent = 'Error'; btn.disabled = false; }
                    }
                ));
            }

            resBox.appendChild(resOptions);
            wrap.appendChild(resBox);
        }

        // Policy decision (if available)
        if (policy) {
            const ACTION_STYLE = {
                allow: { bg: 'rgba(16, 185, 129, 0.08)', border: 'rgba(16, 185, 129, 0.3)', color: '#10b981', label: 'ALLOW' },
                warn:  { bg: 'rgba(245, 158, 11, 0.08)', border: 'rgba(245, 158, 11, 0.3)', color: '#f59e0b', label: 'WARN' },
                block: { bg: 'rgba(239, 68, 68, 0.08)', border: 'rgba(239, 68, 68, 0.3)', color: '#ef4444', label: 'BLOCK' },
            };
            const ps = ACTION_STYLE[policy.action] || ACTION_STYLE.warn;

            const policyCard = document.createElement('div');
            policyCard.style.cssText = `padding: 12px 16px; border-radius: 8px; background: ${ps.bg}; border: 1px solid ${ps.border};`;

            const policyHeader = document.createElement('div');
            policyHeader.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;';

            const policyTitle = document.createElement('div');
            policyTitle.style.cssText = 'display: flex; align-items: center; gap: 6px;';
            const policyLabel = document.createElement('span');
            policyLabel.style.cssText = 'font-size: 11px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.6px;';
            policyLabel.textContent = 'Policy Decision';
            policyTitle.appendChild(policyLabel);
            if (policy.trusted_publisher) {
                const trustBadge = document.createElement('span');
                trustBadge.style.cssText = 'font-size: 9px; background: rgba(16, 185, 129, 0.15); color: #10b981; padding: 1px 5px; border-radius: 3px; font-weight: 600;';
                trustBadge.textContent = 'TRUSTED';
                policyTitle.appendChild(trustBadge);
            }
            policyHeader.appendChild(policyTitle);

            const actionLabel = document.createElement('span');
            actionLabel.style.cssText = `font-size: 16px; font-weight: 800; color: ${ps.color};`;
            actionLabel.textContent = ps.label;
            policyHeader.appendChild(actionLabel);

            policyCard.appendChild(policyHeader);

            // Score breakdown
            const scoreRow = document.createElement('div');
            scoreRow.style.cssText = 'display: flex; gap: 12px; flex-wrap: wrap; font-size: 11px;';

            const makeCount = (label, count, color) => {
                const el = document.createElement('span');
                el.style.cssText = `color: ${color}; font-weight: 600;`;
                el.textContent = `${count} ${label}`;
                return el;
            };

            const scoreLabel = document.createElement('span');
            scoreLabel.style.cssText = 'color: var(--text-secondary);';
            scoreLabel.textContent = `Score: ${policy.risk_score ?? 0}`;
            scoreRow.appendChild(scoreLabel);
            if (policy.safe_count) scoreRow.appendChild(makeCount('safe', policy.safe_count, '#10b981'));
            if (policy.review_count) scoreRow.appendChild(makeCount('review', policy.review_count, '#f59e0b'));
            if (policy.dangerous_count) scoreRow.appendChild(makeCount('dangerous', policy.dangerous_count, '#ef4444'));
            if (policy.unknown_count) scoreRow.appendChild(makeCount('unclassified', policy.unknown_count, '#94a3b8'));

            policyCard.appendChild(scoreRow);

            // Explanation: why this decision + what's missing
            const explainWrap = document.createElement('div');
            explainWrap.style.cssText = 'margin-top: 10px; padding-top: 8px; border-top: 1px solid ' + ps.border + ';';

            // Why blocked/warned/allowed
            const whyEl = document.createElement('div');
            whyEl.style.cssText = 'font-size: 11px; color: var(--text-primary); line-height: 1.6; margin-bottom: 6px;';
            const whyBold = document.createElement('strong');
            whyBold.style.color = ps.color;
            if (policy.action === 'block') {
                whyBold.textContent = 'Why blocked: ';
                whyEl.appendChild(whyBold);
                whyEl.appendChild(document.createTextNode(`Risk score ${policy.risk_score ?? 0} exceeds the warn/block threshold of ${policy.threshold_warn ?? '?'}.`));
            } else if (policy.action === 'warn') {
                whyBold.textContent = 'Why warning: ';
                whyEl.appendChild(whyBold);
                whyEl.appendChild(document.createTextNode(`Risk score ${policy.risk_score ?? 0} exceeds the allow threshold of ${policy.threshold_allow ?? '?'}.`));
            } else {
                whyBold.textContent = 'Allowed: ';
                whyEl.appendChild(whyBold);
                whyEl.appendChild(document.createTextNode(`Risk score ${policy.risk_score} is within the allow threshold of ${policy.threshold_allow}.`));
            }
            explainWrap.appendChild(whyEl);

            // What's missing checklist
            const issues = [];
            if (policy.unknown_count > 0) {
                issues.push({ icon: '\u2717', color: '#ef4444', text: `${policy.unknown_count} finding${policy.unknown_count !== 1 ? 's have' : ' has'} no matching permission rules (unclassified). Each adds to the risk score.` });
            }
            if (!policy.trusted_publisher) {
                issues.push({ icon: '\u2717', color: '#ef4444', text: 'Publisher is not trusted \u2014 no auto-allow shortcut applied.' });
            }
            if (data.manifest_present === false) {
                issues.push({ icon: '\u2717', color: '#ef4444', text: 'Permissions manifest (permissions.yml) is absent \u2014 skill cannot declare its own required permissions.' });
            }
            if (policy.safe_count > 0) {
                issues.push({ icon: '\u2713', color: '#10b981', text: `${policy.safe_count} finding${policy.safe_count !== 1 ? 's' : ''} matched "safe" permission rules and did not add to the score.` });
            }

            if (issues.length > 0) {
                const issuesList = document.createElement('div');
                issuesList.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';
                issues.forEach(iss => {
                    const issRow = document.createElement('div');
                    issRow.style.cssText = 'display: flex; align-items: flex-start; gap: 6px; font-size: 11px; line-height: 1.5;';
                    const issIcon = document.createElement('span');
                    issIcon.style.cssText = `color: ${iss.color}; flex-shrink: 0; font-weight: 700; margin-top: 1px;`;
                    issIcon.textContent = iss.icon;
                    issRow.appendChild(issIcon);
                    const issText = document.createElement('span');
                    issText.style.cssText = 'color: var(--text-secondary);';
                    issText.textContent = iss.text;
                    issRow.appendChild(issText);
                    issuesList.appendChild(issRow);
                });
                explainWrap.appendChild(issuesList);
            }

            // How to fix hint
            if (policy.action !== 'allow') {
                const fixHint = document.createElement('div');
                fixHint.style.cssText = 'margin-top: 8px; font-size: 11px; color: var(--text-secondary); line-height: 1.5; padding: 6px 8px; background: var(--bg-tertiary); border-radius: 4px;';
                const fixLabel = document.createElement('strong');
                fixLabel.style.cssText = 'color: var(--text-primary);';
                fixLabel.textContent = 'To resolve: ';
                fixHint.appendChild(fixLabel);
                const fixes = [];
                if (policy.unknown_count > 0) fixes.push('add permission rules for unclassified patterns (use Resolution Options above)');
                if (!policy.trusted_publisher) fixes.push('trust the publisher to auto-allow');
                fixes.push('raise the policy thresholds in Skill Policy');
                fixHint.appendChild(document.createTextNode(fixes.join(', or ') + '.'));
                explainWrap.appendChild(fixHint);
            }

            policyCard.appendChild(explainWrap);
            wrap.appendChild(policyCard);
        }

        // AI Analysis card (if reviewed)
        if (aiReview && aiReview.reviewed) {
            const aiCard = document.createElement('div');
            aiCard.style.cssText = 'padding: 12px 16px; border-radius: 8px; background: rgba(94, 173, 184, 0.06); border: 1px solid rgba(94, 173, 184, 0.2);';

            const aiHeader = document.createElement('div');
            aiHeader.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;';
            const aiTitle = document.createElement('div');
            aiTitle.style.cssText = 'font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: var(--accent-primary);';
            aiTitle.textContent = 'AI Analysis';
            aiHeader.appendChild(aiTitle);

            const aiRiskColor = RISK_COLOR[aiReview.ai_risk_level] || '#10b981';
            const aiRiskBadge = document.createElement('span');
            aiRiskBadge.style.cssText = `background: ${aiRiskColor}; color: #fff; border-radius: 4px; padding: 2px 10px; font-size: 12px; font-weight: 800;`;
            aiRiskBadge.textContent = aiReview.ai_risk_level || 'LOW';
            aiHeader.appendChild(aiRiskBadge);
            aiCard.appendChild(aiHeader);

            // Assessment text
            if (aiReview.ai_assessment) {
                const assessEl = document.createElement('div');
                assessEl.style.cssText = 'font-size: 12px; color: var(--text-primary); line-height: 1.5; margin-bottom: 8px;';
                assessEl.textContent = aiReview.ai_assessment;
                aiCard.appendChild(assessEl);
            }

            // Stats row
            const aiStats = document.createElement('div');
            aiStats.style.cssText = 'display: flex; gap: 16px; font-size: 11px; color: var(--text-secondary);';

            const fpStat = document.createElement('span');
            fpStat.style.cssText = aiReview.false_positives > 0 ? 'color: #10b981; font-weight: 600;' : '';
            fpStat.textContent = `${aiReview.false_positives} false positive${aiReview.false_positives !== 1 ? 's' : ''} filtered`;
            aiStats.appendChild(fpStat);

            const modelStat = document.createElement('span');
            modelStat.textContent = aiReview.model_used || '';
            aiStats.appendChild(modelStat);

            const tokenStat = document.createElement('span');
            tokenStat.textContent = aiReview.tokens_used ? `${aiReview.tokens_used} tokens` : '';
            aiStats.appendChild(tokenStat);

            aiCard.appendChild(aiStats);
            wrap.appendChild(aiCard);
        }

        const metaGrid = document.createElement('div');
        metaGrid.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px; padding: 10px 12px; background: var(--bg-tertiary); border-radius: 6px; font-size: 12px;';
        const metaItem = (label, value) => {
            const el = document.createElement('div');
            el.style.cssText = 'display: flex; gap: 6px; align-items: baseline;';
            const lbl = document.createElement('span');
            lbl.style.cssText = 'color: var(--text-muted); font-size: 10px; text-transform: uppercase; font-weight: 600; letter-spacing: 0.4px; min-width: 55px;';
            lbl.textContent = label;
            el.appendChild(lbl);
            const val = document.createElement('span');
            val.style.cssText = 'color: var(--text-primary); font-weight: 500;';
            val.textContent = value;
            el.appendChild(val);
            return el;
        };
        metaGrid.appendChild(metaItem('Skill', data.skill_name));
        metaGrid.appendChild(metaItem('Scanned', new Date(data.scan_timestamp).toLocaleString()));
        metaGrid.appendChild(metaItem('Findings', `${data.findings_count ?? data.findings?.length ?? 0}`));
        metaGrid.appendChild(metaItem('Manifest', data.manifest_present === true ? 'Present \u2713' : 'Absent'));
        const pathItem = metaItem('Path', '');
        const pathCode = document.createElement('code');
        pathCode.style.cssText = 'font-size: 10px; color: var(--text-secondary); word-break: break-all;';
        pathCode.textContent = data.scanned_path;
        pathCode.title = data.scanned_path;
        pathItem.querySelector('span:last-child').textContent = '';
        pathItem.querySelector('span:last-child').appendChild(pathCode);
        pathItem.style.cssText += 'grid-column: 1 / -1;';
        metaGrid.appendChild(pathItem);
        wrap.appendChild(metaGrid);

        if (data.findings && data.findings.length > 0) {
            const findingsWrap = document.createElement('div');

            // Collapsible findings header
            const findingsToggle = document.createElement('div');
            findingsToggle.style.cssText = 'display: flex; align-items: center; justify-content: space-between; cursor: pointer; padding: 6px 0; user-select: none;';
            const findingsLabel = document.createElement('div');
            findingsLabel.style.cssText = 'font-size: 11px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.6px;';
            findingsLabel.textContent = `Findings (${data.findings.length})`;
            findingsToggle.appendChild(findingsLabel);
            const findingsArrow = document.createElement('span');
            findingsArrow.style.cssText = 'font-size: 10px; color: var(--text-muted); transition: transform 0.2s;';
            findingsArrow.textContent = '\u25BC';
            findingsToggle.appendChild(findingsArrow);
            findingsWrap.appendChild(findingsToggle);

            const findingsBody = document.createElement('div');
            findingsBody.style.cssText = 'display: block;';
            let findingsOpen = true;
            findingsToggle.addEventListener('click', () => {
                findingsOpen = !findingsOpen;
                findingsBody.style.display = findingsOpen ? 'block' : 'none';
                findingsArrow.textContent = findingsOpen ? '\u25BC' : '\u25B6';
            });

            const CATEGORY_ICON = {
                network_domain: '\uD83C\uDF10', env_var_read: '\uD83D\uDD11', shell_exec: '\u26A0',
                code_exec: '\u26A1', dynamic_import: '\uD83D\uDD17', file_write: '\uD83D\uDCC1',
                base64_literal: '\uD83D\uDD12', compiled_code: '\u2699', symlink_escape: '\u21AA',
                missing_manifest: '\uD83D\uDCCB',
            };

            data.findings.forEach(f => {
                const isFP = f.ai_verdict === 'false_positive';
                const item = document.createElement('div');
                item.style.cssText = `border-bottom: 1px solid var(--border-default, #333); padding: 5px 0;${isFP ? ' opacity: 0.5;' : ''}`;
                const sevColor = { critical: '#ef4444', high: '#ef4444', medium: '#f59e0b', low: '#6b7280', info: '#3b82f6' }[f.severity] || '#6b7280';
                const loc = f.line_number ? `${f.file_path}:${f.line_number}` : (f.file_path || '');

                const topRow = document.createElement('div');
                topRow.style.cssText = 'display: flex; align-items: center; gap: 6px; flex-wrap: wrap;';

                // AI verdict badge
                if (f.ai_verdict) {
                    const aiTag = document.createElement('span');
                    if (isFP) {
                        aiTag.style.cssText = 'background: #6b728822; color: #6b7280; border-radius: 3px; padding: 1px 5px; font-size: 9px; font-weight: 700; text-decoration: line-through;';
                        aiTag.textContent = 'FALSE POSITIVE';
                    } else {
                        aiTag.style.cssText = 'background: #ef444422; color: #ef4444; border-radius: 3px; padding: 1px 5px; font-size: 9px; font-weight: 700;';
                        aiTag.textContent = 'CONFIRMED';
                    }
                    aiTag.title = f.ai_explanation || '';
                    topRow.appendChild(aiTag);
                }

                const sevBadge = document.createElement('span');
                sevBadge.style.cssText = `background: ${sevColor}; color: #fff; border-radius: 3px; padding: 1px 5px; font-size: 10px; font-weight: 700;${isFP ? ' text-decoration: line-through;' : ''}`;
                sevBadge.textContent = (f.severity || 'unknown').toUpperCase();
                topRow.appendChild(sevBadge);

                // Category icon + label
                const catIcon = CATEGORY_ICON[f.category];
                if (catIcon) {
                    const ico = document.createElement('span');
                    ico.style.cssText = 'font-size: 12px; flex-shrink: 0;';
                    ico.textContent = catIcon;
                    ico.title = f.category;
                    topRow.appendChild(ico);
                }
                const cat = document.createElement('strong');
                cat.style.cssText = `font-size: 12px; color: var(--text-primary);${isFP ? ' text-decoration: line-through;' : ''}`;
                cat.textContent = f.category.replace(/_/g, ' ');
                topRow.appendChild(cat);

                // Rule ID — clickable, navigates to Skill Policy
                if (f.rule_id) {
                    const ruleTag = document.createElement('span');
                    ruleTag.style.cssText = 'font-size: 10px; color: var(--accent-primary); background: var(--bg-tertiary); border-radius: 3px; padding: 1px 5px; font-family: monospace; cursor: pointer;';
                    ruleTag.textContent = f.rule_id;
                    ruleTag.title = 'Click to manage this rule in Skill Policy';
                    ruleTag.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (window.SideDrawer) SideDrawer.close();
                        if (window.Sidebar) Sidebar.navigate('skill-permissions');
                    });
                    topRow.appendChild(ruleTag);
                }

                if (loc) {
                    const locEl = document.createElement('span');
                    locEl.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-left: auto;';
                    locEl.textContent = loc;
                    topRow.appendChild(locEl);
                }
                item.appendChild(topRow);

                // AI explanation
                if (f.ai_explanation) {
                    const aiReason = document.createElement('div');
                    aiReason.style.cssText = 'font-size: 10px; color: var(--text-secondary); margin-top: 2px; font-style: italic;';
                    aiReason.textContent = `AI: ${f.ai_explanation}`;
                    item.appendChild(aiReason);
                }

                if (f.excerpt) {
                    const exc = document.createElement('code');
                    exc.style.cssText = 'display: block; font-size: 11px; color: var(--text-secondary); margin-top: 3px; white-space: pre-wrap; word-break: break-all;';
                    exc.textContent = f.excerpt;
                    item.appendChild(exc);
                }

                // Fix guidance for missing_manifest
                if (f.category === 'missing_manifest') {
                    const hint = document.createElement('div');
                    hint.style.cssText = 'font-size: 10px; color: var(--text-secondary); margin-top: 4px; line-height: 1.4;';
                    const hintText = document.createTextNode('Fix: Add a permissions.yml manifest to the skill, or ');
                    hint.appendChild(hintText);
                    const policyLink = document.createElement('span');
                    policyLink.style.cssText = 'color: var(--accent-primary); cursor: pointer; text-decoration: underline;';
                    policyLink.textContent = 'disable this check in Skill Policy';
                    policyLink.addEventListener('click', (e) => { e.stopPropagation(); if (window.SideDrawer) SideDrawer.close(); if (window.Sidebar) Sidebar.navigate('skill-permissions'); });
                    hint.appendChild(policyLink);
                    hint.appendChild(document.createTextNode(', or add the publisher as a '));
                    const trustLink = document.createElement('span');
                    trustLink.style.cssText = 'color: var(--accent-primary); cursor: pointer; text-decoration: underline;';
                    trustLink.textContent = 'trusted publisher';
                    trustLink.addEventListener('click', (e) => { e.stopPropagation(); if (window.SideDrawer) SideDrawer.close(); if (window.Sidebar) Sidebar.navigate('skill-permissions'); });
                    hint.appendChild(trustLink);
                    hint.appendChild(document.createTextNode('.'));
                    item.appendChild(hint);
                }
                findingsBody.appendChild(item);
            });
            findingsWrap.appendChild(findingsBody);
            wrap.appendChild(findingsWrap);
        } else {
            wrap.appendChild(section('Findings', 'No suspicious patterns detected.'));
        }

        // Actions footer
        const actionsFooter = document.createElement('div');
        actionsFooter.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-top: 8px;';

        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-danger';
        delBtn.style.cssText = 'font-size: 12px; padding: 5px 14px;';
        delBtn.textContent = 'Delete Record';
        delBtn.addEventListener('click', () => {
            const doDelete = async () => {
                await fetch(`/api/skill-scans/history/${data.id}`, { method: 'DELETE' });
                SideDrawer.close();
                if (this.activeTab === 'history') {
                    await this._renderActiveTab();
                }
            };
            if (window.Modal) {
                Modal.confirm({
                    title: 'Delete Scan Record',
                    message: 'This scan record will be permanently deleted. This cannot be undone.',
                    confirmLabel: 'Delete',
                    cancelLabel: 'Keep',
                    onConfirm: doDelete,
                });
            } else {
                if (!confirm('Delete this scan record? This cannot be undone.')) return;
                doDelete();
            }
        });
        actionsFooter.appendChild(delBtn);
        wrap.appendChild(actionsFooter);

        // Disclaimer
        const drawerDisclaimer = document.createElement('div');
        drawerDisclaimer.style.cssText = 'margin-top: 16px; text-align: center;';
        const dDisclaimerText = document.createElement('span');
        dDisclaimerText.style.cssText = 'font-size: 10px; color: var(--text-secondary); opacity: 0.5;';
        dDisclaimerText.textContent = 'SecureVector scans can make mistakes. Review findings before deciding.';
        drawerDisclaimer.appendChild(dDisclaimerText);
        wrap.appendChild(drawerDisclaimer);

        SideDrawer.show({ title: 'Scan Detail \u2014 ' + data.skill_name, content: wrap });
    },

    // =====================================================================
    // Scan execution (multi-path)
    // =====================================================================

    async _runScan(paths, btn, statusSpan, container) {
        if (this._scanInProgress) return;
        if (!paths.length) {
            if (window.Toast) Toast.show('No paths to scan', 'error');
            return;
        }

        this._scanInProgress = true;
        btn.disabled = true;
        const origLabel = btn.textContent;
        const label = paths.length === 1 ? 'Scanning\u2026' : `Scanning ${paths.length} skills\u2026`;
        btn.textContent = label;
        statusSpan.textContent = label;
        statusSpan.style.display = 'inline';

        try {
            const resp = await fetch('/api/skill-scans/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paths }),
            });

            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                const msg = typeof err.detail === 'string' ? err.detail
                    : Array.isArray(err.detail) ? err.detail.map(d => d.msg || d).join('; ')
                    : `Scan failed (HTTP ${resp.status})`;
                if (window.Toast) Toast.show(msg, 'error');
                return;
            }

            const data = await resp.json();
            this._lastScanResults = data.results;

            // Show errors via toast
            data.results.filter(r => !r.success).forEach(r => {
                const msg = r.error ? `${r.path}: ${r.error}` : `Scan failed for ${r.path}`;
                if (window.Toast) Toast.show(msg, 'error');
            });

            // Show warnings via toast
            data.results.filter(r => r.warning).forEach(r => {
                if (window.Toast) Toast.show(r.warning, 'warning');
            });

            // Render inline results
            const resultsArea = document.getElementById('ss-scan-results');
            if (resultsArea) {
                this._renderScanResults(resultsArea, data.results);
            }

            // Open drawer for first successful result
            const successes = data.results.filter(r => r.success && r.result);
            if (successes.length === 1) {
                await this._openDrawer(successes[0].result, successes[0].policy, successes[0].ai_review);
            } else if (successes.length > 1) {
                if (window.Toast) Toast.show(`${successes.length} scans complete`, 'success');
            }

        } catch (e) {
            if (window.Toast) Toast.show(`Network error: ${e.message}`, 'error');
        } finally {
            this._scanInProgress = false;
            btn.disabled = false;
            btn.textContent = origLabel;
            statusSpan.style.display = 'none';
        }
    },

    // =====================================================================
    // Helpers
    // =====================================================================

    _buildResolutionOption(icon, iconColor, title, subtitle, onClick) {
        const opt = document.createElement('div');
        opt.style.cssText = 'display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 6px; cursor: pointer; transition: background 0.15s;';
        opt.addEventListener('mouseenter', () => { opt.style.background = 'rgba(94, 173, 184, 0.08)'; });
        opt.addEventListener('mouseleave', () => { opt.style.background = 'transparent'; });

        const iconEl = document.createElement('span');
        iconEl.style.cssText = `font-size: 16px; color: ${iconColor}; flex-shrink: 0; width: 24px; text-align: center;`;
        iconEl.textContent = icon;
        opt.appendChild(iconEl);

        const textWrap = document.createElement('div');
        textWrap.style.cssText = 'flex: 1; min-width: 0;';
        const titleEl = document.createElement('div');
        titleEl.style.cssText = 'font-size: 12px; font-weight: 600; color: var(--text-primary);';
        titleEl.textContent = title;
        textWrap.appendChild(titleEl);
        if (subtitle) {
            const subEl = document.createElement('div');
            subEl.style.cssText = 'font-size: 10px; color: var(--text-secondary); margin-top: 1px;';
            subEl.textContent = subtitle;
            textWrap.appendChild(subEl);
        }
        opt.appendChild(textWrap);

        const actionBtn = document.createElement('button');
        actionBtn.className = 'btn';
        actionBtn.style.cssText = 'font-size: 10px; padding: 3px 10px; flex-shrink: 0;';
        actionBtn.textContent = 'Apply';
        const doAction = () => {
            if (window.Modal) {
                Modal.confirm({
                    title: 'Apply Resolution',
                    message: title + (subtitle ? '\n\n' + subtitle : ''),
                    confirmLabel: 'Apply',
                    cancelLabel: 'Cancel',
                    onConfirm: () => onClick(actionBtn),
                });
            } else {
                if (!confirm(`Apply: ${title}?`)) return;
                onClick(actionBtn);
            }
        };
        actionBtn.addEventListener('click', (e) => { e.stopPropagation(); doAction(); });
        opt.appendChild(actionBtn);

        opt.addEventListener('click', doAction);
        return opt;
    },

    _relTime(isoStr) {
        const ms = Date.now() - new Date(isoStr).getTime();
        const s = Math.floor(ms / 1000);
        if (s < 60) return 'just now';
        const m = Math.floor(s / 60);
        if (m < 60) return `${m}m ago`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h}h ago`;
        const d = Math.floor(h / 24);
        return d < 7 ? `${d}d ago` : new Date(isoStr).toLocaleDateString();
    },

    destroy() {
        this._lastScanResults = null;
    },
};

window.SkillScannerPage = SkillScannerPage;
