/**
 * Proxy Page
 * Proxy settings for Block Mode and Output Scan
 */

const ProxyPage = {
    settings: null,

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
            this.renderContent(container);
        } catch (error) {
            this.settings = { block_threats: false, scan_llm_responses: true };
            this.renderContent(container);
        }
    },

    renderContent(container) {
        container.textContent = '';

        // Page intro
        const intro = document.createElement('div');
        intro.className = 'page-intro';
        intro.style.cssText = 'margin-bottom: 24px; color: var(--text-secondary); font-size: 14px;';
        intro.textContent = 'Configure proxy behavior for threat detection and blocking.';
        container.appendChild(intro);

        // Block Mode Section
        const blockSection = this.createSection('Block Mode', 'When enabled, detected threats are blocked and not forwarded to the LLM');
        const blockCard = this.createCard();
        const blockBody = blockCard.querySelector('.card-body');
        this.renderBlockMode(blockBody);
        blockSection.appendChild(blockCard);
        container.appendChild(blockSection);

        // Output Scan Section
        const outputSection = this.createSection('Output Scan', 'Scan LLM responses for data leakage, credentials, and PII exposure');
        const outputCard = this.createCard();
        const outputBody = outputCard.querySelector('.card-body');
        this.renderOutputScan(outputBody);
        outputSection.appendChild(outputCard);
        container.appendChild(outputSection);

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
                ? 'Enable Block Mode?\n\nDetected threats will be BLOCKED and not forwarded to the LLM.'
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
        note.textContent = 'When enabled, messages flagged as threats will be blocked and not sent to the AI.';
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

    createSection(title, subtitle) {
        const section = document.createElement('div');
        section.className = 'settings-section';
        section.style.cssText = 'margin-bottom: 32px;';

        const header = document.createElement('div');
        header.style.cssText = 'margin-bottom: 16px;';

        const titleEl = document.createElement('h2');
        titleEl.style.cssText = 'font-size: 18px; font-weight: 600; margin-bottom: 4px;';
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
