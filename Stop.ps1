$ErrorActionPreference = 'Stop'
$photoRuntimeFile = Join-Path $PSScriptRoot '.data\runtime.json.tmp-info'
if (-not (Test-Path -LiteralPath $photoRuntimeFile)) { exit }
try {
    $photoRuntime = Get-Content -LiteralPath $photoRuntimeFile -Raw | ConvertFrom-Json
    $photoBootstrap = Invoke-RestMethod -Uri ($photoRuntime.url + '/api/bootstrap') -TimeoutSec 3
    if ($photoBootstrap.defaultOutput -eq (Join-Path $PSScriptRoot 'product-images')) {
        Invoke-RestMethod -Uri ($photoRuntime.url + '/api/quit') -Method Post -ContentType 'application/json' -Body '{}' -Headers @{ 'X-App-Token' = $photoBootstrap.token } -TimeoutSec 3 | Out-Null
    }
} catch { }
