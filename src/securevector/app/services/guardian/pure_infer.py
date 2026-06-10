"""Pure-Python (stdlib-only) inference runtime for SecureVector Guardian.

Loads the exported runtime bundle and classifies text using ONLY the Python
standard library — no scikit-learn, no numpy, nothing to install. This is what
ships inside the SecureVector local app (which has no ML dependencies).

It faithfully reproduces the training pipeline: word + char TF-IDF (sublinear
tf, smoothed idf, per-block L2 norm) -> linear scores -> softmax. Verified for
parity against the scikit-learn model by ``tests/test_parity.py``.

    from svguardian.model.pure_infer import PureGuardian
    g = PureGuardian.load("models/guardian.runtime.json.gz")
    g.predict("ignore all previous instructions")
"""

from __future__ import annotations

import gzip
import json
import math
import re
from collections import Counter

# Mirrors scikit-learn's defaults exactly.
_TOKEN = re.compile(r"(?u)\b\w\w+\b")
_WS = re.compile(r"\s\s+")


def _word_ngrams(text: str, lo: int, hi: int) -> list:
    tokens = _TOKEN.findall(text.lower())
    out = list(tokens) if lo == 1 else []
    n = len(tokens)
    for k in range(max(lo, 2), hi + 1):
        for i in range(n - k + 1):
            out.append(" ".join(tokens[i:i + k]))
    return out


def _char_wb_ngrams(text: str, lo: int, hi: int) -> list:
    text = _WS.sub(" ", text.lower())
    out = []
    for w in text.split():
        w = " " + w + " "
        wl = len(w)
        for k in range(lo, hi + 1):
            offset = 0
            out.append(w[offset:offset + k])
            while offset + k < wl:
                offset += 1
                out.append(w[offset:offset + k])
            if offset == 0:  # short word counted once
                break
    return out


def _tfidf_block(ngrams: list, vocab: dict, idf: list, sublinear: bool) -> dict:
    """Return {col_index: l2-normalized tfidf value} for in-vocab terms."""
    counts = Counter(g for g in ngrams if g in vocab)
    vec = {}
    for term, cnt in counts.items():
        tf = (1.0 + math.log(cnt)) if sublinear else float(cnt)
        col = vocab[term]
        vec[col] = tf * idf[col]
    norm = math.sqrt(sum(v * v for v in vec.values()))
    if norm > 0:
        for col in vec:
            vec[col] /= norm
    return vec


class PureGuardian:
    def __init__(self, bundle: dict):
        self.classes = bundle["classes"]
        self.benign = bundle["benign"]
        self.threshold = float(bundle["threshold"])
        self.window_min_score = float(bundle.get("window_min_score", 0.86))
        self.n_word = int(bundle["n_word_features"])
        self.word = bundle["word"]
        self.char = bundle["char"]
        self.coef = bundle["coef"]            # [n_classes][n_features]
        self.intercept = bundle["intercept"]  # [n_classes]
        self._benign_idx = self.classes.index(self.benign) if self.benign in self.classes else -1

    @classmethod
    def load(cls, path: str, verify: bool = True) -> "PureGuardian":
        """Load the runtime bundle. If a ``<path>.sha256`` sidecar exists and
        ``verify`` is set, the file's SHA-256 must match (tamper detection)."""
        import hashlib
        import os

        with open(path, "rb") as fh:
            data = fh.read()
        sidecar = path + ".sha256"
        if verify and os.path.exists(sidecar):
            with open(sidecar, encoding="utf-8") as fh:
                expected = fh.read().strip()
            actual = hashlib.sha256(data).hexdigest()
            if actual != expected:
                raise ValueError(f"runtime bundle integrity check failed: {path}")
        if path.endswith(".gz"):
            data = gzip.decompress(data)
        return cls(json.loads(data.decode("utf-8")))

    def _scores(self, text: str) -> list:
        wv = _tfidf_block(_word_ngrams(text, *self.word["ngram_range"]),
                          self.word["vocab"], self.word["idf"], self.word["sublinear_tf"])
        cv = _tfidf_block(_char_wb_ngrams(text, *self.char["ngram_range"]),
                          self.char["vocab"], self.char["idf"], self.char["sublinear_tf"])
        scores = list(self.intercept)
        for k in range(len(self.classes)):
            row = self.coef[k]
            s = scores[k]
            for col, val in wv.items():
                s += val * row[col]
            for col, val in cv.items():
                s += val * row[self.n_word + col]
            scores[k] = s
        return scores

    @staticmethod
    def _softmax(scores: list) -> list:
        m = max(scores)
        exps = [math.exp(s - m) for s in scores]
        total = sum(exps)
        return [e / total for e in exps]

    def predict(self, text: str) -> dict:
        proba = self._softmax(self._scores(text))
        ranked = sorted(zip(self.classes, proba), key=lambda kv: kv[1], reverse=True)
        mal_score = sum(p for c, p in ranked if c != self.benign)
        verdict = "malicious" if mal_score >= self.threshold else "benign"
        top_attack = next(((c, p) for c, p in ranked if c != self.benign), (None, 0.0))
        return {
            "verdict": verdict,
            "category": top_attack[0] if verdict == "malicious" else None,
            "confidence": round(float(top_attack[1]), 4),
            "malicious_score": round(float(mal_score), 4),
            "threshold": round(self.threshold, 4),
            "top3": [(c, round(float(p), 4)) for c, p in ranked[:3]],
        }
