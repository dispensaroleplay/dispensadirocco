# Gateway Discord — logs de suppression

Companion du Worker Cloudflare. Le Worker gère slash/boutons ; **ce process** reste connecté en Gateway pour journaliser les suppressions de messages.

## Salon de logs

Par défaut : `1540326524484583465`  
Variable : `DISCORD_DELETE_LOG_CHANNEL_ID`

## Configuration Discord Developer Portal

1. Application du bot → **Bot**
2. Active l’intent privilégié **Message Content Intent**
3. Active aussi **Server Members Intent** seulement si tu en as besoin ailleurs (pas obligatoire pour les deletes)
4. Le bot doit voir **tous les salons** à logger + le salon de logs (permissions : View Channel, Send Messages, Embed Links, Read Message History, View Audit Log)

Invite / permissions recommandées : `ViewChannel`, `SendMessages`, `EmbedLinks`, `ReadMessageHistory`, `ViewAuditLog`.

## Variables d’environnement

| Variable | Requis | Rôle |
|----------|--------|------|
| `DISCORD_BOT_TOKEN` | oui | Même token que le Worker |
| `DISCORD_DELETE_LOG_CHANNEL_ID` | non | Défaut `1540326524484583465` |
| `DISCORD_GUILD_ID` | non | Si défini, ignore les autres serveurs |
| `MESSAGE_CACHE_MAX` | non | Défaut `12000` messages en RAM |

## Lancer en local

```powershell
cd discord-gateway
npm install
$env:DISCORD_BOT_TOKEN="ton_token"
$env:DISCORD_GUILD_ID="1529971523924791478"
npm start
```

## Déployer (ex. Railway / Render / Fly)

Le Worker Cloudflare **ne peut pas** héberger ce process. Héberge `discord-gateway` sur un petit VPS ou PaaS always-on :

1. Root directory : `discord-gateway`
2. Start command : `npm start`
3. Ajoute les variables d’env ci-dessus
4. Laisse tourner 24/7

## Limites

- Messages jamais vus par le bot (avant démarrage / hors cache) → log sans contenu
- « Supprimé par » vient des **audit logs** (délai Discord) ; auto-suppression auteur = parfois « inconnu »
- Ne remplace pas un bot mod complet (warn/kick/etc.)
