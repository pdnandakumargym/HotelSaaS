<#
.SYNOPSIS
  StaySync local setup for Windows: checks/installs Node.js LTS and Docker Desktop,
  then installs dependencies, starts PostgreSQL, applies migrations and seeds demo data.

.DESCRIPTION
  Run from the repository root in PowerShell:

      Set-ExecutionPolicy -Scope Process Bypass
      .\scripts\setup-windows.ps1

  Installing Node.js or Docker Desktop needs an elevated (Run as administrator) PowerShell.
  The script asks before installing anything. Re-running it is safe.

.PARAMETER CheckOnly
  Only report what is installed; change nothing.

.PARAMETER SkipProject
  Install/check prerequisites only; skip npm install, database and seed steps.

.PARAMETER Yes
  Do not prompt before installing prerequisites.
#>
[CmdletBinding()]
param(
  [switch]$CheckOnly,
  [switch]$SkipProject,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$MinNode22 = [version]'22.22.3'
$MinNode24 = [version]'24.15.0'

function Write-Step($msg)  { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "    [ok] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    [!]  $msg" -ForegroundColor Yellow }
function Write-Bad($msg)   { Write-Host "    [x]  $msg" -ForegroundColor Red }

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Confirm-Action($question) {
  if ($Yes) { return $true }
  $answer = Read-Host "    $question [y/N]"
  return ($answer -match '^(y|yes)$')
}

function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Get-NodeVersion {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return $null }
  $raw = (& node -v) 2>$null
  if ($raw -match '^v(\d+\.\d+\.\d+)') { return [version]$Matches[1] }
  return $null
}

function Test-NodeSupported([version]$v) {
  if (-not $v) { return $false }
  if ($v.Major -eq 22) { return $v -ge $MinNode22 }
  if ($v.Major -eq 24) { return $v -ge $MinNode24 }
  return $v.Major -ge 26
}

function Test-Winget {
  return [bool](Get-Command winget -ErrorAction SilentlyContinue)
}

function Invoke-Winget([string]$id, [string]$name) {
  if (-not (Test-Winget)) {
    Write-Bad "winget is not available. Install '$name' manually, then re-run this script."
    return $false
  }
  if (-not (Test-Admin)) {
    Write-Bad "Installing $name needs an elevated PowerShell (Run as administrator)."
    return $false
  }
  if (-not (Confirm-Action "Install $name with winget (package $id)?")) {
    Write-Warn2 "Skipped installing $name."
    return $false
  }
  & winget install --id $id --exact --source winget --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) {
    Write-Bad "winget exited with code $LASTEXITCODE while installing $name."
    return $false
  }
  Update-SessionPath
  return $true
}

# ---------------------------------------------------------------------------
Write-Step 'Checking Node.js'
$nodeVersion = Get-NodeVersion
if (Test-NodeSupported $nodeVersion) {
  Write-Ok "Node.js $nodeVersion (npm $(& npm -v))"
} else {
  if ($nodeVersion) { Write-Warn2 "Node.js $nodeVersion is not supported. Need 24.15+ (LTS) or 22.22.3+." }
  else { Write-Warn2 'Node.js is not installed.' }
  if (-not $CheckOnly) {
    if (Invoke-Winget 'OpenJS.NodeJS.LTS' 'Node.js LTS') {
      $nodeVersion = Get-NodeVersion
      if (Test-NodeSupported $nodeVersion) { Write-Ok "Node.js $nodeVersion installed" }
      else { Write-Warn2 'Node.js installed; open a NEW PowerShell window so PATH updates, then re-run.' }
    }
  }
}

