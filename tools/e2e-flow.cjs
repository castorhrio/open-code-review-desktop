// End-to-end: the real renderer, the real preload, the real ipcMain handlers,
// the real ocr-service and the real CLI binary, in one process.
//
// Every other check stops short of this. `audit:service` drives ocr-service in
// plain Node, so it proves the arguments and the parsing but not that the
// renderer ever reaches them. `audit:ui` drives the renderer against a stub, so
// it proves the rendering but not that anything behind it exists. `audit:guards`
// loads the real bundle in real Electron but only exercises the navigation
// policy. The seam between the two halves — preload, ipcMain, the spec the
// renderer builds, the reply it can parse — was covered by nothing.
//
// This runs inside Electron (see tools/e2e-flow.mjs) and drives the renderer
// through `webContents.executeJavaScript`, so no Playwright and no stubbing are
// involved. It uses `--preview`, which costs no tokens and needs no API key.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { app, BrowserWindow } = require("electron");

const ROOT = path.resolve(__dirname, "..");
const reportPath = process.argv[2];
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: detail || "" });

const finish = () => {
  fs.writeFileSync(reportPath, JSON.stringify({ results }, null, 2));
  app.exit(0);
};

// Nothing may leave this process alive without a report: the runner reads the
// file, and "no file" is indistinguishable from a crash. A hang anywhere below
// becomes a failure that names itself.
setTimeout(() => {
  check("the end-to-end flow finished within the watchdog", false, "the harness hung and was stopped; whatever it was waiting for never arrived");
  finish();
}, 180000).unref?.();

/* ---- a throwaway repository, so the flow has something real to look at ---- */
const git = (cwd, args) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code !== 0 ? reject(new Error(`git ${args.join(" ")}: ${err || out}`)) : resolve(out.trim())));
  });

async function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-e2e-"));
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "t@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await git(dir, ["checkout", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(dir, "a.go"), "package main\n\nfunc main() {}\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", "initial"]);
  await git(dir, ["checkout", "-q", "-b", "feature"]);
  fs.writeFileSync(path.join(dir, "b.go"), "package main\n\nfunc helper() int { return 1 }\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", "add helper"]);
  fs.appendFileSync(path.join(dir, "a.go"), "\n// trailing\n");
  return dir;
}

// The renderer is a single page that reads `last-repo` from localStorage on
// mount, so the repository has to be in place before the app boots — hence the
// reload rather than a post-load poke.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A bounded `did-finish-load` wait.
 *
 * Unbounded is not an option: under an OS sandbox that blocks `file://` the
 * window never finishes loading and never errors either — Chromium just logs
 * "Network service crashed, restarting service" to stderr and waits forever. The
 * process then has to be killed, no report is written, and the runner cannot
 * tell that apart from a crash. Timing out here turns it into a legible failure
 * that the runner can retry with `--no-sandbox`.
 */
function whenLoaded(win, timeout = 20000) {
  return new Promise((resolve, reject) => {
    if (!win.webContents.isLoading()) return resolve();
    const timer = setTimeout(() => reject(new Error(`the window never finished loading within ${timeout}ms`)), timeout);
    win.webContents.once("did-finish-load", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitFor(win, expr, { timeout = 20000, label = expr } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await win.webContents.executeJavaScript(expr, true);
      if (last) return last;
    } catch (err) {
      last = `threw: ${err.message}`;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

app.whenReady().then(async () => {
  let repo = null;
  try {
    repo = await makeRepo();

    // main.js creates the window on its own whenReady; requiring it here means
    // this process *is* the app, with its real handlers registered.
    require(path.join(ROOT, "main.js"));
    let window = null;
    for (const deadline = Date.now() + 20000; Date.now() < deadline; ) {
      window = BrowserWindow.getAllWindows()[0] || null;
      if (window) break;
      await sleep(200);
    }
    if (!window) throw new Error("main.js created no window");

    await whenLoaded(window);

    // Seed the repository, then reload so the app boots against it.
    await window.webContents.executeJavaScript(
      `localStorage.setItem("last-repo", ${JSON.stringify(repo)}); localStorage.setItem("guide-dismissed", "1"); true`,
      true
    );
    window.webContents.reload();
    await whenLoaded(window);

    // 1. The renderer mounted and reached the main process for repository info.
    const header = await waitFor(window, `(() => { const m = document.querySelector("main"); return m && m.innerText.length > 20 ? m.innerText : null; })()`, {
      label: "the review page to render",
    });
    check("the real bundle mounts in Electron", header.length > 20, `${header.length} chars`);

    // The branch badge is fed by `repo:inspect` → git-service, so seeing it means
    // preload, ipcMain and the git layer all answered.
    const badge = await waitFor(window, `(() => document.body.innerText.includes("feature") ? true : null)()`, { label: "the branch badge" }).catch(() => null);
    check("repo:inspect reached the renderer", Boolean(badge), badge ? "" : "the branch name never appeared, so inspect did not answer");

    // 2. The file list is produced by `review:preview` → ocr-service → the CLI.
    //    The review page runs the preview on its own once the scope settles, so
    //    there is nothing to click: wait for the file the CLI must report. The
    //    default mode is 工作区改动, and the only uncommitted change in the
    //    throwaway repo is the appended line in a.go — b.go was committed on the
    //    branch and is not part of a working-tree diff.
    //
    //    The wait is best-effort on purpose. Throwing on timeout would land in
    //    the catch-all below and report "the flow completed: false", which says
    //    nothing about *which* link broke; reading whatever is on screen instead
    //    lets each assertion below name its own failure.
    const preview = await waitFor(
      window,
      `(() => {
         const t = document.querySelector("main").innerText;
         return /a\\.go/.test(t) ? t : null;
       })()`,
      { label: "the previewed file list (a.go)", timeout: 60000 }
    ).catch(async () => window.webContents.executeJavaScript(`document.querySelector("main").innerText`, true).catch(() => ""));

    const sawA = /a\.go/.test(preview);
    const sawB = /b\.go/.test(preview);
    const isEmpty = /没有文件进入审查/.test(preview);
    check("review:preview listed the changed file the CLI reported", sawA, sawA ? "" : `the file list never showed a.go — the spec the renderer built did not reach the CLI as the requested repository. Screen said:\n${preview.slice(0, 600)}`);
    check("the preview was not an empty-scope screen", !isEmpty, isEmpty ? "the preview came back empty, so the spec the renderer built did not reach the CLI intact" : "");
    // A file the CLI did not report must not appear: the list is the CLI's answer,
    // not something the renderer composed from the form.
    check("the list does not invent files", !sawB, sawB ? "b.go was listed, but it is committed on the branch and is not a working-tree change" : "");

    // 3. Nothing may have leaked a placeholder into real text along the way.
    const leaked = preview.match(/\bundefined\b|\bNaN\b|\[object Object\]/g);
    check("no placeholder text survived the round trip", !leaked, leaked ? leaked.join(", ") : "");
  } catch (err) {
    check("the end-to-end flow completed", false, String((err && err.message) || err));
  } finally {
    if (repo) {
      try {
        fs.rmSync(repo, { recursive: true, force: true });
      } catch {
        /* a leftover temp dir is not a failure */
      }
    }
    finish();
  }
});
