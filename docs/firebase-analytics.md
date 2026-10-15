# Firebase usage analytics

The app integrates Google Analytics for Firebase through the pinned native React Native Firebase App and Analytics modules. Expo and existing wallet dependency versions are unchanged. Real Android and iOS app SDK configurations are now connected to the Firebase project below. This native integration has **not** been compiled, installed or runtime-verified; no real analytics events have been validated.

## Firebase project and app configuration

Configured on 2026-10-15:

- Project: **EOS3 Wallet**, ID **`eos3-wallet`**, project number `472446921872`.
- Plan: **Spark** (free); billing was not upgraded.
- GA4 property: **`eos3-wallet`**, ID **`559137524`**, in the existing Analytics account.
- Report timezone: **China time (GMT+08:00)**.
- Android app: `1:472446921872:android:2ee6bd7fa65128b38b3c15`, stream `16134784303`.
- iOS app: `1:472446921872:ios:5fe8a9348dd904538b3c15`, stream `16134673680`.
- Both app identifiers remain `com.eos3.wallet`; the downloaded app SDK files are in the locations below.
- Cloud privacy settings: Google Signals remains off; ad personalization is disallowed in all **307** regions; granular location/device data collection is off. No Google Ads or AdMob link was created.

[Firebase project](https://console.firebase.google.com/project/eos3-wallet/overview) · [GA4 administration](https://analytics.google.com/analytics/web/#/a130435257p559137524/admin)

To replace these configurations for an independent distribution:

1. Create a Firebase project and enable Google Analytics. Choose the reporting timezone intentionally (Asia/Shanghai for the existing operation's daily reporting).
2. Register an Android app with package **`com.eos3.wallet`** and an Apple app with bundle identifier **`com.eos3.wallet`** in that same project.
3. Download the **app SDK configuration** files and place them at:
   - `firebase/google-services.json`
   - `firebase/GoogleService-Info.plist`
4. Alternatively, set `GOOGLE_SERVICES_JSON` / `GOOGLE_SERVICE_INFO_PLIST` to files accessible to the build. These also work with EAS file environment variables. A supplied but missing path is rejected. Bundle/package mismatches and mismatched project IDs are rejected.

These files are app SDK configuration, **not service-account private keys**. Never put a service-account key, admin credentials, wallet key, or signing certificate in this directory. The checked-in app configuration files were downloaded from the authorized project; they contain no placeholders. Project creation is not performed by app startup or build scripts. Treat SDK API keys as public app identifiers; review Google API restrictions in the real project before publishing the app configuration.

Android and iOS are enabled independently when their corresponding validated configuration exists. An unconfigured platform, web, Expo Go and normal development builds do not initialize the JavaScript Analytics adapter. Fresh native defaults keep collection off until JavaScript checks the saved preference. With no saved preference, configured release builds then enable basic analytics automatically. Firebase persists runtime collection choices across launches; a previously enabled installation can resume native analytics before JavaScript starts. Existing disabled choices are preserved. Absence of configuration does not prevent wallet startup.

For public isolated builds, the configuration files must be included as reviewed, non-secret build inputs. External paths are not magically copied into the credential-free compilation sandbox. No service-account or wallet credentials are required for client analytics.

## What is measured

In configured release builds, basic analytics is **on by default** after checking the saved preference. Users can turn it off under **Me → Security Center → Usage statistics**. There is no first-launch analytics prompt. While enabled, the native Firebase SDK supplies its automatic events:

- `first_open`: new activations after installation/reinstallation when collection starts;
- `session_start` and `user_engagement`: active use, used by GA4 activity and retention reports;
- the SDK's standard platform, version and technical installation metadata.

The app does **not** manually send these reserved events. It does not create a custom installation identifier or call a custom event, screen-view, user-ID or user-property API. There are no wallet hooks, account labels, RPC parameters, balances, public/private keys, transaction IDs, signatures or DApp URLs in the analytics interface.

Metrics cover installations with collection enabled that successfully reach Google. Users who disable collection are excluded. They are not counts of unique human beings, all APK downloads, or all installations. First activation can occur later than installation when a user enables collection later. Reinstalling, clearing app data or disabling/re-enabling statistics can change the identifier and affect new-user/retention counts. Existing releases have no retroactive statistics.

## Collection preference and privacy controls

- The runtime preference is **on by default** only when no saved choice exists, and stored separately from wallet storage. Explicit disabled choices remain disabled across launches. Invalid or unreadable preferences stay off. Fresh native startup defaults stay off until this choice has been checked; the native defaults are intentionally not changed to avoid overriding an earlier opt-out before JavaScript runs. Firebase runtime settings persist across launches, so previously enabled installations may resume native collection at startup. SDK errors do not block the wallet and are not forwarded to another telemetry service.
- Disabling stops collection, denies analytics storage and resets the local Firebase Analytics identifier. This is not a request to erase historical server-side aggregates.
- `ad_storage`, `ad_user_data` and `ad_personalization` are denied in native defaults and on every runtime preference change.
- Android advertising-ID, SSAID and automatic screen collection are disabled. Advertising / AdServices permissions are blocked in the manifest merge.
- iOS IDFV collection and ad-network registration are disabled. The official Analytics plugin excludes IDFA support and on-device ad-conversion measurement.
- No Ads linkage, Google Signals or advertising data-sharing settings are enabled by this code. The project has no Ads/AdMob linkage; Google Signals is off, all regions disallow ad personalization, and granular location/device collection is off in GA4. App code cannot enforce settings changed later in the Google console. Settings on the existing parent Analytics account were not changed.
- Firebase still processes its standard usage/technical metadata and network requests on Google's infrastructure. The integration is not a claim of completely anonymous collection. Keep this processing and the default-on/opt-out behavior accurately described in the published privacy policy. The default-on implementation does not implement regional consent handling or establish that prior consent is unnecessary in every distribution region.

## Native integration and next build

The official Analytics config plugin always supplies `withoutAdIdSupport: true`. The optional app plugin registers native initialization only for configured platforms and preserves mods for other platforms. RNFirebase 26 uses its official default iOS SPM mode with dynamic frameworks, configured through `expo-build-properties`. Android keeps offline compilation and independent fixed certificate signing. The additional Firebase artifacts must be prepared in the existing dependency-download stage before a future offline build; this task does not download/build native artifacts or populate new Gradle caches.

Only the new SDK packages and their transitive dependencies are added. The new Firestore web transitive dependency's gRPC version is overridden to **1.14.6** to address advisories affecting its older ~1.9 dependency; Firestore/web analytics are not used by the native wallet. Dependency installation scripts remain disabled, registry signatures are verified, and the dependency inventory/checksum is reviewed. Existing dependency audit findings are not silently fixed by upgrading Expo or wallet libraries.

## Verification before shipping (not executed here)

After authorizing a future build (the real project files are now supplied):

1. Inspect merged Android permissions/metadata and the iOS Podfile/framework selection, Info.plist and privacy manifests. Confirm advertising support remains excluded.
2. Install the newly built APK/IPA. The currently installed builds do not contain these native SDK modules or this settings UI.
3. In a release build with a test Firebase stream, verify a fresh installation automatically enables basic statistics only after its preference check; inspect native Firebase DebugView events. An installation with a saved disabled preference must never enable collection during startup.
4. Confirm automatic first-open/session/activity events appear without duplicates, with no wallet/DApp/transaction parameters. Verify foreground/background and later launches retain the same instance while enabled.
5. Disable, relaunch and verify collection remains disabled. Then check a failed local preference write and a network outage without disrupting wallet operations.
6. Check GA4 new-user/activity/retention reports after processing. Retention requires real users returning over subsequent days and cannot be proven by one startup or unit tests.

References: [Expo Firebase integration](https://docs.expo.dev/guides/using-firebase/), [RNFirebase setup](https://rnfirebase.io/), [Analytics privacy/configuration](https://rnfirebase.io/analytics/usage), [Google event definitions](https://support.google.com/analytics/answer/9234069), [Google data collection controls](https://firebase.google.com/docs/analytics/configure-data-collection).
