; SPDX-License-Identifier: Apache-2.0
; ---------------------------------------------------------------------------
; Open Code Review — Windows 安装器的自定义片段（package.json 的 nsis.include）。
;
; electron-builder 会把这个文件 include 进它自己的 assisted-installer 模板，
; 因此模板里的定义（PRODUCT_FILENAME、UNINSTALL_FILENAME、SHORTCUT_NAME、
; $launchLink、$newStartMenuLink、isUpdated、StdUtils…）在这里都已可用。
; 它只负责「定义宏 / 函数」，由模板在正确的时机 !insertmacro。
;
; 这个文件解决 5 件事：
;
;   1. 欢迎页明确告诉用户「要装什么、装到哪、Key 存在哪」，而不是一个空页面；
;
;   2. 安装详情面板默认是完全关掉的 —— templates/nsis/common.nsh 里硬编码了
;      ShowInstDetails nevershow，installSection.nsh 又执行 SetDetailsPrint none，
;      于是用户在安装过程中看不到任何输出。这里重新打开面板，并在安装段末尾
;      补上用户真正关心的结论（装到哪、建了哪些快捷方式、怎么卸载）。
;
;   3. 进度条中途回退（见下面「进度条为什么不能靠 SectionSetSize 校准」）。
;
;   4. 开始菜单里，在应用快捷方式旁边再放一个「卸载」入口，
;      卸载不再依赖用户去「设置 → 应用」里翻；
;
;   5. 完成页给出安装路径、确认快捷方式已建好，并提供「立即启动」勾选项。
; ---------------------------------------------------------------------------

; —— 欢迎页：把关键信息前置，避免装完才知道要自己配 Key ——
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "安装 Open Code Review 桌面版"
  !define MUI_WELCOMEPAGE_TEXT "本程序是 open-code-review (ocr) 命令行工具的图形界面。$\r$\n$\r$\n向导会把程序安装到您选择的目录，并在桌面与开始菜单创建快捷方式。安装过程中下方会显示进度与详情，完成后会给出安装结果。$\r$\n$\r$\n模型服务与 API Key 不写入安装目录：首次启动后在「设置」页填写，保存在用户目录下的 .opencodereview\config.json。$\r$\n$\r$\n点击「下一步」继续。"
  !insertmacro MUI_PAGE_WELCOME
!macroend

; —— 面板可见性 ——
; 这个宏被插到 installer.nsi 的 !include "common.nsh" 之后，所以这里的
; ShowInstDetails 覆盖模板里先出现的 nevershow。
!macro customHeader
  ShowInstDetails show
!macroend

; —— 安装页的 SHOW 回调 + 进度条处理 ——
;
; 位置很关键：它展开在 assistedInstaller.nsh 第 43 行，紧挨着第 46 行的
; !insertmacro MUI_PAGE_INSTFILES —— MUI2 的 MUI_PAGE_CUSTOMFUNCTION_*
; 是「由下一个页面宏消费一次」的语义（Pages.nsh:105 的
; MUI_PAGE_FUNCTION_CUSTOM 里 Call 完立刻 !undef），所以只有定义在这个位置
; 才会落在安装页上，而不是被前面某个页面宏先吃掉。
;
; 另外，这个位置已经在 !include "MUI2.nsh"（installer.nsi 第 9 行）之后，
; 因此下面函数体里的 ${If} / LogicLib 是可用的。
!macro customPageAfterChangeDir
  !insertmacro ocrDefineInstFilesIntro
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW ocrInstFilesShow
!macroend

