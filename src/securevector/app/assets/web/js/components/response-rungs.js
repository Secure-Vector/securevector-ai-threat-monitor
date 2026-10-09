/**
 * Response rungs on Agent Sessions: the facts chip, the session summary's
 * Response row and the Settings card. Plain words only. Colour carries
 * security state: observe is neutral, flag is amber, step-up is red, and a
 * step-up that only ran in shadow is a muted red outline. Buttons are wired
 * with listeners, never inline handlers, so the page CSP holds.
 */
const ResponseRungs = {
    _esc(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    REASON_WORDS: {
        drift: 'drift band',
        config: 'setup change',
        deny: 'retried after a denial',
    },
    HARNESS_WORDS: {
        'claude-code': 'Claude Code', codex: 'Codex', 'copilot-cli': 'Copilot CLI', antigravity: 'Antigravity',
    },

    /** The word shown for a rung and mode. */
    word(rungWord, mode) {
        const w = rungWord === 'flag' || rungWord === 'step-up' ? rungWord : 'observe';
        return w === 'step-up' && mode !== 'active' ? 'step-up, shadow' : w;
    },
    _cls(word) {
        return word === 'step-up, shadow' ? 'is-stepup-shadow' : word === 'step-up' ? 'is-stepup' : word === 'flag' ? 'is-flag' : 'is-observe';
    },

    /** Facts-line chip, or '' when the session has no rung row. */
    chipHtml(t) {
        if (!t || !t.rung_word) return '';
        const word = this.word(t.rung_word, t.rung_mode);
        return `<span class="terminals-task-rung ${this._cls(word)}" title="Response rung: ${this._esc(word)}">${this._esc(word)}</span>`;
    },

    reasonsText(reasons) {
        return (Array.isArray(reasons) ? reasons : []).map(r => this.REASON_WORDS[r] || '').filter(Boolean).join(', ');
    },

    /** Normalise the rung route body for the summary, or null. */
    summaryData(r) {
        if (!r || typeof r !== 'object' || typeof r.word !== 'string') return null;
        return {
            word: r.word, mode: r.mode === 'active' ? 'active' : 'shadow', rung: Number(r.rung) || 1,
            reasons: Array.isArray(r.reasons) ? r.reasons.filter(x => typeof x === 'string') : [],
            feedback: r.feedback === 'not_needed' ? 'not_needed' : null,
            wouldAsk: Number(r.would_ask) || 0, pinned: !!r.pinned,
        };
    },

    /** The Response row body. `ended` hides the stop button. */
    summaryHtml(d, ended) {
        const word = this.word(d.word, d.mode);
        const why = this.reasonsText(d.reasons);
        let html = `<span class="terminals-rung-word ${this._cls(word)}">${this._esc(word)}</span>${why ? `: ${this._esc(why)}` : ''}`;
        if (d.mode !== 'active' && d.wouldAsk > 0) {
            html += ` <span class="terminals-summary-more">would need approval for ${this._esc(d.wouldAsk)} ${d.wouldAsk === 1 ? 'call' : 'calls'}</span>`;
        }
        const btn = (attr, label, extra) => `<button type="button" class="btn btn-sm${extra || ''}" ${attr}>${label}</button>`;
        const acts = [];
        if (d.rung > 1 || d.pinned) acts.push(btn('data-rung-release', 'Back to observe'));
        if (d.rung > 1 && d.feedback !== 'not_needed') acts.push(btn('data-rung-notneeded', 'Not needed'));
        if (d.rung === 3 && !ended) acts.push(btn('data-rung-stop', 'Stop session'));
        if (d.feedback === 'not_needed') html += ' <span class="terminals-summary-more" data-rung-marked>Marked not needed</span>';
        if (acts.length) html += `<div class="terminals-rung-actions">${acts.join('')}</div>`;
        return html;
    },

    /** Wire the Response row buttons inside `host`. */
    wire(host, task, d, api, onStop) {
        if (!host || !host.querySelector) return;
        const hook = (sel, fn, failText) => {
            const el = host.querySelector(sel);
            if (!el) return;
            el.onclick = async (ev) => {
                if (ev && ev.preventDefault) ev.preventDefault();
                try { await fn(); } catch (e) { el.textContent = failText; }
            };
        };
        hook('[data-rung-release]', async () => {
            const r = await api.terminalsRungRelease(task.id);
            const nd = this.summaryData(r);
            const cell = host.querySelector('[data-rung-cell]');
            if (nd && cell) { cell.innerHTML = this.summaryHtml(nd, !!task.ended_at); this.wire(host, task, nd, api, onStop); }
        }, 'Could not save, try again');
        hook('[data-rung-notneeded]', async () => {
            await api.terminalsRungFeedback(task.id, 'not_needed');
            const cell = host.querySelector('[data-rung-cell]');
            const nd = Object.assign({}, d, { feedback: 'not_needed' });
            if (cell) { cell.innerHTML = this.summaryHtml(nd, !!task.ended_at); this.wire(host, task, nd, api, onStop); }
        }, 'Could not save, try again');
        hook('[data-rung-stop]', async () => { await onStop(task); }, 'Could not stop, try again');
    },

    // --- Settings card -----------------------------------------------------

    harnessLabel(id) { return this.HARNESS_WORDS[id] || String(id || ''); },

    progressText(m) {
        return `${m.sessions} of ${m.sessions_needed} sessions, ${m.days} of ${m.days_needed} days, ${m.unintended} unintended`;
    },

    modeRowHtml(m) {
        const active = m.mode === 'active';
        const id = this._esc(m.harness);
        const state = active ? 'Active' : (m.can_activate ? 'Shadow, ready' : 'Shadow');
        const prog = this.progressText(m) + (m.early_ended && !m.complete ? ', ended early' : '');
        const acts = active
            ? `<button type="button" class="btn btn-sm" data-rung-shadow="${id}">Back to shadow</button>`
            : `<button type="button" class="btn btn-sm btn-primary" data-rung-on="${id}"${m.can_activate ? '' : ' disabled'}>Turn on</button>`
              + (m.can_activate ? '' : `<button type="button" class="btn btn-sm" data-rung-early="${id}">End shadow early</button>`)
              + `<button type="button" class="btn btn-sm" data-rung-shadow="${id}">Back to shadow</button>`;
        return `<div class="rung-mode-row" data-rung-row="${id}"><div class="rung-mode-head"><strong>${this._esc(this.harnessLabel(m.harness))}</strong>`
            + `<span class="rung-mode-state">${this._esc(state)}</span></div>`
            + `<div class="rung-mode-progress">${this._esc(prog)}</div>`
            + `<div class="rung-mode-actions">${acts}</div><div class="rung-mode-confirm" data-rung-confirm="${id}" hidden></div></div>`;
    },

    wouldHaveText(w) {
        if (!w || !w.count) return 'Shadow has not stepped up any session so far.';
        const top = (w.top_reasons || []).map(x => `${this.REASON_WORDS[x.signal] || x.signal} (${x.sessions})`).join(', ');
        return `Shadow would have stepped up ${w.count} ${w.count === 1 ? 'session' : 'sessions'}${top ? `, mostly ${top}` : ''}.`;
    },

    /** Fill `host` with one row per harness and wire its buttons. */
    async renderCard(host, api) {
        if (!host) return;
        let data;
        try { data = await api.terminalsRungModes(); } catch (e) {
            host.innerHTML = '<div class="rung-mode-empty">Response rungs could not be loaded.</div>'; return;
        }
        const modes = (data && data.modes) || [];
        if (!modes.length) {
            host.innerHTML = '<div class="rung-mode-empty">No agent sessions have run yet. Rungs start in shadow, where they only record.</div>';
            return;
        }
        host.innerHTML = modes.map(m => this.modeRowHtml(m)).join('');
        const reload = () => this.renderCard(host, api);
        const confirmBox = (id) => host.querySelector(`[data-rung-confirm="${id}"]`);
        const ask = (id, text, label, run) => {
            const box = confirmBox(id);
            if (!box) return;
            box.hidden = false;
            box.innerHTML = `<span>${this._esc(text)}</span> <button type="button" class="btn btn-sm btn-primary" data-rung-go>${this._esc(label)}</button>`
                + ' <button type="button" class="btn btn-sm" data-rung-cancel>Cancel</button>';
            box.querySelector('[data-rung-cancel]').onclick = () => { box.hidden = true; };
            box.querySelector('[data-rung-go]').onclick = async () => {
                try { await run(); await reload(); } catch (e) {
                    box.innerHTML = `<span class="rung-mode-error">${this._esc((e && e.message) || 'Could not change the mode')}</span>`;
                }
            };
        };
        host.querySelectorAll('[data-rung-on]').forEach(b => {
            b.onclick = () => {
                const id = b.getAttribute('data-rung-on');
                ask(id, 'Step-up calls in a flagged session will wait for your approval in that session only.', 'Turn on',
                    () => api.terminalsRungMode(id, { mode: 'active' }));
            };
        });
        host.querySelectorAll('[data-rung-shadow]').forEach(b => {
            b.onclick = async () => {
                const id = b.getAttribute('data-rung-shadow');
                try { await api.terminalsRungMode(id, { mode: 'shadow' }); await reload(); } catch (e) {
                    const box = confirmBox(id);
                    if (box) { box.hidden = false; box.innerHTML = `<span class="rung-mode-error">${this._esc((e && e.message) || 'Could not change the mode')}</span>`; }
                }
            };
        });
        host.querySelectorAll('[data-rung-early]').forEach(b => {
            b.onclick = async () => {
                const id = b.getAttribute('data-rung-early');
                let w = null;
                try { w = (await api.terminalsRungHarness(id)).would_have; } catch (e) { /* confirm still shows */ }
                ask(id, `${this.wouldHaveText(w)} Ending shadow early lets you turn rungs on before the sample is complete.`,
                    'End shadow early', () => api.terminalsRungMode(id, { end_shadow_early: true }));
            };
        });
    },
};
if (typeof window !== 'undefined') window.ResponseRungs = ResponseRungs;
