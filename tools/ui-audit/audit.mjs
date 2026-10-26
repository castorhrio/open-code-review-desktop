// Visual audit harness. Renders the real UI bundle against a stubbed IPC bridge
// so layout can be inspected without launching Electron or touching the desktop.
// Run with `npm run audit:ui` after `npm run build`.
import fs from "node:fs";
import path from "node:path";
import { SHOTS, BRIDGE, STORAGE, serve, OTHER_REPO_PATH, SOLO_REPO_PATH, BASE_REPO_PATH } from "./fixtures.mjs";
import { loadPlaywright, CHANNEL, describeChannel, requireBuilt } from "./playwright.mjs";

requireBuilt();
const { chromium } = await loadPlaywright();

const PORT = 5199;

// Negative verification means re-running one shot after deliberately breaking the
// fix, and a full sixty-shot run is slow enough that the step quietly stops
// happening. `SHOT=<substring> npm run audit:ui` runs only the matching shots.
// A filtered run announces itself in the tally, because a filtered green is not
// a green and must never be readable as one.
const ONLY = process.env.SHOT || "";

// Windows ships at 125% and 150% by default on every laptop, and a fractional
// device pixel ratio changes text metrics and rounding everywhere at once —
// which is exactly the kind of change a 1x-only suite cannot see. SCALE runs the
// same shots at another ratio; the artefacts get a suffix so a scaled run never
// overwrites the 1x ones, and the tally names the ratio so a scaled green is
// not readable as a 1x green.
const SCALE = Number(process.env.SCALE || 1);

// Enforces the layout spec in `src/components/ui/layout.tsx` instead of trusting
// a code comment: one measure per scrolling page, no horizontal overflow, and no
// element whose content is wider than its own box.
//
// *** DO NOT PUT A BACKTICK ANYWHERE INSIDE THIS LITERAL. ***
// It is a template literal, so a backtick in a *comment* ends it early and the
// file stops parsing — which has happened four times now, each time as an
// `Unexpected identifier` on a line that looks perfectly correct. Name things
// in prose ("Button carries an svg size of 3.5 in its base class") rather than
// in backticks, and do not reach for template interpolation inside the probe.
const PROBE = `(() => {
  // Find the page's declared measure: the first element in <main> carrying a
  // max-width cap (PageBody sets it from --page-max / --page-max-narrow).
  // The lower bound is what makes this a *column*: without it the probe latches
  // onto the first capped chip it meets — a 180px badge, then a 320px scope label
  // on the results screen, each reported as "the page's measure", and a check
  // that compares a page against a badge is not checking anything. 480 sits above
  // every capped chip in the app and below the narrowest real measure (640).
  let measure = null;
  let cap = null;
  for (const el of document.querySelectorAll("main *")) {
    const mw = parseFloat(getComputedStyle(el).maxWidth);
    if (Number.isFinite(mw) && mw >= 480 && mw <= 1200) {
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
  // Truncation with no way back to the full value.
  //
  // The app's own rule (see Badge in overlay.tsx) is that a slot fed by a path,
  // ref, model id or provider name gets a cap *and* a title — because otherwise
  // the one thing the reader needs (the whole path, the whole branch, the whole
  // model id) is exactly the thing the layout hides, and there is no hover, no
  // selection and no other place it appears. The truncate utility was applied
  // widely but the title half was missed in ten slots, which no screenshot can
  // show: an ellipsised value looks identical whether or not it is recoverable.
  //
  // Only elements that are *actually* truncated are reported, so a static label
  // that carries truncate merely as a safety net is not noise.
  const unreachable = [];
  for (const el of document.querySelectorAll("body *")) {
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "DATALIST") continue;
    if (getComputedStyle(el).textOverflow !== "ellipsis") continue;
    if (!(el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0)) continue;
    let has = false;
    // An ancestor's title covers the whole slot; a descendant's covers the text
    // itself, which is where the pointer lands even when the ancestor clips it
    // (ReportView puts the full path on the span inside the card header). Either
    // way the value is reachable, which is the whole question.
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.getAttribute && n.getAttribute("title")) {
        has = true;
        break;
      }
    }
    if (!has && el.querySelector("[title]")) has = true;
    if (has) continue;
    const cls = typeof el.className === "string" ? el.className : el.getAttribute("class") || "";
    unreachable.push(el.tagName.toLowerCase() + "." + cls.slice(0, 50) + " " + el.scrollWidth + ">" + el.clientWidth);
  }
  // One type ramp. styles.css declares four steps and nothing else — 11 / 12 /
  // 13 / 20px — because the app once used ten sizes between 10 and 14px in
  // half-pixel increments, which is what made every screen look slightly
  // unrelated to every other one. A comment cannot hold that; this can. Only
  // elements that *own* text are sampled, so an inherited size is never counted
  // twice, and the sizes are reported so a failure names the offender.
  const RAMP = [11, 12, 13, 20];
  const offRamp = {};
  for (const el of document.querySelectorAll("main *")) {
    if (!el.getClientRects().length) continue;
    const owns = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent || "").trim());
    if (!owns) continue;
    const px = Math.round(parseFloat(getComputedStyle(el).fontSize) * 10) / 10;
    if (RAMP.indexOf(px) !== -1) continue;
    const cls = typeof el.className === "string" ? el.className : el.getAttribute("class") || "";
    const key = px + "px " + el.tagName.toLowerCase() + "." + cls.slice(0, 30);
    offRamp[key] = (offRamp[key] || 0) + 1;
  }
  // Motion is productive, not expressive.
  //
  // IBM's design language draws the line this way: productive motion "leans
  // toward efficiency and responsiveness" while expressive motion is
  // "enthusiastic and vibrant", and "animate only what's vital... needless
  // flourishes or overcomplicated actions without clear reason have no place".
  // A code review tool has no use for the expressive half — every motion here
  // confirms a state change and then gets out of the way. So the rule is a
  // ceiling, not a vocabulary: nothing may take longer than a quarter second.
  //
  // A deliberate loop is exempt, and that is the only exemption: the live
  // activity dot pulses for as long as a run is in flight, and its two seconds
  // *are* the meaning — it says "still working", not "look at me".
  const slowMotion = [];
  const toMs = (v) => v.split(",").map((s) => parseFloat(s) * (s.indexOf("ms") !== -1 ? 1 : 1000)).filter((n) => Number.isFinite(n));
  for (const el of document.querySelectorAll("main *")) {
    if (!el.getClientRects().length) continue;
    const cs = getComputedStyle(el);
    if (cs.animationIterationCount.split(",").some((v) => v.trim() === "infinite")) continue;
    const durs = toMs(cs.animationDuration).concat(toMs(cs.transitionDuration));
    for (const d of durs) {
      if (d <= 240) continue;
      const cls = typeof el.className === "string" ? el.className : "";
      slowMotion.push(Math.round(d) + "ms " + el.tagName.toLowerCase() + "." + cls.slice(0, 30));
    }
  }
  // A declared size that does not take effect.
  //
  // Button carries an svg size of 3.5 in its base class, which is specificity
  // (0,1,1) — a class plus the svg type selector. An explicit size-4 on the
  // icon is (0,1,0), so it loses, and every size-4 icon inside a Button
  // rendered at 14px while the source said 16. The primary action and the
  // settings buttons all said size-4. This is the same failure the type ramp
  // had: the code claims one thing and the screen shows another, and no
  // screenshot can show it because 14px looks perfectly plausible.
  //
  // Scoped to svg: an icon's size-* is unambiguous, whereas a size-* on a
  // stretched grid or flex item is layout doing its job, not a dead override.
  const deadSize = [];
  for (const el of document.querySelectorAll("main svg")) {
    if (!el.getClientRects().length) continue;
    const cls = el.getAttribute("class") || "";
    // Doubled backslashes: this literal is template-literal source text, where a
    // lone \\s or \\d is an unrecognised escape and collapses to a bare s or d.
    const m = cls.match(/(?:^|\\s)size-(\\d+(?:\\.\\d+)?)(?:\\s|$)/);
    if (!m) continue;
    // Tailwind's size-N is N * 0.25rem, and the app runs at a 16px root.
    const want = parseFloat(m[1]) * 4;
    const got = el.getBoundingClientRect().width;
    if (Math.abs(got - want) > 1)
      deadSize.push("size-" + m[1] + " renders " + Math.round(got) + "px " + cls.replace(/\s+/g, " ").slice(0, 40));
  }
  // The positive half of the same rule, and it has to exist: once the call
  // sites stop patching sizes (which is the fix), there is no declared size left
  // for the check above to disagree with, and the rule would go unprobed. So
  // read the button's own step instead — 14px of icon for dense chrome (h-7 /
  // h-8), 16px for the action row (h-9). Scoped to main, which excludes the nav
  // rail: those are hand-rolled buttons at their own optical size, not Buttons.
  const iconStep = [];
  for (const btn of document.querySelectorAll("main button")) {
    const h = Math.round(btn.getBoundingClientRect().height);
    const want = h >= 36 ? 16 : h === 28 || h === 32 ? 14 : 0;
    if (!want) continue;
    for (const svg of btn.querySelectorAll("svg")) {
      if (!svg.getClientRects().length) continue;
      const got = Math.round(svg.getBoundingClientRect().width);
      if (got !== want)
        iconStep.push("a " + h + "px button draws a " + got + "px icon, expected " + want + "px");
    }
  }
  const root = document.getElementById("root");
  // Which view is on screen changes more often than anything else in this app,
  // and it used to hard-swap: no transition at all, so navigation read as a
  // repaint. The entry animation is what makes the change legible, and
  // animation-name survives in computed style after the animation ends, so this
  // is checkable on a still screenshot.
  const viewRoot = document.querySelector("main") && document.querySelector("main").firstElementChild;
  const viewMotion = viewRoot ? getComputedStyle(viewRoot).animationName : "";
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
    unreachable: unreachable.slice(0, 4),
    offRamp: Object.entries(offRamp).slice(0, 4),
    slowMotion: slowMotion.slice(0, 4),
    deadSize: deadSize.slice(0, 4),
    iconStep: [...new Set(iconStep)].slice(0, 4),
    viewMotion,
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
  // Skipped shots are counted separately, never as passes — each shot reloads
  // the page and seeds its own storage, so skipping one cannot change another.
  if (ONLY && !ONLY.split(",").some((token) => name.includes(token))) {
    skipped.push(name);
    return null;
  }
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
  const file = path.join(SHOTS, `${name}${SCALE === 1 ? "" : "@" + Math.round(SCALE * 100)}.png`);
  await page.screenshot({ path: file, fullPage: false });
  const p = await page.evaluate(PROBE);
  const problems = [];
  if (!p.mounted) problems.push("the app did not mount — nothing was rendered to measure");
  else if (p.mainText < 10) problems.push(`<main> rendered ${p.mainText} characters, so the screen is effectively blank`);
  if (p.docScrollW > p.docClientW + 1) problems.push("doc-x-overflow");
  if (p.docScrollH > p.docClientH + 1) problems.push("doc-y-overflow");
  if (p.measure !== null && p.cap !== null && p.measure > p.cap + 1) problems.push(`measure ${p.measure}px > cap ${p.cap}px`);
  if (p.clipped.length) problems.push("clipped: " + p.clipped.join(" | "));
  if (p.unreachable.length) problems.push("truncated with no title: " + p.unreachable.join(" | "));
  if (p.offRamp.length) problems.push("font size off the ramp: " + p.offRamp.map(([k, n]) => `${k} x${n}`).join(" | "));
  if (p.slowMotion.length) problems.push("motion slower than a quarter second: " + p.slowMotion.join(" | "));
  if (p.deadSize.length) problems.push("icon size declared but not applied: " + p.deadSize.join(" | "));
  if (p.iconStep.length) problems.push("icon size does not match the button step: " + p.iconStep.join(" | "));
  // Every view animates in, so the change of screen is legible. A view that
  // swaps instantly is the failure this guards.
  if (!/fadeIn/.test(p.viewMotion || "")) problems.push(`the view does not animate in (animation-name "${p.viewMotion}")`);
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
const skipped = [];

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
    // The frame belongs to the nearest ancestor that draws one, not to a fixed
    // depth. This walked exactly two levels up — list, region, panel — which was
    // right until the feed became a `ScrollArea` and gained a wrapper of its own,
    // at which point the assertion reported the panel frameless. Note the failure
    // mode: it did not crash or find nothing, it quietly measured the wrapper, so
    // the message ("the activity region has no frame") described a real property
    // of the wrong element. A DOM walk that assumes a shape breaks silently when
    // the shape changes; a walk that states what it is looking for does not.
    let panel = region?.parentElement ?? null;
    while (panel && panel !== main && parseFloat(getComputedStyle(panel).borderTopWidth) === 0) {
      panel = panel.parentElement;
    }
    if (panel === main) panel = null;
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
      // A failed call is the one row whose colour carries bad news, and a red
      // dot with no reason beside it is the run screen's silent failure.
      failedRows: rows
        .filter((li) => [...li.querySelectorAll("span")].some((s) => (s.className || "").toString().includes("bg-bad")))
        .map((li) => li.innerText.replace(/\s+/g, " ").trim()),
    };
  });
  const out = [];
  if (seen.rows < 4) out.push(`the activity feed showed only ${seen.rows} rows — a run with nothing on screen reads as a hung app`);
  if (seen.cells.includes("—")) out.push(`a run counter never left "—": ${seen.cells.join(", ")}`);
  if (seen.cells.includes("…")) out.push(`a run counter never left its placeholder: ${seen.cells.join(", ")}`);
  if (!/进入审查/.test(seen.text)) out.push("the run screen lost its scope counter");
  if (seen.gapAbove > 40) out.push(`${seen.gapAbove}px of empty window above the first activity row — the run screen reads as stuck`);
  // Only meaningful when the panel was found at all: without it the share is
  // -1, and "-1% of the screen" is noise on top of the message that says the
  // panel is missing.
  if (seen.share >= 0 && seen.share < 55)
    out.push(`the activity panel is only ${seen.share}% of the screen, so it is not the hero of a running review`);
  if (!seen.bordered) out.push("the activity region has no frame, so unfilled space inside it reads as broken layout");
  // Both halves: the transcript's failed call has to reach the feed as a failed
  // row, and that row has to say why. A dot alone passes the first half and
  // tells the reader nothing, which is the failure the parser fix exists for.
  if (seen.failedRows.length === 0) out.push("the transcript's failed tool call produced no failed row in the feed");
  for (const f of seen.failedRows)
    if (f.split(" ").length < 4) out.push(`a failed tool row is a red dot with no reason: "${f}"`);
  return out;
};

/**
 * The running feed has to be full for the affordance check to mean anything.
 *
 * A check that reads "is there a fade where content is cut off" passes trivially
 * on a region with nothing cut off, so the state that matters — a feed with more
 * tool calls than rows — has to be asserted to exist. Without this the shot above
 * would report green over a feed with 200px to spare, which is what the suite
 * did for its whole life.
 */
const expectFeedOverflows = async (page) => {
  const m = await page.evaluate(() => {
    const h3 = [...document.querySelectorAll("main h3")].find((h) => h.textContent.trim() === "实时活动");
    const panel = h3?.closest("div[class*='rounded-md']");
    const el = panel
      ? [...panel.querySelectorAll("*")].find((n) => /auto|scroll/.test(getComputedStyle(n).overflowY) && n.clientHeight > 40)
      : null;
    if (!el) return null;
    return {
      rows: el.querySelectorAll("li").length,
      below: el.scrollHeight - el.scrollTop - el.clientHeight,
      above: el.scrollTop,
      client: el.clientHeight,
      scroll: el.scrollHeight,
      // A feed that scrolls sideways is two failures, not one: a horizontal
      // scrollbar on the screen the user watches for minutes, and an exemption
      // from the scroll-affordance rule, which skips any region whose
      // scrollWidth exceeds its box — so the feed would lose its vertical fade
      // for exactly as long as one wide line exists.
      wide: el.scrollWidth - el.clientWidth,
    };
  });
  if (!m) return ["the running feed was not found"];
  if (m.below <= 1 && m.above <= 1)
    return [
      `the feed holds ${m.rows} rows in ${m.client}px (${m.scroll}px of content) — nothing is cut off, so the scroll-affordance check is vacuous`,
    ];
  if (m.wide > 1)
    return [`the feed scrolls ${m.wide}px sideways, so one wide line costs it its vertical fade and gives the run screen a horizontal scrollbar`];
  return [];
};

/**
 * The log drawer is the raw-output surface — the CLI's own lines, which the feed
 * summarises — and it had no shot at all, so its layout, its 160px cap and its
 * auto-scroll were never rendered in the audit. It also cut at the top for the
 * same reason the feed did: it pins to its last line, so the oldest lines scroll
 * out of the box with nothing to say so. It is a sibling of `<main>`, which is
 * why nothing looked at it — not a screenshot, not a check.
 */
const expectLogDrawer = async (page) => {
  const m = await page.evaluate(() => {
    const pre = [...document.querySelectorAll("pre")].find((p) => /\[ocr\]/.test(p.textContent || ""));
    if (!pre) return null;
    // The scroller is whichever element actually scrolls: the pre itself before
    // the fix, its wrapper after. Assuming a fixed relationship is how the
    // running-feed check came to measure the wrong element and report a real
    // property of it — the same mistake, in the same week.
    let box = pre;
    while (box && !/auto|scroll/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
    if (!box) box = pre.parentElement;
    return {
      lines: (pre.textContent || "").split("\n").length,
      client: box.clientHeight,
      scroll: box.scrollHeight,
      above: box.scrollTop,
      below: box.scrollHeight - box.scrollTop - box.clientHeight,
    };
  });
  if (!m) return ["the log drawer is not open, so nothing about it was verified"];
  const out = [];
  if (m.lines < 5) out.push(`the log drawer holds only ${m.lines} line(s) of CLI output`);
  if (m.scroll <= m.client + 1)
    out.push(
      `the log drawer holds ${m.lines} lines in ${m.client}px with nothing cut off, so the scroll-affordance check is vacuous`
    );
  return out;
};

/**
 * A session carries its own scope, and the review form on screen has nothing to
 * do with it. The code pane used to resolve its ref from the form, so opening a
 * history session showed the working tree beside a 历史会话 badge — the code next
 * to a finding could be a different file than the one that was reviewed.
 *
 * The ref it reads is the *commit*, not the branch name: the CLI froze the
 * endpoints before the run and kept them in the manifest, and a branch that has
 * moved on since the review now holds content nobody reviewed. So the pane must
 * name the reviewed commit, and the whole SHA has to be what the read asked
 * for — the title keeps it, the badge shows it abbreviated.
 */
const expectCodeReadAtCommit = async (page) => {
  const text = await page.locator("main").innerText();
  const out = [];
  if (!/来自 d41c8b7/.test(text))
    out.push("the code pane is not read from the reviewed commit, so it is showing the working tree or a moved branch");
  const title = await page.locator('main span[title^="来自 d41c8b7"]').first().getAttribute("title").catch(() => null);
  if (!title || !title.includes("d41c8b7a2e9f6013c5d8a4b6e2f7091c3a5d8e6b4"))
    out.push(`the code pane's ref is not the reviewed commit in full (title: ${title})`);
  return out;
};

