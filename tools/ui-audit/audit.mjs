// Visual audit harness. Renders the real UI bundle against a stubbed IPC bridge
// so layout can be inspected without launching Electron or touching the desktop.
// Run with `npm run audit:ui` after `npm run build`.
import fs from "node:fs";
import path from "node:path";
import { SHOTS, BRIDGE, STORAGE, serve } from "./fixtures.mjs";
import { loadPlaywright, CHANNEL, describeChannel, requireBuilt } from "./playwright.mjs";

requireBuilt();
const { chromium } = await loadPlaywright();

const PORT = 5199;

// Enforces the layout spec in `src/components/ui/layout.tsx` instead of trusting
// a code comment: one measure per scrolling page, no horizontal overflow, and no
// element whose content is wider than its own box.
const PROBE = `(() => {
  // Find the page's declared measure: the first element in <main> carrying a
  // max-width cap (PageBody sets it from --page-max / --page-max-narrow).
  // The lower bound is what makes this a *column*: without it the probe latches
  // onto the first capped chip it meets — a 180px badge on the results screen
  // reported a measure of 180, and a check that compares a page against a badge
  // is not checking anything.
  let measure = null;
  let cap = null;
  for (const el of document.querySelectorAll("main *")) {
    const mw = parseFloat(getComputedStyle(el).maxWidth);
    if (Number.isFinite(mw) && mw >= 320 && mw <= 1200) {
      measure = Math.round(el.getBoundingClientRect().width);
      cap = mw;
      break;
    }
  }
  // Forgive content that overflows inside a *real* horizontal scroll container
  // (the code pane). The earlier version only looked at overflow-x, which is a
  // trap: when overflow-y is auto and overflow-x is visible, CSS computes
  // overflow-x to auto as well, so the page's vertical scroller made every
  // element in <main> look horizontally scrollable and silently exempted the
  // whole subtree. Requiring actual horizontal overflow fixes that.
  const scrollable = (el) => {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && n.scrollWidth > n.clientWidth + 1) return true;
    }
    return false;
  };
  // A box that only overflows because of an absolutely/fixed positioned
  // descendant is not clipped — it paints outside on purpose. Corner
  // notification badges are the normal case. Static overflow is the real
  // signal: it means an unbreakable string pushed a sibling out.
  const onlyPositionedOverflow = (el) => {
    const box = el.getBoundingClientRect();
    let staticOverflow = false;
    const walk = (node) => {
      for (const child of node.children) {
        const r = child.getBoundingClientRect();
        if (r.right > box.right + 1 || r.left < box.left - 1) {
          const pos = getComputedStyle(child).position;
          if (pos !== "absolute" && pos !== "fixed") staticOverflow = true;
        }
        if (!staticOverflow) walk(child);
      }
    };
    walk(el);
    return !staticOverflow;
  };
  const clipped = [];
  // Whole document, not just <main>: the first version of this probe scanned
  // main only and therefore never looked at the top bar or the nav rail, which
  // is exactly where a long unbreakable value was silently cut off.
  for (const el of document.querySelectorAll("body *")) {
    // Form controls scroll their own value by design, and datalist never
    // renders — neither is a layout defect.
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "DATALIST") continue;
    // sonner's own icon slot is a deliberate 16px box holding a 20px glyph that
    // it optically centres with -1px margins, so the glyph necessarily
    // overflows its box by a pixel or two. That is the library's design and not
    // ours to correct — but only this one slot is exempt, so a genuine overflow
    // inside a toast (an unbreakable path in an error message, say) still gets
    // reported.
    if (el.matches("[data-sonner-toast] [data-icon]")) continue;
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
      const cs = getComputedStyle(el);
      // text-overflow:ellipsis means overflow is intended, not a defect.
      if (cs.textOverflow === "ellipsis") continue;
      // sr-only clips on purpose: it is the standard way to give an icon-only
      // control an accessible name. className is an SVGAnimatedString on SVG
      // nodes, so normalise before testing.
      const cls = typeof el.className === "string" ? el.className : el.getAttribute("class") || "";
      if (/(^|\s)sr-only(\s|$)/.test(cls)) continue;
      // Horizontal scrolling inside a scroll container is intended (code pane).
      if (scrollable(el)) continue;
      // overflow:visible hides nothing; only complain when the overflow is
      // static, or when a clipping box is genuinely cutting content off.
      const clips = cs.overflowX === "hidden" || cs.overflowX === "clip";
      if (!clips && onlyPositionedOverflow(el)) continue;
      if (clips || cs.overflowX === "visible") {
        clipped.push(el.tagName.toLowerCase() + "." + cls.slice(0, 50) + " " + el.scrollWidth + ">" + el.clientWidth);
      }
    }
  }
  const root = document.getElementById("root");
  return {
    // A page that rendered nothing passes every layout probe: no overflow, no
    // clipping, no measure to compare. This happened for real when the stubbed
    // bridge failed to parse — 20 shots reported "ok" over an empty window.
    mounted: Boolean(root && root.childElementCount) && document.querySelectorAll("nav button").length >= 4,
    mainText: (document.querySelector("main")?.innerText || "").trim().length,
    measure,
    cap,
    docScrollW: document.documentElement.scrollWidth,
    docClientW: document.documentElement.clientWidth,
    docScrollH: document.documentElement.scrollHeight,
    docClientH: document.documentElement.clientHeight,
    clipped: clipped.slice(0, 4),
    // An interpolated optional field prints the word "undefined" into the run
    // header, and an unparseable number prints NaN — both invisible in code
    // review, and both landing in the sentence the user reads to decide whether
    // the run was real.
    leaked: [...(document.body.innerText.match(/\\bundefined\\b|\\bNaN\\b|\\[object Object\\]/g) || [])].filter(
      (v, i, all) => all.indexOf(v) === i
    ),
  };
})()`;

