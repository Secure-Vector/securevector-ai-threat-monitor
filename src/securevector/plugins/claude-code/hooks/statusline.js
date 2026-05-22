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
 *   SecureVector Guard · 2 threats detected · 5 tool calls (3 allow / 2 block) · 7d 1.4M tok
 *
 * Architecture:
 *   - Stats + timeline are fetched fresh on every invocation (~5 ms each).
 *   - Token usage is slow (~2–8 s — disk-scans Claude Code session
 *     transcripts) and lives behind a 5-minute on-disk cache.
 *   - When the token cache is stale, this script SPAWNS A DETACHED
 *     refresh process that updates the cache in the background and
 *     exits silently. The current invocation never waits for it; it
 *     renders with whatever the cache has (or omits the token segment
 *     entirely on the very first call after install).
 *   - A PID-based lock prevents multiple background refreshes from
 *     piling up against the single-worker FastAPI server.
 *
 * Contract:
 *   - Reads (and ignores) Claude Code statusline JSON from stdin.
 *   - Fails SILENTLY if the local app is unreachable.
 *   - No npm deps — only Node built-ins.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BASE_URL = process.env.SECUREVECTOR_URL || 'http://127.0.0.1:8741';

// Foreground fetch budget — only governs the fast endpoints.
const FAST_TIMEOUT_MS = 1500;
// Background refresh budget — generous because the token-usage handler
// can take 6+ s when the OS disk cache is cold.
const BG_REFRESH_TIMEOUT_MS = 30 * 1000;

const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;
const SV_DIR = path.join(os.homedir(), '.securevector');
const TOKEN_CACHE_FILE = path.join(SV_DIR, 'statusline-tokens.json');
const REFRESH_LOCK_FILE = path.join(SV_DIR, 'statusline-refresh.lock');

function getJson(reqPath, timeoutMs) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(BASE_URL + reqPath); }
    catch { return resolve(null); }

    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

    const req = http.get(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: { 'Accept': 'application/json' },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) return finish(null);
          try { finish(JSON.parse(body)); }
          catch { finish(null); }
        });
      }
    );
    req.on('error', () => finish(null));
    if (timeoutMs > 0) {
      setTimeout(() => { req.destroy(); finish(null); }, timeoutMs);
    }
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

function readTokenCache() {
  try {
    const raw = fs.readFileSync(TOKEN_CACHE_FILE, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj.ts === 'number' && obj.value) {
      const age = Date.now() - obj.ts;
      return { value: obj.value, fresh: age < TOKEN_CACHE_TTL_MS };
    }
  } catch { /* missing or unreadable — ignore */ }
  return null;
}

function writeTokenCache(value) {
  try {
    fs.mkdirSync(SV_DIR, { recursive: true });
    fs.writeFileSync(
      TOKEN_CACHE_FILE,
      JSON.stringify({ ts: Date.now(), value }),
      { mode: 0o600 }
    );
  } catch { /* cache is opportunistic — ignore */ }
}

function tryAcquireRefreshLock() {
  try {
    fs.mkdirSync(SV_DIR, { recursive: true });
    if (fs.existsSync(REFRESH_LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(REFRESH_LOCK_FILE, 'utf8').trim(), 10);
      if (pid > 0) {
        try {
          process.kill(pid, 0); // signal 0 = existence check
          return false; // someone else is refreshing
        } catch { /* ESRCH — stale lock, fall through and reacquire */ }
      }
    }
    fs.writeFileSync(REFRESH_LOCK_FILE, String(process.pid), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function releaseRefreshLock() {
  try { fs.unlinkSync(REFRESH_LOCK_FILE); } catch {}
}

function spawnBackgroundTokenRefresh() {
  try {
    const child = spawn(process.argv[0], [__filename, '--refresh-tokens'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch { /* best-effort */ }
}

async function refreshTokensMain() {
  if (!tryAcquireRefreshLock()) {
    return; // another refresh is already running
  }
  try {
    const tokens = await getJson(
      '/api/hooks/claude-code/token-usage',
      BG_REFRESH_TIMEOUT_MS
    );
    if (tokens && Array.isArray(tokens.daily)) writeTokenCache(tokens);
  } finally {
    releaseRefreshLock();
  }
}

// ANSI styling — cyan/red palette. Threats in red (alert), brand prefix +
// body in cyan, matching the host statusline's cyan accent. Block count is
// also red to mirror the threat signal. Disable with NO_COLOR=1
// (https://no-color.org).
const NO_COLOR = process.env.NO_COLOR === '1' || process.env.NO_COLOR === 'true';
const C = NO_COLOR
  ? { reset: '', boldCyan: '', cyan: '', red: '', dim: '' }
  : {
      reset: '\x1b[0m',
      boldCyan: '\x1b[1;36m',
      cyan: '\x1b[36m',
      red: '\x1b[31m',
      dim: '\x1b[2m',
    };

function buildLine(stats, tokens, timeline) {
  const tail = [];

  if (timeline && Array.isArray(timeline.items)) {
    const scans = timeline.items.filter((i) => i.kind === 'scan').length;
    if (scans > 0) {
      tail.push(`${C.red}${scans} threats detected${C.reset}`);
    }
  }

  if (stats && (stats.total ?? 0) > 0) {
    const a = stats.allowed ?? 0;
    const b = stats.blocked ?? 0;
    tail.push(
      `${C.cyan}${stats.total} tool calls (${a} allow / ${C.reset}${C.red}${b} block${C.reset}${C.cyan})${C.reset}`
    );
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
    if (total7d > 0) {
      tail.push(`${C.cyan}7d ${fmtTokens(total7d)} tok${C.reset}`);
    }
  }

  if (tail.length === 0) return null;
  return `${C.boldCyan}SecureVector Guard${C.reset} ${C.dim}·${C.reset} ` + tail.join(` ${C.dim}·${C.reset} `);
}

async function statuslineMain() {
  await drainStdin();

  // Fast endpoints — fetched fresh each render. Sequential because the
  // local app's single uvicorn worker serialises requests; sequential
  // ordering avoids cheap calls queueing behind anything slow.
  const stats = await getJson('/api/tool-permissions/call-audit/stats', FAST_TIMEOUT_MS);
  const timeline = await getJson('/api/replay/timeline?limit=200', FAST_TIMEOUT_MS);

  // Slow endpoint (token usage) is served from the cache only. If the
  // cache is stale or missing, kick off a detached background refresh
  // — we don't wait for it. The next render (≤ 5 s later in CC's
  // refreshInterval) will pick up the freshly-cached value.
  const cached = readTokenCache();
  const tokens = cached ? cached.value : null;
  if (!cached || !cached.fresh) {
    spawnBackgroundTokenRefresh();
  }

  if (!stats && !tokens && !timeline) return; // app unreachable — print nothing

  const line = buildLine(stats, tokens, timeline);
  if (line) process.stdout.write(line + '\n');
}

const isRefreshMode = process.argv.includes('--refresh-tokens');
const entry = isRefreshMode ? refreshTokensMain : statuslineMain;
entry()
  .then(() => process.exit(0))
  .catch(() => process.exit(0));
