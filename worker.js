// La Dispensa Di Rocco — Cloudflare Workers + static assets
//
// Routes:
// - GET  /api/status
// - GET  /api/admin/access
// - POST /api/submit (admin session → proxy app stocks)
// - POST /api/production (Discord webhook + Google Sheets)
// - GET  /admin, /admin/app, /admin/login, /admin/callback
// - POST /discord/interactions
// - static files via env.ASSETS (./site)

const OPEN_ID = "restaurant_open";
const CLOSED_ID = "restaurant_closed";
const ADMIN_ALLOWLIST_KEY = "admin_allowlist";
const SESSION_COOKIE = "dispensa_admin";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const PRODUCTION_DEDUP_TTL = 60 * 60;
const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(init.headers || {})
    }
  });
}

function redirect(location, init = {}) {
  return new Response(null, {
    status: 302,
    ...init,
    headers: {
      Location: location,
      ...(init.headers || {})
    }
  });
}

function hexToBytes(hex) {
  if (!hex || hex.length % 2 !== 0) return new Uint8Array();

  const pairs = hex.match(/../g);
  if (!pairs) return new Uint8Array();

  return new Uint8Array(
    pairs.map(value => Number.parseInt(value, 16))
  );
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function verifyDiscordRequest(request, rawBody, publicKeyHex) {
  const signatureHex = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");

  if (!signatureHex || !timestamp || !publicKeyHex) {
    return false;
  }

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"]
    );

    const message = new TextEncoder().encode(timestamp + rawBody);

    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      hexToBytes(signatureHex),
      message
    );
  } catch {
    return false;
  }
}

function getBootstrapAdmins(env) {
  const raw = env.ADMIN_DISCORD_IDS || "";
  return raw
    .split(",")
    .map(id => id.trim())
    .filter(Boolean);
}

function getBotRoleIds(env) {
  const raw = env.DISCORD_BOT_ROLE_IDS || "";
  return raw
    .split(",")
    .map(id => id.trim())
    .filter(Boolean);
}

function memberHasBotRole(interaction, env) {
  const requiredRoles = getBotRoleIds(env);
  if (!requiredRoles.length) return false;

  const memberRoles = (interaction.member?.roles || []).map(String);
  return requiredRoles.some(roleId => memberRoles.includes(String(roleId)));
}

async function canUseBotCommands(interaction, env) {
  if (getBotRoleIds(env).length) {
    return memberHasBotRole(interaction, env);
  }

  const actorId = getInteractionUserId(interaction);
  return isAdminDiscordId(actorId, env);
}

