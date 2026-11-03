// The UI typography check, checked against the wrong implementations it exists
// to catch — without a browser, so `audit:static` can run it.
//
// Why this file exists: `tools/ui-cjk-typography.mjs` walks three screens in a
// real browser, which `audit:static` cannot do (it has no build and no browser).
// But the part that can be wrong in a way nobody notices is not the walking — it
// is the *rules* and the *wiring*: a rule re-implemented here instead of imported
// would drift from the document rules, and a harness nobody runs is a green light
// that is never turned on. Both are plain Node questions, so they are asked here.
//
// The three things asserted:
//
//   1. **Same source.** For a set of sample lines, the answer the UI check gives
//      must be the answer the document check gives — same rules, same sentences.
//      A re-implementation that "looks equivalent" fails this the moment it
//      differs by one boundary, and the boundary is asserted explicitly (a
//      half-width comma followed by a space is *not* a violation, which is what
//      keeps every numbered list in the app green).
//   2. **Locatable.** A violation has to name the screen, the block, the line and
//      the text. A failure a reader cannot find is a failure they re-run instead
//      of fix.
//   3. **Wired, and the reverse control's premise holds.** The harness is in
//      `audit:app` (it needs `out/`), this file is in `audit:static`, and every
//      sentence the browser harness mutates still exists verbatim in the source
//      that renders it — otherwise that harness exits 2 on a reworded sentence
//      and the reverse control silently stops being one.
//   4. **The screen list and the per-screen premise.** Which screens are walked
//      is asserted (a screen that quietly left the list is a green that shrank),
//      and so is the rule that a screen with no full-width punctuation anywhere
//      counts as unread rather than clean.
//
// No Electron, no browser, no build: plain Node. Run with
// `npm run audit:typography-ui-rules`.
import fs from "node:fs";
import path from "node:path";
import { typographyViolations } from "./cjk-typography.mjs";
import {
  MUTATIONS,
  SCREENS,
  screensWithoutProsePunctuation,
  uiTypographyViolations,
} from "./ui-cjk-typography.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const block = (text, where = "p") => [{ where, text }];
const rulesOf = (violations) => violations.map((violation) => violation.rule);

/* ---- 1. the same three rules, not a second copy of them ----
 *
 * The UI check imports `lineStartViolation` / `halfWidthViolations` /
 * `bareAdjacencyViolations` from the document check. This asserts the *effect* of
 * that import rather than the import statement: for every sample line, the two
 * callers must report the same rules with the same sentences. Someone who pastes
 * a rule into the UI file instead of importing it will disagree on one of these
 * lines the first time either copy is touched — and the samples are chosen so
 * that "touched" means "the boundary moved", not "the rule was deleted".
 */
{
  const samples = [
    "这一行,中文", // 半角标点后接中文
    "用ocr跑", // 中英裸拼
    "，这一行以逗号开头", // 行首禁则
    "正常的一句中文，没有问题。", // clean
    "这一行, 中文", // half-width comma + space: deliberately NOT a violation
    "第 2 轮与 v0.1.13 都带空格", // digits are not part of 中英裸拼
    "`code` 后面,中文", // a code span is not prose, the comma after it still is
  ];
  const mismatched = [];
  for (const line of samples) {
    const doc = typographyViolations("sample.md", line);
    const ui = uiTypographyViolations("sample-screen", block(line));
    const docPairs = doc.map((violation) => `${violation.rule}|${violation.detail}`);
    const uiPairs = ui.map((violation) => `${violation.rule}|${violation.detail.slice(violation.detail.indexOf("：") + 1)}`);
    if (JSON.stringify(docPairs) !== JSON.stringify(uiPairs)) mismatched.push({ line, docPairs, uiPairs });
  }
  check(
    "the UI check reports exactly what the document check reports, line for line",
    mismatched.length === 0,
    JSON.stringify(mismatched)
  );

  // The boundary that keeps the app green: a half-width comma followed by a space
  // is how every numbered list is set, and a rule that flagged it would be turned
  // off within a week. Asserted in both directions so "no violations" cannot be
  // the answer for the wrong reason.
  check(
    "...and a half-width comma followed by a space is not a violation, while the same comma touching Chinese is",
    rulesOf(uiTypographyViolations("s", block("这一行, 中文"))).length === 0 &&
      rulesOf(uiTypographyViolations("s", block("这一行,中文"))).includes("半角标点后接中文"),
    JSON.stringify({
      spaced: rulesOf(uiTypographyViolations("s", block("这一行, 中文"))),
      touching: rulesOf(uiTypographyViolations("s", block("这一行,中文"))),
    })
  );
}

