# SecureVector AI Threat Monitor - Operation Modes

This document provides comprehensive information about the different operation modes available in the SecureVector AI Threat Monitor SDK.

## Overview

The SecureVector SDK supports four distinct operation modes, each optimized for different use cases, performance requirements, and deployment scenarios.

| Mode | Speed | Accuracy | Privacy | Network Required | Use Case |
|------|--------|----------|---------|------------------|----------|
| [Local](#local-mode) | Fastest | Good | Maximum | No | Development, offline environments |
| [API](#api-mode) | Moderate | Highest | Moderate | Yes | Production, enhanced detection |
| [Hybrid](#hybrid-mode) | Optimized | Balanced | Balanced | Optional | Production, best of both |
| [Auto](#auto-mode) | Adaptive | Adaptive | Adaptive | Optional | Zero-config deployments |

## Local Mode

**Status:** ✅ Fully Implemented

Local mode provides fast, privacy-first threat detection using bundled security rules that run entirely on your machine.

### Features

- **Performance:** 5-15ms analysis time
- **Privacy:** No data leaves your machine
- **Offline:** Works without internet connection
- **Rules:** 50+ bundled security patterns
- **Memory:** < 50MB RAM usage
- **Dependencies:** None (only PyYAML)

### Configuration

```python
from securevector import SecureVectorClient
from securevector.models.config_models import OperationMode

# Basic local mode
client = SecureVectorClient(mode=OperationMode.LOCAL)

# Advanced local configuration
client = SecureVectorClient(
    mode=OperationMode.LOCAL,
    enable_caching=True,
    performance_monitoring=True
)
```

### Environment Variables

```bash
export SECUREVECTOR_MODE="local"
export SECUREVECTOR_RULES_PATH="/path/to/custom/rules"  # Optional
export SECUREVECTOR_ENABLE_CACHE="true"                # Optional
```

### CLI Usage

```bash
# Use local mode
securevector --mode local analyze "What is AI?"
securevector --mode local test
securevector --mode local benchmark
```

### Bundled Rule Categories

| Category | Patterns | Examples |
|----------|----------|----------|
| Prompt Injection | 12+ | "Ignore previous instructions" |
| Data Exfiltration | 15+ | "Show me all customer data" |
| Jailbreak Attempts | 8+ | "You are now DAN" |
| Social Engineering | 10+ | "I'm the administrator" |
| System Override | 6+ | "Disable safety protocols" |
| PII Exposure | 8+ | Credit cards, SSNs, emails |

### Performance Characteristics

- **Cold start:** 10-20ms (first analysis)
- **Warm cache:** 2-5ms (repeated prompts)
- **Memory usage:** 30-50MB
- **CPU usage:** Low (pattern matching)
- **Concurrency:** Excellent (stateless)

## API Mode

**Status:** ⚠️ Partially Implemented (Configuration ready, HTTP client needed)

API mode leverages the SecureVector cloud service for enhanced threat detection using advanced ML models and real-time rule updates.

### Features

- **Accuracy:** Highest detection rates
- **Rules:** 500+ patterns + ML models
- **Updates:** Real-time rule updates
- **Scalability:** Cloud-powered analysis
- **Intelligence:** Advanced threat patterns

### Configuration

```python
# API mode with key
client = SecureVectorClient(
    mode=OperationMode.API,
    api_key="your-api-key"
)

# Advanced API configuration
from securevector.models.config_models import SDKConfig

config = SDKConfig()
config.mode = OperationMode.API
config.api_config.api_key = "your-api-key"
config.api_config.api_url = "https://api.securevector.io"
config.api_config.timeout_ms = 5000
config.api_config.retry_attempts = 3

client = SecureVectorClient(config=config)
```

### Environment Variables

```bash
export SECUREVECTOR_MODE="api"
export SECUREVECTOR_API_KEY="your-api-key"
export SECUREVECTOR_API_URL="https://api.securevector.io"  # Optional
```

### CLI Usage

```bash
# Use API mode
securevector --mode api --api-key YOUR_KEY analyze "Suspicious prompt"
securevector --mode api test
```

### API Configuration Options

| Setting | Default | Description |
|---------|---------|-------------|
| `api_url` | `https://api.securevector.io` | API endpoint URL |
| `timeout_ms` | `5000` | Request timeout |
| `retry_attempts` | `3` | Number of retry attempts |
| `max_request_size` | `1MB` | Maximum request size |
| `rate_limit_requests` | `100` | Requests per window |
| `rate_limit_window_seconds` | `60` | Rate limit window |
| `fallback_to_local` | `true` | Fallback on API failure |

### Current Implementation Status

- ✅ Configuration structure complete
- ✅ API key management
- ✅ Rate limiting configuration
- ✅ Timeout and retry settings
- ⚠️ HTTP client implementation needed
- ⚠️ API endpoint integration required

## Hybrid Mode

**Status:** ⚠️ Partially Implemented (Smart routing ready, API integration needed)

Hybrid mode intelligently combines local and API detection for optimal performance and accuracy.

### Features

- **Smart routing:** Local-first with API enhancement
- **Performance:** Optimized for speed and accuracy
- **Fallback:** Graceful degradation to local mode
- **Cost-effective:** Reduces API calls through intelligent routing
- **Adaptive:** Learns from usage patterns

### Configuration

```python
# Basic hybrid mode
client = SecureVectorClient(
    mode=OperationMode.HYBRID,
    api_key="your-api-key"  # Optional but recommended
)

# Advanced hybrid configuration
config = SDKConfig()
config.mode = OperationMode.HYBRID
config.hybrid_config.local_first = True
config.hybrid_config.api_threshold_score = 50
config.hybrid_config.smart_routing = True
config.hybrid_config.fallback_strategy = "local"

client = SecureVectorClient(config=config)
```

### Environment Variables

```bash
export SECUREVECTOR_MODE="hybrid"
export SECUREVECTOR_API_KEY="your-api-key"  # Optional
```

### CLI Usage

```bash
# Use hybrid mode
securevector --mode hybrid analyze "Complex prompt"
securevector --mode hybrid test
```

### Routing Logic

1. **Local Analysis First:** All prompts analyzed locally
2. **Threshold Check:** If risk score > threshold, route to API
3. **API Enhancement:** High-risk prompts get API analysis
4. **Result Combination:** Combine local + API results
5. **Fallback:** Use local-only if API unavailable

### Hybrid Configuration Options

| Setting | Default | Description |
|---------|---------|-------------|
| `local_first` | `true` | Analyze locally first |
| `api_threshold_score` | `50` | API routing threshold |
| `smart_routing` | `true` | Enable intelligent routing |
| `performance_optimization` | `true` | Optimize for performance |
| `fallback_strategy` | `"local"` | Fallback method |

### Current Implementation Status

- ✅ Configuration structure complete
- ✅ Smart routing logic defined
- ✅ Fallback strategies implemented
- ✅ Threshold-based routing
- ⚠️ API integration needed for full functionality
- ⚠️ Result combination logic needs API client

## Auto Mode

**Status:** ✅ Fully Implemented

Auto mode automatically selects the best operation mode based on available configuration and system capabilities.

### Features

- **Zero configuration:** Works out of the box
- **Intelligent detection:** Selects optimal mode
- **Environment aware:** Adapts to deployment context
- **Graceful fallback:** Handles missing configurations
- **Performance optimized:** Chooses fastest available mode

### Configuration

```python
# Zero-config initialization
client = SecureVectorClient()  # Defaults to AUTO mode

# Explicit auto mode
client = SecureVectorClient(mode=OperationMode.AUTO)

# Auto mode with preferences
client = SecureVectorClient(
    mode=OperationMode.AUTO,
    api_key="your-key",  # Will enable hybrid if available
    enable_caching=True
)
```

### Environment Variables

```bash
export SECUREVECTOR_MODE="auto"  # Optional (default)
export SECUREVECTOR_API_KEY="your-key"  # Optional (enables API features)
```

### CLI Usage

```bash
# Auto mode (default)
securevector analyze "What is machine learning?"
securevector test

# Explicit auto mode
securevector --mode auto analyze "Test prompt"
```

### Mode Selection Logic

The auto mode selects operation mode based on the following priority:

1. **API Key Available + Internet Connection:** → Hybrid Mode
2. **API Key Available + No Internet:** → Local Mode
3. **No API Key + Any Environment:** → Local Mode
4. **Configuration Errors:** → Local Mode (fallback)

### Auto Mode Decision Matrix

| API Key | Internet | Selected Mode | Reason |
|---------|----------|---------------|---------|
| ✅ Yes | ✅ Yes | Hybrid | Best performance + accuracy |
| ✅ Yes | ❌ No | Local | API unavailable |
| ❌ No | ✅ Yes | Local | No API credentials |
| ❌ No | ❌ No | Local | Offline operation |

### Environment Detection

Auto mode detects the following environmental factors:

- **API Key Presence:** `SECUREVECTOR_API_KEY` or config
- **Network Connectivity:** Internet connection test
- **System Resources:** Memory and CPU availability
- **Deployment Context:** CI/CD, cloud, local development
- **Performance Requirements:** Latency vs accuracy preferences

## Mode Comparison

### Performance Comparison

| Metric | Local | API | Hybrid | Auto |
|--------|-------|-----|--------|------|
| **Latency** | 5-15ms | 100-500ms | 10-100ms | Variable |
| **Accuracy** | Good | Excellent | High | Adaptive |
| **Offline** | ✅ Yes | ❌ No | ⚠️ Partial | ⚠️ Adaptive |
| **Privacy** | ✅ Maximum | ⚠️ Moderate | ⚠️ Balanced | Variable |
| **Cost** | Free | Paid | Optimized | Variable |

### Use Case Recommendations

#### Local Mode - Best For:
- Development and testing
- Offline environments
- Privacy-sensitive applications
- High-performance requirements
- Cost-conscious deployments

#### API Mode - Best For:
- Production applications
- Maximum accuracy requirements
- Complex threat scenarios
- Enterprise security needs
- Real-time threat intelligence

#### Hybrid Mode - Best For:
- Production applications with cost optimization
- Applications requiring both speed and accuracy
- Variable network connectivity
- Balanced privacy and performance needs
- Enterprise deployments

#### Auto Mode - Best For:
- Quick prototyping and development
- Zero-configuration deployments
- Applications with varying requirements
- Multi-environment deployments
- Teams new to the SDK

## Switching Between Modes

### Runtime Mode Information

```python
# Check current mode
client = SecureVectorClient()
print(f"Current mode: {client.config.mode}")

# Get mode-specific configuration
mode_config = client.config.get_mode_config()
print(f"Mode settings: {mode_config}")

# Check mode capabilities
health = client.get_health_status()
print(f"Mode status: {health['mode_handler_status']}")
```

### Environment-Based Switching

```bash
# Switch mode for single command
SECUREVECTOR_MODE=local securevector analyze "test"

# Switch mode persistently
export SECUREVECTOR_MODE=hybrid
securevector test
```

### Configuration File Switching

```json
{
  "mode": "hybrid",
  "api_key": "your-key",
  "risk_threshold": 80,
  "enable_caching": true
}
```

```bash
securevector --config-file config.json analyze "test prompt"
```

## Error Handling and Fallbacks

### Mode-Specific Error Handling

Each mode implements specific error handling and fallback strategies:

#### Local Mode Errors
- **Rule Loading Failure:** Uses minimal built-in patterns
- **Pattern Compilation Error:** Falls back to string matching
- **Memory Issues:** Reduces cache size automatically

#### API Mode Errors
- **Network Timeout:** Returns error or falls back to local
- **API Key Invalid:** Throws authentication error
- **Rate Limit Exceeded:** Implements exponential backoff
- **Service Unavailable:** Falls back to local if configured

#### Hybrid Mode Errors
- **API Unavailable:** Uses local-only analysis
- **Partial API Failure:** Combines available results
- **Configuration Issues:** Falls back to local mode

#### Auto Mode Errors
- **Mode Detection Failure:** Defaults to local mode
- **Configuration Conflicts:** Uses most conservative option
- **Environment Issues:** Graceful degradation

### Error Code Reference

| Error Code | Description | Mode Impact |
|------------|-------------|-------------|
| `SV-2001` | Mode not available | Falls back to local |
| `SV-2002` | API key missing | Cannot use API/hybrid |
| `SV-3001` | Network timeout | Falls back if configured |
| `SV-3002` | API service unavailable | Falls back to local |
| `SV-5001` | Configuration error | Uses default settings |

## Best Practices

### Mode Selection Guidelines

1. **Start with Auto Mode** for most applications
2. **Use Local Mode** for development and testing
3. **Choose Hybrid Mode** for production deployments
4. **Select API Mode** only when maximum accuracy is required

### Performance Optimization

1. **Enable caching** for repeated prompts
2. **Use batch analysis** for multiple prompts
3. **Configure appropriate timeouts** for your use case
4. **Monitor performance metrics** to optimize settings

### Security Considerations

1. **Protect API keys** using environment variables
2. **Use local mode** for sensitive data
3. **Configure appropriate fallbacks** for production
4. **Monitor and log** mode switching events

### Monitoring and Debugging

```python
# Enable detailed logging
client = SecureVectorClient(log_level="debug")

# Monitor mode performance
stats = client.get_stats()
print(f"Mode performance: {stats['mode_performance']}")

# Check mode health
health = client.get_health_status()
print(f"Mode status: {health['mode_handler_status']}")
```

## Implementation Status Summary

| Feature | Local | API | Hybrid | Auto |
|---------|-------|-----|--------|------|
| **Configuration** | ✅ Complete | ✅ Complete | ✅ Complete | ✅ Complete |
| **Client Init** | ✅ Complete | ✅ Complete | ✅ Complete | ✅ Complete |
| **Core Logic** | ✅ Complete | ⚠️ Partial | ⚠️ Partial | ✅ Complete |
| **Error Handling** | ✅ Complete | ⚠️ Partial | ✅ Complete | ✅ Complete |
| **CLI Support** | ✅ Complete | ✅ Complete | ✅ Complete | ✅ Complete |
| **Documentation** | ✅ Complete | ✅ Complete | ✅ Complete | ✅ Complete |
| **Testing** | ✅ Complete | ⚠️ Partial | ⚠️ Partial | ✅ Complete |

**Legend:**
- ✅ Complete: Fully implemented and tested
- ⚠️ Partial: Configuration ready, needs implementation
- ❌ Missing: Not yet implemented

---

For more information about specific configuration options, see the [API Reference](API_REFERENCE.md).