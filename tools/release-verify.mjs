// Can this `release/` be uploaded? Answered by hashing the bytes, not by a glance.
//
// 第 139 轮 made Windows packaging work on this Linux box, and the box then handed
// back the state this script exists for: a run whose `makensis` was OOM-killed left
// `release/` holding `open-code-review-desktop-0.1.13-setup.exe` at **504 KB** next
// to a 96 MB payload archive — no `latest.yml`, no portable, no blockmap. A person
// who has that directory in front of them cannot tell a finished release from a
// half-built one: the file that matters is *named* like a release and is 0.5% of its
// size. Everything downstream of that glance is a published Release with a broken
// installer, or an auto-update feed whose `sha512` does not match the bytes a client
// downloads — and `electron-updater` verifies that hash *after* the download, so the
// failure surfaces on someone else's machine as an update that never completes.
//
// So the question "发之前本地能验到哪一层" has a second layer, after "造得出来":
// **造出来的那四件是不是同一版、是不是那些字节**。It is answered here rather than in
// `docs/win-install-checklist.md` because it needs no Windows machine: it needs the
// feed file and a hash.
//
// WHAT IS READ, AND WHY EACH LINE IS NOT NEGOTIABLE
// - `latest.yml` is the update feed. Its `version` is what installed clients compare
//   to decide they have an update, and its `sha512` / `size` are what they verify
//   after downloading. Both halves of that pair come from the *build*, so a doc or a
//   tag quoting them cannot stand in: they are re-computed from the bytes on disk
//   here, streaming (a 97 MB setup.exe must not be read into memory on a box whose
//   packaging already got OOM-killed).
// - The four files are what every published release carries, and the set is derived
//   from `package.json` (`build.win.target`, `build.nsis.differentialPackage`,
//   `build.publish`) instead of being spelled here: change a target and the answer
//   follows, which is the opposite of a list that quietly stops matching the build.
// - A *stale* artifact from another version in the same directory is its own
//   violation. Uploading the wrong `setup.exe` beside a right `latest.yml` is not a
//   hypothetical — it is what a directory with two builds in it invites.
// - `release/win-unpacked/resources/app/node_modules/@alibaba-group/open-code-review`
//   is the CLI the packaged app spawns. `tools/release-pin.mjs` can only answer what
//   the *latest tag* shipped, which is always the last release; this answers what
//   **this** tree will ship, before the tag exists. That is the reading which says
//   whether the next release closes the `1.13.0`-vs-pin gap or re-publishes it.
// - `build.win.signExecutable` says whether the signing step is skipped, and four
//   documents tell the reader the artefacts are unsigned. Those are one fact in two
//   places; flipping the flag without editing the sentences is how a release ends up
//   described as something it is not. This does not verify a signature — it cannot.
// - `build.publish[0].url` is the feed installed clients read. `releases/latest/download/`
//   is the only form that keeps working after the next tag; a pinned tag freezes the
//   update feed for every machine that already downloaded this one.
//
// WHY THE PREDICATES ARE INJECTED
// Every rule below takes its answers (`entries`, `latest`, `sizeAndDigest`,
// `cliManifestVersion`) as arguments, because a function that reads `release/` by
// itself can only be run where a release has been built — and the one thing this
// repository has learned is that a check which cannot be fed a fixture cannot be
// shown to be capable of going red. `tools/release-verify-smoke.mjs` drives these
// against fabricated trees (one fact per fixture) and against the published
// `latest.yml` text verbatim; `main()` is the only part that touches a real disk.
//
// Run: `npm run verify:dist` (or `node tools/release-verify.mjs --dir release-0.1.14`
// to ask about the fallback output dir). Exit 0 = the set is uploadable as far as
// this can tell; 1 = something is missing, mismatched, or from another build;
// 2 = there is no tree to ask about, which is not a pass and says so.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { PINNED_UPSTREAM, pinVersion } from "./upstream-watch.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

