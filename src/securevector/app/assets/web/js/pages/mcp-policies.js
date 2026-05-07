/**
 * MCP Policies Page — read-only viewer for cloud-pushed MCP policies.
 *
 * Three jobs (per the local-visibility design plan):
 *   1. Provenance — what's pushed onto this device, by whom, when.
 *   2. Routing — who do I escalate to when a synced rule blocks something.
 *   3. Health — is the cloud→local pipe alive, or am I drifting?
 *
 * Aesthetic: a "security audit panel" — weighted, calm, authoritative. Borrows
 * the canonical stat-card and icon-tile idioms used elsewhere in the app so it
 * reads as a first-class admin surface, not a config table.
 *
 * Trust hardening:
 *   - Admin-authored fields (policy_name, reason, org_name) ALWAYS go through
 *     textContent — never innerHTML — to neutralise the <script> attack surface.
 *   - Read-only: no edit/delete/bypass affordances anywhere on this page.
 *   - ?audit=1 query param auto-expands the verification details panel for
 *     SOC2-style reviewers (captured at script load because the SPA strips
 *     the query string when it pushState()'s after the initial paint).
 */

const _MCP_AUDIT_ENTRY = (() => {
    try { return new URLSearchParams(window.location.search).get('audit') === '1'; }
    catch (_) { return false; }
})();

