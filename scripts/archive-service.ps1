<#
  Rhine Lab UI · 本地归档后端（「数据库」）服务管理

  这个后端就是 RhineLabUI 的数据层：它索引 E:\归档（当前 4.5 万文件 / 110 GB），
  生成 content/archives.json、public/archive-index.json 与 47 份摘要，并在归档变动时
  自动重建快照；界面上的 LOCAL ARCHIVE 面板与「文件位置」都靠它。
  它只监听 127.0.0.1，且每次启动生成一枚访问令牌写入 .archive-token。

  常用：
    install     安装开机自启（登录时触发）+ 立即启动      ← 一次性
    ensure      没在跑就拉起，在跑就什么都不做            ← 一键脚本会调
    status      看状态（任务 / 端口 / 进程 / 快照 / 归档根）
    stop        停掉后端
    uninstall   取消开机自启并停掉后端
    logs        看后端最近的输出

  自启的两种装法（install 会自己挑）：
    · 管理员会话 → 计划任务 WpywArchiveService（登录触发、失败自动重试 3 次）
    · 普通会话   → 「启动」文件夹里的快捷方式（不需要提权，效果相同）
  实测本机普通会话注册计划任务会被「拒绝访问」，所以默认走「启动」文件夹这条。

  为什么用「登录时」而不是「开机 + SYSTEM」：
    1) 服务要用 explorer.exe /select 打开资源管理器定位文件（SHOW IN FOLDER）。
       以 SYSTEM 跑会落在会话 0，用户屏幕上什么都不会出现 —— 那功能会静默失效。
    2) 以当前用户跑，它写出的 archives.json / archive-index.json 归属正常，
       用户随后自己跑 npm run build 不会被权限挡住。
    3) 开机触发要求把账户口令存进计划任务，本机没有这个必要。
  结论：本机单人使用，登录即等于开机可用，且功能无损。窗口由 VBS 隐藏，不弹黑框。
#>
[CmdletBinding()]
param(
  [ValidateSet('ensure', 'start', 'stop', 'restart', 'status', 'install', 'uninstall', 'logs', 'run')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'

$TaskName    = 'WpywArchiveService'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath  = Join-Path $ProjectRoot 'archive.config.json'
$ServiceJs   = Join-Path $ProjectRoot 'scripts\archive-service.mjs'
$TokenFile   = Join-Path $ProjectRoot '.archive-token'
$LogDir      = Join-Path $ProjectRoot 'logs'
$LogFile     = Join-Path $LogDir 'archive-service.log'
$HiddenVbs   = Join-Path $ProjectRoot 'scripts\archive-service-hidden.vbs'
$WScript     = Join-Path $env:SystemRoot 'System32\wscript.exe'
$StartupLnk  = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)) '归档后端 (Rhine Lab).lnk'

function Write-Head($text) { Write-Host ''; Write-Host "  $text" -ForegroundColor Cyan }
function Write-Item($label, $value) {
  Write-Host ('    {0,-12} {1}' -f $label, $value)
}
function Write-Ok($text)   { Write-Host "    $text" -ForegroundColor Green }
function Write-Info2($text) { Write-Host "    $text" -ForegroundColor Gray }
function Write-Warn2($text) { Write-Host "    $text" -ForegroundColor Yellow }

function Get-NodeExe {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  $fallback = 'C:\Program Files\nodejs\node.exe'
  if (Test-Path -LiteralPath $fallback) { return $fallback }
  throw '找不到 node.exe，请先安装 Node.js。'
}

