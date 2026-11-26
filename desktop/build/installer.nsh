; **本文件必须存成 UTF-8 with BOM**（前 3 字节 EF BB BF），缺 BOM 会被静默跳过。
;
; 为什么这条性命攸关：NSIS 3 读到「含非 ASCII 字符但没有 BOM」的文件会判
; Bad text encoding；而 electron-builder 对这种 include 失败是**静默跳过**的 ——
; 构建照样 exit 0、exe 照样产出，但这个宏从未被定义，安装时悄悄退回内置的
; 「礼貌关闭」检查，于是必弹「无法关闭，请手动关闭」且重试永远过不去。
; scripts/pack-desktop.mjs 在打包前断言 BOM，缺了就直接构建失败，不再静默出货。

; 安装前强制结束 modelmux。
;
; 为什么必须强杀：electron-builder 默认走「礼貌关闭」（向窗口发 WM_CLOSE 并等待），
; 而壳的关窗语义是**收进托盘**（见 docs/DESKTOP-APP.md），礼貌关闭永远等不到退出，
; 只会弹「modelmux 无法关闭，请手动关闭」—— 重试永远过不去（实测 2026-11-12）。
; 安装本来就要替换二进制，强杀是唯一自洽的行为。
;
; 这个宏**整体替换** electron-builder 的内置检查（allowOnlyOneInstallerInstance.nsh 的
; !ifmacrodef customCheckAppRunning），内置的「杀不掉就中止」也随之消失 —— 所以这里
; 自己复查一次：仍存活就中止，避免「旧文件已删、新文件写不进去」的半装状态。
;
; ExecToLog 把 taskkill 输出写进安装日志（失败可查）；打两轮是防竞态。

!macro customCheckAppRunning
  nsExec::ExecToLog 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Sleep 800
  nsExec::ExecToLog 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Sleep 300
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
  ${If} $R0 == 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "modelmux 正在运行且无法结束，请从托盘退出后重试安装。" /SD IDOK
    Quit
  ${EndIf}
!macroend

