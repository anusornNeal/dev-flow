$ErrorActionPreference = 'Stop'

$helperPath = Join-Path $PSScriptRoot 'tray-runtime-owner.ps1'
if (-not (Test-Path -LiteralPath $helperPath)) {
    throw "Expected runtime-owner probe helper at $helperPath"
}
. $helperPath

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw "Assertion failed: $Message"
    }
}

$owner = [pscustomobject]@{
    supervisor   = 'start-all'
    instanceId   = 'instance-12345678'
    pid          = 1234
    controlPort  = 1
    controlToken = 'token-12345678'
}

$validIdentity = [pscustomobject]@{
    supervisor     = 'start-all'
    instanceId     = 'instance-12345678'
    pid            = 1234
    lifecycleStatus = 'running'
}

Assert-True (Test-RuntimeOwnerIdentity -Owner $owner -Identity $validIdentity) 'matching supervisor identity should be accepted'

$mismatchedPid = $validIdentity | Select-Object *
$mismatchedPid.pid = 9999
Assert-True (-not (Test-RuntimeOwnerIdentity -Owner $owner -Identity $mismatchedPid)) 'mismatched supervisor PID should be rejected'

$stoppedIdentity = $validIdentity | Select-Object *
$stoppedIdentity.lifecycleStatus = 'stopped'
Assert-True (-not (Test-RuntimeOwnerIdentity -Owner $owner -Identity $stoppedIdentity)) 'stopped supervisor should be rejected'

$missingInstanceId = $validIdentity | Select-Object *
$missingInstanceId.instanceId = ''
Assert-True (-not (Test-RuntimeOwnerIdentity -Owner $owner -Identity $missingInstanceId)) 'identity without an instance ID should be rejected'

Assert-True (-not (Test-RuntimeOwner -Owner $owner -TimeoutSec 1)) 'unreachable supervisor should be treated as stale'

$traySource = Get-Content -Raw (Join-Path $PSScriptRoot 'tray-server.ps1')
$probeIndex = $traySource.IndexOf('Test-RuntimeOwner -Owner $owner')
$postIndex = $traySource.IndexOf('Invoke-RestMethod -Method Post -Uri $controlUrl')
Assert-True ($probeIndex -ge 0) 'tray stop handler should probe the runtime owner'
Assert-True ($postIndex -gt $probeIndex) 'tray stop handler should probe before posting shutdown'
Assert-True ($traySource.Contains('Stale DevFlow supervisor ownership record detected')) 'tray stop handler should handle stale ownership without an error dialog'

Write-Output '[verify-tray-runtime-owner] all assertions passed'
