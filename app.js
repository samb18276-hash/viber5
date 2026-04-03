/* ═══════════════════════════════════════════
   VibeStream — app.js
   ═══════════════════════════════════════════ */

const API_KEY = 'AIzaSyBwzsYYQKjrvwRs4vjkc0DyhdERlVxiBT4';
const YT_API  = 'https://www.googleapis.com/youtube/v3';

/* ── PWA service worker ── */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

/* ══════════════════════════════════
   STORAGE
══════════════════════════════════ */
const Storage = {
  get: k => { try { return JSON.parse(localStorage.getItem(k)) || []; } catch { return []; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),

  getFavs:    () => Storage.get('vs_favs'),
  setFavs:    v  => Storage.set('vs_favs', v),
  isFav:      id => Storage.getFavs().some(s => s.id === id),
  addFav:     s  => { const f = Storage.getFavs(); if (!f.find(x => x.id === s.id)) Storage.setFavs([s, ...f]); },
  removeFav:  id => Storage.setFavs(Storage.getFavs().filter(s => s.id !== id)),

  getPlaylists: () => Storage.get('vs_playlists'),
  setPlaylists: v  => Storage.set('vs_playlists', v),
  createPlaylist: name => {
    const p = { id: Date.now().toString(), name, songs: [] };
    Storage.setPlaylists([...Storage.getPlaylists(), p]);
    return p;
  },
  addToPlaylist: (plId, song) => {
    const pls = Storage.getPlaylists().map(p => {
      if (p.id !== plId || p.songs.find(s => s.id === song.id)) return p;
      return { ...p, songs: [...p.songs, song] };
    });
    Storage.setPlaylists(pls);
  },
  removeFromPlaylist: (plId, songId) => {
    const pls = Storage.getPlaylists().map(p =>
      p.id === plId ? { ...p, songs: p.songs.filter(s => s.id !== songId) } : p
    );
    Storage.setPlaylists(pls);
  },
  deletePlaylist: id => Storage.setPlaylists(Storage.getPlaylists().filter(p => p.id !== id)),

  getOffline: () => Storage.get('vs_offline'),
  setOffline: v  => Storage.set('vs_offline', v),
};

/* ══════════════════════════════════
   YOUTUBE DATA API
══════════════════════════════════ */
function isoToSec(iso) {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (+m[1]||0)*3600 + (+m[2]||0)*60 + (+m[3]||0);
}

async function ytSearch(q, pageToken = null) {
  const params = new URLSearchParams({
    key: API_KEY, q, part: 'snippet', type: 'video',
    videoCategoryId: '10', maxResults: 25,
    ...(pageToken ? { pageToken } : {})
  });
  const r = await fetch(`${YT_API}/search?${params}`);
  if (!r.ok) throw new Error('Search failed');
  const data = await r.json();
  const ids = data.items.map(i => i.id.videoId).join(',');
  if (!ids) return { items: [], nextPageToken: null };

  const details = await fetch(`${YT_API}/videos?key=${API_KEY}&id=${ids}&part=contentDetails`);
  const dData   = await details.json();
  const durMap  = {};
  dData.items.forEach(v => { durMap[v.id] = isoToSec(v.contentDetails.duration); });

  const items = data.items
    .filter(i => {
      const dur = durMap[i.id.videoId] || 0;
      return dur >= 90 && !i.snippet.title.toLowerCase().includes('#shorts');
    })
    .map(i => ({
      id: i.id.videoId,
      title: i.snippet.title,
      artist: i.snippet.channelTitle,
      thumbnail: i.snippet.thumbnails.medium?.url || i.snippet.thumbnails.default?.url,
      publishedAt: i.snippet.publishedAt,
    }));

  return { items, nextPageToken: data.nextPageToken || null };
}

async function ytSearchChannels(q) {
  const params = new URLSearchParams({ key: API_KEY, q, part: 'snippet', type: 'channel', maxResults: 8 });
  const r = await fetch(`${YT_API}/search?${params}`);
  const data = await r.json();
  return (data.items || []).map(i => ({
    id: i.id.channelId,
    name: i.snippet.title,
    thumbnail: i.snippet.thumbnails.medium?.url || i.snippet.thumbnails.default?.url,
    description: i.snippet.description,
  }));
}

async function ytChannelVideos(channelId, order = 'date', q = null, pageToken = null) {
  const apiOrder = { date: 'date', viewCount: 'viewCount', az: 'title', za: 'title' }[order] || 'date';
  const params = new URLSearchParams({
    key: API_KEY, channelId, part: 'snippet', type: 'video',
    maxResults: 30, order: apiOrder,
    ...(q ? { q } : {}),
    ...(pageToken ? { pageToken } : {}),
  });
  const r = await fetch(`${YT_API}/search?${params}`);
  const data = await r.json();
  const ids = (data.items || []).map(i => i.id.videoId).join(',');
  if (!ids) return { items: [], nextPageToken: null };

  const details = await fetch(`${YT_API}/videos?key=${API_KEY}&id=${ids}&part=contentDetails`);
  const dData   = await details.json();
  const durMap  = {};
  dData.items.forEach(v => { durMap[v.id] = isoToSec(v.contentDetails.duration); });

  let items = (data.items || [])
    .filter(i => (durMap[i.id.videoId] || 0) >= 90)
    .map(i => ({
      id: i.id.videoId,
      title: i.snippet.title,
      artist: i.snippet.channelTitle,
      thumbnail: i.snippet.thumbnails.medium?.url,
      publishedAt: i.snippet.publishedAt,
    }));

  if (order === 'za') items.sort((a, b) => b.title.localeCompare(a.title));
  else if (order === 'az') items.sort((a, b) => a.title.localeCompare(b.title));

  return { items, nextPageToken: data.nextPageToken || null };
}

/* ══════════════════════════════════
   PLAYER STATE
══════════════════════════════════ */
const Player = {
  ytPlayer: null,
  ytReady: false,
  current: null,
  queue: [],
  queueIdx: 0,
  playing: false,
  isAd: false,
  offlineSound: null,
  offlinePlaying: null,

  play(song, newQueue = null) {
    if (newQueue) {
      this.queue = newQueue;
      this.queueIdx = newQueue.findIndex(s => s.id === song.id);
      if (this.queueIdx < 0) { this.queue.unshift(song); this.queueIdx = 0; }
    }
    this.current = song;
    this.playing = true;
    this._load(song.id);
    this._updateUI();
    UI.showMiniPlayer();
  },

  _load(id) {
    if (!this.ytReady || !this.ytPlayer) return;
    this.ytPlayer.loadVideoById(id);
  },

  toggle() {
    if (!this.ytPlayer) return;
    if (this.playing) { this.ytPlayer.pauseVideo(); this.playing = false; }
    else              { this.ytPlayer.playVideo();  this.playing = true;  }
    this._updatePlayButtons();
  },

  next() {
    if (this.queue.length === 0) return;
    this.queueIdx = (this.queueIdx + 1) % this.queue.length;
    this.play(this.queue[this.queueIdx]);
  },

  prev() {
    if (this.queue.length === 0) return;
    this.queueIdx = (this.queueIdx - 1 + this.queue.length) % this.queue.length;
    this.play(this.queue[this.queueIdx]);
  },

  addToQueue(song) {
    if (!this.queue.find(s => s.id === song.id)) this.queue.push(song);
    UI.toast('Added to queue');
  },

  onStateChange(state) {
    // -1=unstarted, 0=ended, 1=playing, 2=paused, 3=buffering, 5=cued
    if (state === 0) { this.next(); return; }
    if (state === 1) { this.playing = true; }
    if (state === 2) { this.playing = false; }
    this._updatePlayButtons();
  },

  setAdState(isAd) {
    this.isAd = isAd;
    const badge  = document.getElementById('ad-badge');
    const cover  = document.getElementById('player-cover');
    const artist = document.getElementById('player-artist');
    badge.classList.toggle('show', isAd);
    cover.style.display = isAd ? 'none' : 'block';
    if (isAd) artist.textContent = '📺 Ad playing — music resumes shortly';
    else if (this.current) artist.textContent = this.current.artist;
  },

  _updateUI() {
    if (!this.current) return;
    const s = this.current;
    document.getElementById('player-title').textContent  = s.title;
    document.getElementById('player-artist').textContent = s.artist;
    document.getElementById('player-cover').src          = s.thumbnail;
    document.getElementById('mini-title').textContent    = s.title;
    document.getElementById('mini-artist').textContent   = s.artist;
    document.getElementById('mini-thumb').src            = s.thumbnail;
    // fav button
    const favBtn = document.getElementById('btn-fav');
    favBtn.classList.toggle('liked', Storage.isFav(s.id));
    this._updatePlayButtons();
  },

  _updatePlayButtons() {
    const p = this.playing;
    document.getElementById('icon-play').style.display       = p ? 'none'  : 'block';
    document.getElementById('icon-pause').style.display      = p ? 'block' : 'none';
    document.getElementById('mini-icon-play').style.display  = p ? 'none'  : 'block';
    document.getElementById('mini-icon-pause').style.display = p ? 'block' : 'none';
  },
};

/* ══════════════════════════════════
   YOUTUBE IFRAME API
══════════════════════════════════ */
window.onYouTubeIframeAPIReady = function() {
  Player.ytPlayer = new YT.Player('yt-player', {
    height: '100%', width: '100%',
    playerVars: { autoplay: 1, controls: 0, rel: 0, modestbranding: 1 },
    events: {
      onReady: () => {
        Player.ytReady = true;
        if (Player.current) Player._load(Player.current.id);
      },
      onStateChange: e => Player.onStateChange(e.data),
      onError: () => setTimeout(() => Player.next(), 2000),
    }
  });

  // Ad detection via iframe message polling
  setInterval(() => {
    try {
      const iframe = document.querySelector('#yt-player-wrap iframe');
      if (!iframe) return;
      // Inject ad detection script once
      if (!iframe._adScriptInjected) {
        iframe._adScriptInjected = true;
        iframe.addEventListener('load', () => {
          try {
            const win = iframe.contentWindow;
            const check = setInterval(() => {
              try {
                const doc = iframe.contentDocument || iframe.contentWindow.document;
                const isAd = doc.documentElement.classList.contains('ad-showing') ||
                             !!doc.querySelector('.ytp-ad-player-overlay');
                Player.setAdState(isAd);
              } catch {}
            }, 1000);
          } catch {}
        });
      }
    } catch {}
  }, 3000);
};

// Load YT iframe API
(function() {
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  document.head.appendChild(s);
})();

/* ══════════════════════════════════
   UI HELPERS
══════════════════════════════════ */
const UI = {
  currentScreen: 'home',
  screenStack: [],

  show(id, pushStack = true) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(`screen-${id}`).classList.add('active');
    if (pushStack && id !== this.currentScreen) this.screenStack.push(this.currentScreen);
    this.currentScreen = id;
    // update nav highlight
    document.querySelectorAll('.nav-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.screen === id);
    });
  },

  back() {
    const prev = this.screenStack.pop();
    if (prev) this.show(prev, false);
  },

  showMiniPlayer() { document.getElementById('mini-player').classList.add('show'); },

  loader() { return '<div class="loader"><div class="spinner"></div></div>'; },

  empty(icon, title, sub = '') {
    return `<div class="empty-state">${icon}<h3>${title}</h3>${sub ? `<p>${sub}</p>` : ''}</div>`;
  },

  toast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    Object.assign(t.style, {
      position:'fixed', bottom:'90px', left:'50%', transform:'translateX(-50%)',
      background:'#333', color:'#fff', padding:'8px 18px',
      borderRadius:'20px', fontSize:'13px', zIndex:'999',
      opacity:'1', transition:'opacity .4s',
    });
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 400); }, 2000);
  },

  songHTML(song, songs, extra = '') {
    const fav = Storage.isFav(song.id);
    return `
      <div class="song-item ${Player.current?.id === song.id ? 'playing' : ''}"
           data-id="${song.id}" data-songs='${JSON.stringify(songs).replace(/'/g,"&#39;")}'>
        <img class="song-thumb" src="${song.thumbnail}" alt="" loading="lazy" />
        <div class="song-info">
          <div class="song-title ${Player.current?.id === song.id ? 'playing' : ''}">${escHtml(song.title)}</div>
          <div class="song-artist">${escHtml(song.artist)}</div>
        </div>
        <div class="song-actions">
          <button class="fav-btn ${fav ? 'liked' : ''}" data-id="${song.id}" title="Favorite" onclick="toggleFav(event,'${song.id}',${JSON.stringify(song).replace(/'/g,"&#39;")})">
            <svg viewBox="0 0 24 24" fill="${fav ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          </button>
          <button title="Add to queue" onclick="addToQ(event,'${song.id}',${JSON.stringify(song).replace(/'/g,"&#39;")})">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
          </button>
          <button title="Add to playlist" onclick="openPlaylistModal(event,${JSON.stringify(song).replace(/'/g,"&#39;")})">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h18M3 18h12"/></svg>
          </button>
          ${extra}
        </div>
      </div>`;
  },
};

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

