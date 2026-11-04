// `build/fetch-binaries.cjs` 里那几条决定，不下载一个字节地钉住。
//
// 为什么这一条必须存在：第 139 轮给那个脚本加了第二个来源（GitHub 的 release-asset CDN 到不了时，
// 改取 npm registry 里同一版本的那一份），并把落位改成原子写（`.part` / `.staged` 先落兄弟文件再
// rename）。那是那一轮唯一一处**没有对应 smoke 的产品面改动**——它承担的承诺是「CDN 到不了也打得包」，
// 而这条承诺由三个判断撑着：什么算「这条路答不上来」（`isTransportFailure`）、答不上来之后**先问谁**
// （`sourceOrder`）、被打断留下的残片有没有真的清掉（`clearInterruptedSiblings`）。这三条改坏了，
// 门禁里一句都不会红：打包仍然会跑，只是某一天开始把一条不通的通路当成六条都不通，或者把半截
// `.exe` 当成现成的二进制装进安装包里。
//
// 所以这里问四件事：
//   1. **require 不下载**——它是 `audit:static` 的一项的前提。真跑过一次 main() 的话，本机上
//      `@alibaba-group/open-code-review` 是在的，require 会当场开始拉几十 MB 并走进网络；所以把
//      `console.log` / `console.warn` 换成探针，要求 require 期间一个字都没印出来。
//   2. **分类的边界**——`checksum mismatch` 不许算「路不通」（字节不对是这一个目标的事，把它算成
//      通路故障，下一个目标就不再问 GitHub 了，那是把「摘要不对」悄悄变成「发未验过的字节」）；
//      而 socket 沉默、ECONN、HTTP 4xx/5xx 都必须算，否则六个目标各等满一次预算。
//   3. **残片真的被清掉**——用一次性目录里的真磁盘清一次（假 `rm` 只能证明代码要求了哪两个路径），
//      并且清它的那一句排在「这份二进制在不在」那一次问话**之前**。
//   4. **`npm pack` 那一行怎么读**——registry 这一路的文件名是从 stdout 最后一行取的；空输出、
//      带 notice 的多行输出、以别的东西结尾的输出各判一次，并且红的时候要说人话（把拿到的东西印出来）。
//
// 反向控制在本文件里两处：一处是把分类与读法的**落点**钉在源文本上（排除项必须排在分类之前、
// 「取最后一行」必须真的是 `.pop()`），一处是接线那几条（清理挪到 `existsSync` 之后就会红）。
// 跑法：`npm run audit:fetch-binaries`。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { auditScriptClosure } from "./upstream-watch.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const FETCH_SCRIPT = "build/fetch-binaries.cjs";
const require = createRequire(import.meta.url);
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "ok     " : "FAIL   "} ${name}${ok || !detail ? "" : `：${detail}`}`);
};

const source = fs.readFileSync(path.join(ROOT, FETCH_SCRIPT), "utf8");
const sourceLines = source.split(/\r?\n/);

/** 含 `needle` 的行号（1-based），按出现顺序。 */
const linesOf = (needle) => sourceLines.map((line, index) => (line.includes(needle) ? index + 1 : 0)).filter((n) => n > 0);

/** 只出现一次时给出那一行的行号，否则 `null`：顺序断言只有对「唯一那一行」才说得清是哪一行。 */
const once = (needle) => {
  const hits = linesOf(needle);
  return hits.length === 1 ? hits[0] : null;
};
const at = (needle) => once(needle) ?? -1;

/* ---- 0. 探针：require 这个文件不下载任何东西 ---- */

{
  const printed = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  let fetched = null;
  let threw = null;
  console.log = (...args) => printed.push(String(args.join(" ")));
  console.warn = (...args) => printed.push(String(args.join(" ")));
  try {
    fetched = require(path.join(ROOT, FETCH_SCRIPT));
  } catch (err) {
    threw = err;
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
  check(
    "require 这个文件不跑 main（它是静态门禁的一项；跑过一次就等于在门禁里拉几十 MB 并走进网络）",
    !threw && printed.length === 0 && fetched !== null,
    threw ? String(threw.message || threw) : `印了 ${printed.length} 行：${printed.slice(0, 2).join(" / ")}`
  );
  check(
    "...导出的就是这一文件要问的那几条判定（少一个名字，说明有一条决定没人能驱动）",
    ["isTransportFailure", "sourceOrder", "interruptedSiblings", "clearInterruptedSiblings", "tarballNameFrom", "manifestDigest", "binaryName", "buildUrl", "TARGETS", "DOWNLOAD_TIMEOUT_MS"].every(
      (name) => fetched && typeof fetched[name] !== "undefined"
    ),
    JSON.stringify(Object.keys(fetched || {}))
  );

  const {
    TARGETS,
    DOWNLOAD_TIMEOUT_MS,
    binaryName,
    buildUrl,
    clearInterruptedSiblings,
    interruptedSiblings,
    isTransportFailure,
    manifestDigest,
    sourceOrder,
    tarballNameFrom,
  } = fetched || {};

  /* ---- 1. 什么算「这条路答不上来」 ---- */

  const transportCases = [
    ["socket 沉默到超时", `no answer within ${DOWNLOAD_TIMEOUT_MS / 1000}s for https://github.com/x/y.tgz`],
    ["连接被重置", "read ECONNRESET"],
    ["连接被拒", "connect ECONNREFUSED 140.82.114.4:443"],
    ["连接超时", "connect ETIMEDOUT"],
    ["DNS 暂时解析不了", "getaddrinfo EAI_AGAIN github.com"],
    ["域名根本不存在", "getaddrinfo ENOTFOUND objects.githubusercontent.com"],
    ["到不了主机", "EHOSTUNREACH"],
    ["没有网络", "ENETUNREACH"],
    ["对端挂断", "socket hang up"],
    ["TLS 会话被切断", "socket disconnected"],
    ["握手前就断了", "disconnected before secure TLS connection was established"],
    ["对端提前关闭", "other side closed"],
    ["资产 404", "HTTP 404 for https://github.com/x/y"],
    ["CDN 5xx", "HTTP 503 for https://github.com/x/y"],
    ["小写的也算", "econnreset"],
  ];
  for (const [label, message] of transportCases) {
    check(`「${label}」算通路答不上来（剩下的目标不必各等满一次预算）`, isTransportFailure(new Error(message)) === true, message);
  }

  const notTransportCases = [
    ["下来的字节与承诺不符", "checksum mismatch (expected abc, got the downloaded bytes)"],
    ["npm pack 没报名字", 'npm pack 没有报出 tarball 名（拿到 ""）'],
    ["tarball 里没有那一条", "@alibaba-group/ocr-win32-x64 的 tarball 里没有 package/bin/opencodereview.exe"],
    ["3xx 不是失败（重定向自己有走法）", "HTTP 302 for https://github.com/x/y"],
    ["204 不算路不通", "HTTP 204 for https://github.com/x/y"],
    ["空消息什么都不说", ""],
  ];
  for (const [label, message] of notTransportCases) {
    check(`「${label}」**不**算通路答不上来（那是这一个目标的字节问题，别推广到六个）`, isTransportFailure(new Error(message)) === false, message || "（空消息）");
  }

  check(
    "一句话里同时有 checksum mismatch 与 socket hang up 时，「字节不对」这一半赢（把排除项删掉，红的就是这一格）",
    isTransportFailure(new Error("socket hang up after checksum mismatch")) === false,
    "排除项排在了分类后面，或者已经不见了"
  );
  check(
    "落点：排除那一句排在分类那一句之前，而不是靠正则里的先后碰运气",
    (() => {
      const guard = at("if (/checksum mismatch/i.test(msg)) return false;");
      const classify = at("return /no answer within|ECONN");
      return guard > 0 && classify > guard;
    })(),
    JSON.stringify({ guard: at("if (/checksum mismatch/i.test(msg)) return false;"), classify: at("return /no answer within|ECONN") })
  );
  check(
    "...非 Error 的输入也照同一个读法（字符串直接判，null / undefined 判否而不是抛）",
    isTransportFailure("read ECONNRESET") === true && isTransportFailure(null) === false && isTransportFailure(undefined) === false,
    JSON.stringify({ string: isTransportFailure("read ECONNRESET"), null: isTransportFailure(null) })
  );
  check(
    "超时那句照源码同一个拼法被认成通路故障（改了预算，红的应该是这里）",
    isTransportFailure(new Error(`no answer within ${DOWNLOAD_TIMEOUT_MS / 1000}s for x`)) === true &&
      source.includes("no answer within ${DOWNLOAD_TIMEOUT_MS / 1000}s"),
    JSON.stringify({ budget: DOWNLOAD_TIMEOUT_MS, inSource: source.includes("no answer within ${DOWNLOAD_TIMEOUT_MS / 1000}s") })
  );
  check(
    "...而一句只报「等了多久」的话不算通路故障（认的是那句话的形状，不是里面的数字）",
    isTransportFailure(new Error(`took ${DOWNLOAD_TIMEOUT_MS / 1000}s and finished`)) === false,
    "分类器开始认数字了：那会把成功的下载判成失败"
  );

  /* ---- 2. 答不上来之后，先问谁 ---- */

  check("两条路都还没试过、操作者也没指定 → 先问 GitHub（上游清单在时那条才是快路）", sourceOrder({}) === "github", sourceOrder({}));
  check("操作者指定 OCR_FETCH_PREFER_REGISTRY（或清单读不到）→ 先问 registry", sourceOrder({ preferRegistry: true }) === "registry", sourceOrder({ preferRegistry: true }));
  check("这一趟已经对 release-asset CDN 记下过一次不通 → 先问 registry", sourceOrder({ channelDown: "read ECONNRESET" }) === "registry", sourceOrder({ channelDown: "read ECONNRESET" }));
  check(
    "...那句原因是空串也算「记过一次」（记没记看有没有值，不看那句话长得好不好）",
    sourceOrder({ channelDown: "" }) === "registry",
    sourceOrder({ channelDown: "" })
  );
  check(
    "...而 checksum mismatch 不该被记成 channelDown：字节不对不改变下一个目标的顺序",
    sourceOrder({ preferRegistry: false, channelDown: null }) === "github" && isTransportFailure(new Error("checksum mismatch (expected a, got b)")) === false,
    JSON.stringify({ order: sourceOrder({ preferRegistry: false, channelDown: null }) })
  );
  check(
    "接线：fetchTarget 里那两个事实真的交给了 sourceOrder（不是又在原地写一遍 if）",
    at("sourceOrder({ preferRegistry, channelDown: releaseAssetChannelDown })") > 0,
    "找不到那一行"
  );
  check(
    "接线：channel 那个旗子只在分类判「通路答不上来」时被立起来",
    (() => {
      const guarded = at("if (isTransportFailure(err)) {");
      const assigned = at("releaseAssetChannelDown = err.message;");
      return guarded > 0 && assigned > guarded && assigned - guarded <= 8;
    })(),
    JSON.stringify({ guarded: at("if (isTransportFailure(err)) {"), assigned: at("releaseAssetChannelDown = err.message;") })
  );

  /* ---- 3. 被打断留下的残片 ---- */

  {
    const binFile = path.join("node_modules", "@alibaba-group", "ocr-win32-x64", "bin", "opencodereview.exe");
    const siblings = interruptedSiblings(binFile);
    check(
      "残片就是那两种形状：`.part`（下载一半）与 `.staged`（换文件换到一半）",
      siblings.length === 2 && siblings[0] === `${binFile}.part` && siblings[1] === `${binFile}.staged`,
      JSON.stringify(siblings)
    );

    const calls = [];
    const returned = clearInterruptedSiblings(binFile, { rm: (target, options) => calls.push({ target, options }) });
    check(
      "清的时候两个都清、各一次、都带着 `force: true`（残片不在是常态，不该为此抛错）",
      calls.length === 2 &&
        calls.every((entry) => entry.options && entry.options.force === true) &&
        JSON.stringify(calls.map((entry) => entry.target)) === JSON.stringify(siblings) &&
        JSON.stringify(returned) === JSON.stringify(siblings),
      JSON.stringify(calls)
    );

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-fetch-smoke-"));
    try {
      const binDir = path.join(scratch, "bin");
      fs.mkdirSync(binDir, { recursive: true });
      const real = path.join(binDir, "opencodereview.exe");
      fs.writeFileSync(real, "the real bytes");
      fs.writeFileSync(`${real}.part`, "half a download");
      fs.writeFileSync(`${real}.staged`, "half a swap");
      clearInterruptedSiblings(real);
      check(
        "真磁盘上：两个残片都被清掉，而**那一份二进制留着**（清的是残片，不是产物）",
        !fs.existsSync(`${real}.part`) && !fs.existsSync(`${real}.staged`) && fs.existsSync(real),
        JSON.stringify(fs.readdirSync(binDir))
      );
      let secondThrew = null;
      try {
        clearInterruptedSiblings(real);
      } catch (err) {
        secondThrew = err;
      }
      check(
        "...残片本来就不在时不抛（第二次跑与「已存在但摘要不匹配」那一条走的是同一句）",
        secondThrew === null,
        secondThrew ? String(secondThrew.message) : "抛了"
      );
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }

    const cleanup = at("clearInterruptedSiblings(binFile);");
    const exists = at("if (fs.existsSync(binFile)) {");
    check(
      "接线：清理排在「这份二进制在不在」那一次问话**之前**（挪到后面，半截 `.part` 就会被读成「已经在了」）",
      cleanup > 0 && exists > cleanup,
      JSON.stringify({ cleanup, exists })
    );
    check(
      "接线：调用点用的是默认的 rm（真的走 fs.rmSync），不是只在测试里成立的那个注入",
      cleanup > 0 && at("function clearInterruptedSiblings(binFile, { rm = fs.rmSync } = {}) {") > 0,
      JSON.stringify({ cleanup, def: at("function clearInterruptedSiblings(binFile, { rm = fs.rmSync } = {}) {") })
    );
  }

  /* ---- 4. 落位是原子的 ---- */

  {
    const partWrite = at('const part = `${dest}.part`;');
    const partRename = at("fs.renameSync(part, dest);");
    const stagedCopy = at("fs.copyFileSync(sourceFile, staged);");
    const stagedRename = at("fs.renameSync(staged, binFile);");
    check(
      "下载写到 `<dest>.part`，最后 rename——被杀的那一次不会在最终路径上留下半截 `.exe`",
      partWrite > 0 && partRename > partWrite,
      JSON.stringify({ partWrite, partRename })
    );
    check(
      "落位先 copy 到 `.staged` 再 rename 成目标名，chmod 排在 rename 之前",
      stagedCopy > 0 && stagedRename > stagedCopy && at("fs.chmodSync(staged, 0o755);") > 0,
      JSON.stringify({ stagedCopy, stagedRename, chmod: at("fs.chmodSync(staged, 0o755);") })
    );
    check(
      "...而 `.staged` 那个名字来自同一个 `interruptedSiblings`（两处说的不是两个名字）",
      at('const staged = `${binFile}.staged`;') > 0 && at('return [`${binFile}.part`, `${binFile}.staged`];') > 0,
      JSON.stringify({ staged: at('const staged = `${binFile}.staged`;'), list: at('return [`${binFile}.part`, `${binFile}.staged`];') })
    );
    const rmLines = linesOf("fs.rmSync(binFile, { force: true });");
    const mismatchThrow = at("checksum mismatch (expected ${want}, got the downloaded bytes)");
    check(
      "摘要不符时先把下载来的那一份删掉再抛（否则下一趟 `existsSync` 就读成「已有了」）",
      mismatchThrow > 0 && rmLines.length === 2 && mismatchThrow - rmLines[0] <= 4,
      JSON.stringify({ rmLines, mismatchThrow })
    );
    check(
      "...而 catch 那一支也删一次：两条路（抛错与不抛）都不许把那一份留在最终路径上",
      rmLines.length === 2 && at("warn(`${target.key}: GitHub release asset unusable") > rmLines[1],
      JSON.stringify({ rmLines, warn: at("warn(`${target.key}: GitHub release asset unusable") })
    );
  }

  /* ---- 5. `npm pack` 那行怎么读 ---- */

  {
    const name = "alibaba-group-ocr-win32-x64-1.13.5.tgz";
    check("单行输出：就是它", tarballNameFrom(`${name}\n`) === name, tarballNameFrom(`${name}\n`));
    check(
      "前面还有 notice 行的多行输出：取**最后一行**（拿第一行去跑 `tar -xzf`，要在那一步才炸）",
      tarballNameFrom(`npm notice\nnpm notice Tarball Details\n${name}\n`) === name && tarballNameFrom(`npm notice\n${name}`) === name,
      JSON.stringify([tarballNameFrom(`npm notice\nnpm notice Tarball Details\n${name}\n`), tarballNameFrom(`npm notice\n${name}`)])
    );
    let nameNotLast = null;
    try {
      tarballNameFrom(`${name}\nnpm notice\n`);
    } catch (err) {
      nameNotLast = err;
    }
    check(
      "...名字不在最后一行时抛，而不是交出一个错名字（npm 换排版就是这一格）",
      nameNotLast !== null && /npm pack 没有报出 tarball 名/.test(nameNotLast.message),
      nameNotLast ? nameNotLast.message : "没抛"
    );
    check(
      "...多行里最后一行才是真的那一份（前面粘一个同名假名字，取的必须是行尾那一条）",
      tarballNameFrom(`decoy-1.0.0.tgz\nnpm notice\n${name}`) === name,
      tarballNameFrom(`decoy-1.0.0.tgz\nnpm notice\n${name}`)
    );
    check("落点：那一行真的是 `.pop()`，不是 `.shift()` 或写死的下标", at("const tgz = text.split(/\\r?\\n/).pop();") > 0, String(at("const tgz = text.split(/\\r?\\n/).pop();")));
    check("...CRLF 的输出也一样（到得了 registry 的那一台往往就是 Windows）", tarballNameFrom(`npm notice\r\n${name}\r\n`) === name, JSON.stringify(tarballNameFrom(`npm notice\r\n${name}\r\n`)));

    for (const [label, input] of [
      ["空输出", ""],
      ["只有空白", "  \n\n"],
      ["null", null],
      ["undefined", undefined],
    ]) {
      let threw = null;
      try {
        tarballNameFrom(input);
      } catch (err) {
        threw = err;
      }
      check(
        `「${label}」判失败，而不是交一个假名字给下一步`,
        threw !== null && /npm pack 没有报出 tarball 名/.test(threw.message),
        threw ? threw.message : "没抛"
      );
    }
    let tailThrew = null;
    try {
      tarballNameFrom(`npm notice\n${name}\nnpm notice total files: 4\n`);
    } catch (err) {
      tailThrew = err;
    }
    check(
      "...最后一行不是 `.tgz` 时也算失败（npm 换了排版就是这一格的形状），并把拿到的那一句印出来",
      tailThrew !== null && /npm notice total files: 4/.test(tailThrew.message),
      tailThrew ? tailThrew.message : "没抛"
    );
    check(
      "红的时候那句要印出「拿到了什么」——空串与一句 notice 的区别，正是操作者要看的那一眼",
      (() => {
        try {
          tarballNameFrom("");
          return false;
        } catch (err) {
          return /拿到/.test(err.message);
        }
      })(),
      "句子没带拿到的东西"
    );
    check("接线：registryBinary 用的是这一个读法，不是原地再写一遍 split", at("const tgz = tarballNameFrom(listed);") > 0, "找不到那一行");
  }

  /* ---- 6. 上游 sha256sum.txt 里那一条 ---- */

  {
    const hex = "d728937efd30".padEnd(64, "0");
    const other = "a".repeat(64);
    const lines = [`${other}  opencodereview-darwin-arm64.tar.gz`, `${hex}  opencodereview-windows-amd64.exe`];
    const win = TARGETS.find((target) => target.key === "win32-x64");
    const mac = TARGETS.find((target) => target.key === "darwin-x64");
    check("认得自己那一条（按 `-${os}-${arch}` 找，不硬编码文件名）", manifestDigest(lines, win) === hex, String(manifestDigest(lines, win)));
    check(
      "...不给别家的行（darwin/amd64 与 windows/amd64 只差 os 那一段，取错就是拿别的平台的摘要验这一份）",
      manifestDigest(lines, mac) === null,
      String(manifestDigest(lines, mac))
    );
    check(
      "...大写摘要读回小写（清单那一位的写法与 `sha256` 算出来的不是一个）",
      manifestDigest([`${hex.toUpperCase()}  opencodereview-windows-amd64.exe`], win) === hex,
      "没有归一化"
    );
    check(
      "摘要不是 64 位十六进制 → 读不出（拿半截摘要去比，等于永远比不过，再把它当成 mismatch）",
      manifestDigest(["abc  opencodereview-windows-amd64.exe"], win) === null &&
        manifestDigest([`${hex.slice(0, 63)}  opencodereview-windows-amd64.exe`], win) === null,
      "畸形摘要被当成了合法值"
    );
    check(
      "清单读不到（`null` / `undefined` / 不是数组）时答「没有摘要」，而不是抛",
      manifestDigest(null, win) === null && manifestDigest(undefined, win) === null && manifestDigest("string", win) === null,
      "非数组进了 find()"
    );
    check("...而空清单也是「没有摘要」", manifestDigest([], win) === null, String(manifestDigest([], win)));
    check(
      "六个平台包各在表里，win / mac / linux 三家都在",
      TARGETS.length === 6 && ["win", "mac", "linux"].every((family) => TARGETS.some((target) => target.family === family)),
      JSON.stringify(TARGETS.map((target) => target.key))
    );
    check(
      "windows 那份的名字带 `.exe`，其余两份不带",
      binaryName("windows") === "opencodereview.exe" && binaryName("linux") === "opencodereview" && binaryName("darwin") === "opencodereview",
      binaryName("windows")
    );
    check(
      "URL 模板里的 `{version}` / `{os}` / `{arch}` 都被换成值（占位符留在 URL 上就是 404）",
      buildUrl("x/{version}/ocr-{os}-{arch}", "1.13.5", "windows", "amd64") === "x/1.13.5/ocr-windows-amd64",
      buildUrl("x/{version}/ocr-{os}-{arch}", "1.13.5", "windows", "amd64")
    );
  }

  /* ---- 7. 接线 ---- */

  {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const closure = auditScriptClosure(pkg, (file) => {
      try {
        return fs.readFileSync(path.join(ROOT, file), "utf8");
      } catch (_) {
        return null;
      }
    });
    check(
      "`npm run audit:fetch-binaries` 跑的就是本文件",
      pkg.scripts["audit:fetch-binaries"] === "node tools/fetch-binaries-smoke.mjs",
      JSON.stringify(pkg.scripts["audit:fetch-binaries"])
    );
    check("...它挂在 `audit:static` 里（静态门禁的一项，不该需要一次真下载）", String(pkg.scripts["audit:static"] || "").includes("audit:fetch-binaries"), String(pkg.scripts["audit:static"] || "").slice(0, 80));
    check("...而它不在 `audit:app` 里（那一趟要构建与浏览器，与两个来源的判断无关）", !String(pkg.scripts["audit:app"] || "").includes("audit:fetch-binaries"), String(pkg.scripts["audit:app"] || "").slice(0, 80));
    check("...本文件在 audit 的脚本闭包里（规则每轮都真跑，不是写在角落里）", closure.files.has("tools/fetch-binaries-smoke.mjs"), "闭包里没有");
    check(
      "...而 `fetch:binaries` 那条命令指着的就是本文件钉住的这一个脚本（钉的是真的那一版，不是一份同名副本）",
      pkg.scripts["fetch:binaries"] === `node ${FETCH_SCRIPT}` && fs.existsSync(path.join(ROOT, FETCH_SCRIPT)),
      JSON.stringify({ fetch: pkg.scripts["fetch:binaries"], FETCH_SCRIPT })
    );
  }
}

/* ---- summary ---- */

const failed = results.filter((result) => !result.ok);
console.log(`\n二进制来源与原子落位的规则：${results.length} 条检查，${failed.length} 条红`);
if (failed.length) {
  console.error(failed.map((result) => `  - ${result.name}：${result.detail}`).join("\n"));
  process.exit(1);
}
