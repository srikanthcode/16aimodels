"use strict";

const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const { MODELS, CHAT, EMBEDDING, resolveModel } = require("./models");

const APP_VERSION = "1.0.0";
const STARTED_AT = Date.now();
const NODE_ENV = process.env.NODE_ENV || "production";

function envInt(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    console.error(`[fatal] ${name} must be an integer between ${min} and ${max}.`);
    process.exit(1);
  }
  return value;
}

const PORT = envInt("PORT", 10000, 0, 65535);
const UPSTREAM_TIMEOUT_MS = envInt("UPSTREAM_TIMEOUT_MS", 300000, 1000, 900000);
const MAX_BODY_BYTES = envInt("MAX_BODY_BYTES", 10 * 1024 * 1024, 1024, 64 * 1024 * 1024);
const MAX_EMBED_INPUTS = envInt("MAX_EMBED_INPUTS", 256, 1, 2048);
const OLLAMA_NUM_CTX = envInt("OLLAMA_NUM_CTX", 0, 0, 1048576);
const HEALTH_CACHE_MS = 5000;
const OLLAMA_KEEP_ALIVE_RAW = process.env.OLLAMA_KEEP_ALIVE || "";
const OLLAMA_KEEP_ALIVE = /^-?\d+$/.test(OLLAMA_KEEP_ALIVE_RAW)
  ? Number(OLLAMA_KEEP_ALIVE_RAW)
  : OLLAMA_KEEP_ALIVE_RAW;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const APP_API_KEY = process.env.APP_API_KEY || "";
const HYPERNET_OLLAMA_URL = (process.env.HYPERNET_OLLAMA_URL || "").trim();
const HYPERNET_API_KEY = process.env.HYPERNET_API_KEY || "";

function fatal(message) {
  console.error(`[fatal] ${message}`);
  process.exit(1);
}

if (!APP_API_KEY || APP_API_KEY.length < 16) {
  fatal("APP_API_KEY must be set to a strong secret of at least 16 characters.");
}
if (!HYPERNET_OLLAMA_URL) {
  fatal("HYPERNET_OLLAMA_URL must be set.");
}

let UPSTREAM;
try {
  UPSTREAM = new URL(HYPERNET_OLLAMA_URL);
} catch {
  fatal("HYPERNET_OLLAMA_URL is not a valid URL.");
}
if (UPSTREAM.protocol !== "https:" && UPSTREAM.protocol !== "http:") {
  fatal("HYPERNET_OLLAMA_URL must use http:// or https://.");
}
if (UPSTREAM.username || UPSTREAM.password) {
  fatal("HYPERNET_OLLAMA_URL must not contain credentials.");
}
if (UPSTREAM.search || UPSTREAM.hash) {
  fatal("HYPERNET_OLLAMA_URL must not contain a query string or fragment.");
}
if (UPSTREAM.pathname === "/") UPSTREAM.pathname = "";
const UPSTREAM_BASE_PATH = UPSTREAM.pathname.replace(/\/+$/, "");
const UPSTREAM_HOSTNAME = UPSTREAM.hostname.startsWith("[") && UPSTREAM.hostname.endsWith("]")
  ? UPSTREAM.hostname.slice(1, -1)
  : UPSTREAM.hostname;

if (UPSTREAM.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(UPSTREAM_HOSTNAME)) {
  console.error("[warn] HYPERNET_OLLAMA_URL uses plain HTTP. Use an HTTPS tunnel in production.");
}

const upstreamAgent = UPSTREAM.protocol === "https:"
  ? new https.Agent({ keepAlive: true, maxSockets: 32 })
  : new http.Agent({ keepAlive: true, maxSockets: 32 });

const APP_KEY_DIGEST = crypto.createHash("sha256").update(APP_API_KEY, "utf8").digest();

class ApiError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.type = options.type || (statusCode >= 500 ? "server_error" : "invalid_request_error");
    this.param = options.param === undefined ? null : options.param;
    this.code = options.code || null;
    this.expose = options.expose === undefined ? statusCode < 500 : Boolean(options.expose);
  }
}

class UpstreamError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "UpstreamError";
    this.status = options.status || 0;
    this.body = options.body || "";
  }
}

function log(level, message, fields) {
  const parts = [`[${new Date().toISOString()}]`, level, message];
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      parts.push(`${key}=${String(value).replace(/[\s"]+/g, "_").slice(0, 200)}`);
    }
  }
  const line = parts.join(" ");
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

function authorized(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string") return false;
  const match = /^Bearer\s+(\S.*)$/i.exec(header.trim());
  if (!match) return false;
  const provided = crypto.createHash("sha256").update(match[1].trim(), "utf8").digest();
  return provided.length === APP_KEY_DIGEST.length && crypto.timingSafeEqual(provided, APP_KEY_DIGEST);
}

function corsHeaders(req) {
  const configured = CORS_ORIGIN.trim();
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  let allow = null;
  if (configured === "*") {
    allow = "*";
  } else if (configured && origin) {
    const allowed = configured.split(",").map((value) => value.trim()).filter(Boolean);
    if (allowed.includes(origin)) allow = origin;
  }
  if (!allow) return {};
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Request-Id",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function sendJson(res, statusCode, payload) {
  if (res.writableEnded || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendError(res, err) {
  const statusCode = err.statusCode || 500;
  const exposed = err.expose !== false;
  const message = exposed && err.message
    ? err.message
    : "The gateway encountered an internal error.";
  sendJson(res, statusCode, {
    error: {
      message,
      type: err.type || (statusCode >= 500 ? "server_error" : "invalid_request_error"),
      param: err.param === undefined ? null : err.param,
      code: err.code || null
    }
  });
}

function readJsonBody(req, res) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      res.setHeader("Connection", "close");
      reject(new ApiError(413, "Request body is too large.", { code: "payload_too_large" }));
      return;
    }

    let size = 0;
    let done = false;
    const chunks = [];

    const fail = (err) => {
      if (done) return;
      done = true;
      reject(err);
    };

    req.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        res.setHeader("Connection", "close");
        req.pause();
        fail(new ApiError(413, "Request body is too large.", { code: "payload_too_large" }));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (done) return;
      done = true;
      if (size === 0) {
        reject(new ApiError(400, "Request body is required.", { code: "invalid_request" }));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        reject(new ApiError(400, "Request body must be valid JSON.", { code: "invalid_json" }));
        return;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        reject(new ApiError(400, "Request body must be a JSON object.", { code: "invalid_json" }));
        return;
      }
      resolve(parsed);
    });

    req.on("aborted", () => {
      fail(new ApiError(499, "The request was aborted.", { code: "request_aborted", expose: false }));
    });
    req.on("error", (err) => fail(err));
  });
}