/* ══════════════════════════════════
   HOME SCREEN
══════════════════════════════════ */
const GENRES = ['Hip Hop','Pop','R&B','Gospel','Rock','Afrobeats','Drill','Trap','Dancehall','Reggae','K-Pop','Latin','Country','EDM','Jazz','Soul','Blues','Classical'];

const SECTIONS = [
  { key:'popular',      title:'🔥 Popular Right Now',       q:'top hits 2025 official audio' },
  { key:'trending',     title:'📈 Trending This Week',      q:'trending music 2025' },
  { key:'newreleases',  title:'🆕 New Releases',            q:'new music releases 2025' },
  { key:'hiphop',       title:'🎧 Hip Hop',                 q:'greatest hip hop songs official audio' },
  { key:'rnb',          title:'💜 R&B',                     q:'best RnB songs official audio' },
  { key:'pop',          title:'🎵 Pop',                     q:'pop hits 2025 official audio' },
  { key:'gospel',       title:'✝️ Gospel & Worship',        q:'gospel praise worship songs 2025' },
  { key:'rock',         title:'🎸 Rock',                    q:'classic rock anthems greatest hits' },
  { key:'afrobeats',    title:'🌍 Afrobeats',               q:'afrobeats hits 2025' },
  { key:'drill',        title:'🔩 Drill',                   q:'drill music hits 2024 official' },
  { key:'trap',         title:'🔊 Trap',                    q:'trap music 2025 hits official' },
  { key:'dancehall',    title:'🌴 Dancehall',               q:'dancehall hits 2025' },
  { key:'reggae',       title:'🇯🇲 Reggae',                q:'reggae classics best songs' },
  { key:'kpop',         title:'🇰🇷 K-Pop',                 q:'kpop hits 2025 BTS Blackpink' },
  { key:'latin',        title:'💃 Latin',                   q:'latin hits reggaeton 2025' },
  { key:'country',      title:'🤠 Country',                 q:'country music hits 2025' },
  { key:'edm',          title:'🎛️ EDM',                    q:'EDM electronic music 2025' },
  { key:'jazz',         title:'🎷 Jazz',                    q:'jazz classics best songs' },
  { key:'soul',         title:'🔥 Soul & Funk',             q:'soul funk classics best songs' },
  { key:'michael',      title:'🎩 Michael Jackson',         q:'Michael Jackson official audio' },
  { key:'icecube',      title:'🎤 Ice Cube',                q:'Ice Cube official audio' },
  { key:'sunday',       title:'🙌 Sunday Service Choir',    q:'Sunday Service Choir official audio' },
  { key:'frank',        title:'🌊 Frank Ocean',             q:'Frank Ocean official audio' },
  { key:'drake',        title:'🦉 Drake',                   q:'Drake official audio' },
  { key:'beyonce',      title:'👑 Beyoncé',                  q:'Beyonce official audio' },
  { key:'taylor',       title:'✨ Taylor Swift',             q:'Taylor Swift official audio' },
  { key:'kendrick',     title:'🎯 Kendrick Lamar',          q:'Kendrick Lamar official audio' },
  { key:'weekend',      title:'🌙 The Weeknd',              q:'The Weeknd official audio' },
  { key:'rihanna',      title:'💎 Rihanna',                 q:'Rihanna official audio' },
  { key:'eminem',       title:'⚡ Eminem',                  q:'Eminem official audio' },
  { key:'jayz',         title:'🏆 Jay-Z',                   q:'Jay-Z official audio' },
  { key:'cardi',        title:'💅 Cardi B',                 q:'Cardi B official audio' },
  { key:'travis',       title:'🌵 Travis Scott',            q:'Travis Scott official audio' },
  { key:'juice',        title:'🕊️ Juice WRLD',             q:'Juice WRLD official audio' },
  { key:'billie',       title:'🖤 Billie Eilish',           q:'Billie Eilish official audio' },
  { key:'post',         title:'🍺 Post Malone',             q:'Post Malone official audio' },
  { key:'sza',          title:'🌸 SZA',                     q:'SZA official audio' },
  { key:'doja',         title:'🐱 Doja Cat',                q:'Doja Cat official audio' },
  { key:'ed',           title:'🎸 Ed Sheeran',              q:'Ed Sheeran official audio' },
  { key:'brunomars',    title:'🌺 Bruno Mars',              q:'Bruno Mars official audio' },
  { key:'adele',        title:'🎤 Adele',                   q:'Adele official audio' },
  { key:'usher',        title:'💃 Usher',                   q:'Usher official audio' },
  { key:'chrisbrown',   title:'🕺 Chris Brown',             q:'Chris Brown official audio' },
  { key:'jcole',        title:'🌲 J. Cole',                 q:'J Cole official audio' },
  { key:'nicki',        title:'👱 Nicki Minaj',             q:'Nicki Minaj official audio' },
  { key:'lilwayne',     title:'🐦 Lil Wayne',               q:'Lil Wayne official audio' },
  { key:'kanye',        title:'🎤 Kanye West',              q:'Kanye West official audio' },
  { key:'wizkid',       title:'⭐ Wizkid',                  q:'Wizkid official audio' },
  { key:'burna',        title:'🔥 Burna Boy',               q:'Burna Boy official audio' },
  { key:'davido',       title:'🎵 Davido',                  q:'Davido official audio' },
  { key:'tems',         title:'🌟 Tems',                    q:'Tems official audio' },
  { key:'coldplay',     title:'🌈 Coldplay',                q:'Coldplay official audio' },
  { key:'maroon5',      title:'🌹 Maroon 5',               q:'Maroon 5 official audio' },
  { key:'imagine',      title:'🐷 Imagine Dragons',         q:'Imagine Dragons official audio' },
  { key:'linkin',       title:'⚔️ Linkin Park',             q:'Linkin Park official audio' },
  { key:'queen',        title:'👑 Queen Band',              q:'Queen band official audio' },
  { key:'beatles',      title:'🪲 The Beatles',             q:'The Beatles official audio' },
  { key:'bts',          title:'💜 BTS',                     q:'BTS official audio' },
  { key:'blackpink',    title:'🖤 BLACKPINK',               q:'BLACKPINK official audio' },
  { key:'chill',        title:'😌 Chill Vibes',             q:'chill vibes music playlist 2025' },
  { key:'workout',      title:'💪 Workout',                 q:'workout motivation music 2025' },
  { key:'party',        title:'🎉 Party Anthems',           q:'party anthems 2025' },
  { key:'latenight',    title:'🌙 Late Night Drive',        q:'late night drive music playlist' },
  { key:'study',        title:'📚 Study / Lo-Fi',           q:'lofi hip hop study beats' },
  { key:'love',         title:'❤️ Love Songs',              q:'best love songs of all time' },
  { key:'movies',       title:'🎬 Movie Soundtracks',       q:'best movie soundtrack songs official' },
  { key:'disney',       title:'🏰 Disney Songs',            q:'Disney songs official audio' },
  { key:'kids',         title:'🧒 Kids Songs',              q:'popular kids songs for children' },
  { key:'cartoons',     title:'📺 Cartoon Themes',          q:'cartoon theme songs classic' },
  { key:'videogames',   title:'🎮 Video Game OST',          q:'best video game soundtrack music' },
  { key:'christmas',    title:'🎄 Christmas',               q:'best Christmas songs official audio' },
  { key:'throwback90s', title:'⏪ 90s Throwback',           q:'90s hits throwback best songs' },
  { key:'oldschool',    title:'🕰️ Old School Hip Hop',     q:'old school hip hop classics 90s' },
  { key:'naija',        title:'🎭 Naija / Afropop',         q:'Nigerian afropop music hits 2025' },
];