/**
 * The results header has to say which version was reviewed. The scope line names
 * the refs the run was asked for, and a ref is a name that moves — a reader who
 * forwards the report needs to know which commit the findings are about.
 */
const expectPinnedCommit = async (page) => {
  const text = await page.locator("main").innerText();
  const out = [];
  if (!/固定在 d41c8b7/.test(text)) out.push("the results header does not say which commit was reviewed");
  const title = await page
    .locator('main span[title^="这次审查读的是这一版代码"]')
    .first()
    .getAttribute("title")
    .catch(() => null);
  if (!title || !title.includes("d41c8b7a2e9f6013c5d8a4b6e2f7091c3a5d8e6b4"))
    out.push(`the pinned commit badge does not keep the full SHA reachable (title: ${title})`);
  return out;
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
 * A finding is read against its own lines, and the CLI hands back a window
 * padded 16 lines either side. The pane opened at the window's *first* line, so
 * at the 1000x660 floor the highlight sat 140px below the pane's own bottom
 * edge — selecting a finding showed code the finding was not about, and nothing
 * said so, because the pane still looked like an ordinary scroller.
 *
 * Measured on the built UI before the fix: pane 202px tall over 597px of code,
 * highlight at 715..767 against a pane ending at 627. At 1280x800 (pane 294px)
 * only 4px of the highlight was on screen. The 1440px layout hides it, because
 * there the whole window fits and the pane never scrolls — which is exactly why
 * the assertion has to run at the narrow widths too.
 */
const expectHighlightVisible = async (page) => {
  const m = await page.evaluate(() => {
    const pre = [...document.querySelectorAll("main pre")].find(
      (p) => (p.className || "").toString().includes("min-w-full") && p.parentElement.clientHeight > 0
    );
    if (!pre) return { error: "the code pane is not rendered" };
    const box = pre.parentElement;
    const hits = [...pre.querySelectorAll("div")].filter((d) => (d.className || "").toString().includes("bg-hit"));
    if (!hits.length) return { error: "the code pane highlights no line for the selected finding" };
    const b = box.getBoundingClientRect();
    const first = hits[0].getBoundingClientRect();
    const last = hits[hits.length - 1].getBoundingClientRect();
    return {
      above: Math.round(b.top - first.top),
      below: Math.round(last.bottom - b.bottom),
      boxH: Math.round(b.height),
      scrollH: box.scrollHeight,
    };
  });
  if (m.error) return [m.error];
  const out = [];
  const where = `(pane ${m.boxH}px, code ${m.scrollH}px)`;
  if (m.above > 1)
    out.push(`the highlighted lines start ${m.above}px above the code pane's top edge, so the finding is off screen ${where}`);
  if (m.below > 1)
    out.push(`the highlighted lines end ${m.below}px below the code pane's bottom edge, so the finding is off screen ${where}`);
  return out;
};

/** Run several assertions over one shot, concatenating their problems. */
const all = (...checks) => async (page) => {
  const out = [];
  for (const c of checks) out.push(...(await c(page)));
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
 * The reading column has to be the region that scrolls — and it has to overflow.
 *
 * Two failures in one, which is why this is its own check rather than a line in
 * `expectScrollAffordance`. That check asks "is there a fade where content is
 * cut off", and it passed over this column for the suite's whole life because
 * the fixture's findings are three lines each: the column never overflowed, so
 * there was never anything to fade. `?longfinding=1` supplies a finding the
 * length a real security comment runs to, and with it the second failure shows:
 * the column's wrapper was `overflow-y-auto` around a `ScrollArea`, so the
 * wrapper scrolled (729px of box, 1917px of content) while the ScrollArea —
 * the component that owns the fade — grew to its content and reported nothing
 * cut off. 1188px of finding ran off the bottom of the screen with no
 * affordance, on the one screen whose whole job is reading.
 *
 * So both halves are asserted: the wrapper does not scroll, and the scroller
 * inside it does. Either one alone passes on the broken build.
 */
const expectReadingColumnOverflows = async (page) => {
  const m = await page.evaluate(() => {
    const grid = [...document.querySelectorAll("main .grid")].find((g) =>
      (g.getAttribute("class") || "").includes("grid-cols-[minmax(240px")
    );
    if (!grid) return { error: "no results grid" };
    const vis = [...grid.children].filter((el) => getComputedStyle(el).display !== "none");
    const col = vis[1];
    if (!col) return { error: "the results grid has no reading column" };
    const scrolls = (el) => /auto|scroll/.test(getComputedStyle(el).overflowY) && el.clientHeight > 0;
    let inner = null;
    for (const el of col.querySelectorAll("*")) {
      // The finding's own scroller, not a code block's: the code panes scroll
      // sideways and are excluded from the fade rule on purpose.
      if (!scrolls(el)) continue;
      if (el.scrollWidth > el.clientWidth + 1) continue;
      if (!inner || el.scrollHeight > inner.scrollHeight) inner = el;
    }
    return {
      wrapperScrolls: scrolls(col) && col.scrollHeight > col.clientHeight + 1,
      wrapperBelow: col.scrollHeight - col.clientHeight,
      inner: inner
        ? { client: inner.clientHeight, scroll: inner.scrollHeight, below: inner.scrollHeight - inner.scrollTop - inner.clientHeight }
        : null,
    };
  });
  if (m.error) return [m.error];
  const out = [];
  if (m.wrapperScrolls)
    out.push(
      `the reading column's wrapper scrolls ${m.wrapperBelow}px past its box, so the ScrollArea inside it is not the region that owns the fade`
    );
  if (!m.inner) return [...out, "no scroller was found inside the reading column"];
  if (m.inner.below <= 1)
    out.push(
      `the reading column holds its finding in ${m.inner.client}px with ${m.inner.scroll}px of content — nothing is cut off, so the scroll-affordance check over it is vacuous`
    );
  return out;
};

/**
 * The summary band has to overflow, or its fade check means nothing.
 *
 * The results screen caps 这次审查的要点 at 208px, and the CLI's real summary is
 * a sectioned document — a dozen lines of prose. Every fixture carried a
 * two-line one, so the capped band never scrolled in any shot and the
 * affordance check over it was a green light wired to nothing, while the band
 * itself was a bare `overflow-y-auto` with no fade. `?longfinding=1` carries the
 * sectioned shape; this asserts the cap is actually reached with it.
 */
const expectSummaryOverflows = async (page) => {
  const m = await page.evaluate(() => {
    const h3 = [...document.querySelectorAll("main h3")].find((h) => h.textContent.trim() === "这次审查的要点");
    if (!h3) return null;
    // The band is the nearest ancestor that owns a scroller: the header row and
    // the capped region are siblings inside it.
    const hasScroller = (n) => [...n.querySelectorAll("*")].some((c) => /auto|scroll/.test(getComputedStyle(c).overflowY));
    let band = h3.parentElement;
    while (band && !hasScroller(band)) band = band.parentElement;
    if (!band) return { error: "the summary band has no scroller" };
    const scroller = [...band.querySelectorAll("*")].find((n) => /auto|scroll/.test(getComputedStyle(n).overflowY) && n.clientHeight > 40);
    if (!scroller) return { error: "the summary band has no scroller" };
    return { client: scroller.clientHeight, scroll: scroller.scrollHeight, below: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight };
  });
  if (!m) return ["the summary band was not rendered"];
  if (m.error) return [m.error];
  if (m.below <= 1)
    return [
      `the summary band holds its text in ${m.client}px with ${m.scroll}px of content — nothing is cut off, so the scroll-affordance check over it is vacuous`,
    ];
  return [];
};

/**
 * The results list's row count, scoped to the master-detail grid's first column
 * so filter chips and the detail pane's buttons are not counted as rows.
 */
const countListRows = (page) =>
  page.evaluate(() => {
    const grid = [...document.querySelectorAll("main .grid")].find((g) =>
      (g.getAttribute("class") || "").includes("grid-cols-[minmax(240px")
    );
    if (!grid) return -1;
    const col = [...grid.children].filter((el) => getComputedStyle(el).display !== "none")[0];
    return col ? col.querySelectorAll("button").length : -1;
  });

/**
 * At four figures neither surface virtualises, so the question is whether the
 * mount completes with every finding present. A list that silently caps at a
 * few hundred would still look like a long list — which is exactly why the
 * count is asserted rather than admired.
 */
const expectHugeListed = async (page) => {
  const n = await countListRows(page);
  if (n < 0) return ["the results grid was not rendered"];
  if (n !== 1200) return [`the results list rendered ${n} of 1200 findings — a silent cap, or a mount that gave up`];
  return [];
};

/**
 * 阅读 renders every finding as a document block, so a thousand findings is the
 * heaviest mount in the app. Two halves: all of them are in the document, and
 * the mount finished inside a budget a reader would still call a page load.
 * The time is measured in the page around the 阅读 click, because a number
 * taken from the harness's wall clock would include the round trips.
 */
const expectHugeReport = async (page) => {
  const m = await page.evaluate(() => ({
    articles: document.querySelectorAll("main article").length,
    ms: Math.round(window.__reportMs ?? -1),
  }));
  const out = [];
  if (m.articles !== 1200) out.push(`the report rendered ${m.articles} of 1200 findings`);
  if (m.ms < 0) out.push("the report's mount time was not measured");
  else if (m.ms > 8000) out.push(`the report took ${m.ms}ms to mount 1200 findings — past the point of reading as a document`);
  // The number is the point of this shot, so it is printed even when it passes:
  // a ceiling nobody watches drifts into being the measurement.
  if (m.ms >= 0) console.log(`         report mounted ${m.articles} findings in ${m.ms}ms`);
  return out;
};

/**
 * The run screen is visual — rows appearing, dots pulsing, counters climbing —
 * and a screen reader got none of it. One polite live region now carries the
 * sentence that matters. These assert it exists and says something true: a live
 * region that is empty, or whose text never changes, is silence with extra
 * steps, and neither half is visible in a screenshot.
 */
const liveText = (page) =>
  page.evaluate(() => [...document.querySelectorAll("main [role=status]")].map((e) => e.textContent.trim()).join(" | "));

const expectRunAnnounced = async (page) => {
  const t = await liveText(page);
  if (!t) return ["the running screen has no live region: assistive tech hears nothing while the run works"];
  if (!/审查运行中，已产出 \d+ 条评论/.test(t)) return [`the run's live region does not state its progress: "${t}"`];
  return [];
};

const expectResultAnnounced = async (page) => {
  const t = await liveText(page);
  if (!/审查完成，\d+ 条评论/.test(t))
    return [`a finished run's results do not announce themselves: "${t || "no live region"}"`];
  return [];
};

/**
 * Every scroll region has to admit it scrolls.
 *
 * Both of the review page's regions end flush against a fixed band — the form
 * against the file region's border, the file list against the pinned action bar
 * — so when either is taller than its share the content is sliced mid-row. The
 * scrollbar says the region scrolls (a real 9px one: the app styles
 * `::-webkit-scrollbar`); it does not stop the last row being cut through its
 * glyphs, which is the half-line the reader was about to read. At the 1000x660
 * floor that is the default state: the page opens with a half-row.
 *
 * The rule is conditional, and that is what makes it worth asserting: the fade
 * has to be there *when and only when* there is content beyond the edge. This
 * reads the scroll numbers, then scrolls every region to its far end and
 * re-reads them. A decoration that is always painted passes the first half and
 * fails the second, which is exactly the failure a static gradient has — and a
 * region that was never converted to `ScrollArea` fails the first.
 *
 * It deliberately enumerates regions rather than looking for one known row:
 * the point is that a *new* scroll region cannot quietly skip the rule. The one
 * exclusion is a region that also scrolls sideways — see the note in the loop.
 *
 * The scope is the content column, not `main`. The log drawer is a sibling of
 * `main`, and it is the same kind of region — a 160px box pinned to its last
 * line, whose bottom edge is the window's — so scoping to `main` meant the one
 * region literally flush against the window edge was the one the rule never
 * looked at. Portals (toasts, select menus) attach to <body>, outside this
 * subtree, so they stay out of scope on purpose: their scrolling is the
 * library's, not the app's.
 */
const expectScrollAffordance = async (page) => {
  const read = () =>
    page.evaluate(() => {
      const regions = [];
      const scope = document.querySelector("main")?.parentElement ?? document.body;
      for (const el of scope.querySelectorAll("*")) {
        const cs = getComputedStyle(el);
        if (cs.overflowY !== "auto" && cs.overflowY !== "scroll") continue;
        if (!el.clientHeight || !el.clientWidth) continue;
        // A region that also scrolls sideways is excluded, and the exclusion is
        // the point rather than an escape hatch: it carries a horizontal
        // scrollbar along its bottom edge, so a bottom fade would be painted
        // straight over that scrollbar. The code panes are the case — they are
        // continuous surfaces where a cut line is a convention every editor
        // shares, not an ambiguous half-row.
        if (el.scrollWidth > el.clientWidth + 1) continue;
        const wrap = el.parentElement;
        const box = el.getBoundingClientRect();
        const fades = wrap
          ? [...wrap.children]
              .filter((c) => c !== el && getComputedStyle(c).position === "absolute")
              .map((c) => ({
                at: c.getBoundingClientRect().top <= box.top + 1 ? "top" : "bottom",
                grad: /linear-gradient/.test(getComputedStyle(c).backgroundImage),
              }))
          : [];
        const cls = typeof el.className === "string" ? el.className : "";
        regions.push({
          // Name the region by the thing above it, which is how a reader finds
          // it on screen; the class list is the fallback.
          id: cls.replace(/\s+/g, " ").slice(0, 34) || el.tagName.toLowerCase(),
          below: el.scrollHeight - el.scrollTop - el.clientHeight,
          above: el.scrollTop,
          fades,
        });
      }
      return regions;
    });

  const check = (regions, phase) => {
    const out = [];
    for (const r of regions) {
      const has = (at) => r.fades.some((f) => f.at === at && f.grad);
      if (r.below > 1 && !has("bottom"))
        out.push(
          phase === "first"
            ? `${r.below}px is cut off at the bottom of scroll region "${r.id}" with no fade to say so`
            : `scroll region "${r.id}" still cuts ${r.below}px off after scrolling to its end`
        );
      if (r.below <= 1 && has("bottom"))
        out.push(`scroll region "${r.id}" fits (${r.below}px spare) but still fades its bottom edge`);
      if (r.above <= 1 && has("top"))
        out.push(`scroll region "${r.id}" is at its top but already fades its top edge`);
      if (r.above > 1 && !has("top"))
        out.push(`scroll region "${r.id}" is scrolled ${r.above}px down with no fade showing content above`);
    }
    return out;
  };

  const first = await read();
  const out = check(first, "first");

  // Scroll every region to its far end: each fade has to move to the other
  // edge, or vanish.
  //
  // The original offsets are put back afterwards, and that is not tidiness. An
  // assertion that leaves the page scrolled changes what every assertion after
  // it measures, silently and in the direction of *passing*: the code pane
  // pushed to its end left the selected finding 106px above the pane's own top
  // edge, so a later "is the finding on screen" check read a screen the user
  // never sees. The screenshot is taken before the assertions, so nothing about
  // this was visible in a shot either. A check owns the state it mutates.
  const scrollEnd = (capture) =>
    page.evaluate((cap) => {
      const keep = [];
      const scope = document.querySelector("main")?.parentElement ?? document.body;
      for (const el of scope.querySelectorAll("*")) {
        const cs = getComputedStyle(el);
        if (cs.overflowY !== "auto" && cs.overflowY !== "scroll") continue;
        if (!el.clientHeight) continue;
        if (cap) keep.push(el.scrollTop);
        el.scrollTop = el.scrollHeight;
      }
      return keep;
    }, capture);

  const before = await scrollEnd(true);
  await page.waitForTimeout(200);
  // A region that grows while it is watched — the running feed replays on a
  // timer — can accept the scroll and then gain a row before the read lands, so
  // the read catches a one-row gap the app's own pin closes a task later; and
  // the mirror race reads a bottom fade the app is one commit away from
  // removing, because the scroll-to-end that clears it fires its scroll event a
  // task after the pin. Both are races in the measurement, not defects: each
  // appeared once in a loaded full run and never in isolation. So phase 2 keeps
  // scrolling and re-reading while it reports anything, bounded to two retries;
  // a region that genuinely cannot reach its end, or genuinely paints a stale
  // fade, fails all three reads.
  let last = await read();
  let problems = check(last, "last");
  for (let i = 0; i < 2 && problems.length; i++) {
    await scrollEnd(false);
    await page.waitForTimeout(150);
    last = await read();
    problems = check(last, "last");
  }
  out.push(...problems);
  await page.evaluate((keep) => {
    let i = 0;
    const scope = document.querySelector("main")?.parentElement ?? document.body;
    for (const el of scope.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      if (cs.overflowY !== "auto" && cs.overflowY !== "scroll") continue;
      if (!el.clientHeight) continue;
      el.scrollTop = keep[i++] ?? 0;
    }
  }, before);
  return out;
};

/**
 * 全量扫描 has no diff, and the real CLI says so: every file comes back with a
 * constant `scan` status, `deletions: 0`, and `insertions` as the file's total
 * line count. The list printed that word on every row — the same value 66 times
 * under a heading that already names the mode — and the fixture had been
 * returning diff statuses (`M` / `A`) that the CLI never emits, which is exactly
 * what stopped anyone seeing it. A row's right-hand column has to describe the
 * file, not repeat the mode.
 */
const expectScanRows = async (page) => {
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll("main span[class*='font-mono']")].map((p) =>
      p.parentElement ? p.parentElement.textContent.replace(/\s+/g, " ").trim() : ""
    )
  );
  const out = [];
  if (rows.length < 5) out.push(`only ${rows.length} file rows rendered for a whole-repo scan`);
  for (const r of rows) {
    // Both spellings matter. The raw English is what the fixture used to carry
    // straight to the screen; the Chinese is what the label map turns it into
    // now, so a diff status that survives into scan mode is caught either way.
    if (/modified|added|deleted|重命名|修改|新增|删除/.test(r) || /(^|\s)[MAD]\s·/.test(r))
      out.push(`a 全量扫描 row carries diff vocabulary, but a scan has no diff: "${r.slice(0, 70)}"`);
    if (/scan/i.test(r)) out.push(`a 全量扫描 row repeats the mode's own status word: "${r.slice(0, 70)}"`);
  }
  const withLines = rows.filter((r) => /\d+ 行$/.test(r)).length;
  if (withLines < 5) out.push(`only ${withLines} of ${rows.length} 全量扫描 rows state how many lines will be read`);
  return out;
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
/**
 * One measure per page — asserted on the page that broke it, at the width where
 * it breaks.
 *
 * The review page's file list and its pinned bar are full-bleed *bands*: their
 * background has to reach the window edges to read as bands. Their content does
 * not, and did not: at 1920px the form began at 152px while the file rows began
 * at 32px, so a row's diff stat landed ~1770px from the filename it describes.
 * Three left edges on one page, and the one pairing the list exists to make
 * unreadable — verbatim what rule 1 of the layout spec forbids. Every other shot
 * is 1440px wide, where the same mistake is a 90px offset that reads as a
 * margin, which is why it survived a suite that already checked for overflow.
 */
const expectOneColumn = async (page) => {
  const m = await page.evaluate(() => {
    const find = (sel, test) => [...document.querySelectorAll(sel)].find(test);
    const form = find("main h2", (h) => h.textContent === "审查范围");
    const row = find("main span", (s) => s.textContent === "internal/service/auth/login.go");
    const btn = find("main button", (b) => /开始审查/.test(b.textContent || ""));
    if (!form || !row || !btn) return null;
    const band = row.closest("div");
    return {
      formLeft: Math.round(form.getBoundingClientRect().left),
      rowLeft: Math.round(row.getBoundingClientRect().left),
      bandRight: Math.round(band.getBoundingClientRect().right),
      runRight: Math.round(btn.getBoundingClientRect().right),
    };
  });
  if (m === null) return ["the launcher lost its form, its file list or its run action"];
  const out = [];
  if (Math.abs(m.rowLeft - m.formLeft) > 2)
    out.push(`the file rows start ${Math.abs(m.rowLeft - m.formLeft)}px off the form's column (${m.rowLeft} vs ${m.formLeft})`);
  if (Math.abs(m.runRight - m.bandRight) > 2)
    out.push(`the run action ends ${Math.abs(m.runRight - m.bandRight)}px off the column the list ends at (${m.runRight} vs ${m.bandRight})`);
  return out;
};

const expectNoDeadBand = async (page) => {  const m = await page.evaluate(() => {
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
const page = await browser.newPage({ deviceScaleFactor: SCALE });
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
  expect: expectScanRows,
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
    out.push(...(await expectScrollAffordance(page)));
    // innerText puts each flex child on its own line, so read the row's
    // textContent: span "0/27" -> stats cluster -> the row.
    const rowText = await page.evaluate(() => {
      const span = [...document.querySelectorAll("main span")].find((s) => s.textContent.trim() === "0/27");
      return span ? span.parentElement.parentElement.textContent : null;
    });
    if (!rowText) return ["the legacy session row (0/27) is missing from the fixture"];
    if (/完成/.test(rowText)) out.push(`a legacy session with 27/27 failures is labelled 完成: "${rowText.slice(0, 90)}"`);
    if (!/失败/.test(rowText)) out.push(`the legacy session's failure is not surfaced at all: "${rowText.slice(0, 90)}"`);

    // A resumed session covers completed + reused. Counting only the newly
    // completed files rendered 3/27 — a run that looks like it failed almost
    // everything — while the badge beside it said 完成.
    const reusedText = await page.evaluate(() => {
      const span = [...document.querySelectorAll("main span")].find((s) => s.textContent.trim() === "27/27");
      return span ? span.parentElement.parentElement.textContent : null;
    });
    if (!reusedText) out.push("the resumed session row (27/27) is missing from the fixture");
    else {
      if (!/复用 24/.test(reusedText))
        out.push(`the resumed session does not say that 24 files were reused: "${reusedText.slice(0, 90)}"`);
      if (!/完成/.test(reusedText))
        out.push(`a resumed session whose 27 files are all covered is not labelled 完成: "${reusedText.slice(0, 90)}"`);
    }
    return out;
  },
});
await shoot(page, "07-settings-top", { after: nav("设置"), expect: expectScrollAffordance });
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
  expect: expectScrollAffordance,
});
await shoot(page, "09-results-findings", {
  after: async (page) => {
    await openFindings(page);
    await selectFirstFinding(page);
  },
  expect: all(expectThreePanes, expectCleanSummaries, expectCodeReadAtCommit, expectScrollAffordance, expectHighlightVisible),
});
// A finding long enough to overflow the reading column, which the fixture's
// three-line findings never do. Without this shot every fade assertion over the
// column the app exists to read was a green light wired to nothing — see
// `expectReadingColumnOverflows`. The run path, not 历史: the project summary is
// only carried by a live run's payload — the CLI never persists it — so this is
// the one way to reach both capped regions at once.
await shoot(page, "72-results-long-finding", {
  query: "?longfinding=1&run=done",
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(1600);
    await page.getByRole("button", { name: /开始审查/ }).click();
    await page.waitForTimeout(5200);
  },
  expect: all(expectReadingColumnOverflows, expectSummaryOverflows, expectScrollAffordance, expectHighlightVisible),
});
// The same long content at the window floor, where the reading column is not a
// flex column but a two-row grid (finding above, code below) with
// overflow-hidden. The wide shot cannot see that shape at all: its scroller is
// a different element in a different container, so a regression confined to the
// narrow layout would pass every wide assertion.
await shoot(page, "73-results-long-finding-min", {
  width: 1000,
  height: 660,
  query: "?longfinding=1&run=done",
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(1600);
    await page.getByRole("button", { name: /开始审查/ }).click();
    await page.waitForTimeout(5200);
  },
  expect: all(expectReadingColumnOverflows, expectSummaryOverflows, expectCodeStacked, expectScrollAffordance, expectHighlightVisible),
});
// The same long content in the light theme. Every light shot until now carried
// short findings and a two-line summary, so the fades — gradients that dissolve
// into the surface colour — had never been seen against the light canvas, where
// a wrong tone reads as a grey smear rather than as depth.
await shoot(page, "77-results-long-finding-light", {
  storage: { ...STORAGE, "ocr-theme-pref": "light" },
  query: "?longfinding=1&run=done",
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(1600);
    await page.getByRole("button", { name: /开始审查/ }).click();
    await page.waitForTimeout(5200);
  },
  expect: all(expectReadingColumnOverflows, expectSummaryOverflows, expectScrollAffordance, expectHighlightVisible),
});
// A review at four figures. The largest real session observed was 63 comments
// and the largest fixture 200, so neither the triage list nor 阅读 had ever been
// asked to mount a thousand findings; neither virtualises. These two shots are
// the question, and the assertions are the answer: every finding present, and
// the report's mount inside a budget a reader still calls a page load.
await shoot(page, "74-results-huge", {
  query: "?huge=1",
  after: async (page) => {
    await openFindings(page);
    for (let i = 0; i < 40 && (await countListRows(page)) < 1200; i++) await page.waitForTimeout(250);
    await selectFirstFinding(page);
  },
  expect: all(expectHugeListed, expectScrollAffordance),
});
await shoot(page, "75-report-huge", {
  query: "?huge=1",
  after: async (page) => {
    await openFindings(page);
    for (let i = 0; i < 40 && (await countListRows(page)) < 1200; i++) await page.waitForTimeout(250);
    await page.evaluate(() => {
      window.__t0 = performance.now();
    });
    await page.getByRole("button", { name: "阅读", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("main article").length >= 1200, null, { timeout: 30000 });
    await page.evaluate(() => {
      window.__reportMs = performance.now() - window.__t0;
    });
    await page.waitForTimeout(500);
  },
  expect: all(expectHugeReport, expectScrollAffordance),
});
await shoot(page, "10-review-narrow", { width: 1100, height: 780, expect: expectRunActionVisible });
await shoot(page, "11-settings-narrow", { width: 1100, height: 780, after: nav("设置"), expect: expectScrollAffordance });
await shoot(page, "12-review-xwide", {
  width: 1920,
  height: 1080,
  expect: async (page) => [...(await expectRunActionVisible(page)), ...(await expectOneColumn(page))],
});

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
  expect: all(expectPreviewListed, expectScrollAffordance),
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
  expect: all(expectNoDeadBand, expectRunActionVisible, expectScrollAffordance),
});

