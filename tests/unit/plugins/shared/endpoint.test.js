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
const HARNESSES = fs
  .readdirSync(PLUGINS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(PLUGINS, d.name, 'lib', 'client.js')))
  .map((d) => d.name)
  .sort();

test('every harness that ships a client exposes one endpoint resolver', () => {
  assert.ok(HARNESSES.length >= 5, `only found ${HARNESSES}`);
  for (const h of HARNESSES) {
    const src = fs.readFileSync(path.join(PLUGINS, h, 'lib', 'client.js'), 'utf8');
    assert.match(src, /function resolveBaseUrl\(\)/, `${h} has no resolveBaseUrl`);
    assert.match(src, /resolveBaseUrl,/, `${h} does not export resolveBaseUrl`);
  }
});

test('no hook reads the endpoint environment variable for itself', () => {
  // Nineteen inline copies is nineteen places to forget the warning. The
  // resolver is the only reader, so adding a hook cannot reintroduce a silent
  // path by accident.
  const offenders = [];
  for (const h of HARNESSES) {
    const hooks = path.join(PLUGINS, h, 'hooks');
    if (!fs.existsSync(hooks)) continue;
    for (const f of fs.readdirSync(hooks).filter((n) => n.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(hooks, f), 'utf8');
      if (src.includes('SECUREVECTOR_ENGINE_ENDPOINT') || src.includes('SV_BASE_URL')) {
        offenders.push(`${h}/hooks/${f}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'these hooks resolve the endpoint themselves');
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
