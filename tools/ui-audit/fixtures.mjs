// Shared fixtures + a stubbed IPC bridge, so any harness script can render the
// real UI bundle without launching Electron.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

export const ROOT = path.resolve(import.meta.dirname, "../..");
export const OUT = path.join(ROOT, "out");
// Screenshots are regenerated on every run and are not review artifacts, so
// they stay out of git (see .gitignore).
export const SHOTS = path.join(import.meta.dirname, "shots");

export const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

const require = createRequire(import.meta.url);
const ocr = require(path.join(ROOT, "ocr-service.js"));

/**
 * stderr from one real single-file review (`ocr review` on a throwaway repo:
 * 3m48s, 6 findings). This is the transcript the running screen has to be
 * legible against, and the reason it is here rather than invented: the bridge
 * used to stub `onProgress` with a no-op, so the audit only ever saw a running
 * screen with three zeros and a void — and reported it as passing.
 */
export const RUN_TRANSCRIPT = [
  "[ocr] 8 file(s) changed, reviewing 5 in /home/x/work/payments-api",
  // A batched group, which is what the CLI actually emits whenever several files
  // land in one concurrency slot: a real 11-file run produced one group line
  // naming ten files, and the feed row it became was ~1200px wide. The
  // transcript used to carry single-file groups only, so no shot ever rendered
  // the shape that widens the feed — and a feed that scrolls sideways is
  // silently exempt from the scroll-affordance rule, which skips such regions.
  '[ocr] Skipping plan phase for group "internal/service/auth/login.go,internal/service/auth/session.go,internal/service/auth/token.go,internal/repository/user.go,pkg/httpx/middleware.go" (5 file(s), max 90 lines, total 214 lines)',
  '[ocr] Skipping plan phase for group "internal/service/auth/login.go" (1 file(s), max 90 lines, total 90 lines)',
  "[ocr]   ▶ file_read file_path=internal/service/auth/login.go",
  "[ocr]   ✔ file_read (1ms)",
  "[ocr]   ▶ code_search search_text=tokenFor",
  "[ocr]   ✔ code_search (21ms)",
  "[ocr]   ▶ code_search search_text=auth file_patterns=[*.go]",
  "[ocr]   ✔ code_search (21ms)",
  "[ocr]   ▶ code_search search_text=ConstantTimeCompare",
  // A failed tool call, transcribed from a real run: the CLI's git grep choked
  // on an unbalanced parenthesis in a search pattern. It follows its own ▶ with
  // no ✔ between, which is how the closing line settles the running row to
  // failed — and the feed's failed state, a red dot whose row now carries the
  // reason, had no line in the transcript before this one.
  "[ocr]   ✗ code_search failed: git grep failed: exit status 128: fatal: -e option, 'token(': missing closing parenthesis",
  "[ocr]   ▶ file_find query_name=token*",
  "[ocr]   ✔ file_find (19ms)",
  "[ocr]   ▶ code_comment",
  "[ocr]   ✔ code_comment (0s)",
  '[ocr] Plan completed for group "pkg/httpx/middleware.go"',
  "[ocr]   ▶ file_read file_path=pkg/httpx/middleware.go",
  "[ocr]   ✔ file_read (2ms)",
  "[ocr]   ▶ code_search search_text=WithTimeout use_perl_regexp=true",
  "[ocr]   ✔ code_search (22ms)",
  "[ocr]   ▶ code_comment",
  "[ocr]   ✔ code_comment (0s)",
  "[ocr] estimated cost: ~1.2M tokens",
  "[ocr]   ✔ code_comment (1ms)",
  "[ocr] Summary: 5 file(s) reviewed, 9 comment(s), ~412880 token(s) used, 3m48s elapsed",
];

/** Progress snapshots produced by the app's own parser, not by hand. */
export function runFrames() {
  const p = ocr.createProgress();
  const frames = [];
  for (const line of RUN_TRANSCRIPT) {
    ocr.feedProgressLine(p, line);
    frames.push({ ...p, activity: p.activity.slice() });
  }
  return frames;
}

/**
 * A long run, for the one state the suite never rendered: a feed with more tool
 * calls than rows.
 *
 * The recorded transcript is 23 lines and the parser folds a tool call's ▶ and ✔
 * into a single row, so a whole run is ~16 rows — and the feed holds ~15 at the
 * 1000x660 floor. Measured with the real fixture: after 2.8s the feed held 15
 * rows in 374px with nothing cut off, so `expectScrollAffordance` on the running
 * shot could not fire, and never had. A real run of minutes produces hundreds of
 * tool calls, so the state that matters was the one the fixture could not reach.
 *
 * ?longrun=1 replays the same transcript four times with a distinct file per
 * pass — 92 frames, ~60 rows — which is what the list looks like a few minutes
 * in. The log drawer gets the same replay, so the two surfaces stay consistent.
 * The replay also runs faster (40ms/frame), because this shot is about the
 * feed's layout when full, not about how long a run takes.
 */
export function longRunFrames() {
  const p = ocr.createProgress();
  const frames = [];
  for (const line of longTranscript()) {
    ocr.feedProgressLine(p, line);
    frames.push({ ...p, activity: p.activity.slice() });
  }
  return frames;
}

/** The same replay's log lines, for the drawer. */
export function longRunMilestones() {
  const p = ocr.createProgress();
  return longTranscript().map((line) => ocr.feedProgressLine(p, line)).filter(Boolean);
}

function longTranscript() {
  const out = [];
  for (let pass = 1; pass <= 4; pass++) {
    for (const line of RUN_TRANSCRIPT) {
      out.push(
        line
          .replace(/internal\/service\/auth\/login\.go/g, `internal/service/auth/login_p${pass}.go`)
          .replace(/pkg\/httpx\/middleware\.go/g, `pkg/httpx/middleware_p${pass}.go`)
      );
    }
  }
  return out;
}

/** The same run's milestone lines, i.e. what the log drawer receives. */
export function runMilestones() {
  const p = ocr.createProgress();
  return RUN_TRANSCRIPT.map((line) => ocr.feedProgressLine(p, line)).filter(Boolean);
}

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();

const FINDINGS = [
  {
    path: "internal/service/auth/login.go",
    content:
      "**密码校验用了普通的字符串比较**\n\n`==` 会随前缀匹配长度提前返回，理论上可通过响应时间差逐字节爆破 token。建议改用 `subtle.ConstantTimeCompare`。",
    existing_code: "if stored == presented {\n\treturn issueToken(user)\n}",
    suggestion_code: "if subtle.ConstantTimeCompare([]byte(stored), []byte(presented)) != 1 {\n\treturn ErrInvalidCredentials\n}\nreturn issueToken(user)",
    start_line: 88,
    end_line: 90,
    thinking: "先确认 stored 与 presented 都是用户可控长度，再看调用方是否已经有速率限制……",
    category: "security",
    severity: "critical",
  },
  {
    path: "internal/service/auth/login.go",
    content: "登录失败路径没有释放 `rows`，高并发下会耗尽连接池。",
    suggestion_code: "defer rows.Close()",
    start_line: 132,
    category: "bug",
    severity: "high",
  },
  {
    path: "internal/repository/user_query.go",
    content: "这里对 `email` 建了索引却又套了 `LOWER()`，索引失效，全表扫描。",
    start_line: 41,
    category: "performance",
    severity: "medium",
  },
  {
    path: "pkg/httpx/middleware.go",
    content: "超时中间件把 `context.WithTimeout` 的 cancel 丢掉了，会持续泄漏定时器。",
    suggestion_code: "ctx, cancel := context.WithTimeout(r.Context(), d)\ndefer cancel()",
    start_line: 24,
    end_line: 26,
    category: "bug",
    severity: "medium",
  },
  {
    path: "pkg/httpx/middleware.go",
    content: "错误信息直接把内部路径返回给客户端，建议只记日志。",
    start_line: 57,
    category: "security",
    severity: "low",
  },
];

