// Runs tools/e2e-fake-provider.cjs in a real Electron process and judges the
// screens it captured. `npm run audit:e2e-truncation`, part of `npm run audit:app`
// — it assumes `out/` is already built (`npm run build` first on its own;
// `requireBuilt()` refuses a bundle older than `src/`).
//
// Two layers, on purpose:
//
//   * the **harness** (`.cjs`) drives the app and writes down what was on screen —
//     the badge's `data-run-status`, the badge's word, `<main>`'s text, every
//     toast it saw, and the child processes it spawned;
//   * the **rules** (`e2e-fake-provider-rules.cjs`) say what those facts must be,
//     and are exercised without Electron by `tools/e2e-fake-provider-smoke.mjs`.
//
// This file is only the wiring between them: it spawns Electron, reads the report
// off disk (a GUI-subsystem binary on Windows does not reliably inherit the parent
// console, so stdout would be lost), and turns the rules' verdicts into the two
// exit codes that matter. Keeping the judgements out of here is what makes them
// pokeable — a rule that lives in a file needing a display server is a rule nobody
// can push back on.
//
// A missing report is a failure of *this* gate, never a silent zero: the one thing
// a crashing harness must not look like is a passing one.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireBuilt } from "./ui-audit/playwright.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
requireBuilt();

const require = createRequire(path.join(ROOT, "package.json"));
const RULES = require(path.join(ROOT, "tools", "e2e-fake-provider-rules.cjs"));

const electronPath = require("electron");
if (typeof electronPath !== "string" || !fs.existsSync(electronPath)) {
  console.error("Cannot find the Electron binary. Run npm install.");
  process.exit(2);
}

// Inheriting ELECTRON_RUN_AS_NODE makes electron.exe behave as plain Node: the app
// then dies on `require("electron").app` being undefined and the failure looks like
// a broken app rather than a broken harness.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

function runOnce(extraArgs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-e2e-trunc-"));
  const reportPath = path.join(dir, "report.json");
  const args = [path.join(ROOT, "tools", "e2e-fake-provider.cjs"), reportPath, ...extraArgs];

  return new Promise((resolve) => {
    const child = spawn(electronPath, args, { cwd: ROOT, env, stdio: ["ignore", "inherit", "inherit"] });
    // The harness has its own watchdog; a process killed before it fires must not
    // take the whole gate down with it.
    const killer = setTimeout(() => child.kill(), 420000);
    const done = (value) => {
      clearTimeout(killer);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a leftover temp dir is not a failure */
      }
      resolve(value);
    };
    child.on("error", (err) => done({ error: err.message }));
    child.on("close", () => {
      if (!fs.existsSync(reportPath)) return done({ error: "Electron produced no report — it crashed before finishing." });
      try {
        done(JSON.parse(fs.readFileSync(reportPath, "utf8")));
      } catch (err) {
        done({ error: `unreadable report: ${err.message}` });
      }
    });
  });
}

// Same environment limits as the other real-Electron checks: no usable GPU, and an
// OS sandbox that can block `file://` loads. Try strict first, relax only when the
// environment proves it must, and say so.
const strict = (process.env.PW_ELECTRON_ARGS || "--in-process-gpu").split(" ").filter(Boolean);
let report = await runOnce(strict);
const environmental = (r) => r.error || r.results?.some((x) => !x.ok && /throwaway profile|watchdog/.test(x.name));
let relaxed = false;
if (environmental(report)) {
  relaxed = true;
  console.log(
    `note: ${
      report.error ? `the first run produced no report (${report.error})` : "the app did not boot against the throwaway profile"
    }; retrying with --no-sandbox (environment limit)\n`
  );
  report = await runOnce([...strict, "--no-sandbox"]);
}

if (report.error) {
  console.error(`\nFAIL  the truncation harness could not run: ${report.error}`);
  process.exit(1);
}

const results = Array.isArray(report.results) ? report.results.slice() : [];
const steps = Array.isArray(report.steps) ? report.steps : [];
const views = report.views && typeof report.views === "object" ? report.views : {};
const facts = report.facts && typeof report.facts === "object" ? report.facts : {};

/**
 * The rules' verdicts, turned into the same shape as the harness's own checks.
 *
 * A missing view is red, and named: "the truncated screen was never captured" is
 * a different sentence from "the truncated screen said 完成", and folding the two
 * into one silence is how a harness that never got there looks like a harness that
 * passed. `expectTruncated` is the whole design — the *same* rule function runs
 * against the control run with the expectation flipped, so a rule that is green
 * for any screen cannot be green for both.
 */
const judge = (name, fn) => {
  let violations = null;
  try {
    violations = fn();
  } catch (err) {
    violations = [`the rule threw: ${(err && err.message) || err}`];
  }
  results.push({
    name,
    ok: violations.length === 0,
    detail: violations.join(" / "),
  });
};

for (const mode of ["truncated", "complete"]) {
  const missing = RULES.missingSteps(steps, mode);
  results.push({
    name: `the ${mode} pass reported every step it is required to report`,
    ok: missing.length === 0,
    detail: missing.length ? `never reported: ${missing.join(", ")}` : `${steps.length} steps reported`,
  });
}

judge("the truncated results screen never reads as 完成", () =>
  views.truncated
    ? RULES.truncationViolations(views.truncated, { expectTruncated: true })
    : ["the truncated results screen was never captured — the harness did not get that far"]
);

judge("the truncated report screen never reads as a clean, complete document", () =>
  views.truncatedReport
    ? RULES.reportViolations(views.truncatedReport, { expectTruncated: true })
    : ["the truncated report screen was never captured — the harness did not get that far"]
);

judge("the same rules, pointed at the finished control run, still say 完成", () =>
  views.complete
    ? RULES.truncationViolations(views.complete, { expectTruncated: false })
    : ["the control run's results screen was never captured, so the truncation rule above has no control"]
);

for (const r of results) console.log(`${r.ok ? "ok      " : "FAIL    "} ${r.name}${r.detail ? `  <- ${r.detail}` : ""}`);

/* ---- the readings, so the next person does not have to re-run this to quote them ---- */
const ms = (x) => (typeof x === "number" ? `${x}ms` : "?");
console.log(
  `\nread off the screen: truncated data-run-status=${JSON.stringify(views.truncated?.status)} label=${JSON.stringify(
    views.truncated?.label
  )} in ${ms(facts.truncated?.ms)}; report data-run-status=${JSON.stringify(views.truncatedReport?.status)}; control data-run-status=${JSON.stringify(
    views.complete?.status
  )} label=${JSON.stringify(views.complete?.label)} in ${ms(facts.complete?.ms)}`
);
console.log(
  `budget typed=${JSON.stringify(facts.truncated?.typedBudget)} reached the CLI as --max-tokens-budget=${JSON.stringify(
    (facts.truncated?.spawnArgs || []).flatMap((args) => (args.includes("--max-tokens-budget") ? args[args.indexOf("--max-tokens-budget") + 1] : []))
  )}; provider requests=${facts.truncated?.providerRequests ?? "?"} (truncated) / ${facts.complete?.providerRequests ?? "?"} (control)`
);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} ok, ${failed.length} failed  (real Electron, real CLI, fake provider${relaxed ? ", sandbox relaxed" : ""})`);
if (failed.length) {
  console.error(`\ntruncation checks failed: ${failed.map((r) => r.name).join(", ")}`);
  process.exit(1);
}
