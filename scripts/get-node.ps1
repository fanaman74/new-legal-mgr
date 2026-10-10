# Downloads a private copy of Node.js (current LTS) into .runtime\node inside this project.
# No installation and no administrator rights are needed; the download is verified against
# the SHA-256 checksums published by nodejs.org. Used by "Start Legal Evidence Manager.bat"
# only when no suitable Node.js is installed on this computer.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root '.runtime'
$target = Join-Path $runtime 'node'
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$base = 'https://nodejs.org/dist/latest-v24.x'

$sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content
$line = ($sums -split "`n") | Where-Object { $_ -match "node-v[\d.]+-win-$arch\.zip\s*$" } | Select-Object -First 1
if (-not $line) { throw "No Node.js download found for win-$arch" }
$parts = $line.Trim() -split '\s+'
$expected = $parts[0].ToLower()
$file = $parts[1]

New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$zip = Join-Path $runtime $file
Write-Host "      Downloading $file from nodejs.org ..."
Invoke-WebRequest -UseBasicParsing "$base/$file" -OutFile $zip
$actual = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()
if ($actual -ne $expected) { Remove-Item $zip -Force; throw "Checksum mismatch for $file; download discarded." }
Write-Host '      Checksum verified. Unpacking ...'

$tmp = Join-Path $runtime 'unpack'
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (Test-Path $tar) { & $tar -xf $zip -C $tmp; if ($LASTEXITCODE -ne 0) { throw 'Unpacking failed.' } }
else { Expand-Archive -Path $zip -DestinationPath $tmp }
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
Move-Item (Join-Path $tmp ($file -replace '\.zip$', '')) $target
Remove-Item -Recurse -Force $tmp
Remove-Item -Force $zip
Write-Host "      Node.js is ready in $target"
