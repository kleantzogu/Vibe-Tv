# Vibe TV for Android (phone + Android TV): plan

Status: in progress · Written: 2026-11-11 · Phases 0–6 done (milestone M3) · Work happens on a dedicated `android` branch (see section 2)

> **Changes made while building it** (the text below is updated to match):
> - Sub-branches are named `android-p1-…`, not `android/p1-…`: Git cannot have a branch `android` and a branch `android/x` at the same time.
> - Capacitor 8 builds with **Java 21** (not 17) and needs Node 22+. Minimum Android is 7.0 (API 24).
> - All Capacitor packages are `devDependencies`, so electron-builder never packs them into desktop installers.
> - `capacitor.config.json` instead of `.ts` (no TypeScript needed).
> - Capacitor's HTTP plugin is **not** switched on globally: that would route every `fetch` and XHR of the page through it and buffer whole responses, which breaks hls.js streaming. The adapter calls it directly where it needs native HTTP.
> - Import and state logic moved from `main.js` to `lib/imports.js` and `lib/state.js` in Phase 1, so Android shares it.
> - Storage and HTTP are two small plugins of our own (`VibeFiles`, `VibeHttp`) instead of Capacitor's Filesystem and HTTP plugins: files are replaced in one step, and a channel check can stop reading a live stream after its first bytes.
> - Channel checks (`probe`, `startCheck`) were done in Phase 3; the plan had not given them a phase.
> - File import is phone-only: TVs have no file picker. "Open with Vibe TV" for `.m3u` files moves to Phase 6.
> - Android cloud backup of the app's data is off, because its files hold Xtream Codes logins.
> - Android-only styles live in `platform/android/android.css`, added to `www/` by the build, so `src/styles.css` stays the desktop's.

## 1. Goal

Ship **one installable APK** (Android Package, the file you install on Android) of Vibe TV that works on **both Android phones and Android TV** (also Google TV and Fire TV boxes), developed on a **separate long-lived branch** so the desktop app on `main` stays untouched and releasable the whole time.

The APK must:

1. install on a phone and on a TV box (sideloaded, no store needed);
2. import playlists (M3U file, M3U URL, Xtream Codes login) and play channels;
3. keep feature parity where it makes sense: favorites, recents, groups, hidden groups, search, logos, offline check;
4. be fully usable by touch on a phone and by a TV remote (D-pad: up/down/left/right/OK/Back) on a TV.

**Non-goals (for now):** Google Play release, Chromecast sending, recording, rewriting the desktop app, an in-app updater for the APK.

## 2. Repo and branch strategy

### 2.1 Decision

- **Same repository, separate long-lived branch named `android`**, created from `main`. No new repo: the phone/TV app reuses the same `src/` UI and `lib/` logic, so a second repo would drift out of sync and need its own CI and release process.
- `main` keeps shipping desktop releases exactly as today. Nothing from the Android work reaches `main` until the Android milestone is ready (section 2.6).
- **Check first:** `origin` is `github.com/kleantzogu/Vibe-Tv`. If you don't have push access to it, run `gh repo fork` and do everything below in your fork (the MIT licence allows this). A PR (pull request) back upstream is optional.

### 2.2 Branch model

```
main      o---o---o---o---o---o-----------------o   desktop releases, unchanged flow
           \       \       \                     /
android     o---o---o---o---o---o---o---o---o---o   long-lived Android integration branch
                 \     /   \     /
android-p1-...    o---o     o---o                    short sub-branches, one per phase/task
```

- `android`: integration branch. All Android work lands here. It is pushed to GitHub and can be installed/tested at any time.
- `android-<phase>-<topic>`: short sub-branches (for example `android-p1-portable-core`, `android-p2-capacitor-shell`, `android-p5-native-player`). Each is merged into `android` through a PR, **squash-merged** so every task is one commit.
- Rule: sub-branches target `android`, never `main`.

### 2.3 Day-one commands

```bash
git switch main && git pull
git switch -c android
git add ANDROID-PLAN.md && git commit -m "Add Android plan"
git push -u origin android

# per phase
git switch android && git pull
git switch -c android-p1-portable-core
# ...work, commit, push, open PR into android...
```

### 2.4 Staying in sync with `main`

- Desktop fixes keep landing on `main` while this work runs. Bring them in **at least weekly**, and always before starting a new phase:
  ```bash
  git fetch origin && git switch android && git merge origin/main
  ```
  Use **merge**, not rebase: `android` is shared and long-lived, so rewriting its history is risky.
