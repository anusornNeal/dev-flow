$ErrorActionPreference = 'Stop'

$bootstrapPath = Join-Path $PSScriptRoot 'zrok-bootstrap.ps1'
$tokens = $null
$parseErrors = $null
if (Test-Path $bootstrapPath) {
    [System.Management.Automation.Language.Parser]::ParseFile($bootstrapPath, [ref]$tokens, [ref]$parseErrors) | Out-Null
    if ($parseErrors.Count -gt 0) {
        throw "zrok-bootstrap.ps1 parse failed: $($parseErrors[0].Message)"
    }
}

. $bootstrapPath -NoRun

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERT: $Message" }
}

function Assert-Equal($Actual, $Expected, [string]$Message) {
    if ($Actual -ne $Expected) { throw "ASSERT: $Message (expected=$Expected actual=$Actual)" }
}

function New-FakeBootstrapOps {
    param(
        [bool]$ZrokInstalled = $true,
        [bool]$NssmInstalled = $true,
        [bool]$EnvironmentEnabled = $true,
        [ValidateSet('Missing','Stopped','Running')][string]$ServiceState = 'Running',
        [ValidateSet('Missing','Owned','Conflict')][string]$NameState = 'Owned',
        [bool]$RemotingEnrolled = $true,
        [bool]$RemotingEnrollmentUnsupported = $false,
        [string]$FailOperation = '',
        [string]$SavedReservedName = '',
        [string[]]$OwnedReservedNames = @('test-reserved-name'),
        [string]$ChosenReservedName = 'test-reserved-name'
    )

    $state = [ordered]@{
        zrokInstalled = $ZrokInstalled
        nssmInstalled = $NssmInstalled
        environmentEnabled = $EnvironmentEnabled
        serviceState = $ServiceState
        nameState = $NameState
        remotingEnrolled = $RemotingEnrolled
        savedReservedName = $SavedReservedName
        ownedReservedNames = @($OwnedReservedNames)
        chosenReservedName = $ChosenReservedName
        savedReads = 0
        listNames = 0
        chooseName = 0
        saveName = 0
        tokenReads = 0
        installZrok = 0
        installNssm = 0
        enable = 0
        installService = 0
        startService = 0
        createName = 0
        enrollRemoting = 0
        calls = New-Object System.Collections.Generic.List[string]
    }

    $failIf = {
        param([string]$Operation, [string]$Code)
        if ($FailOperation -eq $Operation) {
            $ex = New-Object System.InvalidOperationException("fake $Operation failure")
            $ex.Data['BootstrapCode'] = $Code
            throw $ex
        }
    }.GetNewClosure()

    $ops = @{
        GetZrokPath = {
            [void]$state.calls.Add('GetZrokPath')
            if ($state.zrokInstalled) { return 'C:\Program Files\zrok2\zrok2.exe' }
            return $null
        }.GetNewClosure()
        InstallZrok = {
            [void]$state.calls.Add('InstallZrok')
            & $failIf 'InstallZrok' 'download-failed'
            $state.installZrok++
            $state.zrokInstalled = $true
            return 'C:\Program Files\zrok2\zrok2.exe'
        }.GetNewClosure()
        GetNssmPath = {
            [void]$state.calls.Add('GetNssmPath')
            if ($state.nssmInstalled) { return 'C:\Program Files\zrok2\nssm.exe' }
            return $null
        }.GetNewClosure()
        InstallNssm = {
            [void]$state.calls.Add('InstallNssm')
            & $failIf 'InstallNssm' 'service-wrapper-install-failed'
            $state.installNssm++
            $state.nssmInstalled = $true
            return 'C:\Program Files\zrok2\nssm.exe'
        }.GetNewClosure()
        TestEnvironmentEnabled = {
            param($ZrokPath)
            [void]$state.calls.Add('TestEnvironmentEnabled')
            return [bool]$state.environmentEnabled
        }.GetNewClosure()
        ReadAccountToken = {
            [void]$state.calls.Add('ReadAccountToken')
            $state.tokenReads++
            $secure = New-Object Security.SecureString
            foreach ($char in 'SUPER-SECRET-TEST-TOKEN'.ToCharArray()) { $secure.AppendChar($char) }
            $secure.MakeReadOnly()
            return $secure
        }.GetNewClosure()
        EnableEnvironment = {
            param($ZrokPath, [Security.SecureString]$Token)
            [void]$state.calls.Add('EnableEnvironment')
            & $failIf 'EnableEnvironment' 'enable-failed'
            Assert-True ($Token -is [Security.SecureString]) 'token must stay SecureString through orchestration'
            $state.enable++
            $state.environmentEnabled = $true
        }.GetNewClosure()
        GetServiceState = {
            [void]$state.calls.Add('GetServiceState')
            return [string]$state.serviceState
        }.GetNewClosure()
        InstallService = {
            param($NssmPath, $ZrokPath)
            [void]$state.calls.Add('InstallService')
            & $failIf 'InstallService' 'service-install-failed'
            $state.installService++
            $state.serviceState = 'Stopped'
        }.GetNewClosure()
        StartService = {
            [void]$state.calls.Add('StartService')
            & $failIf 'StartService' 'service-start-failed'
            $state.startService++
            $state.serviceState = 'Running'
        }.GetNewClosure()
        GetSavedReservedName = {
            [void]$state.calls.Add('GetSavedReservedName')
            $state.savedReads++
            return [string]$state.savedReservedName
        }.GetNewClosure()
        ListOwnedReservedNames = {
            param($ZrokPath)
            [void]$state.calls.Add('ListOwnedReservedNames')
            $state.listNames++
            return @($state.ownedReservedNames)
        }.GetNewClosure()
        ChooseReservedName = {
            param([string[]]$OwnedNames)
            [void]$state.calls.Add('ChooseReservedName')
            $state.chooseName++
            return [string]$state.chosenReservedName
        }.GetNewClosure()
        SaveReservedName = {
            param([string]$Name)
            [void]$state.calls.Add('SaveReservedName')
            $state.saveName++
            $state.savedReservedName = $Name
        }.GetNewClosure()
        GetReservedNameState = {
            param($ZrokPath, $ReservedName)
            [void]$state.calls.Add('GetReservedNameState')
            return [string]$state.nameState
        }.GetNewClosure()
        CreateReservedName = {
            param($ZrokPath, $ReservedName)
            [void]$state.calls.Add('CreateReservedName')
            & $failIf 'CreateReservedName' 'reserved-name-create-failed'
            $state.createName++
            $state.nameState = 'Owned'
        }.GetNewClosure()
        TestRemotingEnrolled = {
            param($ZrokPath)
            [void]$state.calls.Add('TestRemotingEnrolled')
            return [bool]$state.remotingEnrolled
        }.GetNewClosure()
        EnrollRemoting = {
            param($ZrokPath)
            [void]$state.calls.Add('EnrollRemoting')
            if ($RemotingEnrollmentUnsupported) {
                $ex = New-Object System.InvalidOperationException('fake controller returned HTTP 501 unimplemented')
                $ex.Data['BootstrapCode'] = 'remoting-unimplemented'
                throw $ex
            }
            & $failIf 'EnrollRemoting' 'remoting-enroll-failed'
            $state.enrollRemoting++
            $state.remotingEnrolled = $true
        }.GetNewClosure()
    }

    return @{ State = $state; Ops = $ops }
}

