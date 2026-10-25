# 下一轮迭代

本文件记录**上游 `alibaba/open-code-review` 的状态**与**待移植项**。
规则见 [`OCR-UPSTREAM-SYNC.md`](OCR-UPSTREAM-SYNC.md)：每轮至少检查一次上游，
有更新就记在这里，不要静默忽略。

---

## 上游状态（最近检查：2026-10-26）

上游 `alibaba/open-code-review` 自 desktop 锁定的 `v1.13.0` 之后发布了
**3 个补丁版本**：`v1.13.1` / `v1.13.2` / `v1.13.3`（共 18 个 commit）。
本轮已把 desktop 的依赖升到 `^1.13.3`（`package.json` / `package-lock.json`），
并移植了其中对封装影响最大的一个修复。

**本轮复核结论**（2026-10-26，第 2 轮）：上游**仍然没有新内容**。

- `git fetch upstream --tags` 两次都因 `GnuTLS recv error (-110)` 失败（网络抖动），
  改用 GitHub API 交叉核对：`repos/alibaba/open-code-review/commits?sha=main` 的顶端
  仍是 `375f64c`（2026-10-20），`tags` 列表最新仍是 `v1.13.3`，`releases` 无新条目。
- 本仓 `upstream/main` 的本地 ref 也仍指向 `375f64c`，与上游一致。

**本轮复核结论**（2026-10-26，第 3 轮）：上游**仍然没有新内容**。

- `commits?sha=main` 的顶端仍是 `375f64c`（2026-10-20，日期未变）；
  `tags` 最新仍是 `v1.13.3`；`releases` 最新仍是 `v1.13.3`（2026-10-22 发布）。
- 本仓 `upstream/main` 的本地 ref 仍指向 `375f64c`，与上游一致。

**本轮复核结论**（2026-10-26，第 4 轮）：上游**仍然没有新内容**。

- `git fetch upstream --tags` 这次**成功**（前几轮的 `GnuTLS recv error (-110)` 是
  网络抖动），本仓 `upstream/main` 仍指向 `375f64c`。
- GitHub API 交叉核对：`commits?sha=main` 顶端仍是 `375f64c`（2026-10-20）；
  `tags` 最新仍是 `v1.13.3`；`releases` 最新仍是 `v1.13.3`（2026-10-22 发布）。
- 结论不变：本轮没有需要移植的新功能 / 修复 / 破坏性变更。

结论：本轮没有需要移植的新功能 / 修复 / 破坏性变更，desktop 的封装（CLI flag、
输出解析、配置暴露点）无需改动。

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

本轮收了「卷的大小写」与「未知措辞的兜底」两条，其余按优先级排在这里，下一轮挑。
标注「**未动**」的条目是本轮看过、确认仍然成立但没有改的——不是新发现。

- **P1**：`readConfigView` 在 active 分支的 `missing` 只报 `credential`，忽略
  「有 endpoint 无 model」。文件 `ocr-service.js`（既有代码，不是本轮引入）。
  ——**未动**。`readConfigView` 是纯函数，四种组合各断言一次即可，顺手修 active
  分支漏报 `model` 的问题。文件 `tools/service-smoke.mjs`。
- **P2**：`writeAll` 的 Windows 回退分支里 `unlink(tmp)` 失败被吞掉，进程立刻退出
  会留下 `*.tmp` 垃圾。文件 `run-diagnostics.js`。——**未动**。改成把失败记进
  outcome。
- **P2**：`MAX_ENTRIES` 的注释没有写明它是「**全局**上限，按写入顺序淘汰」
  （跨仓库一起算，不是每个仓库 200 条）。文件 `run-diagnostics.js`。若要改成
  per-repo，则要改 `record` 的截断逻辑并加断言。
- **P3**：`finding.tsx` 的 `RunFailureNote`（只显示 tooltip）与 `RunFailureNotice`
  （可见文本）名字相近，看代码的人容易认错。文件 `src/components/finding.tsx`。
- **P3**：`settleRunExit` 的 `signal-failed` 分支——这一行到底写到哪里、用户在
  renderer 已销毁时能不能看见，尚未确认。若确实不可见，应改写到主进程日志文件
  而不是 stderr。
- **P3**：`RunFailureNotice` 的「CLI 原始原因可选中」目前没有对应的 UI 断言。

### 本轮做完、可以划掉的

- ~~`createStore` 的 `options.caseInsensitive` 没有接上真实卷的答案~~ →
  第 4 轮做完：`detectCaseInsensitive` 问**仓库自己的路径**（不写文件），
  `createAppStore` 收口，`main.js` 只剩一行调用。详见上面「P0 — store 的大小写」。
- ~~`readFileAtRef` / `spawnFailure` 的未知措辞兜底分支没有断言~~ →
  第 4 轮做完：各配一条断言，分类逻辑一行未改，`spawnFailure` 顺便导出。
- ~~`check("the stored key is canonical...")` 两个条件用 `&&` 串在一起~~ →
  第 4 轮拆成两条独立断言。

### 一处与上轮简报不同的做法（留给下一个人）

上轮简报建议「在 `userData` 目录下写探针文件」。本轮**没有**这么做，理由写在
上面「P0 — store 的大小写」里：store 的 key 是**仓库路径**，profile 卷的大小写
与它无关；在 macOS 上，profile（系统盘）的答案通常与仓库所在卷**正好相反**。
探针改成只读、只问仓库自己的路径。如果下一个人想改回去，先读那一段。


