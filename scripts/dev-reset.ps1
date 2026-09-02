#!/usr/bin/env pwsh
#Requires -Version 7.0
<#!
.SYNOPSIS
  Reset the Xihe local development data safely.

.DESCRIPTION
  Without -Reset this command only reports the database, host storage and
  Sandbox state. With -Reset it backs up the current PostgreSQL database,
  rebuilds the project-local PostgreSQL volume, and moves host workspace
  directories to the Windows Recycle Bin.

  This script is dev-only. It never touches source files, migrations,
  XIHE_RUNTIME_STATE_DIR/device_id, or other Compose projects.

.PARAMETER Reset
  Perform the destructive dev reset after the backup step.
.PARAMETER DryRun
  Only print the current state. This is the default when -Reset is omitted.
#>
param(
  [switch]$Reset,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($Reset -and $DryRun) {
  throw "Use either -Reset or -DryRun, not both."
}

$ProjectRoot = (Resolve-Path "$PSScriptRoot/..").Path
$HostRoot = if ($env:XIHE_WORKSPACE_HOST_ROOT) {
  (Resolve-Path $env:XIHE_WORKSPACE_HOST_ROOT -ErrorAction SilentlyContinue).Path
} else {
  Join-Path $ProjectRoot ".xihe-workspaces"
}
$ComposeFile = Join-Path $ProjectRoot "docker-compose.yml"
$ComposeProject = "a03-xihe"
$RunId = [guid]::NewGuid().ToString()
$BackupRoot = Join-Path $env:TEMP "xihe-dev-reset"

function Write-ResetEvent {
  param([string]$Event, [hashtable]$Fields = @{})

  $logDir = Join-Path $ProjectRoot "logs"
  if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  }
  $payload = @{ timestamp = (Get-Date -Format o); devResetRunId = $RunId; event = $Event } + $Fields
  Add-Content -LiteralPath (Join-Path $logDir "host.log") -Value ($payload | ConvertTo-Json -Compress) -Encoding utf8
}

function Get-WorkspaceEntries {
  if (-not (Test-Path -LiteralPath $HostRoot)) {
    return @()
  }
  return @(Get-ChildItem -LiteralPath $HostRoot -Force)
}

function Get-WorkspaceBytes {
  $entries = @(Get-WorkspaceEntries)
  if ($entries.Count -eq 0) {
    return [int64]0
  }
  $sum = ($entries | ForEach-Object {
      if ($_.PSIsContainer) {
        (Get-ChildItem -LiteralPath $_.FullName -Force -File -Recurse -ErrorAction SilentlyContinue |
          Measure-Object -Property Length -Sum).Sum
      } else {
        $_.Length
      }
    } | Measure-Object -Sum).Sum
  return [int64]($sum ?? 0)
}

function Get-SandboxContainers {
  return @(docker ps -aq --filter "name=xihe-workspace-ws_")
}

function Get-DatabaseCounts {
  $tableQuery = "SELECT COALESCE(to_regclass('public.workspace_execution_specs')::text, ''), COALESCE(to_regclass('public.workspace_assignments')::text, '');"
  $tableOutput = @(docker compose -p $ComposeProject -f $ComposeFile exec -T postgres psql -U xihe -d xihe -At -F '|' -c $tableQuery 2>$null)
  if ($LASTEXITCODE -ne 0 -or $tableOutput.Count -eq 0) {
    return @("database|unavailable")
  }
  $tableNames = $tableOutput[0].Split('|')
  $specTable = if ($tableNames[0].Trim()) { "workspace_execution_specs" } elseif ($tableNames[1].Trim()) { "workspace_assignments" } else { $null }
  if (-not $specTable) {
    return @("database|schema-not-initialized")
  }
  $query = "SELECT 'users', count(*) FROM users UNION ALL SELECT 'workspaces', count(*) FROM workspaces UNION ALL SELECT 'sessions', count(*) FROM sessions UNION ALL SELECT 'messages', count(*) FROM messages UNION ALL SELECT '$specTable', count(*) FROM $specTable;"
  $output = @(docker compose -p $ComposeProject -f $ComposeFile exec -T postgres psql -U xihe -d xihe -At -F '|' -c $query 2>$null)
  if ($LASTEXITCODE -ne 0) {
    return @("database|unavailable")
  }
  return $output | Where-Object { $_ -match '\S' }
}

function Assert-NativePortsFree {
  $ports = @(12630, 12631, 12632, 12633)
  $listeners = @(
    foreach ($port in $ports) {
      Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    }
  )
  if ($listeners.Count -gt 0) {
    $used = ($listeners | ForEach-Object { "$($_.LocalPort)/$($_.OwningProcess)" }) -join ", "
    throw "Native Xihe services are still listening ($used). Stop dev:host before -Reset."
  }
}