function Invoke-Case([string]$Name, [scriptblock]$Body) {
    & $Body
    Write-Output "[verify-zrok-bootstrap] PASS $Name"
}

Invoke-Case 'environment marker detection requires non-empty environment.json' {
    $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("devflow-zrok-env-test-" + [Guid]::NewGuid().ToString('N'))
    [void][System.IO.Directory]::CreateDirectory($tempDir)
    try {
        Assert-True (-not (Test-ZrokEnvironmentEnabled $tempDir)) 'missing environment.json must be disabled'
        $environmentPath = Join-Path $tempDir 'environment.json'
        [System.IO.File]::WriteAllText($environmentPath, '')
        Assert-True (-not (Test-ZrokEnvironmentEnabled $tempDir)) 'empty environment.json must be disabled'
        [System.IO.File]::WriteAllText($environmentPath, '{}')
        Assert-True (Test-ZrokEnvironmentEnabled $tempDir) 'non-empty environment.json must be enabled'
    } finally {
        [System.IO.Directory]::Delete($tempDir, $true)
    }
}

Invoke-Case 'local reserved-name selection persists only the selected name' {
    $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("devflow-zrok-selection-test-" + [Guid]::NewGuid().ToString('N'))
    [void][System.IO.Directory]::CreateDirectory($tempDir)
    try {
        $selectionPath = Join-Path $tempDir 'zrok-selection.json'
        Write-ZrokReservedNameSelection $selectionPath 'saved-name'
        Assert-Equal (Read-ZrokReservedNameSelection $selectionPath) 'saved-name' 'saved name round-trips'
        $json = Get-Content -LiteralPath $selectionPath -Raw | ConvertFrom-Json
        Assert-Equal @($json.PSObject.Properties).Count 1 'selection file contains one property only'
        Assert-Equal ([string]$json.reservedName) 'saved-name' 'selection file stores the selected reserved name'
        Assert-True (-not ((Get-Content -LiteralPath $selectionPath -Raw) -match 'token|secret|endpoint')) 'selection file must not contain credential or endpoint fields'
        [System.IO.File]::WriteAllText($selectionPath, '{not-json')
        Assert-Equal (Read-ZrokReservedNameSelection $selectionPath) '' 'malformed selection is ignored'
        [System.IO.File]::WriteAllText($selectionPath, ('x' * 5000))
        Assert-Equal (Read-ZrokReservedNameSelection $selectionPath) '' 'oversized selection is ignored'
    } finally {
        [System.IO.Directory]::Delete($tempDir, $true)
    }
}

