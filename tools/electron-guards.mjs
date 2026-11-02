// Runs tools/electron-guards.cjs in a real Electron process and reports the
// result. `npm run audit:guards`, which assumes `out/` is already built (`npm run
// audit` builds once for all four harnesses; on its own, `npm run build` first —
// `requireBuilt()` refuses a bundle older than `src/`).
//
// Electron writes its findings to a JSON file rather than stdout: on Windows a
// GUI-subsystem binary does not reliably inherit the parent console, so piping
// would silently lose the output.
//
// The two decisions below are exported and pure — `guardsRetryReason` (is this
// run's answer about the environment rather than about the app?) and
// `guardsFailure` (what does a run that produced no report mean *after* the
// retry) — because the retry is the one place where a genuine crash could be
// explained away. `tools/electron-guards-smoke.mjs` (`npm run audit:guards-retry`)
// drives them with fixtures, including the case where Electron dies on both
// runs; nothing in that check needs Electron, a build, or a display.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { requireBuilt } from "./ui-audit/playwright.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
export const NO_REPORT = "Electron produced no report — it crashed before finishing.";

// A headless or containerised machine has no usable GPU (Electron aborts with
// "GPU process isn't usable. Goodbye."), its OS sandbox can block file:// loads
// outright (ERR_FAILED, with no will-navigate event at all), and — when
// `chrome-sandbox` is not setuid root — Chromium dies in
// `setuid_sandbox_host.cc` before the app has done anything, which arrives here
// as *no report at all*. All three are environment limits, not product
// behaviour: the handlers under test live in the browser process and are
// unaffected. So only those two shapes earn a retry; a run that finished and
// simply found something broken does not, because relaxing the sandbox cannot
// make a real failing assertion pass and would hide it behind one more run.
//
// `tools/e2e-flow.mjs` already treated "no report" as environmental. The two
// harnesses disagreeing about the same failure is how one container runs a
// suite green and exits 2 on the other.
export const guardsRetryReason = (report) => {
  if (!report || report.error) return "the first run produced no report";
  const bundleLoadFailed = (report.results || []).some(
    (r) => r && !r.ok && /bundle loads/.test(r.name || "")
  );
  return bundleLoadFailed ? "file:// did not load under the OS sandbox" : null;
};

// What a run with no report costs the reader. After `--no-sandbox` has already
// been tried, "no report" is no longer explainable by the sandbox: saying so is
// what keeps the retry from turning a crash into a shrug. Exit code 2 = the
// harness never got an answer; findings that failed are exit 1, decided by the
// caller from the report itself.
export const guardsFailure = (report, { relaxed = false } = {}) => {
  if (!report || !report.error) return null;
  const lines = ["", String(report.error)];
  if (relaxed) {
    lines.push(
      "Both runs stopped before writing a report, and the second already ran with --no-sandbox: " +
        "this is reported as a crash, not as an environment limit."
    );
  }
  lines.push("Re-run with PW_ELECTRON_VERBOSE=1 for the app's own output.");
  return { code: 2, lines };
};

function runOnce(electronPath, extraArgs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-guards-"));
  const reportPath = path.join(dir, "report.json");
  const args = [path.join(ROOT, "tools", "electron-guards.cjs"), reportPath, ...extraArgs];

  // Inheriting ELECTRON_RUN_AS_NODE makes electron.exe behave as plain Node: the
  // app then dies on `require("electron").app` being undefined and the failure
  // looks like a broken app rather than a broken harness.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  return new Promise((resolve) => {
    const child = spawn(electronPath, args, { cwd: ROOT, env, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", () => resolve({ error: NO_REPORT }));
    child.on("close", () => {
      if (!fs.existsSync(reportPath)) return resolve({ error: NO_REPORT });
      resolve(JSON.parse(fs.readFileSync(reportPath, "utf8")));
    });
  });
}

async function main() {
  requireBuilt();

  const electronPath = createRequire(path.join(ROOT, "package.json"))("electron");
  if (typeof electronPath !== "string" || !fs.existsSync(electronPath)) {
    console.error("Cannot find the Electron binary. Run npm install.");
    process.exit(2);
  }

  // Try the strict flags first and only relax when the environment has proved it
  // must be relaxed, saying out loud which of the two proofs was met.
  const strict = (process.env.PW_ELECTRON_ARGS || "--in-process-gpu").split(" ").filter(Boolean);
  let report = await runOnce(electronPath, strict);
  let relaxed = false;

  const reason = guardsRetryReason(report);
  if (reason) {
    relaxed = true;
    console.log(`note: ${reason}; retrying once with --no-sandbox (environment)\n`);
    report = await runOnce(electronPath, [...strict, "--no-sandbox"]);
  }

  const failure = guardsFailure(report, { relaxed });
  if (failure) {
    failure.lines.forEach((line) => console.error(line));
    process.exit(failure.code);
  }

  const { results, externalOpened, navLog, appUrl } = report;
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed += 1;
    console.log(`${r.ok ? "ok      " : "FAIL    "} ${r.name}${r.detail ? `  <- ${r.detail}` : ""}`);
  }
  console.log(`\n${results.length - failed} ok, ${failed} failed${relaxed ? "  (sandbox relaxed)" : ""}`);
  if (appUrl) console.log(`app url: ${appUrl}`);
  if (navLog?.length) console.log(`will-navigate observed: ${navLog.map((n) => `${n.url} prevented=${n.prevented}`).join(" | ")}`);
  if (externalOpened?.length) console.log(`OS browser was offered: ${externalOpened.join(", ")}`);

  if (failed) {
    console.error(`\nfailed: ${results.filter((r) => !r.ok).map((r) => r.name).join(", ")}`);
    process.exit(1);
  }
}

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntryPoint) await main();
