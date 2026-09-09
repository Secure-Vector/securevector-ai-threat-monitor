/**
 * Desktop chrome bridge.
 *
 * The desktop shell identifies itself through its user agent and answers two
 * loopback routes on the local server: GET /api/desktop/chrome reports the
 * native title-bar inset and flags, POST /api/desktop/chrome/theme binds the
 * native window to the active theme. The page's Content Security Policy has
 * no unsafe-eval, so this goes over HTTP rather than the pywebview JS bridge.
 * In a plain browser the user agent has no token and nothing here runs.
 */
const DesktopChrome = {
    ready: false,
    inset: 0,
    TOKEN: 'SecureVectorDesktop',

    isDesktop() {
        return typeof navigator !== 'undefined' && String(navigator.userAgent).includes(this.TOKEN);
    },

    init() {
        if (!this.isDesktop()) return;
        document.documentElement.classList.add('desktop');
        this._attach();
    },

    async _attach() {
        try {
            const resp = await fetch('/api/desktop/chrome', { cache: 'no-store' });
            if (!resp.ok) return;
            const info = await resp.json();
            this.ready = true;
            const root = document.documentElement;
            if (info && info.platform === 'darwin' && info.unified_titlebar) {
                this.inset = Number(info.titlebar_inset) || 0;
                root.classList.add('desktop-mac');
                root.style.setProperty('--titlebar-inset', `${this.inset}px`);
            }
            if (info && info.context_menu === false && !window.__svNoContextMenu) {
                // Native right-click menu off; the shell keeps it in debug mode so DevTools stays reachable.
                window.__svNoContextMenu = true;
                document.addEventListener('contextmenu', (e) => e.preventDefault(), true);
            }
            const theme = (window.Sidebar && typeof Sidebar.currentTheme === 'function')
                ? Sidebar.currentTheme()
                : (root.getAttribute('data-theme') || 'dark');
            this.syncTheme(theme);
        } catch (_) {
            // Web mode against a desktop port, or an older shell: leave the chrome alone.
        }
    },

    /** Hand the theme id to the native window; called by Sidebar.setTheme. */
    syncTheme(id) {
        if (!this.ready) return;
        try {
            fetch('/api/desktop/chrome/theme', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ theme: id }),
            }).catch(() => {});
        } catch (_) {
            // Best effort only.
        }
    },
};

window.DesktopChrome = DesktopChrome;
DesktopChrome.init();
