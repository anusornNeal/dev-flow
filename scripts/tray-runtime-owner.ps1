function Test-RuntimeOwnerIdentity {
    param(
        [psobject]$Owner,
        [psobject]$Identity
    )

    if ($null -eq $Owner -or $null -eq $Identity) { return $false }
    if ([string]::IsNullOrWhiteSpace([string]$Owner.instanceId)) { return $false }
    if ([string]::IsNullOrWhiteSpace([string]$Identity.instanceId)) { return $false }
    if ([string]$Identity.supervisor -ne 'start-all') { return $false }
    if ([string]$Identity.instanceId -ne [string]$Owner.instanceId) { return $false }

    $ownerPid = 0
    $identityPid = 0
    if (-not [int]::TryParse([string]$Owner.pid, [ref]$ownerPid)) { return $false }
    if (-not [int]::TryParse([string]$Identity.pid, [ref]$identityPid)) { return $false }
    if ($ownerPid -lt 1 -or $identityPid -ne $ownerPid) { return $false }

    return @('running', 'starting') -contains [string]$Identity.lifecycleStatus
}

function Test-RuntimeOwner {
    param(
        [psobject]$Owner,
        [int]$TimeoutSec = 2
    )

    if ($null -eq $Owner -or [string]::IsNullOrWhiteSpace([string]$Owner.controlToken)) {
        return $false
    }

    $controlPort = 0
    if (-not [int]::TryParse([string]$Owner.controlPort, [ref]$controlPort)) { return $false }
    if ($controlPort -lt 1 -or $controlPort -gt 65535) { return $false }

    try {
        $headers = @{ 'x-devflow-runtime-token' = [string]$Owner.controlToken }
        $identityUrl = "http://127.0.0.1:$controlPort/identity"
        $identity = Invoke-RestMethod -Method Get -Uri $identityUrl -Headers $headers -TimeoutSec ([Math]::Max(1, $TimeoutSec))
        return [bool](Test-RuntimeOwnerIdentity -Owner $Owner -Identity $identity)
    } catch {
        return $false
    }
}
