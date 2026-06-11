/**
 * DetectionLabel — shared helper for the Rule / ML / Rule+ML source badge.
 *
 * A threat can be caught by the regex rules, by the Guardian ML model, or by
 * both. The Guardian model shows up inside `matched_rules` as an entry with
 * `source === "model"` (rule_id `sv_guardian_model`), and its `confidence` is
 * the ML score. This helper classifies a detection and builds a badge whose
 * tooltip says exactly what detected it (and the ML score when present), so the
 * same label reads identically on the Threats, Agent Map, and Agent Runs views.
 */
const DetectionLabel = {
    ML_RULE_ID: 'sv_guardian_model',

    _isMl(r) {
        return !!r && (r.source === 'model' || r.rule_id === this.ML_RULE_ID);
    },

    /**
     * Classify from a matched_rules array (Threats page has the full array).
     * Returns { key, label, tooltip, mlScore } or null when nothing matched.
     */
    classify(matchedRules) {
        const rules = Array.isArray(matchedRules) ? matchedRules.filter(Boolean) : [];
        const ml = rules.find(r => this._isMl(r));
        const ruleHits = rules.filter(r => !this._isMl(r));
        const names = ruleHits.map(r => r.rule_name || r.name || r.rule_id).filter(Boolean);
        const mlScore = ml && typeof ml.confidence === 'number' ? ml.confidence : null;
        return this._build(!!ml, ruleHits.length > 0, mlScore, names);
    },

    /**
     * Classify from already-derived backend fields (Agent Map / Agent Runs get
     * these on the span/edge payload, where the full rule array isn't carried).
     * @param {string} source - 'rule' | 'ml' | 'rule_ml'
     * @param {number|null} mlScore - 0..1
     * @param {string[]} [ruleNames]
     */
    fromFields(source, mlScore, ruleNames) {
        if (!source) return null;
        const hasMl = source === 'ml' || source === 'rule_ml';
        const hasRule = source === 'rule' || source === 'rule_ml';
        const score = typeof mlScore === 'number' ? mlScore : null;
        return this._build(hasMl, hasRule, score, Array.isArray(ruleNames) ? ruleNames : []);
    },

    _build(hasMl, hasRule, mlScore, names) {
        if (!hasMl && !hasRule) return null;
        const scoreTxt = mlScore != null ? ` — score ${mlScore.toFixed(2)}` : '';
        const shown = (names || []).slice(0, 3);
        const more = (names || []).length > 3 ? '…' : '';
        const namesTxt = shown.length ? ` (${shown.join(', ')}${more})` : '';
        if (hasMl && hasRule) {
            return { key: 'rule_ml', label: 'Rule + ML', mlScore,
                tooltip: `Detected by rules${namesTxt} + Guardian ML${scoreTxt}` };
        }
        if (hasMl) {
            return { key: 'ml', label: 'ML', mlScore,
                tooltip: `Detected by Guardian ML${scoreTxt}` };
        }
        return { key: 'rule', label: 'Rule', mlScore: null,
            tooltip: `Detected by rules${namesTxt || ''}`.trim() };
    },

    /** Build a badge <span> from a matched_rules array, or null. */
    badge(matchedRules) {
        return this._el(this.classify(matchedRules));
    },

    /** Build a badge <span> from backend fields, or null. */
    badgeFromFields(source, mlScore, ruleNames) {
        return this._el(this.fromFields(source, mlScore, ruleNames));
    },

    _el(c) {
        if (!c) return null;
        const b = document.createElement('span');
        b.className = 'detection-badge detection-' + c.key;
        b.textContent = c.label;
        b.title = c.tooltip;           // hover: "Detected by …"
        b.setAttribute('aria-label', c.tooltip);
        return b;
    },

    /** HTML-string badge from backend fields (for innerHTML-built views like
     *  Agent Runs / Agent Map). Returns '' when nothing matched. The tooltip is
     *  attribute-escaped; the label/key are from a fixed safe set. */
    htmlFromFields(source, mlScore, ruleNames) {
        return this._html(this.fromFields(source, mlScore, ruleNames));
    },

    /** Merge detection fields (detection_source / ml_score / detection_rules)
     *  from a source node/edge into a destination node — for client-side
     *  roll-ups (e.g. the Agent Map mesh/sankey topologies that dedupe a tool
     *  across sessions). Mutates dst. Rule+ML if either side ever had each. */
    mergeInto(dst, src) {
        if (!src || !src.detection_source) return;
        const s = src.detection_source, p = dst.detection_source;
        const hasMl = s === 'ml' || s === 'rule_ml' || p === 'ml' || p === 'rule_ml';
        const hasRule = s === 'rule' || s === 'rule_ml' || p === 'rule' || p === 'rule_ml';
        dst.detection_source = hasMl && hasRule ? 'rule_ml' : (hasMl ? 'ml' : 'rule');
        if (src.ml_score != null) {
            dst.ml_score = dst.ml_score == null ? src.ml_score : Math.max(dst.ml_score, src.ml_score);
        }
        if (src.detection_rules && src.detection_rules.length) {
            dst.detection_rules = Array.from(
                new Set([...(dst.detection_rules || []), ...src.detection_rules])
            ).slice(0, 5);
        }
    },

    _html(c) {
        if (!c) return '';
        const esc = (s) => String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
        const t = esc(c.tooltip);
        return `<span class="detection-badge detection-${c.key}" title="${t}" aria-label="${t}">${c.label}</span>`;
    },
};