async function readAdminAllowlist(env) {
  if (!env.SITE_STATE) return [];

  const raw = await env.SITE_STATE.get(ADMIN_ALLOWLIST_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map(String).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

async function writeAdminAllowlist(env, allowlist) {
  await env.SITE_STATE.put(
    ADMIN_ALLOWLIST_KEY,
    JSON.stringify([...new Set(allowlist.map(String))])
  );
}

async function getAdminAllowlist(env) {
  const stored = await readAdminAllowlist(env);
  const bootstrap = getBootstrapAdmins(env);
  return [...new Set([...bootstrap, ...stored])];
}

async function isAdminDiscordId(userId, env) {
  if (!userId) return false;
  return (await getAdminAllowlist(env)).includes(String(userId));
}

async function signAdminSession(userId, env) {
  if (!env.ADMIN_SESSION_SECRET) return null;

  const exp = Date.now() + SESSION_MAX_AGE * 1000;
  const payload = `${userId}.${exp}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.ADMIN_SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload)
  );

  return `${bytesToBase64Url(new TextEncoder().encode(payload))}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function verifyAdminSession(token, env) {
  if (!token || !env.ADMIN_SESSION_SECRET) return null;

  const [payloadPart, signaturePart] = token.split(".");
  if (!payloadPart || !signaturePart) return null;

  try {
    const payload = new TextDecoder().decode(base64UrlToBytes(payloadPart));
    const [userId, expRaw] = payload.split(".");
    const exp = Number(expRaw);

    if (!userId || !Number.isFinite(exp) || Date.now() > exp) return null;

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.ADMIN_SESSION_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlToBytes(signaturePart),
      new TextEncoder().encode(payload)
    );

    if (!valid) return null;
    if (!(await isAdminDiscordId(userId, env))) return null;

    return userId;
  } catch {
    return null;
  }
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function sessionCookie(token, request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}${secure}`;
}

function clearSessionCookie(request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

async function getSessionUserId(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  return verifyAdminSession(token, env);
}

function oauthRedirectUri(request) {
  return `${new URL(request.url).origin}/admin/callback`;
}

async function verifyDiscordInteraction(request, rawBody, env) {
  const keys = [env.DISCORD_PUBLIC_KEY, env.ADMIN_DISCORD_PUBLIC_KEY].filter(Boolean);

  for (const keyHex of keys) {
    if (await verifyDiscordRequest(request, rawBody, keyHex)) {
      return true;
    }
  }

  return false;
}

async function getRestaurantStatus(env) {
  if (!env.SITE_STATE) {
    return json({
      status: "unknown",
      updatedAt: null,
      setupRequired: "SITE_STATE KV binding"
    });
  }

  const status = await env.SITE_STATE.get("restaurant_status");
  const updatedAt = await env.SITE_STATE.get("restaurant_status_updated_at");

  return json({
    status: status === "open" || status === "closed" ? status : "unknown",
    updatedAt: updatedAt || null
  });
}

async function getAdminAccess(request, env) {
  const userId = await getSessionUserId(request, env);
  return json({ allowed: Boolean(userId) });
}

async function handleAdminLogin(request, env) {
  if (!env.DISCORD_CLIENT_ID) {
    return new Response("DISCORD_CLIENT_ID is not configured", { status: 503 });
  }

  const state = crypto.randomUUID();
  const authorize = new URL("https://discord.com/api/oauth2/authorize");
  authorize.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", oauthRedirectUri(request));
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "identify");
  authorize.searchParams.set("state", state);

  if (env.SITE_STATE) {
    await env.SITE_STATE.put(`oauth_state:${state}`, "1", { expirationTtl: 600 });
  }

  return redirect(authorize.toString());
}

async function handleAdminCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return redirect("/?admin=denied");
  }

  if (!code || !state || !env.SITE_STATE) {
    return redirect("/?admin=error");
  }

  const stateOk = await env.SITE_STATE.get(`oauth_state:${state}`);
  if (!stateOk) {
    return redirect("/?admin=error");
  }

  await env.SITE_STATE.delete(`oauth_state:${state}`);

  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
    return redirect("/?admin=error");
  }

  const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: oauthRedirectUri(request)
    })
  });

  if (!tokenResponse.ok) {
    return redirect("/?admin=error");
  }

  const tokenData = await tokenResponse.json();
  const userResponse = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` }
  });

  if (!userResponse.ok) {
    return redirect("/?admin=error");
  }

  const user = await userResponse.json();
  if (!(await isAdminDiscordId(user.id, env))) {
    return redirect("/?admin=denied");
  }

  const session = await signAdminSession(user.id, env);
  if (!session) {
    return redirect("/?admin=error");
  }

  const destination = "/?admin=connected";
  return redirect(destination, {
    headers: { "Set-Cookie": sessionCookie(session, request) }
  });
}

function getStocksOrigin(env) {
  const raw = env.ADMIN_STOCKS_ORIGIN || env.ADMIN_REDIRECT_URL || "";
  return raw.replace(/\/$/, "");
}

