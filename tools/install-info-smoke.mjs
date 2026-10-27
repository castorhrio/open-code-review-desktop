// Exercises install-info.js with a stubbed app object, a stubbed shell and real
// temporary directories.
//
// Which of the four shapes the running copy is in decides both what the settings
// page offers and which sentence the user gets when the button cannot work: an
// installed build has a directory and maybe an uninstaller, a portable build has
// neither (it extracts to a temp dir), a `npm run dev` copy has no install at
// all, and an install whose uninstaller is missing must not be told to delete
// an exe that its own uninstaller would have removed. Those were the bodies of
// `main.js` until this round, where the only way to check them was to read the
// source text. Run with `npm run audit:install`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const ROOT = path.resolve(import.meta.dirname, "..");
const require = createRequire(path.join(ROOT, "package.json"));
const { createInstall } = require(path.join(ROOT, "install-info.js"));
// The stubs and the six install facts live in `tools/install-fixture.mjs`, shared
// with `tools/app-info-smoke.mjs`: that file pins the `app:info` payload's key
// set, which is this module's `installInfo()` spread into the IPC answer. Two
// hand-maintained copies of these stubs used to back those two assertions, so a
// drift in either made one suite red for a key the other had just invented.
import {
  APP_INFO_COMPUTED_KEYS,
  INSTALL_INFO_KEYS,
  installStubs,
  makeApp,
  makeShell,
} from "./install-fixture.mjs";

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

/** The sentence a refusal carries, or "" when the plan was allowed — the
 *  checks below read it as text, and an allowed plan has none. */
const refusal = (plan) => (plan && plan.ok === false ? plan.error || "" : "");

/** The ANSWER a call gives, with a rejection turned into a value. Three checks
 *  below are about a shell that throws: without this, a module that lacks the
 *  guard would take the process down at the first of them and the ~40 checks
 *  after it would never run — one red, then silent. A rejection is reported as
 *  `{ threw }`, which is not the shape any of them accept, so it fails. */
const settle = async (promise) => {
  try {
    return await promise;
  } catch (err) {
    return { threw: (err && (err.message || String(err))) || "threw" };
  }
};

/** The one sentence a rejection with nothing readable in it must turn into. */
const NO_REASON = "打开失败：系统没有给出原因";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ocr-install-info-")));
// An install root the way NSIS leaves it: the app's own files plus the
// uninstaller it names after the product.
const installed = path.join(tmp, "installed");
fs.mkdirSync(path.join(installed, "resources"), { recursive: true });
fs.writeFileSync(path.join(installed, "Uninstall Open Code Review.exe"), "");
fs.writeFileSync(path.join(installed, "Open Code Review.exe"), "");
// Same layout, minus the uninstaller: what a hand-copied or half-removed
// install looks like.
const bare = path.join(tmp, "bare");
fs.mkdirSync(bare, { recursive: true });
fs.writeFileSync(path.join(bare, "Open Code Review.exe"), "");

// The two paths this suite's `app` stub answers with: a profile under the temp
// root, and the exe inside the install root below. They are bound here rather
// than defaulted inside the shared `makeApp`, because they depend on the temp
// tree this file creates — the fixture's defaults are the disk-free ones.
const PROFILE = path.join(tmp, "profile");
const APP_EXE = path.join(installed, "Open Code Review.exe");

/** `install-info.js` built from the shared stubs, with this suite's answers for
 *  the questions that are the behaviour under test: real temp directories
 *  (`exists` / `readdir`) and the platform's own `dirname`. */
const make = ({
  packaged,
  resources = "",
  platform = "win32",
  env = {},
  shell = makeShell(),
  exists = fs.existsSync,
  readdir = fs.readdirSync,
  dirname = path.dirname,
}) =>
  createInstall(
    installStubs({
      app: makeApp({ packaged, resources, userData: PROFILE, exe: APP_EXE }),
      shell,
      platform,
      env,
      resourcesPath: () => resources,
      exists,
      readdir,
      dirname,
    })
  );

/* ---------------- shape 1: installed ---------------- */

{
  const tools = make({ packaged: true, resources: path.join(installed, "resources") });
  const info = tools.installInfo();
  check("an installed build reports its install root", info.installDir === installed, info.installDir);
  check("it is packaged and not portable", info.packaged === true && info.portable === false);
  check("the uninstaller in that root is found", tools.uninstallerPath(installed) === path.join(installed, "Uninstall Open Code Review.exe"));
  check("so 「卸载」 can be offered", info.canUninstall === true);
  check("the profile and the exe come from the app", info.userData === path.join(tmp, "profile") && info.executable.endsWith("Open Code Review.exe"));

  const plan = tools.uninstallPlan();
  check("the uninstall plan names the uninstaller", plan.ok === true && plan.target === path.join(installed, "Uninstall Open Code Review.exe"));
  check("and 「打开安装目录」 is allowed", tools.installDirPlan().ok === true && tools.installDirPlan().dir === installed);
}

/* ---------------- shape 2: portable ---------------- */

{
  const tools = make({
    packaged: true,
    resources: path.join(installed, "resources"),
    env: { PORTABLE_EXECUTABLE_DIR: tmp },
  });
  const info = tools.installInfo();
  check("a portable build is not called an install", info.portable === true && info.installDir === "", JSON.stringify(info.installDir));
  check("even though it was extracted from an install-shaped directory", info.canUninstall === false);
  check("and looking for an uninstaller there is pointless", tools.uninstallerPath(info.installDir) === "");

  const plan = tools.uninstallPlan();
  const said = refusal(plan);
  check("portable 「卸载」 says there is no uninstaller", plan.ok === false && said.includes("免安装版没有卸载器"), said);
  check("it tells the user to delete the exe", said.includes("删除该 exe"));
  check("it does not send them to 「设置 → 应用」", !said.includes("设置 → 应用"), said);

  const dirPlan = tools.installDirPlan();
  check(
    "portable 「打开安装目录」 says why there is none",
    dirPlan.ok === false && refusal(dirPlan).includes("免安装版运行时解压在临时目录"),
    refusal(dirPlan)
  );
}

