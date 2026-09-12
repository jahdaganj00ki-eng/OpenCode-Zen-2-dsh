/**
 * dsh-opencode-zen-free — DSH Desktop Plugin für komplett kostenlose OpenCode Zen Free-Modelle
 *
 * Vereint die besten Ideen aus 7 untersuchten Plugins:
 *  - zou/dsh-llm-opencode-zen : zero-config Bearer public + dynamic catalog + cooldown + watchdog
 *  - FishBottle7/opencode2dsh  : disguise headers (x-opencode-*) + pi-ai catalog S1/S2/S3 + idle watchdogs
 *  - 2247069117/dsh-llm-opencode-zen : probe-based discovery + reasoning_effort mapping
 *  - DHS-M/dsh-opencode-zen    : shim loopback Idee (hier direkt, kein Shim)
 *  - llt22/dsh-opencode-zen-compat : tolerateMissingFinishReason compat fix
 *  - ZeroHomer/dsh-opencode-zen-bypass : fetch UA rewrite (hier per-request header, kein global patch)
 *  - tovuse/Use-Opencode...   : route-level userAgent field (hier direkt header)
 *
 * Unterstützt ALLE 3 OpenCode Zen Wire-Varianten:
 *  - /v1/chat/completions  (openai-compatible)  -> big-pickle, mimo-*, ling-*, nemotron-*, deepseek-*, glm-*, minimax-*, kimi-*, ...
 *  - /v1/responses         (openai)             -> gpt-5.*, gpt-6-astra, grok-*, muse-spark-1.3-contributor-free (aktuell), muse-spark-1.2
 *  - /v1/messages          (anthropic)          -> claude-*, qwen3.*-plus  (falls zukünftig als -free erscheinen)
 *  - /v1/models/gemini-*   (google)             -> gemini-* (falls -free Variante erscheint)
 *
 * Multi-Account: apiKeyEnvs: string[]  (z.B. ["OPENCODE_API_KEY","OPENCODE_ZEN_API_KEY_2", ...])
 *   Round-Robin mit Cooldown nach 429/AUTH. Fallback auf Bearer public wenn alle im Cooldown.
 *
 * Lizenz: MIT
 */

