/* =====================================================================
   Banc d'essai du protocole multijoueur de Liberty Lake.
   48 contrôles : salles, mots de passe, lancement, validation des
   positions, dégâts, chat, verrou des véhicules, modes course et
   police, limitation de cadence, messages malformés.

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

(async () => {
  const ok = [], ko = [];
  const V = (cond, txt) => (cond ? ok : ko).push(txt);

  const a = client('Alice'), b = client('Bob');
  await Promise.all([a.pret, b.pret]);
  await attendre(200);
  V(a.type('BIENVENUE').length === 1, 'BIENVENUE reçu');
  V(a.type('BIENVENUE')[0].modes.length === 4, 'quatre modes annoncés');

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

  console.log('\n=== RÉUSSIS (' + ok.length + ') ===');
  ok.forEach(t => console.log('  ok  ' + t));
  if (ko.length) {
    console.log('\n=== ÉCHECS (' + ko.length + ') ===');
    ko.forEach(t => console.log('  KO  ' + t));
  }
  console.log('\n' + ok.length + ' réussis, ' + ko.length + ' échecs');
  process.exit(ko.length ? 1 : 0);
})().catch(e => { console.error('BANC D\'ESSAI EN ERREUR', e); process.exit(2); });
