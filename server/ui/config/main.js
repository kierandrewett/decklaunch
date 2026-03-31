import { createIcon, ICONS } from '../shared/icons.js';

const ICON_NAMES = Object.keys(ICONS);
const TILE_TYPES = ['app', 'command', 'pc_data', 'shortcut', 'weather', 'media', 'clock', 'calendar', 'spacer', 'volume', 'mic', 'stocks'];
const TYPE_COLORS = {
  app: '#4a9eff', command: '#ff8c42', pc_data: '#0af',
  shortcut: '#b084ff', weather: '#60cfff', media: '#ff6b9d',
  clock: '#44ff88', calendar: '#ff9944', spacer: '#333',
  volume: '#aaffcc', mic: '#ff88cc', stocks: '#4ade80',
};

// ── State ─────────────────────────────────────────────────────────────────────
let TOKEN = sessionStorage.getItem('deck_token') || '';
let config = null;
let selectedTileId = null;
let dirty = false;
let dragSrcId = null;
let statusAgents = []; // kept in sync by pollStatus
let installedApps = null; // null = not fetched yet, [] = unavailable

// ── DOM ───────────────────────────────────────────────────────────────────────
const loginScreen = document.getElementById('login-screen');
const loginForm   = document.getElementById('login-form');
const loginToken  = document.getElementById('login-token');
const loginError  = document.getElementById('login-error');
const editor      = document.getElementById('editor');
const gridPreview = document.getElementById('grid-preview');
const propsPanel  = document.getElementById('props-panel');
const workspace   = document.querySelector('.workspace');
const cfgCols     = document.getElementById('cfg-cols');
const cfgRows     = document.getElementById('cfg-rows');
const addTileBtn  = document.getElementById('add-tile-btn');
const saveBtn     = document.getElementById('save-btn');
const saveStatus  = document.getElementById('save-status');
const agentStatus = document.getElementById('agent-status');

// ── Login ─────────────────────────────────────────────────────────────────────
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const tok = loginToken.value.trim();
  if (!tok) return;
  loginError.classList.add('hidden');
  try {
    const res = await fetch(`/api/config?token=${encodeURIComponent(tok)}`);
    if (!res.ok) throw new Error('Invalid token');
    TOKEN = tok;
    sessionStorage.setItem('deck_token', TOKEN);
    config = await res.json();
    showEditor();
  } catch (err) {
    loginError.textContent = err.message;
    loginError.classList.remove('hidden');
  }
});

(async () => {
  const urlToken = new URLSearchParams(location.search).get('token');
  if (urlToken) { TOKEN = urlToken; sessionStorage.setItem('deck_token', TOKEN); }
  if (!TOKEN) return;
  try {
    const res = await fetch(`/api/config?token=${encodeURIComponent(TOKEN)}`);
    if (!res.ok) return;
    config = await res.json();
    showEditor();
  } catch { /* show login */ }
})();

function showEditor() {
  loginScreen.classList.add('hidden');
  editor.classList.remove('hidden');
  cfgCols.value = config.columns;
  cfgRows.value = config.rows;
  renderGrid();
  showEmptyProps();
  pollStatus();
}

// ── Status ────────────────────────────────────────────────────────────────────
async function pollStatus() {
  try {
    const res = await fetch(`/api/status?token=${encodeURIComponent(TOKEN)}`);
    if (!res.ok) return;
    const data = await res.json();
    statusAgents = data.agents ?? [];
    const online = statusAgents.filter(a => a.connected);
    agentStatus.textContent = online.length
      ? online.map(a => a.hostname).join(', ')
      : 'No agents connected';
    agentStatus.classList.toggle('online', online.length > 0);
    // Refresh the agents section in the props panel if it's currently visible
    const existing = propsPanel.querySelector('.agents-section');
    if (existing) existing.replaceWith(buildAgentsSection());
  } catch { /* ignore */ }
  setTimeout(pollStatus, 10000);
}

// ── Grid controls ─────────────────────────────────────────────────────────────
cfgCols.addEventListener('change', () => { config.columns = Math.max(1, parseInt(cfgCols.value) || 4); markDirty(); renderGrid(); });
cfgRows.addEventListener('change', () => { config.rows    = Math.max(1, parseInt(cfgRows.value) || 3); markDirty(); renderGrid(); });

addTileBtn.addEventListener('click', () => {
  const pos = findFreePosition();
  if (!pos) { showToast('No free cells — increase rows/cols first'); return; }
  const id = uuid();
  config.tiles.push({ id, position: { ...pos, rowSpan: 1, colSpan: 1 }, type: 'command', label: 'New Tile', icon: 'square', action: defaultAction('command') });
  markDirty();
  renderGrid();
  selectTile(id);
});

saveBtn.addEventListener('click', saveConfig);

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveConfig(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedTileId && !isInputFocused()) {
    deleteTile(selectedTileId);
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'd' && selectedTileId) {
    e.preventDefault();
    duplicateTile(selectedTileId);
  }
  if (e.key === 'Escape') {
    selectedTileId = null;
    gridPreview.querySelectorAll('.preview-tile.selected').forEach(el => el.classList.remove('selected'));
    showEmptyProps();
  }
});

window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

