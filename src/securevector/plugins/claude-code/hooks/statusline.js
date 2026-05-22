#!/usr/bin/env node
/**
 * SecureVector Guard — Claude Code statusline emitter.
 *
 * Pulls a quick summary from the local SecureVector app and prints a
 * single one-line status to stdout. Designed to be wired into Claude
 * Code's `statusLine` setting (or shelled out from a user's existing
 * statusline script and appended).
 *
 * Example output:
 *   SecureVector Guard · 2 threats detected · 5 calls (3a/2b) · 7d 1.4M tok
 *
 * Contract:
 *   - Reads (and ignores) Claude Code statusline JSON from stdin.
 *   - Fails SILENTLY if the local app is unreachable. Never blocks
 *     the host statusline, never prints partial garbage on error.
 *   - A small on-disk cache (CACHE_TTL_MS) absorbs the slow
 *     transcript-scan latency of the token-usage endpoint so the
 *     statusline stays snappy at typical refreshInterval (5s).
 *   - No npm deps — only Node built-ins.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE_URL = process.env.SECUREVECTOR_URL || 'http://127.0.0.1:8741';
const PER_REQUEST_TIMEOUT_MS = 1800; // covers token-usage transcript scan
const TOTAL_TIMEOUT_MS = 2000;
const CACHE_TTL_MS = 60 * 1000;
const CACHE_FILE = path.join(os.homedir(), '.securevector', 'statusline-cache.json');

function getJson(reqPath) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(BASE_URL + reqPath); }
    catch { return resolve(null); }

    const req = http.get(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        timeout: PER_REQUEST_TIMEOUT_MS,
        headers: { 'Accept': 'application/json' },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try { resolve(JSON.parse(body)); }
          catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

async function drainStdin() {
  // Claude Code passes a JSON blob (model, session_id, cwd, etc.) on
  // stdin. We don't use it yet but must drain to avoid EPIPE on the
  // host's writer. Cap the wait so non-CC invocations don't hang.
  return new Promise((resolve) => {
    let drained = false;
    const finish = () => { if (!drained) { drained = true; resolve(); } };
    process.stdin.on('data', () => {});
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    setTimeout(finish, 60);
  });
}

function readCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj.ts === 'number' && typeof obj.line === 'string') {
      if (Date.now() - obj.ts < CACHE_TTL_MS) return obj.line;
    }
  } catch { /* missing or unreadable — ignore */ }
  return null;
}

function writeCache(line) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), line }), { mode: 0o600 });
  } catch { /* cache is opportunistic — ignore */ }
}

function buildLine(stats, tokens, timeline) {
  const tail = [];

  if (timeline && Array.isArray(timeline.items)) {
    const scans = timeline.items.filter((i) => i.kind === 'scan').length;
    if (scans > 0) tail.push(`${scans} threats detected`);
  }

  if (stats && (stats.total ?? 0) > 0) {
    tail.push(`${stats.total} calls (${stats.allowed ?? 0}a/${stats.blocked ?? 0}b)`);
  }

  if (tokens && Array.isArray(tokens.daily)) {
    // /token-usage returns up to 30 days; slice to the trailing 7 by
    // ISO date string (lexicographically sortable, sparse-safe).
    const last7 = [...tokens.daily]
      .sort((a, b) => (a.day || '').localeCompare(b.day || ''))
      .slice(-7);
    const total7d = last7.reduce(
      (sum, d) => sum + (d.input_tokens || 0) + (d.output_tokens || 0),
      0
    );
    if (total7d > 0) tail.push(`7d ${fmtTokens(total7d)} tok`);
  }

  if (tail.length === 0) return null;
  return 'SecureVector Guard · ' + tail.join(' · ');
}

async function main() {
  await drainStdin();

  // Fast path: serve from cache if fresh.
  const cached = readCache();
  if (cached) {
    process.stdout.write(cached + '\n');
    return;
  }

  // Cache stale or missing — fetch all three in parallel against a deadline.
  const deadline = new Promise((r) => setTimeout(() => r(null), TOTAL_TIMEOUT_MS));
  const [stats, tokens, timeline] = await Promise.all([
    Promise.race([getJson('/api/tool-permissions/call-audit/stats'), deadline]),
    Promise.race([getJson('/api/hooks/claude-code/token-usage'), deadline]),
    Promise.race([getJson('/api/replay/timeline?limit=200'), deadline]),
  ]);

  if (!stats && !tokens && !timeline) return; // app unreachable — print nothing

  const line = buildLine(stats, tokens, timeline);
  if (!line) return;
  writeCache(line);
  process.stdout.write(line + '\n');
}

main().catch(() => { /* silent */ });
