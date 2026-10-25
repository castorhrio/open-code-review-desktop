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

/* ---- config / info ---- */
const cfg = svc.readConfigView();
check("readConfigView returns a usable shape", cfg && typeof cfg.path === "string" && typeof cfg.ready === "boolean" && typeof cfg.providers === "object", JSON.stringify(cfg)?.slice(0, 140));

// Readiness is about a credential, not a URL. These cases run against a
// throwaway config path and an explicit environment, so the result does not
// depend on the machine's own ~/.opencodereview or exported keys.
const readiness = (config, env = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-config-"));
  const file = path.join(dir, "config.json");
  if (config) fs.writeFileSync(file, JSON.stringify(config));
  const view = svc.readConfigView({ configPath: file, env });
  fs.rmSync(dir, { recursive: true, force: true });
  return view;
};
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
check(
  "a credential env var is ready",
  readiness({}, { OCR_LLM_TOKEN: "t" }).ready && readiness({}, { ANTHROPIC_API_KEY: "k" }).ready
);
const empty = readiness({});
check(
  "an empty config names endpoint, model and credential",
  ["baseUrl", "model", "credential"].every((key) => empty.missing.includes(key)),
  JSON.stringify(empty.missing)
);

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
