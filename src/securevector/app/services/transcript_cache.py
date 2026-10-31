"""Incremental, shared parsing of agent transcripts (JSONL files).

A live Claude Code or Codex session appends to its transcript every few
seconds, so a cache keyed by mtime misses on almost every request and the
whole file (hundreds of MB for a long session) was parsed again each time.

Here one entry per (file, parser key) keeps the parser's state, the byte
offset read so far and the file's identity. A request stats the file: when
it only grew, only the appended bytes are read and fed to the same parser;
when it shrank, was replaced or its already-read bytes changed, the file is
parsed again from the start. A partial last line stays unread until its
newline lands (or it parses as a whole record).

A parser is a generator built by the caller's factory: it receives each
record (a dict, one per JSON line) via ``send(rec)`` and answers
``send(None)`` with a snapshot of its results. The snapshot is shared and
cached until the file changes: callers must copy before they mutate.

Entries idle for ``IDLE_S`` are dropped, and at most ``MAX_ENTRIES`` per
parser group are kept (least recently used first out). Only the parsers' compact results are held,
never raw lines.
"""

from __future__ import annotations

import json
import os
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any, Callable, Generator, Hashable, Optional

IDLE_S = 15 * 60
MAX_ENTRIES = 48
# Per parser group (the key's first element) caps that differ from
# MAX_ENTRIES: token totals are a few small dicts per file, and the
# dashboard's walk over every transcript must not push the live sessions'
# generation parses out.
GROUP_CAPS = {"cc-usage": 1024}
CHUNK_BYTES = 4 * 1024 * 1024
FP_BYTES = 64  # bytes compared at the head and just before the offset

Machine = Generator[Any, Optional[dict], None]


class _Entry:
    __slots__ = ("lock", "machine", "offset", "ident", "size", "mtime_ns",
                 "head_fp", "tail_fp", "snap", "touched")

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.machine: Optional[Machine] = None
        self.offset = 0
        self.ident: tuple = ()
        self.size = -1
        self.mtime_ns = -1
        self.head_fp = b""
        self.tail_fp = b""
        self.snap: Any = None
        self.touched = 0.0


_entries: "OrderedDict[tuple, _Entry]" = OrderedDict()
_registry_lock = threading.Lock()
# Counters for tests and measurements: full parses vs incremental reads.
stats = {"full": 0, "incremental": 0, "hits": 0}


def clear() -> None:
    with _registry_lock:
        _entries.clear()


def entry_count() -> int:
    with _registry_lock:
        return len(_entries)


def _evict(now: float) -> None:
    """Drop idle entries, then the least recently used past the cap.
    Caller holds the registry lock."""
    cutoff = now - IDLE_S
    for k in [k for k, e in _entries.items() if e.touched < cutoff]:
        _entries.pop(k, None)
    counts: dict = {}
    for k in _entries:
        counts[_group(k)] = counts.get(_group(k), 0) + 1
    for g, n in counts.items():
        over = n - GROUP_CAPS.get(g, MAX_ENTRIES)
        if over <= 0:
            continue
        for k in [k for k in _entries if _group(k) == g][:over]:  # oldest first
            _entries.pop(k, None)


def _group(ckey: tuple):
    key = ckey[1]
    return key[0] if isinstance(key, tuple) and key else key


def _read_at(fh, pos: int, n: int) -> bytes:
    fh.seek(pos)
    return fh.read(n)


def _feed(machine: Machine, raw: bytes) -> None:
    raw = raw.strip()
    if not raw:
        return
    try:
        rec = json.loads(raw)
    except ValueError:  # JSONDecodeError and bad UTF-8 alike
        return
    if isinstance(rec, dict):
        machine.send(rec)


def _start(factory: Callable[[], Machine]) -> Machine:
    m = factory()
    next(m)
    return m


def parse(path: Path, key: Hashable, factory: Callable[[], Machine],
          view: Optional[Callable[[Any], Any]] = None) -> Any:
    """The parser snapshot for ``path`` under ``key``, reading only what was
    appended since the last call. None when the file cannot be read.
    ``view``, when given, is applied to the snapshot under the entry's lock
    (the place to copy it) and its result returned instead."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    ckey = (str(path), key)
    now = time.monotonic()
    with _registry_lock:
        entry = _entries.get(ckey)
        if entry is None:
            entry = _entries[ckey] = _Entry()
        entry.touched = now
        _entries.move_to_end(ckey)
        _evict(now)
    with entry.lock:
        ident = (st.st_dev, st.st_ino)
        if (entry.machine is not None and entry.ident == ident
                and entry.size == st.st_size and entry.mtime_ns == st.st_mtime_ns):
            stats["hits"] += 1
            return view(entry.snap) if view is not None else entry.snap
        try:
            snap = _advance(entry, path, st, ident, factory)
            return view(snap) if view is not None and snap is not None else snap
        except OSError:
            # Half-fed parser state is not trusted: the next call starts over.
            entry.machine = None
            entry.snap = None
            return None
        except Exception:
            entry.machine = None
            entry.snap = None
            raise


def _advance(entry: _Entry, path: Path, st, ident: tuple, factory) -> Any:
    try:
        fh = open(path, "rb")
    except OSError:
        entry.machine = None
        return None
    with fh:
        reset = (entry.machine is None or entry.ident != ident or st.st_size < entry.offset)
        if not reset and entry.offset:
            # Same file, not shorter: the bytes already read must be unchanged
            # (a rewrite in place keeps the inode).
            if (_read_at(fh, 0, FP_BYTES) != entry.head_fp
                    or _read_at(fh, max(0, entry.offset - FP_BYTES),
                                min(FP_BYTES, entry.offset)) != entry.tail_fp):
                reset = True
        if reset:
            entry.machine = _start(factory)
            entry.offset = 0
            stats["full"] += 1
        else:
            stats["incremental"] += 1
        machine = entry.machine
        offset = entry.offset
        fh.seek(offset)
        buf = b""
        while True:
            chunk = fh.read(CHUNK_BYTES)
            if not chunk:
                break
            buf = buf + chunk if buf else chunk
            nl = buf.rfind(b"\n")
            if nl < 0:
                continue
            complete, buf = buf[:nl + 1], buf[nl + 1:]
            for raw in complete.split(b"\n"):
                _feed(machine, raw)
            offset += len(complete)
        if buf.strip():
            # A last line with no newline yet: take it only when it is a
            # whole record, else leave it for the next read.
            try:
                whole = isinstance(json.loads(buf), dict)
            except ValueError:
                whole = False
            if whole:
                _feed(machine, buf)
                offset += len(buf)
        entry.offset = offset
        entry.head_fp = _read_at(fh, 0, FP_BYTES) if offset else b""
        entry.tail_fp = (_read_at(fh, max(0, offset - FP_BYTES), min(FP_BYTES, offset))
                         if offset else b"")
    entry.ident = ident
    entry.size = st.st_size
    entry.mtime_ns = st.st_mtime_ns
    entry.snap = machine.send(None)
    return entry.snap