import z from '@deepseek-ai/schemastery';
import {
  CallId,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  RetryPolicySchema,
  assertUsableApiKey,
  attributionHeaders,
  contentHasImage,
  isContextWindowExceededError,
  isQuotaExceededError,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout';
import { createHash, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Konstanten & User-Agent
// ---------------------------------------------------------------------------

const ZEN_VERSION = '1.18.21';
const ZEN_USER_AGENT = `opencode/${ZEN_VERSION} (${process.platform} ${process.arch}; node${process.versions.node})`;
const PUBLIC_KEY = 'public';
const NS = settingsNamespace('opencode-zen-free');
const PROVIDER = 'opencode-zen-free';
const DEFAULT_BASE_URL = 'https://opencode.ai/zen/v1';
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;
const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT';
const FREE_MODEL_SUFFIX = '-free';
const DEFAULT_CATALOG_TTL_MS = 600_000;
const DEFAULT_UNAVAILABLE_COOLDOWN_MS = 1_800_000;
const DEFAULT_ACCOUNT_COOLDOWN_MS = 60_000;

const name = 'opencode-zen-free';
const inject = ['llm'];

// ---------------------------------------------------------------------------
// Endpunkt-Erkennung (aus https://opencode.ai/docs/zen/#endpoints Tabelle)
// ---------------------------------------------------------------------------

function endpointOf(modelId) {
  const id = String(modelId).toLowerCase();
  // responses: gpt-*, grok-*, muse-spark-*
  if (id.startsWith('gpt-') || id.startsWith('grok-') || id.startsWith('muse-spark-')) return 'responses';
  // anthropic messages: claude-*, qwen3*
  if (id.startsWith('claude-') || id.startsWith('qwen')) return 'messages';
  // gemini native: gemini-*
  if (id.startsWith('gemini-')) return 'gemini';
  // alles andere: chat/completions
  return 'chat';
}

// ---------------------------------------------------------------------------
// Statisch verifizierte Free-Modelle
//  - Live am 2026-09-12 via /v1/models (HEUTE): 8 IDs
//  - models.dev free = 31 IDs (inkl. Live) — vollständige Coverage für Auto-Discovery
// ---------------------------------------------------------------------------

const STATIC_FREE = [
  // Live verifiziert (HEUTE /v1/models ∩ models.dev cost=0)
  { id: 'big-pickle', name: 'Big Pickle', contextWindow: 200000, maxTokens: 32000, reasoning: ['off', 'high'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free', contextWindow: 200000, maxTokens: 128000, reasoning: ['high', 'max'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'muse-spark-1.3-contributor-free', name: 'Muse Spark 1.3 Contributor Free', contextWindow: 256000, maxTokens: 64000, reasoning: ['off', 'high'], defaultEffort: 'high', endpoint: 'responses' },
  { id: 'muse-spark-1.2-contributor-free', name: 'Muse Spark 1.2 Contributor Free', contextWindow: 256000, maxTokens: 64000, reasoning: ['off', 'high'], defaultEffort: 'high', endpoint: 'responses' },
  { id: 'mimo-v2.5-free', name: 'MiMo V2.5 Free', contextWindow: 200000, maxTokens: 32000, reasoning: ['off', 'high'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'ling-3.0-flash-fin-free', name: 'Ling 3.0 Flash Fin Free', contextWindow: 200000, maxTokens: 32000, reasoning: ['off', 'high'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free', contextWindow: 1000000, maxTokens: 128000, reasoning: ['off', 'high'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning Free', contextWindow: 200000, maxTokens: 32000, reasoning: ['off', 'high'], defaultEffort: 'high', endpoint: 'chat' },
  // models.dev zusätzliche Free-Modelle (nicht heute live, aber jederzeit reaktivierbar)
  { id: 'glm-4.7-free', name: 'GLM 4.7 Free', contextWindow: 200000, maxTokens: 64000, reasoning: ['high', 'max'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'glm-5-free', name: 'GLM 5 Free', contextWindow: 200000, maxTokens: 64000, reasoning: ['high', 'max'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'grok-code', name: 'Grok Code', contextWindow: 256000, maxTokens: 128000, reasoning: ['high', 'max'], defaultEffort: 'high', endpoint: 'responses' },
  { id: 'hy3-free', name: 'Hy3 Free', contextWindow: 256000, maxTokens: 64000, reasoning: ['high', 'max'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'hy3-preview-free', name: 'Hy3 Preview Free', contextWindow: 256000, maxTokens: 64000, reasoning: ['high', 'max'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'kimi-k2.5-free', name: 'Kimi K2.5 Free', contextWindow: 262144, maxTokens: 64000, reasoning: ['high', 'max'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'laguna-s-2.1-free', name: 'Laguna S 2.1 Free', contextWindow: 256000, maxTokens: 32000, reasoning: ['high', 'max'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'ling-2.6-flash-free', name: 'Ling 2.6 Flash Free', contextWindow: 200000, maxTokens: 32000, reasoning: ['high', 'max'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'ling-3.0-flash-free', name: 'Ling 3.0 Flash Free', contextWindow: 200000, maxTokens: 32000, reasoning: ['high', 'max'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'ling-3.0-tiny-free', name: 'Ling 3.0 Tiny Free', contextWindow: 200000, maxTokens: 16000, reasoning: ['high', 'max'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'longcat-2.0-free', name: 'LongCat 2.0 Free', contextWindow: 200000, maxTokens: 32000, reasoning: ['high', 'max'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'mimo-v2-flash-free', name: 'MiMo V2 Flash Free', contextWindow: 200000, maxTokens: 32000, reasoning: ['high', 'max'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'mimo-v2-omni-free', name: 'MiMo V2 Omni Free', contextWindow: 200000, maxTokens: 32000, reasoning: ['high', 'max'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'mimo-v2-pro-free', name: 'MiMo V2 Pro Free', contextWindow: 200000, maxTokens: 64000, reasoning: ['high', 'max'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'minimax-m2.1-free', name: 'MiniMax M2.1 Free', contextWindow: 204800, maxTokens: 131072, reasoning: ['high', 'max'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'minimax-m2.5-free', name: 'MiniMax M2.5 Free', contextWindow: 204800, maxTokens: 131072, reasoning: ['high', 'max'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'minimax-m3-free', name: 'MiniMax M3 Free', contextWindow: 512000, maxTokens: 128000, reasoning: ['high', 'max'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'nemotron-3-super-free', name: 'Nemotron 3 Super Free', contextWindow: 256000, maxTokens: 64000, reasoning: ['high', 'max'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'north-mini-code-free', name: 'North Mini Code Free', contextWindow: 256000, maxTokens: 64000, reasoning: ['high', 'max'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'qwen3.6-plus-free', name: 'Qwen3.6 Plus Free', contextWindow: 262144, maxTokens: 64000, reasoning: ['high', 'max'], defaultEffort: 'high', endpoint: 'messages' },
  { id: 'ring-2.6-1t-free', name: 'Ring 2.6 1T Free', contextWindow: 1000000, maxTokens: 128000, reasoning: ['high', 'max'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'trinity-large-preview-free', name: 'Trinity Large Preview Free', contextWindow: 200000, maxTokens: 64000, reasoning: ['high', 'max'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'x-preview-f-free', name: 'X Preview F Free', contextWindow: 200000, maxTokens: 32000, reasoning: ['high', 'max'], defaultEffort: 'high', endpoint: 'chat' },
];

const FREE_MODELS = STATIC_FREE;

// ---------------------------------------------------------------------------
// Disguise Headers (FishBottle ids.ts Port)
// ---------------------------------------------------------------------------

function stableID(prefix, value) {
  const sum = createHash('sha256').update(prefix + '\x00' + value).digest();
  return `${prefix}_${sum.subarray(0, 12).toString('hex')}`;
}
function randomID(prefix, size) {
  return `${prefix}_${randomBytes(size).toString('hex')}`;
}
function conversationSeed(messages) {
  for (const m of messages ?? []) {
    if (m?.role !== 'user') continue;
    const enc = JSON.stringify(m.content ?? null);
    if (enc && enc !== 'null' && enc.length > 0) return enc;
  }
  return '';
}
function deriveRequestIDs(messages) {
  let signal = conversationSeed(messages);
  if (!signal || signal === '{}') signal = randomID('fallback', 16);
  return {
    session: stableID('ses', signal),
    request: randomID('req', 16),
    project: stableID('prj', 'opencode-zen-free:default-project'),
    parentSession: '',
  };
}
function disguiseHeaders(ids) {
  return {
    'user-agent': ZEN_USER_AGENT,
    'x-opencode-client': 'cli',
    'x-opencode-session': ids.session,
    'x-session-affinity': ids.session,
    'X-Session-Id': ids.session,
    'x-opencode-request': ids.request,
    'x-opencode-project': ids.project,
  };
}

// ---------------------------------------------------------------------------
// Schema & Config
// ---------------------------------------------------------------------------

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  reasoning: z.array(z.string()),
  defaultEffort: z.string(),
  endpoint: z.string(), // chat | responses | messages | gemini
});

const Config = z.object({
  // Multi-Account: Liste von credential-refs (env-Namen). Leer = nur Bearer public
  apiKeyEnvs: z.array(z.string().role('credential-ref')).default(['OPENCODE_API_KEY', 'OPENCODE_ZEN_API_KEY']),
  // Legacy Einzel-Feld (migriert automatisch nach apiKeyEnvs[0])
  apiKeyEnv: z.string().role('credential-ref'),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(FREE_MODELS),
  dynamicCatalog: z.boolean().default(true),
  catalogTtlMs: z.number().step(1).min(1000).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_CATALOG_TTL_MS),
  unavailableCooldownMs: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_UNAVAILABLE_COOLDOWN_MS),
  accountCooldownMs: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_ACCOUNT_COOLDOWN_MS),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
});

function normalizeApiKeyEnvs(raw) {
  const list = [];
  if (Array.isArray(raw?.apiKeyEnvs)) for (const v of raw.apiKeyEnvs) if (typeof v === 'string' && v.trim()) list.push(v.trim());
  if (typeof raw?.apiKeyEnv === 'string' && raw.apiKeyEnv.trim() && !list.includes(raw.apiKeyEnv.trim())) list.push(raw.apiKeyEnv.trim());
  // Dedupe
  return [...new Set(list)];
}

function resolveAdapterOptions(config, env) {
  const base = config ?? {};
  const apiKeyEnvs = normalizeApiKeyEnvs(base);
  const models = (base.models ?? FREE_MODELS).map((m) => ({
    ...m,
    endpoint: m.endpoint ?? endpointOf(m.id),
    reasoning: m.reasoning ?? ['high', 'max'],
  }));
  return {
    apiKeyEnvs,
    baseURL: String(base.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    maxTokens: base.maxTokens ?? DEFAULT_MAX_TOKENS,
    defaultContextWindow: base.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW,
    models,
    dynamicCatalog: base.dynamicCatalog ?? true,
    catalogTtlMs: base.catalogTtlMs ?? DEFAULT_CATALOG_TTL_MS,
    unavailableCooldownMs: base.unavailableCooldownMs ?? DEFAULT_UNAVAILABLE_COOLDOWN_MS,
    accountCooldownMs: base.accountCooldownMs ?? DEFAULT_ACCOUNT_COOLDOWN_MS,
    streamIdleTimeoutMs: base.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(base.retryPolicy),
  };
}

function normalizeModels(models) {
  return (models ?? FREE_MODELS).map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    description: m.description,
    contextWindow: m.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: m.maxTokens ?? DEFAULT_MAX_TOKENS,
    reasoning: m.reasoning ?? ['high', 'max'],
    defaultEffort: m.defaultEffort ?? 'high',
    endpoint: m.endpoint ?? endpointOf(m.id),
  }));
}
function synthesizeEntry(id) {
  return {
    id,
    name: id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    reasoning: ['high', 'max'],
    defaultEffort: 'high',
    endpoint: endpointOf(id),
  };
}

// ---------------------------------------------------------------------------
// Multi-Account Pool
// ---------------------------------------------------------------------------

class AccountPool {
  constructor(options) {
    this.cooldown = new Map(); // env -> untilMs
    this.roundRobin = 0;
    this.accountCooldownMs = options.accountCooldownMs ?? DEFAULT_ACCOUNT_COOLDOWN_MS;
  }
  markFailed(env, ms) {
    if (!env || env === PUBLIC_KEY) return;
    this.cooldown.set(env, Date.now() + (ms ?? this.accountCooldownMs));
  }
  isCooling(env) {
    const until = this.cooldown.get(env);
    return until !== undefined && until > Date.now();
  }
  // Gibt sortierte Liste zurück: erst verfügbare Keys, dann gekühlte, dann public
  pickOrder(apiKeyEnvs) {
    const now = Date.now();
    const available = [];
    const cooling = [];
    for (const env of apiKeyEnvs) {
      const until = this.cooldown.get(env);
      if (until !== undefined && until > now) cooling.push(env);
      else available.push(env);
    }
    // Round-Robin innerhalb available
    if (available.length > 1) {
      const shift = this.roundRobin % available.length;
      this.roundRobin = (this.roundRobin + 1) % 100000;
      return [...available.slice(shift), ...available.slice(0, shift), ...cooling, PUBLIC_KEY].filter((v, i, a) => a.indexOf(v) === i);
    }
    return [...available, ...cooling, PUBLIC_KEY].filter((v, i, a) => a.indexOf(v) === i);
  }
}

// ---------------------------------------------------------------------------
// Remote Catalog (zou-Port, erweitert um endpoint & models.dev-Synthese)
// ---------------------------------------------------------------------------

class RemoteCatalog {
  constructor(runtime) {
    this.runtime = runtime;
    this.cache = null; // { ids: string[], at: number }
    this.inflight = null;
    this.cooldown = new Map(); // id -> until
  }
  async listRemoteIds(connection) {
    const now = Date.now();
    if (this.cache && now - this.cache.at < connection.catalogTtlMs) return this.cache.ids;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const apiKey = await this.runtime.getApiKey(connection, { preferPublic: true });
        const res = await fetch(connection.baseURL + '/models', {
          headers: {
            ...attributionHeaders(),
            'authorization': 'Bearer ' + apiKey,
            'accept': 'application/json',
            'user-agent': ZEN_USER_AGENT,
          },
        });
        if (!res.ok) throw new LlmError(`catalog fetch failed HTTP ${res.status}`, 'SERVER');
        const body = await res.json();
        const ids = Array.isArray(body?.data)
          ? body.data.map((e) => e?.id).filter((id) => typeof id === 'string')
          : [];
        this.cache = { ids, at: Date.now() };
        return ids;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
  async entries(connection) {
    const statics = normalizeModels(connection.models);
    let remoteIds = null;
    if (connection.dynamicCatalog) {
      try { remoteIds = await this.listRemoteIds(connection); } catch (e) {
        this.runtime.logger?.warn?.('opencode-zen-free: dynamic catalog unavailable, fallback static', e);
      }
    }
    const byId = new Map(statics.map((e) => [e.id, e]));
    const ids = remoteIds === null
      ? statics.map((e) => e.id)
      : [...new Set([...statics.map((e) => e.id), ...remoteIds.filter((id) => {
          // Nur free + big-pickle exposen (kostenlos)
          if (id === 'big-pickle') return true;
          if (id.endsWith(FREE_MODEL_SUFFIX)) return true;
          // Falls static bereits diesen non-free kennt (z.B. big-pickle), behalte
          return byId.has(id);
        })])];
    const now = Date.now();
    return ids
      .filter((id) => {
        const until = this.cooldown.get(id);
        return until === undefined || until <= now;
      })
      .map((id) => byId.get(id) ?? synthesizeEntry(id));
  }
  markUnavailable(id, ms) {
    if (!id || ms <= 0) return;
    this.cooldown.set(id, Date.now() + ms);
  }
}

// ---------------------------------------------------------------------------
// Helper: Messages -> OpenAI / Anthropic / Responses Format
// ---------------------------------------------------------------------------

function toOpenAIChatMessages(messages) {
  const out = [];
  for (const m of messages ?? []) {
    if (!m || typeof m.role !== 'string') continue;
    // DSH nutzt { role, content: string | blocks[] }
    let content = m.content;
    if (Array.isArray(content)) {
      // Blocks zu string flatten (Tool-Images etc. ignorieren)
      content = content.map((b) => {
        if (typeof b === 'string') return b;
        if (b?.type === 'text' && typeof b.text === 'string') return b.text;
        if (b?.type === 'image') return ''; // images not supported on free tier
        return typeof b?.text === 'string' ? b.text : '';
      }).filter(Boolean).join('\n');
    }
    if (typeof content !== 'string') content = String(content ?? '');
    out.push({ role: m.role, content });
  }
  return out;
}

function toAnthropicMessages(messages) {
  // Anthropic: system separat, messages ohne system, content als blocks
  let system;
  const msgs = [];
  for (const m of messages ?? []) {
    if (m.role === 'system') {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      system = system ? system + '\n' + c : c;
      continue;
    }
    const c = typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.map((b) => typeof b === 'string' ? b : (b?.text ?? '')).join('\n')
      : String(m.content ?? '');
    msgs.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: c });
  }
  return { system, messages: msgs };
}

function toResponsesInput(messages) {
  // OpenAI Responses: input = array of {role, content: [{type: input_text, text}]}
  const input = [];
  for (const m of messages ?? []) {
    if (!m?.role) continue;
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) text = m.content.map((b) => typeof b === 'string' ? b : (b?.text ?? '')).join('\n');
    else text = String(m.content ?? '');
    if (!text.trim()) continue;
    input.push({ role: m.role, content: [{ type: 'input_text', text }] });
  }
  return input;
}

function serializeChatRequest(options, model) {
  const messages = toOpenAIChatMessages(options.messages);
  const body = {
    model: model.id,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  // reasoning_effort / thinking mapping (224706-Plugin)
  const effort = options.reasoningEffort ?? model.defaultEffort;
  if (effort && effort !== 'off') {
    // DeepSeek-style: reasoning_effort; einige Modelle erwarten 'thinking'
    body.reasoning_effort = effort;
    // Für Kompatibilität zusätzlich 'thinking' falls Provider es liest
    if (effort === 'high' || effort === 'max') body.reasoning_effort = effort;
  }
  // Tools
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters ?? { type: 'object', properties: {} } },
    }));
    body.tool_choice = 'auto';
  }
  return body;
}

function serializeResponsesRequest(options, model) {
  const input = toResponsesInput(options.messages);
  const body = {
    model: model.id,
    input,
    stream: true,
  };
  if (options.maxTokens !== undefined) body.max_output_tokens = Math.max(16, options.maxTokens);
  else body.max_output_tokens = 4096;
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
    body.tool_choice = 'auto';
  }
  const effort = options.reasoningEffort ?? model.defaultEffort;
  if (effort && effort !== 'off') body.reasoning = { effort: effort === 'max' ? 'high' : effort };
  return body;
}

function serializeAnthropicRequest(options, model) {
  const { system, messages } = toAnthropicMessages(options.messages);
  const body = {
    model: model.id,
    messages,
    stream: true,
    max_tokens: options.maxTokens ?? 4096,
  };
  if (system) body.system = system;
  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters ?? { type: 'object' } }));
  }
  return body;
}

// ---------------------------------------------------------------------------
// SSE Parser (robust, toleriert fehlendes finish_reason / [DONE])
// ---------------------------------------------------------------------------

async function* parseSse(body, onComment) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let pendingEvent = null; // for responses: event: xxx
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        if (line === '') {
          if (pendingEvent !== null) {
            // Responses dual-line: event + data
            // Wir geben als {event, data} Objekt weiter, aber für chat ist pendingEvent === null
          }
          pendingEvent = null;
          continue;
        }
        if (line.startsWith(':')) { // keep-alive / comment
          onComment?.();
          continue;
        }
        if (line.startsWith('event:')) {
          pendingEvent = line.slice(6).trim();
          continue;
        }
        if (line.startsWith('data:')) {
          const data = line.slice(5).trimStart();
          if (pendingEvent) {
            yield JSON.stringify({ _event: pendingEvent, _data: data });
            pendingEvent = null;
          } else {
            yield data;
          }
        }
      }
    }
    if (buffer.trim()) {
      const line = buffer.trim();
      if (line.startsWith('data:')) yield line.slice(5).trimStart();
      else if (line) yield line;
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  // llt22 compat: wenn Stream ohne [DONE]/finish_reason endet, nicht sofort errorn — translate entscheidet
}

// ---------------------------------------------------------------------------
// Translate: Chat, Responses, Anthropic -> Harness StreamChunk
// ---------------------------------------------------------------------------

function mapFinishReason(reason) {
  switch (reason) {
    case 'stop': return { kind: 'stop' };
    case 'tool_calls': return { kind: 'tool-calls' };
    case 'length': return { kind: 'max-tokens' };
    case 'content_filter': return { kind: 'error', failure: { message: 'content filtered', code: 'CONTENT_FILTER' } };
    case null:
    case undefined: return { kind: 'stop' };
    default: return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: String(reason).toUpperCase() } };
  }
}
function mapUsage(usage) {
  if (!usage) return undefined;
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: (usage.prompt_tokens ?? usage.input_tokens ?? 0) - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
    ...(cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
}

async function* translateChat(payloads) {
  let nextIndex = 0;
  let textBlock;
  let reasoningBlock;
  const toolBlocks = new Map();
  const order = [];
  let pendingFinish;
  let pendingUsage;
  let sawContent = false;

  function open(kind) {
    const b = { index: nextIndex++, kind, text: '' };
    order.push(b);
    return b;
  }
  function closeBlock(block) {
    switch (block.kind) {
      case 'text': return { type: 'text', text: block.text };
      case 'reasoning': return { type: 'reasoning', text: block.text };
      case 'tool-call': return { type: 'tool-call', id: CallId(block.callId ?? ''), name: block.name ?? '', arguments: block.text };
    }
  }

  for await (const payload of payloads) {
    if (payload === '[DONE]') {
      for (const b of order) yield { type: 'block-end', index: b.index, block: closeBlock(b) };
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage };
      const reason = pendingFinish ?? { kind: 'stop' };
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0 && !sawContent
          ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } }
          : reason,
      };
      return;
    }
    // cost envelope: {"choices":[],"cost":"0"}  -> treat as [DONE]
    if (payload.includes('"cost"') && payload.includes('"choices":[]')) {
      for (const b of order) {
        // avoid double end if already ended via [DONE]
      }
      // If we already emitted finish via [DONE], ignore. Otherwise emit.
      // We track via flag; simplest: if payload is cost envelope and no finish yet, emit finish
      if (order.length > 0 || sawContent) {
        // ensure blocks closed
      }
      continue;
    }
    let chunk;
    try { chunk = JSON.parse(payload); } catch {
      // Responses oder Anthropic wurden hier nicht erwartet — delegiert an andere translatoren
      // Falls dennoch JSON mit _event Feld: weiterreichen
      if (payload.includes('_event')) {
        // This payload is from parseSse wrapped path — shouldn't happen in chat translator
      }
      continue;
    }
    // Handle wrapped responses event (should not occur in chat, but safety)
    if (chunk._event) {
      // Responses event forwarded erroneously — skip
      continue;
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      if (!delta) {
        if (typeof choice.finish_reason === 'string' && choice.finish_reason) pendingFinish = mapFinishReason(choice.finish_reason);
        else if (choice.finish_reason === null) pendingFinish = { kind: 'stop' };
        continue;
      }
      // reasoning_content (deepseek style) + reasoning_details
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        sawContent = true;
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning');
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' };
        }
        reasoningBlock.text += reasoning;
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning };
      }
      // reasoning_details text fragments
      if (Array.isArray(delta.reasoning_details)) {
        for (const rd of delta.reasoning_details) {
          const t = rd?.text;
          if (typeof t === 'string' && t.length > 0) {
            sawContent = true;
            if (!reasoningBlock) {
              reasoningBlock = open('reasoning');
              yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' };
            }
            reasoningBlock.text += t;
            yield { type: 'reasoning-delta', index: reasoningBlock.index, text: t };
          }
        }
      }
      const content = delta.content;
      if (typeof content === 'string' && content.length > 0) {
        sawContent = true;
        if (!textBlock) {
          textBlock = open('text');
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' };
        }
        textBlock.text += content;
        yield { type: 'text-delta', index: textBlock.index, text: content };
      }
      for (const call of delta.tool_calls ?? []) {
        sawContent = true;
        let block = toolBlocks.get(call.index);
        if (!block) {
          block = open('tool-call');
          toolBlocks.set(call.index, block);
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
        }
        if (call.id !== undefined) block.callId = call.id;
        if (call.function?.name !== undefined) block.name = call.function.name;
        const frag = call.function?.arguments ?? '';
        block.text += frag;
        yield { type: 'tool-call-delta', index: block.index, id: CallId(block.callId ?? ''), ...(block.name !== undefined ? { name: block.name } : {}), argumentsDelta: frag };
      }
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) pendingFinish = mapFinishReason(choice.finish_reason);
    }
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
  }
  // Stream endete ohne [DONE] — llt22 compat: tolerieren statt error (Zen schließt manchmal ohne)
  // Emerson: Falls content geflossen ist, als stop beenden
  if (sawContent || order.length > 0) {
    for (const b of order) {
      // nur block-end wenn noch nicht geschehen — wir haben keinen Finish-Tracker, also emit
      // Vermeide doppelte: wir haben order bereits, aber block-end fehlte falls kein [DONE]
      // Emit nur wenn block noch offen (text/reasoning/tool)
    }
    // Wir müssen sauber beenden: block-end + usage + finish
    // Da wir nicht tracken ob block-end bereits gesendet wurde (nur bei [DONE]), senden wir es jetzt
    // Prüfe: Wenn wir hier sind, kam kein [DONE], also noch kein block-end gesendet
    for (const b of order) {
      // ensure we close once
      yield { type: 'block-end', index: b.index, block: closeBlock(b) };
    }
    if (pendingUsage) yield { type: 'usage', usage: pendingUsage };
    yield { type: 'finish', reason: pendingFinish ?? { kind: 'stop' } };
    return;
  }
  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED');
}

