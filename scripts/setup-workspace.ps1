<#
.SYNOPSIS
  各アームのラン用 workspace を、両アーム同一の初期状態で組み立てる。
.EXAMPLE
  .\scripts\setup-workspace.ps1 -Arm fable5
  .\scripts\setup-workspace.ps1 -Arm opus48
  # 2つが同一かの確認:
  .\scripts\setup-workspace.ps1 -Verify
#>
param(
  [ValidateSet('fable5','opus48')]
  [string]$Arm,
  [switch]$Verify
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$template = Join-Path $repo 'workspace-template'

function New-ArmWorkspace([string]$arm) {
  $ws = Join-Path $repo "runs\$arm\workspace"
  if (Test-Path $ws) { throw "既に存在します: $ws (各アーム1ラン限り。消す前に確認)" }
  New-Item -ItemType Directory -Force $ws | Out-Null

  # 両アーム同一の初期状態: PM_BRIEF, tasks/, .claude/agents/
  Copy-Item (Join-Path $repo 'PM_BRIEF.md') $ws
  Copy-Item (Join-Path $repo 'tasks') $ws -Recurse
  Copy-Item (Join-Path $template '.claude') $ws -Recurse

  Push-Location $ws
  git init -q
  git add -A
  git -c user.name='yukurash' -c user.email='152368380+yukurash@users.noreply.github.com' commit -q -m 'chore: initial workspace (identical across arms)'
  Pop-Location
  Write-Host "作成: $ws"
}

function Compare-Arms {
  $a = Join-Path $repo 'runs\fable5\workspace'
  $b = Join-Path $repo 'runs\opus48\workspace'
  # .git は除外して初期ファイル群のハッシュを比較
  $ha = Get-ChildItem $a -Recurse -File | Where-Object { $_.FullName -notmatch '\\\.git\\' } | Sort-Object Name |
        ForEach-Object { (Get-FileHash $_ -Algorithm SHA256).Hash } | Out-String
  $hb = Get-ChildItem $b -Recurse -File | Where-Object { $_.FullName -notmatch '\\\.git\\' } | Sort-Object Name |
        ForEach-Object { (Get-FileHash $_ -Algorithm SHA256).Hash } | Out-String
  if ($ha -eq $hb) { Write-Host 'OK: 両アームの初期 workspace はバイト同一' -ForegroundColor Green }
  else { Write-Host 'NG: 差分あり。ランを開始しないこと' -ForegroundColor Red }
}

if ($Verify) { Compare-Arms }
elseif ($Arm) { New-ArmWorkspace $Arm }
else { Write-Host '使い方: -Arm fable5|opus48 で作成、-Verify で同一性確認' }
