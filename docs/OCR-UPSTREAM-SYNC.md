# open-code-review-desktop ← alibaba/open-code-review 上游同步

本文只有一个上游事实源：**HEAD 停在哪、每轮是怎么核对的、上游前进时要重读哪几行**。它分两半——上面
**机器可读区**是 `npm run audit:upstream` 逐字核对的部分（pin 三处声明、每轮通路账、对照表与
`tools/upstream-watch.mjs` 的 `ROWS_TO_REREAD` 双射）；下面**人读区**是关系、规则、本轮结论，
以及「改坏了不会有 audit 变红」的那几处。逐轮正文归档在
[`upstream-history.md`](upstream-history.md)，本文件只留当前一轮。

脚本按**形状**定位机器可读区（`<!-- upstream-pin -->` 标记、「本轮 HEAD 核对：`…`」固定行、
`### 核对通路账` 标题、`| 对照点 | 上游文件 |` 表头），不依赖行号，所以在人读区增删正文不会
挪动它们。反过来也一样：**不要在人读区再声明一次 pin、复制一轮欠账、或另起一张对照表**——
「恰好三处声明」「一轮一行」「一行一个对照点」都是断言，第二份拷贝会让计数失准。

这条禁令本身也进了断言：`tools/upstream-watch.mjs` 的 `machineReadableBlockViolations()` 要求
两个标记各恰好一次且 start 在前、五个锚点在区内各恰好一次、**终点之后一个都没有**。所以在人读区
描述这些锚点可以（比如这句话），照抄它们的字面量不行——`npm run audit:upstream` 会点名行号。

## 机器可读区

> 这一节给 `npm run audit:upstream` 读，也给想核对的人读。改动前先看
> `tools/upstream-watch.mjs` 的 `PINNED_UPSTREAM` / `PIN_PLACES` / `TABLE_HEADER` / `ROWS_TO_REREAD`。
> 三处 pin 声明的第三处是散文（形状：固定的整串 40 位 SHA 加一个反引号值），它在人读区的
> 「`upstream:check` 与三处 pin 声明」一节——那句话本身要说清为什么存全 40 位，拆不出来。

<!-- machine-readable:start -->

### pin 块（三处声明之一）

<!-- upstream-pin:start -->
```text
sha 76ab46ac20f08a8bd8ac38881a8a826c7cb6495f
tag v1.13.4
```
<!-- upstream-pin:end -->

### 本轮 HEAD 核对（三处声明之二：固定行）

**本轮 HEAD 核对：`76ab46ac20f08a8bd8ac38881a8a826c7cb6495f`（第 106 轮：`git ls-remote` 答上来了，`refs/heads/main` 仍是 `76ab46a`，与第 101–105 轮同一个 commit；`refs/tags/v1.13.4` 指向 tag 对象 `1393158`，`/releases/latest` 与 npm `latest` 同为 `1.13.4`，**pin 不前进**；通路：git）**

### 核对通路账

「连续 N 轮没核对 HEAD」应当是一眼能数出来的账，而不是散在各轮散文里。`npm` 只能
证明「没有新 release」，证明不了默认分支的 commit；`git` 与 GitHub API 能回答 commit。
所以本表的规则只有一条：**通路是 `npm` 或 `none` 的轮次必须欠 HEAD 那一项（带
`[UPSTREAM-DEBT]`），`git` / `api` 的轮次必须不带**。`tools/upstream-watch-smoke.mjs`
逐行检查这条规则，并检查末行轮次 / 通路与上面「本轮 HEAD 核对」行一致。

这张账还有第二道钩子，钉的是「这一轮到底记没记」：本仓提交信息固定写「第 N 轮」，
smoke 用 `git log -1 --format=%s` 取出 N，要求**账末行轮次是 N 或 N+1**（`ledgerRoundViolations`）。
允许 +1 是因为文档先改、提交后落——那时的 HEAD 还是上一轮的 N-1，账已经写到本轮；而
**比 N 少一行恰好就是「这一轮提交了、账没加行」的形状**，也就是第 63–64、77 轮那种事后
被补记的情况。所以它是红的，句子点名两边的轮次（「提交信息说第 N 轮，通路账停在 M 轮」），
并提醒「没核对也要记一行，欠账写 `[UPSTREAM-DEBT]`」。

