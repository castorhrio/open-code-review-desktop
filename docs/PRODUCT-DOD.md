# open-code-review-desktop 产品标准锁定稿（locked / live）

> 状态：**locked / live**（2026-10-31 Asia/Shanghai 锁定）——已同步进 live scheduler / control prompts，是本产品过线的唯一标准；`npm run audit:upstream` 会拒绝任何回到 draft 的头部  
> 用途：给 agent 下一刀 / TODO / next-iteration 的**唯一合法输入源**：只许 DoD 未勾选 ∪ 当周反馈 ∪ 回归/断链/合规/上游 pin 破裂；勾满即停手  
> 归属：本文件是 scheduler 侧 `/opt/agent-scheduler/docs/product-dod/open-code-review-desktop-dod.md` 在产品仓内的同源副本，条目以 scheduler 侧为准，编码侧只读不改  
> 形态：OSS 桌面壳，封装 **未修改** 的官方 `alibaba/open-code-review`（`ocr`）二进制；**非官方**须诚实声明  
> 发版：`v0.1.13` 对照上游 `ocr v1.13.5`；安装包/portable 在 Releases  
> 代码：`/opt/open-code-review-desktop` · GitHub `castorhrio/open-code-review-desktop`  
> **不改** live scheduler、config.yaml、产品业务代码

---

## 一句话黑核心竞争力

不重写审查引擎：用桌面 GUI 把官方 `ocr` 的范围确认、成本护栏、截断诚实态、续跑与会话，变成「看得见且不容易做错」——并钉死上游 pin，漂移会红。

---

## 竞品对照（1–3）

| 对手 | 对方强在 | 我们的差异 |
|---|---|---|
| **官方 `ocr` CLI**（alibaba/open-code-review，45k+ star） | 引擎本体、更新快 | GUI：预览不花钱、预算/超时显式、截断不装「干净通过」、续跑按钮按 CLI 真实能力显隐 |
| 其它 AI Code Review SaaS / IDE 插件 | 集成深、品牌 | 本地封装官方二进制；Key 走 `ocr config`，本程序不另存副本 |
| 【待核验】其它非官方 ocr GUI 若出现 | — | 只比「上游未改二进制 + 诚实截断 + upstream audit」 |

平台话术：英文 README 写跨平台发版；中文侧强调 **Windows x64 已验证**——对外须按实际验证面诚实，未验证平台标【待核验】不得当已支持。

---

## Definition of Done（v0.1.x 可航运）

每条前面那个 `DOD-<n>：` 是稳定 ID，`npm run audit:upstream` 靠它数「哪几条还没勾」；勾上一条时
必须同时写「证据：<仓内路径>」，指向仓里那份记录（`tools/upstream-watch.mjs` 的
`dodCheckboxViolations`）。ID 与勾选状态以 scheduler 侧同源副本为准，编码侧只补 ID、不改勾选。

条目下面缩进的那行「证据候选：<仓内路径>」先回答另一半问题：**这一条若要勾，该去仓里翻哪份记录**。
它不是勾选，也不代替证据——`dodEvidenceCandidateViolations` 只要求每条都至少有一个候选、且候选路径
真的存在，于是「一直不勾」不再是一个合格的静默状态：没有候选的条目会被逐条点名。候选给多条时按行列，
第一条算主记录。

每条没勾的条目下面还有一行「未勾原因：<一句话 + 仓内路径>」：它回答的是另一半问题——**这一条为什么
现在还不能勾、什么条件下能勾**。`dodReasonViolations` 要求每个 `[ ]` 都有这一句、句子要指到仓里一份
真实存在的记录、不许写「待定」这类占位词，而已经勾上的条目反过来不许再留着它（勾上之后那句
「为什么还没勾」就是假话）。它不催勾，只要求「还没勾」是一个被回答过的状态，而不是没人看过。

