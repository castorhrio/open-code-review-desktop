# 下一轮迭代

本文件记录**上游 `alibaba/open-code-review` 的状态**与**待移植项**。
规则见 [`OCR-UPSTREAM-SYNC.md`](OCR-UPSTREAM-SYNC.md)：每轮至少检查一次上游，
有更新就记在这里，不要静默忽略。

---

## 上游状态（最近检查：2026-10-26，第 9 轮复核）

上游 `alibaba/open-code-review` 自 desktop 锁定的 `v1.13.0` 之后发布了
**3 个补丁版本**：`v1.13.1` / `v1.13.2` / `v1.13.3`（共 18 个 commit）。
本轮已把 desktop 的依赖升到 `^1.13.3`（`package.json` / `package-lock.json`），
并移植了其中对封装影响最大的一个修复。

### 复核记录

| 轮次 | 日期 | 上游顶端 commit | 最新 tag / release | 结论 |
| --- | --- | --- | --- | --- |
| 2 | 2026-10-26 | `375f64c`（2026-10-20） | `v1.13.3` | 无新内容（fetch 因 `GnuTLS recv error (-110)` 失败，改用 API 核对） |
| 3 | 2026-10-26 | `375f64c`（日期未变） | `v1.13.3`（2026-10-22 发布） | 无新内容（API 核对） |
| 4 | 2026-10-26 | `375f64c` | `v1.13.3` | 无新内容（这次 `git fetch upstream --tags` 成功，与本地 ref 一致） |
| 5 | 2026-10-26 | `375f64c`（2026-10-20） | `v1.13.3`（2026-10-22 发布） | 无新内容（`git fetch` 成功 + API 双核对） |

结论：连续 8 轮没有需要移植的新功能 / 修复 / 破坏性变更，desktop 的封装（CLI flag、
输出解析、配置暴露点）无需改动。若某轮顶端 commit 仍为 `375f64c`，本表不新增行。

第 9 轮的核对方式与第 2/3 轮相同：`git fetch upstream --tags` 在这台机器的沙箱里
挂住（无输出直到超时），改用 GitHub API 核对——`commits?sha=main` 顶端仍是
`375f64c`（2026-10-20），`tags` 仍是 `v1.13.3` / `v1.13.2` / `v1.13.1`。

只是拉 tag 时会看到几条 `would clobber existing tag`（本仓也用 `v0.1.x` 编号，
与上游 tag 撞名）：那是本地 remote 的 tag 同步提示，不影响 `upstream/main` 的
提交比对，也不要 `git fetch --tags --force` 去覆盖本仓自己的 tag。

核对方式：

```bash
git fetch upstream --tags
git log --oneline v1.13.0..upstream/main
# fetch 失败时的兜底（不依赖 git 远端）
curl -s 'https://api.github.com/repos/alibaba/open-code-review/commits?sha=main&per_page=5'
curl -s 'https://api.github.com/repos/alibaba/open-code-review/tags?per_page=5'
```

---

## 本轮已移植

### P0 — `review_limit_reached`：达到上限的运行不能看起来干净

- **上游**：`v1.13.1` 的 `81df1f6`（#1678）。
- **上游改了什么**：主循环用完最后一轮工具请求（或用完 token 预算）时，任务会进
  入只提供 `code_comment` / `task_done` 的 grace round。CLI 现在会记录一条
  `review_limit_reached` 警告；零发现时，CLI 自己的 `message` 也从
  "No comments generated. Looks good to me." 改成
  "A review limit was reached before finishing; some findings may be missing."。
- **对 desktop 的影响**：desktop 的「这次审查没有提出问题」空状态原本只看评论数，
  于是把一个**被上限截断**的运行说成「代码没问题」——而这恰恰是 README 里
  「Honest run status / a truncated run never looks like a clean one」承诺不做的事。
  注意 CLI 报这种运行是 **success**（文件确实在 grace round 里完成了），
  所以除了这条新警告以外没有任何东西能把它和干净运行区分开。
- **desktop 侧改动**：
  - `src/lib/types.ts`：新增 `AgentWarning`（上游 `llmloop.AgentWarning`，
    字段 `file` / `message` / `type`），`RunResult.warnings` 从 `unknown[]` 改为
    `AgentWarning[]`。
  - `src/lib/format.ts`：新增 `runLimitReached()`，只读**结构化**信号
    （`review_limit_reached` 警告 + `summary.budget_exceeded`），
    不读 CLI 的英文散文——上游改文案不该改 desktop 的结论。
  - `src/components/ResultsPanel.tsx` / `src/components/ReportView.tsx`：
    零发现但达到上限时，空状态改为「这次审查在达到上限时停下，没有提出问题。」
    并说明「后面的文件可能没被审到」；头部在非 token 上限时标「已达审查上限」。
  - 顺带删掉 `ResultsPanel` 网格里那段**已成死代码**的「没有提出问题」副本——
    网格只在有发现时渲染，那份副本只会在两处措辞漂移。
- **验证**：`tools/ui-audit` 新增 `80-results-limit-reached` 与
  `81-report-limit-reached` 两个 shot（夹具 `?limit=1`）。两个都验证过
  **去掉修复后会 FAIL**。

### 顺带修好（上游改动，desktop 无需改代码）

- **`ocr config set` 的带点 provider 名**（`v1.13.1` `8eb8334`，#1661）：
  上游把 `SplitN(key, ".", 3)` 改成 `LastIndex(key, ".")`，所以
  `providers.my.gateway.api_key` 现在能正确拆成名字 `my.gateway` + 字段 `api_key`
  （v1.13.0 会拆错并报「invalid field」）。desktop 的自定义服务名允许带点
  （`main.js` 拼 `providers.${name}.url` 之类），所以这条修复对 desktop 是**白捡的**。
  已用 1.13.3 真机验证：`config set provider my.gateway` → 写进
  `~/.opencodereview/config.json` 的 `custom_providers["my.gateway"]` 正确。
- **scan 模式的 token 预算**（`v1.13.1` `11ac6d4`，#1745）：scan 达到 token 上限时
  `summary.budget_exceeded` 之前是 `false`（在说谎），现在正确为 `true`。
  desktop 的「已触达 token 上限」本来就读这个字段，**升级即生效**。
