# Keycloak: Refresh-Token-Test (Referenz-Anleitung)

## Dokumentationszweck

Dieses Dokument beschreibt, wie ein `refresh_token`-Flow mit **Keycloak lokal getestet werden kann** (Windows PowerShell-kompatibel).

**Wichtig:** Dies ist eine **Referenz-Testanleitung** für einen zukünftigen, User-basierten OAuth-Flow. Sie ist **nicht Teil des aktuellen KNX IoT Setups**, das `client_credentials` nutzt (siehe `current-api-auth.md`).

Nutzung:
- Zum Verstehen von Refresh-Token-Flows
- Zum lokalen Testen mit einer Test-Keycloak-Instanz
- Als Template, falls KNX IoT später zu User-Authentication wechselt

---

## Kurzfazit

- Mit Keycloak lässt sich `refresh_token` zuverlässig testen.
- `client_credentials` liefert typischerweise **kein** `refresh_token`.
- Für Refresh-Tests wird ein User-Flow benötigt: `authorization_code` + PKCE.

---

## Voraussetzungen in Keycloak

- Realm vorhanden
- Client vorhanden (z. B. `YOUR_CLIENT_ID`)
- Client-Einstellungen:
  - `Standard Flow Enabled = ON`
  - PKCE aktiv (bei Public Client)
  - `Valid Redirect URIs` enthält z. B. `http://localhost:8085/callback`
- Scopes:
  - mindestens `openid`
  - optional/empfohlen `offline_access` (für langlebige Refresh Tokens)

### Linux Debian 13 Tools

```bash
sudo apt update
sudo apt install -y curl jq openssl xdg-utils
```

---

## Variablen (PowerShell)

```powershell
$KC_BASE      = "http://localhost:8080"
$REALM        = "YOUR_REALM"
$CLIENT_ID    = "YOUR_CLIENT_ID"
$REDIRECT_URI = "http://localhost:8085/callback"
$SCOPE        = "openid profile offline_access"

$AUTH_ENDPOINT  = "$KC_BASE/realms/$REALM/protocol/openid-connect/auth"
$TOKEN_ENDPOINT = "$KC_BASE/realms/$REALM/protocol/openid-connect/token"
```

## Variablen (Linux Debian 13 / Bash)

```bash
KC_BASE="http://localhost:8080"
REALM="YOUR_REALM"
CLIENT_ID="YOUR_CLIENT_ID"
REDIRECT_URI="http://localhost:8085/callback"
SCOPE="openid profile offline_access"

AUTH_ENDPOINT="$KC_BASE/realms/$REALM/protocol/openid-connect/auth"
TOKEN_ENDPOINT="$KC_BASE/realms/$REALM/protocol/openid-connect/token"
```

---

## Schritt 1: PKCE erzeugen und Login-URL bauen

```powershell
Add-Type -AssemblyName System.Web

function New-Base64Url([byte[]]$bytes) {
    [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
}

# code_verifier
$verifierBytes = New-Object byte[] 64
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($verifierBytes)
$CODE_VERIFIER = New-Base64Url $verifierBytes

# code_challenge = BASE64URL(SHA256(code_verifier))
$sha = [Security.Cryptography.SHA256]::Create()
$hash = $sha.ComputeHash([Text.Encoding]::ASCII.GetBytes($CODE_VERIFIER))
$CODE_CHALLENGE = New-Base64Url $hash

# state
$stateBytes = New-Object byte[] 16
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($stateBytes)
$STATE = New-Base64Url $stateBytes

$authUrl =
    "$AUTH_ENDPOINT" +
    "?response_type=code" +
    "&client_id=$([System.Web.HttpUtility]::UrlEncode($CLIENT_ID))" +
    "&redirect_uri=$([System.Web.HttpUtility]::UrlEncode($REDIRECT_URI))" +
    "&scope=$([System.Web.HttpUtility]::UrlEncode($SCOPE))" +
    "&code_challenge=$([System.Web.HttpUtility]::UrlEncode($CODE_CHALLENGE))" +
    "&code_challenge_method=S256" +
    "&state=$([System.Web.HttpUtility]::UrlEncode($STATE))"

$authUrl
# Optional: Start-Process $authUrl
```

```bash
# PKCE + State erzeugen
CODE_VERIFIER="$(openssl rand -base64 64 | tr -d '=\n' | tr '/+' '_-')"
CODE_CHALLENGE="$(printf '%s' "$CODE_VERIFIER" | openssl dgst -binary -sha256 | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
STATE="$(openssl rand -hex 16)"

# URL-encoding mit jq
AUTH_URL="${AUTH_ENDPOINT}?response_type=code&client_id=$(jq -rn --arg v "$CLIENT_ID" '$v|@uri')&redirect_uri=$(jq -rn --arg v "$REDIRECT_URI" '$v|@uri')&scope=$(jq -rn --arg v "$SCOPE" '$v|@uri')&code_challenge=$(jq -rn --arg v "$CODE_CHALLENGE" '$v|@uri')&code_challenge_method=S256&state=$(jq -rn --arg v "$STATE" '$v|@uri')"

echo "$AUTH_URL"
# Optional im Browser öffnen:
# xdg-open "$AUTH_URL"
```

