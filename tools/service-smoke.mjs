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

// A directory that is gone entirely. Node's spawn reports a missing *cwd* by
// naming the program it could not launch, so this used to come back as
// `spawn <binaryPath> ENOENT` and send the reader looking for a missing
// executable instead of the deleted repository.
const gone = path.join(os.tmpdir(), "ocr-definitely-not-here-"+process.pid);
const missing = await svc.preview({ repo: gone, mode: "workspace" });
const missingText = String(missing.error || "");
check(
  "a deleted repository names the directory, not the binary",
  !missing.ok && /仓库目录已经不存在/.test(missingText) && !/opencodereview\.exe/.test(missingText),
  missingText.slice(0, 160)
);
check(
  "and the hint says what to do about it",
  /重新选一个仓库目录/.test(missingText),
  missingText.slice(-160)
);

/* ---- sessions ---- */
const sessions = await svc.listSessions(dir, 0);
check("listSessions on a fresh repo returns an empty list", sessions.ok && Array.isArray(sessions.value) && sessions.value.length === 0, JSON.stringify(sessions).slice(0, 120));

/* ---- progress parsing ----
 * A replay of the stderr from one real single-file review (`ocr review` on a
 * throwaway repo, 3m48s, 6 findings). The parser had no test at all, which is
 * how it shipped matching only the scan wording — `changed, reviewing` never
 * matched, so across all three diff modes the run screen showed "—" for the
 * file count and nothing else for four minutes.
 */
const TRANSCRIPT = [
  "[ocr] 1 file(s) changed, reviewing 1 in C:/Users/x/work/payments-api",
  '[ocr] Skipping plan phase for group "auth.js" (1 file(s), max 9 lines, total 9 lines)',
  "[ocr]   ▶ file_read file_path=auth.js",
  "[ocr]   ✔ file_read (1ms)",
  "[ocr]   ▶ code_search search_text=tokenFor",
  "[ocr]   ✔ code_search (21ms)",
  "[ocr]   ▶ code_search search_text=auth file_patterns=[*.js]",
  "[ocr]   ✔ code_search (21ms)",
  "[ocr]   ▶ code_search search_text=USERS",
  "[ocr]   ✔ code_search (21ms)",
  "[ocr]   ▶ file_find query_name=.",
  "[ocr]   ✔ file_find (19ms)",
  "[ocr]   ▶ code_comment",
  "[ocr]   ✔ code_comment (0s)",
  "[ocr]   ▶ file_read file_path=auth.js",
  "[ocr]   ✔ file_read (1ms)",
  "[ocr]   ▶ code_search search_text=tokenFor|require\\(.*auth use_perl_regexp=true",
  "[ocr]   ✔ code_search (22ms)",
  "[ocr]   ▶ code_comment",
  "[ocr]   ✔ code_comment (0s)",
  "[ocr]   ▶ code_comment",
  "[ocr]   ✔ code_comment (1ms)",
  "[ocr] Summary: 1 file(s) reviewed, 6 comment(s), ~81601 token(s) used, 3m48s elapsed",
];
const prog = svc.createProgress();
const milestones = [];
for (const line of TRANSCRIPT) {
  const kept = svc.feedProgressLine(prog, line);
  if (kept) milestones.push(kept);
}
check("review-mode scope line sets the file count", prog.files === 1 && prog.reviewing === 1, `${prog.files}/${prog.reviewing}`);
check("tool calls are counted once each", prog.tools === 10, String(prog.tools));
check("code_comment calls count as findings", prog.comments === 6, String(prog.comments));
check("the file under review is tracked", prog.current === "auth.js", prog.current);
check("activity feed holds the live rows", prog.activity.length >= 10, String(prog.activity.length));
check(
  "every settled activity row is closed, none left running",
  prog.activity.filter((a) => a.kind === "tool" && a.state === "running").length === 0,
  JSON.stringify(prog.activity.slice(-2))
);
check(
  "the feed carries the tool's own arguments",
  prog.activity.some((a) => a.tool === "code_search" && a.args.includes("search_text=USERS")),
  JSON.stringify(prog.activity.slice(2, 4))
);
check("milestone log keeps the scope and summary lines", milestones.some((l) => /changed, reviewing/.test(l)) && milestones.some((l) => /Summary:/.test(l)), milestones.join(" | "));
check("per-tool chatter stays out of the milestone log", !milestones.some((l) => /[▶✔✗•]/.test(l)), milestones.join(" | "));
check("skipping a phase is not counted as an excluded file", prog.excluded === 0, String(prog.excluded));
// The feed is capped and the rows are React keys, so a long run must keep
// producing distinct ids once the cap is reached — an id derived from the array
// length silently collided there.
const longProg = svc.createProgress();
for (let i = 0; i < 200; i++) {
  svc.feedProgressLine(longProg, `[ocr]   ▶ file_read file_path=f${i}.go`);
  svc.feedProgressLine(longProg, "[ocr]   ✔ file_read (1ms)");
}
check("the feed is bounded", longProg.activity.length === 80, String(longProg.activity.length));
check(
  "ids stay unique once the feed is at its cap",
  new Set(longProg.activity.map((a) => a.id)).size === longProg.activity.length,
  longProg.activity.map((a) => a.id).join(",")
);
check("the newest row is still the last", longProg.activity[79].state === "done", JSON.stringify(longProg.activity[79]));
check(
  "the closing summary reads as prose, not as a CLI line",
  prog.activity.some((a) => a.kind === "note" && a.text === "已完成 1 个文件，产出 6 条评论 · 耗时 3m48s"),
  JSON.stringify(prog.activity.slice(-1))
);

