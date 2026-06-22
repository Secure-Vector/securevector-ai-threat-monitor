#!/usr/bin/env sh
# SecureVector engine container entrypoint.
#
# 1. If SECUREVECTOR_ENROLL_TOKEN (svet_*) is set, enroll into the org fleet
#    before serving — best-effort: a failure must NOT stop the engine, which
#    still runs fully self-hosted (local rules + Guardian).
# 2. Serve the web UI/API headless on 0.0.0.0:$PORT. Cloud platforms inject
#    $PORT; default to 8741 for parity with the local app.
set -eu

PORT="${PORT:-8741}"

if [ -n "${SECUREVECTOR_ENROLL_TOKEN:-}" ]; then
    echo "[entrypoint] SECUREVECTOR_ENROLL_TOKEN present — enrolling (svet_*)..."
    if securevector-app enroll -y; then
        echo "[entrypoint] Enrollment OK — fleet + policy sync active."
    else
        echo "[entrypoint] Enrollment failed — continuing in self-host mode." >&2
    fi
fi

echo "[entrypoint] Starting SecureVector engine on 0.0.0.0:${PORT}"
exec securevector-app --web --host 0.0.0.0 --port "${PORT}"
