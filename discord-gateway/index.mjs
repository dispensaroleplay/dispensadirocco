/**
 * Gateway Discord — logs de suppression de messages (tous salons).
 *
 * Requis (Developer Portal → Bot) :
 * - Intent Privileged : Message Content
 * - Intent : Server Members (optionnel), Guilds, Guild Messages, Moderation
 *
 * Env :
 * - DISCORD_BOT_TOKEN
 * - DISCORD_DELETE_LOG_CHANNEL_ID (défaut : 1540326524484583465)
 * - DISCORD_GUILD_ID (optionnel : ne logger que cette guild)
 */

import {
  AuditLogEvent,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Partials
} from "discord.js";

const TOKEN = String(process.env.DISCORD_BOT_TOKEN || "").trim();
const LOG_CHANNEL_ID = String(
  process.env.DISCORD_DELETE_LOG_CHANNEL_ID || "1540326524484583465"
).trim();
const GUILD_ID = String(process.env.DISCORD_GUILD_ID || "").trim();
const CACHE_MAX = Number(process.env.MESSAGE_CACHE_MAX || 12000);

if (!TOKEN) {
  console.error("[gateway] DISCORD_BOT_TOKEN manquant");
  process.exit(1);
}

if (!/^\d+$/.test(LOG_CHANNEL_ID)) {
  console.error("[gateway] DISCORD_DELETE_LOG_CHANNEL_ID invalide");
  process.exit(1);
}

/** @type {Map<string, CachedMessage>} */
const messageCache = new Map();

/**
 * @typedef {object} CachedMessage
 * @property {string} id
 * @property {string} guildId
 * @property {string} channelId
 * @property {string} authorId
 * @property {string} authorTag
 * @property {string|null} authorAvatar
 * @property {string} content
 * @property {string[]} attachments
 * @property {number} createdTimestamp
 * @property {boolean} bot
 */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember]
});

function trimCache() {
  while (messageCache.size > CACHE_MAX) {
    const oldest = messageCache.keys().next().value;
    if (oldest === undefined) break;
    messageCache.delete(oldest);
  }
}

/**
 * @param {import('discord.js').Message} message
 */
function cacheMessage(message) {
  if (!message?.id || !message.guild || message.system) return;
  if (GUILD_ID && message.guild.id !== GUILD_ID) return;

  /** @type {CachedMessage} */
  const entry = {
    id: message.id,
    guildId: message.guild.id,
    channelId: message.channelId,
    authorId: message.author?.id || "unknown",
    authorTag: message.author
      ? `${message.author.username}${message.author.discriminator && message.author.discriminator !== "0" ? `#${message.author.discriminator}` : ""}`
      : "Inconnu",
    authorAvatar: message.author?.displayAvatarURL({ size: 128 }) || null,
    content: String(message.content || ""),
    attachments: [...message.attachments.values()].map((a) => a.url),
    createdTimestamp: message.createdTimestamp || Date.now(),
    bot: Boolean(message.author?.bot)
  };

  messageCache.set(message.id, entry);
  trimCache();
}

/**
 * @param {import('discord.js').Guild} guild
 * @param {string} channelId
 * @param {string} authorId
 */
async function resolveDeleter(guild, channelId, authorId) {
  try {
    const logs = await guild.fetchAuditLogs({
      type: AuditLogEvent.MessageDelete,
      limit: 8
    });
    const now = Date.now();
    const entry = [...logs.entries.values()].find((item) => {
      if (now - item.createdTimestamp > 20_000) return false;
      if (item.target?.id && authorId !== "unknown" && item.target.id !== authorId) {
        return false;
      }
      const extraChannelId =
        item.extra?.channel?.id ||
        item.extra?.channelId ||
        null;
      if (extraChannelId && extraChannelId !== channelId) return false;
      return true;
    });
    return entry?.executor || null;
  } catch (error) {
    console.warn("[gateway] audit log:", error?.message || error);
    return null;
  }
}

/**
 * @param {import('discord.js').TextBasedChannel} logChannel
 * @param {object} payload
 */
