<p align="center">
  <img src="build/icon.png" width="128" height="128" alt="Vibe TV icon">
</p>

<h1 align="center">Vibe TV</h1>

<p align="center">A clean, fast, open-source desktop player for M3U / IPTV playlists, for macOS, Windows and Linux.</p>

<p align="center">
  <a href="https://github.com/kleantzogu/Vibe-Tv/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/kleantzogu/Vibe-Tv?label=download"></a>
  <a href="https://github.com/kleantzogu/Vibe-Tv/actions/workflows/ci.yml"><img alt="Tests" src="https://github.com/kleantzogu/Vibe-Tv/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/github/license/kleantzogu/Vibe-Tv"></a>
</p>

---

## Features

- **Your playlists, your way.** Make playlists in the app and import `.m3u` / `.m3u8` files, web
  addresses or an Xtream Codes login into them. Duplicates are skipped, and the files aren't needed afterwards.
- **Plays (almost) everything.** HLS, DASH, MPEG-TS, FLV, MP4, MKV, WebM and more. What the built-in
  engine can't decode (MPEG-2, AC-3, E-AC-3, MP2, DTS, interlaced broadcasts, `rtmp://`, `rtsp://`,
  `udp://`…) is converted on the fly with the bundled ffmpeg, and only the part that needs it.
- **Handles huge playlists.** Tens of thousands of channels with instant search, accent-insensitive,
  and a Spotlight-style quick search on `/` to jump to any channel.
- **Groups under control.** Filter by group, or hide whole countries or single groups you never watch.
- **Focus mode.** Hide the sidebar, or let it slide in only when the pointer touches the left edge.
- **Favorites and recently watched**, shared across playlists.
- **Channel checks.** Find out which channels are offline, and hide them.
- **Logos and categories** from the playlist, or from the public iptv-org database.
- Custom `Referer` / `User-Agent` per channel (`#EXTVLCOPT`, Kodi-style `|User-Agent=`).

## Open source

Vibe TV is free and open source under the [MIT License](LICENSE): anyone can download it, use it,
change it, share it, build on it or ship their own version, for any purpose. The only condition is
keeping the license notice. The app lists every open-source project it's built on (with versions,
licenses and links) in its About window: **Vibe TV ▸ About Vibe TV** on macOS, **Help ▸ About Vibe TV**
on Windows and Linux. Ideas, bug reports and pull requests are welcome: see
[CONTRIBUTING.md](CONTRIBUTING.md). Please report security problems privately, as described in
[SECURITY.md](SECURITY.md).

## Install

