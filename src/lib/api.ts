import type {
  AppInfo,
  ConfigView,
  DiagnosticsStoreStats,
  ExitPayload,
  Finding,
  Ok,
  Preview,
  RepoInfo,
  RunProgress,
  SessionDiagnostics,
  SessionSummary,
  Spec,
  UpdateState,
  UpdateView,
} from "./types";

interface SaveResult { ok: boolean; error?: string; message?: string; cleared?: boolean; steps?: { key: string; ok: boolean; message: string }[]; config?: ConfigView }

export interface Provider {
  name: string;
  protocol: string;
  url: string;
}

export interface FileWindow {
  ok: boolean;
  error?: string;
  /**
   * Why a read at a ref failed, so the code pane can say more than "it failed".
   *
   * `missing` — the file is not in that ref (deleted, renamed, or never
   * committed there); `bad-ref` — the ref itself does not resolve; `failed` —
   * anything else, including a git error.
   */
  reason?: "missing" | "bad-ref" | "failed";
  path?: string;
  absPath?: string;
  ref?: string;
  source?: "git" | "worktree";
  totalLines?: number;
  firstLine?: number;
  lines?: { n: number; content: string }[];
}

/** 选目录 answers one of exactly three shapes, and which one it is is the whole
 *  contract (the decision lives in `pickInsideAnswer` / `pickInsidePayload` in
 *  `path-guard.js`, and is pinned by `tools/path-guard-smoke.mjs`):
 *
 *    { relPath }  a directory inside the repo; `""` is the repo itself (留空)
 *    { error }    a refusal — outside the repo, or no usable repo chosen yet
 *    {}           the dialog was cancelled
 *
 *  An empty `relPath` means 留空 (the whole repo), so a refusal must never be
 *  readable as one: `relPath` appears only on the first shape and `error` only on
 *  the second. Read them in that order — `error` first, then `relPath`, then the
 *  empty object as "cancelled" — which is the same if-chain `pickInsidePayload`
 *  writes on the main side, so there is one reading of the three shapes.
 *
 *  `?: never` rather than a plain `?` so a reader that forgets the empty-object
 *  case fails to typecheck instead of silently treating it as a path. */
export type PickScanDirAnswer =
  | { relPath: string; error?: never }
  | { relPath?: never; error: string }
  | { relPath?: never; error?: never };

