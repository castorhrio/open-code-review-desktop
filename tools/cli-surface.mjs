// SPDX-License-Identifier: Apache-2.0
// audit:surface — the CLI's parameter surface, checked against the CLI itself.
//
// DOD-2 promises "the engine is not forked": this app only spells arguments,
// streams the CLI's own log and parses the CLI's own JSON. Until now the closest
// thing to evidence for that promise was `audit:service`, which builds arguments
// for the shapes the UI actually uses, and a hand-written per-mode whitelist in
// `ocr-service.js`. Neither answers the question a reviewer asks: *every* flag
// this wrapper sends, against *every* flag the pinned CLI defines. That is the
// gap the sync doc's DOD-2 reason names as 「参数面成片没逐条核过」, and a gap of
// that shape does not close by re-reading prose harder.
//
// So this check asks two machines instead of one reader:
//
//   - the binary the app would actually spawn, for the truth about which flags a
//     command accepts and what kind of value each takes (`--help`, section
//     `Flags` + `Global Flags`);
//   - the wrapper itself, for the truth about which flags it sends: `spawn` is
//     replaced by a recorder, `preview` / `startRun` / the session, rules and
//     config calls are driven with a maximally-populated spec, and the argv each
//     one produces is the inventory. Nothing here is a guess read off a regex
//     over the source — the code hands over its own command lines.
//
// The rules are then a bijection between the two, and each direction catches a
// different real failure:
//
//   1. 声明的 flag 必须在 CLI 的 help 里，且类型一致 — a flag renamed or retyped
//      upstream turns into "unknown flag" and aborts the whole run.
//   2. 声明的 flag 必须真的被拼出来 — a row nobody consumes is a copy of a
//      contract that no longer exists, which is what makes a table rot.
//   3. 拼出来的 flag 必须都在表里 — an argument added without a comparison row is
//      the fork creeping in from the other side.
//   4. CLI 提供、本仓不用的 flag 必须逐条写下为什么不 — so the day upstream
//      exposes a new one, this check says "unclassified" instead of quietly
//      passing, and the GUI's decision to expose it or not gets made on purpose.
//   5. 「某命令不收某个 flag」也要能核对 — the per-mode whitelist exists because
//      `ocr scan` refuses `--effort`, `--no-filter` and `--background-file`, and
//      sending one kills the run. That belief is a claim about the help output,
//      so it is checked against the help output.
//   6. `--preview` 永不带 `--resume` — the CLI rejects the pair, and the preview
//      call shares the spec object with the run button.
//   7. help 读的是被 pin 的那一版 — the binary's own version line has to carry the
//      pinned tag and a commit prefix of the pinned SHA, or every answer above is
//      about some other release. A version probe is cheap; "which CLI answered"
//      is the question a green parameter surface would otherwise dodge.
//
// Rows here are grouped by command, and one row may name two commands only when
// the flag, the kind and the reason are identical for both. `--max-tools` is not
// such a case: review's help says `min 50`, scan's says `only takes effect when
// greater than template default`, so those are two rows with two notes — which is
// also the point of keeping this table in the open.

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PIN_MODULE = "./upstream-watch.mjs";

// The flag-like literals the two consumer modules contain. `--help` and a bare
// `-` are excluded at extraction: the first is cobra's own, the second is the
// CLI's documented spelling for "stdout" and never a flag.
const CONSUMER_SOURCES = ["ocr-service.js", "config-handler.js"];

// ---- the vocabulary ----

/** Every command path this check reads the help of, in the order a reader meets
 *  them: the two run commands, then the reads, then the config writes. */
export const CLI_COMMANDS = Object.freeze([
  "review",
  "scan",
  "session list",
  "session comments",
  "session export",
  "session rm",
  "rules check",
  "config set",
  "config unset",
  "llm providers",
  "llm test",
  "version",
]);

export const KINDS = Object.freeze(["string", "int", "bool"]);

// Cobra prints a flag as `--name <type>` and says nothing for a boolean, so an
// unrecognised word after a flag name is not a kind we can compare — the parser
// reports it and the caller refuses it rather than guessing "bool".
const KNOWN_HELP_KINDS = new Set(["string", "int", "int64", "uint", "uint64", "float64", "duration", "bool"]);

// ---- the declared surface ----
//
// One row per (command, flag) this wrapper sends. `why` is the sentence that
// makes the row arguable: it says what the flag is for *here*, which is what a
// reader compares against the CLI's own help text.

