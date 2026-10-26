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

/* ---- an impossible `--path` is an error, not an empty scan ----
 * Upstream v1.13.2 (27def86, #1709) made `--path` resolve against the
 * filesystem: before, a path that does not exist selected 0 files and exited 0,
 * so the app drew a preview with no rows and a run that "found nothing". The
 * desktop exposes `--path` in scan mode, so this is the one place where the
 * change has to land as a message — and the CLI's wording is English, so it also
 * has to fall through the hint table.
 */
const ghostPath = await svc.preview({ ...base, mode: "scan", path: "no-such-dir/no-such.go" });
check(
  "a scan path that does not exist fails instead of previewing zero files",
  !ghostPath.ok && Boolean(ghostPath.error) && !Array.isArray(ghostPath.value?.files),
  ghostPath.ok ? `resolved ${ghostPath.value?.files?.length} files` : ""
);
check(
  "and the message names the path that was not found",
  /no-such-dir\/no-such\.go/.test(String(ghostPath.error || "")),
  String(ghostPath.error || "").slice(0, 200)
);
check(
  "with a hint that says what to do about it",
  /扫描路径/.test(String(ghostPath.error || "")),
  String(ghostPath.error || "").slice(-200)
);
/* ---- a run that cannot start is reported once ----
 * A process that could not be started emits `error` *and* `close`, and both used
 * to call the exit callback — so the renderer put up two red "审查失败" toasts and
 * two error lines for one run, and the second one reads like a separate event
 * rather than a repeat. One run reports one outcome, and that outcome has to
 * name what was actually wrong: the repository folder is gone, not the binary.
 */
const ghostRepo = path.join(dir, "no-such-folder");
const exits = [];
await new Promise((resolve) => {
  // The timeout keeps a regression from hanging the smoke run instead of
  // failing it: no exit at all is just as wrong as two.
  const timer = setTimeout(resolve, 3000);
  svc.startRun(
    { repo: ghostRepo, mode: "workspace" },
    () => {},
    (_id, res) => {
      exits.push(res);
      clearTimeout(timer);
      resolve();
    },
    () => {}
  );
});
// Give a second exit the chance to arrive before the count is checked.
await new Promise((r) => setTimeout(r, 400));
check("a run that cannot start reports one outcome", exits.length === 1, `${exits.length} exits: ${JSON.stringify(exits.map((e) => e.error))}`);
check(
  "and names the missing folder, not a missing binary",
  /仓库目录已经不存在/.test(String(exits[0]?.error || "")),
  String(exits[0]?.error || "")
);

/* ---- sessions ---- */
const sessions = await svc.listSessions(dir, 0);
check("listSessions on a fresh repo returns an empty list", sessions.ok && Array.isArray(sessions.value) && sessions.value.length === 0, JSON.stringify(sessions).slice(0, 120));

/* ---- the reviewed commit survives the session round trip ----
 * The app pins a reopened session's code pane to the commit the review actually
 * ran against, and the only source for that is the manifest the CLI persists
 * with the session and hands back from `session list --json`. If the CLI ever
 * stopped handing it back, the app would quietly fall back to the ref name and
 * read a branch that has moved on since — the failure would look like a normal
 * screen. So it is checked against the real CLI, with a session file written
 * the way the CLI writes one.
 */
const encodeRepoPath = (p) => {
  // upstream internal/session/persist.go: strip the volume, trim the leading
  // separators, turn every separator into a dash.
  const vol = /^[a-zA-Z]:/.exec(p)?.[0] || "";
  const rest = p.slice(vol.length).replace(/^[\\/]+/, "").replace(/[\\/]/g, "-");
  return vol.replace(/:/g, "_") + rest || "empty";
};
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-home-"));
const sessionId = "smoke00000000000000000000000000";
const head = await git(["rev-parse", "HEAD"]);
const sessionDir = path.join(home, ".opencodereview", "sessions", encodeRepoPath(dir));
fs.mkdirSync(sessionDir, { recursive: true });
fs.writeFileSync(
  path.join(sessionDir, `${sessionId}.jsonl`),
  JSON.stringify({
    uuid: "smoke-uuid-1",
    type: "session_end",
    sessionId,
    timestamp: new Date().toISOString(),
    files_reviewed: ["b.go"],
    duration_seconds: 12,
    llm_failures: 0,
    run_manifest: {
      schema_version: "ocr.run-manifest/v1",
      run_id: sessionId,
      operation: "review",
      terminal_state: "complete",
      input: {
        mode: "range",
        requested_from: "main",
        requested_head: "feature",
        resolved_base: firstCommit,
        resolved_head: head,
        exact_range: `${firstCommit}..${head}`,
      },
      coverage: { selected: [], completed: [], reused: [], failed: [], waived: [] },
    },
  }) + "\n"
);
// The CLI keeps its sessions under the user's home, so the check points it at a
// throwaway one. HOME alone is not enough on Windows — os.UserHomeDir() prefers
// USERPROFILE there.
const prevHome = process.env.HOME;
const prevProfile = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;
const listed = await svc.listSessions(dir, 0);
process.env.HOME = prevHome;
process.env.USERPROFILE = prevProfile;
const found = (listed.ok && listed.value ? listed.value : []).find((s) => s.session_id === sessionId);
check("a session the CLI wrote is listed back", Boolean(found), JSON.stringify(listed).slice(0, 160));
check("its manifest survives the round trip", Boolean(found && found.run_manifest), JSON.stringify(found && found.run_manifest).slice(0, 120));
check(
  "the commit the review ran against comes back with it",
  Boolean(found && found.run_manifest && found.run_manifest.input && found.run_manifest.input.resolved_head === head),
  JSON.stringify(found && found.run_manifest && found.run_manifest.input)
);

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


/* ---- the failure vocabulary must still match upstream ----
 * `manifest.run_failure.classification` and `coverage.failed[].classification`
 * are two different enums upstream (`internal/session/manifest.go`), and the app
 * maps them to Chinese in `src/lib/format.ts`. The map used to be one flat
 * object whose comment described the run-level list as the per-file one — the
 * two vocabularies read as a single enum. Every value in it translates today,
 * so nothing ever looked wrong; the failure would only appear the day upstream
 * added a class, as a raw English word on a failure badge.
 *
 * The lists below are transcribed from upstream at `v1.13.3`
 * (`RunFailureClass` / `FailureClass` constant blocks). If upstream grows a
 * class, this check fails and the fix is to add the label — not to delete the
 * assertion.
 */
const UPSTREAM_RUN_CLASSES = ["input", "configuration", "timeout", "cancelled", "budget", "internal", "unknown"];
const UPSTREAM_ITEM_CLASSES = ["provider", "timeout", "cancelled", "configuration", "input", "budget", "panic", "unknown"];

const formatTs = fs.readFileSync(path.join(ROOT, "src/lib/format.ts"), "utf8");
// The maps are literals with comments and trailing commas, so evaluate the body
// rather than parsing it as JSON.
const labelMap = (name) => {
  const body = new RegExp(`export const ${name}: Record<string, string> = \\{([\\s\\S]*?)\\n\\};`).exec(formatTs);
  if (!body) return null;
  try {
    return new Function(`return {${body[1].replace(/\/\/[^\n]*/g, "")}}`)();
  } catch (_) {
    return null;
  }
};
const runLabels = labelMap("RUN_FAILURE_LABEL");
const itemLabels = labelMap("ITEM_FAILURE_LABEL");
const sorted = (a) => [...a].sort().join(",");
const chinese = (v) => typeof v === "string" && /[\u4e00-\u9fa5]/.test(v) && !/[A-Za-z]/.test(v);

