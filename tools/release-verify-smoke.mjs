// The rules of `tools/release-verify.mjs`, pinned without a build.
//
// `npm run verify:dist` hashes whatever sits in `release/`, so on a machine that has
// not packaged anything this minute the gate has nothing to say — and a rule nobody
// can run is a rule nobody can see go red. This file drives the same exported
// predicates against fabricated trees, one wrong fact per fixture, and requires the
// matching sentence, then walks the digest comparison against a *real* temp directory
// with *real* bytes: a fake disk proves what the code decides, a real one proves the
// hash it computes is the hash `latest.yml` carries.
//
// The format fixture is not invented. `LATEST_PUBLISHED` below is
// `https://github.com/castorhrio/open-code-review-desktop/releases/download/v0.1.13/latest.yml`
// copied verbatim, because the parser's job is to read electron-builder's output and
// nothing else — a fixture written from how the author imagined that file looks would
// let the parser pass on shapes no builder ever emits, while the real feed trips it.
//
// Run with `npm run audit:release-verify-rules`.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  LATEST_FILE,
  LATEST_FEED_URL,
  ROLE_WHY,
  SIGNING_DOCS,
  VERIFY_COMMAND,
  artifactNameFor,
  distArtifactViolations,
  feedSourceViolations,
  parseArgs,
  parseLatestYml,
  requiredRoles,
  signingViolations,
  unpackedCliViolations,
} from "./release-verify.mjs";
import { RELEASE_STEPS, planRelease } from "./release-guard.mjs";
import { PINNED_UPSTREAM, auditScriptClosure, pinVersion } from "./upstream-watch.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
/** The run's own source: two of the checks below ask whether `main()` really calls a
 *  predicate rather than leaving it exported and unread. */
const sourceOfVerify = fs.readFileSync(path.join(ROOT, "tools", "release-verify.mjs"), "utf8");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "ok     " : "FAIL   "} ${name}${ok || !detail ? "" : `：${detail}`}`);
};

const VERSION = "0.1.14";
const SETUP = artifactNameFor("setup", VERSION);
const PORTABLE = artifactNameFor("portable", VERSION);
const BLOCKMAP = artifactNameFor("blockmap", VERSION);
const ROLES = ["setup", "blockmap", "portable", "latest"];
const NAMES = [SETUP, PORTABLE, BLOCKMAP, LATEST_FILE];

/** A digest that is 88 base64 characters, for fixtures that only need the shape. */
const SHA = "Kthm+9/jYMRwJb9MJYR44M9knE9zFslX3lPH6Fnhuc3fyQtgSQuAeTL0Uf6cW/S+hLsbFRDeeWUTiGjUBBtVmA==";

/** Another digest of the same valid shape: a fixture that changes only the *value*
 *  needs this, because a shortened one is refused by the shape rule instead. */
const OTHER_SHA = `z${SHA.slice(1)}`;

/** electron-builder's own feed for v0.1.13, byte-for-byte as published. */
const LATEST_PUBLISHED = `version: 0.1.13
files:
  - url: open-code-review-desktop-0.1.13-setup.exe
    sha512: ${SHA}
    size: 97388854
path: open-code-review-desktop-0.1.13-setup.exe
sha512: ${SHA}
releaseDate: '2026-10-14T14:24:04.092Z'
`;

/** A feed for the fixture version, with the pair this script compares. */
const feedFor = ({ version = VERSION, url = SETUP, sha512 = SHA, size = 97388854, topPath = url, topSha = sha512, topSize = size } = {}) =>
  `version: ${version}
files:
  - url: ${url}
    sha512: ${sha512}
    size: ${size}
