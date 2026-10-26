# 抓 AStudio 的外连（发消息的同时跑，看真正打向哪个 IP/域名）。
# 零依赖：只用 PowerShell 内置 cmdlet。
# 用法: pwsh -NoProfile -ExecutionPolicy Bypass -File watch-astudio-conn.ps1 [-Seconds 40]
param(
    [int]$Seconds = 40,
    [int]$IntervalMs = 250,
    [string]$ProcessName = "AStudio"
)

$ids = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
if ($ids.Count -eq 0) {
    Write-Output "$ProcessName 未运行"
    exit 1
}
Write-Output "监听 PID: $($ids -join ',') ，共 $Seconds 秒（这段时间里请在 AStudio 界面发一条消息）"

$seen = @{}
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end) {
    $conns = Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |
        Where-Object { $_.OwningProcess -in $ids }
    foreach ($c in $conns) {
        $key = "$($c.LocalPort)->$($c.RemoteAddress):$($c.RemotePort)"
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $remote = $c.RemoteAddress
        $tag = if ($remote -eq '127.0.0.1' -or $remote -eq '::1') { 'local' } else { 'WAN ' }
        Write-Output ("[{0}] {1}  {2}:{3} -> {4}:{5}" -f $tag, (Get-Date -Format 'HH:mm:ss.fff'), $c.LocalPort, '', $remote, $c.RemotePort)
    }
    Start-Sleep -Milliseconds $IntervalMs
}

Write-Output ""
Write-Output "=== 汇总（去重后）==="
$seen.Keys | Sort-Object | ForEach-Object { "  $_" }
