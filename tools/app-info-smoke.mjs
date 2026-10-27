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
const { formatAppInfo, readVersionOutput, versionAnswer, VERSION_PROBE_MS, VERSION_PROBE_GRACE_MS } = require(
  path.join(ROOT, "app-info.js")
);
import { INSTALL_INFO_KEYS, stubInstall } from "./install-fixture.mjs";

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
  // The drop is a decision in `app-info.js` only while `main.js` does not choose
  // fields off the probe. Reading the registration is the only way to see that
  // (it is Electron-only code), and the assertion is deliberately about the
  // *name*: a `timedOut` in `main.js` is a second decision point coming back.
  // Comments are stripped first: the registration explains this decision in
  // prose, and a check that also forbade the *word* would make the comment the
  // thing to delete.
  const mainSrc = fs
    .readFileSync(path.join(ROOT, "main.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  check(
    "app:info hands the whole probe answer to formatAppInfo, and never names timedOut itself",
    /\.\.\.probe/.test(mainSrc) && !/timedOut/.test(mainSrc),
    "main.js"
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
