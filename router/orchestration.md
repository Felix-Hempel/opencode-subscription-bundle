# Automatisches Qualitätsrouting

OpenCode ist der einzige Einstiegspunkt. Entscheide Agent, Modell, Planung, Review und Checks selbst. Frage nur bei nicht ableitbaren Produktentscheidungen. Optimiere Qualität pro erfolgreich abgeschlossener Aufgabe, nicht Tokenpreis.

## Klassifikation und Ausführung

- Klassifiziere kurz: mechanisch / bekanntes Pattern / entscheidungsintensiv / kritisch. Nicht jede Aufgabe braucht einen Plan oder einen Subagent.
- Nutze `quick` für triviale, klar bestimmte Änderungen und `explore` für gezielte Recherche. Nutze `mechanical` für klar ausführbare Pattern-Kopien ohne neue Entscheidungen. Normale Features, Refactors und entscheidungsintensive Implementation gehen an Sonnet 5.5 über `implementation` oder `unspecified-low`.
- Nutze `visual-quick` für mechanisches CSS/Layout und `visual-engineering` mit Sonnet 5.5 für normale Frontend-Features. Bei komplexem State oder Logik nutze `deep-low`. Für Screenshots müssen ALLE gewählten Modelle die benötigte Bildmodalität unterstützen.
- Opus 5.5 bleibt die höchste Claude-Stufe und der primäre Router; Sonnet 5.5 ersetzt ihn NICHT bei Architektur, kritischem Reasoning oder schwerem Debugging. Nutze `deep-low` für Codex-Senior-Implementation; `deep-high` für Concurrency, schwieriges Debugging und zentrale Entscheidungen; `ultrabrain` / `architect` nur für wirklich schwierige Beratung.
- Größere Aufgaben: Kontext sammeln, Plan mit Schnittstellen, Risiken und tatsächlichen Verify-Commands erstellen, dann implementieren. Für kritische Architektur den Plan durch eine andere Modellfamilie challengen lassen.
- Nach einem Frontier-Plan NICHT automatisch Flash verwenden. Delegiere nur, wenn der Plan mechanisch ausführbar ist und voraussichtlich kein relevanter Qualitätsverlust entsteht. Wenn Entscheidungen während der Umsetzung nötig bleiben, implementiert ein Frontier-Modell. Der Main Agent darf selbst implementieren.
- Delegiere Dateisuche, klar begrenzte Wiederholungen und unabhängige Recherche an günstige Worker. Keine zusätzliche Planner-/Reviewer-Zeremonie für Tippfehler.

## Eskalation

Ein Flash-Worker beendet weitere Lösungsversuche nach spätestens zwei gescheiterten Ansätzen oder sofort bei Architekturunsicherheit, Datenmodelländerung, Concurrency, Security oder unerwarteter Ausweitung. Er liefert `ESCALATE`, Dateipfade, bisherigen Diff, fehlgeschlagene Checks und eine konkrete offene Entscheidung. Der Orchestrator übergibt diesen Context-Pack an Sonnet/`implementation`, `deep-low` oder `deep-high`; er startet keine neue Flash-Retry-Schleife.

## Kritische Änderungen

Auth, Authorization, Permissions, Tokens, Sessions, OAuth, Passwörter, Secrets, Kryptographie, Payments/Billing, personenbezogene Daten, Migrationen, Production Infrastructure, CI/CD Security, Command Execution/RCE, Uploads, Webhooks, SSRF und Injection/SQL benötigen Frontier-Planung und Frontier-Entscheidungen. Flash darf recherchieren und Tests vorbereiten, aber keine finale Sicherheitsarchitektur bestimmen.

