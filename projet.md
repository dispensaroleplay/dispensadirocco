# PROJET — La Dispensa Di Rocco

> **Document vivant.** À lire avant toute évolution, et **à mettre à jour** dès qu’une fonctionnalité est ajoutée, modifiée ou abandonnée.

| | |
|---|---|
| **Dernière mise à jour** | 2026-08-21 (/stats enrichi) |
| **Repo** | `dispensadirocco` (Worker Cloudflare) |
| **URL prod** | `https://dispensadirocco.ladispensadirocco.workers.dev` |
| **Worker** | `dispensadirocco` |

---

## 1. Contexte

**La Dispensa Di Rocco** est une enseigne RP de street food italienne (Food Truck Casino).

Ce dépôt centralise :

1. Le **site vitrine** (présentation, carte, recrutement, contact)
2. Le **statut OUVERT / FERMÉ** piloté depuis Discord
3. L’**accès admin** (OAuth Discord) vers le formulaire de déclaration de production
4. Le **pipeline production** : Discord → validation humaine → Google Sheets (quotas / salaires)

Objectif métier : automatiser le suivi des **menus / stock produit** déclarés par l’équipe, avec preuve Discord et validation staff, sans ressaisie manuelle dans Sheets.

---

## 2. Architecture

```text
┌─────────────────────┐     ┌──────────────────────────────┐
│  Site vitrine       │     │  Discord (guild RP)          │
│  site/*             │◄────┤  Boutons OUVERT/FERMÉ        │
│                     │     │  Slash /recap /stats /admin-*│
└─────────┬───────────┘     │  Salon production + alertes  │
          │                 └──────────────┬───────────────┘
          ▼                                │
┌─────────────────────┐                    │
│  Cloudflare Worker  │◄───────────────────┘
│  worker.js          │
│  + KV SITE_STATE    │
└─────────┬───────────┘
          │
          ├─► Google Sheets (onglet Production + Stock)
          ├─► Bot Discord interactions (messages + boutons)
          └─► Webhooks (récap / alertes)
```

| Couche | Rôle |
|--------|------|
| `site/` | Assets publics (HTML/CSS/JS/images) |
| `worker.js` | Routage, auth, Discord interactions, Sheets, cron |
| `wrangler.jsonc` | Config Worker, KV, vars, crons |
| `scripts/` | Enregistrement des commandes slash Discord |
| `SETUP-WORKERS.md` | Guide opérationnel secrets / Discord / Sheets |
| **`projet.md`** | Contexte, fonctionnalités, roadmap (ce fichier) |

---

## 3. Fonctionnalités en place

### 3.1 Site vitrine

- Page d’accueil brandée (Cormorant Garamond / Montserrat self-hostées, thème sombre or)
- PWA légère (manifest + icônes + service worker shell)
- Perf mobile : images compressées, intro désactivée, animations réduites, cache assets
- Sections histoire, carte, galerie, recrutement, contact
- Crédit footer : Dev by Sundae²
- Lien Discord « Commander »
- Bouton **ADMIN** visible uniquement si session admin Discord

### 3.2 Statut restaurant

- Boutons Discord **OUVERT** / **FERMÉ** sur un message fixe
- Stockage dans KV `SITE_STATE`
- API publique `GET /api/status`
- Restriction par rôle `DISCORD_BOT_ROLE_IDS` (sinon allowlist admin)

### 3.3 Accès admin

- OAuth Discord (`/admin/login` → `/admin/callback`)
- Session cookie signée (`ADMIN_SESSION_SECRET`)
- Allowlist : `ADMIN_DISCORD_IDS` (bootstrap) + KV `admin_allowlist`
- Slash : `/admin-add`, `/admin-remove`, `/admin-list`

### 3.4 Déclarations de production

**Entrée :** formulaire dédié `/admin/app` (`site/admin-production.html`)

Champs :

- Nom prénom (liste déroulante employés)
- Stock produit
- Une ou plusieurs images (max 10 × 8 Mo) — mobile : Galerie / Appareil photo, barre d’envoi sticky, safe-area
- Crédit bas de page : Sundae² et l.ktv

**Flux :**

1. `POST /api/submit` (session admin requise)
2. Message Discord dans `#production-whebooks` via **Bot** (+ mention rôle staff optionnelle)
3. Boutons **Valider** (vert) / **Refuser** (rouge)
4. **Rien dans Sheets** tant que non validé
5. **Valider** → append Google Sheets  
   - Onglet **Production** : Date · Employé · Menus · Validé=`Oui` · Responsable=`BOT` · Preuve · Commentaire=`Validé par {pseudo}`  
   - Onglet **Stock** (`Stock!A11:F`) : Date · `Vente particuliers` · `Vente grossiste` · Quantité=`−menus` · `BOT` · `automatique`
6. **Refuser** → pas d’écriture Sheets

Aussi disponible : `POST /api/production` (token `PRODUCTION_API_TOKEN`) pour une source JSON externe.

Anti-doublon : même nom + stock &lt; 1 h.

### 3.5 Discord — commandes & salons

| Commande | Comportement |
|----------|----------------|
| `/recap` | Récap semaine (en cours / précédente), filtre `employe` optionnel — réponse **publique dans le salon** où la commande est lancée |
| `/stats` | Stats jour / semaine : **top employés**, comparaison période précédente, plus forte hausse — réponse publique dans le salon |
| `/admin-*` | Gestion allowlist admin — réponse publique dans le salon |

| Salon / webhook | Usage |
|-----------------|--------|
| Production | Déclarations + boutons |
| Alertes (`DISCORD_ALERT_WEBHOOK_URL`) | Erreurs + rappels pending |
| Récap (`DISCORD_RECAP_WEBHOOK_URL`) | Récap **cron** du lundi |

