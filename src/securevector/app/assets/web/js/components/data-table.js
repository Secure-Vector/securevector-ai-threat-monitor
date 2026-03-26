/**
 * DataTable — shared table component.
 *
 * Selection pattern (Linear/Notion style):
 *   - No dedicated checkbox column
 *   - Hover over first cell → checkbox overlay appears
 *   - Checked rows stay visible with accent highlight
 *   - Floating selection bar appears when any row is selected
 *   - Row hover shows action icons on far right (if actions provided)
 */

class DataTable {
    constructor(opts = {}) {
        this.columns = opts.columns || [];
        this.data = opts.data || [];
        this.sortKey = opts.sortKey || null;
        this.sortDir = opts.sortDir || 'asc';
        this.selectable = !!opts.selectable;
        this.pagination = opts.pagination || null;
        this.currentPage = 0;
        this.onRowClick = opts.onRowClick || null;
        this.onSort = opts.onSort || null;
        this.onSelectChange = opts.onSelectChange || null;
        this.idField = opts.idField || 'id';
        this.tableId = opts.tableId || '';
        this.emptyText = opts.emptyText || 'No data available.';
        this.selectedIds = new Set();
        this.customSort = opts.customSort || null;
        this.extraRowBuilder = opts.extraRowBuilder || null;

        // Row hover actions: [{ icon, title, onClick(item), className }]
        this.rowActions = opts.rowActions || null;

        // Bulk actions for selection bar: [{ label, className, onClick(selectedIds) }]
        this.bulkActions = opts.bulkActions || null;

        this.el = document.createElement('div');
        this.el.className = 'sv-table-wrap';
        this._render();
    }

    /* Public API */

    setData(data) {
        this.data = data;
        this.currentPage = 0;
        this._render();
    }

    setSort(key, dir) {
        this.sortKey = key;
        this.sortDir = dir;
        this._render();
    }

    getSelectedIds() { return new Set(this.selectedIds); }

    clearSelection() {
        this.selectedIds.clear();
        if (this.onSelectChange) this.onSelectChange(this.selectedIds);
        this._render();
    }

    refresh() { this._render(); }

    /* Internal */

    _render() {
        this.el.textContent = '';

        if (this.data.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'sv-table-empty';
            empty.textContent = this.emptyText;
            this.el.appendChild(empty);
            return;
        }

        // Floating selection bar
        if (this.selectable && this.selectedIds.size > 0) {
            this.el.appendChild(this._buildSelectionBar());
        }

        const sorted = this._getSortedData();
        const paged = this._getPagedData(sorted);

        const wrapper = document.createElement('div');
        wrapper.className = 'table-wrapper';

        const table = document.createElement('table');
        table.className = 'data-table';
        if (this.selectable) table.classList.add('sv-selectable');
        if (this.tableId) table.id = this.tableId;

        table.appendChild(this._buildThead());
        table.appendChild(this._buildTbody(paged));

        wrapper.appendChild(table);
        this.el.appendChild(wrapper);

        if (this.pagination && this._getTotalPages(sorted.length) > 1) {
            this.el.appendChild(this._buildPagination(sorted.length));
        }
    }

    _buildSelectionBar() {
        const bar = document.createElement('div');
        bar.className = 'sv-selection-bar';

        const count = document.createElement('span');
        count.className = 'sv-selection-count';
        count.textContent = `${this.selectedIds.size} selected`;
        bar.appendChild(count);

        if (this.bulkActions) {
            this.bulkActions.forEach(action => {
                const btn = document.createElement('button');
                btn.className = action.className || 'btn btn-sm';
                btn.textContent = action.label;
                btn.addEventListener('click', () => action.onClick(new Set(this.selectedIds)));
                bar.appendChild(btn);
            });
        }

        const clearBtn = document.createElement('button');
        clearBtn.className = 'btn btn-sm sv-selection-clear';
        clearBtn.textContent = 'Clear';
        clearBtn.addEventListener('click', () => this.clearSelection());
        bar.appendChild(clearBtn);

        return bar;
    }

