# Android APK packaging

Hivekeep ships a Capacitor Android project under `android/`. The APK scripts below are repeatable wrappers around the existing mobile web build, Capacitor sync, and Gradle APK tasks.

## Prerequisites

- Bun dependencies installed with `bun install`.
- Android Studio or Android SDK command-line tools installed.
- A JDK compatible with the Android Gradle plugin, with `JAVA_HOME` set.
- For release APKs only: a local Android signing keystore.

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

The mobile app is a packaged web client. It does not bundle a Hivekeep server; point it at a reachable self-hosted Hivekeep server from inside the app.

- Do not use `localhost` from a physical Android device; it refers to the phone. Use a LAN hostname/IP or a public HTTPS URL for the server.
- From the Android emulator, use `http://10.0.2.2:<port>` to reach a server running on the host machine.
- Prefer HTTPS for release builds. If you test against plain HTTP, keep it limited to trusted local networks and expect Android/network policy or reverse proxy settings to be part of your local setup.
- Keep the server configured the same way as a normal self-hosted Hivekeep deployment. The mobile build's `.env.mobile` only enables mobile client behavior with `VITE_HIVEKEEP_MOBILE=true`.
