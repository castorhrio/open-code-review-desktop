// The `ocr` version that shipped, answered by a run instead of by a reader.
//
// `docs/measurements.md` carried this question as an unverified row for six
// rounds: 「发布资产里带的是哪一版 `ocr`」. The answer was known to be *old*
// (that row quoted the last release commit's `^1.13.0` by hand), but a hand-quoted
// answer rots the moment the next release is cut — nothing in this repository
// would notice, and README's version line is about the *source tree's* pin, not
// about the bytes a stranger downloads.
//
// This script answers it from git, because git is where the answer lives: a
// release tag's `package.json` says what the dependency range was, and that same
// tag's `package-lock.json` says which version the range resolved to — with
// `npmRebuild: false` and electron-builder copying `node_modules` into
// `resources/app`, the resolved version *is* the version inside the artefact.
// Two questions come out of one read:
//
//   - what does the source tree ship next? — `package.json` range vs the pin,
//     which `audit:upstream` already asks, plus the half it cannot see: the
//     *lockfile* version. A range of `^1.13.5` next to a lockfile still holding
//     1.13.4 passes the range check and ships 1.13.4. That is the new assertion.
//   - what did the last release ship? — the latest desktop release tag's lockfile
//     answer, compared to the pin so the gap is a sentence rather than a guess.
//
// The gap is *reported*, not gated: cutting a release needs a Windows machine
// (`tools/release.mjs` refuses anything else), so a red gate here would be
// permanently red on this box and would teach everyone to ignore it. What is
// gated is that the answer stays true — the row in `docs/measurements.md` must
// quote the tag and the version this script reads, so a new release tag turns the
// doc red until someone writes the new answer down.
//
// One trap is worth naming because it is this repository's own history: the
// checkout carries the *upstream* project's tags as well (`v0.2.0`–`v0.2.2` are
// upstream releases, and they sort **higher** than our `v0.1.13`). Selecting
// release tags by version alone therefore answers about the wrong project — the
// selector below reads each candidate tag's `package.json` name and keeps only
// this product's own tags, and `tools/release-pin-smoke.mjs` requires the naive
// selector to go red on exactly that fixture.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { PINNED_UPSTREAM, UPSTREAM_PACKAGE, dependencyPinViolations, pinVersion, versionInRange } from "./upstream-watch.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

export const MANIFEST = "package.json";
export const LOCKFILE = "package-lock.json";
export const MEASUREMENTS_DOC = "docs/measurements.md";

/** The command a reader can re-run, and the mark the doc row must carry. */
export const MEASUREMENT_COMMAND = "npm run audit:release-pin";

/** `v0.1.13` and nothing else: upstream tags and prereleases are not releases of
 *  this product, and the product-name check below is what separates them. */
export const releaseTagOf = (line) => {
  const hit = /^v(\d+)\.(\d+)\.(\d+)$/.exec(String(line == null ? "" : line).trim());
  if (hit === null) return null;
  return {
    tag: `v${hit[1]}.${hit[2]}.${hit[3]}`,
    version: `${hit[1]}.${hit[2]}.${hit[3]}`,
    parts: [Number(hit[1]), Number(hit[2]), Number(hit[3])],
  };
};

/** Semver order on the numeric triple, because `v0.1.9` sorts after `v0.1.13` as
 *  a string and that is the whole content of "latest release". */
export const compareVersions = (a, b) => {
  const left = String(a).split(".").map(Number);
  const right = String(b).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const one = left[index] || 0;
    const other = right[index] || 0;
    if (one !== other) return one < other ? -1 : 1;
  }
  return 0;
};

/** Every `vX.Y.Z` line out of `git tag -l`, ascending. */
export const releaseTagsFrom = (tagList) =>
  String(tagList == null ? "" : tagList)
    .split(/\r?\n/)
    .map(releaseTagOf)
    .filter((entry) => entry !== null)
    .sort((a, b) => compareVersions(a.version, b.version));

