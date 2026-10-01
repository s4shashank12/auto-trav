# auto-naitra for Android

The whole bot on one phone: no VM, no Postgres, no Firebase. The app plays your accounts in the
background and shows the same dashboard as the web version, with every setting and editor.

> The same warning as for the server applies: the game's rules forbid automated play. The app
> makes no attempt to hide itself, and stops an account and marks it in the dashboard if the game
> shows a CAPTCHA.

## Install

1. Get the APK:
   - from the **Actions** tab: the latest "Android" run → Artifacts → `auto-naitra-apk` (a zip
     with the APK inside); or
   - from a GitHub release, when a `v*` tag was pushed; or
   - build it yourself (below).
2. Open it on the phone and allow installing from that source when Android asks.
3. Open **auto-naitra**:
   - allow notifications (the notification shows what runs and has **Stop all**);
   - on the **This phone** card, tap **Allow** next to Battery, so Android does not pause the bot
     while the screen is off. Some phone makers (Xiaomi, Huawei, Samsung, OnePlus...) have their
     own battery savers on top: allow "auto-launch" / "background activity" / "unrestricted"
     for the app there too.
4. **Add server** (game world URL, account name, password), check the settings, press **Start**.

Updates install over the previous version and keep your accounts and settings, as long as both
were signed with the same key (see Signing).

> Run each account in one place only. If the VM backend also plays an account, stop it there
> first: two bots on one account fight over the build queue and the active village.

## What you get

Everything the server does, on the phone:

- building, supply, hero resources, training, research, Smithy, reinforcement, oasis raids
  with farm lists, the hero's adventures and oasis clearing, and inactive-player raids with the
  daily `map.sql` import;
- the dashboard: overview, Army / Buildings / Raiding editors (drag and drop or tap), inactive
  players, live logs and error screenshots, Run now, and every setting;
- several accounts at once, each with its own cookies (see below);
- accounts that were running start again after the phone restarts or the app is updated.

## How it works

```
 MainActivity (the dashboard, dashboard/)            BotService (foreground service)
┌────────────────────────────────────┐  bridge   ┌──────────────────────────────────────────┐
│ WebView: the React dashboard        │ ────────▶ │ engine WebView (off screen)               │
│ window.AutoNaitraAndroid.request()  │ ◀──────── │  src/ bot + engine/src (API, workers)     │
└────────────────────────────────────┘           │    │ Native bridge (BotEngine.kt)          │
                                                 │    ├─ SQLite (BotDatabase.kt)             │
                                                 │    ├─ Keystore AES-GCM (Secrets.kt)       │
                                                 │    └─ game pages: one off-screen WebView  │
                                                 │       per account, own profile (GamePage) │
                                                 └──────────────────────────────────────────┘
```

- **The bot is the same code as on the server.** `engine/build.mjs` bundles `src/` (unchanged)
  with `engine/src`. Where the server has Playwright and Chromium, the engine has
  `engine/src/shims/playwright.js`: the part of Playwright's API that `src/travian.js` uses
  (`goto`, `evaluate`, locators with `:has`, `filter`, `getByRole`, `fill`, `click`, `check`,
  `waitForResponse`...), carried out in Android WebViews.
- **Game pages** are WebViews that are never put on screen. They load pages like the server's
  Chromium: a 1280×900 viewport, a desktop user agent, no images.
- **Accounts stay apart.** Each account gets its own WebView profile (cookies and storage),
  like a Playwright browser context. Older WebViews without profiles (before Android System WebView 110 or
  so) share one cookie jar: accounts then take turns, and each one's cookies are put back
  before its turn.
- **Storage** is SQLite in the app's private storage, with the server's tables (`servers`,
  `server_kv`, `events`, `world_villages`); the engine creates and migrates them
  (`engine/src/repo.js`).
- **Passwords** are encrypted with AES-256-GCM using a key in the Android Keystore that never
  leaves the phone. Nothing is backed up or moved to another phone.
- **Background running.** The engine lives in a foreground service. While an account runs, the
  app holds a partial wake lock, so rounds happen on time with the screen off. Its timers run on
  the app's side, not in the WebView. With nothing running and the app closed, the service stops.
- **The dashboard** is `dashboard/` itself. It finds `window.AutoNaitraAndroid` and sends its API
  requests there instead of over HTTP (`dashboard/src/api.js`). The engine answers them with the
  server's routes and responses (`engine/src/api.js`).

### Battery and data

A running account keeps the CPU from sleeping and loads game pages every round (about every
10 minutes with raids on, 20 to 40 without). Expect noticeable battery use: keep the phone on a
charger if it plays all day. Images are never loaded, so data use stays small.

### Phone requirements

- Android 8.0 or newer.
- An up-to-date **Android System WebView** (or Chrome), version 105 or newer, from the Play Store.
  The bot's selectors use CSS `:has()`.

## Build

You need Node 22, JDK 17+ and the Android SDK (platform 36). Gradle builds the engine and the
dashboard into the APK's assets itself (`npm ci` + esbuild + Vite):

```bash
cd android
echo "sdk.dir=$ANDROID_HOME" > local.properties   # or set ANDROID_HOME
./gradlew assembleRelease                           # app/build/outputs/apk/release/app-release.apk
./gradlew assembleDebug                             # debuggable; chrome://inspect shows its WebViews
```

`APP_VERSION` and `VERSION_CODE` set the version (CI sets them; local builds are `<x.y>-dev`).

### Signing

- **Your own key.** Builds use it when `ANDROID_KEYSTORE_FILE`, `ANDROID_KEYSTORE_PASSWORD`,
  `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` are set. In CI, these are repository secrets
  (see `.github/workflows/android.yml`).
- **The debug key.** Without your own key, builds use `app/debug.keystore`. It is committed on
  purpose: every build, local or CI, can then update the app without losing its data. It only
  matters if someone could get you to install a different APK signed with it.

Android only installs an update signed with the same key as the installed app. To switch keys,
uninstall first: that deletes the accounts and settings on the phone.

## Tests

The engine runs in Node too, which is how it is tested: `engine/test/harness.js` plays the app's
part. Playwright's Chromium pages stand in for the WebViews, and `node:sqlite` for SQLite. The
tests run the real bot against a mock game world (`engine/test/mock-travian.js`). They cover:

- logging in, supplying a village, a hero top-up and building in Roman queue order;
- the hero raiding an oasis through the rally point;
- accounts kept apart, with profiles and with a shared cookie jar;
- rounds on a timer, CAPTCHA screenshots, and the API;
- the dashboard driven at phone size over the bridge.

```bash
npm ci                                  # repository root: Playwright
(cd dashboard && npm ci)
cd android/engine && npm ci && npm test
```
