// The bytes that ship, booted.
//
// `tools/e2e-first-run.cjs` walks the chain a new user walks — guide card, pick a
// repository, configure a provider, preview, the cost confirmation — but it walks
// it in the *source tree*: `electron tools/e2e-first-run.cjs` loads `main.js` from
// the checkout and resolves the CLI from the checkout's `node_modules/`. The thing
// a user downloads is a different set of bytes: `release/<platform>-unpacked`,
// assembled by electron-builder from the `build.files` allowlist, pruned by
// `build/after-pack.cjs`, with the CLI binary inside `resources/app`. Nothing in
// this repository had ever started that copy. `docs/measurements.md` has said so
// since round 112 (「安装版之后的首启仍未有人看过」), and it is the half of DOD-4 and
// DOD-5 that no amount of source-tree harness can close.
//
// This harness starts it. The packaged executable is launched with a throwaway
// HOME and a throwaway Electron profile, its renderer is reached over the DevTools
// protocol, and the questions asked are the ones only the shipped bytes can
// answer:
//
//   - did the renderer come from `resources/app/out`, or from the checkout?
//   - does the app say it is installed, and does the install directory it names
//     exist where the package put it?
//   - is the CLI it probes the one *inside* the package — not a global npm
//     install that happens to be on this machine — and does that binary report
//     the pinned tag and commit?
//   - did the first screen render, with the guide card a first run shows?
//   - did the profile land in the throwaway HOME, and is the developer's own
//     `~/.opencodereview/config.json` byte-identical afterwards?
//
// The reverse control is the same assertions pointed at the *source tree*: a
// development copy must fail the packaged-specific ones (no install directory, a
// binary outside the package). Without it, a green here could mean "the checks
// are satisfied" or "the checks never had anything to look at" — the two are
// indistinguishable from the outside, and the second is the failure mode this
// repository keeps finding.
//
// What this does NOT prove, and says so rather than implying otherwise: the
// Windows `*-setup.exe` wrapper (NSIS install, shortcuts, SmartScreen, the
// uninstaller) is not exercised — this machine is Linux, and the packaged tree it
// boots is the same tree the installer unpacks, not the installer. That row stays
// open in `docs/measurements.md` with its own trigger.
//
// Run with `npm run audit:packaged` after `npm run pack` (it refuses a missing or
// stale tree rather than passing quietly). It needs a display: on a headless box,
// `xvfb-run -a npm run audit:packaged`. The rules themselves are pinned without a
// browser or a package by `tools/e2e-packaged-smoke.mjs` (`audit:packaged-rules`,
// part of `audit:static`), so an edit here is caught on the next static run.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { PINNED_UPSTREAM } from "./upstream-watch.mjs";
import { loadPlaywright } from "./ui-audit/playwright.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const RELEASE = path.join(ROOT, "release");

/* ---- what the package is supposed to contain ----
 *
 * Every name here is electron-builder's, and each one is a fact the shipped tree
 * either has or does not. They are exported so the smoke test can drive the rules
 * against a fake tree instead of a 350MB one.
 */
export const CLI_SCOPE = "@alibaba-group";

/** The output directory electron-builder writes for a platform, in the order to
 *  try. `--dir` builds land here; the installer is produced from the same tree. */
export const PACKAGED_DIRS = Object.freeze({
  linux: ["linux-unpacked"],
  win32: ["win-unpacked"],
  darwin: ["mac", "mac-arm64"],
});

export const packagedDirCandidates = (platform = process.platform) => PACKAGED_DIRS[platform] || [];

export const executableName = (platform = process.platform) =>
  platform === "win32" ? "open-code-review-desktop.exe" : "open-code-review-desktop";

/** The platform package the wrapped CLI ships as an optional dependency. */
export const cliPlatformPackage = (platform = process.platform, arch = process.arch) => `ocr-${platform}-${arch}`;

export const cliBinaryName = (platform = process.platform) => (platform === "win32" ? "opencodereview.exe" : "opencodereview");