    _buildThead() {
        const thead = document.createElement('thead');
        const row = document.createElement('tr');

        this.columns.forEach((col, idx) => {
            const th = document.createElement('th');

            // First column gets the select-all checkbox overlay when selectable
            if (idx === 0 && this.selectable) {
                th.className = 'sv-th-first';
                const inner = document.createElement('div');
                inner.className = 'sv-th-first-inner';

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'sv-select-all';
                cb.title = 'Select all';
                cb.checked = this.data.length > 0 && this.selectedIds.size === this.data.length;
                cb.indeterminate = this.selectedIds.size > 0 && this.selectedIds.size < this.data.length;
                cb.addEventListener('change', (e) => {
                    e.stopPropagation();
                    this._toggleSelectAll(e.target.checked);
                });
                cb.addEventListener('click', (e) => e.stopPropagation());
                inner.appendChild(cb);

                const label = document.createElement('span');
                label.className = 'sv-th-label';
                label.textContent = col.label;
                inner.appendChild(label);

                th.appendChild(inner);
            } else if (col.sortable && col.key) {
                th.className = 'sv-table-th-sort';
                const label = document.createElement('span');
                label.textContent = col.label;
                th.appendChild(label);

                const arrow = document.createElement('span');
                arrow.className = 'sv-sort-arrow';
                if (this.sortKey === col.key) {
                    arrow.textContent = this.sortDir === 'asc' ? '\u25B2' : '\u25BC';
                    arrow.classList.add('active');
                } else {
                    arrow.textContent = '\u25B4';
                }
                th.appendChild(arrow);
            } else {
                th.textContent = col.label || '';
            }

            // Sorting click for all sortable columns (including first)
            if (col.sortable && col.key) {
                th.style.cursor = 'pointer';
                th.style.userSelect = 'none';
                th.addEventListener('click', (e) => {
                    if (e.target.tagName === 'INPUT') return;
                    if (this.sortKey === col.key) {
                        this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
                    } else {
                        this.sortKey = col.key;
                        this.sortDir = col.defaultDir || 'asc';
                    }
                    this.currentPage = 0;
                    if (this.onSort) this.onSort(this.sortKey, this.sortDir);
                    else this._render();
                });
            }

            if (col.width) th.style.width = col.width;
            if (col.align) th.style.textAlign = col.align;
            row.appendChild(th);
        });

        thead.appendChild(row);
        return thead;
    }

