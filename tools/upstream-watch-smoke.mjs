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
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTHORING_HUMAN_HEADING,
  AUTHORING_RULES_HEADING,
  AUTHORING_RULES_MIN,
  AUTHORING_SCRIPT_HEADING,
  AUTHORING_SCRIPT_POINTER,
  DEBT_MARKER,
  HISTORY_ALLOWED_SHA_CONTEXTS,
  HISTORY_APPEND_RULE_TERMS,
  HISTORY_NOTE_MARKER,
  MACHINE_READABLE_ANCHORS,
  MACHINE_READABLE_END,
  MACHINE_READABLE_START,
  MOVED_MARKER,
  PINNED_UPSTREAM,
  PIN_BLOCK_END,
  PIN_BLOCK_START,
  PIN_LINE_SHAPES,
  PIN_PLACES,
  ROWS_TO_REREAD,
  ROW_SOURCES,
  TABLE_HEADER,
  UPSTREAM_HISTORY_DOC,
  classifyGit,
  comparisonTableRows,
  createRunner,
  describePinDisagreements,
  dependencyPinViolations,
  UPSTREAM_PACKAGE,
  versionInRange,
  docAuthoringRuleViolations,
  docTruncationViolations,
  docPointers,
  productDocViolations,
  dodAuthorityViolations,
  dodCheckboxViolations,
  dodChecklist,
  dodEvidenceCandidates,
  dodEvidenceCandidateViolations,
  dodEvidenceBodyViolations,
  auditScriptClosure,
  dodHarnessReachViolations,
  DOD_HARNESS_PATH,
  dodReasons,
  dodReasonViolations,
  dodConfirmationViolations,
  DOD_CONFIRMATION_MARK,
  DOD_REASON_MARK,
  unverifiedTable,
  unverifiedRowViolations,
  UNVERIFIED_OWNERS,
  UNVERIFIED_COLUMNS,
  UNVERIFIED_UPSTREAM_DOC,
  DOD_EVIDENCE_SHAPES,
  dodEvidenceTarget,
  DOD_CANDIDATE_MARK,
  dodPinViolations,
  DOD_VERSION_TOKEN,
  DOD_CHECKBOX_IDS,
  DOD_EVIDENCE_MARK,
  PRODUCT_DOD_DOC,
  DOD_DRAFT_TERMS,
  README_FILES,
  README_INTERNAL_TERMS,
  firstScreenViolations,
  readmeInternalTermViolations,
  DANGLING_LINE_ENDINGS,
  HUMAN_SECTIONS,
  humanSectionViolations,
  LEDGER_HEADING,
  ledgerRowsIn,
  ledgerTableViolations,
  findDocPins,
  findPinShapedCitations,
  findShaCitations,
  formatDrift,
  historyAppendRule,
  historyAppendViolations,
  historyRoundNumbers,
  historySections,
  historyShaRule,
  historyPinLeakViolations,
  ledgerRoundViolations,
  machineReadableBlockViolations,
  parseApiCommit,
  parseLsRemote,
  pinPlaceCoverage,
  pinVersion,
  previousRoundPointerViolations,
  headingSlug,
  roundFromCommitSubject,
  ROUND_IN_COMMIT_SUBJECT,
  runUpstreamWatch,
  tableRowCoverage,
  upstreamDrift,
} from "./upstream-watch.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SYNC_DOC = path.join(ROOT, "docs", "OCR-UPSTREAM-SYNC.md");
const HISTORY_DOC = path.join(ROOT, ...UPSTREAM_HISTORY_DOC.split("/"));

// The text of the log above `line` (1-based). Used to read the archive's own
// preamble: the rule about appending notes has to be stated there, before the
// first archived section, not buried inside one of them.
const historyLinesBefore = (history, line) => history.split(/\r?\n/).slice(0, line - 1).join("\n");

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

/* ---- the self-test switches are command-line flags, not the environment ----
 * This suite re-runs itself at the bottom to prove two things: that a failed
 * check reaches `process.exit(1)` (the red child), and that a run which should
 * be green is not red by construction (the green child). Those two roles used to
 * be selected by environment variables, which has a failure mode unrelated to
 * this suite: a CI job, a shell profile, or a user who happens to export the
 * same name changes what `npm run audit:upstream` does. An argv token is present
 * only when this file's own spawn put it there.
 *
 * The two flags are different tokens on purpose. "Not the self-test" is exactly
 * the state in which the bottom block spawns, so the green child needs a switch
 * of its own to say "run, but do not re-spawn": one flag cannot express both
 * halves without re-entering forever, and a hang reads as a slow machine rather
 * than as a failure. Exact tokens, not prefixes — `--selftest=1` and a bare
 * `selftest` are not switches, so a typo cannot silently select a mode.
 */
const FLAGS = Object.freeze({
  selftest: "--selftest",
  noRespawn: "--no-respawn",
});

const parseFlags = (argv) => ({
  selftest: (argv || []).includes(FLAGS.selftest),
  noRespawn: (argv || []).includes(FLAGS.noRespawn),
});

const flags = parseFlags(process.argv.slice(2));

if (flags.selftest) {
  check(
    "[self-test] a check that fails on purpose",
    false,
    "injected by the exit-code self-test"
  );
}

// The switches as a pure question, asked before any child exists. The old
// environment scheme could not make this check: "unset" and "set to something
// unexpected" were two states that both looked like the normal run. Here, a
// list with neither token means the normal run by construction.
{
  check(
    "no flags: neither the self-test nor the no-respawn switch is on — nothing is inferred",
    parseFlags([]).selftest === false && parseFlags([]).noRespawn === false,
    JSON.stringify(parseFlags([]))
  );
  check(
    "...and only the exact tokens switch a mode on: near-misses stay off",
    parseFlags([FLAGS.selftest]).selftest === true &&
      parseFlags([FLAGS.selftest]).noRespawn === false &&
      parseFlags([FLAGS.noRespawn]).noRespawn === true &&
      parseFlags([FLAGS.noRespawn]).selftest === false &&
      parseFlags(["selftest", "--selftest=1", "--no-respawn=1"]).selftest === false &&
      parseFlags(["selftest", "--selftest=1", "--no-respawn=1"]).noRespawn === false,
    JSON.stringify([
      parseFlags([FLAGS.selftest]),
      parseFlags([FLAGS.noRespawn]),
      parseFlags(["selftest", "--selftest=1", "--no-respawn=1"]),
    ])
  );
}

const PINNED_SHA = PINNED_UPSTREAM.sha;
// A full-length commit that is not the pinned one. Written out rather than
// derived from the pin, so "moved" cannot become "pinned" by editing one string.
const OTHER_SHA = "abcdef0" + "0".repeat(33);
// The pinned commit with a different tail. The first 7 characters are derived
// from the pin on purpose — that is the collision shape under test; the tail is
// hardcoded to 33 characters with no `f` in it, so the two halves add up to a
// 40-character commit that cannot collapse into the pin by construction.
const SAME_PREFIX_TAIL = "0123456789abcde0123456789abcde012";
const SAME_PREFIX_SHA = PINNED_SHA.slice(0, 7) + SAME_PREFIX_TAIL;

/* ---- the fixtures themselves, before anything is concluded from them ---- */
{
  // A fixture that equals the pin turns "moved, not pinned" into "pinned": the
  // check would still be green while testing nothing. Pin changes are exactly
  // when this drifts (the tail is written out, so a new pin whose tail matched
  // it would collapse the two), hence an explicit guard rather than a comment.
  check(
    "the prefix-collision fixture is a different commit from the pin",
    SAME_PREFIX_SHA !== PINNED_SHA,
    `${SAME_PREFIX_SHA} vs ${PINNED_SHA}`
  );
  check(
    "...and it is still a 40-character commit that shares the pin's first 7",
    /^[0-9a-f]{40}$/.test(SAME_PREFIX_SHA) &&
      SAME_PREFIX_SHA.slice(0, 7) === PINNED_SHA.slice(0, 7) &&
      SAME_PREFIX_SHA.slice(7) === SAME_PREFIX_TAIL &&
      SAME_PREFIX_TAIL.length === 33,
    JSON.stringify({ sha: SAME_PREFIX_SHA, tail: SAME_PREFIX_TAIL })
  );
  check(
    "...and the written-out tail differs from the pin's, so the collision is real",
    PINNED_SHA.slice(7) !== SAME_PREFIX_TAIL,
    JSON.stringify({ pinTail: PINNED_SHA.slice(7), fixtureTail: SAME_PREFIX_TAIL })
  );
  check(
    "the 'moved' fixture is a whole commit and is not the pin either",
    OTHER_SHA !== PINNED_SHA && /^[0-9a-f]{40}$/.test(OTHER_SHA),
    `${OTHER_SHA} vs ${PINNED_SHA}`
  );
  // The two fixtures answer different questions: `OTHER_SHA` is "some other
  // commit" (no prefix relation), `SAME_PREFIX_SHA` is "same first 7, different
  // commit". If they shared the pin's prefix, the plain `moved` case would stop
  // covering the no-prefix branch and both would test the same thing.
  check(
    "...and the plain 'moved' fixture does not share the pin's first 7 characters",
    OTHER_SHA.slice(0, 7) !== PINNED_SHA.slice(0, 7),
    JSON.stringify({ moved: OTHER_SHA.slice(0, 7), pin: PINNED_SHA.slice(0, 7) })
  );
}

