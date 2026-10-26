# 下一轮迭代

本文件记录**上游 `alibaba/open-code-review` 的状态**与**待移植项**。
规则见 [`OCR-UPSTREAM-SYNC.md`](OCR-UPSTREAM-SYNC.md)：每轮至少检查一次上游，
有更新就记在这里，不要静默忽略。

本文件只留**现状**：上游状态表、待办、最近两轮的正文。第 2–17 轮的加固正文和
已经划掉的待办搬到了 [`hardening-log.md`](hardening-log.md)——表和十几轮正文
挤在一个文件里，正是那张表漏过四行的温床。

---

## 上游状态（最近检查：2026-10-26，第 22 轮复核）

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
| 18 | 2026-10-26 | `375f64c`（2026-10-20） | `v1.13.3`（2026-10-22 发布） | 无新内容（`git fetch upstream --tags` 成功 + GitHub API 三核对：commits / tags / releases） |
| 19 | 2026-10-26 | `375f64c`（2026-10-20） | `v1.13.3`（2026-10-22 发布） | 无新内容（`git fetch upstream --tags` 成功 + GitHub API 三核对：commits / tags / releases） |
| 20 | 2026-10-26 | `375f64c`（2026-10-20） | `v1.13.3`（2026-10-22 发布） | 无新内容（`git fetch upstream --tags` + GitHub API 三核对：commits / releases；顶端 commit 与 tag 均未变） |
| 21 | 2026-10-26 | `375f64c`（2026-10-20） | `v1.13.3`（2026-10-22 发布） | 无新内容（`git fetch upstream --tags` + GitHub API 三核对：commits / tags / releases；顶端 commit 与 tag 均未变） |
| 22 | 2026-10-26 | `375f64c`（2026-10-20） | `v1.13.3`（2026-10-22 发布） | 无新内容（`git fetch upstream --tags` + GitHub API 核对 commits / tags；顶端 commit 与 tag 均未变） |

结论：第 2–12、14–22 轮都没有需要移植的新功能 / 修复 / 破坏性变更，desktop 的
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

## 第 21 轮 desktop 侧加固（与上游无关）

上游本轮无新提交（顶端仍是 `375f64c` / `v1.13.3`，见上面第 21 轮复核）。

### P0 — 保存的写序钉住：先把条目写完，再让运行指向它

`save` 把若干 `config set` 依次发出去，第一个被拒就停。所以顺序决定了「保存到一半」
已经做了什么：`provider` 若先发，后面 Key 被拒时配置已经指向一个没有 Key 的条目，
下一次运行会以「Key 不对」失败——而 Key 本身没错。`config-handler.js` 现在把这层
理由写在生成 pair 的地方；`tools/config-handler-smoke.mjs` 用两条精确序列断言
（内置服务 / 自定义服务）加一条后果断言（Key 被拒后 `provider` 仍停在原服务、
新拼写下没有半成品条目）。

**实测**：把 `provider` 挪到最前面 → 6 条变红。

### P1 — 被拒的 `code_comment` 批次不再算成一条评论

上游 `v1.13.3`（`375f64c`）把空批次从「成功」改成「错误」，CLI 的收尾行于是从
`✔ code_comment` 变成 `✗ code_comment failed: Error: none of the 'comments'
entries could be filed; …`。`ocr-service.js` 的计数器对每条收尾行都 `+1`，于是
一个什么都没写进去的批次会让运行页显示「已产出 1 条评论」。现在只有 `✔` 计入；
`SUMMARY_RE` 的 `Number(m[2]) || progress.comments` 也改成直接取 CLI 的总数——
「0 comment(s)」是结论，不是「没有新消息」。

**实测**：去掉 `mark !== "✗"` → 1 条变红；改回 `|| progress.comments` → 1 条变红。

## 第 20 轮 desktop 侧加固（与上游无关）

上游本轮无新提交（顶端仍是 `375f64c` / `v1.13.3`，见上面第 20 轮复核），不移植。

