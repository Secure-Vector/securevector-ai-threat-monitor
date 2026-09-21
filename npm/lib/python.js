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
const os = require('node:os');

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

/** `[major, minor]` for an interpreter, or null if it cannot be asked. */
function versionOf(candidate) {
  const { command, args } = splitCommand(candidate);
  try {
    const out = execFileSync(
      command,
      [...args, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }
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
function findPython() {
  const seen = [];
  let best = null;
  for (const candidate of CANDIDATES) {
    const version = versionOf(candidate);
    if (!version) continue;
    seen.push({ candidate, version });
    if (!isNewEnough(version)) continue;
    if (!best || version[0] > best.version[0] || (version[0] === best.version[0] && version[1] > best.version[1])) {
      best = { candidate, version };
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

module.exports = { findPython, explainMissing, versionOf, isNewEnough, MIN_MAJOR, MIN_MINOR, CANDIDATES };
