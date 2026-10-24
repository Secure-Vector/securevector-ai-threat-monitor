/**
 * SecureVector API Client
 * Wrapper for all API calls to the local FastAPI server
 */

const API = {
    baseUrl: '',  // Empty for same-origin requests

    /**
     * Make an API request
     */
    async request(endpoint, options = {}) {
        const url = `${this.baseUrl}${endpoint}`;
        const config = {
            headers: {
                'Content-Type': 'application/json',
                ...options.headers,
            },
            ...options,
        };

        try {
            const response = await fetch(url, config);

            if (!response.ok) {
                const error = await response.json().catch(() => ({ detail: 'Request failed' }));
                throw new Error(error.detail || `HTTP ${response.status}`);
            }

            if (response.status === 204) {
                return {};
            }

            return await response.json();
        } catch (error) {
            console.error(`API Error [${endpoint}]:`, error);
            throw error;
        }
    },

    // ==================== Health ====================

    async health() {
        return this.request('/health');
    },

    // ==================== Analyze ====================

    async analyze(content) {
        return this.request('/analyze', {
            method: 'POST',
            body: JSON.stringify({ text: content }),
        });
    },

    // ==================== Threat Analytics ====================

    async getThreatAnalytics() {
        // Get dashboard summary from threat intel and rules
        try {
            const [threats, rules] = await Promise.all([
                this.getThreats({ page_size: 50 }),
                this.getRules(),
            ]);

            const items = threats.items || [];
            const totalCount = threats.total || items.length;  // Use total from API response
            const ruleItems = rules.items || [];

            // Calculate stats from available items (sample)
            const criticalCount = items.filter(t => t.risk_score >= 80).length;
            const recentThreats = items.slice(0, 5);
            const activeRulesCount = ruleItems.filter(r => r.enabled).length;

            // Group by type
            const threatTypes = {};
            items.forEach(t => {
                const type = t.threat_type || 'unknown';
                threatTypes[type] = (threatTypes[type] || 0) + 1;
            });

            // Compute average analysis latency from items with recorded processing time
            const latencyItems = items.filter(t => t.processing_time_ms > 0);
            const avgLatencyMs = latencyItems.length > 0
                ? latencyItems.reduce((sum, t) => sum + t.processing_time_ms, 0) / latencyItems.length
                : null;

            return {
                total_threats: totalCount,  // Use actual total from API
                critical_count: criticalCount,
                blocked_count: items.filter(t => t.action_taken === 'blocked').length,
                active_rules: activeRulesCount,
                recent_threats: recentThreats,
                threat_types: threatTypes,
                avg_latency_ms: avgLatencyMs,
            };
        } catch (e) {
            return {
                total_threats: 0,
                critical_count: 0,
                blocked_count: 0,
                active_rules: 0,
                recent_threats: [],
                threat_types: {},
            };
        }
    },

    // ==================== Threat Intel ====================

    // Bundle 0.4 — Agent Replay Timeline. Merged feed of scans + tool-audits + cost
    // records, sorted by time DESC. See routes/replay.py for the server side.
    async getReplayTimeline(params = {}) {
        const q = new URLSearchParams();
        if (params.agent) q.set('agent', params.agent);
        if (params.since) q.set('since', params.since);
        if (params.until) q.set('until', params.until);
        if (params.limit) q.set('limit', params.limit);
        if (params.kinds && params.kinds.length) q.set('include_kinds', params.kinds.join(','));
        const qs = q.toString();
        return this.request(`/api/replay/timeline${qs ? '?' + qs : ''}`).catch(() => ({
            items: [], total: 0, agents: [], filters: {},
        }));
    },

    // active-agent-observability #143 — Agent–Tool Live Graph. Agent nodes
    // (runtime) → tool/MCP nodes, edges colored by enforcement outcome.
    // See routes/graph.py for the server side.
    async getAgentToolGraph(params = {}) {
        const q = new URLSearchParams();
        if (params.window_days) q.set('window_days', params.window_days);
        const qs = q.toString();
        return this.request(`/api/graph/agent-tool${qs ? '?' + qs : ''}`).catch(() => ({
            window_days: params.window_days || 7,
            node_cap: 0, truncated: false, dropped_edges: 0, nodes: [], edges: [],
        }));
    },

    // active-agent-observability — 3-layer Agent Map. harness → agent/session →
    // tool nodes; session nodes carry num ("agent #N"), active, idle_days. Edges
    // tiered (harness-session / session-tool). See routes/graph.py build_graph_3layer.
    async getAgentSessionGraph(params = {}) {
        const q = new URLSearchParams();
        if (params.window_days) q.set('window_days', params.window_days);
        const qs = q.toString();
        return this.request(`/api/graph/agent-session${qs ? '?' + qs : ''}`).catch(() => ({
            window_days: params.window_days || 7,
            node_cap: 0, truncated: false, dropped_edges: 0, nodes: [], edges: [],
        }));
    },

    // active-agent-observability #142 — Agent Run Trace. Runs (one per agent
    // session) and the ordered enforced-tool-call spans within a run.
    async getTraces(params = {}) {
        const q = new URLSearchParams();
        if (params.window_days) q.set('window_days', params.window_days);
        if (params.limit) q.set('limit', params.limit);
        // health: 'loop' | 'failing' | 'wasteful' filters; 0 skips health.
        if (params.health != null) q.set('health', params.health);
        const qs = q.toString();
        return this.request(`/api/traces${qs ? '?' + qs : ''}`).catch(() => ({
            window_days: params.window_days || 7, runs: [],
        }));
    },

    async getTrace(traceId) {
        return this.request(`/api/traces/${encodeURIComponent(traceId)}`).catch(() => null);
    },

    // Run health: one run's findings, and findings across runs in a window.
    async getTraceHealth(traceId) {
        return this.request(`/api/traces/${encodeURIComponent(traceId)}/health`).catch(() => null);
    },

    async getRunHealth(params = {}) {
        const q = new URLSearchParams();
        if (params.window_days) q.set('window_days', params.window_days);
        if (params.limit) q.set('limit', params.limit);
        if (params.warm) q.set('warm', 'true');
        const qs = q.toString();
        return this.request(`/api/run-health${qs ? '?' + qs : ''}`).catch(() => null);
    },

    // Agent Governance: coverage of model-issued tool calls plus the gaps to
    // close, from real activity in the window. Null on failure.
    async getGovernanceGaps(params = {}) {
        const days = Number(params.window_days) || 7;
        const fresh = params.refresh ? '&refresh=true' : '';
        return this.request(`/api/governance/gaps?window_days=${encodeURIComponent(days)}${fresh}`).catch(() => null);
    },

    // conversion-ux — Instant Agent Audit. Opt-in retroactive scan of on-disk
    // agent transcripts; consent travels in the run request body.
    async getInstantAuditStatus() {
        return this.request('/api/instant-audit/status').catch(() => null);
    },

    async runInstantAudit(body) {
        return this.request('/api/instant-audit/run', {
            method: 'POST', body: JSON.stringify(body || {}),
        }).catch(() => ({ error: true }));
    },

    async getInstantAuditReport() {
        return this.request('/api/instant-audit/report').catch(() => null);
    },

    async deleteInstantAuditReport() {
        return this.request('/api/instant-audit/report', { method: 'DELETE' }).catch(() => null);
    },

    // agent-observability §3.2 — blocked-action ledger. What enforcement
    // PREVENTED in the window, grouped by reason + by tool, with hit counts.
    async getBlockedLedger(params = {}) {
        const q = new URLSearchParams();
        if (params.window_days) q.set('window_days', params.window_days);
        const qs = q.toString();
        return this.request(`/api/blocked-ledger${qs ? '?' + qs : ''}`).catch(() => ({
            window_days: params.window_days || 7,
            summary: { blocked_total: 0, tools_blocked: 0, agents_affected: 0, last_at: null },
            by_reason: [], by_tool: [],
        }));
    },

    // active-agent-observability — Timeline. Flat, newest-first feed of every
    // enforced tool call (across all runs). Reuses the existing call-audit log.
    async getCallAudit(params = {}) {
        const q = new URLSearchParams();
        q.set('limit', params.limit || 200);
        if (params.offset) q.set('offset', params.offset);
        if (params.action) q.set('action', params.action);
        const qs = q.toString();
        return this.request(`/api/tool-permissions/call-audit${qs ? '?' + qs : ''}`).catch(() => ({
            entries: [], total: 0,
        }));
    },

    // active-agent-observability — Timeline overview chart. Per-day verdict
    // counts aggregated server-side over the FULL window, so the chart never
    // under-counts blocks the way the paged feed (200 rows) would.
    async getCallAuditActivity(params = {}) {
        const q = new URLSearchParams();
        q.set('window_days', params.windowDays || 7);
        return this.request(`/api/tool-permissions/call-audit/activity?${q.toString()}`).catch(() => ({
            window_days: params.windowDays || 7, buckets: [],
        }));
    },

    /** Rule-only detections Guardian cleared before recording (Threats masthead). */
    async getGuardianCleared(days = 7) {
        return this.request(`/api/threat-intel/cleared/summary?days=${encodeURIComponent(days)}`)
            .catch(() => ({ window_days: days, total: 0, by_rule: {}, by_direction: {} }));
    },

    async getThreats(params = {}) {
        const queryParams = new URLSearchParams();
        if (params.page) queryParams.set('page', params.page);
        if (params.page_size) queryParams.set('page_size', params.page_size);
        if (params.threat_type) queryParams.set('threat_type', params.threat_type);
        if (params.min_risk) queryParams.set('min_risk', params.min_risk);
        if (params.max_risk) queryParams.set('max_risk', params.max_risk);
        // Bundle 0.3 — agent slice. The threat-intel route already accepts
        // ?source=... server-side; just plumb it through the SDK call.
        if (params.source) queryParams.set('source', params.source);
        // Deep-link from an Agent Runs detection to the exact record.
        if (params.request_id) queryParams.set('request_id', params.request_id);
        // All scans for one agent run (Runs page scanned-content panel).
        if (params.session_id) queryParams.set('session_id', params.session_id);
        // Range-scoped fetches (dashboard charts). Server-side filter.
        if (params.is_threat !== undefined) queryParams.set('is_threat', String(params.is_threat));
        if (params.start_date) queryParams.set('start_date', params.start_date);
        if (params.end_date) queryParams.set('end_date', params.end_date);
        // Sessions merged trace reads a session's scans oldest-first.
        if (params.sort) queryParams.set('sort', params.sort);
        if (params.order) queryParams.set('order', params.order);

        const query = queryParams.toString();
        return this.request(`/api/threat-intel${query ? '?' + query : ''}`).catch(() => ({
            items: [],
            total: 0,
            total_pages: 0,
        }));
    },

    async getThreat(id) {
        return this.request(`/api/threat-intel/${id}`);
    },

    async deleteThreats(options = {}) {
        return this.request('/api/threat-intel', {
            method: 'DELETE',
            body: JSON.stringify(options),
        });
    },

    async deleteThreat(id) {
        return this.request(`/api/threat-intel/${id}`, {
            method: 'DELETE',
        });
    },

    // disposition: 'false_positive' to dismiss, null to undo. Keeps the
    // record (evidence) — the non-destructive alternative to deleteThreat.
    async setThreatDisposition(id, disposition) {
        return this.request(`/api/threat-intel/${id}/disposition`, {
            method: 'POST',
            body: JSON.stringify({ disposition }),
        });
    },

    // ==================== Rules ====================

    async getRules() {
        return this.request('/api/rules').catch(() => ({
            items: [],
            total: 0,
            categories: [],
        }));
    },

    async toggleRule(ruleId, enabled) {
        return this._jitDecision(`/api/rules/${ruleId}/toggle`, { enabled });
    },

    async generatePatterns(description) {
        return this.request('/api/rules/generate', {
            method: 'POST',
            body: JSON.stringify({ description }),
        });
    },

    async createRule(ruleData) {
        return this._jitDecision('/api/rules/custom', ruleData);
    },

    async getCustomRulesCount() {
        try {
            const response = await this.getRules();
            const items = response.items || [];
            return items.filter(r => r.source === 'custom').length;
        } catch (e) {
            return 0;
        }
    },

    // ==================== SIEM Forwarders ====================

    async listSiemForwarders() {
        return this.request('/api/siem-forwarders').catch(() => ({ items: [], total: 0 }));
    },

    async getSiemForwarder(id) {
        return this.request(`/api/siem-forwarders/${id}`);
    },

    async createSiemForwarder(payload) {
        return this.request('/api/siem-forwarders', {
            method: 'POST',
            body: JSON.stringify(payload),
        });
    },

    async updateSiemForwarder(id, payload) {
        return this.request(`/api/siem-forwarders/${id}`, {
            method: 'PUT',
            body: JSON.stringify(payload),
        });
    },

    async deleteSiemForwarder(id) {
        return this.request(`/api/siem-forwarders/${id}`, { method: 'DELETE' });
    },

    async testSiemForwarder(id) {
        return this.request(`/api/siem-forwarders/${id}/test`, { method: 'POST' });
    },

    // Pre-save Test Connection — fires a synthetic OCSF event against
    // the supplied config without persisting. Used by the Add/Edit
    // modal's "Test connection" button so operators can validate URL
    // + credentials before committing to a DB row.
    async testSiemForwarderConfig(config) {
        return this.request('/api/siem-forwarders/test-config', {
            method: 'POST',
            body: JSON.stringify(config),
        });
    },

    async getSiemForwarderHealth(id) {
        return this.request(`/api/siem-forwarders/${id}/health`);
    },

    async resetSiemForwarderBreaker(id) {
        return this.request(`/api/siem-forwarders/${id}/reset-breaker`, {
            method: 'POST',
        });
    },

    // Global SIEM forwarding kill-switch (v24 — single boolean toggle)
    async getSiemGlobalSettings() {
        return this.request('/api/siem-forwarders/global-settings');
    },
    async setSiemGlobalSettings(enabled) {
        return this.request('/api/siem-forwarders/global-settings', {
            method: 'PUT',
            body: JSON.stringify({ enabled: !!enabled }),
            headers: { 'Content-Type': 'application/json' },
        });
    },

    // ==================== Cloud Rule Sync (preview → review → apply) ====================

    async syncPreviewStart() {
        return this.request('/api/rules/sync/preview', { method: 'POST' });
    },

    async syncPreviewPage(token, page = 1, perPage = 10) {
        const qs = `?page=${encodeURIComponent(page)}&per_page=${encodeURIComponent(perPage)}`;
        return this.request(`/api/rules/sync/preview/${encodeURIComponent(token)}${qs}`);
    },

    async syncPreviewApply(token, replaceExisting = false, opts = {}) {
        const body = {
            preview_token: token,
            replace_existing: replaceExisting,
        };
        // Selective save — pass a list of rule_ids to apply ONLY those, or
        // a list of rule_ids to skip, or neither to apply everything. The
        // server prefers `selected_rule_ids` when both are set.
        if (Array.isArray(opts.selectedRuleIds)) {
            body.selected_rule_ids = opts.selectedRuleIds;
        }
        if (Array.isArray(opts.skipRuleIds)) {
            body.skip_rule_ids = opts.skipRuleIds;
        }
        return this.request('/api/rules/sync/apply', {
            method: 'POST',
            body: JSON.stringify(body),
        });
    },

    async syncPreviewDiscard(token) {
        return this.request(`/api/rules/sync/preview/${encodeURIComponent(token)}`, {
            method: 'DELETE',
        });
    },

    // ==================== General Settings ====================

    async getSettings() {
        return this.request('/api/settings').catch(() => ({
            scan_llm_responses: true,
        }));
    },

    async updateSettings(settings) {
        const result = await this.request('/api/settings', {
            method: 'PUT',
            body: JSON.stringify(settings),
        });
        if (result && result.config_updated && result.config_file) {
            const fileName = result.config_file.split('/').pop().split('\\').pop();
            const msg = `${fileName} updated`;
            if (window.Toast) Toast.info(msg);
            else if (window.UI && UI.showNotification) UI.showNotification(msg, 'info');
        }
        return result;
    },

    // ==================== Cloud Settings ====================

    async getCloudSettings() {
        return this.request('/api/settings/cloud').catch(() => ({
            credentials_configured: false,
            cloud_mode_enabled: false,
        }));
    },

    async setCloudMode(enabled) {
        return this.request('/api/settings/cloud/mode', {
            method: 'PUT',
            body: JSON.stringify({ enabled }),
        });
    },

    async setCloudCredentials(credentials) {
        return this.request('/api/settings/cloud/credentials', {
            method: 'POST',
            body: JSON.stringify(credentials),
        });
    },

    async clearCloudCredentials() {
        return this.request('/api/settings/cloud/credentials', {
            method: 'DELETE',
        });
    },

    // One-click cloud trial (device flow). Raw fetch instead of request():
    // error bodies carry {detail: {error, message}} and the UI needs the
    // machine-readable `error` code (e.g. trial_unavailable) to pick a
    // fallback, which request()'s string-only Error would flatten away.
    async _trialCall(endpoint, body) {
        const resp = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {}),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            const detail = (data && typeof data.detail === 'object') ? data.detail : {};
            const err = new Error(detail.message || data.detail || `HTTP ${resp.status}`);
            err.code = detail.error || `http_${resp.status}`;
            throw err;
        }
        return data;
    },

    async startCloudTrial() {
        return this._trialCall('/api/settings/cloud/trial/start');
    },

    async pollCloudTrial(deviceCode) {
        return this._trialCall('/api/settings/cloud/trial/poll', { device_code: deviceCode });
    },

    // ==================== Tool Permissions ====================

    async getEssentialTools() {
        return this.request('/api/tool-permissions/essential').catch(() => ({
            tools: [],
            total: 0,
        }));
    },

    async getToolOverrides() {
        return this.request('/api/tool-permissions/overrides').catch(() => ({
            overrides: [],
            total: 0,
        }));
    },

    async setToolOverride(toolId, action, runtimeKind = null) {
        const body = { action };
        // null/undefined → omit (global, all runtimes); a slug scopes the rule.
        if (runtimeKind) body.runtime_kind = runtimeKind;
        return this._jitDecision(`/api/tool-permissions/overrides/${encodeURIComponent(toolId)}`, body, 'PUT');
    },

    async updateEssentialToolRateLimit(toolId, maxCalls, windowSeconds) {
        return this.request(`/api/tool-permissions/overrides/${encodeURIComponent(toolId)}/rate-limit`, {
            method: 'PUT',
            body: JSON.stringify({
                max_calls: maxCalls || null,
                window_seconds: windowSeconds || null,
            }),
        });
    },

    async deleteToolOverride(toolId) {
        return this._jitDecision(`/api/tool-permissions/overrides/${encodeURIComponent(toolId)}`, {}, 'DELETE');
    },

    // ==================== JIT Access (requests + grants) ====================

    // Per-run decision token. Approve/deny/revoke are human-only actions:
    // the server requires this token, which only the web UI fetches. Cached
    // for the page's lifetime; refetched transparently after a server restart.
    _jitToken: null,
    async _getJitToken() {
        if (!this._jitToken) {
            let r;
            try {
                r = await this._retryUnconfirmed(() => this.request('/api/jit/ui-token'));
            } catch (e) {
                // The page was loaded before the app restarted: reload once.
                if (/local web UI only/i.test(String(e && e.message))) this._reloadForUiToken();
                throw e;
            }
            this._jitToken = r.token;
            try { window.sessionStorage.removeItem('sv_ui_token_reload'); } catch (_) { /* no storage */ }
        }
        return this._jitToken;
    },
    _reloadForUiToken() {
        let reload = false;
        try {
            if (window.sessionStorage.getItem('sv_ui_token_reload') !== '1') {
                window.sessionStorage.setItem('sv_ui_token_reload', '1');
                reload = true;
            }
        } catch (_) { reload = false; }
        if (reload) {
            window.location.reload();
            return;
        }
        throw new Error('Reload the page to approve.');
    },
    async _jitDecision(endpoint, body, method = 'POST') {
        // NB: request() replaces the whole headers object when options.headers
        // is set (the ...options spread wins), so Content-Type must be
        // restated here or FastAPI 422s on an unparseable body.
        const call = async () => this.request(endpoint, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'X-SV-UI-Token': await this._getJitToken(),
            },
            body: JSON.stringify(body || {}),
        });
        try {
            return await this._retryUnconfirmed(call);
        } catch (e) {
            // Retry once ONLY for a stale token (app restarted since the
            // token was cached) — any other failure surfaces immediately.
            if (!/UI token/i.test(String(e && e.message))) throw e;
            this._jitToken = null;
            return this._retryUnconfirmed(call);
        }
    },
    // The app answers 503 "Could not confirm who asked" when it could not
    // tell, this once, that a person is asking. Try again once after a
    // second; a second failure shows the message.
    async _retryUnconfirmed(call) {
        try {
            return await call();
        } catch (e) {
            if (!/Could not confirm who asked/i.test(String(e && e.message))) throw e;
            await new Promise((resolve) => setTimeout(resolve, 1000));
            return call();
        }
    },

    async getJitRequests(status = null) {
        const q = status ? `?status=${encodeURIComponent(status)}` : '';
        return this.request(`/api/jit/requests${q}`).catch(() => ({ items: [], pending: 0 }));
    },

    async getJitGrants() {
        return this.request('/api/jit/grants').catch(() => ({ items: [], active: [] }));
    },

    async approveJitRequest(id, duration) {
        return this._jitDecision(`/api/jit/requests/${encodeURIComponent(id)}/approve`, { duration });
    },

    async denyJitRequest(id, reason = null) {
        return this._jitDecision(`/api/jit/requests/${encodeURIComponent(id)}/deny`, { reason });
    },

    async revokeJitGrant(id) {
        return this._jitDecision(`/api/jit/grants/${encodeURIComponent(id)}/revoke`, {});
    },

    // ==================== Custom Tools ====================

    async getCustomTools() {
        return this.request('/api/tool-permissions/custom').catch(() => ({
            tools: [],
            total: 0,
        }));
    },

    async createCustomTool(toolData) {
        return this._jitDecision('/api/tool-permissions/custom', toolData, 'POST');
    },

    /** Update a custom tool's label fields (name / description / risk).
     *
     * Separate from updateCustomToolPermission: renaming a tool must never be
     * able to change what it is allowed to do. Partial body, so omitted
     * fields keep their current values. */
    async updateCustomTool(toolId, fields) {
        return this._jitDecision(`/api/tool-permissions/custom/${encodeURIComponent(toolId)}`, fields, 'PATCH');
    },

    async updateCustomToolPermission(toolId, defaultPermission) {
        return this._jitDecision(`/api/tool-permissions/custom/${encodeURIComponent(toolId)}`,
            { default_permission: defaultPermission }, 'PUT');
    },

    async updateCustomToolRateLimit(toolId, maxCalls, windowSeconds) {
        return this.request(`/api/tool-permissions/custom/${encodeURIComponent(toolId)}/rate-limit`, {
            method: 'PUT',
            body: JSON.stringify({
                max_calls: maxCalls || null,
                window_seconds: windowSeconds || null,
            }),
        });
    },

    async deleteCustomTool(toolId) {
        return this._jitDecision(`/api/tool-permissions/custom/${encodeURIComponent(toolId)}`, {}, 'DELETE');
    },

    // ==================== Tool Call Audit Log ====================

    async getToolCallAudit(limit = 50, action = null, offset = 0) {
        const params = new URLSearchParams({ limit, offset });
        if (action) params.set('action', action);
        return this.request(`/api/tool-permissions/call-audit?${params}`).catch(() => ({
            entries: [],
            total: 0,
        }));
    },

    async getToolCallAuditDaily(days = 7) {
        return this.request(`/api/tool-permissions/call-audit/daily?days=${days}`).catch(() => ({ days: [] }));
    },

    async getToolCallAuditStats() {
        return this.request('/api/tool-permissions/call-audit/stats').catch(() => ({
            total: 0, blocked: 0, allowed: 0, log_only: 0,
        }));
    },

    async getToolCallAuditIntegrity() {
        return this.request('/api/tool-permissions/call-audit/integrity').catch(() => ({
            ok: null, total: 0, tampered_at: null, tampered_id: null, reason: null, last_verified_at: null,
        }));
    },

    async getBillOfTools(windowDays = 7) {
        return this.request(`/api/tool-permissions/bill-of-tools?window_days=${windowDays}`).catch(() => ({
            window_days: windowDays, row_count: 0, rows: [],
        }));
    },

    async getRedactions(windowDays = 7, { direction = null, secretType = null, runtimeKind = null, limit = 1000 } = {}) {
        const params = new URLSearchParams({ window_days: String(windowDays), limit: String(limit) });
        if (direction) params.set('direction', direction);
        if (secretType) params.set('secret_type', secretType);
        if (runtimeKind) params.set('runtime_kind', runtimeKind);
        return this.request(`/api/redactions?${params}`).catch(() => ({
            summary: { window_days: windowDays, total: 0, distinct_tools: 0, by_direction: {}, by_secret_type: {}, by_runtime: {} },
            events: [],
        }));
    },

    async getDeviceId() {
        return this.request('/api/system/device-id').catch(() => ({ device_id: null }));
    },

    async deleteToolCallAuditEntries(ids) {
        return this._jitDecision('/api/tool-permissions/call-audit', { ids }, 'DELETE');
    },

    async deleteRule(ruleId) {
        return this._jitDecision(`/api/rules/custom/${encodeURIComponent(ruleId)}`, {}, 'DELETE');
    },

    async getProxyStatus() {
        return this.request('/api/proxy/status');
    },

    // ==================== LLM Settings ====================

    async getLLMSettings() {
        return this.request('/api/settings/llm').catch(() => ({
            enabled: false,
            provider: 'ollama',
            model: 'llama3',
            endpoint: 'http://localhost:11434',
            api_key_configured: false,
        }));
    },

    async updateLLMSettings(settings) {
        return this.request('/api/settings/llm', {
            method: 'PUT',
            body: JSON.stringify(settings),
        });
    },

    async testLLMConnection() {
        return this.request('/api/settings/llm/test', {
            method: 'POST',
        });
    },

    async getLLMProviders() {
        return this.request('/api/llm/providers').catch(() => ({
            providers: [
                { id: 'ollama', name: 'Ollama', endpoint: 'http://localhost:11434', models: ['llama3', 'mistral'], requires_api_key: false },
                { id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com', models: ['gpt-4o', 'gpt-4o-mini'], requires_api_key: true },
                { id: 'anthropic', name: 'Anthropic', endpoint: 'https://api.anthropic.com', models: ['claude-3-5-sonnet-20241022'], requires_api_key: true },
            ],
        }));
    },

    // ==================== Costs ====================

    async getCostSummary(params = {}) {
        const qs = new URLSearchParams();
        if (params.start) qs.set('start', params.start);
        if (params.end) qs.set('end', params.end);
        if (params.limit) qs.set('limit', params.limit);
        const query = qs.toString() ? `?${qs}` : '';
        return this.request(`/api/costs/summary${query}`);
    },

    async getDashboardCostSummary() {
        return this.request('/api/costs/dashboard-summary').catch(() => ({
            today_cost_usd: 0,
            today_requests: 0,
            top_agent: null,
            top_model: null,
            cost_tracking_enabled: true,
            has_unknown_pricing: false,
        }));
    },

    async getMonthlyCostChart(params = {}) {
        const qs = new URLSearchParams();
        if (params.year) qs.set('year', params.year);
        if (params.month) qs.set('month', params.month);
        if (params.start) qs.set('start', params.start);
        if (params.end) qs.set('end', params.end);
        const query = qs.toString() ? `?${qs}` : '';
        return this.request(`/api/costs/monthly-chart${query}`);
    },

    async getCostRecords(params = {}) {
        const qs = new URLSearchParams();
        if (params.agent_id) qs.set('agent_id', params.agent_id);
        if (params.provider) qs.set('provider', params.provider);
        if (params.start) qs.set('start', params.start);
        if (params.end) qs.set('end', params.end);
        if (params.page) qs.set('page', params.page);
        if (params.page_size) qs.set('page_size', params.page_size);
        const query = qs.toString() ? `?${qs}` : '';
        return this.request(`/api/costs/records${query}`);
    },

    async getModelPricing(provider) {
        const query = provider ? `?provider=${encodeURIComponent(provider)}` : '';
        return this.request(`/api/costs/pricing${query}`);
    },

    async updateModelPricing(provider, modelId, data) {
        return this.request(`/api/costs/pricing/${encodeURIComponent(provider)}/${encodeURIComponent(modelId)}`, {
            method: 'PUT',
            body: JSON.stringify(data),
        });
    },

    async syncPricing() {
        return this.request('/api/costs/pricing/sync', { method: 'POST' });
    },

    getCostExportUrl(params = {}) {
        const qs = new URLSearchParams();
        if (params.agent_id) qs.set('agent_id', params.agent_id);
        if (params.provider) qs.set('provider', params.provider);
        if (params.start) qs.set('start', params.start);
        if (params.end) qs.set('end', params.end);
        const query = qs.toString() ? `?${qs}` : '';
        return `/api/costs/export${query}`;
    },

    // Budget API
    async getGlobalBudget() {
        return this.request('/api/costs/budget');
    },
    async setGlobalBudget(data) {
        const result = await this.request('/api/costs/budget', { method: 'PUT', body: JSON.stringify(data) });
        if (window.Toast) Toast.info('securevector.yml updated');
        else if (window.UI && UI.showNotification) UI.showNotification('securevector.yml updated', 'info');
        return result;
    },
    async listAgentBudgets() {
        return this.request('/api/costs/budget/agents');
    },
    async setAgentBudget(agentId, data) {
        return this.request(`/api/costs/budget/agents/${encodeURIComponent(agentId)}`, {
            method: 'PUT', body: JSON.stringify(data),
        });
    },
    async deleteAgentBudget(agentId) {
        return this.request(`/api/costs/budget/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
    },
    async deleteCostRecords(agentId = null, ids = null) {
        const query = agentId ? `?agent_id=${encodeURIComponent(agentId)}` : '';
        const options = { method: 'DELETE' };
        if (ids && ids.length > 0) {
            options.body = JSON.stringify({ ids });
        }
        return this.request(`/api/costs/records${query}`, options);
    },

    async getBudgetGuardian() {
        return this.request('/api/costs/budget/guardian').catch(() => null);
    },

    // ------------------------------------------------- per-run limits ---
    // #203 enforcement controls. Reads degrade; writes surface errors.
    async getRunLimits() {
        return this.request('/api/costs/run-limits').catch(() => null);
    },

    async setRunLimits(payload) {
        return this.request('/api/costs/run-limits', {
            method: 'PUT',
            body: JSON.stringify(payload || {}),
        });
    },

    async getRunLimitStops(windowDays) {
        const q = windowDays ? `?window_days=${encodeURIComponent(windowDays)}` : '';
        return this.request(`/api/costs/run-limits/stops${q}`).catch(() => ({ stops: [] }));
    },

    async exemptRun(payload) {
        return this.request('/api/costs/run-limits/exempt', {
            method: 'POST',
            body: JSON.stringify(payload || {}),
        });
    },

    // ------------------------------------------- cost / token optimizer ---
    // Reads degrade (status -> null, report -> null) so the Optimizer tab
    // renders its empty state offline; run/prefs writes surface their errors.
    async getOptimizerStatus() {
        return this.request('/api/cost-optimizer/status').catch(() => null);
    },

    async getOptimizerReport() {
        return this.request('/api/cost-optimizer/report').catch(() => null);
    },

    async getOptimizerSessions(windowDays = 30) {
        return this.request(`/api/cost-optimizer/sessions?window_days=${windowDays}`)
            .catch(() => null);
    },

    async getOptimizerLive() {
        return this.request('/api/cost-optimizer/live').catch(() => null);
    },

    /** Tell the service a fix went to the clipboard, so the next live sweep
     *  can look for the paste and then measure whether it changed anything.
     *  Best effort: the copy itself must never fail because of this. */
    async optimizerFixCopied(payload) {
        return this.request('/api/cost-optimizer/fix-copied', {
            method: 'POST',
            body: JSON.stringify(payload || {}),
        }).catch(() => null);
    },

    async runOptimizer(payload) {
        return this.request('/api/cost-optimizer/run', {
            method: 'POST',
            body: JSON.stringify(payload || {}),
        });
    },

    async setOptimizerPrefs(payload) {
        return this.request('/api/cost-optimizer/prefs', {
            method: 'PUT',
            body: JSON.stringify(payload || {}),
        });
    },

    async deleteOptimizerReport() {
        return this.request('/api/cost-optimizer/report', { method: 'DELETE' });
    },

    // ---------------------------------------------------------- egress ---
    // Read paths degrade to null so a missing policy or an unrun proof
    // renders as an honest empty state rather than a page-level error. The
    // write paths (proof, replay, promote) deliberately do NOT swallow: the
    // operator asked for something and needs to know it did not happen.

    async getEgressPolicy() {
        return this.request('/api/egress/policy').catch(() => null);
    },
    async getEgressPresets() {
        return this.request('/api/egress/presets').catch(() => null);
    },
    async patchEgressPolicy(patch) {
        // Human-only, like a JIT decision: carries the per-run UI token.
        return this._jitDecision('/api/egress/policy', patch || {}, 'PATCH');
    },
    // Session-scoped host approval and denylist edits: human-only, so they
    // carry the same per-run UI token as JIT decisions.
    async grantEgressHost(host, sessionId, duration) {
        return this._jitDecision('/api/egress/grants', { host, session_id: sessionId, duration });
    },
    async addEgressDeniedHost(host) {
        return this._jitDecision('/api/egress/denylist', { host });
    },
    async removeEgressDeniedHost(host) {
        return this._jitDecision('/api/egress/denylist/remove', { host });
    },
    async promoteEgressHost(host) {
        // Device-wide and permanent, so human-only: carries the UI token.
        return this._jitDecision('/api/egress/promote', { host });
    },
    async getEgressBlastRadius(days = 30) {
        return this.request(`/api/egress/blast-radius?days=${days}`).catch(() => null);
    },
    async getEgressDestinations(days = 30) {
        return this.request(`/api/egress/destinations?days=${days}`)
            .catch(() => ({ destinations: [], distinct_hosts: 0 }));
    },
    async getEgressSessionDestinations(sessionId) {
        return this.request(`/api/egress/sessions/${encodeURIComponent(sessionId)}/destinations`);
    },
    async getEgressScope(days = 7) {
        return this.request(`/api/egress/scope?days=${days}`).catch(() => null);
    },
    async getEgressPolicyHealth(days = 30) {
        return this.request(`/api/egress/policy-health?days=${days}`).catch(() => null);
    },
    async getEgressAudit(limit = 100, action = null) {
        const q = new URLSearchParams({ limit });
        if (action) q.set('action', action);
        return this.request(`/api/egress/audit?${q}`).catch(() => ({ rows: [] }));
    },
    async replayEgressPolicy(body) {
        return this.request('/api/egress/replay', {
            method: 'POST', body: JSON.stringify(body || {}),
        });
    },
    async getContainmentPreflight() {
        return this.request('/api/egress/proof/preflight').catch(() => null);
    },
    async runContainmentProof(trigger = 'manual') {
        return this.request(`/api/egress/proof?trigger=${trigger}`, { method: 'POST' });
    },
    async getLatestContainmentProof() {
        return this.request('/api/egress/proof/latest').catch(() => null);
    },
    async getContainmentDrift() {
        return this.request('/api/egress/proof/drift').catch(() => null);
    },
    async getContainmentProofHistory(limit = 20) {
        return this.request(`/api/egress/proof/history?limit=${limit}`)
            .catch(() => ({ proofs: [] }));
    },

    // --- Agent Terminals ---------------------------------------------------
    // Auth is a cookie issued by /session plus the X-SV-Terminals header on
    // every other call, reads included. request() replaces the whole headers
    // object when options.headers is set, so Content-Type is restated on
    // every write.
    _terminalsReady: false,
    _terminalsSessionPromise: null,
    async terminalsSession() {
        if (this._terminalsReady) return;
        if (!this._terminalsSessionPromise) {
            this._terminalsSessionPromise = this.request('/api/terminals/session').then(() => {
                this._terminalsReady = true;
            }).finally(() => {
                this._terminalsSessionPromise = null;
            });
        }
        return this._terminalsSessionPromise;
    },
    // request() throws a plain Error and doesn't attach the HTTP status, so
    // an auth failure is identified by message: the terminals auth layer
    // always denies with this exact detail, with "HTTP 401"/"HTTP 403" as
    // the fallback shape if a body-less denial ever reaches us instead.
    _terminalsIsAuthError(err) {
        const message = (err && err.message) || '';
        return message === 'Terminals: request not authorised' || /^HTTP 40[13]$/.test(message);
    },
    async _terminalsCall(endpoint, options) {
        await this.terminalsSession();
        try {
            return await this.request(endpoint, options);
        } catch (err) {
            if (!this._terminalsIsAuthError(err)) throw err;
            // One-shot recovery: the cookie may have been cleared or never
            // set; re-issue the session and retry exactly once.
            this._terminalsReady = false;
            await this.terminalsSession();
            return this.request(endpoint, options);
        }
    },
    async _terminalsRead(endpoint) {
        return this._terminalsCall(endpoint, { headers: { 'X-SV-Terminals': '1' } });
    },
    async _terminalsWrite(endpoint, body) {
        return this._terminalsCall(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-SV-Terminals': '1' },
            body: JSON.stringify(body || {}),
        });
    },
    // Observability (6.0): coverage per runtime, running sessions, and one
    // session's governance summary. The read cookie is scoped to the
    // terminals prefix, so these routes live under it.
    async getObservabilityCoverage() {
        return this._terminalsRead('/api/terminals/observability/coverage');
    },
    async getObservabilityLive(params = {}) {
        const q = new URLSearchParams();
        if (params.group) q.set('group', params.group);
        if (params.limit) q.set('limit', params.limit);
        const qs = q.toString();
        return this._terminalsRead(`/api/terminals/observability/live${qs ? '?' + qs : ''}`);
    },
    async getSessionGovernance(sessionId) {
        return this._terminalsRead(`/api/terminals/observability/sessions/${encodeURIComponent(sessionId)}/governance`);
    },
    async terminalsExecutors() {
        return this._terminalsRead('/api/terminals/executors');
    },
    async installGuard(executorId) {
        const res = await fetch(`/api/hooks/${encodeURIComponent(executorId)}/install`, { method: 'POST', credentials: 'same-origin' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.detail || body.message || `Guard install failed (${res.status})`);
        return body;
    },
    async terminalsArchive(taskId) {
        return this._terminalsWrite(`/api/terminals/tasks/${encodeURIComponent(taskId)}/archive`, {});
    },
    async terminalsTasks() {
        return this._terminalsRead('/api/terminals/tasks');
    },
    async terminalsTask(id) {
        return this._terminalsRead(`/api/terminals/tasks/${encodeURIComponent(id)}`);
    },
    // `resumeSessionId` reopens an existing harness session instead of starting
    // a fresh one. Optional, and omitted by every existing call site: the host
    // refuses it for a harness that cannot reopen a session by id.
    async terminalsLaunch(executorId, workspace, title, resumeSessionId, extra) {
        const body = { executor_id: executorId, workspace, title: title || null, resume_session_id: resumeSessionId || null };
        if (extra && extra.worktree) body.worktree = true;
        if (extra && extra.from_task_id) body.from_task_id = extra.from_task_id;
        return this._terminalsWrite('/api/terminals/tasks', body);
    },
    // Worktree isolation: can this folder host one, remove one, reveal one.
    async terminalsGitRepo(folder) {
        return this._terminalsRead(`/api/terminals/git-repo?folder=${encodeURIComponent(folder)}`);
    },
    async terminalsWorktreeOpen(id) {
        return this._terminalsUiWrite(`/api/terminals/tasks/${encodeURIComponent(id)}/worktree/open`, {});
    },
    // A 409 that carries the confirm object is an answer, not a failure: the
    // person is asked in the card, then the call is repeated with confirm.
    async terminalsWorktreeRemove(id, confirm, dirtySeen) {
        await this.terminalsSession();
        const url = `${this.baseUrl}/api/terminals/tasks/${encodeURIComponent(id)}/worktree/remove`;
        const send = async () => fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-SV-Terminals': '1', 'X-SV-UI-Token': await this._getJitToken() },
            body: JSON.stringify(confirm && Number.isInteger(dirtySeen) ? { confirm: true, dirty_seen: dirtySeen } : { confirm: !!confirm }),
        });
        let res = await send();
        if (res.status === 403) { this._jitToken = null; res = await send(); }
        const body = await res.json().catch(() => ({}));
        if (res.ok) return body;
        const d = body && body.detail;
        if (res.status === 409 && d && typeof d === 'object' && d.needs_confirm) return d;
        throw new Error(typeof d === 'string' ? d : `HTTP ${res.status}`);
    },
    async terminalsLink(executorId, sessionId, workspace, title) {
        return this._terminalsWrite('/api/terminals/tasks/link', {
            executor_id: executorId,
            session_id: sessionId,
            workspace: workspace || null,
            title: title || null,
        });
    },
    async terminalsUnlinkedSessions() {
        return this._terminalsRead('/api/terminals/sessions/unlinked');
    },
    async terminalsStop(id) {
        return this._terminalsWrite(`/api/terminals/tasks/${encodeURIComponent(id)}/stop`);
    },
    // Stop from a step-up card: the audit records the origin as "rung".
    async terminalsStopFromRung(id) {
        return this._terminalsWrite(`/api/terminals/tasks/${encodeURIComponent(id)}/stop?origin=rung`);
    },
    async terminalsStopAll() {
        return this._terminalsWrite('/api/terminals/stop-all');
    },
    async terminalsVerdicts(id) {
        return this._terminalsRead(`/api/terminals/tasks/${encodeURIComponent(id)}/verdicts`);
    },
    // Session Drift Score: observe only. The per-task read scores the session
    // now; the batch read returns stored scores; feedback records "looks normal".
    async terminalsDrift(id) {
        return this._terminalsRead(`/api/terminals/tasks/${encodeURIComponent(id)}/drift`);
    },
    // Pre-flight checks (check_policy) for a task's sessions: counts only.
    async terminalsPreflight(id) {
        return this._terminalsRead(`/api/terminals/tasks/${encodeURIComponent(id)}/preflight`);
    },
    async terminalsDriftBatch(ids) {
        return this._terminalsRead(`/api/terminals/drift?task_ids=${encodeURIComponent((ids || []).join(','))}`);
    },
    async terminalsDriftFeedback(id) {
        return this._terminalsUiWrite(`/api/terminals/tasks/${encodeURIComponent(id)}/drift/feedback`, { feedback: 'normal' });
    },
    // Response rungs: reads under the terminals token; writes also carry the
    // per-run UI token, refetched once if the app restarted.
    async terminalsRung(id) {
        return this._terminalsRead(`/api/terminals/tasks/${encodeURIComponent(id)}/rung`);
    },
    async terminalsRungModes() {
        return this._terminalsRead('/api/terminals/rungs/modes');
    },
    async terminalsRungHarness(harness) {
        return this._terminalsRead(`/api/terminals/rungs/modes/${encodeURIComponent(harness)}`);
    },
    async _terminalsUiWrite(endpoint, body) {
        const call = async () => this._terminalsCall(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-SV-Terminals': '1', 'X-SV-UI-Token': await this._getJitToken() },
            body: JSON.stringify(body || {}),
        });
        try {
            return await this._retryUnconfirmed(call);
        } catch (e) {
            if (!/UI token|HTTP 403/.test((e && e.message) || '')) throw e;
            this._jitToken = null;
            return this._retryUnconfirmed(call);
        }
    },
    async terminalsRungRelease(id) {
        return this._terminalsUiWrite(`/api/terminals/tasks/${encodeURIComponent(id)}/rung/release`, {});
    },
    async terminalsRungFeedback(id, feedback) {
        return this._terminalsUiWrite(`/api/terminals/tasks/${encodeURIComponent(id)}/rung/feedback`, { feedback });
    },
    async terminalsRungMode(harness, body) {
        return this._terminalsUiWrite(`/api/terminals/rungs/modes/${encodeURIComponent(harness)}`, body);
    },
    // "High: stop the session and alert": on needs the UI token only; off
    // is a decision the app asks the person to confirm.
    async terminalsStopSwitch(harness, on) {
        return this._terminalsUiWrite(`/api/terminals/rungs/stop/${encodeURIComponent(harness)}`, { on: !!on });
    },
    // Governed delegation: reads under the terminals token, decisions with the UI token.
    async terminalsDelegations(id) {
        return this._terminalsRead(`/api/terminals/tasks/${encodeURIComponent(id)}/delegations`);
    },
    async terminalsDelegationRelease(id) {
        return this._terminalsUiWrite(`/api/terminals/delegations/${encodeURIComponent(id)}/release`, {});
    },
    async terminalsDelegationDiscard(id) {
        return this._terminalsUiWrite(`/api/terminals/delegations/${encodeURIComponent(id)}/discard`, {});
    },
    async getDelegationPolicy() {
        return this.request('/api/settings/delegation');
    },
    async setDelegationPolicy(body) {
        return this._jitDecision('/api/settings/delegation', body, 'PUT');
    },
    async getCloudApprovals() {
        return this.request('/api/settings/cloud-approvals');
    },
    async setCloudApprovals(body) {
        return this._jitDecision('/api/settings/cloud-approvals', body, 'PUT');
    },
    async terminalsEvents(id) {
        return this._terminalsRead(`/api/terminals/tasks/${encodeURIComponent(id)}/events`);
    },
    // --- Agent Config Trust (setup trust), under the terminals token ------
    async configTrustStatus(fresh) {
        return this._terminalsRead(`/api/terminals/config-trust/status${fresh ? '?fresh=true' : ''}`);
    },
    async configTrustHarness(harness) {
        return this._terminalsRead(`/api/terminals/config-trust/harness/${encodeURIComponent(harness)}`);
    },
    async configTrustSession(taskId) {
        return this._terminalsRead(`/api/terminals/config-trust/sessions/${encodeURIComponent(taskId)}`);
    },
    async configTrustRepoCheck(harness, workspace) {
        return this._terminalsWrite('/api/terminals/config-trust/repo-check', { harness, workspace });
    },
    async configTrustApprove(body) {
        return this._terminalsWrite('/api/terminals/config-trust/pins', body);
    },
    // Approve all: one call, so the person confirms the whole batch once.
    async configTrustApproveAll(items) {
        return this._terminalsWrite('/api/terminals/config-trust/pins/batch', { items });
    },
    async configTrustProbe(body) {
        return this._terminalsWrite('/api/terminals/config-trust/probe', body);
    },
    // Agent Detection & Response: one read for the page's tiles and list.
    async detectionResponseSummary() {
        return this._terminalsRead('/api/terminals/detection-response/summary');
    },
    // Response modes may not be served by this install. A missing route
    // returns the page shell, so anything but JSON reads as null (shadow)
    // without logging an API error.
    async terminalsRungModes() {
        await this.terminalsSession();
        const r = await fetch('/api/terminals/rungs/modes', { headers: { 'X-SV-Terminals': '1' }, credentials: 'same-origin' });
        if (!r.ok || !/json/.test(r.headers.get('content-type') || '')) return null;
        return r.json();
    },
    // Same read without the shared error log, for the entry points on Agent
    // Sessions that hide themselves when the summary is unavailable.
    async detectionResponseSummaryQuiet() {
        // Shared by the sidebar badge and Agent Sessions: one read per 15 s.
        const now = Date.now();
        if (this._drQuiet && now - this._drQuiet.at < 15000) return this._drQuiet.p;
        const p = this._detectionResponseSummaryRead();
        this._drQuiet = { at: now, p };
        return p;
    },
    async _detectionResponseSummaryRead() {
        try {
            await this.terminalsSession();
            const r = await fetch('/api/terminals/detection-response/summary', { headers: { 'X-SV-Terminals': '1' }, credentials: 'same-origin' });
            if (!r.ok || !/json/.test(r.headers.get('content-type') || '')) return null;
            return await r.json();
        } catch (e) { return null; }
    },
    terminalsSocketUrl(id) {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${location.host}/api/terminals/tasks/${encodeURIComponent(id)}/ws`;
    },
};

// Make API globally available
window.API = API;

// Writes that change what agents may do, or that remove what was recorded,
// come from a person in the app: the app asks for the per-run UI token on
// them. Pages call some of these with fetch() directly, so the token is
// added here, once, for same-origin writes to those paths. A 503 "Could not
// confirm who asked" is tried again once after a second; a stale token
// (the app restarted) is fetched again once.
API.PERSON_WRITE_PATHS = [
    /^\/api\/settings$/,
    /^\/api\/settings\/llm$/,
    /^\/api\/costs\/records$/,
    /^\/api\/costs\/budget(\/agents\/[^/]+)?$/,
    /^\/api\/costs\/run-limits(\/exempt)?$/,
    /^\/api\/skill-permissions(\/[^/]+)*$/,
    /^\/api\/threat-intel(\/[^/]+)?(\/disposition)?$/,
    /^\/api\/rules\/sync\/apply$/,
    /^\/api\/settings\/cloud\/(credentials|mode)$/,
    /^\/api\/v1\/cloud-forwarding$/,
    /^\/api\/siem-forwarders(\/[^/]+)?(\/reset-breaker)?$/,
    /^\/api\/proxy\/(stop|revert)$/,
    /^\/api\/terminals\/config-trust\/pins(\/batch)?$/,
];
API.needsPerson = function (input, init) {
    const method = String((init && init.method) || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || typeof input !== 'string') return false;
    let url;
    try { url = new URL(input, window.location.href); } catch (e) { return false; }
    if (url.origin !== window.location.origin) return false;
    return API.PERSON_WRITE_PATHS.some((re) => re.test(url.pathname));
};
(function wrapFetchForPersonWrites() {
    if (typeof window.fetch !== 'function') return;
    const plainFetch = window.fetch.bind(window);
    const detailOf = async (res) => {
        try { return String((await res.clone().json()).detail || ''); } catch (e) { return ''; }
    };
    window.fetch = async function (input, init) {
        if (!API.needsPerson(input, init)) {
            const plain = await plainFetch(input, init);
            const method = String((init && init.method) || 'GET').toUpperCase();
            return method === 'GET' || method === 'HEAD' ? plain : API.confirmThen(plain);
        }
        const headers = new Headers((init && init.headers) || {});
        if (headers.has('X-SV-UI-Token')) return plainFetch(input, init);
        const send = async () => {
            const h = new Headers(headers);
            try { h.set('X-SV-UI-Token', await API._getJitToken()); } catch (e) { /* the app answers 403 */ }
            return plainFetch(input, { ...init, headers: h });
        };
        let res = await send();
        if (res.status === 403 && /UI token/i.test(await detailOf(res))) {
            API._jitToken = null;
            res = await send();
        }
        if (res.status === 503 && /Could not confirm who asked/i.test(await detailOf(res))) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            res = await send();
        }
        return API.confirmThen(res);
    };
})();