// Status vocabulary captured from the real binary: `ocr review --preview` spells
// it out (`modified` / `added` / `deleted`), never the single letters this used to
// carry. A fixture that invents a value the CLI cannot emit makes every shot of
// the list a picture of a state that does not exist — and it hid a real one, the
// constant `scan` status that a whole-repo scan returns for all 66 of its files.
const PREVIEW_FILES = [
  { path: "internal/service/auth/login.go", status: "modified", insertions: 34, deletions: 12, will_review: true },
  { path: "internal/repository/user_query.go", status: "modified", insertions: 8, deletions: 3, will_review: true },
  { path: "pkg/httpx/middleware.go", status: "added", insertions: 61, deletions: 0, will_review: true },
  { path: "internal/service/auth/login_test.go", status: "modified", insertions: 22, deletions: 4, will_review: true },
  { path: "web/src/api/client.ts", status: "modified", insertions: 6, deletions: 6, will_review: true },
  { path: "vendor/github.com/pkg/errors/errors.go", status: "modified", insertions: 2, deletions: 2, will_review: false, exclude_reason: "vendored" },
  { path: "docs/api.md", status: "modified", insertions: 40, deletions: 0, will_review: false, exclude_reason: "doc-only" },
  { path: "assets/logo.png", status: "added", insertions: 0, deletions: 0, will_review: false, exclude_reason: "binary" },
];

const SESSIONS = [
  {
    session_id: "9f2c41d0a7b34e58b1c6d7e8f9a0b1c2",
    file_path: "/home/x/.opencodereview/sessions/demo/9f2c41d0.jsonl",
    repo_dir: "/home/x/work/payments-api",
    git_branch: "feat/tenant-rate-limit",
    model: "deepseek-v4-pro",
    review_mode: "range",
    diff_from: "main",
    diff_to: "feat/tenant-rate-limit",
    start_time: iso(1000 * 60 * 34),
    end_time: iso(1000 * 60 * 28),
    duration_ns: 356_000_000_000,
    selected_files: 12,
    completed_files: 12,
    failed_files: 0,
    total_comments: 9,
    // The endpoints the CLI resolved with git *before* the run started, and the
    // commits they resolved to — upstream `internal/session/manifest.go`:
    // "Resolved values are actual commit SHAs captured before execution, not the
    // mutable refs the user typed". The branch has moved on since (that is the
    // whole point of reading an old session), so the code pane has to read the
    // reviewed commit, not `feat/tenant-rate-limit`.
    run_manifest: {
      schema_version: "ocr.run-manifest/v1",
      run_id: "9f2c41d0",
      operation: "review",
      terminal_state: "complete",
      input: {
        mode: "range",
        requested_from: "main",
        requested_head: "feat/tenant-rate-limit",
        resolved_base: "3f2a7c91d4b6e0852a1c9f7e3b5d80146c2ea7f93",
        resolved_head: "d41c8b7a2e9f6013c5d8a4b6e2f7091c3a5d8e6b4",
        exact_range: "3f2a7c91d4b6e0852a1c9f7e3b5d80146c2ea7f93..d41c8b7a2e9f6013c5d8a4b6e2f7091c3a5d8e6b4",
      },
    },
  },
  {
    session_id: "1a7b9c3d5e6f708192a3b4c5d6e7f809",
    file_path: "/home/x/.opencodereview/sessions/demo/1a7b9c3d.jsonl",
    repo_dir: "/home/x/work/payments-api",
    git_branch: "main",
    model: "claude-sonnet-4-5",
    review_mode: "commit",
    diff_commit: "8c1de4f",
    start_time: iso(1000 * 60 * 60 * 5),
    duration_ns: 92_000_000_000,
    selected_files: 3,
    completed_files: 2,
    failed_files: 1,
    total_comments: 4,
    aborted: true,
    run_manifest: { schema_version: "ocr.run-manifest/v1", run_id: "1a7b9c3d", operation: "review", terminal_state: "partial" },
  },
  {
    session_id: "c3d4e5f60718293a4b5c6d7e8f901234",
    file_path: "/home/x/.opencodereview/sessions/demo/c3d4e5f6.jsonl",
    repo_dir: "/home/x/work/payments-api",
    git_branch: "main",
    model: "deepseek-v4-pro",
    review_mode: "full_scan",
    start_time: iso(1000 * 60 * 60 * 26),
    duration_ns: 7_420_000_000_000,
    selected_files: 148,
    completed_files: 148,
    failed_files: 0,
    total_comments: 63,
    resumed_from: "1a7b9c3d",
    run_manifest: { schema_version: "ocr.run-manifest/v1", run_id: "c3d4e5f6", operation: "scan", terminal_state: "completed_with_warnings" },
  },
  {
    // A resumed session reuses the files its previous run already covered.
    // The CLI counts them in the selected total (`selected = completed +
    // reused + failed`), so 3 newly completed + 24 reused out of 27 is a
    // complete run — not the 3/27 this row used to read as.
    session_id: "e5f60718293a4b5c6d7e8f9012345678",
    file_path: "/home/x/.opencodereview/sessions/demo/e5f60718.jsonl",
    repo_dir: "/home/x/work/payments-api",
    git_branch: "main",
    model: "claude-sonnet-4-5",
    review_mode: "full_scan",
    start_time: iso(1000 * 60 * 60 * 30),
    duration_ns: 310_000_000_000,
    selected_files: 27,
    completed_files: 3,
    reused_files: 24,
    failed_files: 0,
    total_comments: 12,
    resumed_from: "9f2c41d0",
    run_manifest: { schema_version: "ocr.run-manifest/v1", run_id: "e5f60718", operation: "scan", terminal_state: "complete" },
  },
  {
    session_id: "77aa88bb99cc00dd11ee22ff33aa44bb",
    file_path: "/home/x/.opencodereview/sessions/demo/77aa88bb.jsonl",
    repo_dir: "/home/x/work/payments-api",
    git_branch: "chore/bump-deps",
    model: "kimi-k2",
    review_mode: "workspace",
    start_time: iso(1000 * 60 * 60 * 50),
    duration_ns: 14_000_000_000,
    selected_files: 1,
    completed_files: 1,
    failed_files: 0,
    total_comments: 0,
    run_manifest: { schema_version: "ocr.run-manifest/v1", run_id: "77aa88bb", operation: "review", terminal_state: "success" },
  },
  // A session from before the run-manifest format existed, taken from a real
  // machine's `ocr session list --json`: no manifest, no terminal_state, and
  // every selected file failed. The history list used to label it 完成 with a
  // green badge, which is an affirmative claim about an outcome nobody
  // recorded — and, here, the wrong one.
  {
    session_id: "5c1d2e3f4a5b60718293a4b5c6d7e8f9",
    file_path: "/home/x/.opencodereview/sessions/demo/5c1d2e3f.jsonl",
    repo_dir: "/home/x/work/payments-api",
    git_branch: "main",
    model: "gpt-4o",
    review_mode: "range",
    diff_from: "main",
    diff_to: "HEAD",
    start_time: iso(1000 * 60 * 60 * 74),
    duration_ns: 2_100_000_000,
    selected_files: 27,
    completed_files: 0,
    failed_files: 27,
    total_comments: 0,
    legacy: true,
    aborted: false,
  },
];