function buildUpstreamUrl(pathname) {
  return new URL(`${UPSTREAM.origin}${UPSTREAM_BASE_PATH}${pathname}`);
}

function openUpstream(pathname, payload, options = {}) {
  const method = options.method || (payload === undefined ? "GET" : "POST");
  const timeoutMs = options.timeoutMs || UPSTREAM_TIMEOUT_MS;
  const signal = options.signal;
  const url = buildUpstreamUrl(pathname);
  const body = payload === undefined ? null : Buffer.from(JSON.stringify(payload), "utf8");

  const headers = { Accept: "application/json" };
  if (body) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = body.length;
  }
  if (HYPERNET_API_KEY) {
    headers.Authorization = `Bearer ${HYPERNET_API_KEY}`;
  }

  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(Object.assign(new Error("Request aborted."), { code: "ABORT_ERR" }));
      return;
    }

    let settled = false;
    const req = transport.request({
      protocol: url.protocol,
      hostname: UPSTREAM_HOSTNAME,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      agent: upstreamAgent
    }, (upstreamRes) => {
      settled = true;
      resolve(upstreamRes);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error("Upstream request timed out."), { code: "ETIMEDOUT" }));
    });

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    if (signal) {
      signal.addEventListener("abort", () => {
        req.destroy(Object.assign(new Error("Request aborted."), { code: "ABORT_ERR" }));
      }, { once: true });
    }

    if (body) req.write(body);
    req.end();
  });
}

function readAllLimited(stream, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];

    const fail = (err) => {
      if (done) return;
      done = true;
      reject(err);
    };

    stream.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        fail(new UpstreamError("Upstream response is too large.", { status: 502 }));
        stream.destroy();
        return;
      }
      chunks.push(chunk);
    });

    stream.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    stream.on("error", (err) => fail(err));
    stream.on("aborted", () => {
      fail(new UpstreamError("Upstream response was aborted.", { status: 502 }));
    });
  });
}

async function upstreamJson(pathname, payload, options = {}) {
  const upstreamRes = await openUpstream(pathname, payload, options);
  const status = upstreamRes.statusCode || 0;
  const text = await readAllLimited(upstreamRes, 8 * 1024 * 1024);
  if (status < 200 || status >= 300) {
    throw new UpstreamError(`Upstream responded with HTTP ${status}.`, { status, body: text });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError("Upstream returned invalid JSON.", { status: 502 });
  }
}

function extractUpstreamMessage(body) {
  if (!body || typeof body !== "string") return "";
  let message = "";
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed.error === "string") message = parsed.error;
    else if (parsed.error && typeof parsed.error.message === "string") message = parsed.error.message;
    else if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    return "";
  }
  return message
    .replace(/https?:\/\/\S+/gi, "[redacted]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function mapUpstreamError(err) {
  if (err instanceof ApiError) return err;

  if (err instanceof UpstreamError) {
    const status = err.status;
    const detail = extractUpstreamMessage(err.body);
    if (status === 404) {
      return new ApiError(404, "The requested model is not available on the inference backend.", {
        param: "model",
        code: "model_not_found"
      });
    }
    if (status === 400) {
      return new ApiError(400, detail || "The inference backend rejected the request.", {
        code: "upstream_invalid_request"
      });
    }
    if (status === 413) {
      return new ApiError(413, "The request is too large for the inference backend.", {
        code: "payload_too_large"
      });
    }
    if (status === 429) {
      return new ApiError(429, "The inference backend is rate limited. Try again shortly.", {
        type: "rate_limit_error",
        code: "rate_limit_exceeded"
      });
    }
    if (status === 401 || status === 403) {
      return new ApiError(502, "The gateway could not authenticate to the inference backend.", {
        code: "backend_auth_failed",
        expose: true
      });
    }
    return new ApiError(502, "The inference backend returned an error.", {
      code: "backend_error",
      expose: true
    });
  }

  if (err && (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND" || err.code === "EAI_AGAIN" || err.code === "ECONNRESET")) {
    return new ApiError(503, "The inference backend is unavailable.", {
      code: "backend_unavailable",
      expose: true
    });
  }
  if (err && err.code === "ETIMEDOUT") {
    return new ApiError(504, "The inference backend timed out.", {
      code: "backend_timeout",
      expose: true
    });
  }
  if (err && err.code === "ABORT_ERR") {
    return new ApiError(499, "The request was aborted.", {
      code: "request_aborted",
      expose: false
    });
  }
  return new ApiError(500, "The gateway encountered an internal error.", {
    code: "internal_error",
    expose: false
  });
}

let healthCache = { at: 0, ok: false };
let healthInFlight = null;

async function backendIsHealthy() {
  const now = Date.now();
  if (now - healthCache.at < HEALTH_CACHE_MS) return healthCache.ok;
  if (healthInFlight) return healthInFlight;

  healthInFlight = (async () => {
    try {
      await upstreamJson("/api/tags", undefined, { method: "GET", timeoutMs: 4000 });
      healthCache = { at: Date.now(), ok: true };
    } catch {
      healthCache = { at: Date.now(), ok: false };
    } finally {
      healthInFlight = null;
    }
    return healthCache.ok;
  })();

  return healthInFlight;
}

function modelObject(model) {
  return {
    id: model.id,
    object: "model",
    created: 0,
    owned_by: "local",
    type: model.type
  };
}

function handleRoot(req, res) {
  sendJson(res, 200, {
    name: "hypernet-ai-gateway",
    version: APP_VERSION,
    description: "OpenAI-compatible gateway for locally hosted models.",
    endpoints: [
      "/health",
      "/v1/models",
      "/v1/chat/completions",
      "/v1/completions",
      "/v1/embeddings"
    ]
  });
}

async function handleHealth(req, res) {
  const ok = await backendIsHealthy();
  sendJson(res, 200, {
    status: ok ? "ok" : "degraded",
    gateway: "online",
    backend: ok ? "online" : "offline",
    version: APP_VERSION,
    models: MODELS.length,
    uptime_seconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    timestamp: new Date().toISOString()
  });
}

function handleListModels(res) {
  sendJson(res, 200, {
    object: "list",
    data: MODELS.map(modelObject)
  });
}

function handleRetrieveModel(res, rawId) {
  const model = resolveModel(rawId);
  if (!model) {
    throw new ApiError(404, `The model '${String(rawId).slice(0, 100)}' does not exist.`, {
      param: "model",
      code: "model_not_found"
    });
  }
  sendJson(res, 200, modelObject(model));
}

function requireModel(rawModel, requiredType) {
  if (typeof rawModel !== "string" || rawModel.trim() === "") {
    throw new ApiError(400, "model is required.", { param: "model", code: "invalid_model" });
  }
  const model = resolveModel(rawModel);
  if (!model) {
    throw new ApiError(404, `The model '${rawModel.trim().slice(0, 100)}' does not exist.`, {
      param: "model",
      code: "model_not_found"
    });
  }
  if (requiredType && model.type !== requiredType) {
    const label = requiredType === EMBEDDING ? "an embedding" : "a chat";
    throw new ApiError(400, `The model '${model.id}' is not ${label} model.`, {
      param: "model",
      code: "model_type_mismatch"
    });
  }
  return model;
}

function numberOption(value, name, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new ApiError(400, `${name} must be a number between ${min} and ${max}.`, {
      param: name,
      code: "invalid_parameter"
    });
  }
  return value;
}

