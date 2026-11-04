// 钉住 `tools/e2e-fake-provider-rules.cjs` 的每一条判据，不起 Electron。
//
// 为什么需要这一条：DOD-4 的最后一半是「一屏真渲染」——`tools/e2e-fake-provider.cjs` 把假
// provider 交给真 Electron、在表单里填上 25000 的预算、按下「开始审查」，然后读屏幕上写了
// 什么。那一趟跑起来要几分钟，而它判得对不对，全部落在 `e2e-fake-provider-rules.cjs` 那几个
// 纯函数上：一个需要显示器、真 CLI 和活渲染器才能推一下的判据，是谁也推不了的判据。
//
// 所以这里做三件事：
//
//   1. **常量与源头对上。** 规则里写的徽章 id / 文字、截断条那句话、头部那格预算，都是从
//      `src/lib/format.ts` 与两个组件里读出来的字面量；它们一变，e2e 会在屏幕上找不到那段
//      文字，而这条 smoke 在不需要 Electron 的情况下先说清「是这几个字对不上了」。
//   2. **同一套规则必须能对着完成态变红。** 否则「截断时它变绿」可能只是因为它对任何一屏都绿。
//   3. **反向控制：把 `statusBadge()` 里 `limited` 那一支删掉，这条判据必须红。** 删法用的是
//      同一张 `STATUS` 表重建「删掉之前」的行为——那正是第 131 轮之前屏幕上的样子：徽章写
//      「完成」，而这次运行后面的文件根本没派发。这条控件的读数同时说明为什么判据读的是
//      `data-run-status` 这个值，而不是去猜类名。
//
// 跑法：`npm run audit:truncation-rules`（`audit:static` 的一项）。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(ROOT, "package.json"));
const RULES = require(path.join(ROOT, "tools", "e2e-fake-provider-rules.cjs"));

// Node 对每个进程只播报一次类型剥离的警告，而这条警告会出现在一个「输出本身就是结论」的
// 套件最前面。其它警告照常放行（与 `tools/format-notice-smoke.mjs` 同一条处理）。
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
const { STATUS, terminalState, statusBadge, completionNotice, WARNING_REVIEW_LIMIT } = format;

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/* ---- 1. 常量与它们描述的那一屏是同几个字 ---- */

check(
  "截断条的常量就是 `RunLimitNotice` 在预算分支上渲染的那句话",
  (() => {
    const src = read("src/components/finding.tsx");
    // 模板字面量在 JSX 里被拆成三截：`这次审查在达到{budget ? " token 预算" : ""}上限时停下`。
    // 把它按「预算分支为真」拼回来，必须与规则里那句逐字相等——否则 e2e 在真屏幕上找不到它，
    // 而失败信息会指向「截断条没出现」，读的人会去查预算，而不是查这句话被改过。
    const m = src.match(/这次审查在达到\{budget \? " token 预算" : ""\}上限时停下/);
    if (!m) return false;
    return RULES.TRUNCATION_BAND === '这次审查在达到 token 预算上限时停下' && m[0].includes("token 预算");
  })(),
  `规则里是「${RULES.TRUNCATION_BAND}」`
);

check(
  "头部预算格的常量就是 `ResultsPanel` 在 `summary.budget_exceeded` 时渲染的那一格",
  read("src/components/ResultsPanel.tsx").includes(`{s.budget_exceeded && <span className="text-warn">${RULES.BUDGET_CHIP}</span>}`),
  `规则里是「${RULES.BUDGET_CHIP}」`
);

check(
  "两个结果面都把徽章的 id 挂在 `data-run-status` 上（e2e 读的就是这个值）",
  ["src/components/ResultsPanel.tsx", "src/components/ReportView.tsx"].every((rel) =>
    read(rel).includes("data-run-status={status.id}")
  ),
  "ResultsPanel / ReportView 各一处"
);

check(
  "标记发现只有假 provider 会发（屏幕上出现它就是一次真跑过的运行）",
  read("tools/fake-provider.mjs").includes(RULES.FINDING_MARKER),
  RULES.FINDING_MARKER
);

/* ---- 2. 从真实现里取出这一屏该有的读数 ---- */

/** 一次被预算截短的运行：CLI 说 complete，`summary.budget_exceeded` 为真。这是 `ocr` 真实
 * 的答案（`tools/fake-provider-smoke.mjs` 那趟真跑读到的就是它），不是为了让断言好过而造的。 */
const truncatedRun = {
  status: "complete",
  comments: [{ path: "a.go", content: RULES.FINDING_MARKER, start_line: 2 }],
  summary: { budget_exceeded: true },
  warnings: [],
};

