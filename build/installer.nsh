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
;   3. 进度条中途回退。成因有两处，都在模板里：
;        a) common.nsh 的 setSpaceRequired 把「段总量」设成解压后体积
;           （APP_64_UNPACKED_SIZE = 打包目录的 dirSize），
;           而 NSIS 自己只把 File 指令写入的字节计入已用量 —— 这里只有内嵌的
;           app-64.7z，大约是解压后体积的三分之一。刻度不一致，第一格就冲到
;           三成多；
;        b) 解压由 nsis7z.dll 完成，该插件会自己 FindWindowExW + SendMessageW
;           去驱动进度条（插件作者原话：“plugin will move progress bar during
;           unpack operation”），结束后 NSIS 再按自己的刻度画回去，于是看到回退。
;      这里在「解压前」把段总量临时放大、在「解压后」收回，让两段刻度接上，
;      并保证收尾时停在 100%。
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

; —— 解压前：把「段总量」临时放大 ——
; 挂一个立刻 Abort 的自定义页（用户看不到它），只为拿到一个「已离开目录页、
; 即将进入安装页」的执行点：这时改段总量不会影响目录页的「所需空间」显示。
; 放大之后，第一个 File（把内嵌的 app-64.7z 写进 $PLUGINSDIR）只占很小一格，
; nsis7z 插件接管进度条时不会出现「26.6% → 0%」的回退。
!macro customPageAfterChangeDir
  !ifdef allowToChangeInstallationDirectory
    Page custom OcrCalibrateProgressBeforeInstall
  !endif
!macroend

!macro ocrDefineProgressProbe
  Function OcrCalibrateProgressBeforeInstall
    !ifdef APP_64_UNPACKED_SIZE
      ; 段下标写死 0：模板只声明了一个段（installer.nsi 的 Section "install"），
      ; 而它是第 94 行才声明的 —— 这个宏被插在第 43 行，此时模板那个
      ; ${INSTALL_SECTION_ID} 还没有定义（实测报 warning 6000），只能用字面量。
      ; 放大 10 倍：内嵌 7z 实测约占其 1/10，进度条此刻几乎不动，
      ; 插件从接近 0% 的地方接管，看不到回退。
      IntOp $0 ${APP_64_UNPACKED_SIZE} * 10
      SectionSetSize 0 $0
    !endif
    ; 解压那 30 秒里 NSIS 不会让我们插话（installSection.nsh 一进来就
    ; SetDetailsPrint none），唯一能提前落进详情面板的就是段的标题行。
    ; 顺手把它改成用户看得懂的话；若某版 NSIS 不打印标题行，这行也只是无副作用。
    SectionSetText 0 "正在安装 Open Code Review，请勿关闭窗口…"
    Abort ; 这一页只是挂载点，本身不显示
  FunctionEnd
!macroend

; 必须连同 !ifndef BUILD_UNINSTALLER 一起守卫：模板把 customPageAfterChangeDir
; 放在 assistedInstaller.nsh 的 !ifndef BUILD_UNINSTALLER 里，编译卸载器那一趟
; 不会展开它；若这里仍然定义函数，就会报 warning 6010「not referenced」，
; 而 makensis 带 -WX，警告即失败。
!ifdef allowToChangeInstallationDirectory
  !ifndef BUILD_UNINSTALLER
    !insertmacro ocrDefineProgressProbe
  !endif
!endif

; —— 解压后：把「段总量」收回到 NSIS 真正会计数完的量 ——
; 此宏由 extractAppPackage.nsh 的 custom_files_post_decompression 调用，
; 位置在「解压 + 复制到 $INSTDIR」之后、写卸载器之前，正是 NSIS 重新接管
; 进度条的那一刻。收小总量 => 进度条直接停在 100%，不会再掉回去。
; 同时把详情输出打开，让后续的 File / 注册表 / 快捷方式步骤有回显。
; 注：electron-builder 只有在配置了 nsis.preCompressedFileExtensions 时才会
; 自己生成同名宏，本项目没有配置，所以这里由我们独占定义。
; 这里用 ${INSTALL_SECTION_ID} 而不是字面量：本宏展开于安装段内部
; （installer.nsi 第 122 行，晚于第 94 行的 Section 声明），模板那个 define
; 此时已经存在。
;
; 取 1/4 的由来（v0.1.9 实测）：段总量 APP_64_UNPACKED_SIZE = 354,230 KB，
; 而 NSIS 自己只累计 File 写入量 —— 内嵌的 app-64.7z 为 96,332,424 B ≈ 94,074 KB，
; 占 26.6%。取 1/4 = 88,557 KB 略小于已用量，进度条在插件交还控制权的瞬间
; 直接封顶 100%，不再从 100% 掉回 26.6%。比值将来变大也只是继续封顶；
; 变小则最多停在八九成，到段末补满，同样不会回退。
!macro ocrSetSizeAfterDecompress SIZE
  IntOp $0 ${SIZE} / 4
  SectionSetSize ${INSTALL_SECTION_ID} $0
  SetDetailsPrint both
  DetailPrint "程序文件已释放到：$INSTDIR"
!macroend

!macro customFiles_x64
  !ifdef APP_64_UNPACKED_SIZE
    !insertmacro ocrSetSizeAfterDecompress ${APP_64_UNPACKED_SIZE}
  !endif
!macroend

!macro customFiles_ia32
  !ifdef APP_32_UNPACKED_SIZE
    !insertmacro ocrSetSizeAfterDecompress ${APP_32_UNPACKED_SIZE}
  !endif
!macroend

!macro customFiles_arm64
  !ifdef APP_ARM64_UNPACKED_SIZE
    !insertmacro ocrSetSizeAfterDecompress ${APP_ARM64_UNPACKED_SIZE}
  !endif
!macroend

; —— 安装段收尾：补上结论信息 + 一个「卸载」开始菜单项 ——
; 此宏在 addStartMenuLink / addDesktopLink 之后执行，$SMPROGRAMS 已指向当前
; 用户的开始菜单（package.json 里 menuCategory 为 false，快捷方式直接放在该目录）。
!macro customInstall
  CreateShortCut "$SMPROGRAMS\卸载 ${SHORTCUT_NAME}.lnk" "$INSTDIR\${UNINSTALL_FILENAME}" "" "$INSTDIR\${UNINSTALL_FILENAME}" 0 "" "" "卸载 ${SHORTCUT_NAME}"
  ; 交给 WinShell 登记成「卸载快捷方式」，Windows 才会把它和程序正确关联。
  WinShell::UninstShortcut "$SMPROGRAMS\卸载 ${SHORTCUT_NAME}.lnk"
  ClearErrors

  ; installSection.nsh 在安装段开头执行了 SetDetailsPrint none，逐文件的
  ; File / CopyFiles 输出全被吞掉，详情面板因此始终空白。上面解压完成时已经
  ; 重新打开开关，这里再把用户真正关心的结论写进去。
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
  !define MUI_FINISHPAGE_TEXT "Open Code Review 已安装到：$\r$\n$INSTDIR$\r$\n$\r$\n桌面与开始菜单的快捷方式已创建，开始菜单里还多了一个「卸载」入口。$\r$\n$\r$\n首次启动后，请到「设置」页选择模型服务并填入 API Key。"
  !insertmacro MUI_PAGE_FINISH
!macroend
