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

## Bindings requis

| Nom | Type | Rôle |
|-----|------|------|
| `SITE_STATE` | KV Namespace | Statut OUVERT / FERMÉ + liste admin |
| `DISCORD_PUBLIC_KEY` | Secret | Vérification des interactions Discord |
| `ASSETS` | Assets | Configuré automatiquement via `wrangler.jsonc` |

Variables déjà dans `wrangler.jsonc` : `DISCORD_GUILD_ID`, `DISCORD_CHANNEL_ID`, `DISCORD_MESSAGE_ID`.

### Persistance du KV (important)

`keep_vars: true` ne conserve que les **variables texte** du dashboard. Les **bindings KV ne sont pas conservés** s’ils ne sont pas aussi déclarés dans `wrangler.jsonc`.

Sans ça, un déploiement GitHub / `wrangler deploy` peut **retirer** `SITE_STATE` — c’est ce qui s’est produit avant.

**Étape 1 — Récupérer l’ID du namespace**

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers KV**
2. Ouvre le namespace **`dispensa-status`**
3. Copie l’**Namespace ID** (32 caractères hexadécimaux)

**Étape 2 — L’ajouter dans `wrangler.jsonc`**

```jsonc
"kv_namespaces": [
  {
    "binding": "SITE_STATE",
    "id": "COLLE_TON_NAMESPACE_ID_ICI"
  }
],
```

**Étape 3 — Commit + push** (ou `npx wrangler deploy`)

Après ça, chaque déploiement réappliquera automatiquement le binding KV.

**Vérification rapide** : ouvre `https://<ton-domaine>/api/status`

- `{"status":"unknown",...}` ou `"open"` / `"closed"` → KV **OK**
- `{"setupRequired":"SITE_STATE KV binding",...}` → KV **manquant**

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
- `DISCORD_BOT_ROLE_IDS` : ID(s) du rôle Discord autorisé à utiliser les commandes et boutons (séparés par des virgules)

### Restreindre les commandes bot par rôle Discord

Par défaut (sans `DISCORD_BOT_ROLE_IDS`), seuls les admins du site (allowlist) peuvent utiliser `/admin-add`, `/admin-remove`, `/admin-list` et les boutons OUVERT / FERMÉ.

