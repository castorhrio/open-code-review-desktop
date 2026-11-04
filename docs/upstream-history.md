# 上游核对日志（历史归档）

**本文件是审计日志；pin 的权威声明在 [`OCR-UPSTREAM-SYNC.md`](OCR-UPSTREAM-SYNC.md)。**
那份文件承载机器可读的 pin 块、「本轮 HEAD 核对」固定行、`upstream:check` 的正文引用，
以及「核对通路账」表 —— 每轮核对的结论只写在那里一行，逐轮正文（查了什么、通路是哪条）
归档在这里。

本文件里**没有** pin 声明，也**不许整串引用 pin**：历史段里的 SHA 是 7 位前缀或 tag 对象。
`tools/upstream-watch-smoke.mjs` 断言本文件不含任何 pin 声明、不含 pin 块，且
`PINNED_UPSTREAM.sha` 的整串一次都不出现（`historyPinLeakViolations`，第 87 轮起）——pin 的
整串只在同步文档里声明，这里只写 7 位前缀，这样它就不会某天被当成第二个权威源。

搬家原因（第 62 轮）：13 段「上游状态（…第 N 轮）」堆在一份还要承载 pin 与对照表的文件里。
`audit:upstream` 要求 pin 在 `OCR-UPSTREAM-SYNC.md` 里恰好出现三次，历史段里的旧 SHA 是那
条计数的噪声源 —— 规则断言不该被历史叙述干扰，而历史本身要留着，所以搬到这里。

正文里出现的「本轮」指的是**正在讲的那一轮**（原文如此，未改）。下表是新轮的附加信息时，
仍然只写在那份同步文档里。

## 这是一份可追溯的活文档，不是冻结的快照

归档段落的正文写入后不再改写：后续轮次只能在段末追加一段 `**补记（第 N 轮）**`，
N 必须晚于该段轮次；新轮次正文加在最上面，段落轮次递减。

规则之后，一段文字只有两种来源：它自己那一轮写的正文，或段末标明轮次的一条补记——没有第三种。
这条是给「第 71 轮的正文被第 72 轮补了一句代价、却没留下痕迹」补的，那件事记在第 72 轮那一段里。所以：

- `**补记（第 N 轮）**` 是唯一的追加形状，行首就是这个标记，一条补记一段；
- 补记必须落在**同一段的末尾**：一段里出现过补记之后，正文就结束了，后面不许再有叙述；
- 补记的 N 必须晚于该段标题里的轮次，同一段的多条补记按轮次递增排列；
- 新轮次的正文加在最上面（不是文件末尾），所以从上往下读，段落轮次递减。

`tools/upstream-watch.mjs` 的 `historyAppendViolations()` 就是这四句话的判定式：`npm run audit:upstream`
要求它对本文档返回空数组，并逐条用「只改一行」的副本验证它会红（补记之后又出叙述、补记写成本段轮次、补记挪到正文之前、
段落顺序被改乱、补记落在这段之外）。规则本身也必须写在这里，否则它只存在于脚本里。

---

## 上游状态（第 131 轮，2026-11-04）

这一轮**没有核对上游**：产品侧只改了「运行结束时的语气」——`src/lib/format.ts` 的 `completionNotice()`
改成从 `statusBadge()` 的 `id` 派生语气（`COMPLETION_TONE` 表），`src/store.tsx` 的结束 toast 补上
`error` 这一支，新增 `tools/format-notice-smoke.mjs` 钉住十种结局的语气与标题。通路上一次都没走，
账也没记——本轮（第 132 轮）把这一行补上，是为了让「第 131 轮核过没有」有答案，而不是把它当成核过。

## 上游状态（第 130 轮，2026-11-04）

本轮复核：**上游没动。** `git fetch upstream --tags` 通了，`refs/heads/main` 仍是 `d3cd23f`——第 127 轮记下的
那个 Starlark commit，`git log 8041473..upstream/main` 现在也只有它一个；`refs/tags/v1.13.5` 与 npm
`latest` 仍分别答 `v1.13.5` / `1.13.5`，三个口径一致，**pin 不动、无移植项**（那 18 个变更文件早就逐个读过：
allowlist、规则表与 `pages/` 文档，对照表 5 行一个都没被碰到）。

本轮产品改动是**运行级的四种结局第一次交给真跑**。此前本仓每一条运行级结论都建立在「拒绝连接的端口」
（`http://127.0.0.1:9/v1`）上：它能证明拒绝（「一个子进程都没起」「成本确认挡住了那次 scan」），但证明不了
完成——没有东西应答时每个文件都失败，一次运行永远走不到 `complete`、也永远发布不出一条发现。于是
「单个提交 / 全量扫描」只到预览级，「截断不显示干净」只有界面层证据。

现在 `tools/fake-provider.mjs` 按被 pin 的 `ocr v1.13.5` 真发的请求形态作答，相位按请求声明的工具区分
（没有工具＝plan 预检、`code_comment`＝review、`approve_all_comments`＝review 后的过滤），不按提示词措辞——
措辞是上游的，工具名是协议。它还会跳过第二次 review 轮里 `<confirmed_findings>` 已点名的文件：上游那一趟
写着「不要重复」，一个忽略它的替身会让同一条发现被发布两次，那不是解析错误，只是一次看着像「2 条」的运行。
`tools/fake-provider-cli.mjs` 把替身接在一次性仓库（`main` / `feature` / 一行未提交改动）与一次性 `HOME` 上，
provider 用 CLI 自己的 `config set custom_providers.…` 写入而不是手写 `config.json`，所以真实用户的 Key 与
配置一次都不在测试里。

`npm run audit:provider`（挂进 `audit:static`）因此真跑四趟，全程 loopback、0 token：完成态
（`status=complete`、1 条标记发现、4 次请求；第二趟 review 真带着 `<confirmed_findings>`，靠跳过才只有 1 条）、
预算截断（**`status` 仍是 `complete`**，`summary.budget_exceeded=true` 且带 `token_budget_reached` 警告，已发布
的那条发现没被擦掉）、全量扫描（**`status=success`**，问 `<current_file_path>` 而不是 `<review_files>`）、
provider 答 500（非零退出、0 条发现）。两处措辞差异对界面是有意义的：截断不在 `status` 里，所以
`runLimitReached()` 必须看 `summary.budget_exceeded` 与 `review_limit_reached`（它一直这么看，现在有真跑撑着）；
扫描的 `success` 与 review 的 `complete` 不是一个词，`STATUS` 表里两个都得在。还缺的一半写在 DoD-4 的未勾原因里：
把这份 fixture 交给 Electron 起一次界面、断言截断的那一屏不写「完成」。

## 上游状态（第 129 轮，2026-11-04）

本轮复核：**上游没动。** `git fetch upstream --tags` 通了，`refs/heads/main` 仍是 `d3cd23f`——第 127 轮记下的
那个 Starlark commit，`git log 8041473..upstream/main` 现在也只有它一个；`refs/tags/v1.13.5` 与 npm
`latest` 仍分别答 `v1.13.5` / `1.13.5`，三个口径一致，**pin 不动、无移植项**（那一个 commit 动的是
allowlist、规则表与 `pages/` 文档，对照表 5 行一个都没被碰到）。

本轮产品改动是给「核到哪儿」这件事一个落点。`upstream:check` 一直是把上游 HEAD 和 **pin**（发布版本）比，
而默认分支本来就该走在 tag 前面，于是从第 121 轮起它连续六轮打印「[UPSTREAM-MOVED] 上游 HEAD 已前进：
abb7abc → 8041473」——同一时间那六轮的通路账一行行写着「无新内容」。一个总在响的标记等于没有标记，而工具
每轮都和文档唱反调，读的人最后两边都不信。现在机器可读区多一行「核到的上游 HEAD」（整串 40 位 + 第几轮），
`checkedHeadViolations` 要求它的轮次与通路账末行相等，`upstream:check` 比的是这一行；静默句因此改口
「与上一轮核到的一致」，前进句多一句「上一次核到是第 N 轮」。顺带把第 128 轮欠的一行账补上——那一轮只改了
图标与图标门禁、通路上一次都没走，账里记 `none` + `[UPSTREAM-DEBT]`，不是记成核过。

## 上游状态（第 127 轮，2026-11-04）

本轮复核：**上游 HEAD 前进，发布版本没动。** `git fetch upstream --tags` 这次通了，`refs/heads/main` 从
`8041473` 走到 `d3cd23f`（1 个 commit：`feat(lang): review Starlark files (#1851)`）；`refs/tags/v1.13.5`
与 npm `latest` 仍分别答 `v1.13.5` / `1.13.5`，所以**pin 不动**（pin 跟的是发布版本，不是默认分支）。
那 18 个变更文件里，对照表 5 行的上游文件一个都没被碰到：引擎侧加的是三个扩展名、两行规则映射与无扩展名
白名单里的 `BUILD` / `WORKSPACE`，其余是 `pages/` 多语文档与新增的 `rule_docs/starlark.md`。这几处都在
引擎里，本仓不自己判定哪些文件进审查、只显示 CLI 给出的排除原因，**无移植项**；夹具里那两条（`go.mod`
仍是「暂不支持的类型」、`testdata/sample.json` 仍是默认排除路径）也不会因为这张白名单变脸。

本轮产品改动在本程序最外层：**应用图标从「阈值化一张暗色渲染」改成按几何画出来。** 旧产物在 1024 上量出来
的字形与底色只有 1.38:1，缩到 16 就只剩一块近乎空的深色方块；新脚本用 4×4 超采样画圆角方、镜片环与手柄，
描边随尺寸加粗（16 上是 1.92px、48 上是 4.13px、256 上是 22.02px），`.ico` 的六个尺寸各自渲染而不是把 1024
缩下去，镜片里的蓝色在 32 以下直接不画。配色取自 `src/styles.css` 的暗色主题，脚本里不再读任何位图源。

## 上游状态（第 126 轮，2026-11-04）

本轮复核：**上游没动。** `git fetch upstream --tags` 这次通了（只有本仓同名的 `v0.1.x` tag 因已存在被拒，与上游无关），
`refs/heads/main` 仍是 `8041473`——第 124 轮记下的那个 C# 规则 commit，`git log abb7abc..upstream/main` 仍只有它一个；
`refs/tags/v1.13.5` 与 npm `latest` 仍分别答 `v1.13.5` / `1.13.5`。三个口径一致，**pin 不动**、对照表 5 行无需重读、
**无移植项**（那一个 commit 只在 `internal/config/rules/` 与 `pages/` 里加 C# 规则，本仓不读规则数据）。

本轮产品侧只做一件事：**第 10 节从「说明书」推到「待填表」。** 第 120–123 轮把「知道该验什么」写到位、把「读数没贴回」
写成断言，但那一节仍是散文：一个拿到 Windows 机器的人要读完整节才知道「读数写在哪、贴回哪一行」。现在 10.1 是四格读数表，
每格最后一列留着一个空（`____`）；10.2 是两行可以直接复制、只填空就能贴回 `docs/measurements.md` 未验证清单的模板——
行名、归属、触发条件都写好了，只留「为什么没验」那一格给人填，而那一格必须含日期与「读数」二字（`pastedReading` 认这两个标记）。

待填表比说明书多一个风险：**同一件事写了两处**。模板里的行名是第 9 节那张对照表的落点，第 9 节改了落点而模板没跟着改，
人就会把读数贴到一行没人认的名字上——而那时清单还是绿的。所以 `tools/checklist-claims.mjs` 多一条 `subsetFormViolations`，
问四件事：四格的步骤号恰好是 1 / 2.2 / 4.2 / 5.2 且顺序照这个、每格都留着空；模板恰好两行四列、每行含空 / 日期占位符 / 「读数」、
触发条件引用清单的某一步；模板点到的每一行第 9 节都点过、且 DOD-5 与 DOD-6 各有一行；模板的行名真的在未验证清单里。
门禁那句读数因此多一个数字（第 10 节贴回模板 2 行），`tools/checklist-claims-smoke.mjs` 62 → 76 条。

反向控制在真仓库上各跑一次：把 10.1 第 4.2 格的空填掉 → 点名第 351 行「没有留空」；把模板第一行的行名改成「首启链路」→
点名第 361 行「第 9 节那张对照表没有把任何一格记回这一行」，并连带点名 DOD-5 那一行没人推进、以及未验证清单里没有这个名字。
改回即绿。

