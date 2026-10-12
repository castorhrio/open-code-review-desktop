import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, ExternalLink, FileCode2, FolderOpen, Search, Sparkles, Wrench, Copy, BookOpenText } from "lucide-react";
import { api, type FileWindow } from "@/lib/api";
import { cn } from "@/lib/cn";
import { SEVERITY_DOT, SEVERITY_LABEL, SEVERITY_RANK, SEVERITY_TEXT, STATUS, coverageOf, summaryLine, terminalState } from "@/lib/format";
import { copyText } from "@/lib/clipboard";
import type { Finding } from "@/lib/types";
import { useStore } from "@/store";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/form";
import { EmptyState, PanelHeader } from "@/components/ui/layout";
import { Badge } from "@/components/ui/overlay";
import { CodeBlock, MarkdownLite, findingToMarkdown } from "@/components/finding";
import { toast } from "sonner";

const SEVERITIES = ["critical", "high", "medium", "low", ""] as const;

/**
 * The file around a finding. Two homes, because the 3-pane grid only has room
 * for it above 1240px of container width:
 *
 *   pane     its own grid column (wide).
 *   stacked  its own row under the finding, inside the detail column (narrow).
 *
 * Either way the viewer is a flex column that fills its box, so the toolbar is
 * always on screen and the code scrolls in its own region — no `sticky`, and a
 * long line scrolls sideways inside the code region instead of turning the
 * whole detail column into a sideways scroller.
 *
 * Why this exists at all: measured on the built UI, the code column was 337px
 * at the 1000px window floor and 568px at 1440px, while the widest line in the
 * fixture needs 629px — so on a 1280px laptop most lines of the very thing the
 * user came to read were cut off.
 */
