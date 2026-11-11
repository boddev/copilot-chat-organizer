param([Parameter(Mandatory)][string]$Cmd, [hashtable]$Body = @{})
$c = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\captures\.control') -Raw | ConvertFrom-Json
$json = $Body | ConvertTo-Json -Depth 10 -Compress
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($c.port)/$Cmd" -Headers @{ 'x-control-token' = $c.token } -ContentType 'application/json' -Body $json -TimeoutSec 120 | ConvertTo-Json -Depth 20
