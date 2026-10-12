// WCAG contrast audit. Walks every rendered text node in all five views, in both
// themes, resolves the effective background behind it, and reports pairs below
// the AA thresholds. Rendered images are hard to judge by eye, so this reports
// ratios instead of opinions. Run with `npm run audit:contrast` after a build.
import { BRIDGE, STORAGE, serve } from "./fixtures.mjs";
import { loadPlaywright, CHANNEL, describeChannel, requireBuilt } from "./playwright.mjs";

requireBuilt();
const { chromium } = await loadPlaywright();

const PORT = 5196;

// Injected into the page: collect one row per element that directly owns text.
const COLLECT = `(() => {
  const lin = (c) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const parse = (s) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(s);
    if (!m) return null;
    const p = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
    return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg) => fg.rgb.map((c, i) => Math.round(c * fg.a + bg[i] * (1 - fg.a)));
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  };
  const bgOf = (el) => {
    // Collect the layers from the element outward, then composite from the
    // outermost inward. Compositing the innermost semi-transparent layer over
    // white first — as an earlier version did — invents a background that never
    // existed, which is precisely the dark-theme case: a tinted card sitting on
    // a near-black canvas would be scored against white.
    const chain = [];
    for (let node = el; node; node = node.parentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0) chain.push(c);
      if (c && c.a >= 1) break;
    }
    let acc = [255, 255, 255];
    for (let i = chain.length - 1; i >= 0; i--) acc = over(chain[i], acc);
    return acc;
  };

  const rows = [];
  for (const el of document.querySelectorAll("*")) {
    const text = [...el.childNodes]
      .filter((n) => n.nodeType === 3 && n.textContent.trim())
      .map((n) => n.textContent.trim())
      .join(" ");
    if (!text) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.5) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const fg = parse(cs.color);
    if (!fg || fg.a === 0) continue;
    const bg = bgOf(el);
    const size = parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || 400;
    // WCAG "large text": >=24px, or >=18.66px when bold.
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    rows.push({
      text: text.slice(0, 40),
      color: cs.color,
      bg: "rgb(" + bg.join(", ") + ")",
      size,
      weight,
      ratio: Math.round(ratio(over(fg, bg), bg) * 100) / 100,
      need: large ? 3 : 4.5,
      cls: (el.className && typeof el.className === "string" ? el.className : "").slice(0, 90),
    });
  }
  return rows;
})()`;

const server = await serve(PORT);
const browser = await chromium.launch({ channel: CHANNEL });

const VIEWS = [
  { name: "review", nav: null },
  { name: "settings", nav: "设置" },
  { name: "history", nav: "历史" },
  { name: "results", nav: "历史", then: "main:/结果/" },
  // The reading view is the widest block of prose in the app, so it is the place
  // a muted-on-surface step would first fail real reading.
  { name: "report", nav: "历史", then: "main:/结果/", then2: "阅读" },
];

const findings = [];
let scanned = 0;

for (const theme of ["light", "dark"]) {
  for (const view of VIEWS) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(BRIDGE);
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "load" });
    await page.evaluate(
      (s) => {
        for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
      },
      { ...STORAGE, "ocr-theme-pref": theme }
    );
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(700);

    if (view.nav) {
      await page.getByRole("button", { name: view.nav, exact: true }).click();
      await page.waitForTimeout(500);
    }
    if (view.then) {
      await page.locator("main").getByRole("button", { name: /结果/ }).first().click();
      await page.waitForTimeout(900);
      await page.locator("main").getByRole("button", { name: /密码校验/ }).first().click();
      await page.waitForTimeout(900);
    }
    if (view.then2) {
      await page.getByRole("button", { name: view.then2, exact: true }).click();
      await page.waitForTimeout(600);
    }

    const rows = await page.evaluate(COLLECT);
    scanned += rows.length;
    for (const r of rows) {
      if (r.ratio < r.need) findings.push({ theme, view: view.name, ...r });
    }
    await page.close();
  }
}

await browser.close();
server.close();

// Collapse to unique (theme, colour pair, size, weight) combinations — the same
// token pair is reused dozens of times and would otherwise flood the report.
const groups = new Map();
for (const f of findings) {
  const key = [f.theme, f.color, f.bg, f.size, f.weight].join(" | ");
  const g = groups.get(key) || { ...f, n: 0, samples: [] };
  g.n += 1;
  if (g.samples.length < 3 && !g.samples.includes(f.text)) g.samples.push(f.text);
  g.views = g.views ? g.views : new Set();
  g.views.add(f.view);
  groups.set(key, g);
}

const sorted = [...groups.values()].sort((a, b) => a.ratio - b.ratio);
// A harness that reports "0 problems" because it inspected nothing is worse
// than no harness: it manufactures confidence. Always state the sample size,
// and refuse to pass vacuously.
console.log(`\nscanned ${scanned} text instances across ${VIEWS.length * 2} theme/view combos  (${describeChannel()})`);
console.log(`${findings.length} sub-AA text instances, ${sorted.length} unique colour/size combos\n`);
if (scanned === 0) {
  console.error("HARNESS BROKEN: the collector matched no text at all.");
  process.exit(1);
}
for (const g of sorted) {
  console.log(
    `${String(g.ratio).padStart(5)}:1 (need ${g.need})  ${g.theme.padEnd(5)} ${String(g.size).padStart(5)}px w${g.weight}  x${String(g.n).padStart(3)}  [${[...g.views].join(",")}]`
  );
  console.log(`         fg ${g.color}  on  ${g.bg}`);
  console.log(`         e.g. ${g.samples.map((s) => JSON.stringify(s)).join(", ")}`);
  if (g.cls) console.log(`         cls  ${g.cls}`);
  console.log();
}
// Same reasoning as the layout harness: findings must fail the gate, not just
// decorate the log.
if (findings.length) process.exit(1);
