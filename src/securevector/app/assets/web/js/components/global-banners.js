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
    // Fresh key — the v4.2 revamp generalises the nudge (OpenClaw + Claude
    // Code) so prior single-plugin dismissals shouldn't suppress it.
    KEY_PLUGINS_NUDGE: 'sv-plugins-nudge-dismissed',
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

        // Fetch both plugin states in parallel so the nudge knows whether
        // either runtime is missing its plugin. Each fetch fails-open to
        // null so a transient API issue never breaks the dashboard.
        const [hooksStatus, ccStatus] = await Promise.all([
            fetch('/api/hooks/status').then(r => r.ok ? r.json() : null).catch(() => null),
            fetch('/api/hooks/claude-code/status').then(r => r.ok ? r.json() : null).catch(() => null),
        ]);

        const dismissed = localStorage.getItem(this.KEY_PLUGINS_NUDGE) === '1';
        const ocActionable = !!(hooksStatus && hooksStatus.openclaw_detected && !hooksStatus.installed);
        const ccActionable = !!(ccStatus && ccStatus.claude_code_detected && !ccStatus.enabled);
        const pluginNudgeRelevant = ocActionable || ccActionable;
        const whatsNewAcked = localStorage.getItem(this.KEY_WHATS_NEW) === this.WHATS_NEW_VERSION;

        if (pluginNudgeRelevant && !dismissed) {
            // At least one runtime has a plugin available + not yet installed.
            // The banner exposes both CTAs unconditionally; the one that isn't
            // actionable is shown in a "done" state instead of being hidden,
            // so the user sees the full plugin lineup either way.
            slot.appendChild(this._buildPluginsNudge({ ocActionable, ccActionable }));
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

    _buildPluginsNudge({ ocActionable, ccActionable }) {
        const banner = document.createElement('div');
        banner.className = 'sv-global-banner';
        banner.style.cssText = 'position: relative; display: flex; align-items: center; gap: 16px; padding: 14px 44px 14px 16px; background: var(--bg-card); border: 1px solid var(--border-default); border-left: 3px solid var(--accent-primary); border-radius: 8px; margin-bottom: 10px; flex-wrap: wrap;';

        // Plug icon — conveys "native integration" not just "speed"
        const icon = document.createElement('div');
        icon.style.cssText = 'flex-shrink: 0; width: 36px; height: 36px; background: rgba(94,173,184,0.14); border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--accent-primary);';
        icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 2v6"/><path d="M15 2v6"/><path d="M7 8h10a2 2 0 0 1 2 2v3a5 5 0 0 1-5 5h-4a5 5 0 0 1-5-5v-3a2 2 0 0 1 2-2z"/><path d="M12 18v4"/></svg>';
        banner.appendChild(icon);

        const textCol = document.createElement('div');
        textCol.style.cssText = 'flex: 1 1 280px; min-width: 220px;';

        const titleRow = document.createElement('div');
        titleRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 3px; flex-wrap: wrap;';
        const title = document.createElement('div');
        title.style.cssText = 'font-size: 13px; font-weight: 700; color: var(--text-primary); line-height: 1.3;';
        title.textContent = 'Run SecureVector natively with a plugin';
        titleRow.appendChild(title);
        const pill = document.createElement('span');
        pill.style.cssText = 'font-size: 9.5px; font-weight: 700; letter-spacing: 0.5px; color: var(--accent-primary); background: rgba(94,173,184,0.12); border: 1px solid rgba(94,173,184,0.3); padding: 2px 6px; border-radius: 4px; text-transform: uppercase;';
        pill.textContent = 'Recommended';
        titleRow.appendChild(pill);
        textCol.appendChild(titleRow);

        const desc = document.createElement('div');
        desc.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.45;';
        desc.textContent = 'Native hooks. Tamper-evident audit. No proxy or env vars required. Available for OpenClaw and Claude Code.';
        textCol.appendChild(desc);

        banner.appendChild(textCol);

        // Two install entry points side by side. Each renders in
        // "actionable" or "installed" state per the per-runtime status
        // fetched in render(); we still expose both so users see the
        // full plugin lineup at a glance.
        const ctaGroup = document.createElement('div');
        ctaGroup.style.cssText = 'display: flex; align-items: center; gap: 8px; flex-shrink: 0; flex-wrap: wrap;';

        ctaGroup.appendChild(this._buildPluginCta({
            label: 'OpenClaw',
            actionable: ocActionable,
            isNew: false,
            // Primary visual weight goes to whichever plugin isn't yet
            // installed; if Claude Code is also actionable, the launch
            // (NEW) plugin takes the filled treatment instead.
            primary: ocActionable && !ccActionable,
            onInstall: () => {
                if (window.Sidebar) { Sidebar.expandSection('integrations'); Sidebar.navigate('proxy-openclaw'); }
            },
        }));

        ctaGroup.appendChild(this._buildPluginCta({
            label: 'Claude Code',
            actionable: ccActionable,
            isNew: true,
            // Claude Code is the v4.2 launch — when actionable it takes
            // the primary (filled) treatment so the NEW plugin reads as
            // the lede.
            primary: ccActionable,
            onInstall: () => {
                if (window.Sidebar) { Sidebar.expandSection('guide'); Sidebar.navigate('guide-claude-code'); }
            },
        }));

        banner.appendChild(ctaGroup);

        const dismissBtn = document.createElement('button');
        dismissBtn.style.cssText = 'position: absolute; top: 6px; right: 6px; background: transparent; border: none; color: var(--text-muted); font-size: 16px; cursor: pointer; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; line-height: 1; border-radius: 6px; transition: color 0.15s, background 0.15s;';
        dismissBtn.title = 'Dismiss';
        dismissBtn.setAttribute('aria-label', 'Dismiss');
        dismissBtn.textContent = '\u00D7';
        dismissBtn.addEventListener('mouseenter', () => { dismissBtn.style.color = 'var(--text-primary)'; dismissBtn.style.background = 'var(--bg-secondary)'; });
        dismissBtn.addEventListener('mouseleave', () => { dismissBtn.style.color = 'var(--text-muted)'; dismissBtn.style.background = 'transparent'; });
        dismissBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            localStorage.setItem(this.KEY_PLUGINS_NUDGE, '1');
            banner.remove();
            this._collapseSlotIfEmpty();
        });
        banner.appendChild(dismissBtn);

        return banner;
    },

    _buildPluginCta({ label, actionable, isNew, primary, onInstall }) {
        const btn = document.createElement('button');
        const filled = primary && actionable;
        const actionableColor = filled ? '#fff' : 'var(--accent-primary)';
        const actionableBg = filled ? 'var(--accent-primary)' : 'transparent';
        const actionableBorder = filled ? 'none' : '1px solid rgba(94,173,184,0.45)';
        // Installed-state styling — the button reads as a soft confirmation
        // pill so the user still sees the lineup without it pretending
        // there's anything left to do for it.
        const installedColor = 'var(--text-muted)';
        const installedBg = 'transparent';
        const installedBorder = '1px solid var(--border-default)';
        btn.style.cssText = 'font-size: 12px; font-weight: 600;'
            + ' color: ' + (actionable ? actionableColor : installedColor) + ';'
            + ' background: ' + (actionable ? actionableBg : installedBg) + ';'
            + ' border: ' + (actionable ? actionableBorder : installedBorder) + ';'
            + ' padding: 7px 12px; border-radius: 6px;'
            + ' cursor: ' + (actionable ? 'pointer' : 'default') + ';'
            + ' white-space: nowrap; transition: opacity 0.15s, transform 0.05s, background 0.15s;'
            + ' display: inline-flex; align-items: center; gap: 6px; line-height: 1;';
        btn.disabled = !actionable;

        if (actionable) {
            const verb = document.createElement('span');
            verb.textContent = 'Install for';
            verb.style.cssText = 'opacity: 0.85; font-weight: 500;';
            btn.appendChild(verb);
        } else {
            // Checkmark glyph — same stroke style as the rest of the app.
            const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            check.setAttribute('viewBox', '0 0 24 24');
            check.setAttribute('fill', 'none');
            check.setAttribute('stroke', 'currentColor');
            check.setAttribute('stroke-width', '2.5');
            check.setAttribute('stroke-linecap', 'round');
            check.setAttribute('stroke-linejoin', 'round');
            check.style.cssText = 'width: 12px; height: 12px; flex-shrink: 0;';
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'M5 12l4 4L19 7');
            check.appendChild(path);
            btn.appendChild(check);
        }

        const labelEl = document.createElement('span');
        labelEl.textContent = label;
        btn.appendChild(labelEl);

        if (isNew) {
            const newPill = document.createElement('span');
            // Warm peach NEW pill — distinct from the cyan SV brand so the
            // launch reads as a separate signal at a glance.
            newPill.style.cssText = 'font-size: 8.5px; font-weight: 800; letter-spacing: 0.6px; padding: 2px 5px; border-radius: 3px; line-height: 1;'
                + ' background: ' + (filled ? 'rgba(255,255,255,0.22)' : 'rgba(217,119,6,0.18)') + ';'
                + ' color: ' + (filled ? '#fff' : '#d97706') + ';'
                + ' border: 1px solid ' + (filled ? 'rgba(255,255,255,0.35)' : 'rgba(217,119,6,0.4)') + ';';
            newPill.textContent = 'NEW';
            btn.appendChild(newPill);
        }

        if (actionable) {
            btn.addEventListener('mouseenter', () => { btn.style.opacity = '0.9'; });
            btn.addEventListener('mouseleave', () => { btn.style.opacity = '1'; });
            btn.addEventListener('mousedown', () => { btn.style.transform = 'scale(0.98)'; });
            btn.addEventListener('mouseup', () => { btn.style.transform = 'scale(1)'; });
            btn.addEventListener('click', (e) => { e.stopPropagation(); onInstall(); });
        } else {
            btn.title = 'Already installed';
        }

        return btn;
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