check("both failure vocabularies are declared separately", Boolean(runLabels && itemLabels));
check(
  "the run-level map is exactly upstream's RunFailureClass",
  Boolean(runLabels) && sorted(Object.keys(runLabels)) === sorted(UPSTREAM_RUN_CLASSES),
  runLabels ? Object.keys(runLabels).join(",") : "missing"
);
check(
  "the per-file map is exactly upstream's FailureClass",
  Boolean(itemLabels) && sorted(Object.keys(itemLabels)) === sorted(UPSTREAM_ITEM_CLASSES),
  itemLabels ? Object.keys(itemLabels).join(",") : "missing"
);
// "Translated" is the whole point: a value missing a label falls through to the
// raw English enum, which is what a reader of a failure message must not see.
const untranslated = (map) =>
  Object.entries(map || {})
    .filter(([k, v]) => v === k || !chinese(v))
    .map(([k, v]) => `${k}=${v}`);
check(
  "every run-level class has a Chinese label",
  Boolean(runLabels) && untranslated(runLabels).length === 0,
  untranslated(runLabels).join(" ")
);
check(
  "every per-file class has a Chinese label",
  Boolean(itemLabels) && untranslated(itemLabels).length === 0,
  untranslated(itemLabels).join(" ")
);
// A class this build has never heard of must surface as itself, not be folded
// into 原因不明 — an unknown word is the one signal that upstream moved. The
// two vocabularies are looked up separately, so each has to keep that
// behaviour on its own.
check(
  "an unrecognised class falls back to itself rather than to a guess",
  /return RUN_FAILURE_LABEL\[c\] \|\| c;/.test(formatTs) && /return ITEM_FAILURE_LABEL\[c\] \|\| c;/.test(formatTs),
  "the two label lookups no longer return the raw value for an unknown class"
);
// The two enums are not interchangeable, and the one class they do not share
// is where a merged table shows: provider and panic are per-file only,
// internal is run-level only. A run-level field must never be translated with
// the per-file vocabulary.
check(
  "the run-level and per-file vocabularies are looked up separately",
  !/export const FAILURE_LABEL\b/.test(formatTs),
  "the merged lookup is back, so a run-level class can be translated with the per-file word"
);

/* ---- the registry table's shape, as the CLI prints it ----
 * Captured from `ocr llm providers` on v1.13.3: a blank line, a title, the
 * `NAME / PROTOCOL / BASE URL` header, a rule under it, then one row per service
 * (with `\r\n` on Windows). Both non-name rows have the table's column layout, so
 * a looser pattern folds them into the list and the app then looks up a service
 * called `NAME` or `----`, misses, and picks the wrong config section for every
 * real name. `matched` is what tells "the table changed shape" from "the table is
 * empty" — the two used to be the same `null`.
 */
const PROVIDER_TABLE = [
  "",
  "Built-in providers:",
  "  NAME                 PROTOCOL           BASE URL",
  "  ----                 --------           --------",
  "  anthropic            anthropic          https://api.anthropic.com",
  "  bedrock              anthropic-bedrock  ",
  "  deepseek             openai             https://api.deepseek.com",
  "",
].join("\r\n");
const table = svc.parseProviderNames(PROVIDER_TABLE);
check(
  "the header and the rule under it are not service names",
  !table.names.includes("NAME") && !table.names.some((name) => /^-+$/.test(name)),
  JSON.stringify(table)
);
check(
  "and every real row survives",
  table.names.join(",") === "anthropic,bedrock,deepseek",
  JSON.stringify(table)
);
check(
  "a table whose shape changed is distinguishable from an empty one",
  svc.parseProviderNames("no table here").matched === 0 && table.matched === 4,
  `${JSON.stringify(svc.parseProviderNames("no table here"))} | ${table.matched}`
);
// ...and the real CLI's answer, end to end: this is the list the view judges
// built-in names by.
const registry = await svc.presetNames();
check(
  "the CLI's own built-in service list reads back",
  registry.ok && registry.names.includes("deepseek") && registry.matched > 0 && !registry.names.includes("NAME"),
  `${registry.ok} | ${registry.error} | ${registry.names.slice(0, 4).join(",")}`
);

/* ---- one table, two questions ----
 * The settings page lists name / protocol / base URL; the readiness view only
 * needs the names. Those used to be two parsers over the same bytes — the page's
 * stricter one (lowercase names, and no `matched` check) would have disagreed
 * with this one the first time the CLI widened a column or shipped an
 * underscored service name. Same function now, so assert they cannot drift.
 */
const parsedTable = svc.parseProviderTable(PROVIDER_TABLE);
check(
  "the provider list and the registry read the same rows",
  parsedTable.rows.map((row) => row.name).join(",") === table.names.join(",") &&
    parsedTable.matched === table.matched,
  `${JSON.stringify(parsedTable.rows)} | ${parsedTable.matched} vs ${table.matched}`
);
check(
  "and each row keeps the columns the settings page shows",
  parsedTable.rows[0].protocol === "anthropic" &&
    parsedTable.rows[0].url === "https://api.anthropic.com" &&
    parsedTable.rows[1].url === "",
  JSON.stringify(parsedTable.rows.slice(0, 2))
);
check(
  "a table whose shape changed yields no rows for the page either",
  svc.parseProviderTable("no table here").rows.length === 0 &&
    svc.parseProviderTable("no table here").matched === 0
);

/* ---- a failed read is reported, not re-spawned on every ask ----
 * The settings page asks for the built-in list beside every readiness view and on
 * every refresh, so an uncached failure spawned one doomed process per
 * interaction: a missing or broken binary turned a single broken read into a
 * stream of them. The failure is remembered for a short window, and the 刷新
 * button (the thing the hint beside the badge tells the user to press) clears it
 * — a cached failure that refresh could not clear would make that hint a lie.
 *
 * `runner` and `now` exist for this check: no clock to wait on, no binary to
 * break on purpose.
 */
const failingRunner = { code: 1, stdout: "", stderr: "Error: provider registry unavailable" };
let spawns = 0;
let clock = 0;
const runner = async () => {
  spawns += 1;
  return failingRunner;
};
const now = () => clock;
const readWith = (opts = {}) => svc.providerTable({ runner, now, ...opts });