function integerOption(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ApiError(400, `${name} must be an integer between ${min} and ${max}.`, {
      param: name,
      code: "invalid_parameter"
    });
  }
  return value;
}

function buildOptions(body) {
  const options = {};

  if (body.temperature !== undefined) options.temperature = numberOption(body.temperature, "temperature", 0, 2);
  if (body.top_p !== undefined) options.top_p = numberOption(body.top_p, "top_p", 0, 1);
  if (body.top_k !== undefined) options.top_k = integerOption(body.top_k, "top_k", 1, 1000);
  if (body.min_p !== undefined) options.min_p = numberOption(body.min_p, "min_p", 0, 1);
  if (body.frequency_penalty !== undefined) options.frequency_penalty = numberOption(body.frequency_penalty, "frequency_penalty", -2, 2);
  if (body.presence_penalty !== undefined) options.presence_penalty = numberOption(body.presence_penalty, "presence_penalty", -2, 2);
  if (body.repeat_penalty !== undefined) options.repeat_penalty = numberOption(body.repeat_penalty, "repeat_penalty", 0, 4);
  if (body.seed !== undefined) options.seed = integerOption(body.seed, "seed", 0, 2147483647);

  const maxTokens = body.max_tokens !== undefined ? body.max_tokens : body.max_completion_tokens;
  if (maxTokens !== undefined) options.num_predict = integerOption(maxTokens, "max_tokens", 1, 131072);

  if (body.stop !== undefined) {
    const stops = Array.isArray(body.stop) ? body.stop : [body.stop];
    if (stops.length === 0 || stops.length > 16 || stops.some((value) => typeof value !== "string" || value.length === 0)) {
      throw new ApiError(400, "stop must be a non-empty string or an array of up to 16 non-empty strings.", {
        param: "stop",
        code: "invalid_parameter"
      });
    }
    options.stop = stops;
  }

  if (OLLAMA_NUM_CTX > 0) options.num_ctx = OLLAMA_NUM_CTX;
  return options;
}

function parseStream(value) {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new ApiError(400, "stream must be a boolean.", { param: "stream", code: "invalid_parameter" });
  }
  return value;
}

function parseIncludeUsage(streamOptions, stream) {
  if (streamOptions === undefined) return false;
  if (!streamOptions || typeof streamOptions !== "object" || Array.isArray(streamOptions)) {
    throw new ApiError(400, "stream_options must be an object.", {
      param: "stream_options",
      code: "invalid_parameter"
    });
  }
  const include = streamOptions.include_usage;
  if (include === undefined) return false;
  if (typeof include !== "boolean") {
    throw new ApiError(400, "stream_options.include_usage must be a boolean.", {
      param: "stream_options.include_usage",
      code: "invalid_parameter"
    });
  }
  if (!stream) {
    throw new ApiError(400, "stream_options is only valid when stream is true.", {
      param: "stream_options",
      code: "invalid_parameter"
    });
  }
  return include;
}

