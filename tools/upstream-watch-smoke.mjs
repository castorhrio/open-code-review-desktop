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
  MOVED_MARKER,
  PINNED_UPSTREAM,
  PIN_PLACES,
  ROWS_TO_REREAD,
  classifyGit,
  createRunner,
  describePinDisagreements,
  findDocPins,
  formatDrift,
  parseApiCommit,
  parseLsRemote,
  pinPlaceCoverage,
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
// are written out here, with no `f` in them, so the fixture cannot collapse into
// the pin by construction. (An earlier version used `"f".repeat(33)` and a
// comment claiming the whole value was written out; both were one edit away from
// a fixture that silently stopped testing anything — see the guards below.)
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
  const match = doc.match(/本轮 HEAD 核对：`([0-9a-f]{7,40})`（([^）]+)）/);
  check(
    "the sync doc carries a fixed '本轮 HEAD 核对' line with a SHA and a qualifier",
    match !== null && match[2].trim().length > 0,
    match ? `${match[1]}（${match[2]}）` : "missing"
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