### 3.6 Automatisations (cron)

| Cron | Action |
|------|--------|
| `0 6 * * 1` (lundi 06:00 UTC) | Récap semaine précédente → webhook récap |
| `0 * * * *` (chaque heure) | Rappel si déclaration pending &gt; `PRODUCTION_PENDING_REMINDER_HOURS` (défaut 6 h), 1 fois |

### 3.7 Google Sheets

- Compte de service (`GOOGLE_SERVICE_ACCOUNT_*`)
- Range production : `GOOGLE_SHEETS_RANGE` (ex. `Production!A:G`)
- Range ajustements stock : `GOOGLE_STOCK_ADJUST_RANGE` (défaut `Stock!A11:F`, même fichier)
- Lecture pour `/recap`, `/stats`, cron (onglet production)
- Écriture uniquement après **Valider** (production + ajustement si configuré)

---

## 4. Routes principales

| Méthode | Chemin | Rôle |
|---------|--------|------|
| GET | `/` | Site vitrine |
| GET | `/api/status` | Statut OUVERT/FERMÉ |
| GET | `/api/admin/access` | Session admin ? |
| GET | `/admin` | Gate → app ou login |
| GET | `/admin/login` | OAuth Discord |
| GET | `/admin/callback` | Callback OAuth |
| GET | `/admin/logout` | Déconnexion |
| GET | `/admin/app` | Formulaire production (HTML dédié) |
| POST | `/api/submit` | Soumission formulaire (multipart) |
| POST | `/api/production` | API token JSON |
| POST | `/api/production/recap` | Récap manuel API (`period`, `employe`) |
| POST | `/discord/interactions` | Interactions Discord |

---

## 5. Secrets / variables critiques

Voir le détail dans [`SETUP-WORKERS.md`](SETUP-WORKERS.md).

**Indispensables production :**

- `DISCORD_BOT_TOKEN` — messages + boutons
- `PRODUCTION_DISCORD_CHANNEL_ID` — salon production (ID numérique)
- `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `PRIVATE_KEY` / `SHEETS_SPREADSHEET_ID`
- `GOOGLE_SHEETS_RANGE` — ex. `Production!A:G`
- `GOOGLE_STOCK_ADJUST_RANGE` — défaut `Stock!A11:F` (même spreadsheet)
- `PRODUCTION_API_TOKEN`
- `ADMIN_SESSION_SECRET`, clés Discord OAuth / Public Keys

**Optionnels :**

- `PRODUCTION_STAFF_ROLE_ID` — ping à chaque déclaration
- `DISCORD_ALERT_WEBHOOK_URL` / `DISCORD_RECAP_WEBHOOK_URL`
- `PRODUCTION_PENDING_REMINDER_HOURS`

Après modification de `scripts/commands.guild.json` :

```powershell
cd "chemin\du\repo"
$env:DISCORD_BOT_TOKEN="..."
node scripts/register-discord-commands.mjs
```

---

## 6. Roadmap

### Fait

- [x] Site vitrine + statut Discord OUVERT/FERMÉ
- [x] Admin OAuth + allowlist
- [x] Formulaire production brandé Dispensa
- [x] Multi-images preuves
- [x] Validation Discord avant Sheets
- [x] Commentaire « Validé par … »
- [x] `/recap`, `/stats` (réponses dans le salon d’exécution)
- [x] Alertes erreurs Discord
- [x] Récap hebdo cron + rappel pending
- [x] Mention rôle staff (si configuré)
- [x] Peaufinage mobile du formulaire admin (`/admin/app`)
- [x] Fix menu hamburger (zone tactile + couches) et chargement site (intro / reveal)
- [x] Liste déroulante des employés sur le formulaire admin
- [x] `/stats` enrichi (top + comparaison période précédente)

### À faire / idées prioritaires

- [ ] **Commentaire libre** sur le formulaire (ex. foodtruck) fusionné avec « Validé par … »
- [ ] **`/pending`** — lister les déclarations en attente Oui/Non
- [ ] **Timeout auto** — après X jours : alerte forte ou refus / archivage
- [ ] **`/export`** — CSV de la période en pièce jointe Discord
- [ ] Domaine custom final + migration complète Discord endpoints (si pas déjà fait)

### Plus tard / nice-to-have

- [ ] Dashboard web live (totaux sans ouvrir Sheets)
- [ ] Historique KV des validations
- [ ] Tests automatisés Worker (validation parsing, mapping Sheets)

### Abandonné / hors scope

- Badge **OUVERT / FERMÉ** visible sur le site vitrine (le pilotage Discord / API reste ; pas d’affichage public demandé)
- Logs de suppression de messages (Gateway ou audit logs Cloudflare)

---

## 7. Règles de maintenance de ce fichier

1. **Avant** une grosse feature : relire §3, §6 et `SETUP-WORKERS.md`
2. **Après** merge / déploiement d’une feature :
   - cocher / ajouter dans §3 et §6
   - mettre à jour la date en en-tête
   - noter les nouveaux secrets / commandes Discord
3. Ne pas dupliquer tout le guide ops ici : les détails de config restent dans `SETUP-WORKERS.md`
4. Si une décision produit change (ex. validation auto vs manuelle), l’écrire explicitement dans §1 ou §3

---

## 8. Liens utiles

- Worker : `https://dispensadirocco.ladispensadirocco.workers.dev`
- Formulaire admin : `/admin/app`
- Setup ops : [`SETUP-WORKERS.md`](SETUP-WORKERS.md)
- README court : [`README.md`](README.md)
