# Testing Guide

This guide covers how to run tests, contribute new tests, and understand the testing framework for SecureVector AI Threat Monitor.

## 🚀 Quick Start

### Running All Tests

```bash
# Install test dependencies (if not already installed)
pip install pytest pytest-cov pyyaml

# Run all tests
pytest tests/ -v

# Run with coverage report
pytest tests/ -v --cov=. --cov-report=html
```

### Running Specific Tests

```bash
# Test CLI functionality
pytest tests/test_cli.py -v

# Test threat patterns
pytest tests/test_patterns.py -v

# Test decorator functionality  
pytest tests/test_decorator.py -v
```

## 📁 Test Structure

```
tests/
├── conftest.py              # pytest configuration and fixtures
├── test_cli.py              # CLI command testing
├── test_patterns.py         # Threat pattern validation
├── test_decorator.py        # @secure_ai_call decorator tests
└── fixtures/
    ├── threats.json         # Malicious prompt examples
    └── safe.json            # Benign prompt examples
```

## 🧪 Test Categories

### 1. CLI Tests (`test_cli.py`)

Tests the command-line interface functionality:

- **Command execution**: `test`, `status`, `signup` commands
- **Version flag**: `--version` output
- **Error handling**: Invalid commands
- **Integration**: CLI with real security engine

Example:
```bash
pytest tests/test_cli.py::TestCLICommands::test_cli_test_command -v
```

### 2. Pattern Tests (`test_patterns.py`)

Validates threat detection accuracy:

- **Malicious prompts**: Should be detected as threats (risk ≥ 70)
- **Safe prompts**: Should not be flagged (risk < 70)
- **Pattern variations**: Case insensitive, different phrasings
- **Performance**: Analysis time < 50ms
- **Caching**: Repeated prompts are faster

Example:
```bash
pytest tests/test_patterns.py::TestThreatPatterns::test_malicious_prompts_detected -v
```

### 3. Decorator Tests (`test_decorator.py`)

Tests the `@secure_ai_call` decorator:

- **Threat blocking**: Malicious prompts raise `SecurityException`
- **Safe pass-through**: Benign prompts proceed normally
- **Custom thresholds**: Configurable risk levels
- **Prompt extraction**: From args and kwargs
- **Integration**: With real security engine

Example:
```bash
pytest tests/test_decorator.py::TestSecureAICallDecorator::test_decorator_blocks_malicious_prompts -v
```

## 📊 Test Fixtures

### Threat Fixtures (`fixtures/threats.json`)

Contains realistic malicious prompts organized by category:

```json
{
  "prompt_injection": [
    {
      "prompt": "Ignore all previous instructions...",
      "expected_risk": 92,
      "description": "Classic ignore instructions attack"
    }
  ],
  "data_extraction": [...],
  "jailbreak_attempts": [...],
  "social_engineering": [...]
}
```

### Safe Fixtures (`fixtures/safe.json`)

Contains benign prompts that should not trigger threats:

```json
{
  "general_questions": [
    {
      "prompt": "What is the weather like today?",
      "expected_risk": 0,
      "description": "Basic weather question"
    }
  ],
  "business_questions": [...],
  "creative_requests": [...]
}
```

## 🔧 Contributing Tests

### Adding New Threat Patterns

1. **Update fixtures**: Add new malicious prompts to `fixtures/threats.json`
2. **Test the pattern**: Ensure it's detected with appropriate risk score
3. **Add edge cases**: Test variations and boundary conditions

Example:
```python
def test_new_attack_pattern(self, security_engine):
    """Test detection of a new attack pattern."""
    malicious_prompt = "Your new attack example"
    result = security_engine.analyze_prompt(malicious_prompt)
    
    assert result.is_threat, f"Failed to detect: {malicious_prompt}"
    assert result.risk_score >= 70, "Risk score too low"
```

### Adding Safe Prompts

1. **Update fixtures**: Add new benign prompts to `fixtures/safe.json`
2. **Test non-detection**: Ensure they don't trigger false positives
3. **Cover edge cases**: Different topics, phrasings, lengths

### Writing Custom Tests

Follow these patterns:

```python
def test_your_feature(self, security_engine, malicious_prompts):
    """Test your specific feature."""
    # Arrange
    test_input = "your test data"
    
    # Act
    result = security_engine.analyze_prompt(test_input)
    
    # Assert
    assert result.is_threat == expected_value
    assert result.risk_score >= expected_threshold
```