/**
 * The tags that are releases of *this* product.
 *
 * `readManifest(tag)` answers the tag's `package.json` as an object, or `null`
 * when the tag has no manifest. A candidate the reader cannot answer is skipped
 * with a reason rather than dropped silently: "we could not read it" and "it is
 * not ours" are different facts, and the printout says which.
 */
export const desktopReleaseTags = ({ tagList, readManifest = () => null, productName = "" }) => {
  const releases = [];
  const skipped = [];
  for (const candidate of releaseTagsFrom(tagList)) {
    const manifest = readManifest(candidate.tag);
    if (manifest === null || typeof manifest !== "object") {
      skipped.push({ ...candidate, kind: "no-manifest", name: null });
      continue;
    }
    if (productName && manifest.name !== productName) {
      skipped.push({ ...candidate, kind: "foreign", name: manifest.name || "" });
      continue;
    }
    releases.push({ ...candidate, appVersion: manifest.version || "" });
  }
  return { releases, skipped };
};

/** The newest release, or `null` when no tag qualifies. */
export const latestRelease = (releases) =>
  releases.length === 0 ? null : releases.reduce((newest, entry) => (compareVersions(entry.version, newest.version) > 0 ? entry : newest));

/** The lockfile record for the wrapped CLI — the version that gets packaged. */
export const cliLockRecord = (lock) => {
  const packages = (lock && lock.packages) || {};
  const record = packages[`node_modules/${UPSTREAM_PACKAGE}`];
  return record && typeof record === "object" ? record : null;
};

export const cliLockVersion = (lock) => {
  const record = cliLockRecord(lock);
  return record && typeof record.version === "string" ? record.version : null;
};

/**
 * The source tree: the version that the *next* release will ship.
 *
 * Half of this is `dependencyPinViolations`, reused rather than copied — one
 * predicate for "the declared range names the pinned version". The other half is
 * the question that check cannot ask: the lockfile's resolved version. Two files
 * disagreeing is not a corner case; it is what `npm install` produces after a
 * dependency bump that was not followed by one, and the packaged app carries the
 * lockfile's answer.
 */
export const treePinViolations = ({ pkg, lock, pinned = PINNED_UPSTREAM }) => {
  const violations = [...dependencyPinViolations(pkg, pinned)];
  const want = pinVersion(pinned);
  const locked = cliLockVersion(lock);
  if (locked === null) {
    violations.push(
      `package-lock.json 里没有 ${UPSTREAM_PACKAGE} 的解析记录（缺少版本号）：` +
        `pin 是 ${pinned.tag}，而产物里真正装的是哪一版无从回答——换一台机器 \`npm install\` 会得到另一份`
    );
    return violations;
  }
  if (locked !== want) {
    violations.push(
      `package-lock.json 把 ${UPSTREAM_PACKAGE} 解析在 ${locked}，而 pin 是 ${pinned.tag}（${want}）：` +
        "打包带走的是 lockfile 解析出来的那一版——区间写得再新，装下来的仍是旧的那一份"
    );
  }
  return violations;
};

/**
 * One release tag, answered from its own two files.
 *
 * Both halves have to be there and to agree, because the answer is only as good
 * as the pair: a manifest without a lockfile record says what was *asked for*,
 * a lockfile alone does not say which product that dependency belongs to. The
 * check is deliberately silent about the pin — that comparison is reported, not
 * gated (see the header).
 */
