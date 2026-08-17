param(
    [switch]$NoRun,
    [string]$ReservedName = 'devflow-mixed',
    [switch]$DisableRemoting,
    [string]$ResultPath = '',
    [switch]$ElevatedChild
)

$ErrorActionPreference = 'Stop'

function New-BootstrapException([string]$Code, [string]$Message) {
    $ex = New-Object System.InvalidOperationException($Message)
    $ex.Data['BootstrapCode'] = $Code
    return $ex
}

function Get-BootstrapErrorCode([System.Exception]$Exception) {
    if ($null -ne $Exception -and $null -ne $Exception.Data -and $Exception.Data.Contains('BootstrapCode')) {
        return [string]$Exception.Data['BootstrapCode']
    }
    return 'bootstrap-failed'
}

function Get-RemotingEnrollmentFailureCode([object[]]$Output) {
    $text = @($Output) -join ' '
    if ($text -match '(?i)\bHTTP(?:\s+(?:response\s+)?status)?\s*[:=]?\s*501\b|\bstatus(?:\s+code)?\s*[:=]?\s*501\b|\bunimplemented\b|\bnot\s+implemented\b') {
        return 'remoting-unimplemented'
    }
    return 'remoting-enroll-failed'
}

function Invoke-ZrokBootstrap {
    param(
        [Parameter(Mandatory = $true)][hashtable]$Ops,
        [Parameter(Mandatory = $true)][string]$ReservedName,
        [bool]$EnableRemoting = $true
    )

    $changed = New-Object System.Collections.Generic.List[string]
    try {
        $zrokPath = & $Ops.GetZrokPath
        if ([string]::IsNullOrWhiteSpace([string]$zrokPath)) {
            $zrokPath = & $Ops.InstallZrok
            [void]$changed.Add('zrok-installed')
        }

        $nssmPath = & $Ops.GetNssmPath
        if ([string]::IsNullOrWhiteSpace([string]$nssmPath)) {
            $nssmPath = & $Ops.InstallNssm
            [void]$changed.Add('service-wrapper-installed')
        }

        if (-not (& $Ops.TestEnvironmentEnabled $zrokPath)) {
            $token = & $Ops.ReadAccountToken
            if ($null -eq $token) {
                throw (New-BootstrapException 'token-required' 'A zrok account token is required to enable the service environment.')
            }
            try {
                & $Ops.EnableEnvironment $zrokPath $token
            } finally {
                $token = $null
            }
            [void]$changed.Add('environment-enabled')
        }

        $nameState = [string](& $Ops.GetReservedNameState $zrokPath $ReservedName)
        if ($nameState -eq 'Conflict') {
            throw (New-BootstrapException 'reserved-name-conflict' "The zrok public name '$ReservedName' is not available to this account.")
        }
        if ($nameState -eq 'Missing') {
            & $Ops.CreateReservedName $zrokPath $ReservedName
            [void]$changed.Add('reserved-name-created')
        }

        $remoteControl = 'available'
        $remotingChanged = $false
        if ($EnableRemoting -and -not (& $Ops.TestRemotingEnrolled $zrokPath)) {
            try {
                & $Ops.EnrollRemoting $zrokPath
                $remotingChanged = $true
                [void]$changed.Add('agent-remoting-enrolled')
            } catch {
                if ((Get-BootstrapErrorCode $_.Exception) -ne 'remoting-unimplemented') { throw }
                $remoteControl = 'unsupported'
            }
        }

        $serviceState = [string](& $Ops.GetServiceState)
        if ($serviceState -eq 'Missing') {
            & $Ops.InstallService $nssmPath $zrokPath
            [void]$changed.Add('agent-service-installed')
            & $Ops.StartService $false
            [void]$changed.Add('agent-service-started')
        } elseif ($serviceState -eq 'Stopped') {
            & $Ops.StartService $false
            [void]$changed.Add('agent-service-started')
        } elseif ($serviceState -eq 'Running') {
            if ($remotingChanged) {
                & $Ops.StartService $true
                [void]$changed.Add('agent-service-restarted')
            }
        } else {
            throw (New-BootstrapException 'service-state-unknown' "Unexpected zrokAgent service state '$serviceState'.")
        }

        return [pscustomobject]@{
            ok = $true
            code = 'ready'
            message = 'zrok bootstrap is ready.'
            zrokPath = [string]$zrokPath
            serviceName = 'zrokAgent'
            reservedName = $ReservedName
            remoteControl = $remoteControl
            remotingEnabled = $EnableRemoting
            changed = @($changed)
        }
    } catch {
        $code = Get-BootstrapErrorCode $_.Exception
        return [pscustomobject]@{
            ok = $false
            code = $code
            message = $_.Exception.Message
            serviceName = 'zrokAgent'
            reservedName = $ReservedName
            changed = @($changed)
        }
    }
}

