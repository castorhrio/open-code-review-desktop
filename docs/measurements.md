# 实测值

README 的 Status 段只写**能力**（能渲染 1200 条、有耗时上限断言、真机跑通过一次全量
扫描），不写某次跑出来的毫秒数与 token 数。理由：实测数字会腐，而 README 里腐掉的
数字不会让任何检查变红。数字留在这里，附日期与来源，愿意核对的人来看这一份。

| 日期 | 场景 | 实测 | 来源 |
| --- | --- | --- | --- |
| 2026-10 | 结果页千级规模：`?huge=1` 挂载 1200 条评论（结果列表每一行 + 阅读页每一块，两者都不虚拟化） | 405ms 挂载完成；审计的上限是 8s | `npm run build && SHOT=75-report-huge npm run audit:ui`（该 shot 每次都会打印当次毫秒数，超过 8s 变红） |
| 2026-10 | 真实全量扫描，活服务商，1 个文件 | 4 条意见、103K token、3m36s | 结果页按该载荷渲染 |
| 2026-10-13 | 真实全量扫描，12 个文件 | 8 条意见、173K token、1m41s；产出分节 `project_summary` | 要点带按该文本渲染，按上限截断并渐隐 |
| 2026-10 | 真实单文件审查（`audit:service` 回放的 stderr 就是这一次） | 3m48s、6 条意见、10 次工具调用 | `tools/service-smoke.mjs` 的夹具里留着那份 stderr |
| 2026-11-03 | 第 104 轮复跑：把 `audit:guards` 的重试判定抽成纯函数之后的门禁 | `audit:static` 23 项全绿；`audit:guards` 在真 Electron 里 24 条全绿，末行仍写「sandbox relaxed」——即第一次严格运行确实没写出报告、`--no-sandbox` 那条重试被真的走到，不只是被夹具模拟过 | `npm run audit:static`；`xvfb-run -a npm run audit:guards`（`PW_CHANNEL=bundled`，Electron 33.4.11，`ocr v1.13.4` 二进制） |
| 2026-11-04 | 第 108 轮：过线标准的「证据候选」进断言（每条 DOD 必须指出若勾上该追哪份记录，且路径真的在仓里） | `audit:upstream` 全绿；新增 8 条检查（1 条正向 + 1 条前提 + 6 条反向控制：删掉一条的候选、候选指向不存在的文件、候选挂在条目之外、候选后面没有路径、正文里提到标记不算候选、候选路径与证据路径同一个读法）；`audit:typography` 全绿（两份 README 的措辞改动后重跑） | `npm run audit:upstream`；`npm run audit:typography` |
| 2026-11-04 | 第 108 轮：README 安装段不再出现内部场合的说法（「初审答辩环境」/「reviewed and demoed on」改成「已验证环境」/「Verified environment」） | `audit:upstream` 新增 5 条检查（正向 + 前提 + 中英两句各自的反向控制 + 「平台事实本身仍绿」），全绿 | `npm run audit:upstream` |
| 2026-11-04 | 第 108 轮：界面中文排版从三屏扩到六屏（通知条 `?notice=overflow`、设置页、首屏引导卡） | `audit:typography-ui` 查了 6 屏共 373 块可见文本（原三屏 202 块），两条反向控制各自点名（`report-read` 与 `settings-top`）；`audit:typography-ui-rules` 全绿（六屏清单、逐屏前提正反两向、两条针都在源组件里） | `PW_CHANNEL=bundled node tools/ui-cjk-typography.mjs`；`node tools/ui-cjk-typography-smoke.mjs` |
| 2026-11-03 | 跨平台验证面：第 103 轮升 pin 到 `ocr v1.13.4` 时在 Linux x64 上真跑一遍 | `audit:guards` 24 条、`audit:exit` 5 条、`audit:e2e` 18 条（真 Electron + 真 CLI）、`audit:ui` 112 条、`audit:contrast` 978 处文本 0 处低于 AA、`audit:ui-scaled` 1.25 与 1.5 各 11 条，全绿；二进制自报 `v1.13.4 (76ab46a) linux/amd64` | `xvfb-run -a npm run audit:guards`（`PW_CHANNEL=bundled`），Electron 33.4.11 |
| 2026-11-04 | 第 112 轮：首启链路第一次被脚本走过（空档案 → 引导卡三步 → 选仓 → 配 provider → 清单 → 成本确认） | `audit:e2e-first-run` 17 条全绿（真 Electron + 真 CLI，`--no-sandbox` 重试被走到，末行写「sandbox relaxed」）；同一次跑里记到 23 个子进程、其中恰有一个 `scan` 带着 `--max-tokens-budget 300000`，而「取消」那一趟一个都没起；`audit:e2e-first-run-rules` 69 条全绿（含「一个不认识的 CLI 命令即使数量对得上也要红」那一格） | `xvfb-run -a node tools/e2e-first-run.mjs`；`node tools/e2e-first-run-steps-smoke.mjs`，Electron 33.4.11，`ocr v1.13.4` 二进制，provider 是 `http://127.0.0.1:9/v1` 的假条目 |
| 2026-11-04 | 第 113 轮升 pin 到 `ocr v1.13.5`：对照表 5 行同批重读之后，整套门禁在新二进制上重跑 | `audit:static` 24 项全绿（其中 `audit:upstream` 345 条、`audit:e2e-first-run-rules` 69 条、`audit:config` 与 `audit:service`、`audit:git` 都跑在换过的二进制上）；`audit:ui` 112 条、`audit:ui-scaled` 1.25 与 1.5 各 11 条、`audit:typography-ui` 6 屏 373 块可见文本 / 457 个带文字的叶子、`audit:contrast` 980 处文本 0 处低于 AA；真 Electron 四条 `audit:guards` 24、`audit:exit` 5、`audit:e2e` 18、`audit:e2e-first-run` 17 全绿，末行都写「sandbox relaxed」。首启那一条同时证明新 pin 的 allowlist 扩张没有动到夹具：`go.mod` 仍是「暂不支持的类型」、`testdata/sample.json` 仍是「默认排除路径」，排除块仍是两行两个理由 | `PW_CHANNEL=bundled PLAYWRIGHT_MODULE=<带 playwright 的 node_modules> xvfb-run -a npm run audit`，Electron 33.4.11，二进制自报 `v1.13.5 (abb7abcd) linux/amd64` |

