// Drives update-service.js's state machine directly, with the updater stubbed.
//
// Why this exists: the update path had no test at all, and it showed. Two of its
// states could never be reached or never be left, and neither is visible in a
// dev build — one needed a packaged build plus a real release, the other needed
// a launch check that found nothing and a look at the Settings page minutes
// later. Both are ordinary branches, so they can be driven here in milliseconds:
//
//   * `suppressed` (the "已忽略" note) was assigned in exactly one place, from a
//     synchronous comparison against a version the async check had not yet
//     learned. Clicking 忽略此版本 therefore did nothing: the next launch
//     announced the same release again, and `autoInstallOnAppQuit` applied it
//     the next time the app closed.
//   * a launch check that found nothing left the phase at "checking" forever,
//     because nothing listened for `update-not-available`. Settings reported
//     正在检查… for the rest of the session.
//
// No network, no Electron, no API key. Run with `npm run audit:update`.
import { createRequire } from "node:module";
import Module from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(ROOT, "package.json"));
const SERVICE = path.join(ROOT, "update-service.js");

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

/**
 * Load a fresh copy of the service with a stubbed updater.
 *
 * `script` is the updater's behaviour for one check: it receives the listener
 * map and decides which events to emit, so a scenario can model anything the
 * real updater does, including emitting nothing at all.
 */
function load({ packaged = true, settings = {}, script }) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-update-"));
  if (Object.keys(settings).length) fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify(settings));

  const listeners = new Map();
  const handlers = new Map();
  const emitted = [];
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    disableWebInstaller: false,
    on: (ev, fn) => listeners.set(ev, fn),
    setFeedURL: () => {},
    quitAndInstall: () => {
      updater.quitCalled = true;
    },
    checkForUpdates: async () => {
      const api = {
        fire: (ev, payload) => listeners.get(ev)?.(payload),
        done: (version) => ({ updateInfo: { version } }),
      };
      return script(api);
    },
  };
  const app = { isPackaged: packaged, getVersion: () => "1.0.0", getPath: () => userData };

  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return { app, ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) }, shell: { openExternal: () => true } };
    if (request === "electron-updater") return { autoUpdater: updater };
    return origLoad.call(this, request, parent, isMain);
  };

  delete require.cache[SERVICE];
  const svc = require(SERVICE);
  Module._load = origLoad;

  svc.init((s) => emitted.push({ ...s }));
  return {
    svc,
    updater,
    handlers,
    emitted,
    userData,
    phases: () => emitted.map((s) => (s.suppressed ? `${s.phase}(suppressed)` : s.phase)),
    settings: () => JSON.parse(fs.readFileSync(path.join(userData, "settings.json"), "utf8")),
    cleanup: () => fs.rmSync(userData, { recursive: true, force: true }),
  };
}

// The launch check is deliberately delayed by 6s so it never competes with the
// first paint, and the IPC channel only offers the interactive variant. Drive
// the exported `check` so the silent path is the silent path.
const launchCheck = (h) => h.svc.check({ interactive: false });
const explicitCheck = (h) => h.handlers.get("update:check")();

/* ---- 1. a check that finds nothing must not stay "checking" ---- */
{
  const h = load({
    script: (api) => {
      api.fire("checking-for-update");
      api.fire("update-not-available", { version: "1.0.0" });
      return api.done("1.0.0");
    },
  });
  await launchCheck(h);
  check(
    "a launch check that finds nothing leaves 正在检查…",
    h.svc.state().phase === "up-to-date",
    `phase=${h.svc.state().phase} after ${h.phases().join(" -> ")}`
  );
  h.cleanup();
}

/* ---- 2. the same, when the updater emits no signal at all ---- */
{
  const h = load({ script: () => ({ updateInfo: { version: "1.0.0" } }) });
  await launchCheck(h);
  check(
    "a check that resolves on the current version still clears 正在检查…",
    h.svc.state().phase === "up-to-date",
    `phase=${h.svc.state().phase}`
  );
  h.cleanup();
}

