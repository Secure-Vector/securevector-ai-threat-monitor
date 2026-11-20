# SecureVector plugin for Hermes Agent

Sends the token usage of each model API call, each tool call and the session
boundaries to the local SecureVector app. It talks only to the SecureVector
app, by default at `http://127.0.0.1:8741` (override with
`SECUREVECTOR_ENGINE_ENDPOINT`).

- Cost: `post_api_request`, one record per API call.
- Tool calls: `post_tool_call`, one audit row per call (tool name and a
  redacted arguments preview, capped at 8 KB).
- Sessions: `on_session_start` marks the start, `on_session_end` marks the
  end of a turn, `on_session_finalize` marks the end of the session.
- Sends: provider, model, token counts (cache reads and writes included),
  tool names and redacted arguments, Hermes session id and request id. No
  prompts, no responses, no tool results.
- The redacted tool arguments go to whatever `SECUREVECTOR_ENGINE_ENDPOINT`
  points at.
- Observe only: never blocks, changes or fails a turn. Each record is sent in
  the background with a 2 second timeout.
- When the `securevector-sdk-hermes` cost hook is registered it records cost,
  and this plugin sends no cost. When its tool hook is registered it writes
  the tool-call audit, and this plugin sends no tool rows. A session marker is
  not sent when the SDK registers that session hook.
- Hermes auxiliary model calls (titles, compression) fire no plugin hook, so
  their cost is not recorded.

Install from the SecureVector app (Connect Agents, Hermes) or with
`securevector-app --install-plugin hermes`. It is copied to
`$HERMES_HOME/plugins/securevector` (default `~/.hermes`) and added to
`plugins.enabled` in `$HERMES_HOME/config.yaml`.
