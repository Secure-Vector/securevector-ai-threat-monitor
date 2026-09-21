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
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'securevector', 'npm-runtime');
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

  const { command, args } = splitPython(python);
  if (!run(command, [...args, '-m', 'venv', target])) {
    return { ok: false, reason: 'Could not create the virtual environment.' };
  }

  const pip = venvBin(version, 'python');
  // Upgrade pip inside the venv first: an old pip on the system Python is a
  // common cause of a wheel resolving wrongly, and this keeps that out of the
  // failure surface. Failure here is not fatal; the install may still work.
  run(pip, ['-m', 'pip', 'install', '--upgrade', 'pip'], { stdio: 'ignore' });

  if (!run(pip, ['-m', 'pip', 'install', spec])) {
    return {
      ok: false,
      reason: [
        `Could not install ${spec} from PyPI.`,
        '',
        'Common causes: no network, a proxy that needs configuring, or this',
        'version not being published yet. The environment was left at',
        `  ${target}`,
        'so you can look, or delete it and try again.',
      ].join('\n'),
    };
  }
  return { ok: true };
}

function splitPython(candidate) {
  const parts = candidate.split(' ');
  return { command: parts[0], args: parts.slice(1) };
}

module.exports = { envRoot, venvPath, venvBin, isReady, install, splitPython, PYPI_PACKAGE };
