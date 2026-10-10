import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, KeyRound, PlugZap, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { LANGUAGES } from "@/lib/spec";
import { useStore } from "@/store";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form";
import { Badge, ConfirmDialog } from "@/components/ui/overlay";

export function SettingsPanel() {
  const { config, providers, saveConfig, unsetProvider, testLlm, info } = useStore();
  const [picked, setPicked] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [customName, setCustomName] = useState("");
  const [customUrl, setCustomUrl] = useState("");
  const [customProtocol, setCustomProtocol] = useState("openai");
  const [effort, setEffort] = useState("");
  const [language, setLanguage] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [confirmUnset, setConfirmUnset] = useState(false);

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

  if (!config) return <div className="p-6 text-[12.5px] text-faint">读取配置中…</div>;

  const isCustomTarget = picked === "__custom__";
  const name = isCustomTarget ? customName.trim() : picked;
  const entry = config.providers[name] || config.customProviders[name] || {};
  const options = [
    ...providers
      .filter((p) => !config.customProviders[p.name])
      .map((p) => ({ value: p.name, label: `${p.name} — ${p.protocol}`, group: "内置服务" })),
    ...Object.keys(config.customProviders).map((n) => ({ value: n, label: n, group: "已保存的自定义服务" })),
    { value: "__custom__", label: "＋ 新建自定义服务 / 私有网关", group: "" },
  ];

  const revealConfig = async () => {
    const res = await api.revealFile(config.path);
    if (!res.ok) toast.error("无法打开", { description: res.error });
    else if (res.action === "open-parent")
      toast("配置文件还没有生成", {
        description: `首次「保存配置」后 CLI 会创建它，已先打开所在目录：${res.path}`,
      });
  };

  const save = async () => {
    if (!name) {
      return;
    }
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
    });
    if (ok) setApiKey("");
  };

  return (
    <div className="h-full overflow-y-auto px-5 py-4">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex items-center gap-2">
          <h2 className="text-[13px] font-semibold text-ink">模型服务</h2>
          <Badge tone={config.ready ? "ok" : "warn"}>
            <CheckCircle2 className="size-3" />
            {config.ready ? "已就绪" : config.blockedReason || "未配置"}
          </Badge>
        </div>

        <p className="mb-4 rounded-md border border-line bg-surface px-3 py-2 text-[11.5px] leading-relaxed text-muted">
          这里改的是官方 CLI 的用户级配置，本程序只调用 <code className="font-mono text-accent">ocr config set</code> 写入，不自行拼接文件。
          同一份配置对命令行 <code className="font-mono">ocr review</code> 立即生效。
        </p>

        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Field label="模型服务">
            <Select value={picked} onValueChange={setPicked} options={options} placeholder="（未选择）" />
          </Field>
          <Field label="模型名" hint="CLI 不提供模型目录接口，请按服务商控制台里的写法填写，例如 claude-sonnet-4-5、qwen3-coder-plus。">
            <Input value={model} spellCheck={false} placeholder="claude-sonnet-4-5" onChange={(e) => setModel(e.target.value)} />
          </Field>

          <div className="col-span-2">
            <Field label="API Key" hint={entry.hasKey ? `已保存：${entry.keyPreview || "（由命令取键）"}　留空表示保持不变` : "该服务还没有 Key，审查前必填。"}>
              <div className="flex items-center gap-2">
                <KeyRound className="size-4 shrink-0 text-faint" />
                <Input
                  type="password"
                  value={apiKey}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={entry.hasKey ? "保持不变请留空" : "sk-…"}
                  onChange={(e) => setApiKey(e.target.value)}
                />
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
              <div className="col-span-2">
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
            <Input type="number" min={0} value={maxTokens} placeholder="0" onChange={(e) => setMaxTokens(e.target.value)} />
          </Field>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button variant="primary" size="lg" disabled={!name} onClick={() => void save()}>
            保存配置
          </Button>
          <Button variant="outline" size="lg" onClick={() => void testLlm()}>
            <PlugZap className="size-4" />
            测试连通
          </Button>
          <Button variant="danger" size="lg" disabled={!config.provider} onClick={() => setConfirmUnset(true)}>
            <Trash2 className="size-4" />
            清除当前服务
          </Button>
          {config.envSources.length > 0 && (
            <span className="ml-auto text-[11px] text-faint">检测到环境变量端点：{config.envSources.join(", ")}（优先于该文件）</span>
          )}
        </div>

        <div className="mt-5 rounded-md border border-line bg-surface px-3 py-2.5 text-[11.5px] text-muted">
          <div className="flex items-center gap-2">
            <span className="text-faint">配置文件</span>
            <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">{config.path}</code>
            <Button variant="ghost" size="sm" onClick={() => void revealConfig()}>
              在文件夹中显示
            </Button>
            <Button variant="ghost" size="sm" onClick={() => info?.docsUrl && void api.openUrl(info.docsUrl)}>
              官方文档
            </Button>
          </div>
          <p className="mt-1.5 leading-relaxed text-faint">
            卸载本程序不会删除该文件（里面是你的 API Key）。会话记录保存在同一目录的 sessions/ 下，由「历史」页管理。
          </p>
        </div>
      </div>

      <ConfirmDialog
        open={confirmUnset}
        onOpenChange={setConfirmUnset}
        title="清除当前模型服务"
        danger
        confirmLabel="清除"
        description={
          <>
            将执行 <code className="font-mono text-[11px]">ocr config unset {config.customProviders[config.provider] ? `custom_providers.${config.provider}` : "provider"}</code>
            ：provider 与 model 选择被清空{config.customProviders[config.provider] ? "，该自定义服务的 URL 与 Key 一并删除" : ""}。此操作不可撤销。
          </>
        }
        onConfirm={() => void unsetProvider()}
      />
    </div>
  );
}
