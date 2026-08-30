// SPDX-License-Identifier: Apache-2.0
/**
 * SecureVector Guard — OpenCode plugin entry point.
 *
 * Unlike every sibling Guard plugin, this one is NOT a set of subprocess hook
 * scripts driven by stdin/stdout JSON. OpenCode loads plugins as in-process ES
 * modules (`packages/opencode/src/plugin/index.ts`): the default export is an
 * async factory that receives `{ client, project, directory, worktree, $ }`
 * and returns an object of hook functions. Consequences:
 *   - no `hooks.json`, no manifest, no per-call `node` spawn;
 *   - `lib/*.js` are imported, not executed, so the ~40ms process-startup cost
 *     that bounds the subprocess harnesses is simply absent;
 *   - the plugin shares the host's process, so an uncaught throw is the
 *     host's problem, not ours (see the fail-open note below).
 *
 * Hook wiring (all names verified against the exported `Hooks` interface in
 * @opencode-ai/plugin @ 1.18.23):
 *   tool.execute.before  → enforcement. Deny = throw.
 *   tool.execute.after   → tamper-evident audit row + tool-RESPONSE scan.
 *   chat.message         → prompt scan (observe-only, never blocks).
 *   permission.ask       → collapse the approval prompt on an existing deny.
 *   event                → session lifecycle (session.created audit row).
 *
 * ⚠️  FAIL-OPEN INVERSION — the single most important thing in this file.
 * OpenCode's documented way to block a tool call is to THROW from
 * `tool.execute.before`. `Plugin.trigger` invokes hooks via
 * `Effect.promise(async () => fn(input, output))` with NO catch, so a
 * rejection becomes an unrecoverable Effect defect. That means an accidental
 * error in this plugin — local app down, fetch reject, JSON parse failure — is
 * INDISTINGUISHABLE from a deliberate block and would fail CLOSED, breaking
 * the user's session. SecureVector's locked decision #5 is fail-OPEN.
 * Therefore every hook body here is wrapped in try/catch, and the ONLY thing
 * ever rethrown is a `SecureVectorDenial` we constructed on purpose.
 * Do not add a `throw` outside that pattern.
 */

import {
  RUNTIME_KIND,
  SOURCE,
  SecureVectorDenial,
  THREAT_SCAN_RESPONSE_LIMIT,
  THREAT_SCAN_RESPONSE_MARKER_GATED_TOOLS,
  THREAT_SCAN_RESPONSE_TOOLS,
  THREAT_SCAN_TEXT_LIMIT,
  THREAT_SCAN_TOOLS,
  brand,
  buildAuditBody,
  decide,
  effectToAction,
  extractPromptText,
  extractScanText,
  extractScanTextFromResponse,
  pickMatch,
  redact,
  requestIdFor,
  resolveBaseUrl,
} from './lib/decide.js';
import { normalize, isMcpToolName } from './lib/normalize.js';
import { fetchSyncedOverrides, getJson, postJsonAndForget } from './lib/client.js';
import { hasCredentialMarkers } from './lib/redact.js';

const INACTIVE_NOTICE = (baseUrl) =>
  'SecureVector Guard is installed but INACTIVE: the local SecureVector app at '
  + baseUrl + ' is not reachable, so tool calls are NOT being enforced or audited '
  + 'this session (failing open). Install and start the free SecureVector app to '
  + 'activate policy enforcement + tamper-evident audit. See https://securevector.io\n';

/**
 * Surface a branded block notice in the TUI.
 *
 * The thrown error's message is what OpenCode feeds back to the model, but
 * whether the human sees it depends on how the TUI renders a tool failure. A
 * toast guarantees the person at the keyboard learns *why* the call was
 * blocked. Entirely best-effort: `client.tui.showToast` is an HTTP call to the
 * host's own server, so it is fire-and-forget and never awaited on the deny
 * path (awaiting it would add latency to a blocked call for no benefit).
 */
function notifyBlocked(client, reason) {
  try {
    const show = client && client.tui && client.tui.showToast;
    if (typeof show !== 'function') return;
    const p = client.tui.showToast({
      body: { title: 'SecureVector Guard', message: String(reason), variant: 'error', duration: 8000 },
    });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* never let a cosmetic notice affect enforcement */ }
}

