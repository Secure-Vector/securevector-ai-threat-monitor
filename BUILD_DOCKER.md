# Building SecureVector MCP Docker Images

This guide explains how to build the SecureVector MCP server Docker images from source.

## Prerequisites

- Docker installed and running
- Docker Buildx for multi-platform builds (optional)

## Quick Build

### Production Image

```bash
docker build -f Dockerfile.mcp -t securevector-mcp:latest .
```

### Development Image

```bash
docker build -f Dockerfile.mcp.dev -t securevector-mcp:latest-dev .
```

## Multi-Platform Build

For building images that work on both AMD64 and ARM64 architectures:

### Setup (One-time)

```bash
# Create and use a new builder
docker buildx create --name multiarch --use
docker buildx inspect --bootstrap
```

### Build for Multiple Platforms

**Production:**
```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f Dockerfile.mcp \
  -t securevectorrepo/securevector-mcp-server:latest \
  --push \
  .
```

**Development:**
```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -f Dockerfile.mcp.dev \
  -t securevectorrepo/securevector-mcp-server:latest-dev \
  --push \
  .
```

## Build with Docker Compose

Update `docker-compose.yml` to build from source:

```yaml
services:
  securevector-mcp:
    build:
      context: .
      dockerfile: Dockerfile.mcp
    container_name: securevector-mcp
    # ... rest of configuration
```

Then build and start:

```bash
docker-compose build
docker-compose up -d
```

## Build Options

### Custom Tag

```bash
docker build -f Dockerfile.mcp -t my-custom-mcp:v1.0 .
```

### No Cache

```bash
docker build --no-cache -f Dockerfile.mcp -t securevector-mcp:latest .
```

### Build Arguments

If you need to pass build arguments:

```bash
docker build -f Dockerfile.mcp \
  --build-arg VERSION=1.0.0 \
  -t securevector-mcp:1.0.0 \
  .
```

## Testing the Built Image

### Production Image

```bash
# Run the image
docker run -it --rm securevector-mcp:latest

# Test with validation
docker run -it --rm securevector-mcp:latest python -m securevector.mcp --validate-only

# Check health
docker run -it --rm securevector-mcp:latest python -c "import securevector; print('OK')"
```

### Development Image

```bash
# Run in development mode
docker run -it --rm securevector-mcp:latest-dev

# Access shell for debugging
docker run -it --rm securevector-mcp:latest-dev bash
```

## Image Size Optimization

The production image is optimized for size:

- Uses `python:3.11-slim` base image
- Removes apt cache after installing dependencies
- Uses `.dockerignore` to exclude unnecessary files

Expected sizes:
- **Production:** ~300-400 MB
- **Development:** ~450-550 MB (includes dev tools)

## Publishing to Docker Hub

### Login

```bash
docker login
```

### Tag

```bash
docker tag securevector-mcp:latest securevectorrepo/securevector-mcp-server:latest
docker tag securevector-mcp:latest securevectorrepo/securevector-mcp-server:1.0.0
```

### Push

```bash
docker push securevectorrepo/securevector-mcp-server:latest
docker push securevectorrepo/securevector-mcp-server:1.0.0
```

## Troubleshooting

### Build Fails - Missing Dependencies

Ensure `requirements.txt` and `setup.py` are up to date:

```bash
pip freeze > requirements.txt
```

### Permission Denied

The images run as non-root user `appuser` (UID 1000). If you have permission issues:

```bash
# Run as root (not recommended for production)
docker run -it --rm --user root securevector-mcp:latest bash
```

### Large Build Context

If the build is slow, check `.dockerignore` is excluding unnecessary files:

```bash
# View build context size
docker build -f Dockerfile.mcp --no-cache . 2>&1 | grep "Sending build context"
```

## Best Practices

1. ✅ **Use `.dockerignore`** - Exclude unnecessary files
2. ✅ **Pin versions** - Use specific Python version in Dockerfile
3. ✅ **Multi-stage builds** - Consider for even smaller images
4. ✅ **Security scanning** - Scan images for vulnerabilities
5. ✅ **Tag versions** - Always tag with version numbers
6. ✅ **Test locally** - Test built images before publishing

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Build and Push Docker Images

on:
  push:
    tags:
      - 'v*'

jobs:
  docker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v2

      - name: Login to Docker Hub
        uses: docker/login-action@v2
        with:
          username: ${{ secrets.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_PASSWORD }}

      - name: Build and push
        uses: docker/build-push-action@v4
        with:
          context: .
          file: Dockerfile.mcp
          platforms: linux/amd64,linux/arm64
          push: true
          tags: |
            securevectorrepo/securevector-mcp-server:latest
            securevectorrepo/securevector-mcp-server:${{ github.ref_name }}
```

## Support

For build issues:
1. Check Docker logs: `docker logs <container-id>`
2. Verify Dockerfile syntax
3. Ensure all dependencies are in `requirements.txt`
4. Check `.dockerignore` isn't excluding needed files

See [MCP_GUIDE.md](MCP_GUIDE.md) for deployment and usage instructions.
