import { useState } from "react";
import { ArrowRight, Check, X } from "lucide-react";
import { useStore } from "@/store";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/layout";
import { cn } from "@/lib/cn";

/**
 * The guide only exists for the two things that genuinely block a first run: no
 * repository, no model. The third step used to be "先预览文件清单，再开始审查",
 * aimed at a button the user had to think of pressing — the list now computes
 * itself as soon as the scope settles, so that step would complete on its own
 * before the user had done anything, and the card would vanish in front of them.
 * It now tracks whether a review has actually been run.
 */
const STEPS = [
  { n: 1, title: "选择要审查的仓库目录", detail: "必须是 git 仓库根目录", action: "选择仓库" },
  { n: 2, title: "配置模型服务与 API Key", detail: "只需一次，写入官方 CLI 的用户配置", action: "去设置" },
  { n: 3, title: "点「开始审查」，结果在「结果」页", detail: "文件清单会自己算，不消耗 token", action: "" },
];

export function GuideCard() {
  const { config, repo, result, pickRepo, setView } = useStore();
  const [dismissed, setDismissed] = useState(() => localStorage.getItem("guide-dismissed") === "1");

  const done = [Boolean(repo), Boolean(config?.ready), Boolean(result)];
  const allDone = done.every(Boolean);
  if (dismissed || allDone) return null;

  const actions = [pickRepo, () => setView("settings")];

  return (
    <Card
      tone="accent"
      padded={false}
      title="三步开始第一次审查"
      actions={
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            localStorage.setItem("guide-dismissed", "1");
            setDismissed(true);
          }}
        >
          <X className="size-3.5" />
          不再提示
        </Button>
      }
    >
      <ol className="divide-y divide-line/60">
        {STEPS.map((s, i) => (
          <li key={s.n} className="flex items-center gap-3 px-4 py-2.5">
            <span
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full border text-meta font-semibold",
                done[i] ? "border-ok/50 bg-ok/15 text-ok" : "border-line-strong text-faint"
              )}
            >
              {done[i] ? <Check className="size-3" strokeWidth={3} /> : s.n}
            </span>
            <div className="min-w-0 flex-1">
              <div className={cn("text-body", done[i] ? "text-muted line-through decoration-ok/40" : "text-ink")}>{s.title}</div>
              <div className="text-meta text-faint">{s.detail}</div>
            </div>
            {s.action && !done[i] && (
              <Button variant="outline" size="sm" onClick={() => void actions[i]()}>
                {s.action}
                <ArrowRight className="size-3.5" />
              </Button>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}
