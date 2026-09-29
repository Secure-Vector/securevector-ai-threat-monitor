'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'securevector', 'app', 'assets', 'web');
const read = (name) => fs.readFileSync(path.join(WEB, name), 'utf8');

function browser() {
  const byId = {};
  const pages = [];
  const document = {
    activeElement: null,
    head: { appendChild(el) { if (el.id) byId[el.id] = el; } },
    getElementById: (id) => byId[id] || null,
    createElement(tag) {
      const el = {
        tag, children: [], attrs: {}, listeners: {}, style: {}, dataset: {}, className: '',
        appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
        setAttribute(key, value) { this.attrs[key] = value; },
        getAttribute(key) { return this.attrs[key]; },
        addEventListener(key, fn) { this.listeners[key] = fn; },
        querySelectorAll(selector) { return selector === '[role="tab"]' ? this.children.filter(child => child.attrs.role === 'tab') : []; },
        focus() { document.activeElement = this; },
        click() { if (this.listeners.click) this.listeners.click(); },
      };
      return el;
    },
  };
  const window = { App: { loadPage(page) { pages.push(page); } } };
  const sandbox = { document, window, App: window.App, console };
  vm.runInNewContext(read('js/components/obs-tabs.js'), sandbox);
  return { tabs: window.ObsTabs, document, pages };
}

