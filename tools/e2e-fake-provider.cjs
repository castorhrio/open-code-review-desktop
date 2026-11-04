// End-to-end: the truncation screen, rendered by the real app.
//
// This is the half of DOD-4 that was still open. `tools/fake-provider-smoke.mjs`
// proves the *CLI* reports `status=complete` together with
// `summary.budget_exceeded=true` — a run that stopped at a budget and still calls
// itself finished. `src/lib/format.ts` decides what the badge and the toast say
// about that, and `tools/format-notice-smoke.mjs` pins those decisions as
// functions. Between the two there was one thing nobody had ever looked at: the
// screen. So this harness boots the app for real, points it at the fake provider,
// sets a token budget in the form, presses 开始审查, and reads what the results
// screen and the report screen actually say.
//
// What is real here, and what is not:
//
//   * **Real app.** `main.js` is required in this process, with the real preload,
//     the real ipcMain handlers, the real `ocr-service.js` and the real pinned
//     `ocr` binary. Nothing in `src/` is stubbed and no payload is injected into
//     the renderer — the run is started by pressing the button a person presses.
//   * **Real truncation.** The budget comes from the form (25000), the provider
//     reports 30000 tokens per request, and the CLI's *own* budget arithmetic
//     decides the run was cut short. The harness never writes
//     `budget_exceeded: true` anywhere; it reads it back off the screen.
//   * **Not a model.** `tools/fake-provider.mjs` answers the protocol the pinned
//     binary speaks, bound to loopback. No packet leaves the machine.
//   * **Throwaway profile.** `HOME` (and the three Windows equivalents) plus the
//     Electron `userData` point into a temp directory created before `main.js`
//     loads, so the fake Key the fixture writes with `ocr config set` cannot land
//     in a developer's real config. The user's own config file is compared
//     byte-for-byte at the end: a harness that changed it broke a promise, not a
//     test.
//
// Then the same page is driven a **second** time with the budget cleared, against
// a provider that reports tiny usage. That run is not the point — it is the
// control: it proves the assertions above can tell a truncated screen from a
// finished one, because the finished one really does say 完成 and really has no
// truncation band. Two runs, one rule set, two answers.
//
// The judgements live in `tools/e2e-fake-provider-rules.cjs` (pure, exercised by
// `tools/e2e-fake-provider-smoke.mjs`); this file only collects the facts they
// judge and writes them to the report path `tools/e2e-fake-provider.mjs` hands
// it. Electron cannot reliably write to a parent console on Windows, which is why
// the report is a file.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");

const ROOT = path.resolve(__dirname, "..");
const { timeoutError, screenAfter, neverAppeared } = require(path.join(ROOT, "tools", "e2e-screen.cjs"));
const RULES = require(path.join(ROOT, "tools", "e2e-fake-provider-rules.cjs"));

const reportPath = process.argv[2];
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: String(detail || "") });

// Steps this harness reports. A declared step that never appears in the report is
// reported red by the runner rather than quietly missing: a check that counts
// only failures reads the same whether it was skipped or satisfied.
const steps = [];
const views = {};
const facts = {};

/* ---- the throwaway profile, installed before anything can read the real one ---- */
const realHome = process.env.HOME || process.env.USERPROFILE || os.homedir();
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-e2e-trunc-"));
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
  userDataPath = `unavailable: ${err.message}`;
}

const realConfigPath = path.join(realHome, ".opencodereview", "config.json");
const digestOf = (file) => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "absent";
  }
};
const realConfigBefore = digestOf(realConfigPath);

/* ---- every child process the app starts is written down ----
 * The budget assertion is not "the form accepted 25000": it is "the CLI was
 * started with it". The only honest evidence for that is this process's spawn
 * log, wrapped before `main.js` pulls in the service that spawns.
 */
const spawnLog = [];
const realSpawn = cp.spawn;
cp.spawn = function (bin, args, options) {
  const child = realSpawn.apply(this, arguments);
  spawnLog.push({ bin: String(bin), args: (args || []).map(String), child });
  return child;
};
const RUN_COMMANDS = ["review", "scan"];
const runsSpawned = () => spawnLog.filter((r) => RUN_COMMANDS.includes(r.args[0]));

