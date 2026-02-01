/**
 * Modal Component
 * Reusable modal dialog
 */

const Modal = {
    activeModal: null,

    /**
     * Show a modal dialog
     * @param {Object} options - Modal options
     * @param {string} options.title - Modal title
     * @param {HTMLElement|string} options.content - Modal content
     * @param {Array} options.actions - Action buttons
     * @param {boolean} options.closable - Show close button (default: true)
     * @param {string} options.size - Modal size (small, medium, large)
     */
    show(options = {}) {
        this.close();

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay && options.closable !== false) {
                this.close();
            }
        });

        const modal = document.createElement('div');
        modal.className = 'modal' + (options.size ? ' modal-' + options.size : '');

        // Header
        const header = document.createElement('div');
        header.className = 'modal-header';

        const title = document.createElement('h2');
        title.className = 'modal-title';
        title.textContent = options.title || '';
        header.appendChild(title);

        if (options.closable !== false) {
            const closeBtn = document.createElement('button');
            closeBtn.className = 'modal-close';
            closeBtn.setAttribute('aria-label', 'Close');
            closeBtn.textContent = '\u00D7';
            closeBtn.addEventListener('click', () => this.close());
            header.appendChild(closeBtn);
        }

        modal.appendChild(header);

        // Body
        const body = document.createElement('div');
        body.className = 'modal-body';

        if (typeof options.content === 'string') {
            const text = document.createElement('p');
            text.textContent = options.content;
            body.appendChild(text);
        } else if (options.content instanceof HTMLElement) {
            body.appendChild(options.content);
        }

        modal.appendChild(body);

        // Footer with actions
        if (options.actions && options.actions.length > 0) {
            const footer = document.createElement('div');
            footer.className = 'modal-footer';

            options.actions.forEach(action => {
                const btn = document.createElement('button');
                btn.className = 'btn ' + (action.primary ? 'btn-primary' : 'btn-secondary');
                btn.textContent = action.label;
                btn.addEventListener('click', () => {
                    if (action.onClick) {
                        action.onClick();
                    }
                    if (action.closeOnClick !== false) {
                        this.close();
                    }
                });
                footer.appendChild(btn);
            });

            modal.appendChild(footer);
        }

        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        this.activeModal = overlay;

        // Focus trap
        modal.setAttribute('tabindex', '-1');
        modal.focus();

        // ESC to close
        const escHandler = (e) => {
            if (e.key === 'Escape' && options.closable !== false) {
                this.close();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);

        // Animate in
        requestAnimationFrame(() => {
            overlay.classList.add('active');
        });
    },

    /**
     * Close the active modal
     */
    close() {
        if (this.activeModal) {
            this.activeModal.classList.remove('active');
            setTimeout(() => {
                if (this.activeModal && this.activeModal.parentNode) {
                    this.activeModal.parentNode.removeChild(this.activeModal);
                }
                this.activeModal = null;
            }, 200);
        }
    },

    /**
     * Show a confirmation dialog
     * @param {Object} options - Confirmation options
     * @param {string} options.title - Dialog title
     * @param {string} options.message - Confirmation message
     * @param {string} options.confirmLabel - Confirm button label
     * @param {string} options.cancelLabel - Cancel button label
     * @param {Function} options.onConfirm - Callback on confirm
     * @param {Function} options.onCancel - Callback on cancel
     */
    confirm(options = {}) {
        this.show({
            title: options.title || 'Confirm',
            content: options.message || 'Are you sure?',
            size: 'small',
            actions: [
                {
                    label: options.cancelLabel || 'Cancel',
                    primary: false,
                    onClick: options.onCancel,
                },
                {
                    label: options.confirmLabel || 'Confirm',
                    primary: true,
                    onClick: options.onConfirm,
                },
            ],
        });
    },
};

window.Modal = Modal;
