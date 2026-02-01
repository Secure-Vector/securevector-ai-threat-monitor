# Changelog

All notable changes to SecureVector AI Threat Monitor will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-01-31

### Added
- **Desktop Application** - Cross-platform GUI for monitoring AI agents (`pip install securevector-ai-monitor[app]`)
  - Visual dashboard with real-time threat monitoring and statistics
  - Local REST API server at `localhost:8741` for agent integration
  - NLP-based rule creation - describe threats in natural language
  - Threat Intel browser for searching and analyzing detected threats
  - SQLite persistence for threat records, custom rules, and settings
  - System tray integration for background operation
  - 100% local operation - no cloud, no API key required
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
  - Flet >=0.21.0 (Apache-2.0) - Cross-platform UI
  - FastAPI >=0.100.0 (MIT) - Local API server
  - Uvicorn >=0.20.0 (BSD-3-Clause) - ASGI server
  - SQLAlchemy >=2.0.0 (MIT) - Database ORM
  - aiosqlite >=0.19.0 (MIT) - Async SQLite
  - platformdirs >=3.0.0 (MIT) - Cross-platform paths
  - watchdog >=3.0.0 (Apache-2.0) - File system events

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
