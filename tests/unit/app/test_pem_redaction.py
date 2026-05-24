"""Tests for the PEM private-key redaction patterns added in v4.3.

Pair with the matching rule sv_community_output_003_pem_private_key_leak —
the rule fires the threat row, the redaction layer ensures the row written
to threat_intel_records.text_content (and forwarded onward via SIEM) does
NOT contain the leaked key body. Closes the self-defeating loop the legal
review flagged on PR #94.
"""

from __future__ import annotations

from securevector.app.utils.redaction import redact_secrets


# ---------------------------------------------------------------------------
# PEM PRIVATE KEY block redaction
# ---------------------------------------------------------------------------


def test_rsa_private_key_body_redacted_envelope_preserved():
    pem = (
        "-----BEGIN RSA PRIVATE KEY-----\n"
        "MIIEpAIBAAKCAQEA1JqGsdVEhSXMpqj3+E\n"
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456\n"
        "-----END RSA PRIVATE KEY-----"
    )
    out, n = redact_secrets(pem)
    assert n >= 1
    # Envelope kept so the matching rule still fires when re-scanning.
    assert "BEGIN RSA PRIVATE KEY" in out
    assert "END RSA PRIVATE KEY" in out
    # Body replaced.
    assert "MIIEpAIBAAKCAQEA" not in out
    assert "[REDACTED-PRIVATE-KEY]" in out


def test_openssh_private_key_body_redacted():
    pem = (
        "-----BEGIN OPENSSH PRIVATE KEY-----\n"
        "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n"
        "AAAAEbm9uZQAAAAAAAAABAAACFwAAAA\n"
        "-----END OPENSSH PRIVATE KEY-----"
    )
    out, n = redact_secrets(pem)
    assert n >= 1
    assert "b3BlbnNzaC1rZXk" not in out
    assert "[REDACTED-PRIVATE-KEY]" in out


def test_bare_private_key_envelope_redacted():
    # Newer PKCS#8 envelopes use the bare "BEGIN PRIVATE KEY" form.
    pem = (
        "-----BEGIN PRIVATE KEY-----\n"
        "secret-key-body-here-encoded-base64\n"
        "-----END PRIVATE KEY-----"
    )
    out, n = redact_secrets(pem)
    assert n >= 1
    assert "secret-key-body-here-encoded-base64" not in out


def test_encrypted_private_key_redacted():
    pem = (
        "-----BEGIN ENCRYPTED PRIVATE KEY-----\n"
        "encryptedbody1234567890\n"
        "-----END ENCRYPTED PRIVATE KEY-----"
    )
    out, n = redact_secrets(pem)
    assert n >= 1
    assert "encryptedbody1234567890" not in out


def test_public_key_block_is_NOT_redacted():
    # Public keys aren't secrets — leaving them alone keeps the surface
    # narrow and prevents collateral damage on legitimate documentation
    # that quotes a public key in an example.
    pub = (
        "-----BEGIN PUBLIC KEY-----\n"
        "MIIBIjANBgkqhkiG9w0BAQE\n"
        "-----END PUBLIC KEY-----"
    )
    out, n = redact_secrets(pub)
    assert n == 0
    assert "MIIBIjANBgkqhkiG9w0BAQE" in out


def test_multiple_keys_in_same_text_all_redacted():
    pem = (
        "Here are two keys:\n"
        "-----BEGIN RSA PRIVATE KEY-----\n"
        "FIRSTKEYBODY1234\n"
        "-----END RSA PRIVATE KEY-----\n"
        "and another:\n"
        "-----BEGIN EC PRIVATE KEY-----\n"
        "SECONDKEYBODY5678\n"
        "-----END EC PRIVATE KEY-----"
    )
    out, n = redact_secrets(pem)
    assert n == 2
    assert "FIRSTKEYBODY1234" not in out
    assert "SECONDKEYBODY5678" not in out


# ---------------------------------------------------------------------------
# OpenSSH binary key carrier redaction
# ---------------------------------------------------------------------------


def test_openssh_binary_carrier_redacted():
    raw = "prefix openssh-key-v1\x00\x00\x00\x07ssh-rsa AAAAB3NzaC1yc2EAAAA suffix"
    out, n = redact_secrets(raw)
    assert n == 1
    assert "openssh-key-v1\x00" not in out
    assert "[REDACTED-OPENSSH-KEY]" in out


def test_redaction_output_is_stable_across_repeated_passes():
    # The content stops changing after the first pass — repeated runs
    # against an already-redacted payload produce byte-identical output.
    # (The regex still *matches* the envelope-marker pair on every pass,
    # so re.subn returns count >= 1; what matters for the SIEM-forwarder
    # path is that no fresh key body is ever exposed.)
    pem = (
        "-----BEGIN RSA PRIVATE KEY-----\n"
        "keybody12345\n"
        "-----END RSA PRIVATE KEY-----"
    )
    once, _ = redact_secrets(pem)
    twice, _ = redact_secrets(once)
    assert once == twice
    assert "keybody12345" not in twice