| 轮次 | 日期 | 通路 | 结论 | 欠账 |
| --- | --- | --- | --- | --- |
| 47 | 2026-10-27 | npm | 仅核对 release（`1.13.3`），HEAD 未核对 | `[UPSTREAM-DEBT]` HEAD |
| 48 | 2026-10-27 | npm | 仅核对 release，HEAD 未核对 | `[UPSTREAM-DEBT]` HEAD |
| 49 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容（欠账已清） | — |
| 50 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；补「空服务表」对照行 | — |
| 51 | 2026-10-27 | git | `375f64c`，无新内容；tag 通路超时，release 由 npm 核对 | — |
| 52 | 2026-10-27 | npm | 仅核对 release，HEAD 未核对 | `[UPSTREAM-DEBT]` HEAD |
| 53 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容 | — |
| 54 | 2026-10-27 | npm | 仅核对 release，HEAD 未核对 | `[UPSTREAM-DEBT]` HEAD |
| 55 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容 | — |
| 56 | 2026-10-27 | api | `375f64c` / `v1.13.3`，无新内容；git 超时，API 作答 | — |
| 57 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；API 与 npm 一致 | — |
| 58 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；tag 与 npm 一致 | — |
| 59 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；API 与 npm 一致；pin 三处声明纳入断言 | — |
| 60 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；pin 三处覆盖断言、路径越界统一、`app:info` 抽纯函数 | — |
| 61 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；UNC / 长路径、pin 重复声明、`installInfo` 缺失三处测试收口 | — |
| 62 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；`caseInsensitive` 改成承重、逐轮正文搬进 `upstream-history.md` | — |
| 63 | 2026-10-27 | none | 本文件没有核对记录（该轮未更新状态与账） | `[UPSTREAM-DEBT]` HEAD |
| 64 | 2026-10-27 | none | 本文件没有核对记录（该轮未更新状态与账） | `[UPSTREAM-DEBT]` HEAD |
| 65 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；npm `1.13.3`；pickInside / providers / 三处反向断言收口 | — |
| 66 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；npm `1.13.3`；e2e 的没跑≠通过、相对仓库先拒、kind 抛错 | — |
| 67 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；npm `1.13.3`；e2e 判定纯函数、Windows 盘符相对、类型负例 | — |
| 68 | 2026-10-27 | api | `375f64c` / `v1.13.3`，无新内容；git 超时、API 作答；npm `1.13.3`；picker 判定纯函数、读屏计数、顺序断言点名行号 | — |
| 69 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；npm `1.13.3`；moved 分支自报 5 处对照点、清单与对照表双射断言 | — |
| 70 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；npm `1.13.3`；`app:info` 版本探测加预算、恒绿归属纠正并加 exit 码自测 | — |
| 71 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；npm `1.13.3`；`timedOut` 语义定案（丢弃并断言）、`repo:pick` 走同一道闸门、自跑子进程断言 | — |
| 72 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；npm `1.13.3`；`formatAppInfo` 入参 key-set 钉住、`late` 判断拆成可问的单元、`pickedRepoOrEmpty` 逐字断言 | — |
| 73 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；npm `1.13.3`；install 桩合并成 `tools/install-fixture.mjs` 并断言 fixture 自身、stderr 分类代价入档、归档追加规则进断言 | — |
| 74 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；npm `1.13.3`；`exec` 超时 kill 进真子进程断言、`installInfo` key-set 扩到全部形态、注册体断言按通道找 | — |
| 75 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；npm `1.13.3`；packaging 补「根目录 `*.js` 全在 `build.files`」并给自己一条会红的自测、`git-service` 通用分支的退出码断言抽成谓词并同样自测、本文件收敛成机器可读区 + 人读区 | — |
| 76 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；npm `1.13.3`；机器可读区的形状进断言（`machineReadableBlockViolations` 三条反面用例）、packaging 闸门补「红的原因」断言与非字面量 require 的反向用例、`git-service` ↔ 本文件交叉引用 | — |
| 77 | 2026-10-27 | none | 本文件没有核对记录（该轮未更新状态与账） | `[UPSTREAM-DEBT]` HEAD |
| 78 | 2026-10-27 | api | `375f64c` / `v1.13.3`，无新内容；git 超时（124）、API 作答；npm `1.13.3`；版本探测的等待预算抽成 `versionWaitMs` 并补 grace/budget 边界与 `probeError` 的异常值形状 | — |
| 79 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；npm `1.13.3`；`installInfo` 同名覆盖改成「顶层优先」并补反向断言、`describeProbeError` 补原型链两端、`versionWaitMs` 去掉只被测试读的 `grace` | — |
| 80 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；npm `1.13.3`；`classifyRef` 的计数改成「十进制数字」严格匹配（堵住 `parseInt` 前缀把畸形形状猜成关系）、`gitEnv` 导出并直测 spread / 只读调用方环境 / 逐调用新鲜 | — |
| 81 | 2026-10-27 | api | `375f64c` / `v1.13.3`，无新内容；git 超时（124）、API 作答；npm `1.13.3`；`classifyRef` 去掉多余的数值换算（超大计数不再答「无关系」）、`gitEnv` 的接线探针改走 `readFileAtRef`、同步文档的「上一轮」压成指针并进断言 | — |
| 82 | 2026-10-27 | api | `375f64c` / `v1.13.3`，无新内容；git 超时（124）、API 作答；npm `1.13.3`；`readFileAtRef` 的 stderr 措辞假设外化成 `REF_READ_WORDINGS` 表并按 sample 断言、核对通路账的末行绑定到提交信息的轮次 | — |
| 83 | 2026-10-27 | api | `375f64c` / `v1.13.3`，无新内容；git 超时（124）、API 作答；npm `1.13.3`；真 git 的 stderr 与 `REF_READ_WORDINGS` 逐行对账（只被一行认出、与 sample 同一行）、`createRunner` → `runUpstreamWatch` 的「git 超时 → API 作答」按文本断言 | — |
| 84 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；npm `1.13.3`；`installInfo` 撞名双向断言、上游自测入口改 argv、文档新增编辑规则清单并进断言 | — |
| 85 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；npm `1.13.3`；`app:info` 的 body 抽成 `handleAppInfo` / `assembleAppInfo`，用 getter 探针直测 spread | — |
| 86 | 2026-10-27 | api | `375f64c` / `v1.13.3`，无新内容；git 超时（124）、API 作答；npm `1.13.3`；编辑规则拆成「给人读的约定」与「给 audit 看的约束」并逐条反向断言 | — |
| 87 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；npm `1.13.3`；`formatAppInfo` 撞名面扩到全部返回键、归档禁止整串引用 pin | — |
| 88 | 2026-10-27 | api | `375f64c` / `v1.13.3`，无新内容；git 超时（124）、API 作答；npm `1.13.3`；`describeProbeError` 抛错 getter、`APP_INFO_COMPUTED_KEYS` 单向权威、兜底带出 `rawStderr` | — |
| 89 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；npm `1.13.3`；计算键清单补「每个名字都被某次返回」、兜底 `error` 的原文摘要与真 git 兜底进断言 | — |
| 90 | 2026-10-27 | api | `375f64c` / `v1.13.3`，无新内容；git TLS 错误（GnuTLS）、API 作答；npm `1.13.3`；账末窗口的构造式自测（N / N+1 绿、N-1 / N-2 红并点名两边轮次）、`timedOut` / `probeError` 丢弃决定的三处清单、`AppInfo` ↔ 计算键 + 安装键交叉断言 | — |
| 91 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；npm `1.13.3`；`probeError` 的丢弃加注入式出口（`onProbeError`，`main.js` 记一条 `console.warn`）、`binarySource` 与 `executable` 的空串语义进断言 | — |
| 92 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；npm `1.13.3`；`probeError` 出口与卸载告警统一到 `run:log`（接线断言改问通道与 `{ line }`，构造式自测钉住 `console.warn` / `{ id }` 判否）、代码→文档的章节引用进断言（改标题即点名缺失） | — |
| 93 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；npm `1.13.3`；窗口未就绪时的事件改成排队 + `did-finish-load` 后 flush（`window-sender.js`，超限丢最旧并回报条数）、依赖版本 ↔ pin tag 进断言、注释引用的章节按「恰好一处」判定 | — |
| 94 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；npm `1.13.3`；sender 的三格边界（未就绪 + 队列非空再 send、已 ready 重复 markReady、flush 失败不污染 dropped）与 `main.js` 的 `lost > 0` 接线进断言；`dependencyPinViolations` 补「无版本号」「pin tag 非版本号」两类红；加载彻底失败的取舍进注释 | — |
| 95 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；npm `1.13.3`；两处「说出口」抽成 `main-wiring.js`（`reportSenderLoss` / `reportProbeError`）并直测、`markReady()` 的 `sent` 改成按次计并补「中断后继续 flush」的反向控制 | — |
| 96 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；npm `1.13.3`；sender 的「超限丢最旧」「非法 limit 落默认」与「未就绪不触碰 window」补反向控制、`main-wiring` 的非法上限 / 非法消息四格补反向控制 | — |
| 97 | 2026-10-27 | git | `375f64c` / `v1.13.3`，无新内容；npm `1.13.3`；`describeProbeError` 的无原型拒绝补到 sink 端（payload 与句子两端同问）、文档截断进断言（未闭合围栏 / 停在半句 / 标题收尾 / 当前状态无正文） | — |
| 98 | 2026-11-02 | git | **上游 HEAD 前进**：`375f64c` → `216dcf5`（3 个 commit：Go / Node 版本、GitHub Action 稳定性、`session show --json` 的空表改成 `[]`）；`refs/tags/v1.13.3` 与 npm `1.13.3` 均未变，**pin 不前进**；对照表 5 行的上游文件都没被这三个 commit 碰到，而 `session` 的 JSON 形状不在这 5 行里（本仓只调 `session list`，已容忍 `null`）；人读区必需标题各恰好一次 + 「当前状态」轮次 ↔ 账末行进断言（`humanSectionViolations`）、`bridge-contract` 的接口与通道双射补反向控制 | — |
| 99 | 2026-11-02 | git | `216dcf5` / `v1.13.3`，无新内容；npm `1.13.3`；README 指向的每份 .md 都要闭合（`productDocViolations`：围栏闭合、最后一行、表格行、指针 404 四条反向控制）、DoD 头部与「状态」行只许是 locked / live（`dodAuthorityViolations`，draft 词汇与「什么都没写」各判一次红） | — |
| 100 | 2026-11-02 | git | `216dcf5` / `v1.13.3`，无新内容；npm `1.13.3`；通知条的三条回放进断言（`?notice=1` 恰两行且 CLI 伪装行不进条但仍在抽屉里、`?notice=many` 去重且顺序不动、`?notice=overflow` 恰 `NOTICE_LIMIT` 条且最旧离场），反向控制改成另起一个端口服务 `logSource` 被削弱的 bundle 并要求同一比较变红；新增 `tools/notices-smoke.mjs`（`logSource` / `noticeText` 逐格边界、三种错误实现自测、`src/store.tsx` 调用点必须两个参数）并作为 `audit:notices` 挂进 `audit:static` | — |
| 101 | 2026-11-02 | git | **上游 HEAD 前进**：`216dcf5` → `76ab46a`（4 个 commit：Go / Node 版本与安全修复、GitHub Action 稳定性、`session show --json` 空表改 `[]`、`file_read_diff` 找不到路径时点名缺哪条）；`git ls-remote --tags` 返回空行（tag 通路本轮没答上来）、npm `1.13.3` 未变，**pin 不前进**；对照表 5 行的上游文件（`resolver.go`、`config_cmd.go`、`llm_cmd.go` / `providers.go`、`failure_class`）一个都没被这四个 commit 碰到，无移植项；新增 `tools/cjk-typography.mjs` + smoke（三条中文排版禁则、三格反向控制、改一个全角句号即点名文件与行号）挂进 `audit:static`，`engines.node` 抬到 `>=22.18` 与类型剥离的真实需求对齐 | — |
| 102 | 2026-11-02 | git | `76ab46a` / `v1.13.3`，无新内容；npm `1.13.3`；两份 README 首屏从能力清单改成产品主意（一句话 + 3–5 条 + 长清单下沉到「已验证行为」/「Verified behaviour」），首屏形状进断言（`firstScreenViolations`：一句话、无 `--参数`、不说「封装」、3–5 条、链接到仍存≥8 条的那一节，逐条反向控制）；`package.json` 的 `description` 同样改口径 | — |
| 103 | 2026-11-03 | api | **上游 tag 前进**：`v1.13.3` → `v1.13.4`（发布 2026-11-02T15:19:48Z，tag commit 就是第 101 轮已经读过的 `76ab46a`；4 个 commit 与安全修复 / Action 稳定性 / `session show --json` 空表改 `[]` / `file_read_diff` 未命中时点名缺的路径同批）；`git ls-remote` 因 TLS 失败（GnuTLS `-110`），HEAD 与 tag 都由 API 答上、npm `latest` 同为 `1.13.4`，**pin 前进**；对照表 5 行在这一次提交里逐行重读（51 个变更文件不含 `resolver.go`、`config_cmd.go`、`llm_cmd.go` / `providers.go`、`failure_class`，两处 Go 源码改动与本仓的两个消费点对上了）；通路账第 101/102 行之间那个把表截成两段的空行删掉，新增 `ledgerTableViolations` 钉住「表内不许有空行」并补反向控制（含一条证明别的账都看不见它）；升 pin 的那一遍真机验证跑在 Linux x64 上（CLI 层 / 真 Electron / UI 三套全绿，`audit:guards` 先红——它没把「没有报告」当环境问题，重试条件与 `e2e-flow` 对齐后转绿），顺带查出英文 README 在让读者下载 12 个 Release 里从未存在过的 macOS / Linux 包，两份 README 与 `使用说明.md` 的发布面、验证面措辞已对齐 | — |
| 104 | 2026-11-03 | git | `76ab46a` / `v1.13.4` / npm `1.13.4`，三条通路答案一致、无新内容，**pin 不前进、无移植项**；两份 README 首屏第二段去 AI 味道（平台验证矩阵下沉到 Known limitations / 已知限制，那一节本就记着全部事实），`firstScreenViolations` 加第 5 条——第一节里出现架构名、包格式名或「按平台一条」的 bullet 即红，四条反向控制：粘回英文原矩阵、粘回中文原矩阵、把一个能力 bullet 换成平台 bullet（条数仍是 5，红的只能是新那条）、同一段矩阵写进「已知限制」必须仍绿（钉住这条管的是位置不是事实）；本文件人读区 192 → 137 行（逐轮正文归档 −27、散文减重 −28：规则与其边界留下，「这一条是怎么一格一格补上的」交回归档第 82、83、88、89 轮），顺带把「本节表格的 4 行」改成 5 行——对照表一直是 5 行；`tools/electron-guards.mjs` 的沙箱重试判定抽成导出的 `guardsRetryReason` / `guardsFailure`，新增 `tools/electron-guards-smoke.mjs` 作为 `audit:guards-retry` 挂进 `audit:static`（两次都没有报告就是崩溃，退 2 且结论不许再写「环境问题」） | — |
| 105 | 2026-11-03 | api | `76ab46a` / `v1.13.4` / npm `1.13.4`，三条通路答案一致、无新内容，**pin 不前进、无移植项**；DoD 的勾选状态进断言（`dodChecklist` / `dodCheckboxViolations`：稳定 ID、只有两种状态、勾选必须带仓内证据、锁定的 6 个 ID 一个不许少，八格反向控制含「补上存在的证据就转绿」）、中文排版的清单补显式兜底（`EXPLICIT_DOCS` + `typographyCoverageViolations`，抹掉 README 指针后 DoD 仍须在清单里）、`docs/measurements.md` 新增「未验证清单」一节 | — |
| 106 | 2026-11-03 | git | `76ab46a` / `v1.13.4` / npm `1.13.4`，三条通路答案一致、无新内容，**pin 不前进、无移植项**；界面中文排版从「手感」变成断言：新增 `tools/ui-cjk-typography.mjs`（真浏览器走结果页 / 长 finding / 阅读页三屏，把可见中文按块取出后跑与文档同源的三条规则，`pre` / `code` 整棵子树排除）与 `tools/ui-cjk-typography-smoke.mjs`（规则同源、三条规则各自点名、接线与反向控制前提），三条规则从 `tools/cjk-typography.mjs` 抽成可复用函数而不是抄一份；反向控制把报告里那句「固定到审查当时的那一版…」的全角逗号改成半角，要求同一趟走查变红并点名那一屏 | — |

