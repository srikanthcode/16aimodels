# Hypernet AI Gateway

A small, zero-dependency Node.js gateway that exposes the models running on a private Ollama host through an OpenAI-compatible API. Render hosts only this gateway; all inference stays on the private backend.

```
OpenAI SDK / curl / app
          |
          |  HTTPS  Authorization: Bearer <APP_API_KEY>
          v
  +-------------------+        HTTPS tunnel        +----------------------+
  |  Render (gateway) | -------------------------> |  private Ollama host |
  |  Node.js, no GPU  |   HYPERNET_OLLAMA_URL      |  16 local models     |
  +-------------------+   optional backend token   +----------------------+
```

## Features

- OpenAI-compatible `GET /v1/models`, `GET /v1/models/:model`, `POST /v1/chat/completions`, `POST /v1/completions`, and `POST /v1/embeddings`.
- Streaming and non-streaming responses.
- Reasoning output mapped to `reasoning_content` for thinking models.
- OpenAI function/tool calling, best effort.
- JSON mode and JSON-schema structured output.
- Embeddings with float or base64 (`float32`, little-endian) encoding.
- Strict model allowlist. Unknown models are rejected; the gateway never silently substitutes another model.
- Bearer authentication with timing-safe comparison, request-size limits, request IDs, CORS, and sanitized upstream errors.
- Public `/health` endpoint that reports backend reachability without exposing infrastructure details.
- No runtime dependencies and no build step.

## Model catalogue

Public IDs are the exact Ollama model names without the `:latest` suffix. A `:latest` suffix is accepted and normalized.

### Chat models

| Public ID | Notes |
| --- | --- |
| `qwen-coder-3b` | Qwen2 Coder, 3B |
| `qwen-coder-1.5b-local` | Qwen2 Coder, 1.8B |
| `qwen2.5-3b-local` | Qwen2.5, 3B |
| `llama32-3b` | Llama 3.2, 3B |
| `llama3.2-1b-local` | Llama 3.2, 1.2B |
| `qwen3-4b-local` | Qwen3, 4B; thinking supported, off by default |
| `qwen3-1.7b-local` | Qwen3, 1.7B; thinking supported, off by default |
| `qwen3-router` | Qwen3, 0.8B; thinking supported, off by default |
| `deepseek-r1-1.5b-local` | DeepSeek-R1, 1.8B; always reasons |
| `smollm3-3b-local` | SmolLM3, 3B; thinking supported, off by default |
| `gemma3-1b-local` | Gemma 3, 1B |
| `phi4-mini-local` | Phi-4 Mini, 3.8B |
| `aya-8b-local` | Aya, 8B |

### Embedding models

| Public ID | Native dimensions |
| --- | --- |
| `bge-m3-local` | 1024 |
| `nomic-embed-local` | 768 |
| `qwen3-embedding-0.6b-local` | 1024 |

## Requirements

- Node.js 18.17 or newer.
- A reachable Ollama backend with the models above.
- An HTTPS tunnel or reverse proxy from Render to the backend. Port `11434` must never be exposed publicly.
- The backend must support `POST /api/embed` (Ollama 0.1.36+).

## Local development

```bash
cd ai-gateway
cp .env.example .env
# edit .env, then export the variables for your shell
node server.js
```

On PowerShell:

```powershell
$env:APP_API_KEY = "local-test-key-0123456789"
$env:HYPERNET_OLLAMA_URL = "http://127.0.0.1:11434"
node server.js
```

The gateway listens on `0.0.0.0:$PORT` (default `10000`).

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `APP_API_KEY` | yes | - | Public API key, minimum 16 characters. |
| `HYPERNET_OLLAMA_URL` | yes | - | Base URL of the Ollama tunnel. No credentials, query, or fragment. A base path is allowed. |
| `HYPERNET_API_KEY` | no | empty | Bearer token sent to the tunnel/reverse proxy. |
| `PORT` | no | `10000` | Listen port. Render sets this automatically. |
| `UPSTREAM_TIMEOUT_MS` | no | `570000` | Backend timeout in milliseconds. |
| `UPSTREAM_WARMUP_TIMEOUT_MS` | no | `2700000` | After the backend timeout the client receives a 504, but the backend request is held open in the background up to this many ms so the prompt cache is seeded; a retry then completes quickly. Must exceed `UPSTREAM_TIMEOUT_MS`. |
| `MAX_BODY_BYTES` | no | `10485760` | Maximum request body size (10 MiB). |
| `MAX_EMBED_INPUTS` | no | `256` | Maximum strings per embeddings request. |
| `OLLAMA_NUM_CTX` | no | `0` | Context window override. `0` uses the backend default. |
| `OLLAMA_KEEP_ALIVE` | no | empty | Optional Ollama `keep_alive`, for example `10m`. |
| `CORS_ORIGIN` | no | `*` | `*` or a comma-separated origin allowlist. |

