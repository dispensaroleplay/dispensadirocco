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

## Accès ADMIN (option B — ta propre app Discord)

Deux applications Discord coexistent :

| App | Rôle | Secrets Cloudflare |
|-----|------|-------------------|
| **JadaOne** (existante) | Boutons OUVERT / FERMÉ | `DISCORD_PUBLIC_KEY` |
| **Ta app admin** (nouvelle) | OAuth + `/admin-add`, etc. | `ADMIN_DISCORD_PUBLIC_KEY`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` |

Le Worker accepte les interactions signées par **l'une ou l'autre** Public Key.

### B1 — Créer ton application

1. [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**
2. Nom au choix (ex. `La Dispensa Admin`)
3. Tu es propriétaire — accès complet

### B2 — OAuth (ta app)

**OAuth2 → Redirects** :

```text
https://<ton-domaine>/admin/callback
```

Copie **Client ID** et **Client Secret** → secrets Cloudflare.

### B3 — Interactions (ta app)

**General Information → Interactions Endpoint URL** :

```text
https://<ton-domaine>/discord/interactions
```

Copie la **Public Key** de **ta app** → secret `ADMIN_DISCORD_PUBLIC_KEY`.

> JadaOne garde sa propre Public Key dans `DISCORD_PUBLIC_KEY` (boutons statut).

### B4 — Inviter le bot sur ton serveur RP

**OAuth2 → URL Generator** :

- Scopes : `bot` + `applications.commands`
- Ouvre le lien → choisis ton serveur RP → Autoriser

### B5 — Slash commands (ta app)

| Commande | Option |
|----------|--------|
| `/admin-add` | `user` (User) |
| `/admin-remove` | `user` (User) |
| `/admin-list` | aucune |

### Secrets Cloudflare (récap)

| Secret | Source |
|--------|--------|
| `DISCORD_PUBLIC_KEY` | JadaOne → General Information |
| `ADMIN_DISCORD_PUBLIC_KEY` | Ta app → General Information |
| `DISCORD_CLIENT_ID` | Ta app → OAuth2 |
| `DISCORD_CLIENT_SECRET` | Ta app → OAuth2 |
| `ADMIN_SESSION_SECRET` | Chaîne aléatoire (génère-la toi-même) |

### Variables

- `ADMIN_DISCORD_IDS` : `606028135904968714` (ton ID bootstrap)
- `ADMIN_REDIRECT_URL` : `https://stocks-ladispensadirocco.pages.dev`

### Gestion permanente

Dans Discord, en tant qu'admin bootstrap :

- `/admin-add @personne` — autorise l'accès ADMIN
- `/admin-remove @personne` — retire l'accès
- `/admin-list` — liste les admins

Liste stockée dans KV `SITE_STATE` → clé `admin_allowlist`.

### Flux utilisateur

1. Admin autorisé : `/admin/login` ou clic ADMIN → connexion Discord
2. Lien ADMIN visible + redirection vers stocks
3. Déconnexion : `/admin/logout`

> L'URL directe de l'app stocks reste accessible sans protection supplémentaire (Cloudflare Access optionnel).
ii