async function shoot(page, name, { width = 1440, height = 900, storage = STORAGE, clearStorage = false, after, expect, query = "" } = {}) {
  await page.setViewportSize({ width, height });
  await page.goto(`http://127.0.0.1:${PORT}/${query}`, { waitUntil: "load" });
  // localStorage survives navigation within an origin, so a shot that needs a
  // *clean* profile has to say so — otherwise it inherits `guide-dismissed`
  // from whichever shot ran first.
  await page.evaluate(
    ({ s, clear }) => {
      if (clear) localStorage.clear();
      for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
    },
    { s: storage, clear: clearStorage }
  );
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(700);
  if (after) await after(page);
  await page.waitForTimeout(500);
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  const p = await page.evaluate(PROBE);
  const problems = [];
  if (!p.mounted) problems.push("the app did not mount — nothing was rendered to measure");
  else if (p.mainText < 10) problems.push(`<main> rendered ${p.mainText} characters, so the screen is effectively blank`);
  if (p.docScrollW > p.docClientW + 1) problems.push("doc-x-overflow");
  if (p.docScrollH > p.docClientH + 1) problems.push("doc-y-overflow");
  if (p.measure !== null && p.cap !== null && p.measure > p.cap + 1) problems.push(`measure ${p.measure}px > cap ${p.cap}px`);
  if (p.clipped.length) problems.push("clipped: " + p.clipped.join(" | "));
  if (p.leaked.length) problems.push("rendered placeholder text: " + p.leaked.join(", "));
  if (expect) problems.push(...(await expect(page)));
  console.log(
    `${problems.length ? "FAIL    " : "ok      "} ${name.padEnd(20)} ${width}x${height}  measure=${p.measure}/${p.cap}` +
      (problems.length ? `  <- ${problems.join("; ")}` : "")
  );
  problems.length ? failed.push(name) : passed.push(name);
  return file;
}

const nav = (label) => async (page) => {
  await page.getByRole("button", { name: label, exact: true }).click();
};

// Scoped to <main>: an unscoped /结果/ also matches the nav-rail button, which
// silently produced an empty results page instead of the findings.
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

const server = await serve(PORT);
fs.mkdirSync(SHOTS, { recursive: true });
const passed = [];
const failed = [];

/**
 * The results screen is the one master-detail view, and its column count is a
 * function of the width it has, not of the viewport. Both halves of that
 * contract are worth asserting, because the failure mode is silent: the panes
 * still "fit" (nothing overflows) while the code — the thing the user opened
 * the screen for — is cut off mid-line.
 *
 * Measured on the built UI before this check existed: the code column was 337px
 * at the 1000px window floor and 568px at 1440px, while the widest line of the
 * fixture needs 561px of text plus the gutter. So the numbers below are the
 * observed requirement, not a preference.
 */
const CODE_NEEDS = 620;

function resultsGrid(page) {
  return page.evaluate((need) => {
    const grid = [...document.querySelectorAll("main .grid")].find((g) => (g.getAttribute("class") || "").includes("grid-cols-[minmax(240px"));
    if (!grid) return { error: "no results grid" };
    const vis = [...grid.children].filter((el) => getComputedStyle(el).display !== "none");
    const last = vis[vis.length - 1];
    const code = last.querySelector("pre");
    // The widest code line, so the assertion is about real content rather than
    // a hard-coded pixel count.
    let widest = 0;
    for (const s of code ? code.querySelectorAll("div > span:nth-child(2)") : []) widest = Math.max(widest, s.scrollWidth);
    return { cols: vis.length, widths: vis.map((el) => Math.round(el.getBoundingClientRect().width)), codeW: code ? code.clientWidth : 0, widest, need };
  }, CODE_NEEDS);
}

/**
 * The findings list is the navigation surface for the whole screen, and it was
 * rendering the CLI's light markdown raw: rows read `**密码校验用了普通的字符串比较**`
 * while the pane beside them rendered the same text bold. Every row showed
 * punctuation that only exists to be consumed by a renderer. The detail pane is
 * allowed to keep inline code styled; the list must not show the markers.
 */
const expectCleanSummaries = async (page) => {
  const out = [];
  const rows = await page.locator("main").evaluate(() => {
    // The master list is the first column of the results grid: the buttons that
    // carry a severity stripe.
    const list = document.querySelector("main .grid > div:first-child");
    if (!list) return null;
    return [...list.querySelectorAll("button")].map((b) => b.innerText.replace(/\s+/g, " ").trim());
  });
  if (!rows) return ["the findings list column was not found"];
  if (rows.length < 3) out.push(`only ${rows.length} finding rows rendered`);
  for (const r of rows) {
    if (r.includes("**")) out.push(`a finding summary shows literal bold markers: "${r.slice(0, 60)}"`);
    if (r.includes("`")) out.push(`a finding summary shows literal backticks: "${r.slice(0, 60)}"`);
  }
  return out;
};

/**
 * The screen a user watches for minutes. The bridge used to stub `onProgress`
 * with a no-op, so the audit only ever saw three zeros over an empty window and
 * reported it as passing — while the real complaint against this screen is "I
 * thought it had hung".
 *
 * The data half (a scope count that actually arrived) was fixed. The density
 * half was not: it measured the gap *below* the last row, and the feed was
 * bottom-anchored, so that gap was always ~0 while a 490px hole sat *above* the
 * first row — a screen that is 70% blank in the middle of a run, which is the
 * exact thing this screen exists to prevent. Both edges are asserted now.
 */
const expectRunningFeed = async (page) => {
  const seen = await page.evaluate(() => {
    const main = document.querySelector("main");
    const list = main.querySelector("ol");
    const rows = list ? [...list.querySelectorAll("li")] : [];
    const region = list?.parentElement;
    const panel = region?.parentElement;
    const rb = region?.getBoundingClientRect();
    const fb = rows[0]?.getBoundingClientRect();
    const pb = panel?.getBoundingClientRect();
    const mb = main.getBoundingClientRect();
    return {
      rows: rows.length,
      text: main.innerText.replace(/\s+/g, " "),
      cells: [...main.querySelectorAll(".tnum")].map((e) => e.textContent.trim()),
      gapAbove: rb && fb ? Math.round(fb.top - rb.top) : -1,
      share: pb ? Math.round((pb.height / mb.height) * 100) : -1,
      bordered: panel ? parseFloat(getComputedStyle(panel).borderTopWidth) > 0 : false,
    };
  });
  const out = [];
  if (seen.rows < 4) out.push(`the activity feed showed only ${seen.rows} rows — a run with nothing on screen reads as a hung app`);
  if (seen.cells.includes("—")) out.push(`a run counter never left "—": ${seen.cells.join(", ")}`);
  if (seen.cells.includes("…")) out.push(`a run counter never left its placeholder: ${seen.cells.join(", ")}`);
  if (!/进入审查/.test(seen.text)) out.push("the run screen lost its scope counter");
  if (seen.gapAbove > 40) out.push(`${seen.gapAbove}px of empty window above the first activity row — the run screen reads as stuck`);
  if (seen.share < 55) out.push(`the activity panel is only ${seen.share}% of the screen, so it is not the hero of a running review`);
  if (!seen.bordered) out.push("the activity region has no frame, so unfilled space inside it reads as broken layout");
  return out;
};

