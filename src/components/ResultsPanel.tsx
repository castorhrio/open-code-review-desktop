import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, ExternalLink, FileCode2, FolderOpen, Search, Sparkles, Wrench } from "lucide-react";
import { api, type FileWindow } from "@/lib/api";
import { cn } from "@/lib/cn";
import { SEVERITY_DOT, SEVERITY_TEXT, STATUS, coverageOf, firstLine, terminalState } from "@/lib/format";
import { useStore } from "@/store";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/overlay";
import { toast } from "sonner";

const SEVERITIES = ["critical", "high", "medium", "low", ""] as const;

/** Minimal markdown for the CLI's own summary text: headings, lists, **bold**. */
function MarkdownLite({ text }: { text: string }) {
  const inline = (s: string, key: string) =>
    s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? (
        <b key={key + i} className="font-semibold text-ink">
          {part.slice(2, -2)}
        </b>
      ) : (
        <span key={key + i}>{part}</span>
      )
    );
  return (
    <div className="space-y-1.5 text-[12px] leading-relaxed text-muted">
      {text.split(/\r?\n/).map((line, i) => {
        const t = line.trim();
        if (!t) return null;
        const heading = /^(#{1,4})\s+(.*)$/.exec(t);
        if (heading)
          return (
            <p key={i} className="text-[12.5px] font-semibold text-ink">
              {inline(heading[2], "h" + i)}
            </p>
          );
        const item = /^(\d+\.|[-*])\s+(.*)$/.exec(t);
        if (item)
          return (
            <p key={i} className="flex gap-1.5 pl-1">
              <span className="shrink-0 text-faint tnum">{item[1].replace(".", "")}</span>
              <span className="min-w-0">{inline(item[2], "i" + i)}</span>
            </p>
          );
        return <p key={i}>{inline(t, "p" + i)}</p>;
      })}
    </div>
  );
}

