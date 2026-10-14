/* =====================================================================
   Banc d'essai du CLIENT, sans navigateur : faux DOM, faux canvas 2D,
   puis on pilote G.update / G.render image par image.

   Il couvre le générateur d'arène du mode Battle, la géométrie que
   l'hôte envoie au serveur, les armes ajoutées, les règles de
   réapparition des deux modes en ligne, et vérifie surtout que la
   partie solo reste intacte.

   Lancement :  node test/client.test.js
   (facultatif : node test/client.test.js <fichier.html> <verifs.js>)
   ===================================================================== */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
/* Fichier du jeu et liste de contrôles : surchargés en argument si besoin. */
const FICHIER = process.argv[2] || path.join(__dirname, '..', 'liberty-lake.html');
const html = fs.readFileSync(FICHIER, 'utf8');
const i0 = html.indexOf('<script>');
const i1 = html.lastIndexOf('</script>');
const code = html.slice(i0 + 8, i1);

/* ---------------------------- faux canvas ---------------------------- */
function faireContexte() {
  const noop = () => { };
  const cible = {
    canvas: null,
    measureText: () => ({ width: 10 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => ({}),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }),
    putImageData: noop, createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(1, w * h * 4)), width: w, height: h }),
    setTransform: noop, drawImage: noop, save: noop, restore: noop
  };
  return new Proxy(cible, {
    get(t, p) {
      if (p in t) return t[p];
      return noop;
    },
    set(t, p, v) { t[p] = v; return true; }
  });
}
function faireCanvas() {
  const c = {
    width: 1280, height: 720, style: {},
    getContext: () => { const g = faireContexte(); g.canvas = c; return g; },
    addEventListener: () => { }, removeEventListener: () => { },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
    toDataURL: () => 'data:,'
  };
  return c;
}

/* ------------------------------ faux DOM ----------------------------- */
const elements = new Map();
function faireElement(id, tag) {
  const e = {
    id: id || '', tagName: (tag || 'div').toUpperCase(),
    style: {}, dataset: {}, children: [], options: [],
    className: '', value: '', textContent: '', innerHTML: '',
    checked: false, disabled: false, max: 0, min: 0,
    firstChild: null, parentNode: null, nextSibling: null,
    appendChild(c) { this.children.push(c); c.parentNode = this; if (!this.firstChild) this.firstChild = c; if (this.tagName === 'SELECT') this.options.push(c); return c; },
    insertBefore(c, ref) { this.children.unshift(c); c.parentNode = this; this.firstChild = c; return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    querySelector(sel) { return trouver(this, sel); },
    querySelectorAll(sel) { return trouverTous(this, sel); },
    addEventListener() { }, removeEventListener() { },
    focus() { }, blur() { }, click() { if (this.onclick) this.onclick({}); },
    classList: { add() { }, remove() { }, toggle() { }, contains: () => false },
    getContext: () => faireContexte()
  };
  return e;
}
function tous(racine, out) {
  out = out || [];
  for (const c of racine.children || []) { out.push(c); tous(c, out); }
  return out;
}
function correspond(e, sel) {
  if (sel.startsWith('.')) return (e.className || '').split(' ').indexOf(sel.slice(1)) >= 0;
  if (sel.startsWith('#')) return e.id === sel.slice(1);
  if (sel.startsWith('[data-')) {
    const m = sel.match(/^\[data-([a-z-]+)(?:="([^"]*)")?\]$/);
    if (!m) return false;
    const cle = m[1].replace(/-([a-z])/g, (s, c) => c.toUpperCase());
    return m[2] === undefined ? e.dataset[cle] !== undefined : e.dataset[cle] === m[2];
  }
  return e.tagName === sel.toUpperCase();
}
function trouver(racine, sel) { return tous(racine).find(e => correspond(e, sel)) || null; }
function trouverTous(racine, sel) { return tous(racine).filter(e => correspond(e, sel)); }

const racine = faireElement('', 'body');
const tete = faireElement('', 'head');
const racineHtml = faireElement('', 'html');
const document = {
  head: tete, body: racine, documentElement: racineHtml,
  getElementById(id) {
    if (!elements.has(id)) {
      const e = id === 'game' ? Object.assign(faireCanvas(), { id, style: {}, dataset: {}, children: [], classList: { add() { }, remove() { }, toggle() { }, contains: () => false }, appendChild() { }, querySelector: () => null, querySelectorAll: () => [], addEventListener() { } }) : faireElement(id);
      elements.set(id, e);
      racine.children.push(e);
      e.parentNode = racine;
    }
    return elements.get(id);
  },
  createElement(tag) { return tag === 'canvas' ? faireCanvas() : faireElement('', tag); },
  querySelector(sel) { return trouver(racine, sel); },
  querySelectorAll(sel) { return trouverTous(racine, sel); },
  addEventListener() { }, removeEventListener() { },
  hidden: false, visibilityState: 'visible'
};
/* Les identifiants du panneau multijoueur doivent avoir des parents
   cohérents : on reconstruit les quelques liens dont le module a besoin. */
function lier(idEnfant, idParent, classe) {
  const e = document.getElementById(idEnfant), p = document.getElementById(idParent);
  e.parentNode = p;
  if (classe) e.className = classe;
  if (p.children.indexOf(e) < 0) p.children.push(e);
  if (!p.firstChild) p.firstChild = e;
}

const stockage = new Map();
const localStorage = {
  getItem: k => (stockage.has(k) ? stockage.get(k) : null),
  setItem: (k, v) => stockage.set(k, String(v)),
  removeItem: k => stockage.delete(k)
};

const ecouteurs = {};
const sandbox = {
  document, localStorage, console,
  window: null, self: null, globalThis: null,
  innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1,
  performance: { now: () => Date.now() },
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => { },
  setTimeout: (f, d) => setTimeout(f, d), clearTimeout, setInterval: () => 0, clearInterval: () => { },
  addEventListener: (t, f) => { (ecouteurs[t] = ecouteurs[t] || []).push(f); },
  removeEventListener: () => { },
  location: { search: '', href: 'http://localhost/' },
  navigator: { userAgent: 'node', language: 'fr' },
  URLSearchParams, Image: function () { return { addEventListener() { } }; },
  WebSocket: function () { this.readyState = 0; this.close = () => { }; this.send = () => { }; },
  AudioContext: undefined, webkitAudioContext: undefined,
  Math, Date, JSON, Object, Array, String, Number, Boolean, Map, Set, WeakMap, WeakSet,
  Uint8ClampedArray, Uint8Array, Float32Array, Error, isFinite, isNaN, parseInt, parseFloat,
  prompt: () => '', alert: () => { }, fetch: () => Promise.reject(new Error('hors ligne'))
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

sandbox.__declencher = nom => declencher(nom);
sandbox.__log = t => console.log(t);
sandbox.__fin = (ok, ko) => {
  console.log('\n' + ok + ' reussis, ' + ko + ' echecs');
  process.exit(ko ? 1 : 0);
};

/* Les contrôles sont concaténés au script du jeu : les déclarations
   `let` / `const` de haut niveau d'un script VM ne sortent pas de sa
   portée, il faut donc partager la même.                              */
const verifs = fs.readFileSync(process.argv[3] || path.join(__dirname, 'client-verifs.js'), 'utf8');
const ctx = vm.createContext(sandbox);
vm.runInContext(code + '\n' + verifs, ctx, { filename: 'liberty-lake.html' });

/* --------------------------- démarrage ------------------------------- */
function declencher(nom) { for (const f of ecouteurs[nom] || []) f({}); }

module.exports = { sandbox, ctx, declencher, document, elements, lier, vm };