// 1000x660 is the window minimum declared in main.js — the tightest the app
// can ever get. The three-column grid cannot be satisfied down here (the
// minimums alone come to ~1180px), so the code folds into the detail column
// rather than being clipped to a third of a line.
await shoot(page, "14-min-review", { width: 1000, height: 660, after: nav("审查"), expect: all(expectRunActionVisible, expectScrollAffordance) });
await shoot(page, "15-min-settings", { width: 1000, height: 660, after: nav("设置"), expect: expectScrollAffordance });
await shoot(page, "16-min-results", {
  width: 1000,
  height: 660,
  after: async (page) => {
    await openFindings(page);
    await selectFirstFinding(page);
  },
  expect: all(expectCodeStacked, expectScrollAffordance, expectHighlightVisible),
});
// `?sessions=many` rather than the default set: at 1000x660 the default history
// is short enough to fit, so the affordance check would pass over a page with
// nothing cut off — the exact vacuity the running-feed shot fell into. The
// narrow window with a full list is the case the rule is for.
await shoot(page, "17-min-history", { width: 1000, height: 660, query: "?sessions=many", after: nav("历史"), expect: expectScrollAffordance });

// The running state of the results page, and a light-theme pass: the type ramp
// touched nearly every text colour, so both themes need eyes on them.
await shoot(page, "18-results-running", {
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /开始审查/ }).click();
    await page.waitForTimeout(1400);
  },
  expect: all(expectRunningFeed, expectRunAnnounced, expectScrollAffordance),
});
// The running screen with a feed that has actually filled.
//
// This is the one state the suite had never rendered, and it is the normal one:
// the recorded transcript is 23 lines, every shot looked at it ~10 rows in, and
// the feed holds ~16 rows at the window floor — so the feed was only ever
// audited with room to spare, and its behaviour when it overflows (a run of
// minutes produces hundreds of tool calls) was unobservable. `expectScrollAffordance`
// was already wired to the shot above and could not fire.
await shoot(page, "69-run-feed-full", {
  width: 1000,
  height: 660,
  query: "?longrun=1",
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /开始审查/ }).click();
    await page.waitForTimeout(2600);
  },
  expect: all(expectFeedOverflows, expectRunAnnounced, expectScrollAffordance),
});
// The log drawer: the raw CLI output the feed summarises, opened by hand. It is
// a sibling of <main>, so nothing had ever rendered it.
await shoot(page, "70-log-drawer", {
  width: 1000,
  height: 660,
  query: "?longrun=1",
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /开始审查/ }).click();
    await page.waitForTimeout(1800);
    await page.getByRole("button", { name: /运行日志/ }).click();
    await page.waitForTimeout(400);
  },
  expect: all(expectLogDrawer, expectScrollAffordance),
});
await shoot(page, "19-light-review", { storage: { ...STORAGE, "ocr-theme-pref": "light" }, after: nav("审查") });
await shoot(page, "20-light-settings", {
  storage: { ...STORAGE, "ocr-theme-pref": "light" },
  after: nav("设置"),
});
await shoot(page, "21-light-findings", {
  storage: { ...STORAGE, "ocr-theme-pref": "light" },
  after: async (page) => {
    await openFindings(page);
    await selectFirstFinding(page);
  },
  expect: all(expectThreePanes, expectHighlightVisible),
});

