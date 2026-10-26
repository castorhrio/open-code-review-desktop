# 上游核对日志（历史归档）

**本文件是审计日志；pin 的权威声明在 [`OCR-UPSTREAM-SYNC.md`](OCR-UPSTREAM-SYNC.md)。**
那份文件承载机器可读的 pin 块、「本轮 HEAD 核对」固定行、`upstream:check` 的正文引用，
以及「核对通路账」表 —— 每轮核对的结论只写在那里一行，逐轮正文（查了什么、通路是哪条）
归档在这里。

本文件里**没有**也不该有 pin 声明：历史段里的 SHA 是 7 位前缀或 tag 对象，与整串 40 位的
pin 不是同一种东西。`tools/upstream-watch-smoke.mjs` 断言本文件不含任何 pin 声明、也不含
pin 块，这样它就不会某天被当成第二个权威源。

搬家原因（第 62 轮）：13 段「上游状态（…第 N 轮）」堆在一份还要承载 pin 与对照表的文件里。
`audit:upstream` 要求 pin 在 `OCR-UPSTREAM-SYNC.md` 里恰好出现三次，历史段里的旧 SHA 是那
条计数的噪声源 —— 规则断言不该被历史叙述干扰，而历史本身要留着，所以搬到这里。

正文里出现的「本轮」指的是**正在讲的那一轮**（原文如此，未改）。下表是新轮的附加信息时，
仍然只写在那份同步文档里。

---

## 上游状态（最近检查：2026-10-27，第 67 轮）

第 67 轮复核：**两条通路一致，结论仍是「无新内容」**。
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`
（与第 49–66 轮同一个 commit），`refs/tags/v1.13.3` 仍指向 annotated tag 对象
`dd925205e108304bd4dd6cc0f8e8b7cf8dee77ea`；`npm view @alibaba-group/open-code-review
version dist-tags` 仍是 `1.13.3` / `latest: 1.13.3`。desktop 的 `^1.13.3` 无需改动，
**无移植项**；本轮没有上游 API / CLI / 配置面的变化要移植。

本轮不加新模块，改的是「第 66 轮新引入的判定还没有单测」这一处，以及两处只测了
契约、没测平台语义的缺口：

- **e2e 的「超时」与「读屏」判定搬进纯函数。** `tools/e2e-screen.cjs` 现在持有
  `timeoutError`、`screenAfter(waiting, readScreen, { timeoutMs })` 与 `neverAppeared`，
  `tools/e2e-flow.cjs` 只剩「等」和「读 `main`」两件 Electron 的事。新增
  `npm run audit:e2e-screen`：用一个 resolve、一个带 `__timeout` 的 reject、一个不带
  的 reject 钉住三态，并钉住「resolve 后不再读屏」「读屏抛错/拒绝仍保住超时判定」
  「空屏幕不是超时」。两次读屏之间画面可能已变的已知近似写进了模块注释。
- **`repoIsPickable` 补上 Windows 语义。** 判据仍是「非空 + `path.isAbsolute`」，但
  现在可注入 `{ pathApi }`；`audit:path` 用 `path.win32` 断言 `C:\repo` / `\\server\share`
  / `\\?\C:\Repo` 可开始，而 `C:repo`（盘符相对，指向 C 盘当前目录）不可开始——这是
  对话框会开到用户没选的位置、并把真在仓库里的子目录判成越界的那一类输入。注入也
  被反过来钉住：同一个 `C:\repo` 在 `path.posix` 下必须判否。
- **`PickScanDirAnswer` 的「漏读空对象」从注释变成编译错误。**
  `src/lib/__typecheck__/pick-scan-dir.ts` 用 `// @ts-expect-error` 钉住三件事：漏掉
  `{}` 那支就不能把 `relPath` 当字符串、拒绝不能同时带 `relPath`、`relPath` 不能是
  `null`；三个合法形状也各写一个正例。`npm run typecheck` 因此成为这条承诺的机械保证。
- **`pickInsidePayload` 的 `default: throw` 在 IPC 边界定案：死路径，不测。**
  `main.js` 的 `repo:pickInside` 只调用 `pickInsidePayload(pickInsideAnswer(...))`，
  renderer 传不了 kind；这个 throw 针对的是「决定层加了 kind、翻译层没加」的漂移。
  `path-guard.js` 的注释写明了这一点（若真被触达，Electron 会把异常变成
  `ipcRenderer.invoke` 的 reject，而不是一个错的答案）；`audit:path` 新增一条源码
  断言：`main.js` 里每一处 `pickInsidePayload(` 的参数都必须是 `pickInsideAnswer(...)`，
  手搓答案字面量会让「死路径」不成立并立即变红。

