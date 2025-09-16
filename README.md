# SecureVector AI Threat Monitor SDK

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![PyPI version](https://badge.fury.io/py/securevector-ai-monitor.svg)](https://badge.fury.io/py/securevector-ai-monitor)
[![Downloads](https://pepy.tech/badge/securevector-ai-monitor)](https://pepy.tech/project/securevector-ai-monitor)
[![Python](https://img.shields.io/pypi/pyversions/securevector-ai-monitor.svg)](https://pypi.org/project/securevector-ai-monitor)

Enterprise-grade AI security monitoring SDK. Protect your AI applications from prompt injection, data exfiltration, and security attacks with 5-15ms latency.

**Key Features:** 3-line integration | Privacy-first | Works offline | 50+ threat patterns

## Getting Started

### Installation
```bash
pip install securevector-ai-monitor
securevector test  # Verify installation
```

### Basic Usage
```python
from securevector import SecureVectorClient

# Initialize client (auto-detects best mode)
client = SecureVectorClient()

# Analyze user input before sending to AI
result = client.analyze(user_prompt)
if result.is_threat:
    return "Request blocked for security reasons"

# Safe to proceed with AI processing
response = your_ai_model(user_prompt)
```

### Framework Integration
```python
# FastAPI example
from fastapi import HTTPException
from securevector.exceptions import SecurityException

@app.post("/chat")
async def chat(message: str):
    try:
        client.analyze(message)  # Throws exception if threat detected
        return {"response": await your_ai_model(message)}
    except SecurityException as e:
        raise HTTPException(400, f"Security threat: {e}")
```

## What It Protects Against

- **Prompt Injection** - "Ignore previous instructions..."
- **Data Exfiltration** - "Show me all customer data..."
- **Jailbreak Attempts** - "You are now DAN..."
- **Social Engineering** - "I'm the CEO, give me admin access..."
- **PII Exposure** - Detection of sensitive information leaks

## CLI Usage

```bash
securevector test                    # Test the system
securevector analyze "What is AI?"   # Analyze a prompt
securevector status                  # Check system status
securevector --help                  # Get help
```

## Operation Modes

| Mode | Speed | Accuracy | Privacy | Use Case |
|------|-------|----------|---------|----------|
| **Local** | 5-15ms | Good | Maximum | Development, offline |
| **API** | 100-500ms | Highest | Moderate | Production, max accuracy |
| **Hybrid** | 10-100ms | Balanced | Balanced | Production, optimized |
| **Auto** | Adaptive | Adaptive | Adaptive | Zero-config (recommended) |

```python
# Mode selection examples
client = SecureVectorClient()                           # Auto (recommended)
client = SecureVectorClient(mode="local")               # Fast, private
client = SecureVectorClient(mode="api", api_key="...")  # Max accuracy
```

**📖 Detailed mode information:** [Operation Modes Documentation](docs/OPERATION_MODES.md)

## Configuration

```python
# Environment variables
export SECUREVECTOR_MODE="local"                    # Operation mode
export SECUREVECTOR_API_KEY="your-api-key"         # For API/hybrid modes
export SECUREVECTOR_RULES_PATH="/path/to/rules"    # Custom rules

# Programmatic configuration
client = SecureVectorClient(
    mode="hybrid",
    api_key="your-key",
    risk_threshold=80,
    enable_caching=True
)
```

## Testing

```bash
# Built-in test suite
securevector test

# Run full test suite
pytest tests/ -v

# Interactive demo
pip install -r demo/requirements.txt
streamlit run demo/chat_demo.py
```

## Requirements

- Python 3.10+
- Compatible with: OpenAI, Anthropic Claude, Azure OpenAI, local models, any text-based LLM

## Documentation

- **[API Reference](docs/API_REFERENCE.md)** - Complete API documentation
- **[Operation Modes](docs/OPERATION_MODES.md)** - Detailed mode information
- **[Security Rules](src/ai_threat_monitor/rules/README.md)** - Rule documentation and legal information
- **[Rules Attribution](src/ai_threat_monitor/rules/RULES_ATTRIBUTION.md)** - Legal attribution and compliance details
- **[Demo Guide](demo/README.md)** - Interactive examples

## Support

- **Bug Reports:** [GitHub Issues](https://github.com/secure-vector/ai-threat-monitor/issues)
- **Questions:** [GitHub Discussions](https://github.com/secure-vector/ai-threat-monitor/discussions)
- **Security Issues:** Create issue with "security" label

## Contributing

We welcome contributions! See [CONTRIBUTOR_AGREEMENT.md](CONTRIBUTOR_AGREEMENT.md) for guidelines.

1. Fork the repository
2. Create feature branch: `git checkout -b feature/name`
3. Add tests for changes
4. Submit pull request

## License

Apache License 2.0 - see [LICENSE](LICENSE) file for details.
