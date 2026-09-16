from securevector.app.server.app import create_app


def _mounted_paths(app):
    """Flatten all mounted route paths, including websocket routes.

    FastAPI 0.137's `include_router` defers flattening behind an internal
    `_IncludedRouter` wrapper (its top-level `path` is `None`); recurse into
    `original_router.routes` with the accumulated prefix to get real paths.
    This mirrors how FastAPI itself resolves requests, without relying on
    `app.openapi()` (which drops websocket routes from its schema).
    """
    try:
        from fastapi.routing import _IncludedRouter
    except ImportError:  # pragma: no cover - older FastAPI without this wrapper

        class _IncludedRouter:  # pragma: no cover
            pass

    paths = set()
    stack = [(app.router.routes, "")]
    while stack:
        routes, prefix = stack.pop()
        for route in routes:
            if isinstance(route, _IncludedRouter):
                stack.append((route.original_router.routes, prefix + route.include_context.prefix))
            else:
                path = getattr(route, "path", None)
                if path is not None:
                    paths.add(prefix + path)
    return paths


def test_terminals_routes_are_mounted():
    app = create_app(host="127.0.0.1", port=8741)
    paths = _mounted_paths(app)
    assert "/api/terminals/session" in paths
    assert "/api/terminals/tasks" in paths
    assert "/api/terminals/tasks/{task_id}/ws" in paths
