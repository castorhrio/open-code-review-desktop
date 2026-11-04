// The rules of `tools/release-pin.mjs`, pinned without git.
//
// `npm run audit:release-pin` reads tags out of this checkout's history, so it
// cannot be part of a static pass that must also work from a shallow clone or a
// tarball — which is how a rule quietly rots. This file drives the same exported
// predicates against fabricated manifests, lockfiles and documents, one wrong
// fact at a time, and requires the matching sentence. It also pins the selector
// trap: this checkout carries the *upstream* project's tags, and a selector that
// picks "the highest vX.Y.Z" answers about the wrong product (the fixture proves
// the naive answer differs from the correct one).
//
// This file is also the half of `audit:release-pin` that works in a `--depth 1`
// clone or a tarball: it imports no git, only the predicates. The run itself reads
// tag history and says so when there is none (see the header of release-pin.mjs,
// and the 未验证清单 row in `docs/measurements.md` that records the cost).
import fs from "node:fs";
import path from "node:path";

import {
  MEASUREMENTS_DOC,
  MEASUREMENT_COMMAND,
  cliLockVersion,
  compareVersions,
  desktopReleaseTags,
  latestRelease,
  measurementAnswerViolations,
  releaseAssetViolations,
  releaseTagOf,
  releaseTagsFrom,
  treePinViolations,
} from "./release-pin.mjs";
import { PINNED_UPSTREAM, auditScriptClosure, pinVersion } from "./upstream-watch.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "ok     " : "FAIL   "} ${name}${ok || !detail ? "" : `：${detail}`}`);
};

const PIN = PINNED_UPSTREAM;
const WANT = pinVersion(PIN);
const PRODUCT = "open-code-review-desktop";
const CLI = "@alibaba-group/open-code-review";

/** The version the reverse controls use as "older than the pin". Written out
 *  rather than computed so it is the actual value the release shipped; the
 *  premise below refuses the day the pin catches up to it. */
const OLD = "1.13.0";
const RELEASE_TAG = "v0.1.13";
/** The version that tag name carries — passed into the predicate instead of being
 *  re-derived there, so this constant is the one place the fixture states it. */
const RELEASE_VERSION = "0.1.13";

const lockWith = (version) => ({
  packages: { [`node_modules/${CLI}`]: { version, resolved: `https://registry.example/${CLI}/-/${version}.tgz` } },
});

const treePkg = (range) => ({ name: PRODUCT, version: "0.1.13", dependencies: { [CLI]: range } });

const goodTree = () => ({ pkg: treePkg(`^${WANT}`), lock: lockWith(WANT), pinned: PIN });

const assetManifest = (range, version = "0.1.13") => ({ name: PRODUCT, version, dependencies: { [CLI]: range } });

const goodAsset = () => ({
  tag: RELEASE_TAG,
  version: RELEASE_VERSION,
  manifest: assetManifest(`^${OLD}`, RELEASE_VERSION),
  lock: lockWith(OLD),
});

/** A row shaped like the one in `docs/measurements.md`: the item is the first
 *  cell, and the three answers a reader needs (tag, version, command) live in the
 *  rest of it. The finder reads the first cell, so the fixture has to be a real
 *  row and not a sentence that mentions the question. */
const goodDoc = () =>
  [
    "## 未验证清单",
    "",
    "| 项 | 归属 | 为什么没验 | 下次要验的触发条件 |",
    "| --- | --- | --- | --- |",
    `| 发布资产里带的是哪一版 \`ocr\` | 真机 | 最新 tag ${RELEASE_TAG} 里带的是 \`ocr\` ${OLD}，源码树 pin 是 ${PIN.tag}，下一次发版对齐 | 在 Windows x64 上装一次发布资产，把结果记回这一行（这一行的读数是 \`${MEASUREMENT_COMMAND}\` 的输出） |`,
    `| 装完之后磁盘上那份 | 真机 | 上面那一行回答的是 tag 里那一份，装完的字节仍未被读过 | 发版后在 Windows 上跑一遍首启 |`,
    "",
  ].join("\n");

