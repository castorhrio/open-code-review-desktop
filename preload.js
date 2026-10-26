// SPDX-License-Identifier: Apache-2.0
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  info: () => ipcRenderer.invoke("app:info"),
  providers: () => ipcRenderer.invoke("app:providers"),
  openInstallDir: () => ipcRenderer.invoke("app:openInstallDir"),
  uninstall: () => ipcRenderer.invoke("app:uninstall"),

  pickRepo: () => ipcRenderer.invoke("repo:pick"),
  pickScanDir: (repo) => ipcRenderer.invoke("repo:pickInside", repo),
  pickFile: (opts) => ipcRenderer.invoke("repo:pickFile", opts),
  inspect: (repo) => ipcRenderer.invoke("repo:inspect", repo),
  resolveRef: (repo, ref) => ipcRenderer.invoke("repo:resolveRef", { repo, ref }),

  preview: (spec) => ipcRenderer.invoke("review:preview", spec),
  run: (spec) => ipcRenderer.invoke("review:run", spec),
  cancel: (id) => ipcRenderer.invoke("review:cancel", id),

  readFile: (req) => ipcRenderer.invoke("file:read", req),
  openFile: (absPath) => ipcRenderer.invoke("file:open", absPath),
  revealFile: (absPath) => ipcRenderer.invoke("file:reveal", absPath),
  saveText: (req) => ipcRenderer.invoke("file:saveText", req),
  openUrl: (url) => ipcRenderer.invoke("file:openUrl", url),

  readConfig: (opts) => ipcRenderer.invoke("config:read", opts),
  // The whole request object goes across, as the interface promises. This used
  // to take two positional arguments and rebuild the object here, so a caller
  // that passed the object the interface asks for had it read as *the name*:
  // the main process looked up a service called "[object Object]", found
  // nothing, and answered "no Key saved" for every service — the six reasons
  // the wording distinguishes never reached the screen.
  savedKey: (req) => ipcRenderer.invoke("config:savedKey", req),
  saveConfig: (form) => ipcRenderer.invoke("config:save", form),
  unsetConfig: (key) => ipcRenderer.invoke("config:unset", key),
  removeEntry: (name) => ipcRenderer.invoke("config:removeEntry", { name }),
  useProvider: (name, model) => ipcRenderer.invoke("config:use", { name, model }),
  testLlm: (form) => ipcRenderer.invoke("config:test", form ? { form } : undefined),

  listSessions: (repo, limit) => ipcRenderer.invoke("session:list", { repo, limit }),
  sessionComments: (repo, sessionId) => ipcRenderer.invoke("session:comments", { repo, sessionId }),
  sessionDiagnostics: (repo, sessionId) => ipcRenderer.invoke("session:diagnostics", { repo, sessionId }),
  // How full the truncation-evidence store is: its cap, the records in use and
  // how many repositories those records belong to. Settings asks once per visit
  // — the numbers move whenever a run finishes, so a value read at startup
  // would be stale exactly when the user looks at it.
  diagnosticsStats: () => ipcRenderer.invoke("diagnostics:stats"),
  exportSession: (repo, sessionId) => ipcRenderer.invoke("session:export", { repo, sessionId }),
  deleteSession: (repo, sessionId) => ipcRenderer.invoke("session:delete", { repo, sessionId }),

  rulesCheck: (repo, path, rule) => ipcRenderer.invoke("rules:check", { repo, path, rule }),

  updateState: () => ipcRenderer.invoke("update:state"),
  checkUpdate: () => ipcRenderer.invoke("update:check"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  ignoreUpdate: (version) => ipcRenderer.invoke("update:ignore", version),
  openReleases: () => ipcRenderer.invoke("update:openReleases"),
  setUpdateEnabled: (enabled) => ipcRenderer.invoke("update:setEnabled", enabled),
  onUpdateState: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on("update:state", handler);
    return () => ipcRenderer.removeListener("update:state", handler);
  },

  onLog: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on("run:log", handler);
    return () => ipcRenderer.removeListener("run:log", handler);
  },
  onExit: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on("run:exit", handler);
    return () => ipcRenderer.removeListener("run:exit", handler);
  },
  onProgress: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on("run:progress", handler);
    return () => ipcRenderer.removeListener("run:progress", handler);
  },
  onMenuOpenRepo: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("menu:open-repo", handler);
    return () => ipcRenderer.removeListener("menu:open-repo", handler);
  },
});
