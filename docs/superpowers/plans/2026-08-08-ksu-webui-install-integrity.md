# KSU WebUI Install and Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement each task with a test-first cycle.

**Goal:** Make KernelSU install the KSU WebUI assets and visibly flag local module metadata tampering.

**Architecture:** The installer preserves `webroot/` while extracting a module with `SKIPUNZIP=1`. Gradle adds a packaged integrity manifest. The boot service verifies the manifest and the WebUI renders the resulting status.

**Tech Stack:** Gradle Kotlin DSL, Android shell, vanilla JavaScript, Node test runner.

## Global Constraints

- Keep all user configuration under `/data/adb/tricky_store` outside the signed module payload.
- Treat local integrity verification as a tamper-evidence signal, not an enforcement boundary.
- Preserve the existing KSU `ksu` API and atomic configuration-write behavior.

---

### Task 1: Test and repair WebUI installation

**Files:**
- Modify: `tests/webui/app.test.mjs`
- Modify: `module/customize.sh`

- [ ] Write a test that reads `module/customize.sh` and expects a structure-preserving `webroot/*` extraction plus an `index.html` existence check.
- [ ] Run `node --test tests/webui/app.test.mjs` and confirm the new test fails because the installer currently omits WebUI assets.
- [ ] Add the minimal extraction and existence check to `customize.sh`.
- [ ] Run `node --test tests/webui/app.test.mjs` and confirm all tests pass.

### Task 2: Add a packaged integrity manifest and status surface

**Files:**
- Modify: `app/build.gradle.kts`
- Create: `module/verify_integrity.sh`
- Modify: `module/service.sh`
- Modify: `module/webroot/app.js`
- Modify: `tests/webui/app.test.mjs`

- [ ] Write failing tests for required manifest fields and the WebUI integrity status parser.
- [ ] Generate the manifest in the module staging directory after all package files are copied.
- [ ] Verify the manifest in `service.sh` before the daemon starts, writing `/data/adb/tricky_store/module_integrity_status`.
- [ ] Render a visible WebUI warning only when the status file reports a mismatch.
- [ ] Run the Node test suite and Gradle packaging checks.

### Task 3: Commit and publish

**Files:**
- Modify: touched implementation and test files

- [ ] Run `git diff --check` and `node --test tests/webui/app.test.mjs`.
- [ ] Commit the installer and integrity changes.
- [ ] Push the synchronized `main` branch to `origin`.