/* ---------------- shape 3: not packaged (npm run dev) ---------------- */

{
  const tools = make({ packaged: false, resources: path.join(installed, "resources") });
  const info = tools.installInfo();
  check("a dev copy reports no install dir", info.packaged === false && info.installDir === "");
  check("and no uninstaller", info.canUninstall === false);
  const plan = tools.uninstallPlan();
  check(
    "「卸载」 in a dev copy is not told the portable story",
    plan.ok === false && refusal(plan).includes("设置 → 应用") && !refusal(plan).includes("免安装版"),
    refusal(plan)
  );
  const devDirPlan = tools.installDirPlan();
  check(
    "「打开安装目录」 is refused, and the portable story is what this shape gets",
    devDirPlan.ok === false && refusal(devDirPlan).includes("免安装版运行时解压在临时目录"),
    refusal(devDirPlan)
  );
}

/* ---------------- shape 4: installed, uninstaller missing ---------------- */

{
  const tools = make({ packaged: true, resources: path.join(bare, "resources") });
  const info = tools.installInfo();
  check("the install root is still reported", info.installDir === bare);
  check("but with no uninstaller found, 「卸载」 is not offered", info.canUninstall === false);
  check("an install with no uninstaller is not called portable", info.portable === false);
  const plan = tools.uninstallPlan();
  check(
    "and its refusal points at the OS uninstall list",
    plan.ok === false && refusal(plan).includes("设置 → 应用") && !refusal(plan).includes("免安装版"),
    refusal(plan)
  );
  check("the directory itself still opens", tools.installDirPlan().ok === true && tools.installDirPlan().dir === bare);
}

/* ---------------- the directory went away under us ---------------- */

{
  const gone = path.join(tmp, "uninstalled");
  const tools = make({ packaged: true, resources: path.join(gone, "resources") });
  const info = tools.installInfo();
  check("a deleted install dir is reported without throwing", info.installDir === gone && info.canUninstall === false);
  check("its uninstaller is not invented", tools.uninstallerPath(gone) === "");
  const dirPlan = tools.installDirPlan();
  check(
    "「打开安装目录」 refuses a directory that is not there",
    dirPlan.ok === false && refusal(dirPlan).includes("安装目录已经不存在"),
    refusal(dirPlan)
  );
  // The sentence for this shape must not borrow the portable story: `installDir`
  // is non-empty here (the info still names the root it was installed into), so
  // "免安装版运行时解压在临时目录" would describe a packaging mode this copy is
  // not in, and send the user looking for the wrong cause.
  check(
    "and it does not tell an installed copy the portable story",
    !refusal(dirPlan).includes("免安装版"),
    refusal(dirPlan)
  );
  check(
    "while it still names the directory that went missing",
    refusal(dirPlan).includes(gone) && dirPlan.path === gone,
    refusal(dirPlan)
  );
}

/* ---------------- the install root will not be listed ---------------- */

{
  // An install root the process may not read (a locked profile volume, a policy
  // that denies directory listing). The scan is a best-effort lookup, so it must
  // answer "no uninstaller" — not throw out of 「卸载」 and out of `app:info`.
  const tools = make({
    packaged: true,
    resources: path.join(installed, "resources"),
    readdir: () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    },
  });
  check("a root that cannot be listed reports no uninstaller", tools.uninstallerPath(installed) === "");
  check("so 「卸载」 is not offered there", tools.installInfo().canUninstall === false);
  const said = refusal(tools.uninstallPlan());
  check("and its refusal is the ordinary one, not a crash", said.includes("没有找到卸载程序"), said);
}

/* ---------------- a platform with no NSIS uninstaller ---------------- */

for (const platform of ["darwin", "linux"]) {
  const tools = make({ packaged: true, resources: path.join(installed, "resources"), platform });
  const info = tools.installInfo();
  check(`on ${platform} an uninstaller in the root is not offered`, info.canUninstall === false);
  check(`on ${platform} it is not found either`, tools.uninstallerPath(installed) === "");
  check(`on ${platform} the user is pointed at the OS`, refusal(tools.uninstallPlan()).includes("设置 → 应用"));
}

/* ---------------- reveal: one existing file, one missing, one nothing ---------------- */

{
  const shell = makeShell();
  const tools = make({ packaged: true, resources: path.join(installed, "resources"), shell });
  const target = path.join(installed, "Open Code Review.exe");
  const res = await tools.revealPath(target);
  check("an existing file is revealed in its folder", res.ok === true && res.action === "reveal" && res.path === target);
  check("showItemInFolder got the exact path", shell.calls.reveal.length === 1 && shell.calls.reveal[0] === target);
  check("and nothing was opened", shell.calls.open.length === 0);
}

{
  const shell = makeShell();
  const tools = make({ packaged: true, resources: path.join(installed, "resources"), shell });
  // The config file does not exist until the first save — the exact moment a
  // newcomer clicks 「打开配置文件所在目录」.
  const target = path.join(installed, "resources", "not-yet", "config.json");
  const ancestor = path.join(installed, "resources");
  const res = await tools.revealPath(target);
  check("a missing path falls back to the nearest existing ancestor", res.ok === true && res.action === "open-parent" && res.path === ancestor, JSON.stringify(res));
  check("the missing target is still reported", res.missing === target);
  check("the ancestor is what gets opened", shell.calls.open.length === 1 && shell.calls.open[0] === ancestor);
  check("no empty folder was revealed", shell.calls.reveal.length === 0);
}

{
  // Electron's shell.openPath resolves to an error string when it cannot open
  // anything — it does not reject. Reading it is the whole point of the fallback
  // branch: without it the user is told the folder opened, and nothing did.
  const shell = makeShell("Failed to open path: no handler for directory");
  const tools = make({ packaged: true, resources: path.join(installed, "resources"), shell });
  const target = path.join(installed, "resources", "not-yet", "config.json");
  const ancestor = path.join(installed, "resources");
  const res = await tools.revealPath(target);
  check(
    "a folder that could not be opened is reported, not swallowed",
    res.ok === false && res.error === "Failed to open path: no handler for directory",
    JSON.stringify(res)
  );
  check("the report still says what was missing and what was tried", res.action === "open-parent" && res.path === ancestor && res.missing === target);
  check("the ancestor was still what got opened", shell.calls.open.length === 1 && shell.calls.open[0] === ancestor);
}