function Get-ArchiveConfig {
  if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "缺少配置文件：$ConfigPath" }
  return (Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Get-Port {
  $cfg = Get-ArchiveConfig
  if ($cfg.port) { return [int]$cfg.port }
  return 43117
}

function Get-Token {
  if (-not (Test-Path -LiteralPath $TokenFile)) { return '' }
  return (Get-Content -LiteralPath $TokenFile -Raw).Trim()
}

function Get-ListenerProcessId {
  param([int]$Port)
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($conn) { return [int]$conn.OwningProcess }
  return 0
}

function Get-CommandLineOf {
  param([int]$ProcessId)
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
  if ($p) { return [string]$p.CommandLine }
  return ''
}

function Test-BackendListening {
  param([int]$Port)
  $procId = Get-ListenerProcessId -Port $Port
  if ($procId -le 0) { return $false }
  return ((Get-CommandLineOf -ProcessId $procId) -like '*archive-service.mjs*')
}

function Get-BackendState {
  param([int]$Port)
  $state = [ordered]@{
    listening = $false; pid = 0; healthy = $false
    watching = $false; lastScan = $null; totals = $null; root = $null; lastError = $null; httpError = $null
  }
  $procId = Get-ListenerProcessId -Port $Port
  if ($procId -le 0) { return $state }
  if ((Get-CommandLineOf -ProcessId $procId) -notlike '*archive-service.mjs*') { return $state }
  $state.listening = $true
  $state.pid = $procId
  try {
    $headers = @{}
    $token = Get-Token
    if ($token) { $headers['x-archive-token'] = $token }
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/status" -Headers $headers -TimeoutSec 5
    $state.healthy = $true
    $state.watching = [bool]$r.watching
    $state.lastScan = $r.lastScan
    $state.totals = $r.totals
    $state.root = $r.root
    $state.lastError = $r.lastError
  } catch {
    $state.httpError = $_.Exception.Message
  }
  return $state
}

function Wait-BackendReady {
  param([int]$Port, [int]$TimeoutSec = 150)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $s = Get-BackendState -Port $Port
    # watching 只有首轮扫描 + 快照写完之后才会为真
    if ($s.healthy -and $s.watching) { return $s }
    Start-Sleep -Milliseconds 800
  }
  return (Get-BackendState -Port $Port)
}

function Write-HiddenLauncher {
  $node = Get-NodeExe
  $ps1  = $PSCommandPath
  $lines = @(
    "' Generated by archive-service.ps1 - do not edit by hand."
    "' Purpose: start the archive backend with a fully hidden window (style 0), so"
    "' that logging on does not flash a black console. Also wraps it so the backend"
    "' keeps its own log file. NOTE: this file is ASCII-only on purpose - wscript"
    "' reads .vbs in the system ANSI code page, so non-ASCII here would garble."
    'Set sh = CreateObject("WScript.Shell")'
    ('sh.CurrentDirectory = "' + $ProjectRoot + '"')
    ('sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & "' + $ps1 + '" & Chr(34) & " -Action run", 0, False')
  )
  Set-Content -LiteralPath $HiddenVbs -Value $lines -Encoding ASCII
  return $HiddenVbs
}

function Test-Elevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Install-ScheduledTaskAutostart {
  $vbs = Write-HiddenLauncher
  $userId = "$env:USERDOMAIN\$env:USERNAME"

  $action = New-ScheduledTaskAction -Execute $WScript -Argument ('"{0}"' -f $vbs) -WorkingDirectory $ProjectRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
  $taskPrincipal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 2) `
    -MultipleInstances IgnoreNew -StartWhenAvailable

  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $taskPrincipal -Settings $settings -Force -ErrorAction Stop `
    -Description '莱茵生命档案 UI 的本地归档后端（127.0.0.1:43117）。登录时后台静默启动，随归档变动自动重建索引。' | Out-Null

  Write-Ok "已注册计划任务 $TaskName（登录触发 / 后台静默 / 失败自动重试 3 次）"
}

function Install-StartupShortcut {
  $vbs = Write-HiddenLauncher
  $dir = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($StartupLnk)
  $lnk.TargetPath = $WScript
  $lnk.Arguments = '"' + $vbs + '"'
  $lnk.WorkingDirectory = $ProjectRoot
  $lnk.WindowStyle = 7
  $lnk.Description = '莱茵生命档案 UI 的本地归档后端（登录时后台静默启动）'
  $lnk.Save()
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)

  Write-Ok "已在「启动」文件夹放置快捷方式：$StartupLnk"
  Write-Info2 '登录后自动在后台静默启动，不弹窗口；删掉这个快捷方式即取消自启。'
}