async function sendDeleteLog(logChannel, payload) {
  const {
    cached,
    channelId,
    messageId,
    deleter,
    bulkCount = null
  } = payload;

  const content =
    cached?.content?.trim() ||
    "*Contenu indisponible (message trop ancien ou non mis en cache).*";
  const clipped =
    content.length > 3500 ? `${content.slice(0, 3490)}…` : content;

  const embed = new EmbedBuilder()
    .setColor(0xd6555f)
    .setTitle(bulkCount ? `Message supprimé (lot ×${bulkCount})` : "Message supprimé")
    .setDescription(clipped)
    .addFields(
      {
        name: "Auteur",
        value: cached
          ? `<@${cached.authorId}> (\`${cached.authorTag}\`)`
          : "*Inconnu*",
        inline: true
      },
      {
        name: "Salon",
        value: `<#${channelId}>`,
        inline: true
      },
      {
        name: "Supprimé par",
        value: deleter
          ? `<@${deleter.id}> (\`${deleter.username}\`)`
          : "*Auteur ou inconnu (pas d’entrée audit récente)*",
        inline: true
      },
      {
        name: "ID message",
        value: `\`${messageId}\``,
        inline: true
      }
    )
    .setTimestamp(cached?.createdTimestamp ? new Date(cached.createdTimestamp) : new Date());

  if (cached?.authorAvatar) {
    embed.setThumbnail(cached.authorAvatar);
  }

  if (cached?.attachments?.length) {
    embed.addFields({
      name: `Pièces jointes (${cached.attachments.length})`,
      value: cached.attachments
        .slice(0, 5)
        .map((url, i) => `[Fichier ${i + 1}](${url})`)
        .join("\n")
        .slice(0, 1000)
    });
  }

  await logChannel.send({ embeds: [embed] });
}

client.once("ready", () => {
  console.log(
    `[gateway] connecté en tant que ${client.user.tag} — logs → ${LOG_CHANNEL_ID} — cache max ${CACHE_MAX}`
  );
});

client.on("messageCreate", (message) => {
  cacheMessage(message);
});

client.on("messageUpdate", (_oldMessage, newMessage) => {
  if (newMessage.partial) return;
  cacheMessage(newMessage);
});

client.on("messageDelete", async (message) => {
  try {
    const guild = message.guild;
    if (!guild) return;
    if (GUILD_ID && guild.id !== GUILD_ID) return;

    const channelId = message.channelId;
    const messageId = message.id;
    const cached = messageCache.get(messageId) || null;
    messageCache.delete(messageId);

    // Évite de logger nos propres embeds de log (boucle visuelle inutile)
    if (channelId === LOG_CHANNEL_ID && cached?.bot && cached.authorId === client.user?.id) {
      return;
    }

    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (!logChannel || !logChannel.isTextBased()) {
      console.error("[gateway] salon de logs introuvable ou non textuel");
      return;
    }

    const authorId = cached?.authorId || message.author?.id || "unknown";
    const deleter = await resolveDeleter(guild, channelId, authorId);

    await sendDeleteLog(logChannel, {
      cached: cached || (message.author
        ? {
            id: messageId,
            guildId: guild.id,
            channelId,
            authorId: message.author.id,
            authorTag: message.author.username,
            authorAvatar: message.author.displayAvatarURL({ size: 128 }),
            content: message.content || "",
            attachments: [...(message.attachments?.values?.() || [])].map((a) => a.url),
            createdTimestamp: message.createdTimestamp || Date.now(),
            bot: Boolean(message.author.bot)
          }
        : null),
      channelId,
      messageId,
      deleter
    });
  } catch (error) {
    console.error("[gateway] messageDelete error:", error?.message || error);
  }
});

client.on("messageDeleteBulk", async (messages, channel) => {
  try {
    const guild = channel.guild;
    if (!guild) return;
    if (GUILD_ID && guild.id !== GUILD_ID) return;
    if (channel.id === LOG_CHANNEL_ID) return;

    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (!logChannel || !logChannel.isTextBased()) return;

    const sample = [...messages.values()].slice(0, 8);
    for (const message of sample) {
      const cached = messageCache.get(message.id) || null;
      messageCache.delete(message.id);
      const authorId = cached?.authorId || message.author?.id || "unknown";
      const deleter = await resolveDeleter(guild, channel.id, authorId);
      await sendDeleteLog(logChannel, {
        cached,
        channelId: channel.id,
        messageId: message.id,
        deleter,
        bulkCount: messages.size
      });
    }

    if (messages.size > sample.length) {
      await logChannel.send({
        content:
          `🗑️ Suppression en lot : **${messages.size}** messages dans <#${channel.id}> ` +
          `(${messages.size - sample.length} non détaillés ici).`
      });
    }
  } catch (error) {
    console.error("[gateway] messageDeleteBulk error:", error?.message || error);
  }
});

client.login(TOKEN).catch((error) => {
  console.error("[gateway] login failed:", error?.message || error);
  process.exit(1);
});