### 对照表（上游前进时要重读的五处）

「最近一次对照」只写**那一项最近被人工重新核对**的轮次。该列没有列出本轮，表示本轮
复核过上游、这一项没有变化，**不是欠账**；只有上游 HEAD / tag 真的前进，才需要重看
对应行并把轮次与日期改成本轮。

**第 46–97 轮上游 HEAD 与 tag 未变**（`375f64c` / `v1.13.3`；第 47–48、52–54 轮只有
npm 通路可达，第 56 轮 git 超时但 API 可达，第 63–64 轮本文件无通路记录，第 68 轮 git
超时但 API 可达，第 69–76、79–80、84–85、87、89、91–97 轮 git 可达，第 77 轮本文件无通路记录，第 78、81–83、86、88、90 轮
git 超时（第 90 轮为 TLS 错误）但 API 可达）。那 52 轮里下表 5 行的
「最近一次对照」一直停在第 45 轮，这是
**没有理由重看**，不是忘了看：
它记录的是「最后一次有人逐行读上游源码」的轮次，而不是「最后一次确认上游没变」的轮次。
换言之：**停在第 45 轮 = 未重看，不等于欠账**；欠账只有一种——pin 前进之后没人
重读对应源码。第 50 轮那行（内置服务表为空是否合法）是榜样的写法：它记的是被重读的
具体行号与 tag，而不是一个「已复核」的戳。