/** The path the app itself resolves the CLI to, inside a packaged tree. */
export const packagedCliPath = (pkgDir, platform = process.platform, arch = process.arch) =>
  path.join(pkgDir, "resources", "app", "node_modules", CLI_SCOPE, cliPlatformPackage(platform, arch), "bin", cliBinaryName(platform));

const isInside = (child, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

const iso = (ms) => new Date(ms).toISOString();

/* ---- the rules ----
 *
 * Four questions, each answered as a list of violations. They take their
 * filesystem and their facts as arguments so the smoke test can hand in a tree
 * that is wrong in exactly one way and require the matching sentence.
 */

/**
 * What the packaged tree must contain, read off the tree itself.
 *
 * The allowlist check (`tools/check-packaging.mjs`) answers "will the packaged app
 * find its files" by scanning the *source* tree against `build.files`. This asks
 * the same question of the bytes that were actually assembled, which is the only
 * place `after-pack`'s pruning and electron-builder's own file selection can be
 * observed: a module dropped by the allowlist, a renderer bundle that never got
 * copied, or a CLI package pruned for the wrong platform all look fine in the
 * checkout and are fatal in the package.
 */
export const packagedTreeViolations = ({
  pkgDir,
  platform = process.platform,
  arch = process.arch,
  version = "",
  exists = fs.existsSync,
  readdir = fs.readdirSync,
  readFile = (file) => fs.readFileSync(file, "utf8"),
}) => {
  const violations = [];
  const app = path.join(pkgDir, "resources", "app");

  const exe = path.join(pkgDir, executableName(platform));
  if (!exists(exe)) violations.push(`打包树里没有可执行文件：${exe}`);

  const index = path.join(app, "out", "index.html");
  if (!exists(index)) violations.push(`打包树里没有渲染层入口：${index}`);

  const manifest = path.join(app, "package.json");
  if (!exists(manifest)) {
    violations.push(`打包树里没有 package.json：${manifest}`);
  } else {
    let parsed = null;
    try {
      parsed = JSON.parse(readFile(manifest));
    } catch (error) {
      violations.push(`打包树里的 package.json 读不出来：${(error && error.message) || error}`);
    }
    if (parsed && version && parsed.version !== version) {
      violations.push(`打包树里的版本是 ${parsed.version}，仓里是 ${version}——这份产物不是当前源码打的`);
    }
  }

  const binary = packagedCliPath(pkgDir, platform, arch);
  if (!exists(binary)) violations.push(`打包树里没有本平台的 CLI 二进制：${binary}`);

  // `build/after-pack.cjs` keeps one platform package and deletes the other five.
  // The hook's own source is not the promise; the shipped tree is.
  const scope = path.join(app, "node_modules", CLI_SCOPE);
  if (!exists(scope)) {
    violations.push(`打包树里没有 ${CLI_SCOPE} 目录：${scope}`);
  } else {
    const kept = readdir(scope).filter((name) => name.startsWith("ocr-"));
    const want = cliPlatformPackage(platform, arch);
    const extra = kept.filter((name) => name !== want);
    if (extra.length) {
      violations.push(`打包树里还留着别的平台的 CLI 包（${extra.join("、")}）——after-pack 的裁剪没有生效`);
    }
    if (!kept.includes(want)) violations.push(`打包树里没有 ${want}（只有 ${kept.join("、") || "空"}）`);
  }

  return violations;
};

/**
 * A packaged tree older than the sources it claims to be built from.
 *
 * Same failure as `requireBuilt()` one layer down, and the same reason it is
 * checked rather than assumed: a stale package boots fine, renders the previous
 * edit's UI, and reports green about code that no longer exists.
 */
export const stalenessViolations = ({ builtAt, newestSource, label = "src/" }) => {
  if (!Number.isFinite(builtAt)) return ["打包树里读不到渲染层入口的时间戳"];
  if (!Number.isFinite(newestSource)) return [];
  if (newestSource > builtAt) {
    return [
      `打包树比 ${label} 旧（产物 ${iso(builtAt)}，${label} ${iso(newestSource)}）——` +
        "这一趟会验上一版源码然后报绿；先 `npm run pack`",
    ];
  }
  return [];
};

/**
 * What the running app says about the copy it is running from.
 *
 * These are the facts a source-tree run cannot have: `app.isPackaged`, the
 * install directory derived from `process.resourcesPath`, and a CLI resolved from
 * inside the package. A development copy answers `packaged: false` and an empty
 * install directory, which is exactly what the reverse control requires to be red.
 */
export const installedShapeViolations = ({
  info,
  pkgDir,
  home = "",
  version = "",
  platform = process.platform,
}) => {
  if (!info || typeof info !== "object") return ["应用没有回答 app:info"];
  const violations = [];

  if (info.packaged !== true) violations.push(`应用自报不是打包版（packaged=${JSON.stringify(info.packaged)}）`);
  if (info.portable === true) violations.push("应用自报是免安装版（portable=true），这一趟验的是安装版形态");

  const wantDir = path.resolve(pkgDir);
  if (!info.installDir) {
    violations.push("应用没有报出安装目录（installDir 为空）——安装版形态没有认出来");
  } else if (path.resolve(info.installDir) !== wantDir) {
    violations.push(`应用报的安装目录是 ${info.installDir}，打包树在 ${wantDir}`);
  }

  if (!info.binary) {
    violations.push("应用没有找到 CLI 二进制");
  } else if (!isInside(info.binary, wantDir)) {
    violations.push(`应用用的 CLI 不在打包树里：${info.binary}`);
  }
  if (info.binarySource === "global") {
    violations.push("应用回落到全局 npm 安装的 CLI（binarySource=global）——打包树里那份没被用上");
  }

  if (!info.configPath) {
    violations.push("应用没有报出配置目录");
  } else if (home && !isInside(info.configPath, home)) {
    violations.push(`配置目录落在一次性档案之外：${info.configPath}`);
  }

  if (version && info.appVersion !== version) {
    violations.push(`应用自报版本 ${info.appVersion}，仓里是 ${version}`);
  }

  return violations;
};

/**
 * The version the app's own probe got out of the bundled binary.
 *
 * `app-info.js` asks `ocr --version`; the answer is `v1.13.5 (abb7abcd) linux/amd64`.
 * Both halves matter: the tag is what the README promises, and the commit prefix
 * is what tells two builds of the same tag apart. This is the question
 * `docs/measurements.md` has been carrying as 「发布资产里带的是哪一版 ocr」 — for the
 * packaged tree it can now be answered by a run instead of by a person reading a
 * version dialog.
 */
export const cliVersionViolations = ({ version, tag = PINNED_UPSTREAM.tag, sha = PINNED_UPSTREAM.sha }) => {
  const text = String(version == null ? "" : version).trim();
  if (!text) return ["应用没有报出 CLI 版本——内置二进制可能没跑起来"];
  const violations = [];
  if (!text.startsWith(`${tag} `)) violations.push(`内置 CLI 自报「${text}」，pin 的 tag 是 ${tag}`);
  const prefix = String(sha || "").slice(0, 7);
  if (prefix && !text.includes(prefix)) violations.push(`内置 CLI 自报「${text}」，pin 的 commit 前缀是 ${prefix}`);
  return violations;
};

/* ---- launching it ---- */

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until the app's DevTools endpoint answers, or say how long we waited. */
const waitForCdp = async (port, timeoutMs = 45000) => {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return { ok: true };
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = (error && error.message) || String(error);
    }
    await sleep(250);
  }
  return { ok: false, failure: `${timeoutMs}ms 内没有等到 DevTools 端点（最后一次：${last}）` };
};

