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
                blocked_count: items.filter(t => t.blocked).length,
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
        return this.request('/api/settings', {
            method: 'PUT',
            body: JSON.stringify(settings),
        });
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
};

// Make API globally available
window.API = API;