{
  // The shell rejecting instead of resolving to a sentence. Not the contract, but
  // an unhandled one would take the whole answer with it: the IPC handler
  // rejects, the renderer's `await` throws, and the toast that should have named
  // the folder never runs — the same "looks like it worked" shape, one step
  // worse. A throw must therefore land in the same `{ ok: false }` shape.
  const shell = makeShell("", new Error("shell.openPath is not a function"));
  const tools = make({ packaged: true, resources: path.join(installed, "resources"), shell });
  const target = path.join(installed, "resources", "not-yet", "config.json");
  const ancestor = path.join(installed, "resources");
  const res = await settle(tools.revealPath(target));
  check(
    "a shell that throws is reported instead of rejecting the caller",
    res.ok === false && res.error === "shell.openPath is not a function",
    JSON.stringify(res)
  );
  check("and it still says what was missing and what was tried", res.action === "open-parent" && res.path === ancestor && res.missing === target);
  check("the ancestor really was the thing attempted", shell.calls.open.length === 1 && shell.calls.open[0] === ancestor);
}

{
  // showItemInFolder returns nothing at all, so a shell whose openPath would
  // fail must not turn the exact-path reveal into a refusal.
  const shell = makeShell("never used here");
  const tools = make({ packaged: true, resources: path.join(installed, "resources"), shell });
  const target = path.join(installed, "Open Code Review.exe");
  const res = await tools.revealPath(target);
  check("an exact path is still revealed when openPath would fail", res.ok === true && res.action === "reveal", JSON.stringify(res));
  check("and openPath is not asked for it", shell.calls.open.length === 0);
}

{
  // The same shape on the host's own rules: nothing along the whole path
  // exists, so the walk has to climb to the root and stop there. The counter
  // throws if it does not — a walk that failed to stop would otherwise hang
  // this audit instead of failing it, and every check after this one would
  // never run. That is the same reason the walk itself has to terminate: a
  // settings page waiting on a filesystem question that never ends is a page
  // that never answers.
  let asked = 0;
  const shell = makeShell();
  const tools = make({
    packaged: true,
    resources: path.join(installed, "resources"),
    shell,
    exists: () => {
      if (++asked > 32) throw new Error("the ancestor walk did not stop at the root");
      return false;
    },
  });
  const target = path.join(tmp, "nowhere", "deeper", "config.json");
  const res = await settle(tools.revealPath(target));
  check("nothing existing at all is an error, not a crash", res.ok === false && res.error === `路径不存在：${target}`, JSON.stringify(res));
  check("and the walk stopped at the root instead of circling", asked <= 12, `${asked} filesystem question(s)`);
  check("and the shell is left alone", shell.calls.open.length === 0 && shell.calls.reveal.length === 0);
}

{
  const shell = makeShell();
  const tools = make({ packaged: true, resources: path.join(installed, "resources"), shell });
  const res = await tools.revealPath("");
  check("an empty path is refused before the filesystem is asked", res.ok === false && res.error === "没有可显示的路径");
  check("the shell is left alone for an empty path", shell.calls.open.length === 0 && shell.calls.reveal.length === 0);
}

/* ---------------- reveal: separator rules, not just the local disk ---------------- */

// The ancestor walk stops when the parent equals the path itself, and *which*
// paths those are is the platform's separator rules: on win32 both `C:\` and a
// UNC share root (`\\server\share`) are their own parents, while posix has only
// `/`. The module therefore takes `dirname` as a seam, and the checks below
// inject `path.win32.dirname` / `path.posix.dirname` so *both* halves are
// exercised on whatever runner the audit happens to use — otherwise "it stops
// instead of walking forever" is a sentence in a comment that no fixture can
// turn red.
//
// The posix half comes first, because it is the one an ordinary posix runner
// sees: `/` is the only path that is its own parent there, so a missing path
// under it has to stop *at* the root and open the root, and a root that is not
// there has to end the walk with a refusal rather than a hang.
{
  // The target as it is: the path exists, so it is revealed in its folder and
  // the walk never runs at all. This is the pair's first half — the same target
  // below is missing, and then it is opened instead. The two answers have to
  // be told apart, because "reveal the file" and "open the folder that holds
  // it" are different acts with different paths.
  const posix = path.posix;
  const shell = makeShell();
  const tools = make({
    packaged: true,
    resources: path.join(installed, "resources"),
    shell,
    platform: "linux",
    dirname: posix.dirname,
    exists: (p) => p === "/a/b",
  });
  const res = await tools.revealPath("/a/b");
  check(
    "an existing posix path is revealed in its folder",
    res.ok === true && res.action === "reveal" && res.path === "/a/b",
    JSON.stringify(res)
  );
  check("showItemInFolder got the exact path", shell.calls.reveal.length === 1 && shell.calls.reveal[0] === "/a/b", JSON.stringify(shell.calls.reveal));
  check("and nothing was opened", shell.calls.open.length === 0, JSON.stringify(shell.calls.open));
}

{
  // The same target when it is missing: the walk climbs until the parent is
  // the path itself, and on posix that level is `/` — the root is what gets
  // opened, not the directory that was asked about. Climbing past it is not an
  // option (there is nothing above `/`), and stopping below it would open a
  // directory that does not exist.
  const posix = path.posix;
  const target = "/a/b/config.json";
  const shell = makeShell();
  const tools = make({
    packaged: true,
    resources: path.join(installed, "resources"),
    shell,
    platform: "linux",
    dirname: posix.dirname,
    exists: (p) => p === "/",
  });
  const res = await tools.revealPath(target);
  check(
    "a missing posix path falls back to the root, the only self-parent on posix",
    res.ok === true && res.action === "open-parent" && res.path === "/" && res.missing === target,
    JSON.stringify(res)
  );
  check("the root is what gets opened", shell.calls.open.length === 1 && shell.calls.open[0] === "/", JSON.stringify(shell.calls.open));
  check("and the missing file is not revealed in a folder", shell.calls.reveal.length === 0, JSON.stringify(shell.calls.reveal));
}

