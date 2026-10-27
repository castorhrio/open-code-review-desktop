// Pins the three shapes `app:info` can answer in.
//
// `app:info` is the one piece of `main.js` the settings page reads verbatim: no
// binary, a version on stdout, a version on stderr. Each shape used to be
// assembled inline, so the only way to see a wrong one was to launch Electron
// and look at the page. `app-info.js` now holds the assembly and this suite
// calls it directly. The cases are the absent-data ones on purpose — those are
// where a fallback can silently copy the wrong half.
//
// Run with `npm run audit:appinfo`.
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(ROOT, "package.json"));
const {
  formatAppInfo,
  assembleAppInfo,
  handleAppInfo,
  readVersionOutput,
  versionAnswer,
  versionWaitMs,
  VERSION_PROBE_MS,
  VERSION_PROBE_GRACE_MS,
} = require(path.join(ROOT, "app-info.js"));
import {
  APP_INFO_COMPUTED_KEYS,
  INSTALL_INFO_KEYS,
  stubInstall,
} from "./install-fixture.mjs";

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

const base = {
  configPath: "/home/me/.opencodereview/config.json",
  docsUrl: "https://open-codereview.ai/docs",
  appVersion: "0.1.13",
  platform: "linux",
  installInfo: {
    packaged: true,
    portable: false,
    installDir: "/opt/app",
    userData: "/home/me/.config/app",
    executable: "/opt/app/app",
    canUninstall: false,
  },
};

/* ---- (a) no binary: no version, and no stale source ---- */
{
  const info = formatAppInfo({
    ...base,
    binary: { path: null, source: null },
    // Even if a caller hands over output, a missing path means the version was
    // not produced by anything. Reporting it would attach a version to "not
    // found", the one combination the page reads as "installed but broken".
    versionStdout: "open-code-review 9.9.9\n",
    versionStderr: "open-code-review 9.9.9\n",
  });
  check(
    "no binary: version is empty",
    info.version === "",
    JSON.stringify(info.version)
  );
  check(
    "no binary: binary is null and binarySource stays null",
    info.binary === null && info.binarySource === null,
    JSON.stringify({ binary: info.binary, binarySource: info.binarySource })
  );
  const missing = formatAppInfo({ ...base, binary: undefined });
  check(
    "no binary object at all: same null shape",
    missing.binary === null && missing.binarySource === null && missing.version === "",
    JSON.stringify({ binary: missing.binary, binarySource: missing.binarySource })
  );
}

/* ---- (b) binary + stdout: strip the name, keep the first line ---- */
{
  const info = formatAppInfo({
    ...base,
    binary: { path: "/opt/app/ocr", source: "local" },
    versionStdout: "\nopen-code-review 1.13.3\nwarning: something\n",
    versionStderr: "",
  });
  check(
    "stdout: the name prefix is stripped and the first non-empty line is kept",
    info.version === "1.13.3",
    JSON.stringify(info.version)
  );
  check(
    "stdout: the binary and its source are reported as given",
    info.binary === "/opt/app/ocr" && info.binarySource === "local",
    JSON.stringify({ binary: info.binary, binarySource: info.binarySource })
  );
  const bare = formatAppInfo({
    ...base,
    binary: { path: "/opt/app/ocr", source: "package" },
    versionStdout: "1.13.3\n",
  });
  check(
    "stdout: a version without the name prefix is left alone",
    bare.version === "1.13.3",
    JSON.stringify(bare.version)
  );
  // Only the product's long name is a prefix. The binary is also called `ocr`,
  // but stripping every short name a build might print is how a version loses
  // a word that was part of it; the contract is "strip exactly
  // `open-code-review`", so this line keeps its `ocr ` and the check says so.
  const shortName = formatAppInfo({
    ...base,
    binary: { path: "/opt/app/ocr", source: "package" },
    versionStdout: "ocr 1.13.3\n",
  });
  check(
    "stdout: a line starting with `ocr ` keeps that prefix (only the long name is stripped)",
    shortName.version === "ocr 1.13.3",
    JSON.stringify(shortName.version)
  );
  const noSource = formatAppInfo({ ...base, binary: { path: "/opt/app/ocr" }, versionStdout: "1.13.3\n" });
  check(
    "a path with no source reports null rather than undefined",
    noSource.binarySource === null,
    JSON.stringify(noSource.binarySource)
  );
}

/* ---- (c) binary + stderr only: read stderr instead of answering empty ---- */
{
  const info = formatAppInfo({
    ...base,
    binary: { path: "/opt/app/ocr", source: "global" },
    versionStdout: "",
    versionStderr: "open-code-review 1.13.3\nsome banner\n",
  });
  check(
    "stderr only: the first line is read and the name prefix stripped",
    info.version === "1.13.3",
    JSON.stringify(info.version)
  );
  const whitespaceStdout = formatAppInfo({
    ...base,
    binary: { path: "/opt/app/ocr", source: "global" },
    versionStdout: "  \n\t\n",
    versionStderr: "open-code-review 1.13.3\n",
  });
  check(
    "whitespace-only stdout falls through to stderr",
    whitespaceStdout.version === "1.13.3",
    JSON.stringify(whitespaceStdout.version)
  );
  const bothEmpty = formatAppInfo({
    ...base,
    binary: { path: "/opt/app/ocr", source: "global" },
    versionStdout: "",
    versionStderr: "",
  });
  check(
    "a binary that says nothing gets an empty version, not an error",
    bothEmpty.version === "" && bothEmpty.binary === "/opt/app/ocr",
    JSON.stringify({ version: bothEmpty.version, binary: bothEmpty.binary })
  );
}