Nach Login wirst du auf `REDIRECT_URI` umgeleitet, z. B.:

`http://localhost:8085/callback?code=AUTH_CODE&state=...`

Den `code` kopieren:

```powershell
$AUTH_CODE = "PASTE_AUTH_CODE_HERE"
```

```bash
AUTH_CODE="PASTE_AUTH_CODE_HERE"
```

---

## Schritt 2: Code gegen Token tauschen

```powershell
$tokenResponse = Invoke-RestMethod -Method Post -Uri $TOKEN_ENDPOINT -ContentType "application/x-www-form-urlencoded" -Body @{
    grant_type    = "authorization_code"
    client_id     = $CLIENT_ID
    code          = $AUTH_CODE
    redirect_uri  = $REDIRECT_URI
    code_verifier = $CODE_VERIFIER
}

$ACCESS_TOKEN  = $tokenResponse.access_token
$REFRESH_TOKEN = $tokenResponse.refresh_token

$tokenResponse | ConvertTo-Json -Depth 6
```

```bash
token_response="$(curl -sS -X POST "$TOKEN_ENDPOINT" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "code=$AUTH_CODE" \
  --data-urlencode "redirect_uri=$REDIRECT_URI" \
  --data-urlencode "code_verifier=$CODE_VERIFIER")"

ACCESS_TOKEN="$(printf '%s' "$token_response" | jq -r '.access_token')"
REFRESH_TOKEN="$(printf '%s' "$token_response" | jq -r '.refresh_token')"

printf '%s\n' "$token_response" | jq
```

Erwartung:

- `access_token` vorhanden
- `refresh_token` vorhanden
- `expires_in` gesetzt

---

## Schritt 3: Refresh-Token testen

```powershell
$refreshResponse = Invoke-RestMethod -Method Post -Uri $TOKEN_ENDPOINT -ContentType "application/x-www-form-urlencoded" -Body @{
    grant_type    = "refresh_token"
    client_id     = $CLIENT_ID
    refresh_token = $REFRESH_TOKEN
}

$NEW_ACCESS_TOKEN  = $refreshResponse.access_token
$NEW_REFRESH_TOKEN = $refreshResponse.refresh_token  # ggf. rotiert

$refreshResponse | ConvertTo-Json -Depth 6
```

```bash
refresh_response="$(curl -sS -X POST "$TOKEN_ENDPOINT" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "grant_type=refresh_token" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "refresh_token=$REFRESH_TOKEN")"

NEW_ACCESS_TOKEN="$(printf '%s' "$refresh_response" | jq -r '.access_token')"
NEW_REFRESH_TOKEN="$(printf '%s' "$refresh_response" | jq -r '.refresh_token')"

printf '%s\n' "$refresh_response" | jq
```

Hinweis: Bei Rotation immer den neuesten `refresh_token` speichern.

---

## Schritt 4: Token sofort verifizieren (Optional)

```powershell
$USERINFO_ENDPOINT = "$KC_BASE/realms/$REALM/protocol/openid-connect/userinfo"

Invoke-RestMethod -Method Get -Uri $USERINFO_ENDPOINT -Headers @{
    Authorization = "Bearer $NEW_ACCESS_TOKEN"
} | ConvertTo-Json -Depth 6
```

```bash
USERINFO_ENDPOINT="$KC_BASE/realms/$REALM/protocol/openid-connect/userinfo"

curl -sS "$USERINFO_ENDPOINT" \
  -H "Authorization: Bearer $NEW_ACCESS_TOKEN" | jq
```

---

## Fehleranalyse

### `invalid_redirect_uri`

- Redirect URI nicht exakt im Client registriert.
- Überprüfe: Keycloak Client-Einstellung `Valid Redirect URIs`

### `invalid_grant` beim Code-Exchange

- Falscher/abgelaufener Code
- Falscher `code_verifier`
- Falsche `redirect_uri`

### `invalid_grant` beim Refresh

- Refresh-Token abgelaufen/invalidiert
- Bereits rotiert und alter Token erneut benutzt

---

## Sicherheits- und Implementierungshinweise

- Access-Token und Ablaufzeit cachen.
- Kurz vor Ablauf proaktiv refreshen (z. B. 60 Sekunden Puffer).
- Bei `401` einmal refresh + retry.
- Refresh-Token sicher speichern.
- Bei `invalid_grant` Re-Login/Neuautorisierung starten.

## HTTP lokal vs. HTTPS in Staging/Prod

- Lokaler Test darf mit `http://localhost` erfolgen (z. B. `http://localhost:8085/callback`).
- In Staging/Produktion immer `https://` für Keycloak, Redirect-URI und API-Verkehr verwenden.
- `localhost`-Ausnahme nicht auf Hostnamen/IPs übertragen (z. B. `http://192.168.x.x` vermeiden).
- Redirect-URIs in Keycloak strikt trennen (Dev vs. Staging/Prod), keine Wildcards in produktiven Umgebungen.
- TLS-Zertifikate in Staging/Prod validieren; keine unsicheren Client-Bypasses (`-k`/`--insecure`).

---

## Verwandte Dokumente

- `current-api-auth.md` – Das aktuelle KNX IoT Setup (client_credentials)
- `overview.md` – Vergleich aller OAuth-Flow-Varianten
