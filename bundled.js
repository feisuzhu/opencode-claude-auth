// src/index.ts
import crypto from "node:crypto";

// src/model-config.ts
var config = {
  ccVersion: "2.1.90",
  baseBetas: [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "prompt-caching-scope-2026-01-05",
    "context-management-2025-06-27"
  ],
  longContextBetas: [
    "context-1m-2025-08-07",
    "interleaved-thinking-2025-05-14"
  ],
  modelOverrides: {
    haiku: {
      exclude: ["interleaved-thinking-2025-05-14"],
      disableEffort: true
    },
    "4-6": {
      add: ["effort-2025-11-24"]
    }
  }
};
function getModelOverride(modelId) {
  const lower = modelId.toLowerCase();
  for (const [pattern, override] of Object.entries(config.modelOverrides)) {
    if (lower.includes(pattern)) return override;
  }
  return null;
}

// src/logger.ts
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
var JWT_PATTERN = /^eyJ[A-Za-z0-9_-]{10,}/;
var mode = "disabled";
var logFilePath = null;
var logStream = null;
function getDefaultLogPath() {
  return join(homedir(), ".local", "share", "opencode", "claude-auth-debug.log");
}
function initLogger(options) {
  closeLogger();
  if (options?.stream) {
    mode = "stream";
    logStream = options.stream;
    return;
  }
  const envVal = process.env.CLAUDE_AUTH_DEBUG;
  if (!envVal) {
    mode = "disabled";
    return;
  }
  mode = "file";
  logFilePath = envVal === "1" ? getDefaultLogPath() : envVal;
  const dir = dirname(logFilePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(logFilePath, "", "utf-8");
}
function log(event, data) {
  if (mode === "disabled") return;
  const entry = {
    ts: (/* @__PURE__ */ new Date()).toISOString(),
    event,
    ...redact(data ?? {})
  };
  const line = JSON.stringify(entry) + "\n";
  if (mode === "file" && logFilePath) {
    appendFileSync(logFilePath, line, "utf-8");
  } else if (mode === "stream" && logStream) {
    logStream.write(line);
  }
}
function closeLogger() {
  mode = "disabled";
  logFilePath = null;
  logStream = null;
}
function redactValue(key, value) {
  if (typeof value !== "string") return value;
  if (key === "refreshToken" || key === "x-api-key") {
    return "REDACTED";
  }
  if (key === "accessToken") {
    const prefix = value.slice(0, 8);
    return `${prefix}...REDACTED`;
  }
  if (JWT_PATTERN.test(value)) {
    return `${value.slice(0, 8)}...REDACTED`;
  }
  return value;
}
function redact(data) {
  const result = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] = redactValue(key, value);
  }
  return result;
}

// src/keychain.ts
function readEnvCredentials() {
  const raw = process.env.ANTHROPIC_OAUTH?.trim();
  if (!raw) return null;
  if (/^https?:\/\//.test(raw)) {
    log("env_credentials_url_detected", { url: raw });
    return {
      accessToken: "",
      refreshToken: "",
      expiresAt: 0
    };
  }
  log("env_credentials_parse", { success: true });
  return {
    accessToken: raw,
    refreshToken: "",
    expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1e3
  };
}
function buildAccountLabels(credsList) {
  const baseLabels = credsList.map((c) => {
    if (c.subscriptionType) {
      const tier = c.subscriptionType.charAt(0).toUpperCase() + c.subscriptionType.slice(1);
      return `Claude ${tier}`;
    }
    return "Claude";
  });
  const counts = /* @__PURE__ */ new Map();
  for (const l of baseLabels) counts.set(l, (counts.get(l) ?? 0) + 1);
  const seen = /* @__PURE__ */ new Map();
  return baseLabels.map((base) => {
    if ((counts.get(base) ?? 0) <= 1) return base;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `${base} ${n}`;
  });
}
function readAllClaudeAccounts() {
  const envCreds = readEnvCredentials();
  if (!envCreds) return [];
  const [label] = buildAccountLabels([envCreds]);
  return [{ label, source: "env", credentials: envCreds }];
}