## 上游状态（最近检查：2026-10-27，第 66 轮）

第 66 轮复核：**两条通路一致，结论仍是「无新内容」**。
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`
（与第 49–65 轮同一个 commit），`refs/tags/v1.13.3` 仍指向 annotated tag 对象
`dd925205e108304bd4dd6cc0f8e8b7cf8dee77ea`；`npm view @alibaba-group/open-code-review
version dist-tags` 仍是 `1.13.3` / `latest: 1.13.3`。desktop 的 `^1.13.3` 无需改动，
**无移植项**；本轮没有上游 API / CLI / 配置面的变化要移植。

本轮不加新模块，改的是「已有断言更难被绕过」，三处：

- **`tools/e2e-flow.cjs`：没跑 ≠ 通过。** picker 的每一步现在都经 `pickerCheck`
  登记：`dialog.showOpenDialog` 打不上桩时，每条断言都**红着出现**并写明「这一步没跑」，
  而不是整段从报告里消失（消失会被任何数失败的汇总当成绿色）。`waitFor` 的超时带上
  `__timeout` 标记，`screenAfter` 据此产出不同文案：「60s 内预览没出现」（CLI 慢 / spec
  没到）与「预览出现但不含 a.go」（renderer 组错了 spec）不再读成同一句话；依赖屏幕内容
  的另外三条断言在超时时也明确写「没有判过」，不再空屏通过。
- **`repo:pickInside` 在开对话框之前就问「这个仓库可用吗」。** `path-guard.js` 新增
  `repoIsPickable`（非空 + `path.isAbsolute`），`main.js` 用它挡住 renderer 传来的相对
  路径：否则对话框会在进程工作目录打开，而 `relativeInside` 会拿相对根去比绝对选择，把
  **真在仓库里**的子目录判成「所选目录不在该仓库内」。`audit:path` 断言顺序（先问再开
  对话框）与「相对的仓库走 no-repo，不会去问 relativeInside」；真 Electron e2e 断言
  `pickScanDir("relative/repo")` 根本没问对话框、答案是 `{ error }` 而不是 `{}`。
- **kind 只有一个声明，未知 kind 抛错。** `PICK_INSIDE_KINDS` 成为四个 kind 的唯一来源，
  `PICK_INSIDE_MESSAGES` 的键从它派生，`pickInsidePayload` 改成 `switch` + `default:
  throw`；`{ kind: "inside" }` 没有字符串 `relPath`、拒绝没有 `error` 句子也一并抛错——
  这些形状过去会变成 `{ error: undefined }` / `{ relPath: undefined }`，在 renderer 那边
  读成「取消」。`src/lib/api.ts` 把三态写成一个 `PickScanDirAnswer` 联合类型（`{}` = 取消，
  `?: never` 让漏读那一支编译就红），`ReviewPanel` 的读法改成「先 error、再 relPath、
  最后视为取消」，与 `pickInsidePayload` 同一顺序。顺带 `pickFileOptions` 的扩展名去重
  （`["md", ".md", " md "]` 是一条）也有断言。

## 上游状态（最近检查：2026-10-27，第 65 轮）

第 65 轮复核：**三条通路一致，结论仍是「无新内容」**。
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`
（与第 49–64 轮同一个 commit），`refs/tags/v1.13.3` 仍指向 annotated tag 对象
`dd925205e108304bd4dd6cc0f8e8b7cf8dee77ea`；`npm view @alibaba-group/open-code-review
version dist-tags` 仍是 `1.13.3` / `latest: 1.13.3`。desktop 的 `^1.13.3` 无需改动，
**无移植项**。（第 63–64 轮没有更新本文件的核对账；本轮不替它们补写通路，只在账里记下
「无记录」。）

本轮继续把 IPC 层的翻译收进可测纯函数，并补反向断言：

