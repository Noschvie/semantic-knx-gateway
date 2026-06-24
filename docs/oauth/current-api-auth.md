# Aktuelles Auth-Modell der KNX IoT 3rd-Party API

## Dokumentationszweck

Dieses Dokument beschreibt das **aktuelle OAuth2-Setup** der KNX IoT 3rd-Party API (`/oauth/access`).  
Es erklärt, warum kein Refresh-Token verfügbar ist und welche Konsequenzen das für Clients hat.

**Hinweis:** Der separaten Keycloak-Guide (`keycloak-refresh-test.md`) dient nur zum lokalen Testen eines User-basierten Refresh-Token-Flows als Referenz-Implementierung. Es ist nicht Teil des aktuellen KNX IoT API setups.

---

## Aktuelles Setup: Client Credentials

### Grant Type

Das API nutzt den OAuth2-Standard **`client_credentials`**:

```bash
POST /oauth/access HTTP/1.1

grant_type=client_credentials
client_id=YOUR_CLIENT_ID
client_secret=YOUR_CLIENT_SECRET
scope=read write manage
```

### Warum Client Credentials?

- **Machine-to-Machine** (M2M) Kommunikation
- Kein User-Login-Kontext erforderlich
- Ideal für Service-zu-Service-Integration
- Keine Benutzersession oder Identität nötig

### Konsequenz: Kein Refresh-Token

Bei `client_credentials` ist **kein `refresh_token`** zu erwarten. Das ist OAuth2-konform:

- `client_credentials` ist für kurzlebige Zugriffe gedacht (M2M)
- Der Client hat bereits die Authentifizierung (Client ID + Secret)
- Ein neues Token wird einfach neu angefordert, wenn das alte abläuft

---

## Token-Renewal-Verhalten heute

### Wenn das Access-Token abläuft

1. Client bemerkt: Token ist abgelaufen oder kurz davor (`expires_in`)
2. Client macht eine **neue** `POST /oauth/access` Anfrage
3. Neue Credentials werden mit der Antwort geliefert
4. Bearer-Token wird aktualisiert
5. Nächster API-Request mit neuem Token

### Code-Beispiel (konzeptuell)

```javascript
// Pseudocode
class OAuthClient {
  async getAccessToken() {
    const response = await fetch('/oauth/access', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: 'read write manage'
      })
    });
    
    const data = await response.json();
    // { access_token: "...", expires_in: 3600, ... }
    
    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + (data.expires_in * 1000);
    
    return data.access_token;
  }
  
  async apiRequest(endpoint) {
    if (this.isTokenExpired()) {
      await this.getAccessToken(); // Einfach neu holen
    }
    
    return fetch(endpoint, {
      headers: { Authorization: `Bearer ${this.accessToken}` }
    });
  }
}
```

---

## Auswirkungen auf Client-Implementierung

### Token Caching & Proaktives Refresh

- Access-Token + Ablaufzeit speichern
- **Kurz vor Ablauf** erneut anfordern (z. B. 60 Sekunden Puffer)
- Nicht warten, bis Token abgelaufen ist

### Fehlerbehandlung

- Bei `401 Unauthorized`: Token ist abgelaufen
  - Einmal erneut `/oauth/access` aufrufen
  - Request mit neuem Token wiederholen
- Bei `invalid_client`: Client-Credentials überprüfen

### Sicherheit

- `client_secret` **niemals** im Frontend speichern
- Nur in der Backend-Anwendung verwenden
- HTTPS für alle OAuth-Verkehr verwenden

---

## Soll-Zustand: User-basierter Flow (zukünftig)

Falls eine User-Authentication später eingeführt wird, müsste umgestellt werden auf:

- **`authorization_code` + PKCE** (statt `client_credentials`)
- Benutzer-Login erforderlich
- Mit `offline_access` Scope könnte ein Refresh-Token ausgegeben werden
- Dann würde Refresh-Token-Rotation möglich sein

Das erfordert aber:
- Ein Login-UI / Authorization-Endpoint
- Redirect-URIs
- Möglicherweise ein Identity Provider (z. B. Keycloak)

Aktuell ist dies **nicht** geplant. Der aktuelle `client_credentials`-Flow ist das Standard-Setup.

---

## Offene Fragen / Zusammenarbeit mit Provider

Falls es Fragen zum OAuth-Provider gibt:

1. **Token-Lebensdauer**: Welche `expires_in` kann der Client erwarten?
2. **Scope-System**: Welche Scopes sind verfügbar? Welche sind Defaults?
3. **Refresh-Token-Roadmap**: Ist ein User-Flow zukünftig geplant?
4. **Rate Limiting**: Gibt es Limits bei häufigen `/oauth/access` Aufrufen?
5. **Token Revocation**: Kann ein Token manuell invalidiert werden?

---

## Verwandte Dokumente

- `authorization-code-pkce-explained.md` – Detaillierte Erklärung, was `authorization_code` + PKCE bedeutet
- `keycloak-refresh-test.md` – Referenz-Testanleitung für User-basierten Flow (Keycloak lokal)
- `overview.md` – Vergleichsmatrix aller OAuth-Flows
- API-TESTING.md – Praktische Testbeispiele
