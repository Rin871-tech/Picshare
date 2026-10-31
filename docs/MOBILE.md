# PicShare mobile and friend discovery

## Implemented

- Signup first for new visitors; login and Google sign-in retained. Existing
  accounts and conversations remain stored in MongoDB, independent of sessions.
- Prominent Messages entry, labeled New message action, larger navigation controls.
- Instagram-style name/username search without requiring a Google account.
- Separate opt-in Google Contacts lookup using People API contacts.readonly.
- Device contact selection (native app; supported browsers use Contact Picker).
  Matching currently uses email addresses, not phone numbers. Phone-only matching
  requires verified phone ownership and an OTP provider; it is not implemented.
- Matching only returns public profiles that explicitly opted in. Blocks apply.
  Address books and Google access tokens are not persisted or logged by PicShare.
  Native contact selection uses the community Contacts plugin, whose Android
  permission group requests read/write contacts; PicShare only uses its picker.
- Capacitor Android/iOS projects; bundled frontend, HTTPS backend configuration,
  native Google login bridge, Keychain/Keystore session storage, permission text.

## Build

Use Node 22 or newer. `npm ci`, then `npm run mobile:sync`.
`npm run android:debug` compiles a debug APK when the Android SDK, Java 21,
Gradle and Maven downloads are available. `npm run ios:open` opens the generated
project; full Xcode 26+, Apple signing, and a simulator/device are needed.
Generated frontend assets are staged from `frontend/`; never edit them manually.
No live-reload/server.url is committed. External fonts, maps and Socket.IO CDN
assets still require network access (as does the backend).

`PICSHARE_BACKEND_URL` defaults to the verified demo backend origin
`https://picshare-5qf9.onrender.com`. It must be an HTTPS origin without a path.
App identifier `com.example.picshare` is a placeholder: replace it in Capacitor
and regenerate/rename native projects before store registration or OAuth setup.

## Backend deployment

Deploy the updated Node source before testing the app. The backend permits the exact default bundled WebView origins
`https://localhost` (Android) and `capacitor://localhost` (iOS). Override them with
`MOBILE_CLIENT_ORIGINS` if needed; keep `CLIENT_ORIGIN` set to the website's exact
HTTPS origin. Do not use wildcard CORS. Do not change the database
or existing JWT secret. No database migration/reset is required.

Google Contacts needs the Google People API enabled in the same Cloud project,
Contacts read-only scope on the consent screen, the website's authorized origin,
and authorized test users while OAuth is in testing. It is separate from sign-in;
users grant consent when they click Find Google contacts. Public rollout may
require Google's scope verification.

Native Google login needs an Android OAuth client registered with the final app
ID and signing SHA fingerprint. Use the existing web/server client ID for backend
ID token verification. For iOS, supply `PICSHARE_IOS_GOOGLE_CLIENT_ID` at mobile
build time and register the reversed client ID URL scheme in Info.plist. Follow
the installed SocialLogin plugin's Google setup guide. Email login remains usable
while these external settings are pending; do not use Google web login in WebViews.

## Validation and limits

48 local integration tests passed, including persistent messaging, authentication,
contact opt-in, privacy, and blocking. Browser smoke test: returning account login,
open Messages, username search, send a synthetic message, and reload to see the
saved conversation. No real Google/phone contacts were accessed during testing.
Native contacts, Google OAuth, calls, notifications and location need device tests.
Background/terminated-app calls and push notifications are not implemented.

The Render free demo has ephemeral photo files. Accounts and text messages are
in Atlas; photos can disappear on a restart. Do not use this demo for durable media.

References: https://capacitorjs.com/docs/getting-started/environment-setup,
https://developers.google.com/people/api/rest/v1/people.connections/list,
https://github.com/Cap-go/capacitor-social-login/blob/main/docs/setup_google.md

Android debug compilation succeeded locally with Gradle 8.14.3 and the installed
Android SDK. This is a debug build, not signed for store distribution. iOS
compilation was not run: full Xcode is not installed.
