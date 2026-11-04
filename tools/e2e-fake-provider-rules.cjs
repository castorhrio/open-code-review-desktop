// 截断那一屏的规则：一次被预算截短的运行，屏幕上不许出现「完成」。
//
// 为什么需要这一条：到第 132 轮为止，「预算截断不显示干净」只有两层证据——界面层的
// `runLimitReached()`（`src/lib/format.ts`）与 CLI 层的真跑（`tools/fake-provider-smoke.mjs`
// 跑出 `summary.budget_exceeded=true` 的那一趟）。两层之间那一屏**从来没有人真渲染过**：
// 把假 provider 交给 Electron、让界面自己起一次带预算上限的运行、再读屏幕上写了什么，
// 是 `tools/e2e-fake-provider.cjs` 补上的那一半，而本文件是它的判据。
//
// 判据不靠截图，也不靠类名：`src/lib/format.ts` 的 `statusBadge()` 把 `id` 挂在
// `data-run-status` 上，harness 读的是那个值加徽章自己的文字。于是「徽章说这次运行是哪种
// 状态」是一个值，不是一次对 DOM 的猜测。
//
// 三条纪律，都是本仓别处已经付过学费的：
//
//   * **规则不读源码，读屏幕。** `tools/format-notice-smoke.mjs` 已经把语气钉在函数级，
//     这一层要的是另一件事：真渲染出来的一屏。把两者混在一起，绿的那条就永远绿。
//   * **同一套规则要能对着完成态变红。** 否则「截断时它变绿」可能只是因为它对任何一屏都绿。
//     所以 `truncationViolations(..., { expectTruncated: false })` 与反向控制由
//     `tools/e2e-fake-provider-smoke.mjs` 逐条钉住。
//   * **缺一步也是红灯。** 一个从报告里消失的检查，在一份只数失败的汇总里读起来跟绿的一样。
"use strict";

/** 那条标记发现。只有 `tools/fake-provider.mjs` 会发这句话，所以屏幕上出现它就是
 * 「这条结果真的来自一次跑完的、经过解析的运行」，而不是渲染器自己编的。 */
const FINDING_MARKER = "FAKE-PROVIDER";

/** 截断条的第一句（`RunLimitNotice`，预算分支）。`summary.budget_exceeded` 为真时它才带
 * 「 token 预算」四个字，所以这句话同时是两个事实的证据：界面读到了截断，且读到了是哪种截断。 */
const TRUNCATION_BAND = "这次审查在达到 token 预算上限时停下";

/** 结果页头部的预算格（`ResultsPanel`，只在 `s.budget_exceeded` 时渲染）。它比截断条更严格：
 * 截断条只要求 `runLimitReached()`，这一格要的正是 `summary.budget_exceeded` 本身。 */
const BUDGET_CHIP = "已触达 token 上限";

/** 徽章的两个取值。`limited` 是 `statusBadge()` 给「CLI 说 complete、但被上限截短」的那一种
 * 状态另起的 id——它是本仓唯一一处刻意让徽章的字与 CLI 的 `status` 不一致的地方。 */
const LIMITED = { id: "limited", label: "未审完" };
const COMPLETE = { id: "complete", label: "完成" };

/** 完成二字。它在这份规则里只作为「一次截短的运行不许说出口的词」出现。 */
const COMPLETION_WORD = "完成";

/** 截断那一趟把表单里的「总 token 上限」填成这个数（远小于下面每次请求报的 token 数），
 * 于是截断由 CLI 自己的预算算术产生，不是被替身或界面模拟出来的。 */
const BUDGET_TOKENS = 25000;

/** 截断那一趟里假 provider 每次请求报的用量：单次就已经超过上面的上限，所以第一次请求之后
 * 预算就被算穿了。与 `tools/fake-provider-smoke.mjs` 第 6 节用的是同一组数。 */
const TRUNCATED_USAGE = { prompt_tokens: 20000, completion_tokens: 10000, total_tokens: 30000 };

/** 这一趟必须报出来的步骤。少了哪一条就是红灯：一个从报告里消失的检查，在一份只数失败的
 * 汇总里读起来跟绿的一样（`tools/e2e-flow.cjs` 与 `tools/e2e-first-run.cjs` 同一条纪律）。
 * `modes` 说明哪一趟该有它——填预算那一步只有截断那一趟会走，`--commit` 那一步只有
 * 单个提交那一趟会走。 */
