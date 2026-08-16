Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class IconExtractor {
    [DllImport("shell32.dll", CharSet = CharSet.Auto)]
    public static extern uint ExtractIconEx(string szFileName, int nIconIndex, IntPtr[] phiconLarge, IntPtr[] phiconSmall, uint nIcons);
}
"@

$projectDir = Split-Path -Parent $PSScriptRoot
$runtimeOwnerPath = Join-Path $projectDir ".devflow\runtime-owner\owner.json"
$logDir = Join-Path $projectDir "logs"
$logFile = Join-Path $logDir "tray.log"

function Write-TrayLog([string]$Level, [string]$Message) {
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
    $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
    Add-Content -Path $logFile -Value "[$timestamp] [$Level] $Message"
}

function Get-RuntimeOwner {
    if (-not (Test-Path $runtimeOwnerPath)) { return $null }
    try {
        return Get-Content -Path $runtimeOwnerPath -Raw | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Get-AppUrl {
    $owner = Get-RuntimeOwner
    if ($null -ne $owner -and -not [string]::IsNullOrWhiteSpace([string]$owner.appUrl)) {
        return ([string]$owner.appUrl).TrimEnd('/')
    }
    return "http://localhost:3000"
}

function Show-TrayMessage([string]$Title, [string]$Message, [int]$Duration = 3500) {
    if ($null -eq $script:notifyIcon) { return }
    $script:notifyIcon.BalloonTipTitle = $Title
    $script:notifyIcon.BalloonTipText = $Message
    $script:notifyIcon.ShowBalloonTip($Duration)
}

$sha = [System.Security.Cryptography.SHA256]::Create()
try {
    $projectIdentity = $projectDir.ToLowerInvariant()
    $hashBytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($projectIdentity))
    $hash = -join ($hashBytes[0..7] | ForEach-Object { $_.ToString("x2") })
} finally {
    $sha.Dispose()
}

$mutexName = "Local\DevFlowTray-$hash"
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$ownsMutex = $false
try {
    $ownsMutex = $mutex.WaitOne(0, $false)
} catch [System.Threading.AbandonedMutexException] {
    $ownsMutex = $true
}

if (-not $ownsMutex) {
    Start-Process (Get-AppUrl)
    $mutex.Dispose()
    exit 0
}

# Bootstrap through the authoritative single-instance supervisor. The tray never owns its child processes.
try {
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm run start:all" -WorkingDirectory $projectDir -WindowStyle Hidden | Out-Null
    Write-TrayLog "INFO" "Requested authoritative DevFlow supervisor startup."
} catch {
    Write-TrayLog "ERROR" "Failed to request supervisor startup: $_"
}

$menu = New-Object System.Windows.Forms.ContextMenu

$titleItem = New-Object System.Windows.Forms.MenuItem
$titleItem.Text = "DevFlow Supervisor"
$titleItem.Enabled = $false
$menu.MenuItems.Add($titleItem)
$menu.MenuItems.Add("-")

$openItem = New-Object System.Windows.Forms.MenuItem
$openItem.Text = "Open App in Browser"
$openItem.add_Click({ Start-Process (Get-AppUrl) })
$menu.MenuItems.Add($openItem)

$zrokItem = New-Object System.Windows.Forms.MenuItem
$zrokItem.Text = "Open zrok Status"
$zrokItem.add_Click({ Start-Process "$(Get-AppUrl)/api/zrok/status" })
$menu.MenuItems.Add($zrokItem)
$menu.MenuItems.Add("-")

$restartItem = New-Object System.Windows.Forms.MenuItem
$restartItem.Text = "Restart DevFlow"
$restartItem.add_Click({
    $appUrl = Get-AppUrl
    Write-TrayLog "INFO" "Requesting guarded DevFlow restart through $appUrl/api/restart."
    try {
        $result = Invoke-RestMethod -Method Post -Uri "$appUrl/api/restart" -ContentType "application/json" -Body "{}" -TimeoutSec 10
        $ticket = if ($result.ticket) { [string]$result.ticket } else { "accepted" }
        Write-TrayLog "INFO" "Guarded restart accepted: $ticket"
        Show-TrayMessage "DevFlow Restart Requested" "Guarded restart accepted ($ticket)."
    } catch {
        $message = $_.Exception.Message
        Write-TrayLog "WARN" "Guarded restart refused or failed: $message"
        Show-TrayMessage "DevFlow Restart Not Started" $message 5000
    }
})
$menu.MenuItems.Add($restartItem)
$menu.MenuItems.Add("-")

$exitItem = New-Object System.Windows.Forms.MenuItem
$exitItem.Text = "Stop Server && Exit"
$exitItem.add_Click({
    $owner = Get-RuntimeOwner
    if ($null -eq $owner -or -not $owner.controlPort -or [string]::IsNullOrWhiteSpace([string]$owner.controlToken)) {
        Show-TrayMessage "DevFlow Stop Failed" "No verified supervisor ownership record is available." 5000
        return
    }

    try {
        $headers = @{ "x-devflow-runtime-token" = [string]$owner.controlToken }
        $controlUrl = "http://127.0.0.1:$($owner.controlPort)/shutdown"
        Invoke-RestMethod -Method Post -Uri $controlUrl -Headers $headers -ContentType "application/json" -Body "{}" -TimeoutSec 10 | Out-Null
        Write-TrayLog "INFO" "Supervisor shutdown accepted for runtime $($owner.instanceId)."
        $script:notifyIcon.Visible = $false
        $script:notifyIcon.Dispose()
        [System.Windows.Forms.Application]::Exit()
    } catch {
        $message = $_.Exception.Message
        Write-TrayLog "ERROR" "Supervisor shutdown failed: $message"
        Show-TrayMessage "DevFlow Stop Failed" $message 5000
    }
})
$menu.MenuItems.Add($exitItem)

$script:notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$largeIcons = New-Object IntPtr[] 1
$smallIcons = New-Object IntPtr[] 1
[void][IconExtractor]::ExtractIconEx("$env:SystemRoot\System32\shell32.dll", 130, $largeIcons, $smallIcons, 1)

if ($smallIcons[0] -ne [IntPtr]::Zero) {
    $script:notifyIcon.Icon = [System.Drawing.Icon]::FromHandle($smallIcons[0])
} elseif ($largeIcons[0] -ne [IntPtr]::Zero) {
    $script:notifyIcon.Icon = [System.Drawing.Icon]::FromHandle($largeIcons[0])
} else {
    $script:notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
}

$script:notifyIcon.Text = "DevFlow Server"
$script:notifyIcon.ContextMenu = $menu
$script:notifyIcon.Visible = $true

try {
    [System.Windows.Forms.Application]::Run()
} finally {
    if ($script:notifyIcon) {
        $script:notifyIcon.Visible = $false
        $script:notifyIcon.Dispose()
    }
    if ($ownsMutex) {
        try { $mutex.ReleaseMutex() } catch {}
    }
    $mutex.Dispose()
}