async function proxyStocksRequest(request, env, stocksPath) {
  const origin = getStocksOrigin(env);
  if (!origin) {
    return new Response("ADMIN_STOCKS_ORIGIN is not configured", { status: 503 });
  }

  const targetUrl = new URL(stocksPath, `${origin}/`);
  const headers = new Headers();

  for (const name of ["accept", "accept-language", "content-type"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  if (env.STOCKS_ACCESS_CLIENT_ID && env.STOCKS_ACCESS_CLIENT_SECRET) {
    headers.set("CF-Access-Client-Id", env.STOCKS_ACCESS_CLIENT_ID);
    headers.set("CF-Access-Client-Secret", env.STOCKS_ACCESS_CLIENT_SECRET);
  }

  const init = {
    method: request.method,
    headers,
    redirect: "follow"
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  const response = await fetch(targetUrl.toString(), init);
  const outHeaders = new Headers(response.headers);
  outHeaders.set("Cache-Control", "no-store");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: outHeaders
  });
}

async function requireAdminSession(request, env) {
  const userId = await getSessionUserId(request, env);
  if (!userId) {
    return { error: redirect("/admin/login") };
  }
  return { userId };
}

async function handleAdminStocksApp(request, env) {
  const auth = await requireAdminSession(request, env);
  if (auth.error) return auth.error;

  const prefix = "/admin/app";
  const url = new URL(request.url);
  let stocksPath = url.pathname.slice(prefix.length) || "/";

  return proxyStocksRequest(request, env, stocksPath);
}

async function handleAdminSubmit(request, env) {
  const auth = await requireAdminSession(request, env);
  if (auth.error) return auth.error;

  let formData;
  try {
    formData = await request.formData();
  } catch {
    return json(
      { ok: false, error: "Impossible de lire le formulaire." },
      { status: 400 }
    );
  }

  const nom = String(formData.get("name") || formData.get("nom") || "").trim();
  const stockRaw = formData.get("stock");
  const stock = typeof stockRaw === "number" ? stockRaw : Number(stockRaw);
  const proof = formData.get("proof");

  if (!nom || !Number.isFinite(stock) || stock < 0) {
    return json(
      {
        ok: false,
        error: "Merci de renseigner un nom et un stock produit valides."
      },
      { status: 400 }
    );
  }

  if (!(proof instanceof File) || proof.size === 0) {
    return json(
      { ok: false, error: "Une image de preuve est obligatoire." },
      { status: 400 }
    );
  }

  if (!String(proof.type || "").startsWith("image/")) {
    return json(
      { ok: false, error: "Le fichier de preuve doit être une image." },
      { status: 400 }
    );
  }

  if (proof.size > 8 * 1024 * 1024) {
    return json(
      { ok: false, error: "L'image ne doit pas dépasser 8 Mo." },
      { status: 400 }
    );
  }

  return recordProductionDeclaration(env, { nom, stock, proofFile: proof });
}

async function handleAdminGate(request, env) {
  const userId = await getSessionUserId(request, env);
  if (userId) {
    return redirect("/admin/app");
  }

  return redirect("/admin/login");
}

async function handleAdminLogout(request) {
  return redirect("/", {
    headers: { "Set-Cookie": clearSessionCookie(request) }
  });
}

function discordEphemeral(content) {
  return json({
    type: 4,
    data: { content, flags: 64 }
  });
}

function getInteractionUserId(interaction) {
  return interaction.member?.user?.id || interaction.user?.id || "";
}

function getSlashOption(interaction, name) {
  return interaction.data?.options?.find(option => option.name === name)?.value;
}

async function handleAdminSlashCommand(interaction, env) {
  const guildId = interaction.guild_id || "";
  if (guildId !== env.DISCORD_GUILD_ID) {
    return discordEphemeral("Cette commande n'est pas autorisée ici.");
  }

  if (!(await canUseBotCommands(interaction, env))) {
    const roleConfigured = getBotRoleIds(env).length > 0;
    return discordEphemeral(
      roleConfigured
        ? "Tu n'as pas le rôle requis pour utiliser les commandes du bot."
        : "Tu n'as pas la permission de gérer les accès admin."
    );
  }

  const command = interaction.data?.name || "";
  const stored = await readAdminAllowlist(env);
  const bootstrap = new Set(getBootstrapAdmins(env));

  if (command === "admin-list") {
    const effective = await getAdminAllowlist(env);
    if (!effective.length) {
      return discordEphemeral("Aucun admin autorisé pour le moment.");
    }

    const lines = effective.map(id => {
      const locked = bootstrap.has(id) ? " (bootstrap)" : "";
      return `• \`${id}\`${locked}`;
    });

    return discordEphemeral(`Admins autorisés :\n${lines.join("\n")}`);
  }

  if (command === "admin-add") {
    const targetId = String(getSlashOption(interaction, "user") || "");
    if (!targetId) {
      return discordEphemeral("Utilisateur introuvable.");
    }

    if (stored.includes(targetId)) {
      return discordEphemeral(`<@${targetId}> est déjà admin.`);
    }

    stored.push(targetId);
    await writeAdminAllowlist(env, stored);

    return discordEphemeral(`✅ <@${targetId}> peut maintenant accéder à ADMIN.`);
  }

  if (command === "admin-remove") {
    const targetId = String(getSlashOption(interaction, "user") || "");
    if (!targetId) {
      return discordEphemeral("Utilisateur introuvable.");
    }

    if (bootstrap.has(targetId)) {
      return discordEphemeral(
        "Cet admin est défini dans ADMIN_DISCORD_IDS (bootstrap) et ne peut pas être retiré via Discord."
      );
    }

    const next = stored.filter(id => id !== targetId);
    if (next.length === stored.length) {
      return discordEphemeral(`<@${targetId}> n'est pas dans la liste admin.`);
    }

    await writeAdminAllowlist(env, next);
    return discordEphemeral(`🔒 <@${targetId}> n'a plus accès à ADMIN.`);
  }

  return discordEphemeral("Commande admin inconnue.");
}

async function handleDiscordInteraction(request, env) {
  if (!env.DISCORD_PUBLIC_KEY && !env.ADMIN_DISCORD_PUBLIC_KEY) {
    return json(
      { error: "DISCORD_PUBLIC_KEY or ADMIN_DISCORD_PUBLIC_KEY must be configured" },
      { status: 503 }
    );
  }

  const rawBody = await request.text();

  const valid = await verifyDiscordInteraction(request, rawBody, env);

  if (!valid) {
    return new Response("invalid request signature", { status: 401 });
  }

  let interaction;

  try {
    interaction = JSON.parse(rawBody);
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  // Discord PING — ne nécessite pas le binding KV.
  if (interaction.type === 1) {
    return json({ type: 1 });
  }

  if (!env.SITE_STATE) {
    return json(
      { error: "SITE_STATE KV binding is not configured" },
      { status: 503 }
    );
  }

  if (interaction.type === 2) {
    return handleAdminSlashCommand(interaction, env);
  }

  if (interaction.type !== 3) {
    return discordEphemeral("Interaction non prise en charge.");
  }

  const guildId = interaction.guild_id || "";
  const channelId =
    interaction.channel_id ||
    interaction.channel?.id ||
    "";
  const messageId = interaction.message?.id || "";

  if (
    guildId !== env.DISCORD_GUILD_ID ||
    channelId !== env.DISCORD_CHANNEL_ID ||
    messageId !== env.DISCORD_MESSAGE_ID
  ) {
    return discordEphemeral("Ce bouton n'est pas autorisé à modifier le statut du site.");
  }

  if (!(await canUseBotCommands(interaction, env))) {
    const roleConfigured = getBotRoleIds(env).length > 0;
    return discordEphemeral(
      roleConfigured
        ? "Tu n'as pas le rôle requis pour modifier le statut du site."
        : "Tu n'as pas la permission de modifier le statut du site."
    );
  }

  const customId = interaction.data?.custom_id;
  let status = null;

  if (customId === OPEN_ID) status = "open";
  if (customId === CLOSED_ID) status = "closed";

  if (!status) {
    return discordEphemeral("Bouton inconnu.");
  }

  await env.SITE_STATE.put("restaurant_status", status);
  await env.SITE_STATE.put(
    "restaurant_status_updated_at",
    new Date().toISOString()
  );

  return discordEphemeral(
    status === "open"
      ? "✅ Le site affiche maintenant **OUVERT**."
      : "🔴 Le site affiche maintenant **FERMÉ**."
  );
}

function readProductionToken(request) {
  const bearer = request.headers.get("Authorization") || "";
  if (bearer.toLowerCase().startsWith("bearer ")) {
    return bearer.slice(7).trim();
  }
  return (request.headers.get("X-Api-Token") || "").trim();
}

function parisDateString(date = new Date()) {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(date);
}

function pemToArrayBuffer(pem) {
  const cleaned = String(pem)
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function createGoogleAccessToken(env) {
  const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKeyPem = env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

  if (!email || !privateKeyPem) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is missing"
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: email,
    scope: GOOGLE_SHEETS_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  };

  const encoder = new TextEncoder();
  const unsigned =
    `${bytesToBase64Url(encoder.encode(JSON.stringify(header)))}.` +
    `${bytesToBase64Url(encoder.encode(JSON.stringify(claim)))}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(unsigned)
  );
  const jwt = `${unsigned}.${bytesToBase64Url(new Uint8Array(signature))}`;

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });

  const tokenData = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokenData.access_token) {
    throw new Error(
      `Google OAuth failed (${tokenResponse.status}): ${tokenData.error || "unknown"}`
    );
  }

  return tokenData.access_token;
}

function normalizeSpreadsheetId(raw) {
  let spreadsheetId = String(raw || "").trim();
  const fromUrl = spreadsheetId.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (fromUrl) spreadsheetId = fromUrl[1];
  return spreadsheetId.split("/")[0].split("?")[0];
}

function productionSheetRange(env) {
  return env.GOOGLE_SHEETS_RANGE || "Feuille1!A:G";
}

async function appendProductionSheetRow(env, row) {
  const spreadsheetId = normalizeSpreadsheetId(env.GOOGLE_SHEETS_SPREADSHEET_ID);
  const range = productionSheetRange(env);

  if (!spreadsheetId) {
    throw new Error("GOOGLE_SHEETS_SPREADSHEET_ID is missing");
  }

  const accessToken = await createGoogleAccessToken(env);
  const endpoint =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
    `/values/${encodeURIComponent(range)}:append` +
    `?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ values: [row] })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Sheets append failed (${response.status}): ${data.error?.message || "unknown"}`
    );
  }

  return data;
}

async function readProductionSheetRows(env) {
  const spreadsheetId = normalizeSpreadsheetId(env.GOOGLE_SHEETS_SPREADSHEET_ID);
  const range = productionSheetRange(env);

  if (!spreadsheetId) {
    throw new Error("GOOGLE_SHEETS_SPREADSHEET_ID is missing");
  }

  const accessToken = await createGoogleAccessToken(env);
  const endpoint =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
    `/values/${encodeURIComponent(range)}`;

  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Sheets read failed (${response.status}): ${data.error?.message || "unknown"}`
    );
  }

  return Array.isArray(data.values) ? data.values : [];
}

