# Windows x64 安装包真机清单（一次跑完 DOD-5、DOD-6 与 DOD-4 的一段）

> 状态：**尚未执行**。这份文件是一次操作的说明书，不是验证记录；它自己也因此不能当证据用。
> 只有当有人把下面每一格的读数填上、贴回 `docs/measurements.md` 对应的行之后，这几行「没验证过」
> 才变成「验证过」。清单存在只说明「知道该验什么」，不说明验过。

## 为什么这一步只能由人在真机上做

`docs/measurements.md` 的实测表里，真机面全是 Linux x64：CLI 层、真 Electron、UI 那几套都在那台机器上跑过。
发布面却只有 Windows——12 个 Release 的资产全是 `*-setup.exe` / `*-portable.exe` / `latest.yml` / blockmap。
中间那一层（NSIS 向导、快捷方式、「应用和功能」里的条目、SmartScreen、卸载器、portable 的临时解压）是
**包装层**，它不在 `npm run dev` 里，也不在 `release/linux-unpacked` 里；Linux 上既跑不了 NSIS，也不该由脚本
在别人的机器上装软件。`tools/e2e-packaged.mjs` 能证明「装完的那份字节起得来」，证明不了「装的过程」。

所以这一层的证据只有一种：一个人在 Windows x64 上按下面的顺序走一遍，把读数写回来。
清单把「验什么、期望读到什么、这个读数记回哪一行」逐项写死，目的是让这一趟**不需要第二个懂这个仓库的人**
在旁边解释。

## 谁、在哪台机器、什么时候跑

- **机器**：Windows 10 或 Windows 11，x64。**普通用户账号**，不是管理员（per-user 安装按设计不需要提权，
  真要验的就是这一点）。