svc.resetPresetCache();
const firstFail = await readWith({ refresh: true });
check(
  "a failed read says why instead of looking empty",
  !firstFail.ok && /provider registry unavailable/.test(firstFail.error) && firstFail.rows.length === 0,
  JSON.stringify(firstFail)
);
const secondFail = await readWith();
check(
  "and the next ask inside the window does not spawn again",
  spawns === 1 && !secondFail.ok && secondFail.cached === true,
  `${spawns} spawn(s) | ${JSON.stringify(secondFail)}`
);
const successRunner = async () => {
  spawns += 1;
  return { code: 0, stdout: PROVIDER_TABLE, stderr: "" };
};
const refreshedNow = await readWith({ refresh: true, runner: successRunner });
check(
  "an explicit refresh retries inside the window instead of replaying the failure",
  refreshedNow.ok && refreshedNow.rows.length === 3 && refreshedNow.matched === 4 && refreshedNow.cached !== true && spawns === 2,
  `${spawns} spawn(s) | ${JSON.stringify(refreshedNow).slice(0, 160)}`
);
check(
  "a success is then reused without another spawn",
  (await readWith()).ok === true && spawns === 2,
  `${spawns} spawn(s)`
);
// The window itself, on a failure read with no refresh in between: it expires on
// its own, so a transient failure (a spawn racing an update) does not need the
// user to press anything.
svc.resetPresetCache();
spawns = 0;
clock = 0;
await readWith({ refresh: true });
const withinWindow = await readWith();
clock += svc.PRESET_FAILURE_TTL_MS;
const afterWindow = await readWith();
check(
  "the window is a delay, not a lock: after it the CLI is asked again",
  spawns === 2 && withinWindow.cached === true && !afterWindow.ok && afterWindow.cached !== true,
  `${spawns} spawn(s) | ${JSON.stringify(afterWindow)}`
);
// Back to the real CLI: a cached failure must not outlive the failure.
const afterFailure = await svc.presetNames({ refresh: true });
check(
  "the real list still reads back after a failed one was cached",
  afterFailure.ok && !afterFailure.cached && afterFailure.names.includes("deepseek"),
  `${afterFailure.ok} | ${afterFailure.error} | ${afterFailure.names.slice(0, 3).join(",")}`
);
const realTable = await svc.providerTable();
check(
  "and it carries the columns the settings page renders",
  realTable.ok && realTable.rows.every((row) => row.name && row.protocol !== undefined),
  JSON.stringify(realTable.rows.slice(0, 2))
);

/* ---- config / info ---- */
const cfg = svc.readConfigView();
check("readConfigView returns a usable shape", cfg && typeof cfg.path === "string" && typeof cfg.ready === "boolean" && typeof cfg.providers === "object", JSON.stringify(cfg)?.slice(0, 140));

// Readiness is about a credential, not a URL. These cases run against a
// throwaway config path and an explicit environment, so the result does not
// depend on the machine's own ~/.opencodereview or exported keys.
const readiness = (config, env = {}, extra = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-config-"));
  const file = path.join(dir, "config.json");
  if (config) fs.writeFileSync(file, JSON.stringify(config));
  // `extra` carries the built-in registry (`presetNames`): the view is a pure
  // function of the file plus that list, and the list is the CLI's own.
  const view = svc.readConfigView({ configPath: file, env, ...extra });
  fs.rmSync(dir, { recursive: true, force: true });
  return view;
};
// The gap list is the machine-readable copy of the sentence, so most assertions
// below can name the gaps once and read the sentence separately.
const gapOf = (view) => view.missing.join(",");
const gateway = { url: "https://llm.corp.internal/v1", protocol: "openai", model: "qwen3-max" };
const gatewayConfig = (entry) => ({ provider: "corp-gateway", custom_providers: { "corp-gateway": entry } });

const noKey = readiness(gatewayConfig(gateway));
check(
  "a custom provider URL alone is not ready",
  !noKey.ready && noKey.missing.includes("credential"),
  JSON.stringify(noKey)
);
check("the missing Key is named for a selected provider", /缺少 API Key/.test(noKey.blockedReason), noKey.blockedReason);

check("a saved provider Key makes it ready", readiness(gatewayConfig({ ...gateway, api_key: "sk-test" })).ready);
check("a credential command makes it ready", readiness(gatewayConfig({ ...gateway, auth_token_cmd: "pass show llm" })).ready);
check(
  "a derived hasKey field is not mistaken for a credential",
  !readiness(gatewayConfig({ ...gateway, hasKey: true })).ready
);

const llm = { url: "https://llm.corp.internal/v1", protocol: "openai", model: "qwen3-max" };
check("an llm section with a token is ready", readiness({ llm: { ...llm, auth_token: "t" } }).ready);
const urlOnly = readiness({ llm }, { OCR_LLM_URL: llm.url, ANTHROPIC_BASE_URL: "https://api.anthropic.com" });
check(
  "endpoint env vars alone are not ready",
  !urlOnly.ready && urlOnly.missing.includes("credential"),
  JSON.stringify(urlOnly)
);
check(
  "endpoint env vars are not counted as credentials",
  urlOnly.envCredentials.length === 0 && urlOnly.envSources.length === 2,
  JSON.stringify({ sources: urlOnly.envSources, credentials: urlOnly.envCredentials })
);
check("a URL-only environment names the missing Key", /缺少 API Key/.test(urlOnly.blockedReason), urlOnly.blockedReason);
// A credential in the environment is a Key, not an endpoint. Upstream returns a
// Claude-Code endpoint only when base URL, token *and* model are all set
// (internal/llm/resolver.go, tryCCEnv), so a lone ANTHROPIC_API_KEY used to turn
// the badge green for a review that could only fail with "no valid LLM endpoint
// configured".
const envTokenOnly = readiness({}, { ANTHROPIC_API_KEY: "k" });
check(
  "a lone credential env var is not a complete environment",
  !envTokenOnly.ready && gapOf(envTokenOnly) === "baseUrl,model",
  `${gapOf(envTokenOnly)} | ${envTokenOnly.blockedReason}`
);
const envComplete = readiness(
  {},
  {
    ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    ANTHROPIC_AUTH_TOKEN: "t",
    ANTHROPIC_MODEL: "claude-sonnet-5",
  }
);
check(
  "a complete ANTHROPIC_* environment is ready",
  envComplete.ready && envComplete.missing.length === 0,
  `${gapOf(envComplete)} | ${envComplete.blockedReason}`
);
const empty = readiness({});
check(
  "an empty config names endpoint, model and credential",
  ["baseUrl", "model", "credential"].every((key) => empty.missing.includes(key)),
  JSON.stringify(empty.missing)
);

/* ---- the sentence and the gap list must agree ----
 * `missing` is the machine-readable copy of the sentence shown next to the
 * readiness badge, and the two used to be computed by separate code: the list
 * looked at the `llm` section only, while the sentence told *any* selected
 * provider that it lacked an API Key. A custom provider with an empty entry
 * therefore offered one gap to fill, and it was the wrong one. The four
 * endpoint/model combinations are asserted value by value, so the failure lands
 * on the field that moved rather than on "the view changed".
 */
const onlyEndpoint = readiness({ llm: { url: llm.url } });
check(
  "an endpoint without a model names the model",
  gapOf(onlyEndpoint) === "model,credential" && /缺少模型名/.test(onlyEndpoint.blockedReason),
  `${gapOf(onlyEndpoint)} | ${onlyEndpoint.blockedReason}`
);
const onlyModel = readiness({ llm: { model: "qwen3-max" } });
check(
  "a model without an endpoint names the endpoint",
  gapOf(onlyModel) === "baseUrl,credential" && /缺少服务端点/.test(onlyModel.blockedReason),
  `${gapOf(onlyModel)} | ${onlyModel.blockedReason}`
);
const bothLlm = readiness({ llm });
check(
  "endpoint and model together leave only the Key",
  gapOf(bothLlm) === "credential" &&
    /缺少 API Key/.test(bothLlm.blockedReason) &&
    !/缺少服务端点|缺少模型名/.test(bothLlm.blockedReason),
  `${gapOf(bothLlm)} | ${bothLlm.blockedReason}`
);
const nothing = readiness({});
check(
  "nothing at all configured names all three, and blames no single one",
  gapOf(nothing) === "baseUrl,model,credential" && /未选择模型服务/.test(nothing.blockedReason),
  `${gapOf(nothing)} | ${nothing.blockedReason}`
);
// A Key that is already saved is not a gap. The list used to append "credential"
// unconditionally for an `llm` section, so a saved token was asked for twice.
const keyOnlyLlm = readiness({ llm: { auth_token: "t" } });
check(
  "a Key that is already saved is not listed as missing",
  gapOf(keyOnlyLlm) === "baseUrl,model" && !/API Key/.test(keyOnlyLlm.missing.join(",")),
  `${gapOf(keyOnlyLlm)} | ${keyOnlyLlm.blockedReason}`
);
// A provider entry carries its own url and model — the case the old code could
// not see at all, because it only ever read `raw.llm` for those two answers.
const bareProvider = readiness({ provider: "corp-gateway", custom_providers: { "corp-gateway": {} } });
check(
  "a selected provider with an empty entry names its endpoint and model too",
  gapOf(bareProvider) === "baseUrl,model,credential" && /缺少服务端点/.test(bareProvider.blockedReason),
  `${gapOf(bareProvider)} | ${bareProvider.blockedReason}`
);
const providerModelOnly = readiness(gatewayConfig({ model: "qwen3-max" }));
check(
  "a provider that carries a model is not told the model is missing",
  gapOf(providerModelOnly) === "baseUrl,credential" && /缺少服务端点/.test(providerModelOnly.blockedReason),
  `${gapOf(providerModelOnly)} | ${providerModelOnly.blockedReason}`
);
const providerUrlOnly = readiness(gatewayConfig({ url: gateway.url }));
check(
  "a provider that carries a URL is not told the URL is missing",
  gapOf(providerUrlOnly) === "model,credential" && /缺少模型名/.test(providerUrlOnly.blockedReason),
  `${gapOf(providerUrlOnly)} | ${providerUrlOnly.blockedReason}`
);

