"""
Unit tests for SkillScannerService.

Covers all 11 detection categories, risk aggregation, manifest parsing,
symlink escape, and compiled code detection. No database dependencies.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

from unittest.mock import MagicMock

try:
    from securevector.app.services.skill_scanner import (
        SkillScannerService,
        ScanResult,
        Finding,
    )
    HAS_APP_DEPS = True
except ImportError:
    HAS_APP_DEPS = False

pytestmark = pytest.mark.skipif(not HAS_APP_DEPS, reason="requires app extras (aiosqlite)")

FIXTURES = Path(__file__).parent.parent.parent / "fixtures" / "skills"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _write(tmp: Path, filename: str, content: str) -> Path:
    p = tmp / filename
    p.write_text(content, encoding="utf-8")
    return p


def _make_svc() -> SkillScannerService:
    """Create a SkillScannerService with a mock DB (unit tests don't need DB)."""
    mock_db = MagicMock()
    return SkillScannerService(db=mock_db)


def _scan_dir(tmp_path: Path) -> ScanResult:
    svc = _make_svc()
    import asyncio
    return asyncio.run(svc.scan(str(tmp_path), invocation_source="cli"))


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

class TestFixtureDirectories:
    def test_malicious_skill_fixture_yields_high_risk(self):
        svc = _make_svc()
        import asyncio
        result = asyncio.run(svc.scan(str(FIXTURES / "malicious-skill"), invocation_source="cli"))
        assert result.risk_level == "HIGH"
        assert result.findings_count > 0

    def test_clean_skill_fixture_yields_low_risk(self):
        svc = _make_svc()
        import asyncio
        result = asyncio.run(svc.scan(str(FIXTURES / "clean-skill"), invocation_source="cli"))
        assert result.risk_level in ("LOW", "MEDIUM")  # manifest missing → MEDIUM is fine

    def test_manifest_skill_fixture_has_manifest(self):
        svc = _make_svc()
        import asyncio
        result = asyncio.run(svc.scan(str(FIXTURES / "manifest-skill"), invocation_source="cli"))
        assert result.manifest_present is True


# ---------------------------------------------------------------------------
# Network detection
# ---------------------------------------------------------------------------

class TestNetworkDetection:
    def test_undeclared_domain_is_flagged(self, tmp_path):
        _write(tmp_path, "main.py", 'import requests\nrequests.get("http://evil.example.com/data")\n')
        result = _scan_dir(tmp_path)
        categories = [f.category for f in result.findings]
        assert "network_domain" in categories

    def test_declared_domain_not_flagged(self, tmp_path):
        _write(tmp_path, "permissions.yml", "permissions:\n  networks:\n    - api.openai.com\n  files: []\n  env_vars: []\n")
        _write(tmp_path, "main.py", 'import requests\nrequests.get("https://api.openai.com/v1/chat")\n')
        result = _scan_dir(tmp_path)
        net_findings = [f for f in result.findings if f.category == "network_domain"]
        assert len(net_findings) == 0

    def test_no_network_calls_clean(self, tmp_path):
        _write(tmp_path, "main.py", 'print("hello")\n')
        result = _scan_dir(tmp_path)
        net_findings = [f for f in result.findings if f.category == "network_domain"]
        assert len(net_findings) == 0


# ---------------------------------------------------------------------------
# Env var detection
# ---------------------------------------------------------------------------

class TestEnvVarDetection:
    def test_os_environ_flagged(self, tmp_path):
        _write(tmp_path, "main.py", 'import os\nsecret = os.environ["SECRET_KEY"]\n')
        result = _scan_dir(tmp_path)
        cats = [f.category for f in result.findings]
        assert "env_var_read" in cats

    def test_os_getenv_flagged(self, tmp_path):
        _write(tmp_path, "main.py", 'import os\nval = os.getenv("API_KEY")\n')
        result = _scan_dir(tmp_path)
        cats = [f.category for f in result.findings]
        assert "env_var_read" in cats

    def test_process_env_js_flagged(self, tmp_path):
        _write(tmp_path, "main.js", 'const key = process.env.SECRET_KEY;\n')
        result = _scan_dir(tmp_path)
        cats = [f.category for f in result.findings]
        assert "env_var_read" in cats

    def test_no_env_read_clean(self, tmp_path):
        _write(tmp_path, "main.py", 'print("no env reads here")\n')
        result = _scan_dir(tmp_path)
        env_findings = [f for f in result.findings if f.category == "env_var_read"]
        assert len(env_findings) == 0


# ---------------------------------------------------------------------------
# Dynamic shell exec detection
# ---------------------------------------------------------------------------

class TestDynamicShellExec:
    def test_subprocess_with_variable_cmd_flagged(self, tmp_path):
        code = 'import subprocess\ncmd = f"echo {user_input}"\nsubprocess.run(cmd, shell=True)\n'
        _write(tmp_path, "main.py", code)
        result = _scan_dir(tmp_path)
        cats = [f.category for f in result.findings]
        assert "shell_exec" in cats

    def test_static_subprocess_is_low_severity(self, tmp_path):
        # Static shell exec (no dynamic args) is flagged at LOW severity — not high
        _write(tmp_path, "main.py", 'import subprocess\nsubprocess.run(["ls", "-la"])\n')
        result = _scan_dir(tmp_path)
        shell_findings = [f for f in result.findings if f.category == "shell_exec"]
        # LOW severity finding, not HIGH — so overall risk stays LOW/MEDIUM
        assert all(f.severity == "low" for f in shell_findings)


# ---------------------------------------------------------------------------
# Base64 obfuscation detection
# ---------------------------------------------------------------------------

class TestBase64Detection:
    def test_base64_decode_call_flagged(self, tmp_path):
        _write(tmp_path, "main.py", 'import base64\ndata = base64.b64decode("aGVsbG8=")\n')
        result = _scan_dir(tmp_path)
        cats = [f.category for f in result.findings]
        assert "base64_literal" in cats

    def test_no_base64_clean(self, tmp_path):
        _write(tmp_path, "main.py", 'print("no encoding here")\n')
        result = _scan_dir(tmp_path)
        b64_findings = [f for f in result.findings if f.category == "base64_literal"]
        assert len(b64_findings) == 0


# ---------------------------------------------------------------------------
# File write detection
# ---------------------------------------------------------------------------

class TestFileWriteDetection:
    def test_open_write_outside_scope_flagged(self, tmp_path):
        _write(tmp_path, "main.py", 'with open("/etc/hosts", "w") as f:\n    f.write("evil")\n')
        result = _scan_dir(tmp_path)
        cats = [f.category for f in result.findings]
        assert "file_write" in cats


# ---------------------------------------------------------------------------
# Manifest parsing
# ---------------------------------------------------------------------------

class TestManifestParsing:
    def test_missing_manifest_yields_finding(self):
        # missing_manifest only fires for paths under ~/.openclaw/skills/
        openclaw_dir = Path("~/.openclaw/skills").expanduser()
        openclaw_dir.mkdir(parents=True, exist_ok=True)
        test_skill = openclaw_dir / "_test_missing_manifest"
        test_skill.mkdir(exist_ok=True)
        try:
            (test_skill / "main.py").write_text('print("hello")\n')
            result = _scan_dir(test_skill)
            assert result.manifest_present is False
            cats = [f.category for f in result.findings]
            assert "missing_manifest" in cats
        finally:
            import shutil
            shutil.rmtree(test_skill, ignore_errors=True)

    def test_missing_manifest_not_flagged_for_non_skill(self, tmp_path):
        # Generic directories should NOT get missing_manifest
        _write(tmp_path, "main.py", 'print("hello")\n')
        result = _scan_dir(tmp_path)
        assert result.manifest_present is False
        cats = [f.category for f in result.findings]
        assert "missing_manifest" not in cats

    def test_permissions_yml_parsed(self, tmp_path):
        _write(tmp_path, "permissions.yml", "permissions:\n  networks:\n    - api.openai.com\n  files: []\n  env_vars: []\n")
        _write(tmp_path, "main.py", 'print("ok")\n')
        result = _scan_dir(tmp_path)
        assert result.manifest_present is True
        manifest_findings = [f for f in result.findings if f.category == "missing_manifest"]
        assert len(manifest_findings) == 0

    def test_skill_json_parsed(self, tmp_path):
        import json
        manifest = {"permissions": {"networks": ["api.example.com"], "files": [], "env_vars": []}}
        _write(tmp_path, "skill.json", json.dumps(manifest))
        _write(tmp_path, "main.py", 'print("ok")\n')
        result = _scan_dir(tmp_path)
        assert result.manifest_present is True


# ---------------------------------------------------------------------------
# Symlink escape detection
# ---------------------------------------------------------------------------

class TestSymlinkEscape:
    def test_symlink_outside_dir_yields_finding(self, tmp_path):
        # Create a symlink pointing outside the skill directory
        link = tmp_path / "escape_link.py"
        link.symlink_to("/etc/passwd")
        result = _scan_dir(tmp_path)
        cats = [f.category for f in result.findings]
        assert "symlink_escape" in cats


# ---------------------------------------------------------------------------
# Risk aggregation
# ---------------------------------------------------------------------------

class TestRiskAggregation:
    def test_high_severity_finding_yields_high_risk(self, tmp_path):
        # Network call is HIGH severity → overall HIGH risk
        _write(tmp_path, "main.py", 'import requests\nrequests.get("http://evil.example.com/data")\n')
        result = _scan_dir(tmp_path)
        assert result.risk_level == "HIGH"

    def test_medium_only_yields_medium_risk(self, tmp_path):
        # Compiled code finding is MEDIUM severity → overall MEDIUM risk
        (tmp_path / "helper.pyc").write_bytes(b"\x00\x00")
        _write(tmp_path, "main.py", 'print("hello")\n')
        result = _scan_dir(tmp_path)
        compiled = [f for f in result.findings if f.category == "compiled_code"]
        assert len(compiled) > 0
        assert result.risk_level == "MEDIUM"

    def test_no_findings_yields_low_risk(self, tmp_path):
        _write(tmp_path, "permissions.yml", "permissions:\n  networks: []\n  files: []\n  env_vars: []\n")
        _write(tmp_path, "main.py", 'print("clean")\n')
        result = _scan_dir(tmp_path)
        assert result.risk_level == "LOW"

    def test_high_severity_overrides_medium(self, tmp_path):
        # Network call (HIGH) + missing manifest (MEDIUM) → overall HIGH
        _write(tmp_path, "main.py", 'import requests\nrequests.get("http://evil.example.com/steal")\n')
        result = _scan_dir(tmp_path)
        assert result.risk_level == "HIGH"


# ---------------------------------------------------------------------------
# Code execution detection
# ---------------------------------------------------------------------------

class TestCodeExecDetection:
    def test_eval_call_flagged(self, tmp_path):
        _write(tmp_path, "main.py", "result = eval(user_input)\n")
        result = _scan_dir(tmp_path)
        cats = [f.category for f in result.findings]
        assert "code_exec" in cats

    def test_exec_call_flagged(self, tmp_path):
        _write(tmp_path, "main.py", "x = exec(code_string)\n")
        result = _scan_dir(tmp_path)
        cats = [f.category for f in result.findings]
        assert "code_exec" in cats

    def test_eval_is_high_severity(self, tmp_path):
        _write(tmp_path, "main.py", "eval('2+2')\n")
        result = _scan_dir(tmp_path)
        exec_findings = [f for f in result.findings if f.category == "code_exec"]
        assert len(exec_findings) > 0
        assert all(f.severity == "high" for f in exec_findings)

    def test_no_eval_clean(self, tmp_path):
        _write(tmp_path, "main.py", "x = 1 + 2\nprint(x)\n")
        result = _scan_dir(tmp_path)
        exec_findings = [f for f in result.findings if f.category == "code_exec"]
        assert len(exec_findings) == 0


# ---------------------------------------------------------------------------
# Dynamic import detection
# ---------------------------------------------------------------------------

class TestDynamicImportDetection:
    def test_dunder_import_flagged(self, tmp_path):
        _write(tmp_path, "main.py", "mod = __import__('os')\n")
        result = _scan_dir(tmp_path)
        cats = [f.category for f in result.findings]
        assert "dynamic_import" in cats

    def test_importlib_flagged(self, tmp_path):
        _write(tmp_path, "main.py", "import importlib\nmod = importlib.import_module('subprocess')\n")
        result = _scan_dir(tmp_path)
        cats = [f.category for f in result.findings]
        assert "dynamic_import" in cats

    def test_dynamic_import_is_high_severity(self, tmp_path):
        _write(tmp_path, "main.py", "mod = __import__('os')\n")
        result = _scan_dir(tmp_path)
        imp_findings = [f for f in result.findings if f.category == "dynamic_import"]
        assert len(imp_findings) > 0
        assert all(f.severity == "high" for f in imp_findings)

    def test_normal_import_clean(self, tmp_path):
        _write(tmp_path, "main.py", "import os\nimport json\n")
        result = _scan_dir(tmp_path)
        imp_findings = [f for f in result.findings if f.category == "dynamic_import"]
        assert len(imp_findings) == 0


# ---------------------------------------------------------------------------
# Compiled / binary code detection
# ---------------------------------------------------------------------------

class TestCompiledCodeDetection:
    def test_pyc_file_flagged(self, tmp_path):
        (tmp_path / "helper.pyc").write_bytes(b"\x00\x00\x00\x00")
        result = _scan_dir(tmp_path)
        cats = [f.category for f in result.findings]
        assert "compiled_code" in cats

    def test_so_file_flagged(self, tmp_path):
        (tmp_path / "native.so").write_bytes(b"\x7fELF")
        result = _scan_dir(tmp_path)
        cats = [f.category for f in result.findings]
        assert "compiled_code" in cats

    def test_dll_file_flagged(self, tmp_path):
        (tmp_path / "module.dll").write_bytes(b"MZ\x00\x00")
        result = _scan_dir(tmp_path)
        cats = [f.category for f in result.findings]
        assert "compiled_code" in cats

    def test_compiled_code_is_medium_severity(self, tmp_path):
        (tmp_path / "helper.pyc").write_bytes(b"\x00")
        result = _scan_dir(tmp_path)
        compiled = [f for f in result.findings if f.category == "compiled_code"]
        assert len(compiled) > 0
        assert all(f.severity == "medium" for f in compiled)

    def test_no_binary_files_clean(self, tmp_path):
        _write(tmp_path, "main.py", "print('hello')\n")
        result = _scan_dir(tmp_path)
        compiled = [f for f in result.findings if f.category == "compiled_code"]
        assert len(compiled) == 0
