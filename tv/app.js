/**
 * Ariyan TV – IPTV Web Player
 * ───────────────────────────────────────────────────────
 * Features:
 *  • HLS.js for .m3u8 streams (with quality levels)
 *  • Shaka Player for DASH (.mpd) with ClearKey DRM
 *  • Quality selector (defaults to highest quality)
 *  • Auto-refresh playlists every 10 minutes
 *  • Lag-free / loop-free HLS config
 *  • Keyboard shortcuts
 *  • Responsive sidebar + mobile layout
 */

'use strict';

/* ─── CONFIG ─────────────────────────────────────────── */
const PLAYLISTS = {
  fifa: {
    label: 'FIFA',
    url:   'https://raw.githubusercontent.com/SHAJON-404/iptv-playlist/refs/heads/main/app/data/fifa.m3u',
  },
  bangla: {
    label: 'Bangla',
    url:   'https://raw.githubusercontent.com/SHAJON-404/iptv-playlist/refs/heads/main/app/data/bangla.m3u',
  },
};

const AUTO_REFRESH_MS = 10 * 60 * 1000; // 10 min

/* ─── STATE ──────────────────────────────────────────── */
const S = {
  playlist:    'fifa',
  channels:    {},       // { fifa:[…], bangla:[…] }
  filtered:    [],
  activeIdx:   -1,
  hls:         null,
  shaka:       null,
  timer:       null,
  lastRefresh: {},
  qualities:   [],
  activeQual:  -1,
  muted:       false,
  bufDelay:    null,     // debounce timer for buffer spinner
};

/* ─── DOM ────────────────────────────────────────────── */
const el = (id) => document.getElementById(id);

const D = {
  vid:           el('vid'),
  chList:        el('channel-list'),
  sidebarLoader: el('sidebar-loader'),
  idleOv:        el('idle-overlay'),
  bufOv:         el('buf-overlay'),
  errOv:         el('err-overlay'),
  errTitle:      el('err-title'),
  errMsg:        el('err-msg'),
  search:        el('channel-search'),
  chCount:       el('ch-count'),
  npLogo:        el('np-logo'),
  npName:        el('np-name'),
  refreshBtn:    el('refresh-btn'),
  refreshLabel:  el('refresh-label'),
  sidebar:       el('sidebar'),
  sidebarToggle: el('sidebar-toggle'),
  prevBtn:       el('prev-btn'),
  nextBtn:       el('next-btn'),
  muteBtn:       el('mute-btn'),
  fsBtn:         el('fs-btn'),
  qualityWrap:   el('quality-wrap'),
  qualityToggle: el('quality-toggle'),
  qualityLabel:  el('quality-label'),
  qualityMenu:   el('quality-menu'),
  toastRack:     el('toast-rack'),
  kbdHint:       el('kbd-hint'),
};

/* ─── INIT ───────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  wireEvents();
  loadPlaylist('fifa');
  loadPlaylist('bangla');          // pre-load both
  startAutoRefresh();
  showKbdHint();
});

/* ─── EVENTS ─────────────────────────────────────────── */
function wireEvents() {
  // Tabs
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchPlaylist(btn.dataset.playlist));
  });

  // Search
  D.search.addEventListener('input', handleSearch);

  // Refresh
  D.refreshBtn.addEventListener('click', async () => {
    D.refreshBtn.classList.add('spin');
    await loadPlaylist(S.playlist, true);
    setTimeout(() => D.refreshBtn.classList.remove('spin'), 700);
  });

  // Sidebar toggle
  D.sidebarToggle.addEventListener('click', toggleSidebar);

  // Prev / Next
  D.prevBtn.addEventListener('click', () => stepChannel(-1));
  D.nextBtn.addEventListener('click', () => stepChannel(+1));

  // Retry
  el('retry-btn').addEventListener('click', retryStream);

  // Mute
  D.muteBtn.addEventListener('click', toggleMute);

  // Fullscreen
  D.fsBtn.addEventListener('click', toggleFullscreen);

  // Quality toggle
  D.qualityToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !D.qualityMenu.classList.contains('hidden');
    D.qualityMenu.classList.toggle('hidden', isOpen);
    D.qualityToggle.setAttribute('aria-expanded', !isOpen);
  });

  // Close quality on outside click
  document.addEventListener('click', () => {
    D.qualityMenu.classList.add('hidden');
    D.qualityToggle.setAttribute('aria-expanded', 'false');
  });

  // Video events — debounced buffer spinner (don't flash on brief segment fetches)
  D.vid.addEventListener('waiting',  onVidWaiting);
  D.vid.addEventListener('stalled',  onVidWaiting);
  D.vid.addEventListener('playing',  onVidPlaying);
  D.vid.addEventListener('canplay',  onVidPlaying);
  D.vid.addEventListener('timeupdate', onVidTimeUpdate);
  D.vid.addEventListener('error',    handleVidError);

  // Keyboard
  document.addEventListener('keydown', handleKeyboard);

  // Kbd hint dismiss
  el('kbd-close').addEventListener('click', () => D.kbdHint.classList.add('hidden'));

  // Fullscreen change
  document.addEventListener('fullscreenchange', updateFsIcon);
}

