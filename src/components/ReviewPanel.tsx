import { useEffect, useState } from "react";
import {
  ChevronRight,
  FileText,
  FolderSearch,
  Hourglass,
  ListTree,
  Play,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Square,
  TriangleAlert,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { EXCLUDE_REASON } from "@/lib/format";
import { EFFORTS, MODE_META, validateSpec } from "@/lib/spec";
import { useStore } from "@/store";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { Card, FieldGrid, PageBody, Section } from "@/components/ui/layout";
import { Badge, ConfirmDialog } from "@/components/ui/overlay";
import { toast } from "sonner";
import { GuideCard } from "@/components/GuideCard";

// A whole-file scan costs roughly one LLM round trip per file *plus* a planning
// pass — one measured file came to 103K tokens and 3m36s. Past this many files
// the app asks before spending, because the number stops being incidental.
const SCAN_CONFIRM_AT = 20;
const SCAN_TOKENS_PER_FILE = 100_000;
const SCAN_MINUTES_PER_FILE = 3.6;

function RefInput({
  label,
  value,
  onChange,
  placeholder,
  list,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  list?: string;
}) {
  const { repo } = useStore();
  const [state, setState] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const ref = value.trim();
    if (!ref || !repo) {
      setState(null);
      return;
    }
    let live = true;
    const t = setTimeout(async () => {
      const res = await api.resolveRef(repo, ref);
      if (live) setState(res.ok ? { ok: true, text: res.sha?.slice(0, 8) || "" } : { ok: false, text: res.error || "" });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [value, repo]);

  return (
    <Field label={label}>
      <div className="relative">
        <Input
          value={value}
          list={list}
          spellCheck={false}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className={cn(state && !state.ok && "border-bad focus-visible:outline-bad")}
        />
        {state?.ok && <span className="tnum absolute right-2 top-1/2 -translate-y-1/2 font-mono text-meta text-ok">✓ {state.text}</span>}
      </div>
      {state && !state.ok && <span className="text-meta text-bad">{state.text}</span>}
    </Field>
  );
}

export function ReviewPanel() {
  const {
    form,
    patchForm,
    repo,
    repoInfo,
    preview,
    runPreview,
    startRun,
    cancelRun,
    running,
    elapsed,
    runLabel,
    resume,
    dismissResume,
    rulesOutput,
    rulesCheck,
    config,
    providers,
    buildSpec,
  } = useStore();
  const meta = MODE_META[form.mode];
  const scan = form.mode === "scan";

  const configured = { ...(config?.providers || {}), ...(config?.customProviders || {}) };
  const modelOptions = form.runProvider
    ? [...(configured[form.runProvider]?.models || []), configured[form.runProvider]?.model || ""].filter(Boolean)
    : [];
  const providerChoices = [
    { value: "", label: config?.provider ? `跟随全局配置（${config.provider}${config.model ? " · " + config.model : ""}）` : "跟随全局配置（尚未配置服务）" },
    ...Object.keys(configured)
      .map((n) => ({ value: n, label: configured[n]?.hasKey ? `${n}（${configured[n].model || "未填模型"}）` : `${n}（缺 Key）`, group: "已配置" })),
    ...providers
      .filter((p) => !configured[p.name] || !configured[p.name]?.hasKey)
      .map((p) => ({ value: p.name, label: p.name, group: "其他内置服务（需先到设置填 Key）" })),
  ];
  const modelHint = !form.runProvider
    ? "先在左边选一个服务。"
    : modelOptions.length
      ? "该服务已有的模型名在下拉里。"
      : "CLI 不提供模型目录，请按服务商的 API 模型名填写（不是控制台显示名）。";
  const [showTuning, setShowTuning] = useState(false);
  const [ruleProbe, setRuleProbe] = useState("");
  const [confirmScan, setConfirmScan] = useState(false);

  const keep = (preview?.value?.files || []).filter((f) => f.will_review);
  const drop = (preview?.value?.files || []).filter((f) => !f.will_review);

  /**
   * Compute the file list on its own, so the screen can say what a run would
   * touch before money is spent.
   *
   * This used to be a button the user had to think of pressing, which is half of
   * why the page read as a form rather than as a review: the one thing that
   * turns "配置" into a decision — how many files, how big — was hidden behind
   * an extra click. A preview costs no tokens, so the only cost is a git diff.
   *
   * It re-runs when the scope changes (`patchForm` clears `preview` for exactly
   * those keys), debounced so typing a ref does not spawn a process per
   * keystroke, and never when the scope could not be run at all.
   */
  const scopeKey = [repo, form.mode, form.from, form.to, form.commit, form.scanPath, form.exclude, form.rule, String(form.noFilter)].join("|");
  useEffect(() => {
    if (!repo || preview || validateSpec(buildSpec())) return;
    const t = setTimeout(() => void runPreview(), 500);
    return () => clearTimeout(t);
  }, [scopeKey, preview, repo, buildSpec, runPreview]);

  /**
   * Start a run, or say why it would do nothing.
   *
   * The file count has to come from the preview: it is the only thing that
   * knows, and it costs no tokens. The *cached* preview is free to reuse but
   * cannot see edits the user made in their own editor since it was taken, so
   * it is trusted only when it says something is there (any change to the
   * scope itself already clears it). Anything else is re-checked — a run that
   * quietly reviews nothing is worse than a second of work.
   */
  /**
   * The banner's session, but only when it can actually be continued. Offering
   * 续跑 for a workspace session was not merely unhelpful — the CLI rejects it
   * (`resume requires --from/--to or --commit`), so the button was a guaranteed
   * failure on the mode most users are in.
   */
  const resuming = Boolean(resume && resume.sessionId && resume.resumable);

  const startOrExplain = async () => {
    // Resuming continues a session whose scope is already fixed.
    if (resuming && resume) {
      void startRun(resume.sessionId);
      return;
    }
    const cached = preview?.value ? keep.length : null;
    const count = cached && cached > 0 ? cached : await runPreview();
    if (count < 0) return;
    if (count === 0) {
      toast.warning(scan ? "没有文件需要通读" : "当前范围没有文件可审查", {
        description: scan
          ? "换个「扫描路径」，或改用「工作区改动」这类按改动的模式。"
          : "工作区没有改动时属正常，可改用「分支对比」或「单个提交」。",
      });
      return;
    }
    // A scan costs roughly one LLM round trip per file, so its size is worth
    // confirming before it is spent.
    if (scan && count > SCAN_CONFIRM_AT) {
      setConfirmScan(true);
      return;
    }
    void startRun();
  };

  const blocked = validateSpec(buildSpec());

  const scopeSummary = running ? (
    <span className="flex items-center gap-2">
      {runLabel || "审查运行中"}
      <span className="tnum flex items-center gap-1 font-mono text-accent">
        <Hourglass className="size-3.5" />
        {elapsed}s
      </span>
      <span className="text-faint">实时进度在「结果」页</span>
    </span>
  ) : preview?.loading ? (
    <span className="text-faint">正在计算文件清单…</span>
  ) : preview?.error ? (
    <span className="text-bad">范围无法计算：{preview.error.split("\n")[0]}</span>
  ) : preview?.value ? (
    keep.length ? (
      <span>
        <b className="tnum text-ink">{keep.length}</b> 个文件进入审查
        <span className="tnum text-faint">
          {" "}
          · {scan ? `${preview.value.total_insertions} 行待通读` : `+${preview.value.total_insertions} / -${preview.value.total_deletions}`}
        </span>
        {drop.length > 0 && <span className="text-faint"> · 另有 {drop.length} 个被排除</span>}
      </span>
    ) : (
      <span className="text-warn">
        当前范围 {preview.value.total_files} 个文件，没有一个进入审查
      </span>
    )
  ) : (
    <span className="text-faint">{blocked || "正在准备…"}</span>
  );

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        {/* Natural height when the page has little to say, capped so the file
            region below always keeps its share — the guide card and the open
            tuning panel together are taller than any window. */}
        <div className="max-h-[55%] min-h-0 shrink-0 overflow-y-auto">
          <PageBody>
            <GuideCard />

            <Section
              title="审查范围"
              actions={<code className="rounded-xs bg-raised px-1.5 py-0.5 font-mono text-meta text-faint">{meta.command}</code>}
            >
              {/* Half the measure, so the control's segments stay a comfortable width
                  and its right edge lines up with the first form column below it. */}
              <div className="flex max-w-[calc((100%-1rem)/2)] gap-1 rounded-md border border-line bg-raised p-1">
                {Object.entries(MODE_META)
                  .filter(([mode]) => mode !== "scan")
                  .map(([mode, m]) => (
                    <button
                      key={mode}
                      onClick={() => patchForm({ mode: mode as keyof typeof MODE_META })}
                      className={cn(
                        "flex-1 rounded-sm px-2 py-1.5 text-body transition-colors duration-150",
                        form.mode === mode ? "bg-accent-solid text-accent-ink font-medium" : "text-muted hover:bg-hover hover:text-ink"
                      )}
                    >
                      {m.label}
                    </button>
                  ))}
                <span className="my-1 w-px shrink-0 bg-line" />
                <button
                  onClick={() => patchForm({ mode: "scan" })}
                  className={cn(
                    "flex items-center gap-1.5 rounded-sm px-2.5 py-1.5 text-body transition-colors duration-150",
                    form.mode === "scan" ? "bg-accent-solid text-accent-ink font-medium" : "text-muted hover:bg-hover hover:text-ink"
                  )}
                >
                  {MODE_META.scan.label}
                  <span className={cn("rounded-xs px-1 text-meta", form.mode === "scan" ? "bg-black/20" : "bg-raised text-faint")}>整库 · 贵</span>
                </button>
              </div>
              <p className="mt-2 text-meta text-faint">{meta.hint}</p>

              {(form.mode === "range" || form.mode === "commit" || scan) && (
                <FieldGrid className="mt-4">
                  {form.mode === "range" && (
                    <>
                      <RefInput label="基线 (from)" value={form.from} onChange={(v) => patchForm({ from: v })} placeholder="main" list="ref-list" />
                      <RefInput label="目标 (to)" value={form.to} onChange={(v) => patchForm({ to: v })} placeholder="feature/x" list="ref-list" />
                    </>
                  )}
                  {form.mode === "commit" && (
                    <div className="col-span-full">
                      <RefInput label="提交" value={form.commit} onChange={(v) => patchForm({ commit: v })} placeholder="abc1234" list="commit-list" />
                    </div>
                  )}
                  {scan && (
                    <div className="col-span-full">
                      <Field label="扫描路径" hint="仓库内相对路径，逗号分隔；留空为整个仓库。">
                        <div className="flex gap-2">
                          <Input
                            value={form.scanPath}
                            spellCheck={false}
                            placeholder="src/main/java,src/main/resources"
                            onChange={(e) => patchForm({ scanPath: e.target.value })}
                          />
                          <Button
                            variant="default"
                            onClick={async () => {
                              const res = await api.pickScanDir(repo);
                              if (res.relPath !== undefined) patchForm({ scanPath: res.relPath });
                            }}
                            disabled={!repo}
                          >
                            <FolderSearch className="size-3.5" />
                            选目录
                          </Button>
                        </div>
                      </Field>
                    </div>
                  )}
                </FieldGrid>
              )}
            </Section>

            <Card
              padded={false}
              title={
                <button
                  type="button"
                  onClick={() => setShowTuning((s) => !s)}
                  aria-expanded={showTuning}
                  className="flex items-center gap-2 font-medium text-muted transition-colors hover:text-ink"
                >
                  <ChevronRight className={cn("size-3.5 transition-transform duration-150", showTuning && "rotate-90")} />
                  <SlidersHorizontal className="size-3.5" />
                  调整这次审查的参数
                </button>
              }
              actions={
                <span className="text-meta text-faint">
                  {showTuning ? "收起" : "都有可用默认值，直接开始即可"}
                </span>
              }
            >
              {showTuning && (
                <div className="space-y-5 border-t border-line p-4">
                  <FieldGrid>
                    <Field label="投入档位" htmlFor="effort" hint={scan ? "全量扫描不支持投入档位。" : "档位越高越慢、越费 token。"}>
                      <Select
                        id="effort"
                        value={form.effort}
                        onValueChange={(v) => patchForm({ effort: v })}
                        disabled={scan}
                        options={EFFORTS.map((e) => ({ value: e.value, label: e.label }))}
                      />
                    </Field>
                    <Field label="并发子任务" htmlFor="concurrency" hint="同时审几个文件，8 是稳妥的默认值。">
                      <Input
                        id="concurrency"
                        type="number"
                        min={1}
                        max={32}
                        value={form.concurrency}
                        placeholder="8"
                        className="max-w-[200px]"
                        onChange={(e) => patchForm({ concurrency: e.target.value })}
                      />
                    </Field>

                    <Field label="本次使用的服务" hint="对应 CLI 的 --provider。留空则用「设置」里配置的服务。">
                      <Select
                        value={form.runProvider}
                        onValueChange={(v) => patchForm({ runProvider: v, runModel: "" })}
                        options={providerChoices}
                      />
                    </Field>
                    <Field label="本次使用的模型" hint={modelHint}>
                      <Input
                        value={form.runModel}
                        list="model-list"
                        spellCheck={false}
                        placeholder={form.runProvider ? "留空则用该服务已保存的模型" : "跟随全局配置"}
                        disabled={!form.runProvider}
                        onChange={(e) => patchForm({ runModel: e.target.value })}
                      />
                    </Field>
                    <datalist id="model-list">
                      {modelOptions.map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                  </FieldGrid>

                  <div className="border-t border-line pt-5">
                    <p className="mb-4 text-meta text-faint">花钱的护栏：达到上限会保留已审结果并停下，剩余文件不再派发。</p>
                    <FieldGrid>
                      <Field label="总 token 上限（输入+输出）">
                        <div className="flex gap-2">
                          <Input
                            type="number"
                            min={0}
                            step={10000}
                            value={form.budget}
                            placeholder="0 = 不限"
                            className="max-w-[200px]"
                            onChange={(e) => patchForm({ budget: e.target.value })}
                          />
                          <div className="flex items-center gap-1.5">
                            {[100000, 300000, 1000000].map((n) => (
                              <button
                                key={n}
                                onClick={() => patchForm({ budget: String(n) })}
                                className="rounded-xs border border-line px-1.5 py-0.5 text-meta text-muted transition-colors hover:border-accent hover:text-accent"
                              >
                                {n / 10000}万
                              </button>
                            ))}
                          </div>
                        </div>
                      </Field>
                      <Field label="整体超时（分钟）" hint="0 = 不限时；默认 15 分钟。">
                        <Input
                          type="number"
                          min={0}
                          value={form.timeout}
                          placeholder="15"
                          className="max-w-[200px]"
                          onChange={(e) => patchForm({ timeout: e.target.value })}
                        />
                      </Field>
                    </FieldGrid>
                  </div>

                  <div className="border-t border-line pt-5">
                    <FieldGrid>
                      <Field label="排除模式" hint="逗号分隔的 gitignore 样式，会与规则文件里的排除合并。">
                        <Input
                          value={form.exclude}
                          spellCheck={false}
                          placeholder="**/generated/*,**/testdata/*"
                          onChange={(e) => patchForm({ exclude: e.target.value })}
                        />
                      </Field>
                      <Field label="需求文档（Markdown）" hint="对应 --background-file，优先于下面的文本。全量扫描不支持。">
                        <div className="flex gap-2">
                          <Input
                            value={form.backgroundFile}
                            spellCheck={false}
                            placeholder="docs/requirements.md"
                            disabled={scan}
                            onChange={(e) => patchForm({ backgroundFile: e.target.value })}
                          />
                          <Button
                            variant="default"
                            disabled={scan}
                            title="选择需求文档"
                            onClick={async () => {
                              const p = await api.pickFile({ title: "选择需求文档", filters: [{ name: "Markdown", extensions: ["md", "txt"] }] });
                              if (p) patchForm({ backgroundFile: p });
                            }}
                          >
                            <FileText className="size-3.5" />
                          </Button>
                        </div>
                      </Field>
                      <div className="col-span-full">
                        <Field label="业务背景（可选，能显著提升判断准确度）">
                          <Textarea
                            value={form.background}
                            placeholder="例如：给登录接口加限流，阈值按租户配置。"
                            onChange={(e) => patchForm({ background: e.target.value })}
                          />
                        </Field>
                      </div>
                      <Field label="单组 prompt token 上限" hint="0 = 模板默认。">
                        <Input
                          type="number"
                          min={0}
                          value={form.maxTokens}
                          placeholder="0"
                          className="max-w-[200px]"
                          onChange={(e) => patchForm({ maxTokens: e.target.value })}
                        />
                      </Field>
                      <Field label="每组最多工具调用轮数" hint="0 = 模板默认。">
                        <Input
                          type="number"
                          min={0}
                          value={form.maxTools}
                          placeholder="0"
                          className="max-w-[200px]"
                          onChange={(e) => patchForm({ maxTools: e.target.value })}
                        />
                      </Field>
                      <div className="col-span-full">
                        <Field label="自定义规则文件（rule.json）" hint="留空使用官方内置的多语言规则集。">
                          <div className="flex gap-2">
                            <Input
                              value={form.rule}
                              spellCheck={false}
                              placeholder="留空使用内置规则"
                              onChange={(e) => patchForm({ rule: e.target.value })}
                            />
                            <Button
                              variant="default"
                              onClick={async () => {
                                const p = await api.pickFile({ title: "选择规则文件", filters: [{ name: "rule JSON", extensions: ["json"] }] });
                                if (p) patchForm({ rule: p });
                              }}
                            >
                              选择
                            </Button>
                          </div>
                        </Field>
                      </div>
                      <div className="col-span-full">
                        <Field label="规则查询" hint="查询某个文件会命中哪条规则，不花 token。">
                          <div className="flex gap-2">
                            <Input
                              value={ruleProbe}
                              spellCheck={false}
                              placeholder="internal/auth/login.go"
                              onChange={(e) => setRuleProbe(e.target.value)}
                            />
                            <Button variant="outline" disabled={!ruleProbe.trim() || !repo} onClick={() => void rulesCheck(ruleProbe.trim())}>
                              查询
                            </Button>
                          </div>
                        </Field>
                      </div>
                      {!scan && (
                        <div className="col-span-full">
                          <Checkbox
                            checked={form.noFilter}
                            onCheckedChange={(v) => patchForm({ noFilter: v })}
                            label="保留全部评论（跳过模型的二次筛选）— 能减少漏报，但误报会变多"
                          />
                        </div>
                      )}
                      {scan && (
                        <>
                          <Checkbox checked={form.noPlan} onCheckedChange={(v) => patchForm({ noPlan: v })} label="跳过逐文件规划 (PLAN_TASK)" />
                          <Checkbox checked={form.noDedup} onCheckedChange={(v) => patchForm({ noDedup: v })} label="跳过同批去重 (DEDUP_TASK)" />
                          <Checkbox checked={form.noSummary} onCheckedChange={(v) => patchForm({ noSummary: v })} label="跳过项目级总结" />
                          <Field label="分批策略">
                            <Select
                              value={form.batch}
                              onValueChange={(v) => patchForm({ batch: v })}
                              options={[
                                { value: "", label: "默认" },
                                { value: "none", label: "none" },
                                { value: "by-language", label: "by-language" },
                                { value: "by-directory", label: "by-directory" },
                              ]}
                            />
                          </Field>
                        </>
                      )}
                    </FieldGrid>
                  </div>
                </div>
              )}
            </Card>

            {resume && (
              <Card tone="warn" padded={false}>
                <div className="flex items-start gap-2 p-4">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
                  <div className="min-w-0 flex-1 text-body text-ink">
                    {resume.resumable ? (
                      <>
                        这次运行没有全部完成{resume.failed ? `（${resume.failed} 个文件失败）` : ""}，会话{" "}
                        <code className="font-mono text-meta text-muted">{resume.sessionId.slice(0, 12)}…</code>
                        。保持同样的范围与模型服务点下面的「续跑未完成部分」，已完成的部分不会重复付费。
                      </>
                    ) : (
                      <>工作区改动的会话不支持续跑（{meta.hint.split("。")[1] || "请重新运行"}）。</>
                    )}
                  </div>
                  <Button variant="ghost" size="sm" onClick={dismissResume}>
                    忽略
                  </Button>
                </div>
              </Card>
            )}

            {rulesOutput && (
              <Card
                padded={false}
                title={<Badge tone="accent">适用规则</Badge>}
                hint={<span className="truncate font-mono">{ruleProbe}</span>}
                actions={
                  <Button variant="ghost" size="sm" onClick={() => setShowTuning(false)}>
                    关闭
                  </Button>
                }
              >
                <pre className="max-h-64 overflow-auto px-4 py-3 font-mono text-meta whitespace-pre-wrap text-muted selectable">
                  {rulesOutput}
                </pre>
              </Card>
            )}
          </PageBody>
        </div>

        {/* What the review is about to read, in the region that fills the
            window. This is the answer to "the product is a configuration form":
            with the knobs collapsed, everything left on screen is the code. It
            also removes the void the launcher used to end in — a page whose
            content is top-aligned and shorter than the window reads as broken
            regardless of how little is on it. */}
        <section className="flex min-h-0 flex-1 flex-col border-t border-line bg-surface">
          <div className="flex shrink-0 items-center gap-2 border-b border-line px-6 py-2">
            <ListTree className="size-3.5 shrink-0 text-accent" />
            <h2 className="shrink-0 text-strong font-semibold text-ink">进入审查的文件</h2>
            <span className="min-w-0 truncate text-meta text-faint">
              {preview?.value ? `不消耗 token · 共 ${preview.value.total_files} 个改动文件` : "范围确定后自动计算"}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto shrink-0"
              disabled={preview?.loading}
              onClick={() => void runPreview()}
            >
              <RefreshCw className="size-3.5" />
              重新计算
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-1">
            {blocked ? (
              <p className="px-1 py-6 text-center text-body text-faint">{blocked}</p>
            ) : !preview || preview.loading ? (
              <p className="px-1 py-6 text-center text-body text-faint">正在计算文件清单…</p>
            ) : preview.error ? (
              <p className="whitespace-pre-wrap px-1 py-6 text-center text-body text-bad">{preview.error}</p>
            ) : (
              <>
                {keep.length === 0 && (
                  <p className="px-1 py-6 text-center text-body text-faint">
                    没有文件进入审查。工作区没有改动时属正常，可改用「分支对比」或「单个提交」。
                  </p>
                )}
                {keep.map((f) => (
                  <div key={f.path} className="flex items-center gap-3 border-b border-line/60 py-2 last:border-b-0">
                    <span className="min-w-0 flex-1 truncate font-mono text-body text-ink">{f.path}</span>
                    <span className="tnum shrink-0 text-meta text-faint">
                      {f.status}
                      {scan ? ` · ${f.insertions} 行` : ` · +${f.insertions} / -${f.deletions}`}
                    </span>
                  </div>
                ))}
                {drop.length > 0 && (
                  <>
                    <div className="mt-3 mb-1 text-meta text-faint">以下 {drop.length} 个不进入审查</div>
                    {drop.map((f) => (
                      <div key={f.path} className="flex items-center gap-3 border-b border-line/40 py-2 last:border-b-0">
                        <span className="min-w-0 flex-1 truncate font-mono text-body text-muted">{f.path}</span>
                        <span className="shrink-0 text-meta text-faint">{EXCLUDE_REASON[f.exclude_reason || ""] || f.exclude_reason}</span>
                      </div>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        </section>

        {/* The run action is the point of the page, and it used to sit below
            every knob the page owns — at the 1000x660 floor the button was not
            on screen at all. It is pinned here so 范围 → 开始 is always one
            glance and one click, however the two regions above it scroll. */}
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-line bg-raised px-6 py-3">
          <div className="min-w-0 flex-1 text-body text-muted">{scopeSummary}</div>
          {running && (
            <Button variant="danger" size="lg" onClick={() => void cancelRun()}>
              <Square className="size-4" />
              取消
            </Button>
          )}
          {/* Disabled only when the run cannot start at all (no repo, a mode
              missing its refs) — the bar's own text is the explanation, sitting
              next to the button. A scope that is valid but empty stays
              clickable, because clicking it explains what to change. */}
          <Button
            variant="primary"
            size="lg"
            disabled={running || Boolean(blocked)}
            title={blocked || undefined}
            onClick={() => void startOrExplain()}
          >
            {resuming ? <RotateCcw className="size-4" /> : <Play className="size-4" />}
            {running ? "审查运行中…" : resuming ? "续跑未完成部分" : "开始审查"}
          </Button>
        </div>
      </div>

      <datalist id="ref-list">
        {(repoInfo?.refs || []).map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      <datalist id="commit-list">
        {(repoInfo?.commits || []).map((c) => (
          <option key={c.hash} value={c.hash}>
            {c.date} — {c.message}
          </option>
        ))}
      </datalist>

      <ConfirmDialog
        open={confirmScan}
        onOpenChange={setConfirmScan}
        title="这次扫描的规模不小"
        confirmLabel="仍然开始"
        danger
        description={(() => {
          const files = keep.length;
          const conc = Math.max(1, Number(form.concurrency.trim()) || 8);
          const minutes = (files * SCAN_MINUTES_PER_FILE) / conc;
          return (
            <span className="block space-y-1.5">
              <span className="block">
                全量扫描 <b className="text-ink">{files}</b> 个文件：每个文件先做一次预分析、再带着工具逐段读，按一次实测样本（单文件约 10 万 token、3–4 分钟）估算，这次大概要
                <b className="text-ink"> {(files * SCAN_TOKENS_PER_FILE) / 10_000} 万 token</b>、
                <b className="text-ink"> {minutes < 60 ? `${Math.round(minutes)} 分钟` : `${(minutes / 60).toFixed(1)} 小时`}</b>
                （并发 {conc}）。
              </span>
              <span className="block text-faint">
                {form.budget.trim() ? `你设的总 token 上限是 ${form.budget.trim()}，达到上限会保留已审结果并停下。` : "你没有设总 token 上限（0 = 不限），中途只能靠「取消」。"}
                {form.timeout.trim() && form.timeout.trim() !== "0" ? ` 整体超时 ${form.timeout.trim()} 分钟，到点会变成部分完成，可用会话续跑。` : ""}
              </span>
              <span className="block text-faint">只想审改动的话，「工作区改动」或「分支对比」便宜一到两个数量级；整库审计建议按目录分几次跑（扫描路径填 PNOS.API/Controllers 这样）。</span>
            </span>
          );
        })()}
        onConfirm={() => {
          setConfirmScan(false);
          void startRun();
        }}
      />
    </>
  );
}
