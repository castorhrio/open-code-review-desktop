// Pins the three answers `tools/upstream-watch.mjs` can give, and ties the pin
// to the sync doc.
//
// Why this exists: the sentinel's whole value is that its sentence can be read
// without a human re-checking it. That only holds if (a) a moved / unreachable /
// unchanged HEAD are classified from the *output shape*, not from today's
// network, (b) the command never fails a surrounding script, and (c) the SHA the
// doc was written against is the SHA the command compares. Any of those three
// drifting turns the sentence back into noise, and none of them shows up in a
// normal run.
//
// No network, no Electron, no CLI. Run with `npm run audit:upstream`.
import fs from "node:fs";
import path from "node:path";

import {
  DEBT_MARKER,
  PINNED_UPSTREAM,
  ROWS_TO_REREAD,
  classifyGit,
  formatDrift,
  parseApiCommit,
  parseLsRemote,
  runUpstreamWatch,
  upstreamDrift,
} from "./upstream-watch.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SYNC_DOC = path.join(ROOT, "docs", "OCR-UPSTREAM-SYNC.md");

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const PINNED_SHA = PINNED_UPSTREAM.sha;
// A full-length commit that is not the pinned one. Written out rather than
// derived from the pin, so "moved" cannot become "pinned" by editing one string.
const OTHER_SHA = "abcdef0" + "0".repeat(33);
// The pinned commit with a different tail. The first 7 characters are derived
// from the pin on purpose — that is the collision shape under test; the other 33
// are written out as `f`, so this is a prefix collision rather than the pin
// itself. (An earlier comment claimed the whole value was written out, which was
// not what the code did.)
const SAME_PREFIX_SHA = PINNED_SHA.slice(0, 7) + "f".repeat(33);

/* ---- the pin itself ---- */
{
  check(
    "the pin is a whole 40-character commit, not the readable 7-character prefix",
    /^[0-9a-f]{40}$/i.test(PINNED_SHA),
    PINNED_SHA
  );
  check(
    "the pin still names the release the doc's table was written against",
    PINNED_UPSTREAM.tag === "v1.13.3" && /^v\d+\.\d+\.\d+$/.test(PINNED_UPSTREAM.tag),
    PINNED_UPSTREAM.tag
  );
}

/* ---- reading `git ls-remote` output ---- */
{
  const tag = "dd925205e108304bd4dd6cc0f8e8b7cf8dee77ea";
  const both = `${tag}\trefs/tags/v1.13.3\n${PINNED_SHA}\trefs/heads/main\n`;
  check(
    "the default branch's SHA is read out of a multi-ref ls-remote answer",
    parseLsRemote(both) === PINNED_SHA,
    JSON.stringify(parseLsRemote(both))
  );
  check(
    "CRLF and trailing spaces do not change the answer",
    parseLsRemote(`  ${PINNED_SHA}  \trefs/heads/main  \r\n`) === PINNED_SHA,
    JSON.stringify(parseLsRemote(`  ${PINNED_SHA}  \trefs/heads/main  \r\n`))
  );
  check(
    "a tag-only answer is not mistaken for the default branch",
    parseLsRemote(`${tag}\trefs/tags/v1.13.3\n`) === null,
    JSON.stringify(parseLsRemote(`${tag}\trefs/tags/v1.13.3\n`))
  );
  check(
    "a malformed SHA is refused instead of reported as a moved HEAD",
    parseLsRemote("not-a-sha\trefs/heads/main\n") === null,
    JSON.stringify(parseLsRemote("not-a-sha\trefs/heads/main\n"))
  );
  check(
    "a short SHA is refused as well: it cannot say *which* commit it is",
    parseLsRemote(`${PINNED_SHA.slice(0, 7)}\trefs/heads/main\n`) === null,
    JSON.stringify(parseLsRemote(`${PINNED_SHA.slice(0, 7)}\trefs/heads/main\n`))
  );
}

