# 下一轮迭代

本文件记录**上游 `alibaba/open-code-review` 的状态**与**待移植项**。
规则见 [`OCR-UPSTREAM-SYNC.md`](OCR-UPSTREAM-SYNC.md)：每轮至少检查一次上游，
有更新就记在这里，不要静默忽略。

本文件只留**现状**：上游状态表、待办、最近两轮的正文。第 2–15 轮的加固正文和
已经划掉的待办搬到了 [`hardening-log.md`](hardening-log.md)——表和十几轮正文
挤在一个文件里，正是那张表漏过四行的温床。

---

## 上游状态（最近检查：2026-10-26，第 17 轮复核）

上游 `alibaba/open-code-review` 自 desktop 锁定的 `v1.13.0` 之后发布了
**3 个补丁版本**：`v1.13.1` / `v1.13.2` / `v1.13.3`（共 18 个 commit）。
desktop 的依赖已升到 `^1.13.3`（`package.json` / `package-lock.json`），
影响最大的那个修复已移植（见下面「已移植的上游改动」）。

### 复核记录

**每一轮都新增一行**，哪怕结论是「无新内容」：这张表是上游复核的**唯一**记录，
一张会漏行的表比没有表更糟——它让人以为每一轮都记在这里。

| 轮次 | 日期 | 上游顶端 commit | 最新 tag / release | 结论 |
| --- | --- | --- | --- | --- |
| 2 | 2026-10-26 | `375f64c`（2026-10-20） | `v1.13.3` | 无新内容（fetch 因 `GnuTLS recv error (-110)` 失败，改用 API 核对） |
| 3 | 2026-10-26 | `375f64c`（日期未变） | `v1.13.3`（2026-10-22 发布） | 无新内容（API 核对） |
| 4 | 2026-10-26 | `375f64c` | `v1.13.3` | 无新内容（这次 `git fetch upstream --tags` 成功，与本地 ref 一致） |
| 5 | 2026-10-26 | `375f64c`（2026-10-20） | `v1.13.3`（2026-10-22 发布） | 无新内容（`git fetch` 成功 + API 双核对） |
| 6 | 2026-10-26 | `375f64c` | `v1.13.3` | 无新内容（见 [`hardening-log.md`](hardening-log.md) 的「第 6 轮」） |
| 7 | 2026-10-26 | `375f64c` | `v1.13.3` | 无新内容（`git fetch` + GitHub API 双核对） |
| 8 | 2026-10-26 | `375f64c` | `v1.13.3` | 无新内容（核对方式沿用上一轮） |
| 9 | 2026-10-26 | `375f64c` | `v1.13.3` | 无新内容（GitHub API 核对；`git fetch` 在沙箱里挂住） |
| 10 | 2026-10-26 | `375f64c`（2026-10-20） | `v1.13.3`（2026-10-22 发布） | 无新内容（GitHub API 三核对：commits / tags / releases） |
| 11 | 2026-10-26 | `375f64c`（2026-10-20） | `v1.13.3`（2026-10-22 发布） | 无新内容（GitHub API 核对 commits / tags；顶端 commit 与 tag 均未变） |
| 12 | 2026-10-26 | `375f64c`（2026-10-20） | `v1.13.3`（2026-10-22 发布） | 无新内容（GitHub API 三核对：commits / tags / releases） |
| 13 | 2026-10-26 | — | — | 未留下复核记录（该轮只补了 `run-handler.js` 的正文，没有查上游） |
| 14 | 2026-10-26 | `375f64c`（2026-10-20） | `v1.13.3`（2026-10-22 发布） | 无新内容（GitHub API 三核对：commits / tags / releases） |
| 15 | 2026-10-26 | `375f64c`（2026-10-20） | `v1.13.3`（2026-10-22 发布） | 无新内容（GitHub API 三核对：commits / tags / releases） |
| 16 | 2026-10-26 | `375f64c`（2026-10-20） | `v1.13.3`（2026-10-22 发布） | 无新内容（GitHub API 三核对：commits / tags / releases） |
| 17 | 2026-10-26 | `375f64c`（2026-10-20） | `v1.13.3`（2026-10-22 发布） | 无新内容（`git fetch upstream --tags` 成功 + GitHub API 三核对：commits / tags / releases） |

结论：第 2–12、14–17 轮都没有需要移植的新功能 / 修复 / 破坏性变更，desktop 的
封装（CLI flag、输出解析、配置暴露点）无需改动；第 13 轮没有留下复核记录。
顶端 commit 仍是 `375f64c`（2026-10-20，`fix(tool): report an empty code_comment
batch instead of success (#1773)`），最新 tag / release 仍是 `v1.13.3`。

