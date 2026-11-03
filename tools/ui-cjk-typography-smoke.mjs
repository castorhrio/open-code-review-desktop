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
  MIN_CJK_FONT_PX,
  MUTATIONS,
  SCREENS,
  STYLE_MUTATIONS,
  cjkFontSizeViolations,
  fontStackViolations,
  isCjkFamily,
  parseFontStack,
  screensWithoutCjkText,
  screensWithoutProsePunctuation,
  uiFontStackViolations,
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

/* ---- 2b. the type ramp's floor and the font stack's order ----
 *
 * Two claims `styles.css` states in comments and nothing read: no Chinese text
 * below 12px, and Latin → Chinese → generic in `--font-sans`. A comment cannot
 * hold either — 11px is one edit away and a missing Chinese family looks correct
 * on the machine that wrote it (that is the toast story in `App.tsx`).
 *
 * The rules are asked here on constructed leaves, and the *declarations* are
 * asked of `src/styles.css` itself: the browser harness can only say "what is
 * rendered is fine today", while this says "the stylesheet this build reads from
 * still declares it", which is the half that runs in `audit:static`.
 */
{
  // The floor. Every boundary is asserted in both directions, because a rule
  // that fires on 13px too would be turned off and take the real check with it.
  const leaf = (text, fontSize, fontFamily = '"Inter", "Microsoft YaHei", sans-serif') => ({
    where: "span.text-meta",
    text,
    fontSize,
    fontFamily,
  });
  const atEleven = cjkFontSizeViolations("settings-top", [leaf("不写配置、也不需要先保存", 11)]);
  const atTwelve = cjkFontSizeViolations("settings-top", [leaf("不写配置、也不需要先保存", 12)]);
  const atThirteen = cjkFontSizeViolations("settings-top", [leaf("不写配置、也不需要先保存", 13)]);
  check(
    "中文字号低于 12px fires at 11px and names the screen, the size and the element",
    atEleven.length === 1 &&
      atEleven[0].rule === "中文字号低于 12px" &&
      atEleven[0].file === "settings-top" &&
      atEleven[0].detail.includes("11px") &&
      atEleven[0].detail.includes("span.text-meta"),
    JSON.stringify(atEleven)
  );
  check(
    "...and 12px (the ramp's smallest step) and 13px are green",
    atTwelve.length === 0 && atThirteen.length === 0,
    JSON.stringify({ atTwelve, atThirteen })
  );
  check(
    "...and the rule is about Chinese: an 11px leaf with no Chinese character in it is not a finding",
    cjkFontSizeViolations("settings-top", [leaf("v1.13.4", 11)]).length === 0,
    JSON.stringify(cjkFontSizeViolations("settings-top", [leaf("v1.13.4", 11)]))
  );
  // The premise the leaf probe carries: a size that is not a number is reported,
  // not skipped. "Unreadable" and "fine" must not be the same answer.
  check(
    "...and a leaf whose font-size cannot be read is reported rather than passed",
    cjkFontSizeViolations("settings-top", [leaf("中文", Number.NaN)]).length === 1,
    JSON.stringify(cjkFontSizeViolations("settings-top", [leaf("中文", Number.NaN)]))
  );

  // The stack, three ways it can be wrong and the shapes that are fine.
  const good = '"Inter", "Inter Variable", -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif';
  const noCjk = '"Inter", -apple-system, "Segoe UI", system-ui, sans-serif';
  const cjkFirst = '"Microsoft YaHei", "Inter", sans-serif';
  const deadAfterGeneric = '"Inter", "Microsoft YaHei", sans-serif, "Segoe UI"';
  const twoGenerics = '"Inter", "Microsoft YaHei", system-ui, sans-serif';
  check(
    "fontStackViolations is green on the stack the app declares (Latin → Chinese → generic)",
    fontStackViolations("--font-sans", good).length === 0,
    JSON.stringify(fontStackViolations("--font-sans", good))
  );
  check(
    "...and a stack with no Chinese family is 字体栈缺中文字族",
    fontStackViolations("--font-sans", noCjk).map((v) => v.rule).join(",") === "字体栈缺中文字族",
    JSON.stringify(fontStackViolations("--font-sans", noCjk))
  );
  check(
    "...and Chinese before Latin is 中文字族排在拉丁字族之前",
    fontStackViolations("--font-sans", cjkFirst).map((v) => v.rule).join(",") === "中文字族排在拉丁字族之前",
    JSON.stringify(fontStackViolations("--font-sans", cjkFirst))
  );
  check(
    "...and a real family after a generic one is 通用字族之后还有字族",
    fontStackViolations("--font-sans", deadAfterGeneric).map((v) => v.rule).join(",") === "通用字族之后还有字族",
    JSON.stringify(fontStackViolations("--font-sans", deadAfterGeneric))
  );
  check(
    "...while a second generic after the first is fine (the app's stack ends that way)",
    fontStackViolations("--font-sans", twoGenerics).length === 0,
    JSON.stringify(fontStackViolations("--font-sans", twoGenerics))
  );
  check(
    "...and an empty stack is not green: it is reported as 字体栈为空",
    fontStackViolations("--font-sans", "").map((v) => v.rule).join(",") === "字体栈为空",
    JSON.stringify(fontStackViolations("--font-sans", ""))
  );

  // Screens are named once per distinct stack, with the count and an example
  // leaf: one defect should not print once per leaf, and "how many" is what tells
  // a reader whether they are looking at a component or at the whole app.
  const stackNamed = uiFontStackViolations("settings-top", [
    leaf("这里改的是官方 CLI 的用户级配置。", 13, noCjk),
    leaf("不写配置、也不需要先保存。", 13, noCjk),
  ]);
  check(
    "the screen-level stack rule names the screen, the count and one element",
    stackNamed.length === 1 &&
      stackNamed[0].file === "settings-top" &&
      stackNamed[0].rule === "字体栈缺中文字族" &&
      stackNamed[0].detail.includes("2 处中文文本") &&
      stackNamed[0].detail.includes("span.text-meta"),
    JSON.stringify(stackNamed)
  );

  // The second premise: a screen with no Chinese leaf was not read for these two
  // rules. Separate from the punctuation premise because a screen of bare labels
  // can be green on punctuation and silent on 12px.
  const read = [{ screen: "settings-top", leaves: [leaf("不写配置。", 13)] }];
  const unread = [
    { screen: "notice-overflow", leaves: [leaf("v1.13.4 run 3", 12)] },
    { screen: "guide-first-run", leaves: [] },
  ];
  check(
    "a screen with no Chinese leaf is named as unread, and a screen with Chinese leaves is not",
    screensWithoutCjkText([...read, ...unread]).join(",") === "notice-overflow,guide-first-run",
    JSON.stringify(screensWithoutCjkText([...read, ...unread]))
  );
  check(
    "...and that premise is not vacuous either",
    screensWithoutCjkText(read).length === 0 && screensWithoutCjkText(unread).length === 2,
    JSON.stringify({ read: screensWithoutCjkText(read), unread: screensWithoutCjkText(unread) })
  );
}

