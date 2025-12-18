# Changelog

All notable changes to SecureVector AI Threat Monitor will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