/** Mirror of the contextBridge surface in preload.js. */
export interface Bridge {
  info(): Promise<AppInfo>;
  providers(): Promise<{ ok: boolean; error?: string; value: Provider[] }>;
  /** Same shape as `revealFile`'s refusal: `action`/`path` are always present,
   *  so an "open a directory" failure reads the same whichever button it was. */
  openInstallDir(): Promise<{ ok: boolean; error?: string; action?: string; path?: string }>;
  uninstall(): Promise<{ ok: boolean; error?: string }>;
  pickRepo(): Promise<string>;
  /** The three shapes and how to read them are on `PickScanDirAnswer`. */
  pickScanDir(repo: string): Promise<PickScanDirAnswer>;
  /** Cancelled answers `""`. Every option but `properties` is optional, and the
   *  defaults (title, button label, 所有文件 filter) come from
   *  `pickFileOptions` in `path-guard.js`. */
  pickFile(opts: { title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<string>;
  inspect(repo: string): Promise<RepoInfo>;
  resolveRef(repo: string, ref: string): Promise<{ ok: boolean; sha?: string; error?: string }>;
  preview(spec: Spec): Promise<Ok<Preview>>;
  run(spec: Spec): Promise<string | null>;
  cancel(id: string): Promise<boolean>;
  readFile(req: {
    repo: string;
    path: string;
    startLine: number;
    endLine?: number;
    ref?: string;
    pad?: number;
  }): Promise<FileWindow>;
  /** Same shape as `revealFile`: `shell.openPath` fails by resolving to an error
   *  string, so the main process reads it and answers `ok: false` — a bare string
   *  would make "did not open" indistinguishable from "opened".
   *
   *  `reason` says which of the three refusals it was. `missing` is decided
   *  before the shell is asked (the file is gone from the working tree, which is
   *  what a finding on a moved branch produces) and deserves its own sentence;
   *  `open-failed` is the shell's own "no handler / refused" answer, which has
   *  nothing to add to what it says. */
  openFile(absPath: string): Promise<{
    ok: boolean;
    action?: "open-file";
    path?: string;
    reason?: "no-file" | "missing" | "open-failed";
    error?: string;
  }>;
  revealFile(
    absPath: string
  ): Promise<{ ok: boolean; action?: "reveal" | "open-parent"; path?: string; missing?: string; error?: string }>;
  saveText(req: {
    title?: string;
    suggestedName?: string;
    text: string;
    filters?: { name: string; extensions: string[] }[];
  }): Promise<{ ok: boolean; file?: string; canceled?: boolean; error?: string }>;
  openUrl(url: string): Promise<boolean>;
  /**
   * `refresh` re-reads the CLI's built-in service list instead of reusing a
   * failure remembered for a short window — the settings page's 刷新 button.
   */
  readConfig(opts?: { refresh?: boolean }): Promise<ConfigView>;
  /**
   * Whether the Key field may be left blank for this name + endpoint, and the
   * sentence to show when it may not. `reason` is one of the `KEY_WITHHELD_*`
   * strings in `ocr-service.js` (`""` when the Key is reusable); the Key itself
   * never reaches the renderer.
   *
   * `endpoint` is the host the service resolves to — the same value the config
   * view's `endpoints` map holds, so the endpoint the Key was compared against
   * and the endpoint on screen are one host. `tableOk` says whether the CLI's
   * built-in service table could be read, so the banner about that table and
   * the sentence under the Key field come from one answer.
   */
  savedKey(req: { name: string; url: string }): Promise<{
    ok: boolean;
    available: boolean;
    reason: string;
    hint: { tone: "ok" | "warn" | "muted"; text: string };
    endpoint: string;
    tableOk: boolean;
  }>;
  saveConfig(form: {
    provider: string;
    isCustom: boolean;
    url?: string;
    protocol?: string;
    apiKey?: string;
    model?: string;
    effort?: string;
    language?: string;
    maxTokens?: number | "";
    setActive?: boolean;
  }): Promise<SaveResult>;
  unsetConfig(key: string): Promise<{ ok: boolean; error?: string; config?: ConfigView }>;
  removeEntry(name: string): Promise<SaveResult>;
  useProvider(name: string, model?: string): Promise<SaveResult>;
  testLlm(form?: { name?: string; url: string; protocol: string; model: string; apiKey: string }): Promise<{ ok: boolean; output: string; via: "form" | "saved" }>;
  /** `limit` caps the rows returned; `0` means every session. The CLI reads
   *  them all to sort by start time, so a cap costs the same and only hides
   *  data — callers should pass 0. */
  listSessions(repo: string, limit: number): Promise<Ok<SessionSummary[]>>;
  sessionComments(repo: string, sessionId: string): Promise<Ok<Finding[]>>;
  /** Truncation facts the CLI does not persist with the session. */
  sessionDiagnostics(repo: string, sessionId: string): Promise<Ok<SessionDiagnostics | null>>;
  /** How full the truncation-evidence store is — its cap, the records in use
   *  and how many repositories those belong to. Called per settings visit:
   *  every finished run can change all three.
   *
   *  `Ok`, not a bare object: a read that could not run must be distinguishable
   *  from a profile that has recorded nothing, or the page prints `0 / 200` for
   *  a file it never opened. The failure's sentence is written next to `stats`
   *  in `run-diagnostics.js` (`statsReport`), so the page shows the reason it
   *  was given. */
  diagnosticsStats(): Promise<Ok<DiagnosticsStoreStats>>;
  exportSession(repo: string, sessionId: string): Promise<{ ok: boolean; file?: string; opened?: boolean; canceled?: boolean; error?: string }>;
  deleteSession(repo: string, sessionId: string): Promise<{ ok: boolean; error?: string }>;
  rulesCheck(repo: string, path: string, rule: string): Promise<Ok<string>>;

  updateState(): Promise<UpdateView>;
  checkUpdate(): Promise<UpdateState>;
  installUpdate(): Promise<boolean>;
  ignoreUpdate(version: string): Promise<UpdateState>;
  openReleases(): Promise<boolean>;
  setUpdateEnabled(enabled: boolean): Promise<boolean>;
  onUpdateState(cb: (p: UpdateState) => void): () => void;
  onLog(cb: (p: { id: string; line: string }) => void): () => void;
  onExit(cb: (p: ExitPayload) => void): () => void;
  onProgress(cb: (p: { id: string; progress: RunProgress }) => void): () => void;
  onMenuOpenRepo(cb: () => void): () => void;
}

export const api = (window as unknown as { api: Bridge }).api;
