// Where the app itself lives, and what can be done to that copy of it.
//
// These three decisions used to be the bodies of `main.js`, where the only way
// to check them was to read the source text: which of the four shapes the
// running copy is in (installed / portable / not packaged / installed without an
// uninstaller), and what a "reveal" does when the path does not exist yet. Each
// one ends in a sentence the user reads, so each one is a behaviour — and a
// behaviour can only be checked by calling it. This file is importable without
// Electron: the app object, the shell and the platform are handed in.
"use strict";

const fs = require("fs");
const path = require("path");

/**
 * @param {object} deps
 * @param {{ isPackaged: boolean, getPath: (name: string) => string }} deps.app
 *   Electron's `app`, or a stub with the same two members.
 * @param {{ showItemInFolder: (p: string) => void, openPath: (p: string) => Promise<string> }} deps.shell
 *   Electron's `shell`, or a stub that records what it was asked to do.
 * @param {string} [deps.platform] `process.platform` by default.
 * @param {Record<string, string | undefined>} [deps.env] `process.env` by default.
 * @param {() => string} [deps.resourcesPath] `process.resourcesPath` by default.
 *   Read lazily: `installInfo()` is called long after this module loads.
 * @param {(p: string) => boolean} [deps.exists]
 * @param {(p: string) => string[]} [deps.readdir]
 */
