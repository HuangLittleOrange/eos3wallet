# EOS³ Wallet

**English** | [简体中文](README.zh-CN.md)

An EOS / Vaulta mobile wallet for the Vaulta mainnet, built with Expo SDK 57, React Native, and TypeScript.

## Features

- Private key import, watch-only accounts, paid account creation, Google / Passkey login, and device key authorization.
- Token balances, asset valuations, resource management, transaction history, transfers, and memos.
- RAM, staking, REX, PowerUp, and sponsored resources.
- Master-password encryption, biometric unlock, private key export, and permission management.
- An in-app DApp browser, Scatter / TokenPocket compatibility, ESR / Anchor signing, and session management.
- Contacts, QR codes, multiple languages, discovery content, and Android update checks.

## Local development

Use Node.js 22.13 or later and install dependencies from the committed lockfile. See the [Expo SDK 57 documentation](https://docs.expo.dev/versions/v57.0.0/).

Dependency installation scripts are disabled by default. The following entry point explicitly applies reviewed security patches. Tests and Metro builds check dependency origins, the lockfile, and patches; see [dependency security maintenance](docs/dependency-security.md).

```bash
npm run install:safe
npm start
```

Full wallet functionality requires a native development build. Android requires the Android SDK; iOS requires macOS and Xcode.

```bash
npm run android
npm run ios
```

For a web preview:

```bash
npm run web
```

The web preview does not provide every native secure storage, Passkey, or biometric capability.

Optional environment configuration:

```bash
cp .env.example .env.local
```

`EXPO_PUBLIC_CONTENT_API_URL` selects the service for discovery content, announcements, and help. The default service is used when this variable is unset. `EXPO_PUBLIC_*` values are included in the app bundle and must contain only public configuration.

## Validation

```bash
npm test -- --runInBand
npm run typecheck
npm run check:source
```

Native storage, Passkey, deep links, and signing flows also require testing on physical devices. Mainnet operations change real on-chain state; review the network, account, and transaction before signing.

Docker can install and verify dependencies, run tests, and generate Android / iOS JavaScript bundles without mounting host environment files, wallet backups, or signing credentials:

```bash
npm run verify:isolated
```

Results are saved in the ignored `exports/isolated-review/` directory. This entry point validates JavaScript bundles.

On macOS with JDK 17, Android SDK 36, Build Tools 36.0.0, NDK 27.1.12297006, and CMake 3.22.1 installed, generate a native test APK with:

```bash
npm run build:android:isolated
```

This local entry point builds an unsigned APK in a macOS sandbox, then signs it with a one-time test key in a separate sandbox. Outputs are saved in `exports/native-review/`. Compilation uses an offline Gradle dependency cache without copying host Gradle initialization scripts or credential settings; missing cache entries stop the build. Test signatures cannot replace an installation signed with the release certificate. See [native builds and signing](docs/native-build-security.md).

## Public Android builds

Pushing to `main` runs [Main tests](.github/workflows/main-tests.yml): dependency verification, unit tests, TypeScript checks, and Expo compatibility checks in credential-free containers. Test execution has no network access. These runs do not compile APKs, use signing secrets, or publish releases.

Pushing a stable version tag such as `v1.0.3` starts the [Android release workflow](.github/workflows/android-build.yml). The tag must match `app.json` → `expo.version`, and its source commit must already be on `main`. Lightweight and annotated tags are supported. Invalid tags, off-main commits, version mismatches, forced tag updates, and previously published versions are rejected before compilation. Never move or reuse a published version tag.

For a new release:

1. Update the application version and Android `versionCode` in `app.json`, commit to `main`, and wait for Main tests to pass. This application version is separate from the Expo SDK dependency.
2. Tag that reviewed commit and push only the intended tag. For example, after preparing app version `1.0.3`:

```bash
git tag -a v1.0.3 FULL_REVIEWED_COMMIT_SHA -m "EOS3 Wallet 1.0.3"
git push origin v1.0.3
```

The release workflow compiles offline, signs with the fixed certificate in an independent network-disabled sandbox, generates GitHub artifact attestations, and publishes an English GitHub Release. These stages use separate runners. Signing secrets are restricted to version tags in the `android-production-signing` environment and are available only to the independent signing step.

Each release uses its version tag, displays the actual APK application version, and provides three downloads: the APK, an outer checksum file, and a complete evidence ZIP. The ZIP includes the original unsigned APK, provenance, public certificate, metadata, source hashes, logs, and third-party notices. A successful release becomes Latest, which the introduction website reads on page load to update its version and download information.

Open **Actions → Main tests** for routine checks and **Actions → Public Android APK** for release build logs, hashes, and provenance. See [public builds and provenance verification](docs/github-android-build.md) for signing environment setup and verification commands. No version tag is created automatically by pushing to `main`.

Provenance binds files to a repository, workflow, and specific source commit. It does not establish an independent security audit or byte-for-byte reproducible builds.

## Wallet security

Ordinary private keys are encrypted with AES-GCM using a key derived from the master password and stored in system secure storage. When biometrics are enabled, the master password is saved in a secure storage entry that requires system authentication. Temporary private keys for accounts awaiting activation are protected by system secure storage and moved into the regular encrypted vault when the wallet is saved. Passkey wallets do not store the asset private key on the client.

Transfers and DApp signatures require user confirmation. Sponsored transactions check the actual actions and fees. Third-party bindings check that transfer permissions and on-chain limits match the confirmation. Only verifiable, restricted payment bindings are supported; additional general-purpose contract actions are rejected. See [binding security](docs/binding-security.md).

Exporting a private key displays it in plaintext; copying it writes it to the system clipboard. Protect exported keys carefully. Browser connections are authorized by site, account, and network, and remain available only during the current browser session. Disconnecting revokes access. Persistent DApp sessions can be revoked in session management.

## External services and privacy

This repository contains the wallet client. Some login, content, update, and sponsorship features depend on external services. The client stores asset private keys locally; signed transactions and necessary request data are sent to the relevant services.

| Recipient | Related data |
| --- | --- |
| RPC / history nodes | Account lookups, public key lookups, balances, history requests, and broadcast transactions |
| Market data services | Token or trading pair queries |
| Google / Passkey login services | Login authorization, credential registration, and authentication information |
| Android QR scanning SDK (Google ML Kit) | Device and app information, installation identifiers, API performance, and usage diagnostics; recognition inputs and results are processed on the device. See [ML Kit privacy terms](https://developers.google.com/ml-kit/terms). |
| Google Analytics for Firebase (on by default) | Automatic first-open/session/activity events, an analytics installation identifier and standard device/app metadata; no wallet accounts, balances, keys, transactions, DApp URLs or advertising collection. See [collection details](docs/firebase-analytics.md). |
| Authorization and sponsorship services | Accounts, authorization settings, transactions awaiting signatures, and signing results |
| Content, image, and update services | Network requests, platform information, and app versions used for update checks |
| DApp / ESR / Anchor Link | Accounts, public keys, signatures, and connection information; persistent session messages pass through a relay service |

On-chain accounts and transactions are public. External services may also record request IP addresses and times. After the user approves a connection, the DApp browser discloses the account and public key to that HTTPS site. Compatibility APIs also provide language, operating system, app version, and a random device identifier generated for each site.

This section describes client data flows and does not replace the privacy policies of connected services.

## Independent distribution

For an independent distribution, configure your own app identifiers, domain associations, build settings, and service addresses:

| Location | Configuration |
| --- | --- |
| `app.json` / `app.config.ts` / `eas.json` | App identity, native permissions, and build configuration |
| `src/passkey/constants.ts` | Login, Passkey, and sponsorship service configuration |
| `src/chain/config.ts` | Networks, nodes, and contracts |
| `src/content/defaults.json` | Built-in content and links |
| `well-known/` | Domain-to-app association statements |

Changing a Passkey domain requires compatible services and app associations, as well as consideration of existing credentials. See [deep link integration](docs/universal-links.md).

## Project structure

```text
src/
├── chain/        Chain configuration, wallet state, resources, transaction checks
├── crypto/       Key generation and encrypted storage
├── passkey/      Login and Passkey signing
├── dapp/         DApp protocols and sessions
├── content/      Content loading
├── net/          Network requests
├── update/       Android updates
├── components/   Shared components
├── screens/      Screens
├── navigation/   Navigation and deep links
├── i18n/         Translations
└── theme.ts      Styling
```

## License

The project is licensed under the [MIT License](LICENSE). Third-party dependencies and assets retain their respective licenses and copyright notices; see [third-party notices](THIRD_PARTY_NOTICES.md). Include the required notices when distributing app packages.

Full-package update checks run at startup on iOS and Android. No OTA JavaScript updates are enabled. See [release configuration and update behavior](docs/app-updates.md).
