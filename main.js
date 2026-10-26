// SPDX-License-Identifier: Apache-2.0
"use strict";

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { spawn } = require("child_process");
const { app, BrowserWindow, dialog, ipcMain, shell, Menu } = require("electron");

const ocr = require("./ocr-service");
const git = require("./git-service");
const { installNavigationGuards } = require("./security");
const updater = require("./update-service");
const { createAppStore, statsReport, flushBeforeQuit } = require("./run-diagnostics");
const { makeRunHandler } = require("./run-handler");
const { makeUninstallHandler } = require("./uninstall-handler");
const { makeConfigHandlers } = require("./config-handler");
const { createInstall } = require("./install-info");
const { pickInsideAnswer, pickInsidePayload } = require("./path-guard");
const { providersAnswer } = require("./provider-handler");
const { formatAppInfo } = require("./app-info");

const DOCS_URL = "https://open-codereview.ai/docs";

let mainWindow = null;

// Where the window's size and position are remembered between launches: one
// small JSON file in the profile directory, read on launch and written on close.
const boundsFile = () => path.join(app.getPath("userData"), "window-bounds.json");

const runDiagnostics = createAppStore(path.join(app.getPath("userData"), "run-diagnostics.json"));

function readBounds() {
  try {
    const raw = JSON.parse(fs.readFileSync(boundsFile(), "utf8"));
    if (Number.isFinite(raw.width) && Number.isFinite(raw.height) && raw.width > 400 && raw.height > 400) {
      return raw;
    }
  } catch (_) {}
  return { width: 1320, height: 880 };
}

