# La Dispensa Di Rocco — Workers

Site vitrine + API Discord / production, déployé en Cloudflare Workers.

**Document principal du projet (contexte, fonctionnalités, roadmap) :** [`projet.md`](projet.md)  
À lire et **mettre à jour** à chaque avancée.

Structure :

```text
site/                 # assets publics (vitrine + formulaire admin)
worker.js             # logique Worker
wrangler.jsonc
scripts/              # enregistrement commandes Discord
SETUP-WORKERS.md      # secrets & procédures
projet.md             # contexte / features / roadmap
```

Le binding KV `SITE_STATE` et les secrets se configurent dans le dashboard Cloudflare (`keep_vars: true`).

## Cloudflare Workers Builds

| Paramètre | Valeur |
|-----------|--------|
| Build command | `npm run build` (ou vide) |
| Deploy command | `npx wrangler deploy` |
| Root directory | *(vide / racine du repo)* |

Le Worker dans le dashboard doit s’appeler **dispensadirocco**.

API production : `POST /api/production` — détails dans **SETUP-WORKERS.md** et **projet.md**.
