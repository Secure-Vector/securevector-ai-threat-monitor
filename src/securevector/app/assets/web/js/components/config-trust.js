/**
 * Agent Config Trust (setup trust): shared rendering for the Connect Agents
 * setup scan card, the per-harness Setup trust card, change cards, the
 * launch dialog's folder verdict, and the session summary's Setup row.
 *
 * Plain words only: no hashes on screen (they live in the audit chain).
 * Colour carries security state only: red for changed or unknown hooks, MCP,
 * permissions and mods; amber for new or for rules and other settings;
 * everything else is neutral. Buttons are wired with listeners, never inline
 * handlers, so the page CSP holds.
 */
const ConfigTrust = {
    _esc(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    _sev(sev) {
        return sev === 'red' ? 'is-red' : sev === 'amber' ? 'is-amber' : 'is-neutral';
    },

    STATE_WORDS: {
        pinned: 'Approved', new: 'Not approved yet', changed: 'Changed', none: 'Nothing configured',
        unknown: 'Unknown', trusted: 'Trusted', unparsed: 'Could not check',
    },

    _stateClass(state) {
        if (state === 'changed' || state === 'unknown' || state === 'unparsed') return 'is-red';
        if (state === 'new') return 'is-amber';
        return 'is-neutral';
    },

    _countsLine(c) {
        if (!c) return '';
        const n = (v, one, many) => `${v} ${v === 1 ? one : many}`;
        const parts = [n(c.mcp_servers || 0, 'MCP server', 'MCP servers'), n(c.hooks || 0, 'hook', 'hooks'),
            n(c.rules || 0, 'rules file', 'rules files')];
        if (c.mods) parts.push(n(c.mods, 'mod', 'mods'));
        return parts.join(' · ');
    },

    /** One change, in plain words, with Approve and Keep flagged. A changed
     *  tool description shows the old and new text side by side. */
    changeCardHtml(ch, view) {
        const target = ch.target === 'surface' ? 'surface' : ch.target;
        const key = ch.target === 'server' ? ch.server : ch.key;
        let diff = '';
        if (ch.old_description != null || ch.new_description != null) {
            diff = '<div class="ct-diff">'
                + `<div class="ct-diff-col"><div class="ct-diff-label">Approved</div><pre>${this._esc(ch.old_description || 'Not seen before')}</pre></div>`
                + `<div class="ct-diff-col"><div class="ct-diff-label">Now</div><pre>${this._esc(ch.new_description || 'Not available')}</pre></div>`
                + '</div>';
        } else if (ch.old_keys || ch.new_keys) {
            diff = `<div class="ct-diff-keys">Inputs before: ${this._esc((ch.old_keys || []).join(', ') || 'none')}. Now: ${this._esc((ch.new_keys || []).join(', ') || 'none')}.</div>`;
        }
        return `<div class="ct-change ${this._sev(ch.severity)}" data-ct-change>`
            + `<div class="ct-change-text">${this._esc(ch.text)}</div>${diff}`
            + '<div class="ct-change-actions">'
            + `<button type="button" class="btn btn-sm btn-primary" data-ct-approve data-harness="${this._esc(view.harness)}"`
            + ` data-target="${this._esc(target)}" data-key="${this._esc(key || '')}" data-expected="${this._esc(ch.current || '')}"${view.workspace ? ` data-workspace="${this._esc(view.workspace)}"` : ''}>Approve</button>`
            + '<button type="button" class="btn btn-sm" data-ct-keep>Keep flagged</button>'
            + '</div></div>';
    },

    /** Changes grouped per server: one card per change, servers together. */
    _changesHtml(view) {
        const changes = view.changes || [];
        if (!changes.length) return '';
        const groups = new Map();
        for (const ch of changes) {
            const g = ch.target === 'server' ? `server:${ch.server}` : ch.target;
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(ch);
        }
        let out = '';
        for (const [g, list] of groups) {
            const title = g.startsWith('server:') ? `MCP server ${g.slice(7)}` : g === 'mod' ? 'Mods' : 'Settings';
            out += `<div class="ct-group"><div class="ct-group-title">${this._esc(title)}</div>${list.map(ch => this.changeCardHtml(ch, view)).join('')}</div>`;
        }
        return out;
    },

    _risksHtml(risks) {
        if (!risks || !risks.length) return '';
        return '<ul class="ct-risks">' + risks.map(r => `<li class="${this._sev(r.severity)}"><span class="ct-dot" aria-hidden="true"></span>${this._esc(r.text)}</li>`).join('') + '</ul>';
    },

    /** The setup scan on first open: per harness counts, risky items first,
     *  change cards, and one Approve per harness that is not approved yet. */
    setupScanHtml(status) {
        const hs = (status && status.harnesses) || [];
        const t = (status && status.totals) || {};
        if (!hs.length) {
            return '<section class="ct-card" data-ct-setup aria-label="Your agent setup"><div class="ct-card-head"><h3>Your agent setup</h3></div>'
                + '<p class="ct-muted">No agent harness setup found on this device yet.</p></section>';
        }
        const risky = t.risky || 0;
        const changed = t.changed || 0;
        const n = (v, one, many) => `${this._esc(v || 0)} ${v === 1 ? one : many}`;
        const head = `${n(t.harnesses || hs.length, 'harness', 'harnesses')}: ${n(t.mcp_servers, 'MCP server', 'MCP servers')}, ${n(t.hooks, 'hook', 'hooks')}, ${n(t.rules, 'rules file', 'rules files')}${t.mods ? `, ${n(t.mods, 'mod', 'mods')}` : ''}.`;
        const flags = [];
        if (changed) flags.push(`<span class="ct-pill is-red">${this._esc(changed)} changed</span>`);
        if (risky) flags.push(`<span class="ct-pill is-red">${this._esc(risky)} risky</span>`);
        if (t.unapproved) flags.push(`<span class="ct-pill is-amber">${this._esc(t.unapproved)} not approved yet</span>`);
        // Harnesses with changes or risks first, then the rest.
        const rank = (v) => (v.changes.length ? 0 : (v.risks || []).some(r => r.severity === 'red') ? 1 : v.state === 'new' ? 2 : 3);
        const rows = hs.slice().sort((a, b) => rank(a) - rank(b)).map(v => {
            const approve = v.state === 'new'
                ? `<button type="button" class="btn btn-sm" data-ct-approve data-harness="${this._esc(v.harness)}" data-target="setup" data-key="" data-expected="${this._esc(v.view_hash || '')}">Approve this setup</button>` : '';
            return `<div class="ct-harness" data-ct-harness="${this._esc(v.harness)}">`
                + `<div class="ct-harness-head"><span class="ct-harness-name">${this._esc(v.label)}</span>`
                + `<span class="ct-state ${this._stateClass(v.state)}">${this._esc(this.STATE_WORDS[v.state] || v.state)}</span>`
                + `<span class="ct-counts">${this._esc(this._countsLine(v.counts))}</span>${approve}</div>`
                + this._risksHtml(v.risks) + this._changesHtml(v) + '</div>';
        }).join('');
        return '<section class="ct-card" data-ct-setup aria-label="Your agent setup">'
            + `<div class="ct-card-head"><h3>Your agent setup</h3>${flags.join('')}</div>`
            + `<p class="ct-muted">${head} Read from config files only; nothing was started.</p>${rows}</section>`;
    },

    /** Per-harness Setup trust card on the Integrations page. */
    harnessCardHtml(v) {
        if (!v) return '';
        const surfaces = (v.surfaces || []).map(s => `<li><span class="ct-state ${this._stateClass(s.state)}">${this._esc(this.STATE_WORDS[s.state] || s.state)}</span> ${this._esc(s.path_hint)} <span class="ct-muted">(${this._esc(s.type)})</span></li>`).join('');
        const servers = (v.servers || []).map(s => {
            const tools = (s.tools || []).map(t => `<li><span class="ct-state ${this._stateClass(t.state)}">${this._esc(this.STATE_WORDS[t.state] || t.state)}</span> ${this._esc(t.name)}${t.description === 'unobserved' ? ' <span class="ct-muted">description unobserved</span>' : ''}</li>`).join('');
            const names = (s.probe_header_names || []).length ? `headers sent: ${(s.probe_header_names || []).join(', ')}` : 'no headers sent';
            const probe = s.probe_allowed
                ? `<label class="ct-probe"><input type="checkbox" data-ct-probe data-harness="${this._esc(v.harness)}" data-server="${this._esc(s.name)}"${s.probe_opt_in ? ' checked' : ''}> Read its tool list from ${this._esc(s.probe_host || 'its address')} (one tools/list request, ${this._esc(names)}, logged)</label>`
                : (s.transport === 'stdio' ? '<span class="ct-muted">Stdio server: never started by SecureVector, descriptions come only from what the harness reports.</span>' : '');
            return `<div class="ct-server"><div class="ct-server-head"><span class="ct-harness-name">${this._esc(s.name)}</span>`
                + `<span class="ct-muted">${this._esc(s.transport || 'removed')}</span>`
                + `<span class="ct-state ${this._stateClass(s.state)}">${this._esc(this.STATE_WORDS[s.state] || s.state)}</span></div>`
                + (tools ? `<ul class="ct-list">${tools}</ul>` : `<div class="ct-muted">No tools seen yet (${this._esc(s.descriptions)}).</div>`)
                + probe + '</div>';
        }).join('');
        let mods = '';
        if (v.harness === 'claude-code') {
            const p = v.posture || {};
            const flag = (k, label) => `<li class="${p[k] ? 'is-red' : 'is-neutral'}"><span class="ct-dot" aria-hidden="true"></span>${this._esc(label)}: ${p[k] ? 'on' : 'off'}</li>`;
            const list = (v.mods || []).map(m => `<li><span class="ct-state ${this._stateClass(m.state)}">${this._esc(this.STATE_WORDS[m.state] || m.state)}</span> ${this._esc(m.name)} ${this._esc(m.version)} <span class="ct-muted">${m.managed ? 'managed' : 'user'}${(m.enabled_scopes || []).length ? `, on in ${this._esc(m.enabled_scopes.join(', '))}` : ', off'}${(m.handlers || []).length ? `, handles ${this._esc(m.handlers.join(', '))}` : ''}</span></li>`).join('');
            mods = '<div class="ct-section"><div class="ct-group-title">Mods</div>'
                + `<ul class="ct-risks">${flag('allowManagedModsOnly', 'Only managed mods allowed')}${flag('allowModsToOverrideDenyRules', 'Mods can override deny rules')}${flag('disableAllHooks', 'All hooks turned off')}</ul>`
                + (list ? `<ul class="ct-list">${list}</ul>` : '<div class="ct-muted">No mods installed.</div>') + '</div>';
        }
        const approve = (v.state === 'new' || v.state === 'changed')
            ? `<button type="button" class="btn btn-sm btn-primary" data-ct-approve data-harness="${this._esc(v.harness)}" data-target="setup" data-key="" data-expected="${this._esc(v.view_hash || '')}">Approve this setup</button>` : '';
        return `<section class="ct-card" data-ct-harness-card aria-label="Setup trust">`
            + `<div class="ct-card-head"><h3>Setup trust</h3><span class="ct-state ${this._stateClass(v.state)}">${this._esc(this.STATE_WORDS[v.state] || v.state)}</span>${approve}</div>`
            + `<p class="ct-muted">${this._esc(this._countsLine(v.counts))}. SecureVector reads these files and never runs what they name.</p>`
            + this._risksHtml(v.risks) + this._changesHtml(v)
            + (surfaces ? `<div class="ct-section"><div class="ct-group-title">Config files</div><ul class="ct-list">${surfaces}</ul></div>` : '')
            + (servers ? `<div class="ct-section"><div class="ct-group-title">MCP servers</div>${servers}</div>` : '')
            + mods + '</section>';
    },

    /** The verdict shown when the folder could not be checked at all. */
    unparsedVerdict(harness) {
        return { harness, state: 'unparsed', reasons_total: 1,
            reasons: [{ severity: 'red', text: 'Could not check this folder\'s agent config.' }] };
    },

    /** The launch dialog's folder verdict: state and the top reasons (max 3). */
    verdictHtml(v) {
        if (!v) return '';
        const words = { trusted: 'Folder setup approved', new: 'Folder setup not approved yet',
            changed: 'Folder setup changed since you approved it', none: 'No agent config in this folder',
            unparsed: 'Could not check this folder' };
        const cls = v.state === 'changed' || v.state === 'unparsed' ? 'is-red' : v.state === 'new' ? 'is-amber' : 'is-neutral';
        const reasons = (v.reasons || []).slice(0, 3).map(r => `<li class="${this._sev(r.severity)}"><span class="ct-dot" aria-hidden="true"></span>${this._esc(r.text)}</li>`).join('');
        const more = (v.reasons_total || 0) > 3 ? `<span class="ct-muted">+${this._esc(v.reasons_total - 3)} more</span>` : '';
        const approve = (v.state === 'new' || v.state === 'changed')
            ? `<button type="button" class="btn btn-sm" data-ct-approve data-harness="${this._esc(v.harness)}" data-target="setup" data-key="" data-expected="${this._esc(v.view_hash || '')}" data-workspace="${this._esc(v.workspace || '')}">Approve this folder</button>` : '';
        return `<div class="ct-verdict ${cls}" data-ct-verdict="${this._esc(v.state)}"><div class="ct-verdict-head">${this._esc(words[v.state] || v.state)}${v.workspace_name ? `: ${this._esc(v.workspace_name)}` : ''}</div>`
            + (reasons ? `<ul class="ct-risks">${reasons}</ul>` : '') + more + approve + '</div>';
    },

    /** The session summary's Setup row: reassurance or what changed. */
    summaryHtml(s) {
        if (!s || s.state === 'unchecked') return '';
        const cls = s.moved ? 'is-red' : s.state === 'changed' ? 'is-amber' : 'is-neutral';
        const list = (s.changes || []).slice(0, 5).map(c => `<li class="${this._sev(c.severity)}">${this._esc(c.text)}</li>`).join('');
        return `<span class="ct-summary ${cls}">${this._esc(s.text)}</span>${list ? `<ul class="terminals-summary-list">${list}</ul>` : ''}`;
    },

    /** The facts line part for a board row, or ''. */
    factsPart(t) {
        if (!t || !t.setup_state) return '';
        if (t.setup_state === 'changed') {
            return `<span class="terminals-task-setup is-red" title="Agent setup changed since it was approved">setup changed (${this._esc(t.setup_changes || 0)})</span>`;
        }
        if (t.setup_state === 'new') return '<span class="terminals-task-setup is-amber" title="Agent setup not approved yet">setup not approved</span>';
        return '<span class="terminals-task-setup" title="Agent setup matches what you approved">setup pinned</span>';
    },

    /** Wire Approve, Keep flagged and the probe switches inside `host`. */
    bind(host, onChange) {
        if (!host || !host.querySelectorAll) return;
        host.querySelectorAll('[data-ct-approve]').forEach(btn => {
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                try {
                    await API.configTrustApprove({
                        harness: btn.dataset.harness, target: btn.dataset.target || 'setup',
                        key: btn.dataset.key || null, workspace: btn.dataset.workspace || null,
                        expected: btn.dataset.expected || '',
                    });
                    if (onChange) onChange();
                } catch (e) {
                    // The files moved after this was shown: show the current
                    // changes instead of approving something unseen.
                    if (/changed after it was shown/.test((e && e.message) || '') && onChange) { onChange(); return; }
                    btn.disabled = false;
                    btn.textContent = 'Could not approve, try again';
                }
            });
        });
        host.querySelectorAll('[data-ct-keep]').forEach(btn => {
            btn.addEventListener('click', () => {
                const card = btn.closest ? btn.closest('[data-ct-change]') : null;
                if (card) card.classList.add('is-kept');
                btn.disabled = true;
                btn.textContent = 'Kept flagged';
            });
        });
        host.querySelectorAll('[data-ct-probe]').forEach(box => {
            box.addEventListener('change', async () => {
                try {
                    await API.configTrustProbe({ harness: box.dataset.harness, server: box.dataset.server, enable: !!box.checked });
                    if (onChange) onChange();
                } catch (e) {
                    box.checked = !box.checked;
                }
            });
        });
    },

    /** Render "Your agent setup" into `host` and keep it live after actions. */
    async mountSetup(host) {
        if (!host || !window.API || !API.configTrustStatus) return;
        host.innerHTML = '<section class="ct-card"><div class="ct-card-head"><h3>Your agent setup</h3></div><p class="ct-muted">Reading agent config files...</p></section>';
        try {
            const status = await API.configTrustStatus(true);
            host.innerHTML = this.setupScanHtml(status);
            this.bind(host, () => this.mountSetup(host));
        } catch (e) {
            host.innerHTML = '';
        }
    },

    async mountHarness(host, harness) {
        if (!host || !window.API || !API.configTrustHarness) return;
        try {
            const view = await API.configTrustHarness(harness);
            host.innerHTML = this.harnessCardHtml(view);
            this.bind(host, () => this.mountHarness(host, harness));
        } catch (e) {
            host.innerHTML = '';
        }
    },
};

window.ConfigTrust = ConfigTrust;
