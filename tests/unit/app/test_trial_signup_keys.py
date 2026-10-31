

def test_personal_key_accepts_both_prefixes_the_auth_service_mints():
    from securevector.app.services.trial_signup import _personal_key

    assert _personal_key("svpk_" + "a" * 32)
    assert _personal_key("sk_" + "a" * 32)
    assert _personal_key("sk-" + "a" * 32)
    assert not _personal_key("svet_" + "a" * 32)
    assert not _personal_key("sk_")
    assert not _personal_key(None)
    assert not _personal_key({"api_key": "sk_" + "a" * 32})
