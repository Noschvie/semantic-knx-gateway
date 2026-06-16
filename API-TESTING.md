# Semantic KNX Runtime Engine - API Testing Guide

Dieses Dokument enthält alle verfügbaren API-Endpunkte mit Beispiel-Curl-Befehlen zum Testen.

## Basis-URL

```bash
API_URL="http://localhost:3000"
KNX_IOT_API_URL="$API_URL/api/v2"
```

## 🔐 OAuth Quickstart

Die meisten Endpunkte unter `/api/v2/*` sind per Bearer Token geschützt.

```bash
# Read-Token (für GET-Endpoints)
READ_TOKEN=$(curl -s -X POST "$API_URL/oauth/access" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -u 'knx-default-client:change-me-in-production' \
  -d 'grant_type=client_credentials&scope=read' | jq -r '.access_token')

# Manage-Token (für /api/v2/subscriptions)
MANAGE_TOKEN=$(curl -s -X POST "$API_URL/oauth/access" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -u 'knx-default-client:change-me-in-production' \
  -d 'grant_type=client_credentials&scope=manage' | jq -r '.access_token')

# Write-Token (für PUT /api/v2/datapoints*)
WRITE_TOKEN=$(curl -s -X POST "$API_URL/oauth/access" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -u 'knx-default-client:change-me-in-production' \
  -d 'grant_type=client_credentials&scope=write' | jq -r '.access_token')

AUTH_READ="Authorization: Bearer $READ_TOKEN"
AUTH_WRITE="Authorization: Bearer $WRITE_TOKEN"
AUTH_MANAGE="Authorization: Bearer $MANAGE_TOKEN"
```

Beispiele in diesem Dokument ohne Auth-Header funktionieren nur, wenn OAuth deaktiviert ist (`OAUTH_DISABLED=true`, nur für lokale Entwicklung/Tests) oder der Header ergänzt wird.

---

## 🏥 Health & Info Endpoints

### Health Check

Prüft ob die API läuft:

```bash
curl -s $API_URL/health | jq
```

**Erwartete Antwort:**

```json
{
  "status": "ok",
  "timestamp": "23.05.2026, 19:54:44",
  "timestampISO": "2026-05-23T17:54:44.255Z",
  "semantic": false
}
```

### System Info

Gibt Informationen über die Runtime und verfügbare Endpunkte zurück:

```bash
curl -s $API_URL/info | jq
```

**Erwartete Antwort:**

```json
{
  "name": "Semantic KNX Runtime Engine",
  "version": "0.1.0",
  "features": {
    "knxRuntime": true,
    "stateEngine": true,
    "semanticLayer": false,
    "timescaleDB": true,
    "restAPI": true
  },
  "endpoints": {
    "stats": "/api/v2/stats",
    "datapoints": "/api/v2/datapoints",
    "events": "/api/v2/events",
    "devices": "/api/v2/devices",
    "semantic": "/api/v2/semantic"
  }
}
```

---

## 📊 Statistics Endpoints

### General Statistics

Übersicht über alle Datenbank-Statistiken:

```bash
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/stats | jq
```

**Formatierte Ausgabe:**

```bash
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/stats | jq '{
  timestamp,
  events: .counts.events,
  states: .counts.states,
  db_size: .database.size,
  first_event: .eventRange.firstEvent,
  last_event: .eventRange.lastEvent
}'
```

### Event Statistics

Statistiken über Events der letzten X Stunden:

```bash
# Letzte 24 Stunden (Standard)
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/stats/events" | jq

# Letzte Stunde
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/stats/events?hours=1" | jq

# Letzte 7 Tage
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/stats/events?hours=168" | jq
```

**Zusammenfassung anzeigen:**

```bash
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/stats/events?hours=24" | jq '.summary'
```

**Stündliche Verteilung:**

```bash
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/stats/events?hours=24" | jq '.hourly[] | {hour, count}'
```

### State Statistics

Statistiken über aktuelle Zustände:

```bash
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/stats/states | jq
```

**DPT-Verteilung:**

```bash
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/stats/states | jq '.byDpt'
```

### Top Active Datapoints

