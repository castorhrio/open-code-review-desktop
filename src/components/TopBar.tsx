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
  // `config` is null until the first read resolves, and the chain below read
  // that absence as "not configured": every launch opened the top bar with
  // 未配置模型 in warn colour beside a provider that had been configured all
  // along. Unknown is not the same as absent, so it gets its own sentence and a
  // neutral dot.
  const unknown = config === null;
  const label = unknown
    ? "读取配置中…"
    : ready
      ? `${config.provider}${config.model ? ` · ${config.model}` : ""}`
      : config.blockedReason || "未配置模型";

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface px-4">
      <span className="shrink-0 text-strong font-semibold text-ink">Open Code Review</span>

      <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-sm border border-line bg-raised px-2 transition-colors hover:border-line-strong focus-within:border-accent">
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
          className="min-w-0 flex-1 bg-transparent font-mono text-body text-ink outline-none placeholder:text-faint"
        />
        <Button variant="ghost" size="sm" className="shrink-0" onClick={pickRepo}>
          <FolderOpen className="size-3.5" />
          浏览
        </Button>
      </div>

      {repoInfo?.ok && (
        <div className="hidden min-w-0 shrink-0 items-center gap-1.5 xl:flex">
          {/* Every value here comes from the repository and has no length
              bound: branch names can be long, and `origin/<branch>` doubles
              them. Without a cap the badges are `nowrap` flex items that
              refuse to shrink, so one long branch pushed this header to
              2673px inside a 1440px window and silently clipped the rest of
              the app. Cap each badge and ellipsise; the full value stays
              reachable via the tooltip. */}
          <Badge title={repoInfo.branch} className="max-w-[200px]">
            <CircleDot className="size-3 shrink-0" />
            <span className="min-w-0 truncate">{repoInfo.branch}</span>
          </Badge>
          {(repoInfo.dirtyCount ?? 0) > 0 && <Badge tone="warn">{repoInfo.dirtyCount} 处未提交</Badge>}
          {repoInfo.upstream && (
            <Badge title={repoInfo.upstream} className="max-w-[240px]">
              <CloudUpload className="size-3 shrink-0" />
              <span className="min-w-0 truncate">{repoInfo.upstream}</span>
            </Badge>
          )}
        </div>
      )}
      {repo && repoInfo && !repoInfo.ok && (
        <span title={repoInfo.error} className="min-w-0 max-w-[320px] shrink truncate text-meta text-bad">
          {repoInfo.error}
        </span>
      )}

      <button onClick={() => setView("settings")} title={config?.path} className="min-w-0 shrink-0">
        <Badge tone={!unknown && !ready ? "warn" : undefined} className={cn("max-w-[260px]", !unknown && !ready && "cursor-pointer")}>
          <span className={cn("size-1.5 shrink-0 rounded-full", unknown ? "bg-line-strong" : ready ? "bg-ok" : "bg-warn")} />
          <span className="min-w-0 truncate">{label}</span>
        </Badge>
      </button>
      {info?.version && <span className="hidden shrink-0 font-mono text-meta text-faint lg:block">{info.version}</span>}
    </header>
  );
}
