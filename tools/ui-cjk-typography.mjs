// The same three Chinese typesetting rules, asked of the text the app actually
// renders.
//
// Why this file exists: `tools/cjk-typography.mjs` checks the documents a
// stranger reads first — the READMEs, the DoD, the sync notes. The screens are
// the other half of what a stranger reads, and they were the half nothing
// checked: a finding whose prose came back from the model with a half-width
// comma, a label that says `用ocr跑`, a wrapped line that begins with 「，」 —
// every one of those is invisible to `audit:ui` (the layout still fits, nothing
// overflows, no placeholder leaks) and to `audit:typography` (it never opens the
// app). So the rules are imported from that file rather than rewritten here: a
// rule fixed there is fixed on both surfaces, and the two cannot drift.
//
// What is checked, and what is deliberately not:
//
//   - the prose of the results screen (a long finding, the case where the model
//     writes the most text), the reading/report screen, and the chrome around
//     them (nav rail, header, buttons, notices);
//   - the three surfaces that were the *last* to be covered, because they are
//     the ones nobody thinks of as prose: the notice bar (sentences the main
//     process writes about its own failure), the settings page (hints and
//     explanations, the densest Chinese in the app), and the first-run guide
//     card. All three are written by hand, one sentence at a time, which is
//     exactly how a half-width comma gets in;
//   - **not** anything inside `pre` / `code` / `textarea` / `input`: a code
//     sample is not prose, and `foo(x,y)中` in a diff is not a typesetting
//     defect. That exclusion is the difference between a rule and a nuisance,
//     and it is the same exclusion the document rules make for code spans;
//   - **not** the exported HTML report. That file is written by the upstream CLI
//     (`ocr session export`), not by this app — its typography is upstream's to
//     fix, and claiming to check it here would be a green light wired to
//     nothing. What this app owns is the reading screen the export is made from.
//
// The line-start rule is asked of *block* starts, not of wrap points: `innerText`
// breaks lines at block boundaries and at `<br>`, not where the browser wrapped,
// so a comma pushed to the next visual line by the measure is not visible to
// this check. That is a real limit and it is written down rather than papered
// over — the block-start case is the one that comes from pasting translated text
// one cell per line, which is the defect worth catching.
//
// Run with `npm run audit:typography-ui` (needs `out/`; `npm run audit` builds
// once for every harness). The rules' own reverse controls run without a browser
// in `tools/ui-cjk-typography-smoke.mjs`, which `audit:static` runs.
import fs from "node:fs";
import path from "node:path";
import {
  bareAdjacencyViolations,
  formatViolation,
  halfWidthViolations,
  lineStartViolation,
  visibleText,
} from "./cjk-typography.mjs";
import { BRIDGE, STORAGE, serve } from "./ui-audit/fixtures.mjs";
import { describeChannel, loadPlaywright, requireBuilt } from "./ui-audit/playwright.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "out");
const WEAK_OUT = path.join(ROOT, ".tmp-audit", "typography-weak");
const PORT = 5201;

/** A block of rendered text, short enough to quote in a failure sentence. */
const snippet = (text, limit = 60) => {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
};

/**
 * The three rules over the blocks a screen rendered.
 *
 * `blocks` is `[{ where, text }]` — `where` names the element the text came from
 * (tag plus its first class names), `text` is that element's `innerText`. Each
 * block's lines are asked the same three questions the documents are asked, and
 * every violation names the screen, the block, the line and the text, because a
 * failure a reader cannot locate is a failure they will re-run rather than fix.
 */
export const uiTypographyViolations = (screen, blocks) => {
  const violations = [];
  blocks.forEach((block, blockIndex) => {
    const lines = String(block.text == null ? "" : block.text).split(/\r?\n/);
    lines.forEach((line, lineIndex) => {
      const visible = visibleText(line);
      if (!visible.trim()) return;
      const where = `${screen} 第 ${blockIndex + 1} 块（${block.where}）第 ${lineIndex + 1} 行「${snippet(line)}」`;
      const push = (rule, detail) => violations.push({ file: screen, line: blockIndex + 1, rule, detail: `${where}：${detail}` });
      const start = lineStartViolation(line, visible);
      if (start) push("行首禁则", start);
      for (const detail of halfWidthViolations(visible)) push("半角标点后接中文", detail);
      for (const detail of bareAdjacencyViolations(visible)) push("中英裸拼", detail);
    });
  });
  return violations;
};