- [ ] DOD-1：**非官方诚实**：README / 关于页 / 安装说明显著写明 unofficial；不冒充阿里巴巴官方产品
  未勾原因：这一条要的是「陌生人第一眼就看见非官方」的外部证据，而仓里只有 `README.zh-CN.md` 与设置页的措辞断言，没有一次真人阅读记录；等陌生人试用反馈里出现「以为这是阿里官方桌面版」时补上。
  证据候选：README.zh-CN.md（首屏、安装段、归属声明三处的「非官方」声明）
  证据候选：src/components/SettingsPanel.tsx（设置页「关于」区的归属声明）
- [ ] DOD-2：**引擎未改**：审查逻辑零分叉；仅拼 CLI、流式日志、解析 JSON、GUI
  未勾原因：原先那句「参数面仍有成片没逐条核过」从第 114 轮起是假话——`tools/cli-surface.mjs` 把本仓真的交给 `spawn` 的 18 条命令行与 12 条命令的 `--help` 双向比了一遍（57 行要拼 / 10 行不收 / 15 行有理由地不用，另含 `--preview` 不带 `--resume` 与版本行归属两条契约），第 111 轮记的 `--max-tools` 差距也已在这张表里逐字对上；这一条仍不勾，因为勾选归 scheduler 侧，且它对照的是**参数面**，不是上游规则表本身——这条边界写在 `docs/OCR-UPSTREAM-SYNC.md` 第 114 轮。scheduler 侧要确认的是：把 `tools/cli-surface.mjs` 里那张参数表当作「引擎未改」的证据写进它那份同源副本，并核对两件事——本仓与副本的六条 ID / 方括号逐条一致、勾选时证据写成 `tools/cli-surface.mjs`；编码侧不自报勾选。
  证据候选：ocr-service.js（只 spawn 官方 CLI、拼参数、解析 JSON 与流式日志，无审查规则）
  证据候选：tools/service-smoke.mjs（按上游 resolver 语义重算「这次运行会打开哪条条目」）
- [ ] DOD-3：**上游同步**：`docs/OCR-UPSTREAM-SYNC.md` pin 与 `npm run audit:upstream` 绿；跟进上游 tag 有记录（当前 pin v1.13.5 / 约定 SHA）
  未勾原因：pin 与对照表有断言，但这一条要的是「跟进上游 tag 有记录」的连续性，而 `docs/OCR-UPSTREAM-SYNC.md` 的通路账里还留着几轮只核了 release 的欠账；等连续几轮 HEAD 都真的核过再勾。
  证据候选：docs/OCR-UPSTREAM-SYNC.md（pin 三处声明与对照表）
  证据候选：tools/upstream-watch-smoke.mjs（pin 与对照表的双射、通路账、DoD 版本事实）
