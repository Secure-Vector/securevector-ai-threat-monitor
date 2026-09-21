"""PtyHost: the one seam between Agent Terminals and process ownership.

Phase 1 (6.0.0) owns the PTY inside the app process (``InProcessPtyHost``).
The 6.0.1 daemon implements the same Protocol over a unix socket; nothing
above this module may depend on ptyprocess or threads.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Callable, Optional, Protocol

from securevector.app.terminals.ring_buffer import RingBuffer

if TYPE_CHECKING:
    from ptyprocess import PtyProcess

logger = logging.getLogger(__name__)

OnExit = Callable[[str, Optional[int]], None]


class PtyUnavailable(RuntimeError):
    """Raised when this platform cannot provide an interactive PTY."""


@dataclass(frozen=True)
class Launch:
    argv: list[str]
    env: dict[str, str]
    cwd: str


@dataclass
class PtyInfo:
    task_id: str
    pid: int
    alive: bool
    exit_code: Optional[int] = None


class Subscriber:
    """One attached client. Bounded queue: when the consumer is slow the
    oldest chunk is dropped and ``dropped`` is incremented. The ring buffer
    keeps the full tail, so a reattach never loses data permanently."""

    def __init__(self, loop: asyncio.AbstractEventLoop, maxsize: int) -> None:
        self.loop = loop
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=maxsize)
        self.dropped = 0

    def _push(self, chunk: Optional[bytes]) -> None:
        # Runs on the event loop thread (scheduled via call_soon_threadsafe).
        if self.queue.full():
            try:
                self.queue.get_nowait()
                self.dropped += 1
            except asyncio.QueueEmpty:
                pass
        self.queue.put_nowait(chunk)

    def push_threadsafe(self, chunk: Optional[bytes]) -> None:
        try:
            self.loop.call_soon_threadsafe(self._push, chunk)
        except RuntimeError:
            pass  # loop closed; the socket is gone anyway


class PtyHost(Protocol):
    def spawn(
        self, task_id: str, launch: Launch, rows: int, cols: int, on_exit: OnExit
    ) -> PtyInfo: ...
    def write(self, task_id: str, data: bytes) -> None: ...
    def resize(self, task_id: str, rows: int, cols: int) -> None: ...
    def attach(self, task_id: str, loop: asyncio.AbstractEventLoop) -> tuple[bytes, Subscriber]: ...
    def detach(self, task_id: str, sub: Subscriber) -> None: ...
    def stop(self, task_id: str, grace: float = 3.0) -> None: ...
    def snapshot(self, task_id: str) -> bytes: ...
    def list(self) -> list[PtyInfo]: ...
    def forget(self, task_id: str, grace: float = 3.0) -> None: ...


@dataclass
class _Session:
    task_id: str
    proc: "PtyProcess"
    ring: RingBuffer
    subs: set = field(default_factory=set)
    lock: threading.Lock = field(default_factory=threading.Lock)
    alive: bool = True
    exit_code: Optional[int] = None


class InProcessPtyHost:
    """ptyprocess-backed host. One reader thread per task."""

    def __init__(self, ring_capacity: int = 2_000_000, queue_size: int = 256) -> None:
        self._ring_capacity = ring_capacity
        self._queue_size = queue_size
        self._sessions: dict[str, _Session] = {}
        self._lock = threading.Lock()

    # -- lifecycle ---------------------------------------------------------

    def spawn(self, task_id: str, launch: Launch, rows: int, cols: int, on_exit: OnExit) -> PtyInfo:
        if sys.platform == "win32":
            raise PtyUnavailable(
                "Agent Terminals needs a POSIX PTY; Windows uses streams in a later release"
            )
        try:
            from ptyprocess import PtyProcess
        except ImportError as exc:  # pragma: no cover
            raise PtyUnavailable("ptyprocess is not installed") from exc
        with self._lock:
            if task_id in self._sessions:
                raise KeyError(f"task {task_id} already exists")
        proc = PtyProcess.spawn(
            list(launch.argv), cwd=launch.cwd, env=dict(launch.env), dimensions=(rows, cols)
        )
        session = _Session(task_id=task_id, proc=proc, ring=RingBuffer(self._ring_capacity))
        with self._lock:
            # Re-check: another spawn() for the same task_id may have won
            # the race between the early check above and this insert.
            if task_id in self._sessions:
                try:
                    proc.terminate(force=True)
                except Exception:
                    logger.debug(
                        "failed to terminate orphaned duplicate spawn for %s",
                        task_id,
                        exc_info=True,
                    )
                raise KeyError(f"task {task_id} already exists")
            self._sessions[task_id] = session
        thread = threading.Thread(
            target=self._reader, args=(session, on_exit), name=f"pty-reader-{task_id}", daemon=True
        )
        thread.start()
        return PtyInfo(task_id=task_id, pid=proc.pid, alive=True)

    def _reader(self, session: _Session, on_exit: OnExit) -> None:
        """Pump PTY output into the ring and every subscriber until EOF, then
        reap the child and report its exit.

        Ordering on exit: host state (``alive``/``exit_code``) is updated
        under ``session.lock`` first, then ``on_exit`` is invoked and allowed
        to return, and only then is the ``None`` sentinel pushed to
        subscribers. So by the time a subscriber observes the sentinel,
        ``on_exit`` has already run to completion.
        """
        proc = session.proc
        while True:
            try:
                chunk = proc.read(65536)
            except EOFError:
                break
            except OSError:
                break
            if not chunk:
                break
            with session.lock:
                session.ring.append(chunk)
                subs = list(session.subs)
            for sub in subs:
                sub.push_threadsafe(chunk)
        try:
            proc.wait()
        except Exception:
            logger.debug("proc.wait() failed for %s", session.task_id, exc_info=True)
        try:
            proc.close(force=False)
        except Exception:
            logger.debug("proc.close() failed for %s", session.task_id, exc_info=True)
        code = (
            proc.exitstatus
            if proc.exitstatus is not None
            else (-proc.signalstatus if proc.signalstatus is not None else None)
        )
        with session.lock:
            session.alive = False
            session.exit_code = code
            subs = list(session.subs)
        try:
            on_exit(session.task_id, code)
        except Exception:  # never let a callback kill the reader
            logger.exception("on_exit callback failed for %s", session.task_id)
        for sub in subs:
            sub.push_threadsafe(None)

    def _get(self, task_id: str) -> _Session:
        with self._lock:
            return self._sessions[task_id]

    # -- I/O ---------------------------------------------------------------

    def write(self, task_id: str, data: bytes) -> None:
        session = self._get(task_id)
        if not session.alive:
            return
        try:
            session.proc.write(data)
        except OSError:
            return

    def resize(self, task_id: str, rows: int, cols: int) -> None:
        session = self._get(task_id)
        if not session.alive:
            return
        try:
            session.proc.setwinsize(max(2, rows), max(2, cols))
        except OSError:
            return

    def attach(self, task_id: str, loop: asyncio.AbstractEventLoop) -> tuple[bytes, Subscriber]:
        session = self._get(task_id)
        sub = Subscriber(loop, self._queue_size)
        with session.lock:
            snapshot = session.ring.snapshot()
            session.subs.add(sub)
            if not session.alive:
                sub.push_threadsafe(None)
        return snapshot, sub

    def detach(self, task_id: str, sub: Subscriber) -> None:
        try:
            session = self._get(task_id)
        except KeyError:
            return
        with session.lock:
            session.subs.discard(sub)

    def snapshot(self, task_id: str) -> bytes:
        session = self._get(task_id)
        with session.lock:
            return session.ring.snapshot()

    def _signal_group(self, proc: "PtyProcess", sig: int) -> None:
        # ptyprocess spawns the child via fork + setsid, so the child is its
        # own process group leader: proc.pid == pgid. Kill the whole group
        # so a stuck task cannot leave grandchildren behind.
        try:
            os.killpg(proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            try:
                proc.kill(sig)
            except Exception:
                logger.debug("failed to signal pid %s", proc.pid, exc_info=True)
        except Exception:
            logger.debug("os.killpg failed for pgid %s", proc.pid, exc_info=True)

    def _terminate(self, session: _Session, grace: float) -> None:
        proc = session.proc
        if not session.alive:
            return
        self._signal_group(proc, signal.SIGTERM)
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline and proc.isalive():
            time.sleep(0.05)
        if proc.isalive():
            self._signal_group(proc, signal.SIGKILL)

    def stop(self, task_id: str, grace: float = 3.0) -> None:
        session = self._get(task_id)
        self._terminate(session, grace)

    def list(self) -> list[PtyInfo]:
        with self._lock:
            sessions = list(self._sessions.values())
        return [PtyInfo(s.task_id, s.proc.pid, s.alive, s.exit_code) for s in sessions]

    def forget(self, task_id: str, grace: float = 3.0) -> None:
        with self._lock:
            session = self._sessions.pop(task_id, None)
        if session is not None and session.alive:
            self._terminate(session, grace)


class WinConPTYHost(InProcessPtyHost):
    """Native Windows ConPTY host through pywinpty.

    It shares the bounded replay/subscriber machinery with the POSIX host;
    only process I/O and teardown differ. There is intentionally no pipes
    fallback: interactive harnesses must get a real pseudoconsole.
    """

    def spawn(self, task_id: str, launch: Launch, rows: int, cols: int, on_exit: OnExit) -> PtyInfo:
        if sys.platform != "win32":
            raise PtyUnavailable("WinConPTYHost is available on Windows only")
        try:
            from winpty import PtyProcess
        except ImportError as exc:  # pragma: no cover - exercised on Windows CI
            raise PtyUnavailable("Agent Tasks requires the native ConPTY dependency (pywinpty)") from exc
        with self._lock:
            if task_id in self._sessions:
                raise KeyError(f"task {task_id} already exists")
        try:
            proc = PtyProcess.spawn(list(launch.argv), cwd=launch.cwd, env=dict(launch.env), dimensions=(rows, cols))
        except Exception as exc:
            raise PtyUnavailable(f"ConPTY could not start this task: {exc}") from exc
        session = _Session(task_id=task_id, proc=proc, ring=RingBuffer(self._ring_capacity))
        with self._lock:
            self._sessions[task_id] = session
        threading.Thread(target=self._reader, args=(session, on_exit), name=f"conpty-reader-{task_id}", daemon=True).start()
        return PtyInfo(task_id=task_id, pid=int(proc.pid), alive=True)

    def _reader(self, session: _Session, on_exit: OnExit) -> None:
        proc = session.proc
        while True:
            try:
                text = proc.read(65536)
            except EOFError:
                break
            except Exception:
                break
            if not text:
                if not proc.isalive():
                    break
                continue
            chunk = text.encode("utf-8", "replace")
            with session.lock:
                session.ring.append(chunk)
                subs = list(session.subs)
            for sub in subs:
                sub.push_threadsafe(chunk)
        try:
            proc.wait()
        except Exception:
            pass
        code = proc.exitstatus
        with session.lock:
            session.alive, session.exit_code, subs = False, code, list(session.subs)
        on_exit(session.task_id, code)
        for sub in subs:
            sub.push_threadsafe(None)

    def write(self, task_id: str, data: bytes) -> None:
        session = self._get(task_id)
        if session.alive:
            try: session.proc.write(data.decode("utf-8", "replace"))
            except Exception: pass

    def resize(self, task_id: str, rows: int, cols: int) -> None:
        session = self._get(task_id)
        if session.alive:
            try: session.proc.setwinsize(max(2, rows), max(2, cols))
            except Exception: pass

    def _terminate(self, session: _Session, grace: float) -> None:
        if not session.alive:
            return
        try: session.proc.terminate(force=False)
        except Exception: pass
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline and session.proc.isalive():
            time.sleep(.05)
        if session.proc.isalive():
            # /T terminates descendants as well as the harness parent.
            subprocess.run(["taskkill", "/PID", str(session.proc.pid), "/T", "/F"], capture_output=True, timeout=5)


def create_pty_host() -> PtyHost:
    """Pick the native interactive host for the current operating system."""
    return WinConPTYHost() if sys.platform == "win32" else InProcessPtyHost()