也就因此，**表里引用的上游行号不需要重看**：pin 相同意味着 commit 相同，同一个 commit
里的 `llm_cmd.go:261`、`providers.go:45` 必然仍指向同一段代码——行号不是欠账，**只有 pin
前进才是**。把「行号可能过期」当成待办，等于把同一个事实重新发现一遍。

第 98 轮是这条界线第一次真的被踩到：`refs/heads/main` 前进到 `216dcf5`（比 pin 多 3 个
commit），而 tag 与 npm 都还是 `v1.13.3` / `1.13.3`，所以 **pin 不动、本表 5 行也不动**。
本表描述的是**被封装的那个发布版本**的行为，默认分支上尚未发布的改动不构成欠账；那三个
commit 的文件清单也证实这一点——`internal/llm/resolver.go`、`config_cmd.go`、`llm_cmd.go` /
`providers.go`、`failure_class` 一个都没被改到。这里的 SHA 一律写 7 位前缀（全串只在上面
三处声明 pin），三个 commit 的清单与结论写在人读区的「当前状态」。

第 103 轮是这条界线的另一半：**tag 第一次真的前进**（`v1.13.3` → `v1.13.4`）。发版的 4 个
commit 就是第 101 轮已经逐文件读过的那一批，所以本轮重读的不是新改动，而是同一批改动
第一次变成**被封装的那个发布版本**。`v1.13.3...v1.13.4` 的 51 个变更文件里没有本表任何一行的
上游文件；两处 Go 源码改动各自有一个本仓消费点要核对，核对结论也各自记在下面那两行里：
`cmd/opencodereview/session_cmd.go` 只给 `runSessionShow` 的 `--json` 补了空表（本仓不调
`session show`，只用 `session list`），`internal/tool/file_read_diff.go` 改的是**回给模型的
tool 结果文本**（`Error: diff not found for: …`、`Diffs exist for: …`），而本仓按行首 `error:`
分类的两处（`ocr-service.js` 的 `errorLines` 与流式 `emit` 的过滤）读的都是 CLI 的 stderr。
逐行结论写在下面这张表的最后一列。