/* ─── PLAYLIST LOAD (M3U) ────────────────────────── */
async function loadPlaylist(key, force = false) {
  const cfg = PLAYLISTS[key];
  if (!cfg) return;

  if (key === S.playlist) showSidebarLoader(true);

  try {
    // Cache-bust so auto-refresh always gets fresh data
    const res = await fetch(cfg.url + `?_=${Date.now()}`, {
      cache: 'no-store',
      headers: { Accept: 'audio/mpegurl, application/vnd.apple.mpegurl, text/plain, */*' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();

    const parsed = parseM3U(text);
    if (!parsed.length) throw new Error('Empty or invalid M3U');

    S.channels[key] = parsed;
    S.lastRefresh[key] = Date.now();

    if (key === S.playlist) {
      S.filtered = [...S.channels[key]];
      renderList(S.filtered);
      updateCount(S.filtered.length);
    }

    updateRefreshLabel();
    if (force) toast(`${cfg.label} playlist refreshed ✓`);

  } catch (err) {
    console.warn('[AriyanTV] Playlist load error:', err);
    if (key === S.playlist) toast('Failed to load playlist', 'err');
  } finally {
    if (key === S.playlist) showSidebarLoader(false);
  }
}


/**
 * Robust M3U / M3U8 extended playlist parser.
 *
 * Handles:
 *  • Standard:      #EXTINF:-1 tvg-logo="..." group-title="...",Name
 *  • Space variant: # EXTINF:-1 tvg-logo="..." group-title="...",Name
 *    (used in the Bangla playlist)
 *  • Bare URLs with no #EXTINF header
 *  • .m3u8 (HLS), .mpd (DASH), and .ts stream URLs
 */
function parseM3U(text) {
  const lines   = text.split(/\r?\n/);
  const results = [];
  let meta      = null;
  let idx       = 0;

  // Matches both "#EXTINF" and "# EXTINF" (Bangla variant uses space after #)
  const EXTINF_RE = /^#\s*EXTINF\s*:(.*)/i;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;

    // ── #EXTINF line ──────────────────────────────────────────
    const mExt = raw.match(EXTINF_RE);
    if (mExt) {
      const info = mExt[1]; // everything after "#EXTINF:"

      // Extract key="value" or key=value attributes
      const attr = (key) => {
        const m = info.match(new RegExp(`${key}=[\"']?([^\"',\\s]+)[\"']?`, 'i'));
        return m ? decodeURIComponent(m[1]) : '';
      };

      // Channel name: text after the last comma on the EXTINF line
      const commaIdx = info.lastIndexOf(',');
      const name = commaIdx >= 0 ? info.slice(commaIdx + 1).trim() : '';

      meta = {
        name:  name || 'Unknown',
        logo:  attr('tvg-logo'),
        group: attr('group-title'),
        id:    attr('tvg-id') || attr('channel-id') || `ch-${idx}`,
      };
      continue;
    }

    // ── Skip other directive/comment lines ────────────────────
    if (raw.startsWith('#')) continue;

    // ── URL line ──────────────────────────────────────────────
    if (/^https?:\/\/|^\//.test(raw) || raw.endsWith('.m3u8') || raw.endsWith('.mpd') || raw.endsWith('.ts')) {
      const url  = raw;
      const type = url.includes('.mpd') ? 'dash' : 'hls';
      results.push({
        id:    meta?.id    || `ch-${idx}`,
        name:  meta?.name  || url.split('/').pop().replace(/\.[^.]+$/, '') || 'Channel',
        logo:  meta?.logo  || '',
        group: meta?.group || '',
        url,
        type,
        kid: '',
        key: '',
      });
      meta = null;
      idx++;
    }
  }

  return results;
}

/* ─── RENDER CHANNELS ────────────────────────────────── */
function renderList(list) {
  // Remove old items
  D.chList.querySelectorAll('.ch-item,.no-results').forEach((n) => n.remove());

  if (!list.length) {
    const d = document.createElement('div');
    d.className = 'no-results';
    d.textContent = 'No channels found';
    D.chList.appendChild(d);
    return;
  }

  const frag = document.createDocumentFragment();
  const allChs = S.channels[S.playlist] || [];

  list.forEach((ch) => {
    const realIdx = allChs.indexOf(ch);
    frag.appendChild(makeChItem(ch, realIdx));
  });

  D.chList.appendChild(frag);
}

function makeChItem(ch, realIdx) {
  const btn = document.createElement('button');
  btn.className = 'ch-item' + (realIdx === S.activeIdx ? ' active' : '');
  btn.role = 'option';
  btn.setAttribute('aria-selected', realIdx === S.activeIdx ? 'true' : 'false');
  btn.dataset.idx = realIdx;

  // Thumb
  const thumb = document.createElement('div');
  thumb.className = 'ch-thumb';
  if (ch.logo) {
    const img = document.createElement('img');
    img.src = ch.logo;
    img.alt = ch.name + ' logo';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.onerror = () => { img.remove(); thumb.appendChild(makeFb(ch)); };
    thumb.appendChild(img);
  } else {
    thumb.appendChild(makeFb(ch));
  }

  // Meta
  const meta = document.createElement('div');
  meta.className = 'ch-meta';
  const name = document.createElement('div');
  name.className = 'ch-name';
  name.textContent = ch.name;
  meta.appendChild(name);
  if (ch.group) {
    const grp = document.createElement('div');
    grp.className = 'ch-grp';
    grp.textContent = ch.group;
    meta.appendChild(grp);
  }

  // Live badge
  const live = document.createElement('span');
  live.className = 'ch-live';
  live.textContent = 'LIVE';

  btn.appendChild(thumb);
  btn.appendChild(meta);
  btn.appendChild(live);

  btn.addEventListener('click', () => playChannel(realIdx));
  return btn;
}

function makeFb(ch) {
  const s = document.createElement('span');
  s.className = 'ch-thumb-fb';
  s.textContent = ch.name.charAt(0).toUpperCase();
  return s;
}

/* ─── PLAYBACK ───────────────────────────────────────── */
async function playChannel(idx) {
  const chs = S.channels[S.playlist];
  if (!chs || idx < 0 || idx >= chs.length) return;

  const ch = chs[idx];
  S.activeIdx = idx;

  // UI updates
  setActiveItem(idx);
  setNowPlaying(ch);
  hideErr();
  D.idleOv.classList.add('hidden');
  showBuf(true);

  // Destroy old instances
  destroyAll();

  // Clear quality
  clearQuality();

  try {
    if (ch.type === 'dash') {
      await startShaka(ch);
    } else {
      await startHls(ch);
    }
  } catch (err) {
    console.error('[AriyanTV] Playback failed:', err);
    showErr('Playback Failed', err.message || 'Unable to play this stream.');
    showBuf(false);
  }
}

/* ── HLS.js (lag-free config) ── */
async function startHls(ch) {
  if (!Hls.isSupported()) {
    // Native Safari HLS
    if (D.vid.canPlayType('application/vnd.apple.mpegurl')) {
      D.vid.src = ch.url;
      await D.vid.play().catch(() => {});
      showBuf(false);
      return;
    }
    throw new Error('HLS not supported');
  }

  const hls = new Hls({
    enableWorker:                true,
    lowLatencyMode:              false,
    liveSyncDurationCount:       3,
    liveMaxLatencyDurationCount: 10,
    maxLiveSyncPlaybackRate:     1.05,

    // ── Aggressive buffering so live stream never starves ──
    backBufferLength:            60,   // keep 60s behind current pos
    maxBufferLength:             90,   // try to buffer 90s ahead
    maxMaxBufferLength:          120,  // absolute cap
    maxBufferHole:               0.5,

    enableSoftwareAES:           true,
    startLevel:                  -1,
    manifestLoadingMaxRetry:     3,
    manifestLoadingRetryDelay:   1500,
    levelLoadingMaxRetry:        3,
    levelLoadingRetryDelay:      1000,
    fragLoadingMaxRetry:         4,
    fragLoadingRetryDelay:       500,
    nudgeMaxRetry:               4,
    highBufferWatchdogPeriod:    3,
  });

  S.hls = hls;

  hls.loadSource(ch.url);
  hls.attachMedia(D.vid);

  await new Promise((resolve, reject) => {
    let settled = false;
    let recoveryAttempts = 0;
    const MAX_RECOVERY = 2;
    let timeoutId;

    // Settles once — clears timeout, calls fn exactly once
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      fn(arg);
    };

    // Manifest received → build quality picker → resolve
    hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
      buildQualityMenu(hls, data.levels);
      settle(resolve);
    });

    // Error handler — recover if possible, reject only as last resort
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return; // hls.js self-recovers non-fatal errors

      // Never kill a session that is actively delivering frames
      if (D.vid.currentTime > 0 && !D.vid.paused) {
        console.warn('[AriyanTV] HLS error on active stream – ignored:', data.details);
        return;
      }

      if (recoveryAttempts < MAX_RECOVERY) {
        recoveryAttempts++;
        console.warn(`[AriyanTV] HLS fatal – recovery ${recoveryAttempts}/${MAX_RECOVERY}:`, data.type, data.details);
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls.startLoad();          // retry stalled network request
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();  // fix MSE decode issues
        } else {
          settle(reject, new Error(data.details || 'Stream error'));
        }
      } else {
        hls.stopLoad();
        settle(reject, new Error(data.details || 'Stream unavailable'));
      }
    });

    // 45 s timeout — only fires when video has zero frames decoded
    timeoutId = setTimeout(() => {
      if (D.vid.currentTime > 0) {
        settle(resolve);  // video is alive — slow manifest, not a real failure
      } else {
        hls.stopLoad();
        settle(reject, new Error('Stream unavailable – may be offline or geo-restricted'));
      }
    }, 45000);
  });

  await D.vid.play().catch(() => {});
  showBuf(false);
}

