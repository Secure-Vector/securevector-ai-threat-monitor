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
            extra: 'Tool calls are blocked natively by hooks / SDKs / MCP — no Block Mode needed. Block Mode only matters for the OpenClaw proxy, the one integration that runs one.',
            evaluate: (s, c) => {
                // "Action needed" applies ONLY to OpenClaw: it's the one integration
                // whose threats are merely logged unless its block-mode proxy (or
                // Block Mode) is on. Hook/SDK/MCP runtimes block tool calls natively.
                if (c.openclawActive && !(c.proxyRunning || s.block_threats)) {
                    return { state: 'off', gap: true, note: 'OpenClaw is active but its block-mode proxy is off (and Block Mode is off) — OpenClaw threats are logged, not blocked. Start the proxy or turn on Block Mode.' };
                }
                if (s.block_threats) return { state: 'on', note: 'Block Mode is on — detected prompt-injection / data-leak threats are blocked on input and output.' };
                if (c.toolCallsSeen) {
                    const who = (c.activeRuntimes && c.activeRuntimes.length) ? c.activeRuntimes.join(', ') : 'your connected runtime';
                    return { state: 'native', note: 'Tool calls are blocked natively by ' + who + ' (via your hook / SDK / MCP). Block Mode only matters for the OpenClaw proxy — not needed here.' };
                }
                return { state: 'off', note: 'No agent connected yet — nothing to block. Block Mode applies only if you run the OpenClaw proxy.' };
            },
        },
        {
            key: 'scan', label: 'Output / data-leak scanning', required: true, nav: 'dashboard#protection',
            fw: 'EU AI Act Art. 15 · OWASP LLM05/LLM02 · SOC 2 Confidentiality',
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
                if (s.tool_permissions_enabled === false) return { state: 'off', gap: true, note: 'Tool/function calls are NOT checked against a permission policy — turn on Tool Permissions.' };
                return c.enrolled
                    ? { state: 'on', note: 'Enforced locally, and your org/cloud MCP policy is synced to this device — centralized, fleet-wide governance.' }
                    : { state: 'on', note: 'Enforced locally by your hooks / SDK / MCP. A centralized org-wide MCP policy (one policy pushed to every device) is an optional add-on — available when you connect cloud. Not a gap.' };
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
        if (gaps.length === 0) return { name: 'Strong',  color: 'var(--success, #10b981)', def: 'every required control is enforced for your connected integrations' };
        if (okReq >= Math.ceil(required.length / 2)) return { name: 'Partial', color: 'var(--warning, #f59e0b)', def: 'some controls are off, partial, or have a gap' };
        return { name: 'Minimal', color: 'var(--danger, #ef4444)', def: 'most required controls are off' };
    },

    _mark(r) {
        // Native gets its OWN teal identity (not the same green as Enforced) so
        // "blocked by your runtime, not by SecureVector's engine" can't be misread.
        if (r.state === 'on')      return { glyph: '✓', label: 'Enforced', color: 'var(--success, #10b981)', bg: 'rgba(16,185,129,0.14)' };
        if (r.state === 'native')  return { glyph: '◆', label: 'Native',   color: 'var(--accent-primary, #5eadb8)', bg: 'rgba(94,173,184,0.16)' };
        if (r.state === 'partial') return { glyph: '~', label: 'Partial',  color: 'var(--warning, #f59e0b)', bg: 'rgba(245,158,11,0.14)' };
        return r.gap
            ? { glyph: '✗', label: 'Action needed', color: 'var(--danger, #ef4444)', bg: 'rgba(239,68,68,0.14)' }
            : { glyph: '○', label: 'Off',           color: 'var(--text-muted, #7d8590)', bg: 'rgba(125,133,144,0.12)' };
    },

    _injectStyle() {
        if (document.getElementById('sv-governance-style')) return;
        const st = document.createElement('style');
        st.id = 'sv-governance-style';
        st.textContent = [
            '@keyframes sv-gov-flash{0%,100%{box-shadow:0 0 0 0 rgba(94,173,184,0);}50%{box-shadow:0 0 0 3px rgba(94,173,184,0.30);}}',
            '.sv-gov-flash{animation:sv-gov-flash 0.6s ease-in-out 3;}',
            '@keyframes gov-in{from{opacity:0;transform:translateY(7px);}to{opacity:1;transform:none;}}',
            '.gov-wrap{max-width:920px;}',
            '.gov-card{background:var(--bg-card);border:1px solid var(--border-default);border-radius:14px;padding:18px 20px;margin-bottom:16px;}',
            // posture meter (segmented bar)
            '.gov-meter{display:flex;height:8px;border-radius:999px;overflow:hidden;background:var(--border-default);margin-top:14px;}',
            '.gov-meter>span{height:100%;transition:width .5s cubic-bezier(.4,0,.2,1);}',
            // control row
            '.gov-ctrl{position:relative;display:flex;align-items:flex-start;gap:14px;width:100%;text-align:left;background:transparent;border:none;border-top:1px solid var(--border-default);padding:15px 12px 15px 18px;cursor:pointer;color:inherit;transition:background .15s ease;}',
            '.gov-ctrl.gov-animate{animation:gov-in .4s ease both;}',
            '.gov-ctrl:first-of-type{border-top:none;}',
            '.gov-ctrl::before{content:"";position:absolute;left:2px;top:14px;bottom:14px;width:3px;border-radius:3px;background:var(--rail);opacity:.55;transition:opacity .15s ease;}',
            '.gov-ctrl:hover{background:var(--bg-hover,rgba(255,255,255,0.035));}',
            '.gov-ctrl:hover::before{opacity:1;}',
            '.gov-ctrl:hover .gov-chev{opacity:.9;transform:translateX(0);}',
            '.gov-badge{flex:none;width:32px;height:32px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;line-height:1;}',
            '.gov-body{flex:1;min-width:0;}',
            '.gov-labrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
            '.gov-lab{font-size:13.5px;font-weight:650;color:var(--text-primary);}',
            '.gov-req{font-size:9.5px;font-weight:700;letter-spacing:.3px;text-transform:uppercase;padding:2px 6px;border-radius:5px;color:var(--text-muted,#7d8590);border:1px solid var(--border-default);}',
            '.gov-note{font-size:12px;color:var(--text-secondary);margin-top:3px;line-height:1.5;}',
            '.gov-extra{font-size:11px;color:var(--text-muted,#7d8590);margin-top:5px;line-height:1.5;}',
            '.gov-fw{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;color:var(--text-muted,#7d8590);margin-top:7px;letter-spacing:.2px;opacity:.85;}',
            '.gov-chip{flex:none;font-size:10.5px;font-weight:700;padding:4px 11px;border-radius:999px;letter-spacing:.3px;white-space:nowrap;}',
            '.gov-chev{flex:none;color:var(--text-muted,#7d8590);opacity:0;transform:translateX(-4px);transition:all .15s ease;font-size:20px;line-height:1;align-self:center;}',
            '.gov-statline{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;}',
            '.gov-stat{font-size:11px;font-weight:600;color:var(--text-secondary);display:inline-flex;align-items:center;gap:6px;}',
            '.gov-stat i{width:8px;height:8px;border-radius:2px;display:inline-block;font-style:normal;}',
        ].join('');
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
        // First view this session → play the entrance animations once; on
        // subsequent visits the page renders instantly (no replayed motion).
        let firstView = true;
        try { firstView = sessionStorage.getItem('sv-governance-flashed') !== '1'; } catch (e) {}

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
        // Coverage signal: the agent-session graph emits a "harness" node per
        // connected integration and a "session" node per agent session. We count
        // running sessions + harnesses (and detect OpenClaw) so the posture's
        // scope is explicit and threat-blocking is judged against the REAL
        // active runtime — not assumed.
        let activeRuntimes = [], sessionCount = 0, openclawActive = false, toolCallsSeen = false;
        try {
            const g = await API.getAgentSessionGraph({ window_days: 30 });
            const nodes = (g && g.nodes) || [];
            const hs = nodes.filter(n => (n.kind || n.type) === 'harness');
            const ss = nodes.filter(n => (n.kind || n.type) === 'session');
            activeRuntimes = Array.from(new Set(hs.map(h => h.label).filter(Boolean)));
            sessionCount = ss.filter(x => x.active !== false).length || ss.length;
            openclawActive = activeRuntimes.some(r => /openclaw/i.test(r));
            toolCallsSeen = hs.length > 0 || ss.length > 0;
        } catch (e) {}
        const cloudOn = !!(cloud && cloud.cloud_mode_enabled && cloud.credentials_configured);
        const ctx = { integrityOk, auditCount, activeRules, enrolled, proxyRunning, activeRuntimes, toolCallsSeen, sessionCount, openclawActive };
        // One canonical scope phrase reused in the band + scope + warnings.
        const agentTxt = sessionCount === 0
            ? 'no agent sessions connected via SV Guard / SDK yet'
            : (sessionCount + ' agent session' + (sessionCount === 1 ? '' : 's') + ' across ' + activeRuntimes.length + ' harness' + (activeRuntimes.length === 1 ? '' : 'es') + ' connected via SV Guard / SDK' + (activeRuntimes.length ? ' (' + activeRuntimes.join(', ') + ')' : ''));

        const rows = this.CONTROLS.map(c => Object.assign({}, c, c.evaluate(settings, ctx)));
        const band = this._band(rows);
        const onCount = rows.filter(r => r.state === 'on' || r.state === 'native').length;
        const partialCount = rows.filter(r => r.state === 'partial').length;
        const gapCount = rows.filter(r => r.gap).length;

        const wrap = document.createElement('div'); wrap.className = 'gov-wrap';
        const card = (mb) => { const d = document.createElement('div'); d.className = 'gov-card'; if (mb != null) d.style.marginBottom = mb + 'px'; return d; };

        // Combined "what this is + what it covers" — ONE yellow-highlighted block
        // so the scope boundary is always read together with the explanation.
        const intro = card();
        intro.style.borderColor = 'var(--warning, #f59e0b)';
        intro.style.background = 'linear-gradient(0deg, rgba(245,158,11,0.07), rgba(245,158,11,0.07)), var(--bg-card)';
        const inTitle = document.createElement('div'); inTitle.textContent = 'What this is — and what it covers'; inTitle.style.cssText = 'font-weight: 700; font-size: 15px; color: var(--text-primary); margin-bottom: 6px;'; intro.appendChild(inTitle);
        const inBody = document.createElement('p'); inBody.style.cssText = 'margin: 0 0 10px; font-size: 13px; color: var(--text-secondary); line-height: 1.55;';
        inBody.textContent = 'A live, on-device summary of which protection controls are actually enforced for your connected agent runtimes. Each control is read from a real signal and shown as Enforced, Native (your hook / SDK / MCP enforces it itself), Partial, or a gap that needs action. Computed locally — nothing leaves your machine — it is an operational posture against SecureVector’s recommended controls, not a measure of legal or regulatory compliance.';
        intro.appendChild(inBody);
        const inCount = document.createElement('div'); inCount.style.cssText = 'font-size: 13px; font-weight: 800; color: var(--text-primary); margin-bottom: 6px;';
        inCount.textContent = 'This device · ' + agentTxt.charAt(0).toUpperCase() + agentTxt.slice(1) + '.';
        intro.appendChild(inCount);
        const inScope = document.createElement('p'); inScope.style.cssText = 'margin: 0; font-size: 12px; color: var(--text-secondary); line-height: 1.55;';
        inScope.textContent = 'Scope: this covers ONLY agents/harnesses connected to SecureVector here (plugin · OpenClaw proxy · framework SDK · MCP). Agents you run WITHOUT a SecureVector integration — e.g. a LangChain app without the SDK, or a Claude Code session you didn’t wire — are invisible and NOT included. A “Strong” band means the controls are enforced for these connected integrations; it does not attest that every agent you run is governed.';
        intro.appendChild(inScope);
        if (!ctx.toolCallsSeen) {
            const inWarn = document.createElement('div'); inWarn.style.cssText = 'margin-top: 8px; font-size: 11.5px; font-weight: 700; color: var(--warning, #f59e0b);';
            inWarn.textContent = 'No connected integration has reported activity on this device yet — so there is nothing for this posture to govern.';
            intro.appendChild(inWarn);
        }
        wrap.appendChild(intro);

        // Band + segmented posture meter
        const C = { on: 'var(--success, #10b981)', native: 'var(--accent-primary, #5eadb8)', partial: 'var(--warning, #f59e0b)', gap: 'var(--danger, #ef4444)', off: 'var(--text-muted, #7d8590)' };
        const counts = { on: 0, native: 0, partial: 0, gap: 0, off: 0 };
        rows.forEach(r => { if (r.state === 'on') counts.on++; else if (r.state === 'native') counts.native++; else if (r.state === 'partial') counts.partial++; else if (r.gap) counts.gap++; else counts.off++; });

        const bandCard = card(); bandCard.className = 'gov-card' + (firstView ? ' sv-gov-flash' : '');
        const head = document.createElement('div'); head.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;';
        const hLeft = document.createElement('div');
        const hTitle = document.createElement('div'); hTitle.textContent = 'This device'; hTitle.style.cssText = 'font-weight: 700; font-size: 16px; color: var(--text-primary);'; hLeft.appendChild(hTitle);
        const hSub = document.createElement('div'); hSub.textContent = (sessionCount === 0 ? 'No agent sessions connected' : sessionCount + ' agent session' + (sessionCount === 1 ? '' : 's') + ' connected') + ' · ' + rows.length + ' controls assessed'; hSub.style.cssText = 'font-size: 12.5px; color: var(--text-secondary); margin-top: 2px;'; hLeft.appendChild(hSub);
        head.appendChild(hLeft);
        const pill = document.createElement('div'); pill.style.cssText = 'display:inline-flex; align-items:center; gap:9px; padding:7px 16px; border-radius:999px; border:1px solid ' + band.color + '; color:' + band.color + '; font-weight:800; font-size:16px; letter-spacing:.2px;';
        const dot = document.createElement('span'); dot.style.cssText = 'width:9px; height:9px; border-radius:50%; background:' + band.color + ';'; pill.appendChild(dot);
        pill.appendChild(document.createTextNode(band.name));
        pill.title = band.name + ' — ' + band.def + '. Operational posture, not a compliance score.';
        head.appendChild(pill); bandCard.appendChild(head);

        const meter = document.createElement('div'); meter.className = 'gov-meter';
        const seg = (n, color) => { if (!n) return; const s = document.createElement('span'); s.style.width = (n / rows.length * 100) + '%'; s.style.background = color; meter.appendChild(s); };
        seg(counts.on, C.on); seg(counts.native, C.native); seg(counts.partial, C.partial); seg(counts.gap, C.gap); seg(counts.off, C.off);
        bandCard.appendChild(meter);

        const statline = document.createElement('div'); statline.className = 'gov-statline';
        const stat = (n, label, color) => { if (!n) return; const s = document.createElement('span'); s.className = 'gov-stat'; const i = document.createElement('i'); i.style.background = color; s.appendChild(i); s.appendChild(document.createTextNode(n + ' ' + label)); statline.appendChild(s); };
        stat(counts.on, 'enforced', C.on); stat(counts.native, 'native', C.native); stat(counts.partial, 'partial', C.partial); stat(counts.gap, counts.gap === 1 ? 'gap' : 'gaps', C.gap); stat(counts.off, 'off', C.off);
        bandCard.appendChild(statline);

        const legend = document.createElement('div'); legend.style.cssText = 'margin-top:12px; font-size:11px; color: var(--text-muted, #7d8590); line-height:1.5;';
        legend.textContent = 'Strong = no gaps · Partial = some off / partial / gap · Minimal = most required controls off. An operational band, not a compliance score.';
        bandCard.appendChild(legend);
        wrap.appendChild(bandCard);

        // (Scope + explainer are merged into the yellow intro block at the top.)

        // Controls
        const list = card();
        const lTitle = document.createElement('div'); lTitle.textContent = 'Controls'; lTitle.style.cssText = 'font-weight: 700; font-size: 14px; color: var(--text-primary); margin-bottom: 4px;'; list.appendChild(lTitle);
        const lHint = document.createElement('div'); lHint.textContent = 'Read from live signals + your active integration. Each row links to the control that changes it.'; lHint.style.cssText = 'font-size: 11.5px; color: var(--text-muted, #7d8590); margin-bottom: 8px;'; list.appendChild(lHint);

        rows.forEach((r, idx) => {
            const m = this._mark(r);
            const row = document.createElement('button'); row.type = 'button'; row.className = 'gov-ctrl' + (firstView ? ' gov-animate' : '');
            row.style.setProperty('--rail', m.color);
            if (firstView) row.style.animationDelay = (idx * 45) + 'ms';
            row.addEventListener('click', () => this._go(r.nav));

            const badge = document.createElement('span'); badge.className = 'gov-badge'; badge.textContent = m.glyph; badge.style.color = m.color; badge.style.background = m.bg; row.appendChild(badge);

            const body = document.createElement('div'); body.className = 'gov-body';
            const labRow = document.createElement('div'); labRow.className = 'gov-labrow';
            const lab = document.createElement('span'); lab.className = 'gov-lab'; lab.textContent = r.label; labRow.appendChild(lab);
            if (r.required) { const req = document.createElement('span'); req.className = 'gov-req'; req.textContent = 'required'; req.title = 'Required for the Strong band — an operational baseline, not a legal obligation.'; labRow.appendChild(req); }
            body.appendChild(labRow);
            const dsc = document.createElement('div'); dsc.className = 'gov-note'; dsc.textContent = r.note; body.appendChild(dsc);
            if (r.extra) { const ex = document.createElement('div'); ex.className = 'gov-extra'; ex.textContent = r.extra; body.appendChild(ex); }
            const fw = document.createElement('div'); fw.className = 'gov-fw'; fw.textContent = r.fw; body.appendChild(fw);
            row.appendChild(body);

            const chip = document.createElement('span'); chip.className = 'gov-chip'; chip.textContent = m.label; chip.style.color = m.color; chip.style.background = m.bg; row.appendChild(chip);
            const chev = document.createElement('span'); chev.className = 'gov-chev'; chev.textContent = '›'; row.appendChild(chev);
            list.appendChild(row);

            // Threat blocking: only the OpenClaw proxy needs Block Mode. Direct
            // in-app link to set that proxy up (sibling, not nested in the button).
            if (r.key === 'block') {
                const setup = document.createElement('div');
                setup.style.cssText = 'padding: 0 12px 12px 64px; font-size: 11.5px; color: var(--text-muted, #7d8590);';
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
        mBody.textContent = 'Each control is assessed from a live signal and against what is currently active — e.g. threat blocking is “native” when your hook / SDK / MCP integration blocks tool calls itself.';
        meta.appendChild(mBody);
        const fwBody = document.createElement('p'); fwBody.style.cssText = 'margin: 0 0 10px; font-size: 12px; color: var(--text-secondary); line-height: 1.55;';
        fwBody.textContent = this.FRAMEWORKS;
        meta.appendChild(fwBody);

        const guideRow = document.createElement('div'); guideRow.style.cssText = 'display:flex; gap:16px; flex-wrap:wrap; align-items:center;';
        // Link to the PRIMARY published sources the baseline maps to (the acts /
        // frameworks themselves), not a SecureVector page — each is verifiable
        // orientation, not interpreted legal advice.
        const srcs = [
            ['EU AI Act — official text (EUR-Lex) →', 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj'],
            ['OWASP Top 10 for LLM Apps (2025) →', 'https://genai.owasp.org/resource/owasp-top-10-for-llm-applications-2025/'],
            ['NIST AI Risk Management Framework →', 'https://www.nist.gov/itl/ai-risk-management-framework'],
        ];
        srcs.forEach(function (pair) { const a = document.createElement('a'); a.href = pair[1]; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = pair[0]; a.style.cssText = 'color: var(--accent-primary); font-weight: 600; font-size: 13px; text-decoration: none;'; guideRow.appendChild(a); });
        meta.appendChild(guideRow);
        const disclaimer = document.createElement('div'); disclaimer.textContent = 'Orientation only — not legal advice.'; disclaimer.style.cssText = 'margin-top: 8px; font-size: 11px; color: var(--text-muted, #7d8590);'; meta.appendChild(disclaimer);
        wrap.appendChild(meta);

        // Soft cloud CTA — pinned to the TOP of the page (per request).
        if (!cloudOn) {
            const cta = card(); cta.style.borderColor = 'var(--accent-primary)';
            const cLead = document.createElement('div'); cLead.style.cssText = 'font-size: 13px; color: var(--text-secondary); line-height: 1.5;';
            cLead.innerHTML = 'This is one device. <a href="https://app.securevector.io/governance" target="_blank" rel="noopener noreferrer" style="color:var(--accent-primary); font-weight:600;">See posture across your whole fleet →</a> by connecting to SecureVector Cloud.';
            cta.appendChild(cLead);
            const cMicro = document.createElement('div');
            cMicro.textContent = (settings.local_only_analysis !== false && settings.residency_locked)
                ? 'EU data-residency is enforced: prompt analysis stays on-device and cannot be sent to the cloud.'
                : 'Connecting syncs rules, policies, and fleet metadata (and enables org MCP policy). Your prompts stay on-device by default.';
            cMicro.style.cssText = 'margin-top: 4px; font-size: 11.5px; color: var(--text-muted, #7d8590);';
            cta.appendChild(cMicro);
            wrap.insertBefore(cta, wrap.firstChild);
        }

        container.appendChild(wrap);

        if (firstView) { try { sessionStorage.setItem('sv-governance-flashed', '1'); } catch (e) {} }
    },
};

window.GovernancePage = GovernancePage;