上面那一行是**验证面**，不是又一个数字，所以它把「怎么跑出来的」也写清楚：这台机器没有 Edge，
UI 三条靠 Playwright 自带的 chromium（`PW_CHANNEL=bundled`）——Playwright 不是本仓依赖，
`npm install` 会把它当多余包装掉，所以跑 `audit:ui` 前要按 README 的说法补一份（`--no-save` 即可）。
这台机器的 `chrome-sandbox` 不是 setuid root，真 Electron 那四条都以 `--no-sandbox` 运行，
harness 会自己说明「sandbox relaxed」。这一行**不覆盖**：Linux / macOS 的打包产物（没跑
`npm run dist:linux`）、真显示器与 GPU、安装版的自动更新、以及单实例锁与卸载路径；macOS 至今
一次都没跑过任何一条。发布面同样只有 Windows——12 个 Release 的资产全是 `*-setup.exe` /
`*-portable.exe` / `latest.yml` / blockmap，没有一份 mac 或 linux 包。所以「发布到哪、验证到哪」
现在是同一句话，写在两份 README 的首屏与限制清单里。Windows x64 仍是唯一端到端（含安装包）验证过的平台。

这些数字不可复现成同一个值：审查耗时取决于服务商、网络与仓库，渲染耗取决于机器。
能复现的是**断言**——「1200 条全部渲染出来」「挂载不超过上限」写成了
`tools/ui-audit/audit.mjs` 里的检查，改坏了会红；「渲染一次真实扫描的载荷」写成了
读夹具的检查。README 承诺的是这一层，不是上表里的某一格。
| 2026-11-04 | 第 114 轮：参数面（DOD-2 的实证面）从手感变成门禁——`tools/cli-surface.mjs` 读被 pin 的那一版二进制的 `--help`（12 条命令）与本仓真的交给 `spawn` 的 18 条命令行，双向对照 | `npm run audit:surface` 全绿：自检 46 条（含 4 条看仓库而不是夹具：`llm test` 的 needle 真在 `config-handler.js` 里、两个消费模块的 flag 字面量与表双向相等、同步文档仍有两条 run 命令的 `--help` 对照行、`audit:surface` 真挂在 `audit:static` 里）+ 门禁「57 行要拼 × help 逐条一致 / 10 行不收 / 15 行有理由地不用」；二进制自报 `v1.13.5 (abb7abcd)`。这一遍第一次跑抓到的是自制夹具自己的两处错：合成命令行把 `--preview` 与 `--resume` 拼在同一条上（46 条里 12 条因此假红），以及「值长得像 flag」那格的期望写成了两个 flag（`--rule --repo /r` 在 CLI 眼里只有一个 flag）；改的是期望与前提，不是规则。`npm run audit:static` 25 项全绿（2362 条 ok 行，exit 0），新增的那一项使 `audit:static` 从本轮起需要本机已装 CLI | `node tools/cli-surface-smoke.mjs`；`node tools/cli-surface.mjs`；`npm run audit:static`（Linux x64，二进制 `v1.13.5 (abb7abcd)`） |
| 2026-11-04 | 第 117 轮：**打包产物第一次被脚本启动**——`release/linux-unpacked` 里的可执行文件（不是源码树里的 Electron）在一次性 HOME 下起来，经 DevTools 协议读界面 | `npm run audit:packaged` 11 条全绿：渲染层来自 `应用目录/out`、首屏引导卡三步在、应用自报「安装版」且 `installDir` 就是打包树、设置页徽章写「安装版 · linux」、内置 CLI 在打包树里（`binarySource=package`）并自报 `v1.13.5 (abb7abcd) linux/amd64`、配置落在一次性档案里、开发者真实 `~/.opencodereview/config.json` 摘要不变；反向控制把同一套断言指向源码树，必须变红并点名安装目录与 CLI 位置（实测点名 2 条）；规则本身 24 条由 `audit:packaged-rules` 钉住（含「`audit:packaged` 不许进 `audit:app`」）| `PLAYWRIGHT_MODULE=<带 playwright 的 node_modules> xvfb-run -a node tools/e2e-packaged.mjs`；`node tools/e2e-packaged-smoke.mjs`，Electron 33.4.11 |