/* ── Shaka Player (DASH + ClearKey DRM) ── */
async function startShaka(ch) {
  shaka.polyfill.installAll();

  if (!shaka.Player.isBrowserSupported()) {
    throw new Error('DASH not supported in your browser');
  }

  const player = new shaka.Player();
  await player.attach(D.vid);
  S.shaka = player;

  player.addEventListener('error', (e) => console.warn('[Shaka]', e.detail));

  const cfg = {
    streaming: {
      bufferingGoal:    30,
      rebufferingGoal:  2,
      stallEnabled:     true,
      stallThreshold:   1,
      stallSkip:        0.1,
    },
    abr: {
      enabled:           true,
      defaultBandwidthEstimate: 10e6, // 10 Mbps default → prefers high quality
    },
  };

  // ClearKey DRM
  if (ch.kid && ch.key) {
    cfg.drm = { clearKeys: { [ch.kid]: ch.key } };
  }

  player.configure(cfg);

  await player.load(ch.url).catch((e) => {
    throw new Error(e.message || 'DASH load failed');
  });

  // Build quality menu from Shaka tracks
  buildShakaQuality(player);

  await D.vid.play().catch(() => {});
  showBuf(false);
}

function destroyAll() {
  if (S.hls)   { S.hls.stopLoad(); S.hls.destroy(); S.hls = null; }
  if (S.shaka) { S.shaka.destroy(); S.shaka = null; }
  D.vid.removeAttribute('src');
  D.vid.load();
}

