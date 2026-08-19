# V5.3 — Déploiement propre Cloudflare Workers

Cette version est volontairement conçue pour **déployer d'abord sans KV ni secret**.

Le fichier `wrangler.jsonc` est du JSON strict et ne contient aucun placeholder.
Il doit commencer par :

```json
{
```

et PAS par `#`, `:root`, ou du CSS.

## Étape 1 — Déployer

Commande :

```bash
npx wrangler deploy
```

Le site doit pouvoir se déployer même si KV et Discord ne sont pas encore configurés.

## Étape 2 — Ajouter le KV dans Cloudflare

Dans le Dashboard :

Workers & Pages → ton Worker → Settings → Bindings → Add → KV Namespace

Variable name :

```text
SITE_STATE
```

Sélectionne ton namespace KV puis déploie.

## Étape 3 — Ajouter le secret Discord

Dans :

Workers & Pages → ton Worker → Settings → Variables and Secrets

Ajoute un **Secret** :

```text
DISCORD_PUBLIC_KEY
```

Valeur : la Public Key de ton application Discord.

Le secret n'est jamais stocké dans GitHub.

## IDs Discord déjà dans wrangler.jsonc

```text
DISCORD_GUILD_ID   = 1529971523924791478
DISCORD_CHANNEL_ID = 1537538848660390018
DISCORD_MESSAGE_ID = 1537545350313938954
```

## Boutons Discord attendus

```text
OUVERTURE  -> restaurant_open
FERMETURE  -> restaurant_closed
```

## Endpoint Discord

```text
https://TON-WORKER.workers.dev/discord/interactions
```

## Si Cloudflare affiche encore `:root {` dans wrangler.jsonc

Alors Cloudflare ne clone PAS le bon contenu GitHub.

Sur GitHub, ouvre `wrangler.jsonc` et vérifie visuellement que la première ligne est `{`.
Vérifie ensuite dans Cloudflare la branche de production reliée au Worker.