function buildGenreChips() {
  const wrap = document.getElementById('genre-chips');
  wrap.innerHTML = GENRES.map(g =>
    `<div class="chip" onclick="searchFromGenre('${g}')">${g}</div>`
  ).join('');
}

function searchFromGenre(genre) {
  document.getElementById('search-input').value = genre;
  UI.show('search');
  doSearch(genre);
}

async function loadHomeSections() {
  const container = document.getElementById('home-sections');
  container.innerHTML = UI.loader();

  const FIRST = 3;
  const first = SECTIONS.slice(0, FIRST);
  const rest  = SECTIONS.slice(FIRST);

  // Load first batch
  const firstResults = await Promise.all(first.map(s => ytSearch(s.q).catch(() => ({ items: [] }))));
  container.innerHTML = '';
  first.forEach((s, i) => renderSection(container, s, firstResults[i].items));

  // Load rest in batches of 5
  const BATCH = 5;
  for (let i = 0; i < rest.length; i += BATCH) {
    const batch = rest.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(s => ytSearch(s.q).catch(() => ({ items: [] }))));
    batch.forEach((s, j) => renderSection(container, s, results[j].items));
  }
}

function renderSection(container, section, songs) {
  if (!songs.length) return;
  const div = document.createElement('div');
  div.className = 'section';
  div.innerHTML = `
    <div class="section-title">${section.title}</div>
    <div class="cards-row">
      ${songs.map(s => `
        <div class="card" onclick='playSong(${JSON.stringify(s).replace(/'/g,"&#39;")},${JSON.stringify(songs).replace(/'/g,"&#39;")})'>
          <img src="${s.thumbnail}" alt="" loading="lazy" />
          <div class="card-title">${escHtml(s.title)}</div>
          <div class="card-artist">${escHtml(s.artist)}</div>
        </div>`).join('')}
    </div>`;
  container.appendChild(div);
}

function playSong(song, queue) { Player.play(song, queue); }
function addToQ(e, id, song) { e.stopPropagation(); Player.addToQueue(song); }

/* ══════════════════════════════════
   SEARCH SCREEN
══════════════════════════════════ */
let searchState = { lastQuery: '', nextPage: null, loading: false };

async function doSearch(query, pageToken = null) {
  const container = document.getElementById('search-results');
  if (!pageToken) { container.innerHTML = UI.loader(); searchState.nextPage = null; }
  searchState.loading = true;

  try {
    const { items, nextPageToken } = await ytSearch(query, pageToken);
    searchState.nextPage = nextPageToken;
    if (!pageToken) container.innerHTML = '';
    if (!items.length && !pageToken) {
      container.innerHTML = UI.empty('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="64" height="64"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>', 'No results', 'Try a different search');
      return;
    }
    items.forEach(s => {
      container.insertAdjacentHTML('beforeend', UI.songHTML(s, items));
    });
    // infinite scroll sentinel
    if (nextPageToken) {
      const sentinel = document.createElement('div');
      sentinel.id = 'search-sentinel';
      sentinel.style.height = '1px';
      container.appendChild(sentinel);
      const obs = new IntersectionObserver(entries => {
        if (entries[0].isIntersecting && !searchState.loading) {
          obs.disconnect();
          doSearch(searchState.lastQuery, searchState.nextPage);
        }
      });
      obs.observe(sentinel);
    }
  } catch (e) {
    if (!pageToken) container.innerHTML = UI.empty('', 'Search failed', 'Check your connection');
  } finally {
    searchState.loading = false;
  }
}

/* ══════════════════════════════════
   ARTISTS SCREEN
══════════════════════════════════ */
const FEATURED_ARTISTS = [
  'Michael Jackson','Ice Cube','Frank Ocean','Sunday Service Choir',
  'Drake','Beyonce','Taylor Swift','Kendrick Lamar','The Weeknd',
  'Rihanna','Eminem','Jay-Z','Cardi B','Travis Scott','Juice WRLD',
  'Billie Eilish','Post Malone','SZA','Doja Cat','Ed Sheeran',
  'Bruno Mars','Adele','Usher','Chris Brown','Lil Baby','Future',
  'NBA YoungBoy','Gunna','Lizzo','Bad Bunny','J Cole','Nicki Minaj',
  'Lil Wayne','Kanye West','Coldplay','Maroon 5','BTS','BLACKPINK',
  'Queen','The Beatles','Linkin Park','Imagine Dragons',
  'Bob Marley','Wizkid','Burna Boy','Davido','Tems',
  'XXXTentacion','Polo G','Rod Wave','Lil Durk',
];

async function loadArtists() {
  const grid = document.getElementById('artists-grid');
  if (grid.children.length > 0) return; // already loaded
  const BATCH = 6;
  for (let i = 0; i < FEATURED_ARTISTS.length; i += BATCH) {
    const batch = FEATURED_ARTISTS.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(name =>
      ytSearchChannels(name).then(r => r[0] ? { ...r[0], searchName: name } : null).catch(() => null)
    ));
    results.filter(Boolean).forEach(a => {
      if (grid.querySelector(`[data-id="${a.id}"]`)) return;
      grid.insertAdjacentHTML('beforeend', `
        <div class="artist-card" data-id="${a.id}" onclick='openArtistProfile(${JSON.stringify(a).replace(/'/g,"&#39;")})'>
          <img class="artist-avatar" src="${a.thumbnail}" alt="${escHtml(a.name)}" loading="lazy" />
          <div class="artist-name">${escHtml(a.name)}</div>
        </div>`);
    });
  }
  document.getElementById('artists-loader').innerHTML = '';
}