Une fois `DISCORD_BOT_ROLE_IDS` configuré, **seuls les membres avec ce rôle** (ou l'un des rôles listés) peuvent :

- utiliser les commandes slash admin
- appuyer sur les boutons **OUVERT** / **FERMÉ**

**Récupérer l'ID du rôle :**

1. Discord → Paramètres → Avancés → **Mode développeur** (activé)
2. Serveur RP → **Paramètres du serveur** → **Rôles** → clic droit sur le rôle → **Copier l'identifiant du rôle**
3. Cloudflare → worker **dispensadirocco** → **Variables** → ajoute `DISCORD_BOT_ROLE_IDS` avec cet ID

Exemple : `DISCORD_BOT_ROLE_IDS` = `1234567890123456789`

Plusieurs rôles : `1234567890123456789,9876543210987654321`

### Gestion permanente

Dans Discord, en tant qu'admin bootstrap :

- `/admin-add @personne` — autorise l'accès ADMIN
- `/admin-remove @personne` — retire l'accès
- `/admin-list` — liste les admins

Liste stockée dans KV `SITE_STATE` → clé `admin_allowlist`.

### Flux utilisateur

1. Admin autorisé : `/admin/login` → bouton ADMIN visible
2. Clic ADMIN → `/admin/app` (formulaire stocks, session requise)
3. Déconnexion : `/admin/logout`

### App stocks sécurisée

L’app stocks n’est plus servie directement depuis le lien ADMIN. Flux :

1. Connexion Discord (`/admin/login`)
2. Clic **ADMIN** → `/admin/app` (proxy authentifié)
3. Envoi du formulaire → `POST /api/submit` (session admin requise)

Variables :

- `ADMIN_STOCKS_ORIGIN` : origine Pages (`https://stocks-ladispensadirocco.pages.dev`)
- `ADMIN_REDIRECT_URL` : conservé pour compatibilité (même URL)

#### Bloquer l’URL Pages directe (recommandé)

Sans ça, `stocks-ladispensadirocco.pages.dev` reste accessible en direct.

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Zero Trust** → **Access** → **Service auth** → **Create Service Token**
2. **Access** → **Applications** → **Add** → Self-hosted → hostname `stocks-ladispensadirocco.pages.dev`
3. Policy : **Service Auth** → token créé à l’étape 1 → **Action : Allow**
4. Ajoute une 2ᵉ policy : **Everyone** → **Action : Block** (ou ne mets que Service Auth)
5. Secrets Cloudflare sur le worker **dispensadirocco** :
   - `STOCKS_ACCESS_CLIENT_ID`
   - `STOCKS_ACCESS_CLIENT_SECRET`

Le worker envoie ces headers au proxy ; les visiteurs sans token ne passent plus.

## Domaine personnalisé

Le site fonctionne aujourd’hui sur `https://dispensadirocco.<compte>.workers.dev`. Pour un domaine RP (ex. `ladispensadirocco.fr` ou `www.ladispensadirocco.fr`), le domaine doit être **géré par Cloudflare** (zone active sur ton compte).

### Prérequis

- Un nom de domaine acheté (OVH, Gandi, Cloudflare Registrar, etc.)
- Le domaine **ajouté à Cloudflare** (DNS géré par Cloudflare — nameservers Cloudflare)

### Étape 1 — Choisir l’URL

| Option | Exemple | Usage |
|--------|---------|--------|
| Racine | `ladispensadirocco.fr` | URL courte, pro |
| Sous-domaine | `www.ladispensadirocco.fr` | Si la racine sert à autre chose |

Tu peux activer **les deux** (racine + `www`).

### Étape 2 — Déclarer le domaine dans `wrangler.jsonc`

Remplace `TON-DOMAINE.fr` par ton vrai domaine :

```jsonc
"routes": [
  {
    "pattern": "TON-DOMAINE.fr",
    "custom_domain": true
  },
  {
    "pattern": "www.TON-DOMAINE.fr",
    "custom_domain": true
  }
],
```

Puis **commit + push** (ou `npx wrangler deploy`). Cloudflare crée automatiquement les enregistrements DNS et le certificat HTTPS.

> Garde l’URL `workers.dev` active pendant la transition (ne mets pas `"workers_dev": false` tant que Discord n’est pas migré).

### Étape 3 — Mettre à jour Discord (obligatoire)

Dans **Admindispensa** → **OAuth2 → Redirects**, ajoute (sans supprimer l’ancienne URL tout de suite) :

```text
https://TON-DOMAINE.fr/admin/callback
```

Dans **Admindispensa** et **JadaOne** → **General Information → Interactions Endpoint URL** :

```text
https://TON-DOMAINE.fr/discord/interactions
```

*(Une seule URL par app — remplace l’URL `workers.dev` une fois le nouveau domaine validé.)*

### Étape 4 — Vérifications

1. `https://TON-DOMAINE.fr/` — page d’accueil
2. `https://TON-DOMAINE.fr/api/status` — KV OK
3. `https://TON-DOMAINE.fr/admin/login` — OAuth Discord
4. Bouton OUVERT/FERMÉ sur Discord → statut mis à jour
5. `/admin-list` fonctionne toujours

### Étape 5 — Optionnel (app stocks)

Tu peux aussi mettre un domaine custom sur l’app stocks (Pages) :

- ex. `stocks.ladispensadirocco.fr` → Cloudflare Pages → Custom domains
- puis mettre à jour `ADMIN_REDIRECT_URL` dans `wrangler.jsonc`

### Dépannage

| Problème | Solution |
|----------|----------|
| « Domain not found » au deploy | Le domaine n’est pas une zone Cloudflare sur ton compte |
| OAuth Discord échoue | Redirect `/admin/callback` manquant pour le **nouveau** domaine |
| Discord interactions invalides | Endpoint URL pas mis à jour sur la bonne app |
| Certificat SSL en attente | Attendre 5–15 min après le premier deploy |

## Déclarations production → Google Sheets

Endpoint : `POST /api/production`

Flux : source → Worker → webhook Discord (`#production-whebooks`) → append Google Sheets.

### Mapping

| Colonne Sheets | Valeur |
|----------------|--------|
| Date | date du jour `DD/MM/YYYY` (Europe/Paris) |
| Employé | `nom` |
| Menus créés | `stock` |
| Validé | `Oui` |
| Responsable | `BOT` |
| Preuve / lien Discord | lien du message posté |
| Commentaire | vide |

### 1 — Compte de service Google

1. [Google Cloud Console](https://console.cloud.google.com/) → crée un projet (ou réutilise)
2. **APIs & Services** → active **Google Sheets API**
3. **IAM & Admin** → **Service Accounts** → **Create**
4. Crée une clé JSON → télécharge le fichier
5. Dans le JSON, note :
   - `client_email` → secret `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` → secret `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` (garde les `\n` ou colle le PEM avec vrais retours à la ligne)

### 2 — Partager le Google Sheet

1. Ouvre le fichier Sheets des quotas
2. **Partager** avec l’email du compte de service → rôle **Éditeur**
3. L’ID du spreadsheet est dans l’URL :
   `https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit`
4. Note le nom exact de l’onglet (ex. `Feuille1`) pour le range `Feuille1!A:G`

### 3 — Webhook Discord

1. Salon `#production-whebooks` → **Paramètres** → **Intégrations** → **Webhooks** → **Nouveau**
2. Nom affiché : `Production`
3. Copie l’URL → secret `DISCORD_PRODUCTION_WEBHOOK_URL`
4. Copie l’ID du salon → var `PRODUCTION_DISCORD_CHANNEL_ID`

### 4 — Secrets / vars Cloudflare (worker `dispensadirocco`)

| Nom | Type | Rôle |
|-----|------|------|
| `PRODUCTION_API_TOKEN` | Secret | Auth de `POST /api/production` |
| `DISCORD_PRODUCTION_WEBHOOK_URL` | Secret | Webhook Discord production |
| `PRODUCTION_DISCORD_CHANNEL_ID` | Var | ID salon `#production-whebooks` |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Secret | Email du compte de service |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | Secret | Clé privée PEM |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | Secret / var | ID du fichier Sheets |
| `GOOGLE_SHEETS_RANGE` | Var | Range append (défaut `Feuille1!A:G`) |

`DISCORD_GUILD_ID` est déjà dans `wrangler.jsonc`.

### 5 — Appeler l’API depuis ta source

```bash
curl -X POST "https://<ton-domaine>/api/production" \
  -H "Authorization: Bearer TON_PRODUCTION_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"nom\":\"Julien Phantom\",\"stock\":1150}"
```

Headers acceptés : `Authorization: Bearer …` **ou** `X-Api-Token: …`

Body accepté :
```json
{ "nom": "Julien Phantom", "stock": 1150 }
```

Réponse succès :
```json
{
  "ok": true,
  "message": "✅ Production enregistrée dans Google Sheets — 1150 × Julien Phantom",
  "discordUrl": "https://discord.com/channels/.../.../...",
  "sheetRow": ["20/08/2026", "Julien Phantom", "1150", "Oui", "BOT", "https://...", ""]
}
```

Anti-doublon : même `nom` + `stock` à moins d’**1 heure** d’écart → `duplicate: true`, pas de 2ᵉ ligne Sheets. Après 1 h, une nouvelle déclaration est acceptée.

Branchez la source existante (formulaire stocks / script) sur cet endpoint **à la place** d’un post Discord direct.

### Formulaire admin (`/admin/app`)

Le formulaire sur `https://dispensadirocco.ladispensadirocco.workers.dev/admin/app` envoie déjà un `POST /api/submit` (session admin requise) avec :

- `name` (texte)
- `stock` (nombre)
- `proof` (image)

Le Worker enregistre alors Discord + Google Sheets (plus besoin du webhook Discord côté app Pages).