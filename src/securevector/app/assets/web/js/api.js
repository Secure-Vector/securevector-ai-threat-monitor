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

            return {
                total_threats: totalCount,  // Use actual total from API
                critical_count: criticalCount,
                blocked_count: items.filter(t => t.action_taken === 'blocked').length,
                active_rules: activeRulesCount,
                recent_threats: recentThreats,
                threat_types: threatTypes,
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

    async getThreats(params = {}) {
        const queryParams = new URLSearchParams();
        if (params.page) queryParams.set('page', params.page);
        if (params.page_size) queryParams.set('page_size', params.page_size);
        if (params.threat_type) queryParams.set('threat_type', params.threat_type);
        if (params.min_risk) queryParams.set('min_risk', params.min_risk);
        if (params.max_risk) queryParams.set('max_risk', params.max_risk);

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

    // ==================== Rules ====================

    async getRules() {
        return this.request('/api/rules').catch(() => ({
            items: [],
            total: 0,
            categories: [],
        }));
    },

    async toggleRule(ruleId, enabled) {
        return this.request(`/api/rules/${ruleId}/toggle`, {
            method: 'POST',
            body: JSON.stringify({ enabled }),
        });
    },

    async generatePatterns(description) {
        return this.request('/api/rules/generate', {
            method: 'POST',
            body: JSON.stringify({ description }),
        });
    },

    async createRule(ruleData) {
        return this.request('/api/rules/custom', {
            method: 'POST',
            body: JSON.stringify(ruleData),
        });
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

    async setToolOverride(toolId, action) {
        return this.request(`/api/tool-permissions/overrides/${encodeURIComponent(toolId)}`, {
            method: 'PUT',
            body: JSON.stringify({ action }),
        });
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
        return this.request(`/api/tool-permissions/overrides/${encodeURIComponent(toolId)}`, {
            method: 'DELETE',
        });
    },

    // ==================== Custom Tools ====================

    async getCustomTools() {
        return this.request('/api/tool-permissions/custom').catch(() => ({
            tools: [],
            total: 0,
        }));
    },

    async createCustomTool(toolData) {
        return this.request('/api/tool-permissions/custom', {
            method: 'POST',
            body: JSON.stringify(toolData),
        });
    },

    async updateCustomToolPermission(toolId, defaultPermission) {
        return this.request(`/api/tool-permissions/custom/${encodeURIComponent(toolId)}`, {
            method: 'PUT',
            body: JSON.stringify({ default_permission: defaultPermission }),
        });
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
        return this.request(`/api/tool-permissions/custom/${encodeURIComponent(toolId)}`, {
            method: 'DELETE',
        });
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
};

// Make API globally available
window.API = API;
