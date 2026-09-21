#!/usr/bin/env node
'use strict';

/**
 * `securevector` for people who install things with npm.
 *
 * This is a launcher, not a reimplementation. It finds a usable Python, makes
 * sure the matching PyPI release is installed in a virtual environment it
 * manages, and then hands over. Everything the product does, it does in the
 * Python process; nothing about behaviour is decided here.
 *
 * The one thing this file is opinionated about is that installing software is
 * an explicit act. `npm install` of this package touches the network exactly
 * zero times. The first real run says what it is going to do before it does it.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const pkg = require('../package.json');
const { findPython, explainMissing, MIN_MAJOR, MIN_MINOR } = require('../lib/python');
const { isReady, install, venvBin, venvPath, envRoot } = require('../lib/bootstrap');

// The npm version and the PyPI version are the same product, so the launcher
// pins to its own version rather than resolving "latest". Installing
// @securevector/cli@6.0.0 must never give you a different SecureVector than
// pip install securevector-ai-monitor==6.0.0 does.
const VERSION = pkg.version;

// Which Python entry point each verb runs. Names must match setup.py's
// console_scripts; a typo here is a confusing "command not found" inside the
// venv rather than an error anyone can act on, so there is a test for it.
const ENTRY_POINTS = {
  app: 'securevector-app',
  monitor: 'sv-monitor',
  proxy: 'securevector-proxy',
  mcp: 'securevector-mcp',
};
const DEFAULT_VERB = 'app';

function usage() {
  return [
    `SecureVector ${VERSION}`,
    '',
    'Usage:',
    '  securevector [app] [...]      Start the local app (default)',
    '  securevector monitor [...]    The sv-monitor CLI, including session commands',
    '  securevector proxy [...]      The LLM proxy',
    '  securevector mcp [...]        The MCP server',
    '  securevector doctor           Check this machine and report what is missing',
    '  securevector where            Print the managed environment path',
    '  securevector --version',
    '',
    'Anything after the verb is passed through untouched, so',
    '  securevector monitor session list',
    'is exactly sv-monitor session list.',
  ].join('\n');
}

function doctor() {
  const { best, seen } = findPython();
  const lines = [`SecureVector ${VERSION} (npm launcher)`, ''];
  lines.push(`node            ${process.version}`);
  lines.push(`platform        ${process.platform} ${process.arch}`);
  lines.push(`python floor    ${MIN_MAJOR}.${MIN_MINOR}`);
  if (best) {
    lines.push(`python found    ${best.candidate} (${best.version.join('.')})`);
  } else {
    lines.push('python found    none usable');
  }
  if (seen.length) {
    lines.push('interpreters    ' + seen.map((s) => `${s.candidate}=${s.version.join('.')}`).join('  '));
  }
  lines.push(`environment     ${venvPath(VERSION)}`);
  const ready = isReady(VERSION, ENTRY_POINTS[DEFAULT_VERB]);
  lines.push(`installed       ${ready ? 'yes' : 'no, the first run will set it up'}`);
  lines.push('');
  if (!best) {
    lines.push(explainMissing(seen));
    return { text: lines.join('\n'), code: 1 };
  }
  lines.push(ready ? 'Ready.' : 'Ready to set up. Run `securevector` to start.');
  return { text: lines.join('\n'), code: 0 };
}

function main(argv) {
  const args = argv.slice(2);

  if (args[0] === '--version' || args[0] === '-v') {
    process.stdout.write(VERSION + '\n');
    return 0;
  }
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    process.stdout.write(usage() + '\n');
    return 0;
  }
  if (args[0] === 'doctor') {
    const r = doctor();
    process.stdout.write(r.text + '\n');
    return r.code;
  }
  if (args[0] === 'where') {
    process.stdout.write(envRoot() + '\n');
    return 0;
  }

  // An unrecognised first argument is a flag or an argument for the default
  // verb, not a typo to reject: `securevector --web` has to keep working.
  const verb = Object.prototype.hasOwnProperty.call(ENTRY_POINTS, args[0]) ? args[0] : DEFAULT_VERB;
  const rest = verb === args[0] ? args.slice(1) : args;
  const entryPoint = ENTRY_POINTS[verb];

  const { best, seen } = findPython();
  if (!best) {
    process.stderr.write('\n' + explainMissing(seen) + '\n\n');
    return 1;
  }

  if (!isReady(VERSION, entryPoint)) {
    const result = install(best.candidate, VERSION);
    if (!result.ok) {
      process.stderr.write('\n' + result.reason + '\n\n');
      return 1;
    }
    if (!isReady(VERSION, entryPoint)) {
      process.stderr.write(
        `\nThe install finished but ${entryPoint} is not in ${venvPath(VERSION)}.\n` +
          'Run `securevector doctor`, and if that looks fine, delete the path above and try again.\n\n'
      );
      return 1;
    }
  }

  const child = spawn(venvBin(VERSION, entryPoint), rest, { stdio: 'inherit' });
  child.on('error', (err) => {
    process.stderr.write(`\nCould not start ${entryPoint}: ${err.message}\n\n`);
    process.exitCode = 1;
  });
  // Signals belong to the child: it owns a server, a proxy or a terminal
  // session, and this process is a thin parent that must not swallow a Ctrl-C
  // the child needs to shut down cleanly.
  child.on('exit', (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 0);
  });
  return null; // async from here; exit code set on the child's exit
}

if (require.main === module) {
  const code = main(process.argv);
  if (code !== null) process.exitCode = code;
}

module.exports = { main, doctor, usage, ENTRY_POINTS, DEFAULT_VERB, VERSION };
