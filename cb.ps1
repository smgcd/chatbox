# Chatbox source build helper (route A). ASCII only - PS 5.1 safe.
# Usage:  .\cb.ps1 -Cmd <install|build|package|dev|ver>
# Forces the portable Node 22 toolchain, so the system node24 and the
# Chatbox-injected 'node' function are bypassed.
param(
  [Parameter(Position=0)][string]$Cmd = "ver"
)

$NODE = "C:\Users\CD\tools\node22"
$SRC  = "C:\Users\CD\Documents\chatbox\chatbox-src"
$pnpm = Join-Path $NODE "pnpm.cmd"

if (-not (Test-Path $pnpm)) { Write-Error "portable node22/pnpm not found at $NODE"; exit 1 }
if (-not (Test-Path $SRC))  { Write-Error "chatbox source not found at $SRC";  exit 1 }

$env:Path = "$NODE;" + $env:Path

switch ($Cmd) {
  "ver"     { & (Join-Path $NODE "node.exe") -v; & $pnpm -v; Write-Host "SRC=$SRC" }
  "install" { Push-Location $SRC; & $pnpm install --reporter=append-only; Pop-Location }
  "build"   { Push-Location $SRC; & $pnpm run build;   Pop-Location }
  "package" { Push-Location $SRC; & $pnpm run package; Pop-Location }
  "dev"     { Push-Location $SRC; & $pnpm run dev;     Pop-Location }
  "clean"   { Push-Location $SRC; & $pnpm exec tsx ./.erb/scripts/clean.js; Pop-Location }
  default   { Write-Host "usage: cb.ps1 -Cmd [ver|install|build|package|dev|clean]" }
}
