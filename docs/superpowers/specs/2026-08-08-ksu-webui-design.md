# KSU WebUI Design

## Goal

Add a self-contained KernelSU WebUI for TEESimulator-RS that manages the module's target packages, keybox assignment, patch-level configuration, boot-property mode, and persisted-key cleanup without requiring a reboot.

## Design Read

Reading this as a high-density mobile configuration surface for technically experienced KernelSU users. The interface uses a Material 3-inspired, trust-first language with `DESIGN_VARIANCE: 3`, `MOTION_INTENSITY: 2`, and `VISUAL_DENSITY: 7`.

The implementation uses native HTML, CSS, and JavaScript rather than React or a front-end build system. KernelSU loads static files from a module's `webroot` directory, and the existing Gradle `Sync` task already copies the complete `module` directory into the final ZIP.

## Scope

The WebUI provides these operations:

1. List installed user applications, search by package label or ID, and add them to `target.txt`.
2. Read, edit, remove, and persist target modes: `auto`, `generate`, and `patch`.
3. Enumerate `*.xml` files in `/data/adb/tricky_store` and assign each target package to a keybox group.
4. Read and persist global or package-specific patch settings in `security_patch.txt`.
5. Read and persist `boot_props_mode` as `auto`, `force`, or `disable`.
6. Clear all persisted keys after an explicit confirmation step.

The WebUI does not expose keybox contents, modify `keybox.xml`, manage module installation, or start or stop the daemon.

## Files

```
module/
  webroot/
    index.html       WebUI entry point and semantic page structure
    app.css          Material-inspired responsive styling and theme tokens
    kernelsu.js      Vendored KernelSU JavaScript bridge, version 3.0.2
    app.js           State, config parsing, root command construction, rendering, and events
tests/
  webui/
    app.test.mjs     Node tests for parser, serializer, and command builders
```

`kernelsu.js` is copied from the Apache-2.0 licensed `kernelsu@3.0.2` package. The page imports it with a relative ES module path, so no browser-side package resolution or build step is required.

## Page Structure

The page has a compact header with the module identifier and a refresh control. A tab bar switches between the following panels:

### Targets

The Targets panel contains a search input and a package list. Every saved package row exposes:

- Application icon when KernelSU supplies `ksu://icon/<package>`.
- Label and package ID.
- Mode segmented control: Auto, Generate, Patch.
- Keybox select populated from discovered XML file names.
- Remove command.

Search results are sourced from `listPackages("user")` and `getPackagesInfo()`. A search result can be added with the default `auto` mode and default `keybox.xml`. Unsaved edits are held in page state until the user invokes the single Save action.

The saved `target.txt` serializer groups packages by keybox. The default `keybox.xml` group has no header. Other groups use `[filename.xml]`. `generate` serializes with `!`, `patch` serializes with `?`, and `auto` has no suffix.

### Patch Levels

The Patch Levels panel contains a global editor and an optional per-package override editor. Each editor has fields for `system`, `vendor`, `boot`, and `all`. Values are restricted to `today`, `prop`, `device_default`, `no`, or `YYYY-MM-DD`.

The serializer writes the global configuration first. Each non-empty application override then receives a `[package.name]` section. The UI preserves the module behavior that `system=prop` causes the running service to derive `vendor` and `boot` from device properties.

### System

The System panel uses a segmented control for Boot props mode and shows the current raw value. A destructive Clear persisted keys command opens a confirmation dialog that names `persistent_keys` and requires a second deliberate action.

## Root Data Flow

KernelSU's `exec()` runs as root. Reads use fixed commands only:

```
cat /data/adb/tricky_store/target.txt
cat /data/adb/tricky_store/security_patch.txt
cat /data/adb/tricky_store/boot_props_mode
find /data/adb/tricky_store -maxdepth 1 -type f -name '*.xml' -printf '%f\\n'
```

Writes never concatenate user-provided values into shell command text. JavaScript validates package IDs, modes, keybox names, and patch values before serializing content. It Base64-encodes the complete file contents, writes a same-directory temporary file through `base64 -d`, sets mode `0644`, and atomically replaces the destination with `mv`. Atomic replacement generates the existing `MOVED_TO` FileObserver event and reloads the daemon configuration.

Clearing persisted keys uses a fixed root command that deletes only `*.bin` and `*.tmp` inside `/data/adb/tricky_store/persistent_keys`, then recreates the directory with mode `0700`.

## State and Error Handling

Initial loading displays skeleton rows. The page treats a missing optional config file as an empty configuration and surfaces other failures inline with stderr detail. A disabled Save button prevents concurrent writes. Successful operations show a KernelSU toast and reload all state from disk. All commands validate `errno`; no success message is shown for a failed root operation.

The page supports both system light and dark themes, honors reduced-motion preferences, provides visible keyboard focus, uses labels above fields, and keeps all primary actions reachable on narrow phone screens.

## Test Strategy

Node's built-in test runner validates pure functions exported by `app.js`:

1. Parse and serialize every `target.txt` mode and keybox grouping.
2. Parse and serialize global and per-package patch-level sections.
3. Reject invalid package names, keybox filenames, and patch values.
4. Produce Base64-backed atomic write commands without embedding raw user text.
5. Produce only the bounded persisted-key cleanup command.

An archive-level smoke test builds or stages the module and asserts the ZIP contains `webroot/index.html`, `webroot/app.css`, `webroot/app.js`, and `webroot/kernelsu.js`.

## Compatibility

The module already rejects KernelSU versions below `KSU_VER_CODE=10670`. The WebUI adds no separate manager dependency and retains Magisk and APatch compatibility because `webroot` is inert outside KernelSU Manager.
