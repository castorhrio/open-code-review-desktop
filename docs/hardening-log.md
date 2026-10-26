# desktop 加固日志（历史归档）

第 2–16 轮的加固正文，和已经划掉的待办条目，都搬到了这里。
**现在该看的是 [`next-iteration.md`](next-iteration.md)**：上游状态、
本轮待办、最近两轮的正文都在那里。

搬家的理由写在这里，免得以后又长回去。`next-iteration.md` 里「上游状态」
那张表曾经漏过四行——正文每一轮都记着自己的核对方式与结论，表里却没有
对应的行。**表和十几轮正文挤在一个文件里，正是漏行的温床**：表要能一眼
看全，正文要能慢慢读，两件事不该挤在一处。搬完之后，那张表是上游复核的
**唯一**记录：每轮都新增一行，结论是「无新内容」也加。

正文里出现的「本轮」指的是**正在讲的那一轮**（原文如此，未改）；各轮
标题里的「本轮」改成了「第 N 轮」，因为在归档里它们已经不再是「本轮」。

---

## 第 2 轮 desktop 侧加固（与上游无关）

### P0 — 重开被截断的会话，在证据还在落盘时不能看起来干净

这条线从 `93f3bd8` 开始，一直在做同一件事：**被上限截断的运行不能看起来像干净
运行**。本轮补上了最后两个还是「靠约定维持」的环节。

**1）读证据时等落盘（真的堵上了那个洞）**

`run:exit` 会等证据写盘，但那个等待**有上限**（`WRITE_TIMEOUT_MS`）——store 的文件
在 profile 目录里，可能是网络挂载，太慢不能一直占着 UI。越过上限后写入仍在队列里，
而**会话重开走的是直接读文件**（`runDiagnostics.read`），于是：

> 运行刚结束 → 写盘超时（写入还在队列里）→ 用户立刻重开会话 → 读到的是**没有证据
> 的旧文件** → 被截断的会话又显示成「干净」。

这条路径之前是通的：写盘有界等待（`a855e18`）、退出冲刷（`aa1668f`）都管住了「写」
的一侧，没人管「读」的一侧。

- `run-diagnostics.js`：新增 `store.readSettled(repo, sessionId)`——先等队列停稳
  （同样有界），再读文件。队列平时是空的，等待只是一次微任务；不空的时候，这个
  等待正是让答案为真的东西。
- `main.js`：`session:diagnostics` 改用它（IPC 变成 async）。

**2）`run:exit` 与证据落盘的顺序，从注释变成事实**

之前 `main.js` 里那个顺序（「record 排在 exit 事件到达 renderer 之前」）只写在
注释里，把 `send("run:exit")` 往上挪一行就会静默失效。

- `run-diagnostics.js`：新增 `settleRunExit({ store, repo, sessionId, result, signal })`
  ——**顺序是函数自己的形状**：先落盘、再发信号，并把结果交给信号。
- `main.js`：`run:exit` 的载荷现在带 `diagnostics: { ok, reason, message }`。
  渲染层据此知道「证据到底在不在盘上」。
- `src/store.tsx`：证据没存上时（`message` 非空），在**运行日志**里说一行。stderr
  上的一行用户看不到，等于没说；`io-error` 的措辞改成含「失败」，日志抽屉会自己
  弹出来（抽屉的规则就是「看起来像麻烦」才自己开）。

**顺带**：三处等待（运行退出、退出冲刷、读等落盘）原来各写各的 `2000`，现在收敛成
一个 `WRITE_TIMEOUT_MS`。

**验证**：`tools/run-diagnostics-smoke.mjs` 新增 11 条断言——读等落盘（普通读会漏、
settled 读能看到）、等待有界（磁盘不应声就放弃）、`run:exit` 信号只在证据落盘后
发出、信号带出结果、报结果失败时信号照样发出去（结束就必须把屏幕还回去）、
慢盘不拖住退出但退出要说清证据没到、真正丢失证据时措辞能被界面显示。

`tools/ui-audit` 新增 `97-run-diagnostics-lost`（夹具 `?run=done&rundiag=1`）：
证据没存上时，运行日志必须自己说清「重开会话后将看不到这条提示」，日志抽屉也要
自己弹出来（它的规则就是「看起来像麻烦」才自己开）。**去掉修复后会 FAIL**，
三条断言同时变红。

---

## 第 3 轮 desktop 侧加固（与上游无关）

本轮不做新功能，只把两条**「靠约定维持」的边界**钉成会 FAIL 的断言，并让 store
能说出真实卷的大小写答案。

### P1 — 删除的边界：跨仓库同名 session id

「上限证据」是按**仓库 + session id** 存的。session id 本身**不跨仓库唯一**——两个
仓库里可以各有一个同名会话，各自带一条自己的截断证据。于是删除有两条路：

- 按 `session id` 删：会连带删掉**另一个仓库**的证据。那条证据是那个仓库里唯一
  记着「这次运行被截断了」的东西，删掉它，那个仓库的会话就又显示成干净的。
- 按 `仓库 + session id` 删：只删自己那条。**这是对的。**

实测：`remove` 本来就是按后者做的（`key(repo, sessionId)` 整体比较），**没有真
bug**。但这条边界此前**没有任何断言**——把它改成「只按 id 删」不会让任何测试变红。
本轮补上：

- `tools/run-diagnostics-smoke.mjs`：删掉一个仓库的会话后，另一个仓库里的同名
  session id 仍在（证据还在）。

顺带把**卷的大小写**这条轴也变成可断言的：

- `run-diagnostics.js`：`createStore(file, options)` 现在把 `options` 透传给
  `normalizeRepo`。此前 store 的 key 只吃平台默认答案，而**大小写敏感性是卷的
  属性、不是 OS 的属性**（macOS 可以按大小写敏感格式化，Linux 可以挂成大小写
  不敏感）——`normalizeRepo` 早就接受这个覆盖参数了，store 却没法用上它。
- 两个答案都在**每个**平台上被断言：折叠大小写的卷上，同一个文件夹的两种拼法
  共用一条记录，删除用另一种拼法也能删掉它；不折叠的卷上，两个目录各记各的，
  删掉一个不影响另一个。
  - 去掉 `createStore` 的透传 → **2 条断言变红**（实测）。

`main.js` 目前仍不传这个参数（走平台默认，对 Windows/macOS 是对的）。真实卷的
答案要能拿到才行，见「仍然开放的事项」。

### P1 — 读的负向路径：`readSettled` 遇上不应声的磁盘

`readSettled` 是「读侧不丢证据」的最后一块，它的**有界等待**是这个模块对调用方
唯一的承诺，也是最容易被后人改坏的地方——把 `drainBounded(...).then(...)` 写成
`drain().then(...)`，等待就没有上限了，而**没有任何断言会发现**（那会让测试自己
挂住，而不是变红）。

- `tools/run-diagnostics-smoke.mjs`：把 `fs/promises` 的 `writeFile` 临时改成
  「永不落盘」，让 store 背后的队列永不停稳，然后断言：
  - 读**给出答案**而不是挂死（去掉有界等待 → 测试挂住，被超时杀掉，实测）；
  - 等待**不早于** `WRITE_TIMEOUT_MS` 放弃（不能提前放弃，否则写其实还有机会
    落盘，提前读到的就是旧数据）；
  - 放弃之后**回答盘上已有的证据**，而不是 `null`——重开一次会话问的就是上一次
    运行的证据，答 `null` 等于说「上次没被截断」。

**验证**：4 个失败模式都实测过会让断言变红或让测试挂住——去掉 `createStore` 的
透传（2 条红）、去掉 `readSettled` 的有界等待（测试挂住）、把 `remove` 改成只按
id 删（2 条红）、超时后返回 `null`（1 条红）。

---

## 第 4 轮 desktop 侧加固（与上游无关）

本轮做两件事：把 store 的「卷大小写」那条线**接到真实卷的答案**（上轮留下的
P0），以及给两条**静默降级**的兜底分支补断言（分类逻辑一行未改）。

### P0 — store 的大小写：问卷，而不是问操作系统

上轮 `createStore` 已经能接住 `options.caseInsensitive`，但 `main.js` 建 store 时
仍走**平台默认**。平台默认是个猜测：macOS 可以把卷格式化成**大小写敏感**，Linux
可以把卷挂成**大小写不敏感**——两个方向都猜错。于是「被截断的运行不能看起来
干净」这条承诺，在一个按大小写敏感格式化的 macOS 卷上仍然会被破坏：两个只差
大小写的目录会被并成一条证据，或者反过来，找不到自己那条。

**问哪里的卷？** 这里和上轮简报里的建议不一样，值得记一笔：简报建议在
`userData` 目录里写探针文件。但 **store 的 key 是「仓库路径」，不是 profile
路径**——`normalizeRepo` 处理的是用户选的仓库目录，profile 卷的大小写与它无关。
更糟的是，在 macOS 上答案通常正好是错的：系统盘是大小写不敏感的（所以
`userData` 说「折叠」），而开发者格式化工作盘时往往**只格式化外置盘**，仓库在
外置盘上（大小写敏感）——问 profile 卷得到的正是**相反**的答案。

所以本轮改成：**问仓库自己的路径，而且不写任何东西**。