### P0 — 一次运行只有一个可注入的去处

第 17–18 轮把收尾的三句话归到 `run:log`，但 `makeRunHandler` 仍然收两个参数
（`log` 与 `warn`）：`main.js` 手工把同一个 `runLog` 传给两者，测试也只能证明
「源码里两处都写了 `runLog`」。这是一个可以被拆开的形状——调用方只要漏掉一个，
漏掉的那一半就退回 `console.warn`，而打包后的应用没有终端。

本轮把两个参数收成一个 `sink(line, id)`：CLI 自己的进度行与三句收尾话都从这一处
出去。默认值仍不同（没有注入时，CLI 行去 `run:log`，收尾话去 `console.warn`），
但应用注入的那一个 `sink` 同时覆盖两者，「只接一半」不再是这个模块能表达的状态。

**断言**（`tools/run-diagnostics-smoke.mjs`）：

- 注入一个 `sink`，CLI 行与 `signal-failed` 都落在它上面，且 id 是 CLI 给的那个；
- 同一个 `sink` 也接住 `settle-failed` 与迟到的写盘结果；
- 注入了 `sink` 时 `console.warn` 一行也收不到——回退路径确实没有被走；
- `main.js` 只写 `sink: runLog`，不再出现 `log:` / `warn:` 两个键。

**实测**：把每运行的 `report` 改回无条件 `console.warn` → 12 条变红。

### P0 — `removeEntry` 的失败已经会报出来，本轮补上夹具

`config-handler.js` 的 `removeEntry` 已经与 `save` 对齐
（`steps.find(s => !s.ok)` → `{ ok: false, error }`），但测试里没有「清空内置服务时
`config set` 返回一项失败」的夹具，所以这条行为没有被钉住。

`tools/config-handler-smoke.mjs` 新增：第二次写入被 CLI 拒绝时，`removeEntry` 返回
`{ ok: false }`，错误里带着失败的键与 CLI 的原话（`withHint` 之后）。

**实测**：把失败分支改回直接返回 `{ ok: true, cleared: true, steps }` → 3 条变红。

### 文档 — 第 17 轮搬进 hardening-log

`next-iteration.md` 只留最近两轮的正文；本轮加入第 20 轮后，第 17 轮按既定规则
搬进 [`hardening-log.md`](hardening-log.md)。

---

## 第 18 轮 desktop 侧加固（与上游无关）

上游本轮无新提交（顶端仍是 `375f64c` / `v1.13.3`，见上面第 18 轮复核），不移植。
本轮做两件事：把第 17 轮留下的**产品决定**落地（三句收尾话的去处），并把
`REF_LIMIT` 的截断钉成断言。

### P0 — 三句收尾话的去处：`run:log`，不是 stderr

第 17 轮把 `settle-failed` / `signal-failed` / 迟到写盘结果归到了同一个 `warn`，
但 `main.js` 根本没有注入 `warn`——那个「一个去处」就是主进程的 `console.warn`，
打包成 GUI 应用后没有终端可看。本轮选定解法一：**接 `run:log`**。

- `main.js`：`warn: runLog`，其中
  `runLog = (line, id) => send("run:log", { id, line })`。渲染进程的日志抽屉吃
  `run:log`，而 `TROUBLE_LINE`（`src/lib/format.ts`）匹配「失败」，所以这两句话
  会让抽屉自己打开。另一个方向（在 `userData` 下写日志文件）被放弃：还得再给用户
  一个读它的入口，而抽屉已经是现成的。
- `run-handler.js`：去处从「handler 构造时」挪到「CLI 回调里按 run 创建」。原因是
  渲染层传的 `spec` 没有运行 id，能拿到 id 的时刻只有 `onDone(id, result)`；用这个
  id，`run:log` 的 `{ id }` 与 `run:exit` 载荷里的 `id` 就是同一个。
- 没注入 `warn` 的调用方仍然落到 `console.warn`，而且三句话仍走同一个闭包。