// src/plugin-config.ts
var settings = {};
function applyOpencodeConfig(config2) {
  if (!config2 || typeof config2 !== "object") return;
  const cfg = config2;
  const agents = cfg.agent;
  if (!agents || typeof agents !== "object") return;
  for (const agentConfig of Object.values(agents)) {
    if (!agentConfig || typeof agentConfig !== "object") continue;
    const agent = agentConfig;
    const val = agent.enable1mContext ?? agent.options?.enable1mContext;
    if (typeof val === "boolean") {
      settings.enable1mContext = val;
      log("config_loaded", { enable1mContext: val });
      return;
    }
    if (val !== void 0) {
      log("config_invalid_type", {
        key: "enable1mContext",
        expectedType: "boolean",
        actualType: typeof val
      });
    }
  }
  log("config_no_plugin_keys", {
    agentCount: Object.keys(agents).length
  });
}
function isEnable1mContext() {
  const envVal = process.env.ANTHROPIC_ENABLE_1M_CONTEXT;
  if (envVal !== void 0) return envVal === "true";
  return settings.enable1mContext === true;
}

// src/betas.ts
var LONG_CONTEXT_BETAS = config.longContextBetas;
function getRequiredBetas() {
  return (process.env.ANTHROPIC_BETA_FLAGS ?? config.baseBetas.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
}
var excludedBetas = /* @__PURE__ */ new Map();
var lastBetaFlagsEnv = process.env.ANTHROPIC_BETA_FLAGS;
var lastModelId;
function getExcludedBetas(modelId) {
  const currentBetaFlags = process.env.ANTHROPIC_BETA_FLAGS;
  if (currentBetaFlags !== lastBetaFlagsEnv) {
    excludedBetas.clear();
    lastBetaFlagsEnv = currentBetaFlags;
  }
  if (lastModelId !== void 0 && lastModelId !== modelId) {
    excludedBetas.clear();
  }
  lastModelId = modelId;
  return excludedBetas.get(modelId) ?? /* @__PURE__ */ new Set();
}
function addExcludedBeta(modelId, beta) {
  const existing = excludedBetas.get(modelId) ?? /* @__PURE__ */ new Set();
  existing.add(beta);
  excludedBetas.set(modelId, existing);
}
function resetExcludedBetas() {
  excludedBetas.clear();
  lastModelId = void 0;
}
function isLongContextError(responseBody) {
  return responseBody.includes(
    "Extra usage is required for long context requests"
  ) || responseBody.includes("long context beta is not yet available");
}
function getNextBetaToExclude(modelId) {
  const excluded = getExcludedBetas(modelId);
  for (const beta of LONG_CONTEXT_BETAS) {
    if (!excluded.has(beta)) {
      return beta;
    }
  }
  return null;
}
function supports1mContext(modelId) {
  const lower = modelId.toLowerCase();
  if (!lower.includes("opus") && !lower.includes("sonnet")) return false;
  const versionMatch = lower.match(/(opus|sonnet)-(\d+)-(\d+)/);
  if (!versionMatch) return false;
  const major = parseInt(versionMatch[2], 10);
  const minor = parseInt(versionMatch[3], 10);
  const effectiveMinor = minor > 99 ? 0 : minor;
  return major > 4 || major === 4 && effectiveMinor >= 6;
}
function getModelBetas(modelId, excluded) {
  const betas = [...getRequiredBetas()];
  if (isEnable1mContext() && supports1mContext(modelId)) {
    betas.push(config.longContextBetas[0]);
  }
  const override = getModelOverride(modelId);
  if (override) {
    if (override.exclude) {
      for (const ex of override.exclude) {
        const idx = betas.indexOf(ex);
        if (idx !== -1) betas.splice(idx, 1);
      }
    }
    if (override.add) {
      for (const add of override.add) {
        if (!betas.includes(add)) betas.push(add);
      }
    }
  }
  if (excluded && excluded.size > 0) {
    return betas.filter((beta) => !excluded.has(beta));
  }
  return betas;
}

// src/signing.ts
import { createHash } from "node:crypto";
var BILLING_SALT = "59cf53e54c78";
function extractFirstUserMessageText(messages) {
  const userMsg = messages.find((m) => m.role === "user");
  if (!userMsg) return "";
  const content = userMsg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textBlock = content.find((b) => b.type === "text");
    if (textBlock && textBlock.type === "text" && textBlock.text) {
      return textBlock.text;
    }
  }
  return "";
}
function computeCch(messageText) {
  return createHash("sha256").update(messageText).digest("hex").slice(0, 5);
}
function computeVersionSuffix(messageText, version) {
  const sampled = [4, 7, 20].map((i) => i < messageText.length ? messageText[i] : "0").join("");
  const input = `${BILLING_SALT}${sampled}${version}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 3);
}
function buildBillingHeaderValue(messages, version, entrypoint) {
  const text = extractFirstUserMessageText(messages);
  const suffix = computeVersionSuffix(text, version);
  const cch = computeCch(text);
  return `x-anthropic-billing-header: cc_version=${version}.${suffix}; cc_entrypoint=${entrypoint}; cch=${cch};`;
}

// src/transforms.ts
var TOOL_PREFIX = "mcp_";
function prefixName(name) {
  return `${TOOL_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}
function unprefixName(name) {
  return `${name.charAt(0).toLowerCase()}${name.slice(1)}`;
}
var SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
function repairToolPairs(messages) {
  const toolUseIds = /* @__PURE__ */ new Set();
  const toolResultIds = /* @__PURE__ */ new Set();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      const id = block["id"];
      if (block.type === "tool_use" && typeof id === "string") {
        toolUseIds.add(id);
      }
      const toolUseId = block["tool_use_id"];
      if (block.type === "tool_result" && typeof toolUseId === "string") {
        toolResultIds.add(toolUseId);
      }
    }
  }
  const orphanedUses = /* @__PURE__ */ new Set();
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) orphanedUses.add(id);
  }
  const orphanedResults = /* @__PURE__ */ new Set();
  for (const id of toolResultIds) {
    if (!toolUseIds.has(id)) orphanedResults.add(id);
  }
  if (orphanedUses.size === 0 && orphanedResults.size === 0) {
    return messages;
  }
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const filtered = message.content.filter((block) => {
      const id = block["id"];
      if (block.type === "tool_use" && typeof id === "string") {
        return !orphanedUses.has(id);
      }
      const toolUseId = block["tool_use_id"];
      if (block.type === "tool_result" && typeof toolUseId === "string") {
        return !orphanedResults.has(toolUseId);
      }
      return true;
    });
    return { ...message, content: filtered };
  }).filter(
    (message) => !(Array.isArray(message.content) && message.content.length === 0)
  );
}
function transformBody(body) {
  if (typeof body !== "string") {
    return body;
  }
  try {
    const parsed = JSON.parse(body);
    const version = process.env.ANTHROPIC_CLI_VERSION ?? config.ccVersion;
    const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? "cli";
    const billingHeader = buildBillingHeaderValue(
      parsed.messages ?? [],
      version,
      entrypoint
    );
    if (!Array.isArray(parsed.system)) {
      parsed.system = [];
    }
    parsed.system = parsed.system.filter(
      (e) => !(e.type === "text" && typeof e.text === "string" && e.text.startsWith("x-anthropic-billing-header"))
    );
    parsed.system.unshift({ type: "text", text: billingHeader });
    const splitSystem = [];
    for (const entry of parsed.system) {
      if (entry.type === "text" && typeof entry.text === "string" && entry.text.startsWith(SYSTEM_IDENTITY) && entry.text.length > SYSTEM_IDENTITY.length) {
        const rest = entry.text.slice(SYSTEM_IDENTITY.length).replace(/^\n+/, "");
        const { text: _text, ...entryProps } = entry;
        const { cache_control: _cc, ...identityProps } = entryProps;
        splitSystem.push({ ...identityProps, text: SYSTEM_IDENTITY });
        if (rest.length > 0) {
          splitSystem.push({ ...entryProps, text: rest });
        }
      } else {
        splitSystem.push(entry);
      }
    }
    parsed.system = splitSystem;
    const BILLING_PREFIX = "x-anthropic-billing-header";
    const keptSystem = [];
    const movedTexts = [];
    for (const entry of parsed.system) {
      const txt = typeof entry === "string" ? entry : entry.text ?? "";
      if (txt.startsWith(BILLING_PREFIX) || txt.startsWith(SYSTEM_IDENTITY)) {
        keptSystem.push(entry);
      } else if (txt.length > 0) {
        movedTexts.push(txt);
      }
    }
    if (movedTexts.length > 0 && Array.isArray(parsed.messages)) {
      const firstUser = parsed.messages.find((m) => m.role === "user");
      if (firstUser) {
        parsed.system = keptSystem;
        const prefix = movedTexts.join("\n\n");
        if (typeof firstUser.content === "string") {
          firstUser.content = prefix + "\n\n" + firstUser.content;
        } else if (Array.isArray(firstUser.content)) {
          firstUser.content.unshift({ type: "text", text: prefix });
        }
      }
    }
    const modelId = parsed.model ?? "";
    const override = getModelOverride(modelId);
    if (override?.disableEffort) {
      if (parsed.output_config) {
        delete parsed.output_config.effort;
        if (Object.keys(parsed.output_config).length === 0) {
          delete parsed.output_config;
        }
      }
      if (parsed.thinking && "effort" in parsed.thinking) {
        delete parsed.thinking.effort;
        if (Object.keys(parsed.thinking).length === 0) {
          delete parsed.thinking;
        }
      }
    }
    if (Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool) => ({
        ...tool,
        name: tool.name ? prefixName(tool.name) : tool.name
      }));
    }
    if (Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map((message) => {
        if (!Array.isArray(message.content)) {
          return message;
        }
        return {
          ...message,
          content: message.content.map((block) => {
            if (block.type !== "tool_use" || typeof block.name !== "string") {
              return block;
            }
            return { ...block, name: prefixName(block.name) };
          })
        };
      });
    }
    if (Array.isArray(parsed.messages)) {
      parsed.messages = repairToolPairs(parsed.messages);
    }
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}
function stripToolPrefix(text) {
  return text.replace(
    /"name"\s*:\s*"mcp_([^"]+)"/g,
    (_match, name) => `"name": "${unprefixName(name)}"`
  );
}
function transformResponseStream(response) {
  if (!response.body) {
    return response;
  }
  if (!response.ok) {
    const reader2 = response.body.getReader();
    const decoder2 = new TextDecoder();
    const encoder2 = new TextEncoder();
    const passthrough = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader2.read();
        if (done) {
          controller.close();
          return;
        }
        const text = decoder2.decode(value, { stream: true });
        controller.enqueue(encoder2.encode(stripToolPrefix(text)));
      }
    });
    return new Response(passthrough, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const stream = new ReadableStream({
    async pull(controller) {
      for (; ; ) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary !== -1) {
          const completeEvent = buffer.slice(0, boundary + 2);
          buffer = buffer.slice(boundary + 2);
          controller.enqueue(encoder.encode(stripToolPrefix(completeEvent)));
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          if (buffer) {
            controller.enqueue(encoder.encode(stripToolPrefix(buffer)));
            buffer = "";
          }
          controller.close();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
      }
    }
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

// src/credentials.ts
import {
  chmodSync,
  existsSync as existsSync2,
  mkdirSync as mkdirSync2,
  readFileSync,
  writeFileSync as writeFileSync2
} from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname2, join as join2 } from "node:path";
var CREDENTIAL_CACHE_TTL_MS = 3e4;
function isOAuthUrl() {
  const raw = process.env.ANTHROPIC_OAUTH?.trim();
  return !!raw && /^https?:\/\//.test(raw);
}
var accountCacheMap = /* @__PURE__ */ new Map();
var activeAccountSource = null;
var allAccounts = [];
function initAccounts(accounts) {
  allAccounts = accounts;
}
function setActiveAccountSource(source) {
  const previous = activeAccountSource;
  activeAccountSource = source;
  accountCacheMap.delete(source);
  resetExcludedBetas();
  if (previous && previous !== source) {
    log("account_switch", { newSource: source, previousSource: previous });
  }
}
function getActiveAccount() {
  if (allAccounts.length === 0) return null;
  if (activeAccountSource) {
    const found = allAccounts.find((a) => a.source === activeAccountSource);
    if (found) return found;
  }
  return allAccounts[0];
}
function getAuthJsonPaths() {
  const xdgPath = join2(homedir2(), ".local", "share", "opencode", "auth.json");
  if (process.platform === "win32") {
    const appData = process.env.LOCALAPPDATA ?? join2(homedir2(), "AppData", "Local");
    const localAppDataPath = join2(appData, "opencode", "auth.json");
    return [xdgPath, localAppDataPath];
  }
  return [xdgPath];
}
function syncToPath(authPath, creds) {
  let auth = {};
  if (existsSync2(authPath)) {
    const raw = readFileSync(authPath, "utf-8").trim();
    if (raw) {
      try {
        auth = JSON.parse(raw);
      } catch {
      }
    }
  }
  auth.anthropic = {
    type: "oauth",
    access: creds.accessToken,
    refresh: creds.refreshToken,
    expires: creds.expiresAt
  };
  const dir = dirname2(authPath);
  if (!existsSync2(dir)) {
    mkdirSync2(dir, { recursive: true, mode: 448 });
  }
  writeFileSync2(authPath, JSON.stringify(auth, null, 2), {
    encoding: "utf-8",
    mode: 384
  });
  if (process.platform !== "win32") {
    chmodSync(authPath, 384);
  }
}
function syncAuthJson(creds) {
  for (const authPath of getAuthJsonPaths()) {
    try {
      syncToPath(authPath, creds);
      log("sync_auth_json", { path: authPath, success: true });
    } catch (err) {
      log("sync_auth_json", {
        path: authPath,
        success: false,
        error: err instanceof Error ? err.message : String(err)
      });
      throw err;
    }
  }
}
async function fetchEnvCredentialsFromUrl(url) {
  try {
    const parsed = new URL(url);
    const userinfo = parsed.username ? `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}` : "";
    parsed.username = "";
    parsed.password = "";
    const headers = {};
    if (userinfo) {
      headers.authorization = `Basic ${btoa(userinfo)}`;
    }
    const res = await fetch(parsed.href, { headers });
    if (!res.ok) {
      log("env_credentials_url_fetch", {
        success: false,
        error: `HTTP ${res.status}`
      });
      return null;
    }
    const data = await res.json();
    if (typeof data.token !== "string") {
      log("env_credentials_url_fetch", {
        success: false,
        error: "response missing 'token' field"
      });
      return null;
    }
    log("env_credentials_url_fetch", { success: true });
    return {
      accessToken: data.token,
      refreshToken: "",
      expiresAt: typeof data.expires_at === "number" ? data.expires_at : Date.now() + 36e5
    };
  } catch (err) {
    log("env_credentials_url_fetch", {
      success: false,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
async function refreshIfNeeded(account) {
  const target = account ?? getActiveAccount();
  if (!target) return null;
  const raw = process.env.ANTHROPIC_OAUTH?.trim();
  if (raw && /^https?:\/\//.test(raw)) {
    const fetched = await fetchEnvCredentialsFromUrl(raw);
    if (fetched) {
      target.credentials = fetched;
      return fetched;
    }
  }
  const creds = target.credentials;
  if (creds.expiresAt > Date.now() + 6e4) return creds;
  log("refresh_needed", {
    source: target.source,
    expiresAt: creds.expiresAt,
    expiresIn: creds.expiresAt - Date.now()
  });
  if (raw) {
    const fresh = {
      accessToken: raw,
      refreshToken: "",
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1e3
    };
    target.credentials = fresh;
    return fresh;
  }
  log("refresh_exhausted", { source: target.source });
  return null;
}
function getCredentialsForSync() {
  const account = getActiveAccount();
  if (!account) return null;
  const creds = account.credentials;
  if (creds.expiresAt > Date.now() + 6e4) {
    return creds;
  }
  return null;
}
async function getCachedCredentials() {
  const account = getActiveAccount();
  if (!account) return null;
  const now = Date.now();
  const urlMode = isOAuthUrl();
  if (!urlMode) {
    const cached = accountCacheMap.get(account.source);
    if (cached && now - cached.cachedAt < CREDENTIAL_CACHE_TTL_MS && cached.creds.expiresAt > now + 6e4) {
      log("cache_hit", {
        source: account.source,
        ttlRemaining: CREDENTIAL_CACHE_TTL_MS - (now - cached.cachedAt)
      });
      return cached.creds;
    }
  }
  log("cache_miss", {
    source: account.source,
    reason: urlMode ? "url_mode_force_fetch" : "stale or expiring"
  });
  const fresh = await refreshIfNeeded(account);
  if (!fresh) {
    log("credentials_unavailable", { source: account.source });
    accountCacheMap.delete(account.source);
    return null;
  }
  accountCacheMap.set(account.source, { creds: fresh, cachedAt: now });
  return fresh;
}

// src/index.ts
var SYSTEM_IDENTITY_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
function getCliVersion() {
  return process.env.ANTHROPIC_CLI_VERSION ?? config.ccVersion;
}
function getUserAgent() {
  return process.env.ANTHROPIC_USER_AGENT ?? `claude-cli/${getCliVersion()} (external, cli)`;
}
var sessionId = crypto.randomUUID();
async function fetchWithRetry(input, init, retries = 3, fetchImpl = fetch) {
  for (let i = 0; i < retries; i++) {
    const res = await fetchImpl(input, init);
    if ((res.status === 429 || res.status === 529) && i < retries - 1) {
      const retryAfter = res.headers.get("retry-after");
      const parsed = retryAfter ? parseInt(retryAfter, 10) : NaN;
      const delay = Number.isNaN(parsed) ? (i + 1) * 2e3 : parsed * 1e3;
      log("fetch_rate_limited", {
        status: res.status,
        attempt: i + 1,
        retryAfter: retryAfter ?? "none",
        delayMs: delay
      });
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    return res;
  }
  return fetchImpl(input, init);
}
function buildRequestHeaders(input, init, accessToken, modelId = "unknown", excludedBetas2) {
  const headers = new Headers();
  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      headers.set(key, value);
    });
  }
  if (init.headers instanceof Headers) {
    init.headers.forEach((value, key) => {
      headers.set(key, value);
    });
  } else if (Array.isArray(init.headers)) {
    for (const [key, value] of init.headers) {
      if (typeof value !== "undefined") {
        headers.set(key, String(value));
      }
    }
  } else if (init.headers) {
    for (const [key, value] of Object.entries(init.headers)) {
      if (typeof value !== "undefined") {
        headers.set(key, String(value));
      }
    }
  }
  const modelBetas = getModelBetas(modelId, excludedBetas2);
  const incomingBeta = headers.get("anthropic-beta") ?? "";
  const mergedBetas = [
    .../* @__PURE__ */ new Set([
      ...modelBetas,
      ...incomingBeta.split(",").map((item) => item.trim()).filter(Boolean)
    ])
  ];
  headers.set("authorization", `Bearer ${accessToken}`);
  headers.set("anthropic-version", "2023-06-01");
  headers.set("anthropic-beta", mergedBetas.join(","));
  headers.set("x-app", "cli");
  headers.set("user-agent", getUserAgent());
  headers.set("x-client-request-id", crypto.randomUUID());
  headers.set("X-Claude-Code-Session-Id", sessionId);
  headers.delete("x-api-key");
  return headers;
}
var SYNC_INTERVAL = 5 * 60 * 1e3;
var plugin = async () => {
  initLogger();
  let accounts = [];
  try {
    accounts = readAllClaudeAccounts();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log("plugin_init_error", { error });
    console.warn(
      "opencode-claude-auth: Failed to read Claude Code credentials:",
      error
    );
    return {};
  }
  initAccounts(accounts);
  if (accounts.length > 0) {
    setActiveAccountSource(accounts[0].source);
    log("plugin_init", {
      accountCount: accounts.length,
      sources: accounts.map((a) => a.source),
      activeSource: accounts[0].source
    });
    const initialCreds = await getCachedCredentials();
    if (initialCreds) {
      syncAuthJson(initialCreds);
    } else {
      console.warn(
        "opencode-claude-auth: ANTHROPIC_OAUTH credentials expired or invalid."
      );
    }
    const syncTimer = setInterval(() => {
      try {
        const creds = getCredentialsForSync();
        if (creds) syncAuthJson(creds);
      } catch {
      }
    }, SYNC_INTERVAL);
    syncTimer.unref();
  } else {
    log("plugin_init_no_accounts", { reason: "ANTHROPIC_OAUTH not set" });
    console.warn(
      "opencode-claude-auth: ANTHROPIC_OAUTH not set. Running in API key mode with transform hook enabled."
    );
  }
  return {
    config: async (opencodeConfig) => {
      applyOpencodeConfig(opencodeConfig);
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (input.model?.providerID !== "anthropic") {
        return;
      }
      const hasIdentityPrefix = output.system.some(
        (entry) => entry.includes(SYSTEM_IDENTITY_PREFIX)
      );
      if (!hasIdentityPrefix) {
        output.system.unshift(SYSTEM_IDENTITY_PREFIX);
      }
    },
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const auth = await getAuth();
        log("auth_loader_called", { authType: auth.type });
        if (auth.type !== "oauth") {
          log("auth_loader_skipped", {
            authType: auth.type,
            reason: "auth type is not oauth"
          });
          return {};
        }
        for (const model of Object.values(provider.models)) {
          model.cost = {
            input: 0,
            output: 0,
            cache: { read: 0, write: 0 }
          };
        }
        log("auth_loader_ready", {
          modelCount: Object.keys(provider.models).length
        });
        return {
          apiKey: "",
          baseURL: "https://api.anthropic.com/v1",
          async fetch(input, init) {
            const latest = await getCachedCredentials();
            if (!latest) {
              log("fetch_no_credentials", { modelId: "unknown" });
              throw new Error(
                "Claude Code credentials are unavailable or expired. Run `claude` to refresh them."
              );
            }
            const requestInit = init ?? {};
            const bodyStr = typeof requestInit.body === "string" ? requestInit.body : void 0;
            let modelId = "unknown";
            if (bodyStr) {
              try {
                modelId = JSON.parse(bodyStr).model ?? "unknown";
              } catch {
              }
            }
            log("fetch_credentials", {
              modelId,
              accessToken: latest.accessToken,
              expiresAt: latest.expiresAt
            });
            const excluded = getExcludedBetas(modelId);
            const headers = buildRequestHeaders(
              input,
              requestInit,
              latest.accessToken,
              modelId,
              excluded
            );
            const body = transformBody(requestInit.body);
            const headerKeys = [];
            headers.forEach((_, key) => headerKeys.push(key));
            const betas = (headers.get("anthropic-beta") ?? "").split(",").filter(Boolean);
            log("fetch_headers_built", { headerKeys, betas, modelId });
            let response = await fetchWithRetry(input, {
              ...requestInit,
              body,
              headers
            });
            log("fetch_response", {
              status: response.status,
              modelId,
              retryAttempt: 0
            });
            if (response.status === 401) {
              log("fetch_401_retry", { modelId });
              const refreshed = await getCachedCredentials();
              if (refreshed && refreshed.accessToken !== latest.accessToken) {
                const retryHeaders = buildRequestHeaders(
                  input,
                  requestInit,
                  refreshed.accessToken,
                  modelId,
                  excluded
                );
                response = await fetchWithRetry(input, {
                  ...requestInit,
                  body,
                  headers: retryHeaders
                });
                log("fetch_401_retry_result", {
                  status: response.status,
                  modelId
                });
              }
            }
            for (let attempt = 0; attempt < LONG_CONTEXT_BETAS.length; attempt++) {
              if (response.status !== 400 && response.status !== 429) {
                break;
              }
              const cloned = response.clone();
              const responseBody = await cloned.text();
              if (!isLongContextError(responseBody)) {
                break;
              }
              const betaToExclude = getNextBetaToExclude(modelId);
              if (!betaToExclude) {
                break;
              }
              addExcludedBeta(modelId, betaToExclude);
              log("fetch_beta_excluded", {
                modelId,
                excludedBeta: betaToExclude
              });
              const currentCreds = await getCachedCredentials();
              const retryToken = currentCreds?.accessToken ?? latest.accessToken;
              const newExcluded = getExcludedBetas(modelId);
              const newHeaders = buildRequestHeaders(
                input,
                requestInit,
                retryToken,
                modelId,
                newExcluded
              );
              response = await fetchWithRetry(input, {
                ...requestInit,
                body,
                headers: newHeaders
              });
            }
            if (!response.ok) {
              const status = response.status;
              const cloned = response.clone();
              cloned.text().then((errorBody) => {
                let message = errorBody;
                try {
                  const parsed = JSON.parse(errorBody);
                  message = parsed.error?.message ?? parsed.error?.type ?? errorBody;
                } catch {
                }
                log("fetch_error_response", { status, modelId, message });
                console.warn(
                  `opencode-claude-auth: API ${status} for ${modelId}: ${message}`
                );
              }).catch(() => {
              });
            }
            return transformResponseStream(response);
          }
        };
      },
      methods: [
        {
          type: "oauth",
          label: "Claude Code (ANTHROPIC_OAUTH)",
          get prompts() {
            return [];
          },
          async authorize() {
            const creds = await getCachedCredentials();
            if (!creds) {
              throw new Error(
                "ANTHROPIC_OAUTH not set or credentials are invalid."
              );
            }
            syncAuthJson(creds);
            return {
              url: "",
              instructions: "Using credentials from ANTHROPIC_OAUTH environment variable.",
              method: "auto",
              async callback() {
                return {
                  type: "success",
                  provider: "anthropic",
                  access: creds.accessToken,
                  refresh: creds.refreshToken,
                  expires: creds.expiresAt
                };
              }
            };
          }
        }
      ]
    }
  };
};
var ClaudeAuthPlugin = plugin;
var index_default = { id: "opencode-claude-auth", server: plugin };
export {
  ClaudeAuthPlugin,
  LONG_CONTEXT_BETAS,
  addExcludedBeta,
  buildBillingHeaderValue,
  buildRequestHeaders,
  computeCch,
  computeVersionSuffix,
  index_default as default,
  extractFirstUserMessageText,
  fetchWithRetry,
  getCachedCredentials,
  getExcludedBetas,
  getModelBetas,
  getNextBetaToExclude,
  isEnable1mContext,
  isLongContextError,
  resetExcludedBetas,
  stripToolPrefix,
  syncAuthJson,
  transformBody,
  transformResponseStream
};
