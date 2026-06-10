# SecureVector Guardian — vendored runtime vs. public pip package

**Status:** assessment / recommendation. No integration code changes proposed here.
**Decision owner:** maintainers of `securevector-ai-threat-monitor`.

## Context

The Guardian ML detection layer is now also published as a **public, zero-dependency
pip package** — [`securevector-guardian-model`](https://github.com/Secure-Vector/securevector-guardian-model)
(v1.2.0, import name `svguardian`). It is stdlib-only at runtime; the ~1.8 MB model
weights (`guardian.runtime.json.gz`) are **not** in the wheel and are auto-downloaded
from the GitHub release on first use, then cached per-user. `svguardian.resolve_runtime()`
returns the cached path, and the cache location can be overridden with the
`SV_GUARDIAN_RUNTIME` environment variable.

Today the app **vendors** a copy of that runtime under
`src/securevector/app/services/guardian/`:

- `pure_infer.py`, `serve.py`, `decode.py`, `window.py` — the stdlib inference modules.
- `guardian.runtime.json.gz` (~1.8 MB) + `.sha256` sidecar — the model bundle, shipped
  inside the wheel and integrity-checked at load (`PureGuardian.load()` verifies the SHA).
- Wired in via `guardian_service.py` (load-once, fail-open) and a two-bar verdict merge
  in the analyze route. Packaging is handled by `setup.py` `package_data`
  (`app/services/guardian/*.json.gz`, `*.sha256`) and `MANIFEST.in`.

The two are functionally the same code; the vendored bundle is a pinned snapshot of the
package's exported runtime.

## Option A — keep vendored (status quo)

Ship the runtime modules + model bundle inside the app wheel, as today.

**Pros**
- **Fully offline out of the box.** No first-run network call; the app detects threats
  the moment it is installed, including in air-gapped / locked-down environments. This is
  a deliberate, advertised property of the app ("100% local by default").
- **Self-contained & reproducible.** The exact model that ships is the exact model that
  runs — pinned, integrity-checked, and versioned with the app release. No drift between
  what was tested and what a user gets.
- **No extra dependency** in the dependency tree; nothing new to resolve, audit, or pin.
- **No new failure mode** from a download endpoint being unreachable, rate-limited, or
  returning an unexpected artifact on first use.

**Cons**
- **Repo / wheel carries the ~1.8 MB bundle.** It inflates the wheel and the git history
  (the binary changes whenever the model is retrained).
- **Manual sync.** Picking up an improved Guardian model means re-vendoring the bundle
  and modules by hand; the app does not auto-update the model between releases.
- **Duplication.** The same code now exists in two repos and can quietly diverge.

## Option B — depend on the public pip package

Add `securevector-guardian-model` as a dependency, drop the vendored copy, and call
`svguardian` directly (using `resolve_runtime()` for the bundle path).

**Pros**
- **Smaller repo & wheel.** The 1.8 MB bundle and the duplicated `.py` modules leave the
  app repo; model retrains no longer churn the app's git history.
- **Single source of truth.** One canonical implementation; no divergence risk between
  the vendored snapshot and upstream.
- **Easier model updates.** Bumping the dependency version (and the bundle it fetches)
  picks up an improved model without hand-vendoring.

**Cons**
- **First-run network dependency.** The model weights download from the GitHub release
  on first use. This breaks the "works fully offline the moment you install it" property
  for fresh / air-gapped installs until the cache is warm. Mitigable (pre-warm the cache
  in the installer, or set `SV_GUARDIAN_RUNTIME`), but it is added moving-part risk on the
  analyze hot path's first call.
- **New runtime dependency** to pin, audit (license/provenance), and keep compatible. The
  app currently has *no* ML dependency; this adds one to `[app]`.
- **Version-coupling surface.** The app's verdict-merge logic assumes a specific
  `serve.analyze()` output shape; an upstream package bump could change that shape and
  silently alter detection behavior unless the version is tightly pinned — which erodes
  the "auto-updates" benefit.
- **Less reproducible.** What model a user ends up running depends on what the package
  fetched at first run, not solely on the app version they installed.

## Recommendation — **keep vendored (Option A), track the public package as upstream**

Keep the vendored runtime. The app's core promise is *100% local, works offline out of
the box, no first-run network*, and the vendored bundle is what delivers that — Option B
trades that guarantee for repo-size and update-convenience wins that matter far less for a
security tool than determinism and offline readiness. A threat detector that can't detect
until it has phoned home is a regression in posture, not an improvement.

Instead, treat `securevector-guardian-model` (`svguardian`) as the **upstream source of
truth** and the vendored copy as a pinned, released snapshot:

1. **Provenance.** Record which `svguardian` release each vendored bundle came from
   (e.g. a `GUARDIAN_VERSION` marker / comment next to the bundle) so the snapshot is
   traceable to an upstream tag.
2. **Sync mechanism.** Add a small dev/CI script that pulls the runtime + modules from a
   given `svguardian` release into `src/securevector/app/services/guardian/`, re-verifies
   the SHA sidecar, and runs the parity/integration tests. Re-vendoring becomes a one-command,
   reviewable step instead of manual copying.
3. **Drift guard (optional).** A CI check that fails if the vendored bundle's SHA / version
   diverges from the pinned upstream release, so the two can't silently fall out of sync.
4. **Reconsider Option B only** if/when the app gains a robust installer-time cache pre-warm
   AND an offline-install path that ships the bundle anyway — at which point the pip dep would
   add convenience without sacrificing the offline guarantee. Until both exist, stay vendored.

Net: keep the deterministic, offline-first behavior users rely on, while making model
updates a tracked, scripted pull from the now-public package rather than ad-hoc copying.