/* ─── QUALITY CONTROL ────────────────────────────────── */
function buildQualityMenu(hls, levels) {
  S.qualities = levels;
  D.qualityWrap.classList.remove('hidden');
  D.qualityMenu.innerHTML = '';

  // Sort levels descending by height/bitrate
  const sorted = levels
    .map((l, i) => ({ i, height: l.height || 0, bitrate: l.bitrate || 0, name: l.name || '' }))
    .sort((a, b) => b.height - a.height || b.bitrate - a.bitrate);

  // Auto = highest available
  const highestIdx = sorted[0]?.i ?? -1;
  hls.currentLevel = highestIdx;
  S.activeQual = highestIdx;

  // Label shown on button
  const topLevel = levels[highestIdx];
  D.qualityLabel.textContent = fmtQuality(topLevel);

  // "Auto (Best)" option
  const autoBtn = makeQItem('Auto (Best)', '', highestIdx, () => {
    hls.currentLevel    = highestIdx;   // lock to highest (not truly auto-ABR to avoid drops)
    S.activeQual = highestIdx;
    D.qualityLabel.textContent = fmtQuality(topLevel);
    updateQMenuActive(highestIdx);
    D.qualityMenu.classList.add('hidden');
  });
  autoBtn.classList.add('selected');
  D.qualityMenu.appendChild(autoBtn);

  // Per-level options
  sorted.forEach(({ i }) => {
    const lvl = levels[i];
    const label = fmtQuality(lvl);
    const badge = lvl.height ? (lvl.height >= 1080 ? '4K/FHD' : lvl.height >= 720 ? 'HD' : 'SD') : '';
    const btn = makeQItem(label, badge, i, () => {
      hls.currentLevel = i;
      S.activeQual = i;
      D.qualityLabel.textContent = label;
      updateQMenuActive(i);
      D.qualityMenu.classList.add('hidden');
      toast(`Quality: ${label}`);
    });
    D.qualityMenu.appendChild(btn);
  });
}

