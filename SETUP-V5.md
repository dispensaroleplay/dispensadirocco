# Configuration V5 — uniquement les fonctions demandées

## 1. Statut OUVERT / FERMÉ connecté à Discord

Le site lit maintenant le statut depuis `/api/status` et l'actualise toutes les 15 secondes.

Le backend Discord est prêt dans :

```text
functions/discord/interactions.js
```

Il accepte deux boutons Discord :

```text
restaurant_open
restaurant_closed
```

et il est limité au message Discord :

```text
1537545350313938954
```

### Cloudflare

Dans Cloudflare Pages :

1. Crée un namespace **Workers KV**.
2. Dans ton projet Pages : **Settings → Bindings → Add → KV namespace**.
3. Variable name : `SITE_STATE`.
4. Sélectionne le namespace créé.
5. Ajoute une variable/secrète Pages :
   - `DISCORD_PUBLIC_KEY` = clé publique de ton application Discord.
6. Redéploie le site.

### Discord

Dans le Developer Portal de ton application Discord, mets comme **Interactions Endpoint URL** :

```text
https://TON-SITE.pages.dev/discord/interactions
```

Les boutons qui mettent le site à jour doivent être des boutons interactifs envoyés par **cette application Discord** et avoir les `custom_id` exacts :

- OUVERTURE → `restaurant_open`
- FERMETURE → `restaurant_closed`

Important : un simple lien vers un message Discord ne peut pas, à lui seul, prévenir ton site lorsqu'un membre clique sur un bouton. L'interaction doit passer par une application/bot Discord.

Le badge du site renvoie déjà vers ton message :

https://discord.com/channels/1529971523924791478/1537538848660390018/1537545350313938954

## 2. ADMIN réellement protégé

Le bouton ADMIN pointe vers :

https://stocks-ladispensadirocco.pages.dev

Pour que l'accès soit réellement protégé, active **Cloudflare Access** directement sur le projet `stocks-ladispensadirocco`.

Dans le projet de stocks :
1. Workers & Pages → projet stocks → Settings.
2. Active une **Access policy** pour le domaine `stocks-ladispensadirocco.pages.dev`.
3. Dans Zero Trust → Access → Applications, choisis qui peut entrer (emails/comptes autorisés).

Cette protection se fait avant que le site de stocks ne soit servi : connaître l'URL ne suffit plus.

L'ancienne page `admin.html` avec mot de passe côté navigateur a été supprimée.
