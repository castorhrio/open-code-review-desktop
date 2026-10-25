import type { RunManifest, RunResult, SessionSummary, Severity } from "./types";

export const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, "": 4 };

export const SEVERITY_TEXT: Record<Severity | string, string> = {
  critical: "text-critical",
  high: "text-high",
  medium: "text-medium",
  low: "text-low",
  "": "text-muted",
};

export const SEVERITY_DOT: Record<Severity | string, string> = {
  critical: "bg-critical",
  high: "bg-high",
  medium: "bg-medium",
  low: "bg-low",
  "": "bg-line-strong",
};

/**
 * The CLI's severity vocabulary is English, and every other label in the app is
 * Chinese — so the filter pills and the detail badge read as raw enum values.
 * The enum stays available as the tooltip, because it is what the CLI writes and
 * what a user sees in an exported report.
 */
export const SEVERITY_LABEL: Record<string, string> = {
  critical: "严重",
  high: "高",
  medium: "中",
  low: "低",
  "": "未标注",
};

/** `status` / `manifest.terminal_state` vocabulary of the CLI. */
export const STATUS: Record<string, { label: string; cls: string }> = {
  success: { label: "完成", cls: "border-ok/40 bg-ok/10 text-ok" },
  complete: { label: "完成", cls: "border-ok/40 bg-ok/10 text-ok" },
  partial: { label: "部分完成", cls: "border-warn/40 bg-warn/10 text-warn" },
  completed_with_warnings: { label: "有警告", cls: "border-warn/40 bg-warn/10 text-warn" },
  completed_with_errors: { label: "部分失败", cls: "border-warn/40 bg-warn/10 text-warn" },
  failed: { label: "失败", cls: "border-bad/40 bg-bad/10 text-bad" },
  skipped: { label: "已跳过", cls: "border-line bg-raised text-muted" },
  aborted: { label: "已中断", cls: "border-warn/40 bg-warn/10 text-warn" },
  unknown: { label: "状态未记录", cls: "border-line bg-raised text-muted" },
};

export const EXCLUDE_REASON: Record<string, string> = {
  user_exclude: "你排除的",
  unsupported_ext: "暂不支持的类型",
  default_path: "默认排除路径",
  secret_exclude: "凭据文件",
  provider_directory: "生成物目录",
  deleted: "已删除",
  binary: "二进制",
  too_large: "过大",
};

/**
 * The CLI's per-file status in a preview.
 *
 * Captured from the real binary, not inferred: `ocr review --preview` spells the
 * value out in full (`modified` / `added` / `deleted`), and `ocr scan --preview`
 * returns a constant `scan` with `deletions: 0` and `insertions` as the file's
 * total line count, because a scan has no diff to describe. `scan` is
 * deliberately absent here — 全量扫描 does not render a status at all, since the
 * same word on all 66 rows of a real scan carries no per-file information.
 *
 * The list used to print the raw value, and the audit's fixture had invented
 * single letters (`M` / `A`) that the CLI never emits — so every screenshot of
 * this list showed a vocabulary that does not exist, which is also what hid the
 * repeated `scan`.
 */
export const FILE_STATUS: Record<string, string> = {
  modified: "修改",
  added: "新增",
  deleted: "删除",
  renamed: "重命名",
};

export const MODE_LABEL: Record<string, string> = {
  workspace: "工作区",
  range: "分支对比",
  commit: "单提交",
  full_scan: "全量扫描",
};

export function fmtNum(n: number | undefined): string {
  return typeof n === "number" ? n.toLocaleString("en-US") : "—";
}

export function terminalState(value: RunResult | null | undefined): string {
  if (!value) return "";
  return (value.manifest && value.manifest.terminal_state) || value.status || "";
}

/**
 * The terminal state of a session, from the best evidence available.
 *
 * Sessions written before the run-manifest format (`legacy: true`) carry no
 * `terminal_state` at all. This used to return "complete" for every one of
 * them, which is not a neutral default — it is an affirmative claim, and on a
 * real machine it was wrong: a session whose 27 of 27 files had failed was
 * listed as 完成 with a green badge. The counts *are* recorded even for those
 * sessions, so infer from them, and say "unknown" rather than guess when even
 * they are empty.
 */
export function sessionState(s: SessionSummary): string {
  if (s.aborted) return "aborted";
  if (s.run_manifest?.terminal_state) return s.run_manifest.terminal_state;
  const selected = s.selected_files || 0;
  const done = (s.completed_files || 0) + (s.reused_files || 0);
  const failed = s.failed_files || 0;
  if (failed && selected && failed >= selected) return "failed";
  if (failed) return "partial";
  if (selected && done >= selected) return "complete";
  return "unknown";
}

