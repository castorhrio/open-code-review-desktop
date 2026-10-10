// SPDX-License-Identifier: Apache-2.0
"use strict";
// One-off asset generator: turns the raw AI-rendered icon into electron-builder
// assets (build/icon.png + a multi-resolution build/icon.ico).
//
// The raw render has two problems for a Windows app icon:
//   1. a light-grey canvas behind the rounded square (would show as a white box)
//   2. a small watermark glyph cluster in the bottom-right corner
// Fix: derive alpha from colour distance to the background, drop every connected
// component except the biggest one (the squircle), then crop to a square.

const fs = require("fs");
const path = require("path");
const Jimp = require("jimp");
const icoModule = require("png-to-ico");
// png-to-ico ships as ESM interop: the callable lives on .default (v3 also
// exposes imagesToIco for the multi-size case).
const pngToIco =
  typeof icoModule === "function" ? icoModule : icoModule.default || icoModule.imagesToIco;

const SRC = process.argv[2];
const OUT_DIR = path.resolve(__dirname);
if (!SRC || !fs.existsSync(SRC)) {
  console.error("usage: node build/make-icon.cjs <source.png>");
  process.exit(1);
}

const ICO_SIZES = [256, 128, 64, 48, 32, 16];
const T_LO = 18; // <= this distance from the background colour -> fully transparent
const T_HI = 60; // >= this distance -> fully opaque

async function main() {
  const img = await Jimp.read(SRC);
  const { width: W, height: H, data } = img.bitmap;

  const bgAt = (x, y) => {
    const i = (y * W + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const bg = [...bgAt(1, 1), ...bgAt(W - 2, 1), ...bgAt(1, H - 2), ...bgAt(W - 2, H - 2)].reduce(
    (acc, _v, idx) => {
      acc[idx % 3] += _v / 4;
      return acc;
    },
    [0, 0, 0]
  );

  // 1. alpha from colour distance to the background
  const mask = new Uint8Array(W * H); // 0 = background, 1 = foreground
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    const dist = Math.max(
      Math.abs(data[i] - bg[0]),
      Math.abs(data[i + 1] - bg[1]),
      Math.abs(data[i + 2] - bg[2])
    );
    const a = dist <= T_LO ? 0 : dist >= T_HI ? 255 : Math.round(((dist - T_LO) / (T_HI - T_LO)) * 255);
    data[i + 3] = a;
    mask[p] = a >= 128 ? 1 : 0;
  }

  // 2. keep only the largest connected foreground component (kills the watermark)
  const label = new Int32Array(W * H).fill(-1);
  let best = -1;
  let bestSize = 0;
  const queue = new Int32Array(W * H);
  let id = 0;
  for (let start = 0; start < W * H; start++) {
    if (mask[start] !== 1 || label[start] !== -1) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    label[start] = id;
    let size = 0;
    while (head < tail) {
      const cur = queue[head++];
      size++;
      const cx = cur % W;
      const cy = (cur / W) | 0;
      for (const [nx, ny] of [
        [cx - 1, cy],
        [cx + 1, cy],
        [cx, cy - 1],
        [cx, cy + 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (mask[n] === 1 && label[n] === -1) {
          label[n] = id;
          queue[tail++] = n;
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = id;
    }
    id++;
  }
  for (let p = 0; p < W * H; p++) {
    if (label[p] !== best) data[p * 4 + 3] = 0;
  }
  img.bitmap.data = data;
  img.rgba(true);
  console.log(`foreground components: ${id}, kept largest (${bestSize}px)`);

  // 3. crop to the bounding box of the remaining opaque pixels, square it up
  let minX = W,
    minY = H,
    maxX = 0,
    maxY = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const side = Math.max(maxX - minX + 1, maxY - minY + 1);
  const offX = minX - Math.floor((side - (maxX - minX + 1)) / 2);
  const offY = minY - Math.floor((side - (maxY - minY + 1)) / 2);
  img.crop(offX < 0 ? 0 : offX, offY < 0 ? 0 : offY, side, side);
  console.log(`cropped to ${side}x${side} at (${offX},${offY})`);

  // 4. emit icon.png at 1024 (electron-builder wants >= 512)
  const png1024 = img.clone().resize(1024, 1024);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await png1024.writeAsync(path.join(OUT_DIR, "icon.png"));
  console.log("wrote build/icon.png (1024x1024)");

  // 5. emit a multi-resolution .ico so the build never depends on electron-builder's
  //    own icon conversion step
  const tmp = path.join(OUT_DIR, ".ico-tmp");
  fs.mkdirSync(tmp, { recursive: true });
  const files = [];
  for (const s of ICO_SIZES) {
    const f = path.join(tmp, `icon-${s}.png`);
    await img.clone().resize(s, s).writeAsync(f);
    files.push(f);
  }
  const ico = await pngToIco(files.map((f) => fs.readFileSync(f)));
  fs.writeFileSync(path.join(OUT_DIR, "icon.ico"), ico);
  files.forEach((f) => fs.unlinkSync(f));
  fs.rmdirSync(tmp);
  console.log(`wrote build/icon.ico (${ico.length} bytes, sizes ${ICO_SIZES.join(",")})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