export function ResultsPanel() {
  const { result, resultOrigin, comments, form, repo, exportSession, history, resume, running, elapsed, runLabel, progress, cancelRun, startRun, setView } = useStore();
  const [sevOn, setSevOn] = useState<Set<string>>(() => new Set(SEVERITIES));
  const [cat, setCat] = useState("");
  const [text, setText] = useState("");
  const [selected, setSelected] = useState(-1);
  const [file, setFile] = useState<FileWindow | null>(null);

  const cats = useMemo(() => [...new Set(comments.map((c) => c.category || "").filter(Boolean))].sort(), [comments]);

  const filtered = useMemo(() => {
    const q = text.toLowerCase();
    return comments
      .map((c, i) => ({ c, i }))
      .filter(
        ({ c }) =>
          sevOn.has(c.severity || "") &&
          (!cat || c.category === cat) &&
          (!q || `${c.content} ${c.path}`.toLowerCase().includes(q))
      )
      .sort((a, b) => a.c.path.localeCompare(b.c.path) || a.c.start_line - b.c.start_line);
  }, [comments, sevOn, cat, text]);

  useEffect(() => {
    setSelected(-1);
    setFile(null);
  }, [result]);

  const current = selected >= 0 ? comments[selected] : null;

  const open = useCallback(
    async (index: number) => {
      setSelected(index);
      const c = comments[index];
      if (!c) return;
      const ref = form.mode === "range" ? form.to.trim() : form.mode === "commit" ? form.commit.trim() : "";
      const res = await api.readFile({
        repo,
        path: c.path,
        startLine: c.start_line,
        endLine: c.end_line,
        ref,
        pad: 16,
      });
      setFile(res);
    },
    [comments, form, repo]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^(INPUT|TEXTAREA)$/.test((document.activeElement?.tagName || "") as string)) return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "j" && e.key !== "k") return;
      e.preventDefault();
      const delta = e.key === "ArrowDown" || e.key === "j" ? 1 : -1;
      const at = filtered.findIndex((f) => f.i === selected);
      const next = filtered[Math.min(Math.max(at + delta, 0), filtered.length - 1)];
      if (next) void open(next.i);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtered, selected, open]);

  if (running) {
    const tools = progress?.tools ?? 0;
    const total = progress?.reviewing ?? 0;
    return (
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-4 py-2">
          <Badge tone="accent">{runLabel || "审查运行中"}</Badge>
          <span className="tnum text-[11.5px] text-muted">已运行 {elapsed}s</span>
          <Button variant="ghost" size="sm" className="ml-auto text-bad" onClick={() => void cancelRun()}>
            取消
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
          <div className="mx-auto max-w-xl space-y-4">
            <p className="text-[13px] font-medium text-ink">正在审查，下面这些数字会一直动</p>
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                { label: "进入审查的文件", value: total || "—" },
                { label: "已完成的工具调用", value: tools },
                { label: "已产出的评论", value: progress?.comments ?? 0 },
              ].map((cell) => (
                <div key={cell.label} className="rounded-md border border-line bg-surface px-2 py-3">
                  <div className="tnum text-[18px] font-semibold text-ink">{cell.value}</div>
                  <div className="mt-0.5 text-[11px] leading-tight text-faint">{cell.label}</div>
                </div>
              ))}
            </div>
            {progress?.cost && <p className="rounded-md border border-line bg-raised px-3 py-2 font-mono text-[11.5px] text-muted">{progress.cost}</p>}
            {progress?.excluded ? <p className="text-[11.5px] text-faint">另有 {progress.excluded} 个文件被规则排除（原因见运行日志）。</p> : null}
            <p className="text-[11.5px] leading-relaxed text-faint">
              每个文件要先做一次预分析、再带着工具去审，所以前几分钟通常一条评论都没有——这不是卡住。
              底部「运行日志」里有 CLI 的原始输出，可整段复制。中断可以用「历史」里的会话续跑，已审完的文件不会重复计费。
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!result) {
    if (resume) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
          <Badge tone="warn">这次运行没有产出结果</Badge>
          <p className="max-w-md text-[12px] leading-relaxed text-muted">
            会话 <code className="font-mono text-[11px]">{resume.sessionId.slice(0, 12)}…</code> 已经中断
            {resume.failed ? `（${resume.failed} 个文件失败）` : ""}。保持同样的范围与模型服务点「续跑未完成部分」，已经审完的文件不会重复计费。
          </p>
          <Button variant="primary" onClick={() => void startRun(resume.sessionId)}>
            续跑未完成部分
          </Button>
          <p className="text-[11px] text-faint">也可以回「审查」页改小范围（按目录、按 diff）再跑一次。</p>
        </div>
      );
    }
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <FileCode2 className="size-8 text-faint" />
        <div>
          <p className="text-[13px] text-muted">还没有结果。</p>
          <p className="mt-1 text-[11.5px] text-faint">运行一次审查，或到「历史」里打开旧会话。</p>
          <p className="mt-1 text-[11.5px] text-faint">刚取消的运行也会留下会话，在「历史」里能续跑或导出报告。</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setView("history")}>
          去历史
        </Button>
      </div>
    );
  }

  const st = terminalState(result);
  const status = STATUS[st] || { label: st || "未知", cls: "border-line bg-raised text-muted" };
  const s = result.summary || {};
  const failed = coverageOf(result, "failed");
  const waived = coverageOf(result, "waived");
  const sessionId = result.session_id || "";
  const session = history.find((h) => h.session_id === sessionId);

  const exportJson = async () => {
    const res = await api.saveText({
      title: "导出审查结果",
      suggestedName: `ocr-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`,
      text: JSON.stringify(result, null, 2),
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (res.ok) toast.success("已导出 JSON", { description: res.file });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2">
        <Badge className={cn("h-6", status.cls)}>{status.label}</Badge>
        {resultOrigin?.kind === "session" && <Badge tone="accent">历史会话</Badge>}
        <div className="tnum flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted">
          <span>
            <b className="text-ink">{s.files_reviewed ?? "—"}</b> 文件
          </span>
          <span>
            <b className="text-ink">{s.comments ?? comments.length}</b> 条评论
          </span>
          {typeof s.total_tokens === "number" && (
            <span>
              tokens <b className="text-ink">{s.total_tokens.toLocaleString("en-US")}</b>
              <span className="text-faint">
                （入 {(s.input_tokens ?? 0).toLocaleString("en-US")} / 出 {(s.output_tokens ?? 0).toLocaleString("en-US")}
                {s.cache_read_tokens ? ` / 缓存命中 ${s.cache_read_tokens.toLocaleString("en-US")}` : ""}）
              </span>
            </span>
          )}
          {s.elapsed && (
            <span>
              耗时 <b className="text-ink">{s.elapsed}</b>
            </span>
          )}
          {result.llm?.model && <span className="text-faint">{result.llm.provider} {result.llm.model}</span>}
          {result.tool_calls?.total ? (
            <span className="text-faint">
              工具调用 {result.tool_calls.total}
              {result.tool_calls.failure ? <span className="text-bad">（失败 {result.tool_calls.failure}）</span> : null}
            </span>
          ) : null}
          {s.budget_exceeded && <span className="text-warn">已触达 token 上限</span>}
          {(result.warnings?.length ?? 0) > 0 && <span className="text-warn">{result.warnings?.length} 条警告</span>}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {sessionId && session && (
            <Button variant="ghost" size="sm" onClick={() => void exportSession(session)}>
              <FileCode2 className="size-3.5" />
              HTML 报告
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => void exportJson()}>
            <Download className="size-3.5" />
            导出 JSON
          </Button>
        </div>
      </div>

      {(failed.length > 0 || waived.length > 0) && (
        <div className="shrink-0 border-b border-warn/25 bg-warn/5 px-4 py-2">
          <div className="mb-1 text-[11.5px] font-medium text-warn">
            有 {failed.length + waived.length} 个文件没有完成，{resultOrigin?.kind === "session" ? "该会话" : "本次结果"}不等于全量审查
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {[...failed.map((f) => ({ f, kind: "未审" })), ...waived.map((f) => ({ f, kind: "跳过" }))].map(({ f, kind }) => (
              <span key={f.item_id} className="font-mono text-[11px] text-muted">
                <span className={kind === "未审" ? "text-bad" : "text-low"}>{kind}</span> {f.path || f.item_id}
                {f.reason && <span className="text-faint"> · {f.reason}</span>}
              </span>
            ))}
          </div>
          {resume && <p className="mt-1 text-[11px] text-faint">点上方「续跑未完成部分」可接着跑，已完成的部分不会重复付费。</p>}
        </div>
      )}

      {result.project_summary && (
        <div className="shrink-0 border-b border-line bg-surface px-4 py-3">
          <div className="mb-1.5 flex items-center gap-1.5">
            <Sparkles className="size-3.5 text-accent" />
            <h3 className="text-[12.5px] font-semibold text-ink">这次审查的要点</h3>
            <span className="text-[11px] text-faint">由 CLI 汇总，不是本程序生成的</span>
          </div>
          <div className="max-h-52 overflow-y-auto pr-1">
            <MarkdownLite text={result.project_summary} />
          </div>
        </div>
      )}

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-canvas px-4 py-2">
        <div className="flex items-center gap-1">
          {SEVERITIES.map((sev) => (
            <button
              key={sev || "none"}
              onClick={() =>
                setSevOn((prev) => {
                  const next = new Set(prev);
                  if (next.has(sev)) next.delete(sev);
                  else next.add(sev);
                  return next;
                })
              }
              className={cn(
                "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                sevOn.has(sev) ? "border-line-strong bg-raised text-ink" : "border-line bg-transparent text-faint"
              )}
            >
              <span className={cn("size-1.5 rounded-full", SEVERITY_DOT[sev])} />
              {sev || "未标注"}
            </button>
          ))}
        </div>
        <select
          value={cat}
          onChange={(e) => setCat(e.target.value)}
          className="h-7 rounded-sm border border-line bg-raised px-2 text-[12px] text-ink outline-none"
        >
          <option value="">全部类别</option>
          {cats.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <div className="flex h-7 min-w-40 flex-1 items-center gap-1.5 rounded-sm border border-line bg-raised px-2">
          <Search className="size-3.5 text-faint" />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="搜索评论内容…"
            className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-faint"
          />
        </div>
        <span className="tnum text-[11.5px] text-faint">
          {filtered.length}/{comments.length}
        </span>
        <span className="hidden text-[10.5px] text-faint xl:inline">↑↓ / j k 切换</span>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(260px,300px)_minmax(300px,1fr)_minmax(320px,1.1fr)] divide-x divide-line">
        <div className="min-h-0 overflow-y-auto">
          {filtered.length === 0 && <p className="p-6 text-center text-[12px] text-faint">没有匹配的评论。</p>}
          {filtered.map(({ c, i }) => {
            const sev = c.severity || "";
            return (
              <button
                key={i}
                onClick={() => void open(i)}
                className={cn(
                  "flex w-full gap-2.5 border-b border-line/60 px-3 py-2.5 text-left transition-colors",
                  i === selected ? "bg-accent-soft" : "hover:bg-hover"
                )}
              >
                <span className={cn("mt-1 w-0.5 shrink-0 self-stretch rounded-full", SEVERITY_DOT[sev])} />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-[12.5px] leading-snug text-ink">{firstLine(c.content)}</span>
                  <span className="mt-1 flex items-center gap-2 font-mono text-[10.5px] text-faint">
                    <span className="truncate">{c.path}</span>
                    <span className="tnum shrink-0">
                      L{c.start_line}
                      {c.end_line && c.end_line !== c.start_line ? `-${c.end_line}` : ""}
                    </span>
                  </span>
                </span>
                {c.category && <span className="shrink-0 self-start rounded-xs border border-line px-1 text-[10px] text-muted">{c.category}</span>}
              </button>
            );
          })}
        </div>

        <div className="min-h-0 overflow-y-auto px-4 py-3">
          {!current && <p className="pt-10 text-center text-[12px] text-faint">在左侧选择一条评论。</p>}
          {current && (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <Badge className={cn("border-transparent", SEVERITY_TEXT[current.severity || ""], "bg-transparent px-0 font-semibold")}>
                  {current.severity || "未标注严重级"}
                </Badge>
                {current.category && <Badge>{current.category}</Badge>}
                <span className="font-mono text-[11px] text-faint">
                  {current.path} · L{current.start_line}
                </span>
              </div>
              <div className="rounded-md border-l-2 border-accent bg-raised px-3 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap text-ink selectable">
                {current.content}
              </div>
              {current.existing_code && (
                <CodeBlock title="当前代码" tone="bad" text={current.existing_code} />
              )}
              {current.suggestion_code && <CodeBlock title="建议改为" tone="ok" text={current.suggestion_code} />}
              {current.thinking && (
                <details className="mt-3 text-[11.5px] text-muted">
                  <summary className="cursor-pointer text-faint hover:text-ink">
                    <Sparkles className="mr-1 inline size-3" />
                    模型判断过程
                  </summary>
                  <div className="mt-1.5 leading-relaxed whitespace-pre-wrap">{current.thinking}</div>
                </details>
              )}
            </>
          )}
        </div>

        <div className="min-h-0 overflow-auto bg-canvas">
          {current && file?.ok && (
            <>
              <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5">
                <Wrench className="size-3.5 text-faint" />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted">{current.path}</span>
                <Badge>{file.source === "git" ? `来自 ${file.ref}` : "工作区当前内容"}</Badge>
                {file.absPath && (
                  <>
                    <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard.writeText(file.absPath || "")}>
                      复制路径
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => file.absPath && void api.openFile(file.absPath)}>
                      <ExternalLink className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        if (!file.absPath) return;
                        const res = await api.revealFile(file.absPath);
                        if (!res.ok) toast.error("无法打开", { description: res.error });
                        else if (res.action === "open-parent")
                          toast("这个文件在工作区里不存在", { description: `可能是被审查的 ref 才有它，已打开：${res.path}` });
                      }}
                    >
                      <FolderOpen className="size-3.5" />
                    </Button>
                  </>
                )}
              </div>
              <pre className="px-2 py-2 font-mono text-[11.5px] leading-[1.6]">
                {file.lines?.map((l) => (
                  <div
                    key={l.n}
                    className={cn(
                      "flex gap-3 rounded-xs px-2",
                      l.n >= current.start_line && l.n <= (current.end_line || current.start_line) && "bg-hit"
                    )}
                  >
                    <span className="tnum w-10 shrink-0 text-right text-faint">{l.n}</span>
                    <span className="whitespace-pre text-ink">{l.content || " "}</span>
                  </div>
                ))}
              </pre>
            </>
          )}
          {current && file && !file.ok && <p className="p-4 text-[12px] text-bad">{file.error}</p>}
          {current && !file && <p className="p-4 text-[12px] text-faint">读取文件中…</p>}
          {!current && <p className="p-4 text-[12px] text-faint">选中评论后在这里显示对应代码位置。</p>}
        </div>
      </div>
    </div>
  );
}

function CodeBlock({ title, tone, text }: { title: string; tone: "ok" | "bad"; text: string }) {
  return (
    <div className="mt-3 overflow-hidden rounded-md border border-line">
      <div className="flex items-center justify-between bg-raised px-2.5 py-1">
        <span className={cn("text-[11px] font-medium", tone === "ok" ? "text-ok" : "text-bad")}>{title}</span>
        <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard.writeText(text)}>
          复制
        </Button>
      </div>
      <pre className="overflow-x-auto px-2.5 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre text-ink selectable">{text}</pre>
    </div>
  );
}