/* ---- the model is read from a different key in each shape ----
 * The resolver reads the model from two different places (internal/llm/resolver.go
 * @ v1.13.3):
 * - provider form (`tryProviderConfig`): the top-level `model` is read, and the
 *   entry's own `model` overrides it;
 * - legacy form (`tryLegacyLlmConfig`): only `llm.model` is read — the top-level
 *   `model` is not read at all.
 * The environment fills the model only in the legacy form: the provider path
 * never consults `OCR_LLM_MODEL`, and a provider without a model is a hard error
 * ("provider %q has no model configured"), not something the next resolution
 * strategy completes. Reading the wrong key is how a config the CLI refuses was
 * called ready — the badge said "已就绪" and the run failed on the first request.
 */
const providerTopModel = readiness({
  provider: "corp-gateway",
  custom_providers: { "corp-gateway": { url: gateway.url, api_key: "sk-test" } },
  model: "qwen3-max",
});
check(
  "a top-level model is the fallback for a selected provider",
  gapOf(providerTopModel) === "" && providerTopModel.model === "qwen3-max",
  `${gapOf(providerTopModel)} | ${providerTopModel.model}`
);
const providerEntryModel = readiness({
  provider: "corp-gateway",
  custom_providers: {
    "corp-gateway": { url: gateway.url, api_key: "sk-test", model: "entry-model" },
  },
  model: "top-level-model",
});
check(
  "and the entry's own model wins over it",
  gapOf(providerEntryModel) === "" && providerEntryModel.model === "entry-model",
  `${gapOf(providerEntryModel)} | ${providerEntryModel.model}`
);
// `ocr config set model X` without a provider writes exactly this key — and the
// legacy path never reads it. Counting it filled the gap list for a config the
// CLI answers with "no valid LLM endpoint configured".
const legacyTopModel = readiness({ model: "qwen3-max", llm: { url: llm.url, auth_token: "t" } });
check(
  "a top-level model does not stand in for llm.model",
  gapOf(legacyTopModel) === "model" && /缺少模型名/.test(legacyTopModel.blockedReason),
  `${gapOf(legacyTopModel)} | ${legacyTopModel.blockedReason}`
);
check(
  "and the view does not offer a model the CLI would not send",
  legacyTopModel.model === "",
  legacyTopModel.model
);
const providerEnvModel = readiness(
  {
    provider: "corp-gateway",
    custom_providers: { "corp-gateway": { url: gateway.url, api_key: "sk-test" } },
  },
  { OCR_LLM_MODEL: "qwen3-max" }
);
check(
  "an env model does not complete a selected provider",
  gapOf(providerEnvModel) === "model",
  `${gapOf(providerEnvModel)} | ${providerEnvModel.blockedReason}`
);
const providerLlmModel = readiness({
  provider: "corp-gateway",
  custom_providers: { "corp-gateway": { url: gateway.url, api_key: "sk-test" } },
  llm: { model: "qwen3-max" },
});
check(
  "and neither does the llm block next to a selected provider",
  gapOf(providerLlmModel) === "model",
  `${gapOf(providerLlmModel)} | ${providerLlmModel.blockedReason}`
);

/* ---- a built-in service needs no URL in the file ----
 * `providers.<name>` only accepts a preset name (config set routes every other
 * name into custom_providers), and the resolver takes the URL from the preset
 * registry unless the entry overrides it — so the shape this app writes for a
 * built-in service (a Key and a model, no URL) is complete, and calling it
 * "missing the endpoint" would disable the run button on a working config.
 */
const presetReady = readiness({
  provider: "deepseek",
  providers: { deepseek: { api_key: "sk-test", model: "deepseek-chat" } },
});
check(
  "a preset entry with a Key and a model is ready without a URL",
  presetReady.ready && presetReady.missing.length === 0,
  `${gapOf(presetReady)} | ${presetReady.blockedReason}`
);
const presetNoKey = readiness({
  provider: "deepseek",
  providers: { deepseek: { model: "deepseek-chat" } },
});
check(
  "the same preset entry without a Key still names the Key",
  gapOf(presetNoKey) === "credential",
  `${gapOf(presetNoKey)} | ${presetNoKey.blockedReason}`
);

/* ---- "in the providers section" is not "a service the CLI knows" ----
 * The resolver looks the name up in its own registry first (`llm.LookupProvider`,
 * case insensitive) and, when that fails, goes to `custom_providers` and errors
 * out:
 *   provider %q is set but not configured in custom_providers section
 * So a name hand-edited into `providers` is a config the CLI refuses whole — not
 * a preset entry that merely lacks a URL. Naming `baseUrl` there sends the user
 * to fill in the one field that cannot change the outcome, which is why the gap
 * has its own key.
 */