- `run-diagnostics.js` 新增 `detectCaseInsensitive(target, options)`：
  把路径里**最深的那一段带字母的**名字换一种拼法（`Payments-API` →
  `PAYMENTS-API`），然后 `stat` 两个拼法，比对 `dev`/`ino`：
  - 同一个 inode → 卷折叠大小写；
  - 另一个 inode（两个只差大小写的目录真的都在）→ 卷**不**折叠；
  - 另一种拼法**根本不存在** → 卷不折叠；
  - 路径读不到（仓库被删了）→ **答不出来**（`null`），交给平台默认。
- **不写文件**是刻意的：路径通常是用户自己的工作树，在里面留一个探针文件比
  猜错更糟。探针只 `stat`，不写。
- `createCaseDetector(options)`：每个路径只问一次。一份证据文件有上百条记录，
  仓库又常在网络盘上，每条都问一遍就是上百次往返。
- `createAppStore(file, options)`：**app 真正用的那个 store** 从这里建，探测
  逻辑收在一个地方，检查够得着；`main.js` 只剩一行调用。
- `main.js`：`createRunDiagnostics(...)` → `createAppStore(...)`。

**三个来源，一个顺序**（`resolveCaseInsensitive`）：显式答案 → 卷的答案 → 平台
的答案。卷**答不出来**时退回平台默认，**不是**当成「大小写敏感」——反过来读，
一个问不出答案的探针会**弄丢**折叠大小写的卷上的每一条证据，正是这个 store
存在的理由所要防的那件事。

**顺带修好一个升级期的洞**：早期 build 用平台默认建 key，在大小写敏感的 macOS
卷上它把目录**转成了小写**存进文件；新 build 按卷的答案（保留大小写）建 key，
那条旧记录就找不到了——重开那个会话又会显示成「干净」。所以 store 现在**两个
key 都查**（`keysFor`）：卷的答案，和早期 build 的答案。

**验证**：`tools/run-diagnostics-smoke.mjs` 新增 22 条断言，覆盖两种卷的答案、
答不出来时的退回、显式答案的优先级、只问一次、探针与真实文件系统的一致性、
app 自己的 store 走的是「问卷」那条路，以及升级期旧记录仍能找到、仍能删。

失败模式逐条实测过会让断言变红（9 个）：不把探测器交给 store（1 条）、`main.js`
自己建 store（1 条）、探针把答案读反（2 条）、答不出来当成大小写敏感（3 条）、
不缓存探测（1 条）、忽略平台答案（5 条）、路径不存在也判（1 条）、存进去的
repo 不规范化（1 条）、不查早期 build 的 key（1 条）。

### P1 — 未知措辞的兜底分支，各配一条断言

两条分类都靠**外部的措辞**：`readFileAtRef` 靠 git 的 stderr 分
`bad-ref` / `missing` / `failed`，`spawnFailure` 靠 `err.code` 分。措辞不是本程序
的：本地化的 git、换版本的 git、上游改文案，都会让某个分支再也走不到——而**没有
任何断言会发现**，只是分类悄悄变了。

- `tools/git-service-smoke.mjs`：在**不是仓库**的目录里读一次（git 的话是
  `fatal: not a git repository`，两种已知措辞都不匹配），断言落到 `failed`，
  而且消息里保留 git 自己的原话。
- `tools/service-smoke.mjs`：`spawnFailure` 原来**根本没有导出**，所以这个分支
  一条断言也没有。本轮把它导出（纯函数，无行为变化），并断言三种情形：二进制
  不在、仓库目录不在、以及**两者都在**时保留原始消息（而不是硬说「找不到可
  执行文件」——那会把用户引到错的东西上）。

分类逻辑一行未改。

---

## 第 5 轮 desktop 侧加固（与上游无关）

本轮把上轮简报里「配置就绪判定」那条线**对到上游源码**上，并把 `MAX_ENTRIES`
那条注释**变成会 FAIL 的断言**。上游本轮无新提交（顶端仍是 `375f64c` / `v1.13.3`），
所以下面每一条都是「读上游源码 → 改 desktop → 用断言钉住」。

### P0 — 模型名：两种形态读的是**不同的键**

上轮简报问的是「上游在 provider 形态下是否读顶层 `raw.model`」。**读了**，而且
读的地方和简报猜的相反——所以 `|| raw.model` 不是「漏了 llm 形态才该有」，而是
**两处都算错了**。`internal/llm/resolver.go` @ `v1.13.3`：

- **provider 形态**（`tryProviderConfig`）：先读顶层的 `model`（`cfg.Model`），再用
  条目自己的 `model` 覆盖它；`llm` 段**完全不读**。
- **legacy 形态**（`tryLegacyLlmConfig`）：**只**读 `llm.model`；顶层的 `model`
  **不读**——而 `ocr config set model X`（没有 provider 时）写的正是顶层那个键。
- **环境变量只在 legacy 形态补模型**：provider 形态压根不看 `OCR_LLM_MODEL`，而且
  provider 缺模型是**硬错误**（`provider %q has no model configured`），不是
  「下一个解析策略能补上」。

desktop 此前把四种键混在一起数、不分形态，于是两种配置被说成「已就绪」，而 CLI
当场拒绝：

| 配置 | desktop 此前 | 上游实际 |
| --- | --- | --- |
| legacy 形态，只有顶层 `model` | 已就绪 | `no valid LLM endpoint configured` |
| provider 形态，模型只在环境变量里 | 已就绪 | `provider ... has no model configured` |

- **改动**（`ocr-service.js`）：`hasModel` 逐形态对齐上游；`view.model` 也改成
  **真正会被发出去的那一个**（provider 形态：条目自己的 `model` 优先、顶层兜底；
  legacy 形态：`llm.model`）。顺带修掉一个显示错位：切换服务时顶层 `model` 还是
  上一个服务的，顶栏却按顶层显示——现在按上游的优先级显示。
- **验证**：`tools/service-smoke.mjs` 新增 6 条断言。其中 4 条**去掉修复就会 FAIL**
  （实测）：legacy 形态的顶层 `model`、provider 形态的环境变量模型、provider 形态
  的 `llm.model`、以及显示的模型不是有效模型；另 2 条是防回退的（顶层 `model`
  在 provider 形态算数、条目 `model` 优先）。新形态也进了「ready 与 missing 必须
  同意」那条不变量。

### P0 — `MAX_ENTRIES` 的全局裁剪：把注释变成断言

上轮简报说这条注释「没写明是全局上限」——注释上一轮已经写清了（`run-diagnostics.js`
第 27–43 行），缺的是**断言**：从**一个**仓库看，per-repo 上限和全局上限长得
一模一样，只有**两个仓库**才分得开。

- `tools/run-diagnostics-smoke.mjs`：两个仓库交替写 `MAX_ENTRIES + 1` 条，断言
  文件里是 `MAX_ENTRIES` 条、两个仓库**共用**一个预算（各自都不到上限）、
  **第一个仓库最老的那条**被淘汰（per-repo 上限下它会活下来）、存活的是
  **全局尾巴**且写入顺序不变。
- **验证**：把裁剪改成 per-repo → **4 条断言变红**（实测）。

### 当时仍然开放（第 5 轮结束时的两条，第 6 轮都收了）

> 下面两条在第 6 轮收掉了，正文保留是因为它们记着**判据是什么**——尤其第一条：
> 缺的不是脚手架，而是 `custom_providers` 那一次查找。详见「第 6 轮」一节。

- **P1 — `presetEntry` 还有一个乐观分支**：手改配置把**自定义名**放进 `providers`
  段（缺 url）时，desktop 判定 ready。上游的判据是**内置服务注册表**
  （`llm.LookupProvider`，大小写不敏感）：不在表里的名字，上游根本不去 `providers`
  段找，而是去 `custom_providers` 段找 → 找不到 → 直接报错
  `provider %q is set but not configured in custom_providers section`。所以那份配置
  是被 CLI **整个拒绝**的，不是「缺一个 baseUrl」——把它算成 `missing: baseUrl`
  反而是**说错了原因**。desktop 要判准这件事，得把内置服务名单带进主进程
  （`ocr llm providers`），不是改一行表达式。
- **P1 — provider 形态下端点与 Key 仍会数环境变量**：`OCR_LLM_URL` /
  `ANTHROPIC_BASE_URL` 在 provider 形态下**不会**被读（端点只来自条目或内置服务
  表）；`OCR_LLM_TOKEN` 同样不会，Key 只有**内置服务自己的**环境变量（如 anthropic
  的 `ANTHROPIC_API_KEY`）才算数。这两处仍偏乐观，和上面的 `hasModel` 是同一类
  问题，本轮只收了模型这一维。

---

## 第 6 轮 desktop 侧加固（与上游无关）

上游顶端仍是 `375f64c` / `v1.13.3`（第 6 轮复核，无新提交）。本轮把上一轮留下的
「`rejectedProvider` 分支」接完——缺的不是脚手架，是上游那半个判据。

### P0 — 被判拒的服务名：缺的是 `custom_providers` 那一次查找

`tryProviderConfig`（`internal/llm/resolver.go` @ `v1.13.3`）按**名字**选段：

```go
preset, isPreset := LookupProvider(cfg.Provider)
if isPreset {
    entry, ok = cfg.Providers[cfg.Provider]
} else {
    entry, ok = cfg.CustomProviders[cfg.Provider]
}
if !ok {
    return ResolvedEndpoint{}, false, fmt.Errorf("provider %q is set but not configured in %s section", cfg.Provider, section)
}
```

