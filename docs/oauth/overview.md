# OAuth2 Übersicht & Entscheidungsmatrix

## Dokumentationszweck

Diese Seite gibt einen **Überblick über die verschiedenen OAuth2-Flows** und erklärt, welcher für welchen Use-Case geeignet ist. Sie verbindet die anderen Dokumente dieser Serie.

---

## OAuth2-Flows im Überblick

| Aspekt | **Client Credentials** | **Authorization Code + PKCE** | **Implicit** |
|--------|------------------------|-------------------------------|-------------|
| **Aktuell bei KNX IoT** | ✅ JA | ❌ NEIN (Zukunft?) | ❌ NEIN |
| **Use-Case** | M2M, Service-to-Service | Benutzer-gesteuert, Web-Apps | ⚠️ Deprecated |
| **Benötigt User-Login?** | ❌ NEIN | ✅ JA | ✅ JA |
| **Access-Token Lebensdauer** | Kurz (< 1h) | Kurz bis Mittel (< 1h) | Kurz |
| **Refresh-Token verfügbar?** | ❌ NEIN | ✅ JA (mit `offline_access`) | ❌ NEIN |
| **Refresh-Mechanismus** | Einfach neu anfragen | Refresh-Token austauschen | nicht verfügbar |
| **Client-Secret erforderlich?** | ✅ JA | ❌ NEIN (Public Client) | ❌ NEIN |
| **PKCE erforderlich?** | ❌ NEIN | ✅ JA | ✅ JA |
| **Redirect-URI erforderlich?** | ❌ NEIN | ✅ JA | ✅ JA |
| **Komplexität** | 🟢 Einfach | 🟡 Mittel | 🟡 Mittel |
| **Sicherheit** | 🟢 Gut (M2M) | 🟢 Sehr gut | 🟠 Schwächer (deprecated) |

---

## Das aktuelle KNX IoT Setup

### Wie es heute funktioniert

```
Client (z. B. Backend-Service)
    ↓
POST /oauth/access (client_credentials)
    ↓
OAuth-Provider
    ↓
Access-Token (kurz-lived, z. B. 3600s)
    ↓
Client speichert Token + Ablaufzeit
```

**Dokumentation:** → Siehe `current-api-auth.md`

### Warum client_credentials?

- **Machine-to-Machine** ist der Standard für Microservices
- Der Client ist nicht eine Benutzer-Anwendung, sondern ein Service
- Keine User-Identität nötig
- Einfach zu implementieren

### Token-Renewal

- Token läuft ab? → Einfach neue `/oauth/access` anfragen
- **Kein** Refresh-Token nötig
- **Kein** User-Interaction erforderlich

---

## Zukünftig möglich: User-basierter Flow

Falls KNX IoT später einen **Benutzer-Authentication** einführt:

```
Benutzer (im Browser)
    ↓
1. Authorize (Login-Screen)
    ↓
OAuth-Provider
    ↓
2. Authorization Code
    ↓
Client-Backend tauscht Code gegen Tokens
    ↓
Access-Token (kurz-lived, z. B. 1h)
Refresh-Token (lang-lived, z. B. 7 Tage)
    ↓
Client speichert beide Tokens
```

**Token-Renewal mit Refresh-Token:**

```
Token-Ablauf erkannt?
    ↓
Refresh-Token an /oauth/access senden
    ↓
Neue Tokens erhalten
    ↓
Refresh-Token rotiert? → neuen speichern
```

**Dokumentation:** → Siehe `keycloak-refresh-test.md` (Referenz-Beispiel)

---

## Vergleich: Heute vs. Zukünftig

| Punkt | **Heute (client_credentials)** | **Zukünftig (auth_code + refresh)** |
|-------|--------------------------------|-------------------------------------|
| Benutzer-Kontext | ❌ NEIN | ✅ JA |
| Refresh-Token | ❌ NEIN | ✅ JA |
| Token-Renewal | Neu anfordern | Refresh-Token nutzen |
| Komplexität | Einfach | Mittel |
| Benutzer-Consent erforderlich? | ❌ NEIN | ✅ JA |
| Passend für Web-UI? | ❌ NEIN | ✅ JA |

---

## Entscheidungshilfe: Welcher Flow für welchen Use-Case?

### "Wir haben einen Backend-Service, der die API aufruft"

→ **Client Credentials** (aktuell)

- Beispiel: Haus-Automation ruft KNX-API auf
- Keine User-Session nötig
- `client_id` + `client_secret` ausreichend
- Siehe: `current-api-auth.md`

### "Wir bauen eine Web-App, in der Benutzer eingeloggt sind"

→ **Authorization Code + PKCE + Refresh-Token** (zukünftig)

- Beispiel: KNX-Dashboard für Benutzer
- Benutzer loggt sich ein
- Token mit Benutzer-Kontext
- Refresh-Token für lange Sessions
- Siehe: `keycloak-refresh-test.md` (als Referenz)

### "Wir bauen eine Mobile-App"

→ **Authorization Code + PKCE** (auch zukünftig)

- Ähnlich Web-App, aber mit zusätzlichen Sicherheitsaspekten
- Keine `client_secret` auf dem Gerät speichern
- PKCE ist **essenziell**

---

## Häufige Missverständnisse

### ❌ "Wir brauchen client_credentials, um refresh_token zu bekommen"

→ **Falsch!** `client_credentials` ist **nicht** kompatibel mit Refresh-Tokens. Verwende stattdessen `authorization_code`.

### ❌ "refresh_token funktioniert überall"

→ **Falsch!** Nur bei User-basierten Flows (z. B. `authorization_code`). Nicht bei `client_credentials`.

### ❌ "Mit Keycloak ändert sich unser KNX IoT API"

→ **Falsch!** Keycloak-Tests sind nur **lokal und zum Lernen**. Die aktuelle KNX IoT API bleibt `client_credentials`.

---

## Zusammenfassung

1. **Heute**: KNX IoT nutzt `client_credentials` → Kein Refresh-Token
2. **Heute**: Token-Renewal durch Neu-Anfrage
3. **Zukünftig** (falls geplant): User-Auth + `authorization_code` → Refresh-Token möglich
4. **Diese Serie**: 
   - `current-api-auth.md` – Aktuelles Setup verstehen
   - `keycloak-refresh-test.md` – Zukünftige Variante lernen (lokal testen)
   - `overview.md` – Diese Seite, Überblick

---

## Verwandte Dokumente

- `current-api-auth.md` – Das aktuelle KNX IoT Setup (client_credentials)
- `keycloak-refresh-test.md` – Referenz-Testanleitung für User-Flow mit Keycloak
