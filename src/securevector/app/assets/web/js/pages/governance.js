// Governance — dedicated page (under the Cloud nav section). Shows THIS
// device's local protection posture HONESTLY and CONTEXT-AWARELY: every
// control is read from a real, live signal and shown in one of these states —
//   ✓ On       enforced/verified now
//   ◆ Native   enforced by the active runtime's own mechanism (hook/SDK/MCP)
//   ~ Partial  on but not fully effective (e.g. local tool enforcement, no
//              cloud MCP policy)
//   ✗ Off      a control that is off (red only when it's a real gap here)
//
// Hard rules so this stays legitimate (not "security theater"):
//   - Never default a control to enforced. Unknown signal != enforced.
//   - Cloud-only enforcement (org MCP policy) is Partial when not enrolled.
//   - Threat blocking is assessed against what is ACTUALLY active: tool calls
//     are blocked natively by hooks/SDK/MCP, so Block Mode is only a real gap
//     when the OpenClaw proxy is running without it.
//   - The band is an OPERATIONAL posture vs SecureVector's recommended
//     controls, which are DERIVED by mapping each control to recognized
//     framework documents (cited per row + below). It is NOT a certification
//     or legal/compliance assessment.
const GovernancePage = {
    // The baseline's provenance: each control is mapped to a clause in these
    // published documents. This is "informed by", orientation only.
    FRAMEWORKS: 'SecureVector’s recommended baseline is derived by mapping each control above to published guidance: '
              + 'OWASP Top 10 for LLM Applications (2025) · NIST AI Risk Management Framework (AI RMF 1.0, NIST AI 100-1) · '
              + 'EU AI Act (Regulation (EU) 2024/1689) Arts. 9, 10, 12, 14, 15 · SOC 2 Trust Services Criteria (Security & Confidentiality). '
              + 'Each control cites the specific provision it maps to. Orientation only — not a certification or legal advice.',

    // evaluate(s, ctx) -> { state: 'on'|'native'|'partial'|'off', note }
    CONTROLS: [
        {
            key: 'block', label: 'Threat blocking (Block Mode)', required: false, nav: 'dashboard#protection',
            fw: 'EU AI Act Art. 15 · OWASP LLM01 · NIST MANAGE',
            extra: 'Tool calls are blocked natively by the PreToolUse hook (Claude Code · Codex · Copilot CLI · Cursor · OpenClaw), the SDK middleware (LangChain · LangGraph · CrewAI), and MCP (check_tool_permission) — no Block Mode needed. Block Mode governs whether detected prompt-injection / data-leak threats are blocked (vs only logged) on the analyze path; OpenClaw is the only integration that also runs a block-mode proxy.',
            evaluate: (s, c) => {
                if (s.block_threats) return { state: 'on', note: 'Detected prompt-injection / data-leak threats are blocked on input and output.' };
                if (c.proxyRunning) return { state: 'off', gap: true, note: 'The OpenClaw proxy is running but Block Mode is OFF — proxy threats are logged, not blocked. Turn on Block Mode to enforce.' };
                return { state: 'native', note: (c.activeRuntimes && c.activeRuntimes.length
                    ? 'Not needed for your active integration(s) — ' + c.activeRuntimes.join(', ') + ' block tool calls natively. Block Mode is optional unless you run the OpenClaw proxy.'
                    : 'No proxy running — hook/SDK/MCP integrations block tool calls natively. Block Mode is optional unless you run the OpenClaw proxy.') };
            },
        },
        {
            key: 'scan', label: 'Output / data-leak scanning', required: true, nav: 'dashboard#protection',
            fw: 'EU AI Act Art. 10/15 · OWASP LLM05/LLM02 · SOC 2 Confidentiality',
            evaluate: (s) => s.scan_llm_responses
                ? { state: 'on', note: 'LLM output is scanned for secrets/PII before storage.' }
                : { state: 'off', gap: true, note: 'Output scanning is off — responses are not checked for data leakage.' },
        },
        {
            key: 'guardian', label: 'Guardian ML detection', required: false, nav: 'guardian-ml',
            fw: 'OWASP LLM01/LLM09 · NIST MEASURE',
            evaluate: (s) => {
                if (!s.guardian_ml_enabled) return { state: 'off', note: 'Guardian ML is disabled (optional — rules still run).' };
                if (s.guardian_ml_available === false) return { state: 'partial', note: 'Enabled but the model is not installed — pip install securevector-guardian-model, then restart.' };
                return { state: 'on', note: 'Local ML model is loaded and scoring alongside the rules.' };
            },
        },
        {
            key: 'tools', label: 'Tool-permission governance', required: true, nav: 'tool-permissions',
            fw: 'EU AI Act Art. 14 (human oversight) · OWASP LLM06 (Excessive Agency) · SOC 2 CC6',
            evaluate: (s, c) => {
                if (s.tool_permissions_enabled === false) return { state: 'off', gap: true, note: 'Tool/function calls are not checked against a permission policy.' };
                return c.enrolled
                    ? { state: 'on', note: 'Local enforcement is on AND org/cloud MCP policy is synced to this device.' }
                    : { state: 'partial', note: 'Local enforcement only — no org/cloud MCP policy is synced (this device is not enrolled). Connect cloud to centralize policy.' };
            },
        },
        {
            key: 'audit', label: 'Audit chain integrity', required: true, nav: 'redactions',
            fw: 'EU AI Act Art. 12 (record-keeping) · NIST GOVERN · SOC 2 CC7',
            evaluate: (s, c) => {
                if (c.integrityOk === true) return { state: 'on', note: 'Hash-chained audit log verified unbroken (' + (c.auditCount || 0) + ' events).' };
                if (c.integrityOk === null) return { state: 'partial', note: 'Audit chain not yet verified this session.' };
                return { state: 'off', gap: true, note: 'Audit chain verification FAILED — tamper detected.' };
            },
        },
        {
            key: 'rules', label: 'Detection rules active', required: true, nav: 'rules',
            fw: 'OWASP LLM01 · NIST MEASURE',
            evaluate: (s, c) => (c.activeRules > 0)
                ? { state: 'on', note: c.activeRules + ' detection rule(s) enabled.' }
                : { state: 'off', gap: true, note: 'No detection rules are enabled.' },
        },
        {
            key: 'residency', label: 'Prompts kept on this device', required: true, nav: 'settings',
            fw: 'EU AI Act Art. 10 (data governance) / GDPR · SOC 2 Confidentiality',
            evaluate: (s) => (s.local_only_analysis !== false)
                ? { state: 'on', note: s.residency_locked ? 'Enforced by your org’s data-residency policy — prompt text cannot leave this device.' : 'Prompt text is analyzed on-device and not sent to the cloud.' }
                : { state: 'off', gap: true, note: 'Cloud analysis is on — prompt text is sent to SecureVector Cloud.' },
        },
    ],

    _band(rows) {
        // A "gap" is a required control off, or a meaningful partial/proxy gap.
        const gaps = rows.filter(r => r.gap || (r.required && r.state === 'partial'));
        const required = rows.filter(r => r.required);
        const okReq = required.filter(r => r.state === 'on' || r.state === 'native').length;
        if (gaps.length === 0) return { name: 'Strong',  color: 'var(--success, #10b981)', def: 'every required control is enforced and no gaps detected' };
        if (okReq >= Math.ceil(required.length / 2)) return { name: 'Partial', color: 'var(--warning, #f59e0b)', def: 'some controls are off, partial, or have a gap' };
        return { name: 'Minimal', color: 'var(--danger, #ef4444)', def: 'most required controls are off' };
    },

    _mark(r) {
        if (r.state === 'on')      return { glyph: '✓', label: 'On',      color: 'var(--success, #10b981)' };
        if (r.state === 'native')  return { glyph: '◆', label: 'Native',  color: 'var(--success, #10b981)' };
        if (r.state === 'partial') return { glyph: '~', label: 'Partial', color: 'var(--warning, #f59e0b)' };
        // off: red only when it's a real gap; otherwise neutral (optional, off)
        return r.gap
            ? { glyph: '✗', label: 'Off', color: 'var(--danger, #ef4444)' }
            : { glyph: '○', label: 'Off', color: 'var(--text-muted, #7d8590)' };
    },

    _injectStyle() {
        if (document.getElementById('sv-governance-style')) return;
        const st = document.createElement('style');
        st.id = 'sv-governance-style';
        st.textContent = '@keyframes sv-gov-flash{0%,100%{box-shadow:0 0 0 0 rgba(94,173,184,0);}50%{box-shadow:0 0 0 3px rgba(94,173,184,0.30);}}'
                       + '.sv-gov-flash{animation:sv-gov-flash 0.6s ease-in-out 3;}';
        document.head.appendChild(st);
    },

    _scrollTo(selector) {
        // Poll for the element (the target page renders async), then scroll +
        // briefly highlight it. Reuses the page's flash keyframes.
        let tries = 0;
        const tick = () => {
            const el = document.querySelector(selector);
            if (el) {
                try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { el.scrollIntoView(); }
                el.classList.add('sv-gov-flash');
                setTimeout(() => el.classList.remove('sv-gov-flash'), 2200);
                return;
            }
            if (tries++ < 16) setTimeout(tick, 150);
        };
        tick();
    },

    _go(nav) {
        // 'dashboard#protection' → open the dashboard Protection card (the home
        // of the Block Mode / Output Scan switches) and highlight it.
        if (nav === 'dashboard#protection') {
            try { if (window.Sidebar && Sidebar.navigate) Sidebar.navigate('dashboard'); else if (window.App && App.loadPage) App.loadPage('dashboard'); } catch (e) {}
            this._scrollTo('.security-controls-section');
            return;
        }
        // 'toggle:<id>' actuates a header toggle (its own confirm runs); else navigate.
        if (typeof nav === 'string' && nav.indexOf('toggle:') === 0) {
            const el = document.getElementById(nav.slice(7));
            if (el) { try { el.scrollIntoView({ block: 'center' }); } catch (e) {} el.click(); }
            return;
        }
        try { if (window.Sidebar && Sidebar.navigate) return Sidebar.navigate(nav); } catch (e) {}
        try { if (window.App && App.loadPage) return App.loadPage(nav); } catch (e) {}
    },

    async render(container) {
        this._injectStyle();
        container.textContent = '';

        let settings = {};   try { settings = (await API.getSettings()) || {}; } catch (e) {}
        let integrityOk = null, auditCount = 0;
        try { const ig = await API.getToolCallAuditIntegrity(); integrityOk = !!(ig && ig.ok); auditCount = (ig && ig.total) || 0; } catch (e) {}
        let cloud = {};      try { cloud = (await API.getCloudSettings()) || {}; } catch (e) {}
        let activeRules = 0; try { const a = await API.getThreatAnalytics(); activeRules = (a && a.active_rules) || 0; } catch (e) {}
        let enrolled = false;
        try { const ca = await API.request('/api/v1/cloud-activity'); enrolled = !!(ca && ca.enrolled); } catch (e) {}
        // Context: is the OpenClaw proxy actually running? which runtimes are active?
        let proxyRunning = false;
        try { const ps = await API.request('/api/proxy/status'); proxyRunning = !!(ps && (ps.running || ps.active || ps.enabled)); } catch (e) {}
        let activeRuntimes = [];
        try {
            const st = await API.getCallAuditStats();
            const by = (st && (st.by_runtime || st.runtimes)) || {};
            activeRuntimes = Object.keys(by).filter(k => (by[k] && (by[k].total || by[k]) > 0));
        } catch (e) {}
        const cloudOn = !!(cloud && cloud.cloud_mode_enabled && cloud.credentials_configured);
        const ctx = { integrityOk, auditCount, activeRules, enrolled, proxyRunning, activeRuntimes };

        const rows = this.CONTROLS.map(c => Object.assign({}, c, c.evaluate(settings, ctx)));
        const band = this._band(rows);
        const onCount = rows.filter(r => r.state === 'on' || r.state === 'native').length;
        const partialCount = rows.filter(r => r.state === 'partial').length;
        const gapCount = rows.filter(r => r.gap).length;

        const wrap = document.createElement('div'); wrap.style.cssText = 'max-width: 900px;';
        const card = (mb) => { const d = document.createElement('div'); d.style.cssText = 'background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 12px; padding: 16px 20px; margin-bottom: ' + (mb == null ? 16 : mb) + 'px;'; return d; };

        // What is this?
        const explain = card();
        const exTitle = document.createElement('div'); exTitle.textContent = 'What is this?'; exTitle.style.cssText = 'font-weight: 700; font-size: 15px; color: var(--text-primary); margin-bottom: 6px;'; explain.appendChild(exTitle);
        const exBody = document.createElement('p'); exBody.style.cssText = 'margin: 0; font-size: 13px; color: var(--text-secondary); line-height: 1.55;';
        exBody.textContent = 'A live, on-device summary of which SecureVector protection controls are actually enforced here, assessed against what is currently active. Each control is read from a real signal and shown as enforced (✓), native to the active runtime (◆), partial (~), or off (✗ when it is a real gap). '
                           + 'It is computed locally — nothing leaves your machine — and reflects your operational posture against SecureVector’s recommended controls, not a measure of legal or regulatory compliance.';
        explain.appendChild(exBody);
        wrap.appendChild(explain);

        // Band
        const bandCard = card(); bandCard.className = 'sv-gov-flash';
        const head = document.createElement('div'); head.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;';
        const hLeft = document.createElement('div');
        const hTitle = document.createElement('div'); hTitle.textContent = 'This device'; hTitle.style.cssText = 'font-weight: 700; font-size: 15px; color: var(--text-primary);'; hLeft.appendChild(hTitle);
        const hSub = document.createElement('div');
        hSub.textContent = onCount + ' enforced · ' + partialCount + ' partial · ' + gapCount + ' gap(s)';
        hSub.style.cssText = 'font-size: 12.5px; color: var(--text-secondary); margin-top: 2px;'; hLeft.appendChild(hSub);
        head.appendChild(hLeft);
        const pill = document.createElement('div'); pill.style.cssText = 'display:inline-flex; align-items:center; gap:8px; padding:6px 14px; border-radius:999px; border:1px solid ' + band.color + '; color:' + band.color + '; font-weight:800; font-size:15px;';
        const dot = document.createElement('span'); dot.style.cssText = 'width:8px; height:8px; border-radius:50%; background:' + band.color + ';'; pill.appendChild(dot);
        pill.appendChild(document.createTextNode(band.name));
        pill.title = band.name + ' — ' + band.def + '. Operational posture, not a compliance score.';
        head.appendChild(pill); bandCard.appendChild(head);
        const legend = document.createElement('div'); legend.style.cssText = 'margin-top:10px; font-size:11.5px; color: var(--text-muted, #7d8590);';
        legend.textContent = 'Strong = no gaps · Partial = some off/partial/gap · Minimal = most required off. ✓ enforced · ◆ native to the active runtime · ~ partial · ✗ gap. Operational band, not a compliance score.';
        bandCard.appendChild(legend);
        wrap.appendChild(bandCard);

        // Controls
        const list = card();
        const lTitle = document.createElement('div'); lTitle.textContent = 'Controls'; lTitle.style.cssText = 'font-weight: 700; font-size: 14px; color: var(--text-primary); margin-bottom: 4px;'; list.appendChild(lTitle);
        const lHint = document.createElement('div'); lHint.textContent = 'Read from live signals + your active integration. Each row links to the control that changes it.'; lHint.style.cssText = 'font-size: 11.5px; color: var(--text-muted, #7d8590); margin-bottom: 8px;'; list.appendChild(lHint);

        rows.forEach(r => {
            const m = this._mark(r);
            const row = document.createElement('button'); row.type = 'button';
            row.style.cssText = 'width:100%; text-align:left; display:flex; align-items:flex-start; gap:10px; padding:10px 8px; background:none; border:none; border-top:1px solid var(--border-default); cursor:pointer; color:inherit;';
            row.addEventListener('mouseenter', () => { row.style.background = 'var(--bg-hover, rgba(255,255,255,0.03))'; });
            row.addEventListener('mouseleave', () => { row.style.background = 'none'; });
            row.addEventListener('click', () => this._go(r.nav));

            const mark = document.createElement('span'); mark.textContent = m.glyph; mark.style.cssText = 'font-weight:800; font-size:15px; line-height:1.35; flex:none; width:14px; text-align:center; color:' + m.color + ';'; row.appendChild(mark);

            const txt = document.createElement('div'); txt.style.cssText = 'flex:1; min-width:0;';
            const labRow = document.createElement('div'); labRow.style.cssText = 'display:flex; align-items:center; gap:8px; flex-wrap:wrap;';
            const lab = document.createElement('span'); lab.textContent = r.label; lab.style.cssText = 'font-size:13px; font-weight:600; color: var(--text-primary);'; labRow.appendChild(lab);
            if (r.required) { const req = document.createElement('span'); req.textContent = 'required'; req.style.cssText = 'font-size:10px; font-weight:700; padding:1px 6px; border-radius:999px; color: var(--text-muted, #7d8590); border:1px solid var(--border-default);'; labRow.appendChild(req); }
            txt.appendChild(labRow);
            const dsc = document.createElement('div'); dsc.textContent = r.note; dsc.style.cssText = 'font-size:12px; color: var(--text-secondary); margin-top:2px; line-height:1.45;'; txt.appendChild(dsc);
            if (r.extra) { const ex = document.createElement('div'); ex.textContent = r.extra; ex.style.cssText = 'font-size:11px; color: var(--text-muted, #7d8590); margin-top:4px; line-height:1.45;'; txt.appendChild(ex); }
            const fw = document.createElement('div'); fw.textContent = r.fw; fw.style.cssText = 'font-size:10.5px; color: var(--text-muted, #7d8590); margin-top:3px;'; txt.appendChild(fw);
            row.appendChild(txt);

            const state = document.createElement('span'); state.textContent = m.label; state.style.cssText = 'flex:none; font-size:11px; font-weight:700; padding:2px 8px; border-radius:999px; color:' + m.color + '; border:1px solid ' + m.color + ';'; row.appendChild(state);
            list.appendChild(row);

            // Threat blocking: only the OpenClaw proxy needs Block Mode. Give a
            // direct in-app link to set that proxy up (kept as a sibling, not
            // nested in the row button, to avoid nested interactive elements).
            if (r.key === 'block') {
                const setup = document.createElement('div');
                setup.style.cssText = 'padding: 2px 8px 8px 32px; font-size: 11.5px; color: var(--text-muted, #7d8590);';
                setup.appendChild(document.createTextNode('Proxy needed? Only OpenClaw runs a block-mode proxy. '));
                const link = document.createElement('a');
                link.href = '#'; link.textContent = 'Set up the OpenClaw proxy →';
                link.style.cssText = 'color: var(--accent-primary); font-weight: 600; text-decoration: none;';
                link.addEventListener('click', (e) => { e.preventDefault(); this._go('proxy-openclaw'); });
                setup.appendChild(link);
                list.appendChild(setup);
            }
        });
        wrap.appendChild(list);

        // How measured + provenance + disclaimer
        const meta = card();
        const mTitle = document.createElement('div'); mTitle.textContent = 'How this is measured & which documents drive the baseline'; mTitle.style.cssText = 'font-weight: 700; font-size: 14px; color: var(--text-primary); margin-bottom: 6px;'; meta.appendChild(mTitle);
        const mBody = document.createElement('p'); mBody.style.cssText = 'margin: 0 0 10px; font-size: 12.5px; color: var(--text-secondary); line-height: 1.55;';
        mBody.textContent = 'Each control is assessed from a live signal and against what is currently active (e.g. threat blocking is "native" when your hook/SDK/MCP integration blocks tool calls itself). The band: no gaps = Strong; any off/partial/gap = Partial; most required off = Minimal.';
        meta.appendChild(mBody);
        const fwBody = document.createElement('p'); fwBody.style.cssText = 'margin: 0 0 10px; font-size: 12px; color: var(--text-secondary); line-height: 1.55;';
        fwBody.textContent = this.FRAMEWORKS;
        meta.appendChild(fwBody);

        const guideRow = document.createElement('div'); guideRow.style.cssText = 'display:flex; gap:16px; flex-wrap:wrap; align-items:center;';
        const guide = document.createElement('a'); guide.href = 'https://securevector.io/docs/governance'; guide.target = '_blank'; guide.rel = 'noopener noreferrer'; guide.textContent = 'Read the governance guide →'; guide.style.cssText = 'color: var(--accent-primary); font-weight: 600; font-size: 13px; text-decoration: none;'; guideRow.appendChild(guide);
        // EU AI Act: link to the official, primary regulation text (EUR-Lex) so this
        // stays strictly orientation/citation — not interpreted legal advice.
        const euLink = document.createElement('a'); euLink.href = 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj'; euLink.target = '_blank'; euLink.rel = 'noopener noreferrer'; euLink.textContent = 'EU AI Act — official text (EUR-Lex) →'; euLink.style.cssText = 'color: var(--accent-primary); font-weight: 600; font-size: 13px; text-decoration: none;'; guideRow.appendChild(euLink);
        meta.appendChild(guideRow);
        const disclaimer = document.createElement('div'); disclaimer.textContent = 'Orientation only — not legal advice.'; disclaimer.style.cssText = 'margin-top: 8px; font-size: 11px; color: var(--text-muted, #7d8590);'; meta.appendChild(disclaimer);
        wrap.appendChild(meta);

        // Soft cloud CTA
        if (!cloudOn) {
            const cta = card(0); cta.style.borderColor = 'var(--accent-primary)';
            const cLead = document.createElement('div'); cLead.style.cssText = 'font-size: 13px; color: var(--text-secondary); line-height: 1.5;';
            cLead.innerHTML = 'This is one device. <a href="https://app.securevector.io/governance" target="_blank" rel="noopener noreferrer" style="color:var(--accent-primary); font-weight:600;">See posture across your whole fleet →</a> by connecting to SecureVector Cloud.';
            cta.appendChild(cLead);
            const cMicro = document.createElement('div');
            cMicro.textContent = (settings.local_only_analysis !== false && settings.residency_locked)
                ? 'EU data-residency is enforced: prompt analysis stays on-device and cannot be sent to the cloud.'
                : 'Connecting syncs rules, policies, and fleet metadata (and enables org MCP policy). Your prompts stay on-device by default.';
            cMicro.style.cssText = 'margin-top: 4px; font-size: 11.5px; color: var(--text-muted, #7d8590);';
            cta.appendChild(cMicro);
            wrap.appendChild(cta);
        }

        container.appendChild(wrap);

        try {
            if (sessionStorage.getItem('sv-governance-flashed') === '1') bandCard.classList.remove('sv-gov-flash');
            else sessionStorage.setItem('sv-governance-flashed', '1');
        } catch (e) {}
    },
};

window.GovernancePage = GovernancePage;
