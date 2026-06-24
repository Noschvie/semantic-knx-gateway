# Authorization Code + PKCE – Detaillierte Erklärung

## Dokumentationszweck

Dieses Dokument erklärt im Detail, wie der **`authorization_code` Flow mit PKCE** funktioniert. Es ist eine tiefgehende Erklärung für Entwickler, die verstehen möchten, was `authorization_code` + PKCE bedeutet (siehe `current-api-auth.md`, Soll-Zustand-Abschnitt).

**Kontext:** Dies ist ein **zukünftiger möglicher Flow** für KNX IoT. Das aktuelle Setup nutzt `client_credentials`.

---

## Der `authorization_code` Flow – Schritt für Schritt

Der **`authorization_code` Flow** ist der Standard OAuth2 Flow für **Benutzer-Authentifizierung**. 

### Akteure:

- **Benutzer** (im Browser)
- **Client** (z. B. deine Web-App)
- **OAuth-Provider** (z. B. Keycloak, der Identity Service)
- **API** (z. B. KNX IoT Gateway)

### Ablauf (Diagramm):

```
┌─────────────┐                    ┌──────────────┐
│   Benutzer  │                    │ OAuth-Server │
│  (Browser)  │                    │ (Keycloak)   │
└─────────────┘                    └──────────────┘
      │                                   │
  1.  │  "Ich will mich einloggen"        │
      │──────────────────────────────────>│
      │                                   │
      │  2. Redirect zu Login-Seite       │
      │<──────────────────────────────────│
      │                                   │
      │  [Benutzer gibt Passwort ein]     │
      │                                   │
      │  3. Authorization Code erhalten   │
      │<──────────────────────────────────│
      │                                   │
  4.  │  Backend tauscht Code gegen       │
      │  Access-Token                     │
      │──────────────────────────────────>│
      │                                   │
      │  Tokens erhalten                  │
      │<──────────────────────────────────│
```

---

## Schritt 1: Benutzer clickt "Login"

Der Client öffnet eine **Login-URL** zum OAuth-Provider:

```
https://oauth-provider.com/authorize?
  response_type=code
  &client_id=meine-app
  &redirect_uri=https://meine-app.com/callback
  &scope=read write offline_access
  &state=xyz123
```

### Parameter erklärt:

| Parameter | Bedeutung | Beispiel |
|-----------|-----------|----------|
| `response_type=code` | "Ich möchte einen Authorization Code" | (immer `code`) |
| `client_id` | Identität der App (registriert beim OAuth-Server) | `meine-app` |
| `redirect_uri` | Wohin der Server mich zurücksendet nach dem Login | `https://meine-app.com/callback` |
| `scope` | Was darf die App mit meinen Daten? | `read write offline_access` |
| `state` | Sicherheits-Token gegen CSRF-Attacken | `xyz123` (zufällig) |

---

## Schritt 2: Benutzer loggt sich ein

Der OAuth-Server zeigt einen **Login-Dialog**:

```
╔════════════════════════════════╗
║  Bitte melden Sie sich an      ║
╠════════════════════════════════╣
║                                ║
║  Email: user@example.com       ║
║  Passwort: ••••••••••          ║
║                                ║
║  [Anmelden]                    ║
╚════════════════════════════════╝
```

Der Benutzer gibt seine Credentials ein. Der Server validiert diese.

---

## Schritt 3: Server sendet Authorization Code

Nach erfolgreichem Login wird der **Browser zurück zur `redirect_uri` geschickt** mit einem Authorization Code:

```
https://meine-app.com/callback?
  code=AUTH_CODE_xyz
  &state=xyz123
```

### Wichtige Eigenschaften des Codes:

- **Sehr kurzlebig**: Nur wenige Minuten gültig (typisch 5–10 Minuten)
- **Einmalig**: Kann nur 1x benutzt werden
- **Browser kennt den Code**: Aber der Browser kennt nicht den `client_secret`!

---

## Schritt 4: Backend tauscht Code gegen Tokens

Der **Backend der App** (nicht der Browser!) macht eine sichere Anfrage zum OAuth-Server:

```bash
POST https://oauth-provider.com/token

grant_type=authorization_code
code=AUTH_CODE_xyz
client_id=meine-app
client_secret=GEHEIM_xyz        # ← NUR Backend kennt das!
redirect_uri=https://meine-app.com/callback
```