async function* translateResponses(payloads) {
  // OpenAI Responses streaming: events wie response.output_text.delta, response.completed, etc.
  let nextIndex = 0;
  let textBlock;
  let reasoningBlock;
  let sawContent = false;
  let pendingUsage;
  let finishKind = 'stop';

  function open(kind) {
    const b = { index: nextIndex++, kind, text: '' };
    return b;
  }
  function closeBlock(block) {
    if (block.kind === 'text') return { type: 'text', text: block.text };
    if (block.kind === 'reasoning') return { type: 'reasoning', text: block.text };
    return { type: 'text', text: block.text };
  }

  for await (const payload of payloads) {
    if (payload === '[DONE]') break;
    let wrapper;
    try { wrapper = JSON.parse(payload); } catch { continue; }
    const event = wrapper._event;
    const raw = wrapper._data ? (() => { try { return JSON.parse(wrapper._data); } catch { return {}; } })() : wrapper;
    const type = event ?? raw.type ?? '';

    // Usage liegt in response.* Objekten
    if (raw.response?.usage) pendingUsage = mapUsage(raw.response.usage);
    if (raw.usage) pendingUsage = mapUsage(raw.usage);

    if (type === 'response.output_text.delta' || type === 'response.text.delta') {
      const delta = raw.delta ?? raw.text ?? '';
      if (typeof delta === 'string' && delta.length > 0) {
        sawContent = true;
        if (!textBlock) {
          textBlock = open('text');
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' };
        }
        textBlock.text += delta;
        yield { type: 'text-delta', index: textBlock.index, text: delta };
      }
    } else if (type === 'response.reasoning.delta' || type === 'response.output_item.added') {
      // reasoning
      const delta = raw.delta ?? raw.item?.summary?.[0]?.text ?? '';
      if (typeof delta === 'string' && delta.length > 0) {
        sawContent = true;
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning');
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' };
        }
        reasoningBlock.text += delta;
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: delta };
      }
    } else if (type === 'response.output_text.done' || type === 'response.completed' || type === 'response.incomplete') {
      if (raw.response?.incomplete_details?.reason === 'max_output_tokens') finishKind = 'max-tokens';
      else if (raw.response?.status === 'completed') finishKind = 'stop';
    } else if (type === 'response.error' || type === 'error') {
      throw new LlmError(raw.error?.message ?? 'responses stream error', 'SERVER');
    } else if (raw.object === 'response' && raw.status) {
      if (raw.status === 'incomplete' && raw.incomplete_details?.reason === 'max_output_tokens') finishKind = 'max-tokens';
      if (raw.usage) pendingUsage = mapUsage(raw.usage);
    }
    // Generischer Fallback: falls delta direkt im chunk ohne event liegt
    if (!event && typeof raw.delta === 'string' && raw.delta.length > 0) {
      sawContent = true;
      if (!textBlock) { textBlock = open('text'); yield { type: 'block-start', index: textBlock.index, blockType: 'text' }; }
      textBlock.text += raw.delta;
      yield { type: 'text-delta', index: textBlock.index, text: raw.delta };
    }
  }
  // Falls kein expliziter Teil kam aber completed-Event fehlte, dennoch versuchen
  if (textBlock) yield { type: 'block-end', index: textBlock.index, block: closeBlock(textBlock) };
  if (reasoningBlock) yield { type: 'block-end', index: reasoningBlock.index, block: closeBlock(reasoningBlock) };
  if (pendingUsage) yield { type: 'usage', usage: pendingUsage };
  if (!sawContent) {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE } } };
  } else {
    const kind = finishKind === 'max-tokens' ? 'max-tokens' : 'stop';
    yield { type: 'finish', reason: { kind } };
  }
}

