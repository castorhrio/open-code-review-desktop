// 图标是「没有任何 audit 看得见」的那类产物，这一条把它变成能被脚本回答的几张表。
//
// 第 127 轮把应用图标从「阈值化一张 AI 渲染」改成按几何画出来（`build/make-icon.cjs`），
// 方向是对的：旧产物字形与底色只有 1.38:1、缩到 16 就剩一块近空的深色方块。但那一轮之后，
// `build/icon.ico`、`build/icon.png`、`assets/icon.png` 三个交付产物仍然零断言——`tools/`
// 里没有一份脚本读过 ICO 头，也没有一份问过「16px 那一格画出来还认得出来吗」。于是「图标
// 改坏了」这件事的可见性完全等于「有人正好打开一看」。这一条补的就是这个洞。
//
// 它问四件互相独立的事，每一件都能被脚本答：
//
//   1. **`.ico` 里那六档图，是不是各自按自己那一档画的。** 读 ICO 头（reserved / type /
//      count）与每个 entry 的声明宽高，再把 entry 里那张图自己的尺寸解出来对一遍——`png-to-ico`
//      拿到 PNG 会转成 32 位 DIB（`BITMAPINFOHEADER`，高度写成两倍，多出来那一半是掩码），
//      所以两种格式都认，不认的是「头里写什么、图里是什么」不一致。这条直接钉住第 127 轮
//      那个决定——**六尺寸各自渲染，而不是把 1024 缩下去**：缩出来的那一档在 16 上没有
//      加粗的描边（`tools/icon-rules-smoke.mjs` 的反向控制把这条走一遍：六个目录项照旧、
//      里面全塞最小那档的负载，规则必须点名「声明 256×256，图是 16×16」）。
//   2. **16px 那一格还认得出是个放大镜。** 判据是「字形像素占比」：与底色明显不同的像素
//      占整格的比例落在 `GLYPH_RATIO_RANGE` 里。太低 = 缩小后什么都没了（旧产物就是这个
//      形状），太高 = 糊成一团。这是把它读成数字而不是「看起来还行」，因为看的人只会看
//      1024 那张。
//   3. **三个产物与三个色值是同一件事。** `build/make-icon.cjs` 第 128 轮起从
//      `src/styles.css` 解析 `--raised` / `--ink` / `--accent`，所以「图标与 App 同色」不再
//      靠注释提醒。这一条不用它自己的解析器，而是**另写一份**读暗色主题块（`[data-theme="dark"]`）
//      再逐字比，两边不一致就点名「CSS 声明什么、脚本解析出什么」——同一个事实两处解析，
//      正是因为一处解析错了不会有人发现。
//   4. **产物文件名与 `package.json` 里那五处引用是同一份。** 改文件名而没改
//      `build.win.icon` / `nsis.installerIcon` / `mac.icon` 这些东西时，构建会静默用默认图标。
//
// 反向控制在 `tools/icon-rules-smoke.mjs`：每一格只改一个事实（entry 数、type、尺寸集合、
// PNG 边长、全同色、色值漂移、`strokeFor` 常量化、`package.json` 换个路径、旧源图复活），
// 要求点名文件与尺寸，并要求在真仓库上全绿。挂进 `audit:static`（`npm run audit:icon`），
// 因为这一条只读仓库里的文件，不跑 Electron、不联网、不写任何东西。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);

export const ICON_ICO = "build/icon.ico";
export const BUILDER_ICON = "build/icon.png";
export const APP_ICON = "assets/icon.png";
/** 旧路径。删掉它是个决定（那张渲染救不回来），所以「它不在」本身要有断言。 */
export const LEGACY_SOURCE = "build/icon-source.png";
export const ICON_SCRIPT = "build/make-icon.cjs";
export const STYLE_SHEET = "src/styles.css";

/** `.ico` 里应有的六个尺寸，从大到小。与 `build/make-icon.cjs` 的 `ICO_SIZES` 逐位相等
 *  （`icoSizesAgreementViolations`），后者是产物怎么生成的唯一事实源。 */
export const ICON_SIDES = Object.freeze([256, 128, 64, 48, 32, 16]);
export const BUILDER_ICON_SIDE = 1024;
export const APP_ICON_SIDE = 512;

/** 16px 那一格「还认得出」的判据。下限挡的是「缩小后什么都不剩」（旧产物），
 *  上限挡的是「字形糊满整格」。两个数都是范围的两端，不是某一版产物的读数，
 *  所以产物变好看时不用回来改。 */
export const GLYPH_RATIO_RANGE = Object.freeze([0.05, 0.4]);

/** 「这个像素算字形」的门槛：与底色任一通道差超过它就是字形。抗锯齿的边会落在中间，
 *  阈值取 32 是为了不把边上的过渡像素算成字形（那样读数会虚高）。 */
export const GLYPH_DISTANCE = 32;

/** 调色板比对容差（每通道）。PNG 是有损于精度的编码，不该要求逐位相等。 */
export const PALETTE_TOLERANCE = 12;

/** 描边在输出尺寸上的像素宽度区间：16px 上细于 1.5px 会被抗锯齿吃成灰雾，
 *  256px 上粗于 30px 就从「镜片环」变成一块板。 */
