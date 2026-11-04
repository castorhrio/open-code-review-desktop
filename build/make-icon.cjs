// SPDX-License-Identifier: Apache-2.0
"use strict";
// The app icon, drawn from geometry instead of converted from a raster render.
//
// Why this exists at all: an app icon is the one piece of the product a user
// meets before any of the UI — the Windows taskbar entry, the desktop shortcut,
// the installer header, the title bar. Nothing in `npm run audit` can see it, so
// it is exactly the kind of surface that rots quietly.
//
// What the previous version produced (a 2026-10 AI render, `build/icon-source.png`,
// thresholded and recoloured by this script) measured, at 1024px:
//
//   - the glyph sat at 1.38:1 against the squircle behind it (fill #172032,
//     stroke #283848) — below the 3:1 a non-text graphic needs, and far below
//     anything a taskbar-sized copy can show;
//   - every stroke was 1–2px at 1024, i.e. 0.03px at 16 — the shape disappeared
//     when Windows shrank it, leaving a nearly blank dark square;
//   - the lens was full of AI-render detail (text-like rows, blocks) which reads
//     as dirt once the icon is 32px or smaller.
//
// So the icon is now drawn: a squircle, a magnifier ring and a handle, in the
// app's own palette, with the stroke widened on small sizes and the lens tint
// dropped there — the two things a downscale cannot do for itself. Everything
// here is arithmetic on a supersampled grid: no source image, no filter pass, no
// text, no external asset. Same input, same bytes, every run.
//
// Geometry is expressed as fractions of the side, so one set of numbers serves
// every output size.
//
// The palette is *read* from `src/styles.css` (dark theme: `--raised`, `--ink`,
// `--accent`) instead of copied into this file. A copy is the shape this repo
// treats as red: the same fact declared twice, and the copy is the one nobody
// updates. An icon that is not the same blue as the app reads as someone else's
// product next to it, so the colour is derived at run time; if the CSS renames a
// variable or drops one, this script stops with a sentence naming it rather than
// drawing an icon in a stale colour. `tools/icon-rules.mjs` asserts the two
// sources agree (it re-parses the dark block itself and compares), and asserts
// the products themselves — ICO header, per-size PNG sides, 16px legibility.
//
// Everything that decides a pixel is exported and side-effect free
// (`strokeFor`, the signed-distance helpers, `coverage`, `paletteFromCss`), so
// `tools/icon-rules-smoke.mjs` can ask questions without rendering an image or
// writing a file. `main()` runs only when this file is executed directly.

const fs = require("fs");
const path = require("path");

const OUT_DIR = path.resolve(__dirname);
const REPO_DIR = path.resolve(__dirname, "..");
const STYLE_FILE = path.join(REPO_DIR, "src", "styles.css");

// `--canvas` (0.20) is the corner radius of the squircle; the magnifier is
// deliberately placed up-left of centre so the squircle's own corners read as
// padding rather than as a mis-centred glyph.
const GEOMETRY = {
  cornerRadius: 0.2,
  lens: { cx: 0.45, cy: 0.44, outerRadius: 0.27 },
  // Stroke width as a fraction of the side. Two ends, because one number cannot
  // serve both: at 1024 a 0.120 stroke is 123px (a slab), at 16 a 0.086 stroke
  // is 1.4px (a grey smear). `strokeFor` interpolates between them.
  strokeAtLarge: 0.086,
  strokeAtSmall: 0.12,
  strokeLargeFrom: 48,
  strokeSmallUntil: 16,
  // Handle runs to the lower-right at 45°, from the ring's mid-line out.
  handleEnd: { x: 0.77, y: 0.76 },
  // Below this the lens is left as flat fill: a 3px tinted disc inside a 2px
  // ring is noise, not glass.
  lensTintFrom: 32,
};

// Which CSS variable feeds which part of the glyph. The dark theme block in
// `src/styles.css` is `:root, [data-theme="dark"] { … }` and comes first, so
// "first declaration of that variable in the file" is the dark value; the light
// block below it is never reached (`src/styles.css` line 128 onwards).
const THEME_VARIABLES = Object.freeze({
  fill: "--raised",
  glyph: "--ink",
  lens: "--accent",
});

