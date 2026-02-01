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

    // ==================== Threat Analytics ====================

    async getThreatAnalytics() {
        return this.request('/api/threat-analytics');
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
        return this.request(`/api/threat-intel${query ? '?' + query : ''}`);
    },

    async getThreat(id) {
        return this.request(`/api/threat-intel/${id}`);
    },

    // ==================== Rules ====================

    async getRules() {
        return this.request('/api/rules');
    },

    async toggleRule(ruleId, enabled) {
        return this.request(`/api/rules/${ruleId}/toggle`, {
            method: 'PUT',
            body: JSON.stringify({ enabled }),
        });
    },

    // ==================== Cloud Settings ====================

    async getCloudMode() {
        return this.request('/api/v1/settings/cloud/mode');
    },

    async setCloudMode(enabled) {
        return this.request('/api/v1/settings/cloud/mode', {
            method: 'PUT',
            body: JSON.stringify({ enabled }),
        });
    },

    // ==================== Theme Settings ====================

    async getTheme() {
        return this.request('/api/settings/theme').catch(() => ({ theme: 'dark' }));
    },

    async setTheme(theme) {
        return this.request('/api/settings/theme', {
            method: 'PUT',
            body: JSON.stringify({ theme }),
        }).catch(() => ({ success: true, theme }));
    },
};

// Make API globally available
window.API = API;
