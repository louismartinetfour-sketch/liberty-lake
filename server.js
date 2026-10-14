#!/usr/bin/env node
'use strict';
/* =======================================================================
   LIBERTY LAKE — SERVEUR MULTIJOUEUR AUTORITAIRE
   -----------------------------------------------------------------------
   Lancement :
     node server.js              → serveur local sur le port 3000
     PORT=8080 node server.js    → port personnalisé
     npm start                   → ce que lance Railway / Render

   Dépendance unique : ws        (npm install ws)
   Node.js 18 minimum (fetch natif utilisé par db.js).

   Variables d'environnement (jamais de secret dans le code) :
     PORT            port d'écoute, fourni automatiquement par l'hébergeur
     ALLOWED_ORIGIN  origines autorisées pour la poignée de main WebSocket,
                     séparées par des virgules (ex. https://mon-jeu.vercel.app).
                     Vide = tout accepter (pratique en local, à éviter en ligne).
     ADMIN_SECRET    clé exigée par /admin/salles et /admin/journal
     DB_URL, DB_KEY  base de données optionnelle (voir db.js)
     TICK_HZ         fréquence de simulation, 20 par défaut
     MAX_SALLES      nombre de salles simultanées, 40 par défaut
     SERVE_STATIC    1 pour servir liberty-lake.html depuis ce serveur

   Ce que le serveur possède (le client ne fait que le montrer) :
     positions validées, points de vie, portefeuille, étoiles, scores,
     heure du jour, météo, événements, verrou des véhicules, manches,
     équipes, chat. Voir la section « LIMITES » de docs/HEBERGEMENT.md.
   ======================================================================= */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const db = require('./db.js');