// Regression guard for silent history truncation: the panel used to ask the CLI
// for 50 sessions and then print "50 条" as if that were the total. Each row
// owns exactly one 「结果」 button, so that is what we count.
await shoot(page, "22-history-many", {
  query: "?sessions=many",
  after: nav("历史"),
  expect: async (page) => {
    const out = [];
    // The history list is the page's only scroller, and it ends flush against
    // the log bar — the same obligation as every other region.
    out.push(...(await expectScrollAffordance(page)));
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
  await shoot(page, name, { query: "?stress=1", after: nav(view), expect: expectScrollAffordance });
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
  expect: all(expectCodeStacked, expectHighlightVisible),
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

    // The file region has to explain *why* nothing entered, not just that — and
    // in 工作区改动 the reason is the working tree, so that is the sentence it
    // must be. (The copy is now per mode; 67 checks the 分支对比 one.)
    const text = await page.locator("main").innerText();
    if (!/共 8 个改动文件/.test(text)) out.push("the empty preview did not report 0 of 8");
    if (!/工作区没有改动时属正常/.test(text)) out.push("no explanation for the empty scope");
    // An empty scope is a dead end unless the sentence that says "改用…" is a
    // control. The prose was there before; the way out was not.
    if ((await page.getByRole("button", { name: "改用分支对比", exact: true }).count()) === 0)
      out.push("the empty scope names an alternative mode but offers no way to switch to it");
    if ((await page.getByRole("button", { name: "改用工作区改动", exact: true }).count()) > 0)
      out.push("the empty scope offers to switch to 工作区改动, which is the mode it is already in");

    // Change the scope: the stale count must go, not linger as if current. The
    // list recomputes itself, so the window to observe that is the debounce.
    // The header's own "共 N 个改动文件" is the proxy — the section itself stays
    // mounted through a recompute, so its title proves nothing.
    const counted = () => page.locator("main").getByText(/个改动文件/).count();
    // `exact` because the empty state now also offers 改用分支对比, and a loose
    // /分支对比/ matches both controls.
    await page.getByRole("button", { name: "分支对比", exact: true }).click();
    await page.waitForTimeout(250);
    if ((await counted()) !== 0) out.push("the preview survived a change of scope, so its count is now stale");
    await page.waitForTimeout(1400);
    if ((await counted()) === 0) out.push("the preview never came back after the scope changed — the list is manual again");

    // And pressing run with nothing to review must explain, not start.
    await page.getByRole("button", { name: "工作区改动", exact: true }).click();
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

// A channel with zero published releases — the state every install is in until
// the first Release exists, transcribed from the real 404 the updater emits for
// a missing latest.yml. Before the phase existed the user got the updater's raw
// words in red, which reads as damage rather than as "nothing has been
// published here yet".
await shoot(page, "76-update-no-release", {
  query: "?update=norelease",
  after: nav("设置"),
  expect: async (page) => {
    const out = [];
    const text = await page.locator("main").innerText();
    if (!/更新渠道尚无任何发布/.test(text)) out.push("the empty-channel state has no sentence of its own");
    if (/检查失败/.test(text)) out.push("an empty channel is still reported as a failed check");
    if ((await page.locator("body").innerText()).includes("已下载完成"))
      out.push("an empty channel is being announced in the banner as a downloaded update");
    return out;
  },
});
// The beat before the renderer's first update pull resolves. The build-type
// suffix used to be a ternary chain over an absent object, which read "unknown"
// as "not packaged" — an installed build opened on 开发模式 until the IPC
// landed, contradicting the 关于 card beside it in the same process.
await shoot(page, "78-settings-update-unknown", {
  query: "?update=none",
  after: nav("设置"),
  expect: async (page) => {
    const text = await page.locator("main").innerText();
    return /开发模式/.test(text) ? ["an unknown build type is rendered as 开发模式 before the first update pull"] : [];
  },
});
// The same class one surface up: the top bar's model badge read a config that
// had not arrived yet as "not configured", so every launch greeted even a fully
// configured machine with 未配置模型 in warning colour.
await shoot(page, "79-topbar-config-unknown", {
  query: "?config=none",
  expect: async (page) => {
    const out = [];
    const text = await page.locator("body").innerText();
    if (/未配置模型/.test(text)) out.push("an unread config is rendered as 未配置模型 in the top bar");
    if (!/读取配置中/.test(text)) out.push("the top bar claims nothing while the config is still loading");
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
    // The sentence used to sit in the 240px list column of the master-detail
    // grid, so the other two panes were bare canvas — two thirds of the window
    // reading as a broken layout rather than as "nothing was found". The same
    // failure is already recorded twice in the backlog (a page that ends in a
    // band of bare canvas), so assert the structure, not just the sentence.
    const shape = await page.evaluate(() => ({
      panes: document.querySelectorAll('main div[class*="grid-cols-[minmax(240px"]').length,
      chips: [...document.querySelectorAll("main button")].filter((b) => /^(严重|高|中|低|未标注)$/.test((b.textContent || "").trim())).length,
    }));
    if (shape.panes)
      out.push(`a clean review still renders the ${shape.panes} master-detail pane(s), leaving blank canvas beside one sentence`);
    if (shape.chips) out.push(`a clean review still shows ${shape.chips} severity filter chips over a list that does not exist`);
    if (!/回审查页换范围/.test(text)) out.push("a clean review does not offer the action that ends it");
    return out;
  },
});

// A run that was cut short by a declared limit is not a clean run, even when
// it found nothing.
//
// Upstream v1.13.1 added the `review_limit_reached` warning: when the main
// loop spends its last tool-request round — or the aggregate token budget — the
// task is sent into a grace round that only offers `code_comment` and
// `task_done`, and the file is recorded as *completed*. The CLI reports such a
// run as a success, and the warning is the only trace of the limit; before
// v1.13.1 not even that existed, and the CLI's own message said "No comments
// generated. Looks good to me." for a run that had been cut off.
//
// The app read "zero findings" as "your code is fine" and rendered it as a
// finished, good result. That is the strongest claim this app makes, and a
// truncated run cannot support it — the promise in the README is that a
// truncated run never looks like a clean one. So the limit is read from the
// CLI's structured signal, not from its English prose, and the empty state
// says what actually happened.
//
// The fixture is the CLI's own shape for it: `status: "complete"`,
// `terminal_state: "complete"`, zero comments, one `review_limit_reached`
// warning. The status is deliberately a success — that is what the CLI reports
// — so nothing but the warning can tell the two apart.
await shoot(page, "80-results-limit-reached", {
  query: "?limit=1&run=done",
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(1600);
    await page.getByRole("button", { name: /开始审查/ }).click();
    await page.waitForTimeout(5200);
  },
  expect: async (page) => {
    const text = await page.locator("main").innerText();
    const out = [];
    if (/这次审查没有提出问题/.test(text))
      out.push("a run that stopped at a review limit is still rendered as a clean review");
    if (!/达到上限/.test(text)) out.push("the run does not say that it stopped at a limit");
    if (!/可能没被审到/.test(text)) out.push("the run does not say that findings may be missing");
    if (!/已达审查上限/.test(text)) out.push("the header does not mark the truncated run");
    // The same shape as a clean review: no master-detail grid over an empty
    // list, and no severity filters over findings that do not exist.
    const shape = await page.evaluate(() => ({
      panes: document.querySelectorAll('main div[class*="grid-cols-[minmax(240px"]').length,
      chips: [...document.querySelectorAll("main button")].filter((b) => /^(严重|高|中|低|未标注)$/.test((b.textContent || "").trim())).length,
    }));
    if (shape.panes) out.push(`a truncated run still renders the ${shape.panes} master-detail pane(s) over an empty list`);
    if (shape.chips) out.push(`a truncated run still shows ${shape.chips} severity filter chips over a list that does not exist`);
    if (!/回审查页换范围/.test(text)) out.push("a truncated run does not offer the action that ends it");
    return out;
  },
});

// The same run, read as a document. The report surface carries its own copy of
// the zero-finding sentence, and the README's own rule is that the two results
// surfaces must not drift — so the limit is asserted on both, not just on the
// one the previous shot happened to open.
await shoot(page, "81-report-limit-reached", {
  query: "?limit=1&run=done",
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(1600);
    await page.getByRole("button", { name: /开始审查/ }).click();
    await page.waitForTimeout(5200);
    await page.getByRole("button", { name: "阅读", exact: true }).click();
    await page.waitForTimeout(600);
  },
  expect: async (page) => {
    const text = await page.locator("main").innerText();
    const out = [];
    if (/这次审查没有提出问题/.test(text))
      out.push("the report still calls a limit-truncated run a clean review");
    if (!/达到上限/.test(text)) out.push("the report does not say that the run stopped at a limit");
    if (!/可能没被审到/.test(text)) out.push("the report does not say that findings may be missing");
    return out;
  },
});

// The code beside a finding has to be the code that was reviewed.
//
// A review names a ref, and its findings describe the code *at that ref*. When
// the file is not in that ref — deleted, renamed, or never committed there —
// the app used to answer with the working tree instead, so the pane showed a
// file the review never saw and the finding beside it looked wrong. So the
// failure has to be visible, and the working tree has to be something the
// reader asks for rather than something that happens to them.
await shoot(page, "82-results-ref-file-missing", {
  query: "?reffile=missing",
  after: openFindings,
  expect: async (page) => {
    const text = await page.locator("main").innerText();
    const out = [];
    if (!/中找不到/.test(text)) out.push("the code pane does not say that the file is missing from the reviewed ref");
    if (!/查看工作区版本/.test(text)) out.push("the code pane offers no way to look at the working tree");
    if (/func \(s \*Service\) Login/.test(text))
      out.push("the working tree was shown in place of the reviewed snapshot");
    return out;
  },
});

// The same failure at the window floor, where the code pane is not a column of
// its own but a row under the finding — and the pane is only ~337px wide
// there. The error text carries a ref name and a path, both unbreakable Latin
// tokens, so this is where a message that overflows sideways would show up.
await shoot(page, "83-results-ref-file-missing-min", {
  width: 1000,
  height: 660,
  query: "?reffile=missing",
  after: openFindings,
  expect: async (page) => {
    const text = await page.locator("main").innerText();
    const out = [];
    if (!/中找不到/.test(text)) out.push("the code pane does not say that the file is missing from the reviewed ref");
    if (!/查看工作区版本/.test(text)) out.push("the code pane offers no way to look at the working tree");
    if (/func \(s \*Service\) Login/.test(text))
      out.push("the working tree was shown in place of the reviewed snapshot");
    return out;
  },
});

// The code beside a finding has to be the code that was reviewed — and "the code
// that was reviewed" is a commit, not a branch name.
//
// A session recorded the *ref* it was given ("main…feat/tenant-rate-limit"), and a
// ref is a name that moves. Reopen the session a week later, after the branch has
// advanced, and the code pane read the branch's current content: a file nobody
// reviewed, next to a finding that was written about a different one.
//
// The CLI already freezes the endpoints before the run and keeps the commits they
// resolved to in the manifest, which `ocr session list --json` hands back
// verbatim — so the reviewed commit is known, and the app has to read it.
await shoot(page, "84-session-pinned-commit", {
  after: async (page) => {
    await openFindings(page);
    await selectFirstFinding(page);
  },
  expect: all(expectCodeReadAtCommit, expectPinnedCommit),
});

// The same pin on the live-run path. A run's own manifest carries the commits
// its endpoints resolved to, so a fresh run reads the exact commit it reviewed
// as well — a branch that moves while the review is still going would otherwise
// shift the code under a finding.
await shoot(page, "85-run-pinned-commit", {
  query: "?run=done",
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(1600);
    await page.getByRole("button", { name: /开始审查/ }).click();
    await page.waitForTimeout(5200);
  },
  expect: all(expectCodeReadAtCommit, expectPinnedCommit),
});

