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
  // `suppressed` describes the state being entered, not a sticky flag, so it is
  // cleared by default: the moment the updater starts talking about a version
  // the user did not ignore, the "已忽略" note has to go with it. Callers that
  // mean it pass `suppressed` explicitly.
  state = { ...state, suppressed: false, ...next, current: app.getVersion() };
  emit(state);
  return state;
}

const ignoredVersion = () => readSettings().ignoredVersion || "";

/**
 * Honour a dismissal that has already been made.
 *
 * Persisting `ignoredVersion` is not enough on its own. `autoDownload` is on, so
 * the build is already on disk by the time anyone can be told about it, and
 * `autoInstallOnAppQuit` would apply it the next time the app closes — which is
 * precisely the thing the user just declined. So an ignored version switches
 * both off and parks the machine in `idle`; the banner stays shut and nothing
 * installs behind the user's back.
 */
function suppress(version) {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  return setState({ phase: "idle", version, suppressed: true });
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

  // updateConfigPath takes a provider-config FILE, not a feed URL; pointing a
  // test feed at a URL has to go through setFeedURL instead.
  if (process.env.OCR_UPDATE_URL) autoUpdater.setFeedURL({ provider: "generic", url: process.env.OCR_UPDATE_URL });
  if (process.env.OCR_DEV_UPDATE_TEST) autoUpdater.forceDevUpdateConfig = true;

  autoUpdater.on("checking-for-update", () => setState({ phase: "checking" }));
  // The signal that a check finished and found nothing newer. There was no
  // listener for it, so the phase stayed at "checking" for the rest of the
  // session: a launch check that found nothing left Settings reporting
  // 正在检查… indefinitely, a spinner nobody ever saw finish.
  autoUpdater.on("update-not-available", (info) =>
    setState({ phase: "up-to-date", version: (info && info.version) || app.getVersion() })
  );
  autoUpdater.on("update-available", (info) => {
    if (info.version && info.version === ignoredVersion()) return suppress(info.version);
    // Paired with `suppress()` below, which switches both flags off. Without
    // this, ignoring one version would leave `autoDownload` off for the rest of
    // the session — and the next release would be announced as "正在下载" while
    // nothing downloaded at all.
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    setState({ phase: "downloading", version: info.version, notes: info.releaseNotes || "" });
  });
  autoUpdater.on("download-progress", (p) => {
    // An ignored build has no cancel API, so it keeps downloading — but its
    // progress must not re-open the banner the user just dismissed.
    if (state.suppressed) return;
    setState({
      phase: "downloading",
      percent: Math.round(p.percent || 0),
      transferred: Math.round((p.transferred || 0) / 1048576),
      total: Math.round((p.total || 0) / 1048576),
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    if (info.version && info.version === ignoredVersion()) return suppress(info.version);
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

const CHECK_TIMEOUT_MS = 25000;

async function check({ interactive } = {}) {
  if (!app.isPackaged && !process.env.OCR_DEV_UPDATE_TEST) {
    return setState({ phase: "unsupported", message: "开发模式不检查更新", fallbackUrl: RELEASES_URL });
  }
  try {
    const res = await Promise.race([
      autoUpdater.checkForUpdates(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("检查超时（25 秒无响应，可能是网络或代理拦截）")), CHECK_TIMEOUT_MS)
      ),
    ]);
    if (!res) return setState({ phase: interactive ? "manual" : "idle", fallbackUrl: RELEASES_URL });
    const latest = (res.updateInfo && res.updateInfo.version) || "";
    // Belt and braces for the event above: a check that resolves on the current
    // version must not leave the phase at "checking", whether or not the updater
    // emitted its own signal first. Only acts when the check has produced no
    // verdict of its own — "checking" is still in flight, "idle" means the
    // updater emitted nothing at all.
    if (latest === app.getVersion() && (state.phase === "checking" || state.phase === "idle")) {
      setState({ phase: "up-to-date", version: latest });
    }
    return state;
  } catch (err) {
    const message = (err && err.message) || String(err);
    // A channel with zero published releases answers 404 for latest.yml. That is
    // not the machine or the network failing, and the updater's own words —
    // Cannot find channel "latest.yml" update info: HttpError: 404 — read as
    // damage. It is the state every install is in until the first Release
    // exists, so an explicit check gets its own sentence; a silent launch check
    // stays silent, because nothing has gone wrong.
    if (/404|cannot find channel|latest\.yml/i.test(message)) {
      if (!interactive) return setState({ phase: "idle" });
      return setState({ phase: "no-release", message, fallbackUrl: RELEASES_URL });
    }
    // A portable build cannot auto-update in any form, so it gets the same
    // "download it by hand" message the `error` event produces. It used to
    // depend on how the failure arrived: an emitted error said 无法自动更新,
    // while a rejected check said 检查失败 in red — same situation, two answers.
    if (isPortable()) return setState({ phase: "manual", message, fallbackUrl: RELEASES_URL });
    if (interactive) return setState({ phase: "error", message, fallbackUrl: RELEASES_URL });
    return setState({ phase: "idle" });
  }
}

function install() {
  if (!supportsAutoUpdate() || state.phase !== "ready") return false;
  // Let the run/session bookkeeping flush before the process dies.
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
  return true;
}

function ignore(version) {
  if (version) writeSettings({ ignoredVersion: version });
  return suppress(version || "");
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
//
// There used to be a `suppressed` check here, reading `downloadedVersion`
// straight after firing the check. It could never fire: `downloadedVersion` is
// only assigned once the updater has answered, which is network time away, so
// the comparison always ran against "". Suppression now happens in the handlers
// that actually learn the version.
function scheduleLaunchCheck() {
  if (readSettings().checkOnLaunch === false) return;
  setTimeout(() => check({ interactive: false }), 6000);
}

// `check` is exported for `tools/update-state.mjs`. The IPC channel only ever
// asks for an interactive check, so without this the silent launch path — the
// one that must stay quiet on failure and must still clear "checking" — is
// reachable only by waiting out the 6s launch delay in a real app.
module.exports = { init, scheduleLaunchCheck, check, state: () => state, RELEASES_URL };