/* ----------------------------- CONFIGURATION ------------------------- */
const PORT = parseInt(process.env.PORT, 10) || 3000;
const TICK_HZ = Math.max(5, Math.min(60, parseInt(process.env.TICK_HZ, 10) || 20));
const TICK_MS = 1000 / TICK_HZ;
const MAX_SALLES = parseInt(process.env.MAX_SALLES, 10) || 40;
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const SERVE_STATIC = process.env.SERVE_STATIC === '1' || !process.env.PORT;
const ORIGINES = (process.env.ALLOWED_ORIGIN || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const PROTOCOLE = 'll-net-1';          // les clients d'une autre version sont refusés

/* Garde-fous réseau. Un client honnête envoie une vingtaine de messages
   par seconde (20 INPUT plus quelques actions) : la limite laisse de la
   marge sans permettre l'inondation.                                    */
const LIM = {
  msgParSec: 70,          // au-delà : avertissement puis expulsion
  avertMax: 4,            // nombre d'avertissements tolérés
  tailleMsg: 4096,        // octets par message
  suspectsMax: 30,        // positions impossibles tolérées avant expulsion
  inactivite: 25000,      // ms sans aucun message → expulsion
  chatParSec: 2,
  chatLong: 200,
  pseudoLong: 18,
  /* Plusieurs joueurs partagent souvent une même adresse publique (une
     maison, un lycée, un opérateur mobile) : la limite protège de
     l'inondation de connexions sans interdire une colocation. Elle se
     relève avec MAX_PAR_IP pour un banc d'essai ou un réseau partagé. */
  joueursParIP: Math.max(1, parseInt(process.env.MAX_PAR_IP, 10) || 8)
};

/* Vitesses maximales connues du client (liberty-lake.html).
   Elles servent à rejeter une téléportation ou une vitesse impossible.
   On garde une marge : latence, rebonds de collision et rampes de saut
   produisent de vrais déplacements légèrement supérieurs.               */
const VMAX = { pied: 300, auto: 430, bateau: 400, avion: 640, defaut: 430 };
const MARGE_V = 1.45;      // tolérance multiplicative
const MARGE_PX = 70;       // tolérance fixe (collisions, rampes)
const TAILLE_MONDE = 10000;
/* Durée de l'historique de positions gardé pour compenser la latence
   lors de la validation d'un tir (ms).                                 */
const FENETRE_HISTO = 700;

/* Armes : table miroir de celle du client, pour valider les dégâts. */
const ARMES = {
  fists: { dmg: 7, rate: 0.42, portee: 60 },
  pistol: { dmg: 15, rate: 0.30, portee: 560 },
  smg: { dmg: 10, rate: 0.085, portee: 490 },
  shotgun: { dmg: 54, rate: 0.80, portee: 320 },   // 6 plombs de 9 dégâts
  rifle: { dmg: 34, rate: 0.55, portee: 880 }
};

/* Modes de jeu. duree = 0 pour une partie sans fin (monde ouvert). */
const MODES = {
  coop: {
    nom: 'Monde ouvert coopératif', min: 1, max: 8, duree: 0,
    equipes: false, feuAmi: false, etoilesDepart: 0,
    desc: 'Même carte, même heure, événements partagés.'
  },
  bataille: {
    nom: 'Bataille rangée', min: 2, max: 16, duree: 900,
    equipes: true, feuAmi: true, etoilesDepart: 0,
    desc: 'Le plus d’argent et de victimes en 15 minutes.'
  },
  course: {
    nom: 'Course', min: 1, max: 12, duree: 600,
    equipes: false, feuAmi: false, etoilesDepart: 0,
    desc: 'Circuit à checkpoints, classement en direct.'
  },
  police: {
    nom: 'Police contre fugitifs', min: 2, max: 10, duree: 600,
    equipes: true, feuAmi: true, etoilesDepart: 5,
    desc: 'Les fugitifs rejoignent l’extraction, la police les arrête.'
  }
};

/* Couleurs attribuées aux joueurs, dans l'ordre d'arrivée. */
const COULEURS = ['#4de2ff', '#ff6b6b', '#7ae582', '#f0c23a', '#c08aff',
  '#ff9f43', '#5ad9c0', '#ff79c6', '#9ec5ff', '#d8cfbc',
  '#8ad45a', '#ff5e7a', '#58c4ff', '#ffd45e', '#b48cff', '#6fe3c4'];

/* Météo : mêmes états et mêmes enchaînements que le client, pour que
   tout le monde soit sous la même pluie au même moment.                */
const METEO_SUITES = {
  degage: ['nuageux', 'nuageux', 'degage', 'brouillard'],
  nuageux: ['pluie', 'degage', 'brouillard', 'pluie', 'nuageux'],
  pluie: ['orage', 'nuageux', 'nuageux', 'pluie'],
  orage: ['pluie', 'pluie', 'nuageux'],
  brouillard: ['nuageux', 'degage', 'brouillard']
};

/* Événements aléatoires diffusés à toute la salle. */
const EVENEMENTS = [
  { id: 'accident', nom: 'Carambolage', txt: 'Un carambolage bloque un carrefour' },
  { id: 'braquage', nom: 'Braquage en cours', txt: 'Une alarme de banque vient de se déclencher' },
  { id: 'convoi', nom: 'Convoi blindé', txt: 'Un convoi blindé traverse la ville' },
  { id: 'course_sauvage', nom: 'Course sauvage', txt: 'Une course sauvage se forme sur le périphérique' },
  { id: 'rafle', nom: 'Rafle', txt: 'La police met en place des contrôles' },
  { id: 'panne', nom: 'Panne de secteur', txt: 'Un quartier vient de perdre l’électricité' }
];

/* ------------------------------ OUTILS ------------------------------- */
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const alea = (a, b) => a + Math.random() * (b - a);
const pioche = t => t[Math.floor(Math.random() * t.length)];
const nombre = (v, def) => (typeof v === 'number' && isFinite(v)) ? v : def;
/* Valeur imposée à une liste de choix : tout le reste retombe sur le
   défaut. Utile pour les options de salle, qui viennent du client.    */
const parmi = (v, choix, def) => {
  const n = Math.round(nombre(v, NaN));
  return choix.indexOf(n) >= 0 ? n : def;
};

/* Journal horodaté. Toute action significative y passe : connexion,
   achat, mort, quête, valeur rejetée. Un seul format, facile à grep.   */
const JOURNAL = [];                    // tampon circulaire pour /admin/journal
function log(niveau, sujet, detail) {
  const ligne = new Date().toISOString() + ' [' + niveau + '] ' + sujet +
    (detail ? ' · ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '');
  JOURNAL.push(ligne);
  if (JOURNAL.length > 500) JOURNAL.shift();
  if (niveau === 'ERR') console.error(ligne); else console.log(ligne);
}

/* Nettoyage du texte venant du client : jamais de balise, jamais de
   caractère de contrôle, longueur bornée.                              */
function propre(txt, max) {
  if (typeof txt !== 'string') return '';
  return txt.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
}

/* Filtre grossièreté, activable par salle. Volontairement minimal :
   on masque la racine, on ne réécrit pas la phrase.                    */
const GROS_MOTS = ['merde', 'connard', 'salope', 'enculé', 'encule', 'pute', 'fdp', 'ntm'];
function filtrer(txt) {
  let out = txt;
  for (const m of GROS_MOTS) {
    const re = new RegExp(m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, c => c[0] + '*'.repeat(Math.max(1, c.length - 1)));
  }
  return out;
}

let SEQ_ID = 1;
const idJoueur = () => 'j' + (SEQ_ID++) + '-' + Math.random().toString(36).slice(2, 6);

/* =======================================================================
   JOUEUR — une connexion, un personnage, son état autoritaire
   ======================================================================= */
class Joueur {
  constructor(ws, ip) {
    this.ws = ws;
    this.ip = ip;
    this.id = idJoueur();
    this.pseudo = 'Anonyme';
    this.couleur = COULEURS[0];
    this.equipe = 0;              // 0 = sans équipe, 1 / 2 selon le mode
    this.pret = false;
    this.salle = null;
    this.vivant = true;

    // --- état autoritaire du personnage ---
    this.x = 0; this.y = 0; this.ang = 0; this.aim = 0;
    this.hp = 100; this.maxHp = 100; this.armor = 0;
    this.argent = 0; this.etoiles = 0;   // miroir du portefeuille du client
    this.veh = null;              // { id, kind } du véhicule occupé
    this.arme = 'fists';
    this.nage = false; this.dedans = false;   // nage / à l'intérieur d'un bâtiment
    this.mort = false; this.respawnT = 0;

    // --- score et progression de manche ---
    this.score = 0; this.kills = 0; this.morts = 0;
    this.checkpoint = -1; this.tour = 0; this.fini = false; this.tempsFin = 0;
    this.arrete = false;          // mode police : fugitif arrêté
    this.extrait = false;         // mode police : fugitif sorti

    // --- validation et cadence ---
    this.seq = 0;                 // dernier numéro d'input accepté
    this.tDernierInput = 0;
    /* Historique court des positions validées. Il sert à compenser la
       latence : quand un tireur annonce avoir touché quelqu'un, on
       cherche si la cible était à portée à un instant récent, et pas
       seulement là où elle se trouve maintenant. */
    this.histo = [];
    this.grace = 0;               // fin de la fenêtre de grâce après un placement
    this.suspects = 0;
    this.avert = 0;
    this.msgN = 0; this.msgT = Date.now();
    this.chatN = 0; this.chatT = Date.now();
    this.tirT = 0;
    this.vuLe = Date.now();
    this.latence = 0;
    this.gainT = Date.now();      // fenêtre de contrôle des gains d'argent
    this.gainCumul = 0;
    this.dmgT = Date.now();       // fenêtre de contrôle des dégâts infligés
    this.dmgCumul = 0;
  }

  envoyer(obj) {
    if (!this.ws || this.ws.readyState !== 1) return;
    try { this.ws.send(JSON.stringify(obj)); } catch (e) { /* socket fermée entre-temps */ }
  }
  expulser(raison) {
    log('INFO', 'expulsion', { id: this.id, pseudo: this.pseudo, raison });
    this.envoyer({ t: 'KICK', raison });
    try { this.ws.close(4003, 'kick'); } catch (e) { }
  }

  /* Vitesse maximale admise selon le moyen de locomotion déclaré. */
  vitesseMax() {
    if (!this.veh) return this.nage ? VMAX.pied : VMAX.pied;
    const k = this.veh.kind || '';
    if (k === 'avion') return VMAX.avion;
    if (k === 'bateau' || k === 'barque' || k === 'vedette' || k === 'speed') return VMAX.bateau;
    if (k === 'helico') return VMAX.avion;
    return VMAX.auto;
  }

  /* État compact envoyé dans chaque TICK. Les clés sont courtes : à
     20 Hz et 16 joueurs, chaque octet compte.                          */
  instantane() {
    return {
      i: this.id,
      // le pixel entier suffit : l'interpolation lisse le reste, et les
      // décimales coûteraient deux caractères par joueur et par image
      x: Math.round(this.x),
      y: Math.round(this.y),
      a: Math.round(this.ang * 100) / 100,
      m: Math.round(this.aim * 100) / 100,
      h: Math.round(this.hp),
      e: this.etoiles,
      s: this.score,
      v: this.veh ? this.veh.kind : null,
      w: this.arme,
      d: this.mort ? 1 : 0,
      g: this.nage ? 1 : 0,
      b: this.dedans ? 1 : 0
    };
  }
  /* Fiche complète, envoyée à l'arrivée et dans le salon d'attente. */
  fiche() {
    return {
      id: this.id, pseudo: this.pseudo, couleur: this.couleur,
      equipe: this.equipe, pret: this.pret, latence: this.latence,
      score: this.score, kills: this.kills, morts: this.morts,
      tour: this.tour, checkpoint: this.checkpoint, fini: this.fini,
      arrete: this.arrete, extrait: this.extrait, mort: this.mort
    };
  }
}

/* =======================================================================
   SALLE — une instance de monde, ses joueurs, sa boucle de jeu
   -----------------------------------------------------------------------
   Chaque salle a sa propre graine, sa propre heure, sa propre météo et
   sa propre file d'événements : deux salles ne se voient pas.
   ======================================================================= */
class Salle {
  constructor(code, def) {
    this.code = code;
    this.nom = def.nom;
    this.mode = def.mode;
    this.max = def.max;
    this.seed = def.seed;
    this.motdepasse = def.motdepasse || '';   // jamais journalisé, jamais diffusé
    this.options = def.options;
    this.hote = null;                          // id du créateur
    this.joueurs = new Map();
    this.phase = 'attente';                    // attente · decompte · jeu · fin
    this.decompte = 0;
    this.creee = Date.now();
    this.debut = 0;
    this.tempsRestant = MODES[this.mode].duree;
    this.tick = 0;

    // --- horloge du monde, partagée par tous ---
    this.tJour = def.options.heureDepart !== undefined ? def.options.heureDepart : 0.34;
    this.meteo = def.options.meteoFixe || 'degage';
    this.meteoFixe = !!def.options.meteoFixe;
    this.meteoReste = alea(75, 165);
    this.meteoSuite = [];
    for (let i = 0, p = this.meteo; i < 3; i++) { const s = this.tirerMeteo(p); this.meteoSuite.push(s); p = s.etat; }

    // --- événements aléatoires ---
    this.evtTimer = alea(60, 150);
    this.evtActifs = [];

    // --- géométrie fournie par le client hôte (voir GEOMETRIE) ---
    this.geo = { spawns: [], checkpoints: [], extraction: null, pret: false };

    // --- véhicules verrouillés : premier arrivé, premier servi ---
    this.vehicules = new Map();       // idVéhicule → { par, kind, x, y, t }

    this.boucle = null;
    this.derTick = Date.now();
  }

  /* ------------------------------- cycle ---------------------------- */
  demarrerBoucle() {
    if (this.boucle) return;
    this.derTick = Date.now();
    this.boucle = setInterval(() => {
      const t = Date.now();
      const dt = Math.min(0.25, (t - this.derTick) / 1000);
      this.derTick = t;
      try { this.simuler(dt); } catch (e) { log('ERR', 'tick salle ' + this.code, e.message); }
    }, TICK_MS);
  }
  arreterBoucle() {
    if (this.boucle) { clearInterval(this.boucle); this.boucle = null; }
  }

  tirerMeteo(prec) {
    const suivant = pioche(METEO_SUITES[prec] || METEO_SUITES.degage);
    return { etat: suivant, duree: alea(75, 165) };
  }

  def() { return MODES[this.mode]; }
  feuAmi() {
    return this.options.feuAmi !== undefined ? !!this.options.feuAmi : this.def().feuAmi;
  }

  /* Résumé pour la liste des salles. Pas de mot de passe, pas d'IP. */
  info() {
    return {
      code: this.code, nom: this.nom, mode: this.mode,
      modeNom: this.def().nom,
      joueurs: this.joueurs.size, max: this.max,
      seed: this.seed, phase: this.phase,
      prive: !!this.motdepasse,
      duree: Math.round((Date.now() - this.creee) / 1000)
    };
  }
  /* État du salon d'attente, renvoyé à chaque changement. */
  etatSalon() {
    return {
      t: 'SALLE',
      code: this.code, nom: this.nom, mode: this.mode, modeNom: this.def().nom,
      max: this.max, seed: this.seed, hote: this.hote, phase: this.phase,
      decompte: Math.ceil(this.decompte),
      options: this.options,
      joueurs: [...this.joueurs.values()].map(j => j.fiche())
    };
  }

  diffuser(msg, saufId) {
    const brut = JSON.stringify(msg);
    for (const j of this.joueurs.values()) {
      if (saufId && j.id === saufId) continue;
      if (j.ws.readyState === 1) { try { j.ws.send(brut); } catch (e) { } }
    }
  }
  diffuserSalon() { this.diffuser(this.etatSalon()); }
  annonce(txte, couleur) {
    this.diffuser({ t: 'CHAT', pseudo: '', texte: txte, couleur: couleur || '#9ec5ff', canal: 'systeme' });
  }

  /* ------------------------- arrivées et départs --------------------- */
  ajouter(j, pseudo) {
    if (this.joueurs.size >= this.max) return 'Salle pleine';
    if (this.phase === 'fin') return 'Partie terminée';
    j.pseudo = pseudo;
    j.salle = this;
    j.couleur = this.couleurLibre();
    j.pret = false;
    this.joueurs.set(j.id, j);
    if (!this.hote) this.hote = j.id;
    // une partie en cours accepte les arrivants : ils entrent directement
    if (this.phase === 'jeu') { this.placer(j); this.envoyerInit(j); }
    this.diffuserSalon();
    this.annonce(pseudo + ' rejoint la salle', j.couleur);
    log('INFO', 'arrivee', { salle: this.code, id: j.id, pseudo });
    return null;
  }
  couleurLibre() {
    const prises = new Set([...this.joueurs.values()].map(j => j.couleur));
    return COULEURS.find(c => !prises.has(c)) || pioche(COULEURS);
  }
  retirer(j) {
    if (!this.joueurs.has(j.id)) return;
    this.joueurs.delete(j.id);
    j.salle = null;
    // son véhicule reste sur place, simplement déverrouillé
    for (const [idv, v] of this.vehicules) if (v.par === j.id) this.vehicules.delete(idv);
    this.annonce(j.pseudo + ' a quitté la partie', '#7a8ea6');
    log('INFO', 'depart', { salle: this.code, id: j.id, pseudo: j.pseudo });
    if (this.hote === j.id) {
      // l'hôte passe au joueur présent le plus ancien
      const suivant = this.joueurs.values().next().value;
      this.hote = suivant ? suivant.id : null;
      if (suivant) this.annonce(suivant.pseudo + ' devient hôte de la salle', suivant.couleur);
    }
    this.diffuserSalon();
    if (this.joueurs.size === 0) HUB.fermer(this.code);
  }

  /* ------------------------- lancement de partie --------------------- */
  /* Le client hôte envoie la géométrie tirée de SA génération du monde :
     points d'apparition sûrs, checkpoints du circuit, point d'extraction.
     Le serveur en valide la forme puis en devient le seul propriétaire. */
  recevoirGeometrie(j, m) {
    if (j.id !== this.hote) return;
    const bornes = p => p && isFinite(p.x) && isFinite(p.y) &&
      p.x >= 0 && p.x <= TAILLE_MONDE && p.y >= 0 && p.y <= TAILLE_MONDE;
    const spawns = Array.isArray(m.spawns) ? m.spawns.filter(bornes).slice(0, 32)
      .map(p => ({ x: p.x, y: p.y })) : [];
    const cps = Array.isArray(m.checkpoints) ? m.checkpoints.filter(bornes).slice(0, 24)
      .map(p => ({ x: p.x, y: p.y, r: clamp(nombre(p.r, 90), 40, 400) })) : [];
    const ext = bornes(m.extraction)
      ? { x: m.extraction.x, y: m.extraction.y, r: clamp(nombre(m.extraction.r, 150), 60, 500) } : null;
    if (!spawns.length) return;
    this.geo = { spawns, checkpoints: cps, extraction: ext, pret: true };
    log('INFO', 'geometrie', { salle: this.code, spawns: spawns.length, cps: cps.length, ext: !!ext });
    this.diffuserSalon();
  }

  /* Demande de lancement par l'hôte : on vérifie l'effectif puis on
     part sur un compte à rebours visible de tous.                      */
  lancer(j) {
    if (j.id !== this.hote || this.phase !== 'attente') return;
    const d = this.def();
    if (this.joueurs.size < d.min) {
      j.envoyer({ t: 'EVENT', type: 'refus', d: { txt: 'Il faut au moins ' + d.min + ' joueurs' } });
      return;
    }
    if (this.mode === 'course' && this.geo.checkpoints.length < 2) {
      j.envoyer({ t: 'EVENT', type: 'refus', d: { txt: 'Le circuit n’a pas encore été tracé' } });
      return;
    }
    this.phase = 'decompte';
    this.decompte = 5;
    this.diffuserSalon();
    this.annonce('La partie commence dans 5 secondes', '#f0c23a');
  }

  /* Répartition des équipes. En bataille : deux camps équilibrés si
     l'option est active. En police contre fugitifs : un tiers de police,
     au moins un et au plus trois.                                      */
  repartirEquipes() {
    const liste = [...this.joueurs.values()];
    if (this.mode === 'police') {
      const nPolice = clamp(Math.round(liste.length / 3), 1, 3);
      // ordre aléatoire pour que ce ne soit pas toujours les mêmes
      liste.sort(() => Math.random() - 0.5);
      liste.forEach((j, i) => {
        j.equipe = i < nPolice ? 1 : 2;             // 1 = police, 2 = fugitifs
        j.etoiles = j.equipe === 2 ? 5 : 0;
      });
    } else if (this.mode === 'bataille' && this.options.equipes) {
      liste.sort(() => Math.random() - 0.5);
      liste.forEach((j, i) => { j.equipe = (i % 2) + 1; });
    } else {
      liste.forEach(j => { j.equipe = 0; });
    }
  }

  demarrer() {
    this.phase = 'jeu';
    this.debut = Date.now();
    this.tempsRestant = this.def().duree;
    this.repartirEquipes();
    for (const j of this.joueurs.values()) {
      j.score = 0; j.kills = 0; j.morts = 0; j.tour = 0;
      // en course, la grille de départ est posée SUR la ligne : on la
      // considère déjà franchie, sinon le premier tour serait validé
      // avant même le feu vert.
      j.checkpoint = this.mode === 'course' ? 0 : -1;
      j.fini = false; j.tempsFin = 0; j.arrete = false; j.extrait = false;
      j.hp = 100; j.armor = 0; j.mort = false;
      /* Le portefeuille n'est qu'un miroir : le client affiche le sien,
         nous ne servons qu'à borner les variations annoncées. On repart
         donc de zéro, comme une partie neuve côté jeu.                 */
      j.argent = 0;
      j.etoiles = this.mode === 'police' && j.equipe === 2 ? 5 : 0;
      this.placer(j);
    }
    for (const j of this.joueurs.values()) this.envoyerInit(j);
    log('INFO', 'partie lancee', { salle: this.code, mode: this.mode, joueurs: this.joueurs.size });
    this.annonce('Partie lancée — ' + this.def().nom, '#7ae582');
  }

  /* Place un joueur sur un point d'apparition fourni par l'hôte.
     En course, les positions suivent l'ordre de la grille de départ.    */
  placer(j) {
    const S = this.geo.spawns;
    if (!S.length) { j.x = 2600; j.y = 2600; return; }
    let p;
    if (this.mode === 'course' && this.geo.checkpoints.length) {
      const c = this.geo.checkpoints[0];
      const n = [...this.joueurs.keys()].indexOf(j.id);
      // grille de départ : deux colonnes derrière la ligne
      p = { x: c.x + (n % 2 === 0 ? -36 : 36), y: c.y + 70 + Math.floor(n / 2) * 60 };
    } else if (this.mode === 'police' && j.equipe === 1 && S.length > 1) {
      p = S[S.length - 1];                    // la police part à l'écart
    } else {
      p = S[Math.floor(Math.random() * S.length)];
    }
    j.x = clamp(p.x, 40, TAILLE_MONDE - 40);
    j.y = clamp(p.y, 40, TAILLE_MONDE - 40);
    j.veh = null; j.nage = false; j.dedans = false;
    j.tDernierInput = Date.now();
    j.histo.length = 0;
    /* C'est NOUS qui venons de le déplacer : ses prochaines entrées
       porteront encore son ancienne position le temps que l'ordre lui
       parvienne. On suspend le contrôle de vitesse quelques instants
       pour ne pas sanctionner notre propre téléportation.             */
    j.grace = Date.now() + 2000;
  }

  envoyerInit(j) {
    j.envoyer({
      t: 'WORLD_INIT',
      protocole: PROTOCOLE,
      moi: j.id,
      code: this.code,
      mode: this.mode,
      modeNom: this.def().nom,
      seed: this.seed,
      options: this.options,
      feuAmi: this.feuAmi(),
      equipe: j.equipe,
      heure: this.tJour,
      meteo: this.meteo,
      duree: this.def().duree,
      tempsRestant: Math.round(this.tempsRestant),
      geo: { checkpoints: this.geo.checkpoints, extraction: this.geo.extraction },
      joueurs: [...this.joueurs.values()].map(p => p.fiche()),
      depart: { x: j.x, y: j.y }
    });
  }

  /* ---------------------------- SIMULATION --------------------------- */
  simuler(dt) {
    // --- compte à rebours avant le départ ---
    if (this.phase === 'decompte') {
      this.decompte -= dt;
      if (Math.ceil(this.decompte) !== this.dernierDecompte) {
        this.dernierDecompte = Math.ceil(this.decompte);
        this.diffuser({ t: 'EVENT', type: 'decompte', d: { n: Math.max(0, this.dernierDecompte) } });
      }
      if (this.decompte <= 0) this.demarrer();
      return;
    }
    if (this.phase !== 'jeu') return;

    // --- horloge du monde : un cycle de 480 s comme en solo ---
    this.tJour = (this.tJour + dt / 480) % 1;

    // --- météo : machine à états identique à celle du client ---
    if (!this.meteoFixe) {
      this.meteoReste -= dt;
      if (this.meteoReste <= 0) {
        const s = this.meteoSuite.shift();
        this.meteo = s.etat; this.meteoReste = s.duree;
        this.meteoSuite.push(this.tirerMeteo(this.meteo));
        this.diffuser({ t: 'EVENT', type: 'meteo', d: { etat: this.meteo } });
      }
    }

    // --- événements aléatoires, pour tout le monde en même temps ---
    if (this.mode === 'coop' || this.mode === 'course') {
      this.evtTimer -= dt;
      if (this.evtTimer <= 0) {
        this.evtTimer = alea(90, 220);
        this.declencherEvenement();
      }
      for (let i = this.evtActifs.length - 1; i >= 0; i--) {
        this.evtActifs[i].reste -= dt;
        if (this.evtActifs[i].reste <= 0) this.evtActifs.splice(i, 1);
      }
    }

    // --- réapparitions ---
    for (const j of this.joueurs.values()) {
      if (!j.mort) continue;
      j.respawnT -= dt;
      if (j.respawnT <= 0) this.reapparaitre(j);
    }

    // --- règles propres au mode ---
    this.reglesMode(dt);

    // --- chronomètre de manche ---
    if (this.def().duree > 0) {
      this.tempsRestant -= dt;
      if (this.tempsRestant <= 0) this.terminer('temps');
    }

    // --- diffusion de l'état ---
    this.tick++;
    this.diffuserTick();
  }

  declencherEvenement() {
    const e = pioche(EVENEMENTS);
    const S = this.geo.spawns;
    const p = S.length ? pioche(S) : { x: 2600, y: 2600 };
    const evt = {
      id: e.id, nom: e.nom,
      x: Math.round(p.x + alea(-700, 700)), y: Math.round(p.y + alea(-700, 700)),
      reste: alea(60, 120)
    };
    this.evtActifs.push(evt);
    this.diffuser({ t: 'EVENT', type: 'evenement', d: { id: e.id, nom: e.nom, txt: e.txt, x: evt.x, y: evt.y } });
    log('INFO', 'evenement', { salle: this.code, id: e.id });
  }

  reapparaitre(j) {
    this.placer(j);
    j.mort = false; j.hp = 100; j.armor = 0;
    j.arme = 'fists';                      // équipement de base au retour
    j.etoiles = this.mode === 'police' && j.equipe === 2 ? 5 : 0;
    j.envoyer({ t: 'EVENT', type: 'respawn', d: { x: j.x, y: j.y, hp: j.hp } });
    this.diffuser({ t: 'EVENT', type: 'retour', d: { id: j.id, pseudo: j.pseudo } }, j.id);
  }

  /* ------------------------- règles par mode ------------------------- */
  reglesMode(dt) {
    if (this.mode === 'police') {
      // la police arrête un fugitif en restant à portée assez longtemps
      const police = [...this.joueurs.values()].filter(j => j.equipe === 1 && !j.mort);
      const fugitifs = [...this.joueurs.values()].filter(j => j.equipe === 2);
      for (const f of fugitifs) {
        if (f.arrete || f.extrait || f.mort) continue;
        const proche = police.some(p => !p.veh && !f.veh &&
          (p.x - f.x) * (p.x - f.x) + (p.y - f.y) * (p.y - f.y) < 90 * 90);
        f.arrestT = proche ? (f.arrestT || 0) + dt : Math.max(0, (f.arrestT || 0) - dt * 0.6);
        if (f.arrestT > 2.2) {
          f.arrete = true; f.arrestT = 0;
          this.diffuser({ t: 'EVENT', type: 'arrestation', d: { id: f.id, pseudo: f.pseudo } });
          this.annonce(f.pseudo + ' a été arrêté', '#ff6b6b');
          for (const p of police) { p.score += 300; }
        }
        // extraction : atteindre le point et y rester une seconde
        const E = this.geo.extraction;
        if (E && !f.veh) {
          const d2 = (E.x - f.x) * (E.x - f.x) + (E.y - f.y) * (E.y - f.y);
          if (d2 < E.r * E.r) {
            f.extracT = (f.extracT || 0) + dt;
            if (f.extracT > 1) {
              f.extrait = true; f.score += 1000;
              this.diffuser({ t: 'EVENT', type: 'extraction', d: { id: f.id, pseudo: f.pseudo } });
              this.annonce(f.pseudo + ' a atteint le point d’extraction !', '#7ae582');
            }
          } else f.extracT = 0;
        }
      }
      const restants = fugitifs.filter(f => !f.arrete && !f.extrait);
      if (fugitifs.length && !restants.length) {
        this.terminer(fugitifs.some(f => f.extrait) ? 'fugitifs' : 'police');
      }
      return;
    }

    if (this.mode === 'course') {
      const C = this.geo.checkpoints;
      if (!C.length) return;
      const tours = clamp(nombre(this.options.tours, 2), 1, 9);
      for (const j of this.joueurs.values()) {
        if (j.fini || j.mort) continue;
        const suiv = (j.checkpoint + 1) % C.length;
        const c = C[suiv];
        const d2 = (c.x - j.x) * (c.x - j.x) + (c.y - j.y) * (c.y - j.y);
        if (d2 < c.r * c.r) {
          j.checkpoint = suiv;
          j.score += 50;
          if (suiv === 0) {
            j.tour++;
            this.diffuser({ t: 'EVENT', type: 'tour', d: { id: j.id, pseudo: j.pseudo, tour: j.tour, total: tours } });
            if (j.tour >= tours) {
              j.fini = true;
              j.tempsFin = (Date.now() - this.debut) / 1000;
              const place = [...this.joueurs.values()].filter(p => p.fini).length;
              j.score += Math.max(200, 1600 - place * 300);
              this.annonce(j.pseudo + ' franchit la ligne en position ' + place, j.couleur);
            }
          } else {
            j.envoyer({ t: 'EVENT', type: 'checkpoint', d: { n: suiv, total: C.length } });
          }
        }
      }
      const actifs = [...this.joueurs.values()];
      if (actifs.length && actifs.every(j => j.fini)) this.terminer('course');
      return;
    }
    // coop et bataille : rien de particulier chaque tick, tout passe par
    // les événements (morts, argent, étoiles) validés à la réception.
  }

  terminer(raison) {
    if (this.phase === 'fin') return;
    this.phase = 'fin';
    const classement = this.classement();
    this.diffuser({ t: 'FIN', raison, classement });
    this.annonce('Partie terminée (' + raison + ')', '#f0c23a');
    log('INFO', 'partie terminee', { salle: this.code, raison, classement: classement.slice(0, 3) });
    db.enregistrerPartie({
      code: this.code, mode: this.mode, seed: this.seed, raison,
      duree: Math.round((Date.now() - this.debut) / 1000),
      classement
    }).catch(e => log('ERR', 'db partie', e.message));
    // la salle retourne en salon d'attente au bout de 20 secondes
    setTimeout(() => {
      if (!HUB.salles.has(this.code)) return;
      this.phase = 'attente';
      for (const j of this.joueurs.values()) j.pret = false;
      this.diffuserSalon();
    }, 20000);
  }

  classement() {
    const l = [...this.joueurs.values()];
    if (this.mode === 'course') {
      l.sort((a, b) => (b.tour - a.tour) || (b.checkpoint - a.checkpoint) ||
        ((a.tempsFin || 1e9) - (b.tempsFin || 1e9)));
    } else {
      l.sort((a, b) => b.score - a.score || b.kills - a.kills);
    }
    return l.map((j, i) => ({
      place: i + 1, pseudo: j.pseudo, couleur: j.couleur, equipe: j.equipe,
      score: j.score, kills: j.kills, morts: j.morts,
      tour: j.tour, tempsFin: j.tempsFin ? Math.round(j.tempsFin * 10) / 10 : 0,
      extrait: j.extrait, arrete: j.arrete
    }));
  }

  /* Diffusion : état complet pour les joueurs proches, cadence réduite
     pour les lointains. À 16 joueurs cela divise le débit par trois.    */
  diffuserTick() {
    const tous = [...this.joueurs.values()];
    const complet = this.tick % 4 === 0;      // une image complète sur quatre
    /* Pour chaque joueur on prépare deux versions : l'état complet, et le
       delta — uniquement les champs qui ont bougé depuis la diffusion
       précédente. Un joueur immobile ne coûte alors que son identifiant.
       L'image complète périodique empêche tout décalage de s'installer. */
    const instantanes = new Map();
    for (const j of tous) {
      const s = j.instantane();
      let d;
      if (complet || !j.dernierEnvoi) d = s;
      else {
        d = { i: s.i };
        for (const k in s) if (s[k] !== j.dernierEnvoi[k]) d[k] = s[k];
      }
      j.dernierEnvoi = s;
      instantanes.set(j.id, { plein: s, delta: d });
    }
    const base = {
      t: 'TICK', n: this.tick,
      heure: Math.round(this.tJour * 10000) / 10000,
      reste: this.def().duree > 0 ? Math.round(this.tempsRestant) : 0
    };
    for (const j of tous) {
      const proches = [];
      for (const a of tous) {
        if (a.id === j.id) continue;
        const loin = (a.x - j.x) * (a.x - j.x) + (a.y - j.y) * (a.y - j.y) > 2200 * 2200;
        if (loin && !complet) continue;      // les lointains : un tick sur quatre
        const s = instantanes.get(a.id);
        proches.push(loin
          ? { i: s.plein.i, x: s.plein.x, y: s.plein.y, a: s.plein.a, d: s.plein.d, v: s.plein.v, e: s.plein.e, loin: 1 }
          : s.delta);
      }
      // notre propre position reste toujours complète : c'est elle qui sert
      // de référence à la réconciliation côté client
      const msg = Object.assign({}, base, { joueurs: proches, moi: instantanes.get(j.id).plein });
      if (complet) {
        msg.scores = tous.map(a => ({
          i: a.id, s: a.score, k: a.kills, m: a.morts,
          tr: a.tour, cp: a.checkpoint, f: a.fini ? 1 : 0,
          ar: a.arrete ? 1 : 0, ex: a.extrait ? 1 : 0
        }));
        if (this.evtActifs.length) msg.evenements = this.evtActifs.map(e => ({ id: e.id, x: e.x, y: e.y }));
      }
      j.envoyer(msg);
    }
  }

  /* --------------------- réception des messages ---------------------- */
  /* Entrée de mouvement. Le client bouge chez lui et nous dit où il est ;
     nous vérifions que c'est atteignable, sinon nous le corrigeons.     */
  input(j, m) {
    if (this.phase !== 'jeu' || j.mort) return;
    const seq = nombre(m.seq, 0);
    if (seq <= j.seq) return;                      // paquet en retard ou rejoué
    const x = nombre(m.x, j.x), y = nombre(m.y, j.y);
    if (x < 0 || y < 0 || x > TAILLE_MONDE || y > TAILLE_MONDE) {
      this.corriger(j, 'hors du monde');
      return;
    }
    const t = Date.now();
    const dt = clamp((t - (j.tDernierInput || t)) / 1000, 0.016, 0.6);
    j.tDernierInput = t;
    j.seq = seq;
    // moyen de locomotion déclaré : il décide de la vitesse permise
    j.nage = !!m.nage;
    j.dedans = !!m.dedans;
    const vmax = j.vitesseMax();
    const permis = vmax * dt * MARGE_V + MARGE_PX;
    const parcouru = Math.hypot(x - j.x, y - j.y);
    // fenêtre de grâce ouverte par un placement du serveur lui-même
    if (j.grace && t < j.grace) {
      if (parcouru > permis) { j.x = x; j.y = y; j.ang = nombre(m.a, j.ang); j.aim = nombre(m.m, j.aim); return; }
      j.grace = 0;
    }
    // un joueur à l'intérieur d'un bâtiment est hors du monde partagé :
    // on gèle sa position au pas de porte plutôt que de la contrôler
    if (j.dedans) { j.ang = nombre(m.a, j.ang); j.aim = nombre(m.m, j.aim); return; }
    if (parcouru > permis) {
      j.suspects++;
      log('WARN', 'position rejetee', {
        salle: this.code, id: j.id, pseudo: j.pseudo,
        parcouru: Math.round(parcouru), permis: Math.round(permis), veh: j.veh && j.veh.kind
      });
      this.corriger(j, 'vitesse impossible');
      if (j.suspects > LIM.suspectsMax) j.expulser('Trop de positions invalides');
      return;
    }
    j.x = x; j.y = y;
    j.histo.push({ t, x, y });
    while (j.histo.length && t - j.histo[0].t > FENETRE_HISTO) j.histo.shift();
    j.ang = nombre(m.a, j.ang);
    j.aim = nombre(m.m, j.aim);
    if (typeof m.w === 'string' && ARMES[m.w]) j.arme = m.w;
    // points de vie : le client subit aussi des dégâts hors réseau
    // (chute, noyade, police locale). On accepte la baisse, on borne la
    // hausse à un soin plausible.
    const hp = clamp(nombre(m.hp, j.hp), 0, j.maxHp);
    if (hp <= j.hp) j.hp = hp;
    else j.hp = Math.min(j.hp + 40 * dt + 1, hp);
    if (j.hp <= 0 && !j.mort) this.tuer(j, null, 'blessures');
  }
  corriger(j, raison) {
    j.envoyer({ t: 'CORRECTION', x: j.x, y: j.y, raison });
  }

  /* Tir : simple diffusion visuelle (traceur, lueur). Les dégâts, eux,
     passent par TOUCHE et sont validés séparément.                     */
  tir(j, m) {
    if (this.phase !== 'jeu' || j.mort) return;
    const arme = typeof m.arme === 'string' && ARMES[m.arme] ? m.arme : 'fists';
    const t = Date.now();
    const cadence = ARMES[arme].rate * 1000 * 0.7;    // 30 % de marge de latence
    if (t - j.tirT < cadence) return;                 // cadence impossible : on ignore
    j.tirT = t;
    j.arme = arme;
    this.diffuser({
      t: 'EVENT', type: 'tir',
      d: { id: j.id, x: Math.round(j.x), y: Math.round(j.y), a: Math.round(nombre(m.angle, j.aim) * 100) / 100, arme }
    }, j.id);
  }

  /* Dégâts infligés à un autre joueur. Le tireur fait la détection chez
     lui (il est le seul à connaître les murs), le serveur vérifie que
     l'arme, la distance et les dégâts sont possibles, puis applique.    */
  touche(j, m) {
    if (this.phase !== 'jeu' || j.mort) return;
    const cible = this.joueurs.get(m.cible);
    if (!cible || cible.mort || cible.id === j.id) return;
    const arme = typeof m.arme === 'string' && ARMES[m.arme] ? m.arme : null;
    if (!arme) return;
    // feu ami
    if (!this.feuAmi() && cible.equipe && cible.equipe === j.equipe) return;
    const A = ARMES[arme];
    /* Portée vérifiée sur l'historique récent de la cible : le tireur a
       visé ce qu'il voyait, c'est-à-dire une position vieille d'un
       aller-retour réseau. La marge reste donc serrée — il n'est plus
       question de compenser la latence par un gros forfait en pixels.  */
    const d = this.distanceCompensee(j, cible);
    if (d > A.portee * 1.15 + 30) {
      log('WARN', 'touche hors portee', { salle: this.code, id: j.id, pseudo: j.pseudo, arme, d: Math.round(d) });
      return;
    }
    const degats = clamp(nombre(m.degats, A.dmg), 0, A.dmg * 1.1);
    /* Débit de dégâts. Valider chaque coup séparément ne suffit pas :
       rien n'empêcherait d'annoncer cent coups de pistolet par seconde.
       L'arme la plus rapide du jeu (la mitraillette) plafonne vers
       120 dégâts par seconde ; on laisse le double pour la rafale et la
       latence, et on refuse au-delà.                                   */
    const t = Date.now();
    if (t - j.dmgT > 1000) { j.dmgT = t; j.dmgCumul = 0; }
    if (j.dmgCumul + degats > 240) {
      log('WARN', 'debit de degats rejete', {
        salle: this.code, id: j.id, pseudo: j.pseudo, arme, cumul: Math.round(j.dmgCumul)
      });
      j.suspects++;
      if (j.suspects > LIM.suspectsMax) j.expulser('Débit de dégâts impossible');
      return;
    }
    j.dmgCumul += degats;
    this.blesser(cible, degats, j, arme);
  }

  /* Plus courte distance entre le tireur (position actuelle) et la cible
     sur toute la fenêtre d'historique, position actuelle comprise.     */
  distanceCompensee(tireur, cible) {
    let min = Math.hypot(cible.x - tireur.x, cible.y - tireur.y);
    for (const p of cible.histo) {
      const d = Math.hypot(p.x - tireur.x, p.y - tireur.y);
      if (d < min) min = d;
    }
    return min;
  }

  blesser(cible, degats, par, cause) {
    if (cible.armor > 0) {
      const a = Math.min(cible.armor, degats * 0.65);
      cible.armor -= a; degats -= a;
    }
    cible.hp = Math.max(0, cible.hp - degats);
    cible.envoyer({ t: 'EVENT', type: 'degats', d: { hp: cible.hp, armor: Math.round(cible.armor), par: par ? par.id : null, cause } });
    if (cible.hp <= 0) this.tuer(cible, par, cause);
  }

  tuer(victime, tueur, cause) {
    if (victime.mort) return;
    victime.mort = true;
    victime.morts++;
    victime.hp = 0;
    victime.respawnT = this.mode === 'bataille' ? 6 : 8;
    victime.veh = null;
    if (tueur && tueur !== victime) {
      tueur.kills++;
      tueur.score += this.mode === 'bataille' ? 500 : 250;
      // tuer un joueur alerte la police : le barème du solo s'applique
      tueur.etoiles = clamp(tueur.etoiles + 2, 0, 5);
      this.annonce(tueur.pseudo + ' a éliminé ' + victime.pseudo, tueur.couleur);
    } else {
      this.annonce(victime.pseudo + ' est mort (' + (cause || 'blessures') + ')', '#7a8ea6');
    }
    this.diffuser({
      t: 'EVENT', type: 'mort',
      d: { id: victime.id, pseudo: victime.pseudo, par: tueur ? tueur.id : null, cause: cause || 'blessures', delai: victime.respawnT }
    });
    log('INFO', 'mort', { salle: this.code, victime: victime.pseudo, par: tueur ? tueur.pseudo : null, cause });
    if (this.mode === 'police' && victime.equipe === 2) {
      victime.arrete = true;                 // un fugitif mort est hors course
      this.reglesMode(0);
    }
  }

  /* Interaction sur une entité partagée : un véhicule occupé est
     verrouillé, premier arrivé premier servi.                          */
  interagir(j, m) {
    if (this.phase !== 'jeu' || j.mort) return;
    const type = propre(m.type, 20);
    const id = propre(String(m.cible === undefined ? '' : m.cible), 40);
    if (type === 'monter') {
      const pris = this.vehicules.get(id);
      if (pris && pris.par !== j.id) {
        j.envoyer({ t: 'EVENT', type: 'refus', d: { txt: 'Véhicule déjà occupé' } });
        return;
      }
      // rayon d'interaction vérifié côté serveur
      const px = nombre(m.x, j.x), py = nombre(m.y, j.y);
      if (Math.hypot(px - j.x, py - j.y) > 160) {
        log('WARN', 'interaction hors portee', { salle: this.code, id: j.id, type });
        return;
      }
      const kind = propre(m.kind, 16) || 'civil';
      this.vehicules.set(id, { par: j.id, kind, x: px, y: py, t: Date.now() });
      j.veh = { id, kind };
      this.diffuser({ t: 'EVENT', type: 'monte', d: { id: j.id, veh: id, kind } }, j.id);
    } else if (type === 'descendre') {
      if (j.veh) {
        this.vehicules.delete(j.veh.id);
        this.diffuser({ t: 'EVENT', type: 'descend', d: { id: j.id, veh: j.veh.id } }, j.id);
        j.veh = null;
      }
    } else if (type === 'etoiles') {
      // le client calcule sa recherche policière locale ; on la borne
      j.etoiles = clamp(Math.round(nombre(m.cible, 0)), 0, 5);
    } else if (type === 'argent') {
      // gain d'argent déclaré : borné à 6000 par tranche de 10 secondes
      const t = Date.now();
      if (t - j.gainT > 10000) { j.gainT = t; j.gainCumul = 0; }
      const gain = clamp(nombre(m.montant, 0), -100000, 6000);
      if (gain > 0 && j.gainCumul + gain > 6000) {
        log('WARN', 'gain rejete', { salle: this.code, id: j.id, pseudo: j.pseudo, gain });
        return;
      }
      j.gainCumul += Math.max(0, gain);
      j.argent = clamp(j.argent + gain, 0, 99999999);
      if (gain > 0) j.score += Math.round(gain / 10);
    }
  }

  chat(j, m) {
    const t = Date.now();
    if (t - j.chatT > 1000) { j.chatT = t; j.chatN = 0; }
    if (++j.chatN > LIM.chatParSec) {
      // anti-spam. On le dit à l'expéditeur : un message avalé sans
      // explication donne l'impression que le chat est cassé.
      if (j.chatN === LIM.chatParSec + 1)
        j.envoyer({ t: 'CHAT', pseudo: '', texte: 'Doucement : deux messages par seconde au maximum', couleur: '#ff9f43', canal: 'systeme' });
      return;
    }
    let texte = propre(m.texte, LIM.chatLong);
    if (!texte) return;
    let canal = m.canal === 'equipe' ? 'equipe' : m.canal === 'prive' ? 'prive' : 'tous';
    if (this.options.filtre) texte = filtrer(texte);
    const paquet = { t: 'CHAT', pseudo: j.pseudo, texte, couleur: j.couleur, canal };
    if (canal === 'prive') {
      const dest = [...this.joueurs.values()].find(p => p.pseudo.toLowerCase() === propre(m.vers, LIM.pseudoLong).toLowerCase());
      if (!dest) { j.envoyer({ t: 'CHAT', pseudo: '', texte: 'Destinataire introuvable', couleur: '#ff6b6b', canal: 'systeme' }); return; }
      paquet.vers = dest.pseudo;
      dest.envoyer(paquet); j.envoyer(paquet);
    } else if (canal === 'equipe' && j.equipe) {
      for (const p of this.joueurs.values()) if (p.equipe === j.equipe) p.envoyer(paquet);
    } else {
      this.diffuser(paquet);
    }
  }

  /* L'hôte modifie les options du salon. */
  majOptions(j, m) {
    if (j.id !== this.hote || this.phase !== 'attente') return;
    const o = m.options || {};
    if (o.feuAmi !== undefined) this.options.feuAmi = !!o.feuAmi;
    if (o.equipes !== undefined) this.options.equipes = !!o.equipes;
    if (o.filtre !== undefined) this.options.filtre = !!o.filtre;
    if (o.trafic !== undefined) this.options.trafic = !!o.trafic;
    if (o.policeDiff !== undefined) this.options.policeDiff = clamp(nombre(o.policeDiff, 1), 0, 2);
    if (o.tours !== undefined) this.options.tours = clamp(Math.round(nombre(o.tours, 2)), 1, 9);
    // options des modes battle et course poursuite
    if (o.manches !== undefined) this.options.manches = parmi(o.manches, [3, 5, 7], this.options.manches);
    if (o.dureeManche !== undefined) this.options.dureeManche = parmi(o.dureeManche, [90, 120, 180], this.options.dureeManche);
    if (o.legendaires !== undefined) this.options.legendaires = !!o.legendaires;
    if (o.dureeMax !== undefined) this.options.dureeMax = parmi(o.dureeMax, [480, 600, 900], this.options.dureeMax);
    if (o.avance !== undefined) this.options.avance = parmi(o.avance, [20, 30, 45], this.options.avance);
    if (o.majMinimap !== undefined) this.options.majMinimap = parmi(o.majMinimap, [10, 15, 30], this.options.majMinimap);
    if (o.variante !== undefined)
      this.options.variante = typeof o.variante === 'string' && EXTRACTIONS.some(e => e.id === o.variante) ? o.variante : '';
    if (o.meteoFixe !== undefined) {
      this.options.meteoFixe = typeof o.meteoFixe === 'string' && METEO_SUITES[o.meteoFixe] ? o.meteoFixe : '';
      this.meteoFixe = !!this.options.meteoFixe;
      if (this.meteoFixe) this.meteo = this.options.meteoFixe;
    }
    this.diffuserSalon();
  }

  expulserJoueur(j, m) {
    if (j.id !== this.hote) return;
    const cible = this.joueurs.get(propre(String(m.id || ''), 40));
    if (!cible || cible.id === j.id) return;
    cible.expulser('Expulsé par l’hôte de la salle');
  }
}

/* =======================================================================
   MODES BATTLE ET COURSE POURSUITE
   -----------------------------------------------------------------------
   Deux modes ajoutés sans toucher au reste du serveur : tout passe par
   de nouvelles méthodes et par l'encapsulation des anciennes
   (`const _x = Salle.prototype.m; Salle.prototype.m = function(){…}`).

   Partage des responsabilités, inchangé : le serveur arbitre les joueurs
   (manches, camps, armes ramassées, traque, extraction, scores) ; la
   géométrie du décor — enceinte de l'arène, bases, emplacements d'armes,
   points d'extraction, barrages, raccourcis — vient du client hôte, seul
   à connaître la carte tirée de la graine.

   RÈGLE DE CAMP : le choix d'un camp n'existe QUE dans le mode
   « poursuite », et seulement dans le salon d'attente de cette salle. Il
   n'est lié ni au compte, ni au pseudo, ni à une autre partie : chaque
   salle repart d'une ardoise vierge. Les autres modes continuent de
   répartir les équipes eux-mêmes (battle, bataille, police) ou de s'en
   passer (coop, course).
   ======================================================================= */

/* ------------------------- armes supplémentaires ---------------------- */
/* Miroir de la table du client : le serveur n'en a besoin que pour
   valider dégâts, cadence et portée.                                   */
Object.assign(ARMES, {
  knife: { dmg: 26, rate: 0.45, portee: 62 },
  silenced: { dmg: 17, rate: 0.33, portee: 540 },
  assault: { dmg: 22, rate: 0.14, portee: 660 },
  sniper: { dmg: 85, rate: 1.30, portee: 1500 },
  glauncher: { dmg: 70, rate: 1.10, portee: 640 },
  lmg: { dmg: 14, rate: 0.07, portee: 580 },
  grenade: { dmg: 70, rate: 1.00, portee: 430 }
});

/* Raretés du mode battle. Les proportions sont celles demandées :
   60 % commune, 30 % rare, 10 % légendaire.                            */
const BATTLE_RARETES = {
  commune: { col: '#c6d8ee', armes: ['pistol', 'shotgun', 'knife', 'grenade'] },
  rare: { col: '#58c4ff', armes: ['smg', 'assault', 'silenced'] },
  legendaire: { col: '#ffd45e', armes: ['sniper', 'glauncher', 'lmg'] }
};
/* Munitions offertes avec l'arme ramassée. */
const BATTLE_MUNITIONS = {
  knife: 0, pistol: 48, shotgun: 24, grenade: 3, smg: 120,
  assault: 90, silenced: 40, sniper: 12, glauncher: 6, lmg: 200
};
/* Formats de salle : un libellé, un effectif. */
const BATTLE_FORMATS = { '2v2': 4, '3v3': 6, '4v4': 8, '5v5': 10 };
const POURSUITE_FORMATS = { '2v2': 4, '3v3': 6, '4v4': 8 };

/* Variantes de zone d'extraction de la course poursuite. */
const EXTRACTIONS = [
  { id: 'fixe', nom: 'Point fixe', txt: 'Un seul cercle d’extraction, immobile.' },
  { id: 'mobile', nom: 'Point mobile', txt: 'La zone se déplace : les deux camps voient sa trajectoire.' },
  { id: 'multi', nom: 'Multi-points', txt: 'Trois zones : une seule suffit aux Fugitifs.' },
  { id: 'minutee', nom: 'Extraction minutée', txt: 'La zone n’apparaît qu’au bout de quatre minutes.' },
  { id: 'conditions', nom: 'Extraction sous conditions', txt: 'Verrouillée jusqu’à la récupération d’une caisse spéciale.' }
];

/* Titres honorifiques, valables 24 h, partagés par tout le serveur.
   Volontairement en mémoire : ils ne valent pas une base de données, et
   un redémarrage les efface sans conséquence.                          */
const TITRES = new Map();            // pseudo → { titre, expire }
function donnerTitre(pseudo, titre) {
  if (!pseudo || !titre) return;
  TITRES.set(pseudo, { titre, expire: Date.now() + 86400000 });
}
function titreDe(pseudo) {
  const t = TITRES.get(pseudo);
  if (!t) return '';
  if (t.expire < Date.now()) { TITRES.delete(pseudo); return ''; }
  return t.titre;
}

/* Deux nouveaux modes. `duree: 0` pour battle : ce ne sont pas les
   minutes qui comptent mais les manches.                               */
Object.assign(MODES, {
  battle: {
    nom: 'BATTLE — Affrontement par manches', min: 2, max: 10, duree: 0,
    equipes: true, feuAmi: false, etoilesDepart: 0, manches: true,
    desc: 'Carte dédiée et dense, armes aléatoires à chaque manche, équipes formées par le serveur.'
  },
  poursuite: {
    nom: 'COURSE POURSUITE — Traque', min: 2, max: 8, duree: 600,
    equipes: true, feuAmi: true, etoilesDepart: 0, camps: true,
    desc: 'Les Fugitifs rejoignent l’extraction, les Chasseurs les éliminent. Camp choisi dans ce salon.'
  }
});

/* Noms de camps, utilisés dans les annonces du serveur. */
const NOMS_CAMPS = {
  battle: { 1: 'ROUGE', 2: 'BLEUE' },
  poursuite: { 1: 'FUGITIFS', 2: 'CHASSEURS' }
};
const nomCamp = (mode, e) => (NOMS_CAMPS[mode] && NOMS_CAMPS[mode][e]) || ('ÉQUIPE ' + e);

/* ======================= état ajouté aux joueurs =====================
   Rien n'est retiré : les champs sont posés à la demande, si bien qu'un
   joueur connecté avant ce module reste parfaitement valide.
   ===================================================================== */
function etatModes(j) {
  if (j.etatModes) return j;
  j.etatModes = true;
  j.camp = 0;                  // camp CHOISI (poursuite uniquement), 0 = indécis
  j.elimine = false;           // sorti de la manche / de la partie
  j.inventaire = ['knife'];    // armes réellement possédées
  j.bouclier = 0;              // horodatage de fin d'invulnérabilité
  j.mancheKills = 0; j.mancheMorts = 0; j.mancheDegats = 0;
  j.mancheArmes = {};          // arme → coups tirés dans la manche
  j.mvp = 0;                   // manches remportées comme MVP
  j.soinT = 0;                 // minuteur du point de soin de base
  j.coffrePris = false;        // coffre de base déjà ouvert cette manche
  j.vuX = 0; j.vuY = 0; j.vuT = 0;   // dernière position connue des Chasseurs
  j.verrou = 0;                // fin du verrou de traque (ms)
  j.verrouT = 0;               // temps passé dans le rayon de traque
  j.extracT = 0;               // temps passé dans la zone d'extraction
  j.dernierExtrac = -1;
  j.renfortT = 0;              // minuteur du renfort mécanique
  return j;
}

/* =========================== SALLE : ajouts ========================== */

/* Les deux nouveaux modes ont besoin d'une géométrie plus riche que les
   trois listes d'origine. On accepte des champs supplémentaires sans
   rien exiger : une version antérieure du client reste compatible.      */
const _geoBase = Salle.prototype.recevoirGeometrie;
Salle.prototype.recevoirGeometrie = function (j, m) {
  _geoBase.call(this, j, m);
  if (j.id !== this.hote) return;
  const pt = p => p && isFinite(p.x) && isFinite(p.y) &&
    p.x >= 0 && p.x <= TAILLE_MONDE && p.y >= 0 && p.y <= TAILLE_MONDE;
  const liste = (t, n) => Array.isArray(t) ? t.filter(pt).slice(0, n).map(p => {
    const o = { x: Math.round(p.x), y: Math.round(p.y) };
    if (typeof p.nom === 'string') o.nom = propre(p.nom, 24);
    if (p.r !== undefined) o.r = clamp(nombre(p.r, 120), 40, 600);
    return o;
  }) : [];

  /* --- enceinte de l'arène du mode battle --- */
  const a = m.arene;
  if (a && pt(a.centre) && Array.isArray(a.bases) && a.bases.length === 2) {
    const r = a.rect || {};
    const rect = {
      x: clamp(nombre(r.x, 0), 0, TAILLE_MONDE), y: clamp(nombre(r.y, 0), 0, TAILLE_MONDE),
      w: clamp(nombre(r.w, 1500), 600, 4000), h: clamp(nombre(r.h, 1500), 600, 4000)
    };
    const bases = a.bases.filter(pt).map((b, i) => ({
      equipe: i + 1, x: Math.round(b.x), y: Math.round(b.y),
      r: clamp(nombre(b.r, 150), 80, 400),
      coffre: pt(b.coffre) ? { x: Math.round(b.coffre.x), y: Math.round(b.coffre.y) }
        : { x: Math.round(b.x), y: Math.round(b.y) },
      soin: pt(b.soin) ? { x: Math.round(b.soin.x), y: Math.round(b.soin.y) }
        : { x: Math.round(b.x), y: Math.round(b.y) }
    }));
    const zones = liste(a.zones, 90);
    if (bases.length === 2 && zones.length >= 15) {
      this.arene = { rect, bases, zones, centre: { x: Math.round(a.centre.x), y: Math.round(a.centre.y) } };
      log('INFO', 'arene recue', { salle: this.code, zones: zones.length });
      this.diffuserSalon();
    }
  }

  /* --- décor de la course poursuite --- */
  const extras = {};
  if (Array.isArray(m.extractions)) extras.extractions = liste(m.extractions, 8);
  if (Array.isArray(m.barrages)) extras.barrages = liste(m.barrages, 24);
  if (Array.isArray(m.raccourcis)) extras.raccourcis = liste(m.raccourcis, 24);
  if (Array.isArray(m.caisses)) extras.caisses = liste(m.caisses, 24);
  if (Array.isArray(m.departs)) extras.departs = liste(m.departs, 12);
  if (Object.keys(extras).length) {
    this.traque = Object.assign(this.traque || {}, extras);
  }
};

/* Le camp : unique endroit du protocole où un joueur choisit son côté,
   et seulement dans une salle de course poursuite en attente.          */
Salle.prototype.choisirCamp = function (j, m) {
  if (!this.def().camps) {
    j.envoyer({ t: 'EVENT', type: 'refus', d: { txt: 'Ce mode ne propose pas de choix de camp' } });
    return;
  }
  if (this.phase !== 'attente') return;
  etatModes(j);
  const c = Math.round(nombre(m.camp, 0));
  if (c !== 1 && c !== 2) return;
  if (j.camp === c) return;
  j.camp = c;
  j.equipe = c;                 // visible tout de suite dans le salon
  this.diffuserSalon();
  this.annonce(j.pseudo + ' rejoint les ' + nomCamp('poursuite', c), c === 1 ? '#ff9f43' : '#c08aff');
  if (!this.equilibreOk() && this.effectifs()[0] === 0) {
    const n = this.effectifs();
    if (Math.abs(n[1] - n[2]) > 1)
      this.annonce('Camps déséquilibrés (' + n[1] + ' – ' + n[2] +
        ') : il faut des volontaires pour changer de côté avant le lancement.', '#ff9f43');
  }
};

/* Effectifs par camp, pour le compteur du salon et l'équilibre. */
Salle.prototype.effectifs = function () {
  const n = { 0: 0, 1: 0, 2: 0 };
  for (const j of this.joueurs.values()) n[etatModes(j).camp || 0]++;
  return n;
};

/* Les camps sont-ils jouables ? Deux camps non vides, écart d'un joueur
   au maximum, et plus personne d'indécis.                              */
Salle.prototype.equilibreOk = function () {
  const n = this.effectifs();
  if (n[0] > 0) return false;
  if (!n[1] || !n[2]) return false;
  return Math.abs(n[1] - n[2]) <= 1;
};

/* ------------------------- salon d'attente --------------------------- */
const _salonBase = Salle.prototype.etatSalon;
Salle.prototype.etatSalon = function () {
  const s = _salonBase.call(this);
  if (this.def().camps) {
    const n = this.effectifs();
    s.camps = { 1: n[1], 2: n[2], indecis: n[0] };
    s.equilibre = this.equilibreOk();
  }
  if (this.def().manches) {
    s.arenePrete = !!this.arene;
    s.manchesGagnees = this.manchesGagnees || { 1: 0, 2: 0 };
  }
  s.titres = {};
  for (const j of this.joueurs.values()) {
    const t = titreDe(j.pseudo);
    if (t) s.titres[j.id] = t;
  }
  return s;
};

/* Le camp choisi voyage dans la fiche du joueur. */
const _ficheBase = Joueur.prototype.fiche;
Joueur.prototype.fiche = function () {
  const f = _ficheBase.call(this);
  f.camp = this.camp || 0;
  f.elimine = !!this.elimine;
  f.titre = titreDe(this.pseudo);
  return f;
};

/* --------------------------- lancement ------------------------------- */
const _lancerBase = Salle.prototype.lancer;
Salle.prototype.lancer = function (j) {
  if (j.id !== this.hote || this.phase !== 'attente') return;
  if (this.mode === 'battle' && !this.arene) {
    j.envoyer({ t: 'EVENT', type: 'refus', d: { txt: 'L’arène n’a pas encore été tracée par l’hôte' } });
    return;
  }
  if (this.mode === 'poursuite' && !this.equilibreOk()) {
    const n = this.effectifs();
    const txt = n[0] ? (n[0] + ' joueur(s) encore sans camp')
      : (!n[1] || !n[2]) ? 'Il faut au moins un joueur dans chaque camp'
        : 'Écart de plus d’un joueur entre les camps';
    j.envoyer({ t: 'EVENT', type: 'refus', d: { txt } });
    this.annonce('Lancement refusé : ' + txt + '. Des volontaires pour changer de côté ?', '#ff9f43');
    return;
  }
  _lancerBase.call(this, j);
};

/* ------------------------ répartition des camps ---------------------- */
const _equipesBase = Salle.prototype.repartirEquipes;
Salle.prototype.repartirEquipes = function () {
  const liste = [...this.joueurs.values()].map(etatModes);
  if (this.mode === 'battle') {
    /* Équilibrage par nombre de joueurs : personne ne choisit son camp,
       on alterne dans un ordre tiré au hasard.                         */
    liste.sort(() => Math.random() - 0.5);
    liste.forEach((p, i) => { p.equipe = (i % 2) + 1; p.camp = 0; });
    return;
  }
  if (this.mode === 'poursuite') {
    /* Le camp vient du salon. Un arrivant de dernière minute sans camp
       est versé au camp le moins fourni.                               */
    const n = { 1: 0, 2: 0 };
    for (const p of liste) if (p.camp) n[p.camp]++;
    for (const p of liste) {
      if (!p.camp) { p.camp = n[1] <= n[2] ? 1 : 2; n[p.camp]++; }
      p.equipe = p.camp;
    }
    return;
  }
  _equipesBase.call(this);
};

/* ---------------------------- démarrage ------------------------------ */
const _demarrerBase = Salle.prototype.demarrer;
Salle.prototype.demarrer = function () {
  const O = this.options;
  if (this.mode === 'battle') {
    this.manche = 0;
    this.manchesGagnees = { 1: 0, 2: 0 };
    this.manchePhase = 'attente';
    this.mancheT = 0;
    this.armesSol = [];
    this.armesPrec = '';
    this.dernierResultat = null;
  }
  if (this.mode === 'poursuite') {
    this.avanceReste = clamp(nombre(O.avance, 30), 10, 90);
    this.dernierAvance = -1;
    this.majTraqueReste = 0;
    this.barrageReste = 180; this.barrageAnnonce = false;
    this.barrages = []; this.barragePrevu = null;
    this.raccourciReste = 120; this.raccourcisVus = [];
    this.caisseAttrapee = false;
    /* Le départ des Fugitifs est tiré AVANT la zone d'extraction : la
       zone doit tomber dans un autre biome, pour forcer la traversée. */
    const T = this.traque || {};
    const D = (T.departs && T.departs.length ? T.departs : this.geo.spawns) || [];
    this.departFugitifs = D.length ? pioche(D) : null;
    this.preparerExtraction();
  }
  _demarrerBase.call(this);
  if (this.mode === 'poursuite') this.tempsRestant = clamp(nombre(O.dureeMax, 600), 240, 1800);
  for (const j of this.joueurs.values()) {
    etatModes(j);
    j.elimine = false; j.inventaire = ['knife']; j.arme = 'knife';
    j.mancheKills = 0; j.mancheMorts = 0; j.mancheDegats = 0; j.mancheArmes = {};
    j.mvp = 0; j.verrou = 0; j.verrouT = 0; j.extracT = 0; j.dernierExtrac = -1;
    j.soinT = 0; j.coffrePris = false; j.renfortT = 0;
    j.vuX = Math.round(j.x); j.vuY = Math.round(j.y); j.vuT = 0;
  }
  // l'état de mode part après WORLD_INIT : le client a déjà sa carte
  for (const j of this.joueurs.values()) this.envoyerModeInit(j);
  if (this.mode === 'battle') this.nouvelleManche();
  if (this.mode === 'poursuite') {
    this.annonce('Départ des Fugitifs révélé — les Chasseurs sont bloqués ' +
      Math.round(this.avanceReste) + ' secondes', '#ff9f43');
  }
};

/* Choix de la variante d'extraction et pose des zones. */
Salle.prototype.preparerExtraction = function () {
  const T = this.traque || {};
  const voulu = this.options.variante;
  const choix = typeof voulu === 'string' && EXTRACTIONS.some(e => e.id === voulu)
    ? voulu : pioche(EXTRACTIONS).id;
  let dispo = ((T.extractions && T.extractions.length ? T.extractions : this.geo.spawns) || []).slice();
  dispo.sort(() => Math.random() - 0.5);
  /* La zone doit tomber dans un biome différent du point de départ, et
     de toute façon loin de lui : on écarte les candidats du même biome
     puis on classe du plus éloigné au plus proche.                    */
  const dep = this.departFugitifs;
  if (dep) {
    const autres = dispo.filter(p => (p.nom && dep.nom)
      ? p.nom !== dep.nom
      : Math.hypot(p.x - dep.x, p.y - dep.y) > 2500);
    if (autres.length) dispo = autres;
    dispo.sort((a, b) =>
      Math.hypot(b.x - dep.x, b.y - dep.y) - Math.hypot(a.x - dep.x, a.y - dep.y));
  }
  const zone = p => ({ x: p.x, y: p.y, r: clamp(nombre(p.r, 200), 120, 400) });
  const E = { variante: choix, zones: [], ouverte: true, caisse: null, retard: 0 };
  E.zones = (choix === 'multi' ? dispo.slice(0, 3) : dispo.slice(0, 1)).map(zone);
  if (!E.zones.length && this.geo.extraction) E.zones = [zone(this.geo.extraction)];
  if (choix === 'mobile') {
    // trajectoire : une boucle entre quelques points sûrs, parcourue lentement
    E.trajet = dispo.slice(0, 5).map(p => ({ x: p.x, y: p.y }));
    if (E.trajet.length < 2) E.trajet = null;
    E.etape = 0; E.avance = 0;
  }
  if (choix === 'minutee') { E.ouverte = false; E.retard = 240; }
  if (choix === 'conditions') {
    E.ouverte = false;
    const pool = ((T.caisses && T.caisses.length ? T.caisses : dispo) || []).slice();
    pool.sort(() => Math.random() - 0.5);
    const C = pool[0];
    E.caisse = C ? { x: C.x, y: C.y, r: 90 } : null;
    if (!E.caisse) { E.ouverte = true; E.variante = 'fixe'; }
  }
  this.extraction = E;
};

/* État de mode envoyé juste après WORLD_INIT : tout ce que WORLD_INIT
   ne transporte pas (arène, camps, extraction, options de manche).     */
Salle.prototype.envoyerModeInit = function (j) {
  if (this.mode !== 'battle' && this.mode !== 'poursuite') return;
  etatModes(j);
  const msg = {
    t: 'MODE_INIT', mode: this.mode, equipe: j.equipe,
    camp: j.camp, nomCamp: nomCamp(this.mode, j.equipe), options: this.options
  };
  if (this.mode === 'battle') {
    msg.arene = this.arene;
    msg.manches = clamp(Math.round(nombre(this.options.manches, 3)), 1, 9);
    msg.dureeManche = clamp(Math.round(nombre(this.options.dureeManche, 120)), 60, 300);
  }
  if (this.mode === 'poursuite') {
    const E = this.extraction || {};
    const def = EXTRACTIONS.find(e => e.id === E.variante) || EXTRACTIONS[0];
    msg.extraction = {
      variante: E.variante, nom: def.nom, txt: def.txt,
      zones: E.ouverte ? E.zones : [], caisse: E.caisse,
      ouverte: !!E.ouverte, retard: Math.round(E.retard || 0)
    };
    msg.avance = Math.round(this.avanceReste || 0);
    msg.majMinimap = clamp(nombre(this.options.majMinimap, 15), 5, 60);
    msg.depart = this.departFugitifs
      ? { x: Math.round(this.departFugitifs.x), y: Math.round(this.departFugitifs.y) }
      : { x: Math.round(j.x), y: Math.round(j.y) };
    msg.veh = this.vehiculesCamp(j.equipe);
    msg.duree = Math.round(this.tempsRestant);
  }
  j.envoyer(msg);
};

/* Véhicules de départ proposés à un camp. Le client les fait apparaître
   chez lui : il est seul à connaître la chaussée.                      */
Salle.prototype.vehiculesCamp = function (equipe) {
  return equipe === 1
    ? ['sport', 'moto', 'berline']          // Fugitifs : rapides et agiles
    : ['suv', 'muscle', 'pickup'];          // Chasseurs : robustes
};

/* ------------------------ placement des joueurs ---------------------- */
const _placerBase = Salle.prototype.placer;
Salle.prototype.placer = function (j) {
  etatModes(j);
  if (this.mode === 'battle' && this.arene) {
    const b = this.arene.bases[(j.equipe || 1) - 1] || this.arene.bases[0];
    const n = [...this.joueurs.keys()].indexOf(j.id);
    j.x = clamp(b.x + Math.cos(n * 1.7) * 40, 40, TAILLE_MONDE - 40);
    j.y = clamp(b.y + Math.sin(n * 1.7) * 40, 40, TAILLE_MONDE - 40);
    j.veh = null; j.nage = false; j.dedans = false;
    j.tDernierInput = Date.now();
    j.histo.length = 0;
    j.grace = Date.now() + 2000;
    j.bouclier = Date.now() + 3000;          // bouclier de sortie de base
    return;
  }
  if (this.mode === 'poursuite') {
    const T = this.traque || {};
    const D = (T.departs && T.departs.length ? T.departs : this.geo.spawns) || [];
    if (D.length) {
      if (!this.departFugitifs) this.departFugitifs = D[0];
      // les Chasseurs partent du point le plus éloigné du départ des Fugitifs
      let loin = D[0], pire = -1;
      for (const p of D) {
        const d = (p.x - this.departFugitifs.x) * (p.x - this.departFugitifs.x) +
          (p.y - this.departFugitifs.y) * (p.y - this.departFugitifs.y);
        if (d > pire) { pire = d; loin = p; }
      }
      const base = j.equipe === 2 ? loin : this.departFugitifs;
      const n = [...this.joueurs.keys()].indexOf(j.id);
      j.x = clamp(base.x + Math.cos(n * 2.1) * 55, 40, TAILLE_MONDE - 40);
      j.y = clamp(base.y + Math.sin(n * 2.1) * 55, 40, TAILLE_MONDE - 40);
      j.veh = null; j.nage = false; j.dedans = false;
      j.tDernierInput = Date.now();
      j.histo.length = 0;
      j.grace = Date.now() + 2000;
      return;
    }
  }
  _placerBase.call(this, j);
};

/* ====================== MODE BATTLE : LES MANCHES ==================== */

/* Tire les emplacements d'armes d'une manche. Jamais deux manches de
   suite avec exactement la même disposition.                           */
Salle.prototype.tirerArmes = function () {
  const A = this.arene;
  if (!A) return [];
  const legendairesOk = this.options.legendaires !== false;
  let sortie = [];
  for (let essai = 0; essai < 6; essai++) {
    const zones = A.zones.slice();
    for (let i = zones.length - 1; i > 0; i--) {
      const k = Math.floor(Math.random() * (i + 1));
      const tmp = zones[i]; zones[i] = zones[k]; zones[k] = tmp;
    }
    const n = Math.min(zones.length, Math.round(alea(15, 25)));
    const liste = [];
    let legendaire = false;
    for (let i = 0; i < n; i++) {
      const d = Math.random() * 100;
      let rarete = d < 60 ? 'commune' : d < 90 ? 'rare' : 'legendaire';
      // une seule arme légendaire par manche, et aucune si l'option est coupée
      if (rarete === 'legendaire' && (legendaire || !legendairesOk)) rarete = 'rare';
      if (rarete === 'legendaire') legendaire = true;
      liste.push({
        id: 'a' + this.manche + '_' + i,
        arme: pioche(BATTLE_RARETES[rarete].armes),
        rarete, x: zones[i].x, y: zones[i].y, lache: false, expire: 0
      });
    }
    /* L'arme légendaire va au centre de la carte, dans une zone exposée :
       il faut se découvrir pour la prendre.                            */
    if (legendairesOk && liste.length) {
      let L = liste.find(a => a.rarete === 'legendaire');
      if (!L) {
        L = liste[0];
        L.rarete = 'legendaire';
        L.arme = pioche(BATTLE_RARETES.legendaire.armes);
      }
      L.x = A.centre.x; L.y = A.centre.y;
    }
    const signature = liste.map(a => a.x + ':' + a.y).sort().join('|');
    sortie = liste;
    if (signature !== this.armesPrec) { this.armesPrec = signature; break; }
  }
  return sortie;
};

/* Ouverture d'une manche : gel de 5 s dans les bases, armes révélées. */
Salle.prototype.nouvelleManche = function () {
  this.manche = (this.manche || 0) + 1;
  this.manchePhase = 'gel';
  this.mancheT = 5;
  this.armesSol = this.tirerArmes();
  for (const j of this.joueurs.values()) {
    etatModes(j);
    j.elimine = false; j.mort = false; j.respawnT = 0;
    j.inventaire = ['knife']; j.arme = 'knife';
    j.hp = Math.round(j.maxHp * 0.5);          // chaque manche repart à 50 % de vie
    j.armor = 0;
    j.mancheKills = 0; j.mancheMorts = 0; j.mancheDegats = 0; j.mancheArmes = {};
    j.coffrePris = false; j.soinT = 0;
    this.placer(j);
    j.envoyer({ t: 'EVENT', type: 'respawn', d: { x: j.x, y: j.y, hp: j.hp } });
  }
  this.diffuser({
    t: 'EVENT', type: 'manche-debut',
    d: {
      manche: this.manche,
      pourGagner: clamp(Math.round(nombre(this.options.manches, 3)), 1, 9),
      gagnees: this.manchesGagnees,
      duree: clamp(Math.round(nombre(this.options.dureeManche, 120)), 60, 300),
      gel: 5,
      armes: this.armesSol.map(a => ({ id: a.id, arme: a.arme, rarete: a.rarete, x: a.x, y: a.y }))
    }
  });
  this.annonce('Manche ' + this.manche + ' — ' + this.armesSol.length + ' armes au sol', '#ffd45e');
  log('INFO', 'manche', { salle: this.code, n: this.manche, armes: this.armesSol.length });
};

/* Fin de manche : survivants, MVP, écran de résultats de 10 secondes. */
Salle.prototype.finManche = function (raison) {
  const vivants = { 1: 0, 2: 0 };
  for (const j of this.joueurs.values()) if (!j.elimine && !j.mort) vivants[j.equipe]++;
  const gagnant = vivants[1] > vivants[2] ? 1 : vivants[2] > vivants[1] ? 2 : 0;
  if (gagnant) {
    this.manchesGagnees[gagnant]++;
    for (const j of this.joueurs.values()) if (j.equipe === gagnant) j.score += 500;
  }
  // MVP : le plus d'éliminations, les dégâts tranchent en cas d'égalité
  let mvp = null;
  for (const j of this.joueurs.values()) {
    if (!mvp) { mvp = j; continue; }
    if (j.mancheKills * 1000 + j.mancheDegats > mvp.mancheKills * 1000 + mvp.mancheDegats) mvp = j;
  }
  if (mvp && !(mvp.mancheKills || mvp.mancheDegats)) mvp = null;
  if (mvp) mvp.mvp++;
  const armeTop = j => {
    let nom = '', n = -1;
    for (const k in j.mancheArmes) if (j.mancheArmes[k] > n) { n = j.mancheArmes[k]; nom = k; }
    return nom;
  };
  this.dernierResultat = {
    manche: this.manche, gagnant, raison, vivants,
    gagnees: this.manchesGagnees,
    pourGagner: clamp(Math.round(nombre(this.options.manches, 3)), 1, 9),
    mvp: mvp ? mvp.id : null,
    attente: 10,
    lignes: [...this.joueurs.values()].map(j => ({
      id: j.id, pseudo: j.pseudo, couleur: j.couleur, equipe: j.equipe,
      kills: j.mancheKills, morts: j.mancheMorts, score: j.score,
      arme: armeTop(j), mvp: !!(mvp && mvp.id === j.id)
    }))
  };
  this.manchePhase = 'resultats';
  this.mancheT = 10;
  this.armesSol = [];
  this.diffuser({ t: 'EVENT', type: 'manche-fin', d: this.dernierResultat });
  this.annonce(gagnant
    ? 'Manche ' + this.manche + ' remportée par l’équipe ' + nomCamp('battle', gagnant) +
    ' (' + this.manchesGagnees[1] + ' – ' + this.manchesGagnees[2] + ')'
    : 'Manche ' + this.manche + ' nulle : autant de survivants de chaque côté',
    gagnant === 1 ? '#ff6b6b' : gagnant === 2 ? '#58c4ff' : '#9ec5ff');
};

/* Horloge des manches : gel, jeu, résultats. */
Salle.prototype.reglesBattle = function (dt) {
  if (!this.arene) return;
  this.mancheT -= dt;
  if (this.manchePhase === 'gel') {
    if (this.mancheT <= 0) {
      this.manchePhase = 'jeu';
      this.mancheT = clamp(Math.round(nombre(this.options.dureeManche, 120)), 60, 300);
      for (const j of this.joueurs.values()) j.bouclier = Date.now() + 3000;
      this.diffuser({ t: 'EVENT', type: 'manche-feu', d: { duree: Math.round(this.mancheT) } });
    }
    return;
  }
  if (this.manchePhase === 'resultats') {
    if (this.mancheT > 0) return;
    const pourGagner = clamp(Math.round(nombre(this.options.manches, 3)), 1, 9);
    if (this.manchesGagnees[1] >= pourGagner || this.manchesGagnees[2] >= pourGagner) {
      this.terminer(this.manchesGagnees[1] > this.manchesGagnees[2] ? 'equipe1' : 'equipe2');
      return;
    }
    this.nouvelleManche();
    return;
  }
  if (this.manchePhase !== 'jeu') return;

  /* --- manche en cours --- */
  // armes lâchées : vingt secondes au sol puis disparition
  const t = Date.now();
  for (let i = this.armesSol.length - 1; i >= 0; i--) {
    const a = this.armesSol[i];
    if (a.expire && t > a.expire) {
      this.armesSol.splice(i, 1);
      this.diffuser({ t: 'EVENT', type: 'arme-partie', d: { id: a.id } });
    }
  }
  // points de soin des bases : 20 % de vie toutes les 3 secondes
  for (const j of this.joueurs.values()) {
    if (j.mort || j.elimine) continue;
    const b = this.arene.bases[(j.equipe || 1) - 1];
    if (!b) continue;
    if ((b.soin.x - j.x) * (b.soin.x - j.x) + (b.soin.y - j.y) * (b.soin.y - j.y) < 90 * 90) {
      j.soinT += dt;
      if (j.soinT >= 3) {
        j.soinT = 0;
        j.hp = Math.min(j.maxHp, j.hp + j.maxHp * 0.2);
        j.envoyer({ t: 'EVENT', type: 'soin', d: { hp: Math.round(j.hp) } });
      }
    } else j.soinT = 0;
  }
  // fin par élimination totale d'un camp
  const vivants = { 1: 0, 2: 0 };
  for (const j of this.joueurs.values()) if (!j.elimine && !j.mort) vivants[j.equipe]++;
  if (!vivants[1] || !vivants[2]) { this.finManche('elimination'); return; }
  if (this.mancheT <= 0) this.finManche('temps');
};

/* Ramassage d'une arme au sol, ou ouverture du coffre de base. */
Salle.prototype.ramasserArme = function (j, m) {
  if (this.mode !== 'battle' || this.manchePhase !== 'jeu' || j.mort || j.elimine) return;
  etatModes(j);
  const id = propre(String(m.cible === undefined ? '' : m.cible), 40);
  if (id === 'coffre') {
    const b = this.arene && this.arene.bases[(j.equipe || 1) - 1];
    if (!b || j.coffrePris) return;
    if ((b.coffre.x - j.x) * (b.coffre.x - j.x) + (b.coffre.y - j.y) * (b.coffre.y - j.y) > 110 * 110) return;
    j.coffrePris = true;
    const arme = pioche(BATTLE_RARETES.commune.armes);
    if (!j.inventaire.includes(arme)) j.inventaire.push(arme);
    j.arme = arme;
    j.envoyer({
      t: 'EVENT', type: 'arme-prise',
      d: { arme, rarete: 'commune', mun: BATTLE_MUNITIONS[arme] || 0, coffre: 1 }
    });
    return;
  }
  const i = this.armesSol.findIndex(a => a.id === id);
  if (i < 0) return;
  const a = this.armesSol[i];
  if ((a.x - j.x) * (a.x - j.x) + (a.y - j.y) * (a.y - j.y) > 70 * 70) {
    log('WARN', 'ramassage hors portee', { salle: this.code, id: j.id, arme: a.arme });
    return;
  }
  this.armesSol.splice(i, 1);
  if (!j.inventaire.includes(a.arme)) j.inventaire.push(a.arme);
  j.arme = a.arme;
  j.envoyer({
    t: 'EVENT', type: 'arme-prise',
    d: { arme: a.arme, rarete: a.rarete, mun: BATTLE_MUNITIONS[a.arme] || 0 }
  });
  this.diffuser({ t: 'EVENT', type: 'arme-partie', d: { id: a.id } }, j.id);
};

/* ==================== MODE COURSE POURSUITE : TRAQUE ================= */
Salle.prototype.reglesPoursuite = function (dt) {
  const tous = [...this.joueurs.values()].map(etatModes);
  const fugitifs = tous.filter(j => j.equipe === 1);
  const chasseurs = tous.filter(j => j.equipe === 2);
  const t = Date.now();

  /* --- avance des Fugitifs : les Chasseurs sont bloqués --- */
  if (this.avanceReste > 0) {
    this.avanceReste -= dt;
    const n = Math.ceil(this.avanceReste);
    if (n !== this.dernierAvance) {
      this.dernierAvance = n;
      this.diffuser({ t: 'EVENT', type: 'avance', d: { n: Math.max(0, n) } });
    }
    if (this.avanceReste <= 0) {
      this.annonce('Les Chasseurs sont lâchés !', '#c08aff');
      this.diffuser({ t: 'EVENT', type: 'avance', d: { n: 0, fin: 1 } });
    }
  }

  /* --- zone d'extraction : ouverture, déplacement, caisse --- */
  const E = this.extraction;
  if (E) {
    if (!E.ouverte && E.variante === 'minutee') {
      E.retard -= dt;
      if (E.retard <= 0) {
        E.ouverte = true;
        this.diffuser({ t: 'EVENT', type: 'extraction-ouverte', d: { zones: E.zones, variante: E.variante } });
        this.annonce('La zone d’extraction vient d’apparaître', '#7ae582');
      }
    }
    if (!E.ouverte && E.variante === 'conditions' && E.caisse && !this.caisseAttrapee) {
      for (const p of tous) {
        if (p.mort || p.elimine) continue;
        if ((E.caisse.x - p.x) * (E.caisse.x - p.x) + (E.caisse.y - p.y) * (E.caisse.y - p.y) < E.caisse.r * E.caisse.r) {
          this.caisseAttrapee = true;
          E.ouverte = true;
          this.diffuser({
            t: 'EVENT', type: 'extraction-ouverte',
            d: { zones: E.zones, variante: E.variante, par: p.pseudo }
          });
          this.annonce(p.pseudo + ' a récupéré la caisse : l’extraction est déverrouillée', '#7ae582');
          break;
        }
      }
    }
    if (E.variante === 'mobile' && E.trajet && E.zones.length) {
      // 40 px/s : assez lent pour être intercepté, assez vif pour compter
      E.avance += dt * 40;
      const a = E.trajet[E.etape % E.trajet.length];
      const b = E.trajet[(E.etape + 1) % E.trajet.length];
      const long = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
      if (E.avance >= long) { E.avance = 0; E.etape++; }
      else {
        const k = E.avance / long;
        E.zones[0].x = Math.round(a.x + (b.x - a.x) * k);
        E.zones[0].y = Math.round(a.y + (b.y - a.y) * k);
      }
    }
  }

  /* --- traque : mise à jour périodique de la position des Fugitifs --- */
  const periode = clamp(nombre(this.options.majMinimap, 15), 5, 60);
  this.majTraqueReste -= dt;
  if (this.majTraqueReste <= 0) {
    this.majTraqueReste = periode;
    for (const f of fugitifs) {
      if (f.mort || f.elimine) continue;
      // brouillage : traverser l'eau gèle la dernière position connue
      if (f.nage) continue;
      f.vuX = Math.round(f.x); f.vuY = Math.round(f.y); f.vuT = t;
    }
  }

  /* --- bonus de traque : 3 s dans un rayon de 200 px → verrou de 10 s --- */
  for (const f of fugitifs) {
    if (f.mort || f.elimine) { f.verrouT = 0; continue; }
    const colle = chasseurs.some(c => !c.mort && !c.elimine &&
      (c.x - f.x) * (c.x - f.x) + (c.y - f.y) * (c.y - f.y) < 200 * 200);
    f.verrouT = colle ? f.verrouT + dt : Math.max(0, f.verrouT - dt * 0.8);
    if (f.verrouT >= 3 && t > f.verrou) {
      f.verrouT = 0;
      f.verrou = t + 10000;
      f.envoyer({ t: 'EVENT', type: 'verrou', d: { duree: 10 } });
      for (const c of chasseurs)
        c.envoyer({ t: 'EVENT', type: 'verrou-pose', d: { id: f.id, pseudo: f.pseudo, duree: 10 } });
    }
  }

  /* --- barrage de faction : toutes les 3 minutes, annoncé 30 s avant --- */
  const T = this.traque || {};
  this.barrageReste -= dt;
  if (!this.barrageAnnonce && this.barrageReste <= 30) {
    this.barrageAnnonce = true;
    const pool = (T.barrages && T.barrages.length ? T.barrages : this.geo.spawns) || [];
    this.barragePrevu = pool.length ? pioche(pool) : null;
    if (this.barragePrevu) {
      this.diffuser({
        t: 'EVENT', type: 'barrage-annonce',
        d: { x: this.barragePrevu.x, y: this.barragePrevu.y, dans: 30 }
      });
      this.annonce('Barrage de faction annoncé dans 30 secondes', '#ffa33d');
    }
  }
  if (this.barrageReste <= 0) {
    this.barrageReste = 180; this.barrageAnnonce = false;
    if (this.barragePrevu) {
      const b = { x: this.barragePrevu.x, y: this.barragePrevu.y };
      this.barrages.push(b);
      while (this.barrages.length > 4) this.barrages.shift();
      this.diffuser({ t: 'EVENT', type: 'barrage', d: { x: b.x, y: b.y } });
      this.annonce('Barrage en place — contournez-le ou forcez-le', '#ffa33d');
      this.barragePrevu = null;
    }
  }

  /* --- raccourci révélé aux seuls Fugitifs, toutes les 2 minutes --- */
  this.raccourciReste -= dt;
  if (this.raccourciReste <= 0) {
    this.raccourciReste = 120;
    const pool = (T.raccourcis || []).filter(r => !this.raccourcisVus.some(v => v.x === r.x && v.y === r.y));
    if (pool.length) {
      const r = pioche(pool);
      this.raccourcisVus.push(r);
      for (const f of fugitifs) f.envoyer({
        t: 'EVENT', type: 'raccourci', d: { x: r.x, y: r.y, nom: r.nom || 'Raccourci' }
      });
    }
  }

  /* --- renfort mécanique : un Fugitif à pied reçoit une moto --- */
  for (const f of fugitifs) {
    if (f.mort || f.elimine || f.veh) { f.renfortT = Math.min(0, f.renfortT); continue; }
    f.renfortT += dt;
    if (f.renfortT >= 20) {
      f.renfortT = -60;              // un renfort par minute au maximum
      const a = Math.random() * Math.PI * 2, d = alea(120, 300);
      f.envoyer({
        t: 'EVENT', type: 'renfort',
        d: { x: Math.round(f.x + Math.cos(a) * d), y: Math.round(f.y + Math.sin(a) * d) }
      });
    }
  }

  /* --- extraction : rester 5 secondes dans une zone ouverte --- */
  if (E && E.ouverte && E.zones.length) {
    for (const f of fugitifs) {
      if (f.mort || f.elimine || f.extrait) continue;
      const dedans = E.zones.some(z =>
        (z.x - f.x) * (z.x - f.x) + (z.y - f.y) * (z.y - f.y) < z.r * z.r);
      if (dedans) {
        f.extracT += dt;
        const reste = Math.max(0, 5 - f.extracT);
        if (Math.ceil(reste) !== f.dernierExtrac) {
          f.dernierExtrac = Math.ceil(reste);
          f.envoyer({ t: 'EVENT', type: 'extraction-cours', d: { reste: Math.ceil(reste) } });
        }
        if (f.extracT >= 5) {
          f.extrait = true; f.score += 1000;
          this.diffuser({ t: 'EVENT', type: 'extraction', d: { id: f.id, pseudo: f.pseudo } });
          this.annonce(f.pseudo + ' a activé l’extraction — les Fugitifs gagnent !', '#7ae582');
          this.terminer('fugitifs');
          return;
        }
      } else if (f.extracT > 0) {
        f.extracT = 0; f.dernierExtrac = -1;
        f.envoyer({ t: 'EVENT', type: 'extraction-cours', d: { reste: 0, annule: 1 } });
      }
    }
  }

  /* --- victoire des Chasseurs : plus un seul Fugitif debout --- */
  const restants = fugitifs.filter(f => !f.elimine && !f.extrait);
  if (fugitifs.length && !restants.length) this.terminer('chasseurs');
};

/* Branchement sur l'aiguillage des règles par mode. */
const _reglesBase = Salle.prototype.reglesMode;
Salle.prototype.reglesMode = function (dt) {
  if (this.mode === 'battle') { this.reglesBattle(dt); return; }
  if (this.mode === 'poursuite') { this.reglesPoursuite(dt); return; }
  _reglesBase.call(this, dt);
};

/* ====================== ENTRÉES ET VALIDATIONS ======================= */

/* Gel des déplacements : dans sa base pendant le décompte de manche, au
   départ pour un Chasseur pendant l'avance des Fugitifs.               */
Salle.prototype.figeOu = function (j) {
  if (this.mode === 'battle' && this.manchePhase === 'gel') return 'décompte de manche';
  if (this.mode === 'poursuite' && j.equipe === 2 && this.avanceReste > 0) return 'avance des Fugitifs';
  return '';
};
const _inputBase = Salle.prototype.input;
Salle.prototype.input = function (j, m) {
  etatModes(j);
  const fige = this.phase === 'jeu' ? this.figeOu(j) : '';
  if (fige) {
    // on accepte la visée, jamais le déplacement
    const x = nombre(m.x, j.x), y = nombre(m.y, j.y);
    j.ang = nombre(m.a, j.ang); j.aim = nombre(m.m, j.aim);
    j.seq = Math.max(j.seq, nombre(m.seq, 0));
    j.tDernierInput = Date.now();
    if (Math.hypot(x - j.x, y - j.y) > 70) this.corriger(j, fige);
    return;
  }
  _inputBase.call(this, j, m);
  // enceinte de l'arène : personne ne sort du terrain
  if (this.mode === 'battle' && this.arene && this.phase === 'jeu') {
    const R = this.arene.rect, mg = 30;
    const cx = clamp(j.x, R.x + mg, R.x + R.w - mg);
    const cy = clamp(j.y, R.y + mg, R.y + R.h - mg);
    if (cx !== j.x || cy !== j.y) { j.x = cx; j.y = cy; this.corriger(j, 'limite de l’arène'); }
  }
};

/* Comptage des coups tirés : sert à désigner « l'arme la plus utilisée »
   de la manche sur l'écran de résultats.                               */
const _tirBase = Salle.prototype.tir;
Salle.prototype.tir = function (j, m) {
  const avant = j.tirT;
  _tirBase.call(this, j, m);
  if (j.tirT !== avant) {
    etatModes(j);
    j.mancheArmes[j.arme] = (j.mancheArmes[j.arme] || 0) + 1;
  }
};

/* Dégâts : bouclier de sortie de base, et comptage des dégâts de la
   manche pour le MVP.                                                  */
const _blesserBase = Salle.prototype.blesser;
Salle.prototype.blesser = function (cible, degats, par, cause) {
  etatModes(cible);
  if (cible.bouclier && Date.now() < cible.bouclier) {
    if (par) par.envoyer({ t: 'EVENT', type: 'refus', d: { txt: 'Cible protégée à la sortie de sa base' } });
    return;
  }
  if (par) { etatModes(par); par.mancheDegats += degats; }
  _blesserBase.call(this, cible, degats, par, cause);
};
const _toucheBase = Salle.prototype.touche;
Salle.prototype.touche = function (j, m) {
  /* Les explosifs touchent plusieurs cibles d'un coup : le plafond de
     débit d'origine les rejetterait à tort. On leur rend du crédit. */
  if (m && (m.arme === 'grenade' || m.arme === 'glauncher')) j.dmgCumul = Math.max(0, j.dmgCumul - 80);
  _toucheBase.call(this, j, m);
};

/* Mort : en battle on est éliminé pour la manche et on lâche ses armes ;
   en course poursuite un Fugitif mort est hors course.                 */
const _tuerBase = Salle.prototype.tuer;
Salle.prototype.tuer = function (victime, tueur, cause) {
  if (victime.mort) return;
  etatModes(victime);
  if (tueur) etatModes(tueur);
  const avantKills = tueur ? tueur.kills : 0;
  _tuerBase.call(this, victime, tueur, cause);
  if (this.mode !== 'battle' && this.mode !== 'poursuite') return;

  victime.mancheMorts++;
  if (tueur && tueur.kills > avantKills) {
    tueur.mancheKills++;
    /* Barème demandé : 100 pour l'élimination, 50 de bonus à l'arme
       légendaire, 25 de bonus en mouvement. Le serveur a déjà crédité
       son barème générique : on applique la différence.                */
    let pts = 100 - (this.mode === 'battle' ? 500 : 250);
    if (BATTLE_RARETES.legendaire.armes.indexOf(tueur.arme) >= 0) pts += 50;
    if (this.enMouvement(tueur)) pts += 25;
    tueur.score = Math.max(0, tueur.score + pts);
  }

  if (this.mode === 'battle') {
    victime.elimine = true;
    victime.respawnT = 1e9;                 // pas de retour avant la manche suivante
    // toutes ses armes tombent au sol, ramassables 20 secondes
    const t = Date.now();
    const lachees = [];
    let n = 0;
    for (const arme of victime.inventaire) {
      if (arme === 'knife') continue;
      const a = {
        id: 'd' + victime.id + '_' + (this.manche || 0) + '_' + (n++),
        arme, rarete: this.rareteDe(arme),
        x: Math.round(victime.x + alea(-18, 18)), y: Math.round(victime.y + alea(-18, 18)),
        lache: true, expire: t + 20000
      };
      this.armesSol.push(a);
      lachees.push({ id: a.id, arme: a.arme, rarete: a.rarete, x: a.x, y: a.y });
    }
    victime.inventaire = ['knife'];
    if (lachees.length) this.diffuser({ t: 'EVENT', type: 'armes-lachees', d: { armes: lachees } });
    if (this.manchePhase === 'jeu') this.reglesBattle(0);
    return;
  }
  if (this.mode === 'poursuite' && victime.equipe === 1) {
    victime.elimine = true;
    victime.respawnT = 1e9;
    this.annonce(victime.pseudo + ' (Fugitif) est hors course', '#ff9f43');
    this.reglesPoursuite(0);
  }
};
Salle.prototype.rareteDe = function (arme) {
  for (const k in BATTLE_RARETES) if (BATTLE_RARETES[k].armes.indexOf(arme) >= 0) return k;
  return 'commune';
};
/* Le tireur bougeait-il ? On le lit sur l'historique de positions. */
Salle.prototype.enMouvement = function (j) {
  if (!j.histo || j.histo.length < 2) return false;
  const a = j.histo[0], b = j.histo[j.histo.length - 1];
  const dt = (b.t - a.t) / 1000;
  if (dt < 0.1) return false;
  return Math.hypot(b.x - a.x, b.y - a.y) / dt > 60;
};

/* Interactions : ramassage d'armes, et refus des véhicules en battle. */
const _interBase = Salle.prototype.interagir;
Salle.prototype.interagir = function (j, m) {
  const type = propre(m.type, 20);
  if (type === 'arme') { this.ramasserArme(j, m); return; }
  if (this.mode === 'battle' && (type === 'monter' || type === 'descendre')) {
    if (type === 'monter') j.envoyer({ t: 'EVENT', type: 'refus', d: { txt: 'Aucun véhicule dans l’arène' } });
    return;
  }
  // aucune police dans ces deux modes : le compteur d'étoiles est muet
  if ((this.mode === 'battle' || this.mode === 'poursuite') && type === 'etoiles') return;
  _interBase.call(this, j, m);
};

/* ====================== DIFFUSION DE L'ÉTAT DE MODE ==================
   Un message à part, à 5 Hz : il évite d'alourdir chaque TICK, et son
   contenu diffère d'un joueur à l'autre (un Fugitif ne voit pas ce que
   voit un Chasseur).
   ===================================================================== */
const _tickBase = Salle.prototype.diffuserTick;
Salle.prototype.diffuserTick = function () {
  _tickBase.call(this);
  if (this.mode !== 'battle' && this.mode !== 'poursuite') return;
  if (this.tick % 4 !== 0) return;
  if (this.mode === 'battle') this.diffuserBattle();
  else this.diffuserPoursuite();
};
Salle.prototype.diffuserBattle = function () {
  const t = Date.now();
  const vivants = { 1: 0, 2: 0 };
  for (const j of this.joueurs.values()) if (!j.elimine && !j.mort) vivants[j.equipe]++;
  const base = {
    t: 'MODE', mode: 'battle',
    manche: this.manche, phase: this.manchePhase,
    reste: Math.max(0, Math.round(this.mancheT)),
    gagnees: this.manchesGagnees, vivants,
    armes: (this.armesSol || []).map(a => ({
      id: a.id, arme: a.arme, rarete: a.rarete, x: a.x, y: a.y, lache: a.lache ? 1 : 0
    }))
  };
  for (const j of this.joueurs.values()) {
    j.envoyer(Object.assign({}, base, {
      bouclier: j.bouclier && t < j.bouclier ? Math.round((j.bouclier - t) / 100) / 10 : 0,
      elimine: j.elimine ? 1 : 0,
      inventaire: j.inventaire
    }));
  }
};
Salle.prototype.diffuserPoursuite = function () {
  const t = Date.now();
  const tous = [...this.joueurs.values()].map(etatModes);
  const fugitifs = tous.filter(j => j.equipe === 1);
  const E = this.extraction || {};
  const commun = {
    t: 'MODE', mode: 'poursuite',
    avance: Math.max(0, Math.round(this.avanceReste || 0)),
    reste: Math.max(0, Math.round(this.tempsRestant)),
    extraction: {
      variante: E.variante, ouverte: !!E.ouverte,
      zones: E.ouverte ? E.zones : [],
      caisse: this.caisseAttrapee ? null : (E.caisse || null),
      retard: E.ouverte ? 0 : Math.max(0, Math.round(E.retard || 0))
    },
    barrages: (this.barrages || []).map(b => ({ x: b.x, y: b.y })),
    barragePrevu: this.barragePrevu || null,
    vivants: {
      1: fugitifs.filter(f => !f.elimine && !f.extrait).length,
      2: tous.filter(j => j.equipe === 2 && !j.mort).length
    }
  };
  /* Les Chasseurs reçoivent les positions connues des Fugitifs avec leur
     âge ; les Fugitifs ne reçoivent jamais celle d'un Chasseur.        */
  const traque = fugitifs.filter(f => !f.elimine && !f.extrait).map(f => {
    const direct = f.verrou && t < f.verrou;
    return {
      id: f.id, pseudo: f.pseudo,
      x: direct ? Math.round(f.x) : f.vuX, y: direct ? Math.round(f.y) : f.vuY,
      age: direct ? 0 : (f.vuT ? Math.round((t - f.vuT) / 1000) : -1),
      direct: direct ? 1 : 0
    };
  });
  for (const j of tous) {
    const msg = Object.assign({}, commun, {
      camp: j.equipe, elimine: j.elimine ? 1 : 0, extrait: j.extrait ? 1 : 0,
      extracT: Math.round((j.extracT || 0) * 10) / 10,
      verrou: j.verrou && t < j.verrou ? Math.round((j.verrou - t) / 1000) : 0
    });
    if (j.equipe === 2) msg.traque = traque;
    else msg.raccourcis = this.raccourcisVus || [];
    j.envoyer(msg);
  }
};

/* ============================ FIN DE PARTIE ==========================
   Récompenses, titres de 24 h et classement dédié par mode.
   ===================================================================== */
const _terminerBase = Salle.prototype.terminer;
Salle.prototype.terminer = function (raison) {
  if (this.phase === 'fin') return;
  if (this.mode === 'poursuite' && raison === 'temps') {
    // le temps expire : les Fugitifs encore en vie l'emportent
    const debout = [...this.joueurs.values()].some(j => j.equipe === 1 && !j.elimine);
    raison = debout ? 'fugitifs' : 'chasseurs';
  }
  if (this.mode === 'battle' || this.mode === 'poursuite') this.recompenser(raison);
  _terminerBase.call(this, raison);
};

Salle.prototype.recompenser = function (raison) {
  const gagnant = (raison === 'fugitifs' || raison === 'equipe1') ? 1
    : (raison === 'chasseurs' || raison === 'equipe2') ? 2 : 0;
  const liste = [...this.joueurs.values()].map(etatModes);

  /* MVP de la course poursuite : dernier survivant ou extraction solo
     chez les Fugitifs, le plus d'éliminations chez les Chasseurs.      */
  let mvpFug = null, mvpChas = null;
  if (this.mode === 'poursuite') {
    const fug = liste.filter(j => j.equipe === 1);
    const extraits = fug.filter(j => j.extrait);
    const debout = fug.filter(j => !j.elimine);
    if (extraits.length === 1) mvpFug = extraits[0];
    else if (debout.length === 1) mvpFug = debout[0];
    for (const c of liste.filter(j => j.equipe === 2))
      if (!mvpChas || c.kills > mvpChas.kills) mvpChas = c;
    if (mvpChas && !mvpChas.kills) mvpChas = null;
  }
  /* En battle, les trois meilleurs scores reçoivent un titre. */
  const podium = this.mode === 'battle'
    ? liste.slice().sort((a, b) => b.score - a.score || b.kills - a.kills).slice(0, 3) : [];

  for (const j of liste) {
    const victoire = !!gagnant && j.equipe === gagnant;
    let mult = victoire ? 2 : 0.5;
    let titre = '';
    if (j === mvpFug) { mult = 3; titre = 'FUGITIF INSAISISSABLE'; }
    else if (j === mvpChas) { mult = 2; titre = 'CHASSEUR IMPLACABLE'; }
    else if (this.mode === 'battle') {
      const r = podium.indexOf(j);
      if (r === 0) titre = 'CHAMPION DE L’ARÈNE';
      else if (r === 1) titre = 'VICE-CHAMPION';
      else if (r === 2) titre = 'TROISIÈME LAME';
    }
    if (titre) donnerTitre(j.pseudo, titre);
    /* L'argent en jeu reste un miroir : on annonce le gain, le client
       l'applique à son portefeuille, le serveur borne la variation.    */
    const argent = Math.round(Math.max(0, j.score) * 0.6 * mult) + (victoire ? 600 : 150);
    j.argent = clamp(j.argent + argent, 0, 99999999);
    j.envoyer({
      t: 'EVENT', type: 'recompense',
      d: {
        argent, mult, titre, victoire: victoire ? 1 : 0,
        mvp: j === mvpFug ? 'fugitif' : j === mvpChas ? 'chasseur' : '',
        manches: this.mode === 'battle' ? this.manchesGagnees : null
      }
    });
  }
  log('INFO', 'recompenses', { salle: this.code, mode: this.mode, raison, gagnant });
};

/* Le classement final annonce les camps, les ratios et les titres. */
const _classBase = Salle.prototype.classement;
Salle.prototype.classement = function () {
  const l = _classBase.call(this);
  if (this.mode !== 'battle' && this.mode !== 'poursuite') return l;
  for (const c of l) {
    c.titre = titreDe(c.pseudo);
    c.camp = nomCamp(this.mode, c.equipe);
    c.ratio = c.morts ? Math.round(c.kills / c.morts * 100) / 100 : c.kills;
    const j = [...this.joueurs.values()].find(p => p.pseudo === c.pseudo);
    if (j) { c.mvp = j.mvp || 0; c.elimine = !!j.elimine; }
  }
  return l;
};

/* Un départ en cours de partie peut vider un camp : on réévalue. */
const _retirerBase = Salle.prototype.retirer;
Salle.prototype.retirer = function (j) {
  const etait = this.joueurs.has(j.id);
  _retirerBase.call(this, j);
  if (!etait || this.phase !== 'jeu') return;
  if (this.mode === 'poursuite') this.reglesPoursuite(0);
  else if (this.mode === 'battle' && this.manchePhase === 'jeu') this.reglesBattle(0);
};

/* =======================================================================
   HUB — l'ensemble des salles et des connexions
   ======================================================================= */
const HUB = {
  salles: new Map(),
  joueurs: new Set(),

  codeLibre() {
    const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let c;
    do {
      c = '';
      for (let i = 0; i < 4; i++) c += L[Math.floor(Math.random() * L.length)];
    } while (this.salles.has(c));
    return c;
  },

  creer(def) {
    if (this.salles.size >= MAX_SALLES) return null;
    const code = this.codeLibre();
    const s = new Salle(code, def);
    this.salles.set(code, s);
    s.demarrerBoucle();
    log('INFO', 'salle creee', { code, mode: def.mode, seed: def.seed, nom: def.nom });
    return s;
  },
  fermer(code) {
    const s = this.salles.get(code);
    if (!s) return;
    s.arreterBoucle();
    this.salles.delete(code);
    log('INFO', 'salle fermee', { code });
  },
  liste(mode) {
    return [...this.salles.values()]
      .filter(s => !mode || s.mode === mode)
      .map(s => s.info())
      .sort((a, b) => b.joueurs - a.joueurs);
  }
};

/* =======================================================================
   SERVEUR HTTP — santé, liste publique, administration, fichier du jeu
   ======================================================================= */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon'
};

function envoyerJson(res, code, obj) {
  const corps = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(corps),
    // le jeu est servi depuis un autre domaine : il doit pouvoir lire /rooms
    'Access-Control-Allow-Origin': ORIGINES.length ? ORIGINES[0] : '*',
    'Cache-Control': 'no-store'
  });
  res.end(corps);
}