// The history list is unbounded by design, so the only thing that must hold is
// that every session stays reachable and the count stays honest. 65 sessions
// crosses the panel's 50-row page boundary on purpose — the bulk count is
// derived from SESSIONS so the total stays 65 when a case is added above.
const MANY_SESSIONS = [
  ...SESSIONS,
  ...Array.from({ length: 65 - SESSIONS.length }, (_, i) => ({
    session_id: `bulk${String(i).padStart(4, "0")}deadbeefcafe0011223344`,
    file_path: `/home/x/.opencodereview/sessions/demo/bulk${i}.jsonl`,
    repo_dir: "/home/x/work/payments-api",
    git_branch: "main",
    model: "deepseek-v4-pro",
    review_mode: "range",
    diff_from: "main",
    diff_to: `release/2.${i}`,
    start_time: iso(1000 * 60 * 60 * (60 + i)),
    duration_ns: 60_000_000_000 + i * 1_000_000,
    selected_files: 4 + (i % 9),
    completed_files: 4 + (i % 9),
    failed_files: 0,
    total_comments: i % 5,
    run_manifest: { schema_version: "ocr.run-manifest/v1", run_id: `bulk${i}`, operation: "review", terminal_state: "complete" },
  })),
];

const CONFIG = {
  path: "C:\\Users\\x\\.opencodereview\\config.json",
  fileExists: true,
  provider: "deepseek",
  model: "deepseek-v4-pro",
  effort: "medium",
  language: "zh-CN",
  maxTokens: 0,
  providers: {
    deepseek: { url: "https://api.deepseek.com/v1", protocol: "openai", model: "deepseek-v4-pro", models: ["deepseek-v4-pro", "deepseek-v4-flash"], hasKey: true, keyPreview: "sk-…7f3a" },
    anthropic: { url: "https://api.anthropic.com", protocol: "anthropic", model: "claude-sonnet-4-5", hasKey: true, keyPreview: "sk-…11bc" },
  },
  customProviders: {
    "corp-gateway": { url: "https://llm.corp.internal/v1", protocol: "openai", model: "qwen3-max", hasKey: false },
  },
  // The endpoint each service resolves to, resolved by the main process with the
  // rule the CLI uses (the entry's own `url`, else the built-in service's
  // registered base URL). The settings page shows this and tests against it,
  // so a fixture without it would leave the form with no endpoint at all.
  endpoints: {
    deepseek: "https://api.deepseek.com/v1",
    anthropic: "https://api.anthropic.com",
    "corp-gateway": "https://llm.corp.internal/v1",
  },
  llm: { url: "https://api.deepseek.com/v1", model: "deepseek-v4-pro", protocol: "openai", hasToken: true, tokenPreview: "sk-…7f3a" },
  envSources: [],
  envCredentials: [],
  configured: true,
  ready: true,
  blockedReason: "",
  missing: [],
};

const INFO = {
  binary: "C:\\Users\\x\\AppData\\Local\\Programs\\Open Code Review\\resources\\app\\node_modules\\@alibaba-group\\ocr-win32-x64\\bin\\opencodereview.exe",
  version: "1.12.13",
  configPath: CONFIG.path,
  docsUrl: "https://github.com/alibaba/open-code-review",
  appVersion: "0.1.9",
  platform: "win32",
  installDir: "C:\\Users\\x\\AppData\\Local\\Programs\\Open Code Review",
  userData: "C:\\Users\\x\\AppData\\Roaming\\open-code-review-desktop",
  executable: "C:\\Users\\x\\AppData\\Local\\Programs\\Open Code Review\\Open Code Review.exe",
  packaged: true,
  portable: false,
  canUninstall: true,
};

const REPO_INFO = {
  ok: true,
  repoRoot: "/home/x/work/payments-api",
  branch: "feat/tenant-rate-limit",
  upstream: "origin/feat/tenant-rate-limit",
  refs: ["main", "master", "develop", "feat/tenant-rate-limit", "release/2.4"],
  // How each ref stands relative to HEAD. This is what makes the default
  // 分支对比 scope pickable in a direction that has a diff: `A...B` is empty
  // exactly when B is an ancestor of A. Here HEAD is the feature branch and the
  // base is behind it, so `from=main, to=feat/…` reviews the feature's changes.
  relations: {
    "origin/feat/tenant-rate-limit": "same",
    "feat/tenant-rate-limit": "same",
    main: "ancestor",
    master: "ancestor",
    develop: "diverged",
    "release/2.4": "diverged",
  },
  commits: [
    // Short hash, as `git log --format=%h` reports it — this is now rendered
    // into the 单个提交 field, so a 40-char hash here would be a fixture that
    // cannot show what the field really holds.
    { hash: "8c1de4f", date: "2026-10-11 09:41", message: "fix(auth): stop leaking rows on the failure path" },
    { hash: "2f7a1b0", date: "2026-10-10 18:02", message: "feat(ratelimit): per-tenant buckets" },
  ],
  dirtyCount: 3,
};

// A second repository, so "switch repos" can be a real switch rather than the
// same repository under a different path. It sits on a different branch with a
// different base and a disjoint ref list, so anything the first repository left
// behind in the form is *visible* — with one shared profile the stale value
// happened to still be correct and the bug was invisible.
export const OTHER_REPO_PATH = "/home/x/work/other-repo";
const OTHER_REPO_INFO = {
  ok: true,
  repoRoot: OTHER_REPO_PATH,
  branch: "develop",
  upstream: "origin/develop",
  refs: ["main", "master", "develop"],
  relations: { "origin/develop": "same", develop: "same", main: "ancestor", master: "ancestor" },
  commits: [{ hash: "c0ffee1234567890abcdef1234567890abcdef12", date: "2026-09-30 11:15", message: "chore: cut release 3.0" }],
  dirtyCount: 0,
};

// The shape that produced a silent zero-file review: the checkout is the *base*
// branch and every other branch is ahead of it. `inspect` used to pick "any ref
// that is not the current branch" as the base, so it chose a branch that was
// ahead of HEAD — and `--from <ahead> --to HEAD` diffs the merge-base against
// HEAD, which is HEAD, i.e. nothing. The user picked 分支对比, pressed the
// primary action, and got "0 个文件，没有一个进入审查" with no explanation.
export const BASE_REPO_PATH = "/home/x/work/base-repo";
const BASE_REPO_INFO = {
  ok: true,
  repoRoot: BASE_REPO_PATH,
  branch: "master",
  upstream: "origin/master",
  refs: ["master", "feature/rate-limit", "hotfix/pool"],
  relations: {
    "origin/master": "same",
    master: "same",
    "feature/rate-limit": "descendant",
    "hotfix/pool": "descendant",
  },
  commits: [{ hash: "5ea1be0f0a1b2c3d4e5f60718293a4b5c6d7e8f9", date: "2026-10-12 10:20", message: "chore: bump deps" }],
  dirtyCount: 0,
};

