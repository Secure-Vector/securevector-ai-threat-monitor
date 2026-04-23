# Changelog

All notable changes to SecureVector AI Threat Monitor will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.5.0] - 2026-04-23

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