- **前提**：装之前 `%USERPROFILE%\.opencodereview\` 不存在，或者已经备份过——第 5 步会往里面写一个 Key。
  装之前也确认桌面与开始菜单里没有旧的快捷方式。
- **什么时候**：下一次发版前，或者 DOD-5 要被勾之前。整趟约 20–30 分钟（两次安装、一次卸载）。
- **跑完怎么交**：把带读数的整段贴回 `docs/measurements.md` 里对应的那几行（第 9 节给了对照表），
  附上两个安装包的 SHA256 与机器信息（Windows 版本、账号类型）。读数是「未出现」「报错原文」也要贴，
  不要改写成结论。

## 0. 取包并记下指纹

从 Releases 下载两个文件：`open-code-review-desktop-0.1.13-setup.exe` 与
`open-code-review-desktop-0.1.13-portable.exe`。版本号以最新发布 tag 为准——`npm run audit:release-pin`
会答出当前最新 tag、以及那一份发布里带的是哪一版 `ocr`（两个数字都要，第 4.3 步要拿它对读数）。

PowerShell 里取指纹，两个文件各一次：

```powershell
Get-FileHash .\open-code-review-desktop-0.1.13-setup.exe -Algorithm SHA256
Get-FileHash .\open-code-review-desktop-0.1.13-portable.exe -Algorithm SHA256
```

记：setup 的 SHA256 是 ____，portable 的 SHA256 是 ____。

## 1. SmartScreen（DOD-5）

**验什么**：双击 `*-setup.exe` 之后，未签名的包会不会被拦、拦住之后能不能走下去。

**期望读数**：出现「Windows 已保护你的电脑」，点「更多信息」→「仍要运行」之后向导起来。
出处：`使用说明.md` 的「代码签名」一节与两份 README 的安装段都写着未做代码签名。

需要记下来的三种情况：

- 出现了，并按上面两步走下去了：记「出现，更多信息 → 仍要运行可用」。
- **没出现**：也要记「未出现」，并写一句为什么（例如文件不是经浏览器下载的、企业策略关掉了 SmartScreen）。
  **未出现不等于已签名**，别把它写成「签名通过」。
- 出现但「更多信息」后面没有「仍要运行」，或点了之后没有继续：这是阻塞项，把窗口原文贴回来。

记：____。

## 2. NSIS 向导（DOD-5 的主读数）

逐项对，每一项都写「与期望一致」或者「不一致：读到的是 ____」。期望值全部来自 `package.json` 的
`build.nsis` 与 `build/installer.nsh`，不是凭印象。

### 2.1 语言与欢迎页

- 向导语言是简体中文（`language: 2052`，`displayLanguageSelector: false`，所以没有语言选择页）。
- 欢迎页标题「安装 Open Code Review 桌面版」。正文里应当同时出现三件事：装到你自己选择的目录、
  桌面与开始菜单会创建快捷方式、API Key 与配置**不写在安装目录**而是用户目录下的
  `.opencodereview\config.json`。

记：____。

### 2.2 安装目录页

- 有一个可以改安装目录的页面（`oneClick: false` 加 `allowToChangeInstallationDirectory: true`）。
- 默认路径是 `C:\Users\<你>\AppData\Local\Programs\Open Code Review`（出处：`使用说明.md` 的安装段）。
- **不出现 UAC 提权弹窗**（`perMachine: false`，per-user 安装）。出现了就是与设计不符，记下来。
- 试着把目录改到别处（例如 `D:\Apps\Open Code Review`），向导应当接受，并把它当作安装目录继续。

记：默认路径读数是 ____，改目录是否被接受是 ____，有没有 UAC 是 ____。

### 2.3 安装页：详情面板与进度条

`build/installer.nsh` 把模板默认关掉的详情面板重新打开了，所以安装期间应当能读到四行：

- `安装位置：<你选的目录>`
- `解压期间窗口可能短暂无响应，请勿关闭。`
- `完成后会自动创建桌面与开始菜单快捷方式。`
- `正在释放程序文件，这一步占绝大部分时间，请稍候…`

进度条从安装页一出现就切成不确定进度（marquee，不显示百分比），所以**不该看到百分比从 37% 退回 0%**。
这一条是修过的缺陷（`installer.nsh` 顶部的注释记着现象与三次实验），本轮要确认它在真机上真的成立。

记：四行是否都在 ____，进度条有没有回退 ____。

### 2.4 安装段收尾与完成页

安装段末尾，详情面板里应当写出结论（`customInstall` 宏）：

- `程序文件：<安装目录>`
- `桌面快捷方式：已创建`
- `开始菜单：已创建程序快捷方式与「卸载」入口`
- `卸载入口：设置 → 应用，或开始菜单「卸载 Open Code Review」`
- `API Key 与配置：<你的用户目录>\.opencodereview（卸载不会删除）`
- `Open Code Review 安装完成`

完成页（`customFinishPage`）：

- 标题「安装完成」，正文里给出**安装路径**，并说清首次启动要在设置页选模型、填 Key。
- 有勾选项「立即启动 Open Code Review」，**默认已勾**。保持勾选，点完成——第 4 步就从这里起。

记：收尾几行是否都在 ____，完成页路径显示的是 ____，勾选项默认状态是 ____。

## 3. 快捷方式与「应用和功能」条目（DOD-5）

**验什么**：装完之后，用户能从哪几个地方找到它、从哪里卸载。

- 桌面：一个名为 `Open Code Review` 的快捷方式（`createDesktopShortcut: "always"`）。
- 开始菜单：`%APPDATA%\Microsoft\Windows\Start Menu\Programs\` 下两个文件——
  `Open Code Review.lnk` 与 `卸载 Open Code Review.lnk`（`menuCategory: false`，所以直接放在这一层，
  不建分类文件夹；卸载入口由 `customInstall` 用 `WinShell::UninstShortcut` 登记）。
- 「设置 → 应用 → 已安装的应用」（旧系统叫「应用和功能」）：条目名是 `Open Code Review 0.1.13`
  （`uninstallDisplayName`），发布者是 xyris，位置是第 2.2 步选的目录。

PowerShell 里可以一次看全：

```powershell
Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs" -Filter "*Open Code Review*"
Get-ChildItem "$env:USERPROFILE\Desktop" -Filter "*Open Code Review*"
```

记：桌面 ____，开始菜单两个文件 ____，应用列表条目名与发布者 ____。

## 4. 从图标起的那一份（DOD-5 的主读数，也是 DOD-4 的一段）

这一步看的是**装完的那一份**，不是开发实例。第 2.4 步勾了「立即启动」的话，这一屏已经在你面前了。

### 4.1 首屏

- 引导卡标题是「三步开始第一次审查」，三步分别是选仓库、配模型、点开始审查
  （`src/components/GuideCard.tsx`）；文件清单会自己算，不消耗 token 那句话也在。
- 没有错误通知条，也没有一闪而过的崩溃。

记：引导卡是否在原样出现 ____，有没有错误条 ____。

### 4.2 设置 → 关于与卸载：六行读数

打开「设置」页，滚到最下面「关于与卸载」那张卡。六行的期望值：

| 行 | 期望读数 |
| --- | --- |
| 程序版本 | `v0.1.13`（与安装包同版本） |
| ocr CLI | `v1.13.0`——这是 `v0.1.13` 这份发布里带的那一版（`npm run audit:release-pin` 的答案），不是源码树的 pin；下一次发版后以那条命令的读数为准。**这一格里的数字有断言**：`npm run audit:release-pin` 会把本页出现的每个 `X.Y.Z` 与最新发布 tag 的读数逐个比，发版之后忘了回来改，`audit:static` 会红并点名行号 |
| 可执行文件 | `<安装目录>\resources\app\node_modules\@alibaba-group\ocr-win32-x64\bin\opencodereview.exe` |
| 可执行文件来源 | `CLI 自带平台包`（也就是 `binarySource=package`，说明找到的是随程序装进来的那份，不是全局安装） |
| 安装目录 | 第 2.2 步选的目录本身（是 `resources` 的上一级，不是 `resources\app`） |
| 配置目录 | `C:\Users\<你>\.opencodereview\config.json` |

卡片右上角的徽章应当是 `安装版 · win32`（`packaged` 为真、`portable` 为假、`platform` 是 `win32`）。

记：六行逐行抄回来；徽章是 ____。

### 4.3 直接问那个二进制（发布资产的一致性）

在上面那个「可执行文件」路径上直接跑一次版本查询：

```powershell
& "<安装目录>\resources\app\node_modules\@alibaba-group\ocr-win32-x64\bin\opencodereview.exe" --version
```

**期望读数**：与 4.2 的「ocr CLI」行完全一致，形如 `v1.13.0 (<7 位 commit>) windows/amd64`。

这一条把两件事连起来：`npm run audit:release-pin` 说这份发布带的是 `1.13.0`，这里说的是磁盘上那一份
实际自报的版本。两边不一致时，**以磁盘为准**，把两条读数一起贴回来——那是资产与记录对不上，不是清单写错了。

记：____。

### 4.4 单实例

再双击一次桌面图标。

**期望读数**：没有出现第二个窗口；已经开着的那个窗口被还原并激活（`main.js` 的 `second-instance` 分支）。
任务栏里也只有一个条目。

记：____。

## 5. 配置与 Key 落在哪（DOD-6 的实测）

**验什么**：装好的那一份里，Key 真的只写进用户目录的 `config.json`，程序目录里没有副本。

### 5.1 先写一个 Key

在设置页选一个模型服务、填入一个**可丢弃的** Key，保存。设置页应当显示掩码（形如 `sk-****ab`），
而不是明文。保存之后回到「关于与卸载」，确认「配置目录」一行指向的还是 `%USERPROFILE%\.opencodereview\config.json`。

### 5.2 翻两个地方

```powershell
# 1) 用户配置：应当有 api_key
Select-String -Path "$env:USERPROFILE\.opencodereview\config.json" -Pattern "api_key"

