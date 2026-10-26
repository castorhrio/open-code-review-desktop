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
const {
  createAppStore,
  WRITE_TIMEOUT_MS,
  outcomeMessage,
  reportOutcome,
  settleRunExit,
  flushNow,
  flushBeforeQuit,
} = require("./run-diagnostics");

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

// shell.showItemInFolder() does nothing at all when the path does not exist —
// and the CLI config is absent until the first save, which is exactly when a
// newcomer clicks this. Fall back to the nearest existing ancestor.
function revealPath(target) {
  if (!target) return { ok: false, error: "没有可显示的路径" };
  let existing = target;
  while (existing && !fs.existsSync(existing)) existing = path.dirname(existing);
  if (!existing) return { ok: false, error: `路径不存在：${target}` };
  if (existing === target) {
    shell.showItemInFolder(target);
    return { ok: true, action: "reveal", path: target };
  }
  shell.openPath(existing);
  return { ok: true, action: "open-parent", path: existing, missing: target };
}

/* Where the app itself lives, as opposed to where its config lives. The
 * renderer shows these so "打开安装目录 / 卸载" never needs a user to guess a
 * path. `resourcesPath` is `<install>/resources`, so its parent is the root the
 * NSIS installer created. A portable build extracts to a temp dir each launch,
 * which is why it is reported separately instead of being called an install. */
function installInfo() {
  const packaged = app.isPackaged;
  const portable = Boolean(process.env.PORTABLE_EXECUTABLE_DIR);
  const installDir = packaged && !portable ? path.dirname(process.resourcesPath) : "";
  return {
    packaged,
    portable,
    installDir,
    userData: app.getPath("userData"),
    executable: app.getPath("exe"),
    canUninstall: process.platform === "win32" && Boolean(uninstallerPath(installDir)),
  };
}

// NSIS writes `Uninstall <productName>.exe` into the install root; scanning for
// it is more robust than re-deriving the name from productName.
function uninstallerPath(installDir) {
  if (process.platform !== "win32" || !installDir || !fs.existsSync(installDir)) return "";
  try {
    const hit = fs.readdirSync(installDir).find((f) => /^Uninstall.*\.exe$/i.test(f));
    return hit ? path.join(installDir, hit) : "";
  } catch (_) {
    return "";
  }
}

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
          click: () => revealPath(ocr.CONFIG_PATH),
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
    ...installInfo(),
  };
});

/* ---------------- ipc: install ---------------- */

ipcMain.handle("app:openInstallDir", async () => {
  const dir = installInfo().installDir;
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: "当前形态没有安装目录（免安装版运行时解压在临时目录）" };
  const err = await shell.openPath(dir);
  return err ? { ok: false, error: err } : { ok: true };
});

