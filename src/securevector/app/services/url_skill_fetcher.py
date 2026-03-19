"""
URL-based skill fetcher for pre-install security scanning.

Downloads skills from GitHub repos, archive URLs, or npm registry
to a temporary directory for scanning before installation.
"""

import asyncio
import ipaddress
import logging
import os
import re
import shutil
import socket
import subprocess
import tarfile
import tempfile
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

logger = logging.getLogger(__name__)

MAX_DOWNLOAD_BYTES = 50_000_000  # 50 MB
DOWNLOAD_TIMEOUT = 60  # seconds
MAX_EXTRACTED_FILES = 500
TEMP_PREFIX = "sv_skill_"
STALE_AGE_SECONDS = 3600  # 1 hour

ALLOWED_SCHEMES = {"https"}
ALLOWED_HOSTS = {
    "github.com", "gitlab.com", "bitbucket.org",
    "registry.npmjs.org", "www.npmjs.com",
    "codeload.github.com",
}

# GitHub URL patterns
_GITHUB_REPO_RE = re.compile(
    r"^https://github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+?)(?:\.git)?/?$"
)
_GITHUB_SUBDIR_RE = re.compile(
    r"^https://github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)/tree/(?P<branch>[^/]+)/(?P<path>.+?)/?$"
)
_GITHUB_BLOB_RE = re.compile(
    r"^https://github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)/blob/(?P<branch>[^/]+)/(?P<path>.+?)/?$"
)
_GITHUB_ARCHIVE_RE = re.compile(
    r"^https://github\.com/[^/]+/[^/]+/archive/"
)
_GITHUB_RELEASE_RE = re.compile(
    r"^https://github\.com/[^/]+/[^/]+/releases/download/"
)

# npm URL patterns
_NPM_PACKAGE_RE = re.compile(
    r"^https://(?:www\.)?npmjs\.com/package/(?P<name>[^/]+)"
)
_NPM_REGISTRY_RE = re.compile(
    r"^https://registry\.npmjs\.org/(?P<name>[^/]+)"
)


class UrlFetchError(Exception):
    """Raised when URL fetching fails."""
    pass


def _confined_path(base: str, *parts: str) -> str:
    """Build a path under *base*, verify it stays within *base* after resolution.

    Returns the resolved absolute path string.  Raises UrlFetchError on traversal.
    Uses os.path.realpath so CodeQL recognises the sanitisation.
    """
    joined = os.path.join(os.path.realpath(base), *parts)
    resolved = os.path.realpath(joined)
    base_real = os.path.realpath(base)
    if not (resolved == base_real or resolved.startswith(base_real + os.sep)):
        raise UrlFetchError("Path traversal detected")
    return resolved


@dataclass
class FetchResult:
    temp_dir: str
    skill_name: str
    source_url: str
    url_type: str  # "github_repo", "archive", "npm"


