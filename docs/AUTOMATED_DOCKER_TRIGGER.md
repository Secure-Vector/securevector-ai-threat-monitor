# Automated Docker Image Rebuilds

## Overview

After publishing a package to PyPI (test or production), the workflow automatically triggers a Docker image rebuild in the `securevector-mcp-server` repository.

```
┌─────────────────────────────────────────────────────────────┐
│  Automated CI/CD Pipeline                                   │
└─────────────────────────────────────────────────────────────┘

1. Code pushed to securevector-ai-threat-monitor
   ↓
2. Workflow publishes to PyPI (test.pypi.org or pypi.org)
   ↓
3. Workflow automatically triggers Docker rebuild ← NEW!
   ↓
4. securevector-mcp-server pulls latest package from PyPI
   ↓
5. Builds and pushes new Docker image
   ↓
6. Customers can pull updated image
```

## Setup Required

### 1. Create GitHub Personal Access Token (PAT)

**In GitHub:**
1. Go to: https://github.com/settings/tokens
2. Click "Generate new token" → "Generate new token (classic)"
3. Name: `MCP Server Trigger Token`
4. Scopes: Check `repo` (full control of private repositories)
   - Or at minimum: `public_repo` and `workflow`
5. Click "Generate token"
6. **Copy the token** (you won't see it again!)

### 2. Add Token to Repository Secrets

**In securevector-ai-threat-monitor repository:**
1. Go to: Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Name: `MCP_SERVER_TRIGGER_TOKEN`
4. Value: Paste the PAT you created
5. Click "Add secret"

### 3. Verify Workflow Files

The workflow files have been updated with the trigger step:

**For develop branch** (`develop-preview-publish.yml`):
```yaml
- name: Trigger Docker rebuild in securevector-mcp-server
  if: success()
  run: |
    curl -X POST \
      -H "Authorization: Bearer ${{ secrets.MCP_SERVER_TRIGGER_TOKEN }}" \
      https://api.github.com/repos/Secure-Vector/securevector-mcp-server/actions/workflows/docker-publish-develop.yml/dispatches \
      -d '{"ref":"develop"}'
```

**For master branch** (`release.yml`):
```yaml
- name: Trigger Docker rebuild in securevector-mcp-server
  if: success()
  run: |
    curl -X POST \
      -H "Authorization: Bearer ${{ secrets.MCP_SERVER_TRIGGER_TOKEN }}" \
      https://api.github.com/repos/Secure-Vector/securevector-mcp-server/actions/workflows/docker-publish-master.yml/dispatches \
      -d '{"ref":"master"}'
```

## How It Works

### Develop Branch Workflow

```bash
# 1. Push to develop
git push origin develop

# 2. GitHub Actions in securevector-ai-threat-monitor:
#    - Builds package
#    - Publishes to test.pypi.org
#    - ✅ Automatically triggers Docker rebuild

# 3. GitHub Actions in securevector-mcp-server:
#    - Receives trigger
#    - Pulls latest package from test.pypi.org
#    - Builds Docker image
#    - Pushes as latest-dev

# 4. Customers pull:
docker pull securevectorrepo/securevector-mcp-server:latest-dev
```

### Master Branch Workflow (Production)

```bash
# 1. Create release or push to master
git push origin master

# 2. GitHub Actions in securevector-ai-threat-monitor:
#    - Builds package
#    - Publishes to pypi.org
#    - ✅ Automatically triggers Docker rebuild

# 3. GitHub Actions in securevector-mcp-server:
#    - Receives trigger
#    - Pulls latest package from pypi.org
#    - Builds Docker image
#    - Pushes as latest

# 4. Customers pull:
docker pull securevectorrepo/securevector-mcp-server:latest
```

## Monitoring

### Check if Trigger Succeeded

1. Go to the workflow run in `securevector-ai-threat-monitor`:
   - https://github.com/Secure-Vector/securevector-ai-threat-monitor/actions

2. Look for the step: "Trigger Docker rebuild in securevector-mcp-server"

3. If successful, you'll see:
   ```
   🐳 Triggering Docker image rebuild...
   ✅ Docker rebuild triggered for develop branch
   ```

### Check Docker Build Progress

1. Go to securevector-mcp-server actions:
   - https://github.com/Secure-Vector/securevector-mcp-server/actions

2. You should see a new workflow run starting shortly after the trigger

3. Wait for it to complete (~5-10 minutes)

4. Once done, the new image is available:
   ```bash
   docker pull securevectorrepo/securevector-mcp-server:latest-dev
   ```

## Manual Trigger (If Needed)

If the automatic trigger fails, you can manually trigger:

### Via GitHub UI

1. Go to: https://github.com/Secure-Vector/securevector-mcp-server/actions
2. Select "Build and Push Docker Image (Develop)" or "(Master)"
3. Click "Run workflow"
4. Select branch (develop or master)
5. Click "Run workflow"

### Via Script

```bash
cd /home/mss/mss/securevector/securevector-mcp-server
./rebuild-docker.sh develop  # or master
```

### Via curl (Manual)

```bash
# For develop
curl -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer YOUR_GITHUB_TOKEN" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/Secure-Vector/securevector-mcp-server/actions/workflows/docker-publish-develop.yml/dispatches \
  -d '{"ref":"develop"}'

# For master
curl -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer YOUR_GITHUB_TOKEN" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/Secure-Vector/securevector-mcp-server/actions/workflows/docker-publish-master.yml/dispatches \
  -d '{"ref":"master"}'
```

## Troubleshooting

### Error: "Bad credentials" or 401

**Problem:** GitHub token is invalid or missing.

**Solution:**
1. Verify token has correct scopes (`repo` or `workflow`)
2. Check token is added to repository secrets as `MCP_SERVER_TRIGGER_TOKEN`
3. Token might be expired - create a new one

### Docker Build Doesn't Start

**Problem:** Trigger succeeded but no workflow runs.

**Solution:**
1. Check workflow file exists in target repo: `docker-publish-develop.yml`
2. Verify workflow has `workflow_dispatch` trigger
3. Check branch name is correct (develop/master)
4. Look at API response in the trigger step logs

### Docker Build Has Old Code

**Problem:** Docker image doesn't have latest changes.

**Cause:** Package on PyPI hasn't been published yet, or PyPI is caching.

**Solution:**
1. Wait a few minutes for PyPI to update
2. Check package version on PyPI:
   ```bash
   pip index versions securevector-ai-monitor-dev --index-url https://test.pypi.org/simple/
   ```
3. If still old, trigger rebuild manually after confirming PyPI has new version

### Want to See What Package Version Docker Will Use

```bash
# Check test.pypi.org
pip index versions securevector-ai-monitor-dev \
  --index-url https://test.pypi.org/simple/ \
  --extra-index-url https://pypi.org/simple/

# Check pypi.org
pip index versions securevector-ai-monitor
```

## Benefits

### Before (Manual)
```
1. Publish package to PyPI
2. Wait for publish to complete
3. Remember to rebuild Docker
4. Go to securevector-mcp-server repo
5. Manually trigger workflow or push empty commit
6. Wait for Docker build
7. Tell customers to pull new image
```

### After (Automated) ✅
```
1. Publish package to PyPI
2. Automatically triggers Docker rebuild
3. Done! 🎉
```

## Testing the Setup

### Test Develop Branch Trigger

```bash
cd /home/mss/mss/securevector/securevector-ai-threat-monitor

# Make a small change
echo "# Test trigger" >> README.md
git add README.md
git commit -m "test: trigger automated Docker rebuild"
git push origin develop

# Watch both repos:
# 1. securevector-ai-threat-monitor workflow completes
# 2. securevector-mcp-server workflow starts automatically
# 3. New Docker image available within ~10 minutes
```

## Security Notes

- ✅ Token is stored securely in GitHub Secrets
- ✅ Token is never exposed in logs
- ✅ Token only has access to trigger workflows
- ✅ Workflow runs under repository's permissions
- ⚠️ **Never** commit the token to code!

## Summary

**What was added:**
1. ✅ Automatic Docker rebuild trigger in both workflows
2. ✅ Proper error handling and logging
3. ✅ Links to monitor progress

**What you need to do:**
1. Create GitHub PAT with `repo` scope
2. Add as `MCP_SERVER_TRIGGER_TOKEN` secret
3. Test by pushing to develop

**Result:**
- Push code → Package published → Docker rebuilt → Customers get latest image
- All automatic! 🚀
