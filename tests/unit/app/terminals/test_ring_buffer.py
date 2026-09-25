import pytest

from securevector.app.terminals.ring_buffer import RingBuffer


def test_append_and_snapshot_below_capacity() -> None:
    rb = RingBuffer(capacity=100)
    rb.append(b"hello\n")
    rb.append(b"world")
    assert rb.snapshot() == b"hello\nworld"
    assert len(rb) == 11


def test_wrap_keeps_only_last_capacity_bytes() -> None:
    rb = RingBuffer(capacity=10)
    rb.append(b"0123456789abcdef")
    assert len(rb) == 10
    # No newline in the retained window: return everything we have.
    assert rb.snapshot() == b"6789abcdef"


def test_snapshot_after_wrap_starts_at_line_boundary() -> None:
    rb = RingBuffer(capacity=12)
    rb.append(b"line one\nline two\nline three\n")
    # Last 12 bytes are b"\nline three\n"; trim through the first newline.
    snap = rb.snapshot()
    assert snap == b"line three\n"


def test_no_line_trim_before_wrap() -> None:
    rb = RingBuffer(capacity=100)
    rb.append(b"\nabc")
    assert rb.snapshot() == b"\nabc"


def test_capacity_must_be_positive() -> None:
    with pytest.raises(ValueError):
        RingBuffer(capacity=0)


def test_clear_resets_wrap_state() -> None:
    rb = RingBuffer(capacity=4)
    rb.append(b"abcdefgh")
    rb.clear()
    assert len(rb) == 0
    rb.append(b"xy")
    assert rb.snapshot() == b"xy"
