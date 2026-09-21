/** Subresource Integrity (SRI) for the vendored xterm.js scripts.
 *
 * The release-gate security criterion is "CSP with pinned, hashed, vendored
 * dependencies" -- pinning alone (the ?v=N query string) does not stop a
 * tampered or accidentally-edited vendor file from being served silently.
 * A hash pins the *content*, not just the filename.
 *
 * The trap with a hardcoded integrity hash is that nobody re-derives it by
 * hand on every review, so it quietly rots: someone patches
 * js/vendor/xterm/xterm.js (a security fix, a build re-vendor, anything)
 * and forgets to update the hash in index.html. The browser then refuses to
 * run the new file (good, loudly, for a real user) but our own test suite
 * would say nothing was wrong (bad, silently, for us) -- unless the test
 * itself recomputes the hash from the file on disk and compares it to what
 * index.html declares. That is what this file does: it does not know the
 * "right" hash in advance, it derives it fresh from the vendored bytes on
 * every run, so an edited vendor file without a matching hash update fails
 * the suite instead of failing a user's browser at runtime.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const readVendorBinary = (rel) => fs.readFileSync(path.join(WEB, 'js', 'vendor', 'xterm', rel));

const sha384Base64 = (buf) => crypto.createHash('sha384').update(buf).digest('base64');

const VENDOR_FILES = ['xterm.js', 'addon-fit.js', 'addon-webgl.js'];

// Pull the exact <script src="/js/vendor/xterm/<file>...> tag out of
// index.html so we can inspect its attributes, rather than re-deriving the
// tag text ourselves and risking a mismatch with what the browser sees.
function findScriptTag(html, vendorFile) {
  const re = new RegExp(
    `<script[^>]*src="\\/js\\/vendor\\/xterm\\/${vendorFile.replace('.', '\\.')}[^"]*"[^>]*>`,
  );
  const match = html.match(re);
  assert.ok(match, `expected a <script> tag loading js/vendor/xterm/${vendorFile}`);
  return match[0];
}

test('vendored xterm scripts have an integrity attribute matching the file on disk', () => {
  const html = read('index.html');

  for (const file of VENDOR_FILES) {
    const tag = findScriptTag(html, file);

    const integrityMatch = tag.match(/integrity="([^"]+)"/);
    assert.ok(integrityMatch, `${file} script tag is missing an integrity attribute`);

    const declared = integrityMatch[1];
    const expected = `sha384-${sha384Base64(readVendorBinary(file))}`;

    // This is the assertion that makes the hash trustworthy: it is not
    // comparing two copies of a hash someone typed by hand, it is
    // comparing the declared hash against one computed right now from the
    // vendored bytes. If the vendor file changes and index.html is not
    // updated to match, this fails.
    assert.strictEqual(
      declared,
      expected,
      `integrity for ${file} is stale: index.html declares ${declared} but the ` +
        `file on disk hashes to ${expected}. Re-run ` +
        `"openssl dgst -sha384 -binary <file> | openssl base64 -A" and update index.html.`,
    );
  }
});

test('vendored xterm scripts do not set crossorigin', () => {
  const html = read('index.html');

  for (const file of VENDOR_FILES) {
    const tag = findScriptTag(html, file);

    // These scripts are served same-origin by the loopback app server,
    // which sends no Access-Control-Allow-Origin header anywhere. Adding
    // crossorigin here would switch the fetch into CORS mode -- required
    // for integrity checking on a cross-origin resource, but for a
    // same-origin one it only adds a CORS precondition the server can
    // never satisfy, so the script would fail to load. integrity works
    // for same-origin resources without crossorigin.
    assert.ok(
      !/\bcrossorigin\b/.test(tag),
      `${file} script tag must not set crossorigin (server sends no CORS headers): ${tag}`,
    );
  }
});
