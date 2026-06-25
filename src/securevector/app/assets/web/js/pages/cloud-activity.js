/**
 * Cloud Activity Page — full-visibility view of what flows between this
 * device and the SecureVector cloud once enrolled.
 *
 * fleet-local-push, story #113.
 *
 * Three read-only sections (mirrors the `sv inspect-uplink` CLI):
 *   1. Enrollment status banner — org / group / device id / last sync /
 *      connection-state indicator.
 *   2. Inbound — synced policies — the current org bundle's tool-permission
 *      rules + bundle version + signing-key fingerprint + last-applied time.
 *   3. Outbound — forwarding — enrollment-sourced destinations (🔒 managed),
 *      the OCSF event classes emitted, and the metadata-only contract.
 *
 * Gating: this page is visible in the sidebar ONLY when the device is
 * enrolled (sidebar.js filters it out otherwise). It still renders a
 * not-enrolled empty-state if reached directly, so a deep-link never 404s.
 *
 * Trust hardening: every server-supplied string (org name, admin email,
 * destination name/url, rule tool_id/reason) goes through textContent —
 * never innerHTML — so a hostile bundle or destination name can't inject
 * markup. Read-only: no edit/delete/bypass affordances on this page.
 */

const CloudActivityPage = {
    _data: null,

    async render(container) {
        container.textContent = '';
        this._container = container;

        container.appendChild(this._buildHero());

        const loading = document.createElement('div');
        loading.className = 'mcp-loading';
        const sp = document.createElement('div');
        sp.className = 'spinner';
        loading.appendChild(sp);
        const lt = document.createElement('div');
        lt.className = 'mcp-loading-text';
        lt.textContent = 'Reading cloud activity…';
        loading.appendChild(lt);
        container.appendChild(loading);

        let data;
        try {
            data = await API.request('/api/v1/cloud-activity');
        } catch (err) {
            container.removeChild(loading);
            container.appendChild(this._buildError(err));
            return;
        }
        this._data = data;
        container.removeChild(loading);
        this._applyHeroState(!!data.enrolled);

        if (!data.enrolled) {
            container.appendChild(this._buildNotEnrolled());
            return;
        }

        container.appendChild(this._buildEnrollmentBanner(data.enrollment));
        container.appendChild(this._buildInboundSection(data.inbound));
        container.appendChild(this._buildOutboundSection(data.outbound));
    },

    // -------- Hero --------

    _buildHero() {
        const hero = document.createElement('div');
        hero.className = 'mcp-hero';

        const tile = document.createElement('div');
        tile.className = 'mcp-hero-tile';
        // Cloud + up/down arrows — conveys the bidirectional pipe.
        tile.innerHTML =
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.8 6 6 0 1 0-11.1 3.6"></path>' +
            '<path d="M8 16v-4"></path><path d="m6 14 2-2 2 2"></path>' +
            '<path d="M14 12v4"></path><path d="m12 14 2 2 2-2"></path></svg>';
        hero.appendChild(tile);

        const text = document.createElement('div');
        text.className = 'mcp-hero-text';
        const titleRow = document.createElement('div');
        titleRow.className = 'mcp-hero-title-row';
        const h1 = document.createElement('h2');
        h1.className = 'mcp-hero-title';
        h1.textContent = 'Cloud Activity';
        titleRow.appendChild(h1);
        const pill = document.createElement('span');
        pill.className = 'mcp-cloud-pill';
        pill.title = 'Visible only when this device is enrolled in a SecureVector organization.';
        pill.textContent = 'Cloud-managed';
        titleRow.appendChild(pill);
        text.appendChild(titleRow);

        const sub = document.createElement('p');
        sub.className = 'mcp-hero-sub';
        text.appendChild(sub);
        hero.appendChild(text);

        // Keep refs so the hero can be made state-aware once enrollment is known.
        // Default to the not-enrolled (future-tense) framing + hidden pill so the
        // loading state and any deep-link to the gated page never claim an
        // enrolled state the device isn't in.
        this._heroSub = sub;
        this._heroPill = pill;
        this._applyHeroState(false);

        return hero;
    },

    // Switch the hero copy + 'Cloud-managed' pill to match enrollment state.
    // Not enrolled: future tense, no pill (nothing is flowing yet). Enrolled:
    // present tense + pill (the pipe is live).
    _applyHeroState(enrolled) {
        if (!this._heroSub) return;
        if (enrolled) {
            this._heroSub.textContent =
                'Exactly what flows in and out of this device since it enrolled — synced policies coming down, metadata-only audit going up. Read-only. The terminal equivalent is `sv inspect-uplink`.';
            this._heroPill.style.display = '';
        } else {
            this._heroSub.textContent =
                'What will flow in and out of this device once it connects to a SecureVector cloud account — policies syncing down, metadata-only audit going up. Nothing flows until then. Read-only. The terminal equivalent is `sv inspect-uplink`.';
            this._heroPill.style.display = 'none';
        }
    },

    _buildError(err) {
        const w = document.createElement('div');
        w.className = 'mcp-empty';
        const h = document.createElement('h3');
        h.textContent = "Couldn't load Cloud Activity";
        w.appendChild(h);
        const p = document.createElement('p');
        p.textContent = err && err.message ? err.message : String(err);
        w.appendChild(p);
        return w;
    },

    _buildNotEnrolled() {
        const wrap = document.createElement('div');
        wrap.className = 'mcp-empty';
        const tile = document.createElement('div');
        tile.className = 'mcp-empty-tile';
        tile.textContent = '☁';
        wrap.appendChild(tile);
        const h = document.createElement('h3');
        h.textContent = 'Connect a cloud account';
        wrap.appendChild(h);
        // Reframed away from org/enrollment jargon: for an individual this is
        // simply an optional cloud-account sign-up, not an admin action. Stays
        // honest about local-first + metadata-only + reversible. Bulleted so the
        // load-bearing claims (content never leaves, metadata-only, reversible)
        // are scannable instead of buried in a paragraph.
        const lead = document.createElement('p');
        lead.textContent =
            'Cloud Activity lights up once this device connects to a SecureVector cloud account (optional, free tier).';
        wrap.appendChild(lead);

        const ul = document.createElement('ul');
        ul.className = 'ca-empty-points';
        // inline-block so the list centers as a unit inside the text-align:center
        // empty-state, while the bullet text itself stays left-aligned (most legible).
        ul.style.cssText =
            'display: inline-block; margin: 8px auto 4px; padding-left: 18px; ' +
            'text-align: left; max-width: 460px; ' +
            'color: var(--text-secondary); line-height: 1.55; font-size: 13px;';
        // Each entry is plain text, except the EU-residency line which carries a
        // {pre, hi, post} shape so the load-bearing compliance guarantee
        // ('hard-locked under EU residency') renders as a highlighted pill —
        // it's the phrase a privacy/compliance buyer scans for.
        [
            'Until then it runs fully local — nothing synced down, nothing forwarded up.',
            {
                pre: 'Your prompt and output text never leaves this device, connected or not (',
                hi: 'hard-locked under EU residency',
                post: ').',
            },
            {
                text: 'Enrolling sends only this device\u2019s identity — device id, hostname, OS, app version — to bind it to your org.',
                eu: 'This identity metadata is the only data that crosses to our cloud (today hosted outside the EU); no prompt or output content is ever included.',
            },
            'After that, forwarding is operational metadata only (agent/session identifiers, activity counts, posture flags; never prompt or output text) for fleet-wide governance posture.',
            'Pause forwarding anytime with the toggle on this page.',
            'Shipping detection events to your own SOC is a separate, tiered choice under Connect \u2192 SIEM Forwarder.',
        ].forEach((t) => {
            const li = document.createElement('li');
            li.style.marginBottom = '5px';
            if (typeof t === 'string') {
                li.textContent = t;
            } else if (t.eu) {
                // Bullet body + an EU-tagged sub-note that scopes what enrollment
                // means for an EU customer (identity metadata only, cloud is
                // non-EU, never content).
                li.appendChild(document.createTextNode(t.text));
                const note = document.createElement('div');
                note.style.cssText =
                    'margin-top: 4px; font-size: 11.5px; line-height: 1.5; ' +
                    'color: var(--text-muted, var(--text-secondary));';
                const tag = document.createElement('span');
                tag.textContent = 'EU';
                tag.style.cssText =
                    'display: inline-block; margin-right: 6px; padding: 0 5px; ' +
                    'border-radius: 4px; font-weight: 700; font-size: 10px; ' +
                    'letter-spacing: 0.3px; color: var(--accent-primary); ' +
                    'background: rgba(8,145,178,0.12); ' +
                    'border: 1px solid rgba(8,145,178,0.30);';
                note.appendChild(tag);
                note.appendChild(document.createTextNode(t.eu));
                li.appendChild(note);
            } else {
                li.appendChild(document.createTextNode(t.pre));
                const lock = document.createElement('span');
                lock.className = 'ca-eu-lock';
                lock.textContent = '\uD83D\uDD12 ' + t.hi; // 🔒 prefix
                lock.style.cssText =
                    'display: inline-block; padding: 0 6px; border-radius: 5px; ' +
                    'font-weight: 600; font-size: 12px; white-space: nowrap; ' +
                    'color: var(--accent-primary); ' +
                    'background: rgba(8,145,178,0.12); ' +
                    'border: 1px solid rgba(8,145,178,0.30);';
                li.appendChild(lock);
                li.appendChild(document.createTextNode(t.post));
            }
            ul.appendChild(li);
        });
        wrap.appendChild(ul);

        // Primary CTA — the same signup surface linked from the header, Getting
        // Started, Rules and Settings. A quiet inline link, not a button/banner.
        const cta = document.createElement('p');
        cta.style.cssText = 'margin-top: 4px;';
        const link = document.createElement('a');
        link.href = 'https://app.securevector.io';
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'Create a free cloud account → app.securevector.io';
        link.style.cssText = 'color: var(--accent-primary); text-decoration: underline;';
        cta.appendChild(link);
        wrap.appendChild(cta);

        // Demoted hint for users who already hold an org-minted enrollment token.
        const cmd = document.createElement('div');
        cmd.className = 'mcp-empty-cmd';
        const lbl = document.createElement('span');
        lbl.className = 'mcp-empty-cmd-label';
        lbl.textContent = 'ALREADY HAVE A TOKEN?';
        const code = document.createElement('code');
        code.textContent = 'securevector-app enroll <svet_token>';
        cmd.appendChild(lbl);
        cmd.appendChild(code);
        wrap.appendChild(cmd);
        return wrap;
    },

    // -------- 1. Enrollment status banner --------

    _buildEnrollmentBanner(e) {
        const card = document.createElement('div');
        card.className = 'ca-section ca-enrollment';

        const head = document.createElement('div');
        head.className = 'ca-section-head';
        const title = document.createElement('h3');
        title.className = 'ca-section-title';
        title.textContent = 'Enrollment status';
        head.appendChild(title);
        head.appendChild(this._buildConnIndicator(e.connection_state));
        card.appendChild(head);

        const grid = document.createElement('dl');
        grid.className = 'ca-dl';
        const rows = [
            ['Organization', e.org_name || e.org_id || '—'],
            ['Group', (e.group_memberships && e.group_memberships.length) ? e.group_memberships.join(', ') : '—'],
            ['Managed by', e.admin_email || '—'],
            ['Enrolled user', e.user_email || '—'],
            ['Device ID', e.device_id || '—'],
            ['Last sync', this._relTime(e.last_sync_at) + (e.last_sync_status ? ' · ' + this._humanPollStatus(e.last_sync_status) : '')],
        ];
        for (const [k, v] of rows) {
            const dt = document.createElement('dt');
            dt.textContent = k;
            const dd = document.createElement('dd');
            dd.textContent = v;
            if (k === 'Device ID') dd.className = 'ca-mono';
            grid.appendChild(dt);
            grid.appendChild(dd);
        }
        card.appendChild(grid);
        return card;
    },

    _buildConnIndicator(state) {
        const map = {
            connected: ['#10b981', 'Connected'],
            idle: ['#f59e0b', 'Idle'],
            stale: ['#f59e0b', 'Sync drift'],
            offline: ['#ef4444', 'Offline'],
            not_enrolled: ['#7d8590', 'Not enrolled'],
            unknown: ['#7d8590', 'Unknown'],
        };
        const [color, label] = map[state] || map.unknown;
        const pill = document.createElement('span');
        pill.className = 'ca-conn';
        const dot = document.createElement('span');
        dot.className = 'ca-conn-dot';
        dot.style.background = color;
        pill.appendChild(dot);
        const txt = document.createElement('span');
        txt.textContent = label;
        pill.appendChild(txt);
        return pill;
    },

    // -------- 2. Inbound — synced policies --------

    _buildInboundSection(inb) {
        const card = document.createElement('div');
        card.className = 'ca-section ca-inbound';

        const head = document.createElement('div');
        head.className = 'ca-section-head';
        const title = document.createElement('h3');
        title.className = 'ca-section-title';
        title.textContent = 'Inbound · synced policies';
        head.appendChild(title);
        const dir = document.createElement('span');
        dir.className = 'ca-dir ca-dir-in';
        dir.textContent = '↓ cloud → device';
        head.appendChild(dir);
        card.appendChild(head);

        if (!inb.any_active) {
            const empty = document.createElement('p');
            empty.className = 'ca-empty-line';
            empty.textContent = 'No policy bundle applied yet. Enrolled devices receive their first signed bundle within ~60s.';
            card.appendChild(empty);
            return card;
        }

        // Provenance chips — version, fingerprint, last-applied.
        const chips = document.createElement('div');
        chips.className = 'ca-chips';
        chips.appendChild(this._chip('Bundle version', inb.bundle_version != null ? 'v' + inb.bundle_version : '—'));
        chips.appendChild(this._chip('Rules', String(inb.rule_count)));
        chips.appendChild(this._chip('Verification', this._humanVerification(inb.verification_status)));
        chips.appendChild(this._chip('Last applied', this._relTime(inb.last_applied_at)));
        card.appendChild(chips);

        if (inb.signing_key_fingerprint) {
            const fp = document.createElement('div');
            fp.className = 'ca-fingerprint';
            const k = document.createElement('span');
            k.className = 'ca-fingerprint-k';
            k.textContent = 'SIGNING KEY';
            const v = document.createElement('code');
            v.textContent = inb.signing_key_fingerprint;
            fp.appendChild(k);
            fp.appendChild(v);
            card.appendChild(fp);
        }

        // Read-only rules table.
        const table = document.createElement('table');
        table.className = 'ca-table';
        const thead = document.createElement('thead');
        thead.innerHTML = '<tr><th>Tool</th><th>Effect</th><th>Priority</th><th>Reason</th></tr>';
        table.appendChild(thead);
        const tbody = document.createElement('tbody');
        for (const r of (inb.rules || [])) {
            const tr = document.createElement('tr');
            const tdTool = document.createElement('td');
            const code = document.createElement('code');
            code.textContent = r.tool_id;
            tdTool.appendChild(code);
            tr.appendChild(tdTool);
            const tdEff = document.createElement('td');
            const eff = document.createElement('span');
            eff.className = 'ca-effect ca-effect-' + (r.effect || '');
            eff.textContent = r.effect ? r.effect.charAt(0).toUpperCase() + r.effect.slice(1) : '—';
            tdEff.appendChild(eff);
            tr.appendChild(tdEff);
            const tdPri = document.createElement('td');
            tdPri.textContent = r.priority != null ? String(r.priority) : '—';
            tr.appendChild(tdPri);
            const tdReason = document.createElement('td');
            tdReason.className = 'ca-reason';
            tdReason.textContent = r.reason || '—';
            tr.appendChild(tdReason);
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        card.appendChild(table);

        // Cross-link to the full MCP Policies drill-down.
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'ca-link';
        link.textContent = 'Full policy detail on MCP Policies →';
        link.addEventListener('click', () => { if (window.Sidebar) Sidebar.navigate('mcp-policies'); });
        card.appendChild(link);

        return card;
    },

    // -------- 3. Outbound — forwarding --------

    _buildOutboundSection(out) {
        const card = document.createElement('div');
        card.className = 'ca-section ca-outbound';

        const head = document.createElement('div');
        head.className = 'ca-section-head';
        const title = document.createElement('h3');
        title.className = 'ca-section-title';
        title.textContent = 'Outbound · forwarding';
        head.appendChild(title);
        const dir = document.createElement('span');
        dir.className = 'ca-dir ca-dir-out';
        dir.textContent = '↑ device → destinations';
        head.appendChild(dir);
        card.appendChild(head);

        // Metadata-only contract banner — the load-bearing privacy promise.
        const promise = document.createElement('div');
        promise.className = 'ca-promise';
        promise.innerHTML =
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
        const ptxt = document.createElement('span');
        ptxt.textContent = 'Metadata only. Tool ids, decisions, device + app version, timestamps. Never prompt text, model output, or tool arguments — the OCSF raw_data slot always leaves as null.';
        promise.appendChild(ptxt);
        card.appendChild(promise);

        // User-level cloud-forwarding opt-out (#151). The device owner can
        // turn off forwarding to the managed (enrollment) destinations even
        // when the admin opted in — disabled means nothing leaves this device
        // for the cloud fleet. User-added SIEM destinations are untouched.
        if ((out.enrollment_destinations || []).length) {
            card.appendChild(this._buildForwardingToggle(out));
        }

        // Destinations table — enrollment-sourced first (badged 🔒 managed),
        // then any user-added ones.
        const allDests = [
            ...(out.enrollment_destinations || []),
            ...(out.user_destinations || []),
        ];
        const dh = document.createElement('h4');
        dh.className = 'ca-subhead';
        dh.textContent = 'Destinations';
        card.appendChild(dh);

        if (!allDests.length) {
            const empty = document.createElement('p');
            empty.className = 'ca-empty-line';
            empty.textContent = 'No forwarding destinations configured. Nothing is being pushed up. Your enrollment admin can opt in to managed destinations; you can also add your own under SIEM Forwarder.';
            card.appendChild(empty);
        } else {
            const table = document.createElement('table');
            table.className = 'ca-table';
            const thead = document.createElement('thead');
            thead.innerHTML = '<tr><th>Name</th><th>Destination</th><th>Source</th><th>Last send</th><th>Sent</th></tr>';
            table.appendChild(thead);
            const tbody = document.createElement('tbody');
            for (const d of allDests) {
                const tr = document.createElement('tr');

                const tdName = document.createElement('td');
                tdName.textContent = d.name || '—';
                if (!d.enabled) {
                    const off = document.createElement('span');
                    off.className = 'ca-disabled-pill';
                    off.textContent = 'disabled';
                    tdName.appendChild(off);
                }
                tr.appendChild(tdName);

                const tdUrl = document.createElement('td');
                const urlCode = document.createElement('code');
                urlCode.className = 'ca-dest-url';
                urlCode.textContent = this._maskUrl(d.url);
                urlCode.title = d.kind || '';
                tdUrl.appendChild(urlCode);
                tr.appendChild(tdUrl);

                const tdSrc = document.createElement('td');
                tdSrc.appendChild(this._sourceBadge(d.source));
                tr.appendChild(tdSrc);

                const tdLast = document.createElement('td');
                tdLast.textContent = this._relTime(d.last_success_at);
                tr.appendChild(tdLast);

                const tdSent = document.createElement('td');
                tdSent.textContent = String(d.events_sent || 0);
                tr.appendChild(tdSent);

                tbody.appendChild(tr);
            }
            table.appendChild(tbody);
            card.appendChild(table);
        }

        // OCSF event vocabulary — the only shapes that ever leave the host.
        const eh = document.createElement('h4');
        eh.className = 'ca-subhead';
        eh.textContent = 'OCSF events emitted';
        card.appendChild(eh);

        const evWrap = document.createElement('div');
        evWrap.className = 'ca-events';
        for (const ev of (out.event_types || [])) {
            const row = document.createElement('div');
            row.className = 'ca-event';
            const code = document.createElement('code');
            code.className = 'ca-event-code';
            code.textContent = ev.event_code;
            row.appendChild(code);
            const cls = document.createElement('span');
            cls.className = 'ca-event-class';
            cls.textContent = 'class ' + ev.class_uid + ' · ' + ev.class_name;
            row.appendChild(cls);
            const desc = document.createElement('span');
            desc.className = 'ca-event-desc';
            desc.textContent = ev.description;
            row.appendChild(desc);
            evWrap.appendChild(row);
        }
        card.appendChild(evWrap);

        return card;
    },

    // -------- Cloud-forwarding opt-out toggle (#151) --------

    _buildForwardingToggle(out) {
        const row = document.createElement('div');
        row.className = 'ca-fwd-toggle-row';

        const textCol = document.createElement('div');
        textCol.className = 'ca-fwd-toggle-text';
        const label = document.createElement('div');
        label.className = 'ca-fwd-toggle-label';
        label.textContent = 'Cloud forwarding';
        textCol.appendChild(label);
        const sub = document.createElement('div');
        sub.className = 'ca-fwd-toggle-sub';
        sub.textContent = out.forwarding_enabled
            ? 'Forwarding metadata to your org’s managed destinations. Turn off to stop anything leaving this device for the cloud fleet.'
            : 'Off — nothing is sent to the cloud fleet from this device. Your admin’s opt-in stays recorded; flip back on anytime.';
        textCol.appendChild(sub);
        row.appendChild(textCol);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ca-fwd-switch' + (out.forwarding_enabled ? ' on' : '');
        btn.setAttribute('role', 'switch');
        btn.setAttribute('aria-checked', out.forwarding_enabled ? 'true' : 'false');
        btn.title = out.forwarding_enabled
            ? 'Disable cloud forwarding (user opt-out)'
            : 'Re-enable cloud forwarding';
        const knob = document.createElement('span');
        knob.className = 'ca-fwd-knob';
        btn.appendChild(knob);

        btn.addEventListener('click', async () => {
            const next = !(this._data && this._data.outbound
                ? this._data.outbound.forwarding_enabled
                : out.forwarding_enabled);
            btn.disabled = true;
            try {
                await API.request('/api/v1/cloud-forwarding', {
                    method: 'POST',
                    body: JSON.stringify({ enabled: next }),
                });
                // Re-render the page from fresh server state so the
                // destinations table (enabled/disabled pills) stays truthful.
                if (this._container) this.render(this._container);
            } catch (err) {
                btn.disabled = false;
                sub.textContent = 'Could not update forwarding: ' + (err && err.message ? err.message : 'request failed');
            }
        });
        row.appendChild(btn);

        return row;
    },

    _sourceBadge(source) {
        const badge = document.createElement('span');
        if (source === 'enrollment') {
            badge.className = 'ca-source ca-source-managed';
            badge.textContent = '🔒 Managed';
            badge.title = 'Auto-registered from your enrollment response. Managed by your org admin.';
        } else {
            badge.className = 'ca-source ca-source-user';
            badge.textContent = 'You added';
            badge.title = 'Hand-added by you on the SIEM Forwarder page.';
        }
        return badge;
    },

    // -------- Shared helpers --------

    _chip(label, value) {
        const c = document.createElement('span');
        c.className = 'mcp-chip';
        const k = document.createElement('span');
        k.className = 'mcp-chip-k';
        k.textContent = label;
        const v = document.createElement('span');
        v.className = 'mcp-chip-v';
        v.textContent = value;
        c.appendChild(k);
        c.appendChild(v);
        return c;
    },

    _maskUrl(url) {
        if (!url) return '—';
        // Strip query/fragment so a token in a URL never lands on screen.
        try {
            const u = new URL(url);
            return u.origin + u.pathname;
        } catch (_) {
            return String(url).split('?')[0].split('#')[0];
        }
    },

    _humanVerification(s) {
        const map = {
            match: '✓ Verified',
            degraded: '⚠ Drift',
            tampered: '✖ Tampered',
            error: '✖ Error',
        };
        return map[s] || s || '—';
    },

    _humanPollStatus(s) {
        if (!s) return '';
        const map = {
            '200_applied': 'Applied · 200',
            '304_not_modified': 'No change · 304',
            '401_refresh': 'JWT refresh',
            'signature_mismatch': 'Signature mismatch',
            'http_error': 'HTTP error',
            'timeout': 'Timeout',
        };
        return map[s] || s;
    },

    _relTime(iso) {
        if (!iso) return '—';
        try {
            const then = new Date(iso).getTime();
            const diffMs = Date.now() - then;
            if (diffMs < 0) return 'in the future';
            const sec = Math.floor(diffMs / 1000);
            if (sec < 60) return sec + 's ago';
            const min = Math.floor(sec / 60);
            if (min < 60) return min + 'm ago';
            const hr = Math.floor(min / 60);
            if (hr < 24) return hr + 'h ago';
            const day = Math.floor(hr / 24);
            return day + 'd ago';
        } catch (_) { return iso; }
    },
};

window.CloudActivityPage = CloudActivityPage;
