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
 * Two sources, in this order:
 *   1. the official GitHub release asset — same URL + sha256 manifest the CLI's
 *      own installer uses;
 *   2. `@alibaba-group/ocr-<platform>` from the npm registry, same version, which
 *      is the *same binary* the release asset is (the CLI publishes both), taken
 *      through `npm pack` so npm's own integrity check applies to the bytes.
 * The fallback is not a convenience: a box whose GitHub release-asset CDN stalls
 * (measured on the Linux packaging box: 0 bytes in 30s for `opencodereview-windows-amd64.exe`,
 * while the registry delivered the 56 MB package in seconds) otherwise cannot
 * package for any platform but its own, which is what puts a release back on the
 * machine that happens to have good network.
 *
 * Whichever source answers, the bytes are checked against a digest before they
 * land: the GitHub `sha256sum.txt` when it is reachable, otherwise the registry's
 * copy of the same file. And the write is atomic (`<file>.part` then rename),
 * because a killed download used to leave a truncated `.exe` at the final path,
 * where `already present, skipping` read it as success and electron-builder
 * packaged it.
 *
 * Usage:
 *   node build/fetch-binaries.cjs              # every platform
 *   node build/fetch-binaries.cjs mac linux    # only those (win|mac|linux)
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { execFileSync } = require("node:child_process");

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

const DOWNLOAD_TIMEOUT_MS = 120_000;

/** Set once this run has met a transport failure against the release-asset CDN:
 *  it is a fact about the route, so the remaining targets need not each wait out
 *  the same two minutes. `null` means "not learned yet". */
let releaseAssetChannelDown = null;

/** Whether an error says "this box could not get an answer" rather than "the bytes
 *  that came back are not the bytes that were promised". */
function isTransportFailure(err) {
  const msg = String((err && err.message) || err || "");
  if (/checksum mismatch/i.test(msg)) return false;
  return /no answer within|ECONN|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket hang up|socket disconnected|disconnected before secure|other side closed|HTTP [45]\d\d|getaddrinfo/i.test(msg);
}

function download(url, maxRedirects = 10) {
  if (!url.startsWith("https")) return Promise.reject(new Error(`Refusing non-HTTPS download: ${url}`));
  if (maxRedirects <= 0) return Promise.reject(new Error(`Too many redirects: ${url}`));
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "user-agent": "open-code-review-desktop-fetch" }, timeout: DOWNLOAD_TIMEOUT_MS }, (res) => {
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
    });
    // Silent sockets are the failure mode here, not refused connections: the
    // release-asset CDN can hold a connection open and answer nothing, and a
    // hanging script never reaches the registry fallback that would answer.
    req.on("timeout", () => {
      req.destroy(new Error(`no answer within ${DOWNLOAD_TIMEOUT_MS / 1000}s for ${url}`));
    });
    req.on("error", reject);
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
  // Written to a sibling and renamed at the end: a killed download must not leave
  // a truncated file at `dest`, because `dest` existing is what the next run reads
  // as "already there".
  const part = `${dest}.part`;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(part);
    res.on("error", (err) => {
      out.destroy();
      fs.unlink(part, () => {});
      reject(err);
    });
    res.pipe(out);
    out.on("finish", () => out.close(resolve));
    out.on("error", (err) => {
      fs.unlink(part, () => {});
      reject(err);
    });
  });
  fs.renameSync(part, dest);
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

/** The digest the upstream `sha256sum.txt` names for this target, or `null` when
 *  that manifest could not be read — on the packaging box it usually cannot be,
 *  because it lives behind the same release-asset CDN as the binaries. */
function manifestDigest(checksums, target) {
  if (!Array.isArray(checksums)) return null;
  const line = checksums.find((l) => l.includes(`-${target.os}-${target.arch}`));
  if (!line) return null;
  const digest = line.trim().split(/\s+/)[0].toLowerCase();
  return /^[0-9a-f]{64}$/.test(digest) ? digest : null;
}

const registryCopies = new Map();

/**
 * The same version's binary as the npm registry publishes it.
 *
 * `npm pack` fetches the tarball the registry holds and npm itself checks it
 * against the packument's `dist.integrity`, so the bytes out of it are
 * authenticated by the registry rather than by this script — which is the whole
 * reason it can stand in for a GitHub asset this box cannot reach. The CLI ships
 * `@alibaba-group/ocr-<platform>` packages at the same version as its release
 * assets, so the two sources are the same file, and where both answered we say so
 * by comparing digests instead of assuming it.
 */
