// SPDX-License-Identifier: Apache-2.0
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  info: () => ipcRenderer.invoke("app:info"),
  providers: () => ipcRenderer.invoke("app:providers"),

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

  readConfig: () => ipcRenderer.invoke("config:read"),
  saveConfig: (form) => ipcRenderer.invoke("config:save", form),
  unsetConfig: (key) => ipcRenderer.invoke("config:unset", key),
  testLlm: () => ipcRenderer.invoke("config:test"),

  listSessions: (repo, limit) => ipcRenderer.invoke("session:list", { repo, limit }),
  sessionComments: (repo, sessionId) => ipcRenderer.invoke("session:comments", { repo, sessionId }),
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
  onMenuOpenRepo: (cb) => {
    const handler = () => cb();
    ipcRenderer.on("menu:open-repo", handler);
    return () => ipcRenderer.removeListener("menu:open-repo", handler);
  },
});