## ⚡ Performance Testing

### Timing Tests

Tests ensure analysis completes quickly:

```python
def test_analysis_performance(self, security_engine):
    """Ensure analysis is fast."""
    import time
    
    start_time = time.time()
    result = security_engine.analyze_prompt("test prompt")
    analysis_time = (time.time() - start_time) * 1000
    
    assert analysis_time < 50, f"Too slow: {analysis_time:.2f}ms"
```

### Caching Tests

Validate that repeated prompts are cached:

```python
def test_caching_effectiveness(self, security_engine):
    """Test caching improves performance."""
    prompt = "What is AI?"
    
    # First call (no cache)
    start = time.time()
    result1 = security_engine.analyze_prompt(prompt)
    first_time = (time.time() - start) * 1000
    
    # Second call (cached)
    start = time.time()
    result2 = security_engine.analyze_prompt(prompt)
    second_time = (time.time() - start) * 1000
    
    assert second_time <= first_time + 5, "Caching ineffective"
```

## 🎯 Test Coverage

### Current Coverage Areas

- ✅ **CLI commands** (test, status, signup)
- ✅ **Threat detection** (all 4 categories)
- ✅ **Safe prompt handling** (no false positives)
- ✅ **Decorator integration** (blocking, pass-through)
- ✅ **Performance** (analysis time, caching)
- ✅ **Error handling** (invalid inputs, edge cases)

### Coverage Goals

- **Lines**: >90% code coverage
- **Patterns**: 100% of YAML rules tested
- **CLI**: All commands and flags covered
- **Decorator**: All configuration options tested

### Running Coverage

```bash
# Generate HTML coverage report
pytest tests/ --cov=. --cov-report=html

# View coverage in browser
open htmlcov/index.html
```

## 🐛 Debugging Tests

### Running Individual Tests

```bash
# Single test method
pytest tests/test_patterns.py::TestThreatPatterns::test_malicious_prompts_detected -v -s

# Single test class
pytest tests/test_cli.py::TestCLICommands -v

# With debug output
pytest tests/test_decorator.py -v -s --tb=long
```

### Common Issues

1. **Import errors**: Run tests from project root directory
2. **Fixture not found**: Check `conftest.py` for fixture definitions
3. **YAML loading errors**: Validate rule files with `python -c "import yaml; yaml.safe_load(open('rules/filename.yaml'))"`
4. **Timing failures**: Tests may be sensitive to system performance

### Debug Tips

```python
# Add debug prints (use -s flag)
def test_debug_example(self, security_engine):
    result = security_engine.analyze_prompt("test")
    print(f"Debug: risk_score={result.risk_score}")  # Shows with -s
    assert result.risk_score < 70
```

## 🔄 Continuous Integration

### GitHub Actions

Tests run automatically on:
- Push to main/master/develop branches
- Pull requests
- Multiple Python versions (3.7-3.11)

### CI Pipeline

1. **Setup**: Install Python and dependencies
2. **Validate**: Check YAML rule files
3. **Test**: Run pytest with coverage
4. **CLI**: Test command-line interface
5. **Lint**: Code style checks (flake8, black)
6. **Security**: Safety and bandit scans
7. **Demo**: Validate demo app imports
8. **Package**: Test package structure

### CI Configuration

See `.github/workflows/tests.yml` for complete CI configuration.

## 📝 Best Practices

### Test Writing

1. **Descriptive names**: `test_decorator_blocks_malicious_prompts_with_high_risk_score`
2. **Clear assertions**: Include failure messages
3. **Use fixtures**: Leverage `conftest.py` fixtures
4. **Test edge cases**: Empty strings, special characters, very long inputs
5. **Performance aware**: Include timing assertions where relevant

### Test Organization

1. **Group by functionality**: CLI, patterns, decorator
2. **Use test classes**: Organize related tests
3. **Logical flow**: Arrange tests from simple to complex
4. **Documentation**: Include docstrings explaining test purpose

### Maintenance

1. **Update fixtures**: Add new attack patterns as they emerge
2. **Review coverage**: Regularly check for untested code paths
3. **Performance monitoring**: Watch for regression in analysis speed
4. **Dependencies**: Keep test dependencies updated

This testing framework ensures SecureVector maintains high quality and security effectiveness as it evolves.