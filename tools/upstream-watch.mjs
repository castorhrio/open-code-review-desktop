// Says whether upstream's default branch still sits on the commit the sync doc
// was written against.
//
// The sync doc (`docs/OCR-UPSTREAM-SYNC.md`) records which upstream source rows
// have been re-read by hand, and that record is only meaningful while upstream
// stays on the same commit. Until now "check the HEAD" lived in prose, so a
// round could skip it and look identical to a round that checked and found
// nothing. This script turns that one fact into a sentence every run prints.
//
// It only *reports*. A moved HEAD is not an error — the doc's rows still need a
// human to re-read them — and an unreachable GitHub is not an error either: it
// prints "skipped" and exits 0, so no audit or release step is ever blocked by
// the network. Which also means a green `upstream:check` is *not* a safety net:
// the net is `audit:service` / `audit:config` / `audit:git` plus the five rows
// a human re-reads. The pure functions are exported so
// `tools/upstream-watch-smoke.mjs` can assert the answers without network.
//
// Three things were added after the first five rounds of unanswered checks:
//  - the command tries `git ls-remote` and then the GitHub API, and says which
//    one answered (`通路：git` / `通路：api`). Historically a timed-out git was
//    reported as "skipped" even though the API could answer the same question;
//  - a skipped run now starts with `[UPSTREAM-DEBT]`, so "this round did not
//    actually check the HEAD" is a greppable fact instead of prose;
//  - a moved run starts with `[UPSTREAM-MOVED]`, so the three answers are three
//    greps: `[UPSTREAM-DEBT]` = not checked, `[UPSTREAM-MOVED]` = checked and
//    changed, no marker = checked and unchanged.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The one document `audit:upstream` reads. Named once, because the command
// itself now opens it (it needs the last checked HEAD to answer "did upstream
// move *since last round*") and three other rules point at it by path.
export const UPSTREAM_SYNC_DOC = "docs/OCR-UPSTREAM-SYNC.md";

export const UPSTREAM_URL = "https://github.com/alibaba/open-code-review.git";
export const UPSTREAM_REF = "refs/heads/main";
export const UPSTREAM_API =
  "https://api.github.com/repos/alibaba/open-code-review/commits/main";

// Prefix of every skipped sentence. Grep for it across a session's output to see
// the rounds whose network debt was never paid; it is a machine marker, not a
// human word, so it survives translation and prose edits.
export const DEBT_MARKER = "[UPSTREAM-DEBT]";

// Prefix of a moved sentence. The three answers are three states a reader has to
// tell apart in a pile of output — "did not check", "checked, unchanged",
// "checked, moved". The first has a marker; this gives the third one too, so a
// single grep separates them instead of trusting the shape of the prose. A
// pinned sentence (the quiet, common case) carries no marker on purpose: silence
// should mean "nothing to do", and any marker is louder than silence.
export const MOVED_MARKER = "[UPSTREAM-MOVED]";

// A commit is 40 hex characters, and so is this pin — deliberately *not* the
// readable 7-character prefix the prose below uses.
//
// The reason is the only failure mode this comparison has: a short pin makes
// "same commit" and "same first seven characters" the same answer. Upstream
// moving from `abb7abcd5c51…` to `abb7abcd5c5f…` would then be reported as "与对照表
// 一致，无需重读" — the one direction this sentence must never be wrong in, since
// every row of the table would silently be stale. With the whole 40 characters
// pinned, that case is `moved`: over-reporting drift costs a re-read, under-
// reporting it costs correctness.
//
// The value is upstream `refs/heads/main` as of `v1.13.5` — the tag commit, which
// the released binary confirms itself (`ocr --version` prints `v1.13.5 (abb7abcd)`);
// `docs/OCR-UPSTREAM-SYNC.md` carries the same 40 characters on its fixed
// 「本轮 HEAD 核对」 line and the smoke test keeps the two exactly equal.
export const PINNED_UPSTREAM = Object.freeze({
  sha: "abb7abcd5c5196fa0278dc87db85780fa269562f",
  tag: "v1.13.5",
});

// Exactly the rows the sync doc's comparison table wants re-read when upstream
// moves — all five of them, each carrying the upstream file the row is about.
//
// Two separate promises are made here, and both used to be prose:
//  - the moved sentence *names what to read*. It listed four rows while the
//    doc's table had five, so the fifth (whether an empty built-in provider
//    table is legal, `cmd/opencodereview/llm_cmd.go`) was reachable only by
//    someone who also opened the doc and noticed the mismatch. A round that
//    greps `[UPSTREAM-MOVED]` now gets the whole reading list;
//  - the list and the table cannot drift: `source` is the exact upstream
//    file/artifact string the table's 上游文件 cell contains, and
//    `tableRowCoverage` (below) checks the two are in bijection — one row per
//    source, one source per row. Adding a table row without adding it here, or
//    vice versa, is a red check that names the missing source.
export const ROWS_TO_REREAD = Object.freeze([
  {
    label: "provider 解析顺序",
    source: "internal/llm/resolver.go",
    note: "同步改 UPSTREAM_RESOLVER 与 MATCH_RULES",
  },
  {
    label: "`config set` 的 key 语法",
    source: "cmd/opencodereview/config_cmd.go",
    note: "点名到最后一个点的分段、未配置带点名直接拒绝",
  },
  {
    label: "内置服务表",
    source: "ocr llm providers",
    note: "列 / 表头 / 失败时的 stderr 措辞",
  },
  {
    label: "内置服务表**为空**是否合法",
    source: "cmd/opencodereview/llm_cmd.go",
    note: "表头无条件打印、空 registry 不报错；上游若改成可外挂 provider，TABLE_HOLLOW 的措辞要跟着改",
  },
  {
    label: "运行期失败分类",
    source: "failure_class",
    note: "两张表：RunFailureClass 与每文件 FailureClass",
  },
]);

// The sources alone, in the order a reader meets them. Exported so a caller (and
// the smoke test) can ask "did the sentence name all of them?" without caring
// about the wording around each one.
export const ROW_SOURCES = Object.freeze(ROWS_TO_REREAD.map((row) => row.source));

// The comparison table's header, spelled exactly as the doc writes it. Used as
// the anchor for `tableRowCoverage`; a reworded header makes that answer
// `found: false`, which is red on purpose (the alternative is a table nobody can
// find and a coverage check that silently passes over zero rows).
export const TABLE_HEADER = "| 对照点 | 上游文件 |";

// The table's body rows, each with its 1-based doc line. The separator row
// (`| --- | --- | …`) carries no comparison point and is skipped; a row that
// starts with `|` but has no source is reported as an orphan by
// `tableRowCoverage`, not dropped here.
export const comparisonTableRows = (doc) => {
  const lines = String(doc || "").split(/\r?\n/);
  const headerAt = lines.findIndex((line) => line.trim().startsWith(TABLE_HEADER));
  if (headerAt === -1) return { found: false, headerLine: null, rows: [] };
  const rows = [];
  for (let index = headerAt + 1; index < lines.length; index += 1) {
    const text = lines[index].trim();
    if (!text.startsWith("|")) break;
    if (/^\|[\s|:-]+\|$/.test(text)) continue;
    rows.push({ line: index + 1, text });
  }
  return { found: true, headerLine: headerAt + 1, rows };
};

// Which table row covers which reading-list source. The point is the bijection:
// the moved sentence is generated from `ROWS_TO_REREAD`, the table is hand-
// written, and the two lists are the same five facts in two places. Without this
// answer, "the sentence names every row" would be checked against the table by
// label substring — which passes even when the table has a sixth row nobody will
// ever be told to re-read.
//
// `missing`  = listed in ROWS_TO_REREAD, in no table row (the sentence names a
//              row the table does not have, or the doc lost a row);
// `orphans`  = a table row that names none of the sources (the table has a
//              comparison point the moved sentence will never mention);
// `duplicated` = a source claimed by two rows (the table repeats itself, so one
//              of the two is being maintained for nothing).
export const tableRowCoverage = (doc, rows = ROWS_TO_REREAD) => {
  const table = comparisonTableRows(doc);
  const claims = table.rows.map((row) => ({
    ...row,
    sources: rows.filter((entry) => row.text.includes(entry.source)).map((entry) => entry.source),
  }));
  const claimsFor = (source) => claims.filter((row) => row.sources.includes(source));
  return {
    found: table.found,
    headerLine: table.headerLine,
    rows: claims,
    missing: rows.filter((entry) => claimsFor(entry.source).length === 0).map((entry) => entry.source),
    duplicated: rows.filter((entry) => claimsFor(entry.source).length > 1).map((entry) => entry.source),
    orphans: claims.filter((row) => row.sources.length === 0),
  };
};

// ---- the pin, and the dependency that installs the CLI it pins ------------
//
// The sync doc declares one upstream release; `package.json` writes a range for
// the same package. That is one promise written in two files maintained by
// different edits, and the two can disagree without anything looking wrong: `^`
// lets the next `npm install` bring a newer minor while the pin, the five
// comparison rows and the `UPSTREAM_RESOLVER` simulation all still describe the
// release this wrapper was read against. Agreement is the common case, which is
// exactly why nothing would notice the day they stop.
//
// So the version in the dependency range is compared to the pinned tag: raising
// the dependency has to move the pin — and therefore the reading list — with it,
// and the red sentence names both sides instead of leaving the reader to grep
// for the second one.
export const UPSTREAM_PACKAGE = "@alibaba-group/open-code-review";

// The version out of a semver range: `^1.13.3`, `~1.13.3`, `>=1.13.3 <2` and a
// bare `1.13.3` all answer `1.13.3`. A range with no version in it (`*`,
// `latest`, a git url, an empty string) answers `null` — those are the values
// this check cannot compare, and treating "cannot compare" as "agrees" is the
// failure mode the check exists to prevent.
export const versionInRange = (range) => {
  const hit = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(String(range == null ? "" : range));
  return hit ? hit[1] : null;
};

/** The pinned tag without its `v`, i.e. the version npm would publish. */
export const pinVersion = (pinned = PINNED_UPSTREAM) =>
  String((pinned && pinned.tag) || "").replace(/^v/, "");

// The rule as violations. Empty is the only acceptable answer for this repo's
// `package.json` next to the pin it ships with.
export const dependencyPinViolations = (pkg, pinned = PINNED_UPSTREAM) => {
  const want = pinVersion(pinned);
  if (!/^\d+\.\d+\.\d+/.test(want)) {
    return [
      `pin 的 tag 不是版本号（${JSON.stringify((pinned && pinned.tag) || null)}）：` +
        "本条按版本号比较，读不出 pin 的版本就没有可比的一方",
    ];
  }
  const dependencies = (pkg && pkg.dependencies) || {};
  const range = dependencies[UPSTREAM_PACKAGE];
  if (range === undefined) {
    return [
      `package.json 的 dependencies 里没有 ${UPSTREAM_PACKAGE}：` +
        `pin 说封装的是 ${pinned.tag}，依赖里却一个字都没写`,
    ];
  }
  const got = versionInRange(range);
  if (got === null) {
    return [
      `package.json 把 ${UPSTREAM_PACKAGE} 写成 ${JSON.stringify(range)}，读不出版本号；` +
        `pin 是 ${pinned.tag}（${want}），两者无从比较——写一个能读出 ${want} 的版本区间`,
    ];
  }
  if (got !== want) {
    return [
      `package.json 的 ${UPSTREAM_PACKAGE} 落在 ${got}（${JSON.stringify(range)}），` +
        `而 pin 是 ${pinned.tag}（${want}）：依赖先动，就要把 pin、对照表 5 行与 ` +
        "`UPSTREAM_RESOLVER` 一起复核后改成本轮的版本",
    ];
  }
  return [];
};

const FULL_SHA = /^[0-9a-f]{40}$/i;

// One predicate for the one question ("is this a whole commit?"), because it is
// asked four times and a rule that only three of four call sites follow is how
// the short-SHA hole opened in the first place. The refusal reasons below quote
// this same 40-character rule.
export const isFullSha = (value) => FULL_SHA.test(String(value == null ? "" : value).trim());

// Reads the SHA for `UPSTREAM_REF` out of `git ls-remote` output. A malformed
// line is ignored rather than trusted: a bad answer here would be reported as a
// moved HEAD (or worse, as "pinned"), and the whole point is that this sentence
// is trustworthy without a human re-checking it.
export const parseLsRemote = (stdout, ref = UPSTREAM_REF) => {
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref && isFullSha(sha)) return sha;
  }
  return null;
};

// The GitHub API answers the same question with `{"sha": "…"}`. Validated with
// the same 40-character rule: the API is a different road to the same fact, not
// a reason to trust a shorter answer.
export const parseApiCommit = (json) => {
  const sha = json && typeof json.sha === "string" ? json.sha.trim() : "";
  return isFullSha(sha) ? sha : null;
};

// Turns a `spawnSync` result into the same shape the API road produces. Kept
// pure and exported because the interesting cases (timeout, non-zero exit,
// empty output) cannot be produced from the real network in a smoke test.
export const classifyGit = (result) => {
  if (!result) return { ok: false, failure: "git ls-remote 没有返回结果", channel: "none" };
  if (result.error) {
    return {
      ok: false,
      failure: result.error.message || "git ls-remote 报错",
      channel: "none",
    };
  }
  if (result.status !== 0) {
    return { ok: false, failure: `git ls-remote 退出码非 0（${result.status}）`, channel: "none" };
  }
  const sha = parseLsRemote(result.stdout);
  if (!sha) return { ok: false, failure: "ls-remote 输出里没有 refs/heads/main", channel: "none" };
  return { ok: true, sha, channel: "git" };
};

// The three answers: `pinned` (same commit as the reference), `moved` (re-read
// the rows), `skipped` (no answer this run — explicitly *not* "unchanged").
//
// `pinned` is the *reference* the answer is measured against, and it is a
// parameter for a reason: the command passes 「上一轮核到的 HEAD」 (read out of the
// sync doc), not the release pin. Comparing against the pin is what made this
// command shout 「上游 HEAD 已前进」 for six rounds in a row while the ledger rows
// for those rounds said 「无新内容」 — upstream's default branch is *supposed* to be
// ahead of the tag it released. The default here stays the pin so a caller that
// says nothing keeps the old, stricter comparison; `runUpstreamWatch` is the
// caller that now passes the recorded one.
//
// A short `pinned` (or a short SHA from the runner) is refused as `skipped`
// rather than prefix-matched. Prefix matching would answer "pinned" for a
// different commit that happens to share the recorded prefix, and a wrong
// "pinned" is invisible: nobody re-reads a row that says nothing changed.
// `skipped` at least says the round did not really check.
export const upstreamDrift = ({
  ok,
  sha,
  pinned = PINNED_UPSTREAM.sha,
  referenceRound = null,
  failure = "",
  channel = "",
}) => {
  if (!ok) {
    return { state: "skipped", reason: failure || "git ls-remote 不可达", channel: "none" };
  }
  if (!sha) {
    return { state: "skipped", reason: "ls-remote 输出里没有 refs/heads/main", channel: "none" };
  }
  if (!isFullSha(pinned)) {
    return {
      state: "skipped",
      reason: `pin 不是完整 40 位 SHA（${pinned}）：短于 40 位只能判「前几位相同」，不能判「同一个 commit」`,
      pinned,
      channel: "none",
    };
  }
  if (!isFullSha(sha)) {
    return {
      state: "skipped",
      reason: `ls-remote 的 SHA 不是完整 40 位（${sha}）`,
      sha,
      pinned,
      channel: "none",
    };
  }
  return {
    state: String(sha).toLowerCase() === String(pinned).toLowerCase() ? "pinned" : "moved",
    sha,
    pinned,
    referenceRound: Number.isInteger(referenceRound) ? referenceRound : null,
    channel: channel || "git",
  };
};

export const formatDrift = (verdict, rows = ROWS_TO_REREAD) => {
  const via = verdict.channel || "none";
  if (verdict.state === "skipped") {
    return `${DEBT_MARKER} 上游 HEAD 核对：跳过（${verdict.reason}；通路：${via}；本轮未核对，不等于上游没变）`;
  }
  if (verdict.state === "pinned") {
    // 「与上一轮核到的一致」, not 「与对照表一致」: the thing compared is the HEAD the
    // last checking round recorded, which is not the pin. Saying "the table
    // agrees" while comparing two other things was the old wording's mistake.
    const when = Number.isInteger(verdict.referenceRound) ? `（第 ${verdict.referenceRound} 轮核到的那次）` : "";
    return `上游 HEAD 核对：${verdict.pinned}（与上一轮核到的一致${when}，无需重读；通路：${via}）`;
  }
  // When the two commits share the readable 7-character prefix, the arrow alone
  // would print `375f64c → 375f64c` — technically "moved" but read as a typo. Say
  // out loud that the difference is further in, and keep the whole SHA on the
  // next line so the reader can compare character by character.
  const from = verdict.pinned.slice(0, 7);
  const to = verdict.sha.slice(0, 7);
  const arrow = from === to ? `${from} → ${to}（前 7 位相同，区别在后面）` : `${from} → ${to}`;
  // Which round the "from" side came from. Without it the arrow reads like the
  // pin moved — the sentence it used to print for six rounds while upstream's
  // default branch was merely ahead of its release. Named when the caller knows.
  const since = Number.isInteger(verdict.referenceRound)
    ? `上一次核到是第 ${verdict.referenceRound} 轮；`
    : "";
  // The reading list is printed here, not looked up in the doc: the event
  // ("the pin moved") should carry its own consequence. `rows` is a parameter so
  // the smoke test can hand in a shorter list and assert that the dropped source
  // really disappears from the output — otherwise "all five are named" could
  // pass while the sentence never read the list at all.
  const reading = rows.map(
    (row, index) =>
      `   ${index + 1}. ${row.label} —— \`${row.source}\`${row.note ? `（${row.note}）` : ""}`
  );
  return [
    `${MOVED_MARKER} 上游 HEAD 已前进：${arrow}（${since}通路：${via}）`,
    `   新 HEAD 全 40 位：${verdict.sha}`,
    `   这不是失败，但下面 ${rows.length} 处对照点需要重读源码（与 docs/OCR-UPSTREAM-SYNC.md 的对照表同 ${rows.length} 行），而不是只看 SHA：`,
    ...reading,
  ].join("\n");
};

// ---- the doc's declarations of the pin -------------------------------------
//
// The pin is written down three times in `docs/OCR-UPSTREAM-SYNC.md` (a machine-
// readable block, the fixed "本轮 HEAD 核对" line, and the prose sentence that
// introduces `upstream:check`) and once here. Four hand-written copies of one
// fact is how
// a doc quotes a commit the sentinel no longer compares against — and the
// failure is silent: the sentence stays green while the doc's table is stale.
//
// So the doc's declarations are read out by shape, not by trusting one line.
// Every shape below is a place that claims "this is the pinned commit":
//
//   - `sha <40 hex>` inside the `<!-- upstream-pin:start/end -->` block;
//   - the SHA in the fixed `本轮 HEAD 核对：\`…\`` line;
//   - the SHA right after `固定的整串 40 位 SHA` in the prose.
//
// `findDocPins` returns them all with 1-based line numbers, and the smoke test
// requires each to equal `PINNED_UPSTREAM.sha` — so a one-character edit
// anywhere in the doc goes red, and the message can name the line instead of
// leaving the reader to diff three copies by eye. Kept pure and exported so the
// "one character changed" case can be produced from a mutated copy of the real
// doc, rather than asserted about the doc as it happens to read today.
export const PIN_BLOCK_START = "<!-- upstream-pin:start -->";
export const PIN_BLOCK_END = "<!-- upstream-pin:end -->";

