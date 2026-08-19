# Cloudflare Workers

Les fichiers publics du site sont dans `public/` :

```text
public/index.html
public/404.html
public/styles.css
public/script.js
public/assets/
worker.js
wrangler.jsonc
package.json
```

Le `wrangler.jsonc` utilise :

```json
"assets": {
  "directory": "./public",
  "binding": "ASSETS",
  "not_found_handling": "404-page",
  "html_handling": "none",
  "run_worker_first": true
}
```

Ne pas mettre `assets.directory` sur `"."` : Cloudflare essaierait d’uploader `.git` et `node_modules`, ce qui fait échouer le déploiement (limite 25 Mo).

## Déploiement

```bash
npm install
npx wrangler deploy
```

Sur Cloudflare (Workers Builds), commande de deploy : `npx wrangler deploy`.

Le Worker dans le dashboard doit s’appeler **dispensadirocco** (même `name` que dans `wrangler.jsonc`).

L’URL `/` est gérée par `worker.js`, qui sert explicitement `/index.html`.
