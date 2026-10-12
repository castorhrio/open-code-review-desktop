// Runs tools/e2e-flow.cjs in a real Electron process and reports the result.
// `npm run audit:e2e`.
//
// Electron writes its findings to a JSON file rather than stdout: on Windows a
// GUI-subsystem binary does not reliably inherit the parent console, so piping
// would silently lose the output.
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

// Inheriting ELECTRON_RUN_AS_NODE makes electron.exe behave as plain Node: the
// app then dies on `require("electron").app` being undefined and the failure
// looks like a broken app rather than a broken harness.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

function runOnce(extraArgs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-e2e-run-"));
  const reportPath = path.join(dir, "report.json");
  const args = [path.join(ROOT, "tools", "e2e-flow.cjs"), reportPath, ...extraArgs];

  return new Promise((resolve) => {
    const child = spawn(electronPath, args, { cwd: ROOT, env, stdio: ["ignore", "inherit", "inherit"] });
    // The script has its own watchdog, but a process that dies before it fires
    // must not take the whole gate down with it.
    const killer = setTimeout(() => child.kill(), 240000);
    child.on("error", (err) => {
      clearTimeout(killer);
      resolve({ error: err.message });
    });
    child.on("close", () => {
      clearTimeout(killer);
      if (!fs.existsSync(reportPath)) return resolve({ error: "Electron produced no report — it crashed before finishing." });
      try {
        resolve(JSON.parse(fs.readFileSync(reportPath, "utf8")));
      } catch (err) {
        resolve({ error: `unreadable report: ${err.message}` });
      }
    });
  });
}

// Same environment limits as the guards check: no usable GPU, and an OS sandbox
// that can block file:// loads. Try strict first, relax only when the
// environment proves it must, and say so.
//
// "Proves it must" includes producing no report at all. Under the sandbox
// Chromium logs "Network service crashed, restarting service" and then waits
// forever — the script's own watchdog is what turns that into a report, but a
// run killed before the watchdog fires arrives here as a missing file, and that
// is the environment, not the product.
const strict = (process.env.PW_ELECTRON_ARGS || "--in-process-gpu").split(" ").filter(Boolean);
let report = await runOnce(strict);
let relaxed = false;

const looksEnvironmental = (r) => r.error || r.results?.some((x) => !x.ok && /bundle mounts|watchdog/.test(x.name));
if (looksEnvironmental(report)) {
  relaxed = true;
  console.log(`note: ${report.error ? `the first run produced no report (${report.error})` : "the bundle did not load"}; retrying with --no-sandbox (environment limit)\n`);
  report = await runOnce([...strict, "--no-sandbox"]);
}

if (report.error) {
  console.error(`\nFAIL  the end-to-end harness could not run: ${report.error}`);
  process.exit(1);
}

const results = report.results || [];
for (const r of results) console.log(`${r.ok ? "ok      " : "FAIL    "} ${r.name}${r.detail ? `  <- ${r.detail}` : ""}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} ok, ${failed.length} failed  (real Electron, real CLI${relaxed ? ", sandbox relaxed" : ""})`);
if (failed.length) {
  console.error(`\nend-to-end checks failed: ${failed.map((r) => r.name).join(", ")}`);
  process.exit(1);
}
