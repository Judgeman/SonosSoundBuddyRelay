/**
 * Sonos OAuth Relay
 *
 * Nimmt den Redirect von Sonos entgegen (?code=...&state=...), tauscht den
 * Code serverseitig gegen Access-/Refresh-Token (Client-Secret bleibt hier,
 * nie in der App) und reicht die Tokens per Redirect an die Android-App
 * weiter (Custom-URI-Scheme, z.B. sonoscontrol://callback?access_token=...).
 *
 * Zusätzlich erneuert POST /refresh einen abgelaufenen Access-Token mit dem
 * Refresh-Token der App — auch dafür braucht Sonos das Client-Secret.
 *
 * Unter /sync/… gleichen mehrere Tablets ihre Einstellungen ab (siehe unten,
 * „Abgleich zwischen Tablets“). Dafür braucht der Worker einen KV-Speicher
 * mit dem Binding SYNC_KV.
 */

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      // Statt Cloudflare-Fehler 1101 eine lesbare Antwort liefern (enthält keine Secrets)
      console.error("Unhandled worker error:", err?.stack ?? err);
      return json({ error: "internal_error", message: String(err?.message ?? err) }, 500);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);

  if (url.pathname === "/callback" && request.method === "GET") {
    return handleCallback(url, env);
  }

  if (url.pathname === "/refresh" && request.method === "POST") {
    return handleRefresh(request, env);
  }

  if (url.pathname === "/sync" || url.pathname.startsWith("/sync/")) {
    return handleSync(request, url, env);
  }

  if (url.pathname === "/") {
    return new Response("Sonos OAuth relay is running.", { status: 200 });
  }

  return new Response("Not found", { status: 404 });
}

async function handleCallback(url, env) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  const oauthError = url.searchParams.get("error");

  // Sonos hat den Login abgelehnt / Nutzer hat abgebrochen
  if (oauthError) {
    return redirectToApp(env, { error: oauthError, state });
  }

  if (!code) {
    return new Response("Missing 'code' parameter", { status: 400 });
  }

  const basicAuth = btoa(`${env.SONOS_CLIENT_ID}:${env.SONOS_CLIENT_SECRET}`);

  let tokenResponse;
  try {
    tokenResponse = await fetch("https://api.sonos.com/login/v3/oauth/access", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        // Muss exakt der redirect_uri entsprechen, mit der der Auth-Request
        // ursprünglich gestartet wurde (= diese Worker-URL selbst).
        redirect_uri: env.REDIRECT_URI,
      }).toString(),
    });
  } catch (err) {
    return redirectToApp(env, { error: "token_request_failed", state });
  }

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse.text();
    console.error("Sonos token exchange failed:", tokenResponse.status, errorBody);
    return redirectToApp(env, { error: "token_exchange_failed", state });
  }

  const tokenData = await tokenResponse.json();

  return redirectToApp(env, {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_in: tokenData.expires_in != null ? String(tokenData.expires_in) : undefined,
    state,
  });
}

/**
 * POST /refresh  Body: {"refresh_token": "..."}
 *
 * Antworten an die App:
 * - 200 {access_token, refresh_token, expires_in}
 * - 401 {error: "invalid_grant"}  Refresh-Token ungültig/widerrufen → App muss neu anmelden
 * - 400 {error: "invalid_request"} Body ohne refresh_token
 * - 502 {error: "..."}            Sonos nicht erreichbar oder anderer Fehler → später erneut versuchen
 */