Download the installer for your system from the
[Releases](https://github.com/kleantzogu/Vibe-Tv/releases) page, or [build it yourself](#build-the-installers).

- **macOS** (`.dmg`, Apple Silicon): open the disk image and drag Vibe TV to Applications. The app is
  signed but not notarized yet, so the first time, right-click it and choose **Open** (or allow it in
  System Settings ▸ Privacy & Security).
- **Windows** (`Setup.exe`): run the installer. SmartScreen may warn that the publisher is unknown;
  choose **More info ▸ Run anyway**.
- **Linux** (`.AppImage`): make it executable (`chmod +x Vibe*.AppImage`) and run it.

Nothing else has to be installed: ffmpeg is included.

## Run from source

You need [Node.js](https://nodejs.org) 20 or newer (the LTS version is fine) and Git.

```bash
git clone https://github.com/kleantzogu/Vibe-Tv.git
cd Vibe-Tv
npm install
npm start
```

The first `npm install` downloads Electron (about 100 MB) and ffmpeg (about 45 MB), so it takes a
minute. On macOS, `npm start` runs the app from a copy of Electron named Vibe TV (made once in `.dev/`),
so the menu bar, Dock and About box show the right name and icon.

Run the checks with:

```bash
npm test
```

## Build the installers

```bash
npm run dist
```

This builds an installer for the system you run it on and puts it in `dist/`. ffmpeg is included
(about 45 MB): `npm install` downloads the build for the computer it runs on, so build each installer
on the system and processor it is for. To build for another processor, reinstall it first, for
example `npm_config_arch=x64 npm install ffmpeg-static` before an Intel Mac build. The bundled ffmpeg is
under the GPL; its license and notes are installed next to it (`ffmpeg.LICENSE`, `ffmpeg.README`).

It makes a Setup `.exe` on Windows, a `.dmg` on macOS and an `.AppImage` on Linux; to get all
three, run the command once on each system. On a Mac with a Developer ID certificate in the
Keychain the app is signed automatically, but it is not notarized, and the Windows installer is not
signed, so macOS Gatekeeper and Windows SmartScreen show a warning the first time they are opened.

### Publish a release (and update everyone)

Installed copies check GitHub Releases when they start and every six hours. To ship a new version:

1. Raise `"version"` in `package.json` (for example `1.1.0` → `1.2.0`), commit and push.
2. On a Mac, run `npm run release`. It checks that the tests pass and that everything is pushed,
   builds the signed macOS app, and runs the **launch check**: the packaged app must start, and must
   recover from a simulated broken start. Only then does it tag the commit `v1.2.0` and publish the
   installer with the files the updater reads (`latest-mac.yml`, and the `.zip` macOS updates from).
   It uses your `gh` login (or `GH_TOKEN`).
3. The tag starts the **Release** workflow on GitHub Actions, which builds the Windows and Linux
   installers, runs the same launch check on each, and only then adds them (with `latest.yml` /
   `latest-linux.yml`) to the same release.
4. Edit the release on GitHub to add notes; the app shows them under "What's new".

People then get the update as chosen in the app menu (Help menu on Windows and Linux) with
**Install Updates Automatically**: on (the default), it downloads quietly and installs when they quit,
with a card offering **Restart now**; off, a card says a new version is out and downloads it only when
they click **Download**. **Check for Updates…** checks right away. On macOS an update is only installed
when it is signed with the same Developer ID as the installed app.

The repository's releases must be public for installed copies to read them. To test updates without
publishing, serve a folder containing a build's `latest-mac.yml` and `.zip` over http and start the app
with `VIBE_TV_UPDATE_URL=http://127.0.0.1:8000/`.

To notarize the macOS app, add your Apple ID credentials (or an App Store Connect API key) as
described in the [electron-builder documentation](https://www.electron.build/code-signing-mac).

## Using Vibe TV

**Playlists.** Playlists are lists you make in the app. Import a `.m3u` / `.m3u8` file into one
(File ▸ Import M3U File, the ⋯ menu at the top of the sidebar, or drop the file on the window), or import from a web
address. The channels are copied into the playlist, so the file is not needed afterwards; importing
another file adds its channels, and channels that are already in the playlist are skipped. Switch,
create, rename and delete playlists from the playlist name at the top of the sidebar. Right-click a
channel to remove it from the playlist. With no playlist yet, an import makes one named after the file.

**Xtream Codes.** If your provider gave you a server, username and password instead of a file, use
File ▸ Log In with Xtream Codes (or the ⋯ menu). The account's live channels, and optionally its
movies, go into a new playlist grouped by the provider's categories. The login is kept with that
playlist (in the app's data folder, like the stream addresses that already contain it), so File ▸
Refresh Playlist from Server reloads its channels later. Favorites and hidden groups survive a refresh.

**Groups.** The pills above the search field filter the list: All, Favorites, Recent, and a Groups pill
that opens a searchable list of the playlist's groups (`group-title`) and shows the one you picked.

**Choosing which groups to see.** Open ⋯ ▸ Manage Groups (or File ▸ Manage Groups, ⌘⇧G / Ctrl+Shift+G,
or "Manage groups…" under the Groups list). Groups are gathered by their prefix ("ES | …", "FR | …"),
so a whole country can be hidden with one checkbox; open a section to pick single groups. Type in the
search field to act on every matching group at once: Show these, Hide these, or Show only these.
Changes apply right away and are kept per playlist. Hidden groups stay out of All, search, the
Groups list and channel checks; Favorites and Recent still show their channels. Right-click a channel
or a group to hide its group quickly (with Undo). Groups that a later import adds are shown.

**Sidebar.** For a video-only view, hide the sidebar with the button at its top, View ▸ Toggle Sidebar
(⌃⌘S on macOS, Ctrl+B elsewhere), or pick a mode in the View menu (or right-click that button):
*Always Show*; *Auto-Hide*, where it slides in over the video when the pointer touches the left edge
of the window and slides away when the pointer leaves; or *Hide*, where it stays away until you bring
it back with the button at the top left of the video. On macOS the window buttons fade with the player
controls while the sidebar is away.

**Moving the window.** There is no title bar: drag the picture (or the top edge of the window) to move
it. A click on the picture still pauses and plays, and a double-click goes full screen.

**Sidebar width.** Drag the sidebar's right edge to make it wider or narrower (it always leaves at least
400 px for the video); the width is remembered. Double-click the edge to reset it. Drag it well past the
narrowest width to tuck the sidebar away. With the edge focused (Tab), ← → resize it and Home / End go to
the narrowest and widest.

**Quick search.** Press `/` (or Ctrl/⌘+K, View ▸ Quick Search) anywhere, even in full screen or with
the sidebar hidden: a big search field opens in the middle of the window, Spotlight style. Before you
type it lists recently watched channels and favorites; as you type it shows the best matching channels
(names that start with what you typed first, then favorites and recent ones) and matching groups.
↑ ↓ move, ↵ plays the channel or opens the group, Esc or a click outside closes it.

**Search.** Type in the search field; it shows how many channels it searches. It matches channel names, groups and ids, ignores accents,
and every word has to match ("fox news" finds "Fox News Radio").

**Logos and groups.** Logos and groups come from the playlist (`tvg-logo`, `group-title`) when
it has them. For channels that only have a `tvg-id` in the iptv-org format (`ABC.us@East`), the
logo and category are looked up in the public [iptv-org database](https://github.com/iptv-org/api).
The database is downloaded once and refreshed weekly. Channels without a logo get a tile with
their initials.

**Favorites and recently watched.** Click the star on a channel (or press Ctrl/⌘+D for the one
that is playing). Both are filters above the search field (Favorites, Recent) and are shared by all playlists.
In Recent, hover a channel and click × (or select it and press Delete) to take it off the list, or
click Clear at the top to empty it; both can be undone from the notification.

**Offline channels.** In the ⋯ menu at the top of the sidebar, "Check Which Channels Are Online" tests
every channel in the playlist and marks the ones that do not respond (a bar under the search field shows
progress, with a Stop button). "Hide Offline Channels" removes those from the list. A channel that fails
to play is marked offline as well, and one that plays is marked online.

## Keyboard

| Key | Action |
| --- | --- |
| Ctrl/⌘ + N | New playlist |
| Ctrl/⌘ + O | Import M3U file |
| Ctrl/⌘ + L | Import from URL |
| Ctrl/⌘ + Shift + L | Log in with Xtream Codes |
| Ctrl/⌘ + R | Refresh an Xtream playlist from its server |
| / or Ctrl/⌘ + K | Quick search, in the middle of the window |
| Ctrl/⌘ + F | Search in the sidebar (brings back a hidden sidebar) |
| ⌃⌘S (macOS), Ctrl+B | Show / hide the sidebar |
| ↑ ↓, Enter | Move through the list, play |
| Space | Play / pause |
| Ctrl/⌘ + ↑ ↓ | Previous / next channel (plain ↑ ↓ in full screen) |
| Click on the picture | Play / pause |
| Drag the picture | Move the window |
| F, F11 (Ctrl+⌘+F on macOS), double-click | Full screen |
| M | Mute |
| Ctrl/⌘ + D | Favorite |
| Ctrl/⌘ + Shift + P | Picture in picture |
| Ctrl/⌘ + Shift + K | Check which channels are online |
| Ctrl/⌘ + Shift + H | Hide offline channels |

## What plays

Playback uses Chromium's media engine with hls.js, dash.js and mpegts.js on top, and
[ffmpeg](https://ffmpeg.org) for everything those can't decode.

- **Directly:** HLS, MPEG-DASH, MPEG-TS, FLV and plain files (MP4, MKV, WebM, MP3, FLAC, WAV…) with
  H.264, HEVC, VP9 or AV1 video and AAC, MP3, Opus or FLAC audio.
- **Through ffmpeg:** MPEG-2, MPEG-4 Part 2, VC-1, WMV, ProRes and other video; AC-3, E-AC-3, MP2,
  DTS, PCM, WMA and other audio; AVI, WMV, MPG, VOB and similar files; and `rtmp://`, `rtsp://`,
  `udp://`, `rtp://`, `srt://` and `mms://` addresses. Only what needs it is converted: when just the
  sound is AC-3 or MP2 (the usual case on IPTV), the picture is passed through untouched. Video is
  re-encoded only when it has to be (on a Mac with the hardware encoder, deinterlaced when the
  broadcast is interlaced). The player shows "Audio converted" or "Converted" when this is happening.
- **How it decides:** for MPEG-TS streams the codecs are read from the first bytes of the stream, so
  there is no extra delay. Anything else that fails to decode, or plays without picture or sound,
  switches to ffmpeg automatically, and the app remembers for the session which channels need it.
- ffmpeg ships with the app (the [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) package,
  ffmpeg 6.0), so nothing has to be installed. To use another build, set `VIBE_TV_FFMPEG` to its
  path; if the bundled one is missing, an installed ffmpeg is used.
- **Does not play:** DRM-protected streams, and web pages (such as a YouTube channel link) instead of
  streams. Films played through ffmpeg can't be seeked yet.
- Custom `Referer` and `User-Agent` from `#EXTVLCOPT` lines (and Kodi-style `|User-Agent=…`
  suffixes) are sent with every request for that channel, including through ffmpeg.

## Where your data is kept

Favorites, history and check results are in `settings.json` in the app's data folder, and each
playlist's channels in `playlists/<id>.json` next to it:

- Windows: `%APPDATA%\Vibe TV`
- macOS: `~/Library/Application Support/Vibe TV`
- Linux: `~/.config/Vibe TV`

Delete that folder to start fresh.

The app used to be called M3U Player. The first time Vibe TV starts, it copies the playlists, favorites
and settings from the old `M3U Player` folder; that folder is left as it was and can be deleted afterwards.

## Troubleshooting

### If Vibe TV can't start

If a version can't open (because of a bug in it, say), Vibe TV shows a small recovery window instead
of failing silently. It looks for a newer version on GitHub straight away, whatever the update
setting, downloads it and restarts into it. If no fix is out yet, it offers **Try again**, **Report the
problem** (a pre-filled GitHub issue, with your home folder and stream addresses left out) and
**Download from GitHub**, and it keeps looking while it's open. A version that failed to open twice in
a row goes straight to the recovery window.

### "The file did not arrive in time"

The playlist file is listed in a folder but its contents are not on your computer: it is in
iCloud Drive (which includes Desktop and Documents when iCloud syncs them), OneDrive, Dropbox,
Google Drive or on a network drive. The app waits up to about 40 seconds for the download and
then gives up. Download the file first (on a Mac: right-click it in Finder ▸ Download Now) or
copy it to a folder that is not synced, then press Try again.

Once a file is imported its channels are stored in the app, so the original can be moved or deleted.

### Trouble starting on Linux

If `npm start` stops with a message about the sandbox (`chrome-sandbox` / "SUID sandbox helper"),
start it with `npx electron . --no-sandbox`.

## Project layout

```
boot.js            Starts the app, and opens the recovery window if it can't start
main.js            Main process: window, menus, dialogs, playlists, request headers for streams
preload.js         The small API the window is allowed to call
lib/
  library.js       Playlists: import, duplicates, hidden groups, storage
  xtream.js        Xtream Codes logins
  probe.js         Stream checks: is it alive, what kind of stream is it
  codecs.js        Codec detection from the stream's first bytes, and what to convert
  convert.js       ffmpeg conversion served to the player over a local address
  channeldb.js     Logos and categories from the iptv-org database
  updates.js       Updates from GitHub Releases
  store.js, net.js, readfile.js, epg.js   Settings, downloads, patient file reading, XMLTV parser
src/               The window: index.html, styles.css, app.js, m3u.js (playlist parser)
src/vendor/        hls.js 1.7.3, mpegts.js 1.8.2, dash.js 5.2.1, with their licenses
scripts/start.js   `npm start`
scripts/release.js `npm run release`
scripts/launch-check.js  Starts a packaged build normally and with a simulated broken start
scripts/credits.js `npm run credits`: writes src/credits.json, the Acknowledgements list
.github/           CI and Release workflows, issue and pull request templates
test/run.js        `npm test`
build/             App icons (icon-source.png is the original; make-icons.py rebuilds the others)
```

## Contributing

Bug reports, ideas and pull requests are welcome; [CONTRIBUTING.md](CONTRIBUTING.md) explains how to
build, test and send changes. Every push and pull request is tested on macOS, Windows and Linux. You can
also publish your own build from a fork: set `owner` and `repo` under `build.publish` in
`package.json`, and your users get updates from your releases.

## License

Vibe TV is free software under the [MIT License](LICENSE).

It includes [hls.js](https://github.com/video-dev/hls.js) (Apache 2.0),
[mpegts.js](https://github.com/xqq/mpegts.js) (Apache 2.0) and
[dash.js](https://github.com/Dash-Industry-Forum/dash.js) (BSD 3-Clause), whose licenses are in
`src/vendor/`. Installers include an [FFmpeg](https://ffmpeg.org) build from
[ffmpeg-static](https://github.com/eugeneware/ffmpeg-static), which is licensed under the GPL and runs
as a separate program; its license is installed next to it.

Vibe TV is a player only: it doesn't come with any channels. Use it with playlists you have the right to watch.