ipcMain.handle("app:uninstall", async () => {
  const info = installInfo();
  const target = uninstallerPath(info.installDir);
  if (!target) {
    return {
      ok: false,
      error: info.portable
        ? "免安装版没有卸载器：直接删除该 exe 即可，程序不写注册表。"
        : "没有找到卸载程序，请到「设置 → 应用」中卸载。",
    };
  }
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

ipcMain.handle("review:run", (_e, spec) => {
  return ocr.startRun(
    spec,
    (id, line) => send("run:log", { id, line }),
    (id, result) => {
      // The CLI does not persist warnings, so this is the only moment the
      // round-limit signal exists. Record before the exit event reaches the
      // renderer, which may refresh history immediately: the write is queued and
      // asynchronous (one whole-file read-modify-write at a time), so `run:exit`
      // waits for it — otherwise the renderer could read `session:diagnostics`
      // and find nothing simply because the rename had not landed yet.
      //
      // That wait is bounded (`recordBounded`, the same 2s the exit flush uses):
      // the store's file lives in the profile directory, which can be a network
      // mount, and an unbounded wait there would hold `run:exit` — and every
      // spinner that ends on it — for as long as the disk took. Past the bound
      // the renderer is told the run is over and the write stays queued, so it
      // still lands (and a quit still waits for it).
      //
      // Only a lost `io-error` is real news. `no-session` is a known shape — the
      // CLI answered with truncation evidence but printed no session id at all
      // (it is not a scan run: `ocr scan` publishes a session id like every
      // other mode) — so there is no session to reopen, the warning cannot be
      // lost, and warning about it every time would train the reader to ignore
      // the line that matters. An
      // `io-error` means the *reopened* session will look clean again even
      // though this one was truncated, and nothing in the UI can show that.
      // A `timeout` is not a loss: the write stays queued and the read of the
      // session waits for it (`readSettled`), so the reopened session still
      // shows the truncation — it is only this run's exit that did not wait.
      //
      // A write that only finishes *after* the bound reports through `onLate`:
      // by then `run:exit` has been sent, so the only place left for the news
      // is this log. Without it, a full disk under a slow profile directory
      // (the two usually arrive together) loses the evidence and says nothing.
      //
      // `settleRunExit` owns the order — the record first, the exit signal
      // after — because the renderer refreshes the history the moment it hears
      // `run:exit`, and a record that has not landed yet would make a
      // truncated session look clean again. The outcome rides along with the
      // signal so the app can say out loud when the evidence did not make it
      // to disk; the wording comes from the same place as the log line below,
      // so there is only one version of it.
      settleRunExit({
        store: runDiagnostics,
        repo: spec.repo,
        sessionId: result.sessionId || (result.value && result.value.session_id) || "",
        result: result.value || null,
        timeoutMs: WRITE_TIMEOUT_MS,
        onLate: (late) => reportOutcome(late, undefined, { late: true }),
        signal: (outcome) =>
          send("run:exit", { id, result, diagnostics: { ...outcome, message: outcomeMessage(outcome) } }),
      }).catch(() => {});
    },
    (id, progress) => send("run:progress", { id, progress })
  );
});

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

ipcMain.handle("file:reveal", (_e, absPath) => revealPath(absPath));

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

/* The readiness view needs one fact this file can only get asynchronously: the
 * CLI's own list of built-in services. `readConfigView` is a synchronous read of
 * the config file, so the list is fetched once (ocr-service caches it) and handed
 * in — the view stays a pure function of the file plus that list, and a
 * hand-edited `providers` entry is judged by the CLI's rule instead of by "the
 * section happens to have this key".
 *
 * `refresh` is only true when the user pressed 刷新: a failed read is remembered
 * for a short window so the settings page cannot spawn a doomed process on every
 * re-render, which would make that button the one thing that does *not* retry.
 */
const configView = async (refresh = false) =>
  ocr.readConfigView({ presetNames: await ocr.presetNames({ refresh }) });

ipcMain.handle("config:read", (_e, opts) => configView(Boolean(opts && opts.refresh)));

// "May I leave the Key field blank for what the form is pointed at, and if not,
// why not?" — the one question the settings page needs answered *before* it asks
// the user anything. The Key itself never crosses this boundary (see
// `savedKeyLookup`); the renderer only gets the reason and the sentence built
// from it, so a wording that distinguishes six causes can be asserted without
// launching Electron.
//
// The lookup happens in the main process because it consults the CLI's own table
// (`ocr llm providers`), which the renderer does not hold: the form's Base URL
// for a built-in service is prefilled from that table, so asking here keeps the
// answer and the field it is about on the same source.
ipcMain.handle("config:savedKey", async (_e, req) => {
  const form = req || {};
  const found = await ocr.savedKeyLookupByName(form.name, form.url);
  return { ok: true, available: Boolean(found.key), reason: found.reason, hint: ocr.savedKeyFieldHint(found.reason) };
});

ipcMain.handle("config:save", async (_e, form) => {
  const pairs = [];
  const name = (form.provider || "").trim();
  if (!name) return { ok: false, error: "未选择 provider", steps: [] };

  if (form.isCustom) {
    if (form.url) pairs.push([`providers.${name}.url`, form.url]);
    if (form.protocol) pairs.push([`providers.${name}.protocol`, form.protocol]);
  }
  if (form.apiKey) pairs.push([`providers.${name}.api_key`, form.apiKey]);
  if (form.model) pairs.push([`providers.${name}.model`, form.model]);
  // Saving an entry must not silently switch the active service; the caller
  // asks for that explicitly.
  if (form.setActive !== false) pairs.push(["provider", name]);
  if (form.model && form.setActive !== false) pairs.push(["model", form.model]);
  if (form.effort) pairs.push(["effort", form.effort]);
  if (form.language) pairs.push(["language", form.language]);
  if (form.maxTokens) pairs.push(["max_tokens", form.maxTokens]);

  const steps = await ocr.setConfig(pairs);
  const failed = steps.find((s) => !s.ok);
  return failed
    ? { ok: false, error: `${failed.key}: ${ocr.withHint(failed.message)}`, steps }
    : { ok: true, steps, config: await configView() };
});

// Built-in provider entries cannot be removed (`config unset` rejects them), so
// clearing their key and model is the equivalent of un-configuring them.
ipcMain.handle("config:removeEntry", async (_e, req) => {
  const name = (req.name || "").trim();
  if (!name) return { ok: false, error: "未指定服务名" };
  const isCustom = Boolean((await configView()).customProviders[name]);
  if (isCustom) return ocr.unsetConfig(`custom_providers.${name}`);
  const steps = await ocr.setConfig([
    [`providers.${name}.api_key`, ""],
    [`providers.${name}.model`, ""],
  ]);
  const failed = steps.find((s) => !s.ok);
  return failed
    ? { ok: false, error: `${failed.key}: ${ocr.withHint(failed.message)}`, steps }
    : { ok: true, cleared: true, message: `已清空 ${name} 的 Key 与模型（内置服务无法删除，仅能解除配置）`, config: await configView() };
});

ipcMain.handle("config:use", async (_e, req) => {
  const pairs = [["provider", req.name]];
  if (req.model) pairs.push(["model", req.model]);
  const steps = await ocr.setConfig(pairs);
  const failed = steps.find((s) => !s.ok);
  return failed
    ? { ok: false, error: `${failed.key}: ${ocr.withHint(failed.message)}`, steps }
    : { ok: true, config: await configView() };
});

ipcMain.handle("config:unset", (_e, key) => ocr.unsetConfig(key));

// `ocr llm test` reads only the saved config, so "test what I just typed" runs
// the CLI against an empty temp HOME with OCR_LLM_* set: the config in the real
// HOME would otherwise win and the test would prove nothing about the form.
ipcMain.handle("config:test", async (_e, req) => {
  const form = req && req.form;
  if (form) {
    const missing = [
      ["url", "Base URL"],
      ["protocol", "协议"],
      ["model", "模型名"],
    ]
      .filter(([key]) => !String(form[key] || "").trim())
      .map(([, label]) => label);
    // A saved Key is only reused for the endpoint it belongs to. A built-in
    // service is usually configured with a Key and no URL — the CLI fills the
    // endpoint in from its own table — so "which host does this Key belong to"
    // has to consult that table (see `savedKeyLookupByName`); asking `savedKeyFor`
    // alone treated the empty URL as a wildcard.
    //
    // The lookup also answers *why* it withheld, and that is what the message is
    // worded from: a built-in service table that could not be read leaves the
    // form's Base URL empty too, so without the reason this branch said "还缺
    // Base URL" — pointing the user at their own typing when the fix was one
    // press of 刷新.
    const typed = String(form.apiKey || "").trim();
    const saved = typed ? { key: typed, reason: "" } : await ocr.savedKeyLookupByName(form.name, form.url);
    const apiKey = saved.key;
    if (missing.length || !apiKey) {
      return {
        ok: false,
        via: "form",
        output: ocr.savedKeyTestMessage({ missing, reason: saved.reason }),
      };
    }
    let home = "";
    try {
      home = fs.mkdtempSync(path.join(app.getPath("temp"), "ocr-llmtest-"));
      const res = await ocr.exec(
        ["llm", "test", "--color", "never"],
        undefined,
        ocr.llmTestEnv({ ...form, apiKey }, home)
      );
      return {
        ok: res.code === 0,
        via: "form",
        output: ocr.withHint(res.code === 0 ? (res.stdout + res.stderr).trim() : ocr.failureText(res)),
      };
    } catch (err) {
      return { ok: false, via: "form", output: `测试没有跑起来：${err.message}` };
    } finally {
      if (home) fs.rmSync(home, { recursive: true, force: true });
    }
  }
  const res = await ocr.exec(["llm", "test", "--color", "never"]);
  return {
    ok: res.code === 0,
    via: "saved",
    output: ocr.withHint(res.code === 0 ? (res.stdout + res.stderr).trim() : ocr.failureText(res)),
  };
});

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
