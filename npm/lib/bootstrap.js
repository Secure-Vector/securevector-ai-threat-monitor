'use strict';

/**
 * The managed virtual environment this launcher installs into, and the rules
 * about when it is allowed to touch the network.
 *
 * The shape of the whole thing: `npm install` does NOTHING but put files on
 * disk. The first time someone actually runs `securevector`, and only then, we
 * create a virtual environment under their own data directory and pip install
 * the exact matching version from PyPI, saying so as it happens. Every run
 * after that is a process exec and nothing else.
 *
 * A postinstall script that downloads and executes code is precisely the
 * supply-chain shape this product warns people about. Shipping one in a
 * security tool would be indefensible whatever the convenience argument, so
 * this package does not have one.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PYPI_PACKAGE = 'securevector-ai-monitor';

// The only index this launcher installs from unless the user says otherwise.
const DEFAULT_PIP_INDEX = 'https://pypi.org/simple';

// The pip the venv is upgraded to before the install. 24.0 is the floor that
// handles every wheel tag the app's dependencies publish for Python 3.10 to
// 3.13; the cap at the next major keeps an unreviewed pip release out of a
// security tool's install path. Revisit when pip 27 ships.
const PIP_SELF_SPEC = 'pip>=24.0,<27';

// Variables that can point pip at another index or local wheels. They are
// cleared so the install always comes from the chosen index.
const PIP_INDEX_VARS = ['PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL', 'PIP_FIND_LINKS', 'PIP_NO_INDEX', 'PIP_TRUSTED_HOST'];

/**
 * The index to install from: PyPI, unless SECUREVECTOR_PIP_INDEX names another.
 * pip's own PIP_INDEX_URL and pip.conf are deliberately not honoured; a mirror
 * has to be chosen for this product on purpose, not inherited from the shell.
 */
function pipIndex(env = process.env) {
  const own = env.SECUREVECTOR_PIP_INDEX;
  if (!own || !own.trim()) return DEFAULT_PIP_INDEX;
  const value = own.trim();
  let url = null;
  try {
    url = new URL(value);
  } catch {
    url = null;
  }
  // Packages from a plain http index can be swapped in transit.
  if (!url || url.protocol !== 'https:') {
    throw new Error(`SECUREVECTOR_PIP_INDEX must be an https:// URL, got: ${value}`);
  }
  return value;
}

/** The environment pip runs with: no config files, no inherited index settings. */
function pipEnv(env = process.env) {
  const out = { ...env };
  const banned = new Set(PIP_INDEX_VARS.concat('PIP_CONFIG_FILE'));
  for (const key of Object.keys(out)) {
    if (banned.has(key.toUpperCase())) delete out[key];
  }
  // os.devnull as the config file is pip's documented way to load no pip.conf
  // at all, user, global or site.
  out.PIP_CONFIG_FILE = os.devnull;
  return out;
}

/** pip arguments for installing `spec` from the chosen index, and only that. */
function pipInstallArgs(spec, env = process.env) {
  return ['-I', '-m', 'pip', 'install', '--index-url', pipIndex(env), spec];
}

/**
 * Where install children run. Python puts the current directory first on
 * sys.path for `-m`; install children run with `-I` (isolated mode, Python
 * 3.4+) from a working directory the launcher owns.
 */
function childCwd() {
  try {
    fs.mkdirSync(envRoot(), { recursive: true });
    return envRoot();
  } catch {
    return os.homedir();
  }
}

/**
 * Where the managed environment lives.
 *
 * Under the user's own data directory, never inside node_modules: a global npm
 * prefix can be root-owned or on a read-only volume, and reinstalling or
 * updating the npm package would otherwise throw away a working environment
 * and re-download it.
 */
function envRoot() {
  const home = os.homedir();
  if (os.platform() === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'SecureVector', 'npm-runtime');
  }
  if (os.platform() === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'SecureVector', 'npm-runtime');
  }
  // The XDG spec says a relative XDG_DATA_HOME is invalid and must be ignored;
  // honouring "." would put the environment inside whatever folder this runs in.
  const xdg = process.env.XDG_DATA_HOME;
  const dataHome = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.local', 'share');
  return path.join(dataHome, 'securevector', 'npm-runtime');
}