const CSS_COLOUR = /^\s*(--[a-z-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/;

/** Every `--name: #rrggbb;` declaration in the sheet, first declaration wins. */
const styleColours = (css) => {
  const found = new Map();
  for (const line of String(css == null ? "" : css).split(/\r?\n/)) {
    const hit = CSS_COLOUR.exec(line);
    if (!hit) continue;
    if (found.has(hit[1])) continue;
    found.set(hit[1], hit[2].toLowerCase());
  }
  return found;
};

const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/**
 * The three colours the glyph is drawn with, parsed out of the stylesheet.
 *
 * Throws (with a sentence naming the variable) when one is missing: an icon
 * drawn in a default colour is worse than no icon, because it is wrong without
 * looking wrong. The CLI turns that into `exit(1)`, and `tools/icon-rules.mjs`
 * reports it as a violation instead of a stack trace.
 */
const paletteFromCss = (css, source = path.relative(REPO_DIR, STYLE_FILE)) => {
  const colours = styleColours(css);
  const missing = Object.values(THEME_VARIABLES).filter((name) => !colours.has(name));
  if (missing.length) {
    throw new Error(
      `${source} 里没找到 ${missing.join(" / ")}：图标的三色（--raised / --ink / --accent）从这里解析，` +
        "变量被改名或删掉时这个脚本不会退回到写死的颜色——先把变量补回去，或改 THEME_VARIABLES"
    );
  }
  return Object.fromEntries(
    Object.entries(THEME_VARIABLES).map(([part, name]) => [part, hexToRgb(colours.get(name))])
  );
};

const readPalette = () => paletteFromCss(fs.readFileSync(STYLE_FILE, "utf8"));

// Resolved once at load: every render uses the same three colours, and requiring
// this file from a gate fails loudly when the stylesheet no longer answers.
const PALETTE = readPalette();

const ICO_SIZES = [256, 128, 64, 48, 32, 16];
const APP_ICON_SIZE = 512; // `main.js` window icon (Linux / title bar)
const BUILDER_ICON_SIZE = 1024; // electron-builder wants >= 512 for its own conversions
const SUPERSAMPLE = 4; // 4x4 subpixels per output pixel, each with its own edge coverage

const strokeFor = (size) => {
  if (size <= GEOMETRY.strokeSmallUntil) return GEOMETRY.strokeAtSmall;
  if (size >= GEOMETRY.strokeLargeFrom) return GEOMETRY.strokeAtLarge;
  const t =
    (size - GEOMETRY.strokeSmallUntil) / (GEOMETRY.strokeLargeFrom - GEOMETRY.strokeSmallUntil);
  return GEOMETRY.strokeAtSmall + (GEOMETRY.strokeAtLarge - GEOMETRY.strokeAtSmall) * t;
};

// ---- signed distances, in fractions of the side (negative = inside) ----
// Written out rather than pulled from a library: three shapes, no dependency,
// and the numbers stay readable next to the geometry they belong to.

const sdRoundRect = (x, y, halfSide, radius) => {
  const qx = Math.abs(x - 0.5) - (halfSide - radius);
  const qy = Math.abs(y - 0.5) - (halfSide - radius);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius;
};

const sdCircle = (x, y, cx, cy, radius) => Math.hypot(x - cx, y - cy) - radius;

const sdSegment = (x, y, ax, ay, bx, by) => {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = x - ax;
  const wy = y - ay;
  const len = vx * vx + vy * vy;
  const t = len === 0 ? 0 : Math.min(1, Math.max(0, (wx * vx + wy * vy) / len));
  return Math.hypot(wx - t * vx, wy - t * vy);
};

// One subpixel's coverage of a shape, over a single subpixel of edge width.
const coverage = (distance, subpixel) => {
  const c = 0.5 - distance / subpixel;
  return c <= 0 ? 0 : c >= 1 ? 1 : c;
};

const mix = (from, to, t) => [
  from[0] + (to[0] - from[0]) * t,
  from[1] + (to[1] - from[1]) * t,
  from[2] + (to[2] - from[2]) * t,
];

// Renders one size. `size` is the real output edge; the geometry is the same at
// every size, only `strokeFor(size)` and the lens tint change.
const renderIcon = (size) => {
  const Jimp = require("jimp");
  const stroke = strokeFor(size);
  const { cx, cy, outerRadius } = GEOMETRY.lens;
  const ringMid = outerRadius - stroke / 2;
  const lensInner = outerRadius - stroke;
  const handHalf = stroke / 2;
  const startRadius = ringMid;
  const diagonal = Math.SQRT1_2;
  const handStart = {
    x: cx + diagonal * startRadius,
    y: cy + diagonal * startRadius,
  };
  const tinted = size >= GEOMETRY.lensTintFrom;

  const grid = size * SUPERSAMPLE;
  const subpixel = 1 / grid;
  const colour = new Float64Array(size * size * 3);
  const alpha = new Float64Array(size * size);

  for (let gy = 0; gy < grid; gy++) {
    const y = (gy + 0.5) * subpixel;
    for (let gx = 0; gx < grid; gx++) {
      const x = (gx + 0.5) * subpixel;

      const shape = coverage(sdRoundRect(x, y, 0.5, GEOMETRY.cornerRadius), subpixel);
      if (shape <= 0) continue;

      let rgb = PALETTE.fill;
      if (tinted) {
        const lens = coverage(sdCircle(x, y, cx, cy, lensInner), subpixel);
        if (lens > 0) rgb = mix(rgb, PALETTE.lens, lens);
      }
      const ring = coverage(Math.abs(sdCircle(x, y, cx, cy, ringMid)) - stroke / 2, subpixel);
      const handle = coverage(
        sdSegment(x, y, handStart.x, handStart.y, GEOMETRY.handleEnd.x, GEOMETRY.handleEnd.y) -
          handHalf,
        subpixel
      );
      const glyph = Math.max(ring, handle);
      if (glyph > 0) rgb = mix(rgb, PALETTE.glyph, glyph);

      const cell = ((gy / SUPERSAMPLE) | 0) * size + ((gx / SUPERSAMPLE) | 0);
      alpha[cell] += shape;
      colour[cell * 3] += shape * rgb[0];
      colour[cell * 3 + 1] += shape * rgb[1];
      colour[cell * 3 + 2] += shape * rgb[2];
    }
  }

  const samples = SUPERSAMPLE * SUPERSAMPLE;
  const data = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const a = alpha[i] / samples;
    const o = i * 4;
    if (a <= 0) continue;
    // Un-premultiply: colour was accumulated weighted by each subpixel's own
    // coverage, so dividing by the summed coverage keeps edges from darkening.
    const w = alpha[i];
    data[o] = Math.round(colour[i * 3] / w);
    data[o + 1] = Math.round(colour[i * 3 + 1] / w);
    data[o + 2] = Math.round(colour[i * 3 + 2] / w);
    data[o + 3] = Math.round(a * 255);
  }
  return new Jimp({ width: size, height: size, data });
};

// png-to-ico ships as ESM interop: the callable lives on .default (v3 also
// exposes imagesToIco for the multi-size case).
const loadPngToIco = () => {
  const icoModule = require("png-to-ico");
  return typeof icoModule === "function" ? icoModule : icoModule.default || icoModule.imagesToIco;
};

const writePng = async (size, file) => {
  const img = renderIcon(size);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await img.writeAsync(file);
  const bytes = fs.statSync(file).size;
  console.log(`wrote ${path.relative(REPO_DIR, file)} (${size}x${size}, ${bytes} bytes)`);
  return file;
};

async function main() {
  if (process.argv[2]) {
    // The raster path is gone on purpose: `build/icon-source.png` measured
    // 1.38:1 glyph-on-fill and could not be fixed by any post-processing. Say so
    // instead of silently ignoring an argument someone still has in muscle memory.
    console.error(
      "这个脚本现在按几何画图标，不再需要源图参数：直接跑 `npm run icon`。\n" +
        "（旧的 `build/icon-source.png` 是一张对比度 1.38:1 的暗色渲染，改成阈值 / 调色救不回来。）"
    );
    process.exit(1);
  }

  const builderIcon = await writePng(BUILDER_ICON_SIZE, path.join(OUT_DIR, "icon.png"));
  await writePng(APP_ICON_SIZE, path.join(REPO_DIR, "assets", "icon.png"));

  // Per-size renders, not downscales of the 1024: `strokeFor` gives 16 and 32 a
  // thicker ring, which a resize from the big copy cannot produce. This is the
  // whole reason the .ico is generated here rather than left to electron-builder.
  const pngToIco = loadPngToIco();
  const tmp = path.join(OUT_DIR, ".ico-tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const files = await Promise.all(
    ICO_SIZES.map((size) => writePng(size, path.join(tmp, `icon-${size}.png`)))
  );
  const ico = await pngToIco(files.map((f) => fs.readFileSync(f)));
  fs.writeFileSync(path.join(OUT_DIR, "icon.ico"), ico);
  files.forEach((f) => fs.unlinkSync(f));
  fs.rmdirSync(tmp);
  console.log(
    `wrote build/icon.ico (${ico.length} bytes, sizes ${ICO_SIZES.join(",")}; ` +
      `stroke ${ICO_SIZES.map((s) => `${s}:${(strokeFor(s) * s).toFixed(2)}px`).join(" ")}）`
  );
  console.log(
    `source: this file's GEOMETRY + src/styles.css ` +
      `(fill ${PALETTE.fill.map((n) => n.toString(16).padStart(2, "0")).join("")}, ` +
      `glyph ${PALETTE.glyph.map((n) => n.toString(16).padStart(2, "0")).join("")}, ` +
      `lens ${PALETTE.lens.map((n) => n.toString(16).padStart(2, "0")).join("")}); ` +
      `build/icon.png is ${builderIcon ? BUILDER_ICON_SIZE : "?"}`
  );
}

module.exports = {
  APP_ICON_SIZE,
  BUILDER_ICON_SIZE,
  GEOMETRY,
  ICO_SIZES,
  PALETTE,
  STYLE_FILE,
  SUPERSAMPLE,
  THEME_VARIABLES,
  coverage,
  hexToRgb,
  paletteFromCss,
  renderIcon,
  sdCircle,
  sdRoundRect,
  sdSegment,
  strokeFor,
  styleColours,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
}
