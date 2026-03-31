import { createIcon, ICONS } from '../shared/icons.js';

// ── Vibrant colour extraction ─────────────────────────────────────────────────
async function extractVibrantColor(dataUrl) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const size = 64;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, size, size);
      const { data } = ctx.getImageData(0, 0, size, size);

      let bestScore = -1, bestR = 0, bestG = 0, bestB = 0; // vivid
      let fallScore = -1, fallR = 255, fallG = 255, fallB = 255; // fallback (any non-black)

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i+1], b = data[i+2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const lightness = (max + min) / 510;
        const sat = max === 0 ? 0 : (max - min) / max;

        if (lightness < 0.08) continue; // skip near-black

        // Primary: prefer saturated, reasonably bright colours
        if (sat >= 0.25 && lightness >= 0.18) {
          const score = sat * 0.7 + lightness * 0.3;
          if (score > bestScore) { bestScore = score; bestR = r; bestG = g; bestB = b; }
        }

        // Fallback: any non-black pixel, heavily biased toward light/white
        const score = lightness * 0.85 + sat * 0.15;
        if (score > fallScore) { fallScore = score; fallR = r; fallG = g; fallB = b; }
      }

      // Use vivid colour if found; otherwise fall back to dominant light colour (allows white)
      let r = bestScore >= 0 ? bestR : fallR;
      let g = bestScore >= 0 ? bestG : fallG;
      let b = bestScore >= 0 ? bestB : fallB;

      if (bestScore < 0 && fallScore < 0) { resolve(null); return; }

      // Enforce a minimum brightness on vivid colours — mix toward white if too dark
      if (bestScore >= 0) {
        const MIN_L = 0.5;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const L = (max + min) / 510;
        if (L < MIN_L && L < 1) {
          const t = (MIN_L - L) / (1 - L);
          r = Math.round(r + t * (255 - r));
          g = Math.round(g + t * (255 - g));
          b = Math.round(b + t * (255 - b));
        }
      }

      resolve(`rgb(${r},${g},${b})`);
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const TOKEN = params.get('token') || sessionStorage.getItem('deck_token') || '';
if (TOKEN) sessionStorage.setItem('deck_token', TOKEN);

const HOST = location.host;
const WS_PROTOCOL = location.protocol === 'https:' ? 'wss' : 'ws';
const WS_URL = `${WS_PROTOCOL}://${HOST}/ws/panel`;

let config = null;
let ws = null;
let reconnectTimer = null;
let tileStates = {};
let mediaPollingTimer = null;
let appIconCache = null; // lazy map: packageName → base64
let micRafId = null;

// ── Debug overlay ──────────────────────────────────────────────────────────────
const DEBUG = (() => {
  const msgs = [];
  const statusMap = {};
  let visible = false;

  // Root overlay
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.93);z-index:10000;display:none;flex-direction:column;font:12px/1.5 monospace;color:#ddd';

  // Header
  const hdr = document.createElement('div');
  hdr.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;background:#111;border-bottom:1px solid #333;flex-shrink:0';
  const titleEl = document.createElement('span');
  titleEl.style.cssText = 'color:#0af;font-weight:bold;flex:1';
  titleEl.textContent = 'Debug';
  const clearBtn = document.createElement('button');
  clearBtn.textContent = 'Clear';
  clearBtn.style.cssText = 'background:#1a1a1a;border:1px solid #444;color:#aaa;padding:2px 10px;border-radius:4px;font:11px monospace;cursor:pointer';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'background:none;border:none;color:#888;font-size:18px;cursor:pointer;padding:0 4px;line-height:1';
  hdr.append(titleEl, clearBtn, closeBtn);

  // Status section (live key/value pairs)
  const statusEl = document.createElement('div');
  statusEl.style.cssText = 'padding:5px 12px;background:#0a0f0a;border-bottom:1px solid #1a2a1a;flex-shrink:0;min-height:22px;white-space:pre-wrap;color:#4f4';

  // Log section
  const logEl = document.createElement('div');
  logEl.style.cssText = 'flex:1;overflow-y:auto;padding:6px 12px;display:flex;flex-direction:column;gap:1px';

  root.append(hdr, statusEl, logEl);
  document.body.appendChild(root);

  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;');

  const renderStatus = () => {
    statusEl.textContent = Object.entries(statusMap).map(([k,v]) => `${k}: ${v}`).join('   ');
  };

  const addRow = (m) => {
    const div = document.createElement('div');
    div.style.color = m.level === 'error' ? '#f66' : m.level === 'warn' ? '#fa6' : '#8f8';
    div.style.wordBreak = 'break-all';
    div.textContent = `[${m.ts}] ${m.text}`;
    logEl.appendChild(div);
    if (msgs.length > 200) logEl.firstElementChild?.remove();
    logEl.scrollTop = logEl.scrollHeight;
  };

  const addMsg = (level, args) => {
    const text = args.map(a => {
      if (a instanceof Error) return `${a.message}${a.stack ? '\n'+a.stack : ''}`;
      try { return typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a); } catch { return String(a); }
    }).join(' ');
    const ts = new Date().toLocaleTimeString([], {hour12:false});
    const m = { level, text, ts };
    msgs.push(m);
    if (msgs.length > 200) msgs.shift();
    if (visible) addRow(m);
  };

  clearBtn.onclick = () => { msgs.length = 0; logEl.innerHTML = ''; };
  closeBtn.onclick = () => { visible = false; root.style.display = 'none'; };

  // Intercept console
  for (const lvl of ['log','warn','error']) {
    const orig = console[lvl].bind(console);
    console[lvl] = (...a) => { orig(...a); addMsg(lvl, a); };
  }
  window.addEventListener('error', e => addMsg('error', [`${e.message} @ ${e.filename}:${e.lineno}`]));
  window.addEventListener('unhandledrejection', e => addMsg('error', [`Unhandled rejection: ${e.reason}`]));

  return {
    log:  (...a) => addMsg('log', a),
    warn: (...a) => addMsg('warn', a),
    err:  (...a) => addMsg('error', a),
    setStatus(key, val) {
      statusMap[key] = val;
      if (visible) renderStatus();
    },
    toggle() {
      visible = !visible;
      root.style.display = visible ? 'flex' : 'none';
      if (visible) {
        renderStatus();
        logEl.innerHTML = '';
        msgs.forEach(addRow);
      }
    },
  };
})();
window.toggleDebug = () => DEBUG.toggle();

