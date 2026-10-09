'use strict';

/**
 * Finding a Python this product can actually run on, and saying something
 * useful when there isn't one.
 *
 * SecureVector is a Python application. This package exists so that people
 * whose toolchain is Node do not have to know that before they can try it, but
 * "do not have to know" is not the same as "we will install a language runtime
 * behind your back". A security tool that silently provisions an interpreter is
 * doing the thing it warns other software about. So: detect, explain, stop.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The app extras need 3.10. The base SDK claims 3.9, but nothing this launcher
// starts is the base SDK, so 3.10 is the honest floor to check against.
const MIN_MAJOR = 3;
const MIN_MINOR = 10;

// Ordered by how likely each is to be the one the user means. A bare `python`
// is last: on a machine with both, `python` is as likely to be a 2.x relic as
// anything, and picking it would produce a syntax error rather than a message.
const CANDIDATES =
  os.platform() === 'win32'
    ? ['py -3', 'python3', 'python']
    : ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3', 'python'];

function splitCommand(candidate) {
  const parts = candidate.split(' ');
  return { command: parts[0], args: parts.slice(1) };
}

// Where Windows installs the per-machine and per-user `py.exe` launcher. These
// are asked first, before anything on PATH.
function windowsLaunchers(env) {
  const out = [];
  for (const root of [env.SystemRoot, env.windir]) {
    if (root) out.push(path.win32.join(root, 'py.exe'));
  }
  if (env.LOCALAPPDATA) out.push(path.win32.join(env.LOCALAPPDATA, 'Programs', 'Python', 'Launcher', 'py.exe'));
  return out;
}

/** Read an environment variable the way the platform does (case-blind on Windows). */
function envValue(env, name, platform) {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function isExecutableFile(file, platform) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    // Windows app execution aliases (Store Python in ...\WindowsApps) are
    // reparse points that stat() cannot follow; lstat sees the entry itself.
    // The interpreter is still asked its version before it is used.
    if (platform !== 'win32') return false;
    try {
      const st = fs.lstatSync(file);
      return !st.isDirectory();
    } catch {
      return false;
    }
  }
}

/** The same directory on disk? Symlinks resolved; case-blind where the filesystem usually is. */
function sameDir(a, b, platform) {
  const real = (d) => {
    try {
      return fs.realpathSync.native(d);
    } catch {
      return (platform === 'win32' ? path.win32 : path.posix).resolve(d);
    }
  };
  const fold = (d) => (platform === 'win32' || platform === 'darwin' ? d.toLowerCase() : d);
  return fold(real(a)) === fold(real(b));
}

/** PATH split into entries, with the quotes Windows allows around an entry removed. */
function pathEntries(env, platform) {
  const sep = platform === 'win32' ? ';' : ':';
  return (envValue(env, 'PATH', platform) || '').split(sep).map((e) => {
    const t = platform === 'win32' ? e.trim() : e;
    return platform === 'win32' && t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
  });
}

/**
 * Is this PATH entry somewhere we are willing to take an interpreter from?
 *
 * Only absolute entries outside the current directory and outside any
 * `node_modules/.bin`, so the interpreter used is the one installed on the
 * machine, wherever the command is run from. Empty and relative entries both
 * mean "the current directory" and are skipped.
 */
function isTrustedDir(dir, cwd, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (!dir || !p.isAbsolute(dir)) return false;
  if (cwd && sameDir(dir, cwd, platform)) return false;
  const segments = p.normalize(dir).split(/[\\/]+/).map((s) => (platform === 'win32' ? s.toLowerCase() : s));
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] === 'node_modules' && segments[i + 1] === '.bin') return false;
  }
  return true;
}

/**
 * The absolute path of `name`, found by walking PATH ourselves and skipping
 * every entry `isTrustedDir` rejects, or null. On Windows PATHEXT is honoured,
 * limited to the extensions that start without a shell (.exe, .com).
 */
