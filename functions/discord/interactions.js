const EXPECTED_MESSAGE_ID = "1537545350313938954";
const OPEN_ID = "restaurant_open";
const CLOSED_ID = "restaurant_closed";

function hexToBytes(hex) {
  if (!hex || hex.length % 2 !== 0) return new Uint8Array();
  return new Uint8Array(hex.match(/../g).map(byte => Number.parseInt(byte, 16)));
}

async function verifyDiscordRequest(request, publicKeyHex, rawBody) {
  const signatureHex = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");

  if (!signatureHex || !timestamp || !publicKeyHex) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(publicKeyHex),
    { name: "Ed25519" },
    false,
    ["verify"]
  );

  const message = new TextEncoder().encode(timestamp + rawBody);

  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    hexToBytes(signatureHex),
    message
  );
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

export async function onRequestPost(context) {
  const request = context.request;
  const rawBody = await request.text();

  const valid = await verifyDiscordRequest(
    request,
    context.env.DISCORD_PUBLIC_KEY,
    rawBody
  );

  if (!valid) return new Response("invalid request signature", { status: 401 });

  const interaction = JSON.parse(rawBody);

  // Discord vérifie l'endpoint avec un PING.
  if (interaction.type === 1) {
    return json({ type: 1 });
  }

  // Message component / bouton.
  if (interaction.type !== 3) {
    return json({
      type: 4,
      data: { content: "Interaction non prise en charge.", flags: 64 }
    });
  }

  if (interaction.message?.id !== EXPECTED_MESSAGE_ID) {
    return json({
      type: 4,
      data: { content: "Ce bouton n'est pas relié au statut du site.", flags: 64 }
    });
  }

  const customId = interaction.data?.custom_id;
  let status = null;

  if (customId === OPEN_ID) status = "open";
  if (customId === CLOSED_ID) status = "closed";

  if (!status) {
    return json({
      type: 4,
      data: { content: "Bouton inconnu.", flags: 64 }
    });
  }

  await context.env.SITE_STATE.put("restaurant_status", status);
  await context.env.SITE_STATE.put(
    "restaurant_status_updated_at",
    new Date().toISOString()
  );

  return json({
    type: 4,
    data: {
      content: status === "open"
        ? "✅ Le site affiche maintenant **OUVERT**."
        : "🔴 Le site affiche maintenant **FERMÉ**.",
      flags: 64
    }
  });
}