function Invoke-WithServiceProfile {
    param([Parameter(Mandatory = $true)][string]$ServiceProfile, [Parameter(Mandatory = $true)][scriptblock]$Body)
    $oldUserProfile = $env:USERPROFILE
    try {
        $env:USERPROFILE = $ServiceProfile
        return (& $Body)
    } finally {
        $env:USERPROFILE = $oldUserProfile
    }
}

function Invoke-ZrokQuiet {
    param(
        [Parameter(Mandatory = $true)][string]$ZrokPath,
        [Parameter(Mandatory = $true)][string]$ServiceProfile,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$FailureCode = 'zrok-command-failed',
        [string]$FailureMessage = 'zrok command failed.'
    )
    $result = Invoke-WithServiceProfile $ServiceProfile {
        $output = & $ZrokPath @Arguments 2>&1
        return @{ ExitCode = $LASTEXITCODE; Output = @($output) }
    }
    if ($result.ExitCode -ne 0) {
        throw (New-BootstrapException $FailureCode $FailureMessage)
    }
    return @($result.Output)
}

function Find-ZrokExecutable([string]$InstallDir) {
    $preferred = Join-Path $InstallDir 'zrok2.exe'
    if (Test-Path $preferred -PathType Leaf) { return $preferred }
    $command = Get-Command 'zrok2.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) { return $command.Source }
    return $null
}

function Find-NssmExecutable([string]$InstallDir) {
    $preferred = Join-Path $InstallDir 'nssm.exe'
    if (Test-Path $preferred -PathType Leaf) { return $preferred }
    $command = Get-Command 'nssm.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) { return $command.Source }
    return $null
}