function createWindow() {
  const bounds = readBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 1000,
    minHeight: 660,
    backgroundColor: "#0d1017",
    title: "Open Code Review",
    icon: path.join(__dirname, "assets", "icon.png"),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    // `npm run dev` launches Vite and Electron together, so the dev server may
    // not be listening yet on the first attempt.
    const tryLoad = (attempt) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.loadURL(devUrl).catch(() => {
        if (attempt < 40) setTimeout(() => tryLoad(attempt + 1), 300);
      });
    };
    tryLoad(0);
  } else {
    mainWindow.loadFile(path.join(__dirname, "out", "index.html"));
  }
  mainWindow.on("close", () => {
    if (mainWindow.isMaximized() || mainWindow.isMinimized()) return;
    try {
      fs.writeFileSync(boundsFile(), JSON.stringify(mainWindow.getBounds()));
    } catch (_) {}
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

updater.init((state) => send("update:state", state));

const install = createInstall({ app, shell });

function buildMenu() {
  const template = [
    // macOS puts the app name and Quit in a mandatory first menu; without it the
    // system menu bar has no way to quit the app.
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    {
      label: "文件",
      submenu: [
        {
          label: "打开仓库…",
          accelerator: "CmdOrCtrl+O",
          click: () => send("menu:open-repo"),
        },
        { type: "separator" },
        ...(process.platform === "darwin" ? [{ role: "close" }] : [{ role: "quit" }]),
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload" },
        { role: "toggledevtools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "帮助",
      submenu: [
        { label: "Open Code Review 文档", click: () => shell.openExternal(DOCS_URL) },
        {
          label: "打开配置文件所在目录",
          click: () => void install.revealPath(ocr.CONFIG_PATH),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------- ipc ----------------
 *
 * Where the body of an `ipcMain.handle` lives: if it is one call to one
 * collaborator, it stays here. If what it promises is an *order* (flush then
 * spawn then reply then quit), a *gate* (only one run at a time) or a *retry*,
 * it goes to a `*-handler.js`, because a behaviour can only be checked by
 * calling it — and a registration cannot.
 */

/* ---------------- ipc: app ---------------- */

// The assembly lives in `app-info.js`: a value built inside a handler can only
// be observed by launching Electron, and the absent-data shapes (no binary, a
// version on stderr) are exactly the ones the settings page shows verbatim.
ipcMain.handle("app:info", async () => {
  const binary = ocr.binaryResolution();
  let versionStdout = "";
  let versionStderr = "";
  if (binary.path) {
    const res = await ocr.exec(["version"]);
    versionStdout = res.stdout || "";
    versionStderr = res.stderr || "";
  }
  return formatAppInfo({
    binary,
    versionStdout,
    versionStderr,
    configPath: ocr.CONFIG_PATH,
    docsUrl: DOCS_URL,
    appVersion: app.getVersion(),
    platform: process.platform,
    installInfo: install.installInfo(),
  });
});

/* ---------------- ipc: install ---------------- */

ipcMain.handle("app:openInstallDir", async () => {
  const plan = install.installDirPlan();
  if (!plan.ok) return plan;
  // `install.openDir()` answers with `{ ok, error, action, path }` — the same
  // fields `revealPath()` uses for the other "open a directory" button — so the
  // renderer reads one shape whichever button failed.
  return install.openDir(plan.dir);
});

// The handler body lives in `uninstall-handler.js`: the order it is made of
// (flush the evidence, then spawn the uninstaller, then let the reply out, then
// quit) is a behaviour, and a behaviour can only be checked by calling it. This
// registration is all that is left, and it is also where the two platform
// details stay: how a detached process is started, and how this app quits.
//
// The flush is the reason the handler exists as its own thing. The uninstaller
// deletes the profile directory, and `before-quit` fires after it has started —
// so the evidence has to be on disk *before* the spawn, not during the quit.
const uninstall = makeUninstallHandler({
  install,
  store: runDiagnostics,
  // Detached and `unref`ed: the uninstaller outlives this process by design,
  // because it deletes the directory this process runs from.
  spawn: (target) => spawn(target, [], { detached: true, stdio: "ignore", windowsHide: false }).unref(),
  quit: () => app.quit(),
  // The two sentences this path can produce — a flush that lost evidence, and a
  // quit that did not take — have to land where a packaged app can read them.
  // `console.warn` is not that place: an installed Windows app has no terminal,
  // so the same `run:log` the run paths use is the one sink, and the drawer that
  // self-opens on a trouble line is where these are read.
  warn: (line) => send("run:log", { line }),
});
ipcMain.handle("app:uninstall", uninstall);

// The answer's shape (a list even when the read failed) and its error sentence
// (with the hint appended) live in `provider-handler.js`: the settings page reads
// `value` as a list without asking `ok` first, and the hint is the only part of
// the message the user can act on. This registration is all that is left, and it
// is also the one place that hands over the real `withHint`.
ipcMain.handle("app:providers", async () =>
  providersAnswer(await ocr.providerTable(), { withHint: ocr.withHint })
);

/* ---------------- ipc: repo ---------------- */

ipcMain.handle("repo:pick", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择要审查的仓库目录",
    buttonLabel: "选择此文件夹",
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths.length) return "";
  return result.filePaths[0];
});

ipcMain.handle("repo:pickInside", async (_e, repo) => {
  // The three answers the picker can give are decided in `path-guard.js`; this
  // registration only asks the dialog and hands the result to that translation.
  // `no-repo` is the same request with the dialog skipped, because there is
  // nothing to default the dialog's start directory to.
  if (!repo) return pickInsidePayload(pickInsideAnswer(repo, null));
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择要扫描的子目录（可留空表示整个仓库）",
    buttonLabel: "使用此目录",
    defaultPath: repo,
    properties: ["openDirectory"],
  });
  const picked = result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  return pickInsidePayload(pickInsideAnswer(repo, picked));
});

ipcMain.handle("repo:pickFile", async (_e, opts) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: (opts && opts.title) || "选择文件",
    buttonLabel: "选择此文件",
    properties: ["openFile"],
    filters: (opts && opts.filters) || [{ name: "所有文件", extensions: ["*"] }],
  });
  if (result.canceled || !result.filePaths.length) return "";
  return result.filePaths[0];
});

ipcMain.handle("repo:inspect", (_e, repo) => git.inspect(repo));

ipcMain.handle("repo:resolveRef", (_e, req) => git.resolveRef(req.repo, req.ref));

/* ---------------- ipc: review ---------------- */

ipcMain.handle("review:preview", (_e, spec) => ocr.preview(spec));

// The handler body lives in `run-handler.js`, not here: what it promises (one
// run, one exit) is a behaviour, and a behaviour can only be checked by running
// it. This registration is all that is left — and this file still does not name
// the exit channel, so the exit cannot be sent from anywhere but the door.
//
// The one `sink` is the decision about every line that belongs to a run: the
// CLI's own progress lines, and the three end-of-run lines that have no exit
// payload to ride on (`signal-failed`, `settle-failed`, and a write that lands
// after the bound). They all go to `run:log`, so the renderer's log drawer is
// the one place they are read. It opens itself on a line that reads like
// trouble, and the `id` is the one the CLI gave the run — the same id the exit
// payload carries — so the line is filed under the run it belongs to. The
// alternative (a file under `userData`) would need a second way to read it;
// stderr is not a place, since a packaged app has no terminal to read it from.
const runLog = (line, id) => send("run:log", { id, line });
const runReview = makeRunHandler({
  ocr,
  store: runDiagnostics,
  send,
  sink: runLog,
});
ipcMain.handle("review:run", (_e, spec) => runReview(spec));

ipcMain.handle("review:cancel", (_e, id) => ocr.cancelRun(id));

/* ---------------- ipc: files ---------------- */

ipcMain.handle("file:read", async (_e, req) =>
  // The policy lives in git-service: a ref means that ref's snapshot (HEAD
  // included), no ref means the working tree, and a failed ref read is reported
  // instead of quietly replaced by the working copy.
  git.readFile(req.repo, req.path, {
    ref: req.ref,
    startLine: req.startLine,
    endLine: req.endLine,
    pad: req.pad || 12,
  })
);

// `shell.openPath()` resolves to an error string rather than rejecting, so the
// answer has to be read. `install.openFile()` does that and answers the same
// `{ ok, error, action, path }` shape as `file:reveal`; returning the raw string
// (what this line used to do) told the renderer a file opened when it did not.
ipcMain.handle("file:open", (_e, absPath) => install.openFile(absPath));

ipcMain.handle("file:reveal", (_e, absPath) => install.revealPath(absPath));

ipcMain.handle("file:saveText", async (_e, req) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: req.title || "保存",
    defaultPath: req.suggestedName,
    filters: req.filters || [{ name: "JSON", extensions: ["json"] }],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(result.filePath, req.text, "utf8");
    return { ok: true, file: result.filePath };
  } catch (err) {
    return { ok: false, error: `写入失败：${err.message}` };
  }
});

