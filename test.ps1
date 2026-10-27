$K = 'test-key-0123456789'
$U = 'https://11434-13cbc047-336c-4164-896c-bb5229949e03.proxy.daytona.work'
$env:PORT = '18081'
$env:APP_API_KEY = $K
$env:HYPERNET_OLLAMA_URL = $U
$gw = 'C:\Users\Lenovo\New folder (18)\ai-gateway'
$p = Start-Process node -ArgumentList 'server.js' -WorkingDirectory $gw -PassThru -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\gw4.out" -RedirectStandardError "$env:TEMP\gw4.err"
Start-Sleep -Seconds 3
$H = @{ Authorization = "Bearer $K" }
$base = 'http://127.0.0.1:18081'
try {
  $chat = Invoke-RestMethod -Uri "$base/v1/chat/completions" -Method Post -Headers $H -ContentType 'application/json' -Body '{"model":"qwen2.5-3b-local","messages":[{"role":"user","content":"Say hi in 3 words"}],"max_tokens":20}'
  "CHAT: $($chat.choices[0].message.content)"
} catch { "CHAT_FAIL: $_" }
try {
  $emb = Invoke-RestMethod -Uri "$base/v1/embeddings" -Method Post -Headers $H -ContentType 'application/json' -Body '{"model":"bge-m3-local","input":"hello world"}'
  "EMBED_DIM: $($emb.data.Count) first_len=$($emb.data[0].embedding.Count)"
} catch { "EMBED_FAIL: $_" }
try {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $req = [System.Net.HttpWebRequest]::Create("$base/v1/chat/completions")
  $req.Method = 'POST'
  $req.ContentType = 'application/json'
  $req.Headers.Add("Authorization", "Bearer $K")
  $req.Timeout = 60000
  $bytes = [Text.Encoding]::UTF8.GetBytes('{"model":"qwen2.5-3b-local","messages":[{"role":"user","content":"Count 1 to 5"}],"max_tokens":40,"stream":true}')
  $req.ContentLength = $bytes.Length
  $st = $req.GetRequestStream(); $st.Write($bytes, 0, $bytes.Length); $st.Close()
  $resp = $req.GetResponse()
  $sr = New-Object IO.StreamReader($resp.GetResponseStream())
  $lines = @()
  for ($i = 0; $i -lt 6; $i++) { $line = $sr.ReadLine(); if ($null -eq $line) { break }; $lines += $line; if ($i -eq 1) { "TTFB_ms=$([int]$sw.Elapsed.TotalMilliseconds)" } }
  "STREAM_LINES: $($lines.Count)"
  "STREAM_FIRST: $($lines[0].Substring(0, [Math]::Min(120, $lines[0].Length)))"
  $sr.Close(); $resp.Close()
} catch { "STREAM_FAIL: $_" }
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
'DONE'