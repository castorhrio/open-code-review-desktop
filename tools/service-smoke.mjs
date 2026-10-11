// Exercises ocr-service.js against the real CLI.
//
// Every other check here stubs the bridge or drives the UI, so the layer that
// actually builds the CLI invocation and parses its output — the app's whole
// job — went unverified. A typo in a flag name, or a parser that assumes a
// shape the CLI does not emit, would ship silently.
//
// `--preview` is used throughout because it reports which files would be
// reviewed without calling the LLM, so this needs no API key and no network.
// Run with `npm run audit:service`.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(ROOT, "package.json"));
const svc = require(path.join(ROOT, "ocr-service.js"));

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

if (!svc.binaryPath()) {
  console.error("No ocr binary found. Run npm install first.");
  process.exit(2);
}

/* ---- a throwaway git repo with a branch, so every mode has something ---- */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-service-"));
// Async spawn, not spawnSync: in a sandboxed environment spawnSync is refused
// outright with EBUSY, while spawn works. Async also matches how the app itself
// shells out.
const git = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: dir, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`git ${args.join(" ")} failed (${code}): ${err || out}`));
      else resolve(out.trim());
    });
  });

await git(["init", "-q"]);
await git(["config", "user.email", "t@example.com"]);
await git(["config", "user.name", "Test"]);
await git(["checkout", "-q", "-b", "main"]);
fs.writeFileSync(path.join(dir, "a.go"), "package main\n\nfunc main() {}\n");
await git(["add", "."]);
await git(["commit", "-q", "-m", "initial"]);
const firstCommit = await git(["rev-parse", "HEAD"]);
await git(["checkout", "-q", "-b", "feature"]);
fs.writeFileSync(path.join(dir, "b.go"), "package main\n\nfunc helper() int { return 1 }\n");
await git(["add", "."]);
await git(["commit", "-q", "-m", "add helper"]);
// Uncommitted change so `workspace` has something to report.
fs.appendFileSync(path.join(dir, "a.go"), "\n// trailing\n");

const base = { repo: dir };
const cases = [
  ["workspace", { ...base, mode: "workspace" }],
  ["range", { ...base, mode: "range", from: "main", to: "feature" }],
  ["commit", { ...base, mode: "commit", commit: firstCommit }],
  ["scan", { ...base, mode: "scan", path: "a.go,b.go" }],
];

for (const [label, spec] of cases) {
  const res = await svc.preview(spec);
  if (!res.ok) {
    check(`${label} preview`, false, res.error);
    continue;
  }
  const v = res.value;
  const shaped =
    Array.isArray(v?.files) &&
    typeof v.total_files === "number" &&
    typeof v.reviewable_count === "number" &&
    v.files.every((f) => typeof f.path === "string" && typeof f.will_review === "boolean");
  check(`${label} preview parses`, shaped, JSON.stringify(v)?.slice(0, 160));
  check(`${label} preview found files`, (v?.files?.length || 0) > 0, `${v?.files?.length} files`);
}

// The whitelist must hold: a key the mode does not own must not reach the CLI,
// or the CLI rejects the run. `path` belongs to scan, not to review.
const leak = await svc.preview({ ...base, mode: "workspace", path: "a.go", batch: "none" });
check("mode-specific flags do not leak into review", leak.ok, leak.error);

// A range with a nonsense ref must fail cleanly with a message, not throw or
// resolve with an empty preview the UI would render as "nothing to review".
const bad = await svc.preview({ ...base, mode: "range", from: "no-such-ref-xyz", to: "main" });
check("bad ref fails with an error, not a silent empty", !bad.ok && Boolean(bad.error), bad.ok ? "resolved ok" : bad.error);

// A non-repo directory must be reported, not parsed as empty.
const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-nonrepo-"));
const outside = await svc.preview({ repo: notRepo, mode: "workspace" });
check("non-repo directory is reported", !outside.ok && Boolean(outside.error), outside.ok ? "resolved ok" : outside.error);

/* ---- sessions ---- */
const sessions = await svc.listSessions(dir, 0);
check("listSessions on a fresh repo returns an empty list", sessions.ok && Array.isArray(sessions.value) && sessions.value.length === 0, JSON.stringify(sessions).slice(0, 120));

/* ---- config / info ---- */
const cfg = svc.readConfigView();
check("readConfigView returns a usable shape", cfg && typeof cfg.path === "string" && typeof cfg.ready === "boolean" && typeof cfg.providers === "object", JSON.stringify(cfg)?.slice(0, 140));

const rules = await svc.rulesCheck(dir, "a.go", "");
check("rulesCheck answers without throwing", typeof rules.ok === "boolean", JSON.stringify(rules).slice(0, 120));

/* ---- cleanup ---- */
for (const d of [dir, notRepo]) fs.rmSync(d, { recursive: true, force: true });

console.log(`\n${failures.length ? `${failures.length} failed` : "all service checks passed"}`);
if (failures.length) {
  console.error(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