export function coverageOf(value: RunResult | null | undefined, kind: "failed" | "waived") {
  return (value?.manifest?.coverage?.[kind] ?? []) as { item_id: string; path?: string; reason?: string; classification?: string }[];
}

/**
 * The commit a run was actually executed against, when the CLI recorded it.
 *
 * The manifest's `input` holds the endpoints git resolved *before* the run
 * started — upstream `internal/session/manifest.go`: "Resolved values are
 * actual commit SHAs captured before execution, not the mutable refs the user
 * typed". A ref is a name that moves; a commit is not. A workspace review has
 * no immutable head (upstream leaves it empty — "workspace has no immutable
 * head"), so it correctly answers "" here.
 */
export function reviewedCommit(manifest?: RunManifest | null): string {
  return manifest?.input?.resolved_head || "";
}

/**
 * A commit shown the way a terminal shows it: seven characters is what git
 * itself abbreviates to, and a full SHA in a badge is unreadable.
 */
export function shortRef(ref: string | undefined): string {
  const s = String(ref || "");
  return /^[0-9a-f]{40}$/i.test(s) ? s.slice(0, 7) : s;
}

/**
 * The ref a session's findings describe.
 *
 * A session records the *name* it was given ("main…feat/x"), and a branch is a
 * moving target: reopen the session after the branch moved on and the code pane
 * would show the branch's current content — not the code the findings were
 * written about. The CLI freezes the real endpoints before it runs and keeps
 * them in the manifest, which is persisted with the session and read back by
 * `ocr session list --json`, so the reviewed commit is recoverable.
 *
 * Prefer the resolved commit. Fall back to the recorded ref name only for
 * sessions written before the manifest existed (and for a scan), where the name
 * is all there is.
 */
export function sessionFileRef(s: SessionSummary): string {
  const resolved = reviewedCommit(s.run_manifest);
  if (resolved) return resolved;
  if (s.review_mode === "range") return s.diff_to || "";
  if (s.review_mode === "commit") return s.diff_commit || "";
  return "";
}

/**
 * The CLI's warning type for "a declared limit truncated this run".
 *
 * Upstream v1.13.1 added it: when the main loop spends its last tool-request
 * round — or the aggregate token budget — the task is sent into a grace round
 * that only offers `code_comment` and `task_done`, and the CLI records
 * `review_limit_reached` so a spent limit stays visible. It covers the round
 * budget too, which `summary.budget_exceeded` does not: that flag is only set
 * for the *token* budget.
 */
export const WARNING_REVIEW_LIMIT = "review_limit_reached";

/**
 * Whether this run was cut short by a limit, and so cannot be read as a complete
 * one.
 *
 * The app's own promise is that a truncated run never looks like a clean one
 * (README, "Honest run status"), and "clean" is the claim this app makes most
 * strongly — a review that found nothing is rendered as a finished, good
 * result. That claim is only supported when the run was allowed to finish, so
 * the two structured signals the CLI emits are checked rather than the comment
 * count alone: the `review_limit_reached` warning, and `summary.budget_exceeded`
 * for the token budget (upstream v1.13.1 made that flag correct for `scan`
 * runs too, which used to report a budget stop as `false`).
 *
 * The CLI also says it in its own `message` ("A review limit was reached before
 * finishing; some findings may be missing."), but that is prose in English and
 * is not read here — a wording change upstream must not change what the app
 * claims.
 */
export function runLimitReached(value: RunResult | null | undefined): boolean {
  if (!value) return false;
  if (value.summary?.budget_exceeded) return true;
  return (value.warnings ?? []).some((w) => w?.type === WARNING_REVIEW_LIMIT);
}

/**
 * Whether a persisted manifest records the aggregate token budget stopping the
 * run. Upstream attributes every item the budget left undispatched to
 * `failed(budget)` and deliberately keeps them in coverage — it is a controlled
 * truncation, not a run failure — so this is the one budget signal a reopened
 * session still carries. The round-limit warning is not persisted; the live
 * result is recorded separately (see `run-diagnostics.js`).
 */
export function manifestBudgetExceeded(manifest: RunManifest | null | undefined): boolean {
  return (manifest?.coverage?.failed ?? []).some((item) => item.classification === "budget");
}

