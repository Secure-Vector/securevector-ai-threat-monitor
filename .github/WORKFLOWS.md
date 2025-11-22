# GitHub Actions Workflows

This document describes the active workflows in this repository.

## Active Workflows

### 1. `develop-preview-publish.yml` ✅
**Triggers:** Push to `develop` branch

**Purpose:** Build and publish development versions to Test PyPI

**What it does:**
- Validates imports and package structure
- Replaces API URL with development endpoint (`scandev.securevector.io`)
- Runs security scans
- Builds package with dev version
- Publishes to Test PyPI as `securevector-ai-monitor-dev`
- Tests installation from Test PyPI

**When to use:** Automatically runs when you push to develop branch

---

### 2. `release.yml` ✅
**Triggers:** Release published (from main/master branch)

**Purpose:** Build and publish production releases to PyPI

**What it does:**
- Fixes package structure
- Runs security scans (verifies production API URL)
- Validates imports
- Builds production package
- Publishes to PyPI as `securevector-ai-monitor`
- Uploads artifacts to GitHub Release

**When to use:** Automatically runs when you create a GitHub release

---

### 3. `comprehensive-testing.yml` ✅
**Triggers:** Pull Requests to main/master/develop

**Purpose:** Run comprehensive tests on multiple Python versions

**What it does:**
- Tests on Python 3.9, 3.10, 3.11, 3.12
- Runs full test suite with pytest
- Generates coverage reports
- Validates across different environments

**When to use:** Automatically runs on all Pull Requests

---

### 4. `benchmark-schedule.yml` ✅
**Triggers:** Scheduled (cron) or manual

**Purpose:** Performance benchmarking

**What it does:**
- Runs performance benchmarks
- Tracks performance over time

**When to use:** Runs automatically on schedule or manually

---

## Disabled Workflows (Manual Only)

These workflows are kept for reference but won't run automatically. They can be triggered manually via `workflow_dispatch` if needed.

### `ci-cd.yml` ⚠️
**Status:** Disabled - Redundant with other workflows

**Reason:** Functionality covered by:
- `comprehensive-testing.yml` (for testing)
- `develop-preview-publish.yml` (for develop builds)
- `release.yml` (for releases)

**Manual trigger:** Can be run manually if needed via GitHub Actions UI

---

### `mcp-testing.yml` ⚠️
**Status:** Disabled - MCP tests included in comprehensive testing

**Reason:** MCP-specific tests are now included in the main test suite run by `comprehensive-testing.yml`

**Manual trigger:** Can be run manually if needed via GitHub Actions UI

---

## Workflow Execution Matrix

| Event | Workflows That Run |
|-------|-------------------|
| Push to `develop` | `develop-preview-publish.yml` |
| Push to `main`/`master` | None (use releases instead) |
| Pull Request | `comprehensive-testing.yml` |
| Release Published | `release.yml` |
| Scheduled | `benchmark-schedule.yml` |

---

## Development Workflow

### Making Changes

1. **Create a branch** from `develop`
   ```bash
   git checkout develop
   git pull
   git checkout -b feature/my-feature
   ```

2. **Make your changes** and commit
   ```bash
   git add .
   git commit -m "Add feature"
   git push origin feature/my-feature
   ```

3. **Create Pull Request** to `develop`
   - ✅ `comprehensive-testing.yml` runs automatically
   - Tests on Python 3.9, 3.10, 3.11, 3.12
   - Must pass before merge

4. **Merge to develop**
   ```bash
   # After PR approved and merged
   ```
   - ✅ `develop-preview-publish.yml` runs automatically
   - Publishes dev version to Test PyPI
   - Uses `scandev.securevector.io` API endpoint

5. **Create Release** from `main`/`master`
   ```bash
   # When ready for production
   git checkout main
   git merge develop
   git push
   # Create release via GitHub UI
   ```
   - ✅ `release.yml` runs automatically
   - Publishes to PyPI
   - Uses `scan.securevector.io` API endpoint

---

## API Endpoints by Environment

| Environment | API URL | Set By | Workflow |
|------------|---------|--------|----------|
| Production | `https://scan.securevector.io` | Default in code | `release.yml` |
| Development | `https://scandev.securevector.io` | CI/CD replacement | `develop-preview-publish.yml` |
| Custom | Any URL | `SECUREVECTOR_API_URL` env var | Manual override |

---

## Troubleshooting

### Too Many Workflows Running?

If you see multiple workflows running on a push to develop, check:
1. Are you pushing to the correct branch?
2. Check `.github/workflows/*.yml` for `on: push` triggers
3. Disabled workflows should have `on: workflow_dispatch` only

### Tests Failing in CI?

1. Run tests locally first:
   ```bash
   PYTHONPATH=src pytest tests/ -v
   ```

2. Check Python version compatibility:
   ```bash
   python --version
   # Tests run on 3.9, 3.10, 3.11, 3.12
   ```

3. Check comprehensive-testing.yml logs in GitHub Actions

### Package Not Publishing?

**To Test PyPI (develop):**
- Check `develop-preview-publish.yml` logs
- Verify `TEST_PYPI_API_TOKEN` secret is set
- Check for version conflicts

**To PyPI (production):**
- Check `release.yml` logs
- Verify `PYPI_API_TOKEN` secret is set
- Ensure release was created from main/master branch

---

## Secrets Required

| Secret | Used By | Purpose |
|--------|---------|---------|
| `TEST_PYPI_API_TOKEN` | `develop-preview-publish.yml` | Publish to Test PyPI |
| `PYPI_API_TOKEN` | `release.yml` | Publish to PyPI |
| `GITHUB_TOKEN` | All workflows | GitHub API access (auto-provided) |

---

## Maintenance

### Adding New Tests

Tests added to `tests/` directory are automatically run by:
- `comprehensive-testing.yml` (on PRs)
- `develop-preview-publish.yml` (before publishing dev builds)
- `release.yml` (before publishing production)

### Updating Workflows

When modifying workflows:
1. Test changes on a feature branch PR first
2. Verify in GitHub Actions UI before merging
3. Update this document if workflow triggers change

### Re-enabling Disabled Workflows

To re-enable `ci-cd.yml` or `mcp-testing.yml`:
1. Edit the workflow file
2. Change `on: workflow_dispatch` back to original triggers
3. Remove the "DISABLED" comment
4. Update this document

---

## Quick Reference

**View workflow runs:**
https://github.com/securevector/ai-threat-monitor/actions

**Trigger manual workflow:**
Actions → Select workflow → Run workflow

**View workflow logs:**
Actions → Select run → Click on job name
