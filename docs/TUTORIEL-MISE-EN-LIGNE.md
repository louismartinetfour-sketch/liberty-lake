# Mettre Liberty Lake en ligne — tutoriel de A à Z

Pas à pas, sans rien supposer de connu. À la fin, vous aurez deux adresses
publiques : une pour le jeu, une pour le serveur multijoueur, toutes deux
joignables sans que votre ordinateur soit allumé.

Comptez **45 minutes** la première fois.

```
   Votre PC ──push──> GitHub ──┬──> Vercel   = le jeu        https://…vercel.app
                               └──> Render   = le serveur    wss://…onrender.com/ws
```

> Les interfaces de GitHub, Vercel et Render changent régulièrement. Les
> noms de boutons donnés ici étaient exacts à la rédaction ; si l'un a
> bougé, le sens de l'étape reste le même.

---

## Étape 0 — Ce qu'il faut avant de commencer

### Sur votre ordinateur

Déjà vérifié chez vous, rien à installer :

| | Version trouvée |
| --- | --- |
| Node.js | 24.14.0 |
| npm | 11.9.0 |
| git | 2.52.0 (configuré au nom de `louismartinetfour-sketch`) |

### Trois comptes gratuits à créer

1. **GitHub** — <https://github.com/signup> — l'entrepôt du code.
2. **Vercel** — <https://vercel.com/signup> — choisissez **« Continue with
   GitHub »**, c'est plus simple ensuite.
3. **Render** — <https://dashboard.render.com/register> — là aussi,
   **« GitHub »**.

Un seul mot de passe à retenir au bout du compte : celui de GitHub.

### Pourquoi deux hébergeurs ?

Vercel sait servir un fichier, très vite, partout dans le monde — mais il ne
garde pas de programme vivant. Le multijoueur, lui, a besoin d'un programme
qui tourne en permanence et garde les connexions ouvertes. D'où Render.

---

## Étape 1 — Envoyer le projet sur GitHub

### 1.1 Créer le dépôt sur GitHub

1. Allez sur <https://github.com/new>.
2. **Repository name** : `liberty-lake`
3. **Private** si vous ne voulez pas que le code soit public (Vercel et
   Render y accèdent quand même, vous les autoriserez).
4. **Ne cochez rien** dans « Initialize this repository » — pas de README,
   pas de .gitignore, pas de licence. Le dossier en a déjà.
5. **Create repository**.

GitHub affiche alors une page avec des commandes. Ignorez-la, les nôtres
sont ci-dessous.

### 1.2 Transformer le dossier en dépôt

Ouvrez un terminal **dans le dossier du jeu** et lancez les commandes une par
une :

```bash
cd "C:\Users\xboxf\OneDrive\Bureau\jeux navigateur"
```

```bash
git init -b main
```

```bash
git add .
```

```bash
git status --short | head -20
```

Cette dernière vérifie ce qui va partir. Vous devez voir `liberty-lake.html`,
`server.js`, `db.js`, `package.json`, les fichiers de `docs/`… et **surtout
pas** `node_modules/` ni `.env` : le `.gitignore` les écarte déjà.

```bash
git commit -m "Liberty Lake : jeu, serveur multijoueur et configuration d'hébergement"
```

### 1.3 Pousser vers GitHub

Remplacez `VOTRE-PSEUDO` par votre identifiant GitHub :

```bash
git remote add origin https://github.com/VOTRE-PSEUDO/liberty-lake.git
```

```bash
git push -u origin main
```

Au premier `push`, une fenêtre s'ouvre pour vous connecter à GitHub
(« Git Credential Manager »). Choisissez **Sign in with your browser**,
validez, et la fenêtre se referme seule. Les fois suivantes, plus rien à
faire.

Rafraîchissez la page de votre dépôt : les fichiers y sont.

> **Si `git push` est refusé** avec `remote origin already exists`, c'est que
> l'adresse était déjà enregistrée : utilisez
> `git remote set-url origin https://github.com/VOTRE-PSEUDO/liberty-lake.git`
> puis recommencez le push.

---

## Étape 2 — Le serveur multijoueur sur Render

**On commence par le serveur** : son adresse sera nécessaire pour configurer
le site juste après.

