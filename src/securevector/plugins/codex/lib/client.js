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
    const resp = await fetch(url, { signal: controller.signal });
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
      headers: { 'content-type': 'application/json' },
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
  const q = runtime ? `?runtime=${encodeURIComponent(runtime)}` : '';
  return getJson(`${baseUrl}/api/tool-permissions/synced-overrides${q}`, opts);
}

module.exports = { getJson, postJsonAndForget, fetchSyncedOverrides, DEFAULT_TIMEOUT_MS };
