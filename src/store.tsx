import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api, type Provider } from "@/lib/api";
import { coverageOf, needsContinuation, reviewedCommit, sessionFileRef, sessionState, terminalState } from "@/lib/format";
import { intOrEmpty, MODE_META, resumableMode, validateSpec } from "@/lib/spec";
import type {
  AppInfo,
  ConfigView,
  Finding,
  Preview,
  RepoInfo,
  ReviewMode,
  RunProgress,
  RunResult,
  SessionSummary,
  Spec,
  UpdateView,
} from "@/lib/types";

export type View = "review" | "results" | "report" | "history" | "settings";

export interface FormState {
  mode: ReviewMode;
  from: string;
  to: string;
  commit: string;
  scanPath: string;
  effort: string;
  concurrency: string;
  budget: string;
  timeout: string;
  exclude: string;
  background: string;
  backgroundFile: string;
  maxTokens: string;
  maxTools: string;
  rule: string;
  runProvider: string;
  runModel: string;
  noFilter: boolean;
  noPlan: boolean;
  noDedup: boolean;
  noSummary: boolean;
  batch: string;
}

export const EMPTY_FORM: FormState = {
  mode: "workspace",
  from: "",
  to: "",
  commit: "",
  scanPath: "",
  effort: "",
  concurrency: "",
  budget: "",
  timeout: "",
  exclude: "",
  background: "",
  backgroundFile: "",
  maxTokens: "",
  maxTools: "",
  rule: "",
  runProvider: "",
  runModel: "",
  noFilter: false,
  noPlan: false,
  noDedup: false,
  noSummary: false,
  batch: "",
};

export interface ResultOrigin {
  kind: "run" | "session";
  label?: string;
  /**
   * The ref the finding's code should be read from. A session carries its own
   * scope, and the review form on screen has nothing to do with it — without
   * this, opening a history session showed the working tree while the header
   * said 历史会话, so the code beside a finding could be a different file than
   * the one that was reviewed.
   */
  fileRef?: string;
  /**
   * What the run covered, as one human line — `分支对比 main…feat/x`. The
   * reading view is the artifact a user forwards to someone else, and "which
   * range was reviewed" is the first question that artifact has to answer.
   * Computed where the scope is known rather than re-derived here, because the
   * CLI's own vocabulary (`full_scan` for the scan mode) is not this file's to
   * reinterpret.
   */
  scope?: string;
  /**
   * How many files the CLI recorded as failed for a session. `ocr session
   * comments` returns findings only and the manifest on `session list` carries no
   * `coverage` detail, so a reopened session knows *that* files were missed and
   * not *which* — and without this the results screen shows a 部分完成 badge over
   * a page that lists nothing as unreviewed.
   */
  failedFiles?: number;
  /**
   * The commit the review was actually executed against, when the CLI recorded
   * one. A ref is a name that moves: a branch that advances after the review
   * leaves the code pane showing content nobody reviewed. The CLI freezes the
   * endpoints before the run and keeps them in the manifest, so this is the
   * exact version the findings were written about.
   */
  pinnedCommit?: string;
}

/**
 * The one place a spec is assembled.
 *
 * It is a free function rather than a closure over `form` because resuming a
 * session has to build the spec from a form it is *about to* set: reading
 * `form` right after `setForm` returns the previous value, and that is how
 * 续跑 on a branch-comparison session came to launch a fresh workspace review
 * with no `--resume` at all.
 */
export function specFrom(f: FormState, repoDir: string, resumeId?: string): Spec {
  const scan = f.mode === "scan";
  const spec: Spec = { repo: repoDir.trim(), mode: f.mode };
  if (f.mode === "range") {
    spec.from = f.from.trim();
    spec.to = f.to.trim();
  }
  if (f.mode === "commit") spec.commit = f.commit.trim();
  if (scan) {
    spec.path = f.scanPath.trim();
    spec.noPlan = f.noPlan;
    spec.noDedup = f.noDedup;
    spec.noSummary = f.noSummary;
    spec.batch = f.batch;
  } else {
    spec.effort = f.effort;
    spec.noFilter = f.noFilter;
    spec.backgroundFile = f.backgroundFile.trim();
  }
  spec.exclude = f.exclude.trim();
  spec.background = f.background.trim();
  spec.concurrency = intOrEmpty(f.concurrency);
  spec.maxTokensBudget = intOrEmpty(f.budget);
  spec.timeout = f.timeout.trim() === "0" ? 0 : intOrEmpty(f.timeout);
  spec.maxTokens = intOrEmpty(f.maxTokens);
  spec.maxTools = intOrEmpty(f.maxTools);
  spec.rule = f.rule.trim();
  // Only sent when the user picked one, so the CLI keeps using the globally
  // configured provider/model otherwise.
  if (f.runProvider) spec.provider = f.runProvider;
  if (f.runModel) spec.model = f.runModel;
  if (resumeId) spec.resume = resumeId;
  return spec;
}

