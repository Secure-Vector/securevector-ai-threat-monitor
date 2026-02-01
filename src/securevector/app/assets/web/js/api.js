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
            body: JSON.stringify({ content }),
        });
    },

    // ==================== Threat Analytics ====================

    async getThreatAnalytics() {
        // Get dashboard summary from threat intel
        try {
            const threats = await this.getThreats({ page_size: 100 });
            const items = threats.items || [];

            // Calculate stats
            const criticalCount = items.filter(t => t.risk_score >= 80).length;
            const recentThreats = items.slice(0, 5);

            // Group by type
            const threatTypes = {};
            items.forEach(t => {
                const type = t.threat_type || 'unknown';
                threatTypes[type] = (threatTypes[type] || 0) + 1;
            });

            return {
                total_threats: items.length,
                critical_count: criticalCount,
                blocked_count: items.filter(t => t.blocked).length,
                active_rules: 0,
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
};

// Make API globally available
window.API = API;
