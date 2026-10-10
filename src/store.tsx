import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { api, type Provider } from "@/lib/api";
import { coverageOf, needsContinuation, terminalState } from "@/lib/format";
import { intOrEmpty, validateSpec } from "@/lib/spec";
import type {
  AppInfo,
  ConfigView,
  Finding,
  Preview,
  RepoInfo,
  ReviewMode,
  RunResult,
  SessionSummary,
  Spec,
  UpdateView,
} from "@/lib/types";

export type View = "review" | "results" | "history" | "settings";

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
  noFilter: false,
  noPlan: false,
  noDedup: false,
  noSummary: false,
  batch: "",
};

export interface ResultOrigin {
  kind: "run" | "session";
  label?: string;
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
  runPreview: () => Promise<void>;
  running: boolean;
  elapsed: number;
  runLabel: string;
  startRun: (resume?: string) => Promise<void>;
  cancelRun: () => Promise<void>;
  log: string[];
  clearLog: () => void;
  result: RunResult | null;
  resultOrigin: ResultOrigin | null;
  comments: Finding[];
  loadSession: (s: SessionSummary) => Promise<void>;
  resume: { sessionId: string; reason: string; failed: number } | null;
  dismissResume: () => void;
  history: SessionSummary[];
  historyLoading: boolean;
  refreshHistory: () => Promise<void>;
  exportSession: (s: SessionSummary) => Promise<void>;
  deleteSession: (s: SessionSummary) => Promise<void>;
  saveConfig: (form: Parameters<typeof api.saveConfig>[0]) => Promise<boolean>;
  unsetProvider: () => Promise<void>;
  testLlm: () => Promise<void>;
  rulesCheck: (path: string) => Promise<void>;
  rulesOutput: string;
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
  const [runLabel, setRunLabel] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<RunResult | null>(null);
  const [resultOrigin, setResultOrigin] = useState<ResultOrigin | null>(null);
  const [resume, setResume] = useState<Store["resume"]>(null);
  const [history, setHistory] = useState<SessionSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [rulesOutput, setRulesOutput] = useState("");
  const [update, setUpdate] = useState<Store["update"]>(null);

  useEffect(() => {
    void api.updateState().then(setUpdate);
    return api.onUpdateState((p) => setUpdate((prev) => ({ ...(prev ?? ({} as UpdateView)), ...p })));
  }, []);

  const runId = useRef<string | null>(null);
  const startedAt = useRef(0);
  const tick = useRef<number | null>(null);
  const repoRef = useRef("");
  repoRef.current = repo;

