# La Dispensa Di Rocco — Workers

Site vitrine + API de statut Discord, déployé en Cloudflare Workers.

Structure :

```text
site/index.html
site/404.html
site/styles.css
site/script.js
site/assets/
worker.js
wrangler.jsonc
package.json
```

- Fichiers publics dans **`site/`** (dossier dédié, isolé de `.git` / `node_modules`)
- Worker : `worker.js` — config : `wrangler.jsonc`

Le binding KV `SITE_STATE` et le secret `DISCORD_PUBLIC_KEY` se configurent dans le dashboard Cloudflare (`keep_vars: true`).

## Cloudflare Workers Builds

| Paramètre | Valeur |
|-----------|--------|
| Build command | `npm run build` (ou vide) |
| Deploy command | `npx wrangler deploy` |
| Root directory | *(vide / racine du repo)* |

Le Worker dans le dashboard doit s’appeler **dispensadirocco**.

API production (Discord + Google Sheets) : `POST /api/production` — voir **SETUP-WORKERS.md**.
