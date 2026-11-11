# Contributing to Vibe TV

Thanks for helping. Vibe TV is open source under the [MIT License](LICENSE): you can use it, change
it, share it and build on it however you like. Contributions back are welcome too.

## Ways to help

- **Report a bug** or **suggest a feature** in [Issues](https://github.com/kleantzogu/Vibe-Tv/issues).
  For playback problems, say which system you're on, what kind of stream it is (HLS, MPEG-TS, Xtream…)
  and what the player shows. Please don't post your provider's stream addresses or logins: they
  contain your username and password.
- **Fix something or add a feature** with a pull request (below).
- **Try the Windows and Linux builds** and tell us what breaks; most testing so far has been on macOS.

## Getting started

You need [Node.js](https://nodejs.org) 20 or newer and Git.

```bash
git clone https://github.com/kleantzogu/Vibe-Tv.git
cd Vibe-Tv
npm install
npm start      # run the app from source
npm test       # run the checks
```

The project layout is in the [README](README.md#project-layout). In short: `main.js` is the main
process (windows, menus, files, network), `src/app.js` is the window, `preload.js` is the only bridge
between them, and `lib/` holds the parts that can be tested without a window.

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Keep each pull request to one change, and describe what it does and how you checked it.
3. Run `npm test` and make sure it passes. Add a check to `test/run.js` for logic you add to `lib/`.
4. For anything visible, run the app (`npm start`) and try it, ideally in both light and dark mode;
   a screenshot in the pull request helps.
5. Match the style around you: plain JavaScript, no frameworks in the window, small functions with a
   comment saying *why* when it isn't obvious, and user-facing text that is short and plain.

Every push and pull request runs the tests on macOS, Windows and Linux.

## Releasing (maintainers)

Raise `"version"` in `package.json`, commit and push, then run `npm run release` on a Mac. It tags the
commit, publishes the macOS installer and update files, and the **Release** workflow builds and adds
the Windows and Linux installers. Installed copies then update themselves. See
[Publish a release](README.md#publish-a-release-and-update-everyone).

## Your own build

You can publish your own build from a fork: set `owner` and `repo` under `build.publish` in
`package.json` to your repository, and your users get updates from your releases. Please give it a
different name and icon if you distribute it widely, so people can tell the two apart.

## Conduct

Be kind and constructive. See the [Code of Conduct](CODE_OF_CONDUCT.md).