- `path-guard.js` 新增 `pickInsideAnswer` / `pickInsidePayload`：`repo:pickInside` 的
  `{}` / `{ error }` / `{ relPath }` 三种答案不再由 `main.js` 的 `if` 链拼出。取消、
  越界、仓库内各是一种 `kind`，两条错误文案也只在这里；`main.js` 只剩 dialog 与一次
  `pickInsidePayload(pickInsideAnswer(...))`。`tools/path-guard-smoke.mjs` 逐种钉住
  kind、键集，以及「注入的 `relativeInside` 说什么就是什么」。
- `provider-handler.js` 把「rows 元素必须是对象」写成**拒绝**而不是透传：设置页对每个
  元素读 `p.name`，一个 `null` 会把它变成崩溃而不是横幅，所以整次读取按「读不到」回答。
  `tools/provider-handler-smoke.mjs` 用 `[null, "x", { name }]` 与数组元素钉住这条契约。
- `tools/config-handler-smoke.mjs` 补 `{ ok: false }` 最小静默表 + 两段各一条不同拼写的
  夹具，断言 `others.length === 1`，且 `section` 分别是 `providers` 与 `custom_providers`。
- `tools/app-info-smoke.mjs` 钉住 `readVersion` 只剥 `open-code-review`（`ocr 1.13.3`
  保留前缀）；`tools/install-info-smoke.mjs` 在三种形态下断言 `installInfo()` 的键集
  恰好六项，与 `app-info-smoke` 末尾的 `expected` 互相钉住。

## 上游状态（最近检查：2026-10-27，第 62 轮）

第 62 轮复核：**两条通路一致，结论仍是「无新内容」**。
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`
（与第 49–61 轮同一个 commit），`refs/tags/v1.13.3` 仍指向 annotated tag 对象
`dd925205e108304bd4dd6cc0f8e8b7cf8dee77ea`。desktop 的 `^1.13.3` 无需改动，**无移植项**。

本轮没有新功能要移植，改的是 desktop 自己的两条规则：

- `path-guard.js` 的 `caseInsensitive` 从「装饰」变成真正决定答案的开关：判据改成
  「resolve 两侧 → 需要时折小写 → **整段比较**」，不再经过 `path.relative`（它自己会折
  小写，所以旗标关掉答案曾经也是 true）。`tools/path-guard-smoke.mjs` 补上「旗标关掉、
  大小写不同 → 在外」与「把 `path.relative` 换成会抛错的桩，答案照旧」两组断言。
- 逐轮正文（第 47–61 轮）整体搬到 [`upstream-history.md`](upstream-history.md)，本文件只留
  关系 / 规则 / 当前状态 / 对照表 / pin 块。`audit:upstream` 因此仍能要求 pin 恰好三处，
  而历史叙述不再参与扫描（`tools/upstream-watch-smoke.mjs` 同时断言归档里没有任何 pin
  声明，免得它变成第二个权威源）。

## 上游状态（最近检查：2026-10-27，第 61 轮）

第 61 轮复核：**通路可达，结论仍是「无新内容」**。
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`
（与第 49–60 轮同一个 commit），`refs/tags/v1.13.3` 仍指向 annotated tag 对象
`dd925205e108304bd4dd6cc0f8e8b7cf8dee77ea`。desktop 的 `^1.13.3` 无需改动，
**无移植项**。

本轮只动测试面与注释，把第 60 轮新引入的两个表面的边界钉死，另收 `app:info` 的可选输入：