async function postDiscordWebhookContent(webhookUrl, content) {
  if (!webhookUrl) return false;

  const url = new URL(webhookUrl);
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content })
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    console.error(
      "[production] Discord alert failed:",
      response.status,
      data.message || "unknown"
    );
    return false;
  }

  return true;
}

async function postProductionAlert(env, content) {
  const primary = env.DISCORD_ALERT_WEBHOOK_URL || env.DISCORD_PRODUCTION_WEBHOOK_URL;
  const ok = await postDiscordWebhookContent(primary, content);

  if (
    !ok &&
    env.DISCORD_ALERT_WEBHOOK_URL &&
    env.DISCORD_PRODUCTION_WEBHOOK_URL &&
    env.DISCORD_ALERT_WEBHOOK_URL !== env.DISCORD_PRODUCTION_WEBHOOK_URL
  ) {
    await postDiscordWebhookContent(env.DISCORD_PRODUCTION_WEBHOOK_URL, content);
  }
}

function parseSheetDate(value) {
  const match = String(value || "")
    .trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (!day || !month || !year) return null;

  return { day, month, year, key: year * 10000 + month * 100 + day };
}

function parisYmdParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).formatToParts(date);

  const day = Number(parts.find(part => part.type === "day")?.value);
  const month = Number(parts.find(part => part.type === "month")?.value);
  const year = Number(parts.find(part => part.type === "year")?.value);
  return { day, month, year, key: year * 10000 + month * 100 + day };
}

