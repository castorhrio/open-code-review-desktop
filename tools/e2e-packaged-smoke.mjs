// The rules of `tools/e2e-packaged.mjs`, pinned without a package or a browser.
//
// `npm run audit:packaged` needs a 350MB packaged tree and a display, so it cannot
// run on every static pass — which is exactly how a rule quietly rots. This file
// drives the same exported predicates against fake trees and fake `app:info`
// answers, one wrong fact at a time, and requires the matching sentence. It also
// pins the wiring: the harness must be reachable from an `audit*` script (the
// closure `tools/upstream-watch.mjs` computes), and it must NOT be inside
// `audit:app`, because a gate that needs `npm run pack` first would turn every
// ordinary audit run into a packaging job.
import fs from "node:fs";
import path from "node:path";
import {
  CLI_SCOPE,
  cliPlatformPackage,
  cliVersionViolations,
  executableName,
  installedShapeViolations,
  packagedDirCandidates,
  packagedTreeViolations,
  stalenessViolations,
} from "./e2e-packaged.mjs";
import { PINNED_UPSTREAM, auditScriptClosure } from "./upstream-watch.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "ok     " : "FAIL   "} ${name}${ok || !detail ? "" : `：${detail}`}`);
};

const PKG = "/fake/release/linux-unpacked";
const APP = path.join(PKG, "resources", "app");
const BIN = path.join(APP, "node_modules", CLI_SCOPE, cliPlatformPackage("linux", "x64"), "bin", "opencodereview");

/** A tree that is right in every way, described as a set of paths. */
const goodTree = () => ({
  files: new Set([
    path.join(PKG, executableName("linux")),
    path.join(APP, "out", "index.html"),
    path.join(APP, "package.json"),
    BIN,
  ]),
  scope: [cliPlatformPackage("linux", "x64")],
  manifest: { version: "0.1.13" },
});

const treeViolations = (tree, extra = {}) =>
  packagedTreeViolations({
    pkgDir: PKG,
    platform: "linux",
    arch: "x64",
    version: "0.1.13",
    exists: (target) => tree.files.has(target) || target === path.join(APP, "node_modules", CLI_SCOPE),
    readdir: () => tree.scope,
    readFile: () => JSON.stringify(tree.manifest),
    ...extra,
  });

// ---- the tree ----
check("前提：一棵什么都不缺的打包树是绿的", treeViolations(goodTree()).length === 0, treeViolations(goodTree()).join("；"));

const noExe = goodTree();
noExe.files.delete(path.join(PKG, executableName("linux")));
check(
  "反向控制：可执行文件不在 → 点名它",
  treeViolations(noExe).some((line) => line.includes("没有可执行文件")),
  treeViolations(noExe).join("；")
);

const noIndex = goodTree();
noIndex.files.delete(path.join(APP, "out", "index.html"));
check(
  "反向控制：渲染层入口不在 → 点名它",
  treeViolations(noIndex).some((line) => line.includes("没有渲染层入口")),
  treeViolations(noIndex).join("；")
);

const noBinary = goodTree();
noBinary.files.delete(BIN);
check(
  "反向控制：本平台 CLI 二进制不在 → 点名它",
  treeViolations(noBinary).some((line) => line.includes("没有本平台的 CLI 二进制")),
  treeViolations(noBinary).join("；")
);

const extraPlatform = goodTree();
extraPlatform.scope = [cliPlatformPackage("linux", "x64"), "ocr-darwin-arm64"];
check(
  "反向控制：after-pack 没剪掉别的平台 → 点名那个包",
  treeViolations(extraPlatform).some((line) => line.includes("ocr-darwin-arm64")),
  treeViolations(extraPlatform).join("；")
);

const wrongVersion = goodTree();
wrongVersion.manifest = { version: "0.1.12" };
check(
  "反向控制：产物版本与仓里不一致 → 点名两边",
  treeViolations(wrongVersion).some((line) => line.includes("0.1.12") && line.includes("0.1.13")),
  treeViolations(wrongVersion).join("；")
);

// ---- staleness ----
check("前提：产物比源码新是绿的", stalenessViolations({ builtAt: 2000, newestSource: 1000 }).length === 0);
check(
  "反向控制：产物比源码旧 → 点名两边时间并要求重新打包",
  stalenessViolations({ builtAt: 1000, newestSource: 2000 }).some((line) => line.includes("npm run pack")),
  stalenessViolations({ builtAt: 1000, newestSource: 2000 }).join("；")
);
check(
  "反向控制：读不到产物时间戳 → 红（不是静默通过）",
  stalenessViolations({ builtAt: NaN, newestSource: 2000 }).length === 1
);

