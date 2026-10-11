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
  let measure = null;
  let cap = null;
  for (const el of document.querySelectorAll("main *")) {
    const mw = parseFloat(getComputedStyle(el).maxWidth);
    if (Number.isFinite(mw) && mw > 0 && mw <= 1200) {
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
  return {
    measure,
    cap,
    docScrollW: document.documentElement.scrollWidth,
    docClientW: document.documentElement.clientWidth,
    docScrollH: document.documentElement.scrollHeight,
    docClientH: document.documentElement.clientHeight,
    clipped: clipped.slice(0, 4),
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
  if (p.docScrollW > p.docClientW + 1) problems.push("doc-x-overflow");
  if (p.docScrollH > p.docClientH + 1) problems.push("doc-y-overflow");
  if (p.measure !== null && p.cap !== null && p.measure > p.cap + 1) problems.push(`measure ${p.measure}px > cap ${p.cap}px`);
  if (p.clipped.length) problems.push("clipped: " + p.clipped.join(" | "));
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

/** Wide: three columns, and the code column clears the widest line. */
const expectThreePanes = async (page) => {
  const g = await resultsGrid(page);
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
 * The preview panel is one of the two buttons on the form, so it is a core
 * flow — and it had no assertion at all, which is how it came to be
 * screenshotted for months against a fixture whose normal payload had no file
 * list at all (`files: undefined`). Every shot showed "进入审查 0 / 共 8" and
 * the "nothing entered the review" explanation, which looks like a perfectly
 * plausible state. Assert the contents, not just the layout.
 */
const expectPreviewListed = async (page) => {
  const out = [];
  const text = await page.locator("main").innerText();
  if (!/进入审查 5 \/ 共 8 个文件/.test(text)) out.push("the preview header does not report 5 of 8");
  if (!/以下 3 个不进入审查/.test(text)) out.push("the excluded files are not listed");
  const rows = await page.locator("main").getByText(/· [+-]\d+ \/ -\d+/).count();
  if (rows < 5) out.push(`only ${rows} reviewable file rows rendered, expected 5`);
  return out;
};

const browser = await chromium.launch({ channel: CHANNEL });
const page = await browser.newPage({ deviceScaleFactor: 1 });
await page.addInitScript(BRIDGE);
page.on("console", (m) => {
  if (m.type() === "error") console.log("  [console.error]", m.text().slice(0, 220));
});
page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 220)));

await shoot(page, "01-review-wide", { after: nav("审查") });
await shoot(page, "02-review-no-guide", { storage: { "last-repo": "" } });
await shoot(page, "03-review-scan", {
  after: async (page) => {
    await page.getByRole("button", { name: /整库/ }).click();
    await page.waitForTimeout(300);
  },
});
await shoot(page, "04-review-advanced", {
  after: async (page) => {
    await page.getByRole("button", { name: /高级参数/ }).click();
    await page.waitForTimeout(300);
  },
});
await shoot(page, "05-results-empty", { after: nav("结果") });
await shoot(page, "06-history", { after: nav("历史") });
await shoot(page, "07-settings-top", { after: nav("设置") });
await shoot(page, "08-settings-bottom", {
  after: async (page) => {
    await nav("设置")(page);
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      const el = document.querySelector("main > div");
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
  expect: expectThreePanes,
});
await shoot(page, "10-review-narrow", { width: 1100, height: 780 });
await shoot(page, "11-settings-narrow", { width: 1100, height: 780, after: nav("设置") });
await shoot(page, "12-review-xwide", { width: 1920, height: 1080 });

// The preview used to render only inside a sidebar that existed above 1536px,
// so this state was previously invisible on most screens.
await shoot(page, "13-review-preview", {
  width: 1440,
  height: 900,
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /预览清单/ }).click();
    await page.waitForTimeout(900);
    await page.evaluate(() => {
      const el = document.querySelector("main > div");
      if (el) el.scrollTop = el.scrollHeight;
    });
  },
  expect: expectPreviewListed,
});

// 1000x660 is the window minimum declared in main.js — the tightest the app
// can ever get. The three-column grid cannot be satisfied down here (the
// minimums alone come to ~1180px), so the code folds into the detail column
// rather than being clipped to a third of a line.
await shoot(page, "14-min-review", { width: 1000, height: 660, after: nav("审查") });
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
    await page.waitForTimeout(400);
    await page.locator("main").getByRole("button", { name: /预览清单/ }).first().click();
    await page.waitForTimeout(900);
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
      for (const step of ["选择要审查的仓库目录", "配置模型服务与 API Key", "先预览文件清单，再开始审查"])
        if (!text.includes(step)) out.push(`guide step missing: ${step}`);
      if (!text.includes("不再提示")) out.push("no way to dismiss the guide");
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
await page.emulateMedia({ colorScheme: null });

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
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /预览清单/ }).click();
    await page.waitForTimeout(700);
  },
  expect: async (page) => {
    const out = [];
    const text = await page.locator("main").innerText();
    if (!/进入审查 0 \/ 共 8 个文件/.test(text)) out.push("the empty preview did not report 0 of 8");
    if (!/没有文件进入审查/.test(text)) out.push("no explanation for the empty scope");

    // Change the scope: the stale count must go, not linger as if current.
    await page.getByRole("button", { name: /分支对比/ }).click();
    await page.waitForTimeout(400);
    if ((await page.locator("main").getByText("文件清单").count()) !== 0)
      out.push("the preview survived a change of scope, so its count is now stale");

    // And pressing run with nothing to review must explain, not start.
    await nav("审查")(page);
    await page.waitForTimeout(200);
    await page.getByRole("button", { name: /工作区改动/ }).click();
    await page.waitForTimeout(200);
    await page.getByRole("button", { name: /预览清单/ }).click();
    await page.waitForTimeout(700);
    await page.getByRole("button", { name: /开始审查/ }).click();
    await page.waitForTimeout(900);
    const toastText = await page.locator("[data-sonner-toast]").innerText().catch(() => "");
    if (!/没有文件可审查/.test(toastText)) out.push(`running an empty scope was not explained (toast: "${toastText.slice(0, 60)}")`);
    if (!(await page.getByRole("button", { name: /开始审查/ }).count()))
      out.push("the run started anyway and left the form page");
    return out;
  },
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
