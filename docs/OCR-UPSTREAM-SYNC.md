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

## 上游状态（最近检查：2026-10-27，第 60 轮）

第 60 轮复核：**三条通路都可达，结论仍是「无新内容」**。
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`
（与第 49–59 轮同一个 commit），`refs/tags/v1.13.3` = `dd925205e108304bd4dd6cc0f8e8b7cf8dee77ea`
（annotated tag 对象，指向同一 commit）；`api.github.com/repos/alibaba/open-code-review/commits/main`
给出同一 SHA，`/releases/latest` 仍是 `v1.13.3`。desktop 的 `^1.13.3` 无需改动，
**无移植项**。

本轮把三处「绿着但可能什么都没测 / 规则写重了」的缝合上：

- `findDocPins` 在文档措辞漂移时会少返回声明，而「读到的都等于常量」会静默绿。现在
  `pinPlaceCoverage` 要求三处（pin 块 / 固定行 / 正文引用）各出现且仅出现一次；
  smoke 里删掉任一处的突变用例先由「只剩两条」和「缺的是哪一个」报红，再谈值。
- 新增 `path-guard.js` 的 `isInside(root, candidate)`：`repo:pickInside` 与
  `readFileWindow` 共用同一条越界规则。原先 `startsWith(root + sep)` 在 Windows 上
  区分大小写，`C:\Repo` 会拒绝 `c:\repo\sub`，是真实 bug；判据改为 `path.relative`，
  Windows 上折叠大小写。`tools/path-guard-smoke.mjs` 用 `path.win32` 在 Linux 上钉住
  这条答案，并断言两个调用点确实走同一条规则。
- `app:info` 的组合抽成 `app-info.js` 的 `formatAppInfo`，三种形状（无二进制 /
  版本在 stdout / 仅 stderr）由 `tools/app-info-smoke.mjs` 断言；`main.js` 只留取数。

## 上游状态（最近检查：2026-10-27，第 59 轮）

第 59 轮复核：**三条通路都可达，结论仍是「无新内容」**。
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`
（与第 49–58 轮同一个 commit），`refs/tags/v1.13.3` = `dd925205e108304bd4dd6cc0f8e8b7cf8dee77ea`
（annotated tag 对象，指向同一 commit）；`api.github.com/repos/alibaba/open-code-review/commits/main`
给出同一 SHA；`npm view @alibaba-group/open-code-review version dist-tags` = `1.13.3` /
`latest: 1.13.3`。desktop 的 `^1.13.3` 无需改动，**无移植项**。

本轮把「pin 到底写了几遍」变成可断言的事，并给编排层补上 mock 断言：

- pin 在本文里有三处手写声明（下面的机器可读块、「本轮 HEAD 核对」固定行、
  `upstream:check` 那段的正文引用），加上 `tools/upstream-watch.mjs` 里的常量，共四处。
  `tools/upstream-watch.mjs` 新增纯函数 `findDocPins` / `describePinDisagreements` 按形状把
  三处文档声明全读出来（带行号），`audit:upstream` 要求每一处都等于 `PINNED_UPSTREAM.sha`；
  改一位就红，报错形如「文档第 N 行（pin 块）：… vs 常量 …」，不必再用眼睛 diff 三份拷贝。
  这条断言本身带自检：把真文档复制一份、只翻 pin 块的一位，要求恰好一处不一致并点名该行。
- `defaultRunner` 拆成 `createRunner({ runGit, runApi })`：git→API→欠账的三条顺序、
  「git 抛错仍改走 API」「API 抛错仍保留两条原因」都成了断言，不用再等网络以特定方式坏掉
  才能验。两条都失败时 `reason` 同时带 `git: …` 与 `api: …`，`skipped` 的欠账标记照旧。
