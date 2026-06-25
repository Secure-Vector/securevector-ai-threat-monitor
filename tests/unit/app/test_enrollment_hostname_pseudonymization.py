"""Tests for the enrollment hostname pseudonymization guardrail.

Raw hostnames frequently embed a person's name ("johns-macbook"), which is
personal data under GDPR. Enrollment binds a device to an org and must never
ship a raw machine name to the (currently non-EU) cloud — only a stable,
non-reversible token. See ``enrollment.pseudonymize_hostname``.
"""

from __future__ import annotations

import hashlib

import pytest

from securevector.app.services.enrollment import pseudonymize_hostname


def _expected(name: str) -> str:
    digest = hashlib.sha256(name.strip().lower().encode("utf-8")).hexdigest()[:12]
    return f"host-{digest}"


def test_pseudonymizes_to_stable_host_token() -> None:
    out = pseudonymize_hostname("Johns-MacBook")
    assert out == _expected("Johns-MacBook")
    assert out.startswith("host-")
    # The raw name must not survive in any form.
    assert "john" not in out.lower()
    assert "macbook" not in out.lower()


def test_is_deterministic_same_machine_same_token() -> None:
    assert pseudonymize_hostname("build-box-07") == pseudonymize_hostname("build-box-07")


def test_is_case_and_whitespace_insensitive() -> None:
    # A heartbeat that reports the name with different casing/padding still maps
    # to one stable cloud device-list entry.
    assert pseudonymize_hostname("  Johns-MacBook  ") == pseudonymize_hostname("johns-macbook")


def test_distinct_hostnames_get_distinct_tokens() -> None:
    assert pseudonymize_hostname("alpha") != pseudonymize_hostname("beta")


@pytest.mark.parametrize("empty", [None, "", "   "])
def test_empty_passes_through_so_field_is_omitted(empty) -> None:
    # Returned unchanged so the caller's `if hostname:` guard keeps the key out
    # of the enrollment payload entirely (rather than sending "host-<hash of ''>").
    assert pseudonymize_hostname(empty) == empty


def test_token_is_not_reversible_length_bound() -> None:
    # 12 hex chars — enough to avoid collisions across a fleet, not the full
    # digest, and one-way regardless.
    out = pseudonymize_hostname("some-internal-server-name")
    assert out is not None
    assert len(out) == len("host-") + 12
