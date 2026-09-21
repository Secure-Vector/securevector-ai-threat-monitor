/**
 * Security exit-criteria guards for Agent Terminals (F3): the page CSP must
 * pin script-src to 'self' with no unsafe-eval, the vendored xterm.js
 * bundle must be loaded locally (never a CDN), and the vendored files must
 * match the hashes recorded in VERSIONS.md so a tampered or mismatched
 * vendor drop is caught in CI, not in the field.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');

function cspContent() {
  const html = read('index.html');
  const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(m, 'index.html must carry a Content-Security-Policy meta tag');
  return m[1];
}

test('the CSP has no unsafe-eval, pins script-src to self, and allows the loopback terminal WebSocket', () => {
  const csp = cspContent();
  assert.ok(!csp.includes('unsafe-eval'), 'unsafe-eval must never be in the CSP');
  assert.ok(csp.includes("script-src 'self';"), "script-src must be pinned to 'self' with nothing appended");
  assert.ok(csp.includes('ws://127.0.0.1:*'), 'loopback ws (127.0.0.1) must be allowed for the terminal socket');
  assert.ok(csp.includes('ws://localhost:*'), 'loopback ws (localhost) must be allowed for the terminal socket');
});

test('every xterm reference in index.html is a local path, never a CDN', () => {
  const html = read('index.html');
  const refs = [...html.matchAll(/(?:href|src)="([^"]*xterm[^"]*)"/gi)].map((m) => m[1]);
  assert.ok(refs.length >= 4, 'expected the xterm.css stylesheet plus three vendored scripts');
  for (const ref of refs) {
    assert.ok(ref.startsWith('/'), `xterm reference must be a local path: ${ref}`);
    assert.ok(!/cdn|unpkg|jsdelivr/i.test(ref), `xterm reference must not come from a CDN: ${ref}`);
  }
});

test('every file listed in VERSIONS.md matches its recorded SHA-256 on disk', () => {
  const versions = read('js/vendor/xterm/VERSIONS.md');
  const rows = [...versions.matchAll(/^\| (\S[^|]*?) \| [^|]+ \| [^|]+ \| ([0-9a-f]{64}) \|$/gm)];
  assert.ok(rows.length >= 4, 'expected at least the four vendored files in the table');
  const vendorDir = path.join(WEB, 'js', 'vendor', 'xterm');
  // Every path in the table is relative to vendorDir (js/vendor/xterm/),
  // including the ones that walk back out of it (e.g. ../../../css/xterm.css
  // for the stylesheet); resolve them all the same way.
  for (const [, fname, expected] of rows) {
    const trimmed = fname.trim();
    const filePath = path.resolve(vendorDir, trimmed);
    const bytes = fs.readFileSync(filePath);
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.strictEqual(actual, expected, `${trimmed} on disk does not match the hash recorded in VERSIONS.md`);
  }
});

test('every vendored .js file in js/vendor/xterm/ is listed in VERSIONS.md', () => {
  const versions = read('js/vendor/xterm/VERSIONS.md');
  const rows = [...versions.matchAll(/^\| (\S[^|]*?) \| [^|]+ \| [^|]+ \| ([0-9a-f]{64}) \|$/gm)];
  const listed = new Set(rows.map(([, fname]) => fname.trim()));
  const vendorDir = path.join(WEB, 'js', 'vendor', 'xterm');
  const onDisk = fs.readdirSync(vendorDir).filter((f) => f.endsWith('.js'));
  assert.ok(onDisk.length > 0, 'expected at least one vendored .js file on disk');
  for (const fname of onDisk) {
    assert.ok(listed.has(fname), `${fname} is on disk but missing a VERSIONS.md row`);
  }
});