/* ---- 2. each rule fires on rendered text, and the failure is locatable ----
 *
 * The three defects a screen can carry, one block each. What is asserted is not
 * only "it went red" but "it said where": the screen name, the block's element,
 * the line inside the block, and the offending text. That is the difference
 * between a check someone can act on and a check that gets re-run.
 */
{
  const halfWidth = uiTypographyViolations("results-findings", block("这里对 email 建了索引,索引失效", "span.line-clamp-2"));
  check(
    "半角标点后接中文 fires on a rendered finding and names the screen, the element and the text",
    halfWidth.length === 1 &&
      halfWidth[0].rule === "半角标点后接中文" &&
      halfWidth[0].file === "results-findings" &&
      halfWidth[0].detail.includes("span.line-clamp-2") &&
      halfWidth[0].detail.includes("「,索」") &&
      halfWidth[0].detail.includes("这里对 email 建了索引"),
    JSON.stringify(halfWidth)
  );

  // Both ends of the same word are reported: `用ocr跑` is two adjacencies, and a
  // rule that stopped after the first would leave half the sentence unset.
  const bare = uiTypographyViolations("report-read", block("用ocr跑一遍", "p"));
  check(
    "中英裸拼 fires on a rendered paragraph and quotes both pairs",
    bare.length === 2 &&
      bare.every((violation) => violation.rule === "中英裸拼") &&
      bare[0].detail.includes("「用o」") &&
      bare[1].detail.includes("「r跑」"),
    JSON.stringify(bare)
  );

  const start = uiTypographyViolations("report-read", block("，这一行以逗号开头", "p"));
  check(
    "行首禁则 fires on a block that begins with a closing mark",
    start.length === 1 && start[0].rule === "行首禁则" && start[0].detail.includes("「，」"),
    JSON.stringify(start)
  );

  // A block is several lines when the app renders `<br>` or a multi-line string;
  // the line number inside the block is what tells a reader which one to fix.
  const multi = uiTypographyViolations("report-read", block("第一行正常。\n第二行,这里有问题。", "p"));
  check(
    "...and a violation on the second line of a block says so, rather than blaming the block",
    multi.length === 1 && multi[0].detail.includes("第 2 行") && multi[0].detail.includes("第二行"),
    JSON.stringify(multi)
  );

  // The other direction: clean prose must be green, or the check is a rule that
  // fires on everything and therefore says nothing.
  const clean = uiTypographyViolations(
    "report-read",
    block("密码校验用了普通的字符串比较，建议改用 subtle.ConstantTimeCompare。", "p")
  );
  check("clean rendered prose is green", clean.length === 0, JSON.stringify(clean));

  // The screens the harness walks are the surfaces where the app writes the most
  // Chinese. A screen list that lost one of them would still be green, so the
  // list itself is asserted — including the three that were added last, because
  // "the notice bar / settings / guide are covered" is exactly the claim that
  // decays into a comment when nothing reads it.
  check(
    "the harness walks the findings, long-finding, report, notice, settings and guide screens",
    SCREENS.map((screen) => screen.name).join(",") ===
      "results-findings,results-long-finding,report-read,notice-overflow,settings-top,guide-first-run",
    SCREENS.map((screen) => screen.name).join(",")
  );

  // The guide screen is the only one that overrides the shared storage, and it
  // has to: `STORAGE` carries `guide-dismissed: 1`, so a screen that inherited it
  // would render no card at all and still report green.
  const guide = SCREENS.find((screen) => screen.name === "guide-first-run");
  check(
    "...and the guide screen opts out of the dismissed flag the other screens share",
    Boolean(guide && guide.storage && !("guide-dismissed" in guide.storage)),
    JSON.stringify(guide && guide.storage)
  );

  // The premise: a screen whose blocks carry no full-width punctuation was not
  // read. Asserted on the function, in both directions — a screen with prose is
  // green, a screen with only bare labels is named.
  const read = [{ screen: "settings-top", blocks: [{ where: "p", text: "这里改的是官方 CLI 的用户级配置，本程序只调用 ocr config set 写入。" }] }];
  const unread = [
    { screen: "notice-overflow", blocks: [{ where: "p", text: "窗口就绪前有 2 条事件超出缓冲上限" }] },
    { screen: "guide-first-run", blocks: [{ where: "div", text: "选择要审查的仓库目录" }, { where: "span", text: "3" }] },
  ];
  check(
    "a screen with no full-width punctuation anywhere is named as unread, and a screen with prose is not",
    screensWithoutProsePunctuation([...read, ...unread]).join(",") === "notice-overflow,guide-first-run",
    JSON.stringify(screensWithoutProsePunctuation([...read, ...unread]))
  );
  check(
    "...and the premise is not vacuous: it reads the blocks it is given",
    screensWithoutProsePunctuation(read).length === 0 && screensWithoutProsePunctuation(unread).length === 2,
    JSON.stringify({ read: screensWithoutProsePunctuation(read), unread: screensWithoutProsePunctuation(unread) })
  );
}