Invoke-Case 'remoting enrollment classification is narrow' {
    Assert-Equal (Get-RemotingEnrollmentFailureCode @('controller request failed: HTTP 501 Not Implemented')) 'remoting-unimplemented' 'HTTP 501 is unsupported capability'
    Assert-Equal (Get-RemotingEnrollmentFailureCode @('controller request 501 failed without an HTTP status')) 'remoting-enroll-failed' 'an unrelated number is not an unsupported capability'
    Assert-Equal (Get-RemotingEnrollmentFailureCode @('controller request failed: 500 internal server error')) 'remoting-enroll-failed' 'other controller failures remain fatal'
}

Invoke-Case 'native stderr capture preserves zrok failure output under stop preference' {
    $powerShellPath = (Get-Process -Id $PID).Path
    $captured = Invoke-NativeCaptured $powerShellPath @(
        '-NoProfile',
        '-Command',
        '[Console]::Error.WriteLine("controller request failed: HTTP 501 Not Implemented"); exit 1'
    )
    Assert-Equal $captured.ExitCode 1 'native capture preserves the process exit code'
    Assert-Equal (Get-RemotingEnrollmentFailureCode $captured.Output) 'remoting-unimplemented' 'stderr remains available for 501 classification'
}

Invoke-Case 'fresh machine installs, enables, creates service/name/remoting' {
    $fake = New-FakeBootstrapOps -ZrokInstalled:$false -NssmInstalled:$false -EnvironmentEnabled:$false -ServiceState Missing -NameState Missing -RemotingEnrolled:$false
    $result = Invoke-ZrokBootstrap -Ops $fake.Ops -ReservedName 'test-reserved-name' -EnableRemoting $true
    Assert-True $result.ok ("fresh bootstrap should succeed: " + ($result | ConvertTo-Json -Depth 8 -Compress))
    Assert-Equal $fake.State.installZrok 1 'zrok installs once'
    Assert-Equal $fake.State.installNssm 1 'nssm installs once'
    Assert-Equal $fake.State.tokenReads 1 'token prompts once'
    Assert-Equal $fake.State.enable 1 'environment enables once'
    Assert-Equal $fake.State.installService 1 'service installs once'
    Assert-Equal $fake.State.startService 1 'service starts once'
    Assert-Equal $fake.State.createName 1 'reserved name creates once'
    Assert-Equal $fake.State.enrollRemoting 1 'remoting enrolls once'
    Assert-Equal $result.remoteControl 'available' 'successful enrollment exposes remote-control capability'
    Assert-True (-not (($result | ConvertTo-Json -Depth 8) -match 'SUPER-SECRET')) 'result must not expose token'
}

Invoke-Case 'repeated run is idempotent and never re-prompts' {
    $fake = New-FakeBootstrapOps -ZrokInstalled:$false -NssmInstalled:$false -EnvironmentEnabled:$false -ServiceState Missing -NameState Missing -RemotingEnrolled:$false
    $first = Invoke-ZrokBootstrap -Ops $fake.Ops -ReservedName 'test-reserved-name' -EnableRemoting $true
    $second = Invoke-ZrokBootstrap -Ops $fake.Ops -ReservedName 'test-reserved-name' -EnableRemoting $true
    Assert-True ($first.ok -and $second.ok) 'both runs should succeed'
    Assert-Equal $fake.State.installZrok 1 'zrok must not reinstall'
    Assert-Equal $fake.State.installNssm 1 'nssm must not reinstall'
    Assert-Equal $fake.State.tokenReads 1 'second run must not request token'
    Assert-Equal $fake.State.installService 1 'service must not reinstall'
    Assert-Equal $fake.State.createName 1 'name must not recreate'
    Assert-Equal $fake.State.enrollRemoting 1 'remoting must not reenroll'
}