function isInputFocused() {
  const tag = document.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

// ── Occupancy helpers ─────────────────────────────────────────────────────────
function occupiedCells() {
  const set = new Set();
  for (const tile of config.tiles ?? []) {
    const row     = tile.position?.row     ?? -1;
    const col     = tile.position?.col     ?? -1;
    const rowSpan = tile.position?.rowSpan ?? 1;
    const colSpan = tile.position?.colSpan ?? 1;
    if (row < 0 || col < 0) continue; // skip malformed tiles
    for (let r = row; r < row + rowSpan; r++)
      for (let c = col; c < col + colSpan; c++)
        set.add(`${r},${c}`);
  }
  return set;
}

function findFreePosition() {
  const rows = config.rows || 3;
  const cols = config.columns || 4;
  const occ  = occupiedCells();
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if (!occ.has(`${r},${c}`)) return { row: r, col: c };
  return null;
}

function freeCells() {
  const occ = occupiedCells();
  const free = [];
  for (let r = 0; r < config.rows; r++)
    for (let c = 0; c < config.columns; c++)
      if (!occ.has(`${r},${c}`)) free.push({ row: r, col: c });
  return free;
}

// ── Render grid ───────────────────────────────────────────────────────────────
// Only called for structural changes (add/delete/position/type change).
// NEVER calls renderProps — that would reset input focus.
function renderGrid() {
  const cols = config.columns || 4;
  const rows = config.rows || 3;
  gridPreview.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  // minmax(68px, auto): rows have a guaranteed pixel minimum so 1fr doesn't
  // collapse to 0px when the container has no explicit height.
  gridPreview.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  gridPreview.innerHTML = '';

  // Empty slot placeholders
  for (const { row, col } of freeCells()) {
    const slot = document.createElement('div');
    slot.className = 'empty-slot';
    slot.style.gridRow    = `${row + 1}`;
    slot.style.gridColumn = `${col + 1}`;
    slot.dataset.row = row;
    slot.dataset.col = col;
    slot.innerHTML = '<span class="empty-plus">+</span>';
    slot.addEventListener('click', () => addTileAt(row, col));
    slot.addEventListener('dragover',  (e) => { e.preventDefault(); slot.classList.add('drag-over'); });
    slot.addEventListener('dragleave', () => slot.classList.remove('drag-over'));
    slot.addEventListener('drop', (e) => {
      e.preventDefault(); slot.classList.remove('drag-over');
      if (dragSrcId) moveTileTo(dragSrcId, row, col);
      dragSrcId = null;
    });
    gridPreview.appendChild(slot);
  }

  // Tiles
  for (const tile of config.tiles) gridPreview.appendChild(makeTileEl(tile));
}

function makeTileEl(tile) {
  const el = document.createElement('div');
  el.className = 'preview-tile';
  el.dataset.id = tile.id;
  if (tile.id === selectedTileId) el.classList.add('selected');

  const pos = tile.position;
  el.style.gridRow    = `${pos.row + 1} / span ${pos.rowSpan ?? 1}`;
  el.style.gridColumn = `${pos.col + 1} / span ${pos.colSpan ?? 1}`;

  populateTileEl(el, tile);
  attachTileEvents(el, tile);
  return el;
}

// Fills/updates the visual content of a tile element without replacing the element.
function populateTileEl(el, tile) {
  el.innerHTML = '';

  const color = TYPE_COLORS[tile.type] ?? '#666';
  const badge = document.createElement('span');
  badge.className = 'tile-type-badge';
  badge.textContent = tile.type;
  badge.style.color = color;
  badge.style.borderColor = color + '44';
  el.appendChild(badge);

  if (tile.type === 'spacer') {
    el.classList.add('tile-spacer');
    el.style.removeProperty('--tile-accent');
    return;
  }
  el.classList.remove('tile-spacer');
  el.style.setProperty('--tile-accent', color);

  if (tile.icon) {
    const iconWrap = document.createElement('div');
    iconWrap.className = 'tile-icon-wrap';
    iconWrap.appendChild(createIcon(tile.icon, { size: 20 }));
    el.appendChild(iconWrap);
  }

  const label = document.createElement('div');
  label.className = 'tile-label';
  label.textContent = tile.label || '';
  el.appendChild(label);
}

// Update just the visual content of an existing tile (label/icon changed — no re-render needed)
function updateTileEl(id) {
  const el = gridPreview.querySelector(`[data-id="${id}"]`);
  const tile = config.tiles.find(t => t.id === id);
  if (el && tile) populateTileEl(el, tile);
}

function attachTileEvents(el, tile) {
  el.addEventListener('click', () => selectTile(tile.id));
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    dragSrcId = tile.id;
    el.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over'); });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault(); el.classList.remove('drag-over');
    if (dragSrcId && dragSrcId !== tile.id) swapTiles(dragSrcId, tile.id);
    dragSrcId = null;
  });
}

function addTileAt(row, col) {
  const id = uuid();
  config.tiles.push({ id, position: { row, col, rowSpan: 1, colSpan: 1 }, type: 'command', label: 'New Tile', icon: 'square', action: defaultAction('command') });
  markDirty(); renderGrid(); selectTile(id);
}

function swapTiles(aId, bId) {
  const a = config.tiles.find(t => t.id === aId);
  const b = config.tiles.find(t => t.id === bId);
  if (!a || !b) return;
  [a.position, b.position] = [{ ...b.position }, { ...a.position }];
  markDirty(); renderGrid();
}

function moveTileTo(id, row, col) {
  const tile = config.tiles.find(t => t.id === id);
  if (!tile) return;
  tile.position.row = row;
  tile.position.col = col;
  markDirty(); renderGrid();
  // Keep tile selected after move
  if (selectedTileId === id) {
    gridPreview.querySelector(`[data-id="${id}"]`)?.classList.add('selected');
  }
}

// ── Select / Props ────────────────────────────────────────────────────────────
function selectTile(id) {
  selectedTileId = id;
  gridPreview.querySelectorAll('.preview-tile').forEach(el => {
    el.classList.toggle('selected', el.dataset.id === id);
  });
  const tile = config.tiles.find(t => t.id === id);
  if (tile) {
    renderProps(tile);
    workspace.classList.add('showing-props');
  }
}

