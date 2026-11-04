// `tools/icon-rules.mjs` 的规则，一格一个事实地钉住。
//
// 这一条要防的是「图标产物零断言」：第 127 轮把图标改成按几何画之后，`.ico` / `.png` 三个产物
// 没有任何脚本读过，改坏了也不会红。所以这里的每一格反向控制都只改一个事实——ICO 的 entry 数、
// type 字段、目录项声明的尺寸、负载图的边长、负载图是否全同色、CSS 里的色值、`strokeFor` 的
// 形状、`package.json` 的引用、旧源图复活——并要求点名文件与尺寸。
//
// 最后两段看的是仓库本身而不是夹具：真产物必须全绿，而且 `.ico` 里那几档必须与
// `build/make-icon.cjs` **现在**渲出来的逐像素相等——提交的产物是旧的（改了 GEOMETRY 忘了跑
// `npm run icon`）也是这一条要抓的形状，而只断言「六档都在」抓不到它。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import {
  APP_ICON,
  APP_ICON_SIDE,
  BUILDER_ICON,
  BUILDER_ICON_SIDE,
  ICON_ICO,
  ICON_SIDES,
  ICON_SCRIPT,
  LEGACY_SOURCE,
  STYLE_SHEET,
  darkThemeColours,
  decodePng,
  dibPixels,
  glyphPixelRatio,
  icoEntries,
  icoEntryImage,
  icoEntryPixels,
  icoEntryViolations,
  icoLegibilityViolations,
  icoSizesAgreementViolations,
  icoStalenessViolations,
  iconPngViolations,
  iconViolations,
  legacySourceViolations,
  packageJsonIconViolations,
  paletteDriftViolations,
  palettePresenceViolations,
  pngHeader,
  strokeShapeViolations,
  uniformColours,
} from "./icon-rules.mjs";
import { auditScriptClosure } from "./upstream-watch.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const makeIcon = require(path.join(ROOT, ICON_SCRIPT));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "ok     " : "FAIL   "} ${name}${ok || !detail ? "" : `：${detail}`}`);
};

const read = (target) => {
  const full = path.join(ROOT, target);
  return fs.existsSync(full) ? fs.readFileSync(full) : null;
};
const text = (target) => {
  const bytes = read(target);
  return bytes === null ? null : bytes.toString("utf8");
};

const ico = read(ICON_ICO);
const builderPng = read(BUILDER_ICON);
const appPng = read(APP_ICON);
const css = text(STYLE_SHEET);
const pkg = JSON.parse(text("package.json"));
const palette = makeIcon.PALETTE;

/* ---- 1. 至少要有东西可查 ---- */

check("三个产物都在（`.ico` / 1024 / 512）", Boolean(ico && builderPng && appPng), JSON.stringify({
  ico: Boolean(ico),
  builder: Boolean(builderPng),
  app: Boolean(appPng),
}));

/* ---- 2. `.ico` 的头与目录项 ---- */

{
  const parsed = icoEntries(ico);
  check(
    "读得进 ICO 头：reserved=0、type=1、count 等于 ICO_SIZES 的长度",
    parsed.ok && parsed.reserved === 0 && parsed.type === 1 && parsed.count === ICON_SIDES.length,
    JSON.stringify({ ok: parsed.ok, reserved: parsed.reserved, type: parsed.type, count: parsed.count })
  );
  check(
    "六个目录项声明的尺寸按顺序就是 ICO_SIZES",
    parsed.ok && parsed.entries.map((entry) => entry.side).join(",") === ICON_SIDES.join(","),
    parsed.ok ? parsed.entries.map((entry) => entry.side).join(",") : parsed.reason
  );
  check(
    "真 `.ico` 的每一档负载图边长都等于它声明的边长",
    icoEntryViolations(ico).length === 0,
    icoEntryViolations(ico).join("；")
  );
}

/* ---- 3. 反向控制：`.ico` 的六种坏法 ---- */