async function searchArtists(q) {
  const grid = document.getElementById('artists-grid');
  grid.innerHTML = UI.loader();
  try {
    const results = await ytSearchChannels(q);
    grid.innerHTML = results.length
      ? results.map(a => `
          <div class="artist-card" onclick='openArtistProfile(${JSON.stringify(a).replace(/'/g,"&#39;")})'>
            <img class="artist-avatar" src="${a.thumbnail}" alt="${escHtml(a.name)}" loading="lazy" />
            <div class="artist-name">${escHtml(a.name)}</div>
          </div>`).join('')
      : UI.empty('', 'No artists found');
  } catch {
    grid.innerHTML = UI.empty('', 'Search failed');
  }
}

/* ══════════════════════════════════
   ARTIST PROFILE
══════════════════════════════════ */
let apState = { artist: null, sort: 'date', query: '', nextPage: null, loading: false };

async function openArtistProfile(artist) {
  apState = { artist, sort: 'date', query: '', nextPage: null, loading: false };
  document.getElementById('ap-avatar').src = artist.thumbnail;
  document.getElementById('ap-name').textContent = artist.name;
  document.getElementById('ap-search-input').value = '';
  document.querySelectorAll('.sort-chip').forEach(c => c.classList.toggle('active', c.dataset.sort === 'date'));
  UI.show('artist-profile');
  loadArtistSongs();
}