/**
 * A session carries its own scope, and the review form on screen has nothing to
 * do with it. The code pane used to resolve its ref from the form, so opening a
 * history session showed the working tree beside a 历史会话 badge — the code next
 * to a finding could be a different file than the one that was reviewed.
 */
const expectCodeFollowsSession = async (page) => {
  const text = await page.locator("main").innerText();
  return /来自 feat\/tenant-rate-limit/.test(text)
    ? []
    : ["the code pane is not read from the session's own ref, so it is showing the working tree"];
};

/** Wide: three columns, and the code column clears the widest line. */
const expectThreePanes = async (page) => {  const g = await resultsGrid(page);
  if (g.error) return [g.error];
  const out = [];
  if (g.cols !== 3) out.push(`expected 3 panes at this width, got ${g.cols} (${g.widths.join("/")})`);
  if (g.codeW < g.need) out.push(`code pane ${g.codeW}px < ${g.need}px needed by a ${g.widest}px line`);
  return out;
};

/** Narrow: two columns, with the code stacked in the detail column, still full width. */
const expectCodeStacked = async (page) => {
  const g = await resultsGrid(page);
  if (g.error) return [g.error];
  const out = [];
  if (g.cols !== 2) out.push(`expected the code to fold into the detail column, got ${g.cols} panes (${g.widths.join("/")})`);
  if (!g.codeW) out.push("the code viewer is not rendered at all in the narrow layout");
  else if (g.codeW < g.widest) out.push(`stacked code is ${g.codeW}px wide but a line needs ${g.widest}px`);
  return out;
};

/**
 * 开始审查 is the page's only primary action, and it used to sit underneath
 * every knob the form owns: at the 1000x660 floor it was not on screen at all,
 * so the smallest legal window showed a wall of configuration with no way to
 * start a review. It is pinned now, and this is what keeps it pinned.
 */
const expectRunActionVisible = async (page) => {
  const btn = page.getByRole("button", { name: /开始审查|续跑未完成部分/ });
  if ((await btn.count()) === 0) return ["the run action is missing from the review page"];
  const box = await btn.first().boundingBox();
  const vp = page.viewportSize();
  if (!box || !vp) return ["the run action could not be measured"];
  if (box.y + box.height > vp.height + 1)
    return [`the run action sits ${Math.round(box.y + box.height - vp.height)}px below the fold in a ${vp.height}px window`];
  return [];
};

/**
 * The preview is a core flow, and it had no assertion at all — which is how it
 * came to be screenshotted for months against a fixture whose normal payload had
 * no file list at all (`files: undefined`). Every shot showed "进入审查 0 / 共 8"
 * and the "nothing entered the review" explanation, which looks like a perfectly
 * plausible state. Assert the contents, not just the layout.
 */
const expectPreviewListed = async (page) => {
  const out = [];
  const text = await page.locator("main").innerText();
  if (!/进入审查 5 \/ 共 8 个文件/.test(text) && !/共 8 个改动文件/.test(text))
    out.push("the file region does not report the scope's size");
  if (!/5 个文件进入审查/.test(text)) out.push("the pinned bar no longer states the file count");
  if (!/以下 3 个不进入审查/.test(text)) out.push("the excluded files are not listed");
  const rows = await page.locator("main").getByText(/· [+-]\d+ \/ -\d+/).count();
  if (rows < 5) out.push(`only ${rows} reviewable file rows rendered, expected 5`);
  return out;
};

/**
 * The launcher used to end in a band of bare canvas: its content was top-aligned
 * in a scroll region, so on any window taller than the form the page read as
 * half-finished — the same defect the running screen had. What has to hold is
 * that the file region reaches the action bar, whatever the window height.
 */
const expectNoDeadBand = async (page) => {
  const m = await page.evaluate(() => {
    const h2 = [...document.querySelectorAll("main h2")].find((h) => h.textContent === "进入审查的文件");
    const section = h2?.closest("section");
    const btn = [...document.querySelectorAll("main button")].find((b) => /开始审查/.test(b.textContent || ""));
    const bar = btn?.parentElement;
    const mb = document.querySelector("main")?.getBoundingClientRect();
    if (!section || !bar || !mb) return null;
    const bb = bar.getBoundingClientRect();
    return {
      // The bar is pinned: anything between it and the bottom of the window
      // means the column stopped growing and the page ends in bare canvas.
      belowBar: Math.round(mb.bottom - bb.bottom),
      // And the file region must be what absorbs the slack, not the void.
      aboveBar: Math.round(bb.top - section.getBoundingClientRect().bottom),
    };
  });
  if (m === null) return ["the launcher lost either its file region or its run bar"];
  const out = [];
  if (m.belowBar > 4) out.push(`${m.belowBar}px of empty canvas below the run bar, so the page ends in a void`);
  if (m.aboveBar > 4) out.push(`${m.aboveBar}px of empty canvas between the file region and the run bar`);
  return out;
};

const browser = await chromium.launch({ channel: CHANNEL });
const page = await browser.newPage({ deviceScaleFactor: 1 });
await page.addInitScript(BRIDGE);
page.on("console", (m) => {
  if (m.type() === "error") console.log("  [console.error]", m.text().slice(0, 220));
});
page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 220)));

