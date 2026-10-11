import type {
  AppInfo,
  ConfigView,
  ExitPayload,
  Finding,
  Ok,
  Preview,
  RepoInfo,
  RunProgress,
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
  path?: string;
  absPath?: string;
  ref?: string;
  source?: "git" | "worktree";
  totalLines?: number;
  firstLine?: number;
  lines?: { n: number; content: string }[];
}

/** Mirror of the contextBridge surface in preload.js. */
export interface Bridge {
  info(): Promise<AppInfo>;
  providers(): Promise<{ ok: boolean; error?: string; value: Provider[] }>;
  openInstallDir(): Promise<{ ok: boolean; error?: string }>;
  uninstall(): Promise<{ ok: boolean; error?: string }>;
  pickRepo(): Promise<string>;
  pickScanDir(repo: string): Promise<{ relPath?: string; error?: string }>;
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
  openFile(absPath: string): Promise<string>;
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
  readConfig(): Promise<ConfigView>;
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