/** The form a session's own scope implies, so a resume re-runs the same thing. */function formForSession(f: FormState, s: SessionSummary): FormState {
  if (s.review_mode === "full_scan") return { ...f, mode: "scan", scanPath: "" };
  if (s.review_mode === "commit") return { ...f, mode: "commit", commit: s.diff_commit || "" };
  return { ...f, mode: "range", from: s.diff_from || "", to: s.diff_to || "" };
}

interface Store {
  view: View;
  setView: (v: View) => void;
  info: AppInfo | null;
  config: ConfigView | null;
  reloadConfig: () => Promise<void>;
  providers: Provider[];
  repo: string;
  repoInfo: RepoInfo | null;
  pickRepo: () => Promise<void>;
  setRepo: (dir: string) => void;
  form: FormState;
  patchForm: (patch: Partial<FormState>) => void;
  buildSpec: (resume?: string) => Spec;
  preview: { value: Preview | null; loading: boolean; error: string } | null;
  runPreview: () => Promise<{ count: number; error: string }>;
  running: boolean;
  elapsed: number;
  progress: RunProgress | null;
  runLabel: string;
  /** Whether the run now in progress could be continued, for its own footer. */
  runResumable: boolean;
  startRun: (resume?: string) => Promise<void>;
  resumeSession: (s: SessionSummary) => void;
  cancelRun: () => Promise<void>;
  log: string[];
  clearLog: () => void;
  result: RunResult | null;
  resultOrigin: ResultOrigin | null;
  comments: Finding[];
  loadSession: (s: SessionSummary) => Promise<void>;
  resume: { sessionId: string; reason: string; failed: number; resumable: boolean } | null;
  dismissResume: () => void;
  history: SessionSummary[];
  historyLoading: boolean;
  refreshHistory: () => Promise<void>;
  exportSession: (sessionId: string) => Promise<void>;
  deleteSession: (s: SessionSummary) => Promise<void>;
  saveConfig: (form: Parameters<typeof api.saveConfig>[0]) => Promise<boolean>;
  unsetProvider: () => Promise<void>;
  testLlm: (form?: { name?: string; url: string; protocol: string; model: string; apiKey: string }) => Promise<void>;
  rulesCheck: (path: string) => Promise<void>;
  rulesOutput: string;
  llmTest: { ok: boolean; output: string; via: "form" | "saved" } | null;
  update: UpdateView | null;
  checkUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  ignoreUpdate: () => Promise<void>;
  setUpdateEnabled: (v: boolean) => Promise<void>;
  openReleases: () => Promise<void>;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useStore must be used inside <AppProvider>");
  return ctx;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<View>("review");
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [config, setConfig] = useState<ConfigView | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [repo, setRepoState] = useState("");
  const [repoInfo, setRepoInfo] = useState<RepoInfo | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [preview, setPreview] = useState<Store["preview"]>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [runLabel, setRunLabel] = useState("");
  const [runResumable, setRunResumable] = useState(true);
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<RunResult | null>(null);
  const [resultOrigin, setResultOrigin] = useState<ResultOrigin | null>(null);
  const [resume, setResume] = useState<Store["resume"]>(null);
  const [history, setHistory] = useState<SessionSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [rulesOutput, setRulesOutput] = useState("");
  const [llmTest, setLlmTest] = useState<{ ok: boolean; output: string; via: "form" | "saved" } | null>(null);
  const [update, setUpdate] = useState<Store["update"]>(null);

  useEffect(() => {
    void api.updateState().then(setUpdate);
    return api.onUpdateState((p) => setUpdate((prev) => ({ ...(prev ?? ({} as UpdateView)), ...p })));
  }, []);