### Antwort vom Server:

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "refresh_token": "refresh_xyz",
  "expires_in": 3600,
  "token_type": "Bearer"
}
```

### Warum das sicherer ist:

- Der **Browser niemals** `client_secret` sieht
- Der **Browser niemals** `access_token` direkt erhält (oder nur über HttpOnly Cookie)
- Der **Backend** kann `client_secret` sicher speichern (im Speicher oder verschlüsselt in Umgebungsvariablen)

---

## PKCE – Was ist das?

**PKCE** = **P**roof **K**ey for **C**ode **E**xchange

Es ist ein **Sicherheits-Zusatz** zum `authorization_code` Flow, der das System gegen **Code-Abfang-Attacken** schützt.

### Problem ohne PKCE:

Ein Hacker könnte den Authorization Code **abfangen**:

```
https://meine-app.com/callback?code=AUTH_CODE_xyz

↓ Hacker sieht diesen Code in:
  - Browser-History
  - Proxy-Logs
  - Netzwerk-Captures

↓ Hacker macht einfach: 
   POST /oauth/access
     grant_type=authorization_code
     code=AUTH_CODE_xyz

PROBLEM: 
  - Ohne PKCE kann jeder mit dem Code ein Token besorgen
  - Der Code ist für "jeden" der ihn hat gültig!
  - Und der Hacker ist derselbe OAuth-Client → Code ist gültig
```

### Lösung mit PKCE:

Der Client generiert ein **Geheimnis** und beweist später, dass er es kennt:

```
Schritt 1: Client generiert geheimen String
  code_verifier = zufälliger String (mindestens 43 Zeichen)
  
Schritt 2: Client berechnet SHA256-Hash des Verifiers
  code_challenge = SHA256(code_verifier) base64url-encoded
  
Schritt 3: Client sendet challenge zum OAuth-Server
  /authorize?
    code_challenge=XXX
    code_challenge_method=S256
    ...
    
Schritt 4: User loggt sich ein
  Server gibt Authorization Code zurück
  
Schritt 5: Client tauscht Code + code_verifier
  /token?
    code=AUTH_CODE_xyz
    code_verifier=zufälliger_string
    ...
    
Schritt 6: Server prüft
  SHA256(code_verifier) == code_challenge?
  
  ✅ JA   → Token geben
  ❌ NEIN → Ablehnen (Code-Abfang erkannt!)
```

### Mit PKCE wäre der Hacker-Angriff foiled:

```
Hacker bekommt Code: AUTH_CODE_xyz

Hacker versucht:
  POST /oauth/access
    grant_type=authorization_code
    code=AUTH_CODE_xyz
    
PROBLEM: 
  - Hacker kennt den code_verifier nicht!
  - Hacker sendet: code_verifier=falsch_geraten
  
Server prüft:
  SHA256(falsch_geraten) != XXX
  
  ❌ NEIN → Ablehnen!
  
✅ Angriff vereitelt!
```

---

## Praktisches Beispiel mit PKCE

### 1. Code-Verifier & Code-Challenge generieren

```javascript
// Client generiert geheimen String (mind. 43 Zeichen)
const code_verifier = crypto
  .randomBytes(32)
  .toString('base64url');

// Ergebnis: "abcdef123456_abcdef123456_abcdef123456_"

// Daraus Challenge berechnen
const sha = crypto.createHash('sha256');
const code_challenge = sha
  .update(code_verifier)
  .digest('base64url');

// Ergebnis: "xyz789_xyz789_xyz789_"
```

### 2. Login-URL mit Challenge

```
https://oauth-provider.com/authorize?
  response_type=code
  &client_id=meine-app
  &code_challenge=xyz789_xyz789_xyz789_
  &code_challenge_method=S256
  &redirect_uri=https://meine-app.com/callback
  &scope=read write offline_access
```

**Parameter:**
- `code_challenge` – SHA256-Hash des Verifiers
- `code_challenge_method=S256` – "Ich benutze SHA256"

### 3. Nach Login, Code gegen Token tauschen

```bash
POST https://oauth-provider.com/token

grant_type=authorization_code
code=AUTH_CODE_xyz
code_verifier=abcdef123456_abcdef123456_abcdef123456_
client_id=meine-app
redirect_uri=https://meine-app.com/callback
```

**Server prüft intern:**
```
SHA256(abcdef123456_abcdef123456_abcdef123456_) 
  ==  xyz789_xyz789_xyz789_?