// The most common repository shape there is: one branch, tracked to its own
// remote, nothing to compare against. Here the only honest default base is
// *none*, so the app has to say so rather than pre-fill a diff that is empty by
// construction.
export const SOLO_REPO_PATH = "/home/x/work/solo-repo";
const SOLO_REPO_INFO = {
  ok: true,
  repoRoot: SOLO_REPO_PATH,
  branch: "main",
  upstream: "origin/main",
  refs: ["main"],
  relations: { "origin/main": "same", main: "same" },
  commits: [{ hash: "a11ce0000000000000000000000000000000beef", date: "2026-10-01 08:00", message: "init" }],
  dirtyCount: 0,
};

// ---------------------------------------------------------------------------
// Pathological payloads (?stress=1)
// Real data is not tidy: vendor errors arrive as one unbroken 200-char token,
// branch names run long, model ids get prefixed with a whole org path, and
// paths nest deeply. A flex/grid child without `min-w-0` refuses to shrink
// below its min-content width, and an unbreakable string is the fastest way to
// find the places that forgot. Swapping these in lets the harness's `clipped`
// probe look for the damage instead of me guessing at it from source.
const LONG = "Supercalifragilisticexpialidocious".repeat(3); // 102 chars, no break opportunity
const LONG_PATH = "/home/developer/" + "deeply-nested-directory/".repeat(6) + "login.go";
const LONG_BRANCH = "feature/" + "tenant-scoped-rate-limiting-and-quota/".repeat(3) + "final";

// The CLI asks the model for a sectioned Chinese summary (主要风险 / 模块热点 /
// 建议顺序), and a real one runs to a dozen lines of prose. The results screen
// caps that band at 208px, so the capped region scrolls — but the two-line
// summary every set carried meant no shot ever reached that state, and the
// affordance check over the band passed over a region with 150px to spare.
// LONG_SUMMARY is the shape the CLI actually produces; no backticks in it,
// because it is interpolated into the bridge's template literal. Declared
// before STRESS, which both sets spread from.
const SUMMARY = "**主要风险**\n\n1. 认证路径上有一处非常量时间比较。\n2. 超时中间件泄漏 cancel。";
const LONG_SUMMARY =
  "**主要风险**\n\n" +
  "1. 认证路径上有一处非常量时间比较：密码哈希直接用等号比较，攻击者可以靠响应时间差逐字节猜出哈希，改用常量时间比较即可。\n" +
  "2. 超时中间件泄漏 cancel：带超时的上下文没有 defer 释放，长时间运行会堆积定时器与协程。\n" +
  "3. 错误信息把内部路径直接返回给客户端，等于把目录结构告诉对方；记进日志就够。\n" +
  "4. 刷新令牌没有轮换：同一个令牌可以一直用到过期，泄漏之后无法靠换发来失效。\n" +
  "5. 登出只清了访问令牌，刷新令牌仍留在客户端存储里，下次启动还能换回会话。\n\n" +
  "**模块热点**\n\n" +
  "- 认证服务集中了上面五条里的三条，登录、刷新、登出三个入口共用同一处比较逻辑，改一处即可全覆盖。\n" +
  "- 超时包装被九个路由引用，改动需要跟着看一遍调用方。\n" +
  "- 令牌签发与校验分散在两个包里，轮换策略要两边一起改才不会出现半边生效。\n\n" +
  "**建议顺序**\n\n" +
  "先修常量时间比较（安全收益最大、改动最小），再补 cancel 的释放，然后做令牌轮换，最后收敛错误消息。前三处互不依赖，可以分开提交；轮换涉及存储结构，单独一个提交并附上迁移说明。";

const STRESS = {
  INFO: { ...INFO, binary: LONG_PATH, installDir: "/opt/" + LONG, configPath: "/home/developer/.opencodereview/" + LONG },
  CONFIG: {
    ...CONFIG,
    model: LONG,
    llm: { ...CONFIG.llm, url: "https://gateway.internal.example.com/" + LONG + "/v1" },
    providers: { ...CONFIG.providers, deepseek: { ...CONFIG.providers.deepseek, model: LONG } },
  },
  REPO_INFO: { ...REPO_INFO, branch: LONG_BRANCH, upstream: "origin/" + LONG_BRANCH },
  SESSIONS: SESSIONS.map((s, i) => ({
    ...s,
    git_branch: LONG_BRANCH,
    model: i % 2 ? LONG : "vendor-partner-org/team-name/" + LONG,
    diff_from: LONG_BRANCH,
    diff_to: LONG_BRANCH,
  })),
  FINDINGS: FINDINGS.map((f) => ({ ...f, path: LONG_PATH })),
  SUMMARY,
  PREVIEW_FILES: PREVIEW_FILES.map((f) => ({ ...f, path: LONG_PATH })),
  OTHER_REPO_INFO,
  OTHER_REPO_PATH,
  SOLO_REPO_INFO,
  SOLO_REPO_PATH,
  BASE_REPO_INFO,
  BASE_REPO_PATH,
};
// PREVIEW_FILES belongs here. It was missing from the normal set, so every
// screenshot of the preview panel — a core flow, "预览清单" is one of the two
// buttons on the form — was taken against `files: undefined` and therefore
// showed "进入审查 0" with the "nothing entered the review" explanation. The
// panel looked plausible, so nothing noticed; the fixture was simply wrong.
const NORMAL = { INFO, CONFIG, REPO_INFO, SESSIONS, FINDINGS, SUMMARY, PREVIEW_FILES, OTHER_REPO_INFO, OTHER_REPO_PATH, SOLO_REPO_INFO, SOLO_REPO_PATH, BASE_REPO_INFO, BASE_REPO_PATH };

// ---------------------------------------------------------------------------
// A finding long enough to overflow the reading column (?longfinding=1)
//
// The results screen's reading column is a bare `overflow-y-auto` wrapping a
// ScrollArea, and the ScrollArea is the one that is supposed to own the fade.
// Measured at 1440x900: the outer region is 729px tall while the inner scroller
// is 425px of content, so the inner one never scrolls and its fade never
// appears — the outer one does the scrolling, with no affordance at all. Every
// fade check over that column passed vacuously, because the fixture's findings
// are three lines each and the region always measured `below=0`. Real reviews
// are not three lines: a security finding with a rewrite and a model rationale
// runs past the window. This payload is that shape, and its only job is length.
//
// Declared after NORMAL, which it spreads: the other way round is a temporal
// dead zone, and it is a *silent* one for anyone who pipes the suite's output
// through `tail`, because the pipeline then reports tail's exit status.
const LONG_BODY = Array.from({ length: 14 }, (_, i) =>
  "第 " + (i + 1) + " 段：这段说明用来把阅读栏撑到窗口高度以上，好让这一列真的开始滚动。" +
  "它没有任何信息量，存在的唯一理由是长度——真实审查里的安全类问题就是这样，"
).join("\n\n");
const LONG_CODE = Array.from(
  { length: 22 },
  (_, i) => "\tline" + String(i + 1).padStart(2, "0") + " := compute(ctx, req, store)"
).join("\n");