/* ---- the rest of the object is passed through, including install facts ---- */
{
  const info = formatAppInfo({ ...base, binary: { path: null, source: null } });
  check(
    "config path, docs URL, app version and platform are carried through",
    info.configPath === base.configPath &&
      info.docsUrl === base.docsUrl &&
      info.appVersion === base.appVersion &&
      info.platform === base.platform,
    JSON.stringify(info)
  );
  check(
    "install facts are spread in rather than dropped",
    info.packaged === true &&
      info.portable === false &&
      info.installDir === "/opt/app" &&
      info.userData === base.installInfo.userData &&
      info.executable === base.installInfo.executable &&
      info.canUninstall === false,
    JSON.stringify(info)
  );
  // `installInfo` is the one optional half of the input: `main.js` only has it
  // when the install facts could be read, so "missing" is a real answer and not
  // a caller mistake. `undefined` (the key present, the value absent) and `null`
  // (the read failed) must both give the same shape — no `packaged`/`installDir`
  // keys at all — rather than a half-filled block the settings page would render
  // as "installed with no directory". Asserted on the key set, because
  // `...undefined` and `...null` are only one character apart in the source.
  const installKeys = ["packaged", "portable", "installDir", "userData", "executable", "canUninstall"];
  const withoutInstall = (value) => formatAppInfo({ ...base, binary: { path: "/x" }, installInfo: value });
  const undefInstall = withoutInstall(undefined);
  check(
    "installInfo: undefined drops every install field and keeps the rest",
    undefInstall.binary === "/x" &&
      installKeys.every((key) => !(key in undefInstall)) &&
      undefInstall.configPath === base.configPath &&
      undefInstall.appVersion === base.appVersion,
    JSON.stringify(Object.keys(undefInstall).sort())
  );
  const nullInstall = withoutInstall(null);
  check(
    "installInfo: null is the same answer as undefined, not a thrown error",
    nullInstall.binary === "/x" && installKeys.every((key) => !(key in nullInstall)),
    JSON.stringify(Object.keys(nullInstall).sort())
  );
  check(
    "...and the two absent shapes are key-for-key identical",
    JSON.stringify(Object.keys(undefInstall).sort()) ===
      JSON.stringify(Object.keys(nullInstall).sort()),
    JSON.stringify([Object.keys(undefInstall).sort(), Object.keys(nullInstall).sort()])
  );
  check(
    "...and a partial install block is passed through as given, without filling the gaps",
    (() => {
      const partial = formatAppInfo({
        ...base,
        binary: { path: "/x" },
        installInfo: { packaged: false },
      });
      return (
        partial.packaged === false &&
        installKeys.slice(1).every((key) => !(key in partial))
      );
    })(),
    "a caller that knows only half the facts must not receive invented ones"
  );

  const shaped = Object.keys(info).sort();
  check(
    "the answer has the four app fields, the binary pair and the install facts",
    ["appVersion", "binary", "binarySource", "configPath", "docsUrl", "platform", "version"].every((key) =>
      shaped.includes(key)
    ),
    JSON.stringify(shaped)
  );
}

/* ---- an install fact cannot answer a question this function owns ----
 * `...installInfo` is a spread, so an install field that happened to be called
 * `binary`, `version` or `configPath` would replace the value `formatAppInfo`
 * had just computed — the page would then show a version that came out of the
 * install facts, and nothing above would notice: the payload's *key set* stays
 * exactly the same when a name collides, so the pinned-key check cannot see it.
 *
 * The decision is "the fields this function computes win": a collision is a name
 * collision, not a better answer, and the losing install field is dropped. The
 * case is written with values that could only come from the collision
 * (`"evil"`, `"9.9.9"`), so a failure prints which side won instead of two
 * strings that happen to match.
 *
 * The third check is the other half: the install facts that do *not* collide must
 * still travel, otherwise "the top level wins" could be implemented by dropping
 * `installInfo` altogether and this block would stay green.
 */
{
  // The authoritative list is `APP_INFO_COMPUTED_KEYS` in
  // `tools/install-fixture.mjs`, and the checks below ask it two different
  // questions. The first is one-way: every key this function returns must be
  // named by that list, so a field cannot be added without naming the collision
  // it creates. The second is deliberately weaker than an equality check: every
  // *listed* name must be answered by at least one shape this function can take.
  // It does not derive the list from a single return value (the list stays the
  // authority), but it does catch the other drift — a field deleted from the
  // return object while its name stays listed. Without it that edit is silent:
  // the one-way check only asks "is every returned key listed", and a listed
  // name that is never returned is exactly what it does not see.
  //
  // The shapes below vary the two inputs that change the answer's content (a
  // binary with a version, no binary at all, no install facts), so a field that
  // only appears under one of them is still covered. The completeness check is
  // weak by design: it asks that no promised name is dead, not that every call
  // returns the same key set.
  //
  // The reference answer uses `installInfo: {}` (an explicit empty object), not
  // `undefined`: this block is about "which keys does the function compute", and
  // `{}` keeps the "install facts are present but empty" shape, so the spread is
  // still exercised. `undefined` would make "present but empty" and "absent" look
  // the same in the key set and blur which half supplied a key.
  const computedKeys = [...APP_INFO_COMPUTED_KEYS].sort();
  const reference = formatAppInfo({
    ...base,
    installInfo: {},
    binary: { path: "/opt/app/ocr", source: "local" },
    versionStdout: "open-code-review 1.13.3\n",
  });
  const ownKeys = Object.keys(reference).sort();
  check(
    "every key formatAppInfo returns is named by the authoritative computed-key list",
    ownKeys.every((key) => computedKeys.includes(key)),
    JSON.stringify({
      got: ownKeys,
      missingFromList: ownKeys.filter((key) => !computedKeys.includes(key)),
    })
  );
  // The other drift direction: a name the list still promises but the function
  // no longer answers. One shape would be enough today, because every key is a
  // literal in the return object; the shapes are varied anyway so the check
  // keeps asking "can this name ever be answered" if a shape-dependent field
  // appears later.
  const answeredKeys = [
    ...new Set(
      [
        reference,
        formatAppInfo({ ...base, installInfo: {}, binary: { path: null, source: null } }),
        formatAppInfo({ ...base, installInfo: undefined, binary: undefined }),
      ].flatMap((info) => Object.keys(info))
    ),
  ].sort();
  check(
    "...and every listed name is answered by at least one formatAppInfo shape",
    computedKeys.every((key) => answeredKeys.includes(key)),
    JSON.stringify({
      missingFromAnswers: computedKeys.filter((key) => !answeredKeys.includes(key)),
    })
  );
  check(
    "...and that list still contains the four fields an install fact could plausibly shadow",
    ["configPath", "docsUrl", "appVersion", "platform"].every((key) =>
      computedKeys.includes(key)
    ),
    JSON.stringify(computedKeys)
  );
  // The collision surface comes from the list, not from the return value. Every
  // listed key gets a different `evil-<key>` value, so a failure prints which
  // side won instead of two strings that happen to match.
  const colliding = {
    ...base.installInfo,
    ...Object.fromEntries(computedKeys.map((key) => [key, `evil-${key}`])),
  };
  check(
    "the collision fixture names every computed key, each with a different value",
    computedKeys.every(
      (key) => key in colliding && colliding[key] !== reference[key]
    ),
    JSON.stringify({ keys: computedKeys, colliding })
  );
  const shadowed = formatAppInfo({
    ...base,
    binary: { path: "/opt/app/ocr", source: "local" },
    versionStdout: "open-code-review 1.13.3\n",
    installInfo: colliding,
  });
  const lost = ownKeys.filter((key) => shadowed[key] !== reference[key]);
  check(
    "every key formatAppInfo returns keeps its own value when installInfo collides with all of them",
    lost.length === 0,
    JSON.stringify({
      lost: Object.fromEntries(
        lost.map((key) => [key, { got: shadowed[key], want: reference[key] }])
      ),
    })
  );
  // A collision is a name overlap, not an extra field: the payload is exactly
  // the computed keys plus the install facts that did not overlap. Built from the
  // inputs rather than from the "no install facts" answer, so this check stays
  // about the payload's shape: if the list ever carries a stale name, that name
  // travels as an ordinary install fact here while the completeness check above
  // is what goes red — the failure lands on the assertion that is about it.
  const expectedPayloadKeys = [...new Set([...ownKeys, ...Object.keys(colliding)])].sort();
  check(
    "...and a collision adds no key: the payload is the computed keys plus the install facts",
    JSON.stringify(Object.keys(shadowed).sort()) ===
      JSON.stringify(expectedPayloadKeys),
    JSON.stringify({ got: Object.keys(shadowed).sort(), want: expectedPayloadKeys })
  );
  check(
    "...and the install facts that do not collide still travel",
    shadowed.packaged === true &&
      shadowed.installDir === "/opt/app" &&
      shadowed.canUninstall === false,
    JSON.stringify({ packaged: shadowed.packaged, installDir: shadowed.installDir })
  );
}