function getAppIconB64(pkg) {
  if (!appIconCache) {
    appIconCache = {};
    try {
      const raw = window.Native?.getInstalledApps?.();
      if (raw) {
        const apps = JSON.parse(raw);
        for (const a of apps) appIconCache[a.packageName] = a.iconBase64 ?? '';
        // Upload to server so other platforms can use them
        const payload = apps
          .filter(a => a.iconBase64)
          .map(a => ({ packageName: a.packageName, iconBase64: a.iconBase64 }));
        if (payload.length) {
          fetch(`/api/app-icons?token=${encodeURIComponent(TOKEN)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }).catch(() => {});
        }
      }
    } catch {}
  }
  return appIconCache[pkg] ?? null;
}

const gridEl = document.getElementById('grid');
const indicator = document.getElementById('connection-indicator');
const errorOverlay = document.getElementById('error-overlay');
const errorMsg = document.getElementById('error-message');

function setConnected(ok) {
  indicator.className = 'indicator ' + (ok ? 'connected' : 'disconnected');
  if (ok) errorOverlay.classList.add('hidden');
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorOverlay.classList.remove('hidden');
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connect() {
  if (ws) ws.close();
  ws = new WebSocket(WS_URL);

  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));

  ws.onmessage = (e) => {
    try { handleServerMsg(JSON.parse(e.data)); } catch { /* ignore */ }
  };

  ws.onclose = () => {
    setConnected(false);
    showError('Disconnected — reconnecting...');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  };

  ws.onerror = () => {
    setConnected(false);
    showError('Connection error');
  };
}

function handleServerMsg(msg) {
  switch (msg.type) {
    case 'auth_ok':
      setConnected(true);
      if (!config) loadConfig();
      break;
    case 'auth_fail':
      showError('Auth failed: ' + (msg.reason ?? 'invalid token'));
      ws.close();
      break;
    case 'state':
      applyState(msg.tiles ?? []);
      break;
    case 'reload':
      loadConfig();
      break;
    case 'ack':
      flashAck(msg.tileId);
      break;
  }
}

function sendWs(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

window.retryConnect = () => { clearTimeout(reconnectTimer); connect(); };


// ── Config ────────────────────────────────────────────────────────────────────
async function loadConfig() {
  try {
    const res = await fetch(`/api/config?token=${encodeURIComponent(TOKEN)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    config = await res.json();
    renderGrid();
  } catch (e) {
    showError(`Failed to load config: ${e.message}`);
  }
}

// ── State ─────────────────────────────────────────────────────────────────────
function applyState(tiles) {
  for (const t of tiles) {
    tileStates[t.id] = { data: t.data, stale: t.stale };
    updateTileData(t.id);
  }
}

// ── Android audio active detection ────────────────────────────────────────────
// Returns true when audio is actually flowing through this Android device's
// output right now. Uses AudioManager.isMusicActive — a hardware-level check
// that is true only when audio is physically playing through speakers/earbuds.
function isAndroidAudioActive() {
  if (!window.Native?.isMusicActive || !window.Native?.getVolume || !window.Native?.setVolume) return false;
  return !!callNative('isMusicActive');
}

function updateTileData(id) {
  const el = document.getElementById(`tile-${id}`);
  if (!el) return;
  if (el._dragging) return;
  const s = tileStates[id];
  if (!s) return;

  if (el._weatherUpdate) { el._weatherUpdate(s.data); return; }
  if (el._stocksUpdate)  { el._stocksUpdate(s.data); return; }
  if (el._volumeUpdate)  { el._volumeUpdate(s.data, s.stale); return; }
  if (el._micUpdate)     { el._micUpdate(s.data, s.stale); return; }

  if (el._mediaUpdate) {
    let d = null;
    try { if (s.data) d = JSON.parse(s.data); } catch {}
    el._mediaUpdate(d);
    return;
  }

  const dataEl = el.querySelector('.tile-data');
  if (dataEl) dataEl.textContent = s.data ?? '—';

  // Percentage fill bar
  const pctMatch = (s.data ?? '').match(/^(\d+(?:\.\d+)?)%$/);
  if (pctMatch) {
    el.style.setProperty('--pct', pctMatch[1] + '%');
    el.classList.add('has-pct');
  } else {
    el.style.removeProperty('--pct');
    el.classList.remove('has-pct');
  }

  // Icon variants — look up the tile config once
  const tile = config?.tiles?.find(t => t.id === id);

  if (!tile?.hideIcon && tile?.iconVariants?.length) {
    const val = s.data ?? '';
    const variant = tile.iconVariants.find(v => v.when === val);
    const iconName = variant?.icon ?? tile.icon;
    const iconWrap = el.querySelector('.tile-icon');
    if (iconWrap && iconName) {
      iconWrap.innerHTML = '';
      if (iconName.startsWith('app:')) {
        const pkg = iconName.slice(4);
        const dataUrl = getAppIconDataUrl(pkg);
        const img = document.createElement('img');
        img.className = 'tile-app-icon';
        if (dataUrl) {
          img.src = dataUrl;
        } else {
          img.src = `/api/app-icon/${encodeURIComponent(pkg)}?token=${encodeURIComponent(TOKEN)}`;
          img.onerror = () => { img.replaceWith(createIcon('app-window')); };
        }
        iconWrap.appendChild(img);
      } else {
        iconWrap.appendChild(createIcon(iconName));
      }
    }
  }

  el.classList.toggle('tile-stale', !!s.stale);
  let dot = el.querySelector('.stale-dot');
  if (s.stale && !dot) {
    dot = document.createElement('div');
    dot.className = 'stale-dot';
    el.appendChild(dot);
  } else if (!s.stale && dot) {
    dot.remove();
  }
}

// ── Grid ──────────────────────────────────────────────────────────────────────
function renderGrid() {
  if (!config) return;
  gridEl.style.gridTemplateColumns = `repeat(${config.columns}, 1fr)`;
  gridEl.style.gridTemplateRows = `repeat(${config.rows}, 1fr)`;
  gridEl.innerHTML = '';

  clearInterval(mediaPollingTimer);

  for (const tile of config.tiles) {
    gridEl.appendChild(buildTile(tile));
  }

  if (config.tiles.some(t => t.type === 'media')) {
    pollMedia();
    mediaPollingTimer = setInterval(pollMedia, 2000);
  }

  // Mic tiles always get the live ring; other tiles opt-in via liveRing: true
  const liveRingTiles = config.tiles.filter(t => t.liveRing || t.type === 'mic');
  if (liveRingTiles.length) startMicMonitor(liveRingTiles);

  for (const id of Object.keys(tileStates)) updateTileData(id);
}

async function startMicMonitor(tiles) {
  if (micRafId) { cancelAnimationFrame(micRafId); micRafId = null; }

  const serverAllows = (t) => {
    const v = tileStates[t.id]?.data;
    return !(!v || v === '—' || v === '0%');
  };

  const applyLevel = (el, level, on) => {
    el.style.setProperty('--ring-level', level.toFixed(3));
    el.classList.toggle('live-ring', on);
  };

  let ringOn = false, ringOffTimer = null;
  const applyAll = (level) => {
    if (level > 0.05) {
      ringOn = true;
      if (ringOffTimer) { clearTimeout(ringOffTimer); ringOffTimer = null; }
    } else if (ringOn && !ringOffTimer) {
      ringOffTimer = setTimeout(() => {
        ringOn = false; ringOffTimer = null;
        for (const t of tiles) {
          const el = document.getElementById(`tile-${t.id}`);
          if (el) applyLevel(el, 0, false);
        }
      }, 600);
    }
    for (const t of tiles) {
      const el = document.getElementById(`tile-${t.id}`);
      if (!el) continue;
      const show = ringOn && serverAllows(t);
      applyLevel(el, show ? level : 0, show);
    }
  };

  // ── Path 1: Android native AudioRecord (works over HTTP) ──────────────────
  if (window.Native?.startMicMonitor && window.Native?.getMicLevel) {
    window.Native.startMicMonitor();
    DEBUG.setStatus('mic', 'native AudioRecord active');
    window.addEventListener('beforeunload', () => window.Native.stopMicMonitor?.(), { once: true });

    setInterval(() => {
      const level = window.Native.getMicLevel() ?? 0;
      DEBUG.setStatus('mic', `native lvl:${level.toFixed(3)}`);
      applyAll(level);
    }, 80);
    return;
  }

  // ── Path 2: Web Audio API (desktop / HTTPS) ───────────────────────────────
  if (navigator.mediaDevices?.getUserMedia) {
    let isMuted = false;
    const syncMute = () => { if (window.Native?.isMicActive) isMuted = !window.Native.isMicActive(); };
    syncMute();
    setInterval(syncMute, 400);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.minDecibels = -35;
      analyser.maxDecibels = -10;
      analyser.smoothingTimeConstant = 0.85;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const hzPerBin = ctx.sampleRate / analyser.fftSize;
      const binLow  = Math.max(1, Math.floor(300  / hzPerBin));
      const binHigh = Math.min(buf.length - 1, Math.ceil(3400 / hzPerBin));

      const tick = () => {
        micRafId = requestAnimationFrame(tick);
        let level = 0, rms = 0;
        if (!isMuted) {
          analyser.getByteFrequencyData(buf);
          let sum = 0;
          for (let i = binLow; i <= binHigh; i++) sum += buf[i] * buf[i];
          rms = Math.sqrt(sum / (binHigh - binLow + 1)) / 255;
          level = Math.min(rms * 2, 1);
        }
        DEBUG.setStatus('mic', `webaudio rms:${rms.toFixed(3)} lvl:${level.toFixed(3)}`);
        applyAll(level);
      };
      tick();
      return;
    } catch (err) {
      DEBUG.err('getUserMedia failed:', err);
    }
  }

  // ── Path 3: binary isMicActive fallback ───────────────────────────────────
  if (window.Native?.isMicActive) {
    DEBUG.setStatus('mic', 'fallback: isMicActive');
    setInterval(() => applyAll(window.Native.isMicActive() ? 0.7 : 0), 400);
  } else {
    DEBUG.setStatus('mic', 'no mic support');
  }
}

function buildTile(tile) {
  const el = document.createElement('div');
  el.id = `tile-${tile.id}`;
  el.className = `tile tile-${tile.type}`;

  const pos = tile.position;
  el.style.gridRow    = `${pos.row + 1} / span ${pos.rowSpan ?? 1}`;
  el.style.gridColumn = `${pos.col + 1} / span ${pos.colSpan ?? 1}`;

  if (tile.type === 'spacer') {
    el.classList.add('tile-spacer');
    return el;
  }

  switch (tile.type) {
    case 'clock':    buildClock(el, tile);     break;
    case 'weather':  buildWeather(el, tile);  break;
    case 'media':    buildMedia(el, tile);    break;
    case 'calendar': buildCalendar(el, tile); break;
    case 'volume':   buildVolume(el, tile);   break;
    case 'mic':      buildMic(el, tile);      break;
    case 'stocks':   buildStocks(el, tile);   break;
    default:         buildGeneric(el, tile);  break;
  }

  if (tile.type === 'volume' || tile.type === 'mic') {
    // drag + tap handled inside buildVolume / buildMic via touch events
  } else if (tile.type === 'stocks') {
    setupStocksTap(el, tile);
  } else if (tile.type === 'pc_data' && tile.action?.dragCommand) {
    setupDrag(el, tile);
  } else {
    el.addEventListener('pointerdown',  () => el.classList.add('tapping'));
    el.addEventListener('pointerup',    () => { el.classList.remove('tapping'); onTap(tile); });
    el.addEventListener('pointerleave', () => el.classList.remove('tapping'));
  }
  return el;
}

function setupStocksTap(el, tile) {
  // No scale effect; allow native scroll in the list; tap fires onTap if touch is quick and outside list
  const list = () => el.querySelector('.stocks-list');
  let startY = 0, startX = 0, moved = false, inList = false;

  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    moved = false;
    inList = list()?.contains(e.target) ?? false;
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    const dy = Math.abs(e.touches[0].clientY - startY);
    const dx = Math.abs(e.touches[0].clientX - startX);
    if (dy > 8 || dx > 8) moved = true;
  }, { passive: true });

  el.addEventListener('touchend', () => {
    if (!moved && !inList) onTap(tile);
  }, { passive: true });
}

// Fixed px-per-percent: 2px of drag = 1% change regardless of tile size
const DRAG_PX_PER_PCT = 2;
const DRAG_MOVE_THRESHOLD = 20; // px before drag activates (vs tap)
const DRAG_THROTTLE_MS = 40;    // max send rate ~25fps

function setupDrag(el, tile) {
  el.classList.add('tile-draggable');
  let startY = 0, startPct = 0, startTime = 0, dragging = false, moved = false;
  let lastSentPct = -1, lastSendTime = 0, sendTimer = null;
  el._dragging = false;

  const flushSend = (pct) => {
    lastSentPct = pct;
    lastSendTime = Date.now();
    sendWs({ type: 'tile_drag', tileId: tile.id, value: pct });
  };

  const sendPct = (pct) => {
    if (pct === lastSentPct) return;
    clearTimeout(sendTimer);
    const elapsed = Date.now() - lastSendTime;
    if (elapsed >= DRAG_THROTTLE_MS) {
      flushSend(pct);
    } else {
      sendTimer = setTimeout(() => flushSend(pct), DRAG_THROTTLE_MS - elapsed);
    }
  };

  const endDrag = (tap) => {
    if (!dragging) return;
    clearTimeout(sendTimer);
    dragging = false;
    el._dragging = false;
    el.classList.remove('tapping', 'dragging');
    if (tap) { onTap(tile); return; }
    const pct = parseFloat(el.style.getPropertyValue('--pct'));
    if (!isNaN(pct)) {
      el._onAck = () => sendWs({ type: 'refresh', tileId: tile.id });
      sendWs({ type: 'tile_drag', tileId: tile.id, value: pct });
    }
  };

  // Use touch events — pointer events + setPointerCapture are unreliable in Android WebView
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    const touch = e.touches[0];
    const pctMatch = (tileStates[tile.id]?.data ?? '').match(/^(\d+(?:\.\d+)?)%$/);
    startPct = pctMatch ? parseFloat(pctMatch[1]) : 50;
    startY = touch.clientY;
    startTime = Date.now();
    dragging = true;
    moved = false;
    lastSentPct = -1;
    el.classList.add('tapping');
  }, { passive: false });

  el.addEventListener('touchmove', (e) => {
    if (!dragging || e.touches.length !== 1) return;
    e.preventDefault();
    const delta = startY - e.touches[0].clientY;
    if (!moved) {
      if (Math.abs(delta) < DRAG_MOVE_THRESHOLD || Date.now() - startTime < 150) return;
      moved = true;
      el._dragging = true;
      el.classList.remove('tapping');
      el.classList.add('dragging');
      navigator.vibrate?.(10);
    }
    const pct = Math.round(Math.min(100, Math.max(0, startPct + delta / DRAG_PX_PER_PCT)));
    el.style.setProperty('--pct', pct + '%');
    el.querySelector('.tile-data').textContent = pct + '%';
    sendPct(pct);
  }, { passive: false });

  el.addEventListener('touchend',    () => endDrag(!moved), { passive: false });
  el.addEventListener('touchcancel', () => endDrag(false));
}