// Rows are one line each on purpose: this is a comparison table, and a reader
// arguing with one row should be able to point at one row.
export const CLI_SURFACE = Object.freeze([
  // `ocr review` — the three diff modes share this command; the mode decides
  // which of `--from/--to/--commit` is spelled, everything below is per spec.
  { command: "review", token: "--repo", kind: "string", why: "用户选中的仓库根目录，同时也是 spawn 的 cwd" },
  { command: "review", token: "--format", kind: "string", why: "固定 json：结果由界面解析，不由人读文本反推" },
  { command: "review", token: "--color", kind: "string", why: "never：日志逐行分类，ANSI 转义会弄脏行首" },
  { command: "review", token: "--from", kind: "string", why: "分支对比范围的起点（merge-base 由 CLI 自己算）" },
  { command: "review", token: "--to", kind: "string", why: "分支对比范围的终点" },
  { command: "review", token: "--commit", kind: "string", why: "单提交范围的那个 ref" },
  { command: "review", token: "--provider", kind: "string", why: "单次运行的服务商覆盖，只进这一条命令行、不写全局配置" },
  { command: "review", token: "--model", kind: "string", why: "单次运行的模型覆盖，同上" },
  { command: "review", token: "--exclude", kind: "string", why: "界面上的排除模式（逗号分隔的 gitignore 样式）" },
  { command: "review", token: "--background", kind: "string", why: "业务背景，行内文本" },
  { command: "review", token: "--background-file", kind: "string", why: "业务背景，Markdown 文件；CLI 说它优先于 --background" },
  { command: "review", token: "--concurrency", kind: "int", why: "最多并发子任务数，界面上的一个数字输入" },
  { command: "review", token: "--max-tokens", kind: "int", why: "每组 prompt 的 token 上限（help 写 per-group）" },
  { command: "review", token: "--max-tokens-budget", kind: "int", why: "成本护栏的主数：预算截断要让界面看得见" },
  { command: "review", token: "--max-tools", kind: "int", why: "每个子任务最多工具调用轮数（help 写 0 = 模板默认、min 50）" },
  { command: "review", token: "--timeout", kind: "int", why: "任务的时间预算（分钟），与运行取消是两件事" },
  { command: "review", token: "--rule", kind: "string", why: "自定义 rule.json 的路径；留空由 CLI 用内置规则" },
  { command: "review", token: "--audience", kind: "string", why: "输出形态交给用户：human 走进度、agent 只给摘要" },
  { command: "review", token: "--effort", kind: "string", why: "审查力度预设 low/medium/high，review 独有" },
  { command: "review", token: "--no-filter", kind: "bool", why: "跳过 LLM 后置过滤，保留全部评论，review 独有" },
  { command: "review", token: "--resume", kind: "string", why: "从官方会话续跑；只在 CLI 支持续跑的范围上拼" },
  { command: "review", token: "--preview", kind: "bool", why: "零成本清单：这个产品的立身之本，不花一个 token" },

  // `ocr scan` — a separate cobra command, not a flag of review. The whole point
  // of this second block is that its `--max-tokens` / `--max-tools` mean per-file
  // and per-subtask with a different adoption rule.
  { command: "scan", token: "--repo", kind: "string", why: "同上：仓库根目录 + cwd" },
  { command: "scan", token: "--format", kind: "string", why: "json，与 review 同一份解析器" },
  { command: "scan", token: "--color", kind: "string", why: "never，与 review 同一套日志分类" },
  { command: "scan", token: "--provider", kind: "string", why: "单次运行的服务商覆盖" },
  { command: "scan", token: "--model", kind: "string", why: "单次运行的模型覆盖" },
  { command: "scan", token: "--exclude", kind: "string", why: "排除模式；scan 没有 diff，排除就是它唯一的范围控制之一" },
  { command: "scan", token: "--background", kind: "string", why: "业务背景行内文本（scan 没有 --background-file，见「不收」表）" },
  { command: "scan", token: "--concurrency", kind: "int", why: "最多并发子任务数" },
  { command: "scan", token: "--max-tokens", kind: "int", why: "每个文件 prompt 的 token 上限（help 写 per-file，与 review 的 per-group 不是一个东西）" },
  { command: "scan", token: "--max-tokens-budget", kind: "int", why: "成本护栏的主数" },
  { command: "scan", token: "--max-tools", kind: "int", why: "每个子任务最多工具调用轮数（help 写「只在大于模板默认值时生效」，与 review 的 min 50 不同）" },
  { command: "scan", token: "--timeout", kind: "int", why: "任务的时间预算（分钟）" },
  { command: "scan", token: "--rule", kind: "string", why: "自定义 rule.json 的路径" },
  { command: "scan", token: "--audience", kind: "string", why: "输出形态：human / agent" },
  { command: "scan", token: "--path", kind: "string", why: "要扫的目录或文件（仓库相对）；不存在的路径 CLI 直接报错" },
  { command: "scan", token: "--batch", kind: "string", why: "分批策略 none/by-language/by-directory 的覆盖" },
  { command: "scan", token: "--no-plan", kind: "bool", why: "跳过每文件的 PLAN_TASK 预分析" },
  { command: "scan", token: "--no-dedup", kind: "bool", why: "跳过每批的 DEDUP_TASK" },
  { command: "scan", token: "--no-summary", kind: "bool", why: "跳过收尾的 PROJECT_SUMMARY_TASK" },
  { command: "scan", token: "--resume", kind: "string", why: "从官方全量扫描会话续跑" },
  { command: "scan", token: "--preview", kind: "bool", why: "零成本清单：全量扫描在花钱之前必须先看得见规模" },

  // Reads and writes: the small ones, each spelled exactly once in the code.
  { command: "session list", token: "--json", kind: "bool", why: "会话列表由界面消费，不解析表格文本" },
  { command: "session list", token: "--color", kind: "string", why: "never：这条命令在终端会画表格" },
  { command: "session list", token: "--limit", kind: "int", why: "恒为 0（不限量）：CLI 仍会打开每个会话文件排序，砍条数买不到速度只会藏会话" },
  { command: "session list", token: "--repo", kind: "string", why: "只看这个仓库的会话" },
  { command: "session comments", token: "--json", kind: "bool", why: "评论列表同样是机器读的形状" },
  { command: "session comments", token: "--repo", kind: "string", why: "会话 id 可能属于多个仓库" },
  { command: "session export", token: "-o", long: "--output", kind: "string", why: "导出 HTML 报告落盘的确切路径" },
  { command: "session export", token: "--repo", kind: "string", why: "同上，按仓库窄化那个会话 id" },
  { command: "session rm", token: "-y", long: "--yes", kind: "bool", why: "非交互删除：CLI 在交互模式会等确认，而它没有界面" },
  { command: "session rm", token: "--repo", kind: "string", why: "让删除落到用户此刻看着的那个仓库" },
  { command: "rules check", token: "--repo", kind: "string", why: "规则判定按仓库走（allowlist 与 .gitignore 都在那儿）" },
  { command: "rules check", token: "--rule", kind: "string", why: "用户在设置里指定的 rule.json；留空则不拼这一行" },
  { command: "llm providers", token: "--color", kind: "string", why: "never：这段输出要被 parseProviderTable 逐列读" },
  {
    command: "llm test",
    token: "--color",
    kind: "string",
    why: "never：测试连接的文本要原样进设置页的返回框",
    // The only call site is `config-handler.js`, which needs a live Electron main
    // process to reach. Its argv is pinned by its own literal instead of by a
    // recorded spawn, and the exemption is stated here rather than left to the
    // reader noticing that no inventory line mentions it.
    needle: { file: "config-handler.js", text: `["llm", "test", "--color", "never"]` },
  },
]);

