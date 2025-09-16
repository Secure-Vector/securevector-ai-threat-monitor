# Claude Code Assistant Instructions

This file contains important instructions and commands for Claude Code when working on this project.

## Project Structure

This is the SecureVector AI Threat Monitor SDK - a Python package for detecting AI threats and prompt injections.

## Critical Pre-Publish Checks

Before declaring the package ready to publish, **ALWAYS** run these validation checks:

### 1. Import Structure Validation

**Test all critical imports work correctly:**

```bash
# Test main package imports
PYTHONPATH=src python3 -c "
try:
    from ai_threat_monitor import SecureVectorClient, AsyncSecureVectorClient
    from ai_threat_monitor.core.modes import APIMode, LocalMode, HybridMode, ModeFactory
    from ai_threat_monitor.models import AnalysisResult, ThreatDetection, DetectionMethod
    from ai_threat_monitor.models.config_models import SDKConfig, OperationMode
    from ai_threat_monitor.models.policy_models import SecurityPolicy
    from ai_threat_monitor.models.threat_types import ThreatType, RiskLevel
    from ai_threat_monitor.testing import MockSecureVectorClient, create_test_prompts
    from ai_threat_monitor.utils import get_logger, PerformanceTracker
    print('✅ All critical imports successful!')
except Exception as e:
    print(f'❌ Import failed: {e}')
    exit(1)
"
```

**Check for problematic relative import issues:**

```bash
# Search for problematic relative imports in top-level modules that should be absolute
echo "Checking for problematic relative imports..."

# Check main client files - these should use absolute imports
if grep -E "from \.\.(utils|models|core)" src/ai_threat_monitor/client.py src/ai_threat_monitor/async_client.py src/ai_threat_monitor/__init__.py 2>/dev/null; then
    echo "❌ Found problematic relative imports in main client files"
    echo "Main client files should use absolute imports like 'from ai_threat_monitor.models.analysis_result import ...'"
    exit 1
fi

# Check models directory - should not import from parent packages with relative imports
if grep -E "from \.\.(utils|core)" src/ai_threat_monitor/models/*.py 2>/dev/null; then
    echo "❌ Found problematic relative imports in models directory"
    echo "Models should use absolute imports like 'from ai_threat_monitor.utils.security import ...'"
    exit 1
fi

# Check testing directory - should not use relative imports to parent packages
if grep -E "from \.\.(models|utils|core)" src/ai_threat_monitor/testing/*.py 2>/dev/null; then
    echo "❌ Found problematic relative imports in testing directory"
    echo "Testing modules should use absolute imports like 'from ai_threat_monitor.models.analysis_result import ...'"
    exit 1
fi

echo "✅ No problematic relative imports found"
```

### 2. Package Installation Test

**Test package builds and installs correctly:**

```bash
# Clean previous builds
rm -rf build/ dist/ *.egg-info/

# Build the package
python setup.py sdist bdist_wheel

# Test install in clean environment (requires virtual environment)
pip install dist/*.whl --force-reinstall

# Test that installed package works
python -c "
try:
    import ai_threat_monitor
    client = ai_threat_monitor.SecureVectorClient()
    print('✅ Package installation test successful!')
except Exception as e:
    print(f'❌ Package installation test failed: {e}')
    exit(1)
"
```

### 3. Core Functionality Test

**Test basic functionality works:**

```bash
PYTHONPATH=src python3 -c "
try:
    from ai_threat_monitor import SecureVectorClient
    from ai_threat_monitor.models.config_models import OperationMode

    # Test client creation and basic analysis
    client = SecureVectorClient(mode=OperationMode.LOCAL)
    result = client.analyze('Hello, how are you?')

    assert hasattr(result, 'is_threat')
    assert hasattr(result, 'risk_score')
    assert hasattr(result, 'confidence')

    print('✅ Core functionality test successful!')
except Exception as e:
    print(f'❌ Core functionality test failed: {e}')
    exit(1)
"
```

### 4. Testing Module Validation

**Ensure testing utilities work:**

```bash
PYTHONPATH=src python3 -c "
try:
    from ai_threat_monitor.testing import MockSecureVectorClient, create_test_prompts, MockBehavior

    # Test mock client
    mock_client = MockSecureVectorClient()
    result = mock_client.analyze('test prompt')

    # Test fixtures
    prompts = create_test_prompts('safe', count=5)
    assert len(prompts) == 5

    print('✅ Testing module validation successful!')
except Exception as e:
    print(f'❌ Testing module validation failed: {e}')
    exit(1)
"
```

