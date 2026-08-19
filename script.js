# La Dispensa Di Rocco — V5.1

V5.1 centralise toute la partie serveur dans un seul fichier Cloudflare Pages :

```text
_worker.js
```

Le Worker :
- sert le site statique,
- fournit `/api/status`,
- reçoit `/discord/interactions`,
- vérifie la signature Discord,
- vérifie les IDs du serveur / salon / message,
- lit et écrit le statut dans Workers KV.

La configuration Cloudflare est centralisée dans :

```text
wrangler.jsonc
```

Les secrets ne sont jamais écrits dans le dépôt.

Voir `SETUP-V5.md` pour la configuration exacte.