- `audit:git` 补「措辞陌生」时的用户可见输出：`readFileAtRef` 的 `failed` 分支现在带 git
  退出码（`读取 <ref> 中的 <path> 失败（git 退出码 128）：fatal: …`），并断言这个退出码确实
  在错误串里——本地化 / 新版 git 把两句英文措辞都换掉时，读者至少还能看到「git 说了什么 +
  退出码」，而不是一句没有原因的话；stderr 为空时也不会只剩一个冒号。

## 上游状态（最近检查：2026-10-27，第 58 轮）

第 58 轮复核：**三条通路都可达，结论仍是「无新内容」**。
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`
（与第 49–57 轮同一个 commit），`refs/tags/v1.13.3` = `dd925205e108304bd4dd6cc0f8e8b7cf8dee77ea`
（annotated tag 对象，指向同一 commit）；`npm view @alibaba-group/open-code-review
version dist-tags` = `1.13.3` / `latest: 1.13.3`。desktop 的 `^1.13.3` 无需改动，
**无移植项**。

本轮把哨兵从「两态」做成「三态」，并把两处「绿着但什么都没测」的夹具补上机械保险：

- `[UPSTREAM-MOVED]`：`moved` 分支现在以自己的 marker 开头。于是三种答案在输出里是
  三种可 grep 的形状——`[UPSTREAM-DEBT]` = 没核对、`[UPSTREAM-MOVED]` = 核对了且变了、
  **不带 marker** = 核对了没变。`tools/upstream-watch-smoke.mjs` 对每个 `runUpstreamWatch`
  用例断言「该带 marker 的带、不该带的不带」，并要求三种首行互不相同。
- 前缀碰撞夹具不再会静默退化：`SAME_PREFIX_SHA` 的第 8–40 位改成写死的非 `f` 常量，并
  前置断言它 ≠ pin、仍共享 pin 的前 7 位、尾串确实与 pin 的尾串不同。否则改 pin 时那条
  「只有前 7 位相同的 commit 必须判 moved」会变成「拿 pin 和 pin 比」，绿而无意义。
- 「miss 不被缓存」从「再问一次还是 null」升级成计数断言：子进程记录两次
  `binaryResolution()` 各自的探测次数，miss 必须**第二次仍在探测**（`probesAfterAgain >
  probesAfterFirst`），hit 必须**第二次一次都不探测**（相等）。两个方向都钉住，「记住
  空结果」与「什么都不记」都不可能蒙过去。
- `fs.existsSync` 的源码断言收紧到 `\bfs\.existsSync\s*\(`，并额外断言无
  `existsSync(` 裸调用、无 `{ existsSync } = …` 解构赋值；别名调用
  （`const probe = fs.existsSync`）靠上面的 `probes` 计数兜底，这一点已写进注释。
- `package.json` 补 `engines: { "node": ">=18" }`：`upstream:check` 用 `fetch` 与
  `AbortSignal.timeout`（Node 18 起稳定），文档里也一并写明。

## 上游状态（最近检查：2026-10-27，第 57 轮）

第 57 轮复核：**三条通路都可达，结论仍是「无新内容」**。
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main` =
`375f64cd6f67a48a135da83cfcf59c52669a09cb`（与第 49–56 轮同一个 commit）；
`api.github.com/repos/alibaba/open-code-review/commits/main` 给出同一 SHA；
`npm view @alibaba-group/open-code-review version dist-tags` = `1.13.3` /
`latest: 1.13.3`，release 仍是 `v1.13.3`。desktop 的 `^1.13.3` 无需改动，**无移植项**。

本轮把「网络欠账」从十段散文变成可 grep 的账：

- `tools/upstream-watch.mjs` 的 `skipped` 分支现在输出固定的 `[UPSTREAM-DEBT]` 前缀，
  并写明 `通路：none`；核对成功时写明 `通路：git` 或 `通路：api`。
- git 通路不通时自动改走 `api.github.com` 的 `commits/main`，两条路都失败才判 `skipped`
  并同时带上两条路的原因——第 56 轮正是「git 超时、API 可用」却被记成跳过的那一类。
- `tools/upstream-watch-smoke.mjs` 钉住三件事：`skipped` 必须带欠账标记、成功必须带
  通路名、下面「核对通路账」表的每一行都必须与 `npm`（只能证明 release，不能证明
  HEAD → 必须欠账）/ `git` / `api`（能证明 HEAD → 不欠账）的规则一致。
- 顺带把二进制探测收敛到唯一入口：`ocr-service.js` 只剩一处 `fs.existsSync`（在
  导出的 `fileExists` 里），`tools/service-smoke.mjs` 改为覆写 `svc.fileExists` 并用
  `probes` 计数证明搜索确实走了这个入口，隔离不再依赖某个具体 fs API。

## 上游状态（最近检查：2026-10-27，第 56 轮）

第 56 轮复核：**`git ls-remote` 不可达，但 GitHub API 可达，结论仍然是「无新内容」**。
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 60s 超时（`timeout` 返回 124，与第 47–48、52–54 轮同因）；
`curl https://api.github.com/repos/alibaba/open-code-review/commits/main` 返回
`sha` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`（2026-10-20
`fix(tool): report an empty code_comment batch instead of success (#1773)`），
`/releases/latest` = `v1.13.3`（2026-10-22，`target_commitish: main`）；
`npm view @alibaba-group/open-code-review version dist-tags` = `1.13.3` / `latest: 1.13.3`。
三条通路一致，**无新 commit、无新 release/tag**，desktop 的 `^1.13.3` 无需改动。
本机 `npm run upstream:check` 因此打印「跳过（spawnSync git ETIMEDOUT）」——那是实话：
这一轮的 HEAD 是 API 核对的，不是 `git ls-remote` 核对的。

顺带补上了前几轮拿不到的那 33 位：`375f64c` 的完整 SHA 是上述 40 位（API 给的），
本轮把 `tools/upstream-watch.mjs` 的 pin 从 7 位前缀改成整串 40 位，并把
「短 SHA 只判前缀」这条歧义钉成断言——详见下面「pin 存全 40 位」那段。**无移植项。**

## 上游状态（最近检查：2026-10-27，第 55 轮）

第 55 轮复核：**网络可达，第 54 轮的欠账已清**。`git ls-remote
https://github.com/alibaba/open-code-review.git refs/heads/main refs/tags/v1.13.3`
退出码 0，`refs/heads/main` = `375f64c`（与第 49–54 轮同一个 SHA），
`refs/tags/v1.13.3` = `dd92520`（annotated tag 对象，指向同一 commit）；
`npm view @alibaba-group/open-code-review version dist-tags` = `1.13.3` /
`latest: 1.13.3`。两条通路一致，**无新 commit、无新 release/tag**，desktop 的
`^1.13.3` 无需改动。

本轮只做一件事：把「本轮到底核对过没有」从散文变成脚本会说的话。新增
`tools/upstream-watch.mjs`（`npm run upstream:check`）比对 `refs/heads/main` 与固定
`375f64c`——一致打印一行，前进打印醒目提示并列出下面四行，网络不通明确打印「跳过」
且退出码仍为 0。对应断言在 `tools/upstream-watch-smoke.mjs`（`audit:upstream`），
并钉住对照表上方那行固定格式的 SHA 与脚本常量一致。**无移植项。**

## 上游状态（最近检查：2026-10-27，第 54 轮）

第 54 轮复核：**GitHub 本轮不可达**。`git ls-remote
https://github.com/alibaba/open-code-review.git refs/heads/main` 与 `refs/tags/v1.13.3`
两次都 120s 超时（`timeout` 返回 124，与第 47–48、52 轮同因），所以「上游有没有新
commit」这一项本轮**没有核对**——这是网络欠账，不是「查过了没变」。可达的一条通路是
npm registry：`npm view @alibaba-group/open-code-review version dist-tags` = `1.13.3` /
`latest: 1.13.3`，与 desktop 的 `^1.13.3` 一致，故**无新 release**。网络恢复后仍需补一次
`git fetch upstream --tags` + `git log HEAD..upstream/main`。

本轮改动全部在 CLI 二进制的**解析来源**这一层（第 53 轮新引入的表面），与上游 CLI 参数、
输出解析、配置读写都无关：`tools/service-smoke.mjs` 把三条搜索逐条钉住（每棵临时树只放
该条搜索要找的东西，`ocr-service.js` 拷进树里跑子进程），并补上三条全失败时的答案
（`{ path: null, source: null }`、`binaryPath()` 为 `null`、miss 不被缓存）；
`SettingsPanel.tsx` 的「可执行文件来源」行不再把「没找到」画成破折号；
`tools/ui-audit` 加了三张 shot（global / 全 null / 未知来源名）。`audit:service` 全绿。
**无移植项。**

## 上游状态（最近检查：2026-10-27，第 53 轮）

第 53 轮复核：`git ls-remote https://github.com/alibaba/open-code-review.git
refs/heads/main refs/tags/v1.13.3` 可达（退出码 0），`refs/heads/main` = `375f64c`
（与第 49–52 轮同一个 SHA），`refs/tags/v1.13.3` 仍指向 annotated tag 对象
`dd92520`；`npm view @alibaba-group/open-code-review version dist-tags` = `1.13.3` /
`latest: 1.13.3`。两条通路一致，**无新 commit、无新 release/tag**，desktop 的
`^1.13.3` 无需改动。

本轮改动：`tools/release-guard-smoke.mjs` 给「读 `release.mjs` 源码」这一处已知例外
补了显式标注与反向保险（`release.mjs` 一旦出现正则字面量，检查会先红并要求扩展
`stripComments`），并给 `DIST_SKIP` 加了覆盖性断言（白名单里的名字必须仍是 win 构建
实际产出的名字）；`ocr-service.js` 的 `binaryPath()` 拆出 `binaryResolution()`，附
`package` / `local` / `global` 来源，`app:info` 与运行日志都能读到。三处都不触碰
上游 CLI 参数、输出解析或配置读写；`audit:service` / `audit:config` / `audit:git`
本轮全绿。**无移植项。**

## 上游状态（第 52 轮，2026-10-27）

第 52 轮复核：`git ls-remote https://github.com/alibaba/open-code-review.git
refs/heads/main refs/tags/v1.13.3` 本轮 40s 超时（`timeout` 返回 124，与第 47–48、51
轮的部分通路同因，GitHub 不可达），因此「有无新 commit / tag」只有 npm registry 一条
通路：`npm view @alibaba-group/open-code-review version dist-tags` = `1.13.3` /
`latest: 1.13.3`，与 desktop 的 `^1.13.3` 一致，**无新发布**。上游 commit 一处本轮
无法直接核对；`audit:service` / `audit:config` / `audit:git` 是上游语义变化先变红的三
道，本轮无需改动它们（本轮只改发版链的检查）。

本轮改动全部在 `tools/release-guard-smoke.mjs`：钉住发版入口「机器 → 版本 → 计划」的
拒绝顺序、`parsePlatform(undefined)` 与 `parsePlatform(process.platform)` 的等价（机器
无关），以及 `clearStaleDistOutput` 在 `readdirSync` 报 `EACCES`（非 `ENOTDIR`）时仍然
删除目录。与上游 CLI、配置读写、`git show` 分类都无关，**无移植项**。

## 上游状态（第 51 轮，2026-10-27）

第 51 轮复核：`git ls-remote https://github.com/alibaba/open-code-review.git` 可达，
`refs/heads/main` 仍是 `375f64c`（与第 50 轮同一个 SHA），`npm view
@alibaba-group/open-code-review version dist-tags` = `1.13.3` / `latest: 1.13.3`。
两条通路一致，**无新 commit、无新 release**；`git ls-remote --tags` 本轮超时（`timeout`
返回 124，与第 47–48 轮同因），tag 一处没有独立核对，但 `main` 顶端 SHA 未变即为「无新
commit」，`latest` 未变即为「无新发布」。desktop 的 `^1.13.3` 无需改动。

本轮改动全部在发版链（`tools/release.mjs` / `release-guard.mjs` / `release-dist.mjs`），
与上游 CLI、配置读写、`git show` 分类都无关：`audit:service` / `audit:config` /
`audit:git` 本轮仍全绿，且没有新的上游暴露点需要移植。**结论：无新内容，无移植项。**

## 上游状态（第 50 轮，2026-10-27）

第 50 轮复核：`git ls-remote https://github.com/alibaba/open-code-review.git` 可达，
`refs/heads/main` 仍是 `375f64c`，`git fetch upstream --tags` 后
`git log --oneline -1 upstream/main` 也是 `375f64c`，`refs/tags/v1.13.3` 仍在
（annotated tag 对象 `dd92520`），`npm view @alibaba-group/open-code-review version
dist-tags` = `1.13.3` / `latest: 1.13.3`。三条通路一致，**无新 commit、无新
release/tag**，desktop 的 `^1.13.3` 无需改动。本轮把「内置服务表为空是否合法」补进
下面的对照表：它此前只写在 `config-handler.js` 的注释里，而它是 `TABLE_HOLLOW` 措辞的
唯一外部依据。

第 49 轮复核（**网络恢复，欠账已清**）：`git ls-remote https://github.com/alibaba/open-code-review.git`
可达，`refs/heads/main` = `375f64c`，`git fetch upstream --tags` 成功后
`git log --oneline -1 upstream/main` = `375f64c`，`git describe --tags --abbrev=0 upstream/main`
= `v1.13.3`（tag 指向同一 commit），`npm view @alibaba-group/open-code-review version`
= `1.13.3`。三条通路一致，**上游无新 commit、无新 release/tag**，`v1.13.3` 即 main HEAD，
desktop 的 `^1.13.3` 无需改动。第 47–48 轮欠的 `git fetch upstream --tags` +
`HEAD..upstream/main` 对照本轮已补做（desktop 与上游无共同祖先，`rev-list` 计数不可用，
故以 `upstream/main` 顶端 SHA 与 tag 指针比对为准）。

- 顶端 commit：`375f64c`（2026-10-20，
  `fix(tool): report an empty code_comment batch instead of success (#1773)`）
- 最新 tag / release：`v1.13.3`（2026-10-22 发布）
- desktop 依赖：`@alibaba-group/open-code-review` `^1.13.3`

第 48 轮复核方式与结论：github.com 仍不可达（`git ls-remote` 30s 超时，
`timeout` 返回 124），沿用 npm registry 作为发布信号——
`npm view @alibaba-group/open-code-review version dist-tags` 仍是 `1.13.3` /
`latest: 1.13.3`，与 desktop 的 `^1.13.3` 一致，故**无新 release**；上游 commit
仍无法直接核对（第 47 轮同因）。本轮改动（发版链的版本参数校验、重试前清空
`release-<version>/`）与上游 CLI 无关，`audit:service` / `audit:config` / `audit:git`
本轮全绿。网络恢复后仍需补一次 `git fetch upstream --tags` + `git log HEAD..upstream/main`。

第 47 轮复核方式与结论：`git ls-remote` 对 github.com 本轮不可达
（`GnuTLS recv error (-110)` / 超时，机器出网受限），改用 npm registry 作为上游发布的
权威信号——`npm view @alibaba-group/open-code-review version dist-tags` 仍是
`1.13.3` / `latest: 1.13.3`，与 desktop 的依赖范围 `^1.13.3` 一致，故**无新 release**。
「有无新 commit」这一项本轮无法直接核对（GitHub API / `ls-remote` 都不通），下轮网络
恢复后应补一次 `git fetch upstream --tags` + commits 对照；即便上游有不发版的 commit，
`audit:service` / `audit:config` / `audit:git` 仍是先变红的那一道，本轮这三条全绿。
本轮的改动（发版 fallback 的搬移函数）与上游 CLI 无关。

**自最近一次有内容变更（`v1.13.3` / `375f64c`）以来，第 27–59 轮复核均无新内容。**
第 27–46、49–51、53、55、57–59 轮每轮都核对了 `git fetch upstream --tags`（或
`git ls-remote` / GitHub API）以及 GitHub API 的 commits / tags / releases，三处一致：
顶端仍是 `375f64c`，最新仍是 `v1.13.3`；第 47–48、52–54 轮只有 npm registry 一条通路
可达，第 56 轮 git 超时但 API 回答（见上），那几轮的「上游 commit 未核对」是网络欠账，
**不等于**上游变了。
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
成功则注明 `通路：api`（两条路问的是同一个 commit）。前进打印醒目提示并列出上表四行
（**不失败**，仍要人读源码）；两条路都失败才明确打印「跳过」，前缀固定为
`[UPSTREAM-DEBT]`、并写明两条路各自的原因，退出码恒为 0，因此可以挂在任何流程里而不会
把网络问题当成上游变更。**grep `[UPSTREAM-DEBT]` 就是这张欠账表**；每轮的 `通路` 也应
写进上面「核对通路账」。

三种答案对应三种 grep，不必读句子：

| grep | 含义 | 该怎么办 |
| --- | --- | --- |
| `[UPSTREAM-DEBT]` | 本轮**没核对** HEAD（git 与 API 都不通） | 下一轮补核对，并在通路账记一行欠账 |
| `[UPSTREAM-MOVED]` | 核对了，HEAD **前进了** | 重读下面四行源码，改 pin 与本文件 |
| 两者都没有 | 核对了，**没变** | 无需动作 |

「没变」刻意不带 marker：安静应该表示「没事要做」，任何 marker 都比安静更响。上面这张
表由 `tools/upstream-watch-smoke.mjs` 的 marker 断言钉住（该带的带、不该带的不带）。

`upstream:check` 依赖 `fetch` 与 `AbortSignal.timeout`，二者都在 Node 18 起稳定，这也是
`package.json` 的 `engines` 写 `>=18` 的原因之一（哨兵跑在 Node，不在 Electron 里）。

**pin 存全 40 位是有意的**：pin 若只存 7 位前缀，`375f64c…` 换成另一个同样以
`375f64c` 开头的 commit 会被判成「与对照表一致，无需重读」——那是这条句子唯一不能错的
方向（下面四行会一直没人重读，而句子是绿的）。所以「相等」的语义就是整串 40 位相等；
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

**`audit:upstream` 退出码恒为 0，只报告不失败——恒绿不是安全网。** 上游漂移的唯一安全网
是 `audit:service` / `audit:config` / `audit:git` 这三条，加上人工重读本节表格的 4 行；
哨兵打印「跳过」（git 与 API 都不可达）时同样是绿的，**绿只说明这条命令跑过，不说明上游
没变**，所以每轮的结论仍要写进上面「上游状态」——跳过时至少留下 `[UPSTREAM-DEBT]` 与
「核对通路账」里的一行欠账。

**本轮 HEAD 核对：`375f64cd6f67a48a135da83cfcf59c52669a09cb`（第 60 轮：`git ls-remote` 可达，`refs/heads/main` 与 pin 一致；tag 与 npm 一致，GitHub API 与 git 一致；通路：git）**

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

「最近一次对照」只写**那一项最近被人工重新核对**的轮次。该列没有列出本轮，表示本轮
复核过上游、这一项没有变化，**不是欠账**；只有上游 HEAD / tag 真的前进，才需要重看
对应行并把轮次与日期改成本轮。

**第 46–60 轮上游 HEAD 与 tag 未变**（`375f64c` / `v1.13.3`；第 47–48、52–54 轮只有
npm 通路可达，第 56 轮 git 超时但 API 可达），所以下表四行的「最近一次对照」停在第 45 轮是
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