export const MIN_STROKE_PX = 1.5;
export const MAX_STROKE_PX = 30;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CSS_COLOUR = /^\s*(--[a-z-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/;
const DARK_THEME_SELECTOR = /\[data-theme=["']dark["']\]/;

const hexOf = (rgb) => `#${rgb.map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;

/* ---- PNG：只解这一条需要的那点东西 ---- */
// 自己写而不是拉一个解码库：需要的是「边长 + 每个像素的 RGBA」，PNG 的 IHDR / IDAT /
// 五种行滤波都是规范里写死的，四十行就能覆盖 Jimp 写出来的那种（8 位、非隔行）。

export const isPng = (bytes) =>
  Buffer.isBuffer(bytes) && bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE);

/** IHDR：边长、位深、颜色类型、隔行。不是 PNG 或头不对时返回 null。 */
export const pngHeader = (bytes) => {
  if (!isPng(bytes) || bytes.length < 33) return null;
  const length = bytes.readUInt32BE(8);
  const type = bytes.subarray(12, 16).toString("latin1");
  if (type !== "IHDR" || length !== 13) return null;
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    bitDepth: bytes[24],
    colourType: bytes[25],
    interlace: bytes[28],
  };
};

const CHANNELS_OF = { 0: 1, 2: 3, 4: 2, 6: 4 };

const unfilter = (raw, width, height, channels) => {
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    if (pos >= raw.length) throw new Error(`PNG 的像素数据不够：第 ${y} 行就不见了`);
    const filter = raw[pos];
    pos += 1;
    const line = raw.subarray(pos, pos + stride);
    if (line.length !== stride) throw new Error(`PNG 的像素数据不够：第 ${y} 行短了 ${stride - line.length} 字节`);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : out.subarray((y - 1) * stride, y * stride);
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) {
        throw new Error(`PNG 第 ${y} 行的滤波类型是 ${filter}（只认 0–4）`);
      }
      cur[i] = value & 0xff;
    }
  }
  return out;
};

/** 解一张 8 位非隔行 PNG，返回 `{ width, height, channels, data }`。解不动就抛，
 *  句子说清为什么——「读不出来」也是一种答案，不该被当成零处违规。 */
export const decodePng = (bytes) => {
  const header = pngHeader(bytes);
  if (!header) throw new Error("不是 PNG（签名或 IHDR 不对）");
  if (header.bitDepth !== 8) throw new Error(`PNG 位深是 ${header.bitDepth}（只解 8 位）`);
  if (header.interlace !== 0) throw new Error("PNG 是隔行的（只解非隔行）");
  const channels = CHANNELS_OF[header.colourType];
  if (!channels) throw new Error(`PNG 颜色类型是 ${header.colourType}（只认 0 / 2 / 4 / 6）`);

  const parts = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("latin1");
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (body.length !== length) throw new Error(`PNG 的 ${type} 块被截断了`);
    if (type === "IDAT") parts.push(body);
    if (type === "IEND") break;
    offset += 12 + length;
  }
  if (!parts.length) throw new Error("PNG 里没有 IDAT 块");
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const data = unfilter(raw, header.width, header.height, channels);
  return { width: header.width, height: header.height, channels, data };
};

/** `{ r, g, b, a }`，灰阶与灰阶+alpha 也补成四通道，调用方不用管颜色类型。 */
export const pixelAt = (image, x, y) => {
  const offset = (y * image.width + x) * image.channels;
  const { data, channels } = image;
  if (channels === 4) return { r: data[offset], g: data[offset + 1], b: data[offset + 2], a: data[offset + 3] };
  if (channels === 3) return { r: data[offset], g: data[offset + 1], b: data[offset + 2], a: 255 };
  if (channels === 2) return { r: data[offset], g: data[offset], b: data[offset], a: data[offset + 1] };
  return { r: data[offset], g: data[offset], b: data[offset], a: 255 };
};

const channelDistance = (pixel, rgb) =>
  Math.max(Math.abs(pixel.r - rgb[0]), Math.abs(pixel.g - rgb[1]), Math.abs(pixel.b - rgb[2]));

/** 与底色明显不同的像素占整格的比例（透明像素不算）。**这就是「16px 还认不认得出」的读数。** */
export const glyphPixelRatio = (image, fill, distance = GLYPH_DISTANCE) => {
  const total = image.width * image.height;
  if (!total) return 0;
  let hits = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const pixel = pixelAt(image, x, y);
      if (pixel.a < 128) continue;
      if (channelDistance(pixel, fill) > distance) hits += 1;
    }
  }
  return hits / total;
};

/** 不透明像素是不是全都一个颜色。全同色意味着「画了但没画上去」，这也是一个真实的坏法。 */
export const uniformColours = (image) => {
  const first = pixelAt(image, 0, 0);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const pixel = pixelAt(image, x, y);
      if (pixel.a < 128) continue;
      if (pixel.r !== first.r || pixel.g !== first.g || pixel.b !== first.b) return false;
    }
  }
  return true;
};

/* ---- 色值：另写一份解析，另一处解析出错才看得见 ---- */

/**
 * 暗色主题块里每个 `--name: #rrggbb` 的声明。
 *
 * 与 `build/make-icon.cjs` 的 `styleColours` **不是同一份实现**，这是刻意的：那一份取
 * 「文件里第一次出现」的值（暗色块在前），这一份只认 `[data-theme="dark"]` 那个块。两份
 * 解析走的路不同，所以要么两块都指同一批值（绿），要么其中一份走偏了块（红）。抄一份过去
 * 就是第三个会各自漂的权威。
 */
export const darkThemeColours = (css) => {
  const lines = String(css == null ? "" : css).split(/\r?\n/);
  const start = lines.findIndex((line) => DARK_THEME_SELECTOR.test(line) && line.includes("{"));
  if (start === -1) return new Map();
  const found = new Map();
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (index > start && line.trim() === "}") break;
    const hit = CSS_COLOUR.exec(line);
    if (!hit || found.has(hit[1])) continue;
    found.set(hit[1], hit[2].toLowerCase());
  }
  return found;
};

/**
 * 「图标的三个色 = 暗色主题那三个变量」。
 *
 * `palette` 是 `build/make-icon.cjs` 解析出来的 `{ fill, glyph, lens }`，`variables` 是它
 * 声明的变量名（`--raised` / `--ink` / `--accent`）。红的时候两边都写出来：只写一边读者
 * 分不清是 CSS 改了还是脚本读错了。
 */
export const paletteDriftViolations = ({
  css,
  palette,
  variables,
  stylePath = STYLE_SHEET,
  scriptPath = ICON_SCRIPT,
}) => {
  const violations = [];
  const colours = darkThemeColours(css);
  if (colours.size === 0) {
    return [
      `${stylePath} 里找不到暗色主题块（形状：含 \`[data-theme="dark"]\` 且以 \`{\` 结尾的那一行）：` +
        `${scriptPath} 的三色正是从那里解析出来的，块被改名或删掉时这条规则没有对象，不能算绿`,
    ];
  }
  for (const [part, name] of Object.entries(variables || {})) {
    const declared = colours.get(name);
    const actual = palette && palette[part] ? hexOf(palette[part]) : "(缺)";
    if (!declared) {
      violations.push(
        `${stylePath} 的暗色主题块里没有 \`${name}\`：${scriptPath} 用它当图标的 ${part} 色，` +
          "变量没了就该一起改 THEME_VARIABLES，而不是让脚本退回到别的颜色"
      );
      continue;
    }
    if (declared !== actual) {
      violations.push(
        `${stylePath} 第 ${describeLine(css, declared)} 声明的 \`${name}\` 是 ${declared}，` +
          `而 ${scriptPath} 解析出的 ${part} 色是 ${actual}：` +
          "两处都在说「图标与 App 同色」，这一对值不一致时图标的颜色就不再是 App 的颜色"
      );
    }
  }
  return violations;
};

/** `--accent: #5b7cfa` 那一行在文件里是第几行。红的时候带上行号，省一次 grep。 */
const describeLine = (css, hex) => {
  const lines = String(css == null ? "" : css).split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(hex) && /^\s*--[a-z-]+\s*:/.test(line));
  return index === -1 ? "(找不到那一行)" : `${index + 1} 行`;
};

/* ---- ICO ---- */

export const ICO_HEADER_BYTES = 6;
export const ICO_ENTRY_BYTES = 16;

/**
 * 读 ICO 头与每个 entry 的声明宽高 / 字节数 / 偏移。
 *
 * 宽高字段是**一个字节**，0 表示 256——写 `.ico` 的库都这么做，所以「256 那个 entry 的
 * 宽字段是 0x00」是正确形状，不是缺失。解析失败时返回 `{ ok: false, reason }` 而不是抛：
 * 这一层要能在 smoke 里被指向任意一段字节。
 */
export const icoEntries = (bytes) => {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.alloc(0);
  if (buffer.length < ICO_HEADER_BYTES) {
    return { ok: false, reason: `文件只有 ${buffer.length} 字节，连 ICO 头（${ICO_HEADER_BYTES} 字节）都不够` };
  }
  const reserved = buffer.readUInt16LE(0);
  const type = buffer.readUInt16LE(2);
  const count = buffer.readUInt16LE(4);
  const entries = [];
  if (count === 0) {
    return { ok: false, reason: "ICO 头的 count 是 0：这份文件里一张图都没有", reserved, type, count, entries };
  }
  for (let index = 0; index < count; index += 1) {
    const offset = ICO_HEADER_BYTES + index * ICO_ENTRY_BYTES;
    if (offset + ICO_ENTRY_BYTES > buffer.length) {
      return {
        ok: false,
        reason: `ICO 头声明有 ${count} 个 entry，但第 ${index + 1} 个的目录项（偏移 ${offset}）已经越界`,
        reserved,
        type,
        count,
        entries,
      };
    }
    entries.push({
      side: buffer[offset] === 0 ? 256 : buffer[offset],
      height: buffer[offset + 1] === 0 ? 256 : buffer[offset + 1],
      bytes: buffer.readUInt32LE(offset + 8),
      offset: buffer.readUInt32LE(offset + 12),
    });
  }
  return { ok: true, reason: "", reserved, type, count, entries };
};

/**
 * 一个 entry 的负载图自己的尺寸，两种格式都认：
 *
 *   - **PNG**（`\x89PNG` 开头）：边长取 IHDR；
 *   - **32 位 DIB**（`BITMAPINFOHEADER`，`biSize === 40`）：宽取 `biWidth`，高取
 *     `|biHeight| / 2`——`.ico` 里的 BMP 把 XOR 位图与 AND 掩码上下拼在一起写，所以头里的
 *     高度是两倍。`png-to-ico` 3.x 走的是这一条，这也是本仓现在实际产出的格式。
 *
 * 都不是就返回 `null`：那时「图是什么」这件事已经说不清了，不能当成「尺寸对上了」。
 */
export const icoEntryImage = (bytes) => {
  const header = pngHeader(bytes);
  if (header) return { format: "png", width: header.width, height: header.height };
  if (Buffer.isBuffer(bytes) && bytes.length >= 16 && bytes.readUInt32LE(0) === 40) {
    const width = Math.abs(bytes.readInt32LE(4));
    const height = Math.abs(bytes.readInt32LE(8)) / 2;
    return { format: "bmp", width, height };
  }
  return null;
};

/**
 * `.ico` 这一份产物对不对：六个 entry、type=1、尺寸与 `ICO_SIZES` 逐位相等，并且每个
 * entry 里装的是**它自己那个尺寸**的图。
 *
 * 最后一条是这条规则的重点。`png-to-ico` 拿到六张 PNG 就把它们塞进去，它不检查边长；
 * 所以「把 1024 缩成六个尺寸塞进去」也能生成一份看起来正常的 `.ico`，而 16px 那一格会是
 * 一张细线灰方块——正是第 127 轮要消灭的东西。断言因此问的是负载图自己的边长。
 */
export const icoEntryViolations = (bytes, { sides = ICON_SIDES, icoPath = ICON_ICO } = {}) => {
  const parsed = icoEntries(bytes);
  if (!parsed.ok) return [`${icoPath}：${parsed.reason}`];
  const violations = [];
  if (parsed.reserved !== 0) {
    violations.push(`${icoPath} 的 ICO 头 reserved 字段是 ${parsed.reserved}（规范要求 0）：这不像是 ICO`);
  }
  if (parsed.type !== 1) {
    violations.push(
      `${icoPath} 的 ICO 头 type 字段是 ${parsed.type}（图标是 1，光标是 2）：` +
        "读到 2 说明这份文件根本不是图标"
    );
  }
  if (parsed.count !== sides.length) {
    violations.push(
      `${icoPath} 里有 ${parsed.count} 个 entry，${ICON_SCRIPT} 的 ICO_SIZES 有 ${sides.length} 个尺寸` +
        `（${sides.join(", ")}）：Windows 会在缺哪一档时自己缩放，而缩放出来的那一档没有加粗的描边`
    );
  }

  const declared = parsed.entries.map((entry) => entry.side);
  for (let index = 0; index < Math.min(declared.length, sides.length); index += 1) {
    const entry = parsed.entries[index];
    if (entry.side !== sides[index] || entry.height !== sides[index]) {
      violations.push(
        `${icoPath} 第 ${index + 1} 个 entry 声明 ${entry.side}×${entry.height}，` +
          `而 ${ICON_SCRIPT} 的 ICO_SIZES[${index}] 是 ${sides[index]}` +
          `（整份顺序是 ${declared.join(", ")}）：改尺寸要两边一起改`
      );
    }
  }
  const declaredSet = [...new Set(declared)].sort((a, b) => b - a);
  const wantedSet = [...new Set(sides)].sort((a, b) => b - a);
  if (declaredSet.join(",") !== wantedSet.join(",")) {
    violations.push(
      `${icoPath} 的尺寸集合是 {${declaredSet.join(", ")}}，应为 {${wantedSet.join(", ")}}：` +
        "多出来的那档没人渲染过，少掉的那档只能由 Windows 自己缩"
    );
  }

  parsed.entries.forEach((entry, index) => {
    const label = `${icoPath} 第 ${index + 1} 个 entry（声明 ${entry.side}×${entry.height}）`;
    if (entry.offset + entry.bytes > bytes.length) {
      violations.push(
        `${label} 指向偏移 ${entry.offset} 的 ${entry.bytes} 字节，而文件只有 ${bytes.length} 字节：` +
          "目录项与数据对不上，读图的那一端会拿到越界的字节"
      );
      return;
    }
    const payload = bytes.subarray(entry.offset, entry.offset + entry.bytes);
    const image = icoEntryImage(payload);
    if (!image) {
      violations.push(
        `${label} 里那张图既不是 PNG（签名 / IHDR 不对）也不是 32 位 DIB（前 4 字节不是 40）：` +
          "两种格式都是写 `.ico` 的库会产出的形状，读到别的说明写图那一步换了东西——先确认它现在写的是什么"
      );
      return;
    }
    if (image.width !== entry.side || image.height !== entry.height) {
      violations.push(
        `${label} 里那张 ${image.format} 图是 ${image.width}×${image.height}：` +
          "这就是「六尺寸各自渲染」与「把 1024 缩下去」的分界——缩出来的那一档在 16 上没有加粗的描边"
      );
    }
  });
  return violations;
};

/**
 * 32 位 DIB（`.ico` 里那种 BMP 负载）解成 `{ width, height, channels: 4, data }`。
 *
 * 几条规范细节就是这一段的全部内容，写错任何一条都会读出一张「颜色对不上」的图：
 *
 *   - `.ico` 的负载**没有** `BITMAPFILEHEADER`（那 14 字节只存在于 `.bmp` 文件里），
 *     像素从 40 字节的 `BITMAPINFOHEADER` 之后立刻开始——按 `.bmp` 的 54 字节去算会整体
 *     偏 14 字节，读出来的「像素」其实是半张图；
 *   - 行是**从下往上**存的（`biHeight` 为正时）；
 *   - 像素是 **BGRA** 而不是 RGBA；
 *   - `biHeight` 是两倍——多出来那一半是 AND 掩码，只在很老的渲染器上用得着（32 位图靠
 *     alpha 就够），所以只解上面那一半。
 *
 * 解不动返回 `null`，由调用方说清。`png-to-ico` 3.0.2 写出来的正是这一种（`getDib` 的
 * 注释写着「blue green red alpha in order」）。
 */
export const dibPixels = (bytes) => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 54) return null;
  if (bytes.readUInt32LE(0) !== 40) return null;
  const width = Math.abs(bytes.readInt32LE(4));
  const rawHeight = bytes.readInt32LE(8);
  const height = Math.abs(rawHeight) / 2;
  if (!Number.isInteger(height) || height <= 0 || width <= 0) return null;
  if (bytes.readUInt16LE(14) !== 32) return null; // 只解 32 位
  if (bytes.readUInt32LE(16) !== 0) return null; // 不认压缩
  const offset = bytes.readUInt32LE(0); // 负载里没有 BITMAPFILEHEADER，信息头之后就是像素
  const stride = width * 4;
  if (offset + stride * height > bytes.length) return null;
  const bottomUp = rawHeight > 0;
  const data = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const sourceRow = bottomUp ? height - 1 - row : row;
    const sourceBase = offset + sourceRow * stride;
    for (let x = 0; x < width; x += 1) {
      const s = sourceBase + x * 4;
      const d = (row * width + x) * 4;
      data[d] = bytes[s + 2];
      data[d + 1] = bytes[s + 1];
      data[d + 2] = bytes[s];
      data[d + 3] = bytes[s + 3];
    }
  }
  return { width, height, channels: 4, data };
};