/**
 * The prose blocks of the current page, in document order.
 *
 * A "block" is the outermost element whose children are all inline-level — the
 * unit a reader sees as one paragraph, one label, one row. Taking the outermost
 * one is what keeps a sentence whole: `<p>foo <strong>bar</strong></p>` is one
 * block, not three, so the line-start rule is asked of the sentence rather than
 * of a fragment that happens to begin with a comma.
 *
 * `inline-block` / `inline-flex` count as inline for the *parent* question (a
 * chip inside a sentence must not split it) but as blocks themselves when they
 * are the outermost box (a button's label is its own line of prose). Code is
 * skipped entirely, by tag and by ancestor.
 */
const proseBlocks = () => {
  const SKIP = new Set(["PRE", "CODE", "TEXTAREA", "INPUT", "SCRIPT", "STYLE", "KBD", "SAMP", "SVG", "CANVAS", "SELECT"]);
  const BOXY_INLINE = new Set(["BUTTON", "A", "LABEL", "SUMMARY", "TH", "TD", "LI"]);
  const skipped = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) if (SKIP.has(n.tagName.toUpperCase())) return true;
    return false;
  };
  const isBlockBox = (el) => {
    const display = getComputedStyle(el).display;
    if (display === "none") return false;
    if (!display.startsWith("inline")) return true;
    return BOXY_INLINE.has(el.tagName.toUpperCase());
  };
  const candidates = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (skipped(el)) continue;
    if (!el.getClientRects().length) continue;
    if (!isBlockBox(el)) continue;
    if (!el.textContent || !el.textContent.trim()) continue;
    if ([...el.children].some((child) => isBlockBox(child))) continue;
    candidates.push(el);
  }
  const set = new Set(candidates);
  const blocks = [];
  for (const el of candidates) {
    let nested = false;
    for (let n = el.parentElement; n; n = n.parentElement) {
      if (set.has(n)) {
        nested = true;
        break;
      }
    }
    if (nested) continue;
    const text = (el.innerText || "").trim();
    if (!text) continue;
    const cls = typeof el.className === "string" ? el.className.split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "";
    blocks.push({ where: el.tagName.toLowerCase() + (cls ? `.${cls}` : ""), text });
  }
  return blocks;
};

// ---- the screens ----
//
// The three surfaces where the app writes the most Chinese: the findings screen
// with a long finding selected (the model's own prose, rendered), the same screen
// at the narrow floor, and the reading/report document. The chrome comes along
// for free — every block on the page is checked, not just the finding body.
const nav = (label) => async (page) => {
  await page.getByRole("button", { name: label, exact: true }).click();
};

const openFindings = async (page) => {
  await nav("历史")(page);
  await page.waitForTimeout(600);
  await page.locator("main").getByRole("button", { name: /结果/ }).first().click();
  await page.waitForTimeout(900);
};

const selectFirstFinding = async (page) => {
  await page.locator("main").getByRole("button", { name: /密码校验/ }).first().click();
  await page.waitForTimeout(900);
};

const openReport = async (page) => {
  await openFindings(page);
  await page.getByRole("button", { name: "阅读", exact: true }).click();
  await page.waitForTimeout(500);
};

export const SCREENS = [
  {
    name: "results-findings",
    query: "",
    navigate: async (page) => {
      await openFindings(page);
      await selectFirstFinding(page);
    },
  },
  {
    name: "results-long-finding",
    query: "?longfinding=1&run=done",
    navigate: async (page) => {
      await nav("审查")(page);
      await page.waitForTimeout(1600);
      await page.getByRole("button", { name: /开始审查/ }).click();
      await page.waitForTimeout(5200);
    },
  },
  { name: "report-read", query: "", navigate: openReport },
  // The notice bar: sentences the main process writes about work it could not
  // do. `?notice=overflow` is the fixture that fills the bar past its bound, so
  // the screen carries the most of them at once — and the bar is the one place
  // where a sentence is *only* ever seen here (the drawer holds the same text,
  // but inside `pre`, which this check skips on purpose).
  {
    name: "notice-overflow",
    query: "?notice=overflow",
    navigate: async (page) => {
      await page.waitForTimeout(600);
    },
  },
  // The settings page: hints, explanations and the about section. The densest
  // hand-written Chinese in the app, and the screen a first run is sent to.
  {
    name: "settings-top",
    query: "",
    navigate: async (page) => {
      await nav("设置")(page);
      await page.waitForTimeout(900);
    },
  },
  // The first-run guide card. Every other screen dismisses it (`STORAGE` carries
  // `guide-dismissed: 1`), so its three steps had no coverage at all — and the
  // steps are the first Chinese a new user reads.
  {
    name: "guide-first-run",
    query: "",
    storage: { "last-repo": "/home/x/work/payments-api", "ocr-theme-pref": "system" },
    navigate: async (page) => {
      await nav("审查")(page);
      await page.waitForTimeout(900);
    },
  },
];

