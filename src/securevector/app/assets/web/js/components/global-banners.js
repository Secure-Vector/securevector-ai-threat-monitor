/**
 * Global banners, retired in 5.3.0.
 *
 * The slot above page content used to carry a Guardian ML disclosure, an
 * enrollment pointer and a release what's-new banner. Product decision:
 * no top banners. Guardian ML is disclosed in Settings and on the welcome
 * screen; enrollment lands the user on Cloud Activity directly.
 *
 * The one line left is the what's-new pointer: after an upgrade it names
 * the running version (from /health) and links its release notes on the
 * docs site until the user dismisses it. A fresh install never sees it.
 */

const GlobalBanners = {
    // Set by the welcome screen on a fresh install; replaced with the running
    // version on the next render so a fresh install never sees the banner.
    WHATS_NEW_VERSION: 'fresh-install',
    KEY_WHATS_NEW: 'sv-whats-new-acked',
    KEY_GUARDIAN_NOTICE: 'sv-guardian-notice-acked',
    KEY_ENROLLED: 'sv-enrolled-banner-acked',
    DOCS_BASE: 'https://docs.securevector.io',

    _versionPromise: null,

    /** Running app version from /health, as "M.m.p", or null. */
    appVersion() {
        if (!this._versionPromise) {
            this._versionPromise = fetch('/health')
                .then(r => (r.ok ? r.json() : null))
                .then(d => this.parseVersion(d && d.version))
                .catch(() => null);
        }
        return this._versionPromise;
    },

    parseVersion(v) {
        const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,4})/.exec(String(v || ''));
        return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
    },

    /** The docs site keeps one release page per minor version
     *  (/release-6-1-0 covers every 6.1.x). */
    releaseNotesUrl(version) {
        const [major, minor] = String(version).split('.');
        return `${this.DOCS_BASE}/release-${major}-${minor}-0`;
    },

    _get(key) {
        try { return localStorage.getItem(key); } catch (_) { return null; }
    },

    _set(key, value) {
        try { localStorage.setItem(key, value); } catch (_) { /* private mode */ }
    },

    /** Whether to show the what's-new line for `version`. A fresh install
     *  records the version here; an upgrader sees the line until dismissed. */
    shouldShowWhatsNew(version) {
        if (!version) return false;
        // Still on the first-launch welcome: a fresh install.
        if (!this._get('sv-welcome-seen-v2')) return false;
        const acked = this._get(this.KEY_WHATS_NEW);
        if (acked === version) return false;
        if (acked === this.WHATS_NEW_VERSION) {
            this._set(this.KEY_WHATS_NEW, version);
            return false;
        }
        return true;
    },

    /** The user closed the line or opened the notes: done for this version. */
    markWhatsNewSeen(version) {
        if (version) this._set(this.KEY_WHATS_NEW, version);
    },

    async render() {
        const old = document.getElementById('sv-global-banners');
        if (old) old.remove();
        if (document.querySelector('.modal-overlay')) return;
        const version = await this.appVersion();
        if (!this.shouldShowWhatsNew(version)) return;
        // No page container yet: nothing is marked, the next render retries.
        const content = document.getElementById('page-content');
        if (!content || !content.parentNode || document.getElementById('sv-global-banners')) return;

        const slot = document.createElement('div');
        slot.id = 'sv-global-banners';
        slot.setAttribute('role', 'status');
        slot.style.cssText = 'display:flex;align-items:center;gap:10px;margin:0 0 12px;padding:8px 12px;'
            + 'border:1px solid var(--border-default);border-radius:8px;background:var(--bg-secondary);'
            + 'font-size:13px;color:var(--text-secondary);';
        const text = document.createElement('span');
        text.style.cssText = 'flex:1;min-width:0;';
        text.textContent = `Updated to ${version}. `;
        const link = document.createElement('a');
        link.href = this.releaseNotesUrl(version);
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = "See what's new";
        link.style.color = 'var(--accent-primary)';
        link.addEventListener('click', () => { this.markWhatsNewSeen(version); slot.remove(); });
        text.appendChild(link);
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'btn btn-sm btn-secondary';
        close.setAttribute('aria-label', 'Dismiss');
        close.textContent = '\u00d7';
        close.addEventListener('click', () => { this.markWhatsNewSeen(version); slot.remove(); });
        slot.appendChild(text);
        slot.appendChild(close);
        content.parentNode.insertBefore(slot, content);
    },
};

window.GlobalBanners = GlobalBanners;