# ---------------------------------------------------------------------------
Write-Step 'Checking Docker Desktop'
$dockerCli = Get-Command docker -ErrorAction SilentlyContinue
if (-not $dockerCli) {
  Write-Warn2 'Docker is not installed.'
  if (-not $CheckOnly) {
    Write-Step 'Checking WSL 2 (required by Docker Desktop)'
    $wslOk = $false
    try { & wsl.exe --status *> $null; $wslOk = ($LASTEXITCODE -eq 0) } catch { $wslOk = $false }
    if ($wslOk) { Write-Ok 'WSL is available' }
    else {
      Write-Warn2 'WSL 2 is not set up. In an elevated PowerShell run:  wsl --install   then restart Windows.'
    }
    if (Invoke-Winget 'Docker.DockerDesktop' 'Docker Desktop') {
      Write-Warn2 'Docker Desktop installed. Sign out/in (or restart), start Docker Desktop once and accept its terms, then re-run this script.'
      $SkipProject = $true
    }
  }
} else {
  & docker info *> $null
  if ($LASTEXITCODE -eq 0) {
    Write-Ok "Docker $((& docker version --format '{{.Server.Version}}') 2>$null) is running"
  } else {
    Write-Warn2 'Docker is installed but the engine is not running. Start Docker Desktop and wait until it says "Engine running".'
    if (-not $CheckOnly) { $SkipProject = $true }
  }
}

if ($CheckOnly) { Write-Host "`nCheck complete (no changes made)."; exit 0 }
if ($SkipProject) { Write-Host "`nPrerequisite step finished. Re-run this script when Node.js and Docker are ready."; exit 0 }
if (-not (Test-NodeSupported (Get-NodeVersion))) { Write-Bad 'A supported Node.js is required to continue.'; exit 1 }

# ---------------------------------------------------------------------------
Set-Location $RepoRoot

function New-RandomSecret([int]$bytes = 24) {
  $buf = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buf)
  return ([Convert]::ToBase64String($buf) -replace '[+/=]', '')
}

Write-Step 'Creating local environment files (never committed)'
$infraEnv = Join-Path $RepoRoot 'infra\.env'
$apiEnv = Join-Path $RepoRoot 'apps\api\.env'
if (-not (Test-Path $infraEnv)) {
  $lines = Get-Content (Join-Path $RepoRoot 'infra\.env.example')
  $lines = $lines -replace '^POSTGRES_PASSWORD=.*$', "POSTGRES_PASSWORD=$(New-RandomSecret)"
  $lines = $lines -replace '^APP_DB_PASSWORD=.*$', "APP_DB_PASSWORD=$(New-RandomSecret)"
  $lines | Set-Content -Encoding ascii $infraEnv
  Write-Ok 'infra\.env created with random database passwords'
} else { Write-Ok 'infra\.env already exists (kept)' }

function Get-EnvValue($file, $name) {
  $line = Get-Content $file | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
  if ($line) { return ($line -replace "^$name=", '').Trim() } else { return '' }
}
$pgPassword = Get-EnvValue $infraEnv 'POSTGRES_PASSWORD'
$appPassword = Get-EnvValue $infraEnv 'APP_DB_PASSWORD'
if (-not $appPassword) {
  # infra\.env from Milestone 1 had no app role password yet
  $appPassword = New-RandomSecret
  Add-Content -Encoding ascii $infraEnv "APP_DB_PASSWORD=$appPassword"
  Write-Ok 'Added APP_DB_PASSWORD to infra\.env'
}