function showEmptyProps() {
  workspace.classList.remove('showing-props');
  propsPanel.innerHTML = `
    <div class="props-empty">
      <div class="props-empty-icon">${createIcon('layout-grid', { size: 32 }).outerHTML}</div>
      <div>No tile selected</div>
      <div class="props-hint">Click a tile to edit it, or click <strong>+</strong> in an empty cell</div>
    </div>`;
}

function renderProps(tile) {
  propsPanel.innerHTML = '';

  // ── Header ──
  const header = div('props-header');

  const backBtn = document.createElement('button');
  backBtn.className = 'props-back-btn';
  backBtn.textContent = '‹ Back';
  backBtn.addEventListener('click', () => {
    selectedTileId = null;
    gridPreview.querySelectorAll('.preview-tile.selected').forEach(el => el.classList.remove('selected'));
    showEmptyProps();
  });
  header.appendChild(backBtn);

  const titleEl = div('props-header-title');
  titleEl.textContent = tile.label || tile.type;
  const actions = div('props-header-actions');

  const dupBtn = iconButton('layers', 'Duplicate (Ctrl+D)', () => duplicateTile(tile.id));
  const delBtn = iconButton('trash-2', 'Delete tile', () => deleteTile(tile.id));
  delBtn.classList.add('danger');
  actions.append(dupBtn, delBtn);
  header.append(titleEl, actions);
  propsPanel.appendChild(header);

  // ── Type ──
  const typeSection = section('Tile type');
  const typeSel = makeSelect(TILE_TYPES.map(t => [t, t]), tile.type, (v) => {
    tile.type = v;
    tile.action = defaultAction(v);
    tile.icon = tile.icon ?? defaultIcon(v);
    markDirty();
    renderGrid();
    selectTile(tile.id); // re-render props for new type
  });
  typeSection.appendChild(field('Type', typeSel));

  if (tile.type !== 'spacer') {
    const labelInput = makeInput('text', tile.label, (v) => {
      tile.label = v;
      // Update header title live
      titleEl.textContent = v || tile.type;
      markDirty();
      updateTileEl(tile.id); // update preview tile without re-render
    });
    labelInput.placeholder = 'Tile label';
    typeSection.appendChild(field('Label', labelInput));
  }
  propsPanel.appendChild(typeSection);

  // ── Icon ──
  if (!['spacer', 'clock', 'weather', 'media', 'calendar', 'volume', 'mic', 'stocks'].includes(tile.type)) {
    propsPanel.appendChild(buildIconSection(tile));
  }

  // ── Position ──
  const posSection = section('Position');
  const posGrid = div('pos-grid');

  const rowI = makeNumInput(tile.position.row, 0, config.rows - 1, (v) => { tile.position.row = v; markDirty(); renderGrid(); });
  const colI = makeNumInput(tile.position.col, 0, config.columns - 1, (v) => { tile.position.col = v; markDirty(); renderGrid(); });
  const rsI  = makeNumInput(tile.position.rowSpan ?? 1, 1, config.rows, (v) => { tile.position.rowSpan = v; markDirty(); renderGrid(); });
  const csI  = makeNumInput(tile.position.colSpan ?? 1, 1, config.columns, (v) => { tile.position.colSpan = v; markDirty(); renderGrid(); });

  posGrid.append(field('Row', rowI), field('Col', colI), field('Row span', rsI), field('Col span', csI));
  posSection.appendChild(posGrid);
  propsPanel.appendChild(posSection);

  // ── Clock options ──
  if (tile.type === 'clock') {
    const clockSec = section('Clock options');
    const secCheck = document.createElement('input');
    secCheck.type = 'checkbox';
    secCheck.checked = tile.showSeconds ?? false;
    secCheck.addEventListener('change', () => {
      tile.showSeconds = secCheck.checked;
      markDirty();
      updateTileEl(tile.id);
    });
    clockSec.appendChild(field('Show seconds', secCheck));
    propsPanel.appendChild(clockSec);
  }

  // ── Action ──
  if (tile.type === 'media') {
    if (!tile.action) tile.action = { type: 'pc_poll', agent: Object.keys(config?.agents ?? {})[0] ?? '', command: '', intervalSeconds: 5 };
    const mediaSec = section('PC Media (MPRIS)');
    mediaSec.appendChild(field('Agent', buildAgentSelect(tile.action.agent, (v) => { tile.action.agent = v; markDirty(); })));
    const hint = div('field-hint');
    hint.textContent = 'Agent streams MPRIS media state automatically via D-Bus. No command needed.';
    mediaSec.appendChild(hint);
    const hideCheck = document.createElement('input');
    hideCheck.type = 'checkbox';
    hideCheck.checked = tile.hideControls ?? false;
    hideCheck.addEventListener('change', () => { tile.hideControls = hideCheck.checked; markDirty(); updateTileEl(tile.id); });
    mediaSec.appendChild(field('Hide buttons (gestures only)', hideCheck));
    propsPanel.appendChild(mediaSec);
  }

  if (tile.type === 'volume') {
    if (!tile.action) tile.action = defaultAction('volume');
    const sec = section('Volume');
    sec.appendChild(field('Agent', buildAgentSelect(tile.action.agent, (v) => { tile.action.agent = v; markDirty(); })));
    const hint = div('field-hint');
    hint.textContent = 'Uses pactl to control agent volume. Drag up/down to adjust. Automatically controls Android volume when the device is playing audio.';
    sec.appendChild(hint);
    propsPanel.appendChild(sec);
  }

  if (tile.type === 'mic') {
    if (!tile.action) tile.action = defaultAction('mic');
    const sec = section('Microphone');
    sec.appendChild(field('Agent', buildAgentSelect(tile.action.agent, (v) => { tile.action.agent = v; markDirty(); })));
    const hint = div('field-hint');
    hint.textContent = 'Shows live mic level ring. Tap to toggle agent mic mute via pactl.';
    sec.appendChild(hint);
    propsPanel.appendChild(sec);
  }

  if (tile.type === 'calendar') {
    if (!tile.calendar) tile.calendar = { days: 14 };
    const calSec = section('Calendar');
    const daysInput = makeNumInput(tile.calendar.days ?? 14, 1, 60, (v) => { tile.calendar.days = v; markDirty(); updateTileEl(tile.id); });
    calSec.appendChild(field('Days ahead', daysInput));
    calSec.appendChild(buildCalendarPicker(tile));
    propsPanel.appendChild(calSec);
  }

  // ── Tap action (clock / weather / calendar) ──
  if (['clock', 'weather', 'calendar', 'stocks'].includes(tile.type)) {
    propsPanel.appendChild(buildTapActionSection(tile));
  }

  if (tile.type === 'weather') {
    if (!tile.weather) tile.weather = { lat: 51.5, lon: -0.12, location: 'London' };
    const wSec = section('Location');
    const locInput = makeInput('text', tile.weather.location, (v) => { tile.weather.location = v; markDirty(); });
    locInput.placeholder = 'e.g. London';
    const latInput = makeInput('number', tile.weather.lat, (v) => { tile.weather.lat = parseFloat(v) || 0; markDirty(); });
    const lonInput = makeInput('number', tile.weather.lon, (v) => { tile.weather.lon = parseFloat(v) || 0; markDirty(); });
    wSec.appendChild(field('Name', locInput));
    wSec.appendChild(field('Latitude', latInput));
    wSec.appendChild(field('Longitude', lonInput));
    propsPanel.appendChild(wSec);
  }

  if (tile.type === 'stocks') {
    if (!tile.stocks) tile.stocks = { apiKey: '', secretKey: '', mode: 'live' };
    const sSec = section('Trading212');
    const apiKeyInput = makeInput('text', tile.stocks.apiKey, (v) => { tile.stocks.apiKey = v; markDirty(); });
    apiKeyInput.placeholder = 'API Key ID';
    sSec.appendChild(field('API Key ID', apiKeyInput));
    const secretInput = makeInput('password', tile.stocks.secretKey, (v) => { tile.stocks.secretKey = v; markDirty(); });
    secretInput.placeholder = 'Secret Key';
    sSec.appendChild(field('Secret Key', secretInput));
    const modeSelect = document.createElement('select');
    modeSelect.className = 'prop-input';
    ['live', 'demo'].forEach(m => {
      const opt = document.createElement('option');
      opt.value = m; opt.textContent = m.charAt(0).toUpperCase() + m.slice(1);
      if (tile.stocks.mode === m) opt.selected = true;
      modeSelect.appendChild(opt);
    });
    modeSelect.addEventListener('change', () => { tile.stocks.mode = modeSelect.value; markDirty(); });
    sSec.appendChild(field('Mode', modeSelect));
    propsPanel.appendChild(sSec);
  }

  if (['app', 'command', 'pc_data', 'shortcut'].includes(tile.type)) {
    if (!tile.action) tile.action = defaultAction(tile.type);
    const actSection = section('Action');

    if (tile.type === 'app') {
      actSection.appendChild(buildAppPicker(tile));

    } else if (tile.type === 'shortcut') {
      const urlInput = makeInput('url', tile.action.url, (v) => { tile.action.url = v; markDirty(); });
      urlInput.placeholder = 'https://...';
      actSection.appendChild(field('URL', urlInput));

    } else if (tile.type === 'command' || tile.type === 'pc_data') {
      actSection.appendChild(field('Agent', buildAgentSelect(tile.action.agent, (v) => { tile.action.agent = v; markDirty(); })));

      const cmdArea = makeTextarea(tile.action.command, (v) => { tile.action.command = v; markDirty(); });
      cmdArea.placeholder = tile.type === 'pc_data'
        ? 'e.g. pactl get-sink-volume @DEFAULT_SINK@ | grep -oP \'\\d+%\' | head -1'
        : 'e.g. pactl set-sink-mute @DEFAULT_SINK@ toggle';
      actSection.appendChild(field('Shell command', cmdArea));

      if (tile.type === 'pc_data') {
        const intervalRow = div('interval-row');
        const intervalInput = makeNumInput(tile.action.intervalSeconds ?? 60, 5, 3600, (v) => { tile.action.intervalSeconds = v; markDirty(); });
        intervalRow.appendChild(field('Poll every', intervalInput));
        const unitLabel = div('interval-unit');
        unitLabel.textContent = 'seconds';
        intervalRow.appendChild(unitLabel);
        actSection.appendChild(intervalRow);

        const tapArea = makeTextarea(tile.action.tapCommand ?? '', (v) => {
          tile.action.tapCommand = v || undefined;
          markDirty();
        });
        tapArea.placeholder = 'e.g. pactl set-sink-mute @DEFAULT_SINK@ toggle';
        const tapHint = div('field-hint');
        tapHint.textContent = 'Runs on tap — leave empty to refresh data instead';
        actSection.appendChild(field('Tap command', tapArea));
        actSection.appendChild(tapHint);

        const dragArea = makeTextarea(tile.action.dragCommand ?? '', (v) => {
          tile.action.dragCommand = v || undefined;
          markDirty();
        });
        dragArea.placeholder = 'e.g. pactl set-sink-volume @DEFAULT_SINK@ $(cat)%';
        const dragHint = div('field-hint');
        dragHint.textContent = 'Runs on drag — new percentage (0–100) is passed as stdin';
        actSection.appendChild(field('Drag command', dragArea));
        actSection.appendChild(dragHint);
      }
    }

    propsPanel.appendChild(actSection);
  }

  // ── Live ring + icon variants (pc_data only) ──
  if (tile.type === 'pc_data') {
    const ringSec = section('Live indicator');
    const ringCheck = document.createElement('input');
    ringCheck.type = 'checkbox';
    ringCheck.checked = tile.liveRing ?? false;
    ringCheck.addEventListener('change', () => { tile.liveRing = ringCheck.checked; markDirty(); });
    const ringHint = div('field-hint');
    ringHint.textContent = 'Shows a green ring when value is not 0%. Use for mic or camera status.';
    ringSec.appendChild(field('Green ring when active', ringCheck));
    ringSec.appendChild(ringHint);
    propsPanel.appendChild(ringSec);
    propsPanel.appendChild(buildIconVariantsSection(tile));
  }

  // ── Agents management (always show at bottom) ──
  propsPanel.appendChild(buildAgentsSection());
}

