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

        // ── Unified master card: state + toggle + device id + add ─────
        // All three "about this forwarder" controls in one vertical stack.
        // Previously three separate cards stacked (kill-switch / device id
        // / add bar) which ate 250+ px of vertical space before the table.
        //
        // Row 1: status line + ON/OFF toggle
        // Row 2: device_id + Copy (subtle divider above)
        // Row 3: Ready-to-forward blurb + primary "+ Add Destination"
        //
        // Title is in the page header already — don't repeat here.
        // Shared-env RBAC callout lives in Guide → SIEM Forwarder.
        const globalCard = document.createElement('div');
        globalCard.className = 'siem-global-switch';
        // Dropped the 4px accent left border — pure decoration that
        // thickens the card visually without adding information. The
        // dividers between rows carry enough structure.
        globalCard.style.cssText = 'display:flex;flex-direction:column;gap:8px;padding:12px 14px;margin-bottom:12px;border:1px solid var(--border-default);border-radius:10px;background:var(--bg-card);';
        // Vendor pill list removed — the type dropdown inside the Add
        // modal (optgroups: Native + Via Webhook) already names every
        // supported destination when the operator actually needs it.
        // Showing them permanently in the card was noise on the
        // command surface.
        // Master card, reading-order layout:
        //   [Device chip]  [Status line — flex]  [ON/OFF toggle]
        //        ↑                 ↑                    ↑
        //     identity          state                action
        //
        // Status + toggle are now adjacent (Gestalt proximity — the
        // toggle controls exactly what the status describes). Device
        // chip moves to the far left as a host-identity label.
        globalCard.innerHTML = `
            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
                <div style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--text-secondary);flex-shrink:0;">
                    <span>Device</span>
                    <code id="siem-device-id" title="Filter your SIEM by this value to see only events from this machine. Raw OS UUID never leaves the box (SHA-256 namespaced hash)." style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--accent-primary);font-size:11.5px;cursor:help;">loading…</code>
                    <button type="button" id="siem-device-copy" title="Copy device_id" aria-label="Copy device_id" style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;background:transparent;border:1px solid var(--border-default);border-radius:4px;color:var(--text-secondary);cursor:pointer;transition:color 0.15s,border-color 0.15s,background 0.15s;">
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    </button>
                </div>
                <div id="siem-global-status-line" style="flex:1;min-width:160px;font-size:12.5px;color:var(--text-secondary);line-height:1.45;text-align:right;">Loading…</div>
                <label class="siem-global-toggle" style="position:relative;display:inline-flex;align-items:center;gap:10px;cursor:pointer;user-select:none;flex-shrink:0;">
                    <span id="siem-global-label" style="font-size:13px;font-weight:700;color:var(--text-primary);min-width:32px;text-align:right;">—</span>
                    <span style="position:relative;display:inline-block;width:44px;height:24px;">
                        <input id="siem-global-checkbox" type="checkbox" style="opacity:0;width:0;height:0;">
                        <span id="siem-global-track" style="position:absolute;inset:0;background:var(--bg-tertiary);border:1px solid var(--border-default);border-radius:999px;transition:background 0.15s;"></span>
                        <span id="siem-global-knob" style="position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--text-secondary);transition:transform 0.15s,background 0.15s;"></span>
                    </span>
                </label>
            </div>
        `;
        // Wire Copy + device-id fetch on the master card's chip.
        const _devCopy = globalCard.querySelector('#siem-device-copy');
        _devCopy.addEventListener('click', async () => {
            const idEl = document.getElementById('siem-device-id');
            const val = idEl ? idEl.textContent : '';
            if (!val || val === 'loading…') return;
            try {
                await navigator.clipboard.writeText(val);
                const prev = _devCopy.innerHTML;
                _devCopy.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
                setTimeout(() => { _devCopy.innerHTML = prev; }, 1400);
            } catch (_) { /* clipboard denied — silent */ }
        });
        API.getDeviceId().then(d => {
            const idEl = document.getElementById('siem-device-id');
            if (idEl && d && d.device_id) idEl.textContent = d.device_id;
        }).catch(() => {
            const idEl = document.getElementById('siem-device-id');
            if (idEl) idEl.textContent = 'unavailable';
        });
        // Master-card Add button removed — single + Add SIEM destination
        // now lives inline with the destinations-table meta row
        // (rendered by SettingsPage.renderSiemForwarders). One button,
        // right above the table, matches the Rules-page pattern.
        container.appendChild(globalCard);

        // Device-id chip + Copy button moved to the destinations-table
        // meta row (SettingsPage.renderSiemForwarders). The chip and
        // its wiring are installed by that renderer; nothing else to
        // do here in the master card.

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
            // Gate the inline Add button that lives above the destinations
            // table (id: siem-inline-add-btn). Master-card Add button was
            // removed; this is now the single entry point.
            const addBtnEl = document.getElementById('siem-inline-add-btn');
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

        // ── Destinations table ───────────────────────────────────────
        // The primary surface for daily ops — moved above the tier
        // reference because returning operators open the page to check
        // health / counts, not to re-read the redaction trade-off.
        // Full-width render (no Card wrapper) so the table uses every
        // pixel of horizontal space.
        const forwardersBody = document.createElement('div');
        container.appendChild(forwardersBody);

        if (window.SettingsPage && typeof SettingsPage.renderSiemForwarders === 'function') {
            await SettingsPage.renderSiemForwarders.call(SettingsPage, forwardersBody);
        } else {
            forwardersBody.textContent = 'SIEM forwarders module not loaded.';
        }

        // ── Redaction tiers — quick reference (collapsible) ──────────
        // Moved BELOW the destinations table — tier reference is
        // read-once material (pick a tier when you add), not part of
        // the daily ritual. First-timers still see the trade-off via
        // the editor-modal dropdown hints + the Guide deep-link in
        // this card's footer. Collapsed by default here.
        // Extra top margin so the collapsible doesn't hug the table's
        // bottom border — visually separates "data" from "reference."
        const tierRef = this._buildTierReference();
        tierRef.style.marginTop = '20px';
        container.appendChild(tierRef);
    },

    _buildTierReference() {
        // Native <details> = zero-JS collapsible. Collapsed by default
        // now that the tier reference lives BELOW the destinations
        // table — it's read-once reference material (pick a tier when
        // you add), not part of the daily ritual. First-timers still
        // see the trade-off via the editor-modal dropdown hints + the
        // Guide deep-link in this card's footer. Open on click.
        const details = document.createElement('details');
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
