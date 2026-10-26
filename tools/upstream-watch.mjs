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
// the net is `audit:service` / `audit:config` / `audit:git` plus the four rows
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

// Exactly the rows the sync doc's table wants re-read when upstream moves. Kept
// here rather than in the doc so the warning and the table cannot drift apart:
// `tools/upstream-watch-smoke.mjs` checks that each label still appears in the
// table.
export const ROWS_TO_REREAD = Object.freeze([
  "provider 解析顺序 —— internal/llm/resolver.go（同步改 UPSTREAM_RESOLVER 与 MATCH_RULES）",
  "`config set` 的 key 语法 —— cmd/opencodereview/config_cmd.go",
  "内置服务表（列 / 表头 / 失败 stderr）—— `ocr llm providers`",
  "运行期失败分类 —— failure_class 两张表",
]);

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

export const formatDrift = (verdict) => {
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
  return [
    `${MOVED_MARKER} 上游 HEAD 已前进：${arrow}（通路：${via}）`,
    `   新 HEAD 全 40 位：${verdict.sha}`,
    "   这不是失败，但 docs/OCR-UPSTREAM-SYNC.md 下面四行需要重读源码，而不是只看 SHA：",
    ...ROWS_TO_REREAD.map((row) => `   - ${row}`),
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
// The shapes outside the block. `g` is not used: each rule is applied to one
// line and the first match is the declaration.
const PIN_LINE_RULES = [
  { where: "本轮 HEAD 核对 行", re: new RegExp("本轮 HEAD 核对：`" + SHA_IN_LINE + "`") },
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
