# PLAN-229: XH reset-admin — dev 密码重置（对应 EW reset-admin.ts）
# 免重启 upsert admin@xihe.local 密码；缺省随机生成 24 字节 base64url 并打印。
# 用法: pwsh -File scripts/reset-admin.ps1 [-Password <pw>] [-Email <email>] [-StackId stack-N]
#   PLAN-0547/BL-103: -StackId 参数优先；缺省回退 XIHE_STACK_ID env，再缺省 stack-1。
#   非缺省栈经 node scripts/stack-run.mjs env-json 派生 DSN（只填空缺，不覆盖 --url/env）。
param(
    [string]$Password,
    [string]$Email = "admin@xihe.local",
    [string]$StackId
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot          # A03-xihe/
$cpDir = Join-Path $root "packages/control-plane"
$cpCache = Join-Path $cpDir "target/reset-admin-classpath.txt"

# PLAN-0547/BL-103: 目标栈解析（-StackId > XIHE_STACK_ID env > stack-1 缺省）。
# 非缺省栈时经 stack-run env-json 派生端口/库名/DSN（workspace SSOT，不自造派生），
# 只填空缺：调用方显式设置的 XIHE_CP_DATASOURCE_URL / XIHE_PG_PORT / POSTGRES_DB 不被覆盖。
$effectiveStack = if ($StackId) { $StackId } elseif ($env:XIHE_STACK_ID) { $env:XIHE_STACK_ID } else { "stack-1" }
if ($effectiveStack -ne "stack-1") {
    Write-Host "[reset-admin] stack=$effectiveStack （经 stack-run env-json 派生目标库）"
    $derivedJson = node (Join-Path $root "scripts/stack-run.mjs") env-json --stack $effectiveStack
    if ($LASTEXITCODE -ne 0) { Write-Error "stack-run env-json 失败（非法或未登记栈？）"; exit 2 }
    $derived = $derivedJson | ConvertFrom-Json
    $envMap = $derived.env
    if (-not $env:XIHE_PG_PORT -and $envMap.XIHE_PG_PORT) { $env:XIHE_PG_PORT = $envMap.XIHE_PG_PORT }
    if (-not $env:POSTGRES_DB -and $envMap.POSTGRES_DB) { $env:POSTGRES_DB = $envMap.POSTGRES_DB }
    if (-not $env:XIHE_CP_DATASOURCE_URL -and $envMap.XIHE_CP_DATASOURCE_URL) { $env:XIHE_CP_DATASOURCE_URL = $envMap.XIHE_CP_DATASOURCE_URL }
}

# 导出并缓存 CP 运行时 classpath（spring-security-crypto + postgresql 等）
if (-not (Test-Path $cpCache) -or (Get-Item $cpCache).LastWriteTime -lt (Get-Item (Join-Path $cpDir "pom.xml")).LastWriteTime) {
    Write-Host "[reset-admin] 导出 maven classpath ..."
    Push-Location $cpDir
    try {
        mvn -q dependency:build-classpath "-Dmdep.outputFile=target/reset-admin-classpath.txt"
        if ($LASTEXITCODE -ne 0) { Write-Error "classpath 导出失败"; exit 1 }
    }
    finally {
        Pop-Location
    }
}
$classpath = (Get-Content $cpCache -Raw).Trim()

$javaArgs = @("--class-path=$classpath", (Join-Path $cpDir "scripts/ResetAdmin.java"), "--email", $Email)
if ($Password) { $javaArgs += @("--password", $Password) }

java @javaArgs
if ($LASTEXITCODE -ne 0) { Write-Error "java 执行失败 (exit=$LASTEXITCODE)"; exit $LASTEXITCODE }