// The round-by-round narrative lives here, not in the sync doc: one file per
// role keeps the pin count meaningful. `findDocPins` only ever reads the sync
// doc, and `tools/upstream-watch-smoke.mjs` additionally asserts that the log
// holds no pin declaration and no pin block at all — an archive that quoted the
// pin would become a second authority nobody compares against.
export const UPSTREAM_HISTORY_DOC = "docs/upstream-history.md";

const SHA_IN_LINE = "([0-9a-fA-F]{7,40})";
// The place name of the fixed "本轮 HEAD 核对" line. Named, because the
// machine-readable region's anchor list below needs the *same* name to find
// that line — and a second copy of this string is exactly the kind of thing
// that drifts out of sync with the rule it describes.
export const FIXED_LINE_PLACE = "本轮 HEAD 核对 行";
// The shapes outside the block. `g` is not used: each rule is applied to one
// line and the first match is the declaration.
const PIN_LINE_RULES = [
  { where: FIXED_LINE_PLACE, re: new RegExp("本轮 HEAD 核对：`" + SHA_IN_LINE + "`") },
  { where: "正文固定 SHA", re: new RegExp("固定的整串 40 位 SHA\\s*`" + SHA_IN_LINE + "`") },
];

// The shape names, outside the private rule table: `PIN_PLACES` is built from
// this list, so adding a fourth shape cannot leave the coverage count asserting
// three places while four exist.
export const PIN_LINE_SHAPES = Object.freeze(PIN_LINE_RULES.map((rule) => rule.where));

// One matcher for "is this line a pin declaration?", shared by `findDocPins`
// (the sync doc's copies of the pin) and `findShaCitations` (the archive's
// rule). Two spellings of the same shape list is how the archive rule would
// silently stop covering a shape added to the doc rule.
export const matchPinShape = (line) => {
  for (const rule of PIN_LINE_RULES) {
    const match = rule.re.exec(String(line == null ? "" : line));
    if (match) return { where: rule.where, sha: match[1] };
  }
  return null;
};

// The three places a pin is declared, in the order a reader meets them. Named
// here so "one declaration went missing" has an answer: `findDocPins` reads by
// shape, so a reworded line simply produces fewer pins — and a caller that only
// asserts "everything I read equals the constant" stays green while no longer
// checking the line the wording moved away from.
export const PIN_PLACES = Object.freeze(["pin 块", ...PIN_LINE_SHAPES]);

// Counts declarations per place. The smoke test compares this against the
// expected three rather than checking `pins.length >= 3`, so a missing place is
// red on the count (and the missing name is printed) before any value is read.
export const pinPlaceCoverage = (pins) => {
  const counts = Object.fromEntries(PIN_PLACES.map((place) => [place, 0]));
  for (const pin of pins || []) {
    const where = pin && pin.where;
    if (Object.prototype.hasOwnProperty.call(counts, where)) counts[where] += 1;
  }
  const missing = PIN_PLACES.filter((place) => counts[place] === 0);
  const duplicated = PIN_PLACES.filter((place) => counts[place] > 1);
  return {
    expected: [...PIN_PLACES],
    counts,
    total: (pins || []).length,
    missing,
    duplicated,
    complete: missing.length === 0 && duplicated.length === 0,
  };
};

export const findDocPins = (doc) => {
  const pins = [];
  let tag = null;
  let blockFound = false;
  let inBlock = false;
  const lines = String(doc || "").split(/\r?\n/);
  lines.forEach((line, index) => {
    const n = index + 1;
    if (line.includes(PIN_BLOCK_START)) {
      inBlock = true;
      blockFound = true;
      return;
    }
    if (line.includes(PIN_BLOCK_END)) {
      inBlock = false;
      return;
    }
    if (inBlock) {
      const sha = /^\s*sha\s+([0-9a-fA-F]{7,40})\s*$/.exec(line);
      if (sha) {
        pins.push({ line: n, sha: sha[1], where: "pin 块" });
        return;
      }
      const tagLine = /^\s*tag\s+(\S+)\s*$/.exec(line);
      if (tagLine) tag = { line: n, tag: tagLine[1] };
      return;
    }
    const shape = matchPinShape(line);
    if (shape) {
      pins.push({ line: n, sha: shape.sha, where: shape.where });
      return;
    }
  });
  return { pins, tag, blockFound };
};

// ---- which upstream commit the last round actually looked at ----
//
// The pin says which *release* this wrapper is built around (`v1.13.5`, whose tag
// commit the binary confirms itself). It is not the same fact as "the last round
// opened `refs/heads/main` and read it", and the two were conflated: this command
// compared upstream's HEAD against the pin, so from the round upstream's default
// branch moved past the tag, every single run printed
// `[UPSTREAM-MOVED] 上游 HEAD 已前进：abb7abc → …` — for six rounds running, while
// those same rounds' ledger rows said 「无新内容」. A marker that always fires is
// not a marker, and a tool that contradicts the document every round trains its
// reader to ignore both.
//
// So the second fact gets its own machine-readable line: the HEAD the last
// checking round really got an answer for, and the round it did it in. The
// command compares against *that*, which makes the three answers mean what they
// say: skipped = this round did not check; moved = upstream advanced since the
// recorded round; no marker = checked, same commit as last time.
//
// The line is held to the ledger, not to a habit: `checkedHeadViolations` requires
// the round it names to be the ledger's last row. Two places, one fact — a round
// that updates one and not the other goes red instead of leaving a doc where the
// table says 「第 9 轮核过」 and the落点 still points at 第 8 轮's commit.
export const CHECKED_HEAD_PLACE = "本轮核到的上游 HEAD 行";

const CHECKED_HEAD_RE = new RegExp(
  "本轮核到的上游 HEAD：`" + SHA_IN_LINE + "`（第\\s*(\\d+)\\s*轮）"
);

/** The declaration on one line, or `null`. Mirrors `matchPinShape`: it returns
 *  the *place* so the anchor rule can find the line by shape rather than by
 *  trusting its wording. */
export const matchCheckedHeadShape = (line) => {
  const match = CHECKED_HEAD_RE.exec(String(line == null ? "" : line));
  if (!match) return null;
  return { where: CHECKED_HEAD_PLACE, sha: match[1], round: Number(match[2]) };
};

/** Every declaration of "the HEAD the last checking round saw", with 1-based
 *  lines. `count` is what the violations read: two declarations are two
 *  answers. */
export const findCheckedHead = (doc) => {
  const found = [];
  String(doc == null ? "" : doc)
    .split(/\r?\n/)
    .forEach((line, index) => {
      const hit = matchCheckedHeadShape(line);
      if (hit) found.push({ line: index + 1, sha: hit.sha, round: hit.round });
    });
  const first = found[0] || null;
  return {
    count: found.length,
    sha: first ? first.sha : null,
    round: first ? first.round : null,
    line: first ? first.line : null,
    lines: found.map((entry) => entry.line),
  };
};

/** The rule as violations. Empty is the only acceptable answer for the real sync
 *  doc.
 *
 *  `ledgerRounds` is passed in rather than read here: the ledger's parser lives
 *  further down and the smoke test drives this rule with hand-written rounds, so
 *  one reader of the table stays one reader.
 *
 *  The round comparison is the part that matters. A declaration the ledger has
 *  already moved past is *the* drift this rule exists for: the table would say
 *  「第 129 轮核过」 while the落点 still held 第 128 轮's commit, and the command
 *  would then say 「与上一轮核到的一致」 about a round nobody checked.
 */
export const checkedHeadViolations = (doc, { ledgerRounds = [] } = {}) => {
  const head = findCheckedHead(doc);
  const violations = [];
  if (head.count === 0) {
    violations.push(
      `同步文档里没有「${CHECKED_HEAD_PLACE}」（形状：**本轮核到的上游 HEAD：\`<40 位 SHA>\`（第 N 轮）**）——` +
        "没有这一行，`upstream:check` 只能拿上游 HEAD 去比 pin（发布版本），" +
        "于是上游默认分支一旦越过 tag，它每一轮都会喊「已前进」"
    );
    return violations;
  }
  if (head.count > 1) {
    violations.push(
      `「${CHECKED_HEAD_PLACE}」出现 ${head.count} 次（应为 1 次）：第 ${head.lines.join("、")} 行——` +
        "两处声明就是两个答案，`upstream:check` 只会读到第一个"
    );
  }
  if (!isFullSha(head.sha)) {
    violations.push(
      `第 ${head.line} 行：「${CHECKED_HEAD_PLACE}」里的 SHA 不是完整 40 位（${JSON.stringify(head.sha)}）——` +
        "前几位相同不等于同一个 commit，比较的一方短了，答案就会把「已前进」读成「没动」"
    );
  }
  const rounds = (ledgerRounds || []).filter((round) => Number.isInteger(round));
  const last = rounds.length ? rounds[rounds.length - 1] : null;
  if (last === null) {
    violations.push(
      `通路账里没有可读的轮次，「${CHECKED_HEAD_PLACE}」因此无从对账——` +
        "核到哪儿与第几轮核的是同一件事，两边都要有"
    );
  } else if (!Number.isInteger(head.round)) {
    violations.push(`第 ${head.line} 行：「${CHECKED_HEAD_PLACE}」没有写「（第 N 轮）」`);
  } else if (head.round !== last) {
    violations.push(
      `第 ${head.line} 行：「${CHECKED_HEAD_PLACE}」写着第 ${head.round} 轮，` +
        `而通路账末行是第 ${last} 轮——核到哪儿是一件事，两处必须一起改；` +
        "只改一处，`upstream:check` 就会拿着上一轮的 HEAD 说「与上一轮核到的一致」"
    );
  }
  return violations;
};

/** What the command compares against, read out of the doc.
 *
 *  Not `PINNED_UPSTREAM.sha`: see the comment above. `ok: false` is a reason a
 *  reader can act on, and the command turns it into the greppable debt sentence
 *  rather than silently comparing against the wrong thing. */
export const referenceFromDoc = (doc) => {
  const head = findCheckedHead(doc);
  if (head.count !== 1) {
    return {
      ok: false,
      reason:
        head.count === 0
          ? `同步文档里找不到「${CHECKED_HEAD_PLACE}」，没有可比的上次核到点`
          : `同步文档里「${CHECKED_HEAD_PLACE}」出现 ${head.count} 次（第 ${head.lines.join("、")} 行），不知道以哪一个为准`,
    };
  }
  if (!isFullSha(head.sha)) {
    return { ok: false, reason: `「${CHECKED_HEAD_PLACE}」里的 SHA 不是完整 40 位（${head.sha}）` };
  }
  return { ok: true, sha: head.sha, round: head.round };
};

// ---- the machine-readable region's own shape ----
//
// The sync doc is two regions: the part `audit:upstream` reads (between
// `<!-- machine-readable:start -->` and `<!-- machine-readable:end -->`) and the
// part it does not (everything after the end marker). The split is what makes
// the audit's answers stable — the pin block, the fixed line, the ledger and
// the comparison table are located *by shape*, so prose in the human half can
// grow without moving them.
//
// The split has a failure mode of its own, and it is silent: a second copy of
// an anchor in the human half (a second `### 核对通路账`, a second comparison
// table, a second pin block) leaves every other check green — the counts that
// would see it are exactly the ones the audit does not make — while the file
// now claims the same fact twice, and the two copies can drift apart. That is
// the mechanical form of the sentence at the top of the file: 「不要在人读区再
// 声明一次 pin、复制一轮欠账、或另起一张对照表」.
//
// So the shape is asserted rather than trusted: the two markers appear once
// each and in that order, the five anchors appear once each *inside* the
// region, and none of them appears after the end marker.
//
// The preamble (before the start marker) quotes three of the anchors on
// purpose — it is the note that tells a reader what the script locates — so it
// is deliberately outside the "exactly once" rule. The rule is about the human
// half, which is where a second copy would be a second authority.
export const MACHINE_READABLE_START = "<!-- machine-readable:start -->";
export const MACHINE_READABLE_END = "<!-- machine-readable:end -->";

// The anchors the machine-readable region must carry — each exactly once, and
// none of them again in the human-readable region.
//
// A `marker` anchor is a literal string. The fixed line is matched by its pin
// *shape* instead (the same rule `findDocPins` uses), so the heading that
// merely names the line does not count as the line, and a prose mention
// without a SHA does not count either.
export const MACHINE_READABLE_ANCHORS = Object.freeze([
  { name: "pin 块起点", marker: PIN_BLOCK_START },
  { name: "pin 块终点", marker: PIN_BLOCK_END },
  { name: "本轮 HEAD 核对 固定行", where: FIXED_LINE_PLACE },
  { name: "核到的上游 HEAD 固定行", where: CHECKED_HEAD_PLACE },
  { name: "核对通路账 标题", marker: "### 核对通路账" },
  { name: "对照表 表头", marker: TABLE_HEADER },
]);

// The 1-based document lines one anchor sits on, inside the given lines.
// A `where` anchor is a pin shape: only the line that really declares the pin
// counts, never a heading that mentions it.
const anchorLines = (lines, anchor) => {
  const hits = [];
  (lines || []).forEach((line, index) => {
    if (anchor.marker) {
      if (line.includes(anchor.marker)) hits.push(index + 1);
      return;
    }
    // Two declaration shapes live in this region: the pin (three places, all
    // equal to `PINNED_UPSTREAM.sha`) and the last checked HEAD (one place, which
    // is a different fact and therefore must not be read as a pin). They are
    // matched by the same rule so an anchor can name either.
    const hit = matchPinShape(line) || matchCheckedHeadShape(line);
    if (hit && hit.where === anchor.where) hits.push(index + 1);
  });
  return hits;
};

// The rule as violations. Empty is the only acceptable answer for the real
// sync doc; each entry names the line, because "the region's shape is wrong"
// sends the reader to a 240-line diff.
export const machineReadableBlockViolations = (doc) => {
  const violations = [];
  const lines = String(doc || "").split(/\r?\n/);

  const markerLines = (marker) => {
    const found = [];
    lines.forEach((line, index) => {
      if (line.includes(marker)) found.push(index + 1);
    });
    return found;
  };

  const startAt = markerLines(MACHINE_READABLE_START);
  const endAt = markerLines(MACHINE_READABLE_END);

  for (const [marker, found] of [
    [MACHINE_READABLE_START, startAt],
    [MACHINE_READABLE_END, endAt],
  ]) {
    if (found.length !== 1) {
      violations.push(
        `机器可读区标记 \`${marker}\` 出现 ${found.length} 次（应为 1 次）：` +
          (found.length ? `第 ${found.join("、")} 行` : "找不到")
      );
    }
  }
  // Without exactly one marker of each kind there is no single region to talk
  // about, so the anchor checks below are skipped rather than reporting "0
  // times" for every anchor — that would be true, but explained by the wrong
  // cause, and the reader would go looking for five missing anchors instead of
  // the one duplicated marker that caused it.
  if (startAt.length !== 1 || endAt.length !== 1) return violations;

  if (startAt[0] > endAt[0]) {
    violations.push(
      `机器可读区的起点（第 ${startAt[0]} 行）在终点（第 ${endAt[0]} 行）之后，顺序颠倒`
    );
    return violations;
  }

  // The region is the lines strictly between the two markers; the human half
  // is everything after the end marker. The offsets turn a position inside a
  // slice back into a document line.
  const inside = lines.slice(startAt[0], endAt[0] - 1);
  const after = lines.slice(endAt[0]);

  for (const anchor of MACHINE_READABLE_ANCHORS) {
    const insideHits = anchorLines(inside, anchor);
    if (insideHits.length !== 1) {
      violations.push(
        `机器可读区里的「${anchor.name}」出现 ${insideHits.length} 次（应为 1 次）：` +
          (insideHits.length ? `第 ${insideHits.map((n) => n + startAt[0]).join("、")} 行` : "找不到")
      );
    }
    const afterHits = anchorLines(after, anchor);
    if (afterHits.length > 0) {
      violations.push(
        `「${anchor.name}」在人读区里又出现 ${afterHits.length} 次：` +
          `第 ${afterHits.map((n) => n + endAt[0]).join("、")} 行——人读区不得复制机器可读区的锚点`
      );
    }
  }

  return violations;
};

