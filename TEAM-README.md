# Team README

This short team README contains repository-level conventions and commands
that every contributor should follow to avoid unnecessary diffs and ensure a
consistent developer experience across platforms.

Checklist
- [ ] Read the sections below on line endings and Git configuration
- [ ] Run the recommended commands once after cloning

1) Line endings (.gitattributes)
--------------------------------
- This repository includes a `.gitattributes` file that enforces LF
  (\n) line endings for source files and documentation and CRLF for
  Windows-specific scripts (PowerShell / .bat) where appropriate.
- Why: consistent EOLs avoid noisy diffs and CI/linter warnings (e.g.
  "no newline at end of file").

2) Recommended local Git settings
---------------------------------
Set your local Git so it does not automatically convert line endings. We
use `.gitattributes` to control normalization per-file.

PowerShell (Windows):
```powershell
# run in repository root (one-time)
git config core.autocrlf false
```

macOS / Linux:
```bash
# run in repository root (one-time)
git config core.autocrlf false
```

3) Normalize repository files (one-time, after .gitattributes changes)
-------------------------------------------------------------------
If `.gitattributes` was added or changed, run these commands in the repo
root to apply normalization and commit the result:

PowerShell / Bash:
```bash
# stage .gitattributes
git add .gitattributes

# renormalize all files according to .gitattributes
git add --renormalize .

# inspect and commit
git status --porcelain
git commit -m "Add .gitattributes and normalize line endings"
```

4) Editor/IDE suggestions
-------------------------
- Configure your editor to use LF for new files (unless you edit a
  Windows script that requires CRLF).
- Enable "trim trailing whitespace" and "insert final newline" if
  available.

5) General project notes
------------------------
- The project uses modern JavaScript modules. Logging is implemented in
  `src/utils/logger.js` and exposes `createLogger(module)` which returns a
  child logger annotated with a `module` field.
- Follow the existing JSDoc block comment style when adding public functions.

6) If you run into problems
---------------------------
- If you see unexpected diffs after pulling, run `git status` and
  `git diff` to inspect. If necessary, re-run the renormalized steps above.
- Ask on the team's chat or open an issue in this repository with the
  exact `git status` / `git diff` output.

Thank you — small, consistent steps keep the repository healthy for every
contributor.
