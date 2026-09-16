import asyncio
import os
import sys
import time

import pytest

from securevector.app.terminals.pty_host import (
    InProcessPtyHost,
    Launch,
    PtyUnavailable,
    Subscriber,
    WinConPTYHost,
    create_pty_host,
)

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="POSIX PTY only")


def _sh(script: str, cwd: str) -> Launch:
    return Launch(argv=["/bin/sh", "-c", script], env={"PATH": "/usr/bin:/bin"}, cwd=cwd)


async def _drain(sub, timeout=3.0) -> bytes:
    """Collect output until the exit sentinel (None) or timeout."""
    out = b""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            chunk = await asyncio.wait_for(sub.queue.get(), timeout=0.2)
        except asyncio.TimeoutError:
            continue
        if chunk is None:
            break
        out += chunk
    return out


async def _wait_for(predicate, timeout=2.0, interval=0.05):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        await asyncio.sleep(interval)
    return predicate()


@pytest.mark.asyncio
async def test_spawn_streams_output_and_reports_exit(tmp_path):
    host = InProcessPtyHost()
    exits = []
    loop = asyncio.get_running_loop()
    info = host.spawn(
        "t1",
        _sh("printf hello; exit 3", str(tmp_path)),
        rows=24,
        cols=80,
        on_exit=lambda tid, code: exits.append((tid, code)),
    )
    assert info.pid > 0
    snapshot, sub = host.attach("t1", loop)
    out = snapshot + await _drain(sub)
    assert b"hello" in out
    # on_exit runs on the reader thread; poll rather than assert immediately.
    assert await _wait_for(lambda: exits == [("t1", 3)])
    assert host.list()[0].alive is False
    host.detach("t1", sub)


@pytest.mark.asyncio
async def test_write_reaches_child_and_resize_is_visible(tmp_path):
    host = InProcessPtyHost()
    loop = asyncio.get_running_loop()
    host.spawn(
        "t2",
        _sh("read x; stty size; echo got:$x", str(tmp_path)),
        rows=24,
        cols=80,
        on_exit=lambda *_: None,
    )
    host.resize("t2", rows=30, cols=100)
    snapshot, sub = host.attach("t2", loop)
    host.write("t2", b"abc\n")
    out = snapshot + await _drain(sub)
    assert b"30 100" in out
    assert b"got:abc" in out


@pytest.mark.asyncio
async def test_stop_terminates_a_stuck_child(tmp_path):
    host = InProcessPtyHost()
    exits = []
    host.spawn(
        "t3",
        _sh("sleep 30", str(tmp_path)),
        rows=24,
        cols=80,
        on_exit=lambda tid, code: exits.append(code),
    )
    host.stop("t3", grace=0.5)
    for _ in range(50):
        if exits:
            break
        await asyncio.sleep(0.05)
    assert exits, "child did not exit after stop()"
    assert host.list()[0].alive is False


@pytest.mark.asyncio
async def test_stop_kills_the_whole_process_group(tmp_path):
    host = InProcessPtyHost()
    exits = []
    # The script backgrounds a grandchild and records its pid, then blocks.
    # stop() must reap both -- ptyprocess spawns the child as its own
    # session/process-group leader, so a plain SIGTERM to the direct pid
    # would leave "sleep 47" running as an orphan.
    host.spawn(
        "t6",
        _sh("sleep 47 & echo bgpid:$! ; sleep 30", str(tmp_path)),
        rows=24,
        cols=80,
        on_exit=lambda tid, code: exits.append(code),
    )
    loop = asyncio.get_running_loop()
    snapshot, sub = host.attach("t6", loop)
    out = snapshot
    deadline = time.monotonic() + 2.0
    while b"bgpid:" not in out and time.monotonic() < deadline:
        try:
            chunk = await asyncio.wait_for(sub.queue.get(), timeout=0.2)
        except asyncio.TimeoutError:
            continue
        if chunk:
            out += chunk
    host.detach("t6", sub)
    assert b"bgpid:" in out, "background pid line never arrived"
    bg_pid = int(out.split(b"bgpid:")[1].split(b"\r")[0].split(b"\n")[0].strip())

    host.stop("t6", grace=0.5)
    for _ in range(50):
        if exits:
            break
        await asyncio.sleep(0.05)
    assert exits, "child did not exit after stop()"

    async def _bg_gone():
        try:
            os.kill(bg_pid, 0)
        except ProcessLookupError:
            return True
        return False

    assert await _wait_for(_bg_gone, timeout=2.0), "background sleep 47 survived stop()"


