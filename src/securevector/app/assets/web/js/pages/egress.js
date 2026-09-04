/**
 * Agent Egress — destination governance.
 *
 * Two tabs, ordered by what the operator needs first:
 *
 *   Destinations  Blast radius: every external host the agents on this device
 *                 actually reached. The number nobody currently has.
 *   Policy        The controls, plus the counterfactual that makes the strict
 *                 presets enableable instead of decorative.
 *
 * CONTAINMENT SELF-TEST IS WITHHELD (not deleted). It never shipped — the
 * feature was cut before its first release. The rendering code below and the
 * whole `/api/egress/proof*` backend are intact and unreferenced; restoring the
 * tab entry in `render()` brings it back. Two problems have to be solved first:
 *
 * 1. It did not prove what its name claimed. The probes call `evaluate_tool_call`
 *    in-process, so the run never crosses the installed hook, this app's own API,
 *    or the harness. A machine where the plugin was never installed still returns
 *    `contained` — confidence manufactured out of a unit test.
 * 2. It sent real requests from a customer machine to third parties
 *    (webhook.site, the cloud IMDS address, npm, PyPI) and, in a healthy
 *    deployment where every dangerous path is blocked before execution, the only
 *    packet that actually left established that the machine has internet.
 *
 * The replacement worth building is a zero-egress enforcement self-test: feed a
 * synthetic PreToolUse event to the *installed* hook and assert the verdict comes
 * back `deny`. That exercises plugin → hook → API → policy end to end and
 * contacts nobody.
 *
 * SOC colour discipline: red means a dangerous path reached the network, amber
 * means the result is inconclusive or the guarantee moved off SecureVector,
 * teal is the one interactive accent. Nothing here is decorative.
 *
 * Retained for the dormant code: a `degraded` proof is NOT a pass and must never
 * be styled like one, and coverage gaps render on the page rather than behind a
 * "details" link.
 */

