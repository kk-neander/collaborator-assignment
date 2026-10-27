# Split Brain launcher for Windows PowerShell. macOS/Linux/WSL: ./sb
# Usage: .\sb.ps1 <command> [args]   (run .\sb.ps1 help)
# If scripts are blocked: powershell -ExecutionPolicy Bypass -File .\sb.ps1 up
param([Parameter(Position = 0)][string]$Command = "help", [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest = @())
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

function Die($msg) { Write-Host $msg -ForegroundColor Red; exit 1 }
function Need-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Die "Docker is not installed. Install Docker Desktop for Windows, then retry." }
  docker info *> $null; if ($LASTEXITCODE -ne 0) { Die "Docker is installed but not running. Start Docker Desktop and retry." }
  docker compose version *> $null; if ($LASTEXITCODE -ne 0) { Die "Docker Compose v2 is missing. Update Docker Desktop." }
}
function Node-Version {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $null }
  $v = (node -e "console.log(process.versions.node)") 2>$null
  if (-not $v) { return $null }
  return [version]$v
}
function Host-Node-Runs-TS { $v = Node-Version; return ($v -and ($v -ge [version]"22.18.0") -and (Test-Path node_modules)) }
function Host-Node-Runs-JS { $v = Node-Version; return ($v -and ($v -ge [version]"20.0.0")) }
function Ensure-Env {
  if (-not (Test-Path .env)) {
    Copy-Item .env.example .env
    Write-Host "Created .env from .env.example. Ada (the AI bot) needs LLM_PROVIDER, LLM_MODEL and usually LLM_API_KEY." -ForegroundColor Yellow
  }
}
function Port {
  $line = Select-String -Path .env -Pattern '^SB_PORT=(\d+)' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($line) { return $line.Matches[0].Groups[1].Value } else { return "8080" }
}
function Wait-Healthy {
  $port = Port
  Write-Host -NoNewline "Waiting for Split Brain on port $port "
  for ($i = 0; $i -lt 90; $i++) {
    try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://localhost:$port/healthz" | Out-Null
      Write-Host ""; Write-Host "Split Brain is up." -ForegroundColor Green
      Write-Host "  Demo (3 people side by side): http://localhost:$port/demo"
      Write-Host "  Join as one person:           http://localhost:$port/"
      return } catch { Write-Host -NoNewline "."; Start-Sleep -Seconds 1 }
  }
  Die "Not healthy after 90s. Check .\sb.ps1 logs relay"
}
function Run-TS($entry, $argv) {
  if (Host-Node-Runs-TS) { node $entry @argv } else { Need-Docker; docker compose --profile tools run --rm tools node $entry @argv }
}

switch ($Command) {
  "up" {
    Need-Docker; Ensure-Env
    $out = (docker compose up --build -d @Rest 2>&1 | Tee-Object -Variable lines | Out-String)
    if ($out -match "fully subnetted") {
      Write-Host "Docker has no free default network ranges; using fixed subnets (compose.subnets.yml)." -ForegroundColor Yellow
      if (-not (Select-String -Path .env -Pattern '^COMPOSE_FILE=' -Quiet)) { Add-Content .env "`nCOMPOSE_FILE=docker-compose.yml;compose.subnets.yml" }
      docker compose -f docker-compose.yml -f compose.subnets.yml up --build -d @Rest
    }
    if (-not (Test-Path .split-brain/started.json)) {
      if (Host-Node-Runs-JS) { node tools/trace/cli.mjs init *> $null }
      else { docker compose --profile tools run --rm tools node tools/trace/cli.mjs init --project-root /app *> $null }
    }
    Wait-Healthy
  }
  "down" { Need-Docker; docker compose down @Rest }
  "reset" { Need-Docker; $ok = Read-Host "Delete all shared documents and start from the seed workspace? [y/N]"; if ($ok -match '^[yY]') { docker compose down -v } else { "Cancelled." } }
  "logs" { Need-Docker; docker compose logs -f --tail=200 @Rest }
  "ps" { Need-Docker; docker compose ps }
  "restart" { Need-Docker; docker compose restart @Rest }
  "dev" { Need-Docker; Ensure-Env; docker compose -f docker-compose.yml -f compose.dev.yml up --build @Rest }
  "test" { if (Host-Node-Runs-TS) { npx vitest run @Rest } else { Need-Docker; docker compose --profile tools run --rm tools npx vitest run @Rest } }
  "score" { Run-TS "harness/score/src/cli.ts" $Rest }
  { $_ -in "trace", "submit", "init" } {
    if (Host-Node-Runs-JS) { node tools/trace/cli.mjs $Command @Rest }
    else { Die "trace/submit needs Node.js 20+ on Windows (https://nodejs.org). Or run them from WSL with ./sb $Command" }
  }
  "doctor" { if (Host-Node-Runs-JS) { node tools/doctor.mjs } else { Need-Docker; Write-Host "Docker OK. Install Node.js 20+ for trace/submit." } }
  default {
@"
Split Brain - 3 humans. 1 AI. 4 versions of the same file.

  .\sb.ps1 up         build and start everything (relay, chaos proxy, AI bot)
  .\sb.ps1 down       stop it            .\sb.ps1 reset   wipe shared documents
  .\sb.ps1 logs [svc] follow logs        .\sb.ps1 ps      service status
  .\sb.ps1 dev        hot-reload mode
  .\sb.ps1 test       unit + property tests
  .\sb.ps1 score      scenario harness (--track floor|sync-core|ai-peer|files|runtime|hostile, --seed N)
  .\sb.ps1 trace      snapshot your AI-agent sessions for this project (--dry-run to preview)
  .\sb.ps1 submit <email>  build your submission bundle and upload it
  .\sb.ps1 doctor     check your machine
"@
  }
}