上一轮只判了「名字在 `providers` 段但不在内置名单里」这一种。剩下两种仍然说错话：

| 配置 | 上周的 desktop | 上游 | 现在 |
| --- | --- | --- | --- |
| 同名条目同时出现在 `providers` 和 `custom_providers` | 判拒绝（理由是「没有 custom_providers 条目」） | 读 `custom_providers`，配置能跑 | ready，字段取自 custom 条目 |
| `provider` 指向的名字两个段都没有 | `missing: baseUrl,model,credential` | `provider %q is set but not configured in custom_providers section` | `missing: provider` |

第一类是把**能用**的配置说成整份被拒；第二类是让用户去填一个填了也不生效的字段。

改动（`ocr-service.js` 的 `readConfigView`）：

- **`registryHit` 与 `knownPreset` 拆开**：「名字在内置名单里」和「名字 + `providers`
  条目都在」是两个问题。环境变量那一段问的是前者（`owner` 归属），条目取哪一段问
  的也是前者；`presetEntry` 仍问后者（内置服务只在有条目时才有端点）。
- **`entry` 按名字选段**：`registryHit` 读 `providers`，其余名字读
  `custom_providers`——stray 条目不再借出端点、Key 或 model。注册表读不到时两份
  都试，保持旧的宽松读法。
- **`rejectedProvider` 加一个条件 `!customEntry`**：名字在 `custom_providers` 里有
  条目时，那份条目正是 CLI 会读的，不该判拒。

**验证**：`tools/service-smoke.mjs` 新增 6 条断言（同名两段仍 ready、字段取 custom
条目、stray 条目不借端点/Key、两段都没有 → `missing: provider`、注册表读不到时不
误拒、以及 `owner` 维度在 legacy 形态下的反向断言）。其中 **4 条去掉修复就 FAIL**
（实测：stray 同名两条、shadowed 端点一条、两段都没有一条）。

---

## 第 7 轮 desktop 侧加固（与上游无关）

上游顶端仍是 `375f64c` / `v1.13.3`（第 7 轮复核，`git fetch` + GitHub API 双核对），
所以本轮不改封装面，只把「保存的 Key 属于哪一条服务条目」这条规则**从猜测改成上游
的判据**。上一轮简报里的两条 P1（`presetEntry` 的乐观分支、provider 形态下端点/Key
数环境变量）在第 6 轮就已收掉，断言在 `tools/service-smoke.mjs` 里；本轮只补了
`entryByName` 这一处。

### P2 — 大小写变体同时存在时，取哪一条：`provider` 自己说了算

`providers` 段里同时有 `DeepSeek` 和 `deepseek` 时，desktop 一直取**全小写**那条，
依据只写在注释里（「`ocr llm providers` 打印的就是小写」）。**读了上游，这条依据
站不住**——`internal/llm/resolver.go` @ `v1.13.3` 的 `tryProviderConfig`：

```go
preset, isPreset := LookupProvider(cfg.Provider)   // 只有这一步折叠大小写
if isPreset { entry, ok = cfg.Providers[cfg.Provider] } else { ... }
```

`cfg.Providers[cfg.Provider]` 用的是配置里 `provider` 字段的**原始字符串**，不是注册表
返回的规范名（`LookupProvider` 只在 `providers.go` 里做 `strings.ToLower` 查表，
`cfg.Provider` 本身没被改写）。所以哪一条会被 `ocr` 打开，答案在配置文件自己手里；
小写那条只在「恰好与 `provider` 一致」时才是对的。判错的方向是把**另一条**的 Key
交给「测试连通」，设置页于是拿着本次运行不会用的 Key 去测（例：`provider: DeepSeek`
时上游读 `providers["DeepSeek"]`，desktop 说复用的是 `providers["deepseek"]` 的 Key）。

- **改动**（`ocr-service.js` 的 `entryByName`）：变体的取舍顺序改成
  ①配置 `provider` 字段点名的那条 → ②注册表拼法（`ocr llm providers` 打印的小写
  形式，表单通常就是它的写法）→ ③文件里的第一条。精确命中仍然优先于任何变体
  （这条没动：跨段同名时精确命中另一段仍是用户的意图）。
- **验证**：`tools/service-smoke.mjs` 新增 3 条断言——`provider: DeepSeek` +
  `providers` 两条变体、`provider: deepseek` + 两条变体（反向）、没有 `provider`
  可依时退回注册表拼法。第一条**去掉修复就 FAIL**（实测变成 `sk-lower`）。

---

## 第 8 轮 desktop 侧加固（与上游无关）

> 这一节是补记的：第 8 轮的代码（`6809a1d` … `9b60c87`，十个提交）早已落地，
> 正文却一直没写，所以「文档落后于代码」这件事本身，把下一轮的上游复核也带偏了。

上游顶端仍是 `375f64c` / `v1.13.3`（无新提交）。本轮把「保存的 Key 属于哪一条服务
条目」这条判定从渲染层搬进主进程：**判定与措辞同处一地**，设置页不再自己猜端点、
自己编句子。

### 落地的东西

- `ocr-service.js` 的 `entryByName`：四条匹配规则（精确 / 配置自己的 `provider` /
  注册表拼法 / 文件顺序），每条都带名字。四条规则是一条 `if/else` 链，所以**顺序就是
  语义**——把一条挪到另一条下面，不会有任何测试变红，只会悄悄换一个条目。规则常量
  与函数一并导出，`tools/service-smoke.mjs` 逐条断言「是哪条规则答的」。
- `ocr-service.js` 的 `savedKeyLookup`：六种扣下 Key 的原因（`config-unreadable` /
  `no-entry` / `order-guess` / `url-mismatch` / `no-key` / `table-unavailable`），外加
  一个**保守的默认值**：没说读过内置服务表，就当没读过（早先的默认是「读过，但表里
  没有」——那会把 Key 交给表单上任何一个地址）。
- `main.js` 新增 `config:savedKey` 通道；`SettingsPanel.tsx` 改为呈现主进程给出的原因，
  措辞由 `savedKeyFieldHint` / `savedKeyTestMessage` 生成（两种说法、六种原因各自一句）。

### 这一轮的判定链，两端还没有对到一起

判定链是三段：**主进程算端点 → 主进程比对 Key 的归属 → 渲染层显示同一个端点**。
第 8 轮把前两段搬进了主进程，第三段还在渲染层里自己算——而且算的是**反过来的
优先级**（详见第 9 轮）。当时没有任何断言看着这一段，所以它可以一直错着。

---

## 第 9 轮 desktop 侧加固（与上游无关）

上游顶端仍是 `375f64c` / `v1.13.3`（第 9 轮复核，GitHub API 核对；`git fetch` 在
沙箱里挂住）。本轮只做一件事：**把上一轮那套判定真正接到屏幕上**，并把它依赖的两条
接缝钉成会 FAIL 的断言。

### P0 — 六种扣 Key 原因，一句也没到过屏幕

`preload.js` 的 `savedKey` 收**两个位置参数**并自己拼成对象：

```js
savedKey: (name, url) => ipcRenderer.invoke("config:savedKey", { name, url }),
```

而接口（`src/lib/api.ts`）与渲染层（`SettingsPanel.tsx`）给的是**一个对象**：
`api.savedKey({ name, url })`。于是主进程收到的是 `name = { name, url }`——一个
对象。`entryByName` 拿它去查表，`String(name).toLowerCase()` 得到 `"[object object]"`,
什么也查不到，于是**每一个服务**都落到 `no-entry`：

```
改之前 : {"key":"","reason":"no-entry"}
改之后 : {"key":"sk-deep","reason":""}
当时的说法: 该服务还没有已保存的 Key，留空保存不会写入 Key。
```

第 8 轮那套「六种原因各有一句话」的机制，就这样一句也没到过屏幕——设置页永远显示
「该服务还没有已保存的 Key」，而这正是它当初要取代的那句话。

**为什么没有任何检查发现**：`tools/bridge-contract.mjs` 只比对了**方法名**（声明的
方法是否都在 preload 上、preload 上的方法是否都声明了），没有比对**参数形状**。

- **改动**（`preload.js`）：`savedKey: (req) => ipcRenderer.invoke("config:savedKey", req)`。
- **验证**（`tools/bridge-contract.mjs`）：新增两条检查——
  1. **参数个数**：接口声明几个参数，preload 就该收几个（`savedKey` 原来接口 1 个、
     preload 2 个）。
  2. **值的去处**：拿一个探针去调每个方法，看渲染层传出去的值**是不是以接口给的名字
     原样到了主进程**（不是被再包一层塞进别的键里）。
  两条都实测过：把 preload 改回旧写法 → 两条同时变红（`savedKey: the interface
  declares 1, the preload takes 2` / `2 of the values the caller sent never arrive
  under the interface's names`）。

### P0 — 判定链的两端：端点只有一个来源

第 8 轮留下的那半段接缝，本轮收掉。端点的优先级以前是**反的**：

- 主进程（`savedKeyLookup`）：条目的 `url` 优先，表里的端点兜底——**和 CLI 一致**
  （`url = preset.BaseURL; if entry.URL != "" { url = entry.URL }`，
  `internal/llm/resolver.go` @ `v1.13.3`）。
- 渲染层（`SettingsPanel.tsx`）：**表里的端点优先**，条目的 `url` 兜底。