path: ${topPath}
sha512: ${topSha}
size: ${topSize}
releaseDate: '2026-11-05T00:00:00.000Z'
`;

const parse = (text) => parseLatestYml(text);
const feedViolations = (text) => parse(text).violations;

const okFeed = (overrides = {}) => feedFor(overrides);

/** A tree that passes, so every reversal below changes exactly one fact. */
const goodTree = (overrides = {}) => {
  const feed = parse(okFeed(overrides.feed || {}));
  return {
    version: overrides.version ?? VERSION,
    entries: overrides.entries ?? NAMES,
    required: overrides.required ?? ROLES,
    latest: overrides.latest === undefined ? feed : overrides.latest,
    sizeAndDigest:
      overrides.sizeAndDigest ??
      ((name) => (NAMES.includes(name) ? { size: 97388854, sha512: SHA } : null)),
  };
};

const violationsOf = (args) => distArtifactViolations(goodTree(args)).length;
const firstViolationOf = (args) => distArtifactViolations(goodTree(args))[0] || "";

/* ---- 1. the parser reads what electron-builder actually wrote ---- */

{
  const parsed = parse(LATEST_PUBLISHED);
  check("the published v0.1.13 feed parses with nothing to complain about", parsed.violations.length === 0, parsed.violations.join("；"));
  check(
    "...and answers what a client verifies: version, path, sha512, and the list's size",
    parsed.version === "0.1.13" && parsed.path === "open-code-review-desktop-0.1.13-setup.exe" && parsed.sha512 === SHA,
    JSON.stringify({ version: parsed.version, path: parsed.path, size: parsed.size })
  );
  check("...the list has that one file with url / sha512 / size", parsed.files.length === 1 && parsed.files[0].url === parsed.path && parsed.files[0].size === 97388854 && parsed.files[0].sha512 === SHA, JSON.stringify(parsed.files));
  check("...and the releaseDate is kept as read", parsed.releaseDate === "2026-10-14T14:24:04.092Z", parsed.releaseDate);
  check(
    "...a header `size` the published feed omits reads as absent, and is not a complaint",
    parsed.size === null && parsed.violations.length === 0,
    JSON.stringify({ size: parsed.size, violations: parsed.violations })
  );

  // A feed that carries one more number is still a valid feed. This is the fixture
  // that keeps the parser from becoming a whitelist of keys it has seen.
  const withExtra = parse(LATEST_PUBLISHED.replace("    size: 97388854", "    size: 97388854\n    blockMapSize: 102735"));
  check("an unknown key inside a files entry is ignored, not refused", withExtra.violations.length === 0, withExtra.violations.join("；"));
}

/* ---- 2. what the parser refuses, one fact at a time ---- */

{
  const cases = [
    ["no version", LATEST_PUBLISHED.replace(/^version: .*\n/m, ""), /version/],
    ["a version that is not x.y.z", LATEST_PUBLISHED.replace("version: 0.1.13", "version: 0.1"), /x\.y\.z/],
    ["no files list", LATEST_PUBLISHED.replace(/^files:\n(?:\s+.*\n)+/m, ""), /files/],
    ["an entry without a size", LATEST_PUBLISHED.replace(/^ {4}size: .*\n/m, ""), /size/],
    ["a truncated sha512", LATEST_PUBLISHED.replaceAll(SHA, SHA.slice(0, 60)), /base64/],
    ["a size of zero", LATEST_PUBLISHED.replace("    size: 97388854", "    size: 0"), /`size` 是 0/],
    ["a header path that names another file", LATEST_PUBLISHED.replace(/^path: .*$/m, "path: other.exe"), /两个下载地址/],
    ["a header sha512 that disagrees with the list", LATEST_PUBLISHED.replace(/^sha512: .*$/m, `sha512: ${OTHER_SHA}`), /顶层 `sha512` 与清单第一条不相等/],
    ["a header size that disagrees with the list", okFeed({ topSize: 504146 }), /顶层 `size`（504146）/],
    ["an empty file", "", /读不到或是空/],
    ["a line that is no field", `${LATEST_PUBLISHED}nonsense\n`, /读不出字段/],
  ];
  for (const [label, text, pattern] of cases) {
    const violations = feedViolations(text);
    check(`the parser refuses a feed with ${label}`, violations.length > 0 && violations.some((line) => pattern.test(line)), violations.join("；"));
  }
  check(
    "...and a feed with nothing wrong is the only shape that stays silent",
    feedViolations(LATEST_PUBLISHED).length === 0,
    `${feedViolations(LATEST_PUBLISHED).length} 条`
  );
}

/* ---- 3. which files this build owes ---- */

{
  const both = requiredRoles({ targets: ["nsis", "portable"], differentialPackage: true, hasPublish: true });
  check("nsis + portable with a differential package owes four files", both.roles.join(",") === ROLES.join(","), both.roles.join(","));
  check("...and says nothing about the config", both.violations.length === 0, both.violations.join("；"));

  const targetObjects = requiredRoles({ targets: [{ target: "nsis", arch: ["x64"] }, { target: "portable", arch: ["x64"] }], hasPublish: true });
  check("...the same answer when targets come as objects, as package.json writes them", targetObjects.roles.join(",") === ROLES.join(","), targetObjects.roles.join(","));

  const noDiff = requiredRoles({ targets: ["nsis", "portable"], differentialPackage: false, hasPublish: true });
  check("differentialPackage false really does drop the blockmap", !noDiff.roles.includes("blockmap") && noDiff.roles.includes("portable"), noDiff.roles.join(","));

  const noPublish = requiredRoles({ targets: ["nsis", "portable"], hasPublish: false });
  check("...and no publish config drops the feed file instead of demanding one", !noPublish.roles.includes("latest") && noPublish.roles.includes("setup"), noPublish.roles.join(","));

  const nsisOnly = requiredRoles({ targets: ["nsis"], hasPublish: true });
  check("a build with one target owes one installer, not a portable nobody built", nsisOnly.roles.join(",") === "setup,blockmap,latest", nsisOnly.roles.join(","));

  const unknown = requiredRoles({ targets: ["nsisWeb"], hasPublish: true });
  check(
    "a target this script does not know is named, not skipped",
    unknown.violations.length === 1 && /nsisWeb/.test(unknown.violations[0]),
    unknown.violations.join("；")
  );
  const none = requiredRoles({ targets: [], hasPublish: true });
  check("...and an empty target list is refused rather than answered as nothing-to-check", none.violations.length === 1, none.violations.join("；"));

  check(
    "every role has a sentence about why the Release needs it",
    ROLES.every((role) => typeof ROLE_WHY[role] === "string" && ROLE_WHY[role].length > 8),
    ROLES.map((role) => `${role}=${JSON.stringify(ROLE_WHY[role] || "")}`).join(" ")
  );
}

/* ---- 4. completeness: the four files, and no others ---- */

{
  check("a complete set for the version passes", violationsOf({}) === 0, firstViolationOf({}));

  for (const role of ROLES) {
    const name = artifactNameFor(role, VERSION);
    const missing = NAMES.filter((entry) => entry !== name);
    const violation = firstViolationOf({ entries: missing });
    check(
      `removing ${name} goes red and names it`,
      violation.includes(name) && violation.includes(role) && violation.includes(ROLE_WHY[role].slice(0, 6)),
      violation
    );
  }

  const stale = firstViolationOf({ entries: [...NAMES, "open-code-review-desktop-0.1.13-setup.exe"] });
  check("a leftover installer from the previous build in the same dir is its own violation", /0\.1\.13.*混在同一目录/.test(stale), stale);
  check(
    "...while an intermediate the uploader does not pick is not",
    violationsOf({ entries: [...NAMES, "open-code-review-desktop-0.1.14-x64.nsis.7z", "builder-debug.yml"] }) === 0,
    firstViolationOf({ entries: [...NAMES, "open-code-review-desktop-0.1.14-x64.nsis.7z", "builder-debug.yml"] })
  );

  const wrongVersion = firstViolationOf({ version: "0.1" });
  check("a build version that is not x.y.z is refused before anything is compared", /x\.y\.z/.test(wrongVersion), wrongVersion);
}

/* ---- 5. the feed has to describe these bytes ---- */

{
  const otherVersion = firstViolationOf({ feed: { version: "0.2.0" } });
  check("a feed naming another version goes red", /feed 与产物不同版/.test(otherVersion), otherVersion);

  const wrongSize = firstViolationOf({ feed: { size: 504146 } });
  check(
    "a feed whose size is the truncated installer's goes red against the disk",
    /磁盘上是 97388854 字节/.test(wrongSize) && wrongSize.includes(SETUP),
    wrongSize
  );

  const wrongSha = firstViolationOf({ feed: { sha512: OTHER_SHA } });
  check("a feed whose sha512 is not the file's goes red and shows both", /实际 sha512 是/.test(wrongSha), wrongSha);

  const missingUrl = firstViolationOf({ feed: { url: "open-code-review-desktop-0.1.14-other.exe", topPath: "open-code-review-desktop-0.1.14-other.exe" } });
  check("a feed pointing at a file the tree does not have goes red", /feed 说有一件事，目录里没有/.test(missingUrl), missingUrl);

  const unreadable = firstViolationOf({ latest: parse("") });
  check("a feed that could not be parsed still stops the run", /读不到或是空/.test(unreadable), unreadable);

  const noFeed = firstViolationOf({ entries: NAMES.filter((n) => n !== LATEST_FILE), latest: null });
  check(
    "...and a missing feed is named once, not twice",
    /缺 latest.yml/.test(noFeed) && noFeed.includes(ROLE_WHY.latest.slice(0, 6)) && !/无法核对摘要/.test(noFeed),
    noFeed
  );
}

/* ---- 6. the same questions against real bytes ----
 * A fabricated `sizeAndDigest` proves the comparison; this proves the hash itself.
 * The bodies are a few KB because the math is the math at 97 MB — a real installer
 * would only make the suite slow and disk-hungry.
 */

{
  const scratch = (fn) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-verify-"));
    try {
      return fn(root);
    } catch (err) {
      return { threw: err };
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  const real = scratch((dir) => {
    const bodies = {
      [SETUP]: Buffer.concat([Buffer.from("NSIS\x02\x00"), Buffer.alloc(4096, 0x41)]),
      [PORTABLE]: Buffer.concat([Buffer.from("7z\x1c\xbc"), Buffer.alloc(2048, 0x42)]),
      [BLOCKMAP]: Buffer.alloc(512, 0x43),
    };
    const digestOf = (buf) => ({ size: buf.length, sha512: crypto.createHash("sha512").update(buf).digest("base64") });
    for (const [name, body] of Object.entries(bodies)) fs.writeFileSync(path.join(dir, name), body);
    const setup = digestOf(bodies[SETUP]);
    const text = `version: ${VERSION}
