'use strict';
/* The recovery window's bridge to boot.js. Self-contained: nothing here depends on the app. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recovery', {
  get: () => ipcRenderer.invoke('recovery:get'),
  check: () => ipcRenderer.invoke('recovery:check'),
  install: () => ipcRenderer.invoke('recovery:install'),
  retry: () => ipcRenderer.invoke('recovery:retry'),
  copy: () => ipcRenderer.invoke('recovery:copy'),
  releases: () => ipcRenderer.invoke('recovery:releases'),
  report: () => ipcRenderer.invoke('recovery:report'),
  onStatus: (fn) => ipcRenderer.on('recovery:status', (_e, s) => fn(s)),
});
