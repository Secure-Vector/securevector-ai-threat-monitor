/**
 * Community links, prefilled issue reports, and the one-time milestone prompt.
 *
 * The links (GitHub, Discord, issue tracker) are shared by the rail footer,
 * the desktop Help menu, the threat drawer, and the uninstall screen. Issue
 * links are prefilled with version, platform, and, for a detection, the rule
 * ids and label. Never event content: the user adds what they choose to on
 * GitHub. Nothing is sent from the app; every link opens the system browser.
 *
 * The milestone prompt asks for a star exactly once, at the first moment the
 * app has visibly earned it: the first blocked action, or failing that, real
 * volume. Any answer is remembered locally and it never asks again.
 */
const Community = {
    GITHUB_URL: 'https://github.com/Secure-Vector/securevector-ai-threat-monitor',
    ISSUES_URL: 'https://github.com/Secure-Vector/securevector-ai-threat-monitor/issues/new',
    DISCORD_URL: 'https://discord.gg/k3bgZuCQBC',
    /** Public contact alias already on the repo; never a personal inbox. */
    CONTACT_EMAIL: 'contact@securevector.io',

    /** Tool calls plus detections before the volume prompt is allowed. */
    MILESTONE: 100,
    /** localStorage key; any value means the question has been answered. */
    STORAGE_KEY: 'sv-milestone-answered',

    _card: null,
    _env: { version: '', os: '', install: '' },

    /** Read version once from the local server; platform from the browser. */
    init() {
        const ua = navigator.userAgent || '';
        const os = /Windows/i.test(ua) ? 'Windows' : /Mac/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : '';
        const desktop = ua.includes('SecureVectorDesktop');
        this._env.os = os;
        this._env.install = desktop
            ? (os === 'Windows' ? 'Windows installer (.exe)' : os === 'macOS' ? 'macOS installer (.dmg)' : 'Linux AppImage')
            : 'pip (securevector-ai-monitor[app])';
        fetch('/health').then(r => r.ok ? r.json() : null).then(d => {
            const v = d && d.version ? String(d.version) : '';
            if (/^[\w.+-]{1,20}$/.test(v)) this._env.version = v;
        }).catch(() => {});
    },

    env() { return { ...this._env }; },

    /**
     * Prefilled "new issue" link. GitHub fills form fields whose id matches a
     * query parameter, so version, platform and install method land in the
     * right boxes and the reporter only writes what happened.
     */
    issueUrl(template, fields = {}) {
        const q = new URLSearchParams();
        q.set('template', template);
        const env = this.env();
        const all = { version: env.version, os: env.os, install_method: env.install, ...fields };
        Object.keys(all).forEach(k => { if (all[k]) q.set(k, String(all[k])); });
        return `${this.ISSUES_URL}?${q.toString()}`;
    },

    bugUrl(fields = {}) { return this.issueUrl('bug_report.yml', fields); },

    /** Plain mailto for people who would rather not use GitHub. Subject carries version and platform. */
    mailUrl(topic = 'feedback') {
        const env = this.env();
        const subject = `SecureVector ${topic}` + (env.version ? ` (v${env.version}` + (env.os ? `, ${env.os})` : ')') : '');
        return `mailto:${this.CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}`;
    },

    /** Detection report: rule ids and label only, never the text. */
    falsePositiveUrl(threat) {
        const t = threat || {};
        const rules = (t.matched_rules || []).map(r => r && (r.rule_id || r.rule_name)).filter(Boolean).join(', ');
        return this.issueUrl('false_positive.yml', {
            title: `False positive: ${t.threat_type || 'detection'}${rules ? ' (' + rules.split(', ')[0] + ')' : ''}`,
            rule: rules,
            detection: [t.threat_type, t.action_taken ? 'action ' + t.action_taken : '', typeof t.risk_score === 'number' ? 'risk ' + t.risk_score : '']
                .filter(Boolean).join(', '),
            source: t.source_identifier || '',
        });
    },

    /** Rail footer: two quiet icon links. */
    createLinks() {
        const row = document.createElement('div');
        row.className = 'sidebar-links';
        row.appendChild(this._link(this.GITHUB_URL, 'Give us a star on GitHub', this._githubIcon()));
        row.appendChild(this._link(this.DISCORD_URL, 'Join us on Discord', this._discordIcon()));
        return row;
    },

    /** Text link that opens a prefilled issue; used at friction points. */
    createReportLink(text, href, className) {
        const a = document.createElement('a');
        a.className = className || 'sv-report-link';
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = text;
        return a;
    },

    _link(href, label, icon) {
        const a = document.createElement('a');
        a.className = 'sidebar-link';
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = label;
        a.setAttribute('aria-label', label);
        a.appendChild(icon);
        return a;
    },

    _svg(d) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'currentColor');
        svg.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
        return svg;
    },

    _githubIcon() {
        return this._svg('M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.72.5.1.68-.22.68-.49v-1.7c-2.78.62-3.37-1.36-3.37-1.36-.45-1.18-1.11-1.5-1.11-1.5-.91-.63.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.56 2.35 1.11 2.92.85.09-.66.35-1.11.63-1.37-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05A9.36 9.36 0 0 1 12 6.84c.85 0 1.71.12 2.5.35 1.91-1.33 2.75-1.05 2.75-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.8-4.57 5.05.36.32.68.94.68 1.9v2.82c0 .27.18.6.69.49A10.26 10.26 0 0 0 22 12.25C22 6.58 17.52 2 12 2z');
    },

    _discordIcon() {
        return this._svg('M19.54 5.33A17.3 17.3 0 0 0 15.3 4l-.2.4a15.9 15.9 0 0 1 3.9 1.9 13.4 13.4 0 0 0-14 0 15.9 15.9 0 0 1 3.9-1.9L8.7 4a17.3 17.3 0 0 0-4.24 1.33C1.78 9.3 1.05 13.15 1.42 16.95a17.4 17.4 0 0 0 5.2 2.62l1.1-1.78a11 11 0 0 1-1.76-.85l.43-.34a12.4 12.4 0 0 0 11.22 0l.43.34c-.56.34-1.15.62-1.76.85l1.1 1.78a17.4 17.4 0 0 0 5.2-2.62c.43-4.4-.73-8.22-3.04-11.62zM8.68 14.63c-1.02 0-1.86-.94-1.86-2.1s.82-2.1 1.86-2.1 1.88.95 1.86 2.1c0 1.16-.82 2.1-1.86 2.1zm6.64 0c-1.02 0-1.86-.94-1.86-2.1s.82-2.1 1.86-2.1 1.88.95 1.86 2.1c0 1.16-.82 2.1-1.86 2.1z');
    },

    answered() {
        try { return !!localStorage.getItem(this.STORAGE_KEY); } catch (_) { return false; }
    },

    _remember(answer) {
        try { localStorage.setItem(this.STORAGE_KEY, answer); } catch (_) { /* private mode */ }
    },

    /**
     * Called whenever a page learns the counts. `blocked` is actions the app
     * stopped, `events` is tool calls plus detections. The first block is the
     * moment the app has visibly done its job, so it wins; volume is the
     * fallback for machines that only observe. Shows once, provided the
     * question has not been answered and first-run screens are done.
     */
    consider(counts) {
        const c = typeof counts === 'number' ? { events: counts } : (counts || {});
        const blocked = Number(c.blocked) || 0;
        const events = Number(c.events) || 0;
        if (blocked < 1 && events < this.MILESTONE) return false;
        if (this._card || this.answered()) return false;
        let welcomed = true;
        try { welcomed = !!localStorage.getItem('sv-welcome-seen-v2'); } catch (_) { /* keep true */ }
        if (!welcomed) return false;
        this._show(blocked, events);
        return true;
    },

    _show(blocked, events) {
        const card = document.createElement('div');
        card.className = 'sv-milestone';
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-label', 'Is SecureVector earning its place?');

        const title = document.createElement('div');
        title.className = 'sv-milestone-title';
        title.textContent = blocked > 0
            ? `SecureVector has blocked ${blocked.toLocaleString()} ${blocked === 1 ? 'action' : 'actions'} on this machine.`
            : `SecureVector has analyzed ${events.toLocaleString()} events on this machine.`;
        card.appendChild(title);

        const body = document.createElement('div');
        body.className = 'sv-milestone-body';
        body.textContent = (blocked > 0
            ? 'If that was the right call, a star on GitHub helps others find it. If a block was wrong, report it and we will look at the rule. '
            : 'If it is earning its place, a star on GitHub helps others find it. If something is off, report it. ')
            + 'The Star button is at the top right of the repo page. This is the only time the app will ask.';
        card.appendChild(body);

        const actions = document.createElement('div');
        actions.className = 'sv-milestone-actions';
        const link = (text, href, cls, answer) => {
            const a = document.createElement('a');
            a.className = 'sv-milestone-action' + (cls ? ' ' + cls : '');
            a.href = href;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = text;
            a.addEventListener('click', () => this._close(answer));
            return a;
        };
        actions.appendChild(link('Star on GitHub', this.GITHUB_URL, 'primary', 'starred'));
        actions.appendChild(link('Report a problem', this.bugUrl(), '', 'feedback'));
        const later = document.createElement('button');
        later.type = 'button';
        later.className = 'sv-milestone-action quiet';
        later.textContent = 'Not now';
        later.addEventListener('click', () => this._close('dismissed'));
        actions.appendChild(later);
        card.appendChild(actions);

        this._onKey = (e) => { if (e.key === 'Escape') this._close('dismissed'); };
        document.addEventListener('keydown', this._onKey);
        document.body.appendChild(card);
        this._card = card;
    },

    _close(answer) {
        this._remember(answer);
        if (this._onKey) document.removeEventListener('keydown', this._onKey);
        this._onKey = null;
        if (this._card) this._card.remove();
        this._card = null;
    },
};

window.Community = Community;
