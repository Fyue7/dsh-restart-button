# dsh-restart-button - the helper that arms the relay and kills DSH.
#
# WHY THE RELAY EXISTS AT ALL
#   Everything inside this process tree dies together with the DSH host: the host
#   runs inside a job object, and a child that kills it is killed by the same
#   closing job. Measured: even a process handed to the shell via
#   Shell.Application.ShellExecute died at the exact moment the host did, four
#   seconds before it was due to launch anything.
#
#   So the relay must be created by something that is NOT in this tree: the Task
#   Scheduler service, or the WMI service. This script tries, in order:
#     1. schtasks  - one-shot task, the service creates the process, and it runs in
#                    the user's interactive session; the relay deletes it afterwards.
#     2. WMI       - Win32_Process.Create through WmiPrvSE.
#     3. shell     - Shell.Application.ShellExecute (kept as a last resort).
#     4. inline    - this process launches DSH itself, hoping it survives.
#   After each attempt it re-reads the log to see whether the relay actually
#   started; the winner is written to the log. Only then does it kill DSH.
#
# NO VISIBLE WINDOW, ANYWHERE
#   This is a console program, so Windows hands it a console window even when it
#   was started by a service or by the plugin. Hide-OwnConsole gets rid of it in
#   the first few milliseconds. The scheduled task no longer goes through a .cmd
#   either: the relay invocation is base64-encoded into a single -EncodedCommand
#   argument, so the Task Scheduler starts powershell.exe directly, with
#   -WindowStyle Hidden and no cmd.exe in between. Orphaned console windows were
#   exactly the "cmd stays behind after the restart" report.
#
# ASCII ONLY, ON PURPOSE
#   Windows PowerShell 5.1 reads a .ps1 without a BOM as ANSI; a UTF-8 Chinese
#   comment can then swallow the newline and merge the next code line into the
#   comment. That bug silently skipped `$alive = Get-Targets` once and cost three
#   rounds of debugging. Keep this file ASCII.

[CmdletBinding()]
param(
	[Parameter(Mandatory = $true)][string]$ExePath,
	[string]$LogPath = '',
	[int]$GraceSeconds = 8,
	[string]$Caller = '',
	[switch]$DryRun
)

# SilentlyContinue, not Continue: schtasks writes its warning to stderr, and with
# Continue PowerShell turns that into a printed error record even though the call
# succeeded. We read the captured text ourselves and log it.
$ErrorActionPreference = 'SilentlyContinue'
$Port = 19387
# How long the relay waits for the old instance to disappear before giving up.
# It used to be a blind fixed delay, and launching while the old instance still
# held the single-instance lock crashed the fresh renderer.
$RelayDelaySeconds = 20
$TaskName = 'dsh-restart-button-relay'
$t0 = Get-Date

