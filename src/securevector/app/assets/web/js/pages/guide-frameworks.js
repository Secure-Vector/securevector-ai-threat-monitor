/**
 * Framework SDKs (LangChain / LangGraph / CrewAI) — setup guide page.
 *
 * Sibling of guide-claude-code.js / guide-cursor.js. Covers the SecureVector
 * SDK family that secures *tool calls* (not just LLM traffic) for the three
 * agent frameworks. Each SDK ships as a separate package that also installs
 * this local app and writes to the same tamper-evident audit chain, tagged
 * runtime_kind=langchain|langgraph|crewai. Keep in sync with the SDK repos
 * (securevector-sdk-langchain / -langgraph / -crewai).
 */
const GuideFrameworksPage = {
    async render(container) {
        container.textContent = '';

        const root = document.createElement('div');
        root.style.cssText = 'max-width: 920px; margin: 0 auto; padding: 24px 32px; font-size: 14px; line-height: 1.6; color: var(--text-primary);';

        // --- Header ---
        const header = document.createElement('div');
        header.style.cssText = 'margin-bottom: 28px;';
        const eyebrow = document.createElement('div');
        eyebrow.style.cssText = 'font-size: 11px; font-weight: 700; letter-spacing: 1.5px; text-transform: uppercase; color: var(--accent-primary); margin-bottom: 6px;';
        eyebrow.textContent = 'Integration Guide';
        header.appendChild(eyebrow);
        const h1 = document.createElement('h1');
        h1.style.cssText = 'font-size: 28px; font-weight: 700; margin: 0 0 8px 0; color: var(--text-primary);';
        h1.textContent = 'Framework SDKs — LangChain · LangGraph · CrewAI';
        header.appendChild(h1);
        const lede = document.createElement('p');
        lede.style.cssText = 'color: var(--text-secondary); margin: 0;';
        lede.textContent = 'One import brings tool-call permissions, secret/data-leak detection, and threat detection to every tool your agent calls — written to the tamper-evident audit chain and tagged runtime_kind so it shows up in the Agent Map and Runs. The SDK is a thin interception layer; this local app is the engine.';
        header.appendChild(lede);
        root.appendChild(header);

        // --- Helpers (mirror guide-cursor.js) ---
        const h2 = (text) => { const el = document.createElement('h2'); el.style.cssText = 'font-size: 18px; font-weight: 700; margin: 28px 0 10px 0; color: var(--text-primary); border-bottom: 1px solid var(--border-default); padding-bottom: 6px;'; el.textContent = text; return el; };
        const h3 = (text) => { const el = document.createElement('h3'); el.style.cssText = 'font-size: 14px; font-weight: 700; margin: 18px 0 6px 0; color: var(--text-primary);'; el.textContent = text; return el; };
        const p = (text) => { const el = document.createElement('p'); el.style.cssText = 'margin: 8px 0; color: var(--text-secondary);'; el.textContent = text; return el; };
        const code = (text) => {
            const wrap = document.createElement('div'); wrap.style.cssText = 'position: relative; margin: 8px 0;';
            const pre = document.createElement('pre'); pre.style.cssText = 'padding: 12px 14px; background: var(--bg-tertiary); border: 1px solid var(--border-default); border-radius: 6px; font-family: monospace; font-size: 12px; user-select: all; overflow-x: auto; margin: 0; white-space: pre; color: var(--text-primary);'; pre.textContent = text; wrap.appendChild(pre);
            const copyBtn = document.createElement('button'); copyBtn.type = 'button'; copyBtn.setAttribute('aria-label', 'Copy code to clipboard'); copyBtn.style.cssText = 'position: absolute; top: 6px; right: 6px; padding: 4px 10px; font-size: 11px; background: var(--bg-secondary); border: 1px solid var(--border-default); border-radius: 4px; color: var(--text-secondary); cursor: pointer;'; copyBtn.textContent = 'Copy';
            copyBtn.onclick = async () => { try { await navigator.clipboard.writeText(text); copyBtn.textContent = 'Copied'; setTimeout(() => copyBtn.textContent = 'Copy', 1200); } catch { copyBtn.textContent = 'Copy failed'; } };
            wrap.appendChild(copyBtn); return wrap;
        };
        const table = (cols, rows) => {
            const t = document.createElement('table'); t.style.cssText = 'width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 13px;';
            t.innerHTML = '<thead><tr>' + cols.map(c => `<th style="text-align:left; padding:8px 10px; border-bottom:2px solid var(--border-default);">${c}</th>`).join('') + '</tr></thead>';
            const tb = document.createElement('tbody');
            rows.forEach(r => { const tr = document.createElement('tr'); tr.innerHTML = r.map((cell, i) => `<td style="padding:8px 10px; border-bottom:1px solid var(--border-default); ${i === 0 ? 'font-weight:600;' : 'color:var(--text-secondary);'}">${cell}</td>`).join(''); tb.appendChild(tr); });
            t.appendChild(tb); return t;
        };
        const callout = (label, body) => {
            const el = document.createElement('div');
            el.style.cssText = 'margin: 12px 0; padding: 12px 14px; border: 1px solid var(--border-default); border-left: 3px solid var(--accent-primary); border-radius: 6px; background: var(--bg-tertiary);';
            const ip = document.createElement('p'); ip.style.cssText = 'margin: 0; color: var(--text-primary); font-size: 13px; line-height: 1.55;';
            const strong = document.createElement('strong'); strong.style.color = 'var(--text-primary)'; strong.textContent = label + ' ';
            ip.appendChild(strong); ip.appendChild(document.createTextNode(body)); el.appendChild(ip); return el;
        };

        // --- What the SDK does ---
        root.appendChild(h2('What the SDK does'));
        root.appendChild(p('Each tool call your agent makes is intercepted before it runs. The SDK normalizes a canonical tool id, then routes the call through the same three controls this app already runs for the CLI plugins:'));
        root.appendChild(table(['Control', 'On tool input', 'On tool output'], [
            ['Tool-call permissions', 'allow / block per policy (synced → override → essential → default-allow)', '—'],
            ['Secret / data-leak detection', 'scans serialized args', 'scans the tool result'],
            ['Threat detection', 'prompt-injection / malicious content', 'indirect-injection in fetched data'],
        ]));
        root.appendChild(p('Every decision is written to the tamper-evident audit chain with runtime_kind attribution, so the calls appear in the Agent Map and Runs alongside your CLI agents. This supports your EU AI Act Art. 12 / 15 record-keeping with attributed, tamper-evident action logs.'));

        // --- Install ---
        root.appendChild(h2('1. Install'));
        root.appendChild(p('Pick the package for your framework. Each one also installs this local app (securevector-ai-monitor) — one command delivers the adapter and the engine.'));
        root.appendChild(code('pip install securevector-sdk-langchain     # or -langgraph, or -crewai'));
        root.appendChild(callout('The app must be running locally.', 'The SDK is a thin interception layer that talks to this app over loopback (http://127.0.0.1:8741). Start it with securevector-app --web. If the app is down, observe mode fails open (tool runs) and enforce mode fails closed (tool denied).'));

        // --- Self-host / remote engine (Terraform) ---
        root.appendChild(h3('Pointing at a self-hosted engine (Terraform / your own cloud)'));
        root.appendChild(p('Deployed the engine to your own cloud with the SecureVector Terraform modules? Agents don’t need the bundled app — install the adapter only (--no-deps) and point it at your deployment’s endpoint URL.'));
        root.appendChild(code(`# adapter only — skip the bundled app (your env already has the framework)
pip install securevector-sdk-langchain --no-deps     # or -langgraph / -crewai

# point at your engine endpoint (the URL from \`terraform output\`)
export SECUREVECTOR_ENGINE_ENDPOINT=https://<your-engine-endpoint>`));
        root.appendChild(callout('Engine, not cloud.', 'SECUREVECTOR_ENGINE_ENDPOINT is where tool calls go for analysis — your local app OR your self-host / Terraform engine. It is NOT the SecureVector cloud (scan.securevector.io). The legacy SECUREVECTOR_SDK_APP_URL still works as a fallback.'));
        root.appendChild(p('Auth is optional. A private (in-VPC) endpoint needs no credential — the default, and the least friction. Only if you expose the endpoint publicly and gate it (Terraform ingress_token — enforced by a v4.9.0+ engine; older images set but ignore it) do you set a key; use a free SecureVector account key or an SVET token — it gates inbound access only and forwards no data:'));
        root.appendChild(code(`export SECUREVECTOR_API_KEY=<SecureVector account key or SVET token>   # optional — public gated endpoint only`));

        // --- LangChain ---
        root.appendChild(h2('2. Wire it up'));
        root.appendChild(h3('LangChain'));
        root.appendChild(p('Use the wrap_tool_call middleware via create_agent. A denied tool is short-circuited with a ToolMessage before it runs — no exceptions, no crashed run.'));
        root.appendChild(code(`from langchain.agents import create_agent
from securevector_sdk_langchain import secure_middleware

agent = create_agent(
    model, tools,
    middleware=[secure_middleware(mode="enforce")],
)`));
        root.appendChild(p('For legacy AgentExecutor / raw LCEL chains where middleware isn’t available, pass the observe-only callback handler instead — it logs but cannot block:'));
        root.appendChild(code(`from securevector_sdk_langchain import SecureVectorCallbackHandler
chain.invoke(payload, config={"callbacks": [SecureVectorCallbackHandler()]})`));

        // --- LangGraph ---
        root.appendChild(h3('LangGraph'));
        root.appendChild(p('The same middleware works, attached via the langgraph-backed create_agent:'));
        root.appendChild(code(`from langchain.agents import create_agent  # langgraph-backed
from securevector_sdk_langgraph import secure_middleware

agent = create_agent(model, tools, middleware=[secure_middleware(mode="enforce")])`));
        root.appendChild(callout('Note:', 'langgraph.prebuilt.create_react_agent does NOT take a middleware argument — use create_agent. For a raw StateGraph with custom tool nodes, gate execution with LangGraph’s interrupt() inside the tool (human/programmatic approval); the observe callback handler still logs through graph config.'));
        root.appendChild(code(`from langgraph.types import interrupt

@tool
def run_query(sql: str):
    interrupt({"action": "run_query", "args": {"sql": sql}})  # pause for approval
    ...`));

        // --- CrewAI ---
        root.appendChild(h3('CrewAI'));
        root.appendChild(p('CrewAI isn’t built on langchain-core, so wrap your tools instead. observe logs every call; enforce raises before the tool’s _run executes.'));
        root.appendChild(code(`from crewai import Agent
from securevector_sdk_crewai import secure_tools

agent = Agent(role="Researcher", goal="Research safely", tools=secure_tools(my_tools))`));
        root.appendChild(p('Or install globally (best-effort monkeypatch of CrewAI’s BaseTool):'));
        root.appendChild(code(`from securevector_sdk_crewai import install
install(mode="observe")`));

        // --- observe vs enforce ---
        root.appendChild(h2('observe vs enforce'));
        root.appendChild(table(['Mode', 'App reachable', 'App unreachable'], [
            ['observe (default)', 'log + advisory verdict; tool always runs', 'tool runs (fail-open)'],
            ['enforce (opt-in)', 'tool runs only if the verdict ≠ block', 'tool denied (fail-closed)'],
        ]));
        root.appendChild(p('observe is the safe funnel default; enforce is the compliance posture (the control cannot be silently bypassed). enforce prints a one-time disclosure to stderr.'));

        // --- Seeing it ---
        root.appendChild(h2('Seeing it in this app'));
        root.appendChild(p('Run your agent once with the SDK installed. The Integrations card for your framework auto-detects the first tool call and flips to Active with live counters — no "connect" step. The calls also appear in:'));
        const ul = document.createElement('ul'); ul.style.cssText = 'margin: 8px 0 8px 18px; color: var(--text-secondary);';
        [['Agent Map', 'a node per runtime_kind (langchain / langgraph / crewai), with calls and blocked counts'],
         ['Runs', 'each session as its own run, with per-tool decisions'],
         ['Evidence (CSV)', 'export from the Integrations card for an auditor-ready, attributed record']].forEach(([k, v]) => {
            const li = document.createElement('li'); li.style.cssText = 'margin: 4px 0;';
            const s = document.createElement('strong'); s.style.color = 'var(--text-primary)'; s.textContent = k + ' — '; li.appendChild(s); li.appendChild(document.createTextNode(v)); ul.appendChild(li);
        });
        root.appendChild(ul);

        // One shortcut per framework — symmetric, so LangGraph/CrewAI users get one too.
        const ctaRow = document.createElement('div');
        ctaRow.style.cssText = 'display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px;';
        [['LangChain', 'proxy-langchain'], ['LangGraph', 'proxy-langgraph'], ['CrewAI', 'proxy-crewai']].forEach(([label, navId]) => {
            const cta = document.createElement('button');
            cta.type = 'button';
            cta.style.cssText = 'padding: 8px 16px; border-radius: 6px; border: 1px solid var(--accent-primary); background: transparent; color: var(--accent-primary); font-size: 13px; font-weight: 600; cursor: pointer;';
            cta.textContent = 'Open ' + label + ' integration →';
            cta.onclick = () => { try { Sidebar.navigate(navId); } catch (e) { console.error('navigate failed', e); } };
            ctaRow.appendChild(cta);
        });
        root.appendChild(ctaRow);

        // Non-affiliation disclaimer for the named third-party frameworks.
        const disclaimer = document.createElement('p');
        disclaimer.style.cssText = 'margin: 24px 0 0; padding-top: 12px; border-top: 1px solid var(--border-default); font-size: 11px; color: var(--text-secondary);';
        disclaimer.textContent = 'SecureVector is an independent project and is not affiliated with or endorsed by Anthropic, LangChain, or CrewAI. Product names are used nominatively to identify the target framework.';
        root.appendChild(disclaimer);

        container.appendChild(root);
    },
};
