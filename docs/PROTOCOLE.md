# Liberty Lake — protocole réseau

Version : `ll-net-1` (constante `PROTOCOLE` dans `server.js`, `NET_PROTO` dans
`liberty-lake.html`). Un client dont la version diffère est refusé dès la
poignée de main, avec un message explicite.

Transport : **WebSocket** sur `/ws`, messages **JSON** en UTF-8.
Cadence serveur : **20 Hz** (`TICK_HZ`). Taille maximale d'un message
client : 4 096 octets.

Chaque message porte un champ `t` qui donne son type. Tout message mal formé,
de type inconnu, ou arrivant dans un état où il n'a pas de sens est ignoré
en silence — jamais une exception.

---

## Client → serveur

| Type | Charge utile | Effet |
| --- | --- | --- |
| `PING` | `ts`, `rtt` | mesure de latence, maintient la connexion éveillée |
| `LIST` | `mode` (facultatif) | demande la liste des salles |
| `CREATE` | `pseudo`, `nom`, `mode`, `max`, `seed`, `motdepasse`, `feuAmi`, `equipes`, `filtre`, `trafic`, `policeDiff`, `tours`, `meteoFixe`, `heureDepart` | crée une salle et y entre |
| `JOIN` | `salle` (code à 4 caractères), `pseudo`, `motdepasse` | rejoint une salle |
| `LEAVE` | — | quitte la salle |
| `READY` | `v` (booléen) | se déclare prêt dans le salon |
| `GEOMETRIE` | `spawns[]`, `checkpoints[]`, `extraction` | **hôte seulement** : géométrie du monde (voir plus bas) |
| `START` | — | **hôte seulement** : lance le compte à rebours |
| `OPTIONS` | `options{}` | **hôte seulement** : modifie les réglages de la salle |
| `EXPEL` | `id` | **hôte seulement** : expulse un joueur |
| `INPUT` | `seq`, `x`, `y`, `a`, `m`, `hp`, `w`, `nage`, `dedans`, `veh` | position et état, 20 fois par seconde |
| `SHOOT` | `angle`, `arme` | un tir est parti (lueur et bruit chez les autres) |
| `TOUCHE` | `cible`, `arme`, `degats` | revendication d'impact sur un joueur |
| `INTERACT` | `type`, `cible`, `kind`, `x`, `y`, `montant` | `monter`, `descendre`, `etoiles`, `argent` |
| `CHAT` | `texte`, `canal` (`tous`/`equipe`/`prive`), `vers` | message |
| `MORT` | `cause` | mort causée par l'environnement ou la police locale |
| `PROFIL` | `pseudo`, `donnees` | sauvegarde facultative vers la base |

## Serveur → client

| Type | Charge utile | Rôle |
| --- | --- | --- |
| `BIENVENUE` | `id`, `protocole`, `tick`, `modes[]`, `salles[]` | poignée de main |
| `PONG` | `ts`, `serveur` | réponse à `PING` |
| `ROOMS` | `salles[]` | liste des salles |
| `SALLE` | état complet du salon d'attente | à chaque changement |
| `WORLD_INIT` | `seed`, `mode`, `options`, `equipe`, `heure`, `meteo`, `geo`, `joueurs[]`, `depart` | début de partie |
| `TICK` | `n`, `heure`, `reste`, `moi`, `joueurs[]`, `scores[]`, `evenements[]` | 20 fois par seconde |
| `EVENT` | `type`, `d{}` | voir la table des événements |
| `CHAT` | `pseudo`, `texte`, `couleur`, `canal` | message diffusé |
| `CORRECTION` | `x`, `y`, `raison` | position refusée : voici la bonne |
| `FIN` | `raison`, `classement[]` | fin de manche |
| `KICK` | `raison` | exclusion |

### Types d'`EVENT`

`refus` · `decompte` · `tousprets` · `meteo` · `evenement` · `degats` ·
`mort` · `respawn` · `retour` · `tir` · `monte` · `descend` · `checkpoint` ·
`tour` · `arrestation` · `extraction`

---

## Format d'un `TICK`

Les clés sont volontairement courtes : à 20 Hz et 16 joueurs, chaque octet
compte.

```json
{
  "t": "TICK", "n": 1420, "heure": 0.4312, "reste": 540,
  "moi":     { "i": "j3-ab12", "x": 2604, "y": 3187, "a": 1.57, "m": 0.9,
               "h": 100, "e": 0, "s": 250, "v": null, "w": "pistol",
               "d": 0, "g": 0, "b": 0 },
  "joueurs": [ { "i": "j7-cd34", "x": 2688, "y": 3140 },
               { "i": "j9-ef56", "x": 5100, "y": 1200, "a": 2.1,
                 "d": 0, "v": "sport", "e": 3, "loin": 1 } ],
  "scores":  [ { "i": "j3-ab12", "s": 250, "k": 1, "m": 0,
                 "tr": 0, "cp": 2, "f": 0, "ar": 0, "ex": 0 } ]
}
```