const LONG_FINDING = {
  ...NORMAL,
  SUMMARY: LONG_SUMMARY,
  FINDINGS: FINDINGS.map((f, i) =>
    i === 0 ? { ...f, content: f.content + "\n\n" + LONG_BODY, existing_code: LONG_CODE, suggestion_code: LONG_CODE } : f
  ),
};

// ---------------------------------------------------------------------------
// A review at four figures (?huge=1)
//
// The largest real session observed was 148 files / 63 comments and the largest
// fixture 200, so neither results surface had ever been asked to mount a
// thousand findings. Neither virtualises — the list renders every row and 阅读
// renders every finding as a document block — which is the right shape at the
// sizes a review actually reaches, and an open question at four figures. Only a
// fixture at that order of magnitude can ask it; the shots measure whether the
// mount completes, whether every finding is present, and how long it took.
const HUGE = {
  ...NORMAL,
  FINDINGS: Array.from({ length: 1200 }, (_, i) => {
    const t = FINDINGS[i % FINDINGS.length];
    return {
      ...t,
      path: `internal/service/${["auth", "billing", "notify", "search", "tokens"][i % 5]}/file${String(Math.floor(i / 5)).padStart(4, "0")}.go`,
      start_line: 20 + (i % 180),
      end_line: 22 + (i % 180),
    };
  }),
  SESSIONS: SESSIONS.map((s, i) => (i ? s : { ...s, total_comments: 1200 })),
};

// The sentence the main process builds for each way a saved Key can be
// withheld (ocr-service.js `savedKeyFieldHint`), keyed by the reason code.
//
// The fixture hands these out verbatim from the real function, and the shot
// compares the screen against them, because the gap being closed is not "does
// the wording distinguish six causes" (that is asserted in the service smoke) but
// "does the wording ever reach the screen": `config:savedKey` existed and the
// settings page never called it, so every cause still rendered as the one
// sentence "该服务还没有 Key". Paraphrasing the sentences here would let the
// fixture and the UI agree with each other while both disagreed with the app.
export const SAVED_KEY_HINTS = Object.fromEntries(
  [
    "",
    ocr.KEY_WITHHELD_TABLE,
    ocr.KEY_WITHHELD_URL,
    ocr.KEY_WITHHELD_ORDER,
    ocr.KEY_WITHHELD_CONFIG,
    ocr.KEY_WITHHELD_NO_ENTRY,
    ocr.KEY_WITHHELD_EMPTY,
  ].map((reason) => [reason, ocr.savedKeyFieldHint(reason)])
);