/** 完成态的对照运行：同样的形状，没有触到任何上限。 */
const completeRun = {
  status: "complete",
  comments: [{ path: "a.go", content: RULES.FINDING_MARKER, start_line: 2 }],
  summary: {},
  warnings: [],
};

const screenOf = (...parts) => parts.filter(Boolean).join("\n");

/** 截断那一屏的可见文字（截断条 + 头部预算格 + 那条发现）。写完的界面就是这些字；这里只
 * 负责把它们排成一行文本，判据负责说它们该说什么。 */
const TRUNCATED_SCREEN = screenOf(RULES.TRUNCATION_BAND, RULES.BUDGET_CHIP, RULES.FINDING_MARKER);
const COMPLETE_SCREEN = screenOf(RULES.FINDING_MARKER);

/**
 * 用一组 `statusBadge` / `completionNotice` 把「屏幕上的事实」拼出来。
 *
 * 这就是 harness 读到的那个形状：`status` 是徽章的 `data-run-status`，`label` 是徽章自己的
 * 文字，`claims` 是这一趟出现过的提示语（含语气）。传进不同的实现，同一个形状就会变成
 * 「那一版程序会渲染出来的一屏」——所以下面那条反向控制不是手写的假数据，而是同一套拼法换
 * 了个实现。
 */
const viewOf = (mod, run, screen) => {
  const badge = mod.statusBadge(run);
  const notice = mod.completionNotice(run);
  return {
    status: badge.id,
    label: badge.label,
    badgeCount: 1,
    screen,
    claims: [{ type: notice.tone, text: notice.title }],
  };
};

const view = (run, screen) => viewOf(format, run, screen);
const mutated = (run, screen) =>
  viewOf(
    {
      // 第 131 轮之前的样子：`statusBadge` 只是把 CLI 的词翻成中文，没有「被截短」这一支。
      // 用同一张 `STATUS` 表重写一遍，删掉的正是那一支。
      statusBadge: (value) => {
        const st = terminalState(value);
        const named = STATUS[st];
        return { id: st || "unknown", label: named ? named.label : st || "未知", cls: named ? named.cls : "" };
      },
      // 语气从徽章 id 派生（`completionNotice` 的规则），所以分支一删，id 就是 complete，
      // 提示语也就跟着说「审查完成」——这正是 DOD-4 要堵的那句话。
      completionNotice: (value) => {
        const st = terminalState(value);
        const base = format.completionNotice(value);
        return st === "complete" || st === "success" ? { ...base, label: STATUS[st].label, title: `审查${STATUS[st].label}`, tone: "success" } : base;
      },
    },
    run,
    screen
  );

const filled = view(truncatedRun, TRUNCATED_SCREEN);
const fin = view(completeRun, COMPLETE_SCREEN);

check(
  "截断那一屏的徽章读数是 limited / 未审完（CLI 说 complete，徽章不跟着说）",
  filled.status === RULES.LIMITED.id && filled.label === RULES.LIMITED.label,
  `data-run-status=${JSON.stringify(filled.status)} 文字=「${filled.label}」`
);
check(
  "完成态那一屏的徽章读数是 complete / 完成",
  fin.status === RULES.COMPLETE.id && fin.label === RULES.COMPLETE.label,
  `data-run-status=${JSON.stringify(fin.status)} 文字=「${fin.label}」`
);
check(
  "截断那一趟的提示语是 warning 语气，且不写「完成」",
  filled.claims[0].type === "warning" && !filled.claims[0].text.includes(RULES.COMPLETION_WORD),
  `${filled.claims[0].type}: ${filled.claims[0].text}`
);
check(
  "完成态那一趟的提示语是 success 语气，且写了「完成」",
  fin.claims[0].type === "success" && fin.claims[0].text.includes(RULES.COMPLETION_WORD),
  `${fin.claims[0].type}: ${fin.claims[0].text}`
);

/* ---- 3. 判据：该绿的绿 ---- */