  const runId = useRef<string | null>(null);
  const startedAt = useRef(0);
  const tick = useRef<number | null>(null);
  const cancelRequested = useRef(false);
  // The ref a run read its diff from, kept for the results screen: the form can
  // be edited while the run is going, and the findings still describe the code
  // as it was at that ref.
  const runFileRef = useRef("");
  const runMode = useRef<string>("workspace");
  const runScope = useRef("");
  const repoRef = useRef("");
  repoRef.current = repo;

  /**
   * Form fields that change *which files* a run would touch. The preview panel
   * prints "进入审查 N 个文件" and the run button uses that count to decide
   * whether to ask before spending, so a preview that outlives an edit to one
   * of these is a lie about the scope — it used to survive all of them, and
   * switching from 工作区改动 to 分支对比 left the previous count on screen as
   * if it were current. Fields that only affect *how* the run is performed
   * (effort, concurrency, budget, timeout, model, …) deliberately keep it.
   */
  const PREVIEW_KEYS = [
    "mode",
    "from",
    "to",
    "commit",
    "scanPath",
    "exclude",
    "rule",
    "noFilter",
  ] as const;

  const patchForm = useCallback(
    (patch: Partial<FormState>) => {
      setForm((f) => ({ ...f, ...patch }));
      if (PREVIEW_KEYS.some((k) => k in patch && patch[k] !== form[k])) setPreview(null);
    },
    [form]
  );

  const loadConfig = useCallback(async () => {
    setConfig(await api.readConfig());
  }, []);