const serveur = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const chemin = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': ORIGINES.length ? ORIGINES[0] : '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  /* Sonde de vie : c'est elle que surveillent Railway, Render et
     UptimeRobot pour ne pas endormir le service.                      */
  if (chemin === '/health' || chemin === '/healthz') {
    return envoyerJson(res, 200, {
      status: 'ok',
      protocole: PROTOCOLE,
      salles: HUB.salles.size,
      joueurs: HUB.joueurs.size,
      uptime: Math.round(process.uptime()),
      tick: TICK_HZ,
      // mémoire résidente en Mo : de quoi surveiller une fuite sans outil
      memoire: Math.round(process.memoryUsage().rss / 1048576),
      base: db.actif() ? 'connectee' : 'memoire'
    });
  }

  /* Liste publique des salles, pour afficher le lobby avant même
     d'ouvrir une WebSocket.                                            */
  if (chemin === '/rooms') {
    return envoyerJson(res, 200, { salles: HUB.liste(url.searchParams.get('mode') || '') });
  }

  /* Classement persistant, si une base est configurée. */
  if (chemin === '/classement') {
    return db.classement(url.searchParams.get('mode') || '', 20)
      .then(l => envoyerJson(res, 200, { classement: l }))
      .catch(e => envoyerJson(res, 200, { classement: [], erreur: e.message }));
  }

  /* Administration : protégée par ADMIN_SECRET, jamais exposée sans clé. */
  if (chemin.startsWith('/admin/')) {
    if (!ADMIN_SECRET || url.searchParams.get('secret') !== ADMIN_SECRET)
      return envoyerJson(res, 403, { erreur: 'interdit' });
    if (chemin === '/admin/salles') {
      return envoyerJson(res, 200, {
        salles: [...HUB.salles.values()].map(s => ({
          code: s.code, nom: s.nom, mode: s.mode, phase: s.phase, seed: s.seed,
          heure: Math.round(s.tJour * 1000) / 1000, meteo: s.meteo,
          joueurs: [...s.joueurs.values()].map(j => ({
            id: j.id, pseudo: j.pseudo, equipe: j.equipe, score: j.score,
            x: Math.round(j.x), y: Math.round(j.y), hp: Math.round(j.hp),
            suspects: j.suspects, latence: j.latence
          }))
        }))
      });
    }
    if (chemin === '/admin/journal') return envoyerJson(res, 200, { journal: JOURNAL });
    return envoyerJson(res, 404, { erreur: 'inconnu' });
  }

  /* En local, ce serveur sert aussi le fichier du jeu : un seul
     processus à lancer pour tester à plusieurs sur le réseau local.
     En ligne, le jeu est servi par Vercel ou Netlify (SERVE_STATIC=0).  */
  if (!SERVE_STATIC) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Serveur de jeu Liberty Lake — le client est hébergé ailleurs. Voir /health');
  }
  const demande = chemin === '/' ? '/liberty-lake.html' : chemin;
  // jamais de remontée d'arborescence
  const fichier = path.join(__dirname, path.normalize(demande).replace(/^(\.\.[/\\])+/, ''));
  if (!fichier.startsWith(__dirname)) {
    res.writeHead(403); return res.end('interdit');
  }
  fs.readFile(fichier, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Introuvable');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(fichier).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      // en-têtes utiles aux performances du canvas
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    });
    res.end(buf);
  });
});