  const patchForm = useCallback((patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch })), []);

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
    const candidates = [res.upstream, ...(res.refs || []).filter((r) => r === "main" || r === "master"), (res.refs || [])[0]];
    const base = candidates.find((c) => c && c !== branch) || "";
    setForm((f) => ({
      ...f,
      from: f.from || base.replace(/^origin\//, ""),
      to: f.to || branch,
    }));
  }, []);

  const setRepo = useCallback(
    (dir: string) => {
      const trimmed = dir.trim();
      setRepoState(trimmed);
      localStorage.setItem("last-repo", trimmed);
      setPreview(null);
      setResume(null);
      if (trimmed) void inspect(trimmed);
    },
    [inspect]
  );

  const pickRepo = useCallback(async () => {
    const dir = await api.pickRepo();
    if (dir) setRepo(dir);
  }, [setRepo]);

  const buildSpec = useCallback(
    (resumeId?: string): Spec => {
      const scan = form.mode === "scan";
      const spec: Spec = { repo: repo.trim(), mode: form.mode };
      if (form.mode === "range") {
        spec.from = form.from.trim();
        spec.to = form.to.trim();
      }
      if (form.mode === "commit") spec.commit = form.commit.trim();
      if (scan) {
        spec.path = form.scanPath.trim();
        spec.noPlan = form.noPlan;
        spec.noDedup = form.noDedup;
        spec.noSummary = form.noSummary;
        spec.batch = form.batch;
      } else {
        spec.effort = form.effort;
        spec.noFilter = form.noFilter;
        spec.backgroundFile = form.backgroundFile.trim();
      }
      spec.exclude = form.exclude.trim();
      spec.background = form.background.trim();
      spec.concurrency = intOrEmpty(form.concurrency);
      spec.maxTokensBudget = intOrEmpty(form.budget);
      spec.timeout = form.timeout.trim() === "0" ? 0 : intOrEmpty(form.timeout);
      spec.maxTokens = intOrEmpty(form.maxTokens);
      spec.maxTools = intOrEmpty(form.maxTools);
      spec.rule = form.rule.trim();
      if (resumeId) spec.resume = resumeId;
      return spec;
    },
    [form, repo]
  );

  const applyResult = useCallback((value: RunResult, origin: ResultOrigin) => {
    setResult(value);
    setResultOrigin(origin);
    const sessionId = value.session_id || "";
    if (sessionId && needsContinuation(value)) {
      const failed = coverageOf(value, "failed");
      setResume({
        sessionId,
        reason: terminalState(value),
        failed: failed.length,
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
    const offExit = api.onExit(({ id, result: r }) => {
      if (!runId.current || id !== runId.current) return;
      stopTimer();
      if (r.error) {
        setRunLabel("审查失败");
        toast.error(r.error.split("\n")[0], { description: r.error.split("\n").slice(1).join(" ") || undefined, duration: 12000 });
      } else {
        setRunLabel("完成");
        toast.success("审查完成", { description: `${r.value?.comments?.length ?? 0} 条评论` });
      }
      if (r.value) {
        applyResult({ ...r.value, session_id: r.value.session_id || r.sessionId || "" }, { kind: "run" });
        setView("results");
      } else if (r.sessionId) {
        setResume({ sessionId: r.sessionId, reason: "failed", failed: 0 });
      }
      runId.current = null;
    });
    return () => {
      offLog();
      offExit();
    };
  }, [applyResult, stopTimer]);

  const startRun = useCallback(
    async (resumeId?: string) => {
      const spec = buildSpec(resumeId);
      const error = validateSpec(spec);
      if (error) {
        toast.warning(error);
        return;
      }
      if (runId.current) {
        toast.warning("已有审查在运行中");
        return;
      }
      setLog([]);
      setPreview(null);
      setResume(null);
      setRunning(true);
      setElapsed(0);
      startedAt.current = Date.now();
      tick.current = window.setInterval(() => setElapsed(Math.round((Date.now() - startedAt.current) / 1000)), 500);
      setRunLabel(resumeId ? "续跑中" : "审查运行中");
      const id = await api.run(spec);
      if (!id) {
        stopTimer();
        setRunLabel("启动失败");
        toast.error("未找到 ocr 可执行文件", { description: "请在项目目录运行 npm install" });
        return;
      }
      runId.current = id;
    },
    [buildSpec, stopTimer]
  );

  const cancelRun = useCallback(async () => {
    if (!runId.current) return;
    await api.cancel(runId.current);
    setRunLabel("已请求取消");
  }, []);

  const runPreview = useCallback(async () => {
    const spec = buildSpec();
    const error = validateSpec(spec);
    if (error) {
      toast.warning(error);
      return;
    }
    setPreview({ value: null, loading: true, error: "" });
    const res = await api.preview(spec);
    setPreview(res.ok ? { value: res.value, loading: false, error: "" } : { value: null, loading: false, error: res.error });
  }, [buildSpec]);

  const refreshHistory = useCallback(async () => {
    if (!repoRef.current) {
      setHistory([]);
      return;
    }
    setHistoryLoading(true);
    const res = await api.listSessions(repoRef.current, 50);
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
      const st = (s.run_manifest && s.run_manifest.terminal_state) || (s.aborted ? "aborted" : "complete");
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
        { kind: "session", label: s.session_id }
      );
      setView("results");
    },
    [applyResult]
  );

  const exportSession = useCallback(async (s: SessionSummary) => {
    const res = await api.exportSession(repoRef.current, s.session_id);
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

  const testLlm = useCallback(async () => {
    const res = await api.testLlm();
    if (res.ok) toast.success("连通正常", { description: res.output.split("\n").slice(0, 2).join(" ") });
    else toast.error("连通失败", { description: res.output, duration: 15000 });
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
    runLabel,
    startRun,
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
    update,
    checkUpdate,
    installUpdate,
    ignoreUpdate,
    setUpdateEnabled,
    openReleases,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