async function* translateAnthropic(payloads) {
  // Anthropic messages streaming: events content_block_delta (text_delta), message_delta, message_stop
  let nextIndex = 0;
  let textBlock;
  let reasoningBlock;
  let sawContent = false;
  let pendingUsage;
  let finishKind = 'stop';

  function open(kind) {
    const b = { index: nextIndex++, kind, text: '' };
    return b;
  }
  function closeBlock(block) {
    if (block.kind === 'text') return { type: 'text', text: block.text };
    return { type: 'reasoning', text: block.text };
  }

  for await (const payload of payloads) {
    if (payload === '[DONE]') break;
    let wrapper;
    try { wrapper = JSON.parse(payload); } catch { continue; }
    const event = wrapper._event;
    const raw = wrapper._data ? (() => { try { return JSON.parse(wrapper._data); } catch { return {}; } })() : wrapper;
    const type = event ?? raw.type ?? '';

    if (type === 'content_block_delta') {
      const delta = raw.delta;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
        sawContent = true;
        if (!textBlock) { textBlock = open('text'); yield { type: 'block-start', index: textBlock.index, blockType: 'text' }; }
        textBlock.text += delta.text;
        yield { type: 'text-delta', index: textBlock.index, text: delta.text };
      } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking.length > 0) {
        sawContent = true;
        if (!reasoningBlock) { reasoningBlock = open('reasoning'); yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }; }
        reasoningBlock.text += delta.thinking;
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: delta.thinking };
      } else if (typeof delta?.text === 'string' && delta.text.length > 0) {
        sawContent = true;
        if (!textBlock) { textBlock = open('text'); yield { type: 'block-start', index: textBlock.index, blockType: 'text' }; }
        textBlock.text += delta.text;
        yield { type: 'text-delta', index: textBlock.index, text: delta.text };
      }
    } else if (type === 'message_delta') {
      if (raw.delta?.stop_reason === 'max_tokens') finishKind = 'max-tokens';
      if (raw.usage) pendingUsage = { inputTokens: raw.usage.input_tokens ?? 0, outputTokens: raw.usage.output_tokens ?? 0 };
    } else if (type === 'message_stop') {
      // final
    } else if (type === 'content_block_start') {
      // ignore
    } else if (raw.delta?.text) {
      // fallback
      const t = raw.delta.text;
      if (typeof t === 'string' && t.length > 0) {
        sawContent = true;
        if (!textBlock) { textBlock = open('text'); yield { type: 'block-start', index: textBlock.index, blockType: 'text' }; }
        textBlock.text += t;
        yield { type: 'text-delta', index: textBlock.index, text: t };
      }
    }
    if (raw.usage) pendingUsage = { inputTokens: raw.usage.input_tokens ?? 0, outputTokens: raw.usage.output_tokens ?? 0 };
  }
  if (textBlock) yield { type: 'block-end', index: textBlock.index, block: closeBlock(textBlock) };
  if (reasoningBlock) yield { type: 'block-end', index: reasoningBlock.index, block: closeBlock(reasoningBlock) };
  if (pendingUsage) yield { type: 'usage', usage: pendingUsage };
  if (!sawContent) {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'model returned no content', code: EMPTY_RESPONSE_CODE } } };
  } else {
    yield { type: 'finish', reason: { kind: finishKind } };
  }
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function providerRetryAfterMs(value) {
  if (!value) return undefined;
  if (/^\d+$/.test(value)) {
    const d = Number(value) * 1000;
    return Number.isFinite(d) && d > 0 ? d : undefined;
  }
  const d = Date.parse(value) - Date.now();
  return Number.isFinite(d) && d > 0 ? d : undefined;
}
function httpErrorCode(status, error) {
  if (status === 401 || status === 403) return 'AUTH';
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ');
  if (isQuotaExceededError(detail)) return 'QUOTA';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return 'CONTEXT_WINDOW_EXCEEDED';
    return 'INVALID_REQUEST';
  }
  if (status === 402) return 'QUOTA';
  if (status >= 500) return 'SERVER';
  return `HTTP_${status}`;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function modelInfo(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...(model.description ? { description: model.description } : {}),
    inputModalities: ['text'],
  };
}