const McpPoliciesPage = {
    _data: null,
    _detailsExpanded: false,

    async render(container) {
        container.textContent = '';
        this._container = container;
        this._detailsExpanded = this._detailsExpanded || _MCP_AUDIT_ENTRY;

        // Hero — heavyweight: shield-check icon tile + name + "Cloud-only" pill +
        // Sync Now button. The button gating reads from data.can_refresh once
        // the fetch resolves; until then we render it disabled.
        const hero = this._buildHero();
        container.appendChild(hero);

        // Loading state — replaced after fetch resolves
        const loading = document.createElement('div');
        loading.className = 'mcp-loading';
        const sp = document.createElement('div');
        sp.className = 'spinner';
        loading.appendChild(sp);
        const lt = document.createElement('div');
        lt.className = 'mcp-loading-text';
        lt.textContent = 'Reading synced policies…';
        loading.appendChild(lt);
        container.appendChild(loading);

        try {
            const data = await API.request('/api/v1/policy-sync/policies');
            this._data = data;
            container.removeChild(loading);
            this._refreshHeroSyncButton(hero, data);
            this._renderBody(container, data);
        } catch (err) {
            container.removeChild(loading);
            container.appendChild(this._buildErrorState(err));
        }
    },

    /**
     * Manual sync — POST /api/v1/policy-sync/refresh, then refetch the page
     * data. The button stays disabled while in flight; on completion we render
     * a small toast-style banner inline below the hero with the outcome.
     */
    async _onSyncNow() {
        if (!this._data || !this._data.can_refresh) return;
        if (this._syncing) return;
        this._syncing = true;
        this._refreshHeroSyncButton(this._container.querySelector('.mcp-hero'), this._data);

        let resp;
        try {
            resp = await API.request('/api/v1/policy-sync/refresh', { method: 'POST' });
        } catch (err) {
            resp = { status: 'error', applied: false, message: err.message || String(err) };
        }
        this._syncing = false;
        this._lastSyncResult = resp;

        // Refetch + re-render — the new data lands the just-applied bundle
        await this.render(this._container);
    },

    _refreshHeroSyncButton(hero, data) {
        if (!hero) return;
        const btn = hero.querySelector('.mcp-sync-now-btn');
        if (!btn) return;

        const canRefresh = !!(data && data.can_refresh);
        const reason = (data && data.refresh_blocker_reason) || '';

        btn.disabled = !canRefresh || this._syncing;
        btn.classList.toggle('is-syncing', !!this._syncing);
        btn.title = !canRefresh
            ? reason || 'Sync unavailable'
            : 'Force one /policy/sync iteration now';
        btn.textContent = this._syncing ? 'Syncing…' : 'Sync now';

        // Toast row under the hero — only shows after a manual sync completes.
        let toast = hero.parentElement && hero.parentElement.querySelector('.mcp-sync-toast');
        if (toast) toast.remove();
        if (this._lastSyncResult) {
            const r = this._lastSyncResult;
            const t = document.createElement('div');
            t.className = 'mcp-sync-toast mcp-sync-toast-' + (r.status === 'ok' || r.status === 'not_modified' ? 'ok' : 'error');
            const icon = document.createElement('span');
            icon.className = 'mcp-sync-toast-icon';
            icon.textContent = r.status === 'ok' ? '✓' : r.status === 'not_modified' ? '·' : '✖';
            const txt = document.createElement('span');
            txt.textContent = r.message + (r.error_detail ? ' (' + r.error_detail + ')' : '');
            const close = document.createElement('button');
            close.className = 'mcp-sync-toast-close';
            close.textContent = '×';
            close.title = 'Dismiss';
            close.addEventListener('click', () => {
                this._lastSyncResult = null;
                this._refreshHeroSyncButton(hero, this._data);
            });
            t.appendChild(icon);
            t.appendChild(txt);
            t.appendChild(close);
            hero.parentElement.insertBefore(t, hero.nextSibling);
        }
    },

    // -------- Top-level scaffolding --------

    _buildHero() {
        const hero = document.createElement('div');
        hero.className = 'mcp-hero';

        const tile = document.createElement('div');
        tile.className = 'mcp-hero-tile';
        // Inline shield-check SVG — matches the sidebar nav icon for visual coherence
        tile.innerHTML =
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>' +
            '<polyline points="8 12 11 15 16 9"></polyline>' +
            '</svg>';
        hero.appendChild(tile);

        const text = document.createElement('div');
        text.className = 'mcp-hero-text';

        const titleRow = document.createElement('div');
        titleRow.className = 'mcp-hero-title-row';
        const h1 = document.createElement('h2');
        h1.className = 'mcp-hero-title';
        h1.textContent = 'MCP Policies';
        titleRow.appendChild(h1);

        const cloudPill = document.createElement('span');
        cloudPill.className = 'mcp-cloud-pill';
        cloudPill.title = 'This surface only activates when the device is enrolled in a SecureVector cloud organization.';
        cloudPill.textContent = 'Cloud-only';
        titleRow.appendChild(cloudPill);

        text.appendChild(titleRow);

        const sub = document.createElement('p');
        sub.className = 'mcp-hero-sub';
        sub.textContent = 'Cloud-pushed tool rules being enforced on this device. Read-only — authoring lives in the SecureVector cloud admin.';
        text.appendChild(sub);

        hero.appendChild(text);

        // Sync Now action — disabled until the GET /policies response surfaces
        // can_refresh=true. Same button shows refresh / syncing / not-allowed
        // states via the can_refresh + refresh_blocker_reason signals.
        const actions = document.createElement('div');
        actions.className = 'mcp-hero-actions';
        const syncBtn = document.createElement('button');
        syncBtn.type = 'button';
        syncBtn.className = 'mcp-sync-now-btn';
        syncBtn.disabled = true;
        syncBtn.textContent = 'Sync now';
        syncBtn.title = 'Loading…';
        syncBtn.addEventListener('click', () => this._onSyncNow());
        // Refresh-circle icon (same shape as the rest of the app)
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('stroke-width', '2');
        icon.setAttribute('stroke-linecap', 'round');
        icon.setAttribute('stroke-linejoin', 'round');
        icon.classList.add('mcp-sync-icon');
        icon.innerHTML = '<polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>';
        syncBtn.prepend(icon);
        actions.appendChild(syncBtn);
        hero.appendChild(actions);

        return hero;
    },

    _buildErrorState(err) {
        const w = document.createElement('div');
        w.className = 'mcp-empty';
        const h = document.createElement('h3');
        h.textContent = "Couldn't load MCP Policies";
        w.appendChild(h);
        const p = document.createElement('p');
        p.textContent = err && err.message ? err.message : String(err);
        w.appendChild(p);
        return w;
    },

    _renderBody(container, data) {
        // Verification status row — 4-up stat tiles. Always renders; gives
        // the page weight even when no policies are active yet.
        container.appendChild(this._buildStatusGrid(data));

        // Two-column layout: policies main + context rail. On narrow screens
        // the rail wraps under (CSS @media handles it).
        const layout = document.createElement('div');
        layout.className = 'mcp-layout';
        const main = document.createElement('div');
        main.className = 'mcp-main';
        const rail = document.createElement('aside');
        rail.className = 'mcp-rail';
        layout.appendChild(main);
        layout.appendChild(rail);
        container.appendChild(layout);

        if (!data.any_active) {
            main.appendChild(this._buildEmptyState());
        } else {
            // Paginated table — matches the canonical pattern from threats.js
            // (DataTable + pagination footer). Click a row to open the detail
            // drawer with the full rule list + bundle id + footer.
            main.appendChild(this._buildPolicyTableHeader(data.policies));
            main.appendChild(this._buildPolicyTable(data.policies));
        }

        rail.appendChild(this._buildRail(data));
    },

    /**
     * Header strip above the table — summary count + (eventually) search box.
     * Search input fires only when ≥6 policies are present, otherwise hidden
     * for visual restraint.
     */
    _buildPolicyTableHeader(policies) {
        const header = document.createElement('div');
        header.className = 'mcp-table-header';

        const summary = document.createElement('div');
        summary.className = 'mcp-table-summary';
        const ruleTotal = policies.reduce((n, p) => n + (p.rule_count || 0), 0);
        const policyLbl = policies.length === 1 ? '1 policy' : policies.length + ' policies';
        const ruleLbl = ruleTotal === 1 ? '1 rule' : ruleTotal + ' rules';
        summary.textContent = `${policyLbl} · ${ruleLbl} total`;
        header.appendChild(summary);

        if (policies.length >= 6) {
            const search = document.createElement('input');
            search.type = 'search';
            search.className = 'mcp-table-search';
            search.placeholder = 'Filter by name, org, or tool…';
            search.addEventListener('input', (e) => {
                const q = e.target.value.toLowerCase().trim();
                this._filterTable(q, policies);
            });
            header.appendChild(search);
        }

        return header;
    },

    /**
     * Build the DataTable using the canonical project pattern.
     * Columns kept tight — name + org + version + rules + applied.
     * Clicking any row opens the SideDrawer with full detail.
     */
    _buildPolicyTable(policies) {
        const wrap = document.createElement('div');
        wrap.className = 'mcp-table-card';

        // DataTable expects an `id` field on each row for selection support.
        const rows = policies.map((p) => ({ ...p, id: p.policy_id }));
        const self = this;

        const table = new DataTable({
            tableId: 'mcp-policies-table',
            data: rows,
            idField: 'policy_id',
            sortKey: 'applied_at',
            sortDir: 'desc',
            pagination: { pageSize: 15 },
            emptyText: 'No org policies on this device.',
            columns: [
                {
                    key: 'policy_name',
                    label: 'Policy',
                    sortable: true,
                    render: (_, p) => {
                        const cell = document.createElement('div');
                        cell.className = 'mcp-cell-policy';

                        const tile = document.createElement('span');
                        tile.className = 'mcp-cell-tile';
                        tile.innerHTML =
                            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                            '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>' +
                            '<polyline points="8 12 11 15 16 9"></polyline></svg>';
                        cell.appendChild(tile);

                        const txt = document.createElement('div');
                        txt.className = 'mcp-cell-policy-text';
                        const name = document.createElement('div');
                        name.className = 'mcp-cell-policy-name';
                        name.textContent = p.policy_name || p.policy_id;
                        const sub = document.createElement('code');
                        sub.className = 'mcp-cell-policy-sub';
                        sub.textContent = p.policy_id;
                        txt.appendChild(name);
                        // Only show the policy_id below if a friendly name exists
                        if (p.policy_name) txt.appendChild(sub);
                        cell.appendChild(txt);
                        return cell;
                    },
                },
                {
                    key: 'org_name',
                    label: 'Organization',
                    sortable: true,
                    render: (_, p) => {
                        const span = document.createElement('span');
                        span.className = 'mcp-cell-org';
                        span.textContent = p.org_name || '—';
                        return span;
                    },
                },
                {
                    key: 'policy_version',
                    label: 'Version',
                    sortable: true,
                    render: (_, p) => {
                        const v = document.createElement('span');
                        v.className = 'mcp-cell-version';
                        v.textContent = 'v' + p.policy_version;
                        return v;
                    },
                },
                {
                    key: 'rule_count',
                    label: 'Rules',
                    sortable: true,
                    render: (_, p) => {
                        const v = document.createElement('span');
                        v.className = 'mcp-cell-count';
                        v.textContent = String(p.rule_count);
                        return v;
                    },
                },
                {
                    key: 'applied_at',
                    label: 'Applied',
                    sortable: true,
                    render: (_, p) => {
                        const span = document.createElement('span');
                        span.className = 'mcp-cell-time';
                        span.textContent = self._relTime(p.applied_at);
                        span.title = p.applied_at || '';
                        return span;
                    },
                },
                {
                    key: '_status',
                    label: 'Status',
                    render: (_, _p) => {
                        // Per-policy verification status isn't tracked yet — the
                        // overall snapshot in the status grid is the source of truth
                        // for now. Mirror the overall status onto every row so the
                        // table doesn't lie when the bundle has expired/drifted.
                        const overall = (self._data && self._data.verification_status) || 'match';
                        const label = overall === 'match' ? '✓ MATCH'
                                    : overall === 'degraded' ? '⚠ DEGRADED'
                                    : '✖ EXPIRED';
                        const wrap = document.createElement('span');
                        wrap.className = 'mcp-cell-status mcp-cell-status-' + overall;
                        wrap.textContent = label;
                        return wrap;
                    },
                },
            ],
            customSort: (data, key, dir) => {
                const d = dir === 'asc' ? 1 : -1;
                return data.sort((a, b) => {
                    let va, vb;
                    if (key === 'applied_at') {
                        return ((new Date(a.applied_at).getTime() || 0)
                              - (new Date(b.applied_at).getTime() || 0)) * d;
                    }
                    if (key === 'policy_version' || key === 'rule_count') {
                        return ((a[key] || 0) - (b[key] || 0)) * d;
                    }
                    if (key === 'policy_name') {
                        va = (a.policy_name || a.policy_id || '').toLowerCase();
                        vb = (b.policy_name || b.policy_id || '').toLowerCase();
                    } else {
                        va = (a[key] || '').toString().toLowerCase();
                        vb = (b[key] || '').toString().toLowerCase();
                    }
                    return va < vb ? -1 * d : va > vb ? 1 * d : 0;
                });
            },
            onRowClick: (p) => self._openPolicyDrawer(p),
        });

        // Hold a reference for the search filter to call into.
        this._table = table;
        this._allPolicies = policies;

        wrap.appendChild(table.el);
        return wrap;
    },

    _filterTable(q, allPolicies) {
        if (!this._table) return;
        if (!q) { this._table.setData(allPolicies.map((p) => ({ ...p, id: p.policy_id }))); return; }
        const matches = allPolicies.filter((p) => {
            const haystack = [
                p.policy_name, p.policy_id, p.org_name,
                ...(p.rules || []).map((r) => r.tool_id),
            ].filter(Boolean).join(' ').toLowerCase();
            return haystack.includes(q);
        });
        this._table.setData(matches.map((p) => ({ ...p, id: p.policy_id })));
    },

    /**
     * Side drawer with the full policy detail — rules list, bundle id,
     * provenance footer. Reuses the existing card builder so visual
     * detail rendering stays in one place.
     */
    _openPolicyDrawer(policy) {
        const content = this._buildPolicyCard(policy);
        // Drop the outer hover-glow border treatment when rendered in a drawer
        // (the drawer already has its own chrome).
        content.classList.add('mcp-policy-in-drawer');
        SideDrawer.show({
            title: policy.policy_name || policy.policy_id,
            content,
        });
    },

    // -------- Verification status grid --------

    _buildStatusGrid(data) {
        const status = data.verification_status || 'match';
        const grid = document.createElement('div');
        grid.className = 'mcp-status-grid mcp-status-' + status;

        // Tile 1 — overall verification status
        const statusGlyph = status === 'match' ? '✓' : status === 'degraded' ? '⚠' : '✖';
        const statusLabel = status === 'match' ? 'MATCH' : status === 'degraded' ? 'DEGRADED' : 'EXPIRED';
        grid.appendChild(this._buildStatTile({
            kind: status,
            label: 'Policy Sync',
            value: statusLabel,
            glyph: statusGlyph,
            sub: status === 'match'
                ? 'Bundle signature verified'
                : status === 'degraded'
                    ? 'Sync drift detected'
                    : 'Falling back to local rules',
        }));

        // Tile 2 — last poll
        grid.appendChild(this._buildStatTile({
            label: 'Last poll',
            value: this._relTime(data.health.last_poll_at),
            sub: data.health.last_poll_status
                ? this._humanPollStatus(data.health.last_poll_status)
                : 'Awaiting first poll',
        }));

        // Tile 3 — bundle freshness countdown
        const remain = data.health.freshness_remaining_seconds;
        grid.appendChild(this._buildStatTile({
            label: 'Bundle expires',
            value: remain != null && remain > 0 ? this._fmtDuration(remain) : '—',
            sub: remain != null && remain > 0
                ? 'Refreshes on next successful poll'
                : 'No active bundle',
        }));

        // Tile 4 — mismatch counter / verification button
        const mm = data.health.consecutive_mismatch_count || 0;
        grid.appendChild(this._buildStatTile({
            kind: mm > 0 ? 'degraded' : 'neutral',
            label: 'Mismatches',
            value: String(mm),
            sub: mm > 0 ? 'Consecutive verify failures' : 'Clean streak',
            extra: this._buildVerifyToggle(data),
        }));

        // Audit panel — collapses below the grid
        if (this._detailsExpanded) {
            grid.appendChild(this._buildAuditPanel(data));
        }
        return grid;
    },

    _buildStatTile({ kind = 'neutral', label, value, glyph, sub, extra }) {
        const tile = document.createElement('div');
        tile.className = 'mcp-stat-tile mcp-stat-' + kind;

        const lbl = document.createElement('div');
        lbl.className = 'mcp-stat-label';
        lbl.textContent = label;
        tile.appendChild(lbl);

        const valueRow = document.createElement('div');
        valueRow.className = 'mcp-stat-value-row';
        if (glyph) {
            const g = document.createElement('span');
            g.className = 'mcp-stat-glyph';
            g.textContent = glyph;
            valueRow.appendChild(g);
        }
        const v = document.createElement('span');
        v.className = 'mcp-stat-value';
        v.textContent = value;
        valueRow.appendChild(v);
        tile.appendChild(valueRow);

        if (sub) {
            const s = document.createElement('div');
            s.className = 'mcp-stat-sub';
            s.textContent = sub;
            tile.appendChild(s);
        }
        if (extra) tile.appendChild(extra);
        return tile;
    },

    _buildVerifyToggle(data) {
        const wrap = document.createElement('div');
        wrap.className = 'mcp-verify-toggle-wrap';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mcp-verify-toggle';
        btn.textContent = this._detailsExpanded ? 'Hide signing details' : 'Verify signing chain';
        btn.addEventListener('click', () => {
            this._detailsExpanded = !this._detailsExpanded;
            // Re-render whole body to reflow the audit panel inline
            const container = document.querySelector('#page-content > .page-content-inner') || document.getElementById('page-content');
            if (container) this.render(container);
        });
        wrap.appendChild(btn);
        return wrap;
    },

    _buildAuditPanel(data) {
        const panel = document.createElement('div');
        panel.className = 'mcp-audit-panel';

        const title = document.createElement('div');
        title.className = 'mcp-audit-title';
        title.textContent = 'Signing chain';
        panel.appendChild(title);

        const rows = [
            ['Last poll',         data.health.last_poll_at || '—'],
            ['Last poll status',  this._humanPollStatus(data.health.last_poll_status) || '—'],
            ['Last MATCH',        data.health.last_match_at || '—'],
            ['Mismatches',        String(data.health.consecutive_mismatch_count ?? 0)],
            ['Freshness left',    data.health.freshness_remaining_seconds == null
                ? '—'
                : this._fmtDuration(data.health.freshness_remaining_seconds)],
            ['Signing key',       data.health.signing_key_fingerprint || 'Not yet captured (no successful apply this session)'],
        ];

        const dl = document.createElement('dl');
        dl.className = 'mcp-audit-dl';
        for (const [label, value] of rows) {
            const dt = document.createElement('dt');
            dt.textContent = label;
            const dd = document.createElement('dd');
            dd.textContent = value;
            dl.appendChild(dt);
            dl.appendChild(dd);
        }
        panel.appendChild(dl);
        return panel;
    },

    // -------- Policy card --------

    _buildPolicyCard(policy) {
        const card = document.createElement('article');
        card.className = 'mcp-policy';
        card.id = 'policy-' + policy.policy_id;

        // Head row — icon tile + name + version + rule-count pill
        const head = document.createElement('header');
        head.className = 'mcp-policy-head';

        const tile = document.createElement('div');
        tile.className = 'mcp-policy-tile';
        tile.innerHTML =
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>' +
            '<polyline points="8 12 11 15 16 9"></polyline>' +
            '</svg>';
        head.appendChild(tile);

        const titleCol = document.createElement('div');
        titleCol.className = 'mcp-policy-title-col';
        const name = document.createElement('h3');
        name.className = 'mcp-policy-name';
        name.textContent = policy.policy_name || policy.policy_id;
        titleCol.appendChild(name);

        const meta = document.createElement('div');
        meta.className = 'mcp-policy-meta';
        const items = [];
        if (policy.org_name) items.push({ label: 'Org', value: policy.org_name });
        if (policy.admin_email) items.push({ label: 'Admin', value: policy.admin_email });
        items.push({ label: 'Applied', value: this._relTime(policy.applied_at) });
        for (const it of items) {
            const tag = document.createElement('span');
            tag.className = 'mcp-meta-tag';
            const k = document.createElement('span');
            k.className = 'mcp-meta-tag-k';
            k.textContent = it.label;
            const v = document.createElement('span');
            v.className = 'mcp-meta-tag-v';
            v.textContent = it.value;
            tag.appendChild(k);
            tag.appendChild(v);
            meta.appendChild(tag);
        }
        titleCol.appendChild(meta);
        head.appendChild(titleCol);

        const badges = document.createElement('div');
        badges.className = 'mcp-policy-badges';
        const verBadge = document.createElement('span');
        verBadge.className = 'mcp-policy-version';
        verBadge.textContent = 'v' + policy.policy_version;
        badges.appendChild(verBadge);
        const cnt = document.createElement('span');
        cnt.className = 'mcp-policy-count';
        cnt.textContent = policy.rule_count + (policy.rule_count === 1 ? ' rule' : ' rules');
        badges.appendChild(cnt);
        head.appendChild(badges);

        card.appendChild(head);

        // Bundle id strip — copyable, mono, distinct surface
        const bundle = document.createElement('div');
        bundle.className = 'mcp-bundle-strip';
        const bLbl = document.createElement('span');
        bLbl.className = 'mcp-bundle-label';
        bLbl.textContent = 'BUNDLE';
        const bId = document.createElement('code');
        bId.className = 'mcp-bundle-id';
        bId.textContent = policy.bundle_id;
        const bCopy = document.createElement('button');
        bCopy.type = 'button';
        bCopy.className = 'mcp-bundle-copy';
        bCopy.textContent = 'Copy';
        bCopy.addEventListener('click', () => {
            navigator.clipboard.writeText(policy.bundle_id).then(() => {
                bCopy.textContent = 'Copied';
                bCopy.classList.add('mcp-bundle-copied');
                setTimeout(() => {
                    bCopy.textContent = 'Copy';
                    bCopy.classList.remove('mcp-bundle-copied');
                }, 1500);
            });
        });
        bundle.appendChild(bLbl);
        bundle.appendChild(bId);
        bundle.appendChild(bCopy);
        card.appendChild(bundle);

        // Rules — each as an enforcement row, not a table cell
        const rules = policy.rules || [];
        if (rules.length) {
            const rulesWrap = document.createElement('div');
            rulesWrap.className = 'mcp-rules';
            for (const rule of rules) rulesWrap.appendChild(this._buildRuleRow(rule));
            card.appendChild(rulesWrap);
        }

        // Footer — read-only routing
        const footer = document.createElement('footer');
        footer.className = 'mcp-policy-footer';
        const lock = document.createElement('span');
        lock.className = 'mcp-footer-lock';
        lock.textContent = '🔒';
        footer.appendChild(lock);
        const ftxt = document.createElement('span');
        ftxt.className = 'mcp-footer-text';
        ftxt.textContent = policy.admin_email
            ? 'Cloud-managed by ' + policy.admin_email + '. To change these rules, contact your org admin.'
            : 'Cloud-managed. To change these rules, contact your org admin.';
        footer.appendChild(ftxt);
        card.appendChild(footer);

        return card;
    },

    _buildRuleRow(rule) {
        const row = document.createElement('div');
        row.className = 'mcp-rule mcp-rule-' + rule.effect;
        row.id = 'tool-' + rule.tool_id;

        // Effect column — bold, full-height accent block
        const effect = document.createElement('div');
        effect.className = 'mcp-rule-effect-col';
        const effectLbl = document.createElement('span');
        effectLbl.className = 'mcp-rule-effect-lbl';
        effectLbl.textContent = rule.effect.toUpperCase();
        effect.appendChild(effectLbl);
        row.appendChild(effect);

        // Body — tool id + meta + reason
        const body = document.createElement('div');
        body.className = 'mcp-rule-body';

        const toolRow = document.createElement('div');
        toolRow.className = 'mcp-rule-tool-row';
        const toolCode = document.createElement('code');
        toolCode.className = 'mcp-rule-tool';
        toolCode.textContent = rule.tool_id;
        toolRow.appendChild(toolCode);
        body.appendChild(toolRow);

        const meta = document.createElement('div');
        meta.className = 'mcp-rule-meta';
        const pri = document.createElement('span');
        pri.className = 'mcp-rule-tag';
        pri.textContent = 'priority ' + rule.priority;
        meta.appendChild(pri);
        if (rule.shadows_local_count > 0) {
            const sh = document.createElement('span');
            sh.className = 'mcp-rule-tag mcp-rule-tag-warn';
            sh.textContent = 'shadows ' + rule.shadows_local_count + ' local';
            meta.appendChild(sh);
        }
        body.appendChild(meta);

        if (rule.reason) {
            const reason = document.createElement('blockquote');
            reason.className = 'mcp-rule-reason';
            reason.textContent = rule.reason;
            body.appendChild(reason);
        }
        row.appendChild(body);

        return row;
    },

    // -------- Empty state --------

    _buildEmptyState() {
        const wrap = document.createElement('div');
        wrap.className = 'mcp-empty';

        const tile = document.createElement('div');
        tile.className = 'mcp-empty-tile';
        tile.textContent = '☁';
        wrap.appendChild(tile);

        const h = document.createElement('h3');
        h.textContent = 'No org policies on this device';
        wrap.appendChild(h);

        const p = document.createElement('p');
        p.textContent =
            "MCP Policies is a cloud-tier feature. This device isn't currently receiving any policies — either it isn't enrolled in an organization, or no policies apply to it.";
        wrap.appendChild(p);

        const cmd = document.createElement('div');
        cmd.className = 'mcp-empty-cmd';
        const cmdLabel = document.createElement('span');
        cmdLabel.className = 'mcp-empty-cmd-label';
        cmdLabel.textContent = 'TO ENROLL';
        const cmdCode = document.createElement('code');
        cmdCode.textContent = 'securevector-app enroll <svet_token>';
        cmd.appendChild(cmdLabel);
        cmd.appendChild(cmdCode);
        wrap.appendChild(cmd);

        return wrap;
    },

    // -------- Right rail --------

    _buildRail(data) {
        const wrap = document.createElement('div');
        wrap.className = 'mcp-rail-inner';

        // What this is
        wrap.appendChild(this._buildRailCard({
            title: 'What this is',
            body:
                'Tool rules pushed from your SecureVector cloud organization. ' +
                'They sit on top of your local Tool Permissions and override them when they conflict.',
        }));

        // Cloud-only callout
        wrap.appendChild(this._buildRailCard({
            kind: 'accent',
            title: '☁  Cloud-only feature',
            body:
                'Personal-mode installs (no enrollment) bypass this entirely. ' +
                'Policy Sync only activates after a successful svet_* token redeem.',
        }));

        // Precedence map
        const prec = document.createElement('div');
        prec.className = 'mcp-rail-card';
        const ph = document.createElement('div');
        ph.className = 'mcp-rail-title';
        ph.textContent = 'Enforcement precedence';
        prec.appendChild(ph);
        const ol = document.createElement('ol');
        ol.className = 'mcp-precedence';
        for (const [n, lbl, sub] of [
            ['1', 'Last-resort rules', 'Compiled-in safety blocks'],
            ['2', 'Cloud-synced rules', 'Right here'],
            ['3', 'Local Tool Permissions', 'Your overrides'],
            ['4', 'Tool default', 'Registry defaults'],
        ]) {
            const li = document.createElement('li');
            const num = document.createElement('span');
            num.className = 'mcp-prec-num';
            num.textContent = n;
            const txt = document.createElement('div');
            txt.className = 'mcp-prec-txt';
            const t1 = document.createElement('div');
            t1.className = 'mcp-prec-label';
            t1.textContent = lbl;
            const t2 = document.createElement('div');
            t2.className = 'mcp-prec-sub';
            t2.textContent = sub;
            txt.appendChild(t1);
            txt.appendChild(t2);
            li.appendChild(num);
            li.appendChild(txt);
            ol.appendChild(li);
        }
        prec.appendChild(ol);
        wrap.appendChild(prec);

        // Quick links
        const links = document.createElement('div');
        links.className = 'mcp-rail-card';
        const lh = document.createElement('div');
        lh.className = 'mcp-rail-title';
        lh.textContent = 'Related';
        links.appendChild(lh);
        for (const [page, label, desc] of [
            ['tool-permissions', 'Tool Permissions', 'See how synced rules layer over local'],
            ['replay', 'Agent Activity', 'Audit trail of allow/block decisions'],
            ['guide', 'Guide', 'How Policy Sync works end-to-end'],
        ]) {
            const a = document.createElement('a');
            a.className = 'mcp-rail-link';
            a.href = '#';
            a.addEventListener('click', (e) => {
                e.preventDefault();
                if (window.Sidebar) Sidebar.navigate(page);
            });
            const ll = document.createElement('div');
            ll.className = 'mcp-rail-link-label';
            ll.textContent = label;
            const ld = document.createElement('div');
            ld.className = 'mcp-rail-link-desc';
            ld.textContent = desc;
            const arrow = document.createElement('span');
            arrow.className = 'mcp-rail-link-arrow';
            arrow.textContent = '→';
            const txtCol = document.createElement('div');
            txtCol.appendChild(ll);
            txtCol.appendChild(ld);
            a.appendChild(txtCol);
            a.appendChild(arrow);
            links.appendChild(a);
        }
        wrap.appendChild(links);
        return wrap;
    },

    _buildRailCard({ title, body, kind }) {
        const c = document.createElement('div');
        c.className = 'mcp-rail-card' + (kind ? ' mcp-rail-' + kind : '');
        const t = document.createElement('div');
        t.className = 'mcp-rail-title';
        t.textContent = title;
        const b = document.createElement('p');
        b.className = 'mcp-rail-body';
        b.textContent = body;
        c.appendChild(t);
        c.appendChild(b);
        return c;
    },

    // -------- Helpers --------

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

    _fmtDuration(seconds) {
        if (seconds == null || seconds < 0) return '—';
        const hr = Math.floor(seconds / 3600);
        const min = Math.floor((seconds % 3600) / 60);
        if (hr > 0) return hr + 'h ' + min + 'm';
        return min + 'm';
    },
};
