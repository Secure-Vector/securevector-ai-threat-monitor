# Privacy Policy

**SecureVector AI Threat Monitor**
**Effective Date:** January 1, 2025
**Last Updated:** January 31, 2026

---

## Overview

This Privacy Policy describes how SecureVector ("we", "us", or "our") collects, uses, and protects your information when you use the SecureVector AI Threat Monitor software and related services.

**Important:** SecureVector AI Threat Monitor can be used in different modes with different privacy implications. Please read carefully to understand how your data is handled.

---

## 1. Deployment Modes and Data Collection

### Local Mode (Default - No Data Collection)

**What happens:**
- All threat analysis is performed locally on your infrastructure
- No data is transmitted to SecureVector servers
- No data is collected, stored, or processed by us
- Complete data privacy and control

**Data flow:**
```
Your Application → SecureVector Library (Local) → Result
(No external communication)
```

**Privacy level:** ✅ **MAXIMUM** - We have zero access to your data

---

### Desktop App Mode (Local Storage - No Data Collection)

**What happens:**
- All threat analysis is performed locally on your machine
- Data is stored locally in SQLite database on your device
- No data is transmitted to SecureVector servers
- No API key required
- 100% offline capable

**Data stored locally on YOUR device:**
| Data Type | Description | Location |
|-----------|-------------|----------|
| Threat Intel Records | Analysis results, timestamps, matched rules | SQLite database |
| Custom Rules | User-created detection rules | SQLite database |
| App Settings | Preferences, UI configuration | SQLite database |
| Community Rules Cache | Cached copy of community rules | SQLite database |

**Database file locations (by platform):**
- **Linux:** `~/.local/share/securevector/threat-monitor/securevector.db`
- **Windows:** `%LOCALAPPDATA%\SecureVector\ThreatMonitor\securevector.db`
- **macOS:** `~/Library/Application Support/SecureVector/ThreatMonitor/securevector.db`

**Data flow:**
```
Your AI Agents → Desktop App (localhost:8741) → SQLite (local) → Dashboard
(No external communication - everything stays on your machine)
```

**Privacy level:** ✅ **MAXIMUM** - We have zero access to your data. All data remains on your device.

**How to delete your data:**
1. Close the desktop application
2. Delete the database file at the location above for your platform
3. Alternatively, delete the entire folder to remove all app data

---

### API/Cloud Mode (Optional - Data Collection)

**What happens when you use our cloud API:**

**Data We Collect:**
1. **Input Text:** The text/prompts you send for analysis
2. **Analysis Results:** Threat detection outcomes, risk scores, matched rules
3. **API Usage Metadata:**
   - Timestamp of request
   - API key identifier (hashed)
   - Request/response size
   - Error codes and logs
4. **Technical Data:**
   - IP address
   - User agent
   - SDK version

**Data We DO NOT Collect:**
- Personal identification (unless you include it in prompts)
- Payment information (handled by third-party processor)
- Device identifiers beyond IP address
- Browsing history or cookies (server-side API only)

---

## 2. How We Use Your Data

### Primary Uses

**API/Cloud Mode:**
- ✅ **Threat Analysis:** Analyze your text for security threats
- ✅ **Service Delivery:** Return analysis results to you
- ✅ **Service Improvement:** Aggregate statistics on threat patterns (anonymized)
- ✅ **Security:** Detect abuse, fraud, or attacks on our service
- ✅ **Compliance:** Meet legal obligations if required

**Local Mode:**
- N/A - No data collected

### We Do NOT:
- ❌ Sell your data to third parties
- ❌ Use your prompts to train AI models (unless you explicitly opt in)
- ❌ Share your data with advertisers
- ❌ Use your data for marketing purposes
- ❌ Retain data longer than necessary

---

## 3. Data Retention

### API/Cloud Mode

**Analysis Data (Prompts & Results):**
- **Default Retention:** 30 days
- **Purpose:** Service debugging, dispute resolution
- **Deletion:** Automatically purged after 30 days

