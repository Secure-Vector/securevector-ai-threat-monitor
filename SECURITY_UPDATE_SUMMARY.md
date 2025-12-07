# Security Vulnerability Updates - 2025-12-06

## Summary
Updated dependency versions in `setup.py` to address high-severity CVE vulnerabilities.

## Vulnerabilities Addressed

### 1. urllib3 (CVE-2025-66418, CVE-2025-66416)
- **CVSS Score**: 8.9 (High) and 7.6 (High)
- **Previous Version Constraint**: Not explicitly specified (was transitive dependency)
- **New Version Constraint**: `>=2.6.0`
- **Fix Version**: 2.6.0
- **Status**: ✅ Updated in setup.py

### 2. mcp (GHSA-c2jp-c369-7pvx)
- **CVSS Score**: 7.6 (High)
- **Previous Version Constraint**: `>=0.1.0`
- **New Version Constraint**: `>=1.23.0`
- **Fix Version**: 1.23.0
- **Status**: ✅ Updated in setup.py

### 3. fastmcp
- **CVSS Score**: 7.3 (High)
- **Previous Version Constraint**: `>=0.1.0`
- **New Version Constraint**: `>=2.13.0`
- **Fix Version**: 2.13.0
- **Status**: ✅ Updated in setup.py

## Changes Made

### setup.py
Updated three dependency sections:

1. **install_requires** - Added `urllib3>=2.6.0` to core dependencies
2. **extras_require['mcp']** - Updated:
   - `mcp>=0.1.0` → `mcp>=1.23.0`
   - `fastmcp>=0.1.0` → `fastmcp>=2.13.0`
3. **extras_require['all']** - Updated same mcp and fastmcp versions

## Installation Notes

When installing the package, users will now automatically get:
- urllib3 2.6.0 or later (patched for CVE-2025-66418, CVE-2025-66416)
- mcp 1.23.0 or later when using `[mcp]` extras (patched for GHSA-c2jp-c369-7pvx)
- fastmcp 2.13.0 or later when using `[mcp]` extras (patched vulnerability)

## Potential Environment Conflicts

Some existing environments may have dependency conflicts with other packages:
- **botocore**: May require `urllib3<2.1`, needs upgrade to support urllib3 2.6.0
- **sagemaker**: May require newer boto3 version
- **langsmith**: May require newer orjson version

These conflicts are in the development/system environment and do not affect the package distribution itself.

## Verification

Run the following to verify the security updates:
```bash
pip index versions urllib3  # Should show 2.6.0 available
pip index versions mcp      # Should show 1.23.0+ available
pip index versions fastmcp  # Should show 2.13.0+ available
```

## Recommendations

1. **For Package Users**: 
   - Upgrade to the latest package version when published
   - Run `pip install --upgrade securevector-ai-monitor[all]` to get all security fixes

2. **For Development Environment**:
   - Update boto3/botocore if using AWS SDK features
   - Update sagemaker if using SageMaker features
   - Update orjson if using langsmith

3. **For CI/CD**:
   - Update dependency scanning tools to verify new minimum versions
   - Test package installation in clean environments

## Verification Results

### Installed Versions (Confirmed)
- ✅ urllib3: **2.6.0** (upgraded from 2.0.7)
- ✅ mcp: **1.23.1** (upgraded from 1.14.1)
- ✅ fastmcp: **2.13.2** (upgraded from 2.12.3)

### Testing Results
- ✅ All SecureVector imports working correctly
- ✅ Basic client functionality verified
- ✅ Local mode threat detection operational
- ✅ No breaking changes detected

## Next Steps

- [x] Update dependency versions in setup.py
- [x] Upgrade packages in development environment
- [x] Verify package functionality with new dependencies
- [ ] Commit these changes to version control
- [ ] Update package version number (patch or minor bump recommended)
- [ ] Test package installation in clean virtual environment
- [ ] Update changelog/release notes
- [ ] Publish updated package to PyPI
