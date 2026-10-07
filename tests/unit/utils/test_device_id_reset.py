"""force_reset_device_id must yield a new id even when the OS machine id is stable."""
from securevector.app.utils import device_id as dev


def test_reset_returns_new_id_despite_stable_os_id(tmp_path, monkeypatch):
    monkeypatch.setattr(dev, "_data_file", lambda: tmp_path / "device_id")
    monkeypatch.setattr(dev, "_read_os_machine_id", lambda: "FIXED-HW-UUID")
    dev.reset_cached_device_id()

    first = dev.get_device_id()
    assert first == dev._hash_id("FIXED-HW-UUID")

    new = dev.force_reset_device_id()
    assert new != first
    assert new.startswith("sv-")

    # The new id survives a process restart (cache file wins over the OS id).
    dev.reset_cached_device_id()
    assert dev.get_device_id() == new
    dev.reset_cached_device_id()


def test_reset_fails_when_new_id_cannot_be_saved(tmp_path, monkeypatch):
    import pytest

    monkeypatch.setattr(dev, "_data_file", lambda: tmp_path / "device_id")
    monkeypatch.setattr(dev, "_read_os_machine_id", lambda: "FIXED-HW-UUID")
    monkeypatch.setattr(dev, "_write_cache_file", lambda value: None)
    dev.reset_cached_device_id()

    with pytest.raises(RuntimeError):
        dev.force_reset_device_id()
    dev.reset_cached_device_id()
