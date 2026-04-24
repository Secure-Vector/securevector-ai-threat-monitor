/**
 * SIEM Forwarder page — minimal, action-focused surface.
 *
 * This page does ONE thing: lets the operator manage the machine-level
 * forwarding pipe. Global on/off, destinations CRUD, health status.
 *
 * Reference material (OCSF schema, per-tier redaction breakdown, example
 * payloads, supported-destinations table, Splunk/Sentinel dashboards,
 * field reference) lives in the Guide → "SIEM Forwarder" section. Keeping
 * those out of the page's critical path prevents scroll fatigue for the
 * operator who just needs to add a destination or flip the kill-switch.
 *
 * Rationale — SOC analyst posture:
 *   Day 1 ritual: open the page, add destination, test, done.
 *   Day 30 ritual: glance at pending + last error, walk away.
 * Everything else is reference material, which belongs in docs, not on
 * the command surface.
 */

const SiemExportPage = {
    async render(container) {
        container.textContent = '';

        if (window.Header) {
            Header.setPageInfo(
                'SIEM Forwarder',
                'Forward threats and tool calls detected by SecureVector to your SIEM. Local-first. No signup.',
            );
        }

        // ── Unified master card: state + toggle + device id ───────────
        // Previously two separate cards (device-id pin + kill-switch).
        // Merged because they answer the same question — "what is this
        // SIEM forwarder doing on this machine?" Layout: title + toggle
        // on row 1, status line on row 2, device_id + Copy on row 3.
        // Shared-env RBAC callout lives in Guide → SIEM Forwarder.
        const globalCard = document.createElement('div');
        globalCard.className = 'siem-global-switch';
        globalCard.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:12px 14px;margin-bottom:12px;border:1px solid var(--border-default);border-left:4px solid var(--accent-primary);border-radius:10px;background:var(--bg-card);';
        // Title is in the page header already — don't repeat it here.
        // Row 1 = status line + toggle; row 2 = device id + Copy.
        globalCard.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:20px;">
                <div id="siem-global-status-line" style="flex:1;min-width:0;font-size:12.5px;color:var(--text-secondary);line-height:1.45;">Loading…</div>
                <label class="siem-global-toggle" style="position:relative;display:inline-flex;align-items:center;gap:10px;cursor:pointer;user-select:none;flex-shrink:0;">
                    <span id="siem-global-label" style="font-size:13px;font-weight:700;color:var(--text-primary);min-width:32px;text-align:right;">—</span>
                    <span style="position:relative;display:inline-block;width:44px;height:24px;">
                        <input id="siem-global-checkbox" type="checkbox" style="opacity:0;width:0;height:0;">
                        <span id="siem-global-track" style="position:absolute;inset:0;background:var(--bg-tertiary);border:1px solid var(--border-default);border-radius:999px;transition:background 0.15s;"></span>
                        <span id="siem-global-knob" style="position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--text-secondary);transition:transform 0.15s,background 0.15s;"></span>
                    </span>
                </label>
            </div>
            <div style="display:flex;align-items:center;gap:8px;padding-top:8px;border-top:1px solid var(--border-default);font-size:12px;color:var(--text-secondary);flex-wrap:wrap;">
                <span><strong style="color:var(--text-primary);">This device</strong> — filter your SIEM by</span>
                <code id="siem-device-id" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--accent-primary);font-size:12px;">loading…</code>
                <button type="button" id="siem-device-copy" class="btn btn-secondary btn-compact" title="Copy device_id">Copy</button>
                <span style="opacity:0.85;">to see only events from this host.</span>
            </div>
        `;
        container.appendChild(globalCard);

        // Wire the device-id Copy + fetch (was on its own card before).
        const _copyBtn = globalCard.querySelector('#siem-device-copy');
        _copyBtn.addEventListener('click', async () => {
            const idEl = document.getElementById('siem-device-id');
            const val = idEl ? idEl.textContent : '';
            if (!val || val === 'loading…') return;
            try {
                await navigator.clipboard.writeText(val);
                const prev = _copyBtn.textContent;
                _copyBtn.textContent = '✓ Copied';
                setTimeout(() => { _copyBtn.textContent = prev; }, 1400);
            } catch (_) { /* clipboard denied */ }
        });
        API.getDeviceId().then(d => {
            const idEl = document.getElementById('siem-device-id');
            if (idEl && d && d.device_id) idEl.textContent = d.device_id;
        }).catch(() => {
            const idEl = document.getElementById('siem-device-id');
            if (idEl) idEl.textContent = 'unavailable';
        });

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
                ? 'Forwarding is <strong style="color:var(--accent-primary);">enabled</strong>. New events flow to every configured destination.'
                : 'Forwarding is <strong style="color:#ef4444;">paused</strong>. New events are NOT enqueued. Queued events still drain.';
            // Gate the Add button on the master state. Creating a
            // destination while forwarding is globally paused leads to
            // silent dead ends ("I added it but nothing flows"), so we
            // disable the entry point and explain why via the tooltip.
            const addBtnEl = document.getElementById('siem-add-btn');
            if (addBtnEl) {
                addBtnEl.disabled = !enabled;
                addBtnEl.style.opacity = enabled ? '' : '0.55';
                addBtnEl.style.cursor = enabled ? 'pointer' : 'not-allowed';
                addBtnEl.title = enabled
                    ? ''
                    : 'SIEM Forwarder is paused. Enable the master toggle above to add or test destinations.';
            }
        };

        paintToggle(true);
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
                paintToggle(!desired);
            } finally {
                saving = false;
            }
        });

        // ── Primary action: Add Destination ───────────────────────────
        // The primary CTA lives above the tier reference — operators who
        // already know the redaction trade-off (the common case on
        // return visits) see the action first. The tier reference sits
        // immediately below so first-timers still read it before saving
        // (expanded-by-default).
        const addBar = document.createElement('div');
        addBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;padding:8px 12px;border:1px solid var(--border-default);border-radius:8px;background:var(--bg-card);';
        // Vendor names get accent styling so they pop visually — helps
        // operators instantly see supported destinations at a glance.
        const vendorPill = (label) => `<span style="color:var(--accent-primary);font-weight:600;">${label}</span>`;
        const vendorsHtml = [
            'Local NDJSON file', 'Splunk HEC', 'Datadog',
            'Microsoft Sentinel', 'Google Chronicle', 'IBM QRadar',
            'OTLP', 'generic webhook',
        ].map(vendorPill).join(', ');
        addBar.innerHTML = `
            <div style="font-size:12.5px;color:var(--text-secondary);line-height:1.5;">
                <strong style="color:var(--text-primary);">Ready to forward?</strong>
                <span style="opacity:0.85;">Wire a destination — ${vendorsHtml}.</span>
            </div>
        `;
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.id = 'siem-add-btn';
        addBtn.className = 'btn btn-primary';
        addBtn.textContent = '+ Add Destination';
        addBtn.style.cssText = 'flex-shrink:0;';
        addBtn.addEventListener('click', () => {
            if (addBtn.disabled) return;
            if (window.SettingsPage && typeof SettingsPage._showSiemEditor === 'function') {
                SettingsPage._showSiemEditor(null);
            }
        });
        addBar.appendChild(addBtn);
        container.appendChild(addBar);

        // ── Redaction tiers — quick reference (collapsible) ──────────
        // Sits directly UNDER the Add bar so first-timers still see the
        // ships/strips trade-off before opening the editor. Expanded by
        // default; operators who already know can collapse it.
        const tierRef = this._buildTierReference();
        container.appendChild(tierRef);

        // ── Destinations (CRUD table lives on SettingsPage) ──────────
        // Render directly into the page container (no Card wrapper) so
        // the table uses the full horizontal width — the previous
        // gradient-card wrapper added ~40px of padding on each side
        // which read as dead space. The table's own border + radius
        // handle visual grouping.
        const forwardersBody = document.createElement('div');
        container.appendChild(forwardersBody);

        if (window.SettingsPage && typeof SettingsPage.renderSiemForwarders === 'function') {
            await SettingsPage.renderSiemForwarders.call(SettingsPage, forwardersBody);
        } else {
            forwardersBody.textContent = 'SIEM forwarders module not loaded.';
        }


        // (Guide footer moved into the tier reference card — see
        // _buildTierReference. Keeps "reference material" next to the
        // reference itself instead of trailing below the table.)
    },

    _buildTierReference() {
        // Native <details> = zero-JS collapsible. Expanded by default:
        // picking a redaction tier is the highest-blast-radius decision
        // on this page (wrong choice = raw prompts leaving the box), so
        // the ships/strips trade-off should be visible without a click.
        // Operators who don't need the reminder can collapse it; the
        // browser remembers their choice via the element's open state
        // for the session. Full depth lives in Guide → SIEM Forwarder.
        const details = document.createElement('details');
        details.open = true;
        details.style.cssText = 'margin-bottom:16px;border:1px solid var(--border-default);border-radius:10px;background:var(--bg-card);overflow:hidden;';

        const summary = document.createElement('summary');
        summary.style.cssText = 'cursor:pointer;padding:12px 16px;font-size:13px;font-weight:700;color:var(--text-primary);list-style:none;display:flex;align-items:center;gap:10px;user-select:none;';
        summary.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent-primary);flex-shrink:0;transition:transform 0.15s;"><polyline points="9 18 15 12 9 6"/></svg>
            <span>What each redaction tier forwards</span>
            <span style="font-size:11.5px;font-weight:500;color:var(--text-muted);">— pick one per destination when you add it</span>
        `;
        details.appendChild(summary);
        // Rotate chevron on open — keeps the interaction readable
        details.addEventListener('toggle', () => {
            const chev = summary.querySelector('svg');
            if (chev) chev.style.transform = details.open ? 'rotate(90deg)' : 'rotate(0)';
        });

        const body = document.createElement('div');
        body.style.cssText = 'padding:4px 16px 16px;border-top:1px solid var(--border-default);';

        const intro = document.createElement('div');
        intro.style.cssText = 'font-size:12.5px;color:var(--text-secondary);line-height:1.55;margin:10px 0 12px;';
        intro.innerHTML = 'The forwarder strips fields at <em>enqueue time</em> — a <code>standard</code> destination never has prompt text in its outbox rows even momentarily. Full tier requires explicit confirmation.';
        body.appendChild(intro);

        const grid = document.createElement('div');
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:10px;';

        const card = ({ name, subtitle, accent, ships, strips }) => {
            const el = document.createElement('div');
            el.style.cssText = `background:var(--bg-tertiary);border:1px solid var(--border-default);border-top:3px solid ${accent};border-radius:8px;padding:12px 14px;`;
            el.innerHTML = `
                <div style="font-size:11.5px;font-weight:800;letter-spacing:0.6px;text-transform:uppercase;color:${accent};margin-bottom:2px;">${name}</div>
                <div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;">${subtitle}</div>
                <div style="font-size:11.5px;color:var(--text-primary);font-weight:700;margin-bottom:4px;">Forwards</div>
                <ul style="margin:0 0 10px;padding-left:16px;font-size:11.5px;color:var(--text-secondary);line-height:1.6;">${ships.map(s => `<li>${s}</li>`).join('')}</ul>
                <div style="font-size:11.5px;color:var(--text-primary);font-weight:700;margin-bottom:4px;">Strips</div>
                <ul style="margin:0;padding-left:16px;font-size:11.5px;color:var(--text-secondary);line-height:1.6;">${strips.map(s => `<li>${s}</li>`).join('')}</ul>
            `;
            return el;
        };

        grid.appendChild(card({
            name: 'Minimal',
            subtitle: 'Ops dashboards',
            accent: '#6ee7b7',
            ships: [
                'verdict (BLOCK / DETECTED / ALLOW)',
                'risk_level, detected_items_count',
                '<code>device.uid</code>, <code>actor.user</code>, <code>actor.process</code>',
                'MITRE ATT&CK techniques',
                '<code>finding.related_events_uid</code>',
                '<code>suppressed_count</code>',
            ],
            strips: [
                'threat_score, confidence_score',
                'rule IDs, model_id, conversation_id',
                'hash-chain witness',
                'prompt text, LLM output, patterns',
            ],
        }));

        grid.appendChild(card({
            name: 'Standard · Default',
            subtitle: 'Most production feeds',
            accent: '#5eadb8',
            ships: [
                'Everything from Minimal, plus:',
                'threat_score, confidence_score',
                'matched rule IDs, worst_rule_severity',
                'model_id, conversation_id',
                'scan duration, ML status',
                'hash-chain witness on audits',
            ],
            strips: [
                'prompt text',
                'LLM output',
                'matched pattern strings',
                'full tool-call arguments',
            ],
        }));

        grid.appendChild(card({
            name: 'Full · Forensic',
            subtitle: 'Opt-in with confirmation',
            accent: '#f59e0b',
            ships: [
                'Everything from Standard, plus:',
                '<code>raw_data</code> = prompt text',
                '<code>unmapped.llm_output</code>',
                'matched pattern strings',
                'full tool-call args + policy reason',
                '<strong>Each field capped at 8KB</strong> (truncation marker appended)',
            ],
            strips: [
                '(nothing — forensic tier)',
            ],
        }));

        body.appendChild(grid);

        // Guide deep-link footer — moved inside the tier reference so
        // the reference + "there's more in the Guide" live together.
        // Removes the standalone dashed footer below the table.
        const tierGuideFooter = document.createElement('div');
        tierGuideFooter.style.cssText = 'margin-top:12px;padding-top:10px;border-top:1px dashed var(--border-default);font-size:11.5px;color:var(--text-muted);line-height:1.55;';
        tierGuideFooter.innerHTML = `
            <strong style="color:var(--text-secondary);">Reference material →</strong>
            Per-tier redaction breakdown, OCSF schema, example payloads, supported destinations, and ready-made Splunk / Sentinel dashboards live in the
            <a href="#" data-sv-goto-guide="section-siem-forwarder" style="color:var(--accent-primary);text-decoration:underline;">Guide → SIEM Forwarder section</a>.
        `;
        tierGuideFooter.querySelector('[data-sv-goto-guide]')?.addEventListener('click', (e) => {
            e.preventDefault();
            if (window.Sidebar) {
                Sidebar._pendingScroll = 'section-siem-forwarder';
                Sidebar.navigate('guide');
            }
        });
        body.appendChild(tierGuideFooter);

        details.appendChild(body);
        return details;
    },
};

// Expose globally so app.js can route to it
if (typeof window !== 'undefined') {
    window.SiemExportPage = SiemExportPage;
}
