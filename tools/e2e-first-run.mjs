// Runs tools/e2e-first-run.cjs in a real Electron process and reports the result.
// `npm run audit:e2e-first-run`, part of `npm run audit:app` — it assumes `out/`
// is already built (`npm run build` first on its own; `requireBuilt()` refuses a
// bundle older than `src/`).
//
// Electron writes its findings to a JSON file rather than stdout: on Windows a
// GUI-subsystem binary does not reliably inherit the parent console, so piping
// would silently lose the output.
//
// This one is the harness that cannot be relaxed into passing. It boots the app
// against a throwaway HOME and a throwaway Electron profile and writes a fake API
// Key through the real CLI, so a run that dies before the report is written leaves
// nothing behind — but a run that produces *no* report also cannot tell the reader
// whether the isolation held. That is why a missing report is a failure of the
// harness, printed as one, and never a silent zero.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireBuilt } from "./ui-audit/playwright.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
requireBuilt();

const electronPath = createRequire(path.join(ROOT, "package.json"))("electron");
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-e2e-first-run-"));
  const reportPath = path.join(dir, "report.json");
  const args = [path.join(ROOT, "tools", "e2e-first-run.cjs"), reportPath, ...extraArgs];

  return new Promise((resolve) => {
    const child = spawn(electronPath, args, { cwd: ROOT, env, stdio: ["ignore", "inherit", "inherit"] });
    // The harness has its own watchdog; a process killed before it fires must not
    // take the whole gate down with it.
    const killer = setTimeout(() => child.kill(), 360000);
    child.on("error", (err) => {
      clearTimeout(killer);
      resolve({ error: err.message });
    });
    child.on("close", () => {
      clearTimeout(killer);
      if (!fs.existsSync(reportPath)) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* a leftover temp dir is not a failure */
        }
        return resolve({ error: "Electron produced no report — it crashed before finishing." });
      }
      let parsed = null;
      try {
        parsed = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      } catch (err) {
        parsed = { error: `unreadable report: ${err.message}` };
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* a leftover temp dir is not a failure */
      }
      resolve(parsed);
    });
  });
}

// Same environment limits as the other real-Electron checks: no usable GPU, and an
// OS sandbox that can block `file://` loads. Try strict first, relax only when the
// environment proves it must, and say so.
const strict = (process.env.PW_ELECTRON_ARGS || "--in-process-gpu").split(" ").filter(Boolean);
let report = await runOnce(strict);
let relaxed = false;

const looksEnvironmental = (r) => r.error || r.results?.some((x) => !x.ok && /throwaway profile|watchdog/.test(x.name));
if (looksEnvironmental(report)) {
  relaxed = true;
  console.log(`note: ${report.error ? `the first run produced no report (${report.error})` : "the app did not boot against the throwaway profile"}; retrying with --no-sandbox (environment limit)\n`);
  report = await runOnce([...strict, "--no-sandbox"]);
}

if (report.error) {
  console.error(`\nFAIL  the first-run harness could not run: ${report.error}`);
  process.exit(1);
}

const results = report.results || [];
for (const r of results) console.log(`${r.ok ? "ok      " : "FAIL    "} ${r.name}${r.detail ? `  <- ${r.detail}` : ""}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} ok, ${failed.length} failed  (real Electron, throwaway profile, real CLI${relaxed ? ", sandbox relaxed" : ""})`);
if (failed.length) {
  console.error(`\nfirst-run checks failed: ${failed.map((r) => r.name).join(", ")}`);
  process.exit(1);
}