/** One environment per version, so upgrading never half-migrates an old one. */
function venvPath(version) {
  return path.join(envRoot(), `v${version}`);
}

function venvBin(version, exe) {
  const dir = os.platform() === 'win32' ? 'Scripts' : 'bin';
  const suffix = os.platform() === 'win32' ? '.exe' : '';
  return path.join(venvPath(version), dir, exe + suffix);
}

/** Is the environment for this version present and carrying the entry points? */
function isReady(version, entryPoint) {
  try {
    return fs.existsSync(venvBin(version, entryPoint));
  } catch {
    return false;
  }
}

function run(command, args, opts = {}) {
  const res = spawnSync(command, args, { stdio: 'inherit', ...opts });
  if (res.error) throw res.error;
  return res.status === 0;
}

/**
 * Create the environment and install the pinned version. Talks while it works,
 * because it is a network install and a silent 30 second pause during what
 * looked like a launch is indistinguishable from a hang.
 */
function install(python, version, { extras = 'app', quiet = false } = {}) {
  const target = venvPath(version);
  const spec = `${PYPI_PACKAGE}[${extras}]==${version}`;
  const say = (line) => {
    if (!quiet) process.stderr.write(line + '\n');
  };

  say('');
  say(`  SecureVector ${version} is not set up yet on this machine.`);
  say('');
  say('  This will now, once:');
  say(`    create a virtual environment  ${target}`);
  say(`    install from PyPI             ${spec}`);
  say('');
  say('  Nothing was downloaded during npm install. Later runs start immediately.');
  say('');

  fs.mkdirSync(path.dirname(target), { recursive: true });

  let index;
  try {
    index = pipIndex();
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  const cwd = childCwd();

  const { command, args } = splitPython(python);
  if (!run(command, [...args, '-I', '-m', 'venv', target], { cwd })) {
    return { ok: false, reason: 'Could not create the virtual environment.' };
  }

  const pip = venvBin(version, 'python');
  // Upgrade pip inside the venv first: an old pip on the system Python is a
  // common cause of a wheel resolving wrongly, and this keeps that out of the
  // failure surface. Failure here is not fatal; the install may still work.
  // Its output is shown: it is a network install like the one below.
  const childEnv = pipEnv();
  if (index !== DEFAULT_PIP_INDEX) say(`  using package index           ${index}  (SECUREVECTOR_PIP_INDEX)`);
  run(pip, ['-I', '-m', 'pip', 'install', '--index-url', index, '--upgrade', PIP_SELF_SPEC], {
    cwd,
    env: childEnv,
    stdio: quiet ? 'ignore' : 'inherit',
  });

  if (!run(pip, pipInstallArgs(spec), { cwd, env: childEnv })) {
    return {
      ok: false,
      reason: [
        `Could not install ${spec} from PyPI.`,
        '',
        'Common causes: no network, a proxy that needs configuring, or this',
        'version not being published yet.',
        '',
        'pip.conf is ignored for this install. If it set a certificate or a',
        'proxy, set PIP_CERT or HTTPS_PROXY, or point SECUREVECTOR_PIP_INDEX at',
        'your https mirror.',
        '',
        'The environment was left at',
        `  ${target}`,
        'so you can look, or delete it and try again.',
      ].join('\n'),
    };
  }
  return { ok: true };
}

function splitPython(candidate) {
  // findPython hands back an absolute command (which may contain spaces);
  // only a bare string is split.
  if (candidate && typeof candidate === 'object') return { command: candidate.command, args: candidate.args || [] };
  const parts = candidate.split(' ');
  return { command: parts[0], args: parts.slice(1) };
}

module.exports = {
  envRoot,
  venvPath,
  venvBin,
  isReady,
  install,
  splitPython,
  pipIndex,
  pipEnv,
  pipInstallArgs,
  childCwd,
  PYPI_PACKAGE,
  DEFAULT_PIP_INDEX,
  PIP_SELF_SPEC,
};
