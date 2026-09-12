# dsh-opencode-zen-free v1.1 — OpenCode Zen Free-Modelle für DSH Desktop (Eager Bootstrap + Profile-MultiAccount)

> **Komplett kostenlos** — nutzt die von OpenCode Zen gesponserten `*-free` Modelle + `big-pickle` via `Bearer public` (anonyme IP-Quota). **Bei Start werden alle Free-Modelle, deren korrekte Endpunkte und Einstellungen komplett abgefragt und sofort einsatzbereit eingerichtet.** Optional beliebig viele **Profile** (Accounts) mit eigenem API-Key für Multi-Account Rotation.

Vereint & verbessert die 7 untersuchten Plugins:

| Plugin | Idee übernommen |
|---|---|
| `xiaozhe7772222/dsh-opencode-zen`, `randomix777/dsh-opencode-zen` | Basis-Idee |
| `FishBottle7/opencode2dsh` | disguise headers (`x-opencode-*`), Catalog S1/S2/S3, watchdogs |
| `zouyuanqing/dsh-llm-opencode-zen` | Zero-Config `Bearer public`, dynamic catalog, `reasoning_content` → `reasoning-delta` |
| `2247069117/dsh-llm-opencode-zen` | `reasoning_effort` Mapping, Auto-Discovery |
| `llt22/dsh-opencode-zen-compat` | Toleriert fehlendes `finish_reason` / `[DONE]` |
| `ZeroHomer/dsh-opencode-zen-bypass` | User-Agent Bypass |
| `DHS-M/dsh-opencode-zen` | Shim-Idee (hier direkt ohne Shim) |

---

## v1.1 — Was ist neu?

### 1. Eager Startup-Bootstrap — „komplett abfragen und einstellen“
Beim Laden des Plugins (DSH Start / Plugin-Reload) läuft automatisch **ein paralleler Bootstrap**:

```
S1 = GET https://opencode.ai/zen/v1/models          (Authorization: Bearer public)
S2 = GET https://models.dev/api.json                (opencode-Provider: cost, limit.context/output)
S3 = GET https://opencode.ai/docs/zen               (HTML-Tabelle: Model ID → Endpoint URL)
S4 = lokale STATIC_FREE Fallback (31 verifizierte Free-Modelle)
```

Daraus wird **ein enriched Katalog** gebaut:

* **Nur Free-Modelle** (`cost.input==0 && cost.output==0` ODER `id==="big-pickle"` ODER `*-free` Suffix) — ca. **31 Modelle** (live 8 + 23 in Reserve)
* **Korrekter Endpunkt je Modell** aus der Doku-Tabelle (`/chat/completions` vs `/responses` vs `/messages` vs `/models/gemini-*`), Fallback Heuristik `endpointOf(id)`
* **Korrekte Einstellungen je Modell** (`contextWindow = limit.context`, `maxTokens = limit.output` aus models.dev), + `reasoning: [high,max]`
* **Ergebnis wird sofort verwendet** — `listModels`/`resolveModel` liefern direkt nach Bootstrap den vollständigen Katalog, `prepareCall` routet ohne weiteren Fetch. Falls S1/S2 offline, greift die statische `STATIC_FREE` Liste.

Log beim Start:
```
opencode-zen-free: starte eager bootstrap (profiles: 1 | OPENCODE_API_KEY)
opencode-zen-free: bootstrap #1 fertig in 412ms — 31 Free-Modelle (chat:27 responses:3 messages:1 gemini:0) | S1:70 live S2:102 Doku:69 Endpoints
opencode-zen-free: 31 Free-Modelle bereit, davon sofort nutzbar: 31 | Profile ok: 1/1
```

Der Bootstrap wiederholt sich alle `catalogTtlMs` (default 10min) und bei Bedarf (Cooldown abgelaufen).

### 2. Profile — Multi-Account mit beliebigen API-Keys

Statt nur `apiKeyEnvs: ["OPENCODE_API_KEY"]` gibt es jetzt **benannte Profile**:

