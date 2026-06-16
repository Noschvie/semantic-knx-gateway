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

IntelliJ IDEA (Windows) — recommended project settings
------------------------------------------------------
If you use IntelliJ / WebStorm on Windows, follow these exact steps to avoid
accidentally saving files with CRLF and to keep behaviour consistent with the
repository `.gitattributes` (which enforces LF for source files):

1. Project line separator
   - File → Settings → Editor → Code Style → Line separator
   - Set to: "Unix and OS X (\n)" or choose "Use project default" if the
     project already uses LF.

2. Ensure final newline and trim trailing spaces
   - File → Settings → Editor → General
   - Enable: "Ensure line feed at file end on Save"
   - Set: "Strip trailing spaces on Save" → "All"

3. Per-file quick check and conversion
   - The bottom-right status bar shows the current file's line endings (CRLF/LF).
   - Click it to change per-file if needed.

4. Helpful Git setting
   - In the terminal (project root):
     ```powershell
     git config core.autocrlf false
     ```

Note: the repository `.gitattributes` will ensure files are stored with LF in
git; IntelliJ configured as above will keep your working copy consistent and
avoid accidental CRLF commits.

Thank you — small, consistent steps keep the repository healthy for every
contributor.
