/** Native approvals in the page: a 202 with a confirmation id is answered
 *  on the computer; api.js waits for it and hands the caller the original
 *  route's final answer, or "Not confirmed". */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const DECIDE = '/api/' + 'jit/requests/r1/approve';

class Node {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.parentNode = null; this.attrs = {};
    this.textContent = ''; this.className = ''; this.value = '';
    const self = this;
    this.classList = { add(c) { self.className += ` ${c}`; } };
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; }
  focus() {}
  querySelector(sel) {
    for (const c of this.children) {
      if (c.tagName === sel) return c;
      const hit = c.querySelector(sel);
      if (hit) return hit;
    }
    return null;
  }
  find(cls) {
    for (const c of this.children) {
      if ((` ${c.className} `).includes(` ${cls} `)) return c;
      const hit = c.find(cls);
      if (hit) return hit;
    }
    return null;
  }
}

function load(routes, platform = 'MacIntel') {
  const body = new Node('body');
  const calls = [];
  const sandbox = {
    console: { error() {}, log() {} }, Response, URL, Headers, setTimeout, clearTimeout,
    location: { origin: 'http://x', href: 'http://x/' },
    navigator: { platform },
    document: { body, createElement: (t) => new Node(t) },
  };
  sandbox.window = sandbox;
  sandbox.window.location = sandbox.location;
  sandbox.fetch = async (url, cfg) => {
    const method = (cfg && cfg.method) || 'GET';
    calls.push({ url, method, body: cfg && cfg.body, headers: cfg && cfg.headers });
    const key = `${method} ${url}`;
    const handler = routes[key] || routes[url];
    if (!handler) return new Response(JSON.stringify({ token: 'tok' }), { status: 200 });
    const [status, out] = handler(cfg, calls);
    return new Response(JSON.stringify(out), { status });
  };
  vm.runInNewContext(read('js/api.js') + '\nwindow.__A = API;', sandbox);
  const A = sandbox.__A;
  A.CONFIRM_POLL_MS = 1;
  return { A, body, calls, sandbox };
}

test('confirmThen passes through anything that is not a pending confirmation', async () => {
  const { A } = load({});
  const ok = new Response('{"a":1}', { status: 200 });
  assert.strictEqual(await A.confirmThen(ok), ok);
  const other = new Response('{"queued":true}', { status: 202 });
  assert.strictEqual(await A.confirmThen(other), other);
});

test('shell mode: "Confirm on your Mac" while pending, then the route\'s own answer', async () => {
  let polls = 0;
  const seenPanel = [];
  const { A, body } = load({
    [`POST ${DECIDE}`]: () => [202, { confirmation_id: 'c1', method: 'shell', summary: 'Allow Codex to run: git push', expires_in: 120 }],
    'GET /api/confirmations/c1': () => {
      polls += 1;
      seenPanel.push(body.children[0] && body.children[0].find('sv-confirm-title').textContent);
      return polls < 3 ? [200, { status: 'pending' }]
        : [200, { status: 'confirmed', result: { status_code: 200, body: { grant: { id: 'g1' } } } }];
    },
  });
  const out = await A.request(DECIDE, { method: 'POST', body: '{}' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), { grant: { id: 'g1' } });
  assert.strictEqual(seenPanel[0], 'Confirm on your Mac…');
  assert.strictEqual(body.children.length, 0, 'the panel closes once confirmed');
});

test('a declined or expired confirmation is "Not confirmed" and nothing else', async () => {
  for (const status of ['denied', 'expired']) {
    const { A, body } = load({
      [`POST ${DECIDE}`]: () => [202, { confirmation_id: 'c2', method: 'shell', summary: 'x' }],
      'GET /api/confirmations/c2': () => [200, { status }],
    }, 'Linux x86_64');
    await assert.rejects(A.request(DECIDE, { method: 'POST', body: '{}' }), /Not confirmed/);
    const panel = body.children[0];
    assert.ok(panel && panel.find('sv-confirm-title').textContent === 'Not confirmed');
  }
});

test('the prompt text names the Mac only on a Mac', () => {
  assert.strictEqual(load({}, 'Win32').A.confirmPrompt({ method: 'shell' }), 'Confirm on your computer…');
  assert.strictEqual(load({}).A.confirmPrompt({ method: 'code' }), 'Enter the code shown on your computer');
});

