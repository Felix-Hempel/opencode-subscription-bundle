# OpenCode Subscription Bundle

Portable **Komposition, kein Fork**: OpenCode **1.18.34**, OmO
**oh-my-openagent@5.1.7**, Anthropic-Auth
**@ex-machina/opencode-anthropic-auth@1.8.6** und eine lokale Routing-Schicht.
Keine Tokens, kein Modellkatalog, keine persönliche Host-Konfiguration enthalten.
Lizenzen: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); MIT gilt nur für eigene Glue-Dateien.

**Status: Draft.** Die Implementierung liegt auf `feat/portable-bundle` und in
[PR #1](https://github.com/Felix-Hempel/opencode-subscription-bundle/pull/1).
Der unabhängige Security-Review ist blockiert; keine Produktionsfreigabe.

## Risiken und Grenzen

- Jeder Nutzer authentifiziert **seine eigenen Abonnements**. Keine fremden
  Accounts, keine geteilten Tokens. Import nur auf selbst kontrollierte Rechner.
- Das Anthropic-Plugin ist **nicht offiziell unterstützt** und warnt vor
  **ToS-Verstößen und Kontosperren**. Intensive Agent-Loops können Sperren
  auslösen. Auch geringe Parallelität ist keine Garantie.
- **Keine Abrechnungs- oder Kostenfreiheit-Garantie.** Extra Usage/Overages bei
  jedem Anbieter separat deaktivieren; Kontoeinstellungen kontrollieren. Router
  und Importer ersetzen keine serverseitigen Billing-Einstellungen.
- Nur `anthropic`, `openai`, `opencode-go`; Claude/OpenAI ausschließlich OAuth.
  Kein Zen/PAYG-Fallback. Go benötigt den eigenen Go-Zugang; dessen API-Key ist
  kein Anthropic-/OpenAI-API-Key. Modellverfügbarkeit hängt von Plan und Region ab.
- Der Container darf den explizit eingebundenen Workspace verändern und nutzt
  Netzwerkzugriff für Anbieter und gepinnte Plugins. Kein Sandbox-Versprechen.
  Projektspezifische OpenCode-Konfigurationen im Workspace können zusätzliche
  Plugins laden: nur vertrauenswürdige Workspaces einbinden.

## Container starten

Voraussetzungen: Docker Engine/Desktop mit Compose v2; Workspace muss UID/GID
**10001:10001** Schreibzugriff erlauben (Linux-Dateirechte gegebenenfalls vorher
gezielt anpassen). Kein Port, Docker-Socket oder Host-HOME wird eingebunden.

```sh
git clone --branch feat/portable-bundle https://github.com/Felix-Hempel/opencode-subscription-bundle.git
cd opencode-subscription-bundle
docker compose build
WORKSPACE=/absoluter/pfad/zum/projekt docker compose run --rm opencode
```

Ohne `WORKSPACE` ist `${WORKSPACE:-.}` das aktuelle Bundle-Verzeichnis. Ein
eigenes benanntes Volume persistiert `/home/opencode`, inklusive Auth, Sessions,
Plugin-Cache und Cooldowns. Der CLI-Prozess läuft nicht als root. Der
Entrypoint seedet nur fehlende Konfigurationsdateien. Ein Image-Update ersetzt
**keine** vorhandene Volume-Konfiguration; Änderungen bewusst übernehmen und CLI
neu starten. `docker compose down -v` löscht das isolierte HOME einschließlich Auth.

Der offizielle Tag `ghcr.io/anomalyco/opencode:1.18.34` wurde hier nicht bestätigt.
Deshalb installiert das Dockerfile das exakte Registry-Paket
`opencode-ai@1.18.34` auf `oven/bun:1.4.2` und prüft beim Build die CLI-Version.
Keine Curl-Pipe, kein `latest`, kein automatisches CLI-Update. Paketinstallation
setzt Vertrauen in Registry/Upstream voraus; kein zusätzlicher Supply-Chain-Beweis.
Docker ist lokal nicht verfügbar. GitHub Actions prüft Container-Build,
CLI-Version, Non-root-Ausführung, persistentes HOME, Konfigurations-/Plugin-Start
und Offline-Tests. **Live-Login ist nicht getestet**. Native Install-/Run-Skripte werden bewusst
nicht angeboten, damit feste `/home/opencode`-Pfade keine Host-Installation verändern.

## Eigene Abonnements anmelden

```sh
docker compose run --rm opencode auth login
```

Im Dialog nacheinander Anthropic (OAuth), OpenAI (ChatGPT/Codex-OAuth) und
OpenCode Go anmelden. Keine Anthropic-/OpenAI-API-Abrechnung auswählen.
Falls Headless-OAuth einen Callback benötigt: vom Anbieter angebotenen
Code-/Device-Flow oder den nachfolgenden Import verwenden; es werden absichtlich
keine Callback-Ports veröffentlicht. Keine Zugangsdaten als Umgebungsvariable.

## Sicherer Import auf einen Server

Der Importer erstellt einmalig
`TARGET_HOME/.local/share/opencode/auth.json`. Quelle und vorhandenes Ziel
müssen reguläre Nicht-Symlink-Dateien sein; **jedes vorhandene Ziel wird abgelehnt**,
auch eine valide Datei. Kein Merge, keine Überschreibung. Home muss explizit
absolut sein und darf weder `/` noch das HOME des aufrufenden Prozesses sein.
Symlinks in Zielverzeichnissen werden abgelehnt. Verzeichnisse erhalten `0700`,
Datei `0600`. Nur folgende exakten Einträge sind zulässig:

- `anthropic` / `openai`: `type: "oauth"`, nichtleere Strings `refresh`, `access`,
  endliche nichtnegative Ganzzahl `expires`; optional Strings `accountId`, `enterpriseUrl`.
- `opencode-go`: `type: "api"`, nichtleerer String `key`; optional `metadata`
  als Objekt ausschließlich mit String-Werten.
- Andere Provider oder zusätzliche Felder: Fehler. Mindestens ein Provider.
  Werte werden nie ausgegeben, auch nicht bei ungültigem JSON.

Transport ist Aufgabe des Nutzers. Folgende Befehle nutzen vorhandene GPG-/SSH-
Werkzeuge und bestehende Schlüssel; **keine eigene Kryptographie**. Platzhalter
`USER@SERVER` und `EMPFÄNGER-FINGERPRINT` ersetzen. Nur den eigenen Auth-Export
verwenden. Falls er weitere Provider enthält, zuerst selbst einen separaten
Export ausschließlich der drei erlaubten Provider erstellen, ohne Tokens zu loggen.

Auf dem Quellrechner, außerhalb des Repositorys:

```sh
umask 077
gpg --encrypt --recipient 'EMPFÄNGER-FINGERPRINT' \
  --output /tmp/opencode-auth-transfer.gpg \
  "$HOME/.local/share/opencode/auth.json"
ssh USER@SERVER 'umask 077; mkdir -p "$HOME/opencode-transfer"; chmod 700 "$HOME/opencode-transfer"'
scp /tmp/opencode-auth-transfer.gpg USER@SERVER:opencode-transfer/auth.json.gpg
rm /tmp/opencode-auth-transfer.gpg
```

Auf dem Server (Empfänger-Schlüssel muss bereits vorhanden sein):

```sh
umask 077
gpg --decrypt --output "$HOME/opencode-transfer/auth.json" \
  "$HOME/opencode-transfer/auth.json.gpg"
cd /pfad/zum/opencode-subscription-bundle
docker compose build
docker compose run --rm --entrypoint bun -e HOME=/tmp/import-caller \
  -v "$HOME/opencode-transfer:/transfer:ro" opencode \
  /opt/bundle/scripts/import-auth.mjs \
  --source /transfer/auth.json --target-home /home/opencode
rm "$HOME/opencode-transfer/auth.json" "$HOME/opencode-transfer/auth.json.gpg"
WORKSPACE=/absoluter/projektpfad docker compose run --rm opencode
```

Das reguläre Container-HOME ist auch das aufrufende HOME: der Importer verweigert
es deshalb ohne Ausnahme. Der Importaufruf verwendet ein anderes aufrufendes
HOME (`/tmp/import-caller`), ohne das isolierte Ziel `/home/opencode` zu ändern.

Auf Linux muss UID 10001 die Transferdatei lesen können; sie bleibt `0600`.
Bei abweichender Server-UID gezielt Eigentümer der Transferdatei/des Verzeichnisses
anpassen, nicht Leserechte für alle öffnen. Import nur bei gestoppter CLI und ohne
andere schreibende Prozesse im Ziel-HOME ausführen. Wiederholte/gleichzeitige
Importer werden durch exklusives Publizieren ohne Überschreiben abgewiesen.
Temporäre Dateien enthalten Tokens und liegen ausschließlich im privaten
Ziel-Datenverzeichnis. Sichere Backups/Volume-Snapshots ebenfalls wie Credentials.
OAuth-Refresh kann den ursprünglichen Login ungültig machen; bei Problemen neu
authentifizieren. `rm` garantiert auf SSDs keine physische Löschung.

Direkter CLI-Test mit Bun (kein nativer OpenCode-Installer):

```sh
bun scripts/import-auth.mjs --source /absolut/eigener-export.json \
  --target-home /absolut/isoliertes-home
```

## Modellrollen und Routing

Die vollständige Konfiguration steht in `config/omo.jsonc` (11 Agents,
16 aktive Kategorien plus deaktiviertes `artistry`). Kein generierter Katalog.
Die folgenden Primaries sind Rollen, **keine Verfügbarkeitsgarantie**:

| Rolle / Kategorie | Primary | Aufgabe |
| --- | --- | --- |
| sisyphus, prometheus, atlas | Claude Opus 5.5 | Orchestrierung, Planung, Ausführung |
| hephaestus, deep-low | GPT 6.1 Sol | Senior-Implementation |
| oracle, momus, ultrabrain, architect | GPT 6 Astra | Beratung, Challenge, schweres Reasoning |
| metis | Claude Opus 5.5 | Planprüfung |
| sisyphus-junior, implementation, unspecified-low | Claude Sonnet 5.5 | Normale Features/Refactors |
| visual-engineering | Claude Sonnet 5.5 | UI-Features |
| deep-high, unspecified-high, security | Claude Opus 5.5 | Architektur/Concurrency/Security |
| review-openai | GPT 6 Astra | Unabhängiges Review nach Claude |
| review-claude | Claude Opus 5.5 | Unabhängiges Review nach OpenAI |
| review-go | Kimi K3 | Zusätzliche Diagnose, kein Security-Review-Ersatz |
| explore, librarian | MiMo v2.6 Flash | Read-only Suche/Quellen |
| multimodal-looker | GLM 5.3 Flash | Bild-/Dokumentanalyse |
| quick, mechanical, visual-quick, writing | GLM 5.3 Flash | Mechanik, Layout, Texte |

Alle Fallback-Reihenfolgen und Reasoning-Stufen sind unverändert enthalten.
Opus fällt typischerweise auf Sol/Astra und dann starke Go-Modelle zurück;
Sonnet auf Sol/weitere Frontier- oder Go-Modelle. Review-Familien bleiben strikt
getrennt. GPT 5.6 Sol, DeepSeek v4.1 Flash/v4 Pro, Luna, Qwen und Haiku bleiben
als konfigurierte Fallbacks erhalten. Unbekannte Kategorien scheitern geschlossen.
`deep` wird kompatibel als `deep-low` behandelt.

Router nutzt nur verbundene, im Runtime-Katalog verfügbare Modelle und benötigte
Input-Modalitäten. Account-Quota sperrt den Provider; eindeutig modellbezogene
Go-Quota nur das Modell. Reset-/Retry-Header steuern Cooldowns; Events persistieren
isoliert im Volume. OmO-Runtime-Recovery bleibt aktiv, der Normalizer übersetzt
Regions-/Quota-/OAuth-Fehler in dessen erwartete Textklassifikationen. Keine
heimliche PAYG-Ausweichroute. Bei vollständiger Erschöpfung: Arbeitsstand erhalten.

## Lokale Verifikation ohne Accounts

```sh
bun run verify
```

`test`: synthetische Router- und Importer-Tests ausschließlich in OS-Tempdirs.
`lint`: offline Bun-Syntaxprüfung, JSONC-/Routing-/Pin-/Pfad-Prüfung und Shell-
Syntaxprüfung; kein umfassender ESLint/Biome-Ersatz. Keine Produktions-Auth gelesen,
kein Netzwerk-/Live-Modelltest. Für echte Deployments zusätzlich Container bauen,
Version prüfen und mit eigenen Accounts testen. **Security-Review-Gate blockiert:**
Der unabhängige Claude-Familienreview scheiterte am Providerlimit/Timeout.
Der Draft-PR ist keine Produktionsfreigabe und wird nicht automatisch gemergt;
vor produktiver Nutzung muss der Review nachgeholt werden. Unit-Tests beweisen
keine Sicherheit.