| 对照点 | 上游文件 | 人工看什么 | 最近一次对照（轮次 / 日期） |
| --- | --- | --- | --- |
| provider 解析顺序 | `internal/llm/resolver.go` | 是否仍按 `cfg.Providers[cfg.Provider]`（原始拼写）读；大小写折叠、回退到 registry 拼写、miss 兜底任一变化都改变设置页「Key 属于哪条」的答案 → 同步改模拟（`UPSTREAM_RESOLVER`）与 `MATCH_RULES` | 第 103 轮 / 2026-11-03（v1.13.4：`internal/llm/resolver.go` 不在 51 个变更文件里，与 v1.13.3 同一个 commit 的内容，`UPSTREAM_RESOLVER` 与 `MATCH_RULES` 不动） |
| `config set` 的 key 语法 | `cmd/opencodereview/config_cmd.go` | 点名到最后一个点的分段（带点的自定义名）、未配置带点名直接拒绝 | 第 103 轮 / 2026-11-03（v1.13.4：`cmd/opencodereview/config_cmd.go` 未被这批 commit 改动） |
| 内置服务表 | `ocr llm providers` 输出 | 列、表头、失败时的 stderr 措辞 | 第 103 轮 / 2026-11-03（v1.13.4：`llm_cmd.go` / `providers.go` 未被改动；`npm run audit:config` 在 1.13.4 的二进制上重跑为绿，见「当前状态」） |
| 内置服务表**为空**是否合法 | `cmd/opencodereview/llm_cmd.go` 的 `runLLMProviders` → `internal/llm/providers.go` 的 `registry` / `ListProviders` | `runLLMProviders` 无条件打印 `Built-in providers:` 表头与 `NAME / PROTOCOL / BASE URL` 列，行来自编译期 `registry` 切片，**一行都没有也不报错、退出码仍为 0**。所以「表读回来是空的」只可能来自装得不完整或我们丢了行——这是 `config-handler.js` 的 `TABLE_HOLLOW` 文案（「CLI 一定有内置服务名，所以这多半是装得不完整」）唯一的外部依据。上游若把 provider 改成可外挂/可配置（空 registry 成为合法状态），这句话就变成错的，`tableSilenceOf` 要跟着改 | 第 103 轮 / 2026-11-03（v1.13.4：`llm_cmd.go:261`、`providers.go:45` 仍指向同一段代码——这两个文件都不在 `v1.13.3...v1.13.4` 的清单里，所以第 50 轮记下的行号在新 pin 上不需要重找；`TABLE_HOLLOW` 的外部依据不变） |
| 运行期失败分类 | 运行 JSON 的 `failure_class` / 每文件 `failure_class` | 枚举值增删（`RunFailureClass` 与 `FailureClass` 是两张表） | 第 103 轮 / 2026-11-03（v1.13.4：两张枚举都没有增删——变更清单不含定义 `failure_class` 的文件；唯一改到工具层的是 `file_read_diff` 的未命中文案，那是回给模型的字符串，不落进本仓读 stderr 的两处分类） |

