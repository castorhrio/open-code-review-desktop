// End-to-end: the chain a *new installation* walks, in the real app.
//
// `tools/e2e-flow.cjs` starts from a configured application: it seeds
// `last-repo`, hides the guide with `guide-dismissed`, and waits for the preview
// the review page computes by itself. That covers the scope engine end to end and
// nothing before it. The part someone at a demo actually does — open the installed
// app, see the guide, pick a repository, configure a model service, press the one
// button that spends money — had never been walked by a script. It is the reason
// DOD-4 is still open in `docs/PRODUCT-DOD.md`.
//
// Three things this harness insists on, none of which the flow can fake:
//
// **It really is a first run.** The profile is a throwaway: `HOME` (and the three
// Windows equivalents), the Electron `userData`, and therefore the renderer's
// `localStorage`, all point into a temp directory created before `main.js` loads.
// The alternative — deleting the developer's `~/.opencodereview` — would destroy
// the one thing this program promises not to duplicate, and would mean the fake
// API Key written below lands in a real config file if the redirect ever failed.
// So the redirect is *checked* before the app boots, and the user's own config
// file is compared byte-for-byte at the end.
//
// **The provider is fake and stays local.** The entry's endpoint is
// `http://127.0.0.1:9/v1` — port 9, the discard service: nothing listens there, so
// the CLI's own connectivity test fails locally in seconds and no packet carrying
// this Key leaves the machine. No real API is called and no token is spent.
//
// **The refusals are judged by what left the process.** The run gate's promise is
// "nothing went toward a model until a model was configured", and the only honest
// evidence for that is this process's spawn log, taken by wrapping
// `child_process.spawn` before `main.js` pulls in the services that call it.
// `review` and `scan` are the two commands that reach a provider, and `--preview`
// next to either means git and the rule tables only. `tools/e2e-first-run-steps.cjs`
// owns that classification, and its smoke test pins it.
//
// This runs inside Electron (see `tools/e2e-first-run.mjs`) and drives the renderer
// through `webContents.executeJavaScript`, so no Playwright and no stubbing of the
// app's own code are involved.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const { app, BrowserWindow, dialog } = require("electron");

const ROOT = path.resolve(__dirname, "..");
const { timeoutError, screenAfter, neverAppeared } = require(path.join(ROOT, "tools", "e2e-screen.cjs"));
const {
  FIRST_RUN_STEP_NAMES,
  firstRunCheck,
  runSpawnVerdict,
  RUN_COMMANDS,
  cliCommands,
  profileIsolationViolations,
  spawnHomeViolations,
  exclusionHeaderVerdict,
  exclusionRowVerdict,
} = require(path.join(ROOT, "tools", "e2e-first-run-steps.cjs"));

const reportPath = process.argv[2];
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: detail || "" });

// How far the flow actually got. Each declared step names the landmarks it needs,
// so a step that could not run is reported red with the reason rather than missing
// from a report that counts failures.
const landmarks = new Set();
const reported = new Set();

const stepCheck = async (name, body) => {
  let declared = null;
  try {
    declared = firstRunCheck(landmarks, name);
  } catch (err) {
    return check(name, false, `this step is not declared in tools/e2e-first-run-steps.cjs: ${(err && err.message) || err}`);
  }
  reported.add(name);
  if (!declared.ok) return check(declared.name, false, declared.detail);
  let verdict = null;
  try {
    verdict = await body();
  } catch (err) {
    return check(name, false, `the step threw: ${(err && err.message) || err}`);
  }
  check(name, verdict.ok, verdict.detail);
  return verdict;
};

/* ---- the throwaway profile, installed before anything can read the real one ---- */
const realHome = process.env.HOME || process.env.USERPROFILE || os.homedir();
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-e2e-home-"));
const cleanupDirs = [tempHome];

process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.APPDATA = path.join(tempHome, "AppData", "Roaming");
process.env.LOCALAPPDATA = path.join(tempHome, "AppData", "Local");
process.env.OneDrive = tempHome;

const tempUserData = path.join(tempHome, "userData");
fs.mkdirSync(tempUserData, { recursive: true });
let userDataPath = "";
try {
  app.setPath("userData", tempUserData);
  userDataPath = app.getPath("userData");
} catch (err) {
  // Anything but the real path is fine; an exception here means the profile was
  // not redirected at all, and the isolation check below says so.
  userDataPath = `unavailable: ${err.message}`;
}

// The user's own CLI config, as it is right now. The last check compares it: a
// harness that changed it broke a promise, not a test.
const realConfigPath = path.join(realHome, ".opencodereview", "config.json");
const digestOf = (file) => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "absent";
  }
};
const realConfigBefore = digestOf(realConfigPath);

/* ---- every child process the app starts is written down ---- */
const spawnLog = [];
const realSpawn = cp.spawn;
cp.spawn = function (bin, args, options) {
  const child = realSpawn.apply(this, arguments);
  spawnLog.push({
    bin: String(bin),
    args: (args || []).map(String),
    env: (options && options.env) || process.env,
    child,
  });
  return child;
};