{
  // The other half of the same fact: when even the root is not there, the walk
  // must stop *at* it instead of asking the filesystem forever. `dirname("/")`
  // is `"/"`, so the parent equals the path — that is the branch that ends the
  // walk with an empty `existing`, and the refusal it produces is the ordinary
  // 「路径不存在」 rather than a hang. The counter throws if the walk does not
  // stop, so a walk that failed to terminate takes the run down here instead
  // of hanging the settings page for the user.
  const posix = path.posix;
  let asked = 0;
  const shell = makeShell();
  const tools = make({
    packaged: true,
    resources: path.join(installed, "resources"),
    shell,
    platform: "linux",
    dirname: posix.dirname,
    exists: () => {
      if (++asked > 32) throw new Error("the ancestor walk did not stop at the posix root");
      return false;
    },
  });
  const res = await settle(tools.revealPath("/"));
  check("a posix root that is not there is 「路径不存在」", res.ok === false && res.error === "路径不存在：/", JSON.stringify(res));
  check("and the walk stopped at the posix root instead of circling", asked <= 4, `${asked} filesystem question(s)`);
  check("the shell is left alone when the root is not there either", shell.calls.open.length === 0 && shell.calls.reveal.length === 0);
}

{
  // A reviewed file on a network share that *is* mounted: the walk has to stop
  // on the share root and open that, not keep climbing past the share into
  // `\\server` (which is not a directory anything can open).
  const win = path.win32;
  const share = "\\\\fileserver\\reviews";
  const target = win.join(share, "nightly", "ocr.yaml");
  // `path.win32.dirname` answers a share root as `\\\\server\\share\\` — with the
  // trailing separator, because that spelling is its own parent. That is the
  // level the walk stops on, and both spellings name the same thing to
  // `shell.openPath`, so the stub accepts either and the check pins the walked
  // one.
  const shareRoot = win.dirname(win.join(share, "nightly"));
  const shell = makeShell();
  const tools = make({
    packaged: true,
    resources: path.join(installed, "resources"),
    shell,
    platform: "win32",
    dirname: win.dirname,
    exists: (p) => p === share || p === shareRoot,
  });
  const res = await tools.revealPath(target);
  check(
    "a UNC target falls back to the existing share root",
    res.ok === true && res.action === "open-parent" && res.path === shareRoot && res.missing === target,
    JSON.stringify(res)
  );
  check("the share root is what gets opened, not the server", shell.calls.open.length === 1 && shell.calls.open[0] === shareRoot, JSON.stringify(shell.calls.open));
  check("and the missing file is not revealed in a folder", shell.calls.reveal.length === 0);
  check("the server above the share is never opened", !shell.calls.open.some((p) => p === "\\\\fileserver" || p === "\\\\fileserver\\"), JSON.stringify(shell.calls.open));
}

{
  // Nothing on the share exists — a workbook opened from a laptop that is off
  // the network. The walk must end at the share root (its own parent) and say so,
  // rather than climbing `\\server` → `\` → itself with a filesystem call each
  // time. The stub counts and throws, so a walk that fails to stop takes the
  // run down here instead of hanging the settings page for the user.
  const win = path.win32;
  const share = "\\\\fileserver\\reviews";
  const deep = win.join(share, ...["a", "b", "c", "d", "e", "f", "g", "h"].map((d) => d), "ocr.yaml");
  let asked = 0;
  const shell = makeShell();
  const tools = make({
    packaged: true,
    resources: path.join(installed, "resources"),
    shell,
    platform: "win32",
    dirname: win.dirname,
    exists: () => {
      if (++asked > 32) throw new Error("the ancestor walk did not stop at the share root");
      return false;
    },
  });
  const res = await settle(tools.revealPath(deep));
  check("a UNC path nothing exists for is 「路径不存在」", res.ok === false && res.error === `路径不存在：${deep}`, JSON.stringify(res));
  check(
    "and the walk stopped at the share root instead of circling",
    asked <= 12,
    `${asked} filesystem question(s) for ${deep.split("\\").length - 1} level(s): a share root is its own parent`
  );
  check("the shell is left alone when nothing on the share exists", shell.calls.open.length === 0 && shell.calls.reveal.length === 0);
}

{
  // The same walk on a local drive: `C:\` is its own parent on win32, so a deep
  // missing path under it ends there too. This is the ordinary 「配置文件还没写
  // 过，且配置目录也不存在」 shape, one platform's version of the posix check
  // further up.
  const win = path.win32;
  const target = "C:\\Users\\me\\AppData\\Roaming\\ocr\\nested\\config.json";
  let asked = 0;
  const shell = makeShell();
  const tools = make({
    packaged: true,
    resources: path.join(installed, "resources"),
    shell,
    platform: "win32",
    dirname: win.dirname,
    exists: () => {
      if (++asked > 32) throw new Error("the ancestor walk did not stop at the drive root");
      return false;
    },
  });
  const res = await settle(tools.revealPath(target));
  check("a deep missing path on a drive is 「路径不存在」", res.ok === false && res.error === `路径不存在：${target}`, JSON.stringify(res));
  check("and it stopped at the drive root", asked <= 10, `${asked} filesystem question(s)`);
  check("a refusal carries no action or path to read", !("action" in res) && !("path" in res), JSON.stringify(res));
}