if (-not (Test-Path $apiEnv)) {
  $buf = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buf)
  $dataKey = [Convert]::ToBase64String($buf)
  (Get-Content (Join-Path $RepoRoot 'apps\api\.env.example')) `
    -replace 'change-me-local-only', $pgPassword `
    -replace 'change-me-app-password', $appPassword `
    -replace '^DATA_ENCRYPTION_KEY=.*$', "DATA_ENCRYPTION_KEY=$dataKey" |
    Set-Content -Encoding ascii $apiEnv
  Write-Ok 'apps\api\.env created (database URLs and a random DATA_ENCRYPTION_KEY)'
} else {
  Write-Ok 'apps\api\.env already exists (kept).'
  if (-not (Get-EnvValue $apiEnv 'DATA_ENCRYPTION_KEY')) {
    Write-Warn2 'apps\api\.env has no DATA_ENCRYPTION_KEY (new in Milestone 2). Delete apps\api\.env and re-run this script, or add the Milestone 2 settings from apps\api\.env.example.'
  }
}

function Set-EnvValue($file, $name, $value) {
  $found = $false
  $lines = @(Get-Content $file | ForEach-Object {
    if ($_ -match "^$name=") { $found = $true; "$name=$value" } else { $_ }
  })
  if (-not $found) { $lines += "$name=$value" }
  $lines | Set-Content -Encoding ascii $file
}

# Keep the database URLs in apps\api\.env in step with infra\.env (single source of truth for
# user names, passwords, database name and port). Other settings in apps\api\.env are kept.
Write-Step 'Checking database connection settings in apps\api\.env'
$pgUser = Get-EnvValue $infraEnv 'POSTGRES_USER'; if (-not $pgUser) { $pgUser = 'staysync' }
$pgDb = Get-EnvValue $infraEnv 'POSTGRES_DB'; if (-not $pgDb) { $pgDb = 'staysync' }
$urlPort = Get-EnvValue $infraEnv 'POSTGRES_PORT'; if (-not $urlPort) { $urlPort = '5432' }
if ($pgUser -notmatch '^[a-z_][a-z0-9_]*$' -or $pgDb -notmatch '^[a-z_][a-z0-9_]*$') { Write-Bad 'POSTGRES_USER and POSTGRES_DB in infra\.env must be lower-case letters, digits or _.'; exit 1 }
foreach ($secret in @($pgPassword, $appPassword)) {
  if ($secret -notmatch '^[A-Za-z0-9]{16,}$') { Write-Bad 'Database passwords in infra\.env must be at least 16 letters/digits.'; exit 1 }
}
$wantedUrls = [ordered]@{
  'DATABASE_URL'                = "postgresql://staysync_app:${appPassword}@localhost:${urlPort}/${pgDb}?schema=public"
  'MIGRATION_DATABASE_URL'      = "postgresql://${pgUser}:${pgPassword}@localhost:${urlPort}/${pgDb}?schema=public"
  'TEST_DATABASE_URL'           = "postgresql://staysync_app:${appPassword}@localhost:${urlPort}/${pgDb}_test?schema=public"
  'TEST_MIGRATION_DATABASE_URL' = "postgresql://${pgUser}:${pgPassword}@localhost:${urlPort}/${pgDb}_test?schema=public"
}
$fixedUrls = @()
foreach ($key in $wantedUrls.Keys) {
  if ((Get-EnvValue $apiEnv $key) -ne $wantedUrls[$key]) { Set-EnvValue $apiEnv $key $wantedUrls[$key]; $fixedUrls += $key }
}
if ($fixedUrls.Count) { Write-Warn2 ("Repaired " + ($fixedUrls -join ', ') + ' to match infra\.env') } else { Write-Ok 'Database URLs match infra\.env' }

function Get-ExcludedPortRanges {
  # Windows (Hyper-V / WSL / WinNAT) can reserve port ranges; binding inside them fails with "access forbidden".
  $ranges = @()
  $out = & netsh interface ipv4 show excludedportrange protocol=tcp 2>$null
  foreach ($line in $out) {
    if ($line -match '^\s*(\d+)\s+(\d+)') { $ranges += ,@([int]$Matches[1], [int]$Matches[2]) }
  }
  return ,$ranges
}

function Test-PortFree([int]$port, $excluded) {
  foreach ($r in $excluded) { if ($port -ge $r[0] -and $port -le $r[1]) { return $false } }
  $listening = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
  return -not $listening
}

Write-Step 'Choosing a free port for PostgreSQL'
$currentPort = Get-EnvValue $infraEnv 'POSTGRES_PORT'
if (-not $currentPort) { $currentPort = '5432' }
$pgRunning = (& docker compose -f infra/docker-compose.yml ps -q postgres 2>$null)
if ($pgRunning) {
  Write-Ok "PostgreSQL container already running on port $currentPort"
} else {
  $excluded = Get-ExcludedPortRanges
  $chosen = $null
  foreach ($candidate in @([int]$currentPort, 5432, 55432, 15432, 25432, 45432)) {
    if (Test-PortFree $candidate $excluded) { $chosen = $candidate; break }
  }
  if (-not $chosen) { Write-Bad 'No free port found for PostgreSQL. Set POSTGRES_PORT in infra\.env manually.'; exit 1 }
  if ("$chosen" -ne "$currentPort") {
    (Get-Content $infraEnv) -replace '^POSTGRES_PORT=.*$', "POSTGRES_PORT=$chosen" | Set-Content -Encoding ascii $infraEnv
    (Get-Content $apiEnv) -replace "localhost:$currentPort/", "localhost:$chosen/" | Set-Content -Encoding ascii $apiEnv
    Write-Warn2 "Port $currentPort is busy or reserved by Windows; using $chosen (infra\.env and apps\api\.env updated)"
  } else {
    Write-Ok "Port $chosen is free"
  }
}
$pgPort = Get-EnvValue $infraEnv 'POSTGRES_PORT'

Write-Step 'Installing npm dependencies (this can take a few minutes)'
& npm install
if ($LASTEXITCODE -ne 0) { Write-Bad 'npm install failed'; exit 1 }

Write-Step 'Starting PostgreSQL and Mailpit (Docker Compose)'
& docker compose -f infra/docker-compose.yml up -d --wait
if ($LASTEXITCODE -ne 0) { Write-Bad 'docker compose failed. Is Docker Desktop running?'; exit 1 }
Write-Ok "PostgreSQL on 127.0.0.1:$pgPort, Mailpit UI on http://localhost:8025"

Write-Step 'Ensuring the database owner password matches infra\.env'
# Inside the container psql connects over the local socket (no password needed), so this also
# repairs a database volume created earlier with a different password.
& docker compose -f infra/docker-compose.yml exec -T postgres psql -v ON_ERROR_STOP=1 -U $pgUser -d postgres -q -c "ALTER ROLE $pgUser WITH PASSWORD '$pgPassword'"
if ($LASTEXITCODE -ne 0) { Write-Bad "Could not update the password of database role $pgUser"; exit 1 }
Write-Ok "Role $pgUser ready"

Write-Step 'Ensuring the test database and the least-privilege API role exist'
$hasTestDb = (& docker compose -f infra/docker-compose.yml exec -T postgres psql -U $pgUser -d $pgDb -tAc "SELECT 1 FROM pg_database WHERE datname='${pgDb}_test'")
if ("$hasTestDb".Trim() -ne '1') {
  & docker compose -f infra/docker-compose.yml exec -T postgres createdb -U $pgUser "${pgDb}_test"
}
foreach ($db in @($pgDb, "${pgDb}_test")) {
  & docker compose -f infra/docker-compose.yml exec -T postgres psql -v ON_ERROR_STOP=1 -v "app_password=$appPassword" -U $pgUser -d $db -q -f /staysync/app-role.sql
  if ($LASTEXITCODE -ne 0) { Write-Bad "Could not set up the staysync_app role in $db"; exit 1 }
}
Write-Ok 'staysync_app role ready'

Write-Step 'Applying database migrations'
& npm run db:deploy
if ($LASTEXITCODE -ne 0) { Write-Bad 'Migrations failed'; exit 1 }

Write-Step 'Seeding clearly-fake demo data'
& npm run db:seed
if ($LASTEXITCODE -ne 0) { Write-Bad 'Seeding failed'; exit 1 }

Write-Host ''
Write-Host 'Setup complete.' -ForegroundColor Green
Write-Host '  Start everything:   npm run dev'
Write-Host '  Web app:            http://localhost:4200'
Write-Host '  API health:         http://localhost:3000/api/v1/health/ready'
Write-Host '  API docs:           http://localhost:3000/api/docs'
Write-Host '  Run all checks:     npm run check'
Write-Host ''
Write-Host 'Create your first platform administrator (prints a one-time password; 2FA setup is required at first sign-in):'
Write-Host '  npm run admin:create -- --email you@example.com --name "Your Name"'
