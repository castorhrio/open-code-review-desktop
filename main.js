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
const { createAppStore, reportOutcome, flushNow, flushBeforeQuit } = require("./run-diagnostics");
const { makeRunHandler } = require("./run-handler");
const { makeConfigHandlers } = require("./config-handler");
const { createInstall } = require("./install-info");

const DOCS_URL = "https://open-codereview.ai/docs";

let mainWindow = null;

const boundsFile = () => path.join(app.getPath("userData"), "window-bounds.json");
// The store keys every entry by the folder it belongs to, and whether two
// spellings of one folder are the same folder is a property of the *volume*
// that folder is on — not of the OS: a macOS volume can be formatted
// case-sensitive, and a Linux one can be mounted case-insensitively. The
// platform's default is a guess, so the volume is asked instead.
//
// The question is asked of the repository's own path, because that is the path
// the key is about: the profile directory's volume would answer a different
// question (and on macOS it usually gives the wrong one — the system disk is
// case-insensitive even when the drive the work sits on is not). Nothing is
// written to ask it, and a volume that cannot answer falls back to the
// platform's default.
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
          click: () => install.revealPath(ocr.CONFIG_PATH),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------- ipc: app ---------------- */

ipcMain.handle("app:info", async () => {
  const bin = ocr.binaryPath();
  let version = "";
  if (bin) {
    const res = await ocr.exec(["version"]);
    version = (res.stdout || res.stderr || "").trim().split(/\r?\n/).filter(Boolean)[0] || "";
  }
  return {
    binary: bin,
    version: version.replace(/^open-code-review\s*/, ""),
    configPath: ocr.CONFIG_PATH,
    docsUrl: DOCS_URL,
    appVersion: app.getVersion(),
    platform: process.platform,
    ...install.installInfo(),
  };
});

/* ---------------- ipc: install ---------------- */

ipcMain.handle("app:openInstallDir", async () => {
  const plan = install.installDirPlan();
  if (!plan.ok) return plan;
  const err = await shell.openPath(plan.dir);
  return err ? { ok: false, error: err } : { ok: true };
});

ipcMain.handle("app:uninstall", async () => {
  const plan = install.uninstallPlan();
  if (!plan.ok) return plan;
  const { target } = plan;
  // The uninstaller deletes the directory this process runs from, so the app has
  // to be gone first — otherwise Windows keeps the files locked and the
  // uninstaller reports them as in use.
  //
  // The evidence is written before the uninstaller starts, not during the quit:
  // `flushBeforeQuit` fires on the `app.quit()` below, by which time the
  // uninstaller is already deleting the profile directory it would write to.
  //
  // The second flush that `before-quit` then performs is deliberately harmless:
  // it calls `drain()` on a queue this flush just emptied, so it settles in the
  // same tick and the quit proceeds — unless a run finished in the meantime and
  // queued one more write, which is exactly the case that should be waited for.
  // Nothing here writes after the uninstaller starts except that last write,
  // and a failed one reports `io-error` instead of throwing.
  //
  // A flush that gave up (a queue that never stopped moving, or a disk that did
  // not answer in time) is logged before the uninstaller starts: it deletes the
  // profile directory right after, so this is the last moment the loss can be
  // reported at all.
  reportOutcome(await flushNow(runDiagnostics));
  try {
    spawn(target, [], { detached: true, stdio: "ignore", windowsHide: false }).unref();
  } catch (err) {
    return { ok: false, error: `启动卸载程序失败：${err.message}` };
  }
  setTimeout(() => app.quit(), 400);
  return { ok: true };
});

/* The table is parsed by ocr-service, not here: the readiness view judges
 * built-in names by the same output, and two parsers for one table is how the
 * list the user picks from and the list the config is judged by start disagreeing
 * after an upstream column-width change. It also means both callers share one
 * read (and one failure window) instead of one spawn each.
 */
ipcMain.handle("app:providers", async () => {
  const table = await ocr.providerTable();
  if (!table.ok) return { ok: false, error: ocr.withHint(table.error), value: [] };
  return { ok: true, value: table.rows };
});

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
  if (!repo) return { error: "请先选择仓库" };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "选择要扫描的子目录（可留空表示整个仓库）",
    buttonLabel: "使用此目录",
    defaultPath: repo,
    properties: ["openDirectory"],
  });
  if (result.canceled || !result.filePaths.length) return {};
  const picked = path.resolve(result.filePaths[0]);
  const root = path.resolve(repo);
  if (picked !== root && !picked.startsWith(root + path.sep)) {
    return { error: "所选目录不在该仓库内" };
  }
  const rel = path.relative(root, picked).split(path.sep).join("/");
  return { relPath: rel || "" };
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

ipcMain.handle("file:open", (_e, absPath) => shell.openPath(absPath));

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
