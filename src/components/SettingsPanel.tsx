import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Copy, Download, Eye, EyeOff, FolderOpen, KeyRound, PlugZap, RefreshCw, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/cn";
import { LANGUAGES } from "@/lib/spec";
import type { ProviderEntry } from "@/lib/types";
import { useStore } from "@/store";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Switch } from "@/components/ui/form";
import { Card, FieldGrid, Page, Section } from "@/components/ui/layout";
import { Badge, ConfirmDialog } from "@/components/ui/overlay";
import { UpdateStatusLine } from "@/components/UpdateBanner";

// The CLI ships 29 built-ins; most users need a handful. Anything already
// configured stays visible so the picker can never hide the entry you are on.
const POPULAR = ["deepseek", "openai", "anthropic", "gemini", "kimi", "z-ai", "dashscope", "siliconflow-cn", "openrouter", "ollama-cloud"];

export function SettingsPanel() {
  const { config, providers, saveConfig, unsetProvider, testLlm, info, update, checkUpdate, installUpdate, setUpdateEnabled, openReleases, llmTest, reloadConfig } = useStore();
  const [picked, setPicked] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [showAllProviders, setShowAllProviders] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [customProtocol, setCustomProtocol] = useState("openai");
  const [effort, setEffort] = useState("");
  const [language, setLanguage] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [confirmUnset, setConfirmUnset] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<[string, ProviderEntry] | null>(null);

  useEffect(() => {
    if (!config) return;
    const active = config.provider || "";
    const known = providers.some((p) => p.name === active) || Boolean(config.customProviders[active]);
    setPicked(active === "" ? "" : known ? active : "__custom__");
    if (!known && active) setCustomName(active);
    setModel(config.model || "");
    setEffort(config.effort || "");
    setLanguage(config.language || "");
    setMaxTokens(config.maxTokens ? String(config.maxTokens) : "");
    setApiKey("");
  }, [config, providers]);

  const entries = config
    ? Object.entries({ ...config.providers, ...config.customProviders })
        .sort((a, b) => Number(b[0] === config.provider) - Number(a[0] === config.provider) || a[0].localeCompare(b[0]))
    : [];

  const use = async (name: string, model?: string) => {
    const res = await api.useProvider(name, model);
    if (!res.ok) toast.error("切换失败", { description: res.error });
    else {
      await reloadConfig();
      toast.success(`当前使用已切到 ${name}`, { description: model ? `模型 ${model}` : "模型沿用该服务的保存值" });
    }
  };

  const load = async () => {
    await reloadConfig();
    toast("配置已刷新");
  };

  const removeEntry = async () => {
    if (!pendingRemove) return;
    const res = await api.removeEntry(pendingRemove[0]);
    if (!res.ok) toast.error("操作失败", { description: res.error });
    else {
      await reloadConfig();
      toast.success(res.message || "已处理");
    }
  };

  if (!config)
    return (
      <Page>
        <p className="text-body text-faint">读取配置中…</p>
      </Page>
    );

  const isCustomTarget = picked === "__custom__";
  const name = isCustomTarget ? customName.trim() : picked;
  const entry = config.providers[name] || config.customProviders[name] || {};
  const builtIn = providers.find((p) => p.name === name);
  const configuredNames = new Set([...Object.keys(config.providers), ...Object.keys(config.customProviders)]);
  const pickable = providers.filter((p) => !config.customProviders[p.name]);
  const visibleProviders = showAllProviders
    ? pickable
    : pickable.filter((p) => POPULAR.includes(p.name) || configuredNames.has(p.name) || p.name === picked);
  const options = [
    ...visibleProviders.map((p) => ({
      value: p.name,
      label: configuredNames.has(p.name) ? `${p.name} — ${p.protocol}（已配置）` : `${p.name} — ${p.protocol}`,
      group: showAllProviders ? "全部内置服务" : "常用服务",
    })),
    ...Object.keys(config.customProviders).map((n) => ({ value: n, label: n, group: "已保存的自定义服务" })),
    { value: "__custom__", label: "＋ 新建自定义服务 / 私有网关", group: "" },
  ];

  // Values as typed, for the no-save connectivity test. url/protocol come from
  // the CLI's own built-in table so a brand-new provider can be tested too.
  const formValues = {
    name,
    url: (isCustomTarget ? customUrl : builtIn?.url || entry.url || "").trim(),
    protocol: (isCustomTarget ? customProtocol : builtIn?.protocol || entry.protocol || "").trim(),
    model: model.trim(),
    apiKey: apiKey.trim(),
  };
  const formTestable = Boolean(formValues.url && formValues.protocol && formValues.model);
  const modelSuggestions = (() => {
    if (!llmTest || llmTest.ok) return [];
    const found = llmTest.output.match(/supported API model names are\s+([A-Za-z0-9._\-]+(?:\s*,\s*[A-Za-z0-9._\-]+)*)/i);
    return found ? found[1].split(",").map((s) => s.trim()).filter(Boolean).slice(0, 8) : [];
  })();

  const revealConfig = async () => {
    const res = await api.revealFile(config.path);
    if (!res.ok) toast.error("无法打开", { description: res.error });
    else if (res.action === "open-parent")
      toast("配置文件还没有生成", {
        description: `首次「保存配置」后 CLI 会创建它，已先打开所在目录：${res.path}`,
      });
  };

  const openInstallDir = async () => {
    const res = await api.openInstallDir();
    if (!res.ok) toast.error("无法打开安装目录", { description: res.error });
  };

  // The main process launches the NSIS uninstaller and quits; reaching this
  // toast at all means it could not, so explain rather than fail silently.
  const doUninstall = async () => {
    const res = await api.uninstall();
    if (!res.ok) toast.error("无法卸载", { description: res.error });
  };

  const save = async (setActive: boolean) => {
    if (!name) {
      return;
    }
    const payload = { ...formValues };
    const ok = await saveConfig({
      provider: name,
      isCustom: isCustomTarget,
      url: isCustomTarget ? customUrl.trim() : "",
      protocol: isCustomTarget ? customProtocol : "",
      apiKey: apiKey.trim(),
      model: model.trim(),
      effort,
      language,
      maxTokens: maxTokens.trim() ? Number(maxTokens) : "",
      setActive,
    });
    if (!ok) return;
    setApiKey("");
    // A save that is never verified turns a typo into a mystery an hour later,
    // so test right here. The typed Key is passed along before the field clears;
    // an empty one resolves to the value just saved, inside the main process.
    if (formTestable) await testLlm(payload);
    else if (setActive) await testLlm();
    else toast("已保存", { description: "该服务没有可用的端点信息，暂不支持按填写值测试；设为当前后可测已保存配置。" });
  };

  return (
    <>
      <Page>
        <Section
          title="模型服务"
          actions={
            <Badge tone={config.ready ? "ok" : "warn"}>
              <CheckCircle2 className="size-3" />
              {config.ready ? "已就绪" : config.blockedReason || "未配置"}
            </Badge>
          }
        >
          <Card>
            <p className="mb-4 text-body text-muted">
              这里改的是官方 CLI 的用户级配置，本程序只调用 <code className="font-mono text-accent">ocr config set</code> 写入，不自行拼接文件。
              同一份配置对命令行 <code className="font-mono">ocr review</code> 立即生效。
            </p>

            <FieldGrid>
              <Field label="模型服务">
                <Select value={picked} onValueChange={setPicked} options={options} placeholder="（未选择）" />
                <button
                  type="button"
                  className="self-start text-meta text-accent hover:underline"
                  onClick={() => setShowAllProviders((v) => !v)}
                >
                  {showAllProviders ? "只看常用服务" : `显示全部 ${providers.length} 个内置服务`}
                </button>
              </Field>
              <Field label="模型名" hint="区分大小写，必须是服务商 API 认的名字（不是控制台里的显示名）。填错时测试会把可用名字列出来，点一下就填好。">
                <Input value={model} spellCheck={false} placeholder="deepseek-v4-pro" onChange={(e) => setModel(e.target.value)} />
                {modelSuggestions.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-meta text-faint">服务商说可用的是：</span>
                    {modelSuggestions.map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={cn(
                          "rounded-sm border px-1.5 py-0.5 font-mono text-meta transition-colors duration-150",
                          m === model ? "border-accent bg-accent-soft text-accent" : "border-line bg-raised text-muted hover:border-accent/50 hover:text-ink"
                        )}
                        onClick={() => {
                          setModel(m);
                          toast("已填入模型名", { description: "点「测试连通」验证这一个" });
                        }}
                      >
                        {m}
                      </button>
                    ))}
                  </div>
                )}
              </Field>

              <div className="col-span-full">
                <Field label="API Key" hint={entry.hasKey ? `已保存：${entry.keyPreview || "（由命令取键）"}　留空表示保持不变` : "该服务还没有 Key，审查前必填。"}>
                  <div className="flex items-center gap-2">
                    <KeyRound className="size-4 shrink-0 text-faint" />
                    <Input
                      type={showKey ? "text" : "password"}
                      value={apiKey}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={entry.hasKey ? "保持不变请留空" : "sk-…"}
                      onChange={(e) => setApiKey(e.target.value)}
                    />
                    <Button
                      variant="ghost"
                      size="md"
                      className="shrink-0"
                      disabled={!apiKey}
                      title={showKey ? "隐藏 Key" : "显示 Key"}
                      onClick={() => setShowKey((v) => !v)}
                    >
                      {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      {showKey ? "隐藏" : "查看"}
                    </Button>
                    {apiKey && <span className="tnum shrink-0 font-mono text-meta text-faint">{apiKey.length} 位</span>}
                  </div>
                </Field>
              </div>

              {isCustomTarget && (
                <>
                  <Field label="自定义服务名">
                    <Input value={customName} spellCheck={false} placeholder="my-gateway" onChange={(e) => setCustomName(e.target.value)} />
                  </Field>
                  <Field label="协议">
                    <Select
                      value={customProtocol}
                      onValueChange={setCustomProtocol}
                      options={[
                        { value: "openai", label: "openai (chat/completions)" },
                        { value: "anthropic", label: "anthropic" },
                        { value: "openai-responses", label: "openai-responses" },
                      ]}
                    />
                  </Field>
                  <div className="col-span-full">
                    <Field label="Base URL" hint="私有网关 / 兼容端点，例如 https://gateway.internal.com/v1">
                      <Input value={customUrl} spellCheck={false} placeholder="https://gateway.internal.com/v1" onChange={(e) => setCustomUrl(e.target.value)} />
                    </Field>
                  </div>
                </>
              )}

              <Field label="默认投入档位" hint="审查页可按次覆盖。">
                <Select
                  value={effort}
                  onValueChange={setEffort}
                  options={[
                    { value: "", label: "不设置" },
                    { value: "low", label: "low" },
                    { value: "medium", label: "medium" },
                    { value: "high", label: "high" },
                  ]}
                />
              </Field>
              <Field label="评论输出语言" hint="写入 CLI 的 language，决定评审意见用什么语言。">
                <Select value={language} onValueChange={setLanguage} options={LANGUAGES} />
              </Field>
              <Field label="单组 prompt token 上限" hint="0 / 留空 = 使用模板默认值。">
                <Input
                  type="number"
                  min={0}
                  value={maxTokens}
                  placeholder="0"
                  className="max-w-[200px]"
                  onChange={(e) => setMaxTokens(e.target.value)}
                />
              </Field>
            </FieldGrid>
          </Card>
        </Section>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="lg" disabled={!name} onClick={() => void save(true)}>
            保存并设为当前
          </Button>
          <Button variant="outline" size="lg" disabled={!name} onClick={() => void save(false)}>
            仅保存该服务
          </Button>
          <Button
            variant="outline"
            size="lg"
            disabled={!formTestable}
            title={formTestable ? "按上方填写的值直接测，不需要先保存" : "先选好服务并填模型名，才能按填写值测试"}
            onClick={() => void testLlm(formValues)}
          >
            <PlugZap />
            测试连通
          </Button>
          <Button variant="ghost" size="lg" onClick={() => void testLlm()}>
            测已保存配置
          </Button>
          <Button variant="danger" size="lg" disabled={!config.provider} onClick={() => setConfirmUnset(true)}>
            <Trash2 />
            清除当前服务
          </Button>
        </div>

        <p className="text-meta text-faint">
          「测试连通」用你当前填写的值，不写配置、也不需要先保存；保存成功后会自动测一次。测已保存配置则按现在生效的那个服务测。
          {config.envSources.length > 0 && <span className="ml-1">检测到环境变量端点：{config.envSources.join(", ")}（优先于该文件）。</span>}
        </p>

        {llmTest && (
          <Card
            padded={false}
            title={<Badge tone={llmTest.ok ? "ok" : "bad"}>{llmTest.ok ? "连通正常" : "连通失败"}</Badge>}
            hint={llmTest.via === "form" ? "按当前填写的值测试（未写配置）" : "按已保存配置测试"}
            actions={
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void copyText(llmTest.output, "完整测试输出")}
              >
                <Copy className="size-3.5" />
                复制
              </Button>
            }
          >
            <pre className="max-h-56 overflow-auto px-4 py-3 font-mono text-meta break-all whitespace-pre-wrap text-muted selectable">
              {llmTest.output || "（无输出）"}
            </pre>
          </Card>
        )}

        <Card
          title="配置文件"
          actions={
            <>
              <Button variant="ghost" size="sm" onClick={() => void revealConfig()}>
                在文件夹中显示
              </Button>
              <Button variant="ghost" size="sm" onClick={() => info?.docsUrl && void api.openUrl(info.docsUrl)}>
                官方文档
              </Button>
            </>
          }
        >
          <code className="block font-mono text-meta break-all text-ink selectable">{config.path}</code>
          <p className="mt-2 text-meta text-faint">
            卸载本程序不会删除该文件（里面是你的 API Key）。会话记录保存在同一目录的 sessions/ 下，由「历史」页管理。
          </p>
        </Card>

        <Section
          title="已配置的服务"
          hint="可同时存在多个，审查页能按次临时切换"
          actions={
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              刷新
            </Button>
          }
        >
          <Card padded={false}>
            {entries.length === 0 ? (
              <p className="px-4 py-4 text-body text-faint">还没有配置任何服务。上面选一个内置服务、填 Key 保存即可。</p>
            ) : (
              <table className="w-full border-collapse">
                <thead>
                  <tr className="text-left text-meta text-faint">
                    <th className="px-4 py-2 font-normal">服务</th>
                    <th className="px-4 py-2 font-normal">协议</th>
                    <th className="px-4 py-2 font-normal">模型</th>
                    <th className="px-4 py-2 font-normal">Key</th>
                    <th className="px-4 py-2 text-right font-normal">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map(([name, e]) => {
                    const active = config.provider === name;
                    const isCustom = Boolean(config.customProviders[name]);
                    return (
                      <tr key={name} className={cn("border-t border-line/70", active && "bg-accent-soft/50")}>
                        <td className="px-4 py-2">
                          {/* Both cells hold arbitrary vendor text. With
                              table-layout:auto an unbreakable model id sizes
                              the column to its content, pushing the table past
                              the card — which then clips it, because Card is
                              overflow-hidden. Cap the two unbounded cells and
                              keep the full value in the tooltip. */}
                          <div className="flex max-w-[240px] items-center gap-1.5">
                            <span className="min-w-0 truncate font-mono text-body text-ink" title={name}>
                              {name}
                            </span>
                            {active && (
                              <Badge tone="accent" className="shrink-0">
                                当前使用
                              </Badge>
                            )}
                            {isCustom && <span className="shrink-0 text-meta text-faint">自定义</span>}
                          </div>
                        </td>
                        <td className="px-4 py-2 text-body text-muted">{e.protocol || (isCustom ? "自定义" : "内置默认")}</td>
                        <td className="px-4 py-2 font-mono text-body text-muted">
                          {e.model ? (
                            <span className="block max-w-[280px] truncate" title={e.model}>
                              {e.model}
                            </span>
                          ) : (
                            <span className="text-faint">未填</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-body">
                          {e.hasKey ? <span className="font-mono text-ok">{e.keyPreview || "已设置"}</span> : <span className="text-bad">缺</span>}
                        </td>
                        <td className="px-4 py-2 text-right whitespace-nowrap">
                          {!active && (
                            <Button variant="ghost" size="sm" onClick={() => void use(name, e.model)}>
                              设为当前
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setPicked(isCustom || providers.some((p) => p.name === name) ? name : "__custom__");
                              if (!providers.some((p) => p.name === name)) setCustomName(name);
                              setModel(e.model || "");
                              setCustomUrl(e.url || "");
                              if (e.protocol) setCustomProtocol(e.protocol);
                              setApiKey("");
                              toast("已载入该服务到上方表单", { description: "留空 API Key 即保持不变" });
                            }}
                          >
                            编辑
                          </Button>
                          <Button variant="ghost" size="sm" className="text-bad" onClick={() => setPendingRemove([name, e])}>
                            {isCustom ? "删除" : "清空 Key"}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <p className="border-t border-line/70 px-4 py-2.5 text-meta text-faint">
              内置服务无法从配置里删除（CLI 的 <code className="font-mono">config unset</code> 不支持
              <code className="font-mono"> providers.&lt;name&gt;</code>），只能清空它的 Key 与模型；自定义服务可以彻底删除。
            </p>
          </Card>
        </Section>

        <Card
          title="更新"
          actions={
            <>
              <Badge>
                v{info?.appVersion}
                {update?.portable ? " · 免安装版" : update?.packaged ? "" : " · 开发模式"}
              </Badge>
              <UpdateStatusLine />
            </>
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => void checkUpdate()}>
              <RefreshCw />
              立即检查更新
            </Button>
            {update?.phase === "ready" && (
              <Button variant="primary" onClick={() => void installUpdate()}>
                <Download />
                重启并更新到 v{update.version}
              </Button>
            )}
            <label className="flex items-center gap-2 text-body text-muted">
              <Switch checked={update?.enabled !== false} onCheckedChange={(v) => void setUpdateEnabled(v)} />
              启动时自动检查更新
            </label>
            <button className="ml-auto text-meta text-accent hover:underline" onClick={() => void openReleases()}>
              查看所有版本
            </button>
          </div>
          {update?.phase === "manual" && (
            <p className="mt-3 text-body text-warn">
              免安装（portable）版每次运行都解压到临时目录，没有可替换的安装根，因此只能到下载页取新安装包。要用自动更新请安装 setup 版。
            </p>
          )}
          {update?.phase === "unsupported" && <p className="mt-3 text-body text-faint">开发模式下不检查更新，也不会下载任何文件。</p>}
        </Card>

        <Card
          title="关于与卸载"
          actions={<Badge>{info?.packaged ? (info.portable ? "免安装版" : "安装版") : "开发模式"} · {info?.platform || "—"}</Badge>}
        >
          {/* `minmax(0,1fr)` and the row's `min-w-0` are both load-bearing: a
              plain `auto` track is never clamped below its item's min-content
              contribution, so a long path pushed the track to 919px inside an
              862px container and the card silently clipped it. */}
          <dl className="grid grid-cols-[minmax(0,1fr)] gap-2">
            <InfoRow label="程序版本" value={`v${info?.appVersion ?? ""}`} />
            <InfoRow label="ocr CLI" value={info?.version ? `v${info.version}` : "未找到可执行文件"} />
            <InfoRow label="可执行文件" value={info?.binary || "—"} mono />
            <InfoRow label="安装目录" value={info?.installDir || "（免安装版运行在临时目录）"} mono />
            <InfoRow label="配置目录" value={info?.configPath || "—"} mono />
          </dl>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" disabled={!info?.installDir} onClick={() => void openInstallDir()}>
              <FolderOpen className="size-3.5" />
              打开安装目录
            </Button>
            {info?.canUninstall && (
              <Button variant="ghost" size="sm" className="text-bad" onClick={() => setConfirmUninstall(true)}>
                <Trash2 className="size-3.5" />
                卸载本程序
              </Button>
            )}
            <span className="text-meta text-faint">
              {info?.canUninstall
                ? "卸载只移除程序本身，不会删除你的 API Key 与会话记录。"
                : info?.portable
                  ? "免安装版直接删除该 exe 即可，不写注册表。"
                  : "未检测到卸载器（开发模式或非 Windows 平台）。"}
            </span>
          </div>
        </Card>
      </Page>

      <ConfirmDialog
        open={confirmUninstall}
        onOpenChange={setConfirmUninstall}
        title="卸载 Open Code Review"
        danger
        confirmLabel="开始卸载"
        description={
          <>
            将启动官方卸载程序并关闭本应用。<code className="font-mono text-meta">.opencodereview</code> 下的配置与会话记录
            <b>不会</b>被删除，卸载后可重新安装继续使用。确定继续？
          </>
        }
        onConfirm={() => void doUninstall()}
      />

      <ConfirmDialog
        open={Boolean(pendingRemove)}
        onOpenChange={(v) => !v && setPendingRemove(null)}
        title={pendingRemove && config.customProviders[pendingRemove[0]] ? "删除自定义服务" : "清空该服务的配置"}
        danger
        confirmLabel={pendingRemove && config.customProviders[pendingRemove[0]] ? "删除" : "清空"}
        description={
          <>
            <code className="font-mono text-meta">{pendingRemove?.[0]}</code> 的
            {pendingRemove && config.customProviders[pendingRemove[0]] ? " URL、协议、模型与 API Key 都会被删除，无法恢复。" : " API Key 与模型会被清空（内置服务无法删除）。它若是当前使用的服务，切换前请先选好替代。"}
          </>
        }
        onConfirm={() => void removeEntry()}
      />

      <ConfirmDialog
        open={confirmUnset}
        onOpenChange={setConfirmUnset}
        title="清除当前模型服务"
        danger
        confirmLabel="清除"
        description={
          <>
            将执行 <code className="font-mono text-meta">ocr config unset {config.customProviders[config.provider] ? `custom_providers.${config.provider}` : "provider"}</code>
            ：provider 与 model 选择被清空{config.customProviders[config.provider] ? "，该自定义服务的 URL 与 Key 一并删除" : ""}。此操作不可撤销。
          </>
        }
        onConfirm={() => void unsetProvider()}
      />
    </>
  );
}

/** One `label — value` line in the 关于 card; long paths stay copyable. */
function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <dt className="w-20 shrink-0 text-meta text-faint">{label}</dt>
      <dd className={cn("min-w-0 flex-1 truncate text-body text-muted selectable", mono && "font-mono text-meta")} title={value}>
        {value}
      </dd>
    </div>
  );
}