  const inspect = useCallback(async (dir: string) => {
    const res = await api.inspect(dir);
    if (!res.ok) {
      setRepoInfo(res);
      toast.error(res.error || "无法读取仓库信息");
      return;
    }
    setRepoInfo(res);
    const branch = res.branch || "";
    // A candidate is only a usable base if it names a *different* branch, or the
    // comparison diffs a branch against itself and reviews nothing.
    //
    // `refs` arrives with remote prefixes already stripped, but `upstream` does
    // not — and `@{upstream}` is by definition the current branch's own remote
    // (`origin/master` while on `master`). Compared raw, it always looked like a
    // different ref, so the guard never fired, `from` collapsed onto `to`, and
    // the CLI was handed `--from master --to master`: 0 files, exit 0, and a
    // 分支对比 that silently reviews nothing. So compare on the stripped name.
    //
    // The value is emitted *as given*, though: when a branch really does track a
    // different remote branch, `origin/develop` is the form that always resolves,
    // where a stripped `develop` needs a local branch of that name to exist.
    const stripRemote = (r?: string) => String(r || "").replace(/^(origin|upstream)\//, "");
    const candidates = [
      res.upstream,
      ...(res.refs || []).filter((r) => r === "main" || r === "master"),
      ...(res.refs || []),
    ].filter((c): c is string => Boolean(c) && stripRemote(c) !== branch);
    const rel = res.relations || {};
    const relation = (c: string) => rel[c] || "";

    // Direction is not symmetric: the CLI's merge-base diff `A...B` is empty
    // exactly when B is an ancestor of A. So a base *behind* HEAD is what makes
    // "review my branch" work, and a base *ahead* of HEAD is what breaks it —
    // picking the latter while `to` stayed on HEAD produced a scope that reviews
    // nothing at all, with no explanation, on the very mode whose hint promises
    // "适合评审一条特性分支".
    //
    //   1. ancestor  -> HEAD is ahead: from=it, to=HEAD reviews HEAD's changes.
    //   2. diverged  -> neither contains the other, so either direction has
    //                   content; keep the app's long-standing direction.
    //   3. descendant-> only that branch has content: review *it* instead, so
    //                   from=HEAD, to=it. This is "review the feature branch"
    //                   from the branch it was cut from.
    //   4. no data   -> an older main process that reports no relations: the
    //                   previous heuristic, correct whenever the base is behind.
    const base =
      candidates.find((c) => relation(c) === "ancestor") ||
      candidates.find((c) => relation(c) === "diverged") ||
      (Object.keys(rel).length ? "" : candidates[0]) ||
      "";
    const ahead = base ? "" : candidates.find((c) => relation(c) === "descendant") || "";
    // 单个提交 has a default where 分支对比 sometimes has none: the newest commit,
    // which is what "review the last commit" means. It was the only one of the
    // four modes that opened with its required field empty and its primary
    // action disabled, so the mode read as unfinished rather than as ready.
    const head = (res.commits || [])[0]?.hash || "";
    // No base and nothing ahead is the honest answer for a repository with a
    // single branch — the field stays empty and `validateSpec` says which one is
    // missing, rather than pre-filling a comparison that cannot produce a diff.
    setForm((f) => ({
      ...f,
      from: f.from || base || (ahead ? branch : ""),
      to: f.to || (ahead || branch),
      commit: f.commit || head,
    }));
  }, []);

  const setRepo = useCallback(
    (dir: string) => {
      const trimmed = dir.trim();
      // "Changed" is what makes the scope fields stale — re-inspecting the same
      // repository must not throw away refs the user typed in by hand.
      const changed = trimmed !== repoRef.current;
      setRepoState(trimmed);
      localStorage.setItem("last-repo", trimmed);
      setPreview(null);
      setResume(null);
      // Everything below belongs to the repository it was produced from. The
      // results header exports with `repoRef.current`, so leaving run A's
      // findings on screen after switching to B meant "导出 HTML" would ask the
      // CLI for A's session inside B — the same class of bug the run's own ref
      // and the session's own ref were fixed for, from the other side.
      setResult(null);
      setResultOrigin(null);
      setHistory([]);
      // A rule lookup answers for a file in a repository. Same reason as above.
      setRulesOutput("");
      // The scope fields name things that live *inside* a repository — branches,
      // a commit, a relative path — and `inspect` only fills from/to while they
      // are empty, so a leftover value was never re-derived. After one switch,
      // 分支对比 went on offering the previous repository's branch inside the new
      // one, where it does not exist. Clearing lets `inspect` answer for the
      // repository actually selected. `exclude` and `rule` are deliberately kept:
      // they are user preferences or paths elsewhere on disk, not repo refs.
      if (changed) setForm((f) => ({ ...f, from: "", to: "", commit: "", scanPath: "" }));
      if (trimmed) void inspect(trimmed);
    },
    [inspect]
  );

  const pickRepo = useCallback(async () => {
    const dir = await api.pickRepo();
    if (dir) setRepo(dir);
  }, [setRepo]);

  const buildSpec = useCallback((resumeId?: string): Spec => specFrom(form, repo, resumeId), [form, repo]);

  const applyResult = useCallback((value: RunResult, origin: ResultOrigin & { resumable: boolean }) => {
    setResult(value);
    setResultOrigin(origin);
    const sessionId = value.session_id || "";
    if (sessionId && needsContinuation(value)) {
      const failed = coverageOf(value, "failed");
      setResume({
        sessionId,
        reason: terminalState(value),
        failed: failed.length,
        resumable: origin.resumable,
      });
    } else {
      setResume(null);
    }
  }, []);

  const stopTimer = useCallback(() => {
    if (tick.current) window.clearInterval(tick.current);
    tick.current = null;
    setRunning(false);
  }, []);

  useEffect(() => {
    const offLog = api.onLog(({ line }) => setLog((l) => [...l.slice(-400), line]));
    const offProgress = api.onProgress(({ id, progress: p }) => {
      if (runId.current && id === runId.current) setProgress(p);
    });
    const offExit = api.onExit(({ id, result: r }) => {
      if (!runId.current || id !== runId.current) return;
      stopTimer();
      setProgress(null);
      // A cancel is the user choosing to stop, and the CLI reports it as a
      // non-zero exit. Treating that as a failure put a red 审查失败 toast on
      // exactly the action the app had just offered, and hid the one follow-up
      // that matters: the part that did finish is still there.
      const cancelled = cancelRequested.current;
      cancelRequested.current = false;
      const canResume = resumableMode(runMode.current);
      if (r.error) {
        setRunLabel(cancelled ? "已取消" : "审查失败");
        if (cancelled) {
          setLog((l) => [...l, "[cancelled] 这次审查已停止"]);
          toast("已取消这次审查", {
            description: !r.value && !canResume
              ? "工作区改动的会话不支持续跑，只能重新运行。"
              : r.value
                ? canResume
                  ? "已审完的部分保留在下方；未完成的部分可以续跑，不会重复计费。"
                  : "已审完的部分保留在下方。工作区改动的会话不支持续跑，要接着审请改用「分支对比」或「单个提交」。"
                : "这次运行的会话已保存，到「历史」里可以续跑未完成的部分。",
          });
        } else {
          // The log area is selectable; a toast is not, and it disappears.
          setLog((l) => [...l, "[error] " + r.error]);
          toast.error(r.error.split("\n")[0], { description: r.error.split("\n").slice(1).join("\n") || undefined, duration: 15000 });
        }
      } else {
        setRunLabel("完成");
        toast.success("审查完成", { description: `${r.value?.comments?.length ?? 0} 条评论` });
      }
      if (r.value) {
        // The CLI resolved the endpoints with git before the run started and
        // froze them into the manifest, so the findings belong to that commit —
        // not to whatever the branch holds by the time the code pane is opened.
        const pinned = reviewedCommit(r.value.manifest);
        applyResult(
          { ...r.value, session_id: r.value.session_id || r.sessionId || "" },
          { kind: "run", fileRef: pinned || runFileRef.current, pinnedCommit: pinned, scope: runScope.current, resumable: canResume }
        );
        setView("results");
        // The session the run just wrote is what the results header exports as an
        // HTML report, and it used to be absent from `history` until the user
        // visited that page — so the report button silently disappeared at the
        // one moment a reader most wants it outside the app.
        void refreshHistory();
      } else {
        // A run that produced no payload used to leave `result` exactly as it
        // was: the previous run's findings, or a session opened from 历史. The
        // screen then presented them under a 已取消 / 审查失败 badge and a
        // 完成 status chip, which reads as the outcome of the run that just
        // failed. Nothing on this screen is that run's until it says so.
        setResult(null);
        setResultOrigin(null);
        if (r.sessionId) setResume({ sessionId: r.sessionId, reason: cancelled ? "cancelled" : "failed", failed: 0, resumable: canResume });
      }
      runId.current = null;
    });
    return () => {
      offLog();
      offProgress();
      offExit();
    };
  }, [applyResult, stopTimer]);

  const runSpec = useCallback(
    async (spec: Spec) => {
      const error = validateSpec(spec);
      if (error) {
        toast.warning(error);
        return;
      }
      if (runId.current) {
        toast.warning("已有审查在运行中");
        return;
      }
      runFileRef.current = spec.mode === "range" ? spec.to || "" : spec.mode === "commit" ? spec.commit || "" : "";
      runScope.current =
        spec.mode === "range" ? `${MODE_META.range.label} ${spec.from}…${spec.to}`
        : spec.mode === "commit" ? `${MODE_META.commit.label} ${spec.commit}`
        : spec.mode === "scan" ? MODE_META.scan.label
        : `${MODE_META.workspace.label} ${spec.repo.split(/[\\/]/).pop() || spec.repo}`;
      runMode.current = spec.mode;
      setLog([]);
      setPreview(null);
      setResume(null);
      setProgress(null);
      cancelRequested.current = false;
      setRunning(true);
      setElapsed(0);
      // Watching a run from the form page means watching a wall of configuration.
      // The run belongs on the results page, where it can show progress and,
      // the moment it ends, the findings.
      setView("results");
      startedAt.current = Date.now();
      tick.current = window.setInterval(() => setElapsed(Math.round((Date.now() - startedAt.current) / 1000)), 500);
      setRunLabel(spec.resume ? "续跑中" : "审查运行中");
      setRunResumable(resumableMode(spec.mode));
      let id: string | null = null;
      let ipcFailed = false;
      try {
        id = await api.run(spec);
      } catch (err) {
        // A rejected IPC call must not leave the UI stuck in "running".
        ipcFailed = true;
        toast.error("启动审查失败", { description: String((err as Error)?.message || err) });
      }
      if (!id) {
        stopTimer();
        setRunLabel("启动失败");
        if (!ipcFailed) toast.error("未找到 ocr 可执行文件", { description: "请在项目目录运行 npm install" });
        return;
      }
      runId.current = id;
    },
    [stopTimer]
  );

  const startRun = useCallback(
    async (resumeId?: string) => runSpec(buildSpec(resumeId)),
    [buildSpec, runSpec]
  );

  /**
   * Resume a session from the history list.
   *
   * The row used to patch the form and then start the run in the same tick, so
   * the spec was built from the form as it was *before* the patch: 续跑 on a
   * branch-comparison session launched a fresh workspace review, and because
   * workspace is not resumable the `--resume` id was dropped on the way to the
   * CLI — the user paid for a review of the wrong thing and their session stayed
   * unfinished. The next form and the spec are now derived from one value.
   */
  const resumeSession = useCallback(
    (s: SessionSummary) => {
      const next = formForSession(form, s);
      setForm(next);
      void runSpec(specFrom(next, repo, s.session_id));
    },
    [form, repo, runSpec]
  );

  const cancelRun = useCallback(async () => {
    if (!runId.current) return;
    cancelRequested.current = true;
    await api.cancel(runId.current);
    setRunLabel("已请求取消");
  }, []);

  // Returns how many files would enter the review — and, when there is no
  // number to return, the reason. Both, because the caller has to *say*
  // something: the run button used to call this, read only the count, and
  // return silently on a negative one, so clicking 开始审查 on a scope the CLI
  // had already refused did nothing at all — not even the error the preview had
  // just produced. The error travels with the count so the explanation cannot be
  // lost to a state update that has not rendered yet.
  const runPreview = useCallback(async (): Promise<{ count: number; error: string }> => {
    const spec = buildSpec();
    const invalid = validateSpec(spec);
    if (invalid) {
      toast.warning(invalid);
      return { count: -1, error: invalid };
    }
    setPreview({ value: null, loading: true, error: "" });
    const res = await api.preview(spec);
    if (!res.ok) {
      setPreview({ value: null, loading: false, error: res.error });
      return { count: -1, error: res.error };
    }
    setPreview({ value: res.value, loading: false, error: "" });
    const files = res.value.files || [];
    return { count: res.value.reviewable_count ?? files.filter((f) => f.will_review).length, error: "" };
  }, [buildSpec]);

  const refreshHistory = useCallback(async () => {
    if (!repoRef.current) {
      setHistory([]);
      return;
    }
    setHistoryLoading(true);
    // 0 = every session the CLI knows about. Capping this hid older sessions
    // with no indication that more existed, and saved no work: the CLI reads
    // all of them to sort by start time either way.
    const res = await api.listSessions(repoRef.current, 0);
    setHistoryLoading(false);
    if (res.ok) setHistory(res.value || []);
    else toast.error(`读取历史失败`, { description: res.error });
  }, []);

  const loadSession = useCallback(
    async (s: SessionSummary) => {
      const res = await api.sessionComments(repoRef.current, s.session_id);
      if (!res.ok) {
        toast.error("读取会话失败", { description: res.error });
        return;
      }
      // Manifest first, then the fallback — which infers from the file counts
      // for sessions written before the manifest format existed. It used to say
      // "complete" for all of them, including one that had failed every file.
      const st = (s.run_manifest && s.run_manifest.terminal_state) || sessionState(s);
      applyResult(
        {
          comments: res.value || [],
          status: st,
          session_id: s.session_id,
          llm: { model: s.model },
          manifest: s.run_manifest || null,
          summary: {
            files_reviewed: s.completed_files,
            comments: s.total_comments,
            elapsed: s.duration_ns ? `${Math.round(s.duration_ns / 1e9)}s` : "",
          },
        },
        {
          kind: "session",
          label: s.session_id,
          scope:
            s.review_mode === "range" ? `${MODE_META.range.label} ${s.diff_from}…${s.diff_to}`
            : s.review_mode === "commit" ? `${MODE_META.commit.label} ${s.diff_commit}`
            : s.review_mode === "full_scan" ? MODE_META.scan.label
            : `${MODE_META.workspace.label} ${s.git_branch || ""}`.trim(),
          fileRef: sessionFileRef(s),
          pinnedCommit: reviewedCommit(s.run_manifest),
          failedFiles: s.failed_files || 0,
          resumable: resumableMode(s.review_mode),
        }
      );
      setView("results");
    },
    [applyResult]
  );

  // Takes the id rather than a SessionSummary: the results header offers the
  // same export, and the session it just produced is not in `history` yet.
  const exportSession = useCallback(async (sessionId: string) => {
    const res = await api.exportSession(repoRef.current, sessionId);
    if (res.ok && res.file) toast.success("已导出 HTML 报告", { description: res.file });
    else if (!res.canceled) toast.error("导出失败", { description: res.error });
  }, []);

  const deleteSession = useCallback(async (s: SessionSummary) => {
    const res = await api.deleteSession(repoRef.current, s.session_id);
    if (!res.ok) {
      toast.error("删除失败", { description: res.error });
      return;
    }
    void refreshHistory();
  }, [refreshHistory]);

  const saveConfig = useCallback(
    async (payload: Parameters<typeof api.saveConfig>[0]) => {
      const res = await api.saveConfig(payload);
      if (!res.ok) {
        toast.error("写入配置失败", { description: res.error });
        return false;
      }
      if (res.config) setConfig(res.config);
      toast.success("配置已保存", { description: "建议先点「测试连通」" });
      return true;
    },
    []
  );

  const unsetProvider = useCallback(async () => {
    const c = config;
    if (!c || !c.provider) {
      toast.warning("当前没有已选择的服务");
      return;
    }
    const isCustom = Boolean(c.customProviders[c.provider]);
    const res = await api.unsetConfig(isCustom ? `custom_providers.${c.provider}` : "provider");
    if (!res.ok) {
      toast.error("清除失败", { description: res.error });
      return;
    }
    if (res.config) setConfig(res.config);
    toast.success("已清除当前服务选择");
  }, [config]);

  const testLlm = useCallback(async (form?: { name?: string; url: string; protocol: string; model: string; apiKey: string }) => {
    setLlmTest(null);
    const res = await api.testLlm(form);
    // Keep the full text on screen and selectable: a toast cannot be copied and
    // disappears before the user finishes reading a long vendor error.
    setLlmTest({ ok: res.ok, output: res.output, via: res.via });
    if (res.ok) toast.success("连通正常", { description: res.output.split("\n")[0] });
    else toast.error(res.via === "form" ? "按当前填写的值测不通" : "连通失败", { description: res.output.split("\n").slice(0, 2).join(" ") });
  }, []);

  const rulesCheck = useCallback(
    async (path: string) => {
      if (!repoRef.current) {
        toast.warning("先选择仓库目录");
        return;
      }
      const res = await api.rulesCheck(repoRef.current, path, form.rule.trim());
      if (!res.ok) {
        toast.error("规则查询失败", { description: res.error });
        return;
      }
      setRulesOutput(res.value || "");
    },
    [form.rule]
  );

  useEffect(() => {
    let live = true;
    (async () => {
      const i = await api.info();
      const c = await api.readConfig();
      const p = await api.providers();
      if (!live) return;
      setInfo(i);
      setConfig(c);
      setProviders(p.ok ? p.value : []);
      const remembered = localStorage.getItem("last-repo");
      if (remembered) {
        setRepoState(remembered);
        void inspect(remembered);
      }
      if (!i.binary) toast.error("未找到 ocr 可执行文件", { description: "请在项目目录运行 npm install", duration: 20000 });
    })();
    return () => {
      live = false;
    };
  }, [inspect]);

  const checkUpdate = useCallback(async () => setUpdate(await api.checkUpdate()), []);
  const installUpdate = useCallback(async () => {
    // A rejected install must not be silent, or it repeats the bug the update
    // banner exists to avoid.
    const ok = await api.installUpdate();
    if (!ok) {
      toast.warning("当前形态无法就地更新", { description: "已为你打开下载页" });
      await api.openReleases();
    }
  }, []);
  const ignoreUpdate = useCallback(async () => {
    if (update?.version) setUpdate(await api.ignoreUpdate(update.version));
  }, [update?.version]);
  const setUpdateEnabled = useCallback(async (v: boolean) => {
    const enabled = await api.setUpdateEnabled(v);
    setUpdate((prev) => (prev ? { ...prev, enabled } : prev));
  }, []);
  const openReleases = useCallback(async () => {
    await api.openReleases();
  }, []);

  const comments = useMemo(() => result?.comments ?? [], [result]);

  const value: Store = {
    view,
    setView,
    info,
    config,
    reloadConfig: loadConfig,
    providers,
    repo,
    repoInfo,
    pickRepo,
    setRepo,
    form,
    patchForm,
    buildSpec,
    preview,
    runPreview,
    running,
    elapsed,
    progress,
    runLabel,
    runResumable,
    startRun,
    resumeSession,
    cancelRun,
    log,
    clearLog: () => setLog([]),
    result,
    resultOrigin,
    comments,
    loadSession,
    resume,
    dismissResume: () => setResume(null),
    history,
    historyLoading,
    refreshHistory,
    exportSession,
    deleteSession,
    saveConfig,
    unsetProvider,
    testLlm,
    rulesCheck,
    rulesOutput,
    llmTest,
    update,
    checkUpdate,
    installUpdate,
    ignoreUpdate,
    setUpdateEnabled,
    openReleases,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
