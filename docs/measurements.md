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
| 2026-11-03 | 跨平台验证面：第 103 轮升 pin 到 `ocr v1.13.4` 时在 Linux x64 上真跑一遍 | `audit:guards` 24 条、`audit:exit` 5 条、`audit:e2e` 18 条（真 Electron + 真 CLI）、`audit:ui` 112 条、`audit:contrast` 978 处文本 0 处低于 AA、`audit:ui-scaled` 1.25 与 1.5 各 11 条，全绿；二进制自报 `v1.13.4 (76ab46a) linux/amd64` | `xvfb-run -a npm run audit:guards`（`PW_CHANNEL=bundled`），Electron 33.4.11 |

上面那一行是**验证面**，不是又一个数字，所以它把「怎么跑出来的」也写清楚：这台机器没有 Edge，
UI 三条靠 Playwright 自带的 chromium（`PW_CHANNEL=bundled`）——Playwright 不是本仓依赖，
`npm install` 会把它当多余包装掉，所以跑 `audit:ui` 前要按 README 的说法补一份（`--no-save` 即可）。
这台机器的 `chrome-sandbox` 不是 setuid root，真 Electron 那三条都以 `--no-sandbox` 运行，
harness 会自己说明「sandbox relaxed」。这一行**不覆盖**：Linux / macOS 的打包产物（没跑
`npm run dist:linux`）、真显示器与 GPU、安装版的自动更新、以及单实例锁与卸载路径；macOS 至今
一次都没跑过任何一条。发布面同样只有 Windows——12 个 Release 的资产全是 `*-setup.exe` /
`*-portable.exe` / `latest.yml` / blockmap，没有一份 mac 或 linux 包。所以「发布到哪、验证到哪」
现在是同一句话，写在两份 README 的首屏与限制清单里。Windows x64 仍是唯一端到端（含安装包）验证过的平台。

这些数字不可复现成同一个值：审查耗时取决于服务商、网络与仓库，渲染耗取决于机器。
能复现的是**断言**——「1200 条全部渲染出来」「挂载不超过上限」写成了
`tools/ui-audit/audit.mjs` 里的检查，改坏了会红；「渲染一次真实扫描的载荷」写成了
读夹具的检查。README 承诺的是这一层，不是上表里的某一格。
