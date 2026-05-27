#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
/**
 * Diagnostic Stop-hook probe — temporary, targeted for removal in a future 4.3.x patch.
 *
 * Claude Code emits a `Stop` event when the agent finishes a turn.
 * OpenClaw's plugin SDK exposes a similar `llm_output` event whose
 * payload includes `event.usage.{input,output,cacheRead}` — that's
 * what powers OpenClaw's `/api/costs/track` integration.
 *
 * Whether Claude Code's Stop event carries token usage is undocumented.
 * This probe inspects every Stop-event payload it sees and records
 * ONLY THE SHAPE — top-level key names, typeof of each value, total
 * payload length — to `~/.securevector/cost-probes/cc-stop-*.json`.
 * **The payload itself is NEVER written.** Stop event payloads can
 * include the assistant's response text, recent transcript references,
 * and user-typed prompts; persisting that to disk without explicit
 * user consent would be a GDPR Art. 13 / CCPA disclosure violation.
 * The shape metadata is sufficient to answer the only question this
 * probe exists for: "does the Stop event payload contain a `usage`
 * field with token counts?"
 *
 * Output is fire-and-forget; never blocks the host. Removed once
 * the Stop-event payload shape is confirmed (tracked internally).
 *
 * Zero npm deps. Native Node 18+.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROBE_DIR = path.join(os.homedir(), '.securevector', 'cost-probes');
const PROBE_MAX_FILES = 100; // safety cap so we don't fill disk
const PROBE_FILENAME_RE = /^cc-stop-.+\.json$/;

async function readAllStdin() {
  let buf = '';
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
}

/**
 * Compute a SHAPE-only fingerprint of the parsed payload: the top-level
 * keys and the typeof of each value (plus, for arrays, length; for
 * nested objects, the nested key list). This is enough to answer
 * "does the Stop event carry token usage" without capturing any
 * user content.
 */
function shapeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array[${value.length}]`;
  const t = typeof value;
  if (t === 'object') {
    // Defense-in-depth: stop at "object[K]" — don't enumerate the
    // nested keys. The diagnostic question is whether `usage` exists
    // and what its top-level shape is; we don't need to know what's
    // INSIDE usage to answer that, and recursing into nested objects
    // would leak key names that could be user-derived in edge cases.
    return `object[${Object.keys(value).length}]`;
  }
  return t; // 'string' | 'number' | 'boolean' | 'undefined'
}

function shapeMap(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const result = {};
  for (const [k, v] of Object.entries(parsed)) {
    result[k] = shapeOf(v);
  }
  return result;
}

async function main() {
  let raw = '';
  try { raw = await readAllStdin(); } catch { return; }

  try {
    fs.mkdirSync(PROBE_DIR, { recursive: true, mode: 0o700 });

    // Cap the number of probe files so a long-running session doesn't
    // accumulate forever. Filter to OUR probe filename pattern so
    // unrelated files in the directory don't count against the cap.
    let existing = [];
    try {
      existing = fs.readdirSync(PROBE_DIR).filter(f => PROBE_FILENAME_RE.test(f));
    } catch { /* noop */ }
    if (existing.length >= PROBE_MAX_FILES) return;

    // Filename: ISO timestamp + pid + counter — avoids collisions
    // within the same millisecond if two CC sessions fire concurrently.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const unique = `${process.pid}-${Math.floor(Math.random() * 0x10000).toString(16)}`;
    const out = path.join(PROBE_DIR, `cc-stop-${stamp}-${unique}.json`);

    let topKeys = [];
    let shapes = null;
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        topKeys = Object.keys(parsed).sort();
        shapes = shapeMap(parsed);
      }
    } catch { /* raw text — leave topKeys/shapes empty */ }

    // Write shape metadata ONLY. Never the payload, never the raw
    // string. If the shape map reveals a `usage` key with the right
    // sub-shape, follow-up work wires `/api/costs/track` and the
    // probe gets removed.
    const record = {
      _probe: 'cc-stop-event-shape-only',
      _captured_at: new Date().toISOString(),
      _raw_length: raw.length,
      _parsed_ok: parsed !== null,
      _top_level_keys: topKeys,
      _shapes: shapes,
    };
    fs.writeFileSync(out, JSON.stringify(record, null, 2), { mode: 0o600 });
  } catch { /* swallow — probe is best-effort */ }
}

if (require.main === module) main();

module.exports = { shapeOf, shapeMap };