- **grace round 完成的文件记为可复用 checkpoint**（`v1.13.1` `81df1f6`）：
  续跑不会再重跑这些文件。desktop 的「续跑」按钮直接走 CLI 会话，无需改。

---

## 上一轮 desktop 侧加固（与上游无关，第 2 轮）

### P0 — 重开被截断的会话，在证据还在落盘时不能看起来干净

这条线从 `93f3bd8` 开始，一直在做同一件事：**被上限截断的运行不能看起来像干净
运行**。本轮补上了最后两个还是「靠约定维持」的环节。

**1）读证据时等落盘（真的堵上了那个洞）**

`run:exit` 会等证据写盘，但那个等待**有上限**（`WRITE_TIMEOUT_MS`）——store 的文件
在 profile 目录里，可能是网络挂载，太慢不能一直占着 UI。越过上限后写入仍在队列里，
而**会话重开走的是直接读文件**（`runDiagnostics.read`），于是：

> 运行刚结束 → 写盘超时（写入还在队列里）→ 用户立刻重开会话 → 读到的是**没有证据
> 的旧文件** → 被截断的会话又显示成「干净」。

这条路径之前是通的：写盘有界等待（`a855e18`）、退出冲刷（`aa1668f`）都管住了「写」
的一侧，没人管「读」的一侧。

- `run-diagnostics.js`：新增 `store.readSettled(repo, sessionId)`——先等队列停稳
  （同样有界），再读文件。队列平时是空的，等待只是一次微任务；不空的时候，这个
  等待正是让答案为真的东西。
- `main.js`：`session:diagnostics` 改用它（IPC 变成 async）。

**2）`run:exit` 与证据落盘的顺序，从注释变成事实**

之前 `main.js` 里那个顺序（「record 排在 exit 事件到达 renderer 之前」）只写在
注释里，把 `send("run:exit")` 往上挪一行就会静默失效。

- `run-diagnostics.js`：新增 `settleRunExit({ store, repo, sessionId, result, signal })`
  ——**顺序是函数自己的形状**：先落盘、再发信号，并把结果交给信号。
- `main.js`：`run:exit` 的载荷现在带 `diagnostics: { ok, reason, message }`。
  渲染层据此知道「证据到底在不在盘上」。
- `src/store.tsx`：证据没存上时（`message` 非空），在**运行日志**里说一行。stderr
  上的一行用户看不到，等于没说；`io-error` 的措辞改成含「失败」，日志抽屉会自己
  弹出来（抽屉的规则就是「看起来像麻烦」才自己开）。

**顺带**：三处等待（运行退出、退出冲刷、读等落盘）原来各写各的 `2000`，现在收敛成
一个 `WRITE_TIMEOUT_MS`。

**验证**：`tools/run-diagnostics-smoke.mjs` 新增 11 条断言——读等落盘（普通读会漏、
settled 读能看到）、等待有界（磁盘不应声就放弃）、`run:exit` 信号只在证据落盘后
发出、信号带出结果、报结果失败时信号照样发出去（结束就必须把屏幕还回去）、
慢盘不拖住退出但退出要说清证据没到、真正丢失证据时措辞能被界面显示。

`tools/ui-audit` 新增 `97-run-diagnostics-lost`（夹具 `?run=done&rundiag=1`）：
证据没存上时，运行日志必须自己说清「重开会话后将看不到这条提示」，日志抽屉也要
自己弹出来（它的规则就是「看起来像麻烦」才自己开）。**去掉修复后会 FAIL**，
三条断言同时变红。

---

## 本轮 desktop 侧加固（与上游无关，第 3 轮）

本轮不做新功能，只把两条**「靠约定维持」的边界**钉成会 FAIL 的断言，并让 store
能说出真实卷的大小写答案。

### P1 — 删除的边界：跨仓库同名 session id

「上限证据」是按**仓库 + session id** 存的。session id 本身**不跨仓库唯一**——两个
仓库里可以各有一个同名会话，各自带一条自己的截断证据。于是删除有两条路：

- 按 `session id` 删：会连带删掉**另一个仓库**的证据。那条证据是那个仓库里唯一
  记着「这次运行被截断了」的东西，删掉它，那个仓库的会话就又显示成干净的。
- 按 `仓库 + session id` 删：只删自己那条。**这是对的。**

实测：`remove` 本来就是按后者做的（`key(repo, sessionId)` 整体比较），**没有真
bug**。但这条边界此前**没有任何断言**——把它改成「只按 id 删」不会让任何测试变红。
本轮补上：

- `tools/run-diagnostics-smoke.mjs`：删掉一个仓库的会话后，另一个仓库里的同名
  session id 仍在（证据还在）。

顺带把**卷的大小写**这条轴也变成可断言的：

- `run-diagnostics.js`：`createStore(file, options)` 现在把 `options` 透传给
  `normalizeRepo`。此前 store 的 key 只吃平台默认答案，而**大小写敏感性是卷的
  属性、不是 OS 的属性**（macOS 可以按大小写敏感格式化，Linux 可以挂成大小写
  不敏感）——`normalizeRepo` 早就接受这个覆盖参数了，store 却没法用上它。
- 两个答案都在**每个**平台上被断言：折叠大小写的卷上，同一个文件夹的两种拼法
  共用一条记录，删除用另一种拼法也能删掉它；不折叠的卷上，两个目录各记各的，
  删掉一个不影响另一个。
  - 去掉 `createStore` 的透传 → **2 条断言变红**（实测）。

`main.js` 目前仍不传这个参数（走平台默认，对 Windows/macOS 是对的）。真实卷的
答案要能拿到才行，见「仍然开放的事项」。

### P1 — 读的负向路径：`readSettled` 遇上不应声的磁盘

`readSettled` 是「读侧不丢证据」的最后一块，它的**有界等待**是这个模块对调用方
唯一的承诺，也是最容易被后人改坏的地方——把 `drainBounded(...).then(...)` 写成
`drain().then(...)`，等待就没有上限了，而**没有任何断言会发现**（那会让测试自己
挂住，而不是变红）。