/**
 * The punctuation a screen has to carry at least once to count as read.
 *
 * A screen that renders no full-width punctuation at all is not a screen this
 * check has looked at — it is a screen whose blocks came back empty, or whose
 * prose moved behind a `pre`, or a navigation that silently landed somewhere
 * else. Green there would mean "nothing to report" and "nothing was read" at the
 * same time, which is the failure mode this repository keeps finding. So the
 * premise is asserted per screen rather than once for the run.
 */
export const PROSE_PUNCTUATION = /[，。、；：！？（）「」]/;

/** Screens whose blocks carry no full-width punctuation, i.e. were not read. */
export const screensWithoutProsePunctuation = (entries) =>
  entries.filter((entry) => !entry.blocks.some((block) => PROSE_PUNCTUATION.test(String(block.text || "")))).map((entry) => entry.screen);

/**
 * The reverse control: the same app with rendered sentences' full-width commas
 * replaced by half-width ones.
 *
 * Without it, a green here could mean "the rules are satisfied" or "the rules
 * never ran" — the two are indistinguishable from the outside, and the second is
 * the failure mode this whole repository keeps finding. So the mutant is built
 * from the real bundle, the same screens are walked, and the run is only allowed
 * to be green if the mutant is *red* and names the sentence that was broken.
 *
 * There is one needle per *kind* of screen, not one for the run: the report
 * screen was the only one mutated while it was the only one walked, and adding
 * three screens without adding a needle would have left them in exactly the
 * state the report screen was in before — checked by a rule nobody had proved
 * could fire there. The settings needle is the one that matters most: the
 * settings page is hand-written prose, which is where a half-width comma
 * actually comes from, while the report's sentence is a constant.
 *
 * Each needle is a sentence the screen renders verbatim, so the mutation lands
 * in text this harness actually reads. `applied !== 1` is a build problem (the
 * sentence was reworded), not a typography finding, and it stops the run rather
 * than passing quietly.
 */
export const NEEDLE = "固定到审查当时的那一版，之后分支再前进也不影响这份报告";
export const MUTANT = "固定到审查当时的那一版,之后分支再前进也不影响这份报告";
export const SETTINGS_NEEDLE = "不写配置、也不需要先保存";
export const SETTINGS_MUTANT = "不写配置,也不需要先保存";

/** Every mutation the reverse control applies, and the screen it must be caught on. */
export const MUTATIONS = [
  { needle: NEEDLE, mutant: MUTANT, screen: "report-read", quote: "「,之」", source: "src/components/ReportView.tsx" },
  { needle: SETTINGS_NEEDLE, mutant: SETTINGS_MUTANT, screen: "settings-top", quote: "「,也」", source: "src/components/SettingsPanel.tsx" },
];

export function weakenedTypographyBundle() {
  fs.rmSync(WEAK_OUT, { recursive: true, force: true });
  fs.cpSync(OUT, WEAK_OUT, { recursive: true });
  const applied = new Map(MUTATIONS.map((mutation) => [mutation.needle, 0]));
  for (const name of fs.readdirSync(path.join(WEAK_OUT, "assets"))) {
    if (!name.endsWith(".js")) continue;
    const file = path.join(WEAK_OUT, "assets", name);
    let source = fs.readFileSync(file, "utf8");
    for (const mutation of MUTATIONS) {
      const parts = source.split(mutation.needle);
      if (parts.length === 1) continue;
      applied.set(mutation.needle, applied.get(mutation.needle) + parts.length - 1);
      source = parts.join(mutation.mutant);
    }
    fs.writeFileSync(file, source);
  }
  const wrong = MUTATIONS.filter((mutation) => applied.get(mutation.needle) !== 1);
  if (wrong.length) {
    console.error(
      "The typography reverse control could not be built: " +
        wrong
          .map(
            (mutation) =>
              `the bundle contains ${applied.get(mutation.needle)} occurrence(s) of ${mutation.source}'s sentence 「${snippet(mutation.needle, 24)}」, but exactly 1 is required`
          )
          .join("; ") +
        ".\n" +
        "Re-read the component and the compiled string in out/assets/*.js; a reverse control that mutates nothing is a green that proves nothing."
    );
    process.exit(2);
  }
  return WEAK_OUT;
}

