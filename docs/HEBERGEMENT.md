# Liberty Lake — hébergement externe

Tout tourne sur des services cloud gratuits ou presque. Rien à installer sur
votre machine, rien à laisser allumé : le jeu reste joignable depuis
n'importe quel navigateur, à n'importe quelle heure.

```
  CLIENT (navigateur)
        │  https
        ▼
  SITE STATIQUE — Vercel ou Netlify          liberty-lake.html
        │  wss
        ▼
  SERVEUR NODE.JS — Railway ou Render        server.js  (dépendance : ws)
        │  https (REST)
        ▼
  BASE DE DONNÉES — Supabase (facultative)   parties · profils
```

Trois pièces indépendantes. Le site peut vivre sans le serveur (le jeu reste
jouable en solo), et le serveur peut vivre sans la base (les parties se
jouent, rien n'est archivé).

---

## 1. Le site — héberger le fichier du jeu

Le jeu est **un seul fichier HTML autonome**. Il n'y a donc rien à construire :
on publie le dépôt tel quel.

### Vercel

1. Pousser le projet sur GitHub.
2. Sur [vercel.com](https://vercel.com) → **Add New… › Project** → importer le dépôt.
3. Réglages : **Framework Preset = Other**, *Build Command* vide,
   *Output Directory* vide (racine du dépôt).
4. Déployer. L'URL obtenue est du type `https://mon-jeu.vercel.app`.

`vercel.json`, à la racine, fait le reste : il sert `liberty-lake.html` sur
`/`, pose les en-têtes d'isolation d'origine (bons pour les performances
canvas) et déclare la politique de sécurité du contenu.

> **À modifier après le déploiement du serveur :** dans `vercel.json`, la
> directive `connect-src` de `Content-Security-Policy` liste les serveurs de
> jeu autorisés. Remplacez les hôtes d'exemple par le vôtre, sinon le
> navigateur refusera d'ouvrir la WebSocket.

### Netlify

1. Pousser le projet sur GitHub.
2. Sur [netlify.com](https://netlify.com) → **Add new site › Import an existing project**.
3. Laisser la commande de build vide, *Publish directory* = `.`.
4. Déployer. L'URL est du type `https://mon-jeu.netlify.app`.

`netlify.toml` contient les mêmes redirections et en-têtes, commentés.
La même remarque sur `connect-src` s'applique.

### Déploiement automatique

Les deux plateformes redéploient à chaque `git push` sur la branche
principale. Aucune action supplémentaire.

---

## 2. Le serveur — héberger le multijoueur

`server.js` n'a qu'une dépendance : `ws`. Il écoute sur le port fourni par la
plateforme (`process.env.PORT`), sert `/health` et accepte les WebSockets
sur `/ws`.

> **Lequel choisir ?** **Render** a un vrai palier gratuit (750 heures
> d'instance par mois), au prix d'une mise en veille après 15 minutes sans
> trafic. **Railway** ne garde qu'un crédit d'essai unique de 5 $, puis
> l'abonnement Hobby à 5 $/mois — mais rien n'y dort. Pour jouer entre amis
> sans payer, prenez Render ; le pas-à-pas détaillé est dans
> [TUTORIEL-MISE-EN-LIGNE.md](TUTORIEL-MISE-EN-LIGNE.md). Les tarifs évoluent :
> vérifiez-les avant de vous engager.

### Railway

1. [railway.app](https://railway.app) → **New Project › Deploy from GitHub repo**.
2. Railway détecte `package.json` et lance `npm start` (soit `node server.js`).
3. Onglet **Variables** : ajouter les variables ci-dessous.
4. Onglet **Settings › Networking › Generate Domain** : on obtient
   `https://mon-serveur.up.railway.app`.
   L'adresse WebSocket à saisir dans le jeu est alors
   **`wss://mon-serveur.up.railway.app/ws`**.

### Render

1. [render.com](https://render.com) → **New › Web Service** → connecter le dépôt.
2. *Runtime* **Node**, *Build Command* `npm install`, *Start Command* `npm start`.
3. *Instance Type* **Free**.
4. **Health Check Path** : `/health`.
5. Ajouter les variables d'environnement, puis déployer.
   L'adresse est `wss://mon-serveur.onrender.com/ws`.

### Variables d'environnement

À saisir dans le tableau de bord de la plateforme, **jamais dans le code**.
Le fichier `.env.example` en liste le détail ; `.env` est ignoré par git.

| Variable | Rôle |
| --- | --- |
| `PORT` | fourni automatiquement — ne pas le définir soi-même |
| `ALLOWED_ORIGIN` | origines autorisées à ouvrir une partie, séparées par des virgules : `https://mon-jeu.vercel.app`. Vide = tout accepter (local seulement) |
| `ADMIN_SECRET` | clé exigée par `/admin/salles` et `/admin/journal` |
| `DB_URL`, `DB_KEY` | base Supabase, facultatives (voir §3) |
| `TICK_HZ` | fréquence de simulation, 20 par défaut |
| `MAX_SALLES` | salles simultanées, 40 par défaut |
| `MAX_PAR_IP` | connexions tolérées depuis une même adresse, 8 par défaut |
| `SERVE_STATIC` | `0` en ligne (le client vient de Vercel/Netlify), `1` pour servir aussi le jeu |

> Le contrôle d'origine du serveur (`ALLOWED_ORIGIN`) n'a rien à voir avec les
> en-têtes CORS du site : **une WebSocket n'est pas protégée par CORS**. C'est
> bien le serveur qui doit filtrer, et c'est ce qu'il fait au moment de la
> poignée de main.

### Points d'entrée HTTP

| Route | Réponse |
| --- | --- |
| `GET /health` | `{ "status": "ok", "salles", "joueurs", "memoire", … }` — sonde de vie |
| `GET /rooms` | liste publique des salles (sans mot de passe) |
| `GET /classement` | meilleurs scores, si une base est configurée |
| `GET /admin/salles?secret=…` | état détaillé, clé obligatoire |
| `GET /admin/journal?secret=…` | 500 dernières lignes de journal |

### Garder le serveur éveillé

Sur l'offre gratuite de Render, le service s'endort après 15 minutes sans
trafic, et le réveil prend jusqu'à une minute.

- **Pendant une partie** : le client envoie un `PING` toutes les 4 secondes
  (il sert aussi à mesurer la latence). Depuis février 2026, un message
  WebSocket entrant suffit à repousser la mise en veille de Render : tant que
  quelqu'un joue, le serveur ne s'endort pas.
- **Entre deux parties** : créer un moniteur gratuit sur
  [UptimeRobot](https://uptimerobot.com) → *Add New Monitor* → type **HTTP(s)**,
  URL `https://mon-serveur.onrender.com/health`, intervalle **5 minutes**.
  Le premier joueur de la journée n'attend alors pas le réveil.
  Attention au quota : un service tenu éveillé en permanence consomme ~730
  des 750 heures mensuelles offertes. Un seul service gratuit, donc.

Railway ne met pas en veille de la même façon, mais facture à l'usage : le
moniteur y est inutile, voire contre-productif.

### Dimensionnement

Chiffres relevés sur ce code, **8 joueurs qui bougent tous en permanence et
restent à portée de vue les uns des autres** — le pire cas pour le réseau :

| Ressource | Mesure |
| --- | --- |
| RAM | 45 Mo au repos, 49 Mo avec une salle de 8 joueurs (`memoire` dans `/health`) |
| Bande passante descendante | 10,8 ko/s par joueur |
| Bande passante montante | 1,7 ko/s par joueur |
| Sortant total du serveur | 86 ko/s pour la salle, soit ~310 Mo par heure de jeu |

La diffusion n'envoie que ce qui a changé depuis l'image précédente, avec une
image complète toutes les quatre, et les joueurs à plus de 2 200 pixels ne
sont rafraîchis qu'un tick sur quatre : une salle où chacun vaque de son côté
consomme nettement moins que ce tableau.

Les offres gratuites de Railway et Render (512 Mo de RAM, une fraction de
cœur) tiennent sans peine plusieurs salles de 8 joueurs. C'est la bande
passante sortante qui plafonne en premier : avec les 100 Go mensuels usuels,
comptez de l'ordre de 300 heures de jeu à 8 joueurs.

> Sous Windows, `setInterval` dérive : la mesure donne 16 ticks par seconde au
> lieu de 20. Sur les hôtes Linux de Railway et Render, la cadence est tenue.
> La simulation, elle, lit l'horloge réelle : seule la fréquence de diffusion
> est concernée, jamais la vitesse du jeu.

---

## 3. La base de données — persistance (facultative)

Sans `DB_URL`, le serveur fonctionne en mémoire : tout marche, mais un
redémarrage efface l'historique. Avec Supabase, les parties terminées et les
profils sont archivés.

`db.js` parle à l'API REST de Supabase avec le `fetch` natif de Node 18 :
**aucune dépendance npm supplémentaire**.

### Mise en place

1. Créer un projet gratuit sur [supabase.com](https://supabase.com).
2. **Project Settings › API** : relever l'URL du projet et la clé
   `service_role` → ce sont `DB_URL` et `DB_KEY`.
3. Dans **SQL Editor**, exécuter :

```sql
-- Parties terminées, avec leur classement complet en JSON.
create table if not exists parties (
  id          bigint generated always as identity primary key,
  code        text        not null,
  mode        text        not null,
  seed        bigint,
  raison      text,
  duree       integer,
  classement  jsonb       not null default '[]'::jsonb,
  creee       timestamptz not null default now()
);
create index if not exists parties_mode_creee on parties (mode, creee desc);

-- Progression facultative importée par un joueur.
create table if not exists profils (
  pseudo   text primary key,
  donnees  jsonb,
  maj      timestamptz not null default now()
);

-- La clé service_role contourne RLS ; on l'active quand même pour que
-- la clé publique (anon) ne donne aucun accès à ces tables.
alter table parties enable row level security;
alter table profils enable row level security;
```

4. Ajouter `DB_URL` et `DB_KEY` aux variables du serveur et redéployer.
   `/health` affiche alors `"base": "connectee"`.

> La clé `service_role` donne tous les droits : elle ne doit **jamais**
> apparaître côté client ni dans le dépôt. Elle ne vit que dans les variables
> d'environnement du serveur.

Tout appel à la base est borné à 6 secondes et enveloppé : si Supabase est
lent ou indisponible, la partie continue, seul le journal le signale.

---

## 4. Essayer en local avant de publier

```bash
npm install
node server.js
```

Le serveur sert alors **aussi** le fichier du jeu : ouvrez
<http://localhost:3000/> dans deux onglets, cliquez **JOUER EN LIGNE**, et
l'adresse par défaut (`ws://localhost:3000/ws`) est déjà la bonne.

```bash
PORT=8080 node server.js      # port personnalisé
npm run sante                 # interroge /health
```

Pour jouer à plusieurs sur le même réseau local, les autres postes ouvrent
`http://adresse-ip-de-votre-machine:3000/`.

---

## 5. Enchaînement conseillé

1. Déployer le **serveur** (Railway ou Render) et noter son adresse.
2. Reporter cette adresse dans `connect-src` de `vercel.json` ou
   `netlify.toml`.
3. Déployer le **site**, noter son URL.
4. Reporter cette URL dans `ALLOWED_ORIGIN` sur la plateforme du serveur.
5. Ouvrir le site, **JOUER EN LIGNE**, coller `wss://…/ws`, créer une salle.
6. (Facultatif) brancher Supabase, puis le moniteur UptimeRobot.

---

## 6. Diagnostic

| Symptôme | Piste |
| --- | --- |
| « Adresse de serveur invalide » | l'adresse doit commencer par `wss://` depuis un site en https |
| La connexion échoue sans message | `ALLOWED_ORIGIN` ne contient pas l'URL exacte du site (sans barre oblique finale) |
| Erreur CSP dans la console | `connect-src` n'autorise pas l'hôte du serveur |
| Première connexion très lente | service Render endormi : vérifier le moniteur UptimeRobot |
| « Le serveur parle une autre version du protocole » | site et serveur déployés à partir de commits différents : redéployer les deux |
| « Position corrigée par le serveur » à répétition | horloge ou latence anormale ; consulter `/admin/journal` |
| `"base": "memoire"` dans `/health` | `DB_URL` ou `DB_KEY` absente côté serveur |

---

## 7. Ce que le serveur possède, et ce qu'il ne possède pas

Le modèle est **client-serveur autoritaire**, mais avec une frontière qu'il
vaut mieux connaître avant d'ouvrir un serveur public.

**Le serveur tranche :** positions (contrôle de vitesse et de téléportation),
points de vie, dégâts entre joueurs, portefeuille, étoiles, scores, verrou
des véhicules, heure du jour, météo, événements aléatoires, équipes, manches,
checkpoints, arrestations, extractions, chat.

**Le serveur ignore :** la géométrie de la ville. Les 10 000 × 10 000 pixels
sont générés par le client à partir de la graine ; le porter côté serveur
reviendrait à y dupliquer tout le générateur. En conséquence :

- Les **points d'apparition, le circuit et le point d'extraction** sont
  calculés par le client hôte sur sa propre carte, puis envoyés au serveur,
  qui en valide la forme et devient ensuite seul juge du franchissement.
- La **détection des impacts** est faite par le tireur (lui seul connaît les
  murs). Le serveur revalide l'arme, la distance — sur un historique de
  700 ms, pour être juste avec les connexions lentes — et plafonne le débit
  de dégâts à 240 points par seconde. Un client modifié peut donc annoncer
  une arme qu'il ne possède pas, mais pas infliger plus de dégâts que la
  cadence maximale du jeu.
- Les **piétons et le trafic civil** restent locaux et décoratifs : chacun
  voit sa propre foule. Les joueurs, eux, sont parfaitement synchronisés.
- L'**argent** est annoncé par le client puis borné par le serveur
  (6 000 $ par tranche de 10 secondes).

Pour une partie entre amis, c'est largement suffisant. Pour un serveur
public compétitif, il faudrait porter la génération du monde côté serveur —
c'est un autre chantier, et il est signalé comme tel.