> 这张表以前漏了第 6–9 轮：正文里每一轮都记着自己的核对方式与结论，表里却没有
> 对应的行——**表少了四行，正文不缺**。那些正文现在在
> [`hardening-log.md`](hardening-log.md) 里，行是照着正文补齐的，核对方式与结论
> 没有另编。

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

## 已移植的上游改动

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

## 第 17 轮 desktop 侧加固（与上游无关）

上游本轮无新提交（顶端仍是 `375f64c` / `v1.13.3`，见上面第 17 轮复核），不移植。
本轮做一件事：**把「一次运行结束时的那几句话」钉到同一个去处**，并复核简报里
P0-1 / P1-1 两条。

### P0 — 一次运行的结束，只有一个去处

`run-handler.js` 这条路上有三句关于「这次运行怎么结束的」的话，严重程度不同，
去处却有两个：

| 句子 | 谁说的 | 讲的是什么 |
| --- | --- | --- |
| `settle-failed` | handler 自己的 `catch` | 收尾根本没做完，退出信号可能没发 |
| `signal-failed` | `settleRunExit` 里面 | 证据在盘上，只是推送失败 |
| 迟到的写盘结果 | `onLate` | 写盘在越过上限之后才落地 |

三句里**只有第一句**走 handler 的 `warn`（也就是注入的那个去处）。后两句走的是
`settleRunExit` 自己的 `warn`——而 **handler 以前根本没给它**：
`settleRunExit` 把 `opts.warn` 透传给 `reportOutcome`，没给就退回 `console.warn`。
于是：

- 注入一个 `warn` 的调用方只看得到**一半**；
- 另一半进了主进程的 stderr。它不会进渲染进程的日志抽屉（抽屉吃的是
  `run:log`），开发时在终端里看得见，打包成 GUI 应用后没有窗口可看。

改动很小：`run-handler.js` 把同一个 `log`（注入的 `warn`，没有就
`console.warn`）交给 `settleRunExit` 的 `warn` 与 `onLate`。三句话从此一个去处。

**断言**（`tools/run-diagnostics-smoke.mjs`，+7 条，走 handler 而不是直接调
`settleRunExit`）：

- 退出推送抛错 → 报的是 `signal-failed`（那句「退出信号推送失败」），**不是**
  `settle-failed`（那是另一件事：收尾根本没做完）；
- handler 自己的最后一道报告没有触发；
- 那个去处里**只有这一句**（一句不多），推送也只发生了一次；
- 证据在推送失败之前就已经在盘上；
- 越过上限之后才落地的写盘，结果也进同一个去处。

**实测**：把 `warn` 的接线去掉 → 3 条变红（`signal-failed` 那句与迟到的写盘结果
都不在去处里）；把 handler 的 `try/catch` 改回 `.catch(() => {})` → 5 条变红
（简报的验收条件是「至少 2 条」）。

### 复核 — 简报的 P0-1 与 P1-1，已经钉住了，不用再做

- **P0-1（`makeRunHandler` 的端到端断言）**：`tools/run-diagnostics-smoke.mjs`
  里已经有「the settle that never finishes」一节——它就是用 `makeRunHandler` 造
  handler、让 `startRun` 回调 `onDone`，然后断言 `reportOutcome` 收到的是
  `settle-failed`、日志里是 `settleFailedMessage()` 那句、退出信号**没有**发出去
  （门没开），以及那个拒绝被处理掉（没有 unhandledRejection）。简报担心的
  「只钉了 `settleRunExit` 本身」是旧状态：那一节是端到端的。本轮补的是它
  **没覆盖的那一格**——推送失败走 `signal-failed` 而不是 `settle-failed`
  （见上），以及这两句话的**去处**。
- **P1-1（`savedKey` 的参数形状）**：`tools/bridge-contract.mjs` 的探针按接口
  声明的字段名逐个打标记，检查它们到达主进程时还在原来的名字下。实测把
  `preload.js` 的 `savedKey` 改回两个位置参数
  （`(name, url) => invoke(..., { name, url })`）→ **2 条变红**（参数个数 + 值的
  去处）。不需要再加断言。

### 仍然开放 — `signal-failed` / `settle-failed` 在真实应用里仍然读不到

本轮把三句话**归到一个去处**，但这个去处今天仍然是 `console.warn`。这两句是
唯一**没有退出信号可搭**的话（推送失败时根本没有退出信号，收尾失败时收尾本身
没做完），所以它们到不了渲染进程的日志抽屉——store 的结果在退出信号**送达**时
是跟着 payload 走的，渲染进程会写进日志，而这两句没有 payload。

