#!/usr/bin/env pwsh
# task-848：run13 收口后处理器（从 one/.tmp/post-run13.ps1 收进耐久落点）。
#
# 与 run-l2-stages.mjs 的关系：
#   - 新流程：分阶段执行器已写 run<N>-results.json（每步含 verdict/cached），本脚本只复用，
#     不重新生成，然后跑 W2 面审计与 W3 判定器。
#   - 旧流程：若只有 run<N>-status.txt，则按旧口径生成 results；每步补 verdict 与 cached=false
#     （W3 判据是 step.verdict !== "PASS" || Number(step.exit) !== 0，缺 verdict 会判 FAIL）。
#
# 用法：
#   pwsh A03-xihe/scripts/post-run13.ps1 [-Run 13] [-WaitMinutes 150] [-OneRoot <dir>] [-EvidenceDir <dir>] [-SkipPostChecks]
param(
  [int]$Run = 13,
  [int]$WaitMinutes = 150,
  [string]$OneRoot = "",
  [string]$EvidenceDir = "",
  [switch]$SkipPostChecks
)

$ErrorActionPreference = 'Continue'
if (-not $OneRoot) {
  $OneRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}
$repo = Join-Path $OneRoot 'A03-xihe'
if (-not $EvidenceDir) {
  $EvidenceDir = Join-Path $OneRoot 'internal\A03-xihe\evidence\2026-11-22-l2-full'
}
$log = Join-Path $EvidenceDir 'post-run13.log'
$statusPath = Join-Path $EvidenceDir "run$Run-status.txt"
$resultsPath = Join-Path $EvidenceDir "run$Run-results.json"

function Log($m) {
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m" | Add-Content -Path $log -Encoding utf8
}

Log "POST13_WAIT run=$Run results=$resultsPath"
$deadline = (Get-Date).AddMinutes($WaitMinutes)
while ((Get-Date) -lt $deadline) {
  if (Test-Path $resultsPath) { break }
  $text = if (Test-Path $statusPath) { Get-Content $statusPath -Raw -Encoding utf8 } else { '' }
  if ($text -match "RUN\d+_DONE|RUN\d+_ABORT") { break }
  Start-Sleep -Seconds 30
}

$head = $null
$steps = @()

if (Test-Path $resultsPath) {
  try {
    $data = Get-Content $resultsPath -Raw -Encoding utf8 | ConvertFrom-Json
  } catch {
    Log "POST13_RESULTS_INVALID 解析失败：$($_.Exception.Message)"
    exit 4
  }
  $head = [string]$data.head
  $steps = @($data.steps)
  Log "POST13_RESULTS_REUSE steps=$($steps.Count) head=$head partial=$($data.partial)"
  if ($data.partial -eq $true) {
    Log 'POST13_RESULT_INVALID 部分跑结果不能作为 W3 证据'
    exit 4
  }
} else {
  $text = if (Test-Path $statusPath) { Get-Content $statusPath -Raw -Encoding utf8 } else { '' }
  if ($text -notmatch 'RUN\d+_DONE|RUN\d+_ABORT') {
    Log 'POST13_TIMEOUT'
    exit 3
  }
  Log 'POST13_RUN13_FINISHED'
  if ($text -match 'RUN\d+_ABORT') {
    Log 'POST13_ABORT'
    exit 4
  }

  $head = ([regex]::Match($text, "RUN\d+_HEAD=([0-9a-f]{40})")).Groups[1].Value
  $steps = @()
  foreach ($line in ($text -split "`r?`n")) {
    $m = [regex]::Match($line, '^(?<name>[a-z\-]+) exit=(?<exit>-?\d+) seconds=(?<sec>[0-9.]+)$')
    if (-not $m.Success) { continue }
    $name = $m.Groups['name'].Value
    $logName = $name
    if ($name -eq 'host') { $name = 'host-e2e' }
    $code = [int]$m.Groups['exit'].Value
    $steps += [ordered]@{
      name    = $name
      exit    = $code
      verdict = $(if ($code -eq 0) { 'PASS' } else { 'FAIL' })
      seconds = [double]$m.Groups['sec'].Value
      cached  = $false
      log     = "internal/A03-xihe/evidence/2026-11-22-l2-full/run$Run-$logName.log"
    }
  }
  $results = [ordered]@{
    task            = 'task-848'
    run             = $Run
    head            = $head
    headNote        = "run$Run legacy: generated from run$Run-status.txt"
    worktreeAtStart = 'unknown'
    steps           = $steps
    generatedBy     = 'A03-xihe/scripts/post-run13.ps1'
  }
  $results | ConvertTo-Json -Depth 6 | Set-Content -Path $resultsPath -Encoding utf8
  Log "POST13_RESULTS_WRITTEN steps=$($steps.Count) head=$head"
}

# W3 硬判据：每步必须有 verdict；缺失即视为无效证据，不能交给判定器当「全绿」。
$missingVerdict = @($steps | Where-Object { -not $_.verdict })
if ($missingVerdict.Count -gt 0) {
  $names = ($missingVerdict | ForEach-Object { $_.name }) -join ','
  Log "POST13_RESULT_INVALID 缺 verdict：$names"
  exit 4
}
if (-not $head) {
  Log 'POST13_RESULT_INVALID 缺 head'
  exit 4
}
$required = @('build', 'test', 'typecheck', 'lint')
$present = @($steps | ForEach-Object { $_.name })
$missingSteps = @($required | Where-Object { $_ -notin $present })
if ($missingSteps.Count -gt 0) {
  Log "POST13_RESULT_INVALID 缺步骤：$($missingSteps -join ',')"
  exit 4
}

$gateFailed = @($steps | Where-Object { $_.name -in @('stack', 'build', 'test', 'typecheck', 'lint') -and [int]$_.exit -ne 0 })
if ($gateFailed.Count -gt 0) {
  Log "POST13_NEEDS_FIX gates=$(($gateFailed | ForEach-Object { $_.name }) -join ',')"
  exit 4
}

if ($SkipPostChecks) {
  Log 'POST13_RESULTS_ONLY skip face-audit / mvp-verify'
  exit 0
}

Log 'POST13_STACK2_STATUS_READ'
& node (Join-Path $repo 'scripts\dev-stack.mjs') status --stack 2 --json *> (Join-Path $EvidenceDir 'post-run13-stack2-status.json')

Log 'POST13_FACE_AUDIT_START'
Set-Location $repo
& node (Join-Path $OneRoot 'internal\A03-xihe\scripts\webui-face-audit.mjs') --evidence-dir 2026-11-22-webui-product-audit *>> $log
$faceExit = $LASTEXITCODE
Set-Location $OneRoot
Log "POST13_FACE_AUDIT exit=$faceExit"

Log 'POST13_MVP_VERIFY_START'
& node (Join-Path $OneRoot 'internal\A03-xihe\scripts\xh-mvp-verify.mjs') --json *>> $log
Log "POST13_MVP_VERIFY exit=$LASTEXITCODE"
Log 'POST13_DONE'
