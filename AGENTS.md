# AGENTS.md

Rules for AI agents (and people) changing Vibe TV. For anything visible, also follow
[DESIGN.md](DESIGN.md). Background: [README](README.md#project-layout),
[CONTRIBUTING.md](CONTRIBUTING.md), [ANDROID-PLAN.md](ANDROID-PLAN.md).

## One app, three targets

Vibe TV ships as a desktop app (Electron: macOS, Windows, Linux), an Android phone/tablet app and an
Android TV app. Phone and TV are the same APK. All three show **the same window**:

| Part | Where | Used by |
| --- | --- | --- |
| The window (UI) | `src/index.html`, `src/styles.css`, `src/app.js`, `src/m3u.js` | all three |
| Logic without a window | `lib/` | all three (Android bundles what it needs) |
| What the window may ask for | `platform/api-contract.js` | all three |
| Desktop answers | `boot.js`, `main.js`, `preload.js` | desktop |
| Android answers | `platform/android/*.js`, Kotlin plugins in `android/` | phone, TV |
| Phone and TV layout | `platform/android/android.css` | phone, TV |
| Remote control | `platform/android/tv-focus.js` | TV |
| Touch | `platform/android/touch.js`, `menu.js` | phone |

`scripts/build-android-web.js` copies `src/` into `www/` unchanged and adds `platform-android.js` and
`android.css`. `www/` is generated and ignored by Git: never edit it.

## Rules

1. **A UI change goes in `src/` once.** Never copy a screen, a component or a piece of `app.js` per
   platform. If Android needs something different, change the shared code so it can differ, then put
   only the difference in `platform/android/`.
2. **The window talks to the outside only through `window.api`.** No `require`, no Node, no Electron
   and no Capacitor calls in `src/`. No `if (android)` branches in `src/app.js`: behaviour that differs
   belongs behind an `api` call or in `platform/android/`.
3. **A new `api` call is added in three places in the same change:** `platform/api-contract.js`,
   `preload.js` + `main.js`, and `platform/android/api.js`. A platform with no use for it still has
   it and resolves with the contract's "elsewhere" value. `npm test` fails otherwise.
4. **Nothing from Node in the Android bundle.** Code in `lib/` that Android uses must not need `fs`,
   `path`, `child_process` and so on; take storage and network as arguments (see `lib/storage-*.js`).
   The Android web build fails if a Node module is still needed.
5. **Keep the Content-Security-Policy as it is:** scripts from the app only, no inline scripts, no
   `eval`, no scripts from the network. Never put user or playlist data into `innerHTML`; use
   `textContent` (the `h()` helper in `app.js`).
6. **Plain JavaScript, no framework, no build step for the window.** No new runtime dependency
   without being asked. After adding, removing or updating a dependency or a file in `src/vendor/`,
   run `npm run credits` and commit `src/credits.json`.
7. **`boot.js` stays small and free of dependencies on the rest of the app.** It is the way out when
   the app cannot start.
8. **Never commit** `www/`, build outputs, signing keys, `android/keystore.properties`, or real
   stream addresses and logins (they contain usernames and passwords). Test streams live in
   `test/android/streams.js`.
9. **Match the style around you:** small functions, a comment that says *why* when it is not
   obvious, user-facing text that is short and plain.

## Checking a change

```bash
npm test                    # logic, the api contract on both platforms, credits, the Android web build
npm start                   # the desktop app from source
npm run build:android-web && npx cap sync android
cd android && ./gradlew assembleDebug      # android/app/build/outputs/apk/debug/app-debug.apk
```

Desktop needs Node.js 20 or newer; Android needs Node.js 22, JDK 21 and the Android SDK.

- Logic added to `lib/` gets a check in `test/run.js`.
- A visible change is tried on **all three**: desktop (`npm start`, light and dark), a phone
  (portrait and landscape) and a TV (remote or arrow keys only, no pointer). There are no automatic
  layout checks, so say in the pull request which of the three you actually ran and which you did not.
- `node test/android/webview.js <adb serial> <port> '<js>'` runs JavaScript inside the app on a device;
  `test/android/playback-check.js` plays the test streams.

## Pull requests

One change per pull request, branched from `main`. Describe what it does and how it was checked. One
version number in `package.json` covers all three apps; releases build them from the same tag.