function Send-ToRecycleBin {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }
  Add-Type -AssemblyName Microsoft.VisualBasic
  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(
    $Path,
    [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
    [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
}

function Remove-SandboxContainers {
  $containers = @(Get-SandboxContainers)
  foreach ($container in $containers) {
    $id = $container.Trim()
    if ($id) {
      docker rm -f $id | Out-Null
      Write-ResetEvent -Event "container_removed" -Fields @{ containerId = $id; scope = "workspace-sandbox" }
    }
  }
  return $containers.Count
}

function Show-State {
  $entries = @(Get-WorkspaceEntries)
  $containers = @(Get-SandboxContainers)
  Write-Host "=== Xihe dev reset (runId=$RunId) ===" -ForegroundColor Cyan
  Write-Host "project: $ProjectRoot"
  Write-Host "hostRoot: $HostRoot"
  Write-Host "host entries: $($entries.Count); bytes: $(Get-WorkspaceBytes)"
  Write-Host "Sandbox containers: $($containers.Count)"
  Write-Host "database counts:"
  foreach ($line in @(Get-DatabaseCounts)) {
    Write-Host "  $line"
  }
  Write-ResetEvent -Event "dev_reset_dry_run" -Fields @{
    hostRootRef = "XIHE_WORKSPACE_HOST_ROOT"
    hostEntryCount = $entries.Count
    sandboxCount = $containers.Count
  }
}

function Backup-Database {
  if (-not (Test-Path -LiteralPath $BackupRoot)) {
    New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
  }
  $backupPath = Join-Path $BackupRoot "xihe-dev-$RunId.dump"
  $container = (docker compose -p $ComposeProject -f $ComposeFile ps -q postgres).Trim()
  if (-not $container) {
    throw "Xihe PostgreSQL container is not running; cannot create reset backup."
  }
  docker exec $container pg_dump -U xihe -d xihe -Fc -f "/tmp/xihe-dev-$RunId.dump"
  if ($LASTEXITCODE -ne 0) {
    throw "pg_dump failed; reset aborted."
  }
  docker cp "$container`:/tmp/xihe-dev-$RunId.dump" $backupPath | Out-Null
  $backup = Get-Item -LiteralPath $backupPath
  Write-Host "database backup: $($backup.FullName) ($($backup.Length) bytes)" -ForegroundColor Green
  Write-ResetEvent -Event "database_backup_created" -Fields @{ backupPath = $backup.FullName; bytes = $backup.Length }
  return $backup.FullName
}

function Invoke-Reset {
  Assert-NativePortsFree
  $backupPath = Backup-Database
  Write-Host "Resetting project-local PostgreSQL volume..." -ForegroundColor Yellow
  docker compose -p $ComposeProject -f $ComposeFile down --volumes --remove-orphans
  if ($LASTEXITCODE -ne 0) {
    throw "PostgreSQL volume reset failed. Backup: $backupPath"
  }
  docker compose -p $ComposeProject -f $ComposeFile up -d --wait postgres
  if ($LASTEXITCODE -ne 0) {
    throw "PostgreSQL restart failed. Backup: $backupPath"
  }

  if (-not (Test-Path -LiteralPath $HostRoot)) {
    New-Item -ItemType Directory -Path $HostRoot -Force | Out-Null
  }
  $entries = @(Get-WorkspaceEntries)
  foreach ($entry in $entries) {
    if ($entry.PSIsContainer) {
      Send-ToRecycleBin -Path $entry.FullName
    } else {
      Add-Type -AssemblyName Microsoft.VisualBasic
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
        $entry.FullName,
        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
    }
  }
  $removedContainers = Remove-SandboxContainers
  $remainingEntries = @(Get-WorkspaceEntries)
  $remainingContainers = @(Get-SandboxContainers)
  if ($remainingEntries.Count -ne 0 -or $remainingContainers.Count -ne 0) {
    Write-ResetEvent -Event "dev_reset_failed" -Fields @{
      remainingHostEntries = $remainingEntries.Count
      remainingSandboxContainers = $remainingContainers.Count
      backupPath = $backupPath
    }
    throw "Reset verification failed; host entries=$($remainingEntries.Count), containers=$($remainingContainers.Count). Backup: $backupPath"
  }
  Write-ResetEvent -Event "dev_reset_finished" -Fields @{ outcome = "ok"; backupPath = $backupPath; removedContainers = $removedContainers }
  Write-Host "Reset complete. Backup retained at $backupPath" -ForegroundColor Green
  Write-Host "Runtime device identity was not changed." -ForegroundColor Cyan
}

Write-ResetEvent -Event "dev_reset_started" -Fields @{ mode = $(if ($Reset) { "reset" } else { "dry-run" }) }
if ($Reset) {
  Invoke-Reset
} else {
  Show-State
  Write-Host "Dry-run only. Use -Reset to perform the dev reset." -ForegroundColor Yellow
}