`resolver` 的查找顺序变化**不会**让 `audit:service` 全面变红——它只覆盖上面那几种形状
（provider 与 registry 拼写不一致、provider 落在 registry 拼写上、provider 指向别的服务）。
上游若换了别的判定方式（例如先查 registry 再查文件），需要人工读 `internal/llm/resolver.go` 确认。

<!-- machine-readable:end -->

---

## 人读区

以下是给人读的：为什么这么封装、调度规则、本轮结论，以及哪些地方改坏了不会有 audit 变红。

## 改这份文档之前

这份文件被 `npm run audit:upstream` 按**形状**核对：标记、标题、表格、pin 与每轮账都只有一份，
位置和数量都是断言。规则因此分成两类，各自只写在能被核对的那一边。

### 给人读的编辑约定

1. **本文件只留当前一轮的正文。** 上一轮整段搬到 `upstream-history.md`，这里只留一句指针；
   指针要指向归档里真实存在的轮次，锚点用那一节标题的 slug。
2. **归档段落正文写一次后不再改写。** 后来者只能在段末追加一条 `补记（第 N 轮）`，N 必须
   晚于该段轮次；新轮次加在最上面，段落轮次递减。
3. **每轮都在核对通路账里记一行。** 通路写 `git` / `api` / `npm` / `none` 之一；没核对也要
   记，不要跳过这一行——「这一轮提交了、账没加行」正是脚本会点名的形状。

### 给 audit:upstream 看的约束

这一节不复述具体形状：机器可读区的标记与锚点、pin 恰好三处、通路账的通路与欠账配套、
「别把锚点字面量抄进人读区」，权威定义都在 `tools/upstream-watch.mjs` 的常量与判定函数里。
改文档就跑 `npm run audit:upstream`，红了它点名行号，再去那份代码里看这一条问的是什么——
把规则再抄一份到这里，只会多一份没人核对、却先过期的拷贝。

## 关系
- Desktop：https://github.com/castorhrio/open-code-review-desktop （服务器 `/opt/open-code-review-desktop`）
- 上游开源库：https://github.com/alibaba/open-code-review

## 规则（调度每轮写码前由 prompt 强制提醒）
1. **定期检查**：每轮至少看一次上游默认分支新 commit，以及 Releases/tags。
2. **评估**：新功能 / API / CLI / 配置 / 破坏性变更对 desktop 封装的影响。
3. **移植**：可安全合并的 → 写入本仓并测通；不能立刻做的 → 记入私有 control 仓的
   下一轮简报。本仓库**不再维护** `next-iteration.md` 之类的工作流文档。
4. **不要**静默忽略上游 release：每轮把结论写进下面「当前状态」，并把上一轮的正文搬到
   [`upstream-history.md`](upstream-history.md)，哪怕结论是「无新内容」。搬完这里只留一句
   指针——「本文件只留当前一轮」不是约定而是断言（`previousRoundPointerViolations`）。

## 当前状态（第 106 轮，2026-11-03）
第 106 轮复核：**上游没有新内容。**`git ls-remote` 这一轮答上来了：`refs/heads/main` 仍是 `76ab46a`
（与第 101–105 轮同一个 commit），`refs/tags/v1.13.4` 指向 tag 对象 `1393158`，`/releases/latest` 与
npm `latest` 同为 `1.13.4`。三条通路答案一致，**pin 不前进、无移植项**，对照表 5 行因此不动。

本轮按控制仓简报做 P0-1：**界面里的中文排版从「手感」变成断言。**

`tools/cjk-typography.mjs` 一直在查文档，而**屏幕是陌生人读的另一半，那一半没有任何检查看过**：
模型返回的 finding 里带一个半角逗号、某个标签写成 `用ocr跑`、某一行以「，」起头——这三种缺陷
`audit:ui` 全都看不见（布局仍然放得下、没有溢出、没有占位符泄漏），`audit:typography` 也看不见
（它从不打开应用）。所以三条规则从那份文件里**抽成可复用函数**（`lineStartViolation` /
`halfWidthViolations` / `bareAdjacencyViolations`），文档侧与界面侧共用同一份：在一处修好的规则
在两侧都修好，两份拷贝也就没有机会漂移。

