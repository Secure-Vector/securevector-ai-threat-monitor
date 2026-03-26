/**
 * DataTable — shared table component for consistent table rendering.
 *
 * Uses <table> elements with consistent styling matching the activity-table format:
 *   - Distinct header row (bg-secondary, text-secondary, 2px border)
 *   - Clean row separation with hover highlights
 *   - Built-in sorting with arrow indicators
 *   - Optional checkbox column with select-all
 *   - Optional pagination
 *
 * Usage:
 *   const dt = new DataTable({
 *       columns: [
 *           { key: 'name', label: 'Name', sortable: true },
 *           { key: 'status', label: 'Status', sortable: true, render: (val, row) => badge(val) },
 *           { key: null, label: 'Actions', render: (_, row) => actionsCell(row) },
 *       ],
 *       data: [...],
 *       sortKey: 'name',
 *       sortDir: 'asc',
 *       checkbox: false,
 *       pagination: { pageSize: 15 },
 *       onRowClick: (row) => openDetail(row),
 *       onSort: (key, dir) => reload(),
 *       onSelectChange: (selectedIds) => updateBulkActions(selectedIds),
 *       idField: 'id',
 *       tableId: 'my-table',
 *       emptyText: 'No data available.',
 *   });
 *
 *   container.appendChild(dt.el);
 *   dt.setData(newData);            // re-render with new data
 *   dt.setSort(key, dir);           // change sort programmatically
 *   dt.getSelectedIds();            // Set<string> of checked row IDs
 */

class DataTable {
    constructor(opts = {}) {
        this.columns = opts.columns || [];
        this.data = opts.data || [];
        this.sortKey = opts.sortKey || null;
        this.sortDir = opts.sortDir || 'asc';
        this.checkbox = !!opts.checkbox;
        this.pagination = opts.pagination || null; // { pageSize: N }
        this.currentPage = 0;
        this.onRowClick = opts.onRowClick || null;
        this.onSort = opts.onSort || null;
        this.onSelectChange = opts.onSelectChange || null;
        this.idField = opts.idField || 'id';
        this.tableId = opts.tableId || '';
        this.emptyText = opts.emptyText || 'No data available.';
        this.selectedIds = new Set();
        this.customSort = opts.customSort || null; // (data, key, dir) => sorted

        // Extra row builder (e.g., expandable pattern rows for rules)
        this.extraRowBuilder = opts.extraRowBuilder || null;

        // Build DOM
        this.el = document.createElement('div');
        this.el.className = 'sv-table-wrap';
        this._render();
    }

    /* ------------------------------------------------------------------ */
    /* Public API                                                          */
    /* ------------------------------------------------------------------ */

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

    getSelectedIds() {
        return new Set(this.selectedIds);
    }

    clearSelection() {
        this.selectedIds.clear();
        if (this.onSelectChange) this.onSelectChange(this.selectedIds);
        this._render();
    }

    refresh() {
        this._render();
    }

    /* ------------------------------------------------------------------ */
    /* Internal rendering                                                  */
    /* ------------------------------------------------------------------ */

    _render() {
        this.el.textContent = '';

        const sorted = this._getSortedData();
        const paged = this._getPagedData(sorted);

        if (this.data.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'sv-table-empty';
            empty.textContent = this.emptyText;
            this.el.appendChild(empty);
            return;
        }

        const wrapper = document.createElement('div');
        wrapper.className = 'table-wrapper';

        const table = document.createElement('table');
        table.className = 'data-table';
        if (this.tableId) table.id = this.tableId;

        table.appendChild(this._buildThead());
        table.appendChild(this._buildTbody(paged));

        wrapper.appendChild(table);
        this.el.appendChild(wrapper);

        if (this.pagination && this._getTotalPages(sorted.length) > 1) {
            this.el.appendChild(this._buildPagination(sorted.length));
        }
    }