test('Observability tabs are named, focusable, and support roving keyboard navigation', () => {
  const { tabs, document, pages } = browser();
  const host = document.createElement('div');
  tabs.render(host, 'runs');
  const list = host.children[0];
  const buttons = list.children;
  assert.equal(list.getAttribute('aria-label'), 'Observability views');
  assert.deepEqual(buttons.map(b => b.title), ['Open Runs', 'Open Health', 'Open Map']);
  assert.deepEqual(buttons.map(b => b.tabIndex), [0, -1, -1]);
  assert.equal(buttons[0].getAttribute('aria-selected'), 'true');
  buttons[0].focus();
  let prevented = false;
  list.listeners.keydown({ key: 'ArrowRight', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(document.activeElement, buttons[1]);
  assert.deepEqual(buttons.map(b => b.tabIndex), [-1, 0, -1]);
  assert.deepEqual(pages, ['run-health']);
  list.listeners.keydown({ key: 'End', preventDefault() {} });
  assert.equal(document.activeElement, buttons[2]);
  assert.deepEqual(pages, ['run-health', 'agent-map']);
  list.listeners.keydown({ key: 'Home', preventDefault() {} });
  assert.equal(document.activeElement, buttons[0]);
  assert.equal(pages.at(-1), 'agent-runs');
});

test('roving tab focus survives the reload that activating a tab triggers', () => {
  const { tabs, document } = browser();
  const host1 = document.createElement('div');
  tabs.render(host1, 'runs');
  const list1 = host1.children[0];
  const buttons1 = list1.children;
  buttons1[0].focus();
  list1.listeners.keydown({ key: 'ArrowRight', preventDefault() {} });
  // Activating a tab reloads the page: a fresh tablist is rendered into a
  // fresh container, discarding the button we just focused.
  const host2 = document.createElement('div');
  tabs.render(host2, 'health');
  const list2 = host2.children[0];
  const buttons2 = list2.children;
  assert.equal(document.activeElement, buttons2[1]);
  assert.equal(buttons2[1].attrs['aria-selected'], 'true');
  // A later, ordinary render (no keyboard activation) must not steal focus.
  const host3 = document.createElement('div');
  tabs.render(host3, 'map');
  assert.equal(document.activeElement, buttons2[1]);
});

test('session names use custom, verified Terminal, workspace, and stable ID priority', () => {
  const { tabs } = browser();
  const sandbox = { window: {}, ObsTabs: tabs, document: { getElementById: () => null }, console };
  vm.runInNewContext(read('js/pages/agent-runs.js'), sandbox);
  const page = sandbox.window.AgentRunsPage;
  tabs.agentName = (trace) => trace === 'custom' ? '<Owner>' : null;
  assert.equal(page._agentLabel({ trace_id: 'custom', session_id: 'session-123', terminal_task: { id: 't', title: 'Task' } }), '<Owner>');
  assert.equal(page._agentLabel({ trace_id: 't1', session_id: 'session-123', terminal_task: { id: 't', title: '<Deploy>' } }), '<Deploy>');
  assert.equal(page._agentLabel({ trace_id: 't2', session_id: 'session-123', terminal_task: { id: 't', workspace_name: 'app-name' } }), 'app-name');
  assert.equal(page._agentLabel({ trace_id: 't3', session_id: 'session-123' }), 'Session session-');
  assert.equal(page._agentLabel({ trace_id: 'trace-1234' }), 'Trace trace-12');
  assert.equal(page._esc(page._agentLabel({ trace_id: 'custom' })), '&lt;Owner&gt;');
});

test('session toolbar spans the split and offers a verified Terminal navigation action', () => {
  const src = read('js/pages/agent-runs.js');
  assert.match(src, /grid-template-columns:296px minmax\(0,1fr\); gap:12px/);
  assert.match(src, /command\.appendChild\(toolbar\);\s*container\.appendChild\(command\)/);
  assert.match(src, /\(triage \|\| list\)\.appendChild\(chips\)/);
  assert.match(src, /className = 'ar-more-views'/);
  assert.match(src, /sessionStorage\.setItem\('sv-agent-task-id', taskId\)/);
  assert.match(src, /Sidebar\.navigate\('terminals'\)/);
  assert.match(src, /\(taskId \? '<button type="button" class="ar-terminal-open"/);
  assert.match(read('js/pages/agent-map.js'), /_sessionLabel\(n\)/);
  assert.doesNotMatch(read('js/pages/getting-started.js'), /agent #N/i);
});

test('only a verified linked session opens its exact Terminal task', () => {
  const events = [];
  const storage = {};
  const detail = { children: [], appendChild(child) { this.children.push(child); } };
  const createElement = () => ({
    innerHTML: '', hidden: false, attrs: {}, listeners: {},
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(key, fn) { this.listeners[key] = fn; },
    appendChild() {},
    querySelector(selector) {
      if (selector === '.ar-terminal-open' && !this.innerHTML.includes('ar-terminal-open')) return null;
      if (selector === '.ar-live-pause') return null;
      const button = { addEventListener(_event, fn) { events.push({ selector, fn }); } };
      return button;
    },
  });
  const window = { Sidebar: { navigate(page) { events.push({ page }); } } };
  const sandbox = {
    window, Sidebar: window.Sidebar, console,
    ObsTabs: { agentName: () => null },
    sessionStorage: { setItem(key, value) { storage[key] = value; } },
    document: { getElementById: (id) => id === 'ar-detail' ? detail : null, createElement },
  };
  vm.runInNewContext(read('js/pages/agent-runs.js'), sandbox);
  const page = window.AgentRunsPage;
  page._timelineIsOpen = () => false;
  page._timelineSync = () => {};
  page._renderTimeline = () => {};
  page._renderSteps = () => {};
  page._loadHealth = () => {};
  const trace = { trace_id: 'trace-1', session_id: 'session-1', runtime_kind: 'codex', ended_at: '2026-01-01T00:00:00Z' };
  page.runs = [{ trace_id: 'trace-1', terminal_task: { id: 'task-1', title: 'Build' } }];
  page.renderWaterfall(trace);
  const open = events.find(e => e.selector === '.ar-terminal-open');
  assert.ok(open);
  let stopped = false;
  open.fn({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.equal(storage['sv-agent-task-id'], 'task-1');
  assert.equal(events.at(-1).page, 'terminals');
  events.length = 0;
  page.runs = [{ trace_id: 'trace-1' }];
  page.renderWaterfall(trace);
  assert.equal(events.some(e => e.selector === '.ar-terminal-open'), false);
});