// Native approvals: a decision route answers 202 with a confirmation id and
// applies nothing until the person confirms on the computer (the desktop
// shell's prompt, or a code shown on the computer in a browser). The
// wrapper above hands every write through confirmThen, so callers see the
// original route's final answer, or a 409 "Not confirmed".
API.CONFIRM_POLL_MS = 1000;
API._confirmResponse = function (status, body) {
    const R = (typeof Response !== 'undefined') ? Response : window.Response;
    if (status === 204) return new R(null, { status: 204 });
    return new R(JSON.stringify(body == null ? {} : body), { status, headers: { 'Content-Type': 'application/json' } });
};
API.confirmThen = async function (res) {
    if (!res || res.status !== 202) return res;
    let info;
    try { info = await res.clone().json(); } catch (e) { return res; }
    if (info && !info.confirmation_id && info.detail && info.detail.confirmation_id) info = info.detail;
    if (!info || !info.confirmation_id) return res;
    const ui = API._confirmPanel(info);
    let done = null;
    try { done = await API._awaitConfirmation(info, ui); } catch (e) { done = null; }
    if (!done) {
        ui.fail();
        return API._confirmResponse(409, { detail: 'Not confirmed' });
    }
    ui.close();
    const result = done.result || {};
    return API._confirmResponse(result.status_code || 200, result.body);
};
API._awaitConfirmation = function (info, ui) {
    const url = `/api/confirmations/${encodeURIComponent(info.confirmation_id)}`;
    const deadline = Date.now() + ((Number(info.expires_in) || 120) + 5) * 1000;
    const headers = async () => ({ 'Content-Type': 'application/json', 'X-SV-UI-Token': await API._getJitToken() });
    return new Promise((resolve) => {
        let finished = false;
        let timer = null;
        const finish = (v) => {
            if (finished) return;
            finished = true;
            if (timer) clearTimeout(timer);
            resolve(v);
        };
        const poll = async () => {
            if (finished) return;
            try {
                const r = await fetch(url, { headers: await headers() });
                const v = await r.json().catch(() => ({}));
                if (r.ok && v.status === 'confirmed') return finish(v);
                if (v.status === 'denied' || v.status === 'expired' || r.status === 404) return finish(null);
            } catch (e) { /* the next poll tries again */ }
            if (Date.now() > deadline) return finish(null);
            timer = setTimeout(poll, API.CONFIRM_POLL_MS);
        };
        // Cancel on the page denies it on the server too, so a prompt still
        // open on the computer can no longer apply it.
        ui.onCancel = async () => {
            try { await fetch(`${url}/cancel`, { method: 'POST', headers: await headers(), body: '{}' }); } catch (e) { /* expires anyway */ }
            finish(null);
        };
        ui.onCode = async (code) => {
            if (finished) return;
            try {
                const r = await fetch(`${url}/code`, { method: 'POST', headers: await headers(), body: JSON.stringify({ code }) });
                const v = await r.json().catch(() => ({}));
                if (r.ok && v.status === 'confirmed') return finish(v);
                if (r.status === 400) { ui.error(v.detail || 'Wrong code.'); return; }
                if (r.status === 429 && v.detail) ui.error(String(v.detail));
                finish(null);
            } catch (e) { ui.error('Could not send the code, try again.'); }
        };
        poll();
    });
};
API.confirmPrompt = function (info) {
    if (info && info.method === 'code') return 'Enter the code shown on your computer';
    const nav = (typeof navigator !== 'undefined' && navigator) || {};
    const mac = /Mac/i.test(String(nav.platform || nav.userAgent || ''));
    return mac ? 'Confirm on your Mac\u2026' : 'Confirm on your computer\u2026';
};
API._confirmPanel = function (info) {
    const ui = { onCancel: null, onCode: null, el: null };
    const doc = (typeof document !== 'undefined') ? document : null;
    if (!doc || typeof doc.createElement !== 'function' || !doc.body) {
        ui.fail = () => {}; ui.close = () => {}; ui.error = () => {};
        return ui;
    }
    const el = doc.createElement('div');
    el.className = 'sv-confirm';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-live', 'assertive');
    const title = doc.createElement('div');
    title.className = 'sv-confirm-title';
    title.textContent = API.confirmPrompt(info);
    const summary = doc.createElement('div');
    summary.className = 'sv-confirm-summary';
    summary.textContent = String(info.summary || '');
    const msg = doc.createElement('div');
    msg.className = 'sv-confirm-msg';
    el.appendChild(title);
    el.appendChild(summary);
    if (info.method === 'code') {
        const form = doc.createElement('form');
        form.className = 'sv-confirm-form';
        const input = doc.createElement('input');
        input.className = 'sv-confirm-code';
        input.setAttribute('inputmode', 'numeric');
        input.setAttribute('autocomplete', 'one-time-code');
        input.setAttribute('maxlength', '6');
        input.setAttribute('aria-label', 'Six-digit code');
        const ok = doc.createElement('button');
        ok.type = 'submit';
        ok.className = 'btn btn-sm';
        ok.textContent = 'Confirm';
        form.onsubmit = (e) => {
            if (e && e.preventDefault) e.preventDefault();
            const code = String(input.value || '').replace(/\D/g, '');
            if (code.length !== 6) { ui.error('Enter all six digits.'); return; }
            msg.textContent = '';
            if (ui.onCode) ui.onCode(code);
        };
        form.appendChild(input);
        form.appendChild(ok);
        el.appendChild(form);
        setTimeout(() => { try { input.focus(); } catch (e) { /* not focusable */ } }, 0);
    }
    const cancel = doc.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-sm sv-confirm-cancel';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => { if (ui.onCancel) ui.onCancel(); };
    el.appendChild(cancel);
    el.appendChild(msg);
    doc.body.appendChild(el);
    ui.el = el;
    const remove = () => { if (el.parentNode) el.parentNode.removeChild(el); };
    ui.error = (text) => { msg.textContent = text; };
    ui.close = remove;
    ui.fail = () => {
        title.textContent = 'Not confirmed';
        el.classList.add('sv-confirm-failed');
        const form = el.querySelector && el.querySelector('form');
        if (form && form.parentNode) form.parentNode.removeChild(form);
        if (cancel.parentNode) cancel.parentNode.removeChild(cancel);
        setTimeout(remove, msg.textContent ? 8000 : 2500);
    };
    return ui;
};
