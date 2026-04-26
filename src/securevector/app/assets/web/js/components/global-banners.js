/**
 * Global Banners — app-level notices that live above page content
 * and persist across navigation. Each banner is dismissible once,
 * with dismissal stored in localStorage so it never reappears.
 *
 * Slot: inserted into <main class="main-content"> between <header>
 * and #page-content. Renders once at app init.
 */

const GlobalBanners = {
    WHATS_NEW_VERSION: '4.1.0',
    KEY_OPENCLAW: 'sv-openclaw-banner-dismissed',
    KEY_WHATS_NEW: 'sv-whats-new-acked',

    async render() {
        // Inject keyframes once
        if (!document.getElementById('sv-global-banner-keyframes')) {
            const style = document.createElement('style');
            style.id = 'sv-global-banner-keyframes';
            style.textContent = `
                @media (prefers-reduced-motion: no-preference) {
                    @keyframes sv-banner-in {
                        0%   { opacity: 0; transform: translateY(-8px); }
                        100% { opacity: 1; transform: translateY(0); }
                    }
                    @keyframes sv-banner-flash {
                        0%, 100% { box-shadow: 0 0 0 0 rgba(94,173,184,0); }
                        30%      { box-shadow: 0 0 0 4px rgba(94,173,184,0.25); }
                        60%      { box-shadow: 0 0 0 0 rgba(94,173,184,0); }
                    }
                    .sv-global-banner {
                        animation: sv-banner-in 0.35s ease-out, sv-banner-flash 1.2s ease-out 0.3s 3;
                    }
                }
            `;
            document.head.appendChild(style);
        }

        // Find or create the slot
        let slot = document.getElementById('sv-global-banners');
        if (!slot) {
            slot = document.createElement('div');
            slot.id = 'sv-global-banners';
            slot.style.cssText = 'padding: 12px 20px 0;';
            const main = document.querySelector('main.main-content');
            const pageContent = document.getElementById('page-content');
            if (main && pageContent) main.insertBefore(slot, pageContent);
            else document.body.insertBefore(slot, document.body.firstChild);
        }
        slot.textContent = '';

        // Fetch state once — decide which banner (if any) to show.
        // Only ONE runs at a time so users don't see two overlapping
        // "OpenClaw plugin" headlines.
        let hooksStatus = null;
        try {
            hooksStatus = await fetch('/api/hooks/status').then(r => r.ok ? r.json() : null).catch(() => null);
        } catch (e) { /* non-critical */ }

        const ocDismissed = localStorage.getItem(this.KEY_OPENCLAW) === '1';
        const ocRelevant = hooksStatus && hooksStatus.openclaw_detected && !hooksStatus.installed;
        const whatsNewAcked = localStorage.getItem(this.KEY_WHATS_NEW) === this.WHATS_NEW_VERSION;

        if (ocRelevant && !ocDismissed) {
            // Actionable: OpenClaw user who hasn't installed the plugin yet.
            // The nudge IS the v3.4.0 release callout for them.
            slot.appendChild(this._buildOpenClawBanner());
        } else if (!whatsNewAcked) {
            // Everyone else: show the What's New card for this release.
            slot.appendChild(this._buildWhatsNew());
        }

        // Hide slot if empty (avoids extra padding)
        if (!slot.hasChildNodes()) {
            slot.style.display = 'none';
        } else {
            slot.style.display = 'block';
        }
    },

    _buildOpenClawBanner() {
        const banner = document.createElement('div');
        banner.className = 'sv-global-banner';
        banner.style.cssText = 'position: relative; display: flex; align-items: center; gap: 16px; padding: 14px 44px 14px 16px; background: var(--bg-card); border: 1px solid var(--border-default); border-left: 3px solid var(--accent-primary); border-radius: 8px; margin-bottom: 10px;';

        // Plug icon — conveys "native integration" not just "speed"
        const icon = document.createElement('div');
        icon.style.cssText = 'flex-shrink: 0; width: 36px; height: 36px; background: rgba(94,173,184,0.14); border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--accent-primary);';
        icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 2v6"/><path d="M15 2v6"/><path d="M7 8h10a2 2 0 0 1 2 2v3a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5v-3a2 2 0 0 1 2-2z"/><path d="M12 18v4"/></svg>';
        banner.appendChild(icon);

        const textCol = document.createElement('div');
        textCol.style.cssText = 'flex: 1; min-width: 0;';

        const titleRow = document.createElement('div');
        titleRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 3px; flex-wrap: wrap;';
        const title = document.createElement('div');
        title.style.cssText = 'font-size: 13px; font-weight: 700; color: var(--text-primary); line-height: 1.3;';
        title.textContent = 'Run SecureVector natively inside OpenClaw';
        titleRow.appendChild(title);
        const pill = document.createElement('span');
        pill.style.cssText = 'font-size: 9.5px; font-weight: 700; letter-spacing: 0.5px; color: var(--accent-primary); background: rgba(94,173,184,0.12); border: 1px solid rgba(94,173,184,0.3); padding: 2px 6px; border-radius: 4px; text-transform: uppercase;';
        pill.textContent = 'Recommended';
        titleRow.appendChild(pill);
        textCol.appendChild(titleRow);

        const desc = document.createElement('div');
        desc.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.45;';
        desc.textContent = 'Zero latency. Full audit trail. No proxy or env vars required.';
        textCol.appendChild(desc);

        banner.appendChild(textCol);

        const cta = document.createElement('button');
        cta.style.cssText = 'flex-shrink: 0; font-size: 12px; font-weight: 600; color: #fff; background: var(--accent-primary); border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; white-space: nowrap; transition: opacity 0.15s, transform 0.05s;';
        cta.textContent = 'Install plugin';
        cta.addEventListener('mouseenter', () => { cta.style.opacity = '0.9'; });
        cta.addEventListener('mouseleave', () => { cta.style.opacity = '1'; });
        cta.addEventListener('mousedown', () => { cta.style.transform = 'scale(0.98)'; });
        cta.addEventListener('mouseup', () => { cta.style.transform = 'scale(1)'; });
        cta.addEventListener('click', () => {
            if (window.Sidebar) { Sidebar.expandSection('integrations'); Sidebar.navigate('proxy-openclaw'); }
        });
        banner.appendChild(cta);

        const dismissBtn = document.createElement('button');
        dismissBtn.style.cssText = 'position: absolute; top: 6px; right: 6px; background: transparent; border: none; color: var(--text-muted); font-size: 16px; cursor: pointer; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; line-height: 1; border-radius: 6px; transition: color 0.15s, background 0.15s;';
        dismissBtn.title = 'Dismiss';
        dismissBtn.setAttribute('aria-label', 'Dismiss');
        dismissBtn.textContent = '\u00D7';
        dismissBtn.addEventListener('mouseenter', () => { dismissBtn.style.color = 'var(--text-primary)'; dismissBtn.style.background = 'var(--bg-secondary)'; });
        dismissBtn.addEventListener('mouseleave', () => { dismissBtn.style.color = 'var(--text-muted)'; dismissBtn.style.background = 'transparent'; });
        dismissBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            localStorage.setItem(this.KEY_OPENCLAW, '1');
            banner.remove();
            this._collapseSlotIfEmpty();
        });
        banner.appendChild(dismissBtn);

        return banner;
    },

    _buildWhatsNew() {
        const card = document.createElement('div');
        card.className = 'sv-global-banner';
        card.style.cssText = 'position: relative; display: flex; align-items: center; gap: 14px; padding: 10px 44px 10px 16px; background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 8px; margin-bottom: 10px;';

        // Version tag is informational only — neutral color so it doesn't
        // compete with interactive accent elements (CTAs, links).
        const tag = document.createElement('span');
        tag.style.cssText = 'flex-shrink: 0; font-size: 10px; font-weight: 700; letter-spacing: 0.6px; color: var(--text-muted); background: var(--bg-tertiary); border: 1px solid var(--border-default); padding: 3px 8px; border-radius: 4px; text-transform: uppercase;';
        tag.textContent = `v${this.WHATS_NEW_VERSION}`;
        card.appendChild(tag);

        const textCol = document.createElement('div');
        textCol.style.cssText = 'flex: 1; min-width: 0; font-size: 13px; color: var(--text-primary); line-height: 1.45;';
        const strong = document.createElement('strong');
        strong.textContent = 'What\u2019s new:';
        strong.style.marginRight = '6px';
        textCol.appendChild(strong);
        // v4.1.0 headline = Agent Replay (per-agent timeline of scans + tool
        // calls + LLM cost). Keep SIEM Forwarder visible as the previous-
        // release callout so users returning after v4.0 still catch up on
        // both. One banner, two releases — cheaper than a carousel.
        textCol.appendChild(document.createTextNode('Agent Replay \u2014 per-agent timeline of scans, tool calls, and LLM cost. Plus indirect-prompt-injection (IDPI) detection and signed wheel attestations. \u00B7 Previously in v4.0: SIEM Forwarder.'));
        card.appendChild(textCol);

        const cta = document.createElement('button');
        cta.style.cssText = 'flex-shrink: 0; font-size: 12px; font-weight: 600; color: var(--accent-primary); background: transparent; border: 1px solid rgba(94,173,184,0.4); padding: 6px 12px; border-radius: 6px; cursor: pointer; white-space: nowrap; transition: background 0.15s;';
        cta.textContent = 'Open SIEM Forwarder \u2192';
        cta.addEventListener('mouseenter', () => { cta.style.background = 'rgba(94,173,184,0.08)'; });
        cta.addEventListener('mouseleave', () => { cta.style.background = 'transparent'; });
        cta.addEventListener('click', () => {
            if (window.Sidebar) {
                // SIEM Forwarder lives under the `integrations` section
                // (labelled "Connect" in the sidebar). Expand first so
                // the nav item is visible when we select it.
                Sidebar.expandSection('integrations');
                Sidebar.navigate('siem-export');
            }
        });
        card.appendChild(cta);

        const closeBtn = document.createElement('button');
        closeBtn.style.cssText = 'position: absolute; top: 6px; right: 6px; background: transparent; border: none; color: var(--text-muted); font-size: 16px; cursor: pointer; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; line-height: 1; border-radius: 6px; transition: color 0.15s, background 0.15s;';
        closeBtn.title = 'Dismiss';
        closeBtn.setAttribute('aria-label', 'Dismiss');
        closeBtn.textContent = '\u00D7';
        closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = 'var(--text-primary)'; closeBtn.style.background = 'var(--bg-secondary)'; });
        closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = 'var(--text-muted)'; closeBtn.style.background = 'transparent'; });
        closeBtn.addEventListener('click', () => {
            localStorage.setItem(this.KEY_WHATS_NEW, this.WHATS_NEW_VERSION);
            card.remove();
            this._collapseSlotIfEmpty();
        });
        card.appendChild(closeBtn);

        return card;
    },

    _collapseSlotIfEmpty() {
        const slot = document.getElementById('sv-global-banners');
        if (slot && !slot.hasChildNodes()) slot.style.display = 'none';
    },
};

window.GlobalBanners = GlobalBanners;