function resolveThink(model, body) {
  if (body.think !== undefined && typeof body.think !== "boolean") {
    throw new ApiError(400, "think must be a boolean.", { param: "think", code: "invalid_parameter" });
  }

  let requested;
  if (body.think !== undefined) {
    requested = body.think;
  } else if (body.reasoning_effort !== undefined) {
    const effort = body.reasoning_effort;
    if (effort !== "none" && effort !== "minimal" && effort !== "low" && effort !== "medium" && effort !== "high") {
      throw new ApiError(400, "reasoning_effort must be one of none, minimal, low, medium, high.", {
        param: "reasoning_effort",
        code: "invalid_parameter"
      });
    }
    requested = effort !== "none";
  }

  if (requested === true && !model.supportsThinking) {
    throw new ApiError(400, `The model '${model.id}' does not support thinking output.`, {
      param: "think",
      code: "unsupported_parameter"
    });
  }
  if (requested === false) {
    return model.thinkParam ? false : undefined;
  }
  if (requested === true) {
    return model.thinkParam ? true : undefined;
  }
  return model.thinkParam ? Boolean(model.defaultThink) : undefined;
}

function resolveFormat(body) {
  const format = body.response_format;
  if (format === undefined || format === null) return undefined;
  if (typeof format !== "object" || Array.isArray(format)) {
    throw new ApiError(400, "response_format must be an object.", {
      param: "response_format",
      code: "invalid_parameter"
    });
  }
  if (format.type === "text") return undefined;
  if (format.type === "json_object") return "json";
  if (format.type === "json_schema") {
    const spec = format.json_schema;
    const schema = spec && (spec.schema || (spec.type === "object" ? spec : undefined));
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      throw new ApiError(400, "response_format.json_schema must include a JSON schema object.", {
        param: "response_format.json_schema",
        code: "invalid_parameter"
      });
    }
    return schema;
  }
  throw new ApiError(400, "response_format.type must be text, json_object, or json_schema.", {
    param: "response_format.type",
    code: "invalid_parameter"
  });
}

function normalizeTools(body) {
  if (body.tool_choice === "none") return undefined;
  if (body.tool_choice !== undefined && body.tool_choice !== null && body.tool_choice !== "auto") {
    throw new ApiError(400, "Only tool_choice 'auto' and 'none' are supported.", {
      param: "tool_choice",
      code: "unsupported_parameter"
    });
  }

  const tools = body.tools;
  if (tools === undefined) return undefined;
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new ApiError(400, "tools must be a non-empty array.", { param: "tools", code: "invalid_parameter" });
  }
  if (tools.length > 64) {
    throw new ApiError(400, "tools must contain at most 64 entries.", { param: "tools", code: "invalid_parameter" });
  }

  return tools.map((tool, index) => {
    const fn = tool && tool.type === "function" ? tool.function : null;
    if (!fn || typeof fn.name !== "string" || fn.name.trim() === "") {
      throw new ApiError(400, `tools[${index}] must be a function tool with a name.`, {
        param: `tools[${index}]`,
        code: "invalid_parameter"
      });
    }
    if (fn.parameters !== undefined && (fn.parameters === null || typeof fn.parameters !== "object" || Array.isArray(fn.parameters))) {
      throw new ApiError(400, `tools[${index}].function.parameters must be an object.`, {
        param: `tools[${index}].function.parameters`,
        code: "invalid_parameter"
      });
    }
    return {
      type: "function",
      function: {
        name: fn.name.trim(),
        ...(typeof fn.description === "string" ? { description: fn.description } : {}),
        parameters: fn.parameters || { type: "object", properties: {} }
      }
    };
  });
}

function rejectUnsupportedChatParams(body) {
  if (body.n !== undefined && body.n !== 1) {
    throw new ApiError(400, "Only n=1 is supported.", { param: "n", code: "unsupported_parameter" });
  }
  if (body.logprobs !== undefined && body.logprobs !== false) {
    throw new ApiError(400, "logprobs is not supported.", { param: "logprobs", code: "unsupported_parameter" });
  }
  if (body.top_logprobs !== undefined) {
    throw new ApiError(400, "top_logprobs is not supported.", { param: "top_logprobs", code: "unsupported_parameter" });
  }
  if (body.audio !== undefined) {
    throw new ApiError(400, "Audio output is not supported.", { param: "audio", code: "unsupported_parameter" });
  }
  if (body.modalities !== undefined) {
    const modalities = body.modalities;
    if (!Array.isArray(modalities) || modalities.some((value) => value !== "text")) {
      throw new ApiError(400, "Only text modality is supported.", {
        param: "modalities",
        code: "unsupported_parameter"
      });
    }
  }
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ApiError(400, "messages must be a non-empty array.", {
      param: "messages",
      code: "invalid_messages"
    });
  }
  if (messages.length > 256) {
    throw new ApiError(400, "messages must contain at most 256 entries.", {
      param: "messages",
      code: "invalid_messages"
    });
  }

  return messages.map((message, index) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new ApiError(400, `messages[${index}] must be an object.`, {
        param: `messages[${index}]`,
        code: "invalid_messages"
      });
    }

    let role = message.role;
    if (role === "developer") role = "system";
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
      throw new ApiError(400, `messages[${index}].role is not supported.`, {
        param: `messages[${index}].role`,
        code: "invalid_messages"
      });
    }

    let content = message.content;
    if (Array.isArray(content)) {
      const parts = [];
      for (const part of content) {
        if (!part || part.type !== "text" || typeof part.text !== "string") {
          throw new ApiError(400, `messages[${index}].content supports text parts only.`, {
            param: `messages[${index}].content`,
            code: "unsupported_content"
          });
        }
        parts.push(part.text);
      }
      content = parts.join("\n");
    }

    if (content === undefined || content === null) {
      if (role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        content = "";
      } else {
        throw new ApiError(400, `messages[${index}].content must be a string.`, {
          param: `messages[${index}].content`,
          code: "invalid_messages"
        });
      }
    }
    if (typeof content !== "string") {
      throw new ApiError(400, `messages[${index}].content must be a string.`, {
        param: `messages[${index}].content`,
        code: "invalid_messages"
      });
    }

    const normalized = { role, content };

    if (role === "tool") {
      const toolName = message.tool_name || message.name;
      if (typeof toolName === "string" && toolName.trim() !== "") {
        normalized.tool_name = toolName.trim();
      }
    }

    if (role === "assistant" && message.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls)) {
        throw new ApiError(400, `messages[${index}].tool_calls must be an array.`, {
          param: `messages[${index}].tool_calls`,
          code: "invalid_tool_calls"
        });
      }
      normalized.tool_calls = message.tool_calls.map((call, callIndex) => {
        const fn = call && call.function;
        if (!fn || typeof fn.name !== "string" || fn.name.trim() === "") {
          throw new ApiError(400, `messages[${index}].tool_calls[${callIndex}].function.name is required.`, {
            param: `messages[${index}].tool_calls[${callIndex}]`,
            code: "invalid_tool_calls"
          });
        }
        let args = fn.arguments;
        if (typeof args === "string") {
          if (args.trim() === "") {
            args = {};
          } else {
            try {
              args = JSON.parse(args);
            } catch {
              throw new ApiError(400, `messages[${index}].tool_calls[${callIndex}].function.arguments must be valid JSON.`, {
                param: `messages[${index}].tool_calls[${callIndex}].function.arguments`,
                code: "invalid_tool_calls"
              });
            }
          }
        }
        if (args === undefined || args === null) args = {};
        if (typeof args !== "object" || Array.isArray(args)) {
          throw new ApiError(400, `messages[${index}].tool_calls[${callIndex}].function.arguments must be an object.`, {
            param: `messages[${index}].tool_calls[${callIndex}].function.arguments`,
            code: "invalid_tool_calls"
          });
        }
        return { function: { name: fn.name.trim(), arguments: args } };
      });
    }

    return normalized;
  });
}