// And on the report, which is the artifact a user forwards to someone else. A
// reader who receives it has to be able to tell which version it is about —
// the scope line names the refs the run was asked for, and those are names.
await shoot(page, "86-report-pinned-commit", {
  after: async (page) => {
    await openFindings(page);
    await selectFirstFinding(page);
    await page.getByRole("button", { name: "阅读", exact: true }).click();
    await page.waitForTimeout(600);
  },
  expect: async (page) => {
    const text = await page.locator("main").innerText();
    const out = [];
    if (!/commit d41c8b7/.test(text)) out.push("the report does not say which commit it is about");
    const title = await page.locator('main span[title="d41c8b7a2e9f6013c5d8a4b6e2f7091c3a5d8e6b4"]').first().getAttribute("title").catch(() => null);
    if (!title) out.push("the report's commit is not kept in full");
    return out;
  },
});

// A run that found something and then hit a limit is still not a complete
// review. The empty-result case is covered by 80/81; when findings are on
// screen the app used to show only a small 已达审查上限 chip in the header, and
// the report said nothing at all — so the one document a user forwards read as
// a complete review of the change. Both surfaces now carry the same band.
await shoot(page, "87-results-limit-reached-with-findings", {
  query: "?limit=1&findings=1&run=done",
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(1600);
    await page.getByRole("button", { name: /开始审查/ }).click();
    await page.waitForTimeout(5200);
  },
  expect: async (page) => {
    const text = await page.locator("main").innerText();
    const out = [];
    if (!/达到上限/.test(text)) out.push("a truncated run with findings does not say that it stopped at a limit");
    if (!/可能没被审到/.test(text)) out.push("the results do not warn that later files may be missing");
    if (!/已达审查上限/.test(text)) out.push("the header does not mark the truncated run");
    if (!/密码校验用了普通的字符串比较/.test(text)) out.push("the findings the run did produce are missing");
    return out;
  },
});