export const SecureVectorGuard = async ({ client }) => {
  const baseUrl = resolveBaseUrl();

  // Reachability probe, once per plugin load. Keyed on the SHAPE of the
  // response (presence of the `synced` key) rather than on whether any rules
  // came back, so a healthy-but-empty app doesn't produce a false warning.
  // getJson fails open (returns {} on error/timeout/non-2xx).
  try {
    const overrides = await getJson(`${baseUrl}/api/tool-permissions/synced-overrides`);
    const reachable = overrides && typeof overrides === 'object'
      && Object.prototype.hasOwnProperty.call(overrides, 'synced');
    if (!reachable) process.stderr.write(INACTIVE_NOTICE(baseUrl));
  } catch { /* fail-open — never block plugin load */ }

  // Tool calls denied in tool.execute.before, keyed by callID. OpenCode fires
  // permission.ask AFTER tool.execute.before on the MCP path, so a call we
  // already blocked would otherwise still prompt the user for approval.
  const denied = new Map();

  return {
    /**
     * ENFORCEMENT. Fires on every tool call, built-in and MCP alike, before
     * OpenCode's own permission check (`ctx.ask`) — so a policy deny wins
     * without the user ever being prompted.
     */
    'tool.execute.before': async (input, output) => {
      let denial = null;
      try {
        const toolName = (input && input.tool) || '';
        const sessionId = (input && input.sessionID) || null;
        const callId = (input && input.callID) || null;
        const args = (output && output.args) || null;

        const decision = await decide(toolName, baseUrl, sessionId, args);
        if (!decision || decision.decision === 'allow') return;

        const requestId = requestIdFor(callId);
        const toolId = decision.toolId || toolName;

        // PostToolUse never runs for a blocked call, so without this the
        // highest-value security events leave no audit trail.
        try {
          postJsonAndForget(
            `${baseUrl}/api/tool-permissions/call-audit`,
            buildAuditBody(toolName, toolId, args, decision.decision, decision.reason, sessionId, requestId),
          );
        } catch { /* audit is best-effort; it must not affect the decision */ }

        // `ask` has no interactive answer path from inside this hook, and a
        // cloud-managed prompt rule has no human to answer it. Record it and
        // let the call through — OpenCode's own permission flow still applies.
        if (decision.decision !== 'deny') return;

        let reason = decision.reason || 'Blocked by policy.';
        if (decision.requestable) {
          try {
            postJsonAndForget(`${baseUrl}/api/jit/requests`, {
              tool_id: toolId,
              function_name: toolName,
              runtime_kind: RUNTIME_KIND,
              session_id: sessionId,
            });
          } catch { /* best-effort */ }
          reason += ' — an access request was filed; a human can approve '
            + 'time-boxed access in SecureVector → Tool Permissions.';
        }

        if (callId) denied.set(callId, true);
        notifyBlocked(client, brand(reason));
        denial = new SecureVectorDenial(brand(reason));
      } catch {
        // Fail-open: any unexpected error allows the call. Never rethrow here
        // — see the header note; a throw IS a deny in OpenCode.
        return;
      }
      // Rethrown outside the try so a deliberate denial can never be
      // swallowed by our own fail-open catch.
      if (denial) throw denial;
    },

    /**
     * Collapse OpenCode's approval prompt for a call we already denied.
     * Complement only, NOT the enforcement point: most OpenCode permissions
     * resolve to "allow" (only doom_loop and external_directory default to
     * "ask"), so this hook never fires for the majority of tools.
     */
    'permission.ask': async (input, output) => {
      try {
        const callId = input && (input.callID || (input.tool && input.tool.callID));
        if (callId && denied.get(callId)) {
          denied.delete(callId);
          output.status = 'deny';
        }
      } catch { /* fail-open */ }
    },

    /**
     * AUDIT + INCOMING SCAN. One row per completed tool call, plus an IDPI /
     * secret-leak scan of the response for tools that return untrusted data.
     */
    'tool.execute.after': async (input, output) => {
      try {
        const toolName = (input && input.tool) || '';
        const candidates = normalize(toolName);
        if (candidates.length === 0) return; // unknown tool — skip (fail-open)

        const sessionId = (input && input.sessionID) || null;
        const requestId = requestIdFor(input && input.callID);
        const args = (input && input.args) || null;

        const overrides = await fetchSyncedOverrides(baseUrl, RUNTIME_KIND);
        const match = pickMatch(candidates, overrides);
        const toolId = match ? match.tool_id : candidates[0];
        const reason = match && typeof match.reason === 'string' ? match.reason : null;
        const action = match ? effectToAction(match.effect) : 'allow';

        let argsPreview = '';
        try {
          if (args !== undefined && args !== null) {
            argsPreview = redact(typeof args === 'string' ? args : JSON.stringify(args));
          }
        } catch { /* swallow */ }

        postJsonAndForget(`${baseUrl}/api/tool-permissions/call-audit`, {
          tool_id: toolId,
          function_name: toolName,
          action,
          risk: null,
          reason,
          is_essential: false,
          args_preview: argsPreview || null,
          runtime_kind: RUNTIME_KIND,
          session_id: sessionId,
          request_id: requestId,
        });

        // Outgoing prose scan (delegated subagent prompt, question text).
        if (THREAT_SCAN_TOOLS.has(toolName)) {
          let text = '';
          try { text = extractScanText(toolName, args); } catch { /* swallow */ }
          if (text.length > 0) {
            postJsonAndForget(`${baseUrl}/analyze`, {
              text: text.slice(0, THREAT_SCAN_TEXT_LIMIT),
              source: SOURCE,
              direction: 'outgoing',
              request_id: requestId,
              session_id: sessionId,
              metadata: { runtime_kind: RUNTIME_KIND, tool_name: toolName, tool_id: toolId },
            });
          }
        }

        // Incoming IDPI / leakage scan. MCP tools return untrusted third-party
        // data, so their responses are always scanned. OpenCode MCP names carry
        // no prefix, so this relies on isMcpToolName() — a
        // `startsWith('mcp__')` test would miss every real MCP tool.
        const isMcp = isMcpToolName(toolName);
        const markerGated = THREAT_SCAN_RESPONSE_MARKER_GATED_TOOLS.has(toolName);
        if (THREAT_SCAN_RESPONSE_TOOLS.has(toolName) || isMcp || markerGated) {
          let text = '';
          try { text = extractScanTextFromResponse(output); } catch { /* swallow */ }
          const passesGate = !markerGated || hasCredentialMarkers(text);
          if (text.length > 0 && passesGate) {
            postJsonAndForget(`${baseUrl}/analyze`, {
              text: text.slice(0, THREAT_SCAN_RESPONSE_LIMIT),
              source: SOURCE,
              direction: 'incoming',
              request_id: requestId,
              session_id: sessionId,
              metadata: {
                runtime_kind: RUNTIME_KIND,
                tool_name: toolName,
                tool_id: toolId,
                scan_target: 'tool_response',
              },
            });
          }
        }
      } catch { /* audit must never break the host */ }
    },

    /**
     * PROMPT SCAN. Observe-only — this hook has no control channel, so a
     * detection here is recorded, never blocking.
     */
    'chat.message': async (input, output) => {
      try {
        const sessionId = (input && input.sessionID) || null;
        const text = extractPromptText(output);
        if (!text) return;
        postJsonAndForget(`${baseUrl}/analyze`, {
          text: text.slice(0, THREAT_SCAN_TEXT_LIMIT),
          source: SOURCE,
          direction: 'outgoing',
          session_id: sessionId,
          request_id: `oc-prompt-${(input && input.messageID) || Date.now().toString(36)}`,
          metadata: { runtime_kind: RUNTIME_KIND, scan_target: 'user_prompt' },
        });
      } catch { /* fail-open */ }
    },

    /**
     * SESSION LIFECYCLE. Forwards the runtime session id so the backend
     * derives the SAME trace_id as this session's tool-call rows — one
     * logical run becomes one node on the Agent Map instead of an orphan.
     */
    event: async ({ event }) => {
      try {
        if (!event || event.type !== 'session.created') return;
        const props = event.properties || {};
        const sessionId = props.info?.id ?? props.sessionID ?? props.id ?? null;
        postJsonAndForget(`${baseUrl}/api/tool-permissions/call-audit`, {
          tool_id: '__session_start__',
          function_name: '__session_start__',
          action: 'log_only',
          risk: null,
          reason: 'SecureVector Guard: OpenCode session opened',
          is_essential: false,
          args_preview: sessionId ? `session_id=${sessionId}`.slice(0, 200) : null,
          runtime_kind: RUNTIME_KIND,
          session_id: sessionId,
        });
      } catch { /* fail-open */ }
    },
  };
};

export default SecureVectorGuard;
