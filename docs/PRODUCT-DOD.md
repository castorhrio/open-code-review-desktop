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
  未勾原因：`ocr-service.js` 只 spawn 官方二进制这件事有断言，但「零分叉」要逐条对照上游 CLI 的参数面，而对照表只覆盖本仓实际用到的那些行。第 111 轮记下的那条漏网项（界面把「每组最多工具调用轮数」调**小**时会被模板默认值静默盖掉）已随 pin 前进到 `v1.13.5` 闭合——CLI 侧 `resolveReviewMaxTools` 让解析后的正值精确设置上限，见 `docs/OCR-UPSTREAM-SYNC.md` 第 113 轮；但参数面仍有成片没逐条核过，所以这一条还不能勾。
  证据候选：ocr-service.js（只 spawn 官方 CLI、拼参数、解析 JSON 与流式日志，无审查规则）
  证据候选：tools/service-smoke.mjs（按上游 resolver 语义重算「这次运行会打开哪条条目」）
- [ ] DOD-3：**上游同步**：`docs/OCR-UPSTREAM-SYNC.md` pin 与 `npm run audit:upstream` 绿；跟进上游 tag 有记录（当前 pin v1.13.5 / 约定 SHA）
  未勾原因：pin 与对照表有断言，但这一条要的是「跟进上游 tag 有记录」的连续性，而 `docs/OCR-UPSTREAM-SYNC.md` 的通路账里还留着几轮只核了 release 的欠账；等连续几轮 HEAD 都真的核过再勾。
  证据候选：docs/OCR-UPSTREAM-SYNC.md（pin 三处声明与对照表）
  证据候选：tools/upstream-watch-smoke.mjs（pin 与对照表的双射、通路账、DoD 版本事实）
- [ ] DOD-4：**主路径可演示**：四范围 + `--preview`；成本护栏；完成/部分/失败/警告徽章；预算截断不显示「干净」；续跑仅在 CLI 支持的模式显示
  未勾原因：首启链路已经有人走过了——空档案 → 引导卡三步 → 选仓 → 配 provider → 清单自己算出来 → 成本确认挡住的那一次 `scan`，全在真 Electron 里跑（`tools/e2e-first-run.cjs`）；还缺的是另外两半：「预算截断不显示干净」目前只有界面层证据（`src/components/ResultsPanel.tsx`），真截断一次要花的钱本程序不替用户花；四范围里「单个提交」与「全量扫描」也只到预览级，运行级的证据在 `tools/e2e-flow.cjs` 里只有工作区与分支对比两条。
  证据候选：tools/e2e-flow.mjs（真 Electron + 真 CLI 走完预览与四范围）
  证据候选：tools/e2e-flow.cjs（真 Electron 里断言预览与分支对比范围的那几条 check）
  证据候选：tools/e2e-first-run.cjs（真 Electron 里走完首启 → 引导 → 配 provider → 预览，以及成本确认挡住的那次 spawn）
  证据候选：src/components/ResultsPanel.tsx（完成／部分／失败／警告徽章与截断态）
- [ ] DOD-5：**航运资产**：`v0.1.13`（或更新）`*-setup.exe` / portable 可装可启；内置二进制可达；未签名 SmartScreen 有说明
  未勾原因：`docs/measurements.md` 记的真机面是 Linux x64，而发布面只有 Windows x64 的 `*-setup.exe`，安装包本身从未被脚本化装过一次；等 Windows x64 上装一次并记下首启结果再勾。
  证据候选：docs/measurements.md（真机记录，以及「没验证过什么」那一节）
  证据候选：tools/release.mjs（发版脚本停在人操边界前）
- [ ] DOD-6：**安全底线**：Key 不进本程序副本；`asar` 保持 false（spawn 契约）；发版密钥扫描绿
  未勾原因：`asar` 保持 false、Key 只经 `ocr config set` 写入、发版前密钥扫描（`tools/secret-scan.mjs`）三条都有断言，缺的是「装好的那一份里 Key 真的不在本程序目录」的实测；等真机上装一次、翻一遍用户数据目录再勾。
  证据候选：package.json（`asar` 保持 false 的 spawn 契约）
  证据候选：config-handler.js（Key 只经 `ocr config set` 写入，本程序不存副本）
  证据候选：tools/secret-scan.mjs（发版前的密钥扫描）

---

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
