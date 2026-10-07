# SIEM Forwarder and dashboard templates

Stream every threat detection and tool-call audit into your own SIEM: Splunk HEC, Datadog, Microsoft Sentinel, Google Chronicle, IBM QRadar, an OpenTelemetry collector, a local NDJSON file, or any HTTPS endpoint that accepts JSON. Your data, your pipes.

## The forwarder

**Why this is safe to ship with zero monetization:**

| Feature | What leaves your machine |
|---|---|
| Scan verdict | `scan_id`, `verdict`, `threat_score`, `risk_level`, `detected_types[]`, counts, durations |
| Tool-call audit | `seq`, `action`, `risk`, `prev_hash`, `row_hash` (the chain witness, which lets your SIEM verify integrity) |
| **Not transmitted by default** | Prompt text, LLM output, matched patterns, reviewer reasoning, model reasoning. A destination set to the `full` level (off by default, chosen per destination) adds raw prompt text, LLM output and full tool arguments, each capped at 8 KB |

The allow-list is enforced at enqueue time by `_assert_metadata_only()`: a destination below `full` can never receive those fields, even if the forwarder code were tampered with.

**Supported destinations (one code path, OCSF 1.3.0 payload):**

| Kind | Target | Auth header |
|---|---|---|
| `splunk_hec` | `https://<host>/services/collector/event` | `Authorization: Splunk <HEC-token>` |
| `datadog` | `https://http-intake.logs.<site>/api/v2/logs` | `DD-API-KEY: <key>` |
| `otlp_http` | `https://<collector>/v1/logs` | optional `Authorization: Bearer <token>` |
| `webhook` | anything that accepts JSON POST | optional `Authorization: Bearer <token>` |

**Configure in Connect → SIEM Forwarder.** Add SIEM destination → pick type → paste URL + token → Test → Save. Tokens are stored `0o600` in the app data dir, never in SQLite.

**Reliability:**
- Per-destination outbox with at-least-once delivery.
- A failing Datadog destination never blocks a healthy Splunk one.
- Per-destination circuit breaker backs off broken endpoints (1 min → 1 hour cap).
- Rows that fail 10 times are dropped (the health view shows the consecutive-failure count).

**SIEM-side integrity verification.** Every forwarded tool-call audit row carries its `prev_hash` and `row_hash`. Run a nightly search in your SIEM that rebuilds the chain: if a historic row has been changed on the local host, the forwarded copy still tells the true story. The local hash chain shows tampering on this machine; the forwarded chain is the off-host record. Every event also carries `device.uid`, so a fleet can be sliced by machine ([Device Identity](../DEVICE_IDENTITY.md)).

## Starter dashboards

Pre-built overviews of SecureVector events (OCSF 1.3.0) for common SIEMs. Each
template assumes you have a SIEM Forwarder configured (Connect → SIEM Forwarder
inside the app) pointing at the corresponding destination. Each carries severity counters, events-over-time by severity, actor and MITRE-ish breakdowns, and a recent-high-severity log feed.

**MIT-licensed, AS-IS.** See [`LICENSE`](LICENSE) + [`NOTICE`](NOTICE). Import
into your own stack and verify panels render against real events before relying
on them for production detections. Adjust queries, facets and sourcetypes to your stack.

## Splunk

File: [`splunk/securevector-dashboard.xml`](splunk/securevector-dashboard.xml)

Import:

1. Splunk Web → Dashboards → Create a new dashboard → Source.
2. Paste the contents of the XML file, save.

What it shows:

- 24h counters: BLOCKS, DETECTED, tool-call blocks, reporting devices.
- Event volume over time by severity.
- Top MITRE ATT&CK techniques (from `finding.techniques[].uid`).
- Top matched rules (from `unmapped.matched_rule_ids[]`).
- Top actors (`actor.user.name` + `actor.process.name`).
- Finding clusters — repeat attacks grouped by `finding.related_events_uid`.
- Rate-limit / burst suppression (from `suppressed_count`).
- Hash-chain integrity sanity (first/last `seq` vs row count per device).

Field paths assume the default HEC ingest; sourcetype `securevector:ocsf`.

## Microsoft Sentinel

File: [`sentinel/securevector-workbook.json`](sentinel/securevector-workbook.json)

Minimal KQL workbook covering the same tiles as the Splunk dashboard. Import:
Sentinel → Workbooks → Advanced Editor → paste JSON → Apply → Save. Set the
`TableName` parameter to match your DCR custom table (default
`Custom-SecureVector_CL`).

## Datadog

File: [`datadog/securevector-dashboard.json`](datadog/securevector-dashboard.json)

Log-based dashboard for the Datadog destination kind. Import: Datadog →
Dashboards → New Dashboard → top-right menu → Import Dashboard JSON → paste.

Before the widgets render cleanly, configure Datadog Logs facets for:
`@severity`, `@class_uid`, `@unmapped.action`, `@actor.user.name`,
`@finding.techniques`, `@device.uid`. Logs → Configuration → Facets.

## Grafana (Loki)

File: [`grafana/securevector-dashboard.json`](grafana/securevector-dashboard.json)

Starter dashboard for the indie / homelab path: SecureVector **Local NDJSON
file** destination → Promtail/Alloy → Loki → Grafana. Import: Grafana →
Dashboards → New → Import → paste JSON → pick your Loki datasource. Adjust
the `$job` textbox variable to match your Promtail pipeline label (default
`securevector`).

Note: Loki's JSON parser flattens arrays to indexed keys (e.g.
`finding_techniques_0_uid`), so the MITRE-by-technique breakdown from the
Splunk / Sentinel templates doesn't port cleanly. This template uses
`finding.title` as the flat-string breakdown instead; if you need
technique-level pivots in Grafana, pre-flatten the array in Promtail.

## Field reference

| OCSF path | Source | Why |
|---|---|---|
| `class_uid` | encoder | 2001 = scan finding, 1007 = tool-call audit |
| `severity` / `severity_id` | encoder | BLOCK / DETECTED / ALLOW + OCSF severity_id |
| `device.uid` | scanner | stable per-machine hash (`sv-<24 hex>`) |
| `actor.user.name` | scanner | OS login of the user who triggered the scan |
| `actor.process.name` | scanner | `source` identifier from the /analyze call |
| `finding.techniques[].uid` | rule metadata | MITRE ATT&CK technique IDs |
| `finding.related_events_uid[]` | scanner | `finding_group_id` — clusters repeat attacks |
| `confidence` / `confidence_score` | scanner | 0–100 int + 0.0–1.0 float |
| `unmapped.matched_rule_ids[]` | scanner | IDs of every rule that fired |
| `unmapped.worst_rule_severity` | scanner | highest per-rule severity among matches |
| `unmapped.seq` / `prev_hash` / `row_hash` | tool-call audit | SHA-256 hash chain — verify off-host |
| `suppressed_count` | forwarder burst guard | events dropped by per-destination rate limit |
