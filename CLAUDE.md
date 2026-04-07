# securevector-ai-threat-monitor Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-02-01

## Active Technologies
- Python 3.10+, JavaScript ES6+ + FastAPI, aiosqlite, pywebview (existing — no new dependencies) (007-llm-cost-tracking)
- SQLite via existing `DatabaseConnection` — two new tables via migration v12 (007-llm-cost-tracking)
- TypeScript (hook handler), JavaScript ES6+ (integration page UI), Python 3.10+ (existing backend) + OpenClaw hook API (external), FastAPI (existing backend), native `fetch` (TypeScript handler) (008-openclaw-hooks-integration)
- N/A (hook is stateless; analysis results stored by existing SecureVector backend) (008-openclaw-hooks-integration)
- Python 3.10+, JavaScript ES6+ + FastAPI, aiosqlite, pywebview 5.0+, uvicorn (all existing — no new dependencies) (001-skill-scanner)
- SQLite via existing `DatabaseConnection`; new `skill_scan_records` table via migration V18 (001-skill-scanner)

- Python 3.10+, JavaScript ES6+ + pywebview 5.0+, FastAPI, uvicorn (existing) (005-crossplatform-lightweight-ui)

## Project Structure

```text
backend/
frontend/
tests/
```

## Commands

cd src [ONLY COMMANDS FOR ACTIVE TECHNOLOGIES][ONLY COMMANDS FOR ACTIVE TECHNOLOGIES] pytest [ONLY COMMANDS FOR ACTIVE TECHNOLOGIES][ONLY COMMANDS FOR ACTIVE TECHNOLOGIES] ruff check .

## Code Style

Python 3.10+, JavaScript ES6+: Follow standard conventions

## Recent Changes
- 008-openclaw-hooks-integration: Added TypeScript (hook handler), JavaScript ES6+ (integration page UI), Python 3.10+ (existing backend) + OpenClaw hook API (external), FastAPI (existing backend), native `fetch` (TypeScript handler)
- 001-skill-scanner: Added Python 3.10+, JavaScript ES6+ + FastAPI, aiosqlite, pywebview 5.0+, uvicorn (all existing — no new dependencies)
- 007-llm-cost-tracking: Added Python 3.10+, JavaScript ES6+ + FastAPI, aiosqlite, pywebview (existing — no new dependencies)

- 005-crossplatform-lightweight-ui: Added Python 3.10+, JavaScript ES6+ + pywebview 5.0+, FastAPI, uvicorn (existing)

<!-- MANUAL ADDITIONS START -->
## Git

- Never commit. The user handles all commits themselves.

## Skills to Use

### UI / Frontend
- **`frontend-design:frontend-design`** — use when building or redesigning any web UI components, pages, or layouts in `src/securevector/app/assets/web/`; produces polished, production-grade vanilla JS following the existing page-object pattern

### Feature Architecture & Code Quality
- **`feature-dev:feature-dev`** — use for deep feature analysis, understanding existing patterns, and planning changes that span multiple backend modules
- **`/simplify`** — run after implementation to review changed code for quality, reuse, and efficiency

### Security / Skill Scanner Domain
- When implementing or extending the Skill Scanner (`src/securevector/app/services/skill_scanner.py`), apply security-expert judgement: static analysis only, no code execution, check each of the 7 finding categories (network_domain, env_var_read, shell_exec, code_exec, dynamic_import, file_write, base64_literal), plus compiled_code, symlink_escape, missing_manifest. Community rule library is intentionally excluded — it targets LLM text, not source code. AI review (if enabled) provides context-aware false-positive filtering. Respect the severity-based risk aggregation (critical/high → HIGH, medium-only → MEDIUM, none/low → LOW)
<!-- MANUAL ADDITIONS END -->