; —— 进度条为什么不能靠 SectionSetSize 校准 ——
;
; 用户报告的现象：进度条在安装中途回退。实测（v0.1.9 装机 + 逐帧取色）确认：
;
;   File(app-64.7z)  0% → 37%     约 1.0s   （安装段自己按字节数推进）
;   nsis7z 插件接管  37% → 0%     瞬间     ← 用户看到的「回退」
;   nsis7z 插件      0% → 100%    约 2.5s   （插件自己 FindWindow + SendMessage）
;
; 直觉上只要把「段总量」放大，让第一段占比趋近 0 就行。**这条路是死的**，
; 三次实验都证明 SectionSetSize 对进度条刻度完全无效：
;
;   a) 在「目录页之后、安装页之前」的自定义页里放大 10 倍
;      → SectionGetSize 立刻返回 3,542,360，但第一段照样 0%→37%；
;   b) 在 preInit（.onInit 内，紧跟模板的 setInstallSectionSpaceRequired）放大
;      → 同上，刻度纹丝不动；
;   c) 解压结束后把总量收小到 1/4 → 结尾位置也没有变化。
;
; 结论：模板进度条的刻度不是运行时从 SectionGetSize 读的，改段总量只影响
; 「所需空间」的显示，不影响已经算好的刻度。而且第一段本身就无解 ——
; 只要 app-64.7z 是用 File 写进去的，NSIS 就会把它计入已用量，
; 插件接管时又必然从 0 重新开始（插件作者原话：“plugin will move progress
; bar during unpack operation”）。
;
; 因此这里换一个思路：**让第一段根本不显示百分比**。
; 安装页一显示就把进度条切成 marquee（不确定进度）模式，
; 插件那些 PBM_SETPOS 在 marquee 模式下会被系统忽略，于是
; 「37% → 0%」这一步在视觉上不存在；等安装段收尾时再切回确定模式并置满。
; 如果目标系统的 comctl32 不支持 marquee，样式位不会被接受，
; 行为退回今天的样子，不会更糟。
!macro ocrDefineInstFilesIntro
  Function ocrInstFilesShow
    ; 详情面板：安装段一开头就 SetDetailsPrint none，逐文件的回显全被吞掉，
    ; 而真正耗时的解压由插件完成、期间 NSIS 脚本是阻塞的，根本轮不到
    ; DetailPrint。唯一可用的时机就是这里 —— 安装页已经显示、段还没开始跑，
    ; 而且 MUI2 的 SHOW 回调是在 GetDlgItem 拿到详情列表句柄（控件 1016）
    ; 之后才调用的（InstallFiles.nsh:103-107），所以列表已经存在，写得进去。
    ; 这些文字会一直留在列表里，陪用户度过整个安装过程。
    ;
    ; 顺序有讲究：进度条上方那行状态文字（控件 1006）显示的是**最后一条**
    ; DetailPrint，所以把「正在做什么」放在最后，让状态行在整个安装期间
    ; 都说人话，而不是停在「完成后会…」这种像已经结束的句子上。
    SetDetailsPrint both
    DetailPrint "安装位置：$INSTDIR"
    DetailPrint "解压期间窗口可能短暂无响应，请勿关闭。"
    DetailPrint "完成后会自动创建桌面与开始菜单快捷方式。"
    DetailPrint "正在释放程序文件，这一步占绝大部分时间，请稍候…"

    ; 进度条切到 marquee。取句柄的方式与 MUI2 自己一致
    ; （InstallFiles.nsh:101-104）：安装页对话框是主窗口下唯一的 #32770，
    ; 进度条是它的控件 1004。
    Push $0
    Push $1
    Push $2
    FindWindow $0 "#32770" "" $HWNDPARENT
    GetDlgItem $0 $0 1004
    ${If} $0 != 0
      System::Call 'user32::GetWindowLongW(p r0, i -16) i .r1'
      IntOp $2 $1 & 0x8
      ${If} $2 != 0x8
        IntOp $1 $1 + 0x8
        System::Call 'user32::SetWindowLongW(p r0, i -16, i r1) i .r3'
      ${EndIf}
      System::Call 'user32::SendMessageW(p r0, i 0x40A, w 1, i 30)'  ; PBM_SETMARQUEE on
      System::Call 'user32::InvalidateRect(p r0, p 0, i 1)'
    ${EndIf}
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd
!macroend

; —— 为什么到这里就收手 ——
; 试过在解压结束后把 marquee 关掉、量程改成 0..100 并置满，让进度条以
; 「满格」收尾。实测不可靠：关 marquee 要先清 PBS_MARQUEE 样式位
; （GetWindowLong / SetWindowLong），而 nsis7z 插件在解压期间自己也在
; 反复 SendMessage 驱动同一个控件，样式位经常被抢回去，结果是进度条
; 在 marquee 和确定态之间来回跳 —— 比原来更难看。
;
; 反正安装段收尾紧跟着就是完成页，进度条以什么状态结束没人看得到，
; 所以这里只保留「一开始就切 marquee」这一步，不再折腾收尾。
; 用户能读到的结论都在完成页和详情面板里。