await shoot(page, "88-report-limit-reached-with-findings", {
  query: "?limit=1&findings=1&run=done",
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(1600);
    await page.getByRole("button", { name: /开始审查/ }).click();
    await page.waitForTimeout(5200);
    await page.getByRole("button", { name: "阅读", exact: true }).click();
    await page.waitForTimeout(600);
  },
  expect: async (page) => {
    const text = await page.locator("main").innerText();
    const out = [];
    if (!/这次审查在达到上限时停下/.test(text)) out.push("the report does not say that the run stopped at a limit");
    if (!/可能没被审到/.test(text)) out.push("the report does not warn that later files may be missing");
    if (!/密码校验用了普通的字符串比较/.test(text)) out.push("the report does not contain the findings the run did produce");
    return out;
  },
});

// A session that reused files from its previous run. The CLI counts them as
// covered (`selected = completed + reused + failed`), but reopening it reported
// only the newly completed files: the header said 3 files over a session whose
// 27 files had all been reviewed.
await shoot(page, "89-reused-session-files-reviewed", {
  after: async (page) => {
    await nav("历史")(page);
    await page.waitForTimeout(700);
    await page.evaluate(() => {
      const span = [...document.querySelectorAll("main span")].find((s) => s.textContent.trim() === "复用 24");
      const row = span?.closest("div.flex.flex-wrap");
      [...(row?.querySelectorAll("button") || [])].find((b) => b.textContent.trim() === "结果")?.click();
    });
    await page.waitForTimeout(900);
  },
  expect: async (page) => {
    const text = await page.locator("main").innerText();
    const out = [];
    if (!/27\s*文件/.test(text)) out.push("the reopened resumed session does not count reused files in 文件");
    if (/(^|\s)3\s*文件/.test(text)) out.push("the reopened resumed session counts only the 3 newly reviewed files");
    return out;
  },
});

// A custom gateway with a URL and a model but no Key. Readiness used to be
// derived from the presence of a URL, so this state showed a green top bar and
// an enabled 开始审查; the CLI then failed after the user had committed to a run.
// The missing credential has to be visible before the button is pressed.
await shoot(page, "90-review-url-only-no-key", {
  query: "?nokey=1",
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(1400);
  },
  expect: async (page) => {
    const out = [];
    const header = page.locator("header");
    if (await header.locator(".bg-ok").count()) out.push("the top bar still shows a green ready dot without a credential");
    if (!/缺少 API Key/.test(await header.innerText())) out.push("the top bar does not name the missing credential");
    const btn = page.getByRole("button", { name: /开始审查/ });
    if (!(await btn.count())) out.push("the run action disappeared entirely");
    else if (!(await btn.first().isDisabled())) out.push("a review with a URL but no Key is still offered as clickable");
    const text = await page.locator("main").innerText();
    if (!/缺少 API Key/.test(text)) out.push("the review page does not name the missing credential");
    if (/未选择模型服务/.test(text)) out.push("a selected provider is reported as no provider at all");
    return out;
  },
});

// The truncation a session cannot carry by itself.
//
// The CLI persists coverage and counts, but never warnings, so a run that spent
// its last tool-request round reopened from 历史 as an ordinary complete review:
// the band that says "later files may be missing" existed only on the live
// result. The desktop now records the warning's type and file at exit; opening
// the session has to bring it back, on both results and the report. The
// manifest here still says complete — that is the dishonest reading being
// guarded against.
await shoot(page, "91-session-limit-reached", {
  query: "?sessionlimit=1",
  after: openFindings,
  expect: async (page) => {
    const text = await page.locator("main").innerText();
    const out = [];
    if (!/该会话不等于全量审查/.test(text)) out.push("a reopened truncated session claims to be a complete review");
    if (!/达到上限时停下/.test(text)) out.push("the reopened session does not say that it stopped at a limit");
    if (!/internal\/service\/auth\/login\.go/.test(text)) out.push("the reopened session does not name the file that hit the limit");
    if (!/密码校验用了普通的字符串比较/.test(text)) out.push("the findings survived but the truncation notice did not");
    return out;
  },
});

await shoot(page, "92-report-session-limit-reached", {
  query: "?sessionlimit=1",
  after: async (page) => {
    await openFindings(page);
    await page.getByRole("button", { name: "阅读", exact: true }).click();
    await page.waitForTimeout(600);
  },
  expect: async (page) => {
    const text = await page.locator("main").innerText();
    const out = [];
    if (!/本次报告不等于全量审查/.test(text)) out.push("the forwarded report of a truncated session reads as complete");
    if (!/达到上限时停下/.test(text)) out.push("the report does not say that the run stopped at a limit");
    return out;
  },
});

// The other half of the same promise, from the data the CLI *does* persist: the
// token budget sweeps undispatched items to failed(budget) in the manifest. No
// local diagnostics record is available here (?sessionbudget returns none), so
// this shot proves loadSession derives the truncation from the manifest alone.
await shoot(page, "93-session-budget-truncated", {
  query: "?sessionbudget=1",
  after: openFindings,
  expect: async (page) => {
    const text = await page.locator("main").innerText();
    const out = [];
    if (!/token 预算上限/.test(text)) out.push("a session cut short by the token budget does not name the budget");
    if (!/该会话不等于全量审查/.test(text)) out.push("a budget-truncated session still reads as a complete review");
    if (!/aggregate token budget reached/.test(text)) out.push("the failed item's reason from the manifest is not shown");
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
    if (!/分支对比 main…feat\/tenant-rate-limit/.test(text))
      out.push("the results header never says what the run covered, so two runs are indistinguishable");
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
  // A document someone forwards has to answer "of what was this a review".
  if (!/分支对比 main…feat\/tenant-rate-limit/.test(doc.text))
    out.push("the report does not name the scope it covers");
  if (!doc.scrolls) out.push("the report has no scroller, so a long review cannot be read to the end");
  return out;
};

await shoot(page, "42-report-read", { after: openReport, expect: all(expectReadableDocument, expectScrollAffordance) });
await shoot(page, "43-report-min", { width: 1000, height: 660, after: openReport, expect: all(expectReadableDocument, expectScrollAffordance) });
await shoot(page, "44-report-light", {
  storage: { ...STORAGE, "ocr-theme-pref": "light" },
  after: openReport,
});
await shoot(page, "45-report-stress", { query: "?stress=1", after: openReport });

// The report is the whole review, not the current filter. That is the sentence in
// `expectReadableDocument`'s comment, and nothing checked it: both shots above
// open 阅读 without ever narrowing the list, so pointing the report at `filtered`
// instead of the store's `comments` would have kept the suite green while
// quietly turning the forwardable document into "whatever you last searched
// for". Narrow the list to a single finding first, then read it.
let narrowedTo = -1;
await shoot(page, "71-report-ignores-filter", {
  after: async (page) => {
    await openFindings(page);
    await page.getByPlaceholder(/搜索评论内容/).fill("email");
    await page.waitForTimeout(400);
    narrowedTo = await page.locator("main .grid > div:first-child button").count();
    await page.getByRole("button", { name: "阅读", exact: true }).click();
    await page.waitForTimeout(500);
  },
  expect: async (page) => {
    const out = [];
    // Without this the shot is vacuous: a search that narrowed nothing would let
    // "the report shows 5" pass for the wrong reason.
    if (!(narrowedTo >= 1 && narrowedTo < 5))
      out.push(`the search narrowed the list to ${narrowedTo} of 5 rows, so this shot proves nothing about the filter`);
    const findings = await page.locator("main article").count();
    if (findings !== 5)
      out.push(
        `the report carries ${findings} findings after the list was narrowed to ${narrowedTo} — 阅读 must be the whole run, not the filter`
      );
    return out;
  },
});

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
  expect: all(
    async (page) => {
      const seen = await page.evaluate(() => {
        const list = document.querySelector("main .grid > div:first-child");
        return { rows: list ? list.querySelectorAll("button").length : 0, header: document.querySelector("main").innerText.match(/(\d+) 条评论/)?.[1] || "?" };
      });
      const out = [];
      if (seen.rows < 200) out.push(`the findings list mounted ${seen.rows} of 200 rows`);
      if (seen.header !== "200") out.push(`the header counts ${seen.header} while the list holds ${seen.rows}`);
      return out;
    },
    expectScrollAffordance
  ),
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

// The app's main transition, which no shot walked before: press 开始审查, the
// run finishes, the payload arrives, and the results screen has to take it.
// Every other "results with findings" shot got there through 历史, so the whole
// success path through `onExit` — the jump, the header, the auto-selected worst
// finding, the project summary that only a live run carries — was unrendered.
await shoot(page, "54-run-completes", {
  query: "?run=done",
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(1600);
    await page.getByRole("button", { name: /开始审查/ }).click();
    await page.waitForTimeout(5200);
  },
  expect: async (page) => {
    const text = await page.locator("main").innerText();
    const out = [];
    if (!/完成/.test(text)) out.push("a finished run is not shown as finished");
    if (!/密码校验用了普通的字符串比较/.test(text)) out.push("the finished run did not open on its most severe finding");
    if (!/这次审查的要点/.test(text)) out.push("the CLI's project summary is missing from a live run's results");
    if (!/412,880/.test(text)) out.push("the run's token total is not in the header");
    if (/审查运行中/.test(text)) out.push("the screen still says the run is going after it exited");
    out.push(...(await expectResultAnnounced(page)));
    return out;
  },
});

// A run that fails is the one moment the app has nobody's attention to fall back
// on: the toast is on screen for fifteen seconds and then the evidence is a log
// drawer the user has to know to open. Its title used to be
// `error.split("\\n")[0]` — the CLI's own `Error: no valid LLM endpoint
// configured for provider "deepseek"` — while the sentence written for a person
// sat in the description underneath, in smaller type, below the fold of a glance.
// So the readable line has to be the title, and the CLI's words have to survive
// in the description for whoever needs the provider's own message.
await shoot(page, "88-run-failure-toast", {
  query: "?runfail=1",
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(1600);
    await page.getByRole("button", { name: /开始审查/ }).click();
    await page.waitForTimeout(5200);
  },
  expect: async (page) => {
    const out = [];
    const title = await page
      .locator("[data-sonner-toast] [data-title]")
      .first()
      .innerText()
      .catch(() => "");
    const desc = await page
      .locator("[data-sonner-toast] [data-description]")
      .first()
      .innerText()
      .catch(() => "");
    if (!title) return ["a failed run shows no toast at all"];
    if (/^Error:/.test(title.trim())) out.push(`the toast still leads with the CLI's own line: ${title.slice(0, 60)}`);
    if (!/还没有配置模型服务/.test(title)) out.push(`the actionable hint is not the title: ${title.slice(0, 60)}`);
    if (!/no valid LLM endpoint configured/.test(desc)) out.push("the CLI's own wording is gone from the toast, so the provider's message is nowhere");
    // A failed run must also hand the screen back: nothing may still claim a
    // run is going.
    const body = await page.locator("body").innerText();
    if (/审查运行中/.test(body)) out.push("the screen still says a run is going after it failed");
    // Starting a run moves the app to the results page, so the button that
    // started it is not on screen at this moment — asking for it read as
    // "disabled" and kept this shot red for a reason that had nothing to do
    // with the failure. The contract is that the app is no longer running, and
    // that going back to 审查 finds the button usable again.
    await nav("审查")(page);
    await page.waitForTimeout(600);
    // The button that starts a run has to be usable again — whether it offers
    // a fresh review or the resume of the session the failed run left behind.
    const start = page.getByRole("button", { name: /开始审查|续跑未完成部分/ });
    if ((await start.count()) === 0) out.push("the review page has no run button after the failure");
    else if ((await start.first().isEnabled().catch(() => false)) === false)
      out.push("the run button stayed disabled after the run failed");
    return out;
  },
});

// The truncation evidence is the desktop's own record — the CLI does not persist
// a run's warnings — and a run that hit the limit is only honest on a reopen if
// that record is on disk. When it is not, the reopened session looks clean again
// and nothing on the results screen can say otherwise: the run itself succeeded,
// so there is no error, no red badge, no failed toast. The main process knows
// (it is the one that tried to write the file), so it says so in the exit
// payload, and the app has to say it in the run log — the one surface that
// survives the run and that the user can open. The drawer's own rule is "output
// that looks like trouble opens the drawer", and a lost truncation record is
// exactly that.
await shoot(page, "97-run-diagnostics-lost", {
  query: "?run=done&rundiag=1",
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(1600);
    await page.getByRole("button", { name: /开始审查/ }).click();
    await page.waitForTimeout(5200);
  },
  expect: async (page) => {
    const out = [];
    const text = await page.locator("body").innerText();
    if (!/上限证据保存失败/.test(text)) out.push("the lost truncation evidence is nowhere in the run log");
    if (!/重开会话后将看不到这条提示/.test(text)) out.push("the log does not say what the loss means for the reopened session");
    // The drawer opens itself on output that looks like trouble; a lost
    // truncation record is trouble, and the user is not going to go looking
    // for it.
    const open = await page
      .locator("pre")
      .filter({ hasText: "上限证据保存失败" })
      .count();
    if (!open) out.push("the run log did not open on a lost truncation record");
    return out;
  },
});

