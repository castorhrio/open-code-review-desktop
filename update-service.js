// SPDX-License-Identifier: Apache-2.0
"use strict";

const path = require("path");
const fs = require("fs");
const { app, ipcMain, shell } = require("electron");
const { autoUpdater } = require("electron-updater");

const RELEASES_URL = "https://github.com/castorhrio/open-code-review-desktop/releases/latest";
const SETTINGS_FILE = () => path.join(app.getPath("userData"), "settings.json");

// The portable target re-extracts to a temp directory on every launch, so there
// is no install root to replace; it can only send the user to the release page.
const isPortable = () => Boolean(process.env.PORTABLE_EXECUTABLE_DIR);

let emit = () => {};
let state = { phase: "idle", current: app.getVersion() };
let downloadedVersion = "";

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE(), "utf8"));
  } catch (_) {
    return {};
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(next));
  } catch (_) {}
  return next;
}

function setState(next) {
  state = { ...state, ...next, current: app.getVersion() };
  emit(state);
  return state;
}

function supportsAutoUpdate() {
  return app.isPackaged && process.platform === "win32" && !isPortable();
}

function configure() {
  // Download starts on its own once an update is found; the user is only asked
  // before the app restarts, which is the one action that interrupts them.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.disableWebInstaller = true;

  if (process.env.OCR_UPDATE_CONFIG) autoUpdater.updateConfigPath = process.env.OCR_UPDATE_CONFIG;
  if (process.env.OCR_DEV_UPDATE_TEST) autoUpdater.forceDevUpdateConfig = true;

  autoUpdater.on("checking-for-update", () => setState({ phase: "checking" }));
  autoUpdater.on("update-available", (info) => {
    downloadedVersion = info.version;
    setState({ phase: "downloading", version: info.version, notes: info.releaseNotes || "" });
  });
  autoUpdater.on("download-progress", (p) =>
    setState({
      phase: "downloading",
      percent: Math.round(p.percent || 0),
      transferred: Math.round((p.transferred || 0) / 1048576),
      total: Math.round((p.total || 0) / 1048576),
    })
  );
  autoUpdater.on("update-downloaded", (info) => {
    downloadedVersion = info.version;
    setState({ phase: "ready", version: info.version });
  });
  autoUpdater.on("error", (err) => {
    const message = (err && err.message) || String(err);
    // A failed check must not look like a crash, and a portable build is told
    // plainly that it has to download by hand.
    setState({
      phase: isPortable() ? "manual" : "error",
      message,
      fallbackUrl: RELEASES_URL,
    });
  });
}

async function check({ interactive } = {}) {
  if (!app.isPackaged && !process.env.OCR_DEV_UPDATE_TEST) {
    return setState({ phase: "unsupported", message: "开发模式不检查更新", fallbackUrl: RELEASES_URL });
  }
  try {
    const res = await autoUpdater.checkForUpdates();
    if (!res) return setState({ phase: interactive ? "manual" : "idle", fallbackUrl: RELEASES_URL });
    if (res.updateInfo.version === app.getVersion() && interactive) {
      return setState({ phase: "up-to-date", version: res.updateInfo.version });
    }
    return state;
  } catch (err) {
    if (interactive) return setState({ phase: "error", message: (err && err.message) || String(err), fallbackUrl: RELEASES_URL });
    return setState({ phase: "idle" });
  }
}

function install() {
  if (!supportsAutoUpdate() || state.phase !== "ready") return false;
  // Let the run/session bookkeeping flush before the process dies.
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return true;
}

function ignore(version) {
  if (version) writeSettings({ ignoredVersion: version });
  return setState({ phase: "idle" });
}

ipcMain.handle("update:state", () => ({
  ...state,
  enabled: readSettings().checkOnLaunch !== false,
  portable: isPortable(),
  packaged: app.isPackaged,
  releasesUrl: RELEASES_URL,
}));

ipcMain.handle("update:check", () => check({ interactive: true }));

ipcMain.handle("update:install", () => install());

ipcMain.handle("update:ignore", (_e, version) => ignore(version));

ipcMain.handle("update:openReleases", () => {
  shell.openExternal(RELEASES_URL);
  return true;
});

ipcMain.handle("update:setEnabled", (_e, enabled) => {
  writeSettings({ checkOnLaunch: Boolean(enabled) });
  return readSettings().checkOnLaunch !== false;
});

function init(sendState) {
  emit = sendState;
  configure();
}

// Delayed so an update check never competes with the first paint or a run the
// user starts immediately after launch.
function scheduleLaunchCheck() {
  if (readSettings().checkOnLaunch === false) return;
  setTimeout(() => {
    const s = readSettings();
    check({ interactive: false });
    if (s.ignoredVersion && s.ignoredVersion === downloadedVersion) {
      setState({ phase: "idle", suppressed: true });
    }
  }, 6000);
}

module.exports = { init, scheduleLaunchCheck, state: () => state, RELEASES_URL };