/** Flags the CLI is believed *not* to accept on a command. Each of these is the
 *  reason a branch exists in `ocr-service.js`'s per-mode whitelist. */
export const CLI_ABSENCES = Object.freeze([
  { command: "scan", token: "--effort", why: "scan 没有 diff 分组，力度预设无对象；拼了会让整条命令以 unknown flag 终止" },
  { command: "scan", token: "--no-filter", why: "后置过滤是 diff 流程的一步，scan 不收这个参数" },
  { command: "scan", token: "--background-file", why: "scan 只收 --background，文件形态没有对应参数" },
  { command: "review", token: "--path", why: "review 的范围由 diff（from/to/commit）决定，不收路径列表" },
  { command: "review", token: "--batch", why: "分批策略是 scan 的调度概念" },
  { command: "review", token: "--no-plan", why: "PLAN_TASK 只在全量扫描里存在" },
  { command: "review", token: "--no-dedup", why: "DEDUP_TASK 只在全量扫描的批次里存在" },
  { command: "review", token: "--no-summary", why: "PROJECT_SUMMARY_TASK 只在全量扫描收尾时存在" },
  { command: "review", token: "--json", why: "review 的机器读形状是 --format json，不是 --json：两条命令的拼写不同，本仓按各自的拼" },
  { command: "session list", token: "--format", why: "会话子命令用 --json，与 review/scan 的 --format 是两套拼写" },
]);

/** Flags the command's help offers and this wrapper does not send, each with the
 *  reason. An entry here is a decision, not an omission. */
export const CLI_UNCONSUMED = Object.freeze([
  { command: "review", token: "--output", why: "运行的结果流由本仓捕获后自己落盘（会话 + 导出），不叫 CLI 往文件写" },
  { command: "review", token: "--tools", why: "工具集的配置归上游内置；替换它等于改引擎能做什么，本仓不做这个决定" },
  { command: "review", token: "--max-git-procs", why: "git 并发数没有对应的界面输入，用 CLI 的默认值" },
  { command: "scan", token: "--output", why: "同 review：输出归本仓" },
  { command: "scan", token: "--tools", why: "同 review：不改引擎的工具集" },
  { command: "scan", token: "--max-git-procs", why: "同 review：没有界面输入，用默认值" },
  { command: "session comments", token: "--category", why: "分类筛选在界面本地做（ResultsPanel 的 triage），不让 CLI 少给数据" },
  { command: "session comments", token: "--severity", why: "同上：严重度过滤是本地筛选，导出与阅读页要看到完整一份" },
  { command: "session comments", token: "--color", why: "这条命令要 --json，JSON 里没有颜色可放；只有逐行读的文本才写 never" },
  { command: "session export", token: "--color", why: "这条命令写的是文件而不是终端输出，没有要逐行解析的文本" },
  { command: "session rm", token: "--color", why: "返回值只看退出码，文本不进界面" },
  { command: "rules check", token: "--color", why: "这一条的输出是给人抄进抽屉的原文，spawn 的 stdout 不是 TTY，CLI 自己就不上色" },
  { command: "config set", token: "--color", why: "只看退出码与错误文本；写配置的关键在参数而不是输出" },
  { command: "config unset", token: "--color", why: "同 config set" },
  { command: "version", token: "--color", why: "版本行要被正则读，但它不含颜色敏感内容；探测只等一个短预算" },
]);

