/* =====================================================================
   Banc d'essai du protocole multijoueur de Liberty Lake.
   114 contrôles : salles, mots de passe, lancement, validation des
   positions, dégâts, chat, verrou des véhicules, modes course et
   police, limitation de cadence, messages malformés, puis les deux
   modes ajoutés — BATTLE (arène, manches, armes aléatoires, résultats)
   et COURSE POURSUITE (choix de camp, avance, traque asymétrique,
   extraction, récompenses).

   Lancement (le serveur doit tourner à côté) :
     MAX_PAR_IP=64 node server.js   &
     node test/protocole.test.js

   MAX_PAR_IP est relevé parce que tous les clients simulés viennent de
   la même adresse ; en exploitation, la limite par défaut (8) protège
   contre l'inondation de connexions.
   ===================================================================== */
const WebSocket = require('ws');
const URL = 'ws://localhost:3000/ws';
const attendre = ms => new Promise(r => setTimeout(r, ms));

function client(nom) {
  const ws = new WebSocket(URL);
  const c = { nom, ws, recus: [], id: null, code: null, init: null, ticks: 0, corrections: 0, fins: [] };
  ws.on('message', b => {
    const m = JSON.parse(b);
    if (m.t === 'TICK') { c.ticks++; c.dernierTick = m; return; }
    // MODE arrive cinq fois par seconde : on n'en garde que le dernier
    if (m.t === 'MODE') { c.mode = m; c.modes = (c.modes || 0) + 1; return; }
    if (m.t === 'MODE_INIT') c.modeInit = m;
    c.recus.push(m);
    if (m.t === 'BIENVENUE') c.id = m.id;
    if (m.t === 'SALLE') c.code = m.code;
    if (m.t === 'WORLD_INIT') c.init = m;
    if (m.t === 'CORRECTION') c.corrections++;
    if (m.t === 'FIN') c.fins.push(m);
    if (m.t === 'KICK') c.kick = m.raison;
  });
  c.envoyer = o => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  c.pret = new Promise(r => ws.on('open', r));
  c.type = t => c.recus.filter(m => m.t === t);
  c.evt = ty => c.recus.filter(m => m.t === 'EVENT' && m.type === ty);
  return c;
}

/* Déplacement progressif. Le serveur refuse les sauts : on avance par
   pas de 80 px, comme le ferait un client honnête.                    */
function marcheur(c, hp) {
  const etat = { seq: 10000 };
  return async (x, y, pas) => {
    for (let garde = 0; garde < 260; garde++) {
      const p = c.dernierTick ? c.dernierTick.moi : { x, y };
      const dx = x - p.x, dy = y - p.y, d = Math.hypot(dx, dy);
      if (d < 36) break;
      const k = Math.min(1, (pas || 80) / d);
      c.envoyer({
        t: 'INPUT', seq: etat.seq++,
        x: Math.round(p.x + dx * k), y: Math.round(p.y + dy * k),
        a: 0, m: 0, hp: hp || 100
      });
      await attendre(55);
    }
  };
}

