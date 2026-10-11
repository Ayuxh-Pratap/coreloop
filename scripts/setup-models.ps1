# Builds the local model stack inside the repo (gitignored), idempotently:
#   .venv-models\   Python + torch (CUDA 12.8) + decider-ai[serve] + triton-windows (decision model server)
#   .models\hf\     decider-0.8b weights (Hugging Face cache layout)
#   .models\parakeet\  Parakeet TDT 0.6B v2 int8 + Silero VAD (speech-to-text, CPU)
#   .models\python\ the uv-managed Python the venv is built on
# Exact versions are the pins just below; they are the only place versions are set.
# Every step is appended to .models\setup.log.
#
#   npm run models:setup                                download everything
#   npm run models:setup -- -Reuse C:\path\to\folder    copy what's already downloaded there instead
#                                                       (uv-cache\, hf\hub\models--Mapika--decider-0.8b\, stt-spike\)
param([string]$Reuse = '')
$ErrorActionPreference = 'Stop'

$PythonVersion  = '3.13'
$TorchSpec      = 'torch==2.11.*'                  # any 2.11 patch release, CUDA 12.8 build
$TorchIndex     = 'https://download.pytorch.org/whl/cu128'
$DeciderSpec    = 'decider-ai[serve]==1.8.1'
$TritonSpec     = 'triton-windows==3.6.0.post26'   # must match torch 2.11 (triton 3.6); enables the fast kernels
$Root    = Split-Path -Parent $PSScriptRoot
$Models  = Join-Path $Root '.models'
$Venv    = Join-Path $Root '.venv-models'
$Py      = Join-Path $Venv 'Scripts\python.exe'
$Log     = Join-Path $Models 'setup.log'

New-Item -ItemType Directory -Force $Models, (Join-Path $Models 'logs') | Out-Null
function Step($msg) { $line = "== $(Get-Date -Format s) $msg"; Write-Host $line -ForegroundColor Cyan; Add-Content -Path $Log -Value $line }
function Reused($rel) {  # $rel inside the -Reuse folder, when one was given and has it
  if ($Reuse -and (Test-Path (Join-Path $Reuse $rel))) { return Join-Path $Reuse $rel }
}
function Run($exe) {  # run a native command; fail the script on a non-zero exit code
  & $exe @args
  if ($LASTEXITCODE -ne 0) { throw "failed ($LASTEXITCODE): $exe $args" }
}

$env:UV_PYTHON_INSTALL_DIR = Join-Path $Models 'python'
$env:HF_HOME               = Join-Path $Models 'hf'
$env:HF_HUB_DISABLE_TELEMETRY = '1'
$env:UV_LINK_MODE          = 'copy'   # never hardlink into a cache that may be deleted later
if ($cache = Reused 'uv-cache') { $env:UV_CACHE_DIR = $cache; Step "reusing wheels from $cache" }

# 1. Python env for the decision model server
if (-not (Test-Path $Py)) { Step "create .venv-models (Python $PythonVersion)"; Run uv venv $Venv -p $PythonVersion } else { Step '.venv-models exists' }
Step "install $TorchSpec from $TorchIndex"
Run uv pip install --python $Py $TorchSpec --index-url $TorchIndex
Step "install $DeciderSpec, $TritonSpec, huggingface_hub"
Run uv pip install --python $Py $DeciderSpec $TritonSpec 'huggingface_hub[cli]'
Run $Py -c "import torch, triton, decider; assert torch.cuda.is_available(), 'CUDA not available'; print('torch', torch.__version__, '| triton', triton.__version__, '| CUDA ok')"

# 2. decider-0.8b weights
$dec = Join-Path $env:HF_HOME 'hub\models--Mapika--decider-0.8b'
if (Test-Path $dec) { Step 'decider-0.8b present' }
elseif ($from = Reused 'hf\hub\models--Mapika--decider-0.8b') {
  Step "decider-0.8b: copy from $from"
  New-Item -ItemType Directory -Force (Split-Path $dec) | Out-Null
  Copy-Item -Recurse $from $dec
} else {
  Step 'decider-0.8b: download (1.5 GB)'
  Run (Join-Path $Venv 'Scripts\hf.exe') download Mapika/decider-0.8b
}

# 3. Parakeet + Silero VAD
$stt = Join-Path $Models 'parakeet'
$asr = Join-Path $stt 'parakeet-tdt-0.6b-v2-int8'
$vad = Join-Path $stt 'silero_vad.onnx'
New-Item -ItemType Directory -Force $stt | Out-Null
$rel = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models'
if (Test-Path "$asr\encoder.int8.onnx") { Step 'Parakeet present' }
elseif ($from = Reused 'stt-spike\sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8') {
  Step "Parakeet: copy from $from"
  Copy-Item -Recurse $from $asr
} else {
  Step 'Parakeet: download (482 MB)'
  $tar = Join-Path $stt 'parakeet.tar.bz2'
  Run curl.exe -fL --retry 3 -o $tar "$rel/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2"
  Run tar.exe -xjf $tar -C $stt
  Rename-Item (Join-Path $stt 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8') $asr
  Remove-Item $tar
}
if (Test-Path $vad) { Step 'Silero VAD present' }
elseif ($from = Reused 'stt-spike\silero_vad.onnx') { Step "Silero VAD: copy from $from"; Copy-Item $from $vad }
else { Step 'Silero VAD: download'; Run curl.exe -fL --retry 3 -o $vad "$rel/silero_vad.onnx" }

Step 'done'
Get-ChildItem $Models, $Venv -Directory | ForEach-Object {
  $gb = (Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1GB
  '{0,-40} {1,6:N2} GB' -f $_.FullName.Substring($Root.Length + 1), $gb
}
