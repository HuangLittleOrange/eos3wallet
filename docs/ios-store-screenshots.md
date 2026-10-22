# App Store screenshots for 1.0.10 (35)

The `iOS Store Screenshots` workflow builds the exact release source commit
`56c2bb5eaee6903e578cc6c378c594b76dc51a60` for the Apple simulator using Xcode
26.4.1. It does not upload or replace the App Store distribution binary.

The workflow has read-only repository permissions and receives no signing,
App Store Connect, SSH, wallet or production service credentials. Source code
and dependency checks use the same locked release inputs as build 35.

Each disposable iPhone 17 Pro and 13-inch iPad Pro simulator captures:

- The first-use screen with no wallet configured.
- The assets screen for the public `eosio` account in watch-only mode. This is
  a public system account, not an account owned or controlled by the operator.
  Its session is prepared in the simulator's ordinary AsyncStorage preferences;
  no signing key, fake balance, transaction or modified app screen is injected.
  Network data is fetched by the app itself.

The capture process sets English, light appearance and a consistent simulator
status bar. Analytics is disabled only for these disposable simulator sessions.
The application sources, production preferences and submitted IPA are unchanged.

Artifacts include the original PNGs, simulator app ZIP, build logs, simulator
inventory, image dimensions and SHA-256 checksums in `provenance.json`. Capture
success alone is not acceptance: visually inspect every screenshot for loading
states, dialogs, missing data, incorrect layout and unintended private data
before uploading it to App Store Connect.

Temporary simulators are shut down and removed in a `finally` block. The job
also removes its generated native project, dependencies and derived build data.
Preserve approved screenshots, provenance and the latest simulator package in
the stable release export directory before cleaning local download copies.

For a later release, review and update the pinned source commit, app version,
build number, device/runtime requirements and expected dimensions together.
