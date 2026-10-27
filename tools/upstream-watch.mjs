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
import path from "node:path";
import { pathToFileURL } from "node:url";

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
// moving from `375f64cd6f67…` to `375f64cf…` would then be reported as "与对照表
// 一致，无需重读" — the one direction this sentence must never be wrong in, since
// every row of the table would silently be stale. With the whole 40 characters
// pinned, that case is `moved`: over-reporting drift costs a re-read, under-
// reporting it costs correctness.
//
// The value is upstream `refs/heads/main` as of `v1.13.3`; `docs/OCR-UPSTREAM-SYNC.md`
// carries the same 40 characters on its fixed "本轮 HEAD 核对" line and the smoke
// test keeps the two exactly equal.
export const PINNED_UPSTREAM = Object.freeze({
  sha: "375f64cd6f67a48a135da83cfcf59c52669a09cb",
  tag: "v1.13.3",
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

// The three answers: `pinned` (same as the doc), `moved` (re-read the rows),
// `skipped` (no answer this run — explicitly *not* "unchanged").
//
// A short `pinned` (or a short SHA from the runner) is refused as `skipped`
// rather than prefix-matched. Prefix matching would answer "pinned" for a
// different commit that happens to share the recorded prefix, and a wrong
// "pinned" is invisible: nobody re-reads a row that says nothing changed.
// `skipped` at least says the round did not really check.
export const upstreamDrift = ({ ok, sha, pinned = PINNED_UPSTREAM.sha, failure = "", channel = "" }) => {
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
    channel: channel || "git",
  };
};

export const formatDrift = (verdict, rows = ROWS_TO_REREAD) => {
  const via = verdict.channel || "none";
  if (verdict.state === "skipped") {
    return `${DEBT_MARKER} 上游 HEAD 核对：跳过（${verdict.reason}；通路：${via}；本轮未核对，不等于上游没变）`;
  }
  if (verdict.state === "pinned") {
    return `上游 HEAD 核对：${verdict.pinned}（与对照表一致，无需重读；通路：${via}）`;
  }
  // When the two commits share the readable 7-character prefix, the arrow alone
  // would print `375f64c → 375f64c` — technically "moved" but read as a typo. Say
  // out loud that the difference is further in, and keep the whole SHA on the
  // next line so the reader can compare character by character.
  const from = verdict.pinned.slice(0, 7);
  const to = verdict.sha.slice(0, 7);
  const arrow = from === to ? `${from} → ${to}（前 7 位相同，区别在后面）` : `${from} → ${to}`;
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
    `${MOVED_MARKER} 上游 HEAD 已前进：${arrow}（通路：${via}）`,
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
    const hit = matchPinShape(line);
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

// ---- what the archive may quote, and what only the sync doc may declare ----
//
// `docs/upstream-history.md` quotes upstream commits in prose — whole
// 40-character SHAs included (the round's `refs/heads/main`, the annotated tag
// object id). That is *not* a pin declaration, and the archive is deliberately
// allowed to do it: a commit *is* 40 hex characters, so any check written as
// "find the 40 hex characters" sees those lines too.
//
// So the rule is stated as two halves instead of one regex:
//
//   allowed   — a whole SHA cited in prose (`refs/heads/main` = `<sha>`), the
//               tag object a tag points at, and the paragraph explaining why the
//               pin stores 40 characters rather than a readable prefix;
//   forbidden — any of the declaration shapes in `PIN_PLACES`: the machine
//               block, the fixed "本轮 HEAD 核对" line, the prose sentence that
//               introduces `upstream:check`. Declarations live in the sync doc
//               and nowhere else, exactly once per place.
//
// `findShaCitations` answers which of the two a line is, so the smoke test can
// assert the archive's rule itself instead of inferring it from "no pin was
// found" — that inference also passes once `findDocPins` stops matching shapes
// at all. Both lists are exported so a failure can print the rule, not just the
// violation.
export const HISTORY_ALLOWED_SHA_CONTEXTS = Object.freeze([
  "轮次叙述里直接引用某个 commit（`refs/heads/main` = `<40 位>`）",
  "叙述里引用 annotated tag 对象 id（`refs/tags/vN.N.N` 指向的那个）",
  "解释 pin 为什么存全 40 位、而不是 7 位前缀的规则段落",
]);

// The rule as one readable sentence, built from the two lists so it cannot go
// stale when a shape is added. The smoke test asserts the sentence names every
// place and keeps the "40 位" allowance.
export const historyShaRule = () =>
  `归档允许整串 40 位 SHA 的自由引用（${HISTORY_ALLOWED_SHA_CONTEXTS.join("；")}），` +
  `但任何一行都不许用 pin 声明形状（${PIN_PLACES.join("、")}）：声明只写在同步文档里，每处恰好一次。`;

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

// The round a commit subject claims to be. `null` when there is none — an empty
// subject (no git, a shallow copy) or a subject that does not follow the house
// style. The caller decides what to do with that; this function refuses to guess
// (a default of 0 would silently compare against a round that never existed).
export const roundFromCommitSubject = (subject) => {
  const hit = ROUND_IN_COMMIT_SUBJECT.exec(String(subject == null ? "" : subject));
  return hit ? Number(hit[1]) : null;
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
export const runUpstreamWatch = async (run = defaultRunner) => {
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
    failure: result && result.failure,
    channel: result && result.channel,
  });
  return { verdict, text: formatDrift(verdict), code: 0 };
};

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isEntryPoint) {
  const { text, code } = await runUpstreamWatch();
  console.log(text);
  process.exitCode = code;
}
