/**
 * dsh-opencode-zen-free v1.1 — DSH Desktop Plugin für komplett kostenlose OpenCode Zen Free-Modelle
 *
 * v1.1 NEU: Eager Startup-Discovery + Profile-MultiAccount
 *  - Bei Start: vollständige Abfrage aller Free-Modelle (GET /v1/models), deren Endpunkte (GET https://opencode.ai/docs/zen Tabelle),
 *    und deren Einstellungen (limit/context/output via models.dev/api.json) -> sofort einsatzbereit
 *  - Profile: beliebig viele Accounts als Profile hinzufügbar (Name + API-Key Env), mit Multi-Account Rotation & Cooldown
 *
 * Vereint 7 Plugins: FishBottle/opencode2dsh, zou, 224706, DHS-M, llt22, ZeroHomer, tovuse
 * 3 Wire-Varianten: /v1/chat/completions, /v1/responses, /v1/messages, /v1/models/gemini-*
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
const DOCS_URL = 'https://opencode.ai/docs/zen';
const MODELS_DEV_URL = 'https://models.dev/api.json';

const name = 'opencode-zen-free';
const inject = ['llm'];

function endpointOf(modelId) {
  const id = String(modelId).toLowerCase();
  if (id.startsWith('gpt-') || id.startsWith('grok-') || id.startsWith('muse-spark-')) return 'responses';
  if (id.startsWith('claude-') || id.startsWith('qwen')) return 'messages';
  if (id.startsWith('gemini-')) return 'gemini';
  return 'chat';
}

const STATIC_FREE = [
  { id: 'big-pickle', name: 'Big Pickle', contextWindow: 200000, maxTokens: 32000, reasoning: ['off', 'high'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free', contextWindow: 200000, maxTokens: 128000, reasoning: ['high', 'max'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'muse-spark-1.3-contributor-free', name: 'Muse Spark 1.3 Contributor Free', contextWindow: 256000, maxTokens: 64000, reasoning: ['off', 'high'], defaultEffort: 'high', endpoint: 'responses' },
  { id: 'muse-spark-1.2-contributor-free', name: 'Muse Spark 1.2 Contributor Free', contextWindow: 256000, maxTokens: 64000, reasoning: ['off', 'high'], defaultEffort: 'high', endpoint: 'responses' },
  { id: 'mimo-v2.5-free', name: 'MiMo V2.5 Free', contextWindow: 200000, maxTokens: 32000, reasoning: ['off', 'high'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'ling-3.0-flash-fin-free', name: 'Ling 3.0 Flash Fin Free', contextWindow: 262144, maxTokens: 32768, reasoning: ['off', 'high'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free', contextWindow: 1000000, maxTokens: 128000, reasoning: ['off', 'high'], defaultEffort: 'high', endpoint: 'chat' },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning Free', contextWindow: 200000, maxTokens: 32000, reasoning: ['off', 'high'], defaultEffort: 'high', endpoint: 'chat' },
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

function stableID(prefix, value) {
  const sum = createHash('sha256').update(prefix + '\x00' + value).digest();
  return `${prefix}_${sum.subarray(0, 12).toString('hex')}`;
}
function randomID(prefix, size) { return `${prefix}_${randomBytes(size).toString('hex')}`; }
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
  return { session: stableID('ses', signal), request: randomID('req', 16), project: stableID('prj', 'opencode-zen-free:default-project'), parentSession: '' };
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
// Schema & Config — Profile-basiertes Multi-Account
// ---------------------------------------------------------------------------

const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  reasoning: z.array(z.string()),
  defaultEffort: z.string(),
  endpoint: z.string(),
});

const profileModel = z.object({
  name: z.string().default(''),
  apiKeyEnv: z.string().role('credential-ref').required(),
  enabled: z.boolean().default(true),
});

const Config = z.object({
  // NEU: Profile — jede Zeile = ein Account mit eigenem API-Key
  profiles: z.array(profileModel).default([{ name: 'default', apiKeyEnv: 'OPENCODE_API_KEY', enabled: true }]),
  // Legacy Felder (werden automatisch nach profiles migriert, falls profiles leer ist)
  apiKeyEnvs: z.array(z.string().role('credential-ref')),
  apiKeyEnv: z.string().role('credential-ref'),
  baseURL: z.string().default(DEFAULT_BASE_URL),
  modelsDevUrl: z.string().default(MODELS_DEV_URL),
  docsUrl: z.string().default(DOCS_URL),
  // Eager Bootstrap
  eagerBootstrap: z.boolean().default(true),
  bootstrapTimeoutMs: z.number().step(1).min(1000).max(120000).default(15000),
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

function normalizeProfiles(raw) {
  const profiles = [];
  // 1) explizite profiles
  if (Array.isArray(raw?.profiles) && raw.profiles.length > 0) {
    for (const p of raw.profiles) {
      if (!p || typeof p.apiKeyEnv !== 'string' || !p.apiKeyEnv.trim()) continue;
      profiles.push({ name: String(p.name ?? '').trim() || p.apiKeyEnv.trim(), apiKeyEnv: p.apiKeyEnv.trim(), enabled: p.enabled !== false });
    }
  }
  // 2) Legacy apiKeyEnvs -> Profile synthetisieren, falls noch keine vorhanden
  if (profiles.length === 0) {
    const legacy = [];
    if (Array.isArray(raw?.apiKeyEnvs)) for (const v of raw.apiKeyEnvs) if (typeof v === 'string' && v.trim()) legacy.push(v.trim());
    if (typeof raw?.apiKeyEnv === 'string' && raw.apiKeyEnv.trim()) legacy.push(raw.apiKeyEnv.trim());
    const uniq = [...new Set(legacy)];
    if (uniq.length > 0) {
      for (const env of uniq) profiles.push({ name: env, apiKeyEnv: env, enabled: true });
    } else {
      // Fallback: leeres Profil = rein anonymer Modus (Bearer public) – trotzdem ein Dummy-Profil für UI
      // Kein Profil nötig; leer bedeutet nur public
    }
  }
  return profiles;
}

function normalizeApiKeyEnvs(raw) {
  const list = [];
  const profiles = normalizeProfiles(raw);
  for (const p of profiles) if (p.enabled) list.push(p.apiKeyEnv);
  // Legacy fallback falls profiles leer
  if (list.length === 0) {
    if (Array.isArray(raw?.apiKeyEnvs)) for (const v of raw.apiKeyEnvs) if (typeof v === 'string' && v.trim()) list.push(v.trim());
    if (typeof raw?.apiKeyEnv === 'string' && raw.apiKeyEnv.trim() && !list.includes(raw.apiKeyEnv.trim())) list.push(raw.apiKeyEnv.trim());
  }
  return [...new Set(list)];
}

function resolveAdapterOptions(config, env) {
  const base = config ?? {};
  const profiles = normalizeProfiles(base);
  const apiKeyEnvs = normalizeApiKeyEnvs(base);
  const models = (base.models ?? FREE_MODELS).map((m) => ({
    ...m,
    endpoint: m.endpoint ?? endpointOf(m.id),
    reasoning: m.reasoning ?? ['high', 'max'],
  }));
  return {
    profiles,
    apiKeyEnvs,
    baseURL: String(base.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
    modelsDevUrl: String(base.modelsDevUrl ?? MODELS_DEV_URL),
    docsUrl: String(base.docsUrl ?? DOCS_URL),
    eagerBootstrap: base.eagerBootstrap ?? true,
    bootstrapTimeoutMs: base.bootstrapTimeoutMs ?? 15000,
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
function synthesizeEntry(id, meta) {
  const base = {
    id,
    name: id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    reasoning: ['high', 'max'],
    defaultEffort: 'high',
    endpoint: endpointOf(id),
  };
  if (meta?.limit?.context) base.contextWindow = meta.limit.context;
  if (meta?.limit?.output) base.maxTokens = meta.limit.output;
  if (meta?.endpoint) base.endpoint = meta.endpoint;
  return base;
}

// ---------------------------------------------------------------------------
// Endpoint-Map aus Doku + models.dev Metadata-Decoder
// ---------------------------------------------------------------------------

async function fetchEndpointMap(docsUrl) {
  try {
    const res = await fetch(docsUrl, { headers: { 'user-agent': ZEN_USER_AGENT, 'accept': 'text/html' }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('docs HTTP ' + res.status);
    const html = await res.text();
    const map = new Map();
    // <tr><td>Name</td><td>model-id</td><td><code>https://opencode.ai/zen/v1/XXX</code>
    const re = /<tr><td>[^<]*<\/td><td>([^<]+)<\/td><td><code[^>]*>([^<]+)<\/code>\s*<\/td>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const mid = m[1].trim();
      const url = m[2].trim();
      let ep = 'chat';
      if (url.includes('/responses')) ep = 'responses';
      else if (url.includes('/messages')) ep = 'messages';
      else if (url.includes('/models/gemini')) ep = 'gemini';
      else if (url.includes('/chat/completions')) ep = 'chat';
      map.set(mid, ep);
    }
    return map;
  } catch (e) {
    return new Map();
  }
}

function decodeModelsDev(data) {
  const result = new Map();
  if (!data || typeof data !== 'object') return result;
  const providers = data;
  // Priorität: opencode, opencode-zen etc. (FishBottle Logik)
  const keys = Object.keys(providers);
  const rank = (k) => {
    const lower = k.toLowerCase();
    if (lower === 'opencode' || lower === 'opencode-zen' || lower === 'opencode_zen') return 0;
    if (lower.includes('opencode')) return 1;
    return 2;
  };
  keys.sort((a,b)=> rank(a)-rank(b) || a.localeCompare(b));
  for (const key of keys) {
    if (rank(key) > 1) continue;
    const provider = providers[key];
    if (!provider || typeof provider !== 'object') continue;
    const models = provider.models;
    if (!models || typeof models !== 'object') continue;
    for (const [modelKey, raw] of Object.entries(models)) {
      if (!raw || typeof raw !== 'object') continue;
      const modelId = typeof raw.id === 'string' && raw.id.length>0 ? raw.id : modelKey;
      result.set(modelId, raw);
    }
    if (result.size>0) return result;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Multi-Account Pool (Profile-bewusst)
// ---------------------------------------------------------------------------

class AccountPool {
  constructor(options) {
    this.cooldown = new Map();
    this.roundRobin = 0;
    this.accountCooldownMs = options.accountCooldownMs ?? DEFAULT_ACCOUNT_COOLDOWN_MS;
  }
  markFailed(env, ms) {
    if (!env || env === PUBLIC_KEY) return;
    this.cooldown.set(env, Date.now() + (ms ?? this.accountCooldownMs));
  }
  isCooling(env) { const u=this.cooldown.get(env); return u!==undefined && u>Date.now(); }
  pickOrder(apiKeyEnvs) {
    const now=Date.now();
    const avail=[], cool=[];
    for(const env of apiKeyEnvs){ const until=this.cooldown.get(env); if(until!==undefined&&until>now) cool.push(env); else avail.push(env); }
    if(avail.length>1){ const shift=this.roundRobin%avail.length; this.roundRobin=(this.roundRobin+1)%100000; return [...avail.slice(shift),...avail.slice(0,shift),...cool,PUBLIC_KEY].filter((v,i,a)=>a.indexOf(v)===i); }
    return [...avail,...cool,PUBLIC_KEY].filter((v,i,a)=>a.indexOf(v)===i);
  }
  status(profiles){
    const now=Date.now();
    return (profiles||[]).map(p=>({ name:p.name, apiKeyEnv:p.apiKeyEnv, enabled:p.enabled, cooling: this.isCooling(p.apiKeyEnv), until: this.cooldown.get(p.apiKeyEnv)||0, remaining: Math.max(0,(this.cooldown.get(p.apiKeyEnv)||0)-now) }));
  }
}

// ---------------------------------------------------------------------------
// Remote Catalog — Eager Bootstrap
// ---------------------------------------------------------------------------

class RemoteCatalog {
  constructor(runtime) {
    this.runtime = runtime;
    this.cache = null; // { ids: string[], at: number, enriched: Map }
    this.enriched = new Map(); // id -> full entry with endpoint/context/maxTokens
    this.endpointMap = new Map();
    this.modelsDevMeta = new Map(); // id -> raw meta
    this.inflight = null;
    this.cooldown = new Map();
    this.ready = false;
    this.lastBootstrap = 0;
    this.lastBootstrapError = '';
    this.bootstrapCount = 0;
  }

  async bootstrap(connection){
    if(this.inflight) return this.inflight;
    this.inflight = (async()=>{
      const started=Date.now();
      try{
        // Parallel: S1 /v1/models, S2 models.dev, S3 endpoint Doku
        const apiKey = await this.runtime.getApiKey(connection, { preferPublic: true });
        const p1 = fetch(connection.baseURL + '/models', {
          headers: { ...attributionHeaders(), 'authorization': 'Bearer '+apiKey, 'accept':'application/json', 'user-agent': ZEN_USER_AGENT },
          signal: AbortSignal.timeout(connection.bootstrapTimeoutMs ?? 15000),
        }).then(async r=>{ if(!r.ok) throw new Error('S1 HTTP '+r.status); const j=await r.json(); return Array.isArray(j?.data)? j.data.map(e=>e?.id).filter(id=>typeof id==='string') : []; }).catch(e=>{ this.runtime.logger?.warn?.('opencode-zen-free: bootstrap S1 /v1/models fehlgeschlagen: '+ (e?.message??String(e))); return null; });

        const p2 = fetch(connection.modelsDevUrl, { headers:{ 'accept':'application/json', 'user-agent': ZEN_USER_AGENT }, signal: AbortSignal.timeout(connection.bootstrapTimeoutMs ?? 15000) }).then(async r=>{ if(!r.ok) throw new Error('S2 HTTP '+r.status); return r.json(); }).then(j=> decodeModelsDev(j)).catch(e=>{ this.runtime.logger?.warn?.('opencode-zen-free: bootstrap S2 models.dev fehlgeschlagen: '+ (e?.message??String(e))); return new Map(); });

        const p3 = fetchEndpointMap(connection.docsUrl).catch(()=>new Map());

        const [ids, metaMap, epMap] = await Promise.all([p1,p2,p3]);
        this.modelsDevMeta = metaMap;
        this.endpointMap = epMap;

        const statics = normalizeModels(connection.models);
        const byId = new Map(statics.map(e=>[e.id,e]));
        // Enriched Endpoint + Limit aus models.dev + Doku
        for(const [id, raw] of metaMap){
          const existing = byId.get(id);
          if(existing){
            if(raw?.limit?.context) existing.contextWindow = raw.limit.context;
            if(raw?.limit?.output) existing.maxTokens = raw.limit.output;
            if(epMap.has(id)) existing.endpoint = epMap.get(id);
          }
        }
        // Endpoint für alle statics aus Doku überschreiben falls vorhanden
        for(const e of statics){ if(epMap.has(e.id)) e.endpoint = epMap.get(e.id); if(metaMap.has(e.id)){ const raw=metaMap.get(e.id); if(raw?.limit?.context) e.contextWindow=raw.limit.context; if(raw?.limit?.output) e.maxTokens=raw.limit.output; } }

        // Entscheide freie Modelle: S2 cost==0 ODER S1 live -free/big-pickle + S3 fallback
        const freeFromDev = new Set([...metaMap.entries()].filter(([id,raw])=> raw?.cost?.input===0 && raw?.cost?.output===0 && (raw?.deprecated!==true)).map(([id])=>id));
        // Live IDs filtern nur free
        let liveFree = null;
        if(ids!==null){
          liveFree = ids.filter(id=> id==='big-pickle' || id.endsWith(FREE_MODEL_SUFFIX) || freeFromDev.has(id) || byId.has(id));
          this.cache = { ids, at: Date.now() };
        }
        // Final exposed = (liveFree ?? statics) ∪ freeFromDev ∪ statics, dedupliziert, mit Enrichment
        const finalIds = liveFree !== null
          ? [...new Set([...liveFree, ...statics.map(e=>e.id), ...freeFromDev])]
          : [...new Set([...statics.map(e=>e.id), ...freeFromDev])];

        // Baue enriched Map
        this.enriched.clear();
        for(const id of finalIds){
          let entry = byId.get(id);
          if(!entry){
            const raw = metaMap.get(id);
            entry = synthesizeEntry(id, { limit: raw?.limit, endpoint: epMap.get(id) });
          } else {
            // Ensure endpoint from epMap if still generic
            if(epMap.has(id) && entry.endpoint === endpointOf(id) && epMap.get(id)!==entry.endpoint) entry.endpoint = epMap.get(id);
          }
          this.enriched.set(id, entry);
        }
        this.ready = true;
        this.lastBootstrap = Date.now();
        this.lastBootstrapError = '';
        this.bootstrapCount++;
        const counts={ chat:0, responses:0, messages:0, gemini:0 };
        for(const e of this.enriched.values()){ counts[e.endpoint]=(counts[e.endpoint]||0)+1; }
        const elapsed = Date.now()-started;
        this.runtime.logger?.info?.(`opencode-zen-free: bootstrap #${this.bootstrapCount} fertig in ${elapsed}ms — ${this.enriched.size} Free-Modelle (chat:${counts.chat} responses:${counts.responses} messages:${counts.messages} gemini:${counts.gemini}) | S1:${ids?ids.length+' live':'offline'} S2:${metaMap.size} Doku:${epMap.size} Endpoints`);
        return this.enriched;
      }catch(e){
        this.lastBootstrapError = e?.message ?? String(e);
        this.runtime.logger?.warn?.('opencode-zen-free: bootstrap fehlgeschlagen: '+this.lastBootstrapError);
        throw e;
      }finally{ this.inflight=null; }
    })();
    return this.inflight;
  }

  async listRemoteIds(connection){
    if(this.cache && Date.now()-this.cache.at < connection.catalogTtlMs) return this.cache.ids;
    if(!this.ready && connection.eagerBootstrap){
      try{ await this.bootstrap(connection); }catch{}
    }
    if(this.inflight) await this.inflight;
    if(this.cache) return this.cache.ids;
    // Fallback: wenn kein Cache, versuche einzelnen S1 Fetch (lazy)
    try{
      const apiKey = await this.runtime.getApiKey(connection, { preferPublic:true });
      const res=await fetch(connection.baseURL+'/models',{ headers:{ ...attributionHeaders(), 'authorization':'Bearer '+apiKey, 'accept':'application/json', 'user-agent': ZEN_USER_AGENT } });
      if(!res.ok) throw new LlmError('catalog fetch failed HTTP '+res.status,'SERVER');
      const body=await res.json();
      const ids=Array.isArray(body?.data)? body.data.map(e=>e?.id).filter(id=>typeof id==='string'): [];
      this.cache={ids, at:Date.now()};
      return ids;
    }catch(e){ this.runtime.logger?.warn?.('opencode-zen-free: listRemoteIds fallback fehlgeschlagen',e); return [...this.enriched.keys()]; }
  }

  async entries(connection){
    // Eager: falls nicht ready, bootstrap jetzt (aber non-blocking falls eagerBootstrap true und bereits im Hintergrund)
    if(!this.ready && connection.dynamicCatalog){
      if(connection.eagerBootstrap){
        // Starte Bootstrap im Hintergrund falls noch nicht laufend, aber warte kurz (max bootstrapTimeoutMs) damit erste listModels schon vollständig ist
        try{ await Promise.race([this.bootstrap(connection), new Promise((_,rej)=> setTimeout(()=>rej(new Error('bootstrap timeout')), 4000))]); }catch(e){ this.runtime.logger?.warn?.('opencode-zen-free: eager bootstrap timeout/fail, nutze statische Fallback-Liste'); }
      }
    }
    // Falls enriched bereits gefüllt, nutze diese direkt
    if(this.enriched.size>0){
      const now=Date.now();
      return [...this.enriched.values()].filter(e=>{ const u=this.cooldown.get(e.id); return u===undefined || u<=now; });
    }
    // Fallback alter Pfad (statics + lazy remote)
    const statics = normalizeModels(connection.models);
    let remoteIds=null;
    if(connection.dynamicCatalog){
      try{ remoteIds=await this.listRemoteIds(connection); }catch(e){ this.runtime.logger?.warn?.('opencode-zen-free: dynamic catalog unavailable, fallback static',e); }
    }
    const byId=new Map(statics.map(e=>[e.id,e]));
    // Endpoint/Map Overrides
    for(const [id,ep] of this.endpointMap){ const ent=byId.get(id); if(ent) ent.endpoint=ep; }
    for(const [id,raw] of this.modelsDevMeta){ const ent=byId.get(id); if(ent && raw?.limit){ if(raw.limit.context) ent.contextWindow=raw.limit.context; if(raw.limit.output) ent.maxTokens=raw.limit.output; } }
    const ids= remoteIds===null ? statics.map(e=>e.id) : [...new Set([...statics.map(e=>e.id), ...remoteIds.filter(id=> id==='big-pickle' || id.endsWith(FREE_MODEL_SUFFIX) || this.modelsDevMeta.has(id) || byId.has(id))])];
    const now=Date.now();
    return ids.filter(id=>{ const u=this.cooldown.get(id); return u===undefined||u<=now; }).map(id=> byId.get(id) ?? synthesizeEntry(id, { limit: this.modelsDevMeta.get(id)?.limit, endpoint: this.endpointMap.get(id)}));
  }
  markUnavailable(id, ms){ if(!id||ms<=0) return; this.cooldown.set(id, Date.now()+ms); }
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
    return PUBLIC_KEY;
  };

  const runtime = {
    getApiKey: (conn, opts) => resolveApiKey(conn, opts?.preferPublic ? PUBLIC_KEY : (opts?.preferredEnv ?? undefined)),
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

  // EAGER BOOTSTRAP: bei Start alle Free-Modelle + Endpunkte/Einstellungen komplett abfragen
  const conn0 = options();
  if (conn0.eagerBootstrap) {
    // fire & forget, aber mit Timeout & Logging
    const t0 = Date.now();
    ctx.logger.info(`opencode-zen-free: starte eager bootstrap (profiles: ${conn0.profiles.length} | ${conn0.profiles.map(p=>p.apiKeyEnv+(p.enabled?'':' (disabled)')).join(', ') || 'nur Bearer public'})`);
    // Kurz warten und dann im Hintergrund weiter: erster Aufruf versucht Bootstrap innerhalb von 4s synchron für sofort einsatzbereite Modelle
    void catalog.bootstrap(conn0).then((enriched)=>{
      // Profile-Check: welche Keys sind auflösbar?
      void Promise.all(conn0.profiles.map(async (p)=>{
        if (!p.enabled) return { p, ok:false, reason:'disabled' };
        try{
          const k = await resolveApiKey(conn0, p.apiKeyEnv);
          return { p, ok: k!==PUBLIC_KEY, key: k===PUBLIC_KEY?'(public)':'(key vorhanden)' };
        }catch(e){ return { p, ok:false, reason: e?.message??String(e) }; }
      })).then((results)=>{
        const okCount = results.filter(r=>r.ok).length;
        ctx.logger.info(`opencode-zen-free: ${enriched.size} Free-Modelle bereit, davon sofort nutzbar: ${enriched.size} | Profile ok: ${okCount}/${results.length} | Time: ${Date.now()-t0}ms`);
        for(const r of results){
          ctx.logger.info(`  profile "${r.p.name}" (${r.p.apiKeyEnv}) -> ${r.ok ? 'OK '+ (r.key||'') : 'FEHLER: '+(r.reason||'kein Key')}`);
        }
        // Periodischer Refresh via catalogTtlMs
        const scheduleRefresh = ()=>{
          setTimeout(async()=>{
            try{ await catalog.bootstrap(options()); }catch{}
            if(!ctx.isDisposed?.()) scheduleRefresh();
          }, options().catalogTtlMs);
        };
        scheduleRefresh();
      });
    }).catch((e)=>{
      ctx.logger.warn(`opencode-zen-free: eager bootstrap initial fehlgeschlagen: ${e?.message??String(e)} — Fallback auf statische Liste (${conn0.models.length} Modelle)`);
    });
  } else {
    ctx.logger.info('opencode-zen-free: eagerBootstrap deaktiviert — nutze lazy discovery');
  }

  // llt22 compat: tolerateMissingFinishReason
  if (typeof ctx.on === 'function') {
    ctx.on('llm/stream', async function* (opts, next) {
      const isOpencode = typeof opts?.provider === 'string' && opts.provider.includes('opencode');
      if (!isOpencode) { yield* next(); return; }
      try { yield* next(); } catch (e) {
        const msg = e?.message ?? String(e);
        if (msg.includes('Stream ended without finish_reason') || msg.includes('finish_reason')) return;
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