/* ---- 3. an explicit check that finds nothing ---- */
{
  const h = load({
    script: (api) => {
      api.fire("checking-for-update");
      api.fire("update-not-available", { version: "1.0.0" });
      return api.done("1.0.0");
    },
  });
  await explicitCheck(h);
  check("an explicit check says 已是最新版", h.svc.state().phase === "up-to-date", `phase=${h.svc.state().phase}`);
  h.cleanup();
}

/* ---- 4. a real update reaches "ready" and can be installed ---- */
{
  const h = load({
    script: (api) => {
      api.fire("checking-for-update");
      api.fire("update-available", { version: "9.9.9", releaseNotes: "" });
      api.fire("download-progress", { percent: 40, transferred: 1, total: 2 });
      api.fire("update-downloaded", { version: "9.9.9" });
      return api.done("9.9.9");
    },
  });
  await launchCheck(h);
  const s = h.svc.state();
  check("a found update reaches ready", s.phase === "ready" && s.version === "9.9.9", `phase=${s.phase}`);
  check("install() is accepted from ready", h.svc.state().phase === "ready" && h.handlers.get("update:install")() === true);
  h.cleanup();
}

/* ---- 5. an ignored version must stay ignored across restarts ---- */
{
  const h = load({
    settings: { ignoredVersion: "9.9.9" },
    script: (api) => {
      api.fire("checking-for-update");
      api.fire("update-available", { version: "9.9.9", releaseNotes: "" });
      api.fire("download-progress", { percent: 90, transferred: 9, total: 10 });
      api.fire("update-downloaded", { version: "9.9.9" });
      return api.done("9.9.9");
    },
  });
  await launchCheck(h);
  const s = h.svc.state();
  check("an ignored version is suppressed, not re-announced", s.suppressed === true, `phase=${s.phase} suppressed=${s.suppressed}`);
  check("a suppressed state never reaches ready", s.phase === "idle", `phase=${s.phase}`);
  check(
    "an ignored version cannot install itself on quit",
    h.updater.autoInstallOnAppQuit === false,
    `autoInstallOnAppQuit=${h.updater.autoInstallOnAppQuit}`
  );
  h.cleanup();
}

/* ---- 6. ignoring from the banner persists and shuts the banner ---- */
{
  const h = load({
    script: (api) => {
      api.fire("checking-for-update");
      api.fire("update-available", { version: "9.9.9", releaseNotes: "" });
      api.fire("update-downloaded", { version: "9.9.9" });
      return api.done("9.9.9");
    },
  });
  await launchCheck(h);
  const after = h.handlers.get("update:ignore")({}, "9.9.9");
  check("忽略此版本 persists the choice", h.settings().ignoredVersion === "9.9.9", JSON.stringify(h.settings()));
  check("忽略此版本 shuts the banner", after.phase === "idle" && after.suppressed === true, `phase=${after.phase}`);
  check("忽略此版本 cancels install-on-quit", h.updater.autoInstallOnAppQuit === false);
  h.cleanup();
}

/* ---- 7. a *newer* release after an ignored one must be offered again ---- */
{
  const h = load({
    settings: { ignoredVersion: "9.9.9" },
    script: (api) => {
      api.fire("checking-for-update");
      api.fire("update-available", { version: "9.9.10", releaseNotes: "" });
      api.fire("update-downloaded", { version: "9.9.10" });
      return api.done("9.9.10");
    },
  });
  await launchCheck(h);
  const s = h.svc.state();
  check("a release that was not ignored is offered", s.phase === "ready" && s.version === "9.9.10", `phase=${s.phase}`);
  check("the 已忽略 note does not leak onto a different version", s.suppressed !== true, `suppressed=${s.suppressed}`);
  check(
    "the updater flags are restored for a version that was not ignored",
    h.updater.autoDownload === true && h.updater.autoInstallOnAppQuit === true,
    `autoDownload=${h.updater.autoDownload} autoInstallOnAppQuit=${h.updater.autoInstallOnAppQuit}`
  );
  h.cleanup();
}

