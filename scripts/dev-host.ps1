#!/usr/bin/env pwsh
#Requires -Version 7.0
<#
.SYNOPSIS
  dev:host — Windows native CP/Agent/Runtime/UI + Docker PostgreSQL/Sandbox
  v1 minimal: postgres via Docker, workspaces under XIHE_WORKSPACE_HOST_ROOT

.PARAMETER Check  Preflight only
.PARAMETER Start  Bring up postgres + native services
.PARAMETER Watch  Start + health loop with auto-restart (foreground, Ctrl+C to stop)
.PARAMETER Stop   Tear down postgres + native services (keeps host directories)
#>
param(
  [switch]$Check,
  [switch]$Start,
  [switch]$Watch,
  [switch]$Stop
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path "$PSScriptRoot/..").Path
$HostRoot = if ($env:XIHE_WORKSPACE_HOST_ROOT) { $env:XIHE_WORKSPACE_HOST_ROOT } else { Join-Path $ProjectRoot ".xihe-workspaces" }
$LogDir = Join-Path $ProjectRoot "logs"
$PidDir = Join-Path $ProjectRoot ".tmp/dev-host"
$DevHostLog = Join-Path $LogDir "host.log"
$DevHostRunId = [guid]::NewGuid().ToString()
$Timestamp = { param($e) Get-Date -Format o }

function Write-DevHostEvent {
  param([string]$Event, [hashtable]$Fields = @{})
  $payload = @{ timestamp = (& $Timestamp $null); devHostRunId = $DevHostRunId; event = $Event } + $Fields
  $json = $payload | ConvertTo-Json -Compress
  Add-Content -Path $DevHostLog -Value $json -Encoding utf8
}

function Test-PortFree {
  param([int]$Port)
  try {
    $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    $l.Start(); $l.Stop(); return $true
  } catch { return $false }
}

function Test-Tool {
  param([string]$Name, [string]$Cmd)
  try { $v = Invoke-Expression "$Cmd 2>&1 | Select-Object -First 1"; return "$Name ok: $v" }
  catch { return "$Name MISSING: $_" }
}

function Ensure-Dirs {
  New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
  New-Item -ItemType Directory -Force -Path $PidDir | Out-Null
  New-Item -ItemType Directory -Force -Path $HostRoot | Out-Null
}

function Do-Check {
  Ensure-Dirs
  Write-Host "=== dev:host -Check (runId=$DevHostRunId) ===" -ForegroundColor Cyan
  Write-DevHostEvent -Event "devhost_run_started" -Fields @{ mode = "check"; hostRootRef = "XIHE_WORKSPACE_HOST_ROOT"; hostRoot = $HostRoot }

  $ok = $true
  # Docker
  try {
    $dv = docker version --format '{{.Server.Version}}' 2>&1
    Write-Host "Docker: $dv" -ForegroundColor Green
    Write-DevHostEvent -Event "process_ready" -Fields @{ service = "docker"; outcome = "ok"; detail = "$dv" }
  } catch {
    Write-Host "Docker NOT available: $_" -ForegroundColor Red; $ok = $false
    Write-DevHostEvent -Event "process_failed" -Fields @{ service = "docker"; errorCode = "DOCKER_UNAVAILABLE"; detail = "$_" }
  }
  $npipe = "\\.\pipe\docker_engine"
  if (Test-Path $npipe) { Write-Host "npipe: $npipe exists" -ForegroundColor Green } else { Write-Host "npipe: $npipe NOT found (Docker Desktop may be off)" -ForegroundColor Yellow }

  # Host root
  try {
    $testFile = Join-Path $HostRoot ".devhost-probe"
    Set-Content -Path $testFile -Value "probe" -Encoding utf8 -Force
    Remove-Item $testFile -Force
    $free = (Get-PSDrive -Name ($HostRoot.Substring(0,1)) -ErrorAction SilentlyContinue)
    Write-Host "hostRoot: $HostRoot writable (drive free ~$([math]::Round($free.Free/1GB,1))GB)" -ForegroundColor Green
    Write-DevHostEvent -Event "process_ready" -Fields @{ service = "host_root"; hostRootRef = "XIHE_WORKSPACE_HOST_ROOT"; outcome = "ok" }
  } catch {
    Write-Host "hostRoot NOT writable: $HostRoot : $_" -ForegroundColor Red; $ok = $false
    Write-DevHostEvent -Event "process_failed" -Fields @{ service = "host_root"; errorCode = "STORAGE_UNAVAILABLE"; detail = "$_" }
  }

  # Ports
  foreach ($p in @(12630,12631,12632,12633,12634)) {
    if (Test-PortFree -Port $p) { Write-Host "port $p free" -ForegroundColor Green }
    else { Write-Host "port $p IN USE" -ForegroundColor Yellow; Write-DevHostEvent -Event "process_failed" -Fields @{ service = "port"; port = $p; errorCode = "PORT_IN_USE" } }
  }

  # Tools
  Write-Host (Test-Tool -Name "mise" -Cmd "mise --version")
  Write-Host (Test-Tool -Name "java" -Cmd "java --version")
  Write-Host (Test-Tool -Name "node" -Cmd "node --version")
  Write-Host (Test-Tool -Name "pnpm" -Cmd "pnpm --version")
  Write-Host (Test-Tool -Name "uv" -Cmd "uv --version")
  Write-Host (Test-Tool -Name "cargo" -Cmd "cargo --version")
  Write-Host (Test-Tool -Name "docker compose" -Cmd "docker compose version")

  Write-DevHostEvent -Event "devhost_run_finished" -Fields @{ mode = "check"; outcome = $(if ($ok) { "ok" } else { "degraded" }) }
  if ($ok) { Write-Host "`nCheck OK — run pwsh -File scripts/dev-host.ps1 -Start to bring up" -ForegroundColor Cyan }
  else { Write-Host "`nCheck finished with warnings — fix above before -Start" -ForegroundColor Yellow }
}

