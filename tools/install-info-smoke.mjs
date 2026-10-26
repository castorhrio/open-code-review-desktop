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

const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok      " : "FAIL    "} ${name}${detail ? `  <- ${detail}` : ""}`);
  if (!ok) failures.push(name);
};

/** The sentence a refusal carries, or "" when the plan was allowed — the
 *  checks below read it as text, and an allowed plan has none. */
const refusal = (plan) => (plan && plan.ok === false ? plan.error || "" : "");

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

/** `shell` that records the calls instead of opening a file manager. */
const makeShell = () => {
  const calls = { reveal: [], open: [] };
  return {
    calls,
    showItemInFolder: (p) => calls.reveal.push(p),
    openPath: async (p) => {
      calls.open.push(p);
      return "";
    },
  };
};

/**
 * `app` with only the two members install-info reads. `getPath("exe")` answers
 * with a path under the install root, because that is the only thing the
 * renderer shows for it.
 */
const makeApp = ({ packaged, resources = "", userData = path.join(tmp, "profile"), exe = path.join(installed, "Open Code Review.exe") }) => ({
  isPackaged: packaged,
  resourcesPath: resources,
  getPath: (name) => (name === "userData" ? userData : exe),
});

const make = ({ packaged, resources = "", platform = "win32", env = {}, shell = makeShell(), exists = fs.existsSync }) =>
  createInstall({
    app: makeApp({ packaged, resources }),
    shell,
    platform,
    env,
    resourcesPath: () => resources,
    exists,
  });

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
  check("「打开安装目录」 is refused", tools.installDirPlan().ok === false);
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
    dirPlan.ok === false && refusal(dirPlan).includes("没有安装目录"),
    refusal(dirPlan)
  );
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
  const res = tools.revealPath(target);
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
  const res = tools.revealPath(target);
  check("a missing path falls back to the nearest existing ancestor", res.ok === true && res.action === "open-parent" && res.path === ancestor, JSON.stringify(res));
  check("the missing target is still reported", res.missing === target);
  check("the ancestor is what gets opened", shell.calls.open.length === 1 && shell.calls.open[0] === ancestor);
  check("no empty folder was revealed", shell.calls.reveal.length === 0);
}

{
  const shell = makeShell();
  const tools = make({ packaged: true, resources: path.join(installed, "resources"), shell, exists: () => false });
  const target = path.join(tmp, "nowhere", "deeper", "config.json");
  const res = tools.revealPath(target);
  check("nothing existing at all is an error, not a crash", res.ok === false && res.error === `路径不存在：${target}`, JSON.stringify(res));
  check("and the shell is left alone", shell.calls.open.length === 0 && shell.calls.reveal.length === 0);
}

{
  const shell = makeShell();
  const tools = make({ packaged: true, resources: path.join(installed, "resources"), shell });
  const res = tools.revealPath("");
  check("an empty path is refused before the filesystem is asked", res.ok === false && res.error === "没有可显示的路径");
  check("the shell is left alone for an empty path", shell.calls.open.length === 0 && shell.calls.reveal.length === 0);
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
    "the four refusal sentences live in install-info.js only",
    ["当前形态没有安装目录", "免安装版没有卸载器", "没有找到卸载程序", "路径不存在："].every((s) => !main.includes(s))
  );
  check("main.js still routes 打开安装目录 and 卸载 through the module", /install\.installDirPlan\(\)/.test(main) && /install\.uninstallPlan\(\)/.test(main));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures.length ? failures.length + " failed" : "all ok"}`);
if (failures.length) process.exit(1);