async function loadArtistSongs(pageToken = null) {
  const container = document.getElementById('ap-songs');
  if (!pageToken) { container.innerHTML = UI.loader(); apState.nextPage = null; }
  apState.loading = true;
  try {
    const { items, nextPageToken } = await ytChannelVideos(
      apState.artist.id, apState.sort, apState.query || null, pageToken
    );
    apState.nextPage = nextPageToken;
    if (!pageToken) container.innerHTML = '';
    if (!items.length && !pageToken) {
      container.innerHTML = UI.empty('', 'No songs found');
      return;
    }
    items.forEach(s => container.insertAdjacentHTML('beforeend', UI.songHTML(s, items)));
    if (nextPageToken) {
      const sentinel = document.createElement('div');
      sentinel.style.height = '1px';
      container.appendChild(sentinel);
      const obs = new IntersectionObserver(entries => {
        if (entries[0].isIntersecting && !apState.loading) {
          obs.disconnect();
          loadArtistSongs(apState.nextPage);
        }
      });
      obs.observe(sentinel);
    }
  } catch {
    if (!pageToken) container.innerHTML = UI.empty('', 'Failed to load');
  } finally {
    apState.loading = false;
  }
}

/* ══════════════════════════════════
   FAVORITES
══════════════════════════════════ */
function toggleFav(e, id, song) {
  e.stopPropagation();
  if (Storage.isFav(id)) {
    Storage.removeFav(id);
    document.querySelectorAll(`.fav-btn[data-id="${id}"]`).forEach(b => {
      b.classList.remove('liked');
      b.querySelector('svg').setAttribute('fill','none');
    });
    if (Player.current?.id === id) document.getElementById('btn-fav').classList.remove('liked');
    UI.toast('Removed from favorites');
  } else {
    Storage.addFav(song);
    document.querySelectorAll(`.fav-btn[data-id="${id}"]`).forEach(b => {
      b.classList.add('liked');
      b.querySelector('svg').setAttribute('fill','currentColor');
    });
    if (Player.current?.id === id) document.getElementById('btn-fav').classList.add('liked');
    UI.toast('Added to favorites ❤️');
  }
}