- **`tools/ui-cjk-typography.mjs`**（`npm run audit:typography-ui`）用真浏览器走三屏——结果页选中
  一条 finding、长 finding 那一屏（模型写得最多的地方）、阅读/报告页——把每屏的可见文本按**块**取出
  （块 = 子元素全是行内级的最外层元素，所以 `<p>foo <strong>bar</strong></p>` 是一块而不是三块，
  行首禁则问的是句子而不是碰巧以逗号开头的碎片），再跑同一套规则。`pre` / `code` / `textarea` /
  `input` 整棵子树排除：代码样例不是散文，diff 里的 `foo(x,y)中` 不是排版缺陷——这条排除正是
  「规则」与「噪音」的分界，与文档侧对代码段的排除是同一条。
- **反向控制**：把报告里那句「固定到审查当时的那一版，之后分支再前进也不影响这份报告」的全角逗号
  改成半角，用同一份 bundle 的副本再走一遍三屏，要求本检查**变红并点名那一屏**。没有它，绿只说明
  「规则满足了」或「规则根本没跑」，而这两件事从外面看一模一样。
- **`tools/ui-cjk-typography-smoke.mjs`**（`npm run audit:typography-ui-rules`）是不需要浏览器的
  那一半：逐行断言界面侧与文档侧**报出同样的规则与同样的句子**（有人把规则抄进界面文件而不是 import，
  第一次改动就会红）、三条规则各自在渲染文本上点名到「哪一屏 / 哪个元素 / 第几行 / 哪段文字」、
  干净散文必须绿、以及反向控制那句原文仍在 `ReportView.tsx` 里（句子被改写时先在这里红，而不是让
  浏览器那一半退 2）。

**接线与简报的一处偏差，写在这里而不是悄悄改**：简报说把 `audit:typography-ui` 挂进 `audit:static`，
但这一半需要 `out/` 与浏览器，而 `audit:static` 的契约是「不构建、不开浏览器」。所以浏览器那一半挂在
`audit:app`（`npm run audit` 只构建一次，交给所有 harness），不需要浏览器的那一半挂在 `audit:static`。

**没有检查的，写清楚**：导出的自包含 HTML 报告是**上游 CLI**（`ocr session export`）写的，不是本程序
渲染的——它的排版归上游，声称在这里检查它只会是一盏接不到线的绿灯。本程序拥有的是导出所依据的那个
阅读页，那一页在检查范围内。另外行首禁则问的是**块首**：`innerText` 只在块边界与 `<br>` 处断行，
浏览器按栏宽折出来的行它看不见，所以「逗号被折到下一行」这一类不在覆盖内——这是真实的边界，写在
工具头部而不是糊过去。

**P0-2 的 critique 结论是「装饰多于信息」，据此做了一个具名 pass：`quieter`。** 三处 `Sparkles`
（✨ 是生成物最直白的签名）从结果页的要点标题、报告页的要点卡片与「模型判断过程」的折叠标题上摘掉——
它们不指向任何可点的东西，只是给每块文字配一个图标。同一趟 critique 撞出更硬的一条：结果页 header 的
`固定在 <sha>` 徽章在每一张截图里都是一堵 41 字符的十六进制墙，因为 `tools/ui-audit/fixtures.mjs` 的
SHA 是 **41** 位（真实 git 是 40 位），`shortRef` 的 `/^[0-9a-f]{40}$/` 从没匹配上——**审计一直在验一个
真实运行产生不出来的形状，而应用真正渲染的 7 位短形从没上过屏**。夹具改成 40 位，`expectPinnedCommit`
新增一条断言：徽章可见文本必须**恰好**是 `固定在 d41c8b7`（完整 SHA 仍留在 title 里）。`audit:ui` 112 条
全绿，`audit:typography-ui` 三屏 202 块全绿。

