'use strict';

/* ---------- Stockage local (IndexedDB) : morceaux, pochettes, groupes ---------- */
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

let dbPromise = openDB();

async function tx(store, mode, fn) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const result = fn(s);
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
  });
}

const getAll = (store) => tx(store, 'readonly', (s) => s.getAll());
const put = (store, value) => tx(store, 'readwrite', (s) => s.put(value));
const del = (store, id) => tx(store, 'readwrite', (s) => s.delete(id));

/* ---------- État ---------- */
const PALETTE = ['#F97316', '#3B82F6', '#EF4444', '#14B8A6', '#A855F7', '#C8F05A', '#EC4899', '#FACC15'];
const state = {
  tab: 'library',
  tracks: [],
  groups: [],
  filter: { kind: 'all', id: null },   // all | source | group
  openGroup: null,
  queue: [],       // ids des morceaux en lecture
  index: -1,
  urls: new Map(), // id -> objectURL
  shuffle: false,
  repeat: false,
};

const audio = document.getElementById('audio');
const view = document.getElementById('view');

/* ---------- Utilitaires ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(16).slice(2));
const fmt = (sec) => {
  if (!isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
};
const letter = (t) => esc((t.title || '?').trim().charAt(0).toUpperCase());
const colorOf = (id) => PALETTE[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];

function coverURL(track) {
  if (!track.cover) return null;
  if (!state.urls.has('c:' + track.id)) state.urls.set('c:' + track.id, URL.createObjectURL(track.cover));
  return state.urls.get('c:' + track.id);
}

function coverHTML(track, cls = 'cover') {
  const url = coverURL(track);
  if (url) return `<div class="${cls}"><img src="${url}" alt=""></div>`;
  return `<div class="${cls}" style="background:${colorOf(track.id)}22;color:${colorOf(track.id)}">${letter(track)}</div>`;
}

/* ---------- Import et lecture des tags ID3 ---------- */
function readTags(file) {
  return new Promise((resolve) => {
    if (!window.jsmediatags) return resolve({});
    window.jsmediatags.read(file, {
      onSuccess: ({ tags }) => {
        let cover = null;
        if (tags.picture) {
          cover = new Blob([new Uint8Array(tags.picture.data)], { type: tags.picture.format });
        }
        resolve({ title: tags.title, artist: tags.artist, cover });
      },
      onError: () => resolve({}),
    });
  });
}

async function importFiles(files) {
  for (const file of files) {
    const tags = await readTags(file);
    const base = file.name.replace(/\.[^.]+$/, '');
    const track = {
      id: uid(),
      title: tags.title || base,
      artist: tags.artist || 'Artiste inconnu',
      cover: tags.cover || null,
      blob: file,
      source: 'Mon iPhone',
      groups: [],
      addedAt: Date.now(),
    };
    await put('tracks', track);
  }
  await reload();
}

/* ---------- Chargement ---------- */
async function reload() {
  state.tracks = (await getAll('tracks')).sort((a, b) => b.addedAt - a.addedAt);
  state.groups = (await getAll('groups')).sort((a, b) => a.name.localeCompare(b.name));
  render();
}

function visibleTracks() {
  const { kind, id } = state.filter;
  if (kind === 'group') return state.tracks.filter((t) => t.groups.includes(id));
  if (kind === 'nogroup') return state.tracks.filter((t) => t.groups.length === 0);
  if (kind === 'source') return state.tracks.filter((t) => t.source === id);
  return state.tracks;
}

/* ---------- Vues ---------- */
function render() {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  if (state.tab === 'library') renderLibrary();
  if (state.tab === 'groups') renderGroups();
  if (state.tab === 'player') renderPlayer();
  renderMini();
}

