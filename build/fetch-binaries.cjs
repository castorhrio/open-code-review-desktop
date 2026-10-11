// SPDX-License-Identifier: Apache-2.0
"use strict";
/*
 * Fetch the ocr native binary for every platform we ship.
 *
 * Why this exists: `@alibaba-group/open-code-review` pulls its binary in through
 * optionalDependencies, and npm only installs the package matching the *host*
 * platform. So a Windows machine ends up with ocr-win32-x64 only, and a
 * `electron-builder --mac` / `--linux` run would package an app whose
 * `resolveNativeBinary()` finds nothing at runtime.
 *
 * This script downloads the missing binaries straight from the official GitHub
 * release (same URL + sha256 manifest the CLI's own installer uses) and drops
 * them into the matching `node_modules/@alibaba-group/ocr-*` package so
 * electron-builder can pick them up.
 *
 * Usage:
 *   node build/fetch-binaries.cjs              # every platform
 *   node build/fetch-binaries.cjs mac linux    # only those (win|mac|linux)
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const OCR_PKG_DIR = path.join(ROOT, "node_modules", "@alibaba-group", "open-code-review");
const SCOPE_DIR = path.join(ROOT, "node_modules", "@alibaba-group");

// package name suffix -> { os, arch } as used in the release URL template.
const TARGETS = [
  { key: "darwin-arm64", pkg: "@alibaba-group/ocr-darwin-arm64", os: "darwin", arch: "arm64", family: "mac" },
  { key: "darwin-x64", pkg: "@alibaba-group/ocr-darwin-x64", os: "darwin", arch: "amd64", family: "mac" },
  { key: "linux-arm64", pkg: "@alibaba-group/ocr-linux-arm64", os: "linux", arch: "arm64", family: "linux" },
  { key: "linux-x64", pkg: "@alibaba-group/ocr-linux-x64", os: "linux", arch: "amd64", family: "linux" },
  { key: "win32-arm64", pkg: "@alibaba-group/ocr-win32-arm64", os: "windows", arch: "arm64", family: "win" },
  { key: "win32-x64", pkg: "@alibaba-group/ocr-win32-x64", os: "windows", arch: "amd64", family: "win" },
];

const log = (msg) => console.log(`[fetch-binaries] ${msg}`);
const warn = (msg) => console.warn(`[fetch-binaries] ${msg}`);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function download(url, maxRedirects = 10) {
  if (!url.startsWith("https")) return Promise.reject(new Error(`Refusing non-HTTPS download: ${url}`));
  if (maxRedirects <= 0) return Promise.reject(new Error(`Too many redirects: ${url}`));
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "user-agent": "open-code-review-desktop-fetch" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          download(res.headers.location, maxRedirects - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        resolve(res);
      })
      .on("error", reject);
  });
}

async function downloadText(url) {
  const res = await download(url);
  return new Promise((resolve, reject) => {
    let data = "";
    res.on("data", (c) => (data += c));
    res.on("end", () => resolve(data));
    res.on("error", reject);
  });
}

async function downloadFile(url, dest) {
  const res = await download(url);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    res.on("error", (err) => {
      out.destroy();
      fs.unlink(dest, () => {});
      reject(err);
    });
    res.pipe(out);
    out.on("finish", () => out.close(resolve));
    out.on("error", reject);
  });
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const s = fs.createReadStream(file);
    s.on("data", (c) => hash.update(c));
    s.on("end", () => resolve(hash.digest("hex")));
    s.on("error", reject);
  });
}

const binaryName = (os) => (os === "windows" ? "opencodereview.exe" : "opencodereview");

function buildUrl(pattern, version, os, arch) {
  return pattern.replace(/\{version\}/g, version).replace(/\{os\}/g, os).replace(/\{arch\}/g, arch);
}

async function fetchTarget(target, { version, urlPattern, checksumPattern, checksums }) {
  const binDir = path.join(SCOPE_DIR, path.basename(target.pkg), "bin");
  const binFile = path.join(binDir, binaryName(target.os));

  if (fs.existsSync(binFile)) {
    log(`${target.key}: already present, skipping`);
    return "skipped";
  }

  fs.mkdirSync(binDir, { recursive: true });
  let url = buildUrl(urlPattern, version, target.os, target.arch);
  if (target.os === "windows") url += ".exe";
  log(`${target.key}: downloading ${url}`);

  await downloadFile(url, binFile);

  if (checksums && checksumPattern) {
    const expected = checksums.find((line) => line.includes(`-${target.os}-${target.arch}`));
    if (!expected) {
      fs.unlinkSync(binFile);
      throw new Error(`no checksum entry for ${target.os}-${target.arch}`);
    }
    const want = expected.trim().split(/\s+/)[0].toLowerCase();
    const got = await sha256(binFile);
    if (want !== got) {
      fs.unlinkSync(binFile);
      throw new Error(`checksum mismatch (expected ${want}, got ${got})`);
    }
    log(`${target.key}: checksum ok`);
  }

  if (target.os !== "windows") {
    try {
      fs.chmodSync(binFile, 0o755);
    } catch (err) {
      warn(`${target.key}: could not chmod: ${err.message}`);
    }
  }

  // A minimal package.json so `require.resolve("@alibaba-group/ocr-<plat>")`
  // (used by the CLI's own resolveNativeBinary) finds it after packaging.
  fs.writeFileSync(
    path.join(SCOPE_DIR, path.basename(target.pkg), "package.json"),
    JSON.stringify({ name: target.pkg, version, license: "Apache-2.0" }, null, 2) + "\n"
  );
  return "fetched";
}

async function main() {
  const families = process.argv.slice(2).filter((a) => ["win", "mac", "linux"].includes(a));
  const wanted = families.length ? TARGETS.filter((t) => families.includes(t.family)) : TARGETS;

  if (!fs.existsSync(path.join(OCR_PKG_DIR, "package.json"))) {
    console.error("Run `npm install` first: @alibaba-group/open-code-review is not present.");
    process.exit(1);
  }

  const ocrPkg = readJson(path.join(OCR_PKG_DIR, "package.json"));
  const version = ocrPkg.version;
  const { urlPattern, checksumPattern } = ocrPkg.ocrConfig || {};
  if (!urlPattern) {
    console.error("open-code-review package.json has no ocrConfig.urlPattern.");
    process.exit(1);
  }

  let checksums = null;
  if (checksumPattern) {
    const checksumUrl = buildUrl(checksumPattern, version, "windows", "amd64"); // {os}/{arch} are unused here
    try {
      checksums = (await downloadText(checksumUrl)).split("\n");
    } catch (err) {
      warn(`could not download checksum manifest (${err.message}); continuing without verification`);
    }
  }

  log(`ocr version ${version}; targets: ${wanted.map((t) => t.key).join(", ")}`);
  let fetched = 0;
  for (const target of wanted) {
    try {
      if ((await fetchTarget(target, { version, urlPattern, checksumPattern, checksums })) === "fetched") fetched++;
    } catch (err) {
      warn(`${target.key}: FAILED — ${err.message}`);
      process.exitCode = 1;
    }
  }
  log(`done (${fetched} fetched)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