await shoot(page, "01-review-wide", { after: nav("审查"), expect: expectRunActionVisible });
await shoot(page, "02-review-no-guide", { storage: { "last-repo": "" } });
await shoot(page, "03-review-scan", {
  after: async (page) => {
    await page.getByRole("button", { name: /整库/ }).click();
    await page.waitForTimeout(300);
  },
});
await shoot(page, "04-review-tuning", {
  after: async (page) => {
    await page.getByRole("button", { name: /调整这次审查的参数/ }).click();
    await page.waitForTimeout(300);
  },
});
await shoot(page, "05-results-empty", {
  after: nav("结果"),
  expect: async (page) => {
    const out = [];
    // An empty state has to offer the action that ends it. With 去历史 as the
    // only button, a user who has never run a review is sent to look at results
    // that do not exist.
    if (!(await page.getByRole("button", { name: /去审查页/ }).count()))
      out.push("the empty results state does not offer to start a review");
    return out;
  },
});
await shoot(page, "06-history", {
  after: nav("历史"),
  // A session written before the run-manifest format has no recorded terminal
  // state. The list used to call every one of them 完成 — an affirmative claim
  // about an outcome nobody recorded — and on a real machine it labelled a run
  // whose 27 of 27 files had failed as complete, in green. The fixture now
  // carries that exact session, so the honest label is asserted rather than
  // left to the default.
  expect: async (page) => {
    const out = [];
    // innerText puts each flex child on its own line, so read the row's
    // textContent: span "0/27" -> stats cluster -> the row.
    const rowText = await page.evaluate(() => {
      const span = [...document.querySelectorAll("main span")].find((s) => s.textContent.trim() === "0/27");
      return span ? span.parentElement.parentElement.textContent : null;
    });
    if (!rowText) return ["the legacy session row (0/27) is missing from the fixture"];
    if (/完成/.test(rowText)) out.push(`a legacy session with 27/27 failures is labelled 完成: "${rowText.slice(0, 90)}"`);
    if (!/失败/.test(rowText)) out.push(`the legacy session's failure is not surfaced at all: "${rowText.slice(0, 90)}"`);
    return out;
  },
});
await shoot(page, "07-settings-top", { after: nav("设置") });
await shoot(page, "08-settings-bottom", {
  after: async (page) => {
    await nav("设置")(page);
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const el = [...document.querySelectorAll("main *")].find(
        (n) => n.scrollHeight > n.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(n).overflowY)
      );
      if (el) el.scrollTop = el.scrollHeight;
    });
  },
});
await shoot(page, "09-results-findings", {
  fullWidth: true,
  after: async (page) => {
    await openFindings(page);
    await selectFirstFinding(page);
  },
  expect: async (page) => [
    ...(await expectThreePanes(page)),
    ...(await expectCleanSummaries(page)),
    ...(await expectCodeFollowsSession(page)),
  ],
});
await shoot(page, "10-review-narrow", { width: 1100, height: 780, expect: expectRunActionVisible });
await shoot(page, "11-settings-narrow", { width: 1100, height: 780, after: nav("设置") });
await shoot(page, "12-review-xwide", { width: 1920, height: 1080, expect: expectRunActionVisible });

// The file list now computes itself as soon as the scope settles, so this shot
// is the automatic path rather than a button press. The preview used to render
// only inside a sidebar that existed above 1536px, which is what made the state
// invisible on most screens.
await shoot(page, "13-review-preview", {
  width: 1440,
  height: 900,
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(1400);
  },
  expect: expectPreviewListed,
});

// The launcher at the window minimum, where the guide card is gone and the form
// is two lines: this is the shape that used to end in a band of bare canvas.
await shoot(page, "46-review-launcher", {
  width: 1440,
  height: 900,
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(1400);
  },
  expect: async (page) => [...(await expectNoDeadBand(page)), ...(await expectRunActionVisible(page))],
});
await shoot(page, "47-review-tuning-open", {
  width: 1440,
  height: 900,
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(1400);
    await page.getByRole("button", { name: /调整这次审查的参数/ }).click();
    await page.waitForTimeout(400);
  },
  expect: async (page) => [...(await expectNoDeadBand(page)), ...(await expectRunActionVisible(page))],
});

// 1000x660 is the window minimum declared in main.js — the tightest the app
// can ever get. The three-column grid cannot be satisfied down here (the
// minimums alone come to ~1180px), so the code folds into the detail column
// rather than being clipped to a third of a line.
await shoot(page, "14-min-review", { width: 1000, height: 660, after: nav("审查"), expect: expectRunActionVisible });
await shoot(page, "15-min-settings", { width: 1000, height: 660, after: nav("设置") });
await shoot(page, "16-min-results", {
  fullWidth: true,
  width: 1000,
  height: 660,
  after: async (page) => {
    await openFindings(page);
    await selectFirstFinding(page);
  },
  expect: expectCodeStacked,
});
await shoot(page, "17-min-history", { width: 1000, height: 660, after: nav("历史") });

// The running state of the results page, and a light-theme pass: the type ramp
// touched nearly every text colour, so both themes need eyes on them.
await shoot(page, "18-results-running", {
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /开始审查/ }).click();
    await page.waitForTimeout(1400);
  },
  expect: expectRunningFeed,
});
await shoot(page, "19-light-review", { storage: { ...STORAGE, "ocr-theme-pref": "light" }, after: nav("审查") });
await shoot(page, "20-light-settings", {
  storage: { ...STORAGE, "ocr-theme-pref": "light" },
  after: nav("设置"),
});
await shoot(page, "21-light-findings", {
  fullWidth: true,
  storage: { ...STORAGE, "ocr-theme-pref": "light" },
  after: async (page) => {
    await openFindings(page);
    await selectFirstFinding(page);
  },
  expect: expectThreePanes,
});

// Regression guard for silent history truncation: the panel used to ask the CLI
// for 50 sessions and then print "50 条" as if that were the total. Each row
// owns exactly one 「结果」 button, so that is what we count.
await shoot(page, "22-history-many", {
  query: "?sessions=many",
  after: nav("历史"),
  expect: async (page) => {
    const out = [];
    const main = page.locator("main");
    const rows = () => main.getByRole("button", { name: "结果", exact: true }).count();
    const more = main.getByRole("button", { name: /显示更多/ });

    const text = await main.innerText();
    if (!/65 条/.test(text)) out.push(`count not honest (want 65 条): ${text.split("\n").find((l) => l.includes("条")) || "?"}`);

    const first = await rows();
    if (first !== 50) out.push(`first page should mount 50 rows, got ${first}`);
    if (!(await more.count())) {
      out.push("no 显示更多 affordance for the remaining sessions");
      return out;
    }
    const label = (await more.first().innerText()).trim();
    if (!/还有 15 条/.test(label)) out.push(`剩余条数不对: "${label}"`);

    await more.first().click();
    await page.waitForTimeout(300);
    const after = await rows();
    if (after !== 65) out.push(`after 显示更多 expected 65 rows, got ${after}`);
    if (await more.count()) out.push("显示更多 still visible after everything is shown");
    return out;
  },
});

// Pathological data: unbreakable 100+ char tokens in every slot a real payload
// can put them. Real vendor errors, org-prefixed model ids and deep paths all
// produce strings with no break opportunity, and a flex/grid child missing
// `min-w-0` will push its container wide instead of shrinking.
for (const [name, view] of [
  ["23-stress-review", "审查"],
  ["24-stress-settings", "设置"],
  ["25-stress-history", "历史"],
]) {
  await shoot(page, name, { query: "?stress=1", after: nav(view) });
}