// ---- premises ----
check(
  "前提：夹具里那个「旧版本」真的比 pin 旧（pin 前进到它时这一套要换夹具）",
  OLD !== WANT && compareVersions(OLD, WANT) < 0,
  `夹具用 ${OLD}，pin 是 ${WANT}`
);
check(
  "前提：夹具里那个 tag 与版本号是同一件事（谓词不再自己从 tag 名里剥前缀）",
  releaseTagOf(RELEASE_TAG).version === RELEASE_VERSION,
  `${RELEASE_TAG} 与 ${RELEASE_VERSION}`
);
check("前提：一棵自洽的源码树是绿的", treePinViolations(goodTree()).length === 0, treePinViolations(goodTree()).join("；"));
check("前提：一份自洽的发布 tag 是绿的", releaseAssetViolations(goodAsset()).length === 0, releaseAssetViolations(goodAsset()).join("；"));
check(
  "前提：一行写了命令 / tag / 版本的文档是绿的",
  measurementAnswerViolations({ doc: goodDoc(), tag: RELEASE_TAG, version: OLD }).length === 0,
  measurementAnswerViolations({ doc: goodDoc(), tag: RELEASE_TAG, version: OLD }).join("；")
);

// ---- the source tree ----
const reverted = treePinViolations({ ...goodTree(), pkg: treePkg(`^${OLD}`) });
check(
  `反向控制：package.json 的依赖改回 ^${OLD} → 点名两边`,
  reverted.some((line) => line.includes(OLD) && line.includes(PIN.tag)),
  reverted.join("；")
);

const staleLock = treePinViolations({ pkg: treePkg(`^${WANT}`), lock: lockWith(OLD), pinned: PIN });
check(
  "反向控制：区间已升、lockfile 还停在旧版本 → 点名两边（区间对得上 pin，装下来的却是旧的）",
  staleLock.some((line) => line.includes("package-lock.json") && line.includes(OLD) && line.includes(WANT)),
  staleLock.join("；")
);

check(
  "反向控制：lockfile 里没有这个包的解析记录 → 红（不是静默通过）",
  treePinViolations({ pkg: treePkg(`^${WANT}`), lock: { packages: {} }, pinned: PIN }).some((line) => line.includes("解析记录")),
  treePinViolations({ pkg: treePkg(`^${WANT}`), lock: { packages: {} }, pinned: PIN }).join("；")
);

// ---- one release tag ----
const drift = releaseAssetViolations({
  tag: RELEASE_TAG,
  version: RELEASE_VERSION,
  manifest: assetManifest(`^${OLD}`, RELEASE_VERSION),
  lock: lockWith(WANT),
});
check(
  "反向控制：发布 tag 的声明与它自己的 lockfile 不一致 → 点名两边",
  drift.some((line) => line.includes(OLD) && line.includes(WANT)),
  drift.join("；")
);

check(
  "反向控制：tag 与包里的版本不是同一件事 → 点名两边",
  releaseAssetViolations({
    tag: RELEASE_TAG,
    version: RELEASE_VERSION,
    manifest: assetManifest(`^${OLD}`, "0.1.12"),
    lock: lockWith(OLD),
  }).some((line) => line.includes("0.1.12") && line.includes(RELEASE_TAG) && line.includes(RELEASE_VERSION))
);

check(
  "反向控制：那份发布没有封装这个 CLI → 红",
  releaseAssetViolations({
    tag: RELEASE_TAG,
    version: RELEASE_VERSION,
    manifest: { name: PRODUCT, version: RELEASE_VERSION, dependencies: {} },
    lock: lockWith(OLD),
  }).some((line) => line.includes(CLI))
);

check(
  "反向控制：发布 tag 里读不到 package.json → 红（不是跳过）",
  releaseAssetViolations({ tag: RELEASE_TAG, version: RELEASE_VERSION, manifest: null, lock: lockWith(OLD) }).length === 1
);