// ---- parsing the help ----

// A cobra help line for one flag, e.g.
//   `      --max-tokens int           per-group prompt token ceiling (0 = …)`
//   `  -o, --output string            write results to a UTF-8 file`
//   `      --no-filter                keep all review comments without …`
//
// The head is the short alias (optional) plus the long name; everything after it
// is read by `readFlagTail`, because "which word is the type" is exactly where a
// new upstream kind would hide.
const FLAG_LINE = /^\s{2,}(?:-(\w),\s+)?--([A-Za-z][\w-]*)(.*)$/;

/** Split what follows a flag name into `{ kind, help }`, or `null` when the word
 *  sitting in the type slot is not a kind cobra prints.
 *
 *  cobra writes `--name <type>` with a single space and pads the *usage* column
 *  with at least two, so the type slot is told apart from the help text by
 *  spacing rather than by a dictionary of words. A word there that is not a known
 *  kind is refused rather than read as a boolean's help text: guessing `bool`
 *  would make a new upstream type (`--max-tools int32` and the like) look like a
 *  flag that takes no value, and that mistake surfaces later as a run that ate the
 *  next argument instead of as a red line here. */
const readFlagTail = (tail) => {
  const text = String(tail == null ? "" : tail);
  if (text.trim() === "") return { kind: "bool", help: "" };
  // The usage column starts at least two spaces out; one space is the type slot.
  if (/^\s{2,}/.test(text)) return { kind: "bool", help: text.trim() };
  const hit = /^ (\S+)(.*)$/.exec(text);
  if (!hit) return null;
  const [, word, rest] = hit;
  if (!KNOWN_HELP_KINDS.has(word)) return null;
  return { kind: word, help: rest.trim() };
};

/** Parse one command's `--help` output.
 *
 *  Returns `{ flags, unknown }`: `flags` maps the long name to
 *  `{ token, long, kind, short, help }` — `token` is the spelling we would send
 *  (the short form when there is one and the caller uses it, else the long form),
 *  and `long` is always the long form — and `unknown` lists lines under `Flags` /
 *  `Global Flags` that did not parse, which the caller turns into a finding.
 *  `Global Flags` are merged into the command's own set, because cobra accepts
 *  them on the command: `--color never` is a persistent flag and `ocr session
 *  list --color never` is a real invocation of this app. */
export const parseCobraHelp = (text) => {
  const flags = new Map();
  const unknown = [];
  let section = null;
  String(text == null ? "" : text)
    .split(/\r?\n/)
    .forEach((line) => {
      if (/^(Flags|Global Flags):$/.test(line.trim())) {
        section = line.trim();
        return;
      }
      if (section === null) return;
      if (line.trim() === "") return;
      // A new top-level heading (e.g. "Use \"ocr [command] --help\" …") ends the
      // block; anything still indented like a flag line was parsed above.
      if (!/^\s/.test(line)) {
        section = null;
        return;
      }
      if (line.includes("The command you chose")) return;
      const hit = FLAG_LINE.exec(line);
      if (!hit) {
        unknown.push(line.trim());
        return;
      }
      const [, short, long, tail] = hit;
      if (long === "help") return;
      const read = readFlagTail(tail);
      if (!read) {
        unknown.push(line.trim());
        return;
      }
      flags.set(`--${long}`, {
        token: `--${long}`,
        long: `--${long}`,
        short: short ? `-${short}` : null,
        kind: read.kind,
        help: read.help,
      });
    });
  return { flags, unknown };
};

// ---- reading the wrapper's own command lines ----

/** Every flag-like string literal in a source file, comments removed.
 *
 *  This is not how the inventory is built — the inventory comes from the argv the
 *  wrapper hands to `spawn`. This answers the other half: a literal that exists in
 *  the code but never reaches the captured inventory (a call site that needs an
 *  IPC payload we cannot reach from here) still has to be classified, and a table
 *  row that no literal backs is a row nobody consumes. Comments are dropped first
 *  because the code documents CLI wording in prose (`rejects --effort`), and a
 *  comment is not a call site. */
