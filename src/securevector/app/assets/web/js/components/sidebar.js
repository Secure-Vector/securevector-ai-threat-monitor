/**
 * Sidebar Navigation Component
 * Note: All content is static/hardcoded, no user input is rendered
 */

const Sidebar = {
    navItems: [
        { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
        { id: 'threats', label: 'Threat Analytics', icon: 'shield' },
        { id: 'rules', label: 'Rules', icon: 'rules' },
        { id: 'settings', label: 'Settings', icon: 'settings' },
    ],

    currentPage: 'dashboard',

    render() {
        const container = document.getElementById('sidebar');
        if (!container) return;

        // Clear container
        container.textContent = '';

        // Create header with mascot
        const header = document.createElement('div');
        header.className = 'sidebar-header';

        // Guardian Owl mascot - vigilant protector
        const mascot = this.createMascot();
        header.appendChild(mascot);

        const logo = document.createElement('span');
        logo.className = 'sidebar-logo';
        logo.textContent = 'SecureVector';
        header.appendChild(logo);
        container.appendChild(header);

        // Create nav
        const nav = document.createElement('nav');
        nav.className = 'sidebar-nav';

        this.navItems.forEach(item => {
            const navItem = document.createElement('div');
            navItem.className = 'nav-item' + (item.id === this.currentPage ? ' active' : '');
            navItem.dataset.page = item.id;

            // Add icon (SVG)
            const iconSvg = this.createIcon(item.icon);
            navItem.appendChild(iconSvg);

            // Add label
            const label = document.createElement('span');
            label.textContent = item.label;
            navItem.appendChild(label);

            // Click handler
            navItem.addEventListener('click', () => this.navigate(item.id));

            nav.appendChild(navItem);
        });

        container.appendChild(nav);

        // Try SecureVector chat widget at bottom
        const chatWidget = this.createChatWidget();
        container.appendChild(chatWidget);
    },

    createChatWidget() {
        const widget = document.createElement('div');
        widget.className = 'sidebar-chat-widget';

        // Header
        const header = document.createElement('div');
        header.className = 'chat-widget-header';

        const headerIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        headerIcon.setAttribute('viewBox', '0 0 24 24');
        headerIcon.setAttribute('fill', 'none');
        headerIcon.setAttribute('stroke', 'currentColor');
        headerIcon.setAttribute('stroke-width', '2');
        const iconPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        iconPath.setAttribute('d', 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z');
        headerIcon.appendChild(iconPath);
        header.appendChild(headerIcon);

        const headerText = document.createElement('span');
        headerText.textContent = 'Try SecureVector';
        header.appendChild(headerText);

        widget.appendChild(header);

        // Messages area
        const messages = document.createElement('div');
        messages.className = 'chat-widget-messages';
        messages.id = 'chat-widget-messages';

        // Welcome message
        const welcome = document.createElement('div');
        welcome.className = 'chat-message bot';
        const welcomeText = document.createElement('div');
        welcomeText.textContent = 'Test threat detection locally';
        welcome.appendChild(welcomeText);
        const rulesNote = document.createElement('div');
        rulesNote.className = 'chat-rules-note';
        rulesNote.textContent = 'Using community rules';
        welcome.appendChild(rulesNote);
        messages.appendChild(welcome);

        widget.appendChild(messages);

        // Input area
        const inputArea = document.createElement('div');
        inputArea.className = 'chat-widget-input';

        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'Type to analyze...';
        input.id = 'chat-widget-input';
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.sendChatMessage();
            }
        });
        inputArea.appendChild(input);

        const sendBtn = document.createElement('button');
        sendBtn.className = 'chat-send-btn';
        sendBtn.setAttribute('aria-label', 'Analyze');

        const sendIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        sendIcon.setAttribute('viewBox', '0 0 24 24');
        sendIcon.setAttribute('fill', 'none');
        sendIcon.setAttribute('stroke', 'currentColor');
        sendIcon.setAttribute('stroke-width', '2');
        const sendPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        sendPath.setAttribute('d', 'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z');
        sendIcon.appendChild(sendPath);
        sendBtn.appendChild(sendIcon);

        sendBtn.addEventListener('click', () => this.sendChatMessage());
        inputArea.appendChild(sendBtn);

        widget.appendChild(inputArea);

        return widget;
    },

    async sendChatMessage() {
        const input = document.getElementById('chat-widget-input');
        const messages = document.getElementById('chat-widget-messages');
        if (!input || !messages) return;

        const content = input.value.trim();
        if (!content) return;

        // Add user message
        const userMsg = document.createElement('div');
        userMsg.className = 'chat-message user';
        userMsg.textContent = content;
        messages.appendChild(userMsg);

        // Clear input
        input.value = '';

        // Add loading message
        const loadingMsg = document.createElement('div');
        loadingMsg.className = 'chat-message bot loading';
        loadingMsg.textContent = 'Analyzing...';
        messages.appendChild(loadingMsg);

        // Scroll to bottom
        messages.scrollTop = messages.scrollHeight;

        try {
            const result = await API.analyze(content);
            loadingMsg.remove();

            // Add result message
            const resultMsg = document.createElement('div');
            resultMsg.className = 'chat-message bot ' + (result.is_threat ? 'threat' : 'safe');

            const resultContent = document.createElement('div');
            resultContent.className = 'chat-result';

            // Status
            const status = document.createElement('div');
            status.className = 'chat-result-status';
            status.textContent = result.is_threat ? 'Threat Detected' : 'Safe';
            resultContent.appendChild(status);

            // Risk score
            const risk = document.createElement('div');
            risk.className = 'chat-result-risk risk-' + this.getChatRiskLevel(result.risk_score);
            risk.textContent = result.risk_score + '% risk';
            resultContent.appendChild(risk);

            // Threat type if detected
            if (result.is_threat && result.threat_type) {
                const type = document.createElement('div');
                type.className = 'chat-result-type';
                type.textContent = result.threat_type;
                resultContent.appendChild(type);
            }

            // Source indicator
            const source = document.createElement('div');
            source.className = 'chat-result-source';
            source.textContent = result.analysis_source === 'cloud' ? 'Cloud rules' : 'Community rules';
            resultContent.appendChild(source);

            resultMsg.appendChild(resultContent);
            messages.appendChild(resultMsg);
        } catch (error) {
            loadingMsg.remove();

            const errorMsg = document.createElement('div');
            errorMsg.className = 'chat-message bot error';
            errorMsg.textContent = 'Error: ' + (error.message || 'Analysis failed');
            messages.appendChild(errorMsg);
        }

        // Scroll to bottom
        messages.scrollTop = messages.scrollHeight;
    },

    getChatRiskLevel(score) {
        if (score >= 80) return 'critical';
        if (score >= 60) return 'high';
        if (score >= 40) return 'medium';
        return 'low';
    },

    createIcon(name) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');

        const paths = {
            dashboard: [
                { tag: 'rect', attrs: { x: '3', y: '3', width: '7', height: '7', rx: '1' } },
                { tag: 'rect', attrs: { x: '14', y: '3', width: '7', height: '7', rx: '1' } },
                { tag: 'rect', attrs: { x: '3', y: '14', width: '7', height: '7', rx: '1' } },
                { tag: 'rect', attrs: { x: '14', y: '14', width: '7', height: '7', rx: '1' } },
            ],
            shield: [
                { tag: 'path', attrs: { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' } },
            ],
            rules: [
                { tag: 'path', attrs: { d: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z' } },
                { tag: 'polyline', attrs: { points: '14 2 14 8 20 8' } },
                { tag: 'line', attrs: { x1: '16', y1: '13', x2: '8', y2: '13' } },
                { tag: 'line', attrs: { x1: '16', y1: '17', x2: '8', y2: '17' } },
            ],
            settings: [
                { tag: 'circle', attrs: { cx: '12', cy: '12', r: '3' } },
                { tag: 'path', attrs: { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z' } },
            ],
        };

        (paths[name] || []).forEach(({ tag, attrs }) => {
            const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
            Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
            svg.appendChild(el);
        });

        return svg;
    },

    createMascot() {
        // Guardian Owl - symbolizes vigilance and protection
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 48 48');
        svg.setAttribute('fill', 'none');
        svg.className = 'sidebar-mascot';

        // Gradient definition
        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');

        const gradient = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
        gradient.setAttribute('id', 'mascot-gradient');
        gradient.setAttribute('x1', '0%');
        gradient.setAttribute('y1', '0%');
        gradient.setAttribute('x2', '100%');
        gradient.setAttribute('y2', '100%');

        const stop1 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
        stop1.setAttribute('offset', '0%');
        stop1.setAttribute('stop-color', '#00d4ff');
        gradient.appendChild(stop1);

        const stop2 = document.createElementNS('http://www.w3.org/2000/svg', 'stop');
        stop2.setAttribute('offset', '100%');
        stop2.setAttribute('stop-color', '#ff3366');
        gradient.appendChild(stop2);

        defs.appendChild(gradient);

        // Glow filter
        const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
        filter.setAttribute('id', 'mascot-glow');
        const feGaussian = document.createElementNS('http://www.w3.org/2000/svg', 'feGaussianBlur');
        feGaussian.setAttribute('stdDeviation', '1');
        feGaussian.setAttribute('result', 'coloredBlur');
        filter.appendChild(feGaussian);
        const feMerge = document.createElementNS('http://www.w3.org/2000/svg', 'feMerge');
        const feMergeNode1 = document.createElementNS('http://www.w3.org/2000/svg', 'feMergeNode');
        feMergeNode1.setAttribute('in', 'coloredBlur');
        const feMergeNode2 = document.createElementNS('http://www.w3.org/2000/svg', 'feMergeNode');
        feMergeNode2.setAttribute('in', 'SourceGraphic');
        feMerge.appendChild(feMergeNode1);
        feMerge.appendChild(feMergeNode2);
        filter.appendChild(feMerge);
        defs.appendChild(filter);

        svg.appendChild(defs);

        // Owl body (shield shape)
        const body = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        body.setAttribute('d', 'M24 4 L40 12 L40 26 C40 36 24 44 24 44 C24 44 8 36 8 26 L8 12 Z');
        body.setAttribute('fill', 'url(#mascot-gradient)');
        body.setAttribute('opacity', '0.15');
        body.setAttribute('filter', 'url(#mascot-glow)');
        svg.appendChild(body);

        // Owl body outline
        const bodyOutline = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        bodyOutline.setAttribute('d', 'M24 4 L40 12 L40 26 C40 36 24 44 24 44 C24 44 8 36 8 26 L8 12 Z');
        bodyOutline.setAttribute('fill', 'none');
        bodyOutline.setAttribute('stroke', 'url(#mascot-gradient)');
        bodyOutline.setAttribute('stroke-width', '2');
        svg.appendChild(bodyOutline);

        // Owl ears (tufts)
        const leftEar = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        leftEar.setAttribute('d', 'M14 14 L17 10 L20 14');
        leftEar.setAttribute('fill', 'none');
        leftEar.setAttribute('stroke', 'url(#mascot-gradient)');
        leftEar.setAttribute('stroke-width', '2');
        leftEar.setAttribute('stroke-linecap', 'round');
        leftEar.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(leftEar);

        const rightEar = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        rightEar.setAttribute('d', 'M34 14 L31 10 L28 14');
        rightEar.setAttribute('fill', 'none');
        rightEar.setAttribute('stroke', 'url(#mascot-gradient)');
        rightEar.setAttribute('stroke-width', '2');
        rightEar.setAttribute('stroke-linecap', 'round');
        rightEar.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(rightEar);

        // Left eye (outer circle)
        const leftEyeOuter = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        leftEyeOuter.setAttribute('cx', '17');
        leftEyeOuter.setAttribute('cy', '20');
        leftEyeOuter.setAttribute('r', '5');
        leftEyeOuter.setAttribute('fill', 'none');
        leftEyeOuter.setAttribute('stroke', 'url(#mascot-gradient)');
        leftEyeOuter.setAttribute('stroke-width', '2');
        svg.appendChild(leftEyeOuter);

        // Left eye (pupil - glowing)
        const leftPupil = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        leftPupil.setAttribute('cx', '17');
        leftPupil.setAttribute('cy', '20');
        leftPupil.setAttribute('r', '2');
        leftPupil.setAttribute('fill', '#00d4ff');
        leftPupil.setAttribute('filter', 'url(#mascot-glow)');
        svg.appendChild(leftPupil);

        // Right eye (outer circle)
        const rightEyeOuter = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        rightEyeOuter.setAttribute('cx', '31');
        rightEyeOuter.setAttribute('cy', '20');
        rightEyeOuter.setAttribute('r', '5');
        rightEyeOuter.setAttribute('fill', 'none');
        rightEyeOuter.setAttribute('stroke', 'url(#mascot-gradient)');
        rightEyeOuter.setAttribute('stroke-width', '2');
        svg.appendChild(rightEyeOuter);

        // Right eye (pupil - glowing)
        const rightPupil = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        rightPupil.setAttribute('cx', '31');
        rightPupil.setAttribute('cy', '20');
        rightPupil.setAttribute('r', '2');
        rightPupil.setAttribute('fill', '#ff3366');
        rightPupil.setAttribute('filter', 'url(#mascot-glow)');
        svg.appendChild(rightPupil);

        // Beak
        const beak = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        beak.setAttribute('d', 'M24 24 L21 28 L24 32 L27 28 Z');
        beak.setAttribute('fill', 'url(#mascot-gradient)');
        beak.setAttribute('opacity', '0.8');
        svg.appendChild(beak);

        // Chest pattern (V shape for protection)
        const chest = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        chest.setAttribute('d', 'M16 34 L24 38 L32 34');
        chest.setAttribute('fill', 'none');
        chest.setAttribute('stroke', 'url(#mascot-gradient)');
        chest.setAttribute('stroke-width', '1.5');
        chest.setAttribute('stroke-linecap', 'round');
        svg.appendChild(chest);

        return svg;
    },

    navigate(page) {
        this.currentPage = page;

        // Update active state
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.page === page);
        });

        // Trigger page load
        if (window.App) {
            App.loadPage(page);
        }
    },

    setActive(page) {
        this.currentPage = page;
        document.querySelectorAll('.nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.page === page);
        });
    },
};

window.Sidebar = Sidebar;
