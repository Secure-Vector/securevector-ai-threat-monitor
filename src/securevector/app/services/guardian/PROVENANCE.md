# Vendored model provenance

This directory vendors the **SecureVector Guardian** inference runtime and its
trained model bundle so the app performs ML threat detection fully offline,
out of the box, with no first-run download.

| | |
|---|---|
| Package | `securevector-guardian-model` |
| Version | **1.2.0** |
| Source | https://github.com/Secure-Vector/securevector-guardian-model (release `v1.2.0`) |
| Bundle | `guardian.runtime.json.gz` (+ `.sha256` integrity sidecar) |
| Integrity | byte-identical to the published v1.2.0 release asset (verify against `guardian.runtime.json.gz.sha256`) |

The vendored `.py` runtime is stdlib-only (no scikit-learn / numpy at runtime)
and parity-exact with the upstream package.

**To update the model:** replace `guardian.runtime.json.gz` + `.sha256` from a
newer `securevector-guardian-model` release, bump the Version above, and re-run
`tests/unit/app/test_analyze_guardian_merge.py` to confirm the integration
still passes.