于是一条自带端点的条目（公司网关、代理）会让设置页指向一个 CLI 永远不会用的主机：
「测试连通」把 Key 发到那儿，而真正跑审查时 Key 走的是另一台；同时那条 Key 又被判成
「属于另一个端点」而扣下——两处都错，方向还相反。

- **改动**：
  - `ocr-service.js` 新增 `serviceEndpoint(entry, presetUrl)`：**一条规则**，两个调用方
    （配置视图算给渲染层看的端点，`savedKeyLookup` 比对 Key 归属时用它）。
  - `readConfigView` 的视图多带一个 `endpoints`：名字 → 该服务解析出来的端点。渲染层
    不再自己算，只读这个。
  - `SettingsPanel.tsx`：`const endpoint = isCustomTarget ? customUrl : config.endpoints[name]`。
- **验证**（`tools/service-smoke.mjs`）：同一份 config + 同一张表，断言**视图给渲染层
  的端点**与 **`savedKeyLookup` 实际用的端点**相等；断言「条目自带端点时，条目赢过表」
  （把 `serviceEndpoint` 的两个来源调换顺序 → 5 条断言变红，实测）。

### P0 — `tableUnavailable` × `presetUrl` 的组合，逐条钉住

三种输入（条目自己的 url、表里这一行的 url、表能不能读到）各有各的答案，答案之间
**不能互换**——为错的原因扣下 Key，会把用户送去修一个没坏的东西。

| 形状 | 答案 |
| --- | --- |
| 表能读 + 条目没有 url | 表里的 url 就是那台主机 |
| 表能读 + 条目有 url | 条目的 url 是那台主机；表里的 url 是**另一台** |
| 表读不到 + 条目没有 url | 主机未知 → `table-unavailable` |
| 表读不到 + 条目有 url | 条目的 url 仍然是那台主机 |

以及「名字根本不在表里」——那是自定义服务，表对它无话可说，端点只能来自条目自己；
条目没写 url 就是**没有主机**，Key 不交给任何主机。这一条报的是 `url-mismatch`：
从表单这一侧看，两种情况说的是同一件事（Key 不会发到这个表单指的地址），修法也是
同一个（把 Base URL 填上，或把 Key 重新填一遍）。

还有一件表的状态替所有人决定的事：**CLI 读哪一段**（`tryProviderConfig` 按名字选段：
内置名读 `providers`，其余读 `custom_providers`）。所以表读不到时，连自定义服务读哪
一段都是未知的——这就是自定义服务在表读不到时也报 `table-unavailable` 的原因。

**验证**（`tools/service-smoke.mjs`）：上表的四种组合 + 自定义服务的三种形状，逐条
断言「原因」与「端点」两个值。

### P1 — `config:savedKey` 的回答带上表的状态

`config:savedKey` 现在回 `{ ok, available, reason, hint, endpoint, tableOk }`：
`endpoint` 是这次判定用的主机（与视图里的 `endpoints` 同源），`tableOk` 说内置服务表
这次能不能读到。设置页那条「读不到内置服务名单」的横幅改用**同一个回答**里的
`tableOk`——横幅与 Key 提示于是不会各说各话（一个说读到了、一个说读不到）。

---

## 第 10 轮 desktop 侧加固（与上游无关）

上游顶端仍是 `375f64c` / `v1.13.3`（第 10 轮复核，GitHub API 三核对），无需移植。
本轮继续上一轮那条线：**Key 提示必须诚实**——主进程说「有 / 没有 / 为什么没有」，
渲染层照抄，中间任何一个环节拿不到答案时，**不许替它编一个**。

### P0 — `MATCH_ORDER` 下 Key 必须被扣：把不变量钉成断言

`entryByName` 的四条匹配规则里，只有 `order`（按文件顺序猜的）不是 CLI 会问的问题：
那个条目**没有一次运行会打开它**（`cfg.Providers[cfg.Provider]` 落空，CLI 整份拒绝
这份配置）。所以它的 Key 不能交出去——但「扣下」这件事此前是**跨函数的口头约定**：
调用方读 `entry` 之后还要读 `rule` 并自己判断，而没有任何断言看着这一段。

- **改动**（`ocr-service.js`）：抽出 `withholdReasonFor(rule)`——「规则 → 扣 Key 原因」
  的映射自成一家，只有 `order` 映射到 `KEY_WITHHELD_ORDER`，另外三条映射到空。
  `savedKeyLookup` 改用它，不再自己认那条 `if`。
- **验证**（`tools/service-smoke.mjs`）：断言
  1. 只有文件顺序能答的形状（`provider` 指着别的服务 + 文件里两种写法都不是注册表
     拼法）确实由 `order` 规则回答；
  2. 该形状的 Key 被扣下，**且原因是 `order-guess`**（不是「表读不到」，也不是
     「Key 属于另一个端点」——那两个原因会把用户送去修没坏的东西）；
  3. 答案止步于端点之前（没有运行会打开的条目不报主机）；
  4. 只要值的那个调用方（`savedKeyFor`）也拿不到它；
  5. `withholdReasonFor` 对四条规则的映射逐条断言；
  6. `order-guess` 的那句话与其余五种原因**逐条不同**（字段下的提示与测试失败后的
     提示各比一次），而且它说的修法是「保存一次」而不是「再填一个 Key」。
- **实测**：把 `savedKeyLookup` 里那条 `if` 删掉 → **6 条断言变红**（其中 3 条是本轮
  新加的，3 条是原有的），且 Key 直接漏出去（`sk-first`）。

### P1 — `config:read` 与 `config:savedKey`：两次 IPC，一份答案

两个通道问的是**同一张内置服务表**：视图问「表读到了吗」，Key 判定问「表读到了吗、
这属于哪个端点」。若各自读一次，它们就可能在同一时刻各说各话——横幅说「读不到
内置服务名单」，Key 提示却说「你的 Key 可以留空」——而两句说的是同一张表。
失败窗口正是最容易出事的地方：第一次读失败被记住，第二次要么复用那次失败、
要么重读一次（可能成功），两次调用于是描述了不同的世界。

- **结论（写进代码注释）**：表只读一次，两个答案共用它。允许的差异只有两种：
  用户按了「刷新」，或失败窗口过期。这两种都会**同时**改变两个答案。
- **验证**（`tools/service-smoke.mjs`）：用计数的 `runner` 断言
  1. 视图先问、Key 判定后问 → 二进制**只 spawn 一次**；
  2. Key 判定先问、视图后问 → 同样只 spawn 一次；
  3. 读失败时 → 两个答案都说是失败，且**只读了一次**（失败被记住，没有第二次
     spawn），Key 的原因是 `table-unavailable` 而不是「没有条目」。
- **实测**：让 `savedKeyLookupByName` 自己再读一次表 → **2 条断言变红**
  （「读了两次」）。

### P1 — 渲染层 `catch` 路径的措辞不能退化成「没有 Key」

`SettingsPanel.tsx` 里 `api.savedKey(...).catch(() => setSavedKey(null))`——查不到答案时
渲染层退回自己的判断，措辞变成「已保存：…　留空表示保持不变」或「该服务还没有
Key」。两句都是**没有人核对过的承诺**：那句「留空表示保持不变」正是那个查询要回答
的问题，而查询失败了；那句「还没有 Key」会把用户送去填一个可能早就存在着的 Key。
这正是上一轮消灭的那类误导，只是换了一条路回来。

- **改动**（`SettingsPanel.tsx`）：`savedKey` 的状态从「有 / 没有」扩成
  `idle / loading / ok / failed` 四态——`loading` 说「正在确认是否已有可用的 Key…」，
  `failed` 说「无法确认是否已有可用的 Key：主进程没有回答这次查询。点「刷新」重试，
  或把 Key 直接填进来。」**不复用**「没有 Key」那句，也不承诺「留空即沿用」。
- **验证**（`tools/ui-audit`）：新夹具 `?savedkey=ipc-fail` 让 stub 的
  `api.savedKey` 直接 reject；新 shot `99-settings-savedkey-ipc-fail` 断言设置页
  显示的是「无法确认」，且**没有**「留空表示保持不变」、**没有**「该服务还没有 Key」。
- **实测**：把 `catch` 改回「丢掉答案、按老路渲染」→ 该 shot **FAIL**（两条问题）。

---


## 第 11 轮 desktop 侧加固（与上游无关）

上游顶端仍是 `375f64c` / `v1.13.3`（第 11 轮复核，GitHub API 核对），无需移植。
本轮不引入新功能，只处理**检查器自己的静默退化**：`tools/bridge-contract.mjs` 里
有三处 `continue`，写坏的代码或写坏的解析都能让形状检查无声消失，而方法名比对仍然
全绿。

### P0 — 解析失败现在是 FAIL，不再 `continue`

`for (const name of declared)` 循环里原来有一句
`if (!wantedList || !actual) continue;`：一旦某方法的参数列表读不出来（preload 改用
方法简写、对象类型写成索引签名、签名里没有括号参数表），这个方法就**不再被检查**，
而「声明的都在 preload 上 / 暴露的都在接口里」两条仍然通过。

- **改动**：`wantedList` / `actual` 各自一条解析断言（指名方法与哪一侧读不出来）；
  `objectTypeKeys` 改成返回 `{ inline, keys }`，于是「看起来是对象字面量但解析出 0 个
  key」能和「本来就不是对象类型（`Spec`、`string`）」分开——前者 FAIL，后者照旧无话可说。
