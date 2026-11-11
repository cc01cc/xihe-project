# PLAN-229: XH reset-admin — dev 密码重置（对应 EW reset-admin.ts）
# 只改密码、不自建账号（用户行不存在 ⇒ 显式失败 exit 3，见 BL-523）；缺省随机生成 24 字节 base64url 并打印。
# 用法: pwsh -File scripts/reset-admin.ps1 [-Password <pw>] [-Email <email>] [-StackId stack-N] [-DryRun]
#   BL-523/安全: 密码改走 **stdin 或 env XIHE_RESET_ADMIN_PASSWORD**（优先级高于 -Password）；
#   -Password 保留但废弃（wrapper 也会把它转成 env，不再进 argv）。
#   PLAN-0547/BL-103: -StackId 参数优先；缺省回退 XIHE_STACK_ID env，再缺省 stack-1。
#   非缺省栈经 node scripts/stack-run.mjs env-json 派生 DSN（只填空缺，不覆盖 --url/env）。
param(
    [string]$Password,
    [string]$Email = "admin@xihe.local",
    [string]$StackId,
    [switch]$DryRun,
    # PLAN-0770 M4：成功后把生效值写回 `.local/dev/admin-password`。
    # **默认关闭**，只有操作员显式重置（`mise run reset-admin`）才打开 —— 因为 `dev-stack`
    # 起栈时的 upsert 也走这个 wrapper，若默认开启就等于在**每次 start** 里把 env 值
    # 材料化进文件（"哪份是真相"被静默改写），这件事仍待用户裁定（PLAN-0770 INV-1 选项 A）。
    [switch]$WriteBack
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
# BL-523: 密码不进 argv（进程表/shell 历史可见）。-Password 仅为兼容保留，改为经 env 传给 java；
# 优先级与 java 侧一致：stdin > env > --password（后者已废弃、wrapper 不再使用）。
#
# PLAN-0770 M4：**没有显式密码时**，不再让 java 自己随机生成（那样这把钥匙只存在于一次输出里，
# 下一次 reset 就漂了）——改由 `lib/dev-admin-password.mjs --ensure` 按单一优先级链解析
# （B′：OS env → 持久文件 → .env 链（仅首次种子）→ 生成）并落盘到 `<checkout>/.local/dev/admin-password`
# （只有最后一层「生成」会写盘；`.env` 链命中时**不**材料化 —— 用户裁定，见 PLAN-0770 D3）。
$resolvedPassword = $null
$passwordSource = "unknown"
if ($Password) {
    Write-Warning "[reset-admin] -Password 已废弃（明文进 shell 历史）；已改为经 env 传递，请改用 stdin 或 XIHE_RESET_ADMIN_PASSWORD"
    $resolvedPassword = $Password
    $passwordSource = "argv"
} elseif ($env:XIHE_RESET_ADMIN_PASSWORD) {
    $resolvedPassword = $env:XIHE_RESET_ADMIN_PASSWORD.Trim()
    $passwordSource = "env"
} elseif ($DryRun) {
    # 只读观察：dry-run 不得解析出值、更不得落盘（读命令无副作用）。
    # java 侧那条 "password-source = generated" 只表示 wrapper 没传值，**不代表**真会随机生成；
    # 真正的来源由单源链决定 ⇒ 在 java 之后补一条权威行（读的人最后看到的是它）。
    $prevRoot = $env:XIHE_CHECKOUT_ROOT
    $env:XIHE_CHECKOUT_ROOT = $root
    try {
        $dryDesc = (node (Join-Path $root "scripts/lib/dev-admin-password.mjs") --describe) | ConvertFrom-Json
        $passwordSource = "single-source:" + $dryDesc.source
    }
    catch {
        $dryDesc = $null
        Write-Warning "[reset-admin] dry-run 无法读取单源解析结果（--describe 失败）：$($_.Exception.Message)"
    }
    finally {
        if ($null -eq $prevRoot) { Remove-Item Env:XIHE_CHECKOUT_ROOT -ErrorAction SilentlyContinue } else { $env:XIHE_CHECKOUT_ROOT = $prevRoot }
    }
} elseif (-not $DryRun) {
    $resolvedPassword = (node (Join-Path $root "scripts/lib/dev-admin-password.mjs") --ensure)
    if ($LASTEXITCODE -ne 0 -or -not $resolvedPassword) {
        Write-Error "[reset-admin] 解析 dev 管理员密码失败（--ensure 非 0）"
        exit 2
    }
    $resolvedPassword = $resolvedPassword.Trim()
    $passwordSource = "single-source"
}
if ($resolvedPassword) { $env:XIHE_RESET_ADMIN_PASSWORD = $resolvedPassword }
if ($DryRun) { $javaArgs += "--dry-run" }

java @javaArgs
if ($LASTEXITCODE -ne 0) { Write-Error "java 执行失败 (exit=$LASTEXITCODE)"; exit $LASTEXITCODE }

# java 的 dry-run 只报它自己看到的输入（没传值 ⇒ generated），会误导读者以为这次会随机生成密码。
# 真正执行的来源是单源链，因此在这一行之前不解释、在这一行之后补权威结论。
if ($DryRun -and $dryDesc) {
    Write-Host ("[reset-admin] dry-run: 实际来源 source={0} hasFile={1}（上面 java 的 generated 只表示未传值，本轮不会生成）；值不打印" -f $dryDesc.source, $dryDesc.hasFile)
}

# PLAN-0770 M4：**成功后**同批写回持久文件，让「DB 里的密码」与「checkout 的单源文件」不漂。
# 只在**显式 -WriteBack**、成功、且非 DryRun 时写；失败路径不动现有文件。值经 stdin 传给
# helper（不进 argv），只打印路径。默认不写：dev-stack 的起栈 upsert 也走本 wrapper，
# 默认写回等于把「每次 start 都材料化」偷偷落地（用户已裁定 B′：文件即真相、env 链只做种子，
# 且**不做** materialize ⇒ 起栈路径不写回）。
if ($WriteBack -and -not $DryRun -and $resolvedPassword) {
    $written = $resolvedPassword | node (Join-Path $root "scripts/lib/dev-admin-password.mjs") --write-stdin
    if ($LASTEXITCODE -eq 0 -and $written) {
        Write-Host "[reset-admin] written=.local/dev/admin-password (source=$passwordSource；值不打印)"
    }
    else {
        Write-Warning "[reset-admin] 写回 .local/dev/admin-password 失败（DB 已更新，文件未同步 —— 下次 start 会以现有来源为准）"
    }
}