/** 一个 entry 的负载解成像素：PNG 走 `decodePng`，32 位 DIB 走 `dibPixels`。 */
export const icoEntryPixels = (bytes) => {
  const image = icoEntryImage(bytes);
  if (!image) return null;
  if (image.format === "png") {
    try {
      return decodePng(bytes);
    } catch (_) {
      return null;
    }
  }
  return dibPixels(bytes);
};

/**
 * **每一档画出来还认不认得出。** 直接从 `.ico` 的字节里取像素，量「与底色明显不同的
 * 像素占比」，要求落在 `GLYPH_RATIO_RANGE` 里。
 *
 * 这一条与 `iconPngViolations` 问的是同一件事的两个位置：那一份问 1024 / 512 两张独立
 * 产物，这一条问真正被 Windows 用的那六档。16px 那格是它存在的理由——旧图标在 1024 上
 * 也是「有个形状」，缩到 16 才变成空方块，而没人会去打开 `.ico` 里的第 6 个 entry 看。
 */
export const icoLegibilityViolations = (
  bytes,
  { sides = ICON_SIDES, fill, ratioRange = GLYPH_RATIO_RANGE, icoPath = ICON_ICO } = {}
) => {
  const parsed = icoEntries(bytes);
  if (!parsed.ok) return [];
  const violations = [];
  parsed.entries.forEach((entry, index) => {
    if (entry.offset + entry.bytes > bytes.length) return; // 越界由 icoEntryViolations 说，重复报只会把行数放大
    const pixels = icoEntryPixels(bytes.subarray(entry.offset, entry.offset + entry.bytes));
    const label = `${icoPath} 第 ${index + 1} 个 entry（声明 ${entry.side}×${entry.height}）`;
    if (!pixels) {
      violations.push(`${label} 的负载解不出像素：这一档的字形占比因此量不出来，不能算绿`);
      return;
    }
    const ratio = glyphPixelRatio(pixels, fill);
    const [low, high] = ratioRange;
    if (ratio < low || ratio > high) {
      violations.push(
        `${label} 的字形像素占比是 ${(ratio * 100).toFixed(2)}%，应在 ${(low * 100).toFixed(1)}%–${(high * 100).toFixed(1)}% 之间：` +
          (ratio < low
            ? "太低了——这一档在任务栏里就是一块近空的方块（旧图标的下场）"
            : "太高了——字形糊满整格，缩小之后只剩一团浅色")
      );
    }
  });
  return violations;
};

