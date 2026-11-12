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