/* ---- the second road (GitHub API) and how a git answer is classified ---- */
{
  check(
    "the API's whole 40-character sha is accepted on the same terms as git",
    parseApiCommit({ sha: PINNED_SHA }) === PINNED_SHA,
    JSON.stringify(parseApiCommit({ sha: PINNED_SHA }))
  );
  check(
    "a short / missing API sha is refused, not trusted because the road is different",
    parseApiCommit({ sha: PINNED_SHA.slice(0, 7) }) === null &&
      parseApiCommit({}) === null &&
      parseApiCommit(null) === null,
    JSON.stringify([
      parseApiCommit({ sha: PINNED_SHA.slice(0, 7) }),
      parseApiCommit({}),
      parseApiCommit(null),
    ])
  );
  const gitOk = classifyGit({ status: 0, stdout: `${PINNED_SHA}\trefs/heads/main\n` });
  check(
    "a successful git answer names git as the channel",
    gitOk.ok && gitOk.sha === PINNED_SHA && gitOk.channel === "git",
    JSON.stringify(gitOk)
  );
  check(
    "a timed-out git answer is not ok and claims no channel",
    classifyGit({ error: new Error("ETIMEDOUT") }).ok === false &&
      classifyGit({ error: new Error("ETIMEDOUT") }).channel === "none",
    JSON.stringify(classifyGit({ error: new Error("ETIMEDOUT") }))
  );
  check(
    "a non-zero git exit is not ok",
    classifyGit({ status: 128, stderr: "fatal: unable to access" }).ok === false,
    JSON.stringify(classifyGit({ status: 128 }))
  );
  check(
    "a git answer with no default-branch line is not ok",
    classifyGit({ status: 0, stdout: "" }).ok === false &&
      classifyGit({ status: 0, stdout: "" }).failure.includes("refs/heads/main"),
    JSON.stringify(classifyGit({ status: 0, stdout: "" }))
  );
}

/* ---- the three verdicts ---- */
{
  const pinned = upstreamDrift({ ok: true, sha: PINNED_SHA });
  check(
    "the pinned commit is pinned",
    pinned.state === "pinned" && pinned.pinned === PINNED_SHA,
    JSON.stringify(pinned)
  );
  check(
    "a pinned verdict says which road answered, defaulting to git",
    pinned.channel === "git",
    JSON.stringify(pinned.channel)
  );
  check(
    "...and can say api when the git road was the one that failed",
    upstreamDrift({ ok: true, sha: PINNED_SHA, channel: "api" }).channel === "api",
    JSON.stringify(upstreamDrift({ ok: true, sha: PINNED_SHA, channel: "api" }))
  );
  check(
    "a skipped verdict claims no road, because no road answered",
    upstreamDrift({ ok: false }).channel === "none",
    JSON.stringify(upstreamDrift({ ok: false }))
  );
  check(
    "the pin comparison ignores SHA case",
    upstreamDrift({ ok: true, sha: PINNED_SHA.toUpperCase() }).state === "pinned",
    JSON.stringify(upstreamDrift({ ok: true, sha: PINNED_SHA.toUpperCase() }))
  );
  const moved = upstreamDrift({ ok: true, sha: OTHER_SHA });
  check(
    "any other SHA is moved, and keeps the whole SHA for the sentence",
    moved.state === "moved" && moved.sha === OTHER_SHA && moved.pinned === PINNED_SHA,
    JSON.stringify(moved)
  );
  // The one case a short pin would get wrong *and silently*: a new commit that
  // shares the recorded prefix. Under prefix matching this is "pinned", i.e. the
  // doc's four rows would stay unread with a green sentence on top of them.
  const samePrefix = upstreamDrift({ ok: true, sha: SAME_PREFIX_SHA });
  check(
    "a SHA that only shares the pin's first 7 characters is moved, not pinned",
    samePrefix.state === "moved" && samePrefix.sha === SAME_PREFIX_SHA,
    JSON.stringify(samePrefix)
  );
  check(
    "...and a short pin is refused as skipped instead of being prefix-matched",
    upstreamDrift({ ok: true, sha: PINNED_SHA, pinned: PINNED_SHA.slice(0, 7) }).state === "skipped",
    JSON.stringify(upstreamDrift({ ok: true, sha: PINNED_SHA, pinned: PINNED_SHA.slice(0, 7) }))
  );
  const shortPin = upstreamDrift({ ok: true, sha: PINNED_SHA, pinned: PINNED_SHA.slice(0, 7) });
  check(
    "...and says why: a prefix is not a commit",
    shortPin.reason.includes("40") && shortPin.reason.includes("同一个 commit"),
    shortPin.reason
  );
  check(
    "a short SHA from the runner is skipped too, never judged as pinned",
    upstreamDrift({ ok: true, sha: PINNED_SHA.slice(0, 7) }).state === "skipped",
    JSON.stringify(upstreamDrift({ ok: true, sha: PINNED_SHA.slice(0, 7) }))
  );
  check(
    "a failed ls-remote is skipped, never 'unchanged'",
    upstreamDrift({ ok: false }).state === "skipped" &&
      upstreamDrift({ ok: false }).reason.includes("不可达"),
    JSON.stringify(upstreamDrift({ ok: false }))
  );
  check(
    "the runner's own failure message survives into the reason",
    upstreamDrift({ ok: false, failure: "boom" }).reason === "boom",
    JSON.stringify(upstreamDrift({ ok: false, failure: "boom" }))
  );
  check(
    "a successful command with no default-branch line is skipped, not pinned",
    upstreamDrift({ ok: true, sha: null }).state === "skipped" &&
      upstreamDrift({ ok: true, sha: null }).reason.includes("refs/heads/main"),
    JSON.stringify(upstreamDrift({ ok: true, sha: null }))
  );
  check(
    "a caller-supplied full pin drives the comparison instead of the module constant",
    upstreamDrift({ ok: true, sha: OTHER_SHA, pinned: OTHER_SHA }).state === "pinned",
    JSON.stringify(upstreamDrift({ ok: true, sha: OTHER_SHA, pinned: OTHER_SHA }))
  );
}

