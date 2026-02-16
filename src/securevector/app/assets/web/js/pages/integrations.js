/**
 * Integration Pages
 * Shows setup instructions for different agent frameworks
 * Each page has Option 1 (Agent Proxy) with provider dropdown and Option 2 (SDK)
 */

const IntegrationPage = {
    // Proxy state
    proxyStatus: { running: false, provider: null, multi: false },
    currentIntegration: null, // Set when rendering an integration page

    // Check proxy status
    async checkProxyStatus() {
        try {
            const res = await fetch('/api/proxy/status');
            this.proxyStatus = await res.json();
            return this.proxyStatus;
        } catch (e) {
            return { running: false, provider: null, multi: false };
        }
    },

    // Start proxy
    async startProxy(provider, multi = false) {
        try {
            const integration = this.currentIntegration || null;
            const res = await fetch('/api/proxy/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider, multi, integration })
            });
            return await res.json();
        } catch (e) {
            return { status: 'error', message: 'Failed to connect' };
        }
    },

    // Stop proxy
    async stopProxy() {
        try {
            const res = await fetch('/api/proxy/stop', { method: 'POST' });
            return await res.json();
        } catch (e) {
            return { status: 'error', message: 'Failed to connect' };
        }
    },

    // Update all proxy buttons
    async updateProxyButtons() {
        await this.checkProxyStatus();
        const btn1 = document.getElementById('start-proxy-single');
        const btn2 = document.getElementById('start-proxy-multi');
        const stopBtn1 = document.getElementById('stop-proxy-single');
        const stopBtn2 = document.getElementById('stop-proxy-multi');
        const status1 = document.getElementById('proxy-status-single');
        const status2 = document.getElementById('proxy-status-multi');

        if (this.proxyStatus.running) {
            const modeUpper = this.proxyStatus.multi ? 'MULTI-PROVIDER' : this.proxyStatus.provider?.toUpperCase();
            if (btn1) { btn1.disabled = true; btn1.textContent = 'Proxy Running'; btn1.style.background = 'var(--accent-primary)'; }
            if (btn2) { btn2.disabled = true; btn2.textContent = 'Proxy Running'; btn2.style.background = 'var(--accent-primary)'; }
            if (stopBtn1) { stopBtn1.style.display = 'inline-block'; }
            if (stopBtn2) { stopBtn2.style.display = 'inline-block'; }
            if (status1) {
                status1.innerHTML = `<strong style="color: var(--success);">ACTIVE:</strong> ${modeUpper} proxy on port 8742`;
            }
            if (status2) {
                status2.innerHTML = `<strong style="color: var(--success);">ACTIVE:</strong> ${modeUpper} proxy on port 8742`;
            }
        } else {
            if (btn1) { btn1.disabled = false; btn1.textContent = 'Start Proxy'; btn1.style.background = 'var(--accent-primary)'; }
            if (btn2) { btn2.disabled = false; btn2.textContent = 'Start Proxy'; btn2.style.background = 'var(--accent-primary)'; }
            if (stopBtn1) { stopBtn1.style.display = 'none'; }
            if (stopBtn2) { stopBtn2.style.display = 'none'; }
            if (status1) { status1.textContent = 'Not running'; status1.style.color = 'var(--text-secondary)'; }
            if (status2) { status2.textContent = 'Not running'; status2.style.color = 'var(--text-secondary)'; }
        }
    },

    // Update OpenClaw proxy button
    async updateOpenClawProxyButton() {
        await this.checkProxyStatus();
        const btn = document.getElementById('start-proxy-openclaw');
        const stopBtn = document.getElementById('stop-proxy-openclaw');
        const status = document.getElementById('proxy-status-openclaw');

        if (this.proxyStatus.running) {
            const modeUpper = this.proxyStatus.multi ? 'MULTI-PROVIDER' : this.proxyStatus.provider?.toUpperCase();
            if (btn) { btn.disabled = true; btn.textContent = 'Proxy Running'; btn.style.background = 'var(--accent-primary)'; }
            if (stopBtn) { stopBtn.style.display = 'inline-block'; stopBtn.disabled = false; stopBtn.textContent = 'Stop Proxy'; }
            if (status) {
                status.innerHTML = `<strong style="color: var(--success);">ACTIVE:</strong> ${modeUpper} proxy on port 8742`;
            }
        } else {
            if (btn) { btn.disabled = false; btn.textContent = 'Start Multi-Provider Proxy'; btn.style.background = 'var(--accent-primary)'; }
            if (stopBtn) { stopBtn.style.display = 'none'; }
            if (status) { status.textContent = 'Not running'; status.style.color = 'var(--text-secondary)'; }
        }
    },

    // Provider configurations
    providers: {
        openai: { label: 'OpenAI', env: 'OPENAI_BASE_URL', path: '/openai/v1' },
        anthropic: { label: 'Anthropic', env: 'ANTHROPIC_BASE_URL', path: '/anthropic' },
        ollama: { label: 'Ollama', env: 'OPENAI_BASE_URL', path: '/ollama/v1' },
        groq: { label: 'Groq', env: 'OPENAI_BASE_URL', path: '/groq/v1' },
        gemini: { label: 'Google Gemini', env: 'GEMINI_API_KEY', path: '/gemini/v1beta' },
        mistral: { label: 'Mistral', env: 'OPENAI_BASE_URL', path: '/mistral/v1' },
        deepseek: { label: 'DeepSeek', env: 'OPENAI_BASE_URL', path: '/deepseek/v1' },
        together: { label: 'Together AI', env: 'OPENAI_BASE_URL', path: '/together/v1' },
        cohere: { label: 'Cohere', env: 'OPENAI_BASE_URL', path: '/cohere/v1' },
        xai: { label: 'xAI (Grok)', env: 'OPENAI_BASE_URL', path: '/xai/v1' },
        cerebras: { label: 'Cerebras', env: 'OPENAI_BASE_URL', path: '/cerebras/v1' },
        moonshot: { label: 'Moonshot', env: 'OPENAI_BASE_URL', path: '/moonshot/v1' },
        minimax: { label: 'MiniMax', env: 'OPENAI_BASE_URL', path: '/minimax/v1' },
    },

    integrations: {
        'proxy-langchain': {
            name: 'LangChain',
            description: 'Python framework for building LLM applications',
            defaultProvider: 'openai',
            sdkCode: `from langchain_core.callbacks import BaseCallbackHandler
from securevector import SecureVectorClient

class SecureVectorCallback(BaseCallbackHandler):
    def __init__(self):
        self.client = SecureVectorClient()

    def on_chat_model_start(self, serialized, messages, **kwargs):
        # Scan input for prompt injection
        for msg_list in messages:
            for msg in msg_list:
                if self.client.analyze(msg.content).is_threat:
                    raise ValueError("Blocked by SecureVector")

    def on_llm_end(self, response, **kwargs):
        # Scan output for data leakage
        for gen in response.generations:
            for g in gen:
                result = self.client.analyze(g.text, direction="output")
                if result.is_threat:
                    print(f"Warning: {result.threat_type}")

# Usage
response = chain.invoke(input, config={
    "callbacks": [SecureVectorCallback()]
})`
        },
        'proxy-langgraph': {
            name: 'LangGraph',
            description: 'Build stateful multi-agent applications',
            defaultProvider: 'openai',
            sdkCode: `from langgraph.graph import StateGraph, START, END
from securevector import SecureVectorClient
from typing import TypedDict

class State(TypedDict):
    messages: list
    blocked: bool

client = SecureVectorClient()

def input_security(state: State) -> dict:
    """Scan input for prompt injection"""
    last_msg = state["messages"][-1].content
    result = client.analyze(last_msg)
    if result.is_threat:
        raise ValueError("Blocked by SecureVector")
    return state

def output_security(state: State) -> dict:
    """Scan output for data leakage"""
    if "response" in state:
        result = client.analyze(state["response"], direction="output")
        if result.is_threat:
            state["warning"] = result.threat_type
    return state

# Add security nodes to your graph
graph.add_edge(START, "input_security")
graph.add_edge("input_security", "llm")
graph.add_edge("llm", "output_security")
graph.add_edge("output_security", END)`
        },
        'proxy-crewai': {
            name: 'CrewAI',
            description: 'Framework for orchestrating AI agents',
            defaultProvider: 'openai',
            sdkCode: `from crewai import Agent
from securevector import SecureVectorClient

client = SecureVectorClient()

def security_callback(step_output):
    """Scan each agent step for threats"""
    result = client.analyze(str(step_output))
    if result.is_threat:
        print(f"Warning: {result.threat_type}")
    return step_output

agent = Agent(
    role="Researcher",
    goal="Research topics safely",
    step_callback=security_callback
)`
        },
        'proxy-n8n': {
            name: 'n8n',
            description: 'Workflow automation platform',
            isNodeBased: true,
            nodeInstall: 'npm install @securevector/n8n-nodes-securevector',
            nodeSetup: `1. Go to Settings → Community Nodes
2. Install: @securevector/n8n-nodes-securevector
3. Drag SecureVector node into your workflow
4. Configure endpoint: http://localhost:8741`,
            apiCode: `// HTTP Request Node Configuration
// Method: POST
// URL: http://localhost:8741/analyze
// Body (JSON):
{
  "text": "={{ $json.user_input }}",
  "direction": "input"
}

// Use IF node to check response:
// Condition: {{ $json.is_threat }} equals true
// True branch: Block/Alert
// False branch: Continue to LLM`
        },
        'proxy-ollama': {
            name: 'Ollama',
            description: 'Run LLMs locally',
            defaultProvider: 'ollama',
            proxyOnly: true,
            exampleCode: `from openai import OpenAI
from securevector import SecureVectorClient

# Initialize clients
ollama = OpenAI(base_url="http://localhost:11434/v1", api_key="not-needed")
sv = SecureVectorClient()

def chat_with_protection(user_input):
    # Scan input for prompt injection
    result = sv.analyze(user_input, direction="input")
    if result.is_threat:
        return f"Blocked: {result.threat_type}"

    # Call Ollama
    response = ollama.chat.completions.create(
        model="llama3.2",
        messages=[{"role": "user", "content": user_input}]
    )
    output = response.choices[0].message.content

    # Scan output for data leakage
    result = sv.analyze(output, direction="output")
    if result.is_threat:
        return f"Warning: {result.threat_type}"

    return output`
        },
        'proxy-openclaw': {
            name: 'OpenClaw/ClawdBot',
            description: 'AI agent framework for Claude',
            isOpenClaw: true,
            defaultProvider: 'anthropic'
        }
    },

    async render(container, integrationId) {
        const integration = this.integrations[integrationId];
        if (!integration) {
            container.textContent = 'Integration not found';
            return;
        }

        // Track which integration page we're on (strip 'proxy-' prefix)
        this.currentIntegration = integrationId.replace('proxy-', '');

        container.textContent = '';

        // Header
        const header = document.createElement('div');
        header.style.cssText = 'margin-bottom: 24px;';

        const title = document.createElement('h1');
        title.className = 'dashboard-title';
        title.textContent = integration.name + ' Integration';
        header.appendChild(title);

        const desc = document.createElement('p');
        desc.className = 'dashboard-subtitle';
        desc.textContent = integration.description;
        header.appendChild(desc);

        container.appendChild(header);

        // Render based on integration type
        if (integration.isNodeBased) {
            // n8n: Node + API options
            container.appendChild(this.createNodeCard(integration));
            container.appendChild(this.createApiCard(integration));
        } else if (integration.isOpenClaw) {
            // OpenClaw: Special proxy setup with --openclaw flag
            container.appendChild(this.createOpenClawCard());
            container.appendChild(this.createRevertCard());
        } else if (integration.proxyOnly) {
            // Ollama: Multi-Provider (recommended) + Single Proxy + Example Code
            container.appendChild(this.createMultiProviderCard());
            container.appendChild(this.createProxyCard(integration, integrationId));
            if (integration.exampleCode) {
                container.appendChild(this.createExampleCodeCard(integration));
            }
        } else {
            // LangChain, LangGraph, CrewAI: Multi-Provider (recommended) + Single Proxy + SDK
            container.appendChild(this.createMultiProviderCard());
            container.appendChild(this.createProxyCard(integration, integrationId));
            container.appendChild(this.createSdkCard(integration));
        }
    },

    createProxyCard(integration, integrationId) {
        const card = document.createElement('div');
        card.style.cssText = 'background: var(--bg-card); border: 2px solid var(--accent-primary); border-radius: 8px; margin-bottom: 16px; overflow: hidden; animation: pulse-border 2s ease-in-out 3;';

        // Add pulse animation style
        if (!document.getElementById('pulse-border-style')) {
            const style = document.createElement('style');
            style.id = 'pulse-border-style';
            style.textContent = '@keyframes pulse-border { 0%, 100% { box-shadow: 0 0 0 0 rgba(0, 188, 212, 0.4); } 50% { box-shadow: 0 0 0 8px rgba(0, 188, 212, 0); } }';
            document.head.appendChild(style);
        }

        // Header with badge
        const header = document.createElement('div');
        header.style.cssText = 'padding: 16px; border-bottom: 1px solid var(--border-default); display: flex; align-items: center; justify-content: space-between;';

        const titleDiv = document.createElement('div');
        const titleText = document.createElement('div');
        titleText.style.cssText = 'font-weight: 600; font-size: 15px;';
        titleText.textContent = 'Option 2: Single Provider Proxy';
        titleDiv.appendChild(titleText);

        const subtitleText = document.createElement('div');
        subtitleText.style.cssText = 'font-size: 13px; color: var(--accent-primary); font-weight: 500;';
        subtitleText.textContent = 'Use this if you only use one LLM provider';
        titleDiv.appendChild(subtitleText);
        header.appendChild(titleDiv);

        card.appendChild(header);

        // Content
        const content = document.createElement('div');
        content.style.cssText = 'padding: 16px;';

        // Provider dropdown
        const providerRow = document.createElement('div');
        providerRow.style.cssText = 'display: flex; align-items: center; gap: 12px; margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--border-default);';

        const providerLabel = document.createElement('span');
        providerLabel.style.cssText = 'font-weight: 500; font-size: 13px; color: var(--text-secondary);';
        providerLabel.textContent = 'Select your LLM provider for your agent that you want to protect:';
        providerRow.appendChild(providerLabel);

        const providerSelect = document.createElement('select');
        providerSelect.id = 'provider-select-' + integrationId;
        providerSelect.style.cssText = 'padding: 8px 16px; border-radius: 6px; border: 2px solid var(--accent-primary); background: var(--bg-tertiary); color: var(--text-primary); font-size: 13px; cursor: pointer; font-weight: 600;';

        Object.entries(this.providers).forEach(([key, config]) => {
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = config.label;
            if (key === integration.defaultProvider) opt.selected = true;
            providerSelect.appendChild(opt);
        });

        providerSelect.addEventListener('change', () => this.updateProxySteps(integrationId));
        providerRow.appendChild(providerSelect);
        content.appendChild(providerRow);

        // Steps container (will be updated by dropdown)
        const stepsContainer = document.createElement('div');
        stepsContainer.id = 'proxy-steps-' + integrationId;
        content.appendChild(stepsContainer);

        card.appendChild(content);

        // Initial render of steps and check proxy status
        setTimeout(() => {
            this.updateProxySteps(integrationId);
            this.updateProxyButtons();
        }, 0);

        return card;
    },

    createMultiProviderCard() {
        const card = document.createElement('div');
        card.style.cssText = 'background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 8px; margin-bottom: 16px; overflow: hidden;';

        // Header
        const header = document.createElement('div');
        header.style.cssText = 'padding: 16px; border-bottom: 1px solid var(--border-default); display: flex; align-items: center; justify-content: space-between;';

        const titleDiv = document.createElement('div');
        const titleText = document.createElement('div');
        titleText.style.cssText = 'font-weight: 600; font-size: 15px;';
        titleText.textContent = 'Option 1: Multi-Provider Proxy';
        titleDiv.appendChild(titleText);

        const subtitleText = document.createElement('div');
        subtitleText.style.cssText = 'font-size: 13px; color: var(--accent-primary); font-weight: 500;';
        subtitleText.textContent = 'Works with all providers — no wrong proxy configuration';
        titleDiv.appendChild(subtitleText);
        header.appendChild(titleDiv);

        const badge = document.createElement('span');
        badge.style.cssText = 'background: #f97316; color: white; padding: 4px 10px; border-radius: 4px; font-size: 11px; font-weight: 700; flex-shrink: 0; letter-spacing: 0.5px; animation: pulse-badge 1.5s ease-in-out infinite;';
        badge.textContent = 'RECOMMENDED';
        header.appendChild(badge);

        // Add pulse animation if not already present
        if (!document.getElementById('pulse-badge-style')) {
            const style = document.createElement('style');
            style.id = 'pulse-badge-style';
            style.textContent = '@keyframes pulse-badge { 0%, 100% { opacity: 1; box-shadow: 0 0 10px rgba(249,115,22,0.6); } 50% { opacity: 0.7; box-shadow: 0 0 2px rgba(249,115,22,0.2); } }';
            document.head.appendChild(style);
        }

        card.appendChild(header);

        // Content
        const content = document.createElement('div');
        content.style.cssText = 'padding: 16px;';

        // Description
        const desc = document.createElement('div');
        desc.style.cssText = 'font-size: 13px; color: var(--text-primary); margin-bottom: 16px; line-height: 1.5; font-weight: 600;';
        desc.textContent = 'Use this if you work with multiple LLM providers. All 12 providers are available instantly \u2014 no configuration needed.';
        content.appendChild(desc);

        // Step 1
        const step1Label = document.createElement('div');
        step1Label.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--accent-primary); margin-bottom: 8px;';
        step1Label.textContent = 'Step 1: Start Multi-Provider Proxy';
        content.appendChild(step1Label);

        const step1Block = this.createCodeBlock('securevector-app --proxy --multi --web');
        step1Block.style.marginBottom = '12px';
        content.appendChild(step1Block);

        // Start Proxy button row (inside Step 1)
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display: flex; align-items: center; gap: 12px; margin-bottom: 16px;';

        const startBtn = document.createElement('button');
        startBtn.id = 'start-proxy-multi';
        startBtn.style.cssText = 'background: var(--accent-primary); color: white; border: none; padding: 10px 20px; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 13px;';
        startBtn.textContent = 'Start Multi-Provider Proxy';
        startBtn.onclick = async () => {
            startBtn.disabled = true;
            startBtn.textContent = 'Starting...';
            const result = await IntegrationPage.startProxy('openai', true);
            if (result.status === 'started') {
                await IntegrationPage.updateProxyButtons();
            } else {
                alert(result.message);
                startBtn.disabled = false;
                startBtn.textContent = 'Start Proxy';
            }
        };
        btnRow.appendChild(startBtn);

        const stopBtn = document.createElement('button');
        stopBtn.id = 'stop-proxy-multi';
        stopBtn.style.cssText = 'background: #ef4444; color: white; border: none; padding: 10px 20px; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 13px; display: none;';
        stopBtn.textContent = 'Stop Proxy';
        stopBtn.onclick = async () => {
            stopBtn.disabled = true;
            stopBtn.textContent = 'Stopping...';
            await IntegrationPage.stopProxy();
            await IntegrationPage.updateProxyButtons();
        };
        btnRow.appendChild(stopBtn);

        const statusText = document.createElement('span');
        statusText.id = 'proxy-status-multi';
        statusText.style.cssText = 'font-size: 12px; color: var(--text-secondary);';
        statusText.textContent = 'Not running';
        btnRow.appendChild(statusText);

        content.appendChild(btnRow);

        // Step 2
        const step2Label = document.createElement('div');
        step2Label.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--accent-primary); margin-bottom: 8px;';
        step2Label.textContent = 'Step 2: Set environment variables';
        content.appendChild(step2Label);

        const envRow = document.createElement('div');
        envRow.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 8px;';

        const linuxCard = document.createElement('div');
        linuxCard.style.cssText = 'background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: 8px; padding: 12px;';
        const linuxTitle = document.createElement('div');
        linuxTitle.style.cssText = 'font-weight: 600; font-size: 12px; color: var(--text-primary); margin-bottom: 8px;';
        linuxTitle.textContent = 'Linux / macOS';
        linuxCard.appendChild(linuxTitle);
        linuxCard.appendChild(this.createCodeBlock('export OPENAI_BASE_URL=http://localhost:8742/openai/v1\nexport ANTHROPIC_BASE_URL=http://localhost:8742/anthropic'));
        envRow.appendChild(linuxCard);

        const winCard = document.createElement('div');
        winCard.style.cssText = 'background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: 8px; padding: 12px;';
        const winTitle = document.createElement('div');
        winTitle.style.cssText = 'font-weight: 600; font-size: 12px; color: var(--text-primary); margin-bottom: 8px;';
        winTitle.textContent = 'Windows (PowerShell)';
        winCard.appendChild(winTitle);
        const winSessionNote = document.createElement('div');
        winSessionNote.style.cssText = 'font-size: 10px; color: var(--text-secondary); margin-bottom: 6px;';
        winSessionNote.textContent = 'Session-only (only affects this PowerShell window):';
        winCard.appendChild(winSessionNote);
        winCard.appendChild(this.createCodeBlock('$env:OPENAI_BASE_URL="http://127.0.0.1:8742/openai/v1"\n$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8742/anthropic"'));
        envRow.appendChild(winCard);

        content.appendChild(envRow);

        const step2Note = document.createElement('div');
        step2Note.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 16px;';
        step2Note.textContent = 'Then run your application. All LLM traffic will route through SecureVector.';
        content.appendChild(step2Note);

        // Available Endpoints
        const pathsLabel = document.createElement('div');
        pathsLabel.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--accent-primary); margin-bottom: 8px;';
        pathsLabel.textContent = 'Available Endpoints';
        content.appendChild(pathsLabel);

        content.appendChild(this.createCodeBlock('OpenAI:    http://localhost:8742/openai/v1\nAnthropic: http://localhost:8742/anthropic\nOllama:    http://localhost:8742/ollama/v1\nGoogle:    http://localhost:8742/gemini/v1beta\nGroq:      http://localhost:8742/groq/v1\nMistral:   http://localhost:8742/mistral/v1\nDeepSeek:  http://localhost:8742/deepseek/v1\nxAI:       http://localhost:8742/xai/v1\nTogether:  http://localhost:8742/together/v1\nCohere:    http://localhost:8742/cohere/v1\nCerebras:  http://localhost:8742/cerebras/v1\nMoonshot:  http://localhost:8742/moonshot/v1\nMiniMax:   http://localhost:8742/minimax/v1'));

        card.appendChild(content);
        return card;
    },

    createExampleCodeCard(integration) {
        const card = document.createElement('div');
        card.style.cssText = 'background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 8px; margin-bottom: 16px; overflow: hidden;';

        // Header
        const header = document.createElement('div');
        header.style.cssText = 'padding: 16px; border-bottom: 1px solid var(--border-default);';

        const titleText = document.createElement('div');
        titleText.style.cssText = 'font-weight: 600; font-size: 15px;';
        titleText.textContent = 'Option 3: Code Examples';
        header.appendChild(titleText);

        const subtitleText = document.createElement('div');
        subtitleText.style.cssText = 'font-size: 12px; color: var(--text-secondary);';
        subtitleText.textContent = 'If you like to code it yourself';
        header.appendChild(subtitleText);

        card.appendChild(header);

        // Code block
        const codeWrapper = this.createCodeBlock(integration.exampleCode);
        card.appendChild(codeWrapper);

        return card;
    },

    updateProxySteps(integrationId) {
        const select = document.getElementById('provider-select-' + integrationId);
        const container = document.getElementById('proxy-steps-' + integrationId);
        if (!select || !container) return;

        const provider = select.value;
        const config = this.providers[provider];

        // Clear container
        while (container.firstChild) {
            container.removeChild(container.firstChild);
        }

        // Step 1
        const step1Label = document.createElement('div');
        step1Label.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--accent-primary); margin-bottom: 8px;';
        step1Label.textContent = 'Step 1: Start SecureVector Proxy';
        container.appendChild(step1Label);

        const step1Block = this.createCodeBlock('securevector-app --proxy --provider ' + provider + ' --web');
        step1Block.style.marginBottom = '12px';
        container.appendChild(step1Block);

        // Start Proxy button row (inside Step 1)
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display: flex; align-items: center; gap: 12px; margin-bottom: 16px;';

        const startBtn = document.createElement('button');
        startBtn.id = 'start-proxy-single';
        startBtn.style.cssText = 'background: var(--accent-primary); color: white; border: none; padding: 10px 20px; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 13px;';
        startBtn.textContent = 'Start Proxy';
        startBtn.onclick = async () => {
            startBtn.disabled = true;
            startBtn.textContent = 'Starting...';
            const result = await IntegrationPage.startProxy(provider, false);
            if (result.status === 'started') {
                await IntegrationPage.updateProxyButtons();
            } else {
                alert(result.message);
                startBtn.disabled = false;
                startBtn.textContent = 'Start Proxy';
            }
        };
        btnRow.appendChild(startBtn);

        const stopBtn = document.createElement('button');
        stopBtn.id = 'stop-proxy-single';
        stopBtn.style.cssText = 'background: #ef4444; color: white; border: none; padding: 10px 20px; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 13px; display: none;';
        stopBtn.textContent = 'Stop Proxy';
        stopBtn.onclick = async () => {
            stopBtn.disabled = true;
            stopBtn.textContent = 'Stopping...';
            await IntegrationPage.stopProxy();
            await IntegrationPage.updateProxyButtons();
        };
        btnRow.appendChild(stopBtn);

        const statusText = document.createElement('span');
        statusText.id = 'proxy-status-single';
        statusText.style.cssText = 'font-size: 12px; color: var(--text-secondary);';
        statusText.textContent = 'Not running';
        btnRow.appendChild(statusText);

        container.appendChild(btnRow);

        // Step 2
        const step2Label = document.createElement('div');
        step2Label.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--accent-primary); margin-bottom: 8px;';
        step2Label.textContent = 'Step 2: Configure your client app';
        container.appendChild(step2Label);

        // Two-column layout: Linux/macOS | Windows
        const singleEnvRow = document.createElement('div');
        singleEnvRow.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 8px;';

        const sLinuxCard = document.createElement('div');
        sLinuxCard.style.cssText = 'background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: 8px; padding: 12px;';
        const sLinuxTitle = document.createElement('div');
        sLinuxTitle.style.cssText = 'font-weight: 600; font-size: 12px; color: var(--text-primary); margin-bottom: 8px;';
        sLinuxTitle.textContent = 'Linux / macOS';
        sLinuxCard.appendChild(sLinuxTitle);

        const sWinCard = document.createElement('div');
        sWinCard.style.cssText = 'background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: 8px; padding: 12px;';
        const sWinTitle = document.createElement('div');
        sWinTitle.style.cssText = 'font-weight: 600; font-size: 12px; color: var(--text-primary); margin-bottom: 8px;';
        sWinTitle.textContent = 'Windows (PowerShell)';
        sWinCard.appendChild(sWinTitle);

        // Special handling for Ollama - show both options for Open WebUI
        if (provider === 'ollama') {
            sLinuxCard.appendChild(this.createCodeBlock('# Option A: Ollama API\nexport OLLAMA_HOST=http://localhost:8742/ollama\n\n# Option B: OpenAI API\nexport OPENAI_BASE_URL=http://localhost:8742/ollama/v1'));
            const sWinSessionNote = document.createElement('div');
            sWinSessionNote.style.cssText = 'font-size: 10px; color: var(--text-secondary); margin-bottom: 6px;';
            sWinSessionNote.textContent = 'Session-only:';
            sWinCard.appendChild(sWinSessionNote);
            sWinCard.appendChild(this.createCodeBlock('# Option A: Ollama API\n$env:OLLAMA_HOST="http://127.0.0.1:8742/ollama"\n\n# Option B: OpenAI API\n$env:OPENAI_BASE_URL="http://127.0.0.1:8742/ollama/v1"'));

            singleEnvRow.appendChild(sLinuxCard);
            singleEnvRow.appendChild(sWinCard);
            container.appendChild(singleEnvRow);

            // Open WebUI specific
            const openwebuiLabel = document.createElement('div');
            openwebuiLabel.style.cssText = 'font-weight: 600; font-size: 12px; color: var(--text-secondary); margin-bottom: 6px;';
            openwebuiLabel.textContent = 'For Open WebUI:';
            container.appendChild(openwebuiLabel);

            const openwebuiBlock = this.createCodeBlock('Settings → Connections → Ollama URL: http://localhost:8742/ollama');
            openwebuiBlock.style.marginBottom = '8px';
            container.appendChild(openwebuiBlock);

            const step2Note = document.createElement('div');
            step2Note.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 16px;';
            step2Note.textContent = 'Traffic routes: Open WebUI → SecureVector Proxy → Ollama';
            container.appendChild(step2Note);
        } else if (provider === 'gemini') {
            // Special handling for Gemini - needs API key as env var
            sLinuxCard.appendChild(this.createCodeBlock('export GEMINI_API_KEY="your-gemini-api-key"'));
            const sWinSessionNote = document.createElement('div');
            sWinSessionNote.style.cssText = 'font-size: 10px; color: var(--text-secondary); margin-bottom: 6px;';
            sWinSessionNote.textContent = 'Session-only:';
            sWinCard.appendChild(sWinSessionNote);
            sWinCard.appendChild(this.createCodeBlock('$env:GEMINI_API_KEY="your-gemini-api-key"'));

            singleEnvRow.appendChild(sLinuxCard);
            singleEnvRow.appendChild(sWinCard);
            container.appendChild(singleEnvRow);

            const geminiNote = document.createElement('div');
            geminiNote.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 12px; padding: 10px 12px; background: rgba(0, 188, 212, 0.1); border-left: 3px solid var(--accent-primary); border-radius: 4px; line-height: 1.6;';
            const geminiStrong = document.createElement('strong');
            geminiStrong.style.color = 'var(--accent-primary)';
            geminiStrong.textContent = 'Gemini Authentication: ';
            geminiNote.appendChild(geminiStrong);
            geminiNote.appendChild(document.createTextNode('Set the API key as an environment variable. The proxy will automatically append it as '));
            const queryParam = document.createElement('code');
            queryParam.style.cssText = 'background: var(--bg-tertiary); padding: 2px 6px; border-radius: 3px; font-size: 11px;';
            queryParam.textContent = '?key=...';
            geminiNote.appendChild(queryParam);
            geminiNote.appendChild(document.createTextNode(' when forwarding to Google.'));
            container.appendChild(geminiNote);
        } else {
            sLinuxCard.appendChild(this.createCodeBlock('export ' + config.env + '=http://localhost:8742' + config.path));
            const sWinSessionNote = document.createElement('div');
            sWinSessionNote.style.cssText = 'font-size: 10px; color: var(--text-secondary); margin-bottom: 6px;';
            sWinSessionNote.textContent = 'Session-only:';
            sWinCard.appendChild(sWinSessionNote);
            sWinCard.appendChild(this.createCodeBlock('$env:' + config.env + '="http://127.0.0.1:8742' + config.path + '"'));

            singleEnvRow.appendChild(sLinuxCard);
            singleEnvRow.appendChild(sWinCard);
            container.appendChild(singleEnvRow);

            const step2Note = document.createElement('div');
            step2Note.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 16px;';
            step2Note.textContent = 'Set this in your client app. Traffic routes: Client → SecureVector → ' + config.label + '.';
            container.appendChild(step2Note);
        }

        // Update button states
        IntegrationPage.updateProxyButtons();
    },

    // OpenClaw provider configs with env vars (pi-ai supported)
    // configOnly: true means no env var override exists — needs openclaw.json custom provider config
    openclawProviders: {
        openai: { label: 'OpenAI', env: 'OPENAI_BASE_URL', path: '/openai/v1' },
        anthropic: { label: 'Anthropic', env: 'ANTHROPIC_BASE_URL', path: '/anthropic' },
        gemini: { label: 'Google Gemini', env: null, path: '/gemini/v1beta', configOnly: true },
        groq: { label: 'Groq', env: 'OPENAI_BASE_URL', path: '/groq/v1' },
        mistral: { label: 'Mistral', env: 'OPENAI_BASE_URL', path: '/mistral/v1' },
        deepseek: { label: 'DeepSeek', env: 'OPENAI_BASE_URL', path: '/deepseek/v1' },
        together: { label: 'Together AI', env: 'OPENAI_BASE_URL', path: '/together/v1' },
        cohere: { label: 'Cohere', env: 'OPENAI_BASE_URL', path: '/cohere/v1' },
        xai: { label: 'xAI (Grok)', env: 'OPENAI_BASE_URL', path: '/xai/v1' },
        cerebras: { label: 'Cerebras', env: 'OPENAI_BASE_URL', path: '/cerebras/v1' },
        moonshot: { label: 'Moonshot', env: 'OPENAI_BASE_URL', path: '/moonshot/v1' },
        minimax: { label: 'MiniMax', env: 'OPENAI_BASE_URL', path: '/minimax/v1' },
    },

    createOpenClawCard() {
        const card = document.createElement('div');
        card.style.cssText = 'background: var(--bg-card); border: 2px solid var(--accent-primary); border-radius: 8px; margin-bottom: 16px; overflow: hidden; animation: pulse-border 2s ease-in-out 3;';

        // Header
        const header = document.createElement('div');
        header.style.cssText = 'padding: 16px; border-bottom: 1px solid var(--border-default); display: flex; align-items: center; justify-content: space-between;';

        const titleDiv = document.createElement('div');
        const titleText = document.createElement('div');
        titleText.style.cssText = 'font-weight: 600; font-size: 15px;';
        titleText.textContent = 'Agent Proxy Setup';
        titleDiv.appendChild(titleText);

        const subtitleText = document.createElement('div');
        subtitleText.style.cssText = 'font-size: 12px; color: var(--text-secondary);';
        subtitleText.textContent = 'Auto-patches pi-ai for seamless integration';
        titleDiv.appendChild(subtitleText);
        header.appendChild(titleDiv);

        card.appendChild(header);

        // Content
        const content = document.createElement('div');
        content.style.cssText = 'padding: 16px;';

        // Steps container
        const stepsContainer = document.createElement('div');
        stepsContainer.id = 'openclaw-steps';
        content.appendChild(stepsContainer);

        card.appendChild(content);

        // Initial render of steps and check proxy status
        setTimeout(() => {
            this.updateOpenClawSteps();
            this.updateOpenClawProxyButton();
        }, 0);

        return card;
    },

    createRevertCard() {
        const card = document.createElement('div');
        card.style.cssText = 'background: var(--bg-card); border: 1px solid var(--warning); border-radius: 8px; margin-bottom: 16px; overflow: hidden;';

        // Header
        const header = document.createElement('div');
        header.style.cssText = 'padding: 16px; border-bottom: 1px solid var(--border-default); background: rgba(255, 152, 0, 0.1);';

        const titleText = document.createElement('div');
        titleText.style.cssText = 'font-weight: 600; font-size: 15px; color: var(--warning);';
        titleText.textContent = 'Revert SecureVector Proxy';
        header.appendChild(titleText);

        const subtitleText = document.createElement('div');
        subtitleText.style.cssText = 'font-size: 12px; color: var(--text-secondary);';
        subtitleText.textContent = 'If you no longer need the proxy, restore original pi-ai files';
        header.appendChild(subtitleText);

        card.appendChild(header);

        // Content
        const content = document.createElement('div');
        content.style.cssText = 'padding: 16px;';

        const desc = document.createElement('div');
        desc.style.cssText = 'font-size: 13px; color: var(--text-secondary); margin-bottom: 12px; line-height: 1.5;';
        desc.textContent = 'Run this command to restore the original pi-ai provider files and remove SecureVector proxy routing. Note: Manual cleanup of custom provider configs may be required (see below):';
        content.appendChild(desc);

        const revertBlock = this.createCodeBlock('securevector-app --revert-proxy');
        revertBlock.style.marginBottom = '12px';
        content.appendChild(revertBlock);

        // Gemini revert note
        const geminiNote = document.createElement('div');
        geminiNote.style.cssText = 'font-size: 12px; color: var(--text-secondary); margin-bottom: 16px; padding: 10px 14px; background: var(--bg-tertiary); border-radius: 6px; line-height: 1.6;';
        const geminiStrong = document.createElement('strong');
        geminiStrong.textContent = 'Google Gemini: ';
        geminiNote.appendChild(geminiStrong);
        geminiNote.appendChild(document.createTextNode('If you added a custom provider (gemini-sv) in ~/.openclaw/openclaw.json, also remove it from models.providers and switch back to the built-in google/gemini-2.0-flash model.'));
        content.appendChild(geminiNote);

        // Revert button
        const revertBtn = document.createElement('button');
        revertBtn.style.cssText = 'background: var(--warning); color: white; border: none; padding: 10px 20px; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 13px;';
        revertBtn.textContent = 'Revert pi-ai Files';
        revertBtn.onclick = async () => {
            if (confirm('This will restore original pi-ai files and remove proxy routing. Continue?')) {
                revertBtn.disabled = true;
                revertBtn.textContent = 'Reverting...';
                try {
                    const res = await fetch('/api/proxy/revert', { method: 'POST' });
                    const result = await res.json();
                    alert(result.message || 'Reverted successfully');
                } catch (e) {
                    alert('Failed to revert. Run: securevector-app --revert-proxy');
                }
                revertBtn.disabled = false;
                revertBtn.textContent = 'Revert pi-ai Files';
            }
        };
        content.appendChild(revertBtn);

        card.appendChild(content);
        return card;
    },

    updateOpenClawSteps() {
        const container = document.getElementById('openclaw-steps');
        if (!container) return;

        // Clear container
        while (container.firstChild) {
            container.removeChild(container.firstChild);
        }

        // Step 1
        const step1Label = document.createElement('div');
        step1Label.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--accent-primary); margin-bottom: 8px;';
        step1Label.textContent = 'Step 1: Start SecureVector with OpenClaw flag';
        container.appendChild(step1Label);

        const step1Block = this.createCodeBlock('securevector-app --proxy --multi --web --openclaw');
        step1Block.style.marginBottom = '8px';
        container.appendChild(step1Block);

        const step1Note = document.createElement('div');
        step1Note.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 12px;';
        step1Note.textContent = 'The --openclaw flag auto-patches pi-ai provider files. The --multi flag enables all providers at once.';
        container.appendChild(step1Note);

        // Start Proxy button row
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap;';

        const startBtn = document.createElement('button');
        startBtn.id = 'start-proxy-openclaw';
        startBtn.style.cssText = 'background: var(--accent-primary); color: white; border: none; padding: 10px 14px; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 12px;';
        startBtn.textContent = 'Start Multi-Provider Proxy';
        startBtn.onclick = async () => {
            startBtn.disabled = true;
            startBtn.textContent = 'Starting...';
            const result = await IntegrationPage.startProxy('openai', true);
            if (result.status === 'started') {
                await IntegrationPage.updateOpenClawProxyButton();
            } else {
                alert(result.message);
                startBtn.disabled = false;
                startBtn.textContent = 'Start Multi-Provider Proxy';
            }
        };
        btnRow.appendChild(startBtn);

        const stopBtn = document.createElement('button');
        stopBtn.id = 'stop-proxy-openclaw';
        stopBtn.style.cssText = 'background: #ef4444; color: white; border: none; padding: 10px 20px; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 13px; display: none;';
        stopBtn.textContent = 'Stop Proxy';
        stopBtn.onclick = async () => {
            stopBtn.disabled = true;
            stopBtn.textContent = 'Stopping...';
            await IntegrationPage.stopProxy();
            await IntegrationPage.updateOpenClawProxyButton();
        };
        btnRow.appendChild(stopBtn);

        const statusText = document.createElement('span');
        statusText.id = 'proxy-status-openclaw';
        statusText.style.cssText = 'font-size: 12px; color: var(--text-secondary);';
        statusText.textContent = 'Not running';
        btnRow.appendChild(statusText);

        container.appendChild(btnRow);

        // Step 2: Set environment variables
        const step2Label = document.createElement('div');
        step2Label.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--accent-primary); margin-bottom: 8px;';
        step2Label.textContent = 'Step 2: Set environment variables (in another terminal)';
        container.appendChild(step2Label);

        // Two-column layout: Linux/macOS | Windows
        const envRow = document.createElement('div');
        envRow.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 8px;';

        // Linux/macOS card
        const linuxCard = document.createElement('div');
        linuxCard.style.cssText = 'background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: 8px; padding: 12px;';
        const linuxTitle = document.createElement('div');
        linuxTitle.style.cssText = 'font-weight: 600; font-size: 12px; color: var(--text-primary); margin-bottom: 8px;';
        linuxTitle.textContent = 'Linux / macOS';
        linuxCard.appendChild(linuxTitle);
        const linuxCode = this.createCodeBlock('export OPENAI_BASE_URL=http://localhost:8742/openai/v1\nexport ANTHROPIC_BASE_URL=http://localhost:8742/anthropic\nexport GEMINI_API_KEY="your-gemini-api-key"\nexport GOOGLE_GENAI_BASE_URL=http://localhost:8742/gemini/v1beta');
        linuxCard.appendChild(linuxCode);
        envRow.appendChild(linuxCard);

        // Windows card
        const winCard = document.createElement('div');
        winCard.style.cssText = 'background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: 8px; padding: 12px;';
        const winTitle = document.createElement('div');
        winTitle.style.cssText = 'font-weight: 600; font-size: 12px; color: var(--text-primary); margin-bottom: 8px;';
        winTitle.textContent = 'Windows (PowerShell)';
        winCard.appendChild(winTitle);
        const winCodeSessionNote = document.createElement('div');
        winCodeSessionNote.style.cssText = 'font-size: 10px; color: var(--text-secondary); margin-bottom: 6px;';
        winCodeSessionNote.textContent = 'Session-only (only affects this PowerShell window):';
        winCard.appendChild(winCodeSessionNote);
        const winCode = this.createCodeBlock('$env:OPENAI_BASE_URL="http://127.0.0.1:8742/openai/v1"\n$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8742/anthropic"\n$env:GEMINI_API_KEY="your-gemini-api-key"\n$env:GOOGLE_GENAI_BASE_URL="http://127.0.0.1:8742/gemini/v1beta"');
        winCard.appendChild(winCode);
        envRow.appendChild(winCard);

        container.appendChild(envRow);

        const step2Note = document.createElement('div');
        step2Note.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 12px; line-height: 1.5;';
        step2Note.textContent = 'Your API keys (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.) should already be set in your environment. These can be set in a different terminal session.';
        container.appendChild(step2Note);

        // Gemini-specific warning
        const geminiWarning = document.createElement('div');
        geminiWarning.style.cssText = 'font-size: 12px; color: var(--text-primary); margin-bottom: 12px; padding: 12px 14px; background: rgba(255, 152, 0, 0.15); border-left: 4px solid var(--warning); border-radius: 6px; line-height: 1.6;';
        const warningIcon = document.createElement('strong');
        warningIcon.style.color = 'var(--warning)';
        warningIcon.textContent = '⚠️ GEMINI USERS ONLY: ';
        geminiWarning.appendChild(warningIcon);
        geminiWarning.appendChild(document.createTextNode('If using Google Gemini, set '));
        const geminiKeyCode = document.createElement('code');
        geminiKeyCode.style.cssText = 'background: var(--bg-tertiary); padding: 2px 6px; border-radius: 3px; font-size: 11px;';
        geminiKeyCode.textContent = 'GEMINI_API_KEY';
        geminiWarning.appendChild(geminiKeyCode);
        geminiWarning.appendChild(document.createTextNode(' and '));
        const geminiUrlCode = document.createElement('code');
        geminiUrlCode.style.cssText = 'background: var(--bg-tertiary); padding: 2px 6px; border-radius: 3px; font-size: 11px;';
        geminiUrlCode.textContent = 'GOOGLE_GENAI_BASE_URL';
        geminiWarning.appendChild(geminiUrlCode);
        geminiWarning.appendChild(document.createTextNode(' in the '));
        const sameSessionStrong = document.createElement('strong');
        sameSessionStrong.textContent = 'SAME session';
        geminiWarning.appendChild(sameSessionStrong);
        geminiWarning.appendChild(document.createTextNode(' BEFORE starting '));
        const codeEl = document.createElement('code');
        codeEl.style.cssText = 'background: var(--bg-tertiary); padding: 2px 6px; border-radius: 3px; font-size: 11px;';
        codeEl.textContent = 'securevector-app --web';
        geminiWarning.appendChild(codeEl);
        geminiWarning.appendChild(document.createTextNode('. The proxy needs to read these to inject your API key.'));
        container.appendChild(geminiWarning);

        // How to set Gemini env vars before starting
        const geminiHowTo = document.createElement('div');
        geminiHowTo.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 12px; padding: 10px 12px; background: rgba(0, 188, 212, 0.1); border-left: 3px solid var(--accent-primary); border-radius: 4px; line-height: 1.6;';
        const geminiStrong = document.createElement('strong');
        geminiStrong.style.color = 'var(--accent-primary)';
        geminiStrong.textContent = 'How to set Gemini env vars: ';
        geminiHowTo.appendChild(geminiStrong);
        geminiHowTo.appendChild(document.createTextNode('In the same terminal, run the export/set commands from Step 2 above, then immediately run '));
        const startCmd = document.createElement('code');
        startCmd.style.cssText = 'background: var(--bg-tertiary); padding: 2px 6px; border-radius: 3px; font-size: 11px;';
        startCmd.textContent = 'securevector-app --proxy --multi --web --openclaw';
        geminiHowTo.appendChild(startCmd);
        geminiHowTo.appendChild(document.createTextNode(' in that same session.'));
        container.appendChild(geminiHowTo);

        const otherNote = document.createElement('div');
        otherNote.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 16px; padding: 10px 14px; background: var(--bg-tertiary); border-radius: 6px; line-height: 1.6;';
        const otherStrong = document.createElement('strong');
        otherStrong.textContent = 'Other providers (Groq, Mistral, DeepSeek, xAI, etc.): ';
        otherNote.appendChild(otherStrong);
        otherNote.appendChild(document.createTextNode('These all share OPENAI_BASE_URL, so only one can be set via env vars at a time. The --openclaw flag in Step 1 patches each pi-ai provider file individually, routing all of them through the proxy automatically.'));
        container.appendChild(otherNote);

        // Step 3: Gemini config (Gemini needs openclaw.json custom provider — must be configured before starting OpenClaw)
        const geminiConfig = this.openclawProviders.gemini;
        const step3Label = document.createElement('div');
        step3Label.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--accent-primary); margin-bottom: 8px;';
        step3Label.textContent = 'Step 3: Configure Gemini (optional)';
        container.appendChild(step3Label);

        const geminiSection = document.createElement('div');
        geminiSection.style.cssText = 'padding: 14px; background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: 8px; margin-bottom: 16px;';

        const geminiDesc = document.createElement('div');
        geminiDesc.style.cssText = 'font-size: 12px; color: var(--text-secondary); margin-bottom: 10px; line-height: 1.5;';
        geminiDesc.textContent = 'To use Gemini through the proxy, add a custom provider to ~/.openclaw/openclaw.json under "models.providers":';
        geminiSection.appendChild(geminiDesc);

        const geminiJson = '"gemini-sv": {\n  "baseUrl": "http://localhost:8742' + geminiConfig.path + '",\n  "apiKey": "YOUR_GEMINI_API_KEY",\n  "api": "google-generative-ai",\n  "models": [\n    {\n      "id": "gemini-2.0-flash",\n      "name": "Gemini 2.0 Flash",\n      "contextWindow": 200000,\n      "maxTokens": 8192\n    }\n  ]\n}';
        const geminiBlock = this.createCodeBlock(geminiJson);
        geminiBlock.style.marginBottom = '8px';
        geminiSection.appendChild(geminiBlock);

        const geminiUsage = document.createElement('div');
        geminiUsage.style.cssText = 'font-size: 11px; color: var(--text-secondary); line-height: 1.5;';
        geminiUsage.textContent = 'Then use gemini-sv/gemini-2.0-flash as your model in OpenClaw.';
        geminiSection.appendChild(geminiUsage);

        container.appendChild(geminiSection);

        // Step 4: Start OpenClaw
        const step4Label = document.createElement('div');
        step4Label.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--accent-primary); margin-bottom: 8px;';
        step4Label.textContent = 'Step 4: Start OpenClaw (in a different terminal)';
        container.appendChild(step4Label);

        const step4Block = this.createCodeBlock('openclaw gateway');
        step4Block.style.marginBottom = '8px';
        container.appendChild(step4Block);

        const step4Note = document.createElement('div');
        step4Note.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 6px; line-height: 1.5;';
        step4Note.textContent = 'All LLM traffic from OpenClaw now routes through SecureVector for threat detection.';
        container.appendChild(step4Note);

        const step4GeminiNote = document.createElement('div');
        step4GeminiNote.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 16px; padding: 8px 10px; background: var(--bg-tertiary); border-radius: 4px; line-height: 1.5;';
        const step4Strong = document.createElement('strong');
        step4Strong.textContent = 'For apps using Gemini: ';
        step4GeminiNote.appendChild(step4Strong);
        step4GeminiNote.appendChild(document.createTextNode('The app (OpenClaw) can run in any terminal session. Only the SecureVector proxy needs the Gemini env vars set in its session (from Step 1).'));
        container.appendChild(step4GeminiNote);

        // Not proxyable note
        const notProxyableNote = document.createElement('div');
        notProxyableNote.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-top: 12px; padding: 10px 14px; background: var(--bg-tertiary); border-radius: 6px; line-height: 1.5;';
        const noteStrong = document.createElement('strong');
        noteStrong.textContent = 'Note: ';
        notProxyableNote.appendChild(noteStrong);
        notProxyableNote.appendChild(document.createTextNode('Google Vertex AI and Amazon Bedrock use cloud SDK auth (GCP IAM / AWS SigV4) and are not proxyable. OpenAI Codex uses OAuth, not standard API keys.'));
        container.appendChild(notProxyableNote);

        // Update button states
        IntegrationPage.updateOpenClawProxyButton();
    },

    createSdkCard(integration) {
        const card = document.createElement('div');
        card.style.cssText = 'background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 8px; margin-bottom: 16px; overflow: hidden;';

        // Header
        const header = document.createElement('div');
        header.style.cssText = 'padding: 16px; border-bottom: 1px solid var(--border-default);';

        const titleText = document.createElement('div');
        titleText.style.cssText = 'font-weight: 600; font-size: 15px;';
        titleText.textContent = 'Option 3: SDK Integration';
        header.appendChild(titleText);

        const subtitleText = document.createElement('div');
        subtitleText.style.cssText = 'font-size: 12px; color: var(--text-secondary);';
        subtitleText.textContent = 'If you like to code it yourself';
        header.appendChild(subtitleText);

        card.appendChild(header);

        // Code block
        card.appendChild(this.createCodeBlock(integration.sdkCode));

        return card;
    },

    createNodeCard(integration) {
        const card = document.createElement('div');
        card.style.cssText = 'background: var(--bg-card); border: 2px solid var(--accent-primary); border-radius: 8px; margin-bottom: 16px; overflow: hidden; animation: pulse-border 2s ease-in-out 3;';

        // Header
        const header = document.createElement('div');
        header.style.cssText = 'padding: 16px; border-bottom: 1px solid var(--border-default); display: flex; align-items: center; justify-content: space-between;';

        const titleDiv = document.createElement('div');
        const titleText = document.createElement('div');
        titleText.style.cssText = 'font-weight: 600; font-size: 15px;';
        titleText.textContent = 'Option 1: Community Node';
        titleDiv.appendChild(titleText);

        const subtitleText = document.createElement('div');
        subtitleText.style.cssText = 'font-size: 12px; color: var(--text-secondary);';
        subtitleText.textContent = 'Install and drag into your workflow';
        titleDiv.appendChild(subtitleText);
        header.appendChild(titleDiv);

        const badge = document.createElement('span');
        badge.style.cssText = 'background: var(--accent-primary); color: white; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;';
        badge.textContent = 'RECOMMENDED';
        header.appendChild(badge);

        card.appendChild(header);

        // Content
        const content = document.createElement('div');
        content.style.cssText = 'padding: 16px;';

        // Install command
        const installLabel = document.createElement('div');
        installLabel.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--accent-primary); margin-bottom: 8px;';
        installLabel.textContent = 'Install';
        content.appendChild(installLabel);

        const installBlock = this.createCodeBlock(integration.nodeInstall);
        installBlock.style.marginBottom = '16px';
        content.appendChild(installBlock);

        // Setup steps
        const setupLabel = document.createElement('div');
        setupLabel.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--accent-primary); margin-bottom: 8px;';
        setupLabel.textContent = 'Setup';
        content.appendChild(setupLabel);

        content.appendChild(this.createCodeBlock(integration.nodeSetup));

        card.appendChild(content);
        return card;
    },

    createCodeBlock(code) {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'position: relative;';

        const pre = document.createElement('pre');
        pre.style.cssText = 'background: var(--bg-tertiary); padding: 12px 14px; padding-right: 60px; border-radius: 6px; overflow-x: auto; font-size: 12px; line-height: 1.5; margin: 0; border: 1px solid var(--border-color); white-space: pre;';

        const codeEl = document.createElement('code');
        codeEl.style.cssText = 'color: var(--text-primary); font-family: monospace;';
        codeEl.textContent = code;
        pre.appendChild(codeEl);

        const copyBtn = document.createElement('button');
        copyBtn.style.cssText = 'position: absolute; top: 6px; right: 6px; padding: 2px 8px; font-size: 10px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 3px; color: var(--text-secondary); cursor: pointer;';
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(code).then(() => {
                copyBtn.textContent = 'Copied!';
                copyBtn.style.color = 'var(--success, #10b981)';
                setTimeout(() => {
                    copyBtn.textContent = 'Copy';
                    copyBtn.style.color = 'var(--text-secondary)';
                }, 2000);
            });
        });

        wrapper.appendChild(pre);
        wrapper.appendChild(copyBtn);
        return wrapper;
    },

    createApiCard(integration) {
        const card = document.createElement('div');
        card.style.cssText = 'background: var(--bg-card); border: 1px solid var(--border-default); border-radius: 8px; margin-bottom: 16px; overflow: hidden;';

        // Header
        const header = document.createElement('div');
        header.style.cssText = 'padding: 16px; border-bottom: 1px solid var(--border-default);';

        const titleText = document.createElement('div');
        titleText.style.cssText = 'font-weight: 600; font-size: 15px;';
        titleText.textContent = 'Option 2: HTTP Request Node';
        header.appendChild(titleText);

        const subtitleText = document.createElement('div');
        subtitleText.style.cssText = 'font-size: 12px; color: var(--text-secondary);';
        subtitleText.textContent = 'Alternative: Use built-in HTTP node';
        header.appendChild(subtitleText);

        card.appendChild(header);

        // Code block
        card.appendChild(this.createCodeBlock(integration.apiCode));

        return card;
    }
};

window.IntegrationPage = IntegrationPage;
