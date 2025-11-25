# Security Rules Documentation

This directory contains the security rules used by the AI Threat Monitor SDK for detecting various types of threats and security violations in AI interactions.

## 📁 Directory Structure

```
rules/
├── community/         # Community rules from llm-rules-builder (used in LOCAL mode)
│   ├── sv_community_essential_patterns.yml    # Core threat detection patterns
│   ├── sv_community_prompt_injection.yml      # Prompt injection attempts
│   ├── sv_community_jailbreak_attempts.yml    # AI jailbreak detection
│   ├── sv_community_data_extraction.yml       # Data exfiltration patterns
│   ├── sv_community_social_engineering.yml    # Social engineering attempts
│   ├── sv_community_pii_detection.yml         # PII detection patterns
│   ├── sv_community_harmful_content.yml       # Harmful content detection
│   ├── owasp_top10.yml                        # OWASP LLM Top 10 patterns
│   └── mitre_patterns.yml                     # MITRE ATT&CK patterns
├── custom/            # User-defined custom rules (empty by default)
├── cache/             # Compiled rule cache (auto-generated)
└── management/        # Rule management utilities (future)
```

## 🔒 Rule Sources and Attribution

### Community Rules (LOCAL Mode)

The community rules in this SDK are sourced from the [llm-rules-builder](https://github.com/securevector/llm-rules-builder) project:

1. **SecureVector Community Rules**: Open-source threat detection patterns maintained by the SecureVector security community
2. **OWASP LLM Top 10**: Patterns based on OWASP's LLM security framework
3. **MITRE ATT&CK Patterns**: Detection rules aligned with MITRE ATT&CK framework for AI systems
4. **Industry Standards**: Rules implementing common security standards and best practices

### Professional & Enterprise Rules (API Mode Only)

For enhanced detection, professional and enterprise-tier rules are available exclusively through API mode:

- **Professional Rules**: Advanced threat patterns with higher accuracy and lower false positive rates
- **Enterprise Rules**: Comprehensive rule sets including regulatory compliance and industry-specific patterns
- **LLM-Powered Analysis**: Contextual threat detection using large language models

### Licensing

- **Community Rules**: Licensed under Apache 2.0 (same as main SDK)
- **Custom Rules**: Users retain full ownership and control of their custom rules
- **API Mode Rules**: Accessed via SecureVector API subscription

### Disclaimers

⚠️ **Important Legal Disclaimers:**

1. **No Guarantee of Detection**: These rules provide best-effort threat detection but cannot guarantee 100% detection of all threats
2. **False Positives**: Rules may flag legitimate content as threatening (users should review and tune)
3. **Evolving Threats**: New attack patterns emerge constantly; rules require regular updates
4. **Compliance Aid Only**: Compliance rules help identify potential violations but do not guarantee regulatory compliance
5. **Context Dependent**: Rule effectiveness may vary based on use case and context

## 📊 Rule Categories

### Essential Patterns (`sv_community_essential_patterns.yml`)
Core patterns for fundamental threat detection:
- Instruction override attempts
- Jailbreak persona activation
- Credential extraction
- Safety bypass attempts
- System probing

### Prompt Injection (`sv_community_prompt_injection.yml`)
Detection of prompt injection attacks:
- Direct instruction override
- Context manipulation
- Role confusion attacks
- System prompt extraction

### Jailbreak Attempts (`sv_community_jailbreak_attempts.yml`)
Advanced AI jailbreak detection:
- DAN and similar personas
- Role-play manipulation
- Hypothetical scenario abuse
- Character impersonation

### Data Extraction (`sv_community_data_extraction.yml`)
Patterns to detect data exfiltration:
- Database structure requests
- API credential extraction
- System information harvesting
- Privilege escalation attempts

### Social Engineering (`sv_community_social_engineering.yml`)
Detection of social engineering tactics:
- Authority impersonation
- Trust exploitation
- Emergency override claims
- Fake identity claims

### PII Detection (`sv_community_pii_detection.yml`)
Personal Identifiable Information detection:
- Social Security Numbers
- Credit card patterns
- Medical record requests
- Financial information

### Harmful Content (`sv_community_harmful_content.yml`)
Detection of harmful content requests:
- Violence and harm instructions
- Illegal activity guidance
- Self-harm content
- Weapon creation instructions

### OWASP Top 10 (`owasp_top10.yml`)
Patterns based on OWASP's LLM Top 10:
- LLM01: Prompt Injection
- LLM02: Insecure Output Handling
- LLM03: Training Data Poisoning
- LLM04: Model Denial of Service
- And more...

### MITRE Patterns (`mitre_patterns.yml`)
Detection rules aligned with MITRE ATT&CK:
- Initial Access techniques
- Execution patterns
- Persistence mechanisms
- Privilege Escalation

## 🛠️ Rule Format

Community rules are defined in YAML format following the llm-rules-builder schema:

```yaml
rules:
  - category: threat_category
    description: Human-readable description
    enabled: true
    id: unique_rule_id
    metadata:
      author: Rule author
      created_at: Creation timestamp
      effectiveness_metrics:
        detection_rate: 0.0-1.0
        precision: 0.0-1.0
        recall: 0.0-1.0
      false_positive_rate: 0.0-1.0
      tags: [tag1, tag2]
    name: Rule name
    pattern:
      case_sensitive: false
      confidence_threshold: 0.0-1.0
      type: regex
      value:
        - pattern1
        - pattern2
    severity: low|medium|high|critical
    tier:
      - community
      - professional  # API mode only
      - enterprise    # API mode only
```

## 🔧 Customization Guide

### Adding Custom Rules

1. **Create custom rule files** in the `custom/` directory
2. **Follow the YAML format** shown above
3. **Test thoroughly** to avoid false positives
4. **Document your rules** for future reference

### Rule Tuning

Users can adjust rule behavior by:
- Modifying confidence thresholds
- Adding exceptions for specific contexts
- Customizing severity levels
- Enabling/disabling rule categories

### Best Practices

1. **Start Conservative**: Begin with higher confidence thresholds
2. **Monitor False Positives**: Regularly review flagged content
3. **Context Matters**: Tune rules for your specific use case
4. **Keep Updated**: Regularly update to latest rule versions
5. **Document Changes**: Maintain records of customizations

## 📚 References and Further Reading

### Security Research
- [OWASP Top 10 for LLMs](https://owasp.org/www-project-top-10-for-large-language-model-applications/)
- [AI Red Team Playbook](https://aivillage.org/large%20language%20models/threat-modeling-llm/)
- [Prompt Injection Research](https://arxiv.org/abs/2302.12173)
- [llm-rules-builder Repository](https://github.com/securevector/llm-rules-builder)

### Frameworks
- [MITRE ATT&CK for AI](https://atlas.mitre.org/)
- [NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework)
- [ISO 42001 AI Management System](https://www.iso.org/standard/81230.html)

## 🆘 Support and Updates

### Rule Updates
- **Automatic Updates**: Enable auto-updates for latest threat patterns
- **Community Contributions**: Contribute to llm-rules-builder repository
- **API Mode**: Get real-time updates via SecureVector API

### Getting Help
- **Documentation**: [https://docs.securevector.io/ai-threat-monitor](https://docs.securevector.io/ai-threat-monitor)
- **Support**: [GitHub Issues](https://github.com/secure-vector/ai-threat-monitor/issues)
- **Security Issues**: security@securevector.io (for security vulnerabilities)
- **Community**: [GitHub Discussions](https://github.com/securevector/llm-rules-builder/discussions)

---

**⚖️ Legal Notice**: This software is provided "AS IS" without warranty. Users are responsible for compliance with applicable laws and regulations. See LICENSE file for full terms.

**🔐 Security Notice**: Report security vulnerabilities privately to security@securevector.io. Do not disclose security issues publicly until patched.

**📅 Last Updated**: January 2025 | **Version**: 1.0.0