function normalizePrompt(prompt) {
  if (typeof prompt === "string") {
    if (prompt.length === 0) {
      throw new ApiError(400, "prompt must not be empty.", { param: "prompt", code: "invalid_prompt" });
    }
    return prompt;
  }
  if (Array.isArray(prompt)) {
    if (prompt.length !== 1) {
      throw new ApiError(400, "Only a single prompt is supported.", {
        param: "prompt",
        code: "unsupported_prompt"
      });
    }
    const first = prompt[0];
    if (typeof first === "string" && first.length > 0) return first;
    throw new ApiError(400, "Token-array prompts are not supported.", {
      param: "prompt",
      code: "unsupported_prompt"
    });
  }
  throw new ApiError(400, "prompt must be a non-empty string.", {
    param: "prompt",
    code: "invalid_prompt"
  });
}

function rejectUnsupportedCompletionParams(body) {
  if (body.n !== undefined && body.n !== 1) {
    throw new ApiError(400, "Only n=1 is supported.", { param: "n", code: "unsupported_parameter" });
  }
  if (body.echo !== undefined && body.echo !== false) {
    throw new ApiError(400, "echo is not supported.", { param: "echo", code: "unsupported_parameter" });
  }
  if (body.logprobs !== undefined) {
    throw new ApiError(400, "logprobs is not supported.", { param: "logprobs", code: "unsupported_parameter" });
  }
  if (body.best_of !== undefined) {
    throw new ApiError(400, "best_of is not supported.", { param: "best_of", code: "unsupported_parameter" });
  }
  if (body.suffix !== undefined) {
    throw new ApiError(400, "suffix is not supported.", { param: "suffix", code: "unsupported_parameter" });
  }
}

function normalizeEmbeddingInput(input) {
  let values;
  if (typeof input === "string") {
    values = [input];
  } else if (Array.isArray(input)) {
    if (input.length === 0) {
      throw new ApiError(400, "input must not be empty.", { param: "input", code: "invalid_input" });
    }
    if (input.length > MAX_EMBED_INPUTS) {
      throw new ApiError(400, `input supports at most ${MAX_EMBED_INPUTS} strings per request.`, {
        param: "input",
        code: "invalid_input"
      });
    }
    for (let index = 0; index < input.length; index++) {
      if (typeof input[index] !== "string") {
        throw new ApiError(400, `input[${index}] must be a string. Token arrays are not supported.`, {
          param: `input[${index}]`,
          code: "unsupported_input"
        });
      }
    }
    values = input;
  } else {
    throw new ApiError(400, "input must be a string or an array of strings.", {
      param: "input",
      code: "invalid_input"
    });
  }

  for (let index = 0; index < values.length; index++) {
    if (values[index].length === 0) {
      throw new ApiError(400, `input[${index}] must not be empty.`, {
        param: `input[${index}]`,
        code: "invalid_input"
      });
    }
    if (values[index].length > 100000) {
      throw new ApiError(400, `input[${index}] is too long.`, {
        param: `input[${index}]`,
        code: "invalid_input"
      });
    }
  }

  return values;
}

function parseEncodingFormat(value) {
  if (value === undefined || value === null || value === "float") return "float";
  if (value === "base64") return "base64";
  throw new ApiError(400, "encoding_format must be 'float' or 'base64'.", {
    param: "encoding_format",
    code: "invalid_parameter"
  });
}

const SPECIAL_TOKEN_PATTERNS = [
  /<\|[^|>]{1,80}\|>/g,
  /<[｜|][^｜|>]{1,80}[｜|]>/g,
  /<end_of_turn>/gi,
  /<start_of_turn>/gi,
  /<eot_id>/gi,
  /<\/s>/g,
  /<unk>/gi,
  /<pad>/gi,
  /<bos>/gi,
  /<eos>/gi
];

function sanitizeText(value) {
  if (typeof value !== "string" || value === "") return "";
  let text = value;
  for (const pattern of SPECIAL_TOKEN_PATTERNS) text = text.replace(pattern, "");
  return text;
}

function normalizeUsage(promptTokens, completionTokens) {
  const prompt = Number.isInteger(promptTokens) ? promptTokens : 0;
  const completion = Number.isInteger(completionTokens) ? completionTokens : 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion
  };
}

