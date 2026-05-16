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

/**
 * POST a JSON body to a URL. Returns immediately (does not await the
 * response). Swallows every error path (sync throws, async rejections,
 * non-2xx responses) so the caller can rely on this never propagating.
 *
 * @param {string} url
 * @param {object} body
 * @returns {undefined}
 */
function postJsonAndForget(url, body) {
  try {
    const p = fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    // p may be a thenable; attach a no-op catch so any rejection is
    // handled and not flagged as an unhandled promise rejection.
    if (p && typeof p.catch === 'function') {
      p.catch(() => {});
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
 * @param {string} baseUrl  Local app base URL (e.g. http://127.0.0.1:8741).
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<object>}  `{ synced: [...], total: N }` or `{}`.
 */
async function fetchSyncedOverrides(baseUrl, opts = {}) {
  return getJson(`${baseUrl}/api/tool-permissions/synced-overrides`, opts);
}

module.exports = { getJson, postJsonAndForget, fetchSyncedOverrides, DEFAULT_TIMEOUT_MS };