function Install-Autostart {
  $vbs = Write-HiddenLauncher

  if (Test-Elevated) {
    try {
      Install-ScheduledTaskAutostart
    } catch {
      Write-Warn2 "计划任务注册失败（$($_.Exception.Message)），改用「启动」文件夹。"
      Install-StartupShortcut
    }
  } else {
    Write-Info2 '当前不是管理员会话 —— 计划任务注册会被拒绝，改用「启动」文件夹实现登录自启。'
    Write-Info2 '两者效果相同；想要带「失败自动重试」的计划任务版，请用管理员身份再跑一次 -Action install。'
    Install-StartupShortcut
  }

  if (-not (Test-BackendListening -Port (Get-Port))) {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) { Start-ScheduledTask -TaskName $TaskName }
    else { Start-Process -FilePath $WScript -ArgumentList ('"{0}"' -f $vbs) -WorkingDirectory $ProjectRoot | Out-Null }
    Write-Host '    已立即启动后端，等待首轮扫描（4.5 万条目，十几秒到一分钟）……'
    $state = Wait-BackendReady -Port (Get-Port) -TimeoutSec 300
    if ($state.healthy -and $state.watching) {
      Write-Ok "后端就绪：端口 $(Get-Port)，PID $($state.pid)"
    } else {
      Write-Warn2 "后端尚未就绪，稍后用 -Action status 复查；日志：$LogFile"
    }
  }
}

function Uninstall-Autostart {
  Stop-Backend
  $removed = $false

  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Ok "已删除计划任务 $TaskName"
    $removed = $true
  }
  if (Test-Path -LiteralPath $StartupLnk) {
    Remove-Item -LiteralPath $StartupLnk -Force
    Write-Ok "已删除「启动」文件夹里的快捷方式"
    $removed = $true
  }
  if (-not $removed) { Write-Warn2 '没有找到任何自启项，跳过。' }
  Remove-Item -LiteralPath $HiddenVbs -Force -ErrorAction SilentlyContinue
}

function Start-Backend {
  $port = Get-Port
  if (Test-BackendListening -Port $port) {
    Write-Ok "后端已在运行（端口 $port）"
    return $true
  }
  $other = Get-ListenerProcessId -Port $port
  if ($other -gt 0) {
    throw "端口 $port 已被 PID $other 占用，而它不是归档后端。请先处理冲突。"
  }

  $node = Get-NodeExe
  if (-not (Test-Path -LiteralPath $ServiceJs)) { throw "找不到后端脚本：$ServiceJs" }
  if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Start-ScheduledTask -TaskName $TaskName
  } else {
    $vbs = Write-HiddenLauncher
    Start-Process -FilePath $WScript -ArgumentList ('"{0}"' -f $vbs) -WorkingDirectory $ProjectRoot | Out-Null
  }

  Write-Host '    已拉起后端，等待首轮扫描（4.5 万条目大约十几秒）……'
  $state = Wait-BackendReady -Port $port -TimeoutSec 180
  if ($state.healthy -and $state.watching) {
    Write-Ok "后端就绪：端口 $port，PID $($state.pid)"
    return $true
  }
  Write-Warn2 "后端没有在预期时间内就绪。最近日志：$LogFile"
  if ($state.httpError) { Write-Warn2 "  HTTP：$($state.httpError)" }
  if ($state.lastError) { Write-Warn2 "  快照：$($state.lastError)" }
  return $false
}

