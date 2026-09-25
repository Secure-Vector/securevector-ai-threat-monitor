// SPDX-License-Identifier: Apache-2.0
/**
 * Where a Guard plugin sends what it reads, and whether it says so.
 *
 * SECUREVECTOR_ENGINE_ENDPOINT is how a self-host or Terraform engine is used
 * instead of the local app, so it is not something to refuse. It is also an
 * environment variable, which means anything that can write a .envrc, a
 * devcontainer.json or a Makefile target in a repository the agent opens can
 * set it. Tool arguments and command output go to whatever it names.
 *
 * The plugins used to read it inline in nineteen hooks, each with a comment
 * asserting the endpoint was loopback and nothing checking. These tests pin
 * the two properties that replaced that: one place resolves it, and a host
 * that is not this machine is named on stderr before anything is sent.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGINS = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'plugins');
// Every plugin directory, not only the ones with a lib/client.js. Keying on
// the resolver's presence meant OpenClaw, which resolves in its own config.ts
// and has no lib/, was never swept at all: the check that said "nothing else
// reads the variable" was not looking at the one plugin where that had been
// true. Two separate lists below, because the question "who has a resolver"
// and the question "who must be swept" are not the same question.
const ALL_PLUGINS = fs
  .readdirSync(PLUGINS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

const HARNESSES = ALL_PLUGINS.filter((n) =>
  fs.existsSync(path.join(PLUGINS, n, 'lib', 'client.js')),
);

test('every harness that ships a client exposes one endpoint resolver', () => {
  assert.ok(HARNESSES.length >= 5, `only found ${HARNESSES}`);
  for (const h of HARNESSES) {
    const src = fs.readFileSync(path.join(PLUGINS, h, 'lib', 'client.js'), 'utf8');
    assert.match(src, /function resolveBaseUrl\(\)/, `${h} has no resolveBaseUrl`);
    assert.match(src, /resolveBaseUrl,/, `${h} does not export resolveBaseUrl`);
  }
});

/** Every source file under a plugin, at any depth. */
function* sourcesOf(harness) {
  const root = path.join(PLUGINS, harness);
  const stack = [root];
  const SUFFIXES = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') stack.push(full);
      } else if (SUFFIXES.some((x) => entry.name.endsWith(x))) {
        yield full;
      }
    }
  }
}

test('nothing but each plugin resolver reads the endpoint variable', () => {
  // Twenty-one inline copies was twenty-one places to forget the warning. The
  // resolver is the only reader, so adding a hook cannot reintroduce a silent
  // path by accident.
  //
  // Walks the WHOLE plugin tree, every source extension, not just hooks/*.js:
  // the Python twin of this check globbed "*.js" and therefore could not see
  // openclaw/config.ts, which read the variable with no loopback check while
  // the test reported that nothing did.
  // Exempt by RELATIVE PATH, not basename: exempting "config.ts" anywhere
  // would silently exempt a future plugins/foo/hooks/config.ts.
  const RESOLVERS = new Set([
    ...HARNESSES.map((h) => path.join(h, 'lib', 'client.js')),
    path.join('openclaw', 'config.ts'),
  ]);
  const offenders = [];
  for (const h of ALL_PLUGINS) {
    for (const full of sourcesOf(h)) {
      if (RESOLVERS.has(path.relative(PLUGINS, full))) continue;
      const src = fs.readFileSync(full, 'utf8');
      // A READ, not a mention, and in the shapes someone writes by accident:
      // plain access, optional chaining, index access, destructuring. Matching
      // the bare name also matched the comment explaining why a read had been
      // removed, so the only way to pass would have been to stop explaining.
      const NAMES = 'SECUREVECTOR_ENGINE_ENDPOINT|SV_BASE_URL|SECUREVECTOR_URL';
      const reads = [
        new RegExp(`process\\.env\\??\\.(${NAMES})\\b`),
        new RegExp(`process\\.env\\[\\s*["'\`](${NAMES})["'\`]`),
        new RegExp(`\\{[^}]*\\b(${NAMES})\\b[^}]*\\}\\s*=\\s*process\\.env`),
      ];
      if (reads.some((r) => r.test(src))) {
        offenders.push(path.relative(PLUGINS, full));
      }
    }
  }
  assert.deepEqual(offenders, [], 'these files resolve the endpoint themselves');
});