    _buildTbody(rows) {
        const tbody = document.createElement('tbody');

        rows.forEach(item => {
            const tr = document.createElement('tr');
            const rowId = item[this.idField];
            const isSelected = this.selectedIds.has(rowId);
            if (isSelected) tr.classList.add('sv-row-selected');

            if (this.onRowClick) {
                tr.style.cursor = 'pointer';
                tr.addEventListener('click', (e) => {
                    if (e.target.closest('.sv-row-cb-wrap') || e.target.closest('.sv-row-actions') ||
                        e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'A') return;
                    this.onRowClick(item);
                });
            }

            // Data cells
            this.columns.forEach((col, idx) => {
                const td = document.createElement('td');
                if (col.align) td.style.textAlign = col.align;
                if (col.className) td.className = col.className;

                // First cell: overlay checkbox on hover
                if (idx === 0 && this.selectable) {
                    td.className = (td.className ? td.className + ' ' : '') + 'sv-td-first';

                    const inner = document.createElement('div');
                    inner.className = 'sv-td-first-inner';

                    const cbWrap = document.createElement('div');
                    cbWrap.className = 'sv-row-cb-wrap';
                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.className = 'sv-row-cb';
                    cb.checked = isSelected;
                    cb.addEventListener('change', (e) => {
                        e.stopPropagation();
                        if (e.target.checked) this.selectedIds.add(rowId);
                        else this.selectedIds.delete(rowId);
                        if (this.onSelectChange) this.onSelectChange(this.selectedIds);
                        this._render();
                    });
                    cb.addEventListener('click', (e) => e.stopPropagation());
                    cbWrap.appendChild(cb);
                    inner.appendChild(cbWrap);

                    const content = document.createElement('div');
                    content.className = 'sv-td-first-content';
                    this._renderCellContent(content, col, item);
                    inner.appendChild(content);

                    td.appendChild(inner);
                } else {
                    this._renderCellContent(td, col, item);
                }

                tr.appendChild(td);
            });

            // Hover action icons on the right (overlays last cell)
            if (this.rowActions && this.rowActions.length > 0) {
                const overlay = document.createElement('div');
                overlay.className = 'sv-row-actions';
                this.rowActions.forEach(action => {
                    const btn = document.createElement('button');
                    btn.className = 'sv-row-action-btn' + (action.className ? ' ' + action.className : '');
                    btn.title = action.title || '';
                    btn.textContent = action.icon || '';
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        action.onClick(item);
                    });
                    overlay.appendChild(btn);
                });
                // Attach overlay to last td
                const lastTd = tr.lastElementChild;
                if (lastTd) {
                    lastTd.style.position = 'relative';
                    lastTd.appendChild(overlay);
                }
            }

            tbody.appendChild(tr);

            if (this.extraRowBuilder) {
                const extra = this.extraRowBuilder(item);
                if (extra) tbody.appendChild(extra);
            }
        });

        return tbody;
    }

    _renderCellContent(td, col, item) {
        if (col.render) {
            const content = col.render(col.key ? item[col.key] : null, item);
            if (content instanceof HTMLElement || content instanceof DocumentFragment) {
                td.appendChild(content);
            } else if (content !== undefined && content !== null) {
                td.textContent = String(content);
            }
        } else if (col.key) {
            td.textContent = item[col.key] ?? '';
        }
    }

    _buildPagination(totalItems) {
        const totalPages = this._getTotalPages(totalItems);
        const pager = document.createElement('div');
        pager.className = 'sv-table-pager';

        const prevBtn = document.createElement('button');
        prevBtn.className = 'btn btn-sm';
        prevBtn.textContent = '\u2190 Prev';
        prevBtn.disabled = this.currentPage === 0;
        if (prevBtn.disabled) prevBtn.style.opacity = '0.4';
        prevBtn.addEventListener('click', () => { this.currentPage--; this._render(); });
        pager.appendChild(prevBtn);

        const info = document.createElement('span');
        info.className = 'sv-table-page-info';
        info.textContent = `Page ${this.currentPage + 1} of ${totalPages}`;
        pager.appendChild(info);

        const nextBtn = document.createElement('button');
        nextBtn.className = 'btn btn-sm';
        nextBtn.textContent = 'Next \u2192';
        nextBtn.disabled = this.currentPage >= totalPages - 1;
        if (nextBtn.disabled) nextBtn.style.opacity = '0.4';
        nextBtn.addEventListener('click', () => { this.currentPage++; this._render(); });
        pager.appendChild(nextBtn);

        return pager;
    }

    /* Sorting & paging */

    _getSortedData() {
        if (!this.sortKey) return [...this.data];
        if (this.customSort) return this.customSort([...this.data], this.sortKey, this.sortDir);

        const dir = this.sortDir === 'asc' ? 1 : -1;
        const key = this.sortKey;

        return [...this.data].sort((a, b) => {
            let va = a[key], vb = b[key];
            if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
            if (key.includes('time') || key.includes('date') || key.includes('seen') || key.includes('created') || key.includes('updated')) {
                va = new Date(va || 0).getTime();
                vb = new Date(vb || 0).getTime();
                return (va - vb) * dir;
            }
            va = String(va || '').toLowerCase();
            vb = String(vb || '').toLowerCase();
            if (va < vb) return -1 * dir;
            if (va > vb) return 1 * dir;
            return 0;
        });
    }

    _getPagedData(sorted) {
        if (!this.pagination) return sorted;
        const ps = this.pagination.pageSize || 15;
        return sorted.slice(this.currentPage * ps, (this.currentPage + 1) * ps);
    }

    _getTotalPages(totalItems) {
        if (!this.pagination) return 1;
        return Math.ceil(totalItems / (this.pagination.pageSize || 15));
    }

    _toggleSelectAll(checked) {
        this.selectedIds.clear();
        if (checked) this.data.forEach(item => this.selectedIds.add(item[this.idField]));
        if (this.onSelectChange) this.onSelectChange(this.selectedIds);
        this._render();
    }
}

window.DataTable = DataTable;
