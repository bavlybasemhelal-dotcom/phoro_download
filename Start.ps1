param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$photoRoot = $PSScriptRoot
$photoRuntimeFile = Join-Path $photoRoot '.data\runtime.json.tmp-info'
if (Test-Path -LiteralPath $photoRuntimeFile) {
    try {
        $photoRuntime = Get-Content -LiteralPath $photoRuntimeFile -Raw | ConvertFrom-Json
        $photoPing = Invoke-RestMethod -Uri ($photoRuntime.url + '/api/bootstrap') -TimeoutSec 2
        if ($photoPing.defaultOutput -eq (Join-Path $photoRoot 'product-images')) {
            if (-not $NoBrowser) { Start-Process $photoRuntime.url }
            exit
        }
    } catch { }
}
$photoNode = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $photoNode) {
    $photoBundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $photoBundledNode) { $photoNode = $photoBundledNode }
}
if (-not $photoNode) { throw 'Node.js 20 or newer is required. Install it from https://nodejs.org' }
if (-not (Test-Path -LiteralPath (Join-Path $photoRoot 'node_modules\sharp'))) { throw 'Run npm.cmd install in this folder first.' }
$photoLog = Join-Path $photoRoot '.data'
New-Item -ItemType Directory -Path $photoLog -Force | Out-Null
$photoProcess = Start-Process -FilePath $photoNode -ArgumentList @('"' + (Join-Path $photoRoot 'server.js') + '"') -WorkingDirectory $photoRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $photoLog 'server.log') -RedirectStandardError (Join-Path $photoLog 'server-error.log')
for ($photoAttempt = 0; $photoAttempt -lt 60; $photoAttempt++) {
    Start-Sleep -Milliseconds 200
    if ($photoProcess.HasExited) { throw ('The app could not start. See ' + (Join-Path $photoLog 'server-error.log')) }
    if (Test-Path -LiteralPath $photoRuntimeFile) {
        try {
            $photoRuntime = Get-Content -LiteralPath $photoRuntimeFile -Raw | ConvertFrom-Json
            if ($photoRuntime.pid -eq $photoProcess.Id) { if (-not $NoBrowser) { Start-Process $photoRuntime.url }; exit }
        } catch { }
    }
}
throw 'The app took too long to start. Check .data\server-error.log'
