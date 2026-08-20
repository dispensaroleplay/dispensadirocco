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
const PROD_VALIDATE_OUI = "prod_validate:oui";
const PROD_VALIDATE_NON = "prod_validate:non";
const ADMIN_ALLOWLIST_KEY = "admin_allowlist";
const SESSION_COOKIE = "dispensa_admin";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const PRODUCTION_DEDUP_TTL = 60 * 60;
const PRODUCTION_PENDING_TTL = 60 * 60 * 24 * 7;
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

function withStaticAssetCache(response) {
  if (!response || response.status !== 200) return response;
  const headers = new Headers(response.headers);
  const type = String(headers.get("Content-Type") || "").toLowerCase();
  const longLived =
    type.startsWith("image/") ||
    type.includes("javascript") ||
    type.includes("css") ||
    type.includes("font") ||
    type.includes("webp");
  if (longLived) {
    headers.set(
      "Cache-Control",
      "public, max-age=604800, stale-while-revalidate=86400"
    );
  } else if (type.includes("text/html")) {
    headers.set(
      "Cache-Control",
      "public, max-age=300, stale-while-revalidate=86400"
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
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

  // Formulaire dédié (évite le CSS/JS stocks qui cassait l'upload photo).
  if (
    request.method === "GET" &&
    (stocksPath === "/" || stocksPath === "" || stocksPath === "/index.html")
  ) {
    const page = await env.ASSETS.fetch(
      new Request(new URL("/admin-production.html", request.url))
    );
    const headers = new Headers(page.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(page.body, {
      status: page.status,
      statusText: page.statusText,
      headers
    });
  }

  return proxyStocksRequest(request, env, stocksPath);
}

function collectProofFiles(formData) {
  const files = [];
  for (const key of ["proof", "proofs", "preuve", "images"]) {
    for (const value of formData.getAll(key)) {
      if (value instanceof File && value.size > 0) files.push(value);
    }
  }
  return files;
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
  const proofs = collectProofFiles(formData);

  if (!nom || !Number.isFinite(stock) || stock < 0) {
    return json(
      {
        ok: false,
        error: "Merci de renseigner un nom et un stock produit valides."
      },
      { status: 400 }
    );
  }

  if (!proofs.length) {
    return json(
      { ok: false, error: "Au moins une image de preuve est obligatoire." },
      { status: 400 }
    );
  }

  if (proofs.length > 10) {
    return json(
      { ok: false, error: "Maximum 10 images par déclaration." },
      { status: 400 }
    );
  }

  for (const proof of proofs) {
    if (!String(proof.type || "").startsWith("image/")) {
      return json(
        { ok: false, error: "Chaque fichier de preuve doit être une image." },
        { status: 400 }
      );
    }

    if (proof.size > 8 * 1024 * 1024) {
      return json(
        { ok: false, error: "Chaque image ne doit pas dépasser 8 Mo." },
        { status: 400 }
      );
    }
  }

  return recordProductionDeclaration(env, { nom, stock, proofFiles: proofs });
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

function discordChannelReply(content) {
  return json({
    type: 4,
    data: { content }
  });
}

function discordDeferEphemeral() {
  return json({
    type: 5,
    data: { flags: 64 }
  });
}

function discordDeferPublic() {
  return json({ type: 5 });
}

async function editOriginalInteraction(applicationId, interactionToken, content) {
  if (!applicationId || !interactionToken) return false;

  const response = await fetch(
    `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    }
  );

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    console.error(
      "[discord] edit interaction failed:",
      response.status,
      data.message || "unknown"
    );
    return false;
  }

  return true;
}

function getInteractionUserId(interaction) {
  return interaction.member?.user?.id || interaction.user?.id || "";
}

function getSlashOption(interaction, name) {
  return interaction.data?.options?.find(option => option.name === name)?.value;
}

async function handleAdminSlashCommand(interaction, env, ctx) {
  const guildId = interaction.guild_id || "";
  if (guildId !== env.DISCORD_GUILD_ID) {
    return discordChannelReply("Cette commande n'est pas autorisée ici.");
  }

  if (!(await canUseBotCommands(interaction, env))) {
    const roleConfigured = getBotRoleIds(env).length > 0;
    return discordChannelReply(
      roleConfigured
        ? "Tu n'as pas le rôle requis pour utiliser les commandes du bot."
        : "Tu n'as pas la permission de gérer les accès admin."
    );
  }

  const command = interaction.data?.name || "";
  const stored = await readAdminAllowlist(env);
  const bootstrap = new Set(getBootstrapAdmins(env));

  if (command === "recap") {
    const periodRaw = String(getSlashOption(interaction, "periode") || "current").toLowerCase();
    const period = periodRaw === "previous" ? "previous" : "current";
    const employe = String(getSlashOption(interaction, "employe") || "").trim();
    const applicationId = env.DISCORD_CLIENT_ID || env.ADMIN_DISCORD_APPLICATION_ID;

    if (!applicationId) {
      return discordChannelReply(
        "DISCORD_CLIENT_ID manquant : impossible de finaliser la commande /recap."
      );
    }

    ctx.waitUntil(
      (async () => {
        try {
          const result = await runWeeklyProductionRecap(env, period, employe, {
            skipDiscordPost: true
          });
          await editOriginalInteraction(
            applicationId,
            interaction.token,
            result.content
          );
        } catch (error) {
          console.error("[production] /recap error:", error?.message || error);
          await postProductionAlert(
            env,
            `❌ **Alerte /recap**\n${error?.message || "unknown"}`
          );
          await editOriginalInteraction(
            applicationId,
            interaction.token,
            `❌ Impossible de générer le récap : ${error?.message || "unknown"}`
          );
        }
      })()
    );

    return discordDeferPublic();
  }

  if (command === "stats") {
    const periodRaw = String(getSlashOption(interaction, "periode") || "day").toLowerCase();
    const period =
      periodRaw === "previous" || periodRaw === "current" || periodRaw === "day"
        ? periodRaw
        : "day";
    const employe = String(getSlashOption(interaction, "employe") || "").trim();
    const applicationId = env.DISCORD_CLIENT_ID || env.ADMIN_DISCORD_APPLICATION_ID;

    if (!applicationId) {
      return discordChannelReply(
        "DISCORD_CLIENT_ID manquant : impossible de finaliser la commande /stats."
      );
    }

    ctx.waitUntil(
      (async () => {
        try {
          const result = await buildProductionStatsContent(env, period, employe);
          await editOriginalInteraction(
            applicationId,
            interaction.token,
            result.content
          );
        } catch (error) {
          console.error("[production] /stats error:", error?.message || error);
          await editOriginalInteraction(
            applicationId,
            interaction.token,
            `❌ Impossible de calculer les stats : ${error?.message || "unknown"}`
          );
        }
      })()
    );

    return discordDeferPublic();
  }

  if (command === "admin-list") {
    const effective = await getAdminAllowlist(env);
    if (!effective.length) {
      return discordChannelReply("Aucun admin autorisé pour le moment.");
    }

    const lines = effective.map(id => {
      const locked = bootstrap.has(id) ? " (bootstrap)" : "";
      return `• \`${id}\`${locked}`;
    });

    return discordChannelReply(`Admins autorisés :\n${lines.join("\n")}`);
  }

  if (command === "admin-add") {
    const targetId = String(getSlashOption(interaction, "user") || "");
    if (!targetId) {
      return discordChannelReply("Utilisateur introuvable.");
    }

    if (stored.includes(targetId)) {
      return discordChannelReply(`<@${targetId}> est déjà admin.`);
    }

    stored.push(targetId);
    await writeAdminAllowlist(env, stored);

    return discordChannelReply(`✅ <@${targetId}> peut maintenant accéder à ADMIN.`);
  }

  if (command === "admin-remove") {
    const targetId = String(getSlashOption(interaction, "user") || "");
    if (!targetId) {
      return discordChannelReply("Utilisateur introuvable.");
    }

    if (bootstrap.has(targetId)) {
      return discordChannelReply(
        "Cet admin est défini dans ADMIN_DISCORD_IDS (bootstrap) et ne peut pas être retiré via Discord."
      );
    }

    const next = stored.filter(id => id !== targetId);
    if (next.length === stored.length) {
      return discordChannelReply(`<@${targetId}> n'est pas dans la liste admin.`);
    }

    await writeAdminAllowlist(env, next);
    return discordChannelReply(`🔒 <@${targetId}> n'a plus accès à ADMIN.`);
  }

  return discordChannelReply("Commande inconnue.");
}

async function handleDiscordInteraction(request, env, ctx) {
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
    return handleAdminSlashCommand(interaction, env, ctx);
  }

  if (interaction.type !== 3) {
    return discordEphemeral("Interaction non prise en charge.");
  }

  const customId = interaction.data?.custom_id || "";

  if (customId === PROD_VALIDATE_OUI || customId === PROD_VALIDATE_NON) {
    return handleProductionValidateButton(interaction, env);
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

function stockAdjustSheetRange(env) {
  return String(env.GOOGLE_STOCK_ADJUST_RANGE || "Stock!A11:F").trim();
}

function stockAdjustSpreadsheetId(env) {
  return normalizeSpreadsheetId(
    env.GOOGLE_STOCK_ADJUST_SPREADSHEET_ID || env.GOOGLE_SHEETS_SPREADSHEET_ID
  );
}

/** Date au format de l’onglet ajustements : DD.MM.YYYY */
function parisDateDots(date = new Date()) {
  return parisDateString(date).replace(/\//g, ".");
}

async function appendGoogleSheetRow(env, spreadsheetId, range, row) {
  if (!spreadsheetId) {
    throw new Error("Google Sheets spreadsheet ID is missing");
  }
  if (!range) {
    throw new Error("Google Sheets range is missing");
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

async function appendProductionSheetRow(env, row) {
  return appendGoogleSheetRow(
    env,
    normalizeSpreadsheetId(env.GOOGLE_SHEETS_SPREADSHEET_ID),
    productionSheetRange(env),
    row
  );
}

/**
 * Ligne onglet ajustements stock :
 * Date | Vente particuliers | Vente grossiste | Quantité (−) | BOT | automatique
 */
function buildStockAdjustRow(stock, date = parisDateDots()) {
  const qty = -Math.abs(Number(stock) || 0);
  return [
    date,
    "Vente particuliers",
    "Vente grossiste",
    qty,
    "BOT",
    "automatique"
  ];
}

async function appendStockAdjustSheetRow(env, stock, date) {
  const range = stockAdjustSheetRange(env);
  if (!range) {
    return { skipped: true };
  }

  return appendGoogleSheetRow(
    env,
    stockAdjustSpreadsheetId(env),
    range,
    buildStockAdjustRow(stock, date || parisDateDots())
  );
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

function todayRangeParis(now = new Date()) {
  const today = parisYmdParts(now);
  return { start: today, end: today };
}

function resolveStatsRange(period, now = new Date()) {
  if (period === "day") return todayRangeParis(now);
  if (period === "previous") return previousIsoWeekRangeParis(now);
  return currentIsoWeekRangeParis(now);
}

function resolveRecapRange(period, now = new Date()) {
  return period === "current"
    ? currentIsoWeekRangeParis(now)
    : previousIsoWeekRangeParis(now);
}

function buildWeeklyProductionRecap(rows, range, employeFilter = "") {
  const totals = new Map();
  let entries = 0;
  let menusTotal = 0;
  const filter = String(employeFilter || "").trim().toLowerCase();

  for (const row of rows) {
    const date = parseSheetDate(row[0]);
    if (!date) continue;
    if (date.key < range.start.key || date.key > range.end.key) continue;

    const employe = String(row[1] || "").trim();
    const menus = Number(String(row[2] || "").replace(/\s/g, "").replace(",", "."));
    if (!employe || !Number.isFinite(menus)) continue;

    if (filter && !employe.toLowerCase().includes(filter)) continue;

    entries += 1;
    menusTotal += menus;
    totals.set(employe, (totals.get(employe) || 0) + menus);
  }

  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "fr"));

  return {
    entries,
    menusTotal,
    ranked,
    employeFilter: String(employeFilter || "").trim()
  };
}

function formatWeeklyRecapMessage(range, summary, period = "previous") {
  const periodLabel = period === "current" ? "semaine en cours" : "hebdo";
  const periodDates = `${formatYmd(range.start)} → ${formatYmd(range.end)}`;
  const filterLabel = summary.employeFilter
    ? ` · employé **${summary.employeFilter}**`
    : "";

  if (!summary.ranked.length) {
    return (
      `📊 **Récap production ${periodLabel}** (${periodDates})${filterLabel}\n` +
      `Aucune déclaration trouvée sur la période.`
    );
  }

  const lines = summary.ranked.map(
    ([name, total], index) => `${index + 1}. **${name}** — ${Math.round(total)} menus`
  );

  return (
    `📊 **Récap production ${periodLabel}** (${periodDates})${filterLabel}\n` +
    `Déclarations : **${summary.entries}** · Menus : **${Math.round(summary.menusTotal)}**\n\n` +
    lines.join("\n")
  );
}

async function runWeeklyProductionRecap(
  env,
  period = "previous",
  employeFilter = "",
  options = {}
) {
  const range = resolveRecapRange(period);
  const rows = await readProductionSheetRows(env);
  const summary = buildWeeklyProductionRecap(rows, range, employeFilter);
  const content = formatWeeklyRecapMessage(range, summary, period);

  if (!options.skipDiscordPost) {
    const webhook =
      env.DISCORD_RECAP_WEBHOOK_URL ||
      env.DISCORD_ALERT_WEBHOOK_URL ||
      env.DISCORD_PRODUCTION_WEBHOOK_URL;

    const posted = await postDiscordWebhookContent(webhook, content);
    if (!posted) {
      throw new Error("Impossible de poster le récap Discord");
    }
  }

  console.log("[production] weekly recap", period, employeFilter || "*", content);
  return {
    ok: true,
    period,
    employeFilter: summary.employeFilter,
    range,
    summary,
    content
  };
}

async function buildProductionStatsContent(env, period = "day", employeFilter = "") {
  const range = resolveStatsRange(period);
  const rows = await readProductionSheetRows(env);
  const summary = buildWeeklyProductionRecap(rows, range, employeFilter);

  const periodLabel =
    period === "day"
      ? "du jour"
      : period === "previous"
        ? "semaine précédente"
        : "semaine en cours";
  const periodDates = `${formatYmd(range.start)} → ${formatYmd(range.end)}`;
  const filterLabel = summary.employeFilter
    ? ` · employé **${summary.employeFilter}**`
    : "";

  if (!summary.ranked.length) {
    return {
      content:
        `📈 **Stats production ${periodLabel}** (${periodDates})${filterLabel}\n` +
        `Aucune déclaration validée sur la période.`
    };
  }

  const lines = summary.ranked
    .slice(0, 15)
    .map(([name, total], index) => `${index + 1}. **${name}** — ${Math.round(total)} menus`);

  return {
    content:
      `📈 **Stats production ${periodLabel}** (${periodDates})${filterLabel}\n` +
      `Déclarations : **${summary.entries}** · Menus : **${Math.round(summary.menusTotal)}**\n\n` +
      lines.join("\n")
  };
}

async function runPendingProductionReminders(env) {
  if (!env.SITE_STATE) return { reminded: 0 };

  const hoursRaw = Number(env.PRODUCTION_PENDING_REMINDER_HOURS || 6);
  const hours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? hoursRaw : 6;
  const thresholdMs = hours * 60 * 60 * 1000;
  const now = Date.now();
  let reminded = 0;
  let cursor;

  do {
    const listed = await env.SITE_STATE.list({
      prefix: "production_pending:",
      cursor,
      limit: 100
    });

    for (const key of listed.keys) {
      const raw = await env.SITE_STATE.get(key.name);
      if (!raw) continue;

      let pending;
      try {
        pending = JSON.parse(raw);
      } catch {
        continue;
      }

      const createdAt = Date.parse(pending.createdAt || "");
      if (!Number.isFinite(createdAt)) continue;
      if (now - createdAt < thresholdMs) continue;
      if (pending.remindedAt) continue;

      const ageHours = Math.floor((now - createdAt) / (60 * 60 * 1000));
      const link = pending.discordUrl || key.name.replace("production_pending:", "");
      await postProductionAlert(
        env,
        `⏰ **Rappel validation production**\n` +
          `**${pending.nom || "?"}** — ${pending.stock ?? "?"} menus\n` +
          `En attente depuis ~**${ageHours} h**\n` +
          `${link}`
      );

      pending.remindedAt = new Date().toISOString();
      await env.SITE_STATE.put(key.name, JSON.stringify(pending), {
        expirationTtl: PRODUCTION_PENDING_TTL
      });
      reminded += 1;
    }

    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);

  console.log("[production] pending reminders sent:", reminded);
  return { reminded };
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
  let employe = String(url.searchParams.get("employe") || "").trim();

  try {
    const body = await request.clone().json().catch(() => null);
    if (body?.period) period = String(body.period).toLowerCase();
    if (body?.employe) employe = String(body.employe).trim();
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
    const result = await runWeeklyProductionRecap(env, period, employe);
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

function productionValidateComponents(disabled = false, validatedLabel = "") {
  if (disabled) {
    return [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 2,
            label: validatedLabel || "Traité",
            custom_id: "prod_validate:done",
            disabled: true
          }
        ]
      }
    ];
  }

  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 3,
          label: "Valider",
          custom_id: PROD_VALIDATE_OUI
        },
        {
          type: 2,
          style: 4,
          label: "Refuser",
          custom_id: PROD_VALIDATE_NON
        }
      ]
    }
  ];
}

