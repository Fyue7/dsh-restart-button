# dsh-restart-button - the relay: kills the old DSH, then starts a new one.
#
# WHY THE RELAY DOES THE KILLING NOW
#   It used to be the helper (restart-dsh.ps1) that killed things, and the relay
#   only waited and launched. Since the DSH host started handing its children a
#   restricted token, the helper can still SEE the processes but Stop-Process on
#   them fails silently: measured on 2026-10-09 23:12, it asked the OS to kill 7
#   and only one died, while the other six kept their original creation times.
#   The relay is created by the Task Scheduler service with the user's own token,
#   so it is not inside that confinement and can kill normally.
#
# WHAT IT DOES, IN ORDER
#   1. wait for the caller's HTTP response to get home
#   2. kill every process carrying the image name, ROOTS FIRST (the Electron main
#      process before its GPU / utility / renderer / host children, so nothing can
#      respawn), up to four rounds until the list is empty
#   3. launch the new instance through explorer.exe, so the new process does not
#      inherit a console (closing a terminal window must never kill DSH)
#   4. wait for 127.0.0.1:<port> to listen again, drop the scheduled task, log
#
# WHERE THE ARGUMENTS COME FROM
#   schtasks /TR is capped at 261 characters, so the scheduled task passes no
#   arguments: the helper leaves them in relay-config.json and this script reads
#   them. Explicit parameters always win (manual runs).
#
# ASCII ONLY, ON PURPOSE
#   Windows PowerShell 5.1 reads a .ps1 without a BOM as ANSI; a UTF-8 Chinese
#   comment can swallow the newline and merge the next code line into the comment.

[CmdletBinding()]
param(
	[string]$ExePath = '',
	[string]$LogPath = '',
	[int]$Port = 0,
	[int]$WaitSeconds = 0,
	[switch]$DryRun
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

# Always have somewhere to write: a missing config used to make the relay fail in
# total silence.
if ([string]::IsNullOrWhiteSpace($LogPath)) {
	$LogPath = Join-Path $env:USERPROFILE '.dsh\dsh-restart-button\restart.log'
}
if ($Port -le 0) { $Port = 19387 }
if ($WaitSeconds -le 0) { $WaitSeconds = 20 }

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
$t0 = Get-Date

Write-Log "relay start: pid=$PID exe='$ExePath' wait=${WaitSeconds}s port=$Port consoleHidden=$hidden config='$configPath' dryRun=$($DryRun.IsPresent)"

if ([string]::IsNullOrWhiteSpace($ExePath)) {
	Write-Log 'relay abort: no exe path (config missing and no -ExePath given)'
	try { & schtasks.exe /Delete /TN 'dsh-restart-button-relay' /F 2>&1 | Out-Null } catch { }
	exit 1
}

$image = [System.IO.Path]::GetFileNameWithoutExtension($ExePath)

function Get-Targets {
	@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq $image })
}

if ($DryRun) {
	$targets = @(Get-Targets)
	Write-Log "dryrun: visible '$image' = $($targets.Count): $((($targets | ForEach-Object { $_.Id }) -join ','))"
	Write-Log "dryrun: would run: taskkill /F /T /IM `"$image.exe`", then a Stop-Process sweep, up to 4 rounds"
	Write-Log 'dryrun: nothing was touched'
	exit 0
}

# 1. Let the caller's HTTP response get home before anything is killed.
Start-Sleep -Milliseconds 1200

# 2. Kill, up to four rounds.
#    taskkill /T walks each matched process's tree, so the Electron main process
#    and its GPU / utility / renderer / host children go together and a half-dead
#    tree cannot respawn anything. A per-pid sweep follows as a belt-and-braces
#    pass for whatever survived.
#    (No parent-process heuristic here: Get-Process objects do not carry
#    ParentProcessId at all, which silently made every process look like a root.)
$taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
$round = 0
while ($round -lt 4) {
	$targets = @(Get-Targets)
	if ($targets.Count -eq 0) { break }
	$round++
	Write-Log "kill round ${round}: alive=$($targets.Count) pid=$((($targets | ForEach-Object { $_.Id }) -join ','))"

	if (Test-Path -LiteralPath $taskkill) {
		$out = (& $taskkill /F /T /IM "$image.exe" 2>&1 | Out-String).Trim()
		Write-Log "taskkill: $($out -replace "`r?`n", ' | ')"
		Start-Sleep -Milliseconds 400
	}

	foreach ($p in @(Get-Targets)) {
		try {
			Stop-Process -Id $p.Id -Force -ErrorAction Stop
		} catch {
			Write-Log "stop-process $($p.Id) failed: $($_.Exception.Message)"
		}
	}
	Start-Sleep -Milliseconds 400
}

$remaining = @(Get-Targets).Count
Write-Log "after killing: remaining=$remaining (rounds=$round, elapsed=$([int]((Get-Date) - $t0).TotalMilliseconds)ms)"

# 3. Wait for the tree to be really gone before starting anything: a second
#    instance would fight over Electron's single-instance lock and crash its
#    renderer.
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

# 4. Launch through explorer: no console is inherited, so closing a terminal
#    window can never take DSH with it.
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
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
	Write-Log "ok: 127.0.0.1:$Port is listening again (total=$([int]((Get-Date) - $t0).TotalMilliseconds)ms)"
} else {
	Write-Log "warn: port $Port did not come up within 120s"
}

# When the task was created by the scheduler, the one-shot definition would stay
# behind; drop it now that the job is done.
try {
	& schtasks.exe /Delete /TN 'dsh-restart-button-relay' /F 2>&1 | Out-Null
	Write-Log 'relay: scheduled task removed'
} catch { }

exit 0
