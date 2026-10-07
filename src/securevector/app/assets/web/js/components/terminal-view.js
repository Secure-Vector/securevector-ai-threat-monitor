// src/securevector/app/assets/web/js/components/terminal-view.js
// xterm.js wrapper for the attached terminal. One instance per attach.
// Renderer: WebGL with DOM fallback on macOS and Windows; DOM only on Linux
// (WebGL contexts in WebKitGTK were the spike's failure case). No canvas
// addon, no web-links addon, no proposed API: the terminal shows bytes and
// forwards keystrokes, nothing else.
(function () {
    // navigator.platform is deprecated but there is no replacement with the
    // same synchronous, no-permission availability; User-Agent Client Hints
    // (navigator.userAgentData.platform) is not available in all embedders.
    const IS_LINUX = /Linux/.test(navigator.platform) && !/Android/.test(navigator.userAgent);

    const THEME = {
        background: '#0b0f14', foreground: '#d5dbe3', cursor: '#d5dbe3',
        selectionBackground: 'rgba(120, 160, 200, 0.35)',
    };

    function b64ToBytes(s) {
        const bin = atob(s || '');
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function strToB64(str) {
        const bytes = new TextEncoder().encode(str);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    }

    class TerminalView {
        constructor(container, { onInput, onResize } = {}) {
            if (typeof Terminal === 'undefined' || typeof FitAddon === 'undefined') {
                throw new Error('Terminal assets failed to load');
            }
            this.container = container;
            this.term = new Terminal({
                allowProposedApi: false,
                cursorBlink: true,
                scrollback: 5000,
                fontSize: 13,
                fontFamily: 'SF Mono, Menlo, Consolas, "DejaVu Sans Mono", monospace',
                theme: THEME,
                convertEol: false,
                // Never let the child drive the window: every windowOptions
                // report is off by default; keep it that way explicitly.
                windowOptions: {},
            });
            this.fit = new FitAddon.FitAddon();
            this.term.loadAddon(this.fit);
            this.term.open(container);
            // Swallow the escape sequences a hostile agent could use to reach
            // outside the viewport. Returning true marks them handled so
            // xterm never falls back to a built-in. 52 = clipboard set/get,
            // 1337 = iTerm2 file transfer, 7 = cwd report, 9 = notifications.
            this._oscDisposables = [52, 1337, 7, 9].map((osc) =>
                this.term.parser.registerOscHandler(osc, () => true)
            );
            this.renderer = this._selectRenderer();
            this._dataDisposable = this.term.onData((d) => onInput(strToB64(d)));
            this._resizeDisposable = this.term.onResize(({ rows, cols }) => onResize(rows, cols));
            this._onWindowResize = () => this.fitNow();
            window.addEventListener('resize', this._onWindowResize);
            this._resizeObserver = null;
            if (window.ResizeObserver) {
                this._resizeObserver = new ResizeObserver(() => this.fitNow());
                this._resizeObserver.observe(container);
            }
            this.fitNow();
        }

        _selectRenderer() {
            if (IS_LINUX || !window.WebglAddon) return 'dom';
            try {
                const webgl = new WebglAddon.WebglAddon();
                webgl.onContextLoss(() => {
                    try { webgl.dispose(); } catch (e) { /* DOM takes over */ }
                    this._webgl = null;
                    this.renderer = 'dom';
                });
                this.term.loadAddon(webgl);
                this._webgl = webgl;
                return 'webgl';
            } catch (e) {
                console.warn('Terminals: WebGL renderer unavailable, using DOM', e);
                return 'dom';
            }
        }

        fitNow() {
            try { this.fit.fit(); } catch (e) { /* container not laid out yet */ }
        }

        write(b64) {
            let bytes;
            try {
                bytes = b64ToBytes(b64);
            } catch (e) {
                console.debug('Terminals: dropping malformed frame', e);
                return;
            }
            this.term.write(bytes);
        }

        get size() {
            return { rows: this.term.rows, cols: this.term.cols };
        }

        focus() { this.term.focus(); }

        dispose() {
            window.removeEventListener('resize', this._onWindowResize);
            try { if (this._resizeObserver) this._resizeObserver.disconnect(); } catch (e) { /* already gone */ }
            try { this._dataDisposable.dispose(); } catch (e) { /* already gone */ }
            try { this._resizeDisposable.dispose(); } catch (e) { /* already gone */ }
            try {
                (this._oscDisposables || []).forEach((d) => d.dispose());
            } catch (e) { /* already gone */ }
            try { if (this._webgl) this._webgl.dispose(); } catch (e) { /* already gone */ }
            try { this.term.dispose(); } catch (e) { /* already gone */ }
        }
    }

    window.TerminalView = TerminalView;
})();
