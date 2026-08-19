# La Dispensa Di Rocco — V4

Cette version remplace complètement l'ancienne V3. Le CSS et le JavaScript ont été réécrits proprement afin de supprimer les anciennes règles inutilisées.

## Fichiers

```text
index.html
admin.html
styles.css
script.js
assets/
  logo.webp
  carte.webp
  restaurant.webp
  plat.webp
```

## Changements

- thème noir / or premium
- vert / blanc / rouge conservés uniquement en accent
- bouton Commander de l'accueil vers Discord
- suppression du protocole `discord://`
- carte agrandissable en plein écran
- galerie optimisée
- bloc Informations RP avec statut OUVERT / FERMÉ
- navigation active selon la section visible
- favicon
- métadonnées de partage Discord / Open Graph
- chargement différé des images lourdes
- bouton ADMIN vers une page protégée par mot de passe
- images converties en WebP pour réduire le poids

## Changer OUVERT / FERMÉ

Dans `script.js`, première ligne utile :

```js
const BUSINESS_OPEN = true;
```

Passe à `false` pour afficher FERMÉ.

## Accès ADMIN

Le bouton `ADMIN` ouvre `admin.html`.

Si le mot de passe est correct, l'utilisateur est redirigé vers :

https://stocks-ladispensadirocco.pages.dev

## Important concernant la sécurité

La vérification du mot de passe est faite dans le navigateur, car le site est statique.
Le mot de passe n'est pas écrit en clair dans `admin.html` : seul son hash SHA-256 est stocké.

Mais ce système n'est pas une vraie protection serveur. Une personne expérimentée peut contourner une protection côté navigateur, et l'URL de stocks reste directement accessible si quelqu'un la connaît.

Pour une vraie restriction d'accès, il faudra protéger également le site de stocks côté Cloudflare (authentification serveur / Cloudflare Access / équivalent).