/* ---- the sentence each verdict prints ---- */
{
  const skipped = formatDrift(upstreamDrift({ ok: false }));
  check(
    "the skipped sentence says 跳过 and refuses to imply 'unchanged'",
    skipped.includes("跳过") && skipped.includes("不等于上游没变") && !skipped.includes("与对照表一致"),
    skipped
  );
  check(
    "the skipped sentence starts with the greppable debt marker and names no road",
    skipped.startsWith(DEBT_MARKER) && skipped.includes("通路：none"),
    skipped
  );
  const pinned = formatDrift(upstreamDrift({ ok: true, sha: PINNED_SHA }));
  check(
    "the pinned sentence names the whole SHA, the git road, and says no rows need re-reading",
    pinned.includes(PINNED_SHA) && pinned.includes("一致") && pinned.includes("通路：git"),
    pinned
  );
  check(
    "the pinned sentence carries no debt marker",
    !pinned.includes(DEBT_MARKER),
    pinned
  );
  const pinnedApi = formatDrift(upstreamDrift({ ok: true, sha: PINNED_SHA, channel: "api" }));
  check(
    "the pinned sentence names the API road when that is the one that answered",
    pinnedApi.includes("通路：api") && !pinnedApi.includes(DEBT_MARKER),
    pinnedApi
  );
  const moved = formatDrift(upstreamDrift({ ok: true, sha: OTHER_SHA }));
  check(
    "the moved sentence is prominent, names the new SHA and the road, and says it is not a failure",
    moved.includes("已前进") &&
      moved.includes("abcdef0") &&
      moved.includes(OTHER_SHA) &&
      moved.includes("通路：git") &&
      moved.includes("不是失败") &&
      !moved.includes(DEBT_MARKER),
    moved
  );
  const labels = ROWS_TO_REREAD.map((row) => row.match(/^[^（—]+/)[0].trim());
  check(
    "the moved sentence lists every row that needs re-reading",
    labels.every((label) => moved.includes(label)),
    JSON.stringify(labels)
  );
  check(
    "exactly four source rows are listed, because the table has four core rows",
    ROWS_TO_REREAD.length === 4 && new Set(ROWS_TO_REREAD).size === 4,
    JSON.stringify(ROWS_TO_REREAD)
  );
  // The prefix-collision sentence must not be mistakable for the quiet one.
  const movedSamePrefix = formatDrift(upstreamDrift({ ok: true, sha: SAME_PREFIX_SHA }));
  check(
    "the same-prefix sentence does not read as a typo: it says the two prefixes match",
    movedSamePrefix.includes("已前进") &&
      movedSamePrefix.includes(SAME_PREFIX_SHA) &&
      movedSamePrefix.includes("前 7 位相同"),
    movedSamePrefix.split("\n")[0]
  );
  check(
    "...and the plain moved sentence does not carry that aside",
    !moved.includes("前 7 位相同"),
    moved.split("\n")[0]
  );
}

/* ---- the command never fails a caller ---- */
{
  const cases = [
    ["pinned", () => ({ ok: true, sha: PINNED_SHA, channel: "git" }), "pinned"],
    ["pinned via the API", () => ({ ok: true, sha: PINNED_SHA, channel: "api" }), "pinned"],
    ["moved", () => ({ ok: true, sha: OTHER_SHA, channel: "git" }), "moved"],
    ["same prefix", () => ({ ok: true, sha: SAME_PREFIX_SHA, channel: "git" }), "moved"],
    ["non-zero exit", () => ({ ok: false, failure: "git ls-remote 退出码非 0（128）" }), "skipped"],
    ["thrown spawn", () => {
      throw new Error("spawn git ENOENT");
    }, "skipped"],
    ["timeout object", () => ({ ok: false, failure: "ETIMEDOUT" }), "skipped"],
    ["empty answer", () => ({ ok: false, sha: null, failure: "ls-remote 输出里没有 refs/heads/main" }), "skipped"],
    ["null result", () => null, "skipped"],
  ];
  for (const [name, runner, expected] of cases) {
    const result = await runUpstreamWatch(runner);
    check(
      `${name}: classified ${expected} and exit code stays 0`,
      result.verdict.state === expected && result.code === 0,
      JSON.stringify({ state: result.verdict.state, code: result.code })
    );
    // The debt marker is the ledger: a skipped run must be greppable, and a
    // checked run must not falsely look like debt.
    check(
      `${name}: ${expected === "skipped" ? "carries" : "does not carry"} the debt marker`,
      result.text.includes(DEBT_MARKER) === (expected === "skipped"),
      result.text
    );
    if (name === "thrown spawn") {
      check(
        "a thrown spawn error keeps its message in the skipped reason",
        result.verdict.reason.includes("spawn git ENOENT"),
        JSON.stringify(result.verdict)
      );
    }
  }
  const moved = await runUpstreamWatch(() => ({ ok: true, sha: OTHER_SHA, channel: "git" }));
  check("the command's text is the formatted verdict", moved.text === formatDrift(moved.verdict), moved.text);
}