/* =======================================================================
   SERVEUR WEBSOCKET — même port que le HTTP
   ======================================================================= */
const wss = new WebSocketServer({
  server: serveur,
  path: '/ws',
  maxPayload: LIM.tailleMsg,
  /* Contrôle d'origine : seules les origines déclarées peuvent ouvrir
     une partie quand ALLOWED_ORIGIN est renseigné.                     */
  verifyClient: (info, accepter) => {
    if (!ORIGINES.length) return accepter(true);
    const o = info.origin || '';
    if (ORIGINES.includes(o)) return accepter(true);
    log('WARN', 'origine refusee', o || '(vide)');
    accepter(false, 403, 'origine non autorisée');
  }
});

wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress || '?';
  // plusieurs onglets depuis la même maison, oui ; cent, non
  let memeIp = 0;
  for (const j of HUB.joueurs) if (j.ip === ip) memeIp++;
  if (memeIp >= LIM.joueursParIP) {
    try { ws.send(JSON.stringify({ t: 'KICK', raison: 'Trop de connexions depuis cette adresse' })); } catch (e) { }
    return ws.close(4004, 'trop de connexions');
  }

  const j = new Joueur(ws, ip);
  HUB.joueurs.add(j);
  ws.estVivant = true;
  ws.on('pong', () => { ws.estVivant = true; });
  log('INFO', 'connexion', { id: j.id, ip });

  j.envoyer({
    t: 'BIENVENUE', id: j.id, protocole: PROTOCOLE, tick: TICK_HZ,
    modes: Object.keys(MODES).map(k => ({
      id: k, nom: MODES[k].nom, min: MODES[k].min, max: MODES[k].max,
      duree: MODES[k].duree, equipes: MODES[k].equipes, desc: MODES[k].desc,
      /* `camps: true` = le joueur choisit son côté dans le salon de CE
         mode ; `manches: true` = partie découpée en manches.          */
      camps: !!MODES[k].camps, manches: !!MODES[k].manches
    })),
    formats: { battle: BATTLE_FORMATS, poursuite: POURSUITE_FORMATS },
    extractions: EXTRACTIONS,
    // nombre de joueurs en ligne par mode, pour les tuiles du menu
    enLigne: (() => {
      const n = {};
      for (const s of HUB.salles.values()) n[s.mode] = (n[s.mode] || 0) + s.joueurs.size;
      return n;
    })(),
    sallesParMode: (() => {
      const n = {};
      for (const s of HUB.salles.values()) n[s.mode] = (n[s.mode] || 0) + 1;
      return n;
    })(),
    salles: HUB.liste('')
  });

  ws.on('message', brut => {
    j.vuLe = Date.now();
    // --- limitation de cadence ---
    const t = Date.now();
    if (t - j.msgT > 1000) { j.msgT = t; j.msgN = 0; }
    if (++j.msgN > LIM.msgParSec) {
      if (++j.avert > LIM.avertMax) {
        log('WARN', 'inondation', { id: j.id, pseudo: j.pseudo, msgs: j.msgN });
        return j.expulser('Trop de messages par seconde');
      }
      return;                                    // on jette le surplus
    }
    if (brut.length > LIM.tailleMsg) return j.expulser('Message trop volumineux');

    let m;
    try { m = JSON.parse(brut); } catch (e) { return; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    try { router(j, m); } catch (e) { log('ERR', 'message ' + m.t, e.message); }
  });

  ws.on('close', () => {
    if (j.salle) j.salle.retirer(j);
    HUB.joueurs.delete(j);
    log('INFO', 'deconnexion', { id: j.id, pseudo: j.pseudo });
  });
  ws.on('error', e => log('WARN', 'socket', e.message));
});

