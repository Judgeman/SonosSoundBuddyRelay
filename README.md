# sonos-relay

Cloudflare Worker, der den Sonos-OAuth-Callback entgegennimmt, den
Authorization-Code serverseitig gegen Tokens tauscht und die Tokens per
Redirect an die Android-App weiterreicht.

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
   Wrangler gibt dir danach die finale URL aus, z.B.
   `https://sonos-relay.<dein-subdomain>.workers.dev`
6. Falls die URL in Schritt 5 von dem abweicht, was du in `REDIRECT_URI`
   vermutet hast: `wrangler.toml` anpassen und erneut deployen.
7. Bei Sonos (developer.sonos.com → deine Integration) als Redirect-URI
   exakt `https://sonos-relay.<dein-subdomain>.workers.dev/callback`
   eintragen.

## Endpunkte

- `GET /callback` — OAuth-Redirect von Sonos, tauscht den Code gegen Tokens
  und leitet auf `sonoscontrol://callback?access_token=…&refresh_token=…&expires_in=…`
  weiter.
- `POST /refresh` — Body `{"refresh_token": "…"}`. Holt bei Sonos einen
  neuen Access-Token (Access-Tokens laufen nach 24 h ab).
  - `200 {"access_token", "refresh_token", "expires_in"}`
  - `401 {"error": "invalid_grant"}` — Refresh-Token ungültig/widerrufen,
    die App muss sich neu anmelden
  - `400 {"error": "invalid_request"}` — kein `refresh_token` im Body
  - `502` — Sonos nicht erreichbar oder anderer Fehler, später erneut versuchen

## Testen

```
curl -i "https://sonos-relay.<dein-subdomain>.workers.dev/"
```
sollte "Sonos OAuth relay is running." liefern.

Refresh testen:
```
curl -i -X POST "https://sonos-relay.<dein-subdomain>.workers.dev/refresh" \
  -H "Content-Type: application/json" \
  -d '{"refresh_token":"<refresh-token>"}'
```

Den vollständigen Login-Flow testest du am einfachsten direkt aus der
Android-App heraus (siehe SonosSpeakers-Projekt).
