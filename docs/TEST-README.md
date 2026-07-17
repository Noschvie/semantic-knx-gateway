# KNX IP Secure Integration Tests

Anleitung zur Durchführung der Unit- und Integration-Tests für die KNX IP Secure-Implementierung.

**Spezifikation**: `KNX_IP_Secure_Integration_Specification.md` §11

---

## Übersicht

Zwei Test-Suites sind verfügbar:

| Test-Suite | Typ | Umgebung | Dauer | Anforderungen |
|-----------|-----|---------|-------|--------------|
| `test-tunnel-options.js` | Unit-Test | Lokal oder eibesthal | ~2s | Node.js |
| `test-knx-secure-integration.sh` | Integration-Test | eibesthal | ~30s+ | Node.js, semantic-knx-gateway, (optional: Keyring + KNX-Hardware) |

---

## Unit-Tests (`test-tunnel-options.js`)

### Zweck

Testet `createTunnelOptions()` direkt – schneller, Hardware-unabhängig, keine laufende Applikation nötig.

**Szenarien (Spec §11 – Classic Mode)**

- ✓ Classic TunnelUDP (Defaults)
- ✓ Classic TunnelUDP (Explizit)
- ✓ Classic TunnelTCP (Explizit)

**Szenarien (Spec §11 – Secure Mode)**

- ✓ Secure Mode mit gültigem Keyring
- ✗ Secure Mode – fehlende Keyring-Datei (Fehler erwartet)
- ✗ Secure Mode – fehlend Passwort (Fehler erwartet)
- ✗ Secure Mode – Keyring-Datei existiert nicht (Fehler erwartet)
- ✓ Secure Mode – TCP wird erzwungen, auch wenn UDP angefordert

**Szenarien (Umgebungsvariablen-Parsing)**

- ✓ `KNX_SECURE="1"` → true
- ✓ `KNX_SECURE="yes"` → true

### Durchführung

#### Option 1: Lokal (auf Entwicklungs-PC)

```bash
# tunnel-options.js in Ihr Projekt kopieren
cp tunnel-options.js /path/to/semantic-knx-gateway/src/southside/

# Unit-Test ausführen
node --input-type=module --eval \
  "$(cat test-tunnel-options.js)" \
  || chmod +x test-tunnel-options.js && ./test-tunnel-options.js
```

#### Option 2: Auf eibesthal

```bash
# SSH zu eibesthal
ssh noschvie@eibesthal.sieben.neunzehn.at

# In das semantic-knx-gateway-Verzeichnis gehen
cd ~/semantic-knx-gateway

# Unit-Test ausführen
node /home/noschvie/test-tunnel-options.js
```

### Erwartetes Ergebnis

```
[HH:MM:SS] ✓ KNX_SECURE unset, KNX_HOST_PROTOCOL unset → defaults to TunnelUDP
[HH:MM:SS] ✓ KNX_SECURE=false, KNX_HOST_PROTOCOL=TunnelUDP → Classic TunnelUDP
[HH:MM:SS] ✓ KNX_SECURE=true, valid keyring file, valid password → Secure TunnelTCP
...
✓ All 10 tests passed (100%)
```

---

## Integration-Tests (`test-knx-secure-integration.sh`)

### Zweck

Testet die tatsächliche `semantic-knx-gateway`-Applikation mit verschiedenen Konfigurationen.

**Szenarien (Spec §11)**

- ✓ Classic TunnelUDP – startup
- ✓ Classic TunnelTCP – startup
- ✓ Secure Mode – startup mit gültigem Keyring (falls vorhanden)
- ✗ Secure Mode – startup ohne Keyring-Datei (Fehler-Szenario)
- ✗ Secure Mode – startup mit ungültigem Passwort (Fehler-Szenario)

### Voraussetzungen

#### Basis (alle Tests)

```bash
# 1. semantic-knx-gateway repo vorhanden
cd ~/semantic-knx-gateway
npm install

# 2. Node.js
node --version
# v22.22.2 oder höher

# 3. KNX-Gateway-Adresse + Port bekannt
export KNX_GATEWAY_IP="192.168.1.1"
export KNX_GATEWAY_PORT="3671"
export KNX_GATEWAY_PHYS_ADDR="1.1.1"
```