```yaml
opencode-zen-free:
  profiles:
    - name: "Privat"
      apiKeyEnv: "OPENCODE_API_KEY"          # verweist auf Settings → Credentials
      enabled: true
    - name: "Zweitaccount"
      apiKeyEnv: "OPENCODE_API_KEY_2"
      enabled: true
    - name: "Team"
      apiKeyEnv: "OPENCODE_ZEN_TEAM_KEY"
      enabled: false                          # temporär deaktiviert
```

* Jedes Profil verweist auf eine **Credential-Referenz** (Umgebungsvariable / `llm-credentials` in `settings.yaml`). In DSH Settings → Credentials den Key hinterlegen.
* **Rotation:** Round-Robin über alle `enabled` Profile. Schlägt ein Profil mit `429`/`401`/`403`/`402` fehl, wird es für `accountCooldownMs` (bzw. `Retry-After` Header) gebannt und der nächste Account im selben Request probiert.
* **Fallback:** Sind alle Profile im Cooldown oder failen, wird transparent auf `Bearer public` gewechselt — Free-Modelle funktionieren also selbst ohne Keys.
* **Legacy kompatibel:** `apiKeyEnvs` / `apiKeyEnv` werden automatisch nach `profiles` migriert (ein Profil je Env).

Status wird beim Bootstrap geloggt und via `AccountPool.status(profiles)` verfügbar.

---

## Aktuell live verifiziert (2026-09-12)

`GET https://opencode.ai/zen/v1/models` mit `Bearer public`:

```
big-pickle                          -> chat      200k ctx / 32k out
deepseek-v4-flash-free              -> chat      200k ctx /128k out
muse-spark-1.3-contributor-free     -> responses 1M   ctx /131k out  (OpenAI Responses API!)
muse-spark-1.2-contributor-free     -> responses 1M   ctx /131k out
mimo-v2.5-free                      -> chat      200k ctx / 32k out
ling-3.0-flash-fin-free             -> chat      262k ctx / 32k out
nemotron-3-ultra-free               -> chat        1M ctx /128k out
nemotron-3.5-lightning-free         -> chat      262k ctx / 32k out
```

Alle 31 `models.dev` Free-Modelle (u.a. `glm-5-free`, `kimi-k2.5-free`, `qwen3.6-plus-free` (messages!), `ring-2.6-1t-free`, `grok-code` (responses) …) sind bereits im Plugin hinterlegt und werden automatisch aktiv, sobald OpenCode sie wieder in `/v1/models` listet — **ohne Plugin-Update**.

---

## Installation

```bash
# via DSH CLI
dsh plugin --profile web add dsh-opencode-zen-free
# oder lokal
dsh plugin --profile web add /workspaces/OpenCode-Zen-2-dsh
# danach DSH neu starten — Provider "OpenCode Zen (Free)" erscheint im Model-Picker
```

---

## Konfiguration

### Minimal (Zero-Config, komplett kostenlos, sofort nutzbar)

```yaml
# ~/.dsh/settings.yaml
agent-default-model:
  provider: opencode-zen-free
  model: mimo-v2.5-free
  reasoningEffort: high
# keine Credentials nötig -> Bootstrap nutzt Bearer public und die 31 Free-Modelle sind sofort da
```

### Mit Profilen (empfohlen für höhere Limits)

```yaml
# 1. Keys in Credentials hinterlegen (Settings → Credentials oder settings.yaml)
llm-credentials:
  OPENCODE_API_KEY: "sk-..."        # Account 1
  OPENCODE_API_KEY_2: "sk-..."      # Account 2
  OPENCODE_TEAM_KEY: "sk-..."       # Account 3

# 2. Profile im Plugin anlegen
opencode-zen-free:
  eagerBootstrap: true              # alle Free-Modelle bei Start abfragen (empfohlen)
  bootstrapTimeoutMs: 15000
  catalogTtlMs: 600000              # Refresh alle 10min
  profiles:
    - name: "Privat"
      apiKeyEnv: OPENCODE_API_KEY
      enabled: true
    - name: "Zweitaccount"
      apiKeyEnv: OPENCODE_API_KEY_2
      enabled: true
    - name: "Team"
      apiKeyEnv: OPENCODE_TEAM_KEY
      enabled: true
  # Tuning
  unavailableCooldownMs: 1800000    # Modell-Ban 30min nach AUTH/unavailable
  accountCooldownMs: 60000          # Account-Ban 60s nach 429
  streamIdleTimeoutMs: 300000       # Idle-Watchdog 5min
```

