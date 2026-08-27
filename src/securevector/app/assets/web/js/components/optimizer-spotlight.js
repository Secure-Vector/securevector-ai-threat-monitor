/**
 * Cost / Token Optimizer first-open spotlight (v5.2.0, #202).
 *
 * A one-time modal on the first open after upgrade whose body is a VISUAL
 * preview of the Optimizer panel: a ranked findings list with estimated
 * values and a per-turn evidence chip, exactly as the real tab renders it.
 *
 * Rendered natively (the app's own CSS), never a bundled screenshot: a real
 * screenshot would carry someone's actual session data (the same rule that
 * keeps Instant Audit screenshots off the website), and a static image breaks
 * in the opposite theme. Synthetic data is clearly labelled until a real scan
 * has findings; then the user's own top finding and total appear, in the
 * leading unit of their billing mode. One appearance, ever.
 *
 * Fresh installs never see it: the welcome modal + tour introduce the feature
 * there, so the spotlight pre-acks itself and stays out of the way.
 */

const OptimizerSpotlight = {
    KEY: 'sv-optimizer-spotlight-acked',

    async maybeShow() {
        try {
            if (localStorage.getItem(this.KEY)) return;
            // Fresh install: the welcome modal and the tour own first contact.
            if (!localStorage.getItem('sv-welcome-seen-v2')) {
                localStorage.setItem(this.KEY, '1');
                return;
            }
        } catch (_) { return; }
        // Never stack on another modal (welcome, wizard). No ack: it simply
        // waits for the next launch.
        if (document.querySelector('.modal-overlay')) return;

        // Real numbers when a scan already found something; labelled
        // synthetic preview otherwise.
        let real = null;
        try {
            const st = await API.getOptimizerStatus();
            if (st && st.has_report) {
                const rep = await API.getOptimizerReport();
                if (rep && (rep.findings || []).length) {
                    real = { rep, mode: (st.prefs && (st.prefs.billing_mode || st.prefs.billing_mode_derived)) || null };
                }
            }
        } catch (_) { /* synthetic preview */ }
        if (document.querySelector('.modal-overlay')) return;
        this._show(real);
    },

    _fmtTok(n) {
        if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
        if (n >= 1e3) return Math.round(n / 1e3) + 'K';
        return String(Math.round(n));
    },

    _lead(tokens, usd, mode) {
        if (mode === 'api' && usd != null) {
            return '≈$' + (usd >= 100 ? Math.round(usd).toLocaleString() : usd.toFixed(2));
        }
        return this._fmtTok(tokens || 0) + ' tok';
    },

    _show(real) {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.style.cssText = 'max-width: 640px; width: 92%;';

        const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
            c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

        let headline, rows, previewTag;
        if (real) {
            const rep = real.rep;
            const obs = rep.observed || {}, mod = rep.modeled_lossless || rep.modeled || {};
            const savedTok = (obs.total_tokens || 0) - (mod.total_tokens || 0);
            const savedUsd = obs.est_cost_usd != null && mod.est_cost_usd != null
                ? obs.est_cost_usd - mod.est_cost_usd : null;
            headline = real.mode === 'subscription'
                ? `~${this._fmtTok(savedTok)} tokens you could get back, from your last ${rep.window_days} days`
                : `${this._lead(savedTok, savedUsd, real.mode)} of estimated avoidable usage in your last ${rep.window_days} days`;
            rows = (rep.findings || []).slice(0, 2).map(f => ({
                type: f.type, lead: this._lead(f.tokens_wasted, f.est_value_usd, real.mode),
                ev: (f.evidence && f.evidence.observed) || '',
            }));
            previewTag = 'From your own sessions · estimates at list price';
        } else {
            headline = 'See why your sessions cost what they did';
            rows = [
                { type: 'repeated_context', lead: '1.4M tok',
                  ev: 'prompt grew ~9,200 tokens/turn across turns 4-31; context older than the last 10 turns was re-sent every turn' },
                { type: 'low_cache_utilization', lead: '760K tok',
                  ev: 'cache hit rate 22% across 27 eligible turns; carried context paid the full input rate instead of the cache-read rate' },
            ];
            previewTag = 'Illustrative example, not your data';
        }
        const LABELS = {
            repeated_context: 'Repeated context', low_cache_utilization: 'Low cache utilisation',
            tool_result_carry: 'Tool-result carry', retry_loop: 'Retry loop',
            duplicate_llm: 'Duplicate requests', excessive_output: 'Excessive output',
            abnormal_loop: 'Abnormal loop shape', model_right_sizing: 'Model right-sizing',
        };

        modal.innerHTML =
            '<div class="modal-header" style="border-bottom:1px solid var(--border-default);">' +
            '<div><div style="font-size:10px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:var(--accent-primary,#5eadb8);">New in v5.2.0</div>' +
            '<div class="modal-title" style="font-family:var(--font-display,inherit);">Cost / Token Optimizer</div></div>' +
            '<button type="button" class="modal-close" aria-label="Dismiss">&times;</button></div>' +
            '<div class="modal-body">' +
            `<p style="color:var(--text-secondary);font-size:14px;line-height:1.55;margin:0 0 14px;">${esc(headline)}. Every finding names the exact session and turn it came from, and links to the evidence in Traces.</p>` +
            '<div style="border:1px solid var(--border-default);border-radius:10px;overflow:hidden;">' +
            `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 14px;background:var(--bg-secondary);font-size:10px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:var(--text-muted);"><span>Findings, ranked by estimated value</span><span>${esc(previewTag)}</span></div>` +
            rows.map(r =>
                '<div style="padding:12px 14px;border-top:1px solid var(--border-default);background:var(--bg-card);">' +
                '<div style="display:flex;align-items:center;gap:10px;">' +
                `<span style="font-weight:600;color:var(--text-primary);font-size:13px;">${esc(LABELS[r.type] || r.type)}</span>` +
                `<span style="margin-left:auto;font-family:var(--font-mono,monospace);font-weight:700;color:var(--text-primary);font-size:14px;">${esc(r.lead)}</span></div>` +
                `<div style="color:var(--text-secondary);font-size:12px;line-height:1.5;margin-top:5px;">${esc(r.ev)}</div>` +
                '<div style="margin-top:7px;"><span style="display:inline-block;padding:1px 8px;border-radius:9999px;font-size:10px;font-weight:600;border:1px solid color-mix(in srgb, var(--accent-primary,#5eadb8) 45%, transparent);color:var(--accent-primary,#5eadb8);">View the turn in Traces</span></div>' +
                '</div>').join('') +
            '</div>' +
            '<p style="color:var(--text-muted);font-size:12px;line-height:1.5;margin:12px 0 0;">Runs entirely on this machine. Token counts are exact; dollar figures are list-price estimates and are labelled, never an invoice claim.</p>' +
            '</div>' +
            '<div class="modal-footer">' +
            '<button type="button" class="btn btn-secondary sv-spot-later">Not now</button>' +
            '<button type="button" class="btn btn-primary sv-spot-open">Open the Optimizer</button>' +
            '</div>';

        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('active'));

        const ack = () => {
            try { localStorage.setItem(this.KEY, '1'); } catch (_) {}
            overlay.classList.remove('active');
            setTimeout(() => overlay.remove(), 200);
        };
        modal.querySelector('.modal-close').addEventListener('click', () => {
            // Dismissed without clicking through: the quiet what's-new banner
            // stays available as the follow-up.
            ack();
            if (window.GlobalBanners) GlobalBanners.render();
        });
        modal.querySelector('.sv-spot-later').addEventListener('click', () => {
            ack();
            if (window.GlobalBanners) GlobalBanners.render();
        });
        modal.querySelector('.sv-spot-open').addEventListener('click', () => {
            ack();
            // CTA taken: the what's-new banner would be a re-nag, pre-ack it.
            try {
                if (window.GlobalBanners) {
                    localStorage.setItem(GlobalBanners.KEY_WHATS_NEW, GlobalBanners.WHATS_NEW_VERSION);
                }
            } catch (_) {}
            if (window.CostsPage) CostsPage._pendingTab = 'optimizer';
            if (window.Sidebar && Sidebar.navigate) Sidebar.navigate('costs');
        });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                ack();
                if (window.GlobalBanners) GlobalBanners.render();
            }
        });
    },
};

window.OptimizerSpotlight = OptimizerSpotlight;