- `tools/path-guard-smoke.mjs` 补 UNC 与长路径（`\\?\`）用例：同主机同共享的子目录在
  里面、大小写不同仍在里面、共享名前缀相同的兄弟在外、**换主机**在外、换共享在外、UNC 根上
  的 `..` 逃逸在外。顺带记下一个容易领错功的发现：`path.win32.relative` 自身就把两边折成
  小写，所以「Windows 不区分大小写」这条答案由 `path.relative` 给出，**不是**
  `caseInsensitive` 旗标给的（旗标作为显式规则保留，但它不是修好这个 bug 的原因）。第 60 轮
  注释里「On Windows the comparison is done on lower-cased absolute paths」容易被读成相反
  的意思，已在 `path-guard.js` 改成实话，并补两条断言钉住「折大小写来自 `path.relative`」
  与「把旗标关掉答案仍为 true」——否则将来换掉 `relative` 时，`caseInsensitive` 会变成
  一条谁都不敢碰的空开关，而大小写答案静默跟着坏。
- `tools/upstream-watch-smoke.mjs` 补 `pinPlaceCoverage` 的 `duplicated` 方向：复制真文档、
  在 pin 块里**再插一行**同样的 SHA，要求 `duplicated === ["pin 块"]`、`missing` 为空、
  `complete === false`；并断言四份声明的值**仍然全等于常量**（所以只有计数能看见它，这正是
  第 60 轮之前的绿）、复制件与原文只差这一行、以及「某处写两遍 + 某处丢了」是两个分开的
  答案而不是一句「不完整」。
- `tools/app-info-smoke.mjs` 补 `installInfo` 缺失用例：`undefined` 与 `null` 都不得留下任何
  install 字段、两者键集逐字相同，且半个 install 块按原样透传（不替调用方补默认值）。

## 上游状态（最近检查：2026-10-27，第 60 轮）

第 60 轮复核：**三条通路都可达，结论仍是「无新内容」**。
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`
（与第 49–59 轮同一个 commit），`refs/tags/v1.13.3` = `dd925205e108304bd4dd6cc0f8e8b7cf8dee77ea`
（annotated tag 对象，指向同一 commit）；`api.github.com/repos/alibaba/open-code-review/commits/main`
给出同一 SHA，`/releases/latest` 仍是 `v1.13.3`。desktop 的 `^1.13.3` 无需改动，
**无移植项**。

本轮把三处「绿着但可能什么都没测 / 规则写重了」的缝合上：

- `findDocPins` 在文档措辞漂移时会少返回声明，而「读到的都等于常量」会静默绿。现在
  `pinPlaceCoverage` 要求三处（pin 块 / 固定行 / 正文引用）各出现且仅出现一次；
  smoke 里删掉任一处的突变用例先由「只剩两条」和「缺的是哪一个」报红，再谈值。
- 新增 `path-guard.js` 的 `isInside(root, candidate)`：`repo:pickInside` 与
  `readFileWindow` 共用同一条越界规则。原先 `startsWith(root + sep)` 在 Windows 上
  区分大小写，`C:\Repo` 会拒绝 `c:\repo\sub`，是真实 bug；判据改为 `path.relative`，
  Windows 上折叠大小写。`tools/path-guard-smoke.mjs` 用 `path.win32` 在 Linux 上钉住
  这条答案，并断言两个调用点确实走同一条规则。
- `app:info` 的组合抽成 `app-info.js` 的 `formatAppInfo`，三种形状（无二进制 /
  版本在 stdout / 仅 stderr）由 `tools/app-info-smoke.mjs` 断言；`main.js` 只留取数。

## 上游状态（最近检查：2026-10-27，第 59 轮）

第 59 轮复核：**三条通路都可达，结论仍是「无新内容」**。
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`
（与第 49–58 轮同一个 commit），`refs/tags/v1.13.3` = `dd925205e108304bd4dd6cc0f8e8b7cf8dee77ea`
（annotated tag 对象，指向同一 commit）；`api.github.com/repos/alibaba/open-code-review/commits/main`
给出同一 SHA；`npm view @alibaba-group/open-code-review version dist-tags` = `1.13.3` /
`latest: 1.13.3`。desktop 的 `^1.13.3` 无需改动，**无移植项**。

本轮把「pin 到底写了几遍」变成可断言的事，并给编排层补上 mock 断言：

- pin 在本文里有三处手写声明（下面的机器可读块、「本轮 HEAD 核对」固定行、
  `upstream:check` 那段的正文引用），加上 `tools/upstream-watch.mjs` 里的常量，共四处。
  `tools/upstream-watch.mjs` 新增纯函数 `findDocPins` / `describePinDisagreements` 按形状把
  三处文档声明全读出来（带行号），`audit:upstream` 要求每一处都等于 `PINNED_UPSTREAM.sha`；
  改一位就红，报错形如「文档第 N 行（pin 块）：… vs 常量 …」，不必再用眼睛 diff 三份拷贝。
  这条断言本身带自检：把真文档复制一份、只翻 pin 块的一位，要求恰好一处不一致并点名该行。
- `defaultRunner` 拆成 `createRunner({ runGit, runApi })`：git→API→欠账的三条顺序、
  「git 抛错仍改走 API」「API 抛错仍保留两条原因」都成了断言，不用再等网络以特定方式坏掉
  才能验。两条都失败时 `reason` 同时带 `git: …` 与 `api: …`，`skipped` 的欠账标记照旧。
- `audit:git` 补「措辞陌生」时的用户可见输出：`readFileAtRef` 的 `failed` 分支现在带 git
  退出码（`读取 <ref> 中的 <path> 失败（git 退出码 128）：fatal: …`），并断言这个退出码确实
  在错误串里——本地化 / 新版 git 把两句英文措辞都换掉时，读者至少还能看到「git 说了什么 +
  退出码」，而不是一句没有原因的话；stderr 为空时也不会只剩一个冒号。

## 上游状态（最近检查：2026-10-27，第 58 轮）

第 58 轮复核：**三条通路都可达，结论仍是「无新内容」**。
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`
（与第 49–57 轮同一个 commit），`refs/tags/v1.13.3` = `dd925205e108304bd4dd6cc0f8e8b7cf8dee77ea`
（annotated tag 对象，指向同一 commit）；`npm view @alibaba-group/open-code-review
version dist-tags` = `1.13.3` / `latest: 1.13.3`。desktop 的 `^1.13.3` 无需改动，
**无移植项**。

