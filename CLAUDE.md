# securevector-ai-threat-monitor Development Guidelines

Auto-generated from all feature plans. Last updated: 2026-02-01

## Active Technologies
- Python 3.10+, JavaScript ES6+ + FastAPI, aiosqlite, pywebview (existing — no new dependencies) (007-llm-cost-tracking)
- SQLite via existing `DatabaseConnection` — two new tables via migration v12 (007-llm-cost-tracking)

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
- 007-llm-cost-tracking: Added Python 3.10+, JavaScript ES6+ + FastAPI, aiosqlite, pywebview (existing — no new dependencies)

- 005-crossplatform-lightweight-ui: Added Python 3.10+, JavaScript ES6+ + pywebview 5.0+, FastAPI, uvicorn (existing)

<!-- MANUAL ADDITIONS START -->
## Git

- Never commit. The user handles all commits themselves.
<!-- MANUAL ADDITIONS END -->