// The other half of the same contract: the run finished and the evidence is on
// disk, but the exit signal never reached the screen, so the app still believes
// it is running — the spinner, the disabled button, the "停不下来" state. Nothing
// on the results screen can say that, so the main process says it in the run log,
// and the wording has to be one the drawer's own rule opens on. It used to end on
// 「界面可能仍显示运行中」, which that rule does not match, so the one line about
// a run that will never look finished was the one line behind a shut drawer.
await shoot(page, "98-run-diagnostics-signal-failed", {
  query: "?run=done&rundiag=2",
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(1600);
    await page.getByRole("button", { name: /开始审查/ }).click();
    await page.waitForTimeout(5200);
  },
  expect: async (page) => {
    const out = [];
    const text = await page.locator("body").innerText();
    if (!/结束信号推送失败/.test(text)) out.push("the failed exit signal is nowhere in the run log");
    if (!/界面可能仍显示运行中/.test(text)) out.push("the log does not say what the failed signal means for the screen");
    const open = await page
      .locator("pre")
      .filter({ hasText: "结束信号推送失败" })
      .count();
    if (!open) out.push("the run log did not open on a failed exit signal");
    return out;
  },
});

// The exact invocation is the first thing to read when a run did not do what you
// expected, and it is in no other durable place — the log drawer collapsed, and a
// toast is not selectable. It belongs in the document a run produces.
await shoot(page, "55-report-carries-command", {
  query: "?run=done",
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(1600);
    await page.getByRole("button", { name: /开始审查/ }).click();
    await page.waitForTimeout(5200);
    await page.getByRole("button", { name: "阅读", exact: true }).click();
    await page.waitForTimeout(600);
  },
  expect: async (page) => {
    const text = await page.locator("main").innerText();
    const out = [];
    if (!/ocr review --repo/.test(text)) out.push("the report does not record the command that produced it");
    // The log line already carries the program name, so prefixing it again reads
    // `ocr ocr review …` — which the check above cannot see.
    if (/ocr ocr/.test(text)) out.push("the recorded command doubled its program name");
    if (/\[cmd\]/.test(text)) out.push("the raw log marker leaked into the document");
    return out;
  },
});

// Later in the same run: a comment has landed, and the footer's reassurance that
// "the first few minutes usually produce nothing" now contradicts the counter
// above it. Measured on a real 2m47s run, where that sentence was still on screen
// beside 已产出评论 1.
await shoot(page, "56-running-with-findings", {
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /开始审查/ }).click();
    await page.waitForTimeout(2900);
  },
  expect: async (page) => {
    const text = await page.locator("main").innerText();
    const out = [];
    if (!/已经产出 \d+ 条评论/.test(text)) out.push("the run footer never acknowledges the findings that have arrived");
    if (/一条评论都没有/.test(text)) out.push("the footer still says no comments have arrived while the counter shows some");
    return out;
  },
});

// Switching repositories while a run's findings are on screen. The results
// header exports through the *current* repo, so keeping run A's findings under
// repository B meant 导出 HTML would ask the CLI for A's session inside B.
await shoot(page, "57-repo-switch-clears-results", {
  after: async (page) => {
    await openFindings(page);
    await page.locator("header input").fill("/home/x/work/other-repo");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
  },
  expect: async (page) => {
    const text = await page.locator("main").innerText();
    const out = [];
    if (/密码校验用了普通的字符串比较/.test(text))
      out.push("the previous repository's findings are still on screen after switching repos");
    if (!/还没有结果/.test(text)) out.push("the results screen did not fall back to its empty state");
    return out;
  },
});

// A session that ended partial. `ocr session comments` returns findings only and
// `session list` carries no coverage detail, so the reopened view knows a file
// failed but not which — and a 部分完成 badge over a page that lists nothing as
// missed is exactly the "truncated run looks clean" failure the app promises not
// to have.
await shoot(page, "58-session-partial", {
  after: async (page) => {
    await nav("历史")(page);
    await page.waitForTimeout(700);
    await page.locator("main").getByRole("button", { name: "结果", exact: true }).nth(1).click();
    await page.waitForTimeout(900);
  },
  expect: async (page) => {
    const text = await page.locator("main").innerText();
    const out = [];
    if (!/部分完成|已中断/.test(text)) out.push("a partial session is not labelled as one");
    if (!/个文件没有完成/.test(text)) out.push("the page lists nothing as unreviewed despite a failed file");
    if (!/只有失败的文件数/.test(text)) out.push("the count-only case does not say it cannot name the files");
    return out;
  },
});

// A scope the CLI has already refused: a ref that does not resolve. This was a
// live no-op — the preview failed, `startOrExplain` read the negative count and
// returned without a word, and 开始审查 stayed enabled, so the one action the
// page exists for did nothing and said nothing. `validateSpec` cannot catch it
// (it knows a ref is present, not that it exists), so the preview's own answer
// has to be what disables the button.
await shoot(page, "59-review-bad-ref", {
  query: "?badref=1",
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "分支对比", exact: true }).click();
    await page.waitForTimeout(600);
    await page.getByPlaceholder("feature/x").fill("no-such-branch-xyz");
    await page.waitForTimeout(1800);
  },
  expect: async (page) => {
    const out = [];
    const btn = page.getByRole("button", { name: /开始审查/ }).first();
    if (!(await btn.isDisabled()))
      out.push("a scope the CLI cannot resolve is still offered as a runnable review");
    const text = await page.locator("main").innerText();
    if (!/分支或提交号无法解析/.test(text)) out.push("the page never says what is wrong with the ref");
    if (!/Needed a single revision/.test(text))
      out.push("the CLI's own wording was dropped instead of kept for copying");
    // Half of the contract: a button that never comes back is worse than one
    // that was never disabled. The fixture keys its refusal off the ref, so
    // repairing the field really does repair the preview.
    await page.getByPlaceholder("feature/x").fill("feat/tenant-rate-limit");
    await page.waitForTimeout(2000);
    if (await btn.isDisabled()) out.push("the run action stayed disabled after the ref was fixed");
    return out;
  },
});

// A full scan that finds nothing to read. The list region used to end with
// "工作区没有改动时属正常，可改用「分支对比」或「单个提交」" — advice for a mode
// that looks at diffs, given to someone who had just asked for a whole-repo
// audit — and the header called its file count "改动文件".
await shoot(page, "60-review-scan-empty", {
  query: "?empty=1",
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /全量扫描/ }).first().click();
    await page.waitForTimeout(1600);
  },
  expect: async (page) => {
    const text = await page.locator("main").innerText();
    const out = [];
    if (/工作区没有改动时属正常/.test(text)) out.push("an empty full scan is told to go and make a working-tree change");
    if (/个改动文件/.test(text)) out.push("a full scan's file count is still described as changes");
    if (!/扫描路径/.test(text)) out.push("the empty scan state does not name the control that would fix it");
    return out;
  },
});

// The results list advertises ↑↓ / j k, and on a 200-finding run the list is
// taller than its pane — so the selection has to be brought into view, or the
// keyboard appears to stop working while the detail pane keeps changing to
// findings the reader cannot see the source of.
await shoot(page, "61-results-keyboard-nav", {
  query: "?many=1",
  after: async (page) => {
    await openFindings(page);
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press("j");
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(700);
  },
  expect: async (page) => {
    const m = await page.evaluate(() => {
      const sel = [...document.querySelectorAll("main button")].find((b) => /bg-accent-soft/.test(String(b.className)));
      const scroller = sel && sel.closest("div[class*='overflow-y-auto']");
      if (!sel || !scroller) return null;
      const r = sel.getBoundingClientRect();
      const s = scroller.getBoundingClientRect();
      return {
        row: [Math.round(r.top), Math.round(r.bottom)],
        view: [Math.round(s.top), Math.round(s.bottom)],
        scrollTop: Math.round(scroller.scrollTop),
      };
    });
    if (m === null) return ["the results list has no selected row, or no scroller around it"];
    if (m.row[0] < m.view[0] - 1 || m.row[1] > m.view[1] + 1)
      return [`the keyboard selection sits outside the visible list (row ${m.row.join("-")}, view ${m.view.join("-")}, scrollTop ${m.scrollTop})`];
    return [];
  },
});

// The default scope for 分支对比 must not be a zero-width diff. `inspect` builds
// its candidate bases from `res.refs` (remote prefixes already stripped) but puts
// the raw `res.upstream` first — and `@{upstream}` is *by definition* the current
// branch's own remote (`origin/master` for `master`), so the `c !== branch` guard
// meant to prevent a branch being compared with itself never fired: the prefix
// made it look like a different ref. `from` then collapsed onto `to` and the CLI
// was handed `--from master --to master`, which reviews nothing. The user picked
// 分支对比, pressed the primary action, and got "当前范围没有文件可审查" — the
// app's main function appearing to do nothing.
await shoot(page, "63-range-default-not-empty", {
  after: async (page) => {
    await page.getByRole("button", { name: "分支对比", exact: true }).click();
    await page.waitForTimeout(400);
  },
  expect: async (page) => {
    const from = await page.getByPlaceholder("main").inputValue();
    const to = await page.getByPlaceholder("feature/x").inputValue();
    const out = [];
    // Remote prefixes are how `refs` and `upstream` differ for the same branch,
    // so compare the names the CLI would actually diff.
    const norm = (r) => r.trim().replace(/^(origin|upstream)\//, "");
    if (!from) out.push("分支对比 was pre-filled with no base ref at all");
    else if (norm(from) === norm(to))
      out.push(`the default branch comparison is empty (from="${from}" and to="${to}" are the same ref, so the diff is zero-width)`);
    return out;
  },
});

// The other half of 63. A repository with a single branch has no base to compare
// against, so the honest default is *no* base — and then the app has to say so.
// The failure this guards against is the one the user reported: the primary
// action either runs and produces nothing, or is dead, and the screen never
// explains which. Here the action must be unavailable *and* the reason legible.
await shoot(page, "64-range-no-base-explains", {
  storage: { ...STORAGE, "last-repo": SOLO_REPO_PATH },
  after: async (page) => {
    await page.getByRole("button", { name: "分支对比", exact: true }).click();
    await page.waitForTimeout(400);
  },
  expect: async (page) => {
    const out = [];
    const from = await page.getByPlaceholder("main").inputValue();
    if (from) out.push(`a single-branch repository was given a base ref it does not have ("${from}")`);
    const start = page.getByRole("button", { name: /开始审查/ });
    if (!(await start.isDisabled()))
      out.push("分支对比 is offered as runnable with no base ref, so it would review a zero-width diff");
    const text = await page.locator("main").innerText();
    if (!/还缺基线 \(from\)/.test(text))
      out.push("nothing on the screen says which ref is missing — and (to) is filled, so a message about both would send the reader looking at the wrong field");
    if (/同时填基线/.test(text))
      out.push("the message asks for (from) and (to) together while (to) is already filled");
    return out;
  },
});

// Switching repositories must not carry the previous repository's scope into the
// form. `inspect` fills from/to only while they are empty (`f.from || base`), a
// guard meant to protect what the user typed — but it cannot tell "the user
// typed this" from "this came from the repository we just left", so after one
// switch the range fields went on offering repository A's branch inside B, where
// it does not exist. This is the same class as 57, from the other side: 57
// checked the *results*, this checks the *form*.
await shoot(page, "62-repo-switch-resets-scope", {
  after: async (page) => {
    // Range mode is the one whose fields name a branch, which is a thing that
    // belongs to a repository.
    await page.getByRole("button", { name: "分支对比", exact: true }).click();
    await page.waitForTimeout(300);
    await page.locator("header input").fill(OTHER_REPO_PATH);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
  },
  expect: async (page) => {
    const from = await page.getByPlaceholder("main").inputValue();
    const to = await page.getByPlaceholder("feature/x").inputValue();
    const out = [];
    const stale = "feat/tenant-rate-limit";
    if (from === stale || to === stale)
      out.push(`the previous repository's branch is still in the scope fields (from=${from}, to=${to})`);
    if (to !== "develop") out.push(`the target ref was not re-derived for the new repository (got "${to}", want "develop")`);
    return out;
  },
});

// The scope fields are cleared because they belonged to the repository that was
// *left*, so re-opening the repository already open must not clear them. The
// browse button goes through `pickRepo`, which calls `setRepo` directly and so
// bypasses the top bar's own "did it actually change?" guard — and the fixture
// returns the repository that is already open, which is the only way to reach
// this branch from the harness at all.
await shoot(page, "65-same-repo-keeps-scope", {
  after: async (page) => {
    await page.getByRole("button", { name: "分支对比", exact: true }).click();
    await page.waitForTimeout(300);
    await page.getByPlaceholder("feature/x").fill("release/2.4");
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "浏览", exact: true }).click();
    await page.waitForTimeout(1000);
  },
  expect: async (page) => {
    const to = await page.getByPlaceholder("feature/x").inputValue();
    if (to !== "release/2.4")
      return [`re-inspecting the repository already open discarded a hand-typed ref (got "${to}", want "release/2.4")`];
    return [];
  },
});