Die aktivsten Datapoints/Gruppenadressen:

```bash
# Top 20 der letzten 24 Stunden (Standard)
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/stats/top-active" | jq

# Top 10 der letzten Stunde
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/stats/top-active?limit=10&hours=1" | jq

# Top 50 der letzten Woche
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/stats/top-active?limit=50&hours=168" | jq
```

**Nur die Top 5 mit Formatierung:**

```bash
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/stats/top-active?limit=5" | \
  jq -r '.datapoints[] | "\(.ga) - \(.eventCount) events - \(.currentValue)"'
```

---

## 📍 Datapoints Endpoints (v2 – intern)

### Alle Datapoints auflisten

```bash
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/datapoints | jq
```

**Nur IDs und Namen:**

```bash
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/datapoints | \
  jq '.datapoints[] | {datapointId, ga, name}'
```

### Spezifischen Datapoint abrufen

```bash
# Nach Datapoint-ID
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/datapoints/ga-1-5-1 | jq

# Nach Gruppenadresse
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/datapoints?ga=1/5/1" | jq
```

---

## 🌐 KNX IoT 3rd Party API (Spec v2.1.0)

> Basis-Pfad: `/api/v2` – nur verfügbar wenn TTL-Datei geladen

### Discovery

```bash
curl -s $API_URL/.well-known/knx | jq
```

**Erwartete Antwort:**

```json
{
  "data": {
    "id": "...",
    "type": "knxInterface",
    "attributes": {
      "title": "KNX Installation",
      "apiVersion": "2.1.0",
      "endpoints": {
        "datapoints": "/api/v2/datapoints",
        "...": "..."
      },
      "counts": {
        "devices": 42,
        "locations": 15
      }
    }
  }
}
```

---

### Datapoints

> ⚠️ **Hinweis zu eckigen Klammern in der Shell:** Die Parameter `page[number]` und `page[size]` müssen in der Bash **URL-encodiert** werden (`%5B` = `[`, `%5D` = `]`), da die Shell eckige Klammern sonst als Glob-Pattern interpretiert und die Parameter stillschweigend verwirft.

```bash
# Alle Datapoints (JSON:API, paginiert)
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/datapoints | jq

# Mit Paginierung – URL-encoded (empfohlen)
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/datapoints?page%5Bnumber%5D=0&page%5Bsize%5D=50" | jq

# Seite 1 (zweite Seite)
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/datapoints?page%5Bnumber%5D=1&page%5Bsize%5D=50" | jq

# Anzahl und erste GA ausgeben
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/datapoints | \
  jq '{total: .meta.collection.total, first: .data[0].attributes["knx:groupAddress"]}'

# Alle Datapoints – nur Titel + Wert + GA
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/datapoints | \
  jq '.data[] | {id, title: .attributes.title, value: .attributes.value, ga: .attributes["knx:groupAddress"]}'

# Einen spezifischen Datapoint per UUID abrufen
# (UUID zuerst aus der Collection holen)
DPID=$(curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/datapoints | jq -r '.data[0].id')
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/datapoints/$DPID" | jq
```

**Struktur eines Datapoints:**

```json
{
  "data": {
    "id": "550e8400-e29b-4xxx-...",
    "type": "datapoint",
    "attributes": {
      "title": "Büro Licht",
      "readable": true,
      "writable": true,
      "value": "1",
      "valueType": "string",
      "timestamp": "2026-05-26T10:00:00Z",
      "datapointType": ["knx:switch"],
      "knx:groupAddress": 2049
    },
    "meta": {
      "datapointId": "...",
      "ga": "1/5/1",
      "dpt": "1.001"
    }
  }
}
```

> ℹ️ **Hinweis zu `valueType: "object"`:** Bei komplexen DPTs (z.B. `11.001` Datum, `10.001` Uhrzeit) ist `value` ein **JSON-String** (doppelt serialisiert). Zum Parsen:
> ```bash
> curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/datapoints/$DPID" | jq '.data.attributes.value | fromjson'
> ```

---

### Timeseries

