param(
  [string]$EnvId = "YOUR_CLOUD_ENV_ID",
  [switch]$Apply
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $projectRoot "database\indexes.json"
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json

if (-not $Apply) {
  Write-Host "Preview only: indexes planned for environment $EnvId."
  foreach ($collection in $manifest.collections) {
    Write-Host ("- {0}: {1}" -f $collection.name, (($collection.indexes.name) -join ", "))
  }
  Write-Host "After confirming the environment, run: powershell -ExecutionPolicy Bypass -File scripts/init-database-indexes.ps1 -EnvId your-env-id -Apply"
  exit 0
}

if ($EnvId -eq "YOUR_CLOUD_ENV_ID") {
  throw "请通过 -EnvId 传入你的云开发环境 ID。"
}

if (-not (Get-Command tcb -ErrorAction SilentlyContinue)) {
  throw "tcb CLI was not found. Install and sign in to CloudBase CLI first."
}

foreach ($collection in $manifest.collections) {
  $inner = [ordered]@{
    createIndexes = $collection.name
    indexes = $collection.indexes
  } | ConvertTo-Json -Depth 20 -Compress
  $outer = @(
    [ordered]@{
      TableName = $collection.name
      CommandType = "COMMAND"
      Command = $inner
    }
  ) | ConvertTo-Json -Depth 20 -Compress

  Write-Host ("Applying indexes for collection {0}" -f $collection.name)
  & tcb db nosql execute --env-id $EnvId --command $outer --json
  if ($LASTEXITCODE -ne 0) {
    throw ("Index initialization failed for {0}; remaining operations were stopped." -f $collection.name)
  }
}

Write-Host "Database index initialization completed. Verify the result in the CloudBase console."
