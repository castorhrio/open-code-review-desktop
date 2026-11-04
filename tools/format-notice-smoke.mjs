// 一次运行结束时说的那句话，语气必须由徽章派生——不是由退出码，也不是由第二处判断。
//
// 为什么需要这一条：`src/lib/format.ts` 的 `completionNotice()` 有三个调用面（结束时的
// toast、运行视图里的标签、读屏的 `role="status"` 行），而它此前只对 `limited` 一种结局
// 另作处理，其余一律给 `tone: "success"`。于是 `partial` / `completed_with_errors` 被用
// 成功语气播报，`failed` 更糟——`ocr` 对一次失败的运行也可能 exit 0，那句「审查完成」就
// 出现在一次什么都没审完的运行上，而旁边的徽章写着「失败」。第 131 轮把语气改成从
// `statusBadge()` 的 `id` 派生，本文件钉住的就是这条派生关系。
//
// 每条断言都带反向控制：把同一张表指向「语气写死 success」的实现，它必须变红并点名是哪
// 一种结局被说成了完成。一个只在正确实现下变绿的断言，等于一句带 console.log 的注释。
//
// 不起 Electron、不起浏览器、不构建：`src/lib/format.ts` 直接 import（Node >= 22.18 会
// 剥掉类型）。跑法：`npm run audit:format`。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

// Node 对每个进程只播报一次类型剥离的警告（本仓 package.json 没有 "type" 字段），而这条
// 警告会出现在一个「输出本身就是结论」的套件最前面。其它警告照常放行。
const defaultWarningPrinters = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (w) => {
  if (w.code !== "MODULE_TYPELESS_PACKAGE_JSON") defaultWarningPrinters.forEach((print) => print(w));
});

const format = await import("../src/lib/format.ts").catch((err) => {
  console.error(
    `src/lib/format.ts could not be imported — it needs Node >= 22.18 to strip the types (this is ${process.version}): ${err.message}`
  );
  process.exit(2);
});
const { completionNotice, statusBadge, WARNING_REVIEW_LIMIT } = format;

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

/* ---- 1. 每种结局该有的语气 ---- */

/** 一次运行的载荷，只写这条断言关心的字段。`status` 是 CLI 自己的词，
 * `terminal_state` 是 manifest 里的同一个词（`terminalState()` 优先读后者）。 */
const run = (status, extra = {}) => ({
  status,
  comments: [{ path: "a.go", content: "x", start_line: 1 }],
  summary: {},
  warnings: [],
  ...extra,
});

/**
 * 这张表就是「哪种结局该用什么语气」的全部答案。`why` 是给读报告的人的一句话：
 * 一条红了的断言要能自己说清它守的是哪句承诺。
 */
const CASES = [
  { name: "complete", value: run("complete"), tone: "success", title: "审查完成", why: "跑完了就是跑完了" },
  { name: "success", value: run("success"), tone: "success", title: "审查完成", why: "全量扫描用 success 这个词，同样是跑完" },
  {
    name: "limited（预算）",
    value: run("complete", { summary: { budget_exceeded: true } }),
    tone: "warning",
    title: "审查停在了 token 预算上限",
    why: "CLI 对被预算截短的运行照样报 complete，徽章改说「未审完」，提示语必须跟着改口",
  },
  {
    name: "limited（轮次）",
    value: run("complete", { warnings: [{ type: WARNING_REVIEW_LIMIT }] }),
    tone: "warning",
    title: "审查停在了审查上限",
    why: "轮次上限不设 budget_exceeded，只有 review_limit_reached 警告——两种上限的补救办法不同",
  },
  { name: "partial", value: run("partial"), tone: "warning", title: "审查部分完成", why: "部分完成不是完成" },
  {
    name: "completed_with_errors",
    value: run("completed_with_errors"),
    tone: "warning",
    title: "审查部分失败",
    why: "有文件失败过，成功语气会盖掉这件事",
  },
  {
    name: "completed_with_warnings",
    value: run("completed_with_warnings"),
    tone: "warning",
    title: "审查有警告",
    why: "有警告的运行不该用成功语气播报",
  },
  { name: "aborted", value: run("aborted"), tone: "warning", title: "审查已中断", why: "中断不是完成" },
  { name: "failed", value: run("failed"), tone: "error", title: "审查失败", why: "失败要用错误语气，而不是成功语气" },
  {
    name: "unknown（没有状态）",
    value: { comments: [], summary: {} },
    tone: "warning",
    title: "审查结束，但这次运行的状态没有记录",
    why: "叫不出名字的状态不是「跑完了」的证据",
  },
];

for (const c of CASES) {
  const badge = statusBadge(c.value);
  const notice = completionNotice(c.value);
  check(
    `${c.name}：徽章 id=${badge.id}，提示语语气=${notice.tone}`,
    notice.tone === c.tone,
    `${c.why} — 期望 ${c.tone}，得到 ${notice.tone}（标题「${notice.title}」）`
  );
  check(`${c.name}：标题是「${c.title}」`, notice.title === c.title, `得到「${notice.title}」`);
  check(
    `${c.name}：提示语的 label 就是徽章的 label（同源，不是第二处判断）`,
    notice.label === badge.label,
    `徽章「${badge.label}」/ 提示语「${notice.label}」`
  );
}