function registryBinary(target, version, workDir) {
  const key = `${target.pkg}@${version}`;
  if (!registryCopies.has(key)) {
    registryCopies.set(key, (async () => {
      const dir = path.join(workDir, path.basename(target.pkg));
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const listed = execFileSync("npm", ["pack", `${target.pkg}@${version}`, "--pack-destination", dir], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const tgz = listed
        .trim()
        .split(/\r?\n/)
        .pop();
      if (!tgz || !tgz.endsWith(".tgz")) throw new Error(`npm pack 没有报出 tarball 名（拿到 ${JSON.stringify(listed.trim())}）`);
      execFileSync("tar", ["-xzf", path.join(dir, tgz), "-C", dir, `package/bin/${binaryName(target.os)}`], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const file = path.join(dir, "package", "bin", binaryName(target.os));
      if (!fs.existsSync(file)) throw new Error(`${target.pkg} 的 tarball 里没有 package/bin/${binaryName(target.os)}`);
      return { file, sha256: await sha256(file) };
    })());
  }
  return registryCopies.get(key);
}

/**
 * Put the bytes at the final path, and make the package resolvable.
 *
 * Renamed in from a sibling rather than written in place, so a build interrupted
 * here leaves either the old file or the new one, never half of either.
 */
async function installBinary(target, sourceFile, version, digest, source) {
  const pkgDir = path.join(SCOPE_DIR, path.basename(target.pkg));
  const binDir = path.join(pkgDir, "bin");
  const binFile = path.join(binDir, binaryName(target.os));
  fs.mkdirSync(binDir, { recursive: true });
  const staged = `${binFile}.staged`;
  fs.copyFileSync(sourceFile, staged);
  if (target.os !== "windows") {
    try {
      fs.chmodSync(staged, 0o755);
    } catch (err) {
      warn(`${target.key}: could not chmod: ${err.message}`);
    }
  }
  fs.renameSync(staged, binFile);

  // A minimal package.json so `require.resolve("@alibaba-group/ocr-<plat>")`
  // (used by the CLI's own resolveNativeBinary) finds it after packaging.
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: target.pkg, version, license: "Apache-2.0" }, null, 2) + "\n");
  log(`${target.key}: installed from ${source}, sha256 ${String(digest).slice(0, 12)}…`);
  return "fetched";
}