// The results view holds the most arbitrary text of any screen: file paths,
// finding bodies, and code. Stress it too, and in the minimum window where
// the three panes have the least room.
await shoot(page, "26-stress-findings", {
  query: "?stress=1",
  after: async (page) => {
    await openFindings(page);
    await selectFirstFinding(page);
  },
});
await shoot(page, "27-stress-findings-min", {
  width: 1000,
  height: 660,
  query: "?stress=1",
  after: async (page) => {
    await openFindings(page);
    await selectFirstFinding(page);
  },
  expect: expectCodeStacked,
});
await shoot(page, "28-stress-preview", {
  query: "?stress=1",
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(1400);
  },
  expect: expectPreviewListed,
});

// The first-run guide is the app's only onboarding surface, and every other
// shot in this file dismissed it (STORAGE carries `guide-dismissed: 1`), so it
// had no visual coverage at all — a regression in it would have shipped
// silently. Both halves matter: with a repo already chosen, and cold.
for (const [name, storage] of [
  ["29-guide-first-run", { "last-repo": "/home/x/work/payments-api" }],
  ["30-guide-cold", {}],
]) {
  await shoot(page, name, {
    storage,
    clearStorage: true,
    after: nav("审查"),
    expect: async (page) => {
      const out = [];
      const card = page.locator("main").getByRole("heading", { name: "三步开始第一次审查" });
      if (!(await card.count())) return ["the guide card is not rendered for a user who has not dismissed it"];
      const text = await page.locator("main").innerText();
      for (const step of ["选择要审查的仓库目录", "配置模型服务与 API Key", "点「开始审查」，结果在「结果」页"])
        if (!text.includes(step)) out.push(`guide step missing: ${step}`);
      if (!text.includes("不再提示")) out.push("no way to dismiss the guide");
      if (name === "30-guide-cold") {
        // With nothing to review, the pinned action must not pretend otherwise —
        // and disabling it is only honest if the bar says what is missing.
        const btn = page.getByRole("button", { name: /开始审查/ });
        if (!(await btn.count())) out.push("the pinned run action disappeared on a cold start");
        else if (!(await btn.first().isDisabled())) out.push("a review with no repository is still offered as clickable");
        if (!/仓库栏/.test(text)) out.push("nothing on a cold start says what is missing");
      }
      return out;
    },
  });
}

// The error toast is this app's only failure surface — CLI errors, rejected
// refs, "cannot open <path>" — and it had no coverage at all: every fixture
// succeeded at everything, so it was never rendered. Two things are asserted
// rather than eyeballed, because both were wrong before:
//   * `body` sets `user-select: none`, so the error text could not be copied;
//   * the toaster was pinned to `theme="system"` while the app had its own
//     preference, so a light-theme app on a dark desktop styled its errors dark.
// The shot deliberately runs the app in light theme with the OS emulated dark,
// which is the only combination where the two can disagree.
await page.emulateMedia({ colorScheme: "dark" });
await shoot(page, "31-toast-error", {
  storage: { ...STORAGE, "ocr-theme-pref": "light" },
  query: "?toast=1",
  after: async (page) => {
    await nav("历史")(page);
    await page.waitForTimeout(900);
  },
  expect: async (page) => {
    const out = [];
    const info = await page.evaluate(() => {
      const layer = document.querySelector("[data-sonner-theme]");
      const toast = document.querySelector("[data-sonner-toast]");
      const desc = document.querySelector("[data-sonner-toast] [data-description]");
      return {
        appTheme: document.documentElement.dataset.theme,
        toastTheme: layer?.getAttribute("data-sonner-theme") || null,
        userSelect: toast ? getComputedStyle(toast).userSelect : null,
        // sonner writes `--width: 356px` inline, so this also guards the
        // `!important` override that widens it for path-carrying errors. It is
        // the *toast* that must be wide: sizing only the container leaves the
        // toast at 356px and drifts it off centre, which is what the first
        // attempt at this fix did.
        width: toast ? Math.round(toast.getBoundingClientRect().width) : 0,
        offsetFromCentre: toast
          ? Math.round(toast.getBoundingClientRect().x + toast.getBoundingClientRect().width / 2 - window.innerWidth / 2)
          : 0,
        whiteSpace: desc ? getComputedStyle(desc).whiteSpace : null,
        // innerText reflects rendered line breaks, so this measures what the
        // user actually sees rather than what the string contains.
        renderedLines: desc ? desc.innerText.split("\n").length : 0,
        text: toast ? toast.innerText : "",
      };
    });
    if (!info.toastTheme) return ["no toast was rendered, so the error surface is untested"];
    if (info.toastTheme !== info.appTheme)
      out.push(`toast theme ${info.toastTheme} does not follow the app's ${info.appTheme}`);
    if (info.userSelect !== "text")
      out.push(`toast text is not selectable (user-select: ${info.userSelect}), so the error cannot be copied`);
    if (info.width < 460)
      out.push(`toast is ${info.width}px wide, back to wrapping absolute paths (the override stopped applying?)`);
    if (Math.abs(info.offsetFromCentre) > 2)
      out.push(`toast is ${info.offsetFromCentre}px off centre — the container was widened without the toast`);
    if (!/permission denied/.test(info.text)) out.push(`the error body did not reach the toast: ${info.text.slice(0, 60)}`);
    // The CLI's errors are multi-line on purpose; collapsing them into one
    // paragraph is what made them unreadable.
    if (info.renderedLines < 3)
      out.push(`the multi-line error was collapsed into ${info.renderedLines} line(s) (white-space: ${info.whiteSpace})`);
    return out;
  },
});
// Not `null`: that releases the override to the browser's own preference, which
// left every shot after this one rendering dark while the light-theme pass at
// 19–21 believed it had covered the other half.
await page.emulateMedia({ colorScheme: "light" });