function Do-Start {
  Ensure-Dirs
  Write-Host "=== dev:host -Start (runId=$DevHostRunId) ===" -ForegroundColor Cyan
  Write-DevHostEvent -Event "devhost_run_started" -Fields @{ mode = "start"; hostRoot = $HostRoot }

  # hostRoot
  $env:XIHE_WORKSPACE_HOST_ROOT = $HostRoot
  Write-Host "XIHE_WORKSPACE_HOST_ROOT=$HostRoot" -ForegroundColor Green

  # postgres only (dev:host uses Docker PG, not full compose)
  Push-Location $ProjectRoot
  try {
    Write-Host "Starting postgres (docker compose up -d postgres)..." -ForegroundColor Cyan
    docker compose up -d postgres
    if ($LASTEXITCODE -ne 0) { throw "docker compose up postgres failed" }
    Write-DevHostEvent -Event "process_started" -Fields @{ service = "postgres"; outcome = "ok" }

    Write-Host "Waiting for postgres healthy (30s)..." -ForegroundColor Cyan
    $ready = $false
    for ($i=1; $i -le 30; $i++) {
      try {
        $cid = (docker compose ps -q postgres 2>$null).Trim()
        if ($cid) {
          docker exec $cid pg_isready -U xihe -d xihe 2>$null | Out-Null
          if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        }
      } catch {}
      Start-Sleep -Seconds 1
    }
    if (-not $ready) {
      Write-Host "postgres not healthy after 30s (continuing, CP will retry)" -ForegroundColor Yellow
      Write-DevHostEvent -Event "process_failed" -Fields @{ service = "postgres"; errorCode = "POSTGRES_NOT_READY" }
    } else {
      Write-Host "postgres ready" -ForegroundColor Green
      Write-DevHostEvent -Event "process_ready" -Fields @{ service = "postgres"; outcome = "ok" }
    }

    # Start native services as background jobs
    $env:XIHE_ENV = "dev"
    $env:XIHE_CP_PORT = "12631"
    $env:XIHE_CP_DATASOURCE_URL = "jdbc:postgresql://localhost:12634/xihe"
    $env:XIHE_CP_API_TOKEN = "dev-token-not-secure"
    $env:XIHE_AGENT_PORT = "12632"
    $env:XIHE_RUNTIME_PORT = "12633"
    $env:XIHE_CP_URL = "http://localhost:12631"

    Write-Host "`nStarting native services..." -ForegroundColor Cyan

    # CP
    Write-Host "  Starting Control Plane (port 12631)..." -ForegroundColor White
    $mvnPath = (Get-Command mvn -ErrorAction SilentlyContinue).Source
    if ($mvnPath) {
        Start-Process -FilePath $mvnPath -ArgumentList "spring-boot:run" -WorkingDirectory "$ProjectRoot\packages\control-plane" -WindowStyle Minimized
    } else {
        Write-Host "  mvn not found, skipping CP" -ForegroundColor Yellow
    }
    Write-DevHostEvent -Event "process_started" -Fields @{ service = "cp"; outcome = "ok" }

    # Runtime
    Write-Host "  Starting Runtime (port 12633)..." -ForegroundColor White
    $cargoPath = (Get-Command cargo -ErrorAction SilentlyContinue).Source
    if ($cargoPath) {
        Start-Process -FilePath $cargoPath -ArgumentList "run","--bin","xihe-runtime" -WorkingDirectory "$ProjectRoot\packages\runtime" -WindowStyle Minimized
    } else {
        Write-Host "  cargo not found, skipping Runtime" -ForegroundColor Yellow
    }
    Write-DevHostEvent -Event "process_started" -Fields @{ service = "runtime"; outcome = "ok" }

    # Agent
    Write-Host "  Starting Agent (port 12632)..." -ForegroundColor White
    $uvPath = (Get-Command uv -ErrorAction SilentlyContinue).Source
    if ($uvPath) {
        Start-Process -FilePath $uvPath -ArgumentList "run","python","-m","xihe_agent.main" -WorkingDirectory "$ProjectRoot\packages\agent" -WindowStyle Minimized
    } else {
        Write-Host "  uv not found, skipping Agent" -ForegroundColor Yellow
    }
    Write-DevHostEvent -Event "process_started" -Fields @{ service = "agent"; outcome = "ok" }

    # UI
    Write-Host "  Starting UI (port 12630)..." -ForegroundColor White
    $vitePath = Join-Path $ProjectRoot "packages\ui\node_modules\.bin\vite.cmd"
    if (Test-Path $vitePath) {
        Start-Process -FilePath $vitePath -ArgumentList "--port","12630","--mode","dev" -WorkingDirectory "$ProjectRoot\packages\ui" -WindowStyle Minimized
    } else {
        Write-Host "  UI dependencies not installed, skipping UI" -ForegroundColor Yellow
    }
    Write-DevHostEvent -Event "process_started" -Fields @{ service = "ui"; outcome = "ok" }

    Write-Host "`nAll services started. Waiting for readiness..." -ForegroundColor Green
    Start-Sleep -Seconds 10

    # Health checks
    $services = @(
      @{ Name = "CP"; Url = "http://localhost:12631/actuator/health" },
      @{ Name = "Agent"; Url = "http://localhost:12632/internal/v1/agent/health" },
      @{ Name = "Runtime"; Url = "http://localhost:12633/health" },
      @{ Name = "UI"; Url = "http://localhost:12630" }
    )
    foreach ($svc in $services) {
      try {
        $r = Invoke-WebRequest -Uri $svc.Url -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        Write-Host "  $($svc.Name): UP ($($r.StatusCode))" -ForegroundColor Green
      } catch {
        Write-Host "  $($svc.Name): DOWN" -ForegroundColor Yellow
      }
    }

    Write-Host "`nServices started. Use 'mise run dev:host:watch' for auto-restart." -ForegroundColor Cyan
    Write-Host "Or stop with 'mise run dev:host:stop'." -ForegroundColor DarkGray
    Write-DevHostEvent -Event "devhost_run_finished" -Fields @{ mode = "start"; outcome = "ok" }
  } finally { Pop-Location }
}

