# knx-lens Import-Addon

Addon für [semantic-knx-gateway](https://github.com/Noschvie/semantic-knx-gateway):
importiert historische Telegramme aus [knx-lens](https://github.com/henfri/knx-lens)
Logdateien (`knx_bus.log` + rotierte `.zip`-Archive) als Hintergrund-Job in
die bestehende Event-Historie (`knx_events`, TimescaleDB).

## Installation

1. Dateien in den Projektbaum kopieren:
   ```
   src/import/knx-lens-parser.js
   src/import/knx-lens-importer.js
   src/import/import-job-store.js
   src/api/routes/import.js
   ```
2. Änderungen aus `integration.patch` in `src/api/rest-api.js` und `package.json`
   übernehmen (Router-Import/Mount unter `/api/v2/import`, Dependency `adm-zip`).
3. Dependency installieren:
   ```bash
   npm install
   ```

## Nutzung

### Import starten (Hintergrund-Job)

```bash
curl -X POST https://<host>/api/v2/import/knx-lens \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"data":{"attributes":{"path":"/var/log/knx-lens","dryRun":false,"deleteExistingForDay":true}}}'
```

Antwort (sofort, 202 Accepted):
```json
{
  "data": {
    "id": "knx-lens-import-1753...-ab12cd",
    "type": "import-job",
    "attributes": {
      "status": "running",
      "logDir": "/var/log/knx-lens",
      "dryRun": false,
      "deleteExistingForDay": true,
      "statusUrl": "/api/v2/import/knx-lens/knx-lens-import-1753...-ab12cd"
    }
  }
}
```

Parameter:
- `path` (erforderlich) – Verzeichnis auf dem Server mit `knx_bus.log` und/oder
  rotierten `knx_bus.log.*.zip` Dateien. Kein Datei-Upload.
- `dryRun` (optional, default `false`) – nur parsen und zählen, nichts in die
  Datenbank schreiben. Zum Gegenprüfen vor dem eigentlichen Import empfohlen.
- `deleteExistingForDay` (optional, default `false`) – löscht vor dem Import
  einer Datei alle bestehenden `knx_events` des jeweiligen Kalendertags
  (lokale Zeit, wie im knx-lens-Log). Macht den Import idempotent bei
  wiederholten Läufen über dieselben Tage. **Nicht nach Group Address
  gefiltert** – ein Re-Import eines Tages ersetzt den gesamten für diesen Tag
  bereits geloggten Bus-Verkehr, nicht nur die im Log enthaltenen GAs. Im
  Dry-Run wird nur gezählt, wie viele Zeilen betroffen wären (kein DELETE).

Authentifizierung: Bearer-Token mit `write`-Scope.

### Fortschritt abfragen

```bash
curl https://<host>/api/v2/import/knx-lens/<jobId> \
  -H "Authorization: Bearer <token>"
```

```json
{
  "data": {
    "attributes": {
      "status": "running",
      "progress": {
        "filesTotal": 100,
        "filesDone": 37,
        "currentFile": "/var/log/knx-lens/knx_bus.log.2026-06-14.zip",
        "totalParsed": 1850,
        "totalImported": 1850,
        "totalSkipped": 0,
        "totalDeleted": 1850
      },
      "result": null,
      "error": null
    }
  }
}
```

`status` ist `running`, `completed` oder `failed`. Bei `completed` steht das
vollständige Ergebnis (Datei-für-Datei-Aufschlüsselung) in `result`, bei
`failed` die Fehlermeldung in `error`.

Authentifizierung: Bearer-Token mit `read`-Scope.

## Architektur

- **`knx-lens-parser.js`** – parst einzelne Logzeilen (Pipe-getrenntes
  Fixed-Width-Format) sowie ganze Log-/ZIP-Dateien. Ignoriert Trennzeilen und
  Startup-Banner automatisch.
- **`knx-lens-importer.js`** – wandelt geparste Telegramme in das von
  `StateEngine.processTelegram()` erwartete Format um und speist sie darüber
  ein. Dadurch landen sie exakt wie live empfangene Telegramme in
  `knx_events` und nutzen automatisch das bereits geladene GA→DPT-Mapping aus
  dem ETS-Projekt. Provenance (Quelldatei, Original-Rohwert) wird im
  `payload`-Feld mitgespeichert.
- **`import-job-store.js`** – einfacher In-Memory Job-Store für den
  asynchronen Lauf. Kein DB-Schema-Change nötig, da der Import ein einmaliger
  Bulk-Vorgang ist, kein wiederkehrender Betriebs-Workflow.
- **`import.js` (Route)** – `POST` startet den Job unawaited im Hintergrund
  und antwortet sofort mit 202; `GET .../:jobId` liefert den aktuellen Stand.

### Bewusste Entscheidung: nicht die TTL/RDF-Semantikschicht

Die TTL/RDF-Schicht (`ttl-loader.js`, `semantic-mapper.js`) bildet die
**Topologie** ab (Gebäude/Raum/Gerät/Funktion aus dem ETS-Projekt), nicht die
Telegramm-Historie. Historische Telegramme gehören daher in `knx_events`
(TimescaleDB) über den bestehenden `StateEngine`-Pfad – genau wie
live empfangene Telegramme auch.

## Bekannte Einschränkungen

1. **Job-Status ist in-memory**: geht bei einem Server-Neustart verloren.
   Für einen einmaligen historischen Import akzeptabel. Falls Import-Jobs
   künftig routinemäßig laufen sollen, auf ein DB-gestütztes Muster wie
   `database_maintenance_log` (siehe `database-manager.js`) umstellen.
2. **Wertgenauigkeit**: Die Werte im knx-lens-Log sind bereits als lesbarer
   String formatiert, nicht die rohen DPT-Bytes. Für einfache numerische DPTs
   (Temperatur, Prozent etc.) verlustfrei, bei komplexeren/zusammengesetzten
   DPTs (z. B. `ControlDimming`) ggf. mit Informationsverlust gegenüber dem
   Original-Telegramm.
3. **Lokale Zeit ohne Zeitzone**: Der knx-lens-Logger schreibt `datetime.now()`
   ohne Zeitzoneninfo. Der Importer interpretiert die Timestamps als lokale
   Zeit der Maschine, auf der er läuft.
4. **Duplikat-Schutz ist opt-in, nicht automatisch**: Ohne
   `deleteExistingForDay: true` erzeugt ein wiederholter Import derselben
   Logdatei erneut Events in `knx_events`. Mit dem Flag wird pro Datei der
   gesamte Kalendertag ersetzt (siehe oben) – das schützt vor Duplikaten,
   löscht aber auch andere Events desselben Tages, die nicht aus diesem
   Import stammen (z. B. bereits live geloggte Telegramme desselben Tages).
5. **Kein Nebenläufigkeits-Schutz**: Es gibt keine Sperre gegen mehrfaches
   gleichzeitiges Starten desselben Imports (z. B. gleicher `path`).

## Nächste Schritte (Vorschlag)

- Job-Status optional in der DB persistieren, falls der Import routinemäßig
  statt einmalig laufen soll
- Live-Tailing als zweite Betriebsart ergänzen, falls später gewünscht