/* ---- 8. failures: loud when asked, silent at launch ---- */
{
  const h = load({ script: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")) });
  await launchCheck(h);
  check("a silent launch check fails quietly", h.svc.state().phase === "idle", `phase=${h.svc.state().phase}`);
  h.cleanup();
}
{
  const h = load({ script: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")) });
  await explicitCheck(h);
  check("an explicit check reports the failure", h.svc.state().phase === "error", `phase=${h.svc.state().phase}`);
  h.cleanup();
}
{
  // A channel with zero published releases: the feed's latest.yml answers 404.
  // Not a failure of the machine, and the updater's raw words read as damage,
  // so an explicit check gets its own phase while a silent launch check stays
  // silent — nothing has gone wrong, there is simply nothing there yet.
  const emptyChannel = () =>
    Promise.reject(new Error('Cannot find channel "latest.yml" update info: HttpError: 404 Not Found'));
  const silent = load({ script: emptyChannel });
  await launchCheck(silent);
  check("a silent launch check against an empty channel stays silent", silent.svc.state().phase === "idle", `phase=${silent.svc.state().phase}`);
  silent.cleanup();
  const loud = load({ script: emptyChannel });
  await explicitCheck(loud);
  check("an explicit check against an empty channel says no-release", loud.svc.state().phase === "no-release", `phase=${loud.svc.state().phase}`);
  loud.cleanup();
}
{
  const env = process.env.PORTABLE_EXECUTABLE_DIR;
  process.env.PORTABLE_EXECUTABLE_DIR = "C:/tmp";
  // Both ways a portable build learns there is no auto-update: the updater
  // emitting an error, and the check rejecting outright. Same situation, so it
  // has to be the same answer.
  const emitted = load({
    script: (api) => {
      api.fire("checking-for-update");
      api.fire("error", new Error("portable builds are not auto-updated"));
      return api.done("1.0.0");
    },
  });
  await explicitCheck(emitted);
  check(
    "a portable build is told to download by hand (error event)",
    emitted.svc.state().phase === "manual",
    `phase=${emitted.svc.state().phase}`
  );
  emitted.cleanup();

  const rejected = load({ script: () => Promise.reject(new Error("portable builds are not auto-updated")) });
  await explicitCheck(rejected);
  check(
    "a portable build is told to download by hand (rejected check)",
    rejected.svc.state().phase === "manual",
    `phase=${rejected.svc.state().phase}`
  );
  rejected.cleanup();

  if (env === undefined) delete process.env.PORTABLE_EXECUTABLE_DIR;
  else process.env.PORTABLE_EXECUTABLE_DIR = env;
}

/* ---- 9. a development build says so instead of looking broken ---- */
{
  const h = load({ packaged: false, script: (api) => api.done("1.0.0") });
  await explicitCheck(h);
  check("an unpackaged build reports 开发模式", h.svc.state().phase === "unsupported", `phase=${h.svc.state().phase}`);
  h.cleanup();
}

/* ---- 10. a disabled check must not run at all ---- */
{
  const h = load({ settings: { checkOnLaunch: false }, script: (api) => api.done("1.0.0") });
  h.svc.scheduleLaunchCheck();
  await new Promise((r) => setTimeout(r, 50));
  check("checkOnLaunch:false runs no check", h.emitted.length === 0, `emitted ${h.emitted.length}`);
  check("update:state reports the switch", h.handlers.get("update:state")().enabled === false);
  h.cleanup();
}

console.log(`\n${failures.length ? `${failures.length} failed` : "all update-state checks passed"}`);
if (failures.length) {
  console.error(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