function getAppIconDataUrl(pkg) {
  // 1. Try the bulk cache (populated by getInstalledApps)
  let b64 = getAppIconB64(pkg);
  // 2. Try the single-icon native method (catches apps not in launcher list)
  if (!b64 && window.Native?.getAppIcon) {
    try { b64 = window.Native.getAppIcon(pkg) || null; } catch {}
  }
  return b64 ? `data:image/png;base64,${b64}` : null;
}

function renderTileIcon(tile) {
  const wrap = document.createElement('div');
  wrap.className = 'tile-icon';
  if (tile.icon?.startsWith('app:')) {
    const pkg = tile.icon.slice(4);
    const dataUrl = getAppIconDataUrl(pkg);
    const img = document.createElement('img');
    img.className = 'tile-app-icon';
    if (dataUrl) {
      img.src = dataUrl;
    } else {
      // Fall back to server-cached icon (works on non-Android clients)
      img.src = `/api/app-icon/${encodeURIComponent(pkg)}?token=${encodeURIComponent(TOKEN)}`;
      img.onerror = () => { img.replaceWith(createIcon('app-window')); };
    }
    wrap.appendChild(img);
  } else {
    wrap.appendChild(createIcon(tile.icon));
  }
  return wrap;
}

function buildGeneric(el, tile) {
  if (tile.icon && !tile.hideIcon) {
    el.appendChild(renderTileIcon(tile));
  }
  const label = document.createElement('div');
  label.className = 'tile-label';
  label.textContent = tile.label ?? '';
  el.appendChild(label);

  if (tile.type === 'pc_data') {
    const data = document.createElement('div');
    data.className = 'tile-data';
    data.textContent = tileStates[tile.id]?.data ?? '—';
    el.appendChild(data);
  }
}

function buildClock(el, tile) {
  // row wraps HH:MM + :SS so they sit side-by-side on wider tiles
  const timeRowEl = document.createElement('div');
  timeRowEl.className = 'clock-time-row';
  const timeEl = document.createElement('div');
  timeEl.className = 'tile-time';
  const secsEl = document.createElement('div');
  secsEl.className = 'tile-secs';
  timeRowEl.append(timeEl, secsEl);
  const dateEl = document.createElement('div');
  dateEl.className = 'tile-date';
  el.append(timeRowEl, dateEl);

  const rollDigit = (wrap, newCh) => {
    const outEl = wrap.querySelector('.clock-digit-val');
    const inEl  = document.createElement('span');
    inEl.className  = 'clock-digit-val clock-in';
    inEl.textContent = newCh;
    wrap.appendChild(inEl);
    if (outEl) outEl.classList.add('clock-out');
    setTimeout(() => { outEl?.remove(); inEl.classList.remove('clock-in'); }, 220);
  };

  const buildDigits = (container) => {
    const spans = [];
    container.innerHTML = '';
    return { spans, render: (str) => {
      if (spans.length !== str.length) {
        container.innerHTML = '';
        spans.length = 0;
        for (const ch of str) {
          if (/\d/.test(ch)) {
            const wrap = document.createElement('span');
            wrap.className = 'clock-digit';
            const val = document.createElement('span');
            val.className = 'clock-digit-val';
            val.textContent = ch;
            wrap.appendChild(val);
            container.appendChild(wrap);
            spans.push({ type: 'digit', wrap, ch });
          } else {
            const sep = document.createElement('span');
            sep.className = 'clock-sep';
            sep.textContent = ch;
            container.appendChild(sep);
            spans.push({ type: 'sep', sep, ch });
          }
        }
      } else {
        for (let i = 0; i < str.length; i++) {
          const s = spans[i];
          if (s.type === 'digit' && s.ch !== str[i]) {
            rollDigit(s.wrap, str[i]);
            s.ch = str[i];
          }
        }
      }
    }};
  };

  const hhmm = buildDigits(timeEl);
  const ss   = buildDigits(secsEl);

  const tick = () => {
    const now = new Date();
    const hhmmStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const rawSec = String(now.getSeconds()).padStart(2, '0');
    const secStr = ':' + rawSec;
    dateEl.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    hhmm.render(hhmmStr);
    ss.render(secStr);
    // show inline seconds on large tiles if showSeconds is set
    secsEl.classList.toggle('secs-inline', !!tile?.showSeconds);
  };

  tick();
  setInterval(tick, 1000);
}

