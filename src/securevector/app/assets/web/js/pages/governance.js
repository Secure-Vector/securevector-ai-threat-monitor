// Governance — dedicated page (moved off the dashboard, which was getting
// crowded). Shows THIS device's local protection posture as a
// Minimal/Partial/Strong band, with a plain "what is this?" explainer, an
// actionable control checklist (each row jumps to the setting that changes it),
// a guide link, and a soft cloud CTA.
//
// Framing matters here: this is an OPERATIONAL posture measured against
// SecureVector's own recommended controls — it is NOT a legal or regulatory
// compliance assessment, and the band is deliberately a coarse word, not a
// precise score, so it can't be mistaken for a "% compliant" number.
const GovernancePage = {
    // The recommended control set. `on(settings, ctx)` reads live signals.
    // `nav` is the sidebar page the row links to so a gap is one click to fix.
    CONTROLS: [
        { key: 'block',     label: 'Threat blocking enforced',           desc: 'Matched threats are blocked, not just logged.',                 on: (s)     => !!s.block_threats,                                              nav: 'settings' },
        { key: 'scan',      label: 'Output / data-leak scanning on',      desc: 'LLM responses are scanned for secrets/PII before storage.',     on: (s)     => s.scan_llm_responses !== false,                                 nav: 'settings' },
        { key: 'guardian',  label: 'Guardian ML detection active',        desc: 'Local ML catches obfuscated and paraphrased attacks.',          on: (s)     => !!s.guardian_ml_enabled && s.guardian_ml_available !== false,    nav: 'guardian-ml' },
        { key: 'tools',     label: 'Tool-permission governance on',       desc: 'Tool/function calls are checked against your policy first.',    on: (s)     => s.tool_permissions_enabled !== false,                            nav: 'tool-permissions' },
        { key: 'audit',     label: 'Audit chain intact (tamper-evident)', desc: 'The hash-chained audit log verifies unbroken.',                 on: (s, c)  => c.integrityOk === true,                                        nav: 'redactions' },
        { key: 'rules',     label: 'Detection rules active',              desc: 'At least one detection rule is enabled.',                       on: (s, c)  => (c.activeRules || 0) > 0,                                      nav: 'rules' },
        { key: 'residency', label: 'Prompts kept on this device',         desc: 'Prompt text is analyzed locally, never sent to the cloud.',     on: (s)     => s.local_only_analysis !== false,                               nav: 'settings' },
    ],

    _band(activeCount) {
        if (activeCount >= 6) return { name: 'Strong',  color: 'var(--success, #10b981)', def: '6–7 of 7 controls active' };
        if (activeCount >= 3) return { name: 'Partial', color: 'var(--warning, #f59e0b)', def: '3–5 of 7 controls active' };
        return { name: 'Minimal', color: 'var(--danger, #ef4444)', def: '0–2 of 7 controls active' };
    },

    _injectStyle() {
        if (document.getElementById('sv-governance-style')) return;
        const st = document.createElement('style');
        st.id = 'sv-governance-style';
        // First-view highlight: pulse the band card 3 times, then settle.
        st.textContent = '@keyframes sv-gov-flash{0%,100%{box-shadow:0 0 0 0 rgba(94,173,184,0);}50%{box-shadow:0 0 0 4px rgba(94,173,184,0.45);}}'
                       + '.sv-gov-flash{animation:sv-gov-flash 0.6s ease-in-out 3;}';
        document.head.appendChild(st);
    },

    _go(nav) {
        try { if (window.Sidebar && Sidebar.navigate) return Sidebar.navigate(nav); } catch (e) {}
        try { if (window.App && App.loadPage) return App.loadPage(nav); } catch (e) {}
    },

    async render(container) {
        this._injectStyle();
        container.textContent = '';

        // Gather live signals — each best-effort so the page never hard-fails.
        let settings = {};   try { settings = (await API.getSettings()) || {}; } catch (e) {}
        let integrityOk = null; try { const ig = await API.getToolCallAuditIntegrity(); integrityOk = !!(ig && ig.ok); } catch (e) {}
        let cloud = {};      try { cloud = (await API.getCloudSettings()) || {}; } catch (e) {}
        let activeRules = 0; try { const a = await API.getThreatAnalytics(); activeRules = (a && a.active_rules) || 0; } catch (e) {}
        const cloudOn = !!(cloud && cloud.cloud_mode_enabled && cloud.credentials_configured);
        const locked  = settings.local_only_analysis !== false && cloud.residency_locked === true;
        const ctx = { integrityOk, activeRules };

        const factors = this.CONTROLS.map(c => ({ ...c, isOn: !!c.on(settings, ctx) }));
        const activeCount = factors.filter(f => f.isOn).length;
        const band = this._band(activeCount);

        const wrap = document.createElement('div');
        wrap.style.cssText = 'max-width: 880px;';

        const card = (mb) => {
            const d = document.createElement('div');
            d.style.cssText = 'background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 12px; padding: 16px 20px; margin-bottom: ' + (mb || 16) + 'px;';
            return d;
        };

        // ---------- "What is this?" explainer ----------
        const explain = card();
        const exTitle = document.createElement('div');
        exTitle.textContent = 'What is this?';
        exTitle.style.cssText = 'font-weight: 700; font-size: 15px; color: var(--text-primary); margin-bottom: 6px;';
        explain.appendChild(exTitle);
        const exBody = document.createElement('p');
        exBody.style.cssText = 'margin: 0; font-size: 13px; color: var(--text-secondary); line-height: 1.55;';
        exBody.textContent = 'Governance posture is a live summary of which SecureVector protection controls are switched on for this device. '
                           + 'It is computed locally — nothing about it leaves your machine. It reflects your operational posture against SecureVector’s recommended controls; '
                           + 'it is not a measure of legal or regulatory compliance.';
        explain.appendChild(exBody);
        wrap.appendChild(explain);

        // ---------- Band card ----------
        const bandCard = card();
        bandCard.className = 'sv-gov-flash';
        const head = document.createElement('div');
        head.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;';
        const hLeft = document.createElement('div');
        const hTitle = document.createElement('div');
        hTitle.textContent = 'This device';
        hTitle.style.cssText = 'font-weight: 700; font-size: 15px; color: var(--text-primary);';
        hLeft.appendChild(hTitle);
        const hSub = document.createElement('div');
        hSub.textContent = activeCount + ' of 7 recommended controls active';
        hSub.style.cssText = 'font-size: 12.5px; color: var(--text-secondary); margin-top: 2px;';
        hLeft.appendChild(hSub);
        head.appendChild(hLeft);

        const pill = document.createElement('div');
        pill.style.cssText = 'display:inline-flex; align-items:center; gap:8px; padding:6px 14px; border-radius:999px; border:1px solid ' + band.color + '; color:' + band.color + '; font-weight:800; font-size:15px; background:transparent;';
        const dot = document.createElement('span');
        dot.style.cssText = 'width:8px; height:8px; border-radius:50%; background:' + band.color + ';';
        pill.appendChild(dot);
        pill.appendChild(document.createTextNode(band.name));
        pill.title = band.name + ' = ' + band.def + '. Operational posture, not a compliance score.';
        head.appendChild(pill);
        bandCard.appendChild(head);

        // band scale legend (factual definitions, no fake precision)
        const legend = document.createElement('div');
        legend.style.cssText = 'margin-top:10px; font-size:11.5px; color: var(--text-muted, #7d8590);';
        legend.textContent = 'Minimal = 0–2 active · Partial = 3–5 · Strong = 6–7. A coarse operational band, not a compliance score.';
        bandCard.appendChild(legend);
        wrap.appendChild(bandCard);

        // ---------- Control checklist (actionable) ----------
        const list = card();
        const lTitle = document.createElement('div');
        lTitle.textContent = 'Controls';
        lTitle.style.cssText = 'font-weight: 700; font-size: 14px; color: var(--text-primary); margin-bottom: 4px;';
        list.appendChild(lTitle);
        const lHint = document.createElement('div');
        lHint.textContent = 'Each control links to the setting that changes it.';
        lHint.style.cssText = 'font-size: 11.5px; color: var(--text-muted, #7d8590); margin-bottom: 8px;';
        list.appendChild(lHint);

        factors.forEach(f => {
            const row = document.createElement('button');
            row.type = 'button';
            row.style.cssText = 'width:100%; text-align:left; display:flex; align-items:flex-start; gap:10px; padding:9px 8px; background:none; border:none; border-top:1px solid var(--border-default); cursor:pointer; color:inherit;';
            row.addEventListener('mouseenter', () => { row.style.background = 'var(--bg-hover, rgba(255,255,255,0.03))'; });
            row.addEventListener('mouseleave', () => { row.style.background = 'none'; });
            row.addEventListener('click', () => this._go(f.nav));

            const mark = document.createElement('span');
            mark.textContent = f.isOn ? '✓' : '○';
            mark.style.cssText = 'font-weight:700; font-size:14px; line-height:1.4; flex:none; color:' + (f.isOn ? 'var(--success, #10b981)' : 'var(--text-muted, #7d8590)') + ';';
            row.appendChild(mark);

            const txt = document.createElement('div');
            txt.style.cssText = 'flex:1; min-width:0;';
            const lab = document.createElement('div');
            lab.textContent = f.label + (f.key === 'audit' && integrityOk === null ? ' (unverified)' : '');
            lab.style.cssText = 'font-size:13px; font-weight:600; color: var(--text-primary);';
            txt.appendChild(lab);
            const dsc = document.createElement('div');
            dsc.textContent = f.desc;
            dsc.style.cssText = 'font-size:12px; color: var(--text-secondary); margin-top:1px;';
            txt.appendChild(dsc);
            row.appendChild(txt);

            const state = document.createElement('span');
            state.textContent = f.isOn ? 'On' : 'Off';
            state.style.cssText = 'flex:none; font-size:11px; font-weight:700; padding:2px 8px; border-radius:999px; ' + (f.isOn
                ? 'color: var(--success, #10b981); border:1px solid var(--success, #10b981);'
                : 'color: var(--text-muted, #7d8590); border:1px solid var(--border-default);');
            row.appendChild(state);

            list.appendChild(row);
        });
        wrap.appendChild(list);

        // ---------- Measured-against + guide + disclaimer ----------
        const meta = card();
        const mTitle = document.createElement('div');
        mTitle.textContent = 'How this is measured';
        mTitle.style.cssText = 'font-weight: 700; font-size: 14px; color: var(--text-primary); margin-bottom: 6px;';
        meta.appendChild(mTitle);
        const mBody = document.createElement('p');
        mBody.style.cssText = 'margin: 0 0 10px; font-size: 12.5px; color: var(--text-secondary); line-height: 1.55;';
        mBody.textContent = 'The band counts how many of the seven controls above are active. They are SecureVector’s recommended baseline for running an agent safely — '
                          + 'not a certification against any law or framework. Treat frameworks such as the EU AI Act as orientation only.';
        meta.appendChild(mBody);

        const guideRow = document.createElement('div');
        guideRow.style.cssText = 'display:flex; gap:16px; flex-wrap:wrap; align-items:center;';
        const guide = document.createElement('a');
        guide.href = 'https://app.securevector.io/governance';
        guide.target = '_blank'; guide.rel = 'noopener noreferrer';
        guide.textContent = 'Read the governance guide →';
        guide.style.cssText = 'color: var(--accent-primary); font-weight: 600; font-size: 13px; text-decoration: none;';
        guideRow.appendChild(guide);
        const euLink = document.createElement('a');
        euLink.href = 'https://app.securevector.io/governance/eu-ai-act';
        euLink.target = '_blank'; euLink.rel = 'noopener noreferrer';
        euLink.textContent = 'EU AI Act orientation →';
        euLink.style.cssText = 'color: var(--accent-primary); font-weight: 600; font-size: 13px; text-decoration: none;';
        guideRow.appendChild(euLink);
        meta.appendChild(guideRow);

        const disclaimer = document.createElement('div');
        disclaimer.textContent = 'Orientation only — not legal advice.';
        disclaimer.style.cssText = 'margin-top: 8px; font-size: 11px; color: var(--text-muted, #7d8590);';
        meta.appendChild(disclaimer);
        wrap.appendChild(meta);

        // ---------- Soft cloud CTA (only when not already on cloud) ----------
        if (!cloudOn) {
            const cta = card(0);
            cta.style.borderColor = 'var(--accent-primary)';
            const cLead = document.createElement('div');
            cLead.style.cssText = 'font-size: 13px; color: var(--text-secondary); line-height: 1.5;';
            cLead.innerHTML = 'This is one device. <a href="https://app.securevector.io/governance" target="_blank" rel="noopener noreferrer" style="color:var(--accent-primary); font-weight:600;">See posture across your whole fleet →</a> by connecting to SecureVector Cloud.';
            cta.appendChild(cLead);
            const cMicro = document.createElement('div');
            cMicro.textContent = locked
                ? 'EU data-residency is enforced: prompt analysis stays on-device and cannot be sent to the cloud.'
                : 'Connecting syncs rules, policies, and fleet metadata. Your prompts stay on-device by default.';
            cMicro.style.cssText = 'margin-top: 4px; font-size: 11.5px; color: var(--text-muted, #7d8590);';
            cta.appendChild(cMicro);
            wrap.appendChild(cta);
        }

        container.appendChild(wrap);

        // Fire the first-view 3× flash once per session.
        try {
            if (sessionStorage.getItem('sv-governance-flashed') !== '1') {
                sessionStorage.setItem('sv-governance-flashed', '1');
            } else {
                bandCard.classList.remove('sv-gov-flash');
            }
        } catch (e) {}
    },
};

window.GovernancePage = GovernancePage;
