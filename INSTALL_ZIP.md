# Installation via ZIP (DSH Desktop direkt)

Diese Datei liegt als `/workspaces/dsh-opencode-zen-free-v1.1.0.zip` (flat, package.json am ZIP-Root) bereit — exakt das Format, das DSH Desktop beim "Aus Datei installieren" / Drag & Drop erwartet.

## Variante A — ZIP Drag & Drop (empfohlen für Desktop-GUI)

1. Lade `dsh-opencode-zen-free-v1.1.0.zip` herunter (liegt im Repo-Root, siehe Release-Asset / file browser).
2. Öffne **DSH Desktop → Einstellungen → Plugins** (oder **Settings → Plugin Market → Install from file**).
3. Ziehe die `*.zip` per Drag & Drop auf das Fenster **oder** klicke `Aus Datei installieren` und wähle die ZIP.
4. DSH extrahiert, liest `package.json` + `cordis.patch.yml` (`dsh.bundle.patch: ./cordis.patch.yml`) und registriert den Provider `opencode-zen-free`.
5. **DSH neu starten** (oder `Dienst neu laden`) — danach erscheint **OpenCode Zen (Free)** im Model-Picker mit allen ~31 Free-Modellen sofort nutzbar.

ZIP-Inhalt (flat):
```
lib/index.js       # Eager Bootstrap + 3 Translatoren + Profile-MultiAccount
package.json       # name: dsh-opencode-zen-free, dsh.bundle.patch: ./cordis.patch.yml
cordis.patch.yml   # - insert: id: opencode-zen-free
README.md
LICENSE
```

## Variante B — CLI mit TGZ (identisch zu ZIP, für `dsh plugin add`)

```bash
dsh plugin --profile web add ./dsh-opencode-zen-free-1.1.0.tgz
# oder via ZIP
dsh plugin --profile web add ./dsh-opencode-zen-free-v1.1.0.zip
# Danach:
dsh restart # bzw. DSH Desktop neu starten
```

Verify nach Installation: Model-Picker → `opencode-zen-free` → z. B. `mimo-v2.5-free`, `big-pickle`, `muse-spark-1.3-contributor-free` (Responses-API) direkt chatten — kein API-Key nötig; weitere Profile unter `opencode-zen-free.profiles` in Settings hinzufügen.

## Varianten im Workspace

- `/workspaces/dsh-opencode-zen-free-v1.1.0.zip` — **flat** (empfohlen für Desktop-GUI)
- `/workspaces/dsh-opencode-zen-free-v1.1.0-folder.zip` — **mit Ordner** `dsh-opencode-zen-free/…` (falls Entpacker einen Ordner erwartet)
- `/workspaces/dsh-opencode-zen-free-1.1.0.tgz` / `.../OpenCode-Zen-2-dsh/dsh-opencode-zen-free-1.1.0.tgz` — npm pack TGZ (kanonisch für CLI)