function renderFavorites() {
  const list = document.getElementById('fav-list');
  const favs = Storage.getFavs();
  if (!favs.length) {
    list.innerHTML = UI.empty('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="64" height="64"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>', 'No favorites yet', 'Tap ❤️ on any song');
    return;
  }
  list.innerHTML = favs.map(s => UI.songHTML(s, favs)).join('');
}

/* ══════════════════════════════════
   PLAYLISTS
══════════════════════════════════ */
function renderPlaylists() {
  const list = document.getElementById('playlists-list');
  const pls  = Storage.getPlaylists();
  if (!pls.length) {
    list.innerHTML = UI.empty('', 'No playlists yet', 'Create one to organize your music');
    return;
  }
  list.innerHTML = pls.map(p => `
    <div class="song-item" onclick="openPlaylistDetail('${p.id}')">
      <div class="song-thumb" style="background:#1a1a2e;display:flex;align-items:center;justify-content:center;">
        <svg viewBox="0 0 24 24" fill="none" stroke="#1DB954" stroke-width="2" width="24" height="24"><path d="M3 6h18M3 12h18M3 18h12"/></svg>
      </div>
      <div class="song-info">
        <div class="song-title">${escHtml(p.name)}</div>
        <div class="song-artist">${p.songs.length} songs</div>
      </div>
      <div class="song-actions">
        <button onclick="deletePlaylist(event,'${p.id}')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        </button>
      </div>
    </div>`).join('');
}

function openPlaylistDetail(id) {
  const pl = Storage.getPlaylists().find(p => p.id === id);
  if (!pl) return;
  document.getElementById('pl-detail-title').textContent = pl.name;
  const songs = document.getElementById('pl-detail-songs');
  if (!pl.songs.length) {
    songs.innerHTML = UI.empty('', 'No songs yet', 'Add songs from search or home');
  } else {
    songs.innerHTML = pl.songs.map(s => UI.songHTML(s, pl.songs,
      `<button onclick="removeFromPl(event,'${pl.id}','${s.id}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>`
    )).join('');
  }
  UI.show('playlist-detail');
}

