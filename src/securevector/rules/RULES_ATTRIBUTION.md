# Rules Attribution and Legal Information

This document provides detailed attribution and legal information for all security rules included in the AI Threat Monitor SDK.

## 📋 Rule Attribution Summary

| Rule Category | Source Type | Attribution Required | License |
|---------------|-------------|---------------------|---------|
| Essential | SecureVector Original | No | Apache 2.0 |
| Content Safety | Mixed Sources | See Below | Apache 2.0 |
| Data Exfiltration | SecureVector Original | No | Apache 2.0 |
| PII Detection | Industry Standards | See Below | Apache 2.0 |
| Jailbreak | Research-Based | See Below | Apache 2.0 |
| Abuse | SecureVector Original | No | Apache 2.0 |
| Compliance | Regulatory Standards | See Below | Apache 2.0 |
| Industry | Mixed Sources | See Below | Apache 2.0 |

## 🔍 Detailed Attributions

### Essential Rules (`bundled/essential/`)
- **Source**: Original SecureVector research and development
- **Contributors**: SecureVector Security Research Team
- **License**: Apache License 2.0
- **Attribution**: Not required (original work)

### Content Safety Rules (`bundled/content_safety/`)
- **Base Patterns**: SecureVector original development
- **Influenced By**:
  - OWASP Top 10 for LLMs
  - AI Safety research from Anthropic, OpenAI
  - Academic research on harmful content detection
- **License**: Apache License 2.0
- **Attribution**: Derivative work, original research applied

### Data Exfiltration Rules (`bundled/data_exfiltration/`)
- **Source**: SecureVector proprietary research
- **Based On**: Analysis of real-world attack patterns
- **License**: Apache License 2.0
- **Attribution**: Not required (original work)

### PII Detection Rules (`bundled/pii/`)
- **Pattern Sources**:
  - US Social Security Number formats (public domain)
  - Credit card number patterns (Luhn algorithm - public domain)
  - Phone number formats (ITU standards)
  - Email patterns (RFC 5322 standard)
- **Implementation**: SecureVector original
- **License**: Apache License 2.0
- **Standards Referenced**:
  - ITU-T E.164 (phone numbers)
  - RFC 5322 (email addresses)
  - ISO/IEC 7812 (credit card numbers)

### Jailbreak Detection Rules (`bundled/jailbreak/`)
- **Research Sources**:
  - "Jailbroken: How Does LLM Safety Training Fail?" (Anthropic, 2023)
  - "Universal and Transferable Adversarial Attacks on Aligned Language Models" (Zou et al., 2023)
  - Community research from AI Village, HackerOne
- **Implementation**: SecureVector adaptation and enhancement
- **License**: Apache License 2.0
- **Attribution**: Derived from published research, significantly modified

### Abuse Prevention Rules (`bundled/abuse/`)
- **Source**: SecureVector Security Research Team
- **Methodology**: Original pattern development
- **License**: Apache License 2.0
- **Attribution**: Not required (original work)

### Compliance Rules (`bundled/compliance/`)

#### GDPR Rules (`compliance/gdpr.yml`)
- **Source**: EU General Data Protection Regulation (Regulation 2016/679)
- **Implementation**: SecureVector interpretation of regulatory requirements
- **Legal Basis**: Public regulation
- **License**: Apache License 2.0
- **References**:
  - Article 5 (Principles of processing)
  - Article 6 (Lawfulness of processing)
  - Article 32 (Security of processing)
  - Article 35 (Data protection impact assessment)

#### HIPAA Rules (`compliance/hipaa.yml`)
- **Source**: US Health Insurance Portability and Accountability Act
- **Implementation**: SecureVector interpretation of 45 CFR Parts 160, 162, 164
- **Legal Basis**: Public regulation
- **License**: Apache License 2.0
- **References**:
  - 45 CFR §164.502 (Uses and disclosures)
  - 45 CFR §164.514 (De-identification)
  - 45 CFR §164.308 (Administrative safeguards)

#### SOX Rules (`compliance/sox.yml`)
- **Source**: Sarbanes-Oxley Act of 2002
- **Implementation**: SecureVector interpretation of financial reporting requirements
- **Legal Basis**: Public law (15 U.S.C. 7201 et seq.)
- **License**: Apache License 2.0
- **References**:
  - Section 302 (Corporate responsibility)
  - Section 404 (Management assessment)

### Industry-Specific Rules (`bundled/industry/`)

#### Healthcare Rules (`industry/healthcare.yml`)
- **Standards Referenced**:
  - HIPAA (see above)
  - HL7 FHIR (healthcare data standards)
  - ICD-10 medical coding
- **Implementation**: SecureVector original
- **License**: Apache License 2.0

#### Education Rules (`industry/education.yml`)
- **Standards Referenced**:
  - FERPA (Family Educational Rights and Privacy Act)
  - COPPA (Children's Online Privacy Protection Act)
  - Student privacy best practices
- **Implementation**: SecureVector original
- **License**: Apache License 2.0

## 📚 Research References

### Academic Papers
1. **Zou, A., et al.** (2023). "Universal and Transferable Adversarial Attacks on Aligned Language Models" - *arXiv:2307.15043*
2. **Wei, A., et al.** (2023). "Jailbroken: How Does LLM Safety Training Fail?" - *arXiv:2307.02483*
3. **Perez, E., et al.** (2022). "Red Teaming Language Models with Language Models" - *arXiv:2202.03286*

### Industry Standards
1. **OWASP Top 10 for LLMs** - https://owasp.org/www-project-top-10-for-large-language-model-applications/
2. **NIST AI Risk Management Framework** - NIST AI 100-1
3. **ISO/IEC 23053:2022** - Framework for AI systems using ML

### Regulatory Sources
1. **EU GDPR** - Regulation (EU) 2016/679
2. **US HIPAA** - 45 CFR Parts 160, 162, 164
3. **Sarbanes-Oxley Act** - 15 U.S.C. 7201 et seq.
4. **FERPA** - 20 U.S.C. § 1232g; 34 CFR Part 99

## ⚖️ Legal Notices

### Copyright Notice
```
Copyright (c) 2025 SecureVector Team

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

### Third-Party Acknowledgments
We acknowledge and thank the following for their contributions to AI safety research:
- Anthropic AI Safety Team
- OpenAI Safety Team
- OWASP Foundation
- AI Village Community
- Academic researchers in AI safety

### Disclaimer
THE RULES PROVIDED ARE FOR REFERENCE ONLY. SECUREVECTOR MAKES NO WARRANTIES ABOUT THE COMPLETENESS, RELIABILITY, OR ACCURACY OF THESE RULES. ANY USE OF THESE RULES IS AT YOUR OWN RISK. SECUREVECTOR SHALL NOT BE LIABLE FOR ANY DAMAGES RESULTING FROM THE USE OF THESE RULES.

### Compliance Notice
These rules are designed to assist with security and compliance but do not guarantee compliance with any specific regulation or standard. Users must conduct their own compliance assessments and may need additional controls beyond these rules.

### Updates and Modifications
- **Original Date**: January 2025
- **Last Updated**: January 2025
- **Update Frequency**: Rules are updated regularly based on new research and threat intelligence
- **Change Tracking**: All rule changes are tracked in the project's version control system

## 📞 Contact Information

- **General Questions**: support@securevector.io
- **Security Issues**: security@securevector.io
- **Legal Questions**: legal@securevector.io
- **Rule Contributions**: rules@securevector.io

---

**Document Version**: 1.0.0
**Last Review Date**: January 2025
**Next Review Date**: July 2025
**Approved By**: SecureVector Legal Team