// ── Icon section with search ──────────────────────────────────────────────────
function buildIconSection(tile) {
  const sec = section('Icon');

  // Tabs: Lucide | App icons
  const hasNative = !!(window.Native?.getInstalledApps);
  loadInstalledApps();
  const hasApps = hasNative && installedApps?.length > 0;
  const isAppIcon = tile.icon?.startsWith('app:');
  let activeTab = isAppIcon ? 'app' : 'lucide';

  // Declare early so event listeners below can close over them without TDZ
  const lucideContent = div('');
  const appContent = div('');

  if (hasApps) {
    const tabs = div('icon-tabs');
    const lucideTab = div('icon-tab' + (activeTab === 'lucide' ? ' active' : ''));
    lucideTab.textContent = 'Lucide';
    const appTab = div('icon-tab' + (activeTab === 'app' ? ' active' : ''));
    appTab.textContent = 'App icons';
    tabs.append(lucideTab, appTab);
    sec.appendChild(tabs);

    lucideTab.addEventListener('click', () => {
      activeTab = 'lucide';
      lucideTab.classList.add('active'); appTab.classList.remove('active');
      lucideContent.style.display = '';
      appContent.style.display = 'none';
    });
    appTab.addEventListener('click', () => {
      activeTab = 'app';
      appTab.classList.add('active'); lucideTab.classList.remove('active');
      appContent.style.display = '';
      lucideContent.style.display = 'none';
    });
  }

  // Lucide tab content (lucideContent div declared above)
  const searchWrap = div('icon-search-wrap');
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Search icons...';
  searchInput.className = 'icon-search';
  searchWrap.appendChild(searchInput);
  lucideContent.appendChild(searchWrap);

  const picker = div('icon-picker');
  lucideContent.appendChild(picker);

  function buildPicker(filter = '') {
    picker.innerHTML = '';
    const names = filter
      ? ICON_NAMES.filter(n => n.includes(filter.toLowerCase()))
      : ICON_NAMES;
    for (const name of names) {
      const opt = div('icon-opt' + (tile.icon === name ? ' selected' : ''));
      opt.title = name;
      opt.appendChild(createIcon(name, { size: 16 }));
      opt.addEventListener('click', () => {
        tile.icon = name;
        picker.querySelectorAll('.icon-opt').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        markDirty();
        updateTileEl(tile.id);
      });
      picker.appendChild(opt);
    }
    if (!names.length) {
      const empty = div('icon-empty');
      empty.textContent = 'No icons match';
      picker.appendChild(empty);
    }
  }

  buildPicker();
  searchInput.addEventListener('input', () => buildPicker(searchInput.value));

  requestAnimationFrame(() => {
    const sel = picker.querySelector('.icon-opt.selected');
    sel?.scrollIntoView({ block: 'nearest' });
  });

  sec.appendChild(lucideContent);

  // App icons tab content (appContent div declared above)
  if (hasApps) {
    const appSearch = document.createElement('input');
    appSearch.type = 'search';
    appSearch.placeholder = 'Search apps...';
    appSearch.className = 'icon-search';
    appContent.appendChild(appSearch);

    const appGrid = div('icon-picker');
    const buildAppGrid = (filter = '') => {
      appGrid.innerHTML = '';
      const q = filter.toLowerCase();
      const apps = installedApps.filter(a => !q || a.appName.toLowerCase().includes(q) || a.packageName.toLowerCase().includes(q));
      for (const app of apps) {
        const iconKey = 'app:' + app.packageName;
        const opt = div('icon-opt' + (tile.icon === iconKey ? ' selected' : ''));
        opt.title = app.appName;
        if (app.iconBase64) {
          const img = document.createElement('img');
          img.src = `data:image/png;base64,${app.iconBase64}`;
          img.className = 'app-icon';
          opt.appendChild(img);
        } else {
          opt.appendChild(createIcon('app-window', { size: 16 }));
        }
        opt.addEventListener('click', () => {
          tile.icon = iconKey;
          appGrid.querySelectorAll('.icon-opt').forEach(o => o.classList.remove('selected'));
          opt.classList.add('selected');
          markDirty();
          updateTileEl(tile.id);
        });
        appGrid.appendChild(opt);
      }
    };
    buildAppGrid();
    appSearch.addEventListener('input', () => buildAppGrid(appSearch.value));
    appContent.appendChild(appGrid);
    sec.appendChild(appContent);

    lucideContent.style.display = isAppIcon ? 'none' : '';
    appContent.style.display = isAppIcon ? '' : 'none';
  }

  return sec;
}

