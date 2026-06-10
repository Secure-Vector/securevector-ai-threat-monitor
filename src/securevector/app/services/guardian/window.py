"""Windowed inference for long documents (emails, PDFs, webpages, RAG context).

A whole-document TF-IDF vector dilutes a short malicious span buried in a large
benign body, so a single classification misses indirect prompt injection. The
fix is the standard one: slide a window over the text, classify each window,
and take the MAX malicious score — a threat anywhere makes the document a
threat. Also classifies the whole text (some attacks are holistic).

Works with any predictor exposing ``.predict(text) -> {... "malicious_score" ...}``
(both ``Guardian`` and the zero-dep ``PureGuardian``).
"""

from __future__ import annotations

import re

# Split on sentence/line boundaries so windows align to natural spans.
_SPLIT = re.compile(r"(?<=[.!?])\s+|[\n\r]+|<!--|-->")

# Bound work on very large inputs so latency stays predictable.
MAX_WINDOWS = 300
WORD_WINDOW = 24   # words per window — finer than 40 to resist benign-token dilution
WORD_STRIDE = 12   # overlap so a span isn't cut across a boundary


def _spans(text: str) -> list:
    """Sentence/line spans, each further chunked into overlapping word windows."""
    out: list = []
    for seg in _SPLIT.split(text):
        seg = seg.strip()
        if not seg:
            continue
        words = seg.split()
        if len(words) <= WORD_WINDOW:
            out.append(seg)
        else:
            for i in range(0, len(words), WORD_STRIDE):
                out.append(" ".join(words[i:i + WORD_WINDOW]))
                if i + WORD_WINDOW >= len(words):
                    break
        if len(out) >= MAX_WINDOWS:
            break
    return out[:MAX_WINDOWS]


def is_long(text: str) -> bool:
    return len(text.split()) > WORD_WINDOW or "\n" in text


# A single short window condemning a whole document is a strong claim, so it
# must clear a higher bar than the document-level calibrated threshold. Tuned on
# the long-document eval (emails/PDFs/webpages/encoded): 0.86 gives full recall
# on buried + encoded threats at zero false positives, with margin above the
# ~0.79 doc threshold so a benign window can't flip a long document.
WINDOW_MIN_SCORE = 0.86


def predict_windowed(predictor, text: str, window_min_score: float | None = None) -> dict:
    """Classify ``text`` with buried-threat coverage:

    * long inputs are split into overlapping windows (max-pool),
    * any base64/hex blob is decoded and its plaintext rescanned.

    The whole-document pass uses the model's calibrated threshold; an individual
    window or decoded span must exceed ``window_min_score`` to flag the document
    (a short span condemning a long body is a strong claim). When not given, the
    threshold travels with the model artifact (``predictor.window_min_score``)."""
    from .decode import decoded_spans

    if window_min_score is None:
        window_min_score = float(getattr(predictor, "window_min_score", WINDOW_MIN_SCORE))

    whole = predictor.predict(text)

    extra = decoded_spans(text)            # threats hidden in encoded blobs
    if is_long(text):
        extra = list(_spans(text)) + extra
    elif len(text) <= 400:                 # short input: also test reversed-text smuggling
        extra.append(text[::-1])
    if not extra:
        return whole

    win_thr = max(float(getattr(predictor, "threshold", 0.5)), window_min_score)
    best_span = None
    scanned = 1
    for span in extra:
        r = predictor.predict(span)
        scanned += 1
        if r["malicious_score"] >= win_thr and (best_span is None or r["malicious_score"] > best_span["malicious_score"]):
            best_span = r

    if best_span is not None and best_span["malicious_score"] > whole["malicious_score"]:
        out = dict(best_span)
        out["verdict"] = "malicious"
    else:
        out = dict(whole)
    out["windows_scanned"] = scanned
    return out
