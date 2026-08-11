$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'tray-server.ps1'), [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -gt 0) {
    foreach ($errorItem in $errors) { Write-Error $errorItem.Message }
    exit 1
}
Write-Output '[verify-tray-parse] syntax ok'
