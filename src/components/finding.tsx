import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { Finding, RunResult } from "@/lib/types";
import { copyText } from "@/lib/clipboard";
import { SEVERITY_LABEL, SEVERITY_TEXT, WARNING_REVIEW_LIMIT, failureLabel, failureOf, runLimitReached } from "@/lib/format";
import { Button } from "@/components/ui/button";

/**
 * The finding itself — its prose, its code, and the copy-a-colleague block.
 *
 * Two screens read a finding: the master-detail triage view on 结果, and the
 * standalone report on 阅读. They must not disagree about what a finding looks
 * like, so the rendering lives here rather than beside either caller.
 */

/**
 * The end of this app's workflow is pasting findings into a PR/MR, a chat, or a
 * ticket — and until now the only ways out were a JSON dump and a standalone
 * HTML report. Findings are already written in light markdown by the CLI, so a
 * markdown block pastes cleanly into GitHub/GitLab without re-formatting.
 */
export function findingToMarkdown(c: Finding): string {
  const line = c.end_line && c.end_line !== c.start_line ? `L${c.start_line}-${c.end_line}` : `L${c.start_line}`;
  const tags = [c.severity, c.category].filter(Boolean).join(" · ");
  const out = [`### \`${c.path}\` ${line}${tags ? ` — ${tags}` : ""}`, "", c.content.trim()];
  if (c.existing_code) out.push("", "当前代码：", "```", c.existing_code.trimEnd(), "```");
  if (c.suggestion_code) out.push("", "建议改为：", "```", c.suggestion_code.trimEnd(), "```");
  return out.join("\n");
}

