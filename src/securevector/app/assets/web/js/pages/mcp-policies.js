/**
 * MCP Policies Page
 *
 * Read-only viewer for cloud-pushed MCP policies. Three jobs:
 *   1. Provenance — what's pushed onto this device, by whom, when.
 *   2. Routing — who do I escalate to when a synced rule blocks something.
 *   3. Health — is the cloud→local pipe alive, or am I drifting?
 *
 * Data source: GET /api/v1/policy-sync/policies. The page never writes;
 * authoring lives in the cloud admin UI ("MCP Policies" sidebar over there).
 *
 * Trust signals follow the design from the local-visibility plan:
 *  - Verification banner: tiered match | degraded | error per the cloud_sync
 *    health snapshot. Auto-clears when a successful poll resumes.
 *  - "Show verification details" expand reveals signing key fingerprint,
 *    last-poll timestamp + status, freshness countdown — gated by user
 *    click OR ?audit=1 on the URL (the auditor entry point).
 *  - Per-rule reason fields are HTML-escaped via textContent — admin
 *    free-text MUST NOT be rendered as live HTML (XSS surface).
 */

// Capture ?audit=1 at script-load time — the SPA router strips the query
// string when it pushState()s after the initial paint, so by the time render()
// runs location.search is empty. We only honour the flag once per page load
// (sticky for that browser tab; revisit by re-loading the URL).
const _MCP_AUDIT_ENTRY = (() => {
    try {
        return new URLSearchParams(window.location.search).get('audit') === '1';
    } catch (_) {
        return false;
    }
})();