- [ ] DOD-4：**主路径可演示**：四范围 + `--preview`；成本护栏；完成/部分/失败/警告徽章；预算截断不显示「干净」；续跑仅在 CLI 支持的模式显示
  未勾原因：首启链路已经有人走过了——空档案 → 引导卡三步 → 选仓 → 配 provider → 清单自己算出来 → 成本确认挡住的那一次 `scan`，全在真 Electron 里跑（`tools/e2e-first-run.cjs`）；「预算截断」从第 130 轮起也不用真花钱了——`tools/fake-provider.mjs` 按被 pin 的那一版二进制真发的请求形态作答，`npm run audit:provider` 在本机 loopback 上真跑出一次 `summary.budget_exceeded=true` 的截断（连同完成态、全量扫描、provider 挂掉共四种结局，0 token）。第 131 轮又把「结束时的语气」从退出码改成从徽章派生，`tools/format-notice-smoke.mjs` 逐条钉住十种结局的语气、标题与「徽章颜色就是提示语语气」。第 133 轮补上了最后那一屏：`tools/e2e-fake-provider.cjs` 在真 Electron 里把这份 fixture 接着起了一次运行——预算从表单填 25000、`--max-tokens-budget 25000` 真的进了命令行、结果页与报告页都渲染出那条标记发现，读回来的 `data-run-status` 是 `limited`（徽章文字「未审完」）、提示语是 warning 语气且不写「完成」，同一趟的对照运行仍是 `complete` / 完成；反向控制也真跑过：把 `statusBadge()` 的 `limited` 分支删掉后这一趟红在「徽章写了完成」与「提示语写了完成」两条上。第 135 轮把最后那一格补上了：`tools/e2e-fake-provider.cjs` 的第三趟在真 Electron 里切到「单个提交」、填上 fixture 那个 `topic` 提交的 SHA、按下开始审查，spawn 日志里逐字读到 `--commit <sha>`，结果页读回 `data-run-status=complete` 与那条标记发现；判据是 `tools/e2e-fake-provider-rules.cjs` 的 `commitScopeViolations`（只认不带 `--preview` 的那次 spawn，预览也带 `--commit`，不能拿它冒充运行）。四范围的运行级证据至此齐了（工作区、分支对比、全量扫描、单个提交）。这一条仍不勾，因为勾选不在编码侧，且它要的是整套主路径的合并判断：把 `tools/e2e-fake-provider.cjs` 与 `tools/e2e-fake-provider-rules.cjs` 当作四范围运行级的证据写进它那份同源副本，并核对两件事——本仓与副本的六条 ID / 方括号逐条一致、勾选时证据写成这两条路径；编码侧不自报勾选。
  证据候选：tools/e2e-flow.mjs（真 Electron + 真 CLI 走完预览与四范围）
  证据候选：tools/e2e-flow.cjs（真 Electron 里断言预览与分支对比范围的那几条 check）
  证据候选：tools/e2e-first-run.cjs（真 Electron 里走完首启 → 引导 → 配 provider → 预览，以及成本确认挡住的那次 spawn）
  证据候选：tools/fake-provider-smoke.mjs（真 CLI 在假 provider 上跑出的四种结局：完成 / 预算截断 / 全量扫描 / provider 挂掉）
  证据候选：tools/e2e-fake-provider.cjs（真 Electron 里渲染截断那一屏：徽章读数、截断条、提示语，以及同一套规则的完成态对照）
  证据候选：src/components/ResultsPanel.tsx（完成／部分／失败／警告徽章与截断态）
  证据候选：tools/format-notice-smoke.mjs（十种结局的语气与标题、徽章颜色与提示语语气一致、STATUS 闭集）
- [ ] DOD-5：**航运资产**：`v0.1.13`（或更新）`*-setup.exe` / portable 可装可启；内置二进制可达；未签名 SmartScreen 有说明
  未勾原因：`docs/measurements.md` 记的真机面是 Linux x64，而发布面只有 Windows x64 的 `*-setup.exe`，安装包本身从未被装过一次；缺的那一趟已经写成 `docs/win-install-checklist.md`（逐项写明验什么、期望读数、读数记回哪一行），有人按它在 Windows x64 上装一次、把读数贴回 `docs/measurements.md` 之后，这一条才具备被勾的条件。**阻塞原因（2026-11-04）：本机是 Linux x64，NSIS 包装层与 portable 产物在这里无法执行**——所以这一条现在缺的不是「再写一份清单」，而是一台 Windows x64 机器加一次按 `docs/win-install-checklist.md` 第 10 节走完的四格读数；读数贴回 `docs/measurements.md` 之后才谈勾选。
  证据候选：docs/measurements.md（真机记录，以及「没验证过什么」那一节）
  证据候选：tools/release.mjs（发版脚本停在人操边界前）
- [ ] DOD-6：**安全底线**：Key 不进本程序副本；`asar` 保持 false（spawn 契约）；发版密钥扫描绿
  未勾原因：`asar` 保持 false、Key 只经 `ocr config set` 写入、发版前密钥扫描（`tools/secret-scan.mjs`）三条都有断言，缺的是「装好的那一份里 Key 真的不在本程序目录」的实测；这一遍怎么翻写在 `docs/win-install-checklist.md` 的第 5、7 步（程序目录、Electron 用户数据目录、卸载后重装各看一次），读数贴回 `docs/measurements.md` 之后才够勾。**阻塞原因（2026-11-04）：本机是 Linux x64，装不出也装不上 `*-setup.exe`，所以「装好的那一份」在这里不存在**——这一条缺的是一次真机上的目录搜索，不是又一条断言；能勾的条件只有一条：有人在 Windows x64 上按 `docs/win-install-checklist.md` 第 5.2 步搜一次程序目录，把结果贴回 `docs/measurements.md`。
  证据候选：package.json（`asar` 保持 false 的 spawn 契约）
  证据候选：config-handler.js（Key 只经 `ocr config set` 写入，本程序不存副本）
  证据候选：tools/secret-scan.mjs（发版前的密钥扫描）