// `ocr-service.js` resolves the CLI and computes `CONFIG_PATH` when it loads, so
// requiring it here — after the env was redirected, before the app is required —
// answers where the writes below would actually land.
const ocrService = require(path.join(ROOT, "ocr-service.js"));
const isolationViolations = profileIsolationViolations({
  env: process.env,
  configPath: ocrService.CONFIG_PATH,
  userData: userDataPath,
  tempHome,
  realHome,
});

/* ---- the OS folder dialog is answered here, not by a human ----
 * The same arrangement as `tools/e2e-flow.cjs`: the patch goes on the `dialog`
 * object `main.js` imported, and when it cannot be installed the steps that would
 * press it are reported red and named rather than skipped.
 */
const PICKER_STUB = "ocr-e2e-first-run-stub";
const dialogAnswers = [];
const dialogQuestions = [];
const realShowOpenDialog = dialog.showOpenDialog;
try {
  const stub = async (_win, options) => {
    dialogQuestions.push(options || {});
    return dialogAnswers.length ? dialogAnswers.shift() : { canceled: true, filePaths: [] };
  };
  stub[PICKER_STUB] = true;
  dialog.showOpenDialog = stub;
} catch {
  /* reported as a failed check, not a crash */
}
const dialogIsStubbed = Boolean(dialog.showOpenDialog && dialog.showOpenDialog[PICKER_STUB]);
const restoreDialog = () => {
  if (dialogIsStubbed && realShowOpenDialog) dialog.showOpenDialog = realShowOpenDialog;
};

const finish = () => {
  // A run stopped through the app's own 取消 is already dead; a harness that dies
  // mid-step must not leave an `ocr scan` writing into the profile afterwards.
  for (const record of spawnLog) {
    try {
      if (record.child && record.child.exitCode === null && !record.child.killed) record.child.kill();
    } catch {
      /* already gone */
    }
  }
  try {
    fs.writeFileSync(reportPath, JSON.stringify({ results }, null, 2));
  } catch (err) {
    console.error(`the first-run report could not be written: ${err.message}`);
  }
  for (const dir of cleanupDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a leftover temp dir is not a failure */
    }
  }
  app.exit(0);
};

// Two connectivity tests of ~15 s each, four real CLI previews and one scan run
// fit inside this; a hang does not.
setTimeout(() => {
  check(
    "the first-run flow finished within the watchdog",
    false,
    "the harness hung and was stopped; whatever it was waiting for never arrived"
  );
  finish();
}, 300000).unref?.();

/* ---- a throwaway repository with something for every mode to say ---- */
const git = (cwd, args) =>
  new Promise((resolve, reject) => {
    // `realSpawn`, not the wrapped one: the fixture's own git calls are not
    // evidence about what the app did.
    const child = realSpawn("git", args, { cwd, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code !== 0 ? reject(new Error(`git ${args.join(" ")}: ${err || out}`)) : resolve(out.trim())));
  });

// The fixture is written so each assertion below has exactly one reason to be red,
// and the numbers are not incidental:
//
//  - `a.go` is the only *reviewable* working-tree change, so the workspace list has
//    one row. `b.go` is committed on the branch and is not a working change.
//  - `go.mod` and `testdata/sample.json` are changed too, and the pinned CLI
//    (v1.13.4) refuses them: `unsupported_ext` and `default_path`. That is the
//    exclusion block — two rows, two different reasons — with nothing guessed at.
//  - 35 committed `.go` files, so 全量扫描 reports well over `SCAN_CONFIRM_AT` (20)
//    reviewable files and the cost confirmation is unavoidable. Under that
//    threshold the guard never fires and the last three checks would be vacuous.
async function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-e2e-first-"));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-e2e-first-remote-"));
  cleanupDirs.push(dir, remote);
  await git(remote, ["init", "--bare", "-q"]);

  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "t@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  await git(dir, ["checkout", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/e2e\ngo 1.21\n");
  fs.writeFileSync(path.join(dir, "a.go"), "package main\n\nfunc main() {}\n");
  fs.writeFileSync(path.join(dir, "a_test.go"), "package main\n\nfunc TestNothing() {}\n");
  fs.mkdirSync(path.join(dir, "internal", "auth"), { recursive: true });
  fs.mkdirSync(path.join(dir, "pkg", "generated"), { recursive: true });
  fs.mkdirSync(path.join(dir, "testdata"), { recursive: true });
  for (let i = 1; i <= 24; i += 1) fs.writeFileSync(path.join(dir, `f${i}.go`), `package p\n\nfunc F${i}() int { return ${i} }\n`);
  for (let i = 1; i <= 8; i += 1)
    fs.writeFileSync(path.join(dir, "internal", "auth", `g${i}.go`), `package auth\n\nfunc G${i}() {}\n`);
  fs.writeFileSync(path.join(dir, "pkg", "generated", "gen.go"), "package generated\n\nfunc Gen() {}\n");
  fs.writeFileSync(path.join(dir, "testdata", "sample.json"), '{"sample":1}\n');
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", "initial"]);
  await git(dir, ["checkout", "-q", "-b", "feature"]);
  fs.writeFileSync(path.join(dir, "b.go"), "package main\n\nfunc helper() int { return 1 }\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", "add helper"]);
  await git(dir, ["remote", "add", "origin", remote]);
  await git(dir, ["push", "-q", "-u", "origin", "feature"]);
  // Working-tree changes on the checked-out branch (`feature`, with a real
  // remote-tracking upstream — the shape a clone has and the shape that once made
  // the default range base compare a branch with itself). One reviewable, two the
  // rules refuse.
  fs.appendFileSync(path.join(dir, "a.go"), "\n// trailing\n");
  fs.writeFileSync(path.join(dir, "go.mod"), "module example.com/e2e\ngo 1.22\n");
  fs.writeFileSync(path.join(dir, "testdata", "sample.json"), '{"sample":2}\n');
  return { dir, remote };
}

