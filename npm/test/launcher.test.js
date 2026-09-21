/** The npm launcher: what it promises, and the promises that are load-bearing.
 *
 * The important one is that `npm install` does not touch the network. Everything
 * else here is ordinary correctness.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');
const launcher = require('../bin/securevector.js');
const python = require('../lib/python.js');
const bootstrap = require('../lib/bootstrap.js');

// --- the supply-chain promise ------------------------------------------------

test('there is no install-time script of any kind', () => {
  // A postinstall that downloads and runs code is the exact shape this product
  // warns people about. Convenience is not a good enough reason for a security
  // tool to ship one, so the package must not have the hooks at all.
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'preprepare', 'postprepare']) {
    assert.ok(!(hook in (pkg.scripts || {})), `package.json defines a ${hook} script`);
  }
});

test('nothing in the shipped files reaches the network at require time', () => {
  // Requiring the launcher must be inert. If merely loading it could fetch
  // something, `npm install` plus any tooling that resolves bins would too.
  for (const rel of ['bin/securevector.js', 'lib/python.js', 'lib/bootstrap.js']) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const banned of ['node:https', "require('https')", 'node-fetch', 'axios']) {
      assert.ok(!src.includes(banned), `${rel} pulls in ${banned}`);
    }
  }
});

test('the install talks before it acts', () => {
  // A silent 30 second network install during what looked like a launch is
  // indistinguishable from a hang, and an unannounced download from a security
  // product is worse than that.
  const src = fs.readFileSync(path.join(ROOT, 'lib/bootstrap.js'), 'utf8');
  assert.match(src, /This will now, once:/);
  assert.match(src, /Nothing was downloaded during npm install/);
});

// --- version pinning ---------------------------------------------------------

test('the launcher pins PyPI to its own version, never latest', () => {
  assert.strictEqual(launcher.VERSION, pkg.version);
  const src = fs.readFileSync(path.join(ROOT, 'lib/bootstrap.js'), 'utf8');
  assert.match(src, /==\$\{version\}/, 'the pip spec must pin an exact ==version');
  assert.ok(!/pip install [^\n]*latest/.test(src), 'never resolve latest');
});

test('the npm version matches the Python package version', () => {
  // Same product, same number. If these drift, `npm i @securevector/cli@X` and
  // `pip install securevector-ai-monitor==X` stop being the same thing.
  const init = fs.readFileSync(path.join(ROOT, '..', 'src', 'securevector', '__init__.py'), 'utf8');
  const m = init.match(/__version__\s*=\s*["']([^"']+)/);
  assert.ok(m, 'could not read __version__');
  assert.strictEqual(pkg.version, m[1],
    'npm/package.json version must track src/securevector/__init__.py');
});

// --- verbs -------------------------------------------------------------------

test('every verb maps to a console_script that setup.py actually declares', () => {
  // A typo here surfaces as "command not found" inside a venv, which is a
  // miserable thing to debug, so it is checked against the real source.
  const setup = fs.readFileSync(path.join(ROOT, '..', 'setup.py'), 'utf8');
  for (const entry of Object.values(launcher.ENTRY_POINTS)) {
    assert.ok(setup.includes(`"${entry}=`), `setup.py declares no console_script named ${entry}`);
  }
});

test('the default verb starts the app', () => {
  assert.strictEqual(launcher.DEFAULT_VERB, 'app');
  assert.strictEqual(launcher.ENTRY_POINTS.app, 'securevector-app');
});

test('an unknown first argument is treated as an argument, not an error', () => {
  // `securevector --web` must keep working; rejecting unknown leading flags
  // would break every pass-through use.
  const src = fs.readFileSync(path.join(ROOT, 'bin/securevector.js'), 'utf8');
  assert.match(src, /hasOwnProperty\.call\(ENTRY_POINTS, args\[0\]\)/);
  assert.match(src, /const rest = verb === args\[0\] \? args\.slice\(1\) : args;/);
});

// --- python detection --------------------------------------------------------

test('the floor is the one the app extras actually need', () => {
  assert.strictEqual(python.MIN_MAJOR, 3);
  assert.strictEqual(python.MIN_MINOR, 10);
  assert.ok(python.isNewEnough([3, 10]));
  assert.ok(python.isNewEnough([3, 13]));
  assert.ok(!python.isNewEnough([3, 9]));
  assert.ok(!python.isNewEnough([2, 7]));
});

test('a bare python is tried last', () => {
  // On a machine with both, `python` is as likely to be a 2.x relic as
  // anything; picking it first yields a syntax error instead of a message.
  const i = python.CANDIDATES.indexOf('python');
  assert.ok(i === -1 || i === python.CANDIDATES.length - 1, 'bare python must be the last candidate');
});

test('no usable python produces instructions, not a stack trace', () => {
  const none = python.explainMissing([]);
  assert.match(none, /needs Python 3\.10 or newer/);
  assert.match(none, /will not install a Python runtime for you/);

  const old = python.explainMissing([{ candidate: 'python3', version: [3, 9] }]);
  assert.match(old, /python3: 3\.9/);
  assert.match(old, /on PATH ahead of/);
});

// --- where things go ---------------------------------------------------------

test('the environment lives in the user data dir, not in node_modules', () => {
  // A global npm prefix can be root-owned or read-only, and reinstalling the
  // npm package would otherwise discard a working environment.
  const root = bootstrap.envRoot();
  assert.ok(!root.includes('node_modules'), root);
  assert.ok(path.isAbsolute(root));
});

test('each version gets its own environment', () => {
  assert.notStrictEqual(bootstrap.venvPath('5.3.0'), bootstrap.venvPath('6.0.0'));
  assert.ok(bootstrap.venvPath('6.0.0').endsWith('v6.0.0'));
});

test('isReady is false for a version that was never installed', () => {
  assert.strictEqual(bootstrap.isReady('0.0.0-nope', 'securevector-app'), false);
});

// --- packaging ---------------------------------------------------------------

test('the published tarball carries the launcher and nothing else', () => {
  assert.deepStrictEqual(pkg.files, ['bin', 'lib', 'README.md']);
  assert.strictEqual(pkg.bin.securevector, 'bin/securevector.js');
});

test('it publishes publicly, with provenance', () => {
  // Scoped packages default to restricted, which would publish a package
  // nobody can install. Provenance matches the sibling n8n package.
  assert.strictEqual(pkg.publishConfig.access, 'public');
  assert.strictEqual(pkg.publishConfig.provenance, true);
});

test('the licence matches the repository it ships from', () => {
  assert.strictEqual(pkg.license, 'Apache-2.0');
});

test('the bin file is executable and has a shebang', () => {
  const p = path.join(ROOT, 'bin/securevector.js');
  assert.match(fs.readFileSync(p, 'utf8').split('\n')[0], /^#!\/usr\/bin\/env node/);
  assert.ok(fs.statSync(p).mode & 0o111, 'bin/securevector.js is not executable');
});