/** 每一档的字形像素占比，给门禁自己那句读数用（`16px 17.97%` 这类）。 */
export const icoGlyphRatios = (bytes, { fill } = {}) => {
  const parsed = icoEntries(bytes);
  if (!parsed.ok || !fill) return [];
  return parsed.entries
    .filter((entry) => entry.offset + entry.bytes <= bytes.length)
    .map((entry) => {
      const pixels = icoEntryPixels(bytes.subarray(entry.offset, entry.offset + entry.bytes));
      return { side: entry.side, ratio: pixels ? glyphPixelRatio(pixels, fill) : null };
    });
};

/**
 * 提交的那份 `.ico` 是不是**现在**这个脚本画出来的。
 *
 * 只断言「六档都在、边长都对」抓不到最常见的坏法：改了 `GEOMETRY` / `strokeFor` 却忘了跑
 * `npm run icon`，于是仓库里躺着上一版画出来的字节，而所有形状断言仍然全绿——图标与代码
 * 已经不是同一件事了。所以这里把脚本现渲出来的那几档与 entry 负载**逐字节**比。
 *
 * `renders` 是 `Map<边长, { width, height, channels, data }>`；只要求它给的那几档，因为
 * 256 那档渲染一次的代价比这条规则本身还大，而任何几何或描边改动都会先在小档上显形。
 */
