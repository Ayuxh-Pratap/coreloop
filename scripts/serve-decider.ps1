# Starts decider-0.8b (decider.serve, POST /v1/systemone) on 127.0.0.1:<Port> from .venv-models.
# Background by default: logs to .models\logs\decider.log, waits until /health answers, prints VRAM.
#   -Foreground  run in this window instead (Ctrl+C stops it)
# Settings are the ones measured in the model bake-off (small CUDA-graph grid so a 6 GB card is enough).
param([switch]$Foreground, [int]$Port = 8001, [int]$WaitSeconds = 240)
$ErrorActionPreference = 'Stop'
$Root   = Split-Path -Parent $PSScriptRoot
$Models = Join-Path $Root '.models'
$Py     = Join-Path $Root '.venv-models\Scripts\python.exe'
$Url    = "http://127.0.0.1:$Port"
if (-not (Test-Path $Py)) { throw "No model env yet. Run: npm run models:setup" }

function Healthy { try { (Invoke-RestMethod "$Url/health" -TimeoutSec 2).ok -eq $true } catch { $false } }
if (Healthy) { Write-Host "decider already running at $Url"; exit 0 }

$env:HF_HOME            = Join-Path $Models 'hf'
$env:HF_HUB_OFFLINE     = '1'
$env:HF_HUB_DISABLE_TELEMETRY = '1'
$env:DECIDER_MODEL      = 'Mapika/decider-0.8b'
$env:DECIDER_DEVICE     = 'cuda'
$env:DECIDER_T_BUCKETS  = '64,128,256,512,1024'
$env:DECIDER_B_BUCKETS  = '1,2,4,8'
$env:DECIDER_MAX_BATCH  = '8'
$env:DECIDER_GRAPH_TOKEN_BUDGET = '4096'
$env:DECIDER_MAX_STATE_TOKENS   = '4096'
$env:DECIDER_SHARED_FORK_GB     = '0.5'
$env:DECIDER_MERGE_OVERHEAD_TOKENS = if ($env:COLOOP_MERGE_OVERHEAD) { $env:COLOOP_MERGE_OVERHEAD } else { '64' }  # measured on the RTX 3050: 512 pads short rows into long buckets (+60 ms)

$uvicorn = @('-m', 'uvicorn', 'decider.serve:app', '--host', '127.0.0.1', '--port', "$Port")
if ($Foreground) { & $Py @uvicorn; exit $LASTEXITCODE }

$log = Join-Path $Models 'logs\decider.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
# Launch through WMI so the server shares no handles with this shell: a child started with Start-Process
# inherits the caller's output pipe and makes `npm run models:start | ...` wait forever. A WMI process
# doesn't inherit this session's environment either, so the settings go into a .cmd launcher.
$cmd = Join-Path $Models 'logs\decider-launch.cmd'
$lines = @('@echo off')
foreach ($k in 'HF_HOME','HF_HUB_OFFLINE','HF_HUB_DISABLE_TELEMETRY','DECIDER_MODEL','DECIDER_DEVICE','DECIDER_T_BUCKETS','DECIDER_B_BUCKETS','DECIDER_MAX_BATCH','DECIDER_GRAPH_TOKEN_BUDGET','DECIDER_MAX_STATE_TOKENS','DECIDER_SHARED_FORK_GB','DECIDER_MERGE_OVERHEAD_TOKENS') {
  $lines += "set `"$k=$([Environment]::GetEnvironmentVariable($k))`""
}
$lines += "`"$Py`" $($uvicorn -join ' ') > `"$log`" 2> `"$log.err`""
Set-Content -Path $cmd -Value $lines -Encoding ascii
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "cmd.exe /c `"$cmd`""; CurrentDirectory = $Root }
if ($r.ReturnValue -ne 0) { throw "could not start decider (Win32_Process.Create returned $($r.ReturnValue))" }
Write-Host "starting decider-0.8b on $Url (log: $log.err) ..."
$sw = [Diagnostics.Stopwatch]::StartNew()
while ($sw.Elapsed.TotalSeconds -lt $WaitSeconds) {
  if (Healthy) {
    Write-Host ("ready after {0:N0} s" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Green
    nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader
    exit 0
  }
  if (Select-String -Path "$log.err" -Pattern 'Traceback|out of memory' -Quiet -ErrorAction SilentlyContinue) {
    Get-Content "$log.err" -Tail 15; throw 'decider failed to start'
  }
  Start-Sleep -Seconds 2
}
throw "decider not healthy after $WaitSeconds s (see $log.err)"