export const RELEASE_DIR = "release";
export const LATEST_FILE = "latest.yml";
export const UNPACKED_DIR = "win-unpacked";
export const ARTIFACT_BASE = "open-code-review-desktop";
export const CLI_PACKAGE = "@alibaba-group/open-code-review";
export const CLI_WIN_BINARY = path.join("node_modules", "@alibaba-group", "ocr-win32-x64", "bin", "opencodereview.exe");

export const VERSION_SHAPE = /^\d+\.\d+\.\d+$/;

/** The one command that re-answers this, quoted into any message that needs it. */
export const VERIFY_COMMAND = "npm run verify:dist";

/** The file a role has for a version, or `null` for a role this script does not know. */
export const artifactNameFor = (role, version) => {
  const base = `${ARTIFACT_BASE}-${version}`;
  if (role === "setup") return `${base}-setup.exe`;
  if (role === "portable") return `${base}-portable.exe`;
  if (role === "blockmap") return `${base}-setup.exe.blockmap`;
  if (role === "latest") return LATEST_FILE;
  return null;
};

/** Why a role has to be in the Release at all — the sentence a missing file gets. */
export const ROLE_WHY = Object.freeze({
  setup: "它是读者下载的那一份，也是 `latest.yml` 指向的那一份",
  portable: "两份 README 与 `使用说明.md` 都把它当作免安装那一档在写",
  blockmap: "自动更新按它做差分下载，少了它每一次更新都是整包重下",
  latest: "它是安装版判断「有没有新版」的唯一入口，少了它已装的客户端永远看不见这一版",
});

/**
 * Which files this build owes, read out of the build config rather than from a list.
 *
 * `targets` is `build.win.target` (an array of `{ target }`, or bare strings),
 * `differentialPackage` is `build.nsis.differentialPackage` (electron-builder's own
 * default is true, so "absent" means "has a blockmap"), and `publish` is `build.publish`
 * (no publish config means no feed file was ever emitted, and demanding `latest.yml`
 * there would be this script inventing a requirement the build does not have).
 *
 * An unknown target name is a violation rather than a skip: the day someone adds
 * `nsisWeb` or `zip`, the honest answer is "this script does not know what that
 * builds" — not a green run that checked nothing.
 */
export const requiredRoles = ({ targets = [], differentialPackage = true, hasPublish = true } = {}) => {
  const violations = [];
  const roles = ["setup"];
  const list = Array.isArray(targets) ? targets : [targets];
  for (const entry of list) {
    const name = typeof entry === "string" ? entry : entry && entry.target;
    if (name === "nsis") {
      if (differentialPackage !== false) roles.push("blockmap");
    } else if (name === "portable") {
      roles.push("portable");
    } else {
      violations.push(
        `构建配置里的 target ${JSON.stringify(name)} 是这份脚本不认识的：它出什么文件无从回答，先补 tools/release-verify.mjs 的 requiredRoles`
      );
    }
  }
  if (!list.length) violations.push("构建配置里没有 Windows target：没有可核对的产物清单，这一条不判绿");
  if (hasPublish) roles.push("latest");
  const unique = [...new Set(roles)];
  return { roles: unique, violations };
};

/**
 * `latest.yml`, read as the contract it is.
 *
 * Deliberately not a general YAML parser: the file is emitted by electron-builder in
 * one fixed shape, and the fields asked for below are exactly the ones a client
 * verifies. Unknown keys (`blockMapSize`, whatever a future builder adds) are ignored
 * on purpose — a feed file that carries one more number is still a valid feed, and
 * turning that red would teach the reader to ignore this script.
 *
 * A field this script needs is required literally: `version`, then `files:` with at
 * least one `{url, sha512, size}`, then the top-level `path` and `sha512` that
 * electron-builder keeps beside the list for older clients. Those two halves must
 * agree with each other — a feed whose header and list disagree is two different
 * answers to "what should I download", and the one that wins depends on the client.
 * A top-level `size` is compared the same way *when it is there*: the feed published
 * for v0.1.13 has no such key, so requiring one would refuse a real artefact.
 *
 * `sha512` is checked as base64 of a 64-byte digest (88 characters, `=` padding
 * included) because that is the only format electron-builder writes, and a hash that
 * is 4 characters short is a truncated paste, not a different encoding.
 */
