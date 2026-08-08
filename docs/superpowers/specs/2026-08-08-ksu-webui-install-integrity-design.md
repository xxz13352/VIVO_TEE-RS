# KSU WebUI Install and Integrity Design

## Goal

Make the packaged KSU WebUI available after a KernelSU installation and surface local module metadata tampering to users.

## Root Cause

The Gradle packaging task already includes `module/webroot/*`. `customize.sh` sets `SKIPUNZIP=1` and manually extracts its installation whitelist, which omits `webroot/*`. The installed module therefore has no `webroot/index.html`, so KernelSU has no WebUI entry to discover.

## Design

`customize.sh` will extract `webroot/*` preserving its directory structure and fail installation if `webroot/index.html` is absent afterwards. This keeps the installer as the only point that needs special handling for `SKIPUNZIP=1`.

The build will generate an `integrity.json` manifest in the module root. It records the official module identity and SHA-256 hashes of `module.prop`, `service.sh`, `customize.sh`, and all WebUI runtime assets. `service.sh` will verify it before launching the daemon and write a local status file. The status is advisory: root users can alter both a module file and its manifest, so it is a visible anti-resale deterrent rather than a trust boundary.

The WebUI will read the status file and render an inline warning when the installed content differs from the packaged manifest. It will retain normal configuration controls when verification is unavailable, avoiding an outage caused by a missing optional status file.

## Validation

- Node tests prove the installer includes the `webroot/*` extraction step.
- Node tests prove the manifest contains the required identity and runtime assets.
- The existing WebUI asset test continues to verify all browser runtime files.
- GitHub Actions packages `zipDebug` and `zipRelease`; opening the module from KernelSU should display the WebUI entry after installation.