/* Aiguillage des messages client → serveur. */
function router(j, m) {
  switch (m.t) {
    case 'PING':
      // mesure de latence et maintien en vie du service
      j.envoyer({ t: 'PONG', ts: nombre(m.ts, 0), serveur: Date.now() });
      if (m.rtt !== undefined) j.latence = clamp(Math.round(nombre(m.rtt, 0)), 0, 5000);
      return;

    case 'LIST':
      j.envoyer({ t: 'ROOMS', salles: HUB.liste(propre(m.mode, 12)) });
      return;

    case 'CREATE': {
      if (j.salle) j.salle.retirer(j);
      const mode = MODES[m.mode] ? m.mode : 'coop';
      const d = MODES[mode];
      const pseudo = propre(m.pseudo, LIM.pseudoLong) || 'Anonyme';
      const def = {
        nom: propre(m.nom, 28) || ('Salle de ' + pseudo),
        mode,
        max: clamp(Math.round(nombre(m.max, d.max)), d.min, d.max),
        seed: clamp(Math.round(nombre(m.seed, Math.floor(Math.random() * 4294967295))), 0, 4294967295),
        motdepasse: propre(m.motdepasse, 24),
        options: {
          feuAmi: m.feuAmi !== undefined ? !!m.feuAmi : d.feuAmi,
          equipes: !!m.equipes,
          filtre: m.filtre !== undefined ? !!m.filtre : true,
          trafic: m.trafic !== undefined ? !!m.trafic : true,
          policeDiff: clamp(Math.round(nombre(m.policeDiff, 1)), 0, 2),
          tours: clamp(Math.round(nombre(m.tours, 2)), 1, 9),
          meteoFixe: typeof m.meteoFixe === 'string' && METEO_SUITES[m.meteoFixe] ? m.meteoFixe : '',
          heureDepart: clamp(nombre(m.heureDepart, 0.34), 0, 0.999),

          /* --- options du mode BATTLE --- */
          // manches à remporter : 3, 5 ou 7
          manches: parmi(m.manches, [3, 5, 7], 3),
          // durée d'une manche : 90, 120 ou 180 secondes
          dureeManche: parmi(m.dureeManche, [90, 120, 180], 120),
          legendaires: m.legendaires !== undefined ? !!m.legendaires : true,

          /* --- options du mode COURSE POURSUITE --- */
          // durée maximale : 8, 10 ou 15 minutes
          dureeMax: parmi(m.dureeMax, [480, 600, 900], 600),
          // avance des Fugitifs : 20, 30 ou 45 secondes
          avance: parmi(m.avance, [20, 30, 45], 30),
          // fréquence de mise à jour de la minimap des Chasseurs
          majMinimap: parmi(m.majMinimap, [10, 15, 30], 15),
          // variante d'extraction : vide = tirée au sort au lancement
          variante: typeof m.variante === 'string' && EXTRACTIONS.some(e => e.id === m.variante) ? m.variante : '',
          // format annoncé dans la liste des salles (2v2, 3v3…)
          format: propre(m.format, 6)
        }
      };
      /* Le format impose l'effectif : 2v2 = 4 joueurs, 5v5 = 10. */
      const formats = mode === 'battle' ? BATTLE_FORMATS : mode === 'poursuite' ? POURSUITE_FORMATS : null;
      if (formats && formats[def.options.format]) def.max = formats[def.options.format];
      const s = HUB.creer(def);
      if (!s) { j.envoyer({ t: 'EVENT', type: 'refus', d: { txt: 'Serveur saturé, réessayez plus tard' } }); return; }
      const err = s.ajouter(j, pseudo);
      if (err) j.envoyer({ t: 'EVENT', type: 'refus', d: { txt: err } });
      return;
    }

    case 'JOIN': {
      const s = HUB.salles.get(propre(String(m.salle || ''), 8).toUpperCase());
      if (!s) { j.envoyer({ t: 'EVENT', type: 'refus', d: { txt: 'Salle introuvable' } }); return; }
      if (s.motdepasse && propre(m.motdepasse, 24) !== s.motdepasse) {
        j.envoyer({ t: 'EVENT', type: 'refus', d: { txt: 'Mot de passe incorrect' } });
        return;
      }
      if (j.salle) j.salle.retirer(j);
      const err = s.ajouter(j, propre(m.pseudo, LIM.pseudoLong) || 'Anonyme');
      if (err) j.envoyer({ t: 'EVENT', type: 'refus', d: { txt: err } });
      return;
    }

    case 'LEAVE':
      if (j.salle) j.salle.retirer(j);
      j.envoyer({ t: 'ROOMS', salles: HUB.liste('') });
      return;

    case 'READY':
      if (!j.salle) return;
      j.pret = !!m.v;
      j.salle.diffuserSalon();
      // tout le monde prêt : l'hôte voit le départ possible, on lance
      if (j.salle.phase === 'attente' && j.salle.joueurs.size >= j.salle.def().min &&
        [...j.salle.joueurs.values()].every(p => p.pret || p.id === j.salle.hote)) {
        const hote = j.salle.joueurs.get(j.salle.hote);
        if (hote) hote.envoyer({ t: 'EVENT', type: 'tousprets', d: {} });
      }
      return;

    /* Choix de camp : n'existe que dans une salle de course poursuite,
       et seulement avant le lancement. Aucun autre mode ne l'accepte. */
    case 'CAMP': if (j.salle) j.salle.choisirCamp(j, m); return;

    case 'GEOMETRIE': if (j.salle) j.salle.recevoirGeometrie(j, m); return;
    case 'START': if (j.salle) j.salle.lancer(j); return;
    case 'OPTIONS': if (j.salle) j.salle.majOptions(j, m); return;
    case 'EXPEL': if (j.salle) j.salle.expulserJoueur(j, m); return;
    case 'INPUT': if (j.salle) j.salle.input(j, m); return;
    case 'SHOOT': if (j.salle) j.salle.tir(j, m); return;
    case 'TOUCHE': if (j.salle) j.salle.touche(j, m); return;
    case 'INTERACT': if (j.salle) j.salle.interagir(j, m); return;
    case 'CHAT': if (j.salle) j.salle.chat(j, m); return;

    case 'MORT':
      // mort causée par l'environnement ou la police locale
      if (j.salle) j.salle.tuer(j, null, propre(m.cause, 24) || 'blessures');
      return;

    case 'PROFIL':
      // sauvegarde optionnelle importée par le joueur en arrivant
      db.sauverProfil(propre(m.pseudo, LIM.pseudoLong), m.donnees)
        .catch(e => log('WARN', 'db profil', e.message));
      return;

    default:
      return;                                    // type inconnu : ignoré
  }
}