function buildWeather(el, tile) {
  el.classList.add('w');

  // top row: location
  const topEl  = document.createElement('div'); topEl.className  = 'w-top';
  const locEl  = document.createElement('div'); locEl.className  = 'w-loc';
  locEl.textContent = tile.weather?.location ?? tile.label ?? '';
  topEl.appendChild(locEl);

  // hero row: icon + temp
  const heroEl = document.createElement('div'); heroEl.className = 'w-hero';
  const iconEl = document.createElement('div'); iconEl.className = 'w-icon';
  const tempEl = document.createElement('div'); tempEl.className = 'w-temp'; tempEl.textContent = '—';
  heroEl.append(iconEl, tempEl);

  // condition
  const condEl = document.createElement('div'); condEl.className = 'w-cond';

  // stats row: icon + value chips
  const statsEl = document.createElement('div'); statsEl.className = 'w-stats';
  const mkStat  = (iconName) => {
    const s   = document.createElement('div'); s.className = 'w-stat';
    const ico = document.createElement('div'); ico.className = 'w-stat-icon';
    ico.appendChild(createIcon(iconName, { size: 12 }));
    const v   = document.createElement('div'); v.className = 'w-stat-val';
    s.append(ico, v); statsEl.appendChild(s);
    return { val: v };
  };
  const feels = mkStat('thermometer');
  const humid = mkStat('droplets');
  const wind  = mkStat('wind');

  // forecast row
  const forecastEl = document.createElement('div'); forecastEl.className = 'w-forecast';

  // wrap current conditions so we can flex them against the forecast
  const currentEl = document.createElement('div'); currentEl.className = 'w-current';
  currentEl.append(topEl, heroEl, condEl, statsEl);

  el.append(currentEl, forecastEl);

  el._weatherUpdate = (raw) => {
    if (!raw) return;
    let d; try { d = JSON.parse(raw); } catch { return; }

    iconEl.innerHTML = '';
    iconEl.appendChild(createIcon(d.icon ?? 'cloud', { size: 32 }));

    tempEl.textContent    = d.temp      ?? '—';
    condEl.textContent    = d.condition ?? '';
    locEl.textContent     = d.location  ?? tile.weather?.location ?? '';
    feels.val.textContent = d.feelsLike ?? '—';
    humid.val.textContent = d.humidity != null ? `${d.humidity}%` : '—';
    wind.val.textContent  = d.wind      ?? '—';
    el.dataset.wx         = weatherTint(d.icon ?? 'cloud');

    // forecast
    forecastEl.innerHTML = '';
    for (const fc of (d.forecast ?? [])) {
      const day = document.createElement('div'); day.className = 'w-fc-day';
      const lbl = document.createElement('div'); lbl.className = 'w-fc-label'; lbl.textContent = fc.day;
      const ico = document.createElement('div'); ico.className = 'w-fc-icon';
      ico.appendChild(createIcon(fc.icon ?? 'cloud', { size: 16 }));
      const hi  = document.createElement('div'); hi.className  = 'w-fc-hi';  hi.textContent  = fc.hi;
      const lo  = document.createElement('div'); lo.className  = 'w-fc-lo';  lo.textContent  = fc.lo;
      day.append(lbl, ico, hi, lo);
      forecastEl.appendChild(day);
    }
  };
}

function weatherTint(icon) {
  if (icon === 'sun')        return 'sunny';
  if (icon === 'cloud-rain') return 'rain';
  if (icon === 'cloud-snow') return 'snow';
  if (icon === 'zap')        return 'storm';
  if (icon === 'star')       return 'night';
  return 'cloud';
}