function createInstall({
  app,
  shell,
  platform = process.platform,
  env = process.env,
  resourcesPath = () => process.resourcesPath,
  exists = fs.existsSync,
  readdir = fs.readdirSync,
}) {
  const isWindows = () => platform === "win32";

  // The `action` both ways of opening a directory answer with. One name, so the
  // plan's refusal and `openDir()`'s result cannot drift apart.
  const OPEN_DIR = "open-dir";
  // 「用系统默认程序打开」 answers with its own name, so a failure report says
  // which of the two buttons was pressed without the caller re-deriving it.
  const OPEN_FILE = "open-file";

  // NSIS writes `Uninstall <productName>.exe` into the install root; scanning for
  // it is more robust than re-deriving the name from productName. A directory
  // that is not there (a portable build reports no install dir at all) answers
  // the same way as one without an uninstaller: there is nothing to launch.
  function uninstallerPath(installDir) {
    if (!isWindows() || !installDir || !exists(installDir)) return "";
    try {
      const hit = readdir(installDir).find((f) => /^Uninstall.*\.exe$/i.test(f));
      return hit ? path.join(installDir, hit) : "";
    } catch (_) {
      return "";
    }
  }

  /* Where the app itself lives, as opposed to where its config lives. The
   * renderer shows these so "打开安装目录 / 卸载" never needs a user to guess a
   * path. `resourcesPath` is `<install>/resources`, so its parent is the root the
   * NSIS installer created. A portable build extracts to a temp dir each launch,
   * which is why it is reported separately instead of being called an install. */
  function installInfo() {
    const packaged = Boolean(app.isPackaged);
    const portable = Boolean(env.PORTABLE_EXECUTABLE_DIR);
    const installDir = packaged && !portable ? path.dirname(resourcesPath()) : "";
    return {
      packaged,
      portable,
      installDir,
      userData: app.getPath("userData"),
      executable: app.getPath("exe"),
      canUninstall: isWindows() && Boolean(uninstallerPath(installDir)),
    };
  }

  /* The two refusals below are the sentences the user gets instead of a button
   * that does nothing. They live here, next to the facts they are about, so the
   * portable case cannot be told "没有找到卸载程序" (it has no installer to find
   * one in) and an installed copy without an uninstaller cannot be told to
   * delete the exe. */

  // A refusal from here carries the same `action`/`path` pair that `openDir()`
  // answers with below. It used to be just `{ ok: false, error }`, so the one
  // failure the renderer can do nothing about (there is no directory to open)
  // arrived in a different shape from every other "open a directory" failure.
  function installDirPlan() {
    const dir = installInfo().installDir;
    if (!dir || !exists(dir)) {
      return { ok: false, error: "当前形态没有安装目录（免安装版运行时解压在临时目录）", action: OPEN_DIR, path: dir };
    }
    return { ok: true, dir };
  }

  function uninstallPlan() {
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
    return { ok: true, target, info };
  }

  // shell.showItemInFolder() does nothing at all when the path does not exist —
  // and the CLI config is absent until the first save, which is exactly when a
  // newcomer clicks this. Fall back to the nearest existing ancestor. The walk
  // stops when the parent repeats (the filesystem root), so a path nothing on
  // the volume exists for is reported instead of walked forever.
  //
  // The fallback opens the ancestor with shell.openPath(), which does *not*
  // reject when it cannot open it: it resolves to an error string, and an empty
  // string means it worked. So this function is async and returns that string as
  // `error` — reporting `ok: true` without reading it would tell a user their
  // file manager opened when nothing happened. shell.showItemInFolder() (the
  // exact-path case) returns nothing, so there is nothing to read there; and a
  // UNC target (`\\server\share`) ends the walk when the parent equals the path
  // itself, which has not been exercised on a real share.
  async function revealPath(target) {
    if (!target) return { ok: false, error: "没有可显示的路径" };
    let existing = target;
    while (existing && !exists(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) {
        existing = "";
        break;
      }
      existing = parent;
    }
    if (!existing) return { ok: false, error: `路径不存在：${target}` };
    if (existing === target) {
      shell.showItemInFolder(target);
      return { ok: true, action: "reveal", path: target };
    }
    const error = await shell.openPath(existing);
    if (error) return { ok: false, error, action: "open-parent", path: existing, missing: target };
    return { ok: true, action: "open-parent", path: existing, missing: target };
  }

  // 「打开安装目录」 was written inline in main.js and answered `{ ok: false,
  // error }` when `shell.openPath()` came back with an error string, while
  // `revealPath()` (the other "open a directory" path) answers with the action
  // and the path it tried. Two shapes for one failure means the renderer has to
  // know which button was pressed to read the answer. Same fields here, and the
  // error string is read rather than ignored, for the same reason as above.
  async function openDir(target) {
    if (!target) return { ok: false, error: "没有可打开的目录", action: OPEN_DIR, path: "" };
    const error = await shell.openPath(target);
    return error
      ? { ok: false, error, action: OPEN_DIR, path: target }
      : { ok: true, action: OPEN_DIR, path: target };
  }

  // The third caller of `shell.openPath()` — 「用系统默认程序打开」 on a reviewed
  // file — used to be a bare `() => shell.openPath(absPath)` in main.js, which
  // hands the renderer a string: `""` when it worked, an error sentence when it
  // did not. The renderer could only treat the truthy one as success, so a file
  // that opened nothing looked like a file that opened. Reading the return value
  // is the same contract `revealPath()` and `openDir()` above already implement,
  // which is why the third reader lives beside them instead of in main.js.
  //
  // The two module names are separate on purpose: `open-dir` and `open-file`
  // differ in `path` too (a directory vs. the file inside it), and a caller that
  // logs or reports the action should not have to guess which was pressed.
  //
  // It answers with a `reason` as well, because the two failures want different
  // advice and `shell.openPath()` gives both the same kind of sentence. A
  // reviewed file can be gone from the working tree (the finding names a path in
  // the ref that was reviewed, and the branch has moved on since); a file that
  // is still there can have no handler for its type. "Failed to open path" fits
  // both, so the *missing* one is decided here, before the shell is asked — the
  // renderer then says 「不在了」 with the path instead of repeating the shell.
  async function openFile(target) {
    if (!target) return { ok: false, error: "没有可打开的文件", reason: "no-file", action: OPEN_FILE, path: "" };
    if (!exists(target))
      return { ok: false, error: `文件不存在：${target}`, reason: "missing", action: OPEN_FILE, path: target };
    const error = await shell.openPath(target);
    return error
      ? { ok: false, error, reason: "open-failed", action: OPEN_FILE, path: target }
      : { ok: true, action: OPEN_FILE, path: target };
  }

  return { installInfo, uninstallerPath, installDirPlan, uninstallPlan, revealPath, openDir, openFile };
}

module.exports = { createInstall };
