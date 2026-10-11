import { useEffect, useState } from "react";
import {
  Coins,
  Eye,
  FileText,
  FolderSearch,
  Hourglass,
  ListTree,
  Play,
  RotateCcw,
  SlidersHorizontal,
  Square,
  TriangleAlert,
} from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { EXCLUDE_REASON } from "@/lib/format";
import { EFFORTS, MODE_META } from "@/lib/spec";
import { useStore } from "@/store";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { Card, FieldGrid, Page, Section } from "@/components/ui/layout";
import { Badge, ConfirmDialog } from "@/components/ui/overlay";
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
  const [showRules, setShowRules] = useState(false);
  const [ruleProbe, setRuleProbe] = useState("");
  const [confirmScan, setConfirmScan] = useState(false);

  const keep = (preview?.value?.files || []).filter((f) => f.will_review);
  const drop = (preview?.value?.files || []).filter((f) => !f.will_review);

  return (
    <>
      <Page className="min-w-0 flex-1">
        <GuideCard />

        <Section
          title="审查范围"
          actions={<code className="rounded-xs bg-raised px-1.5 py-0.5 font-mono text-meta text-faint">{meta.command}</code>}
        >
          <div className="flex gap-1 rounded-md border border-line bg-raised p-1">
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

        <Section title="审查参数" hint="只影响这一次，不改全局配置">
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

            <Field label="本次使用的服务" hint="对应 CLI 的 --provider。">
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
        </Section>

        <Card title="成本与时间护栏" hint="花钱前先看这里" icon={<Coins className="size-3.5 text-accent" />}>
          <FieldGrid>
            <Field label="总 token 上限（输入+输出）" hint="达到上限后已审结果照常保留，剩余文件不再派发。">
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
        </Card>

        <Card
          padded={false}
          title={
            <button
              type="button"
              onClick={() => setShowRules((s) => !s)}
              aria-expanded={showRules}
              className="flex items-center gap-2 font-medium text-muted transition-colors hover:text-ink"
            >
              <SlidersHorizontal className="size-3.5" />
              高级参数
            </button>
          }
          actions={<span className="text-meta text-faint">{showRules ? "收起" : "展开"}</span>}
        >
          {showRules && (
            <div className="border-t border-line p-4">
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
          )}
        </Card>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="lg"
            disabled={running}
            onClick={async () => {
              if (resume?.sessionId || !scan) {
                void startRun(resume?.sessionId);
                return;
              }
              // One measured single-file scan cost ~103K tokens and 3m36s, so a scan
              // is not a "run it and see" operation. The count must come from the
              // preview — and if the user never ran one, run it now: it is free.
              const count = preview?.value ? keep.length : await runPreview();
              if (count < 0) return;
              if (count > SCAN_CONFIRM_AT) {
                setConfirmScan(true);
                return;
              }
              void startRun();
            }}
          >
            {resume?.sessionId ? <RotateCcw className="size-4" /> : <Play className="size-4" />}
            {running ? "审查运行中…" : resume?.sessionId ? "续跑未完成部分" : "开始审查"}
          </Button>
          <Button variant="outline" size="lg" disabled={running} onClick={() => void runPreview()}>
            <Eye className="size-4" />
            预览清单
          </Button>
          {running && (
            <Button variant="danger" size="lg" onClick={() => void cancelRun()}>
              <Square className="size-4" />
              取消
            </Button>
          )}
          <span className="ml-auto flex items-center gap-2 text-meta text-muted">
            {preview?.value && !running && (
              <span className="tnum text-ink">
                预计审查 <b>{keep.length}</b> 个文件
              </span>
            )}
            {runLabel}
            {running && (
              <span className="tnum flex items-center gap-1 font-mono text-accent">
                <Hourglass className="size-3.5" />
                {elapsed}s
              </span>
            )}
          </span>
        </div>

        {resume && (
          <Card tone="warn" padded={false}>
            <div className="flex items-start gap-2 p-4">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
              <div className="min-w-0 flex-1 text-body text-ink">
                {meta.resumable ? (
                  <>
                    这次运行没有全部完成{resume.failed ? `（${resume.failed} 个文件失败）` : ""}，会话{" "}
                    <code className="font-mono text-meta text-muted">{resume.sessionId.slice(0, 12)}…</code>
                    。保持同样的范围与模型服务点上面的「续跑未完成部分」，已完成的部分不会重复付费。
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

        {/* The preview used to live in a sidebar that only existed above 1536px,
            so on most screens "预览清单" looked like a button that did nothing. */}
        {preview && (
          <Card
            padded={false}
            title="文件清单"
            icon={<ListTree className="size-3.5 text-accent" />}
            hint={preview.loading ? "计算中…" : preview.value ? `不消耗 token · 进入审查 ${keep.length} / 共 ${preview.value.total_files} 个文件` : undefined}
          >
            {preview.loading && <p className="px-4 py-3 text-body text-faint">正在计算…</p>}
            {preview.error && <p className="whitespace-pre-wrap px-4 py-3 text-body text-bad">{preview.error}</p>}
            {preview.value && (
              <>
                <div className="grid grid-cols-3 divide-x divide-line border-b border-line">
                  {[
                    { label: "进入审查", value: String(keep.length) },
                    {
                      label: scan ? "待通读行数" : "改动行数",
                      value: scan
                        ? `${preview.value.total_insertions} 行`
                        : `+${preview.value.total_insertions} / -${preview.value.total_deletions}`,
                    },
                    { label: "改动文件总数", value: String(preview.value.total_files) },
                  ].map((cell) => (
                    <div key={cell.label} className="px-4 py-3">
                      <div className="tnum text-stat font-semibold text-ink">{cell.value}</div>
                      <div className="mt-0.5 text-meta text-faint">{cell.label}</div>
                    </div>
                  ))}
                </div>

                {keep.length === 0 ? (
                  <p className="px-4 py-3 text-body text-faint">
                    没有文件进入审查。工作区没有改动时属正常，可改用「分支对比」或「单个提交」。
                  </p>
                ) : (
                  <div className="max-h-80 overflow-y-auto">
                    {keep.map((f) => (
                      <div key={f.path} className="flex items-center gap-3 border-b border-line/60 px-4 py-2">
                        <span className="min-w-0 flex-1 truncate font-mono text-body text-ink">{f.path}</span>
                        <span className="tnum shrink-0 text-meta text-faint">
                          {f.status}
                          {scan ? ` · ${f.insertions} 行` : ` · +${f.insertions} / -${f.deletions}`}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {drop.length > 0 && (
                  <div className="border-t border-line">
                    <div className="bg-raised px-4 py-1.5 text-meta text-faint">以下 {drop.length} 个不进入审查</div>
                    <div className="max-h-56 overflow-y-auto">
                      {drop.map((f) => (
                        <div key={f.path} className="flex items-center gap-3 border-b border-line/40 px-4 py-2 last:border-b-0">
                          <span className="min-w-0 flex-1 truncate font-mono text-body text-muted">{f.path}</span>
                          <span className="shrink-0 text-meta text-faint">{EXCLUDE_REASON[f.exclude_reason || ""] || f.exclude_reason}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </Card>
        )}

        {rulesOutput && (
          <Card
            padded={false}
            title={<Badge tone="accent">适用规则</Badge>}
            hint={<span className="truncate font-mono">{ruleProbe}</span>}
            actions={
              <Button variant="ghost" size="sm" onClick={() => setShowRules(false)}>
                关闭
              </Button>
            }
          >
            <pre className="max-h-64 overflow-auto px-4 py-3 font-mono text-meta whitespace-pre-wrap text-muted selectable">
              {rulesOutput}
            </pre>
          </Card>
        )}

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
      </Page>

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
