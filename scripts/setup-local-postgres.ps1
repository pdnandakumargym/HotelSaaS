<#
.SYNOPSIS
  Sets up StaySync on a locally installed PostgreSQL (no Docker): creates the roles and
  databases, writes the connection strings to apps\api\.env, creates the tables
  (Prisma migrations) and loads fake demo data.

.DESCRIPTION
  Run from the repository root in PowerShell:

      Set-ExecutionPolicy -Scope Process Bypass
      .\scripts\setup-local-postgres.ps1

  It asks once for the password of the PostgreSQL superuser ("postgres") that you chose
  when installing PostgreSQL. That password is only used while the script runs and is not saved.

  Creates (re-running is safe):
    role     staysync       owns the schema, runs migrations (not a superuser)
    role     staysync_app   least-privilege role the API connects as (row-level security applies)
    database staysync       development database
    database staysync_test  used only by integration tests

.PARAMETER PgHost
  PostgreSQL host. Default: localhost

.PARAMETER Port
  PostgreSQL port. Default: 5432

.PARAMETER SuperUser
  PostgreSQL superuser. Default: postgres

.PARAMETER SkipSeed
  Create databases and tables but do not load demo data.
#>
[CmdletBinding()]
param(
  [string]$PgHost = 'localhost',
  [int]$Port = 5432,
  [string]$SuperUser = 'postgres',
  [switch]$SkipSeed
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$ApiDir = Join-Path $RepoRoot 'apps\api'
$ApiEnv = Join-Path $ApiDir '.env'
$AppRoleSql = Join-Path $RepoRoot 'infra\postgres\app-role.sql'
$DbName = 'staysync'
$TestDbName = 'staysync_test'

function Write-Step($msg)  { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "    [ok] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    [!]  $msg" -ForegroundColor Yellow }
function Write-Bad($msg)   { Write-Host "    [x]  $msg" -ForegroundColor Red }

function New-Secret([int]$bytes = 18) {
  $buf = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buf)
  return (($buf | ForEach-Object { $_.ToString('x2') }) -join '')   # hex: safe inside URLs
}

function Get-EnvValue($file, $key) {
  if (-not (Test-Path $file)) { return $null }
  $line = Get-Content $file | Where-Object { $_ -match "^\s*$key\s*=" } | Select-Object -First 1
  if ($line) { return ($line -split '=', 2)[1].Trim() }
  return $null
}

function Set-EnvValue($file, $key, $value) {
  $lines = @(Get-Content $file)
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^\s*#?\s*$key\s*=") { $lines[$i] = "$key=$value"; $found = $true; break }
  }
  if (-not $found) { $lines += "$key=$value" }
  Set-Content -Path $file -Value $lines -Encoding ascii
}

function Find-Psql {
  $cmd = Get-Command psql -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\psql.exe' -ErrorAction SilentlyContinue |
    Sort-Object { [int]($_.Directory.Parent.Name -replace '[^\d].*$', '') } -Descending
  if ($candidates) { return $candidates[0].FullName }
  return $null
}

# Runs SQL (from a string piped to stdin, or a file) as the superuser.
function Invoke-Psql {
  param([string]$Database, [string]$Sql, [string]$File, [hashtable]$Vars = @{})
  $psqlArgs = @('-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', $PgHost, '-p', "$Port", '-U', $SuperUser, '-d', $Database)
  foreach ($k in $Vars.Keys) { $psqlArgs += @('-v', "$k=$($Vars[$k])") }
  # Windows PowerShell turns native stderr into errors under 'Stop'; check the exit code instead.
  $ErrorActionPreference = 'Continue'
  if ($File) { $out = & $script:Psql @psqlArgs -f $File 2>&1 }
  else       { $out = $Sql | & $script:Psql @psqlArgs -f - 2>&1 }
  $ErrorActionPreference = 'Stop'
  if ($LASTEXITCODE -ne 0) {
    $out | ForEach-Object { Write-Bad "$_" }
    throw "psql failed on database '$Database'"
  }
}

# ---------------------------------------------------------------------------------------
Write-Step 'Finding PostgreSQL (psql)'
$script:Psql = Find-Psql
if (-not $script:Psql) {
  Write-Bad 'psql.exe not found. Add "C:\Program Files\PostgreSQL\<version>\bin" to PATH and re-run.'
  exit 1
}
Write-Ok $script:Psql

Write-Step "Connecting to PostgreSQL at ${PgHost}:$Port as '$SuperUser'"
$secure = Read-Host "    Password for PostgreSQL user '$SuperUser'" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
$env:PGOPTIONS = '-c client_min_messages=warning'

