<#
.SYNOPSIS
  介入(仕様変更投下)のタイミングを監視して警報する。判定はするが投下はしない(投下は人間が手で行う)。
.DESCRIPTION
  トリガー(RULES.md §3): 最初の部下の完了通知が PM に到達した5分後。
  ただし開始から25分経過しても通知が来なければ25分時点で投下(フォールバック)。
  このスクリプトはメインセッション JSONL を監視し、上記の投下時刻が来たら音とメッセージで知らせる。
.EXAMPLE
  .\scripts\watch-trigger.ps1 -Arm fable5
#>
param(
  [Parameter(Mandatory)][ValidateSet('fable5','opus48','pilot','smoke')]
  [string]$Arm,
  [int]$FallbackMin = 25,
  [int]$AfterNotifyMin = 5
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$ws   = Join-Path $repo "runs\$Arm\workspace"
$encoded = ($ws -replace '[:\\/]', '-')
$projDir = Join-Path $env:USERPROFILE ".claude\projects\$encoded"

Write-Host "介入トリガー監視 ($Arm): 開始時刻を now とする"
$start = Get-Date
$fired = $false
$firstNotify = $null

function Get-LatestJsonl {
  if (-not (Test-Path $projDir)) { return $null }
  Get-ChildItem $projDir -Filter '*.jsonl' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

while (-not $fired) {
  $f = Get-LatestJsonl
  if ($f) {
    # task-notification(部下の完了通知)を含む行を探す。まだ firstNotify 未確定なら最初の1件の時刻を採用
    if (-not $firstNotify) {
      $hit = Select-String -Path $f.FullName -Pattern 'task-notification|task-notification>' -SimpleMatch -List -ErrorAction SilentlyContinue
      if ($hit) {
        $firstNotify = Get-Date
        Write-Host ("{0:HH:mm:ss}  最初の完了通知を検知。{1}分後({2:HH:mm:ss})に投下" -f (Get-Date), $AfterNotifyMin, (Get-Date).AddMinutes($AfterNotifyMin)) -ForegroundColor Cyan
      }
    }
  }

  $now = Get-Date
  $dueByNotify   = $firstNotify -and ($now -ge $firstNotify.AddMinutes($AfterNotifyMin))
  $dueByFallback = ($now -ge $start.AddMinutes($FallbackMin))

  if ($dueByNotify -or $dueByFallback) {
    $reason = if ($dueByNotify) { "通知+{0}分" -f $AfterNotifyMin } else { "フォールバック {0}分(通知未到達)" -f $FallbackMin }
    [console]::Beep(880,400); [console]::Beep(880,400)
    Write-Host "==================================================" -ForegroundColor Yellow
    Write-Host " 今すぐ介入を投下してください($reason)" -ForegroundColor Yellow
    Write-Host " interventions\spec-change.md の全文を一字一句そのまま貼り付ける" -ForegroundColor Yellow
    Write-Host (" 投下時刻をメモ: {0:yyyy-MM-dd HH:mm:ss}" -f $now) -ForegroundColor Yellow
    Write-Host "==================================================" -ForegroundColor Yellow
    $fired = $true
    break
  }
  Start-Sleep -Seconds 10
}