/* ---- 2c. the stylesheet the build reads from still declares both ----
 *
 * The browser pass proves the rendered app is fine *today*. This proves the
 * declarations the app is built from still say so, which is the half that can
 * run without a build. It also keeps the stylesheet reverse control honest: the
 * needles are compiled text, so a ramp or stack edit here would make the
 * browser harness exit 2 — better to be told here, in the suite that runs on
 * every change.
 */
{
  const css = fs.readFileSync(path.join(ROOT, "src", "styles.css"), "utf8");
  const ramp = [...css.matchAll(/--text-([a-z-]+):\s*(\d+)px/g)].map((match) => ({ step: match[1], px: Number(match[2]) }));
  const smallest = ramp.reduce((min, entry) => Math.min(min, entry.px), Number.POSITIVE_INFINITY);
  check(
    `the type ramp's smallest step is at least ${MIN_CJK_FONT_PX}px`,
    ramp.length >= 4 && smallest >= MIN_CJK_FONT_PX,
    JSON.stringify(ramp)
  );

  const declaredSans = (css.match(/--font-sans:\s*([^;]+);/) || [])[1] || "";
  check(
    "the declared --font-sans is Latin → Chinese → generic",
    fontStackViolations("src/styles.css --font-sans", declaredSans).length === 0 && parseFontStack(declaredSans).some(isCjkFamily),
    JSON.stringify({ declaredSans, violations: fontStackViolations("src/styles.css --font-sans", declaredSans) })
  );

  // The two stylesheet mutations are compiled declarations, so the values they
  // look for have to still be the values in the source. If this goes red, the
  // ramp or the stack changed and `STYLE_MUTATIONS` has to follow — otherwise the
  // browser harness stops the run with "could not be built" instead of proving
  // anything.
  const metaStep = ramp.find((entry) => entry.step === "meta");
  check(
    "the 11px reverse control still targets the current --text-meta step",
    Boolean(metaStep) && STYLE_MUTATIONS[0].needle === `.text-meta{font-size:${metaStep.px}px`,
    JSON.stringify({ metaStep, needle: STYLE_MUTATIONS[0].needle })
  );
  const cjkFamily = parseFontStack(declaredSans).find(isCjkFamily);
  const sansMutation = STYLE_MUTATIONS[1];
  check(
    "the missing-CJK reverse control mutates the very declaration the stylesheet gives, and drops only the Chinese face",
    Boolean(cjkFamily) &&
      sansMutation.needle === `--font-sans:${declaredSans}` &&
      sansMutation.mutant === `--font-sans:${declaredSans.replace(`"${cjkFamily}", `, "")}` &&
      !sansMutation.mutant.includes(cjkFamily) &&
      fontStackViolations("mutant --font-sans", sansMutation.mutant.slice("--font-sans:".length)).length > 0,
    JSON.stringify({ cjkFamily, needle: sansMutation.needle, mutant: sansMutation.mutant })
  );
  check(
    "...and both mutations name a screen the browser harness walks and a rule it reports",
    STYLE_MUTATIONS.every((mutation) => SCREENS.some((screen) => screen.name === mutation.screen) && mutation.rule.length > 0),
    JSON.stringify(STYLE_MUTATIONS.map((mutation) => ({ screen: mutation.screen, rule: mutation.rule })))
  );
}

if (failures.length) {
  console.log(`\n${failures.length} 条断言失败：`);
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
console.log("\n所有断言通过（规则同源、三条规则各自点名、六屏清单与逐屏前提、接线与反向控制前提）。");
