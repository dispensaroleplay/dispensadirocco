import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const APP_ID = "1539720751828041728";
const GUILD_ID = "1529971523924791478";
const token = process.env.DISCORD_BOT_TOKEN?.trim();

if (!token) {
  console.error("Variable manquante : DISCORD_BOT_TOKEN");
  console.error('Exemple PowerShell : $env:DISCORD_BOT_TOKEN="ton_token"; node scripts/register-discord-commands.mjs');
  process.exit(1);
}

const dir = dirname(fileURLToPath(import.meta.url));
const commands = JSON.parse(
  readFileSync(join(dir, "commands.guild.json"), "utf8")
);

const headers = {
  Authorization: `Bot ${token}`,
  "Content-Type": "application/json"
};

const me = await fetch("https://discord.com/api/v10/users/@me", { headers });
const meData = await me.json();

if (!me.ok) {
  console.error("Token bot invalide :", meData);
  console.error("Utilise le token de l'onglet Bot (pas le Client Secret OAuth2).");
  process.exit(1);
}

console.log(`Bot connecte : ${meData.username}#${meData.discriminator || "0"} (${meData.id})`);

const url = `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`;
const response = await fetch(url, {
  method: "PUT",
  headers,
  body: JSON.stringify(commands)
});

const data = await response.json();

if (!response.ok) {
  console.error("Echec enregistrement commandes :", data);
  process.exit(1);
}

console.log("Commandes enregistrees sur le serveur :");
for (const command of data) {
  console.log(`- /${command.name}`);
}
