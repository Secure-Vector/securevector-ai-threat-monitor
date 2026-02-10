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
        gemini: { label: 'Google Gemini', env: 'OPENAI_BASE_URL', path: '/gemini/v1beta' },
        azure: { label: 'Azure OpenAI', env: 'AZURE_OPENAI_BASE_URL', path: '/azure' },
        mistral: { label: 'Mistral', env: 'OPENAI_BASE_URL', path: '/mistral/v1' },
        deepseek: { label: 'DeepSeek', env: 'OPENAI_BASE_URL', path: '/deepseek/v1' },
        openrouter: { label: 'OpenRouter', env: 'OPENAI_BASE_URL', path: '/openrouter/v1' },
        together: { label: 'Together AI', env: 'OPENAI_BASE_URL', path: '/together/v1' },
        fireworks: { label: 'Fireworks AI', env: 'OPENAI_BASE_URL', path: '/fireworks/v1' },
        perplexity: { label: 'Perplexity', env: 'OPENAI_BASE_URL', path: '/perplexity/v1' },
        cohere: { label: 'Cohere', env: 'OPENAI_BASE_URL', path: '/cohere/v1' },
        xai: { label: 'xAI (Grok)', env: 'OPENAI_BASE_URL', path: '/xai/v1' },
        cerebras: { label: 'Cerebras', env: 'OPENAI_BASE_URL', path: '/cerebras/v1' },
        moonshot: { label: 'Moonshot', env: 'OPENAI_BASE_URL', path: '/moonshot/v1' },
        minimax: { label: 'MiniMax', env: 'OPENAI_BASE_URL', path: '/minimax/v1' },
        lmstudio: { label: 'LM Studio', env: 'OPENAI_BASE_URL', path: '/lmstudio/v1' },
        litellm: { label: 'LiteLLM', env: 'OPENAI_BASE_URL', path: '/litellm/v1' },
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
            name: 'OpenClaw/ClaudBot',
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
            container.appendChild(this.createOpenClawCard(integration));
            container.appendChild(this.createRevertCard());
        } else if (integration.proxyOnly) {
            // Ollama: Proxy + Multi-Provider + Example Code
            container.appendChild(this.createProxyCard(integration, integrationId));
            container.appendChild(this.createMultiProviderCard());
            if (integration.exampleCode) {
                container.appendChild(this.createExampleCodeCard(integration));
            }
        } else {
            // LangChain, LangGraph, CrewAI: Proxy + Multi-Provider + SDK
            container.appendChild(this.createProxyCard(integration, integrationId));
            container.appendChild(this.createMultiProviderCard());
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
        titleText.textContent = 'Option 1: Agent Proxy';
        titleDiv.appendChild(titleText);

        const subtitleText = document.createElement('div');
        subtitleText.style.cssText = 'font-size: 13px; color: var(--accent-primary); font-weight: 500;';
        subtitleText.textContent = 'For single LLM across multiple agents';
        titleDiv.appendChild(subtitleText);
        header.appendChild(titleDiv);

        const badge = document.createElement('span');
        badge.style.cssText = 'background: var(--accent-primary); color: white; padding: 4px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;';
        badge.textContent = 'QUICK START';
        header.appendChild(badge);

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
        header.style.cssText = 'padding: 16px; border-bottom: 1px solid var(--border-default);';

        const titleText = document.createElement('div');
        titleText.style.cssText = 'font-weight: 600; font-size: 15px;';
        titleText.textContent = 'Option 2: Multi-Provider Proxy';
        header.appendChild(titleText);

        const subtitleText = document.createElement('div');
        subtitleText.style.cssText = 'font-size: 13px; color: var(--accent-primary); font-weight: 500;';
        subtitleText.textContent = 'If you are planning to use multiple LLMs across multiple agents';
        header.appendChild(subtitleText);

        card.appendChild(header);

        // Content
        const content = document.createElement('div');
        content.style.cssText = 'padding: 16px;';

        // Description
        const desc = document.createElement('div');
        desc.style.cssText = 'font-size: 13px; color: var(--text-secondary); margin-bottom: 16px; line-height: 1.5;';
        desc.textContent = 'The --multi flag enables path-based routing. Agents often use multiple LLMs (e.g., GPT-4 for reasoning, Claude for coding). One proxy protects all traffic.';
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
        startBtn.textContent = 'Start Proxy';
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

        const step2Block = this.createCodeBlock('export OPENAI_BASE_URL=http://localhost:8742/openai/v1\nexport ANTHROPIC_BASE_URL=http://localhost:8742/anthropic');
        step2Block.style.marginBottom = '8px';
        content.appendChild(step2Block);

        const step2Note = document.createElement('div');
        step2Note.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 16px;';
        step2Note.textContent = 'Then run your application. All LLM traffic will route through SecureVector.';
        content.appendChild(step2Note);

        // Available Endpoints
        const pathsLabel = document.createElement('div');
        pathsLabel.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--accent-primary); margin-bottom: 8px;';
        pathsLabel.textContent = 'Available Endpoints';
        content.appendChild(pathsLabel);

        content.appendChild(this.createCodeBlock('OpenAI:    http://localhost:8742/openai/v1\nAnthropic: http://localhost:8742/anthropic\nGoogle:    http://localhost:8742/gemini/v1\nOllama:    http://localhost:8742/ollama/v1\nGroq:      http://localhost:8742/groq/v1\nAzure:     http://localhost:8742/azure/v1\nMistral:   http://localhost:8742/mistral/v1\nDeepSeek:  http://localhost:8742/deepseek/v1'));

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
        const integration = this.integrations[integrationId];

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

        // Special handling for Ollama - show both options for Open WebUI
        if (provider === 'ollama') {
            const ollamaBlock = this.createCodeBlock('# Option A: Ollama API\nexport OLLAMA_HOST=http://localhost:8742/ollama\n\n# Option B: OpenAI API\nexport OPENAI_BASE_URL=http://localhost:8742/ollama/v1');
            ollamaBlock.style.marginBottom = '12px';
            container.appendChild(ollamaBlock);

            // Open WebUI specific
            const openwebuiLabel = document.createElement('div');
            openwebuiLabel.style.cssText = 'font-size: 12px; font-weight: 600; color: var(--text-primary); margin-bottom: 6px;';
            openwebuiLabel.textContent = 'For Open WebUI:';
            container.appendChild(openwebuiLabel);

            const openwebuiBlock = this.createCodeBlock('Settings → Connections → Ollama URL: http://localhost:8742/ollama');
            openwebuiBlock.style.marginBottom = '8px';
            container.appendChild(openwebuiBlock);

            const step2Note = document.createElement('div');
            step2Note.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 16px;';
            step2Note.textContent = 'Traffic routes: Open WebUI → SecureVector Proxy → Ollama';
            container.appendChild(step2Note);
        } else {
            const envBlock = this.createCodeBlock(config.env + '=http://localhost:8742' + config.path);
            envBlock.style.marginBottom = '8px';
            container.appendChild(envBlock);

            const step2Note = document.createElement('div');
            step2Note.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 16px;';
            step2Note.textContent = 'Set this in your client app (Open WebUI, scripts, etc). Traffic routes: Client → SecureVector → ' + config.label + '.';
            container.appendChild(step2Note);
        }

        // Update button states
        IntegrationPage.updateProxyButtons();
    },

    // OpenClaw provider configs with env vars (pi-ai supported)
    openclawProviders: {
        openai: { label: 'OpenAI', env: 'OPENAI_BASE_URL', path: '/openai/v1' },
        anthropic: { label: 'Anthropic', env: 'ANTHROPIC_BASE_URL', path: '/anthropic' },
        ollama: { label: 'Ollama', env: 'OPENAI_BASE_URL', path: '/ollama/v1' },
        groq: { label: 'Groq', env: 'OPENAI_BASE_URL', path: '/groq/v1' },
        gemini: { label: 'Google Gemini', env: 'OPENAI_BASE_URL', path: '/gemini/v1beta' },
        azure: { label: 'Azure OpenAI', env: 'AZURE_OPENAI_BASE_URL', path: '/azure' },
        mistral: { label: 'Mistral', env: 'OPENAI_BASE_URL', path: '/mistral/v1' },
        deepseek: { label: 'DeepSeek', env: 'OPENAI_BASE_URL', path: '/deepseek/v1' },
        openrouter: { label: 'OpenRouter', env: 'OPENAI_BASE_URL', path: '/openrouter/v1' },
        together: { label: 'Together AI', env: 'OPENAI_BASE_URL', path: '/together/v1' },
        fireworks: { label: 'Fireworks AI', env: 'OPENAI_BASE_URL', path: '/fireworks/v1' },
        perplexity: { label: 'Perplexity', env: 'OPENAI_BASE_URL', path: '/perplexity/v1' },
        cohere: { label: 'Cohere', env: 'OPENAI_BASE_URL', path: '/cohere/v1' },
        xai: { label: 'xAI (Grok)', env: 'OPENAI_BASE_URL', path: '/xai/v1' },
        cerebras: { label: 'Cerebras', env: 'OPENAI_BASE_URL', path: '/cerebras/v1' },
        moonshot: { label: 'Moonshot', env: 'OPENAI_BASE_URL', path: '/moonshot/v1' },
        minimax: { label: 'MiniMax', env: 'OPENAI_BASE_URL', path: '/minimax/v1' },
        lmstudio: { label: 'LM Studio', env: 'OPENAI_BASE_URL', path: '/lmstudio/v1' },
        litellm: { label: 'LiteLLM', env: 'OPENAI_BASE_URL', path: '/litellm/v1' },
    },

    createOpenClawCard(integration) {
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

        // Provider dropdown
        const providerRow = document.createElement('div');
        providerRow.style.cssText = 'display: flex; align-items: center; gap: 12px; margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid var(--border-default);';

        const providerLabel = document.createElement('span');
        providerLabel.style.cssText = 'font-weight: 500; font-size: 13px; color: var(--text-secondary);';
        providerLabel.textContent = 'Select your LLM provider for your agent that you want to protect:';
        providerRow.appendChild(providerLabel);

        const providerSelect = document.createElement('select');
        providerSelect.id = 'openclaw-provider-select';
        providerSelect.style.cssText = 'padding: 8px 16px; border-radius: 6px; border: 2px solid var(--accent-primary); background: var(--bg-tertiary); color: var(--text-primary); font-size: 13px; cursor: pointer; font-weight: 600;';

        Object.entries(this.openclawProviders).forEach(([key, config]) => {
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = config.label;
            if (key === 'anthropic') opt.selected = true;
            providerSelect.appendChild(opt);
        });

        providerSelect.addEventListener('change', () => this.updateOpenClawSteps());
        providerRow.appendChild(providerSelect);
        content.appendChild(providerRow);

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
        desc.textContent = 'Run this command to restore the original pi-ai provider files and remove SecureVector proxy routing:';
        content.appendChild(desc);

        const revertBlock = this.createCodeBlock('securevector-app --revert-proxy');
        revertBlock.style.marginBottom = '16px';
        content.appendChild(revertBlock);

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
        const select = document.getElementById('openclaw-provider-select');
        const container = document.getElementById('openclaw-steps');
        if (!select || !container) return;

        const provider = select.value;
        const config = this.openclawProviders[provider];

        // Clear container
        while (container.firstChild) {
            container.removeChild(container.firstChild);
        }

        // Step 1
        const step1Label = document.createElement('div');
        step1Label.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--accent-primary); margin-bottom: 8px;';
        step1Label.textContent = 'Step 1: Start SecureVector with OpenClaw flag';
        container.appendChild(step1Label);

        const step1Block = this.createCodeBlock('securevector-app --proxy --provider ' + provider + ' --web --openclaw');
        step1Block.style.marginBottom = '8px';
        container.appendChild(step1Block);

        const step1Note = document.createElement('div');
        step1Note.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 12px;';
        step1Note.textContent = 'The --openclaw flag auto-patches pi-ai provider files to route through SecureVector.';
        container.appendChild(step1Note);

        // Start Proxy button row (inside Step 1)
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display: flex; align-items: center; gap: 12px; margin-bottom: 16px;';

        // Single provider button
        const singleBtn = document.createElement('button');
        singleBtn.id = 'start-proxy-openclaw-single';
        singleBtn.style.cssText = 'background: var(--bg-tertiary); color: var(--text-primary); border: 1px solid var(--border-default); padding: 10px 14px; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 12px;';
        singleBtn.textContent = 'Start Single';
        singleBtn.onclick = async () => {
            singleBtn.disabled = true;
            singleBtn.textContent = 'Starting...';
            const result = await IntegrationPage.startProxy(provider, false);
            if (result.status === 'started') {
                await IntegrationPage.updateOpenClawProxyButton();
            } else {
                alert(result.message);
                singleBtn.disabled = false;
                singleBtn.textContent = 'Start Single';
            }
        };
        btnRow.appendChild(singleBtn);

        // Multi-provider button (recommended)
        const startBtn = document.createElement('button');
        startBtn.id = 'start-proxy-openclaw';
        startBtn.style.cssText = 'background: var(--accent-primary); color: white; border: none; padding: 10px 14px; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 12px;';
        startBtn.textContent = 'Start Multi (Recommended)';
        startBtn.onclick = async () => {
            startBtn.disabled = true;
            startBtn.textContent = 'Starting...';
            const result = await IntegrationPage.startProxy('openai', true);
            if (result.status === 'started') {
                await IntegrationPage.updateOpenClawProxyButton();
            } else {
                alert(result.message);
                startBtn.disabled = false;
                startBtn.textContent = 'Start Multi (Recommended)';
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

        // Multi-provider explanation
        const multiNote = document.createElement('div');
        multiNote.style.cssText = 'font-size: 11px; color: var(--text-secondary); margin-bottom: 16px; padding: 10px; background: var(--bg-tertiary); border-radius: 6px;';
        multiNote.textContent = 'Multi-provider mode allows OpenClaw to switch between LLMs (Claude, GPT, Gemini, Ollama) without restarting. Each provider has its own path: /anthropic, /openai/v1, /gemini/v1, etc.';
        container.appendChild(multiNote);

        // Step 2
        const step2Label = document.createElement('div');
        step2Label.style.cssText = 'font-weight: 600; font-size: 13px; color: var(--accent-primary); margin-bottom: 8px;';
        step2Label.textContent = 'Step 2: Start OpenClaw (in another terminal)';
        container.appendChild(step2Label);

        const step2Block = this.createCodeBlock(config.env + '=http://localhost:8742' + config.path + ' openclaw gateway');
        step2Block.style.marginBottom = '8px';
        container.appendChild(step2Block);

        const step2Note = document.createElement('div');
        step2Note.style.cssText = 'font-size: 11px; color: var(--text-secondary);';
        step2Note.textContent = 'Traffic now routes through SecureVector proxy for threat detection.';
        container.appendChild(step2Note);

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
