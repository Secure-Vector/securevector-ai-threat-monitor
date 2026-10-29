/**
 * Governed delegation on Agent Sessions: nesting on the board, the parent's
 * Delegations row in the session summary, the approval card for a delegation
 * request, and the policy card in Settings. Plain words only. Colour carries
 * security state, so state words stay neutral. Everything that comes from a
 * task, a folder or a result is escaped, and buttons are wired with listeners,
 * never inline handlers, so the page CSP holds.
 */
const DelegationUI = {
    RESULT_LINES: 6,
    PROMPT_MARK: '\nPrompt:\n',

    _esc(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    HARNESS_WORDS: {
        'claude-code': 'Claude Code', codex: 'Codex', 'copilot-cli': 'Copilot CLI', antigravity: 'Antigravity',
    },
    harnessLabel(id) { return this.HARNESS_WORDS[id] || String(id || ''); },

    STATE_WORDS: {
        pending_approval: 'Waiting for approval', running: 'Running', waiting_for_user: 'Waiting for you', done: 'Done',
        held: 'Held for review', refused: 'Refused', failed: 'Failed',
    },

    // --- Board ----------------------------------------------------------

    COLLAPSE_KEY: 'sv-deleg-collapsed',

    /** Parents whose children are folded away. Never throws. */
    collapsed() {
        try {
            const store = window.localStorage;
            const raw = store ? store.getItem(this.COLLAPSE_KEY) : null;
            const arr = raw ? JSON.parse(raw) : [];
            return new Set(Array.isArray(arr) ? arr.filter(x => typeof x === 'string') : []);
        } catch (e) { return new Set(); }
    },
    /** Flip one parent's fold state and remember it. Returns true when folded. */
    toggle(id) {
        const now = this.collapsed();
        if (now.has(id)) now.delete(id); else now.add(id);
        try {
            const store = window.localStorage;
            if (store) store.setItem(this.COLLAPSE_KEY, JSON.stringify([...now].slice(-200)));
        } catch (e) { /* storage unavailable */ }
        return now.has(id);
    },

    /** Order items so each child follows its parent (oldest child first). A
     *  child whose parent is not in the list stays at top level. `keys` names
     *  the id, parent and created fields when the items are not tasks.
     *  Returns the ordered list, child id to parent, and parent id to children. */
    nest(items, keys) {
        const k = Object.assign({ id: 'id', parent: 'parent_task_id', created: 'created_at' }, keys || {});
        const list = Array.isArray(items) ? items : [];
        const byId = new Map(list.map(t => [t[k.id], t]));
        const parentOf = new Map();
        const kidsOf = new Map();
        for (const t of list) {
            const pid = t[k.parent];
            const p = pid && pid !== t[k.id] ? byId.get(pid) : null;
            if (p && !p[k.parent]) {
                parentOf.set(t[k.id], p);
                if (!kidsOf.has(p[k.id])) kidsOf.set(p[k.id], []);
                kidsOf.get(p[k.id]).push(t);
            }
        }
        for (const arr of kidsOf.values()) arr.sort((a, b) => String(a[k.created] || '').localeCompare(String(b[k.created] || '')));
        const out = [];
        for (const t of list) {
            if (parentOf.has(t[k.id])) continue;
            out.push(t);
            out.push(...(kidsOf.get(t[k.id]) || []));
        }
        return { list: out, parentOf, kidsOf, keys: k };
    },

    /** Drop children of folded parents. The child `keepId` (the selected one)
     *  is never hidden. */
    visible(nested, folded, keepId) {
        const k = nested.keys;
        return nested.list.filter(t => {
            const p = nested.parentOf.get(t[k.id]);
            return !p || !folded.has(p[k.id]) || t[k.id] === keepId;
        });
    },

    /** Position of a child under its parent: 'mid' or 'last'. */
    position(nested, t) {
        const k = nested.keys;
        const p = nested.parentOf.get(t[k.id]);
        if (!p) return null;
        const kids = nested.kidsOf.get(p[k.id]) || [];
        return kids[kids.length - 1] === t ? 'last' : 'mid';
    },

    /** True when a child runs in a different harness than its parent. */
    crossAgent(childHarness, parentHarness) {
        return !!childHarness && !!parentHarness && childHarness !== parentHarness;
    },
    crossHtml() {
        return '<span class="deleg-cross" title="Runs in a different agent than its parent">cross-agent</span>';
    },
    childrenText(n) { return `${n} ${n === 1 ? 'child' : 'children'}`; },

    /** The parent's fold button for the board. */
    toggleHtml(id, n, folded) {
        return `<button type="button" class="deleg-toggle" data-deleg-toggle="${this._esc(id)}" aria-expanded="${folded ? 'false' : 'true'}" `
            + `aria-label="${folded ? 'Show' : 'Hide'} ${this._esc(this.childrenText(n))}"><span class="deleg-caret" aria-hidden="true"></span>${this._esc(this.childrenText(n))}</button>`;
    },

    badgeHtml() {
        return '<span class="terminals-deleg-badge" title="Started by another session through a delegation">delegated</span>';
    },

    /** The line above a child card. Sits outside the card button so the link
     *  is valid markup. */
    fromHtml(child, parent, linked) {
        const title = parent ? (parent.title || this.harnessLabel(parent.executor_id) || 'parent') : 'another session';
        const name = parent && linked !== false
            ? `<a href="#" class="terminals-deleg-parent" data-deleg-parent="${this._esc(parent.id)}">${this._esc(title)}</a>`
            : this._esc(title);
        return `<div class="terminals-deleg-from">${this.badgeHtml()} from ${name}</div>`;
    },

    /** "2 running, 1 done, 1 held", or '' when the parent has none. */
    countsText(c) {
        if (!c || typeof c !== 'object') return '';
        const parts = [];
        for (const k of ['running', 'done', 'held']) {
            const n = Number(c[k]) || 0;
            if (n > 0) parts.push(`${n} ${k}`);
        }
        return parts.join(', ');
    },

    /** The parent card's Delegations line. */
    summaryLineHtml(t, kids, folded) {
        const text = this.countsText(t && t.delegations);
        const tog = kids > 0 ? this.toggleHtml(t.id, kids, !!folded) : '';
        if (!text && !tog) return '';
        return `<div class="terminals-deleg-line">${tog}${text ? `<span>Delegations: ${this._esc(text)}</span>` : ''}</div>`;
    },

    /** Wire "from <parent>" links inside the board: scroll to the parent card. */
    wireBoard(root, onToggle) {
        if (!root || !root.querySelectorAll) return;
        root.querySelectorAll('[data-deleg-toggle]').forEach(b => {
            b.onclick = (ev) => {
                if (ev && ev.stopPropagation) ev.stopPropagation();
                this.toggle(b.getAttribute('data-deleg-toggle'));
                if (onToggle) onToggle();
            };
        });
        root.querySelectorAll('[data-deleg-parent]').forEach(a => {
            a.onclick = (ev) => {
                if (ev && ev.preventDefault) ev.preventDefault();
                if (ev && ev.stopPropagation) ev.stopPropagation();
                const id = a.getAttribute('data-deleg-parent');
                const card = Array.from(root.querySelectorAll('.terminals-task[data-id]')).find(c => c.getAttribute('data-id') === id);
                if (card && card.scrollIntoView) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
            };
        });
    },

    // --- Session summary ----------------------------------------------------

    summaryData(resp) {
        const items = resp && Array.isArray(resp.items) ? resp.items : [];
        const out = items.filter(x => x && typeof x === 'object' && x.delegation_id).map(x => ({
            id: String(x.delegation_id), state: String(x.state || ''), harness: x.harness || '',
            folder: x.folder || '', reason: x.reason || '', result: typeof x.result === 'string' ? x.result : '',
            child: x.child_task_id || null, code: x.reason_code || '',
        }));
        return out.length ? out : null;
    },

    /** A result, escaped, with the lines past the sixth folded away. */
    resultHtml(text) {
        const lines = String(text || '').split('\n');
        if (lines.length <= this.RESULT_LINES) return `<pre class="terminals-deleg-result">${this._esc(lines.join('\n'))}</pre>`;
        const head = lines.slice(0, this.RESULT_LINES).join('\n');
        const rest = lines.slice(this.RESULT_LINES).join('\n');
        return `<pre class="terminals-deleg-result">${this._esc(head)}</pre>`
            + `<details class="terminals-deleg-more"><summary>Show ${lines.length - this.RESULT_LINES} more lines</summary>`
            + `<pre class="terminals-deleg-result">${this._esc(rest)}</pre></details>`;
    },

    itemHtml(d) {
        const word = this.STATE_WORDS[d.state] || d.state;
        let body = '';
        if (d.state === 'held') {
            // The held text is not shown here. A person decides first.
            body = `<div class="terminals-deleg-actions"><button type="button" class="btn btn-sm btn-primary" data-deleg-release="${this._esc(d.id)}" aria-label="Release the held result from ${this._esc(this.harnessLabel(d.harness))}">Release</button>`
                + `<button type="button" class="btn btn-sm" data-deleg-discard="${this._esc(d.id)}" aria-label="Discard the held result from ${this._esc(this.harnessLabel(d.harness))}">Discard</button></div>`;
        } else if (d.state === 'done' && d.result) {
            body = this.resultHtml(d.result);
        } else if ((d.state === 'refused' || d.state === 'failed' || d.state === 'waiting_for_user') && d.reason) {
            body = `<div class="terminals-deleg-reason">${this._esc(d.reason)}</div>`;
        } else if (d.state === 'done' && d.reason) {
            body = `<div class="terminals-deleg-reason">${this._esc(d.reason)}</div>`;
        }
        return `<li class="terminals-deleg-item" data-deleg-id="${this._esc(d.id)}">`
            + `<div class="terminals-deleg-head"><strong>${this._esc(this.harnessLabel(d.harness))}</strong> `
            + `<span class="terminals-deleg-state">${this._esc(word)}</span></div>${body}</li>`;
    },

    /** The Delegations row body. */
    summaryHtml(items) {
        return `<ul class="terminals-deleg-list">${items.map(d => this.itemHtml(d)).join('')}</ul>`;
    },

    /** Wire Release and Discard inside `host`. `api` carries the token. */
    wire(host, api, onChange) {
        if (!host || !host.querySelectorAll) return;
        const hook = (attr, call) => {
            host.querySelectorAll(`[${attr}]`).forEach(b => {
                b.onclick = async (ev) => {
                    if (ev && ev.preventDefault) ev.preventDefault();
                    const id = b.getAttribute(attr);
                    b.disabled = true;
                    try {
                        await call(id);
                        if (onChange) await onChange();
                    } catch (e) {
                        b.disabled = false;
                        const li = b.closest ? b.closest('.terminals-deleg-item') : null;
                        if (li) {
                            const err = (li.querySelector && li.querySelector('.terminals-deleg-error')) || null;
                            if (err) err.textContent = (e && e.message) || 'Could not save, try again';
                            else if (li.insertAdjacentHTML) li.insertAdjacentHTML('beforeend', `<div class="terminals-deleg-error">${this._esc((e && e.message) || 'Could not save, try again')}</div>`);
                        }
                    }
                };
            });
        };
        hook('data-deleg-release', (id) => api.terminalsDelegationRelease(id));
        hook('data-deleg-discard', (id) => api.terminalsDelegationDiscard(id));
    },

    // --- Approval inbox -----------------------------------------------------

    isDelegate(req) {
        return !!req && (req.rule_source === 'delegate' || String(req.tool_id || '').startsWith('delegate:'));
    },

    /** Pull the target, folder, parent task and full prompt out of a request. */
    parseRequest(req) {
        const just = String((req && req.justification) || '');
        const at = just.indexOf(this.PROMPT_MARK);
        // The summary is one line. A line break before the marker means the
        // text is not in the expected shape: show all of it as the prompt.
        if (at >= 0 && /[\r\n\u2028\u2029]/.test(just.slice(0, at))) {
            const toolTarget = String((req && req.tool_id) || '').replace(/^delegate:/, '');
            return { harness: toolTarget, folder: '', taskId: '', prompt: just, warnings: '',
                parentHarness: (req && req.runtime_kind) || '' };
        }
        const head = at >= 0 ? just.slice(0, at) : just;
        const prompt = at >= 0 ? just.slice(at + this.PROMPT_MARK.length) : '';
        const m = /Delegate to (\S+) in ([\s\S]+?) from task (\S+?)\.\s*$/.exec(head);
        const toolHarness = String((req && req.tool_id) || '').replace(/^delegate:/, '');
        const warn = /^Scan warnings: ([\s\S]*?)\. Delegate to /.exec(head);
        return {
            harness: (m && m[1]) || toolHarness,
            folder: (m && m[2]) || '',
            taskId: (m && m[3]) || '',
            prompt,
            warnings: warn ? warn[1] : '',
            parentHarness: (req && req.runtime_kind) || '',
        };
    },

    /** The approval card for a delegation request. `parent` is the parent task
     *  when the page has it. Same data-act buttons as every other card. */
    inboxHtml(req, parent, whenHtml) {
        const p = this.parseRequest(req);
        const title = parent ? (parent.title || this.harnessLabel(parent.executor_id)) : (p.taskId ? `task ${p.taskId.slice(0, 8)}` : 'an agent session');
        const parentHarness = (parent && parent.executor_id) || p.parentHarness;
        const cross = !!parentHarness && !!p.harness && parentHarness !== p.harness;
        const e = (v) => this._esc(v);
        return `
              <div class="terminals-approval terminals-deleg-card" data-id="${e(req.id)}" data-delegation-request>
                <div class="terminals-approval-tool"><span class="terminals-approval-label">Delegation request</span>${whenHtml || ''}</div>
                <dl class="terminals-deleg-facts">
                  <dt>From</dt><dd data-deleg-parent-title>${e(title)}</dd>
                  <dt>Target</dt><dd>${e(this.harnessLabel(p.harness))}</dd>
                  <dt>Folder</dt><dd class="terminals-deleg-folder">${e(p.folder || 'Not given')}</dd>
                </dl>
                ${cross ? '<div class="terminals-deleg-cross">Cross-harness delegation</div>' : ''}
                ${p.warnings ? `<div class="terminals-deleg-warn">Prompt scan: ${e(p.warnings)}</div>` : ''}
                <div class="terminals-deleg-label">Prompt</div>
                <pre class="terminals-deleg-prompt" tabindex="0">${e(p.prompt)}</pre>
                <div class="terminals-approval-actions">
                  <button class="btn btn-sm btn-primary" data-act="approve" data-dur="15m">Approve</button>
                  <button class="btn btn-sm" data-act="deny">Deny</button>
                </div>
              </div>`;
    },

    // --- Settings card ------------------------------------------------------

    COPY: {
        intro: 'Let a session start a second governed session.',
        whenTitle: 'Examples',
        when: [
            'Same agent: starts without asking',
            'Different agent: you approve each one',
            "Folders: parent's folder unless allowlisted",
        ],
        enabled: 'Each request is checked first.',
        cross: 'Each one needs your approval.',
        empty: 'No extra folders yet.',
    },

    ASK: {
        examples: [
            { text: 'Use SecureVector delegate to have another Claude Code session write the tests for this module, then summarise what it found.', note: '' },
            { text: 'Use SecureVector delegate to have Codex build page1.html, wait for the result, then merge it into index.html.', note: 'needs cross-harness delegation on' },
        ],
    },

    /** One line, then a collapsed "Examples": the copyable asks and three bullets. */
    introHtml() {
        const c = this.COPY;
        const a = this.ASK;
        const ex = a.examples.map((e, i) => `<div class="deleg-example"><div class="deleg-example-text" id="deleg-ex-${i}">${this._esc(e.text)}</div>`
            + `${e.note ? `<div class="deleg-example-note">${this._esc(e.note)}</div>` : ''}`
            + `<button type="button" class="btn btn-sm" data-deleg-copy="${i}" aria-describedby="deleg-ex-${i}">Copy</button></div>`).join('');
        return `<p class="deleg-intro">${this._esc(c.intro)}</p>`
            + `<details class="deleg-examples"><summary class="deleg-set-label" style="cursor: pointer;">${this._esc(c.whenTitle)}</summary>${ex}`
            + `<ul class="deleg-when">${c.when.map(x => `<li>${this._esc(x)}</li>`).join('')}</ul></details>`;
    },

    /** Copy text: the clipboard API, then a hidden textarea. Then a toast. */
    async copyText(text) {
        let ok = false;
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); ok = true; }
        } catch (e) { ok = false; }
        if (!ok) {
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.setAttribute('readonly', '');
                ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
                document.body.appendChild(ta);
                ta.select();
                ok = !!document.execCommand('copy');
                document.body.removeChild(ta);
            } catch (e) { ok = false; }
        }
        if (window.Toast) { if (ok) Toast.success('Copied'); else Toast.error('Could not copy. Select the text and copy it.'); }
        return ok;
    },

    /** Wire the Copy buttons inside the intro block. */
    wireIntro(host) {
        if (!host || !host.querySelectorAll) return;
        host.querySelectorAll('[data-deleg-copy]').forEach(b => {
            b.onclick = () => this.copyText(this.ASK.examples[Number(b.getAttribute('data-deleg-copy'))].text);
        });
    },

    async renderCard(host, api) {
        if (!host) return;
        let policy;
        try { policy = await api.getDelegationPolicy(); } catch (e) {
            host.innerHTML = `<div class="terminals-deleg-error">${this._esc((e && e.message) || 'Could not read the delegation policy')}</div>`;
            return;
        }
        host.innerHTML = this.cardHtml(policy);
        this.wireCard(host, api, policy);
    },

    cardHtml(policy) {
        const p = policy && typeof policy === 'object' ? policy : {};
        const list = Array.isArray(p.folder_allowlist) ? p.folder_allowlist : [];
        const toggle = (attr, on, label, note) => `<div class="deleg-set-row"><div><div class="deleg-set-label" id="${attr}-label">${label}</div>${note ? `<div class="deleg-set-note" id="${attr}-note">${note}</div>` : ''}</div>`
            + `<label class="toggle"><input type="checkbox" ${attr}${on ? ' checked' : ''} aria-labelledby="${attr}-label"${note ? ` aria-describedby="${attr}-note"` : ''}><span class="toggle-slider"></span></label></div>`;
        const rows = list.length
            ? list.map(f => `<li class="deleg-folder-row"><code>${this._esc(f)}</code><button type="button" class="btn btn-sm" data-deleg-folder-remove="${this._esc(f)}" aria-label="Remove folder ${this._esc(f)}">Remove</button></li>`).join('')
            : `<li class="deleg-folder-empty">${this._esc(this.COPY.empty)}</li>`;
        return toggle('data-deleg-enabled', p.enabled === true, 'Delegation', this.COPY.enabled)
            + toggle('data-deleg-cross', p.cross_harness === true, 'Allow cross-harness delegation', this.COPY.cross)
            + '<div class="deleg-set-label">Folder allowlist</div>'
            + `<ul class="deleg-folder-list">${rows}</ul>`
            + '<div class="deleg-folder-add"><input type="text" class="form-input" data-deleg-folder-input placeholder="/path/to/folder" aria-label="Folder path">'
            + '<button type="button" class="btn btn-sm" data-deleg-folder-add>Add folder</button></div>'
            + '<div class="terminals-deleg-error" data-deleg-error hidden></div>';
    },

    wireCard(host, api, policy) {
        if (!host || !host.querySelector) return;
        const state = {
            enabled: policy && policy.enabled === true,
            cross_harness: policy && policy.cross_harness === true,
            folder_allowlist: Array.isArray(policy && policy.folder_allowlist) ? policy.folder_allowlist.slice() : [],
        };
        const showError = (msg) => {
            const box = host.querySelector('[data-deleg-error]');
            if (!box) return;
            box.textContent = msg || '';
            box.hidden = !msg;
        };
        const save = async (body) => {
            showError('');
            try {
                const next = await api.setDelegationPolicy(body);
                host.innerHTML = this.cardHtml(next);
                this.wireCard(host, api, next);
            } catch (e) {
                host.innerHTML = this.cardHtml(state);
                this.wireCard(host, api, state);
                const box = host.querySelector('[data-deleg-error]');
                if (box) { box.textContent = (e && e.message) || 'Could not save the delegation policy'; box.hidden = false; }
            }
        };
        const onToggle = (sel, key) => {
            const el = host.querySelector(sel);
            if (el) el.onchange = () => save({ [key]: !!el.checked });
        };
        onToggle('[data-deleg-enabled]', 'enabled');
        onToggle('[data-deleg-cross]', 'cross_harness');
        const add = host.querySelector('[data-deleg-folder-add]');
        const input = host.querySelector('[data-deleg-folder-input]');
        if (add && input) {
            add.onclick = () => {
                const v = String(input.value || '').trim();
                if (!v) { showError('Enter a folder path first.'); return; }
                if (state.folder_allowlist.includes(v)) { showError('That folder is already on the list.'); return; }
                save({ folder_allowlist: state.folder_allowlist.concat([v]) });
            };
        }
        if (host.querySelectorAll) {
            host.querySelectorAll('[data-deleg-folder-remove]').forEach(b => {
                b.onclick = () => {
                    const f = b.getAttribute('data-deleg-folder-remove');
                    save({ folder_allowlist: state.folder_allowlist.filter(x => x !== f) });
                };
            });
        }
    },
};
if (typeof window !== 'undefined') window.DelegationUI = DelegationUI;