const PRESETS = ["anthropic", "deepseek", "dashscope"];
const withPresets = (config, env = {}) => readiness(config, env, { presetNames: PRESETS });
const handEdited = withPresets({
  provider: "corp-gateway",
  providers: { "corp-gateway": { api_key: "sk-test", model: "qwen3-max" } },
});
check(
  "a name the CLI does not know is not read as a preset entry",
  !handEdited.ready && handEdited.rejectedProvider === "corp-gateway",
  `${gapOf(handEdited)} | ${handEdited.blockedReason}`
);
check(
  "and the gap it names is the name, not a field under it",
  gapOf(handEdited) === "provider" && !handEdited.missing.includes("baseUrl"),
  gapOf(handEdited)
);
check(
  "the sentence says the config is refused, not that a field is empty",
  /custom_providers/.test(handEdited.blockedReason) && !/缺少服务端点/.test(handEdited.blockedReason),
  handEdited.blockedReason
);
// A URL under the rejected name must not launder it into a working entry: the
// CLI never opens that section for a name it does not know.
const handEditedWithUrl = withPresets({
  provider: "corp-gateway",
  providers: { "corp-gateway": { ...gateway, api_key: "sk-test" } },
});
check(
  "a URL under a rejected name does not make it ready either",
  !handEditedWithUrl.ready && handEditedWithUrl.missing.includes("provider"),
  `${gapOf(handEditedWithUrl)} | ${handEditedWithUrl.blockedReason}`
);
// The registry is case insensitive upstream, so `DeepSeek` is still the preset.
const presetCase = withPresets({
  provider: "DeepSeek",
  providers: { DeepSeek: { api_key: "sk-test", model: "deepseek-chat" } },
});
check(
  "the registry is case insensitive, so DeepSeek is still a preset",
  presetCase.ready && !presetCase.rejectedProvider,
  `${gapOf(presetCase)} | ${presetCase.blockedReason}`
);
// Without the list nothing can be said about the name, and assuming "not built
// in" would block every working preset config — so the older reading stays.
const noRegistry = readiness({
  provider: "deepseek",
  providers: { deepseek: { api_key: "sk-test", model: "deepseek-chat" } },
});
check(
  "an unreadable registry falls back instead of rejecting every entry",
  noRegistry.ready && !noRegistry.rejectedProvider,
  `${gapOf(noRegistry)} | ${noRegistry.blockedReason}`
);
// A name that lives in `custom_providers` is the entry the CLI actually reads
// once the registry lookup fails, so it is not a rejected name.
const customSameName = withPresets({
  provider: "corp-gateway",
  custom_providers: { "corp-gateway": { ...gateway, api_key: "sk-test" } },
});
check(
  "a name that lives in custom_providers is not rejected",
  customSameName.ready && !customSameName.rejectedProvider,
  `${gapOf(customSameName)} | ${customSameName.blockedReason}`
);
// The mirror case: a stray entry of the same name left in `providers`. The
// resolver picks the section by the *name*, so for this name it reads
// `custom_providers` and never opens the `providers` one — the name is not
// rejected, and the fields that count are the custom entry's.
const bothSections = withPresets({
  provider: "corp-gateway",
  providers: { "corp-gateway": { model: "wrong-model" } },
  custom_providers: { "corp-gateway": { ...gateway, api_key: "sk-test" } },
});
check(
  "a stray entry in providers does not reject a name that custom_providers configures",
  bothSections.ready && !bothSections.rejectedProvider,
  `${gapOf(bothSections)} | ${bothSections.blockedReason}`
);
check(
  "and the fields counted are the custom entry's, not the stray one's",
  bothSections.model === gateway.model,
  `model=${bothSections.model}`
);
// ...and the stray entry cannot supply what the custom entry lacks.
const shadowedCustom = withPresets({
  provider: "corp-gateway",
  providers: { "corp-gateway": { ...gateway, api_key: "sk-test" } },
  custom_providers: { "corp-gateway": {} },
});
check(
  "a stray providers entry does not lend its endpoint or Key to a custom name",
  gapOf(shadowedCustom) === "baseUrl,model,credential",
  `${gapOf(shadowedCustom)} | ${shadowedCustom.blockedReason}`
);
// A selected name with no entry anywhere is rejected by the same rule: the
// resolver looks it up in `custom_providers` and stops with
//   provider %q is set but not configured in custom_providers section
// so naming the endpoint is naming a field that cannot fix the config.
const nameOnly = withPresets({ provider: "corp-gateway" });
check(
  "a selected name that lives in neither section is the gap, not a field under it",
  !nameOnly.ready && gapOf(nameOnly) === "provider" && /custom_providers/.test(nameOnly.blockedReason),
  `${gapOf(nameOnly)} | ${nameOnly.blockedReason}`
);
/* ---- a built-in name whose entry sits in the wrong section ----
 * `tryProviderConfig` picks the section by the *name* and then stops if the entry
 * is not in that one — it never tries the other:
 *   provider %q is set but not configured in providers section
 * The desktop answered this shape with `missing: baseUrl,model,credential`, i.e.
 * it named three fields inside an entry the resolver will never open: filling
 * them in changes nothing. The config is refused whole, so `missing` is empty and
 * the refusal itself is the machine-readable answer.
 */
const presetOnlyInCustom = withPresets({
  provider: "deepseek",
  custom_providers: { deepseek: { ...gateway, api_key: "sk-test" } },
});
check(
  "a built-in name configured only in custom_providers is refused, not ready",
  !presetOnlyInCustom.ready && presetOnlyInCustom.rejected === "provider-not-in-section",
  `${presetOnlyInCustom.rejected} | ${gapOf(presetOnlyInCustom)} | ${presetOnlyInCustom.blockedReason}`
);
check(
  "and nothing is named as missing, because no field would fix it",
  gapOf(presetOnlyInCustom) === "",
  gapOf(presetOnlyInCustom)
);
check(
  "the sentence says the config is refused and which section the entry is in",
  /providers 段/.test(presetOnlyInCustom.blockedReason) &&
    /拒绝/.test(presetOnlyInCustom.blockedReason) &&
    !/缺少/.test(presetOnlyInCustom.blockedReason),
  presetOnlyInCustom.blockedReason
);
// The two shapes that must keep working: the same entry under a name the CLI
// does not know, and a built-in name with its entry in `providers`.
check(
  "a name the CLI does not know with a custom_providers entry stays ready",
  customSameName.ready && customSameName.rejected === "",
  `${customSameName.rejected} | ${gapOf(customSameName)}`
);
check(
  "a built-in name with its entry in providers stays ready",
  presetReady.ready && presetReady.rejected === "",
  `${presetReady.rejected} | ${gapOf(presetReady)}`
);
// Whether the registry could be read at all is a third state, and the settings
// page shows it: every judgement above about a built-in name silently took the
// older, lenient branch when it is missing.
check(
  "a registry that was read is reported as read",
  presetCase.presetRegistry === "ok" && presetCase.presetRegistryError === "",
  `${presetCase.presetRegistry} | ${presetCase.presetRegistryError}`
);
check(
  "a registry that could not be read is reported, with a reason",
  noRegistry.presetRegistry === "unavailable" && Boolean(noRegistry.presetRegistryError),
  `${noRegistry.presetRegistry} | ${noRegistry.presetRegistryError}`
);

// Without the registry this branch cannot be taken at all: "the CLI does not
// know this name" is a fact only the CLI can tell, and guessing it would reject
// every hand-edited `providers` entry that works.
const looseHandEdit = readiness({
  provider: "corp-gateway",
  providers: { "corp-gateway": { api_key: "sk-test", model: "qwen3-max" } },
});
check(
  "an unreadable registry does not reject a hand-edited providers entry either",
  looseHandEdit.ready && !looseHandEdit.rejectedProvider,
  `${gapOf(looseHandEdit)} | ${looseHandEdit.blockedReason}`
);

/* ---- the provider shape does not read the `OCR_LLM_*` overrides ----
 * The provider path stops at the selected entry: the endpoint comes from the
 * entry or from the built-in service's own table, and the `OCR_LLM_*` variables
 * are the legacy path's business. Counting them kept the top bar green for a
 * provider whose entry had no URL, and the run then failed with `no valid LLM
 * endpoint configured` after it had already started.
 */