const newestMtime = (target) => {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = 0;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    newest = Math.max(newest, newestMtime(path.join(target, entry.name)));
  }
  return newest;
};

const digest = (file) => {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch (_) {
    return "";
  }
};

const realConfigPath = () => path.join(os.homedir(), ".opencodereview", "config.json");

/**
 * Boot one copy of the app against a throwaway profile and hand back what it says
 * about itself.
 *
 * `mode` is `packaged` (the shipped tree) or `dev` (the checkout, used only as the
 * reverse control). Both get the same throwaway HOME, so the two runs differ in
 * exactly one thing: which bytes are running.
 */
const boot = async ({ mode, pkgDir, playwright }) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `ocr-packaged-${mode}-`));
  const port = await freePort();
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const args = ["--no-sandbox", `--remote-debugging-port=${port}`];
  const command =
    mode === "packaged"
      ? path.join(pkgDir, executableName())
      : createRequire(path.join(ROOT, "package.json"))("electron");
  const spawnArgs = mode === "packaged" ? args : [ROOT, ...args];

  const child = spawn(command, spawnArgs, {
    cwd: mode === "packaged" ? pkgDir : ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  const cleanup = () => {
    try {
      child.kill();
    } catch (_) {
      /* already gone */
    }
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch (_) {
      /* a leftover temp dir is not a failure */
    }
  };

  const ready = await waitForCdp(port);
  if (!ready.ok) {
    cleanup();
    return { ok: false, failure: `${mode} 那一份没有起来：${ready.failure}\n${output.join("").slice(-2000)}` };
  }

  let browser = null;
  try {
    browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    const page = context.pages()[0] || (await context.waitForEvent("page", { timeout: 15000 }));
    await page.waitForLoadState("domcontentloaded");
    // The renderer asks the main process for `app:info` on mount; the answer is
    // what carries the CLI probe, so wait for it rather than racing it.
    await page.waitForFunction(() => Boolean(document.querySelector("main")), null, { timeout: 30000 });
    await sleep(1200);
    const info = await page.evaluate(() => window.api.info());
    const url = page.url();
    const bodyText = await page.evaluate(() => document.body.innerText);
    // The badge lives on the settings page, so the settings page has to be
    // opened before it can be read — the first screen does not carry it.
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await sleep(900);
    const badge = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll("span, div, p")];
      const hit = nodes.find((node) => /^(安装版|免安装版|开发模式) · \S+$/.test((node.textContent || "").trim()));
      return hit ? hit.textContent.trim() : "";
    });
    return { ok: true, page, browser, info, url, bodyText, badge, home, cleanup };
  } catch (error) {
    try {
      if (browser) await browser.close();
    } catch (_) {
      /* the app is being killed anyway */
    }
    cleanup();
    return { ok: false, failure: `${mode} 那一份起来了但读不到界面：${(error && error.message) || error}` };
  }
};

