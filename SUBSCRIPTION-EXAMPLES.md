# Subscription-Beispiele (aktueller Stand)

Dieses Dokument beschreibt den **aktuell implementierten** Stand in der Runtime.

## Szenario

Ein Dashboard moechte Updates erhalten, wenn sich Datapunkt-Werte aendern.

Aktuell gibt es in der Runtime:
- **HTTP Callback** (implementiert)
- **WebSocket Subscription** (implementiert)

---

## 1. Voraussetzungen

### 1.1 OAuth-Token mit Scope `manage`

Alle Endpunkte unter `/api/v1/subscriptions` sind mit Bearer-Auth geschuetzt und benoetigen den Scope `manage`.

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/oauth/access \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -u 'knx-default-client:change-me-in-production' \
  -d 'grant_type=client_credentials&scope=manage' | jq -r '.access_token')
```

### 1.2 Header fuer Subscription-Requests

- `Authorization: Bearer <token>`
- `Accept: application/vnd.api+json`
- `Content-Type: application/vnd.api+json` (alternativ fuer POST/PATCH auch `application/json`)

---

## 2. HTTP Callback Subscription

### 2.1 Subscription anlegen

```bash
curl -X POST http://localhost:3000/api/v1/subscriptions \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Accept: application/vnd.api+json' \
  -H 'Content-Type: application/vnd.api+json' \
  -d '{
    "data": {
      "type": "subscription",
      "attributes": {
        "subscriptionType": "callback",
        "url": "https://mein-dashboard.local/knx-callback",
        "secret": "mein-hmac-secret",
        "lifetime": "3600"
      },
      "relationships": {
        "subscriptionDatapoints": {
          "data": [
            {
              "id": "123e4567-e89b-12d3-a456-426614174001",
              "type": "datapoint"
            },
            {
              "id": "123e4567-e89b-12d3-a456-426614174002",
              "type": "datapoint"
            }
          ]
        }
      }
    }
  }'
```

**Antwort (201):**

```json
{
  "data": {
    "id": "123e4567-e89b-12d3-a456-426614174000",
    "type": "subscription",
    "relationships": {
      "subscriptionDatapoints": {
        "links": {
          "related": "http://localhost:3000/api/v1/subscriptions/123e4567-e89b-12d3-a456-426614174000/datapoints"
        }
      }
    }
  }
}
```

---

### 2.2 Was wird an den Callback gesendet?

Bei Datapunkt-Aenderungen sendet der Dispatcher einen `POST` an die konfigurierte URL.

**Request-Header (Beispiel):**

```
POST /knx-callback HTTP/1.1
Host: mein-dashboard.local
Content-Type: application/vnd.api+json
Content-Length: 246
Date: Fri, 29 May 2026 10:00:00 GMT
User-Agent: KNX-IoT-Runtime/0.1.0
X-Callback-Signature: mN2A...base64...
```

Hinweise:
- `X-Callback-Signature` wird nur gesetzt, wenn bei der Subscription `secret` gesetzt ist.
- Die Signatur ist **base64-kodiert** (nicht `sha256=<hex>`).

**Request-Body (`UpdateEvent`):**

```json
{
  "data": [
    {
      "id": "123e4567-e89b-12d3-a456-426614174001",
      "type": "datapoint",
      "links": {
        "self": "/api/v1/datapoints/123e4567-e89b-12d3-a456-426614174001"
      },
      "attributes": {
        "value": "1",
        "timestamp": "2026-05-29T10:00:00.000Z"
      }
    }
  ]
}
```

---

### 2.3 Signatur am Empfaenger pruefen

Die Runtime bildet die Signatur aus:
1. Request-Line inkl. CRLF (`POST /path HTTP/1.1\r\n`)
2. Host
3. Date
4. Content-Length
5. Raw-Body

```js
import { createHmac } from 'node:crypto';

function verifySignature({ callbackUrl, rawBody, date, contentLength, signatureHeader, secret }) {
  const parsed = new URL(callbackUrl);
  const requestLine = `POST ${parsed.pathname}${parsed.search} HTTP/1.1\r\n`;

  const signingString =
    requestLine +
    parsed.host +
    date +
    contentLength +
    rawBody;

  const expected = createHmac('sha256', secret)
    .update(signingString)
    .digest('base64');

  return signatureHeader === expected;
}
```

---

## 3. Weitere Subscription-Endpunkte

Alle Endpunkte benoetigen `Authorization: Bearer <token>` mit Scope `manage`.

- `GET /api/v1/subscriptions`
- `GET /api/v1/subscriptions/:id`
- `PATCH /api/v1/subscriptions/:id` (nur `url`, `secret`, `caCert`, `lifetime`)
- `DELETE /api/v1/subscriptions/:id`
- `GET /api/v1/subscriptions/:id/datapoints`
- `GET /api/v1/subscriptions/:id/installations`
- `GET /api/v1/subscriptions/:id/node`

Wichtig: Relationships koennen bei `PATCH` nicht geaendert werden.

---

## 4. Status WebSocket

Ein WebSocket-Subscription-Endpoint ist in der aktuellen Implementierung nicht vorhanden.

- Kein `GET /api/v1/.../ws`
- Kein WebSocket-Dispatch im `CallbackDispatcher`
- Event-Dispatch erfolgt aktuell nur ueber HTTP Callback