function Do-Stop {
  Write-Host "=== dev:host -Stop ===" -ForegroundColor Cyan
  Write-DevHostEvent -Event "cleanup_started" -Fields @{ scope = "dev-host" }
  Push-Location $ProjectRoot
  try {
    Write-Host "Stopping postgres (docker compose stop postgres)..." -ForegroundColor Cyan
    docker compose stop postgres 2>$null
    # Do NOT down volumes or remove host directories
    Write-Host "Postgres stopped (volume pgdata kept, hostRoot kept: $HostRoot)" -ForegroundColor Green
  } finally { Pop-Location }

  # Kill any pid files if we ever background native services (v1: none, placeholder)
  if (Test-Path $PidDir) {
    Get-ChildItem $PidDir -Filter "*.pid" -ErrorAction SilentlyContinue | ForEach-Object {
      try {
        $pid = Get-Content $_.FullName -Raw | ForEach-Object { $_.Trim() }
        if ($pid -match '^\d+$') {
          Write-Host "Killing pid $pid from $($_.Name)" -ForegroundColor Yellow
          Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
        }
        Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
      } catch {}
    }
  }
  Write-DevHostEvent -Event "cleanup_finished" -Fields @{ scope = "dev-host"; outcome = "ok" }
  Write-Host "dev:host stopped. Host directories preserved: $HostRoot" -ForegroundColor Green
}

