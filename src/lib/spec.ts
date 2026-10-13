import type { ReviewMode, Spec } from "./types";

/**
 * UI-side mirror of the main process flag whitelist. `ocr scan` and `ocr review`
 * are separate commands with different accepted flags, and `--resume` only works
 * where the input can be re-derived from refs.
 */
export const MODE_META: Record<
  ReviewMode,
  { label: string; command: string; hint: string; resumable: boolean; usesDiff: boolean }
> = {
  workspace: {
    label: "工作区改动",
    command: "ocr review",
    hint: "暂存 + 未暂存 + 未跟踪的改动，一次审完。工作区改动不支持续跑，中断了要重跑。",
    resumable: false,
    usesDiff: true,
  },
  range: {
    label: "分支对比",
    command: "ocr review --from X --to Y",
    hint: "按 merge-base 对比两个 ref，适合评审一条特性分支。可续跑。",
    resumable: true,
    usesDiff: true,
  },
  commit: {
    label: "单个提交",
    command: "ocr review --commit SHA",
    hint: "审查单个提交相对其父提交的改动。可续跑。",
    resumable: true,
    usesDiff: true,
  },
  scan: {
    label: "全量扫描",
    command: "ocr scan",
    hint: "不看 diff，整文件通读，适合接手陌生代码库或安全审计。可续跑。",
    resumable: true,
    usesDiff: false,
  },
};

/**
 * Whether a run of this mode can be continued, from the mode the CLI recorded.
 *
 * Promised in several places and honoured in fewer until now: cancelling a
 * workspace review leaves an `aborted` session the CLI refuses to resume
 * (`resume requires --from/--to or --commit`), so "到「历史」里续跑" was a promise
 * the default mode could not keep. `full_scan` is the CLI's spelling of `scan`.
 */
export function resumableMode(mode: string | undefined): boolean {
  const key = mode === "full_scan" ? "scan" : (mode ?? "workspace");
  // Looked up as a plain record: a mode this build has never seen must read as
  // *not* resumable rather than throw, because the answer is a promise to the
  // user that the CLI will accept the resume.
  const meta = (MODE_META as Record<string, { resumable: boolean }>)[key];
  return Boolean(meta?.resumable);
}

export const EFFORTS = [
  { value: "", label: "默认（跟随配置）" },
  { value: "low", label: "low — 更快更省" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high — 更深更慢" },
];

export const LANGUAGES = [
  { value: "", label: "不设置（模板默认）" },
  { value: "Chinese", label: "Chinese — 中文" },
  { value: "English", label: "English" },
  { value: "Japanese", label: "Japanese" },
  { value: "Korean", label: "Korean" },
];

export const BUDGET_PRESETS = [
  { value: "", label: "不限" },
  { value: "100000", label: "10 万" },
  { value: "300000", label: "30 万" },
  { value: "1000000", label: "100 万" },
];

export function intOrEmpty(value: string): number | "" {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : "";
}

/**
 * What to say when a scope resolves to zero files, per mode.
 *
 * The sentence used to be written for 工作区改动 and then shown to every mode:
 * a 分支对比 with an empty diff was told to "改用「分支对比」或「单个提交」" — i.e.
 * to switch to the mode it was already in — and a 单个提交 with an empty commit
 * was told the working tree had no changes. Each mode can only be empty for its
 * own reason, so each gets its own sentence and its own title.
 */
export const EMPTY_SCOPE: Record<ReviewMode, { title: string; detail: string }> = {
  workspace: {
    title: "当前范围没有文件可审查",
    detail: "工作区没有改动时属正常。想审一条分支的改动可改用「分支对比」，想审某个提交可改用「单个提交」。",
  },
  range: {
    title: "这两个 ref 之间没有差异",
    detail:
      "按 merge-base 比较，目标分支没有领先基线分支的提交。若你要评审一条特性分支，基线应填它的上游分支（如 main），目标填这条分支——两个 ref 填反了就会得到空 diff。",
  },
  commit: {
    title: "这个提交没有可审查的改动",
    detail: "它相对父提交没有改动，可能是空提交或合并提交。换一个提交号，或改用「分支对比」。",
  },
  scan: {
    title: "没有文件需要通读",
    detail: "这个路径下没有可通读的文件。换个「扫描路径」，或确认目录里有该语言支持读取的源文件。",
  },
};

export function validateSpec(spec: Spec): string {
  // The picker is in the top bar; this line is the first thing a cold start reads.
  if (!spec.repo) return "先在顶部的仓库栏里选一个 git 仓库目录。";
  if (spec.mode === "range" && (!spec.from || !spec.to)) {
    // Name the field that is actually missing. The blanket "fill in from and to"
    // was wrong whenever one of them was already filled — which is now the common
    // case, because a repository with a single branch is deliberately given no
    // base rather than a base equal to the target. Telling the reader to fill in
    // something that is already there sends them looking in the wrong place.
    if (!spec.from && !spec.to) return "分支对比需要填基线 (from) 和目标 (to)。";
    if (!spec.from) return "分支对比还缺基线 (from)：选一个要对比的基准分支。";
    return "分支对比还缺目标 (to)：选一个要审查的分支或提交。";
  }
  if (spec.mode === "commit" && !spec.commit) return "请填写要审查的提交号，或从下拉里选一个。";
  return "";
}