- Resolve conflicts on `android`, run `npm test`, and start the desktop app (`npm start`) to confirm it still behaves.
- Phase 1 changes shared files (`lib/`, a little of `src/`). Keep those edits **small and behavior-preserving** to minimize merge conflicts, and merge `main` into `android` right before and right after Phase 1.

### 2.5 CI (automated checks) on the branch

- `ci.yml` currently runs on pushes to `main` and on every PR. PRs into `android` are therefore already tested on macOS, Windows and Linux. Also add `android` to its `push` branches so direct pushes are tested too.
- Add a new workflow `.github/workflows/android.yml` (only on the `android` branch): on push and manual run, set up Java 21 + Node 22, `npm ci`, `npm test`, build `www/`, `npx cap sync android`, `./gradlew assembleDebug`, then **upload the APK as a workflow artifact**. This gives you downloadable test APKs without creating a GitHub release.
- **Do not touch `release.yml` and never create a `v*` tag from the `android` branch.** Tags start the desktop release workflow, and the desktop updater reads the repo's *latest release*; an Android-only "latest" release would break desktop update checks.

### 2.6 Merging back to `main`

- Merge `android` into `main` only when the **definition of done (section 13)** is met, with one reviewed PR and a normal merge commit (keeps the phase history).
- At that point, update `release.yml` so tagged releases also build the signed APK and attach it to the **same versioned release** as the desktop installers (one version number for all platforms). If an Android-only release is ever needed, publish it with `--latest=false`.
- Until then, desktop releases continue from `main` as usual. If you cut a desktop release while `android` is in progress, merge `main` into `android` afterwards.

### 2.7 Files and secrets

Add to `.gitignore` on the `android` branch:

```
www/
android/build/
android/app/build/
android/.gradle/
android/local.properties
*.jks
*.keystore
```

- **Commit** the generated `android/` project (Gradle files, manifest, Kotlin sources); only build outputs are ignored.
- **Never commit** the signing keystore or its passwords. Keep them outside the repo, back them up in two places, and give CI the values through GitHub repository secrets.

## 3. What we found in the code

Vibe TV is an **Electron** app. Electron targets macOS, Windows and Linux only, so it cannot produce an APK. The code splits cleanly:

| Part | Where | Size | Portable to Android? |
|---|---|---|---|
| Interface (HTML/CSS/JS), M3U parser, bundled hls.js / dash.js / mpegts.js | `src/` | ~3,600 lines of own code | **Yes**, runs in an Android WebView |
| Desktop "backend" in Node.js: storage, imports, Xtream, channel DB, probe, ffmpeg converter, updater, menus | `main.js`, `lib/` | ~2,500 lines | **Not** the Node-specific parts (`fs`, `child_process`, `http`, `electron`) |
| Bridge between the two | `preload.js` (`window.api`, ~40 calls) | 91 lines | This is the seam we replace |

Facts that make the port easier:

- The UI only talks to the backend through `window.api`. Replace that one object and the UI barely changes.
- `lib/net.js`, `lib/xtream.js` and `lib/channeldb.js` already take an injected `fetch`.
- `src/m3u.js` is already shared; `lib/epg.js` and `lib/codecs.js` are plain parsing logic.
- `npm test` (`test/run.js`) covers much of `lib/` and will protect the refactor.
- `package.json` lists exactly which files electron-builder packages (`main.js`, `preload.js`, `lib/`, `src/`), so new `android/`, `platform/` and `www/` folders never end up in desktop installers.

Things that **will not** work as-is on Android:

| Desktop feature | Why it breaks | Android answer |
|---|---|---|
| Files via `fs` (`store.js`, `library.js`, `channeldb.js`) | No Node in a WebView | Capacitor Filesystem (JSON files) or IndexedDB. `localStorage` is too small (~5 MB) for 20k+ channel playlists |
| ffmpeg converter (`convert.js` spawns a binary, serves a local HTTP stream) | Android apps can't run a bundled ffmpeg like this; ffmpeg-kit is discontinued | Native player (Media3 ExoPlayer) decodes most of this directly |
| Header and CORS hacks (`webRequest` hooks in `main.js` set Referer / User-Agent and add `Access-Control-Allow-Origin`) | A WebView has no such hook. CORS = Cross-Origin Resource Sharing, the browser rule that blocks reading other sites' responses | Native HTTP for API/playlist fetches; native player sets headers per stream |
| Native menus, window buttons, drag window, file drop, `electron-updater`, clipboard | Don't exist | In-page menus and dialogs, Capacitor plugins, or no-ops |
| Keyboard + mouse UI (hover, right-click, drag-resizable sidebar, `/` and Ctrl+K) | Phones are touch; TVs are D-pad | New responsive and TV layouts (phases 6 and 7) |