const HARNESS_STEPS = Object.freeze([
  { name: "the harness booted against a throwaway profile, not the user's", modes: ["truncated", "complete", "commit"] },
  { name: "the review page rendered against the fixture repository", modes: ["truncated", "complete", "commit"] },
  { name: "the budget came from the form, not from the fixture's config", modes: ["truncated"] },
  { name: "the run finished and the results screen replaced the run view", modes: ["truncated", "complete"] },
  { name: "at least one toast was captured while it was on screen", modes: ["truncated", "complete"] },
  { name: "the 单个提交 scope reached the CLI as --commit <sha>", modes: ["commit"] },
  { name: "the commit run finished and the results screen replaced the run view", modes: ["commit"] },
]);

/** `单个提交` 那一趟在「审查范围」里该显示的命令行提示。它只在这个范围下渲染
 * （`ReviewPanel` 的 `Section actions` 读 `MODE_META[mode].command`），所以屏幕上出现它
 * 就是「范围真的切过去了」的证据——比「按钮被点过」更接近用户看到的东西。 */
const COMMIT_SCOPE_HINT = "ocr review --commit SHA";

/** 这一趟该报而没报的步骤名。 */
function missingSteps(reported, mode) {
  const seen = new Set(reported || []);
  return HARNESS_STEPS.filter((step) => step.modes.includes(mode) && !seen.has(step.name)).map((step) => step.name);
}

/**
 * 屏幕上出现过哪些提示语（toast）。
 *
 * `tools/e2e-fake-provider.cjs` 用 MutationObserver 逐条记下——toast 会自己消失，只在结束时
 * 扫一眼 DOM 会漏掉恰恰是最先出现的那一条。每条带 `type`（toast 库的 success / warning /
 * error），因为「结束时说了什么」与「用什么语气说的」是两件事：`completionNotice()` 的语气
 * 就是从徽章 id 派生出来的，截断那一趟该是 warning。
 */
function claimsOf(view) {
  const claims = Array.isArray(view && view.claims) ? view.claims : [];
  return claims
    .map((c) => (typeof c === "string" ? { type: "", text: c } : { type: String((c && c.type) || ""), text: String((c && c.text) || "") }))
    .filter((c) => c.text.trim() !== "");
}

/** 这些提示语里，说的是「这次审查怎么样」的那几条。筛选条件宽到不会漏，窄到不会把
 * 「读取历史失败」这类无关提示算进来。 */
function reviewClaims(view) {
  return claimsOf(view).filter((c) => c.text.includes("审查"));
}

const claimsText = (view) => claimsOf(view).map((c) => c.text.trim()).join("\n");

/** 屏幕上提到这个词的整行，用来把「哪一行写了」带进红灯的理由里。 */
function linesWith(text, word) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(word))
    .slice(0, 3);
}

/**
 * 结果页这一屏与「这次运行到底跑没跑完」是否一致，逐条回答。
 *
 * `view` 是 `tools/e2e-fake-provider.cjs` 在真界面上读到的事实：
 *   status  徽章的 `data-run-status`，label 徽章自己的文字，
 *   screen  `<main>` 的 innerText（含 `role="status"` 的读屏行），
 *   claims  这一趟出现过的所有提示语（含类型）。
 *
 * 返回空数组才是绿。截断那一趟的每一条都对应一句承诺：
 *   1. 徽章不许说「完成」（DOD-4 的「预算截断不显示『干净』」）；
 *   2. 徽章文字也不许说「完成」——读的是 DOM，值与字是两处，不能只对一个；
 *   3. 截断条要在屏幕上（不是在 tooltip 里）；
 *   4. 已发布的那条发现还在（截断不是「清空结果」）；
 *   5. `summary.budget_exceeded` 真的被界面读到了（头部的预算格）；
 *   6. 结束时的提示语也不许说「完成」，且不许用 success 语气——CLI 对被截短的运行照样报
 *      `status=complete`，一句按退出码写的「审查完成」正是这条承诺最容易破的地方。
 *
 * 完成态是反向控制：同一套规则反向跑一遍必须变红，且必须红在上面第 1 条那句原话上，
 * 否则「截断时它变绿」可能只是因为它对任何一屏都绿。
 */