function addDaysToYmd(ymd, deltaDays) {
  const utc = Date.UTC(ymd.year, ymd.month - 1, ymd.day + deltaDays);
  const date = new Date(utc);
  return {
    day: date.getUTCDate(),
    month: date.getUTCMonth() + 1,
    year: date.getUTCFullYear(),
    key:
      date.getUTCFullYear() * 10000 +
      (date.getUTCMonth() + 1) * 100 +
      date.getUTCDate()
  };
}

function formatYmd(ymd) {
  return `${String(ymd.day).padStart(2, "0")}/${String(ymd.month).padStart(2, "0")}/${ymd.year}`;
}

function previousIsoWeekRangeParis(now = new Date()) {
  const today = parisYmdParts(now);
  const weekdayName = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Paris",
    weekday: "short"
  }).format(now);

  const weekdayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const weekday = weekdayMap[weekdayName] || 1;
  const daysSinceMonday = weekday - 1;
  const thisMonday = addDaysToYmd(today, -daysSinceMonday);
  const prevMonday = addDaysToYmd(thisMonday, -7);
  const prevSunday = addDaysToYmd(thisMonday, -1);

  return { start: prevMonday, end: prevSunday };
}

function currentIsoWeekRangeParis(now = new Date()) {
  const today = parisYmdParts(now);
  const weekdayName = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Paris",
    weekday: "short"
  }).format(now);

  const weekdayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const weekday = weekdayMap[weekdayName] || 1;
  const daysSinceMonday = weekday - 1;
  const thisMonday = addDaysToYmd(today, -daysSinceMonday);

  return { start: thisMonday, end: today };
}

