# open-code-review-desktop 产品标准锁定稿（writable draft）

> 状态：**writable draft**（2026-10-31 Asia/Shanghai）；**尚未**授权同步进 live scheduler / control prompts  
> 用途：给 agent 下一刀 / TODO / next-iteration 的 **下一轮合法输入源**（待 GIN 批准后锁定）  
> 形态：OSS 桌面壳，封装 **未修改** 的官方 `alibaba/open-code-review`（`ocr`）二进制；**非官方**须诚实声明  
> 发版：`v0.1.13` 对照上游 `ocr v1.13.3`；安装包/portable 在 Releases  
> 代码：`/opt/open-code-review-desktop` · GitHub `castorhrio/open-code-review-desktop`  
> **不改** live scheduler、config.yaml、产品业务代码；本文件仅 box `/workspace/product-dod/` 可写草稿

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

- [ ] **非官方诚实**：README / 关于页 / 安装说明显著写明 unofficial；不冒充阿里巴巴官方产品
- [ ] **引擎未改**：审查逻辑零分叉；仅拼 CLI、流式日志、解析 JSON、GUI
- [ ] **上游同步**：`docs/OCR-UPSTREAM-SYNC.md` pin 与 `npm run audit:upstream` 绿；跟进上游 tag 有记录（当前 pin v1.13.3 / 约定 SHA）
- [ ] **主路径可演示**：四范围 + `--preview`；成本护栏；完成/部分/失败/警告徽章；预算截断不显示「干净」；续跑仅在 CLI 支持的模式显示
- [ ] **航运资产**：`v0.1.13`（或更新）`*-setup.exe` / portable 可装可启；内置二进制可达；未签名 SmartScreen 有说明
- [ ] **安全底线**：Key 不进本程序副本；`asar` 保持 false（spawn 契约）；发版密钥扫描绿

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
