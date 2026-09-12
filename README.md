# dsh-opencode-zen-free — OpenCode Zen Free-Modelle für DSH Desktop (Multi-Account)

> **Komplett kostenlos** — nutzt die von OpenCode Zen gesponserten `*-free` Modelle + `big-pickle` via `Bearer public` (anonyme IP-Quota). Optional Multi-Account-Rotation für höhere Limits.

Vereint & verbessert die 7 untersuchten Plugins:

| Plugin | Idee übernommen |
|---|---|
| `xiaozhe7772222/dsh-opencode-zen`, `randomix777/dsh-opencode-zen` | Basis-Idee |
| `FishBottle7/opencode2dsh` | disguise headers (`x-opencode-*`), Catalog S1/S2/S3, watchdogs |
| `DHS-M/dsh-opencode-zen` | Loopback/Shim Idee (hier direkt ohne Shim) |
| `FishBottle7/opencode2dsh` + `tovuse/...` | `User-Agent: opencode/...` Bypass gegen `429 FreeUsageLimitError` |
| `zouyuanqing/dsh-llm-opencode-zen` | Zero-Config `Bearer public`, dynamic catalog, cooldown, `reasoning_content` → `reasoning-delta` |
| `2247069117/dsh-llm-opencode-zen` | `reasoning_effort` Mapping, Auto-Discovery |
| `llt22/dsh-opencode-zen-compat` | Toleriert fehlendes `finish_reason` / `[DONE]` (Zen non-standard stream-Ende) |
| `ZeroHomer/dsh-opencode-zen-bypass` | UA-Strip (hier per-Request, kein globaler `fetch`-Patch) |
| `dsh-llm-opencode` / `dsh-opencode` | Settings-Schema & Provider-Registrierung |

---

## Was ist neu / warum dieses Plugin?

* **Alle 3 Wire-Varianten** in EINEM Adapter — erkennt pro Modell automatisch den richtigen Endpunkt (aus `https://opencode.ai/docs/zen/#endpoints`):
  * `POST /v1/chat/completions` — `big-pickle`, `mimo-*`, `ling-*`, `nemotron-*`, `deepseek-*`, `glm-*`, `minimax-*`, `kimi-*`, …
  * `POST /v1/responses` — `muse-spark-1.3-contributor-free` (aktuell!), `muse-spark-1.2`, `gpt-5.*`, `grok-*`
  * `POST /v1/messages` — `claude-*`, `qwen3.*-plus` (falls künftig als `-free` erscheint, bereits vorbereitet)
  * `POST /v1/models/gemini-*` — `gemini-*` (falls `-free` erscheint)
* **31 Free-Modelle** statisch verifiziert (`cost.input==0` aus `models.dev/api.json` `opencode` Provider) + **live `/v1/models` Auto-Discovery** — neue Free-Modelle erscheinen automatisch, delisted werden via Cooldown ausgeblendet.
* **Multi-Account Rotation** — `apiKeyEnvs: ["OPENCODE_API_KEY","OPENCODE_ZEN_API_KEY_2",...]` mit Round-Robin + per-Account Cooldown nach `429`/`401`. Fällt auf `Bearer public` zurück wenn alle Accounts im Cooldown sind → **maximale Ausnutzung der kostenlosen IP-Quotas**.
* **Disguise vollständig** — `User-Agent: opencode/1.18.21 (...)`, `x-opencode-client: cli`, `x-opencode-session: ses_<sha256(firstUserMsg)>`, `x-opencode-request`, `x-opencode-project` (FishBottle-ids.ts Port) — sonst `429`.
* **Streaming robust** — verträgt fehlendes `finish_reason`/`[DONE]` + `{"choices":[],"cost":"0"}` Envelope (llt22-Fix), `reasoning_content`/`reasoning_details` → `reasoning-delta`, Tool-Calls, `usage` + `finish`, `idleWatchdog` 300s.
* **Ein Plugin, ein Provider** — `provider: opencode-zen-free`, Display-Name *OpenCode Zen (Free)*, keine Sidecar-Binary, keine Go-Builds.

---

## Aktuell live verifiziert (2026-09-12)

`GET https://opencode.ai/zen/v1/models` mit `Authorization: Bearer public`:

```
big-pickle
deepseek-v4-flash-free
muse-spark-1.3-contributor-free  -> /v1/responses (OpenAI Responses API!)
muse-spark-1.2-contributor-free  -> /v1/responses
mimo-v2.5-free
ling-3.0-flash-fin-free
nemotron-3-ultra-free
nemotron-3.5-lightning-free
```

Restliche `models.dev` Free-Modelle (23 weitere) sofort nutzbar sobald OpenCode sie wieder in `/v1/models` listet — der Adapter synthetisiert sie bereits (u.a. `glm-5-free`, `kimi-k2.5-free`, `laguna-s-2.1-free`, `minimax-m3-free`, `qwen3.6-plus-free`, `ring-2.6-1t-free`, …).

---

## Installation

