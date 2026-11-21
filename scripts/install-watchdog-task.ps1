#Requires -Version 7.0
if ($PSVersionTable.PSVersion.Major -lt 7) { throw "requires PowerShell 7+" }

# 注册 modelmux 外层守护的计划任务：登录触发 + 失败自动重启。
# 为什么用计划任务而不是「启动」文件夹快捷方式：快捷方式跑在交互会话内，会话结束即被
# 清理，且没有失败重启策略；计划任务独立于交互会话，守护非零退出可由 RestartCount 拉回。
# 幂等：重复执行只覆盖同名任务。

$ErrorActionPreference = "Stop"

# 计划任务的 <Exec><Command> 不做 PATH 查找，必须落 node.exe 绝对路径；注册动作发生在
# 当前登录会话里，Get-Command 的解析结果与任务运行时环境一致。MSI 默认位置作兜底。
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  foreach ($cand in "$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Volta\bin\node.exe") {
    if (Test-Path -LiteralPath $cand) { $node = $cand; break }
  }
}
if (-not $node) { throw "找不到 node.exe：确认已安装 Node.js 且在 PATH 中" }
# 仓库根从脚本位置推导（本文件在 scripts/ 下），仓库换机换目录都不用改。
$repo = Split-Path -Parent $PSScriptRoot
$script = Join-Path $repo "scripts\mx-watchdog.mjs"
$taskName = "modelmux-gateway-watchdog"
$startupLnk = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Startup\$taskName.lnk"

if (-not (Test-Path -LiteralPath $node)) { throw "node 不存在：$node" }
if (-not (Test-Path -LiteralPath $script)) { throw "守护脚本不存在：$script" }

# 存储根与守护脚本同口径：MODELMUX_HOME > ~/.modelmux。硬算 USERPROFILE 时，
# 设了该变量的用户会在这里读不到（也清不掉）守护的 pid 文件。
$modelmuxHome = if ($env:MODELMUX_HOME) { $env:MODELMUX_HOME } else { Join-Path $env:USERPROFILE ".modelmux" }

# 先停掉可能在跑的常驻守护，否则新任务的进程会被脚本内单实例锁挡在门外。
$pidFile = Join-Path $modelmuxHome "watchdog.pid"
if (Test-Path -LiteralPath $pidFile) {
  $oldPid = 0
  [void][int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$oldPid)
  $proc = if ($oldPid -gt 0) { Get-Process -Id $oldPid -ErrorAction SilentlyContinue } else { $null }
  if ($proc) {
    Stop-Process -Id $oldPid -Force
    Write-Output "已停止旧守护 pid=$oldPid"
  } else {
    # --once 不留常驻锁；上一代常驻的僵尸 pid 文件会误导排查。
    Remove-Item -LiteralPath $pidFile -Force
    Write-Output "已清理僵尸 watchdog.pid"
  }
}

# 每次触发跑 `--once`（单次探测，不在就拉起），不跑常驻：实测（2026-11-17）常驻守护被
# taskkill 强杀不触发 RestartCount（任务停在 Ready、result=0xFFFFFFFF），常驻本身就是
# 「可被杀的对象」。一次性进程无常驻可杀，漏掉最多 1 分钟即补。
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$script`" --once" -WorkingDirectory $repo
$boot = New-ScheduledTaskTrigger -AtLogOn
$boot.Delay = "PT30S"
# 只给 Interval 不给 Duration：XML 里缺 Duration 即「无限重复」（MaxValue 会超任务 XML 范围）。
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 1)
# 默认策略是「电池供电不启动」—— 守护不能看电源脸色；显式允许电池、不因切电池停止。
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

# S4U（Service For User）：以用户身份跑在非交互会话，不存密码也不分配控制台——
# Interactive 登录类型下 node.exe 是控制台程序，每分钟触发都新建一个 conhost 窗口
# 一闪（实测 2026-11-18 用户桌面抓到）。网关与守护都是纯回环 HTTP/文件操作，
# 不需要交互桌面；若改回 Interactive 必须另加隐藏启动器，否则弹窗回归。
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($boot, $repeat) `
  -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "已注册并启动计划任务：$taskName"

# 停用旧的登录自启路径；脚本内 watchdog.pid 单实例锁也会拦，但没必要留两条自启路径。
if (Test-Path -LiteralPath $startupLnk) {
  Remove-Item -LiteralPath $startupLnk -Force
  Write-Output "已删除启动文件夹快捷方式：$startupLnk"
}
$loginVbs = Join-Path $modelmuxHome "bin\watchdog-login.vbs"
if (Test-Path -LiteralPath $loginVbs) {
  Remove-Item -LiteralPath $loginVbs -Force
  Write-Output "已删除旧登录启动器：$loginVbs"
}
