/**
 * Guardian Assistant — the floating Guardian Bot, and what it opens.
 *
 * Replaces the retired TryItChat floating panel (its launcher was removed
 * long ago; the panel was dead code). The Guardian Bot floats bottom-right —
 * bobbing, eyes wandering — and clicking it opens a compact triage panel.
 * Its main job is cost/token optimization; it also hands you the security
 * surfaces: threats, secret leaks, and blocked permission checks.
 *
 * Not a chat. Every row is real data from existing endpoints with a
 * click-through to the page that owns it, all fetched lazily on open and
 * degrading to quiet omission when an endpoint is unavailable. Dollar
 * figures stay labelled estimates; counts are facts.
 *
 * Sentinel: the bot also watches, quietly. A slow poll over the same
 * endpoints raises a speech bubble when something NEW happens (a threat, a
 * secret redaction, a blocked tool call) and recaps a session shortly after
 * it ends. Every utterance is a fixed template filled with endpoint
 * numbers: no generated text, so the bot cannot say anything the data does
 * not. Strict discipline: one bubble at a time, per-category cooldowns, a
 * mute switch, and nothing at all on the first tick (baselines only).
 */

const GuardianAssistant = {
    _open: false,
    _panel: null,
    _fab: null,

    _bot3d: null,

    // sentinel state
    _sentinelTimer: null,
    _bubbleEl: null,
    _bubbleHideTimer: null,
    SENTINEL_MS: 20000,          // slow lane: this is ambient, not a pager
    BUBBLE_COOLDOWN_MS: 10 * 60 * 1000,   // per category
    RECAP_MIN_QUIET_MS: 10 * 60 * 1000,   // session counts as ended
    RECAP_MAX_AGE_MS: 60 * 60 * 1000,     // too old to mention
    RECAP_MIN_CONTEXT: 60000,
    CONTEXT_ALERT_TOKENS: 150000,        // live session re-sending this much per turn
    CONTEXT_REALERT_GROWTH: 1.5,         // speak again only after 1.5x growth
    BUDGET_ALERT_SHARE: 0.8,             // spoken when a user-set daily budget is 80% used
    LIVE_MS: 45000,                      // live advisor poll cadence
    LIVE_BEEP_COOLDOWN_MS: 10 * 60 * 1000, // audible cues stay rare
    _liveTimer: null,
    _liveData: null,
    WANDER_MS: 26000,                    // one gentle relocation every ~26s when free
    GLIDE_MS: 5000,                      // how long a relocation glide takes
    GLANCE_MS: 15000,                    // idle glance every ~15s (jittered)

    _hidden() {
        try { return localStorage.getItem('sv-guardian-hidden') === '1'; } catch (_) { return false; }
    },
    setHidden(on) {
        try { localStorage.setItem('sv-guardian-hidden', on ? '1' : '0'); } catch (_) { /* private mode */ }
        if (on) {
            this.close();
            this._hideBubble();
            if (this._sentinelTimer) { clearInterval(this._sentinelTimer); this._sentinelTimer = null; }
            if (this._wanderTimer) { clearInterval(this._wanderTimer); this._wanderTimer = null; }
            if (this._ghostTimer) { clearInterval(this._ghostTimer); this._ghostTimer = null; }
            if (this._glanceTimer) { clearTimeout(this._glanceTimer); this._glanceTimer = null; }
            if (this._bot3d) { try { this._bot3d.dispose(); } catch (_) {} this._bot3d = null; }
            if (this._fab) { this._fab.remove(); this._fab = null; }
            if (this._panel) { this._panel.remove(); this._panel = null; }
            document.body.classList.remove('sv-ga-on');
        } else if (!this._fab) {
            this.mount();
        }
    },

    mount() {
        if (this._fab || !window.GuardianBot || this._hidden()) return;
        this._injectStyle();
        const fab = document.createElement('button');
        fab.type = 'button';
        fab.className = 'sv-ga-fab';
        fab.setAttribute('aria-label', 'Open Guardian');
        // Hero renderer when the machine can carry it: the real-3D Guardian
        // (Three.js + GSAP, vendored) with pointer-tracked eyes and a wave.
        // The SVG character remains the fallback — same figure, lighter.
        if (window.Guardian3D && Guardian3D.available()) {
            // 104, up from 94: at 94 the bot read as an icon, not a character.
            try { this._bot3d = Guardian3D.mount(fab, { size: 104 }); } catch (_) { this._bot3d = null; }
        }
        if (!this._bot3d) fab.appendChild(GuardianBot.el({ state: 'idle', size: 84, label: '' }));
        fab.addEventListener('click', () => {
            if (this._justDragged) { this._justDragged = false; return; }
            if (this._bot3d && !this._open) this._bot3d.wave(); // greets while the panel opens
            this.toggle();
        });
        document.body.appendChild(fab);
        document.body.classList.add('sv-ga-on'); // page bottom clears the FAB
        this._fab = fab;
        this._initMoves(fab);
        // First paint: content exists now, so the fade starts out honest
        // instead of sitting opaque over a button until the first scroll.
        setTimeout(() => this._ghostCheck(), 1200);
        this._sentinelStart();
        this._liveStart();
        this._mountedAt = Date.now();
        this._lastEventAt = Date.now();
        this._thinkStart();
        this._orientStart();
        this._wanderStart();
        this._glanceStart();
        // content scrolls under a stationary bot too: keep the ghost fade
        // honest on scroll, throttled to animation frames
        document.addEventListener('scroll', () => {
            if (this._ghostRaf) return;
            this._ghostRaf = requestAnimationFrame(() => {
                this._ghostRaf = null;
                this._ghostCheck();
            });
        }, { capture: true, passive: true });
    },

    // ---------------- placement: drag to pin, wander when free ----------------

    _pinned() {
        try { return localStorage.getItem('sv-guardian-pin') === '1'; } catch (_) { return false; }
    },
    _setPinned(on) {
        try { localStorage.setItem('sv-guardian-pin', on ? '1' : '0'); } catch (_) { /* private mode */ }
    },

    _clampXY(x, y) {
        const w = this._fab ? this._fab.offsetWidth : 100;
        const h = this._fab ? this._fab.offsetHeight : 100;
        return [
            Math.max(8, Math.min(x, window.innerWidth - w - 8)),
            Math.max(8, Math.min(y, window.innerHeight - h - 8)),
        ];
    },

    _moveTo(x, y, glide) {
        const fab = this._fab;
        if (!fab) return;
        [x, y] = this._clampXY(x, y);
        fab.style.transition = glide
            ? `left ${this.GLIDE_MS}ms ease-in-out, top ${this.GLIDE_MS}ms ease-in-out, opacity 300ms ease`
            : 'opacity 300ms ease';
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
        fab.style.left = x + 'px';
        fab.style.top = y + 'px';
        // while gliding (and after landing) fade over text so it stays readable
        clearInterval(this._ghostTimer);
        this._ghostTimer = setInterval(() => this._ghostCheck(), 400);
        setTimeout(() => { clearInterval(this._ghostTimer); this._ghostCheck(); },
            (glide ? this.GLIDE_MS : 0) + 450);
    },

    /** The bot goes see-through only when it actually covers something
     *  readable: the page stays legible, the Guardian stays present. Hover
     *  always restores it. */
    _ghostCheck() {
        const fab = this._fab;
        if (!fab || this._dragging) return;
        fab.classList.toggle('sv-ga-ghost', !!this._coversInk(fab.getBoundingClientRect()));
    },

    /** True when rendered text or a control actually overlaps `rect`.
     *  Text is measured from the text nodes' own client rects, not from an
     *  ancestor's innerText: a card reports every descendant's text, so the
     *  old check faded the bot to nothing while it sat in empty padding. */
    _coversInk(rect, tally) {
        let hits = 0;
        const skip = (el) => (this._fab && this._fab.contains(el))
            || (this._panel && this._panel.contains(el))
            || (this._bubbleEl && this._bubbleEl.contains(el));
        const hit = (r) => r.width > 0.5 && r.height > 0.5
            && r.left < rect.right && r.right > rect.left
            && r.top < rect.bottom && r.bottom > rect.top;
        const seeds = new Set();
        for (const cx of [0.2, 0.5, 0.8]) {
            for (const cy of [0.2, 0.5, 0.8]) {
                const els = document.elementsFromPoint(
                    rect.left + rect.width * cx, rect.top + rect.height * cy) || [];
                for (const el of els) { if (!skip(el)) { seeds.add(el); break; } }
            }
        }
        // Measured miss: the app's toggles are `label.toggle > span.toggle-slider`
        // with a zero-size input inside, so a switch counted as empty space and
        // the bot parked on top of the Guardian ML control. A control is ink
        // whether or not it happens to contain text.
        const INK = 'button, a, input, select, textarea, img, svg, canvas, label,'
            + ' [role="button"], [role="switch"], [role="checkbox"], [role="tab"], [role="link"]';
        // A subtree that does not reach `rect` cannot draw inside it, so it is
        // rejected whole. Without this a seed high in the tree spends the
        // budget on off-screen nodes and misses the text actually under the bot.
        const filter = {
            acceptNode(node) {
                if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
                if (skip(node)) return NodeFilter.FILTER_REJECT;
                return hit(node.getBoundingClientRect())
                    ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
            },
        };
        let budget = 900; // shared across seeds: this runs on a timer
        for (const seed of seeds) {
            const walker = document.createTreeWalker(
                seed, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, filter);
            let n = seed;
            while (n && budget-- > 0) {
                if (n.nodeType === Node.TEXT_NODE) {
                    if ((n.nodeValue || '').trim()) {
                        const range = document.createRange();
                        range.selectNodeContents(n);
                        for (const r of range.getClientRects()) {
                            if (hit(r)) { if (!tally) return 1; hits += 1; break; }
                        }
                    }
                } else if (n !== seed && !skip(n) && n.matches && n.matches(INK)
                    && hit(n.getBoundingClientRect())) {
                    if (!tally) return 1;
                    hits += 1;
                }
                n = walker.nextNode();
            }
        }
        return hits;
    },

    /** How much ink a footprint would cover, as a count of overlapping text
     *  runs and controls. A boolean is too blunt for choosing between spots:
     *  on a dense page every candidate covers something, and the old
     *  all-or-nothing test made the bot give up and stay on the worst one. */
    _inkCount(rect) { return this._coversInk(rect, true); },

    /** A sentinel that never moves reads as a dead image, so the bot takes
     *  one small look around on a jittered ~15s beat. Nothing louder: the
     *  wave and the bubble stay reserved for real events. */
    _glanceStart() {
        clearTimeout(this._glanceTimer);
        const reduced = window.matchMedia
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduced) return;
        const next = () => {
            const jitter = this.GLANCE_MS * (0.7 + Math.random() * 0.7);
            this._glanceTimer = setTimeout(() => {
                if (!this._open && !this._dragging && !document.hidden
                    && this._bot3d && this._bot3d.glance) this._bot3d.glance();
                next();
            }, jitter);
        };
        next();
    },

    /** The Guardian used to relocate to a random ink-free point every 26s.
     *  Measured on the real dashboard, that was the single worst thing about
     *  the app's appearance: it parked on the banner copy and faded to a grey
     *  shape that reads as a rendering fault, and mid-column it read as an
     *  asset dropped in the wrong place. Chasing empty space with a smarter
     *  picker does not work either, because a dense page HAS no empty space:
     *  every candidate anchor here covers something. So it docks, like every
     *  comparable assistant, and the page already reserves the corner for it
     *  (`sv-ga-on`). Drag still pins it wherever the user prefers.
     *  What remains on this timer is only getting off text. */
    _wanderStart() {
        clearInterval(this._wanderTimer);
        const reduced = window.matchMedia
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (reduced) return; // a bot that teleports is worse than one that sits
        this._wanderTimer = setInterval(() => {
            if (this._dragging || this._open || document.hidden) return;
            if (this._bubbleEl && this._bubbleEl.isConnected) return;
            // The bot no longer relocates on its own. It docks, keeps its fade
            // honest as the page changes under it, and the only automatic
            // movement left is getting a user-pinned bot off text.
            this._ghostCheck();
            this._unstick();
        }, this.WANDER_MS);
    },

    /** Prefer whitespace: sample a few random spots and take the first one
     *  whose center has no text or control under it, so the bot lands in
     *  margins instead of on the page. Falls back to the last sample (the
     *  ghost fade still covers that case). */
    /** Move a bot that is standing on text to the nearest clear anchor, and
     *  remember the corrected spot. Applies to pinned bots too: the pin is a
     *  preference about where the user wants it, not a licence to obscure the
     *  page. Does nothing when the current spot is already clear, so a
     *  deliberate placement that works is never overridden. */
    _unstick() {
        const fab = this._fab;
        if (!fab || this._dragging || this._open) return;
        // Docked bots stay docked. Home is a deliberate corner, and content
        // scrolling under it is expected: that is what the fade is for.
        // Only a user-chosen pin can end up somewhere genuinely wrong.
        if (!this._pinned()) return;
        const r = fab.getBoundingClientRect();
        const here = this._inkCount(r);
        if (!here) return;
        const w = fab.offsetWidth, h = fab.offsetHeight;
        const dist = ([x, y]) => Math.hypot(x - r.left, y - r.top);
        // Least ink wins, nearest breaks the tie. Requiring a perfectly clear
        // anchor was measured to fail on the dashboard: every edge anchor
        // covers something there, so the bot gave up and stayed on the banner.
        const ranked = this._anchors(w, h)
            .map((a) => ({ a, ink: this._inkCount(new DOMRect(a[0], a[1], w, h)) }))
            .sort((p, q) => (p.ink - q.ink) || (dist(p.a) - dist(q.a)));
        const best = ranked[0];
        if (!best || best.ink >= here) return;   // nothing better: keep the pin
        const [x, y] = best.a;
        this._moveTo(x, y, true);
        if (this._pinned()) {
            try {
                localStorage.setItem('sv-guardian-pos', JSON.stringify({ x, y }));
            } catch (_) { /* private mode: the correction is per-session */ }
        }
    },

    /** Where the Guardian is allowed to stand: edge anchors only, never the
     *  middle of the content column. Two failures this replaces, both seen on
     *  screen: parked on the banner copy it faded to a grey blob that reads as
     *  a smudge rather than a character, and standing mid-page on the
     *  Optimizer it read as an asset dropped in the wrong place. A character
     *  belongs at the edge of a document or nowhere. */
    _anchors(w, h) {
        const M = 16;
        const W = window.innerWidth, H = window.innerHeight;
        const sb = document.querySelector('.sidebar');
        const left = sb ? Math.max(M, Math.round(sb.getBoundingClientRect().right) + M) : M;
        return [
            [W - w - M, H - h - M],                        // home: bottom right
            [W - w - M, Math.round(H * 0.60)],             // right edge, lower
            [W - w - M, Math.round(H * 0.28)],             // right edge, upper
            [left, H - h - M],                             // bottom left of content
            [Math.round((W + left - w) / 2), H - h - M],   // bottom centre
        ].map(([x, y]) => this._clampXY(x, y));
    },

    _initMoves(fab) {
        // restore a saved spot (a drag pins the bot where it was dropped)
        try {
            const saved = JSON.parse(localStorage.getItem('sv-guardian-pos') || 'null');
            if (saved && this._pinned()) {
                this._moveTo(saved.x, saved.y, false);
                // A pin means "roughly here", not "on top of this paragraph
                // forever". Pages differ, and a spot that was empty when it
                // was dropped is body copy on the next page, where the bot
                // fades to a grey shape that reads as a rendering fault. Once
                // per mount, if the pinned spot is covering text, step to the
                // nearest clear anchor and keep the pin there.
                // Not requestAnimationFrame: the bot mounts before the page
                // paints, so a frame later there is no ink to detect yet and
                // the check passes on an empty screen. Wait for first paint,
                // or a bad pin sits there until the slow wander beat.
                setTimeout(() => this._unstick(), 1200);
            }
        } catch (_) { /* corrupt state: default corner */ }

        let sx = 0, sy = 0, ox = 0, oy = 0, armed = false;
        fab.addEventListener('pointerdown', (ev) => {
            if (ev.button !== 0) return;
            const r = fab.getBoundingClientRect();
            sx = ev.clientX; sy = ev.clientY; ox = r.left; oy = r.top;
            this._dragging = false;
            armed = true;
            try { fab.setPointerCapture(ev.pointerId); } catch (_) { /* capture is an assist, not a requirement */ }
        });
        fab.addEventListener('pointermove', (ev) => {
            if (!armed) return;
            const dx = ev.clientX - sx, dy = ev.clientY - sy;
            if (!this._dragging && Math.hypot(dx, dy) < 6) return;
            this._dragging = true;
            fab.classList.add('sv-ga-drag');
            fab.classList.remove('sv-ga-ghost');
            fab.style.transition = 'none';
            const [x, y] = this._clampXY(ox + dx, oy + dy);
            fab.style.right = 'auto'; fab.style.bottom = 'auto';
            fab.style.left = x + 'px'; fab.style.top = y + 'px';
        });
        fab.addEventListener('pointerup', (ev) => {
            armed = false;
            try {
                if (fab.hasPointerCapture && fab.hasPointerCapture(ev.pointerId)) {
                    fab.releasePointerCapture(ev.pointerId);
                }
            } catch (_) { /* no capture to release */ }
            if (!this._dragging) return;
            this._dragging = false;
            this._justDragged = true; // swallow the click this drop fires
            fab.classList.remove('sv-ga-drag');
            const r = fab.getBoundingClientRect();
            this._setPinned(true); // dropped means "stay here"
            try {
                localStorage.setItem('sv-guardian-pos',
                    JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
            } catch (_) { /* private mode */ }
            this._ghostCheck();
        });
        window.addEventListener('resize', () => {
            const f = this._fab;
            if (!f || !f.style.left) return;
            this._moveTo(parseFloat(f.style.left) || 0, parseFloat(f.style.top) || 0, false);
        });
    },

    /** Bubble and panel follow the bot wherever it is on screen. */
    _placeNear(el) {
        const fab = this._fab;
        if (!fab || !el) return;
        const r = fab.getBoundingClientRect();
        const w = el.offsetWidth || 320, h = el.offsetHeight || 160;
        let left = r.left + r.width / 2 - w / 2;
        left = Math.max(12, Math.min(left, window.innerWidth - w - 12));
        let top = r.top - h - 12;
        if (top < 12) top = Math.min(window.innerHeight - h - 12, r.bottom + 12);
        el.style.left = left + 'px';
        el.style.top = Math.max(12, top) + 'px';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
    },

    toggle() {
        if (this._open) return this.close();
        this.open();
    },

    close() {
        this._open = false;
        if (this._panel) this._panel.classList.remove('open');
        if (this._fab) this._fab.classList.remove('sv-ga-away');
    },

    async open() {
        this._open = true;
        if (!this._panel) this._build();
        this._panel.classList.add('open');
        if (this._fab) this._fab.classList.add('sv-ga-away');
        // Default behaviour is to follow the bot. Once the user has dragged
        // the panel somewhere, that wins: _placeNear would otherwise snap it
        // straight back to the bot on every open and the drag would look
        // like it had not worked.
        if (!this._panelRestore()) this._placeNear(this._panel);
        // greeting: a quick wave from the panel bot, then back to idle
        const headBot = this._panel.querySelector('.sv-ga-headbot .sv-gbot');
        if (headBot && window.GuardianBot) {
            GuardianBot.set(headBot, 'ok');
            setTimeout(() => GuardianBot.set(headBot, 'idle'), 2600);
        }
        await this._fill();
    },

    _build() {
        const panel = document.createElement('div');
        panel.className = 'sv-ga-panel';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Guardian');
        panel.innerHTML =
            '<div class="sv-ga-head">' +
            '<span class="sv-ga-headbot"></span>' +
            '<div><div class="sv-ga-title">Guardian</div>' +
            '<div class="sv-ga-tag">Cost first. Threats always.</div></div>' +
            '<button type="button" class="sv-ga-close" aria-label="Close">&times;</button>' +
            '</div>' +
            '<div class="sv-ga-body"><div class="sv-ga-loading">Looking around…</div></div>';
        panel.querySelector('.sv-ga-headbot')
            .appendChild(GuardianBot.el({ state: 'idle', size: 50, label: '' }));
        panel.querySelector('.sv-ga-close').addEventListener('click', () => this.close());
        document.body.appendChild(panel);
        this._panel = panel;
        this._initPanelMoves(panel);
    },

    /** The panel drags by its header, the way the bot drags by itself. It
     *  opens anchored above the Guardian; once moved, it opens where the user
     *  left it. Header only, deliberately: the body scrolls and is full of
     *  click targets, and the close control has to stay a click.
     *  Nothing here is pinned-vs-free like the bot. A panel the user put
     *  somewhere is simply where the panel goes. */
    _initPanelMoves(panel) {
        const head = panel.querySelector('.sv-ga-head');
        if (!head) return;
        this._panelPlace = (x, y) => {
            const w = panel.offsetWidth, h = panel.offsetHeight;
            const cx = Math.max(8, Math.min(x, window.innerWidth - w - 8));
            const cy = Math.max(8, Math.min(y, window.innerHeight - h - 8));
            panel.style.right = 'auto'; panel.style.bottom = 'auto';
            panel.style.left = cx + 'px'; panel.style.top = cy + 'px';
        };
        let sx = 0, sy = 0, ox = 0, oy = 0, armed = false, moved = false;
        head.addEventListener('pointerdown', (ev) => {
            if (ev.button !== 0 || (ev.target.closest && ev.target.closest('.sv-ga-close'))) return;
            const r = panel.getBoundingClientRect();
            sx = ev.clientX; sy = ev.clientY; ox = r.left; oy = r.top;
            armed = true; moved = false;
            try { head.setPointerCapture(ev.pointerId); } catch (_) { /* an assist, not a requirement */ }
        });
        head.addEventListener('pointermove', (ev) => {
            if (!armed) return;
            const dx = ev.clientX - sx, dy = ev.clientY - sy;
            if (!moved && Math.hypot(dx, dy) < 6) return;   // a click is not a drag
            moved = true;
            panel.classList.add('sv-ga-drag');
            this._panelPlace(ox + dx, oy + dy);
        });
        const end = (ev) => {
            if (!armed) return;
            armed = false;
            try {
                if (head.hasPointerCapture && head.hasPointerCapture(ev.pointerId)) {
                    head.releasePointerCapture(ev.pointerId);
                }
            } catch (_) { /* no capture to release */ }
            if (!moved) return;
            panel.classList.remove('sv-ga-drag');
            const r = panel.getBoundingClientRect();
            try {
                localStorage.setItem('sv-guardian-panel-pos',
                    JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) }));
            } catch (_) { /* private mode: this session only */ }
        };
        head.addEventListener('pointerup', end);
        head.addEventListener('pointercancel', end);
        // A window resize must not strand the panel off-screen: re-clamp
        // whatever position it is holding.
        window.addEventListener('resize', () => {
            if (!panel.style.left) return;
            this._panelPlace(parseFloat(panel.style.left) || 0, parseFloat(panel.style.top) || 0);
        });
    },

    /** Reopen where the user left it, clamped to the viewport it is opening
     *  into. A saved spot from a wider window must not put the panel, and its
     *  close button, out of reach. */
    _panelRestore() {
        if (!this._panel || !this._panelPlace) return false;
        try {
            const p = JSON.parse(localStorage.getItem('sv-guardian-panel-pos') || 'null');
            if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
                this._panelPlace(p.x, p.y);
                return true;
            }
        } catch (_) { /* corrupt state: fall back to following the bot */ }
        return false;
    },

    _row({ label, value, sub, page, tab, primary }) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'sv-ga-row' + (primary ? ' primary' : '');
        row.innerHTML =
            '<div class="sv-ga-row-text"><b></b><span></span></div>' +
            '<span class="sv-ga-row-val"></span>' +
            '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
            'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
        row.querySelector('b').textContent = label;
        row.querySelector('.sv-ga-row-text span').textContent = sub || '';
        row.querySelector('.sv-ga-row-val').textContent = value || '';
        row.addEventListener('click', () => {
            this.close();
            if (tab && window.CostsPage) CostsPage._pendingTab = tab;
            if (window.Sidebar && Sidebar.navigate) Sidebar.navigate(page);
        });
        return row;
    },

    async _fill() {
        const body = this._panel.querySelector('.sv-ga-body');
        const fmtTok = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B'
            : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
            : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(Math.round(n || 0));

        const [optStatus, blocked, analytics] = await Promise.all([
            API.getOptimizerStatus(),
            API.getBlockedLedger({ window_days: 7 }).catch(() => null),
            API.getThreatAnalytics().catch(() => null),
        ]);
        let rep = null;
        if (optStatus && optStatus.has_report) rep = await API.getOptimizerReport();
        // the FAB mirrors what the app is doing: scanning -> scan state
        const scanning = !!(optStatus && optStatus.running);
        if (this._bot3d) {
            this._bot3d.setState(scanning ? 'scan' : 'idle');
        } else if (this._fab && window.GuardianBot) {
            const fabBot = this._fab.querySelector('.sv-gbot');
            if (fabBot) GuardianBot.set(fabBot, scanning ? 'scan' : 'idle');
        }

        body.textContent = '';

        // --- live sessions first: what is happening right now ---
        try {
            const live = this._liveData || await API.getOptimizerLive();
            if (live && live.enabled !== false && (live.sessions || []).length) {
                this._liveData = live;
                this._liveSection(body, live);
            }
        } catch (_) { /* live endpoint hiccup: sections below still render */ }

        // --- the main job: cost / token optimization ---
        const sec1 = document.createElement('div');
        sec1.className = 'sv-ga-sec';
        sec1.textContent = 'Optimize';
        body.appendChild(sec1);
        if (rep && rep.observed) {
            const mode = optStatus.prefs
                && (optStatus.prefs.billing_mode || optStatus.prefs.billing_mode_derived);
            const lead = mode === 'api' && rep.observed.est_cost_usd != null
                ? `≈$${Math.round(rep.observed.est_cost_usd).toLocaleString()} → ≈$${Math.round(((rep.modeled_lossless || rep.modeled)).est_cost_usd).toLocaleString()} est`
                : `${fmtTok(rep.observed.total_tokens)} → ${fmtTok((rep.modeled_lossless || rep.modeled).total_tokens)} tok`;
            body.appendChild(this._row({
                label: 'Cost / Token Optimizer', primary: true,
                sub: `${(rep.findings || []).length} findings · last ${rep.window_days} days · modeled estimate`,
                value: lead, page: 'costs', tab: 'optimizer',
            }));
        } else {
            body.appendChild(this._row({
                label: 'Cost / Token Optimizer', primary: true,
                sub: 'Run your first scan: see why your sessions cost what they did.',
                value: '', page: 'costs', tab: 'optimizer',
            }));
        }

        // --- and the watch: threats, secrets, blocked permissions ---
        const sec2 = document.createElement('div');
        sec2.className = 'sv-ga-sec';
        sec2.textContent = 'Watch';
        body.appendChild(sec2);
        const totals = (analytics && (analytics.totals || analytics)) || {};
        const threatCount = totals.threats_detected ?? totals.total_threats ?? null;
        body.appendChild(this._row({
            label: 'Threats',
            sub: 'Detections from rules and Guardian ML.',
            value: threatCount != null ? String(threatCount) : '', page: 'threats',
        }));
        body.appendChild(this._row({
            label: 'Secret leaks',
            sub: 'Credentials and PII caught mid-flight.',
            value: '', page: 'redactions',
        }));
        body.appendChild(this._row({
            label: 'Blocked permission checks',
            sub: 'Tool calls your policies stopped.',
            value: blocked && blocked.summary && blocked.summary.blocked_total != null
                ? String(blocked.summary.blocked_total)
                : (blocked && blocked.blocked_total != null ? String(blocked.blocked_total) : ''),
            page: 'blocked-ledger',
        }));

        // the mute switch lives where the bot lives
        const quietRow = document.createElement('button');
        quietRow.type = 'button';
        quietRow.className = 'sv-ga-quiet';
        const paintQuiet = () => {
            quietRow.textContent = this._quiet()
                ? 'Announcements are off. Turn them back on'
                : 'Announcements are on: new threats, secret catches, blocks, session recaps. Mute';
        };
        paintQuiet();
        quietRow.addEventListener('click', () => { this._setQuiet(!this._quiet()); paintQuiet(); });
        body.appendChild(quietRow);

        const pinRow = document.createElement('button');
        pinRow.type = 'button';
        pinRow.className = 'sv-ga-quiet';
        const paintPin = () => {
            pinRow.textContent = this._pinned()
                ? 'Pinned where you dropped me. Let me wander again'
                : 'Wandering is on: drag me anywhere to pin me there';
        };
        paintPin();
        pinRow.addEventListener('click', () => {
            this._setPinned(!this._pinned());
            paintPin();
        });
        body.appendChild(pinRow);

        const hideRow = document.createElement('button');
        hideRow.type = 'button';
        hideRow.className = 'sv-ga-quiet';
        hideRow.textContent = 'Hide the Guardian. Bring it back anytime under Help & Settings';
        hideRow.addEventListener('click', () => this.setHidden(true));
        body.appendChild(hideRow);
    },

    // ---------------- sentinel: watch quietly, speak rarely ----------------

    _quiet() {
        try { return localStorage.getItem('sv-guardian-quiet') === '1'; } catch (_) { return false; }
    },
    _setQuiet(on) {
        try { localStorage.setItem('sv-guardian-quiet', on ? '1' : '0'); } catch (_) { /* private mode */ }
        if (on) this._hideBubble();
    },

    _sentinelState() {
        try {
            const raw = localStorage.getItem('sv-ga-sentinel');
            const st = raw ? JSON.parse(raw) : null;
            if (st && typeof st === 'object') return st;
        } catch (_) { /* corrupted or private mode */ }
        return { baselined: false, totals: {}, recapped: {}, lastAt: {} };
    },
    _sentinelSave(st) {
        // recapped can only grow; keep the newest 40 session ids
        const keys = Object.keys(st.recapped || {});
        if (keys.length > 40) keys.slice(0, keys.length - 40).forEach(k => delete st.recapped[k]);
        try { localStorage.setItem('sv-ga-sentinel', JSON.stringify(st)); } catch (_) { /* full */ }
    },

    _sentinelStart() {
        if (this._sentinelTimer) return;
        this._sentinelTimer = setInterval(() => {
            if (document.hidden || this._quiet()) return;
            this._sentinelTick().catch(() => { /* endpoint hiccup: next tick */ });
        }, this.SENTINEL_MS);
    },

    async _sentinelTick() {
        const st = this._sentinelState();
        const [threats, red, blocked, act] = await Promise.all([
            API.request('/api/threat-intel?page=1&page_size=1').catch(() => null),
            API.getRedactions(1).catch(() => null),
            API.getBlockedLedger({ window_days: 1 }).catch(() => null),
            API.getOptimizerSessions(1).catch(() => null),
        ]);
        const totals = {
            threats: threats && threats.total != null ? threats.total : null,
            redactions: red && red.summary && red.summary.total != null ? red.summary.total : null,
            blocked: blocked && blocked.summary && blocked.summary.blocked_total != null
                ? blocked.summary.blocked_total : null,
        };

        // Agent numbering also works when the live advisor is switched off:
        // this tick already has the activity list in hand.
        if (act && act.sessions) {
            this._activityIds = act.sessions.filter(a => a.active).map(a => a.session_id);
        }

        if (!st.baselined) {
            // first sight of the world: remember it, say nothing
            st.baselined = true;
            st.totals = totals;
            if (act && act.sessions) act.sessions.forEach(x => { st.recapped[x.session_id] = true; });
            this._sentinelSave(st);
            return;
        }

        // events: counts are facts; one bubble per tick, per-category cooldown
        const now = Date.now();
        const ready = (cat) => (now - (st.lastAt[cat] || 0)) > this.BUBBLE_COOLDOWN_MS;
        const bump = (cat) => { st.lastAt[cat] = now; };

        const grew = (k) => totals[k] != null && st.totals[k] != null && totals[k] > st.totals[k];
        let spoke = false;
        if (grew('threats') && ready('threats')) {
            const n = totals.threats - st.totals.threats;
            spoke = this._speak({
                text: n === 1 ? 'I flagged a new threat just now.'
                    : `I flagged ${n} new threats just now.`,
                cta: 'See it', page: 'threats', mood: 'alert',
            });
            if (spoke) bump('threats');
        } else if (grew('redactions') && ready('redactions')) {
            const n = totals.redactions - st.totals.redactions;
            spoke = this._speak({
                text: n === 1 ? 'I caught a secret before it left this machine.'
                    : `I caught ${n} secrets before they left this machine.`,
                cta: 'See what', page: 'redactions', mood: 'alert',
            });
            if (spoke) bump('redactions');
        } else if (grew('blocked') && ready('blocked')) {
            const n = totals.blocked - st.totals.blocked;
            spoke = this._speak({
                text: n === 1 ? 'I blocked a tool call your policy forbids.'
                    : `I blocked ${n} tool calls your policy forbids.`,
                cta: 'See them', page: 'blocked-ledger', mood: 'alert',
            });
            if (spoke) bump('blocked');
        }

        // live context too high: the one alert that can still save THIS run
        if (!spoke && act && act.sessions && ready('context')) {
            const liveBig = act.sessions.find(x => x.active
                && x.context_tokens_now != null
                && x.context_tokens_now >= this.CONTEXT_ALERT_TOKENS);
            if (liveBig) {
                const prev = (st.ctxWarned || {})[liveBig.session_id] || 0;
                if (liveBig.context_tokens_now >= prev * this.CONTEXT_REALERT_GROWTH) {
                    const kTok = Math.round(liveBig.context_tokens_now / 1000);
                    spoke = this._speak({
                        text: `${this._liveWho(liveBig).title} is re-sending about ${kTok}K tokens of context with every turn. Compacting it now shrinks every turn that follows.`,
                        cta: 'See the session', page: 'costs', tab: 'optimizer', mood: 'concerned',
                    });
                    if (spoke) {
                        bump('context');
                        st.ctxWarned = st.ctxWarned || {};
                        st.ctxWarned[liveBig.session_id] = liveBig.context_tokens_now;
                    }
                }
            }
        }

        // metered spend nearing the budget the user set themselves: a fact,
        // not a guess. No budget configured means no opinion on "too high".
        if (!spoke && ready('budget')) {
            const bud = await API.request('/api/costs/budget').catch(() => null);
            const limit = bud && bud.daily_budget_usd;
            const spent = bud && (bud.today_spend_usd != null ? bud.today_spend_usd : bud.spent_today_usd);
            if (limit > 0 && spent != null && spent / limit >= this.BUDGET_ALERT_SHARE) {
                const pct = Math.round((spent / limit) * 100);
                spoke = this._speak({
                    text: `Today's metered spend is at ${pct}% of the daily budget you set.`,
                    cta: 'See the spend', page: 'costs', tab: 'overview', mood: 'concerned',
                });
                if (spoke) bump('budget');
            }
        }

        // session-end recap: quiet for 10+ minutes, younger than an hour,
        // big enough to be worth a sentence, said once per session
        if (!spoke && act && act.sessions && ready('recap')) {
            for (const x of act.sessions) {
                if (x.active || st.recapped[x.session_id]) continue;
                const age = now - Date.parse(x.last_activity || 0);
                if (!(age >= this.RECAP_MIN_QUIET_MS && age <= this.RECAP_MAX_AGE_MS)) continue;
                st.recapped[x.session_id] = true;
                const ctx = x.context_tokens_last;
                if (ctx == null || ctx < this.RECAP_MIN_CONTEXT) continue;
                const kTok = Math.round(ctx / 1000);
                spoke = this._speak({
                    text: `That session just wrapped up. It finished at about ${kTok}K tokens of context re-sent on every turn. The Optimizer shows what compacting earlier would have saved.`,
                    cta: 'Open the Optimizer', page: 'costs', tab: 'optimizer',
                });
                if (spoke) { bump('recap'); break; }
            }
        }

        // update baselines only for counters we actually read this tick
        Object.keys(totals).forEach(k => { if (totals[k] != null) st.totals[k] = totals[k]; });
        this._sentinelSave(st);
    },

    /** One bubble at a time; every line is a filled template, never free text. */
    /** Where on screen a finding lives, so the gaze has something real to
     *  land on. Returns null when the nav entry is not rendered or is
     *  off-screen: looking at nothing is worse than not looking. */
    _navAnchor(page) {
        if (!page) return null;
        const onScreen = (el) => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return !!(r.width && r.height) && r.bottom >= 0 && r.top <= window.innerHeight;
        };
        const el = document.querySelector(`.nav-item[data-page="${page}"]`);
        if (!el) return null;
        if (onScreen(el)) return el;
        // Threats, Secret Detections and Blocked Actions are sub-items of a
        // collapsible section, so they have no box while it is closed — which
        // is exactly the case for the events that matter most. Fall back to
        // the section header that owns them: still the right direction, and
        // it is the thing the user would have to click anyway.
        const group = el.closest('.nav-sub-items');
        const parent = group && group.previousElementSibling;
        if (parent && parent.classList && parent.classList.contains('nav-item')
            && onScreen(parent)) return parent;
        return null;
    },

    /** React to something that actually happened. The Guardian looks at the
     *  surface the finding belongs to first, so its attention lands there a
     *  beat before the user's, then reacts in a register that matches the
     *  event. `wave()` is a greeting and stays a greeting: a blocked tool
     *  call does not deserve a friendly nod. */
    _react(mood, page) {
        const target = this._navAnchor(page);
        if (this._bot3d) {
            if (target && this._bot3d.look) this._bot3d.look(target, { hold: 900 });
            if (mood === 'alert' && this._bot3d.react) {
                this._bot3d.react('blocked');
            } else if (mood === 'concerned' && this._bot3d.setState) {
                this._bot3d.setState('concerned');
                clearTimeout(this._moodTimer);
                this._moodTimer = setTimeout(() => {
                    if (this._bot3d) this._bot3d.setState('idle');
                }, 4200);
            } else if (!mood) {
                this._bot3d.wave();
            }
            return;
        }
        // No WebGL: the same states, held statically on the 2D bot.
        const fabBot = this._fab && this._fab.querySelector('.sv-gbot');
        if (!fabBot || !window.GuardianBot) return;
        const s = mood === 'concerned' ? 'concerned' : (mood === 'alert' ? 'listening' : 'ok');
        GuardianBot.set(fabBot, s);
        clearTimeout(this._moodTimer);
        this._moodTimer = setTimeout(() => GuardianBot.set(fabBot, 'idle'), 2400);
    },

    // ------------- context: notice what you opened, offer the short version -------------
    // The Guardian can see which page is open and when something on it was
    // expanded. That is enough to offer an orientation at the moment it is
    // actually wanted, instead of a help panel nobody opens.
    //
    // Discipline, because this is the easiest feature in the app to make
    // annoying: it speaks only after a real expand, only once per page per
    // session, at most a few times in total, never over an alert, and every
    // line ends with an explicit "or carry on". The user is investigating;
    // the bot is offering, not intercepting.

    ORIENT_MAX: 3,        // per session, across all pages
    ORIENT_DWELL_MS: 450, // let the expand actually render before reacting

    /** What each view is, and the one thing worth looking at first. These are
     *  explanations of the product, not claims about the user's data: nothing
     *  here can be wrong about what is on screen. */
    PAGE_BRIEFS: {
        'agent-runs': {
            noun: 'traces',
            what: 'A trace is one agent run end to end, and the rows inside it are the model calls it made, in order.',
            look: 'The turn where tokens jump is usually where a tool result got large.',
            cta: 'Show me the costliest trace', act: 'costliest-trace',
        },
        threats: {
            noun: 'threats',
            what: 'Each row is one detection with the rule that fired and the agent it fired on.',
            look: 'Severity ranks the rule, not the outcome: check whether the action was actually blocked.',
            cta: 'Open blocked actions', page: 'blocked-ledger',
        },
        'blocked-ledger': {
            noun: 'blocked actions',
            what: 'Every row here is something an agent tried and was stopped from doing.',
            look: 'A repeat block on the same tool usually means a policy needs widening, not tightening.',
            cta: 'See the policies', page: 'tool-permissions',
        },
        egress: {
            noun: 'agent egress',
            what: 'These are the destinations agents actually reached, taken from this device.',
            look: 'A first-seen destination matters more than a busy familiar one.',
            cta: 'Open the destination rules', page: 'rules',
        },
        redactions: {
            noun: 'secret detections',
            what: 'Each row is a secret that was caught before it left the machine.',
            look: 'The pattern name tells you which rule caught it, so you know what to rotate.',
            cta: 'See the rules', page: 'rules',
        },
        costs: {
            noun: 'cost',
            what: 'Token counts here are exact; dollars are list-price estimates and are labelled as such.',
            look: 'The Optimizer tab is where the waste is broken down and each finding carries its fix.',
            cta: 'Open the Optimizer', page: 'costs', tab: 'optimizer',
        },
        'mcp-policies': {
            noun: 'MCP policies',
            what: 'A policy decides which MCP servers and tools an agent is allowed to reach.',
            look: 'Check the effective policy, not just the rule: the narrowest match wins.',
            cta: 'See what was blocked', page: 'blocked-ledger',
        },
        'skill-scanner': {
            noun: 'skills',
            what: 'Skills are instructions an agent loads at run time, so a bad one reads like a trusted one.',
            look: 'Findings point at the instruction text itself, not at the file it lives in.',
            cta: 'Open the rules', page: 'rules',
        },
        governance: {
            noun: 'governance',
            what: 'This is the record of what was decided, by which policy, and when.',
            look: 'Export it if you need the evidence outside the app.',
            cta: 'Open SIEM export', page: 'siem-export',
        },
        storylines: {
            noun: 'storylines',
            what: 'A storyline stitches related events into the sequence they happened in.',
            look: 'The gaps matter: a quiet stretch between two events is often the interesting part.',
            cta: 'See the raw traces', page: 'agent-runs',
        },
    },

    _currentPage() {
        if (window.Sidebar && Sidebar.currentPage) return Sidebar.currentPage;
        const el = document.querySelector('.nav-item.active[data-page]');
        return el ? el.dataset.page : null;
    },

    /** How many things on the page are currently open. A generic count beats
     *  a list of per-page selectors: the app expands with `aria-expanded`,
     *  `<details open>`, `.expanded` and `.open`, and this catches all four
     *  without any page needing to know the Guardian exists. */
    _openCount() {
        try {
            return document.querySelectorAll(
                '[aria-expanded="true"], details[open], .expanded, .open').length;
        } catch (_) { return 0; }
    },

    _orientStart() {
        this._oriented = {};
        this._orientCount = 0;
        document.addEventListener('click', (ev) => {
            const t = ev.target;
            if (!t || !t.closest) return;
            if ((this._fab && this._fab.contains(t))
                || (this._panel && this._panel.contains(t))
                || (this._bubbleEl && this._bubbleEl.contains(t))) return;
            const before = this._openCount();
            setTimeout(() => {
                if (this._openCount() > before) this._orient();
            }, this.ORIENT_DWELL_MS);
        }, { capture: true, passive: true });
    },

    /** Offer the short version of whatever the user just opened. */
    _orient() {
        if (this._quiet() || this._open || this._bubbleEl) return;
        if (this._orientCount >= this.ORIENT_MAX) return;
        if (Date.now() - (this._spokeAt || 0) < 30000) return; // let the last word land
        const page = this._currentPage();
        const b = page && this.PAGE_BRIEFS[page];
        if (!b || this._oriented[page]) return;
        this._oriented[page] = true;
        // "or carry on" is not politeness padding: it is the difference
        // between an offer and an interruption.
        const spoke = this._speak({
            text: `Looks like you are digging into ${b.noun}. Short version: `
                + `${b.what} ${b.look} Or ignore me and carry on.`,
            cta: b.cta, page: b.page, tab: b.tab, act: b.act, mood: 'none',
        });
        if (spoke) {
            this._orientCount += 1;
            if (this._bot3d) this._bot3d.setState('listening');
            else if (this._bot) this._bot.setState('listening');
            setTimeout(() => {
                if (this._bot3d) this._bot3d.setState('idle');
                else if (this._bot) this._bot.setState('idle');
            }, 4200);
        }
    },

    /** CTA actions that answer on the page the user is already on. A promise
     *  like "show me the costliest trace" made while the user is looking at
     *  traces must resolve HERE, not by dumping them on the Optimizer tab. */
    async _act(name) {
        if (name !== 'costliest-trace') return;
        // The trace list carries no token numbers; session totals live only in
        // the Optimizer report. Join the two on session_id and rank.
        let sums = null;
        try {
            const rep = await API.request('/api/cost-optimizer/report');
            sums = new Map((rep && rep.session_summaries || []).map(
                (x) => [x.session_id, (x.prompt_tokens || 0) + (x.output_tokens || 0)]));
        } catch (_) { /* no scan yet */ }
        const runs = (window.AgentRunsPage && AgentRunsPage.runs) || [];
        let best = null, bestTok = -1;
        runs.forEach((r) => {
            const t = sums && sums.get(r.session_id);
            if (t != null && t > bestTok) { bestTok = t; best = r; }
        });
        if (!best) {
            // Nothing rankable: no report, or none of these traces map to a
            // scanned session. Say so instead of silently doing nothing.
            this._speak({
                text: 'I cannot rank these traces yet: no Cost Optimizer scan covers them. '
                    + 'Run a scan and ask me again.',
                cta: 'Open the Optimizer', page: 'costs', tab: 'optimizer', mood: 'none',
            });
            return;
        }
        if (window.AgentRunsPage && AgentRunsPage.selectRun) {
            AgentRunsPage.selectRun(best.trace_id, { refresh: true }); // never accordion-collapse
        }
        const row = document.querySelector(`.ar-run[data-trace="${best.trace_id}"]`);
        if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const fmt = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B'
            : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
            : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(Math.round(n || 0));
        this._speak({
            text: `This one. Its session billed ${fmt(bestTok)} tokens, the most of any trace `
                + 'listed here. The turn where tokens jump is usually the one to read first.',
            cta: 'Why it cost that', page: 'costs', tab: 'optimizer', mood: 'none',
        });
    },

    // ---------------------------------------------------------- personality --
    // The Guardian has one voice everywhere it speaks. Traits, in priority
    // order, so future copy has something to be checked against:
    //
    //   1. Calm      - never panics. Urgency comes from the facts, not from
    //                  exclamation marks or red text.
    //   2. Precise   - says the number, never "a lot". Never claims anything
    //                  it did not measure on this device.
    //   3. Modest    - it advises, it does not act. The user applied the fix,
    //                  so the credit is theirs, not the bot's.
    //   4. Kind      - never scolds, never nags, never implies carelessness.
    //                  An ignored suggestion is dropped, not repeated.
    //   5. Dry       - understated humour, and only when nothing is wrong.
    //                  No slang, no sarcasm pointed at the user, no profanity.
    //
    // Hard rule: humour never appears in an advisory, a finding, an alert or
    // anything with a number attached. It lives only in the idle thought
    // cloud below, and the cloud goes quiet the moment something needs doing.
    PERSONA: {
        traits: ['calm', 'precise', 'modest', 'kind', 'dry'],
        // Idle musings. Two hard rules, learned the hard way:
        //
        //   1. Nothing here may make a claim about the user's data. A line
        //      like "a tool result is misbehaving somewhere" reads as a
        //      finding, and a finding with no evidence and no click-through
        //      is worse than silence. Anything about sessions, tokens, tools
        //      or findings goes through _speak(), which carries the number and
        //      a button to the page that owns it.
        //   2. Every line has to survive being read by someone whose
        //      production agent just cost them money: nothing smug, nothing
        //      crude, nothing at the user's expense.
        //
        // What is left is the bot talking about itself, which is the only
        // subject it can be funny about without being wrong.
        idle: [
            'all quiet. I prefer quiet.',
            'I do not sleep. I idle.',
            'a good shift is one with nothing to report',
            'I would fetch you a coffee, but no hands',
            'still here, still watching',
            'filing this under: fine',
            'no news is my favourite kind',
            'holding down the corner',
            'standing by, as usual',
            'nothing to report. delightful.',
            'my one job, and it is going well',
            'I have counted the pixels. twice.',
            'on duty. mostly ornamental.',
            'this corner is mine now',
        ],
        // Shown right after a verified win, before the bot settles again.
        proud: [
            'that one actually worked',
            'numbers went down. good numbers.',
            'you fixed it. I only pointed.',
        ],
        // Long agent run, or a long stretch at the desk. Praise first, a light
        // remark second, and a nudge to look after yourself. Kept to a few
        // words on purpose: encouragement that runs long reads as a lecture.
        stamina: [
            'still going. respect.',
            'long haul. you have got this.',
            'long stretch. nice pace.',
            'deep in it. I am impressed.',
            'hours in, still sharp.',
            'stretch your legs. I will watch.',
            'water exists. just saying.',
            'you and me both, still up.',
            'steady work. it shows.',
        ],
    },

    /** The thought cloud above the Guardian's head: three dots while it is
     *  genuinely busy, a short thought while it is idle. It is decoration with
     *  a rule attached, so it can never mislead: dots mean work is really in
     *  flight, and a thought only ever appears when nothing needs doing. */
    _thoughtEl() {
        if (this._thought && this._thought.isConnected) return this._thought;
        const t = document.createElement('div');
        t.className = 'sv-ga-thought';
        t.setAttribute('aria-hidden', 'true'); // ambient, never announced
        t.innerHTML = '<span class="sv-ga-thought-t"></span>'
            + '<i class="sv-ga-dots"><b></b><b></b><b></b></i>';
        document.body.appendChild(t);
        this._thought = t;
        return t;
    },

    _thoughtPlace() {
        const t = this._thought;
        if (!t || !this._fab) return;
        const f = this._fab.getBoundingClientRect();
        const w = t.offsetWidth || 150;
        // Aim at the HEAD, not the button box. The button is 102px around a
        // 94px canvas and the head only occupies the middle of it, so
        // anchoring to f.top left the tail trailing off into empty space
        // well above the bot.
        const headX = f.left + f.width / 2;
        const headY = f.top + f.height * 0.3;
        let left = headX - w / 2;
        left = Math.max(10, Math.min(left, window.innerWidth - w - 10));
        t.style.left = `${Math.round(left)}px`;
        t.style.top = `${Math.round(headY - t.offsetHeight - 16)}px`;
        // The tail always points at the head, not just when the cloud has
        // been pushed off centre by a viewport edge.
        const lean = headX - (left + w / 2);
        t.style.setProperty('--lean', `${Math.max(-46, Math.min(46, lean))}px`);
        // A bright thought floating over an almost-invisible bot reads as an
        // orphaned tooltip. The cloud fades with its owner.
        t.classList.toggle('sv-ga-ghost', this._fab.classList.contains('sv-ga-ghost'));
    },

    /** Dots on, dots off. Called around real work: a live poll in flight, a
     *  scan running, or a pasted fix still being watched for its payoff. */
    _think(busy) {
        this._busy = !!busy;
        clearTimeout(this._dotsDelay);
        if (busy) {
            // Routine polls answer in well under a second. Dots that blink on
            // every one of them turn "I am working" into a nervous tic, so
            // only work that actually takes a moment earns the indicator.
            this._dotsDelay = setTimeout(() => {
                if (this._busy) this._thoughtShow(null);
            }, this.DOTS_AFTER_MS);
        }
        else if (this._thought && this._thought.dataset.mode === 'dots') this._thoughtHide();
    },

    DOTS_AFTER_MS: 700,

    _thoughtShow(text) {
        // Anything that needs the user's attention outranks the cloud: an open
        // panel, a live bubble, quiet mode, or a page the bot is fading over.
        if (this._quiet() || this._open || this._bubbleEl || !this._fab) return;
        const t = this._thoughtEl();
        // Dots never interrupt a thought mid-read: a routine poll starting
        // while a line is up would otherwise clip it to three dots.
        if (!text && t.classList.contains('show') && t.dataset.mode === 'text') return;
        t.dataset.mode = text ? 'text' : 'dots';
        t.querySelector('.sv-ga-thought-t').textContent = text || '';
        this._thoughtPlace();
        // Flush layout, then reveal in the same tick. requestAnimationFrame
        // looks tidier but never fires while the window is hidden or occluded,
        // which left the cloud mounted at zero opacity and stuck there.
        void t.offsetHeight;
        t.classList.add('show');
        this._thoughtPlace();
        this._thoughtFollow();
        clearTimeout(this._thoughtTimer);
        if (text) {
            this._spokeAt = Date.now();
            // Long enough to read once, never long enough to feel pinned.
            const dwell = Math.min(7000, 3600 + text.length * 55);
            this._thoughtTimer = setTimeout(() => this._thoughtHide(), dwell);
        }
    },

    /** The cloud rides with the bot. The Guardian is draggable and it also
     *  glides when it re-docks, so a one-shot placement leaves the thought
     *  stranded mid-page. Re-anchoring every frame while the cloud is up is
     *  cheap (two rect reads) and is the only thing that survives a CSS
     *  transition moving the bot under it. */
    _thoughtFollow() {
        cancelAnimationFrame(this._thoughtRaf);
        const step = () => {
            const t = this._thought;
            if (!t || !t.classList.contains('show')) { this._thoughtRaf = 0; return; }
            this._thoughtPlace();
            this._thoughtRaf = requestAnimationFrame(step);
        };
        this._thoughtRaf = requestAnimationFrame(step);
    },

    _thoughtHide() {
        clearTimeout(this._thoughtTimer);
        cancelAnimationFrame(this._thoughtRaf);
        this._thoughtRaf = 0;
        const t = this._thought;
        if (!t) return;
        t.classList.remove('show');
    },

    /** The scenarios worth a word. Each one is a condition the Guardian can
     *  actually verify on this device plus a few short lines. Order matters:
     *  earlier scenarios are more specific, and specific beats generic. Every
     *  line stays to a few words, because encouragement that runs long stops
     *  being encouragement and starts being a lecture. */
    _scenarios(live) {
        // Only conditions about the *situation* qualify: how long the human
        // has been at it, what time it is, how long nothing has happened.
        // Nothing here describes the user's sessions or findings, because the
        // cloud cannot be clicked and an unlinked claim is not worth making.
        const sessions = (live && live.sessions) || [];
        const hours = sessions.reduce((m, x) => Math.max(m, x.active_hours || 0), 0);
        const desk = (Date.now() - (this._mountedAt || Date.now())) / 3600000;
        const stretch = Math.max(hours, desk);
        const hour = new Date().getHours();
        const day = new Date().getDay();
        const quietMins = Math.floor(
            (Date.now() - (this._lastEventAt || this._mountedAt || Date.now())) / 60000);

        return [
            {   // A long stretch earns praise, not a warning. The cost side of
                // a long run is the long_session advisory's job, with numbers.
                when: stretch >= 2,
                lines: [`${Math.floor(stretch)}h in. still going.`,
                    ...this.PERSONA.stamina],
            },
            {   // Late night, and still at it.
                when: hour >= 23 || hour < 5,
                lines: ['night shift. same.', 'past eleven. one more?',
                    'the quiet hours are the good ones', 'still up. so am I.'],
            },
            {   // Weekend work.
                when: day === 0 || day === 6,
                lines: ['weekend build. dedication.', 'saturday hits different',
                    'off the clock, still at it'],
            },
            {   // Nothing at all has happened for a long stretch. The bot is
                // allowed to notice the silence: that is about the shift, not
                // about anything on screen.
                when: quietMins >= 20,
                lines: quietMins >= 60
                    ? ['an hour of nothing. peak performance.',
                        'I have been staring at nothing for an hour',
                        'still nothing. I remain vigilant.',
                        'suspiciously calm around here']
                    : [`${quietMins} minutes of absolutely nothing`,
                        'quiet. too quiet. probably fine.',
                        'no news. still no news.',
                        'I could hear a pin drop. no ears, though.'],
            },
        ];
    },

    /** One thought: the most specific true scenario, falling back to the idle
     *  pool. Never repeats the line it just used. */
    _thoughtPick() {
        const live = this._liveData;
        const pool = [];
        for (const sc of this._scenarios(live)) {
            if (sc.when) pool.push(...sc.lines);
        }
        pool.push(...this.PERSONA.idle);
        const options = pool.filter(Boolean).filter(x => x !== this._lastThought);
        const pick = options[Math.floor(Math.random() * options.length)];
        this._lastThought = pick;
        return pick;
    },

    /** Idle musing on a slow timer. Deliberately infrequent: a bot that
     *  thinks out loud every few seconds stops being charming very fast. */
    _thinkStart() {
        clearInterval(this._thinkTimer);
        const tick = () => {
            if (this._busy || this._quiet() || this._open || this._bubbleEl) return;
            if (document.hidden) return;      // nobody is looking
            const now = Date.now();
            // Let the user settle in before the first musing.
            if (now - (this._mountedAt || 0) < this.THOUGHT_SETTLE_MS) return;
            // One shared clock for everything the bot says out loud: bubbles,
            // orientations and thoughts all push the next thought back. And
            // each thought pushes the one after it back further, so a long
            // shift gets a companion that talks less as the hours go on, not
            // more. That is the whole trick to not being annoying.
            const gap = this.THOUGHT_GAP_MS
                * Math.min(4, 1 + (this._thoughtCount || 0) * 0.5);
            if (now - (this._spokeAt || 0) < gap) return;
            if (Math.random() > 0.45) return; // not every window, so it stays a surprise
            this._thoughtShow(this._thoughtPick());
            this._thoughtCount = (this._thoughtCount || 0) + 1;
        };
        this._thinkTimer = setInterval(tick, this.THINK_MS);
    },

    THINK_MS: 26000,          // heartbeat only; THOUGHT_GAP_MS does the pacing
    THOUGHT_GAP_MS: 5 * 60 * 1000,   // first thought 5 min after the last word
    THOUGHT_SETTLE_MS: 2 * 60 * 1000,

    _speak({ text, cta, page, tab, mood, act }) {
        if (this._quiet() || !this._fab) return false;
        this._lastEventAt = Date.now(); // something happened; the shift is not quiet
        if (this._bubbleEl && this._bubbleEl.isConnected) return false; // one at a time
        this._spokeAt = Date.now(); // thoughts wait their turn after any bubble
        const b = document.createElement('div');
        b.className = 'sv-ga-bubble';
        b.setAttribute('role', 'status');
        b.innerHTML =
            '<div class="sv-ga-bubble-t"></div>' +
            '<div class="sv-ga-bubble-row">' +
            '<button type="button" class="sv-ga-bubble-go"></button>' +
            '<button type="button" class="sv-ga-bubble-mute">Mute the Guardian</button>' +
            '<button type="button" class="sv-ga-bubble-x" aria-label="Dismiss">&times;</button>' +
            '</div>';
        b.querySelector('.sv-ga-bubble-t').textContent = text;
        const go = b.querySelector('.sv-ga-bubble-go');
        go.textContent = cta || 'Open';
        go.addEventListener('click', () => {
            this._hideBubble();
            if (act) { this._act(act); return; } // in-place: the answer is on THIS page
            if (tab && window.CostsPage) CostsPage._pendingTab = tab;
            if (window.Sidebar && Sidebar.navigate) Sidebar.navigate(page);
        });
        b.querySelector('.sv-ga-bubble-mute').addEventListener('click', () => this._setQuiet(true));
        b.querySelector('.sv-ga-bubble-x').addEventListener('click', () => this._hideBubble());
        document.body.appendChild(b);
        this._bubbleEl = b;
        this._placeNear(b);
        requestAnimationFrame(() => b.classList.add('show'));
        this._react(mood, page);
        clearTimeout(this._bubbleHideTimer);
        this._bubbleHideTimer = setTimeout(() => this._hideBubble(), 16000);
        return true;
    },

    _hideBubble() {
        this._thoughtPlace();
        clearTimeout(this._bubbleHideTimer);
        const b = this._bubbleEl;
        if (!b) return;
        this._bubbleEl = null;
        b.classList.remove('show');
        setTimeout(() => b.remove(), 220);
    },

    // ------------- live advisor: watch live sessions, speak in time -------------
    // Everything here is advisory. SecureVector never writes into a session;
    // every alert ends in a copy-paste fix the human applies themselves.

    _liveState() {
        try {
            const raw = localStorage.getItem('sv-ga-live');
            const st = raw ? JSON.parse(raw) : null;
            if (st && typeof st === 'object') return st;
        } catch (_) { /* private mode */ }
        return { causes: {}, stages: {}, lastBeepAt: 0 };
    },
    _liveSave(st) {
        const keys = Object.keys(st.causes || {});
        if (keys.length > 40) keys.slice(0, keys.length - 40).forEach(k => delete st.causes[k]);
        try { localStorage.setItem('sv-ga-live', JSON.stringify(st)); } catch (_) { /* full */ }
    },

    _fmtTok(n) {
        return n >= 1e9 ? (n / 1e9).toFixed(1) + 'B'
            : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
            : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(Math.round(n || 0));
    },

    /** "12s ago" / "4m ago" / "2h ago". With several agents running, the one
     *  you typed in seconds ago is the one you are looking for, so recency is
     *  the most useful handle we can offer. */
    _ago(iso) {
        if (!iso) return '';
        const ms = Date.now() - new Date(iso).getTime();
        if (!isFinite(ms) || ms < 0) return '';
        const s = Math.round(ms / 1000);
        if (s < 60) return `active ${s}s ago`;
        const m = Math.round(s / 60);
        if (m < 60) return `active ${m}m ago`;
        return `active ${Math.round(m / 60)}h ago`;
    },

    /** Which agent this card is talking about. The number comes from the same
     *  activity list the Optimizer's session list numbers from, so one session
     *  never ends up with two names; when that list is not loaded yet the card
     *  stays unnumbered rather than inventing a number that would disagree.
     *  Returns { title, sub } where sub is the human handle: the runtime, the
     *  model, and when it was last active. */
    _liveWho(s) {
        const ids = ((this._activityIds || [])).filter(Boolean);
        const num = ids.indexOf(s.session_id) + 1;
        const shortId = String(s.session_id || '').slice(0, 8);
        const title = num > 0 ? `Agent #${num} · ${shortId}` : `Session ${shortId}`;
        const parts = [s.harness, s.model, this._ago(s.last_activity)].filter(Boolean);
        return { title, sub: parts.join(' · ') };
    },

    /** Copy-paste fix for a live advisory: the state-note-first workflow the
     *  design doc records. Compact nudges never carry a savings figure. */
    _liveFix(type, a) {
        a = a || {};
        const stateNote = 'Pause here. Write a short state note to STATE.md so a fresh session can continue this work: the task in one line, decisions already made, files in flight with their paths, and the exact next step. Keep it under 40 lines and do not copy transcript history into it.';
        switch (type) {
            case 'tool_result_carry': return {
                label: 'Copy trim request',
                text: 'From now on, keep tool results small: search first, then read only the specific line ranges you need, and keep any single tool result under about 2K tokens. Oversized results stay in context and are re-billed on every later turn.'
                    + (a.tokens ? ` In this session, ${a.tool || 'a tool'} results reached about ${this._fmtTok(a.tokens)} tokens.` : ''),
            };
            case 'duplicate_calls': return {
                label: 'Copy dedupe request',
                text: `The same ${a.tool || 'tool'} call ran ${a.count || 'several'} times with identical input. Reuse the earlier result instead of calling again, and tell me before repeating any call with the same input.`,
            };
            case 'failure_loop': return {
                label: 'Copy stop-loop request',
                text: 'Stop retrying the failing command. State what failed, what you already tried, and propose a different approach before running anything else. Repeated failing runs bill the full context on every attempt.',
            };
            case 'compact_act_now':
            case 'compact_last_call': return {
                label: 'Copy state note + compact step',
                text: stateNote + '\n\nAfter the note is written I will type: /compact keep the current task, the decisions made, the files in flight, and the exact next step. Drop everything else. If I am switching to an unrelated task instead, I will use /clear.',
            };
            default: return { label: 'Copy state note template', text: stateNote };
        }
    },

    _copy(btn, text, into, meta) {
        const done = () => {
            // Start the follow-through clock: the service looks for this text
            // in a local transcript, then measures whether it changed anything.
            // Best effort; the copy itself must never depend on it.
            if (meta && meta.type) {
                API.optimizerFixCopied({
                    type: meta.type, text,
                    session_id: meta.session_id || null,
                    label: meta.label || null,
                });
            }
            const old = btn.textContent;
            btn.disabled = true;
            btn.textContent = into ? `Copied, paste into ${into}` : 'Copied, paste it into your session';
            setTimeout(() => { btn.disabled = false; btn.textContent = old; }, 1800);
        };
        const fallback = () => {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch (_) { /* clipboard denied */ }
            ta.remove();
            done();
        };
        try {
            navigator.clipboard.writeText(text).then(done, fallback);
        } catch (_) { fallback(); }
    },

    _badgeSet(count) {
        if (!this._fab) return;
        let b = this._fab.querySelector('.sv-ga-badge');
        if (!count) { if (b) b.remove(); return; }
        if (!b) {
            b = document.createElement('span');
            b.className = 'sv-ga-badge';
            this._fab.appendChild(b);
        }
        b.textContent = count > 9 ? '9+' : String(count);
    },

    /** Two short blips, synthesized in place. Honors the sounds pref upstream
     *  and a global cooldown here, so the bot never becomes a pager. */
    _beep() {
        const st = this._liveState();
        if (Date.now() - (st.lastBeepAt || 0) < this.LIVE_BEEP_COOLDOWN_MS) return;
        st.lastBeepAt = Date.now();
        this._liveSave(st);
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            const ctx = new Ctx();
            [0, 0.14].forEach((at) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.frequency.value = 1560;
                osc.type = 'sine';
                gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
                gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + at + 0.015);
                gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.07);
                osc.connect(gain).connect(ctx.destination);
                osc.start(ctx.currentTime + at);
                osc.stop(ctx.currentTime + at + 0.09);
            });
            setTimeout(() => { try { ctx.close(); } catch (_) { /* closed */ } }, 600);
        } catch (_) { /* no audio device */ }
    },

    _liveStart() {
        if (this._liveTimer) return;
        const tick = () => {
            if (document.hidden) return;
            this._liveTick().catch(() => { /* endpoint hiccup: next tick */ });
        };
        this._liveTimer = setInterval(tick, this.LIVE_MS);
        setTimeout(tick, 4000); // first look shortly after mount
    },

    async _liveTick() {
        // Dots mean work is actually happening. They go up before the request
        // and come down after it, so the cloud never fakes being busy.
        this._think(true);
        const live = await API.getOptimizerLive().finally(() => this._think(false));
        if (!live || live.enabled === false) { this._liveData = null; this._badgeSet(0); return; }
        this._liveData = live;
        // Agent numbers come from the activity list, the same source the
        // Optimizer's session list numbers from. Best effort: if it fails the
        // cards stay unnumbered rather than disagreeing with that page.
        try {
            const act = await API.getOptimizerSessions(1);
            this._activityIds = ((act && act.sessions) || [])
                .filter(a => a.active).map(a => a.session_id);
        } catch (_) { /* keep the previous numbering */ }
        const st = this._liveState();
        st.causes = st.causes || {};
        st.stages = st.stages || {};

        let unread = 0;
        let toSpeak = null; // one bubble per tick, worst stage first
        const rank = { quiet: 0, heads_up: 1, act_now: 2, last_call: 3 };

        for (const s of live.sessions || []) {
            // Any advisory or staged compact means the shift is not quiet.
            if ((s.advisories || []).length || (s.compact_stage || 'quiet') !== 'quiet') {
                this._lastEventAt = Date.now();
            }
            const sid = s.session_id;
            const seen = st.causes[sid] = st.causes[sid] || {};
            for (const a of s.advisories || []) {
                if (!seen[a.type]) unread += 1;
            }
            const stage = s.compact_stage || 'quiet';
            const prev = st.stages[sid] || 'quiet';
            if (rank[stage] > rank[prev]) {
                unread += 1;
                if (!toSpeak || rank[stage] > rank[toSpeak.stage]) toSpeak = { stage, s };
            }
        }
        this._badgeSet(unread);

        // A verified fix outranks everything except a last-call compact. It is
        // the one thing the Guardian says that is purely good news, and it is
        // measured: the flag that caused the advice is gone, or context
        // actually shrank. A paste on its own is never celebrated.
        st.wins = st.wins || {};
        const win = this._nextWin(live, st);
        if (win && (!toSpeak || toSpeak.stage !== 'last_call') && !this._quiet()) {
            const spoke = this._speak({
                text: this._winText(win), cta: 'See the receipt',
                page: 'costs', tab: 'optimizer', mood: 'ok',
            });
            if (spoke) {
                st.wins[win.id] = true;
                this._celebrate();
                const proud = this.PERSONA.proud;
                setTimeout(() => this._thoughtShow(
                    proud[Math.floor(Math.random() * proud.length)]), 17000);
                this._liveSave(st);
                return;
            }
        }

        if (toSpeak && !this._quiet()) {
            const { stage, s } = toSpeak;
            const pct = Math.round(s.fill_pct || 0);
            // Name the agent. "A live session" is unusable advice when four
            // are running: the user has to know which window to act in.
            const who = this._liveWho(s).title;
            const lines = {
                heads_up: `${who} is ${pct}% full. Finish the current step, write a state note, then compact.`,
                act_now: `${who} is ${pct}% full. Compact at the next stopping point or quality will drop before auto-compact forces it.`,
                last_call: `${who} is ${pct}% full. Auto-compact is imminent and will pick its own moment. Compact now.`,
            };
            const spoke = this._speak({
                text: lines[stage], cta: 'See the session', page: 'costs', tab: 'optimizer', mood: 'concerned',
            });
            if (spoke) {
                st.stages[s.session_id] = stage; // each stage speaks once per session
                if (stage !== 'heads_up') {
                    if (live.sounds_enabled !== false) this._beep();
                    if (this._bot3d) this._bot3d.wave();
                }
            }
        }
        this._liveSave(st);
    },

    /** The win lap: a 270-degree turn wrapped in drifting colour. It fires
     *  on a verified fix and nothing else, so it stays worth watching. The
     *  Guardian's own palette never changes: the colour is in the puffs, which
     *  mean nothing and are gone in under two seconds. */
    _celebrate() {
        const fab = this._fab;
        if (!fab || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        // The ring of puffs is always DOM. Drawn inside the 94px canvas it sits
        // on the silhouette edge and gets clipped away to nothing, so it goes
        // around the button where there is room for it.
        const spun = !!(this._bot3d && this._bot3d.celebrate);
        if (spun) this._bot3d.celebrate();
        else if (this._bot) this._bot.setState('ok');
        // The flat renderer has no model to turn, so CSS turns the button.
        fab.classList.add(spun ? 'sv-ga-puffs' : 'sv-ga-lap');
        setTimeout(() => fab.classList.remove(spun ? 'sv-ga-puffs' : 'sv-ga-lap'), 1750);
    },

    /** First verified fix this device has not already been congratulated on.
     *  The service keeps wins in the payload for an hour, so a missed poll or
     *  a closed app does not lose one. */
    _nextWin(live, st) {
        const wins = (live && live.fixes && live.fixes.wins) || [];
        return wins.find(w => w && w.id && !st.wins[w.id]) || null;
    },

    /** Congratulations with the number attached. A win with nothing to show
     *  for it is just noise, so every line names what actually moved. */
    _winText(win) {
        const who = win.session_id
            ? this._liveWho({ session_id: win.session_id }).title
            : 'that session';
        const before = (win.before || {}).context_tokens;
        const after = (win.after || {}).context_tokens;
        if (before && after && after < before) {
            return `Nice, that worked. ${who} went from ${this._fmtTok(before)} to `
                + `${this._fmtTok(after)} tokens of context after you pasted the fix.`;
        }
        return `Nice, that worked. The ${this._fixName(win.type)} in ${who} has not `
            + 'come back since you pasted the fix.';
    },

    _fixName(type) {
        switch (type) {
            case 'tool_result_carry': return 'oversized tool result';
            case 'duplicate_calls': return 'repeated tool call';
            case 'failure_loop': return 'failure loop';
            case 'resend_growth': return 'context resend growth';
            case 'excessive_output': return 'over-long output';
            default: return 'problem I flagged';
        }
    },

    _liveText(a) {
        switch (a.type) {
            case 'tool_result_carry':
                return `This session just carried a tool result of about ${this._fmtTok(a.tokens || 0)} tokens from ${a.tool || 'a tool'}. Every later turn re-bills it.`;
            case 'resend_growth':
                return `Context re-sent per turn grew from ${this._fmtTok(a.from_tokens || 0)} to ${this._fmtTok(a.to_tokens || 0)} tokens in this session.`;
            case 'duplicate_calls':
                return `The same ${a.tool || 'tool'} call ran ${a.count} times in a row. Ask for the result to be reused.`;
            case 'failure_loop':
                return `${a.streak} tool calls failed back to back. This session is paying to fail repeatedly.`;
            case 'long_session':
                return 'Long sessions re-bill their whole history. Consider a state note and a fresh session.';
            default:
                return 'Worth a look.';
        }
    },

    /** Live section for the panel: one card per live session with its fill
     *  bar, its compact stage, and its advisories, each ending in a copy fix.
     *  Opening the panel reads everything, so the badge clears here. */
    _liveSection(body, live) {
        const st = this._liveState();
        st.causes = st.causes || {};
        st.stages = st.stages || {};
        const sec = document.createElement('div');
        sec.className = 'sv-ga-sec';
        sec.textContent = 'Live';
        body.appendChild(sec);
        const stageLine = {
            heads_up: 'Finish the current step, write a state note, then compact.',
            act_now: 'Compact at the next stopping point, before quality drops.',
            last_call: 'Auto-compact is imminent and will pick its own moment. Compact now.',
        };
        for (const s of live.sessions || []) {
            const card = document.createElement('div');
            card.className = 'sv-ga-live';
            const pct = s.fill_pct != null ? Math.min(100, s.fill_pct) : null;
            const stage = s.compact_stage || 'quiet';
            const head = document.createElement('div');
            head.className = 'sv-ga-live-head';
            head.innerHTML = '<b></b><span class="sv-ga-live-pct"></span>';
            const who = this._liveWho(s);
            head.querySelector('b').textContent = who.title;
            head.style.cursor = 'pointer';
            head.title = 'Open this session on the Optimizer page';
            head.addEventListener('click', () => {
                this.close();
                if (window.CostsPage) {
                    CostsPage._pendingTab = 'optimizer';
                    CostsPage._pendingScrollSid = s.session_id;
                }
                if (window.Sidebar && Sidebar.navigate) Sidebar.navigate('costs');
            });
            head.querySelector('.sv-ga-live-pct').textContent = pct != null
                ? `${Math.round(pct)}% of context, re-sending ${this._fmtTok(s.context_tokens_now || 0)} tok/turn`
                : 'live';
            card.appendChild(head);
            // Which window is this? The runtime, the model and how long ago it
            // last moved. With four agents open, recency is what identifies the
            // terminal you are about to paste into.
            if (who.sub) {
                const idl = document.createElement('div');
                idl.className = 'sv-ga-live-who';
                idl.textContent = who.sub;
                card.appendChild(idl);
            }
            if (pct != null) {
                const bar = document.createElement('div');
                bar.className = 'sv-ga-live-bar';
                bar.innerHTML = '<i></i>';
                bar.querySelector('i').style.width = pct + '%';
                card.appendChild(bar);
            }
            const items = [];
            if (stage !== 'quiet') {
                items.push({ type: 'compact_' + stage, text: stageLine[stage] });
                st.stages[s.session_id] = stage; // seen in panel = acknowledged
            }
            const seen = st.causes[s.session_id] = st.causes[s.session_id] || {};
            for (const a of s.advisories || []) {
                items.push({ type: a.type, data: a, text: this._liveText(a) });
                seen[a.type] = true;
            }
            for (const it of items) {
                const row = document.createElement('div');
                row.className = 'sv-ga-live-adv';
                const p = document.createElement('span');
                p.textContent = it.text;
                row.appendChild(p);
                const fix = this._liveFix(it.type, it.data);
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'sv-ga-live-copy';
                btn.textContent = fix.label;
                btn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    // name the destination: "paste it into your session" is
                    // useless when four sessions are live
                    this._copy(btn, fix.text, who.title,
                        { type: it.type, session_id: s.session_id, label: fix.label });
                });
                row.appendChild(btn);
                card.appendChild(row);
            }
            if (!items.length) {
                const ok = document.createElement('div');
                ok.className = 'sv-ga-live-adv';
                ok.innerHTML = '<span>Looks healthy: nothing worth interrupting for.</span>';
                card.appendChild(ok);
            }
            body.appendChild(card);
        }
        // The promise, printed rather than assumed, but printed last: the
        // cards are what the user opened the panel for. One line on screen;
        // the full contract rides on hover for whoever wants the fine print.
        const note = document.createElement('div');
        note.className = 'sv-ga-live-note';
        note.textContent = 'Advisory only: you copy, you paste, nothing is ever '
            + 'typed into a session.';
        note.title = 'SecureVector never types into a session and never edits '
            + 'your files. Context figures are measured from the transcript on '
            + 'this device; everything else is a modeled estimate. After you '
            + 'paste a fix, SecureVector watches that same local transcript to '
            + 'see whether it helped, and says so only once the numbers move.';
        body.appendChild(note);
        this._liveSave(st);
        this._badgeSet(0);
    },

    _injectStyle() {
        if (document.getElementById('sv-guardian-assistant-style')) return;
        const st = document.createElement('style');
        st.id = 'sv-guardian-assistant-style';
        st.textContent = `
/* The FAB floats over the page corner; give scrolled-to-bottom content
   room so buttons (optimizer Rescan, exports) are never buried under it. */
body.sv-ga-on #page-content { padding-bottom: 128px; }
.sv-ga-fab { position: fixed; right: 22px; bottom: 18px; z-index: 900;
  background: none; border: none; padding: 4px; cursor: pointer;
  /* The halo is the product's one teal, the family the eyes glow in: not a
     state colour, just presence. Light backgrounds swallow a faint glow, so
     the light token mixes stronger rather than changing hue. */
  filter: drop-shadow(0 4px 10px rgba(0,0,0,0.35))
    drop-shadow(0 0 11px var(--sv-ga-glow));
  animation: sv-ga-breathe 5.4s ease-in-out infinite;
  transition: transform 180ms ease; }
@keyframes sv-ga-breathe {
  50% { filter: drop-shadow(0 4px 10px rgba(0,0,0,0.35))
    drop-shadow(0 0 19px var(--sv-ga-glow-peak)); } }
.sv-ga-fab:hover { transform: translateY(-3px) scale(1.04); opacity: 1 !important; }
.sv-ga-fab { cursor: grab; touch-action: none; }
.sv-ga-fab.sv-ga-drag { cursor: grabbing; transform: none; }
/* Only transient overlap reaches this now (a scroll bringing text under a
   bot that was clear when it landed). 0.32 was a legible grey shape on
   the page, which reads as a smudge; this reads as out of the way. */
.sv-ga-fab.sv-ga-ghost { opacity: 0.14; }
.sv-ga-fab.sv-ga-away { opacity: 0 !important; pointer-events: none; }
.sv-ga-fab:focus-visible { outline: 2px solid var(--accent-primary, #5eadb8); border-radius: 12px; }
.sv-ga-panel { position: fixed; right: 22px; bottom: 100px; z-index: 899;
  width: 340px; max-width: calc(100vw - 44px); max-height: 70vh; overflow-y: auto;
  background: var(--bg-card, #12171e); border: 1px solid var(--border-light, #303844);
  border-radius: 14px; box-shadow: 0 12px 34px rgba(0,0,0,0.45);
  opacity: 0; pointer-events: none; transform: translateY(10px);
  transition: opacity 160ms ease, transform 160ms ease; }
.sv-ga-panel.open { opacity: 1; pointer-events: auto; transform: translateY(0); }
.sv-ga-head { display: flex; align-items: center; gap: 12px; padding: 14px 14px 10px;
  border-bottom: 1px solid var(--border-default, #232a33);
  cursor: move; user-select: none; -webkit-user-select: none; touch-action: none; }
.sv-ga-head .sv-ga-close { cursor: pointer; }
/* while dragging, the open/close transition must not fight the pointer */
.sv-ga-panel.sv-ga-drag { transition: none; }
.sv-ga-title { font-family: var(--font-display, inherit); font-weight: 700;
  font-size: 15px; color: var(--text-primary, #eef2f7); }
.sv-ga-tag { font-size: 11px; color: var(--text-muted, #7f8a97); }
.sv-ga-close { margin-left: auto; background: none; border: none; cursor: pointer;
  color: var(--text-muted, #7f8a97); font-size: 18px; line-height: 1; padding: 4px 8px;
  border-radius: 6px; }
.sv-ga-close:hover { color: var(--text-primary, #eef2f7); background: var(--bg-secondary, #0e1218); }
.sv-ga-body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 6px; }
.sv-ga-loading { color: var(--text-muted, #7f8a97); font-size: 12px; padding: 10px 4px; }
.sv-ga-sec { font-size: 10px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase;
  color: var(--text-muted, #7f8a97); padding: 6px 4px 2px; }
.sv-ga-row { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
  background: var(--bg-secondary, #0e1218); border: 1px solid var(--border-default, #232a33);
  border-radius: 10px; padding: 10px 12px; cursor: pointer; color: var(--text-muted, #7f8a97);
  transition: border-color 140ms ease; }
.sv-ga-row:hover { border-color: var(--accent-primary, #5eadb8); }
.sv-ga-row.primary { border-color: color-mix(in srgb, var(--accent-primary, #5eadb8) 45%, transparent); }
.sv-ga-row-text { flex: 1; min-width: 0; }
.sv-ga-row-text b { display: block; font-size: 12.5px; font-weight: 600;
  color: var(--text-primary, #eef2f7); }
.sv-ga-row-text span { display: block; font-size: 11px; color: var(--text-muted, #7f8a97);
  line-height: 1.4; margin-top: 1px; }
.sv-ga-row-val { font-family: var(--font-mono, monospace); font-size: 12px; font-weight: 700;
  color: var(--text-secondary, #aeb7c2); white-space: nowrap; }
.sv-ga-quiet { background: none; border: none; cursor: pointer; text-align: left;
  font-size: 10.5px; color: var(--text-muted, #7f8a97); padding: 2px 4px 0;
  text-decoration: underline; text-underline-offset: 2px; }
.sv-ga-quiet:hover { color: var(--text-secondary, #aeb7c2); }
.sv-ga-bubble { position: fixed; right: 24px; bottom: 148px; z-index: 901;
  width: 300px; max-width: calc(100vw - 48px);
  background: var(--bg-card, #12171e); border: 1px solid var(--border-light, #303844);
  border-radius: 12px; padding: 12px 14px; box-shadow: 0 10px 28px rgba(0,0,0,0.4);
  opacity: 0; transform: translateY(8px); transition: opacity 180ms ease, transform 180ms ease; }
.sv-ga-bubble::after { content: ''; position: absolute; right: 40px; bottom: -6px;
  width: 12px; height: 12px; transform: rotate(45deg);
  background: var(--bg-card, #12171e);
  border-right: 1px solid var(--border-light, #303844);
  border-bottom: 1px solid var(--border-light, #303844); }
.sv-ga-bubble.show { opacity: 1; transform: translateY(0); }
.sv-ga-bubble-t { font-size: 12.5px; color: var(--text-primary, #eef2f7); line-height: 1.5; }
.sv-ga-bubble-row { display: flex; align-items: center; gap: 10px; margin-top: 9px; }
.sv-ga-bubble-go { background: var(--bg-secondary, #0e1218);
  border: 1px solid var(--accent-primary, #5eadb8); color: var(--accent-primary, #5eadb8);
  border-radius: 8px; font-size: 11.5px; font-weight: 600; padding: 4px 12px; cursor: pointer; }
.sv-ga-bubble-go:hover { background: color-mix(in srgb, var(--accent-primary, #5eadb8) 12%, transparent); }
.sv-ga-bubble-mute { background: none; border: none; color: var(--text-muted, #7f8a97);
  font-size: 10.5px; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
.sv-ga-bubble-x { margin-left: auto; background: none; border: none; cursor: pointer;
  color: var(--text-muted, #7f8a97); font-size: 16px; line-height: 1; padding: 0 2px; }
.sv-ga-bubble-x:hover { color: var(--text-primary, #eef2f7); }
.sv-ga-badge { position: absolute; top: 2px; right: 2px; min-width: 16px; height: 16px;
  border-radius: 8px; background: var(--accent-primary, #5eadb8); color: #06121a;
  font-size: 10px; font-weight: 700; line-height: 16px; text-align: center; padding: 0 3px; }
.sv-ga-live { border: 1px solid var(--border-light, #303844); border-radius: 10px;
  padding: 9px 10px; margin: 6px 0; background: var(--bg-secondary, #0e1218); }
.sv-ga-live-head { display: flex; justify-content: space-between; gap: 8px;
  font-size: 11.5px; color: var(--text-primary, #eef2f7); }
.sv-ga-live-head b { font-weight: 600; }
.sv-ga-live-pct { color: var(--text-muted, #7f8a97); font-size: 10.5px; text-align: right; }
.sv-ga-live-bar { height: 4px; border-radius: 2px; margin-top: 6px; overflow: hidden;
  background: color-mix(in srgb, var(--border-light, #303844) 60%, transparent); }
.sv-ga-live-bar i { display: block; height: 100%; border-radius: 2px;
  background: var(--text-muted, #7f8a97); }
.sv-ga-live-adv { display: flex; flex-direction: column; gap: 5px; margin-top: 8px;
  font-size: 11.5px; color: var(--text-secondary, #9fb0bf); line-height: 1.45; }
.sv-ga-live-who { font-size: 11px; opacity: 0.62; margin: -2px 0 6px; }
.sv-ga-live-note { font-size: 11px; line-height: 1.45; opacity: 0.62;
    margin: -2px 0 8px; }
.sv-ga-live-copy { align-self: flex-start; background: none;
  border: 1px solid var(--accent-primary, #5eadb8); color: var(--accent-primary, #5eadb8);
  border-radius: 7px; font-size: 10.5px; font-weight: 600; padding: 3px 9px; cursor: pointer; }
.sv-ga-live-copy:hover { background: color-mix(in srgb, var(--accent-primary, #5eadb8) 12%, transparent); }
.sv-ga-live-copy:disabled { opacity: 0.7; cursor: default; }
/* The win lap for the flat renderer: 270 degrees and a ring of colour that
   carries no meaning and does not linger. Never used for a security state. */
.sv-ga-fab.sv-ga-lap { animation: sv-ga-lap 1.6s cubic-bezier(0.4, 0, 0.2, 1); }
.sv-ga-fab.sv-ga-lap::after, .sv-ga-fab.sv-ga-puffs::after {
  content: ''; position: absolute; inset: -22px;
  /* the app's global border rule reaches pseudo-elements too, and drew a grey
     orbit line through the puffs: the ring is the puffs, nothing else */
  border: 0; border-radius: 50%; pointer-events: none;
  background:
    radial-gradient(circle at 50% 4%,  hsl(200 62% 66% / 0.9) 0 5px, transparent 6px),
    radial-gradient(circle at 84% 22%, hsl(268 62% 70% / 0.9) 0 4px, transparent 5px),
    radial-gradient(circle at 96% 58%, hsl(320 62% 70% / 0.9) 0 5px, transparent 6px),
    radial-gradient(circle at 74% 90%, hsl(28 70% 66% / 0.9)  0 4px, transparent 5px),
    radial-gradient(circle at 30% 96%, hsl(160 55% 62% / 0.9) 0 5px, transparent 6px),
    radial-gradient(circle at 6% 62%,  hsl(48 72% 66% / 0.9)  0 4px, transparent 5px),
    radial-gradient(circle at 14% 22%, hsl(220 62% 70% / 0.9) 0 5px, transparent 6px);
  animation: sv-ga-puffs 1.55s ease-out forwards; }
@keyframes sv-ga-lap {
  0%   { transform: rotate(0deg)   translateY(0); }
  35%  { transform: rotate(200deg) translateY(-9px); }
  66%  { transform: rotate(270deg) translateY(0); }
  100% { transform: rotate(360deg) translateY(0); }
}
@keyframes sv-ga-puffs {
  0%   { opacity: 0; transform: rotate(0deg)   scale(0.55); }
  25%  { opacity: 1; transform: rotate(90deg)  scale(1); }
  100% { opacity: 0; transform: rotate(330deg) scale(1.5); }
}
@media (prefers-reduced-motion: reduce) {
  .sv-ga-fab { animation: none; }
  .sv-ga-fab.sv-ga-lap { animation: none; }
  .sv-ga-fab.sv-ga-lap::after, .sv-ga-fab.sv-ga-puffs::after {
    animation: none; content: none; }
}
/* Thought cloud: ambient, never load-bearing. Every colour comes from the
   theme tokens, so it follows light / black / azure / ember / slate without a
   per-theme rule. The only accent used is the product's single teal, the same
   family the visor eyes glow in: no new hue is introduced, because hue on this
   bot means security state and nothing else. */
.sv-ga-thought { position: fixed; z-index: 899; pointer-events: none;
  max-width: 210px; padding: 8px 12px; border-radius: 16px;
  background: var(--bg-elevated);
  border: 1px solid color-mix(in srgb, var(--accent-primary) 22%, transparent);
  font-size: 12px; font-weight: 600; letter-spacing: 0.01em; line-height: 1.4;
  box-shadow: 0 6px 18px rgba(0,0,0,0.28),
    0 0 22px color-mix(in srgb, var(--accent-primary) 14%, transparent);
  opacity: 0; transform: translateY(7px) scale(0.92);
  transition: opacity 300ms ease,
    transform 420ms cubic-bezier(0.34, 1.45, 0.64, 1); /* a soft pop, not a snap */
  will-change: transform, opacity; }
.sv-ga-thought.show { opacity: 1; transform: translateY(0) scale(1);
  /* a real thought floats; the delay lets the pop finish first */
  animation: sv-ga-drift 4.6s ease-in-out 600ms infinite alternate; }
@keyframes sv-ga-drift { from { transform: translateY(0) scale(1); }
  to { transform: translateY(-3px) scale(1); } }
.sv-ga-thought.show.sv-ga-ghost { opacity: 0.5; }
/* Two trailing puffs, the classic thought-bubble tail, leaning towards the
   head when the cloud has been pushed sideways by a viewport edge. */
.sv-ga-thought::before, .sv-ga-thought::after { content: ''; position: absolute;
  border-radius: 50%; background: var(--bg-elevated);
  border: 1px solid color-mix(in srgb, var(--accent-primary) 22%, transparent); }
.sv-ga-thought::before { width: 10px; height: 10px; bottom: -7px;
  left: calc(50% + var(--lean, 0px) * 0.55 - 5px); }
.sv-ga-thought::after { width: 6px; height: 6px; bottom: -17px;
  left: calc(50% + var(--lean, 0px) * 0.85 - 3px); }
/* Shine: a highlight travels across the words, the way light moves over the
   visor. Text stays fully legible at every point of the sweep because the
   base colour on both sides of the highlight is the theme's own body colour. */
/* The thought reads in the bot's own ink: white against a dark theme, the
   Guardian's dark visor tone against a light one. Both are the colour of the
   character, not a status, so nothing here can be misread as a severity. */
:root { --sv-ga-ink: #ffffff;
  --sv-ga-glow: color-mix(in srgb, var(--accent-primary) 30%, transparent);
  --sv-ga-glow-peak: color-mix(in srgb, var(--accent-primary) 48%, transparent); }
[data-theme="light"] { --sv-ga-ink: #2a323c;
  --sv-ga-glow: color-mix(in srgb, var(--accent-primary) 42%, transparent);
  --sv-ga-glow-peak: color-mix(in srgb, var(--accent-primary) 62%, transparent); }
.sv-ga-thought-t { display: inline; color: var(--sv-ga-ink);
  background-image: linear-gradient(100deg,
    var(--sv-ga-ink) 0%, var(--sv-ga-ink) 38%,
    color-mix(in srgb, var(--accent-primary) 70%, var(--sv-ga-ink)) 50%,
    var(--sv-ga-ink) 62%, var(--sv-ga-ink) 100%);
  /* Tiled, not no-repeat: the gradient's first and last stops are the same
     body colour, so it tiles seamlessly, and the text still paints at every
     position the sweep reaches. With no-repeat the starting offset put the
     whole gradient outside the text box and the words vanished. */
  background-size: 260% 100%; background-repeat: repeat;
  -webkit-box-decoration-break: clone; box-decoration-break: clone;
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent; color: transparent;
  animation: sv-ga-sheen 7.5s ease-in-out infinite; }
@keyframes sv-ga-sheen {
  /* the highlight crosses in the first third, then the text rests: a sheen
     that sweeps continuously reads as a progress indicator, which this is not */
  0%   { background-position: 190% 0; }
  38%  { background-position: -90% 0; }
  100% { background-position: -90% 0; }
}
.sv-ga-thought[data-mode='dots'] { padding: 9px 12px; }
.sv-ga-thought[data-mode='dots'] .sv-ga-thought-t { display: none; }
.sv-ga-thought[data-mode='text'] .sv-ga-dots { display: none; }
.sv-ga-dots { display: flex; gap: 4px; align-items: center; }
.sv-ga-dots b { width: 5px; height: 5px; border-radius: 50%;
  background: var(--accent-primary); opacity: 0.45;
  box-shadow: 0 0 8px color-mix(in srgb, var(--accent-primary) 60%, transparent);
  animation: sv-ga-think 1.25s ease-in-out infinite; }
.sv-ga-dots b:nth-child(2) { animation-delay: 0.16s; }
.sv-ga-dots b:nth-child(3) { animation-delay: 0.32s; }
@keyframes sv-ga-think {
  0%, 60%, 100% { opacity: 0.28; transform: translateY(0); }
  30% { opacity: 0.9; transform: translateY(-3px); }
}
@media (prefers-reduced-motion: reduce) {
  .sv-ga-thought { transition: opacity 120ms linear; transform: none; }
  .sv-ga-thought.show { transform: none; animation: none; }
  .sv-ga-thought-t { animation: none; background-image: none;
    -webkit-text-fill-color: var(--sv-ga-ink); color: var(--sv-ga-ink); }
  .sv-ga-dots b { animation: none; opacity: 0.55; }
}
}
`;
        document.head.appendChild(st);
    },
};

window.GuardianAssistant = GuardianAssistant;
