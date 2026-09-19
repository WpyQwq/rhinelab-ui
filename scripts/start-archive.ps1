<#
  Rhine Lab UI · 一键启动（桌面那个脚本调的就是它）

  做三件事：
    1. 确保本地归档后端（「数据库」，127.0.0.1:43117）在跑；没装开机自启就顺手装上。
    2. 在单独窗口里启动界面（npm run dev），窗口关掉即停止界面。
    3. 等界面真的响应了，再用默认浏览器打开它。

  顺序很重要：先等后端首轮扫描结束再起界面。因为 back 端启动时会重建快照，
  而 npm run dev 的 predev 也会重建一次，两边同时写同一批文件会互相踩。

  用法：
    -Mode start    一键启动（默认）
    -Mode stop     停掉界面与后端
    -Mode status   只看状态
#>
[CmdletBinding()]
param(
  [ValidateSet('start', 'stop', 'status')]
  [string]$Mode = 'start'
)

$ErrorActionPreference = 'Stop'

$ProjectRoot   = Split-Path -Parent $PSScriptRoot
$ServiceScript = Join-Path $PSScriptRoot 'archive-service.ps1'
$ConfigPath    = Join-Path $ProjectRoot 'archive.config.json'
$LogDir        = Join-Path $ProjectRoot 'logs'
$UiPidFile     = Join-Path $LogDir 'ui.pid'
$UiLog         = Join-Path $LogDir 'ui.log'
$UiErrLog      = Join-Path $LogDir 'ui.err.log'
$UiPortFirst   = 5173
$UiPortLast    = 5185
$UiMarker      = 'ANALYSIS OS'

function Write-Head($text) { Write-Host ''; Write-Host "  $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "    $text" -ForegroundColor Green }
function Write-Info($text) { Write-Host "    $text" -ForegroundColor Gray }
function Write-Warn2($text) { Write-Host "    $text" -ForegroundColor Yellow }

function Get-ArchiveConfig {
  if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "缺少配置文件：$ConfigPath" }
  return (Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Find-UiPort {
  foreach ($p in $UiPortFirst..$UiPortLast) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$p/" -TimeoutSec 2 -UseBasicParsing
      if ($r.StatusCode -eq 200 -and ([string]$r.Content) -like "*$UiMarker*") { return $p }
    } catch { }
  }
  return 0
}

function Wait-UiPort {
  param([int]$TimeoutSec = 240)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $p = Find-UiPort
    if ($p -gt 0) { return $p }
    Start-Sleep -Milliseconds 1000
  }
  return 0
}

function Get-RecordedUiPid {
  if (-not (Test-Path -LiteralPath $UiPidFile)) { return 0 }
  $raw = (Get-Content -LiteralPath $UiPidFile -Raw).Trim()
  $value = 0
  if ([int]::TryParse($raw, [ref]$value)) { return $value }
  return 0
}

function Stop-Ui {
  $stopped = $false

  $recorded = Get-RecordedUiPid
  if ($recorded -gt 0 -and (Get-Process -Id $recorded -ErrorAction SilentlyContinue)) {
    & taskkill.exe /PID $recorded /T /F 2>&1 | Out-Null
    Write-Ok "已关闭界面窗口（进程树 $recorded）"
    $stopped = $true
  }

  # 兜底：按命令行找这个项目的 vite 进程（例如用户自己敲的 npm run dev）
  $extra = @()
  foreach ($p in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    $cl = [string]$p.CommandLine
    if ($cl -and $cl -like "*$ProjectRoot*vite*") { $extra += [int]$p.ProcessId }
  }
  foreach ($t in ($extra | Sort-Object -Unique)) {
    Stop-Process -Id $t -Force -ErrorAction SilentlyContinue
    $stopped = $true
  }
  if (-not $stopped) { Write-Warn2 '界面本来就没在运行。' }
  Remove-Item -LiteralPath $UiPidFile -Force -ErrorAction SilentlyContinue
}

