# One-time (or repeat) cache fill: POST /api/albums/seed for each genre.
# Requires: node server running (npm start or npm run dev).
# If you see "total":0 for every genre, check SPOTIFY_* in .env, then restart the server.
#
# Why NOT curl in PowerShell? curl.exe -d "{\"genre\":\"rock\"}" often breaks quoting and
# sends invalid JSON → SyntaxError at position 1. This script uses Invoke-RestMethod instead.

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

$port = 3001
if ($env:PORT) { $port = [int]$env:PORT }
elseif (Test-Path '.env') {
  Get-Content '.env' | ForEach-Object {
    if ($_ -match '^\s*PORT\s*=\s*(\d+)\s*$') { $port = [int]$Matches[1] }
  }
}
$base = "http://localhost:$port"

$genres = @(
  'rock', 'hip-hop', 'pop', 'indie', 'metal', 'electronic', 'rnb', 'jazz',
  'folk', 'punk', 'classical', 'country', 'reggae', 'blues', 'latin'
)

Write-Host "Seeding albums via $base (server must be running)...`n" -ForegroundColor Cyan

$i = 0
foreach ($g in $genres) {
  $i++
  Write-Host "[$i/$($genres.Count)] $g ... " -NoNewline
  $body = @{ genre = $g } | ConvertTo-Json -Compress
  try {
    $r = Invoke-RestMethod -Uri "$base/api/albums/seed" -Method Post -Body $body -ContentType 'application/json; charset=utf-8'
    Write-Host "OK - total: $($r.total)" -ForegroundColor Green
  } catch {
    Write-Host "FAILED: $_" -ForegroundColor Red
  }
}

Write-Host ""
Write-Host "Done." -ForegroundColor Cyan