export const releaseAssetViolations = ({ tag, manifest, lock }) => {
  const violations = [];
  if (manifest === null || typeof manifest !== "object") {
    return [`发布 tag ${tag} 里读不到 package.json——那一份发布声明的依赖区间无从回答`];
  }
  if (manifest.version && manifest.version !== String(tag).replace(/^v/, "")) {
    violations.push(`${tag} 封的那份 package.json 写着版本 ${manifest.version}：tag 与包里的版本不是同一件事，先弄清发的是哪一份`);
  }
  const dependency = ((manifest && manifest.dependencies) || {})[UPSTREAM_PACKAGE];
  if (dependency === undefined) {
    violations.push(`${tag} 的 package.json 里没有 ${UPSTREAM_PACKAGE}：那一份发布不是封装这个 CLI 的`);
  }
  const declared = dependency === undefined ? null : versionInRange(dependency);
  if (dependency !== undefined && declared === null) {
    violations.push(`${tag} 把 ${UPSTREAM_PACKAGE} 写成 ${JSON.stringify(dependency)}，读不出版本号——无从回答产物里是哪一版`);
  }
  const locked = cliLockVersion(lock);
  if (locked === null) {
    violations.push(
      `${tag} 的 package-lock.json 里没有 ${UPSTREAM_PACKAGE} 的解析记录：` +
        `声明写的是 ${JSON.stringify(dependency)}，而装下来的那一版没有记录`
    );
  }
  if (declared !== null && locked !== null && declared !== locked) {
    violations.push(
      `${tag} 声明 ${JSON.stringify(dependency)}（解析出 ${declared}），它自己的 lockfile 解析在 ${locked}：` +
        "这两份文件在同一份发布里，对不上就说明产物不是照它打的"
    );
  }
  return violations;
};

/**
 * The row in `docs/measurements.md` has to quote what this script reads.
 *
 * "Scriptable" means a stranger can re-run the command and get the same sentence,
 * so three things are required together: the command, the tag, and the version.
 * Any one of them missing and the row goes back to being a hand-written claim.
 */
export const measurementAnswerViolations = ({ doc, tag, version }) => {
  // An empty version would make the `includes` check below true for every row,
  // which is the one shape this rule must never accept: it exists because a row
  // with the wrong version is indistinguishable from a correct one to a reader.
  if (!version) {
    return [`${tag} 里读不到 lockfile 的解析版本——没有答案就没有可核对的那一行`];
  }
  const lines = String(doc == null ? "" : doc).split(/\r?\n/);
  const at = lines.findIndex((line) => /^\|\s*发布资产里带的是哪一版/.test(line.trim()));
  if (at === -1) {
    return [
      `\`${MEASUREMENTS_DOC}\` 里没有「发布资产里带的是哪一版 \`ocr\`」这一行：` +
        `这条答案改由 \`${MEASUREMENT_COMMAND}\` 回答，文档里那一行是它的读数`
    ];
  }
  const row = lines[at];
  const violations = [];
  if (!row.includes(MEASUREMENT_COMMAND)) {
    violations.push(
      `\`${MEASUREMENTS_DOC}\` 第 ${at + 1} 行没有写这份答案是 \`${MEASUREMENT_COMMAND}\` 跑出来的：` +
        "「脚本能答」的意思是有人能重跑它，而不是有人读得更仔细"
    );
  }
  if (!row.includes(tag)) {
    violations.push(
      `\`${MEASUREMENTS_DOC}\` 第 ${at + 1} 行没有写最新发布 tag ${tag}：` +
        "发的不是最新那个 tag 时，这一行答的就不是读者下载得到的那份"
    );
  }
  if (!row.includes(version)) {
    violations.push(
      `\`${MEASUREMENTS_DOC}\` 第 ${at + 1} 行没有写 ${tag} 里带的是 \`ocr\` ${version}：` +
        "这一行的用途就是替读者记住这个版本号"
    );
  }
  return violations;
};

/* ---- the run ---- */

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });

const readJson = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));

/** `null` for "this tag does not carry that file" — a missing `package.json` on a
 *  very old tag is a fact about the tag, not a failure of the run. stderr is
 *  dropped because git's own complaint (`path 'package.json' … not in 'v0.0.1'`)
 *  is the same fact printed a second time, and the printout already says which
 *  tags were skipped and why. */
