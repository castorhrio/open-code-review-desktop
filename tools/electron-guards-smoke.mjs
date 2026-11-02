// Pins the two decisions that turn "Electron wrote nothing" into either a retry
// or a crash report, and the wiring that makes the harness ask them.
//
// Why this file exists: on a container whose `chrome-sandbox` is not setuid root,
// Chromium dies before Electron has written anything, and the harness sees
// exactly one fact — no report file. That is also what a main process that throws
// on startup produces. One observation, two meanings, and the difference is the
// whole check: the first is an environment limit worth running once more without
// the sandbox, the second must stay red and must say *crash*. The retry condition
// was written in round 103 so that `audit:guards` would agree with
// `tools/e2e-flow.mjs` about the same container; nothing asserted it, which is how
// a retry becomes a way of losing a real failure — and how the note printed
// before the retry came to describe every missing report as an environment limit,
// including the one that was not.
//
// Three things, each with the wrong implementation it exists to catch:
//   1. `guardsRetryReason`: which shapes earn a second run (no report at all; a
//      file:// load the OS sandbox refused) and which do not — a run that finished
//      and found a failing guard is a finding, and re-running it with the sandbox
//      off would report a red as an environment problem;
//   2. `guardsFailure`: after `--no-sandbox` has already been tried, a still-missing
//      report exits 2 naming a crash, and the sentence may not keep blaming the
//      machine;
//   3. the wiring: the harness calls these two functions instead of holding a second
//      inline copy of the conditions, and importing the module does not start
//      Electron — which is what lets this run in `audit:static`, with no build, no
//      display and no browser.
import fs from "node:fs";
import path from "node:path";
import { NO_REPORT, guardsRetryReason, guardsFailure } from "./electron-guards.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const noReport = { error: NO_REPORT };
const bundleRefused = { results: [{ ok: false, name: "bundle loads", detail: "ERR_FAILED (-2)" }] };
const findingFailed = { results: [{ ok: false, name: "navigation to https is blocked", detail: "left the app" }] };
const allGreen = { results: [{ ok: true, name: "bundle loads" }, { ok: true, name: "window.open returns null (denied)" }] };

/* ---- 1. which runs get a second chance ---- */
{
  const reason = guardsRetryReason(noReport);
  check(
    "a run that wrote no report is retried, with the reason named",
    typeof reason === "string" && /no report/.test(reason),
    JSON.stringify(reason)
  );
  const sandbox = guardsRetryReason(bundleRefused);
  check(
    "...and so is a file:// load the OS sandbox refused",
    typeof sandbox === "string" && /sandbox/.test(sandbox),
    JSON.stringify(sandbox)
  );
  check(
    "a run that finished with a failing check is NOT retried: a second run cannot make a real finding green",
    guardsRetryReason(findingFailed) === null,
    JSON.stringify(guardsRetryReason(findingFailed))
  );
  check("...and a clean run asks for nothing at all", guardsRetryReason(allGreen) === null, String(guardsRetryReason(allGreen)));

  // The wrong implementations, so the four answers above are about something.
  const retryAnything = (report) =>
    report && (report.error || (report.results || []).some((r) => r && !r.ok)) ? "retry" : null;
  check(
    "...a classifier that retries anything red would send the failed guard through --no-sandbox",
    retryAnything(findingFailed) === "retry" && guardsRetryReason(findingFailed) === null,
    JSON.stringify({ wrong: retryAnything(findingFailed), real: guardsRetryReason(findingFailed) })
  );
  const neverRetries = () => null;
  check(
    "...and one that never retries calls this container's missing sandbox a crash on the first run",
    neverRetries(noReport) === null && guardsRetryReason(noReport) !== null,
    JSON.stringify({ real: guardsRetryReason(noReport) })
  );
}

/* ---- 2. what a second missing report means ---- */
{
  const after = guardsFailure(noReport, { relaxed: true });
  const text = (after && after.lines ? after.lines : []).join(" ");
  check(
    "both runs producing nothing is a harness failure, not a verdict on the app",
    after !== null && after.code === 2,
    JSON.stringify(after)
  );
  check(
    "...and the sentence names a crash while refusing the environment excuse",
    /crash/.test(text) && text.includes("not as an environment limit"),
    text
  );
  check(
    "...and it says the retry had already relaxed the sandbox, so nobody pays for a third run",
    text.includes("--no-sandbox"),
    text
  );
  check(
    "the fixture is the harness's own words for a missing report, not a copy kept here",
    noReport.error === NO_REPORT && /produced no report/.test(NO_REPORT),
    NO_REPORT
  );
  const single = guardsFailure(noReport, {});
  check(
    "a run that was never retried does not claim two runs happened",
    single.code === 2 && !single.lines.join(" ").includes("Both runs"),
    single.lines.join(" ")
  );
  check(
    "...and a report that exists is not a harness failure — findings are the caller's verdict",
    guardsFailure(findingFailed, { relaxed: true }) === null && guardsFailure(allGreen, {}) === null,
    JSON.stringify(guardsFailure(findingFailed, { relaxed: true }))
  );

  const excuseForever = (report) => (report && report.error ? { code: 0, lines: ["environment limit"] } : null);
  const wrong = excuseForever(noReport);
  check(
    "...the variant that keeps blaming the machine exits 0 on a dead Electron and never says crash",
    wrong.code === 0 && !/crash/.test(wrong.lines.join(" ")) && after.code === 2 && /crash/.test(text),
    JSON.stringify(wrong)
  );
}

/* ---- 3. the harness asks these two, and importing it costs nothing ---- */
{
  const src = fs.readFileSync(path.join(ROOT, "tools", "electron-guards.mjs"), "utf8");
  check(
    "the retry decision comes from guardsRetryReason, not from an inline copy",
    /const reason = guardsRetryReason\(report\)/.test(src) &&
      !/report\.error \|\| report\.results\?\.some\(/.test(src),
    "no inline condition found"
  );
  check(
    "...and the failure verdict comes from guardsFailure, carrying whether the retry happened",
    /const failure = guardsFailure\(report, \{ relaxed \}\)/.test(src) && /relaxed = true;/.test(src),
    "guardsFailure is not wired"
  );
  check(
    "...and the retry really adds --no-sandbox instead of only saying so",
    /runOnce\(electronPath, \[\.\.\.strict, "--no-sandbox"\]\)/.test(src),
    "the second run does not pass the flag"
  );
  check(
    "...and the note printed before the retry is the reason the classifier returned",
    /console\.log\(`note: \$\{reason\}/.test(src),
    "the note is not built from the reason"
  );
  check(
    "importing the harness does not start Electron — which is what lets audit:static run this",
    typeof guardsRetryReason === "function" && /if \(isEntryPoint\) await main\(\);/.test(src),
    "main() is not gated by the entry point"
  );

  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
  check(
    "`audit:guards-retry` runs this file and is part of `audit:static`",
    String(scripts["audit:guards-retry"] || "").includes("electron-guards-smoke.mjs") &&
      String(scripts["audit:static"] || "").includes("audit:guards-retry"),
    String(scripts["audit:static"] || "").slice(0, 60)
  );
  check(
    "...while the run that needs Electron stays in `audit:app`",
    String(scripts["audit:guards"] || "").includes("electron-guards.mjs") &&
      String(scripts["audit:app"] || "").includes("audit:guards"),
    String(scripts["audit:app"] || "")
  );
}

console.log(`\n${failures.length ? `${failures.length} failed` : "all electron-guards retry checks passed"}`);
if (failures.length) {
  console.error(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
