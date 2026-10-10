import { useEffect, useState } from "react";
import { FolderOpen, GitBranch, CircleDot, CloudUpload } from "lucide-react";
import { useStore } from "@/store";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/overlay";
import { cn } from "@/lib/cn";

export function TopBar() {
  const { repo, setRepo, pickRepo, repoInfo, config, setView, info } = useStore();
  const [draft, setDraft] = useState(repo);
  useEffect(() => setDraft(repo), [repo]);

  const commit = () => {
    if (draft.trim() !== repo) setRepo(draft.trim());
  };
  const ready = Boolean(config?.ready);
  const label = ready ? `${config?.provider}${config?.model ? ` · ${config.model}` : ""}` : config?.blockedReason || "未配置模型";

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
      <span className="shrink-0 text-[12px] font-semibold tracking-wide text-ink">Open Code Review</span>

      <div className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-sm border border-line bg-raised px-2 transition-colors hover:border-line-strong focus-within:border-accent">
        <GitBranch className="size-3.5 shrink-0 text-faint" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
          placeholder="仓库目录路径…"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-ink outline-none placeholder:text-faint"
        />
        <Button variant="ghost" size="sm" className="h-5 shrink-0 px-1.5" onClick={pickRepo}>
          <FolderOpen className="size-3.5" />
          浏览
        </Button>
      </div>

      {repoInfo?.ok && (
        <div className="hidden shrink-0 items-center gap-1.5 xl:flex">
          <Badge>
            <CircleDot className="size-3" />
            {repoInfo.branch}
          </Badge>
          {(repoInfo.dirtyCount ?? 0) > 0 && <Badge tone="warn">{repoInfo.dirtyCount} 处未提交</Badge>}
          {repoInfo.upstream && (
            <Badge>
              <CloudUpload className="size-3" />
              {repoInfo.upstream}
            </Badge>
          )}
        </div>
      )}
      {repo && repoInfo && !repoInfo.ok && <span className="shrink-0 text-[11.5px] text-bad">{repoInfo.error}</span>}

      <button onClick={() => setView("settings")} title={config?.path} className="shrink-0">
        <Badge tone={ready ? "ok" : "warn"} className={cn("h-6", !ready && "cursor-pointer")}>
          <span className={cn("size-1.5 rounded-full", ready ? "bg-ok" : "bg-warn")} />
          {label}
        </Badge>
      </button>
      {info?.version && <span className="hidden shrink-0 font-mono text-[10.5px] text-faint lg:block">{info.version}</span>}
    </header>
  );
}