# 2) 程序目录：不应当有任何 json 里含 api_key（把路径换成第 2.2 步选的那个）
Get-ChildItem -Recurse -File "<安装目录>" -Include *.json |
  Select-String -Pattern "api_key"
```

**期望读数**：第一条有命中（那是唯一一份 Key）；第二条**零命中**。

### 5.3 Electron 用户数据目录也别漏

`%APPDATA%\Open Code Review\` 是 Electron 的 `userData`（`main.js` 存 `window-bounds.json`，
`run-diagnostics.js` 存上限证据，`update-service.js` 存更新偏好 `settings.json`）。它不在程序目录里，
也不该出现 Key：

```powershell
Get-ChildItem -Recurse -File "$env:APPDATA\Open Code Review" -Include *.json |
  Select-String -Pattern "api_key"
```

**期望读数**：零命中。

### 5.4 命中怎么办

5.2 第二条或 5.3 只要有命中，就是 DOD-6 的阻塞项：把命中文件的完整路径与命中那一行（Key 打码）贴回来，
**不要继续往下勾**。`config-handler.js` 只经 `ocr config set` 写配置，程序自己不该有第二个副本。

记：5.2 第一条命中 ____，第二条 ____，5.3 ____。

## 6. 免安装版（portable）的运行面（DOD-5）

**验什么**：`使用说明.md` 与设置页文案里的三句话——「不写注册表」「没有卸载器」「不用了直接删除该 exe 即可」。

### 6.1 起得来、说的是免安装版

双击 `open-code-review-desktop-0.1.13-portable.exe`。

- 不起安装向导，直接出窗口。
- 设置页「关于与卸载」徽章是 `免安装版 · win32`。
- 「安装目录」一行显示 `（免安装版运行在临时目录）`（`install-info.js` 在 `PORTABLE_EXECUTABLE_DIR`
  存在时把 `installDir` 置空）。
- 没有「卸载本程序」按钮，旁边那句话是「免安装版直接删除该 exe 即可，不写注册表。」

记：____。

### 6.2 不写注册表、不建快捷方式

关掉之后：

```powershell
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall" /s /f "Open Code Review"
```

**期望读数**：无命中（没有卸载项）。桌面与开始菜单也没有新增快捷方式。

记：____。

### 6.3 用户数据目录会出现，这是预期的

`%APPDATA%\Open Code Review\` 在那一次运行后会被创建（窗口位置、诊断、更新偏好）。它在文件系统里，
不在注册表里；「直接删除该 exe」抹掉的是注册表项与快捷方式，不是这些文件。

把实际读数记回来：它是否被创建 ____，里面有什么文件 ____。这一格是给 `使用说明.md` 那句
「不写注册表」划范围用的：如果哪天要改口，改的是那句话，不是这个事实。

### 6.4 删掉就没了

关掉应用，删掉那个 exe。程序不再存在，没有残留的快捷方式或卸载项（`%APPDATA%` 那几份文件除外，
见 6.3）。

记：____。

## 7. 卸载（DOD-5、DOD-6）

两个入口都要走一遍，因为它们走的是不同代码：开始菜单那个是 NSIS 卸载器本身，应用内「卸载本程序」
是 `uninstall-handler.js` 先落盘诊断证据、再启动卸载器并退出。

### 7.1 开始菜单入口

用第 3 步看到的「卸载 Open Code Review」启动卸载器，走完。

**期望读数**：

- `<安装目录>` 消失。
- 桌面与开始菜单的两个快捷方式消失。
- 「应用和功能」里的 `Open Code Review 0.1.13` 条目消失。
- **保留** `%USERPROFILE%\.opencodereview\config.json`（含 Key 与会话记录）——这是 `使用说明.md`
  与设置页确认框的承诺。
- **保留** `%APPDATA%\Open Code Review\`（`deleteAppDataOnUninstall: false`）。

记：四项删除是否都成立 ____，两处保留是否都成立 ____。

### 7.2 重装一次，看 Key 还在不在

重新装一次（同一个安装包），从图标起，打开设置页。

**期望读数**：之前填的模型服务与「Key 已保存」还在——这才是 7.1「保留」的证词；只看文件夹还在，
说明不了程序还能用它。

记：____。

### 7.3 应用内入口

设置 → 关于与卸载 → 「卸载本程序」→ 确认框里写明 `.opencodereview` 下的配置与会话记录不会被删除 →
点「开始卸载」。

**期望读数**：应用关闭，卸载器起来；卸载完成后与 7.1 同样的四项消失、两处保留。

记：____。

## 8. 不在这份清单里的（别顺手加）

- **应用内更新**：要「已安装的旧版本 → 下载 → 校验 → 重启」四步，得先有下一版发布，另开一趟
  （`docs/measurements.md` 的单独一行）。
- **真显示器与 GPU、1.25 / 1.5 缩放**：这一趟只看读数不看像素；那两行另有触发条件。
- **代码签名**：未签名是当前承诺，不是缺陷；清单只验「提示出现时走得下去」。
- **跑一次真实审查**：需要真 Key 与真仓库，那笔钱记在实测表里，不在这趟里花。

## 9. 读数记回哪一行

| 清单项 | 记回 `docs/measurements.md` 的哪一行 | 推进哪条 DoD |
| --- | --- | --- |
| 1 SmartScreen | 安装版之后的首启链路 | DOD-5 |
| 2 向导（目录、详情面板、完成页） | 安装版之后的首启链路 | DOD-5 |
| 3 快捷方式与卸载入口 | 安装版之后的首启链路 | DOD-5 |
| 4.1–4.2 首启与六行读数 | 安装版之后的首启链路 | DOD-5（主）；4.1 同时是 DOD-4 的一段 |
| 4.3 内置二进制自报版本 | 发布资产里带的是哪一版 `ocr` | DOD-5（资产与记录一致） |
| 4.4 单实例 | 单实例锁 | DOD-5 附带 |
| 5 配置与 Key 的位置 | 装好之后 Key 落在哪 | DOD-6 |
| 6 portable | 免安装版（portable）的运行面 | DOD-5 |
| 7 卸载 | 卸载路径 | DOD-5、DOD-6 |

一趟跑完，上表里六行都换掉「没验过」，DOD-5 与 DOD-6 才具备被勾的条件；勾选本身归 scheduler 侧，
这份文件不改 `docs/PRODUCT-DOD.md` 的方括号。