function buildShakaQuality(player) {
  const tracks = player.getVariantTracks().sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  if (!tracks.length) return;

  D.qualityWrap.classList.remove('hidden');
  D.qualityMenu.innerHTML = '';

  // Pick highest by default
  player.selectVariantTrack(tracks[0], /* clearBuffer= */ true);
  D.qualityLabel.textContent = fmtShakaTrack(tracks[0]);

  tracks.forEach((t) => {
    const label = fmtShakaTrack(t);
    const badge = t.height ? (t.height >= 1080 ? 'FHD' : t.height >= 720 ? 'HD' : 'SD') : '';
    const btn = makeQItem(label, badge, t.id, () => {
      player.selectVariantTrack(t, true);
      D.qualityLabel.textContent = label;
      updateQMenuActive(t.id);
      D.qualityMenu.classList.add('hidden');
      toast(`Quality: ${label}`);
    });
    D.qualityMenu.appendChild(btn);
  });

  // Mark first as selected
  D.qualityMenu.querySelector('.quality-menu-item')?.classList.add('selected');
}

function makeQItem(text, badge, id, onClick) {
  const btn = document.createElement('button');
  btn.className = 'quality-menu-item';
  btn.role = 'option';
  btn.dataset.qid = id;
  btn.textContent = text;
  if (badge) {
    const b = document.createElement('span');
    b.className = 'q-badge';
    b.textContent = badge;
    btn.appendChild(b);
  }
  btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return btn;
}

function updateQMenuActive(id) {
  D.qualityMenu.querySelectorAll('.quality-menu-item').forEach((b) => {
    b.classList.toggle('selected', b.dataset.qid == id);
  });
}

function clearQuality() {
  D.qualityMenu.innerHTML = '';
  D.qualityLabel.textContent = 'HD';
  D.qualityWrap.classList.add('hidden');
  S.qualities = [];
}

function fmtQuality(l) {
  if (!l) return '?p';
  if (l.height) return `${l.height}p`;
  if (l.bitrate) return `${Math.round(l.bitrate / 1000)}k`;
  if (l.name) return l.name;
  return 'Auto';
}
function fmtShakaTrack(t) {
  if (t.height) return `${t.height}p`;
  if (t.bandwidth) return `${Math.round(t.bandwidth / 1000)}k`;
  return 'Auto';
}

/* ─── NAVIGATION ─────────────────────────────────────── */
function stepChannel(dir) {
  const chs = S.channels[S.playlist];
  if (!chs?.length) return;
  let next = S.activeIdx + dir;
  if (next < 0) next = chs.length - 1;
  if (next >= chs.length) next = 0;
  playChannel(next);
}

/* ─── SEARCH ─────────────────────────────────────────── */
function handleSearch() {
  const q = D.search.value.trim().toLowerCase();
  const all = S.channels[S.playlist] || [];
  S.filtered = q
    ? all.filter((c) => c.name.toLowerCase().includes(q) || c.group.toLowerCase().includes(q))
    : [...all];
  renderList(S.filtered);
  updateCount(S.filtered.length);
}

/* ─── PLAYLIST SWITCH ────────────────────────────────── */
async function switchPlaylist(key) {
  // Always allow switching even if same key (user may want a refresh)
  if (key === S.playlist && S.channels[key]?.length) {
    // Just re-render in case something was stale
    S.filtered = [...S.channels[key]];
    renderList(S.filtered);
    updateCount(S.filtered.length);
    return;
  }

  S.playlist  = key;
  S.activeIdx = -1;
  D.search.value = '';

  // Update tab appearance
  document.querySelectorAll('.tab-btn').forEach((b) => {
    const on = b.dataset.playlist === key;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });

  // Reset scroll
  D.chList.scrollTop = 0;

  if (S.channels[key]?.length) {
    // Already cached – render immediately, no loader needed
    showSidebarLoader(false);
    S.filtered = [...S.channels[key]];
    renderList(S.filtered);
    updateCount(S.filtered.length);
    updateRefreshLabel();
  } else {
    // Need to fetch
    await loadPlaylist(key);
  }
}

/* ─── AUTO REFRESH ───────────────────────────────────── */
function startAutoRefresh() {
  clearInterval(S.timer);
  S.timer = setInterval(() => {
    loadPlaylist(S.playlist);
    const other = S.playlist === 'fifa' ? 'bangla' : 'fifa';
    loadPlaylist(other);
    updateRefreshLabel();
  }, AUTO_REFRESH_MS);
}

function updateRefreshLabel() {
  const ts = S.lastRefresh[S.playlist];
  if (!ts) return;
  const m = Math.floor((Date.now() - ts) / 60000);
  D.refreshLabel.textContent = m < 1 ? 'Just now' : `${m}m ago`;
}

/* ─── MUTE ───────────────────────────────────────────── */
function toggleMute() {
  S.muted = !S.muted;
  D.vid.muted = S.muted;
  D.muteBtn.classList.toggle('active-ctrl', S.muted);
  const w1 = document.getElementById('vol-wave1');
  const w2 = document.getElementById('vol-wave2');
  if (w1) w1.style.opacity = S.muted ? '0' : '1';
  if (w2) w2.style.opacity = S.muted ? '0' : '1';
  toast(S.muted ? 'Muted 🔇' : 'Unmuted 🔊');
}

/* ─── FULLSCREEN ─────────────────────────────────────── */
function toggleFullscreen() {
  const wrap = document.getElementById('video-wrap');
  if (!document.fullscreenElement) {
    wrap.requestFullscreen().catch(console.error);
  } else {
    document.exitFullscreen();
  }
}
function updateFsIcon() {
  const isFs = !!document.fullscreenElement;
  D.fsBtn.classList.toggle('active-ctrl', isFs);
  D.fsBtn.title = isFs ? 'Exit Fullscreen' : 'Fullscreen';
}

/* ─── VIDEO BUFFER HANDLERS (debounced) ──────────────── */