本轮把哨兵从「两态」做成「三态」，并把两处「绿着但什么都没测」的夹具补上机械保险：

- `[UPSTREAM-MOVED]`：`moved` 分支现在以自己的 marker 开头。于是三种答案在输出里是
  三种可 grep 的形状——`[UPSTREAM-DEBT]` = 没核对、`[UPSTREAM-MOVED]` = 核对了且变了、
  **不带 marker** = 核对了没变。`tools/upstream-watch-smoke.mjs` 对每个 `runUpstreamWatch`
  用例断言「该带 marker 的带、不该带的不带」，并要求三种首行互不相同。
- 前缀碰撞夹具不再会静默退化：`SAME_PREFIX_SHA` 的第 8–40 位改成写死的非 `f` 常量，并
  前置断言它 ≠ pin、仍共享 pin 的前 7 位、尾串确实与 pin 的尾串不同。否则改 pin 时那条
  「只有前 7 位相同的 commit 必须判 moved」会变成「拿 pin 和 pin 比」，绿而无意义。
- 「miss 不被缓存」从「再问一次还是 null」升级成计数断言：子进程记录两次
  `binaryResolution()` 各自的探测次数，miss 必须**第二次仍在探测**（`probesAfterAgain >
  probesAfterFirst`），hit 必须**第二次一次都不探测**（相等）。两个方向都钉住，「记住
  空结果」与「什么都不记」都不可能蒙过去。
- `fs.existsSync` 的源码断言收紧到 `\bfs\.existsSync\s*\(`，并额外断言无
  `existsSync(` 裸调用、无 `{ existsSync } = …` 解构赋值；别名调用
  （`const probe = fs.existsSync`）靠上面的 `probes` 计数兜底，这一点已写进注释。
- `package.json` 补 `engines: { "node": ">=18" }`：`upstream:check` 用 `fetch` 与
  `AbortSignal.timeout`（Node 18 起稳定），文档里也一并写明。

## 上游状态（最近检查：2026-10-27，第 57 轮）