/* ---- the shared stub fixture answers the six facts it promises ----
 * The install facts below come from `tools/install-fixture.mjs`, which is also
 * where `tools/install-info-smoke.mjs` gets its `app` / `shell` stubs. Sharing
 * them is only worth anything if the fixture itself is under test: two suites
 * agreeing about a fixture nobody checks is two suites agreeing about a typo.
 *
 * So the fixture is asked three questions here — the key set it produces, the
 * values the canonical stub has (they are the ones the page fixtures in this
 * file have always used), and whether both suites still import it. The last one
 * is a source check on purpose: a copy of the stub parameters coming back into
 * either suite is exactly the drift the shared file exists to stop, and it is
 * invisible to every behaviour check in both files.
 */
{
  const fixture = stubInstall().installInfo();
  check(
    "the shared fixture's stub answers exactly the six pinned install facts",
    JSON.stringify(Object.keys(fixture).sort()) === JSON.stringify([...INSTALL_INFO_KEYS]),
    JSON.stringify({ got: Object.keys(fixture).sort(), want: [...INSTALL_INFO_KEYS] })
  );
  check(
    "...and with the canonical installed values the page fixtures below already use",
    fixture.packaged === true &&
      fixture.portable === false &&
      fixture.installDir === base.installInfo.installDir &&
      fixture.userData === base.installInfo.userData &&
      fixture.executable === base.installInfo.executable &&
      fixture.canUninstall === base.installInfo.canUninstall,
    JSON.stringify({ fixture, base: base.installInfo })
  );
  // Both halves of "one fixture, two suites": `install-info-smoke.mjs` proves the
  // module's behaviour, this file proves the payload's shape, and the stubs they
  // build the module with are the same objects. A local `makeShell` / `makeApp`
  // in either file is how a "small tweak" starts two fixtures drifting apart.
  const suiteSources = ["app-info-smoke.mjs", "install-info-smoke.mjs"].map((name) => [
    name,
    fs.readFileSync(path.join(ROOT, "tools", name), "utf8"),
  ]);
  check(
    "both suites build their install stubs from the shared fixture",
    suiteSources.every(([, src]) => /from "\.\/install-fixture\.mjs"/.test(src)),
    JSON.stringify(suiteSources.filter(([, src]) => !/install-fixture\.mjs/.test(src)).map(([name]) => name))
  );
  check(
    "...and neither defines its own app or shell stub any more",
    suiteSources.every(
      ([, src]) => !/const (makeShell|makeApp|shellStub)\s*=/.test(src) && !/function (makeShell|makeApp)\s*\(/.test(src)
    ),
    JSON.stringify(
      suiteSources
        .filter(([, src]) => /const (makeShell|makeApp|shellStub)\s*=/.test(src) || /function (makeShell|makeApp)\s*\(/.test(src))
        .map(([name]) => name)
    )
  );
}

/* ---- the payload's key set is pinned, install facts included ----
 * Every check above asserts *a* field; none of them asserts that the set of
 * fields is the one the settings page and `src/lib/types.ts` expect. `...installInfo`
 * is a spread, so a new field in `install-info.js`'s `installInfo()` walks into
 * the IPC payload without anyone deciding to add it — and the renderer reads
 * those fields by name, so a rename there is a blank row on the page while every
 * check here stays green.
 *
 * So the install facts are not hand-written here: they come from the stub
 * fixture's `installInfo()`, and the whole key set is compared as one sorted
 * list. The `expected` list stays written out — it is the *payload* contract,
 * not a copy of the fixture — so a key added in `install-info.js` makes this red
 * with the key that appeared and the fixture check above red with the same key,
 * and the two messages together say which side moved.
 */
{
  const install = stubInstall();
  const installInfo = install.installInfo();
  const info = formatAppInfo({
    ...base,
    binary: { path: "/opt/app/ocr", source: "local" },
    installInfo,
  });
  const keys = Object.keys(info).sort();
  const expected = [
    "appVersion",
    "binary",
    "binarySource",
    "canUninstall",
    "configPath",
    "docsUrl",
    "executable",
    "installDir",
    "packaged",
    "platform",
    "portable",
    "userData",
    "version",
  ].sort();
  check(
    "the payload's key set is exactly the pinned one",
    JSON.stringify(keys) === JSON.stringify(expected),
    JSON.stringify({ got: keys, want: expected })
  );
  // The shared list of computed names has to be the payload's own half, or
  // `install-info-smoke.mjs` would be asserting "no collision" against a list
  // that has forgotten a field. Derived from the contract above (not from the
  // module), so a new computed field has to be named in both places to pass.
  const computedFromContract = expected
    .filter((key) => !INSTALL_INFO_KEYS.includes(key))
    .sort();
  check(
    "...and the shared list of computed fields is exactly the payload's non-install half",
    JSON.stringify([...APP_INFO_COMPUTED_KEYS].sort()) ===
      JSON.stringify(computedFromContract),
    JSON.stringify({
      got: [...APP_INFO_COMPUTED_KEYS].sort(),
      want: computedFromContract,
    })
  );
  check(
    "...and every install fact the install module reports is in it",
    Object.keys(installInfo).every((key) => key in info),
    JSON.stringify({ installKeys: Object.keys(installInfo).sort(), payload: keys })
  );
  check(
    "...and it carries no field that neither the app nor the install facts produced",
    keys.every(
      (key) =>
        [
          "appVersion",
          "binary",
          "binarySource",
          "configPath",
          "docsUrl",
          "platform",
          "version",
        ].includes(key) || key in installInfo
    ),
    "a field from nowhere is a typo the renderer would read as absent"
  );
}

/* ---- an input key nobody decided on does not reach the payload ----
 * The promise of the last round is that the decision about *which fields
 * travel* lives in `app-info.js` and not in the registration: `main.js` hands
 * over the whole probe answer (`...probe`) and this function decides what the
 * settings page gets. That promise has a mechanical form, and this is it: the
 * payload is assembled from named fields, so a key nobody decided on — the
 * probe's `timedOut`, or anything a future caller spreads in — cannot appear
 * in it.
 *
 * The key set above already pins what the payload *is*; what was missing is
 * the other direction: that the payload cannot *grow* by accident. The two
 * together are the guarantee. `main.js` spreading the whole answer is only
 * safe because of this block, and this block is only meaningful because
 * `main.js` spreads the whole answer.
 */
{
  const standard = formatAppInfo({
    ...base,
    binary: { path: "/opt/app/ocr", source: "local" },
    versionStdout: "1.13.3\n",
  });
  const polluted = formatAppInfo({
    ...base,
    binary: { path: "/opt/app/ocr", source: "local" },
    versionStdout: "1.13.3\n",
    // The three keys a careless change would introduce: the probe's own flag,
    // the field name someone would give it in the payload, and a key with no
    // meaning at all — the one that proves the rule is about *unknown* keys
    // and not about a list of known-bad names.
    timedOut: true,
    versionTimedOut: true,
    someKeyNobodyDecidedOn: "leaked",
  });
  const pollutedKeys = Object.keys(polluted).sort();
  check(
    "an input key nobody decided on does not reach the payload",
    !("timedOut" in polluted) &&
      !("versionTimedOut" in polluted) &&
      !("someKeyNobodyDecidedOn" in polluted),
    JSON.stringify(pollutedKeys)
  );
  check(
    "...and the payload's key set is the one the same answer has without those keys",
    JSON.stringify(pollutedKeys) === JSON.stringify(Object.keys(standard).sort()),
    JSON.stringify([pollutedKeys, Object.keys(standard).sort()])
  );
  check(
    "...and the fields that were decided on still carry their values",
    polluted.version === standard.version &&
      polluted.binary === standard.binary &&
      polluted.binarySource === standard.binarySource &&
      polluted.configPath === standard.configPath,
    JSON.stringify({ version: polluted.version, binary: polluted.binary })
  );
}

/* ---- the probe: bounded, and never a rejection ----
 * Everything above is about the *shape* of the answer; none of it covers the
 * wait before the answer exists. `app:info` is what the settings page renders
 * while it opens, so a `ocr version` that never returns is not a wrong field —
 * it is a blank page with nothing on screen to explain it. `readVersionOutput`
 * is the part that makes the wait finite, and it takes `exec` as an argument so
 * every way a service can fail to answer is producible here without breaking a
 * machine.
 */
{
  const answered = { stdout: "open-code-review 1.13.3\n", stderr: "" };
  const calls = [];
  const normal = await readVersionOutput({
    binary: { path: "/opt/app/ocr" },
    exec: (args, options) => {
      calls.push({ args, options });
      return Promise.resolve({ code: 0, ...answered });
    },
    timeoutMs: 2000,
  });
  check(
    "the probe asks the CLI for `version` exactly once",
    calls.length === 1 && JSON.stringify(calls[0].args) === '["version"]',
    JSON.stringify(calls.map((call) => call.args))
  );
  check(
    "...and hands the service the budget it was given, so the child is killed with it",
    calls[0] && calls[0].options && calls[0].options.timeoutMs === 2000,
    JSON.stringify(calls[0] && calls[0].options)
  );
  check(
    "...and passes the output on unchanged, with timedOut false",
    normal.versionStdout === answered.stdout && normal.versionStderr === "" && normal.timedOut === false,
    JSON.stringify(normal)
  );
  check(
    "...so the page still gets the version the CLI printed",
    formatAppInfo({ ...base, binary: { path: "/opt/app/ocr" }, ...normal }).version === "1.13.3",
    JSON.stringify(normal)
  );

  // No binary: the question must not be asked at all. `ocr.exec` answers "no
  // binary" as a failure, and a caller that asked anyway would turn a missing
  // CLI into a version read that "failed".
  let asked = 0;
  const noBinary = await readVersionOutput({
    binary: { path: null },
    exec: () => {
      asked += 1;
      return Promise.resolve({ code: 0, ...answered });
    },
  });
  check(
    "no binary: the CLI is not asked at all and the probe says nothing",
    asked === 0 && noBinary.versionStdout === "" && noBinary.versionStderr === "" && noBinary.timedOut === false,
    JSON.stringify({ asked, ...noBinary })
  );

  // A throw is "said nothing", not a rejection: a rejected `app:info` blinks the
  // settings page out, which is the failure this whole function exists to stop.
  const thrown = await readVersionOutput({
    binary: { path: "/opt/app/ocr" },
    exec: () => Promise.reject(new Error("spawn ENOTDIR")),
    timeoutMs: 2000,
  });
  check(
    "a probe that throws answers empty output instead of rejecting",
    thrown.versionStdout === "" && thrown.versionStderr === "" && thrown.timedOut === false,
    JSON.stringify(thrown)
  );

  /* ---- "the service threw" and "the CLI said nothing" are two answers ----
   * Empty output is the right *payload* for both — the page has one sentence for
   * "no version" — but the two are different facts about the service, and while
   * they were produced by a `.catch(() => …)` that returned the same literal as
   * the empty case, nobody could tell which one happened. The difference now
   * travels in `probeError`: a sentence on the answer when `exec` failed, `null`
   * when it answered (empty or not). Both halves are asserted, because "an
   * exception is recorded" means nothing without the case where there was no
   * exception.
   */
  check(
    "a probe that threw records what was thrown, so the exception is not lost as silence",
    thrown.probeError === "spawn ENOTDIR",
    JSON.stringify(thrown.probeError)
  );
  check(
    "...and a probe that answered is *not* an exception: probeError is null",
    normal.probeError === null && noBinary.probeError === null,
    JSON.stringify([normal.probeError, noBinary.probeError])
  );
  check(
    "...and the payload is the same either way: an exception still yields an empty version",
    (() => {
      const info = formatAppInfo({ ...base, binary: { path: "/opt/app/ocr" }, ...thrown });
      return info.version === "" && info.binary === "/opt/app/ocr";
    })(),
    JSON.stringify(formatAppInfo({ ...base, binary: { path: "/opt/app/ocr" }, ...thrown }))
  );
  check(
    "...and the diagnostic is named by formatAppInfo and dropped, not spread into the payload",
    (() => {
      const info = formatAppInfo({ ...base, binary: { path: "/opt/app/ocr" }, ...thrown });
      return !("probeError" in info) && !("versionError" in info);
    })(),
    JSON.stringify(Object.keys(formatAppInfo({ ...base, binary: { path: "/opt/app/ocr" }, ...thrown })).sort())
  );

  // The shape the budgets exist for: `exec` that never settles and ignores the
  // budget it was handed. Asserted on the clock, because "it returned" is the
  // whole promise — a probe that resolves the *right* object after a minute has
  // still left the page blank for a minute.
  const startedAt = Date.now();
  const hung = await readVersionOutput({
    binary: { path: "/opt/app/ocr" },
    exec: () => new Promise(() => {}),
    timeoutMs: 40,
    graceMs: 60,
  });
  const elapsed = Date.now() - startedAt;
  check(
    "a service that never answers is given up on at the deadline, not waited out",
    hung.versionStdout === "" && hung.versionStderr === "" && hung.timedOut === true,
    JSON.stringify(hung)
  );
  check(
    "...and running out of time is not an exception either: probeError stays null",
    hung.probeError === null,
    JSON.stringify(hung.probeError)
  );
  check(
    "...and that happens after the budget and the grace, and well before a user would call the page broken",
    elapsed >= 80 && elapsed < 1500,
    `${elapsed}ms for 40+60`
  );
  check(
    "...and the settings page gets a complete object anyway, with an empty version",
    (() => {
      const info = formatAppInfo({ ...base, binary: { path: "/opt/app/ocr", source: "local" }, ...hung });
      const verdict = info.version === "" && info.binary === "/opt/app/ocr" && info.binarySource === "local";
      return verdict && info.configPath === base.configPath && info.packaged === true;
    })(),
    JSON.stringify(formatAppInfo({ ...base, binary: { path: "/opt/app/ocr" }, ...hung }))
  );

  // The service's own flag is forwarded so a caller can tell "ran out of time"
  // from "ended with no output" — two answers that look identical in the text.
  const serviceTimedOut = await readVersionOutput({
    binary: { path: "/opt/app/ocr" },
    exec: () => Promise.resolve({ code: null, stdout: "", stderr: "", timedOut: true }),
    timeoutMs: 2000,
  });
  check(
    "the service's own timedOut flag survives the probe",
    serviceTimedOut.timedOut === true && serviceTimedOut.versionStdout === "",
    JSON.stringify(serviceTimedOut)
  );

  // Third state: an `exec` that ignores its budget and answers *late*. The
  // deadline wins, the late output is dropped, and `timedOut` is the answer even
  // though the service never set it itself — "we stopped waiting" is the fact,
  // and a version that arrives after the page asked is not a version this
  // handler can use.
  const late = await readVersionOutput({
    binary: { path: "/opt/app/ocr" },
    exec: () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ code: 0, stdout: "open-code-review 1.13.3\n", stderr: "" }), 140)
      ),
    timeoutMs: 40,
    graceMs: 40,
  });
  check(
    "a service that ignores its budget but answers late still says timedOut, and its late output is dropped",
    late.timedOut === true && late.versionStdout === "" && late.versionStderr === "",
    JSON.stringify(late)
  );

  /* ---- the wait itself: two untrusted numbers, one rule ----
   * The deadline above is asserted on the clock, which is the right way to ask
   * "we stopped waiting" but the wrong way to ask what `wait` is: proving "a
   * negative grace still waits the default" on the clock costs 5.5 seconds, and
   * four such checks would make this suite the slowest thing in `audit:static`.
   * The computation is therefore its own exported function, and every invalid
   * input is asked as a number. `readVersionOutput` is then asserted to be
   * wired to that one function, so a second copy cannot keep this block green
   * while the probe waits by another rule.
   */
  {
    const exact = versionWaitMs({ timeoutMs: 40, graceMs: 60 });
    check(
      "the wait is the budget plus the grace when both are usable",
      exact.budget === 40 && exact.wait === 100 && exact.wait - exact.budget === 60,
      JSON.stringify(exact)
    );
    // The answer is `{ budget, wait }` and nothing else. A `grace` field was
    // there for one round and only this suite ever read it — the shape the
    // payload work of rounds 71/72 exists to keep out of the codebase. "The
    // grace fell back to the default" is asked as `wait - budget` below: that is
    // the number which actually reaches `setTimeout`, so the assertion is about
    // the wait rather than about an intermediate nobody consumes. Pinned as a key
    // set, because a field re-added "for the test" is exactly how it comes back.
    check(
      "the answer is exactly the two numbers the probe waits with, and no third",
      JSON.stringify(Object.keys(exact).sort()) === JSON.stringify(["budget", "wait"]),
      JSON.stringify(Object.keys(exact).sort())
    );
    // Zero grace is a legitimate answer ("stop the moment the child's own budget
    // runs out"), so it must not be folded into the default with the invalid
    // ones. That is the whole reason the guard is `>= 0` and not `> 0`.
    const noGrace = versionWaitMs({ timeoutMs: 40, graceMs: 0 });
    check(
      "a zero grace is obeyed: the wait is exactly the budget",
      noGrace.wait === noGrace.budget && noGrace.wait === 40 && noGrace.wait - noGrace.budget === 0,
      JSON.stringify(noGrace)
    );

    // Every way a grace can fail to be a grace. `Infinity` is the interesting
    // one: `setTimeout(Infinity)` fires immediately in Node, so a value that
    // reads as "wait forever" would actually be the shortest wait in the file.
    const badGraces = [
      ["negative", -1],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["undefined", undefined],
    ];
    for (const [label, graceMs] of badGraces) {
      const answer = versionWaitMs({ timeoutMs: 40, graceMs });
      check(
        `an ${label} grace falls back to the default instead of shortening the wait (${label})`,
        answer.wait === 40 + VERSION_PROBE_GRACE_MS &&
          answer.wait - answer.budget === VERSION_PROBE_GRACE_MS,
        JSON.stringify(answer)
      );
    }
    // No grace argument at all is a different input from `graceMs: undefined`:
    // one relies on the default parameter, the other on the guard inside. Both
    // have to land on the same number.
    const omittedGrace = versionWaitMs({ timeoutMs: 40 });
    check(
      "an omitted grace is the same answer as an undefined one",
      omittedGrace.wait === 40 + VERSION_PROBE_GRACE_MS &&
        omittedGrace.wait === versionWaitMs({ timeoutMs: 40, graceMs: undefined }).wait,
      JSON.stringify(omittedGrace)
    );

    // The budget is handed to the child, so a bad one is worse than a bad wait:
    // `exec` would be asked to kill the process after `NaN` milliseconds. All
    // four shapes have to become the default, and the effect is visible at the
    // call, not just in the number.
    const badBudgets = [
      ["zero", 0],
      ["negative", -25],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
    ];
    for (const [label, timeoutMs] of badBudgets) {
      const answer = versionWaitMs({ timeoutMs, graceMs: 0 });
      check(
        `a ${label} budget falls back to the default and the wait follows it (${label})`,
        answer.budget === VERSION_PROBE_MS && answer.wait === VERSION_PROBE_MS,
        JSON.stringify(answer)
      );
    }
    // The one invariant both guards exist for, over every shape above plus a
    // valid pair and the no-argument call. Asserted as a sweep rather than once
    // because "the deadline never fires inside the child's budget" is the
    // promise, and any future branch has to keep it.
    const sweep = [
      { timeoutMs: 40, graceMs: 60 },
      { timeoutMs: 40, graceMs: 0 },
      { timeoutMs: 40, graceMs: -1 },
      { timeoutMs: 40, graceMs: Number.POSITIVE_INFINITY },
      { timeoutMs: Number.NaN, graceMs: Number.NaN },
      { timeoutMs: Number.POSITIVE_INFINITY, graceMs: -1 },
      {},
    ].map((input) => ({ input, answer: versionWaitMs(input) }));
    check(
      "no input can make the deadline fire before the budget the child was given",
      sweep.every(
        ({ answer }) =>
          Number.isFinite(answer.budget) &&
          answer.budget > 0 &&
          Number.isFinite(answer.wait) &&
          answer.wait >= answer.budget
      ),
      JSON.stringify(sweep)
    );

    // The wiring, not a copy: the probe has to compute its two numbers with the
    // function under test, and that is the only place `budget` may come from.
    const appInfoSrc = fs.readFileSync(path.join(ROOT, "app-info.js"), "utf8");
    check(
      "the probe takes both of its numbers from that one function",
      /const \{ budget, wait \} = versionWaitMs\(\{ timeoutMs, graceMs \}\);/.test(appInfoSrc),
      "app-info.js"
    );

    // A bad budget is normalized *before* `exec` sees it. The injected service
    // answers at once, so this check is about the argument, not the clock.
    const handed = [];
    await readVersionOutput({
      binary: { path: "/opt/app/ocr" },
      exec: (args, options) => {
        handed.push(options && options.timeoutMs);
        return Promise.resolve({ code: 0, stdout: "1.13.3\n", stderr: "" });
      },
      timeoutMs: 0,
      graceMs: 0,
    });
    check(
      "the service is handed the normalized budget, never the zero it was given",
      handed.length === 1 && handed[0] === VERSION_PROBE_MS,
      JSON.stringify(handed)
    );

    // One of the invalid grace values is also proven on the clock, because the
    // pure function and the call site could disagree while both look right: a
    // negative grace that reached `setTimeout` would stop waiting 20ms in,
    // before the child's own 30ms budget had even run out.
    const startedAtBadGrace = Date.now();
    const badGrace = await readVersionOutput({
      binary: { path: "/opt/app/ocr" },
      exec: () => new Promise(() => {}),
      timeoutMs: 30,
      graceMs: -10,
    });
    const elapsedBadGrace = Date.now() - startedAtBadGrace;
    check(
      "a negative grace really waits the default, so the deadline stays outside the budget",
      badGrace.timedOut === true && elapsedBadGrace >= 30 + VERSION_PROBE_GRACE_MS - 20,
      `${elapsedBadGrace}ms for 30+${VERSION_PROBE_GRACE_MS}`
    );

    // An `exec` that is not a function is a miswiring, not a slow CLI: there is
    // nobody to ask, so the probe says nothing and does not wait for a deadline
    // to report a timeout it could have known immediately.
    const noExec = await readVersionOutput({ binary: { path: "/opt/app/ocr" }, exec: null });
    check(
      "an exec that cannot be called answers empty output instead of timing out",
      noExec.versionStdout === "" && noExec.versionStderr === "" && noExec.timedOut === false,
      JSON.stringify(noExec)
    );

    // `describeProbeError`'s other shapes: whatever is rejected may be an Error,
    // a bare string, an object with no message, or an Error with an empty one.
    // All of them reach `probeError` as a sentence, because "the service threw"
    // is a fact that must not become `undefined` on the way.
    // The prototype chain is the boundary this round asked about: `"message" in
    // error` reads an *inherited* message too, and that is the decision (an
    // `Error` subclass may expose `message` through a getter on its prototype,
    // and `hasOwnProperty` would call that error message-less). So the expected
    // answer for an object whose only `message` is on its prototype is that
    // message, not the fixed sentence — and a plain `Error` above still answers
    // its own, which is what keeps this from being "anything goes".
    for (const [label, rejection, expected] of [
      ["a bare string", "boom", "boom"],
      ["an object with no message", {}, "exec rejected without a message"],
      ["an Error with an empty message", new Error(""), "exec rejected without a message"],
      [
        "an object whose `message` only exists on its prototype",
        Object.create({ message: "inherited" }),
        "inherited",
      ],
      // The middle edge of the same chain: `"message" in error` is true, but
      // reading the property throws. `describeProbeError` runs inside a `.catch`,
      // so an unguarded read would reject `app:info` and blank the settings page.
      // The fixed sentence is the answer — the same one as "no usable message" —
      // and the suite must not die with the getter's error instead of naming it.
      [
        "an object whose `message` getter throws",
        Object.defineProperty({}, "message", {
          get() {
            throw new Error("boom");
          },
        }),
        "exec rejected without a message",
      ],
    ]) {
      const answer = await readVersionOutput({
        binary: { path: "/opt/app/ocr" },
        exec: () => Promise.reject(rejection),
        timeoutMs: 2000,
      });
      check(
        `a rejection carrying ${label} still leaves a sentence in probeError`,
        answer.probeError === expected && answer.timedOut === false,
        JSON.stringify(answer.probeError)
      );
    }
  }

  /* ---- the outermost edge of the chain: a rejection with no prototype ----
   * `describeProbeError` runs inside a `.catch`, so a throw in there rejects
   * `app:info` and blanks the settings page — the exact failure this module
   * exists to prevent. `Object.create(null)` is the value that produced it: with
   * no `toString` anywhere in its chain, `String(it)` throws before any sentence
   * exists. The case is built from `Object.create(null)` rather than from a class
   * on purpose, because the edge is the absence of everything, not a custom
   * shape someone thought of.
   *
   * The try/catch belongs to this test, not to the module: if the probe ever
   * rejects again, the suite must name the case that did it instead of dying
   * with a stack trace in the middle of the file.
   */
  {
    let answer = null;
    try {
      answer = await readVersionOutput({
        binary: { path: "/opt/app/ocr" },
        exec: () => Promise.reject(Object.create(null)),
        timeoutMs: 2000,
      });
    } catch {
      answer = { rejected: true };
    }
    check(
      "a rejection with no prototype at all still answers a sentence instead of rejecting app:info",
      answer !== null &&
        !answer.rejected &&
        answer.probeError === "exec rejected without a message" &&
        answer.timedOut === false,
      JSON.stringify(answer)
    );
    check(
      "...and the payload built from it is the complete one the page needs",
      (() => {
        const info = formatAppInfo({ ...base, binary: { path: "/opt/app/ocr" }, ...answer });
        return info.version === "" && info.binary === "/opt/app/ocr" && !("probeError" in info);
      })(),
      JSON.stringify(formatAppInfo({ ...base, binary: { path: "/opt/app/ocr" }, ...answer }))
    );
  }

  /* ---- the deadline's own decision, asked the question the race cannot pose ----
   * The block above is the reachable shape: the deadline fired, so the race was
   * won by the deadline and there was never an answer to drop. The *other* half
   * of the guard — "an answer is there, and we had already stopped waiting" — is
   * not reachable from here: `Promise.race` settles with whichever promise
   * settles first, the deadline reaches the race in one microtask hop and the
   * probe's answer needs several, so the deadline always wins that race. Left
   * untested, that guard would be a line nobody could break and nobody could
   * trust either — and it is the line that decides "a version that arrives
   * after the page asked is not a version this handler can use".
   *
   * So the decision is asked directly, on the function that makes it. The
   * answers below are the four facts the caller may act on: the wait ended, the
   * late output is dropped, an answer that came in time travels unchanged, and
   * the service's own flag is carried through.
   */
  {
    const answeredLate = versionAnswer(
      { stdout: "open-code-review 1.13.3\n", stderr: "", timedOut: false },
      true
    );
    check(
      "an answer that arrives after the deadline is dropped, and the answer says the wait ended",
      answeredLate.versionStdout === "" &&
        answeredLate.versionStderr === "" &&
        answeredLate.timedOut === true,
      JSON.stringify(answeredLate)
    );
    const deadlineWon = versionAnswer(null, false);
    check(
      "...and a deadline that won the race is the same answer",
      deadlineWon.versionStdout === "" &&
        deadlineWon.versionStderr === "" &&
        deadlineWon.timedOut === true,
      JSON.stringify(deadlineWon)
    );
    const inTime = versionAnswer({ stdout: "1.13.3\n", stderr: "", timedOut: false }, false);
    check(
      "an answer that came in time travels as it is",
      inTime.versionStdout === "1.13.3\n" && inTime.versionStderr === "" && inTime.timedOut === false,
      JSON.stringify(inTime)
    );
    const serviceFlag = versionAnswer({ stdout: "", stderr: "", timedOut: true }, false);
    check(
      "...and the service's own flag is carried through when it came in time",
      serviceFlag.timedOut === true && serviceFlag.versionStdout === "",
      JSON.stringify(serviceFlag)
    );
    // The other diagnostic the decision may carry: a rejection's message. It
    // travels on the answer, and the payload built from that answer does not
    // contain it — the same shape as `timedOut`, asserted on an input that
    // really carries the key rather than on an absence of nothing.
    const threw = versionAnswer(
      { stdout: "", stderr: "", timedOut: false, probeError: "spawn ENOTDIR" },
      false
    );
    check(
      "a rejection's message travels on the answer, so it is not re-invented as silence",
      threw.versionStdout === "" && threw.probeError === "spawn ENOTDIR",
      JSON.stringify(threw)
    );
    const threwInfo = formatAppInfo({ ...base, binary: { path: "/opt/app/ocr" }, ...threw });
    check(
      "...and it stops at formatAppInfo: the payload has neither probeError nor an empty version field",
      !("probeError" in threwInfo) && threwInfo.version === "" && threwInfo.binary === "/opt/app/ocr",
      JSON.stringify(Object.keys(threwInfo).sort())
    );
    // The decision has to be the one the probe actually makes. A copy of it
    // somewhere else would keep the function green while the probe ran a
    // different rule — so the wiring is asserted, not assumed.
    const appInfoSrc = fs.readFileSync(path.join(ROOT, "app-info.js"), "utf8");
    check(
      "the probe ends in that decision, so the function under test is the one that runs",
      /return versionAnswer\(answer, late\);/.test(appInfoSrc),
      "app-info.js"
    );
  }

  // ...and the flag stops at `formatAppInfo`. The decision is (b): the payload
  // does *not* carry it. The settings page has one sentence for "the version"
  // and a separate `binary`/`binarySource` pair for "was the CLI found at all",
  // so "found but silent" already has an honest answer there; a
  // `versionTimedOut` field would be a payload key no renderer reads, i.e. a
  // promise that can only ever be asserted to exist. Asserted as an absence on
  // an input that *does* carry `timedOut: true`, plus the same key set as a
  // probe that answered, because an absence is only meaningful against a
  // concrete set.
  const answeredInfo = formatAppInfo({ ...base, binary: { path: "/opt/app/ocr", source: "local" }, ...normal });
  const timedOutInfo = formatAppInfo({ ...base, binary: { path: "/opt/app/ocr", source: "local" }, ...hung });
  const thrownInfo = formatAppInfo({ ...base, binary: { path: "/opt/app/ocr", source: "local" }, ...thrown });
  check(
    "formatAppInfo drops the probe's timedOut flag instead of shipping it",
    !("timedOut" in timedOutInfo) && !("versionTimedOut" in timedOutInfo),
    JSON.stringify(Object.keys(timedOutInfo).sort())
  );
  check(
    "...and a timed-out answer has exactly the key set of one that answered",
    JSON.stringify(Object.keys(timedOutInfo).sort()) === JSON.stringify(Object.keys(answeredInfo).sort()),
    JSON.stringify([Object.keys(timedOutInfo).sort(), Object.keys(answeredInfo).sort()])
  );
  check(
    "...and so does an answer whose `exec` threw — the diagnostics are not payload keys",
    JSON.stringify(Object.keys(thrownInfo).sort()) === JSON.stringify(Object.keys(answeredInfo).sort()) &&
      !("probeError" in thrownInfo),
    JSON.stringify([Object.keys(thrownInfo).sort(), Object.keys(answeredInfo).sort()])
  );
  /* ---- the wiring: the probe's whole answer is the handler's input ----
   * Everything above calls `formatAppInfo` with the probe already spread by the
   * test. The question this block asks is the one the last round's checklist
   * named as missing: does the *handler* spread it, or does the handler pick
   * `versionStdout`/`versionStderr` off it and hand over a smaller object? The
   * payload cannot tell — `formatAppInfo` drops the diagnostics either way — so
   * the probe's diagnostic fields are getters here: whether they are read at all
   * is observable only if the whole object crossed the seam.
   *
   * `assembleAppInfo` is that seam, and `handleAppInfo` is the body the
   * registration now calls. Both are exercised; a source-level check would have
   * accepted either spelling.
   */
  {
    const getterProbe = (seen) => ({
      get versionStdout() {
        seen.push("versionStdout");
        return "open-code-review 1.13.3\n";
      },
      get versionStderr() {
        seen.push("versionStderr");
        return "";
      },
      get timedOut() {
        seen.push("timedOut");
        return true;
      },
      get probeError() {
        seen.push("probeError");
        return "spawn ENOTDIR";
      },
    });

    const read = [];
    const wired = assembleAppInfo({
      ...base,
      binary: { path: "/opt/app/ocr", source: "local" },
      probe: getterProbe(read),
    });
    check(
      "the handler's assembly spreads the probe's whole answer, diagnostics included",
      read.includes("timedOut") && read.includes("probeError"),
      JSON.stringify(read)
    );
    check(
      "...and those diagnostics still stop at formatAppInfo: the payload keeps the key set of a plain answer",
      wired.version === "1.13.3" &&
        !("timedOut" in wired) &&
        !("probeError" in wired) &&
        JSON.stringify(Object.keys(wired).sort()) ===
          JSON.stringify(
            Object.keys(
              formatAppInfo({
                ...base,
                binary: { path: "/opt/app/ocr", source: "local" },
                versionStdout: "open-code-review 1.13.3\n",
              })
            ).sort()
          ),
      JSON.stringify(Object.keys(wired).sort())
    );

    // The counterexample that gives the check its teeth: the natural bad edit —
    // pick the two output fields — never reads the two diagnostics, so the same
    // getters stay silent. If this control ever saw them, "they were read" would
    // no longer distinguish a spread from a pick.
    const picked = [];
    const picker = getterProbe(picked);
    formatAppInfo({
      ...base,
      binary: { path: "/opt/app/ocr" },
      versionStdout: picker.versionStdout,
      versionStderr: picker.versionStderr,
    });
    check(
      "...and the check has teeth: a registration that picks versionStdout/versionStderr leaves timedOut/probeError unread",
      !picked.includes("timedOut") && !picked.includes("probeError"),
      JSON.stringify(picked)
    );

    // `handleAppInfo` is the body the registration calls, so it is asked end to
    // end: the service adapter (four-argument exec), the ask-time facts, and the
    // property this module exists for — a rejection becomes an answer instead of
    // rejecting `app:info`.
    const calls = [];
    let installReads = 0;
    const info = await handleAppInfo({
      exec: (args, cwd, env, options) => {
        calls.push({ args, cwd, env, options });
        return Promise.reject(Object.create(null));
      },
      binaryResolution: () => ({ path: "/opt/app/ocr", source: "local" }),
      configPath: base.configPath,
      docsUrl: base.docsUrl,
      appVersion: base.appVersion,
      platform: base.platform,
      installInfo: () => {
        installReads += 1;
        return base.installInfo;
      },
    });
    check(
      "handleAppInfo calls the service once with `version`, in the service's own signature, with the probe's budget in the fourth slot",
      calls.length === 1 &&
        JSON.stringify(calls[0].args) === '["version"]' &&
        calls[0].cwd === undefined &&
        calls[0].env === undefined &&
        calls[0].options &&
        calls[0].options.timeoutMs === VERSION_PROBE_MS,
      JSON.stringify(calls)
    );
    check(
      "a rejection with no prototype reaches the handler but not the caller: app:info still answers a complete payload",
      info &&
        info.version === "" &&
        info.binary === "/opt/app/ocr" &&
        info.binarySource === "local" &&
        !("probeError" in info) &&
        info.configPath === base.configPath &&
        installReads === 1,
      JSON.stringify({ info, installReads })
    );

    // The two blocks above meet only if `handleAppInfo` actually goes through
    // `assembleAppInfo`; a handler that re-spread the probe itself would keep
    // every check above green while the asserted line stopped running.
    const appInfoSrc = fs.readFileSync(path.join(ROOT, "app-info.js"), "utf8");
    check(
      "the handler assembles through the one function whose spread is asserted",
      /return assembleAppInfo\(\{/.test(appInfoSrc) && /\n\s*\.\.\.probe,/.test(appInfoSrc),
      "app-info.js"
    );
  }

  // The drop is a decision in `app-info.js` only while the registration does not
  // choose fields off the probe. Reading the registration is the only way to see
  // that (it is Electron-only code), and the assertion is deliberately about the
  // *name*: a `timedOut` in the handler is a second decision point coming back.
  //
  // It finds the handler by its IPC channel across the root modules, not by
  // reading `main.js` by name. The check is about what the registration does, and
  // those registrations have moved before; a file-name assertion turns "moved to
  // `xxx-handler.js`" into "main.js not found", which says nothing about the
  // decision this check exists for. Two registrations of the same channel are
  // their own failure: then the assertion would only be reading one of them.
  //
  // Comments are stripped before the body is read: the registration explains this
  // decision in prose, and a check that also forbade the *word* would make the
  // comment the thing to delete.
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const registered = fs
    .readdirSync(ROOT)
    .filter((file) => file.endsWith(".js"))
    .map((file) => ({
      file,
      source: stripComments(fs.readFileSync(path.join(ROOT, file), "utf8")),
    }))
    .filter(({ source }) => /ipcMain\.handle\(\s*["']app:info["']/.test(source));
  check(
    "exactly one root module registers app:info",
    registered.length === 1,
    registered.map(({ file }) => file).join(", ") || "none"
  );
  // The body runs from the registration to the next registration in that module.
  // It does not parse JavaScript; it delimits the one block this check is about,
  // which is all a source-level assertion can honestly do.
  const handlerBody = (source) => {
    const start = source.search(/ipcMain\.handle\(\s*["']app:info["']/);
    if (start < 0) return "";
    const rest = source.slice(start + 1);
    const next = rest.search(/ipcMain\.(?:handle|on|removeHandler)\(/);
    return next < 0 ? rest : rest.slice(0, next);
  };
  const body = registered.length === 1 ? handlerBody(registered[0].source) : "";
  // The body now lives in `app-info.js` and is called above; what is left to get
  // wrong here is a missing fact or a decision sneaking back in. Both are names:
  // every fact the page shows must be handed over, and no probe field (or
  // formatter) may be named, because either name means the registration has
  // started deciding instead of wiring.
  check(
    "app:info is wiring only: it calls handleAppInfo with the service exec and every fact the page shows, and names no probe field",
    /handleAppInfo\(/.test(body) &&
      /exec\s*:/.test(body) &&
      /binaryResolution/.test(body) &&
      /configPath/.test(body) &&
      /docsUrl/.test(body) &&
      /appVersion/.test(body) &&
      /platform/.test(body) &&
      /installInfo/.test(body) &&
      !/versionStdout|versionStderr|timedOut|probeError|formatAppInfo/.test(body),
    registered.length === 1 ? registered[0].file : "no single registration"
  );

  // The defaults have to be usable, and the grace has to be *after* the budget:
  // the child must be allowed to die on its own (its close event is what the
  // service reports) before this side stops waiting. Reversed, every slow CLI
  // would be reported as `timedOut` while actually finishing.
  check(
    "the default budget is a positive number of milliseconds and the grace comes after it",
    Number.isFinite(VERSION_PROBE_MS) && VERSION_PROBE_MS > 0 && VERSION_PROBE_GRACE_MS > 0,
    JSON.stringify({ VERSION_PROBE_MS, VERSION_PROBE_GRACE_MS })
  );
}

console.log(`\n${failures.length ? `${failures.length} failed` : "all app-info checks passed"}`);
if (failures.length) {
  console.error(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