ipcMain.handle("file:openUrl", (_e, url) => {
  if (!/^https?:\/\//i.test(url)) return false;
  shell.openExternal(url);
  return true;
});

/* ---------------- ipc: config ---------------- */

// The handler bodies live in `config-handler.js` for the same reason the run
// handler does: what a save writes and which withheld-Key reason it passes back
// are behaviours, and a behaviour can only be checked by calling it. This file
// only wires them to channels.
const config = makeConfigHandlers({ ocr, tempRoot: app.getPath("temp") });
ipcMain.handle("config:read", config.read);
ipcMain.handle("config:savedKey", config.savedKey);
ipcMain.handle("config:save", config.save);
ipcMain.handle("config:removeEntry", config.removeEntry);
ipcMain.handle("config:use", config.use);
ipcMain.handle("config:unset", config.unset);
ipcMain.handle("config:test", config.test);

/* ---------------- ipc: sessions & rules ---------------- */

ipcMain.handle("session:list", (_e, req) => ocr.listSessions(req.repo, req.limit));

ipcMain.handle("session:comments", (_e, req) => ocr.sessionComments(req.repo, req.sessionId));

// The truncation facts the CLI does not persist with the session. The read waits
// for a write that is still in flight: the run-exit path only waits a bounded
// time for the evidence (a profile directory on a network mount can be slow), so
// a session reopened right after such a run could otherwise be read while its
// own evidence was still being written — and a truncated session would look
// clean again.
ipcMain.handle("session:diagnostics", async (_e, req) => ({
  ok: true,
  value: await runDiagnostics.readSettled(req.repo, req.sessionId),
}));

// The truncation-evidence store's cap, in the terms the settings page states
// it: how many records it keeps (one budget for every repository), how much of
// it this profile is using and how many repositories that is. The read waits
// for the writes still in flight, and answers `settled: false` when that wait
// gave up rather than a count that silently omits the run that just finished —
// the page says so instead of presenting a stale number as current.
//
// The answer is an `Ok`: "this profile has no records" and "I could not read
// the records" are different news, and a page that renders both as `0` sends
// the user to look at a file it never managed to open. The wording of the
// failure is written next to `stats` (`statsReport` in run-diagnostics.js), so
// the renderer shows the reason it was given rather than a string of its own.
ipcMain.handle("diagnostics:stats", () => statsReport(runDiagnostics));

ipcMain.handle("session:export", async (_e, req) => {
  const save = await dialog.showSaveDialog(mainWindow, {
    title: "导出会话报告",
    defaultPath: `ocr-${req.sessionId.slice(0, 8)}.html`,
    filters: [{ name: "HTML 报告", extensions: ["html"] }],
  });
  if (save.canceled || !save.filePath) return { ok: false, canceled: true };
  const res = await ocr.exportSession(req.repo, req.sessionId, save.filePath);
  return res.ok ? { ...res, opened: await shell.openPath(save.filePath) === "" } : res;
});

ipcMain.handle("session:delete", async (_e, req) => {
  const res = await ocr.deleteSession(req.sessionId, req.repo);
  // Deleting the session makes its truncation evidence unreadable anyway, so a
  // failed removal is not worth a warning — but the write still has to be
  // queued with the records, or it can drop one that lands at the same moment.
  if (res.ok) runDiagnostics.remove(req.repo, req.sessionId).catch(() => {});
  return res;
});

ipcMain.handle("rules:check", (_e, req) => ocr.rulesCheck(req.repo, req.path, req.rule));

/* ---------------- lifecycle ---------------- */

// The truncation evidence is written asynchronously, and the app can be closed
// right after a run finishes — the write may still be in flight. Electron does
// not wait for pending promises when the main process exits, so that evidence
// would be gone and the reopened session would look clean again, which is the
// one thing the store exists to prevent. The quit waits for it.
flushBeforeQuit(app, runDiagnostics);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Without this Windows groups the taskbar entry under Electron's host and
  // shows the stock Electron icon even when BrowserWindow.icon is set.
  if (process.platform === "win32") app.setAppUserModelId("com.xyris.open-code-review-desktop");

  app.on("second-instance", () => {
    if (!mainWindow) return createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    updater.scheduleLaunchCheck();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Deny window.open and any navigation off the app's own document; see
// security.js for why. The URL is whatever createWindow() is about to load.
installNavigationGuards({
  app,
  shell,
  appUrl: process.env.ELECTRON_RENDERER_URL || pathToFileURL(path.join(__dirname, "out", "index.html")).href,
});