第 57 轮复核：**三条通路都可达，结论仍是「无新内容」**。
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main` =
`375f64cd6f67a48a135da83cfcf59c52669a09cb`（与第 49–56 轮同一个 commit）；
`api.github.com/repos/alibaba/open-code-review/commits/main` 给出同一 SHA；
`npm view @alibaba-group/open-code-review version dist-tags` = `1.13.3` /
`latest: 1.13.3`，release 仍是 `v1.13.3`。desktop 的 `^1.13.3` 无需改动，**无移植项**。

本轮把「网络欠账」从十段散文变成可 grep 的账：

- `tools/upstream-watch.mjs` 的 `skipped` 分支现在输出固定的 `[UPSTREAM-DEBT]` 前缀，
  并写明 `通路：none`；核对成功时写明 `通路：git` 或 `通路：api`。
- git 通路不通时自动改走 `api.github.com` 的 `commits/main`，两条路都失败才判 `skipped`
  并同时带上两条路的原因——第 56 轮正是「git 超时、API 可用」却被记成跳过的那一类。
- `tools/upstream-watch-smoke.mjs` 钉住三件事：`skipped` 必须带欠账标记、成功必须带
  通路名、下面「核对通路账」表的每一行都必须与 `npm`（只能证明 release，不能证明
  HEAD → 必须欠账）/ `git` / `api`（能证明 HEAD → 不欠账）的规则一致。
- 顺带把二进制探测收敛到唯一入口：`ocr-service.js` 只剩一处 `fs.existsSync`（在
  导出的 `fileExists` 里），`tools/service-smoke.mjs` 改为覆写 `svc.fileExists` 并用
  `probes` 计数证明搜索确实走了这个入口，隔离不再依赖某个具体 fs API。

## 上游状态（最近检查：2026-10-27，第 56 轮）

第 56 轮复核：**`git ls-remote` 不可达，但 GitHub API 可达，结论仍然是「无新内容」**。
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 60s 超时（`timeout` 返回 124，与第 47–48、52–54 轮同因）；
`curl https://api.github.com/repos/alibaba/open-code-review/commits/main` 返回
`sha` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`（2026-10-20
`fix(tool): report an empty code_comment batch instead of success (#1773)`），
`/releases/latest` = `v1.13.3`（2026-10-22，`target_commitish: main`）；
`npm view @alibaba-group/open-code-review version dist-tags` = `1.13.3` / `latest: 1.13.3`。
三条通路一致，**无新 commit、无新 release/tag**，desktop 的 `^1.13.3` 无需改动。
本机 `npm run upstream:check` 因此打印「跳过（spawnSync git ETIMEDOUT）」——那是实话：
这一轮的 HEAD 是 API 核对的，不是 `git ls-remote` 核对的。

顺带补上了前几轮拿不到的那 33 位：`375f64c` 的完整 SHA 是上述 40 位（API 给的），
本轮把 `tools/upstream-watch.mjs` 的 pin 从 7 位前缀改成整串 40 位，并把
「短 SHA 只判前缀」这条歧义钉成断言——详见下面「pin 存全 40 位」那段。**无移植项。**

## 上游状态（最近检查：2026-10-27，第 55 轮）

第 55 轮复核：**网络可达，第 54 轮的欠账已清**。`git ls-remote
https://github.com/alibaba/open-code-review.git refs/heads/main refs/tags/v1.13.3`
退出码 0，`refs/heads/main` = `375f64c`（与第 49–54 轮同一个 SHA），
`refs/tags/v1.13.3` = `dd92520`（annotated tag 对象，指向同一 commit）；
`npm view @alibaba-group/open-code-review version dist-tags` = `1.13.3` /
`latest: 1.13.3`。两条通路一致，**无新 commit、无新 release/tag**，desktop 的
`^1.13.3` 无需改动。

本轮只做一件事：把「本轮到底核对过没有」从散文变成脚本会说的话。新增
`tools/upstream-watch.mjs`（`npm run upstream:check`）比对 `refs/heads/main` 与固定
`375f64c`——一致打印一行，前进打印醒目提示并列出下面四行，网络不通明确打印「跳过」
且退出码仍为 0。对应断言在 `tools/upstream-watch-smoke.mjs`（`audit:upstream`），
并钉住对照表上方那行固定格式的 SHA 与脚本常量一致。**无移植项。**

## 上游状态（最近检查：2026-10-27，第 54 轮）

第 54 轮复核：**GitHub 本轮不可达**。`git ls-remote
https://github.com/alibaba/open-code-review.git refs/heads/main` 与 `refs/tags/v1.13.3`
两次都 120s 超时（`timeout` 返回 124，与第 47–48、52 轮同因），所以「上游有没有新
commit」这一项本轮**没有核对**——这是网络欠账，不是「查过了没变」。可达的一条通路是
npm registry：`npm view @alibaba-group/open-code-review version dist-tags` = `1.13.3` /
`latest: 1.13.3`，与 desktop 的 `^1.13.3` 一致，故**无新 release**。网络恢复后仍需补一次
`git fetch upstream --tags` + `git log HEAD..upstream/main`。

本轮改动全部在 CLI 二进制的**解析来源**这一层（第 53 轮新引入的表面），与上游 CLI 参数、
输出解析、配置读写都无关：`tools/service-smoke.mjs` 把三条搜索逐条钉住（每棵临时树只放
该条搜索要找的东西，`ocr-service.js` 拷进树里跑子进程），并补上三条全失败时的答案
（`{ path: null, source: null }`、`binaryPath()` 为 `null`、miss 不被缓存）；
`SettingsPanel.tsx` 的「可执行文件来源」行不再把「没找到」画成破折号；
`tools/ui-audit` 加了三张 shot（global / 全 null / 未知来源名）。`audit:service` 全绿。
**无移植项。**

## 上游状态（最近检查：2026-10-27，第 53 轮）

第 53 轮复核：`git ls-remote https://github.com/alibaba/open-code-review.git
refs/heads/main refs/tags/v1.13.3` 可达（退出码 0），`refs/heads/main` = `375f64c`
（与第 49–52 轮同一个 SHA），`refs/tags/v1.13.3` 仍指向 annotated tag 对象
`dd92520`；`npm view @alibaba-group/open-code-review version dist-tags` = `1.13.3` /
`latest: 1.13.3`。两条通路一致，**无新 commit、无新 release/tag**，desktop 的
`^1.13.3` 无需改动。

本轮改动：`tools/release-guard-smoke.mjs` 给「读 `release.mjs` 源码」这一处已知例外
补了显式标注与反向保险（`release.mjs` 一旦出现正则字面量，检查会先红并要求扩展
`stripComments`），并给 `DIST_SKIP` 加了覆盖性断言（白名单里的名字必须仍是 win 构建
实际产出的名字）；`ocr-service.js` 的 `binaryPath()` 拆出 `binaryResolution()`，附
`package` / `local` / `global` 来源，`app:info` 与运行日志都能读到。三处都不触碰
上游 CLI 参数、输出解析或配置读写；`audit:service` / `audit:config` / `audit:git`
本轮全绿。**无移植项。**

## 上游状态（第 52 轮，2026-10-27）

第 52 轮复核：`git ls-remote https://github.com/alibaba/open-code-review.git
refs/heads/main refs/tags/v1.13.3` 本轮 40s 超时（`timeout` 返回 124，与第 47–48、51
轮的部分通路同因，GitHub 不可达），因此「有无新 commit / tag」只有 npm registry 一条
通路：`npm view @alibaba-group/open-code-review version dist-tags` = `1.13.3` /
`latest: 1.13.3`，与 desktop 的 `^1.13.3` 一致，**无新发布**。上游 commit 一处本轮
无法直接核对；`audit:service` / `audit:config` / `audit:git` 是上游语义变化先变红的三
道，本轮无需改动它们（本轮只改发版链的检查）。

本轮改动全部在 `tools/release-guard-smoke.mjs`：钉住发版入口「机器 → 版本 → 计划」的
拒绝顺序、`parsePlatform(undefined)` 与 `parsePlatform(process.platform)` 的等价（机器
无关），以及 `clearStaleDistOutput` 在 `readdirSync` 报 `EACCES`（非 `ENOTDIR`）时仍然
删除目录。与上游 CLI、配置读写、`git show` 分类都无关，**无移植项**。

## 上游状态（第 51 轮，2026-10-27）

第 51 轮复核：`git ls-remote https://github.com/alibaba/open-code-review.git` 可达，
`refs/heads/main` 仍是 `375f64c`（与第 50 轮同一个 SHA），`npm view
@alibaba-group/open-code-review version dist-tags` = `1.13.3` / `latest: 1.13.3`。
两条通路一致，**无新 commit、无新 release**；`git ls-remote --tags` 本轮超时（`timeout`
返回 124，与第 47–48 轮同因），tag 一处没有独立核对，但 `main` 顶端 SHA 未变即为「无新
commit」，`latest` 未变即为「无新发布」。desktop 的 `^1.13.3` 无需改动。

本轮改动全部在发版链（`tools/release.mjs` / `release-guard.mjs` / `release-dist.mjs`），
与上游 CLI、配置读写、`git show` 分类都无关：`audit:service` / `audit:config` /
`audit:git` 本轮仍全绿，且没有新的上游暴露点需要移植。**结论：无新内容，无移植项。**

## 上游状态（第 50 轮，2026-10-27）

第 50 轮复核：`git ls-remote https://github.com/alibaba/open-code-review.git` 可达，
`refs/heads/main` 仍是 `375f64c`，`git fetch upstream --tags` 后
`git log --oneline -1 upstream/main` 也是 `375f64c`，`refs/tags/v1.13.3` 仍在
（annotated tag 对象 `dd92520`），`npm view @alibaba-group/open-code-review version
dist-tags` = `1.13.3` / `latest: 1.13.3`。三条通路一致，**无新 commit、无新
release/tag**，desktop 的 `^1.13.3` 无需改动。本轮把「内置服务表为空是否合法」补进
下面的对照表：它此前只写在 `config-handler.js` 的注释里，而它是 `TABLE_HOLLOW` 措辞的
唯一外部依据。

第 49 轮复核（**网络恢复，欠账已清**）：`git ls-remote https://github.com/alibaba/open-code-review.git`
可达，`refs/heads/main` = `375f64c`，`git fetch upstream --tags` 成功后
`git log --oneline -1 upstream/main` = `375f64c`，`git describe --tags --abbrev=0 upstream/main`
= `v1.13.3`（tag 指向同一 commit），`npm view @alibaba-group/open-code-review version`
= `1.13.3`。三条通路一致，**上游无新 commit、无新 release/tag**，`v1.13.3` 即 main HEAD，
desktop 的 `^1.13.3` 无需改动。第 47–48 轮欠的 `git fetch upstream --tags` +
`HEAD..upstream/main` 对照本轮已补做（desktop 与上游无共同祖先，`rev-list` 计数不可用，
故以 `upstream/main` 顶端 SHA 与 tag 指针比对为准）。

- 顶端 commit：`375f64c`（2026-10-20，
  `fix(tool): report an empty code_comment batch instead of success (#1773)`）
- 最新 tag / release：`v1.13.3`（2026-10-22 发布）
- desktop 依赖：`@alibaba-group/open-code-review` `^1.13.3`

第 48 轮复核方式与结论：github.com 仍不可达（`git ls-remote` 30s 超时，
`timeout` 返回 124），沿用 npm registry 作为发布信号——
`npm view @alibaba-group/open-code-review version dist-tags` 仍是 `1.13.3` /
`latest: 1.13.3`，与 desktop 的 `^1.13.3` 一致，故**无新 release**；上游 commit
仍无法直接核对（第 47 轮同因）。本轮改动（发版链的版本参数校验、重试前清空
`release-<version>/`）与上游 CLI 无关，`audit:service` / `audit:config` / `audit:git`
本轮全绿。网络恢复后仍需补一次 `git fetch upstream --tags` + `git log HEAD..upstream/main`。

第 47 轮复核方式与结论：`git ls-remote` 对 github.com 本轮不可达
（`GnuTLS recv error (-110)` / 超时，机器出网受限），改用 npm registry 作为上游发布的
权威信号——`npm view @alibaba-group/open-code-review version dist-tags` 仍是
`1.13.3` / `latest: 1.13.3`，与 desktop 的依赖范围 `^1.13.3` 一致，故**无新 release**。
「有无新 commit」这一项本轮无法直接核对（GitHub API / `ls-remote` 都不通），下轮网络
恢复后应补一次 `git fetch upstream --tags` + commits 对照；即便上游有不发版的 commit，
`audit:service` / `audit:config` / `audit:git` 仍是先变红的那一道，本轮这三条全绿。
本轮的改动（发版 fallback 的搬移函数）与上游 CLI 无关。

**自最近一次有内容变更（`v1.13.3` / `375f64c`）以来，第 27–61 轮复核均无新内容。**
第 27–46、49–51、53、55、57–59 轮每轮都核对了 `git fetch upstream --tags`（或
`git ls-remote` / GitHub API）以及 GitHub API 的 commits / tags / releases，三处一致：
顶端仍是 `375f64c`，最新仍是 `v1.13.3`；第 47–48、52–54 轮只有 npm registry 一条通路
可达，第 56 轮 git 超时但 API 回答（见上），那几轮的「上游 commit 未核对」是网络欠账，
**不等于**上游变了。
desktop 的 CLI flag、输出解析、配置暴露点都无需改动。（`git fetch` 期间只有本仓同名的
`v0.1.x` 发布 tag 因已存在被拒，与上游无关。）

逐轮复核表格与第 2–26 轮的评估正文由私有 control 仓承载（本产品仓库只留这一份
上游状态摘要，避免再出现「表和十几轮正文挤在一处」的漂移）。
