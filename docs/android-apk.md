# Android APK packaging

Hivekeep ships a Capacitor Android project under `android/`. The APK scripts below are repeatable wrappers around the existing mobile web build, Capacitor sync, and Gradle APK tasks.

## Prerequisites

- Bun dependencies installed with `bun install`.
- Android Studio or Android SDK command-line tools installed.
- A JDK compatible with the Android Gradle plugin, with `JAVA_HOME` set.
- For release APKs only: a local Android signing keystore.
- A reachable Hivekeep server. The Android app is a client shell and does not
  start or embed the Bun/Hono server.

## Install on a device

Build either a debug or release APK, then install it on an Android device:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

For a locally signed release build:

```bash
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

You can also copy the APK to the device and open it there; Android may ask you
to allow installs from that source. Release updates must be signed with the same
keystore as the currently installed app.

## Debug APK

```bash
bun run mobile:android:apk:debug
```

The script runs `mobile:sync`, then Gradle `assembleDebug`. The APK is written to:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

Debug APKs use Android's debug signing key and are intended for local installation only.

## Locally signed release APK

Create a local keystore if you do not already have one:

```bash
keytool -genkeypair -v \
  -keystore ~/.hivekeep/android-release.jks \
  -alias hivekeep \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000
```

Set signing environment variables before packaging:

```bash
export HIVEKEEP_ANDROID_KEYSTORE="$HOME/.hivekeep/android-release.jks"
export HIVEKEEP_ANDROID_KEY_ALIAS="hivekeep"
export HIVEKEEP_ANDROID_KEYSTORE_PASSWORD="<keystore password>"
export HIVEKEEP_ANDROID_KEY_PASSWORD="<key password>" # optional; defaults to keystore password
bun run mobile:android:apk:release
```

PowerShell equivalent:

```powershell
$env:HIVEKEEP_ANDROID_KEYSTORE="$HOME/.hivekeep/android-release.jks"
$env:HIVEKEEP_ANDROID_KEY_ALIAS="hivekeep"
$env:HIVEKEEP_ANDROID_KEYSTORE_PASSWORD="<keystore password>"
$env:HIVEKEEP_ANDROID_KEY_PASSWORD="<key password>" # optional; defaults to keystore password
bun run mobile:android:apk:release
```

The signed release APK is written to:

```text
android/app/build/outputs/apk/release/app-release.apk
```

Keep the keystore and passwords out of git. Losing the keystore prevents future APK updates from using the same signing identity.

## Versioning

By default the APK script reads `package.json` and passes the package version into Gradle as `versionName`. It derives `versionCode` as:

```text
major * 10000 + minor * 100 + patch
```

For example, package version `1.9.0` produces Android version `1.9.0 (10900)`.

Override either value for a local build when needed:

```bash
HIVEKEEP_ANDROID_VERSION_NAME=1.9.1 \
HIVEKEEP_ANDROID_VERSION_CODE=10901 \
bun run mobile:android:apk:release
```

## Android app metadata

- Application id / package: `app.hivekeep.mobile`
- App name: `Hivekeep` (`android/app/src/main/res/values/strings.xml`)
- Launcher icon metadata: `android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml` and `ic_launcher_round.xml`
- Hivekeep icon vectors: `android/app/src/main/res/drawable/ic_launcher_background.xml` and `ic_launcher_foreground.xml`

## Self-hosted Hivekeep server notes

The mobile app is a packaged web client. On first launch it prompts for a
Hivekeep server URL and validates `GET <server>/api/health` before continuing.
The normalized `http://` or `https://` origin is stored on the device under the
localStorage key `hivekeep:serverUrl`; the mobile Settings page can update the
same value later.

- Do not use `localhost` from a physical Android device; it refers to the phone. Use a LAN hostname/IP or a public HTTPS URL for the server.
- From the Android emulator, use `http://10.0.2.2:<port>` to reach a server running on the host machine.
- Prefer HTTPS for release builds. If you test against plain HTTP, keep it limited to trusted local networks and expect Android/network policy or reverse proxy settings to be part of your local setup.
- Keep the server configured the same way as a normal self-hosted Hivekeep deployment. The mobile build's `.env.mobile` only enables mobile client behavior with `VITE_HIVEKEEP_MOBILE=true`.

## Trusted origins and auth

Native Capacitor requests originate from `capacitor://localhost`. The server's
credentialed CORS policy and Better Auth trusted origins include that origin so
the mobile app can send the same HTTP-only session cookie used by the web UI.

For browser or reverse-proxy access to the same server, continue to set
`PUBLIC_URL` to the URL users open and use `TRUSTED_ORIGINS` for any additional
browser origins. The Android app's configured server URL must still be reachable
from the device, and reverse proxies must forward cookies and SSE responses.

## Mobile API and SSE contract

In mobile builds (`VITE_HIVEKEEP_MOBILE=true`) and in the native Capacitor
runtime, client code builds absolute API URLs from the stored server URL:

- `buildApiUrl('/me')` -> `<server>/api/me`
- `buildApiUrl('/sse')` -> `<server>/api/sse`
- the connection screen probes `<server>/api/health` without requiring auth

The app uses credentialed fetches (`credentials: 'include'`) so login/session
cookies belong to the configured server. If the stored URL is missing in the
native runtime, API calls fail until the connection screen saves a valid server.

The global SSE stream remains `GET /api/sse`: one multiplexed EventSource per
client, with no mobile-specific event types. Mobile clients reconnect/refetch the
same way as the web client after sleep or network loss.

## Native notification polling

Android local notifications are best-effort and are driven by polling, not by a
push provider. In the native mobile runtime the client:

- polls `GET /api/notifications?unreadOnly=true&limit=10` when the app starts,
  every 60 seconds while mounted, and again when the app resumes;
- requests local-notification permission before scheduling notifications;
- creates the Android notification channel `hivekeep-unread`;
- remembers delivered notification ids locally under
  `hivekeep:nativeDeliveredNotificationIds` to avoid re-alerting for the same
  unread notification;
- routes notification taps to `/notifications`, `/tasks`, or an Agent page based
  on the notification type and `agentSlug`.

Polling failures are intentionally silent so a temporary network issue does not
block app usage.
