/**
 * Global Banners — app-level notices that live above page content
 * and persist across navigation. Each banner is dismissible once,
 * with dismissal stored in localStorage so it never reappears.
 *
 * Slot: inserted into <main class="main-content"> between <header>
 * and #page-content. Renders once at app init.
 */

const GlobalBanners = {
    WHATS_NEW_VERSION: '4.6.0',
    KEY_WHATS_NEW: 'sv-whats-new-acked',
    // Guardian ML ships ENABLED by default (local-only, reversible) — the
    // one-time notice is what turns "enabled without asking" into "enabled
    // with informed consent": say what it is, where data goes (nowhere),
    // and offer the off switch right there. Acked once, never again.
    KEY_GUARDIAN_NOTICE: 'sv-guardian-notice-acked',
    // One-time post-enrollment banner (#114) pointing the user at the new
    // Cloud Activity page. Acked permanently once dismissed / clicked.
    KEY_ENROLLED: 'sv-enrolled-banner-acked',

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

        // Fetch settings + enrollment state in parallel. Each fetch fails-open
        // to null so a transient API issue never breaks the dashboard (the
        // dependent banner just doesn't render that pass).
        const [appSettings, enrollStatus] = await Promise.all([
            fetch('/api/settings').then(r => r.ok ? r.json() : null).catch(() => null),
            fetch('/api/v1/policy-sync/status').then(r => r.ok ? r.json() : null).catch(() => null),
        ]);

        const whatsNewAcked = localStorage.getItem(this.KEY_WHATS_NEW) === this.WHATS_NEW_VERSION;
        const guardianAcked = localStorage.getItem(this.KEY_GUARDIAN_NOTICE) === '1';
        // Only while Guardian is genuinely running: available (model loaded)
        // AND enabled. If the user already found Settings and turned it off,
        // there's nothing to disclose — never nag about a disabled feature.
        const guardianNoticeRelevant = !!(appSettings
            && appSettings.guardian_ml_available && appSettings.guardian_ml_enabled);

        // Post-enrollment first-run banner (#114) — one-time. Shown once
        // after the device becomes enrolled; points at the new Cloud Activity
        // page so the user immediately knows what's now flowing in and out.
        const enrolledBannerAcked = localStorage.getItem(this.KEY_ENROLLED) === '1';
        const isEnrolled = !!(enrollStatus && enrollStatus.enrolled);

        if (guardianNoticeRelevant && !guardianAcked) {
            // Consent outranks everything: a feature that's actively scanning
            // by default gets disclosed BEFORE enrollment pointers and release
            // marketing. One banner at a time — the next banner takes the slot
            // once the user has made their keep-on / turn-off choice.
            slot.appendChild(this._buildGuardianNotice());
        } else if (isEnrolled && !enrolledBannerAcked) {
            // Enrollment trust pointer beats marketing: it explains what is
            // now flowing off this device.
            slot.appendChild(this._buildEnrolledBanner(enrollStatus));
        } else if (!whatsNewAcked) {
            // The what's-new launch banner (v4.6.0) — shown on every fresh
            // install AND every update until acked.
            slot.appendChild(this._buildWhatsNew());
        }

        // Hide slot if empty (avoids extra padding)
        if (!slot.hasChildNodes()) {
            slot.style.display = 'none';
        } else {
            slot.style.display = 'block';
        }
    },

    _buildGuardianNotice() {
        const banner = document.createElement('div');
        banner.className = 'sv-global-banner';
        banner.style.cssText = 'position: relative; display: flex; align-items: center; gap: 16px; padding: 14px 44px 14px 16px; background: var(--bg-card); border: 1px solid var(--border-default); border-left: 3px solid var(--accent-primary); border-radius: 8px; margin-bottom: 10px; flex-wrap: wrap;';

        const ack = () => {
            try { localStorage.setItem(this.KEY_GUARDIAN_NOTICE, '1'); } catch (_) { /* private mode */ }
            // Re-render the slot so the next relevant banner (what's-new /
            // plugins nudge) takes over immediately — without this, banners
            // only advanced on a full reload, which read as "banner missing".
            this.render();
        };

        // Shield-with-spark icon — security feature, not a sales pitch
        const icon = document.createElement('div');
        icon.style.cssText = 'flex-shrink: 0; width: 36px; height: 36px; background: rgba(94,173,184,0.14); border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--accent-primary);';
        icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1 1 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>';
        banner.appendChild(icon);

        const textCol = document.createElement('div');
        textCol.style.cssText = 'flex: 1 1 300px; min-width: 240px;';
        const titleRow = document.createElement('div');
        titleRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 3px; flex-wrap: wrap;';
        const title = document.createElement('div');
        title.style.cssText = 'font-size: 13px; font-weight: 700; color: var(--text-primary); line-height: 1.3;';
        title.textContent = 'Guardian ML is active — local AI threat detection';
        titleRow.appendChild(title);
        const pill = document.createElement('span');
        pill.style.cssText = 'font-size: 9.5px; font-weight: 700; letter-spacing: 0.5px; color: var(--accent-primary); background: rgba(94,173,184,0.12); border: 1px solid rgba(94,173,184,0.3); padding: 2px 6px; border-radius: 4px; text-transform: uppercase;';
        pill.textContent = 'Runs on this machine only';
        titleRow.appendChild(pill);
        textCol.appendChild(titleRow);
        const desc = document.createElement('div');
        desc.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.45;';
        desc.textContent = 'A small ML model now scans alongside the regex rules and labels everything it catches (Rule / ML) so you can audit its calls. Fully offline — nothing leaves your device. You\u2019re in control: keep it on, or switch it off anytime.';
        textCol.appendChild(desc);
        banner.appendChild(textCol);

        const actions = document.createElement('div');
        actions.style.cssText = 'display: flex; align-items: center; gap: 8px; flex-shrink: 0; flex-wrap: wrap;';

        const keepBtn = document.createElement('button');
        keepBtn.type = 'button';
        keepBtn.style.cssText = 'padding: 7px 16px; font-size: 12px; font-weight: 600; background: var(--accent-primary); border: none; color: #fff; border-radius: 6px; cursor: pointer;';
        keepBtn.textContent = 'Keep it on';
        keepBtn.addEventListener('click', ack);
        actions.appendChild(keepBtn);

        const offBtn = document.createElement('button');
        offBtn.type = 'button';
        offBtn.style.cssText = 'padding: 7px 14px; font-size: 12px; font-weight: 600; background: transparent; border: 1px solid var(--border-default); color: var(--text-secondary); border-radius: 6px; cursor: pointer;';
        offBtn.textContent = 'Turn off';
        offBtn.addEventListener('click', async () => {
            offBtn.disabled = true;
            offBtn.textContent = 'Turning off\u2026';
            try {
                await fetch('/api/settings', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ guardian_ml_enabled: false }),
                });
                offBtn.textContent = 'Turned off';
            } catch (_) {
                // API hiccup: don't pretend it worked — send them to the
                // Settings toggle instead of silently acking.
                offBtn.textContent = 'Failed \u2014 use Settings';
            }
            setTimeout(ack, 900);
        });
        actions.appendChild(offBtn);

        const learnBtn = document.createElement('button');
        learnBtn.type = 'button';
        learnBtn.style.cssText = 'padding: 7px 4px; font-size: 12px; font-weight: 600; background: transparent; border: none; color: var(--accent-primary); cursor: pointer;';
        learnBtn.textContent = 'Learn more \u2192';
        // Deliberately does NOT ack — they can read the Guardian page and
        // still get the keep/off choice when they come back.
        learnBtn.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate('guardian-ml'); });
        actions.appendChild(learnBtn);

        banner.appendChild(actions);

        // x = "fine, keep it on" — same outcome as the primary button
        const dismissBtn = document.createElement('button');
        dismissBtn.style.cssText = 'position: absolute; top: 6px; right: 6px; background: transparent; border: none; color: var(--text-muted); font-size: 16px; cursor: pointer; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; line-height: 1; border-radius: 6px; transition: color 0.15s, background 0.15s;';
        dismissBtn.title = 'Dismiss (keeps Guardian on)';
        dismissBtn.setAttribute('aria-label', 'Dismiss notice, keeping Guardian ML on');
        dismissBtn.textContent = '\u00D7';
        dismissBtn.addEventListener('mouseenter', () => { dismissBtn.style.color = 'var(--text-primary)'; dismissBtn.style.background = 'var(--bg-secondary)'; });
        dismissBtn.addEventListener('mouseleave', () => { dismissBtn.style.color = 'var(--text-muted)'; dismissBtn.style.background = 'transparent'; });
        dismissBtn.addEventListener('click', ack);
        banner.appendChild(dismissBtn);

        return banner;
    },

    _buildWhatsNew() {
        // What's-new launch banner — deliberately compact: one line of copy
        // + one CTA. (The fuller two-CTA treatment read as too heavy next to
        // the Guardian consent notice that now precedes it.)
        const card = document.createElement('div');
        card.className = 'sv-global-banner';
        card.style.cssText = 'position: relative; display: flex; align-items: center; gap: 16px; padding: 14px 44px 14px 16px; background: var(--bg-card); border: 1px solid var(--border-default); border-left: 3px solid var(--accent-primary); border-radius: 8px; margin-bottom: 10px; flex-wrap: wrap;';

        // Topology / network-graph icon — three connected nodes, conveying
        // the device -> agent -> tool map at a glance.
        const icon = document.createElement('div');
        icon.style.cssText = 'flex-shrink: 0; width: 36px; height: 36px; background: rgba(94,173,184,0.14); border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--accent-primary);';
        icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M10.6 7l-4 9.7"/><path d="M13.4 7l4 9.7"/></svg>';
        card.appendChild(icon);

        const textCol = document.createElement('div');
        textCol.style.cssText = 'flex: 1 1 300px; min-width: 240px;';

        const titleRow = document.createElement('div');
        titleRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 3px; flex-wrap: wrap;';
        const title = document.createElement('div');
        title.style.cssText = 'font-size: 13px; font-weight: 700; color: var(--text-primary); line-height: 1.3;';
        title.textContent = 'Now with the GitHub Copilot CLI plugin';
        titleRow.appendChild(title);
        const pill = document.createElement('span');
        pill.style.cssText = 'font-size: 9.5px; font-weight: 800; letter-spacing: 0.5px; color: var(--accent-primary); background: rgba(94,173,184,0.12); border: 1px solid rgba(94,173,184,0.3); padding: 2px 6px; border-radius: 4px; text-transform: uppercase;';
        pill.textContent = 'New \u00B7 v4.6.0';
        titleRow.appendChild(pill);
        textCol.appendChild(titleRow);

        const desc = document.createElement('div');
        desc.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.45;';
        desc.textContent = 'Copilot CLI joins the guarded harnesses, and Guardian ML adds local AI threat detection. See every guarded run on the Agent Map.';
        textCol.appendChild(desc);

        card.appendChild(textCol);

        const ctaGroup = document.createElement('div');
        ctaGroup.style.cssText = 'display: flex; align-items: center; gap: 8px; flex-shrink: 0; flex-wrap: wrap;';

        // Primary CTA — explore the hero feature (filled, brand accent).
        const explore = document.createElement('button');
        explore.style.cssText = 'font-size: 12px; font-weight: 600; color: #fff; background: var(--accent-primary); border: none; padding: 7px 13px; border-radius: 6px; cursor: pointer; white-space: nowrap; transition: opacity 0.15s, transform 0.05s; line-height: 1;';
        explore.textContent = 'Explore the Agent Map \u2192';
        explore.addEventListener('mouseenter', () => { explore.style.opacity = '0.9'; });
        explore.addEventListener('mouseleave', () => { explore.style.opacity = '1'; });
        explore.addEventListener('mousedown', () => { explore.style.transform = 'scale(0.98)'; });
        explore.addEventListener('mouseup', () => { explore.style.transform = 'scale(1)'; });
        explore.addEventListener('click', () => {
            localStorage.setItem(this.KEY_WHATS_NEW, this.WHATS_NEW_VERSION);
            // Lands on the Agent Map (the hero topology view) \u2014 navigate()
            // expands the Agent Activity section automatically.
            if (window.Sidebar) Sidebar.navigate('agent-map');
            this.render();
        });
        ctaGroup.appendChild(explore);

        card.appendChild(ctaGroup);

        const closeBtn = document.createElement('button');
        closeBtn.style.cssText = 'position: absolute; top: 6px; right: 6px; background: transparent; border: none; color: var(--text-muted); font-size: 16px; cursor: pointer; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; line-height: 1; border-radius: 6px; transition: color 0.15s, background 0.15s;';
        closeBtn.title = 'Dismiss';
        closeBtn.setAttribute('aria-label', 'Dismiss');
        closeBtn.textContent = '\u00D7';
        closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = 'var(--text-primary)'; closeBtn.style.background = 'var(--bg-secondary)'; });
        closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = 'var(--text-muted)'; closeBtn.style.background = 'transparent'; });
        closeBtn.addEventListener('click', () => {
            localStorage.setItem(this.KEY_WHATS_NEW, this.WHATS_NEW_VERSION);
            this.render();
        });
        card.appendChild(closeBtn);

        return card;
    },

    /**
     * Post-enrollment first-run banner (#114). One-time. Tells the user the
     * device is enrolled, Cloud Connect is on, and links straight to the new
     * Cloud Activity page where they can audit exactly what flows in and out.
     */
    _buildEnrolledBanner(enrollStatus) {
        const card = document.createElement('div');
        card.className = 'sv-global-banner';
        card.style.cssText = 'position: relative; display: flex; align-items: center; gap: 16px; padding: 14px 44px 14px 16px; background: var(--bg-card); border: 1px solid var(--border-default); border-left: 3px solid var(--accent-primary); border-radius: 8px; margin-bottom: 10px; flex-wrap: wrap;';

        // Cloud icon — signals "you're now connected to your org cloud".
        const icon = document.createElement('div');
        icon.style.cssText = 'flex-shrink: 0; width: 36px; height: 36px; background: rgba(94,173,184,0.14); border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--accent-primary);';
        icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.8 6 6 0 1 0-11.1 3.6"/><path d="m9 15 2 2 4-4"/></svg>';
        card.appendChild(icon);

        const textCol = document.createElement('div');
        textCol.style.cssText = 'flex: 1 1 300px; min-width: 240px;';

        const titleRow = document.createElement('div');
        titleRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 3px; flex-wrap: wrap;';
        const title = document.createElement('div');
        title.style.cssText = 'font-size: 13px; font-weight: 700; color: var(--text-primary); line-height: 1.3;';
        // org_name is admin-authored — textContent only, never innerHTML.
        const orgName = (enrollStatus && enrollStatus.org_name) ? enrollStatus.org_name : null;
        title.textContent = orgName
            ? 'Your device is enrolled in ' + orgName
            : 'Your device is enrolled';
        titleRow.appendChild(title);
        const pill = document.createElement('span');
        pill.style.cssText = 'font-size: 9.5px; font-weight: 800; letter-spacing: 0.5px; color: var(--accent-primary); background: rgba(94,173,184,0.12); border: 1px solid rgba(94,173,184,0.3); padding: 2px 6px; border-radius: 4px; text-transform: uppercase;';
        pill.textContent = 'Cloud Connect on';
        titleRow.appendChild(pill);
        textCol.appendChild(titleRow);

        const desc = document.createElement('div');
        desc.style.cssText = 'font-size: 12px; color: var(--text-secondary); line-height: 1.45;';
        desc.textContent = "Cloud Connect is on. Managed policies sync down and metadata-only audit flows up — here's exactly what's flowing in and out.";
        textCol.appendChild(desc);
        card.appendChild(textCol);

        const ctaGroup = document.createElement('div');
        ctaGroup.style.cssText = 'display: flex; align-items: center; gap: 8px; flex-shrink: 0; flex-wrap: wrap;';
        const view = document.createElement('button');
        view.style.cssText = 'font-size: 12px; font-weight: 600; color: #fff; background: var(--accent-primary); border: none; padding: 7px 13px; border-radius: 6px; cursor: pointer; white-space: nowrap; transition: opacity 0.15s; line-height: 1;';
        view.textContent = 'View Cloud Activity →';
        view.addEventListener('mouseenter', () => { view.style.opacity = '0.9'; });
        view.addEventListener('mouseleave', () => { view.style.opacity = '1'; });
        view.addEventListener('click', () => {
            localStorage.setItem(this.KEY_ENROLLED, '1');
            if (window.Sidebar) Sidebar.navigate('cloud-activity');
            card.remove();
            this._collapseSlotIfEmpty();
        });
        ctaGroup.appendChild(view);
        card.appendChild(ctaGroup);

        const closeBtn = document.createElement('button');
        closeBtn.style.cssText = 'position: absolute; top: 6px; right: 6px; background: transparent; border: none; color: var(--text-muted); font-size: 16px; cursor: pointer; width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; line-height: 1; border-radius: 6px; transition: color 0.15s, background 0.15s;';
        closeBtn.title = 'Dismiss';
        closeBtn.setAttribute('aria-label', 'Dismiss');
        closeBtn.textContent = '×';
        closeBtn.addEventListener('mouseenter', () => { closeBtn.style.color = 'var(--text-primary)'; closeBtn.style.background = 'var(--bg-secondary)'; });
        closeBtn.addEventListener('mouseleave', () => { closeBtn.style.color = 'var(--text-muted)'; closeBtn.style.background = 'transparent'; });
        closeBtn.addEventListener('click', () => {
            localStorage.setItem(this.KEY_ENROLLED, '1');
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
