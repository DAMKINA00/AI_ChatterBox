param([Parameter(Mandatory=$true)][string[]]$Paths)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ManifestResource {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr FindResource(IntPtr module, IntPtr name, IntPtr type);
 [DllImport("kernel32.dll")] public static extern uint SizeofResource(IntPtr module, IntPtr resource);
 [DllImport("kernel32.dll")] public static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
 [DllImport("kernel32.dll")] public static extern IntPtr LockResource(IntPtr resource);
 [DllImport("kernel32.dll")] public static extern bool FreeLibrary(IntPtr module);
}
'@
foreach ($taskPath in $Paths) {
 $taskAbsolute = (Resolve-Path -LiteralPath $taskPath).Path
 $taskModule = [ManifestResource]::LoadLibraryEx($taskAbsolute, [IntPtr]::Zero, 2)
 if ($taskModule -eq [IntPtr]::Zero) { throw "Cannot read PE: $taskAbsolute" }
 try {
  $taskResource = [ManifestResource]::FindResource($taskModule, [IntPtr]1, [IntPtr]24)
  if ($taskResource -eq [IntPtr]::Zero) { throw "No executable manifest: $taskAbsolute" }
  $taskLength = [ManifestResource]::SizeofResource($taskModule, $taskResource)
  $taskPointer = [ManifestResource]::LockResource([ManifestResource]::LoadResource($taskModule, $taskResource))
  $taskBytes = New-Object byte[] $taskLength
  [Runtime.InteropServices.Marshal]::Copy($taskPointer, $taskBytes, 0, $taskLength)
  $taskManifest = [Text.Encoding]::UTF8.GetString($taskBytes)
  if ($taskManifest -notmatch 'requestedExecutionLevel\s+level=["'']requireAdministrator["'']') { throw "Expected requireAdministrator: $taskAbsolute" }
  Write-Output "PASS requireAdministrator: $taskAbsolute"
 } finally { [void][ManifestResource]::FreeLibrary($taskModule) }
}
