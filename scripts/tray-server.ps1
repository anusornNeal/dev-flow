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

# Avoid multiple instances running at the same time by killing existing ones on port 3000
foreach ($p in (netstat -ano | Select-String ":3000" | ForEach-Object { $_.Line.Split(' ', [StringSplitOptions]::RemoveEmptyEntries)[-1] })) {
    if ($p -ne "0") {
        try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch {}
    }
}

# Start process
$process = Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm run dev" -WorkingDirectory $projectDir -WindowStyle Hidden -PassThru

# Start ngrok process
$ngrokCommandArgs = "http 3000" # NOTE: Change to "http --domain=YOUR_DOMAIN.ngrok-free.app 3000" if you have a static domain
$ngrokProcess = Start-Process -FilePath "ngrok.exe" -ArgumentList $ngrokCommandArgs -WindowStyle Hidden -PassThru

# UI Context
$menu = New-Object System.Windows.Forms.ContextMenu

$titleItem = New-Object System.Windows.Forms.MenuItem
$titleItem.Text = "DevFlow + ngrok (Running)"
$titleItem.Enabled = $false
$menu.MenuItems.Add($titleItem)

$menu.MenuItems.Add("-")

$openItem = New-Object System.Windows.Forms.MenuItem
$openItem.Text = "Open App in Browser"
$openItem.add_Click({
    Start-Process "http://localhost:3000"
})
$menu.MenuItems.Add($openItem)

$ngrokItem = New-Object System.Windows.Forms.MenuItem
$ngrokItem.Text = "Open ngrok Dashboard"
$ngrokItem.add_Click({
    Start-Process "http://localhost:4040"
})
$menu.MenuItems.Add($ngrokItem)

$menu.MenuItems.Add("-")

$restartItem = New-Object System.Windows.Forms.MenuItem
$restartItem.Text = "Restart DevFlow"
$restartItem.add_Click({
    $logFile = Join-Path $projectDir "logs\tray.log"
    if (-not (Test-Path (Join-Path $projectDir "logs"))) { New-Item -ItemType Directory -Path (Join-Path $projectDir "logs") | Out-Null }
    
    $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ"
    Add-Content -Path $logFile -Value "[$timestamp] [INFO] Restarting DevFlow..."
    
    try {
        Start-Process "taskkill" -ArgumentList "/T /F /PID $($script:process.Id)" -WindowStyle Hidden -Wait
    } catch {}
    try {
        Start-Process "taskkill" -ArgumentList "/T /F /PID $($script:ngrokProcess.Id)" -WindowStyle Hidden -Wait
    } catch {}
    
    foreach ($p in (netstat -ano | Select-String ":3000" | ForEach-Object { $_.Line.Split(' ', [StringSplitOptions]::RemoveEmptyEntries)[-1] })) {
        if ($p -ne "0") {
            try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch {}
        }
    }
    try { Stop-Process -Name "ngrok" -Force -ErrorAction SilentlyContinue } catch {}
    
    try {
        $script:process = Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm run dev" -WorkingDirectory $projectDir -WindowStyle Hidden -PassThru
        $ngrokCommandArgs = "http 3000"
        $script:ngrokProcess = Start-Process -FilePath "ngrok.exe" -ArgumentList $ngrokCommandArgs -WindowStyle Hidden -PassThru
        
        $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ"
        Add-Content -Path $logFile -Value "[$timestamp] [INFO] Restart succeeded. New PID: $($script:process.Id)"
        
        $script:notifyIcon.BalloonTipTitle = "DevFlow Restarted"
        $script:notifyIcon.BalloonTipText = "DevFlow has been restarted successfully."
        $script:notifyIcon.ShowBalloonTip(3000)
    } catch {
        $timestamp = Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ"
        Add-Content -Path $logFile -Value "[$timestamp] [ERROR] Restart failed: $_"
        
        $script:notifyIcon.BalloonTipTitle = "DevFlow Restart Failed"
        $script:notifyIcon.BalloonTipText = "Check logs/tray.log for details."
        $script:notifyIcon.ShowBalloonTip(5000)
    }
})
$menu.MenuItems.Add($restartItem)

$menu.MenuItems.Add("-")

$exitItem = New-Object System.Windows.Forms.MenuItem
$exitItem.Text = "Stop Server && Exit"
$exitItem.add_Click({
    try {
        Start-Process "taskkill" -ArgumentList "/T /F /PID $($script:process.Id)" -WindowStyle Hidden -Wait
    } catch {}
    try {
        Start-Process "taskkill" -ArgumentList "/T /F /PID $($script:ngrokProcess.Id)" -WindowStyle Hidden -Wait
    } catch {}
    
    foreach ($p in (netstat -ano | Select-String ":3000" | ForEach-Object { $_.Line.Split(' ', [StringSplitOptions]::RemoveEmptyEntries)[-1] })) {
        if ($p -ne "0") {
            try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch {}
        }
    }
    # Also kill any lingering ngrok processes just in case
    try { Stop-Process -Name "ngrok" -Force -ErrorAction SilentlyContinue } catch {}
    
    $script:notifyIcon.Visible = $false
    $script:notifyIcon.Dispose()
    [System.Windows.Forms.Application]::Exit()
})
$menu.MenuItems.Add($exitItem)

$script:process = $process
$script:ngrokProcess = $ngrokProcess
$script:notifyIcon = New-Object System.Windows.Forms.NotifyIcon

# Extract the star icon from shell32.dll (index 130)
$largeIcons = New-Object IntPtr[] 1
$smallIcons = New-Object IntPtr[] 1
$extracted = [IconExtractor]::ExtractIconEx("$env:SystemRoot\System32\shell32.dll", 130, $largeIcons, $smallIcons, 1)

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

# Wait a bit then open browser
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 4000
$timer.add_Tick({
    $timer.Stop()
    Start-Process "http://localhost:3000"
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
