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
const { app, BrowserWindow, dialog } = require("electron");

const ROOT = path.resolve(__dirname, "..");
const {
  pickFileOptions,
  PICK_INSIDE_MESSAGES,
} = require(path.join(ROOT, "path-guard.js"));
const reportPath = process.argv[2];
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: detail || "" });

/* ---- the OS pickers are answered here, not by a human ----
 * Both `repo:*` pickers exist to ask the operating system one question and
 * translate the answer. `audit:path` pins the translation as a pure function and
 * `audit:service` pins what the answer is made of, but nothing pinned the seam
 * between them and the screen: `pickScanDir` in `preload.js` hands the renderer
 * `{ relPath }` / `{ error }` / `{}`, and the review page has to read each one
 * differently — fill 扫描路径, say the refusal out loud, or say nothing.
 *
 * So the dialog itself is replaced for this run and the answers are queued. The
 * patch is an own property on the same `dialog` object `main.js` destructured,
 * so the registration calls the stub without knowing it. A real dialog here
 * would be a modal window nobody can click, which is why the checks below are
 * skipped rather than attempted if the patch did not take.
 */
const PICKER_STUB = "ocr-e2e-stub";
const pickerAnswers = [];
const pickerQuestions = [];
const realShowOpenDialog = dialog.showOpenDialog;
try {
  const stub = async (_win, options) => {
    pickerQuestions.push(options || {});
    return pickerAnswers.length ? pickerAnswers.shift() : { canceled: true, filePaths: [] };
  };
  stub[PICKER_STUB] = true;
  dialog.showOpenDialog = stub;
} catch {
  /* reported below as a failed check, not a crash */
}
const dialogIsStubbed = Boolean(dialog.showOpenDialog && dialog.showOpenDialog[PICKER_STUB]);
const restoreDialog = () => {
  if (dialogIsStubbed && realShowOpenDialog) dialog.showOpenDialog = realShowOpenDialog;
};

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
  // A bare remote, so the working branch has a *remote-tracking* upstream. This
  // is what a real clone looks like, and it is the shape that broke the default
  // range base: `@{upstream}` is `origin/feature`, which names the same branch as
  // `feature` but with a prefix, so a guard comparing them raw sees two
  // different refs. Without an upstream the case is unreachable and the
  // assertion below would pass against the bug.
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-e2e-remote-"));
  await git(remote, ["init", "--bare", "-q"]);

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
  await git(dir, ["remote", "add", "origin", remote]);
  await git(dir, ["push", "-q", "-u", "origin", "feature"]);
  // Uncommitted change so `workspace` has something to report.
  fs.appendFileSync(path.join(dir, "a.go"), "\n// trailing\n");
  return { dir, remote };
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
    const repoPath = repo.dir;

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
      `localStorage.setItem("last-repo", ${JSON.stringify(repoPath)}); localStorage.setItem("guide-dismissed", "1"); true`,
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

    // 4. 分支对比 against the *real* git-service and the *real* CLI.
    //
    // The default base is computed from `repo:inspect`, and it was computed wrong
    // in a way only a real repository shows: `@{upstream}` is the current
    // branch's own remote, so the guard against comparing a branch with itself
    // never fired and the scope came out as `main..main` — 0 files, exit 0. The
    // throwaway repo has no upstream configured, so the default here is `main`
    // from the ref list, and the preview must find the file the branch adds.
    await window.webContents.executeJavaScript(
      `(() => { const b = [...document.querySelectorAll("main button")].find((x) => (x.textContent || "").trim() === "分支对比"); if (b) b.click(); return Boolean(b); })()`,
      true
    );

    const range = await waitFor(
      window,
      `(() => {
         const t = document.querySelector("main").innerText;
         return /b\\.go/.test(t) ? t : null;
       })()`,
      { label: "the range-mode preview (b.go)", timeout: 60000 }
    ).catch(async () => window.webContents.executeJavaScript(`document.querySelector("main").innerText`, true).catch(() => ""));

    check(
      "分支对比 in a real repository previews the branch's own change",
      /b\.go/.test(range),
      /b\.go/.test(range) ? "" : `the branch-comparison scope produced no b.go — the default base is probably still the target itself. Screen said:\n${range.slice(0, 600)}`
    );
    const fields = await window.webContents.executeJavaScript(
      `(() => { const i = [...document.querySelectorAll("main input")]; return i.map((x) => x.value).filter(Boolean); })()`,
      true
    );
    check("the range scope names two different refs", new Set(fields).size >= 2, `the scope fields hold ${JSON.stringify(fields)}`);

    /* ---- 5. the sub-directory picker, end to end ----
     * `repo:pickInside` is the one handler whose entire body is "ask the dialog,
     * then translate the answer". The translation is pinned by `audit:path`; what
     * was never proven is that the registration calls it, that the payload's key
     * is the key `pickScanDir` returns, and that the renderer does the right
     * thing with each of the three answers. A refusal read as 留空 would widen a
     * scan to the whole repository, so "the field did not change" is the
     * assertion that matters, not merely "nothing crashed".
     */
    check(
      "the OS dialog is stubbed, so the picker steps ask nobody",
      dialogIsStubbed,
      dialogIsStubbed ? "" : "dialog.showOpenDialog could not be replaced, so the picker wiring is untested in this run"
    );
    if (dialogIsStubbed) {
      const scanField = `(() => { const i = document.querySelector('main input[placeholder^="src/main/java"]'); return i ? i.value : null; })()`;
      const clickPickDir = `(() => { const b = [...document.querySelectorAll("main button")].find((x) => (x.textContent || "").trim() === "选目录"); if (b) b.click(); return Boolean(b); })()`;

      // A scan target that exists, so the preview after the pick has something
      // real to look at: the assertion is about the picker, and a directory that
      // does not exist would fail for an unrelated reason.
      const pkgDir = path.join(repoPath, "pkg", "inner");
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, "c.go"), "package inner\n");

      const switched = await window.webContents.executeJavaScript(
        `(() => { const b = [...document.querySelectorAll("main button")].find((x) => (x.textContent || "").includes("全量扫描")); if (b) b.click(); return Boolean(b); })()`,
        true
      );
      const fieldAppeared = await waitFor(window, `Boolean(${scanField} !== null)`, { label: "扫描路径 to appear in scan mode" })
        .then(() => true)
        .catch(() => false);
      check("全量扫描 shows the 扫描路径 field the picker fills", switched && fieldAppeared, `clicked=${switched} field=${fieldAppeared}`);

      // (a) a directory inside the repo: the field takes the repo-relative path,
      //     spelled with forward slashes whatever the host separator is.
      const askedBefore = pickerQuestions.length;
      pickerAnswers.push({ canceled: false, filePaths: [pkgDir] });
      await window.webContents.executeJavaScript(clickPickDir, true);
      const filled = await waitFor(window, `(() => { const v = ${scanField}; return v === "pkg/inner" ? v : null; })()`, {
        label: "扫描路径 to read pkg/inner",
        timeout: 20000,
      }).catch(() => null);
      check(
        "repo:pickInside hands the renderer a repo-relative path",
        filled === "pkg/inner",
        filled === "pkg/inner"
          ? ""
          : `扫描路径 reads ${JSON.stringify(filled)} — the payload's relPath never reached pickScanDir`
      );
      const question = pickerQuestions.slice(askedBefore);
      check(
        "...and the dialog was asked for a directory, starting at the repo",
        question.length === 1 &&
          Array.isArray(question[0].properties) &&
          question[0].properties.includes("openDirectory") &&
          question[0].defaultPath === repoPath,
        JSON.stringify(question.map((q) => ({ properties: q.properties, defaultPath: q.defaultPath })))
      );

      // (b) cancelled: the empty payload. Nothing is written and nothing is said.
      pickerAnswers.push({ canceled: true, filePaths: [] });
      await window.webContents.executeJavaScript(clickPickDir, true);
      await sleep(1200);
      const afterCancel = await window.webContents.executeJavaScript(scanField, true);
      const saidOnCancel = await window.webContents.executeJavaScript(`document.body.innerText`, true);
      check(
        "a cancelled pick leaves 扫描路径 alone and says nothing",
        afterCancel === "pkg/inner" && !saidOnCancel.includes(PICK_INSIDE_MESSAGES.outside),
        `field=${JSON.stringify(afterCancel)} refusalShown=${saidOnCancel.includes(PICK_INSIDE_MESSAGES.outside)}`
      );

      // (c) a directory outside the repo: the guard's refusal, on screen, and the
      //     field untouched — the shape that must never read as 留空.
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-e2e-outside-"));
      pickerAnswers.push({ canceled: false, filePaths: [outsideDir] });
      await window.webContents.executeJavaScript(clickPickDir, true);
      const said = await waitFor(window, `(() => { const t = document.body.innerText; return t.includes(${JSON.stringify(PICK_INSIDE_MESSAGES.outside)}) ? t : null; })()`, {
        label: "the refusal for a pick outside the repo",
        timeout: 20000,
      }).catch(() => "");
      const afterOutside = await window.webContents.executeJavaScript(scanField, true);
      check(
        "a pick outside the repo is refused on screen, not silently dropped",
        said.includes(PICK_INSIDE_MESSAGES.outside),
        said.includes(PICK_INSIDE_MESSAGES.outside)
          ? ""
          : `the renderer showed no ${PICK_INSIDE_MESSAGES.outside} — pickScanDir's error was read by nobody`
      );
      check(
        "...and 扫描路径 is not widened to the whole repo by the refusal",
        afterOutside === "pkg/inner",
        afterOutside === "pkg/inner"
          ? ""
          : `扫描路径 reads ${JSON.stringify(afterOutside)}; an empty one would mean 整个仓库`
      );
      repo.extraDirs = [outsideDir];
    }

    /* ---- 6. the file picker's options, end to end ----
     * `repo:pickFile` answers a path and nothing else, so the only thing that can
     * be checked through the surface is what it *asked* — which is exactly the
     * decision that used to live inline in the registration. No options at all
     * must still be a picker in which a file can be selected.
     */
    check(
      "the OS dialog is stubbed for the file picker too",
      dialogIsStubbed,
      dialogIsStubbed ? "" : "dialog.showOpenDialog could not be replaced, so the file picker is untested in this run"
    );
    if (dialogIsStubbed) {
      const askedBefore = pickerQuestions.length;
      const answer = await window.webContents.executeJavaScript(`window.api.pickFile({})`, true);
      const question = pickerQuestions.slice(askedBefore);
      const expected = pickFileOptions({});
      check(
        "repo:pickFile with no options opens the all-files picker",
        answer === "" &&
          question.length === 1 &&
          question[0].title === expected.title &&
          question[0].buttonLabel === expected.buttonLabel &&
          JSON.stringify(question[0].filters) === JSON.stringify(expected.filters) &&
          Array.isArray(question[0].properties) &&
          question[0].properties.includes("openFile"),
        JSON.stringify({ answer, asked: question.map((q) => ({ title: q.title, filters: q.filters, properties: q.properties })) })
      );
    }
  } catch (err) {
    check("the end-to-end flow completed", false, String((err && err.message) || err));
  } finally {
    restoreDialog();
    if (repo) {
      for (const dir of [repo.dir, repo.remote, ...(repo.extraDirs || [])]) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* a leftover temp dir is not a failure */
        }
      }
    }
    finish();
  }
});