**Aggregated Statistics:**
- **Retention:** Indefinite
- **Form:** Anonymized, aggregated metrics only
- **Example:** "% of requests containing SQL injection patterns"

**Account Data:**
- **Retention:** Duration of account + 90 days after closure
- **Purpose:** Billing, support, legal compliance

**Legal Holds:**
- Data may be retained longer if required by law, regulation, or legal process

### Local Mode
- **Retention:** N/A - No data sent to us

---

## 4. Data Sharing and Disclosure

### We Share Data With:

**Service Providers:**
- Cloud hosting providers (AWS, Google Cloud) - for infrastructure
- Payment processors (Stripe) - for billing (commercial plans only)
- Analytics services (anonymized metrics only)

**Legal Requirements:**
We may disclose your data if required to:
- Comply with legal obligations (subpoena, court order)
- Protect our rights and property
- Prevent fraud or security threats
- Protect user safety

**Business Transfers:**
If SecureVector is acquired or merged, your data may be transferred to the new entity under the same privacy terms.

### We Do NOT Share With:
- ❌ Advertisers or marketing companies
- ❌ Data brokers
- ❌ Social media platforms
- ❌ AI training companies (unless you explicitly opt in to a training data program)

---

## 5. Data Security

**Technical Measures:**
- ✅ **Encryption in Transit:** TLS 1.3 for all API communications
- ✅ **Encryption at Rest:** AES-256 for stored data
- ✅ **Access Controls:** Role-based access, least privilege principle
- ✅ **Monitoring:** Security logging and anomaly detection
- ✅ **Regular Audits:** Security reviews and penetration testing

**Organizational Measures:**
- Employee access limited to necessary personnel
- Confidentiality agreements for all staff
- Security incident response plan

**Limitations:**
⚠️ No security system is 100% secure. While we implement industry-standard protections, we cannot guarantee absolute security. Use local mode for maximum data protection.

---

## 6. Your Privacy Rights

### All Users

**Right to Choose:**
- ✅ Use local mode for complete privacy
- ✅ Use API mode only when needed
- ✅ Switch between modes at any time

### API/Cloud Mode Users

**Access:**
- Request a copy of your data
- View your API usage history

**Deletion:**
- Request deletion of your account and associated data
- Data deleted within 30 days of request (except legal hold requirements)

**Portability:**
- Export your detection rules and configuration
- Export API usage logs

**Correction:**
- Update your account information
- Correct inaccurate data

**Objection:**
- Object to data processing for certain purposes
- Opt out of analytics (may limit service functionality)

**How to Exercise Rights:**
- Email: contact@securevector.io (or create GitHub issue with "privacy" label)
- Response time: 30 days

---

## 7. Regional Privacy Rights

### European Union (GDPR)

**Legal Basis for Processing:**
- **Contract Performance:** Providing threat analysis services
- **Legitimate Interest:** Service improvement, security, fraud prevention
- **Consent:** Where required by law

**Additional Rights:**
- Right to lodge complaint with supervisory authority
- Right to withdraw consent (where applicable)
- Right to data portability

**Data Controller:** SecureVector (contact via contact@securevector.io)

**EU Representative:** Not yet appointed (company under 250 employees)

### California (CCPA/CPRA)

**Categories of Data Collected:**
- Identifiers (API key, IP address)
- Internet activity (API requests, logs)
- Commercial information (API usage, billing)

**Your CCPA Rights:**
- Right to know what data is collected
- Right to delete personal information
- Right to opt-out of sale (Note: We do not sell data)
- Right to non-discrimination

**Do Not Sell My Personal Information:**
We do not sell personal information. No opt-out needed.

### Other Jurisdictions

We comply with applicable privacy laws in all jurisdictions. If you have specific privacy law questions, contact contact@securevector.io.

---

## 8. International Data Transfers