function truncationViolations(view, { expectTruncated } = {}) {
  const v = [];
  const status = String((view && view.status) || "");
  const label = String((view && view.label) || "");
  const screen = String((view && view.screen) || "");
  const claims = reviewClaims(view);
  const hasBand = screen.includes(TRUNCATION_BAND);
  const hasChip = screen.includes(BUDGET_CHIP);
  const hasFinding = screen.includes(FINDING_MARKER);
  const saidDone = claims.filter((c) => c.text.includes(COMPLETION_WORD));

  if (expectTruncated) {
    if (status === COMPLETE.id) {
      v.push(`徽章写了「完成」而这次运行本该是截断（data-run-status=${COMPLETE.id}，徽章文字=「${label}」）`);
    } else if (status !== LIMITED.id) {
      v.push(`徽章不是截断态：data-run-status=${JSON.stringify(status)}，期望 ${LIMITED.id}（徽章文字=「${label}」）`);
    } else if (label.includes(COMPLETION_WORD)) {
      v.push(`徽章的 id 是 ${LIMITED.id}，但文字写了「${label}」——读数读的是文字`);
    }
    if (!hasBand) v.push(`截断条没出现：屏幕上找不到「${TRUNCATION_BAND}」`);
    if (!hasChip) v.push(`结果页没有「${BUDGET_CHIP}」这一格——summary.budget_exceeded 没被界面读到`);
    if (!hasFinding) v.push(`截断把已发布的结果弄丢了：屏幕上找不到 ${FINDING_MARKER} 那条发现`);
    if (saidDone.length) v.push(`这次运行的提示语写了「完成」：${saidDone.map((c) => c.text.trim()).join(" / ")}`);
    const successTone = claims.filter((c) => c.type === "success");
    if (claims.length && successTone.length) {
      v.push(`截断那一趟有 ${successTone.length} 条提示语用的是 success 语气：${successTone.map((c) => c.text.trim()).join(" / ")}`);
    }
  } else {
    if (status !== COMPLETE.id) v.push(`完成态被读成「${label}」（data-run-status=${JSON.stringify(status)}）`);
    else if (label !== COMPLETE.label) v.push(`完成态的徽章文字是「${label}」，期望「${COMPLETE.label}」`);
    if (hasBand) v.push(`完成态出现了截断条「${TRUNCATION_BAND}」——一次没被截短的运行不该这么说`);
    if (hasChip) v.push(`完成态出现了「${BUDGET_CHIP}」，但这次运行没有触到任何上限`);
    if (!hasFinding) v.push(`完成态没有那条标记发现（${FINDING_MARKER}），这一趟的运行级结论就无从谈起`);
    if (!saidDone.length) {
      v.push(`完成态的提示语没说「完成」：${claims.map((c) => c.text.trim()).join(" / ") || "（一条都没有）"}`);
    } else if (!saidDone.some((c) => c.type === "success")) {
      v.push(`完成态的提示语说了「${saidDone[0].text.trim()}」，但语气是 ${JSON.stringify(saidDone[0].type)} 而不是 success`);
    }
  }
  return v;
}

/**
 * 同一屏的「阅读」文档页（`ReportView`）上，截断该怎么说。
 *
 * 与结果页共用同一个徽章与同一条截断条（`RunLimitNotice` 被两个界面渲染），但**没有**头部的
 * 预算格，所以这里不查那一格；反过来说，文档页更容易被当成「完整的一份报告」读，所以那张
 * 徽章与那条「不等于全量审查」的话都必须真的在纸面上。
 */
function reportViolations(view, { expectTruncated } = {}) {
  const v = [];
  const status = String((view && view.status) || "");
  const label = String((view && view.label) || "");
  const screen = String((view && view.screen) || "");
  const hasBand = screen.includes(TRUNCATION_BAND);
  const hasFinding = screen.includes(FINDING_MARKER);
  const said = linesWith(screen, COMPLETION_WORD);

  if (expectTruncated) {
    if (status !== LIMITED.id) v.push(`报告页的徽章不是截断态：data-run-status=${JSON.stringify(status)}（文字=「${label}」）`);
    if (label.includes(COMPLETION_WORD)) v.push(`报告页徽章的文字写了「${label}」`);
    if (!hasBand) v.push(`报告页没有截断条「${TRUNCATION_BAND}」——一份被截短的报告最容易在这里读成完整的一份`);
    if (!hasFinding) v.push(`报告页没有那条标记发现（${FINDING_MARKER}）`);
    if (said.length) v.push(`报告页写了「${COMPLETION_WORD}」：${said.join(" / ")}`);
  } else {
    if (status !== COMPLETE.id) v.push(`完成态的报告页被读成「${label}」（data-run-status=${JSON.stringify(status)}）`);
    if (hasBand) v.push(`完成态的报告页出现了截断条`);
    if (!hasFinding) v.push(`完成态的报告页没有那条标记发现（${FINDING_MARKER}）`);
  }
  return v;
}

