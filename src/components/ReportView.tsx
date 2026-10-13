import { ArrowLeft, FileCode2, Sparkles } from "lucide-react";
import { SEVERITY_RANK, STATUS, coverageOf, terminalState } from "@/lib/format";
import type { Finding } from "@/lib/types";
import { copyText } from "@/lib/clipboard";
import { useStore } from "@/store";
import { Button } from "@/components/ui/button";
import { Card, PageBody, PanelHeader } from "@/components/ui/layout";
import { Badge } from "@/components/ui/overlay";
import { CoverageNotice, FindingBlock, MarkdownLite, findingToMarkdown } from "@/components/finding";

/** Files first, worst file first, findings in line order inside a file.
 *  A reviewer reads a changeset one file at a time; the flat severity list on
 *  结果 is for triage, and this is for reading it end to end. */
function groupByPath(comments: Finding[]) {
  const byPath = new Map<string, Finding[]>();
  for (const c of comments) {
    const list = byPath.get(c.path);
    if (list) list.push(c);
    else byPath.set(c.path, [c]);
  }
  // `?? 9`: the CLI owns this vocabulary and can add a step this build has never
  // seen, and an unknown value turning the comparator into NaN would order the
  // document unpredictably rather than just last.
  const worst = (list: Finding[]) => Math.min(...list.map((c) => SEVERITY_RANK[c.severity || ""] ?? 9));
  return [...byPath.entries()]
    .sort((a, b) => worst(a[1]) - worst(b[1]) || a[0].localeCompare(b[0]))
    .map(([path, list]) => ({ path, findings: [...list].sort((x, y) => x.start_line - y.start_line) }));
}

export function ReportView() {
  const { result, resultOrigin, comments, log, setView, exportSession } = useStore();
  // The exact invocation is the first thing to read when a run did not do what
  // was expected, and it survives nowhere else: the log drawer is collapsed by
  // default and a toast cannot be selected. Only a run has one — a session
  // reopened from 历史 was written by whatever command made it, which may be
  // this app's or may be the CLI's, so the line is omitted rather than guessed.
  const command = resultOrigin?.kind === "run" ? (log.find((l) => l.startsWith("[cmd] ")) || "").slice(6) : "";

  if (!result) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <FileCode2 className="size-8 text-faint" />
        <p className="text-body text-muted">没有可阅读的结果。先在「结果」页打开一次审查或一个历史会话。</p>
        <Button variant="outline" size="sm" onClick={() => setView("results")}>
          去结果页
        </Button>
      </div>
    );
  }

  const st = terminalState(result);
  const status = STATUS[st] || { label: st || "未知", cls: "border-line bg-raised text-muted" };
  const s = result.summary || {};
  const failed = coverageOf(result, "failed");
  const waived = coverageOf(result, "waived");
  const groups = groupByPath(comments);
  const sessionId = result.session_id || "";
  // A session reopened from history carries a model but no provider (`ocr session
  // comments` returns findings only), so the line is assembled from what exists
  // rather than interpolated — `${undefined}` printed a literal "undefined".
  const facts = [s.elapsed && `耗时 ${s.elapsed}`, result.llm?.provider, result.llm?.model].filter(Boolean).join(" · ");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader>
        <Button variant="ghost" size="sm" onClick={() => setView("results")}>
          <ArrowLeft className="size-3.5" />
          返回结果
        </Button>
        <Badge className={status.cls}>{status.label}</Badge>
        {resultOrigin?.kind === "session" && <Badge tone="accent">历史会话</Badge>}
        <span className="tnum min-w-0 truncate text-meta text-muted">
          <b className="text-ink">{s.files_reviewed ?? "—"}</b> 文件
          {facts && ` · ${facts}`}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            disabled={comments.length === 0}
            title="把全部评论按 Markdown 复制，可直接粘贴到 PR / MR"
            onClick={() => void copyText(comments.map(findingToMarkdown).join("\n\n---\n\n"), ` ${comments.length} 条评论（Markdown）`)}
          >
            复制全文
          </Button>
          {sessionId && (
            <Button variant="ghost" size="sm" title="导出自包含 HTML 报告，可单独打开或转发" onClick={() => void exportSession(sessionId)}>
              导出 HTML
            </Button>
          )}
        </div>
      </PanelHeader>

      <div className="min-h-0 flex-1 overflow-y-auto bg-canvas">
        <PageBody>
          {/* A report has to open by saying what it covers. This document is the
              version a user forwards, and the reader's first question is not
              "how many comments" but "of what". */}
          <div className="flex flex-col gap-1">
            <h1 className="min-w-0 truncate text-stat font-semibold text-ink" title={resultOrigin?.scope || "审查结果"}>
              {resultOrigin?.scope || "审查结果"}
              <span className="tnum ml-2 font-normal text-faint">{comments.length} 条评论</span>
            </h1>
            {command && (
              <div className="flex items-start gap-2">
                <code className="min-w-0 flex-1 break-all font-mono text-meta text-faint selectable">{command}</code>
                <Button variant="ghost" size="sm" className="shrink-0" title="复制这条命令" onClick={() => void copyText(command, "本次运行的命令")}>
                  复制命令
                </Button>
              </div>
            )}
          </div>

          {result.project_summary && (
            <Card
              padded={false}
              icon={<Sparkles className="size-3.5 text-accent" />}
              title="这次审查的要点"
              hint="由 CLI 汇总，不是本程序生成的"
            >
              <div className="px-4 pb-4">
                <MarkdownLite text={result.project_summary} className="text-strong" />
              </div>
            </Card>
          )}

          <CoverageNotice
            failed={failed}
            waived={waived}
            failedFiles={resultOrigin?.failedFiles || 0}
            subject={resultOrigin?.kind === "session" ? "该会话" : "本次结果"}
            className="rounded-md border border-warn/25"
          />

          {comments.length === 0 ? (
            <Card>
              <p className="text-body text-ink">这次审查没有提出问题。</p>
              <p className="mt-1 text-meta text-faint">
                已审 {String(s.files_reviewed ?? "—")} 个文件。范围不对的话，换个模式或改小排除规则再跑一次。
              </p>
            </Card>
          ) : (
            groups.map(({ path, findings }) => (
              <Card
                key={path}
                padded={false}
                title={<span className="truncate font-mono text-body" title={path}>{path}</span>}
                actions={<span className="tnum shrink-0 text-meta text-faint">{findings.length} 条</span>}
              >
                {findings.map((c, i) => (
                  <FindingBlock key={`${path}-${i}-${c.start_line}`} finding={c} />
                ))}
              </Card>
            ))
          )}
        </PageBody>
      </div>
    </div>
  );
}
