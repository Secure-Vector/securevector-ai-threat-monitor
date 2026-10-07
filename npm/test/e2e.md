# End-to-end check for the npm launcher

Not automated in `npm test`, because it installs a real package from PyPI and
takes minutes. Run it by hand before a release.

```bash
cd npm
npm pack                                   # -> securevector-cli-<version>.tgz

TMP=$(mktemp -d)
cd "$TMP" && npm init -y >/dev/null
npm install /path/to/securevector-cli-<version>.tgz

./node_modules/.bin/securevector --version # the version, instantly
./node_modules/.bin/securevector doctor    # "installed  no, the first run will set it up"
./node_modules/.bin/securevector monitor --version
                                           # first run: announces, creates the venv,
                                           # installs from PyPI, then runs
./node_modules/.bin/securevector doctor    # "installed  yes"
time ./node_modules/.bin/securevector monitor --version
                                           # second run: well under a second, silent
```

What to check, beyond "it ran":

- **`npm install` printed no download of its own.** If it did, something grew an
  install script and the supply-chain promise in the README is now false.
- **The first run said what it was going to do before doing it.** A silent
  network install from a security product is the thing this package exists not
  to do.
- **The second run is fast and quiet.** If it reinstalls, `isReady` is looking
  at the wrong path for this platform.
- **The PyPI version installed matches the npm version.** `pip list` inside
  `$(securevector where)/v<version>` should show the same number.
- **A verb that does not exist in the installed release fails in the Python
  process, not the launcher.** That is the pin working: the launcher does not
  invent commands the pinned release does not have.

Clean up:

```bash
rm -rf "$(./node_modules/.bin/securevector where)" "$TMP"
```
