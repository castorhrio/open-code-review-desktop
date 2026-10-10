import { useState } from "react";
import { Download, FolderClock, RotateCcw, Trash2, Eye } from "lucide-react";
import { MODE_LABEL, STATUS, humanDuration, humanTime, sessionState } from "@/lib/format";
import { useStore } from "@/store";
import { Button } from "@/components/ui/button";
import { Badge, ConfirmDialog } from "@/components/ui/overlay";
import { cn } from "@/lib/cn";
import type { SessionSummary } from "@/lib/types";

export function HistoryPanel() {
  const { repo, history, historyLoading, refreshHistory, loadSession, exportSession, deleteSession, startRun, patchForm, form } = useStore();
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null);

  const resumeFrom = (s: SessionSummary) => {
    if (s.review_mode === "full_scan") patchForm({ ...form, mode: "scan", scanPath: "" });
    else if (s.review_mode === "commit") patchForm({ ...form, mode: "commit", commit: s.diff_commit || "" });
    else patchForm({ ...form, mode: "range", from: s.diff_from || "", to: s.diff_to || "" });
    void startRun(s.session_id);
  };

  if (!repo) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <FolderClock className="size-8 text-faint" />
        <p className="text-[12.5px] text-muted">先在顶部选择仓库目录。</p>
        <p className="text-[11.5px] text-faint">每个仓库的历史审查独立保存在 ~/.opencodereview/sessions/&lt;仓库&gt;。</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-line bg-surface px-4 py-2">
        <h2 className="text-[13px] font-semibold text-ink">历史会话</h2>
        <span className="tnum text-[11.5px] text-faint">
          {historyLoading ? "读取中…" : `${history.length} 条 · 由官方 CLI 持久化，可续跑/导出/删除`}
        </span>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void refreshHistory()}>
          刷新
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!historyLoading && history.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-[12.5px] text-muted">这个仓库还没有历史会话。</p>
            <p className="text-[11.5px] text-faint">跑一次审查后会自动记录，可随时回看、导出报告或续跑未完成的部分。</p>
          </div>
        )}
        {history.map((s) => {
          const st = sessionState(s);
          const status = STATUS[st] || { label: st, cls: "border-line bg-raised text-muted" };
          const scope =
            s.review_mode === "range" ? `${s.diff_from}…${s.diff_to}` : s.review_mode === "commit" ? s.diff_commit : s.git_branch;
          return (
            <div key={s.session_id} className="flex items-center gap-3 border-b border-line/70 px-4 py-2.5 hover:bg-hover/50">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[12.5px] text-ink">{MODE_LABEL[s.review_mode || ""] || s.review_mode}</span>
                  <span className="truncate font-mono text-[11.5px] text-muted">{scope || "—"}</span>
                </div>
                <div className="tnum mt-0.5 flex items-center gap-2 font-mono text-[10.5px] text-faint">
                  <span>{humanTime(s.start_time)}</span>
                  <span>{humanDuration(s.duration_ns)}</span>
                  <span>{s.model || "无模型"}</span>
                  {s.resumed_from && <span>续跑自 {s.resumed_from.slice(0, 8)}</span>}
                </div>
              </div>

              <div className="tnum flex shrink-0 items-center gap-2 text-[11.5px] text-muted">
                <span title="完成 / 选中文件数">
                  <b className="text-ink">{s.completed_files}</b>/{s.selected_files}
                </span>
                {s.failed_files > 0 && <span className="text-bad">✗{s.failed_files}</span>}
                <Badge tone={s.total_comments ? "accent" : "neutral"}>{s.total_comments} 条</Badge>
                <Badge className={cn("h-5", status.cls)}>{status.label}</Badge>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => void loadSession(s)} title="在结果页打开">
                  <Eye className="size-3.5" />
                  结果
                </Button>
                {s.review_mode !== "workspace" && (
                  <Button variant="ghost" size="sm" onClick={() => resumeFrom(s)} title="按原范围续跑未完成部分">
                    <RotateCcw className="size-3.5" />
                    续跑
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => void exportSession(s)} title="导出自包含 HTML 报告">
                  <Download className="size-3.5" />
                </Button>
                <Button variant="ghost" size="sm" className="text-bad" onClick={() => setPendingDelete(s)}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(v) => !v && setPendingDelete(null)}
        title="删除历史会话"
        danger
        confirmLabel="删除"
        description={
          <>
            会话 <code className="font-mono text-[11px]">{pendingDelete?.session_id.slice(0, 16)}…</code> 的 JSONL 记录会被永久删除，
            无法恢复。已导出的 HTML 报告不受影响。
          </>
        }
        onConfirm={() => pendingDelete && void deleteSession(pendingDelete)}
      />
    </div>
  );
}