// ── Icon variants section ─────────────────────────────────────────────────────
function buildIconVariantsSection(tile) {
  if (!tile.iconVariants) tile.iconVariants = [];
  const sec = section('Icon variants');
  const hint = div('field-hint');
  hint.textContent = 'Override icon when data matches a specific value (e.g. when "0%" show mic-off).';
  sec.appendChild(hint);

  const list = div('icon-variants-list');
  sec.appendChild(list);

  const renderList = () => {
    list.innerHTML = '';
    for (let i = 0; i < tile.iconVariants.length; i++) {
      const v = tile.iconVariants[i];
      const row = div('icon-variant-row');

      const whenInput = makeInput('text', v.when, (val) => { v.when = val; markDirty(); });
      whenInput.placeholder = 'e.g. 0%';
      whenInput.className = 'variant-when';

      const iconInput = makeInput('text', v.icon, (val) => { v.icon = val; markDirty(); updateTileEl(tile.id); });
      iconInput.placeholder = 'e.g. mic-off';
      iconInput.className = 'variant-icon';

      const removeBtn = iconButton('x', 'Remove variant', () => {
        tile.iconVariants.splice(i, 1);
        markDirty();
        renderList();
      });

      row.append(whenInput, iconInput, removeBtn);
      list.appendChild(row);
    }

    const addBtn = document.createElement('button');
    addBtn.className = 'add-variant-btn';
    addBtn.textContent = '+ Add variant';
    addBtn.addEventListener('click', () => {
      tile.iconVariants.push({ when: '', icon: '' });
      markDirty();
      renderList();
    });
    list.appendChild(addBtn);
  };

  renderList();
  return sec;
}

