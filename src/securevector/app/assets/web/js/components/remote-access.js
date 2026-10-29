/**
 * Remote access mode (6.1.0, phase 1): the browser side.
 *
 * Off by default. While it is on, a page opened by the app's network address
 * can sign in with the access token and then approve, deny and revoke
 * approvals and list and stop sessions. The remote session id lives in
 * sessionStorage only (never localStorage, never a cookie) and is sent as
 * `X-SV-Remote-Session: <id>` by API.request (Authorization stays free for
 * an ingress token). The server enforces every
 * rule; this file only shows the controls that will be accepted.
 */
(function (root) {
    'use strict';

    const RemoteAccess = {
        SESSION_KEY: 'sv_remote_session',
        REAUTH_MS: 10 * 60 * 1000,
        PHASE1_NOTE: 'Launching, linking and typing into sessions work only on this machine (localhost) in this release.',
        DEVICE_ONLY_NOTE: 'Approve this on the machine itself.',
        REAUTH_DETAIL: 'Enter the access token again to continue',
        TURN_ON_HERE: 'Turn it on here, then sign in from the other machine.',
        NOT_NEEDED: 'Not needed here: you are on this machine.',
        CHANGE_ON_MACHINE: 'Change this on the machine itself.',
        TOKEN_ONCE: 'This token is shown once. Store it in your password manager.',
        OFF_SIGNS_OUT: 'This signs out every remote browser.',
        /** Setup help for a proxy on this machine, with the port the app
         *  serves on (from the server, else the page's port, else 8741). */
        proxySameMachine(port) {
            const loc = root.location || {};
            const p = Number(port) || Number(loc.port) || 8741;
            return `Same machine, not 127.0.0.1: proxy_pass http://<private-ip>:${p}; or reverse_proxy <private-ip>:${p}`;
        },
        PROXY_HOST: 'Pass the original Host (nginx: proxy_set_header Host $host).',

        state: { enabled: false, signedIn: false, local: true, allowance: ['once'], deviceOnlyRules: ['cred_then_net', 'outside_then_reach'], reauthAt: 0 },

        esc(s) {
            return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        },

        _store() {
            try { return root.sessionStorage || (typeof sessionStorage !== 'undefined' ? sessionStorage : null); } catch (_) { return null; }
        },
        sessionId() {
            const s = this._store();
            try { return (s && s.getItem(this.SESSION_KEY)) || ''; } catch (_) { return ''; }
        },
        _setSession(id) {
            const s = this._store();
            try { if (s) { if (id) s.setItem(this.SESSION_KEY, id); else s.removeItem(this.SESSION_KEY); } } catch (_) { /* no storage */ }
        },
        /** The header value API.request attaches, or '' with no session. */
        authHeader() {
            const id = this.sessionId();
            return /^[0-9a-f]{16,128}$/.test(id) ? id : '';
        },

        /** Opened by a network address (not localhost, 127.x or ::1). */
        isRemotePage() {
            const api = root.API || (typeof API !== 'undefined' ? API : null);
            return !!(api && api.terminalsRemote && api.terminalsRemote());
        },
        signedIn() {
            return !!(this.state.enabled && this.state.signedIn && this.authHeader());
        },
        reauthFresh(now) {
            return !!this.state.reauthAt && ((now || Date.now()) - this.state.reauthAt) <= this.REAUTH_MS;
        },
        /** The durations a remote approval may use: the device's allowance. */
        allowedDurations(list) {
            if (!this.signedIn()) return list;
            const ok = new Set(this.state.allowance || ['once']);
            return list.filter(d => ok.has(d[0]));
        },
        /** Held by a rule approved only on the machine itself, or a
         *  delegation (it launches a task). */
        isDeviceOnly(req) {
            if (!req) return false;
            if (req.rule_source === 'delegate') return true;
            const rules = new Set(this.state.deviceOnlyRules || []);
            return String(req.held_by || '').split(',').some(r => rules.has(r.trim()));
        },

        _api() { return root.API || (typeof API !== 'undefined' ? API : null); },

        async refresh() {
            const api = this._api();
            let r = null;
            try { r = await api.request('/api/remote-access'); } catch (_) { r = null; }
            const s = this.state;
            s.enabled = !!(r && r.enabled);
            s.signedIn = !!(r && r.signed_in);
            s.local = r ? !!r.local : !this.isRemotePage();
            if (r && Array.isArray(r.allowance)) s.allowance = r.allowance;
            if (r && Array.isArray(r.device_only_rules)) s.deviceOnlyRules = r.device_only_rules;
            if (r && r.reauth_at) s.reauthAt = Date.parse(r.reauth_at) || s.reauthAt;
            s.view = r;
            // Mode off (or not signed in): drop the session header at once.
            if ((!s.enabled || !s.signedIn) && this.sessionId()) this._setSession('');
            if (api) api.remote = { enabled: s.enabled, signedIn: this.signedIn() };
            this.renderHeader();
            return s;
        },

        async signIn(token) {
            const api = this._api();
            const r = await api.request('/api/remote-access/session', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: String(token || '').trim() }),
            });
            this._setSession(r.session_id);
            this.state.reauthAt = Date.now();
            await this.refresh();
            return r;
        },
        async signOut() {
            const api = this._api();
            try { await api.request('/api/remote-access/session/end', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (_) { /* signed out locally anyway */ }
            this._setSession('');
            this.state.signedIn = false;
            this.state.reauthAt = 0;
            await this.refresh();
        },
        async reauth(token) {
            const api = this._api();
            await api.request('/api/remote-access/reauth', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: String(token || '').trim() }),
            });
            this.state.reauthAt = Date.now();
        },
        /** Before an approve or a revoke: ask for the token again when the
         *  last entry is older than 10 minutes. Throws when cancelled. */
        async ensureFresh() {
            if (!this.signedIn() || this.reauthFresh()) return;
            const token = await this.askToken('Enter the access token again', 'Approving and revoking from another machine need the token entered within the last 10 minutes.');
            if (!token) throw new Error('Cancelled');
            await this.reauth(token);
        },

        // --- small dialogs ------------------------------------------------------------

        tokenDialogHtml(title, note) {
            const e = (s) => this.esc(s);
            return `<div class="remote-dialog" role="dialog" aria-modal="true" aria-labelledby="remote-dialog-title">` +
                `<h3 id="remote-dialog-title">${e(title)}</h3>` +
                (note ? `<p class="remote-dialog-note">${e(note)}</p>` : '') +
                `<label class="remote-dialog-label" for="remote-dialog-token">Access token</label>` +
                `<input id="remote-dialog-token" class="remote-dialog-input" type="password" autocomplete="off" spellcheck="false">` +
                `<p class="remote-dialog-error" hidden></p>` +
                `<div class="remote-dialog-actions"><button type="button" class="btn btn-sm" data-act="cancel">Cancel</button>` +
                `<button type="button" class="btn btn-primary btn-sm" data-act="ok">Continue</button></div></div>`;
        },
        /** A token prompt. Resolves to the token, or '' when cancelled. */
        askToken(title, note) {
            const doc = root.document;
            if (!doc || !doc.createElement || !doc.body) return Promise.resolve('');
            return new Promise((resolve) => {
                const overlay = doc.createElement('div');
                overlay.className = 'remote-dialog-overlay';
                overlay.innerHTML = this.tokenDialogHtml(title, note);
                const input = overlay.querySelector('#remote-dialog-token');
                const done = (value) => { overlay.remove(); resolve(value); };
                overlay.querySelector('[data-act="cancel"]').onclick = () => done('');
                overlay.querySelector('[data-act="ok"]').onclick = () => done(input.value.trim());
                input.addEventListener('keydown', (ev) => {
                    if (ev.key === 'Enter') done(input.value.trim());
                    if (ev.key === 'Escape') done('');
                });
                doc.body.appendChild(overlay);
                input.focus();
            });
        },
        async promptSignIn() {
            const token = await this.askToken('Sign in for remote access', 'Paste the access token created on the machine running the app.');
            if (!token) return false;
            try {
                await this.signIn(token);
            } catch (e) {
                if (root.Toast) Toast.error((e && e.message) || 'Sign-in failed');
                return false;
            }
            if (root.Toast) Toast.success('Signed in for remote access');
            const app = root.App || (typeof App !== 'undefined' ? App : null);
            if (app && app.loadPage) app.loadPage(app.currentPage, false);
            return true;
        },

        // --- header ---------------------------------------------------------------------

        headerHtml() {
            const s = this.state;
            if (!s.enabled) return '';
            let html = '<span class="remote-badge" title="Remote access mode is on">Remote access on</span>';
            if (this.isRemotePage()) {
                html += this.signedIn()
                    ? '<button type="button" class="remote-link" data-act="remote-sign-out">Sign out</button>'
                    : '<button type="button" class="btn btn-sm remote-sign-in" data-act="remote-sign-in">Sign in for remote access</button>';
            }
            return html;
        },
        renderHeader() {
            const doc = root.document;
            const slot = doc && doc.getElementById && doc.getElementById('remote-access-slot');
            if (!slot) return;
            slot.innerHTML = this.headerHtml();
            const inBtn = slot.querySelector && slot.querySelector('[data-act="remote-sign-in"]');
            if (inBtn) inBtn.onclick = () => this.promptSignIn();
            const outBtn = slot.querySelector && slot.querySelector('[data-act="remote-sign-out"]');
            if (outBtn) outBtn.onclick = async () => { await this.signOut(); if (root.location && root.location.reload) root.location.reload(); };
        },

        // --- settings -------------------------------------------------------------------

        /** The Settings section body. `view` is GET /api/remote-access;
         *  `ctx` = {editing, token, error}. */
        settingsHtml(view, ctx) {
            const e = (s) => this.esc(s);
            const v = view || {};
            const c = ctx || {};
            const on = !!v.enabled;
            const readOnly = !v.local;
            const notNeeded = !readOnly && !!v.bound_loopback_only && !on;
            // One context line: by a network address, on a localhost-only
            // bind, or the normal case on this machine.
            const guide = readOnly || notNeeded ? '' : `<p class="remote-guide">${e(this.TURN_ON_HERE)}</p>`;
            const disabled = readOnly || notNeeded ? ' disabled' : '';
            // A signed-in remote browser may turn the mode off (only off).
            const remoteOff = readOnly && on && this.signedIn();
            const offDisabled = remoteOff ? '' : disabled;
            let html = `<div class="remote-control" role="group" aria-label="Remote access">` +
                `<button type="button" class="remote-seg${on ? '' : ' is-active'}" data-act="remote-off" aria-pressed="${on ? 'false' : 'true'}"${offDisabled}>Off</button>` +
                `<button type="button" class="remote-seg${on ? ' is-active' : ''}" data-act="remote-on" aria-pressed="${on ? 'true' : 'false'}"${disabled}>On</button>` +
                `</div>` + guide;
            if (readOnly) {
                return html + `<p class="remote-note">${e(this.CHANGE_ON_MACHINE)}</p>` +
                    (remoteOff ? `<p class="remote-note">Turning it off from here: ${e(this.OFF_SIGNS_OUT)}</p>` : '');
            }
            if (notNeeded) return html + `<p class="remote-note">${e(this.NOT_NEEDED)}</p>`;
            if (c.token) {
                html += `<div class="remote-token"><code class="remote-token-value">${e(c.token)}</code>` +
                    `<button type="button" class="btn btn-sm" data-act="remote-copy">Copy</button></div>` +
                    `<p class="remote-note">${e(this.TOKEN_ONCE)}</p>`;
            }
            if (c.error) html += `<p class="remote-error" role="alert">${e(c.error)}</p>`;
            if (!on && c.editing) {
                html += `<div class="remote-form">` +
                    `<label for="remote-allowed">Allowed address</label>` +
                    `<input id="remote-allowed" type="url" placeholder="https://sv.example.com" value="${e(v.allowed_address || '')}">` +
                    `<p class="remote-hint">The https address you open the app by, through your reverse proxy.</p>` +
                    `<label for="remote-proxy">Proxy address</label>` +
                    `<input id="remote-proxy" type="text" placeholder="10.0.0.2 or 10.0.0.0/24" value="${e((v.proxy_address || []).join(', '))}">` +
                    `<p class="remote-hint">The IP address or range your reverse proxy connects from.</p>` +
                    `<p class="remote-hint">${e(this.proxySameMachine(v.web_port))}</p>` +
                    `<p class="remote-hint">${e(this.PROXY_HOST)}</p>` +
                    `<div class="remote-actions"><button type="button" class="btn btn-sm" data-act="remote-cancel">Cancel</button>` +
                    `<button type="button" class="btn btn-primary btn-sm" data-act="remote-enable">Create the token and turn on</button></div></div>`;
            }
            if (on) {
                html += `<dl class="remote-facts"><dt>Allowed address</dt><dd>${e(v.allowed_address || '')}</dd>` +
                    `<dt>Proxy address</dt><dd>${e((v.proxy_address || []).join(', '))}</dd>` +
                    (v.token_rotated_at ? `<dt>Token created</dt><dd>${e(v.token_rotated_at)}</dd>` : '') + `</dl>` +
                    `<div class="remote-actions"><button type="button" class="btn btn-sm" data-act="remote-rotate">Rotate token</button></div>` +
                    `<p class="remote-note">Turning it off: ${e(this.OFF_SIGNS_OUT)}</p>`;
            }
            return html;
        },

        async renderSettings(container) {
            if (!container) return;
            const api = this._api();
            let view;
            try { view = await api.request('/api/remote-access'); } catch (_) {
                container.textContent = 'Could not read this setting.';
                return;
            }
            const ctx = { editing: false, token: '', error: '' };
            const paint = () => {
                container.innerHTML = this.settingsHtml(view, ctx);
                const q = (sel) => container.querySelector(sel);
                const change = async (body) => {
                    ctx.error = '';
                    try {
                        view = await api.changeRemoteAccess(body);
                        ctx.token = view.token || '';
                        ctx.editing = false;
                        this.state.enabled = !!view.enabled;
                        this.renderHeader();
                    } catch (e) {
                        ctx.error = (e && e.message) || 'Not saved';
                    }
                    paint();
                };
                const on = q('[data-act="remote-on"]');
                if (on) on.onclick = () => { if (!view.enabled) { ctx.editing = true; ctx.token = ''; paint(); } };
                const off = q('[data-act="remote-off"]');
                if (off) off.onclick = () => { if (view.enabled) change({ action: 'disable' }); };
                const cancel = q('[data-act="remote-cancel"]');
                if (cancel) cancel.onclick = () => { ctx.editing = false; paint(); };
                const enable = q('[data-act="remote-enable"]');
                if (enable) enable.onclick = () => change({ action: 'enable', allowed_address: q('#remote-allowed').value.trim(), proxy_address: q('#remote-proxy').value.trim() });
                const rotate = q('[data-act="remote-rotate"]');
                if (rotate) rotate.onclick = () => change({ action: 'rotate' });
                const copy = q('[data-act="remote-copy"]');
                if (copy) copy.onclick = () => {
                    try { root.navigator.clipboard.writeText(ctx.token); if (root.Toast) Toast.success('Copied'); } catch (_) { /* select it by hand */ }
                };
            };
            paint();
        },
    };

    root.RemoteAccess = RemoteAccess;
})(typeof window !== 'undefined' ? window : this);