function renderLibrary() {
  const chips = [
    ['all', null, 'Tout'],
    ['source', 'Mon iPhone', 'Mon iPhone'],
    ['nogroup', null, 'Sans groupe'],
  ];
  const seg = chips.map(([kind, id, label]) => {
    const on = state.filter.kind === kind && state.filter.id === id;
    return `<button data-filter="${kind}" data-id="${esc(id)}" class="${on ? 'on' : ''}">${label}</button>`;
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
        <div class="grow"><b>${esc(t.title)}</b><span>${esc(t.artist)}</span>
          <div>${t.groups.map((gid) => {
            const g = state.groups.find((x) => x.id === gid);
            return g ? `<span class="chip" style="background:${g.color}33;color:${g.color}">${esc(g.name)}</span>` : '';
          }).join('')}</div>
        </div>
        <button class="icon-btn" data-edit="${t.id}" aria-label="Groupes du morceau">⋯</button>
      </div>`).join('')
      : `<div class="empty">Aucun morceau pour l'instant. Importe tes fichiers MP3 pour commencer.</div>`}
  `;
  document.getElementById('importBtn').onclick = () => document.getElementById('fileInput').click();
}

function renderGroups() {
  if (state.openGroup) return renderGroupDetail(state.openGroup);
  view.innerHTML = `
    <h1>Groupes</h1>
    ${state.groups.length ? state.groups.map((g) => {
      const n = state.tracks.filter((t) => t.groups.includes(g.id)).length;
      return `<div class="group-card" data-group="${g.id}">
        <div class="dot" style="background:${g.color}"></div>
        <div class="grow"><b style="font-size:16px">${esc(g.name)}</b><span>${n} morceau${n > 1 ? 'x' : ''}</span></div>
        <button class="icon-btn" data-groupedit="${g.id}" aria-label="Modifier">✎</button>
      </div>`;
    }).join('') : `<div class="empty">Crée ton premier groupe : Sport, Running, Muscu, Chill, Soirée…</div>`}
    <button class="btn ghost" id="newGroup" style="margin-top:12px">+ Nouveau groupe</button>
  `;
  document.getElementById('newGroup').onclick = async () => {
    const name = prompt('Nom du groupe ?');
    if (!name || !name.trim()) return;
    const color = PALETTE[state.groups.length % PALETTE.length];
    await put('groups', { id: uid(), name: name.trim(), color });
    await reload();
  };
}

function renderGroupDetail(gid) {
  const g = state.groups.find((x) => x.id === gid);
  if (!g) { state.openGroup = null; return renderGroups(); }
  const tracks = state.tracks.filter((t) => t.groups.includes(gid));
  view.innerHTML = `
    <button class="btn ghost" id="back" style="width:auto;padding:0 14px;margin-bottom:14px">‹ Groupes</button>
    <div style="display:flex;gap:14px;align-items:center;margin-bottom:16px">
      <div class="dot" style="width:64px;height:64px;border-radius:14px;background:${g.color}"></div>
      <div><h1 style="margin:0">${esc(g.name)}</h1><span class="muted">${tracks.length} morceau${tracks.length > 1 ? 'x' : ''}</span></div>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:12px">
      <button class="btn primary" id="playGroup" ${tracks.length ? '' : 'disabled'}>▶ Lecture</button>
      <button class="btn ghost" id="shuffleGroup" ${tracks.length ? '' : 'disabled'} style="width:auto;padding:0 16px">Aléatoire</button>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:10px">
      <button class="btn ghost" id="renameGroup" style="height:36px;font-size:13px">Renommer</button>
      <button class="btn ghost" id="deleteGroup" style="height:36px;font-size:13px;color:#FCA5A5">Supprimer</button>
    </div>
    ${tracks.map((t, i) => `
      <div class="row" data-play-in-group="${t.id}">
        ${coverHTML(t)}
        <div class="grow"><b>${esc(t.title)}</b><span>${esc(t.artist)}</span></div>
        <button class="icon-btn" data-remove="${t.id}" aria-label="Retirer du groupe">✕</button>
      </div>`).join('') || `<div class="empty">Ajoute des morceaux depuis la Bibliothèque (⋯).</div>`}
  `;
  document.getElementById('back').onclick = () => { state.openGroup = null; render(); };
  document.getElementById('playGroup').onclick = () => playQueue(tracks.map((t) => t.id), 0, false);
  document.getElementById('shuffleGroup').onclick = () => playQueue(tracks.map((t) => t.id), 0, true);
  document.getElementById('renameGroup').onclick = async () => {
    const name = prompt('Nouveau nom ?', g.name);
    if (!name || !name.trim()) return;
    await put('groups', { ...g, name: name.trim() });
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
  view.querySelectorAll('[data-remove]').forEach((b) => b.onclick = async () => {
    const t = state.tracks.find((x) => x.id === b.dataset.remove);
    t.groups = t.groups.filter((x) => x !== gid);
    await put('tracks', t);
    await reload();
  });
}

function renderPlayer() {
  const t = state.queue.length ? state.tracks.find((x) => x.id === state.queue[state.index]) : null;
  view.innerHTML = `
    <h1>Lecteur</h1>
    ${t ? `
    <div class="player">
      <div class="big">${coverURL(t) ? `<img src="${coverURL(t)}" alt="">` : letter(t)}</div>
      <div>
        <h2 style="font-size:24px">${esc(t.title)}</h2>
        <span class="muted">${esc(t.artist)}</span>
      </div>
      <div>
        <input id="seek" class="bar" type="range" min="0" max="1000" value="0">
        <div class="times"><span id="tNow">0:00</span><span id="tLeft">-0:00</span></div>
      </div>
      <div class="controls">
        <button class="icon-btn" id="shuffleBtn" aria-label="Aléatoire" style="color:${state.shuffle ? 'var(--accent)' : 'var(--muted)'}">⤨</button>
        <button class="icon-btn" id="prevBtn" aria-label="Précédent"><svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zM9.5 12L18 6v12z"/></svg></button>
        <button class="icon-btn main" id="playBtn" aria-label="Lecture / pause"></button>
        <button class="icon-btn" id="nextBtn" aria-label="Suivant"><svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2zM6 6l8.5 6L6 18z"/></svg></button>
        <button class="icon-btn" id="repeatBtn" aria-label="Répéter" style="color:${state.repeat ? 'var(--accent)' : 'var(--muted)'}">↻</button>
      </div>
    </div>` : `<div class="empty">Rien en lecture. Ouvre un groupe ou un morceau de la Bibliothèque.</div>`}
  `;
  if (t) {
    document.getElementById('playBtn').onclick = togglePlay;
    document.getElementById('prevBtn').onclick = prev;
    document.getElementById('nextBtn').onclick = next;
    document.getElementById('shuffleBtn').onclick = () => { state.shuffle = !state.shuffle; renderPlayer(); };
    document.getElementById('repeatBtn').onclick = () => { state.repeat = !state.repeat; renderPlayer(); };
    const seek = document.getElementById('seek');
    seek.oninput = () => { if (isFinite(audio.duration)) audio.currentTime = (seek.value / 1000) * audio.duration; };
    updatePlayButtons();
    updateProgress();
  }
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

/* ---------- Lecture ---------- */
function urlFor(track) {
  if (!state.urls.has(track.id)) state.urls.set(track.id, URL.createObjectURL(track.blob));
  return state.urls.get(track.id);
}

function playQueue(ids, startAt = 0, shuffle = false) {
  let list = [...ids];
  if (shuffle) list = list.sort(() => Math.random() - 0.5);
  state.queue = list;
  state.index = startAt;
  loadCurrent(true);
  state.tab = 'player';
  render();
}

function loadCurrent(autoplay) {
  const t = state.tracks.find((x) => x.id === state.queue[state.index]);
  if (!t) return;
  audio.src = urlFor(t);
  audio.play().catch(() => {});
  if (!autoplay) audio.pause();
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
  const label = audio.paused ? '▶' : '❚❚';
  const mini = document.getElementById('miniPlay');
  if (mini) mini.textContent = label;
  const main = document.getElementById('playBtn');
  if (main) main.innerHTML = audio.paused
    ? '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
}

function updateProgress() {
  const now = document.getElementById('tNow');
  if (!now) return;
  const seek = document.getElementById('seek');
  now.textContent = fmt(audio.currentTime);
  document.getElementById('tLeft').textContent = '-' + fmt(audio.duration - audio.currentTime);
  if (isFinite(audio.duration)) seek.value = (audio.currentTime / audio.duration) * 1000;
}

audio.addEventListener('play', () => { updatePlayButtons(); navigator.mediaSession && (navigator.mediaSession.playbackState = 'playing'); });
audio.addEventListener('pause', () => { updatePlayButtons(); navigator.mediaSession && (navigator.mediaSession.playbackState = 'paused'); });
audio.addEventListener('timeupdate', updateProgress);
audio.addEventListener('ended', () => {
  if (state.repeat && state.queue.length === 1) { audio.currentTime = 0; audio.play(); return; }
  next();
});

/* ---------- Écran verrouillé et centre de contrôle (Media Session) ---------- */
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

/* ---------- Événements ---------- */
document.querySelector('.tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  state.tab = b.dataset.tab;
  if (state.tab === 'groups') state.openGroup = null;
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

view.addEventListener('click', async (e) => {
  const filter = e.target.closest('[data-filter]');
  if (filter) {
    state.filter = { kind: filter.dataset.filter, id: filter.dataset.id || null };
    return renderLibrary();
  }
  const edit = e.target.closest('[data-edit]');
  if (edit) return openTrackGroups(edit.dataset.edit);
  const gcard = e.target.closest('[data-group]');
  const gedit = e.target.closest('[data-groupedit]');
  if (gedit) { state.openGroup = gedit.dataset.groupedit; return renderGroupDetail(state.openGroup); }
  if (gcard && state.tab === 'groups' && !state.openGroup) { state.openGroup = gcard.dataset.group; return renderGroupDetail(state.openGroup); }
  const play = e.target.closest('[data-play]');
  if (play) {
    const ids = visibleTracks().map((t) => t.id);
    return playQueue(ids, ids.indexOf(play.dataset.play));
  }
  const inGroup = e.target.closest('[data-play-in-group]');
  if (inGroup && !e.target.closest('[data-remove]')) {
    const ids = state.tracks.filter((t) => t.groups.includes(state.openGroup)).map((t) => t.id);
    return playQueue(ids, ids.indexOf(inGroup.dataset.playInGroup));
  }
});

async function openTrackGroups(trackId) {
  const t = state.tracks.find((x) => x.id === trackId);
  if (!state.groups.length) return alert('Crée d\'abord un groupe dans l\'onglet Groupes.');
  const ui = document.createElement('div');
  ui.style.cssText = 'position:fixed;inset:0;background:#000a;display:flex;align-items:flex-end;z-index:9';
  ui.innerHTML = `<div style="background:#1B1D22;width:100%;border-radius:18px 18px 0 0;padding:20px;padding-bottom:calc(20px + env(safe-area-inset-bottom,0px))">
    <h2 style="margin-top:0">${esc(t.title)}</h2>
    <div class="seg" id="gchips">${state.groups.map((g) => {
      const on = t.groups.includes(g.id);
      return `<button data-g="${g.id}" class="${on ? 'on' : ''}">${esc(g.name)}</button>`;
    }).join('')}</div>
    <button class="btn primary" id="closeGroups">Terminé</button>
  </div>`;
  document.body.appendChild(ui);
  ui.querySelectorAll('[data-g]').forEach((b) => b.onclick = async () => {
    const gid = b.dataset.g;
    t.groups = t.groups.includes(gid) ? t.groups.filter((x) => x !== gid) : [...t.groups, gid];
    await put('tracks', t);
    b.classList.toggle('on');
  });
  ui.querySelector('#closeGroups').onclick = async () => { ui.remove(); await reload(); };
  ui.addEventListener('click', (e) => { if (e.target === ui) { ui.remove(); reload(); } });
}

/* ---------- Démarrage ---------- */
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
reload();