const McpPoliciesPage = {
    // Cached response so the audit toggle doesn't re-fetch.
    _data: null,
    _detailsExpanded: false,

    async render(container) {
        container.textContent = '';

        // Default-expand verification details when entered via /mcp-policies?audit=1
        // OR when the user has already toggled it on this session (sticky).
        this._detailsExpanded = this._detailsExpanded || _MCP_AUDIT_ENTRY;

        const intro = this._buildIntro();
        container.appendChild(intro);

        // Loading state — replaced once the fetch resolves
        const loading = document.createElement('div');
        loading.className = 'loading-container';
        const spinner = document.createElement('div');
        spinner.className = 'spinner';
        loading.appendChild(spinner);
        container.appendChild(loading);

        try {
            const data = await API.request('/api/v1/policy-sync/policies');
            this._data = data;
            container.removeChild(loading);
            this._renderBody(container, data);
        } catch (err) {
            container.removeChild(loading);
            container.appendChild(this._buildErrorState(err));
        }
    },

    _buildIntro() {
        const wrap = document.createElement('div');
        wrap.className = 'page-intro';

        const h1 = document.createElement('h2');
        h1.textContent = 'MCP Policies';
        wrap.appendChild(h1);

        const p = document.createElement('p');
        p.className = 'page-intro-subtitle';
        p.textContent =
            'Org-managed tool rules synced from your SecureVector cloud. ' +
            'Read-only — authoring lives in the cloud admin UI.';
        wrap.appendChild(p);

        return wrap;
    },

    _buildErrorState(err) {
        const wrap = document.createElement('div');
        wrap.className = 'mcp-policy-empty';
        const h = document.createElement('h3');
        h.textContent = "Couldn't load MCP Policies";
        wrap.appendChild(h);
        const p = document.createElement('p');
        p.textContent = err && err.message ? err.message : String(err);
        wrap.appendChild(p);
        return wrap;
    },

    _renderBody(container, data) {
        // Verification banner first — sets the trust frame for everything below
        container.appendChild(this._buildVerificationBanner(data));

        if (!data.any_active) {
            container.appendChild(this._buildEmptyState());
            return;
        }

        const list = document.createElement('div');
        list.className = 'mcp-policy-list';
        for (const policy of data.policies) {
            list.appendChild(this._buildPolicyCard(policy));
        }
        container.appendChild(list);
    },

    _buildEmptyState() {
        const wrap = document.createElement('div');
        wrap.className = 'mcp-policy-empty';
        const h = document.createElement('h3');
        h.textContent = 'No org policies synced yet';
        wrap.appendChild(h);
        const p = document.createElement('p');
        p.textContent =
            "This device isn't currently receiving any cloud-pushed MCP policies. " +
            "Either it isn't enrolled in an organization, or no policies apply to it. " +
            "Run `securevector-app enroll <token>` to enroll, then return here.";
        wrap.appendChild(p);
        return wrap;
    },

    _buildVerificationBanner(data) {
        const wrap = document.createElement('div');
        const status = data.verification_status || 'match';
        wrap.className = 'mcp-verification-banner mcp-verif-' + status;

        // First row: status icon + concise headline
        const top = document.createElement('div');
        top.className = 'mcp-verif-top';

        const icon = document.createElement('span');
        icon.className = 'mcp-verif-icon';
        // Plain unicode glyphs — no img/svg dependency, render at any font size
        icon.textContent =
            status === 'match' ? '✓' :
            status === 'degraded' ? '⚠' :
            '✖';
        top.appendChild(icon);

        const headline = document.createElement('span');
        headline.className = 'mcp-verif-headline';
        if (status === 'match') {
            headline.textContent = 'Policy Sync MATCH';
        } else if (status === 'degraded') {
            headline.textContent = 'Policy Sync DEGRADED — last good apply was ' + this._relTime(data.health.last_match_at);
        } else {
            headline.textContent = 'Policy Sync ERROR — bundle expired, falling back to local rules only';
        }
        top.appendChild(headline);
        wrap.appendChild(top);

        // Second row: liveness summary + toggle
        const meta = document.createElement('div');
        meta.className = 'mcp-verif-meta';
        const summary = document.createElement('span');
        const lastPoll = data.health.last_poll_at;
        const remainSec = data.health.freshness_remaining_seconds;
        const parts = [];
        if (lastPoll) {
            parts.push('last poll ' + this._relTime(lastPoll));
        }
        if (remainSec != null && remainSec > 0) {
            parts.push('bundle expires in ' + this._fmtDuration(remainSec));
        }
        summary.textContent = parts.length ? parts.join(' · ') : 'No polls yet — waiting for first sync';
        meta.appendChild(summary);

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'mcp-verif-toggle';
        toggle.textContent = this._detailsExpanded ? 'Hide verification details' : 'Show verification details';
        toggle.addEventListener('click', () => {
            this._detailsExpanded = !this._detailsExpanded;
            // Re-render just this banner in place — cheap, keeps state local
            const newBanner = this._buildVerificationBanner(this._data);
            wrap.replaceWith(newBanner);
        });
        meta.appendChild(toggle);
        wrap.appendChild(meta);

        // Audit panel (collapsible). Only mounted when expanded so the DOM
        // stays light for the casual-user default view.
        if (this._detailsExpanded) {
            wrap.appendChild(this._buildAuditPanel(data));
        }

        return wrap;
    },

    _buildAuditPanel(data) {
        const panel = document.createElement('div');
        panel.className = 'mcp-verif-audit';

        const rows = [
            ['Last poll',         data.health.last_poll_at || '—'],
            ['Last poll status',  data.health.last_poll_status || '—'],
            ['Last MATCH',        data.health.last_match_at || '—'],
            ['Consecutive mismatches', String(data.health.consecutive_mismatch_count ?? 0)],
            ['Bundle freshness remaining',
                data.health.freshness_remaining_seconds == null
                    ? '—'
                    : this._fmtDuration(data.health.freshness_remaining_seconds)],
            ['Signing key',       data.health.signing_key_fingerprint || 'Not yet captured (no successful apply this session)'],
        ];

        const dl = document.createElement('dl');
        dl.className = 'mcp-verif-dl';
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

    _buildPolicyCard(policy) {
        const card = document.createElement('div');
        card.className = 'mcp-policy-card';
        card.id = 'policy-' + policy.policy_id;

        // Header row — name + version + rule count
        const head = document.createElement('div');
        head.className = 'mcp-policy-head';

        const titleCol = document.createElement('div');
        titleCol.className = 'mcp-policy-title-col';

        const name = document.createElement('h3');
        name.className = 'mcp-policy-name';
        name.textContent = policy.policy_name || policy.policy_id;
        titleCol.appendChild(name);

        const sub = document.createElement('div');
        sub.className = 'mcp-policy-sub';
        const provenanceParts = [];
        if (policy.org_name) provenanceParts.push(policy.org_name);
        if (policy.admin_email) provenanceParts.push(policy.admin_email);
        provenanceParts.push('applied ' + this._relTime(policy.applied_at));
        sub.textContent = provenanceParts.join(' · ');
        titleCol.appendChild(sub);

        head.appendChild(titleCol);

        const badges = document.createElement('div');
        badges.className = 'mcp-policy-badges';

        const versionBadge = document.createElement('span');
        versionBadge.className = 'mcp-policy-badge mcp-policy-badge-version';
        versionBadge.textContent = 'v' + policy.policy_version;
        badges.appendChild(versionBadge);

        const countBadge = document.createElement('span');
        countBadge.className = 'mcp-policy-badge mcp-policy-badge-count';
        countBadge.textContent = policy.rule_count + (policy.rule_count === 1 ? ' rule' : ' rules');
        badges.appendChild(countBadge);

        head.appendChild(badges);
        card.appendChild(head);

        // Bundle id row — copyable for incident triage
        const bundleRow = document.createElement('div');
        bundleRow.className = 'mcp-policy-bundle';
        const bundleLabel = document.createElement('span');
        bundleLabel.className = 'mcp-policy-bundle-label';
        bundleLabel.textContent = 'bundle';
        const bundleId = document.createElement('code');
        bundleId.textContent = policy.bundle_id;
        const bundleCopy = document.createElement('button');
        bundleCopy.type = 'button';
        bundleCopy.className = 'mcp-policy-bundle-copy';
        bundleCopy.textContent = 'Copy';
        bundleCopy.addEventListener('click', () => {
            navigator.clipboard.writeText(policy.bundle_id).then(() => {
                bundleCopy.textContent = 'Copied';
                setTimeout(() => { bundleCopy.textContent = 'Copy'; }, 1500);
            });
        });
        bundleRow.appendChild(bundleLabel);
        bundleRow.appendChild(bundleId);
        bundleRow.appendChild(bundleCopy);
        card.appendChild(bundleRow);

        // Rules table
        const rules = policy.rules || [];
        if (rules.length) {
            card.appendChild(this._buildRulesTable(rules));
        }

        // Footer — read-only routing hint
        const footer = document.createElement('div');
        footer.className = 'mcp-policy-footer';
        footer.textContent =
            policy.admin_email
                ? 'Cloud-managed by ' + policy.admin_email + '. To change these rules, contact your org admin.'
                : 'Cloud-managed. To change these rules, contact your org admin.';
        card.appendChild(footer);

        return card;
    },

    _buildRulesTable(rules) {
        const tbl = document.createElement('div');
        tbl.className = 'mcp-policy-rules';

        for (const rule of rules) {
            const row = document.createElement('div');
            row.className = 'mcp-policy-rule-row mcp-rule-' + rule.effect;
            row.id = 'tool-' + rule.tool_id;

            const effect = document.createElement('span');
            effect.className = 'mcp-rule-effect';
            effect.textContent = rule.effect.toUpperCase();
            row.appendChild(effect);

            const body = document.createElement('div');
            body.className = 'mcp-rule-body';

            const tool = document.createElement('div');
            tool.className = 'mcp-rule-tool';
            const toolCode = document.createElement('code');
            toolCode.textContent = rule.tool_id;
            tool.appendChild(toolCode);
            body.appendChild(tool);

            const meta = document.createElement('div');
            meta.className = 'mcp-rule-meta';
            const metaParts = ['priority ' + rule.priority];
            if (rule.shadows_local_count > 0) {
                metaParts.push(
                    'shadows ' + rule.shadows_local_count +
                    ' local rule' + (rule.shadows_local_count === 1 ? '' : 's')
                );
            }
            meta.textContent = metaParts.join(' · ');
            body.appendChild(meta);

            // Reason — admin free-text. textContent escapes; never innerHTML.
            if (rule.reason) {
                const reason = document.createElement('div');
                reason.className = 'mcp-rule-reason';
                reason.textContent = '“' + rule.reason + '”';
                body.appendChild(reason);
            }

            row.appendChild(body);
            tbl.appendChild(row);
        }

        return tbl;
    },

    // Helpers — relative time + duration formatters

    _relTime(iso) {
        if (!iso) return '—';
        try {
            const then = new Date(iso).getTime();
            const now = Date.now();
            const diffMs = now - then;
            if (diffMs < 0) return 'in the future';
            const sec = Math.floor(diffMs / 1000);
            if (sec < 60) return sec + 's ago';
            const min = Math.floor(sec / 60);
            if (min < 60) return min + 'm ago';
            const hr = Math.floor(min / 60);
            if (hr < 24) return hr + 'h ago';
            const day = Math.floor(hr / 24);
            return day + 'd ago';
        } catch (_) {
            return iso;
        }
    },

    _fmtDuration(seconds) {
        if (seconds == null || seconds < 0) return '—';
        const hr = Math.floor(seconds / 3600);
        const min = Math.floor((seconds % 3600) / 60);
        if (hr > 0) return hr + 'h ' + min + 'm';
        return min + 'm';
    },
};
