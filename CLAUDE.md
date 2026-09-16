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

## Versioning — two files, and mind which copy you are reading

`__version__` is declared **twice** and both must move together on every
release bump:

- `src/securevector/__init__.py` — the package version
- `src/securevector/app/__init__.py` — the app version (its own comment says
  to keep it in sync with the package one)

`src/securevector/mcp/__init__.py` and the plugin `package.json` /
`plugin.json` files carry **independent** version lines. Do not bump those to
match the app version.

**Before concluding the version is stale, check where you are reading it
from.** A pip-installed copy in `site-packages` shadows this checkout, and
sibling git worktrees sit on older branches, so `import securevector` or a
bare `python -m securevector.app.main` can report an older version while this
checkout is already correct:

```bash
# which copy is being imported, and what does it claim?
python -c "import securevector; print(securevector.__file__, securevector.__version__)"

# what this checkout actually says
grep -n '__version__' src/securevector/__init__.py src/securevector/app/__init__.py
```

Run the app from source so it loads this checkout rather than the installed
copy: `PYTHONPATH=src python -m securevector.app.main --web`.

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

## Session continuity (every 10 interactions)

Every ~10 user-message interactions, write a fresh session summary so the conversation can be `/compact`-ed without losing state. Rules:

- **Path:** `.claude/sessions/session-YYYY-MM-DD-HHMM.md` (this directory is gitignored — line 29 of `.gitignore`).
- **Never commit session summaries.** They are local-only scratch state. Do not stage, do not add to git, do not include in PRs.
- **What to capture:** active task + sub-task, files in flight (path + what changed), pending TODOs, last command run, any uncommitted-but-applied edits, and the immediate next step. Skip transient tool output, full diffs, and conversation pleasantries.
- **Counting interactions:** count user messages, not tool calls. After every 10th user message, write the summary before responding to the 11th.
- **On resume after compaction:** read the most recent file in `.claude/sessions/` first to recover state.

## Skills to Use

### UI / Frontend
- **`frontend-design:frontend-design`** — use when building or redesigning any web UI components, pages, or layouts in `src/securevector/app/assets/web/`; produces polished, production-grade vanilla JS following the existing page-object pattern

### Feature Architecture & Code Quality
- **`feature-dev:feature-dev`** — use for deep feature analysis, understanding existing patterns, and planning changes that span multiple backend modules
- **`/simplify`** — run after implementation to review changed code for quality, reuse, and efficiency

### Security / Skill Scanner Domain
- When implementing or extending the Skill Scanner (`src/securevector/app/services/skill_scanner.py`), apply security-expert judgement: static analysis only, no code execution, check each of the 7 finding categories (network_domain, env_var_read, shell_exec, code_exec, dynamic_import, file_write, base64_literal), plus compiled_code, symlink_escape, missing_manifest. Community rule library is intentionally excluded — it targets LLM text, not source code. AI review (if enabled) provides context-aware false-positive filtering. Respect the severity-based risk aggregation (critical/high → HIGH, medium-only → MEDIUM, none/low → LOW)
## Release 6.0.0 — branch model and release steps

6.0.0 is a multi-feature release built over ten weeks. Dates: **code freeze
Fri 20 Nov 2026**, **launch Tue 1 Dec 2026**. Headline feature: **Agent
Terminals** (rail label "Terminals"): launch a Claude Code task from the app,
click it to attach to its live terminal (PTY owned by the app, xterm.js over
a per-session WebSocket), verdict rail beside it, approvals through the
existing JIT inbox.

### Branches

- `release/6.0.0` — integration branch, cut from `master` after 5.3.0. Every
  6.0.0 feature merges here first. It is **not** pushed or PR'd until freeze.
  It has no upstream on purpose: never `git push` it without an explicit
  refspec, and never push it to `master`.
- `feat/<issue>-<slug>` — one branch per story, cut from `release/6.0.0`,
  checked out in a sibling worktree `securevector-ai-threat-monitor--<issue>`
  (current: `feat/208-agent-terminals` in `--208`). Follow-up work for a
  story stays on that story's branch; do not open a new branch per PR.
- Feature branches PR into `release/6.0.0`. At freeze, `release/6.0.0` opens
  two PRs from the one branch, to `develop` and to `master` (same as 5.2.0
  and 5.3.0).
- The user commits and pushes; Claude stages and leaves changes in the tree.

### Version bump

Bump `__version__` in **both** `src/securevector/__init__.py` and
`src/securevector/app/__init__.py` to `6.0.0` on the release branch at
freeze, not on feature branches (feature branches keep 5.3.0 so they merge
cleanly). Leave `securevector/mcp/__init__.py` and the plugin manifests
alone unless they changed.

### Release steps (owner runs these, in order)

1. Freeze on Fri 20 Nov: all feature PRs merged into `release/6.0.0`, version
   bumped to 6.0.0 in both files, CHANGELOG entry written, ten-user preview
   build cut from `release/6.0.0`.
2. Preview week: no new scope on `release/6.0.0`; fixes only, each as its own
   commit. Publish one governed-calls number from the preview.
3. Push `release/6.0.0` and open two PRs from it, to `develop` and to
   `master`. Wait for CodeQL, comprehensive-testing, and the security scan to
   pass; clear bot findings on the PR branch (`sv-security-bot` skill).
4. Merge to `master`, tag `v6.0.0`, publish the GitHub release. Publishing
   triggers PyPI trusted publishing via `release.yml`; the tag triggers
   `build-installers.yml` for the macOS, Windows, and Linux installers.
5. Verify: `pip install -U "securevector-ai-monitor[app]==6.0.0"` and launch
   the app; the Terminals rail entry must be present and a task must attach.
6. Merge the same branch to `develop`. Then launch kit, docs, and website go
   out on Tue 1 Dec.

### 6.0.0 scope guard

- Claude Code executor only. macOS and Linux full PTY; Windows streams-only.
- One attached terminal at a time. Tasks run in the folder the user picks
  (worktree isolation is 6.1). Executor in Python; no Node sidecar.
- If late on 30 Oct, cut in this order: approvals inbox, board restore, cost
  figure. The security exit criteria, the attached-terminal demo, and the
  preview are never cut.
- Security exit criteria (all required before freeze): cookie-based token
  bootstrap; CSP with pinned, hashed, vendored xterm.js (no `unsafe-eval`,
  see the pywebview CSP note in the desktop shell); token file and audit DB
  readable only by the installing OS user; risky xterm.js escape handlers
  (OSC 52 clipboard, file OSCs) disabled; UI keystrokes audited as their own
  event type with a test proving a typed "y" cannot pass a hard Guard deny;
  crash-dump and telemetry redaction at parity with disk; unverified marking
  plus heartbeat timeout for screen-manifest status; startup reaper,
  orphaned-tasks view, and "stop all tasks" before uninstall or upgrade.
- Naming: "Agent Terminals" and "Terminals" only. Never "Mission Control",
  never "firewall", never "Command" or "Control" next to "Agent". Unit of
  work is a task; the verb is launch.

<!-- MANUAL ADDITIONS END -->