test('web mode: the six-digit field, a wrong code, then the right one', async () => {
  const posted = [];
  const { A, body } = load({
    [`POST ${DECIDE}`]: () => [202, { confirmation_id: 'c3', method: 'code', summary: 'Change settings' }],
    'GET /api/confirmations/c3': () => [200, { status: 'pending' }],
    'POST /api/confirmations/c3/code': (cfg) => {
      const code = JSON.parse(cfg.body).code;
      posted.push(code);
      return code === '123456'
        ? [200, { status: 'confirmed', result: { status_code: 200, body: { ok: true } } }]
        : [400, { detail: 'Wrong code. 4 tries left.' }];
    },
  });
  const pending = A.request(DECIDE, { method: 'POST', body: '{}' });
  await new Promise(r => setTimeout(r, 10));
  const panel = body.children[0];
  assert.strictEqual(panel.find('sv-confirm-title').textContent, 'Enter the code shown on your computer');
  const form = panel.querySelector('form');
  const input = panel.find('sv-confirm-code');
  input.value = '12';
  form.onsubmit({ preventDefault() {} });
  assert.strictEqual(panel.find('sv-confirm-msg').textContent, 'Enter all six digits.');
  input.value = '000000';
  form.onsubmit({ preventDefault() {} });
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(panel.find('sv-confirm-msg').textContent, 'Wrong code. 4 tries left.');
  input.value = '123 456';
  form.onsubmit({ preventDefault() {} });
  const out = await pending;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(out)), { ok: true });
  assert.deepStrictEqual(posted, ['000000', '123456']);
});

test('the status poll and the code carry the UI token', async () => {
  const { A, calls } = load({
    [`POST ${DECIDE}`]: () => [202, { confirmation_id: 'c4', method: 'shell', summary: 'x' }],
    'GET /api/confirmations/c4': () => [200, { status: 'confirmed', result: { status_code: 204 } }],
  });
  const res = await A.confirmThen(
    new Response(JSON.stringify({ confirmation_id: 'c4', method: 'shell', summary: 'x' }), { status: 202 }));
  assert.strictEqual(res.status, 204);
  const poll = calls.find(c => c.url === '/api/confirmations/c4');
  assert.strictEqual(poll.headers['X-SV-UI-Token'], 'tok');
});

test('Approve all sends one batch call, so the person confirms once', () => {
  const page = read('js/pages/detection-response.js');
  const bulk = page.slice(page.indexOf('async _askBulk'), page.indexOf('_bind(host)'));
  assert.match(bulk, /API\.configTrustApproveAll\(targets\.map\(t => t\.body\)/);
  assert.doesNotMatch(bulk, /for \(const t of targets\) \{ await API\.configTrustApprove\(/);
  assert.match(read('js/api.js'), /\/api\/terminals\/config-trust\/pins\/batch/);
});

test('Cancel on the page denies the confirmation on the server', async () => {
  const { A, body, calls } = load({
    [`POST ${DECIDE}`]: () => [202, { confirmation_id: 'c5', method: 'shell', summary: 'x' }],
    'GET /api/confirmations/c5': () => [200, { status: 'pending' }],
    'POST /api/confirmations/c5/cancel': () => [200, { status: 'denied' }],
  });
  const pending = A.request(DECIDE, { method: 'POST', body: '{}' });
  await new Promise(r => setTimeout(r, 10));
  const cancel = body.children[0].find('sv-confirm-cancel');
  assert.ok(cancel && cancel.textContent === 'Cancel');
  cancel.onclick();
  await assert.rejects(pending, /Not confirmed/);
  const c = calls.find(x => x.url === '/api/confirmations/c5/cancel');
  assert.ok(c && c.method === 'POST' && c.headers['X-SV-UI-Token'] === 'tok');
});

test('the lockout message is shown when too many wrong codes were entered', async () => {
  const text = 'Too many wrong codes were entered on this computer. Wait 10 minutes.';
  const { A, body } = load({
    [`POST ${DECIDE}`]: () => [202, { confirmation_id: 'c6', method: 'code', summary: 'x' }],
    'GET /api/confirmations/c6': () => [200, { status: 'pending' }],
    'POST /api/confirmations/c6/code': () => [429, { detail: text }],
  });
  const pending = A.request(DECIDE, { method: 'POST', body: '{}' });
  await new Promise(r => setTimeout(r, 10));
  const panel = body.children[0];
  panel.find('sv-confirm-code').value = '111111';
  panel.querySelector('form').onsubmit({ preventDefault() {} });
  await assert.rejects(pending, /Not confirmed/);
  assert.strictEqual(panel.find('sv-confirm-msg').textContent, text);
  assert.strictEqual(panel.find('sv-confirm-title').textContent, 'Not confirmed');
});
