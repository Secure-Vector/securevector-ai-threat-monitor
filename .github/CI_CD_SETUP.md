# CI/CD Setup Guide

This document explains the CI/CD pipeline setup for the SecureVector AI Threat Monitor SDK.

## Overview

The CI/CD pipeline is built using GitHub Actions and includes:

1. **Code Quality Checks** (linting, formatting, type checking)
2. **Unit Tests** (across multiple Python versions)
3. **Benchmark Tests** (performance validation)
4. **Security Scanning** (dependency vulnerabilities, code security)
5. **Package Building** (wheel and source distributions)
6. **Publishing** (Test PyPI and PyPI)

## Workflows

### 1. Main CI/CD Pipeline (`ci-cd.yml`)

**Triggers:**
- Push to `main` or `develop` branches
- Pull requests to `main` or `develop`
- Release events

**Jobs:**
- `lint`: Code quality checks (black, flake8, isort, mypy)
- `test`: Unit tests across Python 3.7-3.11
- `benchmark`: Performance benchmarks
- `security`: Security scans (safety, bandit)
- `build`: Package building and validation
- `publish-test`: Publish to Test PyPI (develop branch only)
- `publish-pypi`: Publish to PyPI (releases only)
- `release`: Create GitHub releases

### 2. Release Pipeline (`release.yml`)

**Triggers:**
- GitHub releases (published)

**Purpose:**
- Build and publish to PyPI
- Upload artifacts to GitHub release

### 3. Test PyPI Pipeline (`test-pypi.yml`)

**Triggers:**
- Push to `develop` branch
- Manual workflow dispatch

**Purpose:**
- Test package building and publishing to Test PyPI
- Validate package installation

## Required Secrets

To enable full CI/CD functionality, configure these GitHub secrets:

### PyPI Publishing
```bash
# For production PyPI publishing
PYPI_API_TOKEN=pypi-your-token-here

# For test PyPI publishing  
TEST_PYPI_API_TOKEN=pypi-your-test-token-here
```

### API Keys (Optional)
```bash
# For API mode testing (optional)
SECUREVECTOR_API_KEY=your-api-key-here
```

## Setting Up Secrets

1. Go to your GitHub repository
2. Navigate to Settings → Secrets and variables → Actions
3. Click "New repository secret"
4. Add the required secrets listed above

## PyPI Setup (Placeholder Configuration)

Since PyPI organization is not set up yet, the workflows are configured with placeholders:

### Getting PyPI Tokens

1. **Create PyPI Account**: Register at [pypi.org](https://pypi.org)
2. **Create Test PyPI Account**: Register at [test.pypi.org](https://test.pypi.org)
3. **Generate API Tokens**:
   - Go to Account Settings → API tokens
   - Create a new token with appropriate scope
   - Copy the token (starts with `pypi-`)
4. **Add to GitHub Secrets** as described above

### Package Name

The package is configured as `securevector-ai-monitor`. Ensure this name is available on PyPI before first publish.

## Local Development

### Running Tests Locally

```bash
# Install development dependencies
pip install -e .[dev]

# Run all tests
pytest

# Run only unit tests (exclude benchmarks)
pytest -m "not benchmark"

# Run with coverage
pytest --cov=src --cov-report=html

# Run benchmarks
pytest -m benchmark
```

### Code Quality Checks

```bash
# Format code
black src/ tests/ benchmarks/ scripts/
isort src/ tests/ benchmarks/ scripts/

# Lint code
flake8 src/ tests/ benchmarks/ scripts/

# Type checking
mypy src/

# Security scan
bandit -r src/
safety check
```

### Building Package

```bash
# Install build tools
pip install build twine

# Build package
python -m build

# Check package
twine check dist/*

# Test upload to Test PyPI
twine upload --repository testpypi dist/*
```

## Performance Benchmarks

The CI includes performance benchmarks to ensure the SDK maintains good performance:

### Benchmark Thresholds

- **Response Time**: Average < 100ms, Max < 200ms
- **Memory Usage**: Increase < 100MB during processing
- **Concurrency**: 6 concurrent requests < 500ms total
- **Cache Performance**: > 2x speedup for cache hits

### Running Benchmarks

```bash
# CI-style benchmarks (lighter)
pytest tests/test_benchmarks.py

# Full benchmarks (comprehensive)
cd benchmarks
python performance_test.py
```

## Monitoring and Alerts

The CI/CD pipeline includes several monitoring features:

### Artifacts

- **Coverage Reports**: HTML coverage reports uploaded as artifacts
- **Benchmark Results**: Performance metrics stored as artifacts
- **Security Reports**: Safety and bandit scan results
- **Build Artifacts**: Wheel and source distributions

### Failure Handling

- **Soft Failures**: Some steps (like security scans) are configured to continue on error
- **Required Checks**: Core tests and builds must pass for merging
- **Retry Logic**: Built-in GitHub Actions retry for transient failures

## Deployment Strategy

### Branch Strategy

- **`main`**: Production-ready code
- **`develop`**: Integration branch for testing
- **Feature branches**: Individual feature development

### Release Process

1. **Development**: Work on feature branches
2. **Integration**: Merge to `develop` → triggers Test PyPI publish
3. **Release**: Create GitHub release → triggers PyPI publish
4. **Verification**: Automated tests validate deployment

### Version Management

- Version is defined in `src/ai_threat_monitor/__init__.py`
- Follows semantic versioning (MAJOR.MINOR.PATCH)
- GitHub releases should match version tags

## Troubleshooting

### Common Issues

1. **PyPI Token Issues**: Ensure tokens have correct permissions and aren't expired
2. **Package Name Conflicts**: Check if package name is available on PyPI
3. **Test Failures**: Check test logs and ensure all dependencies are installed
4. **Build Failures**: Verify setup.py and pyproject.toml configuration

### Debug Commands

```bash
# Test package installation locally
pip install dist/*.whl

# Verify package imports
python -c "import ai_threat_monitor; print(ai_threat_monitor.__version__)"

# Check package metadata
python -m pip show securevector-ai-monitor
```

## Security Considerations

- **API Keys**: Never commit API keys to repository
- **Secrets Management**: Use GitHub secrets for sensitive data
- **Dependency Scanning**: Automated security scans in CI
- **Code Analysis**: Static security analysis with bandit

## Contributing

When contributing to the project:

1. Ensure all tests pass locally
2. Run code quality checks
3. Add tests for new features
4. Update documentation as needed
5. Follow the established branching strategy

The CI/CD pipeline will automatically validate your changes and provide feedback through PR checks.