```bash
# UUID des ersten Datapoints holen
DPID=$(curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/datapoints | jq -r '.data[0].id')

# Zeitreihe abrufen
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/datapoints/$DPID/timeseries" | jq

# Mit Zeitfilter
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/datapoints/$DPID/timeseries?startTime=2026-05-26T00:00:00Z&limit=100" | jq

# Nur Werte und Timestamps
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/datapoints/$DPID/timeseries" | \
  jq '.data[] | {ts: .attributes.timestamp, val: .attributes.value}'
```

---

### Wert schreiben (PUT)

**Via UUID** (Spec-konform):

```bash
# UUID des Ziel-Datapoints ermitteln
DPID=$(curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/datapoints | \
  jq -r '.data[] | select(.attributes["knx:groupAddress"] == 2049) | .id' | head -1)

# Einschalten (Spec: value immer als String)
curl -s -X PUT $KNX_IOT_API_URL/datapoints \
  -H "$AUTH_WRITE" \
  -H 'Content-Type: application/vnd.api+json' \
  -d "{"data": {"id": "$DPID", "attributes": {"value": "1"}}}" | jq

# Ausschalten
curl -s -X PUT $KNX_IOT_API_URL/datapoints \
  -H "$AUTH_WRITE" \
  -H 'Content-Type: application/vnd.api+json' \
  -d "{"data": {"id": "$DPID", "attributes": {"value": "0"}}}" | jq
```

**Via Gruppenadresse** (Vendor-Extension – `PUT /api/v2/datapoints/by-ga`):

> GA wird über `data.meta.ga` übergeben (JSON:API-konform: `meta` für nicht-standardisierte Felder).

```bash
# Einschalten
curl -s -X PUT "$KNX_IOT_API_URL/datapoints/by-ga" \
  -H "$AUTH_WRITE" \
  -H 'Content-Type: application/vnd.api+json' \
  -d '{
    "data": {
      "type": "datapoint",
      "attributes": { "value": "1" },
      "meta": { "ga": "1/1/114" }
    }
  }' | jq

# Ausschalten
curl -s -X PUT "$KNX_IOT_API_URL/datapoints/by-ga" \
  -H "$AUTH_WRITE" \
  -H 'Content-Type: application/vnd.api+json' \
  -d '{
    "data": {
      "type": "datapoint",
      "attributes": { "value": "0" },
      "meta": { "ga": "1/1/114" }
    }
  }' | jq

# Numerischer Wert (z.B. Dimmer DPT 5.001)
curl -s -X PUT "$KNX_IOT_API_URL/datapoints/by-ga" \
  -H "$AUTH_WRITE" \
  -H 'Content-Type: application/vnd.api+json' \
  -d '{
    "data": {
      "type": "datapoint",
      "attributes": { "value": "75" },
      "meta": { "ga": "1/2/10" }
    }
  }' | jq
```

**Fehlerfall – GA nicht gefunden:**

```bash
curl -s -X PUT "$KNX_IOT_API_URL/datapoints/by-ga" \
  -H "$AUTH_WRITE" \
  -H 'Content-Type: application/vnd.api+json' \
  -d '{"data": {"type": "datapoint", "attributes": {"value": "1"}, "meta": {"ga": "9/9/999"}}}' | jq
# → 404: No datapoint found for group address "9/9/999"
```

---

### Devices

```bash
# Alle Geräte
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/devices | jq

# Anzahl
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/devices | jq '.meta.collection.total'

# Alle Hersteller
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/devices |
  jq '[.data[].attributes.manufacturer] | unique'

# Spezifisches Gerät per UUID
DEVID=$(curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/devices | jq -r '.data[0].id')
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/devices/$DEVID" | jq

# Relationships prüfen – zeigt Link zu Datapoints des Geräts
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/devices/$DEVID" | jq '.data.relationships'

# Datapoints eines Geräts abrufen (--globoff wegen eckiger Klammern in filter[deviceId])
curl -sg --globoff -H "$AUTH_READ" "$KNX_IOT_API_URL/datapoints?filter[deviceId]=$DEVID" | \
  jq '{total: .meta.collection.total, datapoints: [.data[].attributes.title]}'
```