// The direction of the default 分支对比 scope, which 63 does not check.
//
// 63 proves the base is not the same ref as the target — but the CLI's diff is
// not symmetric: `A...B` is empty exactly when B is an ancestor of A. So a base
// that is *ahead* of HEAD diffs to nothing just as surely as a base equal to it.
// `inspect` used to take "any ref that is not the current branch", which on the
// base branch means a branch that is ahead — `--from feature/x --to master`,
// merge-base against master, zero files. The user picked 分支对比, pressed the
// primary action, and got "当前范围 0 个文件" with no explanation. The base must
// be the branch under review's own base, and the target the branch that is ahead.
await shoot(page, "66-range-on-base-branch", {
  query: "?onbase=1",
  storage: { ...STORAGE, "last-repo": BASE_REPO_PATH },
  after: async (page) => {
    await page.getByRole("button", { name: "分支对比", exact: true }).click();
    await page.waitForTimeout(400);
  },
  expect: async (page) => {
    const from = await page.getByPlaceholder("main").inputValue();
    const to = await page.getByPlaceholder("feature/x").inputValue();
    const out = [];
    if (from !== "master")
      out.push(`the default base is not the branch under review's base (got from="${from}", want "master")`);
    if (to !== "feature/rate-limit")
      out.push(`the default target does not name the branch that is ahead (got to="${to}", want "feature/rate-limit")`);
    return out;
  },
});

// What an empty 分支对比 says. The empty-scope sentence was written for
// 工作区改动 and then shown to every mode, so a range with no diff was told to
// "改用「分支对比」或「单个提交」" — the mode it was already in — and a reader had
// no way to learn that the two refs were simply the wrong way round.
await shoot(page, "67-range-empty-explains", {
  query: "?empty=1",
  after: async (page) => {
    await page.getByRole("button", { name: "分支对比", exact: true }).click();
    await page.waitForTimeout(1200);
  },
  expect: async (page) => {
    const text = await page.locator("main").innerText();
    const out = [];
    if (!/这两个 ref 之间没有差异/.test(text))
      out.push("an empty 分支对比 does not say the two refs are identical, so nothing explains why no file is listed");
    if (/可改用「分支对比」/.test(text))
      out.push("an empty 分支对比 is told to switch to 分支对比, which is the mode it is already in");
    // The way out has to be a control, and it must not offer the mode the user
    // is already in — the exact failure the prose had.
    if ((await page.getByRole("button", { name: "改用工作区改动", exact: true }).count()) === 0)
      out.push("an empty 分支对比 offers no way to switch to a mode that could have content");
    if ((await page.getByRole("button", { name: "改用分支对比", exact: true }).count()) > 0)
      out.push("an empty 分支对比 offers to switch to 分支对比, which is the mode it is already in");
    return out;
  },
});

// 单个提交 was the one primary mode no shot had ever rendered — four modes,
// three of them covered, and this one also the only one that opened with its
// required field empty. A mode nothing renders is a mode nothing checks: the
// form could have lost its pre-fill, or the run button could have gone dead,
// and every screenshot would still be green.
await shoot(page, "68-commit-mode-ready", {
  after: async (page) => {
    await page.getByRole("button", { name: "单个提交", exact: true }).click();
    await page.waitForTimeout(1400);
  },
  expect: async (page) => {
    const out = [];
    const commit = await page.getByPlaceholder("abc1234").inputValue();
    if (!commit) out.push("单个提交 opened with no commit, so the mode cannot be run at all");
    if (await page.getByRole("button", { name: /开始审查/ }).isDisabled())
      out.push("单个提交 is not runnable even though the repository has commits");
    const text = await page.locator("main").innerText();
    if (/请填写要审查的提交号/.test(text))
      out.push("the page still asks for a commit while the field already names one");
    // One form column, like the range refs. Across the full measure the
    // resolved-SHA tick that confirms the value sits ~700px away from it, which
    // is the "label and value 900px apart" failure the layout spec forbids.
    const geo = await page.evaluate(() => {
      const input = [...document.querySelectorAll("main input")].find((i) => i.placeholder === "abc1234");
      let measure = null;
      for (const el of document.querySelectorAll("main *")) {
        const mw = parseFloat(getComputedStyle(el).maxWidth);
        if (Number.isFinite(mw) && mw >= 480 && mw <= 1200) {
          measure = el.getBoundingClientRect().width;
          break;
        }
      }
      if (!input || !measure) return null;
      return { input: input.getBoundingClientRect().width, measure };
    });
    if (geo && geo.input > geo.measure * 0.62)
      out.push(
        `the commit field runs ${Math.round(geo.input)}px of a ${Math.round(geo.measure)}px measure — a single-value field belongs in one column, as the range refs are`
      );
    return out;
  },
});

// The model box belongs to the service named in the picker. Switching the
// picker used to leave the previous service's model in the box, so
// "选 anthropic → 保存" wrote DeepSeek's model into anthropic — a config that
// reads as complete and only fails once a review starts. The box now follows
// the picker, and a service with nothing saved gets an empty box rather than
// someone else's model.
let pickerTrace = null;
await shoot(page, "94-settings-picker-model", {
  after: async (page) => {
    await nav("设置")(page);
    await page.waitForTimeout(400);
    const trigger = page.locator('main [role="combobox"]').first();
    const field = page.getByPlaceholder("deepseek-v4-pro");
    const pick = async (label) => {
      await trigger.click();
      await page.waitForTimeout(150);
      await page.getByRole("option", { name: label }).click();
      await page.waitForTimeout(250);
      return field.inputValue();
    };
    const active = await field.inputValue();
    const saved = await pick(/^anthropic/);
    const blank = await pick(/^openai/);
    const back = await pick(/^anthropic/);
    pickerTrace = { active, saved, blank, back };
  },
  expect: async () => {
    const out = [];
    const t = pickerTrace;
    if (!t) return ["the picker never ran, so nothing about the model field was verified"];
    if (t.active !== "deepseek-v4-pro")
      out.push(`the active service's model is not in the box to begin with: "${t.active}"`);
    if (t.saved !== "claude-sonnet-4-5")
      out.push(`switching to anthropic left "${t.saved}" in the model box instead of its saved model claude-sonnet-4-5`);
    if (t.blank !== "")
      out.push(`switching to an unconfigured service kept "${t.blank}" in the model box, so saving would write another service's model`);
    if (t.back !== "claude-sonnet-4-5")
      out.push(`switching back to anthropic did not restore its model: "${t.back}"`);
    return out;
  },
});

// A run that failed partway is not the same failure for every cause, and the
// app used to say only 失败. `manifest.run_failure` has carried the CLI's own
// classification since v1.13.0, and neither results surface read it — so "the
// model service refused every retry", "this machine has no usable config" and
// "the token budget ran out" were the same red badge, even though the next
// thing a reader does is different for each (retry later / go to 设置 / raise
// the budget). The classification is mapped to Chinese.
//
// The CLI's own reason is a separate thing: it is English prose naming the
// provider and the HTTP status, and it is the line that says whether to retry
// or to fix something. It used to live in a tooltip only — out of reach for
// touch and for a keyboard, and absent from the report, which is the document
// people forward. So it is written out, labelled as the CLI's words.
//
// The fixture keeps the two halves upstream keeps apart: run_failure forces
// terminal_state failed, while the files that did complete keep their findings
// and carry their own (per-file) class.
await shoot(page, "95-results-run-failure-timeout", {
  query: "?failure=timeout&run=done",
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(1600);
    await page.getByRole("button", { name: /开始审查/ }).click();
    await page.waitForTimeout(5200);
  },
  expect: async (page) => {
    const text = await page.locator("main").innerText();
    const out = [];
    if (!/失败原因：超时/.test(text)) out.push("the results header does not say why the run failed");
    if (!/global review deadline of 30m/.test(text))
      out.push("the CLI's own reason for the failure is not written out on the results screen");
    // The per-file class is the visible text now; the CLI's per-file prose is
    // the tooltip. A reader has to be able to see *what kind* of failure each
    // file hit without hovering anything.
    if (!/未审/.test(text)) out.push("the failed files are not listed at all");
    if (!/模型服务出错/.test(text)) out.push("the per-file failure class is not visible text");
    if (!(await page.locator('main span[title*="429 Too Many Requests"]').count()))
      out.push("the per-file failure reason is not readable anywhere");
    if (!/密码校验用了普通的字符串比较/.test(text)) out.push("the findings the run did produce are missing from the failed run");
    return out;
  },
});

// The same on the reading surface, with the other classification: the report is
// the document a user forwards, and one that says 失败 without saying why
// invites the wrong fix. The reason travels with the document — it is the part
// a colleague reading the forwarded report cannot get from a tooltip.
await shoot(page, "96-report-run-failure-budget", {
  query: "?failure=budget&run=done",
  after: async (page) => {
    await nav("审查")(page);
    await page.waitForTimeout(1600);
    await page.getByRole("button", { name: /开始审查/ }).click();
    await page.waitForTimeout(5200);
    await page.getByRole("button", { name: "阅读", exact: true }).click();
    await page.waitForTimeout(600);
  },
  expect: async (page) => {
    const text = await page.locator("main").innerText();
    const out = [];
    if (!/失败原因：预算用尽/.test(text)) out.push("the report does not say why the run failed");
    if (!/aggregate token budget exhausted/.test(text))
      out.push("the report does not write out the CLI's own reason for the failure");
    if (!/预算用尽/.test(text)) out.push("the report does not name the class of the failure");
    if (!/密码校验用了普通的字符串比较/.test(text)) out.push("the report lost the findings the run did produce");
    return out;
  },
});

// The Key field when the lookup that decides "may I leave the Key blank?"
// never answers. The renderer used to drop the answer and fall back to the
// sentence it always used to show — "已保存：…　留空表示保持不变" — which is a
// promise nothing has checked: the lookup is exactly the thing that says
// whether the saved Key will be used for this endpoint. So the failure has to
// show as a failure: the form does not know, and 刷新 asks again.
//
// The other wrong answer is just as bad and just as easy to fall into: "该服务
// 还没有 Key" sends the user to type one that may already be in the config.
await shoot(page, "99-settings-savedkey-ipc-fail", {
  query: "?savedkey=ipc-fail",
  after: nav("设置"),
  expect: async (page) => {
    const text = await page.locator("main").innerText();
    const out = [];
    if (!/无法确认是否已有可用的 Key/.test(text)) out.push("a lookup that did not answer is not shown as a failure");
    if (/留空表示保持不变/.test(text)) out.push("the form still promises the saved Key will be reused after a failed lookup");
    if (/该服务还没有 Key/.test(text)) out.push("the form still claims there is no Key after a failed lookup");
    return out;
  },
});

await browser.close();
server.close();

// A harness that prints FAIL and then exits 0 is a harness CI will happily
// ignore. Report the tally and fail loudly.
const filtered = skipped.length > 0;
console.log(
  `\n${passed.length} ok, ${failed.length} failed` +
    (filtered ? `, ${skipped.length} skipped (SHOT=${ONLY})` : "") +
    `  (${describeChannel()}${SCALE === 1 ? "" : `, deviceScaleFactor ${SCALE}`})`
);
console.log("shots ->", SHOTS);
// A filter that matches nothing is a typo, not a pass: reporting "0 ok, 0
// failed" and exiting 0 would let a misspelt SHOT read as a green build.
if (filtered && passed.length === 0 && failed.length === 0) {
  console.error(`\nSHOT=${ONLY} matched no shots — nothing was verified`);
  process.exit(1);
}
if (filtered) console.warn(`filtered run — only shots matching "${ONLY}" were verified; this is not a full green`);
if (failed.length) {
  console.error(`\nlayout assertions failed: ${failed.join(", ")}`);
  process.exit(1);
}
