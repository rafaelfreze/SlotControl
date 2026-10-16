[CmdletBinding()]
param([string]$CliPath)

$ErrorActionPreference = 'Stop'
$coinopsProjectRef = 'otdfpmsegjxpqrzisfmi'
$coinopsOrganizationId = 'pzgqtvaitaawqgaabxve'

# Official CLI only. Existing login is reused; never read or print its token.
if (-not $CliPath) {
    $coinopsCommand = Get-Command supabase -ErrorAction SilentlyContinue
    if ($coinopsCommand) { $CliPath = $coinopsCommand.Source }
}
if (-not $CliPath) {
    $coinopsCache = Join-Path $env:LOCALAPPDATA 'npm-cache\_npx'
    $coinopsCandidates = @(Get-ChildItem -LiteralPath $coinopsCache -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $coinopsCandidate = Join-Path $_.FullName 'node_modules\@supabase\cli-windows-x64\bin\supabase.exe'
        if (Test-Path -LiteralPath $coinopsCandidate) { $coinopsCandidate }
    })
    foreach ($coinopsCandidate in $coinopsCandidates) {
        $coinopsVersionText = & $coinopsCandidate --version 2>$null
        if ($LASTEXITCODE -eq 0 -and $coinopsVersionText -match '^2\.(\d+)\.(\d+)$' -and [int]$Matches[1] -ge 121) {
            $CliPath = $coinopsCandidate
            break
        }
    }
}
if (-not $CliPath -or -not (Test-Path -LiteralPath $CliPath)) {
    throw 'Official Supabase CLI supporting db query --linked is required. Do not use a legacy .env as fallback.'
}

$coinopsProjectsText = & $CliPath projects list --output json
if ($LASTEXITCODE -ne 0) { throw 'Supabase CLI authentication/project listing failed.' }
$coinopsProjects = ($coinopsProjectsText -join "`n") | ConvertFrom-Json
$coinopsProject = @($coinopsProjects | Where-Object { $_.id -eq $coinopsProjectRef })
if ($coinopsProject.Count -ne 1 -or $coinopsProject[0].name -ne 'OnPlay Platform' -or
    $coinopsProject[0].organization_id -ne $coinopsOrganizationId) {
    throw 'CoinOps project or organization identity is not proven; no SQL was executed.'
}

$coinopsSql = @'
BEGIN READ ONLY;
SELECT jsonb_build_object(
  'product','CoinOps','project_ref','otdfpmsegjxpqrzisfmi','schema','coinops',
  'database',current_database(),'role',current_user,
  'read_only',current_setting('transaction_read_only'),
  'schema_exists',to_regnamespace('coinops') IS NOT NULL,
  'tables',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity) ORDER BY c.relname)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='coinops'
      AND c.relname IN ('operators','exchange_accounts','trading_engines','robot_v1_live_runs','robot_v1_live_slots','robot_v1_live_orders','robot_v1_live_slot_accounts')),
  'recent_coinops_migrations',(SELECT jsonb_agg(to_jsonb(m)) FROM
    (SELECT version,name FROM supabase_migrations.schema_migrations WHERE name LIKE '%coinops%' ORDER BY version DESC LIMIT 10) m),
  'observed_at',now());
COMMIT;
'@
$coinopsResultText = & $CliPath db query --linked --project-ref $coinopsProjectRef --output json $coinopsSql
if ($LASTEXITCODE -ne 0) { throw 'CoinOps read-only database verification failed.' }
$coinopsResult = ($coinopsResultText -join "`n") | ConvertFrom-Json
$coinopsEvidence = $coinopsResult.rows[0].jsonb_build_object
if ($coinopsEvidence.read_only -ne 'on' -or -not $coinopsEvidence.schema_exists -or
    @($coinopsEvidence.tables).Count -ne 7 -or
    @($coinopsEvidence.tables | Where-Object { -not $_.rls -or -not $_.force_rls }).Count -gt 0) {
    throw 'CoinOps schema or RLS verification failed; do not proceed with mutations.'
}
$coinopsEvidence | ConvertTo-Json -Depth 8