- `tools/run-diagnostics-smoke.mjs`：把 `fs/promises` 的 `writeFile` 临时改成
  「永不落盘」，让 store 背后的队列永不停稳，然后断言：
  - 读**给出答案**而不是挂死（去掉有界等待 → 测试挂住，被超时杀掉，实测）；
  - 等待**不早于** `WRITE_TIMEOUT_MS` 放弃（不能提前放弃，否则写其实还有机会
    落盘，提前读到的就是旧数据）；
  - 放弃之后**回答盘上已有的证据**，而不是 `null`——重开一次会话问的就是上一次
    运行的证据，答 `null` 等于说「上次没被截断」。

**验证**：4 个失败模式都实测过会让断言变红或让测试挂住——去掉 `createStore` 的
透传（2 条红）、去掉 `readSettled` 的有界等待（测试挂住）、把 `remove` 改成只按
id 删（2 条红）、超时后返回 `null`（1 条红）。

---

## 本轮 desktop 侧加固（与上游无关，第 4 轮）

本轮做两件事：把 store 的「卷大小写」那条线**接到真实卷的答案**（上轮留下的
P0），以及给两条**静默降级**的兜底分支补断言（分类逻辑一行未改）。

### P0 — store 的大小写：问卷，而不是问操作系统

上轮 `createStore` 已经能接住 `options.caseInsensitive`，但 `main.js` 建 store 时
仍走**平台默认**。平台默认是个猜测：macOS 可以把卷格式化成**大小写敏感**，Linux
可以把卷挂成**大小写不敏感**——两个方向都猜错。于是「被截断的运行不能看起来
干净」这条承诺，在一个按大小写敏感格式化的 macOS 卷上仍然会被破坏：两个只差
大小写的目录会被并成一条证据，或者反过来，找不到自己那条。

**问哪里的卷？** 这里和上轮简报里的建议不一样，值得记一笔：简报建议在
`userData` 目录里写探针文件。但 **store 的 key 是「仓库路径」，不是 profile
路径**——`normalizeRepo` 处理的是用户选的仓库目录，profile 卷的大小写与它无关。
更糟的是，在 macOS 上答案通常正好是错的：系统盘是大小写不敏感的（所以
`userData` 说「折叠」），而开发者格式化工作盘时往往**只格式化外置盘**，仓库在
外置盘上（大小写敏感）——问 profile 卷得到的正是**相反**的答案。

所以本轮改成：**问仓库自己的路径，而且不写任何东西**。

- `run-diagnostics.js` 新增 `detectCaseInsensitive(target, options)`：
  把路径里**最深的那一段带字母的**名字换一种拼法（`Payments-API` →
  `PAYMENTS-API`），然后 `stat` 两个拼法，比对 `dev`/`ino`：
  - 同一个 inode → 卷折叠大小写；
  - 另一个 inode（两个只差大小写的目录真的都在）→ 卷**不**折叠；
  - 另一种拼法**根本不存在** → 卷不折叠；
  - 路径读不到（仓库被删了）→ **答不出来**（`null`），交给平台默认。
- **不写文件**是刻意的：路径通常是用户自己的工作树，在里面留一个探针文件比
  猜错更糟。探针只 `stat`，不写。
- `createCaseDetector(options)`：每个路径只问一次。一份证据文件有上百条记录，
  仓库又常在网络盘上，每条都问一遍就是上百次往返。
- `createAppStore(file, options)`：**app 真正用的那个 store** 从这里建，探测
  逻辑收在一个地方，检查够得着；`main.js` 只剩一行调用。
- `main.js`：`createRunDiagnostics(...)` → `createAppStore(...)`。

**三个来源，一个顺序**（`resolveCaseInsensitive`）：显式答案 → 卷的答案 → 平台
的答案。卷**答不出来**时退回平台默认，**不是**当成「大小写敏感」——反过来读，
一个问不出答案的探针会**弄丢**折叠大小写的卷上的每一条证据，正是这个 store
存在的理由所要防的那件事。

**顺带修好一个升级期的洞**：早期 build 用平台默认建 key，在大小写敏感的 macOS
卷上它把目录**转成了小写**存进文件；新 build 按卷的答案（保留大小写）建 key，
那条旧记录就找不到了——重开那个会话又会显示成「干净」。所以 store 现在**两个
key 都查**（`keysFor`）：卷的答案，和早期 build 的答案。

**验证**：`tools/run-diagnostics-smoke.mjs` 新增 22 条断言，覆盖两种卷的答案、
答不出来时的退回、显式答案的优先级、只问一次、探针与真实文件系统的一致性、
app 自己的 store 走的是「问卷」那条路，以及升级期旧记录仍能找到、仍能删。

失败模式逐条实测过会让断言变红（9 个）：不把探测器交给 store（1 条）、`main.js`
自己建 store（1 条）、探针把答案读反（2 条）、答不出来当成大小写敏感（3 条）、
不缓存探测（1 条）、忽略平台答案（5 条）、路径不存在也判（1 条）、存进去的
repo 不规范化（1 条）、不查早期 build 的 key（1 条）。

### P1 — 未知措辞的兜底分支，各配一条断言

两条分类都靠**外部的措辞**：`readFileAtRef` 靠 git 的 stderr 分
`bad-ref` / `missing` / `failed`，`spawnFailure` 靠 `err.code` 分。措辞不是本程序
的：本地化的 git、换版本的 git、上游改文案，都会让某个分支再也走不到——而**没有
任何断言会发现**，只是分类悄悄变了。

- `tools/git-service-smoke.mjs`：在**不是仓库**的目录里读一次（git 的话是
  `fatal: not a git repository`，两种已知措辞都不匹配），断言落到 `failed`，
  而且消息里保留 git 自己的原话。
- `tools/service-smoke.mjs`：`spawnFailure` 原来**根本没有导出**，所以这个分支
  一条断言也没有。本轮把它导出（纯函数，无行为变化），并断言三种情形：二进制
  不在、仓库目录不在、以及**两者都在**时保留原始消息（而不是硬说「找不到可
  执行文件」——那会把用户引到错的东西上）。

