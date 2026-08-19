// SPDX-License-Identifier: Apache-2.0
/**
 * Fetch wrapper used by the Guard plugin hooks.
 *
 * Locked decision #5 — fail-open: if the local app is unreachable, slow, or
 * returns malformed data, the host's tool call must proceed. Every error
 * path on `getJson` returns `{}` instead of throwing; `postJsonAndForget`
 * never propagates errors and never blocks.
 *
 * The PreToolUse hook uses `getJson` with the default 100ms timeout — fast
 * enough to be invisible on the happy path, fast enough to abort cleanly
 * when the local app is down. The PostToolUse hook uses
 * `postJsonAndForget` so audit POSTs never delay the host CLI.
 *
 * Zero npm deps. Native `fetch` + `AbortController` (Node 18+).
 */

'use strict';

const DEFAULT_TIMEOUT_MS = 100;

/**
 * Auth header for a token-gated remote engine. When SECUREVECTOR_API_KEY is set
 * — e.g. pointing this plugin at a Terraform self-host endpoint gated by
 * `ingress_token` (enforced by engine v4.9.0+) — forward it as
 * `Authorization: Bearer <token>`. Empty/unset -> no header (the default
 * loopback app needs none). Mirrors the SDK and the OpenClaw plugin so a gated
 * remote endpoint is reachable from every runtime.
 *
 * @returns {Record<string,string>}
 */
function authHeaders() {
  const key = (process.env.SECUREVECTOR_API_KEY || '').trim();
  return key ? { authorization: `Bearer ${key}` } : {};
}

/**
 * GET JSON from a URL with a hard timeout. Returns the parsed body on 2xx,
 * or `{}` on any error (non-2xx, timeout, network, malformed JSON).
 *
 * @param {string} url
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<object>}
 */
async function getJson(url, opts = {}) {
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal, headers: authHeaders() });
    if (!resp || !resp.ok) return {};
    try {
      const data = await resp.json();
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

const POST_TIMEOUT_MS = 2000;

/**
 * POST a JSON body to a URL. Returns immediately (does not await the
 * response). Swallows every error path (sync throws, async rejections,
 * non-2xx responses) so the caller can rely on this never propagating.
 *
 * A bounded `AbortController` timeout (POST_TIMEOUT_MS) caps how long a
 * hung / slow connection can keep the fetch pending. These hooks run as
 * short-lived `node` processes the host CLI spawns and waits on; without
 * the bound a stuck socket keeps the event loop alive until the OS TCP
 * timeout (~2min), stalling prompt submission. The timeout is generous
 * (2s — long enough to flush the body on loopback) rather than the 100ms
 * GET timeout, which could abort before the body sends and drop the
 * audit/scan row. The timer is cleared in `.finally`.
 *
 * @param {string} url
 * @param {object} body
 * @returns {undefined}
 */
function postJsonAndForget(url, body) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    const p = fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    // p may be a thenable; attach a no-op catch so any rejection is
    // handled and not flagged as an unhandled promise rejection, and a
    // `.finally` to clear the abort timer either way.
    if (p && typeof p.catch === 'function') {
      p.catch(() => {}).finally(() => clearTimeout(timer));
    } else {
      clearTimeout(timer);
    }
  } catch {
    // swallow synchronous throws too
  }
}

/**
 * Domain helper: GET the local app's synced-overrides table.
 *
 * Thin wrapper around getJson with the canonical path baked in so hook
 * handlers don't need to know the route. Inherits getJson's fail-open
 * contract — returns `{}` on any error and never throws.
 *
 * Passes the caller's `runtime` so the local app drops rules scoped to a
 * different runtime — a Claude-Code-only Block must not reach the Codex hook.
 *
 * @param {string} baseUrl  Local app base URL (e.g. http://127.0.0.1:8741).
 * @param {string} [runtime]  This runtime's slug (e.g. "codex").
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<object>}  `{ synced: [...], total: N }` or `{}`.
 */
async function fetchSyncedOverrides(baseUrl, runtime, opts = {}) {
  const params = new URLSearchParams();
  if (runtime) params.set('runtime', runtime);
  // Session identity on the decision path (#203): lets the server evaluate
  // per-run limits (tool-call cap, loop breaker) for this session. Optional;
  // older servers simply ignore the parameter.
  if (opts.sessionId) params.set('session_id', opts.sessionId);
  const qs = params.toString();
  return getJson(`${baseUrl}/api/tool-permissions/synced-overrides${qs ? `?${qs}` : ''}`, opts);
}

/**
 * Egress evaluation needs a longer budget than the 100ms synced-overrides GET.
 * It parses a shell command and evaluates it against the policy, and there is
 * no cached fallback — a timeout means the call is simply not evaluated.
 */
const EGRESS_TIMEOUT_MS = 400;

/**
 * Domain helper: POST a tool call to the local app's egress evaluator.
 * Extraction and policy evaluation live server-side so there is ONE
 * implementation of shell-command parsing, not one per runtime plugin.
 * Fail-open on every error path.
 */
async function evaluateEgress(baseUrl, body, opts = {}) {
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : EGRESS_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${baseUrl}/api/egress/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp || !resp.ok) return {};
    const data = await resp.json();
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  getJson, postJsonAndForget, fetchSyncedOverrides, evaluateEgress,
  authHeaders, DEFAULT_TIMEOUT_MS, EGRESS_TIMEOUT_MS,
};
