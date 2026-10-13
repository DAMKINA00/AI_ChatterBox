param(
 [Parameter(Mandatory=$true)][string]$Executable,
 [Parameter(Mandatory=$true)][string]$DataDir,
 [int]$Port = 9447,
 [switch]$Elevated
)
$ErrorActionPreference = 'Stop'
if (!$Elevated) {
 try {
  $taskArgs = @('-NoProfile', '-File', ('"' + $PSCommandPath + '"'), '-Executable', ('"' + $Executable + '"'), '-DataDir', ('"' + $DataDir + '"'), '-Port', $Port, '-Elevated')
  $taskProcess = Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList $taskArgs -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  exit $taskProcess.ExitCode
 } catch {
  Write-Error "UAC launch was cancelled or failed. No normal-privilege fallback: $($_.Exception.Message)"
  exit 1
 }
}
$taskPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (!$taskPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Expected elevated test launcher' }
if (Test-Path -LiteralPath (Join-Path $DataDir 'cancel-launch')) { exit 1 }
$env:AI_CHATTERBOX_DATA = $DataDir
$env:AI_CHATTERBOX_HIDE = '1'
$taskApp = Start-Process -FilePath $Executable -ArgumentList "--remote-debugging-port=$Port", '--test-data' -WindowStyle Hidden -PassThru
$taskApp.WaitForExit()
exit $taskApp.ExitCode
