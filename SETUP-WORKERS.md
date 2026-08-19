# Cloudflare Workers — déploiement

## Structure

Les fichiers du site sont dans `site/` :

```text
site/index.html
site/404.html
site/styles.css
site/script.js
site/assets/
worker.js
wrangler.jsonc
```

`wrangler.jsonc` :

```json
"assets": {
  "directory": "./site",
  "binding": "ASSETS",
  "not_found_handling": "404-page",
  "html_handling": "none",
  "run_worker_first": true
}
```

Ne pas utiliser `"."` comme directory : Wrangler inclurait `.git` et `node_modules`, ce qui fait échouer le déploiement.

## Commandes

```bash
npm install
npx wrangler deploy
```

## Dashboard Cloudflare

- **Build command** : `npm run build` (optionnel)
- **Deploy command** : `npx wrangler deploy`
- **Root directory** : laisser vide (racine du repo)

Le nom du Worker doit être **dispensadirocco**.

## Bindings requis (dashboard Cloudflare)

| Nom | Type | Rôle |
|-----|------|------|
| `SITE_STATE` | KV Namespace | Statut OUVERT / FERMÉ |
| `DISCORD_PUBLIC_KEY` | Secret | Vérification des interactions Discord |
| `ASSETS` | Assets | Configuré automatiquement via `wrangler.jsonc` |

Variables déjà dans `wrangler.jsonc` : `DISCORD_GUILD_ID`, `DISCORD_CHANNEL_ID`, `DISCORD_MESSAGE_ID`.

Endpoint Discord : `https://<ton-domaine>/discord/interactions`