分类逻辑一行未改。

---

## 本轮 desktop 侧加固（与上游无关，第 5 轮）

本轮把上轮简报里「配置就绪判定」那条线**对到上游源码**上，并把 `MAX_ENTRIES`
那条注释**变成会 FAIL 的断言**。上游本轮无新提交（顶端仍是 `375f64c` / `v1.13.3`），
所以下面每一条都是「读上游源码 → 改 desktop → 用断言钉住」。

### P0 — 模型名：两种形态读的是**不同的键**

上轮简报问的是「上游在 provider 形态下是否读顶层 `raw.model`」。**读了**，而且
读的地方和简报猜的相反——所以 `|| raw.model` 不是「漏了 llm 形态才该有」，而是
**两处都算错了**。`internal/llm/resolver.go` @ `v1.13.3`：

- **provider 形态**（`tryProviderConfig`）：先读顶层的 `model`（`cfg.Model`），再用
  条目自己的 `model` 覆盖它；`llm` 段**完全不读**。
- **legacy 形态**（`tryLegacyLlmConfig`）：**只**读 `llm.model`；顶层的 `model`
  **不读**——而 `ocr config set model X`（没有 provider 时）写的正是顶层那个键。
- **环境变量只在 legacy 形态补模型**：provider 形态压根不看 `OCR_LLM_MODEL`，而且
  provider 缺模型是**硬错误**（`provider %q has no model configured`），不是
  「下一个解析策略能补上」。

desktop 此前把四种键混在一起数、不分形态，于是两种配置被说成「已就绪」，而 CLI
当场拒绝：

| 配置 | desktop 此前 | 上游实际 |
| --- | --- | --- |
| legacy 形态，只有顶层 `model` | 已就绪 | `no valid LLM endpoint configured` |
| provider 形态，模型只在环境变量里 | 已就绪 | `provider ... has no model configured` |

- **改动**（`ocr-service.js`）：`hasModel` 逐形态对齐上游；`view.model` 也改成
  **真正会被发出去的那一个**（provider 形态：条目自己的 `model` 优先、顶层兜底；
  legacy 形态：`llm.model`）。顺带修掉一个显示错位：切换服务时顶层 `model` 还是
  上一个服务的，顶栏却按顶层显示——现在按上游的优先级显示。
- **验证**：`tools/service-smoke.mjs` 新增 6 条断言。其中 4 条**去掉修复就会 FAIL**
  （实测）：legacy 形态的顶层 `model`、provider 形态的环境变量模型、provider 形态
  的 `llm.model`、以及显示的模型不是有效模型；另 2 条是防回退的（顶层 `model`
  在 provider 形态算数、条目 `model` 优先）。新形态也进了「ready 与 missing 必须
  同意」那条不变量。

### P0 — `MAX_ENTRIES` 的全局裁剪：把注释变成断言

上轮简报说这条注释「没写明是全局上限」——注释上一轮已经写清了（`run-diagnostics.js`
第 27–43 行），缺的是**断言**：从**一个**仓库看，per-repo 上限和全局上限长得
一模一样，只有**两个仓库**才分得开。

- `tools/run-diagnostics-smoke.mjs`：两个仓库交替写 `MAX_ENTRIES + 1` 条，断言
  文件里是 `MAX_ENTRIES` 条、两个仓库**共用**一个预算（各自都不到上限）、
  **第一个仓库最老的那条**被淘汰（per-repo 上限下它会活下来）、存活的是
  **全局尾巴**且写入顺序不变。
- **验证**：把裁剪改成 per-repo → **4 条断言变红**（实测）。

### 当时仍然开放（第 5 轮结束时的两条，第 6 轮都收了）

> 下面两条在第 6 轮收掉了，正文保留是因为它们记着**判据是什么**——尤其第一条：
> 缺的不是脚手架，而是 `custom_providers` 那一次查找。详见「第 6 轮」一节。

- **P1 — `presetEntry` 还有一个乐观分支**：手改配置把**自定义名**放进 `providers`
  段（缺 url）时，desktop 判定 ready。上游的判据是**内置服务注册表**
  （`llm.LookupProvider`，大小写不敏感）：不在表里的名字，上游根本不去 `providers`
  段找，而是去 `custom_providers` 段找 → 找不到 → 直接报错
  `provider %q is set but not configured in custom_providers section`。所以那份配置
  是被 CLI **整个拒绝**的，不是「缺一个 baseUrl」——把它算成 `missing: baseUrl`
  反而是**说错了原因**。desktop 要判准这件事，得把内置服务名单带进主进程
  （`ocr llm providers`），不是改一行表达式。
- **P1 — provider 形态下端点与 Key 仍会数环境变量**：`OCR_LLM_URL` /
  `ANTHROPIC_BASE_URL` 在 provider 形态下**不会**被读（端点只来自条目或内置服务
  表）；`OCR_LLM_TOKEN` 同样不会，Key 只有**内置服务自己的**环境变量（如 anthropic
  的 `ANTHROPIC_API_KEY`）才算数。这两处仍偏乐观，和上面的 `hasModel` 是同一类
  问题，本轮只收了模型这一维。

---

## 本轮 desktop 侧加固（与上游无关，第 6 轮）

上游顶端仍是 `375f64c` / `v1.13.3`（第 6 轮复核，无新提交）。本轮把上一轮留下的
「`rejectedProvider` 分支」接完——缺的不是脚手架，是上游那半个判据。

### P0 — 被判拒的服务名：缺的是 `custom_providers` 那一次查找

`tryProviderConfig`（`internal/llm/resolver.go` @ `v1.13.3`）按**名字**选段：

```go
preset, isPreset := LookupProvider(cfg.Provider)
if isPreset {
    entry, ok = cfg.Providers[cfg.Provider]
} else {
    entry, ok = cfg.CustomProviders[cfg.Provider]
}
if !ok {
    return ResolvedEndpoint{}, false, fmt.Errorf("provider %q is set but not configured in %s section", cfg.Provider, section)
}
```

