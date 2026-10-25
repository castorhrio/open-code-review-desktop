// Checks that the truncation evidence survives the app's exit.
//
// The evidence is written asynchronously, and the user can close the window
// right after a run finishes. Nothing outside Electron can say whether the quit
// really waits for that write, so this spawns a real Electron process, lets it
// quit, and then inspects the file — after the process is gone.
//
// Run with `npm run audit:exit`.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
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

const passed = [];
const failed = [];
const check = (name, ok, detail) => {
  (ok ? passed : failed).push(name);
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
};

/**
 * Start the harness, let it quit, and report how it ended.
 *
 * Each attempt gets its own directory: a crashed run can leave a half-written
 * file behind, and the next attempt has to start from nothing.
 */
async function runOnce(extraArgs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-exit-flush-"));
  const file = path.join(dir, "run-diagnostics.json");
  const startedAt = Date.now();
  const ended = await new Promise((resolve) => {
    const child = spawn(electronPath, [path.join(ROOT, "tools", "exit-flush.cjs"), dir, ...extraArgs], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    // A quit that never completes is the failure this harness exists to catch,
    // so the wait is bounded and reports itself instead of hanging.
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, signal: "TIMEOUT", timedOut: true });
    }, 20000);
    child.on("error", (err) => {
      clearTimeout(killer);
      resolve({ code: null, signal: null, error: err.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, timedOut: false });
    });
  });
  const elapsed = Date.now() - startedAt;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    raw = null;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...ended, raw, elapsed };
}

// A headless or containerised machine may not be able to start the Chromium
// sandbox at all — Electron aborts before the app runs ("The SUID sandbox
// helper binary was found, but is not configured correctly"). That is an
// environment limit, not a product behaviour: the flush lives in the main
// process and does not need the sandbox. Try the strict flags first and only
// relax when the environment proves it must be relaxed, saying so out loud.
const strict = (process.env.PW_ELECTRON_ARGS || "--in-process-gpu").split(" ").filter(Boolean);
let result = await runOnce(strict);
let relaxed = false;

if (!result.raw && !result.timedOut && !result.error) {
  relaxed = true;
  console.log("note: Electron could not start under the OS sandbox; retrying with --no-sandbox (environment limit)\n");
  result = await runOnce([...strict, "--no-sandbox"]);
}

check(
  "the app quits instead of hanging on the flush",
  result.timedOut !== true && !result.error,
  result.error || `exit code ${result.code}${result.signal ? ` / ${result.signal}` : ""}`
);
// The harness drains on purpose slowly, so a quit that waits for the drain
// takes at least that long. A quit that does not wait finishes in well under
// a second — which is exactly how the evidence used to be lost.
check(
  "the quit waits for the pending write",
  result.elapsed >= 1300,
  `the app took ${result.elapsed}ms to exit`
);

const entry =
  result.raw && Array.isArray(result.raw.entries)
    ? result.raw.entries.find((e) => e.session_id === "exit-session")
    : null;
check("the evidence is on disk after the process is gone", Boolean(entry), result.raw ? `entries: ${result.raw.entries?.length}` : "no file");
check("and it still says what it said", entry?.warnings?.length === 1 && entry.warnings[0].type === "review_limit_reached", JSON.stringify(entry?.warnings));
check("and it kept nothing it should not", !JSON.stringify(result.raw).includes("not persisted"));

console.log(`\n${passed.length} ok, ${failed.length} failed${relaxed ? "  (sandbox relaxed)" : ""}`);
if (failed.length) process.exit(1);