{
  // Without the seam the module must still walk with the host's own rules —
  // `dirname` defaults to `path.dirname`, so `main.js` needs no change and the
  // checks above are the only place Windows rules are supplied.
  const shell = makeShell();
  const tools = make({ packaged: true, resources: path.join(installed, "resources"), shell, platform: "win32" });
  const target = path.join(installed, "Open Code Review.exe");
  const res = await tools.revealPath(target);
  check("the default dirname is the host's own", res.ok === true && res.action === "reveal" && res.path === target, JSON.stringify(res));
}

/* ---------------- one shape for 「打开一个目录」 ---------------- */

{
  // The renderer reads `action`/`path` off a failed `revealFile`. 「打开安装目录」
  // is the same act — hand a directory to the file manager — so it must answer
  // with the same fields instead of a bare `{ ok: false, error }`.
  const shell = makeShell();
  const tools = make({ packaged: true, resources: path.join(installed, "resources"), shell });
  const res = await tools.openDir(installed);
  check("opening the install root says which action it was", res.ok === true && res.action === "open-dir" && res.path === installed, JSON.stringify(res));
  check("and the directory is what got opened", shell.calls.open.length === 1 && shell.calls.open[0] === installed);
  check("opening a directory never falls back to revealing it", shell.calls.reveal.length === 0);
}

{
  const shell = makeShell("Failed to open path: denied by policy");
  const tools = make({ packaged: true, resources: path.join(installed, "resources"), shell });
  const res = await tools.openDir(installed);
  check("a directory that could not be opened is reported, not swallowed", res.ok === false && res.error === "Failed to open path: denied by policy", JSON.stringify(res));
  check("and the failure still names the action and the path", res.action === "open-dir" && res.path === installed, JSON.stringify(res));
}

{
  // Same for 「打开安装目录」: a throw has to come back as the directory failure
  // shape, not as a rejected promise.
  const shell = makeShell("", new Error("EPERM: openPath denied"));
  const tools = make({ packaged: true, resources: path.join(installed, "resources"), shell });
  const res = await settle(tools.openDir(installed));
  check("a shell that throws on a directory is reported, not thrown", res.ok === false && res.error === "EPERM: openPath denied", JSON.stringify(res));
  check("with the directory action still named", res.action === "open-dir" && res.path === installed, JSON.stringify(res));
}

{
  // A rejection with nothing in it must not be mistaken for success: the success
  // case is the empty string, so an empty answer gets a sentence of its own
  // instead of passing for "". A guard written as `String(err)` alone would say
  // "null" here; one written as `catch (_) {}` would say nothing at all. `null`
  // is also the throw that a falsy check (`if (openThrows)`) would swallow.
  const shell = makeShell("", null);
  const tools = make({ packaged: true, resources: path.join(installed, "resources"), shell });
  const res = await settle(tools.openDir(installed));
  check(
    "a reasonless rejection is still a failure with a sentence",
    res.ok === false && res.error === NO_REASON,
    JSON.stringify(res)
  );
}

{
  // All three readers of `shell.openPath()` go through `openPathAnswer()`, and
  // the success case is the *empty* answer — so a rejection that carries nothing
  // readable (`null`, or an `Error` with an empty message) is exactly the shape
  // that would pass for "opened" if the fallback sentence were dropped. The check
  // above pins that for `openDir` only; a guard that moved out of the shared
  // helper, or a caller that stopped reading its answer, would show up here for
  // the other two.
  for (const [what, thrown] of [
    ["null", null],
    ["an Error with an empty message", new Error("")],
    ["an Error whose message is only whitespace", new Error("   ")],
    ["an object with no message", { code: "EPERM" }],
  ]) {
    const shell = makeShell("", thrown);
    const tools = make({ packaged: true, resources: path.join(installed, "resources"), shell });
    const target = path.join(installed, "resources", "not-yet", "config.json");
    const ancestor = path.join(installed, "resources");
    // Exact sentence, not merely non-empty: `String(err)` would turn the two
    // Error shapes into "Error" and the object into "[object Object]" — truthy
    // answers that name no cause at all.
    const said = (res) => res.ok === false && res.error === NO_REASON;

    const reveal = await settle(tools.revealPath(target));
    check(`a rejection of ${what} is still a refusal on the ancestor reveal`, said(reveal), JSON.stringify(reveal));
    check(
      "and it still says what was tried and what was missing",
      reveal.action === "open-parent" && reveal.path === ancestor && reveal.missing === target,
      JSON.stringify(reveal)
    );

    const opened = await settle(tools.openDir(installed));
    check(`a rejection of ${what} is still a refusal on 「打开安装目录」`, said(opened), JSON.stringify(opened));
    check("with the directory action still named", opened.action === "open-dir" && opened.path === installed, JSON.stringify(opened));

    const file = await settle(tools.openFile(path.join(installed, "Open Code Review.exe")));
    check(`a rejection of ${what} is still a refusal on 「用系统默认程序打开」`, said(file), JSON.stringify(file));
    check(
      "and it is still an opener failure, not a missing file",
      file.reason === "open-failed" && file.action === "open-file",
      JSON.stringify(file)
    );
  }
}

{
  // A rejected string is the one non-Error shape that *is* a readable reason, so
  // it must pass through as written. Only `String(err)` would have preserved it
  // before; accepting nothing but `err.message` would silently replace it with
  // the fallback sentence.
  const shell = makeShell("", "policy denied by hook");
  const tools = make({ packaged: true, resources: path.join(installed, "resources"), shell });
  const res = await settle(tools.openDir(installed));
  check(
    "a string rejection keeps the sentence it was thrown with",
    res.ok === false && res.error === "policy denied by hook",
    JSON.stringify(res)
  );
}

{
  const shell = makeShell();
  const tools = make({ packaged: true, resources: path.join(installed, "resources"), shell });
  const res = await tools.openDir("");
  check("an empty directory is refused before the shell is asked", res.ok === false && res.action === "open-dir" && res.path === "", JSON.stringify(res));
  check("and the shell is left alone", shell.calls.open.length === 0);
}

/* ---------------- 用系统默认程序打开 a file ---------------- */