function resolveRecapRange(period, now = new Date()) {
  return period === "current"
    ? currentIsoWeekRangeParis(now)
    : previousIsoWeekRangeParis(now);
}

function buildWeeklyProductionRecap(rows, range) {
  const totals = new Map();
  let entries = 0;
  let menusTotal = 0;

  for (const row of rows) {
    const date = parseSheetDate(row[0]);
    if (!date) continue;
    if (date.key < range.start.key || date.key > range.end.key) continue;

    const employe = String(row[1] || "").trim();
    const menus = Number(String(row[2] || "").replace(/\s/g, "").replace(",", "."));
    if (!employe || !Number.isFinite(menus)) continue;

    entries += 1;
    menusTotal += menus;
    totals.set(employe, (totals.get(employe) || 0) + menus);
  }

  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "fr"));

  return { entries, menusTotal, ranked };
}

function formatWeeklyRecapMessage(range, summary, period = "previous") {
  const periodLabel = period === "current" ? "semaine en cours" : "hebdo";
  const periodDates = `${formatYmd(range.start)} → ${formatYmd(range.end)}`;

  if (!summary.ranked.length) {
    return (
      `📊 **Récap production ${periodLabel}** (${periodDates})\n` +
      `Aucune déclaration trouvée sur la période.`
    );
  }

  const lines = summary.ranked.map(
    ([name, total], index) => `${index + 1}. **${name}** — ${Math.round(total)} menus`
  );

  return (
    `📊 **Récap production ${periodLabel}** (${periodDates})\n` +
    `Déclarations : **${summary.entries}** · Menus : **${Math.round(summary.menusTotal)}**\n\n` +
    lines.join("\n")
  );
}

async function runWeeklyProductionRecap(env, period = "previous") {
  const range = resolveRecapRange(period);
  const rows = await readProductionSheetRows(env);
  const summary = buildWeeklyProductionRecap(rows, range);
  const content = formatWeeklyRecapMessage(range, summary, period);

  const webhook =
    env.DISCORD_RECAP_WEBHOOK_URL ||
    env.DISCORD_ALERT_WEBHOOK_URL ||
    env.DISCORD_PRODUCTION_WEBHOOK_URL;

  const posted = await postDiscordWebhookContent(webhook, content);
  if (!posted) {
    throw new Error("Impossible de poster le récap Discord");
  }

  console.log("[production] weekly recap posted", period, content);
  return { ok: true, period, range, summary, content };
}