// ---- the gate ----

const walk = async (page, port, screens) => {
  const found = [];
  for (const screen of screens) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`http://127.0.0.1:${port}/${screen.query}`, { waitUntil: "load" });
    // Cleared first, then set: the screens share one page, so a key a previous
    // screen wrote (`guide-dismissed`) would otherwise leak into the next one and
    // the guide screen would render nothing while still reporting green.
    await page.evaluate((s) => {
      localStorage.clear();
      for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
    }, screen.storage || STORAGE);
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(700);
    await screen.navigate(page);
    await page.waitForTimeout(500);
    const blocks = await page.evaluate(proseBlocks);
    if (!blocks.length) {
      console.error(`FAIL    ${screen.name}：这一屏没有取到任何可见文本，检查因此没有看过它`);
      process.exit(2);
    }
    found.push({ screen: screen.name, blocks, violations: uiTypographyViolations(screen.name, blocks) });
  }
  return found;
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  requireBuilt();
  const { chromium } = await loadPlaywright();
  const DUMP = process.argv.includes("--dump");
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL === "bundled" ? undefined : process.env.PW_CHANNEL || "msedge" });
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.addInitScript(BRIDGE);
  page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 200)));

  const cleanServer = await serve(PORT);
  const clean = await walk(page, PORT, SCREENS);

  if (DUMP) {
    for (const { screen, blocks } of clean) {
      console.log(`\n== ${screen} (${blocks.length} blocks)`);
      for (const block of blocks) console.log(`  [${block.where}] ${snippet(block.text, 200)}`);
    }
  }

  const violations = clean.flatMap((entry) => entry.violations);
  const blocks = clean.reduce((n, entry) => n + entry.blocks.length, 0);
  console.log(
    `界面中文排版：查了 ${clean.length} 屏（${clean.map((e) => e.screen).join("、")}）共 ${blocks} 块可见文本，` +
      `浏览器 ${describeChannel(process.env.PW_CHANNEL)}`
  );
  for (const violation of violations) console.log(`FAIL    ${formatViolation(violation)}`);

  // The premise, per screen: a screen with no full-width punctuation anywhere is
  // a screen this check did not read. Reported before the violations so a
  // navigation that landed on the wrong page cannot pass as clean prose.
  const unread = screensWithoutProsePunctuation(clean);
  if (unread.length) {
    console.log(
      `FAIL    前提：${unread.join("、")} 这一屏没有取到任何含中文标点的文本——` +
        "没有标点可查的屏，绿只说明它没被读到（导航落错页、正文挪进了 pre、或夹具没渲染）"
    );
    await browser.close();
    cleanServer.close();
    process.exit(2);
  }

  // The reverse control runs even when the clean pass is red: a red clean pass
  // with a green mutant would mean the rules fire for some other reason, and
  // that is worth knowing before anyone starts editing prose.
  const weakServer = await serve(PORT + 1, weakenedTypographyBundle());
  const weak = await walk(page, PORT + 1, SCREENS);
  const weakViolations = weak.flatMap((entry) => entry.violations);
  const missed = [];
  for (const mutation of MUTATIONS) {
    const caught = weakViolations.filter(
      (v) => v.rule === "半角标点后接中文" && v.file === mutation.screen && v.detail.includes(mutation.quote)
    );
    if (!caught.length) missed.push(mutation);
    else console.log(`ok      反向控制：${mutation.screen} 上把「${snippet(mutation.needle, 20)}」的全角逗号改成半角，本检查点名了 ${caught.length} 处`);
  }
  if (missed.length) {
    console.log(
      `FAIL    反向控制：${missed.map((m) => `${m.screen}（${m.source}）`).join("、")} 上的全角逗号改成半角之后，本检查没有变红——` +
        "它看不见那一屏的半角标点，所以那一屏的绿不说明任何事"
    );
    await browser.close();
    cleanServer.close();
    weakServer.close();
    process.exit(2);
  }

  await browser.close();
  cleanServer.close();
  weakServer.close();

  if (violations.length) {
    console.log(
      `\n${violations.length} 处问题。规则写在 tools/cjk-typography.mjs 顶部（与文档共用同一份），` +
        "反向控制在 tools/ui-cjk-typography-smoke.mjs。"
    );
    process.exit(1);
  }
  console.log(`ok      ${clean.length} 屏的可见中文都守行首禁则、全角标点与中英分隔`);
}