## Deploy to Render

### Blueprint

1. Push this directory to a Git repository.
2. In Render, create a new Blueprint and select the repository. `render.yaml` defines the service.
3. Set `APP_API_KEY`, `HYPERNET_OLLAMA_URL`, and optionally `HYPERNET_API_KEY` when prompted. These are marked `sync: false`, so they are not stored in Git.
4. Deploy. The health check is `GET /health`.

### Manual

- Runtime: Node
- Build command: `npm install --omit=dev`
- Start command: `node server.js`
- Health check path: `/health`
- Add the environment variables above.

The Free plan sleeps after inactivity and wakes on the next request. That is fine for personal use, but it is not a 24/7 guarantee. Use a paid instance if you need one.

## Tunnel setup

Any private path from Render to Ollama works. The URL must be HTTPS in production.

### Cloudflare Tunnel (recommended)

Run on the machine that can reach Ollama:

```bash
cloudflared tunnel --url http://127.0.0.1:11434
```

Protect the tunnel with Cloudflare Access or a long random `HYPERNET_API_KEY` checked by your reverse proxy. Set `HYPERNET_OLLAMA_URL` to the tunnel hostname and `HYPERNET_API_KEY` to the matching token.

### Tailscale

Expose the Ollama host over Tailscale and use a Tailscale Funnel or an HTTPS reverse proxy on the tailnet. Bind Ollama to the tailnet interface or keep it on loopback behind the proxy.

### Rules

- Terminate TLS at the tunnel or proxy.
- Authenticate every request to the backend.
- Never publish `11434` directly.
- Do not put credentials in `HYPERNET_OLLAMA_URL`.

## API examples

Set these in your shell:

```bash
export GATEWAY="https://your-gateway.onrender.com"
export API_KEY="your-app-api-key"
```

### List models

```bash
curl -s "$GATEWAY/v1/models" \
  -H "Authorization: Bearer $API_KEY"
```

### Chat

```bash
curl -s "$GATEWAY/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-4b-local",
    "messages": [{"role": "user", "content": "Explain HTTP caching in three sentences."}],
    "temperature": 0.4,
    "max_tokens": 256
  }'
```

### Streaming

```bash
curl -N "$GATEWAY/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5-3b-local",
    "messages": [{"role": "user", "content": "Write a short haiku about rain."}],
    "stream": true,
    "stream_options": {"include_usage": true}
  }'
```

The stream is standard SSE: `data: {...}` chunks followed by `data: [DONE]`. Comment lines `: keep-alive` are sent every 15 seconds while the backend is busy.

### Thinking output

```bash
curl -s "$GATEWAY/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-4b-local",
    "messages": [{"role": "user", "content": "Is 91 prime? Explain briefly."}],
    "think": true,
    "max_tokens": 512
  }'
```

Reasoning is returned in `message.reasoning_content`. For streaming, it arrives as `delta.reasoning_content`. `reasoning_effort` is also accepted: `none` disables thinking; `minimal`, `low`, `medium`, and `high` enable it where supported.

Qwen3 and SmolLM3 default to `think: false` so ordinary requests return normal content. DeepSeek-R1 always reasons and ignores `think: false`.

### Tools

```bash
curl -s "$GATEWAY/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen2.5-3b-local",
    "messages": [{"role": "user", "content": "What is the weather in Oslo?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get current weather for a city",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    }],
    "tool_choice": "auto"
  }'
```

Tool support is best effort and depends on the model. `tool_choice` may be `auto` or `none`. A specific function, `required`, and parallel tool calls are not supported.

### Completions

`POST /v1/completions` accepts a single string prompt and uses Ollama's instruction template, so it behaves like a one-message chat rather than raw text continuation.

```bash
curl -s "$GATEWAY/v1/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "llama32-3b", "prompt": "Name three uses for a paperclip.", "max_tokens": 128}'
```

### Embeddings