const readAtTag = (tag, file) => {
  try {
    const stdout = execFileSync("git", ["show", `${tag}:${file}`], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(stdout);
  } catch (_) {
    return null;
  }
};

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "ok     " : "FAIL   "} ${name}${ok || !detail ? "" : `：${detail}`}`);
};

export const main = () => {
  const pkg = readJson(MANIFEST);
  const lock = readJson(LOCKFILE);
  const pinned = PINNED_UPSTREAM;

  const { releases, skipped } = desktopReleaseTags({
    tagList: git("tag", "-l", "v*"),
    productName: pkg.name,
    readManifest: (tag) => readAtTag(tag, MANIFEST),
  });
  const latest = latestRelease(releases);
  if (latest === null) {
    console.error(`没有任何 tag 是 ${pkg.name} 的发布——这一条无话可说，不是通过`);
    process.exit(2);
  }
  const assetLock = readAtTag(latest.tag, LOCKFILE);
  const assetManifest = readAtTag(latest.tag, MANIFEST);
  const shipped = cliLockVersion(assetLock);

  // The answer to the row this script exists for. Printed before the checks so a
  // red run still tells the reader what the tags say.
  console.log(`最新发布 tag：${latest.tag}（${git("log", "-1", "--format=%cs", latest.tag).trim()} 的提交）`);
  console.log(
    `发布资产里带的是 \`ocr\` ${shipped || "（读不到）"}` +
      `（那份 package.json 声明 ${JSON.stringify(((assetManifest || {}).dependencies || {})[UPSTREAM_PACKAGE])}）`
  );
  console.log(
    `源码树下一次会带 \`ocr\` ${cliLockVersion(lock) || "（读不到）"}` +
      `（声明 ${JSON.stringify((pkg.dependencies || {})[UPSTREAM_PACKAGE])}，pin ${pinned.tag}）`
  );
  if (shipped && shipped !== pinVersion(pinned)) {
    console.log(
      `口径差：发布资产是 ${shipped}，源码树 pin 是 ${pinVersion(pinned)}——` +
        "下载得到的那份自带旧一版 CLI；下一次在 Windows 上发版时对齐，README 的版本行说的是源码树这一侧"
    );
  }
  // One line per skipped tag would be ~150 lines of upstream tags on this
  // checkout (the upstream project's own tags live here too), so the printout
  // groups them and names the two reasons a candidate can be skipped.
  const foreign = skipped.filter((entry) => entry.kind === "foreign");
  const unreadable = skipped.filter((entry) => entry.kind === "no-manifest");
  if (foreign.length) {
    const names = [...new Set(foreign.map((entry) => entry.name))].join("、");
    const examples = foreign
      .slice(-3)
      .reverse()
      .map((entry) => entry.tag)
      .join("、");
    console.log(`跳过 ${foreign.length} 个 tag：它们的 package.json 不是本产品（${names}；如 ${examples}）——按版本号一律会选中它们`);
  }
  if (unreadable.length) {
    console.log(`跳过 ${unreadable.length} 个 tag：读不到 package.json（${unreadable.map((entry) => entry.tag).join("、")}）`);
  }

  const tree = treePinViolations({ pkg, lock, pinned });
  check(
    `源码树：依赖区间与 lockfile 解析都是 pin 的那一版（${pinned.tag}）`,
    tree.length === 0,
    tree.join("；")
  );

  const asset = releaseAssetViolations({ tag: latest.tag, manifest: assetManifest, lock: assetLock });
  check(`发布 tag ${latest.tag} 里的声明与它自己的 lockfile 一致（这一份回答是自洽的）`, asset.length === 0, asset.join("；"));

  let ancestor = true;
  try {
    git("merge-base", "--is-ancestor", latest.tag, "HEAD");
  } catch (_) {
    ancestor = false;
  }
  check(`${latest.tag} 是当前 HEAD 的祖先（这一份发布出自这条线）`, ancestor, `${latest.tag} 不在 HEAD 的历史里`);

  const doc = fs.readFileSync(path.join(ROOT, MEASUREMENTS_DOC), "utf8");
  const measured = measurementAnswerViolations({ doc, tag: latest.tag, version: shipped || "" });
  check(`${MEASUREMENTS_DOC} 记的答案是这一趟跑出来的那一份（${latest.tag} / ${shipped || "?"}）`, measured.length === 0, measured.join("；"));

  const failed = results.filter((result) => !result.ok);
  console.log(`\n发布 pin：${results.length} 条检查，${failed.length} 条红`);
  if (failed.length) {
    console.error(failed.map((result) => `  - ${result.name}：${result.detail}`).join("\n"));
    process.exit(1);
  }
};

const isEntryPoint = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;

if (isEntryPoint) main();