export const icoStalenessViolations = ({ icoBytes, renders, icoPath = ICON_ICO }) => {
  const parsed = icoEntries(icoBytes);
  if (!parsed.ok) return [];
  const violations = [];
  for (const [side, image] of renders || []) {
    const entry = parsed.entries.find((item) => item.side === Number(side));
    if (!entry) {
      violations.push(`${icoPath} 里没有 ${side}px 那一档：这条比较没有对象`);
      continue;
    }
    if (entry.offset + entry.bytes > icoBytes.length) continue; // 越界由 icoEntryViolations 说
    const payload = icoEntryPixels(icoBytes.subarray(entry.offset, entry.offset + entry.bytes));
    if (!payload) {
      violations.push(`${icoPath} 的 ${side}px 那一档解不出像素：没法确认它是不是现在这一版画的`);
      continue;
    }
    if (payload.width !== image.width || payload.height !== image.height) {
      violations.push(
        `${icoPath} 的 ${side}px 那一档是 ${payload.width}×${payload.height}，现在渲出来是 ${image.width}×${image.height}`
      );
      continue;
    }
    let differing = 0;
    let maxDelta = 0;
    for (let index = 0; index < image.data.length; index += 1) {
      const delta = Math.abs(image.data[index] - payload.data[index]);
      if (delta === 0) continue;
      differing += 1;
      maxDelta = Math.max(maxDelta, delta);
    }
    if (differing) {
      violations.push(
        `${icoPath} 的 ${side}px 那一档有 ${differing} 个通道字节与现在渲出来的不一样（最多差 ${maxDelta}）：` +
          "提交的产物是旧的一版——改了 GEOMETRY / strokeFor 之后要跑一次 `npm run icon`"
      );
    }
  }
  return violations;
};