// ---- what the running app says ----
const goodInfo = {
  packaged: true,
  portable: false,
  installDir: PKG,
  binary: BIN,
  binarySource: "package",
  configPath: "/fake/home/.opencodereview/config.json",
  appVersion: "0.1.13",
};
const shape = (info) => installedShapeViolations({ info, pkgDir: PKG, home: "/fake/home", version: "0.1.13", platform: "linux" });

check("前提：安装版自报的那一份是绿的", shape(goodInfo).length === 0, shape(goodInfo).join("；"));

check(
  "反向控制：源码树那一份（packaged=false、没有安装目录）→ 两条都点名",
  (() => {
    const lines = shape({ ...goodInfo, packaged: false, installDir: "", binary: "/repo/node_modules/x/bin/opencodereview" });
    return lines.some((line) => line.includes("不是打包版")) && lines.some((line) => line.includes("安装目录"));
  })(),
  shape({ ...goodInfo, packaged: false, installDir: "", binary: "/repo/node_modules/x/bin/opencodereview" }).join("；")
);

check(
  "反向控制：CLI 落在打包树之外 → 点名路径",
  shape({ ...goodInfo, binary: "/usr/lib/node_modules/@alibaba-group/ocr-linux-x64/bin/opencodereview" }).some((line) =>
    line.includes("不在打包树里")
  )
);

check(
  "反向控制：回落到全局安装 → 点名 binarySource",
  shape({ ...goodInfo, binarySource: "global" }).some((line) => line.includes("binarySource=global"))
);

check(
  "反向控制：配置目录落在一次性档案之外 → 点名它",
  shape({ ...goodInfo, configPath: "/home/someone/.opencodereview/config.json" }).some((line) => line.includes("一次性档案之外"))
);

check(
  "反向控制：应用自报版本与仓里不一致 → 点名两边",
  shape({ ...goodInfo, appVersion: "0.1.12" }).some((line) => line.includes("0.1.12") && line.includes("0.1.13"))
);

check("反向控制：应用没有回答 app:info → 红", shape(null).length === 1);

// ---- the CLI version the app probed ----
const pinned = `${PINNED_UPSTREAM.tag} (${PINNED_UPSTREAM.sha.slice(0, 7)}) linux/amd64`;
check("前提：pin 的那一版是绿的", cliVersionViolations({ version: pinned }).length === 0, cliVersionViolations({ version: pinned }).join("；"));
check(
  "反向控制：内置 CLI 是别的 tag → 点名两边",
  cliVersionViolations({ version: "v1.13.4 (76ab46a) linux/amd64" }).some((line) => line.includes("v1.13.4") && line.includes(PINNED_UPSTREAM.tag))
);
check(
  "反向控制：同一个 tag 但 commit 不同 → 点名 commit 前缀",
  cliVersionViolations({ version: `${PINNED_UPSTREAM.tag} (deadbee) linux/amd64` }).some((line) => line.includes("commit 前缀"))
);
check("反向控制：没有版本（二进制没跑起来）→ 红", cliVersionViolations({ version: "" }).length === 1);

// ---- the wiring ----
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const read = (file) => {
  try {
    return fs.readFileSync(path.join(ROOT, file), "utf8");
  } catch (_) {
    return null;
  }
};
const closure = auditScriptClosure(pkg, read);
check(
  "接线：`audit:packaged` 存在，且 harness 在 audit 闭包里（有东西真的跑它）",
  typeof pkg.scripts["audit:packaged"] === "string" && closure.files.has("tools/e2e-packaged.mjs"),
  `audit:packaged=${JSON.stringify(pkg.scripts["audit:packaged"])}，闭包里有=${closure.files.has("tools/e2e-packaged.mjs")}`
);
check(
  "接线：本文件在 audit 闭包里（规则本身每轮都跑）",
  closure.files.has("tools/e2e-packaged-smoke.mjs"),
  "audit:packaged-rules 没有挂进 audit:static"
);
check(
  "接线：`audit:packaged` 不在 `audit:app` 里（它要一份打包产物，不能拖进普通审计）",
  !String(pkg.scripts["audit:app"] || "").includes("audit:packaged"),
  `audit:app=${pkg.scripts["audit:app"]}`
);
check(
  "接线：本平台的打包目录名有约定（否则 harness 找不到产物）",
  packagedDirCandidates("linux").includes("linux-unpacked") && packagedDirCandidates("win32").includes("win-unpacked"),
  JSON.stringify({ linux: packagedDirCandidates("linux"), win32: packagedDirCandidates("win32") })
);

const failed = results.filter((result) => !result.ok);
console.log(`\n打包产物首启的规则：${results.length} 条检查，${failed.length} 条红`);
if (failed.length) {
  console.error(failed.map((result) => `  - ${result.name}：${result.detail}`).join("\n"));
  process.exit(1);
}
