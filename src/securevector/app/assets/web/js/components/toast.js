/**
 * Toast Notification Component
 * Shows temporary notification messages
 */

const Toast = {
    container: null,
    queue: [],

    /**
     * Initialize toast container
     */
    init() {
        if (this.container) return;

        this.container = document.createElement('div');
        this.container.className = 'toast-container';
        document.body.appendChild(this.container);
    },

    /**
     * Show a toast notification
     * @param {Object} options - Toast options
     * @param {string} options.message - Toast message
     * @param {string} options.type - Toast type (success, error, warning, info)
     * @param {number} options.duration - Duration in ms (default: 3000)
     */
    show(options = {}) {
        this.init();

        const toast = document.createElement('div');
        toast.className = 'toast toast-' + (options.type || 'info');

        // Icon
        const icon = document.createElement('span');
        icon.className = 'toast-icon';
        icon.appendChild(this.createIcon(options.type || 'info'));
        toast.appendChild(icon);

        // Message
        const message = document.createElement('span');
        message.className = 'toast-message';
        message.textContent = options.message || '';
        toast.appendChild(message);

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.className = 'toast-close';
        closeBtn.textContent = '\u00D7';
        closeBtn.addEventListener('click', () => this.dismiss(toast));
        toast.appendChild(closeBtn);

        this.container.appendChild(toast);

        // Animate in
        requestAnimationFrame(() => {
            toast.classList.add('active');
        });

        // Auto dismiss
        const duration = options.duration || 3000;
        setTimeout(() => this.dismiss(toast), duration);
    },

    /**
     * Dismiss a toast
     * @param {HTMLElement} toast - Toast element to dismiss
     */
    dismiss(toast) {
        if (!toast || !toast.parentNode) return;

        toast.classList.remove('active');
        toast.classList.add('dismissing');

        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 300);
    },

    /**
     * Show a success toast
     * @param {string} message - Toast message
     */
    success(message) {
        this.show({ message, type: 'success' });
    },

    /**
     * Show an error toast
     * @param {string} message - Toast message
     */
    error(message) {
        this.show({ message, type: 'error', duration: 5000 });
    },

    /**
     * Show a warning toast
     * @param {string} message - Toast message
     */
    warning(message) {
        this.show({ message, type: 'warning' });
    },

    /**
     * Show an info toast
     * @param {string} message - Toast message
     */
    info(message) {
        this.show({ message, type: 'info' });
    },

    createIcon(type) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');

        const icons = {
            success: [
                { tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } },
                { tag: 'polyline', attrs: { points: '9 12 12 15 16 10' } },
            ],
            error: [
                { tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } },
                { tag: 'line', attrs: { x1: '15', y1: '9', x2: '9', y2: '15' } },
                { tag: 'line', attrs: { x1: '9', y1: '9', x2: '15', y2: '15' } },
            ],
            warning: [
                { tag: 'path', attrs: { d: 'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z' } },
                { tag: 'line', attrs: { x1: '12', y1: '9', x2: '12', y2: '13' } },
                { tag: 'line', attrs: { x1: '12', y1: '17', x2: '12.01', y2: '17' } },
            ],
            info: [
                { tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } },
                { tag: 'line', attrs: { x1: '12', y1: '16', x2: '12', y2: '12' } },
                { tag: 'line', attrs: { x1: '12', y1: '8', x2: '12.01', y2: '8' } },
            ],
        };

        (icons[type] || icons.info).forEach(({ tag, attrs }) => {
            const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
            Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
            svg.appendChild(el);
        });

        return svg;
    },
};

window.Toast = Toast;