@pytest.mark.asyncio
async def test_slow_subscriber_drops_oldest_and_counts(tmp_path):
    host = InProcessPtyHost(queue_size=4)
    loop = asyncio.get_running_loop()
    host.spawn(
        "t4",
        _sh("i=0; while [ $i -lt 200 ]; do echo line$i; i=$((i+1)); done", str(tmp_path)),
        rows=24,
        cols=80,
        on_exit=lambda *_: None,
    )
    _, sub = host.attach("t4", loop)
    # Do not read for a moment so the bounded queue overflows.
    await asyncio.sleep(0.5)
    assert sub.queue.qsize() <= 4
    assert sub.dropped > 0
    # Everything is still in the ring for a later replay.
    assert b"line199" in host.snapshot("t4")


def test_subscriber_push_drops_oldest_directly():
    async def _run():
        loop = asyncio.get_running_loop()
        sub = Subscriber(loop, maxsize=2)
        sub._push(b"a")
        sub._push(b"b")
        sub._push(b"c")
        assert sub.queue.qsize() == 2
        assert sub.dropped == 1
        first = sub.queue.get_nowait()
        second = sub.queue.get_nowait()
        assert (first, second) == (b"b", b"c")

    asyncio.run(_run())


@pytest.mark.asyncio
async def test_forget_stops_and_removes_a_running_task(tmp_path):
    host = InProcessPtyHost()
    exits = []
    host.spawn(
        "t5",
        _sh("sleep 30", str(tmp_path)),
        rows=24,
        cols=80,
        on_exit=lambda tid, code: exits.append(code),
    )
    host.forget("t5")
    assert host.list() == []
    for _ in range(60):
        if exits:
            break
        await asyncio.sleep(0.05)
    assert exits, "child did not exit after forget()"


@pytest.mark.asyncio
async def test_duplicate_task_id_raises_key_error(tmp_path):
    host = InProcessPtyHost()
    exits = []
    host.spawn(
        "dup",
        _sh("sleep 30", str(tmp_path)),
        rows=24,
        cols=80,
        on_exit=lambda tid, code: exits.append(code),
    )
    with pytest.raises(KeyError):
        host.spawn("dup", _sh("sleep 30", str(tmp_path)), rows=24, cols=80, on_exit=lambda *_: None)
    host.forget("dup")
    for _ in range(60):
        if exits:
            break
        await asyncio.sleep(0.05)
    assert exits, "original task did not exit after forget()"


@pytest.mark.asyncio
async def test_attach_after_exit_delivers_sentinel_immediately(tmp_path):
    host = InProcessPtyHost()
    loop = asyncio.get_running_loop()
    host.spawn("t7", _sh("exit 0", str(tmp_path)), rows=24, cols=80, on_exit=lambda *_: None)
    assert await _wait_for(lambda: host.list()[0].alive is False)
    _, sub = host.attach("t7", loop)
    chunk = await asyncio.wait_for(sub.queue.get(), timeout=1.0)
    assert chunk is None


def test_detach_unknown_task_does_not_raise():
    host = InProcessPtyHost()
    loop = asyncio.new_event_loop()
    try:
        sub = Subscriber(loop, maxsize=4)
        host.detach("nope", sub)  # must be a no-op, not raise KeyError
    finally:
        loop.close()


def test_unknown_task_raises():
    host = InProcessPtyHost()
    with pytest.raises(KeyError):
        host.write("nope", b"x")


def test_pty_unavailable_is_an_exception_type():
    assert issubclass(PtyUnavailable, RuntimeError)


def test_host_factory_selects_conpty_only_on_windows(monkeypatch):
    import securevector.app.terminals.pty_host as host_module

    monkeypatch.setattr(host_module.sys, "platform", "win32")
    assert isinstance(create_pty_host(), WinConPTYHost)
    monkeypatch.setattr(host_module.sys, "platform", "darwin")
    assert isinstance(create_pty_host(), InProcessPtyHost)
