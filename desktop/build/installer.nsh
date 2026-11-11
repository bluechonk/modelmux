; 安装前强制结束 modelmux。
;
; 为什么必须强杀：electron-builder 默认走「礼貌关闭」（向窗口发 WM_CLOSE 并等待），
; 而壳的关窗语义是**收进托盘**（见 docs/DESKTOP-APP.md），礼貌关闭永远等不到退出，
; 只会弹「modelmux 无法关闭，请手动关闭」—— 重试永远过不去（实测 2026-11-12）。
; 安装本来就要替换二进制，强杀是唯一自洽的行为；装完 runAfterFinish 会拉起新实例。
;
; 打两轮是防竞态：第一轮枚举与击杀之间若有子进程被拉起，第二轮兜底；
; 进程不存在时 taskkill 返回非零，无副作用。

!macro customCheckAppRunning
  nsExec::Exec 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Sleep 800
  nsExec::Exec 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $0
  Sleep 300
  ; 运行时证明（验证宏真的被执行；验证后移除）
  FileOpen $1 "$TEMP\modelmux-kill-ran.txt" w
  FileWrite $1 "ran"
  FileClose $1
!macroend
