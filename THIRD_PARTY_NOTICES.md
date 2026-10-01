# Drittanbieter und Lizenzgrenzen

Dieses Repository ist eine **Komposition, kein Fork**. Es enthält keine vendorten
OpenCode-, OmO- oder Auth-Plugin-Quellen. Die lokalen Router und Tests wurden aus
Felix Hempels lokaler Routing-Konfiguration übernommen. Die MIT-Lizenz dieses
Repositories gilt nur für diese eigene Glue-Schicht, Konfiguration, Skripte und
Dokumentation; sie lizenziert keine Upstream-Komponenten um.

| Komponente | Version | Upstream-Lizenz / Quelle |
| --- | --- | --- |
| OpenCode CLI (`opencode-ai`) | 1.18.34 | MIT: https://github.com/anomalyco/opencode/blob/v1.18.34/LICENSE |
| oh-my-openagent (OmO) | 5.1.7 | Sustainable Use License v1.0: https://github.com/code-yeongyu/oh-my-openagent/blob/v5.1.7/LICENSE.md |
| @ex-machina/opencode-anthropic-auth | 1.8.6 | MIT: https://github.com/ex-machina-co/opencode-anthropic-auth/blob/main/LICENSE |
| Bun Container / Runtime | 1.4.2 | https://github.com/oven-sh/bun/blob/bun-v1.4.2/LICENSE.md |

OmO ist **nicht pauschal MIT**. Seine Sustainable Use License schränkt erlaubte
Nutzungen ein; insbesondere Weiterverkauf/Hosting/kommerzielle Einbettung anhand
der konkreten Upstream-Lizenz prüfen. Container enthalten außerdem
Betriebssystempakete (Git, OpenSSH, CA-Zertifikate) unter eigenen Lizenzen.
Upstream-Copyright- und Lizenzdateien der installierten Pakete bleiben erhalten.

Auth-Plugin-Projekt und Risikohinweis:
https://github.com/ex-machina-co/opencode-anthropic-auth
Das nicht offiziell unterstützte Plugin warnt vor Verstößen gegen Anthropic-ToS
und Kontosperren. Diese Komposition schafft keine Anbieterfreigabe.
