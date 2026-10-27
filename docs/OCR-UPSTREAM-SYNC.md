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
sha 375f64cd6f67a48a135da83cfcf59c52669a09cb
tag v1.13.3
```
<!-- upstream-pin:end -->

### 本轮 HEAD 核对（三处声明之二：固定行）

**本轮 HEAD 核对：`375f64cd6f67a48a135da83cfcf59c52669a09cb`（第 94 轮：`git ls-remote` 与 `--tags --refs` 退出码 0，`refs/heads/main` 与 pin 一致；`refs/tags/v1.13.3` 仍为最高 tag；npm 仍为 `1.13.3`；tag 对象未独立重读；通路：git）**

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

### 对照表（上游前进时要重读的五处）

「最近一次对照」只写**那一项最近被人工重新核对**的轮次。该列没有列出本轮，表示本轮
复核过上游、这一项没有变化，**不是欠账**；只有上游 HEAD / tag 真的前进，才需要重看
对应行并把轮次与日期改成本轮。

**第 46–94 轮上游 HEAD 与 tag 未变**（`375f64c` / `v1.13.3`；第 47–48、52–54 轮只有
npm 通路可达，第 56 轮 git 超时但 API 可达，第 63–64 轮本文件无通路记录，第 68 轮 git
超时但 API 可达，第 69–76、79–80、84–85、87、89、91–94 轮 git 可达，第 77 轮本文件无通路记录，第 78、81–83、86、88、90 轮
git 超时（第 90 轮为 TLS 错误）但 API 可达），所以下表 5 行的
「最近一次对照」停在第 45 轮是
**没有理由重看**，不是忘了看：
它记录的是「最后一次有人逐行读上游源码」的轮次，而不是「最后一次确认上游没变」的轮次。
换言之：**停在第 45 轮 = 未重看，不等于欠账**；欠账只有一种——`375f64c` 前进之后没人
重读对应源码。第 50 轮那行（内置服务表为空是否合法）是榜样的写法：它记的是被重读的
具体行号与 tag，而不是一个「已复核」的戳。

也就因此，**表里引用的上游行号不需要重看**：pin 相同意味着 commit 相同，同一个 commit
里的 `llm_cmd.go:261`、`providers.go:45` 必然仍指向同一段代码——行号不是欠账，**只有 pin
前进才是**。把「行号可能过期」当成待办，等于把同一个事实重新发现一遍。

| 对照点 | 上游文件 | 人工看什么 | 最近一次对照（轮次 / 日期） |
| --- | --- | --- | --- |
| provider 解析顺序 | `internal/llm/resolver.go` | 是否仍按 `cfg.Providers[cfg.Provider]`（原始拼写）读；大小写折叠、回退到 registry 拼写、miss 兜底任一变化都改变设置页「Key 属于哪条」的答案 → 同步改模拟（`UPSTREAM_RESOLVER`）与 `MATCH_RULES` | 第 45 轮 / 2026-10-27（上游 HEAD 未变） |
| `config set` 的 key 语法 | `cmd/opencodereview/config_cmd.go` | 点名到最后一个点的分段（带点的自定义名）、未配置带点名直接拒绝 | 第 45 轮 / 2026-10-27（上游 HEAD 未变） |
| 内置服务表 | `ocr llm providers` 输出 | 列、表头、失败时的 stderr 措辞 | 第 45 轮 / 2026-10-27（上游 HEAD 未变） |
| 内置服务表**为空**是否合法 | `cmd/opencodereview/llm_cmd.go` 的 `runLLMProviders` → `internal/llm/providers.go` 的 `registry` / `ListProviders` | `runLLMProviders` 无条件打印 `Built-in providers:` 表头与 `NAME / PROTOCOL / BASE URL` 列，行来自编译期 `registry` 切片，**一行都没有也不报错、退出码仍为 0**。所以「表读回来是空的」只可能来自装得不完整或我们丢了行——这是 `config-handler.js` 的 `TABLE_HOLLOW` 文案（「CLI 一定有内置服务名，所以这多半是装得不完整」）唯一的外部依据。上游若把 provider 改成可外挂/可配置（空 registry 成为合法状态），这句话就变成错的，`tableSilenceOf` 要跟着改 | 第 50 轮 / 2026-10-27（v1.13.3：`llm_cmd.go:261`、`providers.go:45`） |
| 运行期失败分类 | 运行 JSON 的 `failure_class` / 每文件 `failure_class` | 枚举值增删（`RunFailureClass` 与 `FailureClass` 是两张表） | 第 45 轮 / 2026-10-27（上游 HEAD 未变） |

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

这一节不再复述具体形状。机器可读区的标记与锚点、pin 恰好三处、通路账的通路与欠账对应、
以及「别把锚点字面量抄进人读区」（照抄就是第二份锚点），权威定义都在
`tools/upstream-watch.mjs` 的常量与 `machineReadableBlockViolations` /
`docAuthoringRuleViolations` 等判定函数里。改文档时直接跑 `npm run audit:upstream`；
红了会点名行号，再去那份代码里看这一条问的是什么。把规则抄一份到这里，只会多出一份
没人核对、却先过期的拷贝。

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

## 当前状态（第 94 轮，2026-10-27）

第 94 轮复核：**HEAD 未变，结论仍是「无新内容」；git 与 npm 均可核对。**
`375f64cd…` 与 pin 一致（与第 49–93 轮同一个 commit），`git ls-remote --tags --refs` 仍以
`refs/tags/v1.13.3` 为最高版本，`npm view @alibaba-group/open-code-review version` 仍是
`1.13.3`。**无移植项**。

本轮只动断言与注释，主题是「把第 93 轮已落地的行为，从边界与接线两侧钉牢」：

- **P0-1：`window-sender.js` 的三格边界。** 第 93 轮测了正常路径，但三个格子仍可被命名：
  ①未就绪且队列非空时再 `send()`——走的是排队分支，不是「flush 空转后误投」；
  ②已 ready 时重复 `markReady()`——队列非空时第一次 flush、第二次 `sent === 0` 且不重投；
  ③flush 中途失败时 `dropped` 不被污染——第 4 节的 `announcement` 与恢复调用都要求
  `lost === 0`。三格都在 `tools/window-sender-smoke.mjs`，模块本身未改。
- **P0-2：`main.js` 的接线。** 原来只断言「有 `markReady`、有 `limit`、有某个
  `run:log` 发送」；现在要求 `did-finish-load` 的回调里调 `markReady`、
  `createWindow()` 里调 `markUnready`，并且 `lost > 0` 的计数确实从 `markReady()` 读出、
  经 `send("run:log", { line: … })` 说出。构造式自测把「换通道」「忽略计数」「换 payload
  键」三种写法定否——任一改动都会先红。
- **P1-1：`dependencyPinViolations` 的盲区。** 第 93 轮只演了 `*`；现在 `*` / `latest` /
  空串一律按「读不出版本号」红，**不是**「无法比较即通过」；另补「pin 的 tag 不是版本号
  （如 `nightly`）要点名 tag」与「不带 `v` 的裸版本 pin 仍判一致」。
- **P1-2 / P2-1：注释补上取舍。** `window-sender.js` 顶部写明「页面始终没加载出来时
  `markReady()` 不会被调用，队列填满后丢弃是接受的取舍」；`send()` 里写明未就绪时
  `flush()` 第一行就返回 false，因此那条分支就是排队路径，避免读成「先试投一次」。

改动在 `tools/window-sender-smoke.mjs`、`tools/upstream-watch-smoke.mjs`、
`window-sender.js`（仅注释）、`docs/upstream-history.md` 与本文件。评审逻辑、CLI 参数、
配置读写路径与运行期行为均未动。`audit:sender` / `audit:upstream` 本轮全绿。

上一轮（第 93 轮）的正文见 [upstream-history.md](upstream-history.md#上游状态第-93-轮2026-10-27)，归档之后本文件不留第二份。

## 上游真变了怎么办（命令驱动，而不是「记得看一眼」）
```bash
npm run audit:service   # CLI 参数构建 / 四种模式的输出解析 / resolver 查找顺序的投影
npm run audit:config    # `ocr llm providers` 表与 config.json 的读写假设
npm run audit:git       # `git show` 的分类与按 ref 读文件
```
任一条变红就是「需要评估的上游变更」：先看红在哪条断言，再对照上面的 CLI/配置暴露点判断。

### `upstream:check` 与三处 pin 声明（第三处声明就在这里）

另有 `npm run upstream:check`：先比对 `refs/heads/main` 与本文件固定的整串 40 位 SHA `375f64cd6f67a48a135da83cfcf59c52669a09cb`（正文里引用只写 `375f64c` 前缀是为了好读；这一处与上面的块、下面的固定行同值，`audit:upstream` 三处一起核对）。
相等打印一行并注明 `通路：git`；git 不通时自动改走 `api.github.com/commits/main`，
成功则注明 `通路：api`（两条路问的是同一个 commit）。前进打印醒目提示并逐行列出上表 5 处对照点
（**不失败**，仍要人读源码）；两条路都失败才明确打印「跳过」，前缀固定为
`[UPSTREAM-DEBT]`、并写明两条路各自的原因，退出码恒为 0，因此可以挂在任何流程里而不会
把网络问题当成上游变更。**grep `[UPSTREAM-DEBT]` 就是这张欠账表**；每轮的 `通路` 也应
写进上面「核对通路账」。

三种答案对应三种 grep，不必读句子：

| grep | 含义 | 该怎么办 |
| --- | --- | --- |
| `[UPSTREAM-DEBT]` | 本轮**没核对** HEAD（git 与 API 都不通） | 下一轮补核对，并在通路账记一行欠账 |
| `[UPSTREAM-MOVED]` | 核对了，HEAD **前进了** | 重读它逐行打印的 5 处对照点，改 pin 与本文件 |
| 两者都没有 | 核对了，**没变** | 无需动作 |

「没变」刻意不带 marker：安静应该表示「没事要做」，任何 marker 都比安静更响。上面这张
表由 `tools/upstream-watch-smoke.mjs` 的 marker 断言钉住（该带的带、不该带的不带）。

`upstream:check` 依赖 `fetch` 与 `AbortSignal.timeout`，二者都在 Node 18 起稳定，这也是
`package.json` 的 `engines` 写 `>=18` 的原因之一（哨兵跑在 Node，不在 Electron 里）。

**pin 存全 40 位是有意的**：pin 若只存 7 位前缀，`375f64c…` 换成另一个同样以
`375f64c` 开头的 commit 会被判成「与对照表一致，无需重读」——那是这条句子唯一不能错的
方向（下面 5 行会一直没人重读，而句子是绿的）。所以「相等」的语义就是整串 40 位相等；
pin 或 ls-remote 给出的 SHA 短于 40 位时一律判「跳过」并说明原因，不做前缀匹配。
`tools/upstream-watch-smoke.mjs` 用 pin 的前 7 位 + 写死的 33 位尾串（`0123456789abcde…`，
不含 `f`）喂进去，要求判 `moved`；并前置断言这条夹具 ≠ pin——否则改 pin 时它会退化成
「拿 pin 和 pin 比」，那条检查会继续绿着而什么都没测。

### 能自动变红的地方，和不能的地方

`audit:service` 里的 `UPSTREAM_RESOLVER`（`tools/service-smoke.mjs`）是唯一一处**把上游语义
写进断言**的地方：它按 v1.13.3 `internal/llm/resolver.go` 的做法重算一遍「这次运行会打开哪
条条目」（`cfg.Providers[cfg.Provider]`，原始拼写、不折叠大小写、miss 不兜底），再要求
`entryByName` 指出同一条——所以上游改了「按哪个拼写找条目」，这条会先红。它红的时候先读
上游 HEAD 的 `resolver.go`，改的是 `MATCH_RULES` 和这段模拟，不是把断言放宽。

**`git-service.js` 的 `readFileAtRef` 按 stderr 措辞分类，代价在这里写清楚。** 它用两组
正则把 `git show` 的失败分成 `bad-ref`（引用不存在）与 `missing`（文件不在那个快照里），
两者都对用户说不同的话。这两组正则匹配的是 git 的英文措辞，所以模块固定了
`LC_ALL=C` / `LANG=C`（本地化 git 说的 `致命错误：无效的对象名称` 会落进通用分支）。断言
分两层，而且两层问的不是同一个问题：`tools/git-service-smoke.mjs` 的九条夹具是**手写
字符串**，它们证明「表同意自己」；第 83 轮起同一份 smoke 还会拿**真 git**打印的这两句
stderr（`missing` / `bad-ref` 各一句）过同一个分类器，要求每句只被一个带 pattern 的行认
出来、且与对应 `sample` 落在同一行。所以现在的边界是：**今天这套 git 的这两句话被钉住
了**——git 换了这两句措辞，`audit:git` 会红（这不是「本仓修不了」的红：改的是本仓的
pattern）。仍然没人钉的是**别的失败**：子模块、git 为其它情形保留的拼写、以及 git 从不
在这三处发出的措辞，都只能靠人读。代价的补偿照旧是通用分支必须可诊断——它带上 git 自己
的首行 stderr 与退出码，退出码是这条路上唯一不随语言变的部分。第 88 轮起，兜底分支还把
**未 trim 的原始 stderr** 放在返回对象的 `rawStderr` 上（只在该分支，不拼进用户可见的
`error`），`tools/git-service-smoke.mjs` 用一条表外措辞（`fatal: something new`）断言它
非空、用一条已识别措辞断言它不出现。第 89 轮补上了另一半：`error` 必须含同一份 stderr 的
**首行**（多行夹具同时要求不含第二行，第二行只在 `rawStderr` 里），并用一条**真 git** 的
非仓库失败走同一条 `readFileAtRef`，要求 `rawStderr` 非空、`error` 含其首行——所以「兜底
只能被 stub 构造」不再成立。这条通道让退化**可被看见**，但没有把表 miss 变红：表外的措辞
仍然按 `failed` 回答，只是 `rawStderr` 不再是空的。评审时若想动这两组正则，
请同时想清楚这两层各自覆盖什么，以及本节记录的那半个缺口。对应代码见 `git-service.js` 顶部 `gitEnv()`
注释（那里写了为什么固定 C locale、以及为什么代价的补偿是通用分支必须带退出码与 `rawStderr`）。

**但 audit 变红不等于覆盖完整**：下面这几处只有人工对照，改坏了不会让任何 audit 变红。

**`upstream:check`（哨兵）的退出码恒为 0，只报告不失败——它的绿不是安全网；`audit:upstream` 跑的是本套断言（pin 三处声明、对照表双射、通路账），是会 `exit 1` 的那一半——恒绿不是安全网，所以红色的那一半必须真的红。** 上游漂移的唯一安全网
是 `audit:service` / `audit:config` / `audit:git` 这三条，加上人工重读本节表格的 4 行；
哨兵打印「跳过」（git 与 API 都不可达）时同样是绿的，**绿只说明这条命令跑过，不说明上游
没变**，所以每轮的结论仍要写进上面「当前状态」——跳过时至少留下 `[UPSTREAM-DEBT]` 与
「核对通路账」里的一行欠账。

## 建议命令（agent 在 `/opt/open-code-review-desktop`）
```bash
# 若尚未加 upstream remote：
git remote add upstream https://github.com/alibaba/open-code-review.git 2>/dev/null || true
git fetch upstream --tags
git log --oneline HEAD..upstream/main 2>/dev/null || git log --oneline HEAD..upstream/master 2>/dev/null | head
gh release list -R alibaba/open-code-review --limit 5
```

也可对照本地若存在的 `/opt` 外 checkout；以 GitHub 上游为准。