check(
  "截断那一屏在判据下全绿（徽章、截断条、预算格、发现、提示语）",
  RULES.truncationViolations(filled, { expectTruncated: true }).length === 0,
  JSON.stringify(RULES.truncationViolations(filled, { expectTruncated: true }))
);
check(
  "完成态在**同一套判据**反向跑也全绿——判据不是对任何一屏都绿",
  RULES.truncationViolations(fin, { expectTruncated: false }).length === 0,
  JSON.stringify(RULES.truncationViolations(fin, { expectTruncated: false }))
);
check(
  "截断的报告页全绿（与结果页共用同一个徽章与同一条截断条，但没有头部预算格）",
  RULES.reportViolations(view(truncatedRun, screenOf(RULES.TRUNCATION_BAND, RULES.FINDING_MARKER)), { expectTruncated: true }).length === 0,
  JSON.stringify(RULES.reportViolations(view(truncatedRun, screenOf(RULES.TRUNCATION_BAND, RULES.FINDING_MARKER)), { expectTruncated: true }))
);
check(
  "完成态的报告页同样全绿",
  RULES.reportViolations(view(completeRun, COMPLETE_SCREEN), { expectTruncated: false }).length === 0,
  JSON.stringify(RULES.reportViolations(view(completeRun, COMPLETE_SCREEN), { expectTruncated: false }))
);

/* ---- 4. 反向控制：`limited` 那一支删掉，判据必须红 ---- */

const before131 = mutated(truncatedRun, TRUNCATED_SCREEN);
const before131Violations = RULES.truncationViolations(before131, { expectTruncated: true });
check(
  "反向控制：删掉 `statusBadge()` 的 `limited` 分支后，同一屏被读成 complete / 完成",
  before131.status === "complete" && before131.label === RULES.COMPLETE.label && before131.claims[0].type === "success",
  `data-run-status=${JSON.stringify(before131.status)} 文字=「${before131.label}」提示语=${before131.claims[0].type}:${before131.claims[0].text}`
);
check(
  "反向控制：那一屏必须被判据抓住，且第一条就是「徽章写了完成」",
  before131Violations.length > 0 && before131Violations[0].includes(`徽章写了「${RULES.COMPLETE.label}」`),
  before131Violations.join(" / ") || "（一条都没有——删掉那一支之后判据仍是绿的）"
);
check(
  "反向控制：提示语那条也在红灯里（一次截短的运行在成功语气里说完成）",
  before131Violations.some((v) => v.includes("提示语")),
  before131Violations.join(" / ")
);

/* ---- 5. 单点变异：每一条承诺各有一个只会让它红的改动 ---- */

const TRUNCATION_MUTATIONS = [
  {
    name: "徽章说完成",
    view: { ...filled, status: RULES.COMPLETE.id },
    expect: `徽章写了「${RULES.COMPLETE.label}」`,
  },
  {
    name: "徽章叫不出名字（既不是 limited 也不是 complete）",
    view: { ...filled, status: "partial" },
    expect: "徽章不是截断态",
  },
  {
    name: "徽章 id 对、文字写了完成",
    view: { ...filled, label: `审查${RULES.COMPLETION_WORD}` },
    expect: "读数读的是文字",
  },
  {
    name: "截断条不在屏幕上（比如被折进 tooltip）",
    view: view(truncatedRun, screenOf(RULES.BUDGET_CHIP, RULES.FINDING_MARKER)),
    expect: "截断条没出现",
  },
  {
    name: "头部没有预算格（summary.budget_exceeded 没被界面读到）",
    view: view(truncatedRun, screenOf(RULES.TRUNCATION_BAND, RULES.FINDING_MARKER)),
    expect: "没被界面读到",
  },
  {
    name: "截断把已发布的结果弄丢了",
    view: view(truncatedRun, screenOf(RULES.TRUNCATION_BAND, RULES.BUDGET_CHIP)),
    expect: "截断把已发布的结果弄丢了",
  },
  {
    name: "提示语写了完成（语气仍是 warning）",
    view: { ...filled, claims: [{ type: "warning", text: "审查完成，共 1 条评论" }] },
    expect: "提示语写了「完成」",
  },
  {
    name: "提示语用了 success 语气",
    view: { ...filled, claims: [{ type: "success", text: "审查停在了 token 预算上限" }] },
    expect: "success 语气",
  },
];

for (const m of TRUNCATION_MUTATIONS) {
  const v = RULES.truncationViolations(m.view, { expectTruncated: true });
  check(
    `单点变异「${m.name}」必须红，且点名它守的那句话`,
    v.length > 0 && v.some((x) => x.includes(m.expect)),
    v.join(" / ") || "（绿了——这一格没有断言）"
  );
}