function FileViewer({ current, file, variant }: { current: Finding; file: FileWindow | null; variant: "pane" | "stacked" }) {
  const stacked = variant === "stacked";
  if (!file) return <p className={cn("text-body text-faint", stacked ? "px-4 py-3" : "p-4")}>读取文件中…</p>;
  if (!file.ok) return <p className={cn("text-body text-bad", stacked ? "px-4 py-3" : "p-4")}>{file.error}</p>;
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className={cn("flex min-w-0 shrink-0 items-center gap-2 border-b border-line bg-surface py-2", stacked ? "px-4" : "px-3")}>
        <Wrench className="size-3.5 shrink-0 text-faint" />
        <span className="min-w-0 flex-1 truncate font-mono text-meta text-muted">{current.path}</span>
        {/* A ref is a branch name or a SHA the user typed, and a Badge is
            `nowrap` and refuses to shrink: an uncapped one pushed this toolbar
            past the code pane and clipped the pane itself. Cap the box and keep
            the full value in the title, as the top bar does. */}
        <Badge
          title={file.source === "git" ? `来自 ${file.ref}` : "工作区当前内容"}
          className="max-w-[180px] shrink-0"
        >
          <span className="min-w-0 truncate">{file.source === "git" ? `来自 ${file.ref}` : "工作区当前内容"}</span>
        </Badge>
        {file.absPath && (
          <>
            <Button variant="ghost" size="sm" onClick={() => void copyText(file.absPath || "", "文件绝对路径")}>
              复制路径
            </Button>
            <Button variant="ghost" size="sm" title="用系统默认程序打开" onClick={() => file.absPath && void api.openFile(file.absPath)}>
              <ExternalLink className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              title="在文件夹中显示"
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
      <div className="min-h-0 flex-1 overflow-auto">
        <pre className="w-max min-w-full px-2 py-2 font-mono text-meta leading-[1.6]">
          {file.lines?.map((l) => {
            const inRange = l.n >= current.start_line && l.n <= (current.end_line || current.start_line);
            return (
              <div key={l.n} className={cn("flex gap-3 rounded-xs px-2", inRange && "bg-hit")}>
                {/* On the highlight the gutter needs one step more contrast
                    than `faint`, which lands at 4.1:1 over `--hit`. */}
                <span className={cn("tnum w-10 shrink-0 text-right", inRange ? "text-muted" : "text-faint")}>{l.n}</span>
                <span className="whitespace-pre text-ink">{l.content || " "}</span>
              </div>
            );
          })}
        </pre>
      </div>
    </div>
  );
}

/**
 * The screen a user watches for minutes, and the reason it looks the way it
 * does: a single-file review measured 3m48s end to end, during which the CLI
 * emits nothing but per-tool lines. The previous version counted those into a
 * tally every 25 and showed three zeros beside a paragraph — for a run that was
 * working perfectly, which is exactly "the app has hung".
 *
 * So the CLI's own activity *is* the interface here: every tool call, with what
 * it asked for and how long it took. It is a framed panel that fills the
 * window with its rows starting at the top, because the version this replaced
 * bottom-anchored a bare list inside an unframed flex column — 13 rows at the
 * bottom of a 900px window, and a ~490px hole where the activity should have
 * been. That hole is the single most direct cause of "it looks stuck", and a
 * panel that owns its space cannot produce it: an unfilled log region reads as
 * a log, while an unfilled void reads as a crash.
 */
function RunningView() {
  const { elapsed, runLabel, progress, cancelRun, runResumable } = useStore();
  const feed = useRef<HTMLDivElement>(null);
  const activity = progress?.activity ?? [];

  useEffect(() => {
    const el = feed.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activity.length]);

  const cells = [
    { label: "已运行", value: `${elapsed}s` },
    { label: "进入审查", value: progress ? progress.reviewing || progress.files || "—" : "…" },
    { label: "已产出评论", value: progress ? progress.comments : "…", accent: Boolean(progress?.comments) },
    { label: "工具调用", value: progress ? progress.tools : "…" },
    ...(progress && progress.excluded ? [{ label: "被规则排除", value: progress.excluded }] : []),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader>
        <Badge tone="accent">{runLabel || "审查运行中"}</Badge>
        {progress?.current && (
          <span className="flex min-w-0 items-center gap-1.5 text-meta text-faint">
            正在
            <span className="min-w-0 truncate font-mono text-body text-ink">{progress.current}</span>
          </span>
        )}
        {progress?.cost && <span className="tnum hidden text-meta text-muted sm:inline">预计 {progress.cost}</span>}
        <Button variant="ghost" size="sm" className="ml-auto shrink-0 text-bad" onClick={() => void cancelRun()}>
          取消
        </Button>
      </PanelHeader>

      <div className="grid shrink-0 grid-cols-[repeat(auto-fit,minmax(120px,1fr))] divide-x divide-line border-b border-line bg-surface">
        {cells.map((cell) => (
          <div key={cell.label} className="px-4 py-2.5">
            <div className={cn("tnum text-stat font-semibold", "accent" in cell && cell.accent ? "text-accent" : "text-ink")}>{cell.value}</div>
            <div className="mt-0.5 text-meta text-faint">{cell.label}</div>
          </div>
        ))}
      </div>

      <div className="min-h-0 flex-1 p-4">
        <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-line bg-surface">
          <div className="flex shrink-0 items-center gap-2 border-b border-line bg-raised px-3 py-1.5">
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" aria-hidden="true" />
            <h3 className="text-strong font-semibold text-ink">实时活动</h3>
            <span className="min-w-0 truncate text-meta text-faint">CLI 的每一次工具调用一行，最新在下方</span>
          </div>
          <div ref={feed} className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
            <ol className="space-y-1">
              {activity.length === 0 && (
                <li className="text-body text-faint">正在启动 ocr…第一行输出到达后，这里会开始逐条显示它在读哪个文件、查了什么。</li>
              )}
              {activity.map((a) => (
                <li key={a.id} className="flex items-baseline gap-2">
                  {a.kind === "note" ? (
                    <span className={cn("shrink-0 text-meta", a.warn ? "text-warn" : "text-accent")}>{a.warn ? "!" : "›"}</span>
                  ) : (
                    <span
                      className={cn(
                        "size-1.5 shrink-0 self-center rounded-full",
                        a.state === "running" ? "animate-pulse bg-accent" : a.state === "failed" ? "bg-bad" : "bg-ok"
                      )}
                    />
                  )}
                  <span className={cn("shrink-0 font-mono text-body", a.kind === "note" ? "text-ink" : "text-muted")}>
                    {a.kind === "note" ? a.text : a.tool}
                  </span>
                  {a.args && <span className="min-w-0 truncate font-mono text-meta text-faint">{a.args}</span>}
                  {a.ms && <span className="tnum shrink-0 font-mono text-meta text-faint">{a.ms}</span>}
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>

      <div className="shrink-0 border-t border-line bg-surface px-4 py-2 text-meta text-faint">
        每个文件先做一次预分析、再带着工具逐段读，所以前几分钟通常一条评论都没有——这不是卡住。
        {runResumable
          ? "中断后可在「历史」里续跑，已审完的文件不会重复计费。"
          : "但工作区改动的会话不支持续跑，中断了要重跑；想能续跑就改用「分支对比」或「单个提交」。"}
      </div>
    </div>
  );
}

export function ResultsPanel() {
  const { result, resultOrigin, comments, repo, exportSession, resume, running, startRun, setView } = useStore();
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

  /**
   * Land on something. A finished review used to open on two empty panes and a
   * line telling the reader to click a row — the payoff of the whole app was
   * one click away from being unseen. The most severe finding is what the run
   * was for, so that is what gets opened.
   */
  useEffect(() => {
    if (comments.length === 0) {
      setSelected(-1);
      setFile(null);
      return;
    }
    const top = comments.reduce(
      (best, c, i) =>
        SEVERITY_RANK[c.severity || ""] < SEVERITY_RANK[comments[best].severity || ""] ? i : best,
      0
    );
    void open(top);
    // `open` and `comments` are current at the time `result` changes; re-running
    // on their own identities would re-jump the reader mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const current = selected >= 0 ? comments[selected] : null;

  const open = useCallback(
    async (index: number) => {
      setSelected(index);
      const c = comments[index];
      if (!c) return;
      // The result carries the ref its own findings describe. Reading it back off
      // the review form was wrong twice over: a session from history has no
      // relation to the form, and the form can be edited while a run is going.
      const ref = resultOrigin?.fileRef || "";
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
    [comments, repo, resultOrigin]
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

  if (running) return <RunningView />;

  if (!result) {
    if (resume) {
      return (
        <EmptyState
          icon={<Badge tone="warn">这次运行没有产出结果</Badge>}
          description={
            <p className="text-body text-muted">
              会话 <code className="font-mono text-meta">{resume.sessionId.slice(0, 12)}…</code> 已经中断
              {resume.failed ? `（${resume.failed} 个文件失败）` : ""}。
              {resume.resumable
                ? "保持同样的范围与模型服务点「续跑未完成部分」，已经审完的文件不会重复计费。"
                : "工作区改动的会话不支持续跑，只能重新运行；想保留可续跑的能力就改用「分支对比」或「单个提交」。"}
            </p>
          }
          action={
            resume.resumable ? (
              <>
                <Button variant="primary" onClick={() => void startRun(resume.sessionId)}>
                  续跑未完成部分
                </Button>
                <p className="text-meta text-faint">也可以回「审查」页改小范围（按目录、按 diff）再跑一次。</p>
              </>
            ) : (
              <p className="text-meta text-faint">回「审查」页改小范围（按目录、按 diff）再跑一次。</p>
            )
          }
        />
      );
    }
    return (
      <EmptyState
        icon={<FileCode2 className="size-8 text-faint" />}
        title="还没有结果"
        description={
          <>
            <p className="text-meta text-faint">运行一次审查，或到「历史」里打开旧会话。</p>
            <p className="text-meta text-faint">
              刚取消的运行也会留下会话，在「历史」里能回看与导出报告；分支对比、单个提交和全量扫描还能续跑未完成的部分。
            </p>
          </>
        }
        action={
          // The one action that ends this state is running a review. 历史 is the
          // way back in for someone who has run one before, so it is offered
          // alongside — but a page whose only button says "go look at old
          // results" is a dead end for the user who has none.
          <div className="flex items-center gap-2">
            <Button variant="primary" size="sm" onClick={() => setView("review")}>
              去审查页开始一次
            </Button>
            <Button variant="outline" size="sm" onClick={() => setView("history")}>
              去历史
            </Button>
          </div>
        }
      />
    );
  }

  const st = terminalState(result);
  const status = STATUS[st] || { label: st || "未知", cls: "border-line bg-raised text-muted" };
  const s = result.summary || {};
  const failed = coverageOf(result, "failed");
  const waived = coverageOf(result, "waived");
  const sessionId = result.session_id || "";

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
    // `@container` so the master-detail grid below can respond to the width it
    // actually has, not to the viewport. The nav rail is a fixed 48px, so a
    // viewport media query would silently drift the moment that changes.
    <div className="@container flex h-full min-h-0 flex-col">
      <PanelHeader>
        <Badge className={status.cls}>{status.label}</Badge>
        {resultOrigin?.kind === "session" && <Badge tone="accent">历史会话</Badge>}
        <div className="tnum flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-muted">
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
          {/* This screen is a triage surface: one finding at a time, behind a
              click each. Reading a whole review top to bottom — or searching it
              with one keystroke — needs a document, which is what 阅读 opens. */}
          <Button variant="ghost" size="sm" title="把这次审查排成一份可通读的文档" onClick={() => setView("report")}>
            <BookOpenText className="size-3.5" />
            阅读
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={filtered.length === 0}
            title="把当前筛选出的评论按 Markdown 复制，可直接粘贴到 PR / MR 评论"
            onClick={() => void copyText(
              filtered.map(({ c }) => findingToMarkdown(c)).join("\n\n---\n\n"),
              ` ${filtered.length} 条评论（Markdown）`,
              "可直接粘贴到 PR / MR 评论"
            )}
          >
            <Copy className="size-3.5" />
            复制全部
          </Button>
          {sessionId && (
            <Button variant="ghost" size="sm" title="导出自包含 HTML 报告，可单独打开或转发" onClick={() => void exportSession(sessionId)}>
              <FileCode2 className="size-3.5" />
              HTML 报告
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => void exportJson()}>
            <Download className="size-3.5" />
            导出 JSON
          </Button>
        </div>
      </PanelHeader>

      {(failed.length > 0 || waived.length > 0) && (
        <div className="shrink-0 border-b border-warn/25 bg-warn/5 px-4 py-2.5">
          <div className="mb-1 text-body font-medium text-warn">
            有 {failed.length + waived.length} 个文件没有完成，{resultOrigin?.kind === "session" ? "该会话" : "本次结果"}不等于全量审查
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {[...failed.map((f) => ({ f, kind: "未审" })), ...waived.map((f) => ({ f, kind: "跳过" }))].map(({ f, kind }) => (
              <span key={f.item_id} className="font-mono text-meta text-muted">
                <span className={kind === "未审" ? "text-bad" : "text-low"}>{kind}</span> {f.path || f.item_id}
                {f.reason && <span className="text-faint"> · {f.reason}</span>}
              </span>
            ))}
          </div>
          {resume && <p className="mt-1 text-meta text-faint">点上方「续跑未完成部分」可接着跑，已完成的部分不会重复付费。</p>}
        </div>
      )}

      {result.project_summary && (
        <div className="shrink-0 border-b border-line bg-surface px-4 py-3">
          <div className="mb-2 flex items-center gap-1.5">
            <Sparkles className="size-3.5 text-accent" />
            <h3 className="text-strong font-semibold text-ink">这次审查的要点</h3>
            <span className="text-meta text-faint">由 CLI 汇总，不是本程序生成的</span>
          </div>
          <div className="max-h-52 overflow-y-auto pr-1">
            <MarkdownLite text={result.project_summary} />
          </div>
        </div>
      )}

      <PanelHeader tone="canvas">
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
              title={sev || "CLI 未标注严重级"}
              className={cn(
                "flex items-center gap-1 rounded-full border px-2 py-0.5 text-meta transition-colors",
                sevOn.has(sev) ? "border-line-strong bg-raised text-ink" : "border-line bg-transparent text-faint"
              )}
            >
              <span className={cn("size-1.5 rounded-full", SEVERITY_DOT[sev])} />
              {SEVERITY_LABEL[sev]}
            </button>
          ))}
        </div>
        {/* The one control on this screen that was not built from the app's own
            primitive: a hand-styled native <select> whose popup is drawn by the
            OS, so it ignored the theme and its trigger drifted from every other
            control in the toolbar. */}
        <Select
          value={cat}
          onValueChange={setCat}
          className="h-7 w-auto min-w-[110px] shrink-0 text-body"
          options={[{ value: "", label: "全部类别" }, ...cats.map((c) => ({ value: c, label: c }))]}
        />
        <div className="flex h-7 min-w-40 flex-1 items-center gap-1.5 rounded-sm border border-line bg-raised px-2">
          <Search className="size-3.5 text-faint" />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="搜索评论内容…"
            className="min-w-0 flex-1 bg-transparent text-body outline-none placeholder:text-faint"
          />
        </div>
        <span className="tnum text-meta text-faint">
          {filtered.length}/{comments.length}
        </span>
        <span className="hidden text-meta text-faint xl:inline">↑↓ / j k 切换</span>
      </PanelHeader>

      {/* Master-detail: the one screen that legitimately uses the whole window.
          Above 1240px of container width the three columns fit and the code gets
          its own pane with at least 620px — measured, that is what a line of
          real Go needs before it starts clipping. Below that the three tracks
          cannot be satisfied at all (240 + 340 + 620 is already 1200), so the
          code stops being a column and is stacked under the finding instead:
          same content, nothing hidden behind a breakpoint, and at 1000px the
          reading column ends up ~660px wide — wider than the 568px the code
          pane got at 1440px before this. */}
      <div className="grid min-h-0 flex-1 divide-x divide-line grid-cols-[minmax(240px,300px)_minmax(320px,1fr)_minmax(620px,1.25fr)] @max-[1240px]:grid-cols-[minmax(240px,300px)_minmax(0,1fr)]">
        <div className="min-h-0 overflow-y-auto">
          {filtered.length === 0 && (
            <div className="p-6 text-center">
              {comments.length === 0 ? (
                <>
                  {/* A review that found nothing is a result, not an empty screen.
                      Saying only "没有匹配的评论" made a clean run look like a
                      filter had eaten it. */}
                  <p className="text-body text-ink">这次审查没有提出问题。</p>
                  <p className="mt-1 text-meta text-faint">
                    已审 {String(s.files_reviewed ?? "—")} 个文件。范围不对的话，换个模式或改小排除规则再跑一次。
                  </p>
                </>
              ) : (
                <>
                  <p className="text-body text-muted">没有匹配当前筛选的评论。</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-2"
                    onClick={() => {
                      setSevOn(new Set(SEVERITIES));
                      setCat("");
                      setText("");
                    }}
                  >
                    清除筛选
                  </Button>
                </>
              )}
            </div>
          )}
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
                  <span className="line-clamp-2 text-body text-ink">{summaryLine(c.content)}</span>
                  {/* `faint` over `--accent-soft` is 4.2:1, so the selected row's
                      metadata steps up to `muted`. */}
                  <span className={cn("mt-1 flex items-center gap-2 font-mono text-meta", i === selected ? "text-muted" : "text-faint")}>
                    <span className="truncate">{c.path}</span>
                    <span className="tnum shrink-0">
                      L{c.start_line}
                      {c.end_line && c.end_line !== c.start_line ? `-${c.end_line}` : ""}
                    </span>
                  </span>
                </span>
                {c.category && <span className="shrink-0 self-start rounded-xs border border-line px-1 text-meta text-muted">{c.category}</span>}
              </button>
            );
          })}
        </div>

        {/* The reading column. Narrow: split into two rows so the code is
            always on screen instead of sitting below the fold — the finding
            block and the code each scroll on their own. Wide: one scroller, and
            the code lives in its own column. */}
        <div
          className={cn(
            "min-h-0 overflow-y-auto",
            current && "@max-[1240px]:grid @max-[1240px]:grid-rows-[minmax(0,0.46fr)_minmax(0,0.54fr)] @max-[1240px]:overflow-hidden"
          )}
        >
          <div className={cn("px-4 py-3", current && "@max-[1240px]:min-h-0 @max-[1240px]:overflow-y-auto")}>
            {/* With no findings at all the list column already carries the one
                sentence this state needs; two more placeholders in the empty
                panes turn "clean" into three competing messages. */}
            {!current && comments.length > 0 && <p className="pt-10 text-center text-body text-faint">在左侧选择一条评论。</p>}
            {current && (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-1.5">
                  <Badge
                    title={current.severity || "CLI 未标注严重级"}
                    className={cn("border-transparent", SEVERITY_TEXT[current.severity || ""], "bg-transparent px-0 font-semibold")}
                  >
                    {SEVERITY_LABEL[current.severity || ""]}
                  </Badge>
                  {current.category && <Badge>{current.category}</Badge>}
                  <span className="font-mono text-meta text-faint">
                    {current.path} · L{current.start_line}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    title="复制这一条（Markdown），含当前代码与建议改法"
                    onClick={() => void copyText(findingToMarkdown(current), "这条评论（Markdown）", "可直接粘贴到 PR / MR 评论")}
                  >
                    <Copy className="size-3.5" />
                    复制这条
                  </Button>
                </div>
                <div className="rounded-md border-l-2 border-accent bg-raised px-3 py-2.5 selectable">
                  <MarkdownLite text={current.content} className="text-strong text-ink" />
                </div>
                {current.existing_code && <CodeBlock title="当前代码" tone="bad" text={current.existing_code} />}
                {current.suggestion_code && <CodeBlock title="建议改为" tone="ok" text={current.suggestion_code} />}
                {current.thinking && (
                  <details className="mt-3 text-body text-muted">
                    <summary className="cursor-pointer text-faint hover:text-ink">
                      <Sparkles className="mr-1 inline size-3" />
                      模型判断过程
                    </summary>
                    <div className="mt-2 whitespace-pre-wrap">{current.thinking}</div>
                  </details>
                )}
              </>
            )}
          </div>
          {current && (
            <div className="min-h-0 min-w-0 border-t border-line bg-canvas @min-[1240px]:hidden">
              <FileViewer current={current} file={file} variant="stacked" />
            </div>
          )}
        </div>

        <div className="hidden min-h-0 bg-canvas @min-[1240px]:block">
          {current ? (
            <FileViewer current={current} file={file} variant="pane" />
          ) : (
            comments.length > 0 && <p className="p-4 text-body text-faint">选中评论后在这里显示对应代码位置。</p>
          )}
        </div>
      </div>
    </div>
  );
}
