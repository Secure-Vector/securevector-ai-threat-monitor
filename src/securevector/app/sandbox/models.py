"""Sandbox session data models."""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional


@dataclass
class SandboxSession:
    id: str
    command: str
    profile: str = "default"
    status: str = "running"  # running, completed, failed, timed_out, killed
    pid: Optional[int] = None
    workspace: Optional[str] = None
    exit_code: Optional[int] = None
    stdout: Optional[str] = None
    stderr: Optional[str] = None
    duration_ms: Optional[int] = None
    started_at: str = field(default_factory=lambda: datetime.utcnow().isoformat())
    finished_at: Optional[str] = None
    agent_type: Optional[str] = None
    error: Optional[str] = None