/* ---- 2. 反向控制：语气写死 success 的实现必须被这张表抓住 ---- */

/**
 * 第 131 轮之前的实现：只对 `limited` 另作处理，其余一律 success。它必须在这张表上变红，
 * 且必须红在「哪种结局被说成了完成」上——否则上面那些绿可能只是因为它对任何结局都绿。
 */
const hardcodedSuccess = (value) => {
  const badge = statusBadge(value);
  if (badge.id !== "limited") return { label: badge.label, title: `审查${badge.label}`, tone: "success" };
  return { label: badge.label, title: "审查停在了审查上限", tone: "warning" };
};

// 它当然还认得 `limited`（那一支第 130 轮就修了），所以这里要的是：**除 limited 之外的
// 每一种未完成结局**都必须被它说成完成，也就是必须被这张表抓住。少抓住一种，就说明那张
// 表对那一种没有区分力。
const mustCatch = CASES.filter((c) => c.tone !== "success" && statusBadge(c.value).id !== "limited");
const missed = mustCatch.filter((c) => hardcodedSuccess(c.value).tone === c.tone);
check(
  "反向控制：把语气写死 success 的实现，在每一种非 limited 的未完成结局上都变红",
  mustCatch.length >= 5 && missed.length === 0,
  missed.length
    ? `这些结局被它说成了完成却没被抓住：${missed.map((c) => c.name).join("、")}`
    : `${mustCatch.length} 种结局全部被抓住（${mustCatch.map((c) => c.name).join("、")}）`
);

/** 第二个反向控制：只认 `limited`、把 `failed` 也当 success 的「半修」版本。 */
const limitedOnly = (value) => {
  const badge = statusBadge(value);
  return { label: badge.label, tone: badge.id === "limited" ? "warning" : "success" };
};
const halfFixed = CASES.filter((c) => c.tone !== "success" && limitedOnly(c.value).tone === "success");
check(
  "反向控制：只修了 limited 的半成品，仍会在 partial / failed 上变红",
  halfFixed.length >= 3,
  halfFixed.length ? `它漏掉的结局：${halfFixed.map((c) => c.name).join("、")}` : "半成品竟然全绿，说明这张表没有区分力"
);

/* ---- 3. 三个调用面真的都走这一处 ---- */

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

{
  // 读屏那一行：`role="status"` 的文本必须是 `completionNotice(result).title`，
  // 而不是自己拼一句「审查完成」。这是「看不见的那句话」与徽章同源的唯一证据。
  const results = stripComments(read("src/components/ResultsPanel.tsx"));
  // 这一屏有两个 live region：运行中的进度行，和跑完之后那一行。要钉的是后者——它必须
  // 读 `completionNotice(result).title`，而不是自己拼一句「审查完成」。
  const statusLines = [...results.matchAll(/role="status"[\s\S]{0,400}?<\/p>/g)].map((m) => m[0]);
  const finishedLine = statusLines.find((line) => /completionNotice\(result\)/.test(line));
  check(
    "ResultsPanel 跑完那一行 role=\"status\" 读的是 completionNotice(result).title",
    Boolean(finishedLine) && /completionNotice\(result\)\.title/.test(finishedLine),
    finishedLine
      ? finishedLine.replace(/\s+/g, " ").slice(0, 200)
      : `找不到读 completionNotice 的 live region（这一屏有 ${statusLines.length} 个 role="status"）`
  );
  check(
    "ResultsPanel 里没有第二处自己拼「审查完成」",
    !/["'`]审查完成/.test(results),
    "读屏行与徽章必须同源，自己拼一句就是第二处判断"
  );

  // 结束时的 toast：三种语气都要有落点。少一个分支，`error` 就会静默掉进 success。
  const store = stripComments(read("src/store.tsx"));
  const notice = store.match(/const done = completionNotice\(r\.value\);[\s\S]{0,600}?\n\s*\}/);
  const body = notice ? notice[0] : "";
  check("store.tsx 用 completionNotice 决定结束时的提示语", /completionNotice\(r\.value\)/.test(store), "");
  for (const tone of ["error", "warning", "success"]) {
    check(
      `store.tsx 的结束提示语有 ${tone} 这一支`,
      new RegExp(`done\\.tone === "${tone}"|else toast\\.${tone}\\(`).test(body),
      body ? body.replace(/\s+/g, " ").slice(0, 240) : "找不到 completionNotice 的调用点"
    );
  }
  check(
    "store.tsx 不再按退出码自己写「审查完成」",
    !/toast\.success\(["'`]审查完成/.test(store),
    "退出码为 0 不等于跑完了"
  );
}

/* ---- 4. 报告页与结果页共用同一个徽章 ---- */
{
  const report = stripComments(read("src/components/ReportView.tsx"));
  check(
    "ReportView 的徽章也读 statusBadge（两屏不会各说各的）",
    /statusBadge\(result\)/.test(report) && /data-run-status=\{status\.id\}/.test(report),
    ""
  );
}

console.log(`\n${failures.length ? `FAIL  ${failures.length} 条未通过` : "ok      全部通过"}`);
if (failures.length) {
  console.error(`\nformat notice checks failed: ${failures.join(", ")}`);
  process.exit(1);
}