    _buildThead() {
        const thead = document.createElement('thead');
        const row = document.createElement('tr');

        // Checkbox column header
        if (this.checkbox) {
            const th = document.createElement('th');
            th.className = 'sv-table-th-cb';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'sv-select-all';
            cb.title = 'Select all';
            cb.checked = this.data.length > 0 && this.selectedIds.size === this.data.length;
            cb.addEventListener('change', (e) => this._toggleSelectAll(e.target.checked));
            th.appendChild(cb);
            row.appendChild(th);
        }

        // Data columns
        this.columns.forEach(col => {
            const th = document.createElement('th');

            if (col.sortable && col.key) {
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

                th.addEventListener('click', () => {
                    if (this.sortKey === col.key) {
                        this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
                    } else {
                        this.sortKey = col.key;
                        this.sortDir = col.defaultDir || 'asc';
                    }
                    this.currentPage = 0;
                    if (this.onSort) {
                        this.onSort(this.sortKey, this.sortDir);
                    } else {
                        this._render();
                    }
                });
            } else {
                th.textContent = col.label || '';
            }

            if (col.width) th.style.width = col.width;
            if (col.align) th.style.textAlign = col.align;
            if (col.noSort) th.setAttribute('data-no-sort', '');
            row.appendChild(th);
        });

        thead.appendChild(row);
        return thead;
    }

    _buildTbody(rows) {
        const tbody = document.createElement('tbody');

        rows.forEach(item => {
            const tr = document.createElement('tr');

            if (this.onRowClick) {
                tr.style.cursor = 'pointer';
                tr.addEventListener('click', (e) => {
                    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'A') return;
                    this.onRowClick(item);
                });
            }

            // Checkbox cell
            if (this.checkbox) {
                const td = document.createElement('td');
                td.className = 'sv-table-td-cb';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'sv-row-cb';
                const rowId = item[this.idField];
                cb.checked = this.selectedIds.has(rowId);
                cb.addEventListener('change', (e) => {
                    e.stopPropagation();
                    if (e.target.checked) this.selectedIds.add(rowId);
                    else this.selectedIds.delete(rowId);
                    if (this.onSelectChange) this.onSelectChange(this.selectedIds);
                    // Update select-all checkbox
                    const all = this.el.querySelector('.sv-select-all');
                    if (all) all.checked = this.selectedIds.size === this.data.length;
                });
                cb.addEventListener('click', (e) => e.stopPropagation());
                td.appendChild(cb);
                tr.appendChild(td);
            }

            // Data cells
            this.columns.forEach(col => {
                const td = document.createElement('td');
                if (col.align) td.style.textAlign = col.align;
                if (col.className) td.className = col.className;

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

                tr.appendChild(td);
            });

            tbody.appendChild(tr);

            // Extra rows (e.g., expandable patterns)
            if (this.extraRowBuilder) {
                const extra = this.extraRowBuilder(item);
                if (extra) tbody.appendChild(extra);
            }
        });

        return tbody;
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

    /* ------------------------------------------------------------------ */
    /* Sorting & paging                                                    */
    /* ------------------------------------------------------------------ */

    _getSortedData() {
        if (!this.sortKey) return [...this.data];
        if (this.customSort) return this.customSort([...this.data], this.sortKey, this.sortDir);

        const dir = this.sortDir === 'asc' ? 1 : -1;
        const key = this.sortKey;

        return [...this.data].sort((a, b) => {
            let va = a[key], vb = b[key];
            // Numbers
            if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
            // Dates (ISO strings)
            if (key.includes('time') || key.includes('date') || key.includes('seen') || key.includes('created') || key.includes('updated')) {
                va = new Date(va || 0).getTime();
                vb = new Date(vb || 0).getTime();
                return (va - vb) * dir;
            }
            // Strings
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
        const start = this.currentPage * ps;
        return sorted.slice(start, start + ps);
    }

    _getTotalPages(totalItems) {
        if (!this.pagination) return 1;
        return Math.ceil(totalItems / (this.pagination.pageSize || 15));
    }

    _toggleSelectAll(checked) {
        this.selectedIds.clear();
        if (checked) {
            this.data.forEach(item => this.selectedIds.add(item[this.idField]));
        }
        this.el.querySelectorAll('.sv-row-cb').forEach(cb => { cb.checked = checked; });
        if (this.onSelectChange) this.onSelectChange(this.selectedIds);
    }
}

// Export globally
window.DataTable = DataTable;