| Clé | Sens | | Clé | Sens |
| --- | --- | --- | --- | --- |
| `i` | identifiant | | `w` | arme |
| `x`, `y` | position (pixels entiers) | | `d` | mort (0/1) |
| `a` | direction du regard | | `g` | nage (0/1) |
| `m` | direction de visée | | `b` | à l'intérieur d'un bâtiment (0/1) |
| `h` | points de vie | | `s` | score |
| `e` | étoiles de recherche | | `loin` | état allégé, joueur éloigné |
| `v` | nature du véhicule, `null` à pied | | | |

**Économie de bande passante**, en trois mécanismes :

1. **Delta.** Un joueur n'apparaît qu'avec les champs qui ont changé depuis
   l'image précédente. Un joueur immobile ne coûte que son `i`.
   *Un champ absent signifie « inchangé », jamais « remis à zéro ».*
2. **Image complète périodique.** Un tick sur quatre contient l'état entier
   de chacun, plus `scores` et `evenements` : aucun décalage ne peut
   s'installer plus de 200 ms.
3. **Zone d'intérêt.** Au-delà de 2 200 pixels, un joueur n'est rafraîchi
   qu'un tick sur quatre, et dans une version réduite marquée `loin: 1`.

`moi` échappe à tout cela : notre propre position est toujours complète,
puisque c'est la référence de la réconciliation.

---

## Qui calcule quoi

### Le joueur local bouge tout de suite

Le client simule son propre personnage sans attendre le réseau — c'est la
prédiction. Il annonce ensuite sa position, que le serveur accepte ou refuse.

### Le serveur vérifie, il ne devine pas

À chaque `INPUT`, la distance parcourue depuis l'entrée précédente est
comparée à ce que permet le moyen de locomotion déclaré :

| À pied | Voiture | Bateau | Avion |
| --- | --- | --- | --- |
| 300 px/s | 430 px/s | 400 px/s | 640 px/s |

avec une marge de 45 % plus 70 pixels — collisions, rampes et latence
produisent de vrais déplacements un peu supérieurs. Au-delà, l'entrée est
rejetée, journalisée, et une `CORRECTION` est renvoyée. Trente rejets valent
une exclusion.

Une **fenêtre de grâce de 2 secondes** s'ouvre chaque fois que le serveur
déplace lui-même un joueur (départ, réapparition) : sans elle, il
sanctionnerait sa propre téléportation, le temps que l'ordre parvienne au
client.

### La réconciliation ne tire jamais le joueur en arrière sans raison

Le serveur mémorise la position que le client lui a annoncée : tant qu'il
l'accepte, l'écart entre les deux n'est que celui de la latence. Le seuil de
correction en tient compte — `90 px + vitesse × latence` — et une
`CORRECTION` explicite, elle, s'applique immédiatement. Au-delà de 600 px,
l'alignement est sec : c'est une réapparition, pas une dérive.

### Les impacts sont revendiqués, puis vérifiés

Le tireur fait la détection chez lui : lui seul connaît les murs qui
arrêtent la balle. Le serveur revérifie :

- l'arme existe et ses dégâts annoncés ne dépassent pas les siens ;
- la cible était à portée **à un instant des 700 dernières millisecondes**
  (compensation de latence : on compare à l'historique des positions, pas
  seulement à la position actuelle) ;
- le feu ami est autorisé si la cible est dans la même équipe ;
- le débit total reste sous **240 points de dégâts par seconde** — l'arme la
  plus rapide du jeu en produit 120.

### La géométrie vient du client hôte

Le serveur ne génère pas la ville : les 10 000 × 10 000 pixels sont produits
par le client à partir de la graine. L'hôte lui envoie donc, depuis sa propre
carte et dès le salon d'attente :

- `spawns` — jusqu'à 16 points sur un trottoir, jamais dans l'eau ni dans un mur ;
- `checkpoints` — des carrefours répartis autour du centre, donc reliés par de vraies rues ;
- `extraction` — le point sûr le plus éloigné du départ.

Le serveur en valide la forme et les bornes, puis en devient **seul juge** :
franchissements, tours, arrestations et extractions sont décidés par lui.

---

## Limites assumées

- Un client modifié peut annoncer une arme qu'il ne possède pas. Il ne peut
  pas dépasser le débit de dégâts maximal, ni toucher hors de portée.
- Les piétons et le trafic civil restent locaux : chacun voit sa propre
  foule. Les joueurs, eux, sont parfaitement synchronisés.
- La progression de campagne n'est pas partagée ; c'est le monde qui l'est.
- En cas de reconnexion pendant une partie, le serveur replace le joueur sur
  un point d'apparition : la position n'est pas restaurée.