上一轮只判了「名字在 `providers` 段但不在内置名单里」这一种。剩下两种仍然说错话：

| 配置 | 上周的 desktop | 上游 | 现在 |
| --- | --- | --- | --- |
| 同名条目同时出现在 `providers` 和 `custom_providers` | 判拒绝（理由是「没有 custom_providers 条目」） | 读 `custom_providers`，配置能跑 | ready，字段取自 custom 条目 |
| `provider` 指向的名字两个段都没有 | `missing: baseUrl,model,credential` | `provider %q is set but not configured in custom_providers section` | `missing: provider` |

第一类是把**能用**的配置说成整份被拒；第二类是让用户去填一个填了也不生效的字段。

改动（`ocr-service.js` 的 `readConfigView`）：

- **`registryHit` 与 `knownPreset` 拆开**：「名字在内置名单里」和「名字 + `providers`
  条目都在」是两个问题。环境变量那一段问的是前者（`owner` 归属），条目取哪一段问
  的也是前者；`presetEntry` 仍问后者（内置服务只在有条目时才有端点）。
- **`entry` 按名字选段**：`registryHit` 读 `providers`，其余名字读
  `custom_providers`——stray 条目不再借出端点、Key 或 model。注册表读不到时两份
  都试，保持旧的宽松读法。
- **`rejectedProvider` 加一个条件 `!customEntry`**：名字在 `custom_providers` 里有
  条目时，那份条目正是 CLI 会读的，不该判拒。

**验证**：`tools/service-smoke.mjs` 新增 6 条断言（同名两段仍 ready、字段取 custom
条目、stray 条目不借端点/Key、两段都没有 → `missing: provider`、注册表读不到时不
误拒、以及 `owner` 维度在 legacy 形态下的反向断言）。其中 **4 条去掉修复就 FAIL**
（实测：stray 同名两条、shadowed 端点一条、两段都没有一条）。

---

## 本轮 desktop 侧加固（与上游无关，第 7 轮）

上游顶端仍是 `375f64c` / `v1.13.3`（第 7 轮复核，`git fetch` + GitHub API 双核对），
所以本轮不改封装面，只把「保存的 Key 属于哪一条服务条目」这条规则**从猜测改成上游
的判据**。上一轮简报里的两条 P1（`presetEntry` 的乐观分支、provider 形态下端点/Key
数环境变量）在第 6 轮就已收掉，断言在 `tools/service-smoke.mjs` 里；本轮只补了
`entryByName` 这一处。

### P2 — 大小写变体同时存在时，取哪一条：`provider` 自己说了算

`providers` 段里同时有 `DeepSeek` 和 `deepseek` 时，desktop 一直取**全小写**那条，
依据只写在注释里（「`ocr llm providers` 打印的就是小写」）。**读了上游，这条依据
站不住**——`internal/llm/resolver.go` @ `v1.13.3` 的 `tryProviderConfig`：

```go
preset, isPreset := LookupProvider(cfg.Provider)   // 只有这一步折叠大小写
if isPreset { entry, ok = cfg.Providers[cfg.Provider] } else { ... }
```

`cfg.Providers[cfg.Provider]` 用的是配置里 `provider` 字段的**原始字符串**，不是注册表
返回的规范名（`LookupProvider` 只在 `providers.go` 里做 `strings.ToLower` 查表，
`cfg.Provider` 本身没被改写）。所以哪一条会被 `ocr` 打开，答案在配置文件自己手里；
小写那条只在「恰好与 `provider` 一致」时才是对的。判错的方向是把**另一条**的 Key
交给「测试连通」，设置页于是拿着本次运行不会用的 Key 去测（例：`provider: DeepSeek`
时上游读 `providers["DeepSeek"]`，desktop 说复用的是 `providers["deepseek"]` 的 Key）。

- **改动**（`ocr-service.js` 的 `entryByName`）：变体的取舍顺序改成
  ①配置 `provider` 字段点名的那条 → ②注册表拼法（`ocr llm providers` 打印的小写
  形式，表单通常就是它的写法）→ ③文件里的第一条。精确命中仍然优先于任何变体
  （这条没动：跨段同名时精确命中另一段仍是用户的意图）。
- **验证**：`tools/service-smoke.mjs` 新增 3 条断言——`provider: DeepSeek` +
  `providers` 两条变体、`provider: deepseek` + 两条变体（反向）、没有 `provider`
  可依时退回注册表拼法。第一条**去掉修复就 FAIL**（实测变成 `sk-lower`）。

---

## 本轮 desktop 侧加固（与上游无关，第 8 轮）

> 这一节是补记的：第 8 轮的代码（`6809a1d` … `9b60c87`，十个提交）早已落地，
> 正文却一直没写，所以「文档落后于代码」这件事本身，把下一轮的上游复核也带偏了。

上游顶端仍是 `375f64c` / `v1.13.3`（无新提交）。本轮把「保存的 Key 属于哪一条服务
条目」这条判定从渲染层搬进主进程：**判定与措辞同处一地**，设置页不再自己猜端点、
自己编句子。

### 落地的东西

- `ocr-service.js` 的 `entryByName`：四条匹配规则（精确 / 配置自己的 `provider` /
  注册表拼法 / 文件顺序），每条都带名字。四条规则是一条 `if/else` 链，所以**顺序就是
  语义**——把一条挪到另一条下面，不会有任何测试变红，只会悄悄换一个条目。规则常量
  与函数一并导出，`tools/service-smoke.mjs` 逐条断言「是哪条规则答的」。
- `ocr-service.js` 的 `savedKeyLookup`：六种扣下 Key 的原因（`config-unreadable` /
  `no-entry` / `order-guess` / `url-mismatch` / `no-key` / `table-unavailable`），外加
  一个**保守的默认值**：没说读过内置服务表，就当没读过（早先的默认是「读过，但表里
  没有」——那会把 Key 交给表单上任何一个地址）。
- `main.js` 新增 `config:savedKey` 通道；`SettingsPanel.tsx` 改为呈现主进程给出的原因，
  措辞由 `savedKeyFieldHint` / `savedKeyTestMessage` 生成（两种说法、六种原因各自一句）。

