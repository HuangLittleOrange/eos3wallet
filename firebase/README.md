# Firebase app configuration

The real client SDK files are connected to **EOS3 Wallet** (`eos3-wallet`, Spark plan):

- `google-services.json` — Android package `com.eos3.wallet`
- `GoogleService-Info.plist` — iOS bundle ID `com.eos3.wallet`

Both apps use the same Firebase project and GA4 property `559137524`. These are app SDK configurations, not service-account credentials. **Do not place service-account private keys, wallet data or signing credentials here.**

Usage analytics is on by default in configured release builds after the stored preference is checked. Users can disable it in Me → Security Center → Usage statistics; an existing disabled choice is preserved. Fresh native defaults keep collection off until that preference check completes. Firebase persists runtime choices across launches; previously enabled installations can resume collection at native startup. No first-launch prompt is added. Google Signals, ad personalization and granular location/device collection are off in the project. Native compilation, installation and real event verification have not been performed.

For an independent distribution, replace both files with configurations from your own project. See [the integration and verification guide](../docs/firebase-analytics.md).