> ⚠️ **Hinweis zu eckigen Klammern:** Gilt auch für `filter[deviceId]` — entweder `--globoff` verwenden oder manuell encodieren (`[` → `%5B`, `]` → `%5D`).

---

### Functions

```bash
# Alle Funktionen
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/functions | jq

# Spezifische Funktion
FNID=$(curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/functions | jq -r '.data[0].id')
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/functions/$FNID" | jq
```

---

### Locations

```bash
# Alle Locations (flach)
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/locations | jq

# Nur Namen und Subtypen
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/locations | \
  jq '.data[] | {id, title: .attributes.title, subtype: .attributes.subtype}'

# Spezifische Location
LOCID=$(curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/locations | jq -r '.data[0].id')
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/locations/$LOCID" | jq

# Child-Locations (z.B. Räume eines Stockwerks)
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/locations/$LOCID/childlocations" | jq

# Parent-Location (z.B. Stockwerk eines Raums)
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/locations/$LOCID/parentlocation" | jq
```

**Gesamte Hierarchie traversieren:**

```bash
# Alle Gebäude (subtype = building)
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/locations | \
  jq '.data[] | select(.attributes.subtype == "building") | {id, title: .attributes.title}'

# Alle Räume
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/locations | \
  jq '.data[] | select(.attributes.subtype == "room") | .attributes.title'

# Alle Stockwerke (subtype = floor)
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/locations | \
  jq '.data[] | select(.attributes.subtype == "floor") | {id, title: .attributes.title}'

# Vollständige Hierarchie: Gebäude → Stockwerke → Räume
BUILDING_ID=$(curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/locations | \
  jq -r '.data[] | select(.attributes.subtype == "building") | .id' | head -1)

# Child-Locations des Gebäudes (Stockwerke)
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/locations/$BUILDING_ID/childlocations" | \
  jq '.data[] | {id, title: .attributes.title, subtype: .attributes.subtype}'

# Für jedes Stockwerk die Räume auflisten (Beispiel: erstes Stockwerk)
FLOOR_ID=$(curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/locations/$BUILDING_ID/childlocations" | \
  jq -r '.data[0].id')

curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/locations/$FLOOR_ID/childlocations" | \
  jq '.data[] | {id, title: .attributes.title}'

# Alle Stockwerke mit ihren Räumen (kompakt)
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/locations/$BUILDING_ID/childlocations" | \
  jq -r '.data[].id' | while read FLOOR_ID; do
    FLOOR_NAME=$(curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/locations/$FLOOR_ID" | \
      jq -r '.data.attributes.title')
    echo "=== $FLOOR_NAME ==="
    curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/locations/$FLOOR_ID/childlocations" | \
      jq -r '.data[] | "  - \(.attributes.title)"'
  done

# Parent-Location eines Raums ermitteln (Beispiel: Wohnen → Erdgeschoss)
ROOM_ID=$(curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/locations | \
  jq -r '.data[] | select(.attributes.title | contains("Wohnen")) | .id')

curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/locations/$ROOM_ID/parentlocation" | \
  jq '{floor: .data.attributes.title, subtype: .data.attributes.subtype}'
# → { "floor": "Erdgeschoss", "subtype": "floor" }

# Location-ID ermitteln (Beispiel: Wohnen)
ROOM_ID=$(curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/locations | \
  jq -r '.data[] | select(.attributes.title | contains("Wohnen")) | .id')

# Datapoints eines Raums abrufen (--globoff wegen eckiger Klammern)
curl -sg --globoff -H "$AUTH_READ" "$KNX_IOT_API_URL/datapoints?filter[locationId]=$ROOM_ID" | \
  jq '{total: .meta.collection.total, datapoints: [.data[] | {title: .attributes.title, ga: .meta.ga, value: .attributes.value}]}'
```


### Installations

```bash
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/installations | jq

# Einzelne Installation
INSTALLATION_ID=$(curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/installations | jq -r '.data[0].id')
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/installations/$INSTALLATION_ID" | jq
```

### Node

```bash
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/node | jq

# Limits und Zeitstempel ausgeben
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/node | \
  jq '.data.attributes | {currentSubscriptions, maxSubscriptions, currentDateTime}'
```