// A scope that legitimately contains nothing to review. Two behaviours matter
// and neither is visible in a screenshot of the happy path:
//   * the preview count must not outlive an edit to the scope — it used to
//     survive switching from 工作区改动 to 分支对比, printing the old count as
//     if it were current;
//   * pressing 开始审查 with nothing to review must say so, not spend a run.
await shoot(page, "32-review-empty-scope", {
  query: "?empty=1",
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(1400);
  },
  expect: async (page) => {
    const out = [];
    // The bar carries the numbers even when there is nothing to review — the
    // empty scope is exactly when "8 files were found, none entered" is the
    // information that tells the user what to change.
    const bar = await page.locator("main").innerText();
    if (!/当前范围 8 个文件，没有一个进入审查/.test(bar))
      out.push(`the pinned bar does not report an empty scope with its totals: "${bar.split("\n").find((l) => l.includes("没有一个")) || "?"}"`);

    // The file region has to explain *why* nothing entered, not just that.
    const text = await page.locator("main").innerText();
    if (!/共 8 个改动文件/.test(text)) out.push("the empty preview did not report 0 of 8");
    if (!/没有文件进入审查。工作区没有改动时属正常/.test(text)) out.push("no explanation for the empty scope");

    // Change the scope: the stale count must go, not linger as if current. The
    // list recomputes itself, so the window to observe that is the debounce.
    // The header's own "共 N 个改动文件" is the proxy — the section itself stays
    // mounted through a recompute, so its title proves nothing.
    const counted = () => page.locator("main").getByText(/个改动文件/).count();
    await page.getByRole("button", { name: /分支对比/ }).click();
    await page.waitForTimeout(250);
    if ((await counted()) !== 0) out.push("the preview survived a change of scope, so its count is now stale");
    await page.waitForTimeout(1400);
    if ((await counted()) === 0) out.push("the preview never came back after the scope changed — the list is manual again");

    // And pressing run with nothing to review must explain, not start.
    await page.getByRole("button", { name: /工作区改动/ }).click();
    await page.waitForTimeout(1400);
    await page.getByRole("button", { name: /开始审查/ }).click();
    await page.waitForTimeout(900);
    const toastText = await page.locator("[data-sonner-toast]").innerText().catch(() => "");
    if (!/没有文件可审查/.test(toastText)) out.push(`running an empty scope was not explained (toast: "${toastText.slice(0, 60)}")`);
    if (!(await page.getByRole("button", { name: /开始审查/ }).count()))
      out.push("the run started anyway and left the form page");
    return out;
  },
});

// The update banner and its status line. Every fixture reported `idle`, and the
// banner only renders for downloading / ready / manual, so none of these states
// had ever been on screen — which is how the dismiss button came to be labelled
// 稍后 while actually writing the version to settings and skipping it for good,
// and how the status line came to append "（该版本已忽略）" to "还没检查过更新".
// `?update=<phase>` renders each one.
await shoot(page, "33-update-ready", {
  storage: { ...STORAGE, "ocr-theme-pref": "dark" },
  query: "?update=ready",
  after: nav("审查"),
  expect: async (page) => {
    const out = [];
    const text = await page.locator("body").innerText();
    if (!/v0\.2\.0 已下载完成，重启后生效/.test(text)) out.push("the ready banner does not name the version");
    if (!/重启并更新/.test(text)) out.push("no 重启并更新 action");
    // The label must match the effect: the choice is persisted, so the release
    // is skipped rather than deferred.
    if (!/忽略此版本/.test(text)) out.push("the dismiss action does not say what it actually does");
    if (/稍后/.test(text)) out.push("the dismiss action still reads 稍后, which is not what it does");

    // The banner is the only place a `size="sm"` primary button sits on a
    // tinted surface, and that is where the variant colour turned out to be
    // missing: tailwind-merge filed `text-body` (a font size) and
    // `text-accent-ink` (a colour) in the same group, and since `size` is
    // emitted after `variant`, every small button inherited its container's
    // colour instead. Compare against the token rather than a literal, so this
    // keeps meaning something if the palette moves.
    const buttons = await page.evaluate(() => {
      const strip = document.querySelector("main").previousElementSibling;
      const root = getComputedStyle(document.documentElement);
      const norm = (v) => {
        const el = document.createElement("span");
        el.style.color = v.trim();
        document.body.appendChild(el);
        const out = getComputedStyle(el).color;
        el.remove();
        return out;
      };
      const find = (label) => [...strip.querySelectorAll("button")].find((b) => b.textContent.includes(label));
      const primary = find("重启并更新");
      const ghost = find("忽略此版本");
      return {
        primaryColor: getComputedStyle(primary).color,
        ghostColor: getComputedStyle(ghost).color,
        wantPrimary: norm(root.getPropertyValue("--accent-ink")),
        wantGhost: norm(root.getPropertyValue("--muted")),
        inherited: getComputedStyle(strip).color,
      };
    });
    if (buttons.primaryColor !== buttons.wantPrimary)
      out.push(
        `the primary button does not use --accent-ink: got ${buttons.primaryColor}, want ${buttons.wantPrimary}` +
          (buttons.primaryColor === buttons.inherited ? " (it inherited the banner's colour)" : "")
      );
    if (buttons.ghostColor !== buttons.wantGhost)
      out.push(`the ghost button does not use --muted: got ${buttons.ghostColor}, want ${buttons.wantGhost}`);
    return out;
  },
});

await shoot(page, "34-update-downloading", {
  storage: { ...STORAGE, "ocr-theme-pref": "dark" },
  query: "?update=downloading",
  after: nav("审查"),
  expect: async (page) => {
    const out = [];
    const text = await page.locator("body").innerText();
    if (!/正在下载 v0\.2\.0… 42%（38 \/ 90 MB）/.test(text))
      out.push(`the progress banner does not report percent and size: "${text.slice(0, 80)}"`);
    return out;
  },
});

// A portable build has no version to name — the error path sets a message and
// no version — so this is the shape the banner has to cope with.
await shoot(page, "35-update-manual", {
  storage: { ...STORAGE, "ocr-theme-pref": "dark" },
  query: "?update=manual",
  after: nav("审查"),
  expect: async (page) => {
    const out = [];
    const text = await page.locator("body").innerText();
    if (!/这个版本无法自动更新/.test(text)) out.push("the portable build was not told it cannot auto-update");
    if (!/打开下载页/.test(text)) out.push("no 打开下载页 escape hatch");
    return out;
  },
});

// The state a user reaches by dismissing a release, at the window floor. It was
// unreachable before the ignore path was fixed, so its copy was never read.
await shoot(page, "36-update-suppressed", {
  storage: { ...STORAGE, "ocr-theme-pref": "dark" },
  width: 1000,
  height: 660,
  query: "?update=suppressed",
  after: async (page) => {
    await nav("设置")(page);
    await page.waitForTimeout(400);
    const line = page.getByText(/已忽略 v0\.2\.0/);
    if (await line.count()) await line.first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
  },
  expect: async (page) => {
    const out = [];
    const text = await page.locator("main").innerText();
    if (!/已忽略 v0\.2\.0/.test(text)) out.push("the suppressed state has no sentence of its own");
    if (/还没检查过更新/.test(text)) out.push("an ignored version still claims 还没检查过更新");
    if ((await page.locator("body").innerText()).includes("已下载完成"))
      out.push("a suppressed release is still being announced in the banner");
    return out;
  },
});