- **实测**（改坏 → 变红 → 还原）：
  - `preload.js` 的 `rulesCheck` 改成方法简写 → `FAIL every method's parameter list
    could be read … rulesCheck: could not read its parameter list out of preload.js`；
  - `api.ts` 的 `savedKey(req: { [key: string]: string })` → `FAIL … the inline object
    type of \`req\` yields no keys`。
  - 顺带记一笔：**多行参数列表本来就能读**（切分靠嵌套深度、不靠换行），把它写成
    多行不会变红——注释里写清了这一点，免得下一个人以为「多行 = 已知盲区」。

### P0 — 每个声明的方法都必须真的走到主进程

`if (!invoked.length) continue;` 把「只监听、不发请求」的方法排除在外，理由成立，
但它没区分**合法的事件订阅方法**和**本该发 IPC 却没发的方法**。

- **改动**：加显式白名单 `LISTENER_METHODS`（`onUpdateState` / `onLog` / `onExit` /
  `onProgress` / `onMenuOpenRepo`）。白名单外的方法若调用后一个 invoke 都没有 → FAIL；
  白名单内的方法若真发了请求 → 也 FAIL（它的形状就不再是监听形状了）；白名单里出现
  接口不再声明的方法 → FAIL（躺着豁免一条不存在的断言）。零参数方法（`info`、
  `pickRepo`…）现在也会被调用，因此「调用本身有没有到主进程」对它们同样成立。
- **实测**：`preload.js` 的 `pickRepo` 改成 `() => Promise.resolve("")` →
  `FAIL every declared method reaches the main process when called <- pickRepo: calling
  it sent nothing to the main process`（改之前这条静默通过）。

`npm run audit:bridge`：20 条断言全绿。


## 第 12 轮 desktop 侧加固（与上游无关）

上游顶端仍是 `375f64c` / `v1.13.3`（第 12 轮复核，GitHub API 三核对：commits /
tags / releases），无需移植。本轮继续同一条线：**把「靠约定维持的边界」钉成会 FAIL
的断言**。两处，各钉一个方向。

### P0 — `classifyRef` 的四种答案，逐条钉住

`classifyRef` 决定「分支范围」这个 scope 下 `from` / `to` 的默认值。它读的是 git 的
**stdout 形状**（`<only-in-HEAD> <only-in-ref>`），四种形状对应四种关系：`same` /
`ancestor` / `descendant` / `diverged`。选错方向的后果就写在代码注释里：`A...B` 在
B 是 A 的祖先时是空的——**审 0 个文件，却报成一次干净的审查**。

这条注释此前**没有任何断言**：形状只被真的 git 喂过，那只证明了「今天的 git 这么
打」，没证明形状不对时会怎样。

- **改动**（`git-service.js`）：导出 `classifyRef`（纯函数，行为未变）；并把形状读
  **严格**化——必须是**恰好两个**计数。原来是取前两个、多的忽略，于是 `"1 2 3"` 会
  被读成 `diverged`。严格化之后，形状不对（多一列、少一半、不是数字、根本没有
  输出）一律答 `""`（没有关系）：`inspect` 于是不把它写进 `relations`，UI 退回工作
  区；而猜一个关系会挑出一条**静默审 0 个文件**的范围。
- **验证**（`tools/git-service-smoke.mjs`）：用 stub `spawn` 喂 stdout，四种形状逐条
  断言（`"0 3"` → descendant、`"3 0"` → ancestor、`"2 5"` → diverged、`"0 0"` → same）；
  六种形状不对的（`"garbage"` / `"1"` / `"0"` / `"0 x"` / `""` / `"1 2 3"`）断言答案是
  `""` **且不是四种关系里的任何一种**；git 失败（退出码非 0）也答 `""`。再拿**真
  git** 走一遍同四种：仓库里的 `main`（就是 HEAD）答 `same`、领先一个 commit 的
  `feature` 答 `descendant`、不存在的 `master` 不进 `relations`。
- **实测**：不加严格化 → `"1 2 3"` 那条断言变红（它当时答的是 `diverged`）。

### P0 — 运行的出口只有一扇门

`settleRunExit` 从第 2 轮起就负责「先落盘、再发出口信号」这个顺序——**顺序是函数
形状**。但它只管住了**走它的那条路**：`main.js` 里的 `send("run:exit", …)` 仍然写在
外面，下一个人把那行提到 `settleRunExit` 之上，一切仍然全绿。

- **改动**：
  - `run-diagnostics.js`：通道名 `run:exit` **只在这一处**被写出来，并收进一扇
    **门**（`createRunExitDoor`）。门造出来时是**关着的**，只有 `settleRunExit` 能
    开（开门的钥匙是模块私有的 `Symbol`，模块外拿不到）；从没开过的门发信号会被
    **拒绝**而不是发出去；一次运行只发一次。
  - `settleRunExit` 的参数从 `signal` 改成 `send` + `payload`：调用方交出「怎么发」
    与「发什么」，**不交出发的时候**——那是 `settleRunExit` 的顺序保证。
  - `main.js`：出口信号改走 `settleRunExit`，**主进程不再写通道名**（`run:exit` 这
    个字符串在 `main.js` 里一个都不剩）。
- **验证**（`tools/run-diagnostics-smoke.mjs`）：
  1. 没开过的门发信号 → **被拒绝**，且**什么都没发出去**；
  2. 门说的通道 = 渲染层听的通道（通道名从 `preload.js` 里**读出来**，不抄一份在
     检查里——改个名就红）；
  3. `main.js` **不出现**通道名 → 出口不可能从别处发出去；
  4. `main.js` 把出口交给 `settleRunExit`（`send` 与 `payload` 都在）。
- **实测**：`main.js` 里加一句 `send("run:exit", …)` → 第 3 条变红；把门改成造出来
  就是开的 → 第 1、2 条变红。
- **后来（第 13 轮）**：那三段「handler 体的形状」现在住在 `run-handler.js` 里，由
  `makeRunHandler({ ocr, store, send })` 造出来，`main.js` 只剩一行注册。原因是第 2–4
  条都只能读源码：换个别名、包一层 helper、把门改成**每个 settle 一扇**，正则都仍然
  通过。现在检查直接跑这个 handler（stub 的 `ocr`，一次运行答两次 `onDone`），数真正
  发出去的出口信号——把门挪回 `settleRunExit` 旁边 → 2 条断言变红。
- **顺带**：`tools/bridge-contract.mjs` 的「preload 听的通道主进程都发过」原来只认
  `send("字面量")`，通道名进常量之后会被误判成「没人发这个通道」。现在常量会被解析
  出来一起算——实测把通道改名，preload 与主进程**两侧**的检查同时变红。

### P1 — 第三个读内置服务表的人：设置页的服务列表

`config:read` 与 `config:savedKey` 共读一次内置服务表，第 10 轮已经钉住。第三个读
它的人是 `app:providers`（设置页下拉框里的那份列表）——它走的是 `ocr.providerTable()`，
也就是**同一个**缓存，但**没有断言看着**：注释承诺「两个调用方共用一次读、一个失败
窗口」，而那份承诺涉及三个调用方，有一个（`main.js` 里的 handler）不在断言覆盖里。

- **验证**（`tools/service-smoke.mjs`）：用计数的 `runner` 断言「服务列表先问、Key 判
  定后问」与「Key 判定先问、服务列表后问」两种顺序都**只读一次**，且两个答案说的是
  同一次读。
- **实测**：让 `savedKeyLookupByName` 自己再读一次表 → 3 条断言变红（实测），其中
  1 条是本轮新加的。

### 上轮简报里的一条，已经不用做了

- 简报的 P1-4「provider 形态下 `OCR_LLM_MODEL` 环境变量不算数」——**第 5 轮就钉住
  了**（`tools/service-smoke.mjs` 的「an env model does not complete a selected
  provider」）。下一个人不用重做。


## 第 14 轮 desktop 侧加固（与上游无关）

上游顶端仍是 `375f64c` / `v1.13.3`（第 14 轮复核，GitHub API 三核对），无需移植。
本轮不做新功能，只把两处「诊断自己出错时怎么办」的边界钉住。

### P0 — `reportOutcome` 自己抛错，不能把调用方一起带走

`reportOutcome` 是每条收尾路径的最后一句话：`settleRunExit`、`onLate`、退出冲刷、
卸载冲刷都经过它。它原来直接调用 `warn(...)`；`warn` 一抛（日志 sink 关了、注入的
报告器坏了），异常就沿着调用方返回：

- `flushBeforeQuit` 的 `.then` 里先 `reportOutcome(...)`、再 `app.quit()`，所以
  「上限证据可能丢了」这条诊断会把**退出本身**卡住——应用关不掉，而原因恰是那句
  本来要说明问题的日志。
- `run-handler.js` 的 `settle-failed` 路径虽然有 `say(...)` 护着「报告失败」，
  但这一半从来没被断言过；它还要保证「原始错误仍然打出来」这第二个独立报告。

**改动**（`run-diagnostics.js`）：`reportOutcome` 把 `warn` 的调用包进 try/catch；
抛了就不再声称「报告过了」，返回 `""`（返回值的含义就是「这行进了日志」）。

**验证**（`tools/run-diagnostics-smoke.mjs`，+10 条）：

- 会抛的 `warn` → `reportOutcome` 不抛、返回 `""`；
- `flushBeforeQuit` 在 `warn` 会抛时仍然调用 `app.quit()`，且第一遍确实拦下了退出
  （等冲刷）；