(async () => {
  const ok = [], ko = [];
  const V = (cond, txt) => (cond ? ok : ko).push(txt);

  const a = client('Alice'), b = client('Bob');
  await Promise.all([a.pret, b.pret]);
  await attendre(200);
  V(a.type('BIENVENUE').length === 1, 'BIENVENUE reçu');
  V(a.type('BIENVENUE')[0].modes.length === 6, 'six modes annoncés');

  // --- création de salle ---
  a.envoyer({ t: 'CREATE', pseudo: 'Alice', nom: 'Essai', mode: 'coop', max: 8, seed: 1337 });
  await attendre(250);
  V(!!a.code, 'salle créée, code ' + a.code);
  const salon = a.type('SALLE').pop();
  V(salon && salon.hote === a.id, 'le créateur est hôte');

  // --- géométrie envoyée par l'hôte ---
  a.envoyer({
    t: 'GEOMETRIE',
    spawns: [{ x: 2600, y: 2600 }, { x: 2700, y: 2700 }],
    checkpoints: [{ x: 2600, y: 2600, r: 100 }, { x: 3000, y: 2600, r: 100 }],
    extraction: { x: 5000, y: 5000, r: 200 }
  });
  // --- deuxième joueur ---
  b.envoyer({ t: 'JOIN', salle: a.code, pseudo: 'Bob' });
  await attendre(250);
  V(b.type('SALLE').length > 0, 'Bob reçoit le salon');
  V(b.type('SALLE').pop().joueurs.length === 2, 'deux joueurs dans le salon');
  V(b.type('SALLE').pop().joueurs[1].couleur !== b.type('SALLE').pop().joueurs[0].couleur, 'couleurs distinctes');

  // --- mot de passe ---
  const c3 = client('Carl'); await c3.pret;
  c3.envoyer({ t: 'CREATE', pseudo: 'Carl', nom: 'Privee', mode: 'bataille', motdepasse: 'abc' });
  await attendre(200);
  const codePrive = c3.code;
  const d4 = client('Dora'); await d4.pret;
  d4.envoyer({ t: 'JOIN', salle: codePrive, pseudo: 'Dora', motdepasse: 'faux' });
  await attendre(200);
  V(d4.evt('refus').length === 1, 'mot de passe incorrect refusé');
  d4.envoyer({ t: 'JOIN', salle: codePrive, pseudo: 'Dora', motdepasse: 'abc' });
  await attendre(200);
  V(d4.type('SALLE').length > 0, 'bon mot de passe accepté');

  // --- liste des salles ---
  a.envoyer({ t: 'LIST' });
  await attendre(200);
  const rooms = a.type('ROOMS').pop();
  V(rooms.salles.length >= 2, 'liste des salles : ' + rooms.salles.length);
  V(rooms.salles.every(s => s.motdepasse === undefined), 'aucun mot de passe divulgué');
  V(rooms.salles.find(s => s.code === codePrive).prive === true, 'salle privée signalée');

  // --- lancement ---
  a.envoyer({ t: 'START' });
  await attendre(6500);
  V(!!a.init && !!b.init, 'WORLD_INIT reçu par les deux');
  V(a.init.seed === 1337, 'graine partagée : ' + a.init.seed);
  V(a.init.depart && a.init.depart.x > 0, 'point de départ fourni');
  V(a.ticks > 20, 'ticks reçus : ' + a.ticks);

  // --- mouvement légitime ---
  let x = a.init.depart.x, y = a.init.depart.y, seq = 1;
  for (let i = 0; i < 20; i++) {
    x += 2.5; // ~50 px/s à 20 Hz : largement sous la limite à pied
    a.envoyer({ t: 'INPUT', seq: seq++, x, y, a: 0, m: 0, hp: 100 });
    await attendre(50);
  }
  V(a.corrections === 0, 'mouvement normal accepté (0 correction)');
  const moi = a.dernierTick.moi;
  V(Math.abs(moi.x - x) < 5, 'position suivie par le serveur');

  // --- téléportation refusée ---
  a.envoyer({ t: 'INPUT', seq: seq++, x: 9000, y: 9000, a: 0, m: 0, hp: 100 });
  await attendre(200);
  V(a.corrections === 1, 'téléportation corrigée');
  const corr = a.type('CORRECTION').pop();
  V(Math.abs(corr.x - x) < 6, 'correction renvoie la dernière position valide');

  // --- hors du monde ---
  a.envoyer({ t: 'INPUT', seq: seq++, x: -500, y: 2600, a: 0, m: 0, hp: 100 });
  await attendre(200);
  V(a.corrections === 2, 'position hors du monde refusée');

  // --- séquence rejouée ignorée ---
  const avant = a.corrections;
  a.envoyer({ t: 'INPUT', seq: 2, x: 9999, y: 9999 });
  await attendre(150);
  V(a.corrections === avant, 'paquet rejoué ignoré sans correction');

  // --- chat ---
  b.envoyer({ t: 'CHAT', texte: 'salut la compagnie' });
  await attendre(200);
  V(a.type('CHAT').some(m => m.texte === 'salut la compagnie'), 'chat diffusé');
  b.envoyer({ t: 'CHAT', texte: 'espèce de connard' });
  await attendre(200);
  V(a.type('CHAT').some(m => /c\*+/.test(m.texte)), 'filtre grossièreté appliqué');
  await attendre(1100);
  b.envoyer({ t: 'CHAT', texte: '<script>alert(1)</script>' });
  await attendre(200);
  V(a.type('CHAT').some(m => m.texte.indexOf('<') === -1 && m.texte.indexOf('script') >= 0), 'balises retirées du chat');
  await attendre(1100);
  b.envoyer({ t: 'CHAT', texte: 'privé pour toi', canal: 'prive', vers: 'Alice' });
  await attendre(200);
  V(a.type('CHAT').some(m => m.canal === 'prive'), 'chuchotement livré');

  // --- dégâts validés ---
  // Bob se place à portée d'Alice puis tire
  b.envoyer({ t: 'INPUT', seq: 1, x: x + 80, y: y, a: 0, m: 0, hp: 100 });
  await attendre(150);
  const hpAvant = a.dernierTick.moi.h;
  b.envoyer({ t: 'TOUCHE', cible: a.id, arme: 'pistol', degats: 15 });
  await attendre(250);
  V(a.dernierTick.moi.h < hpAvant, 'dégâts appliqués : ' + hpAvant + ' → ' + a.dernierTick.moi.h);
  // dégâts exagérés : bornés à ceux de l'arme
  const hp2 = a.dernierTick.moi.h;
  b.envoyer({ t: 'TOUCHE', cible: a.id, arme: 'pistol', degats: 9999 });
  await attendre(250);
  V(hp2 - a.dernierTick.moi.h <= 17, 'dégâts bornés au maximum de l\'arme');
  // hors de portée : ignoré
  b.envoyer({ t: 'INPUT', seq: 2, x: x + 100, y: y, a: 0, m: 0, hp: 100 });
  await attendre(120);
  const hp3 = a.dernierTick.moi.h;
  b.envoyer({ t: 'TOUCHE', cible: a.id, arme: 'fists', degats: 7 });
  await attendre(250);
  V(a.dernierTick.moi.h === hp3, 'coup de poing à 100 px ignoré');

  // --- feu ami en coop : interdit ---
  V(a.init.feuAmi === false, 'feu ami désactivé en coop');

  // --- verrou de véhicule ---
  a.envoyer({ t: 'INTERACT', type: 'monter', cible: 'v42', kind: 'civil', x: a.dernierTick.moi.x, y: a.dernierTick.moi.y });
  await attendre(200);
  V(b.evt('monte').some(m => m.d.veh === 'v42'), 'montée diffusée');
  b.envoyer({ t: 'INTERACT', type: 'monter', cible: 'v42', kind: 'civil', x: b.dernierTick.moi.x, y: b.dernierTick.moi.y });
  await attendre(200);
  V(b.evt('refus').some(m => /occup/.test(m.d.txt)), 'véhicule déjà occupé refusé');

  // --- argent borné ---
  a.envoyer({ t: 'INTERACT', type: 'argent', montant: 500 });
  await attendre(150);
  a.envoyer({ t: 'INTERACT', type: 'argent', montant: 999999 });
  await attendre(200);
  V(a.dernierTick.moi.s > 0, 'gain légitime crédité (score ' + a.dernierTick.moi.s + ')');

  // --- étoiles bornées ---
  a.envoyer({ t: 'INTERACT', type: 'etoiles', cible: 99 });
  await attendre(200);
  V(a.dernierTick.moi.e <= 5, 'étoiles plafonnées à ' + a.dernierTick.moi.e);

  // --- mort et réapparition ---
  const e = client('Eve'); await e.pret;
  e.envoyer({ t: 'JOIN', salle: a.code, pseudo: 'Eve' });
  await attendre(300);
  e.envoyer({ t: 'MORT', cause: 'noyade' });
  await attendre(300);
  V(a.evt('mort').some(m => m.d.pseudo === 'Eve'), 'mort diffusée');

  // --- heure et météo partagées ---
  V(a.dernierTick.heure > 0 && a.dernierTick.heure < 1, 'heure du monde diffusée : ' + a.dernierTick.heure);
  V(Math.abs(a.dernierTick.heure - b.dernierTick.heure) < 0.01, 'même heure pour tous');

  // --- expulsion par l'hôte ---
  a.envoyer({ t: 'EXPEL', id: e.id });
  await attendre(300);
  V(e.kick !== undefined, 'expulsion par l\'hôte : ' + e.kick);

  // --- inondation ---
  const f = client('Flood'); await f.pret;
  f.envoyer({ t: 'JOIN', salle: a.code, pseudo: 'Flood' });
  await attendre(200);
  for (let i = 0; i < 700; i++) f.envoyer({ t: 'PING', ts: i });
  await attendre(1200);
  for (let i = 0; i < 700; i++) f.envoyer({ t: 'PING', ts: i });
  await attendre(1200);
  for (let i = 0; i < 700; i++) f.envoyer({ t: 'PING', ts: i });
  await attendre(1200);
  for (let i = 0; i < 700; i++) f.envoyer({ t: 'PING', ts: i });
  await attendre(1500);
  V(f.kick !== undefined, 'inondation sanctionnée : ' + f.kick);

  // --- message malformé : pas de plantage ---
  a.ws.send('ceci n est pas du json');
  a.ws.send(JSON.stringify({ t: 'INPUT', x: 'abc', y: null, seq: 'zz' }));
  a.ws.send(JSON.stringify({ t: 'TYPE_INCONNU' }));
  a.ws.send(JSON.stringify(null));
  await attendre(400);
  V(a.ticks > 0 && !a.kick, 'messages malformés absorbés');

  // --- course : tours et classement ---
  const g = client('Pilote'); await g.pret;
  g.envoyer({ t: 'CREATE', pseudo: 'Pilote', mode: 'course', seed: 77, tours: 1 });
  await attendre(250);
  g.envoyer({
    t: 'GEOMETRIE', spawns: [{ x: 1000, y: 1000 }],
    checkpoints: [{ x: 1000, y: 1000, r: 120 }, { x: 1400, y: 1000, r: 120 }]
  });
  await attendre(150);
  g.envoyer({ t: 'START' });
  await attendre(6500);
  V(!!g.init, 'course lancée');
  // on roule du checkpoint 1 vers le 0 pour boucler un tour
  let gx = g.init.depart.x, gy = g.init.depart.y, gs = 1;
  const allerVers = async (tx, ty) => {
    for (let i = 0; i < 60; i++) {
      const dx = tx - gx, dy = ty - gy, d = Math.hypot(dx, dy);
      if (d < 20) break;
      const pas = Math.min(d, 20);
      gx += dx / d * pas; gy += dy / d * pas;
      g.envoyer({ t: 'INPUT', seq: gs++, x: gx, y: gy, a: 0, m: 0, hp: 100, veh: true });
      await attendre(50);
    }
  };
  await allerVers(1400, 1000);
  await attendre(200);
  V(g.evt('checkpoint').length > 0, 'checkpoint franchi');
  await allerVers(1000, 1000);
  await attendre(400);
  V(g.evt('tour').length > 0 || g.fins.length > 0, 'tour boucle');
  V(g.fins.length > 0, 'course terminée, classement reçu');
  if (g.fins.length) V(g.fins[0].classement[0].pseudo === 'Pilote', 'classement nommé');

  // --- police contre fugitifs : répartition des équipes ---
  const p1 = client('Flic'), p2 = client('Fuyard'), p3 = client('Fuyard2');
  await Promise.all([p1.pret, p2.pret, p3.pret]);
  p1.envoyer({ t: 'CREATE', pseudo: 'Flic', mode: 'police', seed: 9 });
  await attendre(250);
  p1.envoyer({ t: 'GEOMETRIE', spawns: [{ x: 2000, y: 2000 }, { x: 2100, y: 2100 }, { x: 4000, y: 4000 }], extraction: { x: 2400, y: 2000, r: 150 } });
  p2.envoyer({ t: 'JOIN', salle: p1.code, pseudo: 'Fuyard' });
  p3.envoyer({ t: 'JOIN', salle: p1.code, pseudo: 'Fuyard2' });
  await attendre(300);
  p1.envoyer({ t: 'START' });
  await attendre(6500);
  const eq = [p1, p2, p3].map(c => c.init && c.init.equipe);
  V(eq.filter(e => e === 1).length === 1, 'une seule police sur trois joueurs');
  V(eq.filter(e => e === 2).length === 2, 'deux fugitifs');
  const fug = [p1, p2, p3].find(c => c.init.equipe === 2);
  V(fug.dernierTick.moi.e === 5, 'fugitif à 5 étoiles au départ');

  /* ===================================================================
     MODE BATTLE — manches, arène, armes aléatoires, résultats
     =================================================================== */
  const zones = [];
  for (let i = 0; i < 25; i++) zones.push({ x: 2100 + (i % 5) * 260, y: 2100 + Math.floor(i / 5) * 260 });
  const arene = {
    rect: { x: 2000, y: 2000, w: 1500, h: 1500 },
    centre: { x: 2750, y: 2750 },
    bases: [
      { x: 2180, y: 2180, r: 150, coffre: { x: 2250, y: 2180 }, soin: { x: 2180, y: 2250 } },
      { x: 3320, y: 3320, r: 150, coffre: { x: 3250, y: 3320 }, soin: { x: 3320, y: 3250 } }
    ],
    zones
  };
  const r1 = client('Rouge'), r2 = client('Bleu');
  await Promise.all([r1.pret, r2.pret]);
  r1.envoyer({
    t: 'CREATE', pseudo: 'Rouge', nom: 'Arène', mode: 'battle', seed: 4242,
    manches: 3, dureeManche: 90, legendaires: true, format: '2v2'
  });
  await attendre(250);
  V(!!r1.code, 'salle battle créée');
  const infoB = r1.type('SALLE').pop();
  V(infoB && infoB.max === 4, 'format 2v2 impose quatre joueurs (max ' + (infoB && infoB.max) + ')');

  // sans arène, le lancement est refusé
  r2.envoyer({ t: 'JOIN', salle: r1.code, pseudo: 'Bleu' });
  await attendre(250);
  r1.envoyer({ t: 'START' });
  await attendre(250);
  V(r1.evt('refus').some(e => /arène/i.test(e.d.txt)), 'lancement refusé sans arène tracée');

  r1.envoyer({ t: 'GEOMETRIE', spawns: [{ x: 2180, y: 2180 }, { x: 3320, y: 3320 }], arene });
  await attendre(250);
  const salonB = r1.type('SALLE').pop();
  V(salonB && salonB.arenePrete === true, 'arène reçue et signalée dans le salon');
  V(salonB && salonB.camps === undefined, 'aucun choix de camp proposé en battle');

  // le choix de camp est refusé hors course poursuite
  r1.envoyer({ t: 'CAMP', camp: 1 });
  await attendre(200);
  V(r1.evt('refus').some(e => /camp/i.test(e.d.txt)), 'CAMP refusé dans un mode sans camp');

  r1.envoyer({ t: 'START' });
  await attendre(6200);
  V(!!r1.modeInit && r1.modeInit.mode === 'battle', 'MODE_INIT battle reçu');
  V(r1.modeInit && r1.modeInit.manches === 3, 'manches à gagner transmises');
  const eqB = [r1.modeInit.equipe, r2.modeInit.equipe].sort().join();
  V(eqB === '1,2', 'équipes formées par le serveur, une par camp');
  const m1 = r1.evt('manche-debut').pop();
  V(!!m1 && m1.d.manche === 1, 'manche 1 ouverte');
  V(m1 && m1.d.armes.length >= 15 && m1.d.armes.length <= 25,
    'armes au sol : ' + (m1 && m1.d.armes.length) + ' (15 à 25)');
  const leg = m1 ? m1.d.armes.filter(a => a.rarete === 'legendaire') : [];
  V(leg.length === 1, 'une seule arme légendaire par manche');
  V(leg.length === 1 && leg[0].x === 2750 && leg[0].y === 2750, 'arme légendaire placée au centre');
  V(!!r1.mode && r1.mode.phase === 'gel', 'manche en préparation (gel de 5 s)');
  V(r1.dernierTick && r1.dernierTick.moi.h === 50, 'chaque manche démarre à 50 % de vie');
  V(r1.mode && r1.mode.inventaire.join() === 'knife', 'inventaire réduit au couteau');

  // le gel bloque les déplacements, pas la visée
  const depB = { x: r1.dernierTick.moi.x, y: r1.dernierTick.moi.y };
  for (let i = 0; i < 6; i++) {
    r1.envoyer({ t: 'INPUT', seq: 100 + i, x: depB.x + 300, y: depB.y + 300, a: 1, m: 1, hp: 50 });
    await attendre(60);
  }
  V(Math.hypot(r1.dernierTick.moi.x - depB.x, r1.dernierTick.moi.y - depB.y) < 80,
    'joueur figé dans sa base pendant le décompte');

  await attendre(5200);
  V(r1.mode && r1.mode.phase === 'jeu', 'feu vert : la manche est lancée');
  V(r1.evt('manche-feu').length === 1, 'événement de départ de manche diffusé');

  // sortie de l'arène refusée : on tente un saut vers l'extérieur
  const marcheR1 = marcheur(r1, 50);
  let seqHors = 7000;
  for (let i = 0; i < 12; i++) {
    r1.envoyer({ t: 'INPUT', seq: seqHors++, x: 6000, y: 6000, a: 0, m: 0, hp: 50 });
    await attendre(55);
  }
  V(r1.dernierTick.moi.x <= 3500 && r1.dernierTick.moi.y <= 3500, 'enceinte de l’arène respectée');

  // ramassage d'une arme au sol
  const cible = m1.d.armes.find(a => a.rarete !== 'legendaire');
  await marcheR1(cible.x, cible.y);
  r1.envoyer({ t: 'INTERACT', type: 'arme', cible: cible.id });
  await attendre(400);
  const prise = r1.evt('arme-prise').pop();
  V(!!prise && prise.d.arme === cible.arme, 'arme ramassée : ' + (prise && prise.d.arme));
  V(r1.mode.inventaire.indexOf(cible.arme) >= 0, 'arme ajoutée à l’inventaire autoritaire');
  const loin = m1.d.armes
    .filter(a => a.id !== cible.id)
    .sort((p, q) => Math.hypot(q.x - cible.x, q.y - cible.y) - Math.hypot(p.x - cible.x, p.y - cible.y))[0];
  r1.envoyer({ t: 'INTERACT', type: 'arme', cible: loin.id });
  await attendre(300);
  V(r1.evt('arme-prise').length === 1, 'arme hors de portée non ramassée');

  // aucun véhicule dans l'arène
  r1.envoyer({ t: 'INTERACT', type: 'monter', cible: 'v1', kind: 'sport', x: r1.dernierTick.moi.x, y: r1.dernierTick.moi.y });
  await attendre(250);
  V(r1.evt('refus').some(e => /véhicule/i.test(e.d.txt)), 'véhicules refusés dans l’arène');

  // élimination au couteau : score, MVP, armes lâchées
  const b2 = arene.bases[r2.modeInit.equipe - 1];
  await marcheR1(b2.x, b2.y);
  for (let i = 0; i < 5; i++) {
    r1.envoyer({ t: 'TOUCHE', cible: r2.id, arme: 'knife', degats: 26 });
    await attendre(500);
  }
  await attendre(600);
  V(r2.evt('mort').length > 0 || r1.dernierTick === undefined, 'élimination au couteau validée');
  // au cas où le corps à corps n'ait pas suffi, on force la fin de manche
  if (!r1.evt('manche-fin').length) { r2.envoyer({ t: 'MORT', cause: 'test' }); await attendre(600); }
  const fin1 = r1.evt('manche-fin').pop();
  V(!!fin1, 'fin de manche par élimination totale');
  V(fin1 && fin1.d.gagnant === r1.modeInit.equipe, 'manche attribuée au camp survivant');
  V(fin1 && fin1.d.lignes.length === 2, 'écran de résultats : une ligne par joueur');
  V(fin1 && fin1.d.lignes.some(l => l.mvp), 'MVP de la manche désigné');
  V(fin1 && fin1.d.attente === 10, 'dix secondes de résultats');
  V(fin1 && fin1.d.gagnees[r1.modeInit.equipe] === 1, 'score de manches tenu à jour');

  // la manche suivante réaléatoirise les armes
  await attendre(10800);
  const m2 = r1.evt('manche-debut').pop();
  V(!!m2 && m2.d.manche === 2, 'manche 2 ouverte après les résultats');
  const sig1 = m1.d.armes.map(a => a.x + ':' + a.y).sort().join('|');
  const sig2 = m2 ? m2.d.armes.map(a => a.x + ':' + a.y).sort().join('|') : '';
  V(sig1 !== sig2, 'emplacements d’armes différents de la manche précédente');

  /* ===================================================================
     MODE COURSE POURSUITE — camps, avance, traque, extraction
     =================================================================== */
  const f1 = client('Fugitif'), c1 = client('Chasseur');
  await Promise.all([f1.pret, c1.pret]);
  f1.envoyer({
    t: 'CREATE', pseudo: 'Fugitif', nom: 'Traque', mode: 'poursuite', seed: 55,
    dureeMax: 480, avance: 20, majMinimap: 10, variante: 'fixe', format: '2v2'
  });
  await attendre(250);
  V(!!f1.code, 'salle course poursuite créée');
  f1.envoyer({
    t: 'GEOMETRIE',
    spawns: [{ x: 2000, y: 2000 }, { x: 4500, y: 4500 }],
    departs: [{ x: 2000, y: 2000, nom: 'ville' }, { x: 4500, y: 4500, nom: 'banlieue' }],
    extractions: [{ x: 4600, y: 4600, r: 200, nom: 'banlieue' }],
    barrages: [{ x: 3000, y: 3000 }],
    raccourcis: [{ x: 2500, y: 2500, nom: 'Chemin de terre' }],
    caisses: [{ x: 3300, y: 3300 }]
  });
  c1.envoyer({ t: 'JOIN', salle: f1.code, pseudo: 'Chasseur' });
  await attendre(350);
  const salonP = f1.type('SALLE').pop();
  V(salonP && salonP.camps && salonP.camps.indecis === 2, 'les deux joueurs démarrent sans camp');
  V(salonP && salonP.equilibre === false, 'équipes déclarées déséquilibrées sans choix');

  // lancement refusé tant que les camps ne sont pas choisis
  f1.envoyer({ t: 'START' });
  await attendre(250);
  V(f1.evt('refus').some(e => /camp/i.test(e.d.txt)), 'lancement refusé : joueurs sans camp');

  // deux camps du même côté : toujours refusé
  f1.envoyer({ t: 'CAMP', camp: 1 });
  c1.envoyer({ t: 'CAMP', camp: 1 });
  await attendre(300);
  f1.envoyer({ t: 'START' });
  await attendre(250);
  V(f1.evt('refus').some(e => /chaque camp/i.test(e.d.txt)), 'lancement refusé : un camp vide');

  // un volontaire change de côté
  c1.envoyer({ t: 'CAMP', camp: 2 });
  await attendre(300);
  const salonP2 = f1.type('SALLE').pop();
  V(salonP2 && salonP2.camps[1] === 1 && salonP2.camps[2] === 1, 'compteur de camps : 1 — 1');
  V(salonP2 && salonP2.equilibre === true, 'équipes équilibrées, lancement possible');
  const fiche = salonP2.joueurs.find(j => j.pseudo === 'Chasseur');
  V(fiche && fiche.camp === 2, 'le camp choisi voyage dans la fiche du joueur');

  f1.envoyer({ t: 'START' });
  await attendre(6200);
  V(!!f1.modeInit && f1.modeInit.mode === 'poursuite', 'MODE_INIT course poursuite reçu');
  V(f1.modeInit.equipe === 1 && c1.modeInit.equipe === 2, 'camps choisis respectés au lancement');
  V(f1.modeInit.extraction.variante === 'fixe', 'variante d’extraction imposée respectée');
  V(f1.modeInit.veh.join() === 'sport,moto,berline', 'véhicules rapides pour les Fugitifs');
  V(c1.modeInit.veh.join() === 'suv,muscle,pickup', 'véhicules robustes pour les Chasseurs');
  V(f1.dernierTick.moi.e === 0 && c1.dernierTick.moi.e === 0, 'aucune étoile : police désactivée');

  // le Chasseur est bloqué pendant l'avance du Fugitif
  const depC = { x: c1.dernierTick.moi.x, y: c1.dernierTick.moi.y };
  for (let i = 0; i < 8; i++) {
    c1.envoyer({ t: 'INPUT', seq: 200 + i, x: depC.x + 400, y: depC.y, a: 0, m: 0, hp: 100 });
    await attendre(60);
  }
  V(Math.hypot(c1.dernierTick.moi.x - depC.x, c1.dernierTick.moi.y - depC.y) < 80,
    'Chasseur bloqué pendant l’avance des Fugitifs');
  V(c1.mode && c1.mode.avance > 0, 'compte à rebours d’avance diffusé');

  // le Fugitif, lui, circule librement
  const marcheF = marcheur(f1, 100);
  const marcheC = marcheur(c1, 100);
  await marcheF(2200, 2000);
  V(Math.abs(f1.dernierTick.moi.x - 2200) < 60, 'Fugitif libre de ses mouvements');

  // asymétrie de la minimap
  V(Array.isArray(c1.mode.traque), 'le Chasseur reçoit les positions connues des Fugitifs');
  V(c1.mode.traque.length === 1 && c1.mode.traque[0].age >= 0,
    'position horodatée : vu il y a ' + c1.mode.traque[0].age + ' s');
  V(f1.mode && f1.mode.traque === undefined, 'le Fugitif ne reçoit jamais la position des Chasseurs');
  V(Array.isArray(f1.mode.raccourcis), 'les raccourcis sont réservés aux Fugitifs');

  // on laisse l'avance s'écouler entièrement (20 s d'option)
  while (c1.mode && c1.mode.avance > 0) await attendre(500);
  V(c1.mode.avance === 0, 'les Chasseurs sont lâchés après l’avance');

  // bonus de traque : le Chasseur vient se coller au Fugitif
  await marcheC(f1.dernierTick.moi.x + 80, f1.dernierTick.moi.y);
  let seqC = 20000;
  for (let i = 0; i < 70; i++) {
    const p = c1.dernierTick.moi;
    c1.envoyer({ t: 'INPUT', seq: seqC++, x: p.x, y: p.y, a: 0, m: 0, hp: 100 });
    await attendre(60);
  }
  V(f1.evt('verrou').length > 0, 'verrou de traque posé après 3 s dans le rayon');
  V(c1.evt('verrou-pose').length > 0, 'les Chasseurs sont avertis du verrou');
  const direct = c1.mode.traque[0];
  V(direct && direct.direct === 1, 'position du Fugitif verrouillé diffusée en direct');

  // extraction : rejoindre la zone puis y rester cinq secondes
  const Z = f1.modeInit.extraction.zones[0];
  await marcheF(Z.x, Z.y);
  let seqZ = 30000;
  for (let i = 0; i < 100; i++) {
    f1.envoyer({ t: 'INPUT', seq: seqZ++, x: Z.x, y: Z.y, a: 0, m: 0, hp: 100 });
    await attendre(60);
  }
  V(f1.evt('extraction-cours').length > 0, 'décompte d’extraction diffusé au Fugitif');
  V(f1.evt('extraction').length > 0, 'extraction activée');
  V(f1.fins.length > 0 && f1.fins[0].raison === 'fugitifs', 'victoire des Fugitifs enregistrée');
  const rec = f1.evt('recompense').pop();
  V(!!rec && rec.d.mult === 3 && rec.d.mvp === 'fugitif', 'MVP Fugitif : gain x3');
  V(!!rec && !!rec.d.titre, 'titre de 24 h attribué : ' + (rec ? rec.d.titre : 'aucun'));
  const recC = c1.evt('recompense').pop();
  V(!!recC && recC.d.mult === 0.5, 'défaite : gain x0,5');
  const clt = (f1.fins[0] || { classement: [{}] }).classement;
  V(clt[0].camp === 'FUGITIFS' || clt[0].camp === 'CHASSEURS', 'classement : camp indiqué');
  V(clt.every(c => c.ratio !== undefined), 'classement : ratio calculé');

  console.log('\n=== RÉUSSIS (' + ok.length + ') ===');
  ok.forEach(t => console.log('  ok  ' + t));
  if (ko.length) {
    console.log('\n=== ÉCHECS (' + ko.length + ') ===');
    ko.forEach(t => console.log('  KO  ' + t));
  }
  console.log('\n' + ok.length + ' réussis, ' + ko.length + ' échecs');
  process.exit(ko.length ? 1 : 0);
})().catch(e => { console.error('BANC D\'ESSAI EN ERREUR', e); process.exit(2); });
