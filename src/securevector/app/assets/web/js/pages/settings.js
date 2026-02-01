/**
 * Settings Page
 * Application settings including cloud mode and agent integrations
 */

const SettingsPage = {
    cloudEnabled: false,

    // Agent integration instructions
    agents: [
        {
            id: 'n8n',
            name: 'n8n',
            description: 'Workflow automation platform',
            instructions: `
1. Open your n8n workflow editor
2. Add an HTTP Request node
3. Configure the node:
   - Method: POST
   - URL: http://localhost:45678/api/v1/analyze
   - Headers: Content-Type: application/json
   - Body: {"content": "{{$json.content}}"}
4. Connect to your workflow trigger
            `.trim(),
        },
        {
            id: 'dify',
            name: 'Dify',
            description: 'LLM application development platform',
            instructions: `
1. In Dify, go to Plugins > HTTP Request
2. Create a new tool:
   - Name: SecureVector Threat Check
   - Endpoint: http://localhost:45678/api/v1/analyze
   - Method: POST
3. Add to your agent's available tools
4. The agent can now check content for threats
            `.trim(),
        },
        {
            id: 'crewai',
            name: 'CrewAI',
            description: 'AI agent orchestration framework',
            instructions: `
from crewai import Tool
import requests

def check_threat(content: str) -> dict:
    response = requests.post(
        "http://localhost:45678/api/v1/analyze",
        json={"content": content}
    )
    return response.json()

threat_tool = Tool(
    name="SecureVector Threat Check",
    func=check_threat,
    description="Check content for security threats"
)

# Add to your agent's tools
agent = Agent(tools=[threat_tool], ...)
            `.trim(),
        },
        {
            id: 'claude-desktop',
            name: 'Claude Desktop',
            description: 'Anthropic Claude desktop application',
            instructions: `
Add to your claude_desktop_config.json:

{
  "mcpServers": {
    "securevector": {
      "command": "securevector",
      "args": ["mcp"]
    }
  }
}

Claude can then use the threat analysis tools directly.
            `.trim(),
        },
        {
            id: 'openclaw',
            name: 'OpenClaw',
            description: 'Open-source AI agent platform',
            instructions: `
1. Configure the SecureVector HTTP tool:
   - Endpoint: http://localhost:45678/api/v1/analyze
   - Method: POST
   - Content-Type: application/json
2. Add as available tool in your agent config
3. Enable threat checking in your workflows
            `.trim(),
        },
        {
            id: 'langchain',
            name: 'LangChain',
            description: 'LLM application framework',
            instructions: `
from langchain.tools import Tool
import requests

def securevector_check(content: str) -> str:
    response = requests.post(
        "http://localhost:45678/api/v1/analyze",
        json={"content": content}
    )
    result = response.json()
    return f"Risk: {result.get('risk_score', 0)}%"

tool = Tool(
    name="SecureVector",
    func=securevector_check,
    description="Check content for security threats"
)

# Add to your agent
agent = initialize_agent(tools=[tool], ...)
            `.trim(),
        },
        {
            id: 'langgraph',
            name: 'LangGraph',
            description: 'Stateful agent orchestration',
            instructions: `
from langgraph.prebuilt import ToolNode
import requests

def check_threat(content: str) -> dict:
    """Check content for security threats using SecureVector."""
    response = requests.post(
        "http://localhost:45678/api/v1/analyze",
        json={"content": content}
    )
    return response.json()

# Add to your graph's tool node
tool_node = ToolNode(tools=[check_threat])
            `.trim(),
        },
    ],

    async render(container) {
        container.textContent = '';

        // Loading state
        const loading = document.createElement('div');
        loading.className = 'loading-container';
        const spinner = document.createElement('div');
        spinner.className = 'spinner';
        loading.appendChild(spinner);
        container.appendChild(loading);

        try {
            const cloudMode = await API.getCloudMode();
            this.cloudEnabled = cloudMode.enabled || false;
            this.renderContent(container);
        } catch (error) {
            this.cloudEnabled = false;
            this.renderContent(container);
        }
    },

    renderContent(container) {
        container.textContent = '';

        // Cloud Mode Section
        const cloudSection = this.createSection('Cloud Mode', 'Sync threat data with SecureVector cloud');
        const cloudCard = Card.create({ gradient: true });
        const cloudBody = cloudCard.querySelector('.card-body');

        const cloudRow = document.createElement('div');
        cloudRow.className = 'setting-row';

        const cloudInfo = document.createElement('div');
        cloudInfo.className = 'setting-info';

        const cloudLabel = document.createElement('span');
        cloudLabel.className = 'setting-label';
        cloudLabel.textContent = 'Enable Cloud Sync';
        cloudInfo.appendChild(cloudLabel);

        const cloudDesc = document.createElement('span');
        cloudDesc.className = 'setting-description';
        cloudDesc.textContent = 'Sync local threat data with the cloud for enhanced analytics';
        cloudInfo.appendChild(cloudDesc);

        cloudRow.appendChild(cloudInfo);

        // Toggle
        const toggle = document.createElement('label');
        toggle.className = 'toggle';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = this.cloudEnabled;
        checkbox.addEventListener('change', (e) => this.toggleCloudMode(e.target.checked));
        toggle.appendChild(checkbox);

        const slider = document.createElement('span');
        slider.className = 'toggle-slider';
        toggle.appendChild(slider);

        cloudRow.appendChild(toggle);
        cloudBody.appendChild(cloudRow);
        cloudSection.appendChild(cloudCard);
        container.appendChild(cloudSection);

        // Theme Section
        const themeSection = this.createSection('Appearance', 'Customize the look and feel');
        const themeCard = Card.create({ gradient: true });
        const themeBody = themeCard.querySelector('.card-body');

        const themeRow = document.createElement('div');
        themeRow.className = 'setting-row';

        const themeInfo = document.createElement('div');
        themeInfo.className = 'setting-info';

        const themeLabel = document.createElement('span');
        themeLabel.className = 'setting-label';
        themeLabel.textContent = 'Theme';
        themeInfo.appendChild(themeLabel);

        themeRow.appendChild(themeInfo);

        // Theme buttons
        const themeButtons = document.createElement('div');
        themeButtons.className = 'theme-buttons';

        const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';

        ['light', 'dark'].forEach(theme => {
            const btn = document.createElement('button');
            btn.className = 'btn btn-small' + (currentTheme === theme ? ' btn-primary' : '');
            btn.textContent = theme.charAt(0).toUpperCase() + theme.slice(1);
            btn.addEventListener('click', () => this.setTheme(theme));
            themeButtons.appendChild(btn);
        });

        themeRow.appendChild(themeButtons);
        themeBody.appendChild(themeRow);
        themeSection.appendChild(themeCard);
        container.appendChild(themeSection);

        // Agent Integrations Section
        const agentSection = this.createSection('Agent Integrations', 'Connect SecureVector to your AI agents');

        // Agent dropdown
        const agentCard = Card.create({ gradient: true });
        const agentBody = agentCard.querySelector('.card-body');

        const selectRow = document.createElement('div');
        selectRow.className = 'setting-row';

        const selectLabel = document.createElement('label');
        selectLabel.textContent = 'Select Agent Platform';
        selectLabel.className = 'setting-label';
        selectRow.appendChild(selectLabel);

        const select = document.createElement('select');
        select.className = 'filter-select agent-select';
        select.id = 'agent-select';

        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = 'Choose an agent...';
        select.appendChild(defaultOption);

        this.agents.forEach(agent => {
            const option = document.createElement('option');
            option.value = agent.id;
            option.textContent = agent.name;
            select.appendChild(option);
        });

        select.addEventListener('change', (e) => this.showAgentInstructions(e.target.value));
        selectRow.appendChild(select);
        agentBody.appendChild(selectRow);

        // Instructions container
        const instructionsDiv = document.createElement('div');
        instructionsDiv.id = 'agent-instructions';
        instructionsDiv.className = 'agent-instructions';
        agentBody.appendChild(instructionsDiv);

        agentSection.appendChild(agentCard);
        container.appendChild(agentSection);
    },

    createSection(title, description) {
        const section = document.createElement('div');
        section.className = 'settings-section';

        const header = document.createElement('div');
        header.className = 'section-header';

        const titleEl = document.createElement('h2');
        titleEl.className = 'section-title';
        titleEl.textContent = title;
        header.appendChild(titleEl);

        if (description) {
            const descEl = document.createElement('p');
            descEl.className = 'section-description';
            descEl.textContent = description;
            header.appendChild(descEl);
        }

        section.appendChild(header);
        return section;
    },

    async toggleCloudMode(enabled) {
        try {
            await API.setCloudMode(enabled);
            this.cloudEnabled = enabled;
            Toast.success(enabled ? 'Cloud mode enabled' : 'Cloud mode disabled');
        } catch (error) {
            Toast.error('Failed to update cloud mode');
            // Revert the toggle
            const checkbox = document.querySelector('.settings-section input[type="checkbox"]');
            if (checkbox) {
                checkbox.checked = !enabled;
            }
        }
    },

    async setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);

        try {
            await API.setTheme(theme);
        } catch (e) {
            // Ignore errors
        }

        // Update button states
        document.querySelectorAll('.theme-buttons .btn').forEach(btn => {
            btn.classList.toggle('btn-primary', btn.textContent.toLowerCase() === theme);
        });

        // Update header theme icon
        if (window.Header) {
            Header.render();
        }

        Toast.success('Theme updated');
    },

    showAgentInstructions(agentId) {
        const container = document.getElementById('agent-instructions');
        if (!container) return;

        container.textContent = '';

        if (!agentId) return;

        const agent = this.agents.find(a => a.id === agentId);
        if (!agent) return;

        // Agent info
        const info = document.createElement('div');
        info.className = 'agent-info';

        const name = document.createElement('h4');
        name.textContent = agent.name;
        info.appendChild(name);

        const desc = document.createElement('p');
        desc.textContent = agent.description;
        info.appendChild(desc);

        container.appendChild(info);

        // Instructions
        const instructions = document.createElement('div');
        instructions.className = 'instructions-block';

        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = agent.instructions;
        pre.appendChild(code);
        instructions.appendChild(pre);

        // Copy button
        const copyBtn = document.createElement('button');
        copyBtn.className = 'btn btn-small copy-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(agent.instructions).then(() => {
                Toast.success('Copied to clipboard');
            }).catch(() => {
                Toast.error('Failed to copy');
            });
        });
        instructions.appendChild(copyBtn);

        container.appendChild(instructions);
    },
};

window.SettingsPage = SettingsPage;
