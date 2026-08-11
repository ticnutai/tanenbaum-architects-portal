param(
    [Parameter(Mandatory = $true)][int]$ElectronPid,
    [Parameter(Mandatory = $true)][string]$ProfileDir,
    [Parameter(Mandatory = $true)][int]$WorkX,
    [Parameter(Mandatory = $true)][int]$WorkY,
    [Parameter(Mandatory = $true)][int]$WorkWidth,
    [Parameter(Mandatory = $true)][int]$WorkHeight
)

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class MavatWindowLayout {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter,
        int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
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

$electronHandle = Get-MainWindowHandle $ElectronPid
if ($electronHandle -eq [IntPtr]::Zero) {
    throw "Active Electron window was not found"
}

$normalizedProfile = [IO.Path]::GetFullPath($ProfileDir)
$chromeHandle = [IntPtr]::Zero
$chromePid = 0
for ($attempt = 0; $attempt -lt 50 -and $chromeHandle -eq [IntPtr]::Zero; $attempt++) {
    $candidate = Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq "chrome.exe" -and
        $_.CommandLine -and
        $_.CommandLine.IndexOf($normalizedProfile, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $_.CommandLine -notmatch "--type="
    } | Sort-Object CreationDate -Descending | Select-Object -First 1
    if ($candidate) {
        $chromePid = [int]$candidate.ProcessId
        $chromeHandle = Get-MainWindowHandle $chromePid
    }
    if ($chromeHandle -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 200 }
}
if ($chromeHandle -eq [IntPtr]::Zero) {
    throw "The dedicated Google Chrome automation window was not found"
}

$outerMargin = 6
$gap = 8
$usableWidth = $WorkWidth - ($outerMargin * 2) - $gap
$chromeWidth = [Math]::Round($usableWidth * 0.50)
$electronWidth = $usableWidth - $chromeWidth
$height = $WorkHeight - ($outerMargin * 2)
$chromeX = $WorkX + $outerMargin
$electronX = $chromeX + $chromeWidth + $gap
$top = $WorkY + $outerMargin

[MavatWindowLayout]::ShowWindowAsync($chromeHandle, 9) | Out-Null
[MavatWindowLayout]::ShowWindowAsync($electronHandle, 9) | Out-Null
$hwndTopmost = [IntPtr](-1)
$hwndNotTopmost = [IntPtr](-2)
$showWindow = 0x0040
[MavatWindowLayout]::SetWindowPos($chromeHandle, $hwndTopmost, $chromeX, $top, $chromeWidth, $height, $showWindow) | Out-Null
[MavatWindowLayout]::SetWindowPos($electronHandle, $hwndTopmost, $electronX, $top, $electronWidth, $height, $showWindow) | Out-Null
[MavatWindowLayout]::SetWindowPos($chromeHandle, $hwndNotTopmost, $chromeX, $top, $chromeWidth, $height, $showWindow) | Out-Null
[MavatWindowLayout]::SetWindowPos($electronHandle, $hwndNotTopmost, $electronX, $top, $electronWidth, $height, $showWindow) | Out-Null
[MavatWindowLayout]::BringWindowToTop($chromeHandle) | Out-Null
[MavatWindowLayout]::BringWindowToTop($electronHandle) | Out-Null
[MavatWindowLayout]::SetForegroundWindow($electronHandle) | Out-Null

@{
    ok = $true
    electron_pid = $ElectronPid
    chrome_pid = $chromePid
    chrome = @{ x = $chromeX; y = $top; width = $chromeWidth; height = $height }
    electron = @{ x = $electronX; y = $top; width = $electronWidth; height = $height }
} | ConvertTo-Json -Compress
