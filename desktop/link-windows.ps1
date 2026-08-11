param(
    [Parameter(Mandatory = $true)][int]$ElectronPid,
    [Parameter(Mandatory = $true)][string]$ProfileDir
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class MavatLinkedWindows {
    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
"@

function Get-MainWindowHandle([int]$ProcessId) {
    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        $process.Refresh()
        return $process.MainWindowHandle
    } catch {
        return [IntPtr]::Zero
    }
}

function Get-ChromeProcess([string]$ProfilePath) {
    $normalizedProfile = [IO.Path]::GetFullPath($ProfilePath)
    return Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq "chrome.exe" -and
        $_.CommandLine -and
        $_.CommandLine.IndexOf($normalizedProfile, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $_.CommandLine -notmatch "--type="
    } | Sort-Object CreationDate -Descending | Select-Object -First 1
}

$electronHandle = [IntPtr]::Zero
$chromeHandle = [IntPtr]::Zero
for ($attempt = 0; $attempt -lt 120 -and ($electronHandle -eq [IntPtr]::Zero -or $chromeHandle -eq [IntPtr]::Zero); $attempt++) {
    $electronHandle = Get-MainWindowHandle $ElectronPid
    $chrome = Get-ChromeProcess $ProfileDir
    if ($chrome) { $chromeHandle = Get-MainWindowHandle ([int]$chrome.ProcessId) }
    if ($electronHandle -eq [IntPtr]::Zero -or $chromeHandle -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 250 }
}
if ($electronHandle -eq [IntPtr]::Zero -or $chromeHandle -eq [IntPtr]::Zero) { exit 2 }

function Set-LinkedWindowState([bool]$Minimized) {
    $command = if ($Minimized) { 6 } else { 9 }
    [MavatLinkedWindows]::ShowWindowAsync($electronHandle, $command) | Out-Null
    [MavatLinkedWindows]::ShowWindowAsync($chromeHandle, $command) | Out-Null
    for ($attempt = 0; $attempt -lt 24; $attempt++) {
        $electronState = [MavatLinkedWindows]::IsIconic($electronHandle)
        $chromeState = [MavatLinkedWindows]::IsIconic($chromeHandle)
        if ($electronState -eq $Minimized -and $chromeState -eq $Minimized) { return $true }
        Start-Sleep -Milliseconds 50
    }
    return $false
}

$electronMinimized = [MavatLinkedWindows]::IsIconic($electronHandle)
$chromeMinimized = [MavatLinkedWindows]::IsIconic($chromeHandle)
if ($electronMinimized -ne $chromeMinimized) {
    Set-LinkedWindowState $false | Out-Null
    $groupMinimized = $false
} else {
    $groupMinimized = $electronMinimized
}

while ($true) {
    if (-not [MavatLinkedWindows]::IsWindow($electronHandle) -or -not [MavatLinkedWindows]::IsWindow($chromeHandle)) { break }
    $electronMinimized = [MavatLinkedWindows]::IsIconic($electronHandle)
    $chromeMinimized = [MavatLinkedWindows]::IsIconic($chromeHandle)

    if ($electronMinimized -eq $chromeMinimized) {
        $groupMinimized = $electronMinimized
    } else {
        # The window that differs from the last stable group state is the one
        # the user just changed. Apply that state to both and wait for Win32.
        $desiredState = if ($electronMinimized -ne $groupMinimized) {
            $electronMinimized
        } elseif ($chromeMinimized -ne $groupMinimized) {
            $chromeMinimized
        } else {
            $groupMinimized
        }
        Set-LinkedWindowState $desiredState | Out-Null
        $groupMinimized = $desiredState
    }
    Start-Sleep -Milliseconds 180
}