### 这一轮的判定链，两端还没有对到一起

判定链是三段：**主进程算端点 → 主进程比对 Key 的归属 → 渲染层显示同一个端点**。
第 8 轮把前两段搬进了主进程，第三段还在渲染层里自己算——而且算的是**反过来的
优先级**（详见第 9 轮）。当时没有任何断言看着这一段，所以它可以一直错着。

---

## 本轮 desktop 侧加固（与上游无关，第 9 轮）

上游顶端仍是 `375f64c` / `v1.13.3`（第 9 轮复核，GitHub API 核对；`git fetch` 在
沙箱里挂住）。本轮只做一件事：**把上一轮那套判定真正接到屏幕上**，并把它依赖的两条
接缝钉成会 FAIL 的断言。

### P0 — 六种扣 Key 原因，一句也没到过屏幕

`preload.js` 的 `savedKey` 收**两个位置参数**并自己拼成对象：

```js
savedKey: (name, url) => ipcRenderer.invoke("config:savedKey", { name, url }),
```

而接口（`src/lib/api.ts`）与渲染层（`SettingsPanel.tsx`）给的是**一个对象**：
`api.savedKey({ name, url })`。于是主进程收到的是 `name = { name, url }`——一个
对象。`entryByName` 拿它去查表，`String(name).toLowerCase()` 得到 `"[object object]"`,
什么也查不到，于是**每一个服务**都落到 `no-entry`：

```
改之前 : {"key":"","reason":"no-entry"}
改之后 : {"key":"sk-deep","reason":""}
当时的说法: 该服务还没有已保存的 Key，留空保存不会写入 Key。
```

第 8 轮那套「六种原因各有一句话」的机制，就这样一句也没到过屏幕——设置页永远显示
「该服务还没有已保存的 Key」，而这正是它当初要取代的那句话。

**为什么没有任何检查发现**：`tools/bridge-contract.mjs` 只比对了**方法名**（声明的
方法是否都在 preload 上、preload 上的方法是否都声明了），没有比对**参数形状**。

- **改动**（`preload.js`）：`savedKey: (req) => ipcRenderer.invoke("config:savedKey", req)`。
- **验证**（`tools/bridge-contract.mjs`）：新增两条检查——
  1. **参数个数**：接口声明几个参数，preload 就该收几个（`savedKey` 原来接口 1 个、
     preload 2 个）。
  2. **值的去处**：拿一个探针去调每个方法，看渲染层传出去的值**是不是以接口给的名字
     原样到了主进程**（不是被再包一层塞进别的键里）。
  两条都实测过：把 preload 改回旧写法 → 两条同时变红（`savedKey: the interface
  declares 1, the preload takes 2` / `2 of the values the caller sent never arrive
  under the interface's names`）。

### P0 — 判定链的两端：端点只有一个来源

第 8 轮留下的那半段接缝，本轮收掉。端点的优先级以前是**反的**：

- 主进程（`savedKeyLookup`）：条目的 `url` 优先，表里的端点兜底——**和 CLI 一致**
  （`url = preset.BaseURL; if entry.URL != "" { url = entry.URL }`，
  `internal/llm/resolver.go` @ `v1.13.3`）。
- 渲染层（`SettingsPanel.tsx`）：**表里的端点优先**，条目的 `url` 兜底。

于是一条自带端点的条目（公司网关、代理）会让设置页指向一个 CLI 永远不会用的主机：
「测试连通」把 Key 发到那儿，而真正跑审查时 Key 走的是另一台；同时那条 Key 又被判成
「属于另一个端点」而扣下——两处都错，方向还相反。

- **改动**：
  - `ocr-service.js` 新增 `serviceEndpoint(entry, presetUrl)`：**一条规则**，两个调用方
    （配置视图算给渲染层看的端点，`savedKeyLookup` 比对 Key 归属时用它）。
  - `readConfigView` 的视图多带一个 `endpoints`：名字 → 该服务解析出来的端点。渲染层
    不再自己算，只读这个。
  - `SettingsPanel.tsx`：`const endpoint = isCustomTarget ? customUrl : config.endpoints[name]`。
- **验证**（`tools/service-smoke.mjs`）：同一份 config + 同一张表，断言**视图给渲染层
  的端点**与 **`savedKeyLookup` 实际用的端点**相等；断言「条目自带端点时，条目赢过表」
  （把 `serviceEndpoint` 的两个来源调换顺序 → 5 条断言变红，实测）。

### P0 — `tableUnavailable` × `presetUrl` 的组合，逐条钉住

三种输入（条目自己的 url、表里这一行的 url、表能不能读到）各有各的答案，答案之间
**不能互换**——为错的原因扣下 Key，会把用户送去修一个没坏的东西。

| 形状 | 答案 |
| --- | --- |
| 表能读 + 条目没有 url | 表里的 url 就是那台主机 |
| 表能读 + 条目有 url | 条目的 url 是那台主机；表里的 url 是**另一台** |
| 表读不到 + 条目没有 url | 主机未知 → `table-unavailable` |
| 表读不到 + 条目有 url | 条目的 url 仍然是那台主机 |

以及「名字根本不在表里」——那是自定义服务，表对它无话可说，端点只能来自条目自己；
条目没写 url 就是**没有主机**，Key 不交给任何主机。这一条报的是 `url-mismatch`：
从表单这一侧看，两种情况说的是同一件事（Key 不会发到这个表单指的地址），修法也是
同一个（把 Base URL 填上，或把 Key 重新填一遍）。

还有一件表的状态替所有人决定的事：**CLI 读哪一段**（`tryProviderConfig` 按名字选段：
内置名读 `providers`，其余读 `custom_providers`）。所以表读不到时，连自定义服务读哪
一段都是未知的——这就是自定义服务在表读不到时也报 `table-unavailable` 的原因。

**验证**（`tools/service-smoke.mjs`）：上表的四种组合 + 自定义服务的三种形状，逐条
断言「原因」与「端点」两个值。

### P1 — `config:savedKey` 的回答带上表的状态

