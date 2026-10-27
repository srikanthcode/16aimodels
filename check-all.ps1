$base = 'https://one6aimodels.onrender.com'
$K = 'cdcf64b3a81fbe767c50078bcb287e386fa42830b18839144c54cfce55ac670c'
$H = @{ Authorization = "Bearer $K" }
$chatModels = @(
  'qwen-coder-3b','qwen-coder-1.5b-local','qwen2.5-3b-local','llama32-3b',
  'llama3.2-1b-local','qwen3-4b-local','qwen3-1.7b-local','qwen3-router',
  'deepseek-r1-1.5b-local','smollm3-3b-local','gemma3-1b-local',
  'phi4-mini-local','aya-8b-local'
)
$embModels = @('bge-m3-local','nomic-embed-local','qwen3-embedding-0.6b-local')
$fail = 0
"=== HEALTH ==="
try { (Invoke-RestMethod "$base/health" -Headers $H -TimeoutSec 60) | ConvertTo-Json -Compress } catch { "HEALTH_FAIL: $_" }
""
"=== CHAT MODELS ==="
foreach ($m in $chatModels) {
  $mt = if ($m -eq 'deepseek-r1-1.5b-local') { 256 } else { 24 }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $r = Invoke-RestMethod "$base/v1/chat/completions" -Method Post -Headers $H -ContentType 'application/json' `
      -Body ('{"model":"' + $m + '","messages":[{"role":"user","content":"Say OK"}],"max_tokens":' + $mt + '}') -TimeoutSec 180
    $c = $r.choices[0].message.content
    $txt = if ($c) { $c.Trim() } else { '(no text)' }
    if ($txt.Length -gt 40) { $txt = $txt.Substring(0,40) + '...' }
    "OK   {0,-28} {1,5}ms  -> {2}" -f $m, [int]$sw.Elapsed.TotalMilliseconds, $txt
  } catch {
    $fail++
    "FAIL {0,-28} {1,5}ms  -> {2}" -f $m, [int]$sw.Elapsed.TotalMilliseconds, $_.Exception.Message
  }
}
"=== EMBEDDINGS ==="
foreach ($m in $embModels) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $r = Invoke-RestMethod "$base/v1/embeddings" -Method Post -Headers $H -ContentType 'application/json' `
      -Body ('{"model":"' + $m + '","input":"hello"}') -TimeoutSec 120
    "OK   {0,-28} {1,5}ms  -> dim={2}" -f $m, [int]$sw.Elapsed.TotalMilliseconds, $r.data[0].embedding.Count
  } catch {
    $fail++
    "FAIL {0,-28} {1,5}ms  -> {2}" -f $m, [int]$sw.Elapsed.TotalMilliseconds, $_.Exception.Message
  }
}
""
if ($fail -eq 0) { "ALL 16 MODELS OK" } else { "$fail FAILURES" }