function usageFromOllama(result) {
  return normalizeUsage(result && result.prompt_eval_count, result && result.eval_count);
}

function mapFinishReason(reason) {
  if (reason === "length") return "length";
  if (reason === "tool_calls") return "tool_calls";
  return "stop";
}

function normalizeArguments(args) {
  if (typeof args === "string") {
    if (args.trim() === "") return {};
    try {
      return JSON.parse(args);
    } catch {
      return {};
    }
  }
  if (args && typeof args === "object" && !Array.isArray(args)) return args;
  return {};
}

function mapToolCalls(toolCalls, streaming) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return [];
  return toolCalls.map((call, index) => {
    const fn = call && call.function;
    const name = fn && typeof fn.name === "string" ? fn.name : "tool";
    const args = normalizeArguments(fn && fn.arguments);
    const mapped = {
      id: `call_${crypto.randomBytes(12).toString("hex")}`,
      type: "function",
      function: {
        name,
        arguments: JSON.stringify(args)
      }
    };
    if (streaming) mapped.index = index;
    return mapped;
  });
}

function beginStream(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();
}

function sseEvent(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

async function writeStream(res, payload) {
  if (res.writableEnded || res.destroyed) return false;
  const text = typeof payload === "string" ? payload : sseEvent(payload);
  const ok = res.write(text);
  if (ok) return true;
  await new Promise((resolve) => {
    const cleanup = () => {
      res.removeListener("drain", onDrain);
      res.removeListener("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
  return !res.writableEnded && !res.destroyed;
}

async function streamChatCompletions(res, model, payload, includeUsage) {
  const controller = new AbortController();
  let clientGone = false;
  const onClose = () => {
    clientGone = true;
    controller.abort();
  };
  res.on("close", onClose);

  let upstreamRes;
  try {
    upstreamRes = await openUpstream("/api/chat", payload, { signal: controller.signal });
  } catch (err) {
    res.removeListener("close", onClose);
    throw err;
  }

  const status = upstreamRes.statusCode || 0;
  if (status < 200 || status >= 300) {
    const text = await readAllLimited(upstreamRes, 2 * 1024 * 1024).catch(() => "");
    res.removeListener("close", onClose);
    throw new UpstreamError(`Upstream responded with HTTP ${status}.`, { status, body: text });
  }

  beginStream(res);

  const id = `chatcmpl-${crypto.randomBytes(16).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);
  const base = {
    id,
    object: "chat.completion.chunk",
    created,
    model: model.id,
    system_fingerprint: "fp_local"
  };

  await writeStream(res, {
    ...base,
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]
  });

  let buffer = "";
  let finished = false;
  let toolCallsSent = false;

  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(": keep-alive\n\n");
  }, 15000);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  try {
    for await (const chunk of upstreamRes) {
      if (clientGone || res.writableEnded) break;
      buffer += chunk.toString("utf8");

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line === "") continue;

        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        if (event.error) {
          throw Object.assign(new Error("Upstream stream error."), { code: "UPSTREAM_STREAM" });
        }

        const message = event.message || {};
        const thinking = sanitizeText(message.thinking || message.reasoning || "");
        if (thinking) {
          await writeStream(res, {
            ...base,
            choices: [{ index: 0, delta: { reasoning_content: thinking }, finish_reason: null }]
          });
        }

        const content = sanitizeText(message.content);
        if (content) {
          await writeStream(res, {
            ...base,
            choices: [{ index: 0, delta: { content }, finish_reason: null }]
          });
        }

        const toolCalls = mapToolCalls(message.tool_calls, true);
        if (toolCalls.length > 0) {
          toolCallsSent = true;
          await writeStream(res, {
            ...base,
            choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }]
          });
        }

        if (event.done === true) {
          finished = true;
          const finishReason = toolCallsSent ? "tool_calls" : mapFinishReason(event.done_reason);
          await writeStream(res, {
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
          });
          if (includeUsage) {
            await writeStream(res, {
              ...base,
              choices: [],
              usage: usageFromOllama(event)
            });
          }
          await writeStream(res, "data: [DONE]\n\n");
          res.end();
          return;
        }
      }
    }

    if (!finished && !res.writableEnded) {
      await writeStream(res, {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      });
      if (includeUsage) {
        await writeStream(res, {
          ...base,
          choices: [],
          usage: normalizeUsage(0, 0)
        });
      }
      await writeStream(res, "data: [DONE]\n\n");
      res.end();
    }
  } catch (err) {
    if (clientGone || res.writableEnded) return;
    log("error", "chat_stream_failed", { code: err && err.code, model: model.id });
    await writeStream(res, {
      error: {
        message: "The response stream was interrupted.",
        type: "server_error",
        param: null,
        code: "upstream_stream_error"
      }
    });
    await writeStream(res, "data: [DONE]\n\n");
    if (!res.writableEnded) res.end();
  } finally {
    clearInterval(heartbeat);
    res.removeListener("close", onClose);
    if (!upstreamRes.destroyed) upstreamRes.destroy();
  }
}

async function handleChatCompletions(req, res) {
  const body = await readJsonBody(req, res);

  rejectUnsupportedChatParams(body);
  const model = requireModel(body.model, CHAT);
  const messages = normalizeMessages(body.messages);
  const stream = parseStream(body.stream);
  const includeUsage = parseIncludeUsage(body.stream_options, stream);
  const tools = normalizeTools(body);
  const options = buildOptions(body);
  const format = resolveFormat(body);
  const think = resolveThink(model, body);

  const payload = { model: model.ollama, messages, stream };
  if (Object.keys(options).length > 0) payload.options = options;
  if (format !== undefined) payload.format = format;
  if (tools !== undefined) payload.tools = tools;
  if (think !== undefined) payload.think = think;
  if (OLLAMA_KEEP_ALIVE_RAW) payload.keep_alive = OLLAMA_KEEP_ALIVE;

  if (stream) {
    await streamChatCompletions(res, model, payload, includeUsage);
    return;
  }

  const result = await upstreamJson("/api/chat", payload);
  const source = result && result.message ? result.message : {};
  const content = sanitizeText(source.content);
  const thinking = sanitizeText(source.thinking || source.reasoning || "");
  const toolCalls = mapToolCalls(source.tool_calls, false);
  const finishReason = toolCalls.length > 0 ? "tool_calls" : mapFinishReason(result.done_reason);

  const output = {
    role: "assistant",
    content: toolCalls.length > 0 ? null : content
  };
  if (thinking) output.reasoning_content = thinking;
  if (toolCalls.length > 0) output.tool_calls = toolCalls;

  sendJson(res, 200, {
    id: `chatcmpl-${crypto.randomBytes(16).toString("hex")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model.id,
    system_fingerprint: "fp_local",
    choices: [
      {
        index: 0,
        message: output,
        logprobs: null,
        finish_reason: finishReason
      }
    ],
    usage: usageFromOllama(result)
  });
}

async function streamCompletions(res, model, payload, includeUsage) {
  const controller = new AbortController();
  let clientGone = false;
  const onClose = () => {
    clientGone = true;
    controller.abort();
  };
  res.on("close", onClose);

  let upstreamRes;
  try {
    upstreamRes = await openUpstream("/api/generate", payload, { signal: controller.signal });
  } catch (err) {
    res.removeListener("close", onClose);
    throw err;
  }

  const status = upstreamRes.statusCode || 0;
  if (status < 200 || status >= 300) {
    const text = await readAllLimited(upstreamRes, 2 * 1024 * 1024).catch(() => "");
    res.removeListener("close", onClose);
    throw new UpstreamError(`Upstream responded with HTTP ${status}.`, { status, body: text });
  }

  beginStream(res);

  const id = `cmpl-${crypto.randomBytes(16).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);
  const base = {
    id,
    object: "text_completion",
    created,
    model: model.id
  };

  let buffer = "";
  let finished = false;

  const heartbeat = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(": keep-alive\n\n");
  }, 15000);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  try {
    for await (const chunk of upstreamRes) {
      if (clientGone || res.writableEnded) break;
      buffer += chunk.toString("utf8");

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line === "") continue;

        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        if (event.error) {
          throw Object.assign(new Error("Upstream stream error."), { code: "UPSTREAM_STREAM" });
        }

        const text = sanitizeText(event.response || "");
        if (text) {
          await writeStream(res, {
            ...base,
            choices: [{ text, index: 0, logprobs: null, finish_reason: null }]
          });
        }

        if (event.done === true) {
          finished = true;
          await writeStream(res, {
            ...base,
            choices: [{ text: "", index: 0, logprobs: null, finish_reason: mapFinishReason(event.done_reason) }]
          });
          if (includeUsage) {
            await writeStream(res, {
              ...base,
              choices: [],
              usage: usageFromOllama(event)
            });
          }
          await writeStream(res, "data: [DONE]\n\n");
          res.end();
          return;
        }
      }
    }

    if (!finished && !res.writableEnded) {
      await writeStream(res, {
        ...base,
        choices: [{ text: "", index: 0, logprobs: null, finish_reason: "stop" }]
      });
      if (includeUsage) {
        await writeStream(res, {
          ...base,
          choices: [],
          usage: normalizeUsage(0, 0)
        });
      }
      await writeStream(res, "data: [DONE]\n\n");
      res.end();
    }
  } catch (err) {
    if (clientGone || res.writableEnded) return;
    log("error", "completion_stream_failed", { code: err && err.code, model: model.id });
    await writeStream(res, {
      error: {
        message: "The response stream was interrupted.",
        type: "server_error",
        param: null,
        code: "upstream_stream_error"
      }
    });
    await writeStream(res, "data: [DONE]\n\n");
    if (!res.writableEnded) res.end();
  } finally {
    clearInterval(heartbeat);
    res.removeListener("close", onClose);
    if (!upstreamRes.destroyed) upstreamRes.destroy();
  }
}

async function handleCompletions(req, res) {
  const body = await readJsonBody(req, res);

  rejectUnsupportedCompletionParams(body);
  const model = requireModel(body.model, CHAT);
  const prompt = normalizePrompt(body.prompt);
  const stream = parseStream(body.stream);
  const includeUsage = parseIncludeUsage(body.stream_options, stream);
  const options = buildOptions(body);
  const format = resolveFormat(body);
  const think = resolveThink(model, body);

  const payload = { model: model.ollama, prompt, stream };
  if (Object.keys(options).length > 0) payload.options = options;
  if (format !== undefined) payload.format = format;
  if (think !== undefined) payload.think = think;
  if (OLLAMA_KEEP_ALIVE_RAW) payload.keep_alive = OLLAMA_KEEP_ALIVE;

  if (stream) {
    await streamCompletions(res, model, payload, includeUsage);
    return;
  }

  const result = await upstreamJson("/api/generate", payload);
  sendJson(res, 200, {
    id: `cmpl-${crypto.randomBytes(16).toString("hex")}`,
    object: "text_completion",
    created: Math.floor(Date.now() / 1000),
    model: model.id,
    choices: [
      {
        text: sanitizeText(result.response || ""),
        index: 0,
        logprobs: null,
        finish_reason: mapFinishReason(result.done_reason)
      }
    ],
    usage: usageFromOllama(result)
  });
}

function float32ToBase64(vector) {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new UpstreamError("Upstream returned an invalid embedding vector.", { status: 502 });
  }
  const buffer = Buffer.allocUnsafe(vector.length * 4);
  for (let index = 0; index < vector.length; index++) {
    const value = Number(vector[index]);
    if (!Number.isFinite(value)) {
      throw new UpstreamError("Upstream returned a non-numeric embedding value.", { status: 502 });
    }
    buffer.writeFloatLE(value, index * 4);
  }
  return buffer.toString("base64");
}

async function handleEmbeddings(req, res) {
  const body = await readJsonBody(req, res);

  const model = requireModel(body.model, EMBEDDING);
  const input = normalizeEmbeddingInput(body.input);
  const encoding = parseEncodingFormat(body.encoding_format);

  if (body.dimensions !== undefined) {
    throw new ApiError(400, "dimensions is not supported by this gateway; omit it to use the model's native dimension.", {
      param: "dimensions",
      code: "unsupported_parameter"
    });
  }

  const result = await upstreamJson("/api/embed", { model: model.ollama, input });
  if (!result || !Array.isArray(result.embeddings) || result.embeddings.length !== input.length) {
    throw new UpstreamError("Upstream returned an unexpected embedding response.", { status: 502 });
  }

  const data = result.embeddings.map((vector, index) => {
    if (!Array.isArray(vector) || vector.length === 0) {
      throw new UpstreamError("Upstream returned an invalid embedding vector.", { status: 502 });
    }
    return {
      object: "embedding",
      index,
      embedding: encoding === "base64" ? float32ToBase64(vector) : vector
    };
  });

  const promptTokens = Number.isInteger(result.prompt_eval_count) ? result.prompt_eval_count : 0;

  sendJson(res, 200, {
    object: "list",
    data,
    model: model.id,
    usage: {
      prompt_tokens: promptTokens,
      total_tokens: promptTokens
    }
  });
}

async function routeRequest(req, res) {
  const url = new URL(req.url || "/", "http://localhost");

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    throw new ApiError(400, "The request path is not valid.", { code: "invalid_path" });
  }
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");
  if (pathname === "") pathname = "/";

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === "/health") {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET, OPTIONS");
      throw new ApiError(405, "Method not allowed.", { code: "method_not_allowed" });
    }
    await handleHealth(req, res);
    return;
  }

  if (pathname === "/") {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET, OPTIONS");
      throw new ApiError(405, "Method not allowed.", { code: "method_not_allowed" });
    }
    handleRoot(req, res);
    return;
  }

  if (!authorized(req)) {
    res.setHeader("WWW-Authenticate", "Bearer");
    throw new ApiError(401, "Invalid or missing API key.", {
      type: "invalid_request_error",
      code: "invalid_api_key"
    });
  }

  if (pathname === "/v1/models") {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET, OPTIONS");
      throw new ApiError(405, "Method not allowed.", { code: "method_not_allowed" });
    }
    handleListModels(res);
    return;
  }

  if (pathname.startsWith("/v1/models/")) {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET, OPTIONS");
      throw new ApiError(405, "Method not allowed.", { code: "method_not_allowed" });
    }
    handleRetrieveModel(res, pathname.slice("/v1/models/".length));
    return;
  }

  if (pathname === "/v1/chat/completions") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      throw new ApiError(405, "Method not allowed.", { code: "method_not_allowed" });
    }
    await handleChatCompletions(req, res);
    return;
  }

  if (pathname === "/v1/completions") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      throw new ApiError(405, "Method not allowed.", { code: "method_not_allowed" });
    }
    await handleCompletions(req, res);
    return;
  }

  if (pathname === "/v1/embeddings") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      throw new ApiError(405, "Method not allowed.", { code: "method_not_allowed" });
    }
    await handleEmbeddings(req, res);
    return;
  }

  throw new ApiError(404, "The requested endpoint does not exist.", { code: "not_found" });
}

const server = http.createServer((req, res) => {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();

  res.setHeader("x-request-id", requestId);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");

  const cors = corsHeaders(req);
  for (const [key, value] of Object.entries(cors)) res.setHeader(key, value);

  res.on("finish", () => {
    const rawPath = (req.url || "").split("?")[0];
    log("info", "request", {
      id: requestId,
      method: req.method,
      path: rawPath.length > 120 ? rawPath.slice(0, 120) : rawPath,
      status: res.statusCode,
      ms: Date.now() - startedAt
    });
  });

  routeRequest(req, res).catch((err) => {
    const apiError = mapUpstreamError(err);

    if (apiError.code === "payload_too_large") {
      res.once("finish", () => {
        try {
          req.destroy();
        } catch {
          // Socket is already closed.
        }
      });
    }

    if (!res.headersSent) {
      if (apiError.statusCode === 401) res.setHeader("WWW-Authenticate", "Bearer");
      sendError(res, apiError);
    } else if (!res.writableEnded) {
      res.end();
    }

    if (apiError.statusCode >= 500) {
      log("error", "request_failed", {
        id: requestId,
        status: apiError.statusCode,
        code: apiError.code
      });
    } else {
      log("warn", "request_rejected", {
        id: requestId,
        status: apiError.statusCode,
        code: apiError.code
      });
    }
  });
});

server.headersTimeout = 60000;
server.requestTimeout = 120000;
server.keepAliveTimeout = 65000;
server.maxHeadersCount = 100;

server.listen(PORT, "0.0.0.0", () => {
  log("info", "gateway_started", {
    port: PORT,
    models: MODELS.length,
    node: process.version,
    env: NODE_ENV
  });
});

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "shutting_down", { signal });

  const timer = setTimeout(() => process.exit(0), 10000);
  if (typeof timer.unref === "function") timer.unref();

  server.close(() => {
    upstreamAgent.destroy();
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  log("error", "unhandled_rejection", {
    message: reason && reason.message ? String(reason.message).slice(0, 200) : "unknown"
  });
});

process.on("uncaughtException", (err) => {
  log("error", "uncaught_exception", {
    message: err && err.message ? String(err.message).slice(0, 200) : "unknown"
  });
  process.exit(1);
});