function Test-ServiceHealth {
  param([string]$Name, [string]$Url)
  try {
    $response = Invoke-WebRequest -Uri $Url -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
    return $response.StatusCode -lt 400
  } catch {
    return $false
  }
}

function Start-ServiceProcess {
  param([string]$Name, [string]$Command, [string]$LogPath)
  Write-Host "Starting $Name..." -ForegroundColor Cyan
  $logDir = Split-Path $LogPath -Parent
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
  $process = Start-Process -FilePath "pwsh" -ArgumentList "-NoExit", "-Command", "$Command 2>&1 | Tee-Object -FilePath '$LogPath'" -PassThru -WindowStyle Minimized
  Write-DevHostEvent -Event "process_started" -Fields @{ service = $Name; pid = $process.Id; outcome = "ok" }
  return $process
}

function Do-Watch {
  Ensure-Dirs
  Write-Host "=== dev:host -Watch (health loop + auto-restart) ===" -ForegroundColor Cyan
  Write-Host "Press Ctrl+C to stop" -ForegroundColor DarkGray
  Write-DevHostEvent -Event "devhost_run_started" -Fields @{ mode = "watch"; hostRoot = $HostRoot }

  # Service definitions: Name, HealthUrl, Command, LogPath
  $services = @(
    @{ Name = "control-plane"; HealthUrl = "http://localhost:12631/actuator/health"; Command = "cd $ProjectRoot; mise run dev:cp"; LogPath = Join-Path $LogDir "cp.log" },
    @{ Name = "agent"; HealthUrl = "http://localhost:12632/internal/v1/agent/health"; Command = "cd $ProjectRoot; mise run dev:agent"; LogPath = Join-Path $LogDir "agent.log" },
    @{ Name = "runtime"; HealthUrl = "http://localhost:12633/health"; Command = "cd $ProjectRoot; mise run dev:runtime"; LogPath = Join-Path $LogDir "runtime.log" }
  )

  # Track process PIDs
  $processes = @{}

  # Initial start
  foreach ($svc in $services) {
    $processes[$svc.Name] = Start-ServiceProcess -Name $svc.Name -Command $svc.Command -LogPath $svc.LogPath
    Start-Sleep -Seconds 2
  }

  Write-Host "`nAll services started. Monitoring health every 15s..." -ForegroundColor Green
  Write-DevHostEvent -Event "watch_started" -Fields @{ services = ($services | ForEach-Object { $_.Name }) -join "," }

  # Health loop
  while ($true) {
    Start-Sleep -Seconds 15
    foreach ($svc in $services) {
      $alive = Test-ServiceHealth -Name $svc.Name -Url $svc.HealthUrl
      $proc = $processes[$svc.Name]
      $procAlive = $proc -and -not $proc.HasExited

      if (-not $alive -or -not $procAlive) {
        $reason = if (-not $procAlive) { "process_exited" } else { "health_check_failed" }
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $($svc.Name) is down ($reason), restarting..." -ForegroundColor Yellow
        Write-DevHostEvent -Event "auto_restart" -Fields @{ service = $svc.Name; reason = $reason }

        # Kill stale process if still running
        if ($proc -and -not $proc.HasExited) {
          try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
        }

        # Restart
        $processes[$svc.Name] = Start-ServiceProcess -Name $svc.Name -Command $svc.Command -LogPath $svc.LogPath
        Start-Sleep -Seconds 3
      }
    }
  }
}

if ($Check) { Do-Check; exit 0 }
if ($Stop)  { & docker compose stop postgres; exit $LASTEXITCODE }
if ($Watch) { & mise run dev:host:watch; exit $LASTEXITCODE }
if ($Start) { & mise run dev:host; exit $LASTEXITCODE }

# default: check
Do-Check
