# open-code-review-desktop ← alibaba/open-code-review 上游同步

## 关系
- Desktop：https://github.com/castorhrio/open-code-review-desktop （服务器 `/opt/open-code-review-desktop`）
- 上游开源库：https://github.com/alibaba/open-code-review

## 规则（调度每轮写码前由 prompt 强制提醒）
1. **定期检查**：每轮至少看一次上游默认分支新 commit，以及 Releases/tags。
2. **评估**：新功能 / API / CLI / 配置 / 破坏性变更对 desktop 封装的影响。
3. **移植**：可安全合并的 → 写入本仓并测通；不能立刻做的 → 记入私有 control 仓的
   下一轮简报。本仓库**不再维护** `next-iteration.md` 之类的工作流文档。
4. **不要**静默忽略上游 release：每轮把结论写进下面「当前状态」，并把上一轮的正文搬到
   [`upstream-history.md`](upstream-history.md)，哪怕结论是「无新内容」。

## 当前状态（第 70 轮，2026-10-27）

第 70 轮复核：**HEAD 未变，结论仍是「无新内容」；git 与 npm 两条通路都可达。**
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`
（与第 49–69 轮同一个 commit），`--tags` 里最高版本仍是 `v1.13.3`；
`npm view @alibaba-group/open-code-review version dist-tags` 仍是 `1.13.3` /
`latest: 1.13.3`。desktop 的 `^1.13.3` 无需改动，**无移植项**。

本轮不加上游面，做的是「承诺要么能被机器验证、要么就得说清楚」这件事：

- **设置页不再可能因为 CLI 不回话而空白。** `app:info` 是设置页打开时唯一等着的那个
  IPC，而它以前直接 `await ocr.exec(["version"])`：二进制被杀软占用、放在网络盘上，
  或者 spawn 之后再也不 `close`，这个 promise 就永远 pending——页面一片空白，而且不
  解释。现在这条取数路径有两层预算：`ocr-service.js` 的
  `exec(args, cwd, env, { timeoutMs })` 到点 `kill()` 子进程（进程也不该留着），
  `app-info.js` 的 `readVersionOutput` 在外层再等 `timeoutMs + 500ms` 的宽限，
  **即使 `exec` 根本不理会那个预算**也照样有答案。取不到版本不是错误：`formatAppInfo`
  把它读成 `version: ""`，页面仍拿到一个字段齐全的对象（二进制、配置路径、安装事实
  都在）。`exec` 是注入参数，所以「服务挂死」这个形状在 `audit:appinfo` 里造得出来，
  不必真去坏一台机器。
- **「哪条命令可以恒绿」这件事自己进了断言。** 本文档此前把「退出码恒为 0、只报告不
  失败」写在 `audit:upstream` 名下，而 `audit:upstream` 跑的正是这套断言本身——一句话
  把下面所有 pin / 对照表 / 通路账的检查说成了装饰。现在这句话只属于哨兵
  `upstream:check`，并由 `tools/upstream-watch-smoke.mjs` 钉住三件事：
  `package.json` 里 `audit:upstream` → `tools/upstream-watch-smoke.mjs`、
  `upstream:check` → `tools/upstream-watch.mjs`（两个脚本名只差一个词，正是会被换错的
  地方）；这句话必须点名 `upstream:check`、不许把它归给 `audit:upstream`；**并且真的把
  本文件当子进程再跑一次**（`OCR_UPSTREAM_WATCH_SELFTEST=1` 注入一条必红的检查），要求
  子进程 `exit 1` 且 stderr 点名那条注入的失败——否则「failures 非空」可以在没走到
  `process.exit` 的情况下继续打印 ok。
- **通路账的轮次连续性也进了断言。** 此前只读末行，从中间删掉一行不会红，而「连续几轮
  没核对 HEAD」正是这张表要回答的问题；现在要求轮次是连续整数、每轮恰好一行、不重复。
- **P0-2 复核结论：`readFileAtRef` 的措辞漂移已经有断言，本轮不写码。**
  `tools/git-service-smoke.mjs` 用桩 `spawn` 把九种 stderr 逐个喂进真函数：三种
  `bad-ref` 措辞、三种 `missing` 措辞、两种「谁也不认识的改写」，以及一条中文 stderr
  （`致命错误：无效的对象名称`）——后者必须落到 `failed`，且句子含 `退出码 128`。
  把分类抽成 `classifyShowFailure` 只是换一个更容易测的入口，断言面不会变宽，故不改。
- **`spellingClashMessage` 第三个分支补上了 entries 断言。** 该分支（两段 + 服务表已
  回答）此前只断言了「不说什么」，没断言「说了哪几条」——一句只点名 `deepseek` 的句子
  能通过全部否定断言。现在 `entries` 逐条相等（含各自 section 与顺序），并断言它既不
  声称两段都在 `providers`、也不带任何可点的尾巴。

## 上游真变了怎么办（命令驱动，而不是「记得看一眼」）
```bash
npm run audit:service   # CLI 参数构建 / 四种模式的输出解析 / resolver 查找顺序的投影
npm run audit:config    # `ocr llm providers` 表与 config.json 的读写假设
npm run audit:git       # `git show` 的分类与按 ref 读文件
```
任一条变红就是「需要评估的上游变更」：先看红在哪条断言，再对照上面的 CLI/配置暴露点判断。

### 上游 pin（机器可读）

`npm run audit:upstream` 逐字核对下面块里的 `sha` / `tag` 与 `tools/upstream-watch.mjs` 的
`PINNED_UPSTREAM`。这个块既是给人读的，也是给脚本读的：本文里三处 pin 声明（这个块、
「本轮 HEAD 核对」固定行、`upstream:check` 那段的正文引用）必须同值，任一处改一位就会红，
报错会点名是第几行。

<!-- upstream-pin:start -->
```text
sha 375f64cd6f67a48a135da83cfcf59c52669a09cb
tag v1.13.3
```
<!-- upstream-pin:end -->

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

**但 audit 变红不等于覆盖完整**：下面这几处只有人工对照，改坏了不会让任何 audit 变红。

**`upstream:check`（哨兵）的退出码恒为 0，只报告不失败——它的绿不是安全网；`audit:upstream` 跑的是本套断言（pin 三处声明、对照表双射、通路账），是会 `exit 1` 的那一半——恒绿不是安全网，所以红色的那一半必须真的红。** 上游漂移的唯一安全网
是 `audit:service` / `audit:config` / `audit:git` 这三条，加上人工重读本节表格的 4 行；
哨兵打印「跳过」（git 与 API 都不可达）时同样是绿的，**绿只说明这条命令跑过，不说明上游
没变**，所以每轮的结论仍要写进上面「当前状态」——跳过时至少留下 `[UPSTREAM-DEBT]` 与
「核对通路账」里的一行欠账。

**本轮 HEAD 核对：`375f64cd6f67a48a135da83cfcf59c52669a09cb`（第 70 轮：`git ls-remote` 退出码 0，`refs/heads/main` 与 pin 一致；tag 与 npm 均为 `1.13.3`；通路：git）**

### 核对通路账

「连续 N 轮没核对 HEAD」应当是一眼能数出来的账，而不是散在各轮散文里。`npm` 只能
证明「没有新 release」，证明不了默认分支的 commit；`git` 与 GitHub API 能回答 commit。
所以本表的规则只有一条：**通路是 `npm` 或 `none` 的轮次必须欠 HEAD 那一项（带
`[UPSTREAM-DEBT]`），`git` / `api` 的轮次必须不带**。`tools/upstream-watch-smoke.mjs`
逐行检查这条规则，并检查末行轮次 / 通路与上面「本轮 HEAD 核对」行一致。

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

「最近一次对照」只写**那一项最近被人工重新核对**的轮次。该列没有列出本轮，表示本轮
复核过上游、这一项没有变化，**不是欠账**；只有上游 HEAD / tag 真的前进，才需要重看
对应行并把轮次与日期改成本轮。

**第 46–70 轮上游 HEAD 与 tag 未变**（`375f64c` / `v1.13.3`；第 47–48、52–54 轮只有
npm 通路可达，第 56 轮 git 超时但 API 可达，第 63–64 轮本文件无通路记录，第 68 轮 git
超时但 API 可达，第 69–70 轮 git 可达），所以下表 5 行的
「最近一次对照」停在第 45 轮是
**没有理由重看**，不是忘了看：
它记录的是「最后一次有人逐行读上游源码」的轮次，而不是「最后一次确认上游没变」的轮次。
换言之：**停在第 45 轮 = 未重看，不等于欠账**；欠账只有一种——`375f64c` 前进之后没人
重读对应源码。第 50 轮那行（内置服务表为空是否合法）是榜样的写法：它记的是被重读的
具体行号与 tag，而不是一个「已复核」的戳。

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

## 建议命令（agent 在 `/opt/open-code-review-desktop`）
```bash
# 若尚未加 upstream remote：
git remote add upstream https://github.com/alibaba/open-code-review.git 2>/dev/null || true
git fetch upstream --tags
git log --oneline HEAD..upstream/main 2>/dev/null || git log --oneline HEAD..upstream/master 2>/dev/null | head
gh release list -R alibaba/open-code-review --limit 5
```

也可对照本地若存在的 `/opt` 外 checkout；以 GitHub 上游为准。
