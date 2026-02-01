/**
 * Header Component
 * Displays app title, Agent Integrations dropdown, server status, and theme toggle
 */

const Header = {
    serverStatus: 'checking',
    dropdownOpen: false,

    // Agent integration instructions
    agents: [
        { id: 'n8n', name: 'n8n' },
        { id: 'dify', name: 'Dify' },
        { id: 'crewai', name: 'CrewAI' },
        { id: 'claude-desktop', name: 'Claude Desktop' },
        { id: 'openclaw', name: 'OpenClaw' },
        { id: 'langchain', name: 'LangChain' },
        { id: 'langgraph', name: 'LangGraph' },
    ],

    render() {
        const container = document.getElementById('header');
        if (!container) return;

        container.textContent = '';

        // Left side - page title
        const left = document.createElement('div');
        left.className = 'header-left';

        const title = document.createElement('h1');
        title.className = 'header-title';
        title.textContent = this.getPageTitle();
        left.appendChild(title);

        container.appendChild(left);

        // Right side - cloud mode, agent dropdown, status and theme toggle
        const right = document.createElement('div');
        right.className = 'header-right';

        // Cloud Mode toggle with gradient
        const cloudToggle = this.createCloudToggle();
        right.appendChild(cloudToggle);

        // Agent Integrations dropdown with flashing border
        const agentDropdown = this.createAgentDropdown();
        right.appendChild(agentDropdown);

        // Server status indicator
        const statusBadge = document.createElement('div');
        statusBadge.className = 'status-badge ' + this.serverStatus;
        statusBadge.id = 'server-status';

        const statusDot = document.createElement('span');
        statusDot.className = 'status-dot';
        statusBadge.appendChild(statusDot);

        const statusText = document.createElement('span');
        statusText.textContent = this.getStatusText();
        statusBadge.appendChild(statusText);

        right.appendChild(statusBadge);

        // Theme toggle
        const themeToggle = document.createElement('button');
        themeToggle.className = 'theme-toggle';
        themeToggle.setAttribute('aria-label', 'Toggle theme');
        themeToggle.appendChild(this.createThemeIcon());
        themeToggle.addEventListener('click', () => this.toggleTheme());

        right.appendChild(themeToggle);

        container.appendChild(right);

        // Check server status and cloud mode
        this.checkStatus();
        this.checkCloudMode();
    },

    createCloudToggle() {
        const wrapper = document.createElement('div');
        wrapper.className = 'cloud-toggle-wrapper';
        wrapper.id = 'cloud-toggle-wrapper';

        const btn = document.createElement('button');
        btn.className = 'cloud-toggle-btn';
        btn.id = 'cloud-toggle-btn';

        // Cloud icon
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('stroke-width', '2');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z');
        icon.appendChild(path);
        btn.appendChild(icon);

        const text = document.createElement('span');
        text.textContent = 'Cloud';
        text.id = 'cloud-toggle-text';
        btn.appendChild(text);

        btn.addEventListener('click', () => this.toggleCloudMode());

        wrapper.appendChild(btn);
        return wrapper;
    },

    async checkCloudMode() {
        try {
            const settings = await API.getCloudSettings();
            this.updateCloudToggle(settings.cloud_mode_enabled, settings.credentials_configured);
        } catch (e) {
            this.updateCloudToggle(false, false);
        }
    },

    updateCloudToggle(enabled, configured) {
        const btn = document.getElementById('cloud-toggle-btn');
        const text = document.getElementById('cloud-toggle-text');
        if (!btn) return;

        if (enabled) {
            btn.className = 'cloud-toggle-btn active';
            if (text) text.textContent = 'Cloud ON';
        } else {
            btn.className = 'cloud-toggle-btn';
            if (text) text.textContent = configured ? 'Cloud OFF' : 'Cloud';
        }
    },

    async toggleCloudMode() {
        try {
            const settings = await API.getCloudSettings();

            if (!settings.credentials_configured) {
                // Open cloud login
                window.open('https://app.securevector.io/login?redirect=desktop', '_blank');
                Toast.info('Please login at app.securevector.io to enable cloud mode');
                return;
            }

            const newState = !settings.cloud_mode_enabled;
            await API.setCloudMode(newState);
            this.updateCloudToggle(newState, true);
            Toast.success(newState ? 'Cloud mode enabled' : 'Cloud mode disabled');
        } catch (error) {
            Toast.error('Failed to toggle cloud mode');
        }
    },

    createAgentDropdown() {
        const wrapper = document.createElement('div');
        wrapper.className = 'agent-dropdown-wrapper';

        const btn = document.createElement('button');
        btn.className = 'agent-dropdown-btn flashing-border';

        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('stroke-width', '2');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5');
        icon.appendChild(path);
        btn.appendChild(icon);

        const text = document.createElement('span');
        text.textContent = 'Agent Integrations';
        btn.appendChild(text);

        const arrow = document.createElement('span');
        arrow.className = 'dropdown-arrow';
        arrow.textContent = '\u25BC';
        btn.appendChild(arrow);

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleDropdown(wrapper);
        });

        wrapper.appendChild(btn);

        // Dropdown menu
        const menu = document.createElement('div');
        menu.className = 'agent-dropdown-menu';

        this.agents.forEach(agent => {
            const item = document.createElement('div');
            item.className = 'agent-dropdown-item';
            item.textContent = agent.name;
            item.addEventListener('click', () => {
                this.showAgentInstructions(agent.id);
                this.closeDropdown(wrapper);
            });
            menu.appendChild(item);
        });

        wrapper.appendChild(menu);

        // Close dropdown when clicking outside
        document.addEventListener('click', () => this.closeDropdown(wrapper));

        return wrapper;
    },

    toggleDropdown(wrapper) {
        const menu = wrapper.querySelector('.agent-dropdown-menu');
        const isOpen = menu.classList.contains('active');
        if (isOpen) {
            this.closeDropdown(wrapper);
        } else {
            menu.classList.add('active');
            this.dropdownOpen = true;
        }
    },

    closeDropdown(wrapper) {
        const menu = wrapper.querySelector('.agent-dropdown-menu');
        if (menu) {
            menu.classList.remove('active');
        }
        this.dropdownOpen = false;
    },

    showAgentInstructions(agentId) {
        const instructions = this.getAgentInstructions(agentId);
        if (!instructions) return;

        const content = document.createElement('div');
        content.className = 'agent-instructions';

        const info = document.createElement('div');
        info.className = 'agent-info';

        const desc = document.createElement('p');
        desc.textContent = instructions.description;
        info.appendChild(desc);

        content.appendChild(info);

        const block = document.createElement('div');
        block.className = 'instructions-block';

        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = instructions.code;
        pre.appendChild(code);
        block.appendChild(pre);

        const copyBtn = document.createElement('button');
        copyBtn.className = 'btn btn-small btn-primary copy-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(instructions.code).then(() => {
                copyBtn.textContent = 'Copied!';
                setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
            });
        });
        block.appendChild(copyBtn);

        content.appendChild(block);

        Modal.show({
            title: instructions.name + ' Integration',
            content: content,
            size: 'medium',
        });
    },

    getAgentInstructions(agentId) {
        const instructions = {
            'n8n': {
                name: 'n8n',
                description: 'Workflow automation platform',
                code: `1. Open your n8n workflow editor
2. Add an HTTP Request node
3. Configure the node:
   - Method: POST
   - URL: http://localhost:8741/analyze
   - Headers: Content-Type: application/json
   - Body: {"content": "{{$json.content}}"}
4. Connect to your workflow trigger`,
            },
            'dify': {
                name: 'Dify',
                description: 'LLM application development platform',
                code: `1. In Dify, go to Plugins > HTTP Request
2. Create a new tool:
   - Name: SecureVector Threat Check
   - Endpoint: http://localhost:8741/analyze
   - Method: POST
3. Add to your agent's available tools`,
            },
            'crewai': {
                name: 'CrewAI',
                description: 'AI agent orchestration framework',
                code: `from crewai import Tool
import requests

def check_threat(content: str) -> dict:
    response = requests.post(
        "http://localhost:8741/analyze",
        json={"content": content}
    )
    return response.json()

threat_tool = Tool(
    name="SecureVector Threat Check",
    func=check_threat,
    description="Check content for security threats"
)`,
            },
            'claude-desktop': {
                name: 'Claude Desktop',
                description: 'Anthropic Claude desktop application',
                code: `Add to your claude_desktop_config.json:

{
  "mcpServers": {
    "securevector": {
      "command": "securevector-mcp"
    }
  }
}`,
            },
            'openclaw': {
                name: 'OpenClaw',
                description: 'Open-source AI agent platform',
                code: `Configure the SecureVector HTTP tool:
- Endpoint: http://localhost:8741/analyze
- Method: POST
- Content-Type: application/json
- Body: {"content": "<user_input>"}`,
            },
            'langchain': {
                name: 'LangChain',
                description: 'LLM application framework',
                code: `from langchain.tools import Tool
import requests

def securevector_check(content: str) -> str:
    response = requests.post(
        "http://localhost:8741/analyze",
        json={"content": content}
    )
    result = response.json()
    return f"Risk: {result.get('risk_score', 0)}%"

tool = Tool(
    name="SecureVector",
    func=securevector_check,
    description="Check content for threats"
)`,
            },
            'langgraph': {
                name: 'LangGraph',
                description: 'Stateful agent orchestration',
                code: `from langgraph.prebuilt import ToolNode
import requests

def check_threat(content: str) -> dict:
    """Check content for security threats."""
    response = requests.post(
        "http://localhost:8741/analyze",
        json={"content": content}
    )
    return response.json()

tool_node = ToolNode(tools=[check_threat])`,
            },
        };
        return instructions[agentId];
    },

    getPageTitle() {
        const titles = {
            dashboard: 'Dashboard',
            threats: 'Threat Analytics',
            rules: 'Rules',
            settings: 'Settings',
        };
        const currentPage = window.Sidebar ? Sidebar.currentPage : 'dashboard';
        return titles[currentPage] || 'Dashboard';
    },

    getStatusText() {
        const texts = {
            checking: 'Checking...',
            healthy: 'Server Online',
            degraded: 'Degraded',
            offline: 'Offline',
        };
        return texts[this.serverStatus] || 'Unknown';
    },

    createThemeIcon() {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');

        if (isDark) {
            // Sun icon
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', '12');
            circle.setAttribute('cy', '12');
            circle.setAttribute('r', '5');
            svg.appendChild(circle);

            const rays = [
                'M12 1v2', 'M12 21v2', 'M4.22 4.22l1.42 1.42',
                'M18.36 18.36l1.42 1.42', 'M1 12h2', 'M21 12h2',
                'M4.22 19.78l1.42-1.42', 'M18.36 5.64l1.42-1.42'
            ];
            rays.forEach(d => {
                const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                line.setAttribute('d', d);
                svg.appendChild(line);
            });
        } else {
            // Moon icon
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z');
            svg.appendChild(path);
        }

        return svg;
    },

    async toggleTheme() {
        const html = document.documentElement;
        const currentTheme = html.getAttribute('data-theme') || 'dark';
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

        html.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);

        // Re-render to update icon
        this.render();
    },

    async checkStatus() {
        try {
            const health = await API.health();
            this.serverStatus = health.status || 'healthy';
        } catch (e) {
            this.serverStatus = 'offline';
        }
        this.updateStatusBadge();
    },

    updateStatusBadge() {
        const badge = document.getElementById('server-status');
        if (!badge) return;

        badge.className = 'status-badge ' + this.serverStatus;
        const textSpan = badge.querySelector('span:last-child');
        if (textSpan) {
            textSpan.textContent = this.getStatusText();
        }
    },

    updateTitle() {
        const title = document.querySelector('.header-title');
        if (title) {
            title.textContent = this.getPageTitle();
        }
    },
};

window.Header = Header;