「界面可能仍显示运行中」这句话本该由日志抽屉自己打开（`TROUBLE_LINE` 匹配
「失败」），所以缺的不是措辞，是去处。改法有两个：接 `run:log`（进抽屉，会让
抽屉自己弹出来），或者写主进程的日志文件。**这是产品决定**，下一轮再定。

---

## 第 16 轮 desktop 侧加固（与上游无关）

上游本轮无新提交（顶端仍是 `375f64c` / `v1.13.3`），所以下面每一件都是
desktop 自己的事。

### P0 — 拼写冲突的拒绝：两段都冲突时，两段都要说完

`8afdb58` 把「拒绝的时候说清旧条目在哪一段」钉住了——拒绝的话里带上了段名。
但它只说了**一段**。

两段都冲突是真的存在的：注册表（`ocr llm providers`）读不到时，desktop 不知道
CLI 会读 `providers` 还是 `custom_providers`，于是两段都查。两段各有一条同拼写
条目时，旧的拒绝只点名了先查到的那一条：

> 配置里已有 deepseek（在 providers 段），与表单里的 DeepSeek 只差大小写；……
> 请改用已有的拼写 deepseek。

用户照着做——把表单改成 `deepseek`——保存过去了（精确命中就不再冲突），而
`custom_providers` 段里那条**还在**，还带着一把 Key。CLI 读哪一段取决于这个名字
在它自己的服务表里算不算内置名（`tryProviderConfig` → `LookupProvider`），
desktop 恰恰读不到那张表，所以它没有资格替用户选一条。

现在 `spellingClash` 收下全部同拼写条目（`others`），拒绝的话把两条都点名，
并说清「这一版没能读到那张表，说不准它会读哪一段」，请把不要的那一条在配置
文件里改掉或删掉，再改用要留的那条的拼写保存。只有一条时的话一个字未改。

**断言**：旧行为是 bug，不是契约——`8afdb58` 钉的「另一段不出现」本轮明确改掉。
新的断言用「点名次数」而不是固定措辞（`custom_providers` 里含 `providers`，
`includes` 分不开两段）：

- 两段都冲突 → 两段各被点名一次，两个条目名都出现；
- 两段都冲突 → 拒绝的话里**不再**出现「请改用已有的拼写」（那正是把用户送到
  错误那一条的话），并要求把另一条「改掉或删掉」；
- 只有一段有 → 另一段**不得**出现（否则就成了一句「另一段也查过了」的废话）。

去掉修复 → 4 条变红；多点名一段 → 1 条变红（均实测）。

### 复核 — 简报里 P1 的两条，已经钉住了，不用再做

- **`git-service.js` 的 `bad-ref` / `missing` 分类**：`tools/git-service-smoke.mjs`
  已经用**真实 git** 造过这两种失败（`git show no-such-ref:a.go`、
  `git show HEAD:only-in-worktree.txt`），断言 `reason` 分别是 `bad-ref` /
  `missing`；中文 locale 下还有同样两条（`LC_ALL=C` 是让它们成立的原因）。
  正则失配会直接变红，不会静默降级到 `failed`。
- **`SETTLE_FAILED` 路径**：`tools/run-diagnostics-smoke.mjs` 已经钉了
  「settle 抛错 → 报 `SETTLE_FAILED` → 日志里是那句说「退出信号可能没有发出」
  的话 → 退出信号确实没发（settle 握着那扇门）这件事被说出来，而不是安静地
  过去」，还有 `outcomeLogMessage` 与 `outcomeMessage` 的分工。

两条都是「已经有了」，本轮不重复做。

### 文档 — `next-iteration.md` 拆成「现状」与「归档」两份

第 2–14 轮的加固正文和已经划掉的待办搬进了 [`hardening-log.md`](hardening-log.md)，
本文件只留上游状态表、待办和最近两轮。理由是这张表以前漏过四行，而表和十几轮
正文挤在一处正是漏行的温床。搬完之后那张表是上游复核的**唯一**记录，所以
「每轮都新增一行，哪怕结论是无新内容」写进了表头。

---

## 待移植 / 待验证

**规则**：本节只留 `[开放]` 的条目——还没做的，或者结论是「要做、但还没做」的。
已经做完的（`[关闭]`）与查过之后确认**不用改**的（`[无需改动]`）都搬去了
[`hardening-log.md`](hardening-log.md)。理由和上一轮拆文件一样：**标题层不区分
状态**，下一轮的人会把已经关掉的条目当待办，而「已关闭」这三个字藏在正文里，
正是那张表漏过四行的同一个毛病。