class UrlSkillFetcher:
    """Fetch skill source from a URL into a temp directory."""

    def validate_url(self, url: str) -> None:
        """Validate URL for safety before any network access."""
        parsed = urlparse(url)

        if parsed.scheme not in ALLOWED_SCHEMES:
            raise UrlFetchError(f"Only HTTPS URLs are supported, got: {parsed.scheme}")

        if not parsed.hostname:
            raise UrlFetchError("URL has no hostname")

        if parsed.username or parsed.password:
            raise UrlFetchError("URLs with credentials are not allowed")

        if len(url) > 2048:
            raise UrlFetchError("URL is too long (max 2048 characters)")

        # Reject private/internal IPs
        try:
            for info in socket.getaddrinfo(parsed.hostname, None):
                addr = info[4][0]
                ip = ipaddress.ip_address(addr)
                if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                    raise UrlFetchError(f"URL resolves to private/internal IP: {addr}")
        except socket.gaierror:
            pass  # DNS resolution may fail for valid hosts in restricted envs

    def detect_url_type(self, url: str) -> tuple[str, str]:
        """Detect URL type and extract skill name. Returns (url_type, skill_name)."""
        # GitHub repo
        m = _GITHUB_REPO_RE.match(url)
        if m:
            return "github_repo", m.group("repo")

        # GitHub subdirectory (e.g. github.com/owner/repo/tree/main/path/to/skill)
        m = _GITHUB_SUBDIR_RE.match(url)
        if m:
            skill_name = m.group("path").rstrip("/").split("/")[-1]
            return "github_subdir", skill_name

        # GitHub blob URL (e.g. github.com/owner/repo/blob/main/path/to/skill/SKILL.md)
        # Use the parent directory of the file as the skill path
        m = _GITHUB_BLOB_RE.match(url)
        if m:
            file_path = m.group("path").rstrip("/")
            parent = "/".join(file_path.split("/")[:-1])
            if not parent:
                return "github_repo", m.group("repo")
            skill_name = parent.split("/")[-1]
            return "github_subdir", skill_name

        # GitHub archive or release
        if _GITHUB_ARCHIVE_RE.match(url) or _GITHUB_RELEASE_RE.match(url):
            parts = urlparse(url).path.strip("/").split("/")
            return "archive", parts[1] if len(parts) >= 2 else "skill"

        # npm
        m = _NPM_PACKAGE_RE.match(url) or _NPM_REGISTRY_RE.match(url)
        if m:
            return "npm", m.group("name")

        # Generic archive URL
        path = urlparse(url).path
        if any(path.endswith(ext) for ext in (".zip", ".tar.gz", ".tgz")):
            name = Path(path).stem
            if name.endswith(".tar"):
                name = name[:-4]
            return "archive", name or "skill"

        raise UrlFetchError(
            "Unsupported URL. Supported: GitHub repos, .zip/.tar.gz archives, npm packages"
        )

    async def fetch(self, url: str) -> FetchResult:
        """Download and extract a skill from URL to a temp directory."""
        url = url.strip()
        self.validate_url(url)

        # Normalize blob URLs: extract parent directory and convert to tree URL
        m = _GITHUB_BLOB_RE.match(url)
        if m:
            file_path = m.group("path").rstrip("/")
            parent = "/".join(file_path.split("/")[:-1])
            if parent:
                url = f"https://github.com/{m.group('owner')}/{m.group('repo')}/tree/{m.group('branch')}/{parent}"
            else:
                url = f"https://github.com/{m.group('owner')}/{m.group('repo')}"

        url_type, skill_name = self.detect_url_type(url)

        # Sanitize skill name
        skill_name = re.sub(r"[^a-zA-Z0-9._-]", "-", skill_name)[:100]

        temp_dir = tempfile.mkdtemp(prefix=TEMP_PREFIX)

        try:
            if url_type == "github_repo":
                await self._clone_github(url, temp_dir, skill_name)
            elif url_type == "github_subdir":
                await self._fetch_github_subdir(url, temp_dir, skill_name)
            elif url_type == "npm":
                await self._fetch_npm(url, temp_dir, skill_name)
            else:
                await self._download_archive(url, temp_dir, skill_name)
        except UrlFetchError:
            shutil.rmtree(temp_dir, ignore_errors=True)
            raise
        except Exception as e:
            shutil.rmtree(temp_dir, ignore_errors=True)
            raise UrlFetchError(f"Failed to fetch: {e}") from e

        # Find the actual skill directory (may be nested one level)
        skill_dir = self._find_skill_root(temp_dir)

        return FetchResult(
            temp_dir=skill_dir,
            skill_name=skill_name,
            source_url=url,
            url_type=url_type,
        )

    async def _clone_github(self, url: str, temp_dir: str, skill_name: str) -> None:
        """Clone a GitHub repo with depth=1."""
        target = _confined_path(temp_dir, skill_name)

        # Check if git is available
        git_available = shutil.which("git") is not None

        if git_available:
            try:
                result = await asyncio.to_thread(
                    subprocess.run,
                    ["git", "clone", "--depth", "1", "--single-branch", url, target],
                    capture_output=True, text=True, timeout=120,
                )
                if result.returncode != 0:
                    stderr = result.stderr.strip()
                    if "not found" in stderr.lower() or "404" in stderr:
                        raise UrlFetchError("Repository not found. It may be private or the URL is incorrect.")
                    raise UrlFetchError(f"Git clone failed: {stderr[:200]}")

                # Remove .git directory
                git_dir = _confined_path(target, ".git")
                if os.path.isdir(git_dir):
                    shutil.rmtree(git_dir, ignore_errors=True)
                return
            except subprocess.TimeoutExpired:
                raise UrlFetchError("Git clone timed out (120s limit)")

        # Fallback: download zip archive from GitHub
        m = _GITHUB_REPO_RE.match(url)
        if m:
            zip_url = f"https://github.com/{m.group('owner')}/{m.group('repo')}/archive/refs/heads/main.zip"
            await self._download_archive(zip_url, temp_dir, skill_name)
        else:
            raise UrlFetchError("Git is not installed and URL cannot be downloaded as an archive")

    async def _fetch_github_subdir(self, url: str, temp_dir: str, skill_name: str) -> None:
        """Fetch a subdirectory from a GitHub repo. Tries sparse checkout first, falls back to zip."""
        m = _GITHUB_SUBDIR_RE.match(url)
        if not m:
            raise UrlFetchError("Could not parse GitHub subdirectory URL")

        owner, repo, branch, subpath = m.group("owner"), m.group("repo"), m.group("branch"), m.group("path")
        repo_url = f"https://github.com/{owner}/{repo}.git"

        # Try sparse checkout (requires git 2.27+)
        if shutil.which("git"):
            clone_dir = _confined_path(temp_dir, f"{repo}-clone")
            try:
                r1 = await asyncio.to_thread(
                    subprocess.run,
                    ["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse",
                     "--branch", branch, repo_url, clone_dir],
                    capture_output=True, text=True, timeout=120,
                )
                if r1.returncode == 0:
                    r2 = await asyncio.to_thread(
                        subprocess.run,
                        ["git", "-C", clone_dir, "sparse-checkout", "set", subpath],
                        capture_output=True, text=True, timeout=60,
                    )
                    if r2.returncode == 0:
                        source = _confined_path(clone_dir, subpath)
                        if os.path.isdir(source):
                            target = _confined_path(temp_dir, skill_name)
                            shutil.copytree(source, target)
                            shutil.rmtree(clone_dir, ignore_errors=True)
                            return
                # Sparse checkout not supported or failed — clean up and fall through
                shutil.rmtree(clone_dir, ignore_errors=True)
            except subprocess.TimeoutExpired:
                shutil.rmtree(clone_dir, ignore_errors=True)
            except Exception:
                shutil.rmtree(clone_dir, ignore_errors=True)

        # Fallback: download repo zip and extract the subdirectory
        zip_url = f"https://github.com/{owner}/{repo}/archive/refs/heads/{branch}.zip"
        staging_name = f"{repo}-staging"
        await self._download_archive(zip_url, temp_dir, staging_name)

        staging_root = _confined_path(temp_dir, staging_name)
        staging_path = Path(staging_root)
        top_dirs = [d for d in staging_path.iterdir() if d.is_dir() and not d.name.startswith(".")]
        if len(top_dirs) == 1:
            subdir_resolved = _confined_path(str(top_dirs[0]), subpath)
        else:
            subdir_resolved = _confined_path(staging_root, subpath)

        if not os.path.isdir(subdir_resolved):
            raise UrlFetchError(f"Path '{subpath}' not found in repository")

        target = _confined_path(temp_dir, skill_name)
        shutil.copytree(subdir_resolved, target)
        shutil.rmtree(staging_root, ignore_errors=True)

    async def _fetch_npm(self, url: str, temp_dir: str, skill_name: str) -> None:
        """Fetch an npm package tarball."""
        m = _NPM_PACKAGE_RE.match(url) or _NPM_REGISTRY_RE.match(url)
        if not m:
            raise UrlFetchError("Could not parse npm package name from URL")

        pkg_name = m.group("name")
        registry_url = f"https://registry.npmjs.org/{pkg_name}/latest"

        try:
            import json
            data = await asyncio.to_thread(self._download_bytes, registry_url)
            manifest = json.loads(data)
            tarball_url = manifest.get("dist", {}).get("tarball")
            if not tarball_url:
                raise UrlFetchError(f"No tarball URL found for npm package: {pkg_name}")
        except (json.JSONDecodeError, KeyError) as e:
            raise UrlFetchError(f"Failed to parse npm registry response: {e}")

        await self._download_archive(tarball_url, temp_dir, skill_name)

    async def _download_archive(self, url: str, temp_dir: str, skill_name: str) -> None:
        """Download and extract a zip or tar archive."""
        parsed_path = urlparse(url).path.lower()
        is_tar = parsed_path.endswith((".tar.gz", ".tgz"))
        is_zip = parsed_path.endswith(".zip")

        if not is_tar and not is_zip:
            # Default to zip for unknown extensions
            is_tar = False

        ext = ".tar.gz" if is_tar else ".zip"
        archive_path = _confined_path(temp_dir, f"{skill_name}{ext}")

        await asyncio.to_thread(self._download_file, url, archive_path)

        target = _confined_path(temp_dir, skill_name)
        os.makedirs(target, exist_ok=True)

        try:
            if is_tar:
                await asyncio.to_thread(self._safe_extract_tar, archive_path, target)
            else:
                await asyncio.to_thread(self._safe_extract_zip, archive_path, target)
        finally:
            if os.path.exists(archive_path):
                os.unlink(archive_path)

    def _download_bytes(self, url: str) -> bytes:
        """Download URL content as bytes with size limit."""
        req = Request(url, headers={"User-Agent": "SecureVector-SkillScanner/1.0"})
        try:
            resp = urlopen(req, timeout=DOWNLOAD_TIMEOUT)
        except HTTPError as e:
            if e.code == 404:
                raise UrlFetchError("URL not found (404)")
            raise UrlFetchError(f"HTTP error {e.code}: {e.reason}")
        except URLError as e:
            raise UrlFetchError(f"Network error: {e.reason}")

        chunks = []
        total = 0
        while True:
            chunk = resp.read(65536)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_DOWNLOAD_BYTES:
                raise UrlFetchError(f"Download exceeds {MAX_DOWNLOAD_BYTES // 1_000_000} MB limit")
            chunks.append(chunk)

        return b"".join(chunks)

    def _download_file(self, url: str, dest: str) -> None:
        """Stream download to file with size limit."""
        req = Request(url, headers={"User-Agent": "SecureVector-SkillScanner/1.0"})
        try:
            resp = urlopen(req, timeout=DOWNLOAD_TIMEOUT)
        except HTTPError as e:
            if e.code == 404:
                raise UrlFetchError("URL not found (404)")
            raise UrlFetchError(f"HTTP error {e.code}: {e.reason}")
        except URLError as e:
            raise UrlFetchError(f"Network error: {e.reason}")

        total = 0
        with open(dest, "wb") as f:
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_DOWNLOAD_BYTES:
                    raise UrlFetchError(f"Download exceeds {MAX_DOWNLOAD_BYTES // 1_000_000} MB limit")
                f.write(chunk)

    def _safe_extract_zip(self, archive_path: str, dest: str) -> None:
        """Extract zip with path traversal protection."""
        with zipfile.ZipFile(archive_path) as zf:
            file_count = 0
            for info in zf.infolist():
                if info.filename.startswith("/") or ".." in info.filename:
                    raise UrlFetchError(f"Unsafe path in archive: {info.filename}")
                if info.is_dir():
                    continue
                file_count += 1
                if file_count > MAX_EXTRACTED_FILES:
                    raise UrlFetchError(f"Archive contains more than {MAX_EXTRACTED_FILES} files")
                zf.extract(info, dest)

    def _safe_extract_tar(self, archive_path: str, dest: str) -> None:
        """Extract tar with path traversal protection."""
        with tarfile.open(archive_path) as tf:
            file_count = 0
            for member in tf.getmembers():
                if member.name.startswith("/") or ".." in member.name:
                    raise UrlFetchError(f"Unsafe path in archive: {member.name}")
                if member.issym() or member.islnk():
                    continue  # skip symlinks
                if member.isfile():
                    file_count += 1
                    if file_count > MAX_EXTRACTED_FILES:
                        raise UrlFetchError(f"Archive contains more than {MAX_EXTRACTED_FILES} files")
                tf.extract(member, dest, set_attrs=False)

    def _find_skill_root(self, temp_dir: str) -> str:
        """Find the actual skill root — archives often have a single top-level dir."""
        root = Path(temp_dir)
        children = [c for c in root.iterdir() if c.is_dir() and not c.name.startswith(".")]

        # If there's exactly one subdirectory containing the skill, descend into it
        if len(children) == 1:
            inner = children[0]
            inner_children = [c for c in inner.iterdir() if not c.name.startswith(".")]
            # If the inner dir has actual content (files/dirs), use it as root
            if inner_children:
                return str(inner)

        return temp_dir

    @staticmethod
    def cleanup(temp_dir: str) -> None:
        """Remove a temp directory."""
        if temp_dir and os.path.exists(os.path.realpath(temp_dir)):
            shutil.rmtree(temp_dir, ignore_errors=True)

    @staticmethod
    def cleanup_stale(max_age: int = STALE_AGE_SECONDS) -> int:
        """Remove sv_skill_* temp dirs older than max_age seconds."""
        tmp = Path(tempfile.gettempdir())
        now = time.time()
        removed = 0
        try:
            for entry in tmp.iterdir():
                if entry.is_dir() and entry.name.startswith(TEMP_PREFIX):
                    try:
                        age = now - entry.stat().st_mtime
                        if age > max_age:
                            shutil.rmtree(entry, ignore_errors=True)
                            removed += 1
                    except OSError:
                        pass  # Cannot stat entry — skip
        except OSError:
            pass  # Cannot list temp directory — skip
        return removed