async function handleRefresh(request, env) {
  let refreshToken;
  try {
    const body = await request.json();
    refreshToken = body?.refresh_token;
  } catch (err) {
    refreshToken = undefined;
  }
  if (typeof refreshToken !== "string" || refreshToken.length === 0) {
    return json({ error: "invalid_request" }, 400);
  }

  const basicAuth = btoa(`${env.SONOS_CLIENT_ID}:${env.SONOS_CLIENT_SECRET}`);

  let tokenResponse;
  try {
    tokenResponse = await fetch("https://api.sonos.com/login/v3/oauth/access", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
    });
  } catch (err) {
    return json({ error: "token_request_failed" }, 502);
  }

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse.text();
    console.error("Sonos token refresh failed:", tokenResponse.status, errorBody);
    let sonosError;
    try {
      sonosError = JSON.parse(errorBody)?.error;
    } catch (err) {
      sonosError = undefined;
    }
    // Nur ein abgelehnter Refresh-Token bedeutet "neu anmelden". Falsche
    // Client-Daten o.ä. sind ein Problem des Workers, nicht der App-Anmeldung.
    if (sonosError === "invalid_grant") {
      return json({ error: "invalid_grant" }, 401);
    }
    return json({ error: "token_refresh_failed" }, 502);
  }

  const tokenData = await tokenResponse.json();
  return json({
    access_token: tokenData.access_token,
    // Sonos liefert hier den (ggf. neuen) Refresh-Token mit — sonst den alten weiterverwenden
    refresh_token: tokenData.refresh_token ?? refreshToken,
    expires_in: tokenData.expires_in,
  });
}

// --- Abgleich zwischen Tablets -------------------------------------------
//
// Ein Tablet (das Haupt-Tablet) lädt seinen Stand hoch, die anderen holen ihn
// ab. Abgelegt wird alles im KV-Speicher SYNC_KV, getrennt nach Sonos-Haushalt:
//
//   hh:<household>:meta        {version, updatedAt, deviceName, images[]}
//   hh:<household>:snapshot    {version, updatedAt, deviceName, snapshot}
//   hh:<household>:img:<sha256> Bild (JPEG)
//   hh:<household>:played/<tablet> ["<Musik>", …] was dieses Tablet schon gespielt hat
//
// Was die Kinder schon gespielt haben, laden alle Tablets hoch, nicht nur das
// Haupt-Tablet. Jedes Tablet hat dafür einen eigenen Eintrag, abgeholt wird
// alles zusammen — so überschreiben sich zwei Tablets nie gegenseitig. Der
// Schrägstrich kommt in keiner Haushalts-Id vor: Beim Auflisten nach
// „hh:<household>:played/“ kann so kein Eintrag eines anderen Haushalts dabei sein.
//
// Jede Anfrage braucht den Sonos-Access-Token der App (Authorization: Bearer …)
// und den Haushalt (?household=…). Der Worker fragt Sonos, welche Haushalte zu
// dem Token gehören — nur auf diese gibt es Zugriff. So können sich verschiedene
// Sonos-Konten und Haushalte nicht gegenseitig lesen oder überschreiben.

const SONOS_HOUSEHOLDS_URL = "https://api.ws.sonos.com/control/api/v1/households";
const HOUSEHOLD_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Pro Aufruf erlaubt Cloudflare 1000 KV-Zugriffe; ein Upload braucht bis zu zwei je Bild
const MAX_IMAGES = 400;
const PLAYED = "played/";
const TABLET_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PLAYED = 20000;
const MAX_PLAYED_KEY_LENGTH = 1000;
const MAX_PLAYED_BYTES = 2 * 1024 * 1024;