### Sites (Root-Locations)

```bash
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/sites | jq

# Mit Paginierung
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/sites?page%5Bnumber%5D=0&page%5Bsize%5D=10" | jq
```

---

## 🛠️ Test-Script (KNX IoT)

Speichern als `test-knx-iot.sh` und ausführen mit:

```bash
chmod +x test-knx-iot.sh
./test-knx-iot.sh
```

---

## 📅 Events Endpoints

```bash
# Alle Events (letzte 1000)
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/events | jq

# Events für spezifische Gruppenadresse
curl -s -H "$AUTH_READ" "$KNX_IOT_API_URL/events?ga=1/5/1&limit=50" | jq
```

---

## 🧠 Semantic Endpoints (v2 – intern)

> Nur verfügbar wenn TTL-Datei geladen

```bash
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/semantic/locations | jq
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/semantic/locations/hierarchy | jq
curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/semantic/functions | jq
```

---

## 🐛 Debugging

```bash
# Verbose Output
curl -v -H "$AUTH_READ" $KNX_IOT_API_URL/datapoints

# Headers prüfen (Content-Type muss application/vnd.api+json sein)
curl -I -H "$AUTH_READ" $KNX_IOT_API_URL/datapoints

# Response Time messen
time curl -s -H "$AUTH_READ" $KNX_IOT_API_URL/datapoints > /dev/null
```

---

## 🔔 Subscriptions Endpoints (HTTP Callback)

> Basis-Pfad: `/api/v2/subscriptions`  
> Scope: `manage` (lt. KNX IoT Spec 2.1.0)  
> Auth: `Authorization: Bearer <token>`  
> WebSocket-Subscription ist aktuell nicht implementiert.

### Hilfsvariablen vorbereiten

```bash
# Verwendet die globale Basis-URL aus "## Basis-URL"
SUB_URL="$KNX_IOT_API_URL/subscriptions"

# OAuth Access Token (manage scope) holen
TOKEN=$(curl -s -X POST "$API_URL/oauth/access" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -u 'knx-default-client:change-me-in-production' \
  -d 'grant_type=client_credentials&scope=manage' | jq -r '.access_token')

AUTH="Authorization: Bearer $TOKEN"

# Einen vorhandenen Datapoint-ID holen (für Subscription-Beispiele)
DPID=$(curl -s -H "$AUTH" "$KNX_IOT_API_URL/datapoints" | jq -r '.datapoints[0].datapointId // .datapoints[0].id')
echo "Datapoint ID: $DPID"
```

---

### GET /subscriptions – Alle Subscriptions auflisten

```bash
curl -s -H "$AUTH" $SUB_URL | jq

# Nur IDs und URLs
curl -s -H "$AUTH" $SUB_URL | jq '.data[] | {id, url: .attributes.url, type: .attributes.subscriptionType}'

# Anzahl aktiver Subscriptions
curl -s -H "$AUTH" $SUB_URL | jq '.meta.total'
```

**Erwartete Antwort (leere Liste):**

```json
{
  "meta": { "total": 0, "page": 1, "size": 50, "pageCount": 0 },
  "data": []
}
```

---

### POST /subscriptions – Subscription erstellen

**Auf einen Datapoint subscriben:**

```bash
curl -s -X POST $SUB_URL \
  -H "$AUTH" \
  -H 'Content-Type: application/vnd.api+json' \
  -d "{
    \"data\": {
      \"type\": \"subscription\",
      \"attributes\": {
        \"subscriptionType\": \"callback\",
        \"url\": \"http://my-server.local/callback\",
        \"secret\": \"my-hmac-secret\",
        \"lifetime\": \"3600\"
      },
      \"relationships\": {
        \"subscriptionDatapoints\": {
          \"data\": [
            { \"id\": \"$DPID\", \"type\": \"datapoint\", \"meta\": { \"expand\": false } }
          ]
        }
      }
    }
  }" | jq
```

**Erwartete Antwort (201):**

```json
{
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "type": "subscription",
    "relationships": {
      "subscriptionDatapoints": {
        "links": { "related": "/api/v2/subscriptions/550e8400-.../datapoints" }
      }
    }
  }
}
```