{
  const withCount = (count) => {
    const copy = Buffer.from(ico);
    copy.writeUInt16LE(count, 4);
    return copy;
  };
  const five = icoEntryViolations(withCount(5));
  check(
    "反向控制：count 改成 5 → 点名「5 个 entry / 6 个尺寸」",
    five.length > 0 && five.some((line) => line.includes("里有 5 个 entry")),
    five.join("；")
  );

  const wrongType = Buffer.from(ico);
  wrongType.writeUInt16LE(2, 2);
  const typeViolations = icoEntryViolations(wrongType);
  check(
    "反向控制：type 改成 2（光标）→ 点名 type 字段",
    typeViolations.some((line) => line.includes("type 字段是 2")),
    typeViolations.join("；")
  );

  // 目录项照旧、负载全塞最小那一档：这就是「把 1024 缩下去」在字节上的样子。
  const parsed = icoEntries(ico);
  const smallest = parsed.entries[parsed.entries.length - 1];
  const payload = ico.subarray(smallest.offset, smallest.offset + smallest.bytes);
  const directory = Buffer.from(ico.subarray(0, 6 + parsed.entries.length * 16));
  let cursor = 6 + parsed.entries.length * 16;
  parsed.entries.forEach((entry, index) => {
    directory.writeUInt32LE(payload.length, 6 + index * 16 + 8);
    directory.writeUInt32LE(cursor, 6 + index * 16 + 12);
    cursor += payload.length;
  });
  const shrunk = Buffer.concat([directory, ...parsed.entries.map(() => payload)]);
  const shrunkViolations = icoEntryViolations(shrunk);
  check(
    "反向控制：六档负载全塞 16×16（「把 1024 缩下去」）→ 点名「声明 256×256 / 图是 16×16」",
    shrunkViolations.some((line) => line.includes("声明 256×256") && line.includes("是 16×16")),
    shrunkViolations.slice(0, 2).join("；")
  );

  const truncated = Buffer.from(ico);
  truncated.writeUInt32LE(truncated.length, 6 + 12); // 第 1 个 entry 的偏移改到文件尾之外
  const truncatedViolations = icoEntryViolations(truncated);
  check(
    "反向控制：某个 entry 的偏移越界 → 点名偏移与文件长度",
    truncatedViolations.some((line) => line.includes("字节，而文件只有")),
    truncatedViolations.join("；")
  );

  const renamed = Buffer.from(ico);
  const first = icoEntries(ico).entries[0];
  renamed.writeUInt8(32, 6); // 目录项声明 32，而 ICO_SIZES[0] 是 256
  const renamedViolations = icoEntryViolations(renamed);
  check(
    "反向控制：目录项声明改成 32 → 点名「ICO_SIZES[0] 是 256」",
    renamedViolations.some((line) => line.includes("ICO_SIZES[0] 是 256")),
    `${renamedViolations.join("；")}（原来第 1 项是 ${first.side}）`
  );
}

/* ---- 4. 可辨性：16px 那格还认得出 ---- */