// ---- the human half keeps one round, and points at the archive for the rest ----
//
// The file states its own scope at the top: 「逐轮正文归档在 upstream-history.md，
// 本文件只留当前一轮」. Until this rule existed that was only prose — the human half
// carried the *previous* round's full body as a `## 上一轮（第 N 轮…）` section, which
// is the same narrative the archive already holds. A body living in two files is
// the failure the archive's own rule exists to prevent, one level up: the copy
// nobody updates keeps reading like the current answer, and "which round wrote
// this sentence" needs a diff to answer.
//
// So the shape is asserted instead of trusted, and it is checked on the human
// half only (the machine-readable region is the other check's business):
//
//   - no `## 上一轮（第 N 轮…）` heading — a previous round's body belongs in the
//     archive, and a heading is what makes a body a body;
//   - exactly one pointer sentence, because a file that simply dropped the
//     mention would satisfy "no second body" while leaving the reader with no way
//     to find the previous round;
//   - that pointer must name a round the archive really has, with the anchor of
//     *that* section — a pointer to a round that was never archived, or to a
//     rewritten heading's old slug, lands at the top of the archive file, which
//     looks like a successful click and goes to the wrong place.
//
// The anchor is compared, not trusted, for the second reason: the slug is
// computed from the heading by GitHub's rules (lowercase, punctuation dropped,
// spaces to hyphens), so a heading edited next round does not silently break the
// link — this check goes red instead.
export const PREVIOUS_ROUND_HEADING = /^#{2,4}\s*上一轮（第\s*(\d+)\s*轮/;
export const PREVIOUS_ROUND_POINTER =
  /上一轮（第\s*(\d+)\s*轮）的正文见\s*\[`?upstream-history\.md`?\]\(upstream-history\.md#([^)\s]+)\)/;

// The anchor GitHub gives a heading: lowercase, punctuation dropped, spaces to
// hyphens, letters/digits (any script) kept. Written out rather than imported so
// the rule the pointer is checked against is the rule the reader's browser uses,
// and it is asserted against a real heading in the smoke test.
export const headingSlug = (heading) =>
  String(heading == null ? "" : heading)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");

// The rule as violations. Empty is the only acceptable answer for the real sync
// doc; each entry names the line, because "the human half is the wrong shape"
// sends the reader to a 300-line diff.
export const previousRoundPointerViolations = (doc, historyDoc = "") => {
  const violations = [];
  const lines = String(doc || "").split(/\r?\n/);
  const markerLines = (marker) => {
    const found = [];
    lines.forEach((line, index) => {
      if (line.includes(marker)) found.push(index + 1);
    });
    return found;
  };
  const startAt = markerLines(MACHINE_READABLE_START);
  const endAt = markerLines(MACHINE_READABLE_END);
  // Where the human half starts is `machineReadableBlockViolations`'s question.
  // Answering it here too would report the same broken file twice, with the
  // second copy pointing at the wrong cause.
  if (startAt.length !== 1 || endAt.length !== 1 || startAt[0] > endAt[0]) return violations;

  const after = lines.slice(endAt[0]);
  // A position inside `after` turned back into a document line.
  const at = (index) => index + endAt[0] + 1;

  after.forEach((line, index) => {
    const hit = PREVIOUS_ROUND_HEADING.exec(line);
    if (hit) {
      violations.push(
        `第 ${at(index)} 行：人读区里又起了一段「上一轮（第 ${hit[1]} 轮）」的正文——` +
          `逐轮正文属于 ${UPSTREAM_HISTORY_DOC}，本文件只留一个指针句`
      );
    }
  });

  const pointers = [];
  after.forEach((line, index) => {
    const hit = PREVIOUS_ROUND_POINTER.exec(line);
    if (hit) pointers.push({ line: at(index), round: Number(hit[1]), anchor: hit[2] });
  });
  if (pointers.length !== 1) {
    violations.push(
      `人读区的「上一轮」指针出现 ${pointers.length} 次（应为 1 次）：` +
        (pointers.length
          ? `第 ${pointers.map((pointer) => pointer.line).join("、")} 行`
          : "找不到——上一轮的正文归档了，但没有任何一行指过去")
    );
    return violations;
  }

  const [pointer] = pointers;
  const sections = historySections(historyDoc);
  const target = sections.find((section) => section.round === pointer.round);
  if (!target) {
    violations.push(
      `第 ${pointer.line} 行：指针说的是第 ${pointer.round} 轮，` +
        `而 ${UPSTREAM_HISTORY_DOC} 里没有这一轮的段落` +
        `（有 ${sections.filter((section) => section.round !== null).map((section) => section.round).join("、")}）`
    );
    return violations;
  }
  // `historySections` records the heading *line number*; the slug is computed
  // from that line of the archive itself, because the heading text is what a
  // reader clicks, not a copy of it kept here.
  const headingText = String(historyDoc).split(/\r?\n/)[target.line - 1] || "";
  const want = headingSlug(headingText);
  if (pointer.anchor !== want) {
    violations.push(
      `第 ${pointer.line} 行：指针的锚点 \`#${pointer.anchor}\` 不是 ` +
        `${UPSTREAM_HISTORY_DOC} 第 ${target.line} 行标题的锚点 \`#${want}\`，` +
        "点过去会落到归档文件顶部而不是那一轮"
    );
  }
  return violations;
};

// ---- the human half opens with the rules for editing it ----
//
// The rules that keep this file auditable live in three places (the anchor
// shapes, the ledger's binding to the commit subject, and the archive's append
// rule) — and a person opening the doc to record a round meets none of them:
// they open the doc, not this module. "Read `tools/upstream-watch.mjs`" is not
// an entry point for a first edit. So the human half has to open with a short
// checklist, and the checklist itself is asserted to exist.
//
// The checklist is split in two because it used to answer two different readers
// with one voice. A person adding a round needs the editing conventions (one
// round here, append-only archive, a ledger row every round). The rest of the
// old list was a *description of this module's constants* — the anchor shapes,
// "pins live in exactly three places", "do not copy anchor literals" — which a
// reader only needs once the audit is already red, and which this module is the
// authoritative copy of. Repeating them in prose is a second copy that can go
// stale while the checker stays green.
//
// So the second subsection is a pointer, and only the pointer is asserted: it
// must name this module, so a reader sent there finds the constants. The literal
// anchors stay *forbidden* in the human half (a copy would be a second
// authority), which is why the pointer names code rather than quoting shapes.
export const AUTHORING_RULES_HEADING = "## 改这份文档之前";
export const AUTHORING_HUMAN_HEADING = "### 给人读的编辑约定";
export const AUTHORING_SCRIPT_HEADING = "### 给 audit:upstream 看的约束";
export const AUTHORING_SCRIPT_POINTER = "tools/upstream-watch.mjs";
// The human list is deliberately short: each entry is a thing a person does to
// this file. Script-enforced shapes belong to the other subsection and are
// counted by the checks themselves, not by a checklist that could shrink.
export const AUTHORING_RULES_MIN = 3;

const headingBounds = (lines, heading) => {
  const at = lines.findIndex((line) => line.trim().startsWith(heading));
  if (at === -1) return null;
  let end = lines.length;
  for (let index = at + 1; index < lines.length; index += 1) {
    // The parent section owns its `###` subsections, so only a heading at the
    // parent's own level (or above) closes it.
    if (/^#{1,2}\s/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { at, end };
};

// A subsection has to appear exactly once: `findIndex` alone would accept a
// second copy, which is the "two copies of one rule" failure this split exists
// to avoid.
const headingCount = (lines, heading) =>
  lines.filter((line) => line.trim().startsWith(heading)).length;

export const docAuthoringRuleViolations = (doc) => {
  const lines = String(doc || "").split(/\r?\n/);
  // The human half starts after the end marker; the marker's own count is
  // `machineReadableBlockViolations`'s question, so a missing end marker is
  // answered there rather than reported twice with the wrong cause.
  const endAt = lines.findIndex((line) => line.includes(MACHINE_READABLE_END)) + 1;
  if (endAt === 0) return [];

  const human = lines.slice(endAt);
  const name = AUTHORING_RULES_HEADING.replace(/^##\s*/, "");
  const parent = headingBounds(human, AUTHORING_RULES_HEADING);
  if (!parent) {
    return [`人读区没有「${name}」一节：改这份文档的人在 audit 脚本之外找不到规则入口`];
  }

  const violations = [];
  const body = human.slice(parent.at + 1, parent.end);
  const humanName = AUTHORING_HUMAN_HEADING.replace(/^###\s*/, "");
  const scriptName = AUTHORING_SCRIPT_HEADING.replace(/^###\s*/, "");

  for (const [heading, label] of [
    [AUTHORING_HUMAN_HEADING, humanName],
    [AUTHORING_SCRIPT_HEADING, scriptName],
  ]) {
    const count = headingCount(body, heading);
    if (count === 0) {
      violations.push(
        `「${name}」缺少「${label}」小节：人读的约定与脚本执行的约束是两类，` +
          "混在一张清单里时，其中一类会先失去维护"
      );
    } else if (count > 1) {
      violations.push(
        `「${name}」里「${label}」出现了 ${count} 次：规则只写一份，第二份是没人核对的那一份`
      );
    }
  }

  const humanAt = body.findIndex((line) => line.trim().startsWith(AUTHORING_HUMAN_HEADING));
  const scriptAt = body.findIndex((line) => line.trim().startsWith(AUTHORING_SCRIPT_HEADING));
  if (humanAt !== -1 && scriptAt !== -1 && humanAt > scriptAt) {
    violations.push(
      `「${name}」的两个小节顺序颠倒：先写「${humanName}」，再写「${scriptName}」——` +
        "人先看到自己要做的事，脚本约束只是指针"
    );
  }

  if (humanAt !== -1) {
    const end = scriptAt !== -1 && scriptAt > humanAt ? scriptAt : body.length;
    const rules = body
      .slice(humanAt + 1, end)
      .filter((line) => /^\s*\d+\.\s*\S/.test(line)).length;
    if (rules < AUTHORING_RULES_MIN) {
      violations.push(
        `「${humanName}」只有 ${rules} 条编号规则（至少 ${AUTHORING_RULES_MIN} 条）：` +
          "编辑约定不能缩成一句，否则新写文档的人仍要读脚本"
      );
    }
  }

  if (scriptAt !== -1) {
    const text = body.slice(scriptAt + 1).join("\n");
    if (!text.includes(AUTHORING_SCRIPT_POINTER)) {
      violations.push(
        `「${scriptName}」没有指向 \`${AUTHORING_SCRIPT_POINTER}\`：脚本约束的权威定义在代码里，` +
          "这里只该是一个指针；指针丢了，读者要么照抄一份会过期的规则，要么猜"
      );
    }
  }

  const stateAt = human.findIndex((line) => /^##\s*当前状态（/.test(line));
  if (stateAt !== -1 && parent.at > stateAt) {
    violations.push(
      `「${name}」在第 ${endAt + parent.at + 1} 行，落在当前状态（第 ${endAt + stateAt + 1} 行）之后：` +
        "这一节要在人读区开头，改文档的人先看到规则"
    );
  }
  return violations;
};

// ---- how the ledger is read, in one place ----
//
// The smoke test needs the ledger's rows (通路 / 欠账 是否配套), and the rule
// below needs the round the ledger stops at. Two readers of one table, so the
// table is parsed once, here: the second copy of "rows between 「核对通路账」 and
// the next `###`" is how the two answers start disagreeing about which rows
// exist at all.
export const LEDGER_HEADING = "### 核对通路账";

// A ledger row, as one regex, because two spellings of "looks like a row" is
// how `ledgerRowsIn` and the contiguity rule below start disagreeing about
// which lines are in the table at all.
const LEDGER_ROW = /^\|\s*(\d+)\s*\|/;

// The ledger's own line span: from its heading to the next heading, as
// `[start, end)` document indexes, or `null` when the doc has no ledger.
const ledgerRegionOf = (doc) => {
  const lines = String(doc == null ? "" : doc).split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().startsWith(LEDGER_HEADING));
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,4}\s/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { lines, start, end };
};

// The ledger's rows as cell arrays, in document order. `""` (or a doc without
// that heading) yields no rows rather than rows borrowed from another table.
export const ledgerRowsIn = (doc) => {
  const region = ledgerRegionOf(doc);
  if (region === null) return [];
  return region.lines
    .slice(region.start, region.end)
    .filter((line) => LEDGER_ROW.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
};

// ---- one blank line ends the table the reader sees, but not the one we parse ----
//
// `ledgerRowsIn` scans the region for lines that look like rows, so it reads
// *through* a blank line and keeps counting. Markdown does not: GFM ends a table
// at the first blank line, and what follows has no header row, so those rows
// render as a paragraph of literal pipes. The two answers differ by exactly the
// rows below the blank — and the audit is the one that stays green.
//
// 第 102 轮 shipped this shape: rows 101 and 102 sat on either side of a blank
// line, `audit:upstream` counted both, the 「当前状态」 binding passed, and the
// page GitHub rendered stopped at 101 with 102 printed as text. Nothing was
// wrong except the document.
//
// So the blank line is checked where the parser cannot see its effect: strictly
// between the ledger's first and last row. A blank line before the header or
// after the final row is ordinary Markdown (it is what ends the table) and is
// not this rule's question, and the other tables in this region belong to other
// rules — a region-wide "no blank lines anywhere" would flag prose spacing and
// teach whoever sees it to ignore the message.
export const ledgerTableViolations = (doc) => {
  const region = ledgerRegionOf(doc);
  if (region === null) return [];
  const { lines, start, end } = region;

  const rows = [];
  for (let index = start; index < end; index += 1) {
    const hit = LEDGER_ROW.exec(lines[index]);
    if (hit) rows.push({ index, round: Number(hit[1]) });
  }
  if (rows.length === 0) return [];
  // The table starts at its header, not at its first data row: a blank line
  // between the header and the body is the same failure one level up — the
  // reader loses *every* row, while the parser still counts them all.
  const tableStart = lines
    .slice(start, end)
    .findIndex((line) => line.trim().startsWith("|"));
  const header = tableStart === -1 ? rows[0].index : start + tableStart;

  const violations = [];
  const last = rows[rows.length - 1].index;
  let cursor = header + 1;
  while (cursor < last) {
    if (lines[cursor].trim() !== "") {
      cursor += 1;
      continue;
    }
    const blankStart = cursor;
    while (cursor < last && lines[cursor].trim() === "") cursor += 1;
    const above = rows.filter((row) => row.index < blankStart);
    const below = rows.filter((row) => row.index >= cursor);
    const where = blankStart === cursor - 1 ? `第 ${blankStart + 1} 行` : `第 ${blankStart + 1}–${cursor} 行`;
    const aboveText = above.length
      ? `上面读到第 ${above[above.length - 1].round} 轮`
      : "上面只剩表头，一行正文都读不到";
    violations.push(
      `核对通路账的表格被${where}空行截断：${aboveText}，下面第 ${below[0].round}–${below[below.length - 1].round} 轮` +
        `共 ${below.length} 行 Markdown 不再渲染成表格（空行结束这张表，后面的行没有表头，成了正文里的竖线）；` +
        "而 ledgerRowsIn 跨过空行，照常数到它们——audit 数到的和读者看到的是两张表。" +
        "把表格中间的这一行删掉（表前表后的空行是正常收尾，不用动）"
    );
  }
  return violations;
};

// ---- the human half's sections are counted, not assumed ----
//
// Every rule above asks the human half for one *thing it must contain*: the
// editing checklist, one pointer, a current-state body ending in a full
// sentence. None of them asks whether a section is still there at all. Delete
// `## 关系` and the pins, the ledger, the table, the checklist all stay exactly
// as they were — the audit reports full marks on a file that lost the one place
// answering "which repository is which". Demote it to `###`, or paste it twice,
// and nothing says so either; a second copy of 「规则」 is precisely the
// "one rule living in two places" failure this doc's append-only rule exists to
// prevent, one level up.
//
// The four names are the sections a reader needs in order to orient: where the
// two repos live, what each round owes, what the answer is *now*, and how to edit
// the file. The rest of the human half (`## 上游真变了怎么办`, `## 建议命令`) is
// prose a reader can find by scrolling, and renaming it breaks no entry point —
// so it is deliberately not in this list, which is a floor, not a table of
// contents.
//
// The second question is which round the current-state section is. 「当前状态」
// whose body still belongs to an earlier round reads like this round's answer:
// the truncation rule cannot see it (the body is complete prose, just stale) and
// the fixed line's round is already pinned to the ledger. 第 97 轮 slipped this
// way — the ledger gained a row, the section kept 第 96 轮's text, and both
// halves were internally consistent.
export const HUMAN_SECTIONS = Object.freeze([
  { name: "关系", why: "上游仓库与本仓仓库在这里区分，读者第一个要问的就是「哪个是哪个」" },
  { name: "规则", why: "每轮核对上游要做什么，这里是人读侧唯一的入口" },
  { name: "当前状态", why: "本轮的结论（pin 在哪、上游动了没有）写在这一节，别处不算" },
  { name: "改这份文档之前", why: "改这个文件的人在 audit 脚本之外唯一能找到的规则清单" },
]);

export const humanSectionViolations = (doc) => {
  const lines = String(doc == null ? "" : doc).split(/\r?\n/);
  const endAt = lines.findIndex((line) => line.includes(MACHINE_READABLE_END));
  // Where the human half starts is `machineReadableBlockViolations`'s question:
  // a missing or duplicated end marker is answered there, with the marker's line
  // numbers, rather than reported a second time here as "four sections missing".
  if (endAt === -1) return [];

  const human = lines.slice(endAt + 1);
  // A position inside `human` turned back into a document line.
  const at = (index) => index + endAt + 2;
  const headingPattern = (name) => new RegExp(`^##\\s*${name}(?=[\\s（(]|$)`);
  const linesNamed = (name) => {
    const pattern = headingPattern(name);
    const found = [];
    human.forEach((line, index) => {
      if (pattern.test(line.trim())) found.push(at(index));
    });
    return found;
  };

  const violations = [];
  for (const section of HUMAN_SECTIONS) {
    const found = linesNamed(section.name);
    if (found.length === 1) continue;
    if (found.length === 0) {
      // The heading may still exist on the other side of the end marker: that is
      // a section that moved into the machine-readable region, and it reads
      // nothing like "someone deleted it".
      const elsewhere = [];
      const pattern = headingPattern(section.name);
      lines.slice(0, endAt + 1).forEach((line, index) => {
        if (pattern.test(line.trim())) elsewhere.push(index + 1);
      });
      violations.push(
        `人读区没有「## ${section.name}」一节（应为恰好 1 次）：${section.why}。` +
          (elsewhere.length
            ? `它在机器可读区里（第 ${elsewhere.join("、")} 行）——整节被搬进给 audit 读的那一半，人读区就空了`
            : "整节不见了，而这一节的内容没有别处可以代替")
      );
      continue;
    }
    violations.push(
      `人读区里「## ${section.name}」出现 ${found.length} 次（应为 1 次）：第 ${found.join("、")} 行——` +
        `「${section.name}」只该有一份，第二份是哪一份过期了没人说得清`
    );
  }

  // The current-state section's round against the ledger's last row. Only asked
  // when both are readable: a missing heading is the loop's answer, an empty
  // ledger is the smoke test's, and guessing here would report the wrong cause.
  const stateLine = human.find((line) => headingPattern("当前状态").test(line.trim())) || "";
  const stateRound = /第\s*(\d+)\s*轮/.exec(stateLine);
  const ledgerRounds = ledgerRowsIn(lines.join("\n")).map((row) => Number(row[0]));
  const lastLedger = ledgerRounds.length ? ledgerRounds[ledgerRounds.length - 1] : null;
  if (stateRound && lastLedger !== null && Number(stateRound[1]) !== lastLedger) {
    violations.push(
      `「当前状态」标题停在第 ${stateRound[1]} 轮，通路账末行已到第 ${lastLedger} 轮：` +
        "标题写着较旧的一轮，正文也就是那一轮的，读者却会把它当成本轮的结论——" +
        "本轮正文写完后，把上一轮整段搬到归档"
    );
  }

  return violations;
};

// ---- a truncated document must not read as a finished one ----
//
// Every other check in this module reads the doc for a *shape it wants*: three
// pin declarations, one pointer, a table with headers, one current-state
// section. None of them notices a file that simply stops. Cut this doc in half
// mid-paragraph and the pin, the ledger and the table are all still there — the
// audit stays green while the last thing a reader sees is half a sentence,
// which is the one failure that looks like an editorial choice.
//
// Three fingerprints of truncation, each answered with a line number:
//
//   - a fenced code block left open — the cut landed inside a block, and
//     everything after it renders as code;
//   - the last non-empty line ends where no sentence ends: an ending that is
//     only a connector (`：`, `、`, `，`, `-`) or an unclosed inline code span.
//     A heading as the last line counts here too: a section with no body is the
//     same shape as a cut right after the heading;
//   - the current-state section has no complete sentence in its body. This is
//     the section every round rewrites, so it is the one a bad paste shortens
//     most often, and "the heading is there" was already checked by another
//     rule — the body was not.
//
// The rule is deliberately about the *end* of the document, not about length:
// a short doc is legitimate, a half-written last line is not.
//
// A document that ends on a table is the case that forced a fifth answer: read
// as a plain last line, `| 发版 | tools/release.mjs |` ends on the connector
// `|`, so a perfectly finished doc was reported as truncated. The trailing pipe
// of a table row *is* the terminator, so a complete row is a finished line —
// and a row that lost its closing pipe is the truncated shape, reported as its
// own fingerprint rather than as a mysterious dangling `|`.
export const DANGLING_LINE_ENDINGS = Object.freeze(["-", ":", "：", ",", "，", "、", "…", "(", "（", "/", "|", "\\"]);

// The current state's own body — the section every round rewrites. `null` when
// the doc has no such section, so this rule can be asked of the archive too,
// which legitimately has none.
const currentStateBody = (lines) => {
  const at = lines.findIndex((line) => /^##\s*当前状态（/.test(line));
  if (at === -1) return null;
  let end = lines.length;
  for (let index = at + 1; index < lines.length; index += 1) {
    if (/^#{1,2}\s/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { line: at + 1, body: lines.slice(at + 1, end) };
};

export const docTruncationViolations = (doc) => {
  const lines = String(doc == null ? "" : doc).split(/\r?\n/);
  const violations = [];

  // Fences, by count: an odd number means one was cut off *or* never closed,
  // and the sentence names the opening line so the reader does not have to
  // count fences to find it.
  const fences = [];
  lines.forEach((line, index) => {
    if (line.trim().startsWith("```")) fences.push(index + 1);
  });
  if (fences.length % 2 === 1) {
    violations.push(
      `第 ${fences[fences.length - 1]} 行打开了代码围栏却没有闭合：` +
        `共 ${fences.length} 行围栏（应为偶数），文档在这里被截断，或围栏丢了结尾`
    );
  }

  // The last line that is not blank: what a reader's eye ends on.
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === "") last -= 1;
  if (last < 0) {
    violations.push("文档是空的：没有任何一行可以读，也就没有任何一轮的结论留下");
    return violations;
  }
  const lastLine = lines[last].trim();
  // A table row is finished by its own trailing pipe, and unfinished when that
  // pipe is missing — the row is then still open, which is what a cut inside a
  // table looks like.
  const tableRow = lastLine.startsWith("|");
  const tableRowClosed = /^\|.*\|$/.test(lastLine);
  if (/^#{1,6}\s/.test(lastLine)) {
    violations.push(
      `第 ${last + 1} 行是文档的最后一行，而它是个标题（${lastLine}）：` +
        "标题之后没有正文，和「截断正好落在标题后」是同一个形状"
    );
  } else if (tableRow && !tableRowClosed) {
    violations.push(
      `第 ${last + 1} 行是文档的最后一行，是一行没有收尾的表格（${lastLine}）：` +
        "表格行要以「|」结束，缺了它就是这张表在最后一行被截断"
    );
  } else if (tableRowClosed) {
    // Nothing to report: the row is complete. (Its cells are checked by the
    // table-shape rules elsewhere; this rule only says the document did not
    // stop in the middle of a line.)
  } else {
    const dangling = DANGLING_LINE_ENDINGS.find((ending) => lastLine.endsWith(ending));
    // Inline code spans are counted per line (fence lines are excluded by the
    // caller never getting here: a fence line ends with three backticks, which
    // is odd — so only non-fence lines are asked).
    const ticks = (lastLine.match(/`/g) || []).length;
    if (dangling !== undefined) {
      violations.push(
        `第 ${last + 1} 行是文档的最后一行，却停在「${dangling}」上：` +
          "句子没有写完，文档像是被截断的（最后一行要以句末标点收尾）"
      );
    } else if (!lastLine.startsWith("```") && ticks % 2 === 1) {
      violations.push(
        `第 ${last + 1} 行是文档的最后一行，却留下了一个没闭合的行内代码（反引号 ${ticks} 个）：` +
          "最后一行没有写完"
      );
    }
  }

  // The body the current round rewrites.
  const state = currentStateBody(lines);
  if (state !== null) {
    const body = state.body;
    const prose = body.map((line) => line.trim()).filter((line) => line !== "");
    const complete = prose.some((line) => /[。.]$/.test(line));
    if (prose.length === 0) {
      violations.push(
        `「当前状态」一节（第 ${state.line} 行）没有正文：标题在、内容不在——` +
          "本轮核对结论必须写进去，哪怕结论是「无新内容」"
      );
    } else if (!complete) {
      violations.push(
        `「当前状态」一节（第 ${state.line} 行）没有一句以句末标点收尾的话：` +
          "正文写了一半，读起来像写完了一样"
      );
    }
  }

  return violations;
};

// ---- the same rule, now aimed at every document a README points at ----
//
// The truncation rule above was only ever applied to the two files this module
// owns, and that was one file short of what it promised: `README.md` shipped
// with a half-written line in its architecture block (`main.js  Elec`) for
// rounds, and nothing was red — the rule that would have caught it existed and
// was simply never asked. The rule does not care which document it reads, so
// the only thing missing was the list of documents.
//
// The list is derived, not typed: every relative `*.md` a README links to is a
// document a stranger is one click from, so each one must exist and must close.
// READMEs are asked about themselves too — they are pointed at by the repository
// page, and the truncation that started this was in one of them.
//
// Two-step on purpose: `docPointers` answers *which* files, `productDocViolations`
// answers whether they are whole. The smoke test can then go red for a lost
// pointer and for a truncated target separately, instead of one check that
// cannot say which half broke.
export const README_FILES = Object.freeze(["README.md", "README.zh-CN.md"]);

export const docPointers = (markdown) => {
  const pointers = [];
  String(markdown == null ? "" : markdown)
    .split(/\r?\n/)
    .forEach((line, index) => {
      // `[label](path.md)` and `[label](path.md#anchor)`; external links are not
      // ours to read, and a bare `<a href>` is not how these documents link.
      const re = /\]\(([^)\s]+\.md)(?:#[^)]*)?\)/g;
      let match = re.exec(line);
      while (match !== null) {
        const target = match[1];
        const external = /^(?:[a-z]+:)?\/\//i.test(target);
        if (!external && !pointers.some((p) => p.target === target)) {
          pointers.push({ target, line: index + 1 });
        }
        match = re.exec(line);
      }
    });
  return pointers;
};

/**
 * Every document a README points at must exist and must be closed.
 *
 * `readmes` is `[{ path, text }]` — the path is only used to name the source in
 * a violation, so a mutated copy is checked exactly like the real file.
 * `readFile(target)` returns the target's text, or `null` when it is missing;
 * injecting it keeps this pure and lets the smoke test hand in a broken target.
 *
 * A target reached from two READMEs is checked once and named with both sources:
 * the document is the same file, and printing the same defect twice reads like
 * two bugs.
 */
export const productDocViolations = (readmes, readFile) => {
  const violations = [];
  const sources = new Map();

  for (const { path: source, text } of readmes) {
    for (const violation of docTruncationViolations(text)) {
      violations.push(`${source}：${violation}`);
    }
    for (const pointer of docPointers(text)) {
      const seen = sources.get(pointer.target);
      if (seen === undefined) sources.set(pointer.target, [source]);
      else if (!seen.includes(source)) seen.push(source);
    }
  }

  for (const [target, from] of sources) {
    const who = `${from.join(" / ")} 指向「${target}」`;
    const text = readFile(target);
    if (text === null || text === undefined) {
      violations.push(`${who}，但文件不存在：读者点下去是 404`);
      continue;
    }
    for (const violation of docTruncationViolations(text)) {
      violations.push(`${who}：${violation}`);
    }
  }

  return violations;
};

// ---- the first screen answers "what is this", not "what does it do" ----
//
// Both READMEs used to open with the wrapping ("An unofficial cross-platform
// desktop GUI for …", 「…的**非官方**桌面界面」) and then about eighteen
// verification bullets, so a stranger's first screen was an implementation note
// followed by a changelog. The product story — what this is, who it is for, and
// what it does that the terminal does not — sat three sections down, and the
// bullets a reader needs first were the ones they met last.
//
// Prose cannot be asserted, but its *shape* can, and the shape is what drifted:
// a one-sentence greeting, no CLI flags in it, a short list of things a user can
// feel, and the long record sunk into a section that the short list links to.
// That last part is the one that rots quietly — "everything verified is listed
// under X" reads fine for as long as nobody checks that X still holds the list.
//
//   1. 首段一句话 — the paragraph under the title is exactly one sentence. A
//      second sentence in that paragraph is a summary, and a summary is what the
//      list below it was for.
//   2. 首段不提参数 — no `--flag`. A first screen that names `--preview` is
//      written for someone who already knows the CLI.
//   3. 首段不说「封装」 — no "wrapper" / 「封装」: "a wrapper for X" answers how
//      this is built, not what it is for. The build detail stays in the README,
//      one paragraph down; it just stops being the greeting.
//   4. 首屏 3–5 条，长清单有去处 — the first `##` section keeps 3–5 bullets and
//      links to an anchor in the same document, and that section still holds the
//      long record (≥ 8 bullets). Without the floor the "sink" is a promise
//      pointing at a heading whose list was deleted.
//   5. 平台矩阵不在首屏 — no architecture name (`x64`), no package format
//      (`dmg`, `AppImage`, `.deb`, `.exe`), no bullet per platform, anywhere in
//      that first section. Each of those is a fact about *how this was built and
//      tested*, and the first screen was spending two of its paragraphs on them
//      while the same record sits complete under Known limitations. "Which
//      platform is verified to what depth" belongs there; what belongs here is
//      where you can run this and how sure it is.
const OPENING_FLAGS = /--[A-Za-z][\w-]*/;
const OPENING_WRAPPER_TERMS = Object.freeze(["wrapper", "封装", "gui for"]);
const OPENING_FIRST_BULLETS = Object.freeze([3, 5]);
const SINK_MIN_BULLETS = 8;
// Architecture and package-format names: the two things a reader of the first
// screen cannot use, because they only mean something once you are choosing a
// download. `.exe` / `.deb` are matched on the dot so a sentence about "the exe
// you ran" is not this rule's business while `*-setup.exe` is.
const OPENING_MATRIX_TOKEN = /(?:\b(?:x64|x86_64|arm64|aarch64|dmg|AppImage)\b|\.debs?\b|\.exes?\b)/i;
// Only asked of list items: "Windows: …" as a bullet is the matrix in its most
// readable form, and prose that names one platform to say where the app runs is
// what rule 5 asks *for*.
const OPENING_PLATFORM_NAME = /(?:\bWindows\b|\bmacOS\b|\bMac OS\b|\bLinux\b)/i;

const isBullet = (line) => /^\s*[-*+]\s+/.test(line);
const level = (line) => {
  const match = /^(#{1,6})\s+/.exec(line);
  return match ? match[1].length : 0;
};

/** The paragraph directly under the document's first `#` heading: the greeting,
 *  with the blank lines around it dropped and nothing else. */
const openingParagraph = (lines) => {
  const title = lines.findIndex((line) => level(line) === 1);
  if (title === -1) return null;
  let start = title + 1;
  while (start < lines.length && !lines[start].trim()) start += 1;
  const paragraph = [];
  let index = start;
  while (index < lines.length && lines[index].trim()) {
    paragraph.push(lines[index]);
    index += 1;
  }
  return paragraph.length ? { line: start + 1, text: paragraph.join("\n") } : null;
};

/** The first `##` section (the status block) and the `##` section its anchor
 *  points at. `null` when the document has no such section. */
const statusSection = (lines) => {
  const start = lines.findIndex((line) => level(line) === 2);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && level(lines[end]) !== 2) end += 1;
  return { start, end, heading: lines[start], body: lines.slice(start + 1, end) };
};

const sectionBySlug = (lines, slug) =>
  lines.reduce((found, line, index) => {
    if (found !== -1 || level(line) !== 2) return found;
    return headingSlug(line) === slug ? index : found;
  }, -1);

/**
 * The shape of the first screen, per document. `readmes` is `[{ path, text }]`,
 * the same input as `productDocViolations`, so the smoke test can hand in a
 * mutated copy and get the sentence this rule would print for the real file.
 */
export const firstScreenViolations = (readmes) => {
  const violations = [];

  for (const { path: source, text } of readmes) {
    const lines = String(text == null ? "" : text).split(/\r?\n/);

    // 1–3. the greeting.
    const opening = openingParagraph(lines);
    if (opening === null) {
      violations.push(`${source}：标题下面没有一句话说明这是什么——读者第一眼是空的`);
    } else {
      const where = `${source}：第 ${opening.line} 行`;
      const plain = opening.text
        .replace(/`[^`]*`/g, " ")
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/\]\([^)]*\)/g, "]");
      const sentenceEnds = (plain.match(/[。！？]|[.!?](?=\s|$)/g) || []).length;
      const endsSentence = /[。！？.!?]\s*$/.test(plain.trim());
      if (sentenceEnds !== 1 || !endsSentence) {
        violations.push(
          `${where}：首段不是一句话（数到 ${sentenceEnds} 个句末标点）——` +
            "第一段只回答「这是什么、给谁、强在哪」，多出来的句子属于下面的清单"
        );
      }
      // Asked of the raw line, not the stripped one: a flag inside backticks is
      // still a flag, and stripping code spans first would hide exactly the
      // shape this rule exists to refuse.
      const flag = OPENING_FLAGS.exec(opening.text);
      if (flag) {
        violations.push(
          `${where}：首段出现参数名「${flag[0]}」——` +
            "读第一屏的人还不知道这个 CLI 有哪些参数，这里该说的是会得到什么"
        );
      }
      const term = OPENING_WRAPPER_TERMS.find((word) => opening.text.toLowerCase().includes(word));
      if (term) {
        violations.push(
          `${where}：首段用「${term}」讲自己是怎么做的——` +
            "「封装了 X」回答的是实现，不是「给谁解决什么」；实现细节留在下一段"
        );
      }
      if (opening.text.split("\n").some(isBullet)) {
        violations.push(`${where}：标题下面是列表而不是一段话——首屏一句话不能靠条目拼`);
      }
    }

    // 4. the short list, and where the long one went.
    const status = statusSection(lines);
    if (status === null) {
      violations.push(`${source}：没有第一节（## 版本状态 / Status），首屏无从谈起`);
      continue;
    }
    // 5. the platform matrix, which is not a first-screen fact.
    const matrix = [];
    status.body.forEach((line, index) => {
      const where = `第 ${status.start + 2 + index} 行`;
      const token = OPENING_MATRIX_TOKEN.exec(line);
      if (token) matrix.push(`${where}「${token[0]}」`);
      else if (isBullet(line) && OPENING_PLATFORM_NAME.test(line)) matrix.push(`${where} 按平台列的一条`);
    });
    if (matrix.length) {
      violations.push(
        `${source}：首屏的「${status.heading.replace(/^#+\s*/, "")}」里出现平台验证矩阵（${matrix.join("；")}）——` +
          "第一屏要回答的是「在哪能用、跑起来多稳」；哪个平台验证到哪一层、发布面上有什么包，" +
          "Known limitations / 已知限制 那一节已经是完整记录了，写在这里读者先看到的是构建清单"
      );
    }
    const bullets = status.body.filter(isBullet).length;
    if (bullets < OPENING_FIRST_BULLETS[0] || bullets > OPENING_FIRST_BULLETS[1]) {
      violations.push(
        `${source}：第 ${status.start + 1} 行的「${status.heading.replace(/^#+\s*/, "")}」里是 ${bullets} 条，` +
          `应为 ${OPENING_FIRST_BULLETS[0]}–${OPENING_FIRST_BULLETS[1]} 条：首屏只留用户能感知的能力，长清单下沉到专门一节`
      );
    }
    const anchor = /\]\(#([^)\s]+)\)/.exec(status.body.join("\n"));
    if (anchor === null) {
      violations.push(
        `${source}：第 ${status.start + 1} 行的「${status.heading.replace(/^#+\s*/, "")}」没有指向本文件任一节的链接——` +
          "首屏的短清单必须说明长清单在哪一节，否则被下沉的正文等于消失了"
      );
      continue;
    }
    const target = sectionBySlug(lines, anchor[1]);
    if (target === -1) {
      violations.push(
        `${source}：首屏链接指向 #${anchor[1]}，但本文件没有这一节——` +
          "点下去跳不到任何地方，长清单也就没有去处了"
      );
      continue;
    }
    let targetEnd = target + 1;
    while (targetEnd < lines.length && level(lines[targetEnd]) !== 2) targetEnd += 1;
    const sunk = lines.slice(target + 1, targetEnd).filter(isBullet).length;
    if (sunk < SINK_MIN_BULLETS) {
      violations.push(
        `${source}：首屏说验证过的行为都在「${lines[target].replace(/^#+\s*/, "")}」一节，` +
          `但那一节只有 ${sunk} 条（至少该有 ${SINK_MIN_BULLETS} 条）——下沉的长清单被删掉了`
      );
    }
  }

  return violations;
};

// ---- the READMEs are read by strangers, not by the review panel ----
//
// The install section opened with "the environment this is reviewed and demoed
// on is Windows x64" / 「初审答辩环境：Windows x64」. Both sentences are true and
// both are about *us*: they name an internal occasion (a first-round defence)
// and an internal verb (demoing), so a stranger reading the install steps is
// told which audience the sentence was written for instead of what they need —
// which platform this is verified on, and which file to download.
//
// The fix is a wording change, so the rule is about wording: the two READMEs may
// not name the internal occasion. The words are refused by word rather than by
// sentence, because the way this comes back is a sentence pasted in from a
// report, and the sentence around it will be new each time.
//
// What the rule deliberately does *not* refuse is the platform fact itself:
// "verified on Windows x64" is exactly what the install section should say, and
// a rule that refused the platform name would push the honest sentence out along
// with the internal one.
export const README_INTERNAL_TERMS = Object.freeze([
  "答辩",
  "评审",
  "初审",
  "内部评审",
  "内部试用",
  "演示环境",
]);
// English side: the same occasion, written as a verb. Word-bounded so
// "demolish"-style words are not this rule's business, and case-insensitive
// because a heading may capitalise it.
export const README_INTERNAL_PATTERN = /\bdemo(?:s|ed|ing)?\b/i;

/** Internal-occasion vocabulary in the two READMEs. `readmes` is `[{ path, text }]`,
 *  the same input as `firstScreenViolations`. */
export const readmeInternalTermViolations = (readmes) => {
  const violations = [];
  for (const { path: source, text } of readmes) {
    String(text == null ? "" : text)
      .split(/\r?\n/)
      .forEach((line, index) => {
        const term = README_INTERNAL_TERMS.find((word) => line.includes(word));
        const english = README_INTERNAL_PATTERN.exec(line);
        const hit = term || (english === null ? "" : english[0]);
        if (!hit) return;
        violations.push(
          `${source}：第 ${index + 1} 行出现内部场合的说法「${hit}」——` +
            "README 的读者是第一次装这个应用的人，不是评审方；" +
            "这一句该说的是「在哪个平台上验证过、下哪个文件」，而不是这句话是写给谁看的"
        );
      });
  }
  return violations;
};

// ---- the product bar has one authority, and it has to say whose it is ----
//
// `README.md` tells contributors that the next change may only come from an
// unchecked DoD item, and points at `docs/PRODUCT-DOD.md` for the list. The file
// it pointed at still opened with "writable draft … not yet authorised into the
// live scheduler", so the two authorities disagreed about whether the bar was in
// force at all — and a bar that might not apply is not a bar.
//
// The status was settled on 2026-10-31 (locked / live). This rule keeps it
// settled: while a README points at the DoD, its header block must read as
// locked, and the draft vocabulary is refused *by word*, because the way this
// drifts back is a copy of the old header pasted in during a re-sync.
export const PRODUCT_DOD_DOC = "docs/PRODUCT-DOD.md";
export const DOD_DRAFT_TERMS = Object.freeze([
  "writable draft",
  "尚未授权",
  "未授权",
  "待授权",
  "待批准",
  "待 GIN",
  "草稿",
]);
export const DOD_LIVE_TERMS = Object.freeze(["locked", "live", "锁定"]);

/** The header block: everything before the first horizontal rule, which is where
 *  a status line lives. Asking the whole file would refuse the word "draft" in a
 *  paragraph that is legitimately about the old state. */
const dodHeader = (lines) => {
  const end = lines.findIndex((line) => /^\s*---\s*$/.test(line));
  return (end === -1 ? lines : lines.slice(0, end)).join("\n");
};

export const dodAuthorityViolations = (doc) => {
  const lines = String(doc == null ? "" : doc).split(/\r?\n/);
  const header = dodHeader(lines);
  const violations = [];

  const draft = DOD_DRAFT_TERMS.filter((term) => header.includes(term));
  if (draft.length) {
    violations.push(
      `文档头部还带着草稿字样（${draft.map((t) => `「${t}」`).join("、")}）：` +
        "README 已经把它当成生效中的过线标准，两处权威源因此互相矛盾——" +
        "过线标准只有「已锁定」和「不存在」两种状态，没有「半生效」"
    );
  }
  // The status line is the only place that has to answer it. Asking the whole
  // header passed on a sentence about `live scheduler` that says nothing about
  // this document's status — the rule then could not tell an unstated status
  // from a stated one.
  const statusLines = lines.filter((line) => /^>\s*状态[:：]/.test(line.trim()));
  if (!statusLines.some((line) => DOD_LIVE_TERMS.some((term) => line.includes(term)))) {
    violations.push(
      "「状态」一行没有写明这是已锁定 / live 的过线标准（标题里的括注不算数）：" +
        "读的人无法判断它现在算不算数，而 README 已经在拿它当唯一输入源"
    );
  }
  return violations;
};

// ---- the bar's own checkboxes: readable, and a tick has to be earned ----
//
// `dodAuthorityViolations` settles *whether* the bar is in force. It says nothing
// about the six lines that decide what the next change may be: they were plain
// `- [ ] **非官方诚实**：…` bullets, so "which items are still open" could only be
// answered by a person reading the file, and a tick could be added by anyone who
// believed the work was done. The bar is the only input to the next round, so its
// state has to be something the audit can read — and a tick has to point at a
// record inside this repository, because the coding side is not allowed to
// declare itself finished.
//
// Four rules, each with the wrong implementation it is tested against in
// `tools/upstream-watch-smoke.mjs`:
//
//   1. 稳定 ID — every checkbox line starts with `DOD-<n>：`. An item without an
//      ID cannot be referred to, and a re-sync that reorders the list silently
//      renames every item.
//   2. 状态只有两种 — `[ ]` and `[x]`. `[X]`, `[-]`, `[~]` are refused: a third
//      state is how "half done" gets in, and half done is not a state the bar has.
//   3. 勾选要有证据 — a `[x]` item must carry `证据：<仓内路径>`, and that path must
//      exist. An unchecked item must not carry one: evidence for something still
//      open is a contradiction, and it is how a tick gets pasted in later.
//   4. 清单不许缩水 — the IDs the bar was locked with must all still be there.
//      Deleting an item is the quiet way to make a bar look full.
//
// The counterpart this rule *cannot* check is the private control repo's
// next-round brief: it is not in this repository, and the sync doc says this
// repository keeps no `next-iteration.md`. So the two-way coverage the brief asks
// for is stated against the only thing both sides share — the DoD's own IDs and
// the evidence files they point at.
export const DOD_CHECKBOX_IDS = Object.freeze([
  "DOD-1",
  "DOD-2",
  "DOD-3",
  "DOD-4",
  "DOD-5",
  "DOD-6",
]);
export const DOD_EVIDENCE_MARK = "证据：";

const DOD_CHECKBOX = /^\s*[-*+]\s+\[(.)\]\s*(.*)$/;
const DOD_ITEM_ID = /^([A-Z][A-Z0-9]*-\d+)\s*[：:]\s*(.*)$/;

/** The checkbox lines of the DoD, in file order. `id` is `null` when the line
 *  carries no stable ID, which is a violation rather than a parse failure: the
 *  caller has to be able to name the line. */
export const dodChecklist = (doc) => {
  const items = [];
  String(doc == null ? "" : doc)
    .split(/\r?\n/)
    .forEach((line, index) => {
      const hit = DOD_CHECKBOX.exec(line);
      if (hit === null) return;
      const rest = hit[2].trim();
      const idHit = DOD_ITEM_ID.exec(rest);
      items.push({
        line: index + 1,
        state: hit[1],
        checked: hit[1] === "x",
        id: idHit === null ? null : idHit[1],
        text: idHit === null ? rest : idHit[2].trim(),
      });
    });
  return items;
};

/** The path written after one of the DoD's two marks, or `null`. The first token
 *  after the mark, so `证据：docs/measurements.md（第 104 轮）` reads as the file and
 *  the note after it is free text. Backticks around the path are stripped: both
 *  spellings are what a person writes.
 *
 *  One reader for both marks (`证据：` on a ticked item, `证据候选：` under any
 *  item), because two copies of "where does the path end" is how the two
 *  spellings start disagreeing about a note and the same file gets reported as
 *  existing by one rule and missing by the other. */
const dodPathAfterMark = (text, mark) => {
  const at = String(text == null ? "" : text).indexOf(mark);
  if (at === -1) return null;
  const rest = String(text).slice(at + mark.length).trim();
  const token = rest.split(/[\s（()）、，,]/)[0] || "";
  return token.replace(/^`+|`+$/g, "") || null;
};

export const dodEvidenceTarget = (text) => dodPathAfterMark(text, DOD_EVIDENCE_MARK);

export const dodCheckboxViolations = (doc, exists = () => true) => {
  const items = dodChecklist(doc);
  const violations = [];

  if (items.length === 0) {
    violations.push(
      "DoD 里一条 `- [ ]` / `- [x]` 都没有：过线标准只剩散文，" +
        "「下一刀只能从哪来」就没有可数的输入源了"
    );
    return violations;
  }

  for (const item of items) {
    if (item.id === null) {
      violations.push(
        `第 ${item.line} 行：这一条没有稳定 ID（形状 \`- [ ] DOD-1：…\`）——` +
          "没有 ID 的条目没法被引用，重排一次就等于换了一批条目"
      );
    }
    if (item.state !== " " && item.state !== "x") {
      violations.push(
        `第 ${item.line} 行：状态写成了 \`[${item.state}]\`——只有 \`[ ]\` 与 \`[x]\` 两种，` +
          "第三种状态就是「半勾」，而过线标准没有「半勾」这个状态"
      );
    }
  }

  const seenIds = new Map();
  const seenText = new Map();
  for (const item of items) {
    if (item.id !== null) {
      const first = seenIds.get(item.id);
      if (first === undefined) seenIds.set(item.id, item.line);
      else {
        violations.push(
          `第 ${item.line} 行与第 ${first} 行都叫 ${item.id}：ID 必须唯一，` +
            "否则「第 N 条还没勾」这句话指不到唯一一条"
        );
      }
    }
    const key = item.text.replace(/\s+/g, " ").trim();
    const firstText = seenText.get(key);
    if (firstText === undefined) seenText.set(key, item.line);
    else {
      violations.push(
        `第 ${item.line} 行与第 ${firstText} 行的条目正文一模一样：` +
          "两条同文的条目会让「勾了哪一条」无法回答"
      );
    }
  }

  const present = new Set(items.map((item) => item.id).filter((id) => id !== null));
  const missing = DOD_CHECKBOX_IDS.filter((id) => !present.has(id));
  if (missing.length) {
    violations.push(
      `清单里少了 ${missing.join("、")}：过线标准锁定时是 ${DOD_CHECKBOX_IDS.length} 条，` +
        "删掉一条是让清单看起来更满的最安静的办法"
    );
  }

  for (const item of items) {
    const target = dodEvidenceTarget(item.text);
    if (!item.checked) {
      if (target !== null) {
        violations.push(
          `第 ${item.line} 行：${item.id || "这一条"}还没勾，却写着「${DOD_EVIDENCE_MARK}${target}」——` +
            "没做完的条目带证据，下一步就是有人顺手把方括号改成 x"
        );
      }
      continue;
    }
    if (target === null) {
      violations.push(
        `第 ${item.line} 行：${item.id || "这一条"}被勾上了，却没有写「${DOD_EVIDENCE_MARK}<仓内路径>」——` +
          "勾选必须追到仓里的一份记录，编码侧不许自报完成"
      );
      continue;
    }
    if (!exists(target)) {
      violations.push(
        `第 ${item.line} 行：${item.id || "这一条"}的证据指向 ${target}，但仓里没有这个文件——` +
          "勾选追不到记录，等于没有证据"
      );
    }
  }

  return violations;
};

// ---- an open item still has to say where its evidence would be ----
//
// `dodCheckboxViolations` settles "a tick must point at a record": it refuses a
// `[x]` with no `证据：`. It cannot refuse anything about an item that is never
// ticked — and every one of the six items was unticked, so the whole bar sat in
// a state the audit called green while no item named a single file. "Nothing to
// report" and "nobody has looked" are the same answer to that check, and only
// one of them means the bar is being maintained.
//
// So the other half is stated too, as a *candidate* rather than evidence: every
// item must say where its evidence would be (`证据候选：<仓内路径>`), and that
// path must exist. A candidate is not a tick — ticking still belongs to the
// scheduler side, and the item's text is untouched — it is the answer to "if
// this item were closed today, which file in this repository would a reader
// open". The distinction is deliberate and is enforced in both directions:
//
//   1. 每条都要有候选 — all six IDs must carry at least one `证据候选：` line.
//      An item with none is named by ID, because that is how the next round's
//      brief refers to it.
//   2. 候选要落在仓里 — the cited path must exist, so a candidate cannot be a
//      reassuring name. That is the same rule `dodCheckboxViolations` makes for
//      evidence, and for the same reason: a pointer nobody can follow is prose.
//   3. 候选要挂在某一条下面 — a `证据候选：` line before the first item, or
//      after the list, belongs to no ID. It looks like coverage and answers
//      nothing, so it is red rather than ignored.
//   4. 候选是「行首」，不是「出现过」 — a candidate line *starts* with the mark.
//      The DoD's own paragraph explains the mark, so it contains the four
//      characters mid-sentence; reading "the line mentions it" made that
//      explanation an orphan candidate and the live document red on the first
//      run. A mention is prose about the rule, a line that opens with the mark
//      is an answer to it, and only the second one is coverage.
//
// What this rule still cannot say is whether a candidate is *good*. It says the
// pointer exists and that every item has one; whether that file really records
// the item is a human read, which is why the DoD's own text keeps the burden on
// the scheduler side.
export const DOD_CANDIDATE_MARK = "证据候选：";

/** Every `证据候选：` line in the DoD, with the ID of the item it sits under
 *  (`null` when it sits under none). Line numbers are 1-based document lines.
 *
 *  "A candidate line" is a line whose first non-space character starts the mark,
 *  not a line that contains it: the DoD explains the mark in prose, and a rule
 *  that counted the explanation would report the document's own instructions as
 *  an orphan candidate. */
export const dodEvidenceCandidates = (doc) => {
  const items = dodChecklist(doc);
  const byLine = new Map(items.map((item) => [item.line, item]));
  const candidates = [];
  let current = null;
  String(doc == null ? "" : doc)
    .split(/\r?\n/)
    .forEach((text, index) => {
      const line = index + 1;
      const item = byLine.get(line);
      if (item) {
        current = item;
        return;
      }
      if (!text.trimStart().startsWith(DOD_CANDIDATE_MARK)) return;
      candidates.push({
        line,
        id: current === null ? null : current.id,
        path: dodPathAfterMark(text, DOD_CANDIDATE_MARK),
      });
    });
  return candidates;
};

export const dodEvidenceCandidateViolations = (doc, exists = () => true) => {
  const candidates = dodEvidenceCandidates(doc);
  if (candidates.length === 0) {
    return [
      "DoD 里一行「" + DOD_CANDIDATE_MARK + "<仓内路径>」都没有：六条条目因此谁也没说" +
        "「要勾我该去翻哪份记录」，一直不勾就成了一种看起来合格的静默状态",
    ];
  }

  const violations = [];
  const claimed = new Set(candidates.map((candidate) => candidate.id).filter((id) => id !== null));
  const missing = DOD_CHECKBOX_IDS.filter((id) => !claimed.has(id));
  if (missing.length) {
    violations.push(
      `${missing.join("、")} 没有写「${DOD_CANDIDATE_MARK}<仓内路径>」：` +
        "条目可以还没勾，但它必须指出若勾上该追哪份记录——没有候选的那一条，" +
        "下一轮既不知道该去读什么，也没法判断自己是不是已经做到了"
    );
  }

  for (const candidate of candidates) {
    if (candidate.id === null) {
      violations.push(
        `第 ${candidate.line} 行的「${DOD_CANDIDATE_MARK}」不在任何一条 DOD 之下——` +
          "它看起来像是给某一条补了候选，实际上一条都没补上（候选要写在其条目下面一行）"
      );
      continue;
    }
    if (candidate.path === null) {
      violations.push(
        `第 ${candidate.line} 行：${candidate.id} 的「${DOD_CANDIDATE_MARK}」后面没有路径——` +
          "候选必须指向仓里的一份记录，空着等于没写"
      );
      continue;
    }
    if (!exists(candidate.path)) {
      violations.push(
        `第 ${candidate.line} 行：${candidate.id} 的证据候选指向 ${candidate.path}，但仓里没有这个文件——` +
          "候选是「将来要引用的那份记录」，指向不存在的路径，勾选那一步仍然没有着落"
      );
    }
  }

  return violations;
};

// ---- a candidate is a pointer; the pointer has to land on the evidence ----
//
// `dodEvidenceCandidateViolations` settles "every item says which record it would
// cite, and that record exists". It cannot settle the other half: a file can
// exist and still not contain the thing the item is about. That gap is not
// hypothetical — it is the state the whole bar was in: six items, six candidate
// paths, every path present, and nobody had opened one to see whether the
// evidence was inside. "The pointer resolves" and "the evidence is there" are
// different answers, and only the second one is what a tick means.
//
// So each candidate declares the shape its record must contain, and the rule
// reads the file:
//
//   1. 每个候选都要有形状 — a candidate with no declared shape is a pointer
//      nobody has read. It is red, because adding a candidate is exactly the
//      moment to say what evidence it should hold; a table that silently
//      ignored new candidates would let the next round add one and call it done.
//   2. 形状表与候选是双射 — a shape whose (item, path) is no longer a candidate
//      is red too. The two halves are one fact; when only one side moves, the
//      reader cannot tell which of them is current.
//   3. 文件里要真的有那份证据 — every `must` pattern must appear in the body and
//      every `mustNot` pattern must not. The sentence names the item, the path
//      and the missing (or forbidden) label, because "DOD-4 is red" without the
//      word that is missing sends the reader back to reading the file by eye.
//
// What this rule still cannot say is whether the shape is the *right* shape: a
// pattern is a claim about what the evidence looks like, written by the same
// person who wrote the candidate. It can be too weak (a word that appears for
// another reason) or too tight (a wording that changes). Both are visible in the
// table below, which is the point — the claim is now one line a reader can argue
// with, instead of a paragraph of prose nobody re-reads.
export const DOD_EVIDENCE_SHAPES = Object.freeze([
  {
    id: "DOD-1",
    path: "README.zh-CN.md",
    must: [
      { label: "非官方", pattern: /非官方/ },
      { label: "未获其背书 / 无隶属关系", pattern: /未获其背书|无隶属关系/ },
    ],
  },
  {
    id: "DOD-1",
    path: "src/components/SettingsPanel.tsx",
    must: [
      { label: "非官方", pattern: /非官方/ },
      { label: "无隶属关系", pattern: /无隶属关系/ },
    ],
  },
  {
    id: "DOD-2",
    path: "ocr-service.js",
    must: [
      { label: "spawn 官方二进制", pattern: /spawn\(/ },
      { label: "--preview 参数", pattern: /--preview/ },
      { label: "解析 CLI 的 JSON", pattern: /JSON\.parse/ },
    ],
  },
  {
    id: "DOD-2",
    path: "tools/service-smoke.mjs",
    must: [
      { label: "按上游 resolver 语义重算", pattern: /resolver/ },
      { label: "平台包名", pattern: /PLATFORM_PACKAGE/ },
    ],
  },
  {
    id: "DOD-3",
    path: "docs/OCR-UPSTREAM-SYNC.md",
    must: [
      { label: "pin 的 tag", pattern: new RegExp(PINNED_UPSTREAM.tag.replace(/\./g, "\\.")) },
      { label: "对照表", pattern: /对照表/ },
    ],
  },
  {
    id: "DOD-3",
    path: "tools/upstream-watch-smoke.mjs",
    must: [
      { label: "DoD 勾选断言", pattern: /dodCheckboxViolations/ },
      { label: "通路账断言", pattern: /ledgerTableViolations/ },
    ],
  },
  {
    id: "DOD-4",
    path: "tools/e2e-flow.mjs",
    must: [
      { label: "真 Electron 进程", pattern: /spawn\(electronPath/ },
      { label: "跑的是 e2e-flow.cjs", pattern: /e2e-flow\.cjs/ },
    ],
  },
  {
    id: "DOD-4",
    path: "tools/e2e-flow.cjs",
    must: [
      { label: "预览", pattern: /preview/ },
      { label: "分支对比范围", pattern: /range/ },
    ],
  },
  {
    id: "DOD-4",
    path: "tools/e2e-first-run.cjs",
    must: [
      { label: "一次性档案", pattern: /throwaway profile/ },
      { label: "引导卡", pattern: /三步开始第一次审查/ },
      { label: "成本确认", pattern: /这次扫描的规模不小/ },
    ],
  },
  {
    id: "DOD-4",
    path: "tools/fake-provider-smoke.mjs",
    must: [
      { label: "预算截断真跑", pattern: /budget_exceeded/ },
      { label: "全量扫描真跑", pattern: /current_file_path/ },
      { label: "不出网", pattern: /loopback/ },
    ],
  },
  {
    id: "DOD-4",
    path: "src/components/ResultsPanel.tsx",
    must: [
      { label: "四态徽章取自 STATUS", pattern: /STATUS/ },
      { label: "徽章渲染", pattern: /<Badge/ },
      { label: "预算截断态", pattern: /runLimitReached/ },
    ],
  },
  {
    id: "DOD-5",
    path: "docs/measurements.md",
    must: [
      { label: "未验证清单", pattern: /未验证清单/ },
      { label: "真机记录", pattern: /真机/ },
    ],
  },
  {
    id: "DOD-5",
    path: "tools/release.mjs",
    must: [
      { label: "不 push", pattern: /does not push/ },
      { label: "不发布 Release", pattern: /does not publish a GitHub Release/ },
    ],
  },
  {
    id: "DOD-6",
    path: "package.json",
    must: [{ label: "asar 保持 false", pattern: /"asar":\s*false/ }],
  },
  {
    id: "DOD-6",
    path: "config-handler.js",
    must: [
      { label: "写入只经 ocr.setConfig", pattern: /ocr\.setConfig\(/ },
      { label: "Key 走 providers.<name>.api_key", pattern: /api_key/ },
    ],
    mustNot: [{ label: "自己写配置文件", pattern: /writeFile/ }],
  },
  {
    id: "DOD-6",
    path: "tools/secret-scan.mjs",
    must: [
      { label: "读配置里的 Key", pattern: /api_key/ },
      { label: "扫描产物", pattern: /scan/ },
    ],
  },
]);

const dodShapeKey = (id, path) => `${id}\u0000${path}`;

/** The DoD's candidates, read against the shape each one declares.
 *
 *  `read(path)` returns the file's text, or `null` when it cannot be read. It is
 *  required rather than defaulted to a filesystem call: this module is imported
 *  by checks that must be able to hand in a doctored body, and a default that
 *  silently read the real file would make "the evidence is missing" impossible
 *  to test — the one control that matters most. */
export const dodEvidenceBodyViolations = (doc, read = () => null) => {
  const candidates = dodEvidenceCandidates(doc);
  const violations = [];
  const shapes = DOD_EVIDENCE_SHAPES;
  const shapeByKey = new Map(shapes.map((shape) => [dodShapeKey(shape.id, shape.path), shape]));

  // 1. A candidate nobody has said anything about is a pointer, not evidence.
  for (const candidate of candidates) {
    if (candidate.id === null || candidate.path === null) continue; // the candidate rule's question
    if (!shapeByKey.has(dodShapeKey(candidate.id, candidate.path))) {
      violations.push(
        `第 ${candidate.line} 行：${candidate.id} 的候选 ${candidate.path} 没有声明「这份记录里该有什么证据」——` +
          "候选只证明文件在，不证明文件里有那份证据；没声明形状的候选等于没人读过它"
      );
    }
  }

  // 2. The table and the document are one fact, so a shape with no candidate is
  //    the same defect from the other side.
  const candidateKeys = new Set(
    candidates
      .filter((candidate) => candidate.id !== null && candidate.path !== null)
      .map((candidate) => dodShapeKey(candidate.id, candidate.path))
  );
  for (const shape of shapes) {
    if (!candidateKeys.has(dodShapeKey(shape.id, shape.path))) {
      violations.push(
        `${shape.id} 的证据形状表里还留着 ${shape.path}，但 DoD 里已经没有这条候选——` +
          "形状表与候选是同一件事的两面，一边改了另一边没改，读的人就不知道哪份才是真的"
      );
    }
  }

  // 3. The body itself.
  for (const shape of shapes) {
    const body = read(shape.path);
    if (typeof body !== "string") {
      violations.push(
        `${shape.id} 的证据候选 ${shape.path} 读不到内容——形状检查因此没有对象，不能算绿`
      );
      continue;
    }
    const missing = shape.must.filter((item) => !item.pattern.test(body));
    if (missing.length) {
      violations.push(
        `${shape.id} 的证据候选 ${shape.path} 里找不到 ${missing
          .map((item) => `「${item.label}」`)
          .join("、")}——候选指向的文件在，但里面没有这一条要的证据，勾选那一步仍然没有着落`
      );
    }
    const forbidden = (shape.mustNot || []).filter((item) => item.pattern.test(body));
    if (forbidden.length) {
      violations.push(
        `${shape.id} 的证据候选 ${shape.path} 里出现了不该有的 ${forbidden
          .map((item) => `「${item.label}」`)
          .join("、")}——这一条要的是「没有这件事」，出现了就是反证`
      );
    }
  }

  return violations;
};

// ---- a candidate that is a harness has to be a harness something runs ----
//
// `dodEvidenceCandidateViolations` settles "the pointer resolves" and
// `dodEvidenceBodyViolations` settles "the record says the thing". Neither
// settles the question a reader actually asks about a candidate that is a
// *check*: does anything run it? A file under `tools/` can exist, can contain
// every word its shape asks for, and still be dead code — nothing in
// `package.json` invokes it, so the evidence it holds was never produced by a
// run. That is the difference between "we wrote a check" and "the check ran",
// and it is exactly the shape a round leaves behind when it adds a harness and
// forgets the script line.
//
// So the closure is computed rather than listed: start from every `audit*`
// script, follow `npm run <name>` into the scripts it chains, take the `node
// <file>` invocations, then follow each of those files' relative imports and
// `tools/...` literals until nothing new appears. A candidate that is a harness
// must be inside that closure. Records (documents, source files, `package.json`)
// are not harnesses and are not asked this question — they are read by
// `dodEvidenceBodyViolations` instead.
//
// `read` is injected for the same reason as above: the controls have to be able
// to hand in a doctored `package.json` and a doctored file body, and a default
// that read the real disk would make "nothing runs this" impossible to test.
export const AUDIT_SCRIPT_PREFIX = "audit";

const NODE_INVOCATION = /\bnode\s+([\w./-]+\.(?:mjs|cjs|js))/g;
const NPM_RUN_REFERENCE = /npm run ([\w:.-]+)/g;
const RELATIVE_SPECIFIER = /(?:from\s+|require\(\s*|import\(\s*)["'](\.[^"']+)["']/g;
const TOOLS_LITERAL = /["'](tools\/[\w./-]+\.(?:mjs|cjs|js))["']/g;
const TOOLS_JOINED = /["']tools["']\s*,\s*["']([\w.-]+\.(?:mjs|cjs|js))["']/g;

const normalizeRepoPath = (target) =>
  path.posix.normalize(String(target).replace(/\\/g, "/")).replace(/^\.\//, "");

/** Every file an `audit*` script can reach, plus the scripts that were walked.
 *
 *  `files` is a Set of repo-relative paths; a path only enters it when `read`
 *  returns text for it, so "the closure contains it" and "the file is there" are
 *  the same answer. */
export const auditScriptClosure = (pkg, read = () => null) => {
  const scripts = (pkg && pkg.scripts) || {};
  const walked = new Set();
  const files = new Set();
  const queue = [];

  const addFile = (target) => {
    const normalized = normalizeRepoPath(target);
    if (files.has(normalized)) return;
    if (typeof read(normalized) !== "string") return;
    files.add(normalized);
    queue.push(normalized);
  };

  const walkScript = (name) => {
    if (walked.has(name)) return;
    walked.add(name);
    const body = scripts[name];
    if (typeof body !== "string") return;
    for (const hit of body.matchAll(NPM_RUN_REFERENCE)) walkScript(hit[1]);
    for (const hit of body.matchAll(NODE_INVOCATION)) addFile(hit[1]);
  };

  for (const name of Object.keys(scripts)) {
    if (name.startsWith(AUDIT_SCRIPT_PREFIX)) walkScript(name);
  }

  while (queue.length) {
    const file = queue.shift();
    const body = read(file);
    if (typeof body !== "string") continue;
    for (const hit of body.matchAll(RELATIVE_SPECIFIER)) {
      addFile(path.posix.join(path.posix.dirname(file), hit[1]));
    }
    for (const hit of body.matchAll(TOOLS_LITERAL)) addFile(hit[1]);
    for (const hit of body.matchAll(TOOLS_JOINED)) addFile(path.posix.join("tools", hit[1]));
  }

  return { scripts: [...walked].sort(), files };
};

/** A candidate path that is a check rather than a record. */
export const DOD_HARNESS_PATH = /^tools\/[\w./-]+\.(?:mjs|cjs)$/;

export const dodHarnessReachViolations = (doc, { pkg = null, read = () => null } = {}) => {
  const candidates = dodEvidenceCandidates(doc);
  const closure = auditScriptClosure(pkg, read);
  const violations = [];
  const harnesses = candidates.filter(
    (candidate) =>
      candidate.id !== null && candidate.path !== null && DOD_HARNESS_PATH.test(candidate.path)
  );

  if (harnesses.length === 0) {
    violations.push(
      "DoD 的证据候选里没有一条指向 harness（`tools/**/*.mjs` / `*.cjs`）——" +
        "这条规则因此没有对象，不能算绿：六条条目里至少有一条的证据是一份检查"
    );
  }

  for (const candidate of harnesses) {
    if (closure.files.has(candidate.path)) continue;
    violations.push(
      `第 ${candidate.line} 行：${candidate.id} 的证据候选 ${candidate.path} 是一份 harness，` +
        `但没有任何 \`audit*\` 脚本跑到它（依赖闭包 ${closure.files.size} 个文件里没有它）——` +
        "候选指向一份从不被执行的检查，等于「写了检查」而不是「检查跑过」"
    );
  }

  return violations;
};

// ---- an unchecked item has to say why it is still unchecked ----
//
// The candidate rules answer "where would the evidence be". They do not answer
// the question a reader of the bar actually has: *why is this still open*. Six
// items sat unticked for many rounds with a candidate each, and the audit was
// green the whole time — because "no tick" was a state nothing asked about. A
// bar whose open items have no stated reason is a bar nobody is maintaining;
// the difference between "we know what is missing" and "nobody has looked" is
// one sentence per item, and it costs nothing to require it.
//
// The sentence is not a promise to tick. It is the answer to "what would have to
// happen", and it has to be checkable in the same way everything else here is:
//
//   1. 每条没勾的都要有一句 — an unchecked item with no `未勾原因：` line is red.
//   2. 那句话要指到仓里 — the reason must name at least one backticked path that
//      exists, so "why not" is anchored to a record instead of being a mood.
//   3. 不许是占位词 — 待定 / TODO / 以后再说 are refused: they are the shape of an
//      answer, not an answer.
//   4. 勾上了就不许再写 — a ticked item carrying a reason is a contradiction,
//      and it is how a stale reason survives the tick that made it false.
//   5. 不许挂在条目之外 — a reason line under no item answers nothing.
export const DOD_REASON_MARK = "未勾原因：";
export const DOD_REASON_MIN = 16;
export const DOD_REASON_PLACEHOLDERS = Object.freeze([
  "待定",
  "TODO",
  "以后再说",
  "暂无",
  "待补",
  "还没想好",
]);

const BACKTICKED_TOKEN = /`([^`\n]+)`/g;
const looksLikeRepoPath = (token) =>
  /^[\w.-]+(\/[\w.-]+)+$/.test(token) || /\.(md|mjs|cjs|js|tsx|ts|json)$/.test(token);

/** Every `未勾原因：` line in the DoD, with the ID of the item it sits under
 *  (`null` when it sits under none). Same reading as `dodEvidenceCandidates`:
 *  the line has to *start* with the mark, so prose about the rule is not a
 *  reason. */
export const dodReasons = (doc) => {
  const items = dodChecklist(doc);
  const byLine = new Map(items.map((item) => [item.line, item]));
  const reasons = [];
  let current = null;
  String(doc == null ? "" : doc)
    .split(/\r?\n/)
    .forEach((text, index) => {
      const line = index + 1;
      const item = byLine.get(line);
      if (item) {
        current = item;
        return;
      }
      const trimmed = text.trimStart();
      if (!trimmed.startsWith(DOD_REASON_MARK)) return;
      reasons.push({
        line,
        id: current === null ? null : current.id,
        text: trimmed.slice(DOD_REASON_MARK.length).trim(),
      });
    });
  return reasons;
};

export const dodReasonViolations = (doc, exists = () => true) => {
  const items = dodChecklist(doc);
  const reasons = dodReasons(doc);
  const violations = [];
  const byId = new Map();

  for (const reason of reasons) {
    if (reason.id === null) {
      violations.push(
        `第 ${reason.line} 行的「${DOD_REASON_MARK}」不在任何一条 DOD 之下——` +
          "它看起来像回答了「为什么还没勾」，实际上一条都没回答（原因要写在其条目下面）"
      );
      continue;
    }
    if (byId.has(reason.id)) {
      violations.push(
        `第 ${reason.line} 行：${reason.id} 写了不止一条「${DOD_REASON_MARK}」——` +
          "两条原因就是两个说法，读的人不知道哪条才是现在的"
      );
      continue;
    }
    byId.set(reason.id, reason);
  }

  for (const item of items) {
    const reason = byId.get(item.id);
    if (item.checked) {
      if (reason) {
        violations.push(
          `第 ${reason.line} 行：${item.id} 已经勾上了，却还写着「${DOD_REASON_MARK}」——` +
            "勾上之后那句「为什么还没勾」就是假话，留着它等于让下一个人读到过期结论"
        );
      }
      continue;
    }
    if (!reason) {
      violations.push(
        `第 ${item.line} 行：${item.id || "这一条"}还没勾，却没有写「${DOD_REASON_MARK}<一句话 + 仓内路径>」——` +
          "「没勾」和「没人看过」是同一个答案，只有写了原因的那一条才说明这份标准在被维护"
      );
      continue;
    }
    if (reason.text.length < DOD_REASON_MIN) {
      violations.push(
        `第 ${reason.line} 行：${item.id} 的「${DOD_REASON_MARK}」只有 ${reason.text.length} 个字——` +
          `至少要 ${DOD_REASON_MIN} 个字说清「缺什么、什么条件下能勾」`
      );
    }
    const placeholder = DOD_REASON_PLACEHOLDERS.find((word) => reason.text.includes(word));
    if (placeholder !== undefined) {
      violations.push(
        `第 ${reason.line} 行：${item.id} 的「${DOD_REASON_MARK}」里写着「${placeholder}」——` +
          "占位词是答案的形状而不是答案，它让「还没勾」看起来像已经解释过了"
      );
    }
    const paths = [...reason.text.matchAll(BACKTICKED_TOKEN)]
      .map((hit) => hit[1].trim())
      .filter((token) => looksLikeRepoPath(token));
    if (paths.length === 0) {
      violations.push(
        `第 ${reason.line} 行：${item.id} 的「${DOD_REASON_MARK}」没有指出任何仓内路径——` +
          "原因要落在某份记录上（缺的是哪份检查、哪份实测），否则它只是一句心情"
      );
      continue;
    }
    const missing = paths.filter((target) => !exists(target));
    if (missing.length) {
      violations.push(
        `第 ${reason.line} 行：${item.id} 的「${DOD_REASON_MARK}」指向 ${missing.join("、")}，但仓里没有这个文件——` +
          "原因追不到记录，等于没写"
      );
    }
  }

  return violations;
};

// ---- a reason that hands the call to someone else has to say what they check ----
//
// DOD-2 carried this sentence as its stated reason for many rounds: 「这一条仍不勾，
// 因为勾选归 scheduler 侧」. That is a division of labour, not a reason. It names who
// decides and never what they decide, so the item can be neither ticked nor shown to
// be missing anything: every round reads it, agrees with it, and moves on. It was the
// only item on the bar that was stuck *because nobody had written down what the other
// party has to confirm* — an absence that no count, no candidate and no path check
// can see.
//
// So a reason that delegates must answer the second half in the same line:
// 「scheduler 侧要确认的是：<一句话>」, and the clause is held to the same standard as
// everything else here — long enough to be a sentence rather than a shrug, and citing
// a record in this repository so the confirmation has something to land on. What the
// rule cannot judge is whether the clause is the *right* confirmation; what it can
// refuse is leaving the delegation one-sided.
export const DOD_DELEGATION = /归\s*scheduler\s*侧/;
export const DOD_CONFIRMATION_MARK = "scheduler 侧要确认的是：";
export const DOD_CONFIRMATION_MIN = 24;

export const dodConfirmationViolations = (doc, exists = () => true) => {
  const violations = [];
  for (const reason of dodReasons(doc)) {
    if (!DOD_DELEGATION.test(reason.text)) continue;
    const at = reason.text.indexOf(DOD_CONFIRMATION_MARK);
    if (at === -1) {
      violations.push(
        `第 ${reason.line} 行：${reason.id || "这一条"}把决定交给 scheduler 侧，却没有写「${DOD_CONFIRMATION_MARK}<要确认的对象>」——` +
          "「归 scheduler 侧」说的是谁决定，不是缺什么；照这样写，这一条永远勾不上、也永远看不出缺了什么"
      );
      continue;
    }
    const clause = reason.text.slice(at + DOD_CONFIRMATION_MARK.length).trim();
    if (clause.length < DOD_CONFIRMATION_MIN) {
      violations.push(
        `第 ${reason.line} 行：${reason.id} 的「${DOD_CONFIRMATION_MARK}」后面只有 ${clause.length} 个字——` +
          `至少要 ${DOD_CONFIRMATION_MIN} 个字说清要确认的是哪件事、落在哪份记录上`
      );
      continue;
    }
    const paths = [...clause.matchAll(BACKTICKED_TOKEN)]
      .map((hit) => hit[1].trim())
      .filter((token) => looksLikeRepoPath(token));
    if (paths.length === 0) {
      violations.push(
        `第 ${reason.line} 行：${reason.id} 的「${DOD_CONFIRMATION_MARK}」没有指出任何仓内路径——` +
          "确认对象要落在某份记录上（哪份表、哪份实测），否则它仍然是「让别人去看点东西」"
      );
      continue;
    }
    const missing = paths.filter((target) => !exists(target));
    if (missing.length) {
      violations.push(
        `第 ${reason.line} 行：${reason.id} 的「${DOD_CONFIRMATION_MARK}」指向 ${missing.join("、")}，但仓里没有这个文件——` +
          "确认对象追不到记录，等于没写"
      );
    }
  }
  return violations;
};

// ---- "how many are ticked" is one sentence, and it has to agree with the boxes
//
// Six items, each with a candidate and a reason, still left a reader of the bar
// with a question nothing answered: *how many are closed right now*. The number
// was implied by walking six checkboxes, so the sentence a next round wants to
// quote — 「已勾 N 条 / 未勾 M 条」 — lived nowhere and was retyped from memory
// each time. A count that is retyped is a count that drifts, and a drifted count
// is indistinguishable from a bar that changed.
//
// So the DoD carries the count as one section: a fixed sentence, then one row per
// item with its state and a one-line summary. The rule reads both halves and
// compares them to the checkboxes:
//
//   1. 数字要对得上 — the sentence's 已勾 N 条 / 未勾 M 条 must equal what the
//      `[x]` / `[ ]` lines actually say. That comparison is the whole point.
//   2. 状态列要对得上 — every row's 已勾 / 未勾 must be the item's own state, so
//      a tick that was flipped in one place and not the other is named, not
//      averaged away.
//   3. 六个 ID 一个不多一个不少 — a missing row is how the count stays "six"
//      while an item quietly disappears; an unknown ID is a row about something
//      else that still gets counted.
//   4. 摘要不许新造事实 — the summary sentence must cite a record the item's own
//      `未勾原因：` (or its `证据：`, once ticked) already cites. A summary that
//      introduces a *new* file is a second claim, and the two disagree the first
//      time either one moves. This is what keeps the table a restatement: the
//      moment it may say something new, it is a second authority for the bar.
export const DOD_SUMMARY_HEADING = "## 勾选状态一览";
export const DOD_SUMMARY_COLUMNS = Object.freeze(["条目", "状态", "一句话"]);
export const DOD_SUMMARY_STATE_WORDS = Object.freeze({ checked: "已勾", open: "未勾" });
export const DOD_SUMMARY_COUNT = /已勾\s*(\d+)\s*条[、，]\s*未勾\s*(\d+)\s*条/;
export const DOD_SUMMARY_MIN = 10;

/** The 「勾选状态一览」section: the prose above its table, the header cells and the
 *  data rows, with 1-based line numbers. `found` is false when the heading is
 *  absent, so a caller can say "there is no count" instead of "the count is
 *  wrong" — two different repairs. */
export const dodSummaryTable = (doc) => {
  const lines = String(doc == null ? "" : doc).split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().startsWith(DOD_SUMMARY_HEADING));
  if (start === -1) return { found: false, line: null, intro: [], header: [], rows: [], separator: null };
  const intro = [];
  const header = [];
  const rows = [];
  let separator = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^#{1,6}\s/.test(line.trim())) break;
    if (!line.trim().startsWith("|")) {
      if (separator === null) intro.push({ line: index + 1, text: line });
      continue;
    }
    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) {
      separator = index + 1;
      continue;
    }
    if (separator === null) header.push({ line: index + 1, cells });
    else rows.push({ line: index + 1, cells });
  }
  return { found: true, line: start + 1, intro, header, rows, separator };
};

export const dodSummaryViolations = (doc, exists = () => true) => {
  const table = dodSummaryTable(doc);
  if (!table.found) {
    return [
      `DoD 里没有「${DOD_SUMMARY_HEADING.replace(/^##\s*/, "")}」这一节——` +
        "「现在勾了几条」只能靠人数方括号，而数出来的那个数字不会留下任何记录",
    ];
  }
  const violations = [];
  const items = dodChecklist(doc);
  const reasons = new Map(dodReasons(doc).map((reason) => [reason.id, reason]));
  const checkedCount = items.filter((item) => item.checked).length;
  const openCount = items.length - checkedCount;

  // 1. the count.
  const count = DOD_SUMMARY_COUNT.exec(table.intro.map((entry) => entry.text).join("\n"));
  if (count === null) {
    violations.push(
      `第 ${table.line} 行：这一节里没有「已勾 N 条、未勾 M 条」这句话——` +
        "一张状态表不等于一个数字，下一轮要引用的正是那个数字"
    );
  } else if (Number(count[1]) !== checkedCount || Number(count[2]) !== openCount) {
    violations.push(
      `第 ${table.line} 行：这一节写的是已勾 ${count[1]} 条、未勾 ${count[2]} 条，` +
        `而方括号里实际是已勾 ${checkedCount} 条、未勾 ${openCount} 条——` +
        "计数与勾选状态是同一件事，两处说法必须一致"
    );
  }

  // 2. the header, so the columns cannot be reordered under the reader.
  if (table.header.length !== 1) {
    violations.push(
      `第 ${table.line} 行：状态表的表头有 ${table.header.length} 行（应为 1 行「${DOD_SUMMARY_COLUMNS.join(" | ")}」）——` +
        "没有表头，第二列是状态还是备注就没人说得清"
    );
  } else if (table.header[0].cells.join("|") !== DOD_SUMMARY_COLUMNS.join("|")) {
    violations.push(
      `第 ${table.header[0].line} 行：状态表的列是「${table.header[0].cells.join(" / ")}」，` +
        `应为「${DOD_SUMMARY_COLUMNS.join(" / ")}」——列换了位置，读的人会把状态当成一句话`
    );
  }

  // 3. one row per locked ID.
  const seen = new Map();
  for (const row of table.rows) {
    const id = row.cells[0] || "";
    if (seen.has(id)) {
      violations.push(
        `第 ${row.line} 行：${id} 在状态表里出现了两次（上一次在第 ${seen.get(id)} 行）——同一个条目只能有一个状态`
      );
      continue;
    }
    seen.set(id, row.line);
  }
  const missing = DOD_CHECKBOX_IDS.filter((id) => !seen.has(id));
  if (missing.length) {
    violations.push(`状态表里少了 ${missing.join("、")}：「已勾 N 条」只有在每条都占一行时才数得清`);
  }
  const unknown = [...seen.keys()].filter((id) => !DOD_CHECKBOX_IDS.includes(id));
  if (unknown.length) {
    violations.push(`状态表里的 ${unknown.join("、")} 不是过线标准的条目——多出来的一行把计数变成了另一个东西`);
  }

  // 4. the state, and a summary that restates rather than adds.
  const byId = new Map(items.filter((item) => item.id !== null).map((item) => [item.id, item]));
  for (const row of table.rows) {
    const [id, state, summary = ""] = row.cells;
    const item = byId.get(id);
    if (item === undefined) continue;
    const want = item.checked ? DOD_SUMMARY_STATE_WORDS.checked : DOD_SUMMARY_STATE_WORDS.open;
    if (state !== DOD_SUMMARY_STATE_WORDS.checked && state !== DOD_SUMMARY_STATE_WORDS.open) {
      violations.push(
        `第 ${row.line} 行：${id} 的状态写成了「${state}」——` +
          `只有「${DOD_SUMMARY_STATE_WORDS.checked}」与「${DOD_SUMMARY_STATE_WORDS.open}」两种`
      );
      continue;
    }
    if (state !== want) {
      violations.push(
        `第 ${row.line} 行：${id} 在状态表里是「${state}」，而方括号里是「${want}」——` +
          "同一件事的两个地方对不上，读的人不知道该信哪一边"
      );
    }
    if (summary.trim().length < DOD_SUMMARY_MIN) {
      violations.push(`第 ${row.line} 行：${id} 的一句话说只有 ${summary.trim().length} 个字，等于没写`);
      continue;
    }
    const cited = [...summary.matchAll(BACKTICKED_TOKEN)]
      .map((hit) => hit[1].trim())
      .filter((token) => looksLikeRepoPath(token));
    if (cited.length === 0) {
      violations.push(`第 ${row.line} 行：${id} 的一句话说没有指到任何仓内路径——摘要也要落在某份记录上`);
      continue;
    }
    const missingFiles = cited.filter((target) => !exists(target));
    if (missingFiles.length) {
      violations.push(`第 ${row.line} 行：${id} 的一句话说指向 ${missingFiles.join("、")}，但仓里没有这个文件`);
      continue;
    }
    const reason = reasons.get(id);
    const anchorText = item.checked ? item.text : reason ? reason.text : "";
    if (!cited.some((target) => anchorText.includes(target))) {
      violations.push(
        `第 ${row.line} 行：${id} 的一句话说指向 ${cited.join("、")}，` +
          `而该条自己的「${DOD_REASON_MARK}」/「${DOD_EVIDENCE_MARK}」里没有提到它——` +
          "摘要是复述，不是第二个说法；两处指着不同的记录，改一处另一处就成了假话"
      );
    }
  }

  return violations;
};

// ---- "what we have not verified" is a table with an owner, or it is prose ----
//
// `docs/measurements.md` has two halves: what was measured, and — since round
// 105 — what was *not*. The second half is the only place in this repository
// that records the boundary of the claims, and it was a free-form table: a row
// could say "not verified" and leave the reader unable to tell whether that is
// upstream's business, this repository's, or a real machine's. Three different
// owners mean three different next steps, and a row that names none of them is a
// row nobody can act on.
//
// So each row carries an owner and a pointer:
//
//   1. 归属只有三种 — 上游 / 本仓 / 真机. Anything else is red, because a fourth
//      word is a way of not choosing.
//   2. 每行要指到仓里 — at least one backticked path that exists, so the row is
//      anchored to a file a reader can open.
//   3. 归本仓的必须指到一份真的会跑的检查 — the path has to be inside the
//      `audit*` closure. "This is ours and we have not checked it" is only
//      honest while there is a check that could; pointing at a file nothing runs
//      is the same defect as a dead candidate.
//   4. 归上游的要指到同步文档 — the upstream rows are tracked in
//      `docs/OCR-UPSTREAM-SYNC.md`; a row that says "upstream's problem" without
//      naming where upstream is tracked is a row that will never be revisited.
//   5. 触发条件不许空 — the last cell is the answer to "when would we verify
//      this", and an empty one turns the row into a permanent excuse.
export const UNVERIFIED_HEADING = "## 未验证清单";
export const UNVERIFIED_OWNERS = Object.freeze(["上游", "本仓", "真机"]);
export const UNVERIFIED_TRIGGER_MIN = 8;
export const UNVERIFIED_UPSTREAM_DOC = UPSTREAM_SYNC_DOC;
export const UNVERIFIED_COLUMNS = Object.freeze([
  "项",
  "归属",
  "为什么没验",
  "下次要验的触发条件",
]);

/** The 未验证清单 table: its header cells and its data rows (1-based lines).
 *  Rows before the separator are the header; a table with no separator has no
 *  header and every row is data, which the rule reports rather than guesses. */
export const unverifiedTable = (doc) => {
  const lines = String(doc == null ? "" : doc).split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().startsWith(UNVERIFIED_HEADING));
  if (start === -1) return { found: false, header: [], rows: [], separator: null };

  const header = [];
  const rows = [];
  let separator = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^#{1,6}\s/.test(line.trim())) break;
    if (!line.trim().startsWith("|")) continue;
    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) {
      separator = index + 1;
      continue;
    }
    if (separator === null) header.push({ line: index + 1, cells });
    else rows.push({ line: index + 1, cells });
  }
  return { found: true, header, rows, separator };
};

export const unverifiedRowViolations = (doc, { exists = () => true, harnesses = new Set() } = {}) => {
  const table = unverifiedTable(doc);
  const violations = [];

  if (!table.found) {
    violations.push(
      `\`docs/measurements.md\` 里没有「${UNVERIFIED_HEADING}」这一节——` +
        "「没验证过什么」是这份文档的另一半，删掉它，README 的「不覆盖」就没有对应的记录"
    );
    return violations;
  }
  if (table.separator === null) {
    violations.push(
      `「${UNVERIFIED_HEADING}」下面没有表格分隔行——` +
        "没有分隔行就没有表头，读者不知道哪一格是归属、哪一格是触发条件"
    );
  }
  if (table.rows.length === 0) {
    violations.push(
      `「${UNVERIFIED_HEADING}」里一行都没有——` +
        "空表比没有表更糟：它看起来像「全都验证过了」"
    );
    return violations;
  }

  const headerCells = table.header.length ? table.header[table.header.length - 1].cells : [];
  if (headerCells.length && headerCells.join("|") !== UNVERIFIED_COLUMNS.join("|")) {
    violations.push(
      `「${UNVERIFIED_HEADING}」的表头是「${headerCells.join(" | ")}」，` +
        `形状应为「${UNVERIFIED_COLUMNS.join(" | ")}」——` +
        "归属这一列是这条规则要读的东西，表头改了它就静默失效"
    );
  }

  for (const row of table.rows) {
    const cells = row.cells;
    if (cells.length !== UNVERIFIED_COLUMNS.length) {
      violations.push(
        `第 ${row.line} 行：未验证清单的一行有 ${cells.length} 格，` +
          `形状是「${UNVERIFIED_COLUMNS.join(" | ")}」——` +
          "少一格就少一个答案，多一格则说明有人把两件事写进了一行"
      );
      continue;
    }
    const [item, owner, why, trigger] = cells;
    if (!UNVERIFIED_OWNERS.includes(owner)) {
      violations.push(
        `第 ${row.line} 行：「${item}」的归属写成了「${owner}」——` +
          `只许 ${UNVERIFIED_OWNERS.join(" / ")} 三种，` +
          "第四种说法就是「还没想清楚这是谁的事」"
      );
    }
    if (trigger.length < UNVERIFIED_TRIGGER_MIN) {
      violations.push(
        `第 ${row.line} 行：「${item}」的触发条件只有 ${trigger.length} 个字——` +
          `至少要 ${UNVERIFIED_TRIGGER_MIN} 个字说清「什么条件下补验」，` +
          "空着就等于这一行永远不会被回头看"
      );
    }
    const paths = [...`${why} ${trigger}`.matchAll(BACKTICKED_TOKEN)]
      .map((hit) => hit[1].trim())
      .filter((token) => looksLikeRepoPath(token));
    if (paths.length === 0) {
      violations.push(
        `第 ${row.line} 行：「${item}」没有指出任何仓内路径——` +
          "一行「没验证」要能追到一份文件（哪份检查、哪份记录），否则它只是一句免责声明"
      );
      continue;
    }
    const missing = paths.filter((target) => !exists(target));
    if (missing.length) {
      violations.push(
        `第 ${row.line} 行：「${item}」指向 ${missing.join("、")}，但仓里没有这个文件——` +
          "指错的路径比没有路径更难发现"
      );
    }
    if (owner === "本仓") {
      const reachable = paths.filter((target) => harnesses.has(target));
      if (reachable.length === 0) {
        violations.push(
          `第 ${row.line} 行：「${item}」归本仓，但指到的 ${paths.join("、")} 都不在 ` +
            "`audit*` 的依赖闭包里——「这是我们的、还没验」只有在存在一份会跑的检查时才诚实"
        );
      }
    }
    if (owner === "上游" && !`${why} ${trigger}`.includes(UNVERIFIED_UPSTREAM_DOC)) {
      violations.push(
        `第 ${row.line} 行：「${item}」归上游，却没有指到 ${UNVERIFIED_UPSTREAM_DOC}——` +
          "上游的事记在同步文档里，不指过去的那一行没人会回头核"
      );
    }
  }

  return violations;
};

// ---- the bar's own version facts: a pin that moved must not leave the DoD behind ----
//
// The DoD is the only input to the next round, and it states two version facts in
// prose: which upstream release this wrapper ships (`对照上游 ocr vX.Y.Z`) and
// which release of this app carries it (`v0.1.N`). The first one went stale the
// moment the pin moved to v1.13.4 — the file still said v1.13.3 in two places,
// and nothing noticed, because a version number in a sentence is not a shape any
// other rule reads. A reader who trusts the bar then believes the app ships an
// older engine than it does, and the next round's "what is left" is answered
// against a document that is wrong about the present.
//
// So the rule is stated over the values rather than over the sentences: every
// `vX.Y.Z` the DoD contains must be one of exactly two things — the pinned tag,
// or this app's own version. Anything else is either a stale pin (the defect
// this rule exists for) or a historical version fact that belongs in the archive
// and the READMEs, not in the bar. Both are red, and the sentence names the line,
// the token, and the two values it was compared against.
//
// `appVersion` is required rather than defaulted: with no second allowed value,
// the app's own `v0.1.N` would be reported as a stale pin, and a rule that
// cannot tell the two apart would be turned off by the first person who hit it.
export const DOD_VERSION_TOKEN = /\bv(\d+\.\d+\.\d+)\b/g;

export const dodPinViolations = (doc, { pinned = PINNED_UPSTREAM, appVersion = "" } = {}) => {
  const violations = [];
  const pinTag = String((pinned && pinned.tag) || "").trim();
  const own = String(appVersion == null ? "" : appVersion).trim().replace(/^v/, "");
  if (!/^v\d+\.\d+\.\d+$/.test(pinTag)) {
    violations.push(
      `pin 的 tag 是 ${JSON.stringify(pinTag || null)}，读不出 vX.Y.Z：` +
        "本条按版本号比较，读不出 pin 的版本就没有可比的一方"
    );
  }
  if (!/^\d+\.\d+\.\d+/.test(own)) {
    violations.push(
      `调用方没给本程序版本（package.json 的 version，收到 ${JSON.stringify(appVersion == null ? null : appVersion)}）：` +
        "DoD 里同时写着 pin 的 tag 与本程序自己的版本，只认一个会把另一个判成过期"
    );
  }
  const allowed = new Map();
  if (pinTag) allowed.set(pinTag, "pin 的 tag");
  if (own) allowed.set(`v${own}`, "本程序自己的版本");

  String(doc == null ? "" : doc)
    .split(/\r?\n/)
    .forEach((line, index) => {
      for (const hit of line.matchAll(DOD_VERSION_TOKEN)) {
        const token = hit[0];
        if (allowed.has(token)) continue;
        violations.push(
          `第 ${index + 1} 行：DoD 里写着 ${token}，但 pin 是 ${pinTag || "（读不出）"}、` +
            `本程序是 ${own ? `v${own}` : "（读不出）"}——` +
            "过线标准里的版本号只能是这两个之一；上游 pin 前进时这一行没跟着改，" +
            "读的人就会以为封装的是另一个发布版本（历史版本事实写进 upstream-history.md 与 README，不写进过线标准）"
        );
      }
    });

  return violations;
};

// ---- what the archive may quote, and what only the sync doc may declare ----
//
// `docs/upstream-history.md` quotes upstream commits in prose — whole
// 40-character SHAs included (a non-pin round's `refs/heads/main`, the annotated
// tag object id). That is *not* a pin declaration, and the archive is
// deliberately allowed to do it: a commit *is* 40 hex characters, so any check
// written as "find the 40 hex characters" sees those lines too.
//
// The pin itself is the exception, and it is a separate rule from "declaration
// shape": the archive may refer to it, but only by its 7-character prefix. A
// whole copy in the archive is a second authority nobody compares against — the
// same failure a second declaration shape would be — while a prefix is enough
// to read and cannot be mistaken for the pin. `historyPinLeakViolations` is that
// rule, stated over the pinned value instead of over a line shape.
//
// So the archive's contract is three-layered:
//
//   allowed   — a whole SHA cited in prose (`refs/heads/main` = `<sha>`), the
//               tag object a tag points at, and the paragraph explaining why the
//               pin stores 40 characters rather than a readable prefix;
//   allowed   — the pin itself by its 7-character prefix;
//   forbidden — any of the declaration shapes in `PIN_PLACES`, and the pinned
//               SHA quoted whole anywhere.
//
// `findShaCitations` answers which of the first two a line is, so the smoke test
// can assert the archive's rule itself instead of inferring it from "no pin was
// found" — that inference also passes once `findDocPins` stops matching shapes
// at all. Both lists are exported so a failure can print the rule, not just the
// violation.
export const HISTORY_ALLOWED_SHA_CONTEXTS = Object.freeze([
  "轮次叙述里直接引用某个 commit（`refs/heads/main` = `<40 位>`）",
  "叙述里引用 annotated tag 对象 id（`refs/tags/vN.N.N` 指向的那个）",
  "解释 pin 为什么存全 40 位、而不是 7 位前缀的规则段落",
  "pin 本身只用 7 位前缀引用（它的整串只在同步文档里声明一次）",
]);

// The rule as one readable sentence, built from the two lists so it cannot go
// stale when a shape is added. The smoke test asserts the sentence names every
// place and keeps the "40 位" allowance.
export const historyShaRule = () =>
  `归档允许整串 40 位 SHA 的自由引用（${HISTORY_ALLOWED_SHA_CONTEXTS.join("；")}），` +
  `但任何一行都不许用 pin 声明形状（${PIN_PLACES.join("、")}），也不许整串引用 pin 本身：声明只写在同步文档里，每处恰好一次。`;

// A whole commit, not a longer hex run: the lookarounds keep a 41-character blob
// from being read as a 40-character commit with a stray digit beside it, which
// would make the archive's answer depend on substring luck.
const WHOLE_SHA = /(?<![0-9a-fA-F])[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

// Every whole-SHA citation in a document, with the declaration shape it sits in
// (`null` = merely cited). The pin block counts as a shape: a `sha …` line inside
// it is a declaration even though it matches no per-line rule.
export const findShaCitations = (doc) => {
  const citations = [];
  let inBlock = false;
  String(doc || "")
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (line.includes(PIN_BLOCK_START)) {
        inBlock = true;
        return;
      }
      if (line.includes(PIN_BLOCK_END)) {
        inBlock = false;
        return;
      }
      const shapeHit = inBlock ? { where: "pin 块" } : matchPinShape(line);
      const shape = shapeHit ? shapeHit.where : null;
      for (const match of line.matchAll(WHOLE_SHA)) {
        citations.push({ line: index + 1, sha: match[0], shape });
      }
    });
  return citations;
};

/* ---- what may still change in the archive ----
 * The archive is not frozen: a later round sometimes has to add "and here is
 * what that decision cost" to a section it did not write — round 72 did exactly
 * that to round 71's section. That edit is legitimate, but it was *invisible*:
 * the only rule anyone could point at was "the log holds no pin", which says
 * nothing about rewriting the prose around one. A file whose sections may be
 * edited by anyone, any number of times, with no mark left behind, is not an
 * archive — it is a second draft of the sync doc, and "which round wrote this
 * sentence" stops being answerable.
 *
 * So the rule is stated twice: once in the doc's own preamble (a reader has to
 * be able to find it without opening this module), and once here as the
 * predicate the audit runs. Three promises, each of them mechanical:
 *
 *  - a section's body is written once. Later rounds may only append note blocks
 *    *at the end of that section*, one per round, each opening with the note
 *    marker — so any sentence a reader meets before the first note was written
 *    by the section's own round, and every later addition names its round;
 *  - a note's round is later than the section's round (you cannot annotate your
 *    own round) and notes inside one section are in increasing order (the file
 *    reads forward in time even though the sections read backward);
 *  - new sections are added above the previous one, so heading rounds strictly
 *    decrease from the top: "the newest round is at the top" is then a fact
 *    about the file, not a habit.
 */
export const HISTORY_NOTE_MARKER = /^\s*\*\*补记（第\s*(\d+)\s*轮）\*\*/;

// Both are spelled out so the doc and this module say the same sentence; the
// smoke test requires every term to appear in the doc's own preamble, so the
// rule cannot be described here and merely implied there.
export const HISTORY_APPEND_RULE_TERMS = Object.freeze([
  "补记（第 N 轮）",
  "不再改写",
  "段末",
  "轮次递减",
]);

export const historyAppendRule = () =>
  "归档段落的正文写入后不再改写：后续轮次只能在段末追加一段 `**补记（第 N 轮）**`，" +
  "N 必须晚于该段轮次；新轮次正文加在最上面，段落轮次递减。";

// Every `## 上游状态（…第 N 轮…）` section, with its 1-based heading line, body
// lines and note blocks. A heading whose round cannot be read is returned with
// `round: null` rather than dropped — "a section that does not say which round
// it is" is a fact the caller has to report, not one it may skip.
export const historySections = (doc) => {
  const lines = String(doc || "").split(/\r?\n/);
  const sections = [];
  let current = null;
  lines.forEach((line, index) => {
    const heading = /^##\s*上游状态（/.test(line);
    if (heading) {
      const round = /第\s*(\d+)\s*轮/.exec(line);
      current = {
        heading,
        line: index + 1,
        round: round ? Number(round[1]) : null,
        body: [],
        notes: [],
      };
      sections.push(current);
      return;
    }
    if (current) current.body.push({ line: index + 1, text: line });
  });
  for (const section of sections) section.notes = section.body.filter((entry) => HISTORY_NOTE_MARKER.test(entry.text));
  return sections;
};

// The rule as violations. Empty is the only acceptable answer for the real
// archive; each entry names the line, because "the archive is malformed" sends
// the reader to a 600-line diff.
export const historyAppendViolations = (doc) => {
  const violations = [];
  const sections = historySections(doc);

  const firstHeadingAt = sections.length ? sections[0].line : Infinity;
  // A note marker before the first section is a note about nothing: either the
  // preamble was edited by a round, or a section lost its heading.
  String(doc || "")
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (index + 1 < firstHeadingAt && HISTORY_NOTE_MARKER.test(line)) {
        violations.push(`第 ${index + 1} 行：补记出现在归档段落之外（第一节之前），没有可落的段`);
      }
    });

  for (const section of sections) {
    if (section.round === null) {
      violations.push(`第 ${section.line} 行：段落的标题读不出轮次，无法判断它允许哪些补记`);
      continue;
    }
    // Notes have to be a *suffix* of the section: the first non-blank line after
    // a note block ends anything that may still be appended.
    let sawNote = false;
    let insideNote = false;
    for (const entry of section.body) {
      if (HISTORY_NOTE_MARKER.test(entry.text)) {
        sawNote = true;
        insideNote = true;
        continue;
      }
      if (!sawNote) continue;
      if (entry.text.trim() === "") {
        insideNote = false;
        continue;
      }
      if (!insideNote) {
        violations.push(
          `第 ${entry.line} 行：补记之后又出现叙述，归档只许在段末追加补记（正文不再改写）`
        );
        insideNote = true; // one message per paragraph, not per line
      }
    }
    // `round` of each note, read again here so a marker with a missing number is
    // visible as "no notes found" below rather than as a silently dropped entry.
    const noteRounds = section.notes.map((entry) => ({
      line: entry.line,
      round: Number(HISTORY_NOTE_MARKER.exec(entry.text)[1]),
    }));
    noteRounds.forEach((note, index) => {
      if (note.round <= section.round) {
        violations.push(
          `第 ${note.line} 行：第 ${section.round} 轮段落里的补记写着第 ${note.round} 轮，补记必须晚于该段轮次`
        );
      }
      if (index > 0 && note.round <= noteRounds[index - 1].round) {
        violations.push(
          `第 ${note.line} 行：同段补记的轮次不是递增（第 ${noteRounds[index - 1].round} 轮之后是第 ${note.round} 轮）`
        );
      }
    });
  }

  for (let index = 1; index < sections.length; index += 1) {
    const above = sections[index - 1];
    const here = sections[index];
    if (above.round !== null && here.round !== null && here.round >= above.round) {
      violations.push(
        `第 ${here.line} 行：段落轮次不是递减（第 ${above.round} 轮之后是第 ${here.round} 轮），新轮次正文要加在最上面`
      );
    }
  }
  return violations;
};

// The sections the archive must carry, for the smoke test's "the rule is not
// vacuous" question: a document with no sections satisfies every "no violation"
// check above for the wrong reason.
export const historyRoundNumbers = (doc) =>
  historySections(doc)
    .map((section) => section.round)
    .filter((round) => round !== null);

// ---- the ledger is bound to the round the commit subject names ----
//
// The ledger's rows have a rule (a real road, a debt cell that agrees with it,
// consecutive rounds, no repeats) and its last row is tied to the fixed line —
// but every one of those checks reads the doc alone. A round that updated the
// code and forgot the ledger left the doc perfectly valid, just one round older
// than the commit that carried it: the fixed line and the ledger still agreed
// with each other, and the only symptom was the absence of a row nobody counted.
// Rounds 63–64 and 77 were recorded as `none` + `[UPSTREAM-DEBT]` *after the
// fact*, by later rounds that noticed; at commit time nothing said a word.
//
// So the binding is to the one place a round number cannot be forgotten without
// being visible: this repo's commit subjects always say 「第 N 轮」. The audit
// reads the current HEAD's subject, takes N, and requires the ledger's last row
// to be N or N+1. The window is deliberate, not slack:
//
//   - the doc is written *before* the commit that carries it, so while a round
//     is being prepared HEAD still names the previous round (N-1) and the ledger
//     already ends on N — N+1 relative to HEAD is the normal in-progress state;
//   - after the commit both are N;
//   - N-1 relative to HEAD is refused, and that is the whole point: it is the
//     shape of "this round landed and the ledger did not", which is exactly what
//     the ledger exists to prevent. A round that genuinely has nothing to record
//     writes a row saying so (the `none` rows are how that looks after the fact),
//     it does not leave the previous round's row standing.
//
// The two red sentences name both numbers, because "账不对" sends the reader to a
// 60-row table, while "提交信息说第 82 轮，通路账停在 81 轮" is one line to check.
export const ROUND_IN_COMMIT_SUBJECT = /第\s*(\d+)\s*轮/;

// The house style's own marker: 「第 N 轮上游核对」. Read *this* number first,
// because a subject also mentions other rounds by way of history — the commit
// that recorded round 98 opened with "…先抓出第 97 轮账加了一行…" and only later
// said 「第 98 轮上游核对」. Read as "the first round in the subject", that
// commit claimed to be round 97, one behind its own ledger row — and it passed,
// because the +1 window absorbs exactly one round. An assertion that agrees for
// the wrong reason is the thing this whole module is against, so the round is
// taken from the marker, and the plain pattern is only the fallback for
// subjects written before the marker was read (a release commit, say).
export const ROUND_WITH_CHECK_MARKER = /第\s*(\d+)\s*轮上游核对/;

// The round a commit subject claims to be. `null` when there is none — an empty
// subject (no git, a shallow copy) or a subject that does not follow the house
// style. The caller decides what to do with that; this function refuses to guess
// (a default of 0 would silently compare against a round that never existed).
export const roundFromCommitSubject = (subject) => {
  const text = String(subject == null ? "" : subject);
  const marked = ROUND_WITH_CHECK_MARKER.exec(text) || ROUND_IN_COMMIT_SUBJECT.exec(text);
  return marked ? Number(marked[1]) : null;
};

// The rule as violations. `ledgerRounds` is the ledger's round column in
// document order; `headSubject` is `git log -1 --format=%s`. Empty is the only
// acceptable answer for the repo's own HEAD.
export const ledgerRoundViolations = (ledgerRounds, headSubject) => {
  const rounds = (ledgerRounds || []).filter((round) => Number.isInteger(round));
  if (rounds.length === 0) {
    return ["核对通路账里没有可读的轮次，无法与提交信息的轮次对账"];
  }
  const headRound = roundFromCommitSubject(headSubject);
  if (headRound === null) {
    return [
      `提交信息里读不出「第 N 轮」（${JSON.stringify(String(headSubject == null ? "" : headSubject))}），` +
        "通路账因此没有可对账的轮次",
    ];
  }
  const last = rounds[rounds.length - 1];
  if (last === headRound || last === headRound + 1) return [];
  if (last < headRound) {
    return [
      `提交信息说第 ${headRound} 轮，通路账停在 ${last} 轮：这一轮的核对结论没有记账` +
        "（没核对也要记一行，欠账写 [UPSTREAM-DEBT]）",
    ];
  }
  return [
    `提交信息说第 ${headRound} 轮，通路账却记到第 ${last} 轮：` +
      `账比提交信息领先 ${last - headRound} 轮，只有本轮（或本轮之后一轮）可以提前记`,
  ];
};

// The archive's half of the rule: citations wearing a declaration's clothes.
// Empty is the answer `docs/upstream-history.md` must give.
export const findPinShapedCitations = (doc) =>
  findShaCitations(doc).filter((citation) => citation.shape !== null);

// The archive's *other* half, and not a question about line shapes: a whole
// pinned SHA in prose is an allowed shape (it is just a commit) but a forbidden
// value. `findShaCitations` cannot tell it apart from any other citation, so the
// rule is stated against `PINNED_UPSTREAM.sha` directly. A 7-character prefix is
// allowed — it is how the archive refers to the pin — and so is any whole SHA
// that is not the pin (another commit, a tag object).
//
// The pinned value is validated first: a shortened or malformed constant would
// make `includes()` match nothing, and "no leak found" would then be the answer
// for every archive. That is the one failure mode this rule must not have, so it
// fails loudly instead.
export const historyPinLeakViolations = (doc, pinned = PINNED_UPSTREAM.sha) => {
  const pin = String(pinned == null ? "" : pinned).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(pin)) {
    return [
      `pin 常量不是整串 40 位 SHA（${JSON.stringify(pinned)}）：本条按整串比较，` +
        "没有整串就无从判断归档是否泄漏了 pin",
    ];
  }
  const prefix = pin.slice(0, 7);
  return String(doc || "")
    .split(/\r?\n/)
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => text.toLowerCase().includes(pin))
    .map(
      ({ line }) =>
        `第 ${line} 行整串引用了 pin（${prefix}…）：归档只许写 7 位前缀，` +
        "pin 的整串只在同步文档里声明一次"
    );
};

// Turns a list of doc declarations into the lines the caller prints on failure.
// The shape ("文档第 X 行（where）：value vs 常量 pin") is fixed here rather than
// in the smoke test so the message cannot degrade into "mismatch" while the
// three copies are exactly the thing being compared.
export const describePinDisagreements = (pins, pinned = PINNED_UPSTREAM.sha) =>
  (pins || [])
    .filter((pin) => String(pin.sha).toLowerCase() !== String(pinned).toLowerCase())
    .map((pin) => `文档第 ${pin.line} 行（${pin.where}）：${pin.sha} vs 常量 ${pinned}`);

const gitRunner = () =>
  spawnSync("git", ["ls-remote", UPSTREAM_URL, UPSTREAM_REF], {
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });

// The second road to the same SHA. `git` is tried first because it needs no
// rate limit and no token; the API is here because five rounds were recorded as
// "git timed out" while `api.github.com` answered the same question.
const apiRunner = async () => {
  try {
    const response = await fetch(UPSTREAM_API, {
      headers: {
        "User-Agent": "open-code-review-desktop-upstream-watch",
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      return { ok: false, failure: `GitHub API HTTP ${response.status}`, channel: "none" };
    }
    const sha = parseApiCommit(await response.json());
    if (!sha) {
      return { ok: false, failure: "GitHub API 没有给出完整 40 位 SHA", channel: "none" };
    }
    return { ok: true, sha, channel: "api" };
  } catch (error) {
    return {
      ok: false,
      failure: `GitHub API ${error && error.message ? error.message : "不可达"}`,
      channel: "none",
    };
  }
};

// The orchestration the command actually runs: git first, the API only when git
// gave no answer, and both failure sentences kept when neither did.
//
// Written as a factory because this ordering is invisible from the outside
// until the network breaks in a particular way — the case that created it (a
// timed-out git while the API could answer) was recorded as "skipped" for five
// rounds. `tools/upstream-watch-smoke.mjs` passes stub roads in and asserts the
// three orders: git alone, git-then-api, and neither.
//
// A road that *throws* is treated as a road that failed, not as the end of the
// orchestration: `spawnSync` normally returns an error object rather than
// throwing, but "normally" is the assumption a fallback exists to survive. The
// failure sentence names the road it came from, because "git: …；api: …" is the
// only thing that tells the reader both roads were tried.
export const createRunner = ({ runGit = gitRunner, runApi = apiRunner } = {}) => async () => {
  let git;
  try {
    git = classifyGit(runGit());
  } catch (error) {
    git = { ok: false, failure: `git ls-remote 抛错：${(error && error.message) || error}`, channel: "none" };
  }
  if (git.ok) return git;
  let api;
  try {
    api = await runApi();
  } catch (error) {
    api = { ok: false, failure: `GitHub API 抛错：${(error && error.message) || error}`, channel: "none" };
  }
  if (api && api.ok) return api;
  return {
    ok: false,
    failure: `git: ${git.failure}；api: ${(api && api.failure) || "GitHub API 没有给出答案"}`,
    channel: "none",
  };
};

export const defaultRunner = createRunner();

// `code` is always 0: a moved HEAD and an unreachable network are both answers,
// not failures, and this command must stay safe to call from any script.
//
// `reference` / `referenceRound` are the last checked HEAD and the round that
// recorded it (see `referenceFromDoc`). They are parameters rather than reads so
// the smoke test can ask the override question directly — "does handing in a
// different reference change the verdict?" — which is the one thing that proves
// the command compares against the recorded HEAD and not the release pin.
export const runUpstreamWatch = async (
  run = defaultRunner,
  { reference = PINNED_UPSTREAM.sha, referenceRound = null } = {}
) => {
  let result;
  try {
    result = await run();
  } catch (error) {
    const verdict = upstreamDrift({ ok: false, failure: error && error.message });
    return { verdict, text: formatDrift(verdict), code: 0 };
  }
  const ok = Boolean(result) && result.ok === true;
  const verdict = upstreamDrift({
    ok,
    sha: ok ? result.sha : null,
    pinned: reference,
    referenceRound,
    failure: result && result.failure,
    channel: result && result.channel,
  });
  return { verdict, text: formatDrift(verdict), code: 0 };
};

// The command's own reading of the doc: which commit the last checking round
// recorded. A doc that cannot answer is *not* silently replaced by the pin —
// that substitution is exactly how the old sentence kept saying "已前进"; it is
// reported as debt, with the reason naming the line the rule wanted.
export const watchFromDoc = async (run = defaultRunner, doc = "") => {
  const reference = referenceFromDoc(doc);
  if (!reference.ok) {
    const verdict = { state: "skipped", reason: reference.reason, channel: "none" };
    return { verdict, text: formatDrift(verdict), code: 0 };
  }
  return runUpstreamWatch(run, { reference: reference.sha, referenceRound: reference.round });
};

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntryPoint) {
  let doc = "";
  try {
    doc = readFileSync(path.resolve(UPSTREAM_SYNC_DOC), "utf8");
  } catch (error) {
    const verdict = {
      state: "skipped",
      reason: `读不到 ${UPSTREAM_SYNC_DOC}（${(error && error.message) || error}）`,
      channel: "none",
    };
    console.log(formatDrift(verdict));
    process.exit(0);
  }
  const { text, code } = await watchFromDoc(defaultRunner, doc);
  console.log(text);
  process.exitCode = code;
}