```bash
# via DSH CLI (empfohlen)
dsh plugin --profile web add dsh-opencode-zen-free
# oder lokal aus diesem Repo
dsh plugin --profile web add /workspaces/OpenCode-Zen-2-dsh

# danach DSH neu starten — Provider erscheint im Model-Picker als "OpenCode Zen (Free)"
```

### Manuell (settings.yaml)

Kein `cordis.patch.yml` nötig wenn bereits via Plugin installiert. Für direkten Bundle-Insert:

```yaml
# cordis.patch.yml liegt bei — DSH injiziert automatisch:
# - id: opencode-zen-free
#   name: 'dsh-opencode-zen-free'
#   config: {}
```

---

## Konfiguration

### Minimal (Zero-Config, komplett kostenlos)

```yaml
# ~/.dsh/settings.yaml
agent-default-model:
  provider: opencode-zen-free
  model: mimo-v2.5-free
  reasoningEffort: high
# llm-credentials leer lassen -> Bearer public, 8 live Free-Modelle sofort nutzbar
```

### Multi-Account (höhere Limits)

```yaml
llm-credentials:
  OPENCODE_API_KEY: "sk-..."      # Account 1 (opencode.ai/auth)
  OPENCODE_ZEN_API_KEY_2: "sk-..." # Account 2
  OPENCODE_ZEN_API_KEY_3: "sk-..." # Account 3

opencode-zen-free:
  apiKeyEnvs:
    - OPENCODE_API_KEY
    - OPENCODE_ZEN_API_KEY_2
    - OPENCODE_ZEN_API_KEY_3
  # optional Tuning
  dynamicCatalog: true
  catalogTtlMs: 600000              # 10min live /v1/models Refresh
  unavailableCooldownMs: 1800000    # 30min Modell-Ban nach AUTH/unavailable
  accountCooldownMs: 60000          # 60s Account-Cooldown nach 429
  streamIdleTimeoutMs: 300000       # 5min Idle-Watchdog
  models:                           # optional: Modelle überschreiben/erweitern
    - id: mimo-v2.5-free
      name: MiMo V2.5 Free
      contextWindow: 200000
      maxTokens: 32000
      reasoning: [high, max]
      defaultEffort: high
      endpoint: chat
```

> **Wie Multi-Account funktioniert:** Der Adapter probiert die `apiKeyEnvs` in Round-Robin-Reihenfolge. Schlägt ein Account mit `429`/`401`/`403` fehl, wird er für `accountCooldownMs` (bzw. `Retry-After` Header) gebannt und der nächste Account wird im selben Stream-Versuch probiert. Sind alle Accounts im Cooldown, fällt er transparent auf `Bearer public` zurück. Ein Modell, das `AUTH`/`unavailable` liefert, wird für `unavailableCooldownMs` aus `listModels`/`resolveModel` ausgeblendet.

### Single-Account Legacy

```yaml
opencode-zen-free:
  apiKeyEnv: OPENCODE_API_KEY   # wird automatisch nach apiKeyEnvs[0] migriert
```

---

## Endpunkte & Protokolle

| Endpunkt | Wire | Modelle (Beispiele) | Translator |
|---|---|---|---|
| `https://opencode.ai/zen/v1/chat/completions` | `openai-completions` SSE `choices[].delta.{content, reasoning_content, tool_calls, reasoning_details}` | `big-pickle`, `mimo-*`, `ling-*`, `nemotron-*`, `deepseek-*`, `glm-*`, `minimax-*`, `kimi-*` | `translateChat` |
| `https://opencode.ai/zen/v1/responses` | `openai` Responses SSE `event: response.*` | `muse-spark-1.3-contributor-free`, `gpt-5.*`, `grok-*` | `translateResponses` |
| `https://opencode.ai/zen/v1/messages` | `anthropic` SSE `content_block_delta` | `claude-*`, `qwen3.*` | `translateAnthropic` |
| `https://opencode.ai/zen/v1/models/gemini-*` | `google` | `gemini-*` | `translateChat` (Fallback) |

Der Adapter wählt per `endpointOf(modelId)` + pro-Modell `endpoint` Feld. Unbekannte künftige `-free` Modelle werden per Prefix-Heuristik korrekt geroutet.

---

## Troubleshooting

* `429 FreeUsageLimitError` → User-Agent nicht `opencode/` oder IP-Quota erschöpft → Plugin setzt korrekten UA; bei Quota: warten oder weiteren Account in `apiKeyEnvs` ergänzen.
* `401/403` / `not supported` / `unavailable` → Modell gerade delisted/region-blocked → Adapter bannt es 30min, fällt auf nächstes Modell zurück.
* Stream bleibt hängen → `idleWatchdog` wirft nach `streamIdleTimeoutMs` `TIMEOUT`, Host retry greift.
* `Stream ended without finish_reason` → automatisch toleriert (Zens non-standard Ende).
* Bilder → `UNSUPPORTED_CONTENT` (Free-Tier unterstützt nur Text).

---

## Lizenz

MIT
