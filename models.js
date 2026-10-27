"use strict";

const CHAT = "chat";
const EMBEDDING = "embedding";

/*
 * Public model catalogue.
 *
 * `id`      - the model name exposed by this gateway (Ollama name without :latest)
 * `ollama`  - the exact model name sent to the Ollama backend
 * `type`    - chat | embedding
 * `family`  - informational only
 * `params`  - approximate parameter count, informational only
 *
 * Thinking models:
 * `supportsThinking` - the model can emit hidden reasoning
 * `thinkParam`       - the backend honours the `think` flag for this model
 * `defaultThink`     - value used when the client does not ask either way
 *
 * Only models that actually exist on the backend are listed here. Requests for
 * any other model are rejected; the gateway never substitutes a different model.
 */
const MODELS = [
  {
    id: "qwen-coder-3b",
    ollama: "qwen-coder-3b:latest",
    type: CHAT,
    family: "qwen2",
    params: "3.1B"
  },
  {
    id: "qwen-coder-1.5b-local",
    ollama: "qwen-coder-1.5b-local:latest",
    type: CHAT,
    family: "qwen2",
    params: "1.8B"
  },
  {
    id: "qwen2.5-3b-local",
    ollama: "qwen2.5-3b-local:latest",
    type: CHAT,
    family: "qwen2",
    params: "3.1B"
  },
  {
    id: "llama32-3b",
    ollama: "llama32-3b:latest",
    type: CHAT,
    family: "llama",
    params: "3.2B"
  },
  {
    id: "llama3.2-1b-local",
    ollama: "llama3.2-1b-local:latest",
    type: CHAT,
    family: "llama",
    params: "1.2B"
  },
  {
    id: "qwen3-4b-local",
    ollama: "qwen3-4b-local:latest",
    type: CHAT,
    family: "qwen3",
    params: "4.0B",
    supportsThinking: true,
    thinkParam: true,
    defaultThink: false
  },
  {
    id: "qwen3-1.7b-local",
    ollama: "qwen3-1.7b-local:latest",
    type: CHAT,
    family: "qwen3",
    params: "1.7B",
    supportsThinking: true,
    thinkParam: true,
    defaultThink: false
  },
  {
    id: "qwen3-router",
    ollama: "qwen3-router:latest",
    type: CHAT,
    family: "qwen3",
    params: "0.8B",
    supportsThinking: true,
    thinkParam: true,
    defaultThink: false
  },
  {
    id: "deepseek-r1-1.5b-local",
    ollama: "deepseek-r1-1.5b-local:latest",
    type: CHAT,
    family: "qwen2",
    params: "1.8B",
    supportsThinking: true,
    thinkParam: false,
    defaultThink: true
  },
  {
    id: "smollm3-3b-local",
    ollama: "smollm3-3b-local:latest",
    type: CHAT,
    family: "smollm3",
    params: "3.1B",
    supportsThinking: true,
    thinkParam: true,
    defaultThink: false
  },
  {
    id: "gemma3-1b-local",
    ollama: "gemma3-1b-local:latest",
    type: CHAT,
    family: "gemma3",
    params: "1.0B"
  },
  {
    id: "phi4-mini-local",
    ollama: "phi4-mini-local:latest",
    type: CHAT,
    family: "phi3",
    params: "3.8B"
  },
  {
    id: "aya-8b-local",
    ollama: "aya-8b-local:latest",
    type: CHAT,
    family: "command-r",
    params: "8.0B"
  },
  {
    id: "bge-m3-local",
    ollama: "bge-m3-local:latest",
    type: EMBEDDING,
    family: "bert",
    params: "567M",
    dimensions: 1024
  },
  {
    id: "nomic-embed-local",
    ollama: "nomic-embed-local:latest",
    type: EMBEDDING,
    family: "nomic-bert",
    params: "137M",
    dimensions: 768
  },
  {
    id: "qwen3-embedding-0.6b-local",
    ollama: "qwen3-embedding-0.6b-local:latest",
    type: EMBEDDING,
    family: "qwen3",
    params: "596M",
    dimensions: 1024
  }
];

const BY_ID = new Map(MODELS.map((model) => [model.id.toLowerCase(), model]));

function normalizeModelId(rawId) {
  if (typeof rawId !== "string") return "";
  let id = rawId.trim();
  if (id.toLowerCase().endsWith(":latest")) id = id.slice(0, -":latest".length);
  return id;
}

function resolveModel(rawId) {
  const id = normalizeModelId(rawId);
  if (!id) return null;
  return BY_ID.get(id.toLowerCase()) || null;
}

module.exports = {
  CHAT,
  EMBEDDING,
  MODELS,
  normalizeModelId,
  resolveModel
};