```bash
# ID der neuen Subscription direkt speichern
SUB_ID=$(curl -s -X POST $SUB_URL \
  -H "$AUTH" \
  -H 'Content-Type: application/vnd.api+json' \
  -d "{
    \"data\": {
      \"type\": \"subscription\",
      \"attributes\": {
        \"subscriptionType\": \"callback\",
        \"url\": \"http://my-server.local/callback\",
        \"secret\": \"my-hmac-secret\"
      },
      \"relationships\": {
        \"subscriptionDatapoints\": {
          \"data\": [{ \"id\": \"$DPID\", \"type\": \"datapoint\" }]
        }
      }
    }
  }" | jq -r '.data.id')
echo "Subscription ID: $SUB_ID"
```

**Auf eine Installation subscriben (mit expand=true):**

```bash
INSTID=$(curl -s -H "$AUTH" $KNX_IOT_API_URL/installations | jq -r '.data[0].id')

curl -s -X POST $SUB_URL \
  -H "$AUTH" \
  -H 'Content-Type: application/vnd.api+json' \
  -d "{
    \"data\": {
      \"type\": \"subscription\",
      \"attributes\": {
        \"subscriptionType\": \"callback\",
        \"url\": \"http://my-server.local/callback\"
      },
      \"relationships\": {
        \"subscriptionInstallations\": {
          \"data\": [
            { \"id\": \"$INSTID\", \"type\": \"installation\", \"meta\": { \"expand\": true } }
          ]
        }
      }
    }
  }" | jq
```

**Auf den Node subscriben:**

```bash
NODE_ID=$(curl -s -H "$AUTH" $KNX_IOT_API_URL/node | jq -r '.data.id')

curl -s -X POST $SUB_URL \
  -H "$AUTH" \
  -H 'Content-Type: application/vnd.api+json' \
  -d "{
    \"data\": {
      \"type\": \"subscription\",
      \"attributes\": {
        \"subscriptionType\": \"callback\",
        \"url\": \"http://my-server.local/callback\"
      },
      \"relationships\": {
        \"subscriptionNode\": {
          \"data\": { \"id\": \"$NODE_ID\", \"type\": \"node\" }
        }
      }
    }
  }" | jq
```

**Fehlerfall – fehlende URL:**

```bash
curl -s -X POST $SUB_URL \
  -H "$AUTH" \
  -H 'Content-Type: application/vnd.api+json' \
  -d '{
    "data": {
      "type": "subscription",
      "attributes": { "subscriptionType": "callback" },
      "relationships": {
        "subscriptionDatapoints": { "data": [{ "id": "some-id", "type": "datapoint" }] }
      }
    }
  }' | jq
# → 422: Attribute "url" is required for callback subscriptions.
```

**Fehlerfall – keine Ressourcen angegeben:**

```bash
curl -s -X POST $SUB_URL \
  -H "$AUTH" \
  -H 'Content-Type: application/vnd.api+json' \
  -d '{
    "data": {
      "type": "subscription",
      "attributes": { "subscriptionType": "callback", "url": "http://example.com" }
    }
  }' | jq
# → 422: At least one resource (subscriptionDatapoints, subscriptionInstallations or subscriptionNode) must be provided.
```

---

### GET /subscriptions/:id – Einzelne Subscription abrufen

```bash
curl -s -H "$AUTH" $SUB_URL/$SUB_ID | jq

# Nur Attribute
curl -s -H "$AUTH" $SUB_URL/$SUB_ID | jq '.data.attributes'

# Ablaufzeit prüfen
curl -s -H "$AUTH" $SUB_URL/$SUB_ID | jq '.data.attributes | {expiresAt, lifetime, active}'
```

---

### PATCH /subscriptions/:id – Subscription aktualisieren

> Nur `url`, `secret`, `caCert` und `lifetime` sind änderbar.  
> Die subscribed Ressourcen (`subscriptionDatapoints`/`subscriptionInstallations`/`subscriptionNode`) können **nicht** geändert werden – dafür DELETE + neu anlegen.