function Hide-OwnConsole {
	try {
		$code = @'
using System;
using System.Runtime.InteropServices;
public class DshConsoleWindow {
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
		return [DshConsoleWindow]::Hide()
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

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$relay = Join-Path $here 'relaunch-dsh.ps1'
# NOT $home: that name collides with PowerShell's automatic $HOME (variable names
# are case-insensitive), and the assignment then silently does nothing - which sent
# relay-config.json to C:\Users\<user>\ and left the relay with no arguments at all.
$pluginHome = if ([string]::IsNullOrWhiteSpace($LogPath)) { $here } else { Split-Path -Parent $LogPath }
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

Write-Log "helper start: pid=$PID exe='$ExePath' grace=${GraceSeconds}s caller='$Caller' dryRun=$($DryRun.IsPresent) relay='$relay' consoleHidden=$hidden"

if (-not (Test-Path -LiteralPath $ExePath)) {
	Write-Log "abort: exe not found: $ExePath"
	exit 1
}

$image = [System.IO.Path]::GetFileNameWithoutExtension($ExePath)

function Get-Targets {
	@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq $image })
}

function Get-RelayStartCount {
	try {
		if ([string]::IsNullOrWhiteSpace($LogPath) -or -not (Test-Path -LiteralPath $LogPath)) { return 0 }
		return @(Select-String -LiteralPath $LogPath -Pattern 'relay start' -SimpleMatch -ErrorAction SilentlyContinue).Count
	} catch {
		return 0
	}
}

# schtasks caps /TR at 261 characters, so the task carries no arguments at all:
# the relay reads its instructions from this config file instead. The task action
# is powershell.exe itself with -WindowStyle Hidden, so no cmd.exe - and therefore
# no console window - is involved.
function Write-RelayConfig {
	$configPath = Join-Path $pluginHome 'relay-config.json'
	$payload = [ordered]@{
		exePath = $ExePath
		logPath = $LogPath
		port = $Port
		delaySeconds = $RelayDelaySeconds
		caller = $Caller
		writtenAt = (Get-Date).ToString('o')
	}
	try {
		($payload | ConvertTo-Json) | Set-Content -LiteralPath $configPath -Encoding UTF8
		return $configPath
	} catch {
		Write-Log "cannot write relay config '$configPath': $($_.Exception.Message)"
		return ''
	}
}

# wscript.exe is a GUI-subsystem host: Windows creates no console for it at all,
# and window style 0 keeps the relay hidden too. Launching powershell.exe straight
# from the Task Scheduler opened a Windows Terminal window instead (this machine's
# default console host), where -WindowStyle Hidden does nothing.
function Write-RelayLauncher {
	$vbsPath = Join-Path $pluginHome 'relay-launch.vbs'
	$vbsLine = 'sh.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ""' + $relay + '""", 0, True'
	$lines = @(
		'Set sh = CreateObject("WScript.Shell")',
		'rem written by restart-dsh.ps1 - runs the relay with no console window',
		$vbsLine
	)
	try {
		Set-Content -LiteralPath $vbsPath -Value $lines -Encoding ASCII
		return $vbsPath
	} catch {
		Write-Log "cannot write relay launcher '$vbsPath': $($_.Exception.Message)"
		return ''
	}
}

function Wait-RelayStart([int]$baseline, [int]$milliseconds) {
	$deadline = (Get-Date).AddMilliseconds($milliseconds)
	while ((Get-Date) -lt $deadline) {
		if ((Get-RelayStartCount) -gt $baseline) { return $true }
		Start-Sleep -Milliseconds 250
	}
	return ((Get-RelayStartCount) -gt $baseline)
}

function Arm-Relay {
	if (-not (Test-Path -LiteralPath $relay)) {
		Write-Log "relay script missing at '$relay'"
		return 'none'
	}

	$baseline = Get-RelayStartCount
	$configPath = Write-RelayConfig
	$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
	$launcher = if (Test-Path -LiteralPath $wscript) { Write-RelayLauncher } else { '' }
	if ($launcher -ne '') {
		$psArgs = "//B `"$launcher`""
		$taskCmd = "$wscript $psArgs"
	} else {
		$psArgs = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File $relay"
		$taskCmd = "$psExe $psArgs"
	}
	Write-Log "relay: arming (baseline relay-start lines = $baseline, config = '$configPath', launcher = '$launcher', taskCmdLength = $($taskCmd.Length))"

	# 1. Scheduled task: the Task Scheduler service creates the process, outside this job.
	try {
		$create = (& schtasks.exe /Create /TN $TaskName /TR $taskCmd /SC ONCE /ST 00:00 /F 2>&1 | Out-String).Trim()
		Write-Log "relay: schtasks create -> $create"
		$run = (& schtasks.exe /Run /TN $TaskName 2>&1 | Out-String).Trim()
		Write-Log "relay: schtasks run -> $run"
		if (Wait-RelayStart $baseline 4000) { return 'schtasks' }
		Write-Log "relay: schtasks did not produce a live relay"
	} catch {
		Write-Log "relay: schtasks threw: $($_.Exception.Message)"
	}

	# 2. WMI: Win32_Process.Create runs inside WmiPrvSE, also outside this job.
	try {
		$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $taskCmd } -ErrorAction Stop
		Write-Log "relay: wmi create rc=$($res.ReturnValue) pid=$($res.ProcessId)"
		if (Wait-RelayStart $baseline 4000) { return 'wmi' }
		Write-Log "relay: wmi did not produce a live relay"
	} catch {
		Write-Log "relay: wmi threw: $($_.Exception.Message)"
	}

	# 3. Shell handoff. Measured to stay inside the job, so it is only a fallback.
	try {
		$shell = New-Object -ComObject Shell.Application
		$shell.ShellExecute($wscript, $psArgs, $here, 'open', 0)
		if (Wait-RelayStart $baseline 4000) { return 'shell' }
		Write-Log "relay: shell handoff did not produce a live relay"
	} catch {
		Write-Log "relay: shell handoff threw: $($_.Exception.Message)"
	}

	return 'inline'
}

$visible = @(Get-Targets)

if ($DryRun) {
	Write-Log "dryrun: visible '$image' processes = $($visible.Count): $((($visible | ForEach-Object { $_.Id }) -join ','))"
	Write-Log "dryrun: relay script present = $(Test-Path -LiteralPath $relay)"
	Write-Log "dryrun: would arm the relay (schtasks -> wmi -> shell), then kill the list above"
	Write-Log "dryrun: done, nothing was touched (elapsed=$([int]((Get-Date) - $t0).TotalMilliseconds)ms)"
	exit 0
}

# 0. Let the caller's HTTP response get home before anything is killed.
Start-Sleep -Milliseconds 700

# 1. Arm the relay first, through whichever creator actually works.
$relayVia = Arm-Relay
Write-Log "relay armed via: $relayVia"

# 2. Kill everything carrying the image name (host and shell are the same file).
$alive = @(Get-Targets)
Write-Log "stage1: alive=$($alive.Count) pid=$((($alive | ForEach-Object { $_.Id }) -join ','))"
foreach ($p in $alive) {
	try { $null = $p.CloseMainWindow() } catch { }
}

$politeBudget = [Math]::Min([Math]::Max($GraceSeconds, 1), 2)
$deadline = (Get-Date).AddSeconds($politeBudget)
while ((Get-Date) -lt $deadline -and @(Get-Targets).Count -gt 0) {
	Start-Sleep -Milliseconds 200
}

$left = @(Get-Targets)
if ($left.Count -gt 0) {
	Write-Log "stage2: force kill $($left.Count) pid=$((($left | ForEach-Object { $_.Id }) -join ','))"
	foreach ($p in $left) {
		try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { }
	}
	$deadline2 = (Get-Date).AddSeconds(10)
	while ((Get-Date) -lt $deadline2 -and @(Get-Targets).Count -gt 0) {
		Start-Sleep -Milliseconds 200
	}
}

$remaining = @(Get-Targets).Count
if ($remaining -gt 0) {
	Write-Log "warn: $remaining process(es) still alive after the force kill"
} else {
	Write-Log "clean: all '$image' processes are gone"
}

# 3. Only when nothing else worked is this process the last hope. Launch through
#    explorer even here: a direct Start-Process would make DSH a child of this
#    console, and closing that window would take DSH down with it.
if ($relayVia -eq 'inline' -or $relayVia -eq 'none') {
	Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
	$explorer = Join-Path $env:SystemRoot 'explorer.exe'
	if (Test-Path -LiteralPath $explorer) {
		try {
			& $explorer $ExePath | Out-Null
			Write-Log "inline launch via explorer sent: $ExePath"
		} catch {
			Write-Log "inline explorer launch threw: $($_.Exception.Message)"
		}
	} else {
		try {
			Start-Process -FilePath $ExePath -WorkingDirectory (Split-Path -Parent $ExePath)
			Write-Log "inline launch sent: $ExePath"
		} catch {
			Write-Log "inline launch failed: $($_.Exception.Message)"
		}
	}
}

Write-Log "helper done in $([int]((Get-Date) - $t0).TotalMilliseconds)ms (relayVia=$relayVia)"
exit 0