// ── App picker ────────────────────────────────────────────────────────────────
function loadInstalledApps() {
  if (installedApps !== null) return;
  try {
    const raw = window.Native?.getInstalledApps?.();
    installedApps = raw ? JSON.parse(raw).sort((a, b) => a.appName.localeCompare(b.appName)) : [];
  } catch {
    installedApps = [];
  }
}

function buildAppPicker(tile) {
  loadInstalledApps();

  const wrap = document.createElement('div');

  if (!installedApps.length) {
    // Fallback: plain text input (browser / no Native bridge)
    const pkgInput = makeInput('text', tile.action.packageName ?? '', (v) => { tile.action.packageName = v; markDirty(); });
    pkgInput.placeholder = 'com.example.app';
    wrap.appendChild(field('Package name', pkgInput));
    const hint = div('field-hint');
    hint.textContent = 'Open in the Android app to pick from installed apps.';
    wrap.appendChild(hint);
    return wrap;
  }

  // Selected app display
  const selectedEl = div('app-selected');
  const renderSelected = () => {
    selectedEl.innerHTML = '';
    const pkg = tile.action.packageName;
    const found = installedApps.find(a => a.packageName === pkg);
    if (found) {
      if (found.iconBase64) {
        const img = document.createElement('img');
        img.src = `data:image/png;base64,${found.iconBase64}`;
        img.className = 'app-icon';
        selectedEl.appendChild(img);
      }
      const nameEl = div('app-name');
      nameEl.textContent = found.appName;
      const pkgEl = div('app-pkg');
      pkgEl.textContent = found.packageName;
      selectedEl.append(nameEl, pkgEl);
    } else if (pkg) {
      const pkgEl = div('app-pkg');
      pkgEl.textContent = pkg;
      selectedEl.appendChild(pkgEl);
    } else {
      const hint = div('field-hint');
      hint.textContent = 'No app selected';
      selectedEl.appendChild(hint);
    }
  };
  renderSelected();
  wrap.appendChild(selectedEl);

  // Search + list
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'icon-search';
  searchInput.placeholder = 'Search apps...';
  wrap.appendChild(searchInput);

  const list = div('app-list');
  wrap.appendChild(list);

  const buildList = (filter = '') => {
    list.innerHTML = '';
    const q = filter.toLowerCase();
    const results = installedApps.filter(a =>
      !q || a.appName.toLowerCase().includes(q) || a.packageName.toLowerCase().includes(q)
    );
    for (const app of results) {
      const row = div('app-row' + (app.packageName === tile.action.packageName ? ' selected' : ''));
      if (app.iconBase64) {
        const img = document.createElement('img');
        img.src = `data:image/png;base64,${app.iconBase64}`;
        img.className = 'app-icon';
        row.appendChild(img);
      }
      const info = div('app-row-info');
      const nameEl = div('app-name');
      nameEl.textContent = app.appName;
      const pkgEl = div('app-pkg');
      pkgEl.textContent = app.packageName;
      info.append(nameEl, pkgEl);
      row.appendChild(info);
      row.addEventListener('click', () => {
        tile.action.packageName = app.packageName;
        markDirty();
        renderSelected();
        buildList(searchInput.value);
      });
      list.appendChild(row);
    }
  };
  buildList();
  searchInput.addEventListener('input', () => buildList(searchInput.value));

  return wrap;
}