Invoke-Case 'already configured machine performs no destructive mutation' {
    $fake = New-FakeBootstrapOps
    $result = Invoke-ZrokBootstrap -Ops $fake.Ops -ReservedName 'test-reserved-name' -EnableRemoting $true
    Assert-True $result.ok 'configured bootstrap should succeed'
    Assert-Equal $fake.State.tokenReads 0 'configured environment must not prompt'
    Assert-Equal $fake.State.installService 0 'running service must not reinstall'
    Assert-Equal $fake.State.startService 0 'running service must not restart'
    Assert-Equal $fake.State.createName 0 'existing name must be reused'
    Assert-Equal $fake.State.enrollRemoting 0 'existing remoting must be reused'
}

Invoke-Case 'partial environment prompts only for enablement' {
    $fake = New-FakeBootstrapOps -EnvironmentEnabled:$false
    $result = Invoke-ZrokBootstrap -Ops $fake.Ops -ReservedName 'test-reserved-name' -EnableRemoting $true
    Assert-True $result.ok 'partial environment should recover'
    Assert-Equal $fake.State.tokenReads 1 'missing environment requests token'
    Assert-Equal $fake.State.enable 1 'missing environment enables once'
    Assert-Equal $fake.State.installZrok 0 'existing zrok reused'
}

Invoke-Case 'stopped service is started without reinstall' {
    $fake = New-FakeBootstrapOps -ServiceState Stopped
    $result = Invoke-ZrokBootstrap -Ops $fake.Ops -ReservedName 'test-reserved-name' -EnableRemoting $true
    Assert-True $result.ok 'stopped service should recover'
    Assert-Equal $fake.State.installService 0 'stopped service must not reinstall'
    Assert-Equal $fake.State.startService 1 'stopped service should start'
}

Invoke-Case 'explicit reserved name bypasses saved and interactive selection' {
    $fake = New-FakeBootstrapOps -SavedReservedName 'saved-name' -OwnedReservedNames @('saved-name','explicit-name') -ChosenReservedName 'saved-name'
    $result = Invoke-ZrokBootstrap -Ops $fake.Ops -ReservedName 'explicit-name' -EnableRemoting $true
    Assert-Equal $result.ok $true 'explicit selection should succeed'
    Assert-Equal $result.reservedName 'explicit-name' 'explicit reserved name remains authoritative'
    Assert-Equal $fake.State.savedReads 0 'explicit name must not read saved selection'
    Assert-Equal $fake.State.listNames 0 'explicit name must not list account names'
    Assert-Equal $fake.State.chooseName 0 'explicit name must not prompt for selection'
    Assert-Equal $fake.State.savedReservedName 'explicit-name' 'explicit name becomes the local saved selection'
}

Invoke-Case 'saved owned reserved name is reused without prompting' {
    $fake = New-FakeBootstrapOps -SavedReservedName 'saved-name' -OwnedReservedNames @('saved-name','other-name') -ChosenReservedName 'other-name'
    $result = Invoke-ZrokBootstrap -Ops $fake.Ops -ReservedName '' -EnableRemoting $true
    Assert-Equal $result.ok $true 'saved selection should succeed'
    Assert-Equal $result.reservedName 'saved-name' 'saved owned name is reused'
    Assert-Equal $fake.State.listNames 1 'saved selection is validated against account names'
    Assert-Equal $fake.State.chooseName 0 'valid saved selection must not prompt'
    Assert-Equal $fake.State.createName 0 'owned saved name must not be recreated'
}

Invoke-Case 'interactive existing reserved name is reused and saved' {
    $fake = New-FakeBootstrapOps -OwnedReservedNames @('alpha','beta') -ChosenReservedName 'beta'
    $result = Invoke-ZrokBootstrap -Ops $fake.Ops -ReservedName '' -EnableRemoting $true
    Assert-Equal $result.ok $true 'interactive existing selection should succeed'
    Assert-Equal $result.reservedName 'beta' 'chosen existing name is returned'
    Assert-Equal $fake.State.chooseName 1 'missing saved selection asks once'
    Assert-Equal $fake.State.createName 0 'existing chosen name is reused'
    Assert-Equal $fake.State.savedReservedName 'beta' 'chosen existing name is persisted locally'
}

