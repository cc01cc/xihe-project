# PLAN-229: XH reset-admin — dev 密码重置（对应 EW reset-admin.ts）
# 免重启 upsert admin@xihe.local 密码；缺省随机生成 24 字节 base64url 并打印。
# 用法: pwsh -File scripts/reset-admin.ps1 [-Password <pw>] [-Email <email>]
param(
    [string]$Password,
    [string]$Email = "admin@xihe.local"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot          # A03-xihe/
$cpDir = Join-Path $root "packages/control-plane"
$cpCache = Join-Path $cpDir "target/reset-admin-classpath.txt"

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
