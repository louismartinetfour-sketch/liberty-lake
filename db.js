'use strict';
/* =======================================================================
   LIBERTY LAKE — PERSISTANCE (optionnelle)
   -----------------------------------------------------------------------
   Base de données accessible en HTTP, donc sans aucune dépendance npm :
   on parle à l'API REST de Supabase avec le fetch natif de Node 18+.

   Variables d'environnement (jamais de clé dans le code) :
     DB_URL   https://xxxxxxxx.supabase.co
     DB_KEY   clé « service_role » du projet Supabase
     DB_TABLE_PARTIES   defaut : parties
     DB_TABLE_PROFILS   defaut : profils

   Sans DB_URL, tout fonctionne en mémoire : le serveur tourne, les
   parties se jouent, seule la persistance entre redémarrages est perdue.
   Aucun appel à ce module ne peut faire tomber une partie : tout est
   enveloppé, borné dans le temps, et échoue en silence journalisé.

   Tables attendues (SQL de création dans docs/HEBERGEMENT.md) :
     parties  (code, mode, seed, raison, duree, classement jsonb, creee)
     profils  (pseudo primary key, donnees jsonb, maj)
   ======================================================================= */

const URL_BASE = (process.env.DB_URL || '').replace(/\/+$/, '');
const CLE = process.env.DB_KEY || '';
const T_PARTIES = process.env.DB_TABLE_PARTIES || 'parties';
const T_PROFILS = process.env.DB_TABLE_PROFILS || 'profils';
const DELAI = 6000;                       // ms : au-delà, on abandonne

let journaliser = (n, s, d) => console.log('[' + n + '] ' + s + ' ' + (d || ''));
let disponible = false;

function actif() { return disponible; }

function init(log) {
  if (log) journaliser = log;
  if (!URL_BASE || !CLE) {
    journaliser('INFO', 'base de donnees', 'DB_URL absente : persistance desactivee (mode memoire)');
    disponible = false;
    return;
  }
  if (typeof fetch !== 'function') {
    journaliser('WARN', 'base de donnees', 'fetch indisponible : Node 18+ requis');
    disponible = false;
    return;
  }
  disponible = true;
  journaliser('INFO', 'base de donnees', 'Supabase REST configuree');
}

/* Appel REST borné dans le temps. Renvoie toujours une promesse résolue
   avec les données, ou rejetée avec un message court et lisible.       */
async function appel(chemin, options) {
  if (!disponible) throw new Error('persistance desactivee');
  const ctrl = new AbortController();
  const minuteur = setTimeout(() => ctrl.abort(), DELAI);
  try {
    const r = await fetch(URL_BASE + '/rest/v1/' + chemin, Object.assign({
      signal: ctrl.signal,
      headers: Object.assign({
        'apikey': CLE,
        'Authorization': 'Bearer ' + CLE,
        'Content-Type': 'application/json'
      }, (options && options.headers) || {})
    }, options || {}));
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 180));
    const txt = await r.text();
    return txt ? JSON.parse(txt) : null;
  } finally {
    clearTimeout(minuteur);
  }
}

/* Archive une partie terminée avec son classement. */
async function enregistrerPartie(p) {
  if (!disponible) return null;
  return appel(T_PARTIES, {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      code: p.code, mode: p.mode, seed: p.seed, raison: p.raison,
      duree: p.duree, classement: p.classement, creee: new Date().toISOString()
    })
  });
}

/* Sauvegarde / lecture du profil d'un joueur (progression importée).
   Les données viennent du client : on borne la taille avant d'écrire.  */
async function sauverProfil(pseudo, donnees) {
  if (!disponible || !pseudo) return null;
  const brut = JSON.stringify(donnees === undefined ? null : donnees);
  if (brut && brut.length > 20000) throw new Error('profil trop volumineux');
  return appel(T_PROFILS + '?on_conflict=pseudo', {
    method: 'POST',
    headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ pseudo, donnees: JSON.parse(brut), maj: new Date().toISOString() })
  });
}

async function chargerProfil(pseudo) {
  if (!disponible || !pseudo) return null;
  const l = await appel(T_PROFILS + '?pseudo=eq.' + encodeURIComponent(pseudo) + '&select=donnees&limit=1');
  return l && l[0] ? l[0].donnees : null;
}

/* Meilleurs scores, tous modes ou un seul. Le classement est stocké en
   JSON dans la partie : on l'aplatit ici pour le lobby.                */
async function classement(mode, limite) {
  if (!disponible) return [];
  const q = T_PARTIES + '?select=mode,classement,creee' +
    (mode ? '&mode=eq.' + encodeURIComponent(mode) : '') +
    '&order=creee.desc&limit=' + Math.min(200, Math.max(1, limite || 20));
  const parties = await appel(q);
  const plat = [];
  for (const p of parties || []) {
    for (const c of p.classement || []) {
      plat.push({ pseudo: c.pseudo, mode: p.mode, score: c.score, kills: c.kills, place: c.place, date: p.creee });
    }
  }
  plat.sort((a, b) => b.score - a.score);
  return plat.slice(0, Math.min(100, limite || 20));
}

module.exports = { init, actif, enregistrerPartie, sauverProfil, chargerProfil, classement };