// The first ten seconds of a real run are the window that reads as "hung": the
// CLI has printed its scope line and started planning, but no tool call has
// finished yet. Observed live — the feed was empty while the log already had
// three lines.
const early = svc.createProgress();
svc.feedProgressLine(early, "[ocr] 8 file(s) changed, reviewing 5 in /home/x/work/payments-api");
svc.feedProgressLine(early, '[ocr] Skipping plan phase for group "internal/service/auth/login.go" (1 file(s), max 90 lines, total 90 lines)');
check(
  "the feed has something to show before the first tool call",
  early.activity.length >= 2 && /范围确定/.test(early.activity[0].text),
  JSON.stringify(early.activity)
);
check("and it already names the file being read", early.current === "internal/service/auth/login.go", early.current);

// The other two scope wordings, both of which the CLI really prints.
const scanProg = svc.createProgress();
svc.feedProgressLine(scanProg, "[ocr] full-scan: 27 file(s) discovered, reviewing 27 in /repo");
check("scan-mode scope line parses", scanProg.files === 27 && scanProg.reviewing === 27, `${scanProg.files}/${scanProg.reviewing}`);
const resumeProg = svc.createProgress();
svc.feedProgressLine(resumeProg, "[ocr] Resume 10b8a6bd: reusing 3 file(s), reviewing 5 file(s)");
check("resume scope line parses", resumeProg.files === 3 && resumeProg.reviewing === 5, `${resumeProg.files}/${resumeProg.reviewing}`);
const costProg = svc.createProgress();
svc.feedProgressLine(costProg, "[ocr] estimated cost: ~1.2M tokens");
svc.feedProgressLine(costProg, "[ocr] Skipping vendor/foo.js  binary file");
check("cost and exclusions parse", costProg.cost === "~1.2M tokens" && costProg.excluded === 1, `${costProg.cost}/${costProg.excluded}`);
const filteredProg = svc.createProgress();
svc.feedProgressLine(filteredProg, "[ocr] Filtered 12 file(s) by include/exclude rules");
check("aggregate filtered count parses", filteredProg.excluded === 12, String(filteredProg.excluded));


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
