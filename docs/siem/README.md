# SIEM dashboard templates

Pre-built overviews of SecureVector events (OCSF 1.3.0) for common SIEMs. Each
template assumes you have a SIEM Forwarder configured (Configure → Connect →
SIEM Forwarder inside the app) pointing at the corresponding destination.

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
Sentinel → Workbooks → Advanced Editor → paste JSON → Apply → Save.

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
