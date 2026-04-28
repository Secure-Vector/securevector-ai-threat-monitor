# Changelog

All notable changes to SecureVector AI Threat Monitor will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.1.1] - 2026-04-27

### Fixed
- **Desktop app hang on Cmd+Q / window close (macOS)** — `run_desktop()` launched uvicorn as a daemon thread with no shutdown handshake. pywebview's Cocoa run loop waits for the daemon thread to drain on shutdown; uvicorn's event loop holds long-lived connections (SSE / keepalive) that never return, so the process hung and only force-quit recovered. Fix: register a `window.events.closing` handler that calls `os._exit(0)` immediately on user-triggered close, plus a backstop `os._exit(0)` after `webview.start()` returns. There is no per-process state to flush — DB writes are committed inline; logs are best-effort.
- **`--web` mode SIGINT shutdown latency** (`run_web()` and `start_server()`) — passed `timeout_graceful_shutdown=1` to `uvicorn.run()` so in-flight request drain caps at 1 second instead of waiting indefinitely. Halves Ctrl+C exit time (10.8s → 5.4s in measurement). Safe for SecureVector's request profile: scans complete in ms, SIEM forwarders run on background workers, SQLite WAL is atomic per-statement.

## [4.1.0] - 2026-04-26

### Added
- **Agent Replay timeline** — new local-first observability page (`/replay`) that merges threat scans, tool-call audits, and LLM cost records into a single time-sorted feed per agent. Filter by agent / range (1h / 6h / 24h / 7d / all, defaults to 7d) / kind (threats / tool calls / LLM cost). Each row shows severity-coloured dot, date+time, kind tag, agent, one-line summary; click to expand the raw event JSON. Export the filtered view to CSV. **Overview line chart** at the top — three subtle lines (Threats / Tool calls / LLM cost) plotted as event counts per time bucket over the active range, with per-kind totals in the legend. Sidebar entry sits under the **Agent Activity** umbrella alongside Tool Activity and Cost Tracking sub-items.
- **`/api/replay/timeline` endpoint** — backend that joins `threat_intel`, `tool_call_audit`, and `llm_cost_records` by time + agent, supports `agent`, `since`, `until`, `limit`, `include_kinds` query params. Output is bounded for inspection-grade use; SIEM Forwarder remains the durable export path.
- **Indirect Prompt Injection (IDPI) module** — new `direction="incoming"` mode on `/analyze` for scanning fetched RAG content, scraped HTML, emails, and tool outputs before they reach the LLM. Reconciles with the legacy `llm_response: bool` flag for back-compat. Resolved direction is stamped on every threat-intel record so the Threats UI + OCSF SIEM events can pivot on it. Defaults preserve byte-identical behaviour for v4.0.x clients.
- **`indirect_prompt_injection` rule pack (12 starter rules)** — covers hidden HTML comments, zero-width unicode steganography, role override, tool-call hijack, HTTP exfiltration, system-prompt extraction, javascript: markdown URIs, hidden CSS instruction blocks, base64 decode-and-execute directives, credential / token exfil, pseudo-system "new instructions" headers, and inline data: URIs carrying executable content. All MITRE-tagged. Surfaces under Rules as a new category.
- **SLSA Build Level 2+ provenance attestations on every wheel + sdist** — release workflow now signs every published artifact via Sigstore Fulcio (workflow's short-lived OIDC identity) and publishes the attestation to the public Sigstore Rekor transparency log. PyPI surfaces the attestation per PEP 740. Customers verify with `gh attestation verify <wheel> --owner Secure-Vector` or `cosign verify-blob`. Zero third-party licensing — Sigstore + Rekor + Fulcio are public free services.
- **`SECURITY.md`** — vulnerability disclosure path + a Build provenance section explaining why provenance matters (SolarWinds / Codecov / 3CX / XZ utils), how to verify, what the attestation proves vs doesn't, and what to do on attestation mismatch.
- **Per-agent source filter on Threat Monitor** — Threats page gains an "Agent / Source" dropdown auto-populated from distinct sources in the loaded data. Cost Tracking already had per-agent breakdown; this closes the gap on the threats side.
- **Sidebar restructure: Agent Replay umbrella** — new collapsible Agent Replay group containing Timeline (the merged feed), Tool Activity (deep-link to tool-call audit log), and Cost Tracking (deep-link to per-agent spend dashboard). Default-expanded; clicking the parent navigates to Timeline + reveals the sub-list.

### Marketing
- README hero rewritten to lead with the runaway-cost guardrail story ("Stop your AI agent burning $400 overnight") with injection / tool-audit / skill-scan benefits as second-order. The cost-tracking + auto-stop capability shipped in v3.4.0+; this is a positioning change, not a feature change.

## [4.0.0] - 2026-04-24

### Added
- **SIEM Forwarder (free, no signup)** — forward every threat scan and tool-call audit to your SOC in OCSF 1.3.0 format. Supports Splunk HEC, Datadog, OpenTelemetry/OTLP, Microsoft Sentinel, Google Chronicle, IBM QRadar (via webhook), generic HTTPS webhook, and a **Local NDJSON file** destination (zero-infra indie path).
- **Per-destination redaction tiers** — `minimal` (default, safe) / `standard` / `full`. Full requires explicit confirmation; raw prompt / LLM output / matched patterns capped at 8 KB per field with an explicit truncation marker.
- **Per-destination SOC knobs** — `min_severity` floor (default `review`, drops WARN-tier noise), `rate_limit_per_minute` (0 = unlimited) with a sliding-window burst guard that emits a `suppressed_count` summary on the next allowed event.
- **MITRE ATT&CK tagging** — every matched rule carries `mitre_techniques` (from `metadata.mitre_attack_ids` in the YAML, with a per-category fallback map for unlabelled rules). Surfaced as OCSF `finding.techniques` in every forwarded event.
- **Actor + device attribution** — `actor.user.name` (OS login), `actor.process.name` (scan source), `device.uid` (stable `sv-<24 hex>`). All three flow into every forwarded event at every redaction tier, enabling per-user / per-host / per-fleet pivots in the SIEM.
- **Finding clustering** — deterministic `finding_group_id` = SHA-256(matched rule IDs + conversation + hour bucket) → OCSF `finding.related_events_uid`, so repeat attacks collapse to one triage finding.
- **Splunk HEC indexing verify-back** — Test button polls `/services/collector/ack` (sends `X-Splunk-Request-Channel` so acks work). Returns `verified ∈ {indexed, pending, accepted_with_ack, accepted, written}` — no more "HTTP 200 = working" false confidence.
- **Lifetime events-sent counter** per destination (migration v28) + "Last sent" relative-time column — operator-visible destination health.
- **Schema revision marker** — `metadata.extension = {name: "securevector", version: "securevector:4.0"}` on every event so downstream parsers can branch on shape changes independently of OCSF version.
- **Guide — SIEM Forwarder section** with collapsible sub-sections, enterprise deployment FAQ (fleet topology SVG), OCSF schema reference, example payloads, supported destinations table, credential-storage disclosure, and ready-made Splunk + Sentinel dashboards (`docs/siem/`).
- **Sidebar indicators** — "SIEM active (N destinations)" status chip (green) parallel to the Proxy-active chip; "AI Agent Runtime Control" tagline under the SecureVector wordmark.
- **Context-aware `?` help** — deep-links from each page (SIEM Forwarder, Skill Scanner, Tool Permissions, Costs) into the matching Guide section.

### Changed
- OCSF encoder migrated to proper field placement: `device.uid` (was in `unmapped`), top-level `confidence` (0-100 int) + `confidence_score` (0.0-1.0 float), `finding.techniques`, `actor` block with user/process, `finding.related_events` and `finding.related_events_uid`.
- Verdict vocabulary collapsed on the wire: `BLOCK / DETECTED / ALLOW` (WARN + REVIEW fold into DETECTED). Legacy verdicts still accepted by the encoder.
- Per-rule `worst_rule_severity` can override verdict-based `severity_id` when a rule carries explicit severity.
- Default redaction tier for new destinations is now `minimal` (safer posture for indie devs clicking through defaults).
- SIEM Forwarder sidebar entry moved above Integrations and anchors the Connect section.

### Infrastructure
- Migration v26: `min_severity` + `rate_limit_per_minute` on `external_forwarders`.
- Migration v27: drop `kind` CHECK constraint so new destination kinds (like `file`) don't require table rebuilds.
- Migration v28: `events_sent` lifetime counter column.
- Splunk + Sentinel dashboard templates shipped in `docs/siem/`.

## [3.6.0] - 2026-04-23

> Note: v3.5.0 was an aborted release (binary asset pipeline issue during publish) and was withdrawn. v3.6.0 ships the exact same feature set.


### Added
- **Tool-call audit hash chain** — every row in `tool_call_audit` is linked by SHA-256 (`seq`, `prev_hash`, `row_hash`). Any post-hoc edit or delete breaks the chain on the next re-verify. Verifiable locally via `GET /api/tool-permissions/call-audit/integrity` — returns `{ok, total, tampered_at}`. Migration v20 backfills hashes for existing rows.
- **Per-device identifier (`device_id`)** — every scan and audit row is stamped with a stable `sv-<24 hex>` derived from the OS machine UUID (IOPlatformUUID / `/etc/machine-id` / `MachineGuid`), SHA-256 hashed with a namespace prefix. Survives app reinstall on the same hardware; raw OS UUID never leaves the machine. Migration v21 adds the `device_id` column to `threat_intel_records` and `tool_call_audit`, plus indexes for per-device dashboard filtering.
- **Cloud rule sync — opt-in with selective save** — `POST /api/rules/sync/preview` returns a preview token; UI now shows a collapsible list of incoming rules, lets the user select which to accept (none selected by default), and requires an explicit confirmation modal ("keep cloud mode on?") before writing. Prevents accidental mass-override of local rule state.
- **Integrity column in the Tool Activity table** — dedicated `Verified` / `Tampered` pill per row, driven by the chain verification endpoint.
- **Device ID surfaces**:
  - Shown in the Tool Activity integrity banner (`· device sv-…`).
  - Visible on every Threat Detail and Tool Call Detail panel.
  - Returned by `GET /api/system/device-id` for external tooling / SIEM.

### Changed
- **Audit integrity banner** rewritten with theme-aware CSS classes (`.sv-integrity-banner.ok / .fail / .unknown`) — previously hard-coded white background was unreadable in dark theme. Added a ✕ dismiss affordance (persists for OK state only; failure + unknown always re-show). The Re-verify action moved to its own right-aligned slot below the banner — banner is evidence, button is action, separating them keeps each readable.
- **Compact toolbar buttons** — new `.btn-compact` variant applied to Auto Refresh / Export CSV / Export PDF on the Threat Monitor page; they now pair with the filter-dropdown heights instead of reading as page-primary buttons.
- **Threat details + Audit details** now include a `Device` row with the hashed device_id, monospace + tooltip describing the stability + privacy story.

### Fixed
- **Modal stale-closure on confirmation popups** — `Modal.close()` was reading `this.activeModal` inside a setTimeout after `Modal.show()` had already re-assigned it, causing the *new* modal to be removed. Fixed by capturing the reference synchronously at close time.
- **Rule sync save button label** now reflects the user's actual selection count (e.g. "Save 12 rules") instead of the full catalog size.
- **Threat scan + audit repositories** read back the `device_id` column on SELECT; previously the INSERT wrote it but `_row_to_record` and `to_dict` dropped the field, so UI detail panels and API responses showed `null`.

### Security
- **Hash-chain tamper evidence** — mutating any historical audit row (action, risk, reason, args_preview, tool_id, function_name, etc.) now detectably breaks the chain, surfaces as a red banner in the Tool Activity page, and pins the bad seq in `tampered_at`.
- **Per-device attribution** — fleet operators can slice threats and blocked tool calls by device without exposing the raw OS UUID.
- **SIEM forwarders (when enabled, v4.0 pipeline)** include `device_id` in every forwarded event's `unmapped` block for both scan (OCSF class 2001) and tool-audit (class 1007) payloads, at both `standard` and `minimal` redaction — machine attribution is kept even in minimal because fleet operators need to tell laptops apart regardless.

## [2.1.1] - 2026-02-10

### Fixed
- Removed standalone `/proxy` page — "Open Integrations" on Getting Started now expands the Integrations sidebar section
- Fixed proxy start failing silently when `integration` field is `null` (Pydantic v2 `Optional[str]` validation)
- Fixed welcome modal overlay blocking all pointer events on the page

## [2.1.0] - 2026-02-09

### Added
- **Getting Started Guide** — In-app onboarding page with step-by-step setup instructions, collapsible examples, and copyable code blocks
- **Multi-Provider Proxy** — Single proxy instance supports all 19 LLM providers simultaneously via lazy initialization (`localhost:8742/{provider}/v1`)
- **OpenClaw Integration** — Dedicated integration page for OpenClaw/ClawdBot with one-click proxy setup for Anthropic
- **Cloud Mode** — Optional connection to SecureVector Cloud for ML-powered threat detection with automatic fallback to local analysis
- **Binary Installers** — Cross-platform installers for Windows (.exe), macOS (.dmg), Linux (AppImage, DEB, RPM)
- **Auto-Refresh** — Dashboard and threats pages auto-refresh for real-time monitoring
- **LLM Recommendation** — AI Analysis settings suggest optimal provider/model configurations

### Changed
- Multi-provider proxy is now the recommended default (Option 1) across all integration pages
- Integrations UI restructured — multi-provider shown first with RECOMMENDED badge
- Threat Analytics empty state now links to Getting Started guide
- Sidebar navigation updated — Getting Started as first item with rocket icon
- Updated tagline to "100% local by default" for accuracy (cloud mode is optional)
- Credential storage refactored for improved security
- Proxy route handling improved with better error logging

### Fixed
- Fixed navigation routing errors (`getting-started` → `guide`, `integrations` → `proxy`)
- Fixed "ClawdBot" capitalization across UI
- Fixed proxy stop functionality for subprocess-started proxies
- Fixed global variable usage in proxy.py

### Documentation
- Added `docs/GETTING_STARTED.md` — comprehensive onboarding guide
- Rewrote `docs/INSTALLATION.md` — added binary installers, `[app]` as primary install
- Rewrote `docs/API_SPECIFICATION.md` — added full local API reference (30+ endpoints)
- Updated `docs/USECASES.md` — fixed broken code blocks, updated OpenAI SDK to v1.0+
- Updated `docs/MCP_GUIDE.md` — fixed Claude Code config paths
- Updated `SECURITY.md` — added v2.1.0 to supported versions
- Simplified README — clearer install options, updated screenshots, trimmed navigation

## [2.0.0] - 2026-01-31

### Added
- **Desktop Application** - Cross-platform GUI for monitoring AI agents (`pip install securevector-ai-monitor[app]`)
  - Visual dashboard with real-time threat monitoring and statistics
  - Local REST API server at `localhost:8741` for agent integration
  - NLP-based rule creation - describe threats in natural language
  - Threat Intel browser for searching and analyzing detected threats
  - SQLite persistence for threat records, custom rules, and settings
  - System tray integration for background operation
  - 100% local by default - no API key required
- **Unified Rule Architecture** - SDK automatically reads from database when desktop app is installed
  - LocalAnalyzer auto-detects app database and uses it when available
  - Falls back to YAML community rules when app is not installed
  - Custom rules created in app are immediately available to SDK

### Changed
- **Installation Options Clarified**
  - `pip install securevector-ai-monitor` - SDK only (default, lightweight ~6MB)
  - `pip install securevector-ai-monitor[app]` - SDK + Desktop Application (~60-70MB)
- Updated minimum dependency versions for security (see Security section)

### Security
- **CVE-2025-53643** (High) - Fixed HTTP Request Smuggling in aiohttp by requiring >=3.12.14
- **CVE-2024-52303** (Medium) - Fixed memory leak in aiohttp middleware by requiring >=3.12.14
- **CVE-2025-66418** (High) - Fixed unbounded decompression chain in urllib3 by requiring >=2.6.3
- **CVE-2025-66471** (High) - Fixed streaming API decompression bomb in urllib3 by requiring >=2.6.3
- **CVE-2026-21441** (High) - Fixed redirect decompression bypass in urllib3 by requiring >=2.6.3
- Removed clear-text logging of sensitive information (client IDs, session keys) in MCP tools
- Added explicit permissions to GitHub Actions workflows (principle of least privilege)

### Dependencies
- `aiohttp` minimum version: >=3.12.14 (security)
- `urllib3` minimum version: >=2.6.3 (security)
- New optional dependencies for `[app]` extra:
  - pywebview >=5.0 (BSD-3-Clause) - Lightweight cross-platform webview
  - FastAPI >=0.100.0 (MIT) - Local API server
  - Uvicorn >=0.20.0 (BSD-3-Clause) - ASGI server
  - SQLAlchemy >=2.0.0 (MIT) - Database ORM
  - aiosqlite >=0.19.0 (MIT) - Async SQLite
  - platformdirs >=3.0.0 (MIT) - Cross-platform paths
  - watchdog >=3.0.0 (Apache-2.0) - File system events
  - httpx >=0.24.0 (BSD-3-Clause) - Async HTTP client

### Documentation
- Updated README.md with desktop app installation and usage
- Added SDK vs Desktop App feature comparison table
- Updated PRIVACY_POLICY.md with desktop app local storage details
- Updated SECURITY.md with desktop app security model and dependency licenses
- Updated LICENSE_NOTICE.md with desktop app dependency table
- All documentation clarifies SDK as default, desktop app as optional

## [1.3.1] - 2025-12-18

### Changed
- Updated documentation to reflect self-contained community rules
- Simplified rule source attribution in README and code comments

### Documentation
- Updated `src/securevector/rules/README.md` to remove external repository references
- Cleaned up community rules documentation for clarity
- Streamlined "Getting Help" and "References" sections

## [1.3.0] - 2025-12-17

### Added
- Comprehensive third-party framework attributions in LICENSE_NOTICE.md
  - MITRE ATT&CK® trademark attribution and fair use statement
  - OWASP Top 10 for LLMs attribution under CC BY-SA 4.0
  - Academic research references disclaimer
  - Third-party AI service names disclaimer (OpenAI®, Anthropic®, ChatGPT®, etc.)

### Changed
- **Open Source Compliance Improvements:**
  - Removed all proprietary claims from community security rules
  - Changed `source: securevector_proprietary` to `source: securevector_community` across all community rules
  - Updated all rule descriptions from "Proprietary" to "Community-developed"
  - Replaced all `internal://` URLs with public GitHub repository URLs
  - Enhanced legal compliance for Apache 2.0 open source license

### Documentation
- Updated LICENSE_NOTICE.md with comprehensive third-party attributions
- Added proper trademark disclaimers for MITRE ATT&CK® and OWASP®
- Clarified fair use policy for security research and threat detection

### Legal
- ✅ All community rules now fully compliant with Apache 2.0 license
- ✅ Proper attribution for third-party frameworks (MITRE, OWASP)
- ✅ No remaining proprietary claims in open source code
- ✅ Trademark compliance for all referenced services and frameworks

## [1.2.0] - 2025-01-XX

### Added
- Initial community security rules
- Support for multiple detection modes (local, API, hybrid)
- Comprehensive threat detection patterns

### Security
- Enhanced detection capabilities for LLM threats
- OWASP LLM Top 10 coverage
- MITRE ATT&CK framework mapping

---

**Legend:**
- `Added` for new features
- `Changed` for changes in existing functionality
- `Deprecated` for soon-to-be removed features
- `Removed` for now removed features
- `Fixed` for any bug fixes
- `Security` for security improvements
- `Documentation` for documentation changes
- `Legal` for legal compliance improvements