/* ---- the run ---- */

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "ok     " : "FAIL   "} ${name}${ok || !detail ? "" : `：${detail}`}`);
};

const refuse = (message) => {
  console.error(message);
  process.exit(2);
};

const main = async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const platform = process.platform;
  const arch = process.arch;

  const candidates = packagedDirCandidates(platform).map((name) => path.join(RELEASE, name));
  const pkgDir = candidates.find((dir) => fs.existsSync(dir));
  if (!pkgDir) {
    refuse(
      [
        `没有找到打包产物（找过：${candidates.join("、") || "本平台没有约定目录"}）。`,
        "这一趟验的是装完的那份字节，源码树里的 Electron 不算——先 `npm run pack`（或 `npm run dist`）。",
      ].join("\n")
    );
  }

  // The tree has to be the one this source produces, or the run is a statement
  // about the previous edit.
  const builtIndex = path.join(pkgDir, "resources", "app", "out", "index.html");
  const builtAt = fs.existsSync(builtIndex) ? fs.statSync(builtIndex).mtimeMs : NaN;
  const newestSource = Math.max(
    ...[path.join(ROOT, "src"), path.join(ROOT, "vite.config.mjs")]
      .filter((target) => fs.existsSync(target))
      .map(newestMtime)
  );
  const stale = stalenessViolations({ builtAt, newestSource });
  check(`打包树不比源码旧（${path.relative(ROOT, pkgDir)}）`, stale.length === 0, stale.join("；"));
  if (stale.length) {
    console.error("先 `npm run pack` 再跑这一趟：验一份旧产物没有意义。");
    process.exit(1);
  }

  const tree = packagedTreeViolations({ pkgDir, platform, arch, version: pkg.version });
  check(`打包树里该有的都在（可执行文件 / 渲染层 / 本平台 CLI / 只留本平台）`, tree.length === 0, tree.join("；"));

  const playwright = await loadPlaywright();
  const before = digest(realConfigPath());

  const packaged = await boot({ mode: "packaged", pkgDir, playwright });
  if (!packaged.ok) {
    check("打包产物能起来并画出界面", false, packaged.failure);
    console.error(`\n打包产物：${results.filter((r) => !r.ok).length} 条红`);
    process.exit(1);
  }

  try {
    check(
      "渲染层来自打包树（不是源码树）",
      packaged.url.startsWith(`file://${path.join(pkgDir, "resources", "app", "out")}`),
      `页面地址是 ${packaged.url}`
    );

    const guide = packaged.bodyText.includes("三步开始第一次审查");
    check("首启那一屏画出来了（引导卡三步在）", guide, "首屏没有引导卡——这一份不是空档案，或者引导卡没渲染");
    check(
      "首屏有中文正文（这一屏真的被读到了）",
      /[，。、；：！？（）「」]/.test(packaged.bodyText),
      "首屏没有任何全角标点，说明取到的文本是空的"
    );

    const shape = installedShapeViolations({ info: packaged.info, pkgDir, home: packaged.home, version: pkg.version, platform });
    check("应用自报「安装版」，安装目录就是打包树", shape.length === 0, shape.join("；"));

    check(
      `设置页的徽章写「安装版 · ${platform}」`,
      packaged.badge === `安装版 · ${platform}`,
      `读到的是「${packaged.badge || "（没有找到徽章）"}」`
    );

    const cli = cliVersionViolations({ version: packaged.info && packaged.info.version });
    check(
      `内置 CLI 可达且自报 pin 的那一版（${PINNED_UPSTREAM.tag} / ${PINNED_UPSTREAM.sha.slice(0, 7)}）`,
      cli.length === 0,
      cli.join("；")
    );

    check(
      "配置落在一次性档案里",
      Boolean(packaged.info && packaged.info.configPath) && isInside(packaged.info.configPath, packaged.home),
      `配置目录是 ${packaged.info && packaged.info.configPath}`
    );
  } finally {
    try {
      await packaged.browser.close();
    } catch (_) {
      /* the app is being killed anyway */
    }
    packaged.cleanup();
  }

  check(
    "开发者自己的 ~/.opencodereview/config.json 一个字节都没动",
    digest(realConfigPath()) === before,
    "真实配置文件的摘要变了——一次性档案的重定向没有生效"
  );

  // The reverse control: the same assertions, pointed at the checkout. A
  // development copy has no install directory and resolves the CLI from the
  // checkout's `node_modules`, so the packaged-specific rules must fire. If they
  // do not, they were never about the package.
  const dev = await boot({ mode: "dev", pkgDir, playwright });
  if (!dev.ok) {
    check("反向控制：源码树那一份能起来（否则这条控制没有对象）", false, dev.failure);
  } else {
    try {
      const devShape = installedShapeViolations({ info: dev.info, pkgDir, home: dev.home, version: pkg.version, platform });
      const named = devShape.filter((line) => line.includes("安装目录") || line.includes("不在打包树里"));
      check(
        "反向控制：同一套断言指向源码树时变红，并点名安装目录与 CLI 位置",
        devShape.length > 0 && named.length >= 2,
        devShape.length ? `只点名了 ${named.length} 条：${devShape.join("；")}` : "源码树那一份也全绿——这些断言不是关于打包产物的"
      );
    } finally {
      try {
        await dev.browser.close();
      } catch (_) {
        /* the app is being killed anyway */
      }
      dev.cleanup();
    }
  }

  const failed = results.filter((result) => !result.ok);
  console.log(
    `\n打包产物首启：${results.length} 条检查，${failed.length} 条红` +
      `（${path.relative(ROOT, pkgDir)}，${platform}/${arch}，内置 CLI ${(packaged.info && packaged.info.version) || "未报" }）`
  );
  if (failed.length) {
    console.error(failed.map((result) => `  - ${result.name}：${result.detail}`).join("\n"));
    process.exit(1);
  }
};

const isEntryPoint = process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href;

if (isEntryPoint) {
  await main();
}