export const flagLiteralsIn = (source) => {
  const withoutComments = String(source == null ? "" : source)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[\t ]*\/\/.*$/gm, "")
    .replace(/\/\/[^"'`\n]*$/gm, "");
  const found = new Set();
  for (const hit of withoutComments.matchAll(/(["'`])(-{1,2}[A-Za-z][\w-]*)\1/g)) found.add(hit[2]);
  return found;
};

/** Split one captured argv into `{ command, flags }`.
 *
 *  `command` is the longest prefix of `argv` that is a known command path, so the
 *  positional arguments a command takes (`config set <key> <value>`,
 *  `session rm <id>`) are not mistaken for part of the command name. A shape that
 *  matches none of `commands` keeps its whole leading run of non-flag words as the
 *  command name — that is the reading the caller wants, because an unlisted command
 *  has to be reported with the name the code actually spelled.
 *
 *  A flag consumes the token after it when the help says the flag takes a value, so
 *  a repository path that begins with `-` cannot masquerade as a flag. When the help
 *  does not know the flag, the value is skipped only if it does not look like a flag
 *  either — and the unknown flag is reported regardless, which is the outcome that
 *  matters. */
export const classifyInvocation = (argv, { commands = CLI_COMMANDS, kindsFor = () => null } = {}) => {
  const words = (argv || []).map(String);
  const isFlag = (word) => /^--?[A-Za-z]/.test(word);
  let command = null;
  for (let size = words.length; size >= 1; size -= 1) {
    if (words[size] !== undefined && isFlag(words[size])) continue;
    const prefix = words.slice(0, size).join(" ");
    if (commands.includes(prefix)) {
      command = prefix;
      break;
    }
  }
  let index = 0;
  if (command === null) {
    while (index < words.length && !isFlag(words[index])) index += 1;
    command = words.slice(0, index).join(" ");
  } else {
    index = command.split(" ").length;
  }
  const flags = [];
  while (index < words.length) {
    const word = words[index];
    if (!isFlag(word)) {
      index += 1;
      continue;
    }
    const kind = kindsFor(command, word);
    if (kind === "bool" || kind === null) {
      // `null` = the CLI's help does not know this flag at all.
      flags.push({ token: word, value: null, known: kind !== null });
      index += 1;
      if (kind === null && index < words.length && !isFlag(words[index])) index += 1;
      continue;
    }
    flags.push({ token: word, value: words[index + 1] == null ? null : String(words[index + 1]), known: true });
    index += 2;
  }
  return { command, argv: words, flags };
};

// ---- the rules ----

/** Every `--preview` call must be free of `--resume`, whatever the spec said.
 *  Exported because the reason is a contract with the CLI, not a style choice. */
export const previewResumeViolations = (invocations) =>
  invocations
    .filter((run) => run.flags.some((flag) => flag.token === "--preview"))
    .filter((run) => run.flags.some((flag) => flag.token === "--resume"))
    .map((run) => `第 ${run.index} 次调用同时拼了 --preview 与 --resume（CLI 会拒绝这对组合）`);

/** The whole rule set as findings. Empty means the surface agrees.
 *
 *  `helps` maps a command path to `parseCobraHelp`'s result; `invocations` to
 *  `classifyInvocation`'s results; `sources` maps each consumer module to its
 *  text. Sources come in as text rather than as a token set so the same call can
 *  check a row's `needle` — and so a control can doctor the code without first
 *  having to predict what the extraction will make of it.
 *
 *  The three tables are inputs too, defaulting to the exported ones. A rule whose
 *  data cannot be doctored cannot be shown to fire, and `tools/cli-surface-smoke.mjs`
 *  is where every one of them is shown firing. */
export const cliSurfaceViolations = ({
  helps = new Map(),
  invocations = [],
  sources = new Map(),
  surface = CLI_SURFACE,
  absences = CLI_ABSENCES,
  unconsumed = CLI_UNCONSUMED,
} = {}) => {
  const violations = [];

  // A vacuous pass is the failure mode this file exists to avoid, so the inputs
  // are asked about before their contents are.
  if (surface.length === 0) violations.push("参数面表是空的——一张没写任何 flag 的表能骗过所有双向断言");
  if (helps.size === 0) violations.push("没有读到任何一份 --help 输出，参数面无法核对");
  if (invocations.length === 0) violations.push("一次调用都没录到，参数面无法核对");

  const helpFor = (command) => helps.get(command) || null;
  const rowKey = (command, token) => `${command}\u0000${token}`;

  // Rows must be well-formed before they can be compared to anything: a duplicate
  // row would let one side of a mismatch hide behind the other.
  const seenRow = new Map();
  surface.forEach((row, ordinal) => {
    const key = rowKey(row.command, row.token);
    if (seenRow.has(key)) {
      violations.push(
        `参数面第 ${ordinal + 1} 行：${row.command} 的 ${row.token} 与第 ${seenRow.get(key)} 行重复——同一件事的两行会各自漂移`
      );
    }
    seenRow.set(key, ordinal + 1);
    if (!CLI_COMMANDS.includes(row.command)) violations.push(`参数面第 ${ordinal + 1} 行属于「${row.command}」，但这条命令不在核对清单里`);
    if (!KINDS.includes(row.kind)) violations.push(`${row.command} 的 ${row.token} 声明的类型「${row.kind}」不是 ${KINDS.join("/")} 之一`);
    if (!String(row.why || "").trim()) violations.push(`${row.command} 的 ${row.token} 没有写「本仓为什么拼它」——一行没有理由的对照等于没人核过`);
    if (row.long && !row.long.startsWith("--")) {
      violations.push(`${row.command} 的 ${row.token} 的 long 字段写的是「${row.long}」——long 必须是长写法，否则第 1 条规则查的是另一个参数`);
    }
    if (row.needle) {
      const file = String(row.needle.file || "");
      const text = String(row.needle.text || "");
      if (!sources.has(file)) {
        violations.push(`${row.command} 的 ${row.token} 说自己的调用点在 ${file || "（空）"}，但那个文件不在本检查读的消费模块里`);
      }
      if (!text.trim()) {
        violations.push(`${row.command} 的 ${row.token} 声明了 needle 却没有字面量——免录制的理由必须是「由某个字面量钉住」，不是「这条先跳过」`);
      } else if (!row.command.split(" ").every((word) => text.includes(`"${word}"`))) {
        violations.push(
          `${row.command} 的 ${row.token} 的 needle 里没有「${row.command}」这条命令路径——那一行钉的是别的命令行`
        );
      }
    }
  });
  for (const entry of absences) {
    if (!CLI_COMMANDS.includes(entry.command)) violations.push(`「不收」清单里有一行属于「${entry.command}」，但这条命令不在核对清单里`);
    if (!String(entry.why || "").trim()) violations.push(`${entry.command} 不收 ${entry.token} 却没有写下理由`);
    if (surface.some((row) => row.command === entry.command && row.token === entry.token)) {
      violations.push(`${entry.command} 的 ${entry.token} 同时出现在「要拼」与「不收」两张表里——它不能既拼又不拼`);
    }
  }
  for (const entry of unconsumed) {
    if (!CLI_COMMANDS.includes(entry.command)) violations.push(`「不用」清单里有一行属于「${entry.command}」，但这条命令不在核对清单里`);
    if (!String(entry.why || "").trim()) violations.push(`${entry.command} 的 ${entry.token} 被列为不用，但没有写下为什么不`);
    if (surface.some((row) => row.command === entry.command && row.token === entry.token)) {
      violations.push(`${entry.command} 的 ${entry.token} 同时出现在「要拼」与「不用」两张表里`);
    }
  }

  // 1. Declared rows exist on the command, with the same kind.
  for (const row of surface) {
    const help = helpFor(row.command);
    if (!help) {
      violations.push(`${row.command} 的 help 没读到，${row.token} 这一行因此没被核对过——不能算绿`);
      continue;
    }
    const long = row.long || row.token;
    const entry = help.flags.get(long) || null;
    if (!entry) {
      violations.push(
        `${row.command} 的 --help 里没有 ${long}——本仓在拼一个这条命令不收的参数（CLI 会以 unknown flag 拒绝整条命令）`
      );
      continue;
    }
    if (entry.kind !== row.kind) {
      violations.push(
        `${row.command} 的 ${long} 类型不一致：本仓按「${row.kind}」拼，CLI 的 help 写「${entry.kind}」——值会被吞或参数被拒，取决于哪边先改`
      );
    }
    if (row.token.startsWith("-") && !row.token.startsWith("--") && entry.short !== row.token) {
      violations.push(`${row.command} 的 ${row.token} 不是 ${long} 的短写法（CLI 写的是 ${entry.short || "无短写法"}）`);
    }
  }

  // 5. Believed absences.
  for (const entry of absences) {
    const help = helpFor(entry.command);
    if (!help) {
      violations.push(`${entry.command} 的 help 没读到，「不收 ${entry.token}」这一行没被核对过`);
      continue;
    }
    if (help.flags.has(entry.token)) {
      violations.push(
        `${entry.command} 现在收 ${entry.token} 了（help：「${help.flags.get(entry.token).help.slice(0, 60)}」）——本仓的每模式白名单可以放开这一格，但必须先确认界面要不要给它一个入口`
      );
    }
  }

  // 2 + 3. The inventory, both directions.
  const consumedByKey = new Map();
  for (const run of invocations) {
    for (const flag of run.flags) {
      const key = rowKey(run.command, flag.token);
      if (!consumedByKey.has(key)) consumedByKey.set(key, run);
    }
  }
  for (const run of invocations) {
    if (!CLI_COMMANDS.includes(run.command)) {
      violations.push(`录到一条本仓在调用的命令「${run.command}」，但它不在核对清单里——新加一条 spawn 就要新加一行对照`);
    }
    for (const flag of run.flags) {
      if (!flag.known) {
        violations.push(`${run.command} 拼了 ${flag.token}，而这条命令的 --help 里没有它`);
      }
      if (!seenRow.has(rowKey(run.command, flag.token))) {
        violations.push(
          `${run.command} 真的拼出了 ${flag.token}，但参数面表里没有这一行——界面或 spawn 新加了一个没人对照的参数`
        );
      }
    }
  }
  for (const row of surface) {
    if (consumedByKey.has(rowKey(row.command, row.token))) continue;
    // The one legitimate way a declared flag never reaches the recorder is a call
    // site that needs a live Electron main process. Such a row is pinned by the
    // literal it is written as, and the literal is read out of the file here — the
    // alternative would be a row that silently stops corresponding to any code.
    if (row.needle) {
      const text = sources.get(String(row.needle.file || ""));
      if (typeof text !== "string" || !text.includes(String(row.needle.text || "\u0000"))) {
        violations.push(
          `${row.command} 的 ${row.token} 说它由 ${row.needle.file} 里的那行字面量钉住，但文件里没有 \`${row.needle.text}\`——调用点改了而这一行没改，它就不再是对照`
        );
      }
      continue;
    }
    violations.push(
      `参数面表说 ${row.command} 会拼 ${row.token}，但没有一次录下来的调用真的拼了它——这一行是拷贝，不是对照`
    );
  }

  // 6. preview never carries resume.
  violations.push(
    ...previewResumeViolations(invocations.map((run, index) => ({ ...run, index: index + 1 })))
  );

  // 4 + coverage. Every flag the command offers is either sent or decided against.
  for (const command of CLI_COMMANDS) {
    const help = helpFor(command);
    if (!help) {
      violations.push(`${command} 没有 help 可读——它的参数面这一轮没被核对，不能算绿`);
      continue;
    }
    if (help.unknown && help.unknown.length) {
      violations.push(`${command} 的 --help 里有 ${help.unknown.length} 行解析不出来：${help.unknown.slice(0, 2).join(" / ")}`);
    }
    const declared = new Set(
      surface.filter((row) => row.command === command).map((row) => row.token)
    );
    const longs = new Set([...surface.filter((row) => row.command === command).map((row) => row.long || row.token)]);
    const skipped = new Map(
      unconsumed.filter((entry) => entry.command === command).map((entry) => [entry.token, entry])
    );
    for (const [token, entry] of skipped) {
      if (!help.flags.has(token)) {
        violations.push(
          `${command} 的「不用」清单里有 ${token}（理由：「${String(entry.why || "").slice(0, 40)}」），但这条命令的 --help 里没有它——这一行拦不住任何变化，只会让清单看起来比实际长`
        );
      }
    }
    for (const [long, entry] of help.flags) {
      if (longs.has(long) || declared.has(entry.token)) continue;
      if (skipped.has(long)) continue;
      violations.push(
        `${command} 的 --help 里有 ${long}（「${entry.help.slice(0, 48)}」），参数面既没写要拼它也没写为什么不用——上游新增或改名的参数，需要一次有人做过的决定`
      );
    }
  }

  // 4 (source literals, both directions) — the half that does not need a process.
  const allTokens = new Set(surface.map((row) => row.token));
  const tokenFiles = new Map();
  for (const [file, text] of sources) {
    for (const token of flagLiteralsIn(text)) {
      if (!tokenFiles.has(token)) tokenFiles.set(token, []);
      tokenFiles.get(token).push(file);
    }
  }
  for (const [token, files] of tokenFiles) {
    if (!allTokens.has(token)) {
      violations.push(`${files.join("、")} 里拼了 ${token}，但参数面没有任何一行提到它——对照表少了一行，或代码多拼了一个参数`);
    }
  }
  for (const token of allTokens) {
    if (!tokenFiles.has(token)) {
      violations.push(`参数面里有 ${token} 这一行，但 ${CONSUMER_SOURCES.join("、")} 里没有任何一处把它拼成字面量——这行对照对的是不存在的代码`);
    }
  }

  return violations;
};

// ---- the version line, and which release answered ----

/** Does the binary's own version output name the pinned release?
 *
 *  `answer` is the CLI's `version` output; `want` is `{ tag, sha }` from the pin.
 *  The tag is compared exactly (it is one string, not a range) and the commit is
 *  compared by prefix, because the CLI prints 8 characters and a build stamp is
 *  not the whole SHA. A short prefix is refused rather than trusted: this is the
 *  check that says "the help text above came from the pinned commit", and a
 *  one-character match is not an answer to that question. */
export const versionAttribution = (answer, want) => {
  const text = String(answer == null ? "" : answer);
  const tag = String((want && want.tag) || "");
  const sha = String((want && want.sha) || "");
  if (!tag || sha.length < 40) return { ok: false, reason: "pin 本身不完整，无法核对二进制的出处" };
  if (!text.includes(tag)) return { ok: false, reason: `版本输出里没有 ${tag}` };
  const printed = /\((\w{7,40})\)/.exec(text);
  if (!printed) return { ok: false, reason: "版本输出里没有括号里的 commit 前缀" };
  if (!sha.startsWith(printed[1])) return { ok: false, reason: `版本输出的 commit ${printed[1]} 与 pin 的 ${sha.slice(0, 7)} 不是同一个` };
  if (printed[1].length < 7) return { ok: false, reason: `版本输出的 commit 前缀只有 ${printed[1].length} 位，太短不能算同一 commit` };
  return { ok: true, tag, commit: printed[1] };
};

// ---- the runner: read the help, drive the wrapper, report ----

const HELP_SPECS = CLI_COMMANDS.map((command) => command.split(" "));

/** The maximally-populated spec, one per mode. Every key the UI can fill is set,
 *  so `argList` emits every flag it is allowed to emit for that mode; keys a mode
 *  does not own are also set, because the whitelist is what is being checked. */
const fullSpec = (mode, repo) => ({
  mode,
  repo,
  from: "refs/heads/main",
  to: "refs/heads/dev",
  commit: "deadbeef",
  provider: "openai",
  model: "claude-opus-4-6",
  exclude: "**/generated/*",
  background: "ctx",
  backgroundFile: "/tmp/background.md",
  concurrency: 4,
  maxTokens: 12000,
  maxTokensBudget: 200000,
  maxTools: 60,
  timeout: 20,
  rule: "/tmp/rule.json",
  audience: "agent",
  effort: "low",
  path: "internal/agent",
  batch: "by-language",
  noFilter: true,
  noPlan: true,
  noDedup: true,
  noSummary: true,
  resume: "session-abc",
});

/** Replace `child_process.spawn` with a recorder, then load the service.
 *
 *  `ocr-service.js` binds `spawn` at require time, so the patch has to land
 *  before the first `require` of it — and the help reading above uses
 *  `execFileSync`, which is a different binding and stays real. The recorder never
 *  starts a process: an argv is the whole product of this phase. */
const recordInvocations = (svcPath, repo) => {
  const cp = require("child_process");
  const { EventEmitter } = require("events");
  const realSpawn = cp.spawn;
  const calls = [];
  cp.spawn = (bin, args, options) => {
    calls.push({ bin, args: (args || []).map(String), options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.pid = 4242;
    setImmediate(() => child.emit("close", 0));
    return child;
  };
  const restore = () => {
    cp.spawn = realSpawn;
  };
  try {
    delete require.cache[require.resolve(svcPath)];
    const svc = require(svcPath);
    return { svc, calls, restore };
  } catch (err) {
    restore();
    throw err;
  }
};

const main = async () => {
  const failures = [];
  const svcPath = path.join(ROOT, "ocr-service.js");
  const svcProbe = require(svcPath);
  const bin = svcProbe.binaryPath();
  if (!bin) {
    console.error("FAIL  找不到 ocr 可执行文件——参数面核对的是应用真的会 spawn 的那一份，找不到就没有对象");
    process.exit(1);
  }

  const helpOutput = new Map();
  for (const argv of HELP_SPECS) {
    try {
      helpOutput.set(
        argv.join(" "),
        execFileSync(bin, [...argv, "--help"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      );
    } catch (err) {
      failures.push(`${argv.join(" ")} --help 没跑出来：${String(err && err.message).split("\n")[0]}`);
    }
  }

  let versionText = "";
  try {
    versionText = execFileSync(bin, ["version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    failures.push(`ocr version 没跑出来：${String(err && err.message).split("\n")[0]}`);
  }
  const { PINNED_UPSTREAM } = await import(PIN_MODULE);
  const attribution = versionAttribution(versionText, PINNED_UPSTREAM);
  if (!attribution.ok) failures.push(`参数面读的不是被 pin 的那一版：${attribution.reason}`);

  const helps = new Map();
  for (const [command, text] of helpOutput) helps.set(command, parseCobraHelp(text));

  const { svc, calls, restore } = recordInvocations(svcPath, "/repo");
  try {
    for (const mode of ["workspace", "range", "commit", "scan"]) {
      await svc.preview(fullSpec(mode, "/repo"));
      svc.startRun(fullSpec(mode, "/repo"), () => {}, () => {}, () => {});
    }
    await svc.listSessions("/repo", 0);
    await svc.sessionComments("/repo", "session-abc");
    await svc.exportSession("/repo", "session-abc", "/tmp/report.html");
    await svc.deleteSession("session-abc", "/repo");
    await svc.rulesCheck("/repo", "internal/a.go", "/tmp/rule.json");
    await svc.setConfig([["provider", "openai"], ["custom_providers.x.api_key", "sk-test"]]);
    await svc.unsetConfig("provider");
    await svc.providerTable({ runner: async (args) => { calls.push({ bin, args: args.map(String), options: null }); return { code: 0, stdout: "", stderr: "" }; } });
    // `llm test` is spelled by `config-handler.js`, which needs a live `electron`;
    // the array it passes is reached through the same `exec` this service exports.
    await svc.exec(["llm", "test", "--color", "never"]);
  } finally {
    restore();
  }

  const kindsFor = (command, token) => {
    const help = helps.get(command);
    if (!help) return null;
    const entry = help.flags.get(token);
    if (entry) return entry.kind;
    for (const value of help.flags.values()) if (value.short === token) return value.kind;
    return null;
  };
  const invocations = calls
    .map((call) => classifyInvocation(call.args, { kindsFor }))
    .filter((run) => run.command !== "");

  const sources = new Map();
  for (const file of CONSUMER_SOURCES) {
    sources.set(file, fs.readFileSync(path.join(ROOT, file), "utf8"));
  }

  const violations = [...failures, ...cliSurfaceViolations({ helps, invocations, sources })];

  console.log(
    `ocr 参数面：${bin ? path.basename(bin) : "-"}（${attribution.ok ? `${attribution.tag} / ${attribution.commit}` : "出处未核"}）` +
      ` · 核对 ${CLI_COMMANDS.length} 条命令的 --help、${invocations.length} 条本仓真的拼出的命令行` +
      ` · 声明 ${CLI_SURFACE.length} 行要拼、${CLI_ABSENCES.length} 行不收、${CLI_UNCONSUMED.length} 行有理由地不用` +
      ` · 扫了 ${CONSUMER_SOURCES.length} 个消费模块的 flag 字面量`
  );
  if (violations.length) {
    for (const line of violations) console.error(`FAIL  ${line}`);
    console.error(`\n参数面有 ${violations.length} 处不一致`);
    process.exit(1);
  }
  console.log(`OK    参数面逐条一致（${CLI_SURFACE.length} 行 × help）`);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`FAIL  cli-surface 自己出错了：${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}
