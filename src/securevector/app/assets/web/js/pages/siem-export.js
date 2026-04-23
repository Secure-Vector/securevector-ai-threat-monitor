/**
 * SIEM Forwarder page — top-level Configure item.
 *
 * Promoted out of Settings so users discover it as a first-class feature.
 * The page is a thin shell around `SettingsPage.renderSiemForwarders` (the
 * existing CRUD table + editor) plus documentation blocks that explain:
 *   - what actually gets forwarded (metadata only — never prompt text)
 *   - what schema the events use (OCSF 1.3.0)
 *   - which destination kinds are supported and what each one needs to
 *     be configured (URL shape + required auth header)
 *
 * Intentionally delegates the table/editor helpers to SettingsPage so the
 * CRUD code has one home; this page owns the docs + chrome, not the data.
 */

const SiemExportPage = {
    async render(container) {
        container.textContent = '';

        if (window.Header) {
            Header.setPageInfo(
                'SIEM Forwarder',
                'Forward threats and tool-call audits to your SOC. Metadata-only. No signup.',
            );
        }

        // ── "Your data stays yours" reassurance pill ─────────────────
        // A small inline badge right below the page header, making the
        // free + local + no-signup stance obvious at first glance.
        // Sits above every other card so it frames everything below.
        const trustPill = document.createElement('div');
        trustPill.className = 'siem-trust-pill';
        trustPill.style.cssText = 'display:inline-flex;align-items:center;gap:10px;padding:8px 14px;margin-bottom:14px;border:1px solid rgba(16,185,129,0.3);background:rgba(16,185,129,0.08);border-radius:999px;font-size:12.5px;color:var(--text-primary);';
        trustPill.innerHTML = `
            <span aria-hidden="true" style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;color:#10b981;">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </span>
            <span>
                <strong style="color:#10b981;">Your data stays yours.</strong>
                <span style="color:var(--text-secondary);">Free, local, no signup. Events go straight from this machine to your SIEM — never through SecureVector.</span>
            </span>
        `;
        container.appendChild(trustPill);

        // ── Shared-env RBAC note ──────────────────────────────────────
        // The local app's API binds to 127.0.0.1 and has no per-user
        // access control — anyone on that loopback can change config.
        // That's fine for a personal laptop, NOT fine for a shared
        // dev/jump host. Point those users at the cloud app, which has
        // the RBAC surface. Small inline note (not a blocker).
        const rbacNote = document.createElement('div');
        rbacNote.className = 'siem-rbac-note';
        rbacNote.style.cssText = 'display:flex;align-items:flex-start;gap:10px;padding:10px 14px;margin-bottom:14px;border:1px solid var(--border-default);background:var(--bg-tertiary);border-radius:8px;font-size:12px;color:var(--text-secondary);line-height:1.55;';
        rbacNote.innerHTML = `
            <span aria-hidden="true" style="color:var(--text-muted);font-weight:700;flex-shrink:0;">i</span>
            <span>
                <strong style="color:var(--text-primary);">Shared machine?</strong>
                This local app is designed for a single operator — the API on <code>127.0.0.1</code> has no per-user access control. If multiple people share this host and you need RBAC, use the
                <a href="https://app.securevector.io" target="_blank" rel="noopener" style="color:var(--accent-primary);text-decoration:underline;">SecureVector Cloud app</a>,
                which supports teams, roles, and audit of who changed what.
            </span>
        `;
        container.appendChild(rbacNote);

        // ── Global kill-switch (v24) ──────────────────────────────────
        // Single toggle that turns ALL forwarding off at the enqueue
        // boundary. Default ON, but no events flow until a destination
        // is configured (see "Your destinations" below). Flipping OFF
        // stops new events from landing in the outbox; already-queued
        // rows still drain to completion.
        const globalCard = document.createElement('div');
        globalCard.className = 'siem-global-switch';
        globalCard.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:20px;padding:16px 20px;margin-bottom:16px;border:1px solid var(--border-default);border-left:4px solid var(--accent-primary);border-radius:10px;background:var(--bg-card);';
        globalCard.innerHTML = `
            <div style="flex:1;min-width:0;">
                <div style="font-size:14px;font-weight:700;color:var(--text-primary);margin-bottom:4px;">
                    SIEM Forwarder
                </div>
                <div id="siem-global-status-line" style="font-size:12.5px;color:var(--text-secondary);line-height:1.45;">
                    Loading…
                </div>
            </div>
            <label class="siem-global-toggle" style="position:relative;display:inline-flex;align-items:center;gap:10px;cursor:pointer;user-select:none;flex-shrink:0;">
                <span id="siem-global-label" style="font-size:13px;font-weight:700;color:var(--text-primary);min-width:32px;text-align:right;">—</span>
                <span style="position:relative;display:inline-block;width:44px;height:24px;">
                    <input id="siem-global-checkbox" type="checkbox" style="opacity:0;width:0;height:0;">
                    <span id="siem-global-track" style="position:absolute;inset:0;background:var(--bg-tertiary);border:1px solid var(--border-default);border-radius:999px;transition:background 0.15s;"></span>
                    <span id="siem-global-knob" style="position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--text-secondary);transition:transform 0.15s,background 0.15s;"></span>
                </span>
            </label>
        `;
        container.appendChild(globalCard);

        const checkbox = globalCard.querySelector('#siem-global-checkbox');
        const labelEl = globalCard.querySelector('#siem-global-label');
        const track = globalCard.querySelector('#siem-global-track');
        const knob = globalCard.querySelector('#siem-global-knob');
        const statusLine = globalCard.querySelector('#siem-global-status-line');

        const paintToggle = (enabled) => {
            checkbox.checked = !!enabled;
            labelEl.textContent = enabled ? 'ON' : 'OFF';
            track.style.background = enabled ? 'var(--accent-primary)' : 'var(--bg-tertiary)';
            knob.style.transform = enabled ? 'translateX(20px)' : 'translateX(0)';
            knob.style.background = enabled ? '#0b1117' : 'var(--text-secondary)';
            statusLine.innerHTML = enabled
                ? 'Forwarding is <strong style="color:var(--accent-primary);">enabled</strong>. New events flow to every configured destination. No destinations? Add one below — events start flowing automatically once you do.'
                : 'Forwarding is <strong style="color:#ef4444;">paused</strong>. New scans and tool-call audits will NOT be enqueued. Already-queued events still drain. Re-enable any time.';
        };

        // Fetch current state + wire the toggle
        paintToggle(true); // optimistic default until server responds
        API.getSiemGlobalSettings().then(s => paintToggle(!!(s && s.enabled))).catch(() => paintToggle(true));

        let saving = false;
        checkbox.addEventListener('change', async (e) => {
            if (saving) return;
            const desired = !!e.target.checked;
            saving = true;
            paintToggle(desired);
            try {
                const resp = await API.setSiemGlobalSettings(desired);
                paintToggle(!!(resp && resp.enabled));
            } catch (_) {
                // revert on failure
                paintToggle(!desired);
            } finally {
                saving = false;
            }
        });

        // ── Intro card ───────────────────────────────────────────────
        // High-level pitch + privacy contract. Rendered as a gradient
        // card so it reads as the page's "what is this" banner.
        const intro = Card.create({ gradient: true });
        const introBody = intro.querySelector('.card-body');
        introBody.innerHTML = `
            <div>
                <div style="font-size:15px;font-weight:700;color:var(--text-primary);margin-bottom:6px;">
                    Forward security events to your SIEM — free, open-source, metadata-only by default.
                </div>
                <div style="font-size:13px;color:var(--text-secondary);line-height:1.55;">
                    Configure one or more destinations below. Every threat scan and tool-call audit row is
                    forwarded in OCSF 1.3.0 format. <strong style="color:var(--text-primary);">Prompts,
                    LLM outputs, and matched patterns never leave this machine</strong> at the default
                    redaction tier — only verdicts, counts, and the tamper-evident hash-chain witness
                    travel to your SOC.
                </div>
            </div>
        `;
        container.appendChild(intro);

        // ── What gets forwarded + format ─────────────────────────────
        const facts = document.createElement('div');
        facts.className = 'siem-facts-grid';
        facts.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin:18px 0;';

        facts.appendChild(this._factCard({
            emoji: '✓',
            title: 'What gets forwarded',
            body: `
                <ul style="margin:6px 0 0;padding-left:18px;line-height:1.7;">
                    <li><strong>Threat scans</strong> — verdict, threat_score, risk_level, detected_types, duration, model_id</li>
                    <li><strong>Tool-call audits</strong> — tool_id, action (allow/block), seq, prev_hash, row_hash, risk</li>
                    <li><strong>Attribution</strong> — stable <code>device_id</code> on every event</li>
                </ul>
            `,
        }));

        facts.appendChild(this._factCard({
            emoji: '⊘',
            title: 'What never leaves the box',
            body: `
                <ul style="margin:6px 0 0;padding-left:18px;line-height:1.7;">
                    <li>Prompt text, chat history, LLM response bodies</li>
                    <li>Matched pattern strings, reviewer reasoning, ML reasoning</li>
                    <li>Tool-call argument values (only a truncated preview, if you enable it)</li>
                    <li><strong>Cost / billing data</strong> — stays strictly local; not in any outbound event</li>
                </ul>
            `,
        }));

        facts.appendChild(this._factCard({
            emoji: '⧉',
            title: 'Event schema',
            body: `
                <div style="line-height:1.65;">
                    <div><strong>OCSF 1.3.0</strong> — the Open Cybersecurity Schema Framework adopted by AWS Security Lake, Splunk, Palo Alto, and CrowdStrike.</div>
                    <div style="margin-top:8px;">
                        Scans emit class <code>2001</code> (Security Finding).
                        Tool-call audits emit class <code>1007</code> (Process Activity), with the
                        SHA-256 hash chain in <code>unmapped</code> so your SIEM can re-verify integrity off-host.
                    </div>
                    <div style="margin-top:8px;"><strong>All timestamps are UTC</strong> (<code>time</code> = Unix epoch milliseconds). Dashboards render in the viewer's local zone; raw events never are.</div>
                    <div style="margin-top:6px;">Schema revision <code>securevector:4.0</code> in <code>metadata.extension</code> — bump on breaking change.</div>
                </div>
            `,
        }));

        container.appendChild(facts);

        // ── Supported destinations + required config ─────────────────
        const destTitle = document.createElement('div');
        destTitle.style.cssText = 'font-size:13px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.6px;margin:6px 0 10px;';
        destTitle.textContent = 'Supported destinations';
        container.appendChild(destTitle);

        const destTable = document.createElement('div');
        destTable.style.cssText = 'border:1px solid var(--border-default);border-radius:8px;overflow:hidden;margin-bottom:12px;';
        destTable.innerHTML = `
            <table style="width:100%;border-collapse:collapse;font-size:13px;">
                <thead>
                    <tr style="background:var(--bg-tertiary);">
                        <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;font-size:11px;letter-spacing:0.6px;">Destination</th>
                        <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;font-size:11px;letter-spacing:0.6px;">URL shape</th>
                        <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;font-size:11px;letter-spacing:0.6px;">Required auth</th>
                        <th style="text-align:left;padding:10px 12px;font-weight:600;color:var(--text-muted);text-transform:uppercase;font-size:11px;letter-spacing:0.6px;">Status</th>
                    </tr>
                </thead>
                <tbody>
                    <tr style="border-top:1px solid var(--border-default);">
                        <td style="padding:10px 12px;"><strong>Splunk HEC</strong></td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:12px;">https://&lt;host&gt;/services/collector/event</td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:12px;">Authorization: Splunk &lt;HEC-token&gt;</td>
                        <td style="padding:10px 12px;"><span style="background:rgba(16,185,129,0.18);color:#10b981;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;">NATIVE</span></td>
                    </tr>
                    <tr style="border-top:1px solid var(--border-default);">
                        <td style="padding:10px 12px;"><strong>Datadog Logs</strong></td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:12px;">https://http-intake.logs.&lt;site&gt;/api/v2/logs</td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:12px;">DD-API-KEY: &lt;key&gt;</td>
                        <td style="padding:10px 12px;"><span style="background:rgba(16,185,129,0.18);color:#10b981;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;">NATIVE</span></td>
                    </tr>
                    <tr style="border-top:1px solid var(--border-default);">
                        <td style="padding:10px 12px;"><strong>OTLP / HTTP</strong><br><span style="color:var(--text-muted);font-size:11px;">Any OpenTelemetry collector</span></td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:12px;">https://&lt;collector&gt;/v1/logs</td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:12px;">optional: Authorization: Bearer &lt;token&gt;</td>
                        <td style="padding:10px 12px;"><span style="background:rgba(16,185,129,0.18);color:#10b981;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;">NATIVE</span></td>
                    </tr>
                    <tr style="border-top:1px solid var(--border-default);">
                        <td style="padding:10px 12px;"><strong>Generic Webhook</strong><br><span style="color:var(--text-muted);font-size:11px;">Lambda · Cloudflare · Tines · n8n · custom</span></td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:12px;">any HTTPS endpoint that accepts JSON POST</td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:12px;">optional: Authorization: Bearer &lt;token&gt;</td>
                        <td style="padding:10px 12px;"><span style="background:rgba(16,185,129,0.18);color:#10b981;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;">NATIVE</span></td>
                    </tr>
                    <tr style="border-top:1px solid var(--border-default);">
                        <td style="padding:10px 12px;"><strong>IBM QRadar</strong><br><span style="color:var(--text-muted);font-size:11px;">Generic HTTP Events API</span></td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:12px;">https://&lt;qradar-host&gt;/api/siem/events</td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:12px;">SEC: &lt;api-token&gt; · via webhook</td>
                        <td style="padding:10px 12px;"><span style="background:rgba(99,102,241,0.18);color:#818cf8;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;">VIA WEBHOOK</span></td>
                    </tr>
                    <tr style="border-top:1px solid var(--border-default);">
                        <td style="padding:10px 12px;"><strong>Microsoft Sentinel</strong><br><span style="color:var(--text-muted);font-size:11px;">Log Analytics / DCR endpoint</span></td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:12px;">https://&lt;dce&gt;.ingest.monitor.azure.com/dataCollectionRules/&lt;id&gt;/streams/Custom-SecureVector</td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:12px;">Authorization: Bearer &lt;AAD-token&gt; · via webhook</td>
                        <td style="padding:10px 12px;"><span style="background:rgba(99,102,241,0.18);color:#818cf8;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;">VIA WEBHOOK</span></td>
                    </tr>
                    <tr style="border-top:1px solid var(--border-default);">
                        <td style="padding:10px 12px;"><strong>Google Chronicle SIEM</strong><br><span style="color:var(--text-muted);font-size:11px;">UDM batchCreate</span></td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:12px;">https://malachiteingestion-pa.googleapis.com/v2/udmevents:batchCreate</td>
                        <td style="padding:10px 12px;font-family:monospace;font-size:12px;">Authorization: Bearer &lt;GCP-token&gt; · via webhook</td>
                        <td style="padding:10px 12px;"><span style="background:rgba(99,102,241,0.18);color:#818cf8;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;">VIA WEBHOOK</span></td>
                    </tr>
                </tbody>
            </table>
        `;
        container.appendChild(destTable);

        // Helper note clarifying the "via webhook" row semantics so the
        // user isn't surprised when they go to configure QRadar/Sentinel/
        // Chronicle and see the Webhook kind dropdown.
        const viaWebhookNote = document.createElement('div');
        viaWebhookNote.style.cssText = 'font-size:12px;color:var(--text-muted);margin-bottom:24px;line-height:1.55;';
        viaWebhookNote.innerHTML = `
            <strong>Note on &quot;via webhook&quot;:</strong>
            QRadar, Sentinel, and Chronicle all accept JSON over HTTPS with a bearer-style auth header — exactly the shape the Generic Webhook kind already sends. Configure one by choosing <em>Webhook</em> as the kind, pasting the endpoint URL, and providing the appropriate token. Native one-click adapters for these vendors are on the roadmap.
        `;
        container.appendChild(viaWebhookNote);

        // ── Example event payloads ──────────────────────────────────
        // Concrete OCSF events — one Security Finding (class 2001) from
        // a prompt-injection scan, one Process Activity (class 1007)
        // from a blocked tool call. Shown as JSON so an ops engineer can
        // paste into their SIEM's search to sanity-check field paths.
        const exTitle = document.createElement('div');
        exTitle.style.cssText = 'font-size:13px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.6px;margin:6px 0 10px;';
        exTitle.textContent = 'Example event payloads';
        container.appendChild(exTitle);

        const exGrid = document.createElement('div');
        exGrid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:14px;margin-bottom:28px;';

        const scanExample = {
            metadata: {
                version: '1.3.0',
                product: { name: 'SecureVector Local Threat Monitor', vendor_name: 'SecureVector' },
                log_name: 'securevector-local-scan',
            },
            category_uid: 2,
            class_uid: 2001,
            class_name: 'Security Finding',
            activity_id: 1,
            severity_id: 5,
            severity: 'BLOCK',
            time: 1745352300000,
            finding: {
                uid: '0e5325f1-37d7-49e4-a1c0-23254038781a',
                title: 'BLOCK: Prompt Injection',
                types: ['prompt_injection'],
            },
            observables: [
                { type_id: 0, name: 'verdict', value: 'BLOCK' },
                { type_id: 0, name: 'risk_level', value: 'critical' },
            ],
            raw_data: null,
            unmapped: {
                threat_score: 0.9,
                confidence_score: 0.008,
                detected_items_count: 2,
                detected_types: ['prompt_injection'],
                ml_status: 'skipped',
                scan_duration_ms: 12.4,
                model_id: 'gpt-4o',
                conversation_id: 'sess-demo-1',
                device_id: 'sv-89ec5d06412c3e674073b860',
            },
        };

        const auditExample = {
            metadata: {
                version: '1.3.0',
                product: { name: 'SecureVector Local Threat Monitor', vendor_name: 'SecureVector' },
                log_name: 'securevector-local-scan',
            },
            category_uid: 1,
            class_uid: 1007,
            class_name: 'Process Activity',
            activity_id: 1,
            severity_id: 4,
            time: 1745352300500,
            process: { name: 'send', uid: 'Gmail.send' },
            raw_data: null,
            unmapped: {
                audit_id: 17,
                action: 'block',
                risk: 'high',
                is_essential: false,
                seq: 17,
                prev_hash: '4e9a2b1d7c3f5a8e1b4c7d9f2a6e3c8b5d1f7a0e9c3b6d2f4a8e5c1b9d7f3a6e',
                row_hash: 'a7c3e9f1b5d2a8e4c6b9f1d3a7e5c8b2d4f6a1e9c3b7d5f2a8e6c4b1d9f3a5e7',
                device_id: 'sv-89ec5d06412c3e674073b860',
            },
        };

        exGrid.appendChild(this._eventCard({
            title: 'Threat scan (OCSF class 2001 — Security Finding)',
            body: 'Emitted whenever /analyze produces a verdict ≠ ALLOW (or everything if event_filter=all).',
            payload: scanExample,
        }));
        exGrid.appendChild(this._eventCard({
            title: 'Tool-call audit (OCSF class 1007 — Process Activity)',
            body: 'Emitted on every tool-call audit row. Hash-chain witness (prev_hash + row_hash) in unmapped lets your SIEM re-verify integrity off-host.',
            payload: auditExample,
        }));

        container.appendChild(exGrid);

        // ── Destinations table (CRUD lives on SettingsPage) ──────────
        // Keeping the data helpers on SettingsPage avoids duplicating a
        // few hundred lines of editor code; this page just hands them a
        // container and lets them render into it.
        const manageTitle = document.createElement('div');
        manageTitle.style.cssText = 'font-size:13px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.6px;margin:6px 0 10px;';
        manageTitle.textContent = 'Your destinations';
        container.appendChild(manageTitle);

        const forwardersCard = Card.create({ gradient: true });
        const forwardersBody = forwardersCard.querySelector('.card-body');
        container.appendChild(forwardersCard);

        if (window.SettingsPage && typeof SettingsPage.renderSiemForwarders === 'function') {
            await SettingsPage.renderSiemForwarders.call(SettingsPage, forwardersBody);
        } else {
            forwardersBody.textContent = 'SIEM forwarders module not loaded.';
        }
    },

    _factCard({ emoji, title, body }) {
        const card = document.createElement('div');
        card.className = 'siem-fact-card';
        card.style.cssText = 'background:var(--bg-card);border:1px solid var(--border-default);border-radius:10px;padding:14px 16px;';
        card.innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
                <span style="font-size:18px;line-height:1;color:var(--accent-primary);">${emoji}</span>
                <span style="font-size:13px;font-weight:700;color:var(--text-primary);text-transform:uppercase;letter-spacing:0.5px;">${title}</span>
            </div>
            <div style="font-size:13px;color:var(--text-secondary);">${body}</div>
        `;
        return card;
    },

    _eventCard({ title, body, payload }) {
        const card = document.createElement('div');
        card.style.cssText = 'background:var(--bg-card);border:1px solid var(--border-default);border-radius:10px;overflow:hidden;display:flex;flex-direction:column;';

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border-bottom:1px solid var(--border-default);';
        const titleWrap = document.createElement('div');
        titleWrap.style.cssText = 'flex:1;min-width:0;';
        titleWrap.innerHTML = `
            <div style="font-size:13px;font-weight:700;color:var(--text-primary);">${title}</div>
            <div style="font-size:11.5px;color:var(--text-muted);margin-top:2px;line-height:1.4;">${body}</div>
        `;
        header.appendChild(titleWrap);

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'btn btn-secondary btn-compact';
        copyBtn.textContent = 'Copy JSON';
        copyBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
                const prev = copyBtn.textContent;
                copyBtn.textContent = '✓ Copied';
                setTimeout(() => { copyBtn.textContent = prev; }, 1400);
            } catch (_) { /* ignore */ }
        });
        header.appendChild(copyBtn);
        card.appendChild(header);

        const pre = document.createElement('pre');
        pre.style.cssText = 'margin:0;padding:12px 14px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.5;color:var(--accent-primary);background:var(--bg-tertiary);overflow:auto;max-height:320px;white-space:pre;word-break:normal;';
        pre.textContent = JSON.stringify(payload, null, 2);
        card.appendChild(pre);

        return card;
    },
};

// Expose globally so app.js can route to it
if (typeof window !== 'undefined') {
    window.SiemExportPage = SiemExportPage;
}