- 注入会抛的 `reportOutcome` → `say` 吞掉它，`settle` 的原始错误仍然落进 `warn`，
  没有 `unhandledRejection`；
- 用**真实**报告器、让 `warn` 只在收尾行抛 → 原始错误行仍然收到（第二个独立报告）。

**实测**：去掉 try/catch → 前两条变红，且测试在 `flushBeforeQuit` 处以
`Error: the log sink is gone` 崩溃（未处理的 rejection）。

### P0 — `MAX_ENTRIES` 轮换后的「静默」是设计，不是 bug

`MAX_ENTRIES` 挤掉旧记录后，`read` 对那条会话答 `null`，与「这条会话本来就干净」
完全一样。第 5 轮已经用两个仓库交替写钉住了「全局裁剪」，但没有断言钉住**两者的
答案相同**；注释说了，测试只说「trimmed session reopens as no evidence」。

本轮补一条断言：文件已达上限时，被挤掉的 session 与从未记录过的 session 都答
`null`，且文件仍是 `MAX_ENTRIES` 条。这不是新行为，是把「当前就是静默」钉住——
以后有人把它当 bug 修之前，必须先改这条断言与 `MAX_ENTRIES` 的注释。若要做
`trimmed` 标记或 `wasTrimmed(repo, sessionId)`，那是另一轮的事，且要同时接 UI。

### P1 — 简报的 P1-3（`entryByName` 调用侧）：已检查，没有第二个调用点

`entryByName(` 在主进程只有一处调用：`ocr-service.js` 的 `savedKeyLookup`，它在
第 333 行用 `withholdReasonFor(found.rule)` 决定是否扣 Key，规则到原因的映射没有被
绕开。简报点名的 `view.model` / `view.hasKey` / `view.keyPreview` **都不经过**
`entryByName`：`view.model` 读的是按段精确取到的 `entry`（第 724 行），
`view.providers` / `customProviders` 是 `mapSection` 对原文件的逐条展示（第 783–784
行）。所以「按位置猜出来的条目不当作本次运行的答案」在 Key 复用这条路上已经成立；
展示层展示的是「文件里这条条目自己有没有 Key」，不是「本次运行会用哪条 Key」。
本轮没有代码改动——若下一轮要把两者并成同一个答案，那是一次产品措辞决定，不是
修 bug。


---

## 第 15 轮 desktop 侧加固（与上游无关）

上游本轮无新提交（顶端仍是 `375f64c` / `v1.13.3`，见
[`next-iteration.md`](next-iteration.md) 复核表的第 15 轮那一行），不移植。
本轮做一件事：**把「拼写冲突时错报哪一段」从约定变成事实**，另把简报里剩下的两条
复核结论记下来。

### P0 — 拼写冲突的拒绝，要说清旧条目在哪一段

`config-handler.js` 的 `spellingClash` 找出同名不同拼写的旧条目后，错误信息只说
**名字**：

> 配置里已有 deepseek，与表单里的 DeepSeek 只差大小写；…请改用已有的拼写 deepseek。

但两段的条目住在 `config.json` 的不同地方：`providers` 段是内置服务的条目，
`custom_providers` 段是自定义条目。用户拿到这句话，只能自己把整个配置文件翻一遍
才知道去哪儿改——而「去哪儿改」正是这句话要回答的问题。

- **改动**（`config-handler.js`）：`spellingClash` 的答案从「一个名字」变成
  「名字 + 它在哪一段」，错误信息里说成「配置里已有 deepseek（在 providers 段）」。
  段的名称用的是**配置文件里的键**（`providers` / `custom_providers`），因为那才是
  用户要翻的地方；设置页与 store 里本来也用这两个名字（`ocr config unset
  custom_providers.<name>`）。
  「同名不同拼写」与「拒绝在写入之前」这两条行为一个字没改。
- **顺带钉住一个只有顺序能回答的问题**：注册表失联时两段都查，**先查到的那段**
  才是被点名的那段。先 `providers` 后 `custom_providers` 是现在的顺序，理由是
  `providers` 段存的是内置服务的条目，而内置服务名是注册表认得的那一类——注册表
  失联时它只是最可能的那一类，所以顺序是「更可能」而不是「一定」。这条顺序以前
  只写在注释里。

**验证**（`tools/config-handler-smoke.mjs`，+6 条）：

- 内置名撞内置名（`providers.deepseek` vs 表单 `DeepSeek`）→ 拒绝信息说
  `providers 段`，且不提 `custom_providers`；
- 自定义名撞自定义名（`custom_providers.my.gateway` vs 表单 `my.Gateway`）→ 拒绝
  信息说 `custom_providers 段`；
- **注册表失联 + 两段各有一个同拼写条目** → 报的是先查的那段（`providers` 侧），
  另一段的条目名**不出现在**信息里，两个条目都没被动过（Key 还在、`provider` 没被
  指过去）。

  这一条里两段的条目**故意拼得不一样**（`deepseek` 与 `DEEPSEEK`）：两段写成同一个
  拼法时，信息里出现的名字是哪一个都一样，断言会两边都过——那就没有钉住任何东西。
  简报的验收条件里也写了这一句（"若结果相同则说明断言写得不够严，需改成检查 section
  来源"）。

**实测**：改动前后各跑一次 `npm run audit:config`，全绿；把 `spellingClash` 里的两段
顺序反过来 → 上面第 3 组的两条断言变红（信息改为报 `DEEPSEEK` / `custom_providers
段`）。

### P0 — 简报的 P0-1 复核：`MATCH_ORDER → order-guess → 界面文案` 已有会红的断言

简报担心这条链「本轮没被 `service-smoke.mjs` 触及」，可能会静默退化。**已复核，
不需要补**：`tools/service-smoke.mjs` 里有 7 条断言守着它（`only the order rule
withholds a Key`、`the Key of an entry no run opens is withheld, for the reason that
says so`、`the answer stops before the endpoint…` 等），它们逐条断言
`entryByName` 返回的规则是 `MATCH_ORDER`、`withholdReasonFor(MATCH_ORDER)` 是
`order-guess`、Key 被扣下、端点不报、只要值的调用方也拿不到，以及 `order-guess`
那句话与其余五种原因逐条不同。

**实测**：把 `ocr-service.js` 的 `withholdReasonFor` 改成「`MATCH_ORDER` 分支返回
`""`」→ 上面的 7 条断言全部变红。也就是说这条链不是靠约定维持的。

### 已知取舍 — `MAX_ENTRIES` 轮换后，旧会话与干净会话**答得一样**

这是 README 那句「a truncated run never looks like a clean one」的**已记录例外**，
写在这里是为了别让人把它当 bug 又修一遍：

- 上限证据按「仓库 + 会话」存，全局最多 `MAX_ENTRIES`（200）条。写第 201 条时，
  最旧的一条被挤掉。
- 被挤掉的那条会话**重开时答 `null`**——与「这条会话本来就干净」完全一样，
  **界面上无法区分**。
- 只有**触发轮换的那一次运行**的日志里会出现一行（`trimmed` 计数，第 14 轮的
  `f52ac61`）。之后没有任何地方会再提这件事。
- 为什么接受：另一种做法是文件无限增长（它在 profile 目录里，每次运行都要整份读
  再整份写）。被挤掉的是最旧的记录，而用户最可能重开的正是最新的那些。
- 以后要改的话（例如给 `read` 加 `rotated: true`，或加 `wasTrimmed(repo, sessionId)`），
  必须同时改第 14 轮钉住「两者答案相同」的那条断言，并且接到界面上——否则一个
  200 次运行之后的用户重开早期会话，仍会看到「干净」。

---

## 第 16 轮 desktop 侧加固（与上游无关）

上游本轮无新提交（顶端仍是 `375f64c` / `v1.13.3`），所以下面每一件都是
desktop 自己的事。

### P0 — 拼写冲突的拒绝：两段都冲突时，两段都要说完

`8afdb58` 把「拒绝的时候说清旧条目在哪一段」钉住了——拒绝的话里带上了段名。
但它只说了**一段**。

两段都冲突是真的存在的：注册表（`ocr llm providers`）读不到时，desktop 不知道
CLI 会读 `providers` 还是 `custom_providers`，于是两段都查。两段各有一条同拼写
条目时，旧的拒绝只点名了先查到的那一条：

> 配置里已有 deepseek（在 providers 段），与表单里的 DeepSeek 只差大小写；……
> 请改用已有的拼写 deepseek。

用户照着做——把表单改成 `deepseek`——保存过去了（精确命中就不再冲突），而
`custom_providers` 段里那条**还在**，还带着一把 Key。CLI 读哪一段取决于这个名字
在它自己的服务表里算不算内置名（`tryProviderConfig` → `LookupProvider`），
desktop 恰恰读不到那张表，所以它没有资格替用户选一条。

现在 `spellingClash` 收下全部同拼写条目（`others`），拒绝的话把两条都点名，
并说清「这一版没能读到那张表，说不准它会读哪一段」，请把不要的那一条在配置
文件里改掉或删掉，再改用要留的那条的拼写保存。只有一条时的话一个字未改。

**断言**：旧行为是 bug，不是契约——`8afdb58` 钉的「另一段不出现」本轮明确改掉。
新的断言用「点名次数」而不是固定措辞（`custom_providers` 里含 `providers`，
`includes` 分不开两段）：