`config:savedKey` 现在回 `{ ok, available, reason, hint, endpoint, tableOk }`：
`endpoint` 是这次判定用的主机（与视图里的 `endpoints` 同源），`tableOk` 说内置服务表
这次能不能读到。设置页那条「读不到内置服务名单」的横幅改用**同一个回答**里的
`tableOk`——横幅与 Key 提示于是不会各说各话（一个说读到了、一个说读不到）。

---


## 待移植 / 待验证

### 已完成 — `manifest.run_failure` 的中文映射与展示

**状态（2026-10-26）**：**全部做完，别再重复实现**。

- 失败原因的**中文映射已实现**（`bf065b5`，`src/lib/format.ts` 的
  `RUN_FAILURE_LABEL` / `ITEM_FAILURE_LABEL`，两套词表由 `tools/service-smoke.mjs`
  逐值断言）。
- **报告页已摆出 `run_failure.reason`**（`f884499`）：`finding.tsx` 新增
  `RunFailureNotice`，结果页与报告页都写出一行失败原因；分类是本程序自己的句子，
  CLI 的原话标成「CLI 原始原因」并保持可选中。
- **`CoverageItem.classification` 也从 tooltip 提成了可见文本**（同一个提交）：
  未审/跳过行现在直接显示中文分类，CLI 的原话挪到该行 tooltip，并按去重后在行
  下方写出一次。

上游的 `RunManifest` 有 `run_failure: { classification, reason }`，它会把
`terminal_state` 强制成 `failed`。desktop 此前只显示一个红色「失败」徽章，
**不显示失败原因**——用户知道失败了，但不知道为什么；这一刀已经补上。

**词表（2026-10-25 复核，`internal/session/manifest.go` @ `v1.13.3`）**——上游是
**两个**枚举，不是一份：

- `RunFailureClass`（`manifest.run_failure.classification`，7 个）：
  `input / configuration / timeout / cancelled / budget / internal / unknown`
- `FailureClass`（`coverage.failed[].classification`，8 个）：
  `provider / timeout / cancelled / configuration / input / budget / panic / unknown`

本文档此前把 run-level 一段写成了 8 值的那一份（含 `provider` / `panic`），
是把两个枚举当成一个读了。真源已写进 `src/lib/types.ts` 的 `run_failure` 注释，
两套映射（`RUN_FAILURE_LABEL` / `ITEM_FAILURE_LABEL`）由
`tools/service-smoke.mjs` 逐值断言，上游新增分类会让 `audit:service` 变红。

> 注意：`run_failure` 在 `v1.13.0` 就已经存在，不是这三个版本带来的；
> 只是这三个版本让「预算截断」更常出现，把它暴露得更明显了。

### P1 — `ocr scan --path` 的行为变更（`v1.13.2` `27def86`，#1709）

`--path` 现在按文件系统解析，**不存在的路径是错误**，而不是静默选中 0 个文件并
`exit 0`；大小写写错在大小写敏感的文件系统上也是错误。
desktop 在 scan 模式暴露 `--path`（`ocr-service.js` 的 `path` flag）。

对 desktop 是改善（以前静默空扫描，现在 CLI 会报错）；desktop 侧**已修复并验证**
（`293c891`）：`scan --path` 指向不存在的路径时，预览/「开始审查」会把 CLI 的报错
落成中文提示，而不是渲染成一个空的文件列表。此项关闭，无需再验证。

### P1 — 空 code_comment 批次现在算工具失败（`v1.13.3` `375f64c`，#1773）

CLI 之前把空的 `code_comment` 批次报成成功，现在报成错误。
desktop 的「工具调用 N（失败 M）」直接读 CLI 的 `tool_calls.failure`，数字会更诚实，
**无需改代码**；但 `audit:service` 的夹具里没有空批次场景，可以补一条。

### P2 — CLI 侧的新语言 / 规则（`v1.13.2`）

- `1325261` Shader Languages、`6d68b1a` Nushell、`46790d9` PowerShell 审查规则、
  `9867a3d` OpenTofu 的 `.tofu` 扩展名。

这些都进的是 CLI 自己的 allowlist / rules。desktop 不暴露语言清单，
**无需改动**；但 README 的「Features」表目前没提语言支持，若要宣传需要另行确认口径。

### 与 desktop 无关

- `ea5ced2` / `d73c9d3` 依赖安全更新、`b842659` grpc 升级
- `410ddb8` MCP `tools/list` 分页（desktop 不暴露 MCP 配置）
- `313519f` NixPkgs 的 `pkgs/` provider 目录
- `55450a9` / `c0d623a` 上游 CI 的 PR 策略

---

## 仍然开放的事项（非上游）

第 5 轮收了「模型名按形态对齐上游」与「`MAX_ENTRIES` 全局裁剪」，第 6 轮收了
「按名字选配置段」，第 7 轮收了 `entryByName` 的变体取舍，第 8 轮把 Key 归属判定搬进
主进程，第 9 轮把这条判定真正接到屏幕上并收掉端点那一端；剩下的按优先级排在这里，
下一轮挑。标注「**未动**」的条目是最近一轮看过、确认仍然成立但没有改的——不是新发现。

- **P1**：`entryByName` 的「精确命中优先」与上游的「按名字选段」在**同名跨段**时
  不一致。`tryProviderConfig` 先查注册表决定读 `providers` 还是 `custom_providers`，
  然后用配置里的原始字符串去读那一段；而 `entryByName` 是 `providers[name] ||
  custom_providers[name]`，所以一个**自定义名**同时被手改进 `providers` 段时，desktop
  会拿 `providers` 那条（CLI 不会读的）里的 Key。第 6 轮的 `readConfigView` 已经按段
  读，`entryByName` 还没跟上——它缺的是注册表，所以要么把注册表传进去，要么让调用方
  先判段。文件 `ocr-service.js`。——**本轮发现，未动**。
- **P1**：「条目没有写端点」与「Key 属于另一个端点」现在共用 `url-mismatch` 一句话
  （「已保存的 Key 属于另一个端点」）。对前者这句话其实不准确——那条记录谁也没写
  端点，Key 不属于任何端点。修法有两条：加第 7 种原因（措辞表、语气表、UI 夹具、
  本文档的「六种」都要跟着改），或者把这句话改成两种都成立的写法。第 9 轮把这条
  行为**钉住**并在 `tools/service-smoke.mjs` 的注释里写清它指的是什么，但没改措辞。