const finish = () => {
  for (const record of spawnLog) {
    try {
      if (record.child && record.child.exitCode === null && !record.child.killed) record.child.kill();
    } catch {
      /* already gone */
    }
  }
  try {
    fs.writeFileSync(reportPath, JSON.stringify({ results, steps, views, facts }, null, 2));
  } catch (err) {
    console.error(`the truncation report could not be written: ${err.message}`);
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

// Two real runs (one truncated, one not) plus a git fixture and a bundle load fit
// inside this; a hang does not.
setTimeout(() => {
  check("the truncation flow finished within the watchdog", false, "the harness hung and was stopped; whatever it was waiting for never arrived");
  finish();
}, 300000).unref?.();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function whenLoaded(win, timeout = 30000) {
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
    await sleep(200);
  }
  throw timeoutError(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

const evalJs = (win, expr) => win.webContents.executeJavaScript(expr, true);
const MAIN_TEXT = `document.querySelector("main") ? document.querySelector("main").innerText : ""`;

/* ---- the four things a person does with a mouse ----
 * `press` dispatches the whole pointer sequence: the run button is an ordinary
 * `<button>` and answers to `click`, while the parameter drawer's toggle and the
 * nav rail are Radix/`aria-label`-driven. One helper for all of them, so the flow
 * cannot pass a control by accident of it being simple. `typeInto` goes through
 * the window's own value setter and then fires `input`, because assigning
 * `el.value` alone leaves React's controlled field showing the new text while its
 * state still holds the old one — a budget field that looks filled and reaches
 * the CLI empty.
 */
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

const mainButton = (text) => `[...document.querySelectorAll("main button")].find((x) => (x.textContent || "").trim() === ${JSON.stringify(text)})`;
const pressButton = (win, text) => press(win, mainButton(text));
const pressNav = (win, label) => press(win, `document.querySelector('button[aria-label=${JSON.stringify(label)}]')`);

const BUDGET_FIELD = 'main input[placeholder="0 = 不限"]';

/** The run button's label and whether it can be pressed. */
const runButtonState = (win) =>
  evalJs(
    win,
    `(() => {
       const wanted = ["开始审查", "审查运行中…", "续跑未完成部分"];
       const b = [...document.querySelectorAll("main button")].find((x) => wanted.includes((x.textContent || "").trim()));
       return b ? { found: true, label: b.textContent.trim(), disabled: Boolean(b.disabled) } : { found: false, label: null, disabled: null };
     })()`
  );

/* ---- toast capture ----
 * The toast is the sentence that disappears, and it is the one that used to read
 * 审查完成 over a truncated run. A single look at the DOM when the results screen
 * appears would miss it often enough to make the assertion flaky, so every toast
 * is recorded by an observer from the moment the app is ready to run, and each one
 * keeps its `data-type` (the tone `completionNotice` chose) as well as its words.
 */
const INSTALL_COLLECTOR = `(() => {
  if (Array.isArray(window.__ocrToasts)) return true;
  const seen = new Set();
  window.__ocrToasts = [];
  const sweep = () => {
    for (const el of document.querySelectorAll("[data-sonner-toast]")) {
      const text = (el.innerText || "").trim();
      if (!text) continue;
      const type = el.getAttribute("data-type") || "";
      const key = type + "|" + text;
      if (seen.has(key)) continue;
      seen.add(key);
      window.__ocrToasts.push({ type, text, at: Date.now() });
    }
  };
  new MutationObserver(sweep).observe(document.body, { childList: true, subtree: true, characterData: true });
  sweep();
  return true;
})()`;

/** What the screen says right now: the badge's own value, the badge's word, the
 * main pane's text (including the `role="status"` line, which is inside it) and
 * every toast seen this run. */
const captureView = (win) =>
  evalJs(
    win,
    `(() => {
       const badges = document.querySelectorAll("[data-run-status]");
       const badge = badges[0] || null;
       const main = document.querySelector("main");
       return {
         status: badge ? badge.getAttribute("data-run-status") : null,
         label: badge ? (badge.innerText || "").trim() : "",
         badgeCount: badges.length,
         screen: main ? main.innerText : "",
         claims: Array.isArray(window.__ocrToasts) ? window.__ocrToasts.slice() : [],
       };
     })()`
  );

/**
 * One run, driven the way a person drives it: 审查 → open the parameter drawer →
 * fill (or clear) the token budget → 开始审查 → wait for the results screen.
 *
 * Returns what was observed. A failure to reach the results screen is thrown with
 * the screen it was stuck on, so "the run never finished" and "the results screen
 * said the wrong thing" stay two different sentences.
 */
async function runWithBudget(win, { budget, label, timeout = 180000 }) {
  await pressNav(win, "审查");
  const ready = await waitFor(win, `(() => { const b = [...document.querySelectorAll("main button")].find((x) => (x.textContent || "").trim() === "开始审查"); return b && !b.disabled ? "ready" : null; })()`, {
    label: `${label}: 开始审查 to be pressable`,
    timeout: 60000,
  }).catch(() => null);
  if (!ready) {
    const screen = await evalJs(win, MAIN_TEXT).catch(() => "");
    throw new Error(`${label}: 开始审查 never became pressable, so this run could not be started. Screen said:\n${String(screen).slice(0, 700)}`);
  }

  const opened = await pressButton(win, "调整这次审查的参数");
  const typed = await waitFor(win, `Boolean(document.querySelector(${JSON.stringify(BUDGET_FIELD)}))`, {
    label: `${label}: the token-budget field`,
    timeout: 15000,
  })
    .then(() => typeInto(win, BUDGET_FIELD, budget))
    .catch(() => null);
  if (typed === null) {
    throw new Error(`${label}: the parameter drawer never showed the token-budget field (opened=${opened})`);
  }
  const effective = await evalJs(win, `Number(document.querySelector(${JSON.stringify(BUDGET_FIELD)}).value || 0)`);

  const before = runsSpawned().length;
  const pressed = await pressButton(win, "开始审查");
  if (!pressed) throw new Error(`${label}: 开始审查 was not there to press`);

  const started = Date.now();
  // The results screen is the run's own end: the badge only exists once a result
  // is on screen, and the finding only exists once the CLI published one.
  await waitFor(
    win,
    `(() => {
       const badge = document.querySelector("[data-run-status]");
       const main = document.querySelector("main");
       if (!badge || !main) return null;
       return main.innerText.includes(${JSON.stringify(RULES.FINDING_MARKER)}) ? "results" : null;
     })()`,
    { label: `${label}: the results screen with the published finding`, timeout }
  );
  const ms = Date.now() - started;

  // The toast animates in and the results screen renders in the same tick; give
  // the observer one beat before the screen is read, or the sentence that
  // disappears is read before it appeared.
  await sleep(900);
  const view = await captureView(win);

  return { view, ms, spawned: runsSpawned().slice(before), typed, effective, opened };
}

/* ---- how far the flow got, so a step that never ran is red and named ---- */
const step = async (name, body) => {
  steps.push(name);
  let verdict = null;
  try {
    verdict = await body();
  } catch (err) {
    return check(name, false, `the step threw: ${(err && err.message) || err}`);
  }
  if (!verdict) return check(name, false, "the step produced no verdict");
  check(name, verdict.ok, verdict.detail);
  return verdict;
};

app.whenReady().then(async () => {
  let truncated = null;
  let complete = null;
  try {
    // The fixture writes the provider entry with the CLI's own `config set`, into
    // the same throwaway HOME the app reads — which is why the profile had to be
    // created before this line, and why `startFixture` takes it rather than
    // making its own.
    const fixtureModule = await import(pathToFileURL(path.join(ROOT, "tools", "fake-provider-cli.mjs")).href);
    const truncatedFixture = await fixtureModule.startFixture({
      home: tempHome,
      providerOptions: { usage: RULES.TRUNCATED_USAGE },
    });
    cleanupDirs.push(truncatedFixture.dir);

    require(path.join(ROOT, "main.js"));
    let window = null;
    for (const deadline = Date.now() + 40000; Date.now() < deadline; ) {
      window = BrowserWindow.getAllWindows()[0] || null;
      if (window) break;
      await sleep(200);
    }
    if (!window) throw new Error("main.js created no window");
    await whenLoaded(window);

    // Seed the fixture repository and retire the first-run guide: this harness is
    // about one screen, and `tools/e2e-first-run.cjs` is the one that walks the
    // guide. Reloading after the write is what makes the renderer boot *against*
    // the fixture.
    await evalJs(
      window,
      `localStorage.setItem("last-repo", ${JSON.stringify(truncatedFixture.dir)}); localStorage.setItem("guide-dismissed", "1"); true`
    );
    window.webContents.reload();
    await whenLoaded(window);
    await evalJs(window, INSTALL_COLLECTOR);

    const configPath = path.join(tempHome, ".opencodereview", "config.json");
    await step("the harness booted against a throwaway profile, not the user's", async () => {
      const isolated = tempHome !== realHome && userDataPath.startsWith(tempHome) && fs.existsSync(configPath);
      return {
        ok: isolated,
        detail: isolated
          ? `HOME=${tempHome}; CLI config at ${configPath}; Electron profile at ${userDataPath}; provider ${truncatedFixture.provider.url}`
          : `the redirect did not hold: HOME=${tempHome} real=${realHome} userData=${userDataPath} config=${configPath} exists=${fs.existsSync(configPath)}`,
      };
    });

    await step("the review page rendered against the fixture repository", async () => {
      const timeoutMs = 90000;
      const screen = await screenAfter(
        waitFor(window, `(${MAIN_TEXT}).includes("a.go") ? ${MAIN_TEXT} : null`, { label: "the workspace file list (a.go)", timeout: timeoutMs }),
        () => evalJs(window, MAIN_TEXT).catch(() => ""),
        { timeoutMs }
      );
      if (screen.timedOut) return { ok: false, detail: `${neverAppeared("the previewed list", timeoutMs)}. Screen said:\n${String(screen.screen).slice(0, 700)}` };
      const previewed = spawnLog.some((r) => r.args[0] === "review" && r.args.includes("--preview"));
      return {
        ok: previewed,
        detail: previewed ? "the list came from a real `review --preview` on the fixture repository" : "a.go is on screen but no `review --preview` was spawned, so the list did not come from the CLI",
      };
    });

    /* ---- run 1: the truncated one ---- */
    truncated = await runWithBudget(window, { budget: String(RULES.BUDGET_TOKENS), label: "truncated" });
    views.truncated = truncated.view;
    facts.truncated = {
      ms: truncated.ms,
      typedBudget: truncated.typed,
      effectiveBudget: truncated.effective,
      spawnArgs: truncated.spawned.map((r) => r.args),
      providerRequests: truncatedFixture.provider.requests.length,
    };

    await step("the budget came from the form, not from the fixture's config", async () => {
      const run = truncated.spawned.find((r) => RUN_COMMANDS.includes(r.args[0]));
      const withBudget = Boolean(run) && run.args.includes("--max-tokens-budget");
      const value = withBudget ? run.args[run.args.indexOf("--max-tokens-budget") + 1] : null;
      return {
        ok: truncated.typed === String(RULES.BUDGET_TOKENS) && withBudget && value === String(RULES.BUDGET_TOKENS),
        detail: !run
          ? "no review/scan child was spawned by this run"
          : `${run.args.slice(0, 6).join(" ")} … typed=${JSON.stringify(truncated.typed)} effective=${truncated.effective} --max-tokens-budget=${JSON.stringify(value)}`,
      };
    });

    await step("the run finished and the results screen replaced the run view", async () => {
      const badge = truncated.view.status;
      const ok = Boolean(badge) && truncated.view.badgeCount === 1;
      return {
        ok,
        detail: ok
          ? `the results screen carries one badge, data-run-status=${JSON.stringify(badge)}, in ${truncated.ms}ms`
          : `the results screen was not reached as a finished run: ${JSON.stringify({ badge, badges: truncated.view.badgeCount })}`,
      };
    });

    await step("at least one toast was captured while it was on screen", async () => {
      const claims = RULES.reviewClaims(truncated.view);
      return {
        ok: claims.length > 0,
        detail: claims.length
          ? claims.map((c) => `${c.type || "?"}: ${c.text.replace(/\s+/g, " ").slice(0, 90)}`).join(" | ")
          : "no toast mentioning 审查 was captured — either none was shown or the toast surface moved, and neither is evidence about the wording",
      };
    });

    /* ---- the same run, read as a document ---- */
    const reportStarted = Date.now();
    const opened = await pressButton(window, "阅读");
    const wentToReport = await waitFor(
      window,
      `(() => {
         const back = [...document.querySelectorAll("main button")].some((x) => (x.textContent || "").trim() === "返回结果");
         return back ? "report" : null;
       })()`,
      { label: "the report screen (返回结果)", timeout: 30000 }
    ).catch(() => null);
    if (!opened || wentToReport !== "report") {
      throw new Error(`the 阅读 button did not open the report screen (pressed=${opened}, screen=${JSON.stringify(wentToReport)})`);
    }
    await sleep(400);
    views.truncatedReport = await captureView(window);
    facts.truncatedReport = { ms: Date.now() - reportStarted };

    await step("the report screen opened on the same run", async () => {
      const view = views.truncatedReport;
      const ok = Boolean(view.status) && view.screen.includes(RULES.FINDING_MARKER);
      return {
        ok,
        detail: ok ? `report badge data-run-status=${JSON.stringify(view.status)}` : `the report screen has no badge or no finding: ${JSON.stringify({ status: view.status, hasFinding: view.screen.includes(RULES.FINDING_MARKER) })}`,
      };
    });

    /* ---- run 2: the control. Same repository, a provider that reports 160
     * tokens per request, and no budget in the form. If this run does not say
     * 完成 and does not lose the truncation band's absence, the assertions above
     * would be green for a screen they cannot tell apart from this one. ---- */
    const smallFixture = await fixtureModule.startFixture({ home: tempHome, dir: truncatedFixture.dir });
    facts.control = { providerUrl: smallFixture.provider.url };
    complete = await runWithBudget(window, { budget: "", label: "complete" });
    views.complete = complete.view;
    facts.complete = {
      ms: complete.ms,
      typedBudget: complete.typed,
      spawnArgs: complete.spawned.map((r) => r.args),
      providerRequests: smallFixture.provider.requests.length,
    };

    await step("the control run was started without a budget", async () => {
      const run = complete.spawned.find((r) => RUN_COMMANDS.includes(r.args[0]));
      const ok = Boolean(run) && !run.args.includes("--max-tokens-budget") && complete.typed === "";
      return {
        ok,
        detail: !run ? "no review/scan child was spawned by the control run" : `typed=${JSON.stringify(complete.typed)} carries budget flag=${Boolean(run.args.includes("--max-tokens-budget"))}`,
      };
    });

    await smallFixture.close();
  } catch (err) {
    check("the truncation flow completed", false, String((err && err.message) || err));
  } finally {
    // The promise the whole isolation exists to keep, judged here rather than
    // assumed: whatever the flow did to a config file, it was not done to this one.
    const CONFIG_STEP = "the user's own CLI config file is byte-for-byte what it was at boot";
    steps.push(CONFIG_STEP);
    const after = digestOf(realConfigPath);
    check(
      CONFIG_STEP,
      realConfigBefore === after,
      realConfigBefore === after
        ? `${realConfigPath} ${realConfigBefore === "absent" ? "still does not exist" : "is unchanged"}`
        : `${realConfigPath} changed (${realConfigBefore.slice(0, 12)} → ${after.slice(0, 12)}): a fake Key may have been written into a real profile`
    );
    finish();
  }
});