check(
  "反向控制：发布 tag 的 lockfile 里没有解析记录 → 红",
  releaseAssetViolations({
    tag: RELEASE_TAG,
    version: RELEASE_VERSION,
    manifest: assetManifest(`^${OLD}`, RELEASE_VERSION),
    lock: { packages: {} },
  }).some((line) => line.includes("解析记录"))
);

check(
  "反向控制：调用方没给 tag 解析出的版本号 → 红（不是跳过这一条比对）",
  releaseAssetViolations({
    tag: RELEASE_TAG,
    version: "",
    manifest: assetManifest(`^${OLD}`, "0.1.12"),
    lock: lockWith(OLD),
  }).some((line) => line.includes("版本号")),
  releaseAssetViolations({ tag: RELEASE_TAG, version: "", manifest: assetManifest(`^${OLD}`, "0.1.12"), lock: lockWith(OLD) }).join("；")
);

// ---- the row in docs/measurements.md ----
const wrongVersion = goodDoc().replace(`\`ocr\` ${OLD}`, "`ocr` 1.12.13");
check(
  "反向控制：文档里那一行写的是另一个版本 → 点名两边",
  measurementAnswerViolations({ doc: wrongVersion, tag: RELEASE_TAG, version: OLD }).some(
    (line) => line.includes("1.12.13") || line.includes(OLD)
  ),
  measurementAnswerViolations({ doc: wrongVersion, tag: RELEASE_TAG, version: OLD }).join("；")
);

const wrongTag = goodDoc().replace(RELEASE_TAG, "v0.1.12");
check(
  "反向控制：文档里那一行写的是另一个 tag → 点名最新 tag",
  measurementAnswerViolations({ doc: wrongTag, tag: RELEASE_TAG, version: OLD }).some((line) => line.includes(RELEASE_TAG)),
  measurementAnswerViolations({ doc: wrongTag, tag: RELEASE_TAG, version: OLD }).join("；")
);

const noCommand = goodDoc().replace(MEASUREMENT_COMMAND, "人工读一遍");
check(
  "反向控制：那一行没写是哪条命令跑出来的 → 红",
  measurementAnswerViolations({ doc: noCommand, tag: RELEASE_TAG, version: OLD }).some((line) => line.includes("重跑")),
  measurementAnswerViolations({ doc: noCommand, tag: RELEASE_TAG, version: OLD }).join("；")
);

check(
  "反向控制：整行被删掉 → 红（不是「无话可说」）",
  measurementAnswerViolations({ doc: "# 实测值\n\n没有表格。\n", tag: RELEASE_TAG, version: OLD }).length === 1
);

check(
  "反向控制：读不到发布版本的时把空串当答案 → 红（includes('') 恒真的那一格）",
  measurementAnswerViolations({ doc: goodDoc(), tag: RELEASE_TAG, version: "" }).length === 1
);