const COMPLETE_MUTATIONS = [
  { name: "完成态被读成 limited", view: { ...fin, status: RULES.LIMITED.id }, expect: "完成态被读成" },
  { name: "完成态的徽章文字不是完成", view: { ...fin, label: "部分完成" }, expect: "徽章文字是" },
  {
    name: "完成态冒出一条截断条",
    view: view(completeRun, screenOf(RULES.TRUNCATION_BAND, RULES.FINDING_MARKER)),
    expect: "完成态出现了截断条",
  },
  {
    name: "完成态冒出头部预算格",
    view: view(completeRun, screenOf(RULES.BUDGET_CHIP, RULES.FINDING_MARKER)),
    expect: RULES.BUDGET_CHIP,
  },
  { name: "完成态没有那条发现", view: view(completeRun, ""), expect: "没有那条标记发现" },
  { name: "完成态没说什么（一条提示语都没有）", view: { ...fin, claims: [] }, expect: "没说「完成」" },
  {
    name: "完成态说了完成，但语气不是 success",
    view: { ...fin, claims: [{ type: "warning", text: `审查${RULES.COMPLETION_WORD}` }] },
    expect: "而不是 success",
  },
];

for (const m of COMPLETE_MUTATIONS) {
  const v = RULES.truncationViolations(m.view, { expectTruncated: false });
  check(
    `反向控制「${m.name}」必须红`,
    v.length > 0 && v.some((x) => x.includes(m.expect)),
    v.join(" / ") || "（绿了——控制失效）"
  );
}

const REPORT_MUTATIONS = [
  {
    name: "报告页徽章说完成",
    view: { ...view(truncatedRun, screenOf(RULES.TRUNCATION_BAND, RULES.FINDING_MARKER)), status: RULES.COMPLETE.id },
    expect: "报告页的徽章不是截断态",
  },
  {
    name: "报告页没有截断条（一份被截短的报告最容易在这里读成完整的一份）",
    view: view(truncatedRun, COMPLETE_SCREEN),
    expect: "报告页没有截断条",
  },
  {
    name: "报告页正文写了完成",
    view: view(truncatedRun, screenOf(RULES.TRUNCATION_BAND, RULES.FINDING_MARKER, `审查${RULES.COMPLETION_WORD}`)),
    expect: "报告页写了「完成」",
  },
  {
    name: "完成态的报告页冒出截断条",
    view: view(completeRun, screenOf(RULES.TRUNCATION_BAND, RULES.FINDING_MARKER)),
    expect: "完成态的报告页出现了截断条",
    expectTruncated: false,
  },
];

for (const m of REPORT_MUTATIONS) {
  const v = RULES.reportViolations(m.view, { expectTruncated: m.expectTruncated !== false });
  check(
    `报告页单点变异「${m.name}」必须红`,
    v.length > 0 && v.some((x) => x.includes(m.expect)),
    v.join(" / ") || "（绿了——这一格没有断言）"
  );
}

/* ---- 6. 步骤面：消失的检查与失败一样红 ---- */

const STEPS = RULES.HARNESS_STEPS;
check(
  "步骤表是冻结的、名字唯一、每步都声明了它属于哪一趟",
  Object.isFrozen(STEPS) && new Set(STEPS.map((s) => s.name)).size === STEPS.length && STEPS.every((s) => Array.isArray(s.modes) && s.modes.length > 0),
  JSON.stringify(STEPS.map((s) => s.name))
);
check(
  "每条步骤声明的趟次只有 truncated / complete 两种",
  STEPS.every((s) => s.modes.every((m) => m === "truncated" || m === "complete")),
  JSON.stringify([...new Set(STEPS.flatMap((s) => s.modes))])
);
check(
  "报全了就是没有缺项",
  RULES.missingSteps(STEPS.map((s) => s.name), "truncated").length === 0 && RULES.missingSteps(STEPS.map((s) => s.name), "complete").length === 0,
  JSON.stringify(RULES.missingSteps(STEPS.map((s) => s.name), "truncated"))
);
check(
  "少报一步就点名那一步（「没跑」不许读成「通过」）",
  (() => {
    const all = STEPS.map((s) => s.name);
    const dropped = all[all.length - 1];
    const missing = RULES.missingSteps(all.filter((n) => n !== dropped), "truncated");
    return missing.length === 1 && missing[0] === dropped;
  })(),
  JSON.stringify(RULES.missingSteps([], "truncated"))
);
check(
  "只属于截断那一趟的步骤，在完成态那一趟里不算缺项",
  (() => {
    const budget = STEPS.find((s) => s.modes.length === 1 && s.modes[0] === "truncated");
    if (!budget) return false;
    const truncatedSteps = STEPS.filter((s) => s.modes.includes("truncated")).map((s) => s.name).filter((n) => n !== budget.name);
    return RULES.missingSteps(truncatedSteps, "complete").length === 0 && RULES.missingSteps(truncatedSteps, "truncated").includes(budget.name);
  })(),
  "填预算那一步只在截断那一趟"
);