- 两段都冲突 → 两段各被点名一次，两个条目名都出现；
- 两段都冲突 → 拒绝的话里**不再**出现「请改用已有的拼写」（那正是把用户送到
  错误那一条的话），并要求把另一条「改掉或删掉」；
- 只有一段有 → 另一段**不得**出现（否则就成了一句「另一段也查过了」的废话）。

去掉修复 → 4 条变红；多点名一段 → 1 条变红（均实测）。

### 复核 — 简报里 P1 的两条，已经钉住了，不用再做

- **`git-service.js` 的 `bad-ref` / `missing` 分类**：`tools/git-service-smoke.mjs`
  已经用**真实 git** 造过这两种失败（`git show no-such-ref:a.go`、
  `git show HEAD:only-in-worktree.txt`），断言 `reason` 分别是 `bad-ref` /
  `missing`；中文 locale 下还有同样两条（`LC_ALL=C` 是让它们成立的原因）。
  正则失配会直接变红，不会静默降级到 `failed`。
- **`SETTLE_FAILED` 路径**：`tools/run-diagnostics-smoke.mjs` 已经钉了
  「settle 抛错 → 报 `SETTLE_FAILED` → 日志里是那句说「退出信号可能没有发出」
  的话 → 退出信号确实没发（settle 握着那扇门）这件事被说出来，而不是安静地
  过去」，还有 `outcomeLogMessage` 与 `outcomeMessage` 的分工。

两条都是「已经有了」，本轮不重复做。

### 文档 — `next-iteration.md` 拆成「现状」与「归档」两份

第 2–14 轮的加固正文和已经划掉的待办搬进了 [`hardening-log.md`](hardening-log.md)，
本文件只留上游状态表、待办和最近两轮。理由是这张表以前漏过四行，而表和十几轮
正文挤在一处正是漏行的温床。搬完之后那张表是上游复核的**唯一**记录，所以
「每轮都新增一行，哪怕结论是无新内容」写进了表头。

---

## 第 17 轮 desktop 侧加固（与上游无关）

上游本轮无新提交（顶端仍是 `375f64c` / `v1.13.3`，见 `next-iteration.md` 的复核表），
不移植。本轮做一件事：**把「一次运行结束时的那几句话」钉到同一个去处**，并复核
简报里 P0-1 / P1-1 两条。

### P0 — 一次运行的结束，只有一个去处

`run-handler.js` 这条路上有三句关于「这次运行怎么结束的」的话，严重程度不同，
去处却有两个：

| 句子 | 谁说的 | 讲的是什么 |
| --- | --- | --- |
| `settle-failed` | handler 自己的 `catch` | 收尾根本没做完，退出信号可能没发 |
| `signal-failed` | `settleRunExit` 里面 | 证据在盘上，只是推送失败 |
| 迟到的写盘结果 | `onLate` | 写盘在越过上限之后才落地 |

三句里**只有第一句**走 handler 的 `warn`（也就是注入的那个去处）。后两句走的是
`settleRunExit` 自己的 `warn`——而 **handler 以前根本没给它**：
`settleRunExit` 把 `opts.warn` 透传给 `reportOutcome`，没给就退回 `console.warn`。
于是：

- 注入一个 `warn` 的调用方只看得到**一半**；
- 另一半进了主进程的 stderr。它不会进渲染进程的日志抽屉（抽屉吃的是
  `run:log`），开发时在终端里看得见，打包成 GUI 应用后没有窗口可看。

改动很小：`run-handler.js` 把同一个 `log`（注入的 `warn`，没有就
`console.warn`）交给 `settleRunExit` 的 `warn` 与 `onLate`。三句话从此一个去处。

**断言**（`tools/run-diagnostics-smoke.mjs`，+7 条，走 handler 而不是直接调
`settleRunExit`）：

- 退出推送抛错 → 报的是 `signal-failed`（那句「退出信号推送失败」），**不是**
  `settle-failed`（那是另一件事：收尾根本没做完）；
- handler 自己的最后一道报告没有触发；
- 那个去处里**只有这一句**（一句不多），推送也只发生了一次；
- 证据在推送失败之前就已经在盘上；
- 越过上限之后才落地的写盘，结果也进同一个去处。

**实测**：把 `warn` 的接线去掉 → 3 条变红（`signal-failed` 那句与迟到的写盘结果
都不在去处里）；把 handler 的 `try/catch` 改回 `.catch(() => {})` → 5 条变红
（简报的验收条件是「至少 2 条」）。

> 第 20 轮把这一步再收了一格：`log` 与 `warn` 两个可注入点合成一个 `sink`，
> 「只接一半」不再是这个模块能表达的状态。见 `next-iteration.md` 第 20 轮。

### 复核 — 简报的 P0-1 与 P1-1，已经钉住了，不用再做

- **P0-1（`makeRunHandler` 的端到端断言）**：`tools/run-diagnostics-smoke.mjs`
  里已经有「the settle that never finishes」一节——它就是用 `makeRunHandler` 造
  handler、让 `startRun` 回调 `onDone`，然后断言 `reportOutcome` 收到的是
  `settle-failed`、日志里是 `settleFailedMessage()` 那句、退出信号**没有**发出去
  （门没开），以及那个拒绝被处理掉（没有 unhandledRejection）。简报担心的
  「只钉了 `settleRunExit` 本身」是旧状态：那一节是端到端的。本轮补的是它
  **没覆盖的那一格**——推送失败走 `signal-failed` 而不是 `settle-failed`
  （见上），以及这两句话的**去处**。
- **P1-1（`savedKey` 的参数形状）**：`tools/bridge-contract.mjs` 的探针按接口
  声明的字段名逐个打标记，检查它们到达主进程时还在原来的名字下。实测把
  `preload.js` 的 `savedKey` 改回两个位置参数
  （`(name, url) => invoke(..., { name, url })`）→ **2 条变红**（参数个数 + 值的
  去处）。不需要再加断言。

### 已关闭（第 18 轮）— `signal-failed` / `settle-failed` 现在进日志抽屉

本轮把三句话**归到一个去处**，但这个去处当时仍然是 `console.warn`。这两句是
唯一**没有退出信号可搭**的话（推送失败时根本没有退出信号，收尾失败时收尾本身
没做完），所以它们到不了渲染进程的日志抽屉——store 的结果在退出信号**送达**时
是跟着 payload 走的，渲染进程会写进日志，而这两句没有 payload。

「界面可能仍显示运行中」这句话本该由日志抽屉自己打开（`TROUBLE_LINE` 匹配
「失败」），所以缺的不是措辞，是去处。改法有两个：接 `run:log`（进抽屉，会让
抽屉自己弹出来），或者写主进程的日志文件。**第 18 轮定了：接 `run:log`**——
`main.js` 注入 `warn`，两句话进渲染进程的日志抽屉；写日志文件的方向放弃，
理由见 `next-iteration.md` 第 18 轮。

---

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

---

## 已经划掉的待办（历史）

这些条目在写下时是开放的，现在都收掉了。留着它们是为了让「当时认为
还差什么」可查——下一轮接手的人不必重新发明一遍。

- ~~`manifest.run_failure` 的中文映射与展示~~ → **全部做完**（`bf065b5` 映射，
  `f884499` 展示）：失败原因的**中文映射已实现**（`src/lib/format.ts` 的
  `RUN_FAILURE_LABEL` / `ITEM_FAILURE_LABEL`，两套词表由 `tools/service-smoke.mjs`
  逐值断言）；**报告页已摆出 `run_failure.reason`**（`f884499`，`finding.tsx` 新增
  `RunFailureNotice`，结果页与报告页都写出一行失败原因，分类是本程序自己的句子，
  CLI 的原话标成「CLI 原始原因」并保持可选中）；**`CoverageItem.classification`
  也从 tooltip 提成了可见文本**（同一个提交：未审/跳过行直接显示中文分类，CLI 的
  原话挪到该行 tooltip，并按去重后在行下方写出一次）。desktop 此前只显示一个红色
  「失败」徽章，**不显示失败原因**——用户知道失败了，但不知道为什么；这一刀已经
  补上。
  词表（2026-10-25 复核，`internal/session/manifest.go` @ `v1.13.3`）——上游是
  **两个**枚举，不是一份：`RunFailureClass`（`manifest.run_failure.classification`，
  7 个：`input / configuration / timeout / cancelled / budget / internal / unknown`）
  与 `FailureClass`（`coverage.failed[].classification`，8 个：
  `provider / timeout / cancelled / configuration / input / budget / panic / unknown`）。
  本文档此前把 run-level 一段写成了 8 值的那一份（含 `provider` / `panic`），是把
  两个枚举当成一个读了。真源已写进 `src/lib/types.ts` 的 `run_failure` 注释，两套映射
  由 `tools/service-smoke.mjs` 逐值断言，上游新增分类会让 `audit:service` 变红。
  > 注意：`run_failure` 在 `v1.13.0` 就已经存在，不是 `v1.13.1`–`v1.13.3` 带来的；
  > 只是这三个版本让「预算截断」更常出现，把它暴露得更明显了。
- ~~`ocr scan --path` 的行为变更（`v1.13.2` `27def86`，#1709）~~ → **关闭**：
  `--path` 现在按文件系统解析，**不存在的路径是错误**（而不是静默选中 0 个文件并
  `exit 0`），大小写写错在大小写敏感的文件系统上也是错误。desktop 在 scan 模式
  暴露 `--path`（`ocr-service.js` 的 `path` flag），对 desktop 是改善。desktop 侧
  **已修复并验证**（`293c891`）：`scan --path` 指向不存在的路径时，预览/「开始审查」
  会把 CLI 的报错落成中文提示，而不是渲染成一个空的文件列表。无需再验证。