/** 每个 entry 的尺寸与字节数，给门禁自己那句读数用。 */
export const icoSizeReadings = (bytes) => {
  const parsed = icoEntries(bytes);
  if (!parsed.ok) return [];
  return parsed.entries.map((entry) => ({ side: entry.side, bytes: entry.bytes }));
};

/* ---- 单张 PNG ---- */

/**
 * 一张图标 PNG 对不对：边长、不是全同色、字形像素占比在可辨区间里。
 *
 * 占比那一条只对**小尺寸**有意义（大图上怎么画都够多），但规则不按尺寸分叉——一个尺寸
 * 一个判据会让「这一档没被检查」变得没人说得清。
 */
export const iconPngViolations = ({ bytes, side, pngPath, palette, ratioRange = GLYPH_RATIO_RANGE }) => {
  const fill = (palette && palette.fill) || [0, 0, 0];
  const header = pngHeader(bytes);
  if (!header) {
    return [`${pngPath} 不是 PNG（签名或 IHDR 不对）：图标产物必须是 PNG，读到别的说明写图那一步变了`];
  }
  const violations = [];
  if (header.width !== side || header.height !== side) {
    violations.push(
      `${pngPath} 的边长是 ${header.width}×${header.height}，应为 ${side}×${side}：` +
        "electron-builder 按这个边长换算各平台要的档位，差一档会静默用默认图标"
    );
  }
  let image;
  try {
    image = decodePng(bytes);
  } catch (err) {
    violations.push(`${pngPath} 解不开：${err && err.message ? err.message : err}`);
    return violations;
  }
  if (uniformColours(image)) {
    violations.push(
      `${pngPath} 的不透明像素全是同一个颜色：几何画出来一定有字形与底色的交界，` +
        "全同色意味着画上去的东西没了（或者整张被底色盖住）"
    );
    return violations;
  }
  const ratio = glyphPixelRatio(image, fill);
  const [low, high] = ratioRange;
  if (ratio < low || ratio > high) {
    violations.push(
      `${pngPath} 的字形像素占比是 ${(ratio * 100).toFixed(2)}%，应在 ${(low * 100).toFixed(1)}%–${(high * 100).toFixed(1)}% 之间：` +
        (ratio < low
          ? "太低了——就是这个形状让旧图标在任务栏里缩成一块近空的方块"
          : "太高了——字形糊满整格，缩小之后只剩一团浅色")
    );
  }
  return violations;
};

/** 三个色值都能在这张图里找到（每通道容差 `PALETTE_TOLERANCE`）。
 *
 *  只查 `build/icon.png` 与 `assets/icon.png` 这种 ≥32 的档：`build/make-icon.cjs` 从 32
 *  以下就不画镜片的蓝（3px 的蓝盘套在 2px 的环里是噪声），所以 16px 那格查不到蓝色是
 *  **正确形状**，不该红。 */
export const palettePresenceViolations = ({
  bytes,
  palette,
  pngPath,
  tolerance = PALETTE_TOLERANCE,
}) => {
  let image;
  try {
    image = decodePng(bytes);
  } catch (err) {
    return [`${pngPath} 解不开：${err && err.message ? err.message : err}`];
  }
  const violations = [];
  for (const [part, rgb] of Object.entries(palette || {})) {
    let found = false;
    for (let y = 0; y < image.height && !found; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const pixel = pixelAt(image, x, y);
        if (pixel.a < 128) continue;
        if (channelDistance(pixel, rgb) <= tolerance) {
          found = true;
          break;
        }
      }
    }
    if (!found) {
      violations.push(
        `${pngPath} 里找不到 ${part} 色 ${hexOf(rgb)}（容差 ${tolerance}/通道）：` +
          "三个色都该出现在这份产物里——少一个说明按几何画的那一步漏了一种形状"
      );
    }
  }
  return violations;
};

/* ---- 生成参数 ---- */

/** `ICO_SIZES` 与这一条自己的尺寸表逐位相等。反过来的方向是「脚本改了尺寸、断言没跟」：
 * 那时 `.ico` 有六档、断言也要求六档，但两边的六档不是同一批数字。 */
export const icoSizesAgreementViolations = ({ sides, expected = ICON_SIDES, scriptPath = ICON_SCRIPT }) => {
  const actual = Array.isArray(sides) ? sides.map(Number) : [];
  if (actual.length !== expected.length) {
    return [
      `${scriptPath} 的 ICO_SIZES 有 ${actual.length} 个尺寸（${actual.join(", ")}），` +
        `这一条断言的是 ${expected.length} 个（${expected.join(", ")}）：两边要一起改`,
    ];
  }
  const violations = [];
  expected.forEach((side, index) => {
    if (actual[index] === side) return;
    violations.push(
      `${scriptPath} 的 ICO_SIZES[${index}] 是 ${actual[index]}，这一条断言的是 ${side}：` +
        "`build/icon.ico` 的 entry 顺序按前者生成、按后者核对，两边不同就会把「顺序对齐」判成对"
    );
  });
  return violations;
};

/**
 * `strokeFor` 的形状：两端各取对应常数、中间严格插值、两头夹住，并且落到像素上时
 * 16px 够粗、256px 不够粗得离谱。
 *
 * 不在这里写死 0.12 / 0.086：那两个数是 `build/make-icon.cjs` 的 `GEOMETRY` 说的事，抄一遍
 * 就是第二个权威。这里断言的是**它们与尺寸的关系**，以及两条从「看得见」出发的边界
 * （`MIN_STROKE_PX` / `MAX_STROKE_PX`）——改参数不用改规则，改坏了规则才红。
 */