try {
  $ErrorActionPreference = 'Continue'
  $version = & $script:Psql -X -t -A -h $PgHost -p $Port -U $SuperUser -d postgres -c 'SHOW server_version' 2>&1
  $ErrorActionPreference = 'Stop'
  if ($LASTEXITCODE -ne 0) { Write-Bad "$version"; throw 'Could not connect. Check that the PostgreSQL service is running and the password is correct.' }
  Write-Ok "PostgreSQL $version"

  # Reuse passwords already in apps\api\.env so re-running does not break an existing setup.
  $ownerPassword = $null; $appPassword = $null
  $mig = Get-EnvValue $ApiEnv 'MIGRATION_DATABASE_URL'
  $app = Get-EnvValue $ApiEnv 'DATABASE_URL'
  if ($mig -match '^postgresql://staysync:([^@]+)@' -and $Matches[1] -notmatch 'change-me') { $ownerPassword = $Matches[1] }
  if ($app -match '^postgresql://staysync_app:([^@]+)@' -and $Matches[1] -notmatch 'change-me') { $appPassword = $Matches[1] }
  if (-not $ownerPassword) { $ownerPassword = New-Secret }
  if (-not $appPassword) { $appPassword = New-Secret }

  Write-Step 'Creating roles and databases'
  $rolesAndDbs = @'
SELECT format('CREATE ROLE staysync LOGIN CREATEDB NOSUPERUSER NOCREATEROLE PASSWORD %L', :'owner_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'staysync') \gexec
SELECT format('ALTER ROLE staysync WITH LOGIN CREATEDB PASSWORD %L', :'owner_password') \gexec
SELECT format('CREATE DATABASE %I OWNER staysync ENCODING ''UTF8''', d)
FROM unnest(ARRAY[:'db', :'test_db']) AS d
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = d) \gexec
'@
  Invoke-Psql -Database 'postgres' -Sql $rolesAndDbs -Vars @{ owner_password = $ownerPassword; db = $DbName; test_db = $TestDbName }
  Write-Ok "role staysync, databases $DbName and $TestDbName"

  $schemaSetup = @'
ALTER SCHEMA public OWNER TO staysync;
ALTER DEFAULT PRIVILEGES FOR ROLE staysync IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO staysync_app;
ALTER DEFAULT PRIVILEGES FOR ROLE staysync IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO staysync_app;
'@
  foreach ($db in @($DbName, $TestDbName)) {
    Invoke-Psql -Database $db -File $AppRoleSql -Vars @{ app_password = $appPassword }
    Invoke-Psql -Database $db -Sql $schemaSetup
  }
  Write-Ok 'role staysync_app (least privilege, row-level security applies)'

  Write-Step 'Writing connection strings to apps\api\.env'
  if (Test-Path $ApiEnv) {
    $backup = "$ApiEnv.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $ApiEnv $backup
    Write-Ok "existing .env backed up to $(Split-Path -Leaf $backup)"
  } else {
    Copy-Item (Join-Path $ApiDir '.env.example') $ApiEnv
  }
  $hp = "${PgHost}:$Port"
  Set-EnvValue $ApiEnv 'DATABASE_URL' "postgresql://staysync_app:$appPassword@$hp/$DbName?schema=public"
  Set-EnvValue $ApiEnv 'MIGRATION_DATABASE_URL' "postgresql://staysync:$ownerPassword@$hp/$DbName?schema=public"
  Set-EnvValue $ApiEnv 'TEST_DATABASE_URL' "postgresql://staysync_app:$appPassword@$hp/$TestDbName?schema=public"
  Set-EnvValue $ApiEnv 'TEST_MIGRATION_DATABASE_URL' "postgresql://staysync:$ownerPassword@$hp/$TestDbName?schema=public"
  if (-not (Get-EnvValue $ApiEnv 'DATA_ENCRYPTION_KEY')) {
    $buf = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buf)
    Set-EnvValue $ApiEnv 'DATA_ENCRYPTION_KEY' ([Convert]::ToBase64String($buf))
    Write-Ok 'generated DATA_ENCRYPTION_KEY'
  }
  # Without Docker there is no Mailpit; log emails (verification links etc.) to the API console instead.
  if ((Get-EnvValue $ApiEnv 'MAIL_TRANSPORT') -eq 'smtp' -and (Get-EnvValue $ApiEnv 'SMTP_HOST') -eq 'localhost') {
    $smtpPort = [int](Get-EnvValue $ApiEnv 'SMTP_PORT')
    $tcp = New-Object Net.Sockets.TcpClient
    try { $open = $tcp.ConnectAsync('127.0.0.1', $smtpPort).Wait(500) } catch { $open = $false } finally { $tcp.Dispose() }
    if (-not $open) {
      Set-EnvValue $ApiEnv 'MAIL_TRANSPORT' 'log'
      Write-Ok 'no mail server on localhost; MAIL_TRANSPORT=log (emails are printed in the API console)'
    }
  }
  Write-Ok 'apps\api\.env updated'
} finally {
  Remove-Item Env:PGPASSWORD, Env:PGOPTIONS -ErrorAction SilentlyContinue
}

Write-Step 'Creating tables (Prisma migrations)'
if (-not (Test-Path (Join-Path $ApiDir 'node_modules'))) {
  & npm ci --prefix $ApiDir
  if ($LASTEXITCODE -ne 0) { Write-Bad 'npm ci failed in apps\api'; exit 1 }
}
& npm --prefix $ApiDir run db:deploy
if ($LASTEXITCODE -ne 0) { Write-Bad 'migrations failed'; exit 1 }
Write-Ok "tables created in $DbName (the test database is migrated automatically by the integration tests)"

if (-not $SkipSeed) {
  Write-Step 'Loading fake demo data'
  & npm --prefix $ApiDir run db:seed
  if ($LASTEXITCODE -ne 0) { Write-Bad 'seed failed'; exit 1 }
  Write-Warn2 'Note the demo password printed above; it is shown only once.'
}

Write-Host ''
Write-Ok 'Done. Start the app with:  npm run dev'
Write-Host "    pgAdmin: connect to ${PgHost}:$Port, database '$DbName'. The owner password is in apps\api\.env (MIGRATION_DATABASE_URL)."
