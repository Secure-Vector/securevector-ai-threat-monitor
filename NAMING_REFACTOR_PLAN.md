# SDK Naming Refactor Plan

## Current Problems
- Package name: `securevector-ai-monitor`
- Import name: `ai_threat_monitor`
- Repository: `ai-threat-monitor`

**This creates confusion for developers!**

## Recommended Solution

### New Naming Convention
```bash
PyPI Package:    securevector-ai-monitor    (keep - already established)
Python Import:   securevector               (change from ai_threat_monitor)
Repository:      ai-threat-monitor          (keep - URLs already shared)
```

### Directory Structure Changes
```
src/
├── securevector/                    # Rename from ai_threat_monitor/
│   ├── __init__.py                 # Main exports
│   ├── client.py
│   ├── async_client.py
│   ├── models/
│   ├── core/
│   ├── utils/
│   ├── testing/
│   ├── rules/
│   ├── config/                     # Move from src/config/
│   ├── engines/                    # Move from src/engines/
│   └── integrations/               # Move from src/integrations/
└── (remove loose directories)
```

### Import Changes
```python
# OLD (confusing)
from ai_threat_monitor import SecureVectorClient

# NEW (professional, matches brand)
from securevector import SecureVectorClient
```

## Implementation Steps

1. **Rename main package directory**
   ```bash
   mv src/ai_threat_monitor src/securevector
   ```

2. **Move loose directories into package**
   ```bash
   mv src/config src/securevector/config
   mv src/engines src/securevector/engines
   mv src/integrations src/securevector/integrations
   ```

3. **Update all imports throughout codebase**
   - Change `ai_threat_monitor` → `securevector`
   - Update relative imports where needed

4. **Update setup.py package_data**
   ```python
   package_data={
       "securevector": [
           "rules/**/*.yml",
           "rules/**/*.yaml",
           # ...
       ]
   }
   ```

5. **Update CI/CD pipeline**
   - Update package structure checks
   - Update import tests

6. **Update documentation**
   - README.md examples
   - Installation guides
   - All documentation

## Benefits of This Change

✅ **Professional**: Matches AWS SDK, Google SDK patterns
✅ **Brand Recognition**: Users remember "SecureVector"
✅ **Clean Structure**: All code in one package
✅ **Future Proof**: Can add more SecureVector products
✅ **Developer Friendly**: Clear, consistent naming

## Industry Examples

- `aws-sdk-python` → `import boto3`
- `google-cloud-python` → `import google.cloud`
- `stripe-python` → `import stripe`
- `securevector-ai-monitor` → `import securevector` ✅

## Breaking Change Notice

This is a breaking change that requires:
- Updating user code imports
- Version bump (major version)
- Migration guide for existing users
- Deprecation notice for old import

## Alternative (If Breaking Change Not Acceptable)

Keep current structure but clean up:
1. Move `src/config`, `src/engines`, `src/integrations` into `src/ai_threat_monitor/`
2. Keep import as `from ai_threat_monitor import`
3. Document the naming convention clearly