---

## 勾选状态一览

六条里已勾 0 条、未勾 6 条。这张表只回答「现在一共勾了几条、每条为什么不勾」；详细的那句话仍写在
上面每一条下面的「未勾原因：」行里，表里这句是**复述**，不是第二个说法。`npm run audit:upstream` 的
`dodSummaryViolations` 逐行核对四件事：数字与方括号一致、状态列与方括号一致、六个 ID 一个不多一个不少、
一句话里的那条路径既在仓里、也出现在该条自己的「未勾原因：」（勾上之后则是「证据：」）里。所以勾上一条
时这张表要跟着改：状态列翻成「已勾」，一句话改写成「证据指向哪份记录」，同时删掉那条「未勾原因：」——
两边一起动，只动一边就会红。

| 条目 | 状态 | 一句话 |
| --- | --- | --- |
| DOD-1 | 未勾 | 缺陌生人第一眼的记录，仓里只有措辞断言（`README.zh-CN.md`） |
| DOD-2 | 未勾 | 参数面已与 `tools/cli-surface.mjs` 双向对上，勾选与副本核对归 scheduler 侧 |
| DOD-3 | 未勾 | pin 有断言，通路账里还留着只核了 release 的欠轮（`docs/OCR-UPSTREAM-SYNC.md`） |
| DOD-4 | 未勾 | 四范围运行级已齐（含「单个提交」的 `--commit <sha>`），缺的是 scheduler 侧核对（`tools/e2e-fake-provider.cjs`） |
| DOD-5 | 未勾 | 真机面是 Linux x64，Windows 安装包从未被脚本装过（`docs/measurements.md`） |
| DOD-6 | 未勾 | 三条都有断言，缺装好的那份里 Key 不在程序目录的实测（`tools/secret-scan.mjs`） |

## 停手清单

- 分叉/重写审查规则引擎「优化效果」
- 去掉「非官方」声明或暗示官方背书
- 为追 macOS/Linux 完美度而阻塞 Windows 已验证主路径热修（可平行，但下一刀须来自 DoD）
- 虚拟化大改造无测量依据（仓内已有 huge 测量口径）
- 自动发 GitHub Release / push——发版脚本停在人操边界前（见 README）

DoD 后只修：上游破坏性变更适配、回归、安全/密钥、反馈点名卡点。

---

## 代理反馈回路（每周，各 ≤5 条）

### A. 陌生人 / 真用户（≤5）

1. 首次能否在引导内完成「选仓 → 配模型 → 预览 → 开始」
2. 是否误以为这是阿里官方桌面版
3. 截断/失败态是否看懂「不是代码没问题」
4. 成本确认是否挡得住误点全量扫描
5. SmartScreen / 未签名是否劝退——文案是否够

### B. 竞品 / 上游对照（≤5）

1. 上游 `ocr` 新 tag 是否前进——只决定是否升 pin
2. CLI 新警告字段是否需 GUI 映射（如 limit reached）
3. 官方若出官方 GUI——我们差异是否仍成立
4. 本周最多 1 条 UX 吸收
5. 禁止重写引擎对标 SaaS 功能表

---

## 代理下一刀只能从哪里拉

1. DoD 未勾选
2. 当周反馈浓缩
3. 回归 / 安全 / 密钥 / **上游 pin 破坏**

**禁止**：冒充官方；改 scheduler；推送发版未经人确认。

---

## Repo path anchors

| 项 | 路径 |
|---|---|
| 阿里云 | `/opt/open-code-review-desktop` |
| 中文说明 | `README.zh-CN.md` / `使用说明.md` |
| 上游同步 | `docs/OCR-UPSTREAM-SYNC.md` |
| 测量 | `docs/measurements.md` |
| 主进程 | `main.js` / `ocr-service.js` |
| 发版 | `tools/release.mjs` |
