# dsh-restart-button - the relay: waits for the old DSH to be gone, then starts a new one.
#
# WHY THIS FILE EXISTS
#   The helper that kills DSH is a descendant of the DSH host. When the host dies,
#   the job object takes the helper with it, so anything the helper does AFTER the
#   kill (starting the new instance) never happens. This relay is therefore started
#   BEFORE the kill, by something outside that job (a scheduled task, WMI, or the
#   shell). It survives, waits, and brings DSH back.
#
# WHY IT WAITS FOR "GONE" INSTEAD OF SLEEPING
#   The first version slept a fixed five seconds and then launched. When the kill
#   ran late, that started a second instance while the first still held Electron's
#   single-instance lock - the fresh renderer crashed and the shell showed
#   "Desktop renderer exited: crashed". Now it polls for the image to disappear and
#   only launches once it really is gone; if the old instance is still alive after
#   the wait budget it refuses to launch rather than create a second one.
#
# WHERE THE ARGUMENTS COME FROM
#   schtasks /TR is capped at 261 characters, so the scheduled task passes no
#   arguments at all: the helper leaves them in relay-config.json and this script
#   reads them. Explicit parameters always win, which is what manual runs use.
#
# ASCII ONLY, ON PURPOSE
#   Windows PowerShell 5.1 reads a .ps1 without a BOM as ANSI; a UTF-8 Chinese
#   comment can then swallow the newline and merge the next code line into the
#   comment. Keep this file ASCII.

[CmdletBinding()]
param(
	[string]$ExePath = '',
	[string]$LogPath = '',
	[int]$Port = 0,
	[int]$WaitSeconds = 0
)

$ErrorActionPreference = 'Continue'

$configPath = Join-Path $env:USERPROFILE '.dsh\dsh-restart-button\relay-config.json'
try {
	if (Test-Path -LiteralPath $configPath) {
		$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
		if ([string]::IsNullOrWhiteSpace($ExePath)) { $ExePath = [string]$config.exePath }
		if ([string]::IsNullOrWhiteSpace($LogPath)) { $LogPath = [string]$config.logPath }
		if ($Port -le 0 -and $null -ne $config.port) { $Port = [int]$config.port }
		if ($WaitSeconds -le 0 -and $null -ne $config.delaySeconds) { $WaitSeconds = [int]$config.delaySeconds }
	}
} catch { }

# Always have somewhere to write. Without this the relay used to fail in silence:
# no config meant no log path, so nothing anywhere recorded what it did.
if ([string]::IsNullOrWhiteSpace($LogPath)) {
	$LogPath = Join-Path $env:USERPROFILE '.dsh\dsh-restart-button\restart.log'
}
if ($Port -le 0) { $Port = 19387 }
if ($WaitSeconds -le 0) { $WaitSeconds = 20 }

# Started by the Task Scheduler (or WMI, or the shell) as a console program, so
# Windows may hand it a console window; hide it before doing anything else.
function Hide-OwnConsole {
	try {
		$code = @'
using System;
using System.Runtime.InteropServices;
public class DshRelayConsoleWindow {
	[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
	[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
	public static bool Hide() {
		IntPtr h = GetConsoleWindow();
		if (h == IntPtr.Zero) { return false; }
		return ShowWindow(h, 0);
	}
}
'@
		Add-Type -TypeDefinition $code -ErrorAction Stop
		return [DshRelayConsoleWindow]::Hide()
	} catch {
		return $false
	}
}

function Write-Log([string]$message) {
	if ([string]::IsNullOrWhiteSpace($LogPath)) { return }
	try {
		$dir = Split-Path -Parent $LogPath
		if ($dir -and -not (Test-Path -LiteralPath $dir)) {
			New-Item -ItemType Directory -Force -Path $dir | Out-Null
		}
		$stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
		Add-Content -LiteralPath $LogPath -Value "[$stamp] $message" -Encoding UTF8
	} catch { }
}

$hidden = Hide-OwnConsole

Write-Log "relay start: pid=$PID exe='$ExePath' wait=${WaitSeconds}s port=$Port consoleHidden=$hidden config='$configPath'"

if ([string]::IsNullOrWhiteSpace($ExePath)) {
	Write-Log 'relay abort: no exe path (config missing and no -ExePath given)'
	try { & schtasks.exe /Delete /TN 'dsh-restart-button-relay' /F 2>&1 | Out-Null } catch { }
	exit 1
}

$image = [System.IO.Path]::GetFileNameWithoutExtension($ExePath)

function Get-Targets {
	@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq $image })
}

# Wait for the old instance to be gone. Launching on a fixed timer risked a second
# instance while the first still held the single-instance lock - that is what
# crashed the renderer.
$deadline = (Get-Date).AddSeconds([Math]::Max($WaitSeconds, 1))
while ((Get-Date) -lt $deadline -and @(Get-Targets).Count -gt 0) {
	Start-Sleep -Milliseconds 250
}

$left = @(Get-Targets).Count
if ($left -gt 0) {
	Write-Log "relay abort: $left '$image' process(es) still alive after ${WaitSeconds}s; not launching a second instance"
	try { & schtasks.exe /Delete /TN 'dsh-restart-button-relay' /F 2>&1 | Out-Null } catch { }
	exit 2
}

Write-Log 'relay: old instance is gone, launching in 600ms'
Start-Sleep -Milliseconds 600

# Never hand the host's own run mode to the window instance.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# Launch through explorer instead of from this process.
# Start-Process made DSH a child of THIS console; Chromium attaches to its parent
# console for logging, so the terminal window stayed alive as long as DSH did - and
# closing that window sent CTRL_CLOSE to DSH, which killed it. Explorer has no
# console, so the fresh instance belongs to nobody here.
$launched = $false
$explorer = Join-Path $env:SystemRoot 'explorer.exe'
if (Test-Path -LiteralPath $explorer) {
	try {
		& $explorer $ExePath | Out-Null
		$launched = $true
		Write-Log "relay launched via explorer: $ExePath"
	} catch {
		Write-Log "relay: explorer launch threw: $($_.Exception.Message)"
	}
}
if (-not $launched) {
	try {
		Start-Process -FilePath $ExePath -WorkingDirectory (Split-Path -Parent $ExePath)
		Write-Log "relay launched directly (explorer unavailable): $ExePath"
	} catch {
		Write-Log "relay launch failed: $($_.Exception.Message)"
		exit 1
	}
}

# Confirm the new instance actually appeared, instead of trusting the launch call.
$appeared = $false
$seenUntil = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $seenUntil) {
	if (@(Get-Targets).Count -gt 0) { $appeared = $true; break }
	Start-Sleep -Milliseconds 300
}
Write-Log "relay: new instance visible = $appeared"

$ready = $false
$until = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $until) {
	$client = $null
	try {
		$client = New-Object System.Net.Sockets.TcpClient
		$client.Connect('127.0.0.1', $Port)
		$ready = $true
		break
	} catch {
		Start-Sleep -Milliseconds 400
	} finally {
		if ($client) { try { $client.Close() } catch { } }
	}
}

if ($ready) {
	Write-Log "ok: 127.0.0.1:$Port is listening again"
} else {
	Write-Log "warn: port $Port did not come up within 120s"
}

# When the relay was started by the Task Scheduler service, the one-shot task
# definition would stay behind; drop it now that the job is done.
try {
	& schtasks.exe /Delete /TN 'dsh-restart-button-relay' /F 2>&1 | Out-Null
	Write-Log 'relay: scheduled task removed'
} catch { }

exit 0
