# Development Installation Guide (Internal)

**⚠️ This document is for SecureVector developers only. Do not share publicly.**

## Installing Development Builds from Test PyPI

### The Test PyPI Installation Issue

When installing development versions from Test PyPI, you **must** use `--extra-index-url` to allow pip to fetch dependencies from the main PyPI repository.

### Common Error

**You will see this error without the correct flags:**
```
ERROR: Could not find a version that satisfies the requirement httpx>=0.28.1 (from fastmcp)
ERROR: No matching distribution found for httpx>=0.28.1
```

**Why this happens:**
- Test PyPI only hosts the development package (`securevector-ai-monitor-dev`)
- Dependencies like `httpx`, `fastmcp`, `mcp`, etc. are hosted on the main PyPI
- Without `--extra-index-url`, pip can't find these dependencies

### ✅ Correct Installation Commands

**Basic installation from Test PyPI:**
```bash
pip install --index-url https://test.pypi.org/simple/ \
            --extra-index-url https://pypi.org/simple/ \
            securevector-ai-monitor-dev
```

**With MCP support:**
```bash
pip install --index-url https://test.pypi.org/simple/ \
            --extra-index-url https://pypi.org/simple/ \
            securevector-ai-monitor-dev[mcp]
```

**With all features:**
```bash
pip install --index-url https://test.pypi.org/simple/ \
            --extra-index-url https://pypi.org/simple/ \
            securevector-ai-monitor-dev[all]
```

### Understanding the Flags

- `--index-url https://test.pypi.org/simple/` - Primary source for the package
- `--extra-index-url https://pypi.org/simple/` - Fallback for dependencies

This tells pip to:
1. First look for packages on Test PyPI
2. If not found, fall back to the main PyPI
3. This allows the dev package to come from Test PyPI while dependencies come from main PyPI

### Verifying Development Installation

```python
from securevector import SecureVectorClient

# Should show "dev" in version for test builds
import securevector
print(f"Version: {securevector.__version__}")

# Create a client
client = SecureVectorClient()

# Verify it works
result = client.analyze("Hello, how are you?")
print(f"Is threat: {result.is_threat}")
print(f"Risk score: {result.risk_score}")
```

### Development Build Differences

Development builds from Test PyPI have:
1. Version suffix with timestamp: `1.0.0.dev20251124184715`
2. Package name: `securevector-ai-monitor-dev` (instead of `securevector-ai-monitor`)
3. API URL automatically set to development endpoint (`scandev.securevector.io`)

### Testing After Build

After a new development build is published:

1. **Uninstall old versions:**
   ```bash
   pip uninstall securevector-ai-monitor securevector-ai-monitor-dev -y
   ```

2. **Install latest dev build:**
   ```bash
   pip install --index-url https://test.pypi.org/simple/ \
               --extra-index-url https://pypi.org/simple/ \
               securevector-ai-monitor-dev[mcp]
   ```

3. **Verify installation:**
   ```bash
   python -c "import securevector; print(securevector.__version__)"
   ```

4. **Test MCP server:**
   ```bash
   python -m securevector.mcp --health-check
   ```

### Development Workflow

```bash
# 1. Clone repository
git clone https://github.com/secure-vector/ai-threat-monitor.git
cd ai-threat-monitor

# 2. Create virtual environment
python -m venv venv
source venv/bin/activate  # On Windows: venv\Scripts\activate

# 3. Install in editable mode with all dev dependencies
pip install -e .[dev,mcp]

# 4. Run tests
pytest tests/ -v

# 5. Run linting
flake8 src/

# 6. Make changes and test
python -m securevector.mcp --health-check
```

### CI/CD Testing

The GitHub Actions workflow automatically:
1. Builds the package with dev version
2. Publishes to Test PyPI
3. Installs from Test PyPI with correct flags
4. Verifies installation and imports

See `.github/workflows/develop-preview-publish.yml` line 308 for the exact command used.

### Troubleshooting Development Builds

**Issue: Can't find httpx or other dependencies**

Solution: Always use `--extra-index-url` when installing from Test PyPI

**Issue: Wrong version installed**

```bash
# Check what's installed
pip list | grep securevector

# Force reinstall
pip uninstall securevector-ai-monitor-dev -y
pip install --index-url https://test.pypi.org/simple/ \
            --extra-index-url https://pypi.org/simple/ \
            --force-reinstall \
            securevector-ai-monitor-dev[mcp]
```

**Issue: Both dev and production versions installed**

```bash
# Remove both
pip uninstall securevector-ai-monitor securevector-ai-monitor-dev -y

# Install only what you need
pip install securevector-ai-monitor  # Production
# OR
pip install --index-url https://test.pypi.org/simple/ \
            --extra-index-url https://pypi.org/simple/ \
            securevector-ai-monitor-dev  # Development
```

## Notes for Maintainers

- Always test installation from Test PyPI before merging to main
- Verify the `--extra-index-url` flag is documented in release notes
- Check that CI/CD uses the correct flags (see workflow files)
- Development builds should never be referenced in public documentation
