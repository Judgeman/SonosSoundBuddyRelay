# sonos-relay

Cloudflare Worker für die Android-App
[Sound Buddy](https://github.com/Judgeman/SonosSoundBuddy). Er hält das
Sonos-Client-Secret, das nicht in die App gehört, und übernimmt damit alle
Token-Anfragen bei Sonos:

- **Login:** nimmt den OAuth-Callback entgegen, tauscht den
  Authorization-Code gegen Tokens und reicht sie per Redirect an die App
  weiter.
- **Erneuern:** tauscht den Refresh-Token der App gegen einen neuen
  Access-Token. Sonos-Access-Tokens laufen nach 24 h ab.
- **Abgleich zwischen Tablets** (optional): speichert den Stand eines
  Haupt-Tablets (Kinder-Profile, Musikauswahl, Bilder, Speaker-Einstellungen,
  Passwort-Hash), damit andere Tablets ihn automatisch übernehmen können.
  Außerdem gleichen alle Tablets ab, welche Musik welches Kind schon
  gespielt hat — die App markiert noch nie gespielte Musik als neu.

> **Wo die Daten liegen:** Für den Abgleich speichert der Worker die
> Einstellungen der App im KV-Speicher des Cloudflare-Accounts, in dem er
> läuft — also beim Betreiber des Workers. Dazu gehören die Namen der Kinder,
> eigene Fotos, die Musikauswahl, welche Musik schon gespielt wurde und der
> Passwort-Hash der Einstellungen.
> Wer das Repo kopiert und einen eigenen Worker deployt, speichert die Daten
> in seinem eigenen Account. Wer die App mit dem Worker eines anderen nutzt,
> gibt diese Daten an dessen Betreiber. Ohne KV-Binding speichert der Worker
> nichts.

## Endpunkte

### `GET /callback`

OAuth-Redirect von Sonos (`?code=…&state=…`). Tauscht den Code gegen Tokens
und leitet weiter auf

```
sonoscontrol://callback?access_token=…&refresh_token=…&expires_in=…&state=…
```

Bei Fehlern wird stattdessen `?error=…&state=…` weitergereicht.

### `POST /refresh`

Body: `{"refresh_token": "…"}`

| Status | Antwort | Bedeutung für die App |
|---|---|---|
| `200` | `{"access_token", "refresh_token", "expires_in"}` | Neue Tokens speichern. Liefert Sonos keinen neuen Refresh-Token, kommt der bisherige zurück. |
| `401` | `{"error": "invalid_grant"}` | Refresh-Token ungültig oder widerrufen → neu anmelden |
| `400` | `{"error": "invalid_request"}` | Kein `refresh_token` im Body |
| `502` | `{"error": "token_request_failed" \| "token_refresh_failed"}` | Sonos nicht erreichbar oder lehnt die Client-Daten ab → Anmeldung behalten, später erneut versuchen |
| `500` | `{"error": "internal_error", "message": …}` | Unerwarteter Fehler im Worker (enthält keine Secrets) |

Nur `401` bedeutet „neu anmelden“. So führt ein falsch konfigurierter Worker
nicht dazu, dass die App abgemeldet wird.

### `/sync/…` — Abgleich zwischen Tablets

Jede Anfrage braucht den Sonos-Access-Token der App
(`Authorization: Bearer …`) und den Sonos-Haushalt (`?household=…`). Der
Worker fragt bei Sonos (`GET /households`), welche Haushalte zu dem Token
gehören, und erlaubt nur diese. Alle Daten liegen unter dem Haushalt
(`hh:<household>:…`). Verschiedene Sonos-Konten und Haushalte sehen und
überschreiben sich also nie gegenseitig.

| Aufruf | Bedeutung |
|---|---|
| `GET /sync/state` | `{version, updatedAt, deviceName}` des zuletzt hochgeladenen Stands, `404 not_found` wenn es keinen gibt |
| `GET /sync/snapshot` | `{version, updatedAt, deviceName, snapshot}` |
| `POST /sync/images/missing` | Body `{"hashes": [...]}` → `{"missing": [...]}`: welche Bilder noch hochgeladen werden müssen |
| `PUT /sync/images/<sha256>` | Bild hochladen (max. 5 MB); der Name muss der SHA-256 des Inhalts sein |
| `GET /sync/images/<sha256>` | Bild abholen |
| `PUT /sync/snapshot` | Body `{"deviceName", "images": [...], "snapshot": {...}}`; alle Bilder müssen vorher hochgeladen sein (sonst `409 missing_images`). Nicht mehr gebrauchte Bilder werden gelöscht. |
| `GET /sync/played` | `{"entries": [...]}`: die Listen aller Tablets des Haushalts zusammengeführt (leer, wenn noch nichts) |
| `PUT /sync/played/<tablet>` | Body `{"entries": [...]}`; ersetzt die Liste dieses Tablets (Kennung aus `A–Z a–z 0–9 _ -`, höchstens 64 Zeichen; höchstens 20 000 Einträge, 5 MB) |
| `DELETE /sync` | Löscht Stand, Bilder und gespielte Musik des Haushalts |

Den Stand lädt nur das Haupt-Tablet hoch, die gespielte Musik dagegen jedes
Tablet. Ein Eintrag sagt, ob ein Kind-Profil eine Musik schon gespielt hat:

```json
{"profileSyncId": "3f2c…", "musicKey": "FAVORITE:12:Bibi Blocksberg", "played": true, "changedAt": 1760100000000}
```

`played: false` heißt: von den Eltern wieder als neu markiert. `changedAt`
ist der Zeitpunkt der Änderung in Millisekunden. Damit sich zwei Tablets
nicht gegenseitig überschreiben, hat jedes seinen eigenen Eintrag
(`hh:<household>:played/<tablet>`). `GET` führt alle zusammen: Je Profil und
Musik gewinnt die neueste Änderung, bei gleichem Zeitpunkt „gespielt“ —
dieselbe Regel wie in der App. So kommt auch „wieder neu“ bei allen Tablets
an.

Fehler: `401 invalid_token` (Token fehlt oder Sonos lehnt ihn ab → App
erneuert ihn), `403 forbidden_household` (Token gehört nicht zu dem
Haushalt), `501 sync_not_configured` (kein KV-Binding), `502
sonos_unreachable`. Pro Stand sind höchstens 400 Bilder erlaubt, weil
Cloudflare je Aufruf nur 1000 KV-Zugriffe zulässt.

Im kostenlosen Tarif erlaubt KV 1000 Schreibvorgänge am Tag. Ein Upload
schreibt zwei Einträge plus jedes neue Bild; die App lädt nur hoch, wenn sich
etwas geändert hat. Die Tablets fragen alle 5 Minuten `GET /sync/state` und
`GET /sync/played` ab, solange die App offen ist, und `GET /sync/played`
zusätzlich beim Öffnen der Musikauswahl (höchstens alle 30 Sekunden). Die
gespielte Musik schreibt ein Tablet nur, wenn es etwas kennt, das in der Cloud
noch fehlt — meist, weil dort gerade zum ersten Mal etwas gespielt wurde.

### `GET /`

Lebenszeichen: „Sonos OAuth relay is running.“

## Setup

1. `npm install`
2. `npx wrangler login`
3. In `wrangler.toml`:
   - `SONOS_CLIENT_ID` eintragen (aus dem Sonos Developer Portal)
   - `REDIRECT_URI` auf die eigene Worker-URL setzen (siehe Schritt 5)
4. Secret setzen (landet NICHT in wrangler.toml / Git):
   ```
   npx wrangler secret put SONOS_CLIENT_SECRET
   ```
5. Deployen:
   ```
   npx wrangler deploy
   ```
   Wrangler gibt danach die finale URL aus, z. B.
   `https://sonos-relay.<dein-subdomain>.workers.dev`
6. Optional, für den Abgleich zwischen Tablets: KV-Speicher anlegen
   ```
   npx wrangler kv namespace create SYNC_KV
   ```
   und die ausgegebene `id` im `[[kv_namespaces]]`-Block in `wrangler.toml`
   eintragen (Block einkommentieren), dann erneut deployen. Hinweis oben zu
   den gespeicherten Daten beachten.
7. Falls die URL von `REDIRECT_URI` abweicht: `wrangler.toml` anpassen und
   erneut deployen.
8. Bei Sonos (developer.sonos.com → deine Integration) als Redirect-URI
   exakt `https://sonos-relay.<dein-subdomain>.workers.dev/callback`
   eintragen.

### Ohne Wrangler: im Cloudflare-Dashboard aktualisieren

1. dash.cloudflare.com → **Workers & Pages** → `sonos-relay`
2. **Edit code** → den gesamten Inhalt durch `src/index.js` ersetzen
   (am Ende muss `return Response.redirect(target, 302);` und `}` stehen)
3. **Deploy**

Ein späteres `wrangler deploy` setzt die Bindings auf den Stand von
`wrangler.toml` — dann den `[[kv_namespaces]]`-Block dort mit derselben id
eintragen, sonst ist der Abgleich danach abgeschaltet (die Daten bleiben im
Namespace erhalten).

Variablen und das Secret unter **Settings → Variables and Secrets** bleiben
dabei unverändert.

Für den Abgleich zwischen Tablets zusätzlich einmalig:

1. **Storage & Databases → KV** → **Create** → Name z. B. `soundbuddy-sync`
2. Zurück beim Worker: **Settings → Bindings → Add → KV namespace**,
   Variable name `SYNC_KV`, den eben angelegten Namespace wählen
3. **Deploy** Achtung: Ein späteres `wrangler deploy` überschreibt den
im Dashboard eingefügten Code mit dem Stand des Repos.

## Testen

Automatische Tests für den Abgleich (KV und Sonos werden nachgebaut, ohne
Netz und ohne Abhängigkeiten):

```
npm test
```

Lebenszeichen:

```
curl -i "https://sonos-relay.<dein-subdomain>.workers.dev/"
```

`/refresh` mit einem absichtlich falschen Token. Erwartet wird
`401 {"error":"invalid_grant"}`. `502` deutet auf falsche Client-ID oder
falsches Secret hin, `404` auf einen veralteten Deploy.

```
curl -i -X POST "https://sonos-relay.<dein-subdomain>.workers.dev/refresh" \
  -H "Content-Type: application/json" \
  -d '{"refresh_token":"test"}'
```

Unter Windows/PowerShell (dort ist `curl` ein Alias für `Invoke-WebRequest`):

```powershell
try {
    $r = Invoke-WebRequest -Method Post -UseBasicParsing `
        -Uri "https://sonos-relay.<dein-subdomain>.workers.dev/refresh" `
        -ContentType "application/json" `
        -Body '{"refresh_token":"test"}'
    "$($r.StatusCode) $($r.Content)"
} catch {
    "$([int]$_.Exception.Response.StatusCode) $($_.ErrorDetails.Message)"
}
```

Fehlgeschlagene Token-Anfragen protokolliert der Worker mit der Antwort von
Sonos. Ansehen lassen sie sich mit `npx wrangler tail` oder im Dashboard
unter **Logs**.

Den vollständigen Login-Flow testest du am einfachsten direkt aus der
Android-App heraus.