{
  check(
    "真 `.ico` 六档的字形像素占比都落在可辨区间",
    icoLegibilityViolations(ico, { fill: palette.fill }).length === 0,
    icoLegibilityViolations(ico, { fill: palette.fill }).join("；")
  );
  const parsed = icoEntries(ico);
  const entry16 = parsed.entries.find((entry) => entry.side === 16);
  const pixels16 = icoEntryPixels(ico.subarray(entry16.offset, entry16.offset + entry16.bytes));
  const measured = glyphPixelRatio(pixels16, palette.fill);
  check(
    "16px 那格的字形占比在 5%–40% 之间（读数写进 measurements.md）",
    measured > 0.05 && measured < 0.4,
    `${(measured * 100).toFixed(2)}%`
  );

  // 反向控制：16px 那格换成一整片底色（「画了但没画上去」）。
  const flatDib = (size) => {
    const dib = Buffer.alloc(40 + size * size * 4 + 4 * size);
    dib.writeUInt32LE(40, 0);
    dib.writeInt32LE(size, 4);
    dib.writeInt32LE(size * 2, 8);
    dib.writeUInt16LE(1, 12);
    dib.writeUInt16LE(32, 14);
    for (let i = 0; i < size * size; i += 1) {
      dib[40 + i * 4] = palette.fill[2];
      dib[40 + i * 4 + 1] = palette.fill[1];
      dib[40 + i * 4 + 2] = palette.fill[0];
      dib[40 + i * 4 + 3] = 255;
    }
    return dib;
  };
  const icoOf = (sides, payloads) => {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(sides.length, 4);
    const directory = Buffer.alloc(sides.length * 16);
    let cursor = 6 + directory.length;
    sides.forEach((size, index) => {
      const offset = index * 16;
      directory.writeUInt8(size >= 256 ? 0 : size, offset);
      directory.writeUInt8(size >= 256 ? 0 : size, offset + 1);
      directory.writeUInt16LE(1, offset + 4);
      directory.writeUInt16LE(32, offset + 6);
      directory.writeUInt32LE(payloads[index].length, offset + 8);
      directory.writeUInt32LE(cursor, offset + 12);
      cursor += payloads[index].length;
    });
    return Buffer.concat([header, directory, ...payloads]);
  };
  const flat = icoOf([16], [flatDib(16)]);
  check(
    "反向控制：整片底色的 16px 负载 → 占比 0%，点名「太低了」",
    icoLegibilityViolations(flat, { fill: palette.fill, sides: [16] }).some((line) =>
      line.includes("太低了")
    ),
    icoLegibilityViolations(flat, { fill: palette.fill, sides: [16] }).join("；")
  );
  check(
    "反向控制的前提：真 `.ico` 在同一套判据下是绿的（差异不是判据自己写错）",
    icoLegibilityViolations(ico, { fill: palette.fill, sides: ICON_SIDES }).length === 0,
    icoLegibilityViolations(ico, { fill: palette.fill, sides: ICON_SIDES }).join("；")
  );
  // 通道顺序：`.ico` 的 32 位 DIB 是 BGRA，解出来第一个像素的 RGB 应等于底色。
  check(
    "32 位 DIB 解码的通道顺序与底色一致（BGRA → PALETTE.fill）",
    pixels16 !== null &&
      Math.abs(pixels16.data[0] - palette.fill[0]) <= 4 &&
      Math.abs(pixels16.data[1] - palette.fill[1]) <= 4 &&
      Math.abs(pixels16.data[2] - palette.fill[2]) <= 4,
    pixels16 ? JSON.stringify([...pixels16.data.subarray(0, 4)]) : "解不出像素"
  );
}

/* ---- 5. 两张独立产物（1024 / 512） ---- */