function removeFromPl(e, plId, songId) {
  e.stopPropagation();
  Storage.removeFromPlaylist(plId, songId);
  openPlaylistDetail(plId);
}

function deletePlaylist(e, id) {
  e.stopPropagation();
  if (!confirm('Delete this playlist?')) return;
  Storage.deletePlaylist(id);
  renderPlaylists();
}

/* ══════════════════════════════════
   PLAYLIST MODAL
══════════════════════════════════ */
let pendingSong = null;

function openPlaylistModal(e, song) {
  e.stopPropagation();
  pendingSong = song;
  const list = document.getElementById('playlist-modal-list');
  const pls  = Storage.getPlaylists();
  list.innerHTML = pls.length
    ? pls.map(p => `<div class="modal-item" onclick="addToPlFromModal('${p.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M3 6h18M3 12h18M3 18h12"/></svg><span>${escHtml(p.name)}</span></div>`).join('')
    : '<p style="color:var(--text3);font-size:13px;padding:8px 0;">No playlists yet. Create one below.</p>';
  document.getElementById('playlist-modal').classList.add('show');
}

function addToPlFromModal(plId) {
  if (pendingSong) { Storage.addToPlaylist(plId, pendingSong); UI.toast('Added to playlist ✓'); }
  closeModal('playlist-modal');
}

function closeModal(id) { document.getElementById(id).classList.remove('show'); }

/* ══════════════════════════════════
   OFFLINE
══════════════════════════════════ */
let activeTrack = null;
let activeAudio = null;

function renderOffline() {
  const list    = document.getElementById('offline-list');
  const tracks  = Storage.getOffline();
  if (!tracks.length) {
    list.innerHTML = UI.empty('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="64" height="64"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>', 'No offline tracks', 'Import audio files to listen without internet');
    return;
  }
  list.innerHTML = tracks.map(t => `
    <div class="offline-track" onclick="playOfflineTrack('${t.id}')">
      <div class="track-icon ${activeTrack === t.id ? 'playing' : ''}">
        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
          ${activeTrack === t.id ? '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>' : '<path d="M8 5v14l11-7z"/>'}
        </svg>
      </div>
      <div style="flex:1;overflow:hidden;">
        <div class="track-name">${escHtml(t.name)}</div>
        <div class="track-size">${t.size ? (t.size/1024/1024).toFixed(1)+' MB' : 'Local file'}</div>
      </div>
      <button class="track-delete" onclick="deleteOffline(event,'${t.id}')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
      </button>
    </div>`).join('');
}

function playOfflineTrack(id) {
  const tracks = Storage.getOffline();
  const track  = tracks.find(t => t.id === id);
  if (!track) return;
  if (activeAudio) { activeAudio.pause(); activeAudio = null; }
  if (activeTrack === id) { activeTrack = null; renderOffline(); return; }
  activeTrack = id;
  activeAudio = new Audio(track.dataUrl);
  activeAudio.play();
  activeAudio.onended = () => { activeTrack = null; renderOffline(); };
  renderOffline();
}

function deleteOffline(e, id) {
  e.stopPropagation();
  if (!confirm('Remove this track?')) return;
  if (activeTrack === id && activeAudio) { activeAudio.pause(); activeAudio = null; activeTrack = null; }
  Storage.setOffline(Storage.getOffline().filter(t => t.id !== id));
  renderOffline();
}

/* ══════════════════════════════════
   QUEUE
══════════════════════════════════ */
function renderQueue() {
  const list = document.getElementById('queue-list');
  if (!Player.queue.length) { list.innerHTML = '<p style="color:var(--text3);padding:16px;text-align:center;">Queue is empty</p>'; return; }
  list.innerHTML = Player.queue.map((s, i) => `
    <div class="queue-item ${i === Player.queueIdx ? 'current' : ''}" onclick="Player.play(${JSON.stringify(s).replace(/'/g,"&#39;")})">
      <img class="queue-thumb" src="${s.thumbnail}" alt="" />
      <div class="queue-info">
        <div class="queue-title">${escHtml(s.title)}</div>
        <div class="queue-artist">${escHtml(s.artist)}</div>
      </div>
      <button class="queue-remove" onclick="event.stopPropagation();Player.queue.splice(${i},1);renderQueue();">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`).join('');
}

/* ══════════════════════════════════
   SONG ITEM CLICK DELEGATION
══════════════════════════════════ */
document.addEventListener('click', e => {
  const item = e.target.closest('.song-item');
  if (!item || e.target.closest('button')) return;
  try {
    const id    = item.dataset.id;
    const songs = JSON.parse(item.dataset.songs.replace(/&#39;/g,"'"));
    const song  = songs.find(s => s.id === id) || songs[0];
    Player.play(song, songs);
  } catch {}
});

/* ══════════════════════════════════
   EVENT LISTENERS
══════════════════════════════════ */
// Bottom nav
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const screen = btn.dataset.screen;
    UI.show(screen, false);
    UI.screenStack = [];
    if (screen === 'artists') loadArtists();
  });
});