// ── Calendar account picker ───────────────────────────────────────────────────
function buildCalendarPicker(tile) {
  const wrap = div('');
  loadInstalledApps(); // ensure Native is available check

  const populateSel = (sel, calendars) => {
    sel.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = ''; allOpt.textContent = 'All calendars';
    sel.appendChild(allOpt);
    const byAccount = {};
    for (const cal of calendars) {
      (byAccount[cal.accountName] ??= []).push(cal);
    }
    for (const [account, cals] of Object.entries(byAccount)) {
      const grp = document.createElement('optgroup');
      grp.label = account;
      for (const c of cals) {
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = c.name;
        if (c.id === tile.calendar?.calendarId) o.selected = true;
        grp.appendChild(o);
      }
      sel.appendChild(grp);
    }
  };

  const fetchCalendars = () => {
    try {
      const raw = window.Native?.getCalendars?.();
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  };

  let calendars = fetchCalendars();

  if (!calendars.length) {
    const hint = div('field-hint');
    hint.textContent = tile.calendar?.calendarId
      ? `Calendar ID: ${tile.calendar.calendarId}`
      : 'Open in the Android app to pick a calendar account. All calendars shown by default.';
    wrap.appendChild(hint);
    return wrap;
  }

  const sel = document.createElement('select');
  populateSel(sel, calendars);
  sel.addEventListener('change', () => {
    tile.calendar.calendarId = sel.value || undefined;
    markDirty();
  });

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.textContent = '↻';
  refreshBtn.title = 'Refresh calendar list';
  refreshBtn.style.cssText = 'margin-left:6px;padding:2px 8px;cursor:pointer;';
  refreshBtn.addEventListener('click', () => {
    calendars = fetchCalendars();
    populateSel(sel, calendars);
  });

  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.alignItems = 'center';
  const f = field('Account / calendar', sel);
  row.appendChild(f);
  row.appendChild(refreshBtn);
  wrap.appendChild(row);
  return wrap;
}

// ── Tap action section ────────────────────────────────────────────────────────
function buildTapActionSection(tile) {
  const sec = section('On tap');

  const typeOpts = [['none', 'Nothing'], ['url', 'Open URL'], ['app', 'Launch app']];
  const current = tile.tapApp !== undefined ? 'app' : tile.tapUrl !== undefined ? 'url' : 'none';
  const typeSel = makeSelect(typeOpts, current, (v) => {
    tile.tapUrl = undefined;
    tile.tapApp = undefined;
    if (v === 'url') tile.tapUrl = '';
    if (v === 'app') tile.tapApp = '';
    markDirty();
    sec.replaceWith(buildTapActionSection(tile));
  });
  sec.appendChild(field('Action', typeSel));

  if (tile.tapUrl !== undefined) {
    const urlInput = makeInput('url', tile.tapUrl ?? '', (v) => { tile.tapUrl = v || undefined; markDirty(); });
    urlInput.placeholder = 'https://...';
    sec.appendChild(field('URL', urlInput));
  }

  if (tile.tapApp !== undefined) {
    const hasApps = !!(window.Native?.getInstalledApps) && (installedApps?.length > 0);
    if (hasApps) {
      // Inline mini app picker
      loadInstalledApps();
      const pkgInput = makeInput('text', tile.tapApp ?? '', (v) => { tile.tapApp = v || undefined; markDirty(); });
      pkgInput.placeholder = 'com.example.app';
      const searchInput = document.createElement('input');
      searchInput.type = 'text'; searchInput.className = 'icon-search';
      searchInput.placeholder = 'Search apps...';
      const list = div('app-list');
      const buildList = (q = '') => {
        list.innerHTML = '';
        const filtered = installedApps.filter(a => !q || a.appName.toLowerCase().includes(q.toLowerCase()) || a.packageName.includes(q));
        for (const app of filtered.slice(0, 40)) {
          const row = div('app-row' + (app.packageName === tile.tapApp ? ' selected' : ''));
          if (app.iconBase64) {
            const img = document.createElement('img'); img.src = `data:image/png;base64,${app.iconBase64}`; img.className = 'app-icon';
            row.appendChild(img);
          }
          const info = div('app-row-info');
          info.appendChild(Object.assign(div('app-name'), { textContent: app.appName }));
          info.appendChild(Object.assign(div('app-pkg'), { textContent: app.packageName }));
          row.appendChild(info);
          row.addEventListener('click', () => { tile.tapApp = app.packageName; markDirty(); buildList(searchInput.value); });
          list.appendChild(row);
        }
      };
      buildList();
      searchInput.addEventListener('input', () => buildList(searchInput.value));
      sec.appendChild(searchInput);
      sec.appendChild(list);
    } else {
      const pkgInput = makeInput('text', tile.tapApp ?? '', (v) => { tile.tapApp = v || undefined; markDirty(); });
      pkgInput.placeholder = 'com.example.app';
      sec.appendChild(field('Package name', pkgInput));
    }
  }

  return sec;
}

// ── Agents section ────────────────────────────────────────────────────────────
function buildAgentsSection() {
  const sec = section('Agents');
  sec.classList.add('agents-section');

  if (statusAgents.length === 0) {
    const hint = div('field-hint');
    hint.textContent = 'No agents have connected yet. Start the agent on your PC.';
    sec.appendChild(hint);
    return sec;
  }

  for (const agent of statusAgents) {
    const row = div('agent-row');

    const dot = document.createElement('span');
    dot.className = `agent-dot ${agent.connected ? 'dot-connected' : 'dot-offline'}`;

    const info = div('agent-info');
    const nameEl = div('agent-name');
    nameEl.textContent = agent.hostname;
    const metaEl = div('agent-meta');
    metaEl.textContent = agent.os + (agent.last_seen_seconds_ago != null
      ? ` · ${agent.last_seen_seconds_ago}s ago` : '');
    info.append(nameEl, metaEl);

    const forgetBtn = iconButton('x', 'Forget agent', async () => {
      if (!confirm(`Forget "${agent.hostname}"? Tiles referencing this agent will still work if it reconnects.`)) return;
      await fetch(`/api/agents/${encodeURIComponent(agent.id)}?token=${encodeURIComponent(TOKEN)}`, { method: 'DELETE' });
      delete (config.agents ?? {})[agent.id];
      statusAgents = statusAgents.filter(a => a.id !== agent.id);
      const existing = propsPanel.querySelector('.agents-section');
      if (existing) existing.replaceWith(buildAgentsSection());
    });
    forgetBtn.classList.add('agent-remove');

    row.append(dot, info, forgetBtn);
    sec.appendChild(row);
  }

  const hint = div('field-hint');
  hint.textContent = 'Agents appear here automatically when they connect.';
  sec.appendChild(hint);

  return sec;
}

function buildAgentSelect(val, onChange) {
  const agents = statusAgents.length > 0
    ? statusAgents.map(a => [a.id, a.hostname])
    : Object.keys(config.agents ?? {}).map(id => [id, config.agents[id].hostname ?? id]);
  if (!agents.length) {
    const warn = div('field-hint warn');
    warn.textContent = '⚠ No agents have connected yet';
    return warn;
  }
  return makeSelect(agents, val, onChange);
}

// ── Tile actions ──────────────────────────────────────────────────────────────
function deleteTile(id) {
  if (!confirm('Delete this tile?')) return;
  config.tiles = config.tiles.filter(t => t.id !== id);
  selectedTileId = null;
  markDirty(); renderGrid(); showEmptyProps();
}

function duplicateTile(id) {
  const src = config.tiles.find(t => t.id === id);
  if (!src) return;
  const pos = findFreePosition();
  if (!pos) { showToast('No free cells to duplicate into'); return; }
  const newTile = JSON.parse(JSON.stringify(src));
  newTile.id = uuid();
  newTile.position = { ...pos, rowSpan: 1, colSpan: 1 };
  newTile.label = src.label ? `${src.label} (copy)` : '';
  config.tiles.push(newTile);
  markDirty(); renderGrid(); selectTile(newTile.id);
}

// ── Save ──────────────────────────────────────────────────────────────────────
async function saveConfig() {
  saveStatus.textContent = 'Saving...';
  saveStatus.className = 'save-status';
  try {
    const res = await fetch(`/api/config?token=${encodeURIComponent(TOKEN)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    saveStatus.textContent = 'Saved ✓';
    saveStatus.className = 'save-status ok';
    dirty = false;
    saveBtn.classList.remove('unsaved');
  } catch (e) {
    saveStatus.textContent = `Error: ${e.message}`;
    saveStatus.className = 'save-status err';
  }
  setTimeout(() => { saveStatus.textContent = ''; saveStatus.className = 'save-status'; }, 3000);
}

function markDirty() {
  if (!dirty) {
    dirty = true;
    saveBtn.classList.add('unsaved');
    saveStatus.textContent = 'Unsaved';
    saveStatus.className = 'save-status warn';
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function section(title) {
  const s = div('props-section');
  const h = div('props-section-title');
  h.textContent = title;
  s.appendChild(h);
  return s;
}

function field(label, el) {
  const w = div('field');
  const l = document.createElement('label');
  l.textContent = label;
  w.append(l, el);
  return w;
}

function div(className = '') {
  const el = document.createElement('div');
  if (className) el.className = className;
  return el;
}

function makeInput(type, val, onChange) {
  const el = document.createElement('input');
  el.type = type;
  el.value = val ?? '';
  el.addEventListener('input', () => onChange(el.value));
  return el;
}

function makeNumInput(val, min, max, onChange) {
  const el = makeInput('number', val, (v) => onChange(Math.min(max, Math.max(min, parseInt(v) || min))));
  el.min = min; el.max = max;
  el.className = 'num-input';
  return el;
}

function makeTextarea(val, onChange) {
  const el = document.createElement('textarea');
  el.value = val ?? '';
  el.addEventListener('input', () => onChange(el.value));
  return el;
}

function makeSelect(opts, val, onChange) {
  const el = document.createElement('select');
  for (const [v, label] of opts) {
    const o = document.createElement('option');
    o.value = v; o.textContent = label;
    if (v === val) o.selected = true;
    el.appendChild(o);
  }
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

function iconButton(iconName, title, onClick) {
  const btn = document.createElement('button');
  btn.className = 'icon-btn';
  btn.title = title;
  btn.appendChild(createIcon(iconName, { size: 14 }));
  btn.addEventListener('click', onClick);
  return btn;
}

function defaultAction(type) {
  const firstAgent = Object.keys(config?.agents ?? {})[0] ?? 'pc';
  return {
    app:      { type: 'launch_app', packageName: '' },
    shortcut: { type: 'open_url',   url: '' },
    command:  { type: 'pc_command', agent: firstAgent, command: '' },
    pc_data:  { type: 'pc_poll',    agent: firstAgent, command: '', intervalSeconds: 60 },
    volume:   { type: 'pc_poll',    agent: firstAgent, command: '', intervalSeconds: 5 },
    mic:      { type: 'pc_poll',    agent: firstAgent, command: '', intervalSeconds: 5 },
  }[type] ?? null;
}

function defaultIcon(type) {
  return { app: 'app-window', command: 'terminal', pc_data: 'monitor', shortcut: 'globe',
           weather: 'cloud', media: 'music', clock: 'clock', calendar: 'calendar',
           volume: 'volume-2', mic: 'mic', stocks: 'trending-up' }[type] ?? null;
}

function showToast(msg) {
  const t = div('toast');
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2500);
}

function uuid() {
  return crypto.randomUUID?.() ??
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}