/* Ménage : sockets muettes, salles vides, salles fantômes. */
setInterval(() => {
  const t = Date.now();
  for (const j of HUB.joueurs) {
    if (j.ws.readyState !== 1) continue;
    if (t - j.vuLe > LIM.inactivite) { j.expulser('Inactivité'); continue; }
    if (j.ws.estVivant === false) { try { j.ws.terminate(); } catch (e) { } continue; }
    j.ws.estVivant = false;
    try { j.ws.ping(); } catch (e) { }
  }
  for (const s of [...HUB.salles.values()]) {
    if (s.joueurs.size === 0 && t - s.creee > 60000) HUB.fermer(s.code);
  }
}, 10000);

/* Arrêt propre : on avertit les joueurs plutôt que de couper net. */
function arreter(signal) {
  log('INFO', 'arret', signal);
  for (const j of HUB.joueurs) j.envoyer({ t: 'KICK', raison: 'Le serveur redémarre' });
  for (const s of [...HUB.salles.values()]) s.arreterBoucle();
  wss.close(() => serveur.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', () => arreter('SIGTERM'));
process.on('SIGINT', () => arreter('SIGINT'));
process.on('uncaughtException', e => log('ERR', 'exception non capturée', e.stack || e.message));
process.on('unhandledRejection', e => log('ERR', 'promesse rejetée', (e && e.message) || String(e)));

db.init(log);
serveur.listen(PORT, () => {
  log('INFO', 'serveur pret', {
    port: PORT, tick: TICK_HZ, statique: SERVE_STATIC,
    origines: ORIGINES.length ? ORIGINES : '(toutes)',
    base: db.actif() ? 'connectee' : 'memoire'
  });
  console.log('   WebSocket : ws://localhost:' + PORT + '/ws');
  console.log('   Santé     : http://localhost:' + PORT + '/health');
  if (SERVE_STATIC) console.log('   Jeu       : http://localhost:' + PORT + '/');
});