const providerEntryNoUrl = {
  provider: "corp-gateway",
  custom_providers: { "corp-gateway": { model: "qwen3-max", api_key: "sk-test" } },
};
const providerEnvUrl = readiness(providerEntryNoUrl, { OCR_LLM_URL: gateway.url });
check(
  "an OCR_LLM_URL does not stand in for a selected provider's endpoint",
  !providerEnvUrl.ready && providerEnvUrl.missing.includes("baseUrl"),
  `${gapOf(providerEnvUrl)} | ${providerEnvUrl.blockedReason}`
);
const providerAnthropicBase = readiness(providerEntryNoUrl, {
  ANTHROPIC_BASE_URL: "https://api.anthropic.com",
});
check(
  "and neither does ANTHROPIC_BASE_URL",
  providerAnthropicBase.missing.includes("baseUrl"),
  `${gapOf(providerAnthropicBase)} | ${providerAnthropicBase.blockedReason}`
);
const providerEnvToken = readiness(
  { provider: "corp-gateway", custom_providers: { "corp-gateway": { url: gateway.url, model: "qwen3-max" } } },
  { OCR_LLM_TOKEN: "t" }
);
check(
  "an OCR_LLM_TOKEN does not stand in for a selected provider's Key",
  !providerEnvToken.ready && providerEnvToken.missing.includes("credential"),
  `${gapOf(providerEnvToken)} | ${providerEnvToken.blockedReason}`
);
/* ---- where the provider shape reads a Key from the environment ----
 * `tryProviderConfig` reads the Key from the entry first and, when the entry has
 * neither `api_key` nor `api_key_cmd`, from the *built-in service's own*
 * variable — `preset.EnvVar`, and only for a preset. A custom provider has no
 * environment fallback at all, and one preset's variable is not another
 * preset's Key. Counting any ANTHROPIC_* for any selected name kept the badge
 * green for a gateway with no Key of its own; the run then failed with
 * "provider %q has no api_key or api_key_cmd configured and no environment
 * variable fallback found".
 */
const presetOwnKey = withPresets(
  { provider: "anthropic", providers: { anthropic: { model: "claude-sonnet-5" } } },
  { ANTHROPIC_API_KEY: "k" }
);
check(
  "a built-in service reads its own variable as the Key",
  presetOwnKey.ready && presetOwnKey.envCredentials.includes("ANTHROPIC_API_KEY"),
  `${gapOf(presetOwnKey)} | ${JSON.stringify(presetOwnKey.envCredentials)} | ${presetOwnKey.blockedReason}`
);
const customEnvKey = withPresets(
  { provider: "corp-gateway", custom_providers: { "corp-gateway": { url: gateway.url, model: "qwen3-max" } } },
  { ANTHROPIC_API_KEY: "k" }
);
check(
  "a custom provider has no environment fallback, so that variable is not its Key",
  !customEnvKey.ready && gapOf(customEnvKey) === "credential" && customEnvKey.envCredentials.length === 0,
  `${gapOf(customEnvKey)} | ${JSON.stringify(customEnvKey.envCredentials)} | ${customEnvKey.blockedReason}`
);
const customAuthToken = withPresets(
  { provider: "corp-gateway", custom_providers: { "corp-gateway": { url: gateway.url, model: "qwen3-max" } } },
  { ANTHROPIC_AUTH_TOKEN: "t" }
);
check(
  "the Claude-Code token is a legacy-shape variable and does not count for a provider",
  !customAuthToken.ready && gapOf(customAuthToken) === "credential" && customAuthToken.envSources.length === 0,
  `${gapOf(customAuthToken)} | ${JSON.stringify(customAuthToken.envSources)} | ${customAuthToken.blockedReason}`
);
const otherPresetKey = withPresets(
  { provider: "deepseek", providers: { deepseek: { model: "deepseek-chat" } } },
  { ANTHROPIC_API_KEY: "k" }
);
check(
  "one preset's variable is not another preset's Key",
  !otherPresetKey.ready && gapOf(otherPresetKey) === "credential",
  `${gapOf(otherPresetKey)} | ${JSON.stringify(otherPresetKey.envCredentials)} | ${otherPresetKey.blockedReason}`
);
// Without the registry nothing can be said about which variable belongs to the
// selected name, and assuming "none" would block a config that works — so the
// older, lenient reading stays.
const customNoRegistry = readiness(
  { provider: "corp-gateway", custom_providers: { "corp-gateway": { url: gateway.url, model: "qwen3-max" } } },
  { ANTHROPIC_API_KEY: "k" }
);
check(
  "an unreadable registry keeps the lenient reading instead of inventing a missing Key",
  customNoRegistry.ready && customNoRegistry.envCredentials.includes("ANTHROPIC_API_KEY"),
  `${gapOf(customNoRegistry)} | ${JSON.stringify(customNoRegistry.envCredentials)} | ${customNoRegistry.blockedReason}`
);
// The lenient fallback above is about *which* built-in service owns a variable,
// not about which shape reads it: the provider path never reads the Claude-Code
// token, so not knowing the registry cannot make it count.
const customNoRegistryToken = readiness(
  { provider: "corp-gateway", custom_providers: { "corp-gateway": { url: gateway.url, model: "qwen3-max" } } },
  { ANTHROPIC_AUTH_TOKEN: "t" }
);
check(
  "the Claude-Code token stays out even when the registry is unreadable",
  !customNoRegistryToken.ready && gapOf(customNoRegistryToken) === "credential",
  `${gapOf(customNoRegistryToken)} | ${JSON.stringify(customNoRegistryToken.envSources)} | ${customNoRegistryToken.blockedReason}`
);
// The legacy shape keeps reading them: with no `provider` set, `OCR_LLM_*` is the
// CLI's documented way to run without a config file.
const legacyEnvUrl = readiness({}, { OCR_LLM_URL: llm.url, OCR_LLM_TOKEN: "t", OCR_LLM_MODEL: "qwen3-max" });
check(
  "the legacy shape still reads the OCR_LLM_* overrides",
  legacyEnvUrl.ready,
  `${gapOf(legacyEnvUrl)} | ${legacyEnvUrl.blockedReason}`
);
// The `owner` column narrows *which* preset a variable counts for in the
// provider shape; it is not a filter in the legacy shape, where
// `ANTHROPIC_API_KEY` has always been a Key. Dropping the variable from the
// legacy reading would have blocked a documented way to run without a config
// file, so the lenient direction is pinned here.
const legacyAnthropicKey = withPresets({ llm: { ...llm } }, { ANTHROPIC_API_KEY: "k" });
check(
  "the legacy shape still counts a preset's own variable as the Key",
  legacyAnthropicKey.ready && legacyAnthropicKey.envCredentials.includes("ANTHROPIC_API_KEY"),
  `${gapOf(legacyAnthropicKey)} | ${JSON.stringify(legacyAnthropicKey.envCredentials)} | ${legacyAnthropicKey.blockedReason}`
);

/* ---- the `llm` block is not read once a provider is selected ----
 * Upstream stops at the provider section as soon as `provider` is set, so an
 * `llm.auth_token` saved next to a selected service never reaches the request:
 * a custom provider has to carry its own Key. Counting that token emptied the
 * gap list while the badge said "not ready", and the sentence then had no gap to
 * name.
 */
const r1 = readiness({
  provider: "corp-gateway",
  custom_providers: { "corp-gateway": gateway },
  llm: { url: gateway.url, model: gateway.model, auth_token: "t" },
});
check(
  "a token in the llm block does not stand in for a selected service's Key",
  !r1.ready && gapOf(r1) === "credential",
  `${gapOf(r1)} | ${r1.blockedReason}`
);

/* ---- the saved Key is found by the name the CLI would use ----
 * `ocr` resolves a built-in name through its own registry, which is case
 * insensitive (`llm.LookupProvider`), so `DeepSeek` in the file and `deepseek`
 * from the form are the same service. `savedKeyFor` matched the name as a raw
 * string, so it missed a Key the CLI was already using and the settings page
 * said "还没有已保存的 Key" for a config that `ocr review` runs fine on. A custom
 * name is a plain map key upstream, so it keeps the exact-string rule: answering
 * for another spelling would hand out a Key for an entry the CLI never opens.
 */
