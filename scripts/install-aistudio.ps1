[CmdletBinding()]
param(
    [string]$Root = $(if ($env:SystemDrive) { Join-Path -Path $env:SystemDrive -ChildPath 'Apps\AIStudio2API' } else { 'C:\Apps\AIStudio2API' }),
    [switch]$Start
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repository = 'Mag1cFall/AIStudio2API'
$releaseUri = "https://api.github.com/repos/$repository/releases/latest"
$requestHeaders = @{
    Accept = 'application/vnd.github+json'
    'User-Agent' = 'AI-ChatterBox-AIStudio2API-installer'
}
$rootAbsolute = [IO.Path]::GetFullPath($Root)
$temporaryZip = $null
$temporaryStage = $null

function ConvertTo-GitHubUri {
    param([Parameter(Mandatory = $true)][string]$Value)

    $parsed = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$parsed)) {
        throw "GitHub URL is invalid: $Value"
    }
    $allowedHosts = @('api.github.com', 'github.com', 'objects.githubusercontent.com', 'raw.githubusercontent.com')
    if ($parsed.Scheme -ne 'https' -or $allowedHosts -notcontains $parsed.Host.ToLowerInvariant()) {
        throw "Refusing a non-GitHub HTTPS URL: $Value"
    }
    return $parsed.AbsoluteUri
}

function New-LocalApiKey {
    $bytes = New-Object byte[] 32
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $random.GetBytes($bytes)
    } finally {
        $random.Dispose()
    }
    $encoded = [Convert]::ToBase64String($bytes).TrimEnd('=')
    return ($encoded -replace '\+', '-' -replace '/', '_')
}

function Resolve-RootChildPath {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$RootAbsolute
    )

    $candidateAbsolute = [IO.Path]::GetFullPath($Candidate)
    if (Test-Path -LiteralPath $candidateAbsolute) {
        $candidateAbsolute = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $candidateAbsolute).Path)
    }
    $rootComparable = $RootAbsolute -replace '[\\/]+$', ''
    $candidateComparable = $candidateAbsolute -replace '[\\/]+$', ''
    $rootPrefix = $rootComparable + [IO.Path]::DirectorySeparatorChar
    if ($candidateComparable.Equals($rootComparable, [StringComparison]::OrdinalIgnoreCase) -or
        -not $candidateComparable.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the installer root: $candidateAbsolute"
    }
    return $candidateAbsolute
}

function Get-ExpectedSha256 {
    param(
        [Parameter(Mandatory = $true)]$Release,
        [Parameter(Mandatory = $true)]$Asset
    )

    $digestProperty = $Asset.PSObject.Properties['digest']
    if ($null -ne $digestProperty -and -not [string]::IsNullOrWhiteSpace([string]$digestProperty.Value)) {
        $digest = [regex]::Match([string]$digestProperty.Value, '(?i)^sha256:(?<hash>[0-9a-f]{64})$')
        if (-not $digest.Success) {
            throw "The release published an unsupported SHA-256 digest for $($Asset.name)."
        }
        return $digest.Groups['hash'].Value.ToUpperInvariant()
    }

    $checksumAssets = @($Release.assets | Where-Object {
        $name = [string]$_.name
        ($name -match '(?i)(sha256|checksum|checksums|hash)') -and ($name -notmatch '(?i)windows-amd64\.zip$')
    })
    foreach ($checksumAsset in $checksumAssets) {
        $checksumUri = ConvertTo-GitHubUri ([string]$checksumAsset.browser_download_url)
        $checksumText = (Invoke-WebRequest -Uri $checksumUri -Headers $requestHeaders -UseBasicParsing).Content
        foreach ($line in ($checksumText -split "`r?`n")) {
            if ($line -like "*$($Asset.name)*") {
                $match = [regex]::Match($line, '(?i)\b(?<hash>[0-9a-f]{64})\b')
                if ($match.Success) {
                    return $match.Groups['hash'].Value.ToUpperInvariant()
                }
            }
        }
    }

    throw "The release does not publish a SHA-256 digest for $($Asset.name); refusing an unverifiable install."
}