function Stop-Backend {
  $port = Get-Port
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }

  $targets = New-Object System.Collections.Generic.List[int]

  $procId = Get-ListenerProcessId -Port $port
  if ($procId -gt 0 -and (Get-CommandLineOf -ProcessId $procId) -like '*archive-service.mjs*') {
    $targets.Add($procId)
  }
  # 兜底：按命令行找漏网的 node / 宿主
  foreach ($p in (Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    $cl = [string]$p.CommandLine
    if (-not $cl) { continue }
    if ($cl -like '*archive-service.mjs*') { $targets.Add([int]$p.ProcessId) }
    elseif ($cl -like '*-Action run*' -and $cl -like '*archive-service.ps1*') { $targets.Add([int]$p.ProcessId) }
    elseif ($cl -like '*archive-service-hidden.vbs*') { $targets.Add([int]$p.ProcessId) }
  }

  $unique = $targets | Sort-Object -Unique
  if ($unique.Count -eq 0) {
    Write-Warn2 '后端本来就没在运行。'
    return
  }
  foreach ($t in $unique) { Stop-Process -Id $t -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 600
  if (Get-ListenerProcessId -Port $port) {
    Write-Warn2 "停止后端口 $port 仍被占用，请手动检查。"
  } else {
    Write-Ok "已停止后端（结束 $($unique.Count) 个进程）"
  }
}

function Show-Status {
  $port = Get-Port
  $cfg = Get-ArchiveConfig
  $state = Get-BackendState -Port $port

  Write-Head '归档后端（数据库）'
  Write-Item '归档根' "$($cfg.root)"
  Write-Item '端口' "$port（仅本机 127.0.0.1）"
  if ($state.listening) {
    Write-Item '进程' "PID $($state.pid) 运行中"
  } else {
    Write-Item '进程' '未运行'
  }
  if ($state.healthy) {
    Write-Item '快照' "已就绪  watching=$($state.watching)"
    if ($state.totals) {
      $gb = [math]::Round($state.totals.bytes / 1GB, 2)
      Write-Item '索引' "$($state.totals.files) 文件 / $($state.totals.dirs) 目录 / $gb GB"
    }
    Write-Item '上次扫描' "$($state.lastScan)"
    if ($state.lastError) { Write-Item '最近错误' "$($state.lastError)" }
  } elseif ($state.listening) {
    Write-Item '接口' "端口在听但 /status 不通：$($state.httpError)"
    Write-Item '提示' '令牌可能是旧的，重启一次后端即可'
  } else {
    Write-Item '接口' '不可达（后端没在跑）'
  }

  $tokenAge = '无令牌文件'
  if (Test-Path -LiteralPath $TokenFile) {
    $t = Get-Item -LiteralPath $TokenFile
    $tokenAge = "$($t.LastWriteTime)（$(($t.Length)) 字节）"
  }
  Write-Item '令牌' $tokenAge

  Write-Head '开机自启'
  $installed = $false

  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    Write-Item '计划任务' "$TaskName  状态=$($task.State)"
    if ($info) { Write-Item '上次结果' "$($info.LastRunTime)  code=$($info.LastTaskResult)" }
    $installed = $true
  }

  if (Test-Path -LiteralPath $StartupLnk) {
    Write-Item '启动快捷方式' $StartupLnk
    $installed = $true
  }

  if ($installed) {
    Write-Ok '已启用：登录时后台静默启动（不弹窗口）'
  } else {
    Write-Warn2 "未安装。执行 `"$($PSCommandPath) -Action install`" 可装上。"
  }
  Write-Host ''
}

function Show-Logs {
  if (-not (Test-Path -LiteralPath $LogFile)) {
    Write-Warn2 "还没有日志：$LogFile"
    return
  }
  Write-Head "后端日志尾部（$LogFile）"
  Get-Content -LiteralPath $LogFile -Tail 30 -Encoding UTF8 | ForEach-Object { Write-Host "    $_" }
  Write-Host ''
}

function Invoke-BackendRun {
  # 计划任务的真正入口：已经在跑就直接退出，避免重复实例抢端口
  $port = Get-Port
  if (Test-BackendListening -Port $port) {
    Write-Host "归档后端已在运行（端口 $port），本次启动跳过。"
    return
  }
  if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
  $node = Get-NodeExe
  Set-Location -LiteralPath $ProjectRoot
  & $node $ServiceJs *> $LogFile
}

switch ($Action) {
  'status'    { Show-Status }
  'logs'      { Show-Logs }
  'install'   { Install-Autostart; Write-Host ''; Show-Status }
  'uninstall' { Uninstall-Autostart }
  'start'     { Start-Backend | Out-Null }
  'stop'      { Stop-Backend }
  'restart'   { Stop-Backend; Start-Sleep -Seconds 1; Start-Backend | Out-Null }
  'ensure'    {
    # 明确给出跨进程可依赖的退出码：0 = 就绪，1 = 没能就绪
    $ok = Start-Backend
    if ($ok) { exit 0 } else { exit 1 }
  }
  'run'       { Invoke-BackendRun }
}