const savedKey = (config, name, url = "", presetUrl = "") => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-saved-key-"));
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, JSON.stringify(config));
  try {
    return svc.savedKeyFor(name, url, file, presetUrl);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
check(
  "a saved Key is reused when the config spells the built-in name differently",
  savedKey({ providers: { DeepSeek: { api_key: "sk-upper" } } }, "deepseek") === "sk-upper"
);
check(
  "and the other way round, because the registry folds case",
  savedKey({ providers: { deepseek: { api_key: "sk-lower" } } }, "DeepSeek") === "sk-lower"
);
check(
  "an exact match wins over a case variant in the other section",
  savedKey(
    {
      providers: { deepseek: { api_key: "sk-builtin" } },
      custom_providers: { DeepSeek: { api_key: "sk-custom" } },
    },
    "DeepSeek"
  ) === "sk-custom"
);
/* Two entries whose names differ only by case are two different entries to
 * `ocr`, so "which one did the user mean" has a right answer rather than a
 * guess: `tryProviderConfig` folds the name only for the *registry* lookup and
 * then reads `cfg.Providers[cfg.Provider]` with the raw string, so the entry the
 * config's own `provider` field names is the one the CLI opens
 * (internal/llm/resolver.go, v1.13.3). This used to always pick the all-lowercase
 * spelling — right by luck whenever the two agreed, and wrong (the settings page
 * then reuses a Key from an entry the run does not use) when they did not.
 */
const twoVariants = (provider, name) =>
  savedKey(
    {
      provider,
      providers: {
        deepseek: { api_key: "sk-lower" },
        DeepSeek: { api_key: "sk-upper" },
      },
    },
    name
  );
check(
  "with two case variants, the entry the config's own provider names wins",
  twoVariants("DeepSeek", "DEEPSEEK") === "sk-upper",
  twoVariants("DeepSeek", "DEEPSEEK")
);
check(
  "and it still wins when the config spells it the other way",
  twoVariants("deepseek", "DEEPSEEK") === "sk-lower",
  twoVariants("deepseek", "DEEPSEEK")
);
check(
  "with no provider to go by, the registry's own spelling is the fallback",
  savedKey({ providers: { DeepSeek: { api_key: "sk-upper" }, deepseek: { api_key: "sk-lower" } } }, "DEEPSEEK") ===
    "sk-lower"
);
/* The third spelling: `providers` holds both variants, and the config's own
 * `provider` reads `DEEPSEEK` — a spelling no entry is named with. The two rules
 * above both miss, so which entry answers is decided by the next one: the
 * registry's spelling (`ocr llm providers` prints `deepseek`, and a form filled
 * from that table holds it), *not* insertion order. That ordering is what makes
 * this check worth having: the file lists two variants before the registry's own
 * spelling, so "first match" (sk-first) and "the registry's spelling" (sk-third)
 * give different Keys.
 *
 * What `ocr` does with this file is worth knowing while reading it: the lookup
 * is `cfg.Providers[cfg.Provider]` on the raw string, so `DEEPSEEK` misses and
 * the run fails with "provider DEEPSEEK is set but not configured in providers
 * section". Nothing opens — so this answer cannot send the settings page a Key
 * for a run that would have used another one. */
const thirdSpelling = (provider, name) =>
  savedKey(
    {
      provider,
      providers: {
        DeepSEEK: { api_key: "sk-first" },
        DeepSeek: { api_key: "sk-second" },
        deepseek: { api_key: "sk-third" },
      },
    },
    name
  );
check(
  "a config whose provider names no entry falls to the registry's spelling",
  thirdSpelling("DEEPSEEK", "DEEPSEEK") === "sk-third",
  thirdSpelling("DEEPSEEK", "DEEPSEEK")
);
/* And only when the file never spells the name the registry way is `matches[0]`
 * left: here both entries are variants of `deepseek` and neither *is* it, so the
 * question has no right answer and file order is what remains. Pinned because it
 * is a guess, not because it is good — it is reachable only for a config `ocr`
 * rejects, and if this ever answers for a config the CLI runs, the ordering
 * needs a real rule instead. */
check(
  "and file order answers only when no spelling matches at all",
  savedKey(
    { provider: "corp-gateway", providers: { DeepSEEK: { api_key: "sk-first" }, DeepSeek: { api_key: "sk-second" } } },
    "deepseek"
  ) === "sk-first"
);
// The question the settings page asks is not always spelled the way the file is:
// the form holds the name the user picked, while the config's `provider` decides
// which entry a run opens. The two are read separately, and the rule between them
// is "exact first": a form holding `deepseek` is the form for the `deepseek`
// entry (that is the Key the user is editing and about to test), even when a run
// right now would open `DeepSeek`. Both spellings are the same built-in service,
// so nothing but which saved Key is reused depends on this — the provider decides
// only when the form's spelling is in the file *at all* (the two checks above).
check(
  "an exact entry wins over the variant the config's provider names",
  twoVariants("DeepSeek", "deepseek") === "sk-lower",
  twoVariants("DeepSeek", "deepseek")
);
check(
  "and the other way round, whichever spelling the form holds",
  twoVariants("deepseek", "DeepSeek") === "sk-upper",
  twoVariants("deepseek", "DeepSeek")
);
// The last fallback is only reached when `provider` names none of these variants
// and the file does not spell the name the registry way either — here only one
// variant exists, so there is nothing left to choose between.
check(
  "a lone variant is answered even when no provider points at it",
  savedKey({ provider: "corp-gateway", providers: { DeepSeek: { api_key: "sk-upper" } } }, "DEEPSEEK") ===
    "sk-upper"
);
check(
  "a custom name is not folded, because the CLI looks it up exactly",
  savedKey(
    { custom_providers: { "corp-gateway": { url: gateway.url, api_key: "sk-custom" } } },
    "Corp-Gateway",
    gateway.url
  ) === ""
);
check(
  "a saved Key is still withheld from an endpoint it does not belong to",
  savedKey(
    { providers: { deepseek: { url: "https://api.deepseek.com", api_key: "sk-deep" } } },
    "DeepSeek",
    "https://elsewhere.example/v1"
  ) === ""
);

/* A built-in service configured the way this app configures it — a Key and a
 * model, no `url` — has an endpoint all the same: the CLI's own table supplies it
 * (`tryProviderConfig`: `url = preset.BaseURL` unless `entry.URL` overrides,
 * internal/llm/resolver.go, v1.13.3). So "the entry has no URL" is not "the Key
 * belongs everywhere", and reading an empty `saved` as a wildcard handed the Key
 * to whatever host the test-connection form offered. The two assertions below are
 * the pair that settles it: the built-in endpoint still reuses the Key, any other
 * endpoint does not.
 */
const presetKey = { providers: { deepseek: { api_key: "sk-deep" } } };
const DEEPSEEK_URL = "https://api.deepseek.com";
check(
  "a Key saved without a URL is reused for the endpoint the CLI fills in",
  savedKey(presetKey, "DeepSeek", `${DEEPSEEK_URL}/`, DEEPSEEK_URL) === "sk-deep",
  savedKey(presetKey, "DeepSeek", `${DEEPSEEK_URL}/`, DEEPSEEK_URL)
);
check(
  "and is withheld from any other endpoint, even though the entry has no URL",
  savedKey(presetKey, "DeepSeek", "https://elsewhere.example/v1", DEEPSEEK_URL) === "",
  savedKey(presetKey, "DeepSeek", "https://elsewhere.example/v1", DEEPSEEK_URL)
);
// A custom provider has no table to fall back to — upstream requires its `url`
// for every protocol that names an endpoint — so an entry without one names no
// host at all, and no host may be given its Key.
check(
  "an entry with no URL and no built-in endpoint has no host to hand the Key to",
  savedKey({ custom_providers: { "corp-gateway": { api_key: "sk-custom" } } }, "corp-gateway", gateway.url) === "",
  savedKey({ custom_providers: { "corp-gateway": { api_key: "sk-custom" } } }, "corp-gateway", gateway.url)
);
// The table is the only source of that endpoint, and an unreadable table must
// withhold rather than guess: retyping a Key is recoverable, sending it to the
// wrong host is not.
check(
  "an unreadable registry withholds the Key instead of guessing where it goes",
  savedKey(presetKey, "DeepSeek", "https://elsewhere.example/v1") === "",
  savedKey(presetKey, "DeepSeek", "https://elsewhere.example/v1")
);
// `savedKeyForName` is the version the main process calls: it reads the
// built-in endpoint out of the same cached table the settings page lists. The
// injected `runner` stands in for the binary, and the cache is cleared between
// cases so each one sees its own table — otherwise the first success would be
// reused for the failing read and the check would pass for the wrong reason.
const presetDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-saved-key-name-"));
const presetFile = path.join(presetDir, "config.json");
fs.writeFileSync(presetFile, JSON.stringify(presetKey));
const presetRunner = () => ({
  code: 0,
  stdout: [
    "NAME      PROTOCOL  BASE URL",
    "--------  --------  --------",
    `deepseek  openai    ${DEEPSEEK_URL}`,
    "",
  ].join("\n"),
  stderr: "",
});
svc.resetPresetCache();
const viaTable = await svc.savedKeyForName("DeepSeek", DEEPSEEK_URL, presetFile, { runner: presetRunner });
check(
  "savedKeyForName reads the built-in endpoint from the CLI table",
  viaTable === "sk-deep",
  viaTable
);
const viaOtherHost = await svc.savedKeyForName("DeepSeek", "https://elsewhere.example/v1", presetFile, {
  runner: presetRunner,
});
check(
  "and still withholds that Key from another endpoint",
  viaOtherHost === "",
  viaOtherHost
);
svc.resetPresetCache();
const viaBrokenTable = await svc.savedKeyForName("DeepSeek", DEEPSEEK_URL, presetFile, {
  runner: () => ({ code: 1, stdout: "", stderr: "ocr: not found" }),
});
check(
  "a table that cannot be read withholds the Key instead of guessing",
  viaBrokenTable === "",
  viaBrokenTable
);
svc.resetPresetCache();
fs.rmSync(presetDir, { recursive: true, force: true });

/* ---- one list, one answer ----
 * `ready` and `missing` used to be separate expressions, so they could disagree:
 * `ready` was false while `missing` was empty, leaving the badge with nothing to
 * name. Both are now read off the same three booleans, and the invariant is
 * asserted on every shape the resolver can see.
 */
const invariances = {
  "llm block": readiness({ llm: { ...llm, auth_token: "t" } }),
  "empty config": empty,
  "no endpoint": onlyEndpoint,
  "no model": onlyModel,
  "saved Key only": keyOnlyLlm,
  "lone credential env": envTokenOnly,
  "complete env": envComplete,
  "preset entry": presetReady,
  "provider without a Key": providerUrlOnly,
  "llm token next to a provider": r1,
  "bare provider": bareProvider,
  "provider with a top-level model": providerTopModel,
  "legacy form with a top-level model": legacyTopModel,
  "provider with an env model": providerEnvModel,
  "preset reading its own variable": presetOwnKey,
  "custom provider with an anthropic variable": customEnvKey,
  "built-in name in the wrong section": presetOnlyInCustom,
};
for (const [name, view] of Object.entries(invariances)) {
  check(
    `ready and missing agree (${name})`,
    view.ready === (view.missing.length === 0 && !view.rejected) && view.ready === (view.blockedReason === ""),
    `ready=${view.ready} missing=${JSON.stringify(view.missing)} blockedReason=${view.blockedReason}`
  );
}

/* ---- the sentence, spelled out ----
 * The assertions above read the sentence for a keyword. These compare the whole
 * string, so the 「和」/「、」 join and the label wording are under regression
 * protection too — that punctuation was wrong once already, and a keyword match
 * cannot see it.
 */
const sentences = [
  ["the endpoint", readiness({ llm: { model: llm.model, auth_token: "t" } }), "已配置模型名和 API Key，但缺少服务端点"],
  ["the model", readiness({ llm: { url: llm.url, auth_token: "t" } }), "已配置服务端点和 API Key，但缺少模型名"],
  ["the Key", readiness({ llm }), "已配置服务端点、模型名，但缺少 API Key"],
  ["the model and the Key", readiness({ llm: { url: llm.url } }), "已配置服务端点，但缺少模型名和 API Key"],
  [
    "the endpoint and the Key",
    readiness({ llm: { model: llm.model } }),
    "已配置模型名，但缺少服务端点和 API Key",
  ],
  [
    "the endpoint and the model",
    readiness({ llm: { auth_token: "t" } }),
    "已配置 API Key，但缺少服务端点、模型名",
  ],
  ["nothing at all", readiness({}), "未选择模型服务"],
  [
    "every gap on a selected service",
    bareProvider,
    "已选服务 corp-gateway，但缺少服务端点、模型名和 API Key",
  ],
];
for (const [name, view, expected] of sentences) {
  check(`the sentence names ${name}`, view.blockedReason === expected, view.blockedReason);
}

const rules = await svc.rulesCheck(dir, "a.go", "");
check("rulesCheck answers without throwing", typeof rules.ok === "boolean", JSON.stringify(rules).slice(0, 120));

/* ---- a spawn failure says which of the two is gone ----
 * Node reports a spawn failure with the *program's* path even when what is
 * missing is the working directory, so a repository that no longer exists
 * surfaced as "spawn <binaryPath> ENOENT" and the user went looking for a
 * missing executable.
 *
 * The fallback is the other half: an ENOENT that is neither of those — a
 * third cause, or a wording this code does not know — keeps the original
 * message instead of claiming an executable is missing. Guessing there would
 * send the user looking for the wrong thing.
 */
const enoent = { code: "ENOENT", message: "spawn /usr/bin/ocr ENOENT" };
const present = path.join(dir, "present.txt");
fs.writeFileSync(present, "x", "utf8");
check(
  "a missing binary is named",
  svc.spawnFailure(enoent, path.join(dir, "no-such-binary"), dir).includes("未找到 ocr 可执行文件")
);
check(
  "a missing repository is named",
  svc.spawnFailure(enoent, present, path.join(dir, "no-such-repo")).includes("仓库目录已经不存在")
);
check(
  "and when neither is gone, the original message is kept",
  svc.spawnFailure(enoent, present, dir) === enoent.message
);
check(
  "a failure that is not ENOENT keeps its message too",
  svc.spawnFailure({ code: "EACCES", message: "permission denied" }, present, dir) === "permission denied"
);

/* ---- cleanup ---- */
for (const d of [dir, notRepo, home]) fs.rmSync(d, { recursive: true, force: true });

console.log(`\n${failures.length ? `${failures.length} failed` : "all service checks passed"}`);
if (failures.length) {
  console.error(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