**URL und Secret aktualisieren:**

```bash
curl -s -X PATCH $SUB_URL/$SUB_ID \
  -H "$AUTH" \
  -H 'Content-Type: application/vnd.api+json' \
  -d "{
    \"data\": {
      \"id\": \"$SUB_ID\",
      \"type\": \"subscription\",
      \"attributes\": {
        \"url\": \"http://new-server.local/callback\",
        \"secret\": \"new-secret-value\"
      }
    }
  }" | jq
# → 200: { "data": null }
```

**Lifetime verlängern:**

```bash
curl -s -X PATCH $SUB_URL/$SUB_ID \
  -H "$AUTH" \
  -H 'Content-Type: application/vnd.api+json' \
  -d "{
    \"data\": {
      \"id\": \"$SUB_ID\",
      \"type\": \"subscription\",
      \"attributes\": { \"lifetime\": \"172800 seconds\" }
    }
  }" | jq
```

**Fehlerfall – ID-Mismatch zwischen Body und URL:**

```bash
curl -s -X PATCH $SUB_URL/$SUB_ID \
  -H "$AUTH" \
  -H 'Content-Type: application/vnd.api+json' \
  -d '{
    "data": {
      "id": "wrong-id",
      "type": "subscription",
      "attributes": { "url": "http://example.com" }
    }
  }' | jq
# → 409: Resource id in body does not match URL parameter.
```

---

### DELETE /subscriptions/:id – Subscription löschen

```bash
curl -s -X DELETE -H "$AUTH" $SUB_URL/$SUB_ID
# → 204 No Content (leerer Body)

# Prüfen ob wirklich weg
curl -s -H "$AUTH" $SUB_URL/$SUB_ID | jq
# → 404: Subscription "..." not found.
```

---

### GET /subscriptions/:id/datapoints – Abonnierte Datapunkte

```bash
curl -s -H "$AUTH" $SUB_URL/$SUB_ID/datapoints | jq

# Nur IDs
curl -s -H "$AUTH" $SUB_URL/$SUB_ID/datapoints | jq '.data[].id'

# Mit Paginierung
curl -s -H "$AUTH" "$SUB_URL/$SUB_ID/datapoints?page%5Bnumber%5D=1&page%5Bsize%5D=10" | jq
```

---

### GET /subscriptions/:id/installations – Abonnierte Installationen

```bash
curl -s -H "$AUTH" $SUB_URL/$SUB_ID/installations | jq
```

---

### GET /subscriptions/:id/node – Abonnierter Node

```bash
curl -s -H "$AUTH" $SUB_URL/$SUB_ID/node | jq
# → { "data": null }         wenn kein Node subscribed
# → { "data": { "id": "...", "type": "node", "meta": { "expand": false } } }
```

---

### Vollständiger End-to-End Test

Speichern als `test-subscriptions.sh`:

