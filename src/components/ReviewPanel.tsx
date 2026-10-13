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
import { EXCLUDE_REASON, cliReason } from "@/lib/format";
import { EFFORTS, EMPTY_SCOPE, MODE_META, validateSpec } from "@/lib/spec";
import { useStore } from "@/store";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { Card, FieldGrid, Measure, PageBody, ScrollArea, Section } from "@/components/ui/layout";
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
    pickRepo,
    setView,
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
   * The CLI's own wording for a scope it refused, kept for copying — but only
   * when it adds something the translated line does not. It usually does not:
   * the hint is derived *from* it, so printing both would say the same thing
   * twice in the same place.
   */
  const previewDetail = (() => {
    if (!preview?.error) return "";
    const raw = preview.error
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trim().startsWith("→"))
      .join("\n")
      .trim();
    return raw === cliReason(preview.error) ? "" : raw;
  })();

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
    const result = cached && cached > 0 ? { count: cached, error: "" } : await runPreview();
    // The one outcome this button must never produce is silence. It used to:
    // a scope the CLI refuses (a mistyped ref, a directory that is not a git
    // root) made the preview fail, and the click returned without a word while
    // the button stayed enabled — so the app's primary action looked broken and
    // the user had no way to tell what it wanted. The reason now travels back
    // with the count and is shown, whatever it is.
    if (result.count < 0) {
      toast.warning("这次审查没能开始", {
        description: `${cliReason(result.error) || "这个范围现在算不出文件清单。"}\n改好上面的范围后按钮会恢复可用。`,
        duration: 12000,
      });
      return;
    }
    const count = result.count;
    if (count === 0) {
      toast.warning(EMPTY_SCOPE[form.mode].title, { description: EMPTY_SCOPE[form.mode].detail });
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
  // A remembered repository can stop existing — a temp directory cleaned up, a
  // clone deleted, a drive letter that moved. `inspect()` already knows, and
  // until now the page still offered 开始审查 for the dead path and surfaced the
  // doomed spawn as a raw error line naming the *executable*.
  const repoGone = repo && repoInfo && !repoInfo.ok ? repoInfo.error || "仓库目录打不开" : "";
  // A run with no model behind it can only fail, and until now the app let it
  // start and reported the CLI's `no valid LLM endpoint configured` as a toast
  // after spawning a process. `ready` is the same predicate the top bar's badge
  // already uses, so this is not a new guess about the CLI's state.
  const llmBlocked = config && !config.ready ? config.blockedReason || "还没有配置模型服务" : "";
  /**
   * A scope the CLI has already refused — a ref that does not resolve, a
   * directory that is not a git root.
   *
   * `validateSpec` cannot see this: it knows a ref is *present*, not that it
   * exists, so the button stayed enabled for a range that could never run and
   * clicking it was a no-op. The preview has already asked the question and been
   * refused, so the answer is known here — the same "a precondition the app
   * knows about but does not act on" the results page was fixed for.
   */
  const scopeUnresolvable = !running && !preview?.loading && preview?.error ? preview.error : "";
  const disabledReason =
    blocked || repoGone || llmBlocked || (scopeUnresolvable ? `范围无法计算：${cliReason(scopeUnresolvable)}` : "");

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
    <span className="text-bad">范围无法计算：{cliReason(preview.error)}</span>
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
        <ScrollArea grow={false} className="max-h-[55%]">
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
                    // One column, like the two range refs — not `col-span-full`.
                    // A commit is a short hash, and across the full measure the
                    // resolved-SHA tick that confirms it landed ~700px away from
                    // the value it confirms. The three diff modes now put the
                    // same kind of control at the same width.
                    <RefInput label="提交" value={form.commit} onChange={(v) => patchForm({ commit: v })} placeholder="abc1234" list="commit-list" />
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
                hint={<span className="truncate font-mono" title={ruleProbe}>{ruleProbe}</span>}
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
        </ScrollArea>

        {/* What the review is about to read, in the region that fills the
            window. This is the answer to "the product is a configuration form":
            with the knobs collapsed, everything left on screen is the code. It
            also removes the void the launcher used to end in — a page whose
            content is top-aligned and shorter than the window reads as broken
            regardless of how little is on it. */}
        <section className="flex min-h-0 flex-1 flex-col border-t border-line bg-surface">
          <div className="shrink-0 border-b border-line">
            <Measure className="flex items-center gap-2 px-6 py-2">
              <ListTree className="size-3.5 shrink-0 text-accent" />
              <h2 className="shrink-0 text-strong font-semibold text-ink">进入审查的文件</h2>
              <span className="min-w-0 truncate text-meta text-faint">
                {preview?.value
                  ? `不消耗 token · 共 ${preview.value.total_files} 个${scan ? "" : "改动"}文件`
                  : "范围确定后自动计算"}
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
            </Measure>
          </div>
          <ScrollArea>
            <Measure className="px-6 py-1">
              {blocked ? (
                <p className="px-1 py-6 text-center text-body text-faint">{blocked}</p>
              ) : !preview || preview.loading ? (
                <p className="px-1 py-6 text-center text-body text-faint">正在计算文件清单…</p>
              ) : preview.error ? (
                // Lead with the sentence that says what to change; the CLI's own
                // wording follows, small and selectable, because it is what gets
                // pasted into a bug report.
                <div className="px-1 py-6 text-center">
                  <p className="text-body text-bad">{cliReason(preview.error)}</p>
                  {previewDetail && (
                    <p className="mx-auto mt-1.5 max-w-[var(--page-max-narrow)] whitespace-pre-wrap font-mono text-meta text-faint selectable">
                      {previewDetail}
                    </p>
                  )}
                </div>
              ) : (
                <>
                  {keep.length === 0 && (
                    // Advice has to match the mode that produced the empty scope,
                    // and it has to be actionable. The old sentence was written
                    // for 工作区改动 and shown to every mode, so a 分支对比 with an
                    // empty diff was told to "改用「分支对比」" — the mode it was
                    // already in. Each mode now names its own reason, and the
                    // sentence that used to be prose ("可改用…") is a button.
                    <div className="mx-auto max-w-[var(--page-max-narrow)] px-1 py-6 text-center">
                      <p className="text-body text-warn">{EMPTY_SCOPE[form.mode].title}</p>
                      <p className="mt-1.5 text-meta text-faint">{EMPTY_SCOPE[form.mode].detail}</p>
                      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                        {EMPTY_SCOPE[form.mode].alternatives.map((m) => (
                          <Button key={m} variant="outline" size="sm" onClick={() => patchForm({ mode: m })}>
                            改用{MODE_META[m].label}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}
                  {keep.map((f) => (
                    <div key={f.path} className="flex items-center gap-3 border-b border-line/60 py-2 last:border-b-0">
                      <span className="min-w-0 flex-1 truncate font-mono text-body text-ink" title={f.path}>{f.path}</span>
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
                          <span className="min-w-0 flex-1 truncate font-mono text-body text-muted" title={f.path}>{f.path}</span>
                          <span className="shrink-0 text-meta text-faint">{EXCLUDE_REASON[f.exclude_reason || ""] || f.exclude_reason}</span>
                        </div>
                      ))}
                    </>
                  )}
                </>
              )}
            </Measure>
          </ScrollArea>
        </section>

        {/* The run action is the point of the page, and it used to sit below
            every knob the page owns — at the 1000x660 floor the button was not
            on screen at all. It is pinned here so 范围 → 开始 is always one
            glance and one click, however the two regions above it scroll. */}
        <div className="shrink-0 border-t border-line bg-raised">
          <Measure className="flex flex-wrap items-center gap-3 px-6 py-3">
            <div className="min-w-0 flex-1">
              <div className="text-body text-muted">{scopeSummary}</div>
              {(repoGone || llmBlocked) && (
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-warn">
                  {repoGone && (
                    <>
                      <span>仓库目录现在打不开：{repoGone}。</span>
                      <Button variant="ghost" size="sm" onClick={() => void pickRepo()}>
                        重新选择
                      </Button>
                    </>
                  )}
                  {llmBlocked && (
                    <>
                      <span>模型服务还没就绪：{llmBlocked}。</span>
                      <Button variant="ghost" size="sm" onClick={() => setView("settings")}>
                        去设置
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
            {running && (
              <Button variant="danger" size="lg" onClick={() => void cancelRun()}>
                <Square className="size-4" />
                取消
              </Button>
            )}
            {/* Disabled only when the run cannot start at all (no repo, a mode
                missing its refs, a repository that is gone, no model behind it, a
                scope the CLI has already refused) — the bar's own text is the
                explanation, sitting next to the button. A scope that is valid but
                empty stays clickable, because clicking it explains what to
                change. The `title` is a courtesy only: `Button` sets
                `disabled:pointer-events-none`, so a disabled button cannot show
                one — the visible sentence above is what actually carries this. */}
            <Button
              variant="primary"
              size="lg"
              disabled={running || Boolean(disabledReason)}
              title={disabledReason || undefined}
              onClick={() => void startOrExplain()}
            >
              {resuming ? <RotateCcw className="size-4" /> : <Play className="size-4" />}
              {running ? "审查运行中…" : resuming ? "续跑未完成部分" : "开始审查"}
            </Button>
          </Measure>
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