// A review that finds nothing is still a finished review, and it used to render
// the same sentence as a filter that had hidden everything — which reads as
// "the tool broke", not "your code is clean".
await shoot(page, "37-results-clean", {
  query: "?clean=1",
  after: openFindings,
  expect: async (page) => {
    const text = await page.locator("main").innerText();
    const out = [];
    if (!/这次审查没有提出问题/.test(text)) out.push("a clean review does not say so");
    if (/没有匹配当前筛选/.test(text)) out.push("a clean review blames the filters");
    const counted = [...text.matchAll(/(\d+) 条评论/g)].map((m) => m[1]);
    if (counted.some((n) => n !== "0")) out.push(`the header still counts comments this review does not have: ${counted.join(",")}`);
    if (/在左侧选择一条评论/.test(text)) out.push("an empty pane is telling the reader to select from a list that is empty");
    return out;
  },
});

// A finished review used to land on two empty panes ("在左侧选择一条评论"), so
// the highest-value content needed a click before it existed on screen. Opening
// the most severe finding is asserted here rather than assumed: the fixture's
// first row is a `medium`, and the row that should be selected for free is the
// `critical` one further down the list.
await shoot(page, "38-results-lands-on-worst", {
  after: openFindings,
  expect: async (page) => {
    const text = await page.locator("main").innerText();
    const out = [];
    if (!/密码校验用了普通的字符串比较/.test(text)) out.push("the run did not land on the most severe finding");
    if (/在左侧选择一条评论/.test(text)) out.push("the detail pane is still empty after a result arrives");
    if (/选中评论后在这里显示对应代码位置/.test(text)) out.push("the code pane is still empty after a result arrives");
    return out;
  },
});

// 续跑 must resume *that session's* scope. The row patches the review form and
// then starts the run — but a React state update is not synchronous, so the spec
// handed to the CLI is built from whatever the form was a moment earlier. This
// asserts the spec itself rather than the form, because the spec is what runs.
await shoot(page, "39-history-resume-scope", {
  after: async (page) => {
    await nav("历史")(page);
    await page.waitForTimeout(700);
    await page.locator("main").getByRole("button", { name: "续跑" }).first().click();
    await page.waitForTimeout(500);
  },
  expect: async (page) => {
    const spec = await page.evaluate(() => window.__lastRunSpec || null);
    if (!spec) return ["续跑 never reached the CLI"];
    const out = [];
    if (spec.resume !== "9f2c41d0a7b34e58b1c6d7e8f9a0b1c2") out.push(`续跑 did not carry the session id (got ${JSON.stringify(spec.resume)})`);
    if (spec.mode !== "range") out.push(`续跑 started a ${spec.mode} run instead of the session's range run`);
    if (spec.from !== "main" || spec.to !== "feat/tenant-rate-limit")
      out.push(`续跑 lost the session's scope (got ${JSON.stringify([spec.from, spec.to])})`);
    return out;
  },
});

// Stopping a run is an action the app itself offers, so it must not come back as
// a crash. `?cancel=1` answers the cancel with the same non-zero exit a killed
// child produces — which is what made 已取消 render as 审查失败.
//
// The pair also pins the resume promise: a workspace session is `aborted` on disk
// and the CLI refuses to resume it (`resume requires --from/--to or --commit`),
// so offering 续跑 there is a guaranteed failure — while a range session must
// still offer it.
const startAndCancel = async (page, mode) => {
  await nav("审查")(page);
  await page.waitForTimeout(300);
  if (mode) {
    await page.getByRole("button", { name: mode }).click();
    await page.waitForTimeout(1400);
  }
  await page.getByRole("button", { name: /开始审查/ }).click();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "取消", exact: true }).first().click();
  await page.waitForTimeout(1400);
};

await shoot(page, "40-run-cancelled", {
  query: "?cancel=1",
  after: (page) => startAndCancel(page),
  expect: async (page) => {
    const body = await page.locator("body").innerText();
    const out = [];
    if (/审查失败/.test(body)) out.push("a user-initiated cancel is reported as 审查失败");
    if (!/已取消/.test(body)) out.push("the cancel is not acknowledged anywhere on screen");
    if ((await page.getByRole("button", { name: /续跑未完成部分/ }).count()) > 0)
      out.push("a cancelled workspace run offers 续跑, which the CLI would reject");
    if (!/不支持续跑/.test(body)) out.push("the cancel does not say this session cannot be continued");
    return out;
  },
});
await shoot(page, "41-cancel-resumable", {
  query: "?cancel=1",
  after: (page) => startAndCancel(page, "分支对比"),
  expect: async (page) => {
    const out = [];
    if ((await page.getByRole("button", { name: /续跑未完成部分/ }).count()) === 0)
      out.push("a cancelled range run stopped offering the resume it does support");
    return out;
  },
});

// The reading view is the answer to "the results can't be looked at on their
// own": the triage screen shows one finding at a time behind a click each, so a
// review of any size cannot be read end to end or searched. What has to hold is
// that it is the *whole* review (not the current filter), laid out per file,
// with the CLI's markdown rendered rather than shown.
const openReport = async (page) => {
  await openFindings(page);
  await page.getByRole("button", { name: "阅读", exact: true }).click();
  await page.waitForTimeout(500);
};