{
  // The third reader of `shell.openPath()`: 「用系统默认程序打开」 on a reviewed
  // file. It used to be a bare `() => shell.openPath(absPath)` in main.js, which
  // hands the renderer a string — `""` on success, a sentence on failure — so
  // the renderer had no way to tell "no handler for .xyz" from "opened".
  const shell = makeShell();
  const tools = make({ packaged: true, resources: path.join(installed, "resources"), shell });
  const target = path.join(installed, "Open Code Review.exe");
  const res = await tools.openFile(target);
  check("opening a file says which action it was", res.ok === true && res.action === "open-file" && res.path === target, JSON.stringify(res));
  check("and the file is what got opened", shell.calls.open.length === 1 && shell.calls.open[0] === target);
  check("opening a file never falls back to revealing it", shell.calls.reveal.length === 0);
}

{
  const shell = makeShell("Failed to open path: no application for this file");
  const tools = make({ packaged: true, resources: path.join(installed, "resources"), shell });
  const target = path.join(installed, "Open Code Review.exe");
  const res = await tools.openFile(target);
  check(
    "a file that could not be opened is reported, not swallowed",
    res.ok === false && res.error === "Failed to open path: no application for this file",
    JSON.stringify(res)
  );
  check("and the failure still names the action and the path", res.action === "open-file" && res.path === target, JSON.stringify(res));
  check(
    "a shell refusal is reported as the shell's own, not as a missing file",
    res.reason === "open-failed",
    JSON.stringify(res)
  );
}

{
  // And the third reader: 「用系统默认程序打开」 must keep its `open-failed`
  // reason when the shell throws, because the file *is* there — only the opener
  // failed — and the renderer shows different advice for the two.
  const shell = makeShell("", new Error("spawn failed"));
  const tools = make({ packaged: true, resources: path.join(installed, "resources"), shell });
  const target = path.join(installed, "Open Code Review.exe");
  const res = await settle(tools.openFile(target));
  check("a shell that throws on a file is reported, not thrown", res.ok === false && res.error === "spawn failed", JSON.stringify(res));
  check("and it is called an opener failure, not a missing file", res.reason === "open-failed", JSON.stringify(res));
  check("with the file action and path still named", res.action === "open-file" && res.path === target, JSON.stringify(res));
}

{
  // A file the review names but the working tree no longer has: the branch moved
  // on, or the finding came from a ref that never carried it. `shell.openPath()`
  // answers this with the same "Failed to open path" it answers a missing
  // handler with, so the two would be the same sentence — and 「没有能打开它的
  // 程序」 over a deleted file is advice about the wrong thing. The file's absence
  // is therefore decided before the shell is asked.
  const shell = makeShell();
  const tools = make({ packaged: true, resources: path.join(installed, "resources"), shell });
  const gone = path.join(installed, "src", "removed.go");
  const res = await tools.openFile(gone);
  check("a file that is not there is refused", res.ok === false, JSON.stringify(res));
  check("with a reason of its own", res.reason === "missing", JSON.stringify(res));
  check("and a sentence that names the path", res.error.includes(gone), res.error);
  check("the shell is not asked to open a path nothing exists at", shell.calls.open.length === 0, JSON.stringify(shell.calls));
  check("the action and the path are still answered", res.action === "open-file" && res.path === gone, JSON.stringify(res));
}

{
  // The existence check is the module's own seam (`exists`), so a stubbed
  // filesystem answers it too — without this the check would be reading the real
  // disk and could not be pinned either way round.
  const shell = makeShell();
  const tools = make({ packaged: true, resources: path.join(installed, "resources"), shell, exists: () => false });
  const res = await tools.openFile(path.join(installed, "Open Code Review.exe"));
  check("an injected filesystem that says the file is gone is believed", res.ok === false && res.reason === "missing", JSON.stringify(res));
  check("and the shell is left alone for it as well", shell.calls.open.length === 0, JSON.stringify(shell.calls));
}

{
  // An empty path and a missing file are the two refusals before the shell, and
  // they are not the same refusal: one is "nothing was asked for", the other is
  // "this file is gone". The renderer shows a path for the second.
  const shell = makeShell();
  const tools = make({ packaged: true, resources: path.join(installed, "resources"), shell });
  const empty = await tools.openFile("");
  check("an empty path has its own reason", empty.reason === "no-file", JSON.stringify(empty));
}

{
  const shell = makeShell();
  const tools = make({ packaged: true, resources: path.join(installed, "resources"), shell });
  const res = await tools.openFile("");
  check("an empty file path is refused before the shell is asked", res.ok === false && res.action === "open-file" && res.path === "", JSON.stringify(res));
  check("and the shell is left alone", shell.calls.open.length === 0);
}

{
  // The action names stay apart on purpose: the renderer's two buttons are
  // 「打开文件」 and 「在文件夹中显示」, and a failure report that called both
  // `open-dir` would make the log say the wrong button was pressed.
  const shell = makeShell("nope");
  const tools = make({ packaged: true, resources: path.join(installed, "resources"), shell });
  const file = await tools.openFile(path.join(installed, "Open Code Review.exe"));
  const dir = await tools.openDir(installed);
  check("a file failure and a directory failure do not share an action", file.action === "open-file" && dir.action === "open-dir");
}

{
  // The other half of the same shape: the plan's own refusal (there is no
  // directory to open) carries `action`/`path` too, so a caller can read the
  // four fields without asking which branch answered.
  const tools = make({
    packaged: true,
    resources: path.join(installed, "resources"),
    env: { PORTABLE_EXECUTABLE_DIR: tmp },
  });
  const plan = tools.installDirPlan();
  const fields = ["ok", "error", "action", "path"];
  check("a refused 「打开安装目录」 carries all four fields", plan.ok === false && fields.every((f) => f in plan), JSON.stringify(plan));
  check("its action matches the one openDir answers with", plan.action === "open-dir");
  check("its path is empty because there is none", plan.path === "");
}

/* ---------------- `exists` is the only opinion asked ---------------- */