export const strokeShapeViolations = ({ strokeFor, geometry, scriptPath = ICON_SCRIPT }) => {
  const violations = [];
  const small = geometry.strokeSmallUntil;
  const large = geometry.strokeLargeFrom;
  const atSmall = strokeFor(small);
  const atLarge = strokeFor(large);
  if (atSmall !== geometry.strokeAtSmall) {
    violations.push(
      `${scriptPath} 的 strokeFor(${small}) 是 ${atSmall}，而 GEOMETRY.strokeAtSmall 是 ${geometry.strokeAtSmall}：` +
        "小尺寸那一端不落在自己的常数上"
    );
  }
  if (atLarge !== geometry.strokeAtLarge) {
    violations.push(
      `${scriptPath} 的 strokeFor(${large}) 是 ${atLarge}，而 GEOMETRY.strokeAtLarge 是 ${geometry.strokeAtLarge}：` +
        "大尺寸那一端不落在自己的常数上"
    );
  }
  const mid = (small + large) / 2;
  const between = strokeFor(mid);
  if (!(between < atSmall && between > atLarge)) {
    violations.push(
      `${scriptPath} 的 strokeFor(${mid}) 是 ${between}，没有落在 ${atLarge}–${atSmall} 之间：` +
        "中间不插值的话，尺寸一变描边就跳一级"
    );
  }
  if (strokeFor(small / 2) !== atSmall) {
    violations.push(
      `${scriptPath} 的 strokeFor(${small / 2}) 是 ${strokeFor(small / 2)}，应等于小尺寸那一端 ${atSmall}：` +
        "更小的档位没有兜底，描边会细过 16px 那一档"
    );
  }
  if (strokeFor(BUILDER_ICON_SIDE) !== atLarge) {
    violations.push(
      `${scriptPath} 的 strokeFor(${BUILDER_ICON_SIDE}) 是 ${strokeFor(BUILDER_ICON_SIDE)}，应等于大尺寸那一端 ${atLarge}：` +
        "1024 上不该比 48 更细"
    );
  }
  const grid = [8, small, mid, large, 64, 256, BUILDER_ICON_SIDE];
  for (let index = 1; index < grid.length; index += 1) {
    const previous = strokeFor(grid[index - 1]);
    const current = strokeFor(grid[index]);
    if (current > previous + 1e-12) {
      violations.push(
        `${scriptPath} 的 strokeFor 在 ${grid[index - 1]} → ${grid[index]} 上变粗了（${previous} → ${current}）：` +
          "尺寸越大描边该越细，反过来会让大图成一块板"
      );
      break;
    }
  }
  const smallPx = atSmall * small;
  if (smallPx < MIN_STROKE_PX) {
    violations.push(
      `${scriptPath} 在 ${small}px 上的描边只有 ${smallPx.toFixed(2)}px（下限 ${MIN_STROKE_PX}px）：` +
        "细过这条线就会被抗锯齿吃成灰雾，和旧图标同一个下场"
    );
  }
  const largePx = atLarge * 256;
  if (largePx > MAX_STROKE_PX) {
    violations.push(
      `${scriptPath} 在 256px 上的描边是 ${largePx.toFixed(2)}px（上限 ${MAX_STROKE_PX}px）：` +
        "再粗就不是镜片环了，是一块描了边的板"
    );
  }
  return violations;
};

/** `package.json` 里那五处引用仍指向这一份产物的文件名。改文件名而没改这些引用时，
 *  electron-builder 会**静默**用它自己的默认图标，而没有任何一步会红。 */
export const packageJsonIconViolations = (
  pkg,
  { icoPath = ICON_ICO, pngPath = BUILDER_ICON } = {}
) => {
  const build = (pkg && pkg.build) || {};
  const win = build.win || {};
  const nsis = build.nsis || {};
  const expected = [
    ["build.win.icon", win.icon, icoPath],
    ["build.nsis.installerIcon", nsis.installerIcon, icoPath],
    ["build.nsis.uninstallerIcon", nsis.uninstallerIcon, icoPath],
    ["build.nsis.installerHeaderIcon", nsis.installerHeaderIcon, icoPath],
    ["build.mac.icon", (build.mac || {}).icon, pngPath],
    ["build.linux.icon", (build.linux || {}).icon, pngPath],
  ];
  const violations = [];
  for (const [field, actual, wanted] of expected) {
    if (actual === wanted) continue;
    violations.push(
      `package.json 的 ${field} 是 ${JSON.stringify(actual)}，应为 ${JSON.stringify(wanted)}：` +
        "文件名改了而引用没改时，构建会静默换成默认图标——没有任何一步会红"
    );
  }
  return violations;
};

/** 旧源图必须真的不在了：它是一张救不回来的渲染，留着就会被下一次「参考一下旧图」捡回去。 */
export const legacySourceViolations = ({ exists, sourcePath = LEGACY_SOURCE }) =>
  exists
    ? [
        `${sourcePath} 又出现了：第 127 轮删掉它是个决定（字形与底色只有 1.38:1，` +
          `改阈值 / 调色救不回来），图标现在由 ${ICON_SCRIPT} 按几何画——这张图留着就会被当成源`,
      ]
    : [];

/* ---- 一整个仓库 ---- */

/**
 * 把上面所有断言串成一份违规清单。参数都是「已经读进来的字节 / 已经解析出来的值」，
 * 读文件本身不在这里做：这样 smoke 可以把任意一份夹具塞进来，而不必去改仓库里的文件。
 */