const expectReadableDocument = async (page) => {
  const doc = await page.evaluate(() => {
    const main = document.querySelector("main");
    const files = [...main.querySelectorAll("section")]
      .filter((s) => s.querySelector("article"))
      .map((s) => ({
        path: s.querySelector("span")?.textContent || "",
        findings: s.querySelectorAll("article").length,
      }));
    return {
      files,
      findings: main.querySelectorAll("article").length,
      text: main.innerText,
      // The document must scroll on its own; a clipped reading surface is the
      // same failure the code pane used to have.
      scrolls: [...main.querySelectorAll("div")].some((d) => d.scrollHeight > d.clientHeight + 8 && /auto|scroll/.test(getComputedStyle(d).overflowY)),
    };
  });
  const out = [];
  if (doc.findings !== 5) out.push(`the report shows ${doc.findings} findings, but this review has 5 — reading view must carry the whole run`);
  if (doc.files.length !== 3) out.push(`expected the findings grouped into 3 files, got ${doc.files.length}`);
  if (doc.files[0] && !/login\.go/.test(doc.files[0].path))
    out.push(`the report does not lead with the worst file: ${doc.files.map((f) => f.path).join(", ")}`);
  if (/\*\*|`/.test(doc.text)) out.push("the report shows literal markdown markers instead of rendering them");
  // `ocr session comments` returns findings only, so the CLI's project summary
  // exists for a live run and not for a session reopened from history. Assert
  // the part that must survive both paths: the run identity line.
  if (!/条评论/.test(doc.text)) out.push("the report lost the run's own header, so it cannot be read outside the app");
  if (!doc.scrolls) out.push("the report has no scroller, so a long review cannot be read to the end");
  return out;
};

await shoot(page, "42-report-read", { after: openReport, expect: expectReadableDocument });
await shoot(page, "43-report-min", { width: 1000, height: 660, after: openReport, expect: expectReadableDocument });
await shoot(page, "44-report-light", {
  storage: { ...STORAGE, "ocr-theme-pref": "light" },
  after: openReport,
});
await shoot(page, "45-report-stress", { query: "?stress=1", after: openReport });

// A repo with no model behind it. The run cannot do anything but fail, so the
// page has to say which of its two preconditions is missing and get out of the
// way — not disable 开始审查 into a tooltip and leave the count on screen as if
// everything were ready.
await shoot(page, "48-review-no-llm", {
  query: "?nollm=1",
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(1400);
  },
  expect: async (page) => {
    const out = [];
    const btn = page.getByRole("button", { name: /开始审查/ });
    if (!(await btn.count())) out.push("the run action disappeared entirely");
    else if (!(await btn.first().isDisabled())) out.push("a review with no configured model is still offered as clickable");
    const text = await page.locator("main").innerText();
    if (!/模型服务还没就绪/.test(text)) out.push("nothing on the page says why the run cannot start");
    if (!/未选择模型服务/.test(text)) out.push("the blocker is not named, so the user cannot act on it");
    if (!(await page.getByRole("button", { name: "去设置" }).count())) out.push("no way to fix the blocker from where it was found");
    return out;
  },
});

// The remembered repository no longer exists — a temp dir cleaned up, a clone
// deleted. This was reachable on a real machine: the app restored `last-repo`,
// every CLI call then failed with `spawn <binary> ENOENT` because Node names the
// program when the *cwd* is what is missing, and 开始审查 stayed enabled so the
// user could only discover that by trying.
await shoot(page, "49-review-repo-gone", {
  query: "?norepo=1",
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(1400);
  },
  expect: async (page) => {
    const out = [];
    const btn = page.getByRole("button", { name: /开始审查/ });
    if ((await btn.count()) && !(await btn.first().isDisabled()))
      out.push("a run against a repository that no longer exists is still offered as clickable");
    const text = await page.locator("main").innerText();
    if (!/仓库目录现在打不开/.test(text)) out.push("nothing says the remembered repository is gone");
    if (/opencodereview\.exe|ENOENT/.test(text)) out.push("the raw spawn error is shown instead of an explanation");
    if (!(await page.getByRole("button", { name: "重新选择" }).count())) out.push("no way out of the dead repository from where it is reported");
    return out;
  },
});

// Open a session, then start a run from it and cancel. A run that produces no
// payload used to leave `result` untouched, so the results screen kept showing
// the session's findings under a 已取消 badge and a 完成 status chip — the
// previous content presented as the outcome of the run that just stopped.
await shoot(page, "50-stale-result-cleared", {
  query: "?cancel=1",
  after: async (page) => {
    await openFindings(page);
    await nav("审查")(page);
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: /开始审查/ }).click();
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "取消", exact: true }).first().click();
    await page.waitForTimeout(1600);
  },
  expect: async (page) => {
    const text = await page.locator("main").innerText();
    const out = [];
    if (/密码校验用了普通的字符串比较/.test(text))
      out.push("the cancelled run still shows findings from the session opened before it");
    if (!/这次运行(已取消|没有产出结果)/.test(text)) out.push("the cancelled run does not say it produced nothing");
    if (!/已取消/.test(text)) out.push("the cancel is not acknowledged on screen");
    return out;
  },
});

// A full-repo scan's payload. Neither results surface virtualises, so this is
// the scale at which an unbounded list stops being a layout question and becomes
// a "did the screen survive" question — and the point where a header that
// disagrees with the list beneath it would show.
await shoot(page, "51-results-many", {
  query: "?many=1",
  after: openFindings,
  expect: async (page) => {
    const seen = await page.evaluate(() => {
      const list = document.querySelector("main .grid > div:first-child");
      return { rows: list ? list.querySelectorAll("button").length : 0, header: document.querySelector("main").innerText.match(/(\d+) 条评论/)?.[1] || "?" };
    });
    const out = [];
    if (seen.rows < 200) out.push(`the findings list mounted ${seen.rows} of 200 rows`);
    if (seen.header !== "200") out.push(`the header counts ${seen.header} while the list holds ${seen.rows}`);
    return out;
  },
});
await shoot(page, "52-report-many", {
  query: "?many=1",
  after: async (page) => {
    await openFindings(page);
    await page.getByRole("button", { name: "阅读", exact: true }).click();
    await page.waitForTimeout(900);
  },
  expect: async (page) => {
    const n = await page.evaluate(() => document.querySelectorAll("main article").length);
    return n < 200 ? [`the reading view rendered ${n} of 200 findings`] : [];
  },
});

// The tightest real combination for the launcher's three-band layout: the
// window minimum, the first-run guide still on screen, and every knob expanded.
// The form region is capped so it can never push the file region or the run bar
// out of the window, and this is where that cap has to hold.
await shoot(page, "53-review-tight", {
  width: 1000,
  height: 660,
  storage: { "last-repo": "/home/x/work/payments-api" },
  clearStorage: true,
  after: async (page) => {
    await page.getByRole("button", { name: /调整这次审查的参数/ }).click();
    await page.waitForTimeout(500);
  },
  expect: async (page) => [...(await expectNoDeadBand(page)), ...(await expectRunActionVisible(page))],
});

await browser.close();
server.close();

// A harness that prints FAIL and then exits 0 is a harness CI will happily
// ignore. Report the tally and fail loudly.
console.log(`\n${passed.length} ok, ${failed.length} failed  (${describeChannel()})`);
console.log("shots ->", SHOTS);
if (failed.length) {
  console.error(`\nlayout assertions failed: ${failed.join(", ")}`);
  process.exit(1);
}
