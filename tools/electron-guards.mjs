// Runs tools/electron-guards.cjs in a real Electron process and reports the
// result. `npm run audit:guards`, which assumes `out/` is already built (`npm run
// audit` builds once for all four harnesses; on its own, `npm run build` first —
// `requireBuilt()` refuses a bundle older than `src/`).
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-guards-"));
  const reportPath = path.join(dir, "report.json");
  const args = [path.join(ROOT, "tools", "electron-guards.cjs"), reportPath, ...extraArgs];

  return new Promise((resolve) => {
    const child = spawn(electronPath, args, { cwd: ROOT, env, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", (err) => resolve({ error: err.message }));
    child.on("close", () => {
      if (!fs.existsSync(reportPath)) return resolve({ error: "Electron produced no report — it crashed before finishing." });
      resolve(JSON.parse(fs.readFileSync(reportPath, "utf8")));
    });
  });
}

// A headless or containerised machine has no usable GPU (Electron aborts with
// "GPU process isn't usable. Goodbye."), its OS sandbox can block file:// loads
// outright (ERR_FAILED, with no will-navigate event at all), and — when
// `chrome-sandbox` is not setuid root — Chromium dies in
// `setuid_sandbox_host.cc` before the app has done anything, which arrives here
// as *no report at all*. All three are environment limits, not product
// behaviour: the handlers under test live in the browser process and are
// unaffected. Try the strict flags first and only relax when the environment
// proves it must be relaxed, saying so out loud. "Proved it" includes producing
// no report, which is what `tools/e2e-flow.mjs` already treats as environmental;
// the two harnesses disagreeing about that is how the same container runs one
// suite green and exits 2 on the other.
const strict = (process.env.PW_ELECTRON_ARGS || "--in-process-gpu").split(" ").filter(Boolean);
let report = await runOnce(strict);
let relaxed = false;

if (report.error || report.results?.some((r) => !r.ok && /bundle loads/.test(r.name))) {
  relaxed = true;
  console.log(
    `note: ${
      report.error
        ? `the first run produced no report (${report.error})`
        : "file:// did not load under the OS sandbox"
    }; retrying with --no-sandbox (environment limit)\n`
  );
  report = await runOnce([...strict, "--no-sandbox"]);
}

if (report.error) {
  console.error("\n" + report.error);
  console.error("Re-run with PW_ELECTRON_VERBOSE=1 for the app's own output.");
  process.exit(2);
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