class OpenCodeZenFreeAdapter extends LlmAdapter {
  constructor(config) {
    super();
    this.config = config; // { options, resolveApiKey, catalog, accountPool }
  }
  providerInfo(provider) {
    return { id: provider, name: 'OpenCode Zen (Free)' };
  }
  providerRetryPolicy(_provider) {
    return this.config.options().retryPolicy;
  }
  async listModels(provider) {
    const entries = await this.config.catalog.entries(this.config.options());
    return entries.map((m) => modelInfo(provider, m));
  }
  async resolveModel(provider, model, _signal) {
    const connection = this.config.options();
    const entries = await this.config.catalog.entries(connection);
    const found = entries.find((e) => e.id === model);
    const ctxWindow = found?.contextWindow ?? connection.defaultContextWindow;
    const base = {
      ...(found ? modelInfo(provider, found) : { provider, id: model, name: model, inputModalities: ['text'] }),
      context: { contextWindow: ctxWindow },
      defaultMaxTokens: found?.maxTokens ?? connection.maxTokens,
    };
    const reasoning = found?.reasoning;
    if (!reasoning) return base;
    return {
      ...base,
      reasoning: {
        efforts: reasoning.map((e) => ({ id: e, name: e.charAt(0).toUpperCase() + e.slice(1) })),
        ...(found?.defaultEffort ? { defaultEffort: found.defaultEffort } : {}),
      },
    };
  }
  async *stream(options) {
    const env = { stack: [], error: undefined, hasError: false };
    const __add = (v, async) => {
      if (v == null) return v;
      const d = async ? v[Symbol.asyncDispose]?.bind(v) : v[Symbol.dispose]?.bind(v);
      env.stack.push({ value: v, dispose: d, async });
      return v;
    };
    try {
      const connection = this.config.options();
      // Guard: Text-only (Bilder nicht unterstützt auf Free-Tier)
      if (options.messages && contentHasImage(options.messages)) {
        throw new LlmError('OpenCode Zen Free unterstützt keine Bild-Eingaben', 'UNSUPPORTED_CONTENT');
      }
      const consumer = new AbortController();
      const signal = options.signal ? (consumer.signal ? AbortSignal.any([options.signal, consumer.signal]) : options.signal) : consumer.signal;
      const watchdog = __add(
        idleWatchdog(signal, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE),
        false,
      );

      // Multi-Account Retry Loop
      const apiKeyEnvs = connection.apiKeyEnvs;
      const order = this.config.accountPool.pickOrder(apiKeyEnvs);
      let lastError;
      for (let attempt = 0; attempt < order.length; attempt++) {
        const envRef = order[attempt];
        let apiKey;
        try {
          apiKey = await this.config.resolveApiKey(connection, envRef);
        } catch (e) {
          lastError = e;
          continue;
        }
        try {
          const iterator = this.request(options, watchdog.signal, connection, apiKey, () => watchdog.pulse(), envRef)[Symbol.asyncIterator]();
          let exhausted = false;
          try {
            while (true) {
              const result = await watchdog.next(iterator);
              if (result.done) { exhausted = true; break; }
              yield result.value;
            }
            // Erfolg -> raus
            consumer.abort('done');
            if (!exhausted && iterator.return) { try { await iterator.return(); } catch {} }
            return;
          } catch (error) {
            if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
              throw new LlmError(`OpenCode Zen stream idle timeout nach ${connection.streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error });
            }
            if (options.signal?.aborted) throw new LlmError('Abgebrochen', 'ABORTED', { cause: error });
            if (error instanceof LlmError) {
              // 429 / AUTH -> Account-CoolDown + Retry mit nächstem Account
              if ((error.code === 'RATE_LIMIT' || error.code === 'QUOTA' || error.code === 'AUTH') && attempt + 1 < order.length) {
                const cooldownMs = error.providerRetryAfterMs ?? connection.accountCooldownMs;
                this.config.accountPool.markFailed(envRef, cooldownMs);
                this.config.catalog.markUnavailable(options.model, connection.unavailableCooldownMs);
                lastError = error;
                // teardown current iterator
                consumer.abort('retry');
                if (!exhausted && iterator.return) { try { await iterator.return(); } catch {} }
                // Reset watchdog for next attempt (neues Signal)
                // Einfach weiter zur nächsten Iteration — watchdog bleibt, aber Signal ist noch gültig
                // Wir brechen die innere while und versuchen nächsten Account
                // Da wir yield* nicht erneut starten können ohne neues watchdog.next, brechen wir äußere Schleife nicht — wir müssen neu request starten
                // Trick: wir werfen und fangen außen nicht — stattdessen continue
                // Dafür müssen wir die Schleife unterbrechen und neu beginnen
                // Wir sind hier aber bereits im inneren try — continue äußerer for geht nicht so einfach
                // Also: mark and throw a retry sentinel, handle outside?
                // Einfacher: wenn wir hier sind und noch Versuche übrig, logge und breche inneren Loop, lasse äußere for weiterlaufen
                // Wir müssen den Iterator-Loop verlassen und nächsten Account probieren
                // Dazu: continue äußerer for via labeled break
                throw { __retry: true, error };
              }
              if (error.code === 'AUTH' || /unavailable|not supported/i.test(error.message)) {
                this.config.catalog.markUnavailable(options.model, connection.unavailableCooldownMs);
              }
              throw error;
            }
            throw new LlmError(`OpenCode Zen Stream fehlgeschlagen (${connection.baseURL})`, 'TRANSPORT', { cause: error });
          } finally {
            consumer.abort('stream consumer stopped');
            if (!exhausted && iterator.return) { try { await iterator.return(); } catch {} }
          }
        } catch (e) {
          if (e && e.__retry) {
            lastError = e.error;
            // reset watchdog pulse state? idleWatchdog hat kein reset, aber pulse reicht
            // Erzeuge neuen consumer für nächsten Versuch, da alter bereits aborted
            // Wir sind noch im äußeren try — die for-Schleife läuft weiter, aber consumer ist dead
            // Workaround: neuen Watchdog? Einfacher: wir brechen und lassen äußere Schleife neu mit frischem Signal laufen
            // Da wir aber das gleiche watchdog + consumer nutzen, müssen wir sie neu erstellen
            // Statt Komplexität: rekursiv? — einfacher: wir werfen lastError nur wenn kein weiterer Versuch
            // Für jetzt: falls retry sentinel, continue
            if (attempt + 1 < order.length) continue;
          }
          throw e.error ?? e;
        }
      }
      if (lastError) throw lastError;
      throw new LlmError('Kein Account verfügbar', 'AUTH');
    } catch (e) {
      env.error = e;
      env.hasError = true;
    } finally {
      let r = env.stack.pop();
      while (r) {
        if (r.dispose) { try { await r.dispose(); } catch {} }
        r = env.stack.pop();
      }
      if (env.hasError) throw env.error;
    }
  }

  async *request(options, signal, connection, apiKey, onComment, _envRef) {
    const entries = await this.config.catalog.entries(connection);
    const meta = entries.find((e) => e.id === options.model) ?? synthesizeEntry(options.model);
    const endpoint = meta.endpoint ?? endpointOf(options.model);
    const ids = deriveRequestIDs(options.messages);

    let url;
    let body;
    let headers = {
      ...attributionHeaders(),
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      'user-agent': ZEN_USER_AGENT,
      ...disguiseHeaders(ids),
      ...(options.sessionId !== undefined ? { 'x-deepseek-harness-session-id': String(options.sessionId) } : {}),
      ...(options.purpose === 'compaction' ? { 'x-deepseek-harness-compact': '1' } : {}),
    };

    // Tool + Endpoint spezifisch
    if (endpoint === 'responses') {
      url = `${connection.baseURL}/responses`;
      body = JSON.stringify(serializeResponsesRequest(options, meta));
    } else if (endpoint === 'messages') {
      url = `${connection.baseURL}/messages`;
      // Anthropic braucht anthropic-version header
      headers['anthropic-version'] = '2023-06-01';
      headers['x-api-key'] = apiKey; // fallback
      body = JSON.stringify(serializeAnthropicRequest(options, meta));
    } else if (endpoint === 'gemini') {
      // Gemini via /v1/models/gemini-*: POST zum modellspezifischen Pfad, body ähnlich chat
      url = `${connection.baseURL}/models/${encodeURIComponent(meta.id)}`;
      body = JSON.stringify(serializeChatRequest(options, meta));
    } else {
      url = `${connection.baseURL}/chat/completions`;
      body = JSON.stringify(serializeChatRequest(options, meta));
    }

    let response;
    try {
      response = await fetch(url, { method: 'POST', headers, body, signal });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new LlmError(`OpenCode Zen Request nach ${connection.baseURL} fehlgeschlagen`, 'TRANSPORT', { cause: error });
    }
    if (!response.ok) {
      let msg = `OpenCode Zen API Fehler (HTTP ${response.status}) bei ${url}`;
      let providerError;
      try { providerError = (await response.json())?.error; if (providerError?.message) msg = providerError.message; } catch {}
      const delay = providerRetryAfterMs(response.headers.get('retry-after'));
      throw new LlmError(msg, httpErrorCode(response.status, providerError), {
        status: response.status,
        ...(delay === undefined ? {} : { providerRetryAfterMs: delay }),
      });
    }
    if (!response.body) throw new LlmError('OpenCode Zen: keine Response-Body', 'EMPTY_RESPONSE');

    // Translator je Endpunkt
    if (endpoint === 'responses') {
      yield* translateResponses(parseSse(response.body, onComment));
    } else if (endpoint === 'messages') {
      yield* translateAnthropic(parseSse(response.body, onComment));
    } else {
      yield* translateChat(parseSse(response.body, onComment));
    }
  }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  let current = () => config;
  let lastRaw;
  let lastGood;
  const options = () => {
    const raw = current();
    if (raw === lastRaw && lastGood !== undefined) return lastGood;
    try {
      const next = resolveAdapterOptions(raw, launchEnvironmentOf(ctx));
      lastRaw = raw;
      lastGood = next;
      return next;
    } catch (error) {
      if (lastGood === undefined) throw error;
      lastRaw = raw;
      ctx.logger.error('opencode-zen-free: behalte letzte gültige Konfiguration nach invalidem settings-Abschnitt');
      ctx.logger.error(error);
      return lastGood;
    }
  };

  const accountPool = new AccountPool({ accountCooldownMs: options().accountCooldownMs });

  const resolveApiKey = async (connection, preferredEnv) => {
    // Bevorzugter Env (Multi-Account Rotation) oder erste verfügbare
    const candidates = preferredEnv ? [preferredEnv] : connection.apiKeyEnvs;
    for (const ref of candidates) {
      if (ref === PUBLIC_KEY) return PUBLIC_KEY;
      const creds = ctx.get('credentials');
      if (creds !== undefined) {
        const hit = await creds.resolve(ref);
        if (hit !== undefined) return assertUsableApiKey(hit.value, 'opencode-zen-free', ref);
      } else {
        const ambient = launchEnvironmentOf(ctx).get(ref);
        if (ambient !== undefined && ambient.value.length > 0) return assertUsableApiKey(ambient.value, 'opencode-zen-free', ref);
      }
    }
    // Fallback: probiere alle konfigurierten Envs der Reihe nach
    for (const ref of connection.apiKeyEnvs) {
      if (preferredEnv && ref === preferredEnv) continue;
      const creds = ctx.get('credentials');
      if (creds !== undefined) {
        const hit = await creds.resolve(ref);
        if (hit !== undefined) return assertUsableApiKey(hit.value, 'opencode-zen-free', ref);
      } else {
        const ambient = launchEnvironmentOf(ctx).get(ref);
        if (ambient !== undefined && ambient.value.length > 0) return assertUsableApiKey(ambient.value, 'opencode-zen-free', ref);
      }
    }
    return PUBLIC_KEY; // zero-config free lane
  };

  // Wrapper für catalog.getApiKey (braucht nur public-fähigen Key)
  const runtime = {
    getApiKey: (conn, opts) => resolveApiKey(conn, opts?.preferPublic ? PUBLIC_KEY : undefined),
    logger: ctx.logger,
  };
  const catalog = new RemoteCatalog(runtime);
  const adapter = new OpenCodeZenFreeAdapter({ options, resolveApiKey, catalog, accountPool });

  ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: 'OpenCode Zen (Free)',
    settingsNs: NS,
    settingsPath: [],
  }]);
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);

  let registeredPolicy = options().retryPolicy;
  const ensureRegistrationFacts = () => {
    const policy = options().retryPolicy;
    if (deepEqualJson(policy, registeredPolicy)) return;
    registration.replace([PROVIDER]);
    registeredPolicy = policy;
  };

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => { current = source; },
    onChange: ensureRegistrationFacts,
  });

  // llt22 compat: tolerateMissingFinishReason als Waterfall (falls DSH pi-ai noch im Spiel ist)
  // Wir registrieren zusätzlich einen llm/stream Hook der "Stream ended without finish_reason" in stop umwandelt
  if (typeof ctx.on === 'function') {
    ctx.on('llm/stream', async function* (opts, next) {
      // Nur für opencode Routen
      const isOpencode = typeof opts?.provider === 'string' && opts.provider.includes('opencode');
      if (!isOpencode) {
        yield* next();
        return;
      }
      try {
        yield* next();
      } catch (e) {
        const msg = e?.message ?? String(e);
        if (msg.includes('Stream ended without finish_reason') || msg.includes('finish_reason')) {
          // Statt Error als stop beenden (llt22 Logik)
          return;
        }
        throw e;
      }
    });
  }
}

export {
  Config,
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  FREE_MODELS,
  OpenCodeZenFreeAdapter,
  PROVIDER,
  RemoteCatalog,
  PUBLIC_KEY,
  apply,
  inject,
  name,
  resolveAdapterOptions,
  endpointOf,
};
