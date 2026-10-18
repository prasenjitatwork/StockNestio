# StockNestio Android app

This Android app opens `https://aaravisyumbox.themidastouche.com/` as a Trusted Web Activity. It uses the hosted app and its existing Google Sheets connection; inventory data is not copied into the Android package.

## Build and install

Open this `android` folder in Android Studio and let Gradle sync. Build the debug APK from **Build → Build Bundle(s) / APK(s) → Build APK(s)**. The APK is created at `app/build/outputs/apk/debug/app-debug.apk`. Install it on a device with:

```powershell
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

Publish the updated `index.html`, `manifest.json`, and the two `assets/stocknestio-icon-*.png` files to the website. Upload the included `.well-known/assetlinks.json` to `https://aaravisyumbox.themidastouche.com/.well-known/assetlinks.json`. It is signed for the debug certificate on the development computer; if you build on another computer, replace the fingerprint with that build's SHA-256 certificate fingerprint. Serve it as `application/json` over HTTPS without redirects. Until the file is live, Android opens the site in a browser tab rather than a verified full-screen activity.

For Google Play, publish a release-signed APK or app bundle and add the **Play App Signing** SHA-256 certificate fingerprint to `assetlinks.json`; the debug fingerprint is only for local development installs.

The website must also have Google OAuth configured and the Sheets API enabled. Sign-in, workbook reads, and writes use the existing hosted PHP backend.