#### Für Secure-Mode-Tests (optional)

```bash
# 1. ETS Keyring-Datei exportiert von eibesthal (Weinzierl 732 Secure)
export KEYRING_FILE="/path/to/exported-keyring.knxkeys"

# 2. Keyring-Passwort
export KEYRING_PASSWORD="your-keyring-password"
```

### Durchführung

#### Schritt 1: Script auf eibesthal bereitstellen

```bash
scp test-knx-secure-integration.sh noschvie@eibesthal.sieben.neunzehn.at:~/
ssh noschvie@eibesthal.sieben.neunzehn.at "chmod +x ~/test-knx-secure-integration.sh"
```

#### Schritt 2: Tests ausführen

```bash
# SSH zu eibesthal
ssh noschvie@eibesthal.sieben.neunzehn.at

# Umgebungsvariablen setzen
export SEMANTIC_KNX_REPO=~/semantic-knx-gateway
export KNX_GATEWAY_IP="192.168.1.1"
export KNX_GATEWAY_PORT="3671"
export KNX_GATEWAY_PHYS_ADDR="1.1.1"

# Optional: Keyring-Konfiguration (falls Secure-Tests erwünscht)
export KEYRING_FILE="/path/to/keyring.knxkeys"
export KEYRING_PASSWORD="your-password"

# Tests ausführen
bash ~/test-knx-secure-integration.sh
```

#### Schritt 3: Ergebnisse prüfen

```
KNX Secure Integration Tests
Spec §11: Classic & Secure Mode Scenarios

ℹ semantic-knx-gateway found
ℹ Node.js v22.22.2 found

────────────────────────────────────────
Test 1: Classic Mode (TunnelUDP)
────────────────────────────────────────
ℹ Starting app in Classic TunnelUDP mode...
✓ App started successfully
✓ Classic TunnelUDP startup

────────────────────────────────────────
Test 2: Classic Mode (TunnelTCP)
────────────────────────────────────────
ℹ Starting app in Classic TunnelTCP mode...
✓ App started successfully
✓ Classic TunnelTCP startup

────────────────────────────────────────
Test Summary
────────────────────────────────────────
✓ All 2 tests passed (100%)
```

---

## Szenarien – Detailemahlung

### Classic Mode (TunnelUDP) – Default

**Konfiguration:**
```bash
export KNX_SECURE=false
export KNX_HOST_PROTOCOL=TunnelUDP
```

**Erwartet:**
- App startet, verbindet sich mit KNX-Gateway über UDP
- Log: `connection mode: Classic (TunnelUDP)`
- Kein Secure-Session-Aufbau

---

### Classic Mode (TunnelTCP) – Explizit

**Konfiguration:**
```bash
export KNX_SECURE=false
export KNX_HOST_PROTOCOL=TunnelTCP
```

**Erwartet:**
- App startet, verbindet sich mit KNX-Gateway über TCP
- Log: `connection mode: Classic (TunnelTCP)`
- Kein Secure-Session-Aufbau

---

### Secure Mode – Valid Keyring

**Konfiguration:**
```bash
export KNX_SECURE=true
export KNX_HOST_PROTOCOL=TunnelUDP  # wird zu TunnelTCP erzwungen
export KNX_KEYRING_FILE="/path/to/keyring.knxkeys"
export KNX_KEYRING_PASSWORD="keyring-password"
```

**Erwartet:**
- App startet
- Log: `connection mode: Secure (TunnelTCP)`
- Log bei erfolgreichem Session-Aufbau: `Secure session established`
- Applikation läuft normal

**Fehlerfall – Ungültiges Passwort:**
- Secure Session kann nicht hergestellt werden
- Log zeigt Authentifizierungsfehler (von KNXUltimate)
- App: Retry oder Shutdown (je nach Implementierung)

---

### Secure Mode – Missing Keyring File

**Konfiguration:**
```bash
export KNX_SECURE=true
unset KNX_KEYRING_FILE
export KNX_KEYRING_PASSWORD="password"
```

