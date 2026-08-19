# La Dispensa Di Rocco — Workers

Site vitrine + API de statut Discord, déployé en Cloudflare Workers.

- Fichiers publics : `public/`
- Worker : `worker.js`
- Config : `wrangler.jsonc`

Le binding KV `SITE_STATE` et le secret `DISCORD_PUBLIC_KEY` se configurent dans le dashboard Cloudflare (conservés grâce à `keep_vars`).
