/**
 * Sonos OAuth Relay
 *
 * Nimmt den Redirect von Sonos entgegen (?code=...&state=...), tauscht den
 * Code serverseitig gegen Access-/Refresh-Token (Client-Secret bleibt hier,
 * nie in der App) und reicht die Tokens per Redirect an die Android-App
 * weiter (Custom-URI-Scheme, z.B. sonoscontrol://callback?access_token=...).
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/callback" && request.method === "GET") {
      return handleCallback(url, env);
    }

    if (url.pathname === "/") {
      return new Response("Sonos OAuth relay is running.", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },
};

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