## 4. Chosen approach

**Capacitor shell + platform adapter + native player plugin, producing one APK with two UIs.**

- **Capacitor** wraps the existing web UI in a real Android app (an Android Studio project we build into an APK).
- A **platform adapter** (`platform-android.js`) implements the same `window.api` contract that `preload.js` provides today, so desktop and Android share one UI.
- A small **native Kotlin plugin ("VibePlayer")** plays streams with Media3 ExoPlayer: HLS, DASH, MPEG-TS, MPEG-2 (device permitting), `rtsp://`, `udp://` and custom headers. It replaces the ffmpeg converter on Android.
- **One APK, one `applicationId`, two UIs:**
  - The manifest declares both the normal `LAUNCHER` and the TV `LEANBACK_LAUNCHER` category, with `touchscreen` and `leanback` features set to **not required**, so the same APK installs on phones and TVs.
  - At startup the adapter detects a TV (Android's `UiModeManager` reports `TYPE_TELEVISION`, or the device has the `leanback` feature) and reports `platform: androidtv`; otherwise `android`. The UI picks the touch layout or the 10-foot D-pad layout from that.
- Build a **universal APK** with both 32-bit (`armeabi-v7a`) and 64-bit (`arm64-v8a`) ARM code: many TV boxes and Fire TV sticks are still 32-bit. This only matters if native libraries (libVLC, an FFmpeg extension) get added; Media3 itself is plain Java/Kotlin.

Alternatives considered and rejected:

| Option | Why not |
|---|---|
| PWA / TWA (web app on a hosted URL) | Needs hosting, and browsers block most IPTV streams (CORS, mixed http/https) |
| Capacitor with web players only (hls.js / mpegts.js) | Fine as a first milestone, but Referer/User-Agent channels, MPEG-2, AC-3, rtsp/udp won't work reliably |
| Full native rewrite (Kotlin + Compose for TV) | Best final result, but throws away ~3,600 lines of working UI and takes the longest |
| React Native / Flutter | Same rewrite cost with no benefit over Capacitor for a web codebase |
| Separate phone and TV APKs | Double the release work; one APK with runtime detection is enough |

## 5. Decisions to confirm

Already decided: same repo, separate `android` branch, one APK for phone and TV.

| # | Question | Recommendation |
|---|---|---|
| D1 | Which gets polish first, phone or TV? | Both ship in the same APK. Phases 0–5 are shared; this only sets the order of phases 6 and 7 |
| D2 | Native player engine: Media3 ExoPlayer or libVLC? | **Media3**: smaller, official, good TV support. libVLC plays more exotic streams but adds ~20+ MB per architecture and has a more complicated licence |
| D3 | Do you have push access to `kleantzogu/Vibe-Tv`, or do we fork? | Check before Phase 0 (section 2.1) |
| D4 | Distribution: sideload only, or Google Play later? | Sideload only now. Play requires an AAB (Android App Bundle) and review; revisit later |
| D5 | Minimum Android version | Use whatever the current Capacitor release requires (recent versions need Android 6/7+); check at setup time |

## 6. Target structure (on the `android` branch)

```
Vibe-Tv/
  src/                    shared UI (unchanged where possible)
  platform/
    android/
      platform-android.js implements window.api for Android
      player.js           JS side of the VibePlayer plugin
      tv-focus.js         D-pad focus manager (phase 7)
  lib/                    shared logic, made storage/fetch-injectable
  android/                generated by Capacitor (Android Studio project)
    app/src/main/java/.../VibePlayerPlugin.kt
  www/                    build output used by Capacitor (generated, git-ignored)
  scripts/build-android-web.js   bundles src + platform-android + needed lib modules into www/
  capacitor.config.ts
  .github/workflows/android.yml  debug-APK builds for the android branch
  ANDROID-PLAN.md
```

- `lib/` modules are CommonJS and the WebView has no `require`. Bundle with **esbuild** into a single script that honors the existing Content-Security-Policy (`script-src 'self'`, no inline scripts, no `eval`).
- Detect the platform in `src/` with `window.Capacitor` (Android) vs the Electron `window.api` injected by `preload.js`. Keep that check in one place.
- Capacitor and esbuild go in `devDependencies` so they stay out of the desktop app.

## 7. `window.api` to Android mapping

Contract from `preload.js` (every call must be handled or intentionally stubbed):

| `window.api` call | Android implementation |
|---|---|
| `init`, `patchState` | Load/save the settings JSON (favorites, recents, status, activePlaylistId, settings) via Filesystem; `platform` is `android` or `androidtv`; version from the Capacitor App plugin |
| `createPlaylist`, `renamePlaylist`, `removePlaylist`, `playlistChannels`, `removeChannels`, `setHiddenGroups` | `lib/library.js` with a Capacitor Filesystem storage backend (same per-playlist JSON format as desktop) |
| `importPick`, `importFiles` | `<input type=file>` or a file-picker plugin, read as text, parse with `src/m3u.js`. `files:opened` event from an Android "Open with" intent for `.m3u/.m3u8` |
| `importUrl`, `xtreamLogin`, `xtreamRefresh` | `lib/xtream.js` and URL import with a **native HTTP fetch** (Capacitor HTTP) injected |
| `lookupChannels` | `lib/channeldb.js` (iptv-org database) with native fetch and Filesystem cache |
| `probe`, `startCheck`, `cancelCheck` | `lib/probe.js` over native HTTP; may need a small native "read first N KB with headers" method because Capacitor's HTTP buffers whole responses |
| `mediaCaps`, `convertOpen`, `convertStatus`, `convertInspect`, `convertClose` | Not used on Android: the player picks the native engine and plays the original URL. `mediaCaps` reports "native" |
| `setStreamHeaders` | Headers are passed on each `VibePlayer.play(url, headers)` call |
| `popupMenu`, `confirm` | In-page context menu (long-press on touch, long-OK on TV) and in-page confirm dialog |
| `copyText` | Capacitor Clipboard plugin |
| `credits`, `openCreditLink` | Bundled `credits.json`; Capacitor Browser plugin for links |
| `setWindowButtons`, `moveWindow` | No-op |
| `updateState`, `checkForUpdates`, `downloadUpdate`, `installUpdate`, `setAutoUpdate`, `openReleaseNotes` | Return `status: off`; hide update UI on Android |
| events: `menu`, `check:progress`, `files:opened`, `import:waiting`, `theme:accent`, `update:state` | Emit from the adapter where relevant (`check:progress`, `files:opened`); the rest unused |

## 8. Phases

Estimates are working days for one developer who knows the codebase. Each phase has its own sub-branch (merged into `android` by PR) and ends with a test you can run.

### Phase 0: Setup and decisions (0.5 day)  ·  branch: `android`

- [x] Confirm D1–D5; fork if you can't push to `origin`.
- [x] Create and push the `android` branch and commit this plan (section 2.3).
- [x] Install the Android tooling: JDK 21, the Android SDK command-line tools, `adb`, and a phone and an Android TV emulator (AVD, Android Virtual Device). Done with Homebrew, without Android Studio.
- [ ] Enable USB debugging on a real phone (not needed until Phase 4).
- [x] Add the `.gitignore` entries from section 2.7 and `android` to `ci.yml`'s push branches.
- [ ] Collect a **test playlist set** from sources you are entitled to use: plain HLS, MPEG-TS, an MPEG-2/AC-3 channel, an `rtsp://` or `udp://` one, one that needs Referer/User-Agent, an Xtream account, and one 20k+ channel file.
- **Done when:** the `android` branch is on GitHub and the emulator and phone are both visible in `adb devices` (ADB = Android Debug Bridge).

### Phase 1: Make the code portable (1–2 days)  ·  branch: `android-p1-portable-core`

- [x] Write the `window.api` contract down (section 7) as JSDoc/types so both platforms implement the same thing.
- [x] Make `Store`, `Library`, `ChannelDb` take a storage backend instead of calling `fs` directly (keep a Node `fs` backend for desktop).
- [x] Make `probe.js` / `xtream.js` / `net.js` fully fetch-injectable.
- [x] Add `scripts/build-android-web.js` (esbuild) producing `www/`.
- [x] Keep `npm test` green and run the desktop app to confirm nothing regressed. Merge `main` into `android` before and after (section 2.4).
- **Done when:** desktop behaves exactly as before and `www/` builds.

### Phase 2: Capacitor shell and first APK (1 day)  ·  branch: `android-p2-capacitor-shell`

- [x] `npm i -D @capacitor/core @capacitor/android @capacitor/cli esbuild`
- [x] `npx cap init "Vibe TV" com.vibetv.app --web-dir=www` then `npx cap add android`
- [x] `capacitor.config.json`: `appId`, `appName`, `webDir: 'www'`, `android.allowMixedContent: true` (many IPTV URLs are plain `http://`).
- [x] `AndroidManifest.xml`: `INTERNET` permission, `usesCleartextTraffic="true"`, both `LAUNCHER` and `LEANBACK_LAUNCHER` categories, `touchscreen` and `leanback` features set to not required, TV banner (320×180 px).
- [x] Stub `platform-android.js` (with phone/TV detection) so the UI starts with an empty state.
- [x] Add `.github/workflows/android.yml` so every push to `android` produces a downloadable debug APK.
- [x] Build: `npm run build:android-web && npx cap sync android`, then Android Studio ▸ Build ▸ Build APK, or `cd android && ./gradlew assembleDebug`.
- [x] Install: `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`
- **Done when:** the same APK installs on a phone and on the TV emulator, opens, and shows the empty-state screen without console errors. The TV emulator shows it in the launcher row.

### Phase 3: Data layer, imports, library (2–3 days)  ·  branch: `android-p3-data-imports`

- [x] Filesystem storage backend; settings, favorites, recents, hidden groups persist across restarts.
- [x] Playlists: create, rename, delete, remove channels.
- [x] Imports: M3U file, M3U URL, Xtream login and refresh, using native HTTP.
- [x] Channel logos and categories from the iptv-org database with weekly cache refresh.
- [x] Channel checks: one channel (`probe`) and the whole playlist (`startCheck`), with each channel's Referer / User-Agent.
- **Done when:** a 20k-channel playlist imports, search stays instant, and everything is still there after the app is killed and reopened.

### Phase 4: Playback v1 with web engines (1–2 days)  ·  branch: `android-p4-web-playback`

- [x] Play HLS/TS/MP4 through the existing hls.js / mpegts.js / `<video>` paths in the WebView.
- [x] Verify mixed content (http streams inside the https WebView origin) and record how many test channels play.
- **Done when:** you have a pass/fail table for the test playlist set. This is the **gate**: it shows how much the native player must cover.

**Result (2026-11-12, Pixel 7 emulator, Android 14, streams from `test/android/streams.js`):** with the web engines alone, **1 of 14 playable streams plays**.

| Stream | Web engines in the WebView |
|---|---|
| HLS live, H.264 + AAC, server allows web pages (CORS) | **Plays**, picture and sound |
| HLS live, H.264 + AAC (no CORS, like nearly every IPTV server) | Fails: the page may not read it |
| HLS at an address without `.m3u8`, redirected | Fails |
| HLS film, H.264 + AC-3 | Fails |
| MPEG-TS live: H.264 + AAC / MP2 / AC-3 / E-AC-3, MPEG-2 + MP2, HEVC + AAC | All six fail |
| MP4 film, H.264 + AAC · MKV film, H.264 + AC-3 | Both fail |
| DASH film | Fails |
| HLS that needs Referer and User-Agent | Fails |
| Offline address (404) · a web page instead of a stream | Correct error message for each |

What it means: the cause is not the codecs but the page itself. hls.js, dash.js and mpegts.js fetch streams with the page's own requests, and a page served from `https://localhost` may only read servers that send CORS headers, which IPTV servers do not. On a computer `main.js` rewrites those headers for the window; a WebView has no such hook. So on Android **the native player (Phase 5) plays everything**, and the web engines are not used there at all. Run it again with `node test/android/playback-check.js <device>`.

### Phase 5: Native player plugin (4–7 days)  ·  branch: `android-p5-native-player`

- [x] Kotlin Capacitor plugin `VibePlayer` using Media3 ExoPlayer: `play(url, headers)`, `stop`, `pause/resume`, volume/mute, state events (buffering, playing, error with a reason the UI already understands: `offline`, `codec`, `timeout`).
- [x] Sources: HLS, DASH, progressive/MPEG-TS, RTSP, UDP; per-stream Referer and User-Agent headers; redirect and cleartext handling.
- [x] Rendering: **spike first.** Preferred: native video surface behind a transparent WebView so the existing overlay UI (sidebar, quick search) still works. Fallback: a separate full-screen player activity with its own minimal controls.
- [x] Hook `src/app.js` playback so Android uses the native player and skips hls.js/mpegts.js/ffmpeg conversion; keep web engines for desktop.
- [ ] Decoder gaps (evaluated, decision open, see below): hardware decode of MPEG-2 and AC-3/E-AC-3 varies by device, and DTS is rarely supported. If a target box lacks audio codecs, evaluate Media3's FFmpeg audio decoder extension (built locally) or libVLC. Check the licences before shipping either, and keep `armeabi-v7a` in the build if native libraries are added.
- [x] Android integration: audio focus, keep-screen-on, resume after app switch, Back-button behavior, fullscreen immersive mode.
- **Done when:** every channel in the test set that plays on desktop also plays on at least one phone and one real TV device, including the header-protected one.

**How it was built (2026-11-12):**

- **Rendering: the preferred way works.** The native picture is drawn behind a see-through WebView, in the rectangle the page's player occupies, so the app's own controls, sidebar and quick search stay on top. No separate player activity was needed.
- **One hook in `src/app.js`.** The page's `<video>` is swapped for a stand-in with the same properties, methods and events (`platform/android/player.js`), so the rest of the app drives the native player without knowing. `play()` hands the channel to `window.vibeNativePlayer` when it exists.
- **Full screen** is done by the app rather than the page: the player covers the page, the system bars hide, and a phone turns sideways. Back (button, gesture or remote) closes dialogs, then full screen, then leaves the app.
- Audio focus, pausing when headphones are pulled out, keep-screen-on while playing, and pause / resume when the app is left and reopened are handled in the plugin.

**Result with `node test/android/playback-check.js` (emulators, Android 14):**

| Stream | Phone emulator | Android TV emulator |
|---|---|---|
| HLS live (with and without CORS, and at an address without `.m3u8`) | Plays | Plays |
| MPEG-TS live, H.264 + AAC · HEVC + AAC | Plays | Plays |
| MP4 film · DASH film | Plays, seekable | Plays, seekable |
| HLS that needs Referer and User-Agent | Plays | Plays |
| Anything with AC-3, E-AC-3 or MP2 sound (5 streams) | Picture plays, **no sound**, and the app says so | Same |
| MPEG-TS, MPEG-2 video + MP2 sound | "This device has no decoder for MPEG-2 video and MP2 sound" | Picture plays, no sound |
| Offline address · web page | Correct message for each | Correct message for each |

13 of 14 playable streams start on the phone emulator and 14 of 14 on the TV emulator (the web engines managed 1). Not tested: `rtsp://` and `udp://` (cannot be served to an emulator from here; the player has the modules for them), and real devices.

**Open decision: sound in AC-3, E-AC-3, MP2 and DTS.** Emulators have no decoder for them; real TV boxes usually do, many phones do not, and MP2 and AC-3 are common on IPTV. Three ways to cover every device:

1. Build Media3's own FFmpeg audio extension (audio decoders only, LGPL build). Clean licence, but needs the Android NDK, a build step in CI, and `armeabi-v7a` + `arm64-v8a` libraries in the APK (a few MB).
2. Use a prebuilt extension such as Jellyfin's. No build step, but it is GPL-3, which would put the Android APK under GPL terms.
3. Leave it to the device and keep the "No sound" message.

### Phase 6: Phone experience (3–4 days)  ·  branch: `android-p6-phone-ui`

- [ ] Responsive layout: sidebar becomes a drawer or bottom sheet in portrait; side-by-side in landscape.
- [ ] Touch: tap to play, long-press for the context menu, swipe to open the channel list, safe-area/notch insets, orientation handling.
- [ ] Back button, optional Picture-in-Picture, split-screen sanity check.
- **Done when:** one-handed use in portrait is comfortable and nothing relies on hover or right-click.

**What was built (2026-11-12), all in `platform/android/` (nothing in `src/` changed):**

- [x] **Upright:** the picture across the top (16:9), the playlist and channels below it. **Sideways:** the list beside the picture, as on a computer but narrower; full screen is one tap and turns the phone sideways by itself.
- [x] **Sized for a finger:** larger text, 42–46 px buttons, favourite stars always visible (no hover), no volume slider (the phone's keys do that), no window-dragging or sidebar-resizing.
- [x] **A tap on the picture** shows or hides the controls and never pauses; a double tap goes full screen.
- [x] **Menus** (`api.popupMenu`) are a sheet that slides up from the bottom; a **long-press** on a channel or group opens its menu.
- [x] **Back** closes the menu, then dialogs, then full screen, then leaves the app.
- [x] **"Open with Vibe TV"** for `.m3u` / `.m3u8` files from other apps (by file type, as Android does).
- [ ] Picture-in-Picture (optional): not done; its button is hidden on Android.
- [ ] Swipe gestures on the picture (next / previous channel): not done; the buttons do it.
- [ ] Split-screen and tablets: not tried.

Checked on the Pixel 7 emulator: upright and sideways layout, playing by tap, controls by tap, the ⋯ menu, the long-press channel menu, Back by swipe, the Xtream dialog, and a playlist file opened from outside. The Android TV emulator still plays all 14 test streams. Not checked on a real phone.

### Phase 7: Android TV experience (4–6 days)  ·  branch: `android-p7-tv-ui`

- [ ] **Focus system** (`tv-focus.js`): every interactive element reachable with the D-pad, with a clearly visible focus ring and predictable spatial movement (up/down through the list, left/right between sidebar and player). Active only when `platform === 'androidtv'`; the phone UI is not affected.
- [ ] Remote keys: OK to play, Back to close overlays/exit fullscreen, Menu for the ⋯ menu, channel up/down (`KEYCODE_CHANNEL_UP/DOWN`) and media keys.
- [ ] 10-foot layout: larger type and targets, overscan-safe margins (about 5%), no hover-only controls, no tiny icons.
- [ ] Text entry is painful with a remote: make search optional, keep the on-screen keyboard working, and simplify URL/Xtream entry. Stretch: "send playlist from your phone" via a local page or QR code.
- [ ] TV launcher assets: banner 320×180, icon, correct `LEANBACK_LAUNCHER` entry.
- **Done when:** a full session (import, find a channel, play, change channel, switch playlist, quit) works with only the remote on a real TV box.

### Phase 8: Hardening, release and merge to `main` (2–3 days)  ·  branch: `android-p8-release`

- [ ] Release signing: create a keystore with `keytool`, store it and its passwords **outside the repo** and back it up (losing it means you can't update the same app). Debug-signed and release-signed APKs can't update each other; uninstall one before installing the other.
- [ ] Release build with R8 (code shrinker) and version tied to `package.json`.
- [ ] Extend `release.yml` (CI = continuous integration): add an Android job (setup-java 21, setup-node, `npm ci`, `npm test`, build `www/`, `npx cap sync android`, `./gradlew assembleRelease`, sign with repository secrets, attach the APK to the same GitHub release as the desktop installers).
- [ ] README: add Android install steps (allow unknown apps, `adb install`) and update the "macOS, Windows and Linux" wording; update `SECURITY.md` and the Credits list for new dependencies.
- [ ] Soak test (several hours of continuous playback), memory check on a low-end device.
- [ ] Final `main` → `android` merge, full desktop regression check, then open the single `android` → `main` PR (section 2.6).
- **Done when:** a tagged release publishes desktop installers plus a signed APK that installs on a clean phone and TV.

## 9. Milestones and effort

| Milestone | Reached after | Cumulative effort |
|---|---|---|
| M1: first APK boots on phone and TV emulator | Phase 2 | 3–4 days |
| M2: phone alpha, imports and basic playback work | Phase 4 | 6–9 days |
| M3: phone beta, native player and touch UI | Phases 5–6 | 13–20 days |
| M4: Android TV beta | Phase 7 | 17–26 days |
| M5: release-ready signed APK with CI, merged to `main` | Phase 8 | 19–29 days |

That is roughly **4 to 6 weeks** of focused solo work for phone and TV together. The biggest uncertainty is Phase 5 (native player and codec coverage), so run its rendering spike early, right after Phase 2, if schedule risk matters. Phases 6 and 7 can be swapped (D1) without affecting anything else.

## 10. Test matrix

| Device | Must test |
|---|---|
| Recent phone (Android 13+) | All phases; touch, rotation, PiP |
| Older or low-end phone | Large playlists, memory, hardware decode limits |
| Android TV emulator (AVD) | Layout, focus, launcher entry (not codec support) |
| Real Android TV / Google TV box | D-pad, codecs, performance, install by `adb connect <tv-ip>:5555` |
| Fire TV stick (optional) | Sideload, 32-bit ARM, codec differences |

Content to test on each: HLS, MPEG-TS, MPEG-2 video, AC-3/E-AC-3/MP2 audio, `rtsp://`, `udp://`, header-protected stream, Xtream login, 20k+ channel playlist, `http://` and `https://` streams, a dead channel (error message path).

## 11. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| `android` drifts far from `main` and the final merge is painful | Conflicts, regressions in desktop | Merge `main` into `android` weekly; keep Phase 1 edits to shared files small; run the 3-OS CI on every PR |
| Android work accidentally affects desktop | Desktop release breaks | Branch isolation, `window.Capacitor` platform checks, `npm test` + `npm start` before each merge |
| A `v*` tag or Android-only "latest" release is created from the wrong branch | Desktop updater breaks for everyone | Tag only from `main`; Android test builds go through workflow artifacts; `--latest=false` for any Android-only release |
| Native video behind a transparent WebView misbehaves on some devices | Overlay UI and video don't compose | Spike in Phase 5; fallback is a separate player activity |
| Device lacks a decoder for MPEG-2 / AC-3 / DTS | Some channels have no picture or sound | Test on real boxes early; FFmpeg audio extension or libVLC as a fallback; show a clear "unsupported on this device" error |
| Capacitor HTTP buffers whole responses | Memory spikes on huge playlists, no streaming reads for `probe` | Test with the 20k+ file; add a small native streaming/"first N KB" method if needed |
| Focus and D-pad navigation in a web UI is fiddly | TV experience feels broken | Build a single focus manager early in Phase 7 and test on a real remote, not only the emulator |
| Cleartext (`http://`) and mixed content settings | Streams silently fail | Set `usesCleartextTraffic` and `allowMixedContent` in Phase 2 and test with both URL types |
| 32-bit-only TV boxes | APK won't install or run | Build a universal APK including `armeabi-v7a`; test on a 32-bit device |
| Lost signing keystore | Can't ship updates to existing installs | Back it up in two places; never commit it |
| Licences (ffmpeg is GPL on desktop; libVLC and the FFmpeg extension have their own terms) | Distribution problems | Prefer Media3 core; review licences before adding any decoder; update the in-app Credits |
| Scope creep into a rewrite | Plan slips | Keep the "adapter, not rewrite" rule; every UI change must keep desktop working |

## 12. Handy commands

```bash
# keep the branch current with desktop work
git fetch origin && git switch android && git merge origin/main

# build the web bundle and sync it into the Android project
npm run build:android-web && npx cap sync android

# debug APK
cd android && ./gradlew assembleDebug

# install on a USB phone, or on a TV over the network
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb connect <tv-ip>:5555 && adb install -r app-debug.apk

# logs, and WebView debugging (open chrome://inspect in desktop Chrome)
adb logcat | grep -i vibe
```

## 13. Definition of done (merge `android` into `main`)

- [ ] One signed APK installs on a phone and on an Android TV box from a clean state.
- [ ] Import (file, URL, Xtream), playlists, favorites, recents, hidden groups and search all work and persist.
- [ ] Every channel in the test set that plays on desktop plays on Android, or fails with a clear message.
- [ ] Phone flow works by touch; TV flow works with the remote only.
- [ ] Desktop app unchanged in behavior; `npm test` passes on macOS, Windows and Linux CI.
- [ ] `android` is up to date with `main`; no `v*` tag was ever created from it.
- [ ] Release workflow publishes the APK next to the desktop installers; README documents installation.

## Appendix: what was reviewed

`package.json` (Electron 44, electron-builder file list, ffmpeg-static, electron-updater), `main.js` (IPC handlers, header/CORS hooks), `preload.js` (`window.api`), `lib/*` (storage, net, xtream, channeldb, probe, codecs, convert, epg, updater), `src/index.html` (CSP, script loading), `src/app.js` (player engine selection, keyboard handling), `.github/workflows/ci.yml` and `release.yml`, `.gitignore`, git remote and branches (`origin` = `kleantzogu/Vibe-Tv`, only `main` exists). No Android, Capacitor or Cordova code exists in the repo yet.