/* ---- 3. wired, and the reverse control's premise still holds ----
 *
 * The browser half needs `out/`, so it belongs in `audit:app` next to `audit:ui`
 * rather than in `audit:static` — a static suite that needs a build is not
 * static. This file is the half that can run without one, and it is in
 * `audit:static`.
 */
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const scripts = pkg.scripts || {};
  check(
    "`audit:typography-ui` runs the browser harness",
    scripts["audit:typography-ui"] === "node tools/ui-cjk-typography.mjs",
    scripts["audit:typography-ui"]
  );
  check(
    "...and it is part of `audit:app`, which builds once for every harness",
    String(scripts["audit:app"] || "").includes("audit:typography-ui"),
    scripts["audit:app"]
  );
  check(
    "`audit:typography-ui-rules` runs this file and is part of `audit:static`",
    scripts["audit:typography-ui-rules"] === "node tools/ui-cjk-typography-smoke.mjs" &&
      String(scripts["audit:static"] || "").includes("audit:typography-ui-rules"),
    JSON.stringify({ rules: scripts["audit:typography-ui-rules"], static: scripts["audit:static"] })
  );

  // The reverse control mutates one sentence per screen kind in the built bundle.
  // If a sentence is reworded, the harness exits 2 — correct, but only if someone
  // notices. This makes the premise a red assertion in the suite that runs on
  // every change, for every mutation rather than for the first one.
  const missing = MUTATIONS.filter((mutation) => {
    const source = fs.readFileSync(path.join(ROOT, mutation.source), "utf8");
    return !source.includes(mutation.needle) || source.includes(mutation.mutant);
  });
  check(
    "every sentence the reverse control mutates still exists verbatim in the component that renders it",
    missing.length === 0,
    JSON.stringify(missing.map((mutation) => ({ source: mutation.source, needle: mutation.needle })))
  );
  check(
    "...and each mutation names a screen the harness actually walks",
    MUTATIONS.every((mutation) => SCREENS.some((screen) => screen.name === mutation.screen)),
    JSON.stringify(MUTATIONS.map((mutation) => mutation.screen))
  );
}

if (failures.length) {
  console.log(`\n${failures.length} 条断言失败：`);
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
console.log("\n所有断言通过（规则同源、三条规则各自点名、六屏清单与逐屏前提、接线与反向控制前提）。");