async function handleProductionValidateButton(interaction, env) {
  const guildId = interaction.guild_id || "";
  if (guildId !== env.DISCORD_GUILD_ID) {
    return discordEphemeral("Ce bouton n'est pas autorisé ici.");
  }

  if (!(await canUseBotCommands(interaction, env))) {
    const roleConfigured = getBotRoleIds(env).length > 0;
    return discordEphemeral(
      roleConfigured
        ? "Tu n'as pas le rôle requis pour valider une production."
        : "Tu n'as pas la permission de valider une production."
    );
  }

  const customId = interaction.data?.custom_id || "";
  const approved = customId === PROD_VALIDATE_OUI;
  const messageId = interaction.message?.id || "";
  const actorId = getInteractionUserId(interaction);
  const baseContent = String(interaction.message?.content || "").trim();

  if (!messageId) {
    return discordEphemeral("Message Discord introuvable.");
  }

  if (!env.SITE_STATE) {
    return discordEphemeral("SITE_STATE KV manquant : impossible de valider.");
  }

  const pendingKey = `production_pending:${messageId}`;
  const pendingRaw = await env.SITE_STATE.get(pendingKey);

  if (!pendingRaw) {
    return discordEphemeral(
      "Cette déclaration n'est plus en attente (déjà traitée ou expirée)."
    );
  }

  let pending;
  try {
    pending = JSON.parse(pendingRaw);
  } catch {
    return discordEphemeral("Données de déclaration invalides.");
  }

  const actor =
    interaction.member?.user?.global_name ||
    interaction.member?.user?.username ||
    interaction.user?.global_name ||
    interaction.user?.username ||
    actorId;

  const commentaire = approved ? `Validé par ${actor}` : "";

  const sheetRow = [
    pending.date || parisDateString(),
    pending.nom,
    String(pending.stock),
    "Oui",
    "BOT",
    pending.discordUrl || "",
    commentaire
  ];

  let adjustStatus = "";

  if (approved) {
    try {
      await appendProductionSheetRow(env, sheetRow);
    } catch (error) {
      console.error("[production] validate sheets error:", error?.message || error);
      await postProductionAlert(
        env,
        `❌ **Alerte validation → Sheets**\n` +
          `**${pending.nom}** (${pending.stock})\n` +
          `${error?.message || "unknown"}`
      );
      return discordEphemeral(
        `❌ Impossible d'écrire dans Google Sheets : ${error?.message || "unknown"}`
      );
    }

    try {
      const adjust = await appendStockAdjustSheetRow(env, pending.stock);
      if (adjust?.skipped) {
        adjustStatus =
          "\n⚠️ Ajustement stock **non écrit** : variable `GOOGLE_STOCK_ADJUST_RANGE` manquante.";
        await postProductionAlert(
          env,
          `⚠️ **Ajustement stock ignoré**\n` +
            `Définis la variable Cloudflare \`GOOGLE_STOCK_ADJUST_RANGE\` ` +
            `(ex. \`NomOnglet!A:F\`).\n` +
            `Production **${pending.nom}** (${pending.stock}) OK.`
        );
      } else {
        adjustStatus = "\n📦 Ajustement stock : **écrit** (Vente particuliers / grossiste).";
      }
    } catch (error) {
      console.error("[production] stock adjust sheets error:", error?.message || error);
      adjustStatus = `\n⚠️ Ajustement stock **échoué** : ${error?.message || "unknown"}`;
      await postProductionAlert(
        env,
        `⚠️ **Production OK, ajustement stock échoué**\n` +
          `**${pending.nom}** (${pending.stock})\n` +
          `Range : \`${stockAdjustSheetRange(env) || "(vide)"}\`\n` +
          `${error?.message || "unknown"}`
      );
    }
  }

  await env.SITE_STATE.delete(pendingKey);

  const statusLine = approved
    ? `✅ **Validé** par <@${actorId}> — écrit dans Google Sheets${adjustStatus}`
    : `🚫 **Refusé** par <@${actorId}> — non écrit dans Google Sheets`;

  const nextContent = baseContent
    ? `${baseContent}\n\n${statusLine}`
    : statusLine;

  return json({
    type: 7,
    data: {
      content: nextContent,
      components: productionValidateComponents(
        true,
        approved ? "Validé" : "Refusé"
      )
    }
  });
}