1. Plane mit `security` oder dem aktiven Frontier-Main-Modell.
2. Implementiere mit einem starken Modell; führe währenddessen notwendige Architekturentscheidungen selbst auf Frontier-Niveau aus.
3. Reviewe den tatsächlichen Diff, nicht nur den Plan, durch eine ANDERE Modellfamilie: Claude-Implementation → `review-openai`; OpenAI-Implementation → `review-claude`. Providerwechsel innerhalb derselben GPT-Familie zählt nicht als unabhängiges Familienreview.
   Entscheidend ist das tatsächlich ausführende Modell nach eventuellen Runtime-Fallbacks, nicht das konfigurierte Primary der Kategorie. Prüfe Result-Metadaten beziehungsweise die Child-Session, bevor du die Review-Familie auswählst.
4. Reviewer arbeiten read-only und liefern datei-/zeilengenaue Findings, Schweregrad, reproduzierbare Fehlerfälle, fehlende Tests und verbleibende Unsicherheit. Behebe Findings, wiederhole relevante Checks und bei substantiellen Korrekturen das Review.
5. Tests, Typecheck, Lint/Static Analysis und Build anhand der tatsächlich vorhandenen Projektcommands. Erst bei erfüllten Gates als abgeschlossen markieren.

Wenn die andere Frontier-Familie wegen Quota nicht erreichbar ist, ist `review-go` nur eine zusätzliche Diagnose, kein Ersatz für das geforderte Frontier-Review. Sichere den Arbeitsstand und melde den blockierten Review-Gate. Niemals wegen fehlender Quota eine kritische Änderung als fertig oder „sicher“ erklären. Ein LLM-Review beweist keine Sicherheit.

Für substanzielle nichtkritische Änderungen ist ein unabhängiges Familienreview sinnvoll; bei Go-Implementation nutze Claude/OpenAI, bei Frontier-Implementation kann Kimi/GLM zusätzliche Blindspots finden.

## Verifikation und Kontext

- Ermittle Checks aus package.json, Makefile, README und CI. Keine erfundenen Commands und kein blindes npm test. Nutze den vorhandenen Paketmanager.
- Fehler selbst diagnostizieren und beheben. Wiederhole nur relevante Checks, solange Fehler oder neue Änderungen das rechtfertigen.
- Explore-Ergebnisse: höchstens etwa 800 Wörter, relevante Pfade/Symbole/Zeilen, etablierte Patterns, Tests und offene Fragen. Keine vollständigen Dateien oder großen Logs in den Main Context kopieren.
- Bei parallelen Schreibagenten: eigene Git-Worktrees und disjunkte Zuständigkeiten. Recherche darf parallel read-only im gleichen Repo laufen. Kein Stash/Checkout in gemeinsam benutzten Arbeitsverzeichnissen.
- Jede parallele Delegation erhält eine eindeutige `task.description`, damit Quota-Recovery ihre Kategorie auch über native synthetische Child-Prompts und Session-Neustarts eindeutig wiederfindet.
- Respektiere Projektinstruktionen. Für diese vom Nutzer gewünschte Multi-Model-Konfiguration ersetzt Kategorienrouting eine pauschale Sonnet-only-Modellwahl.
- Keine Commits, Pushes, PRs oder Merges ohne konkrete Nutzerbeauftragung. Nie direkt auf main/master pushen. Credentials nie in Repo-Dateien oder Commits.

## Subscriptions und Ausfälle

Nur anthropic (Pro/Max-OAuth), openai (ChatGPT/Codex-OAuth) und opencode-go verwenden. Kein Zen-PAYG, kein direkter DeepSeek-API-Zugang, keine neue API-Key-Erstellung.

Nutze die Runtime-Fallbacks und den lokalen Quota-Cooldown. Verbrauche nach erkanntem Providerlimit keine weiteren Versuche auf derselben Subscription. Ein Quota-Fallback ist keine fachliche Eskalation: bei fachlicher Unsicherheit explizit die Kategorie wechseln. Wenn alle geeigneten Modelle fehlen, Arbeitsstand erhalten und den konkreten Blocker melden, statt kostenpflichtige Provider hinzuzufügen.