function resolveExecutable(name, { env = process.env, cwd = process.cwd(), platform = os.platform() } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  let exts = [''];
  if (platform === 'win32') {
    exts = (envValue(env, 'PATHEXT', platform) || '.COM;.EXE')
      .split(';')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e === '.exe' || e === '.com');
    if (p.extname(name)) exts = [''];
    else if (exts.length === 0) exts = ['.exe'];
  }
  for (const dir of pathEntries(env, platform)) {
    if (!isTrustedDir(dir, cwd, platform)) continue;
    for (const ext of exts) {
      const file = p.join(dir, name + ext);
      if (isExecutableFile(file, platform)) return file;
    }
  }
  return null;
}

/**
 * Turn a candidate like `python3` or `py -3` into `{ command, args }` with an
 * absolute command, or null when there is no trusted one. On Windows the
 * system `py.exe` launcher is preferred over anything found on PATH.
 */
function resolveCandidate(candidate, opts = {}) {
  const platform = opts.platform || os.platform();
  const env = opts.env || process.env;
  const { command, args } = splitCommand(candidate);
  if (platform === 'win32' && command === 'py') {
    for (const file of windowsLaunchers(env)) {
      if (isExecutableFile(file, platform)) return { command: file, args };
    }
  }
  const resolved = resolveExecutable(command, { ...opts, env, platform });
  return resolved ? { command: resolved, args } : null;
}

/** `[major, minor]` for an interpreter, or null if it cannot be asked. */
function versionOf(candidate, opts = {}) {
  const resolved = typeof candidate === 'string' ? resolveCandidate(candidate, opts) : candidate;
  if (!resolved) return null;
  const { command, args } = resolved;
  try {
    const out = execFileSync(
      command,
      // -I: isolated mode, so nothing in the current directory (or PYTHON*
      // variables) can be imported ahead of the standard library.
      [...args, '-I', '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, cwd: os.homedir() }
    ).trim();
    const [major, minor] = out.split('.').map(Number);
    if (!Number.isInteger(major) || !Number.isInteger(minor)) return null;
    return [major, minor];
  } catch {
    return null;
  }
}

function isNewEnough([major, minor]) {
  return major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR);
}

/**
 * The best interpreter on this machine, as `{ candidate, version }`.
 *
 * Returns the highest usable version rather than the first found: a machine
 * with 3.9 on PATH and 3.12 beside it should use 3.12, and "first match wins"
 * would hand back the one that cannot run the app.
 */
function findPython(opts = {}) {
  const seen = [];
  let best = null;
  for (const candidate of opts.candidates || CANDIDATES) {
    const resolved = resolveCandidate(candidate, opts);
    if (!resolved) continue;
    const version = versionOf(resolved);
    if (!version) continue;
    seen.push({ candidate, version, command: resolved.command });
    if (!isNewEnough(version)) continue;
    if (!best || version[0] > best.version[0] || (version[0] === best.version[0] && version[1] > best.version[1])) {
      best = { candidate, version, command: resolved.command, args: resolved.args };
    }
  }
  return { best, seen };
}

/** What to tell someone who has no usable Python. Never a stack trace. */
function explainMissing(seen) {
  const floor = `${MIN_MAJOR}.${MIN_MINOR}`;
  if (seen.length === 0) {
    return [
      `SecureVector needs Python ${floor} or newer, and no Python was found on PATH.`,
      '',
      'Install one, then run this again:',
      os.platform() === 'darwin'
        ? '  brew install python@3.12        (or python.org/downloads)'
        : os.platform() === 'win32'
          ? '  winget install Python.Python.3.12   (or python.org/downloads)'
          : '  sudo apt install python3.12     (or your distribution equivalent)',
      '',
      'This package will not install a Python runtime for you. Provisioning a',
      'language runtime without being asked is the behaviour this product exists',
      'to flag in other software.',
    ].join('\n');
  }
  const found = seen.map((s) => `  ${s.candidate}: ${s.version.join('.')}`).join('\n');
  return [
    `SecureVector needs Python ${floor} or newer. The interpreters found are older:`,
    '',
    found,
    '',
    `Install Python ${floor}+ and run this again. If you already have one, make sure`,
    'it is on PATH ahead of the versions above.',
  ].join('\n');
}

module.exports = {
  findPython,
  explainMissing,
  versionOf,
  isNewEnough,
  resolveExecutable,
  resolveCandidate,
  isTrustedDir,
  isExecutableFile,
  pathEntries,
  MIN_MAJOR,
  MIN_MINOR,
  CANDIDATES,
};
