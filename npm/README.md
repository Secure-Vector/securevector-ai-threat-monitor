# SecureVector for npm

Security and observability for AI agents. This package is the launcher for
people whose toolchain is Node; the product itself is a Python application
published on PyPI, and this installs and runs the matching version.

```bash
npm install -g @securevector/cli
securevector
```

or without installing anything globally:

```bash
npx @securevector/cli
```

## What happens when you install it

Nothing. `npm install` writes files and stops. It runs no install script and
makes no network request beyond fetching the package itself.

The first time you actually run `securevector`, it creates a virtual
environment under your own data directory and installs the matching release
from PyPI, telling you what it is doing as it does it. Every run after that
starts immediately.

That is deliberate. A postinstall script that downloads and executes code is
the exact supply-chain shape this product exists to warn people about. It would
be a strange thing for a security tool to ship, however convenient, so it does
not.

## Requirements

Python 3.10 or newer, on PATH. This package will not install a language runtime
for you. If Python is missing or too old, `securevector doctor` says so and
tells you what to do.

## Commands

```
securevector [app] [...]     Start the local app (default)
securevector monitor [...]   The sv-monitor CLI, including session commands
securevector proxy [...]     The LLM proxy
securevector mcp [...]       The MCP server
securevector doctor          Check this machine and report what is missing
securevector where           Print the managed environment path
securevector --version
```

Everything after the verb is passed through untouched, so

```bash
securevector monitor session list
```

is exactly `sv-monitor session list`.

## Versions

The npm version and the PyPI version are the same number for the same product.
`npm install @securevector/cli@6.0.0` gives you exactly what
`pip install securevector-ai-monitor==6.0.0` gives you. The launcher pins that
exact version and never resolves `latest`.

## Uninstalling

```bash
npm uninstall -g @securevector/cli
rm -rf "$(securevector where)"     # run this first, it needs the command
```

## Licence

Apache-2.0. See the repository for the full text.