function buildStocks(el, tile) {
  el.classList.add('stocks');

  // ── Top header: label left, [total value + P&L] right ──
  const headerEl = document.createElement('div');
  headerEl.className = 'stocks-header';
  const labelEl = document.createElement('div');
  labelEl.className = 'stocks-label';
  labelEl.textContent = (tile.label && tile.label !== 'New Tile') ? tile.label : 'Portfolio';
  const summaryEl = document.createElement('div');
  summaryEl.className = 'stocks-summary';
  const totalValEl = document.createElement('div');
  totalValEl.className = 'stocks-total-val';
  const pplRowEl = document.createElement('div');
  pplRowEl.className = 'stocks-ppl-row';
  summaryEl.append(totalValEl, pplRowEl);
  headerEl.append(labelEl, summaryEl);

  // ── Period grid (6 cells: TODAY 2D 3D / 1W 1M YTD) ──
  const periodsEl = document.createElement('div');
  periodsEl.className = 'stocks-periods';

  const PERIOD_LABELS = ['TODAY', '2D', '3D', '1W', '1M', 'YTD'];
  const PERIOD_KEYS   = ['1d',    '2d', '3d', '1w', '1m', 'ytd'];
  const periodCells = {};
  for (let i = 0; i < PERIOD_LABELS.length; i++) {
    const cell = document.createElement('div');
    cell.className = 'stocks-period-cell';
    const lbl = document.createElement('div');
    lbl.className = 'stocks-period-label';
    lbl.textContent = PERIOD_LABELS[i];
    const pct = document.createElement('div');
    pct.className = 'stocks-period-pct';
    pct.textContent = '—';
    const chg = document.createElement('div');
    chg.className = 'stocks-period-change';
    cell.append(lbl, pct, chg);
    periodsEl.appendChild(cell);
    periodCells[PERIOD_KEYS[i]] = { pct, chg, cell };
  }

  // ── Position list ──
  const listEl = document.createElement('div');
  listEl.className = 'stocks-list';

  el.append(headerEl, periodsEl, listEl);

  // ── Helpers ──
  function fmtVal(str) {
    const n = parseFloat(str);
    if (isNaN(n)) return '—';
    return '£' + n.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
  function fmtSigned(str, decimals = 0) {
    const n = parseFloat(str);
    if (isNaN(n)) return '—';
    const sign = n >= 0 ? '+' : '-';
    return sign + '£' + Math.abs(n).toLocaleString('en-GB', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  el._stocksUpdate = (raw) => {
    if (!raw) return;
    let d; try { d = JSON.parse(raw); } catch { return; }

    // Header
    totalValEl.textContent = fmtVal(d.totalValue);
    pplRowEl.className = `stocks-ppl-row stocks-${d.totalPplSign}`;
    pplRowEl.innerHTML = `${fmtSigned(d.totalPpl, 2)}<span class="stocks-ppl-label"> unrealised</span>`;

    // Periods
    const periods = d.periods || {};
    for (const [key, els] of Object.entries(periodCells)) {
      const p = periods[key];
      if (p && p.pct) {
        els.pct.textContent = p.pct;
        els.chg.textContent = fmtSigned(p.change);
        els.pct.className = `stocks-period-pct stocks-${p.sign}`;
        els.chg.className = `stocks-period-change stocks-${p.sign}`;
        els.cell.dataset.sign = p.sign;
      } else {
        els.pct.textContent = '—';
        els.chg.textContent = '';
        els.pct.className = 'stocks-period-pct stocks-dim';
        els.chg.className = 'stocks-period-change';
        delete els.cell.dataset.sign;
      }
    }

    // Positions
    listEl.innerHTML = '';
    for (const pos of (d.positions ?? [])) {
      const row = document.createElement('div');
      row.className = `stocks-row stocks-${pos.pplSign}`;

      const left = document.createElement('div');
      left.className = 'stocks-left';
      const ticker = document.createElement('div');
      ticker.className = 'stocks-ticker';
      ticker.textContent = pos.ticker;
      const qty = document.createElement('div');
      qty.className = 'stocks-qty';
      qty.textContent = `${pos.qty} sh`;
      left.append(ticker, qty);

      const right = document.createElement('div');
      right.className = 'stocks-right';
      const posVal = document.createElement('div');
      posVal.className = 'stocks-pos-val';
      posVal.textContent = fmtVal(pos.value);
      const ppl = document.createElement('div');
      ppl.className = 'stocks-ppl';
      ppl.textContent = `${fmtSigned(pos.ppl)} (${pos.pct})`;
      right.append(posVal, ppl);

      row.append(left, right);
      listEl.appendChild(row);
    }
  };
}

function buildMedia(el, tile) {
  // ── Inner wrapper (scaled during swipe) ──
  const innerEl = document.createElement('div');
  innerEl.className = 'media-inner';
  el.appendChild(innerEl);

  // ── Album art background ──
  const artBgEl = document.createElement('div');
  artBgEl.className = 'media-art';
  innerEl.appendChild(artBgEl);
  const gradientEl = document.createElement('div');
  gradientEl.className = 'media-gradient';
  innerEl.appendChild(gradientEl);

  // ── Idle state ──
  const idleEl = document.createElement('div');
  idleEl.className = 'media-idle';
  const idleIcon = document.createElement('div');
  idleIcon.appendChild(createIcon('music', { size: 32 }));
  const idleText = document.createElement('div');
  idleText.className = 'media-idle-text';
  idleText.textContent = 'Nothing playing';
  idleEl.append(idleIcon, idleText);

  // ── Active state ──
  const activeEl = document.createElement('div');
  activeEl.className = 'media-active hidden';

  const textEl       = document.createElement('div'); textEl.className       = 'media-text';
  const titleEl      = document.createElement('div'); titleEl.className      = 'media-title';
  const titleInnerEl = document.createElement('span'); titleInnerEl.className = 'media-title-inner';
  titleEl.appendChild(titleInnerEl);
  const artistEl = document.createElement('div'); artistEl.className = 'media-artist';
  textEl.append(titleEl, artistEl);

  // ── Marquee engine ───────────────────────────────────────────────────────────
  const MQ_SPEED      = 32;   // px/s scroll speed
  const MQ_START_WAIT = 2200; // ms pause at start before scrolling
  const MQ_END_WAIT   = 1800; // ms pause at end before returning
  const MQ_RETURN_MS  = 700;  // ms duration of smooth return
  const MQ_FADE       = 28;   // px fade zone on each edge

  let mOverflow = 0, mPos = 0, mState = 'idle';
  let mTimer = null, mRaf = null, mLastTs = null;
  let mReturnStartTs = null, mReturnFrom = 0, mReturnMs = MQ_RETURN_MS;

  const setMask = (pos) => {
    const abs = -pos; // 0 → overflow
    const lAlpha = (1 - Math.min(abs / MQ_FADE, 1)).toFixed(3);
    const rAlpha = (1 - Math.min((mOverflow - abs) / MQ_FADE, 1)).toFixed(3);
    const m = `linear-gradient(to right,rgba(0,0,0,${lAlpha}) 0%,black ${MQ_FADE}px,black calc(100% - ${MQ_FADE}px),rgba(0,0,0,${rAlpha}) 100%)`;
    titleEl.style.webkitMaskImage = m;
    titleEl.style.maskImage = m;
  };

  const mTick = (ts) => {
    if (!mLastTs) mLastTs = ts;
    const dt = Math.min(ts - mLastTs, 50) / 1000;
    mLastTs = ts;

    if (mState === 'scrolling') {
      mPos = Math.max(mPos - MQ_SPEED * dt, -mOverflow);
      titleInnerEl.style.transform = `translateX(${mPos}px)`;
      setMask(mPos);
      if (mPos <= -mOverflow) {
        mState = 'hold-end'; mRaf = null;
        mTimer = setTimeout(() => {
          mState = 'returning'; mReturnFrom = mPos; mReturnStartTs = null; mLastTs = null;
          mReturnMs = (mOverflow / MQ_SPEED) * 1000;
          mRaf = requestAnimationFrame(mTick);
        }, MQ_END_WAIT);
        return;
      }
    } else if (mState === 'returning') {
      if (!mReturnStartTs) mReturnStartTs = ts;
      const t = Math.min((ts - mReturnStartTs) / mReturnMs, 1);
      mPos = mReturnFrom * (1 - t);
      titleInnerEl.style.transform = `translateX(${mPos}px)`;
      setMask(mPos);
      if (t >= 1) {
        mPos = 0; mState = 'idle';
        titleInnerEl.style.transform = 'translateX(0)';
        setMask(0); mRaf = null;
        mTimer = setTimeout(() => {
          mState = 'scrolling'; mLastTs = null;
          mRaf = requestAnimationFrame(mTick);
        }, MQ_START_WAIT);
        return;
      }
    }
    mRaf = requestAnimationFrame(mTick);
  };

  const startMarquee = (overflow) => {
    stopMarquee();
    mOverflow = overflow; mPos = 0; mState = 'idle';
    titleInnerEl.style.transform = 'translateX(0)';
    setMask(0);
    mTimer = setTimeout(() => {
      mState = 'scrolling'; mLastTs = null;
      mRaf = requestAnimationFrame(mTick);
    }, MQ_START_WAIT);
  };

  const stopMarquee = () => {
    if (mTimer) { clearTimeout(mTimer); mTimer = null; }
    if (mRaf)   { cancelAnimationFrame(mRaf); mRaf = null; }
    mPos = 0; mState = 'idle';
    titleInnerEl.style.transform = '';
    titleEl.style.webkitMaskImage = '';
    titleEl.style.maskImage = '';
  };

  const updateMarquee = () => {
    const overflow = titleInnerEl.offsetWidth - titleEl.clientWidth;
    if (overflow > 4) startMarquee(overflow); else stopMarquee();
  };

  const controlsEl = document.createElement('div');
  controlsEl.className = 'media-controls';

  const sendMediaControl = (action) => {
    if (tile.action?.agent) {
      sendWs({ type: 'media_control', tileId: tile.id, action });
    } else {
      callNative('mediaControl', action);
    }
  };

  const attachBtn = (btn, handler) => {
    btn.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); handler(); });
    btn.addEventListener('click', (e) => e.stopPropagation()); // prevent bubble to tile
  };

  const mkBtn = (iconName, cls, action) => {
    const btn = document.createElement('button');
    btn.className = `media-btn${cls ? ' ' + cls : ''}`;
    btn.appendChild(createIcon(iconName, { size: 24 }));
    attachBtn(btn, () => sendMediaControl(action));
    return btn;
  };

  const playBtn = document.createElement('button');
  playBtn.className = 'media-btn play-btn';
  playBtn.appendChild(createIcon('play', { size: 24 }));

  const mkSkipBtn = (iconName, action) => {
    const btn = document.createElement('button');
    btn.className = 'media-btn';
    btn.appendChild(createIcon(iconName, { size: 24 }));
    attachBtn(btn, () => {
      isPlaying = true;
      playBtn.innerHTML = '';
      playBtn.appendChild(createIcon('pause', { size: 24 }));
      sendMediaControl(action);
    });
    return btn;
  };

  controlsEl.append(mkSkipBtn('skip-back', 'previous'), playBtn, mkSkipBtn('skip-forward', 'next'));
  if (tile.hideControls) { controlsEl.style.display = 'none'; el.classList.add('no-controls'); }
  activeEl.append(textEl, controlsEl);

  innerEl.append(idleEl, activeEl);

  // ── Source badge (top-right corner) ──
  const sourceBadge = document.createElement('div');
  sourceBadge.className = 'media-source-badge';
  el.appendChild(sourceBadge);

  let lastArt = '';
  let isPlaying = false;

  attachBtn(playBtn, () => {
    isPlaying = !isPlaying;
    playBtn.innerHTML = '';
    playBtn.appendChild(createIcon(isPlaying ? 'pause' : 'play', { size: 24 }));
    sendMediaControl('play-pause');
  });

  el._mediaUpdate = (data) => {
    const hasContent = data && (data.title || data.artist || data.status === 'playing' || data.state === 'playing');
    idleEl.classList.toggle('hidden', !!hasContent);
    activeEl.classList.toggle('hidden', !hasContent);

    // Source badge: icon + label
    // Remote = tile has a PC agent (MPRIS). Local = audio is physically playing on this device.
    if (hasContent) {
      const isLocal = !!callNative('isMusicActive');
      const isRemote = !isLocal && !!tile.action?.agent;
      if (isLocal || isRemote) {
        const iconName = isLocal ? 'volume-2' : 'monitor';
        const label = isLocal
          ? 'This device'
          : (config?.agents?.[tile.action.agent]?.hostname || tile.action.agent);
        sourceBadge.innerHTML = '';
        sourceBadge.appendChild(createIcon(iconName, { size: 14 }));
        const span = document.createElement('span');
        span.textContent = label;
        sourceBadge.appendChild(span);
        sourceBadge.style.display = '';
      } else {
        sourceBadge.style.display = 'none';
      }
    } else {
      sourceBadge.style.display = 'none';
    }

    const art = data?.artBase64 ?? '';
    if (art !== lastArt) {
      lastArt = art;
      const dataUrl = art ? `data:${data?.artMime || 'image/jpeg'};base64,${art}` : '';
      artBgEl.style.backgroundImage = dataUrl ? `url(${dataUrl})` : '';
      el.classList.toggle('has-art', !!art);
      if (art) {
        extractVibrantColor(dataUrl).then(color => {
          if (color) {
            document.documentElement.style.setProperty('--accent', color);
            document.documentElement.style.setProperty('--tile-active', color.replace('rgb(', 'rgba(').replace(')', ', 0.20)'));
          } else {
            document.documentElement.style.removeProperty('--accent');
            document.documentElement.style.removeProperty('--tile-active');
          }
        });
      } else {
        document.documentElement.style.removeProperty('--accent');
        document.documentElement.style.removeProperty('--tile-active');
      }
    }

    if (!hasContent) return;

    const newTitle = data.title || 'Unknown';
    if (titleInnerEl.textContent !== newTitle) {
      titleInnerEl.textContent = newTitle;
      requestAnimationFrame(() => requestAnimationFrame(updateMarquee));
    }
    artistEl.textContent = data.artist || '';

    const prevPlaying = isPlaying;
    isPlaying = (data.status ?? data.state) === 'playing';
    playBtn.innerHTML = '';
    playBtn.appendChild(createIcon(isPlaying ? 'pause' : 'play', { size: 24 }));

    if (Date.now() - lastIndicatorAt > 800 && isPlaying !== prevPlaying) {
      showTapIndicator(isPlaying ? 'pause' : 'play');
    }
  };

  // ── Swipe indicators (left + right) ──
  const indPrev = document.createElement('div');
  indPrev.className = 'media-swipe-indicator media-swipe-prev';
  indPrev.appendChild(createIcon('skip-back', { size: 28 }));
  el.appendChild(indPrev);

  const indNext = document.createElement('div');
  indNext.className = 'media-swipe-indicator media-swipe-next';
  indNext.appendChild(createIcon('skip-forward', { size: 28 }));
  el.appendChild(indNext);

  const indTap = document.createElement('div');
  indTap.className = 'media-tap-indicator';
  el.appendChild(indTap);

  let lastIndicatorAt = 0;
  const showTapIndicator = (iconName) => {
    lastIndicatorAt = Date.now();
    indTap.innerHTML = '';
    indTap.appendChild(createIcon(iconName, { size: 28 }));
    indTap.classList.remove('show');
    void indTap.offsetWidth; // force reflow to restart animation
    indTap.classList.add('show');
  };

  const SWIPE_THRESHOLD = 52;
  let swipeStartX = 0, swipeStartY = 0, swipeTouchTarget = null, swiping = false, thresholdCrossed = false;
  let rafId = null;

  const applySwipe = (dx) => {
    const absDx = Math.abs(dx);
    const goingLeft = dx < 0;
    const progress = Math.min(absDx / SWIPE_THRESHOLD, 1);

    // Scale down inner content
    const scale = 1 - progress * 0.1;
    innerEl.style.transform = `scale(${scale})`;

    // Active indicator slides in from its edge; inactive fades out
    const activeInd = goingLeft ? indNext : indPrev;
    const inactiveInd = goingLeft ? indPrev : indNext;

    // Slide in: starts offset, moves to 0 as progress increases
    const offset = (1 - progress) * 28;
    activeInd.style.opacity = String(progress);
    activeInd.style.transform = `translateX(${goingLeft ? offset : -offset}px) scale(${0.75 + progress * 0.25})`;
    inactiveInd.style.opacity = '0';
    inactiveInd.style.transform = '';
  };

  const resetSwipe = (animate) => {
    swiping = false;
    thresholdCrossed = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    const t = animate ? 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)' : 'none';
    innerEl.style.transition = t;
    innerEl.style.transform = '';
    [indPrev, indNext].forEach(ind => {
      ind.style.transition = animate ? 'opacity 0.2s, transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)' : 'none';
      ind.style.opacity = '0';
      ind.style.transform = '';
    });
  };

  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    swipeStartX = e.touches[0].clientX;
    swipeStartY = e.touches[0].clientY;
    swipeTouchTarget = e.target;
    swiping = true;
    thresholdCrossed = false;
    innerEl.style.transition = 'none';
    [indPrev, indNext].forEach(ind => ind.style.transition = 'none');
  }, { passive: true });

  el.addEventListener('touchmove', (e) => {
    if (!swiping || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - swipeStartX;
    const dy = e.touches[0].clientY - swipeStartY;
    // Cancel if more vertical than horizontal
    if (Math.abs(dy) > Math.abs(dx) * 1.2) { resetSwipe(true); return; }

    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => applySwipe(dx));

    if (!thresholdCrossed && Math.abs(dx) >= SWIPE_THRESHOLD) {
      thresholdCrossed = true;
      navigator.vibrate?.(20);
    }
  }, { passive: true });

  el.addEventListener('touchend', (e) => {
    if (!swiping) return;
    const dx = e.changedTouches[0].clientX - swipeStartX;
    const dy = e.changedTouches[0].clientY - swipeStartY;
    const isSwipe = Math.abs(dx) >= SWIPE_THRESHOLD && Math.abs(dy) <= Math.abs(dx) * 1.2;
    const isTap = Math.abs(dx) < 12 && Math.abs(dy) < 12;
    resetSwipe(true);
    if (isSwipe) {
      isPlaying = true;
      playBtn.innerHTML = '';
      playBtn.appendChild(createIcon('pause', { size: 24 }));
      sendMediaControl(dx < 0 ? 'next' : 'previous');
    } else if (isTap && !swipeTouchTarget?.closest('.media-btn')) {
      isPlaying = !isPlaying;
      playBtn.innerHTML = '';
      playBtn.appendChild(createIcon(isPlaying ? 'pause' : 'play', { size: 24 }));
      showTapIndicator(isPlaying ? 'pause' : 'play');
      sendMediaControl('play-pause');
    }
  }, { passive: true });

  el.addEventListener('touchcancel', () => resetSwipe(true), { passive: true });
}