// Mini player
document.getElementById('mini-player').addEventListener('click', e => {
  if (e.target.closest('button')) return;
  UI.show('player');
});
document.getElementById('mini-play-btn').addEventListener('click', e => { e.stopPropagation(); Player.toggle(); });
document.getElementById('mini-prev').addEventListener('click',     e => { e.stopPropagation(); Player.prev(); });
document.getElementById('mini-next').addEventListener('click',     e => { e.stopPropagation(); Player.next(); });

// Player controls
document.getElementById('btn-play-pause').addEventListener('click', () => Player.toggle());
document.getElementById('btn-prev').addEventListener('click', () => Player.prev());
document.getElementById('btn-next').addEventListener('click', () => Player.next());
document.getElementById('player-back').addEventListener('click', () => UI.back());
document.getElementById('btn-fav').addEventListener('click', () => {
  if (!Player.current) return;
  toggleFav({ stopPropagation:()=>{} }, Player.current.id, Player.current);
  document.getElementById('btn-fav').classList.toggle('liked', Storage.isFav(Player.current.id));
});
document.getElementById('btn-queue').addEventListener('click', () => {
  renderQueue();
  document.getElementById('queue-sheet').classList.add('show');
});
document.getElementById('btn-add-playlist').addEventListener('click', () => {
  if (Player.current) openPlaylistModal({ stopPropagation:()=>{} }, Player.current);
});

// Back buttons
document.getElementById('artist-back').addEventListener('click', () => UI.back());
document.getElementById('fav-back').addEventListener('click', () => UI.back());
document.getElementById('playlists-back').addEventListener('click', () => UI.back());
document.getElementById('pl-detail-back').addEventListener('click', () => UI.back());
document.getElementById('offline-back').addEventListener('click', () => UI.back());

// Library nav
document.getElementById('lib-favorites-btn').addEventListener('click', () => { renderFavorites(); UI.show('favorites'); });
document.getElementById('lib-playlists-btn').addEventListener('click', () => { renderPlaylists(); UI.show('playlists'); });
document.getElementById('lib-offline-btn').addEventListener('click',   () => { renderOffline();   UI.show('offline'); });

// Search
const searchInput = document.getElementById('search-input');
const searchClear = document.getElementById('search-clear');
searchInput.addEventListener('input', () => searchClear.classList.toggle('show', searchInput.value.length > 0));
searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') { searchState.lastQuery = searchInput.value; doSearch(searchInput.value); } });
document.getElementById('search-go').addEventListener('click', () => { searchState.lastQuery = searchInput.value; doSearch(searchInput.value); });
searchClear.addEventListener('click', () => { searchInput.value = ''; searchClear.classList.remove('show'); document.getElementById('search-results').innerHTML = ''; });

// Artist search
const artistInput = document.getElementById('artist-search-input');
const artistClear = document.getElementById('artist-search-clear');
artistInput.addEventListener('input', () => artistClear.classList.toggle('show', artistInput.value.length > 0));
artistInput.addEventListener('keydown', e => { if (e.key === 'Enter') searchArtists(artistInput.value); });
document.getElementById('artist-search-go').addEventListener('click', () => searchArtists(artistInput.value));
artistClear.addEventListener('click', () => {
  artistInput.value = ''; artistClear.classList.remove('show');
  document.getElementById('artists-grid').innerHTML = '';
  loadArtists();
});

// Artist profile search
const apInput = document.getElementById('ap-search-input');
const apClear  = document.getElementById('ap-search-clear');
apInput.addEventListener('input', () => apClear.classList.toggle('show', apInput.value.length > 0));
apInput.addEventListener('keydown', e => { if (e.key === 'Enter') { apState.query = apInput.value; loadArtistSongs(); } });
document.getElementById('ap-search-go').addEventListener('click', () => { apState.query = apInput.value; loadArtistSongs(); });
apClear.addEventListener('click', () => { apInput.value = ''; apState.query = ''; loadArtistSongs(); apClear.classList.remove('show'); });

// Sort chips
document.querySelectorAll('.sort-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.sort-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    apState.sort = chip.dataset.sort;
    loadArtistSongs();
  });
});

// New playlist
document.getElementById('new-playlist-btn').addEventListener('click', () => {
  document.getElementById('new-playlist-name').value = '';
  document.getElementById('new-playlist-modal').classList.add('show');
});
document.getElementById('new-playlist-cancel').addEventListener('click', () => closeModal('new-playlist-modal'));
document.getElementById('new-playlist-confirm').addEventListener('click', () => {
  const name = document.getElementById('new-playlist-name').value.trim();
  if (!name) return;
  Storage.createPlaylist(name);
  closeModal('new-playlist-modal');
  renderPlaylists();
});
document.getElementById('create-playlist-from-modal').addEventListener('click', () => {
  closeModal('playlist-modal');
  document.getElementById('new-playlist-name').value = '';
  document.getElementById('new-playlist-modal').classList.add('show');
});

// File import
document.getElementById('file-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const track = { id: Date.now().toString(), name: file.name.replace(/\.[^.]+$/, ''), size: file.size, dataUrl: ev.target.result };
    const offline = Storage.getOffline();
    Storage.setOffline([track, ...offline]);
    renderOffline();
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

// Close modals on overlay click
['playlist-modal','new-playlist-modal','queue-sheet'].forEach(id => {
  document.getElementById(id).addEventListener('click', e => {
    if (e.target.id === id) closeModal(id);
  });
});

/* ══════════════════════════════════
   INIT
══════════════════════════════════ */
buildGenreChips();
loadHomeSections();