async function handleProductionRecap(request, env) {
  if (!env.PRODUCTION_API_TOKEN) {
    return json(
      { ok: false, error: "PRODUCTION_API_TOKEN is not configured" },
      { status: 503 }
    );
  }

  const providedToken = readProductionToken(request);
  if (!providedToken || providedToken !== env.PRODUCTION_API_TOKEN) {
    return json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  let period = String(url.searchParams.get("period") || "previous").toLowerCase();

  try {
    const body = await request.clone().json().catch(() => null);
    if (body?.period) period = String(body.period).toLowerCase();
  } catch {
    // body optionnel
  }

  if (period !== "current" && period !== "previous") {
    return json(
      { ok: false, error: 'period must be "current" or "previous"' },
      { status: 400 }
    );
  }

  try {
    const result = await runWeeklyProductionRecap(env, period);
    return json(result);
  } catch (error) {
    console.error("[production] recap error:", error?.message || error);
    await postProductionAlert(
      env,
      `❌ **Alerte récap hebdo**\nImpossible de générer/poster le récap : ${error?.message || "unknown"}`
    );
    return json(
      {
        ok: false,
        error: `Impossible de générer le récap (${error?.message || "unknown"}).`
      },
      { status: 502 }
    );
  }
}

async function postProductionDiscordMessage(env, nom, stock, proofFile = null) {
  const webhookUrl = env.DISCORD_PRODUCTION_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("DISCORD_PRODUCTION_WEBHOOK_URL is missing");
  }

  const content =
    `Nouvelle déclaration de production\n` +
    `Nom : ${nom}\n` +
    `Stock produit : ${stock}`;

  const url = new URL(webhookUrl);
  url.searchParams.set("wait", "true");

  let response;
  if (proofFile instanceof File || proofFile instanceof Blob) {
    const body = new FormData();
    body.append("payload_json", JSON.stringify({ content }));
    const filename =
      (proofFile instanceof File && proofFile.name) || "preuve.png";
    body.append("files[0]", proofFile, filename);
    response = await fetch(url.toString(), { method: "POST", body });
  } else {
    response = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id) {
    throw new Error(
      `Discord webhook failed (${response.status}): ${data.message || "unknown"}`
    );
  }

  const guildId = env.DISCORD_GUILD_ID;
  const configuredChannelId = String(env.PRODUCTION_DISCORD_CHANNEL_ID || "").trim();
  const channelId =
    /^\d+$/.test(configuredChannelId)
      ? configuredChannelId
      : String(data.channel_id || "").trim();

  if (!guildId || !channelId) {
    throw new Error(
      "DISCORD_GUILD_ID missing, or PRODUCTION_DISCORD_CHANNEL_ID is invalid (must be numeric salon ID)"
    );
  }

  const discordUrl = `https://discord.com/channels/${guildId}/${channelId}/${data.id}`;
  return { messageId: data.id, channelId, discordUrl };
}

async function buildProductionDedupKey(nom, stock) {
  const raw = `${nom.toLowerCase()}|${stock}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw)
  );
  const hex = [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
  return `production_dedup:${hex}`;
}

async function recordProductionDeclaration(env, { nom, stock, proofFile = null }) {
  const date = parisDateString();
  const dedupKey = await buildProductionDedupKey(nom, stock);

  if (env.SITE_STATE) {
    const already = await env.SITE_STATE.get(dedupKey);
    if (already) {
      try {
        const previous = JSON.parse(already);
        const createdAt = Date.parse(previous.createdAt || "");
        const ageMs = Number.isFinite(createdAt) ? Date.now() - createdAt : 0;
        if (ageMs < PRODUCTION_DEDUP_TTL * 1000) {
          return json({
            ok: true,
            duplicate: true,
            message: `✅ Production déjà enregistrée (délai < 1 h) — ${stock} × ${nom}`,
            discordUrl: previous.discordUrl || null,
            sheetRow: previous.sheetRow || null
          });
        }
      } catch {
        return json({
          ok: true,
          duplicate: true,
          message: `✅ Production déjà enregistrée (délai < 1 h) — ${stock} × ${nom}`
        });
      }
    }
  }

  let discord;
  try {
    discord = await postProductionDiscordMessage(env, nom, stock, proofFile);
  } catch (error) {
    console.error("[production] Discord error:", error?.message || error);
    await postProductionAlert(
      env,
      `❌ **Alerte production Discord**\n` +
        `Impossible de poster la déclaration **${nom}** (${stock} menus).\n` +
        `Erreur : ${error?.message || "unknown"}`
    );
    return json(
      {
        ok: false,
        error: `Impossible d'enregistrer la production : échec Discord (${error?.message || "unknown"}).`
      },
      { status: 502 }
    );
  }

  const sheetRow = [
    date,
    nom,
    String(stock),
    "Oui",
    "BOT",
    discord.discordUrl,
    ""
  ];

  try {
    await appendProductionSheetRow(env, sheetRow);
  } catch (error) {
    console.error("[production] Sheets error:", error?.message || error);
    await postProductionAlert(
      env,
      `❌ **Alerte Google Sheets**\n` +
        `Discord OK pour **${nom}** (${stock} menus) mais l'écriture Sheets a échoué.\n` +
        `Preuve : ${discord.discordUrl}\n` +
        `Erreur : ${error?.message || "unknown"}`
    );
    return json(
      {
        ok: false,
        error: `Impossible d'enregistrer la production : échec Google Sheets (${error?.message || "unknown"}).`,
        discordUrl: discord.discordUrl
      },
      { status: 502 }
    );
  }

  if (env.SITE_STATE) {
    await env.SITE_STATE.put(
      dedupKey,
      JSON.stringify({
        discordUrl: discord.discordUrl,
        sheetRow,
        createdAt: new Date().toISOString()
      }),
      { expirationTtl: PRODUCTION_DEDUP_TTL }
    );
  }

  const message = `✅ Production enregistrée dans Google Sheets — ${stock} × ${nom}`;
  console.log("[production]", message, discord.discordUrl);

  return json({
    ok: true,
    message,
    discordUrl: discord.discordUrl,
    sheetRow
  });
}