**Current Infrastructure:**
- Primary servers located in United States
- Data may be processed in USA, EU, or other regions

**Transfer Mechanisms:**
- Standard Contractual Clauses (SCCs) for EU data
- Compliance with applicable data protection regulations

**Your Control:**
If you require data to remain in specific jurisdiction, use **local mode**.

---

## 9. Cookies and Tracking

**SDK/API:**
- ❌ No cookies used
- ❌ No browser tracking
- ✅ Server-side API calls only

**Website (securevector.io):**
- Essential cookies for site functionality
- Analytics cookies (optional - you can opt out)
- No advertising cookies

---

## 10. Children's Privacy

SecureVector AI Threat Monitor is not directed at children under 13 (or 16 in EU).

- We do not knowingly collect data from children
- If you believe we have collected child data, contact us immediately
- We will delete such data promptly

---

## 11. Open Source Software

**This Privacy Policy applies to:**
- ✅ Cloud/API services provided by SecureVector
- ✅ Official SecureVector web properties

**This Privacy Policy does NOT apply to:**
- ❌ Self-hosted installations using local mode
- ❌ Modified/forked versions of the open source code
- ❌ Third-party deployments

**If you fork or self-host:** You are responsible for your own privacy policy and compliance.

---

## 12. Third-Party Services

**Our software may integrate with:**
- OpenAI, Anthropic, Google (if you use their APIs)
- LangChain, LangGraph, n8n (if you use these frameworks)

**Important:**
- We are not responsible for third-party privacy practices
- Review their privacy policies separately
- Your use of their services is subject to their terms

---

## 13. Data Breach Notification

**In the event of a data breach:**
1. We will investigate within 72 hours
2. Notify affected users via email within 72 hours (if required by law)
3. Report to applicable authorities (GDPR, state laws)
4. Provide details on:
   - What data was affected
   - What we're doing about it
   - What you should do

---

## 14. Changes to This Policy

**We may update this policy:**
- To reflect new features or services
- To comply with legal requirements
- To improve transparency

**Notification:**
- Material changes: Email notification 30 days in advance
- Minor changes: Updated "Last Updated" date
- Continued use constitutes acceptance

**Version History:**
- v1.0 (2025-01-01): Initial policy
- v1.1 (2025-12-16): Updated prior to public release
- v2.0 (2026-01-31): Added Desktop App Mode section with local SQLite storage details

---

## 15. Contact Information

**Privacy Questions:**
- Email: contact@securevector.io
- GitHub: Create issue with "privacy" label at https://github.com/Secure-Vector/securevector-ai-threat-monitor/issues
- Response time: 30 days maximum

**Data Protection Officer:**
Not yet appointed (company under GDPR threshold)

**EU Representative:**
Not yet appointed (company under GDPR threshold)

---

## 16. Legal Basis Summary

| Purpose | Legal Basis (GDPR) | Opt-Out Available? |
|---------|-------------------|-------------------|
| Threat analysis (API mode) | Contract performance | Yes - use local mode |
| Service improvement | Legitimate interest | Yes - contact us |
| Security & fraud prevention | Legitimate interest | No - essential function |
| Legal compliance | Legal obligation | No - required by law |
| Aggregated analytics | Legitimate interest | Yes - contact us |

---

## Summary

**🔒 Privacy-First Design:**
- **Local mode (SDK):** Zero data collection (default recommendation)
- **Desktop App mode:** Local SQLite storage only, zero external data transmission
- **API mode:** Minimal collection, 30-day retention, strong security
- **Transparency:** Clear disclosure of all data practices
- **User control:** You choose your privacy level

**📧 Questions?**
Contact contact@securevector.io or create a GitHub issue.

---

**By using SecureVector AI Threat Monitor, you acknowledge that you have read and understood this Privacy Policy.**

---

<div align="center">

**Last Updated:** January 31, 2026
**Effective Date:** January 1, 2025

</div>
