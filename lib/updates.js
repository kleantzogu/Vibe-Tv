'use strict';
/*
 * Updates from GitHub Releases (electron-updater).
 *
 * Every release (the Release workflow publishes one for each merge to main) carries the installers
 * plus a small file that says which version is the newest (latest-mac.yml, latest.yml,
 * latest-linux.yml). The app reads it at launch and every few hours. An update is only applied when
 * it is signed like the installed app.
 *
 * Two ways to take an update, chosen in the app menu ("Install Updates Automatically"):
 *  - automatic (default): it downloads quietly and installs when the app quits, so the next launch is
 *    the new version; the window offers "Restart now" for anyone who doesn't want to wait;
 *  - ask: the window says a new version is out and downloads it only when asked.
 */
const EventEmitter = require('events');

const CHECK_EVERY = 6 * 3600 * 1000;
const FIRST_CHECK_AFTER = 5000;

class Updates extends EventEmitter {
  /**
   * @param {object} o
   * @param {boolean} o.enabled  false when running from source (nothing to update)
   * @param {boolean} o.auto     download and install without asking
   * @param {string} [o.feedUrl] test feed (a folder served over http) instead of GitHub
   */
  constructor({ enabled, auto, feedUrl, currentVersion }) {
    super();
    this.enabled = !!enabled;
    this.auto = !!auto;
    this.state = { status: this.enabled ? 'idle' : 'off', version: '', progress: 0, notes: '', error: '', current: currentVersion, manual: false };
    this.timer = null;
    if (!this.enabled) return;

    const { autoUpdater } = require('electron-updater');
    this.u = autoUpdater;
    autoUpdater.logger = null;
    autoUpdater.autoDownload = this.auto;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    if (feedUrl) {
      autoUpdater.forceDevUpdateConfig = true;
      autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
    }

    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', error: '' }));
    autoUpdater.on('update-not-available', () => this.set({ status: 'none' }));
    autoUpdater.on('update-available', (info) =>
      this.set({ status: this.auto ? 'downloading' : 'available', version: info.version, notes: notesText(info.releaseNotes), progress: 0 })
    );
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', progress: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', (info) => this.set({ status: 'ready', version: info.version, progress: 100 }));
    autoUpdater.on('error', (e) => this.set({ status: 'error', error: friendlyError(e) }));
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
    // A check the person asked for has been answered: later background checks report quietly again.
    if (this.state.manual && ['none', 'error', 'available', 'ready'].includes(this.state.status)) this.state = { ...this.state, manual: false };
  }

  start() {
    if (!this.enabled) return;
    setTimeout(() => this.check(false), FIRST_CHECK_AFTER);
    this.timer = setInterval(() => this.check(false), CHECK_EVERY);
  }

  /** manual: the person asked (menu), so "you're up to date" and errors are worth showing. */
  async check(manual) {
    if (!this.enabled) return this.state;
    if (['checking', 'downloading', 'ready'].includes(this.state.status)) {
      if (manual) this.set({ manual: true });
      return this.state;
    }
    this.set({ manual: !!manual });
    try {
      await this.u.checkForUpdates();
    } catch (e) {
      this.set({ status: 'error', error: friendlyError(e) });
    }
    return this.state;
  }

  async download() {
    if (!this.enabled || this.state.status !== 'available') return this.state;
    this.set({ status: 'downloading', progress: 0 });
    try {
      await this.u.downloadUpdate();
    } catch (e) {
      this.set({ status: 'error', error: friendlyError(e) });
    }
    return this.state;
  }

  install() {
    if (this.enabled && this.state.status === 'ready') this.u.quitAndInstall(false, true);
  }

  setAuto(on) {
    this.auto = !!on;
    if (!this.enabled) return;
    this.u.autoDownload = this.auto;
    // Switched to automatic while an update waits: fetch it now.
    if (this.auto && this.state.status === 'available') this.download();
  }
}

// GitHub release notes arrive as HTML (or a list of them): plain text is enough for a short preview.
function notesText(notes) {
  const raw = Array.isArray(notes) ? notes.map((n) => n.note || '').join('\n') : String(notes || '');
  return raw
    .replace(/<\/(p|li|h\d)>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 600);
}

function friendlyError(e) {
  const m = String((e && e.message) || e || '');
  if (/ENOTFOUND|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ENETUNREACH/.test(m)) return 'No internet connection';
  if (/404|Cannot find latest|No published versions/i.test(m)) return 'No release has been published yet';
  if (/code signature|not signed|signature/i.test(m)) return 'The downloaded update is not signed like this app, so it was not installed';
  if (/ERR_CONNECTION|ECONNREFUSED|ETIMEDOUT|timed out/i.test(m)) return 'The update server could not be reached';
  return m.split('\n')[0].slice(0, 160) || 'Something went wrong';
}

module.exports = { Updates, notesText, friendlyError };