```bash
#!/usr/bin/env bash
set -e
API_URL="${API_URL:-http://localhost:3000}"
SUB_URL="$KNX_IOT_API_URL/subscriptions"
H='Content-Type: application/vnd.api+json'

TOKEN=$(curl -sf -X POST "$API_URL/oauth/access" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -u 'knx-default-client:change-me-in-production' \
  -d 'grant_type=client_credentials&scope=manage' | jq -r '.access_token')

AUTH="Authorization: Bearer $TOKEN"

echo "=== 1. Datapoint-ID holen ==="
DPID=$(curl -sf -H "$AUTH" $KNX_IOT_API_URL/datapoints | jq -r '.datapoints[0].datapointId // .datapoints[0].id')
echo "Datapoint: $DPID"

echo "=== 2. Subscription erstellen ==="
SUB_ID=$(curl -sf -X POST $SUB_URL -H "$AUTH" -H "$H" -d "{
  \"data\": {
    \"type\": \"subscription\",
    \"attributes\": {
      \"subscriptionType\": \"callback\",
      \"url\": \"http://localhost:9999/test-callback\",
      \"secret\": \"test-secret\",
      \"lifetime\": \"3600\"
    },
    \"relationships\": {
      \"subscriptionDatapoints\": {
        \"data\": [{ \"id\": \"$DPID\", \"type\": \"datapoint\" }]
      }
    }
  }
}" | jq -r '.data.id')
echo "Subscription: $SUB_ID"

echo "=== 3. GET /subscriptions ==="
curl -sf -H "$AUTH" $SUB_URL | jq '.meta'

echo "=== 4. GET /subscriptions/:id ==="
curl -sf -H "$AUTH" $SUB_URL/$SUB_ID | jq '.data.attributes | {subscriptionType, url, lifetime, active}'

echo "=== 5. GET /subscriptions/:id/datapoints ==="
curl -sf -H "$AUTH" $SUB_URL/$SUB_ID/datapoints | jq '.meta'

echo "=== 6. PATCH – URL ändern ==="
curl -sf -X PATCH $SUB_URL/$SUB_ID -H "$AUTH" -H "$H" -d "{
  \"data\": {
    \"id\": \"$SUB_ID\",
    \"type\": \"subscription\",
    \"attributes\": { \"url\": \"http://localhost:9999/updated-callback\" }
  }
}" | jq

echo "=== 7. GET nach PATCH – neue URL prüfen ==="
curl -sf -H "$AUTH" $SUB_URL/$SUB_ID | jq '.data.attributes.url'

echo "=== 8. DELETE ==="
curl -sf -X DELETE -H "$AUTH" $SUB_URL/$SUB_ID
echo "Deleted (204)"

echo "=== 9. GET nach DELETE → 404 ==="
curl -s -H "$AUTH" $SUB_URL/$SUB_ID | jq '.errors[0]'

echo ""
echo "✅ Alle Tests erfolgreich"
```

```bash
chmod +x test-subscriptions.sh
./test-subscriptions.sh
```

---

### Callback-Empfang lokal simulieren

Um eingehende Callback-Requests zu beobachten, einen einfachen HTTP-Listener starten:

```bash
# Python (dauerhaft, gibt alle Requests aus)
python3 -m http.server 9999

# Oder mit npx (gibt Body formatiert aus)
npx --yes http-echo-server 9999
```

> ⚠️ **Docker-Netzwerk:** Da der Service im Container läuft, ist `localhost` aus seiner Sicht der Container selbst.  
> Für Callbacks auf den Host stattdessen `http://host.docker.internal:9999/callback` als URL verwenden.


---

## 📝 Notes

- KNX IoT Endpunkte liefern `Content-Type: application/vnd.api+json`
- Alle IDs in `/api/v2/*` sind stabile **UUIDs** (deterministisch aus der internen ID generiert)
- Paginierung via `page%5Bnumber%5D` und `page%5Bsize%5D` Query-Parameter – eckige Klammern müssen URL-encodiert werden (`[` → `%5B`, `]` → `%5D`)
- **Filter-Parameter** (`filter[deviceId]` etc.) ebenfalls URL-encodieren **oder** `curl -g`/`--globoff` verwenden – sonst verwirft die Bash die Parameter stillschweigend
- `value` ist immer ein **String** – bei `valueType: "object"` (z.B. Datum/Uhrzeit) ist es ein doppelt serialisierter JSON-String → mit `| fromjson` parsen
- `knx:groupAddress` ist ein **Integer** (`main*2048 + middle*256 + sub`)
- Alle Timestamps sind ISO 8601 (UTC)
- **Umlaute in `jq`-Strings:** `==` mit Umlauten (ä/ö/ü) schlägt fehl wenn das Terminal-Encoding nicht UTF-8 ist → stattdessen `contains()` verwenden oder UUID direkt angeben

```bash
# ❌ Unsicher bei Umlauten
jq -r '.data[] | select(.attributes.title == "Küche") | .id'

# ✅ Sicher
jq -r '.data[] | select(.attributes.title | contains("che")) | .id'
```

---

## 🔗 Weitere Ressourcen

- [KNX IoT 3rd Party API Specification](https://www.knx.org/knx-en/for-professionals/index.php)
- [TimescaleDB Documentation](https://docs.timescale.com/)
- [PostgreSQL JSON Functions](https://www.postgresql.org/docs/current/functions-json.html)
