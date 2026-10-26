// Contracts verified against @alibaba-group/open-code-review v1.13.3
// (`ocr review --help`, `ocr scan --help`, real `--format json` payloads and the
// upstream structs in cmd/opencodereview/output.go, internal/model/review.go,
// internal/llmloop/pool.go, internal/session/{list,manifest}.go).

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

/**
 * The values `manifest.run_failure.classification` can hold. Spelling the enum
 * out is what makes a new upstream class a compile error here rather than a
 * raw English word on a failure badge.
 */
export type RunFailureClass =
  | "input"
  | "configuration"
  | "timeout"
  | "cancelled"
  | "budget"
  | "internal"
  | "unknown";

export interface RunManifest {
  schema_version: string;
  run_id: string;
  operation: string;
  terminal_state: TerminalState;
  input?: {
    mode?: string;
    requested_from?: string;
    requested_head?: string;
    /**
     * The commits the run was executed against, resolved by git *before* it
     * started — not the refs the user typed (upstream `internal/session/manifest.go`:
     * "Resolved values are actual commit SHAs captured before execution"). A ref
     * is a name that moves; these are the only record of which version was
     * actually reviewed.
     */
    resolved_base?: string;
    resolved_head?: string;
    exact_range?: string;
  };
  execution?: { ocr_version?: string; provider?: string; model?: string; configured_concurrency?: number };
  coverage?: {
    selected?: CoverageItem[];
    completed?: CoverageItem[];
    reused?: CoverageItem[];
    failed?: CoverageItem[];
    waived?: CoverageItem[];
  };
  /**
   * Why the whole run stopped, when it did.
   *
   * This is the single written-down source of the two failure vocabularies the
   * app maps to Chinese (`format.ts`: `RUN_FAILURE_LABEL` /
   * `ITEM_FAILURE_LABEL`). Upstream `internal/session/manifest.go` (read at
   * `v1.13.3`) declares **two** enums, and they are not interchangeable:
   *
   * - `RunFailureClass`, this field's `classification` — `input` /
   *   `configuration` / `timeout` / `cancelled` / `budget` / `internal` /
   *   `unknown`. Seven values. A run never fails with `provider` or `panic`:
   *   those are always attributed to a single item. `internal` exists only
   *   here, for scheduler/invariant failures.
   * - `FailureClass`, `coverage.failed[].classification` — `provider` /
   *   `timeout` / `cancelled` / `configuration` / `input` / `budget` /
   *   `panic` / `unknown`. Eight values.
   *
   * Its presence forces `terminal_state` to `failed` while leaving the items
   * that did complete intact. `reason` is the CLI's own prose (English, and it
   * names providers), which is why it is shown as context and never parsed.
   */
  run_failure?: { classification?: RunFailureClass; reason?: string };
  elapsed_ms?: number;
}

/**
 * llmloop.AgentWarning — one non-fatal warning recorded during a subtask.
 *
 * `type` is the CLI's own vocabulary, and the app reads exactly one of them:
 * `review_limit_reached`, which upstream v1.13.1 added to say that a declared
 * limit (the tool-request rounds, or the aggregate token budget) spent the main
 * loop's last round and sent the task into its grace round.
 */
export interface AgentWarning {
  file?: string;
  message?: string;
  type?: string;
}

export interface RunResult {
  status?: TerminalState | string;
  llm?: { provider?: string; model?: string };
  message?: string;
  summary?: RunSummary;
  tool_calls?: { total?: number; by_tool?: Record<string, number>; failure?: number; failure_by_tool?: Record<string, number> };
  comments?: Finding[] | null;
  groups?: { label: string; files: string[] }[];
  warnings?: AgentWarning[];
  project_summary?: string;
  resume?: { resumed_from: string; reused_files: number; rerun_files: number };
  session_id?: string;
  manifest?: RunManifest | null;
}

/** Live counters parsed out of the CLI's `[ocr]` progress stream. */
/** One row of the live feed a running review writes to. */
export interface ActivityEvent {
  id: number;
  /** `tool` is a tool call the agent made; `note` is a step worth reading. */
  kind: "tool" | "note";
  tool?: string;
  args?: string;
  state?: "running" | "done" | "failed";
  ms?: string;
  text?: string;
  warn?: boolean;
}