/**
 * Why a run stopped, in the app's own language.
 *
 * The CLI writes a run-level failure as `manifest.run_failure`, with its own
 * fixed vocabulary (`internal/session/manifest.go`): input / configuration /
 * timeout / cancelled / budget / internal / unknown. It is a different enum
 * from the per-file classes carried by `coverage.failed[].classification`
 * (provider / timeout / cancelled / configuration / input / budget / panic /
 * unknown) — a run never fails with "provider", that is always one file — so
 * both are mapped here, and the header note says 失败原因 while a coverage row
 * says 未审 · 原因. Neither string is invented: an unknown value is shown as
 * itself rather than being folded into "unknown", because a value this build
 * has never heard of is the one a reader most needs to see.
 */
export const FAILURE_LABEL: Record<string, string> = {
  // run-level
  input: "审查范围无效",
  configuration: "配置不完整",
  timeout: "超时",
  cancelled: "已取消",
  budget: "预算用尽",
  internal: "程序内部错误",
  unknown: "原因不明",
  // per-file class, from coverage.failed
  provider: "模型服务出错",
  panic: "程序崩溃",
};

export function failureLabel(classification: string | undefined): string {
  const c = String(classification || "");
  return FAILURE_LABEL[c] || c;
}

/**
 * The run-level failure a result carries, ready to render.
 *
 * The badge alone said 失败 and nothing else, so a reader could see that a run
 * broke but not whether it was worth retrying (timeout), fixing (configuration),
 * or asking again later (budget). The reason is the CLI's English prose and
 * names providers, so it stays in a tooltip; the classification is the part
 * that belongs in the sentence.
 */
export function failureOf(value: RunResult | null | undefined): { classification: string; label: string; reason: string } | null {
  const failure = value?.manifest?.run_failure;
  if (!failure) return null;
  const classification = String(failure.classification || "");
  return {
    classification,
    label: failureLabel(classification) || "原因不明",
    reason: String(failure.reason || "").trim(),
  };
}

export function needsContinuation(value: RunResult): boolean {
  const st = terminalState(value);
  return st === "partial" || st === "failed" || coverageOf(value, "failed").length > 0;
}

/**
 * The one line of a CLI failure that a person can act on.
 *
 * `ocr-service.js` appends a translated hint as a `→ …` line whenever it
 * recognises the error, and that line is the one written for a human. Everything
 * above it is the CLI's own wording — `Error: --to value "x" is not a valid
 * commit ref: fatal: Needed a single revision` — which names flags and git
 * internals rather than the field to fix. Three surfaces used to take
 * `error.split("\n")[0]` and so printed exactly the line the hint exists to
 * replace; the full text stays available (and selectable) underneath.
 */
export function cliReason(text: string): string {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const hint = lines.find((l) => l.startsWith("→"));
  return (hint ? hint.replace(/^→\s*/, "") : lines[0] || "").trim();
}

/**
 * The same failure split into a title and the context underneath it.
 *
 * A toast has one line of title and a description below it. A failed run used to
 * take `error.split("\n")[0]` for the title — the CLI's own wording, naming
 * providers and flags — and put the translated hint, the one line written for a
 * person, second. ReviewPanel had already worked out that the hint belongs first;
 * the run-failure toast had not, so the same error read differently depending on
 * which surface reported it.
 *
 * The detail keeps everything else, hint line excepted, because the CLI's words
 * are still the only place a provider's own message appears.
 */
export function cliFailure(text: string): { reason: string; detail?: string } {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const hint = lines.find((l) => l.startsWith("→"));
  const reason = (hint ? hint.replace(/^→\s*/, "") : lines[0] || "").trim();
  const detail = lines.filter((l) => l !== hint).join("\n").trim();
  return { reason, detail: detail || undefined };
}

export function humanTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function humanDuration(ns: number | undefined): string {
  if (!ns) return "";
  const secs = Math.round(ns / 1e9);
  if (secs < 60) return `${secs} 秒`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} 分 ${secs % 60} 秒`;
  return `${Math.floor(mins / 60)} 时 ${mins % 60} 分`;
}

/**
 * The one-line summary of a finding, for the master list.
 *
 * The CLI writes findings in light markdown, and the list rendered it raw: a row
 * read `**密码校验用了普通的字符串比较**` and `这里对 `email` 建了索引却又套了
 * `LOWER()``, while the pane beside it rendered the same text bold. The list is
 * the navigation surface for the whole screen, so every row was showing
 * punctuation that exists only to be consumed by a renderer.
 *
 * Strip the markers rather than render them: this is a summary, and the
 * formatted version is one click away. Leading blank lines are skipped, because
 * findings often open with one.
 */
export function summaryLine(s: string): string {
  const line = String(s || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return "";
  return line
    .replace(/^#{1,6}\s+/, "") // heading
    .replace(/^(\d+\.|[-*+])\s+/, "") // list marker
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // link -> its text
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/`([^`]*)`/g, "$1") // inline code
    .slice(0, 200);
}
