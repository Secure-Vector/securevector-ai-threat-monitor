/**
 * Instant Agent Audit — conversion-ux download hook (v5.0.0).
 *
 * "Find out what your agents already did." Opt-in retroactive scan of the
 * agent transcripts already on this machine (Claude Code, Codex) — no plugin,
 * no config, nothing leaves the device. Three states:
 *   1. consent — explains exactly what will be read, waits for the click;
 *   2. scanning — live progress while the backend walks the transcripts;
 *   3. report — secrets / destructive commands / MCP flows / spend, with the
 *      "keep watching from now on" CTA into Connect Agents (funnel step 2).
 *
 * SOC colour discipline: red = threats/risky, amber = secrets, teal = the one
 * interactive accent; spend and structure stay neutral.
 */

const InstantAuditPage = {
    _state: { windowDays: 90, polling: null },

    async render(container) {
        container.textContent = '';
        if (window.Header) {
            Header.setPageInfo('Instant Audit',
                'What your agents already did, scanned from the transcripts on this machine. Nothing leaves it.');
        }
        this._injectStyle();
        const body = document.createElement('div');
        body.id = 'ia-body';
        body.innerHTML = '<div class="ia-empty">Loading…</div>';
        container.appendChild(body);
        await this.refresh();
    },

    _stopPoll() {
        if (this._state.polling) { clearInterval(this._state.polling); this._state.polling = null; }
    },

    async refresh() {
        const body = document.getElementById('ia-body');
        if (!body) { this._stopPoll(); return; }
        const st = await API.getInstantAuditStatus();
        if (!st) { body.innerHTML = '<div class="ia-empty">Audit status unavailable.</div>'; return; }
        if (st.running) { this._renderScanning(body, st); this._startPoll(); return; }
        this._stopPoll();
        if (st.has_report) {
            const rep = await API.getInstantAuditReport();
            if (rep) { this._renderReport(body, rep); return; }
        }
        this._renderConsent(body, st);
    },

    _startPoll() {
        if (this._state.polling) return;
        this._state.polling = setInterval(() => {
            // Self-teardown when the page unmounts.
            if (!document.getElementById('ia-body') || (window.App && App.currentPage !== 'instant-audit')) {
                this._stopPoll();
                return;
            }
            this.refresh();
        }, 900);
    },

    // ---------------- state 1: consent ----------------

    _renderConsent(body, st) {
        const failed = st.progress && st.progress.phase === 'error';
        body.innerHTML = `
            <div class="ia-hero">
                <div class="ia-hero-eyebrow">Runs entirely on this machine</div>
                <h2 class="ia-hero-h">Find out what your agents already did.</h2>
                <p class="ia-hero-p">Your coding agents have been writing transcripts to this machine all along
                   (<code>~/.claude</code>, <code>~/.codex</code>). SecureVector can audit that history right now:
                   no plugin, no account, nothing forwarded anywhere.</p>
                <div class="ia-points">
                    <div class="ia-point"><span class="ia-pt-dot" style="background:#f59e0b"></span>
                        <b>Secrets in plaintext</b><span>API keys, tokens and credentials that appeared in past sessions</span></div>
                    <div class="ia-point"><span class="ia-pt-dot" style="background:#ef4444"></span>
                        <b>Destructive commands that ran</b><span>a small deterministic checklist: recursive deletes, pipe-to-shell, force-pushes. No heuristics, no ML.</span></div>
                    <div class="ia-point"><span class="ia-pt-dot" style="background:#8b949e"></span>
                        <b>External MCP data flows</b><span>which MCP servers your sessions actually talked to</span></div>
                    <div class="ia-point"><span class="ia-pt-dot" style="background:#8b949e"></span>
                        <b>LLM usage value</b><span>list-price equivalent per model and harness</span></div>
                </div>
                <div class="ia-consent">
                    <div class="ia-consent-t">Before scanning, know exactly what happens:</div>
                    <ul>
                        <li>Reads Claude Code and Codex transcript files on this machine, read-only.</li>
                        <li>Detected secrets are <b>never stored</b>; only their type and count.</li>
                        <li>The report is one local file; you can delete it here at any time.</li>
                        <li>Nothing is uploaded. This works with the network unplugged.</li>
                    </ul>
                </div>
                <div class="ia-actions">
                    <span class="ia-winlabel">History window</span>
                    ${[30, 90, 365].map(d => `<button type="button" class="ia-winbtn${this._state.windowDays === d ? ' on' : ''}" data-days="${d}">${d === 365 ? '1 year' : d + ' days'}</button>`).join('')}
                    <button type="button" class="ia-go" id="ia-go">Scan my agent history</button>
                </div>
                ${failed ? `<div class="ia-err">The last scan failed: ${this._esc(st.progress.error || 'unknown error')}. You can retry.</div>` : ''}
            </div>`;
        body.querySelectorAll('.ia-winbtn').forEach(b => b.addEventListener('click', () => {
            this._state.windowDays = Number(b.dataset.days);
            body.querySelectorAll('.ia-winbtn').forEach(x => x.classList.toggle('on', x === b));
        }));
        body.querySelector('#ia-go').addEventListener('click', async () => {
            const res = await API.runInstantAudit({ consent: true, window_days: this._state.windowDays });
            if (!res || res.error) { if (window.Toast) Toast.error('Could not start the scan.'); return; }
            this.refresh();
        });
    },

    // ---------------- state 2: scanning ----------------

    _renderScanning(body, st) {
        const p = st.progress || {};
        const total = p.total || 0;
        const done = Math.min(p.done || 0, total);
        const pct = total ? Math.round(done / total * 100) : 0;
        body.innerHTML = `
            <div class="ia-hero">
                <div class="ia-hero-eyebrow">Scanning locally</div>
                <h2 class="ia-hero-h">Auditing your agent history…</h2>
                <p class="ia-hero-p">${total ? `${done} of ${total} sessions` : 'Discovering transcripts…'}</p>
                <div class="ia-bar"><div class="ia-bar-fill" style="width:${pct}%"></div></div>
            </div>`;
    },

    // ---------------- state 3: report ----------------

    _renderReport(body, rep) {
        const s = rep.secrets || {}; const r = rep.risky || {};
        const mcp = rep.mcp || {}; const sp = rep.spend || {};
        const scanned = rep.scanned || {};
        const sessions = scanned.sessions || {};
        const sesSummary = Object.entries(sessions).map(([k, n]) => `${n} ${k}`).join(' · ')
            || `${scanned.sessions_total || 0} sessions`;
        const period = rep.period || {};
        const fmtD = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
        const usd = (v) => '$' + (v || 0).toFixed(v >= 100 ? 0 : 2);
        body.innerHTML = `
            <div class="ia-rephead">
                <span class="ia-hero-eyebrow">Audit of ${sesSummary} · ${fmtD(period.first)} → ${fmtD(period.last)}</span>
                <span class="ia-repmeta">generated ${this._esc(rep.generated_at || '')} · ${(rep.duration_ms / 1000).toFixed(1)}s · local only</span>
            </div>
            <div class="ia-stats">
                <div class="ia-stat${r.total ? ' danger' : ''}"><div class="ia-stat-v">${r.total || 0}</div>
                    <div class="ia-stat-l">Destructive commands ran</div><div class="ia-stat-d">${r.sessions_affected || 0} session${r.sessions_affected === 1 ? '' : 's'} affected</div></div>
                <div class="ia-stat${s.total ? ' warn' : ''}"><div class="ia-stat-v">${s.total || 0}</div>
                    <div class="ia-stat-l">Secrets in plaintext</div><div class="ia-stat-d">${s.sessions_affected || 0} session${s.sessions_affected === 1 ? '' : 's'} affected</div></div>
                <div class="ia-stat"><div class="ia-stat-v">${(mcp.servers || []).length}</div>
                    <div class="ia-stat-l">External MCP servers</div><div class="ia-stat-d">${mcp.external_calls_total || 0} calls</div></div>
                <div class="ia-stat" title="Same pricing pipeline as the Dashboard's spend-today estimate (token counts x API list prices). The Dashboard shows today; this covers the full audit window."><div class="ia-stat-v">≈${usd(sp.total_usd)}</div>
                    <div class="ia-stat-l">LLM usage · est.</div><div class="ia-stat-d">${sp.llm_runs || 0} runs · last ${rep.window_days || 90} days · list price</div></div>
            </div>
            ${this._riskySection(r)}
            ${this._secretsSection(s)}
            ${this._mcpSection(mcp)}
            ${this._spendSection(sp)}
            ${scanned.truncated ? `<div class="ia-trunc">Coverage note: scan caps were reached (per-harness session cap ${scanned.caps ? scanned.caps.sessions_per_harness : ''}, ${scanned.caps ? scanned.caps.chars_per_session : ''} chars secret-scanned per session). The numbers above are a floor, not a ceiling.</div>` : ''}
            <div class="ia-cta">
                <div><b>This was the past. Watch what happens next.</b>
                <span>Connect your agents and every future session is enforced and audited live: blocked actions, redacted secrets, full traces.</span>
                <span class="ia-after" id="ia-after" hidden></span></div>
                <button type="button" class="ia-go" id="ia-connect">Connect agents →</button>
            </div>
            <div class="ia-foot">
                <button type="button" class="ia-lite" id="ia-export">Export JSON</button>
                <button type="button" class="ia-lite" id="ia-rescan">Rescan</button>
                <button type="button" class="ia-lite danger" id="ia-delete">Delete report</button>
            </div>`;
        body.querySelector('#ia-connect').addEventListener('click', () => {
            try { if (window.Sidebar && Sidebar.navigate) Sidebar.navigate('guide-connect-agents'); else if (window.App && App.loadPage) App.loadPage('guide-connect-agents'); } catch (e) { /* nav best-effort */ }
        });
        // The "after" story — if live enforcement has already blocked actions
        // since install, say so right where the past-vs-future contrast lands.
        API.getBlockedLedger({ window_days: 90 }).then(led => {  // route caps le=90
            const n = led && led.summary && led.summary.blocked_total;
            const el = body.querySelector('#ia-after');
            if (!n || !el) return;
            el.hidden = false;
            el.innerHTML = `SecureVector has since blocked <b>${n}</b> action${n === 1 ? '' : 's'} live. <a href="#" id="ia-blocked-link">see Blocked Actions</a>.`;
            const a = el.querySelector('#ia-blocked-link');
            if (a) a.addEventListener('click', (e) => {
                e.preventDefault();
                try { if (window.Sidebar && Sidebar.navigate) Sidebar.navigate('blocked-ledger'); } catch (err) { /* nav best-effort */ }
            });
        }).catch(() => { /* live ledger unavailable — omit the line */ });
        body.querySelector('#ia-export').addEventListener('click', () => {
            // The report is already the exportable artifact: one local JSON
            // file, secrets never included. Download it as-is.
            const stamp = (rep.generated_at || '').slice(0, 10).replace(/-/g, '') || 'report';
            const blob = new Blob([JSON.stringify(rep, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `securevector-instant-audit-${stamp}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        });
        // Session links in the destructive table: resolve session -> trace via
        // the Traces API; sessions that predate enforcement have no trace.
        body.addEventListener('click', async (e) => {
            const link = e.target && e.target.closest ? e.target.closest('.ia-sess') : null;
            if (!link) return;
            e.preventDefault();
            const sid = link.dataset.sid;
            const res = await API.getTraces({ window_days: 365, limit: 500 });
            const run = (res.runs || []).find(x => x.session_id === sid);
            if (run && window.AgentRunsPage) {
                AgentRunsPage._pendingTrace = run.trace_id;
                if (window.Sidebar && Sidebar.navigate) Sidebar.navigate('agent-runs');
            } else if (window.Toast) {
                Toast.info('No trace for this session: it ran before SecureVector enforcement was connected.');
            }
        });
        body.querySelector('#ia-rescan').addEventListener('click', async () => {
            const res = await API.runInstantAudit({ consent: true, window_days: this._state.windowDays });
            if (res && !res.error) this.refresh();
        });
        body.querySelector('#ia-delete').addEventListener('click', async () => {
            await API.deleteInstantAuditReport();
            if (window.Toast) Toast.success('Report deleted. Nothing of the scan remains.');
            this.refresh();
        });
    },

    _riskySection(r) {
        // v2 reports come from a deterministic checklist (no rules engine, no
        // ML — heuristics FP too much for a first-touch report). Old v1 items
        // carried rule_id instead of label; fall back so a stale report still
        // renders until the user rescans.
        const method = `Deterministic checklist${r.patterns ? ` of ${r.patterns} destructive patterns` : ''}, no heuristics, no ML. Only commands executed by shell tools are checked; file contents are never flagged.`;
        if (!r.total) {
            return `<div class="ia-sec"><div class="ia-sec-h">Destructive commands</div>
                <div class="ia-ok">No destructive commands in the scanned window.</div>
                <div class="ia-note">${method}</div></div>`;
        }
        const rows = (r.items || []).map(i => `
            <tr><td><span class="ia-sev ia-sev-${this._esc(i.severity)}"></span>${this._esc(i.severity)}</td>
                <td>${this._esc(i.label || i.rule_id || i.threat_type || 'finding')}</td>
                <td class="ia-mono">${this._esc(i.tool || '')}</td>
                <td class="ia-prev">${this._esc(i.preview || '')}</td>
                <td>${i.session_id ? `<a href="#" class="ia-sess ia-mono" data-sid="${this._esc(i.session_id)}" title="session ${this._esc(i.session_id)} (${this._esc(i.harness || '')}). Opens its trace if this session was enforced.">${this._esc(String(i.session_id).slice(0, 8))}</a>` : ''}</td>
                <td class="ia-when">${this._esc((i.called_at || '').slice(0, 10))}</td></tr>`).join('');
        const capped = r.total > (r.items || []).length
            ? `<div class="ia-note">${(r.items || []).length} shown of ${r.total}, most severe first.</div>` : '';
        return `<div class="ia-sec"><div class="ia-sec-h" style="color:#ef4444">Destructive commands that actually ran</div>
            <div class="ia-tblwrap"><table class="ia-tbl"><thead><tr>
            <th>Severity</th><th>Finding</th><th>Tool</th><th>Command (redacted)</th><th>Session</th><th>When</th>
            </tr></thead><tbody>${rows}</tbody></table></div>${capped}
            <div class="ia-note">${method}</div></div>`;
    },

    _secretsSection(s) {
        if (!s.total) {
            return `<div class="ia-sec"><div class="ia-sec-h">Secrets</div>
                <div class="ia-ok">No plaintext secrets detected in the scanned window.</div></div>`;
        }
        const rows = (s.by_type || []).map(t =>
            `<div class="ia-chip warn"><b>${t.count}</b>&nbsp;${this._esc(t.type)}</div>`).join('');
        return `<div class="ia-sec"><div class="ia-sec-h" style="color:#f59e0b">Secrets that appeared in plaintext</div>
            <div class="ia-chips">${rows}</div>
            <div class="ia-note">Matches are counted by type only. The secrets themselves are never stored by this audit.</div></div>`;
    },

    _mcpSection(mcp) {
        const servers = mcp.servers || [];
        if (!servers.length) {
            return `<div class="ia-sec"><div class="ia-sec-h">External MCP servers</div>
                <div class="ia-ok">No MCP tool calls found in the scanned window.</div></div>`;
        }
        const rows = servers.map(sv => `
            <tr><td class="ia-mono">${this._esc(sv.name)}</td>
                <td class="ia-num">${sv.calls}</td><td class="ia-num">${sv.sessions}</td></tr>`).join('');
        return `<div class="ia-sec"><div class="ia-sec-h">External MCP servers your sessions talked to</div>
            <div class="ia-tblwrap"><table class="ia-tbl"><thead><tr><th>Server</th><th>Calls</th><th>Sessions</th></tr></thead>
            <tbody>${rows}</tbody></table></div></div>`;
    },

    _spendSection(sp) {
        const models = sp.by_model || [];
        if (!models.length) {
            return `<div class="ia-sec"><div class="ia-sec-h">LLM usage</div>
                <div class="ia-ok">No priced LLM runs found${(sp.unpriced_models || []).length ? ' (unpriced models: ' + sp.unpriced_models.map(m => this._esc(m)).join(', ') + ')' : ''}.</div></div>`;
        }
        const rows = models.map(m => `
            <tr><td class="ia-mono">${this._esc(m.model)}</td>
                <td class="ia-num">${m.runs}</td><td class="ia-num">$${m.usd.toFixed(2)}</td></tr>`).join('');
        const unpriced = (sp.unpriced_models || []).length
            ? `<div class="ia-note">Models without a price entry (excluded): ${sp.unpriced_models.map(m => this._esc(m)).join(', ')}.</div>` : '';
        return `<div class="ia-sec"><div class="ia-sec-h">LLM usage over the audit window, list-price equivalent</div>
            <div class="ia-note" style="margin:0 0 8px">An estimate of what this usage would cost at API list prices. On a subscription, this is not billed spend. The Dashboard's spend figure uses the same pricing, windowed to today.</div>
            <div class="ia-tblwrap"><table class="ia-tbl"><thead><tr><th>Model</th><th>Runs</th><th>Est. value</th></tr></thead>
            <tbody>${rows}</tbody></table></div>${unpriced}</div>`;
    },

    _esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g,
            c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },

    _injectStyle() {
        if (document.getElementById('instant-audit-style')) return;
        const st = document.createElement('style');
        st.id = 'instant-audit-style';
        st.textContent = `
            .ia-empty { padding:40px; text-align:center; color:var(--text-muted,#7d8590); }
            .ia-hero { max-width:760px; margin:24px auto; padding:28px 32px; border:1px solid var(--border-default,#30363d);
                border-radius:16px; background:linear-gradient(180deg, var(--bg-card,#161b22), color-mix(in srgb, var(--bg-card,#161b22) 88%, #000)); }
            .ia-hero-eyebrow { font:700 10px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:1.2px; text-transform:uppercase;
                color:var(--accent-primary,#5eadb8); }
            .ia-hero-h { margin:10px 0 8px; font:700 24px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3); }
            .ia-hero-p { margin:0 0 18px; font-size:13.5px; line-height:1.7; color:var(--text-secondary,#b1bac4); }
            .ia-hero-p code { font:600 12px ui-monospace,'JetBrains Mono',Menlo,monospace; color:var(--text-primary,#e6edf3); }
            .ia-points { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:18px; }
            @media (max-width:820px) { .ia-points { grid-template-columns:1fr; } }
            .ia-point { display:grid; grid-template-columns:10px auto; grid-template-rows:auto auto; column-gap:9px; align-items:baseline; }
            .ia-pt-dot { width:8px; height:8px; border-radius:50%; grid-row:1; }
            .ia-point b { font-size:13px; color:var(--text-primary,#e6edf3); }
            .ia-point span:last-child { grid-column:2; font-size:12px; color:var(--text-muted,#7d8590); }
            .ia-consent { border:1px solid var(--border-default,#30363d); border-left:3px solid var(--accent-primary,#5eadb8);
                border-radius:10px; padding:12px 16px; margin-bottom:18px; background:var(--bg-secondary,#0d1117); }
            .ia-consent-t { font:700 11px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.6px; text-transform:uppercase;
                color:var(--text-secondary,#b1bac4); margin-bottom:6px; }
            .ia-consent ul { margin:0; padding-left:18px; font-size:12.5px; line-height:1.9; color:var(--text-secondary,#b1bac4); }
            .ia-actions { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
            .ia-winlabel { font:600 11px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.5px; text-transform:uppercase;
                color:var(--text-muted,#7d8590); }
            .ia-winbtn { cursor:pointer; border:1px solid var(--border-default,#30363d); border-radius:8px; padding:6px 12px;
                background:var(--bg-secondary,#0d1117); color:var(--text-secondary,#b1bac4); font-size:12px; }
            .ia-winbtn.on { border-color:var(--accent-primary,#5eadb8); color:var(--accent-primary,#5eadb8); }
            .ia-go { cursor:pointer; margin-left:auto; border:none; border-radius:10px; padding:10px 20px;
                background:var(--accent-primary,#5eadb8); color:#04191d; font:700 13px 'Avenir Next',Avenir,system-ui,sans-serif;
                transition:filter .12s; }
            .ia-go:hover { filter:brightness(1.1); }
            .ia-err { margin-top:12px; font-size:12.5px; color:#ef4444; }
            .ia-bar { height:8px; border-radius:6px; background:var(--bg-secondary,#0d1117); overflow:hidden;
                border:1px solid var(--border-default,#30363d); }
            .ia-bar-fill { height:100%; background:var(--accent-primary,#5eadb8); transition:width .4s ease; }
            .ia-rephead { display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; margin:4px 0 12px; }
            .ia-repmeta { margin-left:auto; font-size:11px; color:var(--text-muted,#7d8590); }
            .ia-stats { display:flex; flex-wrap:wrap; border:1px solid var(--border-default,#30363d); border-radius:12px;
                overflow:hidden; margin-bottom:18px; background:color-mix(in srgb, var(--bg-primary,#010409) 45%, var(--bg-card,#161b22)); }
            .ia-stat { flex:1 1 auto; min-width:150px; padding:14px 18px 12px; border-right:1px solid var(--border-default,#30363d); }
            .ia-stat:last-child { border-right:0; }
            .ia-stat-v { font:700 22px ui-monospace,'JetBrains Mono',Menlo,monospace; color:var(--text-primary,#e6edf3);
                font-variant-numeric:tabular-nums; }
            .ia-stat-l { margin-top:3px; font:700 9.5px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.9px;
                text-transform:uppercase; color:var(--text-muted,#7d8590); }
            .ia-stat-d { margin-top:2px; font-size:10.5px; color:var(--text-muted,#7d8590); }
            .ia-stat.danger { background:color-mix(in srgb, #ef4444 7%, transparent); }
            .ia-stat.danger .ia-stat-v { color:#ef4444; }
            .ia-stat.warn { background:color-mix(in srgb, #f59e0b 7%, transparent); }
            .ia-stat.warn .ia-stat-v { color:#f59e0b; }
            .ia-sec { margin-bottom:18px; padding:14px 18px; border:1px solid var(--border-default,#30363d); border-radius:12px;
                background:var(--bg-card,#161b22); }
            .ia-sec-h { font:700 13px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3); margin-bottom:10px; }
            .ia-ok { font-size:12.5px; color:var(--text-muted,#7d8590); }
            .ia-tblwrap { overflow-x:auto; }
            .ia-tbl { width:100%; border-collapse:collapse; font-size:12px; }
            .ia-tbl th { text-align:left; font:700 9.5px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:.8px;
                text-transform:uppercase; color:var(--text-muted,#7d8590); padding:4px 10px 6px 0; border-bottom:1px solid var(--border-default,#30363d); }
            .ia-tbl td { padding:6px 10px 6px 0; border-bottom:1px solid color-mix(in srgb, var(--border-default,#30363d) 55%, transparent);
                color:var(--text-secondary,#b1bac4); vertical-align:top; }
            .ia-mono { font:500 11.5px ui-monospace,'JetBrains Mono',Menlo,monospace; color:var(--text-primary,#e6edf3); }
            .ia-num { font-variant-numeric:tabular-nums; }
            .ia-prev { max-width:520px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
                font:500 11.5px ui-monospace,'JetBrains Mono',Menlo,monospace; }
            .ia-when { white-space:nowrap; color:var(--text-muted,#7d8590); }
            .ia-sev { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; background:#8b949e; }
            .ia-sev-critical, .ia-sev-high { background:#ef4444; }
            .ia-sev-medium { background:#f59e0b; }
            .ia-chips { display:flex; flex-wrap:wrap; gap:8px; }
            .ia-chip { display:inline-flex; align-items:center; border-radius:20px; padding:4px 12px; font-size:12px;
                border:1px solid var(--border-default,#30363d); color:var(--text-secondary,#b1bac4); }
            .ia-chip.warn { border-color:rgba(245,158,11,.45); color:#f59e0b; }
            .ia-chip b { font-family:ui-monospace,'JetBrains Mono',Menlo,monospace; }
            .ia-note { margin-top:8px; font-size:11.5px; color:var(--text-muted,#7d8590); }
            .ia-trunc { margin-bottom:18px; padding:10px 14px; border:1px solid var(--border-default,#30363d);
                border-left:3px solid #f59e0b; border-radius:8px; font-size:12px; color:var(--text-secondary,#b1bac4); }
            .ia-cta { display:flex; align-items:center; gap:16px; padding:16px 20px; margin-bottom:14px;
                border:1px solid color-mix(in srgb, var(--accent-primary,#5eadb8) 45%, transparent); border-radius:12px;
                background:color-mix(in srgb, var(--accent-primary,#5eadb8) 7%, transparent); }
            .ia-cta b { display:block; font-size:14px; color:var(--text-primary,#e6edf3); margin-bottom:2px; }
            .ia-cta span { font-size:12.5px; color:var(--text-secondary,#b1bac4); }
            .ia-cta .ia-go { margin-left:auto; flex:0 0 auto; }
            .ia-cta .ia-after { display:block; margin-top:6px; font-size:12.5px; color:var(--text-secondary,#b1bac4); }
            .ia-cta .ia-after b { display:inline; font-size:12.5px; margin:0; }
            .ia-cta .ia-after a { color:var(--accent,#2dd4bf); text-decoration:none; }
            .ia-cta .ia-after a:hover { text-decoration:underline; }
            .ia-sess { color:var(--accent,#2dd4bf); text-decoration:none; font-size:11.5px; }
            .ia-sess:hover { text-decoration:underline; }
            .ia-foot { display:flex; gap:10px; margin-bottom:24px; }
            .ia-lite { cursor:pointer; border:1px solid var(--border-default,#30363d); border-radius:8px; padding:6px 14px;
                background:transparent; color:var(--text-secondary,#b1bac4); font-size:12px; }
            .ia-lite:hover { border-color:var(--accent-primary,#5eadb8); color:var(--text-primary,#e6edf3); }
            .ia-lite.danger:hover { border-color:#ef4444; color:#ef4444; }
        `;
        document.head.appendChild(st);
    },
};

window.InstantAuditPage = InstantAuditPage;