{
  // Every "is it there?" decision goes through the injected `exists`, not
  // through fs. These stubs say a path that is really on disk is missing, which
  // is the counter-example the earlier checks (all using fs.existsSync) cannot
  // express: if any of the three helpers reached for the real filesystem
  // instead, these would answer as if the path existed.
  const target = path.join(installed, "Open Code Review.exe");
  const shell = makeShell();
  const tools = make({
    packaged: true,
    resources: path.join(installed, "resources"),
    shell,
    exists: (p) => p !== target,
  });
  const res = await tools.revealPath(target);
  check(
    "a target the injected exists calls missing walks up to its parent",
    res.ok === true && res.action === "open-parent" && res.path === installed && res.missing === target,
    JSON.stringify(res)
  );
  check("so the file itself was not revealed", shell.calls.reveal.length === 0);
  check("its parent was opened instead", shell.calls.open.length === 1 && shell.calls.open[0] === installed);
}

{
  const tools = make({
    packaged: true,
    resources: path.join(installed, "resources"),
    exists: (p) => p !== installed,
  });
  const plan = tools.installDirPlan();
  check(
    "a directory the injected exists calls missing is refused as missing, not as portable",
    plan.ok === false && refusal(plan).includes("安装目录已经不存在") && !refusal(plan).includes("免安装版"),
    JSON.stringify(plan)
  );
  check("and its uninstaller is not looked for", tools.uninstallerPath(installed) === "");
  check("so 「卸载」 is not offered either", tools.uninstallPlan().ok === false);
}

{
  // The same stub the other way round: the directory is gone from the
  // filesystem's point of view but the walk must still stop on a path `exists`
  // accepts, otherwise 「打开配置文件所在目录」 would report 路径不存在 for a
  // path whose parent is right there.
  const shell = makeShell();
  const target = path.join(installed, "resources", "no-such.json");
  const tools = make({
    packaged: true,
    resources: path.join(installed, "resources"),
    shell,
    exists: (p) => p === path.join(installed, "resources"),
  });
  const res = await tools.revealPath(target);
  check("a synthetic exists decides the walk, not fs", res.ok === true && res.path === path.join(installed, "resources"), JSON.stringify(res));
}

/* ---------------- the install facts are exactly these six keys ---------------- */

/* The checks above ask about a field at a time, so a *new* field slips into
 * `installInfo()` without any of them noticing. That matters beyond this module:
 * `app:info` spreads this object into the IPC payload, and `src/lib/types.ts`
 * reads those names, so a rename or an addition is a blank row on the settings
 * page. The key set is pinned once per install shape — the facts are the same
 * six whether the copy is installed, portable, a dev build, an install whose
 * uninstaller has gone missing, or an install directory that has since been
 * deleted, only their values differ.
 *
 * The last two shapes are here because the five fields they fill differently are
 * exactly the ones a "just return early" edit would replace with a different
 * object: a root without an uninstaller answers `canUninstall: false` through
 * the same six-key literal, and a deleted root still names its `installDir`.
 * Pinning only the three happy-ish shapes would let a shape-specific return
 * literal appear, and the first red would be `app-info-smoke.mjs`'s payload
 * key-set — where the reader has to work out whether the fixture or the module
 * moved.
 *
 * The list itself lives in `tools/install-fixture.mjs`, next to the stubs this
 * suite builds the module from, so this check and `app-info-smoke.mjs`'s payload
 * check cannot disagree about which six facts exist: one list, two assertions
 * about two different things (the module's answer, and the IPC payload built
 * from it). `app-info-smoke.mjs` also asserts that this file imports the
 * fixture, so a local copy cannot come back.
 */
{
  const expected = [...INSTALL_INFO_KEYS];
  const shapes = [
    ["installed", make({ packaged: true, resources: path.join(installed, "resources") })],
    ["portable", make({ packaged: true, resources: path.join(installed, "resources"), env: { PORTABLE_EXECUTABLE_DIR: tmp } })],
    ["dev", make({ packaged: false, resources: path.join(installed, "resources") })],
    // The same install root as `installed`, but without the uninstaller file the
    // scan looks for.
    ["uninstaller missing", make({ packaged: true, resources: path.join(bare, "resources") })],
    // A root that is named by the info but is not on disk any more (the same
    // path the 「安装目录已经不存在」 block above asks about).
    ["install directory deleted", make({ packaged: true, resources: path.join(tmp, "uninstalled", "resources") })],
  ];
  for (const [label, tools] of shapes) {
    const keys = Object.keys(tools.installInfo()).sort();
    check(
      `${label}: installInfo() answers exactly the six pinned keys`,
      JSON.stringify(keys) === JSON.stringify(expected),
      JSON.stringify({ got: keys, want: expected })
    );
  }
}

/* ---------------- the six fact names are not app:info's own fields ---------------- */

/* The other half of the collision decision pinned in `app-info-smoke.mjs`.
 * `formatAppInfo()` spreads `installInfo()` *before* the seven fields it
 * computes itself, so a fact that shared one of those names would be silently
 * dropped. Both directions matter and neither can see the other: this module
 * must not *offer* a colliding name, and `app-info-smoke.mjs` proves the
 * computed value still wins if one ever appears. A rename here, or a reordered
 * spread there, is visible in exactly one of the two.
 */
{
  const facts = Object.keys(
    make({ packaged: true, resources: path.join(installed, "resources") }).installInfo()
  ).sort();
  const collisions = facts.filter((key) => APP_INFO_COMPUTED_KEYS.includes(key));
  check(
    "installInfo() offers no name that formatAppInfo computes for itself",
    collisions.length === 0,
    JSON.stringify({
      facts,
      computed: [...APP_INFO_COMPUTED_KEYS].sort(),
      collisions,
    })
  );
  // Without a complete list, "no collision" passes over nothing. The names are
  // written out here as the contract; `app-info-smoke.mjs` separately derives
  // the same set from `formatAppInfo({ installInfo: {} })` and requires
  // `APP_INFO_COMPUTED_KEYS` to equal it — so a field dropped from the list is
  // red on one side or the other, and the collision proof there runs over the
  // derived set rather than over this list.
  const computed = [
    "appVersion",
    "binary",
    "binarySource",
    "configPath",
    "docsUrl",
    "platform",
    "version",
  ];
  check(
    "...and the computed-name list really covers all seven fields, so this is not a vacuous pass",
    APP_INFO_COMPUTED_KEYS.length === computed.length &&
      computed.every((key) => APP_INFO_COMPUTED_KEYS.includes(key)),
    JSON.stringify({ got: [...APP_INFO_COMPUTED_KEYS].sort(), want: computed })
  );
}

