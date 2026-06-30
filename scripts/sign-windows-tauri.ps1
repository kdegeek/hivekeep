param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $InputPath)) {
  throw "Signing input does not exist: $InputPath"
}

$signingRequired = $env:WINDOWS_SIGNING_REQUIRED -match '^(1|true|yes)$'
$pfxBase64 = $env:WINDOWS_SIGNING_CERTIFICATE_PFX_BASE64
$pfxPassword = $env:WINDOWS_SIGNING_CERTIFICATE_PASSWORD
$thumbprint = $env:WINDOWS_SIGNING_CERTIFICATE_THUMBPRINT

if ([string]::IsNullOrWhiteSpace($pfxBase64) -and [string]::IsNullOrWhiteSpace($thumbprint)) {
  $message = "Windows signing secrets are not set; leaving unsigned: $InputPath"
  if ($signingRequired) {
    throw $message
  }

  Write-Warning $message
  exit 0
}

function Get-SignToolPath {
  if (-not [string]::IsNullOrWhiteSpace($env:WINDOWS_SIGNTOOL_PATH)) {
    if (Test-Path -LiteralPath $env:WINDOWS_SIGNTOOL_PATH) {
      return $env:WINDOWS_SIGNTOOL_PATH
    }

    throw "WINDOWS_SIGNTOOL_PATH does not exist: $env:WINDOWS_SIGNTOOL_PATH"
  }

  $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $kitRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  if (Test-Path -LiteralPath $kitRoot) {
    $kitSignTool = Get-ChildItem -Path $kitRoot -Recurse -Filter signtool.exe |
      Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
      Sort-Object FullName -Descending |
      Select-Object -First 1

    if ($kitSignTool) {
      return $kitSignTool.FullName
    }
  }

  throw "signtool.exe was not found. Install the Windows SDK or set WINDOWS_SIGNTOOL_PATH."
}

$signtool = Get-SignToolPath
$digestAlgorithm = if ([string]::IsNullOrWhiteSpace($env:WINDOWS_SIGNING_DIGEST_ALGORITHM)) {
  "sha256"
} else {
  $env:WINDOWS_SIGNING_DIGEST_ALGORITHM
}
$timestampUrl = if ([string]::IsNullOrWhiteSpace($env:WINDOWS_SIGNING_TIMESTAMP_URL)) {
  "http://timestamp.digicert.com"
} else {
  $env:WINDOWS_SIGNING_TIMESTAMP_URL
}

$arguments = @("sign", "/fd", $digestAlgorithm)

if (-not [string]::IsNullOrWhiteSpace($timestampUrl)) {
  $arguments += @("/tr", $timestampUrl, "/td", $digestAlgorithm)
}

$temporaryPfx = $null

try {
  if (-not [string]::IsNullOrWhiteSpace($pfxBase64)) {
    if ([string]::IsNullOrWhiteSpace($pfxPassword)) {
      throw "WINDOWS_SIGNING_CERTIFICATE_PASSWORD is required when WINDOWS_SIGNING_CERTIFICATE_PFX_BASE64 is set."
    }

    $temporaryPfx = Join-Path ([System.IO.Path]::GetTempPath()) ("hivekeep-signing-{0}.pfx" -f ([System.Guid]::NewGuid()))
    [System.IO.File]::WriteAllBytes($temporaryPfx, [System.Convert]::FromBase64String($pfxBase64))
    $arguments += @("/f", $temporaryPfx, "/p", $pfxPassword)
  } else {
    $arguments += @("/sha1", $thumbprint)
  }

  $arguments += $InputPath

  & $signtool @arguments
  if ($LASTEXITCODE -ne 0) {
    throw "signtool.exe failed with exit code $LASTEXITCODE"
  }
} finally {
  if ($temporaryPfx -and (Test-Path -LiteralPath $temporaryPfx)) {
    Remove-Item -LiteralPath $temporaryPfx -Force
  }
}
