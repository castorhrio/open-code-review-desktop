// SPDX-License-Identifier: Apache-2.0
"use strict";

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, dialog, ipcMain, shell, Menu } = require("electron");

const ocr = require("./ocr-service");
const git = require("./git-service");
const updater = require("./update-service");

const DOCS_URL = "https://open-codereview.ai/docs";

let mainWindow = null;

const boundsFile = () => path.join(app.getPath("userData"), "window-bounds.json");

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

const parseProviderTable = (text) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[a-z0-9-]+\s{2,}/.test(l))
    .map((l) => {
      const cols = l.split(/\s{2,}/);
      return { name: cols[0], protocol: cols[1] || "", url: cols[2] || "" };
    })
    .filter((p) => p.name && p.name !== "NAME" && !/^-+$/.test(p.name));

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

function buildMenu() {
  const template = [
    {
      label: "文件",
      submenu: [
        {
          label: "打开仓库…",
          accelerator: "CmdOrCtrl+O",
          click: () => send("menu:open-repo"),
        },
        { type: "separator" },
        { role: "quit" },
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
  };
});

ipcMain.handle("app:providers", async () => {
  const res = await ocr.exec(["llm", "providers", "--color", "never"]);
  if (res.code !== 0) return { ok: false, error: ocr.withHint(ocr.failureText(res)), value: [] };
  return { ok: true, value: parseProviderTable(res.stdout) };
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
    (id, result) => send("run:exit", { id, result })
  );
});

ipcMain.handle("review:cancel", (_e, id) => ocr.cancelRun(id));

/* ---------------- ipc: files ---------------- */

ipcMain.handle("file:read", async (_e, req) => {
  if (req.ref && req.ref !== "HEAD") {
    const at = await git.readFileAtRef(req.repo, req.path, req.ref, req.startLine, req.endLine, req.pad || 12);
    if (at.ok) return at;
  }
  return git.readFileWindow(req.repo, req.path, req.startLine, req.endLine, req.pad || 12);
});

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

ipcMain.handle("config:read", () => ocr.readConfigView());

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
    : { ok: true, steps, config: ocr.readConfigView() };
});

// Built-in provider entries cannot be removed (`config unset` rejects them), so
// clearing their key and model is the equivalent of un-configuring them.
ipcMain.handle("config:removeEntry", async (_e, req) => {
  const name = (req.name || "").trim();
  if (!name) return { ok: false, error: "未指定服务名" };
  const isCustom = Boolean(ocr.readConfigView().customProviders[name]);
  if (isCustom) return ocr.unsetConfig(`custom_providers.${name}`);
  const steps = await ocr.setConfig([
    [`providers.${name}.api_key`, ""],
    [`providers.${name}.model`, ""],
  ]);
  const failed = steps.find((s) => !s.ok);
  return failed
    ? { ok: false, error: `${failed.key}: ${ocr.withHint(failed.message)}`, steps }
    : { ok: true, cleared: true, message: `已清空 ${name} 的 Key 与模型（内置服务无法删除，仅能解除配置）`, config: ocr.readConfigView() };
});

ipcMain.handle("config:use", async (_e, req) => {
  const pairs = [["provider", req.name]];
  if (req.model) pairs.push(["model", req.model]);
  const steps = await ocr.setConfig(pairs);
  const failed = steps.find((s) => !s.ok);
  return failed
    ? { ok: false, error: `${failed.key}: ${ocr.withHint(failed.message)}`, steps }
    : { ok: true, config: ocr.readConfigView() };
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
    const apiKey = String(form.apiKey || "").trim() || ocr.savedKeyFor(form.name, form.url);
    if (missing.length || !apiKey) {
      const parts = missing.length ? `还缺 ${missing.join("、")}` : "该服务还没有已保存的 Key，请把 Key 填进来";
      return {
        ok: false,
        via: "form",
        output: `${parts}，无法按当前填写的值测试。补齐后再点，或先保存再测已保存的配置。`,
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

ipcMain.handle("session:delete", (_e, req) => ocr.deleteSession(req.sessionId, req.repo));

ipcMain.handle("rules:check", (_e, req) => ocr.rulesCheck(req.repo, req.path, req.rule));

/* ---------------- lifecycle ---------------- */

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
