// Contracts verified against @alibaba-group/open-code-review v1.12.13
// (`ocr review --help`, `ocr scan --help`, real `--format json` payloads and the
// upstream structs in cmd/opencodereview/output.go, internal/model/review.go,
// internal/session/{list,manifest}.go).

export type ReviewMode = "workspace" | "range" | "commit" | "scan";

export type Severity = "critical" | "high" | "medium" | "low" | "";

export type Category =
  | "bug"
  | "security"
  | "performance"
  | "maintainability"
  | "test"
  | "style"
  | "documentation"
  | "other"
  | "";

export type TerminalState =
  | "success"
  | "complete"
  | "partial"
  | "failed"
  | "skipped"
  | "completed_with_errors"
  | "completed_with_warnings";

/** model.LlmComment — `comments` is `null`, not `[]`, when a run finds nothing. */
export interface Finding {
  path: string;
  content: string;
  suggestion_code?: string;
  existing_code?: string;
  start_line: number;
  end_line?: number;
  thinking?: string;
  category?: Category;
  severity?: Severity;
}

export interface RunSummary {
  files_reviewed?: number;
  comments?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  elapsed?: string;
  budget_exceeded?: boolean;
}

export interface CoverageItem {
  item_id: string;
  path?: string;
  classification?: string;
  reason?: string;
}

export interface RunManifest {
  schema_version: string;
  run_id: string;
  operation: string;
  terminal_state: TerminalState;
  input?: { mode?: string; requested_from?: string; requested_head?: string };
  execution?: { ocr_version?: string; provider?: string; model?: string; configured_concurrency?: number };
  coverage?: {
    selected?: CoverageItem[];
    completed?: CoverageItem[];
    reused?: CoverageItem[];
    failed?: CoverageItem[];
    waived?: CoverageItem[];
  };
  elapsed_ms?: number;
}

export interface RunResult {
  status?: TerminalState | string;
  llm?: { provider?: string; model?: string };
  message?: string;
  summary?: RunSummary;
  tool_calls?: { total?: number; failure?: number };
  comments?: Finding[] | null;
  groups?: { label: string; files: string[] }[];
  warnings?: unknown[];
  project_summary?: string;
  resume?: { resumed_from: string; reused_files: number; rerun_files: number };
  session_id?: string;
  manifest?: RunManifest | null;
}

/** agent.Preview — for `scan`, `insertions` is the file's line count and status is "scan". */
export interface PreviewFile {
  path: string;
  status: string;
  insertions: number;
  deletions: number;
  will_review: boolean;
  exclude_reason?: string;
}

export interface Preview {
  files: PreviewFile[];
  total_insertions: number;
  total_deletions: number;
  total_files: number;
  reviewable_count: number;
  excluded_count: number;
}

/** session.Summary from `ocr session list --json` (prints `null` when empty). */
export interface SessionSummary {
  session_id: string;
  file_path: string;
  repo_dir: string;
  git_branch?: string;
  model?: string;
  review_mode?: "workspace" | "range" | "commit" | "full_scan" | string;
  diff_from?: string;
  diff_to?: string;
  diff_commit?: string;
  resumed_from?: string;
  start_time: string;
  end_time?: string;
  duration_ns?: number;
  selected_files: number;
  completed_files: number;
  failed_files: number;
  reused_files?: number;
  waived_files?: number;
  total_comments: number;
  llm_failures?: number;
  aborted?: boolean;
  legacy?: boolean;
  run_manifest?: RunManifest | null;
}

export interface RepoInfo {
  ok: boolean;
  error?: string;
  repoRoot?: string;
  branch?: string;
  upstream?: string;
  refs?: string[];
  commits?: { hash: string; date: string; message: string }[];
  dirtyCount?: number;
}

export interface ConfigView {
  path: string;
  fileExists: boolean;
  provider: string;
  model: string;
  effort: string;
  language: string;
  maxTokens: number;
  providers: Record<string, ProviderEntry>;
  customProviders: Record<string, ProviderEntry>;
  llm: { url: string; model: string; protocol: string; hasToken: boolean; tokenPreview: string };
  envSources: string[];
  configured: boolean;
  ready: boolean;
  blockedReason: string;
}

export interface ProviderEntry {
  api_key?: undefined;
  url?: string;
  protocol?: string;
  model?: string;
  models?: string[];
  hasKey?: boolean;
  keyPreview?: string;
}

export interface AppInfo {
  binary: string | null;
  version: string;
  configPath: string;
  docsUrl: string;
  appVersion: string;
  platform: string;
}

export interface Spec {
  repo: string;
  mode: ReviewMode;
  from?: string;
  to?: string;
  commit?: string;
  path?: string;
  effort?: string;
  exclude?: string;
  background?: string;
  backgroundFile?: string;
  rule?: string;
  batch?: string;
  concurrency?: number | "";
  maxTokens?: number | "";
  maxTokensBudget?: number | "";
  maxTools?: number | "";
  timeout?: number | "";
  noFilter?: boolean;
  noPlan?: boolean;
  noDedup?: boolean;
  noSummary?: boolean;
  resume?: string;
}

export interface ExitPayload {
  id: string;
  result: {
    code: number;
    error?: string;
    value?: RunResult | null;
    raw?: string;
    sessionId?: string;
    command?: string;
  };
}

export type Ok<T> = { ok: true; value: T } | { ok: false; error: string; raw?: string };