Invoke-Case 'interactive new reserved name is created once and saved' {
    $fake = New-FakeBootstrapOps -NameState Missing -OwnedReservedNames @('alpha') -ChosenReservedName 'new-machine-name'
    $result = Invoke-ZrokBootstrap -Ops $fake.Ops -ReservedName '' -EnableRemoting $true
    Assert-Equal $result.ok $true 'interactive new selection should succeed'
    Assert-Equal $result.reservedName 'new-machine-name' 'new chosen name is returned'
    Assert-Equal $fake.State.chooseName 1 'new selection asks once'
    Assert-Equal $fake.State.createName 1 'missing chosen name is created once'
    Assert-Equal $fake.State.savedReservedName 'new-machine-name' 'new chosen name is persisted locally'
}

Invoke-Case 'stale saved name falls back to account selection' {
    $fake = New-FakeBootstrapOps -SavedReservedName 'stale-name' -OwnedReservedNames @('current-name') -ChosenReservedName 'current-name'
    $result = Invoke-ZrokBootstrap -Ops $fake.Ops -ReservedName '' -EnableRemoting $true
    Assert-Equal $result.ok $true 'stale saved selection should recover'
    Assert-Equal $result.reservedName 'current-name' 'interactive replacement wins over stale saved name'
    Assert-Equal $fake.State.chooseName 1 'stale saved selection prompts once'
    Assert-Equal $fake.State.savedReservedName 'current-name' 'replacement selection is persisted'
}

Invoke-Case 'unsupported remoting preserves local readiness' {
    $fake = New-FakeBootstrapOps -RemotingEnrolled:$false -RemotingEnrollmentUnsupported:$true -ServiceState Running
    $result = Invoke-ZrokBootstrap -Ops $fake.Ops -ReservedName 'account-specific-name' -EnableRemoting $true
    $json = $result | ConvertTo-Json -Depth 8
    Assert-Equal $result.ok $true 'local readiness remains available'
    Assert-Equal $result.remoteControl 'unsupported' 'capability is explicit'
    Assert-True (-not ($json -match 'account-specific-name\.shares\.zrok\.io')) 'bootstrap must not synthesize a public hostname'
    Assert-True (-not ($result.PSObject.Properties.Name -contains 'publicHost')) 'bootstrap result must omit constructed public host output'
}

Invoke-Case 'ordinary remoting enrollment failure remains fatal' {
    $fake = New-FakeBootstrapOps -RemotingEnrolled:$false -FailOperation EnrollRemoting -ServiceState Running
    $result = Invoke-ZrokBootstrap -Ops $fake.Ops -ReservedName 'account-specific-name' -EnableRemoting $true
    Assert-Equal $result.ok $false 'unclassified enrollment failure must fail bootstrap'
    Assert-Equal $result.code 'remoting-enroll-failed' 'unclassified enrollment failure code is preserved'
}

Invoke-Case 'reserved-name conflict is actionable and non-destructive' {
    $fake = New-FakeBootstrapOps -NameState Conflict
    $result = Invoke-ZrokBootstrap -Ops $fake.Ops -ReservedName 'test-reserved-name' -EnableRemoting $true
    Assert-True (-not $result.ok) 'name conflict should fail'
    Assert-Equal $result.code 'reserved-name-conflict' 'name conflict code'
    Assert-Equal $fake.State.createName 0 'conflict must not create/overwrite name'
}

Invoke-Case 'download failure returns structured error' {
    $fake = New-FakeBootstrapOps -ZrokInstalled:$false -FailOperation InstallZrok
    $result = Invoke-ZrokBootstrap -Ops $fake.Ops -ReservedName 'test-reserved-name' -EnableRemoting $true
    Assert-True (-not $result.ok) 'download failure should fail'
    Assert-Equal $result.code 'download-failed' 'download failure code'
}

Invoke-Case 'bad token returns structured error without token leakage' {
    $fake = New-FakeBootstrapOps -EnvironmentEnabled:$false -FailOperation EnableEnvironment
    $result = Invoke-ZrokBootstrap -Ops $fake.Ops -ReservedName 'test-reserved-name' -EnableRemoting $true
    $json = $result | ConvertTo-Json -Depth 8
    Assert-True (-not $result.ok) 'bad token should fail'
    Assert-Equal $result.code 'enable-failed' 'bad token code'
    Assert-True (-not ($json -match 'SUPER-SECRET')) 'failure result must not expose token'
}

Write-Output '[verify-zrok-bootstrap] all scenarios passed'