function Show-Status {
  Write-Head '界面'
  $port = Find-UiPort
  if ($port -gt 0) {
    $recorded = Get-RecordedUiPid
    Write-Ok "在运行：http://127.0.0.1:$port/  （记录的 PID $recorded）"
  } else {
    Write-Info '未运行'
  }
  Write-Head '归档后端'
  & $ServiceScript -Action status
}

switch ($Mode) {
  'status' { Show-Status }

  'stop' {
    Write-Head '停止档案库'
    Stop-Ui
    & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
      -NoProfile -ExecutionPolicy Bypass -File $ServiceScript -Action stop
    Write-Host ''
  }

  'start' {
    Write-Head '启动档案库'

    if (-not (Test-Path -LiteralPath $ServiceScript)) {
      throw "找不到服务脚本：$ServiceScript"
    }

    # 1) 后端（「数据库」）
    # 放进子进程调用：这样它的 exit 码语义明确，也不会把本脚本一起 exit 掉。
    # （直接在同一个会话里 & 调用时 $LASTEXITCODE 可能是 $null，而 $null -ne 0 为真，
    #   会把「后端其实好好的」误报成失败。）
    Write-Info '检查归档后端……'
    & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
      -NoProfile -ExecutionPolicy Bypass -File $ServiceScript -Action ensure
    $backendOk = ($LASTEXITCODE -eq 0)
    if (-not $backendOk) {
      Write-Warn2 '归档后端没能就绪 —— 界面照常启动，但 LOCAL ARCHIVE 面板与「文件位置」会不可用。'
    }

    $cfg = Get-ArchiveConfig

    # 2) 界面
    $port = Find-UiPort
    if ($port -gt 0) {
      Write-Ok "界面已经在跑：http://127.0.0.1:$port/"
    } else {
      if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
      $npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue)
      if (-not $npm) { throw '找不到 npm.cmd，请确认 Node.js 已正确安装。' }

      Write-Info '启动界面（后台静默运行 npm run dev，日志写进 logs\ui.log）……'
      # 隐藏窗口 + 重定向输出：一是干净，二是万一起不来，日志就在手边可查。
      # （反过来，不重定向时 Start-Process 在非交互宿主里可能连窗口都建不出来，
      #   表现就是「什么都没发生」，排查时毫无线索。）
      $proc = Start-Process -FilePath $npm.Source -ArgumentList @('run', 'dev') `
        -WorkingDirectory $ProjectRoot -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $UiLog -RedirectStandardError $UiErrLog
      Set-Content -LiteralPath $UiPidFile -Value $proc.Id -Encoding ASCII

      Write-Info '等待界面就绪（predev 会先重建一次索引，约十几秒）……'
      $port = Wait-UiPort -TimeoutSec 300
      if ($port -le 0) {
        Write-Warn2 '界面在超时前没有响应。下面是它自己的输出：'
        Write-Host ''
        if (Test-Path -LiteralPath $UiLog) { Get-Content -LiteralPath $UiLog -Tail 20 -Encoding UTF8 | ForEach-Object { Write-Host "      $_" } }
        if ((Test-Path -LiteralPath $UiErrLog) -and (Get-Item -LiteralPath $UiErrLog).Length -gt 0) {
          Write-Host ''
          Write-Host '      --- stderr ---' -ForegroundColor DarkGray
          Get-Content -LiteralPath $UiErrLog -Tail 20 -Encoding UTF8 | ForEach-Object { Write-Host "      $_" }
        }
        Write-Host ''
        exit 1
      }
      Write-Ok "界面已就绪：http://127.0.0.1:$port/"
    }

    # 3) 开浏览器
    Start-Process ("http://127.0.0.1:$port/") | Out-Null
    Write-Ok '已用默认浏览器打开。'

    Write-Host ''
    Write-Info "归档根：$($cfg.root)"
    Write-Info '要停止：运行「启动档案库.cmd stop」（界面与后端一起停）'
    Write-Info "界面日志：$UiLog"
    Write-Host ''
  }
}