### 5. Linting and Type Checking

**Run code quality checks:**

```bash
# Check if these commands exist and run them
if command -v ruff &> /dev/null; then
    echo "Running ruff checks..."
    ruff check src/
elif command -v flake8 &> /dev/null; then
    echo "Running flake8 checks..."
    flake8 src/
else
    echo "⚠️  No linter found (ruff or flake8)"
fi

# Type checking
if command -v mypy &> /dev/null; then
    echo "Running mypy type checks..."
    mypy src/ai_threat_monitor/ --ignore-missing-imports
else
    echo "⚠️  mypy not found, skipping type checks"
fi
```

### 6. Test Suite Execution

**Run the full test suite:**

```bash
# Run tests with pytest if available
if command -v pytest &> /dev/null; then
    echo "Running test suite..."
    PYTHONPATH=src pytest tests/ -v --tb=short
elif [ -f "tests/test_client.py" ]; then
    echo "Running basic tests..."
    PYTHONPATH=src python3 -m pytest tests/ -v --tb=short
else
    echo "⚠️  No test runner found or tests directory missing"
fi
```

## Common Issues and Solutions

### Import Issues

1. **Relative vs Absolute Imports**: Always use absolute imports like `from ai_threat_monitor.models.analysis_result import AnalysisResult`
2. **Missing __init__.py**: Ensure all directories have `__init__.py` files
3. **Circular Imports**: Check for circular dependencies between modules

### Package Structure Issues

1. **Missing Dependencies**: Check that all required packages are in `requirements.txt` and `setup.py`
2. **File Permissions**: Ensure all files have correct permissions
3. **Binary Files**: Make sure no unwanted binary files are included

### Testing Issues

1. **Mock Dependencies**: Ensure all mocks are properly configured
2. **Test Data**: Verify test fixtures are available and valid
3. **Environment Variables**: Check if tests require specific environment setup

## Pre-Commit Checklist

Before any commit that might affect package publishing:

- [ ] All imports use absolute paths
- [ ] Package builds without errors
- [ ] Core functionality works
- [ ] Testing utilities work
- [ ] Linting passes (if available)
- [ ] Type checking passes (if available)
- [ ] Test suite passes (if available)
- [ ] No sensitive data in code
- [ ] Version number updated if needed

## Quick Validation Command

Run this single command to perform most critical checks:

```bash
# Comprehensive pre-publish validation
echo "🔍 Running comprehensive pre-publish validation..."

echo "1. Testing critical imports..."
PYTHONPATH=src python3 -c "
from ai_threat_monitor import SecureVectorClient, AsyncSecureVectorClient
from ai_threat_monitor.core.modes import APIMode, LocalMode, HybridMode
from ai_threat_monitor.models import AnalysisResult, ThreatDetection
from ai_threat_monitor.testing import MockSecureVectorClient, create_test_prompts
print('✅ Imports successful')
"

echo "2. Testing basic functionality..."
PYTHONPATH=src python3 -c "
from ai_threat_monitor import SecureVectorClient
client = SecureVectorClient()
result = client.analyze('Hello world')
assert hasattr(result, 'is_threat')
print('✅ Basic functionality works')
"

echo "3. Checking for problematic relative imports..."

# Check main client files - these should use absolute imports
if grep -E "from \.\.(utils|models|core)" src/ai_threat_monitor/client.py src/ai_threat_monitor/async_client.py src/ai_threat_monitor/__init__.py 2>/dev/null; then
    echo "❌ Found problematic relative imports in main client files"
    exit 1
fi

# Check models and testing directories - should not use relative imports to parent packages
if grep -E "from \.\.(utils|core|models)" src/ai_threat_monitor/models/*.py src/ai_threat_monitor/testing/*.py 2>/dev/null; then
    echo "❌ Found problematic relative imports in models/testing directories"
    exit 1
fi

echo "✅ No problematic relative imports found"

echo "🎉 Pre-publish validation completed successfully!"
```

## Notes

- Always run the pre-publish checks before declaring a package ready
- If any check fails, investigate and fix before proceeding
- Consider adding more specific tests based on recent issues encountered
- Update this file when new validation requirements are identified