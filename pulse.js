'use strict';

/* ================= Stockage local (IndexedDB) ================= */
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
const getAll = (store) => tx(store, 'readonly', (s) => s.getAll());
const put = (store, value) => tx(store, 'readwrite', (s) => s.put(value));
const del = (store, id) => tx(store, 'readwrite', (s) => s.delete(id));

/* ================= Réglages (localStorage, petits) ================= */
const SETTINGS_KEY = 'pulse-settings';
const settings = (() => {
  try { return { disabledAuto: [], ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch (e) { return { disabledAuto: [] }; }
})();
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
const isAutoOn = (id) => !settings.disabledAuto.includes(id);

/* ================= Groupes automatiques ================= */
// kw : mots repérés dans le titre, l'artiste ou le genre du fichier.
// bpm : plage de tempo [min, max[ (estimée à l'import, sur le téléphone).
const AUTO = [
  { id: 'sport', name: 'Sport', color: '#F97316', kw: ['sport', 'workout', 'gym', 'muscu', 'power', 'running', 'training', 'fitness', 'hiit', 'cardio', 'motivation', 'intense'], bpm: [120, 400] },
  { id: 'chill', name: 'Chill', color: '#14B8A6', kw: ['chill', 'lofi', 'lo-fi', 'relax', 'calm', 'sleep', 'study', 'cozy', 'ambient', 'acoustic'], bpm: [0, 100] },
  { id: 'soiree', name: 'Soirée', color: '#A855F7', kw: ['party', 'club', 'dance', 'edm', 'mashup', 'remix', 'festival', 'bass'], bpm: [110, 400] },
  { id: 'matin', name: 'Matin', color: '#FACC15', kw: ['morning', 'wake', 'coffee', 'sunrise', 'fresh', 'good day'], bpm: null },
];
const AUTO_BY_ID = Object.fromEntries(AUTO.map((g) => [g.id, g]));

// Créneaux horaires de l'écran Accueil
const SLOTS = [
  { name: 'Ce matin', from: 5, to: 11, auto: 'matin' },
  { name: 'Cet après-midi', from: 11, to: 18, auto: 'sport' },
  { name: 'Ce soir', from: 18, to: 23, auto: 'soiree' },
  { name: 'Cette nuit', from: 23, to: 5, auto: 'chill' },
];
const inSlot = (hour, s) => (s.from < s.to ? hour >= s.from && hour < s.to : hour >= s.from || hour < s.to);

function autoGroupsFor(t) {
  const text = `${t.title} ${t.artist} ${t.genre || ''}`.toLowerCase();
  const out = new Set();
  for (const g of AUTO) {
    if (!isAutoOn(g.id)) continue;
    if (g.kw.some((k) => text.includes(k))) out.add(g.id);
    if (g.bpm && t.bpm > 0 && t.bpm >= g.bpm[0] && t.bpm < g.bpm[1]) out.add(g.id);
  }
  // « Matin » : écouté au moins 2 fois entre 5h et 11h
  const morning = (t.plays || []).filter((p) => { const h = new Date(p).getHours(); return h >= 5 && h < 11; }).length;
  if (isAutoOn('matin') && morning >= 2) out.add('matin');
  return [...out];
}

/* ================= État ================= */
const PALETTE = ['#F97316', '#3B82F6', '#EF4444', '#14B8A6', '#A855F7', '#C8F05A', '#EC4899', '#FACC15'];
const state = {
  tab: 'home',
  tracks: [],
  groups: [],
  filter: { kind: 'all', id: null },
  openGroup: null,      // 'auto:<id>' ou id d'un groupe manuel
  lists: {},            // listes de lecture affichées sur l'accueil
  queue: [],
  index: -1,
  urls: new Map(),
  shuffle: false,
  repeat: false,
  analyzing: false,
};

const audio = document.getElementById('audio');
const view = document.getElementById('view');

/* ================= Utilitaires ================= */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
const fmt = (sec) => {
  if (!isFinite(sec) || sec < 0) return '0:00';
  return Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');
};
const letter = (t) => esc((t.title || '?').trim().charAt(0).toUpperCase());
const colorOf = (id) => PALETTE[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];
const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

function coverURL(track) {
  if (!track.cover) return null;
  const key = 'c:' + track.id;
  if (!state.urls.has(key)) state.urls.set(key, URL.createObjectURL(track.cover));
  return state.urls.get(key);
}
function urlFor(track) {
  if (!state.urls.has(track.id)) state.urls.set(track.id, URL.createObjectURL(track.blob));
  return state.urls.get(track.id);
}
function coverHTML(track, cls = 'cover') {
  const url = coverURL(track);
  if (url) return `<div class="${cls}"><img src="${url}" alt=""></div>`;
  return `<div class="${cls}" style="background:${colorOf(track.id)}22;color:${colorOf(track.id)}">${letter(track)}</div>`;
}

function membersOf(gid) {
  if (gid.startsWith('auto:')) {
    const id = gid.slice(5);
    return state.tracks.filter((t) => autoGroupsFor(t).includes(id));
  }
  return state.tracks.filter((t) => t.groups.includes(gid));
}

/* ================= Import et tags ================= */
function readTags(file) {
  return new Promise((resolve) => {
    if (!window.jsmediatags) return resolve({});
    window.jsmediatags.read(file, {
      onSuccess: ({ tags }) => {
        let cover = null;
        if (tags.picture) cover = new Blob([new Uint8Array(tags.picture.data)], { type: tags.picture.format });
        resolve({ title: tags.title, artist: tags.artist, genre: tags.genre, cover });
      },
      onError: () => resolve({}),
    });
  });
}

async function importFiles(files) {
  for (const file of files) {
    const tags = await readTags(file);
    const base = file.name.replace(/\.[^.]+$/, '');
    await put('tracks', {
      id: uid(),
      title: tags.title || base,
      artist: tags.artist || 'Artiste inconnu',
      genre: tags.genre || '',
      cover: tags.cover || null,
      blob: file,
      source: 'Mon iPhone',
      groups: [],
      plays: [],
      lastPlayed: 0,
      bpm: undefined,       // undefined = pas encore analysé ; 0 = analyse impossible
      addedAt: Date.now(),
    });
  }
  await reload();
  analyzePending();
}

/* ================= Analyse du tempo (sur l'appareil) ================= */
// On ne décode que le début du fichier (~6 Mo) pour rester léger en mémoire.
async function estimateBPM(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  try {
    const buf = await blob.slice(0, 6 * 1024 * 1024).arrayBuffer();
    const audio = await ctx.decodeAudioData(buf);
    const ch = audio.getChannelData(0);
    const block = Math.floor(audio.sampleRate / 100); // enveloppe à 100 Hz
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
      const L = Math.round(6000 / bpm); // décalage en trames pour ce tempo
      let c = 0;
      for (let i = 0; i + L < onset.length; i++) c += onset[i] * onset[i + L];
      if (c > best) { best = c; bestBpm = bpm; }
    }
    return bestBpm;
  } finally {
    ctx.close && ctx.close();
  }
}

async function analyzePending() {
  if (state.analyzing) return;
  state.analyzing = true;
  try {
    for (const t of state.tracks.filter((x) => x.bpm === undefined)) {
      let bpm = 0;
      try { bpm = (await estimateBPM(t.blob)) || 0; } catch (e) { bpm = 0; }
      t.bpm = bpm;
      await put('tracks', t);
      if (state.tab === 'home' || state.tab === 'library') render();
    }
  } finally {
    state.analyzing = false;
    render();
  }
}

/* ================= Chargement ================= */
async function reload() {
  state.tracks = (await getAll('tracks')).sort((a, b) => b.addedAt - a.addedAt);
  state.groups = (await getAll('groups')).sort((a, b) => a.name.localeCompare(b.name));
  render();
}

function visibleTracks() {
  const { kind, id } = state.filter;
  if (kind === 'nogroup') return state.tracks.filter((t) => t.groups.length === 0);
  if (kind === 'source') return state.tracks.filter((t) => t.source === id);
  return state.tracks;
}

/* ================= Vues ================= */
function render() {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  if (state.tab === 'home') renderHome();
  if (state.tab === 'library') renderLibrary();
  if (state.tab === 'groups') renderGroups();
  if (state.tab === 'player') renderPlayer();
  renderMini();
}

function card(t, listKey, idx) {
  return `<button class="card" data-list="${listKey}" data-idx="${idx}">
    ${coverHTML(t, 'card-cover')}
    <span class="card-title">${esc(t.title)}</span>
    <span class="muted">${esc(t.artist)}</span>
  </button>`;
}

function section(title, tracks, key, sub = '') {
  state.lists[key] = tracks.map((t) => t.id);
  return `<section>
    <div class="sec-head"><h2>${esc(title)}</h2>${sub ? `<span class="muted">${esc(sub)}</span>` : ''}</div>
    <div class="hscroll">${tracks.map((t, i) => card(t, key, i)).join('')}</div>
  </section>`;
}

function renderHome() {
  const hour = new Date().getHours();
  const slot = SLOTS.find((s) => inSlot(hour, s));
  const byId = (id) => state.tracks.find((t) => t.id === id);

  const recent = state.tracks.filter((t) => t.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 8);

  let forSlot = state.tracks
    .map((t) => ({ t, c: (t.plays || []).filter((p) => inSlot(new Date(p).getHours(), slot)).length }))
    .filter((x) => x.c > 0)
    .sort((a, b) => b.c - a.c)
    .slice(0, 8)
    .map((x) => x.t);
  let slotSub = 'Selon tes écoutes';
  if (!forSlot.length) {
    forSlot = membersOf('auto:' + slot.auto).slice(0, 8);
    slotSub = 'Suggestions';
  }

  const newest = state.tracks.slice(0, 8);
  const autoLinks = AUTO.filter((g) => isAutoOn(g.id)).map((g) =>
    `<button class="chip-btn" data-open="auto:${g.id}" style="border-color:${g.color};color:${g.color}">${g.name}</button>`).join('');

  view.innerHTML = `
    <h1>Accueil</h1>
    ${state.tracks.length === 0 ? `<div class="empty">Importe tes MP3 depuis la Bibliothèque pour commencer.</div>` : ''}
    ${recent.length ? section('Reprendre', recent, 'recent') : ''}
    ${forSlot.length ? section(slot.name, forSlot, 'slot', slotSub) : ''}
    ${newest.length ? section('Nouveautés', newest, 'new') : ''}
    <section>
      <div class="sec-head"><h2>Ambiances</h2></div>
      <div class="seg">${autoLinks || '<span class="muted">Tous les groupes automatiques sont désactivés.</span>'}</div>
    </section>
    ${state.analyzing ? `<p class="muted">Analyse du tempo en cours…</p>` : ''}
  `;
  void byId;
}

function renderLibrary() {
  const seg = [
    ['all', null, 'Tout'],
    ['source', 'Mon iPhone', 'Mon iPhone'],
    ['nogroup', null, 'Sans groupe'],
  ].map(([kind, id, label]) => {
    const on = state.filter.kind === kind && state.filter.id === id;
    return `<button data-filter="${kind}" data-id="${esc(id || '')}" class="${on ? 'on' : ''}">${label}</button>`;
  }).join('');
  const list = visibleTracks();
  view.innerHTML = `
    <h1>Bibliothèque</h1>
    <button class="btn primary" id="importBtn">Importer mes morceaux</button>
    <p class="muted" style="margin:8px 2px 14px">Depuis l'app Fichiers. Les morceaux restent sur l'iPhone, sans réseau.</p>
    <div class="seg">${seg}</div>
    ${list.length ? list.map((t) => `
      <div class="row" data-play="${t.id}">
        ${coverHTML(t)}
        <div class="grow">
          <b>${esc(t.title)}</b>
          <span>${esc(t.artist)}${t.bpm > 0 ? ' · ' + t.bpm + ' BPM' : t.bpm === undefined ? ' · analyse…' : ''}</span>
          <div>${[...autoGroupsFor(t).map((id) => ({ name: AUTO_BY_ID[id].name, color: AUTO_BY_ID[id].color })),
            ...t.groups.map((gid) => state.groups.find((g) => g.id === gid)).filter(Boolean)]
            .map((g) => `<span class="chip" style="background:${g.color}33;color:${g.color}">${esc(g.name)}</span>`).join('')}</div>
        </div>
        <button class="icon-btn" data-edit="${t.id}" aria-label="Groupes du morceau">⋯</button>
      </div>`).join('')
      : `<div class="empty">Aucun morceau pour l'instant.</div>`}
  `;
  document.getElementById('importBtn').onclick = () => document.getElementById('fileInput').click();
}

function renderGroups() {
  if (state.openGroup) return renderGroupDetail(state.openGroup);
  const auto = AUTO.map((g) => {
    const on = isAutoOn(g.id);
    const n = on ? membersOf('auto:' + g.id).length : 0;
    return `<div class="group-card" data-open="auto:${g.id}">
      <div class="dot" style="background:${g.color}"></div>
      <div class="grow"><b style="font-size:16px">${g.name}</b><span>${on ? plural(n, 'morceau') : 'Désactivé'}</span></div>
      <button class="chip-btn ${on ? 'on' : ''}" data-toggle-auto="${g.id}">${on ? 'Actif' : 'Inactif'}</button>
    </div>`;
  }).join('');
  const manual = state.groups.map((g) => {
    const n = state.tracks.filter((t) => t.groups.includes(g.id)).length;
    return `<div class="group-card" data-open="${g.id}">
      <div class="dot" style="background:${g.color}"></div>
      <div class="grow"><b style="font-size:16px">${esc(g.name)}</b><span>${plural(n, 'morceau')}</span></div>
    </div>`;
  }).join('');
  view.innerHTML = `
    <h1>Groupes</h1>
    <h2>Automatiques</h2>
    <p class="muted" style="margin:4px 0 10px">Rangés selon le titre, le genre, le tempo et tes écoutes.</p>
    ${auto}
    <h2>Mes groupes</h2>
    ${manual || `<div class="empty">Crée tes propres groupes, par exemple pour une soirée précise.</div>`}
    <button class="btn ghost" id="newGroup" style="margin-top:12px">+ Nouveau groupe</button>
  `;
  document.getElementById('newGroup').onclick = async () => {
    const name = prompt('Nom du groupe ?');
    if (!name || !name.trim()) return;
    await put('groups', { id: uid(), name: name.trim(), color: PALETTE[state.groups.length % PALETTE.length] });
    await reload();
  };
}

function renderGroupDetail(gid) {
  const isAuto = gid.startsWith('auto:');
  const g = isAuto ? AUTO_BY_ID[gid.slice(5)] : state.groups.find((x) => x.id === gid);
  if (!g) { state.openGroup = null; return renderGroups(); }
  const color = g.color;
  const name = isAuto ? g.name : g.name;
  const tracks = membersOf(gid);
  view.innerHTML = `
    <button class="btn ghost" id="back" style="width:auto;padding:0 14px;margin-bottom:14px">‹ Groupes</button>
    <div style="display:flex;gap:14px;align-items:center;margin-bottom:16px">
      <div class="dot" style="width:64px;height:64px;border-radius:14px;background:${color}"></div>
      <div><h1 style="margin:0">${esc(name)}</h1><span class="muted">${plural(tracks.length, 'morceau')}${isAuto ? ' · automatique' : ''}</span></div>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:12px">
      <button class="btn primary" id="playGroup" ${tracks.length ? '' : 'disabled'}>▶ Lecture</button>
      <button class="btn ghost" id="shuffleGroup" ${tracks.length ? '' : 'disabled'} style="width:auto;padding:0 16px">Aléatoire</button>
    </div>
    ${isAuto ? '' : `<div style="display:flex;gap:8px;margin-bottom:10px">
      <button class="btn ghost" id="renameGroup" style="height:36px;font-size:13px">Renommer</button>
      <button class="btn ghost" id="deleteGroup" style="height:36px;font-size:13px;color:#FCA5A5">Supprimer</button>
    </div>`}
    ${tracks.map((t) => `
      <div class="row" data-play-in-group="${t.id}">
        ${coverHTML(t)}
        <div class="grow"><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></div>
        ${isAuto ? '' : `<button class="icon-btn" data-remove="${t.id}" aria-label="Retirer du groupe">✕</button>`}
      </div>`).join('') || `<div class="empty">${isAuto ? 'Aucun morceau ne correspond encore à ce groupe.' : 'Ajoute des morceaux depuis la Bibliothèque (⋯).'}</div>`}
  `;
  document.getElementById('back').onclick = () => { state.openGroup = null; render(); };
  document.getElementById('playGroup').onclick = () => playQueue(tracks.map((t) => t.id), 0, false);
  document.getElementById('shuffleGroup').onclick = () => playQueue(tracks.map((t) => t.id), 0, true);
  if (isAuto) return;
  document.getElementById('renameGroup').onclick = async () => {
    const n = prompt('Nouveau nom ?', g.name);
    if (!n || !n.trim()) return;
    await put('groups', { ...g, name: n.trim() });
    await reload();
  };
  document.getElementById('deleteGroup').onclick = async () => {
    if (!confirm(`Supprimer le groupe « ${g.name} » ? Les morceaux restent dans la bibliothèque.`)) return;
    for (const t of state.tracks.filter((x) => x.groups.includes(gid))) {
      t.groups = t.groups.filter((x) => x !== gid);
      await put('tracks', t);
    }
    await del('groups', gid);
    state.openGroup = null;
    await reload();
  };
}

function renderPlayer() {
  const t = state.queue.length ? state.tracks.find((x) => x.id === state.queue[state.index]) : null;
  view.innerHTML = `
    <h1>Lecteur</h1>
    ${t ? `
    <div class="player">
      <div class="big">${coverURL(t) ? `<img src="${coverURL(t)}" alt="">` : letter(t)}</div>
      <div>
        <h2 style="font-size:24px;margin:0">${esc(t.title)}</h2>
        <span class="muted">${esc(t.artist)}</span>
      </div>
      <div>
        <input id="seek" class="bar" type="range" min="0" max="1000" value="0" aria-label="Position">
        <div class="times"><span id="tNow">0:00</span><span id="tLeft">-0:00</span></div>
      </div>
      <div class="controls">
        <button class="icon-btn" id="shuffleBtn" aria-label="Aléatoire" style="color:${state.shuffle ? 'var(--accent)' : 'var(--muted)'}">⤨</button>
        <button class="icon-btn" id="prevBtn" aria-label="Précédent"><svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zM9.5 12L18 6v12z"/></svg></button>
        <button class="icon-btn main" id="playBtn" aria-label="Lecture / pause"></button>
        <button class="icon-btn" id="nextBtn" aria-label="Suivant"><svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2zM6 6l8.5 6L6 18z"/></svg></button>
        <button class="icon-btn" id="repeatBtn" aria-label="Répéter" style="color:${state.repeat ? 'var(--accent)' : 'var(--muted)'}">↻</button>
      </div>
    </div>` : `<div class="empty">Rien en lecture. Ouvre un groupe ou un morceau.</div>`}
  `;
  if (!t) return;
  document.getElementById('playBtn').onclick = togglePlay;
  document.getElementById('prevBtn').onclick = prev;
  document.getElementById('nextBtn').onclick = next;
  document.getElementById('shuffleBtn').onclick = () => { state.shuffle = !state.shuffle; renderPlayer(); };
  document.getElementById('repeatBtn').onclick = () => { state.repeat = !state.repeat; renderPlayer(); };
  document.getElementById('seek').oninput = (e) => {
    if (isFinite(audio.duration)) audio.currentTime = (e.target.value / 1000) * audio.duration;
  };
  updatePlayButtons();
  updateProgress();
}

function renderMini() {
  const mini = document.getElementById('mini');
  const t = state.queue.length ? state.tracks.find((x) => x.id === state.queue[state.index]) : null;
  if (!t || state.tab === 'player') { mini.classList.add('hidden'); return; }
  mini.classList.remove('hidden');
  const url = coverURL(t);
  document.getElementById('miniCover').innerHTML = url ? `<img src="${url}" alt="">` : '';
  document.getElementById('miniTitle').textContent = t.title;
  document.getElementById('miniArtist').textContent = t.artist;
  updatePlayButtons();
}

/* ================= Lecture ================= */
function playQueue(ids, startAt = 0, shuffle = false) {
  if (!ids.length) return;
  let list = [...ids];
  if (shuffle) list = list.sort(() => Math.random() - 0.5);
  state.queue = list;
  state.index = Math.max(0, startAt);
  loadCurrent(true);
  state.tab = 'player';
  render();
}

function recordPlay(t) {
  t.plays = [...(t.plays || []).slice(-199), Date.now()];
  t.lastPlayed = Date.now();
  put('tracks', t);
}

function loadCurrent(autoplay) {
  const t = state.tracks.find((x) => x.id === state.queue[state.index]);
  if (!t) return;
  audio.src = urlFor(t);
  if (autoplay) {
    audio.play().catch(() => {});
    recordPlay(t);
  } else {
    audio.pause();
  }
  setMediaSession(t);
  renderMini();
}

function togglePlay() {
  if (!audio.src) return;
  audio.paused ? audio.play() : audio.pause();
}

function next() {
  if (!state.queue.length) return;
  if (state.shuffle && state.queue.length > 1) {
    let i; do { i = Math.floor(Math.random() * state.queue.length); } while (i === state.index);
    state.index = i;
  } else {
    state.index = (state.index + 1) % state.queue.length;
  }
  loadCurrent(true);
  render();
}

function prev() {
  if (!state.queue.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  state.index = (state.index - 1 + state.queue.length) % state.queue.length;
  loadCurrent(true);
  render();
}

function updatePlayButtons() {
  const mini = document.getElementById('miniPlay');
  if (mini) mini.textContent = audio.paused ? '▶' : '❚❚';
  const main = document.getElementById('playBtn');
  if (main) main.innerHTML = audio.paused
    ? '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
}

function updateProgress() {
  const now = document.getElementById('tNow');
  if (!now) return;
  now.textContent = fmt(audio.currentTime);
  document.getElementById('tLeft').textContent = '-' + fmt(audio.duration - audio.currentTime);
  if (isFinite(audio.duration)) document.getElementById('seek').value = (audio.currentTime / audio.duration) * 1000;
}

audio.addEventListener('play', () => { updatePlayButtons(); if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing'; });
audio.addEventListener('pause', () => { updatePlayButtons(); if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused'; });
audio.addEventListener('timeupdate', updateProgress);
audio.addEventListener('ended', () => {
  if (state.repeat && state.queue.length === 1) { audio.currentTime = 0; audio.play(); return; }
  next();
});

/* ================= Écran verrouillé (Media Session) ================= */
function setMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  const url = coverURL(t);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title,
    artist: t.artist,
    album: 'Pulse',
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
function toggleAuto(id) {
  const i = settings.disabledAuto.indexOf(id);
  if (i >= 0) settings.disabledAuto.splice(i, 1); else settings.disabledAuto.push(id);
  saveSettings();
  render();
}

async function removeFromGroup(trackId, gid) {
  const t = state.tracks.find((x) => x.id === trackId);
  t.groups = t.groups.filter((x) => x !== gid);
  await put('tracks', t);
  await reload();
}

async function openTrackGroups(trackId) {
  const t = state.tracks.find((x) => x.id === trackId);
  if (!state.groups.length) return alert("Crée d'abord un groupe dans l'onglet Groupes.");
  const autoNames = autoGroupsFor(t).map((id) => AUTO_BY_ID[id].name).join(', ') || 'aucun';
  const ui = document.createElement('div');
  ui.className = 'sheet';
  ui.innerHTML = `<div class="sheet-box">
    <h2 style="margin-top:0">${esc(t.title)}</h2>
    <p class="muted" style="margin:0 0 12px">Automatique : ${esc(autoNames)}</p>
    <div class="seg" id="gchips">${state.groups.map((g) => `<button data-g="${g.id}" class="${t.groups.includes(g.id) ? 'on' : ''}">${esc(g.name)}</button>`).join('')}</div>
    <button class="btn primary" id="closeGroups">Terminé</button>
  </div>`;
  document.body.appendChild(ui);
  ui.querySelectorAll('[data-g]').forEach((b) => b.onclick = async () => {
    const gid = b.dataset.g;
    t.groups = t.groups.includes(gid) ? t.groups.filter((x) => x !== gid) : [...t.groups, gid];
    await put('tracks', t);
    b.classList.toggle('on');
  });
  const close = async () => { ui.remove(); await reload(); };
  ui.querySelector('#closeGroups').onclick = close;
  ui.addEventListener('click', (e) => { if (e.target === ui) close(); });
}

/* ================= Événements ================= */
document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  state.tab = b.dataset.tab;
  state.openGroup = null;
  render();
});

document.getElementById('fileInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) await importFiles(files);
});

document.getElementById('miniPlay').addEventListener('click', togglePlay);
document.getElementById('mini').addEventListener('click', (e) => {
  if (e.target.closest('#miniPlay')) return;
  state.tab = 'player';
  render();
});

view.addEventListener('click', (e) => {
  const t = e.target;
  const toggle = t.closest('[data-toggle-auto]');
  if (toggle) return toggleAuto(toggle.dataset.toggleAuto);
  const more = t.closest('[data-edit]');
  if (more) return openTrackGroups(more.dataset.edit);
  const rm = t.closest('[data-remove]');
  if (rm) return removeFromGroup(rm.dataset.remove, state.openGroup);
  const f = t.closest('[data-filter]');
  if (f) { state.filter = { kind: f.dataset.filter, id: f.dataset.id || null }; return renderLibrary(); }
  const open = t.closest('[data-open]');
  if (open) { state.openGroup = open.dataset.open; return renderGroupDetail(state.openGroup); }
  const list = t.closest('[data-list]');
  if (list) return playQueue(state.lists[list.dataset.list] || [], Number(list.dataset.idx));
  const play = t.closest('[data-play]');
  if (play) { const ids = visibleTracks().map((x) => x.id); return playQueue(ids, ids.indexOf(play.dataset.play)); }
  const pig = t.closest('[data-play-in-group]');
  if (pig) { const ids = membersOf(state.openGroup).map((x) => x.id); return playQueue(ids, ids.indexOf(pig.dataset.playInGroup)); }
});

/* ================= Démarrage ================= */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
reload().then(() => analyzePending());