上一轮（第 125 轮）的正文见 [`upstream-history.md`](upstream-history.md#上游状态第-125-轮2026-11-04)，归档之后本文件不留第二份。

## 上游状态（第 125 轮，2026-11-04）

本轮复核：**上游没动。** `git ls-remote` 超时 124，HEAD / tag / release 由 GitHub API 答上：`refs/heads/main` 仍是 `8041473`（第 124 轮记下的那个 C# 规则 commit），`/releases/latest` 与 npm `latest` 仍分别答 `v1.13.5` / `1.13.5`——三个口径一致，**pin 不动**、对照表 5 行无需重读、**无移植项**。

本轮产品侧只做一件事：**`docs/measurements.md` 上半张表从「行读得出来」变成「表渲染得出来」。** 第 121–124 轮各往实测表加了一行，每行前面都留了一个空行——Markdown 因此把它渲染成五张表：只有第一张有表头，后四段是带竖线的普通段落。脚本按「`|` 开头」照读，行一个不少，所以 `audit:static` 一直是绿的：同一张表有两份形状（渲染出来的、脚本读的），只有一份被核对过。

`tools/checklist-claims.mjs` 因此多一条 `measurementTableViolations`：`# 实测值` 那一节要有表头、且逐字是「日期 / 场景 / 实测 / 来源」；表头下面紧跟分隔行、且整张表只有这一行；表头到最后一行的区间里不许有空行与正文行；每行列数要与表头相等。反向控制八格，48 条检查变成 62 条。四处空行（第 23 / 25 / 27 / 29 行）先由这条断言点名，再在 `docs/measurements.md` 里删掉——那张表现在是一张表，18 条读数、行号连续。

## 上游状态（第 124 轮，2026-11-04）

那个 commit 只碰规则数据：新增 `internal/config/rules/rule_docs/csharp.md`、`internal/config/rules/system_rules.json` 加一行并补测试，另 5 个是 `pages/` 下的多语审查规则文档。对照表 5 行的上游文件一个都没被碰到，所以它对本仓的影响是「下一次发版时多一门语言的规则」，不是调用面变更；等它进下一个发布时再按那 5 行重读一遍。

本轮产品侧只做一件事：**把两处「读者第一眼会读错」的地方改对。** 第一处是 README 的「已验证行为」里那条「安装版能启动并调用到内置二进制」——它验的是 `release/linux-unpacked` 里的可执行文件（`tools/e2e-packaged.mjs`），而发布面只有 Windows 的 `*-setup.exe`，不标平台就等于把脚本验的平台说成发布平台；两份 README 的对应条目因此各补一句平台与脚本名。

第二处是安装段：`v0.1.13` 安装包里带的是 `ocr 1.13.0`，而源码树 pin 在 `1.13.5`。这个差距在 `docs/measurements.md` 里早有登记（`npm run audit:release-pin` 从发布 tag 的 `package.json` 与 lockfile 读出来的），但下载安装包的人看不到那一行；两份 README 的安装段因此各补一句，并写明两个数字是脚本从 tag 里读出来的、不是照句子抄的。

Windows x64 上按 `docs/win-install-checklist.md` 装一次 `v0.1.13` 仍是 DOD-5 / DOD-6 缺的那一趟，本轮没有推进它：这台机器是 Linux，跑不了 NSIS 包装层，而「怎么执行这一趟」已经写过三轮，再写一遍不会多出一条读数。

## 上游状态（第 123 轮，2026-11-04）

本轮复核：**上游没动。** `npm run upstream:check` 走 api 通路答上 `refs/heads/main` 仍是第 121 轮记下的 `8041473`（`git ls-remote` 超时 124），`/releases/latest` 与 npm `latest` 仍分别答 `v1.13.5` / `1.13.5`——三个口径一致，**pin 不动**、对照表 5 行无需重读、**无移植项**。

本轮产品侧只做一件事：**把第 120–121 轮建立的「真机清单 + 版本门禁」链条闭合。** 那两轮之后，链条上还剩一处只靠人的纪律连接的地方——清单文件头写着「这份文件是一次操作的说明书，不是验证记录」，但这句话本身没有断言：把 `docs/measurements.md` 未验证清单里那两行删掉，欠账就消失了，而 run 还是绿的。

`tools/checklist-claims.mjs`（`npm run audit:checklist-claims`，挂进 `audit:static`）因此问三件互相咬合的事：未验证清单里「按清单第 N 步去验」的行必须真的引用清单路径；清单第 9 节那张「读数记回哪一行」的对照表与未验证清单**双向**对上（正向堵「行先没了」，反向堵「第 9 节的行被删了，读数没有落点」）；DOD-5 / DOD-6 一旦是 `[x]`，清单文件头就不能还写着「尚未执行」，且这两条点到的每一行「为什么没验」必须已换成带日期与「读数」二字的实测读数。两个读法上的约定写在文件头：「第 N 步」与「第 N 节」不是一回事（`应用内更新` 那一行引用清单是为了说「这一项不在那一趟里」），一条对照行只认第一个 `DOD-<n>`（`DOD-5（主）；…DOD-4…` 的主归属是 DOD-5）。规则由 `tools/checklist-claims-smoke.mjs` 的 32 条检查钉住，反向控制逐格点名文件与行号。

同一轮里 `docs/win-install-checklist.md` 新增 §10「最小可行子集（5 分钟）」：第 1–7 节是 20–30 分钟的一趟，而「一次跑不完」不该等于「什么都没留下」——只做第 1、2.2、4.2、5.2 四格，DOD-5 与 DOD-6 就各有一条读数，并写明没跑到的行不许删（门禁会点名）。`使用说明.md` 也进了中文排版的显式清单：它是 Windows 用户装完第一眼读的中文文档，此前只靠 README 的链接被覆盖。

## 上游状态（第 121 轮，2026-11-04）

本轮复核：**上游 HEAD 前进了，但没有新发布。** `npm run upstream:check` 走 api 通路答上 `refs/heads/main` 已从 `abb7abc` 前进到 `8041473`（`git ls-remote` 超时 124），`/releases/latest` 与 npm `latest` 仍分别答 `v1.13.5` / `1.13.5`——**pin 不动**：pin 跟的是被封装的那个发布版本，不是默认分支。

那个 commit 是 `feat(rules): add C# review rules (#1840)`，8 个文件：新增 `internal/config/rules/rule_docs/csharp.md`，`internal/config/rules/system_rules.json` 加一行并补测试，另 5 个是 `pages/` 下的多语审查规则文档。上面 5 个对照点的上游文件（`internal/llm/resolver.go`、`cmd/opencodereview/config_cmd.go`、`llm_cmd.go` / `providers.go`、`internal/session/manifest.go` 里那两张 `failure_class` 枚举）一个都没被碰到——**无移植项**，等它进下一个发布时再按那 5 行重读一遍。

本轮产品侧只有一件事：**`docs/win-install-checklist.md` §4.2 里那两个期望版本，从「人记得回来改」变成「脚本会点名」。** 那张清单要能被人拿着安装包冷读，所以 §4.2 把「程序版本」与「`ocr CLI`」两个读数写成了具体字符；而这两个数字都出自最新发布 tag，一次发版就会同时变——正是没人会去翻清单的时刻。旧的写法只在文件里留了一句「下一次发版后以那条命令的读数为准」，没有人会回来执行它。

`tools/release-pin.mjs` 因此多一条 `checklistVersionViolations`：清单里出现的每个 `X.Y.Z` 只能是最新发布 tag 的版本、或那个 tag 的 lockfile 解析出的 `ocr` 版本；`方法`上「程序版本」那一格必须写发布的版本，`ocr CLI` 那一格必须写那一份发布里带的版本、并指出 `npm run audit:release-pin`——或者写成「以那条命令的读数为准」且**一个数字都不写**（不会过期的那一种写法）。它点名文件名与行号，`audit:static` 里那一项先红。规则本身由 `tools/release-pin-smoke.mjs` 从 30 条加到 41 条钉住，反向控制包括「写一个不存在的版本即点名行号」「删掉那一行即红」「空文件即红」「不写数字的那一种写法仍绿」，另加两条看仓库而不是夹具的（清单里那两行还在、`ocr CLI` 那一格还指着那条命令）。

## 上游状态（第 120 轮，2026-11-04）

本轮复核：**上游什么都没动。** `npm run upstream:check` 走 git 通路答上 `refs/heads/main` 仍是 `abb7abc`，`/releases/latest` 由 GitHub API 答 `v1.13.5`，npm `latest` 由 `npm view` 答 `1.13.5`——三处口径一致，**pin 不动、对照表 5 行无需重读、无移植项**。

本轮不改能力，只把 DOD-5 那条「真机面」从「没人写过该验什么」推到「一次真机跑就能勾」：新增
[`win-install-checklist.md`](win-install-checklist.md)，逐项写清 SmartScreen 的三种读数、NSIS 向导四个页面各该看到什么
（期望值全从 `package.json` 的 `build.nsis` 与 `build/installer.nsh` 读出，不是凭印象）、桌面与开始菜单两个快捷方式、
装完之后「关于与卸载」六行的读数、直接问内置二进制的那一版、portable 的注册表查询、卸载两个入口的「删了哪四项、
留了哪两处」，以及每一格读数记回 `docs/measurements.md` 的哪一行。`docs/measurements.md` 的未验证清单因此多两行
（装好之后 Key 落在哪、免安装版的运行面），另外四行的触发条件改成指着清单里的具体步骤；`docs/PRODUCT-DOD.md`
的 DOD-5 与 DOD-6 未勾原因各加一句「那一趟写成哪份文件」，勾选状态一个字没动。

清单本身不是证据：它只说明知道该验什么，读数贴回之前那几行仍是「没验过」。

## 上游状态（第 119 轮，2026-11-04）

本轮复核：**上游什么都没动。** `npm run upstream:check` 走 git 通路答上 `refs/heads/main` 仍是 `abb7abc`（第 111–114、116–118 轮核到的都是它），`/releases/latest` 由 GitHub API 答 `v1.13.5`，npm `latest` 由 `npm view` 答 `1.13.5`——三处口径一致，**pin 不动、对照表 5 行无需重读、无移植项**。

本轮产品侧不改能力，只补上一轮那套账的三处缺口，都属「门禁红了要说得清原因」这一件事：

1. **同一事实不再两处解析**：`releaseAssetViolations` 原来用 `String(tag).replace(/^v/, "")` 自己从 tag 名里剥版本，而 `releaseTagOf` 已经解析过一次；现在签名收成 `{ tag, version, manifest, lock }`，版本由调用方传入，空版本算一条红而不是「跳过这次比对」——与下方「文档那一行」的规则同一个形状（`includes("")` 对每一行都真）。
2. **浅克隆里的红要说出原因**：`main()` 在 `git tag -l 'v*'` 为空时不再说「没有发布」（那句话会让人去查另一个项目的 tag），而是点名「`--depth` 克隆与 tarball 解出来的目录都长这样」并指出可以先跑不要 git 的那一半。
3. **第二个环境依赖登记进账**：`audit:static` 从第 114 轮起要本机已装 CLI，第 118 轮起还要本 checkout 的 tag 历史；后者这一轮真量了一次——`git clone --depth 1 --no-tags` 的副本里 `tools/release-pin.mjs` 退出码 2 并说出原因，`tools/release-pin-smoke.mjs` 同一副本里 30 条全绿（规则那一半不碰 git），代价写进 `docs/measurements.md` 的未验证清单与实测表。

## 上游状态（第 118 轮，2026-11-04）

本轮复核：**上游什么都没动。** `refs/heads/main` 仍是 `abb7abc`（`/commits/main` 答上，第 111、112、113、114、116、117 轮核到的都是它），
`/releases/latest` 仍是 `v1.13.5`，npm `latest` 同为 `1.13.5`——三处口径一致，**pin 不动、对照表 5 行无需重读、无移植项**。

本轮产品侧的改动是把**发布资产里带的是哪一版 `ocr`** 从「人读过一次」变成「脚本能答」：`tools/release-pin.mjs`
（`npm run audit:release-pin`，挂进 `audit:static`）读最新发布 tag 的 `package.json` 与同一份 tag 的 `package-lock.json`——`npmRebuild: false`
加上 electron-builder 会把 `node_modules` 抄进 `resources/app`，所以 lockfile 解析出来的那一版就是产物里的那一版。它同时补上了
`audit:upstream` 看不见的一半：依赖区间写着 pin、而 lockfile 还停在旧版本时，`dependencyPinViolations` 是绿的，产物却是旧的。
本轮读数：`v0.1.13` 里带 `ocr 1.13.0`，源码树这一侧 `1.13.5`——差的这两版写成一行打印，不设成永久红（发版要 Windows 机器，
一条恒红的门禁只会教会所有人忽略它）；`docs/measurements.md` 那一行必须写出 tag、版本与命令，tag 一前进就会红。

这条脚本自带一个本仓特有的坑：checkout 里还躺着上游的 tag（`v0.2.0`–`v0.2.2`、`v1.13.x`），它们按版本号排在本产品的 `v0.1.13` **之后**，
所以「选最高的 vX.Y.Z」会答到另一个产品上；选择器因此读每个候选 tag 的 `package.json` 名字，smoke 里有一格专门要求「只按版本号选」
选中 `v1.13.5` 而正确的选择是 `v0.1.13`。

## 上游状态（第 117 轮，2026-11-04）

本轮复核：`abb7abc` / `v1.13.5` / npm `1.13.5`，三条通路答案一致、无新内容，**pin 不前进、无移植项**。
`git ls-remote` 这一趟超时（124），HEAD、tag 与 Release 都由 GitHub API 答上。

本轮的产品改动是把「装完的那份字节」第一次交给脚本：`tools/e2e-packaged.mjs`（`npm run audit:packaged`）在一次性 HOME 下启动
`release/<platform>-unpacked` 里的可执行文件，经 DevTools 协议读界面，断言渲染层来自 `resources/app/out`、应用自报「安装版」且
安装目录就是打包树、内置 CLI 在打包树里并自报 pin 的 tag 与 commit 前缀、配置落在一次性档案里、开发者真实配置摘要不变；反向控制是
同一套断言指向源码树（必须变红并点名安装目录与 CLI 位置）。规则抽成四个纯函数，由 `tools/e2e-packaged-smoke.mjs`
（`audit:packaged-rules`）用 24 条检查钉住。逐轮正文写在本段里是因为第 117 轮提交时同步文档只加了账行、正文留到了下一轮补。

## 上游状态（第 116 轮，2026-11-04）

本轮产品侧没有新增能力，做的是**把上一轮留下的断链接上**：第 115 轮的提交信息写着「第 115 轮」，而通路账停在
第 114 轮，于是 `ledgerRoundViolations` 的判定（账末行轮次必须是提交信息的 N 或 N+1）在开局时就是红的——这正是
那条规则存在的理由：一轮提交了、账没加行，看起来和「这一轮核对过、上游没动」一模一样。账上补了第 115 轮一行，
通路写 `none` 并带 `[UPSTREAM-DEBT] HEAD`（那一轮确实没有核对记录，欠账如实记着，本轮由 `git` 通路清掉），
第 116 轮一行写本轮的 git 结论。

## 上游状态（第 114 轮，2026-11-04）
本轮复核：**上游什么都没动。** `git ls-remote` 这一趟通了（第 113 轮那条 GnuTLS `-110` 没再出现），HEAD 与 tag 一次问全：
`refs/heads/main` 仍是 `abb7abc`——第 111、112、113 轮核对到的都是它，本轮第四次；`refs/tags/v1.13.5`（tag 对象 `e739d39`）指向的
也是 `abb7abc`；Releases 前三条仍是 `v1.13.5` / `v1.13.4` / `v1.13.3`（皆非 draft / 非 prerelease），npm `latest` 仍是 `1.13.5`
（`gitHead` = `abb7abc`）。**pin 不动、对照表 5 行无需重读、无移植项。**

本轮的产品改动是补 DOD-2 的实证面：**参数面**。此前「引擎未改」只有两条证据——`ocr-service.js` 只拼参数不实现规则、以及一张手写的
每模式白名单；两者都答不了审阅者真正要问的那一句：本仓拼出去的每一个 flag，是不是都被**被 pin 的那一版** CLI 收。`tools/cli-surface.mjs`
（`npm run audit:surface`）回答它，用的是两台机器而不是一次重读：被 pin 的二进制的 `--help`（12 条命令，含 `ocr review --help` 与
`ocr scan --help`）与本仓真的交给 `spawn` 的 argv（`preview` / 四种范围的 `startRun` / 会话三条 / 规则 / 配置两条 / provider 表，共 18 条
命令行）。两个方向都查：表里的 57 行必须在 help 里且类型一致、也必须真的被某条命令行拼出来；录到的每个 flag 必须在表里有行；help 里有
而本仓不送的 15 行必须在「不用」表里写下理由；「`scan` 不收 `--effort`」这类 10 行白名单依据也要在 help 里核对。另有两条不属于双射但
同样会杀人：`--preview` 永不带 `--resume`（CLI 拒绝这对组合，而预览与运行共用一个 spec），版本行必须同时带 pin 的 tag 与 commit 前缀
（否则上面每一条答案说的都是别的发布）。

三张表都在 `tools/cli-surface.mjs` 里，本文件只指向它、不抄第二份——拷贝会各自漂，这是第 104 轮把人读区减重的同一条理由。
反向控制在 `tools/cli-surface-smoke.mjs` 一并跑（同一个 script 先自检、再门禁）：夹具不是抄表，而是**从表生成**，于是「诚实的答案」
是空数组；每一格再改一个事实，要求拥有那个事实的规则用自己的话点名。这一遍第一次跑就抓到自制夹具自己的两处错：它把 `--preview` 与
`--resume` 拼在同一条合成命令行上（于是每条控制都在跟一个不诚实的底色对账，46 条里 12 条因此假红），以及把「值长得像 flag」那一格的
期望写成了两个 flag（`--rule --repo /r` 在 CLI 眼里是「`--rule` 的值是 `--repo`」，那行只有一个 flag）。两处改的都是夹具的期望与前提，
不是放宽规则——反过来，现在还有一条前提专门钉住「底色里没有任何一条命令行同时带 `--preview` 与 `--resume`」。

代价写清：`audit:surface` 读的是本机装下来的那份二进制（与 `ocr-service.js` 的 `binaryPath()` 同一个答案），所以 `audit:static`
从本轮起不再「不需要 CLI 也能跑」——CLI 没落下来时它退 1 并说清原因，而不是静默变绿。

DOD-2 的未勾原因随之改写：原先那句「参数面仍有成片没逐条核过」从本轮起是假话。**勾选状态不动**（勾选归 scheduler 侧），改的是
「为什么还不能勾」——现在缺的是 scheduler 侧的确认，以及「对照的是参数面，不是引擎的规则表本身」这半句诚实边界。

验证口径：`npm run audit:static`（25 项，本轮新增的 `audit:surface` 里含 46 条自检 + 12 条命令的 help 对照）在本机 Linux x64 上全绿，
二进制自报 `v1.13.5 (abb7abcd)`，数字记在 [`docs/measurements.md`](measurements.md)。

## 上游状态（第 113 轮，2026-11-04）
本轮复核：**上游的发布版本前进了**——`v1.13.4` → `v1.13.5`。npm `latest` 变成 `1.13.5`，`refs/tags/v1.13.5` 指向 `abb7abc`（tag 对象
`e739d39`，Release 发布于 2026-11-03T14:43:14Z，非 draft、非 prerelease），而 `refs/heads/main` 仍是第 111、112 轮核对到的那个
`abb7abc`。第 111 轮那条「tag / Release 走了、npm 没走」的分叉本轮合上，**pin 前进**；本机 `npm install` 落下来的二进制自报
`v1.13.5 (abb7abcd) linux/amd64`，与新 pin 是同一个 commit。

第 112 轮留下的那句预告（「下一次 npm 发到 `1.13.5` 时，pin 前进的那一轮要同时重读对照表 5 行」）本轮执行了：`v1.13.4...v1.13.5`
是 8 个 commit、36 个变更文件，逐行结论写在上面那张表的最后一列。这里只留两条读名字会踩坑的：

- **两个 `resolver.go` 不是同一个文件。** 清单里有 `internal/diff/resolver.go`（new-side hunk 匹配的空行重试），没有对照表第 1 行说的
  `internal/llm/resolver.go`。`UPSTREAM_RESOLVER` 与 `MATCH_RULES` 因此不动。
- **第五行的文件这次真的被碰到了。** 定义两张失败枚举的 `internal/session/manifest.go` 在清单里，所以「清单里没有它」这一句在这一行
  不成立，读的是它改的那几行：diff 只有一处，`ManifestExecution` 多一个 `MaxToolRequestTimes`（JSON `max_tool_request_times`）。
  `FailureClass` 的 8 个值与 `RunFailureClass` 的 7 个值在两个 tag 上逐行取出来比过、完全一致；本仓只读已知键，那个新字段不消费。

无移植项，但有一条**用户可见**：`--max-tools` 从这一版起「调小也算数」。新二进制自己的帮助文本是
`max tool call rounds per subtask (0 = template default; min 50)`——解析后的正值精确设置上限，但 `50` 仍是下限。第 111 轮发现、
第 112 轮搬进 DOD-2 未勾原因的那条差距就此闭合，本轮把那一句改写；**DOD-2 仍然没勾**，因为「零分叉」要的是参数面逐条对照，
这件事不会因为一版发布而自动完成。界面那行的 hint（`0 = 模板默认。`）本来就只承诺 `0` 的含义，现在它说的仍然是真话，所以这一轮
**不**给它加「调小会被模板默认值覆盖」的说明——那句话的有效期只有上一个 pin，写下去就是一句注定过期的话。

另外三条引擎侧的变化对本仓没有契约影响：allowlist 扩了 `.jsonc` 与 EJS / Liquid / Nunjucks / HAML / Slim / ERB，Scala 进规则表，
工作区模式不再把被 `.gitignore` 匹配的**已跟踪**文件滤掉（第 107 轮记的那条 HEAD 改动，这一次进入被封装的发布版本）。本仓显示的
是 CLI 给出的排除原因与文件清单，不自己判定哪些文件进审查，所以无移植项。

本轮还收编了一处**依赖先动、文档没跟上**的状态：工作树里 `package.json` 与 `package-lock.json` 已经落在 `^1.13.5`（本机
`npm install` 从镜像拉下来的），而 pin 仍写上一个发布版本——`audit:upstream` 因此点名「依赖先动，就要把 pin、对照表 5 行与
`UPSTREAM_RESOLVER` 一起复核后改成本轮的版本」。这条断言的存在理由就是这一刻：它不许一次版本前进只发生在 lockfile 里。本轮按它
要求的那条路走完了，而不是把 lockfile 退回去假装没发生。

验证口径与第 103 轮那次升 pin 相同：跑在本机 Linux x64（开发机，不是发布面），CLI 层、真 Electron、UI 三套的数字记在
[`docs/measurements.md`](measurements.md)；两份 README 与 `src/lib/types.ts` 的版本行随 pin 一起前进。

还有一条本轮**修掉并加了断言**的 lockfile 事实：本机 `npm install` 重新生成的 `package-lock.json` 里只剩 5 个平台包，
`@alibaba-group/ocr-darwin-x64` 掉了出去——父条目 `optionalDependencies` 里那六行声明还在，只是它自己那条解析记录没了。对发布面没有
影响（发布的是 Windows x64，`ocr-win32-x64` 在），对这台机器也没有影响（linux/x64 本来就不装 darwin 包），所以它**不会**让任何一条
门禁变红：真正的后果是 `npm ci` 在 macOS x64 上装不出东西，而那正是从来没被构建过的平台——只在没人构建的平台上开的口子，就是会一直
开着的口子。修法是把那条记录按 `npm view` 给出的 `resolved` / `integrity` 补回去（tarball 下下来重算 sha512 与 `npm view` 逐字相等，
不是抄一个看起来对的串），补完再跑一次 `npm install --package-lock-only` 确认 npm 不会把它再剪掉。

断言加在 `tools/check-packaging.mjs`（`audit:packaging`）：它问的是同一个问题的下一层——「打包出来的应用找得到自己的文件吗」——
只不过问的是 `package-lock.json`。规则只有一条，但**读的是声明而不是写死的六个名字**：父条目的 `optionalDependencies` 说有几个平台包，
每一个就必须有自己的解析记录，版本要与声明一致、`resolved` 与 `integrity` 都要在。`tools/check-packaging-smoke.mjs` 用**改真 lockfile**
的方式造六格反向控制（删一条记录 / 版本对不上 / 缺 integrity / 上游多声明一个平台 / 声明为空 / 父条目整个不见），所以上游哪天加第七个
平台，这一套不用改就覆盖到了；「声明为空」那一格是防假绿的——没有声明时循环会一条问题都不报，而它其实什么都没读。

还有一条本轮把版本行推到 `v1.13.5` 时**必须一起说清**的发布面事实：仓里最后一个发布提交是 2026-10-14 的
`chore(release): 0.1.13`，那一份 `package.json` 里的 CLI 依赖还是 `^1.13.0`。也就是说 Releases 上那份
`*-setup.exe` 带的 `ocr` 既不是 `v1.13.4` 也不是 `v1.13.5`，而是那天解析到的那一版；README 的「`v0.1.13`, running
`ocr v1.13.5`」与 DoD 头部那句说的是**这份源码树构建出来、按此 pin 验证过**的那一版，不是下载得到的那串字节。合上这个落差的
动作是发一次新版——`tools/release.mjs` 停在推送提交与发布 Release 之前，那两步属于人。本轮既不假装已经发过，也不把 README 的
版本行退回成资产里的旧版本：那会把 pin 的本意（「封装并对照的是哪一版」）改成「上一次 shipping 里恰好装的是哪一版」。要补的实测
记在 [`docs/measurements.md`](measurements.md) 的未验证清单里。

上一轮（第 112 轮）的正文见 [upstream-history.md](upstream-history.md#上游状态第-112-轮2026-11-04)，归档之后本文件不留第二份。

## 上游状态（第 112 轮，2026-11-04）
本轮复核：**上游什么都没动。** `git ls-remote` 答上：`refs/heads/main` 仍是 `abb7abc`（与第 111 轮核对到的同一个 commit），
`refs/tags/v1.13.5` 仍指向它（tag 对象 `e739d39`），npm `latest` 仍是 `1.13.4`。三个口径本轮一致，pin 因此不动，对照表 5 行无需重读，
无移植项。上一轮写下的那条规则（**pin 跟 npm 走，不跟 tag 或 Release 走**）是常驻规则，不是那一轮的结论，所以这里只重述一句：
下一次 npm 发到 `1.13.5` 时，pin 前进的那一轮要同时重读对照表 5 行。

第 111 轮发现的 `--max-tools` 那条用户可见差距（pin 的 1.13.4 上把「每组最多工具调用轮数」调**小**会被模板默认值盖掉）
本轮**从正文搬进 `docs/PRODUCT-DOD.md` 的 DOD-2 未勾原因**。理由是这份文件本身的规矩：正文每轮归档，只有当前一轮留在这里，
而「上游发了才算解决」的欠账如果只写在正文里，归档之后就没有任何人再持有它——DOD-2 那一句是有断言读的（`dodReasonViolations`
要求它指到仓里真实存在的记录），欠账因此有了一个不会随归档消失的家。

本轮的产品改动是一件：**把 DOD-4 缺的「首启 → 引导 → 配 provider → 预览」做成 harness**。
根因不在产品而在证据：`tools/e2e-flow.cjs` 一进来就 `localStorage.setItem("last-repo", …)` 并把引导卡关掉，它证明的是范围引擎，
装完安装版之后的第一屏没有任何脚本走过。新增的 `tools/e2e-first-run.cjs`（`npm run audit:e2e-first-run`，挂在 `audit:app`）
17 条 check 走的是一个人真的会走的路径，其中三个决定不是装饰：

- **档案是一次性的，不是「删掉用户的」。** `HOME`（与三个 Windows 变量）、Electron 的 `userData`、因而渲染层的 `localStorage`
  全在 `require("main.js")` 之前指向一个临时目录；引导卡能出现是因为那份档案本来就是空的，而不是因为脚本把它调成空的。
  这条规矩的代价写在 `tools/e2e-first-run-steps.cjs`：判不出来就**不开应用**，因为这条链路要写一个假 API Key，
  重定向若没生效，它会进开发者真实的 `~/.opencodereview/config.json`。链路末尾另有一条 check 把那份真实文件的摘要与开跑前比一次。
- **拒绝是谁挡的要由进程自己说。** 引导卡、运行门与设置页的措辞都能被渲染层自己圆过去，所以 spawn 是被记下来的
  （`child_process.spawn` 在 `main.js` 拉进 service 之前被包住）：填 Key 之前必须**零个** `review` / `scan`，
  成本确认后点「取消」必须**仍零个**，点「仍然开始」必须**恰好一个**且带着用户设的 `--max-tokens-budget`。
  `--preview` 不算——预览不花钱，这是产品的立身之本，分类把它单独放开。
- **provider 是假的，请求也出不了这台机器。** 端点是 `http://127.0.0.1:9/v1`（discard 端口，没人监听），CLI 的连通测试在机器内部失败，
  一个包都不发出去；不调真 API、不花 token。

它第一次跑抓到的是**它自己**的三处错，都不是产品缺陷但都会让它假绿：fixture 把 HEAD 切回 `main`，于是「feature」分支徽章永远等不到；
Radix 的 select trigger 带的是 `role="combobox"` 而**没有** `aria-haspopup`，用后者找它等于永远点不开；
确认框经 Portal 渲染在 `document.body`，用 `main button` 找「取消」找不到，看上去像护栏没出现。
第三处还顺带纠了一个更早的误判：`llm test` 那一次 spawn 的 `HOME` 不是 harness 的临时目录——那是 `config-handler.js`
**自己**为「按填写值测试」造的第二个一次性档案（保存过的 Key 会盖过 `OCR_LLM_*`，见那里的注释），
所以判定改成「没有任何孩子跑在开发者的真实档案里」，并把那类档案认成允许的、而不是当成泄漏。

它还差的那一半也记在 DOD-4 的未勾原因里：真截断一次预算要花的钱本程序不替用户花，「单个提交」与「全量扫描」两条范围到目前只有预览级证据。

## 上游状态（第 111 轮，2026-11-04）
本轮复核：**上游 HEAD 前进了 3 个 commit，并且第一次出现「tag / release 走了、npm 没走」的情形。**
`git ls-remote` 答上：`refs/heads/main` 从 `5c039e8` 前进到 `abb7abc`；`refs/tags/v1.13.5` 指向 `abb7abc`
（tag 对象 `e739d39`，GitHub Release 也是正式发布，不是 draft / prerelease），而 npm `latest` 仍是 `1.13.4`。

**pin 因此不前进，而这一轮才第一次需要把它写成规则**：本程序 spawn 的是 `@alibaba-group/open-code-review`
这个 npm 包里的二进制（`ocr-service.js`），pin 声明的是「实际会跑起来的那一版」，所以它跟 npm 走，不跟 tag
或 Release 走。第 103 轮 tag 与 npm 同时前进，两个口径看不出区别；这一轮把它们分开了，规则才有内容。

三个 commit 对本仓的影响逐条核过：

- `20d57cb` `fix(review): honor lower max-tools overrides`：`cmd/opencodereview/review_cmd.go` 里
  `--max-tools` 现在「只要给了就赢过模板默认值」（新的 `resolveReviewMaxTools`），manifest 的 `execution`
  多一个 `max_tool_request_times`（加法字段，本仓只读已知键，不需要改）。**这条对本仓是用户可见的**：
  界面「调整这次审查的参数」里的「每组最多工具调用轮数」传的就是 `--max-tools`，而在 pin 的 1.13.4 上把它
  调**小**会被模板默认值盖掉（调大有效），1.13.5 起才算数。无移植项——本仓一直照直传，改的是 CLI 侧的优先级；
  等 npm 发布 1.13.5、pin 前进时这条自动成立。
- `98f1dfe` `fix(diff): split a bare "diff --git" header at its separator`：`internal/diff/parser.go`，裸头
  不再吞掉下一段；`abb7abc` `fix(diff): retry new-side hunk match without blank lines`：
  `internal/diff/resolver.go`——**不是**对照表第 1 行那个 `internal/llm/resolver.go`（同名不同目录，读名字容易
  混，所以点明）。两处都在引擎侧解析 diff，本仓不自己解析 diff，无移植项。
- 对照表 5 行（`internal/llm/resolver.go`、`config_cmd.go`、`llm_cmd.go` / `providers.go`、`failure_class`）一个都
  没被这三个 commit 碰到。

本轮的产品改动是一件：**过线标准与「没验证过什么」从「写了检查」推到「检查真的跑过 / 边界有人认领」**。
前几轮把 DoD 的候选推到「路径在仓里」与「文件里真有那句话」，可两者加起来仍然放过一个状态：候选指向一份
**从不被执行**的检查——文件在、措辞对、没有任何 `audit*` 脚本跑到它。`tools/upstream-watch.mjs` 的
`auditScriptClosure` 因此把依赖闭包**算**出来（`audit*` 脚本 → `npm run` 链 → `node <file>` → 相对 import 与
`tools/...` 字面量），`dodHarnessReachViolations` 要求每个指向 harness 的候选都在闭包里；闭包算空时规则
自报「没有对象」，而不是报绿。

同一趟补上另一半：**「没勾」和「没人看过」不再长得一样**。6 条 DoD 连续多轮全 `[ ]`，每条都有候选、audit 一直绿，
因为「没勾」是没有任何检查问过的状态。现在每条没勾的下面都要有一句 `未勾原因：<一句话 + 仓内路径>`
（`dodReasonViolations`）：要指到仓里真实存在的记录、不许写「待定」这类占位词、勾上之后不许再留着（那会变成假话）、
挂在条目之外的那一句会点名。它不催勾，只要求「为什么还没勾」是一个被回答过的状态。

`docs/measurements.md` 的「未验证清单」也从自由表格变成有归属的表：每行要写清这项是**上游 / 本仓 / 真机**谁的
事，并指到仓里一份可打开的记录（`unverifiedRowViolations`）。归本仓的行必须指到依赖闭包里的一份真检查
（「这是我们的、还没验」只有在存在一份会跑的检查时才诚实），归上游的行必须指到本文件——不指过来的那一行没人会回头核。

反向控制按「这条规则能怎么错」逐格写：闭包只跑一个 harness 时要点名剩下五个（而真被跑到的那一个不许被点名）、
没有任何 `audit*` 脚本时不许报绿、删掉一条未勾原因要红、写「待定」要红、指到不存在的文件要红、勾上后留着原因要红、
原因挂在条目之外要红；未验证清单去掉归属格、把上游行改成本仓、上游行不再指本文件、触发条件留空，各红一次。

**补记（第 112 轮）**：第 111 轮记下的 `--max-tools` 那条用户可见差距，正文归档后就没有别的
地方持有它了，所以第 112 轮把它写进 `docs/PRODUCT-DOD.md` 的 DOD-2 未勾原因——那一句由
`dodReasonViolations` 读，欠账因此有了一个不随归档消失的家。本文档的规矩是段落写入后不再改写，
所以这里只追加这一句去向，不动上面那段。

## 上游状态（第 110 轮，2026-11-04）
本轮复核：**上游 HEAD 前进了 1 个 commit。**`git ls-remote` 答上：`refs/heads/main` 从 `c452846` 前进到
`5c039e8`（`feat(allowlist): add HAML, Slim and ERB template support (#1552)`，动的是
`internal/config/allowlist/supported_file_types.json`、`system_rules.json` 与规则文档）；
`refs/tags/v1.13.4` 仍指向 tag 对象 `1393158`，npm `latest` 仍是 `1.13.4`。tag 与 npm 未动，
**pin 不前进**，对照表 5 行不动，无移植项——allowlist 与规则表是引擎侧，本仓只显示 CLI 给出的排除原因，
不自己判定哪些文件进审查。

本轮的产品改动是一件：**界面中文的「字号下限」与「字体栈顺序」从注释变成断言**。
`styles.css` 的两段注释一直说阶梯最小 12px、栈是拉丁 → 中文 → 通用，但没有任何检查——而这正是 11px
与「漏掉中文字族」能悄悄回来的方式。`tools/ui-cjk-typography.mjs` 因此多问两个问题，都对**真正带文字的叶子**
读 `getComputedStyle`（不是读样式表：内联样式、被 merge 吃掉的类、库自己的默认值都绕得过样式表）：
中文文本的 `font-size` 不得低于 12px；含中文的叶子，`font-family` 必须是拉丁 → 中文 → 通用（缺中文字族 /
中文字族排在拉丁之前 / 通用字族之后还有真字族，三种各自点名）。逐屏前提也分成两条：没有中文标点算没读到散文，
没有中文叶子算没读到字号与字族。

它第一次跑就抓到一个真缺陷：结果页「固定在 d41c8b7」的徽章整块套着 `font-mono`，而 mono 栈里没有中文字族——
「固定在」三个字是系统兜底画的，与 `App.tsx` 里 toast 那段注释描述的是同一个缺陷。修法是只把 commit 留在
mono 里，标签回到正文字族（`src/components/ResultsPanel.tsx`）。

反向控制也加了一组按**样式表**改坏的两格：把 `.text-meta` 的 12px 改成 11px、把 `--font-sans` 里的
`Microsoft YaHei` 摘掉，各要求在 `settings-top` 上点名对应规则。两条 needle 从 `src/styles.css` 推导而不是抄一份，
needle 指错时 `audit:static` 先红（`ui-cjk-typography-smoke.mjs` 同时断言阶梯最小值、声明栈的顺序与两条 needle 的推导）。

**补记（第 111 轮）** 上面这段「tag 与 npm 未动」只对 11-04 当天成立：次日上游 HEAD 再前进到 `abb7abc`，
并发布了 `v1.13.5`（tag 对象 `e739d39`，正式 Release），而 npm `latest` 仍是 `1.13.4`——所以 pin 与
三处声明都没有跟着动：本程序 spawn 的是 npm 包里的二进制，pin 声明的是「实际会跑起来的那一版」。
这一轮还核出那 3 个 commit 里有一条对本仓用户可见（`--max-tools` 调小在 1.13.4 上无效），细节写在第 111 轮的正文里。

## 上游状态（第 109 轮，2026-11-03）
第 108 轮复核：**上游没有新内容。**`git ls-remote` 这一轮答上来了：`refs/heads/main` 仍是 `8f9c8b7`，
`refs/tags/v1.13.4` 仍指向 tag 对象 `1393158`，`/releases/latest` 仍是 `v1.13.4`。三条通路答案一致，
**pin 不前进**，对照表 5 行因此不动，无移植项。

本轮按控制仓简报做 P0-1 的收尾、P1-2 与 P1-1，三件都不新增产品功能。

**P0-1：过线标准从「人读才能核」推到「脚本能核哪几条还没证据」。** 上一轮把 DoD 的版本事实拉进了断言，
但 `dodCheckboxViolations` 只对**勾上的**条目说话，而 6 条全是 `[ ]`——于是「六条里没有一条指出过任何一份
记录」是审计判绿的状态。「没什么可报」与「没人看过」对那条检查是同一个答案，而只有后者说明这份标准还在被维护。

- 每条 DOD 下面加一行缩进的 `证据候选：<仓内路径>`（`docs/PRODUCT-DOD.md`）：它回答的是另一半问题——
  **这一条若要勾，该去仓里翻哪份记录**。候选不是勾选，也不代替证据；勾选仍归 scheduler 侧，条目正文一个字没动。
- 新增 `dodEvidenceCandidates` / `dodEvidenceCandidateViolations`（`tools/upstream-watch.mjs`）：每条 ID 至少一个
  候选、候选路径必须真的在仓里、候选必须挂在某一条之下（写在第一条之前或清单之后属于「没有 ID 的候选」，
  看着像覆盖、实际一条都没补上）。
- 候选路径与证据路径共用同一个读法（`dodPathAfterMark`）：反引号与后面的括注都不改变「这一行指的是哪个文件」，
  两处各写一份「路径到哪结束」正是两条规则开始对同一行给出不同答案的方式。
- 反向控制（`tools/upstream-watch-smoke.mjs`）八格：正向全绿；前提（6 个 ID 都有候选、没有无主候选、候选数 ≥ 6）；
  删掉 DOD-5 的候选只点名 DOD-5；候选指向 `docs/no-such-record.md` 点名行号与路径；候选写在第一条之前点名行号；
  标记后面没有路径点名行号；**正文里提到标记不算候选**（见下）；候选路径的反引号与括注不改变文件名。
- 这条规则第一次跑就抓到自己：DoD 里解释这个标记的那段散文**含有**这四个字，于是「行里出现过标记」把说明本身
  判成了无主候选，活文档当场变红。规则改成「行首是标记」——提到标记是散文，以标记开头才是回答，两半都进了断言
  （否则「忽略提及」在规则完全停止读取候选时也会绿）。

**P1-2：README 的安装段不再出现内部场合的说法。** 上一轮在安装段顶部写的是「初审答辩环境：Windows x64」/
「the environment this is reviewed and demoed on is Windows x64」。两句都真，但都在讲**我们**：一个内部场合
（初审答辩）与一个内部动词（demo），第一次装这个应用的人读到的是「这句话是写给谁看的」，而不是「哪个平台验证过、
下哪个文件」。改成「已验证环境：Windows x64，使用 `*-setup.exe`」/「Verified environment: Windows x64, using the
`*-setup.exe`」——平台事实与文件名都留着，去掉的只是场合。

- 新增 `readmeInternalTermViolations`（`tools/upstream-watch.mjs`）：两份 README 里不许出现内部场合的词
  （`答辩` / `评审` / `初审` / `内部评审` / `内部试用` / `演示环境`，英文侧 `demo` / `demoed` / `demoing`）。
  按词拒绝而不是按句，因为这句话回来的方式是「从某份报告里粘一句」，句子每次都不一样。
- 反向控制五格：正向全绿；前提（两份 README 都真的读到了，不是空清单）；中文那句粘回去点名文件、行号与「答辩」；
  英文那句粘回去点名「demoed」（只挡中文名词的规则挡不住它）；**平台事实本身仍绿**——把「macOS 与 Linux 只有源码」
  写进同一句必须不红，否则这条规则会连诚实的那半句一起赶走。

**P1-1：界面中文排版从三屏扩到六屏。** 上一轮把界面排版从手感变成断言，但只走了三屏（结果页选中一条
finding、长 finding、阅读页）。漏掉的三处恰好是**手写**中文最密的地方：通知条（主进程自己写的失败句）、
设置页（提示与解释，全应用最密）、首屏引导卡（新用户读到的第一段中文）。手写句子是半角逗号进来的唯一途径，
而模型返回的 finding 反而是最不容易出这种错的那一类。

- `tools/ui-cjk-typography.mjs` 新增三屏：`notice-overflow`（`?notice=overflow`，通知条被填到上限的那一屏）、
  `settings-top`、`guide-first-run`。规则函数一个没动——三屏复用同一份 `uiTypographyViolations`。
- 引导卡要**单独一份 storage**：其余各屏共用的 `STORAGE` 带 `guide-dismissed: 1`，继承它的引导屏会一张卡都不渲染
  却照样报绿。`walk` 改成「先 `localStorage.clear()` 再写这一屏的 storage」，否则上一屏写的键会漏进下一屏。
- 新增逐屏前提 `screensWithoutProsePunctuation`：一屏里**没有任何全角标点**就算没读到（导航落错页、正文挪进
  `pre`、夹具没渲染），直接退 2 而不是报绿。「没什么可报」与「什么都没读到」在一条只数违规的检查里是同一个答案。
- 反向控制从一条变两条（`MUTATIONS`）：报告那句之外，加设置页「不写配置、也不需要先保存」的顿号改半角，
  要求点名 `settings-top`。只加屏不加针，新屏就停在报告屏加针之前的状态——被一条没人证明能在那里触发的规则看着。
- `tools/ui-cjk-typography-smoke.mjs`（`audit:static`，无浏览器）补四格：六屏清单逐字断言（少一屏即红）、
  引导屏确实退出了 `guide-dismissed`、逐屏前提的正反两向（有散文的屏绿、只有裸标签的屏被点名）、
  以及「每条针都还在它渲染的那个组件里」从只查第一条改成查全部。

本轮改动：`tools/upstream-watch.mjs`（新增候选规则与 README 内部词规则）、`tools/upstream-watch-smoke.mjs`
（八格 + 五格断言）、`tools/ui-cjk-typography.mjs`（三屏 + 逐屏前提 + 第二条反向控制）、
`tools/ui-cjk-typography-smoke.mjs`（四格断言）、`docs/PRODUCT-DOD.md`（6 条各加证据候选与一段说明）、
两份 README（各一句）、`docs/measurements.md`（本轮验证数字 + 未验证清单加「导出 HTML 排版归上游」）、
本文件与归档。

## 上游状态（第 108 轮，2026-11-04）
第 108 轮复核：**上游没有新内容。**`git ls-remote` 这一轮答上来了：`refs/heads/main` 仍是 `8f9c8b7`，
`refs/tags/v1.13.4` 仍指向 tag 对象 `1393158`，`/releases/latest` 仍是 `v1.13.4`。三条通路答案一致，
**pin 不前进**，对照表 5 行因此不动，无移植项。

本轮按控制仓简报做 P0-1 的收尾、P1-2 与 P1-1，三件都不新增产品功能。

**P0-1：过线标准从「人读才能核」推到「脚本能核哪几条还没证据」。** 上一轮把 DoD 的版本事实拉进了断言，
但 `dodCheckboxViolations` 只对**勾上的**条目说话，而 6 条全是 `[ ]`——于是「六条里没有一条指出过任何一份
记录」是审计判绿的状态。「没什么可报」与「没人看过」对那条检查是同一个答案，而只有后者说明这份标准还在被维护。

- 每条 DOD 下面加一行缩进的 `证据候选：<仓内路径>`（`docs/PRODUCT-DOD.md`）：它回答的是另一半问题——
  **这一条若要勾，该去仓里翻哪份记录**。候选不是勾选，也不代替证据；勾选仍归 scheduler 侧，条目正文一个字没动。
- 新增 `dodEvidenceCandidates` / `dodEvidenceCandidateViolations`（`tools/upstream-watch.mjs`）：每条 ID 至少一个
  候选、候选路径必须真的在仓里、候选必须挂在某一条之下（写在第一条之前或清单之后属于「没有 ID 的候选」，
  看着像覆盖、实际一条都没补上）。
- 候选路径与证据路径共用同一个读法（`dodPathAfterMark`）：反引号与后面的括注都不改变「这一行指的是哪个文件」，
  两处各写一份「路径到哪结束」正是两条规则开始对同一行给出不同答案的方式。
- 反向控制（`tools/upstream-watch-smoke.mjs`）八格：正向全绿；前提（6 个 ID 都有候选、没有无主候选、候选数 ≥ 6）；
  删掉 DOD-5 的候选只点名 DOD-5；候选指向 `docs/no-such-record.md` 点名行号与路径；候选写在第一条之前点名行号；
  标记后面没有路径点名行号；**正文里提到标记不算候选**（见下）；候选路径的反引号与括注不改变文件名。
- 这条规则第一次跑就抓到自己：DoD 里解释这个标记的那段散文**含有**这四个字，于是「行里出现过标记」把说明本身
  判成了无主候选，活文档当场变红。规则改成「行首是标记」——提到标记是散文，以标记开头才是回答，两半都进了断言
  （否则「忽略提及」在规则完全停止读取候选时也会绿）。

**P1-2：README 的安装段不再出现内部场合的说法。** 上一轮在安装段顶部写的是「初审答辩环境：Windows x64」/
「the environment this is reviewed and demoed on is Windows x64」。两句都真，但都在讲**我们**：一个内部场合
（初审答辩）与一个内部动词（demo），第一次装这个应用的人读到的是「这句话是写给谁看的」，而不是「哪个平台验证过、
下哪个文件」。改成「已验证环境：Windows x64，使用 `*-setup.exe`」/「Verified environment: Windows x64, using the
`*-setup.exe`」——平台事实与文件名都留着，去掉的只是场合。

- 新增 `readmeInternalTermViolations`（`tools/upstream-watch.mjs`）：两份 README 里不许出现内部场合的词
  （`答辩` / `评审` / `初审` / `内部评审` / `内部试用` / `演示环境`，英文侧 `demo` / `demoed` / `demoing`）。
  按词拒绝而不是按句，因为这句话回来的方式是「从某份报告里粘一句」，句子每次都不一样。
- 反向控制五格：正向全绿；前提（两份 README 都真的读到了，不是空清单）；中文那句粘回去点名文件、行号与「答辩」；
  英文那句粘回去点名「demoed」（只挡中文名词的规则挡不住它）；**平台事实本身仍绿**——把「macOS 与 Linux 只有源码」
  写进同一句必须不红，否则这条规则会连诚实的那半句一起赶走。

**P1-1：界面中文排版从三屏扩到六屏。** 上一轮把界面排版从手感变成断言，但只走了三屏（结果页选中一条
finding、长 finding、阅读页）。漏掉的三处恰好是**手写**中文最密的地方：通知条（主进程自己写的失败句）、
设置页（提示与解释，全应用最密）、首屏引导卡（新用户读到的第一段中文）。手写句子是半角逗号进来的唯一途径，
而模型返回的 finding 反而是最不容易出这种错的那一类。

- `tools/ui-cjk-typography.mjs` 新增三屏：`notice-overflow`（`?notice=overflow`，通知条被填到上限的那一屏）、
  `settings-top`、`guide-first-run`。规则函数一个没动——三屏复用同一份 `uiTypographyViolations`。
- 引导卡要**单独一份 storage**：其余各屏共用的 `STORAGE` 带 `guide-dismissed: 1`，继承它的引导屏会一张卡都不渲染
  却照样报绿。`walk` 改成「先 `localStorage.clear()` 再写这一屏的 storage」，否则上一屏写的键会漏进下一屏。
- 新增逐屏前提 `screensWithoutProsePunctuation`：一屏里**没有任何全角标点**就算没读到（导航落错页、正文挪进
  `pre`、夹具没渲染），直接退 2 而不是报绿。「没什么可报」与「什么都没读到」在一条只数违规的检查里是同一个答案。
- 反向控制从一条变两条（`MUTATIONS`）：报告那句之外，加设置页「不写配置、也不需要先保存」的顿号改半角，
  要求点名 `settings-top`。只加屏不加针，新屏就停在报告屏加针之前的状态——被一条没人证明能在那里触发的规则看着。
- `tools/ui-cjk-typography-smoke.mjs`（`audit:static`，无浏览器）补四格：六屏清单逐字断言（少一屏即红）、
  引导屏确实退出了 `guide-dismissed`、逐屏前提的正反两向（有散文的屏绿、只有裸标签的屏被点名）、
  以及「每条针都还在它渲染的那个组件里」从只查第一条改成查全部。

本轮改动：`tools/upstream-watch.mjs`（新增候选规则与 README 内部词规则）、`tools/upstream-watch-smoke.mjs`
（八格 + 五格断言）、`tools/ui-cjk-typography.mjs`（三屏 + 逐屏前提 + 第二条反向控制）、
`tools/ui-cjk-typography-smoke.mjs`（四格断言）、`docs/PRODUCT-DOD.md`（6 条各加证据候选与一段说明）、
两份 README（各一句）、`docs/measurements.md`（本轮验证数字 + 未验证清单加「导出 HTML 排版归上游」）、
本文件与归档。

## 上游状态（第 107 轮，2026-11-03）
第 107 轮复核：**上游 HEAD 前进，pin 不动。**`git ls-remote` 这一轮超时（124），GitHub API 答上：
`refs/heads/main` 从 `76ab46a` 前进到 `8f9c8b7`（1 个 commit，2026-11-03T02:23:33Z），`refs/tags/v1.13.4`
仍指向 tag 对象 `1393158`，`/releases/latest` 与 npm `latest` 同为 `1.13.4`。发布的版本没动，所以
**pin 不前进**，对照表 5 行因此不动。

那个 commit 是 `fix(diff): keep tracked gitignored files in workspace review`（#1837），只改
`internal/diff/git.go` 与它的测试：`partitionDiffs` 在 `ModeWorkspace` 下不再套 `.gitignore`。理由写在
代码注释里——工作区模式里未跟踪的忽略文件早已被滤掉，再套一次只会误删**已跟踪**的改动（`git add -f`
进 `bin/` 的那种）。对本仓的影响是**无移植项**：本程序不自己过滤 diff，工作区范围就是
`ocr review --repo <path>`（`ocr-service.js` 的 `MODES.workspace`），文件清单与计数都来自 CLI 的 JSON，
所以这条修复的形状是「用户会看到工作区审查多出几个文件」，不是「我们要改代码」。它也不在对照表那 5 行
里（provider 解析、`config set` 语法、内置服务表、空服务表、`failure_class`），表不动。

本轮按控制仓简报做 P0-1 与 P0-2，两件都不新增产品功能。

**P0-1：DoD 里的版本事实从人工记忆变成断言。** 过线标准里写着两个版本：封装的上游发布
（`对照上游 ocr vX.Y.Z`）与本程序自己的版本（`v0.1.N`）。第 103 轮 pin 从 v1.13.3 升到 v1.13.4 时，
DoD 里那两处（头部「发版」行与 DOD-3 的括注）**没有跟着改**，而没有任何检查看得见——一句话里的版本号
不是任何规则读的形状。读的人因此以为封装的是旧引擎，而「下一刀还剩什么」正是对着这份文件回答的。

- 新增 `dodPinViolations(doc, { pinned, appVersion })`（`tools/upstream-watch.mjs`）：DoD 里出现的每个
  `vX.Y.Z` 只能是 **pin 的 tag** 或 **本程序版本**，其余一律红，并点名行号、那个 token 与两个被比较的值。
  规则写在**值**上而不是句子上：过期的 pin 与「历史版本事实」是同一类错误（后者该进归档与 README，
  不该进过线标准），一条规则同时挡住。
- `appVersion` 是**必填**而不是默认值：少了第二个允许值，本程序自己的 `v0.1.13` 会被判成过期 pin，
  而一条分不清两者的规则会被第一个撞上它的人关掉。所以调用方漏传本身是红的（`package.json 的 version` 那句）。
- 反向控制（`tools/upstream-watch-smoke.mjs`）五格：把 pin 的 tag 换回 `v1.13.3`，要求**每一行**都被点名
  （本轮是第 7、39 行）；「规则真的读到了东西」（两个版本都在 token 列表里，否则绿只说明它什么都没读）；
  历史版本 `v1.13.1` 写进 DoD 也红；同一句里出现第三个版本 `v1.13.5` 红而本程序版本绿；漏传 `appVersion` 红。
- 同时把 DoD 那两处改成 `v1.13.4`。这是**事实订正**，不是改条目：6 条 DoD 的 ID、勾选状态与正文一个字没动
  （`dodCheckboxViolations` 照旧全绿）。scheduler 侧那份同源副本的同一处仍是 `v1.13.3`，需要那边同步一次——
  本仓的断言只能管本仓这份。

**P0-2：答辩平台写进安装段第一句。** 两份 README 的 Install / 安装 段顶部各加一句：初审答辩环境是
Windows x64、用 `*-setup.exe`。此前「Windows 是唯一端到端验证过的平台」写在 Known limitations / 已知限制
里（第 104 轮从首屏下沉过去的），位置对，但读者要翻到那一节才知道；安装段是「我要不要下载」的决策点，
一句话放在那里比一节更早生效。没有新增平台承诺，也没有动代码。

本轮改动：`tools/upstream-watch.mjs`（新增 `dodPinViolations` / `DOD_VERSION_TOKEN`）、
`tools/upstream-watch-smoke.mjs`（五格断言）、`docs/PRODUCT-DOD.md`（两处版本号）、两份 README（各一句）、
本文件与归档。

## 上游状态（第 106 轮，2026-11-03）
第 106 轮复核：**上游没有新内容。**`git ls-remote` 这一轮答上来了：`refs/heads/main` 仍是 `76ab46a`
（与第 101–105 轮同一个 commit），`refs/tags/v1.13.4` 指向 tag 对象 `1393158`，`/releases/latest` 与
npm `latest` 同为 `1.13.4`。三条通路答案一致，**pin 不前进、无移植项**，对照表 5 行因此不动。

本轮按控制仓简报做 P0-1：**界面里的中文排版从「手感」变成断言。**

`tools/cjk-typography.mjs` 一直在查文档，而**屏幕是陌生人读的另一半，那一半没有任何检查看过**：
模型返回的 finding 里带一个半角逗号、某个标签写成 `用ocr跑`、某一行以「，」起头——这三种缺陷
`audit:ui` 全都看不见（布局仍然放得下、没有溢出、没有占位符泄漏），`audit:typography` 也看不见
（它从不打开应用）。所以三条规则从那份文件里**抽成可复用函数**（`lineStartViolation` /
`halfWidthViolations` / `bareAdjacencyViolations`），文档侧与界面侧共用同一份：在一处修好的规则
在两侧都修好，两份拷贝也就没有机会漂移。

- **`tools/ui-cjk-typography.mjs`**（`npm run audit:typography-ui`）用真浏览器走三屏——结果页选中
  一条 finding、长 finding 那一屏（模型写得最多的地方）、阅读/报告页——把每屏的可见文本按**块**取出
  （块 = 子元素全是行内级的最外层元素，所以 `<p>foo <strong>bar</strong></p>` 是一块而不是三块，
  行首禁则问的是句子而不是碰巧以逗号开头的碎片），再跑同一套规则。`pre` / `code` / `textarea` /
  `input` 整棵子树排除：代码样例不是散文，diff 里的 `foo(x,y)中` 不是排版缺陷——这条排除正是
  「规则」与「噪音」的分界，与文档侧对代码段的排除是同一条。
- **反向控制**：把报告里那句「固定到审查当时的那一版，之后分支再前进也不影响这份报告」的全角逗号
  改成半角，用同一份 bundle 的副本再走一遍三屏，要求本检查**变红并点名那一屏**。没有它，绿只说明
  「规则满足了」或「规则根本没跑」，而这两件事从外面看一模一样。
- **`tools/ui-cjk-typography-smoke.mjs`**（`npm run audit:typography-ui-rules`）是不需要浏览器的
  那一半：逐行断言界面侧与文档侧**报出同样的规则与同样的句子**（有人把规则抄进界面文件而不是 import，
  第一次改动就会红）、三条规则各自在渲染文本上点名到「哪一屏 / 哪个元素 / 第几行 / 哪段文字」、
  干净散文必须绿、以及反向控制那句原文仍在 `ReportView.tsx` 里（句子被改写时先在这里红，而不是让
  浏览器那一半退 2）。

**接线与简报的一处偏差，写在这里而不是悄悄改**：简报说把 `audit:typography-ui` 挂进 `audit:static`，
但这一半需要 `out/` 与浏览器，而 `audit:static` 的契约是「不构建、不开浏览器」。所以浏览器那一半挂在
`audit:app`（`npm run audit` 只构建一次，交给所有 harness），不需要浏览器的那一半挂在 `audit:static`。

**没有检查的，写清楚**：导出的自包含 HTML 报告是**上游 CLI**（`ocr session export`）写的，不是本程序
渲染的——它的排版归上游，声称在这里检查它只会是一盏接不到线的绿灯。本程序拥有的是导出所依据的那个
阅读页，那一页在检查范围内。另外行首禁则问的是**块首**：`innerText` 只在块边界与 `<br>` 处断行，
浏览器按栏宽折出来的行它看不见，所以「逗号被折到下一行」这一类不在覆盖内——这是真实的边界，写在
工具头部而不是糊过去。

**P0-2 的 critique 结论是「装饰多于信息」，据此做了一个具名 pass：`quieter`。** 三处 `Sparkles`
（✨ 是生成物最直白的签名）从结果页的要点标题、报告页的要点卡片与「模型判断过程」的折叠标题上摘掉——
它们不指向任何可点的东西，只是给每块文字配一个图标。同一趟 critique 撞出更硬的一条：结果页 header 的
`固定在 <sha>` 徽章在每一张截图里都是一堵 41 字符的十六进制墙，因为 `tools/ui-audit/fixtures.mjs` 的
SHA 是 **41** 位（真实 git 是 40 位），`shortRef` 的 `/^[0-9a-f]{40}$/` 从没匹配上——**审计一直在验一个
真实运行产生不出来的形状，而应用真正渲染的 7 位短形从没上过屏**。夹具改成 40 位，`expectPinnedCommit`
新增一条断言：徽章可见文本必须**恰好**是 `固定在 d41c8b7`（完整 SHA 仍留在 title 里）。`audit:ui` 112 条
全绿，`audit:typography-ui` 三屏 202 块全绿。

本轮没有动任何交互语义、IPC 与评审逻辑；改动只在 `tools/cjk-typography.mjs`（抽函数，行为不变，
`audit:typography` 与它的 smoke 全绿）、两个新 `tools/` 文件、`package.json` 的两条脚本与两处套件接线、
`src/components/ReportView.tsx` 与 `ResultsPanel.tsx` 的三处图标、`tools/ui-audit/fixtures.mjs` 与
`audit.mjs` 的 SHA 形状，以及本文件与归档。

## 上游状态（第 105 轮，2026-11-03）
第 105 轮复核：**上游没有新内容。**`git ls-remote` 这一轮没有输出（通路没答上来），HEAD 与 tag
都由 GitHub API 答上：`/commits/main` 仍是 `76ab46a`（与第 101–104 轮同一个 commit），
`/releases/latest` 与 npm `latest` 同为 `1.13.4`。三条通路答案一致，**pin 不前进、无移植项**，
对照表 5 行因此不动。

本轮按控制仓简报做三件事，都不动产品行为，主题是**让唯一权威源可验证**：

- **DoD 的勾选状态进断言。** `docs/PRODUCT-DOD.md` 是「下一刀只能从哪来」的唯一来源，而
  `dodAuthorityViolations` 只断言了头部是 locked / live——哪几条还开着，只能靠人读。现在每条
  前面有稳定 ID（`DOD-1` … `DOD-6`），`tools/upstream-watch.mjs` 新增 `dodChecklist` /
  `dodCheckboxViolations`：ID 必须唯一、状态只有 `[ ]` 与 `[x]` 两种、**勾上一条必须写
  「证据：<仓内路径>」且那个文件真的在仓里**、锁定时那 6 个 ID 一个都不许少。最后一条是这一轮
  真正想要的那条：编码侧不许自报完成，勾选必须追到仓里的一份记录。反向控制八格，其中一格是
  「同一个勾，补上存在的证据就转绿」——没有它，这条规则可能只是「任何条目都不许勾」。
- **中文排版的清单补上兜底。** `typographyTargets` 从两份 README 的 `.md` 指针推导，所以
  `docs/PRODUCT-DOD.md` 今天在清单里**只因为**某个 README 链了它；哪天首屏重写把那个链接去掉，
  过线标准就悄悄退出「排版被检查过」的集合，而 run 还是绿的。新增 `EXPLICIT_DOCS`（显式清单）
  与 `typographyCoverageViolations`：把两份 README 的 `.md` 指针全部抹掉之后，显式清单里的文档
  仍必须在被检查的清单里。反向控制先钉住前提（抹掉指针后 DoD 确实掉出推导清单），再要求清空
  显式清单时点名它。
- **「没验证过什么」从散句变成一节。** `docs/measurements.md` 末尾新增「未验证清单（截至
  2026-11-03）」：应用内更新、Linux / macOS 打包产物、真显示器与 GPU、单实例锁、卸载路径，
  每条写「为什么没验」与「下次要验的触发条件」。两份 README 的 Known limitations / 已知限制
  指向这一节，这一节也指回那边——「不覆盖」与「什么时候补」现在是同一件事的两面。

改动只在 `docs/PRODUCT-DOD.md`（只补 ID 与一句 ID 约定，勾选状态一个没动）、
`tools/upstream-watch.mjs` 与它的 smoke、`tools/cjk-typography.mjs` 与它的 smoke、
`docs/measurements.md`、两份 README 的一句指针，以及本文件与归档；评审逻辑、CLI 参数、配置读写
路径与运行期行为均未变。
上一轮（第 104 轮）的正文见 [upstream-history.md](upstream-history.md#上游状态第-104-轮2026-11-03)，归档之后本文件不留第二份。

## 上游状态（第 104 轮，2026-11-03）
第 104 轮复核：**上游没有新内容。**`git ls-remote` 退出码 0，`refs/heads/main` 仍是 `76ab46a`
（与第 101–103 轮同一个 commit）；`git ls-remote --tags` 最高仍是 `v1.13.4`，`/releases/latest`
与 npm `latest` 同为 `1.13.4`。三条通路的答案一致，**pin 不前进、无移植项**，对照表 5 行因此
不动；「最近一次对照停在上一轮」是什么意思，写在上面那张表的表头说明里——那不是欠账。

本轮按控制仓简报做三个具名 pass，都不动产品行为：

- **distill + clarify：两份 README 首屏第二段不再放平台验证矩阵。** 那一段讲的是「哪个平台验证到
  哪一层」，是构建者的账；读者在第一屏要的是「我明天能不能用它」。现在只剩一句：`v0.1.13` 跑的
  是 `ocr v1.13.4`，Windows 上从构建、安装到审查端到端跑通过，下面每条能力都是实跑出来的。矩阵
  本体在 Known limitations / 已知限制 那一节，一条没少（第 103 轮刚把它写全）。形状进了
  `firstScreenViolations` 的第 5 条：第一节里出现架构名、包格式名，或「按平台一条」的 bullet，就红。
- **distill：本文件人读区从 192 行减到 137 行。** 其中 27 行是上一轮正文照例归档，28 行是真的减重：
  「给 audit 看的约束」不再复述形状，「pin 存全 40 位」与「能自动变红的地方，和不能的地方」只留
  规则与其真实边界，逐轮是怎么补上的那些叙述交回 [`upstream-history.md`](upstream-history.md)
  对应的轮次——那儿是它们该在的地方，本文件也就少了一份会过期的拷贝。
- **harden：`audit:guards` 的沙箱重试判定抽成纯函数。** 「没写出报告」在第一次严格运行里还算
  环境问题，在 `--no-sandbox` 的重试之后就不算了。`tools/electron-guards.mjs` 现在导出
  `guardsRetryReason` / `guardsFailure`，新增的 `tools/electron-guards-smoke.mjs` 用夹具钉住
  「真崩溃不会被重试洗成绿」，并要求最后那句结论点名是崩溃、不许再写「环境问题」。

改动只在两份 README、`tools/upstream-watch.mjs` 与它的 smoke、`tools/electron-guards.mjs`、新增的
`tools/electron-guards-smoke.mjs`、`package.json` 的脚本表，以及本文件与归档；评审逻辑、CLI 参数、
配置读写路径与运行期行为均未变。

## 上游状态（第 103 轮，2026-11-03）
第 103 轮复核：**上游的发布版本前进了**——`v1.13.3` → `v1.13.4`（发布于 2026-11-02T15:19:48Z）。
`git ls-remote` 的 TLS 被断开，HEAD 与 tag 都由 GitHub API 答上，npm `latest` 同为 `1.13.4`；
新 tag 指的正是第 101 轮已经逐文件读过的 `76ab46a`，所以本轮要评估的不是新改动，而是**同一批
改动第一次成为被封装的那个发布版本**。对照表 5 行在这一次提交里逐行重读完毕（每行的结论与
依据写在最后一列），**pin 前进**：`PINNED_UPSTREAM`、pin 块、固定行、正文里的第三处声明、
`package.json` 的 `^1.13.4`，以及 `npm install` 落下来的二进制——它自报
`open-code-review v1.13.4 (76ab46a) linux/amd64`，与 pin 同一个 commit。

- **两处 Go 源码改动都追到了本仓的消费点，「不在对照表里」不等于「与本仓无关」。**
  `session show --json` 把空表从 `null` 改成 `[]`——本仓不调 `session show`，只用 `session list`；
  `file_read_diff` 的未命中提示改成点名缺哪条路径（`Error: diff not found for: …`、
  `Diffs exist for: …`）——那是回给模型的 tool 结果文本，而本仓按行首 `error:` 分类的两处
  （`ocr-service.js` 的 `errorLines`、流式 `emit` 的过滤）读的都是 CLI 自己的 stderr。
  所以**无移植项**：四个上游 commit 没有一个改变封装层看得见的内容。
- **通路账里那个把表截成两段的空行删掉了，并进了断言。** 第 102 轮的账里，第 101 与 102 行之间
  夹着一个空行：`ledgerRowsIn` 按形状扫这一节，跨过空行照常数到 56 行，而 Markdown 在空行处
  结束表格——读者看到的表停在第 101 轮，第 102 行渲染成正文里的竖线。新增
  `ledgerTableViolations`（表内出现空行即红，点名行号与两边的轮次，并说明读者丢掉哪几行），
  表前表后的空行不算红（那是 Markdown 的正常收尾）。反向控制里最要紧的一条不是「它会红」，
  而是**别的账都看不见它**：同一份被插入空行的文档，轮次连续、通路/欠账配套、「当前状态」绑定
  照旧全绿——所以这条断言顺便钉住了它的前提（解析器确实读得穿空行）。
- **跨平台的那条缺口用一次真实运行补上了一半，并且它当场抓到一个 harness 缺陷。** 升 pin 需要
  真跑一遍才算验证，而这一轮的开发机是 Linux x64：`npm install` 下来的 1.13.4 二进制自报
  `v1.13.4 (76ab46a) linux/amd64`，随后 `audit:config` / `audit:service` / `audit:git` /
  `audit:providers`（真 CLI）、`audit:guards`（24 条）/ `audit:exit`（5 条）/ `audit:e2e`
  （18 条，真 Electron + 真 CLI）、`audit:ui`（112 条）/ `audit:contrast`（978 处文本，0 处低于
  AA）/ `audit:ui-scaled`（1.25 与 1.5 各 11 条）全绿，数字与未覆盖面记在
  [`measurements.md`](measurements.md)。第一条变红的就是 `audit:guards`：这台机器的
  `chrome-sandbox` 不是 setuid root，Chromium 在写任何报告之前就死在 `setuid_sandbox_host.cc`，
  而 guards 的重试条件只认「报告里有 `bundle loads` 失败」这一种形状，于是它退出码 2 报
  「Electron crashed」——`tools/e2e-flow.mjs` 早就把「根本没有报告」当成环境问题重试了，两个
  harness 对同一种失败的说法不一致，就是「同一台机器上一条绿一条红」的来源。重试条件对齐之后
  guards 同样全绿。这条记录**不覆盖** Linux / macOS 的打包产物、真显示器与 GPU、以及安装版的
  自动更新——README 的 Known limitations / 已知限制 现在按这三档写。
- **同一趟核对撞出一个更硬的问题：英文 README 让读者去下载根本不存在的包。** 12 个 Release
  逐一看过，资产只有 `*-setup.exe` / `*-portable.exe` / `latest.yml` / blockmap——**从来没发布过
  一份 macOS 或 Linux 构建**，而 `README.md` 的「Option C — macOS」「Option D — Linux」却写着
  「打开 `*-mac-<arch>.dmg`」「`chmod +x` 那个 AppImage」，首屏还有一句「Builds ship for Windows,
  macOS and Linux」。中文版是对的（只有 A 安装版 / B 绿色版 / C 源码）。现在两份都对齐成同一句话：
  **发布面 = Windows，验证面 = Windows 端到端 + Linux 源码路径，macOS 从未构建也从未运行**；改动的
  位置是 `README.md`（首屏那段、Install 里合成一段的 C/D、Status、Known limitations）、
  `README.zh-CN.md`（首屏那段、版本状态、已知限制）与 `使用说明.md`（产物表的两行与「方式 C」的
  一句前置说明）。这一条不是「加功能」，是把已经在 DoD 里的「非官方诚实」延伸到「发布面诚实」。
- **把「每次升 pin 必红」的字面量换成真不变式。** smoke 里那条
  `PINNED_UPSTREAM.tag === "v1.13.3"` 的标题写着「pin 仍指着对照表所依据的那个发布版本」，
  但它从没打开过文档，而且 pin 每次合法前进都必须手改它——一个每次都要改的断言，最后一定被
  改成绿的。现在它问的正是标题那句话：5 行的「最近一次对照」都必须引用当前 pin 的 tag，
  反向控制把其中一行改回上一个 tag，要求红且点名那一行。

改动只在 `package.json` / `package-lock.json` 的 CLI 版本、`tools/upstream-watch.mjs` 与它的 smoke、
`tools/electron-guards.mjs` 的沙箱重试条件、两份 README 的验证范围措辞、`docs/measurements.md`，
以及本文件与归档；评审逻辑、CLI 参数、配置读写路径与运行期行为均未变。
上一轮（第 102 轮）的正文见 [upstream-history.md](upstream-history.md#上游状态第-102-轮2026-11-02)，归档之后本文件不留第二份。

---

## 上游状态（第 102 轮，2026-11-02）
第 102 轮复核：**上游没有新内容。**`git ls-remote` 退出码 0，`refs/heads/main` 仍是 `76ab46a`
（与第 101 轮同一个 commit），`git ls-remote --tags` 的最高 tag 仍是 `v1.13.3`，npm 仍是
`1.13.3`。**pin 不前进，无移植项。**

本轮的主题是上一轮简报的 P0-1：README 首屏从「能力清单」改成「产品主意」，并让这个口径有断言。

- **首屏一句话。** 两份 README 的标题下面现在是一句人话：这是什么、给谁、比终端强在哪。
  「非官方」声明留在紧跟的一段，实现细节（只做封装、不重写引擎）也还在，但不再是开场白。
  原来 Status 段那 16–18 条验证记录**下沉**到「已验证行为」/ `Verified behaviour` 一节，
  首屏只留五条用户能感知的能力，并指过去。
- **首屏形状进断言（`firstScreenViolations`，`tools/upstream-watch.mjs`）。** 首段必须恰好一句
  （数句末标点，代码块与 URL 不算）、不得出现 `--参数`（**代码块里的也算**）、不得出现
  「wrapper」「封装」这类实现口径；第一节必须 3–5 条、必须链接到本文件某一节，且那一节仍
  存着 ≥8 条——最后一条是这组规则里唯一会安静腐烂的方向：指针还在、节还在，记录被删掉了。
  每一格配一条反向控制（加第二句、塞 `--preview`、改成 wrapper、删到 1 条、加到 6 条、
  去掉链接、链接指向不存在的锚点、把那一节清空），两条 README 各问一遍。
- **`package.json` 的 `description` 同口径。** 从「Desktop wrapper for …」改成一句话说给谁解决
  什么，`npm view` / 包管理器里看到的也是产品主意而不是实现。

改动只在两份 README、`tools/upstream-watch.mjs` 与它的 smoke、`package.json` 的 `description`，以及本文件；
评审逻辑、CLI 参数、配置读写路径与运行期行为均未变。

---

## 上游状态（第 101 轮，2026-11-02）
第 101 轮复核：**上游 HEAD 前进，但发布版本没动，无移植项。**`git ls-remote` 退出码 0，
`refs/heads/main` 从 `216dcf5` 前进到 `76ab46a`（比 pin 多 4 个 commit）；`git ls-remote --tags`
本轮返回空行、tag 通路没答上来，release 改由 npm 回答：`1.13.3`。**pin 不前进。**

四个 commit 是 `9b0fab8`（Go / Node 版本与安全修复）、`cd8b55d`（GitHub Action 稳定性）、
`216dcf5`（`session show --json` 空表改 `[]`）、`76ab46a`（`file_read_diff` 找不到路径时点名缺哪条）。
没有一条碰到上面 5 处对照点，而它们对封装层的影响也各自为零：`session show` 本仓不调用（只用
`session list`，已容忍 `null`）；`file_read_diff` 是上游工具给模型的报错措辞，不对封装暴露；
两条版本 / CI 改动不改变二进制契约。所以本轮**不升 pin**，下一轮继续盯同一个发布版本。

本轮的主题是上一轮简报的 P0-2 与 P1-1：把「中文排版」从手感变成断言，并让声明与真实需求对齐。

- **三条禁则进脚本（`tools/cjk-typography.mjs`）。** 行首禁则（引用、列表前缀剥掉之后再问）、
  半角标点后接中文（代码块 / 行内代码 / 链接目标 / URL 除外）、中英裸拼（汉字与拉丁字母之间
  必须有分隔）。文件清单不是手写的：`docPointers` 从两份 README 推出所有相对 `*.md`，README
  自身也在清单里——手写清单恰好在「新加了一份文档」时过期，而那正是这条检查存在的理由。
- **三格反向控制（`tools/cjk-typography-smoke.mjs`）。** 每一格都是「真规则抓到 + 某个弱实现抓不到」：
  只看 `line[0]` 的版本对 `> ，…` 与 `- **、…` 视而不见；不看代码边界的版本会把围栏里的样例与
  `1. 标题` 一起判红（这正是会让规则被删掉的那种误报）；只比数字的版本对 `用ocr跑` 答零。
  另外，把 `README.zh-CN.md` 里一个全角句号改成半角，断言红在**那份文件的那一行**，且只改了一个字符。
- **`engines.node` 抬到 `>=22.18`。** `tools/notices-smoke.mjs` 与 `tools/ui-audit/fixtures.mjs`
  直接 import `src/lib/notices.ts`，依赖的是 Node 22.18 起不带 flag 的类型剥离；`>=18` 这条声明
  比真实需求低了一个大版本，属于「装了会红、但声明说能跑」的错账。

改动只在新增的两个 `tools/` 文件、`package.json` 的 `engines` 与 `audit:typography`，以及本文件；
评审逻辑、CLI 参数、配置读写路径与运行期行为均未变。

## 上游状态（第 100 轮，2026-11-02）

第 100 轮复核：**上游无新内容。**`git ls-remote` 退出码 0，`refs/heads/main` 仍是 `216dcf5`
（与第 98、99 轮同一个 commit），`git ls-remote --tags` 按版本排序的最高 tag 仍是 `v1.13.3`
（词法序的末位是 `v1.9.9`，`sort -V` 才是 1.13.3），`npm view` 仍是 `1.13.3`。**pin 不前进，
无移植项**：被封装的那个二进制与第 98 轮逐字节相同。

本轮的主题是「上一轮自己登记的 P0」——通知条有了三条回放，却没有任何一条断言在消费它们。

- **三条回放进断言。** `?notice=1` 要求恰好两行（`main-wiring.js` 的两句）、且 CLI 那句以
  `[notice]` 开头的原文**不在**条上、但在运行日志抽屉里逐字仍在（拒绝 ≠ 丢弃）；`?notice=many`
  要 1、2、1 只变成两行且首个句子仍在首位（重复不产生第二行、不跳到最后）；`?notice=overflow`
  要恰 `NOTICE_LIMIT`（从 `src/store.tsx` 读，不抄）条，最旧一句离场。期望行由**生产者**的
  文本拼出（`sentenceOf`）而不是调用被测规则，否则规则被削弱时期望跟着削弱，两边一致不等于
  断言。
- **反向控制不再靠人手。** 另起一个端口服务一份 `out/` 的副本，其中编译后的
  `logSource` 被判据削成「永远答 app」（即只用前缀的那版规则），要求**同一比较变红**并且
  红的话里点名那句伪装行；替换次数必须恰为 1，0 次就停——一个没被真正施加的变异是一枚
  证明不了任何事的绿灯。这条控制不受 `SHOT` 过滤影响，过滤跑也照样验。
- **纯函数边界进 `audit:notices`（`tools/notices-smoke.mjs`）。** `src/lib/notices.ts` 的注释
  里有六条不变量，此前只有注释：空串 id、非字符串 id（`123` / `true` / `[]` / `{}`）、
  `null` / `undefined` / 非对象载荷都算「无 run」；裸 marker 返回原文；句子两侧 trim；
  跑在某次运行名下的行一律不是提示。每种错法各有一次自测（真值判定、只减前缀、不剥 marker），
  另钉 `src/store.tsx` 的调用点必须是 `noticeText(line, logSource(payload))` 恰好一处。

改动只在 `tools/ui-audit/`（`audit.mjs` / `fixtures.mjs`）、新增的 `tools/notices-smoke.mjs`、
`package.json` 的 `audit:notices` 与 README 的审计命令清单；评审逻辑、CLI 参数、配置读写路径
与运行期行为均未变。

## 上游状态（第 99 轮，2026-11-02）

第 99 轮复核：**上游无新内容。**`git ls-remote` 退出码 0，`refs/heads/main` 仍是 `216dcf5`
（与第 98 轮同一个 commit），`git ls-remote --tags` 的最高 tag 仍是 `refs/tags/v1.13.3`，
`npm view @alibaba-group/open-code-review version` 仍是 `1.13.3`。**pin 不前进，无移植项**：
发布版本没动，被封装的那个二进制与第 98 轮逐字节相同。

本轮只动文档与断言，主题是「产品文件不能自己带伤，权威源只能有一处」，产品代码未动。

- **README 的截断不能只靠「有人看见」。** 截断规则（`docTruncationViolations`）存在了很多
  轮，却只被问过它自己所属的两份文档，于是 `README.md` 的架构代码块带着半行 `main.js Elec`
  活了下来，没有任何一条断言是红的——规则是对的，只是没被指向陌生人第一个打开的那个文件。
  所以现在**文件清单是推导出来的**：`docPointers` 从两份 README 里取出所有相对 `*.md`
  链接，`productDocViolations` 逐个要求「存在 + 闭合」，README 自身也在清单里。两步分开
  是有意的：丢了一条指针和一份文档被截断会说两句不同的话，而不是一句无法指向哪一半的话。
- **四条反向控制**：删掉 README 最后一个收尾围栏（点名文件与打开围栏的行号）、指向一份
  不存在的文档（点名目标是 404）、被指向的文档停在「，」上（点名是**哪份**文档截断，
  README 是干净的）、缺了收尾 `|` 的表格行。第四条是这轮被迫补的第五种答案：一份**以表格
  行收尾**的完整文档，按普通的「最后一行」读会停在连接符 `|` 上，于是把写完的文档判成截断
  ——表格行的收尾 `|` 本身就是终止符。
- **过线标准只能有一个权威。** `README.md` 让贡献者「DoD 勾满就停手」，而它指向的
  `docs/PRODUCT-DOD.md` 头部还写着 `writable draft … 尚未授权`：两处权威源互相矛盾，而
  一条「可能不算数」的标准不是标准。状态在 2026-10-31 定稿为 locked / live，`先改头部`
  只是把人读的部分改对；**不可再复现**才是这轮要做的事——`dodAuthorityViolations` 要求
  头部（第一条水平线之前）不出现 draft 词汇（`writable draft` / `尚未授权` / `草稿` 等），
  且「状态」一行必须写明 locked / live，并配两条反向控制：把旧头部原样粘回去要红、让头部
  「什么都没写」要红（后者是另一种错：它不矛盾，只是让读者无法判断）。

- **「这一轮是第几轮」不许从括号里的旧引用读出来。** 通路账与提交信息的绑定读的是
  `git log -1` 的标题，此前取的是标题里**第一个**「第 N 轮」。而本轮之前的那个提交先说了
  「抓出第 97 轮账加了一行」，后面才说「第 98 轮上游核对」——于是它自称第 97 轮，比自己的
  账落后一轮，**而且是绿的**：窗口本来就允许「账比 HEAD 领先一轮」。一条为了正确理由而绿的
  断言是这一整套东西最反对的形状，所以轮次现在先从固定的说法「第 N 轮上游核对」里读，读不到
  才退回第一个「第 N 轮」（发布提交那种写法）。三条反向控制钉住这个选择：旧引用在前仍读自己的
  轮次、标记之后又提到更早的轮次不改答案、没有标记的标题仍能读出唯一那个轮次。

改动只在 `tools/upstream-watch.mjs`、`tools/upstream-watch-smoke.mjs`、`docs/PRODUCT-DOD.md`
与两份 README 的过线标准指针；评审逻辑、CLI 参数、配置读写路径与运行期行为均未变。

上一轮（第 98 轮）的正文见 [upstream-history.md](upstream-history.md#上游状态第-98-轮2026-11-02)，归档之后本文件不留第二份。

---

## 上游状态（第 98 轮，2026-11-02）

第 98 轮复核：**上游默认分支前进了，发布版本没有。**`git ls-remote` 退出码 0，
`refs/heads/main` 已是 `216dcf5`（比 pin 多 3 个 commit：Go / Node 版本升级、GitHub Action
稳定性、`session show --json` 把空表打成 `[]`），而 `refs/tags` 最高仍是 `v1.13.3`、npm
仍是 `1.13.3`。本程序封装的是**发布出来的那个二进制**，所以 **pin 不前进**，对照表 5 行
也没有欠账——那三个 commit 的文件清单里没有一个 5 行引用的上游文件（`resolver.go` /
`config_cmd.go` / `llm_cmd.go` / `providers.go` / `failure_class` 均未出现）。**无移植项**。

留一条给未来：`216dcf5`（#1792）改的是 `session show --json` 的空 `items`（原来是 `null`，
现在是无条件 `[]`）。本仓不调 `session show`，调的是 `session list --json`，它在 pin 上仍
打印 `null`，`ocr-service.js` 的 `Array.isArray(...) ? ... : []` 已经把两种形状都兜住，所以
这条改动今天对我们没有影响。但**这个形状不在对照表 5 行里**：pin 真前进那天，除了 5 行还
要多读 `cmd/opencodereview/session_cmd.go` 一次，并把 `ocr session list --json` 的空表实际
跑一遍确认——上游正在逐个把 `null` 改成 `[]`，`show` 与 `comments` 已经改了。

本轮只动断言，主题是「接线与文档的形状不能只靠读源码相信」：

- **P0-1：桥的双射有反向控制了。** `tools/bridge-contract.mjs` 里接口的读法与通道的读法
  都收成一个函数（`interfaceIn` / `channelsIn`），下面新增八格自测：把 `src/lib/api.ts` 的
  一个方法改名喂进去，`missing` 与 `undeclared` 各点名自己那一侧；暴露侧同样改名则两个答案
  互换；把接口缩进改成四空格，严格正则读空而宽松正则仍数到 42 条，「没有成员被跳过」那条
  断言于是有它自己的红；把 `preload.js` 的一个通道改名，`unhandled` 与 `orphans` 同时点名
  新旧两个拼写；把 `RUN_EXIT_CHANNEL` 的值改指别处，`neverSent` 与 `sentToNobody` 双端变红
  ——这一格专门盯「main 侧经常量发出的通道」，正则丢了常量解析就会把它读成没人发的事件。
- **P0-2：人读区的形状进断言。** `tools/upstream-watch.mjs` 新增 `humanSectionViolations`：
  「关系 / 规则 / 当前状态 / 改这份文档之前」四节在人读区各恰好一次，缺一节、降级成 `###`、
  被复制两份、或整节被搬进机器可读区，都点名行号；另加一条「当前状态标题的轮次必须等于通路
  账末行」。通路账的行改由 `ledgerRowsIn` 一处解析，烟测与规则读同一张表。这条断言第一次跑
  就把本仓自己的断链抓出来了：第 97 轮加了账的一行，却没有重写本节，标题停在第 96 轮——
  两边各自都自洽，所以此前没有任何一条规则看得见它。第 96 轮的正文已按约定搬到
  `docs/upstream-history.md`，本节不留第二份。
- **P1-3：三条同拼写条目。** `tools/config-handler-smoke.mjs` 补 `spellingClashMessage` 的
  三入口三种形状（三条同段、两条一段加一条另一段且表静默、三条分三段），每格按 `entries`
  的配对断言、并要求句子里两处计数都来自条目数；一个把 `listed` 截成前两条的实现会在这里
  变红（已用临时改动验过：两条用例全绿、三条用例红），把 `sameSection` 写成
  `entries.length > 1` 也一样红——两条的时候不暴露的分叉，三条才暴露。

改动只在 `tools/bridge-contract.mjs`、`tools/upstream-watch.mjs`、
`tools/upstream-watch-smoke.mjs`、`tools/config-handler-smoke.mjs` 与两份上游文档；产品代码
未动（`config-handler.js` 只是被临时改坏用于自测，已还原）。评审逻辑、CLI 参数、配置读写
路径与运行期行为均未变。

上一轮（第 96 轮）的正文见 [upstream-history.md](upstream-history.md#上游状态第-96-轮2026-10-27)，归档之后本文件不留第二份。

---

## 上游状态（第 96 轮，2026-10-27）

第 96 轮复核：**HEAD 未变，结论仍是「无新内容」；git 与 npm 均可核对。**
`375f64cd…` 与 pin 一致（与第 49–95 轮同一个 commit），`git ls-remote --tags` 仍以
`refs/tags/v1.13.3` 为最高版本，`npm view @alibaba-group/open-code-review version` 仍是
`1.13.3`。**无移植项**。

本轮只动测试与文档，主题是「已落地的行为，边界要有会红的反向控制」：

- **P0-1：超限丢最旧 + 非法 limit。** `tools/window-sender-smoke.mjs` 继续要求
  `limit: 3` 下连发 5 条、`markReady()` 后留下最后 3 条且 `lost === 2`；新增反向控制：
  一个越界就 `held.pop()` 的 sender（丢最新）同样报 `lost === 2`，但交出的行是
  `1/2/3`，必须判红。非法 limit 列表补上字符串 `"3"`，并新增「把 limit 原样收下」的
  sender 作为反例——它不会落回 `DEFAULT_PENDING_LIMIT`。
- **P0-2：非法 limit / 非法 message。** `tools/main-wiring-smoke.mjs` 补四格：
  `reportSenderLoss({ limit: 0 })` 与 `{ limit: -5 }` 的句子不带括号、仍含条数、不含
  `undefined` / `NaN`；`reportProbeError({ message: undefined })` 与
  `{ message: 42 }` 落 `未知错误` 兜底。两条反向控制分别是「只做
  `Number.isSafeInteger` 不做 `> 0`」的上限判断（会印出 `（0 条）` / `（-5 条）`）与
  「直接插值 message」的写法（会印出 `undefined` / `42`）。
- **P1-3：未就绪不触碰 window。** 测试窗口新增 `calls()` 计数；未就绪时 `send` 一条，
  要求 `webContents.send` 的调用数为 0（不只是「没收到」），并用一个「照发不误」的
  sender 证明这个 0 不是计数器本身失效。

改动只在 `tools/window-sender-smoke.mjs`、`tools/main-wiring-smoke.mjs` 与两份上游
文档。评审逻辑、CLI 参数、配置读写路径与运行期行为均未动。`audit:sender` /
`audit:wiring` / `audit:upstream` 本轮全绿。

---

## 上游状态（第 95 轮，2026-10-27）

第 95 轮复核：**HEAD 未变，结论仍是「无新内容」；git 与 npm 均可核对。**
`375f64cd…` 与 pin 一致（与第 49–94 轮同一个 commit），`git ls-remote --tags --refs` 仍以
`refs/tags/v1.13.3` 为最高版本，`npm view @alibaba-group/open-code-review version` 仍是
`1.13.3`。**无移植项**。

本轮只动 `main.js` 的两处「说出口」，主题是「同一句话不要只用读源码来断言」：

- **P0-2：`reportSenderLoss`。** 原来「队列上限丢了几条」整段写在 `did-finish-load` 的
  回调里，测试只能按文本问「`lost > 0` 附近有没有 `send("run:log", { line: … })`」——
  这句话对「永远不执行的分支」也是绿的，对「挪进一个函数」是红的。现在搬进
  `main-wiring.js`（`send` 注入），`main.js` 只留 `reportSenderLoss({ ...windowSender
  .markReady(), limit: windowSender.limit, send })`；`lost === 0` 不说话、`lost > 0` 只说
  一次、通道是 `run:log`、payload 只有 `{ line }`、句子带条数与上限——都由
  `tools/main-wiring-smoke.mjs` 直测，并把「换通道 / 换键 / 丢掉计数 / `if (lost)`」
  四种写法定否。
- **P1-1：`reportProbeError`。** 同一模式收口 `onProbeError` 的真实 sink：句子、通道与
  `{ line }` 在 `main-wiring.js` 里被直测（含「空消息仍有话说」「没有 `send` 不抛」
  「`console.warn` / 另一个通道 / 丢掉消息」三种反例），`main.js` 只剩
  `onProbeError: (message) => reportProbeError({ message, send })`，
  `tools/app-info-smoke.mjs` 改问这条接线。
- **P0-1：`markReady()` 的 `sent` 语义。** JSDoc 写明 `sent` 是**本次调用**送出的条数
  （中断后的一次 `markReady()` 只报剩余部分，两次答案相加才是队列原长），并补一条反向
  控制：`survivesInterruptedFlush` 对真模块要求「中断后继续 flush，全队列按序各一次」，
  对「一失败就清空队列」的写法判红。

改动在 `main-wiring.js`（新增）、`main.js`、`package.json`（`build.files` 与
`audit:wiring`）、`tools/main-wiring-smoke.mjs`（新增）、`tools/window-sender-smoke.mjs`、
`tools/app-info-smoke.mjs`、`window-sender.js`（仅注释）、`docs/upstream-history.md` 与
本文件。评审逻辑、CLI 参数、配置读写路径与运行期行为均未动。`audit:static` 本轮全绿。

---

## 上游状态（第 94 轮，2026-10-27）

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

## 上游状态（第 93 轮，2026-10-27）

第 93 轮复核：**HEAD 未变，结论仍是「无新内容」；git 与 npm 均可核对。**
`375f64cd…` 与 pin 一致（与第 49–92 轮同一个 commit），`git ls-remote --tags --refs` 仍以
`refs/tags/v1.13.3` 为最高版本，`npm view @alibaba-group/open-code-review version` 仍是
`1.13.3`。desktop 的 `^1.13.3` 与 pin 一致，本轮把这一点变成了断言（见下 P1）；
**无移植项**。

本轮三件事，主题是「同一个承诺写在两处时，让两处互相看着」：

- **P0-2（真缺陷）：窗口未就绪时发出的行不再静默丢弃。** `main.js` 的 `send()` 原本是
  `if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(…)`：看着像
  安全网，其实是静默丢弃。`updater.init()` 在 `createWindow()` 之前就跑，启动时算出的
  `update:state` 谁也收不到；窗口正在重建、或页面还没加载完时产生的 `run:log` 同样消失
  ——而这正是「异常要有出口」那条约束下最不能丢的一类行（装好的应用没有终端）。现在
  这些行**排队**，在渲染进程的 `did-finish-load` 时按原序 flush；队列有上限（
  `DEFAULT_PENDING_LIMIT = 200`），超限丢最旧的并**把丢掉的条数从 `markReady()` 还回来**，
  由 `main.js` 在 `run:log` 上说出「窗口就绪前有 N 条事件超出缓冲上限」。实现收进
  `window-sender.js`（`createWindowSender({ currentWindow })`），`main.js` 只留接线：
  `createWindow()` 里 `markUnready()`、`did-finish-load` 上 `markReady()`。
- **P1-4：`package.json` 的依赖版本 ↔ `PINNED_UPSTREAM.tag`。** 文档写「封装上游
  v1.13.3」、依赖写 `^1.13.3`，是同一个承诺的第四份拷贝；`^` 允许下一次 `npm install`
  就换成 1.14，而 pin、对照表 5 行与 `UPSTREAM_RESOLVER` 模拟仍描述 1.13.3。新增
  `dependencyPinViolations()` / `versionInRange()`，`audit:upstream` 要求两者一致，并把
  「依赖抬到 `^1.14.0`」「压根没写依赖」「区间读不出版本（`*`）」三种情形逐条演成红。
- **P2-5：注释引用的章节必须**恰好一处**。** 第 92 轮只断言「那个标题存在」；同一标题在
  文档里出现两次时，注释指向哪一处只能靠猜，而其中一份迟早没人维护。现在按**计数**判定，
  并自测「复制一份同名标题即红、改成相近但不同的名字不红」。

改动在 `window-sender.js`（新增）、`main.js`、`package.json`（`build.files` 与
`audit:sender`）、`tools/window-sender-smoke.mjs`（新增）、`tools/upstream-watch.mjs`、
`tools/upstream-watch-smoke.mjs`、`tools/git-service-smoke.mjs`、`docs/upstream-history.md`
与本文件。评审逻辑、CLI 参数、配置读写路径均未动。`audit:sender` / `audit:packaging` /
`audit:bridge` / `audit:git` / `audit:upstream` 本轮全绿，`audit:static` 整体复跑亦全绿。

## 上游状态（第 92 轮，2026-10-27）

第 92 轮复核：**HEAD 未变，结论仍是「无新内容」；git 与 npm 可达。**
`npm run upstream:check` 本轮走 git 通路、退出码 0，`375f64cd…` 与 pin 一致（与第
49–91 轮同一个 commit）；`git ls-remote --tags --refs` 仍以 `refs/tags/v1.13.3` 为最高
版本，`npm view @alibaba-group/open-code-review version` 仍是 `1.13.3`。desktop 的
`^1.13.3` 无需改动，**无移植项**。

本轮按控制仓简报收口三件事，主题是「同一类事实只留一个出口、一个地址」：

- **P0-3：`probeError` 的出口与卸载告警统一到 `run:log`。** 第 91 轮把 `probeError` 接到
  `main.js` 的 `console.warn`，可同一文件里的卸载告警刻意不用它：装好的应用没有终端，
  stderr 不是用户能读的地方。现在 `onProbeError` 发 `run:log`（`{ line }`，无 `id`），与
  `app:uninstall` 的 `warn` 同一个 sink；payload 与键集不变。`tools/app-info-smoke.mjs`
  的接线断言改问 `send("run:log", { line: … })`，并补一条构造式自测：`console.warn` 与
  `{ id }` 都判否、`{ line }` 判是——换通道或换字段都会红。
- **P0-1：代码→文档的章节引用可自动变红。** `git-service.js` 的两处注释都让人去读
  `docs/OCR-UPSTREAM-SYNC.md` 的「能自动变红的地方，和不能的地方」。该节一直存在，但没有
  断言；改名后注释会指向不存在的位置而全绿。`tools/git-service-smoke.mjs` 现在把源码里的
  `docs/OCR-UPSTREAM-SYNC.md … 『标题』` 解析出来，与文档标题做空白归一比较，并自测
  「把标题改掉」会点名缺失的那一个。
- **P0-2：第 91 轮正文核对无截断。** 该段完整结束于改动清单与绿灯记录；本轮把它原样归档
  到 `upstream-history.md`，本文件只留指针（`previousRoundPointerViolations` 全绿）。

改动在 `main.js`、`app-info.js`（注释）、`tools/app-info-smoke.mjs`、
`tools/git-service-smoke.mjs`、`docs/upstream-history.md` 与本文件；不碰 `src/**`、CLI 参数、
配置读写与其它 IPC 注册体。`audit:appinfo` / `audit:git` / `audit:upstream` 本轮全绿，
`audit:static` 整体复跑亦全绿。

---

## 上游状态（第 91 轮，2026-10-27）

第 91 轮复核：**HEAD 未变，结论仍是「无新内容」；git 与 npm 可达。**
`git ls-remote https://github.com/alibaba/open-code-review.git HEAD` 本轮退出码 0，
`375f64cd…` 与 pin 一致（与第 49–90 轮同一个 commit），`refs/tags/v1.13.3` 的 tag 对象仍
指向同一 commit；`npm view @alibaba-group/open-code-review version` 仍是 `1.13.3`（第 90 轮
git 通路报 GnuTLS 错误，本轮恢复）。desktop 的 `^1.13.3` 无需改动，**无移植项**。

本轮按控制仓简报收口两条「诊断与空值语义只写在注释里」的缺口：

- **P0-2：`probeError` 的丢弃有了出口，而 payload 不变。** `formatAppInfo` 仍然不返回
  任何诊断字段（第 90 轮的三处清单照旧），但「服务真的抛了」此前除了 `version: ""` 之外
  没有任何读者。`handleAppInfo` 现在接受一个注入的 `onProbeError`（默认 no-op），只在
  `exec` 抛错时调用一次、传入 `describeProbeError` 的那句话；`main.js` 传入
  `console.warn`，所以真实用户那里不再蒸发。回调自身抛错被接住——它只是日志，不能把
  `app:info` 变成拒绝、把设置页变空白。`timedOut` 仍不设出口：等待由本模块自己的预算
  封顶，「不等了」的可见后果（空版本）payload 已经带着；异常才是别处无从得知的失败。
  `tools/app-info-smoke.mjs` 断言四种情形：抛错时调用一次且句子正确、正常应答不调用、
  服务自报超时/静默不调用、回调抛错时 payload 仍完整；并断言 `main.js` 的接线里有
  `onProbeError` 与 `console.warn`。反向控制：删掉 `handleAppInfo` 里的调用，第一条即红。
- **P1-1：空串的语义进断言。** `binarySource` 用 `||` 把 `""` 与「没有 source」折成同
  一个 `null`——这是决定，但此前只覆盖了「键缺失」一格，改成 `??` 会静默让页面收到空徽章。
  `installInfo()` 的 `executable` 同理（真实 Electron 永远给路径，只有 stub 能构造空串）。
  `tools/app-info-smoke.mjs` 与 `tools/install-info-smoke.mjs` 各补一格，后者同时要求其余
  五个事实不变，避免「修这个字段」顺手抹掉另一个。

P0-1（`AppInfo` ↔ 两条清单的交叉断言）已由第 90 轮落地，本轮不重复。
P2-4 只补了注释：`handleAppInfo` 在探测之后读安装事实是有意的——回答描述的是交出去的
那一刻，而探测是唯一可能耗秒的部分。

改动在 `app-info.js`、`main.js`、`tools/app-info-smoke.mjs`、`tools/install-info-smoke.mjs`、
`docs/upstream-history.md` 与本文件；`binarySource` / `executable` 的运行期行为未变，
`probeError` 只是从「无处可去」变成「去一条日志」。`audit:appinfo` / `audit:install` /
`audit:upstream` 本轮全绿（`audit:static` 随后整体复跑）。

上一轮（第 90 轮）的正文见 [upstream-history.md](upstream-history.md#上游状态第-90-轮2026-10-27)，归档之后本文件不留第二份。

**补记（第 92 轮）**
第 91 轮把 `probeError` 接到 `main.js` 的 `console.warn`；第 92 轮改为同一个 `run:log`
sink（`{ line }`），payload 与键集不变，接线断言同步改问通道。本段正文保留当时的记录。

## 上游状态（第 90 轮，2026-10-27）

第 90 轮复核：**HEAD 未变，结论仍是「无新内容」；git 通路报 TLS 错误（GnuTLS），改由 API 作答。**
`refs/heads/main` 的顶端仍是 `375f64c`（与第 49–89 轮同一个 commit，通路 `api`），
`v1.13.3` 仍为最新 release，npm 仍是 `1.13.3`；desktop 的 `^1.13.3` 无需改动，**无移植项**。

该轮只改测试与注释：`ledgerRoundViolations` 的 N / N+1 窗口用构造提交逐格自测
（N / N+1 绿，N-1 / N-2 红并点名两边轮次）；`timedOut` / `probeError` 的丢弃决定收敛成
`app-info.js` 里的三处清单，并加上 `src/lib/types.ts` 的 `AppInfo` ↔
`APP_INFO_COMPUTED_KEYS` + `INSTALL_INFO_KEYS` 交叉断言。

**补记（第 91 轮）**
第 90 轮只更新了同步文档的机器可读区（pin 行与通路账第 90 行），人读区正文此前没有
单列；本段由第 91 轮据该轮提交信息与通路账补写，结论以通路账为准。

## 上游状态（第 89 轮，2026-10-27）

第 89 轮复核：**HEAD 未变，结论仍是「无新内容」；git 与 npm 可达。**
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main` 本轮退出码 0，
`375f64c` 与 pin 一致（与第 49–88 轮同一个 commit）；`git ls-remote --tags --refs` 仍以
`refs/tags/v1.13.3` 为最高版本，`npm view @alibaba-group/open-code-review version` 仍是
`1.13.3`（tag 对象本轮没有独立重读——branch 未变即「无新 commit」，registry 的 `latest`
未变即「无新发布」）。desktop 的 `^1.13.3` 无需改动，**无移植项**。

本轮按控制仓简报收口两条「清单或文案漂移不会红」的缺口，都不改运行期行为与 UI：

- **P0-1：`APP_INFO_COMPUTED_KEYS` 补上「每个列出的名字都被某次返回」的弱约束。**
  第 88 轮只断言「返回值 ⊆ 清单」，于是「从 `formatAppInfo` 删掉一个字段但忘删清单」是
  静默的：单向检查只问返回键在不在清单里，没问清单里的名字还活不活。现在
  `tools/app-info-smoke.mjs` 用三种形态（有 binary + 版本、无 binary、无 installInfo）拼出
  实际返回键的并集，要求清单里每个名字至少出现一次；清单仍是权威，约束仍是弱的（不要求
  每次调用的键集相同）。反向控制：从 `formatAppInfo` 的返回里删掉 `platform`，断言点名
  `missingFromAnswers: ["platform"]` 并红。`tools/install-fixture.mjs` 的注释同步改成
  「两个方向问的不是同一个问题」。
- **P0-2：兜底分支的用户可见文案带上 git 原文摘要，并证明真 git 会走到这里。**
  `error` 自第 82 轮起就带 git 首行与退出码，`rawStderr` 自第 88 轮起保存完整 stderr，
  但「`error` 真的含原文」此前没有断言——把 `first` 换成固定句，所有检查仍绿。
  `tools/git-service-smoke.mjs` 现在用两行表外措辞断言：`error` 含首行、不含第二行，
  `rawStderr` 含第二行；再拿一个**真 git** 的非仓库失败（`fatal: not a git repository`）走
  同一条 `readFileAtRef`，要求 `rawStderr` 非空、`error` 含其首行——这证明兜底不是只能被
  stub 构造出来。（`gitEnv()` 固定 C locale，所以「非 C locale 更深地走到兜底」无法从
  `readFileAtRef` 这一侧主动制造；真 git 的兜底证据改由这条未被识别的真实措辞提供。）
  反向控制：把兜底 `message` 里的 `first` 去掉，两条断言当场红。

改动只在 `tools/app-info-smoke.mjs`、`tools/install-fixture.mjs`（注释）、
`tools/git-service-smoke.mjs`、`docs/hardening-log.md`、`docs/upstream-history.md`
与本文件；不碰 `main.js`、`src/**`、CLI 参数、配置读写、IPC 注册体或运行期代码。
`audit:appinfo` / `audit:git` / `audit:upstream` 本轮全绿（`audit:static` 随后整体复跑）。

上一轮（第 88 轮）的正文见 [upstream-history.md](upstream-history.md#上游状态第-88-轮2026-10-27)，归档之后本文件不留第二份。

## 上游状态（第 88 轮，2026-10-27）

第 88 轮复核：**HEAD 未变，结论仍是「无新内容」；API 与 npm 可达，git 通路本轮超时。**
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main` 本轮超时
（`timeout` 返回 124，与第 83、86 轮同因），改由 `npm run upstream:check` 走
`api.github.com/repos/alibaba/open-code-review/commits/main` 作答：`sha` 仍是 `375f64c`
（与第 49–87 轮同一个 commit，通路 `api`）；`npm view @alibaba-group/open-code-review version`
仍是 `1.13.3`。tag 一处本轮没有独立核对——`refs/heads/main` 未变即「无新 commit」，
registry 的 `latest` 未变即「无新发布」。desktop 的 `^1.13.3` 无需改动，**无移植项**。

本轮按控制仓简报收口三条「外部世界变了不会红」的缺口，都不改运行期行为与 UI：

- **P0-1：`describeProbeError` 补上「`message` 是抛错 getter」这一格。**
  `"message" in error` 走原型链，读取一个会抛的 getter 会让 `describeProbeError` 自己抛；
  它运行在 `.catch` 里，抛出去就是设置页空白。该形状本来就由 try/catch 接住，但此前没有
  断言：现在 `tools/app-info-smoke.mjs` 用
  `Object.defineProperty({}, "message", { get() { throw … } })` 作拒绝值，要求
  `probeError` 落回固定句 `exec rejected without a message`、`app:info` 不拒绝。反向控制：
  去掉 try/catch，断言当场红并停在 `describeProbeError`。
- **P0-2：`APP_INFO_COMPUTED_KEYS` 成为唯一权威，返回值只做单向断言。**
  第 87 轮从返回键推导撞名面，与清单做等值断言；两侧同时改就仍能同绿。现在
  `tools/app-info-smoke.mjs` 要求 `formatAppInfo` 的返回键 **⊆** `APP_INFO_COMPUTED_KEYS`
  （多出来即红），撞名面从常量推导而不是从返回值推导；清单里多出一个函数未返回的名字
  不报错（它只是作为普通安装字段随 `...installInfo` 走）。反向控制：给 `formatAppInfo`
  加一个返回字段但不改常量，断言点名该字段并变红。
- **P0-3：`readFileAtRef` 落到兜底分支时带出 git 原始 stderr。**
  `REF_READ_WORDINGS` 的 sample 是手写的；git 改措辞或换 locale 时表全部 miss、答案仍是
  `failed`，而 `audit:git` 原本照旧全绿。现在兜底分支把未 trim 的 stderr 放进返回对象的
  `rawStderr`（只在该分支；不拼进用户可见的 `error`），并由 `tools/git-service-smoke.mjs`
  用表外措辞 `fatal: something new` 断言 `reason === "failed"` 且 `rawStderr` 非空；同一
  组断言还要求已识别措辞不带 `rawStderr`，否则该字段就不再标记「这是兜底」。反向控制：
  去掉 `rawStderr`，断言当场红。

改动只在 `app-info.js`（注释）、`tools/app-info-smoke.mjs`、`tools/install-fixture.mjs`
（注释）、`tools/install-info-smoke.mjs`（注释）、`git-service.js`、
`tools/git-service-smoke.mjs`、`docs/hardening-log.md`、`docs/upstream-history.md`
与本文件；不碰 `main.js`、`src/**`、CLI 参数、配置读写或 IPC 注册体。
`audit:appinfo` / `audit:git` / `audit:upstream` 本轮全绿（`audit:static` 随后整体复跑）。

## 上游状态（第 87 轮，2026-10-27）

第 87 轮复核：**HEAD 未变，结论仍是「无新内容」；git 与 npm 可达。**
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main` 本轮退出码 0，
`375f64c` 与 pin 一致（与第 49–86 轮同一个 commit）；`git ls-remote --tags --refs` 仍以
`refs/tags/v1.13.3` 为最高版本，`npm view @alibaba-group/open-code-review version` 仍是
`1.13.3`（tag 对象本轮没有独立重读——branch 未变即「无新 commit」，registry 的 `latest`
未变即「无新发布」）。desktop 的 `^1.13.3` 无需改动，**无移植项**。

本轮按控制仓简报收口两条「会红」的边界，都不改运行期行为：

- **P0-1：`formatAppInfo` 的撞名面从「七个计算字段」扩到「全部返回键」。**
  `tools/app-info-smoke.mjs` 不再从手写清单取键，而是从
  `formatAppInfo({ installInfo: {} })` 的返回对象直接读；每个键各给一个 `evil-<key>` 值
  塞进 `installInfo`，断言全部保住计算值。共享的 `APP_INFO_COMPUTED_KEYS` 仍保留
  （`install-info-smoke.mjs` 用它证明模块不提供撞名），但新增一格要求它恰好等于这组返回
  键——清单落后于返回值时先红。验过会红：把 `...installInfo` 挪到计算字段之后，七个键
  逐一变成 `evil-*`，失败信息列全。
- **P0-2：`docs/upstream-history.md` 不许整串引用 pin。**
  新增 `historyPinLeakViolations`：按 `PINNED_UPSTREAM.sha` 的整串逐行查，命中即点名行号；
  7 位前缀、别的 commit / tag 对象的整串仍然允许。pin 常量不是整串时直接报错，避免
  `includes()` 永远不中而让规则空过。归档里原有的 25 处整串 pin 一并改成 7 位前缀（与文件
  开头早已写下的「历史段里的 SHA 是 7 位前缀或 tag 对象」一致）；这是本轮唯一的归档正文
  改动，取舍记在 `docs/hardening-log.md`。反向控制：在归档第一行插入整串 pin，断言点名
  第 1 行且只改了一行。

改动只在 `app-info.js`（注释）、`tools/app-info-smoke.mjs`、`tools/install-info-smoke.mjs`、
`tools/install-fixture.mjs`（注释）、`tools/upstream-watch.mjs`、`tools/upstream-watch-smoke.mjs`、
`docs/hardening-log.md`、`docs/upstream-history.md` 与本文件；不碰 `main.js`、`src/**`、
CLI 参数、配置读写或 `git show` 分类。`audit:appinfo` / `audit:upstream` / `audit:static`
本轮全绿。

## 上游状态（第 86 轮，2026-10-27）

第 86 轮复核：**HEAD 未变，结论仍是「无新内容」；API 与 npm 可达，git 通路本轮超时。**
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main` 本轮超时
（`timeout` 返回 124，与第 47–48、83 轮同因），改由 `npm run upstream:check` 走
`api.github.com/repos/alibaba/open-code-review/commits/main` 作答：`sha` 仍是 `375f64c`
（与第 49–85 轮同一个 commit，通路 `api`）；`npm view @alibaba-group/open-code-review version`
仍是 `1.13.3`。tag 一处本轮没有独立核对——`refs/heads/main` 未变即「无新 commit」，
registry 的 `latest` 未变即「无新发布」。desktop 的 `^1.13.3` 无需改动，**无移植项**。

控制仓简报里的 P0-1、P0-2、P1-1 在前两轮已全部落地（`handleAppInfo` 的 spread 直测、
`Object.create(null)` 的 resolve 断言、`bridge-contract` 的 arity 检查）。本轮做简报的
下一条 P1，并把随之而来的 pin 双写取舍记进加固日志。

- **P1-2：人读区的编辑规则拆成两节。** 旧清单六条里，只有「本文件只留当前一轮」「归档
  只追加补记」「每轮通路账记一行」是**人要做的动作**；其余三条（机器可读区只由脚本维护、
  pin 恰好三处、别把锚点字面量抄进人读区）其实是 `tools/upstream-watch.mjs` 常量的
  说明书，抄在文档里就是第二份会过期的拷贝。现在 `docAuthoringRuleViolations` 要求：
  父节下恰好一个「给人读的编辑约定」（至少 3 条编号规则）与一个「给 audit:upstream 看的
  约束」，顺序固定，且后者必须点名 `tools/upstream-watch.mjs`。smoke 用六种「只改一处」
  的副本各自验证会红：删父节、删任一小节、交换两小节、把整节挪到当前状态之后、把人的
  清单删到两条、以及在约束节里抹掉脚本指针。
- **P2：pin 双写的取舍入档。** `docs/hardening-log.md` 记下「pin 在
  `tools/upstream-watch.mjs` 与本文各写一份、靠 `audit:upstream` 双向比对」这一选择，
  以及何时该改成单一来源。

改动只在 `tools/upstream-watch.mjs`、`tools/upstream-watch-smoke.mjs`、`docs/hardening-log.md`
与本文件；不碰 CLI 参数、配置读写、运行期行为或本文件的机器可读区（除本轮自己的 pin 行与账）。
`audit:upstream` / `audit:static` 本轮全绿。

## 上游状态（第 85 轮，2026-10-27）

第 85 轮复核：**HEAD 未变，结论仍是「无新内容」；git 与 npm 均可核对。**
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main` 本轮退出码 0，
`375f64c` 与 pin 一致（与第 49–84 轮同一个 commit）；`git ls-remote --tags` 显示
`refs/tags/v1.13.3^{}` 仍指向同一个 commit；`npm view @alibaba-group/open-code-review version`
仍是 `1.13.3`。GitHub API 本轮没有另问一次——git 的 branch 与 tag 两条都答了问题。
desktop 的 `^1.13.3` 无需改动，**无移植项**。

本轮兑现控制仓简报里唯一还没落地的一项：`main.js` 的接线层此前只有正则断言
（「handler 里有 `...probe`」），证明的是源码拼写，不是「探针的整个返回对象真的交给了
`formatAppInfo`」。

- **P0-1：`app:info` 的 handler body 抽成可调用的 `handleAppInfo`，并直测 spread。**
  `app-info.js` 新增两个导出：`assembleAppInfo({ binary, probe, …facts })` 是唯一执行
  `...probe` 的那一行；`handleAppInfo` 负责取 `binaryResolution()`、跑
  `readVersionOutput`、调 `assembleAppInfo`，并把服务四参数
  `exec(args, cwd, env, options)` 到探针 `exec(args, { timeoutMs })` 的适配也收进来。
  `main.js` 的注册现在只剩 `ipcMain.handle("app:info", () => handleAppInfo({ … }))`。
  `tools/app-info-smoke.mjs` 用**带 getter 的探针对象**问 `assembleAppInfo`：`timedOut`
  与 `probeError` 是否被读取，只有真的发生 spread 才会为真；反面控制是「只取
  `versionStdout`/`versionStderr`」的写法，同样两个 getter 保持沉默——证明这条断言分得清
  spread 与挑选。另有三格问 `handleAppInfo` 本身：服务只被调用一次且参数是 `["version"]`、
  预算落在第四个参数、`Object.create(null)` 的 rejection 仍 resolve 出完整 payload
  （`installInfo` 只读一次）。验过会红：把 `...probe` 改成显式两个字段，spread 那格与
  「handler 走 `assembleAppInfo`」那格当场红；还原后全绿。
- **P0-2：`describeProbeError` 的「不 reject」断言**在上一轮已经落地
  （`exec: () => Promise.reject(Object.create(null))` 的 resolve + 固定句），本轮复核后
  保留，不重复加格。
- **P1-1：`preload.js` ↔ `src/lib/api.ts` 的方法名 / 参数个数**同样已由
  `tools/bridge-contract.mjs` 覆盖（双向名单、arity、逐参数落点），本轮复核后不动。

改动只在 `app-info.js`、`main.js`、`tools/app-info-smoke.mjs` 与本文件；不碰 CLI 参数、
配置读写、`git show` 分类或本文件的机器可读区（除本轮自己的 pin 行与账）。
`audit:appinfo` / `audit:bridge` / `audit:static` 本轮全绿。

## 上游状态（第 84 轮，2026-10-27）

第 84 轮复核：**HEAD 未变，结论仍是「无新内容」；git、API 与 npm 均可核对。**
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main` 本轮退出码 0，
`375f64c` 与 pin 一致（与第 49–83 轮同一个 commit）；
`api.github.com/repos/alibaba/open-code-review/commits/main` 给出同一个 `sha`；`npm view
@alibaba-group/open-code-review version` 仍是 `1.13.3`。tag 一处本轮没有独立核对——
`refs/heads/main` 未变即「无新 commit」，registry 的 `latest` 未变即「无新发布」。desktop
的 `^1.13.3` 无需改动，**无移植项**。

本轮按控制仓简报换方向：不加新的断言密度，而是把三处容易维护错的规则收敛。

- **P0-1：`installInfo` 撞名从注释约定变成双向断言。** `formatAppInfo` 先展开
  `installInfo`，再用七个计算字段覆盖，所以撞名字段会无声消失。`tools/app-info-smoke.mjs`
  现在用一个与**全部七个**计算字段重名、且值都不同的对象喂进去，断言七个字段全部保住计算值
  （不只是抽查 `binary` / `version`），并前置断言这个撞名对象确实覆盖了七个名字。
  `tools/install-info-smoke.mjs` 从另一边钉：`installInfo()` 返回的六个名字不得与那七个
  重名，且共享的 `APP_INFO_COMPUTED_KEYS` 必须覆盖完整的七个——否则「没有撞名」会在一张
  空表上通过。验过会红：把 spread 挪到计算字段之后，七个字段逐一被 `evil` 值顶掉；
  把 `userData` 改名成 `binary`，install 一侧点名 `collisions:["binary"]`。
- **P0-2：`tools/upstream-watch-smoke.mjs` 的自测入口从环境变量改成命令行参数。**
  原来两个变量（选中红色子进程 / 选中绿色子进程）在 CI 或用户环境撞名时会改变
  `npm run audit:upstream` 的行为。现在是 `--selftest` / `--no-respawn` 两个精确 token，
  并新增三格：无参数时两个开关都为假（不从环境推断）、近似拼写（`--selftest=1`、裸
  `selftest`）不算开关、旧环境变量名不再出现在源码里。红色子进程只带 `--selftest`，
  另有一格断言它没有重入 spawn；绿色子进程仍证明整轮套件不是天生红。
- **P1-1：文档的编辑规则有了人读入口。** `docs/OCR-UPSTREAM-SYNC.md` 人读区开头新增
  「写这份文档的规则」六条（不抄锚点字面量），`tools/upstream-watch.mjs` 的
  `docAuthoringRuleViolations` 断言这一节存在、至少四条编号规则、且在当前状态之前；
  smoke 用删标题、把标题挪到当前状态之后、把清单删到三条三种副本验证它会红。

断言只动 `tools/app-info-smoke.mjs`、`tools/install-info-smoke.mjs`、
`tools/install-fixture.mjs`、`tools/upstream-watch-smoke.mjs`、`tools/upstream-watch.mjs`
与本文件，不碰 CLI 参数、配置读写、IPC 注册体或运行时行为。`audit:appinfo` /
`audit:install` / `audit:upstream` 本轮全绿。

## 上游状态（第 83 轮，2026-10-27）

第 83 轮复核：**HEAD 未变，结论仍是「无新内容」；API 与 npm 两条通路可达。**
`git ls-remote https://github.com/alibaba/open-code-review.git` 本轮超时（`timeout` 返回
124，与第 47–48 轮同因），改由 `api.github.com/repos/alibaba/open-code-review/commits/main`
回答：HTTP 200，`sha` 仍是 `375f64c`（与第 49–82 轮同一个 commit）；`npm view
@alibaba-group/open-code-review version` 仍是 `1.13.3`。tag 一处本轮没有独立核对——
`refs/heads/main` 未变即「无新 commit」，registry 的 `latest` 未变即「无新发布」。desktop
的 `^1.13.3` 无需改动，**无移植项**。

本轮把上一轮承认的那半个缺口补上，并给 78/81/82 三轮真实发生过的那条路径加一格断言：

- **P0-1：真 git 的 stderr 现在也要过表。** 第 82 轮把措辞假设外化成
  `REF_READ_WORDINGS`（每行带 `reason` / `pattern` / `sample`），但 `sample` 是手写字符串，
  证明的只是「表同意自己」。本轮 `tools/git-service-smoke.mjs` 用**同一个 `git()`**（因此
  同一个 `gitEnv()`，仍是 C locale）、同一个临时仓库，问 git 要这两个失败的真 stderr，再交给
  `readFileAtRef` 用的**同一个分类器**（`classifyRefReadFailure`，本轮为此导出）。三格三件事：
  ① 真 git 仍以一行 `fatal: …`、退出码 128 回答这两个失败（这是 sample 的写法声明的前提）：
  `fatal: path '不存在/的路径' does not exist in 'HEAD'` 与
  `fatal: invalid object name 'not-a-real-ref'.`；② 每句话只被**一个**带 pattern 的行认出来，
  且就是答案里那一行；③ 认出真话的行，与手写 `sample` 落到的行是**同一个行对象**——sample
  与现实不可能各走一行还各自「对」。第四格是这三格的自测：两句真话都以 `fatal:` 开头，所以
  「放宽成前缀」那种改法会同时命中两行，而表里没有任何一行会——断言写在 git 自己的输出上。
  验过会红：把 `missing` 的 pattern 改成 `/^fatal:/i`，`bad-ref` 那格立刻点名
  `matched=["bad-ref","missing"]`，随后每一格依赖「唯一命中」的检查一起红。
  下文「能自动变红的地方」那句「没有任何 audit 会因为 git 改措辞而变红」因此**不再成立**，
  已就地改写成它现在的真实边界：今天这套 git 的这两句话被钉住了，**别的失败**（子模块、
  git 为其它情形保留的拼写）仍没人钉。
- **P0-2：`createRunner` → `runUpstreamWatch` 那条线，按**文本**断言。** 第 59 轮起 git→API
  的回落在**对象**上已被断言（`channel: "api"`），但轮次里人看到的是句子，中间还隔着
  `upstreamDrift` → `formatDrift` 两道：`channel` 在路上丢了，对象仍绿而句子会印「通路：none」，
  于是一次核对过的轮次读起来像欠账。现在注入 `git` 返回 `{error: ETIMEDOUT}`、API 返回 pin，
  走完整条 `runUpstreamWatch`，断言句子带「通路：api」、不带 `[UPSTREAM-DEBT]`、不带
  `[UPSTREAM-MOVED]`、**也不带那条失败通路的原因**（`ETIMEDOUT` 不许漏进安静句子里，
  否则「无 marker = 没事要做」这个 grep 就不成立），退出码 0；另一格两条路都失败：句子以
  `[UPSTREAM-DEBT]` 开头、带「通路：none」、两条原因都在、退出码仍 0。验过会红：把
  `runUpstreamWatch` 里透传的 `channel` 写死成 `"git"`，第一格当场点名
  `"channel":"git"` 与整句文本。

两条都在 `git-service.js` / `tools/git-service-smoke.mjs` 与本文件里（P0-2 只动
`tools/upstream-watch-smoke.mjs` 的断言），不碰 CLI 参数、配置读写与 IPC 注册体；改写了的
那句话在下面「能自动变红的地方，和不能的地方」一节。`audit:git` / `audit:upstream` 本轮全绿。

上一轮（第 82 轮）的正文见 [upstream-history.md](upstream-history.md#上游状态第-82-轮2026-10-27)，归档之后本文件不留第二份。

## 上游状态（第 82 轮，2026-10-27）

第 82 轮复核：**HEAD 未变，结论仍是「无新内容」；API 与 npm 两条通路可达。**
`git ls-remote https://github.com/alibaba/open-code-review.git` 本轮超时（`timeout` 返回
124，与第 47–48 轮同因），改由 `api.github.com/repos/alibaba/open-code-review/commits/main`
回答：HTTP 200，`sha` = `375f64c`（与第 49–81 轮同一个
commit，2026-10-20 的 `fix(tool): report an empty code_comment batch instead of success
(#1773)`）；`npm view @alibaba-group/open-code-review version` 仍是 `1.13.3`。tag 一处本轮
没有独立核对——`refs/heads/main` 未变即「无新 commit」，registry 的 `latest` 未变即「无新
发布」。desktop 的 `^1.13.3` 无需改动，**无移植项**。

本轮把两件「注释里承认过、但没有断言钉住」的假设变成会红的检查：

- **P0-1：`readFileAtRef` 的 stderr 措辞假设外化成 `REF_READ_WORDINGS` 表。** 此前是两条
  正则内联在分类分支里，配一句注释坦白「这匹配的是 git 的英文措辞，没人检查这个假设」。
  现在三行数据、每行带 `reason` / `pattern` / `sample`：`bad-ref`、`missing`、兜底
  （`pattern: null`，必须是最后一行且唯一）。分类改成遍历表：第一个命中的 `pattern` 赢，
  都不命中就是兜底。smoke 把每行的 `sample` 真喂回 `readFileAtRef`（仍是 stub 掉的
  `spawn`），要求拿回该行自己的 `reason`；再要求「带 sample 的行覆盖全部三种答案」、
  兜底行唯一且最后。删掉 `bad-ref` 正则里的 `bad revision`，那格当场红并点名 sample 与
  实际答案；删掉 `missing` 的 sample，覆盖率那格红——两条都验过。这也纠正了下文一句旧话：
  「没有任何 audit 会因为措辞而变红」不再成立，**表自己的主张**现在有断言；仍然没人钉的
  是「git 明天还这么说」（sample 是手写字符串）。
- **P0-2：核对通路账的末行绑定到提交信息的轮次。** 账的行规则（通路 / 欠账 / 连续 / 末行
  与固定行一致）此前全都只读文档自己：一轮提交了却没记账，文档依然完全合法，只是比提交
  落后一轮。现在 `ledgerRoundViolations()` 用 `git log -1 --format=%s` 里的「第 N 轮」对账，
  允许账末行是 N（已提交）或 N+1（先改文档、后提交）；比 N 少就是漏记，句子点名两边的
  轮次并提醒「没核对也要记一行」。smoke 从真文档里删掉末行、拿该行轮次当提交信息喂进去，
  断言红且同时说出两个数字；另有三格把它钉紧：领先两轮、提交信息里没有轮次、账是空的。

两条都在 `git-service.js` / `tools/git-service-smoke.mjs` / `tools/upstream-watch.mjs` /
`tools/upstream-watch-smoke.mjs` 与本文件内，不碰 CLI 参数、配置读写与 IPC 注册体；
`audit:service` / `audit:config` / `audit:git` / `audit:upstream` 本轮全绿。

## 上游状态（第 81 轮，2026-10-27）

第 81 轮复核：**HEAD 未变，结论仍是「无新内容」；API 与 npm 两条通路可达。**
`git ls-remote https://github.com/alibaba/open-code-review.git` 本轮超时（`timeout` 返回
124，与第 47–48 轮同因），改由 `api.github.com/repos/alibaba/open-code-review/commits/main`
回答：HTTP 200，`sha` = `375f64c`（与第 49–80 轮同一个
commit，2026-10-20 的 `fix(tool): report an empty code_comment batch instead of success
(#1773)`）；`npm view @alibaba-group/open-code-review version` 仍是 `1.13.3`。tag 一处本轮
没有独立核对——`refs/heads/main` 未变即「无新 commit」，registry 的 `latest` 未变即「无新
发布」。desktop 的 `^1.13.3` 无需改动，**无移植项**。

本轮按上一轮留下的三件事收口，主题都是「一行检查在防什么，必须有答案」：

- **P0-1：`classifyRef` 里那两行 `Number.isFinite` 定案为「不是防御，是多做的换算」，删掉。**
  上一轮把计数改成十进制数字严格匹配后，那两行看着不可达——其实可达，只是要一个 309 位以上
  的计数（`Number.parseInt("9".repeat(400))` 是 `Infinity`）。但它防的那件事本来就不该发生：
  四种关系只问「哪一半是零」。所以现在**不做任何数值换算**，`isZeroCount()` 直接读数字
  （`/^0+$/`）。smoke 补两格超大计数（24 位与 400 位）：两者都仍答一个关系；把 `parseInt`
  放回去，400 位那格当场答 `""`（`Infinity` 进 `isFinite` 守卫）、四格普通计数仍绿——已这样
  验过。「这一行在防什么」的答案现在是：什么都不防，它是多余的。
- **P0-2：`gitEnv` 的 spawn 接线探针从「问 `git()`」改成「问 `readFileAtRef`」。**
  第 80 轮正文说这条探针还在——它确实在，但问的是 `fresh.git(["--version"])`：证明的是
  `git()` 会带 `gitEnv()`，不是**代码面板那条读文件的路**会。把 `spawn("git", ["show", …])`
  内联进 `readFileAtRef`（参数都现成，看着像无害的简化）会让分类悄悄脱离 C locale，而旧探针
  照旧全绿。现在探针走一次真的 `readFileAtRef`，从 `spawn` 的 options 里读回 `LC_ALL` /
  `LANG` / `PATH` / `cwd`，并断言那次调用真的带了 `show`——已按上面的内联验过会红（三格）。
  那个函数因此有了两条互补的断言：`gitEnv()` 问返回值，本探针问接线。
- **P1-1：「本文件只留当前一轮」从散文变成断言。** 人读区此前的「上一轮（第 79 轮）」是完整
  正文，与 `upstream-history.md` 里的第 79 轮段重复，而文件开头就写着「只留当前一轮」。正文按
  规则搬进归档，这里只留一句指针；同时新增 `previousRoundPointerViolations()`（在
  `tools/upstream-watch.mjs`）：人读区不得再起「上一轮（第 N 轮）」的标题段、指针必须恰好一句、
  指针说的那一轮必须在归档里真有段落、锚点必须等于那段标题算出来的 slug（否则点过去落在归档
  文件顶部，看着像点成功了）。smoke 用四条「只改一处」的副本逐条验红。

三条都在 `git-service.js` / `tools/git-service-smoke.mjs` / `tools/upstream-watch.mjs` /
`tools/upstream-watch-smoke.mjs` 与本文件内，不碰 CLI 参数、配置读写与 IPC 注册体；
`audit:service` / `audit:config` / `audit:git` / `audit:upstream` 本轮全绿。

---
## 上游状态（第 80 轮，2026-10-27）

第 80 轮复核：**HEAD 未变，结论仍是「无新内容」；git 与 npm 两条通路都可达。**
`git ls-remote https://github.com/alibaba/open-code-review.git HEAD refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64c`
（与第 49–79 轮同一个 commit），`refs/tags/v1.13.3` 仍指向 annotated tag 对象
`dd925205e108304bd4dd6cc0f8e8b7cf8dee77ea`；`npm view @alibaba-group/open-code-review version`
仍是 `1.13.3`。desktop 的 `^1.13.3` 无需改动，**无移植项**。

本轮不再扩纯函数抽取，回到 `git-service.js` 里两处「相信一个自己控制不了的输入」的地方，
各补一条会红的断言——两条都先验过「改回旧写法就红」：

- **P0-1：`classifyRef` 的计数改成「十进制数字」严格匹配。** 原来两半交给
  `Number.parseInt` 再查 `Number.isFinite`，而 `parseInt` 接受数字**前缀**：`"3x 0"` 读成
  3 与 0（`ancestor`）、`"0 3x"` 读成 0 与 3（`descendant`）、`"0x10 0"` 读成 0 与 0——
  **`same`**，正是这个函数唯一不能错的那个答案（「两分支是同一个 commit」）；负号同理
  （`"-1 0"` → `ancestor`），而 `rev-list` 根本印不出负计数。现在两半先过 `/^\d+$/`，
  形状不对一律答 `""`，`inspect` 就不把该 ref 放进 `relations`、UI 回落到工作区。
  smoke 新增六格畸形形状（`3x` / `0x10` / 负号 / 小数），与已有的四格合法形状同表；
  把严格匹配换回 `parseInt`，这六格当场红、四格合法形状仍绿——已这样验过。
- **P0-2：`gitEnv` 导出并直测。** 固定 `LC_ALL=C` / `LANG=C` 是 `readFileAtRef` 两条
  英文分类的前提，此前只有「真跑一次 git、从 `spawn` 的 options 里读回 env」这一条路：
  它证明键到了 `spawn`，但证明不了展开语义与「每次调用新建」——删掉 `...process.env`
  后 `git` 仍能靠默认路径被找到，探针照样成功。现在直接问导出的 `gitEnv()`：在
  `zh_CN.UTF-8` 的环境里两个键仍是 `C`，且**调用方的 `process.env` 未被改写**（排除
  「改完再返回同一个对象」）；`PATH` 与一个自造的调用方变量都还在（spread 的语义）；
  两次调用之间改变量，第二次能看见（不是模块加载时的快照）。去掉 spread，三格红；已验过。
  同一段还留着「键确实进了 `spawn` options」那条探针，两者互补：一个问函数，一个问接线。

两条都在 `git-service.js` 与 `tools/git-service-smoke.mjs` 内，不碰 CLI 参数、配置读写与
`readFileAtRef` 的 stderr 分类；`audit:service` / `audit:config` / `audit:git` 本轮全绿。

## 上游状态（第 79 轮，2026-10-27）

第 79 轮复核：**HEAD 未变，结论仍是「无新内容」；git 与 npm 两条通路都可达。**
`git ls-remote https://github.com/alibaba/open-code-review.git HEAD refs/tags/v1.13.3`
退出码 0，`refs/heads/main` = `375f64c`（与第 49–78 轮同一个
commit），`refs/tags/v1.13.3` 仍指向 annotated tag 对象
`dd925205e108304bd4dd6cc0f8e8b7cf8dee77ea`；`npm view @alibaba-group/open-code-review version`
仍是 `1.13.3`。desktop 的 `^1.13.3` 无需改动，**无移植项**。

本轮仍不扩大纯函数抽取范围，只补上一轮抽出来的那两个函数里最后没被问过的形状：

- **P0-1：`formatAppInfo` 的 `installInfo` 同名覆盖定案为「顶层优先」。** 原来
  `...installInfo` 展开在最后，一个叫 `binary` / `version` / `configPath` 的安装事实会**静默**
  顶掉刚算出来的值，而载荷的 key 集因为同名不变，钉 key 集的断言看不见它。现在展开挪到最前：
  字段同名是撞名，不是更好的答案，撞名的安装字段被丢弃。smoke 用
  `installInfo: { binary: "evil", version: "9.9.9", binarySource: "evil", configPath: "/evil/…" }`
  逐字断言四个字段保住计算值、key 集不变、且不撞名的安装事实照旧随行（否则「顶层优先」可以
  用「索性丢掉 installInfo」实现而这条仍绿）。把展开挪回下面，这条会直接红——已这样验过。
- **P0-2：`describeProbeError` 的原型链两端各补一格。** `"message" in error` 走原型链是
  **决定**：`Error` 子类可以把 `message` 做成原型上的 getter，`hasOwnProperty` 会把这种合法错误
  判成「没有消息」，所以断言 `Object.create({ message: "inherited" })` 落到 `"inherited"`，而
  普通 `Error` 仍答自己的 message。另一端 `Object.create(null)` 没有 `toString`，`String(it)`
  会**抛**——这行跑在 `.catch` 里，抛出去就是 `app:info` 被拒、设置页空白，所以取值加了守卫，
  这一格断言它答固定句子而不是拒绝（去掉守卫，这条当场红）。
- **P1-3：`versionWaitMs` 的 `grace` 字段去掉。** 它只有一个读者——本文件的测试——正是第
  71/72 轮从载荷里清掉的那种「只被断言存在」的字段。现在答案就是 `{ budget, wait }` 两个数
  （smoke 断言 key 集恰好这两个），「grace 回落到了默认值」改成问 `wait - budget`，也就是真正
  进 `setTimeout` 的那个量。

沿用第 78 轮的结论：这三条都在 `app-info.js` 与 `tools/app-info-smoke.mjs` 内，不碰 CLI 参数、
配置读写与 `git show` 分类，`audit:service` / `audit:config` / `audit:git` 不受影响。

## 上游状态（第 78 轮，2026-10-27）

第 78 轮复核：**HEAD 未变，结论仍是「无新内容」；本轮 git 超时、API 作答，npm 一致。**
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 本轮在 120 秒预算内没有返回（`timeout` 退出码 124，无输出），
`api.github.com/repos/alibaba/open-code-review/commits/main` 退出码 0，
`sha` = `375f64c`（与第 49–76 轮同一个 commit）；
`npm view @alibaba-group/open-code-review version dist-tags` 仍是 `1.13.3` /
`latest: 1.13.3`（tag 一处本轮没有独立重读，由 `main` 顶端未变与 npm 版本未变共同说明）。
desktop 的 `^1.13.3` 无需改动，**无移植项**。第 77 轮的提交没有更新本文件，因此本轮在
通路账里补了一行 `none` 与它欠下的 HEAD 核对；本轮这次 API 核对只清本轮的账。

本轮继续补已经抽出来的纯函数的分支覆盖，不再扩大抽取范围。上一轮把「抛错」与「沉默」
分开记在 `probeError` 之后，剩下没被问过的是**等待本身**和**异常值的形状**：

- **P0：等待预算抽成 `versionWaitMs`，四种非法 grace 与四种非法 budget 各断一次。**
  `readVersionOutput` 里那两行原本是内联的：`Number.isFinite(timeoutMs) && timeoutMs > 0`
  与 `Number.isFinite(graceMs) && graceMs >= 0`。它们各自决定一个数字，而这两个数字的
  形状只有在 `setTimeout` 里才看得见——`setTimeout(Infinity)` 在 Node 里立刻触发，所以
  「读到的最长等待」实际是最短的等待。现在计算收进导出的 `versionWaitMs({ timeoutMs,
  graceMs })`，返回 `{ budget, grace, wait }`：非法 budget 回落默认值，非法 grace 回落
  默认 grace，`wait` 由两者相加。smoke 逐条问四格（负 / `NaN` / `Infinity` /
  `undefined`），断言 `wait === budget + VERSION_PROBE_GRACE_MS`；再断言 `graceMs: 0`
  是被遵守的（`wait === budget`，不能被并进非法值）；再对一组输入扫一遍不变量
  `wait >= budget`——「deadline 绝不落在子进程自己的预算之内」是这两行存在的理由。
  正常 pair（40+60=100）也断了一次，否则四条回落用例在两个常量相等时可能恒真。
- **P0：接线与交给 `exec` 的预算一起断言。** 纯函数绿不代表探针用它：smoke 先要求
  `app-info.js` 里恰好是 `const { budget, wait } = versionWaitMs({ timeoutMs, graceMs });`，
  再让 `exec` 立即返回，断言 `timeoutMs: 0` 时服务收到的是 `VERSION_PROBE_MS` 而不是
  `0`——非法值必须在交给子进程之前就被换掉，否则 `exec` 会按 `NaN`/`0` 去设自己的 timer。
  另有一格在时钟上：`timeoutMs: 30, graceMs: -10` 的挂死服务必须在 30+默认 grace 之后
  才被判 `timedOut`；若负 grace 漏进 `setTimeout`，等待会是 20ms，早于子进程自己的 30ms
  预算，这条会先红。
- **P1：`exec` 不是函数、异常值没有句子，也各有一格。** `readVersionOutput` 的第一个
  early return 是 `!binaryPath || typeof exec !== "function"`，此前只测了「没有 binary」
  那一半；现在补「有 binary 但 `exec: null`」，断言答案是 `timedOut: false` 的空输出——
  没人可问是接线错了，不该报成「CLI 很慢」。`describeProbeError` 也补了三种被拒值：
  裸字符串原样成为句子；`new Error("")` 与**没有 `message` 的普通对象**落到同一句
  `exec rejected without a message`。最后一格顺带修了一个小洞：普通对象原先被
  `String()` 成 `"[object Object]"`，那是一个值但不是一条诊断（没有可查的东西），
  现在与空消息同答。三种都断言 `timedOut === false`，因为「抛错」不是「超时」。

上游那三条自动变红的网（`audit:service` / `audit:config` / `audit:git`）本轮不受影响：
本轮改的是版本探测的等待与诊断，不碰 CLI 参数、配置读写和 `git show` 分类。

## 上游状态（第 76 轮，2026-10-27）

第 76 轮复核：**HEAD 未变，结论仍是「无新内容」；git 与 npm 两条通路都可达。**
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64c`
（与第 49–75 轮同一个 commit），`refs/tags/v1.13.3` 仍指向 annotated tag 对象
`dd925205e108304bd4dd6cc0f8e8b7cf8dee77ea`；
`npm view @alibaba-group/open-code-review version dist-tags` 仍是 `1.13.3` /
`latest: 1.13.3`。desktop 的 `^1.13.3` 无需改动，**无移植项**。

本轮不加产品功能面，做的是把上一轮刚拆出来的两处「形状」变成断言，再补两条零风险的交叉引用：

- **P0-1：机器可读区自身的形状进了断言。** 上一轮把 pin 块、固定行、通路账、对照表收进
  `<!-- machine-readable:start/end -->` 之间，但「人读区不许有第二份拷贝」只写在开头那句话里，
  没有任何检查会看见第二份。现在 `tools/upstream-watch.mjs` 多一个纯函数
  `machineReadableBlockViolations(doc)`：两个标记各恰好一次且 start 在前；区内五个锚点（pin 块
  起止、固定行、通路账标题、对照表表头）各恰好一次；这五个锚点**不得**出现在终点之后——那
  就是「不要在人读区再声明一次 pin」的机械形式。`tools/upstream-watch-smoke.mjs`
  要求它对真实文档返回空数组，再用「只改一行」的副本逐条验证它会红：标记对拆成两处（多一个
  start）、锚点被复制到人读区（在人读区多一行通路账标题）、两个标记顺序颠倒。三条反面用例都
  断言了「与真实文档只差一行/两行」，否则「会红」可能是因为副本本身坏了。断言同时钉住人读区
  确实是一段（不是空尾巴），且第三处 pin 声明（散文那处）仍在人读区——否则「终点之后没有
  锚点」会因为人读区不存在而恒真。这条断言上线时就抓到了本节自己：正文原先照抄了通路账标题
  与对照表表头这两个锚点的字面量，于是「人读区不得复制锚点」当场变红，改法是描述它们而不是
  抄它们——同一件事以后每轮都会遇到，写正文时留意。
- **P0-2：packaging 闸门「红的原因」也进了断言。** 上一轮那条「删掉任一行 `*.js` 白名单都要
  红」只钉住「会红、且点名了那一行」，没钉住「红在漏打包这件事上」：将来 `build.files` 里多
  一条 pattern 或挪一次目录，这条循环可能因为别的原因继续绿。现在同一条循环再断言失败句里
  出现 `required at runtime` 或 `root module` 之一。同时把已知盲区写成反向用例：闸门用的是
  正则扫描而不是 AST，`require(`./x`)` / `require("./" + "x")` 这类**非字面量** require 它看
  不见——用例在临时目录里造出字面量与两种计算式各一条，断言「字面量进了图、计算式没进图、
  闸门对它们一个字都不说」，再另造一条「根目录模块被计算式 require」证明根目录扫仍抓得到它
  （报错用 `root module` 的措辞）。于是「运行时 require 必须写成字面量」这条约束有了断言，
  而不是只剩一句注释。
- **P1-1：两处交叉引用，外加一句行号说明。** `git-service.js` 顶部 `gitEnv()` 注释块末尾加了
  一句指向本文件「能自动变红的地方，和不能的地方」；本文件那段关于 `readFileAtRef` 按 stderr
  措辞分类的代价里加了一句指向 `git-service.js` 顶部 `gitEnv()` 注释——下一轮不必重新发现一遍。
  对照表下方另补一句：pin 相同即 commit 相同，表里引用的上游行号（`llm_cmd.go:261`、
  `providers.go:45`）必然仍指向同一段代码，**行号不是欠账，只有 pin 前进才是**。

---
## 上游状态（第 75 轮，2026-10-27）

## 当前状态（第 75 轮，2026-10-27）

第 75 轮复核：**HEAD 未变，结论仍是「无新内容」；git 与 npm 两条通路都可达。**
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64c`
（与第 49–74 轮同一个 commit），`refs/tags/v1.13.3` 仍指向 annotated tag 对象
`dd925205e108304bd4dd6cc0f8e8b7cf8dee77ea`；
`npm view @alibaba-group/open-code-review version dist-tags` 仍是 `1.13.3` /
`latest: 1.13.3`。desktop 的 `^1.13.3` 无需改动，**无移植项**。

本轮不加产品功能面，做的是「文档承诺 ↔ 机器断言」之间还剩的两处桥，外加本文件自身的收敛：

- **P0-1：`build.files` 的白名单不再只靠「有人记得加」。** `tools/check-packaging.mjs` 原先只顺
  `main.js` / `preload.js` 的 `require` 图走，因此漏掉第二类漏打包——一个用**路径字符串**加载
  的模块（`path.join(__dirname, …)` 交给子进程的那种）或一个**还没有人 require 的**新根模块：
  它们在图里不存在，于是被当成「不需要打包」，等哪天有人用到才在打包版里炸。现在这条闸门问两
  个问题：`require` 图里每个模块都要在白名单里；**根目录每一个 `*.js` 都要在白名单里**，不管有
  没有东西 require 它（真不是运行时模块的就该搬到 `tools/`，报错就是这么说的）。同时核心抽成
  可 import 的 `findPackagingProblems()` / `allowlistMatcher()` / `matchesPattern()`，新增
  `tools/check-packaging-smoke.mjs` 把「这条闸门会红」变成断言：临时目录里造出四种形状
  （直接 require、只有依赖 require 的传递模块、没人 require 的根模块、`!` 排除项、白名单里
  写了不存在的文件、入口文件不存在），一次删一项，要求答案点名那一项；再拿本仓**真实的**
  `package.json` 逐条验：白名单里 14 行 `*.js` **每一行都是承重的**——删掉任一行，闸门必须红并
  点名它。这条清单是从 `package.json` 读的，不是抄在这里的，所以以后新增模块自动被覆盖，而一
  行「已经没人需要」的死条目也会在这里被点出来。
- **P0-2：`git-service` 通用分支的兜底本身被断言了。** `readFileAtRef` 的 `bad-ref` / `missing`
  靠匹配 git 的英文措辞，本地化或新版 git 说别的就会落进通用 `failed` 分支——这条分支的诊断性
  （句子里带 git 自己的首行 stderr 与**退出码**）是那个已知代价的唯一补偿。原来这条断言写成
  三处内联正则，改一处仍读作「已覆盖」；现在只有一个谓词 `namesExitCode(message, code)`，三处
  调用点都用它，并补两条自测：同一句失败去掉退出码后**必须判红**，以及它要的是 git 真正退出的
  那个码（`退出码 128` 不许被当成 `退出码 1`）——所以「退出码在句子里」不会随重构悄悄消失。
  中文措辞 `致命错误：无效的对象名称` 也单独成一条命名断言（`reason === "failed"` 且句子带退出码）。
- **P1-1：本文件收敛成「机器可读区 + 人读区」。** 之前 pin 块、固定行、通路账、对照表散在
  两百行正文中间，改一处要跨好几段读，人读的散文与脚本读的表混在一起。现在四块集中在文件顶部
  的「机器可读区」（`<!-- machine-readable:start/end -->` 之间），按形状定位、不依赖行号；关系、
  规则、本轮结论、「能自动变红的地方和不能的地方」放在后面的人读区。语义没变，`audit:upstream`
  保持绿。第 74 轮的正文按归档规则搬进了 [`upstream-history.md`](upstream-history.md)。

---
## 上游状态（第 74 轮，2026-10-27）

## 当前状态（第 74 轮，2026-10-27）

第 74 轮复核：**HEAD 未变，结论仍是「无新内容」；git 与 npm 两条通路都可达。**
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64c`
（与第 49–73 轮同一个 commit），`refs/tags/v1.13.3` 仍指向 annotated tag 对象
`dd925205e108304bd4dd6cc0f8e8b7cf8dee77ea`；
`npm view @alibaba-group/open-code-review version dist-tags` 仍是 `1.13.3` /
`latest: 1.13.3`。desktop 的 `^1.13.3` 无需改动，**无移植项**。

本轮不加新功能面，补的是三处「依赖的行为本身没有断言」的缺口：

- **P0-1：`exec` 的预算真会 kill 子进程，现在是真子进程断言。** `app-info.js` 的双层
  预算是「服务这一层到点 kill 子进程、`app-info` 这一层再兜一个截止时间」，而
  `app-info-smoke.mjs` 的探测用例全部打桩 `exec`——「到点会 kill」这个承重点没有任何
  断言。`audit:service` 新增一段：把本机 node 种成服务要找的可执行文件名（symlink /
  hardlink / copy 依次尝试），参数是一段「先写下自己的 PID、再睡 60 秒」的脚本，用 300ms
  预算调用 `exec`，然后断言三件事——调用在远早于 60 秒时返回、答案带 `timedOut`、以及
  子进程写下的 PID 已不再是活进程（`kill(pid, 0)` + 最多 2 秒轮询）。同一条假 CLI 再跑
  一次**不带预算**的短命令，证明「返回了」不是「本来就退出」。少了最后这条 PID 断言，
  「kill 掉」与「只是不再等」在测试看来完全一样。
- **P0-2：`installInfo()` 的 key-set 扩到每一个形态。** 上一轮已经把「恰好六个 key」
  钉进了 `tools/install-fixture.mjs`，`audit:install` 也逐形态比对，但只覆盖 installed /
  portable / dev。这轮补上「安装目录在、卸载器不在」和「安装目录已被删掉」两个形态：它们
  正是最容易被一句「提前 return 一个别的对象」改坏的形状，而那时的第一处红会出现在
  `app-info-smoke` 的 payload key-set，读者还要先分辨是 fixture 漂了还是模块漂了。
- **P1-1：`app-info-smoke` 对注册体的断言改成按 IPC 通道找，不再按文件名找。** 原先是
  `readFileSync("main.js")` + 正则，把注册搬进 `xxx-handler.js` 会以「找不到 main.js」
  变红——那不是这条断言要守的决策。现在扫根目录的 `*.js` 找到 `ipcMain.handle("app:info")`
  的模块，要求**恰好一个**模块注册这个通道，再取从注册到下一个 `ipcMain.handle/on` 之间
  的正文，断言它 `readVersionOutput(`、`...probe`、`formatAppInfo(` 三件事都在、且不出现
  `timedOut`（先剥注释）。两条都会红：改注册体、或在第二个模块里重复注册。

---


## 上游状态（第 73 轮，2026-10-27）

第 73 轮复核：**HEAD 未变，结论仍是「无新内容」；git 与 npm 两条通路都可达。**
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64c`
（与第 49–72 轮同一个 commit），`refs/tags/v1.13.3` 仍指向 annotated tag 对象
`dd925205e108304bd4dd6cc0f8e8b7cf8dee77ea`（`--tags` 里最高版本仍是 `v1.13.3`）；
`npm view @alibaba-group/open-code-review version dist-tags` 仍是 `1.13.3` /
`latest: 1.13.3`。desktop 的 `^1.13.3` 无需改动，**无移植项**。

本轮不加新功能面，做的是上一轮简报里的两条 P0 与一条 P1，主题都是「同一件事写了两遍，
而第二遍没人看着」：

- **P0-1：`app:info` 与 `install:info` 的桩参数合并成一份 fixture。** 两条断言说过同一个
  key 集合：`tools/install-info-smoke.mjs` 钉 `installInfo()` 的六个字段，
  `tools/app-info-smoke.mjs` 钉 `app:info` 的 payload 键集（`installInfo()` 被展开进去）。
  两处注释都写着「与另一处互相钉住」，但桩参数（`app` / `shell`）在两边各有一份拷贝，
  任一处漂移会让两条断言朝相反方向报红，且不说哪份是新的。现在桩与六项事实一起搬进
  `tools/install-fixture.mjs`：`INSTALL_INFO_KEYS`、`makeApp`、`makeShell`、
  `installStubs`、`stubInstall`。`install-info-smoke` 仍然自己回答文件系统问题（真临时
  目录、注入 `exists`/`readdir`/`dirname`）——那才是它测的行为；共享的是桩的形状与
  六项事实的名字。`app-info-smoke` 另外钉三件事：fixture 的桩恰好答六个 key、值就是页面
  夹具一直在用的那套、并且两个 suite 都还从这个文件 import（源码断言——本地再抄一份桩
  正是这件事要停掉的行为，而它在两边的行为断言里都看不见）。
- **P0-2：`git-service.js` 的 stderr 分类代价写进「能自动变红的地方，和不能的地方」。**
  见下面那一节新增的一段：分类读的是 git 自己的措辞，`audit:git` 的九条 stderr 是手写
  字符串，所以断言证明的只是「今天的措辞仍匹配」，不是「git 明天还这么说」。这就是它的
  代价，写下来，免得下一轮再提一遍。
- **P1-1：`docs/upstream-history.md` 的追加规则，从习惯变成断言。** 第 72 轮给第 71 轮
  正文补了一句「这一支的代价」——改动是对的，但没有痕迹，于是「这句话是哪一轮写的」
  只能靠回忆。现在那份文件开头写明自己是**可追溯的活文档**：正文写入后不再改写，后续
  轮次只能在段末追加一段 `**补记（第 N 轮）**`，N 必须晚于该段轮次，新轮次正文加在最
  上面（段落轮次递减）。规则的可执行形式是 `tools/upstream-watch.mjs` 的
  `historyAppendViolations()`：`audit:upstream` 要求它对真实归档返回空数组、要求归档里
  至少真有一条补记（否则「没有违例」是空话），并用「只改一行」的副本逐条验证它会红——
  补记之后又出现叙述、补记写成本段自己的轮次、补记被挪到正文之前、段落顺序被改乱、
  补记落在任何段落之外。第 72 轮那条补记已按新形状改成段末的 `**补记（第 72 轮）**`。

---

## 上游状态（第 72 轮，2026-10-27）

第 72 轮复核：**HEAD 未变，结论仍是「无新内容」；git 与 npm 两条通路都可达。**
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64c`
（与第 49–71 轮同一个 commit），`--tags` 里最高版本仍是 `v1.13.3`；
`npm view @alibaba-group/open-code-review version dist-tags` 仍是 `1.13.3` /
`latest: 1.13.3`。desktop 的 `^1.13.3` 无需改动，**无移植项**。

本轮不加新功能面，只把上一轮三处「决定已经做出、但还缺机械保证」的收口补齐，并把
上一轮没写完的代价说明补上：

- **`formatAppInfo` 的「入参 key-set」钉上了——这是上一轮最要紧的那一条。** 上一轮把
  `timedOut` 的取舍搬回 `app-info.js`：注册里改成 `...probe`，整个探测答案交给
  `formatAppInfo`，由它决定哪些字段上路。这个承诺要成立，得有一道机械保证——**入参里
  没人决定过的 key 不许进 payload**。`tools/app-info-smoke.mjs` 现在钉三件事：
  (1) 带 `timedOut`、`versionTimedOut` 和一个无意义 key 的入参，payload 里一个都不许有；
  (2) 这样的 payload 的 key 集合与「正常作答」逐字相同；(3) 被决定的那几个字段
  （`version` / `binary` / `binarySource` / `configPath`）的值没变。另一支「把 `main.js`
  改成显式三字段」没有选：那会把取舍点搬回注册里，正是上一轮要收口的东西。
- **`readVersionOutput` 末尾「迟到就丢弃」的那条判断被拆成一个能问的单元。**
  `app-info.js` 里的 `if (late || !answer) return saidNothing(true)` 有一半是**从外面造
  不出来的形状**：`Promise.race` 结算给先落地的那个 promise，而 deadline 到 race 只走
  一跳微任务、探测答案要走上 exec→map→catch→race 好几跳，所以 deadline 一旦触发就必然
  已经赢了那场 race，`answer` 必是 `null`——「迟到了**而且**答案还在」在
  `readVersionOutput` 外面根本到不了（实测过，不是推的）。一个没人能触发的分支就是
  一个没人能相信的分支，所以判断本身被提成 `versionAnswer(answer, late)` 导出，
  `audit:appinfo` 直接问它：迟到且答案还在 → 答案丢弃、答「等过了」；deadline 赢了
  race → 同一个答案；按时到达 → 原样通过；服务自己的 `timedOut` → 透传。另加一条源码
  断言钉住探测确实 `return versionAnswer(answer, late)`，免得函数与实现各走各的。
- **`repo:pick` 的「原样返回」从一句话变成逐字断言。** 上一轮承诺 UNC 路径原样保留、
  不 `resolve()`；原有三态断言（相对 → `""`、`C:repo` → `""`、UNC → 保留）里只有第三条
  会红，而「保留」到底是原样还是归一没有独立断言。`audit:path` 现在逐条比对：返回值与
  入参**逐字相同**（含大小写、含 `\\?\` 前缀），并与 `path.win32.resolve` 的结果对照，
  明确点出 `C:\Repo\..\Repo` 这条就是「`resolve` 会改写、这里不改」的分界；POSIX 一侧
  同样断言 `/repo/../repo` 不被折叠。
- **上一轮「选 b」的代价写进正文。** 第 71 轮那段（现在在
  [`upstream-history.md`](upstream-history.md)）补了一句：设置页在 CLI 迟答时只看到
  `version: ""`，与 CLI 静默不可区分——这是有意的，因为 `binary` / `binarySource` 已经
  能区分「没找到」与「找到了但没说话」，而「迟答」与「静默」对用户的可行动作相同（都
  指向检查杀软 / 网络盘）。代价写清楚，下一轮才不会再把这个方案提一遍。

## 上游状态（第 71 轮，2026-10-27）

第 71 轮复核：**HEAD 未变，结论仍是「无新内容」；git 与 npm 两条通路都可达。**
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64c`
（与第 49–70 轮同一个 commit），`--tags` 里最高版本仍是 `v1.13.3`；
`npm view @alibaba-group/open-code-review version dist-tags` 仍是 `1.13.3` /
`latest: 1.13.3`。desktop 的 `^1.13.3` 无需改动，**无移植项**。

本轮不加新功能面，把上一轮最后两处「承诺还没有断言」的地方收口：

- **`timedOut` 的归属定案：`formatAppInfo` 接受它，然后丢掉它（选 b）。** 上一轮
  的 `readVersionOutput` 会回答「是不是我们这边等到期了」，而 `main.js` 当时用解构
  `const { versionStdout, versionStderr } = ...` 顺手把它扔了——一个没人决定、也没人
  能测的丢弃。现在注册里改成 `const probe = await readVersionOutput(...)` +
  `formatAppInfo({ binary, ...probe, ... })`，**字段取舍只发生在 `app-info.js` 一处**，
  并且它是显式接收 `timedOut` 再 `void` 掉。选 b 而不是给 payload 加
  `versionTimedOut`：设置页对「版本」只有一句话，而「CLI 到底找没找到」已经由
  `binary` / `binarySource` 两列回答——多一个 boolean 就是一个没有任何渲染器读的
  字段，只能被断言「存在」，不能承重。`tools/app-info-smoke.mjs` 因此钉三件事：
  (1) `exec` 抛错 → 空输出且 `timedOut:false`；(2) `exec` 自己报 `timedOut:true` →
  一路透传到外层；(3) `exec` 无视预算但**迟到返回** → 到点即答 `timedOut:true`
  且迟到的 stdout 被丢弃。外加两条反向断言：把带 `timedOut:true` 的探测结果喂给
  `formatAppInfo`，payload 里不许出现 `timedOut` / `versionTimedOut`，且 key 集合
  与「正常作答」的回答逐字相同；`main.js`（去掉注释后）不许再出现 `timedOut`
  这个词——出现就意味着决策点又被搬回注册里。

- **`repo:pick` 与 `repo:pickInside` 共用同一道闸门。** `repo:pick` 以前把
  `result.filePaths[0]` 直接回给渲染器，而渲染器把它当仓库存下来
  （`pickRepo` 里 `if (dir) setRepo(dir)`），之后所有相对路径都对着渲染器的 cwd 解析
  ——一个来自 `localStorage` 的陈旧 `last-repo` 就能把整个应用指到用户没选过的目录。
  现在这条路径走 `pickedRepoOrEmpty`（`path-guard.js`，与 `repoIsPickable` 同一判据）：
  不合格就答 `""`，与「用户点了取消」同一个答案，因为渲染器对二者的读法本来就一样
  （都表示「别动我现在打开的仓库」），而第三种形状在渲染器里没有地方显示。路径
  **原样返回，不 `resolve()`**：这个函数只决定这条答案能不能上路。`audit:path` 补三态
  ——相对路径 → `""`、`C:repo`（盘符相对）→ `""`、`\\server\share\repo`（UNC 绝对）
  → 原样保留——并加一条源码断言：`repo:pick` 的注册体里必须是
  `pickedRepoOrEmpty(result.filePaths[0])`，不许再出现 `return result.filePaths[0]`。
- **`audit:upstream` 的自跑子进程现在会承认「我根本没跑起来」。** `spawnSync` 失败
  （`ENOENT`、脚本读不了）报的是 `status: null`，此前与「跑了、红了、`status === 1`」
  在报告里长得一样。现在先断 `child.status !== null`，detail 里带 `child.error.message`，
  让「没跑起来」和「跑起来红了」分开。P1-2（history 47–61 旧正文归档）与 P2 各项留给
  下一轮。

**补记（第 72 轮）**：上面这一支的代价是——设置页在 CLI 迟答时只会看到
`version: ""`，与 CLI 静默不可区分；这是有意的：`binary` / `binarySource` 已能区分
「没找到」与「找到了但没说话」，而「迟答」与「静默」对用户的可行动作相同（都指向
「检查杀软 / 网络盘」）。写在这里，是因为上一轮只写了「为什么不加字段」，没写「加了
会怎样、不加的代价是什么」：文档级的妥协需要显式承认，否则下一轮还会有人把这个方案
再提一遍。这一段按本文件前言里的追加规则写：正文不动，补记落在段末并标明轮次。

## 上游状态（最近检查：2026-10-27，第 70 轮）

第 70 轮复核：**HEAD 未变，结论仍是「无新内容」；git 与 npm 两条通路都可达。**
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64c`
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

## 上游状态（最近检查：2026-10-27，第 69 轮）

第 69 轮复核：**HEAD 未变，结论仍是「无新内容」；git 通路本轮可达。**
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64c`
（与第 49–68 轮同一个 commit），`refs/tags/v1.13.3` 仍指向 annotated tag 对象
`dd925205e108304bd4dd6cc0f8e8b7cf8dee77ea`（`--tags` 里最高版本仍是 `v1.13.3`）；
`npm view @alibaba-group/open-code-review version dist-tags` 仍是 `1.13.3` /
`latest: 1.13.3`。desktop 的 `^1.13.3` 无需改动，**无移植项**。

本轮不加新产品面，只把「pin 前进」这件事自己的后果变成断言：

- **`[UPSTREAM-MOVED]` 现在自己点名要重读的 5 处对照点。** 此前 moved 分支只列出
  四行，而对照表有 5 行——第五行（内置服务表**为空**是否合法，`llm_cmd.go`）只有
  翻开本文件的人才会知道。现在 `ROWS_TO_REREAD`（`tools/upstream-watch.mjs`）是
  5 个 `{ label, source, note }`：`source` 就是对照表「上游文件」列里的那个字符串，
  moved 分支逐行打印 `序号. 对照点 —— 文件名（看什么）`。于是「pin 前进」这个事件
  本身就给出阅读清单，不依赖人记得翻本文档。
- **清单与对照表改成双射断言，而不是「标签出现在文档某处」。** 新增纯函数
  `tableRowCoverage(doc)`（同文件）：按对照表的表头（`对照点` / `上游文件` 两列）取表体行，回答
  每条 `source` 落在哪一行（`missing` = 清单里有、表里没有；`orphans` = 表里有、
  清单里没有；`duplicated` = 一行被两处认领）。`audit:upstream` 断言表体行数等于
  清单长度、三者皆空；`smoke` 还用真文档的两份副本各做一次负例——删掉 `llm_cmd.go`
  那一行要求 `missing` 恰好点名它，插入一条新对照点要求 `orphans` 恰好点名它的行号，
  且两份副本都只与原文差一行（否则红的原因可能是别处）。
- **`formatDrift` 的清单是参数，不是字面量。** 传进去的 `rows` 决定打印几行与
  「下面 N 处对照点」的 N；smoke 传一份四条清单，要求 `llm_cmd.go` 从输出里消失、
  N 变成 4——否则「五行都在」可以在句子根本不读清单的情况下绿。
- **P0-2 复核结论：`save` → `spellingClashMessage` 的 tie 断言已存在，本轮不写码。**
  `tools/config-handler-smoke.mjs` 的 `refusalOf` 用 stub 的 `readConfigView()` 调
  handler 自己的 `spellingClash` + `spellingClashMessage`，`saidVerbatim` 断言
  `res.error === answer.message`（真句逐字），`entriesAre` 断言 `entries` 的
  name/section 逐条相等且顺序一致；两处在五个用例里都被引用（内置名、自定义名、
  同段两条、两段各一条、服务表静默 / 空表）。已有断言足够，不再加重复的一条。

## 上游状态（最近检查：2026-10-27，第 68 轮）

第 68 轮复核：**HEAD 未变，结论仍是「无新内容」；本轮 git 通路超时，由 GitHub API 作答。**
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 本轮超时（退出码 124），改走 GitHub API：
`api.github.com/repos/alibaba/open-code-review/commits/main` 给出
`refs/heads/main` = `375f64c`（与第 49–67 轮同一个
commit），`git/ref/tags/v1.13.3` 仍指向 annotated tag 对象
`dd925205e108304bd4dd6cc0f8e8b7cf8dee77ea`，`releases/latest` 仍是 `v1.13.3`；
`npm view @alibaba-group/open-code-review version dist-tags` 仍是 `1.13.3` /
`latest: 1.13.3`。desktop 的 `^1.13.3` 无需改动，**无移植项**。

本轮继续「把判定搬进可测纯函数」这条线，补的是第 66–67 轮留下的两处「只有人读注释
才能保证」的契约：

- **picker 的「打桩失败 → 逐条红」成为值。** 新增 `tools/e2e-picker.cjs`：
  `PICKER_STEP_NAMES` 是 picker 断言的完整清单，`pickerChecks(dialogIsStubbed)` 为
  每个步骤回答一行，`pickerCheck` 对未声明的步骤直接抛错（拼错名字不会静默删断言）。
  `e2e-flow.cjs` 不再写 `if (!dialogIsStubbed) return check(...)` 的内联分支；步骤
  是否红由模块决定，流程末尾还新增「声明的每一步都确实被报告」的检查——删掉一处
  `pickerCheck` 调用会变红，而不是让报告悄悄变短。`tools/e2e-picker-smoke.mjs`
  （`npm run audit:e2e-picker`，挂在 `audit:e2e-screen` 之后）钉住三态：`true` 逐条
  绿、`false` 逐条红且 detail 含 `PICKER_STUB`、`undefined` 同样逐条红；并断言流程
  仍在用这份清单。
- **`screenAfter` 的「读屏恰好一次」被计数钉住。**
  `tools/e2e-screen-smoke.mjs` 在 reject 分支加入 reader 调用计数与「报告的 screen
  就是 reader 那次返回值」两条断言（此前只断言了 resolve 分支 0 次），并把
  `neverAppeared` 的两个预算改成具名变量，不再靠人读两个字面量确认它们不同。
- **`repo:pickInside` 的顺序断言点名行号。** `audit:path` 原有的「先
  `repoIsPickable` 再 `dialog.showOpenDialog`」检查现在显式匹配带括号的调用，并要求
  该 handler 内恰好一次对话框调用；失败时打印两个行号，而不是只给一个布尔值。

## 上游状态（最近检查：2026-10-27，第 67 轮）

第 67 轮复核：**两条通路一致，结论仍是「无新内容」**。
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64c`
（与第 49–66 轮同一个 commit），`refs/tags/v1.13.3` 仍指向 annotated tag 对象
`dd925205e108304bd4dd6cc0f8e8b7cf8dee77ea`；`npm view @alibaba-group/open-code-review
version dist-tags` 仍是 `1.13.3` / `latest: 1.13.3`。desktop 的 `^1.13.3` 无需改动，
**无移植项**；本轮没有上游 API / CLI / 配置面的变化要移植。

本轮不加新模块，改的是「第 66 轮新引入的判定还没有单测」这一处，以及两处只测了
契约、没测平台语义的缺口：

- **e2e 的「超时」与「读屏」判定搬进纯函数。** `tools/e2e-screen.cjs` 现在持有
  `timeoutError`、`screenAfter(waiting, readScreen, { timeoutMs })` 与 `neverAppeared`，
  `tools/e2e-flow.cjs` 只剩「等」和「读 `main`」两件 Electron 的事。新增
  `npm run audit:e2e-screen`：用一个 resolve、一个带 `__timeout` 的 reject、一个不带
  的 reject 钉住三态，并钉住「resolve 后不再读屏」「读屏抛错/拒绝仍保住超时判定」
  「空屏幕不是超时」。两次读屏之间画面可能已变的已知近似写进了模块注释。
- **`repoIsPickable` 补上 Windows 语义。** 判据仍是「非空 + `path.isAbsolute`」，但
  现在可注入 `{ pathApi }`；`audit:path` 用 `path.win32` 断言 `C:\repo` / `\\server\share`
  / `\\?\C:\Repo` 可开始，而 `C:repo`（盘符相对，指向 C 盘当前目录）不可开始——这是
  对话框会开到用户没选的位置、并把真在仓库里的子目录判成越界的那一类输入。注入也
  被反过来钉住：同一个 `C:\repo` 在 `path.posix` 下必须判否。
- **`PickScanDirAnswer` 的「漏读空对象」从注释变成编译错误。**
  `src/lib/__typecheck__/pick-scan-dir.ts` 用 `// @ts-expect-error` 钉住三件事：漏掉
  `{}` 那支就不能把 `relPath` 当字符串、拒绝不能同时带 `relPath`、`relPath` 不能是
  `null`；三个合法形状也各写一个正例。`npm run typecheck` 因此成为这条承诺的机械保证。
- **`pickInsidePayload` 的 `default: throw` 在 IPC 边界定案：死路径，不测。**
  `main.js` 的 `repo:pickInside` 只调用 `pickInsidePayload(pickInsideAnswer(...))`，
  renderer 传不了 kind；这个 throw 针对的是「决定层加了 kind、翻译层没加」的漂移。
  `path-guard.js` 的注释写明了这一点（若真被触达，Electron 会把异常变成
  `ipcRenderer.invoke` 的 reject，而不是一个错的答案）；`audit:path` 新增一条源码
  断言：`main.js` 里每一处 `pickInsidePayload(` 的参数都必须是 `pickInsideAnswer(...)`，
  手搓答案字面量会让「死路径」不成立并立即变红。

## 上游状态（最近检查：2026-10-27，第 66 轮）

第 66 轮复核：**两条通路一致，结论仍是「无新内容」**。
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64c`
（与第 49–65 轮同一个 commit），`refs/tags/v1.13.3` 仍指向 annotated tag 对象
`dd925205e108304bd4dd6cc0f8e8b7cf8dee77ea`；`npm view @alibaba-group/open-code-review
version dist-tags` 仍是 `1.13.3` / `latest: 1.13.3`。desktop 的 `^1.13.3` 无需改动，
**无移植项**；本轮没有上游 API / CLI / 配置面的变化要移植。

本轮不加新模块，改的是「已有断言更难被绕过」，三处：

- **`tools/e2e-flow.cjs`：没跑 ≠ 通过。** picker 的每一步现在都经 `pickerCheck`
  登记：`dialog.showOpenDialog` 打不上桩时，每条断言都**红着出现**并写明「这一步没跑」，
  而不是整段从报告里消失（消失会被任何数失败的汇总当成绿色）。`waitFor` 的超时带上
  `__timeout` 标记，`screenAfter` 据此产出不同文案：「60s 内预览没出现」（CLI 慢 / spec
  没到）与「预览出现但不含 a.go」（renderer 组错了 spec）不再读成同一句话；依赖屏幕内容
  的另外三条断言在超时时也明确写「没有判过」，不再空屏通过。
- **`repo:pickInside` 在开对话框之前就问「这个仓库可用吗」。** `path-guard.js` 新增
  `repoIsPickable`（非空 + `path.isAbsolute`），`main.js` 用它挡住 renderer 传来的相对
  路径：否则对话框会在进程工作目录打开，而 `relativeInside` 会拿相对根去比绝对选择，把
  **真在仓库里**的子目录判成「所选目录不在该仓库内」。`audit:path` 断言顺序（先问再开
  对话框）与「相对的仓库走 no-repo，不会去问 relativeInside」；真 Electron e2e 断言
  `pickScanDir("relative/repo")` 根本没问对话框、答案是 `{ error }` 而不是 `{}`。
- **kind 只有一个声明，未知 kind 抛错。** `PICK_INSIDE_KINDS` 成为四个 kind 的唯一来源，
  `PICK_INSIDE_MESSAGES` 的键从它派生，`pickInsidePayload` 改成 `switch` + `default:
  throw`；`{ kind: "inside" }` 没有字符串 `relPath`、拒绝没有 `error` 句子也一并抛错——
  这些形状过去会变成 `{ error: undefined }` / `{ relPath: undefined }`，在 renderer 那边
  读成「取消」。`src/lib/api.ts` 把三态写成一个 `PickScanDirAnswer` 联合类型（`{}` = 取消，
  `?: never` 让漏读那一支编译就红），`ReviewPanel` 的读法改成「先 error、再 relPath、
  最后视为取消」，与 `pickInsidePayload` 同一顺序。顺带 `pickFileOptions` 的扩展名去重
  （`["md", ".md", " md "]` 是一条）也有断言。

## 上游状态（最近检查：2026-10-27，第 65 轮）

第 65 轮复核：**三条通路一致，结论仍是「无新内容」**。
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64c`
（与第 49–64 轮同一个 commit），`refs/tags/v1.13.3` 仍指向 annotated tag 对象
`dd925205e108304bd4dd6cc0f8e8b7cf8dee77ea`；`npm view @alibaba-group/open-code-review
version dist-tags` 仍是 `1.13.3` / `latest: 1.13.3`。desktop 的 `^1.13.3` 无需改动，
**无移植项**。（第 63–64 轮没有更新本文件的核对账；本轮不替它们补写通路，只在账里记下
「无记录」。）

本轮继续把 IPC 层的翻译收进可测纯函数，并补反向断言：

- `path-guard.js` 新增 `pickInsideAnswer` / `pickInsidePayload`：`repo:pickInside` 的
  `{}` / `{ error }` / `{ relPath }` 三种答案不再由 `main.js` 的 `if` 链拼出。取消、
  越界、仓库内各是一种 `kind`，两条错误文案也只在这里；`main.js` 只剩 dialog 与一次
  `pickInsidePayload(pickInsideAnswer(...))`。`tools/path-guard-smoke.mjs` 逐种钉住
  kind、键集，以及「注入的 `relativeInside` 说什么就是什么」。
- `provider-handler.js` 把「rows 元素必须是对象」写成**拒绝**而不是透传：设置页对每个
  元素读 `p.name`，一个 `null` 会把它变成崩溃而不是横幅，所以整次读取按「读不到」回答。
  `tools/provider-handler-smoke.mjs` 用 `[null, "x", { name }]` 与数组元素钉住这条契约。
- `tools/config-handler-smoke.mjs` 补 `{ ok: false }` 最小静默表 + 两段各一条不同拼写的
  夹具，断言 `others.length === 1`，且 `section` 分别是 `providers` 与 `custom_providers`。
- `tools/app-info-smoke.mjs` 钉住 `readVersion` 只剥 `open-code-review`（`ocr 1.13.3`
  保留前缀）；`tools/install-info-smoke.mjs` 在三种形态下断言 `installInfo()` 的键集
  恰好六项，与 `app-info-smoke` 末尾的 `expected` 互相钉住。

## 上游状态（最近检查：2026-10-27，第 62 轮）

第 62 轮复核：**两条通路一致，结论仍是「无新内容」**。
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64c`
（与第 49–61 轮同一个 commit），`refs/tags/v1.13.3` 仍指向 annotated tag 对象
`dd925205e108304bd4dd6cc0f8e8b7cf8dee77ea`。desktop 的 `^1.13.3` 无需改动，**无移植项**。

本轮没有新功能要移植，改的是 desktop 自己的两条规则：

- `path-guard.js` 的 `caseInsensitive` 从「装饰」变成真正决定答案的开关：判据改成
  「resolve 两侧 → 需要时折小写 → **整段比较**」，不再经过 `path.relative`（它自己会折
  小写，所以旗标关掉答案曾经也是 true）。`tools/path-guard-smoke.mjs` 补上「旗标关掉、
  大小写不同 → 在外」与「把 `path.relative` 换成会抛错的桩，答案照旧」两组断言。
- 逐轮正文（第 47–61 轮）整体搬到 [`upstream-history.md`](upstream-history.md)，本文件只留
  关系 / 规则 / 当前状态 / 对照表 / pin 块。`audit:upstream` 因此仍能要求 pin 恰好三处，
  而历史叙述不再参与扫描（`tools/upstream-watch-smoke.mjs` 同时断言归档里没有任何 pin
  声明，免得它变成第二个权威源）。

## 上游状态（最近检查：2026-10-27，第 61 轮）

第 61 轮复核：**通路可达，结论仍是「无新内容」**。
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64c`
（与第 49–60 轮同一个 commit），`refs/tags/v1.13.3` 仍指向 annotated tag 对象
`dd925205e108304bd4dd6cc0f8e8b7cf8dee77ea`。desktop 的 `^1.13.3` 无需改动，
**无移植项**。

本轮只动测试面与注释，把第 60 轮新引入的两个表面的边界钉死，另收 `app:info` 的可选输入：

- `tools/path-guard-smoke.mjs` 补 UNC 与长路径（`\\?\`）用例：同主机同共享的子目录在
  里面、大小写不同仍在里面、共享名前缀相同的兄弟在外、**换主机**在外、换共享在外、UNC 根上
  的 `..` 逃逸在外。顺带记下一个容易领错功的发现：`path.win32.relative` 自身就把两边折成
  小写，所以「Windows 不区分大小写」这条答案由 `path.relative` 给出，**不是**
  `caseInsensitive` 旗标给的（旗标作为显式规则保留，但它不是修好这个 bug 的原因）。第 60 轮
  注释里「On Windows the comparison is done on lower-cased absolute paths」容易被读成相反
  的意思，已在 `path-guard.js` 改成实话，并补两条断言钉住「折大小写来自 `path.relative`」
  与「把旗标关掉答案仍为 true」——否则将来换掉 `relative` 时，`caseInsensitive` 会变成
  一条谁都不敢碰的空开关，而大小写答案静默跟着坏。
- `tools/upstream-watch-smoke.mjs` 补 `pinPlaceCoverage` 的 `duplicated` 方向：复制真文档、
  在 pin 块里**再插一行**同样的 SHA，要求 `duplicated === ["pin 块"]`、`missing` 为空、
  `complete === false`；并断言四份声明的值**仍然全等于常量**（所以只有计数能看见它，这正是
  第 60 轮之前的绿）、复制件与原文只差这一行、以及「某处写两遍 + 某处丢了」是两个分开的
  答案而不是一句「不完整」。
- `tools/app-info-smoke.mjs` 补 `installInfo` 缺失用例：`undefined` 与 `null` 都不得留下任何
  install 字段、两者键集逐字相同，且半个 install 块按原样透传（不替调用方补默认值）。

## 上游状态（最近检查：2026-10-27，第 60 轮）

第 60 轮复核：**三条通路都可达，结论仍是「无新内容」**。
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64c`
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
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64c`
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
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64c`
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
`375f64c`（与第 49–56 轮同一个 commit）；
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
`sha` = `375f64c`（2026-10-20
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

**自最近一次有内容变更（`v1.13.3` / `375f64c`）以来，第 27–61 轮复核均无新内容。**
第 27–46、49–51、53、55、57–59 轮每轮都核对了 `git fetch upstream --tags`（或
`git ls-remote` / GitHub API）以及 GitHub API 的 commits / tags / releases，三处一致：
顶端仍是 `375f64c`，最新仍是 `v1.13.3`；第 47–48、52–54 轮只有 npm registry 一条通路
可达，第 56 轮 git 超时但 API 回答（见上），那几轮的「上游 commit 未核对」是网络欠账，
**不等于**上游变了。
desktop 的 CLI flag、输出解析、配置暴露点都无需改动。（`git fetch` 期间只有本仓同名的
`v0.1.x` 发布 tag 因已存在被拒，与上游无关。）

逐轮复核表格与第 2–26 轮的评估正文由私有 control 仓承载（本产品仓库只留这一份
上游状态摘要，避免再出现「表和十几轮正文挤在一处」的漂移）。

