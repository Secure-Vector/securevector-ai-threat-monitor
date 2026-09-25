"""Bounded in-memory scrollback for one task.

Terminal output is kept in memory only (Phase 1 has no on-disk history).
After the buffer wraps, a snapshot starts at the first line boundary so a
reattaching client never starts mid-line.
"""

from __future__ import annotations

import threading


class RingBuffer:
    """Fixed-capacity byte buffer keeping only the last ``capacity`` bytes.

    ``append`` is called from a single reader thread; ``snapshot``,
    ``clear``, and ``__len__`` are called from the asyncio event-loop
    thread. All access is guarded by an internal lock so the two threads
    never observe or mutate the buffer concurrently.
    """

    def __init__(self, capacity: int = 2_000_000) -> None:
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        self._cap = capacity
        self._buf = bytearray()
        self._wrapped = False
        self._lock = threading.Lock()

    def append(self, data: bytes) -> None:
        """Append bytes, trimming from the front to keep the last ``capacity`` bytes."""
        if not data:
            return
        with self._lock:
            self._buf += data
            overflow = len(self._buf) - self._cap
            if overflow > 0:
                del self._buf[:overflow]
                self._wrapped = True

    def snapshot(self) -> bytes:
        """Return the retained bytes, dropping a leading partial line after a wrap."""
        with self._lock:
            if not self._wrapped:
                return bytes(self._buf)
            nl = self._buf.find(b"\n")
            if nl < 0:
                return bytes(self._buf)
            return bytes(memoryview(self._buf)[nl + 1 :])

    def clear(self) -> None:
        """Empty the buffer and reset the wrapped flag."""
        with self._lock:
            self._buf = bytearray()
            self._wrapped = False

    def __len__(self) -> int:
        with self._lock:
            return len(self._buf)
