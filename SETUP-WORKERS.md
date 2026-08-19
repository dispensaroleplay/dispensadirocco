# V5.5 — Cloudflare Workers sans dossier public

Cette version supprime complètement le besoin d'un dossier `public/`.

Les fichiers du site sont directement à la racine du dépôt :

```text
index.html
404.html
styles.css
script.js
assets/
worker.js
wrangler.jsonc
.assetsignore
```

Le `wrangler.jsonc` utilise maintenant :

```json
"assets": {
  "directory": ".",
  "binding": "ASSETS",
  "not_found_handling": "404-page",
  "html_handling": "none",
  "run_worker_first": true
}
```

`.assetsignore` empêche `worker.js`, `wrangler.jsonc`, les README et les fichiers
de configuration d'être exposés comme assets publics.

## Déploiement

Commande :

```bash
npx wrangler deploy
```

## Important

Sur GitHub, tu n'as plus besoin d'un dossier `public`.

Vérifie simplement que `index.html` est bien à la racine, au même niveau que
`worker.js` et `wrangler.jsonc`.

L'URL `/` est gérée par `worker.js`, qui sert explicitement `/index.html`.