export interface RunProgress {
  files: number;
  reviewing: number;
  tools: number;
  comments: number;
  excluded: number;
  cost: string;
  /** The file the agent is working on right now, as far as its tool calls reveal. */
  current: string;
  byTool: Record<string, number>;
  activity: ActivityEvent[];
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

/**
 * What a run's result said about truncation, kept by the desktop because the
 * CLI does not write warnings into the session stream. Only the fields the app
 * renders are stored — never warning messages or provider payloads.
 */
export interface SessionDiagnostics {
  warnings?: AgentWarning[];
  budget_exceeded?: boolean;
}

/**
 * How much of the truncation-evidence store is in use.
 *
 * `limit` is one budget shared by every repository — a busy repository's runs
 * rotate a quiet one's records out, and those sessions then reopen looking
 * clean (see `MAX_ENTRIES` in `run-diagnostics.js`). `settled` is false when
 * the read could not wait for the writes still in flight, i.e. the count may be
 * missing the run that just finished; the settings page says so rather than
 * presenting it as current.
 */
export interface DiagnosticsStoreStats {
  limit: number;
  entries: number;
  repos: number;
  settled: boolean;
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
  /**
   * How each ref stands relative to HEAD. A `--from A --to B` comparison is
   * empty exactly when B is an ancestor of A, so the default 分支对比 scope can
   * only be chosen in a direction that has a diff if this is known — without
   * it, "review this branch" on the base branch silently reviews nothing.
   */
  relations?: Record<string, "same" | "ancestor" | "descendant" | "diverged">;
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
  /**
   * The endpoint each known service resolves to, keyed by service name.
   *
   * It is computed in the main process, by the same rule the saved-Key decision
   * uses (`serviceEndpoint` in `ocr-service.js`): the entry's own `url` if it
   * has one, otherwise the built-in service's registered base URL. The settings
   * page shows this and tests against it rather than deriving a second copy of
   * the rule — a copy that read the two sources in the other order and pointed
   * the form at a host the CLI would never use.
   */
  endpoints: Record<string, string>;
  llm: { url: string; model: string; protocol: string; hasToken: boolean; tokenPreview: string };
  envSources: string[];
  envCredentials: string[];
  configured: boolean;
  ready: boolean;
  blockedReason: string;
  /** The service name the CLI refuses, when it refuses one (`""` otherwise). */
  rejectedProvider?: string;
  /**
   * Why the CLI refuses the whole config, mirroring `tryProviderConfig` in
   * `internal/llm/resolver.go` @ v1.13.3: it picks the section by *name* and
   * stops if the entry is not in that section, without trying the other one.
   *
   * - `name-unknown` — the name is not in the CLI's registry and there is no
   *   `custom_providers` entry, so `missing` is `["provider"]`: the name is the
   *   thing to change.
   * - `provider-not-in-section` — the name *is* built in, but its entry is not
   *   under `providers`; the section that holds it is never opened, so no field
   *   can be filled in and `missing` stays empty.
   *
   * `""` means the config is not refused.
   */
  rejected: "" | "name-unknown" | "provider-not-in-section";
  missing: ("credential" | "baseUrl" | "model" | "provider")[];
  /**
   * Whether the CLI's own list of built-in services (`ocr llm providers`) could
   * be read. `unavailable` means every question about built-in names was
   * answered by the older, lenient fallback — the one that called a config
   * "ready" and let the CLI refuse it at run time — so the settings page says so
   * rather than showing a confident badge. `presetRegistryError` carries the
   * reason (the CLI's own message) for the tooltip.
   */
  presetRegistry: "ok" | "unavailable";
  presetRegistryError?: string;
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
  /** Where the app itself is installed ("" for dev / portable runs). */
  installDir: string;
  /** Electron's per-user data dir, where window bounds and settings live. */
  userData: string;
  /** The running executable. */
  executable: string;
  packaged: boolean;
  portable: boolean;
  /** Whether an NSIS uninstaller was found (Windows installed builds only). */
  canUninstall: boolean;
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
  provider?: string;
  model?: string;
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

/**
 * What the main process managed to do with the truncation evidence of a run.
 *
 * The CLI does not persist warnings, so the app records them itself when a run
 * ends; this says whether that record landed on disk. `message` is the same
 * Chinese line the main process logged (empty when there is nothing to say), so
 * the app can say the same thing instead of keeping a second copy of it.
 */
export interface DiagnosticsOutcome {
  ok: boolean;
  reason: string;
  message?: string;
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
  /** Whether the truncation evidence of this run made it to disk. */
  diagnostics?: DiagnosticsOutcome;
}

export type Ok<T> = { ok: true; value: T } | { ok: false; error: string; raw?: string };

export type UpdatePhase =
  | "idle"
  | "checking"
  | "downloading"
  | "ready"
  | "up-to-date"
  | "error"
  | "manual"
  | "no-release"
  | "unsupported";

export interface UpdateState {
  phase: UpdatePhase;
  current: string;
  version?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  message?: string;
  notes?: string;
  fallbackUrl?: string;
  suppressed?: boolean;
}

/** Fields only updateState() can answer, so event pushes may omit them. */
export type UpdateView = UpdateState & {
  enabled?: boolean;
  portable?: boolean;
  packaged?: boolean;
  releasesUrl?: string;
};
