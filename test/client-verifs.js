/* ---- contrôles exécutés DANS la portée du script du jeu ---- */
__declencher('load');
setTimeout(function () {
  let ok = 0, ko = 0;
  const V = (c, t) => { if (c) { ok++; __log('  ok  ' + t); } else { ko++; __log('  KO  ' + t); } };
  try {
    V(!!G, 'monde construit');
    V(!!G.world && G.world.buildings.length > 50, 'ville générée : ' + (G.world ? G.world.buildings.length : 0) + ' bâtiments');
    V(!!WEAPONS.sniper && !!WEAPONS.knife && !!WEAPONS.grenade, 'armes de l’arène présentes');
    V(WORDER.length === 12, 'WORDER complété : ' + WORDER.length + ' armes');
    V(typeof MODEJEU === 'object' && MODEJEU.mode === '', 'MODEJEU au repos hors de ces modes');
    V(typeof ARENE === 'object', 'générateur d’arène présent');

    /* --- arène : même graine, même carte --- */
    const a1 = ARENE.definir(4242, G);
    const sig1 = JSON.stringify([a1.rect, a1.bases, a1.zones.length, a1.decor.length]);
    ARENE.cle = '';
    const a2 = ARENE.definir(4242, G);
    const sig2 = JSON.stringify([a2.rect, a2.bases, a2.zones.length, a2.decor.length]);
    V(sig1 === sig2, 'arène déterministe pour une même graine');
    V(a1.rect.w === 1500 && a1.rect.h === 1500, 'enceinte de 1500 x 1500 px');
    V(a1.zones.length >= 15, 'emplacements d’armes : ' + a1.zones.length + ' (15 minimum)');
    V(a1.bases.length === 2 && !!a1.bases[0].coffre && !!a1.bases[0].soin,
      'deux bases, chacune avec coffre et point de soin');
    const dc = Math.hypot(a1.bases[0].x - a1.centre.x, a1.bases[0].y - a1.centre.y);
    V(dc > 250, 'centre de carte à l’écart des bases (' + Math.round(dc) + ' px)');
    V(a1.decor.length > 5, 'décor propre à l’arène : ' + a1.decor.length + ' éléments');
    // `definir` renvoie l'objet ARENE lui-même : on fige l'empreinte avant
    const rect4242 = JSON.stringify(a1.rect);
    ARENE.cle = '';
    const a3 = ARENE.definir(777, G);
    V(JSON.stringify(a3.rect) !== rect4242, 'une autre graine donne une autre arène');

    /* --- géométrie que l'hôte envoie au serveur --- */
    const geo = MODEJEU.geometrieSupplementaire();
    V(!!geo && !!geo.arene && geo.arene.zones.length >= 15, 'géométrie d’arène prête pour le serveur');
    V(!!geo.departs && geo.departs.length >= 2, 'départs par biome : ' + (geo.departs || []).length);
    V(!!geo.extractions && geo.extractions.length >= 2,
      'extractions candidates : ' + (geo.extractions || []).length);
    V(!!geo.barrages && geo.barrages.length > 2, 'barrages candidats : ' + (geo.barrages || []).length);
    V(!!geo.caisses && geo.caisses.length > 2, 'caisses spéciales : ' + (geo.caisses || []).length);
    const bio = new Set((geo.extractions || []).map(e => e.nom));
    V(bio.size === (geo.extractions || []).length, 'une extraction par biome distinct');

    /* --- décor solide réellement indexé puis retiré --- */
    ARENE.cle = '';
    ARENE.definir(4242, G);
    const d0 = ARENE.decor.find(d => d.solid);
    const avant = G.world.solidsNear(d0.x + d0.w / 2, d0.y + d0.h / 2, 40).length;
    ARENE.poserDecor(G);
    const apres = G.world.solidsNear(d0.x + d0.w / 2, d0.y + d0.h / 2, 40).length;
    V(apres > avant, 'décor de l’arène ajouté aux collisions (' + avant + ' → ' + apres + ')');
    ARENE.retirerDecor(G);
    V(G.world.solidsNear(d0.x + d0.w / 2, d0.y + d0.h / 2, 40).length === avant,
      'décor retiré proprement à la sortie du mode');

    /* --- tables miroir du serveur --- */
    V(MJ_RARETES.legendaire.armes.join() === 'sniper,glauncher,lmg', 'armes légendaires conformes');
    V(MJ_RARETES.commune.armes.length === 4 && MJ_RARETES.rare.armes.length === 3,
      'trois paliers de rareté renseignés');
    V(MJ_CAMPS.poursuite[1].c === '#ff9f43' && MJ_CAMPS.poursuite[2].c === '#c08aff',
      'Fugitifs en orange, Chasseurs en violet');
    V(MJ_CAMPS.battle[1].n === 'ROUGE' && MJ_CAMPS.battle[2].n === 'BLEUE',
      'battle : équipes rouge et bleue, sans camp choisi');

    /* --- le solo reste intact : vingt images jouées --- */
    G.started = true;
    for (let i = 0; i < 20; i++) { G.update(0.016); G.render(); }
    V(true, 'vingt images jouées sans exception');
    V(!!G.ext && !!G.ext.camp, 'extensions et campagne toujours installées');
    V(MODEJEU.mode === '' && !MODEJEU.actif(), 'les deux modes restent inertes en solo');

    /* --- grenade : projectile marqué, puis explosion --- */
    const nb = G.bullets.length;
    G.spawnBullet(G.player.x + 40, G.player.y, 0, WEAPONS.grenade, G.player);
    const b = G.bullets[G.bullets.length - 1];
    V(G.bullets.length === nb + 1 && b.explose === 110, 'projectile de grenade marqué explosif');
    let boum = 0;
    const vraie = MODEJEU.exploser;
    MODEJEU.exploser = function (Gm, bb) { boum++; return vraie.call(this, Gm, bb); };
    for (let i = 0; i < 120; i++) G.updateBullets(0.016);
    MODEJEU.exploser = vraie;
    V(boum >= 1, 'la grenade explose en fin de course (' + boum + ' explosion(s))');

    /* --- réapparition de manche : pas de clinique, pas de perte d'argent --- */
    const vraiEnPartie = NET.enPartie;
    NET.enPartie = () => true;
    MODEJEU.mode = 'battle';
    MODEJEU.init = { mode: 'battle', equipe: 1, manches: 3 };
    MODEJEU.aEquiper = false;
    G.player.money = 5000;
    G.respawn();
    V(G.player.money === 5000, 'aucune perte d’argent à la réapparition de manche');
    V(G.player.weapon === 'knife' && !!G.player.owned.knife, 'retour au couteau à chaque manche');
    MODEJEU.mode = 'poursuite';
    MODEJEU.init = { mode: 'poursuite', equipe: 1 };
    G.respawn();
    V(G.player.weapon === 'pistol' && G.player.ammo.pistol === 24,
      'course poursuite : pistolet et deux chargeurs au retour');
    NET.enPartie = vraiEnPartie;
    MODEJEU.mode = ''; MODEJEU.init = null; G.player.money = 0;
    V(!MODEJEU.actif(), 'retour au solo propre après la partie');
    const argentSolo = G.player.money = 5000;
    G.respawn();
    V(G.player.money === Math.floor(argentSolo * 0.7), 'le solo garde sa pénalité de réapparition');

    /* --- lobby : tuiles, options, camp --- */
    V(typeof LobbyUI.prototype.optionsModes === 'function', 'options de salle des deux modes câblées');
    V(typeof LobbyUI.prototype.installerModes === 'function', 'interface des deux modes câblée');
    V(MJ_TUILES.length === 2 && MJ_TUILES[0].id === 'battle' && MJ_TUILES[1].id === 'poursuite',
      'deux tuiles de mode : BATTLE et COURSE POURSUITE');
    V(typeof Salle === 'undefined', 'aucun code serveur dans le client');
  } catch (e) {
    ko++;
    __log('  KO  exception : ' + (e && e.stack || e));
  }
  __fin(ok, ko);
}, 450);