// ── Calendar ───────────────────────────────────────────────────────────────────
function buildCalendar(el, tile) {
  const days = tile.calendar?.days ?? 14;
  const calId = tile.calendar?.calendarId ?? '';

  // Header
  const headerEl = document.createElement('div');
  headerEl.className = 'cal-header';
  const titleEl = document.createElement('div');
  titleEl.className = 'cal-title';
  titleEl.textContent = tile.label || 'Calendar';
  const countEl = document.createElement('div');
  countEl.className = 'cal-today-count';
  headerEl.append(titleEl, countEl);

  const listEl = document.createElement('div');
  listEl.className = 'cal-list';
  el.append(headerEl, listEl);

  // Stable color per calendar name
  const calColor = (name) => {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
    return `hsl(${h % 360},65%,62%)`;
  };

  // Relative day label
  const dayLabel = (startMs) => {
    const now = new Date();
    const d = new Date(startMs);
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const diff = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - todayStart) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  };

  // "in X min" / "in Xh" / "now" string
  const relTime = (startMs, endMs) => {
    const now = Date.now();
    if (now >= startMs && now < endMs) return 'now';
    const diff = startMs - now;
    if (diff < 0) return null;
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `in ${mins}m`;
    const hrs = Math.floor(diff / 3600000);
    if (hrs < 24) return `in ${hrs}h`;
    return null;
  };

  // Duration string
  const duration = (startMs, endMs, allDay) => {
    if (allDay) return 'All day';
    const mins = Math.round((endMs - startMs) / 60000);
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  };

  // Is weekend
  const isWeekend = (startMs) => { const d = new Date(startMs).getDay(); return d === 0 || d === 6; };

  const refresh = () => {
    try {
      let raw = window.Native?.getCalendarEventsEx?.(calId, days);
      if (raw == null) raw = window.Native?.getCalendarEvents?.();
      let events = raw ? JSON.parse(raw) : [];

      // Deduplicate by title (keep first occurrence)
      const seen = new Set();
      events = events.filter(ev => {
        const key = ev.title?.trim().toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      listEl.innerHTML = '';
      const now = Date.now();

      // Count today's events for header badge
      const todayStart = new Date(); todayStart.setHours(0,0,0,0);
      const todayEnd   = new Date(); todayEnd.setHours(23,59,59,999);
      const todayCount = events.filter(e => e.startMs >= todayStart.getTime() && e.startMs <= todayEnd.getTime()).length;
      countEl.textContent = todayCount ? `${todayCount} today` : '';

      if (!events.length) {
        const empty = document.createElement('div');
        empty.className = 'cal-empty';
        empty.textContent = 'No upcoming events';
        listEl.appendChild(empty);
        return;
      }

      // Group by day key
      const groups = new Map();
      for (const ev of events) {
        const d = new Date(ev.startMs);
        const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        if (!groups.has(key)) groups.set(key, { startMs: ev.startMs, events: [] });
        groups.get(key).events.push(ev);
      }

      // Separate past / upcoming with a divider
      let pastDividerAdded = false, upcomingFirstEl = null;

      for (const [, group] of groups) {
        const isToday = dayLabel(group.startMs) === 'Today';
        const groupPast = group.events.every(e => (e.endMs ?? e.startMs + 3600000) < now);

        // Past/future divider
        if (!pastDividerAdded && !groupPast) {
          if (listEl.children.length > 0) {
            const div = document.createElement('div');
            div.className = 'cal-divider';
            listEl.appendChild(div);
          }
          pastDividerAdded = true;
        }

        // Day group header
        const groupEl = document.createElement('div');
        groupEl.className = 'cal-group';

        const dayHdr = document.createElement('div');
        dayHdr.className = 'cal-day-header' + (isToday ? ' cal-day-today' : '') + (isWeekend(group.startMs) ? ' cal-day-weekend' : '');
        const dayName = document.createElement('span');
        dayName.textContent = dayLabel(group.startMs);
        const dayCount = document.createElement('span');
        dayCount.className = 'cal-day-count';
        dayCount.textContent = group.events.length > 1 ? `${group.events.length}` : '';
        dayHdr.append(dayName, dayCount);
        groupEl.appendChild(dayHdr);

        let isFirstUpcoming = !upcomingFirstEl && !groupPast;

        for (const ev of group.events) {
          const isPast = (ev.endMs ?? ev.startMs + 3600000) < now;
          const isNow  = now >= ev.startMs && now < (ev.endMs ?? ev.startMs + 3600000);
          const rel    = relTime(ev.startMs, ev.endMs ?? ev.startMs + 3600000);

          const row = document.createElement('div');
          row.className = 'cal-event'
            + (isPast  ? ' cal-event-past'    : '')
            + (isNow   ? ' cal-event-now'     : '')
            + (isFirstUpcoming && !isNow ? ' cal-event-next' : '')
            + (ev.allDay ? ' cal-event-allday' : '');

          if (isFirstUpcoming && !upcomingFirstEl) upcomingFirstEl = row;
          if (isFirstUpcoming) isFirstUpcoming = false;

          // Color dot
          const dot = document.createElement('div');
          dot.className = 'cal-dot';
          dot.style.background = calColor(ev.calendar || 'default');

          // Right side: time + duration
          const meta = document.createElement('div');
          meta.className = 'cal-meta';

          if (!ev.allDay) {
            const timeStr = ev.end ? `${ev.start} – ${ev.end}` : ev.start;
            const timeEl = document.createElement('div');
            timeEl.className = 'cal-time';
            timeEl.textContent = timeStr;
            meta.appendChild(timeEl);
          }

          const durStr = duration(ev.startMs, ev.endMs ?? ev.startMs + 3600000, ev.allDay);
          const durEl = document.createElement('div');
          durEl.className = 'cal-dur';
          durEl.textContent = durStr;
          meta.appendChild(durEl);

          // Left side: title + calendar name + rel time chip
          const body = document.createElement('div');
          body.className = 'cal-body';

          const nameEl = document.createElement('div');
          nameEl.className = 'cal-name';
          nameEl.textContent = ev.title;

          body.append(nameEl);

          if (rel) {
            const chip = document.createElement('div');
            chip.className = 'cal-rel' + (rel === 'now' ? ' cal-rel-now' : '');
            chip.textContent = rel;
            body.appendChild(chip);
          }

          if (isNow) {
            const pulse = document.createElement('div');
            pulse.className = 'cal-pulse';
            row.appendChild(pulse);
          }

          row.append(dot, body, meta);


          groupEl.appendChild(row);
        }

        listEl.appendChild(groupEl);
      }

    } catch(e) { console.error('cal', e); }
  };

  refresh();
  const timer = setInterval(refresh, 10_000);
  el._destroy = () => clearInterval(timer);
}

// ── Volume tile ───────────────────────────────────────────────────────────────
function buildVolume(el, tile) {
  const iconWrap = renderTileIcon(tile);
  el.appendChild(iconWrap);
  const setVolumeIcon = (muted) => {
    iconWrap.innerHTML = '';
    iconWrap.appendChild(createIcon(muted ? 'volume-x' : 'volume-2'));
  };
  const label = document.createElement('div');
  label.className = 'tile-label';
  label.textContent = tile.label || 'Volume';
  el.appendChild(label);
  const dataEl = document.createElement('div');
  dataEl.className = 'tile-data';
  dataEl.textContent = tileStates[tile.id]?.data ?? '—';
  el.appendChild(dataEl);

  // Small badge shown when controlling Android volume
  const badge = document.createElement('div');
  badge.className = 'vol-mode-badge';
  el.appendChild(badge);

  let androidMode = false;
  el._androidMode = false;
  el._preMuteVol = null;

  const setAndroidMode = (active) => {
    if (androidMode === active) return;
    androidMode = active;
    el._androidMode = active;
    badge.textContent = active ? '📱' : '';
    badge.title = active ? 'Controlling Android volume' : '';
  };

  // Override server state updates — in android mode, ignore PC volume from server
  el._volumeUpdate = (data, stale) => {
    if (androidMode) return; // android polling drives display instead
    const pctMatch = (data ?? '').match(/^(\d+(?:\.\d+)?)%$/);
    if (pctMatch) {
      setVolumeIcon(parseFloat(pctMatch[1]) === 0);
      el.style.setProperty('--pct', pctMatch[1] + '%');
      el.classList.add('has-pct');
      if (!el._dragging) dataEl.textContent = data;
    } else {
      el.style.removeProperty('--pct');
      el.classList.remove('has-pct');
      if (!el._dragging) dataEl.textContent = data ?? '—';
    }
    el.classList.toggle('tile-stale', !!stale);
  };

  // Poll Android volume + mode every 2 s
  const pollAndroid = () => {
    const active = isAndroidAudioActive();
    setAndroidMode(active);
    if (active && !el._dragging) {
      const vol = callNative('getVolume');
      if (vol != null) {
        const pct = Math.round(vol);
        setVolumeIcon(pct === 0);
        el.style.setProperty('--pct', pct + '%');
        el.classList.add('has-pct');
        dataEl.textContent = pct + '%';
      }
    }
  };
  el._pollAndroid = pollAndroid;
  const pollTimer = setInterval(pollAndroid, 2000);
  pollAndroid();
  el._destroy = () => clearInterval(pollTimer);

  // ── Drag to set volume ────────────────────────────────────────────────────
  el.classList.add('tile-draggable');
  let startY = 0, startPct = 0, startTime = 0, dragging = false, moved = false;
  let lastSentPct = -1, lastSendTime = 0, sendTimer = null;
  el._dragging = false;

  const flushSend = (pct) => {
    lastSentPct = pct;
    lastSendTime = Date.now();
    if (androidMode) {
      callNative('setVolume', pct);
    } else {
      sendWs({ type: 'tile_drag', tileId: tile.id, value: pct });
    }
  };

  const sendPct = (pct) => {
    if (pct === lastSentPct) return;
    clearTimeout(sendTimer);
    const elapsed = Date.now() - lastSendTime;
    if (elapsed >= DRAG_THROTTLE_MS) {
      flushSend(pct);
    } else {
      sendTimer = setTimeout(() => flushSend(pct), DRAG_THROTTLE_MS - elapsed);
    }
  };

  const endDrag = (tap) => {
    if (!dragging) return;
    clearTimeout(sendTimer);
    dragging = false;
    el._dragging = false;
    el.classList.remove('tapping', 'dragging');
    if (tap) { onTap(tile); return; }
    const pct = parseFloat(el.style.getPropertyValue('--pct'));
    if (!isNaN(pct)) {
      if (androidMode) {
        callNative('setVolume', pct);
      } else {
        el._onAck = () => sendWs({ type: 'refresh', tileId: tile.id });
        sendWs({ type: 'tile_drag', tileId: tile.id, value: pct });
      }
    }
  };

  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    if (androidMode) {
      startPct = callNative('getVolume') ?? 50;
    } else {
      const pctMatch = (tileStates[tile.id]?.data ?? '').match(/^(\d+(?:\.\d+)?)%$/);
      startPct = pctMatch ? parseFloat(pctMatch[1]) : 50;
    }
    startY = e.touches[0].clientY;
    startTime = Date.now();
    dragging = true;
    moved = false;
    lastSentPct = -1;
    el.classList.add('tapping');
  }, { passive: false });

  el.addEventListener('touchmove', (e) => {
    if (!dragging || e.touches.length !== 1) return;
    e.preventDefault();
    const delta = startY - e.touches[0].clientY;
    if (!moved) {
      if (Math.abs(delta) < DRAG_MOVE_THRESHOLD || Date.now() - startTime < 150) return;
      moved = true;
      el._dragging = true;
      el.classList.remove('tapping');
      el.classList.add('dragging');
      navigator.vibrate?.(10);
    }
    const pct = Math.round(Math.min(100, Math.max(0, startPct + delta / DRAG_PX_PER_PCT)));
    el.style.setProperty('--pct', pct + '%');
    dataEl.textContent = pct + '%';
    sendPct(pct);
  }, { passive: false });

  el.addEventListener('touchend',    () => endDrag(!moved), { passive: false });
  el.addEventListener('touchcancel', () => endDrag(false));
}