**Erwartet (Fail-Fast):**
- `createTunnelOptions()` wirft Fehler **vor** dem Verbindungsversuch
- Log: `Invalid KNX tunnel configuration: KNX_SECURE=true requires KNX_KEYRING_FILE`
- App startet nicht

---

### Secure Mode – Missing Password

**Konfiguration:**
```bash
export KNX_SECURE=true
export KNX_KEYRING_FILE="/path/to/keyring.knxkeys"
unset KNX_KEYRING_PASSWORD
```

**Erwartet (Fail-Fast):**
- `createTunnelOptions()` wirft Fehler **vor** dem Verbindungsversuch
- Log: `Invalid KNX tunnel configuration: KNX_SECURE=true requires KNX_KEYRING_PASSWORD`
- App startet nicht

---

## Fehlerbehebung

### Unit-Tests

#### Fehler: `Cannot find module 'tunnel-options.js'`

Stelle sicher, dass `tunnel-options.js` im selben Verzeichnis wie `test-tunnel-options.js` liegt oder der Import-Pfad angepasst ist.

```bash
# Kopiere die Dateien in ein Test-Verzeichnis
mkdir ~/knx-secure-tests
cp tunnel-options.js tunnel-manager.js test-tunnel-options.js ~/knx-secure-tests/
cd ~/knx-secure-tests
node test-tunnel-options.js
```

#### Fehler: `fs.existsSync is not a function`

Dies kann vorkommen, wenn eine ältere Node.js-Version verwendet wird. Upgrade auf **v20+**:

```bash
node --version
# Falls < v20: Update nötig
```

---

### Integration-Tests

#### Fehler: `semantic-knx-gateway repo not found`

```bash
export SEMANTIC_KNX_REPO=/path/to/semantic-knx-gateway
# oder
bash test-knx-secure-integration.sh  # Nutzt aktuelles Verzeichnis
```

#### Fehler: `npm start` blockiert / wird nicht beendet

Das Skript nutzt Timeouts und Signale. Falls App nicht terminiert:

```bash
# Manuelle Cleanup
pkill -f "node.*semantic-knx-gateway"
```

#### Log zeigt keine Connection-Mode-Bestätigung

Das ist normal, wenn die App nur beim Startup loggt. Prüfe manuell:

```bash
# Tail der Logs während der App läuft
tail -f /path/to/semantic-knx-gateway/logs/error.log | grep "connection mode"
```

---

## Integration in CI/CD

Die Unit-Tests können in eine CI/CD-Pipeline integriert werden:

```yaml
# GitHub Actions Beispiel
- name: Run KNX Secure Unit Tests
  run: |
    cd ${{ github.workspace }}/semantic-knx-gateway
    node test-tunnel-options.js
  continue-on-error: false
```

Integration-Tests erfordern eine echte KNX-Umgebung (eibesthal) und eignen sich besser für Nightly-Tests oder manuelle Validierung.

---

## Weiterführendes

### Zusätzliche Tests (Future)

Folgende Szenarien sind für zukünftige Erweiterung reserviert (Spec §11):

- [ ] Reconnect-Verhalten nach Weinzierl-Neustart
- [ ] Datenverlust-Vermeidung bei Neuverbindung
- [ ] Telegram-Queue-Verhalten unter Disconnect/Reconnect
- [ ] Performance-Vergleich: Classic vs. Secure Mode
- [ ] Automatische Capability-Erkennung (Fallback Classic ← Secure bei Fehler)

### Dokumentation

- `KNX_IP_Secure_Integration_Specification.md` – Detaillierte Architektur-Spezifikation
- `tunnel-options.js` – Inline-Kommentare zu ENV-Variablen und Fehlerbehandlung
- `tunnel-manager.js` – Änderungen zum bestehenden Code (§7: minimal)

---

## Kontakt

Fragen zur Implementierung oder Tests bitte an:
- **GitHub Issues**: https://github.com/Noschvie/semantic-knx-gateway
- **eibesthal-Logs**: `/home/noschvie/semantic-knx-gateway/logs/`

---

**Letzte Aktualisierung**: 2026-02-17  
**Spec-Version**: KNX IP Secure Integration Specification v1.0
