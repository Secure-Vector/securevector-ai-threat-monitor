// src/securevector/app/assets/web/js/pages/terminals-layout.js
// The shape of the Terminals workspace: a binary tree of panes and splits.
//
// It is deliberately free of the DOM. The page diffs the tree it had against
// the tree an operation returned and only creates or disposes the panes that
// actually appeared or vanished, so a split never restarts the terminal in the
// pane that was split. That diff only works if every operation returns a new
// tree and leaves the old one intact, which is what every function here does.
const TerminalsLayout = {
    // A pane narrower than this is a column of broken glyphs rather than a
    // terminal, so a drag can never take a side below it.
    MIN_RATIO: 0.15,

    // Every tab in a group is a task the page has to keep straight, and one
    // of them is a live socket the moment it is brought forward. Past this a
    // pane is a filing cabinet rather than a terminal, and the titles are too
    // narrow to tell apart.
    MAX_GROUP: 8,

    // How deep a stored tree may nest. Six panes need five levels; this is
    // room to spare, and a bound the parser can refuse past.
    MAX_DEPTH: 64,

    _id() {
        const hex = (n) => n.toString(16).padStart(2, '0');
        if (typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function') {
            const bytes = new Uint8Array(6);
            crypto.getRandomValues(bytes);
            return Array.from(bytes, hex).join('');
        }
        let out = '';
        for (let i = 0; i < 6; i++) out += hex(Math.floor(Math.random() * 256));
        return out;
    },

    /** A fresh pane holding one task.
     *  A pane holds a group: `taskIds` in tab order, and `taskId`, the one it
     *  is showing. `taskId` is always a member of the group, or null with an
     *  empty group, so every reader that only knows about `taskId` still asks
     *  the right question: what is this pane showing. */
    create(taskId) {
        const task = taskId == null ? null : String(taskId);
        return { type: 'pane', id: this._id(), taskIds: task == null ? [] : [task], taskId: task };
    },

    /** A pane's group, tolerating a node built before panes held groups. */
    _ids(node) {
        if (!node) return [];
        if (Array.isArray(node.taskIds)) return node.taskIds.filter(x => typeof x === 'string' && x);
        return node.taskId == null ? [] : [String(node.taskId)];
    },

    /** A new pane node with that group, normalised: an active task that is not
     *  in the group is not a state the rest of the page could read. */
    _pane(node, taskIds, taskId) {
        const ids = taskIds.map(String);
        const active = ids.includes(taskId) ? taskId : (ids.length ? ids[0] : null);
        return { ...node, taskIds: ids, taskId: active };
    },

    /** The pane without one task, and whichever neighbour takes its place: the
     *  tab after it, or the one before it when it was the last. Null when the
     *  task was the pane's only one, which is a pane the caller has to close. */
    _drop(node, taskId) {
        const ids = this._ids(node);
        const at = ids.indexOf(taskId);
        if (at < 0) return node;
        const left = ids.filter(x => x !== taskId);
        if (!left.length) return null;
        return this._pane(node, left, node.taskId === taskId ? left[Math.min(at, left.length - 1)] : node.taskId);
    },

    /** The pane whose group holds a task. A task lives in exactly one pane. */
    _holder(root, taskId) {
        return this.panes(root).find(p => this._ids(p).includes(taskId)) || null;
    },

    find(root, id) {
        if (!root || !id) return null;
        if (root.id === id) return root;
        if (root.type !== 'split') return null;
        return this.find(root.a, id) || this.find(root.b, id);
    },

    /** The split that holds `id`, or null for the root and for anything absent. */
    parent(root, id) {
        if (!root || root.type !== 'split' || !id) return null;
        if (root.a.id === id || root.b.id === id) return root;
        return this.parent(root.a, id) || this.parent(root.b, id);
    },

    /** Panes in reading order: left before right, top before bottom. */
    panes(root) {
        if (!root) return [];
        if (root.type === 'pane') return [root];
        return this.panes(root.a).concat(this.panes(root.b));
    },

    /** Rebuild the tree, handing every node to `fn` and keeping what it returns. */
    _map(node, fn) {
        if (!node) return null;
        if (node.type === 'split') {
            const a = this._map(node.a, fn);
            const b = this._map(node.b, fn);
            const next = (a === node.a && b === node.b) ? node : { ...node, a, b };
            return fn(next);
        }
        return fn(node);
    },

    /** The pane becomes a split: the old pane on the a side, a new pane on b. */
    split(root, paneId, dir, newTaskId) {
        if (!root || (dir !== 'row' && dir !== 'col')) return root;
        const target = this.find(root, paneId);
        if (!target || target.type !== 'pane') return root;
        const made = { type: 'split', id: this._id(), dir, ratio: 0.5, a: target, b: this.create(newTaskId) };
        return this._map(root, (n) => (n === target ? made : n));
    },

    /** Close a pane: its sibling takes the whole space the split occupied. */
    close(root, paneId) {
        if (!root) return null;
        const target = this.find(root, paneId);
        if (!target || target.type !== 'pane') return root;
        if (root === target) return null;
        const holder = this.parent(root, paneId);
        const survivor = holder.a.id === paneId ? holder.b : holder.a;
        if (root === holder) return survivor;
        return this._map(root, (n) => (n === holder ? survivor : n));
    },

    // Which way a split has to run for a pane to land on a given edge.
    EDGE_DIRS: { left: 'row', right: 'row', top: 'col', bottom: 'col' },

    /** Take a pane out of the tree and drop it against one edge of another.
     *  The moved pane keeps its id, so the page recognises it across the
     *  re-render and its terminal is moved rather than restarted. */
    move(root, paneId, targetPaneId, edge) {
        const dir = this.EDGE_DIRS[edge];
        if (!root || !dir || !paneId || paneId === targetPaneId) return root;
        const moving = this.find(root, paneId);
        const target = this.find(root, targetPaneId);
        if (!moving || moving.type !== 'pane') return root;
        if (!target || target.type !== 'pane') return root;
        const without = this.close(root, paneId);
        // The pane was the whole layout; there is nowhere else to put it.
        if (!without) return root;
        const landing = this.find(without, targetPaneId);
        if (!landing) return root;
        const first = edge === 'left' || edge === 'top';
        const made = {
            type: 'split', id: this._id(), dir, ratio: 0.5,
            a: first ? moving : landing,
            b: first ? landing : moving,
        };
        return this._map(without, (n) => (n === landing ? made : n));
    },

    setRatio(root, splitId, ratio) {
        const target = this.find(root, splitId);
        if (!target || target.type !== 'split') return root;
        if (typeof ratio !== 'number' || !isFinite(ratio)) return root;
        const clamped = Math.min(1 - this.MIN_RATIO, Math.max(this.MIN_RATIO, ratio));
        if (clamped === target.ratio) return root;
        return this._map(root, (n) => (n === target ? { ...n, ratio: clamped } : n));
    },

    /** The pane is claimed for one task: its group becomes exactly that task,
     *  or empty. Anything it was holding is let go. */
    replaceTask(root, paneId, taskId) {
        const target = this.find(root, paneId);
        if (!target || target.type !== 'pane') return root;
        const next = taskId == null ? null : String(taskId);
        const ids = next == null ? [] : [next];
        if (target.taskId === next && this._ids(target).length === ids.length) return root;
        return this._map(root, (n) => (n === target ? this._pane(n, ids, next) : n));
    },

    /** Put a task in a pane's group and bring it forward. The task leaves
     *  whichever pane held it before, and that pane goes if it was its last. */
    addTask(root, paneId, taskId) {
        if (!root || taskId == null) return root;
        const next = String(taskId);
        const target = this.find(root, paneId);
        if (!target || target.type !== 'pane') return root;
        if (this._ids(target).includes(next)) return this.setActive(root, paneId, next);
        // A full pane takes nothing: silently dropping the task it already
        // holds, or growing without bound, are both worse than refusing.
        if (this._ids(target).length >= this.MAX_GROUP) return root;
        let tree = root;
        const from = this._holder(root, next);
        if (from) {
            const left = this._drop(from, next);
            tree = left ? this._map(tree, (n) => (n === from ? left : n)) : this.close(tree, from.id);
        }
        const landing = tree ? this.find(tree, paneId) : null;
        if (!landing) return root;
        return this._map(tree, (n) => (n === landing ? this._pane(n, this._ids(n).concat([next]), next) : n));
    },

    /** Take a task out of whichever pane holds it, closing a pane it empties. */
    removeTask(root, taskId) {
        if (!root || taskId == null) return root;
        const gone = String(taskId);
        const holder = this._holder(root, gone);
        if (!holder) return root;
        const left = this._drop(holder, gone);
        if (!left) return this.close(root, holder.id);
        return this._map(root, (n) => (n === holder ? left : n));
    },

    /** Show a task the pane already holds. */
    setActive(root, paneId, taskId) {
        const target = this.find(root, paneId);
        if (!target || target.type !== 'pane') return root;
        const next = taskId == null ? null : String(taskId);
        if (next == null || !this._ids(target).includes(next)) return root;
        if (target.taskId === next) return root;
        return this._map(root, (n) => (n === target ? this._pane(n, this._ids(n), next) : n));
    },

    /** One pane's whole group joins another's, and the pane it emptied goes,
     *  its split collapsing behind it. The target keeps showing whatever it
     *  was showing: a merge puts tasks side by side, it does not ask to change
     *  tab. Refused rather than truncated when the two together would not fit,
     *  because dropping tasks on the floor is worse than not merging. */
    mergePane(root, paneId, targetPaneId) {
        if (!root || !paneId || !targetPaneId || paneId === targetPaneId) return root;
        const source = this.find(root, paneId);
        const target = this.find(root, targetPaneId);
        if (!source || source.type !== 'pane') return root;
        if (!target || target.type !== 'pane') return root;
        // The source is the whole layout, so there is no target beside it.
        if (root === source) return root;
        const held = this._ids(target);
        const joining = this._ids(source).filter(x => !held.includes(x));
        const ids = held.concat(joining);
        if (ids.length > this.MAX_GROUP) return root;
        const without = this.close(root, paneId);
        if (!without) return root;
        const landing = this.find(without, targetPaneId);
        if (!landing) return root;
        return this._map(without, (n) => (n === landing ? this._pane(n, ids, landing.taskId) : n));
    },

    /** Swap one task for another in place. A restarted harness is a new task,
     *  and it has to come back in the tab its old one was in rather than
     *  disbanding the group around it. */
    swapTask(root, oldTaskId, newTaskId) {
        if (!root || oldTaskId == null || newTaskId == null) return root;
        const from = String(oldTaskId);
        const to = String(newTaskId);
        if (from === to) return root;
        // The new task may already be somewhere; it can only be in one pane.
        const tree = this.removeTask(root, to);
        if (!tree) return root;
        const holder = this._holder(tree, from);
        if (!holder) return root;
        const ids = this._ids(holder).map(x => (x === from ? to : x));
        return this._map(tree, (n) => (n === holder ? this._pane(n, ids, holder.taskId === from ? to : holder.taskId) : n));
    },

    serialize(root) {
        if (!root) return null;
        if (root.type === 'pane') return { type: 'pane', id: root.id, taskIds: this._ids(root), taskId: root.taskId };
        return {
            type: 'split', id: root.id, dir: root.dir, ratio: root.ratio,
            a: this.serialize(root.a), b: this.serialize(root.b),
        };
    },

    /** Read back a stored tree, keeping only fields this version understands.
     *  Anything malformed returns null rather than a half tree: the page falls
     *  back to no layout, which is always a safe state. */
    parse(obj) {
        const seen = new Set();
        const seenTasks = new Set();
        // A pane the reader gave up on, as against a malformed one: the split
        // above it closes over it, exactly as closing that pane would, while a
        // node this version cannot read still rejects the whole tree.
        const DROPPED = { dropped: true };
        const walk = (n, depth) => {
            // Stored trees are untrusted input, and this walk is recursive:
            // without a bound, a deep enough one overflows the stack and the
            // throw lands somewhere with no business handling it. No real
            // layout is anywhere near this deep.
            if (depth > this.MAX_DEPTH) return null;
            if (!n || typeof n !== 'object') return null;
            if (typeof n.id !== 'string' || !n.id) return null;
            if (seen.has(n.id)) return null;
            seen.add(n.id);
            if (n.type === 'pane') {
                // Two shapes: a stored group, and the single task panes that
                // are already in people's browsers from before a pane could
                // hold more than one. The old shape is a group of one.
                const raw = Array.isArray(n.taskIds)
                    ? Array.from(new Set(n.taskIds.filter(x => typeof x === 'string' && x)))
                    : (typeof n.taskId === 'string' && n.taskId ? [n.taskId] : []);
                // A task lives in exactly one pane. A stored tree that puts one
                // in two would mount it twice, on two sockets, and only the
                // first would ever be found again, so the later pane gives it
                // up, and goes if that was all it was holding.
                const ids = raw.filter(x => !seenTasks.has(x)).slice(0, this.MAX_GROUP);
                ids.forEach(x => seenTasks.add(x));
                if (raw.length && !ids.length) return DROPPED;
                const active = typeof n.taskId === 'string' && ids.includes(n.taskId)
                    ? n.taskId : (ids.length ? ids[0] : null);
                return { type: 'pane', id: n.id, taskIds: ids, taskId: active };
            }
            if (n.type !== 'split') return null;
            if (n.dir !== 'row' && n.dir !== 'col') return null;
            const a = walk(n.a, depth + 1);
            const b = walk(n.b, depth + 1);
            if (!a || !b) return null;
            if (a === DROPPED && b === DROPPED) return DROPPED;
            if (a === DROPPED || b === DROPPED) return a === DROPPED ? b : a;
            const ratio = typeof n.ratio === 'number' && isFinite(n.ratio) ? n.ratio : 0.5;
            return {
                type: 'split', id: n.id, dir: n.dir,
                ratio: Math.min(1 - this.MIN_RATIO, Math.max(this.MIN_RATIO, ratio)),
                a, b,
            };
        };
        const out = walk(obj, 0);
        return out === DROPPED ? null : out;
    },

    /** Drop the tasks that no longer exist from every group, and the panes
     *  that leaves empty, collapsing the splits behind them. A restored layout
     *  must never open a socket for a task the server has forgotten. */
    prune(root, aliveTaskIds) {
        const alive = aliveTaskIds instanceof Set ? aliveTaskIds : new Set(aliveTaskIds || []);
        const walk = (n) => {
            if (!n) return null;
            if (n.type === 'pane') {
                const ids = this._ids(n);
                const kept = ids.filter(x => alive.has(x));
                if (!kept.length) return null;
                if (kept.length === ids.length) return n;
                // The pane stays because it still holds something; only the
                // tab it was showing has to be replaced when that one went.
                return this._pane(n, kept, n.taskId);
            }
            const a = walk(n.a);
            const b = walk(n.b);
            if (!a) return b;
            if (!b) return a;
            if (a === n.a && b === n.b) return n;
            return { ...n, a, b };
        };
        return walk(root);
    },
};

window.TerminalsLayout = TerminalsLayout;