const EgressPage = {
    _state: {
        tab: 'destinations',
        proof: null,
        drift: null,
        running: false,
        preflightOpen: false,
        policy: null,
        health: null,
        blast: null,
        destinations: [],
        replay: null,
        replayPreset: null,
        windowDays: 30,
    },

    async render(container) {
        container.textContent = '';
        // Two sidebar destinations share this page: "Agent Egress" under
        // Visibility shows what agents reached; "Egress Policy" under
        // Policies shows what they may reach. The route decides the view,
        // so there is no in-page tab bar; each view links to the other.
        // (The withheld containment self-test keeps its loader and renderer;
        // set _state.tab = 'containment' to bring it back.)
        if (this._state.tab !== 'containment') {
            this._state.tab = (window.App && App.currentPage === 'egress-policy') ? 'policy' : 'destinations';
        }
        const policyView = this._state.tab === 'policy';
        if (window.Header) {
            if (policyView) Header.setPageInfo('Egress Policy', 'Where agents may reach: allow, block or log per destination.');
            else Header.setPageInfo('Agent Egress', 'Every external host your agents reached, first seen and how often.');
        }
        this._injectStyle();

        const cross = document.createElement('div');
        cross.className = 'eg-cross';
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'eg-cross-link';
        link.textContent = policyView ? 'See the destinations agents reached' : 'Manage the egress policy';
        link.addEventListener('click', () => {
            if (window.App && typeof App.loadPage === 'function') App.loadPage(policyView ? 'egress' : 'egress-policy');
        });
        cross.appendChild(link);
        container.appendChild(cross);

        const body = document.createElement('div');
        body.id = 'eg-body';
        body.innerHTML = '<div class="eg-empty">Loading…</div>';
        container.appendChild(body);

        if (this._state.tab === 'containment') await this._loadContainment();
        else if (this._state.tab === 'destinations') await this._loadDestinations();
        else await this._loadPolicy();
    },

    // ==================================================== containment tab ===

    async _loadContainment() {
        const [proof, drift] = await Promise.all([
            API.getLatestContainmentProof(),
            API.getContainmentDrift(),
        ]);
        this._state.proof = proof;
        this._state.drift = drift;
        this._renderContainment();
    },

    _renderContainment() {
        const body = document.getElementById('eg-body');
        if (!body) return;
        body.textContent = '';

        const proof = this._state.proof;

        // Renders in both states, above everything. The rows on this tab name
        // real attack techniques against real hosts; without a standing notice
        // that SecureVector generated them, a glance or a screenshot reads as
        // an incident report about the user's own agents.
        body.appendChild(this._simBanner());

        if (!proof) {
            body.appendChild(this._firstRunCard());
            return;
        }

        body.appendChild(this._verdictCard(proof));
        if (this._state.drift) body.appendChild(this._driftCard(this._state.drift));
        body.appendChild(this._probeTable(proof));
        body.appendChild(this._coverageCard(proof));
        body.appendChild(this._exportBar(proof));
    },

    /** Deliberately untoned. The SOC palette reserves amber for an inconclusive
     *  result and red for a path that got out; colouring a permanent
     *  explanatory notice would spend a signal that means something else. */
    _simBanner() {
        const el = document.createElement('div');
        el.className = 'eg-card eg-simbanner';
        el.innerHTML =
            '<h3>These calls are SecureVector\'s own. They are not your agents\' activity.</h3>' +
            '<p>Every row on this tab is a probe this app generates when you press ' +
            'run, against a fixed list of destinations. <strong>The attack is ' +
            'simulated</strong> — the command shown names the technique being ' +
            'tested, and no data of yours is ever sent. <strong>The measurement ' +
            'is real</strong>: a path SecureVector does not block makes a genuine ' +
            'request, which is the only way the last column can report something ' +
            'neither your agent nor your harness can report about itself.</p>' +
            '<p class="eg-note">Nothing here is recorded as a threat, and none of ' +
            'it counts toward your dashboard. To see where your agents actually ' +
            'went, use the Destinations tab.</p>';
        return el;
    },

    _firstRunCard() {
        const wrap = document.createElement('div');
        wrap.className = 'eg-card eg-firstrun';
        wrap.innerHTML =
            '<h3>No containment proof has been run on this device</h3>' +
            '<p>Containment is usually believed rather than checked. This test ' +
            'attempts a small, fixed set of network operations through the real ' +
            'tool path and reports three things for each: whether SecureVector ' +
            'stopped it, whether your own network stopped it, and whether it ' +
            'reached the internet anyway. The third column is the one you cannot ' +
            'produce for yourself.</p>';
        const actions = document.createElement('div');
        actions.className = 'eg-actions';
        actions.appendChild(this._runButton());
        const pf = document.createElement('button');
        pf.type = 'button';
        pf.className = 'eg-btn ghost';
        pf.textContent = 'What will it do?';
        pf.addEventListener('click', () => this._togglePreflight(wrap));
        actions.appendChild(pf);
        wrap.appendChild(actions);
        return wrap;
    },

    _runButton() {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'eg-btn primary';
        btn.textContent = this._state.running ? 'Running…' : 'Run containment proof';
        btn.disabled = this._state.running;
        btn.addEventListener('click', () => this._runProof());
        return btn;
    },

    async _togglePreflight(host) {
        const existing = host.querySelector('.eg-preflight');
        if (existing) { existing.remove(); return; }
        const manifest = await API.getContainmentPreflight();
        const box = document.createElement('div');
        box.className = 'eg-preflight';
        if (!manifest) {
            box.textContent = 'Could not load the preflight manifest.';
            host.appendChild(box);
            return;
        }
        const list = (items) => '<ul>' + (items || [])
            .map(i => `<li>${this._esc(i)}</li>`).join('') + '</ul>';
        box.innerHTML =
            `<p>${this._esc(manifest.description)}</p>` +
            '<h4>Destinations contacted</h4>' + list(manifest.destinations) +
            '<h4>Operations performed</h4>' + list(manifest.operations) +
            '<h4>What it never does</h4>' + list(manifest.never_does) +
            `<p class="eg-note">${this._esc(manifest.note_for_endpoint_security || '')}</p>`;
        host.appendChild(box);
    },

    async _runProof() {
        this._state.running = true;
        this._renderContainment();
        const body = document.getElementById('eg-body');
        if (body) {
            const note = document.createElement('div');
            note.className = 'eg-running';
            note.textContent = 'Attempting each path. This takes a few seconds.';
            body.appendChild(note);
        }
        try {
            const result = await API.runContainmentProof('manual');
            this._state.proof = result;
            this._state.drift = result.drift || null;
            if (window.Toast) {
                Toast.show(`Containment proof complete: ${result.verdict}`,
                    result.verdict === 'contained' ? 'success' : 'warning');
            }
        } catch (e) {
            if (window.Toast) Toast.show('Containment proof failed: ' + e.message, 'error');
        } finally {
            this._state.running = false;
            this._renderContainment();
        }
    },

    /** Verdict copy is duplicated from the server on purpose: the page must
     *  read correctly even if a future response trims the prose. */
    _VERDICT: {
        contained: {
            tone: 'ok',
            line: 'Every dangerous path tested was stopped by SecureVector before the call executed.',
        },
        partial: {
            tone: 'warn',
            line: 'Nothing dangerous reached the network, but not everything was stopped by SecureVector. ' +
                  'The rest was stopped by your own network, which this policy does not manage and cannot notice changing.',
        },
        uncontained: {
            tone: 'bad',
            line: 'At least one dangerous path reached the network. This device is not contained for those paths.',
        },
        degraded: {
            tone: 'warn',
            line: 'Containment could NOT be established. This machine could not reach the internet during the test, ' +
                  'so "nothing got out" carries no information. These results are inconclusive, not a pass.',
        },
        error: {
            tone: 'warn',
            line: 'The test did not complete. No conclusion about containment can be drawn from this run.',
        },
    },

    _verdictCard(proof) {
        const verdict = (proof.verdict || 'error').toLowerCase();
        const meta = this._VERDICT[verdict] || this._VERDICT.error;
        const card = document.createElement('div');
        card.className = 'eg-card eg-verdict tone-' + meta.tone;

        const top = document.createElement('div');
        top.className = 'eg-verdict-top';
        const word = document.createElement('div');
        word.className = 'eg-verdict-word';
        word.textContent = verdict;
        top.appendChild(word);

        const stamp = document.createElement('div');
        stamp.className = 'eg-verdict-stamp';
        stamp.textContent = `${this._rel(proof.started_at)} · ${proof.policy_preset || 'baseline'} preset`;
        top.appendChild(stamp);
        card.appendChild(top);

        const line = document.createElement('p');
        line.className = 'eg-verdict-line';
        line.textContent = meta.line;
        card.appendChild(line);

        const s = proof.summary || this._summaryFromProbes(proof.probes || []);
        const counts = document.createElement('div');
        counts.className = 'eg-counts';
        counts.appendChild(this._count(s.blocked_by_securevector, 'stopped by SecureVector'));
        // Tone only when the number is non-zero. A coloured zero reads as a
        // warning about something that did not happen.
        counts.appendChild(this._count(s.blocked_by_network, 'stopped by your network',
            s.blocked_by_network ? 'warn' : null));
        counts.appendChild(this._count(s.reached_anyway, 'reached anyway',
            s.reached_anyway ? 'bad' : null));
        card.appendChild(counts);

        const actions = document.createElement('div');
        actions.className = 'eg-actions';
        actions.appendChild(this._runButton());
        const pf = document.createElement('button');
        pf.type = 'button';
        pf.className = 'eg-btn ghost';
        pf.textContent = 'What will it do?';
        pf.addEventListener('click', () => this._togglePreflight(card));
        actions.appendChild(pf);
        card.appendChild(actions);
        return card;
    },

    _summaryFromProbes(probes) {
        const dangerous = probes.filter(p => p.expect_contained);
        return {
            blocked_by_securevector: dangerous.filter(p => p.blocked_by_securevector).length,
            blocked_by_network: dangerous.filter(p => p.blocked_by_network).length,
            reached_anyway: dangerous.filter(p => p.reached).length,
        };
    },

    _count(value, label, tone) {
        const el = document.createElement('div');
        el.className = 'eg-count' + (tone ? ' tone-' + tone : '');
        el.innerHTML = `<span class="eg-count-val">${Number(value || 0)}</span>` +
            `<span class="eg-count-label">${this._esc(label)}</span>`;
        return el;
    },

    _DRIFT_TONE: {
        regressed: 'bad',
        weakened: 'warn',
        inconclusive: 'muted',
        improved: 'ok',
        stable: 'muted',
    },

    _driftCard(drift) {
        const card = document.createElement('div');
        const tone = this._DRIFT_TONE[drift.status] || 'muted';
        card.className = 'eg-card eg-drift tone-' + tone;

        const head = document.createElement('div');
        head.className = 'eg-drift-head';
        head.innerHTML =
            `<span class="eg-drift-label">Change since the previous proof</span>` +
            `<span class="eg-drift-status">${this._esc(drift.status || 'unknown')}</span>`;
        card.appendChild(head);

        const reason = document.createElement('p');
        reason.className = 'eg-drift-reason';
        reason.textContent = drift.reason || '';
        card.appendChild(reason);

        (drift.changes || []).forEach(change => {
            const row = document.createElement('div');
            row.className = 'eg-drift-row';
            row.innerHTML =
                `<span class="eg-drift-probe">${this._esc(change.title || change.probe_id)}</span>` +
                `<span class="eg-drift-move">${this._esc(change.from || 'not tested')}` +
                ` &rarr; ${this._esc(change.to || 'not tested')}</span>`;
            const note = document.createElement('div');
            note.className = 'eg-drift-note';
            note.textContent = change.note || '';
            row.appendChild(note);
            card.appendChild(row);
        });
        return card;
    },

    _probeTable(proof) {
        const wrap = document.createElement('div');
        wrap.className = 'eg-card';
        wrap.appendChild(this._sectionTitle('Results',
            'One row per simulated path, each attempted by SecureVector — not by your agents. ' +
            'The last column is the one no agent and no harness can report about itself.'));

        const table = document.createElement('table');
        table.className = 'eg-table';
        table.innerHTML =
            '<thead><tr>' +
            '<th>Simulated path</th>' +
            '<th class="num">Stopped by SecureVector</th>' +
            '<th class="num">Stopped by your network</th>' +
            '<th class="num">Reached anyway</th>' +
            '</tr></thead>';
        const tbody = document.createElement('tbody');

        (proof.probes || []).forEach(p => {
            const tr = document.createElement('tr');
            if (p.reached && p.expect_contained) tr.className = 'bad';

            // The control probe's category IS "control", so printing both would
            // read "control · control". It gets the explanatory line instead.
            const meta = p.expect_contained
                ? `simulated · ${this._esc(p.category || '')}`
                : 'control, expected to reach the network';
            const first = document.createElement('td');
            first.innerHTML =
                `<div class="eg-probe-title">${this._esc(p.title || p.id)}</div>` +
                `<div class="eg-probe-meta">${meta}</div>` +
                `<code class="eg-probe-dest">${this._esc(p.destination || '')}</code>` +
                // The backend already distinguishes "blocked before execution"
                // from "ran and was refused". Dropping it left the table unable
                // to say the call never happened — the CSV export could, the
                // screen could not.
                (p.detail ? `<div class="eg-probe-detail">${this._esc(p.detail)}</div>` : '');
            tr.appendChild(first);

            tr.appendChild(this._mark(p.blocked_by_securevector, 'ok'));
            tr.appendChild(this._mark(p.blocked_by_network, 'warn'));
            tr.appendChild(this._mark(p.reached, p.expect_contained ? 'bad' : 'ok'));
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        return wrap;
    },

    _mark(on, tone) {
        const td = document.createElement('td');
        td.className = 'num';
        if (on) {
            td.innerHTML = `<span class="eg-mark tone-${tone}">yes</span>`;
        } else {
            td.innerHTML = '<span class="eg-mark off">no</span>';
        }
        return td;
    },

    _coverageCard(proof) {
        const card = document.createElement('div');
        card.className = 'eg-card eg-coverage';
        card.appendChild(this._sectionTitle('What this proof does not establish',
            'Printed rather than footnoted. An attestation that implies coverage it does not have is worse than none.'));
        const ul = document.createElement('ul');
        (proof.coverage || []).forEach(line => {
            const li = document.createElement('li');
            li.textContent = line;
            ul.appendChild(li);
        });
        card.appendChild(ul);
        return card;
    },

    _exportBar(proof) {
        const bar = document.createElement('div');
        bar.className = 'eg-exportbar';
        const label = document.createElement('span');
        label.className = 'eg-export-label';
        label.textContent = 'Export attestation';
        bar.appendChild(label);
        [['Markdown', 'md'], ['CSV', 'csv'], ['JSON', 'json']].forEach(([text, ext]) => {
            const a = document.createElement('a');
            a.className = 'eg-btn ghost';
            a.href = `/api/egress/proof/export.${ext}?proof_id=${encodeURIComponent(proof.id)}`;
            a.textContent = text;
            a.setAttribute('download', '');
            bar.appendChild(a);
        });
        const hash = document.createElement('code');
        hash.className = 'eg-hash';
        hash.textContent = (proof.result_hash || '').slice(0, 16);
        hash.title = 'Proofs are hash-chained: a removed or edited run breaks the chain.';
        bar.appendChild(hash);
        return bar;
    },

    // =================================================== destinations tab ===

    async _loadDestinations() {
        const [blast, inv, scope] = await Promise.all([
            API.getEgressBlastRadius(this._state.windowDays),
            API.getEgressDestinations(this._state.windowDays),
            API.getEgressScope(7),
        ]);
        this._state.blast = blast;
        this._state.destinations = (inv && inv.destinations) || [];
        this._state.scope = scope;
        this._renderDestinations();
    },

    _renderDestinations() {
        const body = document.getElementById('eg-body');
        if (!body) return;
        body.textContent = '';
        const blast = this._state.blast;

        if (!blast || !blast.distinct_hosts) {
            const empty = document.createElement('div');
            empty.className = 'eg-card eg-empty-clear';
            empty.innerHTML =
                '<h3>No agent egress recorded yet</h3>' +
                '<p>Once a Guard-protected runtime makes a network-capable tool call, ' +
                'every destination it reaches lands here. This is the blast radius: ' +
                'not how many things were blocked, but how far the agents on this ' +
                'device can actually get.</p>';
            body.appendChild(empty);
            return;
        }

        const stats = document.createElement('div');
        stats.className = 'eg-stats';
        stats.appendChild(this._stat(blast.distinct_hosts, 'external hosts reached', true));
        stats.appendChild(this._stat(blast.write_capable_hosts, 'reached with a write'));
        stats.appendChild(this._stat(blast.first_seen_recently,
            `first seen in ${blast.new_within_days} days`,
            false, blast.first_seen_recently > 0 ? 'warn' : null));
        stats.appendChild(this._stat(blast.blocked_calls, 'calls blocked'));
        body.appendChild(stats);

        const scopeCard = this._scopeCard(this._state.scope);
        if (scopeCard) body.appendChild(scopeCard);

        const note = document.createElement('p');
        note.className = 'eg-note';
        note.textContent = blast.coverage || '';
        body.appendChild(note);

        const card = document.createElement('div');
        card.className = 'eg-card';
        card.appendChild(this._sectionTitle('Every destination reached',
            'Most active first. Promote a host to allow it under a stricter preset.'));

        const table = document.createElement('table');
        table.className = 'eg-table';
        table.innerHTML =
            '<thead><tr><th>Host</th><th class="num">Calls</th>' +
            '<th class="num">Writes</th><th class="num">Blocked</th>' +
            '<th>Last seen</th><th></th></tr></thead>';
        const tbody = document.createElement('tbody');
        this._state.destinations.forEach(d => {
            const tr = document.createElement('tr');
            tr.innerHTML =
                `<td><code>${this._esc(d.host)}</code></td>` +
                `<td class="num">${Number(d.calls || 0)}</td>` +
                `<td class="num">${Number(d.writes || 0)}</td>` +
                `<td class="num${d.blocked ? ' bad-text' : ''}">${Number(d.blocked || 0)}</td>` +
                `<td class="muted">${this._esc(this._rel(d.last_seen))}</td>`;
            const actionTd = document.createElement('td');
            actionTd.className = 'num';
            if (d.promotable === false) {
                // Baseline decides before the allowlist is consulted, so a
                // promotion here would do nothing. Offering the button anyway
                // would be offering a control that silently fails.
                const note = document.createElement('span');
                note.className = 'eg-nopromote';
                note.textContent = 'policy edit';
                note.title = 'Blocked by a rule that a one-click allow cannot clear. ' +
                    'Publish interdiction and the cloud metadata endpoint need an ' +
                    'explicit policy change.';
                actionTd.appendChild(note);
            } else {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'eg-btn tiny';
                btn.textContent = 'Allow';
                btn.addEventListener('click', () => this._promote(d.host, btn));
                actionTd.appendChild(btn);
            }
            tr.appendChild(actionTd);
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        card.appendChild(table);
        body.appendChild(card);
    },

    /** Only rendered when there is something to say. A permanently-visible
     *  "no unusual activity" banner is furniture, and furniture stops being
     *  read long before the day it says something different. */
    _scopeCard(scope) {
        if (!scope || scope.status === 'quiet' || scope.status === 'insufficient_baseline') {
            return null;
        }
        const card = document.createElement('div');
        card.className = 'eg-card eg-scope tone-warn';
        card.appendChild(this._sectionTitle('Scope expansion', scope.headline));

        (scope.sessions || []).forEach(s => {
            const row = document.createElement('div');
            row.className = 'eg-scope-row';
            row.innerHTML =
                `<code>${this._esc(s.session_id || 'unknown session')}</code>` +
                `<span class="eg-scope-nums">${Number(s.distinct_hosts || 0)} hosts, ` +
                `${Number(s.novel_hosts || 0)} new, ` +
                `${Number(s.rate_per_minute || 0)}/min</span>`;
            (s.reasons || []).forEach(reason => {
                const li = document.createElement('div');
                li.className = 'eg-scope-reason';
                li.textContent = reason;
                row.appendChild(li);
            });
            card.appendChild(row);
        });

        const note = document.createElement('p');
        note.className = 'eg-note';
        note.textContent = scope.note || '';
        card.appendChild(note);
        return card;
    },

    async _promote(host, btn) {
        btn.disabled = true;
        btn.textContent = 'Allowing…';
        try {
            await API.promoteEgressHost(host);
            btn.textContent = 'Allowed';
            if (window.Toast) Toast.show(`${host} added to the allowlist.`, 'success');
        } catch (e) {
            btn.disabled = false;
            btn.textContent = 'Allow';
            if (window.Toast) Toast.show('Could not allow ' + host + ': ' + e.message, 'error');
        }
    },

    // ========================================================= policy tab ===

    async _loadPolicy() {
        const [policy, health, presets] = await Promise.all([
            API.getEgressPolicy(),
            API.getEgressPolicyHealth(this._state.windowDays),
            API.getEgressPresets(),
        ]);
        this._state.policy = policy;
        this._state.health = health;
        this._state.presets = presets;
        this._renderPolicy();
    },

    _PRESETS: [
        ['baseline', 'Baseline',
         'On by default. Reads are recorded and allowed; only the narrow, unambiguous write classes are denied. ' +
         'Needs no tuning by construction.'],
        ['hardened', 'Hardened',
         'Baseline, plus every write destination must be on the allowlist. Needs tuning. Preview the impact first.'],
        ['contained', 'Contained',
         'Only listed destinations are reachable at all. Intended for a single run, not as a permanent setting: ' +
         'a global allowlist covering a month of work is intractable and gets abandoned.'],
    ],

    /** The rule pack behind a preset, collapsed by default.
     *
     *  Teal marks a denial rather than red: red is reserved for a dangerous
     *  path that reached the network, and a rule that denies is enforcement
     *  working. `log_only` is rendered as its own muted mark so it can never be
     *  mistaken for a block that is not happening.
     */
    _presetDetail(presetId) {
        const data = this._state.presets;
        const entry = (data && data.presets || []).find(p => p.id === presetId);
        const box = document.createElement('details');
        box.className = 'eg-presetdetail';

        if (!entry) {
            box.innerHTML = '<summary>What this enforces</summary>' +
                '<p class="eg-note">Could not load the rule pack.</p>';
            return box;
        }

        const denies = entry.rules.filter(r => r.effect === 'deny').length;
        const logs = entry.rules.length - denies;
        box.innerHTML =
            `<summary>What this enforces — ${denies} deny rule${denies === 1 ? '' : 's'}` +
            `${logs ? `, ${logs} recorded-only` : ''}</summary>`;

        if (data.pack_loaded === false) {
            const warn = document.createElement('p');
            warn.className = 'eg-note';
            warn.textContent =
                'The baseline rule pack did not load on this device, so nothing below is being enforced.';
            box.appendChild(warn);
        }

        const adds = document.createElement('ul');
        adds.className = 'eg-preset-adds';
        (entry.adds || []).forEach(line => {
            const li = document.createElement('li');
            li.textContent = line;
            adds.appendChild(li);
        });
        box.appendChild(adds);

        const list = document.createElement('div');
        list.className = 'eg-rulelist';
        entry.rules.forEach(r => {
            const item = document.createElement('div');
            item.className = 'eg-rule';
            const isDeny = r.effect === 'deny';
            item.innerHTML =
                '<div class="eg-rule-head">' +
                `<span class="eg-mark ${isDeny ? 'tone-ok' : 'off'}">` +
                `${isDeny ? 'deny' : 'record'}</span>` +
                `<span class="eg-rule-title">${this._esc(r.title || r.id)}</span>` +
                `<span class="eg-rule-sev">${this._esc(r.severity || '')}</span>` +
                (r.ci_exempt
                    ? '<span class="eg-rule-flag" title="A CI runner profile can waive this one rule ' +
                      'without waiving the pack.">CI-waivable</span>'
                    : '') +
                '</div>' +
                (r.matches || []).map(m =>
                    `<div class="eg-rule-match">${this._esc(m)}</div>`).join('');
            list.appendChild(item);
        });
        box.appendChild(list);
        return box;
    },

    _renderPolicy() {
        const body = document.getElementById('eg-body');
        if (!body) return;
        body.textContent = '';
        const policy = this._state.policy;

        if (!policy) {
            const empty = document.createElement('div');
            empty.className = 'eg-card eg-empty-clear';
            empty.innerHTML = '<h3>No active egress policy</h3>' +
                '<p>Baseline still applies. This device has no stored policy row yet.</p>';
            body.appendChild(empty);
            return;
        }

        if (this._state.health) body.appendChild(this._healthCard(this._state.health));

        const card = document.createElement('div');
        card.className = 'eg-card';
        card.appendChild(this._sectionTitle('Preset',
            'How strict the destination policy is. Preview the impact against this device\'s own history before switching.'));

        this._PRESETS.forEach(([id, label, blurb]) => {
            const row = document.createElement('div');
            row.className = 'eg-preset' + (policy.preset === id ? ' on' : '');
            row.innerHTML =
                `<div class="eg-preset-head">` +
                `<span class="eg-preset-name">${this._esc(label)}</span>` +
                (policy.preset === id ? '<span class="eg-preset-active">active</span>' : '') +
                `</div><p class="eg-preset-blurb">${this._esc(blurb)}</p>`;

            // "Needs tuning" is not something an operator can consent to
            // without the list, so the list ships with the selector.
            row.appendChild(this._presetDetail(id));

            if (policy.preset !== id) {
                const actions = document.createElement('div');
                actions.className = 'eg-actions';
                const preview = document.createElement('button');
                preview.type = 'button';
                preview.className = 'eg-btn ghost';
                preview.textContent = 'Preview impact';
                preview.addEventListener('click', () => this._preview(id, row));
                actions.appendChild(preview);
                const apply = document.createElement('button');
                apply.type = 'button';
                apply.className = 'eg-btn';
                apply.textContent = 'Switch to ' + label;
                apply.addEventListener('click', () => this._applyPreset(id));
                actions.appendChild(apply);
                row.appendChild(actions);
            }
            card.appendChild(row);
        });
        body.appendChild(card);

        body.appendChild(this._listCard('Allowed destinations', policy.allowlist || [],
            'Hosts promoted from a block, or added by hand. A host covers its subdomains.'));
        body.appendChild(this._listCard('Denied destinations', policy.denylist || [],
            'Always blocked, whatever the preset. A denylist entry outranks an allowlist entry.'));
    },

    _healthCard(health) {
        const misset = health.policy_health === 'mis-set';
        const card = document.createElement('div');
        card.className = 'eg-card eg-health tone-' + (misset ? 'warn' : 'muted');
        card.appendChild(this._sectionTitle('Policy health',
            'How often a block gets promoted afterwards. A policy whose denials are all promoted is fighting you.'));
        const line = document.createElement('p');
        line.className = 'eg-health-line';
        if (!health.blocks) {
            line.textContent = `No destination was blocked in the last ${health.window_days} days, ` +
                'so there is nothing to measure yet.';
        } else {
            const pct = Math.round((health.promotion_rate || 0) * 100);
            const word = health.blocks === 1 ? 'block was' : 'blocks were';
            line.textContent =
                `${health.promoted} of ${health.blocks} ${word} promoted afterwards (${pct}%). ` +
                (misset
                    ? 'That is high enough to call this policy mis-set: it is stopping things you want, ' +
                      'and the usual outcome of that is the feature being turned off.'
                    : 'That is a healthy rate: blocks are mostly landing on things you did not want.');
        }
        card.appendChild(line);
        return card;
    },

    async _preview(preset, host) {
        const existing = host.querySelector('.eg-replay');
        if (existing) existing.remove();
        const box = document.createElement('div');
        box.className = 'eg-replay';
        box.textContent = 'Replaying this device\'s recorded destinations…';
        host.appendChild(box);
        try {
            const result = await API.replayEgressPolicy({ preset, days: this._state.windowDays });
            box.textContent = '';
            const summary = document.createElement('p');
            summary.className = 'eg-replay-summary';
            summary.textContent = result.summary || '';
            box.appendChild(summary);

            if ((result.newly_blocked_hosts || []).length) {
                const table = document.createElement('table');
                table.className = 'eg-table compact';
                table.innerHTML = '<thead><tr><th>Host</th><th class="num">Calls</th>' +
                    '<th>Operations</th><th>Clears with a promotion</th></tr></thead>';
                const tb = document.createElement('tbody');
                result.newly_blocked_hosts.forEach(h => {
                    const tr = document.createElement('tr');
                    tr.innerHTML =
                        `<td><code>${this._esc(h.host)}</code></td>` +
                        `<td class="num">${Number(h.calls || 0)}</td>` +
                        `<td class="muted">${this._esc((h.operations || []).join(', '))}</td>` +
                        `<td>${h.promotable ? 'yes' : '<span class="bad-text">no, needs a policy edit</span>'}</td>`;
                    tb.appendChild(tr);
                });
                table.appendChild(tb);
                box.appendChild(table);
            }

            const caveats = document.createElement('ul');
            caveats.className = 'eg-caveats';
            (result.caveats || []).forEach(c => {
                const li = document.createElement('li');
                li.textContent = c;
                caveats.appendChild(li);
            });
            box.appendChild(caveats);
        } catch (e) {
            box.textContent = 'Could not replay: ' + e.message;
        }
    },

    async _applyPreset(preset) {
        try {
            this._state.policy = await API.patchEgressPolicy({ preset });
            if (window.Toast) Toast.show('Egress preset set to ' + preset, 'success');
            this._renderPolicy();
        } catch (e) {
            if (window.Toast) Toast.show('Could not change preset: ' + e.message, 'error');
        }
    },

    _listCard(title, hosts, blurb) {
        const card = document.createElement('div');
        card.className = 'eg-card';
        card.appendChild(this._sectionTitle(title, blurb));
        if (!hosts.length) {
            const p = document.createElement('p');
            p.className = 'eg-note';
            p.textContent = 'Empty.';
            card.appendChild(p);
            return card;
        }
        const list = document.createElement('div');
        list.className = 'eg-hostlist';
        hosts.forEach(h => {
            const chip = document.createElement('code');
            chip.className = 'eg-hostchip';
            chip.textContent = h;
            list.appendChild(chip);
        });
        card.appendChild(list);
        return card;
    },

    // ============================================================ helpers ===

    _sectionTitle(title, sub) {
        const el = document.createElement('div');
        el.className = 'eg-sectitle';
        el.innerHTML = `<h3>${this._esc(title)}</h3>` +
            (sub ? `<p>${this._esc(sub)}</p>` : '');
        return el;
    },

    _stat(value, label, big, tone) {
        const el = document.createElement('div');
        el.className = 'eg-stat' + (big ? ' big' : '') + (tone ? ' tone-' + tone : '');
        el.innerHTML = `<div class="eg-stat-val">${Number(value || 0).toLocaleString()}</div>` +
            `<div class="eg-stat-label">${this._esc(label)}</div>`;
        return el;
    },

    _rel(iso) {
        if (!iso) return 'never';
        const t = String(iso).replace(' ', 'T') + (String(iso).endsWith('Z') ? '' : 'Z');
        const d = new Date(t);
        if (isNaN(d)) return String(iso);
        const secs = (Date.now() - d.getTime()) / 1000;
        if (secs < 60) return 'just now';
        if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
        if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
        return Math.floor(secs / 86400) + 'd ago';
    },

    _esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g,
            c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    },

    _injectStyle() {
        if (!document.getElementById('egress-cross-style')) {
            const st = document.createElement('style');
            st.id = 'egress-cross-style';
            st.textContent = `
            .eg-cross { display:flex; justify-content:flex-end; margin:0 0 14px; }
            .eg-cross-link { cursor:pointer; border:1px solid var(--border-default,#30363d); border-radius:999px;
                background:var(--bg-card,#161b22); color:var(--accent-primary,#5eadb8); padding:5px 12px;
                font:600 12px 'Avenir Next',Avenir,system-ui,sans-serif; transition:border-color .12s,background .12s; }
            .eg-cross-link:hover { border-color:var(--accent-primary,#5eadb8); background:var(--bg-hover,#21262d); }`;
            document.head.appendChild(st);
        }
        if (document.getElementById('eg-style')) return;
        const st = document.createElement('style');
        st.id = 'eg-style';
        st.textContent = `
            .eg-tabs { display:inline-flex; gap:4px; padding:4px; border-radius:10px; margin-bottom:18px;
                background:var(--bg-tertiary,#21262d); border:1px solid var(--border-default,#30363d); }
            .eg-tab { border:0; background:transparent; color:var(--text-secondary,#b1bac4);
                font:600 12px 'Avenir Next',Avenir,system-ui,sans-serif; padding:6px 14px; border-radius:7px;
                cursor:pointer; transition:color .12s, background .12s; }
            .eg-tab.on { background:var(--bg-card,#161b22); color:var(--text-primary,#e6edf3); box-shadow:0 1px 2px rgba(0,0,0,.25); }
            .eg-tab:hover:not(.on) { color:var(--text-primary,#e6edf3); }

            .eg-card { padding:18px 20px; border-radius:12px; background:var(--bg-card,#161b22);
                border:1px solid var(--border-default,#30363d); box-shadow:var(--elevate-1,none); margin-bottom:16px; }
            .eg-card h3 { margin:0 0 4px; font:700 14px 'Avenir Next',Avenir,system-ui,sans-serif;
                color:var(--text-primary,#e6edf3); }
            .eg-card p { margin:0 0 10px; font-size:12.5px; line-height:1.6; color:var(--text-secondary,#b1bac4); }
            .eg-empty { padding:26px; color:var(--text-muted,#7d8590); font-size:13px; }
            .eg-empty-clear { text-align:center; max-width:600px; margin:40px auto; }
            .eg-note { font-size:12px; color:var(--text-muted,#7d8590); line-height:1.6; }
            .eg-simbanner { border-style:dashed; }
            .eg-simbanner h3 { color:var(--text-secondary,#b1bac4); }
            .eg-simbanner strong { color:var(--text-primary,#e6edf3); font-weight:700; }
            .eg-simbanner p:last-child { margin-bottom:0; }
            .eg-running { font-size:12.5px; color:var(--text-muted,#7d8590); padding:4px 2px 16px; }

            /* Tone is security state only: ok = enforced, warn = inconclusive or
               moved off us, bad = a dangerous path reached the network. */
            .eg-card.tone-ok { border-color:color-mix(in srgb,var(--accent-primary,#5eadb8) 50%,transparent); }
            .eg-card.tone-warn { border-color:color-mix(in srgb,#f59e0b 50%,transparent);
                background:color-mix(in srgb,#f59e0b 6%,var(--bg-card,#161b22)); }
            .eg-card.tone-bad { border-color:color-mix(in srgb,#ef4444 55%,transparent);
                background:color-mix(in srgb,#ef4444 7%,var(--bg-card,#161b22)); }

            .eg-verdict-top { display:flex; align-items:baseline; gap:14px; flex-wrap:wrap; }
            .eg-verdict-word { font:700 32px 'Avenir Next',Avenir,system-ui,sans-serif; letter-spacing:-.5px;
                text-transform:uppercase; color:var(--text-primary,#e6edf3); line-height:1; }
            .eg-verdict.tone-bad .eg-verdict-word { color:#ef4444; }
            .eg-verdict.tone-warn .eg-verdict-word { color:#f59e0b; }
            .eg-verdict.tone-ok .eg-verdict-word { color:var(--accent-primary,#5eadb8); }
            .eg-verdict-stamp { margin-left:auto; font-size:11.5px; color:var(--text-muted,#7d8590);
                font-variant-numeric:tabular-nums; }
            .eg-verdict-line { margin:12px 0 16px; font-size:13px; line-height:1.65;
                color:var(--text-secondary,#b1bac4); max-width:78ch; }

            .eg-counts { display:flex; flex-wrap:wrap; gap:26px; padding:14px 0 4px;
                border-top:1px solid var(--border-default,#30363d); }
            .eg-count-val { display:block; font:700 22px ui-monospace,'JetBrains Mono',Menlo,monospace;
                color:var(--text-primary,#e6edf3); font-variant-numeric:tabular-nums; line-height:1; }
            .eg-count.tone-bad .eg-count-val { color:#ef4444; }
            .eg-count.tone-warn .eg-count-val { color:#f59e0b; }
            .eg-count-label { display:block; margin-top:5px; font:600 10.5px 'Avenir Next',Avenir,system-ui,sans-serif;
                text-transform:uppercase; letter-spacing:.5px; color:var(--text-muted,#7d8590); }

            .eg-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:16px; }
            .eg-btn { border:1px solid var(--border-default,#30363d); background:var(--bg-tertiary,#21262d);
                color:var(--text-primary,#e6edf3); font:600 12px 'Avenir Next',Avenir,system-ui,sans-serif;
                padding:7px 14px; border-radius:8px; cursor:pointer; text-decoration:none; display:inline-block;
                transition:border-color .12s, background .12s; }
            .eg-btn:hover { border-color:var(--accent-primary,#5eadb8); }
            .eg-btn[disabled] { opacity:.55; cursor:default; }
            .eg-btn.primary { background:color-mix(in srgb,var(--accent-primary,#5eadb8) 16%,transparent);
                border-color:color-mix(in srgb,var(--accent-primary,#5eadb8) 60%,transparent);
                color:var(--accent-primary,#5eadb8); }
            .eg-btn.ghost { background:transparent; color:var(--text-secondary,#b1bac4); }
            .eg-btn.tiny { padding:3px 10px; font-size:11px; }

            .eg-preflight { margin-top:14px; padding:14px 16px; border-radius:10px;
                background:var(--bg-tertiary,#21262d); border:1px solid var(--border-default,#30363d); }
            .eg-preflight h4 { margin:12px 0 5px; font:700 11px 'Avenir Next',Avenir,system-ui,sans-serif;
                text-transform:uppercase; letter-spacing:.5px; color:var(--text-muted,#7d8590); }
            .eg-preflight ul, .eg-coverage ul, .eg-caveats { margin:0; padding-left:18px; }
            .eg-preflight li, .eg-coverage li, .eg-caveats li { font-size:12px; line-height:1.65;
                color:var(--text-secondary,#b1bac4); }
            .eg-preflight code, .eg-preflight li { word-break:break-word; }

            .eg-drift-head { display:flex; align-items:center; gap:10px; }
            .eg-drift-label { font:600 10.5px 'Avenir Next',Avenir,system-ui,sans-serif; text-transform:uppercase;
                letter-spacing:.5px; color:var(--text-muted,#7d8590); }
            .eg-drift-status { font:700 12px 'Avenir Next',Avenir,system-ui,sans-serif; text-transform:uppercase;
                letter-spacing:.5px; color:var(--text-primary,#e6edf3); }
            .eg-drift.tone-bad .eg-drift-status { color:#ef4444; }
            .eg-drift.tone-warn .eg-drift-status { color:#f59e0b; }
            .eg-drift-reason { margin:8px 0 0 !important; }
            .eg-drift-row { margin-top:12px; padding-top:12px; border-top:1px solid var(--border-default,#30363d); }
            .eg-drift-probe { font:600 12.5px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3); }
            .eg-drift-move { margin-left:10px; font:600 11px ui-monospace,'JetBrains Mono',Menlo,monospace;
                color:var(--text-muted,#7d8590); }
            .eg-drift-note { margin-top:5px; font-size:12px; line-height:1.6; color:var(--text-secondary,#b1bac4); }

            .eg-table { width:100%; border-collapse:collapse; margin-top:8px; }
            .eg-table th { text-align:left; padding:8px 10px; font:600 10.5px 'Avenir Next',Avenir,system-ui,sans-serif;
                text-transform:uppercase; letter-spacing:.5px; color:var(--text-muted,#7d8590);
                border-bottom:1px solid var(--border-default,#30363d); }
            .eg-table th.num, .eg-table td.num { text-align:right; }
            .eg-table td { padding:11px 10px; font-size:12.5px; color:var(--text-secondary,#b1bac4);
                border-bottom:1px solid var(--border-default,#30363d); vertical-align:top;
                font-variant-numeric:tabular-nums; }
            .eg-table tbody tr:last-child td { border-bottom:0; }
            .eg-table tr.bad td { background:color-mix(in srgb,#ef4444 7%,transparent); }
            .eg-table.compact td, .eg-table.compact th { padding:6px 8px; font-size:12px; }
            .eg-table code { font:600 11.5px ui-monospace,'JetBrains Mono',Menlo,monospace;
                color:var(--text-primary,#e6edf3); }
            .eg-table .muted { color:var(--text-muted,#7d8590); }
            /* Scoped to td so it outranks the .eg-table td colour rule. */
            .eg-table td.bad-text, .bad-text { color:#ef4444; }
            .eg-nopromote { font:600 10.5px 'Avenir Next',Avenir,system-ui,sans-serif; text-transform:uppercase;
                letter-spacing:.5px; color:var(--text-muted,#7d8590); border:1px dashed var(--border-default,#30363d);
                padding:3px 9px; border-radius:6px; cursor:help; }

            .eg-probe-title { font:600 13px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3); }
            .eg-probe-meta { margin-top:3px; font-size:11px; color:var(--text-muted,#7d8590); }
            .eg-probe-dest { display:block; margin-top:5px; font-size:11px !important;
                color:var(--text-muted,#7d8590) !important; word-break:break-all; }
            .eg-probe-detail { margin-top:5px; font-size:11px; font-style:italic;
                color:var(--text-muted,#7d8590); }
            .eg-mark { font:700 11px 'Avenir Next',Avenir,system-ui,sans-serif; text-transform:uppercase;
                letter-spacing:.5px; padding:2px 8px; border-radius:6px; border:1px solid var(--border-default,#30363d);
                color:var(--text-muted,#7d8590); }
            .eg-mark.tone-ok { color:var(--accent-primary,#5eadb8);
                border-color:color-mix(in srgb,var(--accent-primary,#5eadb8) 55%,transparent); }
            .eg-mark.tone-warn { color:#f59e0b; border-color:color-mix(in srgb,#f59e0b 55%,transparent); }
            .eg-mark.tone-bad { color:#ef4444; border-color:color-mix(in srgb,#ef4444 60%,transparent);
                background:color-mix(in srgb,#ef4444 12%,transparent); }
            .eg-mark.off { opacity:.5; }

            .eg-exportbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:-4px 0 20px; }
            .eg-export-label { font:600 10.5px 'Avenir Next',Avenir,system-ui,sans-serif; text-transform:uppercase;
                letter-spacing:.5px; color:var(--text-muted,#7d8590); margin-right:4px; }
            .eg-hash { margin-left:auto; font:600 11px ui-monospace,'JetBrains Mono',Menlo,monospace;
                color:var(--text-muted,#7d8590); }

            .eg-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin-bottom:14px; }
            .eg-stat { padding:16px 18px; border-radius:12px; background:var(--bg-card,#161b22);
                border:1px solid var(--border-default,#30363d); box-shadow:var(--elevate-1,none); }
            .eg-stat.tone-warn { border-color:color-mix(in srgb,#f59e0b 45%,transparent); }
            .eg-stat-val { font:700 28px ui-monospace,'JetBrains Mono',Menlo,monospace; color:var(--text-primary,#e6edf3);
                font-variant-numeric:tabular-nums; line-height:1; }
            .eg-stat.big .eg-stat-val { font-size:34px; }
            .eg-stat.tone-warn .eg-stat-val { color:#f59e0b; }
            .eg-stat-label { margin-top:6px; font:600 10.5px 'Avenir Next',Avenir,system-ui,sans-serif;
                text-transform:uppercase; letter-spacing:.5px; color:var(--text-muted,#7d8590); }

            .eg-sectitle { margin:0 0 10px; }
            .eg-sectitle h3 { margin:0 0 3px; }
            .eg-sectitle p { margin:0; font-size:12px; color:var(--text-muted,#7d8590); }

            .eg-preset { padding:14px 16px; border-radius:10px; border:1px solid var(--border-default,#30363d);
                margin-bottom:10px; background:var(--bg-tertiary,#21262d); }
            .eg-preset.on { border-color:color-mix(in srgb,var(--accent-primary,#5eadb8) 60%,transparent);
                background:color-mix(in srgb,var(--accent-primary,#5eadb8) 8%,transparent); }
            .eg-preset-head { display:flex; align-items:center; gap:10px; }
            .eg-preset-name { font:700 13px 'Avenir Next',Avenir,system-ui,sans-serif; color:var(--text-primary,#e6edf3); }
            .eg-preset-active { font:700 9.5px 'Avenir Next',Avenir,system-ui,sans-serif; text-transform:uppercase;
                letter-spacing:.5px; color:var(--accent-primary,#5eadb8); padding:2px 7px; border-radius:5px;
                border:1px solid color-mix(in srgb,var(--accent-primary,#5eadb8) 55%,transparent); }
            .eg-preset-blurb { margin:6px 0 0 !important; }
            .eg-presetdetail { margin-top:10px; }
            .eg-presetdetail > summary { cursor:pointer; font:600 11.5px 'Avenir Next',Avenir,system-ui,sans-serif;
                color:var(--accent-primary,#5eadb8); list-style:revert; width:fit-content; }
            .eg-presetdetail > summary:hover { text-decoration:underline; }
            .eg-preset-adds { margin:10px 0 0; padding-left:18px; }
            .eg-preset-adds li { font-size:12px; line-height:1.65; color:var(--text-secondary,#b1bac4); }
            .eg-rulelist { margin-top:12px; display:flex; flex-direction:column; gap:8px; }
            .eg-rule { padding:9px 11px; border-radius:8px; border:1px solid var(--border-default,#30363d);
                background:var(--bg-elevated,#0d1117); }
            .eg-rule-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
            .eg-rule-title { font:600 12.5px 'Avenir Next',Avenir,system-ui,sans-serif;
                color:var(--text-primary,#e6edf3); }
            .eg-rule-sev { font-size:10.5px; text-transform:uppercase; letter-spacing:.5px;
                color:var(--text-muted,#7d8590); }
            .eg-rule-flag { font:600 9.5px 'Avenir Next',Avenir,system-ui,sans-serif; text-transform:uppercase;
                letter-spacing:.5px; color:var(--text-muted,#7d8590); border:1px dashed var(--border-default,#30363d);
                padding:2px 7px; border-radius:5px; cursor:help; }
            .eg-rule-match { margin-top:5px; font-size:11px; line-height:1.55;
                color:var(--text-muted,#7d8590); word-break:break-word; }

            .eg-replay { margin-top:14px; padding:14px 16px; border-radius:10px;
                background:var(--bg-card,#161b22); border:1px solid var(--border-default,#30363d);
                font-size:12.5px; color:var(--text-secondary,#b1bac4); }
            .eg-replay-summary { font:600 13px 'Avenir Next',Avenir,system-ui,sans-serif !important;
                color:var(--text-primary,#e6edf3) !important; margin-bottom:10px !important; }
            .eg-caveats { margin-top:12px !important; }

            .eg-scope-row { margin-top:12px; padding-top:12px; border-top:1px solid var(--border-default,#30363d); }
            .eg-scope-row code { font:600 11.5px ui-monospace,'JetBrains Mono',Menlo,monospace;
                color:var(--text-primary,#e6edf3); }
            .eg-scope-nums { margin-left:10px; font:600 11px ui-monospace,'JetBrains Mono',Menlo,monospace;
                color:var(--text-muted,#7d8590); font-variant-numeric:tabular-nums; }
            .eg-scope-reason { margin-top:5px; font-size:12px; line-height:1.6; color:var(--text-secondary,#b1bac4); }
            /* The alert-only note must not read as one more reason. */
            .eg-scope .eg-note { margin-top:14px; padding-top:12px;
                border-top:1px solid var(--border-default,#30363d); }

            .eg-health-line { margin:0 !important; }
            .eg-hostlist { display:flex; flex-wrap:wrap; gap:6px; }
            .eg-hostchip { font:600 11.5px ui-monospace,'JetBrains Mono',Menlo,monospace; padding:3px 9px;
                border-radius:6px; background:var(--bg-tertiary,#21262d); color:var(--text-secondary,#b1bac4);
                border:1px solid var(--border-default,#30363d); }
        `;
        document.head.appendChild(st);
    },
};
/** Route wrapper: the Policies entry renders the policy view of EgressPage. */
const EgressPolicyPage = {
    render(container) { return EgressPage.render(container); },
};

window.EgressPage = EgressPage;
window.EgressPolicyPage = EgressPolicyPage;