async function handleProductionDeclaration(request, env) {
  if (!env.PRODUCTION_API_TOKEN) {
    console.error("[production] PRODUCTION_API_TOKEN is not configured");
    return json(
      { ok: false, error: "PRODUCTION_API_TOKEN is not configured" },
      { status: 503 }
    );
  }

  const providedToken = readProductionToken(request);
  if (!providedToken || providedToken !== env.PRODUCTION_API_TOKEN) {
    return json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const nom = String(body?.nom ?? body?.name ?? "").trim();
  const stockRaw = body?.stock ?? body?.stock_produit ?? body?.menus;
  const stock = typeof stockRaw === "number" ? stockRaw : Number(stockRaw);

  if (!nom) {
    return json(
      {
        ok: false,
        error: "Impossible d'enregistrer la production : nom manquant."
      },
      { status: 400 }
    );
  }

  if (!Number.isFinite(stock) || stock < 0) {
    return json(
      {
        ok: false,
        error: "Impossible d'enregistrer la production : quantité manquante."
      },
      { status: 400 }
    );
  }

  return recordProductionDeclaration(env, { nom, stock });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/index.html")
    ) {
      const indexUrl = new URL("/index.html", request.url);
      return env.ASSETS.fetch(new Request(indexUrl, request));
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      return getRestaurantStatus(env);
    }

    if (request.method === "GET" && url.pathname === "/api/admin/access") {
      return getAdminAccess(request, env);
    }

    if (request.method === "GET" && url.pathname === "/admin/login") {
      return handleAdminLogin(request, env);
    }

    if (request.method === "GET" && url.pathname === "/admin/callback") {
      return handleAdminCallback(request, env);
    }

    if (request.method === "GET" && url.pathname === "/admin/logout") {
      return handleAdminLogout(request);
    }

    if (
      (request.method === "GET" || request.method === "HEAD") &&
      (url.pathname === "/admin/app" || url.pathname.startsWith("/admin/app/"))
    ) {
      return handleAdminStocksApp(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/submit") {
      return handleAdminSubmit(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/production") {
      return handleProductionDeclaration(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/production/recap") {
      return handleProductionRecap(request, env);
    }

    if (request.method === "GET" && url.pathname === "/admin") {
      return handleAdminGate(request, env);
    }

    if (
      request.method === "POST" &&
      url.pathname === "/discord/interactions"
    ) {
      return handleDiscordInteraction(request, env);
    }

    if (
      url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/admin") ||
      url.pathname === "/discord/interactions"
    ) {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, POST" }
      });
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          await runWeeklyProductionRecap(env);
        } catch (error) {
          console.error("[production] scheduled recap error:", error?.message || error);
          await postProductionAlert(
            env,
            `❌ **Alerte récap hebdo (cron)**\n${error?.message || "unknown"}`
          );
        }
      })()
    );
  }
};