test('the sweep covers every plugin, including one with no lib/client.js', () => {
  // OpenClaw is the case that was invisible: it resolves in config.ts and has
  // no lib/ at all, so a list keyed on the resolver's presence skipped it.
  assert.ok(ALL_PLUGINS.includes('openclaw'), `swept plugins: ${ALL_PLUGINS}`);
  assert.ok(!HARNESSES.includes('openclaw'), 'openclaw has no lib/client.js by design');
  assert.ok(ALL_PLUGINS.length > HARNESSES.length, 'the two lists must differ');
});

test('the sweep above actually walks past hooks/ and past .js', () => {
  // Only evidence if it can see the files it claims to clear. Both times this
  // check was wrong, it was because it could not see the offending file.
  const seen = [...sourcesOf('openclaw')].map((p) => path.basename(p));
  assert.ok(seen.includes('config.ts'), `openclaw walk saw only ${seen}`);
  const cc = [...sourcesOf('claude-code')].map((p) => path.relative(PLUGINS, p));
  assert.ok(cc.some((p) => p.includes('lib/')), 'the walk never descended into lib/');
  assert.ok(cc.length >= 8, `claude-code walk found only ${cc.length} files`);
});

/** Load a fresh copy of one harness's client with a chosen environment. */
function loadClient(harness, env) {
  const file = path.join(PLUGINS, harness, 'lib', 'client.js');
  delete require.cache[require.resolve(file)];
  const saved = {};
  for (const k of ['SECUREVECTOR_ENGINE_ENDPOINT', 'SV_BASE_URL']) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  const written = [];
  const realWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    const mod = require(file);
    return { url: mod.resolveBaseUrl(), written };
  } finally {
    process.stderr.write = realWrite;
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    delete require.cache[require.resolve(file)];
  }
}

// claude-code stands in for the CommonJS harnesses; they share this file.
test('an unset endpoint is the local app, and says nothing', () => {
  const { url, written } = loadClient('claude-code', {});
  assert.equal(url, 'http://127.0.0.1:8741');
  assert.deepEqual(written, []);
});

test('an explicit loopback endpoint also says nothing', () => {
  for (const url of ['http://127.0.0.1:9000', 'http://localhost:8741', 'http://[::1]:8741']) {
    const out = loadClient('claude-code', { SECUREVECTOR_ENGINE_ENDPOINT: url });
    assert.equal(out.url, url);
    assert.deepEqual(out.written, [], `${url} should be quiet`);
  }
});

test('a remote endpoint is named on stderr before anything is sent', () => {
  const { url, written } = loadClient('claude-code', {
    SECUREVECTOR_ENGINE_ENDPOINT: 'https://engine.example.com',
  });
  assert.equal(url, 'https://engine.example.com');
  assert.equal(written.length, 1);
  assert.match(written[0], /engine\.example\.com/);
  assert.match(written[0], /not this machine/);
});

test('a remote endpoint on plain HTTP says the data travels in the clear', () => {
  const { written } = loadClient('claude-code', {
    SECUREVECTOR_ENGINE_ENDPOINT: 'http://attacker.tld',
  });
  assert.match(written[0], /in the clear/);
});

test('the warning is emitted once, not on every hook invocation', () => {
  const file = path.join(PLUGINS, 'claude-code', 'lib', 'client.js');
  delete require.cache[require.resolve(file)];
  process.env.SECUREVECTOR_ENGINE_ENDPOINT = 'https://engine.example.com';
  const written = [];
  const realWrite = process.stderr.write;
  process.stderr.write = (c) => {
    written.push(String(c));
    return true;
  };
  try {
    const mod = require(file);
    mod.resolveBaseUrl();
    mod.resolveBaseUrl();
    mod.resolveBaseUrl();
    assert.equal(written.length, 1, 'three calls should produce one warning');
  } finally {
    process.stderr.write = realWrite;
    delete process.env.SECUREVECTOR_ENGINE_ENDPOINT;
    delete require.cache[require.resolve(file)];
  }
});

test('an endpoint that is not a URL falls back to the local app and says so', () => {
  const { url, written } = loadClient('claude-code', {
    SECUREVECTOR_ENGINE_ENDPOINT: 'not a url at all',
  });
  assert.equal(url, 'http://127.0.0.1:8741');
  assert.match(written[0], /not a URL/);
});
