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

**本轮复核结论**（2026-10-26）：`git fetch upstream --tags` 后最新 tag 仍是
`v1.13.3`，`upstream/main` 顶端仍是 `375f64c`——上游自上次检查以来没有新
commit / release / tag，本轮没有需要移植的新内容。

只是拉 tag 时会看到几条 `would clobber existing tag`（本仓也用 `v0.1.x` 编号，
与上游 tag 撞名）：那是本地 remote 的 tag 同步提示，不影响 `upstream/main` 的
提交比对，也不要 `git fetch --tags --force` 去覆盖本仓自己的 tag。

核对方式：

```bash
git fetch upstream --tags
git log --oneline v1.13.0..upstream/main
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

## 待移植 / 待验证

### P1 — `manifest.run_failure` 的中文映射：已完成，剩报告页展示

**状态（2026-10-26）**：失败原因的**中文映射已实现**（`bf065b5`，
`src/lib/format.ts` 的 `RUN_FAILURE_LABEL` / `ITEM_FAILURE_LABEL`，两套词表由
`tools/service-smoke.mjs` 逐值断言）。未做的只剩**把 `run_failure.reason` 摆到
报告页**，以及 `CoverageItem.classification` 目前只在 tooltip 里。别再重复实现映射。

上游的 `RunManifest` 有 `run_failure: { classification, reason }`，它会把
`terminal_state` 强制成 `failed`。desktop 只显示一个红色「失败」徽章，
**不显示失败原因**——用户知道失败了，但不知道为什么。

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

desktop 的 `CoverageItem.classification` 现在会映射成中文，但仍只在 tooltip 里；
剩下一刀是把 `run_failure.reason` 摆到报告页（见下方 P1）。

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
