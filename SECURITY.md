# Security

## Reporting a vulnerability

Please report security issues privately via GitHub's [Private Security Advisory](https://github.com/Secure-Vector/securevector-ai-threat-monitor/security/advisories/new) or by emailing **security@securevector.io**. Do **not** file public issues for security vulnerabilities.

We aim to acknowledge reports within 2 business days and provide a fix or mitigation timeline within 14 days for high-severity issues.

---

## Build provenance — verifying your install

Every SecureVector wheel published to PyPI from version **4.1.0** onward ships with a [SLSA Build Level 2+](https://slsa.dev/spec/v1.0/levels) provenance attestation, signed with a short-lived [Sigstore](https://www.sigstore.dev) identity bound to our GitHub Actions release workflow, and anchored in the public [Rekor transparency log](https://search.sigstore.dev). Anyone can independently verify that the wheel was built from this exact repo by our official CI — no trust in SecureVector's keys required.

### Why this matters

Supply-chain attacks have become the default class of incident for software vendors:
- 2020 — SolarWinds. Build server compromise; "signed" binaries shipped a backdoor.
- 2021 — Codecov. CI script tampering; legitimate-looking uploader exfiltrated secrets.
- 2023 — 3CX. Cascading compromise of a signed installer.
- 2024 — XZ utils. Maintainer takeover; backdoor in a signed tarball.

In every case, "the binary was signed" was true but useless — there was no record of *what built it, from which commit, on which CI runner*. Build provenance closes that gap.

### Verifying with `gh` CLI (recommended)

```sh
# Install the wheel locally, then:
gh attestation verify $(python -c 'import securevector,os; print(os.path.dirname(securevector.__file__))')/.. \
    --owner Secure-Vector

# Or verify the wheel file directly before installing:
gh attestation verify securevector_ai_monitor-4.1.0-py3-none-any.whl \
    --owner Secure-Vector
```

A successful verification reports the source commit, the GitHub Actions workflow that built the wheel, and the Sigstore Rekor entry index.

### Verifying with `cosign`

```sh
cosign verify-blob \
    --certificate-identity-regexp "https://github.com/Secure-Vector/securevector-ai-threat-monitor/.github/workflows/release.yml@.*" \
    --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
    --bundle <attestation-bundle.json> \
    <wheel-file>
```

PyPI surfaces the attestation bundle on each package version's page; download the `.sigstore` bundle alongside the wheel.

### What the attestation tells you

| Field | What it proves |
|---|---|
| `subjectName` + `subjectDigest` | The SHA-256 hash of the wheel — verify it matches the file you downloaded. |
| `buildDefinition.buildType` | `https://actions.github.io/buildtypes/workflow/v1` — built by GitHub Actions. |
| `buildDefinition.externalParameters.workflow.path` | `.github/workflows/release.yml` — the workflow that produced it. |
| `buildDefinition.externalParameters.workflow.ref` | The Git ref / tag the build was triggered from. |
| `buildDefinition.resolvedDependencies` | The exact commit SHA used. |
| `runDetails.builder.id` | `https://github.com/actions/runner-images` — the runner image identity. |

Combined: *this exact wheel was built from this exact commit by our official release workflow, with no human-modifiable signing key in the loop.*

### What the attestation does NOT tell you

- It does not verify the *behaviour* of the code. A signed-and-attested wheel that contains a deliberate backdoor is still backdoored.
- It does not tell you the wheel is bug-free.
- It does not replace static or dynamic analysis on your side.

Provenance answers *"is this wheel from where it claims?"* — and only that question.

### Reporting an attestation mismatch

If `gh attestation verify` fails on a wheel claiming to be from us, **stop using the wheel immediately** and contact security@securevector.io. Include:
- The exact wheel filename and SHA-256.
- The full output of the verification command.
- The PyPI version page URL.

We treat attestation mismatches as critical-severity incidents and respond within hours.

---

## Older versions

Versions before 4.1.0 do not carry build attestations. They are still signed by PyPI's own infrastructure but cannot be verified back to a specific source commit. Upgrade at your earliest convenience.