### [开放] P1 — 空 code_comment 批次现在算工具失败（`v1.13.3` `375f64c`，#1773）

CLI 之前把空的 `code_comment` 批次报成成功，现在报成错误。
desktop 的「工具调用 N（失败 M）」直接读 CLI 的 `tool_calls.failure`，数字会更诚实，
**无需改代码**；但 `audit:service` 的夹具里没有空批次场景，可以补一条。

### [开放（产品口径待定，不是代码问题）] P2 — README 的「Features」表要不要提语言支持

`v1.13.2` 往 CLI 自己的 allowlist / rules 里加了几种语言：`1325261` Shader
Languages、`6d68b1a` Nushell、`46790d9` PowerShell 审查规则、`9867a3d` OpenTofu
的 `.tofu` 扩展名。

desktop 不暴露语言清单，**代码无需改动**；但 README 的「Features」表目前没提
语言支持——要不要宣传、怎么写，是**产品口径**，不是代码问题，等一个决定。

### 与 desktop 无关

这一组查过之后 desktop 不用动（依赖安全更新、grpc 升级、MCP 分页、NixPkgs 的
provider 目录、上游 CI 的 PR 策略），正文搬去了
[`hardening-log.md`](hardening-log.md)。这里只留一个指针，免得下一轮的人
再抄一遍。

---

## 仍然开放的事项（非上游）

第 5 轮收了「模型名按形态对齐上游」与「`MAX_ENTRIES` 全局裁剪」，第 6 轮收了
「按名字选配置段」，第 7 轮收了 `entryByName` 的变体取舍，第 8 轮把 Key 归属判定搬进
主进程，第 9 轮把这条判定真正接到屏幕上并收掉端点那一端，第 10 轮把「`order` 规则
必须扣下 Key」「两个通道只读一次表」「查不到答案不许替它编」这三条钉成断言，第 12 轮
把「`classifyRef` 的四种答案」「运行出口只有一扇门」「服务列表也只读一次表」这三条
钉成断言，第 14 轮把「`reportOutcome` 自抛不得带走调用方」与「`MAX_ENTRIES` 轮换后
的静默」钉住，第 15 轮把「拼写冲突时说的是哪一段」钉住并复核了「`MATCH_ORDER`
必须扣 Key」那条链，第 16 轮把「两段都冲突时两段都要说完」补上，第 17 轮把
「一次运行结束时的三句话归到一个去处」钉住；剩下的按优先级排在这里，下一轮挑。标注「**未动**」的条目是
最近一轮看过、确认仍然成立但没有改的——不是新发现。

- **P2**：README 的 Status 段落里有**一次实测值**（`1200 findings` / `405ms` /
  `8s ceiling`）。实测数字会腐，腐了之后没有任何测试会红。README 承诺的应该是**能力**
  （能渲染 1200 条、有 8s 预算），不是某次跑出来的毫秒数——把数字挪进 `docs/`，或
  改成「实测值见 `tools/ui-audit/` 的输出」。文件 `README.md` / `README.zh-CN.md`。
  ——**未动**（第 12 轮只做了断言，没碰 README）。
- **P2**：`audit:ui` / `audit:ui-scaled` / `audit:contrast` / `audit:guards` /
  `audit:e2e` 每个脚本前面都各带一次 `npm run build`，一次完整 audit 要 build 五次。
  合并成一次（让 `audit` 脚本先 build 一次，后面的检查都假设 `out/` 存在）能省掉
  四次构建。文件 `package.json`。——**未动**。
- **P1**：`git-service.js` 的 `inspect` 用 `ranked.slice(0, REF_LIMIT)`（40）截断，
  **被截掉的 ref 在 `relations` 里没有条目**。`REF_LIMIT` 的注释说「named bases
  first」，但没有断言钉住「`upstream` / `main` / `master` 一定在前 40 名内」——
  仓库有 60 个分支时 `main` 可能被截掉，界面就会把两个可比分支说成不可比。
  文件 `git-service.js` / `tools/git-service-smoke.mjs`。——**未动**（第 15 轮简报
  提出，本轮只做了拼写冲突那一件）。
- **P1**：`config-handler.js` 的 `save` 先写 `providers.<name>.<field>`，**后**写
  `provider`。这个顺序依赖上游「写字段不必先选中服务」的行为；上游若改成要求先
  `config set provider <name>` 才能写条目，desktop 会半途失败——`steps` 里有
  `ok:false` 能被 `failed` 抓到，但错误信息指向字段名（`providers.X.api_key: …`），
  而不是「请先选服务」。这个顺序是有意的还是只是碰巧能用，没有断言钉住。
  文件 `config-handler.js` / `tools/config-handler-smoke.mjs`。——**未动**。

