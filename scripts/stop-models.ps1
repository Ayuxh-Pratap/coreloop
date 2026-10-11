# Stops the model servers started from this repo. Matches python.exe by command line, because a venv's
# python.exe is a launcher with a child interpreter: killing a parent shell can leave the child holding VRAM.
$procs = Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.CommandLine -match 'decider\.serve' }
if (-not $procs) { Write-Host 'no model servers running' }
foreach ($p in $procs) { Write-Host "stop $($p.ProcessId)"; Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader
