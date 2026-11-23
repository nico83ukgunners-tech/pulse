'use strict';

/* ================= Base de données (IndexedDB) ================= */
const DB_NAME = 'pulse';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('tracks', { keyPath: 'id' });
      db.createObjectStore('groups', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const dbPromise = openDB();

async function tx(store, mode, fn) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
  });
}
const getAll = (s) => tx(s, 'readonly', (o) => o.getAll());
const put = (s, v) => tx(s, 'readwrite', (o) => o.put(v));
const del = (s, id) => tx(s, 'readwrite', (o) => o.delete(id));

/* ================= Réglages ================= */
const SETTINGS_KEY = 'pulse-settings';
const settings = (() => {
  try { return { autoOn: false, seeded: false, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch (e) { return { autoOn: false, seeded: false }; }
})();
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

/* ================= Constantes ================= */
const COLORS = ['#FF6B6B', '#FFA94D', '#FFD43B', '#69DB7C', '#38D9A9', '#4DABF7', '#9775FA', '#F783AC'];

// Suggestions automatiques (désactivées par défaut). Sport, Chill et Soirée s'excluent.
const AUTO = [
  { id: 'sport', name: 'Sport', color: '#FF8A3D', exclusive: true, bpm: [118, 400],
    kw: ['workout', 'gym', 'muscu', 'running', 'training', 'fitness', 'hiit', 'cardio', 'sport', 'power', 'motivation', 'bodybuild'] },
  { id: 'chill', name: 'Chill', color: '#2EC4B6', exclusive: true, bpm: [0, 96],
    kw: ['chill', 'lofi', 'lo-fi', 'relax', 'calm', 'sleep', 'study', 'ambient', 'acoustic', 'piano', 'jazz'] },
  { id: 'soiree', name: 'Soirée', color: '#B56CFF', exclusive: true, bpm: [112, 400],
    kw: ['party', 'club', 'dance', 'edm', 'mashup', 'festival', 'house', 'techno', 'afterparty'] },
  { id: 'matin', name: 'Matin', color: '#FFD43B', exclusive: false, bpm: null,
    kw: ['morning', 'wake', 'coffee', 'sunrise', 'good day'] },
];
const AUTO_BY_ID = Object.fromEntries(AUTO.map((g) => [g.id, g]));
const SEED_GROUPS = [
  { name: 'Sport', color: '#FF8A3D' }, { name: 'Chill', color: '#2EC4B6' },
  { name: 'Soirée', color: '#B56CFF' }, { name: 'Matin', color: '#FFD43B' },
];

/* ================= État ================= */
const state = {
  tab: 'home',
  detail: null,            // { type: 'group' | 'album', id }
  tracks: [],
  groups: [],
  lists: {},               // listes de lecture courantes (par clé)
  queue: [],
  index: -1,
  shuffle: false,
  repeat: false,
  urls: new Map(),
  autoCache: null,         // trackId -> [ids automatiques], reconstruit au besoin
  editMode: false,
  sel: new Set(),
  libView: 'titles',
  search: '',
  playerOpen: false,
  analyzing: false,
};
const audio = document.getElementById('audio');
const app = document.getElementById('app');
const $ = (s) => document.querySelector(s);

/* ================= Utilitaires ================= */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
const fmt = (sec) => (!isFinite(sec) || sec < 0 ? '0:00' : Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0'));
const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
const hueOf = (str) => [...String(str)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const gradientFor = (str) => { const h = hueOf(str); return `linear-gradient(140deg, hsl(${h} 82% 58%), hsl(${(h + 45) % 360} 78% 30%))`; };
const colorOfGroup = (g) => g.color || '#888';
const sortByTrack = (a, b) => (a.trackNo || 0) - (b.trackNo || 0) || a.title.localeCompare(b.title);

function coverURL(t) {
  if (!t.cover) return null;
  const key = 'c:' + t.id;
  if (!state.urls.has(key)) state.urls.set(key, URL.createObjectURL(t.cover));
  return state.urls.get(key);
}
function urlFor(t) {
  if (!state.urls.has(t.id)) state.urls.set(t.id, URL.createObjectURL(t.blob));
  return state.urls.get(t.id);
}
// Pochette : image si elle existe, sinon dégradé coloré avec l'initiale
function art(t, size = 's', fallbackKey) {
  const url = coverURL(t);
  const key = fallbackKey || t.album || t.title;
  if (url) return `<div class="art ${size}"><img src="${url}" alt=""></div>`;
  return `<div class="art ${size}" style="background:${gradientFor(key)}">${esc((t.title || '?').trim().charAt(0).toUpperCase())}</div>`;
}
function albumArt(tracks, key, size) {
  const withCover = tracks.find((t) => coverURL(t));
  if (withCover) return art(withCover, size, key);
  return `<div class="art ${size}" style="background:${gradientFor(key || 'x')}">${esc((key || '♪').charAt(0).toUpperCase())}</div>`;
}

/* ================= Import et tags ================= */
function readTags(file) {
  return new Promise((resolve) => {
    if (!window.jsmediatags) return resolve({});
    window.jsmediatags.read(file, {
      onSuccess: ({ tags }) => {
        let cover = null;
        if (tags.picture) cover = new Blob([new Uint8Array(tags.picture.data)], { type: tags.picture.format });
        resolve({
          title: tags.title, artist: tags.artist, album: tags.album, genre: tags.genre,
          trackNo: parseInt(String(tags.track || '0'), 10) || 0, cover,
        });
      },
      onError: () => resolve({}),
    });
  });
}

async function importFiles(files) {
  for (const file of files) {
    const tags = await readTags(file);
    await put('tracks', {
      id: uid(),
      title: tags.title || file.name.replace(/\.[^.]+$/, ''),
      artist: tags.artist || 'Artiste inconnu',
      album: tags.album || '',
      trackNo: tags.trackNo || 0,
      genre: tags.genre || '',
      cover: tags.cover || null,
      blob: file,
      groups: [],
      plays: [],
      lastPlayed: 0,
      bpm: undefined,
      addedAt: Date.now(),
    });
  }
  await reload();
  analyzePending();
}

// Relit les tags des morceaux importés avant la v3 (album, numéro de piste)
async function migrateTags() {
  const todo = state.tracks.filter((t) => t.album === undefined && t.blob);
  for (const t of todo) {
    const tags = await readTags(t.blob);
    t.album = tags.album || '';
    t.trackNo = tags.trackNo || 0;
    if ((!t.artist || t.artist === 'Artiste inconnu') && tags.artist) t.artist = tags.artist;
    if (!t.genre && tags.genre) t.genre = tags.genre;
    if (!t.cover && tags.cover) t.cover = tags.cover;
    await put('tracks', t);
  }
  if (todo.length) render();
}

/* ================= Suggestions automatiques ================= */
function scoreAuto(t, g) {
  const text = `${t.title} ${t.genre || ''}`.toLowerCase();
  let s = 0;
  for (const k of g.kw) if (text.includes(k)) s += 2;
  if (g.bpm && t.bpm > 0 && t.bpm >= g.bpm[0] && t.bpm < g.bpm[1]) s += 1;
  return s;
}

// Un album reste entier : l'ambiance majoritaire de l'album s'applique à toutes ses pistes.
function buildAutoCache() {
  const cache = new Map();
  state.autoCache = cache;
  if (!settings.autoOn) return;

  const byAlbum = new Map();
  for (const t of state.tracks) {
    let best = null, bestScore = 0;
    for (const g of AUTO) {
      if (!g.exclusive) continue;
      const s = scoreAuto(t, g);
      if (s > bestScore) { best = g.id; bestScore = s; }
    }
    const plays = (t.plays || []).filter((p) => { const h = new Date(p).getHours(); return h >= 5 && h < 11; }).length;
    const ids = best ? [best] : [];
    if (plays >= 2 || AUTO_BY_ID.matin.kw.some((k) => t.title.toLowerCase().includes(k))) ids.push('matin');
    cache.set(t.id, ids);
    if (t.album) {
      if (!byAlbum.has(t.album)) byAlbum.set(t.album, []);
      byAlbum.get(t.album).push(t);
    }
  }
  for (const tracks of byAlbum.values()) {
    if (tracks.length < 2) continue;
    const count = {};
    for (const t of tracks) {
      const ex = cache.get(t.id).find((x) => x !== 'matin');
      if (ex) count[ex] = (count[ex] || 0) + 1;
    }
    const top = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
    if (!top) continue;
    for (const t of tracks) {
      const matin = cache.get(t.id).filter((x) => x === 'matin');
      cache.set(t.id, [top, ...matin]);
    }
  }
}
function autoIdsFor(t) {
  if (!settings.autoOn) return [];
  if (!state.autoCache) buildAutoCache();
  return state.autoCache.get(t.id) || [];
}

function membersOf(gid) {
  if (gid.startsWith('auto:')) {
    const id = gid.slice(5);
    return state.tracks.filter((t) => autoIdsFor(t).includes(id));
  }
  return state.tracks.filter((t) => t.groups.includes(gid));
}
function groupInfo(gid) {
  if (gid.startsWith('auto:')) {
    const a = AUTO_BY_ID[gid.slice(5)];
    return a ? { id: gid, name: a.name, color: a.color, auto: true } : null;
  }
  const g = state.groups.find((x) => x.id === gid);
  return g ? { ...g, auto: false } : null;
}
function visibleGroups() {
  const list = state.groups.map((g) => ({ ...g, auto: false }));
  if (settings.autoOn) for (const a of AUTO) list.push({ id: 'auto:' + a.id, name: a.name, color: a.color, auto: true });
  return list;
}

function albumsIndex() {
  const map = new Map();
  for (const t of state.tracks) {
    if (!t.album) continue;
    if (!map.has(t.album)) map.set(t.album, []);
    map.get(t.album).push(t);
  }
  for (const list of map.values()) list.sort(sortByTrack);
  return map;
}

/* ================= Chargement ================= */
async function reload() {
  state.tracks = (await getAll('tracks')).sort((a, b) => b.addedAt - a.addedAt);
  state.groups = (await getAll('groups')).sort((a, b) => a.name.localeCompare(b.name));
  if (!settings.seeded && state.groups.length === 0) {
    for (const g of SEED_GROUPS) await put('groups', { id: uid(), ...g });
    settings.seeded = true;
    saveSettings();
    state.groups = (await getAll('groups')).sort((a, b) => a.name.localeCompare(b.name));
  }
  state.autoCache = null;
  render();
}

/* ================= Rendu ================= */
function render() {
  document.querySelectorAll('#tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.tab && !state.detail));
  app.innerHTML = page();
  renderMini();
  if (state.playerOpen) renderPlayer();
}

function page() {
  if (state.detail) {
    if (state.detail.type === 'group') return groupPage(state.detail.id);
    if (state.detail.type === 'album') return albumPage(state.detail.id);
  }
  switch (state.tab) {
    case 'library': return libraryPage();
    case 'groups': return groupsPage();
    case 'settings': return settingsPage();
    default: return homePage();
  }
}

function rowHTML(t, ctx, idx) {
  const sel = state.editMode && state.detail && state.detail.type === 'group';
  if (sel) {
    const on = state.sel.has(t.id);
    return `<div class="trow" data-act="sel" data-id="${t.id}">
      <span class="check ${on ? 'on' : ''}">${on ? '✓' : ''}</span>
      ${art(t, 's')}
      <div class="info"><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></div></div>`;
  }
  return `<div class="trow">
    <div class="info" data-act="play" data-ctx="${ctx}" data-idx="${idx}" style="display:flex;align-items:center;gap:12px;flex:1;min-width:0">
      ${art(t, 's')}
      <div class="info" style="flex:1;min-width:0"><b>${esc(t.title)}</b><span>${esc(t.artist)}${t.album ? ' · ' + esc(t.album) : ''}</span></div>
    </div>
    <button class="more" data-act="menu" data-id="${t.id}" aria-label="Options">⋯</button>
  </div>`;
}

function listOf(ctx, tracks) {
  state.lists[ctx] = tracks.map((t) => t.id);
  if (!tracks.length) return `<div class="empty">Rien à afficher ici.</div>`;
  return tracks.map((t, i) => rowHTML(t, ctx, i)).join('');
}

function groupCard(g) {
  const n = membersOf(g.id).length;
  return `<button class="gcard" data-act="open" data-type="group" data-id="${esc(g.id)}" style="background:${gradientFor(g.name + g.id)}">
    <b>${esc(g.name)}</b><span>${plural(n, 'morceau')}${g.auto ? ' · auto' : ''}</span></button>`;
}

function homePage() {
  const h = new Date().getHours();
  const hello = h < 12 ? 'Bonjour' : h < 18 ? 'Bon après-midi' : 'Bonsoir';
  const all = state.tracks;
  const newest = all.slice(0, 40);
  const recent = all.filter((t) => t.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 20);
  state.lists.all = all.map((t) => t.id);
  state.lists.new = newest.map((t) => t.id);
  state.lists.recent = recent.map((t) => t.id);
  const albums = [...albumsIndex().entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const groups = visibleGroups();

  if (!all.length) {
    return `<p class="greet">${hello}</p><h1 class="page-title">Pulse</h1>
      <div class="empty">Ta bibliothèque est vide.<br><br>
      <button class="btn acc" data-act="import">Importer mes morceaux</button></div>`;
  }

  return `
    <p class="greet">${hello}</p>
    <h1 class="page-title">Pulse</h1>
    <div class="quick">
      <button class="qtile" data-act="playlist" data-key="all" style="background:${gradientFor('tous')}">Tous les titres</button>
      <button class="qtile" data-act="playlist" data-key="new" style="background:${gradientFor('nouveautes')}">Derniers ajouts</button>
      <button class="qtile" data-act="playlist" data-key="recent" style="background:${gradientFor('recent')}">Écoutés récemment</button>
      <button class="qtile" data-act="playlist" data-key="all" data-shuffle="1" style="background:${gradientFor('aleatoire')}">Lecture aléatoire</button>
    </div>

    ${groups.length ? `<div class="sec"><h2>Tes groupes</h2><button data-act="tab" data-v="groups">Tout voir</button></div>
      <div class="carousel">${groups.map((g) => `<div style="flex:0 0 200px">${groupCard(g)}</div>`).join('')}</div>` : ''}

    ${albums.length ? `<div class="sec"><h2>Albums</h2></div>
      <div class="carousel">${albums.map(([key, tracks]) => `
        <button class="card" data-act="open" data-type="album" data-id="${esc(key)}">
          ${albumArt(tracks, key, 'card-art')}
          <b>${esc(key)}</b><small>${esc(tracks[0].artist)}</small>
        </button>`).join('')}</div>` : ''}

    ${recent.length ? `<div class="sec"><h2>Écoutés récemment</h2></div>
      <div class="carousel">${recent.map((t, i) => `
        <button class="card" data-act="play" data-ctx="recent" data-idx="${i}">
          ${art(t, 'card-art')}<b>${esc(t.title)}</b><small>${esc(t.artist)}</small>
        </button>`).join('')}</div>` : ''}

    <div class="sec"><h2>Nouveautés</h2></div>
    <div class="carousel">${newest.slice(0, 12).map((t, i) => `
      <button class="card" data-act="play" data-ctx="new" data-idx="${i}">
        ${art(t, 'card-art')}<b>${esc(t.title)}</b><small>${esc(t.artist)}</small>
      </button>`).join('')}</div>
  `;
}

function libraryPage() {
  return `
    <h1 class="page-title">Bibliothèque</h1>
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:14px">
      <input id="search" type="search" placeholder="Titre, artiste, album" value="${esc(state.search)}"
        style="flex:1;height:46px;border-radius:14px;border:none;background:var(--s1);padding:0 14px;font-size:15px;outline:none">
      <button class="icon" data-act="import" aria-label="Importer">＋</button>
    </div>
    <div class="seg" style="margin-bottom:16px">
      <button data-act="libview" data-v="titles" class="${state.libView === 'titles' ? 'on' : ''}">Titres</button>
      <button data-act="libview" data-v="albums" class="${state.libView === 'albums' ? 'on' : ''}">Albums</button>
    </div>
    <div id="libList">${libList()}</div>`;
}

function libList() {
  const q = state.search.trim().toLowerCase();
  const match = (t) => !q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q);
  if (state.libView === 'albums') {
    const albums = [...albumsIndex().entries()].filter(([k, tracks]) => match({ title: k, artist: tracks[0].artist, album: k }))
      .sort((a, b) => a[0].localeCompare(b[0]));
    if (!albums.length) return `<div class="empty">Aucun album. Les morceaux sans album apparaissent dans « Titres ».</div>`;
    return `<div class="grid2">${albums.map(([key, tracks]) => `
      <button class="card" data-act="open" data-type="album" data-id="${esc(key)}">
        ${albumArt(tracks, key, 'card-art')}
        <b>${esc(key)}</b><small>${esc(tracks[0].artist)} · ${plural(tracks.length, 'titre')}</small>
      </button>`).join('')}</div>`;
  }
  const tracks = state.tracks.filter(match);
  return listOf('lib', tracks);
}

function groupsPage() {
  const mine = state.groups;
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h1 class="page-title" style="margin:0">Groupes</h1>
      <button class="btn acc sm" data-act="newgroup">+ Nouveau</button>
    </div>
    ${mine.length ? `<div class="grid2">${mine.map((g) => groupCard({ ...g, auto: false })).join('')}</div>`
      : `<div class="empty">Crée tes groupes, par exemple « Sport », « Chill » ou une soirée précise. Ensuite, ajoute tes morceaux depuis la Bibliothèque (⋯).</div>`}
    ${settings.autoOn ? `<div class="sec"><h2>Suggestions automatiques</h2></div>
      <div class="grid2">${AUTO.map((a) => groupCard({ id: 'auto:' + a.id, name: a.name, color: a.color, auto: true })).join('')}</div>` : ''}
  `;
}

function groupPage(gid) {
  const g = groupInfo(gid);
  if (!g) { state.detail = null; return homePage(); }
  const tracks = membersOf(gid);
  const others = state.groups.filter((x) => x.id !== gid);
  state.lists.grp = tracks.map((t) => t.id);
  const editable = !g.auto;
  return `
    <button class="btn sm" data-act="back" style="margin-bottom:12px">‹ Retour</button>
    <div class="hero" style="background:${gradientFor(g.name + g.id)}">
      <span class="muted" style="color:#fff;opacity:.85">${g.auto ? 'Suggestion automatique' : 'Mon groupe'}</span>
      <h1>${esc(g.name)}</h1>
      <span class="sub">${plural(tracks.length, 'morceau')}</span>
      <div class="actions">
        <button class="btn acc" data-act="playlist" data-key="grp">▶ Lecture</button>
        <button class="btn" data-act="playlist" data-key="grp" data-shuffle="1">Aléatoire</button>
        ${editable ? `<button class="btn" data-act="edit">${state.editMode ? 'Terminer' : 'Modifier'}</button>` : ''}
      </div>
    </div>
    ${editable ? `<div class="row-btns">
      <button class="btn ghost sm" data-act="renamegroup" data-id="${gid}">Renommer</button>
      <button class="btn ghost sm danger" data-act="deletegroup" data-id="${gid}">Supprimer le groupe</button>
    </div>` : ''}
    ${listOf('grp', tracks)}
    ${state.editMode && state.sel.size && editable ? `
      <div class="bulk">
        <span>${state.sel.size} sélectionné${state.sel.size > 1 ? 's' : ''}</span>
        <select id="moveTo"><option value="">Déplacer vers…</option>
          ${others.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select>
        <button class="btn sm danger" data-act="bulkremove" data-id="${gid}">Retirer</button>
      </div>` : ''}
  `;
}

function albumPage(key) {
  const tracks = albumsIndex().get(key) || [];
  if (!tracks.length) { state.detail = null; return libraryPage(); }
  state.lists.album = tracks.map((t) => t.id);
  return `
    <button class="btn sm" data-act="back" style="margin-bottom:12px">‹ Retour</button>
    <div class="hero" style="background:${gradientFor(key)}">
      ${albumArt(tracks, key, 'xl')}
      <h1>${esc(key)}</h1>
      <span class="sub">${esc(tracks[0].artist)} · ${plural(tracks.length, 'titre')}</span>
      <div class="actions">
        <button class="btn acc" data-act="playlist" data-key="album">▶ Lecture</button>
        <button class="btn" data-act="playlist" data-key="album" data-shuffle="1">Aléatoire</button>
        <button class="btn" data-act="albumGroup" data-id="${esc(key)}">+ Groupe</button>
      </div>
    </div>
    ${tracks.map((t, i) => rowHTML(t, 'album', i)).join('')}
  `;
}

function settingsPage() {
  const albums = albumsIndex().size;
  return `
    <h1 class="page-title">Réglages</h1>
    <button class="setting" data-act="autoToggle">
      <div class="txt"><b>Suggestions automatiques</b>
        <small>Propose des groupes Sport, Chill, Soirée et Matin selon le titre, le genre, le tempo et tes écoutes. Un album reste entier. Désactivé, tu ranges tout toi-même.</small></div>
      <span class="switch ${settings.autoOn ? 'on' : ''}"></span>
    </button>
    <button class="setting" data-act="reanalyze">
      <div class="txt"><b>Recalculer le tempo</b><small>À faire si les BPM semblent faux. Peut prendre quelques minutes.</small></div>
      <span class="muted">›</span>
    </button>
    <button class="setting" data-act="import">
      <div class="txt"><b>Importer des morceaux</b><small>Depuis l'app Fichiers de l'iPhone.</small></div>
      <span class="muted">›</span>
    </button>
    <div class="empty" style="margin-top:16px">${plural(state.tracks.length, 'morceau')} · ${plural(albums, 'album')} · ${plural(state.groups.length, 'groupe')}</div>
  `;
}

/* ================= Feuilles ================= */
function openSheet(html) {
  $('#sheetRoot').innerHTML = `<div class="sheet" data-backdrop="1"><div class="sheet-box"><div class="sheet-grab"></div>${html}</div></div>`;
}
function closeSheet() { $('#sheetRoot').innerHTML = ''; }

function openTrackSheet(tid) {
  const t = state.tracks.find((x) => x.id === tid);
  if (!t) return;
  const auto = autoIdsFor(t).map((id) => AUTO_BY_ID[id]).filter(Boolean);
  openSheet(`
    <div style="display:flex;gap:12px;align-items:center;margin-bottom:14px">
      ${art(t, 's')}<div style="min-width:0"><b style="display:block;font-size:16px">${esc(t.title)}</b>
      <span class="muted">${esc(t.artist)}${t.album ? ' · ' + esc(t.album) : ''}</span></div>
    </div>
    <p class="muted" style="margin:0 0 6px">Mes groupes (touche pour ajouter ou retirer)</p>
    <div class="sheet-list">
      ${state.groups.length ? state.groups.map((g) => {
        const on = t.groups.includes(g.id);
        return `<button class="sheet-item" data-act="tg" data-id="${tid}" data-g="${g.id}">
          <span class="dot" style="background:${g.color}"></span>${esc(g.name)}${on ? '<span class="chk">✓</span>' : ''}</button>`;
      }).join('') : '<span class="muted">Aucun groupe. Crée-en dans l’onglet Groupes.</span>'}
    </div>
    ${auto.length ? `<p class="muted" style="margin:0 0 14px">Suggestion automatique : ${auto.map((a) => a.name).join(', ')}</p>` : ''}
    <button class="btn block danger" data-act="deleteTrack" data-id="${tid}" style="margin-bottom:10px">Supprimer du téléphone</button>
    <button class="btn block acc" data-act="closeSheet">Terminé</button>`);
}

function openAlbumGroupSheet(key) {
  openSheet(`
    <h3 style="margin-bottom:6px">Ajouter « ${esc(key)} »</h3>
    <p class="muted" style="margin:0 0 6px">Tous les titres de l'album rejoignent le groupe choisi.</p>
    <div class="sheet-list">
      ${state.groups.length ? state.groups.map((g) => `
        <button class="sheet-item" data-act="albumAdd" data-id="${esc(key)}" data-g="${g.id}">
          <span class="dot" style="background:${g.color}"></span>${esc(g.name)}</button>`).join('')
        : '<span class="muted">Crée d’abord un groupe.</span>'}
    </div>
    <button class="btn block" data-act="closeSheet">Annuler</button>`);
}

/* ================= Lecture ================= */
function currentTrack() {
  return state.queue.length ? state.tracks.find((x) => x.id === state.queue[state.index]) : null;
}

function playList(ids, startAt = 0, shuffle = false) {
  if (!ids || !ids.length) return;
  let list = [...ids];
  if (shuffle) list = list.sort(() => Math.random() - 0.5);
  state.queue = list;
  state.index = Math.max(0, startAt);
  loadCurrent(true);
  render();
}

function recordPlay(t) {
  t.plays = [...(t.plays || []).slice(-199), Date.now()];
  t.lastPlayed = Date.now();
  state.autoCache = null;
  put('tracks', t);
}

function loadCurrent(autoplay) {
  const t = currentTrack();
  if (!t) return;
  audio.src = urlFor(t);
  if (autoplay) { audio.play().catch(() => {}); recordPlay(t); } else audio.pause();
  setMediaSession(t);
}

function togglePlay() { if (audio.src) (audio.paused ? audio.play() : audio.pause()); }
function next() {
  if (!state.queue.length) return;
  if (state.shuffle && state.queue.length > 1) {
    let i; do { i = Math.floor(Math.random() * state.queue.length); } while (i === state.index);
    state.index = i;
  } else state.index = (state.index + 1) % state.queue.length;
  loadCurrent(true); render();
}
function prev() {
  if (!state.queue.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  state.index = (state.index - 1 + state.queue.length) % state.queue.length;
  loadCurrent(true); render();
}

function playIcon(playing) {
  return playing
    ? '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>';
}
function updatePlayButtons() {
  const playing = !audio.paused;
  const mini = $('#miniPlay');
  if (mini) mini.innerHTML = playIcon(playing);
  const big = $('#plPlay');
  if (big) big.innerHTML = playIcon(playing);
}

function renderMini() {
  const mini = $('#mini');
  const t = currentTrack();
  if (!t) { mini.classList.add('hidden'); return; }
  mini.classList.remove('hidden');
  $('#miniArt').innerHTML = coverURL(t) ? `<img src="${coverURL(t)}" alt="">` : `<div style="width:100%;height:100%;background:${gradientFor(t.album || t.title)};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800">${esc(t.title.charAt(0).toUpperCase())}</div>`;
  $('#miniTitle').textContent = t.title;
  $('#miniArtist').textContent = t.artist;
  updatePlayButtons();
}

function renderPlayer() {
  const el = $('#player');
  const t = currentTrack();
  if (!t) { el.innerHTML = ''; return; }
  el.style.background = gradientFor(t.album || t.title);
  el.innerHTML = `
    <div class="pl-top">
      <button class="icon" data-act="closePlayer" aria-label="Fermer">⌄</button>
      <span>${t.album ? esc(t.album) : 'En lecture'}</span>
      <button class="icon" data-act="menuCurrent" aria-label="Options">⋯</button>
    </div>
    <div style="margin-top:6px">${art(t, 'xl')}</div>
    <div class="pl-info"><div><h2>${esc(t.title)}</h2><span>${esc(t.artist)}</span></div></div>
    <div>
      <input id="seek" class="bar" type="range" min="0" max="1000" value="0" aria-label="Position">
      <div class="times"><span id="tNow">0:00</span><span id="tLeft">-0:00</span></div>
    </div>
    <div class="ctrl">
      <button class="tog ${state.shuffle ? 'on' : ''}" data-act="shuffle" aria-label="Aléatoire">⤨</button>
      <button class="sm" data-act="prev" aria-label="Précédent"><svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zM9.5 12L18 6v12z"/></svg></button>
      <button class="big" data-act="pp" id="plPlay" aria-label="Lecture / pause">${playIcon(!audio.paused)}</button>
      <button class="sm" data-act="next" aria-label="Suivant"><svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2zM6 6l8.5 6L6 18z"/></svg></button>
      <button class="tog ${state.repeat ? 'on' : ''}" data-act="repeat" aria-label="Répéter">↻</button>
    </div>`;
  updateProgress();
}

function updateProgress() {
  const d = audio.duration;
  const pct = isFinite(d) && d > 0 ? (audio.currentTime / d) * 100 : 0;
  const fill = $('#miniFill');
  if (fill) fill.style.width = pct + '%';
  const now = $('#tNow');
  if (now) {
    now.textContent = fmt(audio.currentTime);
    $('#tLeft').textContent = '-' + fmt(d - audio.currentTime);
    const seek = $('#seek');
    if (seek && document.activeElement !== seek) seek.value = pct * 10;
  }
}

audio.addEventListener('play', updatePlayButtons);
audio.addEventListener('pause', updatePlayButtons);
audio.addEventListener('timeupdate', updateProgress);
audio.addEventListener('ended', () => {
  if (state.repeat && state.queue.length === 1) { audio.currentTime = 0; audio.play(); return; }
  next();
});

function setMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  const url = coverURL(t);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist, album: t.album || 'Pulse',
    artwork: url ? [{ src: url, sizes: '512x512', type: 'image/jpeg' }] : [{ src: 'icon.svg', sizes: '512x512', type: 'image/svg+xml' }],
  });
  const h = navigator.mediaSession;
  h.setActionHandler('play', () => audio.play());
  h.setActionHandler('pause', () => audio.pause());
  h.setActionHandler('previoustrack', prev);
  h.setActionHandler('nexttrack', next);
  h.setActionHandler('seekto', (d) => { audio.currentTime = d.seekTime; });
}

/* ================= Actions ================= */
async function toggleTrackGroup(tid, gid) {
  const t = state.tracks.find((x) => x.id === tid);
  t.groups = t.groups.includes(gid) ? t.groups.filter((x) => x !== gid) : [...t.groups, gid];
  await put('tracks', t);
  await reload();
}

async function deleteTrack(tid) {
  const t = state.tracks.find((x) => x.id === tid);
  if (!t || !confirm(`Supprimer « ${t.title} » du téléphone ? Ce n'est pas réversible.`)) return;
  await del('tracks', tid);
  state.urls.delete(tid);
  closeSheet();
  await reload();
}

async function analyzePending() {
  if (state.analyzing) return;
  state.analyzing = true;
  try {
    let n = 0;
    for (const t of state.tracks.filter((x) => x.bpm === undefined)) {
      let bpm = 0;
      try { bpm = (await estimateBPM(t.blob)) || 0; } catch (e) { bpm = 0; }
      t.bpm = bpm;
      await put('tracks', t);
      state.autoCache = null;
      if (++n % 3 === 0 && !state.playerOpen) render();
    }
  } finally {
    state.analyzing = false;
    render();
  }
}

// Tempo estimé sur les 6 premiers Mo du fichier (environ 3 minutes), pour rester léger en mémoire.
async function estimateBPM(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  try {
    const buf = await blob.slice(0, 6 * 1024 * 1024).arrayBuffer();
    const aud = await ctx.decodeAudioData(buf);
    const ch = aud.getChannelData(0);
    const block = Math.floor(aud.sampleRate / 100);
    const env = [];
    for (let i = 0; i + block <= ch.length; i += block) {
      let s = 0;
      for (let j = 0; j < block; j++) s += Math.abs(ch[i + j]);
      env.push(s / block);
    }
    const onset = new Float32Array(env.length);
    for (let i = 1; i < env.length; i++) onset[i] = Math.max(0, env[i] - env[i - 1]);
    let best = 0, bestBpm = 0;
    for (let bpm = 70; bpm <= 180; bpm++) {
      const L = Math.round(6000 / bpm);
      let c = 0;
      for (let i = 0; i + L < onset.length; i++) c += onset[i] * onset[i + L];
      if (c > best) { best = c; bestBpm = bpm; }
    }
    return bestBpm;
  } finally {
    if (ctx.close) ctx.close();
  }
}

/* ================= Événements ================= */
document.addEventListener('click', async (e) => {
  if (e.target.dataset && e.target.dataset.backdrop) return closeSheet();
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const d = el.dataset;
  switch (d.act) {
    case 'tab':
      state.tab = d.v; state.detail = null; state.editMode = false; state.sel.clear();
      return render();
    case 'back':
      state.detail = null; state.editMode = false; state.sel.clear();
      return render();
    case 'open':
      state.detail = { type: d.type, id: d.id }; state.editMode = false; state.sel.clear();
      window.scrollTo(0, 0);
      return render();
    case 'play':
      if (state.lists[d.ctx]) return playList(state.lists[d.ctx], Number(d.idx));
      return;
    case 'playlist': {
      const ids = state.lists[d.key] || [];
      return playList(ids, 0, d.shuffle === '1');
    }
    case 'menu': return openTrackSheet(d.id);
    case 'menuCurrent': { const t = currentTrack(); if (t) openTrackSheet(t.id); return; }
    case 'tg': await toggleTrackGroup(d.id, d.g); return openTrackSheet(d.id);
    case 'deleteTrack': return deleteTrack(d.id);
    case 'closeSheet': return closeSheet();
    case 'albumGroup': return openAlbumGroupSheet(d.id);
    case 'albumAdd': {
      const tracks = albumsIndex().get(d.id) || [];
      for (const t of tracks) {
        if (!t.groups.includes(d.g)) { t.groups = [...t.groups, d.g]; await put('tracks', t); }
      }
      closeSheet();
      return reload();
    }
    case 'newgroup': {
      const name = prompt('Nom du groupe ?');
      if (!name || !name.trim()) return;
      await put('groups', { id: uid(), name: name.trim(), color: COLORS[state.groups.length % COLORS.length] });
      return reload();
    }
    case 'renamegroup': {
      const g = state.groups.find((x) => x.id === d.id);
      const name = prompt('Nouveau nom ?', g.name);
      if (!name || !name.trim()) return;
      await put('groups', { ...g, name: name.trim() });
      return reload();
    }
    case 'deletegroup': {
      const g = state.groups.find((x) => x.id === d.id);
      if (!confirm(`Supprimer le groupe « ${g.name} » ? Les morceaux restent dans la bibliothèque.`)) return;
      for (const t of state.tracks.filter((x) => x.groups.includes(d.id))) {
        t.groups = t.groups.filter((x) => x !== d.id);
        await put('tracks', t);
      }
      await del('groups', d.id);
      state.detail = null;
      return reload();
    }
    case 'edit':
      state.editMode = !state.editMode; state.sel.clear();
      return render();
    case 'sel':
      if (state.sel.has(d.id)) state.sel.delete(d.id); else state.sel.add(d.id);
      return render();
    case 'bulkremove': {
      for (const t of state.tracks.filter((x) => state.sel.has(x.id))) {
        t.groups = t.groups.filter((x) => x !== d.id);
        await put('tracks', t);
      }
      state.sel.clear();
      return reload();
    }
    case 'libview':
      state.libView = d.v; return render();
    case 'import':
      return $('#fileInput').click();
    case 'autoToggle':
      settings.autoOn = !settings.autoOn; saveSettings(); state.autoCache = null;
      return render();
    case 'reanalyze': {
      for (const t of state.tracks) { t.bpm = undefined; await put('tracks', t); }
      analyzePending();
      return;
    }
    case 'openPlayer':
      state.playerOpen = true; renderPlayer();
      $('#player').classList.add('open');
      return;
    case 'closePlayer':
      state.playerOpen = false; $('#player').classList.remove('open');
      return;
    case 'pp': return togglePlay();
    case 'next': return next();
    case 'prev': return prev();
    case 'shuffle': state.shuffle = !state.shuffle; return renderPlayer();
    case 'repeat': state.repeat = !state.repeat; return renderPlayer();
    default: return;
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'search') {
    state.search = e.target.value;
    const list = $('#libList');
    if (list) list.innerHTML = libList();
  }
  if (e.target.id === 'seek' && isFinite(audio.duration)) {
    audio.currentTime = (e.target.value / 1000) * audio.duration;
  }
});

document.addEventListener('change', async (e) => {
  if (e.target.id === 'moveTo' && e.target.value) {
    const target = e.target.value;
    const from = state.detail && state.detail.id;
    for (const t of state.tracks.filter((x) => state.sel.has(x.id))) {
      t.groups = [...t.groups.filter((x) => x !== from), ...(t.groups.includes(target) ? [] : [target])];
      await put('tracks', t);
    }
    state.sel.clear();
    return reload();
  }
  if (e.target.id === 'fileInput') {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) await importFiles(files);
  }
});

/* ================= Démarrage ================= */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
reload().then(async () => { await migrateTags(); analyzePending(); });