- **P1**：`entryByName` 的「精确命中优先」与上游的「按名字选段」在**同名跨段**时
  不一致。`tryProviderConfig` 先查注册表决定读 `providers` 还是 `custom_providers`，
  然后用配置里的原始字符串去读那一段；而 `entryByName` 是 `providers[name] ||
  custom_providers[name]`，所以一个**自定义名**同时被手改进 `providers` 段时，desktop
  会拿 `providers` 那条（CLI 不会读的）里的 Key。第 6 轮的 `readConfigView` 已经按段
  读，`entryByName` 还没跟上——它缺的是注册表，所以要么把注册表传进去，要么让调用方
  先判段。文件 `ocr-service.js`。——**仍未动**（第 10 轮只把 `order` 规则扣 Key 这条
  钉住，没有碰选段）。
- **P1**：「条目没有写端点」与「Key 属于另一个端点」现在共用 `url-mismatch` 一句话
  （「已保存的 Key 属于另一个端点」）。对前者这句话其实不准确——那条记录谁也没写
  端点，Key 不属于任何端点。修法有两条：加第 7 种原因（措辞表、语气表、UI 夹具、
  本文档的「六种」都要跟着改），或者把这句话改成两种都成立的写法。第 9 轮把这条
  行为**钉住**并在 `tools/service-smoke.mjs` 的注释里写清它指的是什么，但没改措辞。
- **P2**：渲染层那一端（设置页把哪个端点发给主进程）现在没有断言看着——它只做一次
  查表（`config.endpoints[name]`），没有自己的规则，但**万一**有人把优先级写回去，
  `tools/service-smoke.mjs` 看不见（它测的是主进程那两端）。第 9 轮留下的形状是：
  渲染层不再有规则可写错，但也没有一条断言能证明这一点。文件
  `src/components/SettingsPanel.tsx`。——第 10 轮给渲染层补了一条 UI 断言，但补的是
  「查不到答案时怎么说话」，**不是**「端点只查表」这一条；后者仍然没有断言看着。
- **P1**：`tools/ui-audit/fixtures.mjs` 的 `run_manifest.schema_version` 是手写常量，
  `ocr-service.js` 实际读的字段集合没有断言看着。上游改 manifest schema 时，夹具会继续
  喂旧形状而没人发现。加一条「夹具字段集合 = 服务端读取的字段集合」的断言。
- **P2**：设置页的 `loading` 态（「正在确认是否已有可用的 Key…」）是转瞬即逝的，
  `tools/ui-audit` 抓不到它——夹具的 `savedKey` 立刻 resolve。要钉住它得让 stub
  挂住不答，那是另一件事。
- **P2**：`writeAll` 的 Windows 回退分支里 `unlink(tmp)` 失败被吞掉，进程立刻退出
  会留下 `*.tmp` 垃圾。文件 `run-diagnostics.js`。——**未动**。改成把失败记进
  outcome。
- **P3**：`finding.tsx` 的 `RunFailureNote`（只显示 tooltip）与 `RunFailureNotice`
  （可见文本）名字相近，看代码的人容易认错。文件 `src/components/finding.tsx`。
- **P3**：`settleRunExit` 的 `signal-failed` 分支——这一行到底写到哪里、用户在
  renderer 已销毁时能不能看见。第 17 轮**查清楚了**：它写进主进程的
  `console.warn`（stderr），不会进渲染进程的日志抽屉（抽屉吃的是 `run:log`），
  打包成 GUI 应用后无处可看。`settle-failed` 同理。store 的结果在退出信号
  **送达**时是跟着 payload 走、用户看得见的，只有这两句没有 payload 可搭。
  改法有两个（接 `run:log` 进抽屉 / 写主进程日志文件），**是产品决定**，
  下一轮再定。文件 `run-handler.js` / `run-diagnostics.js`。
- **P3**：`RunFailureNotice` 的「CLI 原始原因可选中」目前没有对应的 UI 断言。


### 一处与上轮简报不同的做法（留给下一个人）

第 4 轮的简报建议「在 `userData` 目录下写探针文件」。第 4 轮**没有**这么做，理由写在
[`hardening-log.md`](hardening-log.md) 的「第 4 轮」的「P0 — store 的大小写」一节里：
store 的 key 是**仓库路径**，profile 卷的大小写
与它无关；在 macOS 上，profile（系统盘）的答案通常与仓库所在卷**正好相反**。
探针改成只读、只问仓库自己的路径。如果下一个人想改回去，先读那一段。