// ── Mic tile ──────────────────────────────────────────────────────────────────
function buildMic(el, tile) {
  const iconWrap = document.createElement('div');
  iconWrap.className = 'tile-icon';
  iconWrap.appendChild(createIcon('mic'));
  el.appendChild(iconWrap);

  const label = document.createElement('div');
  label.className = 'tile-label';
  label.textContent = tile.label || 'Mic';
  el.appendChild(label);

  const dataEl = document.createElement('div');
  dataEl.className = 'tile-data';
  dataEl.textContent = tileStates[tile.id]?.data ?? '—';
  el.appendChild(dataEl);

  el._micUpdate = (data, stale) => {
    const pctMatch = (data ?? '').match(/^(\d+(?:\.\d+)?)%$/);
    if (pctMatch) {
      const muted = parseFloat(pctMatch[1]) === 0;
      iconWrap.innerHTML = '';
      iconWrap.appendChild(createIcon(muted ? 'mic-off' : 'mic'));
      el.style.setProperty('--pct', pctMatch[1] + '%');
      el.classList.add('has-pct');
      if (!el._dragging) dataEl.textContent = data;
    } else {
      el.style.removeProperty('--pct');
      el.classList.remove('has-pct');
      if (!el._dragging) dataEl.textContent = data ?? '—';
    }
    el.classList.toggle('tile-stale', !!stale);
  };

  // Seed display from current state
  el._micUpdate(tileStates[tile.id]?.data ?? null, tileStates[tile.id]?.stale ?? false);

  // ── Drag to set mic input gain ─────────────────────────────────────────────
  el.classList.add('tile-draggable');
  let startY = 0, startPct = 0, startTime = 0, dragging = false, moved = false;
  let lastSentPct = -1, lastSendTime = 0, sendTimer = null;
  el._dragging = false;

  const flushSend = (pct) => {
    lastSentPct = pct;
    lastSendTime = Date.now();
    sendWs({ type: 'tile_drag', tileId: tile.id, value: pct });
  };

  const sendPct = (pct) => {
    if (pct === lastSentPct) return;
    clearTimeout(sendTimer);
    const elapsed = Date.now() - lastSendTime;
    if (elapsed >= DRAG_THROTTLE_MS) {
      flushSend(pct);
    } else {
      sendTimer = setTimeout(() => flushSend(pct), DRAG_THROTTLE_MS - elapsed);
    }
  };

  const endDrag = (tap) => {
    if (!dragging) return;
    clearTimeout(sendTimer);
    dragging = false;
    el._dragging = false;
    el.classList.remove('tapping', 'dragging');
    if (tap) { onTap(tile); return; }
    const pct = parseFloat(el.style.getPropertyValue('--pct'));
    if (!isNaN(pct)) {
      el._onAck = () => sendWs({ type: 'refresh', tileId: tile.id });
      sendWs({ type: 'tile_drag', tileId: tile.id, value: pct });
    }
  };

  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    const pctMatch = (tileStates[tile.id]?.data ?? '').match(/^(\d+(?:\.\d+)?)%$/);
    startPct = pctMatch ? parseFloat(pctMatch[1]) : 50;
    startY = e.touches[0].clientY;
    startTime = Date.now();
    dragging = true;
    moved = false;
    lastSentPct = -1;
    el.classList.add('tapping');
  }, { passive: false });

  el.addEventListener('touchmove', (e) => {
    if (!dragging || e.touches.length !== 1) return;
    e.preventDefault();
    const delta = startY - e.touches[0].clientY;
    if (!moved) {
      if (Math.abs(delta) < DRAG_MOVE_THRESHOLD || Date.now() - startTime < 150) return;
      moved = true;
      el._dragging = true;
      el.classList.remove('tapping');
      el.classList.add('dragging');
      navigator.vibrate?.(10);
    }
    const pct = Math.round(Math.min(100, Math.max(0, startPct + delta / DRAG_PX_PER_PCT)));
    el.style.setProperty('--pct', pct + '%');
    dataEl.textContent = pct + '%';
    sendPct(pct);
  }, { passive: false });

  el.addEventListener('touchend',    () => endDrag(!moved), { passive: false });
  el.addEventListener('touchcancel', () => endDrag(false));
}

