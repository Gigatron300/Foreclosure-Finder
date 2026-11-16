# Asks which folder the court documents go into, remembers it, and puts a shortcut on the desktop.
# Run by Setup.bat. -PropertiesDir skips the folder window (used for testing).
param([string]$PropertiesDir = '', [switch]$NoShortcut)

$root = Split-Path -Parent $PSScriptRoot

if (-not $PropertiesDir) {
    Add-Type -AssemblyName System.Windows.Forms
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'Choose the PROPERTIES folder: the shared OneDrive folder that holds one folder per property.'
    $dialog.ShowNewFolderButton = $false
    $oneDrive = $env:OneDrive
    if ($oneDrive -and (Test-Path $oneDrive)) { $dialog.SelectedPath = $oneDrive }
    $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
    if ($dialog.ShowDialog($owner) -ne [System.Windows.Forms.DialogResult]::OK) {
        Write-Host ''
        Write-Host ' No folder was chosen, so setup is not finished. Run Setup again when ready.'
        exit 1
    }
    $PropertiesDir = $dialog.SelectedPath
}

if (-not (Test-Path $PropertiesDir -PathType Container)) {
    Write-Host " That folder does not exist: $PropertiesDir"
    exit 1
}

# Plain UTF-8 without a byte-order mark, so the helper can read it as JSON.
$json = @{ propertiesDir = (Resolve-Path $PropertiesDir).Path } | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $root 'court-docs-helper.config.json'), $json, (New-Object System.Text.UTF8Encoding($false)))

if (-not $NoShortcut) {
    $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Court Docs Helper.lnk'
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
    $shortcut.TargetPath = Join-Path $root 'Start Court Docs Helper.bat'
    $shortcut.WorkingDirectory = $root
    $shortcut.Description = 'Pulls NJ court filings for cards ticked on the Camden Pipeline page'
    $shortcut.Save()
}

Write-Host ''
Write-Host ' Setup is finished.'
Write-Host " Court documents will be saved in: $((Resolve-Path $PropertiesDir).Path)"
if (-not $NoShortcut) { Write-Host ' Start the helper with the "Court Docs Helper" shortcut on the desktop.' }