def install_skill(source_path: str, skill_name: str, skills_dir: str | None = None) -> str:
    """Copy a scanned skill from temp to the skills directory.

    Returns the install path.
    Raises UrlFetchError on failure.
    """
    # Sanitize skill name first (no filesystem taint).
    safe_name = re.sub(r"[^a-zA-Z0-9._-]", "-", skill_name)[:100]
    if not safe_name:
        raise UrlFetchError("Invalid skill name")

    # --- Source validation (must be under system temp) ---
    tmp_root = os.path.realpath(tempfile.gettempdir())
    source = os.path.realpath(source_path)

    # Guard: source must be under $TMPDIR.
    if not source.startswith(tmp_root + os.sep):
        raise UrlFetchError("Source path must be in the system temp directory")
    if not os.path.isdir(source):
        raise UrlFetchError("Source path does not exist")

    # --- Target construction (under home by default) ---
    home_dir = os.path.realpath(os.path.expanduser("~"))
    if skills_dir:
        target_root = os.path.realpath(skills_dir)
    else:
        target_root = os.path.join(home_dir, ".openclaw", "skills")

    # Guard: target must be under $HOME.
    if not target_root.startswith(home_dir + os.sep) and target_root != home_dir:
        raise UrlFetchError("Target directory must be under home directory")

    target = os.path.join(target_root, safe_name)
    if os.path.exists(target):
        raise UrlFetchError(f"Skill '{safe_name}' already exists at {target}")

    os.makedirs(target_root, exist_ok=True)
    shutil.copytree(source, target)

    # Cleanup temp source
    shutil.rmtree(source, ignore_errors=True)

    return target