/**
 * Minimal markdown for the CLI's own prose. The CLI writes findings and the
 * project summary in light markdown, so rendering them raw leaks `**` into the
 * primary reading surface. Findings name identifiers constantly, so inline code
 * is the second construct worth handling — it was rendering as literal
 * backticks in the one place a reader is trying to follow an argument about
 * `subtle.ConstantTimeCompare`.
 *
 * Both are split in a single pass so a line that mixes them keeps its order.
 * The length guards matter: a stray `**` in prose (no closing pair) must render
 * as itself, not as an empty `<b>` that silently deletes it.
 */
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`)/g;

export function MarkdownLite({ text, className }: { text: string; className?: string }) {
  const inline = (s: string, key: string) =>
    s.split(INLINE).map((part, i) => {
      if (part.length > 4 && part.startsWith("**") && part.endsWith("**"))
        return (
          <b key={key + i} className="font-semibold text-ink">
            {part.slice(2, -2)}
          </b>
        );
      if (part.length > 2 && part.startsWith("`") && part.endsWith("`"))
        return (
          <code key={key + i} className="rounded-xs bg-raised px-1 font-mono text-ink">
            {part.slice(1, -1)}
          </code>
        );
      return <span key={key + i}>{part}</span>;
    });
  return (
    <div className={cn("space-y-1.5 text-body text-muted", className)}>
      {text.split(/\r?\n/).map((line, i) => {
        const t = line.trim();
        if (!t) return null;
        const heading = /^(#{1,4})\s+(.*)$/.exec(t);
        if (heading)
          return (
            <p key={i} className="text-strong font-semibold text-ink">
              {inline(heading[2], "h" + i)}
            </p>
          );
        const item = /^(\d+\.|[-*])\s+(.*)$/.exec(t);
        if (item)
          return (
            <p key={i} className="flex gap-1.5 pl-1">
              <span className="tnum shrink-0 text-faint">{item[1].replace(".", "")}</span>
              <span className="min-w-0">{inline(item[2], "i" + i)}</span>
            </p>
          );
        return <p key={i}>{inline(t, "p" + i)}</p>;
      })}
    </div>
  );
}

export function CodeBlock({ title, tone, text }: { title: string; tone: "ok" | "bad"; text: string }) {
  return (
    <div className="mt-3 overflow-hidden rounded-md border border-line">
      <div className="flex items-center justify-between bg-raised px-3 py-1">
        <span className={cn("text-meta font-medium", tone === "ok" ? "text-ok" : "text-bad")}>{title}</span>
        <Button variant="ghost" size="sm" onClick={() => void copyText(text, `「${title}」代码`)}>
          复制
        </Button>
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-meta whitespace-pre text-ink selectable">{text}</pre>
    </div>
  );
}

/**
 * Why the whole run stopped.
 *
 * `manifest.run_failure` is the CLI's structured answer, and it was the one
 * part of a failed run the app dropped: both results surfaces showed a red 失败
 * badge and nothing else, so "the model service refused us", "the config has no
 * key" and "the budget ran out" all read the same — even though the follow-up
 * is different for each. The reason stays in the tooltip: it is English prose
 * naming endpoints, and the classification is the sentence written for a
 * person. Rendered beside the badge on both surfaces so they cannot drift.
 */
export function RunFailureNote({ result, className }: { result: RunResult; className?: string }) {
  const failure = failureOf(result);
  if (!failure) return null;
  return (
    <span
      className={cn("min-w-0 max-w-[240px] truncate text-meta text-bad", className)}
      title={failure.reason || failure.classification}
    >
      失败原因：{failure.label}
    </span>
  );
}

/**
 * What the run did not cover.
 *
 * A live run carries `manifest.coverage`, so it can name the files. A session
 * reopened from history cannot — `ocr session comments` returns findings only and
 * `session list` records just a count — so it says how many instead. Either way
 * the block exists because the product's own promise is that a truncated run
 * never reads as a clean one, and a 部分完成 badge over a page that lists nothing
 * as missed breaks that promise quietly.
 *
 * Both results surfaces render this, and they had drifted-able copies of it.
 */
export function CoverageNotice({
  failed,
  waived,
  failedFiles,
  subject,
  resumeHint,
  className,
}: {
  failed: { item_id: string; path?: string; reason?: string; classification?: string }[];
  waived: { item_id: string; path?: string; reason?: string; classification?: string }[];
  failedFiles: number;
  subject: string;
  resumeHint?: ReactNode;
  className?: string;
}) {
  const known = failed.length + waived.length;
  if (!known && !failedFiles) return null;
  return (
    <div className={cn("bg-warn/5 px-4 py-2.5 text-warn", className)}>
      <div className="mb-1 text-body font-medium">
        有 {Math.max(known, failedFiles)} 个文件没有完成，{subject}不等于全量审查
      </div>
      {known > 0 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {[...failed.map((f) => ({ f, kind: "未审" })), ...waived.map((f) => ({ f, kind: "跳过" }))].map(({ f, kind }) => (
            <span key={f.item_id} className="font-mono text-meta text-muted">
              <span className={kind === "未审" ? "text-bad" : "text-low"}>{kind}</span> {f.path || f.item_id}
              {/* The CLI classifies every failed item; only some carry prose.
                  A row that said nothing but "未审 internal/..." left the reader
                  to guess whether it timed out or never got dispatched. */}
              {f.reason ? (
                <span className="text-faint"> · {f.reason}</span>
              ) : f.classification ? (
                <span className="text-faint"> · {failureLabel(f.classification)}</span>
              ) : null}
            </span>
          ))}
        </div>
      ) : (
        <div className="text-meta text-faint">
          会话记录里只有失败的文件数，CLI 的会话导出没有给出具体是哪些；续跑会重新派发它们。
        </div>
      )}
      {resumeHint}
    </div>
  );
}

/**
 * What a truncated run could not tell you.
 *
 * `review_limit_reached` (upstream v1.13.1) and `summary.budget_exceeded` say a
 * declared limit stopped the run, but the CLI still reports it as a success —
 * the files it did read are complete. With findings on screen the app used to
 * show only a small 已达审查上限 chip, and the report showed nothing at all; a
 * reader had no way to know the review stopped early and more files may be
 * missing. Both surfaces render this band, so they cannot drift.
 */
export function RunLimitNotice({ result, subject, className }: { result: RunResult; subject: string; className?: string }) {
  if (!runLimitReached(result)) return null;
  const files = [
    ...new Set(
      (result.warnings ?? [])
        .filter((w) => w?.type === WARNING_REVIEW_LIMIT && w.file)
        .map((w) => w.file as string)
    ),
  ];
  const budget = Boolean(result.summary?.budget_exceeded);
  return (
    <div className={cn("bg-warn/5 px-4 py-2.5 text-warn", className)}>
      <div className="text-body font-medium">
        这次审查在达到{budget ? " token 预算" : ""}上限时停下
      </div>
      <div className="mt-1 text-meta text-muted">
        {subject}不等于全量审查：后面的文件可能没被审到。提高上限或缩小范围再跑一次。
      </div>
      {files.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-meta text-muted">
          <span className="shrink-0">触到上限：</span>
          {files.slice(0, 8).map((f) => (
            <span key={f} className="min-w-0 max-w-[420px] truncate font-mono text-faint" title={f}>
              {f}
            </span>
          ))}
          {files.length > 8 && <span className="shrink-0 text-faint">等 {files.length} 个文件</span>}
        </div>
      )}
    </div>
  );
}

/** A finding as a block of reading: severity, where it is, prose, both code sides.
 *  The 16px inset is `Card`'s own body padding, not a measure of its own. */
export function FindingBlock({ finding: c }: { finding: Finding }) {
  return (
    <article className="border-b border-line px-4 py-4 last:border-b-0">
      <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        <SeverityTag severity={c.severity} />
        {c.category && <span className="rounded-xs border border-line px-1 text-meta text-muted">{c.category}</span>}
        <span className="tnum min-w-0 truncate font-mono text-meta text-faint">
          L{c.start_line}
          {c.end_line && c.end_line !== c.start_line ? `-${c.end_line}` : ""}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          title="复制这一条（Markdown），含当前代码与建议改法"
          onClick={() => void copyText(findingToMarkdown(c), "这条评论（Markdown）", "可直接粘贴到 PR / MR 评论")}
        >
          复制这条
        </Button>
      </div>
      <div className="rounded-md border-l-2 border-accent bg-raised px-3 py-2.5 selectable">
        <MarkdownLite text={c.content} className="text-strong text-ink" />
      </div>
      {c.existing_code && <CodeBlock title="当前代码" tone="bad" text={c.existing_code} />}
      {c.suggestion_code && <CodeBlock title="建议改为" tone="ok" text={c.suggestion_code} />}
      {c.thinking && (
        <details className="mt-3 text-body text-muted">
          <summary className="cursor-pointer text-faint hover:text-ink">模型判断过程</summary>
          <div className="mt-2 whitespace-pre-wrap">{c.thinking}</div>
        </details>
      )}
    </article>
  );
}

function SeverityTag({ severity }: { severity?: string }) {
  const sev = severity || "";
  return (
    <span
      title={sev || "CLI 未标注严重级"}
      className={cn("text-strong font-semibold", SEVERITY_TEXT[sev])}
    >
      {SEVERITY_LABEL[sev]}
    </span>
  );
}