```bash
curl -s "$GATEWAY/v1/embeddings" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "bge-m3-local", "input": ["first document", "second document"]}'
```

- `input` may be a string or an array of up to `MAX_EMBED_INPUTS` strings.
- Token arrays are rejected.
- `encoding_format` may be `float` (default) or `base64`.
- `dimensions` is rejected; each model returns its native dimension.

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="https://your-gateway.onrender.com/v1",
    api_key="your-app-api-key",
)

response = client.chat.completions.create(
    model="qwen3-4b-local",
    messages=[{"role": "user", "content": "Say hello in Norwegian."}],
    max_tokens=128,
)
print(response.choices[0].message.content)
```

### Health

```bash
curl -s "$GATEWAY/health"
```

```json
{
  "status": "ok",
  "gateway": "online",
  "backend": "online",
  "version": "1.0.0",
  "models": 16,
  "uptime_seconds": 42,
  "timestamp": "2026-10-27T12:00:00.000Z"
}
```

`/health` always returns HTTP 200. `backend` is `offline` when the backend check fails. The check is cached for five seconds.

## Error format

Errors use the OpenAI shape:

```json
{
  "error": {
    "message": "The model 'unknown-model' does not exist.",
    "type": "invalid_request_error",
    "param": "model",
    "code": "model_not_found"
  }
}
```

| Status | Typical codes |
| --- | --- |
| 400 | `invalid_parameter`, `unsupported_parameter`, `invalid_messages`, `model_type_mismatch` |
| 401 | `invalid_api_key` |
| 404 | `model_not_found`, `not_found` |
| 413 | `payload_too_large` |
| 429 | `rate_limit_exceeded` |
| 502 | `backend_error`, `backend_auth_failed` |
| 503 | `backend_unavailable` |
| 504 | `backend_timeout` |

Upstream URLs, IP addresses, and stack traces are never returned to clients.

## Supported parameters

`temperature`, `top_p`, `top_k`, `min_p`, `frequency_penalty`, `presence_penalty`, `repeat_penalty`, `seed`, `max_tokens` (or `max_completion_tokens`), `stop`, `stream`, `stream_options.include_usage`, `response_format`, `tools`, `tool_choice` (`auto` or `none`), `think`, and `reasoning_effort`.

Rejected with `400`: `n` other than `1`, `logprobs`, `top_logprobs`, `audio`, non-text `modalities`, token-array prompts, `echo`, `best_of`, and `suffix`.

## Notes and limitations

- **DeepSeek-R1:** the model always reasons. Reasoning is returned in `reasoning_content`, and normal content follows. If a response appears to contain only reasoning, raise `max_tokens` to at least 512-1024. The gateway does not force a token budget.
- **Qwen3 thinking:** thinking is disabled by default so small models return usable content quickly. Set `think: true` or `reasoning_effort` to enable it. Expect much higher latency and token usage.
- **Aya:** the backend may leak `<|END_OF_TURN_TOKEN|>` and similar markers. The gateway strips common special-token patterns from content and reasoning.
- **Tools:** small local models may ignore tools or emit malformed arguments. Arguments are normalized to JSON objects, but behaviour is model-dependent.
- **Completions:** prompts go through the model's instruction template; this is not a raw completion endpoint.
- **Embeddings:** `dimensions` is not supported; use the model's native dimension.
- **Free Render plan:** the service sleeps after inactivity.

## Security checklist

- Use a long random `APP_API_KEY`; rotate it if it leaks.
- Put the backend behind an authenticated HTTPS tunnel.
- Keep `HYPERNET_API_KEY` and `APP_API_KEY` in Render environment variables, never in Git.
- Do not expose Ollama on a public IP or port.
- Restrict `CORS_ORIGIN` if a browser calls the gateway directly.
- Keep dependencies at zero; there is no third-party runtime code.
- Monitor logs for repeated 401, 413, and 5xx responses.

## Project structure

```
ai-gateway/
  server.js       HTTP server, routing, validation, streaming, errors
  models.js       model allowlist and lookup
  package.json    metadata and scripts
  .env.example    environment template
  .gitignore
  render.yaml     Render blueprint
  README.md
```

## Tests

```bash
npm run check
```

With the server running:

```bash
curl -s http://127.0.0.1:10000/health
curl -s http://127.0.0.1:10000/v1/models -H "Authorization: Bearer $APP_API_KEY"
```

The project has no unit tests; the endpoints are exercised against the live backend.