- ~~CLI 侧的新语言 / 规则（`v1.13.2`）对 desktop 的影响~~ → **无需改动**：
  `1325261` Shader Languages、`6d68b1a` Nushell、`46790d9` PowerShell 审查规则、
  `9867a3d` OpenTofu 的 `.tofu` 扩展名，进的都是 CLI 自己的 allowlist / rules，
  desktop 不暴露语言清单。README 的「Features」表要不要提语言支持，是**产品口径**，
  留在 [`next-iteration.md`](next-iteration.md) 的「待移植 / 待验证」里（`[开放]`）。
- ~~上游那几件与 desktop 无关的改动~~ → **无需改动**：`ea5ced2` / `d73c9d3` 依赖
  安全更新、`b842659` grpc 升级、`410ddb8` MCP `tools/list` 分页（desktop 不暴露 MCP
  配置）、`313519f` NixPkgs 的 `pkgs/` provider 目录、`55450a9` / `c0d623a` 上游 CI
  的 PR 策略。


- ~~`reportOutcome` 自身抛异常时，调用方会被一起带走（退出路径因此可能关不掉）~~
  → 第 14 轮做完：`warn` 的调用包进 try/catch，抛了返回 `""`；断言覆盖
  `reportOutcome`、`flushBeforeQuit` 仍然退出、`settle-failed` 的原始错误仍有第二次
  报告。去掉 try/catch → 2 条变红且测试崩溃（实测）。详见上面第 14 轮。
- ~~`MAX_ENTRIES` 挤掉旧记录后与干净会话无法区分，且没有断言钉住这个设计~~
  → 第 14 轮做完：断言文件达上限时，被挤掉的 session 与从未记录过的 session 都答
  `null`，且文件仍是 `MAX_ENTRIES` 条。详见上面第 14 轮。
- ~~`classifyRef` 的四种答案（`same` / `ancestor` / `descendant` / `diverged`）没有
  断言~~ → 第 12 轮做完：`git-service.js` 导出 `classifyRef` 并把 stdout 形状读严
  （恰好两个计数），`tools/git-service-smoke.mjs` 用 stub `spawn` 逐条钉住四种形状、
  六种形状不对的形状与 git 失败，再用真 git 走一遍同四种；不加严格化 → 1 条变红
  （实测）。详见上面「P0 — `classifyRef` 的四种答案」。
- ~~`send("run:exit")` 的顺序保证只保护了一条调用路径~~ → 第 12 轮做完：通道名只在
  `run-diagnostics.js` 写一次，收进一扇只有 `settleRunExit` 能开的门（私有 `Symbol`），
  `main.js` 不再写通道名；`tools/run-diagnostics-smoke.mjs` 断言「没开过的门发不出
  去」「门说的通道 = preload 听的通道」「main.js 不出现通道名」「main.js 把出口交给
  `settleRunExit`」；`main.js` 加一句 `send("run:exit", …)` → 1 条变红（实测）。
- ~~`app:providers`（设置页的服务列表）也读那张内置服务表，但没有断言看着它与
  `config:savedKey` 共读一次~~ → 第 12 轮做完：`tools/service-smoke.mjs` 用计数的
  `runner` 断言两种调用顺序都只读一次；让 `savedKeyLookupByName` 自己再读一次表 →
  3 条变红（实测）。
- ~~`MATCH_ORDER` 下 Key 必须被扣，但「扣下」靠调用方读 `rule` 再判断，是跨函数的口头
  约定~~ → 第 10 轮做完：`ocr-service.js` 抽出 `withholdReasonFor(rule)`，
  `tools/service-smoke.mjs` 逐条断言「只有文件顺序能答的形状 → 规则是 `order` → Key
  被扣下 → 原因是 `order-guess` → 端点不报 → 只要值的调用方也拿不到」，外加它那句
  措辞与其余五种原因逐条不同；删掉那条 `if` → 6 条断言变红（实测）。详见上面
  「P0 — `MATCH_ORDER` 下 Key 必须被扣」。
- ~~`config:savedKey` 与 `config:read` 两次 IPC 可能对同一张表各说各话~~ → 第 10 轮
  做完：结论写进 `ocr-service.js` 的注释（表只读一次，允许的差异只有「刷新」与
  「失败窗口过期」，两种都同时改变两个答案），`tools/service-smoke.mjs` 用计数的
  `runner` 断言两个通道只 spawn 一次、失败时两个答案一起失败；让
  `savedKeyLookupByName` 自己再读一次 → 2 条断言变红（实测）。
- ~~渲染层 `catch` 路径把「查不到答案」说成「没有 Key」~~ → 第 10 轮做完：
  `SettingsPanel.tsx` 的状态扩成 `idle / loading / ok / failed`，`failed` 说「无法
  确认是否已有可用的 Key」；`tools/ui-audit` 新 shot `99-settings-savedkey-ipc-fail`
  （夹具 `?savedkey=ipc-fail`）断言页面没有「留空表示保持不变」、没有「该服务还没有
  Key」；把 `catch` 改回老写法 → 该 shot FAIL（实测）。
- ~~判定链的两端（主进程的 `presetUrl` 与渲染层算的 `endpoint`）没有对到一起~~ →
  第 9 轮做完：端点只剩一条规则（`serviceEndpoint`），配置视图把它交给渲染层，
  `tools/service-smoke.mjs` 用同一份 config + 同一张表断言两端相等；把优先级调回
  旧的顺序 → 5 条断言变红（实测）。详见上面「P0 — 判定链的两端」。
- ~~`tableUnavailable` × `presetUrl` 的组合没有逐条钉住~~ → 第 9 轮做完：四种组合
  加自定义服务的三种形状，逐条断言「原因」与「端点」两个值，并写清了「名字不在表里」
  指的是什么。
- ~~`config:savedKey` 的回答不携带表状态，横幅与 Key 提示各说各话~~ → 第 9 轮
  做完：回答带 `tableOk` 与 `endpoint`，横幅改用同一个回答。
- ~~`config:savedKey` 没进 bridge 契约检查~~ → 第 9 轮做完：`tools/bridge-contract.mjs`
  多了两条（参数个数、值的去处），实测能抓住把 preload 改回旧写法的那一处。
- ~~`readConfigView` 在 active 分支漏报 model~~ → 第 4 轮做完（`ab21f7d` /
  `221e829`）：`hasModel` 不再漏报模型，`ready` 与 `missing` 出自同一张清单；
  第 5 轮又把 `hasModel` 数的那几个键**按形态**对齐了上游（见上面第 5 轮）。
- ~~`readConfigView` 的 `raw.model` / `presetEntry` 语义核对~~ → 第 5 轮做完：
  逐形态对齐上游 `internal/llm/resolver.go`，`presetEntry` 剩下的那一个分支留在
  「仍然开放」里，并写清了为什么不能靠改一行表达式解决。
- ~~`spawnFailure` 没有导出、没有断言~~ → 第 4 轮做完（`ab11a4d`）：已导出，
  三种情形都有断言（`tools/service-smoke.mjs`）。
- ~~`MAX_ENTRIES` 只是注释里写着是全局上限~~ → 第 5 轮做完：两个仓库交替写的
  4 条断言钉住了「全局、不是 per-repo」。
- ~~`createStore` 的 `options.caseInsensitive` 没有接上真实卷的答案~~ →
  第 4 轮做完：`detectCaseInsensitive` 问**仓库自己的路径**（不写文件），
  `createAppStore` 收口，`main.js` 只剩一行调用。详见上面「P0 — store 的大小写」。
- ~~`readFileAtRef` / `spawnFailure` 的未知措辞兜底分支没有断言~~ →
  第 4 轮做完：各配一条断言，分类逻辑一行未改，`spawnFailure` 顺便导出。
- ~~`check("the stored key is canonical...")` 两个条件用 `&&` 串在一起~~ →
  第 4 轮拆成两条独立断言。
- ~~内置服务名只写在 `custom_providers` 段（`provider: anthropic`）时仍报缺字段~~
  → 第 6 轮 `c36daa9` 收了：`rejected = "provider-not-in-section"`，`missing` 留空、
  `ready` 由拒绝决定，句子说「把条目移到 `providers.<name>`」；断言在
  `tools/service-smoke.mjs`（`presetOnlyInCustom`）。
- ~~`rejectedProvider` 分支没接上（`presetEntry` 的乐观分支）~~ → 第 6 轮做完：
  按**名字**选段，并补上 `custom_providers` 那一次查找；同名两段 / 两段都没有两种
  形态都有断言，4 条去掉修复即 FAIL。剩下「内置名只写在 custom_providers」一条按
  上面的 P1 留给下一轮。
- ~~provider 形态下端点与 Key 仍会数环境变量~~ → 第 5 轮的 `d464d5d` 已经收了：
  `ENV_SOURCES` 第三列按形态、第四列按 preset 归属；`providerEnvUrl` /
  `providerAnthropicBase` / `providerEnvToken` / `customEnvKey` 四条断言在看着。
  第 6 轮又补了 legacy 形态下 `ANTHROPIC_API_KEY` 仍算数的反向断言。