export const iconViolations = ({
  icoBytes,
  builderPng,
  appPng,
  legacySourceExists = false,
  css,
  palette,
  variables,
  pkg,
  sides,
  strokeFor,
  geometry,
  paths = {},
}) => [
  ...icoEntryViolations(icoBytes, { sides: sides || ICON_SIDES, icoPath: paths.ico || ICON_ICO }),
  ...iconPngViolations({
    bytes: builderPng,
    side: BUILDER_ICON_SIDE,
    pngPath: paths.builder || BUILDER_ICON,
    palette,
  }),
  ...iconPngViolations({
    bytes: appPng,
    side: APP_ICON_SIDE,
    pngPath: paths.app || APP_ICON,
    palette,
  }),
  ...icoLegibilityViolations(icoBytes, {
    sides: sides || ICON_SIDES,
    fill: (palette && palette.fill) || [0, 0, 0],
    icoPath: paths.ico || ICON_ICO,
  }),
  ...palettePresenceViolations({ bytes: builderPng, palette, pngPath: paths.builder || BUILDER_ICON }),
  ...palettePresenceViolations({ bytes: appPng, palette, pngPath: paths.app || APP_ICON }),
  ...paletteDriftViolations({
    css,
    palette,
    variables,
    stylePath: paths.style || STYLE_SHEET,
    scriptPath: paths.script || ICON_SCRIPT,
  }),
  ...icoSizesAgreementViolations({ sides, scriptPath: paths.script || ICON_SCRIPT }),
  ...strokeShapeViolations({ strokeFor, geometry, scriptPath: paths.script || ICON_SCRIPT }),
  ...packageJsonIconViolations(pkg, { icoPath: paths.ico || ICON_ICO, pngPath: paths.builder || BUILDER_ICON }),
  ...legacySourceViolations({ exists: legacySourceExists, sourcePath: paths.legacy || LEGACY_SOURCE }),
];

/* ---- the run ---- */

const readFile = (target) => {
  const full = path.join(ROOT, target);
  return fs.existsSync(full) ? fs.readFileSync(full) : null;
};

const isEntryPoint =
  process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;

if (isEntryPoint) {
  let makeIcon = null;
  let loadError = "";
  try {
    makeIcon = require(path.join(ROOT, ICON_SCRIPT));
  } catch (err) {
    loadError = err && err.message ? err.message : String(err);
  }

  const icoBytes = readFile(ICON_ICO) || Buffer.alloc(0);
  const builderPng = readFile(BUILDER_ICON) || Buffer.alloc(0);
  const appPng = readFile(APP_ICON) || Buffer.alloc(0);
  const css = (readFile(STYLE_SHEET) || Buffer.alloc(0)).toString("utf8");
  const pkgBytes = readFile("package.json");
  const pkg = pkgBytes ? JSON.parse(pkgBytes.toString("utf8")) : {};

  const violations = [];
  if (!makeIcon) {
    violations.push(
      `${ICON_SCRIPT} 读不进来（${loadError}）：这一条的色值、尺寸表与 strokeFor 都从那里取，` +
        "脚本自己起不来时不能算绿"
    );
  } else {
    violations.push(
      ...iconViolations({
        icoBytes,
        builderPng,
        appPng,
        legacySourceExists: fs.existsSync(path.join(ROOT, LEGACY_SOURCE)),
        css,
        palette: makeIcon.PALETTE,
        variables: makeIcon.THEME_VARIABLES,
        pkg,
        sides: makeIcon.ICO_SIZES,
        strokeFor: makeIcon.strokeFor,
        geometry: makeIcon.GEOMETRY,
      })
    );
  }

  // 读数：门禁自己印出来的那几个数字，谁想知道「图标现在长什么样」都不用先装环境。
  const readings = icoSizeReadings(icoBytes);
  const ratios = icoGlyphRatios(icoBytes, { fill: makeIcon ? makeIcon.PALETTE.fill : [0, 0, 0] });
  console.log(
    `${ICON_ICO}：${icoBytes.length} 字节，${readings.length} 个 entry（` +
      `${readings
        .map((entry) => {
          const ratio = ratios.find((item) => item.side === entry.side);
          return `${entry.side}:${entry.bytes}B/${ratio && ratio.ratio !== null ? `${(ratio.ratio * 100).toFixed(1)}%` : "?"}`;
        })
        .join(" ")}）`
  );
  if (makeIcon) {
    console.log(
      `描边：${[16, 32, 48, 256]
        .map((side) => `${side}px→${(makeIcon.strokeFor(side) * side).toFixed(2)}px`)
        .join("，")}；三色 ${Object.entries(makeIcon.PALETTE)
        .map(([part, rgb]) => `${part} ${hexOf(rgb)}`)
        .join("，")}（解析自 ${STYLE_SHEET} 的暗色主题块）`
    );
  }
  for (const [label, bytes, side] of [
    [BUILDER_ICON, builderPng, BUILDER_ICON_SIDE],
    [APP_ICON, appPng, APP_ICON_SIDE],
  ]) {
    let line = `${label}：${bytes.length} 字节`;
    try {
      const image = decodePng(bytes);
      const fill = makeIcon ? makeIcon.PALETTE.fill : [0, 0, 0];
      line += `，${image.width}×${image.height}，字形像素占比 ${(glyphPixelRatio(image, fill) * 100).toFixed(2)}%`;
    } catch (err) {
      line += `（解不开：${err && err.message ? err.message : err}）`;
    }
    console.log(line);
  }

  for (const violation of violations) console.log(`FAIL    ${violation}`);
  if (violations.length) {
    console.log(
      `\n${violations.length} 处问题。规则写在 tools/icon-rules.mjs 顶部，反向控制在 tools/icon-rules-smoke.mjs。`
    );
    process.exit(1);
  }
  console.log(
    `图标产物：0 处问题（${readings.length} 档边长各自渲染、16px 字形占比在 ${(GLYPH_RATIO_RANGE[0] * 100).toFixed(0)}%–${(GLYPH_RATIO_RANGE[1] * 100).toFixed(0)}% 之间、三色来自 ${STYLE_SHEET}、` +
      `${LEGACY_SOURCE} 仍不在）`
  );
}