### 2.1 Créer le service

1. <https://dashboard.render.com> → **New +** → **Web Service**.
2. **Connect a repository** → autorisez Render à voir votre GitHub →
   choisissez `liberty-lake`.
3. Remplissez :

| Champ | Valeur |
| --- | --- |
| **Name** | `liberty-lake-serveur` (il formera l'adresse) |
| **Region** | `Frankfurt (EU Central)` si vous jouez depuis l'Europe |
| **Branch** | `main` |
| **Root Directory** | *laisser vide* |
| **Runtime** / **Language** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Instance Type** | **Free** |

4. Dépliez **Advanced** et réglez **Health Check Path** sur `/health`.

### 2.2 Les variables d'environnement

Toujours dans **Advanced**, **Add Environment Variable**, deux lignes :

| Key | Value |
| --- | --- |
| `SERVE_STATIC` | `0` |
| `ADMIN_SECRET` | une longue chaîne inventée, par exemple `7h2Kp9xQw4Lm8Rt5Vb3Nz6Yc1` |

`ALLOWED_ORIGIN` viendra à l'étape 4, quand le site aura une adresse.
`PORT` est fourni par Render : **ne le définissez jamais vous-même**.

> `ADMIN_SECRET` protège `/admin/salles` et `/admin/journal`. Sans elle, ces
> deux pages restent fermées — mais autant avoir la clé.

### 2.3 Déployer et vérifier

**Create Web Service**. Le journal défile pendant deux à trois minutes, puis
affiche :

```
serveur pret · {"port":10000,"tick":20,"statique":false,…}
   WebSocket : ws://localhost:10000/ws
```

> La ligne « ws://localhost » est normale : le serveur décrit son écoute
> interne. De l'extérieur, c'est l'adresse Render qui compte.

Votre adresse figure en haut de la page, du type
`https://liberty-lake-serveur.onrender.com`. Ouvrez-la en ajoutant `/health` :

```
https://liberty-lake-serveur.onrender.com/health
```

Vous devez lire quelque chose comme :

```json
{"status":"ok","protocole":"ll-net-1","salles":0,"joueurs":0,
 "uptime":12,"tick":20,"memoire":46,"base":"memoire"}
```

**Notez bien l'adresse du serveur pour le jeu** : c'est la même, en `wss://`
et suivie de `/ws` —

```
wss://liberty-lake-serveur.onrender.com/ws
```

---

## Étape 3 — Le jeu sur Vercel

### 3.1 Importer le projet

1. <https://vercel.com/new> → **Import Git Repository** → `liberty-lake`.
2. **Framework Preset** : **Other**.
3. **Build Command**, **Output Directory**, **Install Command** : laissez
   tout vide (ouvrez la section *Build and Output Settings* pour le vérifier).
4. **Deploy**.

Vingt secondes plus tard, Vercel affiche l'aperçu et votre adresse, du type
`https://liberty-lake.vercel.app`.

### 3.2 Vérifier

Ouvrez l'adresse : le menu de Liberty Lake apparaît, le solo est jouable.
C'est `vercel.json` qui redirige `/` vers `liberty-lake.html`.

Le multijoueur ne marche pas encore — c'est l'étape suivante.

---

## Étape 4 — Relier le site et le serveur

Deux déclarations croisées, l'une dans le code, l'autre chez Render. Sans
elles, le navigateur **et** le serveur refusent la connexion, chacun pour une
raison différente.

### 4.1 Autoriser le serveur dans le jeu (navigateur → serveur)

Le navigateur n'ouvre une WebSocket que vers les adresses déclarées dans la
politique de sécurité du contenu. Ouvrez [vercel.json](../vercel.json) et
remplacez, dans la longue ligne `Content-Security-Policy`, les deux hôtes
d'exemple par le vôtre :

```
wss://liberty-lake-serveur.up.railway.app https://liberty-lake-serveur.up.railway.app
wss://liberty-lake-serveur.onrender.com   https://liberty-lake-serveur.onrender.com
```

devient, si votre service s'appelle autrement :

```
wss://VOTRE-SERVICE.onrender.com https://VOTRE-SERVICE.onrender.com
```

Gardez `ws://localhost:3000 http://localhost:3000` à la fin : c'est ce qui
vous laisse continuer à tester sur votre machine.

Puis publiez la modification :

```bash
git add vercel.json && git commit -m "Autoriser le serveur de jeu dans la CSP" && git push
```

Vercel redéploie tout seul en une vingtaine de secondes.

> Si vous avez choisi Netlify, la même ligne est à modifier dans
> [netlify.toml](../netlify.toml).

### 4.2 Autoriser le site dans le serveur (serveur → site)

Une WebSocket n'est pas protégée par CORS : c'est au serveur de filtrer qui
a le droit d'ouvrir une partie.

1. Render → votre service → **Environment** → **Add Environment Variable**.
2. | Key | Value |
   | --- | --- |
   | `ALLOWED_ORIGIN` | `https://liberty-lake.vercel.app` |

**Sans barre oblique finale**, et exactement l'adresse affichée par Vercel.
Pour en autoriser plusieurs, séparez-les par des virgules :
`https://liberty-lake.vercel.app,https://liberty-lake-git-main-vous.vercel.app`

3. **Save Changes** : Render redéploie.

---

## Étape 5 — Votre première partie en ligne

1. Ouvrez `https://liberty-lake.vercel.app`.
2. **JOUER EN LIGNE**.
3. **PSEUDO** : votre nom. **SERVEUR** : `wss://VOTRE-SERVICE.onrender.com/ws`
4. **SE CONNECTER**. Le badge passe à **CONNECTÉ** avec la latence.
5. **CRÉER LA SALLE** (mode, graine, options à votre goût).
6. Envoyez l'adresse du site à un ami. Il fait la même chose, voit votre
   salle dans la liste, clique **REJOINDRE**.
7. Vous, l'hôte : **LANCER LA PARTIE**.

Le pseudo et l'adresse du serveur sont retenus : la fois suivante, deux
clics suffisent.

> **La première connexion de la journée peut prendre une minute.** Le service
> gratuit s'endort après 15 minutes sans trafic et doit se réveiller.
> L'étape 6 règle ça.

---

## Étape 6 — Garder le serveur réveillé

Depuis février 2026, un service gratuit Render reste éveillé tant qu'il
reçoit des messages WebSocket. Le jeu en envoie un toutes les 4 secondes :
**pendant qu'une partie est en cours, le serveur ne s'endort pas**.

Reste le tout premier réveil. Un moniteur gratuit s'en charge :

1. <https://uptimerobot.com> → compte gratuit.
2. **+ New monitor**.
3. **Monitor Type** : `HTTP(s)` · **Friendly Name** : `Liberty Lake` ·
   **URL** : `https://VOTRE-SERVICE.onrender.com/health` ·
   **Monitoring Interval** : `5 minutes`.
4. **Create monitor**.

Le serveur répond alors toutes les 5 minutes et ne dort jamais.

> **Attention au quota.** Render offre 750 heures d'instance par mois et par
> espace de travail. Un service maintenu éveillé en permanence en consomme
> ~730 : vous tenez avec **un seul** service gratuit, pas deux. Si vous
> préférez laisser le serveur dormir, supprimez le moniteur et acceptez une
> minute d'attente au premier joueur.

---

## Étape 7 — La base de données (facultatif)

Sans elle, tout fonctionne : les parties se jouent, mais rien n'est archivé
d'un redémarrage à l'autre. Avec elle, les classements sont conservés.

1. <https://supabase.com> → **New project** (gratuit).
2. **SQL Editor** → **New query** → collez tout le contenu de
   [supabase.sql](supabase.sql) → **Run**. Le script est prêt à l'emploi,
   rien à y modifier.
3. **Project Settings → API** : relevez l'URL du projet et la clé
   `service_role`.
4. Render → **Environment** → ajoutez :

| Key | Value |
| --- | --- |
| `DB_URL` | `https://xxxxxxxx.supabase.co` |
| `DB_KEY` | la clé `service_role` |

5. Après redéploiement, `/health` affiche `"base":"connectee"`.

> La clé `service_role` donne tous les droits sur votre base. Elle ne vit que
> dans les variables Render — **jamais** dans le code, jamais sur GitHub.

---

## Étape 8 — Modifier le jeu plus tard

C'est le point agréable : il n'y a plus rien à refaire.

```bash
git add . && git commit -m "ce que j'ai changé" && git push
```

- Un changement dans `liberty-lake.html` → Vercel redéploie le jeu.
- Un changement dans `server.js` → Render redéploie le serveur.

**Une seule précaution :** si vous touchez au protocole réseau, changez
`PROTOCOLE` dans `server.js` **et** `NET_PROTO` dans `liberty-lake.html` en
même temps. Un client et un serveur de versions différentes se refusent
poliment plutôt que de jouer une partie incohérente.

Avant de pousser une modification du serveur, le banc d'essai vous dit si
rien n'est cassé :

```bash
node server.js
```

puis, dans un second terminal :

```bash
npm run test:protocole
```

Vous devez lire `48 réussis, 0 échecs`.

---

## Étape 9 — Quand ça ne marche pas

| Ce que vous voyez | Ce qu'il faut regarder |
| --- | --- |
| Badge bloqué sur **CONNEXION…** | l'adresse doit commencer par `wss://` depuis un site en `https`, et finir par `/ws` |
| **CONNEXION…** puis **HORS LIGNE**, sans message | `ALLOWED_ORIGIN` ne contient pas l'URL exacte du site (barre oblique finale en trop ?) |
| Console du navigateur : `Refused to connect … Content Security Policy` | `vercel.json` n'autorise pas l'hôte du serveur (étape 4.1) ; le changement a-t-il été poussé ? |
| Première connexion très longue, puis tout va bien | le service dormait ; voir l'étape 6 |
| « Le serveur parle une autre version du protocole » | site et serveur déployés depuis des commits différents : repoussez les deux |
| `git push` refusé : `Authentication failed` | relancez, choisissez **Sign in with your browser** |
| Vercel affiche une liste de fichiers au lieu du jeu | *Framework Preset* n'est pas sur **Other**, ou une commande de build a été renseignée |
| Render : `Cannot find module 'ws'` | *Build Command* doit être `npm install` |
| `/health` répond `"base":"memoire"` alors que Supabase est branché | `DB_URL` ou `DB_KEY` manquante ou mal copiée |

Pour voir ce que fait le serveur en direct : Render → votre service →
**Logs**. Chaque action y est horodatée (arrivées, départs, morts, valeurs
rejetées).

---

## Étape 10 — Ce que ça coûte vraiment

| Service | Offre utilisée | Prix | La limite qui compte |
| --- | --- | --- | --- |
| **Vercel** | Hobby | 0 € | usage personnel non commercial |
| **Render** | Free | 0 € | 750 h d'instance par mois ; s'endort après 15 min sans trafic |
| **Supabase** | Free | 0 € | 500 Mo de base, projet mis en pause après une semaine d'inactivité |
| **UptimeRobot** | Free | 0 € | 50 moniteurs, intervalle de 5 min |

**Zéro euro** pour jouer entre amis. Les mesures faites sur ce serveur
donnent 11 ko/s par joueur et 52 Mo de mémoire pour une salle de huit : les
offres gratuites sont très au large.

**Si vous voulez un serveur qui ne dort jamais**, deux options payantes :
Render **Starter** à 7 $/mois, ou **Railway** à partir de 5 $/mois (Railway
n'a plus de palier gratuit durable : un crédit d'essai unique de 5 $, puis
l'abonnement Hobby). Vérifiez les tarifs du jour, ils bougent.

---

## Récapitulatif à garder sous la main

```
Dépôt       https://github.com/VOTRE-PSEUDO/liberty-lake
Jeu         https://liberty-lake.vercel.app
Serveur     wss://VOTRE-SERVICE.onrender.com/ws
Santé       https://VOTRE-SERVICE.onrender.com/health
Admin       https://VOTRE-SERVICE.onrender.com/admin/salles?secret=VOTRE-CLE
```

Pour aller plus loin : [HEBERGEMENT.md](HEBERGEMENT.md) (référence des
variables, SQL, dimensionnement) et [PROTOCOLE.md](PROTOCOLE.md) (messages
réseau, anti-triche, limites assumées).