/**
 * `单个提交` 那一趟该说什么。
 *
 * 这一条守的是 README 第一条承诺（Four scopes）里唯一还停在预览级的那一格：预览只证明
 * 「CLI 能算出这个范围有哪些文件」，不证明「按下开始审查之后命令行里真的带着
 * `--commit <sha>`」。所以判据读两处事实：
 *
 *   * **命令行**（`spawnArgs`，harness 在 `cp.spawn` 上记的）：`review` 的参数里必须有
 *     `--commit`，且紧跟其后的就是那个 SHA。这是「范围真的传下去了」的唯一硬证据——
 *     界面上写着「单个提交」而命令行里没有 `--commit`，正是这一条要抓的那种假绿。
 *   * **屏幕**（`view`）：范围提示是 `ocr review --commit SHA`（说明范围切过去了）、徽章是
 *     `complete`、那条标记发现在。截断/失败不在这条判据的射程内——那是
 *     `truncationViolations` 的事。
 *
 * 反向控制：把 `ocr-service.js` 里 `if (spec.mode === "commit") args.push("--commit", ...)`
 * 那一行删掉，这一趟必须红在「命令行里没有 --commit」上；`tools/e2e-fake-provider-smoke.mjs`
 * 用一份没有 `--commit` 的 spawnArgs 钉住这个方向。
 */
function commitScopeViolations({ view, scopeScreen, spawnArgs, sha } = {}) {
  const v = [];
  const args = Array.isArray(spawnArgs) ? spawnArgs : [];
  // 只认**真正的运行**：预览（`--preview`）也带 `--commit`，把它算进来就等于用「范围算得出来」
  // 冒充「范围跑起来了」——那正是这一条要堵的假绿。
  const run = args.find((a) => Array.isArray(a) && (a[0] === "review" || a[0] === "scan") && !a.includes("--preview"));
  const status = String((view && view.status) || "");
  const label = String((view && view.label) || "");
  const screen = String((view && view.screen) || "");
  const before = String(scopeScreen || "");

  if (!run) {
    v.push("这一趟没有起任何真正的 review/scan 子进程（只有预览）——按下开始审查之后什么都没跑");
  } else {
    const at = run.indexOf("--commit");
    if (at < 0) {
      v.push(`命令行里没有 --commit：这一趟跑的不是「单个提交」范围（${run.slice(0, 8).join(" ")} …）`);
    } else if (run[at + 1] !== sha) {
      v.push(`--commit 后面不是那个提交：${JSON.stringify(run[at + 1])} ≠ ${JSON.stringify(sha)}`);
    }
  }

  if (!before.includes(COMMIT_SCOPE_HINT)) {
    v.push(`按下开始审查之前的那一屏没有「${COMMIT_SCOPE_HINT}」——范围没有真的切到单个提交`);
  }
  if (status !== COMPLETE.id) {
    v.push(`单个提交那一趟的徽章是 ${JSON.stringify(status)}（文字=「${label}」），期望 ${COMPLETE.id}`);
  }
  if (!screen.includes(FINDING_MARKER)) {
    v.push(`单个提交那一趟没有那条标记发现（${FINDING_MARKER}），运行级结论无从谈起`);
  }
  return v;
}

module.exports = {
  FINDING_MARKER,
  TRUNCATION_BAND,
  BUDGET_CHIP,
  COMPLETION_WORD,
  LIMITED,
  COMPLETE,
  BUDGET_TOKENS,
  TRUNCATED_USAGE,
  COMMIT_SCOPE_HINT,
  HARNESS_STEPS,
  missingSteps,
  claimsOf,
  reviewClaims,
  claimsText,
  linesWith,
  truncationViolations,
  reportViolations,
  commitScopeViolations,
};
