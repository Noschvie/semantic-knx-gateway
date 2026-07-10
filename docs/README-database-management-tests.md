# Database Management API - Test Suite

## Übersicht

Dieses Skript testet alle Endpoints der **Database Management API (Phase 1 & 2)**:

- `GET /api/v2/database/health` - Health Check
- `GET /api/v2/database/info` - Datenbankstatistiken
- `GET /api/v2/database/cleanup-jobs` - Audit Log
- `POST /api/v2/database/purge` - Event-Löschung
- `POST /api/v2/database/optimize` - VACUUM Operationen

## Verwendung

### Voraussetzungen

- Die KNX IoT Gateway API läuft auf `http://localhost:3000`
- `curl` und `jq` sind installiert
- Bash 4.0+

### Ausführung

```bash
cd semantic-knx-gateway
chmod +x scripts/test-database-management-api.sh
./scripts/test-database-management-api.sh
```

## Operationelles Impact

| Operation | Blockiert? | Grund |
|-----------|-----------|-------|
| `GET /health` | ❌ Nein | Read-only Query |
| `GET /info` | ❌ Nein | Read-only Query |
| `GET /cleanup-jobs` | ❌ Nein | Read-only Query |
| `POST /purge (Dry-Run)` | ❌ Nein | Read-only Preview |
| `POST /purge (Execute)` | ⚠️ Minimal | Row-level Locks, kurze Dauer |
| `POST /optimize (full=false)` | ❌ Nein | VACUUM ANALYZE läuft parallel |
| `POST /optimize (full=true)` | 🔴 **JA!** | **Exklusiver Lock - App geht offline** |

## Test-Ablauf

### Step 1: Health Check
```
GET /health
```
- Keine Authentifizierung erforderlich
- Testet Datenbankverbindung

### Step 2: OAuth Token
```
POST /oauth/access
  - grant_type: client_credentials
  - scope: read,delete:database
```
- Token mit `delete:database` Scope wird abgerufen
- Erforderlich für alle Protected Endpoints

### Step 3: GET /info
```
GET /info
  (Before Operations)
```
- Zeigt Datenbanksstatistiken vor Operationen
- Datenbankgröße, Tabellensizes, Event-Timeline

### Step 4: GET /cleanup-jobs
```
GET /cleanup-jobs
  (Before Operations)
```
- Zeigt Audit Log vor Operationen
- Normalerweise leer bei freshstart

### Step 5: POST /purge (Dry-Run)
```
POST /purge
  - preset: 90_days
  - dry_run: true
```
- Preview-Modus
- Zeigt was gelöscht würde, ohne tatsächlich zu löschen

### Step 6: POST /purge (Error-Test)
```
POST /purge
  - preset: 90_days
  - dry_run: false
  - confirm: false
```
- Sollte mit 409 Confirmation Required fehlen
- Testet Sicherheitsmechanismus

### Step 7: POST /optimize
```
POST /optimize
  - full: false (standard)
  - analyze: true
```
- VACUUM ANALYZE im Online-Modus
- **App bleibt online**
- Reclaims Disk Space

### Step 7b: POST /optimize (Optional - VACUUM FULL)
```
POST /optimize
  - full: true
  - analyze: true
```
- **WARNUNG: App geht offline!**
- Nur im Maintenance-Fenster ausführen
- Skript fragt vor Bestätigung

### Step 8: GET /cleanup-jobs (After Operations)
```
GET /cleanup-jobs
  - status: completed
```
- Zeigt ausgeführte Operationen im Audit Log
- Dokumentiert wer, was, wann gemacht hat

### Step 9: GET /info (After Operations)
```
GET /info
  (After Operations)
```
- Vergleich vorher/nachher
- Zeigt Auswirkungen der Operationen

## Sicherheitsfeatures

### OAuth2 Scopes
```
read         - GET Endpoints
delete:database - POST Endpoints (Purge, Optimize)
```

### Destructive Operations Protection
```
POST /purge
  1. dry_run=true  → Preview only
  2. dry_run=false + confirm=true → Execute
```

### Audit Logging
```
Alle Operationen werden in database_maintenance_log geloggt:
  - Operation (purge/optimize)
  - Status (running/completed/failed)
  - Timestamps
  - Results (JSON)
  - executed_by (OAuth ClientId)
```

## Häufig Gestellte Fragen

### Kann die App während der Tests laufen?
**Ja!** Der Standard-Test verwendet:
- Read-only Operationen (GET)
- Purge mit Row-Level Locks (kurze Dauer)
- VACUUM ANALYZE online-Mode

Nur VACUUM FULL (optional) erfordert Downtime.

### Was ist der Unterschied zwischen VACUUM und VACUUM FULL?
```
VACUUM ANALYZE (full=false)
  ✅ Online (App läuft)
  ✅ Schnell
  ✅ Update Query Planner Stats
  ⚠️ Reclaims weniger Speicher

VACUUM FULL (full=true)
  🔴 Offline (App blockiert)
  ⏱️ Langsam (abhängig von DB-Größe)
  ✅ Reclaims maximaler Speicher
  ✅ Defragmentiert komplett
```

### Wie oft sollte ich diese Tests ausführen?
- **Health Check**: Täglich (Monitoring)
- **Info/Cleanup-Jobs**: Wöchentlich (Audit-Review)
- **Purge**: Nach Bedarf (Retention Policy)
- **Optimize**: Monatlich (Wartung)
- **VACUUM FULL**: Halbjährlich (Maintenance Window)

## Troubleshooting

### "❌ Failed to obtain token"
- OAuth-Service läuft nicht
- Client-Credentials falsch
- Check: `curl http://localhost:3000/oauth/access -X POST ...`

### "401 Unauthorized"
- Token ist abgelaufen
- Scopes reichen nicht aus
- Bearer Header falsch

### "409 Confirmation Required"
- Purge benötigt `confirm=true`
- Sicherheitsmechanismus funktioniert korrekt

### "Timeout bei VACUUM FULL"
- Normale Behavior - DB ist größer als erwartet
- Nur in Maintenance Window ausführen

## Weitere Ressourcen

- Dokumentation: `docs/DATABASE_MANAGEMENT.md`
- API Spec: `docs/knxiot_api_openapi.yaml`
- Code: `src/storage/database-manager.js`