files:
  - url: ${SETUP}
    sha512: ${setup.sha512}
    size: ${setup.size}
path: ${SETUP}
sha512: ${setup.sha512}
size: ${setup.size}
releaseDate: '2026-11-05T00:00:00.000Z'
`;
    fs.writeFileSync(path.join(dir, LATEST_FILE), text);
    const entries = fs.readdirSync(dir);
    const latest = parse(fs.readFileSync(path.join(dir, LATEST_FILE), "utf8"));
    const sizeAndDigest = (name) => {
      try {
        return digestOf(fs.readFileSync(path.join(dir, name)));
      } catch (_) {
        return null;
      }
    };
    const clean = distArtifactViolations({ version: VERSION, entries, required: ROLES, latest, sizeAndDigest });

    // The one fact this block exists to prove: truncate the installer, and the feed's
    // own numbers are what notice.
    fs.writeFileSync(path.join(dir, SETUP), bodies[SETUP].subarray(0, 504));
    const truncated = distArtifactViolations({
      version: VERSION,
      entries: fs.readdirSync(dir),
      required: ROLES,
      latest: parse(fs.readFileSync(path.join(dir, LATEST_FILE), "utf8")),
      sizeAndDigest,
    });
    return { clean, truncated, setupSize: setup.size, setupSha: setup.sha512.slice(0, 12) };
  });

  check("real bytes hashed the way electron-builder hashes them pass", !real.threw && real.clean.length === 0, real.threw ? String(real.threw) : (real.clean || []).join("；"));
  check(
    "...and a truncated installer is caught by the feed's size, not by a guess",
    !real.threw && real.truncated.some((line) => /磁盘上是 504 字节/.test(line)) && real.truncated.some((line) => /实际 sha512 是/.test(line)),
    real.threw ? String(real.threw) : (real.truncated || []).join("；")
  );
}

/* ---- 7. which CLI the tree carries ---- */

{
  const pinned = pinVersion(PINNED_UPSTREAM);
  const good = { pinnedVersion: pinned, cliManifestVersion: pinned, winBinaryPresent: true };
  check("the packaged tree carrying the pinned CLI passes", unpackedCliViolations(good).length === 0, JSON.stringify(unpackedCliViolations(good)));
  check(
    "one version behind is named, because that is the shape of the v0.1.13 gap",
    unpackedCliViolations({ ...good, cliManifestVersion: "1.13.0" }).some((line) => line.includes("1.13.0") && line.includes(pinned)),
    unpackedCliViolations({ ...good, cliManifestVersion: "1.13.0" }).join("；")
  );
  check(
    "...and a missing wrapper manifest stops the answer rather than skipping it",
    unpackedCliViolations({ ...good, cliManifestVersion: null }).some((line) => /读不到/.test(line)),
    unpackedCliViolations({ ...good, cliManifestVersion: null }).join("；")
  );
  check(
    "...a missing win32 executable is its own violation, even when the version matches",
    unpackedCliViolations({ ...good, winBinaryPresent: false }).some((line) => /opencodereview\.exe/.test(line)),
    unpackedCliViolations({ ...good, winBinaryPresent: false }).join("；")
  );
  check(
    "...and both at once is two sentences, not one collapsed into the first",
    unpackedCliViolations({ ...good, cliManifestVersion: null, winBinaryPresent: false }).length === 2,
    String(unpackedCliViolations({ ...good, cliManifestVersion: null, winBinaryPresent: false }).length)
  );
}

/* ---- 8. how it is invoked ---- */

{
  check("no arguments means release/", parseArgs([]).ok === true && parseArgs([]).dir === "release", JSON.stringify(parseArgs([])));
  check("...--dir points it at the fallback output dir", parseArgs(["--dir", "release-0.1.14"]).dir === "release-0.1.14", JSON.stringify(parseArgs(["--dir", "release-0.1.14"])));
  check("...--unpacked at another unpacked tree", parseArgs(["--unpacked", "linux-unpacked"]).unpacked === "linux-unpacked", JSON.stringify(parseArgs(["--unpacked", "linux-unpacked"])));
  check("...a flag with no value after it is refused", parseArgs(["--dir"]).ok === false && /要跟一个目录名/.test(parseArgs(["--dir"]).error), JSON.stringify(parseArgs(["--dir"])));
  check("...an unknown flag is refused", parseArgs(["--version", "0.1.14"]).ok === false && /不认识的参数/.test(parseArgs(["--version", "0.1.14"]).error), JSON.stringify(parseArgs(["--version", "0.1.14"])));
  check(
    "...and the refusal names the command a reader can copy",
    parseArgs(["--nope"]).error.includes(VERIFY_COMMAND),
    parseArgs(["--nope"]).error
  );
}

/* ---- 8b. the two config values the run now reads ----
 *
 * Until round 141 these were only *derived* here: `build.win.signExecutable` because
 * nothing read it at all, `build.publish[0].url` because `requiredRoles` used only its
 * presence to decide whether a feed file is owed. Both are promises made to a reader —
 * "unsigned, so SmartScreen may warn" in four documents, and "the installed build checks
 * the published release on launch" — so both are now asked of the config itself, which is
 * the only place a drift is visible before the release is.
 *
 * The fixture docs are built from each document's own claim (`entry.claim.source`), which
 * is also the premise check below: a fixture that matches by luck would make the reversal
 * prove nothing.
 */
{
  const docsSayingIt = SIGNING_DOCS.map(({ path: target, claim }) => ({ path: target, text: `正文里那句：${claim.source}` }));
  const docsSilentOn = (target) => docsSayingIt.map((doc) => (doc.path === target ? { ...doc, text: "这一份把签名的事一句没提。" } : doc));

  check(
    "premise: each fixture doc matches its own claim, and the silenced one does not",
    SIGNING_DOCS.every((entry, index) => entry.claim.test(docsSayingIt[index].text)) &&
      !SIGNING_DOCS[2].claim.test(docsSilentOn(SIGNING_DOCS[2].path)[2].text),
    JSON.stringify(docsSayingIt.map((doc) => doc.text.slice(0, 24)))
  );
  check(
    "signExecutable false + the four documents saying so: nothing to complain",
    signingViolations({ signExecutable: false, docs: docsSayingIt }).length === 0,
    signingViolations({ signExecutable: false, docs: docsSayingIt }).join("；")
  );
  const flipped = signingViolations({ signExecutable: true, docs: docsSayingIt });
  check(
    "...flipping signExecutable to true changes the conclusion, and names every document that still says unsigned",
    flipped.length === 1 &&
      flipped[0].includes("README.md") &&
      flipped[0].includes("README.zh-CN.md") &&
      flipped[0].includes("使用说明.md") &&
      flipped[0].includes("docs/win-install-checklist.md"),
    flipped.join("；") || "没有违规"
  );
  check(
    "...an absent flag is read as \u201cwill sign\u201d, not as \u201cstill false\u201d",
    signingViolations({ signExecutable: undefined, docs: docsSayingIt }).length === 1,
    signingViolations({ signExecutable: undefined, docs: docsSayingIt }).join("；") || "没有违规"
  );
  const silenced = SIGNING_DOCS[2].path;
  const oneSilent = signingViolations({ signExecutable: false, docs: docsSilentOn(silenced) });
  check(
    "...the flag still false but one document stopped saying it: that document is named, and only it",
    oneSilent.length === 1 &&
      oneSilent[0].includes(silenced) &&
      SIGNING_DOCS.filter((entry) => entry.path !== silenced).every((entry) => !oneSilent[0].includes(entry.path)),
    oneSilent.join("；") || "没有违规"
  );

  const GOOD_FEED_URL = "https://github.com/castorhrio/open-code-review-desktop/releases/latest/download/";
  check("premise: the feed url this repository ships passes the shape the rule requires", LATEST_FEED_URL.test(GOOD_FEED_URL), GOOD_FEED_URL);
  check("publish pointing at releases/latest/download/: nothing to complain", feedSourceViolations({ publish: [{ provider: "generic", url: GOOD_FEED_URL }] }).length === 0, feedSourceViolations({ publish: [{ provider: "generic", url: GOOD_FEED_URL }] }).join("；"));
  const pinned = feedSourceViolations({ publish: [{ provider: "generic", url: "https://github.com/castorhrio/open-code-review-desktop/releases/download/v0.1.13/" }] });
  check(
    "...a feed pinned to one tag goes red, because installed clients would never see the next release",
    pinned.length === 1 && pinned[0].includes("releases/download/v0.1.13"),
    pinned.join("；") || "没有违规"
  );
  const noSlash = feedSourceViolations({ publish: [{ provider: "generic", url: GOOD_FEED_URL.replace(/\/$/, "") }] });
  check(
    "...a missing trailing slash is the same failure shape: the feed file never resolves",
    noSlash.length === 1,
    noSlash.join("；") || "没有违规"
  );
  check(
    "...no publish config at all is refused rather than skipped: the README promises in-app updates",
    feedSourceViolations({ publish: undefined }).length === 1 && feedSourceViolations({ publish: [] }).length === 1,
    JSON.stringify({ undef: feedSourceViolations({ publish: undefined }).length, empty: feedSourceViolations({ publish: [] }).length })
  );
  const provider = feedSourceViolations({ publish: [{ provider: "github", url: GOOD_FEED_URL }] });
  check(
    "...another provider is named as such, not judged on its url",
    provider.length === 1 && provider[0].includes("\"github\""),
    provider.join("；") || "没有违规"
  );
  check(
    "...a first entry that is not an object is refused (an unreadable feed is not an empty one)",
    feedSourceViolations({ publish: [null] }).length === 1 && feedSourceViolations({ publish: ["x"] }).length === 1,
    JSON.stringify({ null: feedSourceViolations({ publish: [null] }).length })
  );

  // The two readings this file cannot fake: the repository's own values.
  const realPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const realDocs = SIGNING_DOCS.map(({ path: target }) => {
    try {
      return { path: target, text: fs.readFileSync(path.join(ROOT, target), "utf8") };
    } catch (_) {
      return { path: target, text: "" };
    }
  });
  check(
    "...and in this repository: signExecutable is false, all four documents still say so, and the feed is releases/latest",
    signingViolations({ signExecutable: realPkg.build.win.signExecutable, docs: realDocs }).length === 0 &&
      feedSourceViolations({ publish: realPkg.build.publish }).length === 0,
    JSON.stringify({
      signExecutable: realPkg.build.win.signExecutable,
      silent: SIGNING_DOCS.filter((entry, index) => !entry.claim.test(realDocs[index].text)).map((entry) => entry.path),
      url: realPkg.build.publish && realPkg.build.publish[0] && realPkg.build.publish[0].url,
    })
  );
  check(
    "...so the run actually asks both (exported predicates nobody calls are not a gate)",
    sourceOfVerify.includes("signingViolations({ signExecutable: win.signExecutable, docs })") &&
      sourceOfVerify.includes("feedSourceViolations({ publish: build.publish })"),
    "main() 里没有那两行"
  );
}

/* ---- 9. the wiring: it runs where a release is cut ---- */

{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const closure = auditScriptClosure(pkg, (file) => {
    try {
      return fs.readFileSync(path.join(ROOT, file), "utf8");
    } catch (_) {
      return null;
    }
  });
  check(
    "verify:dist is the one command that answers this",
    pkg.scripts["verify:dist"] === "node tools/release-verify.mjs" && closure.files.has("tools/release-verify.mjs"),
    `verify:dist=${JSON.stringify(pkg.scripts["verify:dist"])}，闭包里有=${closure.files.has("tools/release-verify.mjs")}`
  );
  check(
    "audit:release-verify-rules is the rules half, and it hangs in audit:static",
    pkg.scripts["audit:release-verify-rules"] === "node tools/release-verify-smoke.mjs" && String(pkg.scripts["audit:static"] || "").includes("audit:release-verify-rules"),
    `audit:release-verify-rules=${JSON.stringify(pkg.scripts["audit:release-verify-rules"])}`
  );
  check(
    "...and not in audit:app, which needs a display and a build",
    !String(pkg.scripts["audit:app"] || "").includes("release-verify"),
    String(pkg.scripts["audit:app"] || "").slice(0, 120)
  );

  const at = (name) => RELEASE_STEPS.indexOf(name);
  check(
    "the release plan verifies the artefacts after packaging",
    at("dist") >= 0 && at("verify-dist") === at("dist") + 1,
    RELEASE_STEPS.join(" -> ")
  );
  check(
    "...and the key scan still comes last, over the packages it checked",
    at("secret-scan") === RELEASE_STEPS.length - 1 && at("verify-dist") < at("secret-scan"),
    RELEASE_STEPS.join(" -> ")
  );

  const cleanCapture = (cmd) => (String(cmd).startsWith("git symbolic-ref") ? "main\n" : "");
  const steps = planRelease({ version: VERSION, capture: cleanCapture }).steps;
  const command = (name) => (steps.find((step) => step.name === name) || {}).command;
  check(
    "...with the command the plan carries being the same file this check pins",
    command("verify-dist") === "node tools/release-verify.mjs",
    JSON.stringify(command("verify-dist"))
  );
  check(
    "...so a refused plan runs it no more than it runs packaging",
    planRelease({ version: VERSION, capture: () => { throw new Error("detached"); } }).steps.length === 0,
    "steps"
  );
}

/* ---- summary ---- */

const failed = results.filter((result) => !result.ok);
console.log(`\n发布产物自检规则：${results.length} 条检查，${failed.length} 条红`);
if (failed.length) {
  console.error(failed.map((result) => `  - ${result.name}：${result.detail}`).join("\n"));
  process.exit(1);
}