// The provider this flow configures. Nothing here is a real credential and the
// endpoint is the local discard port, so every request the app makes to it dies in
// the machine.
const FAKE = {
  name: "e2e-fake",
  url: "http://127.0.0.1:9/v1",
  model: "fake-model",
  key: "sk-fake-e2e-not-a-real-key",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A bounded `did-finish-load` wait — same reason as in `e2e-flow.cjs`: under an OS
 * sandbox that blocks `file://` the window never finishes loading and never errors
 * either, and only a timeout turns that into a sentence the runner can act on.
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
  throw timeoutError(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

const MAIN_TEXT = `document.querySelector("main") ? document.querySelector("main").innerText : ""`;
const BODY_TEXT = `document.body.innerText`;

const screenAfterWindow = (win, waiting, options) =>
  screenAfter(waiting, () => evalJs(win, MAIN_TEXT).catch(() => ""), options);

/* ---- the four things a person does with a mouse ----
 * `press` dispatches the whole pointer sequence, not just a click: the mode switch
 * and the run button are ordinary `<button>`s that answer to `click`, but the
 * provider picker is a Radix trigger that opens on `pointerdown` and whose items
 * answer on `pointerup`. One helper for both, so the flow cannot pass a control by
 * accident of it being simple.
 *
 * `typeInto` goes through the window's own value setter and then fires `input`:
 * assigning `el.value` alone leaves React's controlled field showing the new text
 * while its state still holds the old one — a form that looks filled and saves
 * empty, which is the failure this harness would then be unable to see.
 */
const evalJs = (win, expr) => win.webContents.executeJavaScript(expr, true);

const press = (win, elementExpr) =>
  evalJs(
    win,
    `(() => {
       const el = (${elementExpr});
       if (!el) return false;
       el.scrollIntoView({ block: "center", inline: "nearest" });
       const r = el.getBoundingClientRect();
       const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
       el.dispatchEvent(new PointerEvent("pointerdown", { ...init, pointerId: 1, isPrimary: true }));
       el.dispatchEvent(new PointerEvent("pointerup", { ...init, pointerId: 1, isPrimary: true, buttons: 0 }));
       el.dispatchEvent(new MouseEvent("click", init));
       return true;
     })()`
  );

const typeInto = (win, selector, value) =>
  evalJs(
    win,
    `(() => {
       const el = document.querySelector(${JSON.stringify(selector)});
       if (!el) return null;
       const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
       setter.call(el, ${JSON.stringify(value)});
       el.dispatchEvent(new Event("input", { bubbles: true }));
       return el.value;
     })()`
  );

const hasOnScreen = (win, text, where = BODY_TEXT) => evalJs(win, `(${where}).includes(${JSON.stringify(text)})`);
const mainButton = (text) => `[...document.querySelectorAll("main button")].find((x) => (x.textContent || "").trim() === ${JSON.stringify(text)})`;
const pressButton = (win, text) => press(win, mainButton(text));
// The rail's buttons hold an icon and carry their word as `aria-label`, so a text
// match would never find them — and they live outside `main`.
const pressNav = (win, label) => press(win, `document.querySelector('button[aria-label=${JSON.stringify(label)}]')`);
// A Radix Dialog renders through a Portal into `document.body`, so its buttons are
// **not** inside `main`. Looking for them with a `main button` search finds nothing
// and the guard under test then reads as "the dialog never appeared" when the only
// thing that failed was the reach.
const dialogButton = (text) => `[...document.querySelectorAll('[role="dialog"] button')].find((b) => (b.textContent || "").trim() === ${JSON.stringify(text)})`;
const pressDialogButton = (win, text) => press(win, dialogButton(text));

const RUN_LABELS = ["开始审查", "审查运行中…", "续跑未完成部分"];
const runButtonState = (win) =>
  evalJs(
    win,
    `(() => {
       const wanted = ${JSON.stringify(RUN_LABELS)};
       const b = [...document.querySelectorAll("main button")].find((x) => wanted.includes((x.textContent || "").trim()));
       return b ? { found: true, label: b.textContent.trim(), disabled: b.disabled } : { found: false, label: null, disabled: null };
     })()`
  );

/**
 * The reason cell of one excluded file.
 *
 * Excluded rows are read by the path's own `title` attribute, so "the row is
 * missing", "the row prints the CLI's raw key" and "the row printed undefined"
 * stay three different sentences instead of one "the screen looked wrong".
 */
const exclusionRowReason = (win, filePath) =>
  evalJs(
    win,
    `(() => {
       const span = [...document.querySelectorAll("main span[title]")].find((x) => x.getAttribute("title") === ${JSON.stringify(filePath)});
       if (!span) return null;
       const cells = [...span.parentElement.children];
       const last = cells[cells.length - 1];
       return last ? last.textContent : null;
     })()`
  );

app.whenReady().then(async () => {
  try {
    // Step 0 is not a step, it is a precondition: with the redirect unproven the
    // fake Key could land in the developer's real config, so the app is not booted
    // at all — and every declared step is still reported, red, naming the landmark
    // it never reached.
    if (isolationViolations.length) {
      check("the harness booted against a throwaway profile, not the user's", false, isolationViolations.join("; "));
      reported.add("the harness booted against a throwaway profile, not the user's");
      return finish();
    }

    const repo = await makeRepo();
    landmarks.add("boot");

    require(path.join(ROOT, "main.js"));
    let window = null;
    for (const deadline = Date.now() + 20000; Date.now() < deadline; ) {
      window = BrowserWindow.getAllWindows()[0] || null;
      if (window) break;
      await sleep(200);
    }
    if (!window) throw new Error("main.js created no window");
    await whenLoaded(window);

    // Which children asked the CLI for a file list. Built from the module's own
    // narrowing, so "is this a CLI child" is answered in exactly one place.
    const previewSpawns = () =>
      cliCommands(spawnLog).filter((r) => RUN_COMMANDS.includes(r.args[0]) && r.args.includes("--preview"));

    await stepCheck("the harness booted against a throwaway profile, not the user's", async () => ({
      ok: true,
      detail: `HOME=${tempHome}; CLI config at ${ocrService.CONFIG_PATH}; Electron profile at ${userDataPath}`,
    }));

    await stepCheck("the first screen is a first run: no remembered repository, guide not dismissed", async () => {
      const remembered = await evalJs(window, `localStorage.getItem("last-repo")`);
      const dismissed = await evalJs(window, `localStorage.getItem("guide-dismissed")`);
      const bothEmpty = remembered === null && dismissed === null;
      return {
        ok: bothEmpty,
        detail: bothEmpty ? "" : `the fresh profile already holds last-repo=${JSON.stringify(remembered)} guide-dismissed=${JSON.stringify(dismissed)}, so this is not the first screen an installed app shows`,
      };
    });

    const GUIDE_TITLES = ["选择要审查的仓库目录", "配置模型服务与 API Key", "点「开始审查」，结果在「结果」页"];
    await stepCheck("the guide card offers its three steps and both actions that are still open", async () => {
      const missingTitles = [];
      for (const title of GUIDE_TITLES) if (!(await hasOnScreen(window, title, MAIN_TEXT))) missingTitles.push(title);
      const hasCard = await hasOnScreen(window, "三步开始第一次审查", MAIN_TEXT);
      const missingActions = [];
      for (const action of ["选择仓库", "去设置"]) if (!(await evalJs(window, `Boolean(${mainButton(action)})`))) missingActions.push(action);
      const missing = [];
      if (!hasCard) missing.push("the card itself (三步开始第一次审查)");
      if (missingTitles.length) missing.push(`step titles: ${missingTitles.join(" / ")}`);
      if (missingActions.length) missing.push(`open actions: ${missingActions.join(" / ")}`);
      return {
        ok: missing.length === 0,
        detail: missing.length
          ? `${missing.join("; ")} — the two action buttons only render for a step that is still open, so their absence means the card did not appear or was already satisfied`
          : "",
      };
    });

    await stepCheck("开始审查 is refused before a repository is chosen, and says what it wants", async () => {
      const state = await runButtonState(window);
      const says = await hasOnScreen(window, "先在顶部的仓库栏里选一个 git 仓库目录。", MAIN_TEXT);
      return {
        ok: state.found && state.disabled === true && says,
        detail: !state.found
          ? "no 开始审查 button on the review page"
          : state.disabled === false
            ? "it is enabled with no repository at all"
            : !says
              ? "it is disabled, but nothing on the page says why"
              : "",
      };
    });

    await stepCheck("「选择仓库」 asks the OS dialog once and takes its answer", async () => {
      if (!dialogIsStubbed) return { ok: false, detail: "dialog.showOpenDialog is not replaceable here, so the folder dialog would be a modal window nobody can click" };
      landmarks.add("dialog");
      const askedBefore = dialogQuestions.length;
      dialogAnswers.push({ canceled: false, filePaths: [repo.dir] });
      const clicked = await pressButton(window, "选择仓库");
      const badge = await waitFor(window, `(${BODY_TEXT}).includes("feature") ? true : null`, {
        label: "the branch badge, which only repo:inspect can draw",
        timeout: 30000,
      })
        .then(() => true)
        .catch(() => null);
      const question = dialogQuestions.slice(askedBefore);
      const askedOnce = question.length === 1 && Array.isArray(question[0].properties) && question[0].properties.includes("openDirectory");
      if (badge === true) landmarks.add("repo-picked");
      return {
        ok: clicked && badge === true && askedOnce,
        detail: !clicked
          ? "the guide's 选择仓库 button was not there to press"
          : !askedOnce
            ? `the dialog was asked ${question.length} time(s): ${JSON.stringify(question.map((q) => q.properties))}`
            : badge !== true
              ? "the answer never reached the page: no branch badge, so repo:inspect did not answer"
              : "",
      };
    });

    await stepCheck("the file list computes itself after the pick, through a real --preview", async () => {
      const timeoutMs = 60000;
      const screen = await screenAfterWindow(
        window,
        waitFor(window, `(${MAIN_TEXT}).includes("a.go") ? ${MAIN_TEXT} : null`, { label: "the workspace file list (a.go)", timeout: timeoutMs }),
        { timeoutMs }
      );
      if (screen.timedOut) {
        return { ok: false, detail: `${neverAppeared("the previewed list", timeoutMs)}. Screen said:\n${String(screen.screen).slice(0, 600)}` };
      }
      const asked = previewSpawns().some((r) => r.args.includes("--repo") && r.args[r.args.indexOf("--repo") + 1] === repo.dir);
      const invented = /(^|\n)[^.\n]*b\.go/.test(screen.screen);
      const countLine = /(\d+)\s*个文件进入审查/.exec(screen.screen);
      return {
        ok: asked && !invented && Boolean(countLine) && countLine[1] === "1",
        detail: !asked
          ? "no review --preview was spawned against the fixture repository, so the list on screen did not come from the CLI"
          : invented
            ? "b.go is listed, but it is committed on the branch and is not a working-tree change"
            : !countLine
              ? "the summary line never said how many files enter the review"
              : countLine[1] === "1"
                ? ""
                : `the summary says ${countLine[1]} files enter the review; a.go is the only reviewable working change in the fixture`,
      };
    });

    await stepCheck("the files the CLI refused are listed as refused, each with a translated reason", async () => {
      const drop = [
        { path: "go.mod", reason: "unsupported_ext" },
        { path: "testdata/sample.json", reason: "default_path" },
      ];
      const screen = await evalJs(window, MAIN_TEXT);
      const header = exclusionHeaderVerdict({ screen, dropCount: drop.length });
      if (!header.ok) return header;
      const rows = [];
      for (const file of drop) {
        const reason = await exclusionRowReason(window, file.path).catch(() => null);
        rows.push(exclusionRowVerdict({ path: file.path, rawReason: file.reason, rowText: reason }));
      }
      const failed = rows.filter((row) => !row.ok);
      return { ok: failed.length === 0, detail: failed.length ? failed.map((row) => row.detail).join("; ") : rows.map((row) => row.detail).join("; ") };
    });

    // The gap the run gate blocks on, read off the gate itself rather than
    // hardcoded: it is the config view's own `blockedReason`, and the settings
    // badge is the same value, so this is the assertion that the two halves of the
    // product say the same thing about one config file.
    const gateGap = await waitFor(window, `(() => { const m = /模型服务还没就绪：(.+?)。/.exec(${MAIN_TEXT}); return m ? m[1] : null; })()`, {
      label: "the run gate's own sentence about the missing model service",
      timeout: 20000,
    }).catch(() => "");

    await stepCheck("the settings page names the same gap the run gate names", async () => {
      if (!gateGap) return { ok: false, detail: "the review page never said which model-service gap it was blocking the run on" };
      const went = await pressButton(window, "去设置");
      const badge = await waitFor(window, `(${MAIN_TEXT}).includes(${JSON.stringify(gateGap)}) ? true : null`, {
        label: `the settings badge naming ${JSON.stringify(gateGap)}`,
        timeout: 20000,
      })
        .then(() => true)
        .catch(() => null);
      return {
        ok: Boolean(went) && badge === true,
        detail: !went
          ? "the guide's 去设置 action was not there to press"
          : badge !== true
            ? `the 模型服务 badge does not say ${JSON.stringify(gateGap)}; the review page and the settings page would tell a reader different things about the same config`
            : "",
      };
    });

    /* ---- the provider form, filled the way a person fills it ---- */
    // Radix's select trigger carries `role="combobox"` and *no* `aria-haspopup`,
    // so the picker is found by the role it really has. The 模型服务 group is
    // named because the page has three comboboxes and only one of them is the
    // service picker.
    const providerPickerTrigger = `(() => { const g = [...document.querySelectorAll("main [role=group]")].find((x) => (x.textContent || "").startsWith("模型服务")); return g && g.querySelector('button[role="combobox"]'); })()`;
    const customProviderOption = `[...document.querySelectorAll('[role="option"]')].find((x) => (x.textContent || "").includes("新建自定义服务"))`;

    const openCustomProviderForm = async () => {
      const opened = await press(window, providerPickerTrigger);
      // Radix animates the content in, so the options are not in the document on
      // the same tick the trigger was pressed; `waitFor` polls and then the option
      // is pressed once it exists.
      const optionPressed = opened
        ? await waitFor(window, `Boolean(${customProviderOption})`, { label: "the provider picker's option list", timeout: 10000 })
            .then(() => sleep(150).then(() => press(window, customProviderOption)))
            .catch(() => false)
        : false;
      const fieldsAppeared = await waitFor(window, `Boolean(document.querySelector('main input[placeholder="my-gateway"]'))`, {
        label: "the 自定义服务名 field",
        timeout: 10000,
      })
        .then(() => true)
        .catch(() => false);
      if (opened && optionPressed && fieldsAppeared) return { opened, optionPressed, fieldsAppeared };
      // What the page actually drew, so this red line is a lead rather than a
      // dead end: the field labels the form is found by, and the triggers that
      // could be the service picker.
      const probe = await evalJs(
        window,
        `(() => {
           const groups = [...document.querySelectorAll("main [role=group]")].map((g) => (g.textContent || "").trim().slice(0, 22));
           const triggers = [...document.querySelectorAll("main button")].map((b) => (b.textContent || "").trim().slice(0, 14) + "#" + (b.getAttribute("aria-haspopup") || b.getAttribute("role") || "")).filter((x) => /#(listbox|combobox)$/.test(x));
           return { groups: groups.slice(0, 12), triggers: triggers.slice(0, 6) };
         })()`
      ).catch(() => null);
      return { opened, optionPressed, fieldsAppeared, probe };
    };

    await stepCheck("saving an entry with no Key does not unlock 开始审查", async () => {
      const form = await openCustomProviderForm();
      if (!(form.opened && form.optionPressed && form.fieldsAppeared)) {
        return {
          ok: false,
          detail: `the custom-provider form did not open (trigger=${form.opened}, option=${form.optionPressed}, fields=${form.fieldsAppeared}) — the service picker is a Radix trigger, so this is the control that a plain click cannot operate. Page said: ${JSON.stringify(form.probe)}`,
        };
      }
      landmarks.add("settings-form");
      const typedName = await typeInto(window, 'main input[placeholder="my-gateway"]', FAKE.name);
      const typedUrl = await typeInto(window, 'main input[placeholder^="https://gateway"]', FAKE.url);
      const typedModel = await typeInto(window, 'main input[placeholder="deepseek-v4-pro"]', FAKE.model);
      const saved = await pressButton(window, "保存并设为当前");
      // Not `includes("API Key")`: the page carries an API Key field label
      // whether or not anything is missing, so that match could never be red. The
      // gap sentence is the config view's own — `已选服务 …，但缺少 API Key` — and
      // it only appears when the entry is incomplete in exactly that way.
      const namesTheGap = await waitFor(window, `(${MAIN_TEXT}).includes("但缺少 API Key") ? true : null`, {
        label: "the gap sentence naming the missing API Key",
        timeout: 30000,
      })
        .then(() => true)
        .catch(() => null);
      await pressNav(window, "审查");
      const gate = await waitFor(window, `(() => { const b = [...document.querySelectorAll("main button")].find((x) => (x.textContent || "").trim() === "开始审查"); return b && b.disabled ? "disabled" : null; })()`, {
        label: "开始审查 to stay refused",
        timeout: 20000,
      }).catch(() => null);
      return {
        ok: typedName === FAKE.name && typedUrl === FAKE.url && typedModel === FAKE.model && Boolean(saved) && namesTheGap === true && gate === "disabled",
        detail: [
          typedName !== FAKE.name || typedUrl !== FAKE.url || typedModel !== FAKE.model ? "one of the three fields never took the typed value (React did not see the input event)" : "",
          !saved ? "保存并设为当前 was not there to press" : "",
          namesTheGap !== true ? "after saving the entry with no Key, the settings page never named API Key as the gap" : "",
          gate !== "disabled" ? "开始审查 is not disabled for an entry with no Key — a run that can only fail, started by the one button the app promises to guard" : "",
        ]
          .filter(Boolean)
          .join("; "),
      };
    });

    await stepCheck("...and no review or scan process left the process before a model was configured", async () => {
      const verdict = runSpawnVerdict(spawnLog, { expected: 0, withBudget: false });
      return {
        ok: verdict.ok,
        detail: verdict.ok
          ? `${spawnLog.length} child process(es) so far, none of them a run: ${spawnLog.map((r) => r.args.join(" ")).slice(0, 4).join(" | ")}`
          : `the UI let one through while the model service was still incomplete: ${verdict.detail}`,
      };
    });

    await stepCheck("filling the Key on that same entry unlocks 开始审查 with the list intact", async () => {
      await pressNav(window, "设置");
      const typed = await waitFor(window, `Boolean(document.querySelector('main input[type="password"]'))`, { label: "the API Key field to come back", timeout: 15000 })
        .then(() => typeInto(window, 'main input[type="password"]', FAKE.key))
        .catch(() => null);
      const saved = await pressButton(window, "保存并设为当前");
      const ready = await waitFor(window, `(${MAIN_TEXT}).includes("已就绪") ? true : null`, { label: "the 模型服务 badge to say 已就绪", timeout: 40000 })
        .then(() => true)
        .catch(() => null);
      await pressNav(window, "审查");
      const gate = await waitFor(window, `(() => { const b = [...document.querySelectorAll("main button")].find((x) => (x.textContent || "").trim() === "开始审查"); return b && !b.disabled ? "open" : null; })()`, {
        label: "开始审查 to become clickable",
        timeout: 40000,
      })
        .then(() => "open")
        .catch(() => null);
      const stillListed = await hasOnScreen(window, "a.go", MAIN_TEXT);
      if (ready === true && gate === "open") landmarks.add("provider-saved");
      return {
        ok: typed === FAKE.key && Boolean(saved) && ready === true && gate === "open" && stillListed,
        detail: [
          typed !== FAKE.key ? "the API Key field never took the typed value" : "",
          !saved ? "保存并设为当前 was not there to press" : "",
          ready !== true ? "the 模型服务 badge did not change to 已就绪 after a complete entry was saved" : "",
          gate !== "open" ? "开始审查 is still disabled although the config view answered ready — the two halves disagree about the same config" : "",
          gate === "open" && !stillListed ? "the file list disappeared when the provider was configured" : "",
        ]
          .filter(Boolean)
          .join("; "),
      };
    });

    await stepCheck("no child process ever ran against the developer's real home", async () => {
      const { violations, sandboxes } = spawnHomeViolations(spawnLog, {
        tempHome,
        realHome,
        llmTestPrefix: path.join(os.tmpdir(), "ocr-llmtest-"),
      });
      return {
        ok: violations.length === 0,
        detail: violations.length
          ? violations.join("; ")
          : `${spawnLog.length} child process(es) under ${tempHome}${sandboxes.length ? `, plus ${sandboxes.length} that ran in the app's own throwaway CLI-test profile (config-handler makes one because a saved Key wins over OCR_LLM_*)` : ""}`,
      };
    });

    /* ---- the guard at the end of this chain: a scan nobody meant to start ---- */
    await stepCheck("全量扫描 past the threshold asks before it spends", async () => {
      const openedTuning = await pressButton(window, "调整这次审查的参数");
      const typedBudget = await typeInto(window, 'main input[placeholder="0 = 不限"]', "300000");
      const switched = await press(window, `[...document.querySelectorAll("main button")].find((x) => (x.textContent || "").includes("全量扫描"))`);
      const scanList = await waitFor(window, `(${MAIN_TEXT}).includes("g1.go") ? ${MAIN_TEXT} : null`, {
        label: "the whole-repository list (35 .go files)",
        timeout: 90000,
      })
        .then(() => true)
        .catch(() => null);
      const clickedRun = await pressButton(window, "开始审查");
      const nothingYet = runSpawnVerdict(spawnLog, { expected: 0, withBudget: false });
      const dialogShown = await waitFor(
        window,
        `document.querySelector('[role="dialog"]') && (${BODY_TEXT}).includes("这次扫描的规模不小") ? true : null`,
        { label: "the cost confirmation", timeout: 20000 }
      )
        .then(() => true)
        .catch(() => null);
      const dialogText = `document.querySelector('[role="dialog"]') ? document.querySelector('[role="dialog"]').innerText : ""`;
      const quotesCeiling = dialogShown === true ? await hasOnScreen(window, "你设的总 token 上限是 300000", dialogText) : false;
      const quotesEstimate = dialogShown === true ? await hasOnScreen(window, "万 token", dialogText) : false;
      if (dialogShown === true) landmarks.add("confirm-shown");
      return {
        ok: Boolean(openedTuning && typedBudget === "300000" && switched && scanList && clickedRun && dialogShown === true && quotesCeiling && quotesEstimate && nothingYet.ok),
        detail: [
          !openedTuning ? "the parameter drawer never opened" : "",
          typedBudget !== "300000" ? "the token ceiling field never took 300000" : "",
          !switched ? "全量扫描 was not there to switch to" : "",
          !scanList ? "the whole-repository list never arrived, so the count behind the guard is unknown" : "",
          !clickedRun ? "开始审查 was not there to press" : "",
          dialogShown !== true ? "the run started without asking: a scan of this size is the one mistake this app promises to interrupt" : "",
          dialogShown === true && !quotesCeiling ? "the confirmation appeared but never repeated the ceiling that was set — its number is decoration" : "",
          dialogShown === true && !quotesEstimate ? "the confirmation appeared without a token estimate, so nothing tells the reader what they are approving" : "",
          !nothingYet.ok ? `a run had already left the process before the confirmation: ${nothingYet.detail}` : "",
        ]
          .filter(Boolean)
          .join("; "),
      };
    });

    await stepCheck("...and 取消 in that dialog leaves no process behind", async () => {
      const cancelled = await pressDialogButton(window, "取消");
      const closed = await waitFor(window, `document.querySelector('[role="dialog"]') ? null : "closed"`, {
        label: "the cost confirmation to close",
        timeout: 15000,
      })
        .then(() => "closed")
        .catch(() => null);
      const verdict = runSpawnVerdict(spawnLog, { expected: 0, withBudget: false });
      return {
        ok: Boolean(cancelled) && closed === "closed" && verdict.ok,
        detail: !cancelled
          ? "the confirmation's 取消 was not there to press — the dialog is portalled outside main, so this is the reach, not the guard"
          : closed !== "closed"
            ? "the dialog stayed open after 取消"
            : verdict.ok
              ? "no child process was started: the refusal happened before the CLI was asked"
              : verdict.detail,
      };
    });

    await stepCheck("...and 仍然开始 spawns exactly one run, carrying the --max-tokens-budget that was set", async () => {
      await pressButton(window, "开始审查");
      const reopened = await waitFor(window, `document.querySelector('[role="dialog"]') && (${BODY_TEXT}).includes("这次扫描的规模不小") ? true : null`, {
        label: "the cost confirmation to come back",
        timeout: 20000,
      })
        .then(() => true)
        .catch(() => null);
      const confirmed = await pressDialogButton(window, "仍然开始");
      let verdict = runSpawnVerdict(spawnLog, { expected: 1, withBudget: true });
      for (const deadline = Date.now() + 30000; Date.now() < deadline && !verdict.ok; ) {
        await sleep(500);
        verdict = runSpawnVerdict(spawnLog, { expected: 1, withBudget: true });
      }
      // Starting a run moves the view to 结果, where the run's own 取消 lives in
      // `main` — a different button from the dialog's, and deliberately not
      // confused with it.
      const cancelledRun = await pressButton(window, "取消");
      const after = runSpawnVerdict(spawnLog, { expected: 1, withBudget: true });
      return {
        ok: reopened === true && Boolean(confirmed) && after.ok,
        detail:
          reopened !== true
            ? "pressing 开始审查 again did not bring the confirmation back, so the guard is a one-time nag rather than a gate"
            : !confirmed
              ? "仍然开始 was not there to press inside the dialog"
              : after.ok
                ? `${after.detail}${cancelledRun ? "; the run was then stopped through the app's own 取消" : "; the run had already ended on its own by the time 取消 was pressed"}`
                : after.detail,
      };
    });

    await stepCheck("不再提示 retires the guide, and it stays retired across a reload", async () => {
      await pressNav(window, "审查");
      const stillThere = await hasOnScreen(window, "三步开始第一次审查", MAIN_TEXT);
      const pressed = await pressButton(window, "不再提示");
      await sleep(400);
      const goneNow = !(await hasOnScreen(window, "三步开始第一次审查", MAIN_TEXT));
      window.webContents.reload();
      await whenLoaded(window);
      const goneAfterReload = await waitFor(window, `(${MAIN_TEXT}).includes("三步开始第一次审查") ? null : "gone"`, {
        label: "the guide to stay away after a reload",
        timeout: 20000,
      })
        .then(() => "gone")
        .catch(() => null);
      return {
        ok: Boolean(stillThere && pressed && goneNow && goneAfterReload === "gone"),
        detail: !stillThere
          ? "the guide card was already gone before anyone dismissed it — the same selector that reads present three steps back now reads absent, so one of the two is not being drawn by the card"
          : !pressed
            ? "不再提示 was not there to press"
            : !goneNow
              ? "the card stayed after 不再提示"
              : goneAfterReload !== "gone"
                ? "the card came back after a reload, so the dismissal was never written to the profile"
                : "",
      };
    });
  } catch (err) {
    check("the first-run flow completed", false, String((err && err.message) || err));
  } finally {
    // The promise the whole isolation exists to keep, judged here rather than
    // assumed: whatever the flow did to a config file, it was not done to this one.
    const CONFIG_DIGEST_STEP = "the user's own CLI config file is byte-for-byte what it was at boot";
    const realConfigAfter = digestOf(realConfigPath);
    reported.add(CONFIG_DIGEST_STEP);
    check(
      CONFIG_DIGEST_STEP,
      realConfigBefore === realConfigAfter,
      realConfigBefore === realConfigAfter
        ? `${realConfigPath} ${realConfigBefore === "absent" ? "still does not exist" : "is unchanged"}`
        : `${realConfigPath} changed (${realConfigBefore.slice(0, 12)} → ${realConfigAfter.slice(0, 12)}): a fake Key may have been written into a real profile`
    );
    // Declared after the flow, so a crash in the middle still leaves every step in
    // the report: red, naming the landmark it waited for. Deleting a step from this
    // file is caught by `tools/e2e-first-run-steps-smoke.mjs`, which reads the
    // source for the declared names.
    for (const name of FIRST_RUN_STEP_NAMES) {
      if (reported.has(name)) continue;
      reported.add(name);
      const verdict = firstRunCheck(landmarks, name);
      check(name, false, verdict.ok ? "the flow finished without ever reporting this step" : verdict.detail);
    }
    restoreDialog();
    finish();
  }
});