## 未验证清单（截至 2026-11-04）

上面每一行都是「跑过什么」。这一节是它的反面：**没跑过什么**，以及下次要验的触发条件。
两份 README 的 Known limitations / 已知限制 与这一节说的是同一件事，两处互相指向——那边写
「不覆盖」，这边写「为什么没覆盖、什么时候补」。

| 项 | 归属 | 为什么没验 | 下次要验的触发条件 |
| --- | --- | --- | --- |
| 应用内更新（NSIS 安装版） | 真机 | 更新器要走完「已安装的旧版本 → 下载 → 校验 → 重启」四步，这台机器上只有开发实例；装一次再升一次会覆盖用户数据目录（`update-service.js`） | 下一次发版前，在 Windows x64 上装 `v0.1.13` 再升到新版本，记下四步各自的结果 |
| Linux / macOS 打包产物 | 真机 | 只跑过源码级门禁；`npm run dist:linux` 没跑过，macOS 一次都没构建（`tools/release.mjs`） | 第一次真的要发布这两个平台时；在那之前 README 的发布面只写 Windows |
| 真显示器与 GPU | 真机 | 这台机器没有显示器，UI 三条都在 Xvfb 下的无头 Chromium 里跑（`tools/ui-audit/audit.mjs`） | 有人在一台带显示器的机器上打开安装版，看一遍首屏、结果页与 1.25 / 1.5 缩放 |
| 安装版之后的首启链路 | 真机 | 第 117 轮起「装完的那份字节」有脚本了：`tools/e2e-packaged.mjs` 启动 `release/linux-unpacked` 里的可执行文件并断言首屏、安装形态与内置二进制（Linux x64 上 11 条全绿）。仍缺的是 **Windows 的 `*-setup.exe` 包装层**——NSIS 安装、快捷方式、SmartScreen、卸载器，以及装完之后图标起的那一份；这台机器是 Linux，跑不了那一层 | 在 Windows x64 上装一次 `v0.1.13` 或更新的安装包，把首启那一屏的结果记下来；这一趟同时也是 DOD-5 缺的那半边 |
| 发布资产里带的是哪一版 `ocr` | 真机 | 答案是脚本读出来的，不是人读出来的：最新发布 tag `v0.1.13`（2026-10-14 的提交）的 `package.json` 声明 `^1.13.0`，同一份 tag 的 `package-lock.json` 把 `@alibaba-group/open-code-review` 解析在 `1.13.0`——`npmRebuild: false` 且 electron-builder 把 `node_modules` 抄进 `应用目录`，所以那一份就是产物里带的；源码树这一侧声明 `^1.13.5`、lockfile 解析 `1.13.5`、pin `v1.13.5`。两边差的是「下载得到的那份自带旧两版 CLI」，不是「不知道」。仍没验的是**装完之后磁盘上那份**（装完之后磁盘上那份应用目录里的 CLI 未被读过）：这台机器跑不了 NSIS | 在 Windows x64 上装一次发布资产，把 `npm run audit:packaged` 指到 `win-unpacked` 或读应用自己的版本探测（`app-info.js` 问的就是 `ocr --version`），结果记回这一行；发新版时 tag 一变，`npm run audit:release-pin` 就会红，直到这一行改写 |
| 单实例锁 | 真机 | 开发实例与安装版共用同一份用户数据，验它要两个进程抢同一个目录，会打断正在跑的审查（`main.js`） | 装完安装版之后双击两次图标，确认第二个窗口静默退出而不是起两份 |
| 卸载路径 | 真机 | 卸载会删用户数据目录，而这台机器上的会话与配置是唯一一份（`uninstall-handler.js`） | 在一台可以丢数据的机器上装一次、卸一次，确认 `ocr` 配置与 Key 的去留与 README 说的一致 |
| 导出 HTML 报告的中文排版 | 上游 | 报告是上游 `ocr` 自己生成的 HTML，排版（标点、行高、字体栈）归上游，本仓只负责把文件交出去；本仓的排版断言（`audit:typography` / `audit:typography-ui`）看的是自己的文档与界面，看不到那份 HTML；上游那一行记在 `docs/OCR-UPSTREAM-SYNC.md` 的对照表里 | 上游改报告模板时（对照表里 `report` 那一行变动），或有人反馈导出件的中文排版问题时；在那之前 README 不承诺导出件的排版 |