/* ---------------- the module stays importable without Electron ---------------- */

{
  const src = fs.readFileSync(path.join(ROOT, "install-info.js"), "utf8");
  const required = [...src.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  check("install-info.js only requires node builtins", required.every((r) => r === "fs" || r === "path"), required.join(", "));
  check("it never reaches for Electron", !/require\(\s*["']electron["']/.test(src));

  // The behaviour checks above prove the module *can* answer these questions.
  // They cannot prove the app asks it — that wiring is one line in main.js, and
  // it is the line a refactor moves back.
  const main = fs.readFileSync(path.join(ROOT, "main.js"), "utf8");
  check("main.js builds the helpers from the real app and shell", /createInstall\(\{\s*app,\s*shell\s*\}\)/.test(main));
  check("main.js no longer defines installInfo itself", !/function installInfo\s*\(/.test(main));
  check("main.js no longer defines uninstallerPath itself", !/function uninstallerPath\s*\(/.test(main));
  check("main.js no longer defines revealPath itself", !/function revealPath\s*\(/.test(main));
  check(
    "the five refusal sentences live in install-info.js only",
    ["当前形态没有安装目录", "安装目录已经不存在", "免安装版没有卸载器", "没有找到卸载程序", "路径不存在："].every(
      (s) => !main.includes(s)
    )
  );
  // The two buttons ask the module questions, and 卸载's body is no longer in
  // this file: the order it is made of (flush, spawn, reply, quit) moved to
  // `uninstall-handler.js` in the round that made it callable. So the directory
  // plan is still asked here, the uninstall plan is asked in the handler
  // `main.js` registers — and not a second time here, which is the "helpful"
  // edit that would put the body back where nothing can call it.
  const uninstallSrc = fs.readFileSync(path.join(ROOT, "uninstall-handler.js"), "utf8");
  const asksHere = /install\.installDirPlan\(\)/.test(main);
  const asksThere = /install\.uninstallPlan\(\)/.test(uninstallSrc);
  const asksTwice = /install\.uninstallPlan\(\)/.test(main);
  const routed = asksHere && asksThere && !asksTwice;
  check(
    "main.js still routes 打开安装目录 and 卸载 through the module",
    routed,
    routed ? "" : `main.js asks the directory plan: ${asksHere}, the handler asks the uninstall plan: ${asksThere}, main.js asks it too: ${asksTwice}`
  );
  // A refusal is only worth anything if it reaches the screen: each handler must
  // return the plan's own `error`, not a rewording of it and not `undefined`.
  const handlerBody = (name) => {
    const hit = main.match(new RegExp(`ipcMain\\.handle\\(\\s*"${name}"[\\s\\S]*?\\n\\}\\);`));
    return hit ? hit[0] : "";
  };
  const openInstallDir = handlerBody("app:openInstallDir");
  check("app:openInstallDir hands the refusal through unchanged", /if \(!plan\.ok\) return plan;/.test(openInstallDir));
  check("app:uninstall hands the refusal through unchanged", /if \(!plan\.ok\) return plan;/.test(uninstallSrc));
  // The refusal is only unchanged if the handler returns the plan itself: a
  // hand-built `{ ok: false, error }` is the shape an earlier round removed, and
  // it is what a "helpful" edit puts back. The directory handler may build none.
  // The uninstall handler may build only the failures about its own two acts —
  // reading the plan, and starting the exe — each of which names which act
  // failed, because install-info cannot know about either.
  check("app:openInstallDir does not build its own failure shape", !/\{\s*ok:\s*false/.test(openInstallDir));
  check("app:openInstallDir opens through the module", /return install\.openDir\(plan\.dir\);/.test(openInstallDir));
  const builtThere = [...uninstallSrc.matchAll(/return \{\s*ok:\s*false,\s*error:\s*([^}]*)\}/g)].map((m) => m[1].trim());
  const onlyOwnActs = builtThere.length === 3 && builtThere.every((expr) => /planFailure|启动卸载程序失败/.test(expr));
  check(
    "every failure 卸载 builds is one of its own two named acts",
    onlyOwnActs,
    onlyOwnActs ? "" : JSON.stringify(builtThere)
  );
  const exeSaid = /启动卸载程序失败/.test(uninstallSrc);
  check(
    "and the one about the exe says the uninstaller would not launch",
    exeSaid && !/启动卸载程序失败/.test(main),
    exeSaid ? "" : "uninstall-handler.js no longer says 启动卸载程序失败"
  );
  check("install-info.js answers the open-directory failure shape", /async function openDir\(\s*target\s*\)/.test(fs.readFileSync(path.join(ROOT, "install-info.js"), "utf8")));
  check("file:reveal returns what the module answered", /ipcMain\.handle\(\s*"file:reveal",\s*\(_e, absPath\)\s*=>\s*install\.revealPath\(absPath\)\s*\)/.test(main));
  // `file:open` used to hand the renderer the raw string from `shell.openPath()`,
  // which reads as success for `""` and as *anything* for a failure. It must go
  // through the module now, and the module must be the one reading the answer.
  check("file:open opens through the module", /ipcMain\.handle\(\s*"file:open",\s*\(_e, absPath\)\s*=>\s*install\.openFile\(absPath\)\s*\)/.test(main));
  check("main.js no longer returns shell.openPath's raw string", !/ipcMain\.handle\(\s*"file:open"[^\n]*shell\.openPath/.test(main));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures.length ? failures.length + " failed" : "all ok"}`);
if (failures.length) process.exit(1);
