# Security

## Reporting a vulnerability

Please **don't** open a public issue for security problems. Use GitHub's private reporting instead:
[Report a vulnerability](https://github.com/kleantzogu/Vibe-Tv/security/advisories/new). Include what
you found, how to reproduce it, and which version you're on. You'll get an answer as soon as possible,
and credit in the release notes if you want it.

## What's in scope

- The app itself (main process, window, preload bridge) and its update mechanism.
- How it handles playlists, stream addresses, Xtream logins and the local ffmpeg conversion server.

## Good to know

- Updates are downloaded from this repository's GitHub Releases; on macOS an update is only installed
  when it is signed with the same Developer ID as the installed app.
- Playlists, Xtream logins and settings stay on your computer, in the app's data folder (see the
  README). Nothing is sent anywhere except requests to the streams and logo database you use, and the
  update check, which reads this repository's latest release on GitHub.
- Only the latest release gets security fixes.
