# Docker Rebuild Automation - Quick Setup

## ✅ What's Been Done

Your workflows now automatically trigger Docker rebuilds after PyPI publish!

### Files Modified

1. **`.github/workflows/develop-preview-publish.yml`**
   - Added: Automatic trigger for `docker-publish-develop.yml` in mcp-server repo
   - Triggers after successful test.pypi.org publish

2. **`.github/workflows/release.yml`**
   - Added: Automatic trigger for `docker-publish-master.yml` in mcp-server repo
   - Triggers after successful pypi.org publish

3. **Documentation Created:**
   - `docs/AUTOMATED_DOCKER_TRIGGER.md` - Complete setup guide

## 🔧 Setup Required (5 minutes)

### Step 1: Create GitHub Token

1. Go to: https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. Name: `MCP Server Trigger Token`
4. Scope: Check `repo` (full control)
5. Generate and **copy the token**

### Step 2: Add to Repository Secrets

1. Go to: https://github.com/Secure-Vector/securevector-ai-threat-monitor/settings/secrets/actions
2. Click "New repository secret"
3. Name: `MCP_SERVER_TRIGGER_TOKEN`
4. Value: Paste your token
5. Add secret

### Step 3: Test It!

```bash
cd /home/mss/mss/securevector/securevector-ai-threat-monitor

# Make a test change
git commit --allow-empty -m "test: automated Docker trigger"
git push origin develop

# Watch the magic happen:
# 1. Workflow publishes to test.pypi.org
# 2. Automatically triggers Docker rebuild
# 3. Wait ~10 minutes
# 4. New image available!

docker pull securevectorrepo/securevector-mcp-server:latest-dev
```

## 📊 The New Workflow

### Before (Manual) ❌
```
Push code
  ↓
Publish to PyPI
  ↓
Remember to rebuild Docker 🤔
  ↓
Go to mcp-server repo
  ↓
Manually trigger workflow
  ↓
Wait...
  ↓
Tell customers to update
```

### After (Automated) ✅
```
Push code
  ↓
Publish to PyPI
  ↓
Automatically rebuild Docker! 🎉
  ↓
Done!
```

## 🎯 What Happens Now

### Develop Branch
```
git push origin develop
  ↓
[securevector-ai-threat-monitor]
  • Publishes to test.pypi.org
  • Triggers Docker rebuild
  ↓
[securevector-mcp-server]
  • Pulls latest from test.pypi.org
  • Builds securevectorrepo/securevector-mcp-server:latest-dev
  • Pushes to Docker Hub
  ↓
Customers: docker pull ...latest-dev
```

### Master Branch (Production)
```
git push origin master
  ↓
[securevector-ai-threat-monitor]
  • Publishes to pypi.org
  • Triggers Docker rebuild
  ↓
[securevector-mcp-server]
  • Pulls latest from pypi.org
  • Builds securevectorrepo/securevector-mcp-server:latest
  • Pushes to Docker Hub
  ↓
Customers: docker pull ...latest
```

## 🔍 Monitoring

### Check Trigger Status

**In ai-threat-monitor actions:**
```
Step: "Trigger Docker rebuild in securevector-mcp-server"
Output: ✅ Docker rebuild triggered for develop branch
```

**In mcp-server actions:**
```
https://github.com/Secure-Vector/securevector-mcp-server/actions
→ New workflow run should appear within 30 seconds
```

## 🚨 Troubleshooting

### Token Error (401/403)
→ Check secret is named exactly: `MCP_SERVER_TRIGGER_TOKEN`
→ Verify token has `repo` scope

### No Docker Workflow Starts
→ Wait 30 seconds (API delay)
→ Check workflow file exists in mcp-server repo
→ Verify branch name is correct

### Docker Has Old Code
→ Wait for PyPI to update (2-5 minutes)
→ Check package version on PyPI first
→ Then manually retrigger if needed

## 🎁 Benefits

1. ✅ **Fully Automated** - No manual steps!
2. ✅ **Always in Sync** - Docker matches PyPI
3. ✅ **No Forgetting** - Triggers automatically
4. ✅ **Fast Updates** - Customers get latest quickly
5. ✅ **Less Work** - Set it and forget it!

## 📝 Summary

**What you need:**
- Create GitHub PAT (5 min)
- Add as repository secret (1 min)
- Test by pushing to develop (1 min)

**What you get:**
- Automatic Docker rebuilds forever! 🚀

**Next steps:**
1. Set up the token (see Step 1-2 above)
2. Test it (see Step 3 above)
3. Profit! 💰

For detailed information, see: `docs/AUTOMATED_DOCKER_TRIGGER.md`