/* ---- the pin itself ---- */
{
  check(
    "the pin is a whole 40-character commit, not the readable 7-character prefix",
    /^[0-9a-f]{40}$/i.test(PINNED_SHA),
    PINNED_SHA
  );
  check(
    "the pin's tag parses as a version, so the dependency range has something to compare",
    /^v\d+\.\d+\.\d+$/.test(PINNED_UPSTREAM.tag),
    PINNED_UPSTREAM.tag
  );
  // The other half of this label — "does the pin still name the release the
  // comparison table was read against" — is a question about the *doc*, and it
  // used to be answered here by `tag === "v1.13.3"`. That literal is red on every
  // legitimate pin advance, so the day the pin moves the honest move is to edit
  // the literal, and the assertion has stopped asserting anything. The real
  // question is asked next to the code that reads the table
  // (`the comparison table was read against the release the pin names`).
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
    "the moved sentence starts with its own marker, so a grep separates it from both quiet states",
    moved.startsWith(MOVED_MARKER) &&
      !moved.includes(DEBT_MARKER) &&
      MOVED_MARKER !== DEBT_MARKER,
    moved.split("\n")[0]
  );
  check(
    "...and the pinned and skipped sentences never carry the moved marker",
    !pinned.includes(MOVED_MARKER) && !skipped.includes(MOVED_MARKER),
    JSON.stringify({ pinned: pinned.split("\n")[0], skipped: skipped.split("\n")[0] })
  );
  check(
    "the three answers are three distinct marker shapes: debt / moved / none",
    [skipped.startsWith(DEBT_MARKER), moved.startsWith(MOVED_MARKER), !pinned.startsWith("[")].every(Boolean),
    JSON.stringify([skipped.split("\n")[0], moved.split("\n")[0], pinned.split("\n")[0]])
  );
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
  const listedLabels = ROWS_TO_REREAD.map((row) => row.label);
  check(
    "the moved sentence lists every row that needs re-reading",
    listedLabels.every((label) => moved.includes(label)),
    JSON.stringify(listedLabels.filter((label) => !moved.includes(label)))
  );
  // The point of the whole round: "the pin moved" must name the files to re-read
  // itself, not leave that to someone who remembers to open the doc. Each row's
  // `source` is the exact string the doc's table carries, so the check is about
  // the same fact in both places.
  check(
    "the moved sentence names all five upstream sources, paths included",
    ROW_SOURCES.length === 5 && ROW_SOURCES.every((source) => moved.includes(source)),
    JSON.stringify({
      count: ROW_SOURCES.length,
      missing: ROW_SOURCES.filter((source) => !moved.includes(source)),
    })
  );
  check(
    "every source is listed once, and none is a substring of another",
    new Set(ROW_SOURCES).size === ROW_SOURCES.length &&
      ROW_SOURCES.every(
        (source) => ROW_SOURCES.filter((other) => other !== source && other.includes(source)).length === 0
      ),
    JSON.stringify(ROW_SOURCES)
  );
  // The list is printed by walking `ROWS_TO_REREAD`; if it were printed as a
  // literal, adding a row would leave the sentence behind and the check above
  // would still pass. Handing in a four-row list has to drop exactly the row
  // that is missing from it.
  const dropped = ROWS_TO_REREAD.filter((row) => row.source !== "cmd/opencodereview/llm_cmd.go");
  const droppedText = formatDrift(upstreamDrift({ ok: true, sha: OTHER_SHA }), dropped);
  check(
    "...and the list is generated from the rows, not written as a literal",
    dropped.length === ROWS_TO_REREAD.length - 1 &&
      !droppedText.includes("cmd/opencodereview/llm_cmd.go") &&
      droppedText.includes("下面 4 处对照点") &&
      ROWS_TO_REREAD.some((row) => row.source === "cmd/opencodereview/llm_cmd.go") &&
      moved.includes("下面 5 处对照点"),
    JSON.stringify({ dropped: dropped.length, hasLlmCmd: droppedText.includes("llm_cmd.go") })
  );
  check(
    "exactly five source rows are listed, one per comparison point in the doc's table",
    ROWS_TO_REREAD.length === 5 && new Set(ROW_SOURCES).size === 5,
    JSON.stringify(ROW_SOURCES)
  );
  // The prefix-collision sentence must not be mistakable for the quiet one.
  const movedSamePrefix = formatDrift(upstreamDrift({ ok: true, sha: SAME_PREFIX_SHA }));
  check(
    "the same-prefix sentence does not read as a typo: it says the two prefixes match",
    movedSamePrefix.startsWith(MOVED_MARKER) &&
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
    // checked run must not falsely look like debt. Same for a moved run — one
    // grep of the whole session's output then separates the three states.
    check(
      `${name}: ${expected === "skipped" ? "carries" : "does not carry"} the debt marker`,
      result.text.includes(DEBT_MARKER) === (expected === "skipped"),
      result.text
    );
    check(
      `${name}: ${expected === "moved" ? "carries" : "does not carry"} the moved marker`,
      result.text.includes(MOVED_MARKER) === (expected === "moved"),
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

/* ---- the orchestration: git first, then the API, then debt ----
 * `runUpstreamWatch(run)` takes a runner, and that seam made the three *verdicts*
 * testable — but the git-then-API order inside the real runner was the part that
 * broke once (five rounds recorded a timed-out git as "skipped" while the API
 * could answer the same question) and it stayed untested, because reaching it
 * needed the network to fail in a specific way. `createRunner` takes the two
 * roads as arguments, so the order is now asserted instead of hoped for:
 * git alone, git-then-api, and neither — plus the two `throw` shapes, which are
 * roads that failed rather than the end of the orchestration.
 */
{
  const apiOk = { ok: true, sha: PINNED_SHA, channel: "api" };
  let calls = { git: 0, api: 0 };
  const runnerFor = ({ git, api }) =>
    createRunner({
      runGit: () => {
        calls.git += 1;
        return git();
      },
      runApi: () => {
        calls.api += 1;
        return api();
      },
    });
  const reset = () => {
    calls = { git: 0, api: 0 };
  };

  reset();
  const gitOnly = await runnerFor({
    git: () => ({ status: 0, stdout: `${PINNED_SHA}\trefs/heads/main\n` }),
    api: () => apiOk,
  })();
  check(
    "a git answer ends the orchestration before the API is asked",
    gitOnly.ok && gitOnly.channel === "git" && calls.git === 1 && calls.api === 0,
    JSON.stringify({ result: gitOnly, calls })
  );

  reset();
  const apiFallback = await runnerFor({
    git: () => ({ error: new Error("ETIMEDOUT") }),
    api: () => apiOk,
  })();
  check(
    "a failed git falls back to the API, and the answer says it came from there",
    apiFallback.ok &&
      apiFallback.channel === "api" &&
      apiFallback.sha === PINNED_SHA &&
      calls.git === 1 &&
      calls.api === 1,
    JSON.stringify({ result: apiFallback, calls })
  );

  // The cell above asks the *object* `createRunner` returns. What a round actually
  // shows is the sentence `runUpstreamWatch` prints from it, and that path has its
  // own seam (`upstreamDrift` → `formatDrift`) between the road that answered and
  // the words on screen: a `channel` dropped on the way through would still leave
  // the object green and print `通路：none`, i.e. a checked round that reads like a
  // debt-carrying one. So the same injected pair is driven end to end here, and
  // what is asserted is the text, not the object.
  reset();
  const viaApiText = await runUpstreamWatch(
    runnerFor({
      git: () => ({ error: new Error("ETIMEDOUT") }),
      api: () => apiOk,
    })
  );
  check(
    "a timed-out git answered by the API prints 通路：api with no debt marker, at exit 0",
    viaApiText.verdict.state === "pinned" &&
      viaApiText.verdict.channel === "api" &&
      viaApiText.text.includes("通路：api") &&
      !viaApiText.text.includes(DEBT_MARKER) &&
      viaApiText.code === 0 &&
      calls.git === 1 &&
      calls.api === 1,
    JSON.stringify({ verdict: viaApiText.verdict, code: viaApiText.code, text: viaApiText.text, calls })
  );
  // A checked-and-unchanged round is the quiet case: the road that failed must
  // not leak into its sentence either. "通路：api（git: ETIMEDOUT）" would read as
  // debt in the words while carrying no marker, and no marker is exactly what a
  // grep for "nothing to do" relies on.
  check(
    "...and the failed road's reason stays out of it, so the quiet sentence stays quiet",
    !viaApiText.text.includes("ETIMEDOUT") &&
      !viaApiText.text.includes(MOVED_MARKER) &&
      viaApiText.text.split(/\r?\n/).filter(Boolean).length === 1,
    JSON.stringify(viaApiText.text)
  );
  check(
    "...and the sentence is the formatted verdict, not a second rendering of it",
    viaApiText.text === formatDrift(viaApiText.verdict),
    viaApiText.text
  );
  // The other road, end to end as well: neither road answering has to read as
  // debt *and* still be exit 0 — the two halves of "an unreachable GitHub is an
  // answer, not a failure" for the case that really happens (the git timeout).
  reset();
  const viaNothing = await runUpstreamWatch(
    runnerFor({
      git: () => ({ error: new Error("ETIMEDOUT") }),
      api: () => ({ ok: false, failure: "GitHub API HTTP 503", channel: "none" }),
    })
  );
  check(
    "neither road answering prints [UPSTREAM-DEBT] with 通路：none, still at exit 0",
    viaNothing.verdict.state === "skipped" &&
      viaNothing.text.startsWith(DEBT_MARKER) &&
      viaNothing.text.includes("通路：none") &&
      viaNothing.text.includes("ETIMEDOUT") &&
      viaNothing.text.includes("GitHub API HTTP 503") &&
      viaNothing.code === 0,
    JSON.stringify({ verdict: viaNothing.verdict, code: viaNothing.code })
  );

  reset();
  const gitThrew = await runnerFor({
    git: () => {
      throw new Error("spawn git ENOENT");
    },
    api: () => apiOk,
  })();
  check(
    "a git that throws is a failed road, not the end of the orchestration",
    gitThrew.ok && gitThrew.channel === "api" && calls.api === 1,
    JSON.stringify({ result: gitThrew, calls })
  );

  reset();
  const bothFailed = await runnerFor({
    git: () => ({ error: new Error("ETIMEDOUT") }),
    api: () => ({ ok: false, failure: "GitHub API HTTP 403", channel: "none" }),
  })();
  check(
    "both roads failing keeps both reasons and claims no road",
    bothFailed.ok === false &&
      bothFailed.channel === "none" &&
      bothFailed.failure.includes("ETIMEDOUT") &&
      bothFailed.failure.includes("GitHub API HTTP 403") &&
      bothFailed.failure.includes("git:") &&
      bothFailed.failure.includes("api:"),
    JSON.stringify(bothFailed)
  );

  // The combined sentence is what a skipped round actually shows: the reader
  // needs the two reasons, not a single "不可达" that hides which road was tried.
  reset();
  const viaCommand = await runUpstreamWatch(
    runnerFor({
      git: () => ({ error: new Error("ETIMEDOUT") }),
      api: () => ({ ok: false, failure: "GitHub API HTTP 403", channel: "none" }),
    })
  );
  check(
    "a skipped command keeps both road failures in its reason, plus the debt marker, at exit 0",
    viaCommand.verdict.state === "skipped" &&
      viaCommand.verdict.reason.includes("ETIMEDOUT") &&
      viaCommand.verdict.reason.includes("GitHub API HTTP 403") &&
      viaCommand.text.startsWith(DEBT_MARKER) &&
      viaCommand.code === 0,
    JSON.stringify({ verdict: viaCommand.verdict, code: viaCommand.code })
  );

  reset();
  const apiThrew = await runnerFor({
    git: () => ({ status: 128, stderr: "fatal: unable to access" }),
    api: () => {
      throw new Error("getaddrinfo ENOTFOUND");
    },
  })();
  check(
    "an API that throws is a failed road, with its message and git's both kept",
    apiThrew.ok === false &&
      apiThrew.failure.includes("ENOTFOUND") &&
      apiThrew.failure.includes("git:"),
    JSON.stringify(apiThrew)
  );

  // A default runner that is missing a road must still be a runner: the factory
  // is called with no arguments by the entry point, so the shape of the export
  // is part of the contract.
  const noRoads = await createRunner({ runGit: () => ({ status: 0, stdout: "" }), runApi: () => undefined })();
  check(
    "an API road answering nothing is a failed road, not a thrown one",
    noRoads.ok === false && noRoads.failure.includes("api:"),
    JSON.stringify(noRoads)
  );
}

/* ---- the doc's fixed line and the module pin cannot drift ---- */
{
  const doc = fs.readFileSync(SYNC_DOC, "utf8");
  // One line, fixed shape: the reader should not have to skim a paragraph to
  // learn whether the current round was actually checked.
  //
  // The qualifier is prose, and prose grows parentheses: round 110 wrote
  // `… `c452846` → `5c039e8`（1 个 commit：…），` inside it, and the shape used
  // to be `（([^）]+)）` — it stopped at the *inner* `）`, so the road at the end
  // of the qualifier was never captured and a correct doc was reported as not
  // saying which road checked the HEAD. The shape is therefore "the line ends
  // with `）**`": everything up to the final `）` belongs to the qualifier,
  // whatever it puts inside.
  const fixedLine = (text) => text.match(/本轮 HEAD 核对：`([0-9a-f]{7,40})`（(.+)）(?:\*\*|\s*$)/m);
  const match = fixedLine(doc);
  check(
    "the sync doc carries a fixed '本轮 HEAD 核对' line with a SHA and a qualifier",
    match !== null && match[2].trim().length > 0,
    match ? `${match[1]}（${match[2]}）` : "missing"
  );

  // The reverse control for that shape, on a constructed line rather than the
  // doc: the doc's own qualifier changes every round, and a control that reads
  // the live line would go quiet the first round nobody nested a parenthesis.
  // What it asks is the half that broke — the road sits *after* an inner `）`.
  const nested = fixedLine(
    "**本轮 HEAD 核对：`76ab46ac`（第 110 轮：前进 `c452846` → `5c039e8`（1 个 commit：模板进 allowlist 与规则表），通路：git）**"
  );
  const nestedRoad = nested ? /通路：(git|api|npm|none)/.exec(nested[2]) : null;
  check(
    "...and a qualifier with parentheses inside it still yields the road at its end",
    nestedRoad !== null && nestedRoad[1] === "git",
    JSON.stringify({ qualifier: nested ? nested[2] : null, road: nestedRoad ? nestedRoad[1] : null })
  );

  // The pin is handwritten in three places in the doc (the machine-readable
  // block, the fixed line, the prose sentence that introduces `upstream:check`)
  // and once in this module. Three unchecked copies is how a doc ends up quoting
  // a commit the sentinel no longer compares against — silently, because the
  // sentence stays green. So every declaration is read out by shape and each one
  // must carry the constant's 40 characters; the failure names the doc line.
  const docPins = findDocPins(doc);
  const whereList = docPins.pins.map((pin) => `${pin.where}@${pin.line}`);
  check(
    "the sync doc carries a machine-readable pin block",
    docPins.blockFound && docPins.pins.some((pin) => pin.where === "pin 块"),
    JSON.stringify({ blockFound: docPins.blockFound, pins: whereList })
  );
  const coverage = pinPlaceCoverage(docPins.pins);
  check(
    "the pin is declared exactly three times, once in each of the three places",
    docPins.pins.length === 3 && coverage.complete,
    JSON.stringify(coverage)
  );
  const docDisagreements = describePinDisagreements(docPins.pins, PINNED_SHA);
  check(
    "every place the doc declares the pin carries the SHA the sentinel compares against",
    docDisagreements.length === 0,
    docDisagreements.join("；") || `${docPins.pins.length} declaration(s)`
  );
  check(
    "every declaration is a whole 40-character commit, never the readable prefix",
    docPins.pins.every((pin) => pin.sha.length === 40),
    JSON.stringify(docPins.pins.map((pin) => [pin.line, pin.sha.length]))
  );
  check(
    "the pin block's tag is the tag this module pins",
    docPins.tag !== null && docPins.tag.tag === PINNED_UPSTREAM.tag,
    JSON.stringify(docPins.tag)
  );
  // The fifth copy of the pin is not a value but a *claim about reading*: the
  // comparison table's 「最近一次对照」 column says which round read which row, and
  // the doc states the answer as a release (the cell opens with the pinned tag).
  // When the pin moves, the rows describe the release they were last read against
  // — so a row still citing the previous tag is the machine-readable shape of
  // "dependency moved, nobody re-read the row". This is the question the retired
  // `tag === "v1.13.3"` literal put in its label without ever opening the document.
  const tableBody = comparisonTableRows(doc).rows;
  const rowsOffPin = (text) =>
    comparisonTableRows(text).rows.filter((row) => !row.text.includes(PINNED_UPSTREAM.tag));
  check(
    "the comparison table was read against the release the pin names, every row",
    tableBody.length === ROWS_TO_REREAD.length && rowsOffPin(doc).length === 0,
    JSON.stringify({
      rows: tableBody.length,
      stale: rowsOffPin(doc).map((row) => `第 ${row.line} 行`),
      want: PINNED_UPSTREAM.tag,
    })
  );
  const staleTagLines = doc.split("\n");
  const firstRow = tableBody[0];
  staleTagLines[firstRow.line - 1] = staleTagLines[firstRow.line - 1].replace(
    PINNED_UPSTREAM.tag,
    "v1.13.3"
  );
  const staleRows = rowsOffPin(staleTagLines.join("\n"));
  check(
    "...and one row left citing the previous release goes red, naming that row's line",
    staleRows.length === 1 &&
      staleRows[0].line === firstRow.line &&
      staleTagLines[firstRow.line - 1].includes("v1.13.3"),
    JSON.stringify({ line: firstRow.line, stale: staleRows.map((row) => row.line) })
  );

  // The pin has a fourth copy, in a different file and a different shape:
  // `package.json`'s dependency range. The doc declares one release, the
  // dependency writes a range for the same package, and `^` means the next
  // install may bring a newer minor while the pin, the five rows and the resolver
  // simulation still describe the release this wrapper was read against. The two
  // have to agree *now* — and the failure has to name both places, because "the
  // dependency moved" is not the interesting half.
  const realPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  check(
    "package.json's dependency on the CLI names the version the pin names",
    dependencyPinViolations(realPkg).length === 0,
    dependencyPinViolations(realPkg).join("；") || JSON.stringify(realPkg.dependencies[UPSTREAM_PACKAGE])
  );
  const bumped = dependencyPinViolations({
    dependencies: { ...realPkg.dependencies, [UPSTREAM_PACKAGE]: "^1.14.0" },
  });
  check(
    "...and raising that range without touching the pin goes red, naming both versions",
    bumped.length === 1 &&
      bumped[0].includes("1.14.0") &&
      bumped[0].includes(PINNED_UPSTREAM.tag) &&
      bumped[0].includes(UPSTREAM_PACKAGE),
    JSON.stringify(bumped)
  );
  const noDependency = dependencyPinViolations({ dependencies: {} });
  check(
    "...and a package.json with no dependency on the CLI at all is red too, not silently green",
    noDependency.length === 1 && noDependency[0].includes("没有"),
    JSON.stringify(noDependency)
  );
  // "Cannot compare" is not "agrees": every shapeless range has to be refused,
  // and each one has to be refused by the *unreadable-range* sentence rather
  // than by some later mismatch.
  const unreadableRanges = ["*", "latest", ""];
  const unreadableResults = unreadableRanges.map((range) =>
    dependencyPinViolations({ dependencies: { ...realPkg.dependencies, [UPSTREAM_PACKAGE]: range } })
  );
  check(
    "...and every range with no version in it is refused rather than read as agreement",
    unreadableResults.every(
      (violations) => violations.length === 1 && violations[0].includes("读不出版本号")
    ),
    JSON.stringify(unreadableRanges.map((range, index) => [range, unreadableResults[index]]))
  );
  // The pin side is a version too. A pin tag like `nightly` (or one renamed
  // without a version) leaves nothing to compare, and must be named as the
  // pin's problem — not reported as a dependency mismatch, which would send the
  // reader to the wrong file.
  const notAVersionPin = dependencyPinViolations(
    { dependencies: { ...realPkg.dependencies } },
    { sha: PINNED_UPSTREAM.sha, tag: "nightly" }
  );
  check(
    "...and a pin whose tag is not a version is refused, naming the tag",
    notAVersionPin.length === 1 &&
      notAVersionPin[0].includes("不是版本号") &&
      notAVersionPin[0].includes("nightly"),
    JSON.stringify(notAVersionPin)
  );
  check(
    "...while a bare version pin (no leading v) still compares as equal",
    dependencyPinViolations(
      { dependencies: { ...realPkg.dependencies } },
      { sha: PINNED_UPSTREAM.sha, tag: pinVersion(PINNED_UPSTREAM) }
    ).length === 0,
    JSON.stringify(
      dependencyPinViolations(
        { dependencies: { ...realPkg.dependencies } },
        { sha: PINNED_UPSTREAM.sha, tag: pinVersion(PINNED_UPSTREAM) }
      )
    )
  );
  check(
    "...and the version is read out of every range shape, and out of none of the shapeless ones",
    JSON.stringify(["^1.13.3", "~1.13.30", ">=1.13.3 <2", "1.13.3", "*", "", "latest"].map(versionInRange)) ===
      JSON.stringify(["1.13.3", "1.13.30", "1.13.3", "1.13.3", null, null, null]),
    JSON.stringify(["^1.13.3", "~1.13.30", ">=1.13.3 <2", "1.13.3", "*", "", "latest"].map(versionInRange))
  );

  // The comparison has to be red on a one-character edit *and* say where. Same
  // doc, one character flipped in the block's pin: the declarations keep their
  // shape, so the mismatch is the only difference. Asserted against a mutated
  // copy rather than the live doc, which keeps the check meaningful even while
  // the live doc and the constant agree (they always do, when this suite passes).
  const blockPin = docPins.pins.find((pin) => pin.where === "pin 块");
  const flipped = blockPin
    ? blockPin.sha.slice(0, -1) + (blockPin.sha.endsWith("0") ? "1" : "0")
    : "";
  const mutatedDoc = blockPin
    ? doc
        .split(/\r?\n/)
        .map((line, index) =>
          index + 1 === blockPin.line ? line.replace(blockPin.sha, flipped) : line
        )
        .join("\n")
    : "";
  const mutatedDisagreements = describePinDisagreements(findDocPins(mutatedDoc).pins, PINNED_SHA);
  check(
    "editing one character of the doc's pin goes red, naming the line and the constant",
    blockPin !== undefined &&
      flipped !== blockPin.sha &&
      mutatedDisagreements.length === 1 &&
      mutatedDisagreements[0].includes(`文档第 ${blockPin.line} 行`) &&
      mutatedDisagreements[0].includes(flipped) &&
      mutatedDisagreements[0].includes(PINNED_SHA),
    JSON.stringify(mutatedDisagreements)
  );
  // The mutation is one line in, one line out: if it changed more, the red
  // below could be explained by anything else in the copy.
  const docLines = doc.split(/\r?\n/);
  const mutatedLines = mutatedDoc.split(/\r?\n/);
  check(
    "...and the mutated copy differs from the doc on exactly one line",
    blockPin !== undefined &&
      docLines.length === mutatedLines.length &&
      docLines.filter((line, index) => line !== mutatedLines[index]).length === 1,
    JSON.stringify({
      lines: docLines.length,
      changed: docLines.filter((line, index) => line !== mutatedLines[index]).length,
    })
  );

  // Removing a declaration is the failure that used to stay green: the two
  // remaining pins still equal the constant, so only a count can see it. Each
  // mutation deletes exactly the line holding one place, and the coverage
  // answer has to name that place — "2 < 3" alone would not tell the reader
  // which sentence stopped being checked.
  for (const place of PIN_PLACES) {
    const pin = docPins.pins.find((entry) => entry.where === place);
    const without = pin
      ? docLines.filter((_, index) => index + 1 !== pin.line).join("\n")
      : "";
    const after = findDocPins(without);
    const afterCoverage = pinPlaceCoverage(after.pins);
    check(
      `deleting the ${place} declaration fails the count and names the missing place`,
      pin !== undefined &&
        after.pins.length === 2 &&
        afterCoverage.missing.length === 1 &&
        afterCoverage.missing[0] === place &&
        !afterCoverage.complete,
      JSON.stringify({ line: pin && pin.line, total: after.pins.length, missing: afterCoverage.missing })
    );
  }
  // The other direction of the same count check: a place declared *twice*. The
  // value check cannot see this — both copies equal the constant, so a suite
  // that only compared values (the state before round 60) stayed green while one
  // sentence was being checked twice and another maybe not at all. Built by
  // copying the real doc and inserting one more `sha …` line inside the pin
  // block, so the extra declaration is the only difference between the two.
  const blockPinLine = blockPin ? docLines[blockPin.line - 1] : "";
  const duplicatedDoc = blockPin
    ? [
        ...docLines.slice(0, blockPin.line),
        blockPinLine,
        ...docLines.slice(blockPin.line),
      ].join("\n")
    : "";
  const duplicatedPins = findDocPins(duplicatedDoc).pins;
  const duplicatedCoverage = pinPlaceCoverage(duplicatedPins);
  check(
    "declaring the pin block's SHA twice fails the count and names the duplicated place",
    blockPin !== undefined &&
      duplicatedPins.length === 4 &&
      duplicatedCoverage.counts["pin 块"] === 2 &&
      duplicatedCoverage.duplicated.length === 1 &&
      duplicatedCoverage.duplicated[0] === "pin 块" &&
      duplicatedCoverage.missing.length === 0 &&
      !duplicatedCoverage.complete,
    JSON.stringify(duplicatedCoverage)
  );
  check(
    "...and every one of the four values still equals the constant, so only the count can go red",
    duplicatedPins.length === 4 && describePinDisagreements(duplicatedPins, PINNED_SHA).length === 0,
    JSON.stringify(describePinDisagreements(duplicatedPins, PINNED_SHA))
  );
  // The fixture is one inserted line, not a reworded document: if the copy
  // differed anywhere else, the red above could be explained by that instead.
  const duplicatedLines = duplicatedDoc.split(/\r?\n/);
  check(
    "...and the copy differs from the doc by exactly one inserted line",
    blockPin !== undefined &&
      duplicatedLines.length === docLines.length + 1 &&
      duplicatedLines[blockPin.line - 1] === blockPinLine &&
      duplicatedLines[blockPin.line] === blockPinLine &&
      duplicatedLines
        .filter((_, index) => index !== blockPin.line)
        .every((line, index) => line === docLines[index]),
    JSON.stringify({ docLines: docLines.length, copyLines: duplicatedLines.length })
  );
  // Duplicated and missing are two answers, not one: a place can be declared
  // twice while another is gone, and reporting only "incomplete" would hide
  // which of the two shapes was actually found (and send the reader to the wrong
  // line). Built directly from pin shapes rather than from a mutated doc, because
  // both shapes have to appear in the same answer.
  const halfAndHalf = pinPlaceCoverage([
    { where: "pin 块", sha: PINNED_SHA },
    { where: "pin 块", sha: PINNED_SHA },
    { where: "本轮 HEAD 核对 行", sha: PINNED_SHA },
  ]);
  check(
    "...and a doubled place plus a missing one are reported as two separate answers",
    halfAndHalf.duplicated.length === 1 &&
      halfAndHalf.duplicated[0] === "pin 块" &&
      halfAndHalf.missing.length === 1 &&
      halfAndHalf.missing[0] === "正文固定 SHA" &&
      !halfAndHalf.complete,
    JSON.stringify(halfAndHalf)
  );

  const channel = match ? /通路：(git|api|npm|none)/.exec(match[2]) : null;
  check(
    "the fixed line says which road checked the HEAD this round",
    channel !== null,
    match ? match[2] : "missing"
  );
  // Section locators match a *line* start, not the first occurrence of the text
  // anywhere in the file. The doc's preamble quotes the very markers this suite
  // looks for ("`### 核对通路账` 标题"、"`| 对照点 | 上游文件 |` 表头") to explain
  // what the script reads and why — and a plain `indexOf` finds that sentence
  // first, which turned the ledger's 29 rows into "0 row(s)" and made three
  // checks red for a reason that had nothing to do with the ledger.
  const locateLine = (text, needle) => {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const found = new RegExp(`^${escaped}`, "m").exec(text);
    return found ? found.index : -1;
  };
  check(
    "a locator finds the section's own line, not a quoted copy of it in prose",
    locateLine(`正文引用了 ${"### 核对通路账"} 这个标题\n\n### 核对通路账\n| 47 | … |`, "### 核对通路账") ===
      `正文引用了 ${"### 核对通路账"} 这个标题\n\n`.length,
    JSON.stringify(
      locateLine(`正文引用了 ${"### 核对通路账"} 这个标题\n\n### 核对通路账\n| 47 | … |`, "### 核对通路账")
    )
  );

  const tableAt = locateLine(doc, "| 对照点 | 上游文件 |");
  const fixedAt = locateLine(doc, "**本轮 HEAD 核对：");
  check(
    "the fixed line sits above the comparison table, not buried below it",
    match !== null && tableAt !== -1 && fixedAt !== -1 && fixedAt < tableAt,
    `line=${fixedAt} table=${tableAt}`
  );
  // The ledger turns "this round was checked over npm only" into a row instead
  // of a paragraph. The rule the rows must obey is the useful part: npm can
  // report a release but not the default branch's commit, so an npm-only round
  // owes the HEAD check; git and the API can answer it, so they owe nothing.
  const ledgerAt = locateLine(doc, LEDGER_HEADING);
  check(
    "the sync doc carries the per-round check ledger",
    ledgerAt !== -1,
    String(ledgerAt)
  );
  // The rows are parsed by the module, not by a second copy of "the lines
  // between this heading and the next one": `humanSectionViolations` reads this
  // same table to learn which round the ledger stops at, and two parsers of one
  // table is how the two answers start disagreeing about which rows exist.
  const ledgerRows = ledgerRowsIn(doc);
  check(
    "the ledger the smoke reads is the ledger the rule reads, and it is not empty",
    ledgerRows.length > 0 && ledgerRows.every((row) => /^\d+$/.test(row[0])),
    `${ledgerRows.length} row(s)`
  );
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
  // One row per round, and the rounds are consecutive. Only the last row is read
  // by the checks above, so without this a round could be dropped from the middle
  // of the ledger — the table stays "valid", the debt count silently falls by
  // one, and "how many rounds in a row went unchecked" (the question the ledger
  // exists to answer) becomes wrong by an amount nobody can see. Duplicates are
  // the same failure from the other side: two rows for one round let a later
  // round's debt be paid twice.
  const ledgerRounds = ledgerRows.map((row) => Number(row[0]));
  const gaps = ledgerRounds
    .slice(1)
    .map((round, index) => (round === ledgerRounds[index] + 1 ? null : `${ledgerRounds[index]}→${round}`))
    .filter(Boolean);
  check(
    "the ledger's rounds are consecutive integers, one row each, with no repeat",
    ledgerRounds.every((round) => Number.isInteger(round)) && gaps.length === 0,
    JSON.stringify({ rounds: ledgerRounds.length, first: ledgerRounds[0], last: ledgerRounds[ledgerRounds.length - 1], gaps })
  );
  /* ---- the ledger is bound to the round in the commit subject ----
   * Every ledger check above reads the doc alone, so a round that updated the
   * code and forgot the ledger left a doc that was still perfectly valid — one
   * round older than the commit that carried it, with no row missing by any
   * count. The binding is to the one place the round number cannot be forgotten
   * without being visible: this repo's commit subjects always say 「第 N 轮」.
   *
   * The accepted window (ledger last = N or N+1 relative to HEAD's subject) is
   * explained in `ledgerRoundViolations`; the short version is that the doc is
   * written before the commit, so an in-progress round legitimately sits one
   * ahead, while one *behind* is the shape of a round that landed without
   * recording anything — the exact failure the ledger exists to catch.
   */
  const headLog = spawnSync("git", ["log", "-1", "--format=%s"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 10000,
  });
  const headSubject =
    headLog.error || headLog.status !== 0 ? "" : String(headLog.stdout || "").trim();
  const headRound = roundFromCommitSubject(headSubject);
  check(
    "the current commit's subject names its round, which is what the ledger is bound to",
    headRound !== null,
    headLog.error ? `git log 读不到：${headLog.error.message}` : JSON.stringify(headSubject)
  );
  const roundViolations = ledgerRoundViolations(ledgerRounds, headSubject);
  check(
    "the ledger ends on this commit's round (this one, or the next while the doc is written)",
    roundViolations.length === 0,
    roundViolations.join("；") ||
      `HEAD 第 ${headRound} 轮 / 账末第 ${ledgerRounds[ledgerRounds.length - 1]} 轮`
  );
  // The failure the binding exists for, as one deleted line: drop the last row
  // and ask with the subject of the commit that should have carried it. Built
  // this way it stays the same mutation before and after this round's commit
  // (pre-commit the dropped round is the pending one, post-commit it is HEAD's).
  const droppedRound = ledgerRounds[ledgerRounds.length - 1];
  const droppedLedger = ledgerRoundViolations(
    ledgerRounds.slice(0, -1),
    `fix: 某处改动（第 ${droppedRound} 轮上游核对：无新内容）`
  );
  check(
    "dropping the round's own row goes red, naming the commit's round and the ledger's",
    droppedLedger.length === 1 &&
      droppedLedger[0].includes(`第 ${droppedRound} 轮`) &&
      droppedLedger[0].includes(`停在 ${droppedRound - 1} 轮`),
    JSON.stringify(droppedLedger)
  );
  check(
    "...and it says what to do instead, so 'nothing to record' does not read as 'skip the row'",
    droppedLedger.length === 1 && droppedLedger[0].includes(DEBT_MARKER),
    JSON.stringify(droppedLedger)
  );
  // The window as a table, built from literals instead of the live ledger and
  // the live HEAD: the rule above is exercised once, against whatever this
  // round happens to be, so "N-1 is red" and "N+1 is green" were never both
  // asked at once. Each row changes one input; the subject is a real commit
  // sentence, because that is the string `git log -1 --format=%s` hands over.
  const ledgerEnding = (last, head) =>
    ledgerRoundViolations([last - 1, last], `fix: 某处改动（第 ${head} 轮上游核对：无新内容）`);
  const bindingCases = [
    ["the commit's own round", 82, true],
    ["one round ahead while the doc is written", 83, true],
    ["one row short", 81, false],
    ["two rows short", 80, false],
  ];
  const bindingAnswers = bindingCases.map(([label, last, green]) => {
    const violations = ledgerEnding(last, 82);
    return {
      label,
      last,
      green,
      violations,
      namesBoth:
        violations.length === 1 &&
        violations[0].includes("第 82 轮") &&
        violations[0].includes(`停在 ${last} 轮`),
    };
  });
  check(
    "the ledger window, asked with constructed subjects: N and N+1 are green, N-1 and N-2 are red",
    bindingAnswers.every((entry) => (entry.violations.length === 0) === entry.green),
    JSON.stringify(
      bindingAnswers
        .filter((entry) => (entry.violations.length === 0) !== entry.green)
        .map(({ label, last, green, violations }) => ({ label, last, green, violations }))
    )
  );
  check(
    "...and both shortfall sentences name the commit's round and the ledger's",
    bindingAnswers
      .filter((entry) => !entry.green)
      .every((entry) => entry.namesBoth),
    JSON.stringify(
      bindingAnswers
        .filter((entry) => !entry.green && !entry.namesBoth)
        .map(({ label, last, violations }) => ({ label, last, violations }))
    )
  );
  // "Only change one line" as a copy of the rule: the same ledger (ending on
  // round 82) and the same subject with its digit moved by one. Nothing else in
  // the input moves, so a rule that accepted any nearby number would stay
  // green here and this check would be the one that says so.
  check(
    "...and moving only the subject's round by one, with the ledger untouched, turns it red",
    ledgerRoundViolations([80, 82], "第 82 轮").length === 0 &&
      ledgerRoundViolations([80, 82], "第 83 轮").length === 1,
    JSON.stringify(ledgerRoundViolations([80, 82], "第 83 轮"))
  );
  // The other direction of the window, and the two shapes that are not rounds at
  // all. Without these the accepted window could widen to "any number below the
  // ledger" and the mutation above would still pass.
  const twoAhead = ledgerRoundViolations([80, 82], "第 80 轮");
  check(
    "a ledger two rounds ahead of the commit is red, not silently accepted",
    twoAhead.length === 1 && twoAhead[0].includes("领先 2 轮"),
    JSON.stringify(twoAhead)
  );
  const noRound = ledgerRoundViolations([80, 81], "chore: 没有轮次的提交信息");
  check(
    "a subject with no round is its own red, not a default that compares against 0",
    noRound.length === 1 && noRound[0].includes("读不出") &&
      roundFromCommitSubject("chore: 没有轮次的提交信息") === null &&
      roundFromCommitSubject("") === null,
    JSON.stringify(noRound)
  );
  // The subject also names other rounds when it explains history. Reading the
  // first of those as "the round this commit is" made a commit claim to be one
  // round behind itself — and the +1 window absorbed it, so nothing was red.
  // The marker 「第 N 轮上游核对」 is the house style's own answer; these two
  // checks pin both directions of the choice.
  const historical = "test(bridge): 接线补反向控制（顺带抓出第 97 轮账加了一行）；第 98 轮上游核对（无新内容）";
  check(
    "a subject that mentions an older round first still reads the round it claims",
    roundFromCommitSubject(historical) === 98 &&
      ROUND_IN_COMMIT_SUBJECT.exec(historical)[1] === "97",
    JSON.stringify({ read: roundFromCommitSubject(historical) })
  );
  check(
    "...and a later round named after the marker does not move it, because the marker is the claim",
    roundFromCommitSubject("fix(x): 一处改动；第 99 轮上游核对（补第 98 轮的行）") === 99,
    JSON.stringify({ read: roundFromCommitSubject("fix(x): 一处改动；第 99 轮上游核对（补第 98 轮的行）") })
  );
  check(
    "...and a subject without the marker still falls back to its only round",
    roundFromCommitSubject("chore(release): 0.1.14（第 80 轮）") === 80,
    JSON.stringify({ read: roundFromCommitSubject("chore(release): 0.1.14（第 80 轮）") })
  );
  check(
    "an empty ledger is red rather than vacuously in agreement",
    ledgerRoundViolations([], "第 82 轮").length === 1,
    JSON.stringify(ledgerRoundViolations([], "第 82 轮"))
  );
  /* ---- the ledger is one table for the reader, not just for the parser ----
   * Every check above asks the parsed rows for a property. None of them can see
   * a blank line, because `ledgerRowsIn` scans the region for lines that look
   * like rows and simply steps over it — while GFM *ends the table* there, so
   * the rows below the blank render as a paragraph of pipes. 第 102 轮 shipped
   * exactly that: rows 101 and 102 on either side of one blank line, the audit
   * counting both, GitHub printing the second as text.
   *
   * The premise is therefore asserted as loudly as the rule: a mutated doc must
   * keep counting every row *and* go red. A rule that only fired when the
   * parser lost the row would be checking something the parser does not do.
   */
  const ledgerLines = doc.split("\n");
  const ledgerRowAt = (round) =>
    ledgerLines.findIndex((line) => line.startsWith(`| ${round} |`));
  const liveRounds = ledgerRows.map((row) => Number(row[0]));
  const liveLast = liveRounds[liveRounds.length - 1];
  const liveSecondLast = liveRounds[liveRounds.length - 2];
  check(
    "the blank-line mutations below are anchored in two real adjacent rows of the live ledger",
    liveRounds.length >= 2 &&
      ledgerRowAt(liveLast) !== -1 &&
      ledgerRowAt(liveSecondLast) !== -1 &&
      ledgerRowAt(liveLast) === ledgerRowAt(liveSecondLast) + 1,
    JSON.stringify({ liveLast, liveSecondLast, at: ledgerRowAt(liveLast) })
  );
  check(
    "the live ledger is one contiguous table, with no blank line inside it",
    ledgerTableViolations(doc).length === 0,
    ledgerTableViolations(doc).join("；") || `${liveRounds.length} row(s)`
  );
  const withBlank = (at, count = 1) =>
    [
      ...ledgerLines.slice(0, at),
      ...Array.from({ length: count }, () => ""),
      ...ledgerLines.slice(at),
    ].join("\n");
  const splitRows = withBlank(ledgerRowAt(liveLast));
  check(
    "a blank line between two rows goes red, naming the line and the rounds on both sides",
    ledgerTableViolations(splitRows).length === 1 &&
      ledgerTableViolations(splitRows)[0].includes(`第 ${ledgerRowAt(liveLast) + 1} 行`) &&
      ledgerTableViolations(splitRows)[0].includes(`上面读到第 ${liveSecondLast} 轮`) &&
      ledgerTableViolations(splitRows)[0].includes(`第 ${liveLast}–${liveLast} 轮共 1 行`),
    JSON.stringify(ledgerTableViolations(splitRows))
  );
  check(
    "...and the parser still counts every row, which is why the rule has to exist at all",
    ledgerRowsIn(splitRows).length === ledgerRowsIn(doc).length &&
      ledgerRowsIn(splitRows).length === liveRounds.length,
    JSON.stringify({
      parsedWithBlank: ledgerRowsIn(splitRows).length,
      parsedLive: ledgerRowsIn(doc).length,
    })
  );
  // The hole is only real if nothing else saw it. Re-ask the split doc every
  // other question the audit puts to the ledger — rounds consecutive, 通路/欠账
  // paired, the last row bound to the commit's round, 「当前状态」 bound to that
  // row — and they all stay green, which is exactly how 第 102 轮 shipped a
  // table GitHub rendered as two.
  const splitParsed = ledgerRowsIn(splitRows);
  const splitRounds = splitParsed.map((row) => Number(row[0]));
  const splitGaps = splitRounds.slice(1).filter((round, index) => round !== splitRounds[index] + 1);
  const splitDebtBad = splitParsed.filter(([, , via, , debt]) => {
    if (!["git", "api", "npm", "none"].includes(via)) return true;
    return debt.includes(DEBT_MARKER) !== (via === "npm" || via === "none");
  });
  const splitBinding = ledgerRoundViolations(
    splitRounds,
    `fix: 一处改动（第 ${liveLast} 轮上游核对：无新内容）`
  );
  check(
    "...and no other ledger question sees the blank, which is the hole this rule closes",
    splitGaps.length === 0 &&
      splitDebtBad.length === 0 &&
      splitBinding.length === 0 &&
      humanSectionViolations(splitRows).join("\n") === humanSectionViolations(doc).join("\n") &&
      ledgerTableViolations(splitRows).length === 1,
    JSON.stringify({ gaps: splitGaps, debt: splitDebtBad.length, binding: splitBinding })
  );
  check(
    "...and the sentence says what to do, so 'two tables' does not read as a parsing bug",
    ledgerTableViolations(splitRows).length === 1 &&
      ledgerTableViolations(splitRows)[0].includes("删掉"),
    JSON.stringify(ledgerTableViolations(splitRows))
  );
  // Two shapes the rule must NOT fire on, or it becomes noise a reader learns to
  // ignore: the blank line that legitimately ends a table, and the blank prose
  // spacing above the header.
  const lastRowEnd = ledgerRowAt(liveLast);
  const afterTable = withBlank(lastRowEnd + 1);
  check(
    "a blank line after the ledger's last row is normal Markdown, not a broken table",
    ledgerTableViolations(afterTable).length === 0,
    JSON.stringify(ledgerTableViolations(afterTable))
  );
  const headerAt = ledgerLines.findIndex(
    (line, index) => index > ledgerLines.findIndex((l) => l.startsWith(LEDGER_HEADING)) && line.trim().startsWith("|")
  );
  check(
    "...and so is the blank line above the header",
    ledgerTableViolations(withBlank(headerAt)).length === 0,
    JSON.stringify({ headerAt, violations: ledgerTableViolations(withBlank(headerAt)) })
  );
  const underHeader = withBlank(headerAt + 2);
  check(
    "a blank line directly under the header is the worse shape: the reader loses every row, and the sentence says so",
    ledgerTableViolations(underHeader).length === 1 &&
      ledgerTableViolations(underHeader)[0].includes("只剩表头") &&
      ledgerTableViolations(underHeader)[0].includes(`共 ${liveRounds.length} 行`),
    JSON.stringify(ledgerTableViolations(underHeader))
  );
  // One accidental double blank is one defect, so it is one sentence — and it
  // names the range, because "第 112 行" and "第 113 行" both being reported for
  // the same stray Enter keypress reads like two problems to fix.
  const doubled = withBlank(ledgerRowAt(liveLast), 2);
  check(
    "two consecutive blank lines are one violation naming the range",
    ledgerTableViolations(doubled).length === 1 &&
      ledgerTableViolations(doubled)[0].includes(
        `第 ${ledgerRowAt(liveLast) + 1}–${ledgerRowAt(liveLast) + 2} 行`
      ),
    JSON.stringify(ledgerTableViolations(doubled))
  );
  check(
    "a doc with no ledger at all answers 'no violation', not a borrowed table",
    ledgerTableViolations("### 别的标题\n| 1 | a | b |\n| 2 | c | d |\n").length === 0,
    JSON.stringify(ledgerTableViolations("### 别的标题\n| 1 | a | b |\n| 2 | c | d |\n"))
  );
  // The reading list is generated from `ROWS_TO_REREAD`; the table is hand-
  // written. Asking "does each label appear somewhere in the doc" (the previous
  // shape of this check) passes while the table has a sixth row nobody will ever
  // be told to re-read, and passes while a listed row has drifted into some other
  // paragraph. So the two lists are compared as a bijection on the sources — the
  // upstream file each row is about — and the failure names the source, not a
  // count.
  const tableCoverage = tableRowCoverage(doc);
  check(
    "the doc has the comparison table the sentinel's reading list is paired with",
    tableCoverage.found && doc.includes(TABLE_HEADER),
    JSON.stringify({ found: tableCoverage.found, headerLine: tableCoverage.headerLine })
  );
  check(
    "the table has exactly one body row per listed source, and no row is unclaimed",
    tableCoverage.rows.length === ROWS_TO_REREAD.length &&
      tableCoverage.missing.length === 0 &&
      tableCoverage.duplicated.length === 0 &&
      tableCoverage.orphans.length === 0,
    JSON.stringify({
      rows: tableCoverage.rows.length,
      listed: ROWS_TO_REREAD.length,
      missing: tableCoverage.missing,
      duplicated: tableCoverage.duplicated,
      orphans: tableCoverage.orphans.map((row) => row.line),
    })
  );
  check(
    "...and each listed label is the cell text of its own row",
    ROWS_TO_REREAD.every((row) => doc.includes(row.label)),
    JSON.stringify(ROWS_TO_REREAD.filter((row) => !doc.includes(row.label)).map((row) => row.label))
  );
  // Dropping a table row is the drift this pair exists to catch: the doc loses a
  // comparison point and the sentinel would keep naming five rows *including*
  // one the table no longer has. Asserted on a mutated copy, deleting exactly the
  // line of the `cmd/opencodereview/llm_cmd.go` row.
  const droppedSource = "cmd/opencodereview/llm_cmd.go";
  const dropRow = tableCoverage.rows.find((row) => row.sources.includes(droppedSource));
  const withoutRow = dropRow ? docLines.filter((_, index) => index + 1 !== dropRow.line).join("\n") : "";
  const afterDrop = tableRowCoverage(withoutRow);
  check(
    "deleting the llm_cmd.go table row goes red and names that source",
    dropRow !== undefined &&
      afterDrop.rows.length === tableCoverage.rows.length - 1 &&
      afterDrop.missing.length === 1 &&
      afterDrop.missing[0] === droppedSource,
    JSON.stringify({ line: dropRow && dropRow.line, rows: afterDrop.rows.length, missing: afterDrop.missing })
  );
  // The other direction: a table row the reading list does not know about. Built
  // by duplicating the resolver row and pointing it at a different upstream file,
  // so it is a real sixth comparison point, not a separator-shaped line.
  const orphanRow = `| 某个新对照点 | \`internal/llm/resolver_v2.go\` | 示例 | 第 99 轮 / 2026-10-27 |`;
  const withOrphan = dropRow
    ? [...docLines.slice(0, dropRow.line), orphanRow, ...docLines.slice(dropRow.line)].join("\n")
    : "";
  const afterOrphan = tableRowCoverage(withOrphan);
  check(
    "a table row with no counterpart in the reading list is reported as an orphan, naming its line",
    dropRow !== undefined &&
      afterOrphan.rows.length === tableCoverage.rows.length + 1 &&
      afterOrphan.orphans.length === 1 &&
      afterOrphan.orphans[0].line === dropRow.line + 1 &&
      afterOrphan.missing.length === 0 &&
      withOrphan.split(/\r?\n/)[afterOrphan.orphans[0].line - 1] === orphanRow,
    JSON.stringify({ rows: afterOrphan.rows.length, orphans: afterOrphan.orphans })
  );
  check(
    "...and both copies of the table differ from the doc by exactly one line",
    dropRow !== undefined &&
      docLines.length === withoutRow.split(/\r?\n/).length + 1 &&
      docLines.length === withOrphan.split(/\r?\n/).length - 1,
    JSON.stringify({
      doc: docLines.length,
      dropped: withoutRow.split(/\r?\n/).length,
      orphan: withOrphan.split(/\r?\n/).length,
    })
  );
}

/* ---- the machine-readable region's own shape ----
 * The sync doc is two regions: the part this audit reads (between the two
 * `<!-- machine-readable:… -->` markers) and the part it does not (everything
 * after the end marker). The split is what makes the audit's answers stable —
 * the pin block, the fixed line, the ledger and the comparison table are found
 * *by shape*, so prose in the human half can grow without moving them.
 *
 * The split's failure mode is silent, which is why it needs its own rule: a
 * second copy of an anchor in the human half (a second `### 核对通路账`, a
 * second comparison table, a second pin block) leaves every other check green,
 * because the counts that would see it are exactly the ones the audit does not
 * make. The file then says the same thing twice, and the two copies can drift
 * apart. That is the mechanical form of the sentence at the top of the file
 * (「不要在人读区再声明一次 pin、复制一轮欠账、或另起一张对照表」).
 *
 * So: the real doc must be clean; the human half must be a real region (or
 * "no anchor after the end marker" is vacuous); and three one-line mutations
 * must each go red for their own reason.
 */
{
  const doc = fs.readFileSync(SYNC_DOC, "utf8");
  const docLines = doc.split(/\r?\n/);
  const violations = machineReadableBlockViolations(doc);
  check(
    "the sync doc's machine-readable region has exactly the shape the audit reads",
    violations.length === 0,
    violations.join("；") || "no violation"
  );
  check(
    "the region is checked for at least five anchors, each with its own name and its own matcher",
    MACHINE_READABLE_ANCHORS.length >= 5 &&
      new Set(MACHINE_READABLE_ANCHORS.map((anchor) => anchor.name)).size ===
        MACHINE_READABLE_ANCHORS.length &&
      MACHINE_READABLE_ANCHORS.every((anchor) => Boolean(anchor.marker) !== Boolean(anchor.where)),
    JSON.stringify(MACHINE_READABLE_ANCHORS.map((anchor) => anchor.name))
  );

  const startLine = docLines.findIndex((line) => line.includes(MACHINE_READABLE_START)) + 1;
  const endLine = docLines.findIndex((line) => line.includes(MACHINE_READABLE_END)) + 1;
  const humanLines = docLines.length - endLine;
  check(
    "...and the human half is a real region, not an empty one",
    startLine > 0 && endLine > startLine && humanLines > 20,
    `start=${startLine} end=${endLine} human=${humanLines} line(s)`
  );
  // The human half is where the *third* pin declaration lives (the prose one).
  // Asserting it is still there proves the rule aims at the right region — and
  // that "no anchor after the end marker" is about the anchors, not about
  // banning every shape of pin declaration from the human half.
  const humanPins = findDocPins(docLines.slice(endLine).join("\n"));
  check(
    "...and it is the region that still holds the third (prose) pin declaration",
    humanPins.pins.length === 1 && humanPins.pins[0].where === "正文固定 SHA",
    JSON.stringify(humanPins.pins.map((pin) => [pin.where, pin.sha.slice(0, 7)]))
  );

  // (a) the marker pair split into two places: a second start marker below the
  // end marker makes the file look like it has two machine-readable regions.
  const split = [
    ...docLines.slice(0, endLine),
    MACHINE_READABLE_START,
    ...docLines.slice(endLine),
  ].join("\n");
  const splitViolations = machineReadableBlockViolations(split);
  check(
    "a second machine-readable start marker goes red, naming the marker and both lines",
    splitViolations.length === 1 &&
      splitViolations[0].includes(MACHINE_READABLE_START) &&
      splitViolations[0].includes("2 次") &&
      splitViolations[0].includes(String(startLine)) &&
      splitViolations[0].includes(String(endLine + 1)),
    splitViolations.join("；")
  );
  check(
    "...and that copy differs from the doc by exactly one inserted line",
    split.split(/\r?\n/).length === docLines.length + 1,
    `doc=${docLines.length} copy=${split.split(/\r?\n/).length}`
  );

  // (b) an anchor copied into the human half: the file now says the same thing
  // twice, and the copy is the one nobody reads.
  const copied = [
    ...docLines.slice(0, endLine),
    "### 核对通路账",
    ...docLines.slice(endLine),
  ].join("\n");
  const copiedViolations = machineReadableBlockViolations(copied);
  check(
    "an anchor copied into the human half goes red, naming that line",
    copiedViolations.length === 1 &&
      copiedViolations[0].includes("人读区") &&
      copiedViolations[0].includes("核对通路账") &&
      copiedViolations[0].includes(String(endLine + 1)),
    copiedViolations.join("；")
  );
  check(
    "...and that copy differs from the doc by exactly one inserted line too",
    copied.split(/\r?\n/).length === docLines.length + 1,
    `doc=${docLines.length} copy=${copied.split(/\r?\n/).length}`
  );

  // (c) the two markers in the wrong order: the region would be the lines
  // *before* the end marker, which is not what the file means.
  const swapped = docLines
    .map((line, index) => {
      if (index + 1 === startLine) return line.replace(MACHINE_READABLE_START, MACHINE_READABLE_END);
      if (index + 1 === endLine) return line.replace(MACHINE_READABLE_END, MACHINE_READABLE_START);
      return line;
    })
    .join("\n");
  const swappedViolations = machineReadableBlockViolations(swapped);
  check(
    "the two markers in the wrong order go red, naming both lines",
    swappedViolations.length === 1 &&
      swappedViolations[0].includes("顺序颠倒") &&
      swappedViolations[0].includes(String(startLine)) &&
      swappedViolations[0].includes(String(endLine)),
    swappedViolations.join("；")
  );
  check(
    "...and only the two marker lines changed",
    swapped
      .split(/\r?\n/)
      .filter((line, index) => line !== docLines[index]).length === 2,
    "the swap must not have touched anything else"
  );
}

/* ---- the human half opens with two kinds of rules, kept apart ----
 * The rules this suite enforces are spread across the anchor check, the ledger
 * binding and the archive rule. The doc has to carry an entry point for a
 * first-time editor — but not one flat list, because the old list mixed two
 * readers:
 *
 *   - what a person does to this file (keep one round, append-only archive, a
 *     ledger row every round);
 *   - what only `tools/upstream-watch.mjs` knows (anchor shapes, pin arity,
 *     "do not copy anchor literals").
 *
 * The second group is a pointer, not prose. The checks below assert both
 * subsections exist in that order, that the human one is a real numbered list,
 * and that the pointer names the module. Each way of breaking the shape is
 * asked on a one-line edit, so a failure names its own cause.
 */
{
  const doc = fs.readFileSync(SYNC_DOC, "utf8");
  const docLines = doc.split(/\r?\n/);
  const endAt = docLines.findIndex((line) => line.includes(MACHINE_READABLE_END)) + 1;
  const human = docLines.slice(endAt);
  const headingAt = human.findIndex((line) => line.trim().startsWith(AUTHORING_RULES_HEADING));
  const headingEnd = human.findIndex(
    (line, index) => index > headingAt && /^#{1,2}\s/.test(line)
  );
  const section =
    headingAt === -1 ? [] : human.slice(headingAt + 1, headingEnd === -1 ? undefined : headingEnd);
  const humanAt = section.findIndex((line) => line.trim().startsWith(AUTHORING_HUMAN_HEADING));
  const scriptAt = section.findIndex((line) => line.trim().startsWith(AUTHORING_SCRIPT_HEADING));
  const humanBody =
    humanAt === -1 ? [] : section.slice(humanAt + 1, scriptAt === -1 ? undefined : scriptAt);
  const rules = humanBody.filter((line) => /^\s*\d+\.\s*\S/.test(line)).length;

  const violations = docAuthoringRuleViolations(doc);
  check(
    "the sync doc's human half carries the editing rules above the current round",
    violations.length === 0,
    violations.join("；") || "no violation"
  );

  check(
    "the rules are split into a human checklist and a pointer for the audit code",
    headingAt !== -1 && humanAt !== -1 && scriptAt !== -1 && humanAt < scriptAt,
    JSON.stringify({
      heading: AUTHORING_RULES_HEADING,
      human: AUTHORING_HUMAN_HEADING,
      script: AUTHORING_SCRIPT_HEADING,
      humanAt,
      scriptAt,
    })
  );
  check(
    "...and the human half is a checklist, not a title: at least the minimum number of numbered rules",
    AUTHORING_RULES_MIN >= 3 && rules >= AUTHORING_RULES_MIN,
    JSON.stringify({ heading: AUTHORING_HUMAN_HEADING, rules, minimum: AUTHORING_RULES_MIN })
  );
  check(
    "...and the script half points at tools/upstream-watch.mjs instead of restating it",
    scriptAt !== -1 && section.slice(scriptAt + 1).join("\n").includes(AUTHORING_SCRIPT_POINTER),
    JSON.stringify({ pointer: AUTHORING_SCRIPT_POINTER, scriptAt })
  );

  // (a) the parent heading deleted: both subsections may still sit there, but
  // nothing says they are the entry point.
  const withoutHeading = docLines
    .filter((line) => !line.trim().startsWith(AUTHORING_RULES_HEADING))
    .join("\n");
  const missing = docAuthoringRuleViolations(withoutHeading);
  check(
    "deleting that section goes red and names the missing entry point",
    missing.length === 1 && missing[0].includes("改这份文档之前") && missing[0].includes("规则入口"),
    JSON.stringify(missing)
  );
  check(
    "...and the copy differs from the doc by exactly one deleted line",
    withoutHeading.split(/\r?\n/).length === docLines.length - 1,
    `doc=${docLines.length} copy=${withoutHeading.split(/\r?\n/).length}`
  );

  // (b) one of the two subsections deleted: the parent heading survives, so
  // only the split itself can see that a reader lost half of the rules.
  for (const [label, heading] of [
    ["human", AUTHORING_HUMAN_HEADING],
    ["script", AUTHORING_SCRIPT_HEADING],
  ]) {
    const without = docLines.filter((line) => !line.trim().startsWith(heading)).join("\n");
    const lost = docAuthoringRuleViolations(without);
    check(
      `deleting the ${label} subsection goes red and names it`,
      lost.length === 1 && lost[0].includes("缺少") && lost[0].includes(heading.replace(/^###\s*/, "")),
      JSON.stringify(lost)
    );
    check(
      `...and the ${label} copy differs from the doc by exactly one deleted line`,
      without.split(/\r?\n/).length === docLines.length - 1,
      `doc=${docLines.length} copy=${without.split(/\r?\n/).length}`
    );
  }

  // (c) the two subsection headings swapped: the words are all still there, but
  // the reader meets the script's constraints before their own checklist.
  const swapped = (() => {
    if (humanAt === -1 || scriptAt === -1) return "";
    const out = [...docLines];
    const first = endAt + headingAt + 1 + humanAt;
    const second = endAt + headingAt + 1 + scriptAt;
    [out[first], out[second]] = [out[second], out[first]];
    return out.join("\n");
  })();
  const swapViolations = swapped ? docAuthoringRuleViolations(swapped) : [];
  check(
    "swapping the two subsections goes red, naming the order",
    swapViolations.some((violation) => violation.includes("顺序颠倒")),
    JSON.stringify(swapViolations)
  );

  // (d) the whole section moved below the current round: still present, still
  // worded the same, but no longer the first thing an editor meets.
  const block = headingAt === -1 ? [] : human.slice(headingAt, headingEnd === -1 ? undefined : headingEnd);
  const rest = headingAt === -1 ? [...human] : [...human.slice(0, headingAt), ...human.slice(headingAt + block.length)];
  const restStateAt = rest.findIndex((line) => /^##\s*当前状态（/.test(line));
  const movedDoc =
    restStateAt === -1 || !block.length
      ? ""
      : [
          ...docLines.slice(0, endAt),
          ...rest.slice(0, restStateAt + 1),
          ...block,
          ...rest.slice(restStateAt + 1),
        ].join("\n");
  const movedViolations = movedDoc ? docAuthoringRuleViolations(movedDoc) : [];
  check(
    "moving the section below the current round goes red, naming the line order",
    movedDoc !== "" &&
      movedViolations.some((violation) => violation.includes("落在当前状态")) &&
      movedViolations.some((violation) => violation.includes("改这份文档之前")),
    JSON.stringify(movedViolations)
  );

  // (e) the human checklist shrunk below the minimum: both headings are still
  // there, so only a count can see that the entry point stopped covering the
  // conventions.
  const numbered = [];
  for (let line = 0; line < humanBody.length; line += 1) {
    if (/^\s*\d+\.\s*\S/.test(humanBody[line])) numbered.push(endAt + headingAt + 1 + humanAt + 1 + line);
  }
  const removedRules = new Set(numbered.slice(AUTHORING_RULES_MIN - 1));
  const shrunk = docLines.filter((_, index) => !removedRules.has(index)).join("\n");
  const shrunkViolations = docAuthoringRuleViolations(shrunk);
  check(
    "shrinking the human checklist below the minimum goes red, naming the rule count",
    numbered.length >= AUTHORING_RULES_MIN &&
      shrunkViolations.some((violation) => violation.includes("条编号规则")),
    JSON.stringify(shrunkViolations)
  );

  // (f) the pointer replaced by a restatement: the subsection exists, it even
  // talks about the audit, but the one address a red run needs is gone.
  const withoutPointer = docLines
    .map((line) => line.split(AUTHORING_SCRIPT_POINTER).join("某个脚本"))
    .join("\n");
  const pointerViolations = docAuthoringRuleViolations(withoutPointer);
  check(
    "dropping the pointer from the script subsection goes red, naming the module",
    pointerViolations.length === 1 && pointerViolations[0].includes(AUTHORING_SCRIPT_POINTER),
    JSON.stringify(pointerViolations)
  );
  check(
    "...and that copy differs from the doc in no line's count",
    withoutPointer !== doc && withoutPointer.split(/\r?\n/).length === docLines.length,
    "only the pointer text changed"
  );
}

/* ---- the human half keeps one round, and points at the archive for the rest ----
 * The sync doc says of itself 「本文件只留当前一轮」, and until now that was prose:
 * the human half also carried the previous round's whole body under a
 * `## 上一轮（第 N 轮…）` heading, i.e. a second copy of what the archive already
 * holds. Two copies of one narrative drift, and the copy nobody updates keeps
 * reading like the current answer.
 *
 * So the shape is a rule, and the rule is asserted in both directions: the real
 * doc must be clean, and each of the four ways to break it must go red for its
 * own reason — a body coming back, the pointer disappearing, a pointer to a round
 * the archive never archived, and a pointer whose anchor is not the archived
 * heading's slug (which lands at the top of the archive file, looking like a
 * successful click).
 */
{
  const doc = fs.readFileSync(SYNC_DOC, "utf8");
  const history = fs.readFileSync(HISTORY_DOC, "utf8");
  const docLines = doc.split(/\r?\n/);
  const endLine = docLines.findIndex((line) => line.includes(MACHINE_READABLE_END)) + 1;
  const violations = previousRoundPointerViolations(doc, history);
  check(
    "the sync doc's human half keeps one round and points at the archive for the previous one",
    violations.length === 0,
    violations.join("；") || "no violation"
  );

  const pointerLine = docLines.find((line) => /^上一轮（第\s*(\d+)\s*轮）的正文见/.test(line));
  // The round the live pointer names, read from the doc rather than written
  // here: the mutations below have to keep pointing at the real pointer, and a
  // hard-coded round stops being applied the moment the pointer moves on (which
  // is once per round). Then (c) would silently become a no-op copy and go red
  // for the wrong reason — the same class of "assumption nobody checks" this
  // round is about.
  const pointerRound = pointerLine
    ? Number(/^上一轮（第\s*(\d+)\s*轮）的正文见/.exec(pointerLine)[1])
    : null;
  check(
    "...and the pointer it keeps is a sentence, not a section: no heading, one line",
    pointerLine !== undefined && !/^#{1,6}\s/.test(pointerLine),
    pointerLine || "no pointer line"
  );
  // The anchor is compared against the archive's own heading, so the two cannot
  // silently disagree; the slug rule is asserted on a real heading rather than
  // restated here.
  const archived = /^## 上游状态（第\s*(\d+)\s*轮/m.exec(history);
  check(
    "the anchor a pointer carries is the archived heading's own slug",
    archived !== null &&
      headingSlug(archived[0]) === archived[0].replace(/^##\s*/, "").toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-"),
    archived ? headingSlug(archived[0]) : "no archived section"
  );

  // (a) the previous round's body comes back — the shape this rule exists for.
  const restored = [...docLines];
  restored.splice(
    endLine + 1,
    0,
    "",
    `## 上一轮（第 ${pointerRound} 轮，2026-10-27）`,
    "",
    `第 ${pointerRound} 轮的正文又抄了一遍。`
  );
  const restoredViolations = previousRoundPointerViolations(restored.join("\n"), history);
  check(
    "a previous-round section copied back into the human half goes red, naming that line",
    restoredViolations.length >= 1 &&
      pointerRound !== null &&
      restoredViolations.some(
        (v) => v.includes(`上一轮（第 ${pointerRound} 轮）`) && v.includes(String(endLine + 3))
      ),
    restoredViolations.join("；")
  );

  // (b) the pointer removed: "no second body" would otherwise be satisfied by
  // simply dropping the mention, leaving the reader unable to find that round.
  const dropped = docLines.filter((line) => !/^上一轮（第\s*\d+\s*轮）的正文见/.test(line)).join("\n");
  const droppedViolations = previousRoundPointerViolations(dropped, history);
  check(
    "dropping the pointer instead of the body goes red too, for its own reason",
    droppedViolations.length === 1 && droppedViolations[0].includes("指针出现 0 次"),
    droppedViolations.join("；")
  );

  // (c) a pointer to a round the archive does not have.
  const wrongRound = doc.replace(
    pointerLine,
    pointerRound === null
      ? pointerLine
      : pointerLine.replace(new RegExp(`第\\s*${pointerRound}\\s*轮`), "第 999 轮")
  );
  const wrongRoundViolations = previousRoundPointerViolations(wrongRound, history);
  check(
    "a pointer to a round that was never archived goes red, naming the round",
    wrongRoundViolations.length === 1 && wrongRoundViolations[0].includes("第 999 轮"),
    wrongRoundViolations.join("；")
  );

  // (d) the right round, the wrong anchor: the round exists, but the link lands
  // at the top of the archive file instead of on that section.
  const wrongAnchor = doc.replace(pointerLine, pointerLine.replace(/upstream-history\.md#[^)]+/, "upstream-history.md#上游状态"));
  const wrongAnchorViolations = previousRoundPointerViolations(wrongAnchor, history);
  // The anchor the right round *should* carry, taken from the archive's own
  // heading for that round (not from a copy of the date typed here).
  const pointerSection =
    pointerRound === null ? undefined : historySections(history).find((entry) => entry.round === pointerRound);
  const pointerHeading =
    pointerSection === undefined ? "" : history.split(/\r?\n/)[pointerSection.line - 1] || "";
  check(
    "an anchor that is not the archived heading's slug goes red, naming both anchors",
    wrongAnchorViolations.length === 1 &&
      wrongAnchorViolations[0].includes("`#上游状态`") &&
      pointerHeading !== "" &&
      wrongAnchorViolations[0].includes(`\`#${headingSlug(pointerHeading)}\``),
    wrongAnchorViolations.join("；")
  );

  // Same fixture discipline as the machine-readable block: each copy differs from
  // the real doc in one place only, so the red cannot be explained by anything
  // else. The two one-line edits are compared by line count and by content.
  const anchorOnly = wrongAnchor.split(/\r?\n/);
  check(
    "...and the wrong-anchor copy changed exactly one line",
    anchorOnly.length === docLines.length &&
      anchorOnly.filter((line, index) => line !== docLines[index]).length === 1,
    `changed=${anchorOnly.filter((line, index) => line !== docLines[index]).length}`
  );
}

/* ---- a document that stops mid-sentence must not read as a finished one ----
 * Every check above asks the doc for a shape it wants (three pins, one pointer,
 * one table, one current-state section). None of them notices a file that simply
 * stops: cut this doc in half and the pin, the ledger and the table are all
 * still there, so the audit stays green while the last thing a reader sees is
 * half a sentence. That is the failure `docTruncationViolations` answers, and the
 * checks below ask it three ways so each fingerprint has a red of its own.
 */
{
  const doc = fs.readFileSync(SYNC_DOC, "utf8");
  const history = fs.readFileSync(HISTORY_DOC, "utf8");
  const docLines = doc.split(/\r?\n/);

  check(
    "the sync doc is not truncated: fences closed, a finished last line, a current-state body with a finished sentence",
    docTruncationViolations(doc).length === 0,
    docTruncationViolations(doc).join("；") || "no violation"
  );
  check(
    "...and the archive passes the same rule (it legitimately has no current-state section)",
    docTruncationViolations(history).length === 0,
    docTruncationViolations(history).join("；") || "no violation"
  );

  // (a) a fenced block left open. The doc is cut by deleting its last closing
  // fence, which is what a bad paste at the end of a round looks like.
  const closingFence = (() => {
    for (let index = docLines.length - 1; index >= 0; index -= 1) {
      if (docLines[index].trim() === "```") return index;
    }
    return -1;
  })();
  const unclosedFence = docLines.filter((_, index) => index !== closingFence).join("\n");
  const fenceViolations = docTruncationViolations(unclosedFence);
  // The opener the function should name: the last fence line *above* the one
  // deleted, not the first in the file.
  const openerLine = (() => {
    for (let index = closingFence - 1; index >= 0; index -= 1) {
      // A fence line may carry a language (`\`\`\`bash`), so the opener is found
      // by prefix — asking for a bare fence found the *previous* block's closer
      // and named the wrong line.
      if (docLines[index].trim().startsWith("```")) return index + 1;
    }
    return null;
  })();
  check(
    "a code block left open goes red, naming the line that opened it",
    fenceViolations.length === 1 &&
      openerLine !== null &&
      fenceViolations[0].includes(`第 ${openerLine} 行`) &&
      fenceViolations[0].includes("代码围栏"),
    fenceViolations.join("；") || "no violation"
  );
  check(
    "...and that copy differs from the doc by exactly one deleted line",
    closingFence !== -1 &&
      unclosedFence.split(/\r?\n/).length === docLines.length - 1,
    `${docLines.length} -> ${unclosedFence.split(/\r?\n/).length}`
  );

  // (b) the cut lands mid-sentence: everything is present, the last line simply
  // stops on a connector. This is the shape that reads as an editorial choice.
  const cutMidSentence = `${doc}\n本轮改动停在半路，`;
  const cutViolations = docTruncationViolations(cutMidSentence);
  check(
    "a last line that stops on a connector goes red, naming the character and the line",
    cutViolations.length === 1 &&
      cutViolations[0].includes("「，」") &&
      cutViolations[0].includes(`第 ${doc.split(/\r?\n/).length + 1} 行`) &&
      DANGLING_LINE_ENDINGS.includes("，"),
    cutViolations.join("；") || "no violation"
  );
  // The counterweight: appending a *finished* paragraph is the legitimate edit
  // every round makes, and it must stay green — otherwise the rule would just be
  // "this doc is red".
  const finishedTail = `${doc}\n本轮结论：无移植项。\n`;
  check(
    "...and appending a finished sentence stays green, so the rule is not 'any edit is red'",
    docTruncationViolations(finishedTail).length === 0,
    docTruncationViolations(finishedTail).join("；") || "no violation"
  );

  // (c) the cut lands right after a heading: a section with no body is the same
  // shape, and the heading-on-the-last-line check is the only one that sees it.
  const headingLast = `${doc}\n## 下一轮\n`;
  const headingViolations = docTruncationViolations(headingLast);
  check(
    "a document that ends on a heading goes red: a section with no body is a truncation too",
    headingViolations.length === 1 && headingViolations[0].includes("标题"),
    headingViolations.join("；") || "no violation"
  );

  // (d) the section this round rewrites, emptied. "The heading is there" was
  // already somebody else's check; the body was not.
  const stateAt = docLines.findIndex((line) => /^##\s*当前状态（/.test(line));
  const stateEnd = docLines.findIndex(
    (line, index) => index > stateAt && /^#{1,2}\s/.test(line)
  );
  const emptied = [
    ...docLines.slice(0, stateAt + 1),
    "",
    "",
    ...docLines.slice(stateEnd === -1 ? docLines.length : stateEnd),
  ].join("\n");
  const emptyViolations = docTruncationViolations(emptied);
  check(
    "an emptied current-state section goes red, naming the section's line",
    stateAt !== -1 &&
      emptyViolations.length === 1 &&
      emptyViolations[0].includes(`第 ${stateAt + 1} 行`) &&
      emptyViolations[0].includes("没有正文"),
    emptyViolations.join("；") || "no violation"
  );

  // (e) the body is there but no sentence in it is finished — the state a
  // half-written round leaves behind.
  const unfinished = [
    ...docLines.slice(0, stateAt + 1),
    "本轮复核：HEAD 未变，结论尚未写完",
    ...docLines.slice(stateEnd === -1 ? docLines.length : stateEnd),
  ].join("\n");
  const unfinishedViolations = docTruncationViolations(unfinished);
  check(
    "...and a body with no finished sentence goes red for its own reason",
    stateAt !== -1 &&
      unfinishedViolations.length === 1 &&
      unfinishedViolations[0].includes("句末标点"),
    unfinishedViolations.join("；") || "no violation"
  );
  check(
    "...and neither mutation was explained by the fence rule: both copies keep every fence",
    emptied.split(/\r?\n/).filter((line) => line.trim().startsWith("```")).length ===
      docLines.filter((line) => line.trim().startsWith("```")).length &&
      unfinished.split(/\r?\n/).filter((line) => line.trim().startsWith("```")).length ===
        docLines.filter((line) => line.trim().startsWith("```")).length,
    "fence counts differ"
  );
}

/* ---- the human half's sections: are they there, once, and this round's? ----
 * Every rule above asks the human half for something it must *contain*. None
 * asks whether a section is still *there*: delete `## 关系` and the pins, the
 * ledger, the table, the checklist and the pointer all stay exactly as they
 * were, so the audit reports full marks on a file that lost the one place
 * answering "which repository is which". `humanSectionViolations` counts the
 * required headings instead of assuming them, and adds the one question the
 * truncation rule cannot ask — a current-state body can be complete prose and
 * still belong to an earlier round. That is literally what happened in 第 97 轮:
 * the ledger gained a row, the section kept 第 96 轮's heading, and both halves
 * were internally consistent.
 *
 * Each copy below differs from the real document in one place, so a red can
 * only be explained by the mutation that caused it.
 */
{
  const doc = fs.readFileSync(SYNC_DOC, "utf8");
  const docLines = doc.split(/\r?\n/);
  const headingAt = (name) =>
    docLines.findIndex((line) => new RegExp(`^##\\s*${name}(?=[\\s（(]|$)`).test(line.trim()));

  check(
    "the human half carries every required section exactly once, and its current-state round is the ledger's last",
    humanSectionViolations(doc).length === 0,
    humanSectionViolations(doc).join("；") || "no violation"
  );

  // The list is a floor, so it needs something to stand on: every entry must
  // name a `## ` heading the real document really has once, with a reason long
  // enough for the red to be actionable. A stale name would keep this green
  // forever while pointing at a section nobody writes.
  check(
    "every required section is a real `## ` heading in the document, each with a reason worth printing",
    HUMAN_SECTIONS.length >= 4 &&
      HUMAN_SECTIONS.every(
        (section) =>
          section.name.length > 0 &&
          section.why.length >= 8 &&
          headingAt(section.name) !== -1 &&
          docLines.filter(
            (line) => new RegExp(`^##\\s*${section.name}(?=[\\s（(]|$)`).test(line.trim())
          ).length === 1
      ),
    JSON.stringify(HUMAN_SECTIONS.map((section) => `${section.name}:${headingAt(section.name) + 1}`))
  );

  // (a) the whole section gone.
  const relationAt = headingAt("关系");
  const dropped = humanSectionViolations([...docLines.slice(0, relationAt), ...docLines.slice(relationAt + 1)].join("\n"));
  check(
    "deleting a required section goes red, names it, and says the content has no other home",
    relationAt !== -1 &&
      dropped.length === 1 &&
      dropped[0].includes("## 关系") &&
      dropped[0].includes("整节不见了") &&
      dropped[0].includes("恰好 1 次"),
    dropped.join("；") || "no violation"
  );

  // (b) demoted a level: `###` is a subsection, so the human half no longer has
  // the section even though a line with that name is on the page.
  const rulesAt = headingAt("规则");
  const demotedLines = [...docLines];
  demotedLines[rulesAt] = docLines[rulesAt].replace(/^##/, "###");
  const demotedViolations = humanSectionViolations(demotedLines.join("\n"));
  check(
    "a required heading demoted to a subsection counts as missing, not as present",
    rulesAt !== -1 &&
      demotedLines.filter((line, index) => line !== docLines[index]).length === 1 &&
      demotedViolations.length === 1 &&
      demotedViolations[0].includes("## 规则"),
    demotedViolations.join("；") || "no violation"
  );

  // (c) pasted twice — the "one rule living in two places" failure, which is
  // this file's own append-only rule seen from above.
  const duplicatedLines = [...docLines];
  duplicatedLines.splice(rulesAt + 1, 0, docLines[rulesAt]);
  const duplicateViolations = humanSectionViolations(duplicatedLines.join("\n"));
  check(
    "a second copy of a required section goes red and names both lines",
    duplicateViolations.length === 1 &&
      duplicateViolations[0].includes("出现 2 次") &&
      duplicateViolations[0].includes(`第 ${rulesAt + 1}、${rulesAt + 2} 行`),
    duplicateViolations.join("；") || "no violation"
  );

  // (d) the section moved *into* the machine-readable region: the heading is on
  // the page, so "整节不见了" would be a lie, and the reader would go looking
  // for a deletion instead of for the marker it crossed.
  const endAt = docLines.findIndex((line) => line.includes(MACHINE_READABLE_END));
  const movedHead = docLines[relationAt];
  const withoutHead = [...docLines.slice(0, relationAt), ...docLines.slice(relationAt + 1)];
  // The marker is located *after* the removal, because the section being moved
  // sits below it: taking the original index would slice a range that runs
  // backwards and quietly duplicate every line between the two.
  const markerIndex = withoutHead.findIndex((line) => line.includes(MACHINE_READABLE_END));
  const movedLines = [...withoutHead.slice(0, markerIndex), movedHead, ...withoutHead.slice(markerIndex)];
  const movedIndex = markerIndex;
  const movedViolations = humanSectionViolations(movedLines.join("\n"));
  check(
    "a section that crossed into the machine-readable region is reported as moved, with the line it landed on",
    endAt !== -1 &&
      markerIndex !== -1 &&
      movedViolations.length === 1 &&
      movedViolations[0].includes("## 关系") &&
      movedViolations[0].includes("机器可读区") &&
      movedViolations[0].includes(`第 ${movedIndex + 1} 行`) &&
      !movedViolations[0].includes("整节不见了"),
    movedViolations.join("；") || "no violation"
  );

  // (e) the stale round — the shape 第 97 轮 left behind.
  const stateAt = headingAt("当前状态");
  const ledgerLast = Number(ledgerRowsIn(doc).slice(-1)[0][0]);
  const staleLines = [...docLines];
  staleLines[stateAt] = docLines[stateAt].replace(/第\s*\d+\s*轮/, `第 ${ledgerLast - 1} 轮`);
  const staleViolations = humanSectionViolations(staleLines.join("\n"));
  check(
    "a current-state heading naming an earlier round than the ledger goes red, printing both numbers",
    stateAt !== -1 &&
      staleLines.filter((line, index) => line !== docLines[index]).length === 1 &&
      staleViolations.length === 1 &&
      staleViolations[0].includes(`第 ${ledgerLast - 1} 轮`) &&
      staleViolations[0].includes(`第 ${ledgerLast} 轮`),
    staleViolations.join("；") || "no violation"
  );

  // (f) and the deferral: with no readable end marker, "where does the human
  // half start" is not this rule's question. Answering it here too would report
  // one broken file as four missing sections, pointing at the wrong cause.
  const noMarker = docLines.filter((line) => !line.includes(MACHINE_READABLE_END)).join("\n");
  check(
    "without the end marker the rule stays quiet, and the marker's own rule is the one that speaks",
    humanSectionViolations(noMarker).length === 0 &&
      humanSectionViolations("").length === 0 &&
      machineReadableBlockViolations(noMarker).length > 0,
    `${humanSectionViolations(noMarker).length} section violation(s) / ${
      machineReadableBlockViolations(noMarker).length
    } marker violation(s)`
  );
}

/* ---- the audit log is one file, and it is not a second pin authority ----
 * Thirteen round sections used to sit in the sync doc, above the pin and the
 * comparison table, each quoting an upstream SHA of its own (seven-character
 * prefixes, tag object ids). None of those matched a pin shape, so the count
 * stayed at three — by luck of wording. The structural risk was real: the pin
 * rule is "exactly three declarations", and the way that breaks is a historical
 * paragraph that happens to be shaped like a declaration. So the narrative moved
 * to its own file, and the split itself is asserted here: the sync doc keeps one
 * current-state section, the log keeps the archived rounds, and the log declares
 * no pin at all (otherwise it would be an authority nobody compares against).
 */
{
  const syncDoc = fs.readFileSync(SYNC_DOC, "utf8");
  const history = fs.readFileSync(HISTORY_DOC, "utf8");
  const stateHeadings = syncDoc.match(/^## 当前状态（/gm) || [];
  check(
    "the sync doc keeps exactly one current-state section",
    stateHeadings.length === 1,
    `${stateHeadings.length} heading(s)`
  );
  check(
    "...and carries no archived round sections any more",
    !/^## 上游状态（/m.test(syncDoc),
    "the round-by-round narrative belongs in the audit log"
  );
  const archivedRounds = history.match(/^## 上游状态（/gm) || [];
  check(
    "the audit log holds the round sections the sync doc no longer carries",
    archivedRounds.length >= 10,
    `${archivedRounds.length} section(s)`
  );
  const historyPins = findDocPins(history);
  check(
    "the audit log declares no pin and holds no pin block",
    historyPins.pins.length === 0 && historyPins.blockFound === false,
    JSON.stringify({ pins: historyPins.pins, blockFound: historyPins.blockFound })
  );

  /* ---- the archive's rule, stated as a rule instead of inferred ----
   * "No pin was found in the archive" is true for two different worlds: the
   * archive really only cites commits, or `findDocPins` has stopped matching
   * declarations at all. The distinction matters because the archive quotes
   * *whole 40-character* SHAs (a round's `refs/heads/main`, a tag object id), and
   * a future shape like "any `sha: <40 hex>`" would make those lines red for a
   * reason nobody reading the failure would guess. So the rule is two lists —
   * allowed citations, forbidden declaration shapes — and both are asserted.
   */
  const rule = historyShaRule();
  check(
    "the archive rule is one sentence that names every forbidden shape and the allowed whole SHA",
    PIN_PLACES.every((place) => rule.includes(place)) && rule.includes("40 位"),
    rule
  );
  check(
    "...and the list of allowed citation contexts is short, non-empty and spelled out",
    HISTORY_ALLOWED_SHA_CONTEXTS.length >= 2 &&
      HISTORY_ALLOWED_SHA_CONTEXTS.every(
        (context) => typeof context === "string" && context.trim().length > 0 && rule.includes(context)
      ),
    JSON.stringify(HISTORY_ALLOWED_SHA_CONTEXTS)
  );
  // The places a declaration may appear are derived from the shapes, so a fourth
  // shape in `PIN_LINE_RULES` becomes a fourth required place instead of a rule
  // that silently stops being checked (`pinPlaceCoverage` counts by name).
  check(
    "every declaration place is one line shape plus the machine block, and an empty doc misses all of them",
    PIN_PLACES.length === PIN_LINE_SHAPES.length + 1 &&
      PIN_PLACES[0] === "pin 块" &&
      PIN_LINE_SHAPES.every((shape) => PIN_PLACES.includes(shape)) &&
      JSON.stringify(pinPlaceCoverage([]).missing) === JSON.stringify([...PIN_PLACES]),
    JSON.stringify({ places: [...PIN_PLACES], shapes: [...PIN_LINE_SHAPES] })
  );

  // The real archive: it does quote whole SHAs, and none of them is in a
  // declaration shape. Both halves are asserted, because "zero violations" over a
  // document with no citations would be a vacuous pass.
  const historyCitations = findShaCitations(history);
  check(
    "the archive really does quote whole 40-character SHAs in prose",
    historyCitations.length > 0 && historyCitations.every((citation) => citation.sha.length === 40),
    `${historyCitations.length} citation(s)`
  );
  check(
    "...including commits that are not the pin, so citing another commit stays allowed",
    historyCitations.some((citation) => citation.sha !== PINNED_SHA),
    JSON.stringify([...new Set(historyCitations.map((citation) => citation.sha))])
  );
  const historyShaped = findPinShapedCitations(history);
  check(
    "no citation in the archive sits in a pin declaration shape",
    historyShaped.length === 0,
    historyShaped.length ? JSON.stringify(historyShaped) : rule
  );
  check(
    "...and every citation there is classified as a plain citation, not as a declaration",
    historyCitations.every((citation) => citation.shape === null),
    JSON.stringify(historyCitations.filter((citation) => citation.shape !== null))
  );

  // The values, not the shapes: the pin itself is the one commit the archive may
  // not quote whole. It is referred to by its 7-character prefix, which is
  // readable and cannot be mistaken for the pin's declaration; a whole copy would
  // be a second authority nobody compares against (the same failure the
  // declaration-shape rule exists to prevent). This is a value rule, so it is
  // asked of `PINNED_UPSTREAM.sha` rather than of a line shape.
  const archiveLines = history.split(/\r?\n/);
  const pinPrefix = PINNED_SHA.slice(0, 7);
  const pinLeaks = historyPinLeakViolations(history);
  check(
    "the archive never quotes the pin whole",
    pinLeaks.length === 0,
    pinLeaks.length ? JSON.stringify(pinLeaks) : `prefix ${pinPrefix}`
  );
  check(
    "...and it does refer to the pin by its 7-character prefix, so the clean answer is not vacuous",
    history.includes(pinPrefix),
    `${history.split(pinPrefix).length - 1} occurrence(s) of ${pinPrefix}`
  );
  check(
    "...while whole SHAs that are not the pin stay allowed",
    historyCitations.some((citation) => citation.sha !== PINNED_SHA) &&
      historyPinLeakViolations("`refs/heads/main` = `" + "e".repeat(40) + "`").length === 0,
    JSON.stringify([...new Set(historyCitations.map((citation) => citation.sha))])
  );
  check(
    "an upper-case whole pin is the same leak, not a different string",
    historyPinLeakViolations("`" + PINNED_SHA.toUpperCase() + "`").length === 1,
    "case folding"
  );
  check(
    "a pin constant that is not a whole commit cannot pass vacuously",
    historyPinLeakViolations("no pin here", pinPrefix).length === 1,
    JSON.stringify(historyPinLeakViolations("no pin here", pinPrefix))
  );
  // The reverse control on the real archive: insert the whole pin on one line
  // and require the failure to name that line, with one line changed.
  const leakedLine = `第 99 轮：\`refs/heads/main\` = \`${PINNED_SHA}\``;
  const leakedArchive = archiveLines
    .map((line, index) => (index === 0 ? leakedLine : line))
    .join("\n");
  const leakHits = historyPinLeakViolations(leakedArchive);
  check(
    "inserting the whole pin into the archive goes red, naming that line",
    leakHits.length === 1 && /^第 1 行/.test(leakHits[0]),
    JSON.stringify(leakHits)
  );
  check(
    "...and exactly one line changed, so the red cannot be explained by anything else",
    leakedArchive.split(/\r?\n/).filter((line, index) => line !== archiveLines[index]).length === 1,
    `changed=${leakedArchive.split(/\r?\n/).filter((line, index) => line !== archiveLines[index]).length}`
  );
  // The same predicate, pointed at the sync doc, must find exactly the three
  // declarations — otherwise the archive's clean answer above could just mean
  // the predicate never matches anything.
  const syncShaped = findPinShapedCitations(syncDoc);
  check(
    "the same rule finds exactly the sync doc's three declarations, one per place",
    syncShaped.length === 3 &&
      JSON.stringify([...new Set(syncShaped.map((citation) => citation.shape))].sort()) ===
        JSON.stringify([...PIN_PLACES].sort()) &&
      syncShaped.every((citation) => citation.sha === PINNED_SHA),
    JSON.stringify(syncShaped.map((citation) => [citation.line, citation.shape]))
  );

  // The shapes, one line each, built here rather than read out of the doc: a
  // whole SHA in prose is a citation, the same SHA in any declaration shape is
  // not, and the machine block declares without matching a per-line rule.
  const proseCitation = "`refs/heads/main` = `" + PINNED_SHA + "`";
  const tagCitation = "`refs/tags/v1.13.3` 仍指向 annotated tag 对象 `" + "d".repeat(40) + "`";
  const shapeFixtures = [
    ["本轮 HEAD 核对 行", "本轮 HEAD 核对：`" + PINNED_SHA + "`（第 99 轮）"],
    ["正文固定 SHA", "固定的整串 40 位 SHA `" + PINNED_SHA + "`"],
    ["pin 块", [PIN_BLOCK_START, "sha " + PINNED_SHA, PIN_BLOCK_END].join("\n")],
  ];
  check(
    "a whole SHA cited in prose is allowed, both for the pin and for another commit",
    findShaCitations(proseCitation).length === 1 &&
      findShaCitations(proseCitation)[0].shape === null &&
      findShaCitations(tagCitation)[0].shape === null &&
      findShaCitations(tagCitation)[0].sha === "d".repeat(40),
    JSON.stringify([findShaCitations(proseCitation), findShaCitations(tagCitation)])
  );
  for (const [where, line] of shapeFixtures) {
    const shaped = findPinShapedCitations(line);
    check(
      `the ${where} shape is caught even when the SHA is a whole commit`,
      shaped.length === 1 && shaped[0].shape === where && shaped[0].sha === PINNED_SHA,
      JSON.stringify(shaped)
    );
  }
  check(
    "a hex run longer than a commit is not read as a commit with a stray digit",
    findShaCitations("blob " + PINNED_SHA + "a").length === 0,
    JSON.stringify(findShaCitations("blob " + PINNED_SHA + "a"))
  );

  // And the answer must flip on the real archive with one edited line: take a
  // genuine citation and give it the fixed line's wording. Same file, one line
  // different, so the red cannot be explained by anything else.
  const firstCitation = historyCitations[0];
  const historyLines = history.split(/\r?\n/);
  const rewritten = firstCitation
    ? historyLines
        .map((line, index) =>
          index + 1 === firstCitation.line
            ? `本轮 HEAD 核对：\`${firstCitation.sha}\`（第 99 轮：改写在归档里）`
            : line
        )
        .join("\n")
    : "";
  const rewrittenHits = firstCitation ? findPinShapedCitations(rewritten) : [];
  const rewrittenLines = rewritten.split(/\r?\n/);
  check(
    "rewriting one archived citation into a declaration shape goes red, naming that line",
    firstCitation !== undefined &&
      rewrittenHits.length === 1 &&
      rewrittenHits[0].line === firstCitation.line &&
      rewrittenHits[0].shape === "本轮 HEAD 核对 行" &&
      historyLines.filter((line, index) => line !== rewrittenLines[index]).length === 1,
    JSON.stringify({ citation: firstCitation, hits: rewrittenHits })
  );
  check(
    "...because the pin authority is the sync doc, which the log names",
    history.includes("OCR-UPSTREAM-SYNC.md"),
    UPSTREAM_HISTORY_DOC
  );
  check(
    "...and the sync doc links back to the log, so the split is discoverable from either end",
    syncDoc.includes("upstream-history.md")
  );
}

/* ---- what may still change in the archive, and what may not ----
 * The archive is a live document: a later round sometimes has to append "and
 * this is what that decision cost" to a section it did not write. Round 72 did
 * that to round 71. That is legitimate — but it was unmarked, so nothing in this
 * suite could tell it apart from a rewrite, and "which round wrote this
 * sentence" stopped being answerable by reading the file.
 *
 * So the file now states its own rule (a section's body is written once; later
 * rounds append one marked note at the end of that section; new sections go on
 * top, so heading rounds decrease), and `historyAppendViolations` is that rule
 * as a predicate. The checks below ask three things: the doc says the rule in
 * the same words, the real archive obeys it *and* actually uses the note shape
 * (a rule nobody exercises is vacuous), and a single edited line turns it red
 * with the line number.
 */
{
  const history = fs.readFileSync(HISTORY_DOC, "utf8");
  const sections = historySections(history);
  const rounds = historyRoundNumbers(history);
  check(
    "the audit log's sections all say which round they are, newest first",
    sections.length >= 10 &&
      rounds.length === sections.length &&
      rounds.every((round, index) => index === 0 || round < rounds[index - 1]),
    JSON.stringify(rounds)
  );
  // The rule has to be readable in the file, not only in this module: the next
  // person to append a note opens the doc, not `tools/upstream-watch.mjs`.
  const rule = historyAppendRule();
  const preamble = historyLinesBefore(history, sections.length ? sections[0].line : 1);
  check(
    "the annex rule is one sentence naming the note shape, the ban on rewriting, and the order",
    HISTORY_APPEND_RULE_TERMS.every((term) => rule.includes(term)) &&
      HISTORY_APPEND_RULE_TERMS.includes("补记（第 N 轮）"),
    rule
  );
  check(
    "...and the log's own preamble says the same sentence, so the rule is not only in the audit script",
    HISTORY_APPEND_RULE_TERMS.every((term) => preamble.includes(term)),
    JSON.stringify(HISTORY_APPEND_RULE_TERMS.filter((term) => !preamble.includes(term)))
  );
  check(
    "the real archive has no append violation",
    historyAppendViolations(history).length === 0,
    JSON.stringify(historyAppendViolations(history))
  );
  // "No violation" over an archive that never uses the note shape would pass for
  // the wrong reason — nothing to place wrongly. The archive has at least one
  // note, and it names a round later than its section's.
  const noted = sections.filter((section) => section.notes.length > 0);
  check(
    "...and the archive really uses the note shape, on a round later than the section's",
    noted.length >= 1 &&
      noted.every(
        (section) =>
          section.notes.every(
            (entry) => Number(HISTORY_NOTE_MARKER.exec(entry.text)[1]) > section.round
          )
      ),
    JSON.stringify(noted.map((section) => [section.round, section.notes.map((n) => n.line)]))
  );

  // The predicate against mutations of the real file, one edited line each, so a
  // red below cannot be explained by anything else in the copy.
  const lines = history.split(/\r?\n/);
  const oneLineApart = (copy) => {
    const copyLines = copy.split(/\r?\n/);
    return copyLines.length === lines.length &&
      copyLines.filter((line, index) => line !== lines[index]).length === 1;
  };
  const noteSection = noted[0];
  const noteEntry = noteSection && noteSection.notes[0];
  const noteText = noteEntry ? lines[noteEntry.line - 1] : "";

  // (a) a later round appending a note *and then* more prose: the addition is
  // allowed, the rewrite after it is not.
  // The note block ends where the next blank line is; the prose is appended
  // *after* it, which is the shape of "I added one more sentence to last round's
  // section" — the edit the rule forbids.
  let noteBlockEnd = noteEntry ? noteEntry.line : 0;
  while (noteEntry && noteBlockEnd < lines.length && lines[noteBlockEnd].trim() !== "") noteBlockEnd += 1;
  const proseAfterNote = noteEntry
    ? [
        ...lines.slice(0, noteBlockEnd),
        "",
        "  这一句是补记之后又补的叙述。",
        ...lines.slice(noteBlockEnd),
      ].join("\n")
    : "";
  const afterProseViolations = noteEntry ? historyAppendViolations(proseAfterNote) : [];
  check(
    "prose added after a note is a violation, named at its own line",
    noteEntry !== undefined &&
      noteBlockEnd > noteEntry.line &&
      proseAfterNote.split(/\r?\n/).length === lines.length + 2 &&
      afterProseViolations.length === 1 &&
      afterProseViolations[0].includes(`第 ${noteBlockEnd + 2} 行`) &&
      afterProseViolations[0].includes("只许在段末追加补记"),
    JSON.stringify({ note: noteEntry, blockEnd: noteBlockEnd, violations: afterProseViolations })
  );

  // (b) a note that claims its own section's round. One character apart from the
  // note the archive really carries, so the answer flips on the rule and nothing
  // else.
  const selfDated = noteEntry
    ? lines
        .map((line, index) =>
          index + 1 === noteEntry.line ? line.replace(/第\s*\d+\s*轮/, `第 ${noteSection.round} 轮`) : line
        )
        .join("\n")
    : "";
  const selfDatedViolations = noteEntry ? historyAppendViolations(selfDated) : [];
  check(
    "a note dated to its own section's round is a violation, named at that line",
    noteEntry !== undefined &&
      oneLineApart(selfDated) &&
      selfDatedViolations.length === 1 &&
      selfDatedViolations[0].includes(`第 ${noteEntry.line} 行`) &&
      selfDatedViolations[0].includes("必须晚于该段轮次"),
    JSON.stringify({ note: noteEntry, violations: selfDatedViolations })
  );

  // (c) the same note moved to the *top* of its section, which is where a
  // "helpful" edit puts it: the note is fine on its own, the section's body after
  // it is the thing the rule forbids touching.
  const firstBody = noteSection && noteSection.body.find((entry) => entry.text.trim() !== "");
  const noteFirst = noteEntry && firstBody
    ? [
        ...lines.slice(0, firstBody.line - 1),
        noteText,
        ...lines.slice(firstBody.line - 1, noteEntry.line - 1),
        ...lines.slice(noteEntry.line),
      ].join("\n")
    : "";
  const noteFirstViolations = noteEntry && firstBody ? historyAppendViolations(noteFirst) : [];
  check(
    "a note placed above the section's body is a violation:正文不再改写",
    noteEntry !== undefined &&
      firstBody !== undefined &&
      noteFirst.split(/\r?\n/).length === lines.length &&
      noteFirstViolations.length >= 1 &&
      noteFirstViolations[0].includes("补记之后又出现叙述"),
    JSON.stringify({ note: noteEntry, body: firstBody && firstBody.line, violations: noteFirstViolations })
  );

  // (d) the order of the sections. A round inserted *below* a newer one is the
  // shape of "I added my section at the end of the file", which is what everyone
  // does by reflex and what the archive's top-is-newest reading would hide.
  const top = sections[0];
  const reordered = top
    ? lines
        .map((line, index) => (index + 1 === top.line ? line.replace(/第\s*\d+\s*轮/, "第 1 轮") : line))
        .join("\n")
    : "";
  const reorderedViolations = top ? historyAppendViolations(reordered) : [];
  check(
    "a section that no longer reads as newer than the one below it is a violation",
    top !== undefined &&
      oneLineApart(reordered) &&
      reorderedViolations.length === 1 &&
      reorderedViolations[0].includes(`第 ${sections[1].line} 行`) &&
      reorderedViolations[0].includes("递减"),
    JSON.stringify({ top: top && top.line, violations: reorderedViolations })
  );
  // ...and a note outside any section is nobody's note: it has no round to be
  // later than, which is why the doc's preamble is not a place to add one.
  const orphanNote = [...lines.slice(0, top ? top.line - 1 : 0), "**补记（第 99 轮）**：这落在前言里。", ...lines.slice(top ? top.line - 1 : 0)].join("\n");
  const orphanViolations = historyAppendViolations(orphanNote);
  check(
    "a note in the preamble is a violation: there is no section for it to be later than",
    top !== undefined &&
      orphanViolations.length === 1 &&
      orphanViolations[0].includes(`第 ${top.line} 行`) &&
      orphanViolations[0].includes("没有可落的段"),
    JSON.stringify(orphanViolations)
  );
}

/* ---- which command may stay green, and which one has to go red ----
 * Two commands sit next to each other and answer opposite questions:
 *
 *   `npm run upstream:check`  asks the network. A moved HEAD and an unreachable
 *                             GitHub are both *answers*, so it exits 0 by
 *                             design; its three states are greps, not exit codes.
 *   `npm run audit:upstream`  runs this file: the pin, the comparison table and
 *                             the ledger. Nothing here needs the network, and
 *                             everything here is a claim that must be able to
 *                             fail.
 *
 * That split was written down backwards in the sync doc: the "exit code is always
 * 0 — green is not a safety net" paragraph pointed at `audit:upstream`, which is
 * *this* suite. The sentence is worse than a typo, because it tells the next
 * reader that every assertion below it is decorative — the natural response is to
 * stop trusting the red (or to move the checks somewhere louder) instead of
 * reading it. So both halves are pinned here: the script→file mapping is read out
 * of `package.json`, the sentence is required to name the sentinel, and the last
 * check actually runs this file with one check forced to fail and asserts the
 * child's exit code. Without that last one, `failures` could stop reaching
 * `process.exit` and every check above would still print `ok`.
 */
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const scripts = pkg.scripts || {};
  const DOTTED = path.join("tools", "upstream-watch-smoke.mjs");
  const SENTINEL = path.join("tools", "upstream-watch.mjs");
  check(
    "`audit:upstream` runs this suite, the half that is allowed to fail",
    scripts["audit:upstream"] === `node tools/upstream-watch-smoke.mjs`,
    scripts["audit:upstream"]
  );
  check(
    "...and `upstream:check` runs the sentinel, the half that always exits 0",
    scripts["upstream:check"] === `node tools/upstream-watch.mjs`,
    scripts["upstream:check"]
  );
  check(
    "...and the failing half is in `audit:static`, so it is not a command nobody runs",
    String(scripts["audit:static"] || "").includes("audit:upstream"),
    scripts["audit:static"]
  );
  // The two script names differ by one word and the files by one suffix, which is
  // exactly how a mapping gets swapped in an edit. Name both files, not just the
  // commands.
  check(
    "...with the two files distinct and both present on disk",
    DOTTED !== SENTINEL &&
      fs.existsSync(path.join(ROOT, DOTTED)) &&
      fs.existsSync(path.join(ROOT, SENTINEL)),
    JSON.stringify({ DOTTED, SENTINEL })
  );

  const doc = fs.readFileSync(SYNC_DOC, "utf8");
  const greenLine = doc
    .split(/\r?\n/)
    .find((line) => line.includes("恒绿不是安全网"));
  check(
    "the sync doc still says which command's green is not a safety net",
    greenLine !== undefined,
    greenLine ? greenLine.slice(0, 80) : "no line mentions 恒绿不是安全网"
  );
  check(
    "...and attributes always-exit-0 to `upstream:check`, not to this suite",
    greenLine !== undefined &&
      greenLine.includes("`upstream:check`") &&
      !/`audit:upstream`\s*退出码恒为\s*0/.test(greenLine),
    greenLine || ""
  );
  check(
    "...and says out loud that this suite is the half that fails",
    greenLine !== undefined && greenLine.includes("`audit:upstream`"),
    greenLine || ""
  );
  // The sentence that claims exit 0 for this suite is not a sentence anybody
  // reads twice, so it is also refused wherever else it might be copied to.
  check(
    "and no line of the sync doc claims this suite exits 0",
    !doc.split(/\r?\n/).some((line) => /`audit:upstream`\s*退出码恒为\s*0/.test(line)),
    "the failing half must not be described as green"
  );
}

if (!flags.selftest && !flags.noRespawn) {
  const ownSource = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  // The old environment names must stay gone: a leftover read of either would
  // put the environment back in charge of which mode this run is in. Built from
  // pieces so this check does not match its own source text.
  const oldEnvNames = [
    ["OCR", "UPSTREAM", "WATCH", "SELFTEST"].join("_"),
    ["OCR", "UPSTREAM", "WATCH", "NO", "SELFTEST"].join("_"),
  ];
  check(
    "the switches are argv-only: no environment variable selects a mode any more",
    oldEnvNames.every((name) => !ownSource.includes(name)),
    JSON.stringify(oldEnvNames.filter((name) => ownSource.includes(name)))
  );

  const runChild = (flag) =>
    spawnSync(process.execPath, [fileURLToPath(import.meta.url), flag], {
      encoding: "utf8",
    });

  const child = runChild(FLAGS.selftest);
  // A spawn that never ran (`ENOENT`, an unreadable script) reports `status:
  // null` — the same "not 1" as a child that ran and failed. Without this the
  // self-run's whole point ("the exit code came from a real process") is taken
  // on faith, and the reason it did not run is only in `error`.
  check(
    "...and the self-run really spawned: the child process started and exited on its own",
    child.status !== null,
    child.error
      ? `spawn failed: ${child.error.message}`
      : `status=${child.status} signal=${child.signal || "none"}`
  );
  check(
    "a failing check makes this command exit non-zero",
    child.status === 1,
    `status=${child.status} signal=${child.signal || "none"}`
  );
  check(
    "...and the injected failure is named on stderr, so the red says what failed",
    /a check that fails on purpose/.test(child.stderr || ""),
    String(child.stderr || "").trim().split(/\r?\n/).slice(-2).join(" | ")
  );

  // The bottom block's own check names are the evidence that a process ran the
  // re-spawn at all. Defined once for both children, and asserted to exist in
  // this source, so "absent from the output" can never pass because the names
  // were reworded here.
  const respawnCheckNames = ["a failing check makes this command exit non-zero", "the self-run really spawned"];
  check(
    "the names the re-spawn check looks for still exist in this file",
    respawnCheckNames.every((name) => ownSource.includes(name)),
    JSON.stringify(respawnCheckNames.filter((name) => !ownSource.includes(name)))
  );

  // The red child was spawned with `--selftest` only: it carries no
  // `--no-respawn`. If the bottom block's condition were "no flags" instead of
  // "neither flag", the red child would re-enter it and spawn a green
  // grandchild, whose check names would appear in the red child's stdout. They
  // must not: a child selected for the self-test is one level deep too.
  check(
    "...and the self-test child, spawned without --no-respawn, did not re-enter the self-run",
    respawnCheckNames.every((name) => !String(child.stdout || "").includes(name)),
    JSON.stringify({
      leaked: respawnCheckNames.filter((name) => String(child.stdout || "").includes(name)),
    })
  );

  // The other half of the same question: a run that *should* be green has to
  // stay green. Without this, the suite could be red by construction — a check
  // that always fails would still satisfy "a failing check exits 1", so the
  // exit-code contract would be met by a permanently red suite and the
  // self-test would be proving nothing.
  const green = runChild(FLAGS.noRespawn);
  check(
    "the green self-run is selected by the other flag, so one child cannot become the other",
    FLAGS.noRespawn !== FLAGS.selftest &&
      parseFlags([FLAGS.selftest]).noRespawn === false &&
      parseFlags([FLAGS.noRespawn]).selftest === false,
    JSON.stringify({ red: FLAGS.selftest, green: FLAGS.noRespawn })
  );
  check(
    "a run without --selftest exits 0 — the suite is not red by construction",
    green.status === 0,
    `status=${green.status} signal=${green.signal || "none"}`
  );
  check(
    "...and it really ran the whole suite, rather than dying before the first check",
    /all upstream-watch checks passed/.test(green.stdout || "") && !/failed:/.test(green.stderr || ""),
    String(green.stdout || "")
      .trim()
      .split(/\r?\n/)
      .slice(-1)
      .join(" | ")
  );
  // "Exited 0" on its own does not say the green child was one level deep — a
  // child that re-spawned would exit 0 too, once the recursion under it
  // finished, which it never did. The bottom block's own check names are the
  // evidence: only a process that ran the re-spawn prints them, so their
  // absence from the green child's output is what proves it stopped there.
  check(
    "...and it did not re-spawn: none of the bottom block's own checks appear in its output",
    respawnCheckNames.every((name) => !String(green.stdout || "").includes(name)),
    JSON.stringify({
      leaked: respawnCheckNames.filter((name) => String(green.stdout || "").includes(name)),
    })
  );
}

/* ---- every document a README points at must be closed ----
 * The truncation rule lived here for rounds and was only ever asked about the two
 * files this module owns, so `README.md` shipped with half a line in its
 * architecture block and nothing was red: the rule was correct and never pointed
 * at the file a stranger opens first. The list of documents is therefore derived
 * from the READMEs themselves, and the checks below go red both when a document
 * stops and when the derivation stops finding it.
 */
{
  const read = (target) => {
    const file = path.join(ROOT, target);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  };
  const readmes = README_FILES.map((name) => ({ path: name, text: fs.readFileSync(path.join(ROOT, name), "utf8") }));
  const live = productDocViolations(readmes, read);

  check(
    "every document a README points at exists and is closed, and so is the README itself",
    live.length === 0,
    live.join("；") || "no violation"
  );

  // The floor: without it a regex that stopped matching anything would leave the
  // rule above green over an empty list, which is the way this kind of check
  // dies. These four are the documents a reader is actually sent to.
  const pointers = [...new Set(readmes.flatMap((readme) => docPointers(readme.text).map((p) => p.target)))];
  const required = ["docs/measurements.md", "docs/OCR-UPSTREAM-SYNC.md", PRODUCT_DOD_DOC, "使用说明.md"];
  check(
    "the derived list still contains the documents readers are sent to",
    required.every((target) => pointers.includes(target)),
    JSON.stringify({ missing: required.filter((t) => !pointers.includes(t)), found: pointers })
  );

  const readme = readmes[0].text;
  const lines = readme.split(/\r?\n/);

  // (a) the README itself stops inside a code block: the shape that shipped.
  let closing = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim() === "```") {
      closing = index;
      break;
    }
  }
  let opener = -1;
  for (let index = closing - 1; index >= 0; index -= 1) {
    if (lines[index].trim().startsWith("```")) {
      opener = index + 1;
      break;
    }
  }
  const unclosed = lines.filter((_, index) => index !== closing).join("\n");
  const selfCut = productDocViolations([{ path: "README.md", text: unclosed }], read);
  check(
    "a README whose last code block lost its closing fence goes red, naming the file and the opener line",
    closing !== -1 &&
      opener !== -1 &&
      selfCut.length === 1 &&
      selfCut[0].startsWith("README.md：") &&
      selfCut[0].includes(`第 ${opener} 行`) &&
      selfCut[0].includes("代码围栏"),
    selfCut.join("；") || "no violation"
  );
  check(
    "...and that copy differs from the real README by exactly one deleted line",
    closing !== -1 && unclosed.split(/\r?\n/).length === lines.length - 1,
    `${lines.length} -> ${unclosed.split(/\r?\n/).length}`
  );

  // (b) a pointer to a file that is not there. The reader follows it into a 404,
  // and before this rule nothing said so.
  const danglingPointer = `${readme}\n见 [不存在的文档](docs/不存在的文档.md)。\n`;
  const missingTarget = productDocViolations([{ path: "README.md", text: danglingPointer }], read);
  check(
    "a pointer to a file that does not exist goes red, naming the target",
    missingTarget.length === 1 &&
      missingTarget[0].includes("docs/不存在的文档.md") &&
      missingTarget[0].includes("不存在"),
    missingTarget.join("；") || "no violation"
  );

  // (c) a *target* stops mid-sentence: the defect is in the linked document, and
  // the sentence has to say which one, because the README is fine.
  const truncatedTarget = productDocViolations(readmes, (target) =>
    target === "docs/measurements.md" ? `${read(target)}\n本轮改动停在半路，` : read(target)
  );
  check(
    "a document that stops mid-sentence goes red against the README that points at it",
    truncatedTarget.length === 1 &&
      truncatedTarget[0].includes("docs/measurements.md") &&
      truncatedTarget[0].includes("README.md") &&
      truncatedTarget[0].includes("「，」"),
    truncatedTarget.join("；") || "no violation"
  );

  // (d) a document that legitimately ends on a table. Read as a plain last line
  // it ends on the connector `|`, which reported finished documents as
  // truncated — the reason this fingerprint exists.
  const tableEnded = "# 标题\n\n| 项 | 路径 |\n| --- | --- |\n| 发版 | tools/release.mjs |\n";
  const tableOpen = "# 标题\n\n| 项 | 路径 |\n| --- | --- |\n| 发版 | tools/release.mjs\n";
  check(
    "a document that ends on a complete table row is finished, not truncated",
    docTruncationViolations(tableEnded).length === 0,
    docTruncationViolations(tableEnded).join("；") || "no violation"
  );
  check(
    "...and the same row with its closing pipe missing goes red as an unfinished table",
    docTruncationViolations(tableOpen).length === 1 && docTruncationViolations(tableOpen)[0].includes("表格"),
    docTruncationViolations(tableOpen).join("；") || "no violation"
  );
}

/* ---- the first screen is a product story, not a changelog ----
 * Both READMEs opened with how they are built and then ~18 verification
 * bullets; the sentence a stranger needs first ("what is this, who is it for,
 * what does it do that the terminal does not") was three sections down. The
 * checks here hold the shape that fixed it: one sentence, no flags, 3–5
 * user-facing bullets, and the long record in the section the short list links
 * to. Each rule gets a mutation that has to make it red, because a rule about
 * prose that never fires is indistinguishable from a rule nobody wired up.
 */
{
  const readmes = README_FILES.map((name) => ({ path: name, text: fs.readFileSync(path.join(ROOT, name), "utf8") }));
  const live = firstScreenViolations(readmes);
  check(
    "both READMEs open with one sentence, no CLI flags, 3–5 bullets, and the long list under the section they link to",
    live.length === 0,
    live.join("；") || "no violation"
  );

  const mutate = (name, from, to) => {
    const before = readmes.find((doc) => doc.path === name).text;
    const hits = before.split(from).length - 1;
    return { hits, text: before.replace(from, to) };
  };
  const mutated = (name, from, to) => firstScreenViolations([{ path: name, text: mutate(name, from, to).text }]);
  const hits = (name, from) => mutate(name, from, "").hits;

  const greeting = "instead of scrolling a terminal.";
  check(
    "...and the mutation below is anchored in the live greeting (a rule tested against a sentence nobody wrote proves nothing)",
    hits("README.md", greeting) === 1,
    String(hits("README.md", greeting))
  );

  const twoSentences = mutated("README.md", greeting, "instead of scrolling a terminal. It also has a tray icon.");
  check(
    "a greeting that grew a second sentence goes red, and says how many it counted",
    twoSentences.length === 1 && twoSentences[0].includes("数到 2"),
    twoSentences.join("；") || "no violation"
  );

  // A flag inside backticks is still a flag: the rule reads the raw line, so
  // this mutation is written the tempting way rather than the obvious one.
  const flagged = mutated("README.md", "pick the branch", "run `--preview` on the branch");
  check(
    "a first screen that names a CLI flag goes red, even inside backticks",
    flagged.length === 1 && flagged[0].includes("--preview"),
    flagged.join("；") || "no violation"
  );

  const wrapped = mutated("README.md", "A desktop app for people who want", "A desktop wrapper for people who want");
  check(
    "a first screen that says it is a wrapper goes red, naming the word",
    wrapped.length === 1 && wrapped[0].includes("wrapper"),
    wrapped.join("；") || "no violation"
  );

  const zhWrapped = mutate("README.zh-CN.md", "给想让 AI 真去审一遍代码", "本应用封装了官方 CLI，给想让 AI 真去审一遍代码");
  const zhViolations = firstScreenViolations([{ path: "README.zh-CN.md", text: zhWrapped.text }]);
  check(
    "...and the same rule answers for the Chinese README, not just the English one",
    zhWrapped.hits === 1 && zhViolations.length === 1 && zhViolations[0].includes("封装"),
    zhViolations.join("；") || "no violation"
  );

  // The short list: 3–5 bullets, and an anchor that resolves.
  const statusOf = (text) => {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((line) => /^##\s+/.test(line));
    let end = start + 1;
    while (end < lines.length && !/^##\s+/.test(lines[end])) end += 1;
    return lines.slice(start + 1, end);
  };
  const dropBullet = (text, nth) => {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((line) => /^##\s+/.test(line));
    let seen = 0;
    for (let index = start + 1; index < lines.length; index += 1) {
      if (!/^\s*-\s+/.test(lines[index])) continue;
      seen += 1;
      if (seen === nth) {
        lines.splice(index, 1);
        return lines.join("\n");
      }
    }
    return text;
  };
  const enText = readmes.find((doc) => doc.path === "README.md").text;
  const tooFew = firstScreenViolations([{ path: "README.md", text: dropBullet(dropBullet(dropBullet(dropBullet(enText, 5), 4), 3), 2) }]);
  check(
    "a status block cut down to one bullet goes red, saying how many it found",
    tooFew.length === 1 && tooFew[0].includes("1 条"),
    tooFew.join("；") || "no violation"
  );

  const tooMany = firstScreenViolations([
    {
      path: "README.md",
      text: enText.replace("\n\nEverything that has actually been verified", "\n- **A sixth bullet** — which is where a changelog starts again.\n\nEverything that has actually been verified"),
    },
  ]);
  check(
    "...and so does a sixth bullet (the upper bound is what keeps the first screen from becoming the old one)",
    tooMany.length === 1 && tooMany[0].includes("6 条"),
    tooMany.join("；") || "no violation"
  );

  const unlinked = firstScreenViolations([
    {
      path: "README.md",
      text: enText.replace(
        "is listed under [Verified behaviour](#verified-behaviour); which platform that record covers, and which it does not, is under [Known limitations](#known-limitations)",
        "is listed further down this file, platform by platform too"
      ),
    },
  ]);
  check(
    "a status block that stops pointing at the long list goes red: the sunk record must have an address",
    unlinked.length === 1 && unlinked[0].includes("没有指向本文件"),
    unlinked.join("；") || "no violation"
  );

  const dangling = firstScreenViolations([
    { path: "README.md", text: enText.replace("(#verified-behaviour)", "(#nowhere)") },
  ]);
  check(
    "...and a link whose anchor matches no heading goes red by name",
    dangling.length === 1 && dangling[0].includes("#nowhere"),
    dangling.join("；") || "no violation"
  );

  // The sink has to still hold the record. This is the quiet failure: the
  // pointer stays, the section stays, and the eighteen bullets quietly leave.
  const emptied = enText.replace("## Verified behaviour", "## Verified behaviour\n\nNothing to see here yet.\n");
  const lostRecord = firstScreenViolations([{ path: "README.md", text: emptied.replace(/^- .*\n/gm, "") }]);
  check(
    "a linked section that lost its bullets goes red: the promise \"everything is under X\" needs X to still hold it",
    lostRecord.length >= 1 && lostRecord.some((violation) => violation.includes("长清单被删掉了")),
    lostRecord.join("；") || "no violation"
  );
  check(
    "...and the empty section really is a section on its own (the anchor still resolves, so the red is about the bullets)",
    /^##\s+Verified behaviour\s*$/m.test(emptied) && /\]\(#verified-behaviour\)/.test(emptied),
    String(statusOf(emptied).length)
  );

  // 5. the platform matrix. Until the previous round it filled the first screen's
  // second paragraph in both READMEs — `x64`, installer + portable, the dated green
  // run, "macOS has never been built" — which is the release-and-CI record, not an
  // answer to "can I run this tomorrow". These mutations paste that record back.
  //
  // The status sentence is the needle, and it is *derived* rather than written
  // out: it carries this app's version and the pinned release, both of which
  // change, and a hardcoded copy turns a pin advance into "go find the fixtures
  // that quote the old tag". What is asserted first is that the derived needle
  // still matches the live README exactly once — a needle that stops matching
  // would make the mutation a no-op and the red below would look like a
  // first-screen bug rather than like this control having lost its object.
  const readmePkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const enStatus = "`v" + readmePkg.version + "`, running `ocr " + PINNED_UPSTREAM.tag + "`";
  check(
    "the English README's status sentence is still the needle this control mutates",
    hits("README.md", enStatus) === 1,
    JSON.stringify({ needle: enStatus, hits: hits("README.md", enStatus) })
  );
  const enMatrix = mutated(
    "README.md",
    enStatus,
    "Verification is not uniform across platforms: **Windows x64 is the only end-to-end platform, and the only build Releases publishes** (`*-setup.exe` + portable); the `*.dmg` and the AppImage / `.deb` have never been produced.\n\n" +
      enStatus
  );
  check(
    "pasting the platform matrix back into the first screen goes red, naming the token and the line",
    enMatrix.length === 1 && enMatrix[0].includes("x64") && /第 \d+ 行/.test(enMatrix[0]),
    enMatrix.join("；") || "no violation"
  );

  const zhMatrix = firstScreenViolations([
    {
      path: "README.zh-CN.md",
      text: mutate("README.zh-CN.md", "`v0.1.13`（最新）", "**Windows x64 是唯一端到端验证过的平台**；Linux x64 上 2026-11-03 全绿，但没有产出过 AppImage 或 `.deb`；macOS 从未构建。\n\n`v0.1.13`（最新）").text,
    },
  ]);
  check(
    "...and the Chinese README's matrix is refused by the same rule, not a translation of it",
    zhMatrix.length === 1 && zhMatrix[0].includes("x64") && zhMatrix[0].includes("版本状态"),
    zhMatrix.join("；") || "no violation"
  );

  const platformBullet = mutated("README.md", "- **Your key stays yours**", "- **Windows and Linux** — one platform per bullet");
  check(
    "a bullet per platform goes red on its own (the count is still 5, so this is not the short-list rule)",
    platformBullet.length === 1 && platformBullet[0].includes("按平台列的一条"),
    platformBullet.join("；") || "no violation"
  );

  // The rule is about *where* the record sits. Written into Known limitations — the
  // section that already holds it in full — the same sentence must stay green,
  // otherwise this is a ban on the fact rather than on the first screen.
  const limitationCopy = mutate(
    "README.md",
    "- Git must be on `PATH`.",
    "- Windows x64 is the only end-to-end platform (`*-setup.exe` + portable; no `*.dmg`, no AppImage, no `.deb`).\n- Git must be on `PATH`."
  );
  const sunkIntoLimitations = firstScreenViolations([
    {
      path: "README.md",
      text: limitationCopy.text,
    },
  ]);
  check(
    "...and the identical matrix under Known limitations stays green: the rule refuses the place, not the fact",
    limitationCopy.hits === 1 &&
      /x64/.test(limitationCopy.text) &&
      !/x64/.test(statusOf(limitationCopy.text).join("\n")) &&
      sunkIntoLimitations.length === 0,
    sunkIntoLimitations.join("；") || "no violation"
  );
}

/* ---- the READMEs are read by strangers, not by the review panel ----
 * The install section opened with "the environment this is reviewed and demoed
 * on is Windows x64" / 「初审答辩环境：Windows x64」. Both sentences are true and
 * both are about us: they name an internal occasion, so a first-time installer
 * is told which audience the sentence was written for instead of which file to
 * download. The wording is fixed; these checks keep it fixed.
 *
 * The controls are the two ways this rule could be wrong: it could pass by
 * reading nothing (no README text at all), and it could refuse the platform fact
 * along with the internal word — which would push the honest sentence out with
 * the dishonest one.
 */
{
  const readmes = README_FILES.map((name) => ({ path: name, text: fs.readFileSync(path.join(ROOT, name), "utf8") }));
  const live = readmeInternalTermViolations(readmes);
  check(
    "neither README names an internal occasion (defence / review panel / demo) in its install steps",
    live.length === 0,
    live.join("；") || "no violation"
  );

  // The premise: the rule has to be reading the files, not an empty list.
  check(
    "...and the rule is reading both READMEs, not an empty list",
    readmes.length === README_FILES.length &&
      readmes.every((doc) => doc.text.length > 1000) &&
      readmeInternalTermViolations([]).length === 0,
    JSON.stringify(readmes.map((doc) => ({ path: doc.path, chars: doc.text.length })))
  );

  // The defect itself, put back where it was: the two sentences this round
  // replaced. Each has to be named by file, line and word.
  const zhBack = readmes.map((doc) =>
    doc.path === "README.zh-CN.md"
      ? { ...doc, text: doc.text.replace("**已验证环境：Windows x64", "**初审答辩环境：Windows x64") }
      : doc
  );
  const zhViolations = readmeInternalTermViolations(zhBack);
  check(
    "...and the Chinese sentence this round replaced goes red, naming the file, the line and the word",
    zhViolations.length === 1 &&
      zhViolations[0].includes("README.zh-CN.md") &&
      /第 \d+ 行/.test(zhViolations[0]) &&
      zhViolations[0].includes("答辩"),
    zhViolations.join("；") || "no violation"
  );

  const enBack = readmes.map((doc) =>
    doc.path === "README.md"
      ? { ...doc, text: doc.text.replace("**Verified environment: Windows x64", "**The environment this is reviewed and demoed on is Windows x64") }
      : doc
  );
  const enViolations = readmeInternalTermViolations(enBack);
  check(
    "...and the English sentence goes red on the verb, not only on the Chinese noun",
    enViolations.length === 1 &&
      enViolations[0].includes("README.md") &&
      enViolations[0].includes("demoed"),
    enViolations.join("；") || "no violation"
  );

  // The honest half of the sentence is not the problem: the platform fact and
  // the file to download are exactly what the install section should say, so a
  // rule that refused them would be a rule against saying anything at all.
  const honest = readmes.map((doc) => ({
    ...doc,
    text: doc.text.replace(
      /^\*\*(?:Verified environment|已验证环境).*$/m,
      "**Verified environment: Windows x64, using the `*-setup.exe`; macOS and Linux are source-only.**"
    ),
  }));
  check(
    "...and the platform fact itself stays green: the rule refuses the internal occasion, not the honest sentence",
    readmeInternalTermViolations(honest).length === 0 &&
      README_INTERNAL_TERMS.every((term) => !honest.some((doc) => doc.text.includes(term))),
    readmeInternalTermViolations(honest).join("；") || "no violation"
  );
}

/* ---- the product bar says it is in force, and one place says it ----
 * `README.md` sends contributors to the DoD and tells them to stop adding
 * features once it is full; the file it sent them to opened with "writable draft
 * … not yet authorised", so the bar might not have been a bar at all. The status
 * was settled on 2026-10-31; these checks are what keep a re-sync from quietly
 * pasting the old header back.
 */
{
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const doc = fs.readFileSync(path.join(ROOT, PRODUCT_DOD_DOC), "utf8");

  check(
    "a README still points at the DoD, so the status rule is about a live authority",
    docPointers(readme).some((p) => p.target === PRODUCT_DOD_DOC),
    JSON.stringify(docPointers(readme).map((p) => p.target))
  );
  check(
    "the DoD header reads as locked / live and carries no draft vocabulary",
    dodAuthorityViolations(doc).length === 0,
    dodAuthorityViolations(doc).join("；") || "no violation"
  );

  // The reverse control is the old header itself, put back where it was.
  const statusLine = doc.split(/\r?\n/).find((line) => line.includes("状态：")) || "";
  const reverted = doc.replace(
    statusLine,
    "> 状态：**writable draft**（2026-10-31 Asia/Shanghai）；**尚未**授权同步进 live scheduler / control prompts"
  );
  const revertedViolations = dodAuthorityViolations(reverted);
  check(
    "putting the draft header back goes red, naming the words that made it a contradiction",
    statusLine !== "" &&
      revertedViolations.length === 1 &&
      DOD_DRAFT_TERMS.some((term) => revertedViolations[0].includes(`「${term}」`)) &&
      reverted.split(/\r?\n/).length === doc.split(/\r?\n/).length,
    revertedViolations.join("；") || "no violation"
  );

  // A header that says nothing about its own status is the other half: it does
  // not contradict the README, it just leaves the reader unable to tell.
  // Both places the header could say it: the title's parenthetical and the
  // status line. Dropping only one leaves the other one answering, which is
  // exactly the "it says it somewhere" reading this rule refuses to accept.
  const silent = doc
    .replace(statusLine, "> 状态：见下文")
    .replace("（locked / live）", "")
    .replace("锁定稿", "规范稿");
  check(
    "...and a header with no status at all goes red for its own reason",
    statusLine !== "" &&
      dodAuthorityViolations(silent).length === 1 &&
      dodAuthorityViolations(silent)[0].includes("「状态」一行没有写明"),
    dodAuthorityViolations(silent).join("；") || "no violation"
  );
}

/* ---- the bar's checkboxes are readable, and a tick has to be earned ----
 * The DoD is the only input to the next round, so "which items are still open"
 * has to be a thing the audit can answer — and a tick has to point at a record
 * inside this repository, because the coding side may not declare itself done.
 * The live document is all-unchecked, which is exactly why the interesting
 * controls are the ones that *add* a tick: a rule that only ever sees `[ ]`
 * would pass by never being asked.
 */
{
  const doc = fs.readFileSync(path.join(ROOT, PRODUCT_DOD_DOC), "utf8");
  const exists = (target) => fs.existsSync(path.join(ROOT, target));
  const lines = doc.split(/\r?\n/);
  const items = dodChecklist(doc);

  check(
    "the DoD's checkbox lines all carry a stable ID, and the locked set is still there",
    items.length === DOD_CHECKBOX_IDS.length &&
      items.map((item) => item.id).join(",") === DOD_CHECKBOX_IDS.join(","),
    JSON.stringify(items.map((item) => ({ line: item.line, id: item.id, state: item.state })))
  );
  check(
    "the live DoD passes the checkbox rules (no tick without evidence, no third state)",
    dodCheckboxViolations(doc, exists).length === 0,
    dodCheckboxViolations(doc, exists).join("；") || "no violation"
  );

  // (a) an item that lost its ID: the line is still a checkbox, so the count
  // stays right and only the ID rule can see it.
  const first = items[0];
  const noId = lines
    .map((line, index) => (index + 1 === first.line ? line.replace(`${first.id}：`, "") : line))
    .join("\n");
  const noIdViolations = dodCheckboxViolations(noId, exists);
  // Two sentences, and both are true: the line has no ID, *and* the locked set
  // is now short one ID. Reporting only the first would let a reader think the
  // item is still counted somewhere.
  check(
    "...and an item that lost its ID goes red, naming the line and the ID that left the set",
    noIdViolations.length === 2 &&
      noIdViolations.some((v) => v.includes(`第 ${first.line} 行`) && v.includes("没有稳定 ID")) &&
      noIdViolations.some((v) => v.includes(`少了 ${first.id}`)) &&
      dodChecklist(noId).length === items.length,
    noIdViolations.join("；") || "no violation"
  );

  // (b) a tick with nothing behind it — the shape this rule exists for.
  const ticked = lines
    .map((line, index) => (index + 1 === first.line ? line.replace("- [ ]", "- [x]") : line))
    .join("\n");
  const tickedViolations = dodCheckboxViolations(ticked, exists);
  check(
    "...and ticking an item with no evidence goes red, naming the item and the missing mark",
    tickedViolations.length === 1 &&
      tickedViolations[0].includes(first.id) &&
      tickedViolations[0].includes(DOD_EVIDENCE_MARK) &&
      tickedViolations[0].includes("不许自报完成"),
    tickedViolations.join("；") || "no violation"
  );

  // (c) the same tick *with* evidence that exists is green: the rule is about
  // the record, not about the square brackets. Without this control the rule
  // above could be "no item may ever be checked", which is a different rule.
  const evidenced = lines
    .map((line, index) =>
      index + 1 === first.line
        ? `${line.replace("- [ ]", "- [x]")}（${DOD_EVIDENCE_MARK}docs/measurements.md）`
        : line
    )
    .join("\n");
  check(
    "...and the same tick with evidence that exists is green: the rule is about the record, not the brackets",
    dodCheckboxViolations(evidenced, exists).length === 0,
    dodCheckboxViolations(evidenced, exists).join("；") || "no violation"
  );

  // (d) evidence that points nowhere is the same as no evidence, and the
  // sentence has to say which path was missing.
  const dangling = evidenced.replace("docs/measurements.md", "docs/no-such-record.md");
  const danglingViolations = dodCheckboxViolations(dangling, exists);
  check(
    "...and evidence pointing at a file that does not exist goes red, naming the path",
    danglingViolations.length === 1 &&
      danglingViolations[0].includes("docs/no-such-record.md") &&
      danglingViolations[0].includes("追不到记录"),
    danglingViolations.join("；") || "no violation"
  );

  // (e) evidence on an item that is still open: the contradiction that makes
  // the next tick look already-earned.
  const premature = lines
    .map((line, index) =>
      index + 1 === first.line ? `${line}（${DOD_EVIDENCE_MARK}docs/measurements.md）` : line
    )
    .join("\n");
  const prematureViolations = dodCheckboxViolations(premature, exists);
  check(
    "...and an unchecked item that already cites evidence goes red",
    prematureViolations.length === 1 &&
      prematureViolations[0].includes("还没勾") &&
      prematureViolations[0].includes(DOD_EVIDENCE_MARK),
    prematureViolations.join("；") || "no violation"
  );

  // (f) deleting an item: the quiet way to make a bar look full.
  const dropped = lines.filter((_, index) => index + 1 !== items[items.length - 1].line).join("\n");
  const droppedViolations = dodCheckboxViolations(dropped, exists);
  check(
    "...and deleting an item goes red, naming the ID that went missing",
    droppedViolations.length === 1 &&
      droppedViolations[0].includes(DOD_CHECKBOX_IDS[DOD_CHECKBOX_IDS.length - 1]) &&
      droppedViolations[0].includes("少了"),
    droppedViolations.join("；") || "no violation"
  );

  // (g) a third state, and a duplicated ID: both are ways of answering "which
  // item is this" with something that is not an answer.
  const thirdState = lines
    .map((line, index) => (index + 1 === first.line ? line.replace("- [ ]", "- [X]") : line))
    .join("\n");
  const thirdViolations = dodCheckboxViolations(thirdState, exists);
  const duplicated = lines
    .map((line, index) =>
      index + 1 === items[1].line ? line.replace(items[1].id, first.id) : line
    )
    .join("\n");
  const duplicatedViolations = dodCheckboxViolations(duplicated, exists);
  check(
    "...and a third state or a duplicated ID each go red for their own reason",
    thirdViolations.length === 1 &&
      thirdViolations[0].includes("[X]") &&
      thirdViolations[0].includes("半勾") &&
      duplicatedViolations.some((v) => v.includes(first.id) && v.includes("ID 必须唯一")) &&
      duplicatedViolations.some((v) => v.includes(`少了 ${items[1].id}`)),
    JSON.stringify({ third: thirdViolations, duplicated: duplicatedViolations })
  );

  // (h) two items with the same text: the ID rule cannot see it, and "which one
  // did we tick" stops being answerable.
  const sameText = lines
    .map((line, index) =>
      index + 1 === items[1].line ? line.replace(items[1].text, first.text) : line
    )
    .join("\n");
  const sameTextViolations = dodCheckboxViolations(sameText, exists);
  check(
    "...and two items with identical text go red, naming both lines",
    sameTextViolations.length === 1 &&
      sameTextViolations[0].includes(`第 ${items[1].line} 行`) &&
      sameTextViolations[0].includes(`第 ${first.line} 行`) &&
      sameTextViolations[0].includes("一模一样"),
    sameTextViolations.join("；") || "no violation"
  );

  // (i) the evidence path reader, on the three spellings a person writes.
  check(
    "the evidence path is read from the mark, not from the line: note after it, backticks around it, and no mark at all",
    dodEvidenceTarget(`${DOD_EVIDENCE_MARK}docs/measurements.md（第 104 轮）`) === "docs/measurements.md" &&
      dodEvidenceTarget(`${DOD_EVIDENCE_MARK}\`docs/measurements.md\``) === "docs/measurements.md" &&
      dodEvidenceTarget("没有证据的一句话") === null,
    JSON.stringify([
      dodEvidenceTarget(`${DOD_EVIDENCE_MARK}docs/measurements.md（第 104 轮）`),
      dodEvidenceTarget(`${DOD_EVIDENCE_MARK}\`docs/measurements.md\``),
      dodEvidenceTarget("没有证据的一句话"),
    ])
  );
}

/* ---- an open item still has to say where its evidence would be ----
 * `dodCheckboxViolations` only speaks about ticks, and all six items are
 * unticked — so "no item names a single file" was a state the audit called
 * green. The candidate rule is the other half: every item must say which record
 * it would cite if it were closed today, and that path must exist.
 *
 * The controls below are the ways this rule can be wrong: it can pass by
 * reading nothing (no candidate at all), it can pass while an item has none
 * (the exact state the live document was in), it can accept a path that is not
 * in the repository, it can accept a candidate that belongs to no item, and it
 * can count the DoD's own explanation of the mark as coverage — which is what
 * the first run of this rule did, on the live document.
 */
{
  const doc = fs.readFileSync(path.join(ROOT, PRODUCT_DOD_DOC), "utf8");
  const exists = (target) => fs.existsSync(path.join(ROOT, target));
  const lines = doc.split(/\r?\n/);
  const items = dodChecklist(doc);
  const candidates = dodEvidenceCandidates(doc);

  check(
    "the live DoD passes the candidate rule: every item says where its evidence would be",
    dodEvidenceCandidateViolations(doc, exists).length === 0,
    dodEvidenceCandidateViolations(doc, exists).join("；") || "no violation"
  );
  // The premise, stated separately: a rule that reads no candidate is green for
  // the wrong reason, and "no candidates" looks exactly like "all covered".
  check(
    "...and the rule is reading something: all six IDs carry a candidate, and every candidate sits under an item",
    DOD_CHECKBOX_IDS.every((id) => candidates.some((c) => c.id === id)) &&
      candidates.every((c) => c.id !== null && c.path !== null) &&
      candidates.length >= DOD_CHECKBOX_IDS.length,
    JSON.stringify(candidates.map((c) => ({ line: c.line, id: c.id, path: c.path })))
  );

  // The defect the rule exists for: an item that names nothing. Deleting DOD-5's
  // candidates is the state the whole document was in before this round.
  const fifth = items.find((item) => item.id === "DOD-5");
  const stripped = lines
    .filter((line, index) => {
      const at = index + 1;
      return !(at > fifth.line && candidates.some((c) => c.line === at && c.id === "DOD-5"));
    })
    .join("\n");
  const strippedViolations = dodEvidenceCandidateViolations(stripped, exists);
  check(
    "...and an item with no candidate goes red, naming that ID and no other",
    strippedViolations.length === 1 &&
      strippedViolations[0].includes("DOD-5") &&
      !strippedViolations[0].includes("DOD-4") &&
      !strippedViolations[0].includes("DOD-6"),
    strippedViolations.join("；") || "no violation"
  );

  // A candidate is a pointer, so a pointer nobody can follow is the failure: the
  // path has to be in the repository, not merely plausible.
  const firstCandidate = candidates[0];
  const dangling = lines
    .map((line, index) =>
      index + 1 === firstCandidate.line
        ? line.replace(firstCandidate.path, "docs/no-such-record.md")
        : line
    )
    .join("\n");
  const danglingViolations = dodEvidenceCandidateViolations(dangling, exists);
  check(
    "...and a candidate pointing at a file that does not exist goes red, naming the line and the path",
    danglingViolations.length === 1 &&
      danglingViolations[0].includes(`第 ${firstCandidate.line} 行`) &&
      danglingViolations[0].includes("docs/no-such-record.md"),
    danglingViolations.join("；") || "no violation"
  );

  // A candidate above the first item belongs to no ID: it reads as coverage and
  // answers nothing, which is worse than an empty item because it looks done.
  const orphan = lines
    .map((line, index) =>
      index + 1 === items[0].line ? `${DOD_CANDIDATE_MARK}docs/measurements.md\n${line}` : line
    )
    .join("\n");
  const orphanViolations = dodEvidenceCandidateViolations(orphan, exists);
  check(
    "...and a candidate that sits under no item goes red instead of counting as coverage",
    orphanViolations.length === 1 &&
      orphanViolations[0].includes("不在任何一条 DOD 之下") &&
      orphanViolations[0].includes(`第 ${items[0].line} 行`),
    orphanViolations.join("；") || "no violation"
  );

  // The mark with nothing after it is the shape a hurried edit leaves behind.
  const empty = lines
    .map((line, index) => (index + 1 === firstCandidate.line ? `  ${DOD_CANDIDATE_MARK}` : line))
    .join("\n");
  const emptyViolations = dodEvidenceCandidateViolations(empty, exists);
  check(
    "...and a candidate with no path after the mark goes red, naming the line",
    emptyViolations.length === 1 &&
      emptyViolations[0].includes(`第 ${firstCandidate.line} 行`) &&
      emptyViolations[0].includes("没有路径"),
    emptyViolations.join("；") || "no violation"
  );

  // The bug this rule had on its first run: the DoD explains the mark in prose,
  // and "the line contains the mark" made that explanation an orphan candidate.
  // A mention is prose about the rule; a line that opens with the mark answers
  // it. Both halves are asserted, because "ignore mentions" alone would also
  // pass if the rule stopped reading candidates at all.
  const proseLine = lines.findIndex(
    (line) => line.includes(DOD_CANDIDATE_MARK) && !line.trimStart().startsWith(DOD_CANDIDATE_MARK)
  );
  const mentionUnderItem = lines
    .map((line, index) =>
      index + 1 === items[0].line
        ? `${line}\n  说明：条目下面那行「${DOD_CANDIDATE_MARK}<仓内路径>」是候选，不是勾选`
        : line
    )
    .join("\n");
  check(
    "...and a sentence that merely mentions the mark is not a candidate, while a line that opens with it still is",
    proseLine !== -1 &&
      !candidates.some((c) => c.line === proseLine + 1) &&
      dodEvidenceCandidates(mentionUnderItem).length === candidates.length &&
      dodEvidenceCandidateViolations(mentionUnderItem, exists).length === 0,
    JSON.stringify({
      proseLine: proseLine + 1,
      counted: candidates.some((c) => c.line === proseLine + 1),
      afterMention: dodEvidenceCandidates(mentionUnderItem).length,
      live: candidates.length,
    })
  );

  // One reader for both marks: the candidate path is read the same way the
  // evidence path is, so a note after it or backticks around it cannot make the
  // two rules disagree about which file a line names.
  const noted = lines
    .map((line, index) =>
      index + 1 === firstCandidate.line
        ? `  ${DOD_CANDIDATE_MARK}\`${firstCandidate.path}\`（第 108 轮）`
        : line
    )
    .join("\n");
  check(
    "...and the candidate path is read like the evidence path: backticks and a note after it do not change the file",
    dodEvidenceCandidates(noted)[0].path === firstCandidate.path &&
      dodEvidenceCandidateViolations(noted, exists).length === 0,
    JSON.stringify(dodEvidenceCandidates(noted)[0])
  );
}

/* ---- a candidate is a pointer; the pointer has to land on the evidence ----
 * The candidate rule settles "every item names a record and the record exists".
 * It cannot settle whether the record contains the evidence — and that was the
 * state of the whole bar: six items, every candidate path present, nobody had
 * opened one. The controls below are the ways this rule can be wrong: it can
 * pass by reading nothing, it can pass while a candidate has no declared shape,
 * it can stay green on a file that exists but lacks the evidence, it can accept
 * a shape whose candidate was deleted, and it can miss the one item that is
 * stated as an absence (`mustNot`).
 */
{
  const doc = fs.readFileSync(path.join(ROOT, PRODUCT_DOD_DOC), "utf8");
  const realRead = (target) => {
    try {
      return fs.readFileSync(path.join(ROOT, target), "utf8");
    } catch {
      return null;
    }
  };
  const candidates = dodEvidenceCandidates(doc);
  const lines = doc.split(/\r?\n/);

  check(
    "the live DoD's candidates really contain the evidence each item is about",
    dodEvidenceBodyViolations(doc, realRead).length === 0,
    dodEvidenceBodyViolations(doc, realRead).join("；") || "no violation"
  );
  // The premise, stated separately: a rule that reads no shape is green for the
  // wrong reason, and "no shapes" looks exactly like "all covered".
  check(
    "...and the rule is reading something: all six IDs have a shape, and every candidate has one",
    DOD_CHECKBOX_IDS.every((id) => DOD_EVIDENCE_SHAPES.some((shape) => shape.id === id)) &&
      candidates.every((candidate) =>
        DOD_EVIDENCE_SHAPES.some((shape) => shape.id === candidate.id && shape.path === candidate.path)
      ) &&
      DOD_EVIDENCE_SHAPES.every((shape) => shape.must.length > 0),
    JSON.stringify({
      ids: DOD_CHECKBOX_IDS.filter((id) => !DOD_EVIDENCE_SHAPES.some((s) => s.id === id)),
      shapes: DOD_EVIDENCE_SHAPES.length,
      candidates: candidates.length,
    })
  );

  // The defect the rule exists for: the file is there, the evidence is not. The
  // body is doctored rather than the document, because the candidate is fine —
  // it is the record that stopped saying what the item is about.
  const doctored = (target) =>
    target === "README.zh-CN.md" ? String(realRead(target)).replace(/非官方/g, "官方") : realRead(target);
  const missingBody = dodEvidenceBodyViolations(doc, doctored);
  check(
    "...and a candidate whose file exists but no longer says 非官方 goes red, naming the item, the path and the missing word",
    missingBody.length === 1 &&
      missingBody[0].includes("DOD-1") &&
      missingBody[0].includes("README.zh-CN.md") &&
      missingBody[0].includes("非官方"),
    missingBody.join("；") || "no violation"
  );

  // A candidate added without saying what evidence it should hold is a pointer
  // nobody has read — the exact shape the next round would leave behind.
  const firstItem = dodChecklist(doc)[0];
  const unshaped = lines
    .map((line, index) =>
      index + 1 === firstItem.line ? `${line}\n  证据候选：docs/hardening-log.md` : line
    )
    .join("\n");
  const unshapedViolations = dodEvidenceBodyViolations(unshaped, realRead);
  check(
    "...and a candidate with no declared shape goes red, naming the path",
    unshapedViolations.length === 1 &&
      unshapedViolations[0].includes("docs/hardening-log.md") &&
      unshapedViolations[0].includes("没有声明"),
    unshapedViolations.join("；") || "no violation"
  );

  // The other side of the bijection: the table still holds a shape for a
  // candidate the document no longer makes.
  const fifth = dodChecklist(doc).find((item) => item.id === "DOD-5");
  const stripped = lines
    .filter((line, index) => {
      const at = index + 1;
      return !(at > fifth.line && candidates.some((c) => c.line === at && c.id === "DOD-5"));
    })
    .join("\n");
  const strippedViolations = dodEvidenceBodyViolations(stripped, realRead);
  check(
    "...and a shape whose candidate was deleted from the DoD goes red instead of passing quietly",
    strippedViolations.length === 2 &&
      strippedViolations.every((v) => v.includes("DOD-5")) &&
      strippedViolations.some((v) => v.includes("docs/measurements.md")) &&
      strippedViolations.some((v) => v.includes("tools/release.mjs")),
    strippedViolations.join("；") || "no violation"
  );

  // A file that cannot be read is not evidence: the check has no object, and
  // "could not read it" must not be the same answer as "it is fine".
  const unreadable = dodEvidenceBodyViolations(doc, (target) =>
    target === "package.json" ? null : realRead(target)
  );
  check(
    "...and a candidate whose file cannot be read goes red rather than counting as green",
    unreadable.length === 1 &&
      unreadable[0].includes("DOD-6") &&
      unreadable[0].includes("package.json") &&
      unreadable[0].includes("读不到"),
    unreadable.join("；") || "no violation"
  );

  // DOD-6 is the one item stated as an absence ("本程序不存副本"), so it is the
  // only place `mustNot` can be exercised: a config handler that started writing
  // the file itself would still contain every `must` word.
  const writes = (target) =>
    target === "config-handler.js"
      ? `${realRead(target)}\nfs.writeFileSync(configPath, JSON.stringify(view));`
      : realRead(target);
  const writesViolations = dodEvidenceBodyViolations(doc, writes);
  check(
    "...and a record that starts writing the config itself goes red on the absence DOD-6 states",
    writesViolations.length === 1 &&
      writesViolations[0].includes("DOD-6") &&
      writesViolations[0].includes("config-handler.js") &&
      writesViolations[0].includes("自己写配置文件"),
    writesViolations.join("；") || "no violation"
  );
}

/* ---- the bar's version facts: a pin that moved must not leave the DoD behind ----
 * The DoD states two versions in prose — the upstream release this wrapper ships
 * and this app's own release. The first went stale when the pin moved to v1.13.4
 * and nothing noticed, because a version inside a sentence is not a shape any
 * other rule reads. The rule is therefore stated over the values: every `vX.Y.Z`
 * in the bar must be the pinned tag or this app's version, and nothing else.
 *
 * The controls below are the three ways this rule could be wrong: it could pass
 * by reading nothing (no token found), it could refuse the app's own version
 * (which would make it unusable and get it deleted), and it could stay green on
 * the exact defect it exists for (the old pin pasted back in).
 */
{
  const doc = fs.readFileSync(path.join(ROOT, PRODUCT_DOD_DOC), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const opts = { pinned: PINNED_UPSTREAM, appVersion: pkg.version };
  const tokens = [...doc.matchAll(DOD_VERSION_TOKEN)].map((hit) => hit[0]);

  check(
    "the live DoD's version facts are the pinned tag and this app's own version, and nothing else",
    dodPinViolations(doc, opts).length === 0,
    dodPinViolations(doc, opts).join("；") || "no violation"
  );
  // The premise: a rule that finds no version token at all is green for the
  // wrong reason, and the two states look identical from the outside.
  check(
    "...and the rule is reading something: the bar really does state both versions",
    tokens.includes(PINNED_UPSTREAM.tag) && tokens.includes(`v${pkg.version}`),
    JSON.stringify(tokens)
  );

  // The defect this rule exists for: the pin moves, the sentence does not.
  const staleTag = "v1.13.3";
  const stale = doc.split(PINNED_UPSTREAM.tag).join(staleTag);
  const staleViolations = dodPinViolations(stale, opts);
  const staleLines = stale
    .split(/\r?\n/)
    .map((line, index) => (line.includes(staleTag) ? index + 1 : null))
    .filter((n) => n !== null);
  check(
    "...and the previous pin pasted back in goes red, naming every line that still says it",
    staleViolations.length === staleLines.length &&
      staleLines.length >= 2 &&
      staleLines.every((n) => staleViolations.some((v) => v.includes(`第 ${n} 行`) && v.includes(staleTag))) &&
      staleViolations.every((v) => v.includes(PINNED_UPSTREAM.tag) && v.includes(`v${pkg.version}`)),
    JSON.stringify({ staleLines, staleViolations })
  );

  // A historical version fact is the other way a wrong number gets in: it is not
  // a stale pin, and it still does not belong in the bar.
  const historical = `${doc}\n\n- 上游 v1.13.1 新增了 review_limit_reached 警告。\n`;
  const historicalViolations = dodPinViolations(historical, opts);
  check(
    "...and a historical upstream version quoted in the bar goes red too, naming the token",
    historicalViolations.length === 1 &&
      historicalViolations[0].includes("v1.13.1") &&
      historicalViolations[0].includes("upstream-history.md"),
    historicalViolations.join("；") || "no violation"
  );

  // The app's own version is the second allowed value, and it is allowed for a
  // reason: without it the rule would refuse the bar's own release line.
  //
  // The "third version" is derived (the pin's patch + 1) rather than written out:
  // a hardcoded one is a ticking bomb — the fixture that exists to refuse a
  // version which is *not* the pin goes quiet-red the round the pin reaches that
  // number, and the red then reads like the rule broke rather than like the
  // fixture expired.
  const pinParts = PINNED_UPSTREAM.tag.replace(/^v/, "").split(".").map(Number);
  const thirdVersion = `v${pinParts[0]}.${pinParts[1]}.${pinParts[2] + 1}`;
  const ownLine = `发版：\`v${pkg.version}\` 对照上游 \`ocr ${PINNED_UPSTREAM.tag}\``;
  const futureLine = `发版：\`v${pkg.version}\` 对照上游 \`ocr ${thirdVersion}\``;
  check(
    "...and the derived third version really is neither the pin nor this app's release",
    thirdVersion !== PINNED_UPSTREAM.tag && thirdVersion !== `v${pkg.version}`,
    JSON.stringify({ thirdVersion, pinned: PINNED_UPSTREAM.tag, own: `v${pkg.version}` })
  );
  check(
    "...and the app's own version is allowed, while a third version in the same sentence is not",
    dodPinViolations(ownLine, opts).length === 0 &&
      dodPinViolations(futureLine, opts).length === 1 &&
      dodPinViolations(futureLine, opts)[0].includes(thirdVersion),
    JSON.stringify([dodPinViolations(ownLine, opts), dodPinViolations(futureLine, opts)])
  );

  // No second allowed value means the app's own version would be reported as a
  // stale pin — a rule that cannot tell the two apart gets switched off by the
  // first person who hits it, so the missing argument is red rather than silent.
  const noAppVersion = dodPinViolations(doc, { pinned: PINNED_UPSTREAM });
  check(
    "...and a caller that forgets the app version goes red instead of reporting the app's own version as stale",
    noAppVersion.length === 3 &&
      noAppVersion[0].includes("package.json 的 version") &&
      noAppVersion.slice(1).every((v) => v.includes(`v${pkg.version}`)),
    noAppVersion.join("；") || "no violation"
  );
}

/* ---- a candidate that is a harness has to be a harness something runs ----
 * The candidate rules settle "the pointer resolves" and "the record says the
 * thing". Neither settles "does anything run it": a file under `tools/` can
 * exist, contain every word its shape asks for, and still be dead code. The
 * closure is computed from `package.json` (audit* scripts → `npm run` chains →
 * `node <file>` → relative imports and `tools/...` literals), so the answer is
 * derived rather than listed.
 *
 * The controls below are the ways this rule can be wrong: it can pass by having
 * no harness candidate at all, and it can stay green when the script line that
 * runs the candidate is deleted.
 */
{
  const doc = fs.readFileSync(path.join(ROOT, PRODUCT_DOD_DOC), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const realRead = (target) => {
    try {
      return fs.readFileSync(path.join(ROOT, target), "utf8");
    } catch {
      return null;
    }
  };
  const closure = auditScriptClosure(pkg, realRead);
  const candidates = dodEvidenceCandidates(doc);
  const harnesses = candidates.filter(
    (candidate) => candidate.path !== null && DOD_HARNESS_PATH.test(candidate.path)
  );

  check(
    "every DoD candidate that is a harness is inside the audit* dependency closure",
    dodHarnessReachViolations(doc, { pkg, read: realRead }).length === 0,
    dodHarnessReachViolations(doc, { pkg, read: realRead }).join("；") || "no violation"
  );
  // The premise, stated separately: a closure that resolved nothing would make
  // the rule above green for the wrong reason, and "nothing resolved" looks
  // exactly like "everything is covered".
  check(
    "...and the closure really resolved: audit scripts were walked, files were reached, and at least one candidate is a harness",
    closure.scripts.length >= 10 &&
      closure.files.size >= 20 &&
      closure.files.has("tools/upstream-watch-smoke.mjs") &&
      harnesses.length >= 1,
    JSON.stringify({
      scripts: closure.scripts.length,
      files: closure.files.size,
      harnesses: harnesses.map((candidate) => candidate.path),
    })
  );

  // The defect the rule exists for: the harness is there, the script line that
  // runs it is not. A package.json whose only audit script runs one harness
  // leaves every other candidate unreachable — the smallest version of "a round
  // added a check and forgot the script". The control is two-sided on purpose:
  // the harness nothing runs has to be named, and the one harness the script
  // *does* run has to be left alone. A rule that named everything would pass the
  // first half and still be useless.
  const oneScript = { scripts: { "audit:only": "node tools/secret-scan.mjs" } };
  const unreached = dodHarnessReachViolations(doc, { pkg: oneScript, read: realRead });
  check(
    "...and a package.json that runs only one of the candidate harnesses goes red on the other five, naming item and path, while the one it does run is not reported",
    unreached.length === harnesses.length - 1 &&
      unreached.every((violation) => violation.includes("没有任何")) &&
      unreached.some((violation) => violation.includes("tools/release.mjs")) &&
      unreached.some((violation) => violation.includes("tools/e2e-flow.mjs")) &&
      !unreached.some((violation) => violation.includes("tools/secret-scan.mjs")),
    unreached.join("；") || "no violation"
  );

  // A repository with no `audit*` scripts at all resolves nothing, so the rule
  // must say so instead of reporting "no unreachable harnesses".
  const noAudit = { ...pkg, scripts: { build: "vite build" } };
  const emptyClosure = dodHarnessReachViolations(doc, { pkg: noAudit, read: realRead });
  check(
    "...and a package.json with no audit* scripts goes red rather than passing with an empty closure",
    emptyClosure.length === harnesses.length &&
      emptyClosure.every((violation) => violation.includes("依赖闭包 0 个文件")),
    emptyClosure.join("；") || "no violation"
  );
}

/* ---- an unchecked item has to say why it is still unchecked ----
 * Six items sat unticked for many rounds with a candidate each and the audit was
 * green the whole time, because "no tick" was a state nothing asked about. The
 * reason line is the answer to "what would have to happen", and it has to be
 * anchored to a record rather than being a mood.
 *
 * The controls are the five ways this rule can be wrong: it can pass by reading
 * no reason at all, it can accept a placeholder, it can accept a reason that
 * points nowhere, it can stay green when a ticked item keeps its stale reason,
 * and it can ignore a reason that belongs to no item.
 */
{
  const doc = fs.readFileSync(path.join(ROOT, PRODUCT_DOD_DOC), "utf8");
  const exists = (target) => fs.existsSync(path.join(ROOT, target));
  const lines = doc.split(/\r?\n/);
  const items = dodChecklist(doc);
  const reasons = dodReasons(doc);

  check(
    "every unchecked DoD item says why it is still unchecked, and the reason points at a record in this repository",
    dodReasonViolations(doc, exists).length === 0,
    dodReasonViolations(doc, exists).join("；") || "no violation"
  );
  // The premise: one reason per unchecked item, and the rule is reading them.
  check(
    "...and the rule is reading something: one reason per unchecked item, none for a ticked one",
    reasons.length === items.filter((item) => !item.checked).length &&
      items.every((item) => item.checked || reasons.some((reason) => reason.id === item.id)),
    JSON.stringify({ items: items.length, reasons: reasons.length })
  );

  // The defect the rule exists for: the item is open and nobody has said why.
  const first = items[0];
  const firstReason = reasons.find((reason) => reason.id === first.id);
  const withoutReason = lines
    .filter((line, index) => index + 1 !== firstReason.line)
    .join("\n");
  const missingReason = dodReasonViolations(withoutReason, exists);
  check(
    "...and an item whose reason line was deleted goes red, naming the item",
    missingReason.length === 1 &&
      missingReason[0].includes(first.id) &&
      missingReason[0].includes("没有写"),
    missingReason.join("；") || "no violation"
  );

  // A placeholder is the shape of an answer, not an answer.
  const placeholder = lines
    .map((line, index) =>
      index + 1 === firstReason.line
        ? "  未勾原因：待定，等 `docs/measurements.md` 里那份记录出现之后再勾这一条。"
        : line
    )
    .join("\n");
  const placeholderViolations = dodReasonViolations(placeholder, exists);
  check(
    "...and a reason that says 待定 goes red, naming the placeholder",
    placeholderViolations.length === 1 &&
      placeholderViolations[0].includes("待定") &&
      placeholderViolations[0].includes(first.id),
    placeholderViolations.join("；") || "no violation"
  );

  // A reason that points at a file nobody can open is prose.
  const dangling = lines
    .map((line, index) =>
      index + 1 === firstReason.line
        ? "  未勾原因：等 `docs/not-a-real-record.md` 里那份记录出现之后再勾这一条。"
        : line
    )
    .join("\n");
  const danglingViolations = dodReasonViolations(dangling, exists);
  check(
    "...and a reason pointing at a file that is not there goes red, naming the path",
    danglingViolations.length === 1 &&
      danglingViolations[0].includes("docs/not-a-real-record.md") &&
      danglingViolations[0].includes("仓里没有"),
    danglingViolations.join("；") || "no violation"
  );

  // The other direction: a tick makes the reason false, so keeping it is red.
  const ticked = lines
    .map((line, index) =>
      index + 1 === first.line
        ? line.replace("- [ ]", "- [x]").replace(/\s*$/, " 证据：README.zh-CN.md")
        : line
    )
    .join("\n");
  const tickedViolations = dodReasonViolations(ticked, exists);
  check(
    "...and a ticked item that keeps its 未勾原因 goes red as a contradiction",
    tickedViolations.length === 1 &&
      tickedViolations[0].includes(first.id) &&
      tickedViolations[0].includes("已经勾上"),
    tickedViolations.join("；") || "no violation"
  );

  // A reason before the first item answers nothing.
  const orphan = ["  未勾原因：这一条不属于任何条目，只是看起来像回答了问题。", doc].join("\n");
  const orphanViolations = dodReasonViolations(orphan, exists);
  check(
    "...and a reason line that sits under no item goes red instead of being ignored",
    orphanViolations.length === 1 && orphanViolations[0].includes("不在任何一条 DOD 之下"),
    orphanViolations.join("；") || "no violation"
  );
}

/* ---- a reason that hands the call to someone else has to say what they check ----
 * DOD-2 sat on the bar with a reason that named the decider and not the decision:
 * 「这一条仍不勾，因为勾选归 scheduler 侧」. That sentence is true and useless — it
 * says the item is blocked and never what the other party has to confirm, which is
 * how an item stays unticked for many rounds while every audit is green.
 *
 * The controls are the four ways this rule can be wrong: it can pass when the
 * clause is simply missing, when the clause is a stub, when the clause points at a
 * file nobody can open, and when the clause names no record at all.
 */
{
  const doc = fs.readFileSync(path.join(ROOT, PRODUCT_DOD_DOC), "utf8");
  const exists = (target) => fs.existsSync(path.join(ROOT, target));
  const lines = doc.split(/\r?\n/);
  const reasons = dodReasons(doc);
  const delegating = reasons.filter((reason) => /归\s*scheduler\s*侧/.test(reason.text));

  check(
    "every DoD reason that hands the call to scheduler says what scheduler has to confirm",
    dodConfirmationViolations(doc, exists).length === 0,
    dodConfirmationViolations(doc, exists).join("；") || "no violation"
  );
  // The premise: the rule is reading something. A document with no delegating
  // reason would satisfy the rule for the wrong reason.
  check(
    "...and the rule is reading something: exactly one reason delegates, and it is DOD-2's",
    delegating.length === 1 && delegating[0].id === "DOD-2",
    JSON.stringify(delegating.map((reason) => ({ id: reason.id, line: reason.line })))
  );

  const two = delegating[0];
  const withoutClause = lines
    .map((line, index) =>
      index + 1 === two.line ? line.slice(0, line.indexOf(DOD_CONFIRMATION_MARK)) : line
    )
    .join("\n");
  const missing = dodConfirmationViolations(withoutClause, exists);
  check(
    "...and deleting the clause goes red, naming the item and saying the delegation is one-sided",
    missing.length === 1 && missing[0].includes("DOD-2") && missing[0].includes("没有写"),
    missing.join("；") || "no violation"
  );

  const stub = lines
    .map((line, index) =>
      index + 1 === two.line ? `${line.slice(0, line.indexOf(DOD_CONFIRMATION_MARK))}${DOD_CONFIRMATION_MARK}勾选。` : line
    )
    .join("\n");
  const stubViolations = dodConfirmationViolations(stub, exists);
  check(
    "...and a clause that is only a shrug goes red on its length",
    stubViolations.length === 1 && stubViolations[0].includes("只有") && stubViolations[0].includes("个字"),
    stubViolations.join("；") || "no violation"
  );

  const dangling = lines
    .map((line, index) =>
      index + 1 === two.line
        ? `${line.slice(0, line.indexOf(DOD_CONFIRMATION_MARK))}${DOD_CONFIRMATION_MARK}核对 \`docs/not-a-real-record.md\` 里那张表是否与本仓一致（编码侧不勾）。`
        : line
    )
    .join("\n");
  const danglingViolations = dodConfirmationViolations(dangling, exists);
  check(
    "...and a clause pointing at a file that is not there goes red, naming the path",
    danglingViolations.length === 1 &&
      danglingViolations[0].includes("docs/not-a-real-record.md") &&
      danglingViolations[0].includes("仓里没有"),
    danglingViolations.join("；") || "no violation"
  );

  const noRecord = lines
    .map((line, index) =>
      index + 1 === two.line
        ? `${line.slice(0, line.indexOf(DOD_CONFIRMATION_MARK))}${DOD_CONFIRMATION_MARK}核对一下两边说的是不是同一件事，然后再决定勾不勾这一条。`
        : line
    )
    .join("\n");
  const noRecordViolations = dodConfirmationViolations(noRecord, exists);
  check(
    "...and a clause that names no record goes red instead of passing as prose",
    noRecordViolations.length === 1 && noRecordViolations[0].includes("没有指出任何仓内路径"),
    noRecordViolations.join("；") || "no violation"
  );
}

/* ---- "what we have not verified" is a table with an owner, or it is prose ----
 * `docs/measurements.md` is the only place that records the boundary of the
 * claims. A row that says "not verified" without saying whose business it is
 * leaves the reader unable to act: upstream's gap, this repository's gap and a
 * real machine's gap are three different next steps.
 *
 * The controls are the four ways this rule can be wrong: a row can lose its
 * owner, an upstream row can be relabelled as ours while no check exists, an
 * upstream row can stop naming where upstream is tracked, and the trigger can
 * be emptied.
 */
{
  const doc = fs.readFileSync(path.join(ROOT, "docs/measurements.md"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const exists = (target) => fs.existsSync(path.join(ROOT, target));
  const realRead = (target) => {
    try {
      return fs.readFileSync(path.join(ROOT, target), "utf8");
    } catch {
      return null;
    }
  };
  const harnesses = auditScriptClosure(pkg, realRead).files;
  const table = unverifiedTable(doc);
  const opts = { exists, harnesses };

  check(
    "every row of the 未验证清单 carries an owner (上游 / 本仓 / 真机) and a pointer to a record in this repository",
    unverifiedRowViolations(doc, opts).length === 0,
    unverifiedRowViolations(doc, opts).join("；") || "no violation"
  );
  // The premise: the table was found, has the four columns, and has rows.
  check(
    "...and the rule is reading something: the table exists with its four columns and at least six rows",
    table.found &&
      table.separator !== null &&
      table.header.length === 1 &&
      table.header[0].cells.join("|") === UNVERIFIED_COLUMNS.join("|") &&
      table.rows.length >= 6 &&
      table.rows.every((row) => UNVERIFIED_OWNERS.includes(row.cells[1])),
    JSON.stringify({
      found: table.found,
      header: table.header.map((row) => row.cells),
      rows: table.rows.length,
      owners: table.rows.map((row) => row.cells[1]),
    })
  );

  const lines = doc.split(/\r?\n/);
  const firstRow = table.rows[0];
  const dropOwner = lines
    .map((line, index) =>
      index + 1 === firstRow.line
        ? `| ${firstRow.cells[0]} | ${firstRow.cells[2]} | ${firstRow.cells[3]} |`
        : line
    )
    .join("\n");
  const dropOwnerViolations = unverifiedRowViolations(dropOwner, opts);
  check(
    "...and a row that lost its owner column goes red, naming the row and the shape",
    dropOwnerViolations.length === 1 &&
      dropOwnerViolations[0].includes(`第 ${firstRow.line} 行`) &&
      dropOwnerViolations[0].includes("3 格"),
    dropOwnerViolations.join("；") || "no violation"
  );

  // The upstream row relabelled as ours: the paths it names are not in the
  // audit closure, so "this is ours and we have not checked it" is not honest.
  const upstreamRow = table.rows.find((row) => row.cells[1] === "上游");
  const relabelled = lines
    .map((line, index) =>
      index + 1 === upstreamRow.line
        ? `| ${upstreamRow.cells[0]} | 本仓 | ${upstreamRow.cells[2]} | ${upstreamRow.cells[3]} |`
        : line
    )
    .join("\n");
  const relabelledViolations = unverifiedRowViolations(relabelled, opts);
  check(
    "...and an upstream row relabelled 本仓 goes red, because nothing in the audit closure covers it",
    relabelledViolations.length === 1 &&
      relabelledViolations[0].includes("归本仓") &&
      relabelledViolations[0].includes("依赖闭包"),
    relabelledViolations.join("；") || "no violation"
  );

  // An upstream row that stops naming where upstream is tracked will never be
  // revisited.
  const untracked = lines
    .map((line, index) =>
      index + 1 === upstreamRow.line
        ? `| ${upstreamRow.cells[0]} | 上游 | 报告是上游自己生成的 HTML，排版归上游，本仓只把文件交出去（\`docs/measurements.md\` 这一节记着边界）。 | ${upstreamRow.cells[3]} |`
        : line
    )
    .join("\n");
  const untrackedViolations = unverifiedRowViolations(untracked, opts);
  check(
    "...and an upstream row that no longer names the sync doc goes red",
    untrackedViolations.length === 1 &&
      untrackedViolations[0].includes(UNVERIFIED_UPSTREAM_DOC) &&
      untrackedViolations[0].includes("归上游"),
    untrackedViolations.join("；") || "no violation"
  );

  // An empty trigger turns the row into a permanent excuse.
  const noTrigger = lines
    .map((line, index) =>
      index + 1 === firstRow.line
        ? `| ${firstRow.cells[0]} | ${firstRow.cells[1]} | ${firstRow.cells[2]} |  |`
        : line
    )
    .join("\n");
  const noTriggerViolations = unverifiedRowViolations(noTrigger, opts);
  check(
    "...and a row with an empty trigger goes red, naming the row",
    noTriggerViolations.length === 1 &&
      noTriggerViolations[0].includes("触发条件") &&
      noTriggerViolations[0].includes(`第 ${firstRow.line} 行`),
    noTriggerViolations.join("；") || "no violation"
  );
}

console.log(`\n${failures.length ? `${failures.length} failed` : "all upstream-watch checks passed"}`);
if (failures.length) {
  console.error(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