// ---- picking the right tags ----
const TAG_LIST = [
  "v0.0.1",
  "v0.1.0",
  "v0.1.9",
  "v0.1.13",
  "v0.2.0",
  "v0.2.2",
  "v1.13.5",
  "v0.1.13-rc1",
  "not-a-tag",
].join("\n");
const MANIFESTS = {
  "v0.1.0": { name: "ocr-desktop", version: "0.1.0", dependencies: { [CLI]: "^1.10.0" } },
  "v0.1.9": { name: PRODUCT, version: "0.1.9", dependencies: { [CLI]: "^1.12.13" } },
  "v0.1.13": { name: PRODUCT, version: "0.1.13", dependencies: { [CLI]: `^${OLD}` } },
  "v0.2.0": { name: "@ali/open-code-review", version: "0.1.8" },
  "v0.2.2": { name: "@ali/open-code-review", version: "0.2.1" },
  "v1.13.5": { name: "@ali/open-code-review", version: "1.13.5" },
};
const picked = desktopReleaseTags({
  tagList: TAG_LIST,
  productName: PRODUCT,
  readManifest: (tag) => MANIFESTS[tag] || null,
});
check(
  "选 tag：只留本产品的发布，最新的是 v0.1.13",
  latestRelease(picked.releases).tag === "v0.1.13" && picked.releases.length === 2,
  JSON.stringify(picked.releases.map((entry) => entry.tag))
);
check(
  "反向控制：只按版本号选会选中上游的 v1.13.5——夹具必须证明这条分叉是真的",
  latestRelease(releaseTagsFrom(TAG_LIST)).tag === "v1.13.5",
  `按版本号选到的是 ${latestRelease(releaseTagsFrom(TAG_LIST)).tag}`
);
check(
  "选 tag：被跳过的那些各有理由（不是无声丢弃）",
  picked.skipped.some((entry) => entry.tag === "v0.0.1" && entry.kind === "no-manifest") &&
    picked.skipped.some((entry) => entry.tag === "v1.13.5" && entry.kind === "foreign" && entry.name === "@ali/open-code-review"),
  JSON.stringify(picked.skipped.map((entry) => [entry.tag, entry.kind]))
);
check(
  "选 tag：预发布与不成形的 tag 不是候选（v0.1.13-rc1 不进清单）",
  !releaseTagsFrom(TAG_LIST).some((entry) => entry.tag.includes("rc")),
  JSON.stringify(releaseTagsFrom(TAG_LIST).map((entry) => entry.tag))
);
check(
  "选 tag：v0.1.9 排在 v0.1.13 之后是字符串排序的错，数值排序里它在前面",
  compareVersions("0.1.9", "0.1.13") < 0 && latestRelease(releaseTagsFrom("v0.1.9\nv0.1.13")).tag === "v0.1.13",
  JSON.stringify(releaseTagsFrom("v0.1.9\nv0.1.13").map((entry) => entry.tag))
);
check(
  "选 tag：一个本产品的 tag 都没有时 answer 是 null，而不是随便挑一个",
  latestRelease(desktopReleaseTags({ tagList: "v1.13.5", productName: PRODUCT, readManifest: (tag) => MANIFESTS[tag] }).releases) ===
    null
);
check("lockfile 解析：读不出版本时是 null，而不是空串", cliLockVersion({ packages: {} }) === null && cliLockVersion(lockWith(OLD)) === OLD);

// ---- the wiring ----
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const read = (file) => {
  try {
    return fs.readFileSync(path.join(ROOT, file), "utf8");
  } catch (_) {
    return null;
  }
};
const closure = auditScriptClosure(pkg, read);
check(
  `接线：\`audit:release-pin\` 存在，且脚本在 audit 闭包里（每一趟静态审计都真的跑它）`,
  typeof pkg.scripts["audit:release-pin"] === "string" && closure.files.has("tools/release-pin.mjs"),
  `audit:release-pin=${JSON.stringify(pkg.scripts["audit:release-pin"])}，闭包里有=${closure.files.has("tools/release-pin.mjs")}`
);
check(
  "接线：本文件也在 audit 闭包里（规则本身每轮都跑）",
  closure.files.has("tools/release-pin-smoke.mjs"),
  "audit:release-pin 没有把 smoke 一起跑"
);
check(
  "接线：它不在 `audit:app` 里（读 git 历史的事不该拖进真 Electron 那一趟）",
  !String(pkg.scripts["audit:app"] || "").includes("audit:release-pin"),
  `audit:app=${pkg.scripts["audit:app"]}`
);
check(
  `接线：${MEASUREMENTS_DOC} 那一行指的正是这条命令`,
  String(read(MEASUREMENTS_DOC) || "").includes(MEASUREMENT_COMMAND),
  `文档里找不到 ${MEASUREMENT_COMMAND}`
);

const failed = results.filter((result) => !result.ok);
console.log(`\n发布 pin 的规则：${results.length} 条检查，${failed.length} 条红`);
if (failed.length) {
  console.error(failed.map((result) => `  - ${result.name}：${result.detail}`).join("\n"));
  process.exit(1);
}