/* ---- the doc's fixed line and the module pin cannot drift ---- */
{
  const doc = fs.readFileSync(SYNC_DOC, "utf8");
  // One line, fixed shape: the reader should not have to skim a paragraph to
  // learn whether the current round was actually checked. It carries the whole
  // 40-character commit for the same reason the pin does — a 7-character prefix
  // cannot tell two commits apart.
  const match = doc.match(/本轮 HEAD 核对：`([0-9a-f]{7,40})`（([^）]+)）/);
  check(
    "the sync doc carries a fixed '本轮 HEAD 核对' line with a SHA and a qualifier",
    match !== null && match[2].trim().length > 0,
    match ? `${match[1]}（${match[2]}）` : "missing"
  );
  check(
    "that line's SHA is exactly the SHA the sentinel compares against",
    match !== null && match[1].toLowerCase() === PINNED_SHA.toLowerCase(),
    match ? `${match[1]} vs ${PINNED_SHA}` : "missing"
  );
  check(
    "the doc's fixed line is a whole commit too, not a prefix",
    match !== null && match[1].length === 40,
    match ? `${match[1].length} chars` : "missing"
  );
  const channel = match ? /通路：(git|api|npm|none)/.exec(match[2]) : null;
  check(
    "the fixed line says which road checked the HEAD this round",
    channel !== null,
    match ? match[2] : "missing"
  );
  const tableAt = doc.indexOf("| 对照点 | 上游文件 |");
  check(
    "the fixed line sits above the comparison table, not buried below it",
    match !== null && tableAt !== -1 && doc.indexOf("本轮 HEAD 核对：") < tableAt,
    `line=${match ? doc.indexOf("本轮 HEAD 核对：") : -1} table=${tableAt}`
  );
  // The ledger turns "this round was checked over npm only" into a row instead
  // of a paragraph. The rule the rows must obey is the useful part: npm can
  // report a release but not the default branch's commit, so an npm-only round
  // owes the HEAD check; git and the API can answer it, so they owe nothing.
  const ledgerAt = doc.indexOf("### 核对通路账");
  check(
    "the sync doc carries the per-round check ledger",
    ledgerAt !== -1,
    String(ledgerAt)
  );
  const ledgerSection = ledgerAt !== -1 && tableAt !== -1 ? doc.slice(ledgerAt, tableAt) : "";
  const ledgerRows = ledgerSection
    .split("\n")
    .filter((line) => /^\|\s*\d+\s*\|/.test(line))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  check(
    "the ledger has a row for every round in the network-debt era",
    ledgerRows.length >= 10,
    `${ledgerRows.length} row(s)`
  );
  const badLedgerRows = ledgerRows.filter(([, , via, , debt]) => {
    if (!["git", "api", "npm", "none"].includes(via)) return true;
    const owesHead = via === "npm" || via === "none";
    return debt.includes(DEBT_MARKER) !== owesHead;
  });
  check(
    "every ledger row names a real road, and its debt cell agrees with that road",
    badLedgerRows.length === 0,
    JSON.stringify(badLedgerRows)
  );
  const latestLedger = ledgerRows[ledgerRows.length - 1];
  const fixedRound = match ? /第\s*(\d+)\s*轮/.exec(match[2]) : null;
  check(
    "the ledger ends on the round the fixed line claims to be",
    latestLedger && fixedRound && Number(latestLedger[0]) === Number(fixedRound[1]),
    JSON.stringify({ ledger: latestLedger && latestLedger[0], fixed: fixedRound && fixedRound[1] })
  );
  check(
    "the fixed line's road agrees with the ledger's last row",
    latestLedger !== undefined && channel !== null && latestLedger[2] === channel[1],
    JSON.stringify({ ledger: latestLedger && latestLedger[2], fixed: channel && channel[1] })
  );
  const labels = ROWS_TO_REREAD.map((row) => row.match(/^[^（—]+/)[0].trim());
  check(
    "each row the sentinel names still exists in the table",
    labels.every((label) => doc.includes(label)),
    JSON.stringify(labels.filter((label) => !doc.includes(label)))
  );
}

console.log(`\n${failures.length ? `${failures.length} failed` : "all upstream-watch checks passed"}`);
if (failures.length) {
  console.error(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