本轮没有动任何交互语义、IPC 与评审逻辑；改动只在 `tools/cjk-typography.mjs`（抽函数，行为不变，
`audit:typography` 与它的 smoke 全绿）、两个新 `tools/` 文件、`package.json` 的两条脚本与两处套件接线、
`src/components/ReportView.tsx` 与 `ResultsPanel.tsx` 的三处图标、`tools/ui-audit/fixtures.mjs` 与
`audit.mjs` 的 SHA 形状，以及本文件与归档。
上一轮（第 105 轮）的正文见 [upstream-history.md](upstream-history.md#上游状态第-105-轮2026-11-03)，归档之后本文件不留第二份。

## 上游真变了怎么办（命令驱动，而不是「记得看一眼」）
```bash
npm run audit:service   # CLI 参数构建 / 四种模式的输出解析 / resolver 查找顺序的投影
npm run audit:config    # `ocr llm providers` 表与 config.json 的读写假设
npm run audit:git       # `git show` 的分类与按 ref 读文件
```
任一条变红就是「需要评估的上游变更」：先看红在哪条断言，再对照上面的 CLI/配置暴露点判断。

pin 前进时，对照表 5 行要在同一个提交里一次性重读完毕；建议那一次不要同时做别的改造，
因为「哪些行看过了」全靠这一份记录。

### `upstream:check` 与三处 pin 声明（第三处声明就在这里）

另有 `npm run upstream:check`：先比对 `refs/heads/main` 与本文件固定的整串 40 位 SHA `76ab46ac20f08a8bd8ac38881a8a826c7cb6495f`（正文里引用只写 `76ab46a` 前缀是为了好读；这一处与上面的块、下面的固定行同值，`audit:upstream` 三处一起核对）。
相等打印一行并注明 `通路：git`；git 不通时自动改走 `api.github.com/commits/main`，成功注明 `通路：api`——两条路问的是同一个 commit。前进时打印醒目提示并逐行列出上面那 5 处对照点，
**但不失败**，仍要人读源码；两条路都失败才打印「跳过」，前缀固定为 `[UPSTREAM-DEBT]`、写明两条路各自的原因，退出码恒为 0，所以它能挂在任何流程里而不把网络问题当成上游变更。

三种答案对应三种 grep，不必读句子：

| grep | 含义 | 该怎么办 |
| --- | --- | --- |
| `[UPSTREAM-DEBT]` | 本轮**没核对** HEAD（git 与 API 都不通） | 下一轮补核对，并在通路账记一行欠账 |
| `[UPSTREAM-MOVED]` | 核对了，HEAD **前进了** | 重读它逐行打印的 5 处对照点，改 pin 与本文件 |
| 两者都没有 | 核对了，**没变** | 无需动作 |

「没变」刻意不带 marker：安静应该表示「没事要做」，任何 marker 都比安静更响；这张表由 `tools/upstream-watch-smoke.mjs` 的 marker 断言钉住（该带的带、不该带的不带）。

哨兵跑在 Node 里，`engines.node` 因此写 `>=22.18`——它曾写 `>=18`，比真实需求低了一个大版本，抬上来的理由记在第 101 轮。

**pin 存全 40 位是有意的**：只存 7 位前缀时，把 pin 换成另一个同样以该前缀开头的 commit 会被判成「与对照表一致，无需重读」，而那是这句话唯一不能错的方向——下面那 5 行会一直没人重读，句子却还是绿的。所以「相等」的语义就是整串 40 位相等；pin 或 `ls-remote` 给出的 SHA 短于 40 位时一律判「跳过」并说明原因，不做前缀匹配。

### 能自动变红的地方，和不能的地方

`audit:service` 里的 `UPSTREAM_RESOLVER`（`tools/service-smoke.mjs`）是唯一一处**把上游语义
写进断言**的地方：它按 v1.13.3 `internal/llm/resolver.go` 的做法重算一遍「这次运行会打开哪
条条目」（`cfg.Providers[cfg.Provider]`，原始拼写、不折叠大小写、miss 不兜底），再要求
`entryByName` 指出同一条——所以上游改了「按哪个拼写找条目」，这条会先红。它红的时候先读
上游 HEAD 的 `resolver.go`，改的是 `MATCH_RULES` 和这段模拟，不是把断言放宽。

**`git-service.js` 的 `readFileAtRef` 按 stderr 措辞分类，代价在这里写清楚。** 它用两组正则把 `git show`
的失败分成 `bad-ref`（引用不存在）与 `missing`（文件不在那个快照里），两者对用户说的是不同的话；正则匹配
的是 git 的英文措辞，所以模块固定 `LC_ALL=C` / `LANG=C`（本地化 git 的「致命错误：无效的对象名称」会
落进通用分支）。今天的边界是：**这两句话被钉住了**——git 换了措辞 `audit:git` 会红，要改的是本仓的
pattern；**没人钉的是别的失败**（子模块、git 为其它情形保留的拼写、git 从不在这两处发出的措辞），只能靠
人读。补偿是通用分支必须可诊断：`error` 带 git 的首行与退出码——退出码是这条路上唯一不随语言变的部分——
未 trim 的原文放在 `rawStderr`（只在兜底分支，不拼进用户可见的 `error`）。这两层各自覆盖什么、是一格
一格怎么补上来的，记在归档第 82、83、88、89 轮；想动这两组正则，先连 `git-service.js` 顶部 `gitEnv()`
的注释一起读。

**但 audit 变红不等于覆盖完整**：下面这几处只有人工对照，改坏了不会让任何 audit 变红。

**`upstream:check`（哨兵）的退出码恒为 0，只报告不失败——它的绿不是安全网；`audit:upstream` 跑的是本套断言（pin 三处声明、对照表双射、通路账），是会 `exit 1` 的那一半——恒绿不是安全网，红的这一半必须真的红。**
上游漂移的唯一安全网是 `audit:service` / `audit:config` / `audit:git` 这三条，加上人工重读本节
表格的 5 行；哨兵打印「跳过」（git 与 API 都不可达）时同样是绿的——**绿只说明这条命令跑过，
不说明上游没变**。所以每轮的结论仍要写进上面「当前状态」，跳过时至少留下 `[UPSTREAM-DEBT]`
与「核对通路账」里的一行欠账。

## 建议命令（agent 在 `/opt/open-code-review-desktop`）
```bash
# 若尚未加 upstream remote：
git remote add upstream https://github.com/alibaba/open-code-review.git 2>/dev/null || true
git fetch upstream --tags
git log --oneline HEAD..upstream/main 2>/dev/null || git log --oneline HEAD..upstream/master 2>/dev/null | head
gh release list -R alibaba/open-code-review --limit 5
```

也可对照本地若存在的 `/opt` 外 checkout；以 GitHub 上游为准。

