# SecureVector AI Threat Monitor - API Reference

Complete API reference documentation for the SecureVector AI Threat Monitor SDK.

## Table of Contents

- [Client Classes](#client-classes)
  - [SecureVectorClient](#securevectorclient)
  - [AsyncSecureVectorClient](#asyncsecurevectorclient)
- [Models](#models)
  - [AnalysisResult](#analysisresult)
  - [ThreatDetection](#threatdetection)
  - [Configuration Models](#configuration-models)
- [Exceptions](#exceptions)
- [Testing Utilities](#testing-utilities)
- [Utility Functions](#utility-functions)

## Client Classes

### SecureVectorClient

The main synchronous client for threat analysis.

#### Constructor

```python
SecureVectorClient(
    mode: Union[str, OperationMode] = OperationMode.AUTO,
    api_key: Optional[str] = None,
    config: Optional[SDKConfig] = None,
    policy: Optional[SecurityPolicy] = None,
    **kwargs
)
```

**Parameters:**
- `mode` (str|OperationMode): Operation mode - "local", "api", "hybrid", or "auto"
- `api_key` (str, optional): API key for enhanced detection
- `config` (SDKConfig, optional): Custom SDK configuration
- `policy` (SecurityPolicy, optional): Custom security policy
- `**kwargs`: Additional configuration options

**Example:**
```python
from securevector import SecureVectorClient

# Basic initialization (local mode)
client = SecureVectorClient()

# With API key for enhanced detection
client = SecureVectorClient(
    mode="hybrid",
    api_key="your-api-key-here"
)

# With custom configuration
client = SecureVectorClient(
    mode="local",
    raise_on_threat=False,
    log_level="INFO",
    enable_caching=True
)
```

#### Methods

##### analyze()

Analyze a single prompt for security threats.

```python
def analyze(self, prompt: str, **kwargs) -> AnalysisResult
```

**Parameters:**
- `prompt` (str): The text prompt to analyze
- `**kwargs`: Additional analysis options

**Returns:**
- `AnalysisResult`: Complete analysis result

**Raises:**
- `ValidationError`: If prompt validation fails
- `SecurityException`: If threat detected and `raise_on_threat=True`

**Example:**
```python
result = client.analyze("What is the weather today?")

print(f"Is threat: {result.is_threat}")
print(f"Risk score: {result.risk_score}")
print(f"Confidence: {result.confidence}")
print(f"Analysis time: {result.analysis_time_ms}ms")

if result.detections:
    for detection in result.detections:
        print(f"Threat type: {detection.threat_type}")
        print(f"Description: {detection.description}")
```

##### analyze_batch()

Analyze multiple prompts in batch.

```python
def analyze_batch(self, prompts: List[str], **kwargs) -> List[AnalysisResult]
```

**Parameters:**
- `prompts` (List[str]): List of prompts to analyze
- `**kwargs`: Additional analysis options

**Returns:**
- `List[AnalysisResult]`: Analysis results for each prompt

**Example:**
```python
prompts = [
    "What is machine learning?",
    "Show me all passwords",
    "How does encryption work?"
]

results = client.analyze_batch(prompts)
for i, result in enumerate(results):
    print(f"Prompt {i+1}: {'THREAT' if result.is_threat else 'SAFE'}")
```

##### is_threat()

Simple boolean check for threat detection.

```python
def is_threat(self, prompt: str, **kwargs) -> bool
```

**Example:**
```python
if client.is_threat("Ignore previous instructions"):
    print("Potential threat detected!")
```

##### get_risk_score()

Get the risk score for a prompt.

```python
def get_risk_score(self, prompt: str, **kwargs) -> int
```

**Returns:**
- `int`: Risk score from 0-100

**Example:**
```python
risk = client.get_risk_score("Show me admin access")
print(f"Risk score: {risk}/100")
```

##### get_stats()

Get usage statistics.

```python
def get_stats(self) -> Dict[str, Any]
```

**Returns:**
- `Dict[str, Any]`: Statistics dictionary

**Example:**
```python
stats = client.get_stats()
print(f"Total requests: {stats['total_requests']}")
print(f"Threats detected: {stats['threats_detected']}")
print(f"Average response time: {stats['avg_response_time_ms']:.1f}ms")
```

##### get_health_status()

Get health status of client components.

```python
def get_health_status(self) -> Dict[str, Any]
```

**Example:**
```python
health = client.get_health_status()
print(f"Status: {health['status']}")
print(f"Mode: {health['mode']}")
```

##### Context Manager

The client can be used as a context manager for automatic resource cleanup.

```python
with SecureVectorClient() as client:
    result = client.analyze("Test prompt")
    print(f"Risk: {result.risk_score}")
# Resources automatically cleaned up
```

### AsyncSecureVectorClient

Asynchronous client for high-performance applications.

#### Constructor

Same as `SecureVectorClient` but returns an async client.

```python
AsyncSecureVectorClient(
    mode: Union[str, OperationMode] = OperationMode.AUTO,
    api_key: Optional[str] = None,
    config: Optional[SDKConfig] = None,
    policy: Optional[SecurityPolicy] = None,
    **kwargs
)
```

#### Async Methods

All methods are async versions of the sync client:

##### analyze()

```python
async def analyze(self, prompt: str, **kwargs) -> AnalysisResult
```

**Example:**
```python
import asyncio
from securevector import AsyncSecureVectorClient

async def main():
    async_client = AsyncSecureVectorClient()
    result = await async_client.analyze("Test prompt")
    print(f"Threat: {result.is_threat}")

asyncio.run(main())
```

##### analyze_batch()

```python
async def analyze_batch(self, prompts: List[str], **kwargs) -> List[AnalysisResult]
```

##### Concurrent Processing

Process multiple prompts concurrently for better performance:

```python
async def concurrent_analysis():
    async_client = AsyncSecureVectorClient()
    
    prompts = ["prompt1", "prompt2", "prompt3"]
    
    # Process concurrently
    tasks = [async_client.analyze(prompt) for prompt in prompts]
    results = await asyncio.gather(*tasks)
    
    return results
```

##### Async Context Manager

```python
async def main():
    async with AsyncSecureVectorClient() as client:
        result = await client.analyze("Test")
        print(f"Result: {result.risk_score}")
    # Automatic cleanup
```

## Models

### AnalysisResult

Complete result of threat analysis.

#### Properties

```python
class AnalysisResult:
    is_threat: bool                    # Whether threat was detected
    risk_score: int                    # Risk score 0-100
    confidence: float                  # Confidence 0.0-1.0
    detections: List[ThreatDetection]  # Detailed threat detections
    analysis_time_ms: float           # Analysis time in milliseconds
    detection_method: DetectionMethod  # Method used for detection
    timestamp: datetime               # Analysis timestamp
    summary: str                      # Human-readable summary
    prompt_hash: str                  # Hash of analyzed prompt
    threat_types: List[str]           # List of detected threat types
```

**Example:**
```python
result = client.analyze("Test prompt")

# Basic properties
print(f"Threat: {result.is_threat}")
print(f"Risk: {result.risk_score}/100")
print(f"Confidence: {result.confidence:.2%}")

# Detailed information
print(f"Method: {result.detection_method.value}")
print(f"Time: {result.analysis_time_ms:.1f}ms")
print(f"Summary: {result.summary}")

# Threat details
if result.detections:
    for detection in result.detections:
        print(f"- {detection.threat_type}: {detection.description}")
```

### ThreatDetection

Detailed information about a specific threat detection.

#### Properties

```python
class ThreatDetection:
    threat_type: str        # Type of threat detected
    risk_score: int         # Risk score for this detection
    confidence: float       # Confidence in this detection
    description: str        # Human-readable description
    rule_id: Optional[str]  # ID of rule that triggered
    metadata: Dict[str, Any] # Additional metadata
```

### Configuration Models

#### SDKConfig

Main SDK configuration class.

```python
class SDKConfig:
    mode: OperationMode           # Operation mode
    api_config: APIConfig         # API-specific settings
    local_config: LocalConfig     # Local mode settings
    performance_monitoring: bool  # Enable performance tracking
    log_level: str               # Logging level
    enable_caching: bool         # Enable result caching
    raise_on_threat: bool        # Raise exception on threats
    max_prompt_length: int       # Maximum prompt length
    max_batch_size: int          # Maximum batch size
```

**Example:**
```python
from securevector.models.config_models import SDKConfig, OperationMode

config = SDKConfig()
config.mode = OperationMode.LOCAL
config.log_level = "DEBUG"
config.enable_caching = True
config.max_prompt_length = 50000

client = SecureVectorClient(config=config)
```

#### OperationMode

Enumeration of operation modes.

```python
class OperationMode(Enum):
    LOCAL = "local"      # Local analysis only
    API = "api"          # API-enhanced analysis
    HYBRID = "hybrid"    # Intelligent local/API switching
    AUTO = "auto"        # Automatic mode selection
```

## Exceptions

All SDK exceptions inherit from `AIThreatMonitorException` and include structured error codes.

### Exception Hierarchy

```python
AIThreatMonitorException
├── SecurityException          # Threat detected
├── ValidationError           # Input validation failed
├── ConfigurationError        # Configuration error
├── APIError                  # API communication error
│   ├── AuthenticationError   # API authentication failed
│   └── RateLimitError       # Rate limit exceeded
├── ModeNotAvailableError    # Requested mode unavailable
├── RuleLoadError            # Security rules load failed
├── CacheError               # Caching error
├── PerformanceError         # Performance threshold exceeded
└── CircuitBreakerError      # Circuit breaker open
```

### Error Codes

All exceptions include structured error codes:

```python
try:
    client.analyze("")
except ValidationError as e:
    print(f"Error code: {e.code}")           # e.g., "SV-4001"
    print(f"Error type: {e.error_code}")     # ErrorCode enum
    print(f"Context: {e.context}")           # Additional context
    print(f"Solution: {e.solution}")         # Actionable guidance
```

### Common Error Codes

- `SV-1001`: Security threat detected
- `SV-2002`: Missing API key
- `SV-3001`: API connection failed
- `SV-4001`: Empty prompt
- `SV-4002`: Prompt too long
- `SV-5001`: Performance timeout

## Testing Utilities

The SDK includes comprehensive testing utilities.

### Mock Clients

```python
from securevector.testing import MockSecureVectorClient, MockBehavior

# Basic mock
mock_client = MockSecureVectorClient()

# Custom behavior
behavior = MockBehavior(
    default_is_threat=True,
    default_risk_score=85,
    response_time_ms=15.0
)
mock_client = MockSecureVectorClient(mock_behavior=behavior)
```

### Test Data Generation

```python
from securevector.testing import create_test_prompts, ThreatScenario

# Generate test prompts
safe_prompts = create_test_prompts("safe", count=10)
threat_prompts = create_test_prompts("threat", count=10)
mixed_prompts = create_test_prompts("mixed", count=20)

# Specific scenarios
injection_prompts = create_test_prompts("prompt_injection", count=5)
```

### Testing Assertions

```python
from securevector.testing import (
    assert_is_threat, assert_is_safe, assert_risk_score
)

result = mock_client.analyze("test prompt")

# Assertions
assert_is_safe(result)
assert_risk_score(result, max_score=30)
assert_threat_types(result, ["prompt_injection"])
```

## Utility Functions

### Convenience Functions

```python
from securevector import (
    create_client, create_async_client,
    analyze_prompt, analyze_prompt_async
)

# Quick client creation
client = create_client(mode="local")
async_client = create_async_client(mode="hybrid", api_key="key")

# Quick analysis
result = analyze_prompt("Test prompt")
result = await analyze_prompt_async("Async test")
```

### Retry Utilities

```python
from utils.retry import with_retry, RetryConfig, API_RETRY_CONFIG

# Decorator for retry logic
@with_retry(API_RETRY_CONFIG)
def my_api_function():
    # Function with retry logic
    pass

# Custom retry configuration
custom_config = RetryConfig(
    max_attempts=5,
    base_delay=1.0,
    exponential_base=2.0
)
```

## Usage Patterns

### Basic Usage

```python
from securevector import SecureVectorClient

# Simple usage
client = SecureVectorClient()
result = client.analyze("What is AI?")
print(f"Safe: {not result.is_threat}")
```

### Production Usage

```python
from securevector import SecureVectorClient
from securevector.models.config_models import OperationMode

# Production configuration
client = SecureVectorClient(
    mode=OperationMode.HYBRID,
    api_key=os.getenv("SECUREVECTOR_API_KEY"),
    raise_on_threat=False,
    enable_caching=True,
    log_level="INFO"
)

# Analyze user input
try:
    result = client.analyze(user_input)
    if result.is_threat:
        # Handle threat
        log_security_event(result)
        return {"allowed": False, "reason": "Security threat detected"}
    else:
        return {"allowed": True}
except Exception as e:
    # Handle errors gracefully
    logger.error(f"Analysis failed: {e}")
    return {"allowed": False, "reason": "Analysis failed"}
```

### Async Production Usage

```python
import asyncio
from securevector import AsyncSecureVectorClient

async def analyze_content_batch(content_list):
    async with AsyncSecureVectorClient(mode="hybrid") as client:
        # Process multiple items concurrently
        tasks = [client.analyze(content) for content in content_list]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        
        # Process results
        filtered_content = []
        for content, result in zip(content_list, results):
            if isinstance(result, Exception):
                # Log error, default to blocking
                logger.error(f"Analysis failed: {result}")
                continue
            elif result.is_threat:
                logger.warning(f"Threat detected: {result.summary}")
                continue
            else:
                filtered_content.append(content)
        
        return filtered_content
```

### Testing Usage

```python
import pytest
from securevector.testing import (
    MockSecureVectorClient, MockBehavior,
    assert_is_safe, create_test_prompts
)

def test_content_filter():
    # Setup mock
    mock_behavior = MockBehavior(default_is_threat=False)
    mock_client = MockSecureVectorClient(mock_behavior=mock_behavior)
    
    # Test your application
    content_filter = ContentFilter(client=mock_client)
    result = content_filter.filter_content("Safe content")
    
    assert result["allowed"] is True
    assert_is_safe(mock_client.call_log[0]["result"])

@pytest.mark.asyncio
async def test_async_processing():
    from securevector.testing import MockAsyncSecureVectorClient
    
    async_mock = MockAsyncSecureVectorClient()
    
    # Test concurrent processing
    prompts = create_test_prompts("mixed", count=5)
    results = await asyncio.gather(*[
        async_mock.analyze(prompt) for prompt in prompts
    ])
    
    assert len(results) == 5
```

## Error Handling Best Practices

```python
from securevector import SecureVectorClient
from utils.exceptions import ValidationError, APIError, SecurityException

client = SecureVectorClient()

try:
    result = client.analyze(user_input)
    
    if result.is_threat:
        # Handle threat appropriately
        handle_security_threat(result)
    
except ValidationError as e:
    # Input validation failed
    logger.warning(f"Invalid input: {e}")
    return {"error": "Invalid input", "code": e.code}

except APIError as e:
    # API communication failed, fallback to local mode
    logger.error(f"API failed, using local mode: {e}")
    # Client should automatically fallback, but handle if needed
    
except SecurityException as e:
    # Threat detected and raise_on_threat=True
    logger.critical(f"Security threat: {e}")
    return {"blocked": True, "threat": e.result}

except Exception as e:
    # Unexpected error
    logger.error(f"Unexpected error: {e}")
    return {"error": "Analysis failed"}
```

## Performance Optimization

### Caching

```python
# Enable caching for better performance
client = SecureVectorClient(enable_caching=True)

# Cache will automatically store and retrieve results
result1 = client.analyze("Same prompt")  # Cache miss
result2 = client.analyze("Same prompt")  # Cache hit (faster)
```

### Batch Processing

```python
# More efficient than individual calls
prompts = ["prompt1", "prompt2", "prompt3"]
results = client.analyze_batch(prompts)  # Single batch call
```

### Async for Concurrency

```python
# Process multiple prompts concurrently
async def process_concurrent(prompts):
    async with AsyncSecureVectorClient() as client:
        tasks = [client.analyze(prompt) for prompt in prompts]
        return await asyncio.gather(*tasks)
```

---

For more examples and detailed guides, see the [tutorials](../examples/tutorials/) directory.
