# 用途：抓 Comate 进程的网络对端（发消息时跑，看 Comate 真正连到哪里）
# 运行：pwsh -NoProfile -ExecutionPolicy Bypass -File .agents/skills/comate_re/scripts/watch-comate-conn.ps1 -Seconds 40
# 依赖：netstat / Get-NetTCPConnection（Windows 自带）
param(
    [int]$Seconds = 40
)

# PS7 版本校验
if ($PSVersionTable.PSVersion.Major -lt 7) {
    Write-Error "此脚本要求 PowerShell 7，当前版本 $($PSVersionTable.PSVersion)"
    exit 1
}

Write-Output "=== Comate 网络对端监控（${Seconds} 秒） ==="
Write-Output "提示：在 Comate 里发一条消息，然后看下面的 RemoteAddress"
Write-Output ""

$seen = @{}
$endTime = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $endTime) {
    $conns = Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |
        Where-Object { $_.OwningProcess -in @(Get-Process comate -ErrorAction SilentlyContinue).Id }
    foreach ($c in $conns) {
        $key = "$($c.LocalAddress):$($c.LocalPort) -> $($c.RemoteAddress):$($c.RemotePort)"
        if (-not $seen.ContainsKey($key)) {
            $seen[$key] = $true
            Write-Output "[$(Get-Date -Format 'HH:mm:ss')] $key (pid $($c.OwningProcess))"
        }
    }
    Start-Sleep -Milliseconds 500
}

Write-Output ""
Write-Output "=== 抓到的去重对端 ==="
$seen.Keys | ForEach-Object { Write-Output $_ }
