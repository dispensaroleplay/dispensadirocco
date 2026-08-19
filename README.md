# La Dispensa Di Rocco — V5.3 Workers Clean

Version de dépannage propre :

- `wrangler.jsonc` = JSON strict valide
- aucun placeholder KV dans le fichier
- aucun secret requis au moment du premier déploiement
- `worker.js` ne plante pas si KV/secret ne sont pas encore configurés
- KV et secret se configurent ensuite depuis le Dashboard Cloudflare

Voir `SETUP-WORKERS.md`.