**断言**（`tools/run-diagnostics-smoke.mjs`，+6 条）：

- 退出推送抛错 → 渲染进程的 `run:log` 收到 `signal-failed` 那句话（不再只进 stderr）；
- 该行登记在 CLI 给的 id 下（不是渲染层的 `spec.runId`），且没有第二份；
- 收尾 rejection → `settle-failed` 那句同样进 `run:log`；
- 不注入 `warn` → 同一句话仍然只去 `console.warn` 这一个地方；
- `main.js` 源码确实把 `warn` 接到了 `run:log`——行为断言只能证明 handler **能**
  这样接，证明不了应用**真的**这样接，而这正是前两轮漏掉的那一半。

**实测**：删掉 `main.js` 的 `warn: runLog` → 1 条变红；让 handler 不给 `warn`
传 id → 2 条变红（id 与 settle 那两格）。

### P1 — `REF_LIMIT` 的截断：命名 bases 必须活在前 40 名内

`inspect` 对 ref 排序后取前 40。注释说「named bases first」，但没有断言：夹具只有
三个分支，`refs.slice(0, 40)` 也能全绿，而 60 个分支的真实仓库里 `main` 可能被
截掉，界面于是把两个本可比的分支说成不可比。

`tools/git-service-smoke.mjs` 新增一个 60 分支的仓库：`b00`…`b57` 按字母序排在
`main` / `master` 之前，另配一个真实 upstream（bare remote + `push -u`）。断言
`refs` 仍是 60 个、`upstream` 是 `origin/main`、`main` / `master` / `origin/main`
都在 `relations` 里，而 `b57` 不在、`relations` 恰好 40 个。

**实测**：把排序改回 `[...new Set(refs)].slice(0, REF_LIMIT)` → 3 条变红
（三个命名 base 全部被挤出）。`git-service.js` 一行未改——这轮是给既有行为补断言。

### 文档 — 第 16 轮搬进 hardening-log

`next-iteration.md` 只留最近两轮正文；本轮加入第 18 轮后，第 16 轮按既定规则
搬进 [`hardening-log.md`](hardening-log.md)。

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
「一次运行结束时的三句话归到一个去处」钉住，第 18 轮把这个去处接到 `run:log`
并给 `REF_LIMIT` 的命名 bases 补上截断断言，第 20 轮把 `log` / `warn` 两个可注入点
收成一个 `sink`，并给 `removeEntry` 的失败补上夹具；剩下的按优先级排在这里，下一轮挑。标注「**未动**」的条目是
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
- **P2**：`git-service.js` 的 `REF_LIMIT` 排序里，`upstream` 是完整名（`origin/main`），
  而 `refs` 里是剥掉 remote 前缀的 `main`；两者指向同一 commit 时各占一个名额、
  各跑一次 `rev-list`，`relations` 里留下两个键（界面只按 `refs` 里的名字查，
  所以后果是多一次 spawn，不是错答案）。60 分支的夹具钉住了「命名 base 不被截掉」，
  但没覆盖「同一 commit 的两个名字」。要么排序时把 `upstream` 的短名放进集合并去重，
  要么把注释改成明说这是有意的。文件 `git-service.js` / `tools/git-service-smoke.mjs`。
  ——**未动**（第 20 轮复核确认仍成立）。
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
- **P3**：`RunFailureNotice` 的「CLI 原始原因可选中」目前没有对应的 UI 断言。


### 一处与上轮简报不同的做法（留给下一个人）

第 4 轮的简报建议「在 `userData` 目录下写探针文件」。第 4 轮**没有**这么做，理由写在
[`hardening-log.md`](hardening-log.md) 的「第 4 轮」的「P0 — store 的大小写」一节里：
store 的 key 是**仓库路径**，profile 卷的大小写
与它无关；在 macOS 上，profile（系统盘）的答案通常与仓库所在卷**正好相反**。
探针改成只读、只问仓库自己的路径。如果下一个人想改回去，先读那一段。
