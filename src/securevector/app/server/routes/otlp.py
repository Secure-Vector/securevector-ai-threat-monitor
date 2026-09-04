"""OTLP/HTTP JSON trace ingest: ``POST /v1/traces``.

Any OpenTelemetry exporter can point here. Spans that follow the GenAI
semantic conventions become rows the Traces page already understands:

- ``gen_ai.operation.name`` in chat / text_completion / generate_content /
  embeddings → a generation row in ``llm_cost_records`` (model, tokens, cost,
  previews, duration, verdict).
- ``gen_ai.operation.name`` = execute_tool → a tool-call audit row.
- anything else is counted as skipped and not stored.

The prompt and the completion are scanned (outgoing and llm_response) so a
model turn carries a verdict like a tool call does. Ingest never blocks a
call: spans arrive after the fact. Only the JSON encoding is accepted;
protobuf gets 415 with a message naming the JSON encoding.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from securevector.app.database.connection import get_database
from securevector.app.database.repositories.costs import CostsRepository
from securevector.app.database.repositories.custom_tools import CustomToolsRepository
from securevector.app.database.repositories.settings import SettingsRepository
from securevector.app.utils.trace_id import derive_trace_id
from securevector.guard import PREVIEW_LIMIT, SCAN_LIMIT, redact

logger = logging.getLogger(__name__)

router = APIRouter()

GENERATION_OPS = {"chat", "text_completion", "generate_content", "embeddings", "completion"}
TOOL_OPS = {"execute_tool", "tool"}


# --------------------------------------------------------------------------- #
# OTLP JSON decoding                                                          #
# --------------------------------------------------------------------------- #


def _value(v: Any) -> Any:
    if not isinstance(v, dict):
        return v
    if "stringValue" in v:
        return v["stringValue"]
    if "intValue" in v:
        try:
            return int(v["intValue"])
        except (TypeError, ValueError):
            return v["intValue"]
    if "doubleValue" in v:
        return v["doubleValue"]
    if "boolValue" in v:
        return bool(v["boolValue"])
    if "arrayValue" in v:
        return [_value(x) for x in (v["arrayValue"] or {}).get("values", [])]
    if "kvlistValue" in v:
        return _attrs((v["kvlistValue"] or {}).get("values"))
    if "bytesValue" in v:
        return v["bytesValue"]
    return None


def _attrs(items: Any) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for kv in items or []:
        if isinstance(kv, dict) and "key" in kv:
            out[str(kv["key"])] = _value(kv.get("value"))
    return out


def _ns(v: Any) -> Optional[int]:
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def _iso(ns: Optional[int]) -> Optional[str]:
    if ns is None:
        return None
    return datetime.fromtimestamp(ns / 1e9, tz=timezone.utc).replace(tzinfo=None).isoformat()


def _text(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    try:
        import json

        return json.dumps(v, ensure_ascii=False, default=str)
    except Exception:  # noqa: BLE001
        return str(v)


def _first(*vals: Any) -> Any:
    for v in vals:
        if v not in (None, "", [], {}):
            return v
    return None


def _event_attr(events: Any, event_name: str, *keys: str) -> Any:
    for e in events or []:
        if isinstance(e, dict) and e.get("name") == event_name:
            a = _attrs(e.get("attributes"))
            v = _first(*(a.get(k) for k in keys))
            if v is not None:
                return v
    return None


def _classify(attrs: Dict[str, Any], name: str) -> Optional[str]:
    op = str(attrs.get("gen_ai.operation.name") or "").strip().lower()
    if op in GENERATION_OPS:
        return "generation"
    if op in TOOL_OPS:
        return "tool"
    head = name.split(" ", 1)[0].lower() if name else ""
    if head in GENERATION_OPS or (attrs.get("gen_ai.request.model") and "gen_ai.tool.name" not in attrs):
        return "generation"
    if head in TOOL_OPS or "gen_ai.tool.name" in attrs:
        return "tool"
    return None


# --------------------------------------------------------------------------- #
# Scanning: reuse the /analyze route so findings land in Threats             #
# --------------------------------------------------------------------------- #


async def _scan(text: str, direction: str, *, session_id: str, request_id: str, runtime_kind: str) -> Optional[dict]:
    """Verdict for one text, or None when nothing was scanned."""
    if not text:
        return None
    try:
        from securevector.app.server.routes.analyze import AnalysisRequest, analyze_text

        req = AnalysisRequest(
            text=text[:SCAN_LIMIT], source=runtime_kind[:255], session_id=session_id[:64],
            request_id=request_id[:64], direction=direction,
            metadata={"runtime_kind": runtime_kind, "ingest": "otlp"},
        )
        scope = {"type": "http", "method": "POST", "path": "/analyze", "headers": [], "query_string": b""}
        result = await analyze_text(req, Request(scope))
        finding = bool(result.is_threat) or bool(result.redacted_text)
        risk = int(result.risk_score or 0)
        reason = result.threat_type or ("secret" if result.redacted_text else "clean")
        return {"finding": finding, "risk": risk, "reason": f"{direction} {reason} risk={risk}"}
    except Exception as exc:  # noqa: BLE001 - a scan failure never rejects the span
        logger.debug("otlp ingest scan failed: %s", exc)
        return None


def _verdict(*scans: Optional[dict]) -> Tuple[Optional[str], Optional[int], Optional[str]]:
    done = [s for s in scans if s is not None]
    if not done:
        return None, None, None
    findings = [s for s in done if s["finding"]]
    if not findings:
        return "allow", 0, None
    worst = max(findings, key=lambda s: s["risk"])
    return "log_only", worst["risk"], worst["reason"]


# --------------------------------------------------------------------------- #
# Ingest                                                                      #
# --------------------------------------------------------------------------- #


class _Stats:
    accepted = 0
    rejected = 0
    skipped = 0
    first_error: Optional[str] = None


async def _ingest_generation(span: dict, attrs: dict, ctx: dict, costs: CostsRepository, store_text: bool) -> None:
    events = span.get("events")
    prompt = _text(_first(
        _event_attr(events, "gen_ai.content.prompt", "gen_ai.prompt", "content"),
        attrs.get("gen_ai.input.messages"), attrs.get("gen_ai.prompt"),
    ))
    completion = _text(_first(
        _event_attr(events, "gen_ai.content.completion", "gen_ai.completion", "content"),
        attrs.get("gen_ai.output.messages"), attrs.get("gen_ai.completion"),
    ))
    finish = attrs.get("gen_ai.response.finish_reasons")
    if isinstance(finish, list):
        finish = finish[0] if finish else None
    request_id = str(_first(attrs.get("securevector.request_id"), span.get("spanId")) or "")[:64]

    prompt_scan = await _scan(prompt, "outgoing", session_id=ctx["session_id"], request_id=request_id,
                              runtime_kind=ctx["runtime_kind"])
    completion_scan = await _scan(completion, "llm_response", session_id=ctx["session_id"], request_id=request_id,
                                  runtime_kind=ctx["runtime_kind"])
    action, risk, reason = _verdict(prompt_scan, completion_scan)

    await costs.record_generation(
        trace_id=ctx["trace_id"], span_id=span.get("spanId"), session_id=ctx["session_id"],
        runtime_kind=ctx["runtime_kind"],
        provider=_first(attrs.get("gen_ai.system"), attrs.get("gen_ai.provider.name")),
        model_id=str(_first(attrs.get("gen_ai.request.model"), attrs.get("gen_ai.response.model"), "unknown")),
        input_tokens=int(_first(attrs.get("gen_ai.usage.input_tokens"), attrs.get("gen_ai.usage.prompt_tokens"), 0) or 0),
        output_tokens=int(_first(attrs.get("gen_ai.usage.output_tokens"), attrs.get("gen_ai.usage.completion_tokens"), 0) or 0),
        input_cached_tokens=int(attrs.get("gen_ai.usage.cache_read.input_tokens") or 0),
        started_at=ctx["started_at"], duration_ms=ctx["duration_ms"],
        parent_span_id=span.get("parentSpanId") or None, request_id=request_id or None,
        agent_id=ctx.get("agent_id"),
        input_preview=redact(prompt, PREVIEW_LIMIT) if (store_text and prompt) else None,
        output_preview=redact(completion, PREVIEW_LIMIT) if (store_text and completion) else None,
        finish_reason=str(finish) if finish else None,
        verdict_action=action, verdict_risk=risk, verdict_reason=reason,
    )


async def _ingest_tool(span: dict, attrs: dict, ctx: dict, tools: CustomToolsRepository, db, store_text: bool) -> None:
    span_id = span.get("spanId")
    if span_id and ctx["trace_id"]:
        dup = await db.fetch_one(
            "SELECT 1 FROM tool_call_audit WHERE trace_id = ? AND span_id = ?", (ctx["trace_id"], span_id)
        )
        if dup:
            return
    name = str(_first(attrs.get("gen_ai.tool.name"), span.get("name"), "tool"))
    args = _text(_first(attrs.get("gen_ai.tool.call.arguments"), attrs.get("gen_ai.tool.input")))
    result = _text(_first(attrs.get("gen_ai.tool.call.result"), attrs.get("gen_ai.tool.output")))
    request_id = str(_first(attrs.get("securevector.request_id"), span_id) or "")[:64]
    args_scan = await _scan(args, "outgoing", session_id=ctx["session_id"], request_id=request_id,
                            runtime_kind=ctx["runtime_kind"])
    result_scan = await _scan(result, "incoming", session_id=ctx["session_id"], request_id=request_id,
                              runtime_kind=ctx["runtime_kind"])
    action, risk, reason = _verdict(args_scan, result_scan)
    await tools.log_tool_call_audit(
        name, name, action or "allow", risk=str(risk) if risk else None, reason=reason,
        args_preview=redact(args, PREVIEW_LIMIT) if (store_text and args) else None,
        runtime_kind=ctx["runtime_kind"], session_id=ctx["session_id"], request_id=request_id or None,
        span_id=span_id, parent_span_id=span.get("parentSpanId") or None,
    )


def _runtime_kind(service_name: Any) -> str:
    s = str(service_name or "otel").strip().lower()
    return "".join(ch if ch.isalnum() or ch in "-_." else "-" for ch in s)[:64] or "otel"


@router.post("/v1/traces")
async def ingest_traces(request: Request):
    ctype = request.headers.get("content-type", "")
    if "protobuf" in ctype:
        raise HTTPException(status_code=415, detail="Send OTLP/HTTP JSON: set OTEL_EXPORTER_OTLP_PROTOCOL=http/json")
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="Body is not valid JSON")
    if not isinstance(body, dict) or not isinstance(body.get("resourceSpans"), list):
        raise HTTPException(status_code=400, detail="Expected an ExportTraceServiceRequest with resourceSpans[]")

    db = get_database()
    costs = CostsRepository(db)
    tools = CustomToolsRepository(db)
    try:
        settings = await SettingsRepository(db).get()
        store_text = bool(getattr(settings, "store_text_content", True))
    except Exception:  # noqa: BLE001
        store_text = True

    st = _Stats()
    for rs in body["resourceSpans"]:
        if not isinstance(rs, dict):
            continue
        res = _attrs((rs.get("resource") or {}).get("attributes"))
        runtime_kind = _runtime_kind(res.get("service.name"))
        for ss in rs.get("scopeSpans") or []:
            for span in (ss or {}).get("spans") or []:
                if not isinstance(span, dict):
                    st.rejected += 1
                    continue
                try:
                    attrs = _attrs(span.get("attributes"))
                    kind = _classify(attrs, str(span.get("name") or ""))
                    if kind is None:
                        st.skipped += 1
                        continue
                    session_id = str(_first(attrs.get("session.id"), res.get("session.id"), span.get("traceId")) or "")
                    if not session_id:
                        st.rejected += 1
                        st.first_error = st.first_error or "span has no traceId"
                        continue
                    start, end = _ns(span.get("startTimeUnixNano")), _ns(span.get("endTimeUnixNano"))
                    ctx = {
                        "session_id": session_id[:64],
                        "runtime_kind": runtime_kind,
                        "trace_id": derive_trace_id(runtime_kind, session_id[:64]),
                        "started_at": _iso(start),
                        "duration_ms": int((end - start) / 1e6) if (start and end and end >= start) else None,
                        "agent_id": _first(attrs.get("gen_ai.agent.name"), res.get("service.name")),
                    }
                    if kind == "generation":
                        await _ingest_generation(span, attrs, ctx, costs, store_text)
                    else:
                        await _ingest_tool(span, attrs, ctx, tools, db, store_text)
                    st.accepted += 1
                except Exception as exc:  # noqa: BLE001
                    logger.warning("otlp ingest: span rejected: %s", exc)
                    st.rejected += 1
                    st.first_error = st.first_error or str(exc)[:200]

    payload: Dict[str, Any] = {}
    if st.rejected:
        payload["partialSuccess"] = {"rejectedSpans": st.rejected, "errorMessage": st.first_error or "rejected"}
    payload["securevector"] = {"accepted": st.accepted, "skipped": st.skipped}
    return JSONResponse(payload)


__all__: List[str] = ["router"]
