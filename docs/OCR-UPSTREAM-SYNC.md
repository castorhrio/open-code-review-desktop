# open-code-review-desktop ← alibaba/open-code-review 上游同步

## 关系
- Desktop：https://github.com/castorhrio/open-code-review-desktop （服务器 `/opt/open-code-review-desktop`）
- 上游开源库：https://github.com/alibaba/open-code-review

## 规则（调度每轮写码前由 prompt 强制提醒）
1. **定期检查**：每轮至少看一次上游默认分支新 commit，以及 Releases/tags。
2. **评估**：新功能 / API / CLI / 配置 / 破坏性变更对 desktop 封装的影响。
3. **移植**：可安全合并的 → 写入本仓并测通；不能立刻做的 → 记入私有 control 仓的
   下一轮简报。本仓库**不再维护** `next-iteration.md` 之类的工作流文档。
4. **不要**静默忽略上游 release：每轮把结论追加到下面「上游状态」，哪怕结论是
   「无新内容」。

## 上游状态（最近检查：2026-10-27，第 43 轮）

- 顶端 commit：`375f64c`（2026-10-20，
  `fix(tool): report an empty code_comment batch instead of success (#1773)`）
- 最新 tag / release：`v1.13.3`（2026-10-22 发布）
- desktop 依赖：`@alibaba-group/open-code-review` `^1.13.3`

**自最近一次有内容变更（`v1.13.3` / `375f64c`）以来，第 27–43 轮复核均无新内容。**
每轮都核对了 `git fetch upstream --tags` 以及 GitHub API 的 commits / tags /
releases 三处，三处一致：顶端仍是 `375f64c`，最新仍是 `v1.13.3`（第 43 轮复核同）。
desktop 的 CLI flag、输出解析、配置暴露点都无需改动。（`git fetch` 期间只有本仓同名的
`v0.1.x` 发布 tag 因已存在被拒，与上游无关。）

逐轮复核表格与第 2–26 轮的评估正文由私有 control 仓承载（本产品仓库只留这一份
上游状态摘要，避免再出现「表和十几轮正文挤在一处」的漂移）。

## 上游真变了怎么办（命令驱动，而不是「记得看一眼」）
```bash
npm run audit:service   # CLI 参数构建 / 四种模式的输出解析 / resolver 查找顺序的投影
npm run audit:config    # `ocr llm providers` 表与 config.json 的读写假设
npm run audit:git       # `git show` 的分类与按 ref 读文件
```
任一条变红就是「需要评估的上游变更」：先看红在哪条断言，再对照上面的 CLI/配置暴露点判断。

### 能自动变红的地方，和不能的地方

`audit:service` 里的 `UPSTREAM_RESOLVER`（`tools/service-smoke.mjs`）是唯一一处**把上游语义
写进断言**的地方：它按 v1.13.3 `internal/llm/resolver.go` 的做法重算一遍「这次运行会打开哪
条条目」（`cfg.Providers[cfg.Provider]`，原始拼写、不折叠大小写、miss 不兜底），再要求
`entryByName` 指出同一条——所以上游改了「按哪个拼写找条目」，这条会先红。它红的时候先读
上游 HEAD 的 `resolver.go`，改的是 `MATCH_RULES` 和这段模拟，不是把断言放宽。

**但 audit 变红不等于覆盖完整**：下面这几处只有人工对照，改坏了不会让任何 audit 变红。

| 对照点 | 上游文件 | 人工看什么 | 本轮是否对照过 |
| --- | --- | --- | --- |
| provider 解析顺序 | `internal/llm/resolver.go` | 是否仍按 `cfg.Providers[cfg.Provider]`（原始拼写）读；大小写折叠、回退到 registry 拼写、miss 兜底任一变化都改变设置页「Key 属于哪条」的答案 → 同步改模拟（`UPSTREAM_RESOLVER`）与 `MATCH_RULES` | 是（上游 HEAD 未变） |
| `config set` 的 key 语法 | `cmd/opencodereview/config_cmd.go` | 点名到最后一个点的分段（带点的自定义名）、未配置带点名直接拒绝 | 是（上游 HEAD 未变） |
| 内置服务表 | `ocr llm providers` 输出 | 列、表头、失败时的 stderr 措辞 | 是（上游 HEAD 未变） |
| 运行期失败分类 | 运行 JSON 的 `failure_class` / 每文件 `failure_class` | 枚举值增删（`RunFailureClass` 与 `FailureClass` 是两张表） | 是（上游 HEAD 未变） |

`resolver` 的查找顺序变化**不会**让 `audit:service` 全面变红——它只覆盖上面那几种形状
（provider 与 registry 拼写不一致、provider 落在 registry 拼写上、provider 指向别的服务）。
上游若换了别的判定方式（例如先查 registry 再查文件），需要人工读 `internal/llm/resolver.go` 确认。

## 建议命令（agent 在 `/opt/open-code-review-desktop`）
```bash
# 若尚未加 upstream remote：
git remote add upstream https://github.com/alibaba/open-code-review.git 2>/dev/null || true
git fetch upstream --tags
git log --oneline HEAD..upstream/main 2>/dev/null || git log --oneline HEAD..upstream/master 2>/dev/null | head
gh release list -R alibaba/open-code-review --limit 5
```

也可对照本地若存在的 `/opt` 外 checkout；以 GitHub 上游为准。
