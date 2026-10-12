import { cn } from "@/lib/cn";
import type { Finding } from "@/lib/types";
import { copyText } from "@/lib/clipboard";
import { SEVERITY_LABEL, SEVERITY_TEXT } from "@/lib/format";
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

/** A finding as a block of reading: severity, where it is, prose, both code sides. */
export function FindingBlock({ finding: c }: { finding: Finding }) {
  return (
    <article className="report-finding border-b border-line px-6 py-5 last:border-b-0">
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
          className="ml-auto no-print"
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
