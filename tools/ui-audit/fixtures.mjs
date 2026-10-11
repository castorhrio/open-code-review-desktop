// Shared fixtures + a stubbed IPC bridge, so any harness script can render the
// real UI bundle without launching Electron.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "../..");
export const OUT = path.join(ROOT, "out");
// Screenshots are regenerated on every run and are not review artifacts, so
// they stay out of git (see .gitignore).
export const SHOTS = path.join(import.meta.dirname, "shots");

export const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

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

const PREVIEW_FILES = [
  { path: "internal/service/auth/login.go", status: "M", insertions: 34, deletions: 12, will_review: true },
  { path: "internal/repository/user_query.go", status: "M", insertions: 8, deletions: 3, will_review: true },
  { path: "pkg/httpx/middleware.go", status: "A", insertions: 61, deletions: 0, will_review: true },
  { path: "internal/service/auth/login_test.go", status: "M", insertions: 22, deletions: 4, will_review: true },
  { path: "web/src/api/client.ts", status: "M", insertions: 6, deletions: 6, will_review: true },
  { path: "vendor/github.com/pkg/errors/errors.go", status: "M", insertions: 2, deletions: 2, will_review: false, exclude_reason: "vendored" },
  { path: "docs/api.md", status: "M", insertions: 40, deletions: 0, will_review: false, exclude_reason: "doc-only" },
  { path: "assets/logo.png", status: "A", insertions: 0, deletions: 0, will_review: false, exclude_reason: "binary" },
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
    run_manifest: { schema_version: "1", run_id: "9f2c41d0", operation: "review", terminal_state: "complete" },
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
    run_manifest: { schema_version: "1", run_id: "1a7b9c3d", operation: "review", terminal_state: "partial" },
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
    run_manifest: { schema_version: "1", run_id: "c3d4e5f6", operation: "scan", terminal_state: "completed_with_warnings" },
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
    run_manifest: { schema_version: "1", run_id: "77aa88bb", operation: "review", terminal_state: "success" },
  },
];

// The history list is unbounded by design, so the only thing that must hold is
// that every session stays reachable and the count stays honest. 65 sessions
// crosses the panel's 50-row page boundary on purpose.
const MANY_SESSIONS = [
  ...SESSIONS,
  ...Array.from({ length: 61 }, (_, i) => ({
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
    run_manifest: { schema_version: "1", run_id: `bulk${i}`, operation: "review", terminal_state: "complete" },
  })),
];

const SESSION_SETS = { default: SESSIONS, many: MANY_SESSIONS };

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
  llm: { url: "https://api.deepseek.com/v1", model: "deepseek-v4-pro", protocol: "openai", hasToken: true, tokenPreview: "sk-…7f3a" },
  envSources: [],
  configured: true,
  ready: true,
  blockedReason: "",
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
  commits: [
    { hash: "8c1de4f9a2b3c4d5e6f708192a3b4c5d6e7f8091", date: "2026-10-11 09:41", message: "fix(auth): stop leaking rows on the failure path" },
    { hash: "2f7a1b0c9d8e7f60514253647586970a1b2c3d4e", date: "2026-10-10 18:02", message: "feat(ratelimit): per-tenant buckets" },
  ],
  dirtyCount: 3,
};

export const BRIDGE = `
window.api = {
  info: async () => (${JSON.stringify(INFO)}),
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
  readConfig: async () => (${JSON.stringify(CONFIG)}),
  updateState: async () => ({ phase: "idle", current: "0.1.9", enabled: true, packaged: true, portable: false, releasesUrl: "https://github.com/alibaba/open-code-review/releases" }),
  inspect: async () => (${JSON.stringify(REPO_INFO)}),
  listSessions: async () => {
    // ?sessions=many swaps in the 65-session set, so the history panel's paging
    // can be exercised without a second harness.
    const want = new URLSearchParams(location.search).get("sessions");
    const sets = ${JSON.stringify(SESSION_SETS)};
    return { ok: true, value: sets[want] || sets.default };
  },
  sessionComments: async () => ({ ok: true, value: ${JSON.stringify(FINDINGS)} }),
  preview: async () => ({ ok: true, value: { files: ${JSON.stringify(PREVIEW_FILES)}, total_insertions: 171, total_deletions: 27, total_files: 8, reviewable_count: 5, excluded_count: 3 } }),
  resolveRef: async (_r, ref) => ({ ok: true, sha: "8c1de4f9a2b3c4d5e6f708192a3b4c5d6e7f8091" }),
  run: async () => "run-1",
  cancel: async () => true,
  readFile: async () => ({ ok: true, path: "internal/service/auth/login.go", absPath: "/home/x/work/payments-api/internal/service/auth/login.go", source: "worktree", ref: "feat/tenant-rate-limit", totalLines: 180, firstLine: 72, lines: Array.from({length: 33}, (_, i) => ({ n: 72 + i, content: ["func (s *Service) Login(ctx context.Context, email, presented string) (*Token, error) {", "\tuser, err := s.repo.ByEmail(ctx, strings.ToLower(email))", "\tif err != nil {", "\t\treturn nil, ErrInvalidCredentials", "\t}", "\tstored, err := s.repo.PasswordHash(ctx, user.ID)", "\tif err != nil {", "\t\treturn nil, err", "\t}", "", "\t// TODO: constant-time compare", "\tif stored == presented {", "\t\treturn s.tokens.Issue(user)", "\t}", "\treturn nil, ErrInvalidCredentials", "}", "", "func (s *Service) Refresh(ctx context.Context, tok string) (*Token, error) {", "\tclaims, err := s.tokens.Verify(tok)", "\tif err != nil {", "\t\treturn nil, ErrInvalidCredentials", "\t}", "\treturn s.tokens.Issue(&model.User{ID: claims.Subject})", "}", "", "func (s *Service) Logout(ctx context.Context, tok string) error {", "\treturn s.tokens.Revoke(ctx, tok)", "}"][i % 29] || "" })) }),
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
  onLog: () => () => {},
  onExit: () => () => {},
  onProgress: () => () => {},
  onMenuOpenRepo: () => () => {},
};
`;

export const STORAGE = { "last-repo": "/home/x/work/payments-api", "guide-dismissed": "1" };


export function serve(port) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = (req.url || "/").split("?")[0];
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