// Only show the spinner if buffering lasts more than 800ms.
// Brief micro-stalls during segment fetches are normal on live HLS
// and must never trigger a visible spinner.
function onVidWaiting() {
  clearTimeout(S.bufDelay);
  S.bufDelay = setTimeout(() => {
    // One last check — if video resumed by now, skip it
    if (!D.vid.paused || D.vid.currentTime === 0) {
      D.bufOv.classList.remove('hidden');
    }
  }, 800);
}

// Video is delivering frames — immediately clear any pending/shown spinner
function onVidPlaying() {
  clearTimeout(S.bufDelay);
  S.bufDelay = null;
  D.bufOv.classList.add('hidden');
  hideErr();
}

// timeupdate fires ~4× per second while frames arrive.
// If the spinner is visible but video is progressing, dismiss it.
function onVidTimeUpdate() {
  if (!D.bufOv.classList.contains('hidden')) {
    clearTimeout(S.bufDelay);
    S.bufDelay = null;
    D.bufOv.classList.add('hidden');
  }
}

/* ─── VIDEO ERROR ────────────────────────────────────── */
function handleVidError() {
  const code = D.vid.error?.code;
  const map  = {
    1: 'Playback aborted by browser.',
    2: 'Network error – check your connection.',
    3: 'Decoding error – stream may be corrupted.',
    4: 'Format not supported in your browser.',
  };
  showErr('Stream Error', map[code] || 'An error occurred during playback.');
  showBuf(false);
}

/* ─── KEYBOARD ───────────────────────────────────────── */
function handleKeyboard(e) {
  if (e.target === D.search) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key) {
    case 'ArrowUp':   case 'ArrowLeft':  e.preventDefault(); stepChannel(-1); break;
    case 'ArrowDown': case 'ArrowRight': e.preventDefault(); stepChannel(+1); break;
    case 'f': case 'F': toggleFullscreen(); break;
    case 'm': case 'M': toggleMute(); break;
    case 's': case 'S': toggleSidebar(); break;
    case '/': e.preventDefault(); D.search.focus(); break;
  }
}

/* ─── KEYBOARD HINT ──────────────────────────────────── */
function showKbdHint() {
  D.kbdHint.classList.remove('hidden');
  setTimeout(() => D.kbdHint.classList.add('hidden'), 8000);
}

/* ─── UI HELPERS ─────────────────────────────────────── */
function showSidebarLoader(on) {
  D.sidebarLoader.style.display = on ? 'flex' : 'none';
}

// Direct show/hide for the buffer overlay.
// When hiding, always cancel any pending debounce timer too.
function showBuf(on) {
  if (!on) {
    clearTimeout(S.bufDelay);
    S.bufDelay = null;
  }
  D.bufOv.classList.toggle('hidden', !on);
}

function showErr(title, msg) {
  D.errTitle.textContent = title;
  D.errMsg.textContent   = msg;
  D.errOv.classList.remove('hidden');
  showBuf(false);
}
function hideErr() { D.errOv.classList.add('hidden'); }

function retryStream() {
  hideErr();
  if (S.activeIdx >= 0) playChannel(S.activeIdx);
}

function setActiveItem(idx) {
  D.chList.querySelectorAll('.ch-item').forEach((b) => {
    const on = parseInt(b.dataset.idx, 10) === idx;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on) b.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
}

function setNowPlaying(ch) {
  D.npName.textContent = ch.name;
  if (ch.logo) {
    D.npLogo.src = ch.logo;
    D.npLogo.style.display = '';
    D.npLogo.onerror = () => { D.npLogo.style.display = 'none'; };
  } else {
    D.npLogo.style.display = 'none';
  }
  document.title = `${ch.name} – Ariyan TV`;
}

function updateCount(n) {
  D.chCount.textContent = `${n} channel${n !== 1 ? 's' : ''}`;
}

function toggleSidebar() {
  const c = D.sidebar.classList.toggle('collapsed');
  D.sidebarToggle.setAttribute('aria-expanded', !c ? 'true' : 'false');
}

/* ─── TOAST ──────────────────────────────────────────── */
function toast(msg, type = 'info', ms = 3000) {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  D.toastRack.appendChild(t);
  setTimeout(() => {
    t.classList.add('fade');
    setTimeout(() => t.remove(), 250);
  }, ms);
}
