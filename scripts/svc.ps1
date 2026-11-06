<#
.SYNOPSIS
  MetalPriceKit Server 本地服务管理。

.DESCRIPTION
  用 .env.local 里的配置启停服务。进程是独立的后台进程，
  关掉这个终端也不影响它继续跑。

  首次使用：
    1. 复制 .env.local.example 为 .env.local 并填好 key
    2. powershell -ExecutionPolicy Bypass -File scripts/svc.ps1 start

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/svc.ps1 start
  powershell -ExecutionPolicy Bypass -File scripts/svc.ps1 status
  powershell -ExecutionPolicy Bypass -File scripts/svc.ps1 logs
  powershell -ExecutionPolicy Bypass -File scripts/svc.ps1 stop
#>
param(
  [ValidateSet('start', 'stop', 'restart', 'status', 'logs')]
  [string]$Action = 'status',

  # logs 动作打印最后多少行
  [int]$Tail = 40
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $Root '.env.local'
$PidFile = Join-Path $Root 'data\service.pid'
$LogFile = Join-Path $Root 'data\service.log'
$ErrFile = Join-Path $Root 'data\service.err.log'

# 输出统一用 UTF-8。Windows PowerShell 5.1 默认按 GBK 输出，
# 重定向到文件时就会变成 GBK，日志跟服务自己的 UTF-8 输出对不上。
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Get-NodeExe {
  # 开发机上的 Node 装在 F 盘，不在 PATH 里也能找到。
  $local = 'F:\tools\node\node.exe'
  if (Test-Path $local) { return $local }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  throw '找不到 node.exe。装一个 Node 22+ 或把 F:\tools\node\node.exe 的路径写进本脚本。'
}

function Read-EnvFile {
  if (-not (Test-Path $EnvFile)) {
    throw "缺少 $EnvFile。生产环境的模板在 deploy/env.example。"
  }
  $map = @{}
  foreach ($line in Get-Content $EnvFile -Encoding UTF8) {
    $trimmed = $line.Trim()
    if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
    $idx = $trimmed.IndexOf('=')
    if ($idx -le 0) { continue }
    $map[$trimmed.Substring(0, $idx).Trim()] = $trimmed.Substring($idx + 1).Trim()
  }
  return $map
}

function Get-ServiceProcess {
  if (-not (Test-Path $PidFile)) { return $null }
  $pidText = (Get-Content $PidFile -Raw -Encoding UTF8).Trim()
  if ($pidText -eq '') { return $null }
  $proc = Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue
  if (-not $proc) { return $null }
  return $proc
}

function Start-ServiceProcess {
  if (Get-ServiceProcess) {
    Write-Host '服务已经在跑了。用 restart 重启。'
    return
  }

  $envMap = Read-EnvFile
  foreach ($k in $envMap.Keys) {
    Set-Item -Path "env:$k" -Value $envMap[$k]
  }

  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PidFile) | Out-Null
  $node = Get-NodeExe
  Write-Host "启动中… node=$node"
  Write-Host "  端口=$($envMap['PORT']) 预算=$($envMap['MPK_MONTHLY_BUDGET'])/月 模式=$($envMap['NODE_ENV'])"

  # stdin 要指向一个空文件：让子进程不继承父进程的 stdin 句柄。
  # 否则在某些终端/工具里，命令跑完终端还占着不退出（子进程一直握着那个管道）。
  $stdinFile = Join-Path (Split-Path -Parent $PidFile) '.stdin'
  if (-not (Test-Path $stdinFile)) { New-Item -ItemType File -Force -Path $stdinFile | Out-Null }

  # 用 -WindowStyle Hidden 而不是 -NoNewWindow：
  # -NoNewWindow 会让子进程共用当前控制台，命令跑完终端还挂着不走。
  $proc = Start-Process -FilePath $node `
    -ArgumentList 'src/index.ts' `
    -WorkingDirectory $Root `
    -PassThru -WindowStyle Hidden `
    -RedirectStandardInput $stdinFile `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError $ErrFile

  Set-Content -Path $PidFile -Value $proc.Id -Encoding ASCII

  # 等服务起来再报结果，否则 health 一定连不上。
  $port = if ($envMap.ContainsKey('PORT')) { $envMap['PORT'] } else { '8787' }
  $ready = $false
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
      $ready = $true
      break
    } catch { }
  }

  if (-not $ready) {
    Write-Host '启动后没能在 10 秒内响应。日志尾部：' -ForegroundColor Yellow
    if (Test-Path $LogFile) { Get-Content $LogFile -Encoding UTF8 -Tail 10 }
    if (Test-Path $ErrFile) { Get-Content $ErrFile -Encoding UTF8 -Tail 10 }
    return
  }

  Write-Host "已启动  PID=$($proc.Id)  http://127.0.0.1:$port" -ForegroundColor Green
  if ($health.hasSnapshot) {
    $source = if ($null -eq $health.lastFetchOk) { '本地快照（本次进程还没抓上游）' } else { "上游抓取于 $($health.lastFetchAt)" }
    Write-Host "  数据来源：$source"
  } else {
    Write-Host "  还没有任何数据，行情接口会返回 503" -ForegroundColor Yellow
  }
  Write-Host "  日志：$LogFile"
  Write-Host "  自检：node scripts/smoke.ts http://127.0.0.1:$port"
}

function Stop-ServiceProcess {
  $proc = Get-ServiceProcess
  if (-not $proc) {
    Write-Host '服务没在跑。'
    if (Test-Path $PidFile) { Remove-Item $PidFile -Force }
    return
  }
  Write-Host "停止中… PID=$($proc.Id)"
  # Node 的 SIGTERM 走 shutdown 钩子，能优雅关库。
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  if (Test-Path $PidFile) { Remove-Item $PidFile -Force }
  Write-Host '已停止。' -ForegroundColor Green
}

function Show-ServiceStatus {
  $proc = Get-ServiceProcess
  if (-not $proc) {
    Write-Host '服务没在跑。' -ForegroundColor Yellow
    return
  }
  $envMap = Read-EnvFile
  $port = if ($envMap.ContainsKey('PORT')) { $envMap['PORT'] } else { '8787' }
  Write-Host "运行中  PID=$($proc.Id)  内存=$([math]::Round($proc.WorkingSet64 / 1MB))MB"
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3
    $ok = if ($null -eq $health.lastFetchOk) { '本次进程未抓取（用本地快照）' } else { $health.lastFetchOk }
    Write-Host "  健康=$($health.status)  有数据=$($health.hasSnapshot)  抓取状态=$ok  最近抓取=$($health.lastFetchAt)  运行时长=$($health.uptimeSeconds)s"
  } catch {
    Write-Host "  健康检查失败：$($_.Exception.Message)" -ForegroundColor Yellow
  }
}

function Show-ServiceLogs {
  if (-not (Test-Path $LogFile)) { Write-Host '还没有日志。'; return }
  Get-Content $LogFile -Encoding UTF8 -Tail $Tail
  if ((Test-Path $ErrFile) -and (Get-Item $ErrFile).Length -gt 0) {
    Write-Host "`n--- stderr ---" -ForegroundColor Yellow
    Get-Content $ErrFile -Encoding UTF8 -Tail $Tail
  }
}

switch ($Action) {
  'start'   { Start-ServiceProcess }
  'stop'    { Stop-ServiceProcess }
  'restart' { Stop-ServiceProcess; Start-Sleep -Milliseconds 500; Start-ServiceProcess }
  'status'  { Show-ServiceStatus }
  'logs'    { Show-ServiceLogs }
}