async function fetchTarget(target, { version, urlPattern, checksums, workDir, preferRegistry = false }) {
  const binDir = path.join(SCOPE_DIR, path.basename(target.pkg), "bin");
  const binFile = path.join(binDir, binaryName(target.os));
  const want = manifestDigest(checksums, target);
  // An interrupted run leaves `.part` / `.staged` siblings behind; they are shapes
  // of "not yet the file", never shapes of "the file", so they are dropped before
  // anything asks whether the binary is present.
  for (const leftover of [`${binFile}.part`, `${binFile}.staged`]) fs.rmSync(leftover, { force: true });

  // The registry copy is asked for only when a digest is actually needed: with the
  // upstream manifest in hand, pulling a 56 MB tarball to prove a file is itself
  // would be a cost paid for nothing.
  let registryAsked = null;
  const getRegistry = () => {
    if (registryAsked === null) {
      registryAsked = registryBinary(target, version, workDir).catch((err) => {
        warn(`${target.key}: registry unavailable (${err.message})`);
        return null;
      });
    }
    return registryAsked;
  };

  if (fs.existsSync(binFile)) {
    const have = await sha256(binFile);
    if (want && have === want) {
      log(`${target.key}: already present, sha256 matches the upstream manifest`);
      return "skipped";
    }
    const registry = await getRegistry();
    if (registry) {
      const expected = want || registry.sha256;
      const named = want ? "上游清单" : "registry";
      if (have === expected) {
        log(`${target.key}: already present, byte-identical to the ${named} copy`);
        return "skipped";
      }
      if (want && registry.sha256 !== want) {
        throw new Error(`${target.key}: 两条来源互相矛盾——上游清单是 ${want}，registry 是 ${registry.sha256}，本地那一份两边都不是`);
      }
      warn(`${target.key}: 已有的那一份与${named}不符（本地 ${have.slice(0, 12)}… vs ${expected.slice(0, 12)}…），换成 registry 的那一份`);
      return installBinary(target, registry.file, version, registry.sha256, "npm registry");
    }
    // Nothing to compare against: a binary `npm install` put there on the host
    // platform is legitimate, and an offline box still has to be able to package.
    // "Unverifiable here" is said out loud rather than turned into a refusal.
    warn(`${target.key}: 上游清单与 registry 这一次都读不到，无法核对已有的那一份（sha256 ${have.slice(0, 12)}…）——保留它`);
    return "skipped";
  }

  let got = null;
  let url = buildUrl(urlPattern, version, target.os, target.arch);
  if (target.os === "windows") url += ".exe";
  if (preferRegistry) {
    // A route that trickles instead of stalling never trips the socket timeout: that
    // is how one 56 MB asset occupied an hour on the packaging box while the registry
    // answered in seconds. `OCR_FETCH_PREFER_REGISTRY=1`, or a manifest this box could
    // not read, says "don't start the slow one".
    log(`${target.key}: 按要求先走 npm registry（OCR_FETCH_PREFER_REGISTRY 或上游清单不可达）`);
  } else if (releaseAssetChannelDown !== null) {
    log(`${target.key}: release-asset CDN 这一趟已经答过一次不通（${releaseAssetChannelDown}），直接走 registry`);
  } else {
    try {
      fs.mkdirSync(binDir, { recursive: true });
      log(`${target.key}: downloading ${url}`);
      await downloadFile(url, binFile);
      got = await sha256(binFile);
      if (want && got !== want) {
        fs.rmSync(binFile, { force: true });
        got = null;
        throw new Error(`checksum mismatch (expected ${want}, got the downloaded bytes)`);
      }
      if (want) return installBinary(target, binFile, version, want, "GitHub release");
    } catch (err) {
      fs.rmSync(binFile, { force: true });
      warn(`${target.key}: GitHub release asset unusable (${err.message})`);
      if (isTransportFailure(err)) {
        // A socket that answers nothing is a fact about this box, not about this
        // target: the remaining ones would each wait out the same timeout.
        releaseAssetChannelDown = err.message;
      }
    }
  }

  const registry = await getRegistry();
  if (!registry) {
    if (!got) throw new Error(`${target.key}: GitHub 资产与 npm registry 都没给出可用的那一份`);
    warn(`${target.key}: 没有可核对的摘要（清单与 registry 都没答），用 GitHub 的那一份但不声称验过`);
    return installBinary(target, binFile, version, got, "GitHub release (unverified)");
  }
  if (want && registry.sha256 !== want) {
    throw new Error(`${target.key}: registry 里那一份与上游清单不符（${registry.sha256} vs ${want}）`);
  }
  if (got && got !== registry.sha256) {
    throw new Error(`${target.key}: GitHub 与 registry 给的不是同一份字节（${got.slice(0, 12)}… vs ${registry.sha256.slice(0, 12)}…）`);
  }
  return installBinary(target, registry.file, version, registry.sha256, "npm registry");
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
  let preferRegistry = ["1", "true"].includes(String(process.env.OCR_FETCH_PREFER_REGISTRY || "").toLowerCase());
  if (checksumPattern) {
    const checksumUrl = buildUrl(checksumPattern, version, "windows", "amd64"); // {os}/{arch} are unused here
    try {
      checksums = (await downloadText(checksumUrl)).split("\n");
    } catch (err) {
      warn(`could not download checksum manifest (${err.message}); the registry copy answers instead`);
      // The manifest sits on the same host as the binaries, so a manifest this box
      // could not read is a fact about the route, not about one file.
      preferRegistry = true;
    }
  }
  if (preferRegistry) log("来源顺序：npm registry 优先（操作者指定，或上游清单读不到）");

  // Not `os.tmpdir()`: on the box that packages Windows artefacts, /tmp is a tmpfs
  // under a per-user quota, and the extraction died there with `Wrote only 512 of
  // 10240 bytes` while unpacking a 56 MB binary. The scratch belongs on the same
  // volume as the destination it is filling. Dot-prefixed so npm and
  // electron-builder keep ignoring it.
  const workDir = fs.mkdtempSync(path.join(ROOT, "node_modules", ".fetch-binaries-"));
  log(`ocr version ${version}; targets: ${wanted.map((t) => t.key).join(", ")}`);
  try {
    let fetched = 0;
    for (const target of wanted) {
      try {
        if ((await fetchTarget(target, { version, urlPattern, checksums, workDir, preferRegistry })) === "fetched") fetched++;
      } catch (err) {
        warn(`${target.key}: FAILED — ${err.message}`);
        process.exitCode = 1;
      }
    }
    log(`done (${fetched} fetched)`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
