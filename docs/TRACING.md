# Traces for any Python agent: model calls, tokens, cost and verdicts

One run of your agent becomes one trace in the app's **Traces** page: every
model call with its model, tokens, cost, input and output previews, duration
and a verdict, and every `@guard` tool call nested under the model turn that
asked for it. The run list shows tokens and cost per run and marks runs where
one turn carries most of the spend.

Nothing to install beyond the app. The SDK is part of `securevector-ai-monitor`
and uses only the standard library.

## Two lines for OpenAI and Anthropic

```python
from securevector import guard, instrument

instrument()   # patches the openai and anthropic clients that are installed

with guard.session("ticket-8812", user_id="u-42", tags=["prod"]):
    reply = client.chat.completions.create(model="gpt-4o", messages=messages)
    result = search_web(reply.choices[0].message.content)   # a @guard tool
```

`instrument()` wraps `chat.completions.create`, `responses.create` and
`messages.create`, sync and async, streaming included. It returns the list of
providers it patched, so you can assert on it in a startup check. Calling it
twice is harmless.

## Any other provider: one span per call

```python
from securevector import guard

with guard.generation(model="anthropic.claude-3-5-sonnet-20241022-v2:0",
                      provider="bedrock", input=messages) as gen:
    r = bedrock.converse(modelId=..., messages=messages)
    gen.end(output=r["output"]["message"],
            usage={"input": r["usage"]["inputTokens"],
                   "output": r["usage"]["outputTokens"]})
```

`usage` accepts the plain `{"input", "output", "cache_read"}` shape and the
usage objects the OpenAI, Anthropic and Bedrock clients return. `end()` is
optional: leaving the block records what is known. An exception inside the
block closes the span with the error type. `async with` works the same way.

## What a trace shows

| On the run list | On each model turn | On each tool call |
|---|---|---|
| tokens, cost, model turns, tool calls, blocked count | model, provider, tokens in and out (cached shown separately), cost, duration, finish reason, verdict, prompt and response previews | tool, arguments preview, verdict, the model turn it belongs to |

The trace header adds spend per model and the costliest turn. A run whose
single largest turn is more than half of its spend gets a mark in the list.

## Sessions and identity

`guard.session(session_id, user_id=None, tags=None, metadata=None)` groups
everything inside the block into one run and stamps the identity on every
model turn. Without a session the process gets one id. The session
propagates into `asyncio` tasks started inside the block.

A `@guard` tool call is linked to the model turn that is open, or else to the
most recent turn that finished in the session: the usual loop, where the model
asks for a tool and the tool runs after the call returns. A new session starts
with no previous turn.

## Verdicts on model turns

The app scans the prompt as text heading to the model and the response as
model output, the same rules and models it applies to tool calls. A finding
is recorded on the turn and in **Threats**; it never changes the model call,
which has already happened. In `enforce` mode, `guard.generation()` scans the
prompt before the call and raises `GuardBlocked` at or above the risk
threshold, so the request never leaves your process. `instrument()` follows
the same setting.

## Send traces without the SDK

The app accepts OpenTelemetry traces over OTLP/HTTP JSON at `/v1/traces`.
Any agent instrumented with the GenAI semantic conventions works as is:

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:8741/v1/traces
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_SERVICE_NAME=my-agent            # becomes the runtime shown in Traces
```

Spans are read as follows:

| Span | Stored as | Attributes read |
|---|---|---|
| `gen_ai.operation.name` in `chat`, `text_completion`, `generate_content`, `embeddings` | model turn | `gen_ai.system`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.response.finish_reasons`, prompt and completion from the `gen_ai.content.prompt` and `gen_ai.content.completion` events or the `gen_ai.input.messages` and `gen_ai.output.messages` attributes |
| `gen_ai.operation.name` = `execute_tool` | tool call | `gen_ai.tool.name`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `parentSpanId` |
| anything else | skipped, counted in the response | |

`session.id` and `user.id` on the span or the resource set the run and the
user; without `session.id` the trace id is the run. Resending a batch updates
the same rows. Protobuf is not accepted; the endpoint answers 415 with the
setting to change. The response is the standard `partialSuccess` object plus
a `securevector` object with `accepted` and `skipped` counts.

## Configuration

The same variables as `@guard`:

| Variable | Default | Meaning |
|---|---|---|
| `SECUREVECTOR_ENGINE_ENDPOINT` or `SECUREVECTOR_SDK_APP_URL` | `http://127.0.0.1:8741` | Local app or self-hosted engine |
| `SECUREVECTOR_SDK_MODE` | `observe` | `enforce` blocks a model call on a prompt finding |
| `SECUREVECTOR_SDK_RISK_THRESHOLD` | `70` | Risk at or above which `enforce` blocks |
| `SECUREVECTOR_SDK_TIMEOUT_MS` | `3000` | Per-request timeout to the app |
| `SECUREVECTOR_SDK_DISABLED` | unset | `1` turns tracing and `@guard` into no-ops |
| `SECUREVECTOR_API_KEY` | unset | Bearer token for a self-hosted engine |

Spans are buffered in the process and sent in one request at most every 200
milliseconds and at exit. If the app is down the model call runs unchanged and
one warning is logged per process.

## What is stored

Per model turn: model, provider, tokens, cost, duration, finish reason,
verdict, and a 500-character redacted preview of the prompt and the response
when the store-text setting is on. The full prompt and response are sent to
the app for scanning and are kept only with a threat record on a finding,
under the same setting; see the storage note in [GUARD.md](GUARD.md).
