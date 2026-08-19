// La Dispensa Di Rocco — Cloudflare Workers + static assets
//
// Routes:
// - GET  /api/status
// - GET  /api/admin/access
// - GET  /admin, /admin/login, /admin/callback
// - POST /discord/interactions
// - static files via env.ASSETS (./site)

const OPEN_ID = "restaurant_open";
const CLOSED_ID = "restaurant_closed";
const ADMIN_ALLOWLIST_KEY = "admin_allowlist";
const SESSION_COOKIE = "dispensa_admin";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

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

async function handleAdminGate(request, env) {
  const userId = await getSessionUserId(request, env);
  if (userId) {
    return redirect(env.ADMIN_REDIRECT_URL || "/");
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

  const actorId = getInteractionUserId(interaction);
  if (!(await isAdminDiscordId(actorId, env))) {
    return discordEphemeral("Tu n'as pas la permission de gérer les accès admin.");
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
  }
};