{
  check(
    `\`${BUILDER_ICON}\` 是 ${BUILDER_ICON_SIDE}×${BUILDER_ICON_SIDE} 且字形占比在区间内`,
    iconPngViolations({ bytes: builderPng, side: BUILDER_ICON_SIDE, pngPath: BUILDER_ICON, palette })
      .length === 0,
    iconPngViolations({ bytes: builderPng, side: BUILDER_ICON_SIDE, pngPath: BUILDER_ICON, palette }).join("；")
  );
  check(
    `\`${APP_ICON}\` 是 ${APP_ICON_SIDE}×${APP_ICON_SIDE} 且字形占比在区间内`,
    iconPngViolations({ bytes: appPng, side: APP_ICON_SIDE, pngPath: APP_ICON, palette }).length === 0,
    iconPngViolations({ bytes: appPng, side: APP_ICON_SIDE, pngPath: APP_ICON, palette }).join("；")
  );
  check(
    "两张产物里三个色值都能找到",
    palettePresenceViolations({ bytes: builderPng, palette, pngPath: BUILDER_ICON }).length === 0 &&
      palettePresenceViolations({ bytes: appPng, palette, pngPath: APP_ICON }).length === 0,
    [
      ...palettePresenceViolations({ bytes: builderPng, palette, pngPath: BUILDER_ICON }),
      ...palettePresenceViolations({ bytes: appPng, palette, pngPath: APP_ICON }),
    ].join("；")
  );
  check(
    "反向控制：把 512 那张按 1024 核对 → 点名边长",
    iconPngViolations({ bytes: appPng, side: BUILDER_ICON_SIDE, pngPath: APP_ICON, palette }).some((line) =>
      line.includes("的边长是 512×512，应为 1024×1024")
    ),
    iconPngViolations({ bytes: appPng, side: BUILDER_ICON_SIDE, pngPath: APP_ICON, palette }).join("；")
  );
  check(
    "反向控制：拿一段非 PNG 当图标 → 点名「不是 PNG」",
    iconPngViolations({ bytes: Buffer.from("nope"), side: 16, pngPath: BUILDER_ICON, palette }).some((line) =>
      line.includes("不是 PNG")
    ),
    "只有 4 字节的负载也必须是红"
  );

  // 全同色：用 Jimp（本仓自己写图标用的那个编码器）写一张出来，证明解码器读得动它。
  const Jimp = require("jimp");
  const side = 16;
  const data = Buffer.alloc(side * side * 4);
  for (let i = 0; i < side * side; i += 1) {
    data[i * 4] = palette.fill[0];
    data[i * 4 + 1] = palette.fill[1];
    data[i * 4 + 2] = palette.fill[2];
    data[i * 4 + 3] = 255;
  }
  const file = path.join(os.tmpdir(), `ocr-icon-rules-${process.pid}.png`);
  const image = new Jimp({ width: side, height: side, data });
  await image.writeAsync(file);
  const flatBytes = fs.readFileSync(file);
  fs.unlinkSync(file);
  check(
    "反向控制：整片底色的 PNG → 点名「不透明像素全是同一个颜色」",
    iconPngViolations({ bytes: flatBytes, side, pngPath: BUILDER_ICON, palette }).some((line) =>
      line.includes("全是同一个颜色")
    ),
    iconPngViolations({ bytes: flatBytes, side, pngPath: BUILDER_ICON, palette }).join("；")
  );
  check(
    "解码器能读懂 Jimp 写出来的 PNG（同一份编码器，一边写一边解）",
    pngHeader(flatBytes) !== null &&
      decodePng(flatBytes).width === side &&
      uniformColours(decodePng(flatBytes)) === true,
    JSON.stringify({ header: pngHeader(flatBytes) })
  );
}

/* ---- 6. 色值：两处解析必须指同一批值 ---- */