async function handleSync(request, url, env) {
  const kv = env.SYNC_KV;
  if (!kv) {
    return json({ error: "sync_not_configured" }, 501);
  }

  const household = url.searchParams.get("household") ?? "";
  if (!HOUSEHOLD_PATTERN.test(household)) {
    return json({ error: "invalid_household" }, 400);
  }
  const denied = await checkHouseholdAccess(request, household);
  if (denied) return denied;

  const prefix = `hh:${household}:`;
  const path = url.pathname;
  const method = request.method;

  if (path === "/sync/state" && method === "GET") {
    const meta = await kv.get(prefix + "meta", "json");
    if (!meta) return json({ error: "not_found" }, 404);
    return json({ version: meta.version, updatedAt: meta.updatedAt, deviceName: meta.deviceName });
  }

  if (path === "/sync/snapshot" && method === "GET") {
    const stored = await kv.get(prefix + "snapshot", "text");
    if (!stored) return json({ error: "not_found" }, 404);
    return new Response(stored, {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  if (path === "/sync/snapshot" && method === "PUT") {
    return putSnapshot(request, kv, prefix);
  }

  if (path === "/sync/images/missing" && method === "POST") {
    const body = await readJson(request, MAX_SNAPSHOT_BYTES);
    const hashes = body?.hashes;
    if (!Array.isArray(hashes) || hashes.length > MAX_IMAGES || !hashes.every((h) => HASH_PATTERN.test(h))) {
      return json({ error: "invalid_request" }, 400);
    }
    const meta = await kv.get(prefix + "meta", "json");
    return json({ missing: await findMissingImages(kv, prefix, hashes, meta) });
  }

  const imageMatch = path.match(/^\/sync\/images\/([0-9a-f]{64})$/);
  if (imageMatch && method === "PUT") {
    const hash = imageMatch[1];
    const bytes = await readBytes(request, MAX_IMAGE_BYTES);
    if (!bytes) return json({ error: "too_large" }, 413);
    // Der Name ist der Inhalt: so kann niemand unter fremdem Namen etwas ablegen
    if ((await sha256Hex(bytes)) !== hash) return json({ error: "hash_mismatch" }, 400);
    await kv.put(prefix + "img:" + hash, bytes);
    return json({ ok: true });
  }
  if (imageMatch && method === "GET") {
    const bytes = await kv.get(prefix + "img:" + imageMatch[1], "arrayBuffer");
    if (!bytes) return json({ error: "not_found" }, 404);
    return new Response(bytes, {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
    });
  }

  if (path === "/sync/played" && method === "GET") {
    return json({ played: await readPlayed(kv, prefix) });
  }

  const playedMatch = path.match(/^\/sync\/played\/([^/]+)$/);
  if (playedMatch && method === "PUT") {
    if (!TABLET_PATTERN.test(playedMatch[1])) return json({ error: "invalid_request" }, 400);
    const keys = (await readJson(request, MAX_PLAYED_BYTES))?.keys;
    if (
      !Array.isArray(keys) ||
      keys.length > MAX_PLAYED ||
      !keys.every((key) => typeof key === "string" && key.length > 0 && key.length <= MAX_PLAYED_KEY_LENGTH)
    ) {
      return json({ error: "invalid_request" }, 400);
    }
    await kv.put(prefix + PLAYED + playedMatch[1], JSON.stringify([...new Set(keys)]));
    return json({ ok: true });
  }

  if (path === "/sync" && method === "DELETE") {
    const meta = await kv.get(prefix + "meta", "json");
    const images = Array.isArray(meta?.images) ? meta.images : [];
    const played = await listKeys(kv, prefix + PLAYED);
    await Promise.all([
      ...images.map((hash) => kv.delete(prefix + "img:" + hash)),
      ...played.map((name) => kv.delete(name)),
    ]);
    await kv.delete(prefix + "snapshot");
    await kv.delete(prefix + "meta");
    return json({ ok: true });
  }

  return json({ error: "not_found" }, 404);
}

/**
 * PUT /sync/snapshot  Body: {"deviceName": "…", "images": ["<sha256>", …], "snapshot": {…}}
 *
 * Alle Bilder müssen vorher hochgeladen sein, sonst 409 mit der Liste der fehlenden.
 * Bilder, die der neue Stand nicht mehr braucht, werden danach gelöscht.
 */
async function putSnapshot(request, kv, prefix) {
  const body = await readJson(request, MAX_SNAPSHOT_BYTES);
  const images = body?.images;
  if (
    !body ||
    typeof body.snapshot !== "object" ||
    body.snapshot === null ||
    !Array.isArray(images) ||
    images.length > MAX_IMAGES ||
    !images.every((h) => HASH_PATTERN.test(h))
  ) {
    return json({ error: "invalid_request" }, 400);
  }
  const unique = [...new Set(images)];
  const previous = await kv.get(prefix + "meta", "json");
  const missing = await findMissingImages(kv, prefix, unique, previous);
  if (missing.length > 0) return json({ error: "missing_images", missing }, 409);

  const meta = {
    version: crypto.randomUUID(),
    updatedAt: Date.now(),
    deviceName: String(body.deviceName ?? "").slice(0, 100),
    images: unique,
  };
  // Stand zuerst, dann die Meta-Daten: wer die neue Version sieht, bekommt auch den neuen Stand
  await kv.put(
    prefix + "snapshot",
    JSON.stringify({ version: meta.version, updatedAt: meta.updatedAt, deviceName: meta.deviceName, snapshot: body.snapshot })
  );
  await kv.put(prefix + "meta", JSON.stringify(meta));

  const stillUsed = new Set(unique);
  const unused = (Array.isArray(previous?.images) ? previous.images : []).filter((hash) => !stillUsed.has(hash));
  await Promise.all(unused.map((hash) => kv.delete(prefix + "img:" + hash)));

  return json({ version: meta.version, updatedAt: meta.updatedAt, deviceName: meta.deviceName });
}

/**
 * Bilder aus [hashes], die noch nicht im Speicher liegen. Was der zuletzt
 * hochgeladene Stand schon verwendet, gilt ohne Nachsehen als vorhanden —
 * das spart KV-Abfragen (pro Aufruf sind nur 1000 erlaubt).
 */
async function findMissingImages(kv, prefix, hashes, meta) {
  const known = new Set(Array.isArray(meta?.images) ? meta.images : []);
  const unknown = [...new Set(hashes)].filter((hash) => !known.has(hash));
  const found = await Promise.all(
    unknown.map(async (hash) => {
      const stream = await kv.get(prefix + "img:" + hash, "stream");
      if (stream) await stream.cancel();
      return stream !== null;
    })
  );
  return unknown.filter((hash, index) => !found[index]);
}

/** Was auf irgendeinem Tablet des Haushalts schon gespielt wurde, ohne Doppelte. */
async function readPlayed(kv, prefix) {
  const lists = await Promise.all((await listKeys(kv, prefix + PLAYED)).map((name) => kv.get(name, "json")));
  const played = new Set();
  for (const list of lists) {
    if (Array.isArray(list)) list.filter((key) => typeof key === "string").forEach((key) => played.add(key));
  }
  return [...played].sort();
}

/** Namen aller Einträge, die mit [prefix] beginnen — KV liefert sie seitenweise. */
async function listKeys(kv, prefix) {
  const names = [];
  let cursor;
  do {
    const page = await kv.list({ prefix, cursor });
    names.push(...page.keys.map((key) => key.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return names;
}

/**
 * Prüft bei Sonos, ob der Token der App zum Haushalt gehört.
 * Gibt eine Fehler-Antwort zurück oder null, wenn alles passt.
 */
async function checkHouseholdAccess(request, household) {
  const auth = request.headers.get("Authorization") ?? "";
  if (!/^Bearer \S+$/.test(auth)) {
    return json({ error: "invalid_token" }, 401);
  }
  let response;
  try {
    response = await fetch(SONOS_HOUSEHOLDS_URL, { headers: { Authorization: auth } });
  } catch (err) {
    return json({ error: "sonos_unreachable" }, 502);
  }
  // 401/403 von Sonos: Token abgelaufen oder ungültig → App erneuert ihn und versucht es wieder
  if (response.status === 401 || response.status === 403) {
    return json({ error: "invalid_token" }, 401);
  }
  if (!response.ok) {
    console.error("Sonos households check failed:", response.status);
    return json({ error: "sonos_unreachable" }, 502);
  }
  const data = await response.json().catch(() => null);
  const ids = Array.isArray(data?.households) ? data.households.map((h) => h?.id) : [];
  if (!ids.includes(household)) {
    return json({ error: "forbidden_household" }, 403);
  }
  return null;
}

async function readBytes(request, limit) {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > limit) return null;
  const buffer = await request.arrayBuffer();
  return buffer.byteLength > limit ? null : buffer;
}

async function readJson(request, limit) {
  const bytes = await readBytes(request, limit);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    return null;
  }
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * Leitet den Browser per 302 auf das Custom-URI-Scheme der Android-App
 * weiter. Android fängt das über den registrierten Intent-Filter ab und
 * öffnet die App direkt mit den Tokens im Query-String.
 */
function redirectToApp(env, params) {
  const filtered = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
  const qs = new URLSearchParams(filtered).toString();
  const target = `${env.APP_CALLBACK_SCHEME}?${qs}`;
  return Response.redirect(target, 302);
}