async function postProductionDiscordMessage(env, nom, stock, proofFiles = []) {
  const staffRoleId = String(env.PRODUCTION_STAFF_ROLE_ID || "").trim();
  const mention = /^\d+$/.test(staffRoleId) ? `<@&${staffRoleId}> ` : "";
  const files = Array.isArray(proofFiles)
    ? proofFiles.filter(file => file instanceof File || file instanceof Blob)
    : [];

  const content =
    `${mention}Nouvelle déclaration de production\n` +
    `Nom : ${nom}\n` +
    `Stock produit : ${stock}` +
    (files.length > 1 ? `\nPreuves : ${files.length} images` : "");

  const guildId = env.DISCORD_GUILD_ID;
  const channelId = String(env.PRODUCTION_DISCORD_CHANNEL_ID || "").trim();
  const botToken = String(env.DISCORD_BOT_TOKEN || "").trim();
  const components = productionValidateComponents();

  if (!botToken) {
    throw new Error(
      "DISCORD_BOT_TOKEN manquant (secret Cloudflare) — requis pour les boutons Valider/Refuser"
    );
  }

  if (!/^\d+$/.test(channelId)) {
    throw new Error(
      "PRODUCTION_DISCORD_CHANNEL_ID invalide — colle l'ID numérique du salon #production-whebooks"
    );
  }

  if (!guildId) {
    throw new Error("DISCORD_GUILD_ID manquant");
  }

  const payload = {
    content,
    components,
    allowed_mentions: /^\d+$/.test(staffRoleId)
      ? { parse: [], roles: [staffRoleId] }
      : { parse: [] }
  };

  const endpoint = `https://discord.com/api/v10/channels/${channelId}/messages`;
  let response;

  if (files.length) {
    const body = new FormData();
    body.append("payload_json", JSON.stringify(payload));
    files.forEach((file, index) => {
      const filename =
        (file instanceof File && file.name) || `preuve-${index + 1}.png`;
      body.append(`files[${index}]`, file, filename);
    });
    response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bot ${botToken}` },
      body
    });
  } else {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id) {
    throw new Error(
      `Discord bot message failed (${response.status}): ${data.message || JSON.stringify(data)}`
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

async function recordProductionDeclaration(env, { nom, stock, proofFile = null, proofFiles = null }) {
  const date = parisDateString();
  const dedupKey = await buildProductionDedupKey(nom, stock);
  const files = Array.isArray(proofFiles) && proofFiles.length
    ? proofFiles
    : proofFile
      ? [proofFile]
      : [];

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
            message: `✅ Production déjà déclarée (délai < 1 h) — ${stock} × ${nom}`,
            discordUrl: previous.discordUrl || null,
            pending: true
          });
        }
      } catch {
        return json({
          ok: true,
          duplicate: true,
          message: `✅ Production déjà déclarée (délai < 1 h) — ${stock} × ${nom}`,
          pending: true
        });
      }
    }
  }

  let discord;
  try {
    discord = await postProductionDiscordMessage(env, nom, stock, files);
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

  if (env.SITE_STATE) {
    await env.SITE_STATE.put(
      `production_pending:${discord.messageId}`,
      JSON.stringify({
        nom,
        stock,
        date,
        discordUrl: discord.discordUrl,
        proofCount: files.length,
        createdAt: new Date().toISOString()
      }),
      { expirationTtl: PRODUCTION_PENDING_TTL }
    );

    await env.SITE_STATE.put(
      dedupKey,
      JSON.stringify({
        discordUrl: discord.discordUrl,
        messageId: discord.messageId,
        createdAt: new Date().toISOString()
      }),
      { expirationTtl: PRODUCTION_DEDUP_TTL }
    );
  }

  const message =
    `⏳ Déclaration postée sur Discord — en attente de validation (Oui/Non) — ${stock} × ${nom}` +
    (files.length > 1 ? ` · ${files.length} images` : "");
  console.log("[production]", message, discord.discordUrl);

  return json({
    ok: true,
    pending: true,
    message,
    discordUrl: discord.discordUrl,
    proofCount: files.length
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/index.html")
    ) {
      const indexUrl = new URL("/index.html", request.url);
      const page = await env.ASSETS.fetch(new Request(indexUrl, request));
      const headers = new Headers(page.headers);
      headers.set("Cache-Control", "public, max-age=300, stale-while-revalidate=86400");
      return new Response(page.body, { status: page.status, headers });
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
      return handleDiscordInteraction(request, env, ctx);
    }

    if (
      url.pathname.startsWith("/api/") ||
      url.pathname === "/admin" ||
      url.pathname.startsWith("/admin/") ||
      url.pathname === "/discord/interactions"
    ) {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "GET, POST" }
      });
    }

    return withStaticAssetCache(await env.ASSETS.fetch(request));
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          if (event.cron === "0 * * * *") {
            await runPendingProductionReminders(env);
            return;
          }

          await runWeeklyProductionRecap(env);
        } catch (error) {
          console.error("[production] scheduled error:", error?.message || error);
          await postProductionAlert(
            env,
            `❌ **Alerte cron production**\n${error?.message || "unknown"}`
          );
        }
      })()
    );
  }
};