export const parseLatestYml = (text) => {
  const violations = [];
  const out = { version: "", path: "", sha512: "", size: null, releaseDate: "", files: [] };
  if (typeof text !== "string" || text.trim() === "") {
    return { ...out, violations: [`${LATEST_FILE} 读不到或是空的：没有 feed 就没有「下载哪一份、该有多大」的答案`] };
  }
  const lines = text.split(/\r?\n/);
  const top = new Map();
  let inFiles = false;
  let current = null;
  for (let at = 0; at < lines.length; at += 1) {
    const raw = lines[at];
    const line = raw.replace(/\s+$/, "");
    if (line === "" || /^\s*#/.test(line)) continue;
    const entry = /^\s+-\s+([\w-]+):\s*(.*)$/.exec(line);
    if (entry) {
      if (!inFiles) {
        violations.push(`第 ${at + 1} 行在 \`files:\` 之外出现了列表项：这一份 feed 的形状不是 electron-builder 写出来的那一份`);
        continue;
      }
      current = {};
      out.files.push(current);
      applyField(current, entry[1], entry[2], at + 1, violations);
      continue;
    }
    const item = /^\s+([\w-]+):\s*(.*)$/.exec(line);
    if (item && inFiles) {
      if (current === null) {
        violations.push(`第 ${at + 1} 行是 \`files:\` 里的缩进字段，前面却没有列表项`);
        continue;
      }
      applyField(current, item[1], item[2], at + 1, violations);
      continue;
    }
    const field = /^([\w-]+):\s*(.*)$/.exec(line);
    if (!field) {
      violations.push(`第 ${at + 1} 行读不出字段（既不是 \`key: value\`，也不是列表项）：这一份 feed 没法逐字段核对`);
      continue;
    }
    const [, key, value] = field;
    if (key === "files") {
      if (value.trim() !== "") {
        violations.push(`\`files:\` 后面直接跟了内容（${value.trim()}）：Expected a list, one key per line`);
        continue;
      }
      inFiles = true;
      continue;
    }
    inFiles = false;
    current = null;
    if (top.has(key)) violations.push(`顶层字段 \`${key}\` 出现了两次：同一份 feed 对同一件事给了两个答案`);
    top.set(key, value.trim());
  }

  out.version = unquote(top.get("version") || "");
  out.path = unquote(top.get("path") || "");
  out.sha512 = unquote(top.get("sha512") || "");
  out.size = numberOr(top.get("size"));
  out.releaseDate = unquote(top.get("releaseDate") || "");

  if (out.version === "") violations.push(`${LATEST_FILE} 没有 \`version\`：安装版拿它判断「这一版是不是比我现在的新」，少了它这份 feed 不能发布`);
  else if (!VERSION_SHAPE.test(out.version)) violations.push(`${LATEST_FILE} 的 version 是 ${JSON.stringify(out.version)}，不是 x.y.z：客户端的比较逻辑读不出版本号`);
  if (out.files.length === 0) violations.push(`${LATEST_FILE} 里没有 \`files:\` 清单：下载哪一份、多大、什么摘要都无从核对`);
  if (out.path === "") violations.push(`${LATEST_FILE} 没有顶层 \`path\`：那是旧客户端唯一会读的那一格`);
  if (out.sha512 === "") violations.push(`${LATEST_FILE} 没有顶层 \`sha512\``);
  // A top-level `size` is *not* required: the feed electron-builder published for
  // v0.1.13 has no such key, and demanding it would make this script refuse the real
  // artefact. When it is there, it is compared like the other two header fields.
  for (const file of out.files) {
    for (const key of ["url", "sha512", "size"]) {
      if (file[key] === undefined) violations.push(`第 ${file.line} 行那条 \`files:\` 缺 \`${key}\`：清单不完整，客户端只能猜`);
    }
  }
  if (out.files.length && out.path !== out.files[0].url) {
    violations.push(`${LATEST_FILE} 的顶层 \`path\`（${JSON.stringify(out.path)}）与清单第一条（${JSON.stringify(out.files[0].url)}）不是同一份：一份 feed 给了两个下载地址`);
  }
  if (out.files.length && out.sha512 && out.sha512 !== out.files[0].sha512) {
    violations.push(`${LATEST_FILE} 的顶层 \`sha512\` 与清单第一条不相等：下载哪一份都能验证通过，取决于客户端读哪一格`);
  }
  if (out.files.length && out.size !== null && out.size !== out.files[0].size) {
    violations.push(`${LATEST_FILE} 的顶层 \`size\`（${out.size}）与清单第一条（${out.files[0].size}）不相等：判断「下载完了没有」的两格给了两个答案`);
  }
  return { ...out, violations };
};

const unquote = (value) => String(value).replace(/^['"]|['"]$/g, "");

const numberOr = (value) => {
  const raw = unquote(value);
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
};

/** One key of one `files:` entry, with the shape rules that make a paste visible. */
const applyField = (target, key, rawValue, line, violations) => {
  const value = unquote(rawValue);
  if (key === "size") {
    const parsed = numberOr(rawValue);
    if (parsed === null) {
      violations.push(`第 ${line} 行的 \`size\` 是 ${JSON.stringify(value)}，不是字节数：客户端按这个数字判断下载是否完整`);
      return;
    }
    if (parsed === 0) {
      violations.push(`第 ${line} 行的 \`size\` 是 0：零字节的产物不会是可安装的那一份`);
      return;
    }
    target.size = parsed;
    return;
  }
  if (key === "sha512") {
    if (!/^[A-Za-z0-9+/]{86}==$/.test(value)) {
      violations.push(`第 ${line} 行的 \`sha512\` 是 ${JSON.stringify(value)}，不像 base64 的 64 字节摘要（88 个字符、\`==\` 结尾）：摘要写坏了，客户端下载完一定验不过`);
      return;
    }
    target.sha512 = value;
    return;
  }
  if (value === "") {
    violations.push(`第 ${line} 行的 \`${key}\` 是空的`);
    return;
  }
  target[key] = value;
  if (key === "url" || key === "sha512" || key === "size") target.line = target.line || line;
};

/**
 * The four files, the feed, and the bytes — asked at the same time.
 *
 * `entries` are the *file* names sitting in the output dir (directories excluded:
 * `win-unpacked/` and `linux-unpacked/` are build trees, not release assets).
 * `sizeAndDigest(name)` answers `{ size, sha512 }` from the disk, or `null` when the
 * file is not there — the injected form is what lets a fixture claim a hash the bytes
 * do not have, which is precisely the failure this check exists to catch.
 */
export const distArtifactViolations = ({ version, entries, required, latest, sizeAndDigest }) => {
  const violations = [];
  if (!VERSION_SHAPE.test(String(version || ""))) {
    return [`这一趟要核对的版本号是 ${JSON.stringify(version)}，不是 x.y.z：产物名与 feed 都比不了`];
  }
  const present = new Set(entries || []);

  for (const role of required || []) {
    const name = artifactNameFor(role, version);
    if (name === null) {
      violations.push(`未知的产物角色 ${JSON.stringify(role)}：这份脚本说不出它该叫什么名字`);
      continue;
    }
    if (!present.has(name)) {
      violations.push(`缺 ${name}（${role}）：${ROLE_WHY[role]}——这一套不能上传`);
    }
  }

  // A build of another version sitting in the same directory. Not a leftover to be
  // forgiven: the uploader picks files by name, and two versions in one folder is how
  // the wrong bytes end up beside the right feed.
  const stale = new RegExp(`^${ARTIFACT_BASE}-(\\d+\\.\\d+\\.\\d+)-(setup\\.exe|portable\\.exe|setup\\.exe\\.blockmap)$`);
  for (const name of present) {
    const hit = stale.exec(name);
    if (hit && hit[1] !== version) violations.push(`${name} 是 ${hit[1]} 那一次的产物，和 ${version} 混在同一目录里：按名字挑文件会挑错`);
  }

  if (latest === null || typeof latest !== "object") {
    // Nothing to compare against — and no second sentence about it. The required-role
    // loop above already named the missing file when the file is missing, and a feed
    // that is present but unreadable answers that itself through `parseLatestYml`.
    return violations;
  }
  violations.push(...(latest.violations || []));
  if (latest.version && latest.version !== version) {
    violations.push(`${LATEST_FILE} 写的是 ${latest.version}，这一趟要发的是 ${version}：feed 与产物不同版，已装的客户端会按 feed 去下载`);
  }
  for (const file of latest.files || []) {
    if (!file.url) continue;
    if (!present.has(file.url)) {
      violations.push(`${LATEST_FILE} 指向 ${file.url}，而 ${version} 的产物清单里没有这一份：feed 说有一件事，目录里没有`);
      continue;
    }
    const onDisk = sizeAndDigest ? sizeAndDigest(file.url) : null;
    if (!onDisk) {
      violations.push(`读不到 ${file.url} 的字节与摘要：没有可核对的那一份`);
      continue;
    }
    if (onDisk.size !== file.size) {
      violations.push(`${file.url} 磁盘上是 ${onDisk.size} 字节，${LATEST_FILE} 写的是 ${file.size}：客户端按后者判断下载是否完整`);
    }
    if (onDisk.sha512 !== file.sha512) {
      violations.push(`${file.url} 的实际 sha512 是 ${onDisk.sha512}，${LATEST_FILE} 写的是 ${file.sha512}：这一版一旦发布，已装客户端更新到这一步一定失败`);
    }
  }
  return violations;
};

/**
 * Which `ocr` the tree about to be uploaded carries.
 *
 * `tools/release-pin.mjs` answers this for the *latest tag*, i.e. for the release that
 * already happened — which is how the `v0.1.13` shipping `1.13.0` became a documented
 * fact. The same question asked of the tree in front of us can only be answered
 * before the tag exists, and that is the only moment it is still actionable: reading
 * the packaged wrapper's own `package.json` says what the next download will contain.
 *
 * The win32 binary is asked alongside it because the wrapper's version is a lie if
 * the platform package did not make it in: `ocr-service.js` spawns that executable,
 * and on a Linux box `npm install` never provides it (`fetch:binaries win` does).
 */
export const unpackedCliViolations = ({ pinnedVersion, cliManifestVersion, winBinaryPresent, unpackedDir = UNPACKED_DIR }) => {
  const violations = [];
  if (cliManifestVersion === null || cliManifestVersion === undefined) {
    violations.push(`${unpackedDir}/resources/app/node_modules 里读不到 ${CLI_PACKAGE} 的 package.json：产物里带的是哪一版 CLI 无从回答`);
  } else if (cliManifestVersion !== pinnedVersion) {
    violations.push(
      `打包树里的 ${CLI_PACKAGE} 是 ${cliManifestVersion}，pin 是 ${pinnedVersion}：这一版发出去，下载的人仍带着旧一版 CLI（就是 v0.1.13 那条差距的形状）`
    );
  }
  if (!winBinaryPresent) {
    violations.push(`${unpackedDir}/resources/app 里没有 win32 那份 opencodereview.exe：应用起得来，第一次运行审查就会失败`);
  }
  return violations;
};

/**
 * Whether the sentence "the artefacts are unsigned" still holds, asked of the build
 * config rather than of a document.
 *
 * `build.win.signExecutable: false` is electron-builder's "skip Windows code signing"
 * switch (26.x: *"Set to `false` to skip Windows code signing while still editing
 * executable resources"*). It is why every published release is unsigned, why both
 * READMEs tell the reader to expect SmartScreen, and why `docs/win-install-checklist.md`
 * 第 1 步 exists at all. Those sentences and that flag are one fact in two places, and
 * `verify:dist` is the command that reads the config — so it is the place to notice the
 * drift. Absent is **not** "still false": the default is to sign when a certificate is
 * available, so a missing key says the same thing as `true` to a reader who is about to
 * be told they will see a SmartScreen prompt.
 *
 * This does not verify a signature — it cannot, and says so. What it refuses is a flip
 * that leaves those documents promising the opposite.
 */
export const SIGNING_DOCS = Object.freeze([
  { path: "README.md", claim: /unsigned/i },
  { path: "README.zh-CN.md", claim: /未做代码签名|未签名|不签名/ },
  { path: "使用说明.md", claim: /未签名/ },
  { path: "docs/win-install-checklist.md", claim: /未签名/ },
]);

export const signingViolations = ({ signExecutable, docs = [] }) => {
  const byPath = new Map((docs || []).map((doc) => [doc && doc.path, doc]));
  const claims = SIGNING_DOCS.filter((entry) => {
    const doc = byPath.get(entry.path);
    return doc && typeof doc.text === "string" && entry.claim.test(doc.text);
  }).map((entry) => entry.path);
  if (signExecutable === false) {
    const silent = SIGNING_DOCS.filter((entry) => !claims.includes(entry.path)).map((entry) => entry.path);
    if (silent.length === 0) return [];
    return [
      "构建配置显式跳过签名（`build.win.signExecutable: false`），而这几份文档不再对它承诺的那件事：" +
        `${silent.join(" / ")}——未签名的包会撞 SmartScreen，那是那一句「未签名 / unsigned」唯一的用处`,
    ];
  }
  return [
    `build.win.signExecutable 读到的不是 \`false\`（是 ${JSON.stringify(signExecutable)}，没写也等于「会去签」），而 ${claims.join(" / ") || "文档"} 仍写着未签名 / 未做代码签名：` +
      "先把那几句改掉，再让这一格变绿——签名之后的产物与「更多信息 → 仍要运行」那条路是两件事，而这一条验不了签名本身",
  ];
};

/**
 * The auto-update feed the installed build is going to read.
 *
 * `build.publish[0].url` is not a packaging detail: it is baked into `latest.yml`'s
 * consumers through `electron-updater`, and the README promises "the installed build
 * checks the published release on launch". `releases/latest/download/` is the form that
 * keeps that promise across releases; `releases/download/vX.Y.Z/` freezes the feed at one
 * release, so every client updates to that version forever and never sees the next one.
 * A missing `publish` is a third answer: then nothing was ever emitted for a client to
 * read, and the README's sentence is the one that is wrong.
 */
export const LATEST_FEED_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/releases\/latest\/download\/$/;

export const feedSourceViolations = ({ publish }) => {
  if (!Array.isArray(publish) || publish.length === 0) {
    return [
      "构建配置里没有 `build.publish`：`latest.yml` 不是任何服务器会读到的东西，而已装客户端「启动时检查已发布的 Release」那句话就没有源（README 的 In-app updates 与已知限制都指着它）",
    ];
  }
  const [first] = publish;
  if (!first || typeof first !== "object") {
    return ["`build.publish` 第一项不是一个对象：自动更新源读不出来，这一条不判绿"];
  }
  if (first.provider !== "generic") {
    return [`自动更新源现在的 provider 是 ${JSON.stringify(first.provider)}，不是 \`generic\`：这一套的更新走的是「把 latest.yml 放在 Release 上」那条路，换 provider 要连着改 ` + "`update-service.js`" + " 与两份 README"];
  }
  if (typeof first.url !== "string" || first.url === "") {
    return ["`build.publish[0]` 没有 `url`：没有源，客户端无从判断有没有新版"];
  }
  if (!LATEST_FEED_URL.test(first.url)) {
    return [
      `自动更新源是 ${JSON.stringify(first.url)}，不是 \`https://github.com/<owner>/<repo>/releases/latest/download/\`：` +
        "钉在某个 tag 上（`releases/download/vX.Y.Z/`）等于把 feed 冻在那一版——已装客户端会一直更新到它，永远看不见下一版；少了结尾的 `/` 也接不上 `latest.yml`",
    ];
  }
  return [];
};

/* ---- the run ---- */

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "ok     " : "FAIL   "} ${name}${ok || !detail ? "" : `：${detail}`}`);
};

/** sha512 (base64) and size of one file, streamed — a 97 MB setup.exe is not read whole. */
const sizeAndDigestOf = (file) =>
  new Promise((resolve, reject) => {
    let size = 0;
    const hash = crypto.createHash("sha512");
    const stream = fs.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    stream.on("end", () => resolve({ size, sha512: hash.digest("base64") }));
  });

export const parseArgs = (argv = []) => {
  const args = { dir: RELEASE_DIR, unpacked: UNPACKED_DIR };
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i += 1) {
    const token = String(list[i]);
    if (token === "--dir" || token === "--unpacked") {
      const value = String(list[i + 1] || "");
      if (value === "" || value.startsWith("--")) {
        return { ok: false, error: `${token} 后面要跟一个目录名（${VERIFY_COMMAND} ${token} release-0.1.14）` };
      }
      args[token.slice(2)] = value;
      i += 1;
      continue;
    }
    return { ok: false, error: `不认识的参数 ${JSON.stringify(token)}：这一条只收 --dir 与 --unpacked（${VERIFY_COMMAND}）` };
  }
  return { ok: true, ...args };
};

/** The file names sitting in one directory, directories left out on purpose. */
const filesIn = (dir) => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch (err) {
    return null;
  }
};

export const main = async () => {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(2);
  }
  const dir = path.resolve(ROOT, parsed.dir);
  const unpacked = path.join(dir, parsed.unpacked);

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const version = pkg.version;
  const build = pkg.build || {};
  const win = build.win || {};
  const { roles, violations: roleViolations } = requiredRoles({
    targets: (win.target || []).map((entry) => (typeof entry === "string" ? entry : entry && entry.target)).filter(Boolean),
    differentialPackage: (build.nsis || {}).differentialPackage,
    hasPublish: Array.isArray(build.publish) ? build.publish.length > 0 : Boolean(build.publish),
  });

  console.log(`发布产物自检：${parsed.dir}/，要发的一版是 ${version}（${pkg.name}）`);
  console.log(`该有 ${roles.length} 件：${roles.map((role) => artifactNameFor(role, version)).join("、")}`);

  const entries = filesIn(dir);
  if (entries === null) {
    console.error(`${parsed.dir}/ 读不到（${VERIFY_COMMAND} 之前要先有一条构建）：这一条无话可说，不是通过`);
    process.exit(2);
  }
  if (roleViolations.length) {
    for (const line of roleViolations) console.error(line);
    process.exit(1);
  }

  // Sizes are printed, not judged: a truncated installer from a killed build is a
  // number a reader has to see. The one place a size becomes an assertion is
  // `latest.yml`, which states the byte count it was written with (see below).
  for (const role of roles) {
    const name = artifactNameFor(role, version);
    try {
      console.log(`  ${name}：${fs.statSync(path.join(dir, name)).size} 字节`);
    } catch (_) {
      console.log(`  ${name}：缺`);
    }
  }

  const latestPath = path.join(dir, LATEST_FILE);
  const latest = fs.existsSync(latestPath) ? parseLatestYml(fs.readFileSync(latestPath, "utf8")) : null;

  const digestMap = new Map();
  for (const file of latest ? latest.files : []) {
    if (!file.url || !entries.includes(file.url)) continue;
    try {
      digestMap.set(file.url, await sizeAndDigestOf(path.join(dir, file.url)));
    } catch (err) {
      digestMap.set(file.url, null);
      console.error(`读 ${file.url} 的字节失败：${(err && err.message) || err}`);
    }
  }
  const sizeAndDigest = (name) => (digestMap.has(name) ? digestMap.get(name) : null);

  const artifactViolations = distArtifactViolations({ version, entries, required: roles, latest, sizeAndDigest });
  const setup = artifactNameFor("setup", version);
  console.log(
    latest
      ? `${LATEST_FILE}：version ${latest.version || "（无）"}，清单 ${latest.files.length} 条，首条 ${latest.files[0] ? latest.files[0].url : "（无）"} / ${latest.files[0] ? latest.files[0].size : "?"} 字节` +
          (digestMap.get(setup) ? `；实际算过 sha512 ${digestMap.get(setup).sha512.slice(0, 12)}… / ${digestMap.get(setup).size} 字节` : "")
      : `${LATEST_FILE}：没有这一份文件`
  );
  check(`这套产物可以上传（${roles.length} 件都在，且与 ${LATEST_FILE} 的字节一致）`, artifactViolations.length === 0, artifactViolations.join("；"));

  const cliManifest = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(unpacked, "resources", "app", "node_modules", CLI_PACKAGE, "package.json"), "utf8")).version || null;
    } catch (_) {
      return null;
    }
  })();
  const winBinaryPresent = fs.existsSync(path.join(unpacked, "resources", "app", CLI_WIN_BINARY));
  console.log(`打包树里的 CLI：${cliManifest || "（读不到）"}，win32 二进制${winBinaryPresent ? "在" : "不在"}`);
  const cliViolations = unpackedCliViolations({
    pinnedVersion: pinVersion(PINNED_UPSTREAM),
    cliManifestVersion: cliManifest,
    winBinaryPresent,
    unpackedDir: path.join(parsed.dir, parsed.unpacked),
  });
  check(`产物里带的是 pin 的那一版 CLI（${pinVersion(PINNED_UPSTREAM)}）`, cliViolations.length === 0, cliViolations.join("；"));

  const docs = SIGNING_DOCS.map(({ path: target }) => {
    try {
      return { path: target, text: fs.readFileSync(path.join(ROOT, target), "utf8") };
    } catch (_) {
      return { path: target, text: "" };
    }
  });
  const signing = signingViolations({ signExecutable: win.signExecutable, docs });
  const claiming = SIGNING_DOCS.filter((entry, index) => entry.claim.test(docs[index].text)).map((entry) => entry.path);
  console.log(
    `签名：${win.signExecutable === false ? "这一步被显式跳过（`build.win.signExecutable: false`），" : `配置里读到 ${JSON.stringify(win.signExecutable)}——没有被跳过，`}` +
      `还写着「未签名」的是 ${claiming.join(" / ") || "（没有）"}`
  );
  check("关于「未签名」的那几句与构建配置仍互相成立（这一条不验签名本身）", signing.length === 0, signing.join("；"));

  const feed = feedSourceViolations({ publish: build.publish });
  const firstPublish = Array.isArray(build.publish) ? build.publish[0] : null;
  console.log(`自动更新源：${firstPublish && firstPublish.url ? firstPublish.url : "（没有 build.publish[0].url）"}`);
  check("自动更新源仍是 `releases/latest/download/`（已装的那一台能不能看见下一版）", feed.length === 0, feed.join("；"));

  const failed = results.filter((result) => !result.ok);
  console.log(`\n发布产物：${results.length} 条检查，${failed.length} 条红`);
  if (failed.length) {
    console.error(`重跑：${VERIFY_COMMAND}`);
    process.exit(1);
  }
  console.log("注：这一条说的是「这套字节自相一致、且是同一版」——装得上与否仍归 docs/win-install-checklist.md。");
};

const isEntryPoint = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;

if (isEntryPoint) {
  main().catch((err) => {
    console.error(`发布产物自检没有跑完：${(err && err.stack) || err}`);
    process.exit(1);
  });
}
