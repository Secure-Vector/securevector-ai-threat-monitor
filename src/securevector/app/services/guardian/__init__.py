"""Bundled Guardian ML runtime (offline, stdlib-only inference).

``__version__`` mirrors the upstream model release at
github.com/Secure-Vector/securevector-guardian-model. When the model is split
into its own PyPI distribution, ``guardian_service.model_version()`` prefers the
installed ``securevector-guardian-model`` package version over this constant, so
`pip install -U securevector-guardian-model` + restart reports the new version
without any app change.
"""

__version__ = "1.2.0"