{
  check(
    "`build/make-icon.cjs` 的三色 = `src/styles.css` 暗色主题块里的三个变量",
    paletteDriftViolations({ css, palette, variables: makeIcon.THEME_VARIABLES }).length === 0,
    paletteDriftViolations({ css, palette, variables: makeIcon.THEME_VARIABLES }).join("；")
  );
  const drifted = css.replace("--accent: #5b7cfa;", "--accent: #123456;");
  const drift = paletteDriftViolations({ css: drifted, palette, variables: makeIcon.THEME_VARIABLES });
  check(
    "反向控制：把 CSS 的 `--accent` 改成别的值 → 点名 CSS 那个值与脚本解析出的值",
    drifted !== css &&
      drift.some((line) => line.includes("#123456") && line.includes("--accent") && line.includes("lens")),
    drift.join("；")
  );
  const renamedVar = paletteDriftViolations({
    css,
    palette,
    variables: { ...makeIcon.THEME_VARIABLES, lens: "--brand" },
  });
  check(
    "反向控制：脚本改去读一个不存在的变量（`--brand`）→ 点名暗色块里没有它",
    renamedVar.some((line) => line.includes("没有 \`--brand\`")),
    renamedVar.join("；")
  );
  check(
    "反向控制：CSS 里缺 `--accent` → `paletteFromCss` 抛一句点名它的话",
    (() => {
      try {
        makeIcon.paletteFromCss("--raised: #171c26;\n--ink: #e6ebf3;\n", "fixture.css");
        return false;
      } catch (err) {
        return String(err && err.message).includes("--accent");
      }
    })(),
    "解析失败必须停，不能退回写死的颜色"
  );
  check(
    "`darkThemeColours` 取的是暗色块（与 `styles.css` 里第一次出现的那批值相同）",
    darkThemeColours(css).get("--raised") === css.match(/--raised:\s*(#[0-9a-f]{6})/)[1],
    JSON.stringify({ dark: darkThemeColours(css).get("--raised") })
  );
}

/* ---- 7. 生成参数：尺寸表与 strokeFor ---- */

{
  check(
    "`ICO_SIZES` 与这一条自己的尺寸表逐位相等",
    icoSizesAgreementViolations({ sides: makeIcon.ICO_SIZES }).length === 0,
    icoSizesAgreementViolations({ sides: makeIcon.ICO_SIZES }).join("；")
  );
  check(
    "反向控制：`ICO_SIZES` 少一档 → 点名两边",
    icoSizesAgreementViolations({ sides: [256, 128, 64, 48, 32] }).length > 0,
    "五个尺寸与六个尺寸不该判成对"
  );
  check(
    "`strokeFor` 的两端、插值、兜底与两条像素边界都对",
    strokeShapeViolations({ strokeFor: makeIcon.strokeFor, geometry: makeIcon.GEOMETRY }).length === 0,
    strokeShapeViolations({ strokeFor: makeIcon.strokeFor, geometry: makeIcon.GEOMETRY }).join("；")
  );
  check(
    "反向控制：`strokeFor` 改成常数 → 点名「端不落在常数上」",
    strokeShapeViolations({
      strokeFor: () => makeIcon.GEOMETRY.strokeAtSmall,
      geometry: makeIcon.GEOMETRY,
    }).length > 0,
    "常数插值等于没有随尺寸加粗"
  );
  const flat16 = makeIcon.strokeFor(16) * 16;
  check(
    "16px 上的描边实际像素宽度 ≥ 1.5px（读数：1.92px）",
    flat16 >= 1.5,
    `${flat16.toFixed(2)}px`
  );
}

/* ---- 8. `package.json` 的引用与旧源图 ---- */

{
  check(
    "`package.json` 那六处图标引用都指向这一份产物",
    packageJsonIconViolations(pkg).length === 0,
    packageJsonIconViolations(pkg).join("；")
  );
  const renamed = JSON.parse(JSON.stringify(pkg));
  renamed.build.win.icon = "build/icon-new.ico";
  check(
    "反向控制：`build.win.icon` 改成别的路径 → 点名该字段",
    packageJsonIconViolations(renamed).some((line) => line.includes("build.win.icon")),
    "改文件名而没改引用时构建会静默换默认图标"
  );
  check(
    "旧源图 `build/icon-source.png` 仍不在",
    legacySourceViolations({ exists: fs.existsSync(path.join(ROOT, LEGACY_SOURCE)) }).length === 0,
    legacySourceViolations({ exists: fs.existsSync(path.join(ROOT, LEGACY_SOURCE)) }).join("；")
  );
  check(
    "反向控制：旧源图复活 → 点名它是一张救不回来的渲染",
    legacySourceViolations({ exists: true }).some((line) => line.includes("1.38:1")),
    legacySourceViolations({ exists: true }).join("；")
  );
}

/* ---- 9. 提交的 `.ico` 不是旧的 ---- */

{
  const renders = new Map([[16, makeIcon.renderIcon(16)], [32, makeIcon.renderIcon(32)]]);
  const images = new Map([...renders].map(([side, img]) => [
    side,
    { width: side, height: side, channels: 4, data: img.bitmap.data },
  ]));
  check(
    "`build/icon.ico` 的 16px / 32px 两档与现在渲出来的逐像素相等（产物不是旧的）",
    icoStalenessViolations({ icoBytes: ico, renders: images }).length === 0,
    icoStalenessViolations({ icoBytes: ico, renders: images }).join("；")
  );
  const stale = new Map([...images].map(([side, img]) => [side, { ...img, data: Buffer.from(img.data) }]));
  const touched = stale.get(16);
  touched.data[0] = (touched.data[0] + 7) % 256;
  check(
    "反向控制：16px 那档改一个字节 → 点名「与现在渲出来的不一样」",
    icoStalenessViolations({ icoBytes: ico, renders: stale }).some((line) => line.includes("不一样")),
    "改了 GEOMETRY 忘跑 `npm run icon` 就是这一种"
  );
}

/* ---- 10. 参数分支 ---- */

{
  const run = spawnSync(process.execPath, [ICON_SCRIPT, LEGACY_SOURCE], { cwd: ROOT, encoding: "utf8" });
  check(
    "`npm run icon` 带源图参数时退出码 1 并说清「不再需要源图参数」",
    run.status === 1 && String(run.stderr).includes("不再需要源图参数"),
    JSON.stringify({ status: run.status, stderr: String(run.stderr).slice(0, 80) })
  );
}

/* ---- 11. 接线 ---- */

{
  const closure = auditScriptClosure(pkg, (target) => {
    const full = path.join(ROOT, target);
    // 目录也算「存在」，而闭包会拿它去读——EISDIR 不是这一条要问的事。
    return fs.existsSync(full) && fs.statSync(full).isFile() ? fs.readFileSync(full, "utf8") : null;
  });
  check(
    "接线：`audit:icon` 存在，且规则与 smoke 都在 audit 闭包里",
    typeof pkg.scripts["audit:icon"] === "string" &&
      closure.files.has("tools/icon-rules.mjs") &&
      closure.files.has("tools/icon-rules-smoke.mjs"),
    `audit:icon=${JSON.stringify(pkg.scripts["audit:icon"])}`
  );
  check(
    "接线：`audit:icon` 挂在 `audit:static` 里（不是只挂在 `audit:app`）",
    String(pkg.scripts["audit:static"] || "").includes("audit:icon"),
    "读仓库里的字节，不该拖进真 Electron 那一趟"
  );
  check(
    "接线：`audit:icon` 不在 `audit:app` 里",
    !String(pkg.scripts["audit:app"] || "").includes("audit:icon"),
    `audit:app=${String(pkg.scripts["audit:app"] || "").slice(0, 60)}…`
  );
  check(
    "接线：`npm run icon` 仍指向 `build/make-icon.cjs`",
    pkg.scripts.icon === `node ${ICON_SCRIPT}`,
    JSON.stringify(pkg.scripts.icon)
  );
}

/* ---- 12. 真仓库：整份清单为零 ---- */

{
  const violations = iconViolations({
    icoBytes: ico,
    builderPng,
    appPng,
    legacySourceExists: fs.existsSync(path.join(ROOT, LEGACY_SOURCE)),
    css,
    palette,
    variables: makeIcon.THEME_VARIABLES,
    pkg,
    sides: makeIcon.ICO_SIZES,
    strokeFor: makeIcon.strokeFor,
    geometry: makeIcon.GEOMETRY,
  });
  check("真仓库的图标产物：0 处问题", violations.length === 0, violations.join("；"));
  check(
    "`icoEntryImage` 对 PNG 与 32 位 DIB 两种负载都答得出边长",
    icoEntryImage(builderPng) !== null &&
      icoEntryImage(builderPng).width === BUILDER_ICON_SIDE &&
      icoEntryImage(ico.subarray(0, 0)) === null,
    JSON.stringify(icoEntryImage(builderPng))
  );
  check(
    "`dibPixels` 对短的 / 非 DIB 的负载返回 null（不瞎猜）",
    dibPixels(Buffer.alloc(10)) === null && dibPixels(Buffer.alloc(60)) === null,
    "读不懂就说读不懂"
  );
}

const failed = results.filter((result) => !result.ok);
console.log(`\n图标产物的规则：${results.length} 条检查，${failed.length} 条红`);
if (failed.length) {
  console.error(failed.map((result) => `  - ${result.name}：${result.detail}`).join("\n"));
  process.exit(1);
}