function Install-ZrokExecutable([string]$InstallDir) {
    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("devflow-zrok-" + [Guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        $release = Invoke-RestMethod -UseBasicParsing -Uri 'https://api.github.com/repos/openziti/zrok/releases/latest' -Headers @{ 'User-Agent' = 'DevFlow-zrok-bootstrap' }
        $asset = @($release.assets) | Where-Object { $_.name -match '^zrok_[0-9.]+_windows_amd64\.tar\.gz$' } | Select-Object -First 1
        if ($null -eq $asset) {
            throw (New-BootstrapException 'download-failed' 'Latest zrok release does not contain a Windows amd64 archive.')
        }
        $archivePath = Join-Path $tempRoot $asset.name
        Invoke-WebRequest -UseBasicParsing -Uri $asset.browser_download_url -OutFile $archivePath
        if (-not [string]::IsNullOrWhiteSpace([string]$asset.digest) -and ([string]$asset.digest).StartsWith('sha256:')) {
            $expected = ([string]$asset.digest).Substring(7).ToLowerInvariant()
            $actual = (Get-FileHash -Algorithm SHA256 -Path $archivePath).Hash.ToLowerInvariant()
            if ($actual -ne $expected) {
                throw (New-BootstrapException 'download-integrity-failed' 'Downloaded zrok archive failed SHA-256 verification.')
            }
        }
        $tar = Get-Command 'tar.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $tar) {
            throw (New-BootstrapException 'install-failed' 'Windows tar.exe is required to extract the zrok archive.')
        }
        & $tar.Source '-xzf' $archivePath '-C' $tempRoot 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw (New-BootstrapException 'install-failed' 'Unable to extract the zrok Windows archive.')
        }
        $source = Get-ChildItem -Path $tempRoot -Filter 'zrok2.exe' -File -Recurse | Select-Object -First 1
        if ($null -eq $source) {
            throw (New-BootstrapException 'install-failed' 'zrok2.exe was not found in the downloaded archive.')
        }
        $destination = Join-Path $InstallDir 'zrok2.exe'
        Copy-Item -LiteralPath $source.FullName -Destination $destination -Force
        return $destination
    } catch {
        if ($_.Exception.Data.Contains('BootstrapCode')) { throw }
        throw (New-BootstrapException 'download-failed' 'Unable to download or install zrok2.')
    } finally {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Install-NssmExecutable([string]$InstallDir) {
    $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("devflow-nssm-" + [Guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
        $archivePath = Join-Path $tempRoot 'nssm-2.24.zip'
        Invoke-WebRequest -UseBasicParsing -Uri 'https://nssm.cc/release/nssm-2.24.zip' -OutFile $archivePath
        Expand-Archive -LiteralPath $archivePath -DestinationPath $tempRoot -Force
        $archFolder = if ([Environment]::Is64BitOperatingSystem) { 'win64' } else { 'win32' }
        $source = Get-ChildItem -Path $tempRoot -Filter 'nssm.exe' -File -Recurse | Where-Object { $_.DirectoryName -match ([regex]::Escape($archFolder) + '$') } | Select-Object -First 1
        if ($null -eq $source) {
            throw (New-BootstrapException 'service-wrapper-install-failed' 'nssm.exe was not found in the downloaded archive.')
        }
        $destination = Join-Path $InstallDir 'nssm.exe'
        Copy-Item -LiteralPath $source.FullName -Destination $destination -Force
        return $destination
    } catch {
        if ($_.Exception.Data.Contains('BootstrapCode')) { throw }
        throw (New-BootstrapException 'service-wrapper-install-failed' 'Unable to download or install the zrok Windows service wrapper.')
    } finally {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Test-ZrokEnvironmentEnabled([string]$ZrokDir) {
    $environmentPath = Join-Path $ZrokDir 'environment.json'
    try {
        if (-not (Test-Path -LiteralPath $environmentPath -PathType Leaf)) { return $false }
        return ((Get-Item -LiteralPath $environmentPath).Length -gt 0)
    } catch {
        return $false
    }
}

function New-DefaultZrokBootstrapOps {
    param(
        [string]$InstallDir = (Join-Path $env:ProgramFiles 'zrok2'),
        [string]$ServiceName = 'zrokAgent',
        [string]$NamespaceToken = 'public'
    )

    $serviceProfile = Join-Path $env:SystemRoot 'System32\config\systemprofile'
    $zrokDir = Join-Path $serviceProfile '.zrok2'
    $agentEnrollmentPath = Join-Path $zrokDir 'agent-enrollment.json'

    return @{
        GetZrokPath = { return (Find-ZrokExecutable $InstallDir) }.GetNewClosure()
        InstallZrok = { return (Install-ZrokExecutable $InstallDir) }.GetNewClosure()
        GetNssmPath = { return (Find-NssmExecutable $InstallDir) }.GetNewClosure()
        InstallNssm = { return (Install-NssmExecutable $InstallDir) }.GetNewClosure()
        TestEnvironmentEnabled = {
            param($ZrokPath)
            return (Test-ZrokEnvironmentEnabled $zrokDir)
        }.GetNewClosure()
        ReadAccountToken = {
            Write-Host 'DevFlow first-run setup needs your zrok account token. It will not be stored or printed.'
            return (Read-Host 'zrok account token' -AsSecureString)
        }.GetNewClosure()
        EnableEnvironment = {
            param($ZrokPath, [Security.SecureString]$Token)
            $bstr = [IntPtr]::Zero
            $plain = $null
            try {
                $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Token)
                $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
                $result = Invoke-WithServiceProfile $serviceProfile {
                    $output = & $ZrokPath 'enable' $plain 2>&1
                    return @{ ExitCode = $LASTEXITCODE; Output = @($output) }
                }
                if ($result.ExitCode -ne 0) {
                    throw (New-BootstrapException 'enable-failed' 'Unable to enable the zrok service environment. Check the account token and network connection.')
                }
            } finally {
                $plain = $null
                if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
            }
        }.GetNewClosure()
        GetServiceState = {
            $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
            if ($null -eq $service) { return 'Missing' }
            if ($service.Status -eq [System.ServiceProcess.ServiceControllerStatus]::Running) { return 'Running' }
            return 'Stopped'
        }.GetNewClosure()
        InstallService = {
            param($NssmPath, $ZrokPath)
            New-Item -ItemType Directory -Path $zrokDir -Force | Out-Null
            $commands = @(
                @('install', $ServiceName, $ZrokPath, 'agent', 'start'),
                @('set', $ServiceName, 'AppDirectory', $serviceProfile),
                @('set', $ServiceName, 'AppStdout', (Join-Path $zrokDir 'agent-stdout.log')),
                @('set', $ServiceName, 'AppStderr', (Join-Path $zrokDir 'agent-stderr.log')),
                @('set', $ServiceName, 'Start', 'SERVICE_AUTO_START')
            )
            foreach ($args in $commands) {
                & $NssmPath @args 2>&1 | Out-Null
                if ($LASTEXITCODE -ne 0) {
                    throw (New-BootstrapException 'service-install-failed' 'Unable to install or configure the zrokAgent Windows service.')
                }
            }
        }.GetNewClosure()
        StartService = {
            param([bool]$Restart)
            try {
                Set-Service -Name $ServiceName -StartupType Automatic
                if ($Restart) {
                    Restart-Service -Name $ServiceName -Force
                } else {
                    Start-Service -Name $ServiceName
                }
                $service = Get-Service -Name $ServiceName
                $service.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(20))
            } catch {
                throw (New-BootstrapException 'service-start-failed' 'zrokAgent did not reach the Running state.')
            }
        }.GetNewClosure()
        GetReservedNameState = {
            param($ZrokPath, $Name)
            try {
                $raw = Invoke-ZrokQuiet $ZrokPath $serviceProfile @('overview', '--json') 'overview-failed' 'Unable to read the zrok account overview.'
                $json = ($raw -join [Environment]::NewLine) | ConvertFrom-Json
                foreach ($entry in @($json.names)) {
                    if ([string]$entry.name -eq $Name) {
                        if ([string]$entry.namespaceToken -eq $NamespaceToken -or [string]$entry.namespace_token -eq $NamespaceToken) { return 'Owned' }
                        return 'Conflict'
                    }
                }
                return 'Missing'
            } catch {
                if ($_.Exception.Data.Contains('BootstrapCode')) { throw }
                throw (New-BootstrapException 'overview-failed' 'Unable to determine the zrok reserved-name state.')
            }
        }.GetNewClosure()
        CreateReservedName = {
            param($ZrokPath, $Name)
            $result = Invoke-WithServiceProfile $serviceProfile {
                $output = & $ZrokPath 'create' 'name' $Name '--namespace-token' $NamespaceToken 2>&1
                return @{ ExitCode = $LASTEXITCODE; Output = @($output) }
            }
            if ($result.ExitCode -ne 0) {
                $text = ($result.Output -join ' ')
                $code = if ($text -match '(?i)conflict|already|allocated|unavailable') { 'reserved-name-conflict' } else { 'reserved-name-create-failed' }
                throw (New-BootstrapException $code "Unable to create the zrok public name '$Name'.")
            }
        }.GetNewClosure()
        TestRemotingEnrolled = {
            param($ZrokPath)
            return (Test-Path $agentEnrollmentPath -PathType Leaf)
        }.GetNewClosure()
        EnrollRemoting = {
            param($ZrokPath)
            $result = Invoke-WithServiceProfile $serviceProfile {
                $output = & $ZrokPath 'agent' 'enroll' '--headless' 2>&1
                return @{ ExitCode = $LASTEXITCODE; Output = @($output) }
            }
            if ($result.ExitCode -ne 0) {
                $code = Get-RemotingEnrollmentFailureCode $result.Output
                $message = if ($code -eq 'remoting-unimplemented') {
                    'The zrok controller does not support Agent remote-control enrollment.'
                } else {
                    'Unable to enroll the zrok agent for remote control.'
                }
                throw (New-BootstrapException $code $message)
            }
        }.GetNewClosure()
    }
}

function Test-IsAdministrator {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

function Invoke-ElevatedBootstrap {
    param([string]$ReservedName, [bool]$EnableRemoting)
    $resultFile = Join-Path ([System.IO.Path]::GetTempPath()) ("devflow-zrok-result-" + [Guid]::NewGuid().ToString('N') + '.json')
    try {
        $powerShellExe = (Get-Process -Id $PID).Path
        $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-ReservedName', "`"$ReservedName`"", '-ElevatedChild', '-ResultPath', "`"$resultFile`"")
        if (-not $EnableRemoting) { $args += '-DisableRemoting' }
        try {
            $process = Start-Process -FilePath $powerShellExe -Verb RunAs -ArgumentList $args -Wait -PassThru
        } catch {
            return [pscustomobject]@{ ok = $false; code = 'elevation-denied'; message = 'Administrator approval is required to install the zrok Windows service.'; serviceName = 'zrokAgent'; reservedName = $ReservedName; changed = @() }
        }
        if (-not (Test-Path $resultFile -PathType Leaf)) {
            return [pscustomobject]@{ ok = $false; code = 'elevated-bootstrap-failed'; message = "Elevated zrok bootstrap exited without a result (exit code $($process.ExitCode))."; serviceName = 'zrokAgent'; reservedName = $ReservedName; changed = @() }
        }
        return (Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json)
    } finally {
        Remove-Item -LiteralPath $resultFile -Force -ErrorAction SilentlyContinue
    }
}

function Write-BootstrapResult([object]$Result, [string]$Path) {
    $json = $Result | ConvertTo-Json -Depth 8 -Compress
    if ([string]::IsNullOrWhiteSpace($Path)) {
        Write-Output $json
    } else {
        [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
    }
}

if (-not $NoRun) {
    $enableRemoting = -not $DisableRemoting
    if (-not $ElevatedChild -and -not (Test-IsAdministrator)) {
        $finalResult = Invoke-ElevatedBootstrap $ReservedName $enableRemoting
        Write-BootstrapResult $finalResult $ResultPath
        if (-not $finalResult.ok) { exit 1 }
        exit 0
    }

    try {
        $ops = New-DefaultZrokBootstrapOps
        $finalResult = Invoke-ZrokBootstrap -Ops $ops -ReservedName $ReservedName -EnableRemoting $enableRemoting
    } catch {
        $finalResult = [pscustomobject]@{ ok = $false; code = (Get-BootstrapErrorCode $_.Exception); message = $_.Exception.Message; serviceName = 'zrokAgent'; reservedName = $ReservedName; changed = @() }
    }
    Write-BootstrapResult $finalResult $ResultPath
    if (-not $finalResult.ok) { exit 1 }
}