// ── Tile tap ──────────────────────────────────────────────────────────────────
function onTap(tile) {
  // Widget tap override (clock / weather / calendar)
  if (tile.tapApp) { callNative('launchApp', tile.tapApp); return; }
  if (tile.tapUrl) { window.open(tile.tapUrl, '_blank'); return; }

  switch (tile.type) {
    case 'app':
      if (tile.action?.packageName) callNative('launchApp', tile.action.packageName);
      break;
    case 'shortcut':
      if (tile.action?.url) window.open(tile.action.url, '_blank');
      break;
    case 'command':
      sendWs({ type: 'tile_action', tileId: tile.id });
      break;
    case 'pc_data': {
      const el = document.getElementById(`tile-${tile.id}`);
      if (el) el._onAck = () => sendWs({ type: 'refresh', tileId: tile.id });
      sendWs({ type: 'tile_action', tileId: tile.id });
      break;
    }
    case 'mic':
      // Server toggles mute and pushes updated state after poll
      sendWs({ type: 'tile_action', tileId: tile.id });
      break;
    case 'volume': {
      const volEl = document.getElementById(`tile-${tile.id}`);
      if (volEl?._androidMode) {
        // Toggle Android media volume mute
        const cur = callNative('getVolume') ?? 0;
        if (cur > 0) {
          volEl._preMuteVol = cur;
          callNative('setVolume', 0);
        } else {
          const restore = volEl._preMuteVol ?? 50;
          callNative('setVolume', restore);
        }
        // Poll immediately so bar + text + icon all update at once
        volEl._pollAndroid?.();
      } else {
        // Toggle PC sink mute via agent — server pushes state after poll completes
        sendWs({ type: 'tile_action', tileId: tile.id });
      }
      break;
    }
  }
}

function flashAck(tileId) {
  const el = document.getElementById(`tile-${tileId}`);
  if (!el) return;
  if (el._onAck) {
    const cb = el._onAck;
    el._onAck = null;
    cb();
    return;
  }
  el.classList.remove('ack-flash');
  void el.offsetWidth;
  el.classList.add('ack-flash');
  setTimeout(() => el.classList.remove('ack-flash'), 400);
}

// ── Media polling ─────────────────────────────────────────────────────────────
function pollMedia() {
  if (!config) return;
  // Only use Android native bridge for tiles without a PC-side MPRIS action
  const androidTiles = config.tiles.filter(t => t.type === 'media' && !t.action?.agent);
  if (!androidTiles.length) return;

  let data = null;
  try {
    const raw = callNative('getNowPlaying');
    if (raw) data = JSON.parse(raw);
  } catch { /* no native bridge */ }

  for (const tile of androidTiles) {
    document.getElementById(`tile-${tile.id}`)?._mediaUpdate?.(data);
  }
}

// ── Native bridge ─────────────────────────────────────────────────────────────
function callNative(method, ...args) {
  return window.Native?.[method]?.(...args) ?? null;
}

// ── Init ──────────────────────────────────────────────────────────────────────
connect();