- **P2**：渲染层那一端（设置页把哪个端点发给主进程）现在没有断言看着——它只做一次
  查表（`config.endpoints[name]`），没有自己的规则，但**万一**有人把优先级写回去，
  `tools/service-smoke.mjs` 看不见（它测的是主进程那两端）。第 9 轮留下的形状是：
  渲染层不再有规则可写错，但也没有一条断言能证明这一点。文件
  `src/components/SettingsPanel.tsx`。
- **P2**：`writeAll` 的 Windows 回退分支里 `unlink(tmp)` 失败被吞掉，进程立刻退出
  会留下 `*.tmp` 垃圾。文件 `run-diagnostics.js`。——**未动**。改成把失败记进
  outcome。
- **P3**：`finding.tsx` 的 `RunFailureNote`（只显示 tooltip）与 `RunFailureNotice`
  （可见文本）名字相近，看代码的人容易认错。文件 `src/components/finding.tsx`。
- **P3**：`settleRunExit` 的 `signal-failed` 分支——这一行到底写到哪里、用户在
  renderer 已销毁时能不能看见，尚未确认。若确实不可见，应改写到主进程日志文件
  而不是 stderr。
- **P3**：`RunFailureNotice` 的「CLI 原始原因可选中」目前没有对应的 UI 断言。

### 本轮做完、可以划掉的

- ~~判定链的两端（主进程的 `presetUrl` 与渲染层算的 `endpoint`）没有对到一起~~ →
  第 9 轮做完：端点只剩一条规则（`serviceEndpoint`），配置视图把它交给渲染层，
  `tools/service-smoke.mjs` 用同一份 config + 同一张表断言两端相等；把优先级调回
  旧的顺序 → 5 条断言变红（实测）。详见上面「P0 — 判定链的两端」。
- ~~`tableUnavailable` × `presetUrl` 的组合没有逐条钉住~~ → 第 9 轮做完：四种组合
  加自定义服务的三种形状，逐条断言「原因」与「端点」两个值，并写清了「名字不在表里」
  指的是什么。
- ~~`config:savedKey` 的回答不携带表状态，横幅与 Key 提示各说各话~~ → 第 9 轮
  做完：回答带 `tableOk` 与 `endpoint`，横幅改用同一个回答。
- ~~`config:savedKey` 没进 bridge 契约检查~~ → 第 9 轮做完：`tools/bridge-contract.mjs`
  多了两条（参数个数、值的去处），实测能抓住把 preload 改回旧写法的那一处。
- ~~`readConfigView` 在 active 分支漏报 model~~ → 第 4 轮做完（`ab21f7d` /
  `221e829`）：`hasModel` 不再漏报模型，`ready` 与 `missing` 出自同一张清单；
  第 5 轮又把 `hasModel` 数的那几个键**按形态**对齐了上游（见上面第 5 轮）。
- ~~`readConfigView` 的 `raw.model` / `presetEntry` 语义核对~~ → 第 5 轮做完：
  逐形态对齐上游 `internal/llm/resolver.go`，`presetEntry` 剩下的那一个分支留在
  「仍然开放」里，并写清了为什么不能靠改一行表达式解决。
- ~~`spawnFailure` 没有导出、没有断言~~ → 第 4 轮做完（`ab11a4d`）：已导出，
  三种情形都有断言（`tools/service-smoke.mjs`）。
- ~~`MAX_ENTRIES` 只是注释里写着是全局上限~~ → 第 5 轮做完：两个仓库交替写的
  4 条断言钉住了「全局、不是 per-repo」。
- ~~`createStore` 的 `options.caseInsensitive` 没有接上真实卷的答案~~ →
  第 4 轮做完：`detectCaseInsensitive` 问**仓库自己的路径**（不写文件），
  `createAppStore` 收口，`main.js` 只剩一行调用。详见上面「P0 — store 的大小写」。
- ~~`readFileAtRef` / `spawnFailure` 的未知措辞兜底分支没有断言~~ →
  第 4 轮做完：各配一条断言，分类逻辑一行未改，`spawnFailure` 顺便导出。
- ~~`check("the stored key is canonical...")` 两个条件用 `&&` 串在一起~~ →
  第 4 轮拆成两条独立断言。
- ~~内置服务名只写在 `custom_providers` 段（`provider: anthropic`）时仍报缺字段~~
  → 第 6 轮 `c36daa9` 收了：`rejected = "provider-not-in-section"`，`missing` 留空、
  `ready` 由拒绝决定，句子说「把条目移到 `providers.<name>`」；断言在
  `tools/service-smoke.mjs`（`presetOnlyInCustom`）。
- ~~`rejectedProvider` 分支没接上（`presetEntry` 的乐观分支）~~ → 第 6 轮做完：
  按**名字**选段，并补上 `custom_providers` 那一次查找；同名两段 / 两段都没有两种
  形态都有断言，4 条去掉修复即 FAIL。剩下「内置名只写在 custom_providers」一条按
  上面的 P1 留给下一轮。
- ~~provider 形态下端点与 Key 仍会数环境变量~~ → 第 5 轮的 `d464d5d` 已经收了：
  `ENV_SOURCES` 第三列按形态、第四列按 preset 归属；`providerEnvUrl` /
  `providerAnthropicBase` / `providerEnvToken` / `customEnvKey` 四条断言在看着。
  第 6 轮又补了 legacy 形态下 `ANTHROPIC_API_KEY` 仍算数的反向断言。

### 一处与上轮简报不同的做法（留给下一个人）

上轮简报建议「在 `userData` 目录下写探针文件」。本轮**没有**这么做，理由写在
上面「P0 — store 的大小写」里：store 的 key 是**仓库路径**，profile 卷的大小写
与它无关；在 macOS 上，profile（系统盘）的答案通常与仓库所在卷**正好相反**。
探针改成只读、只问仓库自己的路径。如果下一个人想改回去，先读那一段。


