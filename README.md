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
6. Falls die URL von `REDIRECT_URI` abweicht: `wrangler.toml` anpassen und
   erneut deployen.
7. Bei Sonos (developer.sonos.com → deine Integration) als Redirect-URI
   exakt `https://sonos-relay.<dein-subdomain>.workers.dev/callback`
   eintragen.

### Ohne Wrangler: im Cloudflare-Dashboard aktualisieren

1. dash.cloudflare.com → **Workers & Pages** → `sonos-relay`
2. **Edit code** → den gesamten Inhalt durch `src/index.js` ersetzen
   (am Ende muss `return Response.redirect(target, 302);` und `}` stehen)
3. **Deploy**

Variablen und das Secret unter **Settings → Variables and Secrets** bleiben
dabei unverändert. Achtung: Ein späteres `wrangler deploy` überschreibt den
im Dashboard eingefügten Code mit dem Stand des Repos.

## Testen

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
