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

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(ROOT, "package.json"));
const { formatAppInfo } = require(path.join(ROOT, "app-info.js"));

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

console.log(`\n${failures.length ? `${failures.length} failed` : "all app-info checks passed"}`);
if (failures.length) {
  console.error(`failed: ${failures.join(", ")}`);
  process.exit(1);
}