✅ JA → Token geben!
```

---

## Warum PKCE notwendig ist

| Szenario | Ohne PKCE | Mit PKCE |
|----------|-----------|----------|
| **Hacker fängt Code ab** | ❌ Kann ihn sofort austauschen | ✅ Braucht auch `code_verifier` |
| **Mobile App** | ⚠️ Unsicher (Code in Browser) | ✅ Standard |
| **Single-Page App (SPA)** | ⚠️ Unsicher (Code in JS sichtbar) | ✅ Empfohlen |
| **Desktop App** | ⚠️ Unsicher (System-Browser) | ✅ Empfohlen |
| **Traditional Server-Rendered App** | ✅ OK (Backend versteckt Code) | ✅ Zusätzliche Sicherheit |

---

## Vergleich: `client_credentials` vs. `authorization_code` + PKCE

| Aspekt | **client_credentials** (Heute) | **authorization_code + PKCE** (Zukünftig) |
|--------|-------------------------------|-------------------------------------------|
| **Benutzer-Kontext** | ❌ NEIN (M2M) | ✅ JA (User-spezifisch) |
| **Login erforderlich?** | ❌ NEIN | ✅ JA |
| **Refresh-Token** | ❌ NEIN | ✅ JA (mit `offline_access`) |
| **Token-Renewal** | Neu anfordern | Refresh-Token austauschen |
| **Komplexität** | 🟢 Einfach | 🟡 Mittel |
| **Sicherheit** | 🟢 Gut für M2M | 🟢 Sehr gut für User-Auth |
| **Use-Case** | Service-to-Service | Benutzer-Anwendung |
| **PKCE erforderlich?** | ❌ NEIN | ✅ JA |

---

## Was bedeutet das für KNX IoT?

### Heute (client_credentials):
```javascript
// Backend ruft OAuth-Endpoint auf
POST /oauth/access
  grant_type=client_credentials
  client_id=knx-service-xyz
  client_secret=geheim
  scope=read write manage

// Antwort: { access_token, expires_in }
// Kein refresh_token!
```

### Zukünftig, wenn User-Auth eingeführt wird (authorization_code + PKCE):
```
1. Benutzer öffnet Browser
2. Browser redirect zu /authorize
3. Benutzer loggt sich ein
4. Backend tauscht Code gegen Tokens
5. Backend erhält: { access_token, refresh_token }
6. Token wird benutzer-spezifisch (nicht mehr M2M)
7. Mit Refresh-Token: Sessions bleiben länger gültig
8. PKCE schützt den Code-Austausch
```

---

## Zusammenfassung

| Begriff | Erklärung |
|---------|-----------|
| **`authorization_code`** | OAuth2 Flow, bei dem Benutzer sich einloggt und ein kurz-lebiger Code vergeben wird |
| **Code-Tausch** | Backend tauscht Code gegen langlebige Tokens (Access + Refresh) mit `client_secret` |
| **PKCE** | Sicherheits-Layer: Client beweist, dass er den Code generiert hat |
| **`code_verifier`** | Geheimer String (43+ Zeichen), den nur der Client kennt |
| **`code_challenge`** | SHA256-Hash des Verifiers, der zum OAuth-Server gesendet wird |
| **`code_challenge_method=S256`** | "Ich benutze SHA256 für die Challenge" |
| **Warum zusammen?** | `authorization_code` für Benutzer-Kontext + `PKCE` für Sicherheit |

---

## Nächste Schritte

- **Lokales Testen:** Siehe `keycloak-refresh-test.md` für eine vollständige PowerShell & Bash-Anleitung
- **Überblick:** Siehe `overview.md` für einen Vergleich aller OAuth-Flows
- **Aktuelles Setup:** Siehe `current-api-auth.md` für das derzeitige `client_credentials`-Setup

---

## Ressourcen

- **RFC 6749** – OAuth 2.0 Authorization Framework: https://tools.ietf.org/html/rfc6749
- **RFC 7636** – OAuth 2.0 Proof Key for Code Exchange (PKCE): https://tools.ietf.org/html/rfc7636
- **OpenID Connect** (Identity Layer on top of OAuth 2.0): https://openid.net/connect/
