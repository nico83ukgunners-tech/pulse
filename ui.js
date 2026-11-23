'use strict';

/* ================= Base de données (IndexedDB) ================= */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('pulse', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('tracks', { keyPath: 'id' });
      req.result.createObjectStore('groups', { keyPath: 'id' });
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
    t.onabort = () => reject(t.error);
  });
}
const getAll = (s) => tx(s, 'readonly', (o) => o.getAll());
const put = (s, v) => tx(s, 'readwrite', (o) => o.put(v));
const del = (s, id) => tx(s, 'readwrite', (o) => o.delete(id));
const clearStore = (s) => tx(s, 'readwrite', (o) => o.clear());

/* ================= Réglages locaux ================= */
const kv = {
  get(k, d) { try { const v = localStorage.getItem('pulse-' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { localStorage.setItem('pulse-' + k, JSON.stringify(v)); },
};

const COLORS = ['#FF8A3D', '#2EC4B6', '#B56CFF', '#FFD43B', '#FF6B9A', '#4DABF7', '#69DB7C', '#FF6B6B'];
const SEED_GROUPS = ['Sport', 'Running', 'Muscu', 'Chill', 'Soirée', 'Matin'];

/* ================= État ================= */
const state = {
  tab: 'home',
  detail: null,            // { type: 'group' | 'album', id }
  tracks: [],
  groups: [],
  lists: {},               // ids des morceaux affichés, par contexte de lecture
  queue: [],
  index: -1,
  shuffle: false,
  repeat: false,
  urls: new Map(),
  libView: 'titles',
  search: '',
  playerOpen: false,
  sheet: null,             // { kind, id?, gid? }
  busy: false,
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
const sortTracks = (a, b) => (a.album || '').localeCompare(b.album || '') || (a.trackNo || 0) - (b.trackNo || 0) || a.title.localeCompare(b.title);
const groupById = (id) => state.groups.find((g) => g.id === id);

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3800);
}

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
function releaseURLs(id) {
  for (const k of [id, 'c:' + id]) {
    if (state.urls.has(k)) { URL.revokeObjectURL(state.urls.get(k)); state.urls.delete(k); }
  }
}

// Pochette : image si elle existe, sinon dégradé coloré avec l'initiale
function art(t, size = 's') {
  const url = coverURL(t);
  if (url) return `<div class="art ${size}"><img src="${url}" alt=""></div>`;
  return `<div class="art ${size}" style="background:${gradientFor(t.album || t.title)}">${esc((t.title || '?').trim().charAt(0).toUpperCase())}</div>`;
}
function albumArt(tracks, key, size) {
  const withCover = tracks.find((t) => coverURL(t));
  if (withCover) return art(withCover, size);
  return `<div class="art ${size}" style="background:${gradientFor(key)}">${esc(key.charAt(0).toUpperCase())}</div>`;
}

/* ================= Import ================= */
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
  let n = 0;
  for (const file of files) {
    toast(`Import ${n + 1} / ${files.length}…`);
    try {
      // On copie les octets dans l'app : une simple référence au fichier peut devenir illisible sur iPhone.
      const bytes = await file.arrayBuffer();
      const blob = new Blob([bytes], { type: file.type || 'audio/mp4' });
      const tags = await readTags(file);
      await put('tracks', {
        id: uid(),
        title: tags.title || file.name.replace(/\.[^.]+$/, ''),
        artist: tags.artist || 'Artiste inconnu',
        album: tags.album || '',
        trackNo: tags.trackNo || 0,
        cover: tags.cover || null,
        blob,
        groups: [],
        plays: [],
        lastPlayed: 0,
        addedAt: Date.now(),
      });
      n++;
    } catch (e) {
      toast(`Impossible d'importer ${file.name}`);
    }
  }
  await reload();
  if (n) toast(`${plural(n, 'morceau')} ajouté${n > 1 ? 's' : ''}`);
}

/* ================= Chargement ================= */
async function reload() {
  state.tracks = (await getAll('tracks')).sort((a, b) => b.addedAt - a.addedAt);
  state.groups = (await getAll('groups')).sort((a, b) => a.name.localeCompare(b.name));
  render();
}

async function init() {
  // Bibliothèque vidée à la demande : une seule fois, à la mise à jour
  if (!kv.get('wiped-v6', false)) {
    await clearStore('tracks');
    kv.set('wiped-v6', true);
  }
  if (!kv.get('seeded', false)) {
    if ((await getAll('groups')).length === 0) {
      for (let i = 0; i < SEED_GROUPS.length; i++) {
        await put('groups', { id: uid(), name: SEED_GROUPS[i], color: COLORS[i % COLORS.length] });
      }
    }
    kv.set('seeded', true);
  }
  await reload();
}

/* ================= Affichage ================= */
function render() {
  document.querySelectorAll('#tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.tab && !state.detail));
  app.innerHTML = page();
  renderMini();
  if (state.playerOpen) renderPlayer();
  renderSheet();
}

function page() {
  if (state.detail && state.detail.type === 'group') return groupPage(state.detail.id);
  if (state.detail && state.detail.type === 'album') return albumPage(state.detail.id);
  switch (state.tab) {
    case 'library': return libraryPage();
    case 'groups': return groupsPage();
    case 'settings': return settingsPage();
    default: return homePage();
  }
}

function albumsIndex() {
  const map = new Map();
  for (const t of state.tracks) {
    if (!t.album) continue;
    if (!map.has(t.album)) map.set(t.album, []);
    map.get(t.album).push(t);
  }
  for (const list of map.values()) list.sort(sortTracks);
  return map;
}

function trackRow(t, ctx, idx) {
  return `<div class="trow">
    <div class="tmain" data-act="play" data-ctx="${ctx}" data-idx="${idx}">
      ${art(t, 's')}
      <div class="tt"><b>${esc(t.title)}</b><span>${esc(t.artist)}${t.album ? ' · ' + esc(t.album) : ''}</span></div>
    </div>
    <button class="more" data-act="menu" data-id="${t.id}" aria-label="Options">⋯</button>
  </div>`;
}

function trackList(ctx, tracks) {
  state.lists[ctx] = tracks.map((t) => t.id);
  return tracks.map((t, i) => trackRow(t, ctx, i)).join('');
}

function groupCard(g) {
  const n = state.tracks.filter((t) => t.groups.includes(g.id)).length;
  return `<button class="gcard" data-act="open" data-type="group" data-id="${esc(g.id)}" style="background:${gradientFor(g.name)}">
    <b>${esc(g.name)}</b><span>${plural(n, 'morceau')}</span></button>`;
}

function emptyImport(msg) {
  return `<div class="empty">${msg}<br><br><button class="btn acc" data-act="import">＋ Importer des morceaux</button></div>`;
}

function homePage() {
  const h = new Date().getHours();
  const hello = h < 12 ? 'Bonjour' : h < 18 ? 'Bon après-midi' : 'Bonsoir';
  const all = [...state.tracks].sort((a, b) => a.title.localeCompare(b.title));
  const newest = state.tracks.slice(0, 40);
  const recent = state.tracks.filter((t) => t.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 20);
  const albums = [...albumsIndex().entries()].sort((a, b) => a[0].localeCompare(b[0]));
  state.lists.all = all.map((t) => t.id);
  state.lists.new = newest.map((t) => t.id);
  state.lists.recent = recent.map((t) => t.id);

  return `
    <p class="greet">${hello}</p>
    <h1 class="page-title">Pulse</h1>
    <button class="btn acc block" data-act="import" style="margin-bottom:6px">＋ Importer des morceaux</button>
    ${all.length ? `
    <div class="quick">
      <button class="qtile" data-act="playlist" data-key="all" style="background:${gradientFor('tous')}">▶ Tous les titres</button>
      <button class="qtile" data-act="playlist" data-key="all" data-shuffle="1" style="background:${gradientFor('aleatoire')}">⤨ Aléatoire</button>
    </div>` : ''}

    <div class="sec"><h2>Mes groupes</h2><button data-act="tab" data-v="groups">Gérer</button></div>
    ${state.groups.length
      ? `<div class="carousel">${state.groups.map((g) => `<div>${groupCard(g)}</div>`).join('')}</div>`
      : `<div class="empty">Crée un groupe (Sport, Chill, Soirée…) dans l'onglet Groupes.</div>`}

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

    ${!all.length ? emptyImport('Ta bibliothèque est vide. Importe tes morceaux depuis l\'app Fichiers.') : ''}
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
    if (!albums.length) return `<div class="empty">Aucun album. Les morceaux sans album restent dans « Titres ».</div>`;
    return `<div class="grid2">${albums.map(([key, tracks]) => `
      <button class="card" data-act="open" data-type="album" data-id="${esc(key)}">
        ${albumArt(tracks, key, 'card-art')}
        <b>${esc(key)}</b><small>${esc(tracks[0].artist)} · ${plural(tracks.length, 'titre')}</small>
      </button>`).join('')}</div>`;
  }
  const tracks = state.tracks.filter(match).sort((a, b) => a.title.localeCompare(b.title));
  if (!state.tracks.length) return emptyImport('Aucun morceau pour le moment.');
  if (!tracks.length) return `<div class="empty">Aucun résultat.</div>`;
  return trackList('lib', tracks);
}

function groupsPage() {
  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h1 class="page-title" style="margin:0">Groupes</h1>
      <button class="btn acc sm" data-act="newgroup">+ Nouveau</button>
    </div>
    ${state.groups.length
      ? `<div class="grid2">${state.groups.map(groupCard).join('')}</div>`
      : `<div class="empty">Aucun groupe. Crée « Sport », « Chill », « Soirée »… puis ajoute-y des morceaux.</div>`}
  `;
}

function groupPage(gid) {
  const g = groupById(gid);
  if (!g) { state.detail = null; return homePage(); }
  const tracks = state.tracks.filter((t) => t.groups.includes(gid)).sort(sortTracks);
  return `
    <button class="btn sm" data-act="back" style="margin-bottom:12px">‹ Retour</button>
    <div class="hero" style="background:${gradientFor(g.name)}">
      <span class="sub" style="margin:0;opacity:.85">Mon groupe</span>
      <h1>${esc(g.name)}</h1>
      <span class="sub">${plural(tracks.length, 'morceau')}</span>
      <div class="actions">
        <button class="btn acc" data-act="playlist" data-key="grp" ${tracks.length ? '' : 'disabled'}>▶ Lecture</button>
        <button class="btn" data-act="playlist" data-key="grp" data-shuffle="1" ${tracks.length ? '' : 'disabled'}>⤨ Aléatoire</button>
        <button class="btn" data-act="addTracks" data-id="${gid}">＋ Ajouter des morceaux</button>
      </div>
    </div>
    <div class="row-btns">
      <button class="btn ghost sm" data-act="renamegroup" data-id="${gid}">Renommer</button>
      <button class="btn ghost sm danger" data-act="deletegroup" data-id="${gid}">Supprimer le groupe</button>
    </div>
    ${tracks.length ? trackList('grp', tracks)
      : `<div class="empty">Ce groupe est vide.<br>Touche « Ajouter des morceaux » et coche ceux que tu veux.</div>`}
  `;
}

function albumPage(key) {
  const tracks = albumsIndex().get(key) || [];
  if (!tracks.length) { state.detail = null; return libraryPage(); }
  return `
    <button class="btn sm" data-act="back" style="margin-bottom:12px">‹ Retour</button>
    <div class="hero" style="background:${gradientFor(key)}">
      ${albumArt(tracks, key, 'xl')}
      <h1>${esc(key)}</h1>
      <span class="sub">${esc(tracks[0].artist)} · ${plural(tracks.length, 'titre')}</span>
      <div class="actions">
        <button class="btn acc" data-act="playlist" data-key="album">▶ Lecture</button>
        <button class="btn" data-act="playlist" data-key="album" data-shuffle="1">⤨ Aléatoire</button>
        <button class="btn" data-act="albumGroup" data-id="${esc(key)}">＋ Ajouter à un groupe</button>
      </div>
    </div>
    ${trackList('album', tracks)}
  `;
}

function settingsPage() {
  return `
    <h1 class="page-title">Réglages</h1>
    <button class="setting" data-act="import">
      <div class="txt"><b>Importer des morceaux</b><small>Choisis tes fichiers audio dans l'app Fichiers.</small></div>
      <span class="muted">›</span>
    </button>
    <button class="setting" data-act="clearAll">
      <div class="txt"><b>Vider la bibliothèque</b><small>Supprime tous les morceaux du téléphone. Les groupes sont conservés.</small></div>
      <span class="muted">›</span>
    </button>
    <div class="empty" style="margin-top:16px">${plural(state.tracks.length, 'morceau')} · ${plural(albumsIndex().size, 'album')} · ${plural(state.groups.length, 'groupe')}</div>
  `;
}

/* ================= Feuilles ================= */
function sheetHTML() {
  const s = state.sheet;
  if (!s) return '';
  let body = '';
  if (s.kind === 'track') {
    const t = state.tracks.find((x) => x.id === s.id);
    if (!t) return '';
    body = `
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:14px">
        ${art(t, 's')}<div style="min-width:0"><b style="display:block;font-size:16px">${esc(t.title)}</b>
        <span class="muted">${esc(t.artist)}${t.album ? ' · ' + esc(t.album) : ''}</span></div>
      </div>
      <p class="muted" style="margin:0 0 6px">Dans quels groupes ?</p>
      <div class="sheet-list">${groupChecks(t.groups, (g) => `data-act="tg" data-id="${t.id}" data-g="${g.id}"`)}</div>
      <button class="btn block danger" data-act="deleteTrack" data-id="${t.id}">Supprimer du téléphone</button>`;
  }
  if (s.kind === 'addTracks') {
    const g = groupById(s.id);
    if (!g) return '';
    const all = [...state.tracks].sort((a, b) => a.title.localeCompare(b.title));
    body = `
      <h3 style="margin-bottom:6px">Ajouter à « ${esc(g.name)} »</h3>
      <p class="muted" style="margin:0 0 10px">Touche un morceau pour l'ajouter ou le retirer.</p>
      <div class="sheet-list" style="max-height:52vh;overflow:auto">
        ${all.length ? all.map((t) => {
          const on = t.groups.includes(g.id);
          return `<button class="sheet-item" data-act="tg" data-id="${t.id}" data-g="${g.id}">
            <span class="check ${on ? 'on' : ''}">${on ? '✓' : ''}</span>
            <span style="min-width:0;overflow:hidden"><b style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.title)}</b>
            <small class="muted" style="display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.artist)}</small></span></button>`;
        }).join('') : '<span class="muted">Importe d’abord des morceaux.</span>'}
      </div>`;
  }
  if (s.kind === 'albumGroup') {
    const tracks = albumsIndex().get(s.id) || [];
    body = `
      <h3 style="margin-bottom:6px">Ajouter « ${esc(s.id)} »</h3>
      <p class="muted" style="margin:0 0 10px">Tous les titres de l'album rejoignent le groupe choisi.</p>
      <div class="sheet-list">${state.groups.length ? state.groups.map((g) => `
        <button class="sheet-item" data-act="albumAdd" data-id="${esc(s.id)}" data-g="${g.id}">
          <span class="dot" style="background:${g.color}"></span>${esc(g.name)}
          ${tracks.every((t) => t.groups.includes(g.id)) ? '<span class="chk">✓</span>' : ''}</button>`).join('')
        : '<span class="muted">Crée d’abord un groupe.</span>'}</div>`;
  }
  return `<div class="sheet" data-backdrop="1"><div class="sheet-box"><div class="sheet-grab"></div>
    ${body}
    <button class="btn block" data-act="closeSheet" style="margin-top:14px">Fermer</button>
  </div></div>`;
}
function groupChecks(current, attrs) {
  if (!state.groups.length) return '<span class="muted">Aucun groupe. Crée-en dans l’onglet Groupes.</span>';
  return state.groups.map((g) => {
    const on = current.includes(g.id);
    return `<button class="sheet-item" ${attrs(g)}><span class="dot" style="background:${g.color}"></span>${esc(g.name)}${on ? '<span class="chk">✓</span>' : ''}</button>`;
  }).join('');
}
function renderSheet() {
  $('#sheetRoot').innerHTML = sheetHTML();
}
function openSheet(sheet) { state.sheet = sheet; renderSheet(); }
function closeSheet() { state.sheet = null; $('#sheetRoot').innerHTML = ''; }

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
  state.playerOpen = true;
  render();
}

function recordPlay(t) {
  t.plays = [...(t.plays || []).slice(-199), Date.now()];
  t.lastPlayed = Date.now();
  put('tracks', t);
}

function loadCurrent(autoplay) {
  const t = currentTrack();
  if (!t) return;
  audio.src = urlFor(t);
  setMediaSession(t);
  if (!autoplay) return;
  const p = audio.play();
  if (p && p.catch) p.catch((e) => toast(`Lecture impossible (${e.name}). Vérifie le format du fichier.`));
  recordPlay(t);
}

function togglePlay() {
  if (!audio.src) return;
  if (audio.paused) audio.play().catch((e) => toast(`Lecture impossible (${e.name})`));
  else audio.pause();
}
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

const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
function updatePlayButtons() {
  const icon = audio.paused ? ICON_PLAY : ICON_PAUSE;
  const mini = $('#miniPlay'); if (mini) mini.innerHTML = icon;
  const big = $('#plPlay'); if (big) big.innerHTML = icon;
}

function renderMini() {
  const mini = $('#mini');
  const t = currentTrack();
  if (!t) { mini.classList.add('hidden'); return; }
  mini.classList.remove('hidden');
  const url = coverURL(t);
  $('#miniArt').innerHTML = url ? `<img src="${url}" alt="">`
    : `<div style="width:100%;height:100%;background:${gradientFor(t.album || t.title)};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800">${esc(t.title.charAt(0).toUpperCase())}</div>`;
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
      <button class="big" data-act="pp" id="plPlay" aria-label="Lecture / pause">${audio.paused ? ICON_PLAY : ICON_PAUSE}</button>
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
audio.addEventListener('error', () => {
  const t = currentTrack();
  toast(`« ${t ? t.title : 'Ce morceau'} » ne peut pas être lu. Essaie un MP3 ou un M4A.`);
});
audio.addEventListener('ended', () => {
  if (state.repeat && state.queue.length === 1) { audio.currentTime = 0; audio.play(); return; }
  next();
});

function setMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  const url = coverURL(t);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title, artist: t.artist, album: t.album || 'Pulse',
    artwork: url ? [{ src: url, sizes: '512x512', type: 'image/jpeg' }] : [],
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
  if (!t) return;
  t.groups = t.groups.includes(gid) ? t.groups.filter((x) => x !== gid) : [...t.groups, gid];
  await put('tracks', t);
  await reload();
}

async function deleteTrack(tid) {
  const t = state.tracks.find((x) => x.id === tid);
  if (!t || !confirm(`Supprimer « ${t.title} » du téléphone ?`)) return;
  await del('tracks', tid);
  releaseURLs(tid);
  closeSheet();
  await reload();
}

/* ================= Événements ================= */
document.addEventListener('click', async (e) => {
  if (e.target.dataset && e.target.dataset.backdrop) return closeSheet();
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const d = el.dataset;
  switch (d.act) {
    case 'tab':
      state.tab = d.v; state.detail = null;
      return render();
    case 'back':
      state.detail = null;
      return render();
    case 'open':
      state.detail = { type: d.type, id: d.id };
      window.scrollTo(0, 0);
      return render();
    case 'play':
      if (state.lists[d.ctx]) return playList(state.lists[d.ctx], Number(d.idx));
      return;
    case 'playlist':
      return playList(state.lists[d.key] || [], 0, d.shuffle === '1');
    case 'menu':
      return openSheet({ kind: 'track', id: d.id });
    case 'menuCurrent': {
      const t = currentTrack(); if (t) openSheet({ kind: 'track', id: t.id });
      return;
    }
    case 'tg':
      return toggleTrackGroup(d.id, d.g);
    case 'deleteTrack':
      return deleteTrack(d.id);
    case 'closeSheet':
      return closeSheet();
    case 'addTracks':
      return openSheet({ kind: 'addTracks', id: d.id });
    case 'albumGroup':
      return openSheet({ kind: 'albumGroup', id: d.id });
    case 'albumAdd': {
      const tracks = albumsIndex().get(d.id) || [];
      for (const t of tracks) {
        if (!t.groups.includes(d.g)) { t.groups = [...t.groups, d.g]; await put('tracks', t); }
      }
      closeSheet();
      toast('Album ajouté au groupe');
      return reload();
    }
    case 'newgroup': {
      const name = prompt('Nom du groupe ?');
      if (!name || !name.trim()) return;
      const g = { id: uid(), name: name.trim(), color: COLORS[state.groups.length % COLORS.length] };
      await put('groups', g);
      state.tab = 'groups';
      return reload();
    }
    case 'renamegroup': {
      const g = groupById(d.id);
      const name = prompt('Nouveau nom ?', g.name);
      if (!name || !name.trim()) return;
      await put('groups', { ...g, name: name.trim() });
      return reload();
    }
    case 'deletegroup': {
      const g = groupById(d.id);
      if (!confirm(`Supprimer le groupe « ${g.name} » ? Les morceaux restent dans la bibliothèque.`)) return;
      for (const t of state.tracks.filter((x) => x.groups.includes(d.id))) {
        t.groups = t.groups.filter((x) => x !== d.id);
        await put('tracks', t);
      }
      await del('groups', d.id);
      state.detail = null;
      return reload();
    }
    case 'libview':
      state.libView = d.v; return render();
    case 'import':
      return $('#fileInput').click();
    case 'clearAll': {
      if (!state.tracks.length) return toast('La bibliothèque est déjà vide');
      if (!confirm(`Supprimer les ${state.tracks.length} morceaux du téléphone ? Irréversible.`)) return;
      await clearStore('tracks');
      state.urls.forEach((url) => URL.revokeObjectURL(url));
      state.urls.clear();
      audio.removeAttribute('src'); audio.load();
      state.queue = []; state.index = -1; state.playerOpen = false;
      toast('Bibliothèque vidée');
      return reload();
    }
    case 'openPlayer':
      state.playerOpen = true; renderPlayer();
      requestAnimationFrame(() => $('#player').classList.add('open'));
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
  if (e.target.id === 'fileInput') {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) await importFiles(files);
  }
});

/* ================= Démarrage ================= */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
init().catch((e) => toast('Erreur au démarrage : ' + e.message));
