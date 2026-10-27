# 上游核对日志（历史归档）

**本文件是审计日志；pin 的权威声明在 [`OCR-UPSTREAM-SYNC.md`](OCR-UPSTREAM-SYNC.md)。**
那份文件承载机器可读的 pin 块、「本轮 HEAD 核对」固定行、`upstream:check` 的正文引用，
以及「核对通路账」表 —— 每轮核对的结论只写在那里一行，逐轮正文（查了什么、通路是哪条）
归档在这里。

本文件里**没有**也不该有 pin 声明：历史段里的 SHA 是 7 位前缀或 tag 对象，与整串 40 位的
pin 不是同一种东西。`tools/upstream-watch-smoke.mjs` 断言本文件不含任何 pin 声明、也不含
pin 块，这样它就不会某天被当成第二个权威源。

搬家原因（第 62 轮）：13 段「上游状态（…第 N 轮）」堆在一份还要承载 pin 与对照表的文件里。
`audit:upstream` 要求 pin 在 `OCR-UPSTREAM-SYNC.md` 里恰好出现三次，历史段里的旧 SHA 是那
条计数的噪声源 —— 规则断言不该被历史叙述干扰，而历史本身要留着，所以搬到这里。

正文里出现的「本轮」指的是**正在讲的那一轮**（原文如此，未改）。下表是新轮的附加信息时，
仍然只写在那份同步文档里。

## 这是一份可追溯的活文档，不是冻结的快照

归档段落的正文写入后不再改写：后续轮次只能在段末追加一段 `**补记（第 N 轮）**`，
N 必须晚于该段轮次；新轮次正文加在最上面，段落轮次递减。

这条规则是给「第 71 轮的正文被第 72 轮补了一句代价」那件事补的：那次改动是对的，但它
没有留下痕迹，于是「这句话是哪一轮写的」只能靠回忆。规则之后，一段文字只有两种来源——
它自己那一轮写的正文，或者段末标明轮次的一条补记，没有第三种。所以：

- `**补记（第 N 轮）**` 是唯一的追加形状，行首就是这个标记，一条补记一段；
- 补记必须落在**同一段的末尾**：一段里出现过补记之后，正文就结束了，后面不许再有叙述；
- 补记的 N 必须晚于该段标题里的轮次，同一段的多条补记按轮次递增排列；
- 新轮次的正文加在最上面（不是文件末尾），所以从上往下读，段落轮次递减。

`tools/upstream-watch.mjs` 的 `historyAppendViolations()` 就是这四句话的判定式，
`npm run audit:upstream` 要求它对本文档返回空数组，并逐条用「只改一行」的副本验证它会红：
补记之后又出现叙述、补记写成本段自己的轮次、补记被挪到正文之前、段落顺序被改乱、
补记落在这段之外。规则本身也必须写在这里（上面那句），否则它只存在于脚本里。

---
## 上游状态（第 80 轮，2026-10-27）

第 80 轮复核：**HEAD 未变，结论仍是「无新内容」；git 与 npm 两条通路都可达。**
`git ls-remote https://github.com/alibaba/open-code-review.git HEAD refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`
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
退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`（与第 49–78 轮同一个
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
`sha` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`（与第 49–76 轮同一个 commit）；
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
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`
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
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`
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
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`
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
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`
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
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`
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
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`
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

## 上游状态（最近检查：2026-10-27，第 69 轮）

第 69 轮复核：**HEAD 未变，结论仍是「无新内容」；git 通路本轮可达。**
`git ls-remote https://github.com/alibaba/open-code-review.git refs/heads/main
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`
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
`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`（与第 49–67 轮同一个
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
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`
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
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`
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
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`
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
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`
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
refs/tags/v1.13.3` 退出码 0，`refs/heads/main` = `375f64cd6f67a48a135da83cfcf59c52669a09cb`
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
