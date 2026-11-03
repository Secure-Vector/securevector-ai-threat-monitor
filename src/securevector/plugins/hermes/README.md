# SecureVector plugin for Hermes Agent

Sends the token usage of each model API call Hermes makes to SecureVector Cost
Tracking. It talks only to the SecureVector app, by default at
`http://127.0.0.1:8741` (override with `SECUREVECTOR_ENGINE_ENDPOINT`).

- Hook: `post_api_request`, one record per API call.
- Sends: provider, model, token counts (cache reads and writes included),
  Hermes session id and request id. No prompts, no responses.
- Never blocks or fails a turn: each record is sent in the background with a
  2 second timeout.
- When the `securevector-sdk-hermes` cost hook is registered it records cost,
  and this plugin stays quiet so nothing is counted twice.

Install from the SecureVector app (Connect Agents, Hermes) or with
`securevector-app --install-plugin hermes`. It is copied to
`~/.hermes/plugins/securevector` and added to `plugins.enabled` in
`~/.hermes/config.yaml`.