export const BRIDGE = `
window.api = (() => {
  const q = new URLSearchParams(location.search);
  const D = q.get("stress") === "1" ? ${JSON.stringify(STRESS)} : q.get("longfinding") === "1" ? ${JSON.stringify(LONG_FINDING)} : q.get("huge") === "1" ? ${JSON.stringify(HUGE)} : ${JSON.stringify(NORMAL)};
  const SETS = { default: D.SESSIONS, many: ${JSON.stringify(MANY_SESSIONS)} };
  // A run replays the real transcript through the real parser, so the running
  // screen is audited against the data it will actually receive. ?longrun=1
  // swaps in a replay long enough to overflow the feed — see longRunFrames.
  const LONG = q.get("longrun") === "1";
  const FRAMES = LONG ? ${JSON.stringify(longRunFrames())} : ${JSON.stringify(runFrames())};
  const LINES = LONG ? ${JSON.stringify(longRunMilestones())} : ${JSON.stringify(runMilestones())};
  let progressCb = null;
  let logCb = null;
  let exitCb = null;
  // The payload a completed review answers with on stdout. Everything the app
  // shows after a run comes from this shape, so the success transition is only
  // real if the whole payload is here — not just the comments.
  // (No backticks anywhere below: the bridge is one template literal.)
  //
  // ?limit=1 is the shape upstream v1.13.1 made possible: a run that spent its
  // last tool-request round, finished in the grace round, and found nothing.
  // The CLI reports it as a *success* — the file did complete — and the only
  // trace of the limit is the review_limit_reached warning it now records.
  // Before that warning existed the run was indistinguishable from a clean one,
  // and the app read "zero findings" as "your code is fine".
  // ?limit=1&findings=1 is the same run with findings: a truncated review is
  // not a clean one just because it found something, and its report must say
  // what it could not cover.
  const LIMIT = q.get("limit") === "1";
  const LIMIT_FINDINGS = LIMIT && q.get("findings") === "1";
  const LIMIT_EMPTY = LIMIT && !LIMIT_FINDINGS;
  // ?failure=<class> is a run that broke partway: the CLI resolves a
  // run-level cause, writes it into the manifest as run_failure, forces
  // terminal_state to failed, and still keeps the files it did finish. The
  // class is the CLI's own RunFailureClass (internal/session/manifest.go) and
  // the reason is its prose - English, naming the provider, which is why the
  // app says the class in its own words and labels the prose as the CLI's.
  const FAILURE = q.get("failure") || "";
  const FAILURE_REASON = {
    timeout: "global review deadline of 30m elapsed before 3 of 5 files were dispatched",
    budget: "aggregate token budget exhausted before 3 of 5 files were dispatched",
  }[FAILURE] || "";
  const RUN_RESULT = {
    status: "complete",
    session_id: "9f2c41d0a7b34e58b1c6d7e8f9a0b1c2",
    llm: { provider: "deepseek", model: "deepseek-v4-pro" },
    comments: LIMIT_EMPTY ? [] : D.FINDINGS,
    project_summary: LIMIT_EMPTY ? undefined : D.SUMMARY,
    summary: { files_reviewed: 5, comments: LIMIT_EMPTY ? 0 : 5, total_tokens: 412880, input_tokens: 401000, output_tokens: 11880, elapsed: "3m48s" },
    manifest: {
      schema_version: "ocr.run-manifest/v1",
      run_id: "9f2c41d0",
      operation: "review",
      // The CLI's own terminal states are complete/partial/failed/skipped; the
      // status it reports is this one, not a separate "success".
      terminal_state: "complete",
      input: {
        mode: "range",
        requested_from: "main",
        requested_head: "feat/tenant-rate-limit",
        resolved_base: "3f2a7c91d4b6e0852a1c9f7e3b5d80146c2ea7f93",
        resolved_head: "d41c8b7a2e9f6013c5d8a4b6e2f7091c3a5d8e6b4",
        exact_range: "3f2a7c91d4b6e0852a1c9f7e3b5d80146c2ea7f93..d41c8b7a2e9f6013c5d8a4b6e2f7091c3a5d8e6b4",
      },
      coverage: { failed: [], waived: [] },
    },
    warnings: LIMIT
      ? [{ type: "review_limit_reached", file: "internal/service/auth/login.go", message: "max tool rounds reached; task_done" }]
      : [],
  };
  if (FAILURE) {
    RUN_RESULT.status = "failed";
    RUN_RESULT.manifest.terminal_state = "failed";
    RUN_RESULT.manifest.run_failure = { classification: FAILURE, reason: FAILURE_REASON };
    // Two items with two different classes, the way the manifest really looks:
    // one file the model service refused — provider is a *per-file* class, a run
    // never fails with it — and the rest swept by the stop that ended the run
    // (upstream's itemFailureForRunClass maps the run-level class onto them).
    RUN_RESULT.manifest.coverage.failed = [
      {
        item_id: "internal/service/auth/session.go",
        path: "internal/service/auth/session.go",
        classification: "provider",
        reason: "provider deepseek returned 429 Too Many Requests",
      },
      { item_id: "internal/service/auth/login.go", path: "internal/service/auth/login.go", classification: FAILURE, reason: "" },
    ];
  }
  const replay = () => {
    const step = LONG ? 40 : 130;
    FRAMES.forEach((f, i) => setTimeout(() => progressCb && progressCb({ id: "run-1", progress: f }), step * i));
    LINES.forEach((l, i) => setTimeout(() => logCb && logCb({ id: "run-1", line: l }), step * i));
    // ?run=done walks the transition nothing else in this file covered: the run
    // finishes, the payload arrives, and the app has to land on the results with
    // them. Every other "results" shot got there through 历史.
    if (q.get("run") === "done" && !FAILURE) {
      setTimeout(
        () => logCb && logCb({ id: "run-1", line: "[cmd] ocr review --repo /home/x/work/payments-api --format json --color never" }),
        60
      );
      setTimeout(
        () =>
          exitCb &&
          exitCb({
            id: "run-1",
            result: { code: 0, value: RUN_RESULT, sessionId: RUN_RESULT.session_id },
            // ?rundiag=1 is a run whose truncation evidence could not be saved;
            // ?rundiag=2 is one whose exit signal never reached the screen, so a
            // finished run stays looking like it is still running. Both lines are
            // the wording run-diagnostics.js owns, and the app has to put them in
            // the run log: a stderr line nobody opens is the same as not saying it.
            ...(q.get("rundiag") === "1"
              ? {
                  diagnostics: {
                    ok: false,
                    reason: "io-error",
                    message: "本次运行的上限证据保存失败，重开会话后将看不到这条提示",
                  },
                }
              : q.get("rundiag") === "2"
                ? {
                    diagnostics: {
                      ok: false,
                      reason: "signal-failed",
                      message: "本次运行已经结束，但结束信号推送失败，界面可能仍显示运行中",
                    },
                  }
                : {}),
          }),
        step * FRAMES.length + 400
      );
    }
    // ?runfail=1 is a run the model service refused. The text is the pair
    // ocr-service.js really produces: the CLI's own Error: line, which names
    // the provider and talks about endpoints, and the translated hint appended
    // under it. The toast used to lead with the first line and bury the hint in
    // the description, so the one sentence written for a person was the part
    // users had to go looking for.
    if (q.get("runfail") === "1") {
      setTimeout(
        () =>
          exitCb &&
          exitCb({
            id: "run-1",
            result: {
              code: 1,
              value: null,
              sessionId: "9f2c41d0a7b34e58b1c6d7e8f9a0b1c2",
              error:
                'Error: no valid LLM endpoint configured for provider "deepseek"\\n→ 还没有配置模型服务。到「设置」里选择服务、填入 API Key 并保存后再运行。',
            },
          }),
        step * FRAMES.length + 400
      );
    }
    // The failure run exits non-zero the way the CLI does, and still carries
    // the partial value: that pair is what puts the results screen up with the
    // failure cause beside the badge instead of ending in a toast alone.
    if (FAILURE) {
      setTimeout(
        () =>
          exitCb &&
          exitCb({
            id: "run-1",
            result: {
              code: 1,
              value: RUN_RESULT,
              sessionId: RUN_RESULT.session_id,
              error: "Error: review stopped before every file was reviewed\\n→ 模型服务返回 429，稍后再试或换一个服务。",
            },
          }),
        step * FRAMES.length + 400
      );
    }
  };
  return {
  info: async () => (D.INFO),
  providers: async () => ({ ok: true, value: [
    { name: "deepseek", protocol: "openai", url: "https://api.deepseek.com/v1" },
    { name: "anthropic", protocol: "anthropic", url: "https://api.anthropic.com" },
    { name: "openai", protocol: "openai", url: "https://api.openai.com/v1" },
    { name: "gemini", protocol: "openai", url: "https://generativelanguage.googleapis.com/v1beta" },
    { name: "kimi", protocol: "openai", url: "https://api.moonshot.cn/v1" },
    { name: "z-ai", protocol: "openai", url: "https://open.bigmodel.cn/api/paas/v4" },
    { name: "dashscope", protocol: "openai", url: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    { name: "siliconflow-cn", protocol: "openai", url: "https://api.siliconflow.cn/v1" },
    { name: "openrouter", protocol: "openai", url: "https://openrouter.ai/api/v1" },
    { name: "ollama-cloud", protocol: "openai", url: "https://ollama.com/v1" },
  ]}),
  readConfig: async () => {
    // ?config=none is the beat every launch actually has: the boot sequence
    // awaits this call, so until it lands the renderer holds no config at all.
    // Never resolving is the honest model of that window.
    if (q.get("config") === "none") return await new Promise(() => {});
    // ?nollm=1 is the state a fresh machine is actually in: a repo is chosen and
    // the scope computes fine, but there is no model behind the run. The app
    // knows this — "ready" is what the top-bar badge reads — and used to let the
    // user discover it from a CLI error after spawning a process.
    // (No backticks in here: this whole bridge is one template literal.)
    if (q.get("nollm") === "1")
      return {
        ...D.CONFIG,
        provider: "",
        model: "",
        configured: false,
        ready: false,
        blockedReason: "未选择模型服务",
        missing: ["baseUrl", "model", "credential"],
      };
    // ?nokey=1 is a selected custom gateway with a URL and a model but no Key.
    // It used to count as ready, so the top bar was green and 开始审查 ran until
    // the CLI failed. Keep the llm fallback empty: a real config in this state
    // has no second credential hidden behind the provider.
    if (q.get("nokey") === "1")
      return {
        ...D.CONFIG,
        provider: "corp-gateway",
        model: "qwen3-max",
        llm: { url: "", model: "", protocol: "", hasToken: false, tokenPreview: "" },
        ready: false,
        blockedReason: "已选服务 corp-gateway，但缺少 API Key",
        missing: ["credential"],
      };
    return D.CONFIG;
  },
  // ?update=<phase> renders the update banner and its status line, which are
  // otherwise unreachable here: the banner only shows for downloading / ready /
  // manual, and every other fixture reports idle. Those three states had
  // therefore never been looked at — which is how a button labelled 稍后 came to
  // mean "never tell me about this release again".
  updateState: async () => {
    const base = { current: "0.1.9", enabled: true, packaged: true, portable: false, releasesUrl: "https://github.com/alibaba/open-code-review/releases" };
    // The state before the renderer's first pull resolves. The build-type badge
    // used to read this absence as "not packaged" and open an installed build on
    // 开发模式 for a beat.
    if (q.get("update") === "none") return null;
    const state = {
      idle: { phase: "idle" },
      downloading: { phase: "downloading", version: "0.2.0", percent: 42, transferred: 38, total: 90 },
      ready: { phase: "ready", version: "0.2.0" },
      // A portable build has no version to name — the error handler sets a
      // message and no version, so that is what the banner has to cope with.
      manual: { phase: "manual", portable: true, message: "portable builds re-extract to a temp directory on every launch" },
      // The state the user reaches by dismissing a release. Unreachable until
      // the ignore path was fixed, so it was never on screen either.
      suppressed: { phase: "idle", suppressed: true, version: "0.2.0" },
      // A channel with zero published releases, transcribed from the real 404
      // the updater emits for a missing latest.yml. Every install is in this
      // state until the first Release exists, so its copy has to be on screen
      // in a shot, not only described in the service.
      norelease: { phase: "no-release", message: 'Cannot find channel "latest.yml" update info: HttpError: 404 Not Found' },
    }[q.get("update") || "idle"];
    return { ...base, ...state };
  },
  inspect: async (dir) => {
    if (q.get("norepo") === "1") return { ok: false, error: "路径不存在" };
    if (dir === D.OTHER_REPO_PATH) return D.OTHER_REPO_INFO;
    if (dir === D.SOLO_REPO_PATH) return D.SOLO_REPO_INFO;
    // ?onbase=1 is the shape that produced a silent zero-file 分支对比: the
    // checkout is the base branch and everything else is ahead of it.
    if (q.get("onbase") === "1") return D.BASE_REPO_INFO;
    return D.REPO_INFO;
  },
  listSessions: async () => {
    // ?sessions=many swaps in the 65-session set, so the history panel's paging
    // can be exercised without a second harness. ?toast=1 makes the call fail
    // instead, which is the only way to get the app's error surface — a toast —
    // on screen for inspection; every other fixture succeeds at everything.
    const want = q.get("sessions");
    if (q.get("toast") === "1") {
      return { ok: false, error: "error: failed to read session index\\n  caused by: open /home/x/.opencodereview/sessions/demo/index.jsonl: permission denied\\n  hint: run 'ocr sessions --rebuild' to regenerate the index" };
    }
    const set = SETS[want] || SETS.default;
    // ?sessionbudget=1 is a session the token budget cut short. The CLI does not
    // persist warnings, but it does sweep undispatched items to failed(budget),
    // so this is the one truncation a reopened session can still prove from the
    // manifest alone.
    if (q.get("sessionbudget") === "1")
      return {
        ok: true,
        value: set.map((s, i) =>
          i
            ? s
            : {
                ...s,
                run_manifest: {
                  ...(s.run_manifest || {}),
                  terminal_state: "partial",
                  coverage: {
                    ...((s.run_manifest && s.run_manifest.coverage) || {}),
                    failed: [
                      {
                        item_id: "budget-item",
                        path: "internal/service/auth/login.go",
                        classification: "budget",
                        reason: "aggregate token budget reached before dispatch completed",
                      },
                    ],
                  },
                },
              }
        ),
      };
    // Keep the session's own comment count in step with ?many=1's payload, or
    // the shot renders a header that disagrees with the list beneath it and the
    // disagreement looks like the product's bug rather than the fixture's.
    if (q.get("many") === "1")
      return { ok: true, value: set.map((s, i) => (i ? s : { ...s, total_comments: 200 })) };
    // ?clean=1 pairs with the empty sessionComments below: a review that
    // found nothing has to be consistent across both calls, or the shot renders
    // a header promising 9 comments over a list that says there are none.
    if (q.get("clean") === "1") return { ok: true, value: set.map((s, i) => (i ? s : { ...s, total_comments: 0 })) };
    return { ok: true, value: set };
  },
  sessionDiagnostics: async (_repo, sessionId) => {
    // ?sessionlimit=1 is a session whose run spent its last tool-request round.
    // The CLI kept that only in the live JSON, so the desktop's own record is
    // what makes it survive a reopen. The manifest says complete, which is
    // exactly the dishonest reading this shot guards against.
    if (q.get("sessionlimit") === "1" && sessionId === D.SESSIONS[0].session_id)
      return {
        ok: true,
        value: {
          warnings: [{ type: "review_limit_reached", file: "internal/service/auth/login.go" }],
          budget_exceeded: false,
        },
      };
    return { ok: true, value: null };
  },
  sessionComments: async () => {
    if (q.get("clean") === "1") return { ok: true, value: [] };
    // ?many=1 is a full-repo scan's payload: a real 148-file session in the
    // fixture set left 63 comments, and both results surfaces render every
    // finding without virtualisation, so scale is the thing to check.
    if (q.get("many") === "1")
      return {
        ok: true,
        // Plain concatenation: this whole bridge is one template literal, so a
        // nested backtick string or an interpolation would break the bundle.
        value: Array.from({ length: 40 }, (_, i) => i).flatMap((i) =>
          D.FINDINGS.map((f, j) => ({
            ...f,
            path: f.path.replace(/[^/]+$/, "dir" + i + "/") + i,
            end_line: undefined,
            category: f.category || "cat" + j,
          }))
        ),
      };
    return { ok: true, value: D.FINDINGS };
  },
  preview: async (spec) => {
    // ?norepo=1 has to fail here too, or the shot renders a file list for a
    // repository that does not exist and never shows what the region does.
    if (q.get("norepo") === "1")
      return { ok: false, error: "仓库目录已经不存在：/home/x/work/payments-api\\n→ 上次用的目录已经不在了。在顶部重新选一个仓库目录即可。" };
    // ?badref=1 is the scope the CLI has already refused: a ref that does not
    // resolve. It keys off the ref in the spec, the way the CLI does, so fixing
    // the field really does fix the preview — otherwise the shot could only ever
    // prove that the button is disabled, never that it comes back. The error
    // text is copied verbatim from a live run, raw line and appended hint
    // together, because the pair is the whole point: the page used to print only
    // the raw one.
    if (q.get("badref") === "1" && /no-such/.test(String((spec && spec.to) || "")))
      return { ok: false, error: 'Error: --to value "no-such-branch-xyz" is not a valid commit ref: fatal: Needed a single revision\\n→ 分支或提交号无法解析：检查拼写，或直接从下拉列表里选。' };
    // ?empty=1 is the state where the scope legitimately contains nothing to
    // review — a clean working tree, or a ref range that touches no source.
    // The app has to say so rather than spend a run discovering it.
    // A scan has no diff, so the CLI reports its constant scan status with no
    // deletions, and insertions carries the file's total line count. Returning
    // the diff vocabulary here made the 全量扫描 shot show per-file 修改 / 新增
    // labels that cannot occur in that mode. Captured from the real binary:
    //   ocr scan --preview --repo . --format json   -> status "scan", deletions 0
    //   ocr review --preview --repo . --from HEAD~12 --to HEAD -> "modified"
    // (No backticks anywhere in this file — the bridge below is one template
    // literal and a stray backtick ends it. Fifth time. See AGENT_BACKLOG.md.)
    const files =
      spec && spec.mode === "scan"
        ? D.PREVIEW_FILES.map((f) => ({ ...f, status: "scan", insertions: f.insertions + f.deletions, deletions: 0 }))
        : D.PREVIEW_FILES;
    if (q.get("empty") === "1") {
      return { ok: true, value: { files: files.map((f) => ({ ...f, will_review: false })), total_insertions: 0, total_deletions: 0, total_files: files.length, reviewable_count: 0, excluded_count: files.length } };
    }
    return { ok: true, value: { files, total_insertions: 171, total_deletions: 27, total_files: 8, reviewable_count: 5, excluded_count: 3 } };
  },
  resolveRef: async (_r, ref) =>
    q.get("badref") === "1" && /no-such/.test(ref)
      ? { ok: false, error: "无法解析 " + ref }
      : { ok: true, sha: "8c1de4f9a2b3c4d5e6f708192a3b4c5d6e7f8091" },
  run: async (spec) => { window.__lastRunSpec = spec; replay(); return "run-1"; },
  cancel: async () => {
    // What a killed child really looks like: a non-zero exit, no payload, and a
    // session id on disk. Without this the cancel path could not be rendered,
    // and a user-initiated stop was reported as a crash.
    if (q.get("cancel") === "1")
      setTimeout(() => {
        if (exitCb)
          exitCb({
            id: "run-1",
            result: { code: null, error: "ocr 以退出码 null 结束", value: null, sessionId: "9f2c41d0a7b34e58b1c6d7e8f9a0b1c2" },
          });
      }, 250);
    return true;
  },
  readFile: async (req) => {
    // ?reffile=missing is the state a review hits when the file is not in the
    // ref it was reviewed at — deleted, renamed, or never committed there. The
    // app used to answer with the working tree instead, so the code pane showed
    // a file the review never saw, and the finding beside it looked wrong.
    if (q.get("reffile") === "missing" && req.ref)
      return { ok: false, reason: "missing", ref: req.ref, path: req.path, error: "在 " + req.ref + " 中找不到 " + req.path };
    return { ok: true, path: req.path, absPath: "/home/x/work/payments-api/" + req.path, source: req.ref ? "git" : "worktree", ref: req.ref, totalLines: 180, firstLine: 72, lines: Array.from({length: 33}, (_, i) => ({ n: 72 + i, content: ["func (s *Service) Login(ctx context.Context, email, presented string) (*Token, error) {", "\tuser, err := s.repo.ByEmail(ctx, strings.ToLower(email))", "\tif err != nil {", "\t\treturn nil, ErrInvalidCredentials", "\t}", "\tstored, err := s.repo.PasswordHash(ctx, user.ID)", "\tif err != nil {", "\t\treturn nil, err", "\t}", "", "\t// TODO: constant-time compare", "\tif stored == presented {", "\t\treturn s.tokens.Issue(user)", "\t}", "\treturn nil, ErrInvalidCredentials", "}", "", "func (s *Service) Refresh(ctx context.Context, tok string) (*Token, error) {", "\tclaims, err := s.tokens.Verify(tok)", "\tif err != nil {", "\t\treturn nil, ErrInvalidCredentials", "\t}", "\treturn s.tokens.Issue(&model.User{ID: claims.Subject})", "}", "", "func (s *Service) Logout(ctx context.Context, tok string) error {", "\treturn s.tokens.Revoke(ctx, tok)", "}"][i % 29] || "" })) };
  },
  openFile: async () => "",
  revealFile: async () => ({ ok: true, action: "reveal", path: "" }),
  saveText: async () => ({ ok: true, file: "C:/tmp/out.json" }),
  openUrl: async () => true,
  openInstallDir: async () => ({ ok: true }),
  uninstall: async () => ({ ok: true }),
  saveConfig: async () => ({ ok: true, config: (${JSON.stringify(CONFIG)}) }),
  unsetConfig: async () => ({ ok: true, config: (${JSON.stringify(CONFIG)}) }),
  removeEntry: async () => ({ ok: true }),
  useProvider: async () => ({ ok: true }),
  // ?savedkey=<reason> is the answer for "may I leave the Key box blank?": the
  // reason the Key is withheld, plus the sentence to show for it. With no query
  // the reason is empty, which is the ordinary "the saved Key will be reused".
  // The answer also carries the built-in table's state and the endpoint the
  // lookup used: the settings page reads the banner about that table from
  // here, so a fixture that left the state out would claim the table is
  // unreadable on every screen. (No backticks in here: the whole bridge is one
  // template literal.)
  savedKey: async () => {
    const reason = q.get("savedkey") || "";
    const hints = ${JSON.stringify(SAVED_KEY_HINTS)};
    return {
      ok: true,
      available: !reason,
      reason,
      hint: hints[reason] || hints[""] || { tone: "muted", text: "" },
      endpoint: ${JSON.stringify(CONFIG.endpoints.deepseek)},
      tableOk: true,
    };
  },
  testLlm: async () => ({ ok: true, output: "[ok] deepseek deepseek-v4-pro 连通正常", via: "form" }),
  exportSession: async () => ({ ok: true, file: "C:/tmp/report.html" }),
  deleteSession: async () => ({ ok: true }),
  rulesCheck: async () => ({ ok: true, value: "internal/service/auth/login.go -> go-security/auth.md" }),
  pickRepo: async () => "/home/x/work/payments-api",
  pickScanDir: async () => ({ relPath: "internal/service" }),
  pickFile: async () => "docs/requirements.md",
  checkUpdate: async () => ({ phase: "up-to-date", current: "0.1.9" }),
  installUpdate: async () => true,
  ignoreUpdate: async () => ({ phase: "idle", current: "0.1.9" }),
  setUpdateEnabled: async () => true,
  openReleases: async () => true,
  onUpdateState: () => () => {},
  onLog: (cb) => { logCb = cb; return () => { if (logCb === cb) logCb = null; }; },
  onExit: (cb) => { exitCb = cb; return () => { if (exitCb === cb) exitCb = null; }; },
  onProgress: (cb) => { progressCb = cb; return () => { if (progressCb === cb) progressCb = null; }; },
  onMenuOpenRepo: () => () => {},
  };
})();
`;

// The bridge is a template literal whose *contents* become source text in the
// page, so a stray backtick or an unescaped interpolation inside an innocent
// comment yields a bundle that fails only at runtime — as a pageerror three
// screenshots later. Parse it here, where the message points at the line.
try {
  // eslint-disable-next-line no-new-func
  new Function(BRIDGE);
} catch (err) {
  console.error(`The stubbed bridge does not parse: ${err.message}`);
  process.exit(2);
}

// The theme is declared, not inherited. `shoot` only writes the keys it is
// given and localStorage survives navigation within the origin, so one shot that
// asks for dark leaves every later shot dark — which is how the update-banner
// shot quietly recoloured the eight screens after it while each of them believed
// it was looking at the default theme.
export const STORAGE = { "last-repo": "/home/x/work/payments-api", "guide-dismissed": "1", "ocr-theme-pref": "system" };


export function serve(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = (req.url || "/").split("?")[0];
      // The browser asks for a favicon unprompted; answering 404 puts a red
      // console error in every run and buries the ones that matter.
      if (url === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      const rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
      const file = path.join(OUT, rel);
      if (!file.startsWith(OUT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
