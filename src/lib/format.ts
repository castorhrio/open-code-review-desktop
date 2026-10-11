import type { RunResult, SessionSummary, Severity } from "./types";

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

export function needsContinuation(value: RunResult): boolean {
  const st = terminalState(value);
  return st === "partial" || st === "failed" || coverageOf(value, "failed").length > 0;
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

export function firstLine(s: string): string {
  return String(s || "").split(/\r?\n/)[0].slice(0, 200);
}
