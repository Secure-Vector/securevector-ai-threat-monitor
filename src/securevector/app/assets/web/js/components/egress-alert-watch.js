/**
 * EgressAlertWatch: suspicious egress alerts, watched from the app shell.
 *
 * Security alerts must never be lost (owner, 6.1). The Guardian bubble is
 * one way to see them, but the Guardian can be hidden and a tab can sit in
 * the background, so this watcher runs on its own:
 *
 *  - polls GET /api/terminals/observability/egress-alerts every 20 s while
 *    the tab is visible and every 60 s while it is hidden (so a system
 *    notification still arrives), and on start and whenever the tab becomes
 *    visible again catches up from the last time it looked (beyond the 30
 *    minute window, at most 24 h);
 *  - keeps every alert not yet acknowledged and shows the count as a red
 *    badge on the Live grid tab and the Observability nav item;
 *  - sends a system notification per new alert when the user allowed it
 *    (asked once, with a plain prompt; if denied, the badge stays);
 *  - re-alerts the same (session, host) only when a stronger reason
 *    arrives (blocked, or right after a credential read).
 *
 * Opening the Live grid acknowledges what is pending. The "Alert me on
 * suspicious egress" setting (the Guardian panel) turns all of this off.
 */
(function (root) {
    const EgressAlertWatch = {
        POLL_MS: 20000,
        HIDDEN_POLL_MS: 60000,
        _lastPoll: 0,
        WINDOW_MS: 30 * 60 * 1000,
        MAX_SINCE_MS: 24 * 60 * 60 * 1000,
        MAX_PENDING: 100,
        KEY: 'sv-egress-watch',
        ASKED_KEY: 'sv-egress-notify-asked',
        _timer: null,
        _alerts: [],
        _busy: false,

        _ls() { try { return root.localStorage || null; } catch (_) { return null; } },

        enabled() {
            try { const ls = this._ls(); return !ls || ls.getItem('sv-guardian-egress-alerts') !== '0'; } catch (_) { return true; }
        },

        /** 2 for the reasons that escalate (blocked, after a credential
         *  read), 1 for the rest (new host, paste host, raw IP). */
        strength(a) {
            const r = (a && a.reasons) || [];
            return (r.includes('blocked') || r.includes('cred_then_net')) ? 2 : 1;
        },

        state() {
            try {
                const ls = this._ls();
                const st = ls ? JSON.parse(ls.getItem(this.KEY) || 'null') : null;
                if (st && typeof st === 'object') {
                    st.ack = st.ack && typeof st.ack === 'object' ? st.ack : {};
                    st.pending = Array.isArray(st.pending) ? st.pending : [];
                    return st;
                }
            } catch (_) { /* corrupted or private mode */ }
            return { ack: {}, pending: [], lastSeenAt: null };
        },

        save(st) {
            const keys = Object.keys(st.ack || {});
            if (keys.length > 500) keys.slice(0, keys.length - 500).forEach(k => delete st.ack[k]);
            st.pending = (st.pending || []).slice(-this.MAX_PENDING);
            try { const ls = this._ls(); if (ls) ls.setItem(this.KEY, JSON.stringify(st)); } catch (_) { /* full */ }
        },

        /** Pending alerts: shown, not yet acknowledged. */
        pending() { return this.state().pending; },
        count() { return this.enabled() ? this.pending().length : 0; },

        /** Everything the Guardian may speak about: pending first (caught up
         *  while hidden), then the latest poll, one entry per id. */
        latest() {
            const out = [];
            const at = new Map();
            this.pending().concat(this._alerts || []).forEach(a => {
                if (!a || !a.id) return;
                if (!at.has(a.id)) { at.set(a.id, out.length); out.push(a); }
                else if (this.strength(a) > this.strength(out[at.get(a.id)])) out[at.get(a.id)] = a;
            });
            return out;
        },

        /** The `since` for a poll: none while the last look is inside the
         *  30 minute window, else the last look, never more than 24 h back. */
        sinceFor(lastSeenAt, now) {
            const t = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
            if (!Number.isFinite(t) || now - t < this.WINDOW_MS - 60000) return null;
            return new Date(Math.max(t, now - this.MAX_SINCE_MS)).toISOString();
        },

        /** Take a poll's alerts: new ones (or ones with a stronger reason
         *  than what was acknowledged or pending) join the pending list and
         *  notify. Returns the new ones. */
        ingest(alerts, now) {
            const st = this.state();
            const fresh = [];
            const pend = new Map(st.pending.map((a, i) => [a.id, i]));
            (alerts || []).forEach(a => {
                if (!a || !a.id) return;
                const s = this.strength(a);
                const acked = Number(st.ack[a.id]) || 0;
                const pi = pend.has(a.id) ? pend.get(a.id) : -1;
                const had = pi >= 0 ? this.strength(st.pending[pi]) : 0;
                if (s <= Math.max(acked, had)) return;
                const keep = { id: a.id, session_id: a.session_id, host: a.host, reasons: a.reasons || [],
                    label: a.label || '', text: a.text || '', at: a.last_at || a.at || null };
                if (pi >= 0) st.pending[pi] = keep;
                else { pend.set(a.id, st.pending.length); st.pending.push(keep); }
                fresh.push(keep);
            });
            st.lastSeenAt = new Date(now == null ? Date.now() : now).toISOString();
            this._alerts = alerts || [];
            // Looking at the Live grid right now is seeing them.
            if (this._onGrid()) {
                st.pending.forEach(a => { st.ack[a.id] = Math.max(Number(st.ack[a.id]) || 0, this.strength(a)); });
                st.pending = [];
            }
            this.save(st);
            if (this.enabled()) fresh.forEach(a => this.notify(a));
            this.paint();
            try {
                if (root.dispatchEvent && root.CustomEvent) root.dispatchEvent(new root.CustomEvent('sv-egress-alerts', { detail: { fresh } }));
            } catch (_) { /* no events in this host */ }
            return fresh;
        },

        /** Acknowledge pending alerts (all, or the given ids). */
        acknowledge(ids) {
            const st = this.state();
            const only = ids ? new Set(ids) : null;
            st.pending = st.pending.filter(a => {
                if (only && !only.has(a.id)) return true;
                st.ack[a.id] = Math.max(Number(st.ack[a.id]) || 0, this.strength(a));
                return false;
            });
            this.save(st);
            this.paint();
        },

        _onGrid() {
            try {
                const doc = root.document;
                return !!(root.App && root.App.currentPage === 'live-grid' && doc && !doc.hidden);
            } catch (_) { return false; }
        },

        /** Whether a timer beat should poll: always when visible, once a
         *  minute when hidden. */
        due(hidden, now) {
            return !hidden || now - this._lastPoll >= this.HIDDEN_POLL_MS - 1000;
        },

        async tick() {
            this._lastPoll = Date.now();
            if (this._busy || !root.API || !root.API.getEgressAlerts) return null;
            if (!this.enabled()) { this.paint(); return null; }
            this._busy = true;
            try {
                const now = Date.now();
                const since = this.sinceFor(this.state().lastSeenAt, now);
                const body = await root.API.getEgressAlerts(since ? { since } : {}).catch(() => null);
                if (!body || !Array.isArray(body.alerts)) return null;
                return this.ingest(body.alerts, now);
            } finally {
                this._busy = false;
            }
        },

        // ------------------------------------------------- notifications

        _N() { return root.Notification || null; },

        notify(a) {
            const N = this._N();
            if (!N) return false;
            if (N.permission === 'granted') {
                try {
                    const n = new N('SecureVector security alert', { body: a.text || `Suspicious egress to ${a.host}`, tag: a.id });
                    n.onclick = () => { try { root.focus(); } catch (_) {} this.review(a); };
                    return true;
                } catch (_) { return false; }
            }
            if (N.permission === 'default') this.askOnce();
            return false;
        },

        _asked() { try { const ls = this._ls(); return !!(ls && ls.getItem(this.ASKED_KEY) === '1'); } catch (_) { return false; } },

        /** One plain prompt, the first time an alert arrives while
         *  notifications are undecided. Never asked again. */
        askOnce() {
            const N = this._N();
            const doc = root.document;
            if (!N || N.permission !== 'default' || this._asked() || !doc || !doc.body) return false;
            try { this._ls().setItem(this.ASKED_KEY, '1'); } catch (_) { /* private mode */ }
            const box = doc.createElement('div');
            box.className = 'sv-eaw-ask';
            box.setAttribute('role', 'dialog');
            box.setAttribute('aria-label', 'Security alert notifications');
            box.innerHTML = '<p>Get a desktop notification when an agent sends data somewhere suspicious? ' +
                'Alerts still show in the app and on the Live grid either way.</p>' +
                '<div class="sv-eaw-row"><button type="button" class="sv-eaw-yes">Allow notifications</button>' +
                '<button type="button" class="sv-eaw-no">Not now</button></div>';
            const close = () => { try { box.remove(); } catch (_) {} };
            box.querySelector('.sv-eaw-yes').addEventListener('click', () => {
                close();
                try { const p = N.requestPermission(); if (p && p.catch) p.catch(() => {}); } catch (_) { /* denied */ }
            });
            box.querySelector('.sv-eaw-no').addEventListener('click', close);
            doc.body.appendChild(box);
            return true;
        },

        review(a) {
            const sid = a && a.session_id;
            if (sid && root.LiveGridPage) root.LiveGridPage._pendingOpen = sid;
            if (root.Sidebar && root.Sidebar.navigate) root.Sidebar.navigate('live-grid');
            else if (root.App && root.App.loadPage) root.App.loadPage('live-grid');
        },

        // ------------------------------------------------------- badges

        TARGETS: ['.sv-obs-tab[data-p="live-grid"]', '.nav-item[data-page="agent-runs"]'],

        paint() {
            const doc = root.document;
            if (!doc || !doc.querySelectorAll) return;
            const n = this.count();
            const label = `${n} security alert${n === 1 ? '' : 's'} on the Live grid`;
            this.TARGETS.forEach(sel => {
                doc.querySelectorAll(sel).forEach(el => {
                    let b = el.querySelector('.sv-alert-count');
                    if (!n) { if (b) b.hidden = true; return; }
                    if (!b) {
                        b = doc.createElement('span');
                        b.className = 'nav-count sv-alert-count';
                        el.appendChild(b);
                    }
                    b.hidden = false;
                    if (b.textContent !== String(n)) b.textContent = String(n);
                    b.setAttribute('aria-label', label);
                    b.title = label;
                });
            });
        },

        _injectStyle() {
            const doc = root.document;
            if (!doc || doc.getElementById('sv-eaw-style')) return;
            const s = doc.createElement('style');
            s.id = 'sv-eaw-style';
            s.textContent = `
.sv-alert-count { background: color-mix(in srgb, var(--danger) 22%, transparent); color: color-mix(in srgb, var(--danger) 80%, var(--text-primary)); margin-left: 6px; }
.sv-obs-tab .sv-alert-count { margin-left: 6px; }
.sv-eaw-ask { position: fixed; left: 24px; bottom: 24px; z-index: 950; width: 340px; max-width: calc(100vw - 48px);
  background: var(--bg-card); border: 1px solid var(--danger); border-radius: 10px; padding: 12px 14px;
  color: var(--text-primary); font-size: 12.5px; line-height: 1.5; box-shadow: 0 10px 28px rgba(0,0,0,0.4); }
.sv-eaw-ask p { margin: 0 0 10px; }
.sv-eaw-row { display: flex; gap: 8px; }
.sv-eaw-row button { border-radius: 6px; padding: 4px 12px; font: 600 12px var(--font-body); cursor: pointer;
  border: 1px solid var(--border-default); background: var(--bg-secondary); color: var(--text-primary); }
.sv-eaw-row .sv-eaw-yes { border-color: var(--accent-primary); color: var(--accent-primary); }
.sv-eaw-row button:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 1px; }
`;
            doc.head.appendChild(s);
        },

        start() {
            if (this._timer) return;
            const doc = root.document;
            this._injectStyle();
            this.paint();
            this.tick();
            // Every 20 s while visible; while hidden, every 60 s.
            this._timer = setInterval(() => {
                if (!this.due(doc && doc.hidden, Date.now())) return;
                this.tick();
            }, this.POLL_MS);
            if (doc && doc.addEventListener) {
                // Coming back to a hidden tab: catch up at once.
                doc.addEventListener('visibilitychange', () => { if (!doc.hidden) this.tick(); });
            }
            // Pages rebuild their tabs and the nav; keep the badge on them.
            if (root.MutationObserver && doc && doc.body) {
                let queued = false;
                new root.MutationObserver(() => {
                    if (queued) return;
                    queued = true;
                    setTimeout(() => { queued = false; this.paint(); }, 250);
                }).observe(doc.body, { childList: true, subtree: true });
            }
        },
    };
    // Started by App.init (js/app.js), next to the Guardian.
    root.EgressAlertWatch = EgressAlertWatch;
})(typeof window !== 'undefined' ? window : globalThis);