**Ein Profil hinzufügen:** Einfach einen neuen Eintrag unter `profiles:` ergänzen + den Key unter `llm-credentials:` hinterlegen — beim nächsten DSH-Start oder Hot-Reload erscheint das Profil sofort im Bootstrap-Log und in der Rotation.

**Profil deaktivieren:** `enabled: false` setzen — wird aus der Rotation genommen, bleibt aber konfiguriert.

**Profil entfernen:** Eintrag löschen.

#### Legacy (weiter unterstützt)

```yaml
opencode-zen-free:
  apiKeyEnvs: [OPENCODE_API_KEY, OPENCODE_API_KEY_2]  # -> wird zu 2 Profilen
  # oder
  apiKeyEnv: OPENCODE_API_KEY                         # -> 1 Profil
```

### Vollständiges Schema

```yaml
opencode-zen-free:
  baseURL: https://opencode.ai/zen/v1
  modelsDevUrl: https://models.dev/api.json
  docsUrl: https://opencode.ai/docs/zen
  eagerBootstrap: true
  bootstrapTimeoutMs: 15000
  profiles: [{name, apiKeyEnv, enabled}]
  models: [{id, name, contextWindow, maxTokens, reasoning, defaultEffort, endpoint}]
  dynamicCatalog: true
  catalogTtlMs: 600000
  unavailableCooldownMs: 1800000
  accountCooldownMs: 60000
  streamIdleTimeoutMs: 300000
  retryPolicy: { ... } # DSH RetryPolicySchema
```

---

## Endpunkte & Protokolle

| Endpunkt | Wire | Modelle (Beispiele) | Translator |
|---|---|---|---|
| `https://opencode.ai/zen/v1/chat/completions` | `openai-completions` SSE | `big-pickle`, `mimo-*`, `ling-*`, `nemotron-*`, `deepseek-*`, `glm-*`, `minimax-*`, `kimi-*` | `translateChat` |
| `https://opencode.ai/zen/v1/responses` | `openai` SSE `event: response.*` | `muse-spark-1.3-contributor-free`, `grok-code`, `gpt-5.*` | `translateResponses` |
| `https://opencode.ai/zen/v1/messages` | `anthropic` SSE `content_block_delta` | `qwen3.6-plus-free`, `claude-*` | `translateAnthropic` |
| `https://opencode.ai/zen/v1/models/gemini-*` | `google` | `gemini-*` | `translateChat` |

Die Endpoint-Zuordnung kommt beim Bootstrap direkt aus der Doku-Tabelle (69 Einträge) und wird pro Modell gespeichert — neue `-free` Modelle werden per Heuristik korrekt geroutet, falls sie noch nicht in der Doku stehen.

Weitere Details: `reasoning_content`/`reasoning_details` → `reasoning-delta`, Tool-Calls, `usage`, fehlendes `finish_reason`/`[DONE]` tolerant, `idleWatchdog` 300s, `User-Agent: opencode/...` + `x-opencode-*` disguise.

---

## Troubleshooting

* `429 FreeUsageLimitError` → IP-Quota erschöpft → weiteres Profil hinzufügen oder warten (die anderen Profile rotieren automatisch).
* `401/403` → Key ungültig/Region → Profil-Ban, nächstes Profil wird probiert; Modell-Ban 30min.
* Stream hängt → `TIMEOUT` nach `streamIdleTimeoutMs`, DSH Retry greift.
* `Stream ended without finish_reason` → automatisch als `stop` gewertet.
* Bilder → `UNSUPPORTED_CONTENT`.

---

## Lizenz

MIT
