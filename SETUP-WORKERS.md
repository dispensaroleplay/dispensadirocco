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