try {
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    } catch {
        # Windows PowerShell may already have a suitable TLS policy.
    }

    $release = Invoke-RestMethod -Uri $releaseUri -Headers $requestHeaders -Method Get
    $assets = @($release.assets)
    if ($assets.Count -eq 0) {
        throw 'The latest GitHub release has no downloadable assets.'
    }

    $asset = @($assets | Where-Object { [string]$_.name -ieq 'windows-amd64.zip' }) | Select-Object -First 1
    if ($null -eq $asset) {
        $asset = @($assets | Where-Object { [string]$_.name -match '(?i)windows-amd64\.zip$' }) | Select-Object -First 1
    }
    if ($null -eq $asset) {
        throw 'The latest GitHub release has no windows-amd64.zip asset.'
    }

    $downloadUri = ConvertTo-GitHubUri ([string]$asset.browser_download_url)
    $assetName = [IO.Path]::GetFileName([string]$asset.name)
    $tag = [string]$release.tag_name
    if ([string]::IsNullOrWhiteSpace($tag)) { $tag = [string]$release.name }
    if ([string]::IsNullOrWhiteSpace($tag)) { $tag = [string]$release.id }
    $tag = $tag -replace '[^A-Za-z0-9._-]', '-'
    if ($assetName -match '(?i)^(.+)-windows-amd64\.zip$') {
        $directoryName = "$($matches[1])-windows-amd64"
    } else {
        $directoryName = "aistudio2api-$tag-windows-amd64"
    }
    $directoryName = $directoryName -replace '[^A-Za-z0-9._-]', '-'

    [IO.Directory]::CreateDirectory($rootAbsolute) | Out-Null
    $rootAbsolute = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $rootAbsolute).Path)
    $installDirectory = Resolve-RootChildPath -Candidate (Join-Path -Path $rootAbsolute -ChildPath $directoryName) -RootAbsolute $rootAbsolute
    if (Test-Path -LiteralPath $installDirectory) {
        throw "Refusing to overwrite the existing version directory: $installDirectory"
    }

    $temporaryZip = Resolve-RootChildPath -Candidate (Join-Path -Path $rootAbsolute -ChildPath ('.download-' + [Guid]::NewGuid().ToString('N') + '.zip')) -RootAbsolute $rootAbsolute
    $temporaryStage = Resolve-RootChildPath -Candidate (Join-Path -Path $rootAbsolute -ChildPath ('.stage-' + [Guid]::NewGuid().ToString('N'))) -RootAbsolute $rootAbsolute
    Invoke-WebRequest -Uri $downloadUri -Headers $requestHeaders -OutFile $temporaryZip -UseBasicParsing

    $expectedSha256 = Get-ExpectedSha256 -Release $release -Asset $asset
    if ([string]::IsNullOrWhiteSpace($expectedSha256)) {
        throw "The release does not publish a SHA-256 digest for $assetName; refusing an unverifiable install."
    }
    $actualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $temporaryZip).Hash.ToUpperInvariant()
    if ($actualSha256 -ne $expectedSha256) {
        throw "SHA-256 mismatch for $assetName; refusing to extract the archive."
    }
    Write-Output "SHA-256 verified for $assetName."

    [IO.Directory]::CreateDirectory($temporaryStage) | Out-Null
    Expand-Archive -LiteralPath $temporaryZip -DestinationPath $temporaryStage -Force
    $children = @(Get-ChildItem -LiteralPath $temporaryStage -Force)
    $payload = $temporaryStage
    if ($children.Count -eq 1 -and $children[0].PSIsContainer) {
        $payload = $children[0].FullName
    }
    $payload = Resolve-RootChildPath -Candidate $payload -RootAbsolute $rootAbsolute
    if (-not (Test-Path -LiteralPath (Join-Path -Path $payload -ChildPath 'aistudio2api.exe') -PathType Leaf)) {
        throw 'The archive does not contain aistudio2api.exe at its package root.'
    }
    Move-Item -LiteralPath $payload -Destination $installDirectory

    $executable = Join-Path -Path $installDirectory -ChildPath 'aistudio2api.exe'
    $envPath = Join-Path -Path $installDirectory -ChildPath '.env'
    $envCreated = $false
    if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) {
        $apiKey = New-LocalApiKey
        $envContent = @"
AISTUDIO_AUTH_STATES=auth
LISTEN_ADDR=127.0.0.1:2048
PROXY_API_KEY=$apiKey
AUTO_START=false
REQUEST_BODY_LOG=false
ADMIN_AUTH_ENABLED=false
WARM_WORKER_LIMIT=2
MAX_ACTIVE_WORKERS=10
WARM_STARTUP_CONCURRENCY=2
PER_ACCOUNT_CONCURRENCY=1
ROUTING_STRATEGY=fill-first
UPSTREAM_CHANNELS=playground,build
WAA_BACKEND=go
"@
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [IO.File]::WriteAllText($envPath, $envContent, $utf8NoBom)
        $envCreated = $true
    }

    Write-Output ("Installed AIStudio2API {0} at {1}" -f $tag, $installDirectory)
    Write-Output ("Executable: {0}" -f $executable)
    if ($envCreated) {
        Write-Output 'Created .env with a cryptographically random local API key; the key value was not printed.'
    } else {
        Write-Output 'Existing .env preserved; no API key was changed.'
    }

    if ($Start) {
        $running = @(Get-Process -Name 'aistudio2api' -ErrorAction SilentlyContinue)
        if ($running.Count -gt 0) {
            Write-Output 'An aistudio2api.exe process already exists; skipped launch without stopping it.'
        } else {
            $process = Start-Process -FilePath $executable -ArgumentList @('-open-ui=false') -WorkingDirectory $installDirectory -WindowStyle Hidden -PassThru
            Write-Output ("Started AIStudio2API in the background (PID {0})." -f $process.Id)
        }
    }
} finally {
    if ($null -ne $temporaryZip) {
        $temporaryZip = Resolve-RootChildPath -Candidate $temporaryZip -RootAbsolute $rootAbsolute
        if (Test-Path -LiteralPath $temporaryZip) {
            Remove-Item -LiteralPath $temporaryZip -Force -ErrorAction SilentlyContinue
        }
    }
    if ($null -ne $temporaryStage) {
        $temporaryStage = Resolve-RootChildPath -Candidate $temporaryStage -RootAbsolute $rootAbsolute
        if (Test-Path -LiteralPath $temporaryStage) {
            Remove-Item -LiteralPath $temporaryStage -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
