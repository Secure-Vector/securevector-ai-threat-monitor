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

// --- interpreter lookup cannot be hijacked by the project being run in -------

const os = require('node:os');

function fakePython(dir, name, version) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\necho ${version}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

test('a python3 planted in the cwd or node_modules/.bin is never chosen', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-npm-path-'));
  try {
    const project = path.join(root, 'project');
    const bin = path.join(project, 'node_modules', '.bin');
    const real = path.join(root, 'usr', 'bin');
    // The planted ones claim a newer version, so if they were reachable they would win.
    fakePython(project, 'python3', '3.13');
    fakePython(bin, 'python3', '3.13');
    const good = fakePython(real, 'python3', '3.12');
    const env = { PATH: [bin, '', '.', 'relative/dir', project, real].join(':') };
    const opts = { env, cwd: project, platform: 'linux', candidates: ['python3'] };

    assert.strictEqual(python.resolveExecutable('python3', opts), good);
    const { best } = python.findPython(opts);
    assert.ok(best, 'the real interpreter later on PATH is found');
    assert.strictEqual(best.command, good);
    assert.deepStrictEqual(best.version, [3, 12]);

    // With only untrusted entries there is nothing to run.
    const none = python.findPython({ ...opts, env: { PATH: [bin, '', project].join(':') } });
    assert.strictEqual(none.best, null);
    assert.strictEqual(none.seen.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('untrusted PATH entries are recognised on both platforms', () => {
  assert.ok(!python.isTrustedDir('', '/p', 'linux'));
  assert.ok(!python.isTrustedDir('.', '/p', 'linux'));
  assert.ok(!python.isTrustedDir('bin', '/p', 'linux'));
  assert.ok(!python.isTrustedDir('/p', '/p', 'linux'));
  assert.ok(!python.isTrustedDir('/p/node_modules/.bin', '/x', 'linux'));
  assert.ok(!python.isTrustedDir('/a/node_modules/.bin/', '/x', 'linux'));
  assert.ok(python.isTrustedDir('/usr/bin', '/p', 'linux'));
  assert.ok(!python.isTrustedDir('C:\\Proj', 'c:\\proj', 'win32'));
  assert.ok(!python.isTrustedDir('C:\\proj\\NODE_MODULES\\.bin', 'C:\\x', 'win32'));
  assert.ok(!python.isTrustedDir('.\\tools', 'C:\\x', 'win32'));
  assert.ok(python.isTrustedDir('C:\\Python312', 'C:\\proj', 'win32'));
});

test('the resolved interpreter is passed to the installer by absolute path', () => {
  const split = bootstrap.splitPython({ command: '/opt/Python 3/bin/python3', args: [] });
  assert.deepStrictEqual(split, { command: '/opt/Python 3/bin/python3', args: [] });
  const src = fs.readFileSync(path.join(ROOT, 'bin/securevector.js'), 'utf8');
  assert.ok(!src.includes('install(best.candidate'), 'install must get the resolved command, not the bare name');
});

// --- pip installs from PyPI and nowhere else ---------------------------------

test('pip is pointed at PyPI explicitly', () => {
  const args = bootstrap.pipInstallArgs('securevector-ai-monitor[app]==1.2.3', {});
  assert.deepStrictEqual(args, [
    '-I', '-m', 'pip', 'install', '--index-url', 'https://pypi.org/simple', 'securevector-ai-monitor[app]==1.2.3',
  ]);
  assert.ok(!args.includes('--extra-index-url'));
});

test('only SECUREVECTOR_PIP_INDEX can change the index, never pip variables', () => {
  assert.strictEqual(bootstrap.pipIndex({ PIP_INDEX_URL: 'https://evil.example/simple' }), 'https://pypi.org/simple');
  assert.strictEqual(bootstrap.pipIndex({ SECUREVECTOR_PIP_INDEX: ' https://mirror.corp/simple ' }), 'https://mirror.corp/simple');
  assert.strictEqual(bootstrap.pipIndex({ SECUREVECTOR_PIP_INDEX: '' }), 'https://pypi.org/simple');
});

test('the pip child environment drops index settings and every pip.conf', () => {
  const env = bootstrap.pipEnv({
    PATH: '/usr/bin',
    HTTPS_PROXY: 'http://proxy:8080',
    PIP_INDEX_URL: 'https://evil.example/simple',
    PIP_EXTRA_INDEX_URL: 'https://evil.example/simple',
    pip_find_links: '/tmp/wheels',
    PIP_NO_INDEX: '1',
    PIP_TRUSTED_HOST: 'evil.example',
    PIP_CONFIG_FILE: '/home/u/evil.conf',
  });
  for (const k of ['PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL', 'pip_find_links', 'PIP_NO_INDEX', 'PIP_TRUSTED_HOST']) {
    assert.ok(!(k in env), `${k} must not reach pip`);
  }
  assert.strictEqual(env.PIP_CONFIG_FILE, os.devnull);
  assert.strictEqual(env.PATH, '/usr/bin');
  assert.strictEqual(env.HTTPS_PROXY, 'http://proxy:8080');
});

test('the pip self-upgrade is pinned to a reviewed range and shown', () => {
  assert.match(bootstrap.PIP_SELF_SPEC, /^pip>=\d+(\.\d+)*,<\d+$/);
  const src = fs.readFileSync(path.join(ROOT, 'lib/bootstrap.js'), 'utf8');
  assert.ok(!/'--upgrade', 'pip'\]/.test(src), 'pip must not upgrade to an unbounded latest');
  assert.ok(!/PIP_SELF_SPEC\][^\n]*stdio: 'ignore'/.test(src));
});

test('SECUREVECTOR_PIP_INDEX must be https', () => {
  assert.strictEqual(bootstrap.pipIndex({ SECUREVECTOR_PIP_INDEX: 'https://mirror.example/simple' }), 'https://mirror.example/simple');
  for (const bad of ['http://mirror.example/simple', 'file:///tmp/wheels', 'mirror.example/simple', 'ftp://x/']) {
    assert.throws(() => bootstrap.pipIndex({ SECUREVECTOR_PIP_INDEX: bad }), /must be an https:\/\/ URL/);
  }
});

test('the current directory is recognised through symlinks and case', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-npm-cwd-'));
  try {
    const physical = fs.realpathSync(dir);
    // On macOS os.tmpdir() is a symlinked /var path; /private/var is the real one.
    assert.strictEqual(python.isTrustedDir(physical, dir, process.platform), false);
    assert.strictEqual(python.isTrustedDir(dir, physical, process.platform), false);
    // Case variants of the same folder (case-blind on darwin and win32).
    assert.strictEqual(python.isTrustedDir(dir.toUpperCase(), dir, 'darwin'), false);
    assert.strictEqual(python.isTrustedDir('C:\\Work\\Repo', 'c:\\work\\repo', 'win32'), false);
    assert.strictEqual(python.isTrustedDir(path.join(physical, 'bin'), dir, process.platform), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('quoted Windows PATH entries are unquoted', () => {
  const env = { Path: '"C:\\Program Files\\Python312";C:\\Windows; "C:\\Tools" ;' };
  assert.deepStrictEqual(python.pathEntries(env, 'win32'), ['C:\\Program Files\\Python312', 'C:\\Windows', 'C:\\Tools', '']);
  assert.deepStrictEqual(python.pathEntries({ PATH: '"/a":/b' }, 'linux'), ['"/a"', '/b']);
});

test('a Windows app execution alias (reparse point stat cannot follow) still counts as a file', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-npm-alias-'));
  try {
    // A dangling link is what an alias looks like to Node: stat fails, lstat works.
    const alias = path.join(dir, 'python3.exe');
    fs.symlinkSync(path.join(dir, 'missing-target'), alias);
    assert.strictEqual(python.isExecutableFile(alias, 'win32'), true);
    assert.strictEqual(python.isExecutableFile(alias, 'linux'), false);
    assert.strictEqual(python.isExecutableFile(dir, 'win32'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a venv or pip package planted in the current directory never runs during install', { skip: process.platform === 'win32', timeout: 180000 }, () => {
  const { best } = python.findPython();
  if (!best) return; // no interpreter on this machine
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-npm-hijack-'));
  const marker = path.join(root, 'HIJACKED');
  const project = path.join(root, 'project');
  for (const mod of ['venv', 'pip']) {
    fs.mkdirSync(path.join(project, mod), { recursive: true });
    fs.writeFileSync(path.join(project, mod, '__init__.py'), `open(${JSON.stringify(marker)}, 'a').write('${mod}\\n')\n`);
    fs.writeFileSync(path.join(project, mod, '__main__.py'), '');
  }
  const saved = { cwd: process.cwd(), env: { ...process.env } };
  try {
    // The plant works when nothing guards against it, so the test can fail.
    require('node:child_process').spawnSync(best.command, [...(best.args || []), '-m', 'venv', '--help'], { cwd: project, stdio: 'ignore' });
    assert.ok(fs.existsSync(marker), 'sanity: a bare -m imports from the current directory');
    fs.rmSync(marker);

    process.chdir(project);
    process.env.HOME = path.join(root, 'home');
    process.env.XDG_DATA_HOME = path.join(root, 'home', 'data');
    // An index that refuses at once: the venv is created, pip runs and fails fast, offline.
    process.env.SECUREVECTOR_PIP_INDEX = 'https://127.0.0.1:9/simple';
    process.env.PIP_RETRIES = '0';
    process.env.PIP_TIMEOUT = '2';
    process.env.PIP_DISABLE_PIP_VERSION_CHECK = '1';
    const result = bootstrap.install(best, '0.0.0', { quiet: true });
    assert.strictEqual(result.ok, false);
    assert.ok(fs.existsSync(bootstrap.venvBin('0.0.0', 'python')), 'the venv was created');
    assert.ok(!fs.existsSync(marker), fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '');
  } finally {
    process.chdir(saved.cwd);
    for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k];
    Object.assign(process.env, saved.env);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a relative XDG_DATA_HOME is ignored', () => {
  const saved = process.env.XDG_DATA_HOME;
  const realPlatform = os.platform;
  os.platform = () => 'linux'; // the XDG branch, on any host
  const fallback = path.join(os.homedir(), '.local', 'share', 'securevector', 'npm-runtime');
  try {
    for (const rel of ['.', 'rel/dir']) {
      process.env.XDG_DATA_HOME = rel;
      assert.strictEqual(bootstrap.envRoot(), fallback);
    }
    process.env.XDG_DATA_HOME = '/opt/data';
    assert.strictEqual(bootstrap.envRoot(), path.join('/opt/data', 'securevector', 'npm-runtime'));
  } finally {
    os.platform = realPlatform;
    if (saved === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = saved;
  }
});