; —— 安装段收尾：补上结论信息 + 一个「卸载」开始菜单项 ——
; 此宏在 addStartMenuLink / addDesktopLink 之后执行，$SMPROGRAMS 已指向当前
; 用户的开始菜单（package.json 里 menuCategory 为 false，快捷方式直接放在该目录）。
;
; 注：这几行 DetailPrint 到得很晚（安装段已经跑到最后，紧接着就是完成页），
; 实测在详情面板里只停留一帧左右。它们的价值是给日志留档，用户真正会读的
; 是完成页；面板里全程可见的是 ocrInstFilesShow 写的那四行。
!macro customInstall
  CreateShortCut "$SMPROGRAMS\卸载 ${SHORTCUT_NAME}.lnk" "$INSTDIR\${UNINSTALL_FILENAME}" "" "$INSTDIR\${UNINSTALL_FILENAME}" 0 "" "" "卸载 ${SHORTCUT_NAME}"
  ; 交给 WinShell 登记成「卸载快捷方式」，Windows 才会把它和程序正确关联。
  WinShell::UninstShortcut "$SMPROGRAMS\卸载 ${SHORTCUT_NAME}.lnk"
  ClearErrors

  ; installSection.nsh 在安装段开头执行了 SetDetailsPrint none，逐文件的
  ; File / CopyFiles 输出全被吞掉，详情面板因此始终空白。这里重新打开开关，
  ; 把用户真正关心的结论写进去。
  SetDetailsPrint both
  DetailPrint "程序文件：$INSTDIR"
  DetailPrint "桌面快捷方式：已创建"
  DetailPrint "开始菜单：已创建程序快捷方式与「卸载」入口"
  DetailPrint "卸载入口：设置 → 应用，或开始菜单「卸载 ${SHORTCUT_NAME}」"
  DetailPrint "API Key 与配置：$PROFILE\.opencodereview（卸载不会删除）"
  DetailPrint "Open Code Review 安装完成"
!macroend

; —— 卸载段：把上面那个入口清掉（应用自身的快捷方式由模板负责删除）——
!macro customUnInstall
  Delete "$SMPROGRAMS\卸载 ${SHORTCUT_NAME}.lnk"
!macroend

; —— 完成页：告知安装结果，并提供「立即启动」——
; 一旦定义了 customFinishPage，模板自带的默认完成页会被整体跳过，所以这里必须
; 完整复刻模板的 StartApp 逻辑（含 --updated 透传与以用户身份启动），不能省略。
;
; 文案长度受硬约束，但约束是可以抬高的：MUI2 给 MUI_FINISHPAGE_TEXT 的标签
; 默认只有 40 个对话框单位高（Finish.nsh:286，因为有「立即启动」勾选框，
; 走的是 MUI_FINISHPAGE_TEXT_HEIGHT_BUTTONS 这一支），约合 4 行；
; v0.1.9 实测第 4 行就被勾选框压掉半句，连安装路径都被截在
; 「…\Open Code」上。定义 MUI_FINISHPAGE_TEXT_LARGE 后高度变成 60 单位
; （约 6 行），勾选框的位置是按 TEXT_BOTTOM_BUTTONS 算出来的，
; 会自己跟着下移，不需要我们摆控件。这个 define 全项目只有这一处消费。
;
; 即便如此仍留了余量：安装路径长度由用户决定，是本页唯一可能折行的内容，
; 所以正文压到「安装到哪 + 下一步做什么」两件事，详细的安装结果
; （快捷方式、卸载入口、配置文件位置）都在安装页的详情面板里，不在这里重复。
!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_FINISHPAGE_RUN_TEXT "立即启动 Open Code Review"
  !define MUI_FINISHPAGE_TITLE "安装完成"
  !define MUI_FINISHPAGE_TEXT_LARGE
  !define MUI_FINISHPAGE_TEXT "Open Code Review 已安装到：$\r$\n$INSTDIR$\r$\n$\r$\n桌面与开始菜单的快捷方式已创建。$\r$\n首次启动请在「设置」页选择模型服务并填入 API Key。"
  !insertmacro MUI_PAGE_FINISH
!macroend
