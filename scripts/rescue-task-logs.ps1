<#
.SYNOPSIS
  バックグラウンドのサブエージェントログ(Temp配下・消える)を退避し続ける。
  ラン開始と同時に別ウィンドウで起動し、ラン終了+退避確認まで止めないこと。
.DESCRIPTION
  Claude Code はメインセッションのログを ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl に、
  バックグラウンドのサブエージェントのログを
  %TEMP%\claude\<encoded-cwd>\<sessionId>\tasks\<agentId>.output に書く。
  後者は一時領域のため、30秒ごとに runs\<arm>\raw\ へコピーして保全する。
.EXAMPLE
  .\scripts\rescue-task-logs.ps1 -Arm fable5
#>
param(
  [Parameter(Mandatory)][ValidateSet('fable5','opus48','pilot','smoke')]
  [string]$Arm,
  [int]$IntervalSec = 30
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$ws   = Join-Path $repo "runs\$Arm\workspace"
if (-not (Test-Path $ws)) { throw "workspace がありません: $ws" }

# cwd のエンコード名(Claude Code の projects/ ディレクトリ名の規則): 区切りを '-' に
$encoded = ($ws -replace '[:\\/]', '-')
$projDir = Join-Path $env:USERPROFILE ".claude\projects\$encoded"
$tempBase = Join-Path $env:TEMP "claude\$encoded"

$dstMain  = Join-Path $repo "runs\$Arm\raw"
$dstTasks = Join-Path $dstMain 'tasks'
New-Item -ItemType Directory -Force $dstTasks | Out-Null

Write-Host "監視開始 (Ctrl+C で停止):"
Write-Host "  projects: $projDir"
Write-Host "  temp    : $tempBase"
Write-Host "  退避先  : $dstMain"

while ($true) {
  try {
    # メインセッション JSONL(最新)
    if (Test-Path $projDir) {
      Get-ChildItem $projDir -Filter '*.jsonl' -ErrorAction SilentlyContinue |
        ForEach-Object { Copy-Item $_.FullName (Join-Path $dstMain $_.Name) -Force }
    }
    # サブエージェントの tasks/*.output
    if (Test-Path $tempBase) {
      Get-ChildItem $tempBase -Recurse -Filter '*.output' -ErrorAction SilentlyContinue |
        ForEach-Object { Copy-Item $_.FullName (Join-Path $dstTasks $_.Name) -Force }
    }
    $n = (Get-ChildItem $dstTasks -Filter '*.output' -ErrorAction SilentlyContinue).Count
    Write-Host ("{0:HH:mm:ss}  退避済み tasks: {1}" -f (Get-Date), $n)
  } catch {
    Write-Warning "退避中のエラー(継続): $_"
  }
  Start-Sleep -Seconds $IntervalSec
}
