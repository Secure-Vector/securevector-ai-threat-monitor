# Docker Quick Start Guide

## Security Updates Applied ✅

All Docker images will now use the secure dependency versions:
- urllib3 >= 2.6.0 (CVE-2025-66418, CVE-2025-66416 fixed)
- mcp >= 1.23.0 (GHSA-c2jp-c369-7pvx fixed)
- fastmcp >= 2.13.0 (vulnerability fixed)

## Development Environment

### Build and Start Development Container
```bash
# Build the development image with security fixes
docker-compose -f docker-compose.dev.yml build

# Start the development container
docker-compose -f docker-compose.dev.yml up -d

# View logs
docker-compose -f docker-compose.dev.yml logs -f

# Stop the container
docker-compose -f docker-compose.dev.yml down
```

### Access Development Container
```bash
# Get a shell inside the container
docker exec -it securevector-mcp-dev /bin/bash

# Run Python commands
docker exec -it securevector-mcp-dev python -c "from securevector import SecureVectorClient; print('OK')"
```

## Production Environment

### Build and Start Production Container
```bash
# Build the production image
docker-compose build

# Start the production container
docker-compose up -d

# View logs
docker-compose logs -f

# Stop the container
docker-compose down
```

## Configuration

### Environment Variables (in docker-compose files)

**Development mode:**
- `SECUREVECTOR_MCP_MODE=development` - Enables dev features
- `SECUREVECTOR_MCP_LOG_LEVEL=DEBUG` - Verbose logging
- `SECUREVECTOR_MCP_TRANSPORT=stdio` - Communication method

**Production mode:**
- `SECUREVECTOR_MCP_MODE=balanced` - Production settings
- `SECUREVECTOR_MCP_LOG_LEVEL=INFO` - Standard logging
- `SECUREVECTOR_API_KEY=your_key` - For cloud/hybrid mode (optional)

### Volume Mounts (optional)

Uncomment in docker-compose files to enable:
```yaml
volumes:
  - ./src:/app/src        # Hot-reload source code changes
  - ./config:/app/config  # Custom configuration
  - ./logs:/app/logs      # Persistent logs
```

## Health Checks

Both containers include health checks:
```bash
# Check container health
docker ps
# Look for "healthy" status

# Manual health check
docker exec securevector-mcp-dev python -c "import securevector; print('OK')"
```

## Troubleshooting

### Container won't start
```bash
# View detailed logs
docker-compose -f docker-compose.dev.yml logs

# Check for errors during build
docker-compose -f docker-compose.dev.yml build --no-cache
```

### Dependency issues
```bash
# Verify security fixes are installed
docker exec securevector-mcp-dev pip show urllib3 mcp fastmcp
```

### Reset everything
```bash
# Stop and remove containers
docker-compose -f docker-compose.dev.yml down

# Remove images
docker rmi securevector-mcp-dev:latest

# Rebuild from scratch
docker-compose -f docker-compose.dev.yml build --no-cache
```

## Files Modified

- ✅ `docker-compose.yml` - Updated to build locally instead of pulling from registry
- ✅ `docker-compose.dev.yml` - Updated to build locally
- ✅ `Dockerfile.mcp` - Production Dockerfile (updated)
- ✅ `Dockerfile.mcp.dev` - Development Dockerfile (updated)
- ✅ `requirements.txt` - Created with security fixes

## Next Steps

1. Build the development image: `docker-compose -f docker-compose.dev.yml build`
2. Start the container: `docker-compose -f docker-compose.dev.yml up -d`
3. Verify it's running: `docker ps`
4. Test functionality: `docker exec securevector-mcp-dev python -m securevector.mcp --help`
