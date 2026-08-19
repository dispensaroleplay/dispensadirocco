// La Dispensa Di Rocco — Cloudflare Workers + static assets
//
// This Worker handles:
// - GET  /api/status
// - POST /discord/interactions
// - all static site files through env.ASSETS (./public)
//
// Secrets are NOT stored in this file.
// They are injected by Cloudflare through env.* bindings.

const OPEN_ID = "restaurant_open";
const CLOSED_ID = "restaurant_closed";

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

function hexToBytes(hex) {
  if (!hex || hex.length % 2 !== 0) return new Uint8Array();

  const pairs = hex.match(/../g);
  if (!pairs) return new Uint8Array();

  return new Uint8Array(
    pairs.map(value => Number.parseInt(value, 16))
  );
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

async function handleDiscordInteraction(request, env) {
  if (!env.DISCORD_PUBLIC_KEY) {
    return json(
      { error: "DISCORD_PUBLIC_KEY secret is not configured" },
      { status: 503 }
    );
  }

  if (!env.SITE_STATE) {
    return json(
      { error: "SITE_STATE KV binding is not configured" },
      { status: 503 }
    );
  }

  const rawBody = await request.text();

  const valid = await verifyDiscordRequest(
    request,
    rawBody,
    env.DISCORD_PUBLIC_KEY
  );

  if (!valid) {
    return new Response("invalid request signature", { status: 401 });
  }

  let interaction;

  try {
    interaction = JSON.parse(rawBody);
  } catch {
    return new Response("invalid json", { status: 400 });
  }

  // Discord PING used when validating the Interactions Endpoint URL.
  if (interaction.type === 1) {
    return json({ type: 1 });
  }

  // Only accept button / message-component interactions.
  if (interaction.type !== 3) {
    return json({
      type: 4,
      data: {
        content: "Interaction non prise en charge.",
        flags: 64
      }
    });
  }

  // Lock interactions to the intended server/channel/message IDs.
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
    return json({
      type: 4,
      data: {
        content: "Ce bouton n'est pas autorisé à modifier le statut du site.",
        flags: 64
      }
    });
  }

  const customId = interaction.data?.custom_id;
  let status = null;

  if (customId === OPEN_ID) status = "open";
  if (customId === CLOSED_ID) status = "closed";

  if (!status) {
    return json({
      type: 4,
      data: {
        content: "Bouton inconnu.",
        flags: 64
      }
    });
  }

  await env.SITE_STATE.put("restaurant_status", status);
  await env.SITE_STATE.put(
    "restaurant_status_updated_at",
    new Date().toISOString()
  );

  return json({
    type: 4,
    data: {
      content:
        status === "open"
          ? "✅ Le site affiche maintenant **OUVERT**."
          : "🔴 Le site affiche maintenant **FERMÉ**.",
      flags: 64
    }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Force l'URL racine à servir explicitement la page d'accueil.
    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/index.html")
    ) {
      const indexUrl = new URL("/index.html", request.url);
      return env.ASSETS.fetch(new Request(indexUrl, request));
    }

    // API de statut utilisée par le site.
    if (request.method === "GET" && url.pathname === "/api/status") {
      return getRestaurantStatus(env);
    }

    // Endpoint des interactions Discord.
    if (
      request.method === "POST" &&
      url.pathname === "/discord/interactions"
    ) {
      return handleDiscordInteraction(request, env);
    }

    if (
      url.pathname === "/api/status" ||
      url.pathname === "/discord/interactions"
    ) {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { "Allow": "GET, POST" }
      });
    }

    // Tous les autres fichiers statiques passent par le binding ASSETS.
    return env.ASSETS.fetch(request);
  }
};