/* ---- 7. 提示语与文本的读法 ---- */

check(
  "提示语接受字符串与对象两种形状，空白的丢掉",
  (() => {
    const claims = RULES.claimsOf({ claims: ["审查完成", { type: "warning", text: "审查停在上限" }, "   ", { text: "" }, null] });
    return claims.length === 2 && claims[0].text === "审查完成" && claims[1].type === "warning";
  })(),
  JSON.stringify(RULES.claimsOf({ claims: ["审查完成", { type: "warning", text: "  " }] }))
);
check("读不到提示语时是空表，不是抛错", RULES.claimsOf({}).length === 0 && RULES.claimsOf(null).length === 0, JSON.stringify(RULES.claimsOf(null)));
check(
  "只把提到「审查」的提示语算进这次运行（「读取历史失败」不算）",
  RULES.reviewClaims({ claims: ["读取历史失败", "审查完成"] }).length === 1,
  JSON.stringify(RULES.reviewClaims({ claims: ["读取历史失败", "审查完成"] }))
);
check(
  "红灯的正文只带前 3 行，且是包含那个词的行",
  (() => {
    const lines = RULES.linesWith(["a 完成", "b 无关", "c 完成", "d 完成", "e 完成"].join("\n"), RULES.COMPLETION_WORD);
    return lines.length === 3 && lines.every((l) => l.includes(RULES.COMPLETION_WORD)) && !lines.some((l) => l.includes("无关"));
  })(),
  JSON.stringify(RULES.linesWith(["a 完成", "b 无关", "c 完成", "d 完成", "e 完成"].join("\n"), RULES.COMPLETION_WORD))
);

/* ---- 8. 接线：这一趟真的挂进了门禁，反向控制没被摘掉 ---- */

const pkg = JSON.parse(read("package.json"));
const runnerSrc = read("tools/e2e-fake-provider.mjs");
const harnessSrc = read("tools/e2e-fake-provider.cjs");

check(
  "`audit:app` 里挂着这一趟真 Electron（判据在 app 套件、纯规则在 static 套件）",
  pkg.scripts["audit:app"].includes("audit:e2e-truncation") && pkg.scripts["audit:static"].includes("audit:truncation-rules"),
  `audit:app = ${pkg.scripts["audit:app"].slice(0, 120)}…`
);
check(
  "两个 script 各自指到本轮的 runner 与 smoke",
  pkg.scripts["audit:e2e-truncation"] === "node tools/e2e-fake-provider.mjs" &&
    pkg.scripts["audit:truncation-rules"] === "node tools/e2e-fake-provider-smoke.mjs",
  `${pkg.scripts["audit:e2e-truncation"]} / ${pkg.scripts["audit:truncation-rules"]}`
);
check(
  "runner 同时用上截断判据与它的反向控制（少了任何一条，绿就只是那一趟跑过）",
  runnerSrc.includes("truncationViolations") &&
    runnerSrc.includes("expectTruncated: true") &&
    runnerSrc.includes("expectTruncated: false") &&
    runnerSrc.includes("missingSteps"),
  "expectTruncated 的两个方向各出现一次"
);
check(
  "harness 把屏幕上读到的事实写进报告（状态、文字、主区文字、提示语），而不是只报 ok",
  ["data-run-status", "innerText", "__ocrToasts", "steps", "views"].every((needle) => harnessSrc.includes(needle)),
  "captureView + INSTALL_COLLECTOR + finish() 的 report 三件套"
);
/** 去掉行首注释之后的源码。harness 的文件头把这条承诺写成了句子（「the harness never writes
 * `budget_exceeded: true` anywhere」），所以「源码里没有这句话」只能在代码上判——否则这条断言
 * 会因为注释里那句自我描述而红，而它想守的恰恰是那句话。 */
const codeOf = (src) =>
  src
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

check(
  "harness 自己不改写截断：预算从表单进 CLI，`budget_exceeded` 只从屏幕上读回来",
  codeOf(harnessSrc).includes("--max-tokens-budget") &&
    !codeOf(harnessSrc).includes("budget_exceeded: true") &&
    !codeOf(harnessSrc).includes("budget_exceeded:true"),
  "spawn 参数里有 --max-tokens-budget，代码里没有手写的 budget_exceeded: true（注释里那句自我描述不算）"
);

console.log(`\n${failures.length ? `FAILED  ${failures.length} 条` : "全部通过"}`);
if (failures.length) {
  console.error(`截断判据 smoke 失败：${failures.join(", ")}`);
  process.exit(1);
}
