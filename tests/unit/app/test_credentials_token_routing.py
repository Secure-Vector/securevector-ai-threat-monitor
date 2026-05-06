"""
Unit tests for credentials.detect_token_type — routes tokens to the right
configuration path (svet_* enrollment vs svpk_*/legacy personal API key).
"""

from securevector.app.services.credentials import detect_token_type


def test_svet_prefix_detected_as_enrollment():
    assert detect_token_type("svet_-THtmIMwlE0Hxh52pSaFmaQg") == "svet"


def test_svpk_prefix_detected_as_personal():
    assert detect_token_type("svpk_AbCdEfGhIjKlMnOpQrStUv") == "svpk"


def test_legacy_unprefixed_detected_as_legacy():
    # Pre-prefix API keys remain valid forever (back-compat)
    assert detect_token_type("legacy_unprefixed_api_key_string") == "legacy"


def test_empty_string_falls_back_to_legacy():
    # Permissive — empty string gets treated as a personal-path attempt;
    # downstream save_credentials handles validation.
    assert detect_token_type("") == "legacy"


def test_other_prefixes_treated_as_legacy():
    # Future prefix space stays open — anything we don't recognise falls
    # through to the legacy path. New prefixes require an explicit branch.
    assert detect_token_type("sk_test_something") == "legacy"
    assert detect_token_type("svet") == "legacy"  # missing underscore
