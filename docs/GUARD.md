# `@guard`: one decorator for any Python agent

`@guard` puts a plain Python function under SecureVector. It ships inside the
`securevector-ai-monitor` package, has no dependencies beyond the standard library, and
talks to the local app you already run (or to a self-hosted engine).

Use it when your agent calls OpenAI, Anthropic, Bedrock or Gemini directly, or
is just a loop of Python functions, and there is no framework SDK to install.

## Install and run

```bash
pip install securevector-ai-monitor[app]
securevector-app            # starts the local app on http://127.0.0.1:8741
```

```python
from securevector import guard

@guard
def search_web(query: str) -> str:
    return http_get(f"https://search.example/?q={query}")

search_web("weather in Austin")
```

Open the app. The call is in **Tool Activity** with its arguments preview, in
**Agent Runs** grouped under the current session, and in the audit chain.

## What one call does

1. **Arguments in.** The bound arguments are serialised to JSON and scanned as
   text heading from the user to a tool (`direction=outgoing`): prompt
   injection, jailbreaks, secrets, data-exfiltration patterns.
2. **Decide.** In `observe` mode (default) a finding is recorded and the
   function runs. In `enforce` mode a finding at or above the risk threshold
   stops the call with `GuardBlocked` before the function runs.
3. **Return value out.** The result is scanned as fetched context heading back
   to the model (`direction=incoming`), which is the indirect prompt injection
   scan. Output findings are always recorded and never raised, because the
   result already exists.
4. **Audit.** One row is written with the tool id, function name, action
   (`allow`, `log_only` or `block`), risk, reason, a redacted 500-character
   preview of the arguments, the session id and a per-call request id.

If the app cannot be reached the function runs unscanned, nothing is raised,
and one warning is logged per process.

## Options

```python
@guard(
    tool_id="db.query",     # name shown in the app; defaults to the function name
    mode="enforce",         # observe | enforce; overrides the environment for this function
    scan_output=False,      # skip the return-value scan for large or binary results
)
def run_sql(sql: str) -> list[dict]: ...
```

Sync and `async def` functions are both supported. Methods work; `self` is
dropped from the preview.

### Sessions

Calls are grouped in Agent Runs by session. By default every process gets one
session id. To group one agent run explicitly:

```python
with guard.session("ticket-8812"):
    plan = think(task)
    for step in plan:
        act(step)
```

The session id propagates through `asyncio` tasks started inside the block.

### Blocking

```python
from securevector import guard, GuardBlocked

@guard(mode="enforce")
def run_shell(cmd: str) -> str: ...

try:
    run_shell(user_supplied_command)
except GuardBlocked as e:
    print(e.tool_id, e.reason, e.risk_score)
```

## Configuration

Read once from the environment. Same names as the framework SDKs.

| Variable | Default | Meaning |
|---|---|---|
| `SECUREVECTOR_ENGINE_ENDPOINT` or `SECUREVECTOR_SDK_APP_URL` | `http://127.0.0.1:8741` | Local app or self-hosted engine URL |
| `SECUREVECTOR_SDK_MODE` | `observe` | `observe` records findings, `enforce` blocks on argument findings |
| `SECUREVECTOR_SDK_RISK_THRESHOLD` | `70` | Risk score at or above which `enforce` blocks |
| `SECUREVECTOR_SDK_TIMEOUT_MS` | `3000` | Per-request timeout to the app |
| `SECUREVECTOR_SDK_DISABLED` | unset | `1` makes the decorator a no-op |
| `SECUREVECTOR_API_KEY` | unset | Sent as a bearer token to a self-hosted engine |

For tests or custom wiring, pass a `GuardConfig` and a transport directly:

```python
from securevector.guard import GuardConfig, AppTransport, guard

cfg = GuardConfig(base_url="https://engine.internal", mode="enforce")
@guard(config=cfg, transport=AppTransport(cfg))
def tool(x): ...
```

## What is stored

The app stores the redacted argument preview (500 characters), the action,
risk and reason, not the full arguments or the return value. Text sent to the
scan endpoint is capped at 100 KB and is not persisted by the scan itself.
Obvious credential shapes (AWS keys, GitHub tokens, `sk-` keys, `password:`
fields) are redacted client-side before the preview leaves the process.

## Compared with the framework SDKs

The LangChain, LangGraph, CrewAI and Hermes SDKs hook into the framework's own
tool-call path, so you install them and change nothing. `@guard` is for code
that has no framework: you choose which functions count as tools. Both write
the same rows to the same app.
