"use strict";

/* ══════════════════════════════════════════════════════════════
   PREFERENCES — persistent user settings (localStorage)
   ══════════════════════════════════════════════════════════════ */
const PREFS_KEY = 'pypad-prefs-v1';
const defaultPrefs = {
  theme: 'system',            // 'dark' | 'light' | 'system'
  accent: 'red',              // ACCENTS key
  editorTheme: 'pypad',       // EDITOR_THEMES key
  tabWidth: 4,
  fontSize: 13,
  kbdAlwaysOn: false,
  sidebarOpen: false,
  layout: null,               // panel slot snapshot {bottom: [...], right: [...], activeBottom, activeRight}
};
let prefs = loadPrefs();
function loadPrefs() {
  try { return Object.assign({}, defaultPrefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); }
  catch { return { ...defaultPrefs }; }
}
function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {} }
function setPref(key, value) {
  prefs[key] = value; savePrefs();
  if (key === 'theme')       applyTheme();
  if (key === 'accent')      applyAccent();
  if (key === 'editorTheme') applyEditorTheme();
  if (key === 'tabWidth')    applyTabWidth();
  if (key === 'fontSize')    applyFontSize();
}

/* ══════════════════════════════════════════════════════════════
   PERSISTENCE — files / GitLab / folder handle
   Survives refresh; cleared by "clear cookies and site data".
   ══════════════════════════════════════════════════════════════ */
const STORE = {
  files:  'pypad-files-v1',   // open files + active id (incl. uncommitted gitlab edits)
  gitlab: 'pypad-gitlab-v1',  // PAT + URL + user + open repo + branch
};

/* Tiny IndexedDB key/value store — used for FileSystemDirectoryHandle
   which isn't serializable to localStorage. */
const idb = (function () {
  let p;
  function db() {
    return p || (p = new Promise((res, rej) => {
      const r = indexedDB.open('pypad', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  }
  return {
    async get(k) { const d = await db(); return new Promise((res, rej) => { const r = d.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
    async set(k, v) { const d = await db(); return new Promise((res, rej) => { const tx = d.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); },
    async del(k) { const d = await db(); return new Promise((res, rej) => { const tx = d.transaction('kv', 'readwrite'); tx.objectStore('kv').delete(k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); },
  };
})();

/* Strip non-serializable bits (FileSystemFileHandle) before stringify. */
function slimFiles() {
  return files.map(({ handle, ...rest }) => rest);
}
let _persistFilesT = null;
function persistFiles() {
  // light debounce so per-keystroke edits don't hammer localStorage
  clearTimeout(_persistFilesT);
  _persistFilesT = setTimeout(() => {
    try { localStorage.setItem(STORE.files, JSON.stringify({ files: slimFiles(), activeId })); } catch {}
  }, 250);
}
function loadPersistedFiles() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE.files) || 'null');
    if (raw && Array.isArray(raw.files)) {
      raw.files.forEach(f => files.push(f));
      activeId = raw.activeId || null;
      return true;
    }
  } catch {}
  return false;
}

function persistGitlab() {
  try {
    if (!session.token) { localStorage.removeItem(STORE.gitlab); return; }
    localStorage.setItem(STORE.gitlab, JSON.stringify({
      token: session.token, gitlabUrl: session.gitlabUrl,
      username: session.username, email: session.email,
      avatarInitial: session.avatarInitial,
      currentRepo: session.currentRepo, currentBranch: session.currentBranch,
    }));
  } catch {}
}
function loadPersistedGitlab() {
  try {
    const data = JSON.parse(localStorage.getItem(STORE.gitlab) || 'null');
    if (data && data.token) { Object.assign(session, data); return true; }
  } catch {}
  return false;
}

function forceDisconnectGitlab() {
  session.token = null; session.username = null; session.email = null;
  session.avatarInitial = null; session.currentRepo = null;
  session.currentBranch = null; session.currentFile = null;
  try { localStorage.removeItem(STORE.gitlab); } catch {}
  // Also drop any open gitlab files (their content was edits-only).
  for (let i = files.length - 1; i >= 0; i--) {
    if (files[i].source === 'gitlab') {
      if (files[i].id === activeId) activeId = null;
      files.splice(i, 1);
    }
  }
  // UI
  document.getElementById('btnGitlab').classList.remove('active');
  document.getElementById('stBranch').innerHTML = `<svg><use href="#i-branch"/></svg> local`;
  document.getElementById('glDot').style.display = '';
  persistFiles(); renderTree();
  if (!activeId && files.length === 0) {
    src.value = '';
    fileLabel.textContent = 'untitled.py';
    document.getElementById('bcFile').textContent = 'untitled.py';
    renderHighlight();
  }
}
function closeRepo() {
  session.currentRepo = null; session.currentBranch = null;
  document.getElementById('stBranch').innerHTML =
    `<svg><use href="#i-branch"/></svg> ${session.username ? '@' + esc(session.username) : 'local'}`;
  persistGitlab(); renderTree();
  toast('Closed repository');
}
function clearAllStorage() {
  if (!confirm('Clear ALL stored data?\n\n· Files in browser storage\n· GitLab session (token, repo)\n· Folder handle\n· Preferences (theme, accent, layout)\n\nThis can\'t be undone.')) return;
  try {
    localStorage.removeItem(STORE.files);
    localStorage.removeItem(STORE.gitlab);
    localStorage.removeItem(PREFS_KEY);
  } catch {}
  try { idb.del('dirHandle'); } catch {}
  toast('All stored data cleared — reloading', 'warn');
  setTimeout(() => location.reload(), 600);
}

/* ── File System Access API — open a folder from the user's disk.
   Handle is persisted in IndexedDB; permission may need re-grant
   on a new tab/session. ── */
let dirHandle = null;
let dirTreeCache = [];
let dirNeedsPerm = false;

function fsaSupported() { return typeof window.showDirectoryPicker === 'function'; }

async function openLocalDir() {
  if (!fsaSupported()) {
    toast('Folder open requires Chrome / Edge / Opera', 'err');
    return;
  }
  try {
    const h = await window.showDirectoryPicker({ mode: 'readwrite' });
    dirHandle = h; dirNeedsPerm = false;
    try { await idb.set('dirHandle', h); } catch {}
    await refreshDirTree();
    toast(`Folder · ${h.name}`, 'ok');
  } catch (e) {
    if (e.name !== 'AbortError') toast(`Open folder failed: ${e.message}`, 'err');
  }
}

async function tryRestoreDir() {
  if (!fsaSupported()) return;
  try {
    const h = await idb.get('dirHandle');
    if (!h) return;
    dirHandle = h;
    const perm = await h.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') { await refreshDirTree(); rewireDirFileHandles(); }
    else { dirNeedsPerm = true; renderTree(); }
  } catch {}
}

async function resumeDirAccess() {
  if (!dirHandle) return false;
  try {
    const p = await dirHandle.requestPermission({ mode: 'readwrite' });
    if (p === 'granted') {
      dirNeedsPerm = false;
      await refreshDirTree();
      rewireDirFileHandles();
      return true;
    }
    toast('Permission denied', 'err');
  } catch (e) { toast(`Permission failed: ${e.message}`, 'err'); }
  return false;
}

async function refreshDirTree() {
  if (!dirHandle) return;
  const out = [];
  async function walk(h, prefix = '') {
    for await (const e of h.values()) {
      if (e.kind === 'directory') {
        const name = e.name;
        if (name.startsWith('.') ||
            ['node_modules', '__pycache__', 'venv', '.venv', 'dist', 'build', '.git']
              .includes(name)) continue;
        await walk(e, prefix + name + '/');
      } else if (e.kind === 'file') {
        out.push({ name: e.name, path: prefix + e.name, handle: e });
      }
    }
  }
  try { await walk(dirHandle); } catch {}
  out.sort((a, b) => a.path.localeCompare(b.path));
  dirTreeCache = out;
  renderTree();
}

/* After refreshing the tree, re-attach FileSystemFileHandles to any
   previously-restored `dir`-source files in the open files list. */
function rewireDirFileHandles() {
  files.forEach(f => {
    if (f.source === 'dir' && !f.handle && f.path) {
      const m = dirTreeCache.find(t => t.path === f.path);
      if (m) f.handle = m.handle;
    }
  });
}

async function openDirFile(path) {
  const entry = dirTreeCache.find(e => e.path === path);
  if (!entry) return;
  // already open? just switch
  const existing = files.find(f => f.source === 'dir' && f.path === path);
  if (existing) { selectFile(existing.id); return; }
  try {
    const file = await entry.handle.getFile();
    const content = await file.text();
    const f = {
      id: cryptoId(), name: entry.name, content, originalContent: content,
      source: 'dir', path, handle: entry.handle,
    };
    files.push(f); selectFile(f.id); persistFiles();
    toast(`Opened ${entry.name}`, 'ok');
  } catch (e) {
    toast(`Open failed: ${e.message}`, 'err');
  }
}

function closeDir() {
  dirHandle = null; dirTreeCache = []; dirNeedsPerm = false;
  try { idb.del('dirHandle'); } catch {}
  // Drop dir-sourced open files (their disk-source is gone)
  for (let i = files.length - 1; i >= 0; i--) {
    if (files[i].source === 'dir') {
      if (files[i].id === activeId) activeId = null;
      files.splice(i, 1);
    }
  }
  if (!activeId) {
    src.value = '';
    fileLabel.textContent = 'untitled.py';
    document.getElementById('bcFile').textContent = 'untitled.py';
    renderHighlight();
  }
  persistFiles(); renderTree();
  toast('Closed folder');
}

/* ── Accent palette ── each accent has separate dark / light variants.
   Dark variants are brighter & saturated for visibility on dark chrome;
   light variants are deeper / less neon for legibility on white. */
const ACCENTS = {
  red:     { name: 'Red',
    dark:  { main: '#ff3b3b', rgb: '255,59,59'    },
    light: { main: '#cc0000', rgb: '204,0,0'      } },
  blue:    { name: 'Blue',
    dark:  { main: '#5b9bff', rgb: '91,155,255'   },
    light: { main: '#0a66c2', rgb: '10,102,194'   } },
  magenta: { name: 'Magenta',
    dark:  { main: '#ff5dbf', rgb: '255,93,191'   },
    light: { main: '#c2185b', rgb: '194,24,91'    } },
  orange:  { name: 'Orange',
    dark:  { main: '#ff9540', rgb: '255,149,64'   },
    light: { main: '#d35400', rgb: '211,84,0'     } },
  green:   { name: 'Green',
    dark:  { main: '#3ddc8b', rgb: '61,220,139'   },
    light: { main: '#06814e', rgb: '6,129,78'     } },
  purple:  { name: 'Purple',
    dark:  { main: '#b388ff', rgb: '179,136,255'  },
    light: { main: '#6a1b9a', rgb: '106,27,154'   } },
  cyan:    { name: 'Cyan',
    dark:  { main: '#22d3ee', rgb: '34,211,238'   },
    light: { main: '#0e7490', rgb: '14,116,144'   } },
  amber:   { name: 'Amber',
    dark:  { main: '#fbbf24', rgb: '251,191,36'   },
    light: { main: '#b45309', rgb: '180,83,9'     } },
};
function currentMode() {
  if (prefs.theme === 'system') return _systemMql.matches ? 'light' : 'dark';
  return prefs.theme;
}
function accentVariant(key) {
  const a = ACCENTS[key] || ACCENTS.red;
  return a[currentMode()] || a.dark;
}

/* ── Editor themes — bg + token overrides ──
   `auto` follows the IDE chrome theme: dark → PyPad, light → GitHub Light. */
const EDITOR_THEMES = {
  auto: {
    name: 'Follow IDE', follow: true,
  },
  pypad: {
    name: 'PyPad', isDark: true, bg: '#000000', fg: '#e0e0e0',
    tokens: { kw: '#cc0000', fn: '#448aff', str: '#00d4aa', num: '#ffab00', cmt: '#777777', dec: '#b388ff', cls: '#ffab00', op: '#aaaaaa', self: '#b388ff', bi: '#448aff' },
  },
  midnight: {
    name: 'Midnight', isDark: true, bg: '#0e1525', fg: '#dbe7ff',
    tokens: { kw: '#ff79c6', fn: '#82aaff', str: '#a5e075', num: '#ffcb6b', cmt: '#546e94', dec: '#c792ea', cls: '#ffcb6b', op: '#89ddff', self: '#c792ea', bi: '#82aaff' },
  },
  solarized: {
    name: 'Solarized Dark', isDark: true, bg: '#002b36', fg: '#93a1a1',
    tokens: { kw: '#cb4b16', fn: '#268bd2', str: '#2aa198', num: '#b58900', cmt: '#586e75', dec: '#6c71c4', cls: '#b58900', op: '#93a1a1', self: '#6c71c4', bi: '#268bd2' },
  },
  dracula: {
    name: 'Dracula', isDark: true, bg: '#282a36', fg: '#f8f8f2',
    tokens: { kw: '#ff79c6', fn: '#50fa7b', str: '#f1fa8c', num: '#bd93f9', cmt: '#6272a4', dec: '#ffb86c', cls: '#8be9fd', op: '#ff79c6', self: '#bd93f9', bi: '#8be9fd' },
  },
  'github-light': {
    name: 'GitHub Light', isDark: false, bg: '#ffffff', fg: '#1f2328',
    tokens: { kw: '#cf222e', fn: '#8250df', str: '#0a3069', num: '#0550ae', cmt: '#6e7781', dec: '#953800', cls: '#953800', op: '#24292f', self: '#953800', bi: '#0550ae' },
  },
};

/* ── Apply functions (define stubs early; real impls below) ── */
let _systemMql = matchMedia('(prefers-color-scheme: light)');
function applyTheme() {
  let mode = prefs.theme;
  if (mode === 'system') mode = _systemMql.matches ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', mode);
  // Topbar button reflects the *selected* preference, not the resolved mode,
  // so the user can see at a glance whether System / Light / Dark is active.
  const tIcon = document.getElementById('themeIcon');
  const tBtn  = document.getElementById('btnTheme');
  const iconKey = prefs.theme === 'system' ? 'i-monitor'
              : prefs.theme === 'light'  ? 'i-sun'
              :                            'i-moon';
  if (tIcon) tIcon.innerHTML = `<use href="#${iconKey}"/>`;
  if (tBtn)  tBtn.setAttribute('data-tip',
    prefs.theme === 'system' ? 'Theme: System' :
    prefs.theme === 'light'  ? 'Theme: Light'  : 'Theme: Dark');
  // Re-pick accent variant + auto-follow editor theme for the new mode
  if (typeof applyAccent === 'function') applyAccent();
  if (typeof applyEditorTheme === 'function') applyEditorTheme();
}
_systemMql.addEventListener?.('change', () => { if (prefs.theme === 'system') applyTheme(); });

function applyAccent() {
  const v = accentVariant(prefs.accent);
  const r = document.documentElement.style;
  r.setProperty('--accent', v.main);
  r.setProperty('--accent-rgb', v.rgb);
  r.setProperty('--accent-dim',  `rgba(${v.rgb}, 0.12)`);
  r.setProperty('--accent-glow', `rgba(${v.rgb}, 0.26)`);
  rebuildCursors(v.main);
  _accentRgb = v.rgb;
}
function rebuildCursors(hex) {
  const h = hex.replace('#', '%23');
  const def = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20'%3E%3Cpath d='M5 1L1 1L1 5' fill='none' stroke='${h}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3Cpath d='M10 6L6 6L6 10' fill='none' stroke='${h}' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round' opacity='0.55'/%3E%3Cpath d='M15 11L11 11L11 15' fill='none' stroke='${h}' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round' opacity='0.25'/%3E%3C/svg%3E`;
  const ptr = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Cline x1='8' y1='1' x2='8' y2='3' stroke='${h}' stroke-width='1.4' stroke-linecap='round'/%3E%3Cline x1='8' y1='13' x2='8' y2='15' stroke='${h}' stroke-width='1.4' stroke-linecap='round'/%3E%3Cline x1='1' y1='8' x2='3' y2='8' stroke='${h}' stroke-width='1.4' stroke-linecap='round'/%3E%3Cline x1='13' y1='8' x2='15' y2='8' stroke='${h}' stroke-width='1.4' stroke-linecap='round'/%3E%3Cpath d='M8 4L12 8L8 12L4 8Z' fill='none' stroke='${h}' stroke-width='1.4' stroke-linejoin='round'/%3E%3Crect x='6.5' y='6.5' width='3' height='3' fill='${h}'/%3E%3C/svg%3E`;
  const txt = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='18' viewBox='0 0 16 18'%3E%3Cline x1='10' y1='2' x2='10' y2='16' stroke='${h}' stroke-width='1.8' stroke-linecap='round'/%3E%3Cline x1='7' y1='3' x2='13' y2='3' stroke='${h}' stroke-width='1.4' stroke-linecap='round'/%3E%3Cline x1='7' y1='15' x2='13' y2='15' stroke='${h}' stroke-width='1.4' stroke-linecap='round'/%3E%3Cpath d='M2 6L5 9L2 12' fill='none' stroke='${h}' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E`;
  const r = document.documentElement.style;
  r.setProperty('--cur-default', `url("${def}") 1 1, default`);
  r.setProperty('--cur-pointer', `url("${ptr}") 8 8, pointer`);
  r.setProperty('--cur-text',    `url("${txt}") 10 9, text`);
}
/* Resolve an editor-theme key, following IDE chrome when `auto` is selected. */
function resolveEditorTheme(key) {
  const t = EDITOR_THEMES[key] || EDITOR_THEMES.pypad;
  if (t.follow) return currentMode() === 'light' ? EDITOR_THEMES['github-light'] : EDITOR_THEMES.pypad;
  return t;
}
function applyEditorTheme() {
  const t = resolveEditorTheme(prefs.editorTheme);
  const r = document.documentElement.style;
  r.setProperty('--editor-bg', t.bg);
  r.setProperty('--editor-fg', t.fg);
  Object.entries(t.tokens).forEach(([k, v]) => r.setProperty(`--tk-${k}`, v));
  document.documentElement.setAttribute('data-editor-theme', prefs.editorTheme);
}
function applyTabWidth() {
  document.documentElement.style.setProperty('--tab-w', prefs.tabWidth);
}
function applyFontSize() {
  document.documentElement.style.setProperty('--code-fs', prefs.fontSize + 'px');
}

/* ──────────────────────────────────────────────────────────────
   AMBIENT FIELD — slow drifting accent-colored dots
   ────────────────────────────────────────────────────────────── */
let _accentRgb = '204,0,0';
function hexToRgb(hex) {
  const m = hex.replace('#', '').match(/^([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}
(function () {
  const c = document.getElementById('field'); const ctx = c.getContext('2d');
  let w, h, dots = [];
  function resize() {
    w = c.width = Math.floor(window.innerWidth * devicePixelRatio);
    h = c.height = Math.floor(window.innerHeight * devicePixelRatio);
    c.style.width = window.innerWidth + 'px'; c.style.height = window.innerHeight + 'px';
  }
  function seed(n) {
    dots = []; for (let i = 0; i < n; i++) dots.push({
      x: Math.random() * w, y: Math.random() * h,
      vx: (Math.random() - .5) * .12 * devicePixelRatio,
      vy: (Math.random() - .5) * .12 * devicePixelRatio,
      r: (Math.random() * 1.2 + .4) * devicePixelRatio,
      a: Math.random() * .4 + .1,
    });
  }
  resize(); seed(48);
  window.addEventListener('resize', () => { resize(); seed(48); });
  function tick() {
    ctx.clearRect(0, 0, w, h);
    dots.forEach(d => {
      d.x = (d.x + d.vx + w) % w; d.y = (d.y + d.vy + h) % h;
      ctx.fillStyle = `rgba(${_accentRgb},${d.a * .35})`;
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill();
    });
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();

/* ──────────────────────────────────────────────────────────────
   TOAST
   ────────────────────────────────────────────────────────────── */
function toast(msg, kind = '') {
  const host = document.getElementById('toastHost');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 240);
  }, 2400);
}

/* ──────────────────────────────────────────────────────────────
   TOOLTIP
   ────────────────────────────────────────────────────────────── */
(function () {
  const tip = document.getElementById('tip'); let target = null, t = null;
  function showFor(el) {
    if (!el) return;
    const text = el.getAttribute('data-tip'); if (!text) return;
    tip.textContent = text;
    const r = el.getBoundingClientRect();
    tip.style.visibility = 'hidden'; tip.style.display = 'block'; tip.classList.add('show');
    const tr = tip.getBoundingClientRect();
    let top = r.bottom + 8;
    let left = r.left + r.width / 2 - tr.width / 2;
    if (top + tr.height > window.innerHeight - 8) top = r.top - tr.height - 8;
    left = Math.max(6, Math.min(left, window.innerWidth - tr.width - 6));
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
    tip.style.visibility = 'visible';
  }
  function hide() { tip.classList.remove('show'); target = null; clearTimeout(t); }
  document.addEventListener('mouseover', e => {
    const el = e.target.closest('[data-tip]'); if (!el || el === target) return;
    target = el; clearTimeout(t); t = setTimeout(() => showFor(el), 350);
  });
  document.addEventListener('mouseout', e => {
    if (!target) return; if (target.contains(e.relatedTarget)) return; hide();
  });
  document.addEventListener('click', hide);
  document.addEventListener('scroll', hide, true);
})();

/* ──────────────────────────────────────────────────────────────
   EDITOR — textarea + highlighted <pre> overlay
   ────────────────────────────────────────────────────────────── */
const src = document.getElementById('src');
const hl = document.getElementById('hlCode');
const gut = document.getElementById('gutter');
const ph = document.getElementById('placeholder');
const stack = document.getElementById('codeStack');
const fileLabel = document.getElementById('fileName');
const filePill = document.getElementById('filePill');

const PY_KW = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in',
  'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case'
]);
const PY_BI = new Set([
  'print', 'len', 'range', 'enumerate', 'open', 'sum', 'min', 'max', 'list', 'dict', 'set', 'tuple',
  'str', 'int', 'float', 'bool', 'bytes', 'isinstance', 'type', 'input', 'sorted', 'map', 'filter', 'zip', 'abs', 'round',
  'super', 'object', 'property', 'staticmethod', 'classmethod', 'iter', 'next', 'hash', 'id',
  'callable', 'repr', 'ord', 'chr', 'reversed', 'all', 'any', 'divmod', 'pow', 'vars',
  'globals', 'locals', 'getattr', 'setattr', 'hasattr', 'delattr', 'issubclass',
  'frozenset', 'bytearray', 'memoryview', 'complex', 'format', 'slice',
  'Exception', 'BaseException', 'ValueError', 'TypeError', 'KeyError', 'IndexError',
  'AttributeError', 'RuntimeError', 'StopIteration', 'ArithmeticError', 'AssertionError',
  'OSError', 'NameError', 'ZeroDivisionError', 'NotImplementedError', 'FileNotFoundError',
  'ImportError', 'ModuleNotFoundError', 'LookupError', 'UnicodeError', 'OverflowError',
]);
const PY_DUNDERS = new Set([
  '__name__', '__main__', '__file__', '__init__', '__doc__', '__all__',
  '__repr__', '__str__', '__eq__', '__hash__', '__len__', '__iter__', '__next__',
  '__enter__', '__exit__', '__getitem__', '__setitem__', '__call__', '__future__',
]);

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* Strip strings and comments from a line so identifier matching can run
   against code-only text. Replaces them with spaces to preserve column. */
function stripStringsAndComments(line) {
  let out = ''; let str = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (str) {
      if (c === '\\' && i + 1 < line.length) { out += '  '; i++; continue; }
      out += ' ';
      if (c === str) str = null;
      continue;
    }
    if (c === '#') { out += ' '.repeat(line.length - i); break; }
    if (c === '"' || c === "'") { str = c; out += ' '; continue; }
    out += c;
  }
  return out;
}

/* Collect every name defined anywhere in the file (best-effort, no AST).
   Wildcard imports return null → caller should disable unknown-name lint. */
function getDefinedNames(code) {
  const defined = new Set([
    'self', 'cls', '_',
  ]);
  PY_BI.forEach(b => defined.add(b));
  PY_DUNDERS.forEach(b => defined.add(b));
  let wildcard = false;
  const lines = code.split('\n');
  lines.forEach(line => {
    const s = stripStringsAndComments(line);
    // import X, import X as Y, import X.Y
    const im = s.match(/^\s*import\s+(.+)$/);
    if (im) {
      im[1].split(',').forEach(spec => {
        const t = spec.trim(); if (!t) return;
        const asM = t.match(/^(\S+)\s+as\s+([A-Za-z_]\w*)$/);
        if (asM) defined.add(asM[2]);
        else defined.add(t.split('.')[0].trim());
      });
    }
    // from X import a, b as c, *
    const fr = s.match(/^\s*from\s+\S+\s+import\s+(.+)$/);
    if (fr) {
      const after = fr[1].replace(/^\(|\)$/g, '');
      after.split(',').forEach(spec => {
        const t = spec.trim(); if (!t) return;
        if (t === '*') { wildcard = true; return; }
        const asM = t.match(/^([A-Za-z_]\w*)\s+as\s+([A-Za-z_]\w*)$/);
        defined.add(asM ? asM[2] : t.match(/^([A-Za-z_]\w*)/)?.[1] || t);
      });
    }
    // def / async def
    const fn = s.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/);
    if (fn) {
      defined.add(fn[1]);
      fn[2].split(',').forEach(p => {
        const m = p.replace(/[:=].*$/, '').trim().match(/^\*{0,2}\s*([A-Za-z_]\w*)/);
        if (m) defined.add(m[1]);
      });
    }
    // class
    const cl = s.match(/^\s*class\s+([A-Za-z_]\w*)/);
    if (cl) defined.add(cl[1]);
    // for X in ..., scattered (also catches comprehensions like [x for x in y])
    [...s.matchAll(/\bfor\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+in\s+/g)].forEach(m => {
      m[1].split(',').forEach(t => {
        const id = t.trim().match(/^([A-Za-z_]\w*)/);
        if (id) defined.add(id[1]);
      });
    });
    // with X as Y, with X as (a, b)
    [...s.matchAll(/\bas\s+([A-Za-z_]\w*)/g)].forEach(m => defined.add(m[1]));
    // lambda X: ...
    [...s.matchAll(/\blambda\s+([^:]+):/g)].forEach(m => {
      m[1].split(',').forEach(p => {
        const id = p.trim().match(/^([A-Za-z_]\w*)/);
        if (id) defined.add(id[1]);
      });
    });
    // walrus operator :=
    [...s.matchAll(/\b([A-Za-z_]\w*)\s*:=/g)].forEach(m => defined.add(m[1]));
    // global / nonlocal
    const gn = s.match(/^\s*(?:global|nonlocal)\s+(.+)$/);
    if (gn) gn[1].split(',').forEach(n => {
      const id = n.trim().match(/^([A-Za-z_]\w*)/);
      if (id) defined.add(id[1]);
    });
    // assignment: lhs = rhs (incl tuple unpacking)
    // detect anything left of an '=' that's not '==', '!=', '<=', '>=', '+=', etc.
    // skip lines that begin with a control keyword
    if (!/^\s*(?:if|elif|while|for|return|yield|raise|with|try|except|finally|import|from|assert|del|pass|break|continue)\b/.test(s)) {
      // walk: find first unparenthesized '=' that isn't part of ==, !=, <=, >=, +=, -=, *=, /=, %=, |=, &=, ^=, >>=, <<=, **=, //=, :=
      let depth = 0, eqIdx = -1;
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        else if (c === '=' && depth === 0) {
          const prev = s[i - 1] || ''; const next = s[i + 1] || '';
          if ('=!<>+-*/%|&^:'.includes(prev)) continue;
          if (next === '=') { i++; continue; }
          eqIdx = i; break;
        }
      }
      if (eqIdx > 0) {
        const lhs = s.slice(0, eqIdx);
        [...lhs.matchAll(/([A-Za-z_]\w*)/g)].forEach(m => {
          const at = m.index;
          if (at > 0 && lhs[at - 1] === '.') return; // attribute, not new name
          if (at > 0 && lhs[at - 1] === ']') return; // subscript target
          defined.add(m[1]);
        });
      }
    }
  });
  return wildcard ? null : defined;
}

/* Find unknown name references across the file. Returns [{line, col, name}]. */
function getUnknownNames(code) {
  const defined = getDefinedNames(code);
  if (!defined) return [];           // wildcard import — bail
  const unknowns = [];
  const lines = code.split('\n');
  lines.forEach((line, li) => {
    const s = stripStringsAndComments(line);
    [...s.matchAll(/\b([A-Za-z_]\w*)\b/g)].forEach(m => {
      const word = m[1]; const idx = m.index;
      if (idx > 0 && s[idx - 1] === '.') return;          // attribute access
      if (PY_KW.has(word)) return;
      if (defined.has(word)) return;
      // skip number-like (already covered by \b) and pure digit-like
      if (/^\d/.test(word)) return;
      // skip identifiers immediately followed by '=' (assignment / kwarg)
      let after = idx + word.length;
      while (after < s.length && s[after] === ' ') after++;
      if (s[after] === '=' && s[after + 1] !== '=') return;
      // skip when used as a kwarg in a call: identifier followed by '='
      // (handled above). Already-defined check covers most.
      unknowns.push({ line: li + 1, col: idx + 1, name: word });
    });
  });
  return unknowns;
}

/* Tokenize a python source string into highlighted HTML.
   `defined` is a Set of known names — identifiers outside it get .tk-unk
   (red wavy underline). Pass null to disable unknown-name marking. */
function tokenizePython(code, defined) {
  let out = '';
  const lines = code.split('\n');
  let inTriple = null;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let i = 0; let buf = '';
    while (i < line.length) {
      if (inTriple) {
        const idx = line.indexOf(inTriple, i);
        if (idx === -1) { buf += `<span class="tk-str">${escHtml(line.slice(i))}</span>`; i = line.length; }
        else { buf += `<span class="tk-str">${escHtml(line.slice(i, idx + 3))}</span>`; i = idx + 3; inTriple = null; }
        continue;
      }
      const ch = line[i]; const two = line.slice(i, i + 3);
      if (two === '"""' || two === "'''") {
        const end = line.indexOf(two, i + 3);
        if (end === -1) { buf += `<span class="tk-str">${escHtml(line.slice(i))}</span>`; inTriple = two; i = line.length; }
        else { buf += `<span class="tk-str">${escHtml(line.slice(i, end + 3))}</span>`; i = end + 3; }
        continue;
      }
      if (ch === '#') { buf += `<span class="tk-cmt">${escHtml(line.slice(i))}</span>`; break; }
      if (ch === '"' || ch === "'") {
        const q = ch; let j = i + 1; let esc = false;
        while (j < line.length) { const c = line[j]; if (esc) { esc = false; j++; continue; } if (c === '\\') { esc = true; j++; continue; } if (c === q) { j++; break; } j++; }
        buf += `<span class="tk-str">${escHtml(line.slice(i, j))}</span>`; i = j; continue;
      }
      if (ch === '@') {
        let j = i + 1; while (j < line.length && /[A-Za-z_0-9.]/.test(line[j])) j++;
        buf += `<span class="tk-dec">${escHtml(line.slice(i, j))}</span>`; i = j; continue;
      }
      if (/[0-9]/.test(ch)) {
        let j = i; while (j < line.length && /[0-9_.xXbBoOeE]/.test(line[j])) j++;
        buf += `<span class="tk-num">${escHtml(line.slice(i, j))}</span>`; i = j; continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        let j = i; while (j < line.length && /[A-Za-z_0-9]/.test(line[j])) j++;
        const word = line.slice(i, j);
        // attribute? preceded by `.`
        const isAttr = i > 0 && line[i - 1] === '.';
        // look-ahead for `=` (assignment / kwarg) or `(` (call)
        let k = j; while (k < line.length && line[k] === ' ') k++;
        const followedByCall   = line[k] === '(';
        const followedByAssign = line[k] === '=' && line[k + 1] !== '=';

        let cls = '';
        if (word === 'self' || word === 'cls') cls = 'tk-self';
        else if (PY_KW.has(word)) cls = 'tk-kw';
        else if (PY_BI.has(word)) cls = 'tk-bi';
        else if (isAttr) cls = followedByCall ? 'tk-fn' : '';
        else if (/^[A-Z]/.test(word)) cls = 'tk-cls';
        else if (followedByCall) cls = 'tk-fn';
        // mark unknown if we have a definitions list and this identifier
        // is not in it (and isn't an assignment target / kwarg / attribute)
        if (defined && !isAttr && !followedByAssign &&
            !PY_KW.has(word) && !PY_BI.has(word) &&
            word !== 'self' && word !== 'cls' && !defined.has(word) &&
            !PY_DUNDERS.has(word)) {
          cls = (cls + ' tk-unk').trim();
        }
        buf += cls ? `<span class="${cls}">${word}</span>` : word;
        i = j; continue;
      }
      if (/[+\-*/%=<>!&|^~]/.test(ch)) {
        buf += `<span class="tk-op">${escHtml(ch)}</span>`; i++; continue;
      }
      buf += escHtml(ch); i++;
    }
    out += buf + (li < lines.length - 1 ? '\n' : '');
  }
  return out;
}

function renderHighlight() {
  const code = src.value;
  const defined = getDefinedNames(code);   // null if wildcard import present
  hl.innerHTML = tokenizePython(code, defined) + '\n';
  ph.style.display = code.length === 0 ? 'block' : 'none';
  renderGutter();
  updateCursorPos();
}

function renderGutter() {
  const code = src.value;
  const lines = code.split('\n');
  const n = Math.max(1, lines.length);
  let buf = '';
  for (let i = 1; i <= n; i++) {
    buf += `<div class="gln" data-ln="${i}"><span class="bp"></span><span>${i}</span></div>`;
  }
  gut.innerHTML = buf;
}

function syncScroll() {
  const pre = hl.parentElement; // <pre class="hl">
  pre.scrollTop = src.scrollTop;
  pre.scrollLeft = src.scrollLeft;
  gut.scrollTop = src.scrollTop;
}

function updateCursorPos() {
  const v = src.value; const p = src.selectionStart || 0;
  const before = v.slice(0, p);
  const lines = before.split('\n');
  const ln = lines.length;
  const col = lines[lines.length - 1].length + 1;
  document.getElementById('stPos').textContent = `Ln ${ln}, Col ${col}`;
  // highlight active gutter
  document.querySelectorAll('.gln.active').forEach(g => g.classList.remove('active'));
  const gl = gut.children[ln - 1]; if (gl) gl.classList.add('active');
}

src.addEventListener('input', () => {
  dirty(); renderHighlight();
  // keep the active file's in-memory buffer in sync so persistence
  // captures uncommitted edits on the next debounced flush
  const f = files.find(x => x.id === activeId);
  if (f) { f.content = src.value; persistFiles(); }
});
src.addEventListener('scroll', syncScroll);
src.addEventListener('keyup', updateCursorPos);
src.addEventListener('click', updateCursorPos);
src.addEventListener('focus', () => { if (isTouch()) openMobileKbd(); });

/* Tab key: insert 4 spaces, smart Enter: keep indent */
src.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    insertAtCursor('    ');
  } else if (e.key === 'Enter') {
    // smart indent
    const p = src.selectionStart;
    const before = src.value.slice(0, p);
    const lineStart = before.lastIndexOf('\n') + 1;
    const curLine = before.slice(lineStart);
    const indent = curLine.match(/^[ \t]*/)[0];
    const extra = /[:({\[]\s*$/.test(curLine) ? '    ' : '';
    e.preventDefault();
    insertAtCursor('\n' + indent + extra);
  } else if (e.ctrlKey && (e.key === 'Enter' || e.key === 'r')) {
    e.preventDefault(); runCode();
  } else if (e.ctrlKey && (e.key === '`' || e.key === ';')) {
    e.preventDefault(); toggleTerminal();
  } else if (e.ctrlKey && (e.key === 's')) {
    e.preventDefault(); saveFile();
  } else if (e.ctrlKey && e.shiftKey && (e.key === 'F' || e.key === 'f')) {
    e.preventDefault(); formatBasic();
  }
});

function insertAtCursor(text) {
  const start = src.selectionStart; const end = src.selectionEnd;
  src.value = src.value.slice(0, start) + text + src.value.slice(end);
  const pos = start + text.length;
  src.setSelectionRange(pos, pos);
  dirty(); renderHighlight();
  src.dispatchEvent(new Event('scroll'));
  syncScroll();
}

function deleteAtCursor() {
  const start = src.selectionStart; const end = src.selectionEnd;
  if (start === end && start > 0) {
    src.value = src.value.slice(0, start - 1) + src.value.slice(end);
    src.setSelectionRange(start - 1, start - 1);
  } else {
    src.value = src.value.slice(0, start) + src.value.slice(end);
    src.setSelectionRange(start, start);
  }
  dirty(); renderHighlight();
}

/* dirty / clean */
function dirty() { filePill.classList.remove('clean'); filePill.classList.add('dirty'); markActiveTreeDirty(); }
function clean() { filePill.classList.remove('dirty'); filePill.classList.add('clean'); markActiveTreeDirty(false); }
function markActiveTreeDirty(d = true) {
  const a = document.querySelector('.tree-item.active');
  if (a) a.classList.toggle('dirty', d);
}

/* ──────────────────────────────────────────────────────────────
   FORMAT (very basic: trim trailing whitespace + ensure final \n)
   ────────────────────────────────────────────────────────────── */
/* find the position of an unquoted, non-comment trailing `;` cluster on a line,
   so we can strip it without touching `;` inside strings. */
function stripTrailingSemis(line) {
  let str = null; let lastSemi = -1; let firstCommentAt = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (str) {
      if (c === '\\') { i++; continue; }
      if (c === str) str = null;
      continue;
    }
    if (c === '#') { firstCommentAt = i; break; }
    if (c === '"' || c === "'") { str = c; continue; }
    if (c === ';') lastSemi = i;
    else if (c !== ' ' && c !== '\t') lastSemi = -1; // not trailing anymore
  }
  const cutEnd = firstCommentAt === -1 ? line.length : firstCommentAt;
  if (lastSemi === -1 || lastSemi >= cutEnd) return line;
  // walk back from cutEnd-1, strip trailing whitespace + `;` cluster
  let end = cutEnd;
  while (end > 0 && /[;\s]/.test(line[end - 1])) end--;
  const tail = firstCommentAt === -1 ? '' : line.slice(firstCommentAt);
  const head = line.slice(0, end);
  // preserve a single space before an inline comment, if any
  return tail ? head + (head ? '  ' : '') + tail : head;
}

/* Apply formatting transforms; return new buffer (or null if unchanged). */
function formatBuffer(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const out = lines.map(ln => stripTrailingSemis(ln).replace(/[ \t]+$/, ''));
  let v = out.join('\n').replace(/\n{3,}/g, '\n\n');
  if (v && !v.endsWith('\n')) v += '\n';
  return v === raw ? null : v;
}

/* Run formatter in-place. Returns true if buffer changed. */
function applyFormat({ silent = false } = {}) {
  const raw = src.value;
  const v = formatBuffer(raw);
  if (v === null) { if (!silent) toast('Already formatted', 'ok'); return false; }
  const oldPos = src.selectionStart;
  src.value = v;
  const np = Math.min(oldPos, v.length);
  src.setSelectionRange(np, np);
  renderHighlight();
  return true;
}

/* Press Format → scan, open Problems panel with the findings.
   User chooses what to fix from the panel. */
function formatBasic() {
  const issues = detectIssues();
  lastIssues = issues;
  renderProblems(issues);
  if (!issues.length) {
    toast('Already clean', 'ok');
    flash(document.getElementById('btnFormat'));
    return;
  }
  if (!panels.problems.opened) openPanel('problems');
  const fixables = issues.filter(i => i.fixable).length;
  const manual   = issues.length - fixables;
  flash(document.getElementById('btnFormat'));
  if (fixables && manual) toast(`${fixables} auto-fixable · ${manual} manual`, 'warn');
  else if (fixables) toast(`${fixables} issue${fixables===1?'':'s'} ready to fix`, 'warn');
  else toast(`${manual} issue${manual===1?'':'s'} — manual review`, 'warn');
}

function flash(el) { if (!el) return; el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }

/* ──────────────────────────────────────────────────────────────
   FILE MANAGER (in-memory)
   ────────────────────────────────────────────────────────────── */
const files = []; // { id, name, content, source: 'local'|'gitlab', path?, sha? }
let activeId = null;

function newFile() {
  const name = prompt('New file name', `script_${files.length + 1}.py`); if (!name) return;
  const f = { id: cryptoId(), name, content: '', source: 'local' };
  files.push(f); selectFile(f.id); renderTree(); persistFiles();
  toast(`Created ${name}`, 'ok');
}
function cryptoId() {
  return 'f_' + Math.random().toString(36).slice(2, 10);
}
function selectFile(id) {
  const cur = files.find(f => f.id === activeId);
  if (cur) cur.content = src.value;
  const f = files.find(f => f.id === id); if (!f) return;
  activeId = id;
  src.value = f.content || '';
  fileLabel.textContent = f.name;
  document.getElementById('bcFile').textContent = f.name;
  document.getElementById('bcPath').textContent =
    f.source === 'gitlab' ? 'gitlab' :
    f.source === 'dir'    ? (dirHandle?.name || 'folder') : 'local';
  renderHighlight();
  // Mark dirty if content has diverged from original (e.g. restored unsaved edits)
  if (f.originalContent !== undefined && f.originalContent !== f.content) dirty(); else clean();
  renderTree(); persistFiles();
}
async function saveFile() {
  const f = files.find(x => x.id === activeId);
  if (!f) { newFile(); return; }
  f.content = src.value;
  if (f.source === 'dir' && f.handle) {
    try {
      const w = await f.handle.createWritable();
      await w.write(f.content); await w.close();
      f.originalContent = f.content;
    } catch (e) { toast(`Save failed: ${e.message}`, 'err'); return; }
  } else {
    f.originalContent = f.content;
  }
  clean(); persistFiles();
  flash(document.getElementById('btnSave'));
  toast(`Saved ${f.name}`, 'ok');
}
function deleteFile(id) {
  const i = files.findIndex(f => f.id === id); if (i < 0) return;
  const f = files[i]; files.splice(i, 1);
  if (activeId === id) {
    activeId = null; src.value = '';
    fileLabel.textContent = 'untitled.py';
    document.getElementById('bcFile').textContent = 'untitled.py';
  }
  renderHighlight(); renderTree(); persistFiles();
  toast(`Deleted ${f.name}`);
}
function renderTree() {
  const tree = document.getElementById('fileTree');
  const parts = [];

  /* — Open Files section (always shown) — */
  if (files.length) {
    const items = files.map(f => {
      const isPy = f.name.endsWith('.py');
      const ico = f.source === 'gitlab' ? 'i-gitlab'
                : f.source === 'dir'    ? 'i-folder-open'
                : isPy                  ? 'i-py' : 'i-doc';
      const dirty = (f.originalContent !== undefined && f.originalContent !== f.content);
      return `<div class="tree-item ${isPy ? 'py' : ''} ${f.id === activeId ? 'active' : ''} ${dirty ? 'dirty' : ''}"
                   data-id="${f.id}" onclick="selectFile('${f.id}')">
        <svg><use href="#${ico}"/></svg>
        <span class="name">${escHtml(f.name)}</span>
        <span class="mod-dot"></span>
      </div>`;
    }).join('');
    parts.push(`<div class="tree-section">${items}</div>`);
  } else {
    parts.push(`<div class="tree-empty"><div>No files open.</div>
      <div style="margin-top:8px" class="hint">Create a new file, open a folder, or load a repo from GitLab.</div></div>`);
  }

  /* — Folder section (when a local folder is open) — */
  if (dirHandle) {
    parts.push(`<div class="tree-section">
      <div class="tree-section-head">
        <span class="tsh-label" title="${esc(dirHandle.name)}">${esc(dirHandle.name)}</span>
        <button class="tsh-btn" data-tip="Refresh folder" onclick="refreshDirTree()"><svg><use href="#i-undo"/></svg></button>
        <button class="tsh-btn" data-tip="Close folder" onclick="closeDir()"><svg><use href="#i-close"/></svg></button>
      </div>
      ${dirNeedsPerm
        ? `<div class="tree-empty" style="text-align:left">
            <div style="color:var(--text)">Folder permission lost on refresh.</div>
            <button class="seg-item" style="margin-top:8px" onclick="resumeDirAccess()">
              <svg><use href="#i-power"/></svg> Reconnect
            </button>
          </div>`
        : dirTreeCache.map(t => {
            const isPy = t.name.endsWith('.py');
            const open = files.find(f => f.source === 'dir' && f.path === t.path);
            return `<div class="tree-item ${isPy ? 'py' : ''} ${open && open.id === activeId ? 'active' : ''}"
                         onclick="openDirFile('${esc(t.path)}')">
              <svg><use href="#i-${isPy ? 'py' : 'doc'}"/></svg>
              <span class="name" title="${esc(t.path)}">${esc(t.name)}</span>
            </div>`;
          }).join('')
      }
    </div>`);
  }

  /* — GitLab repo section (when a repo is open) — */
  if (session.token && session.currentRepo) {
    parts.push(`<div class="tree-section">
      <div class="tree-section-head">
        <span class="tsh-label" title="${esc(session.currentRepo.fullPath)}">
          <svg style="vertical-align:-2px"><use href="#i-gitlab"/></svg>
          ${esc(session.currentRepo.name)}
        </span>
        <button class="tsh-btn" data-tip="Browse files" onclick="openFileTree('')"><svg><use href="#i-folder-open"/></svg></button>
        <button class="tsh-btn" data-tip="Close repository" onclick="closeRepo()"><svg><use href="#i-close"/></svg></button>
      </div>
      <div class="tree-empty" style="text-align:left;padding:6px 14px;font-size:10.5px">
        Branch · <b style="color:var(--purple)">${esc(session.currentBranch || '?')}</b>
      </div>
    </div>`);
  }

  tree.innerHTML = parts.join('');
}

/* ──────────────────────────────────────────────────────────────
   PANEL ADAPTIVE PLACEMENT — terminal / problems
   ────────────────────────────────────────────────────────────── */
const workspace  = document.getElementById('workspace');
const bottomBody = document.getElementById('bottomBody');
const bottomTabs = document.getElementById('bTabs');
const rightBody  = document.getElementById('rightBody');

const panels = { terminal: { where: null, opened: false }, problems: { where: null, opened: false } };
// where: 'bottom' | 'right' | null

const PANEL_DEF = {
  terminal: { icon: 'i-terminal', label: 'Terminal' },
  problems: { icon: 'i-problems', label: 'Problems' },
};

/* ── Slot model ──
   Both `bottom` and `right` slots have an ordered tab list. A panel can
   live in at most one slot. Drag/drop reorders within a slot and moves
   between slots. */
const slotOrder = { bottom: [], right: [] };
const slotActive = { bottom: null, right: null };

const rTabs = document.getElementById('rTabs');
const rightPanelEl  = document.getElementById('rightPanel');
const bottomPanelEl = document.getElementById('bottomPanel');

function panelSlot(name) { return panels[name].where; }
function isPanelOpen(name) { return !!panels[name].where; }

function mountInto(name, slot, indexOrEnd) {
  const node = panelNodes[name];
  node.style.display = '';
  if (slot === 'bottom') bottomBody.appendChild(node);
  else if (slot === 'right') rightBody.appendChild(node);
  panels[name].where = slot;
  panels[name].opened = true;
  // maintain slot order list
  const list = slotOrder[slot];
  if (!list.includes(name)) {
    if (typeof indexOrEnd === 'number' && indexOrEnd >= 0 && indexOrEnd <= list.length) {
      list.splice(indexOrEnd, 0, name);
    } else {
      list.push(name);
    }
  }
  if (!slotActive[slot]) slotActive[slot] = name;
}

function unmount(name) {
  const node = panelNodes[name];
  if (node.parentElement) node.parentElement.removeChild(node);
  const oldSlot = panels[name].where;
  panels[name].where = null;
  panels[name].opened = false;
  if (oldSlot) {
    const list = slotOrder[oldSlot];
    const i = list.indexOf(name); if (i >= 0) list.splice(i, 1);
    if (slotActive[oldSlot] === name) slotActive[oldSlot] = list[0] || null;
  }
}

function openPanel(name) {
  if (isPanelOpen(name)) { setActive(name); focusPanel(name); return; }
  // Adaptive placement
  let slot;
  if (!slotOrder.bottom.length) slot = 'bottom';
  else if (!slotOrder.right.length) slot = 'right';
  else slot = 'right';
  mountInto(name, slot);
  slotActive[slot] = name;
  applyLayout(); rebuildTabs(); flashJustOpened(); focusPanel(name);
  saveLayout();
}
function closePanel(name) {
  if (!isPanelOpen(name)) return;
  unmount(name);
  applyLayout(); rebuildTabs();
  saveLayout();
}
function togglePanel(name) { isPanelOpen(name) ? closePanel(name) : openPanel(name); }
function focusPanel(name) {
  if (name === 'terminal') panelNodes.terminal.querySelector('.term-in')?.focus();
}
function setActive(name) {
  const slot = panels[name].where; if (!slot) return;
  slotActive[slot] = name; rebuildTabs(); focusPanel(name); saveLayout();
}
function flashJustOpened() {
  bottomPanelEl.classList.remove('just-opened');
  rightPanelEl.classList.remove('just-opened');
  void bottomPanelEl.offsetWidth; void rightPanelEl.offsetWidth;
  if (slotOrder.bottom.length) bottomPanelEl.classList.add('just-opened');
  if (slotOrder.right.length)  rightPanelEl.classList.add('just-opened');
}

/* Move a panel to a target slot at an optional index. Swaps slots when needed. */
function movePanel(name, targetSlot, targetIndex) {
  if (!isPanelOpen(name)) return;
  const fromSlot = panels[name].where;
  if (fromSlot === targetSlot) {
    // reorder within slot
    const list = slotOrder[targetSlot];
    const i = list.indexOf(name); if (i < 0) return;
    list.splice(i, 1);
    const newIdx = (typeof targetIndex === 'number')
      ? Math.max(0, Math.min(targetIndex, list.length))
      : list.length;
    list.splice(newIdx, 0, name);
  } else {
    unmount(name);
    mountInto(name, targetSlot, targetIndex);
  }
  slotActive[targetSlot] = name;
  applyLayout(); rebuildTabs(); focusPanel(name); saveLayout();
}

/* Move active panel of a slot to the other slot (used by the dock buttons). */
function dockActiveTo(fromSlot, toSlot) {
  const active = slotActive[fromSlot]; if (!active) return;
  movePanel(active, toSlot);
}

function applyLayout() {
  const bottomOpen = slotOrder.bottom.length > 0;
  const rightOpen  = slotOrder.right.length > 0;
  workspace.setAttribute('data-bottom', bottomOpen ? 'open' : 'closed');
  workspace.setAttribute('data-right',  rightOpen  ? 'open' : 'closed');
  document.getElementById('btnTerm').classList.toggle('active',     isPanelOpen('terminal'));
  document.getElementById('btnProblems').classList.toggle('active', isPanelOpen('problems'));
}

/* Build a tab DOM node. Wires click → setActive, X → close, drag handlers. */
function buildTab(name, slot, isActive) {
  const def = PANEL_DEF[name];
  const tab = document.createElement('div');
  tab.className = 'ptab' + (isActive ? ' active' : '');
  tab.draggable = true;
  tab.dataset.panel = name;
  tab.dataset.slot  = slot;
  tab.innerHTML = `
    <svg><use href="#${def.icon}"/></svg>
    <span>${def.label}</span>
    <span class="tab-close" data-tip="Close"><svg><use href="#i-close"/></svg></span>`;
  tab.addEventListener('click', (e) => {
    if (e.target.closest('.tab-close')) return;
    setActive(name);
  });
  tab.querySelector('.tab-close').addEventListener('click', (e) => {
    e.stopPropagation(); closePanel(name);
  });
  attachDragHandlers(tab);
  return tab;
}

function rebuildTabs() {
  ['bottom', 'right'].forEach(slot => {
    const strip = slot === 'bottom' ? bottomTabs : rTabs;
    const spacer = strip.querySelector('.ph-spacer');
    [...strip.querySelectorAll('.ptab')].forEach(n => n.remove());
    const active = activeIn(slot);
    slotOrder[slot].forEach(name => {
      const tab = buildTab(name, slot, name === active);
      strip.insertBefore(tab, spacer);
    });
    // body display: show only active panel
    Object.keys(panels).forEach(name => {
      if (panels[name].where === slot) {
        panelNodes[name].style.display = (name === active) ? '' : 'none';
      }
    });
  });

  // dock buttons
  document.getElementById('rDock').onclick = () => dockActiveTo('right', 'bottom');
  document.getElementById('bDock').onclick = () => dockActiveTo('bottom', 'right');
  document.getElementById('rClose').onclick = () => { const k = activeIn('right'); if (k) closePanel(k); };
  document.getElementById('bClose').onclick = () => { const k = activeIn('bottom'); if (k) closePanel(k); };
}

function activeIn(slot) {
  const list = slotOrder[slot]; if (!list.length) return null;
  if (slotActive[slot] && list.includes(slotActive[slot])) return slotActive[slot];
  return list[0];
}

/* ── Drag and drop ── */
let dragName = null;
function attachDragHandlers(tab) {
  tab.addEventListener('dragstart', (e) => {
    dragName = tab.dataset.panel;
    try { e.dataTransfer.setData('text/plain', dragName); } catch {}
    e.dataTransfer.effectAllowed = 'move';
    tab.classList.add('dragging');
  });
  tab.addEventListener('dragend', () => {
    dragName = null;
    document.querySelectorAll('.dragging').forEach(n => n.classList.remove('dragging'));
    clearDropMarkers();
  });
  tab.addEventListener('dragover', (e) => {
    if (!dragName) return;
    e.preventDefault();
    const r = tab.getBoundingClientRect();
    const before = (e.clientX - r.left) < r.width / 2;
    clearDropMarkers();
    tab.classList.add(before ? 'drop-before' : 'drop-after');
  });
  tab.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!dragName) return;
    const slot = tab.dataset.slot;
    const list = slotOrder[slot];
    const targetIdx = list.indexOf(tab.dataset.panel);
    const r = tab.getBoundingClientRect();
    const before = (e.clientX - r.left) < r.width / 2;
    let insertAt = before ? targetIdx : targetIdx + 1;
    // when reordering in the same slot, adjust for removal of the source
    if (panels[dragName].where === slot) {
      const fromIdx = list.indexOf(dragName);
      if (fromIdx >= 0 && fromIdx < insertAt) insertAt--;
    }
    movePanel(dragName, slot, insertAt);
    clearDropMarkers();
  });
}
function clearDropMarkers() {
  document.querySelectorAll('.drop-before,.drop-after,.drop-target').forEach(n => {
    n.classList.remove('drop-before', 'drop-after', 'drop-target');
  });
}
/* Allow dropping onto the slot tabstrip (append) or body (move to that slot). */
function attachSlotDropTargets() {
  const targets = [
    { el: bottomTabs,     slot: 'bottom', mode: 'append' },
    { el: rTabs,          slot: 'right',  mode: 'append' },
    { el: bottomBody,     slot: 'bottom', mode: 'append' },
    { el: rightBody,      slot: 'right',  mode: 'append' },
    { el: bottomPanelEl,  slot: 'bottom', mode: 'append' },
    { el: rightPanelEl,   slot: 'right',  mode: 'append' },
  ];
  targets.forEach(({ el, slot }) => {
    el.addEventListener('dragover', (e) => {
      if (!dragName) return;
      // only react if not on a tab (tabs handle their own)
      if (e.target.closest('.ptab')) return;
      e.preventDefault();
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget || !el.contains(e.relatedTarget)) el.classList.remove('drop-target');
    });
    el.addEventListener('drop', (e) => {
      if (!dragName) return;
      if (e.target.closest('.ptab')) return;
      e.preventDefault();
      movePanel(dragName, slot, slotOrder[slot].length);
      clearDropMarkers();
    });
  });
}

/* ── Persist + restore layout ── */
function saveLayout() {
  prefs.layout = {
    bottom: [...slotOrder.bottom],
    right:  [...slotOrder.right],
    activeBottom: slotActive.bottom,
    activeRight:  slotActive.right,
  };
  savePrefs();
}
function restoreLayout() {
  const L = prefs.layout; if (!L) return;
  (L.bottom || []).forEach(name => { if (panels[name]) mountInto(name, 'bottom'); });
  (L.right  || []).forEach(name => { if (panels[name]) mountInto(name, 'right'); });
  if (L.activeBottom && slotOrder.bottom.includes(L.activeBottom)) slotActive.bottom = L.activeBottom;
  if (L.activeRight  && slotOrder.right.includes(L.activeRight))   slotActive.right  = L.activeRight;
}

/* ──────────────────────────────────────────────────────────────
   TERMINAL — Pyodide-backed REPL + shell helpers + js eval
   ────────────────────────────────────────────────────────────── */
const panelNodes = {
  terminal: (() => {
    const div = document.createElement('div');
    div.className = 'term';
    div.innerHTML = `
  <div class="term-out" id="termOut"></div>
  <div class="term-in-row">
    <svg><use href="#i-terminal"/></svg>
    <span class="term-mode" id="termMode">py</span>
    <input class="term-in" id="termIn" type="text" autocomplete="off" autocorrect="off" spellcheck="false" placeholder="python · type :help for shortcuts"/>
  </div>`;
    return div;
  })(),
  problems: (() => {
    const div = document.createElement('div');
    div.className = 'problems'; div.id = 'problemsList';
    div.innerHTML = `<div class="prob-empty">No problems detected.</div>`;
    return div;
  })(),
};

/* Pyodide loader (lazy) */
let pyodideReadyPromise = null;
let pyodide = null;
let runtimeState = 'cold';

function setRuntime(state, info) {
  runtimeState = state;
  const st = document.getElementById('stRuntime');
  const bc = document.getElementById('rtBreadcrumb');
  const rt = document.getElementById('rtState');
  const ver = document.getElementById('rtVer');
  st.classList.remove('loading', 'err');
  if (state === 'loading') { st.classList.add('loading'); st.innerHTML = `<span class="spin" style="width:9px;height:9px;border-width:1.5px"></span> Pyodide loading…`; bc.textContent = 'Pyodide loading'; rt.textContent = 'loading'; rt.style.color = 'var(--amber)'; }
  else if (state === 'ready') { st.innerHTML = `<svg><use href="#i-power"/></svg> Pyodide ready`; bc.textContent = `Pyodide ${info || ''}`.trim(); rt.textContent = 'ready'; rt.style.color = 'var(--green)'; if (info) ver.textContent = info; }
  else if (state === 'running') { st.innerHTML = `<span class="spin" style="width:9px;height:9px;border-width:1.5px"></span> running`; bc.textContent = 'running'; rt.textContent = 'running'; rt.style.color = 'var(--blue)'; }
  else if (state === 'error') { st.classList.add('err'); st.innerHTML = `<svg><use href="#i-problems"/></svg> ${info || 'runtime error'}`; bc.textContent = 'runtime error'; rt.textContent = 'error'; rt.style.color = 'var(--accent)'; }
  else if (state === 'cold') { st.innerHTML = `<svg><use href="#i-power"/></svg> Pyodide cold`; bc.textContent = 'Pyodide cold'; rt.textContent = 'cold'; rt.style.color = 'var(--dim)'; }
}

async function loadPyodideOnce() {
  if (pyodideReadyPromise) return pyodideReadyPromise;
  setRuntime('loading');
  pyodideReadyPromise = (async () => {
    try {
      // load script
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js';
        s.onload = resolve; s.onerror = () => reject(new Error('Failed to load Pyodide script'));
        document.head.appendChild(s);
      });
      // eslint-disable-next-line no-undef
      pyodide = await loadPyodide({
        stdout: (s) => termWrite(s, 't-out'),
        stderr: (s) => termWrite(s, 't-err'),
      });
      const v = pyodide.runPython('import sys; sys.version.split()[0]');
      setRuntime('ready', v);
      return pyodide;
    } catch (e) {
      setRuntime('error', 'load failed');
      throw e;
    }
  })();
  return pyodideReadyPromise;
}

function termOut() { return panelNodes.terminal.querySelector('#termOut'); }
function termIn() { return panelNodes.terminal.querySelector('#termIn'); }
function termModeEl() { return panelNodes.terminal.querySelector('#termMode'); }
let termMode = 'py'; // 'py' | 'js' | 'sh'
function setTermMode(m) {
  termMode = m;
  const el = termModeEl(); el.textContent = m;
  el.className = 'term-mode' + (m === 'js' ? ' js' : m === 'sh' ? ' sh' : '');
  termIn().setAttribute('placeholder',
    m === 'py' ? 'python · type :help for shortcuts'
      : m === 'js' ? 'javascript · runs in this tab'
        : 'shell · ls · cat <file> · clear');
}

function termWrite(text, cls = 't-out') {
  const out = termOut();
  const lines = String(text).split('\n');
  const last = lines.pop();
  lines.forEach(l => {
    const d = document.createElement('div'); d.className = 't-line ' + cls; d.textContent = l; out.appendChild(d);
  });
  if (last) {
    const d = document.createElement('div'); d.className = 't-line ' + cls; d.textContent = last; out.appendChild(d);
  }
  out.scrollTop = out.scrollHeight;
}
function termPromptLine(text, mode = termMode) {
  const out = termOut();
  const d = document.createElement('div'); d.className = 't-line';
  d.innerHTML = `<span class="t-prompt">${mode === 'js' ? 'js' : mode === 'sh' ? '$' : '»'}</span> <span class="t-py">${escHtml(text)}</span>`;
  out.appendChild(d); out.scrollTop = out.scrollHeight;
}
function termClear() { termOut().innerHTML = ''; }

/* run python code — REPL-aware so single expressions echo their value */
async function runPython(code, opts = {}) {
  if (!pyodide) await loadPyodideOnce();
  setRuntime('running');
  try {
    if (opts.repl) {
      // single-expression → eval+print; statement → exec
      const wrapped = `
import ast, traceback
_src = ${JSON.stringify(code)}
try:
_tree = ast.parse(_src, mode='exec')
if len(_tree.body) == 1 and isinstance(_tree.body[0], ast.Expr):
    _v = eval(compile(ast.Expression(_tree.body[0].value), '<repl>', 'eval'))
    if _v is not None: print(repr(_v))
else:
    exec(compile(_tree, '<repl>', 'exec'), globals())
except SystemExit:
pass
except BaseException:
traceback.print_exc()
`;
      await pyodide.runPythonAsync(wrapped);
    } else {
      await pyodide.runPythonAsync(code);
    }
    setRuntime('ready', document.getElementById('rtVer').textContent);
  } catch (e) {
    termWrite(String(e.message || e), 't-err');
    setRuntime('ready', document.getElementById('rtVer').textContent);
  }
}

/* Shell-ish commands available in py mode if line starts with ":" or in sh mode */
async function runShell(line) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const args = rest.join(' ');
  switch (cmd) {
    case 'clear': case 'cls': termClear(); break;
    case 'help': case '?':
      termWrite('PyPad terminal — quick reference', 't-info');
      termWrite('  :py | :js | :sh           switch mode', 't-dim');
      termWrite('  :run                       execute current editor', 't-dim');
      termWrite('  :pip install <name>        load a python package', 't-dim');
      termWrite('  :ls | :cat <file>          inspect in-memory files', 't-dim');
      termWrite('  :clear                     clear terminal', 't-dim');
      termWrite('  :time <expr>               eval and time a python expr', 't-dim');
      break;
    case 'ls':
      if (!files.length) termWrite('(no files in workspace)', 't-dim');
      else files.forEach(f => termWrite(`  ${f.name}  ·  ${f.content.length} bytes  ·  ${f.source}`, 't-out'));
      break;
    case 'cat': {
      const f = files.find(f => f.name === args);
      if (!f) termWrite(`cat: ${args}: not found`, 't-err');
      else termWrite(f.content, 't-out');
      break;
    }
    case 'pip': {
      const sub = rest[0]; const pkg = rest.slice(1).join(' ');
      if (sub !== 'install' || !pkg) { termWrite('usage: :pip install <name>', 't-dim'); break; }
      if (!pyodide) await loadPyodideOnce();
      try {
        termWrite(`fetching ${pkg}…`, 't-info');
        await pyodide.loadPackage(pkg.split(/\s+/));
        termWrite(`installed ${pkg}`, 't-info');
      } catch (e) {
        // fall back to micropip
        try {
          await pyodide.loadPackage('micropip');
          await pyodide.runPythonAsync(`import micropip; await micropip.install(${JSON.stringify(pkg)})`);
          termWrite(`installed ${pkg} (micropip)`, 't-info');
        } catch (e2) {
          termWrite(`install failed: ${e2.message || e2}`, 't-err');
        }
      }
      break;
    }
    case 'run': await runCode(); break;
    case 'time': {
      const expr = args;
      if (!expr) { termWrite('usage: :time <expr>', 't-dim'); break; }
      const code = `import time; _t = time.perf_counter(); _v = (${expr}); print(_v); print(f"-- {(time.perf_counter()-_t)*1000:.3f} ms")`;
      await runPython(code);
      break;
    }
    case 'py': setTermMode('py'); break;
    case 'js': setTermMode('js'); break;
    case 'sh': setTermMode('sh'); break;
    default: termWrite(`unknown command: ${cmd} — try :help`, 't-err');
  }
}

async function termSubmit(raw) {
  if (!raw.trim()) return;
  history.push(raw); histIdx = history.length;
  termPromptLine(raw);
  if (raw.startsWith(':')) { await runShell(raw.slice(1)); return; }
  if (termMode === 'js') {
    try {
      // eslint-disable-next-line no-new-func
      const result = (new Function('return (' + raw + ')'))();
      termWrite(formatJs(result), 't-out');
    } catch (e1) {
      try {
        const result = (new Function(raw))();
        if (result !== undefined) termWrite(formatJs(result), 't-out');
      } catch (e2) {
        termWrite(String(e2.message || e2), 't-err');
      }
    }
    return;
  }
  if (termMode === 'sh') { await runShell(raw); return; }
  // py mode — REPL-style execution
  await runPython(raw, { repl: true });
}

function formatJs(v) {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'object') { try { return JSON.stringify(v, null, 2); } catch { return String(v); } }
  return String(v);
}

/* wire input */
panelNodes.terminal.querySelector('#termIn').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const v = e.target.value; e.target.value = '';
    termSubmit(v);
  } else if (e.key === 'ArrowUp') {
    // history previous (simple)
    if (histIdx > 0) { histIdx--; e.target.value = history[histIdx]; }
  } else if (e.key === 'ArrowDown') {
    if (histIdx < history.length - 1) { histIdx++; e.target.value = history[histIdx]; }
    else { histIdx = history.length; e.target.value = ''; }
  }
});
const history = []; let histIdx = 0;

/* greeting */
function termGreeting() {
  termWrite('PyPad terminal — ' + new Date().toLocaleString(), 't-info');
  termWrite('Type :help for shortcuts · :py · :js · :sh', 't-dim');
}
termGreeting();

/* ──────────────────────────────────────────────────────────────
   RUN BUTTON
   ────────────────────────────────────────────────────────────── */
async function runCode() {
  if (!src.value.trim()) { toast('Nothing to run', 'warn'); return; }

  // Open terminal first so output goes to the bottom slot
  if (!panels.terminal.opened) openPanel('terminal');

  // Pre-flight: scan + auto-fix + show what's left (problems lands at right)
  const issues = detectIssues();
  const fixables  = issues.filter(i => i.fixable);
  const unfixable = issues.filter(i => !i.fixable);
  if (issues.length) {
    lastIssues = issues;
    renderProblems(issues);
    if (!panels.problems.opened) openPanel('problems');
    if (fixables.length) {
      const kinds = new Set(fixables.map(i => i.kind));
      const newCode = applyFixesForKinds(kinds);
      if (commitBuffer(newCode)) flash(document.getElementById('btnFormat'));
      lastIssues = detectIssues();
      renderProblems(lastIssues);
    }
    if (unfixable.length) {
      toast(`${unfixable.length} manual issue${unfixable.length===1?'':'s'} — running anyway`, 'warn');
    }
  }

  const code = src.value;
  flash(document.getElementById('btnRun'));
  termWrite(`──── run @ ${new Date().toLocaleTimeString()} ────`, 't-amber');
  const btn = document.getElementById('btnRun');
  btn.classList.add('running');
  try {
    await runPython(code);
  } finally {
    btn.classList.remove('running');
  }
}

/* ──────────────────────────────────────────────────────────────
   PROBLEMS — detection + vibrant panel with per-issue fix buttons
   ────────────────────────────────────────────────────────────── */
let lastIssues = [];

/* find position of trailing `;` (outside strings/comments). -1 if none. */
function findTrailingSemiCol(line) {
  let str = null; let lastSemi = -1; let firstComment = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (str) {
      if (c === '\\') { i++; continue; }
      if (c === str) str = null; continue;
    }
    if (c === '#') { firstComment = i; break; }
    if (c === '"' || c === "'") { str = c; continue; }
    if (c === ';') lastSemi = i;
    else if (c !== ' ' && c !== '\t') lastSemi = -1;
  }
  const end = firstComment === -1 ? line.length : firstComment;
  return (lastSemi !== -1 && lastSemi < end) ? lastSemi : -1;
}

/* Full issue scan. Returns enriched issue objects. */
function detectIssues() {
  const code = src.value;
  const lines = code.split('\n');
  const out = [];
  let id = 0;
  lines.forEach((line, i) => {
    const ln = i + 1;
    const s = stripStringsAndComments(line);

    if (/\t/.test(line)) {
      out.push({ id: ++id, kind: 'tabs', sev: 'warn', line: ln, rule: 'W191', msg: 'Tab character — prefer 4 spaces', fixable: true });
    }
    if (/[ \t]+$/.test(line)) {
      out.push({ id: ++id, kind: 'trailing_ws', sev: 'info', line: ln, rule: 'W291', msg: 'Trailing whitespace', fixable: true });
    }
    const semi = findTrailingSemiCol(line);
    if (semi !== -1) {
      out.push({ id: ++id, kind: 'trailing_semi', sev: 'warn', line: ln, col: semi + 1, rule: 'E703', msg: 'Statement ends with a semicolon', fixable: true });
    }
    const im = line.match(/^(\s*)import\s+(\w+)\s*$/);
    if (im) {
      const name = im[2];
      const rest = lines.slice(0, i).concat(lines.slice(i + 1)).join('\n');
      const used = new RegExp('\\b' + name + '\\b').test(rest);
      if (!used) out.push({ id: ++id, kind: 'unused_import', sev: 'warn', line: ln, rule: 'F401', msg: `'${name}' imported but never used`, fixable: true, meta: { name } });
    }
    if (/^\s*def\s+\w+\([^)]*\)\s*(?:->\s*[^:]+)?:\s*$/.test(line)) {
      const next = lines[i + 1] || '';
      if (!/^\s*("""|''')/.test(next)) {
        out.push({ id: ++id, kind: 'missing_doc', sev: 'info', line: ln, rule: 'D103', msg: 'Function is missing a docstring', fixable: false });
      }
    }
    if (/^\s*class\s+[A-Za-z_]\w*(\([^)]*\))?\s*:\s*$/.test(line)) {
      const next = lines[i + 1] || '';
      if (!/^\s*("""|''')/.test(next)) {
        out.push({ id: ++id, kind: 'missing_class_doc', sev: 'info', line: ln, rule: 'D101', msg: 'Class is missing a docstring', fixable: false });
      }
    }
    if (line.length > 120) {
      out.push({ id: ++id, kind: 'long_line', sev: 'info', line: ln, rule: 'E501', msg: `Line too long (${line.length} > 120)`, fixable: false });
    }

    /* ── Extra rules ── */

    // Bare except (no exception class) — swallows everything including SystemExit/KeyboardInterrupt
    if (/^\s*except\s*:\s*$/.test(s)) {
      out.push({ id: ++id, kind: 'bare_except', sev: 'warn', line: ln, rule: 'E722',
        msg: 'Bare except — catch a specific exception class instead', fixable: false });
    }

    // `== None` / `!= None` should be `is None` / `is not None`
    const cmpNone = s.match(/(==|!=)\s*None\b|\bNone\s*(==|!=)/);
    if (cmpNone) {
      out.push({ id: ++id, kind: 'cmp_none', sev: 'warn', line: ln, rule: 'E711',
        msg: "Comparison to None should use 'is' / 'is not'", fixable: false });
    }

    // `== True/False` should be implicit
    const cmpBool = s.match(/(==|!=)\s*(True|False)\b/);
    if (cmpBool) {
      out.push({ id: ++id, kind: 'cmp_bool', sev: 'warn', line: ln, rule: 'E712',
        msg: `Comparison to ${cmpBool[2]} — use truthiness instead`, fixable: false });
    }

    // Mutable default argument: def f(x=[]):  or  ={}, =set()
    const mutDef = s.match(/^\s*(?:async\s+)?def\s+\w+\s*\(([^)]*)\)/);
    if (mutDef) {
      const params = mutDef[1];
      if (/=\s*(\[\s*\]|\{\s*\}|set\(\s*\)|list\(\s*\)|dict\(\s*\))/.test(params)) {
        out.push({ id: ++id, kind: 'mutable_default', sev: 'warn', line: ln, rule: 'B006',
          msg: 'Mutable default argument — use None and assign inside the function', fixable: false });
      }
    }

    // print as a statement (Python 2) — `print "x"` (no parens)
    if (/^\s*print\s+[^(]/.test(s)) {
      out.push({ id: ++id, kind: 'print_statement', sev: 'err', line: ln, rule: 'E999',
        msg: "Missing parentheses in call to 'print'", fixable: false });
    }
  });

  // Whole-file unknown-name detection (NameError-class problems)
  getUnknownNames(code).forEach(u => {
    out.push({ id: ++id, kind: 'unknown_name', sev: 'err',
      line: u.line, col: u.col, rule: 'F821',
      msg: `Undefined name '${u.name}'`, fixable: false });
  });

  if (code.length > 0 && !code.endsWith('\n')) {
    out.push({ id: ++id, kind: 'no_final_nl', sev: 'info', line: lines.length, rule: 'W292', msg: 'No newline at end of file', fixable: true });
  }
  const tripleNL = code.match(/\n{3,}/);
  if (tripleNL) {
    const idx = code.indexOf(tripleNL[0]);
    const ln = code.slice(0, idx).split('\n').length + 1;
    out.push({ id: ++id, kind: 'blank_lines', sev: 'info', line: ln, rule: 'E303', msg: 'Too many consecutive blank lines', fixable: true });
  }
  return out;
}

/* Apply fixes for the issues whose `kind` is in `kinds`. */
function applyFixesForKinds(kinds) {
  let v = src.value.replace(/\r\n/g, '\n');
  if (kinds.has('tabs')) v = v.replace(/\t/g, '    ');
  v = v.split('\n').map(ln => {
    if (kinds.has('trailing_semi')) ln = stripTrailingSemis(ln);
    if (kinds.has('trailing_ws'))  ln = ln.replace(/[ \t]+$/, '');
    return ln;
  }).join('\n');
  if (kinds.has('unused_import')) {
    // remove top-level unused single imports (re-scan against current buffer)
    const lines = v.split('\n');
    const keep = lines.map((line, i) => {
      const m = line.match(/^(\s*)import\s+(\w+)\s*$/);
      if (!m) return line;
      const name = m[2];
      const rest = lines.slice(0, i).concat(lines.slice(i + 1)).join('\n');
      return new RegExp('\\b' + name + '\\b').test(rest) ? line : null;
    }).filter(x => x !== null);
    v = keep.join('\n');
  }
  if (kinds.has('blank_lines')) v = v.replace(/\n{3,}/g, '\n\n');
  if (kinds.has('no_final_nl') && v && !v.endsWith('\n')) v += '\n';
  return v;
}

function commitBuffer(newCode) {
  if (newCode === src.value) return false;
  const oldPos = src.selectionStart;
  src.value = newCode;
  const np = Math.min(oldPos, newCode.length);
  src.setSelectionRange(np, np);
  renderHighlight();
  return true;
}

function fixOne(id) {
  const issue = lastIssues.find(i => i.id === id);
  if (!issue || !issue.fixable) return;
  const before = src.value;
  const newCode = applyFixesForKinds(new Set([issue.kind]));
  const changed = commitBuffer(newCode);
  if (changed) {
    flash(document.getElementById('btnFormat'));
    toast(`Fixed: ${issue.rule}`, 'ok');
  }
  lastIssues = detectIssues();
  renderProblems(lastIssues);
}

function fixAllProblems() {
  const fixables = lastIssues.filter(i => i.fixable);
  if (!fixables.length) { toast('Nothing auto-fixable', 'warn'); return; }
  const kinds = new Set(fixables.map(i => i.kind));
  const newCode = applyFixesForKinds(kinds);
  const changed = commitBuffer(newCode);
  if (changed) {
    flash(document.getElementById('btnFormat'));
    toast(`Fixed ${fixables.length} issue${fixables.length === 1 ? '' : 's'}`, 'ok');
  }
  lastIssues = detectIssues();
  renderProblems(lastIssues);
}

function iconForSev(sev) { return sev === 'err' ? 'i-problems' : sev === 'warn' ? 'i-problems' : 'i-info'; }

function renderProblems(issues) {
  const node = panelNodes.problems;
  const errs  = issues.filter(p => p.sev === 'err').length;
  const warns = issues.filter(p => p.sev === 'warn').length;
  const fixables = issues.filter(p => p.fixable).length;

  document.getElementById('stErrors').innerHTML   = `<svg><use href="#i-problems"/></svg> ${errs}`;
  document.getElementById('stWarnings').innerHTML = `<svg><use href="#i-problems"/></svg> ${warns}`;

  if (!issues.length) {
    node.innerHTML = `
      <div class="prob-clean">
        <div class="prob-clean-ring"><svg><use href="#i-format"/></svg></div>
        <div class="prob-clean-title">All clean</div>
        <div class="prob-clean-sub">No problems detected.</div>
      </div>`;
    return;
  }

  const header = `
    <div class="prob-bar">
      <span class="pb-summary">
        ${errs ? `<span class="pb-chip err">${errs} error${errs===1?'':'s'}</span>` : ''}
        ${warns ? `<span class="pb-chip warn">${warns} warning${warns===1?'':'s'}</span>` : ''}
        ${issues.length - errs - warns ? `<span class="pb-chip info">${issues.length-errs-warns} hint${issues.length-errs-warns===1?'':'s'}</span>` : ''}
      </span>
      ${fixables ? `<button class="pb-fix-all" onclick="fixAllProblems()" data-tip="Apply all auto-fixes">
          <svg><use href="#i-format"/></svg>
          <span>Fix all (${fixables})</span>
        </button>` : `<span class="pb-manual">Manual review</span>`}
    </div>`;

  const body = issues.map(p => `
    <div class="prob ${p.sev} ${p.fixable ? 'is-fixable' : 'is-manual'}" data-id="${p.id}">
      <div class="pi"><svg><use href="#${iconForSev(p.sev)}"/></svg></div>
      <div class="prob-text">
        <div class="prob-msg">${escHtml(p.msg)}</div>
        <div class="prob-meta">
          <span class="rule">${p.rule || ''}</span>
          <span>Line ${p.line}</span>
          ${p.fixable ? '<span class="tag-auto">auto-fix</span>' : '<span class="tag-manual">manual</span>'}
        </div>
      </div>
      <div class="prob-actions">
        ${p.fixable ? `<button class="prob-btn fix" data-tip="Apply this fix" onclick="fixOne(${p.id})">
            <svg><use href="#i-format"/></svg>
          </button>` : ''}
        <button class="prob-btn jump" data-tip="Jump to line" onclick="jumpToLine(${p.line})">
          <svg><use href="#i-chevron-down"/></svg>
        </button>
      </div>
    </div>`).join('');

  node.innerHTML = header + body;
}

function jumpToLine(ln) {
  const v = src.value; const lines = v.split('\n');
  let p = 0; for (let i = 0; i < ln - 1 && i < lines.length; i++) p += lines[i].length + 1;
  src.focus(); src.setSelectionRange(p, p);
  const lineHeight = 18;
  const pre = hl.parentElement;
  const target = Math.max(0, (ln - 3) * lineHeight);
  src.scrollTo({ top: target, behavior: 'smooth' });
  pre.scrollTo({ top: target, behavior: 'auto' });
  updateCursorPos();
}

/* Lint throttling — runs at most once every ~12 s while the buffer is
   dirty. The editor highlighter (which marks unknowns inline) still runs
   on every keystroke; this is just for the full Problems panel scan,
   which can be heavier on larger files. */
const LINT_INTERVAL_MS = 12_000;
let lintDirty = false;
let lintTimer = null;
function scheduleLint() {
  lintDirty = true;
  if (lintTimer) return;
  lintTimer = setTimeout(() => {
    lintTimer = null;
    if (!lintDirty) return;
    lintDirty = false;
    lastIssues = detectIssues();
    renderProblems(lastIssues);
  }, LINT_INTERVAL_MS);
}
src.addEventListener('input', scheduleLint);

/* ──────────────────────────────────────────────────────────────
   MOBILE KEYBOARD
   ────────────────────────────────────────────────────────────── */
const mkbd = document.getElementById('mkbd');
let kbdShift = false; let kbdLock = false; let kbdSymbols = false;
const rows = {
  letters: [
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ':'],
    ['shift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', 'backspace'],
  ],
  symbols: [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['!', '@', '#', '$', '%', '&', '*', '(', ')', '='],
    ['shift', '+', '-', '/', '\\', '|', '[', ']', '{', '}', 'backspace'],
  ],
};

function buildLetterRows() {
  const set = kbdSymbols ? rows.symbols : rows.letters;
  const ids = ['kRow1', 'kRow2', 'kRow3'];
  ids.forEach((id, ri) => {
    const el = document.getElementById(id);
    el.innerHTML = '';
    set[ri].forEach(k => {
      const b = document.createElement('button'); b.className = 'mk';
      if (k === 'shift') {
        b.classList.add('act');
        b.innerHTML = `<svg><use href="#i-shift"/></svg>`;
        b.dataset.act = 'shift';
        if (kbdShift || kbdLock) b.classList.add(kbdLock ? 'lock-on' : 'shift-on');
      } else if (k === 'backspace') {
        b.classList.add('act');
        b.innerHTML = `<svg><use href="#i-backspace"/></svg>`;
        b.dataset.act = 'backspace';
      } else {
        const shown = (kbdShift || kbdLock) && !kbdSymbols ? k.toUpperCase() : k;
        b.textContent = shown; b.dataset.ins = shown;
      }
      el.appendChild(b);
    });
  });
}
buildLetterRows();

mkbd.addEventListener('pointerdown', e => {
  const b = e.target.closest('.mk'); if (!b) return;
  e.preventDefault();
  src.focus({ preventScroll: true });
  if (b.dataset.ins !== undefined) {
    let txt = b.dataset.ins;
    insertAtCursor(txt);
    if (kbdShift && !kbdLock) { kbdShift = false; buildLetterRows(); }
  } else if (b.dataset.act) {
    const a = b.dataset.act;
    if (a === 'tab') insertAtCursor('    ');
    else if (a === 'enter') {
      // simulate Enter via existing handler
      const p = src.selectionStart;
      const before = src.value.slice(0, p);
      const ls = before.lastIndexOf('\n') + 1;
      const indent = before.slice(ls).match(/^[ \t]*/)[0];
      const extra = /[:({\[]\s*$/.test(before.slice(ls)) ? '    ' : '';
      insertAtCursor('\n' + indent + extra);
    }
    else if (a === 'backspace') deleteAtCursor();
    else if (a === 'shift') {
      if (kbdLock) { kbdLock = false; kbdShift = false; }
      else if (kbdShift) { kbdShift = false; kbdLock = true; }
      else kbdShift = true;
      buildLetterRows();
    }
    else if (a === 'symbols') {
      kbdSymbols = !kbdSymbols; buildLetterRows();
      document.getElementById('kbSymToggle').textContent = kbdSymbols ? 'abc' : '123';
      document.getElementById('kbSymToggle').classList.toggle('shift-on', kbdSymbols);
    }
    else if (a === 'paren') { insertAtCursor('()'); src.setSelectionRange(src.selectionStart - 1, src.selectionStart - 1); }
    else if (a === 'quote') { insertAtCursor('""'); src.setSelectionRange(src.selectionStart - 1, src.selectionStart - 1); }
  }
}, { passive: false });

function isTouch() {
  return matchMedia('(pointer: coarse)').matches && window.innerWidth < 1024;
}

let kbdForced = false; // user can override with status-bar toggle
function shouldUseCustomKbd() { return kbdForced || isTouch(); }

function openMobileKbd() {
  if (!shouldUseCustomKbd()) return;
  document.body.classList.add('kbd-mode');
  document.getElementById('stKbd').classList.add('active');
  mkbd.classList.add('open');
  src.setAttribute('inputmode', 'none');
  const h = mkbd.offsetHeight;
  document.querySelector('.editor').style.paddingBottom = h + 'px';
  const r = document.getElementById('mkbdRetract');
  r.style.bottom = (h + 8) + 'px';
  r.classList.add('show');
}
function closeMobileKbd() {
  document.body.classList.remove('kbd-mode');
  document.getElementById('stKbd').classList.remove('active');
  mkbd.classList.remove('open');
  document.querySelector('.editor').style.paddingBottom = '';
  document.getElementById('mkbdRetract').classList.remove('show');
  if (!kbdForced) src.removeAttribute('inputmode');
}

/* explicit retract — bypasses the focus race so keyboard actually stays closed */
document.getElementById('mkbdRetract').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  kbdForced = false;
  src.blur();
  closeMobileKbd();
}, { passive: false });

if (shouldUseCustomKbd()) src.setAttribute('inputmode', 'none');
src.addEventListener('focus', () => { if (shouldUseCustomKbd()) openMobileKbd(); });
src.addEventListener('blur', () => {
  setTimeout(() => {
    if (document.activeElement && (document.activeElement.closest('.mkbd') || document.activeElement === src)) return;
    closeMobileKbd();
  }, 60);
});

// status bar toggle: tap to force-show keyboard on desktop
document.getElementById('stKbd').addEventListener('click', () => {
  kbdForced = !kbdForced;
  if (kbdForced) { src.focus(); openMobileKbd(); }
  else closeMobileKbd();
});

/* ──────────────────────────────────────────────────────────────
   THEME TOGGLE
   ────────────────────────────────────────────────────────────── */
/* Topbar theme button cycles dark → light → system */
document.getElementById('btnTheme').addEventListener('click', () => {
  const order = ['dark', 'light', 'system'];
  const i = order.indexOf(prefs.theme);
  const next = order[(i + 1) % order.length];
  setPref('theme', next);
  toast(next === 'system' ? 'System theme' : next === 'light' ? 'Light theme' : 'Dark theme');
});

/* ──────────────────────────────────────────────────────────────
   SETTINGS SHEET
   ────────────────────────────────────────────────────────────── */
const PREVIEW_SNIPPET = [
  '@dataclass',
  'class User:',
  '    """Account holder."""',
  '    name: str',
  '    age: int = 0',
  '',
  'def greet(u: User) -> str:',
  '    # welcome line',
  '    return f"hi, {u.name}!"',
].join('\n');

function previewHtml(theme) {
  const t = theme.tokens;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const span = (cls, s) => `<span style="color:${t[cls]}">${esc(s)}</span>`;
  return [
    span('dec', '@dataclass'),
    `${span('kw', 'class')} ${span('cls', 'User')}:`,
    `    ${span('str', '"""Account holder."""')}`,
    `    name: ${span('cls', 'str')}`,
    `    age: ${span('cls', 'int')} = ${span('num', '0')}`,
    '',
    `${span('kw', 'def')} ${span('fn', 'greet')}(u: ${span('cls', 'User')}) -&gt; ${span('cls', 'str')}:`,
    `    ${span('cmt', '# welcome line')}`,
    `    ${span('kw', 'return')} ${span('str', 'f"hi, {u.name}!"')}`,
  ].join('\n');
}

function openSettings() {
  const segTab = [2, 4, 8].map(v =>
    `<button class="seg-item${prefs.tabWidth === v ? ' on' : ''}" data-set-tab="${v}">${v}</button>`).join('');

  const swatches = Object.entries(ACCENTS).map(([key, a]) => {
    const v = a[currentMode()] || a.dark;
    return `<button class="swatch${prefs.accent === key ? ' on' : ''}"
             style="--c:${v.main}" data-tip="${a.name}" data-set-accent="${key}"
             aria-label="${a.name}"></button>`;
  }).join('');

  const themeCards = Object.entries(EDITOR_THEMES).map(([key, t]) => {
    const eff = t.follow ? resolveEditorTheme(key) : t;
    const followBadge = t.follow
      ? `<span class="theme-follow-badge"><svg><use href="#i-monitor"/></svg></span>` : '';
    return `<button class="theme-card${prefs.editorTheme === key ? ' on' : ''}${t.follow ? ' is-follow' : ''}" data-set-editor-theme="${key}">
       <div class="theme-preview" style="background:${eff.bg};color:${eff.fg}">${previewHtml(eff)}${followBadge}</div>
       <div class="theme-name"><span>${t.name}</span><span class="dot"></span></div>
     </button>`;
  }).join('');

  openSheet(`
      <div class="sheet-head">
        <div class="sh-icon"><svg><use href="#i-settings"/></svg></div>
        <div class="sh-title">Settings</div>
        <button class="sh-close" onclick="closeSheet()"><svg><use href="#i-close"/></svg></button>
      </div>
      <div class="sheet-body">
        <div class="set-section">
          <div class="set-label"><svg><use href="#i-format"/></svg> Accent color</div>
          <div class="swatches" id="setAccent">${swatches}</div>
        </div>

        <div class="set-section">
          <div class="set-label"><svg><use href="#i-py"/></svg> Editor theme</div>
          <div class="theme-grid" id="setEditorTheme">${themeCards}</div>
        </div>

        <div class="set-section">
          <div class="set-label"><svg><use href="#i-format"/></svg> Editor</div>
          <div class="set-row">
            <div class="set-row-label">Tab width
              <div class="set-row-hint">Number of spaces inserted by Tab</div>
            </div>
            <div class="seg" id="setTab">${segTab}</div>
          </div>
          <div class="set-row">
            <div class="set-row-label">Font size
              <div class="set-row-hint">Editor font size in pixels</div>
            </div>
            <div class="set-stepper">
              <button id="setFontDown"><svg><use href="#i-chevron-down"/></svg></button>
              <span class="val" id="setFontVal">${prefs.fontSize}</span>
              <button id="setFontUp"><svg><use href="#i-up"/></svg></button>
            </div>
          </div>
          <div class="set-row">
            <div class="set-row-label">Force on-screen keyboard
              <div class="set-row-hint">Show PyPad's custom keyboard even on desktop</div>
            </div>
            <div class="toggle${prefs.kbdAlwaysOn ? ' on' : ''}" id="setKbdAlways"></div>
          </div>
        </div>

        <div class="set-section">
          <div class="set-label"><svg><use href="#i-info"/></svg> Storage</div>
          <div class="set-row">
            <div class="set-row-label">Reset preferences
              <div class="set-row-hint">Restore theme / accent / layout to defaults</div>
            </div>
            <button class="mini-btn" id="setReset" data-tip="Reset preferences"><svg><use href="#i-undo"/></svg></button>
          </div>
          <div class="set-row">
            <div class="set-row-label">Force disconnect GitLab
              <div class="set-row-hint">Drop the saved token, repo and any open remote files</div>
            </div>
            <button class="mini-btn" id="setForceDisc" data-tip="Force disconnect GitLab"><svg><use href="#i-power"/></svg></button>
          </div>
          <div class="set-row">
            <div class="set-row-label">Clear all stored data
              <div class="set-row-hint">Files, GitLab session, folder handle, preferences</div>
            </div>
            <button class="mini-btn" id="setClearAll" data-tip="Clear all stored data"><svg><use href="#i-trash"/></svg></button>
          </div>
        </div>

        <div class="set-section set-about">
          <div class="set-about-line">
            &copy; ${new Date().getFullYear()}
            <a href="https://dimitrisofikitis.com" target="_blank" rel="noopener noreferrer">Dimitris Sofikitis</a>
            &nbsp;&middot;&nbsp;
            <a href="https://github.com/dSofikitis/PyPad-IDE/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">MIT License</a>
          </div>
        </div>
      </div>
  `, { cls: 'settings-sheet' });

  // wire interactions
  const refresh = () => openSettings(); // simple refresh

  document.getElementById('setAccent').addEventListener('click', (e) => {
    const b = e.target.closest('[data-set-accent]'); if (!b) return;
    setPref('accent', b.dataset.setAccent);
    toast(`Accent: ${ACCENTS[b.dataset.setAccent].name}`, 'ok'); refresh();
  });
  document.getElementById('setEditorTheme').addEventListener('click', (e) => {
    const b = e.target.closest('[data-set-editor-theme]'); if (!b) return;
    setPref('editorTheme', b.dataset.setEditorTheme);
    toast(`Editor theme: ${EDITOR_THEMES[b.dataset.setEditorTheme].name}`, 'ok'); refresh();
  });
  document.getElementById('setTab').addEventListener('click', (e) => {
    const b = e.target.closest('[data-set-tab]'); if (!b) return;
    setPref('tabWidth', Number(b.dataset.setTab)); refresh();
  });
  document.getElementById('setFontDown').onclick = () => {
    if (prefs.fontSize > 10) { setPref('fontSize', prefs.fontSize - 1); document.getElementById('setFontVal').textContent = prefs.fontSize; }
  };
  document.getElementById('setFontUp').onclick = () => {
    if (prefs.fontSize < 22) { setPref('fontSize', prefs.fontSize + 1); document.getElementById('setFontVal').textContent = prefs.fontSize; }
  };
  document.getElementById('setKbdAlways').addEventListener('click', () => {
    setPref('kbdAlwaysOn', !prefs.kbdAlwaysOn);
    kbdForced = prefs.kbdAlwaysOn;
    if (kbdForced) { src.focus(); openMobileKbd(); } else closeMobileKbd();
    refresh();
  });
  document.getElementById('setReset').onclick = () => {
    if (!confirm('Reset all preferences and panel layout?')) return;
    localStorage.removeItem(PREFS_KEY);
    prefs = { ...defaultPrefs };
    applyTheme(); applyAccent(); applyEditorTheme(); applyTabWidth(); applyFontSize();
    toast('Preferences reset', 'ok');
    closeSheet();
  };
  document.getElementById('setForceDisc').onclick = () => {
    if (!confirm('Force-disconnect GitLab? Token + saved repo will be wiped, and any open remote files closed.')) return;
    forceDisconnectGitlab();
    toast('GitLab disconnected', 'warn');
    closeSheet();
  };
  document.getElementById('setClearAll').onclick = () => {
    clearAllStorage();
    closeSheet();
  };
}
document.getElementById('btnSettings').addEventListener('click', openSettings);

/* ──────────────────────────────────────────────────────────────
   TOPBAR WIRING
   ────────────────────────────────────────────────────────────── */
document.getElementById('btnRun').addEventListener('click', runCode);
document.getElementById('btnFormat').addEventListener('click', formatBasic);
document.getElementById('btnSave').addEventListener('click', saveFile);
document.getElementById('btnExplorer').addEventListener('click', () => {
  const open = workspace.getAttribute('data-side') === 'open';
  workspace.setAttribute('data-side', open ? 'closed' : 'open');
  document.getElementById('btnExplorer').classList.toggle('active', !open);
  setPref('sidebarOpen', !open);
});
document.getElementById('btnOpenDir').addEventListener('click', () => {
  // Ensure the sidebar is visible so the folder section becomes findable
  if (workspace.getAttribute('data-side') !== 'open') {
    workspace.setAttribute('data-side', 'open');
    document.getElementById('btnExplorer').classList.add('active');
    setPref('sidebarOpen', true);
  }
  openLocalDir();
});
document.getElementById('btnTerm').addEventListener('click', () => togglePanel('terminal'));
document.getElementById('btnProblems').addEventListener('click', () => {
  lastIssues = detectIssues();
  renderProblems(lastIssues);
  togglePanel('problems');
});
document.getElementById('btnGitlab').addEventListener('click', () => openGitlabPanel());
function toggleTerminal() { togglePanel('terminal'); }

/* ──────────────────────────────────────────────────────────────
   GITLAB — preserved from previous version, restyled
   ────────────────────────────────────────────────────────────── */
const session = {
  token: null, username: null, email: null, avatarInitial: null,
  gitlabUrl: 'https://gitlab.com',
  currentRepo: null, currentFile: null, currentBranch: null,
};
function isAuthed() { return !!session.token; }
function api(path, opts = {}) {
  return fetch(`${session.gitlabUrl}/api/v4${path}`, {
    ...opts,
    headers: { 'PRIVATE-TOKEN': session.token, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
}

function openSheet(html, opts = {}) {
  const ov = document.getElementById('sheetOverlay');
  const body = document.getElementById('sheetBody');
  body.className = 'sheet' + (opts.cls ? ' ' + opts.cls : '');
  body.innerHTML = html;
  ov.classList.add('open');
}
function closeSheet() { document.getElementById('sheetOverlay').classList.remove('open'); }
function maybeCloseSheet(e) { if (e.target.id === 'sheetOverlay') closeSheet(); }

function openGitlabPanel() {
  if (!isAuthed()) return openAuthSheet();
  openSheet(`
<div class="sheet-head">
  <div class="sh-icon"><svg><use href="#i-gitlab"/></svg></div>
  <div class="sh-title">GitLab</div>
  <button class="sh-close" onclick="closeSheet()"><svg><use href="#i-close"/></svg></button>
</div>
<div class="sheet-sub">@${esc(session.username)} · ${esc(session.gitlabUrl.replace(/^https?:\/\//, ''))}</div>
<div class="sheet-body">
  <div class="sheet-list-item" onclick="openRepoBrowser()">
    <div class="li-icon"><svg><use href="#i-folder-open"/></svg></div>
    <div class="li-main"><div class="li-title">Open Repository</div><div class="li-sub">Browse and load files</div></div>
  </div>
  <div class="sheet-list-item" onclick="openCommitSheet()">
    <div class="li-icon"><svg><use href="#i-commit"/></svg></div>
    <div class="li-main"><div class="li-title">Commit &amp; Push</div><div class="li-sub">${session.currentFile ? esc(session.currentFile.path) : 'Open a remote file first'}</div></div>
  </div>
  <div class="sheet-list-item" onclick="signOut()">
    <div class="li-icon"><svg><use href="#i-power"/></svg></div>
    <div class="li-main"><div class="li-title">Sign Out</div><div class="li-sub">Clear token from memory</div></div>
  </div>
</div>`);
}
function openAuthSheet() {
  openSheet(`
<div class="sheet-head">
  <div class="sh-icon"><svg><use href="#i-gitlab"/></svg></div>
  <div class="sh-title">Connect GitLab</div>
  <button class="sh-close" onclick="closeSheet()"><svg><use href="#i-close"/></svg></button>
</div>
<div class="sheet-sub">Token + repo are saved to browser storage so you stay signed in across refreshes. Cleared on sign-out or "Clear site data".</div>
<div class="sheet-body">
  <div class="sheet-error" id="authError"></div>
  <div class="sheet-field"><label>Instance URL</label>
    <input class="sheet-input" id="authUrl" value="https://gitlab.com"/></div>
  <div class="sheet-field"><label>Personal Access Token</label>
    <input class="sheet-input" id="authToken" type="password" placeholder="glpat-xxxxxxxx" autocomplete="off"/></div>
  <div class="sheet-hint">Scopes: <b>read_api</b> + <b>write_repository</b></div>
  <button class="sheet-btn" id="authSubmit" onclick="submitAuth()"><svg><use href="#i-power"/></svg> Connect</button>
</div>`);
  setTimeout(() => document.getElementById('authToken')?.focus(), 250);
}
async function submitAuth() {
  const btn = document.getElementById('authSubmit'); const err = document.getElementById('authError');
  const token = document.getElementById('authToken').value.trim();
  const url = document.getElementById('authUrl').value.trim().replace(/\/$/, '');
  err.classList.remove('show');
  if (!token) { err.textContent = 'Token required.'; err.classList.add('show'); return; }
  btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
  session.gitlabUrl = url; session.token = token;
  try {
    const res = await api('/user'); if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const u = await res.json();
    session.username = u.username; session.email = u.email || '(none)';
    session.avatarInitial = (u.name || u.username).charAt(0).toUpperCase();
    document.getElementById('glDot').style.display = 'none';
    document.getElementById('btnGitlab').classList.add('active');
    document.getElementById('stBranch').innerHTML = `<svg><use href="#i-branch"/></svg> @${esc(u.username)}`;
    persistGitlab();
    closeSheet(); toast(`Connected as @${u.username}`, 'ok');
  } catch (e) {
    session.token = null;
    err.textContent = String(e.message); err.classList.add('show');
    btn.disabled = false; btn.innerHTML = '<svg><use href="#i-power"/></svg> Connect';
  }
}
function signOut() {
  session.token = null; session.username = null; session.currentRepo = null;
  session.currentBranch = null; session.currentFile = null;
  try { localStorage.removeItem(STORE.gitlab); } catch {}
  document.getElementById('btnGitlab').classList.remove('active');
  document.getElementById('stBranch').innerHTML = `<svg><use href="#i-branch"/></svg> local`;
  closeSheet(); toast('Signed out');
}
async function openRepoBrowser() {
  openSheet(`
<div class="sheet-head">
  <div class="sh-icon"><svg><use href="#i-folder-open"/></svg></div>
  <div class="sh-title">Repositories</div>
  <button class="sh-close" onclick="closeSheet()"><svg><use href="#i-close"/></svg></button>
</div>
<div class="search-row">
  <svg><use href="#i-search"/></svg>
  <input class="sheet-input" id="repoSearch" placeholder="Filter…" oninput="filterRepos(this.value)"/>
</div>
<div class="sheet-body" id="repoList">
  <div class="loading-row"><span class="spin"></span> Loading projects…</div>
</div>`);
  try {
    const res = await api('/projects?membership=true&order_by=last_activity_at&per_page=30');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    repoCache = await res.json(); renderRepos(repoCache);
  } catch (e) {
    document.getElementById('repoList').innerHTML = `<div class="prob-empty">Failed: ${esc(e.message)}</div>`;
  }
}
let repoCache = [];
function renderRepos(list) {
  const el = document.getElementById('repoList'); if (!el) return;
  if (!list.length) { el.innerHTML = '<div class="prob-empty">No repositories.</div>'; return; }
  el.innerHTML = list.map(r => {
    const vis = r.visibility === 'private' ? 'private' : r.visibility === 'internal' ? 'internal' : 'public';
    return `<div class="sheet-list-item" onclick="selectRepo(${r.id}, '${esc(r.name)}', '${esc(r.path_with_namespace)}', '${esc(r.default_branch || 'main')}')">
  <div class="li-icon"><svg><use href="#i-folder"/></svg></div>
  <div class="li-main">
    <div class="li-title">${esc(r.name_with_namespace || r.name)}</div>
    <div class="li-sub"><span class="vis">${vis}</span>${r.language ? `<span class="lang">${esc(r.language)}</span>` : ''}</div>
  </div>
</div>`;
  }).join('');
}
function filterRepos(q) {
  q = q.toLowerCase();
  renderRepos(repoCache.filter(r =>
    r.name.toLowerCase().includes(q) || (r.path_with_namespace || '').toLowerCase().includes(q)));
}
async function selectRepo(id, name, fullPath, defaultBranch) {
  session.currentRepo = { id, name, fullPath, defaultBranch };
  session.currentBranch = defaultBranch;
  document.getElementById('stBranch').innerHTML = `<svg><use href="#i-branch"/></svg> ${esc(defaultBranch)}`;
  persistGitlab();
  openFileTree('');
}
let treePath = '';
function openFileTree(p) {
  treePath = p;
  openSheet(`
<div class="sheet-head">
  <div class="sh-icon"><svg><use href="#i-folder-open"/></svg></div>
  <div class="sh-title">${esc(session.currentRepo.name)}</div>
  <button class="sh-close" onclick="closeSheet()"><svg><use href="#i-close"/></svg></button>
</div>
<div class="sheet-sub">Branch · <b style="color:var(--purple)">${esc(session.currentBranch)}</b></div>
<div class="crumb-row" id="treeCrumbs"></div>
<div class="sheet-body" id="treeList"><div class="loading-row"><span class="spin"></span> Loading…</div></div>`);
  document.getElementById('treeCrumbs').innerHTML = buildCrumbs(p);
  loadTree(p);
}
function buildCrumbs(p) {
  const parts = p ? p.split('/') : []; let acc = ''; let html = `<span class="tcrumb" onclick="openFileTree('')">root</span>`;
  parts.forEach((part, i) => {
    acc += (acc ? '/' : '') + part;
    if (i < parts.length - 1) html += `<span class="tsep">›</span><span class="tcrumb" onclick="openFileTree('${esc(acc)}')">${esc(part)}</span>`;
    else html += `<span class="tsep">›</span><span class="tcrumb">${esc(part)}</span>`;
  });
  return html;
}
async function loadTree(p) {
  const { id } = session.currentRepo; const branch = session.currentBranch;
  const params = p ? `&path=${encodeURIComponent(p)}` : '';
  try {
    const res = await api(`/projects/${id}/repository/tree?ref=${branch}&per_page=100${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = await res.json();
    items.sort((a, b) => a.type !== b.type ? (a.type === 'tree' ? -1 : 1) : a.name.localeCompare(b.name));
    const el = document.getElementById('treeList');
    if (!items.length) { el.innerHTML = '<div class="prob-empty">Empty.</div>'; return; }
    el.innerHTML = items.map(it => {
      const isDir = it.type === 'tree';
      const ico = isDir ? 'i-folder' : (it.name.endsWith('.py') ? 'i-py' : 'i-doc');
      const act = isDir ? `openFileTree('${esc(it.path)}')` : `openRemoteFile('${esc(it.path)}')`;
      return `<div class="sheet-list-item" onclick="${act}">
    <div class="li-icon"><svg><use href="#${ico}"/></svg></div>
    <div class="li-main"><div class="li-title">${esc(it.name)}</div>
      <div class="li-sub">${isDir ? 'directory' : 'file'}</div></div>
  </div>`;
    }).join('');
  } catch (e) {
    document.getElementById('treeList').innerHTML = `<div class="prob-empty">Error: ${esc(e.message)}</div>`;
  }
}
async function openRemoteFile(path) {
  const { id } = session.currentRepo; const branch = session.currentBranch;
  closeSheet(); toast(`Loading ${path.split('/').pop()}…`);
  try {
    const res = await api(`/projects/${id}/repository/files/${encodeURIComponent(path)}?ref=${branch}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const content = atob(data.content);
    const f = {
      id: cryptoId(), name: path.split('/').pop(),
      content, originalContent: content,
      source: 'gitlab', path, sha: data.last_commit_id
    };
    files.push(f); selectFile(f.id); renderTree(); persistFiles();
    toast(`Opened ${f.name}`, 'ok');
  } catch (e) { toast(`Open failed: ${e.message}`, 'err'); }
}
function openCommitSheet() {
  const f = files.find(f => f.id === activeId);
  if (!f || f.source !== 'gitlab') { toast('Open a GitLab file first', 'warn'); return; }
  openSheet(`
<div class="sheet-head">
  <div class="sh-icon"><svg><use href="#i-commit"/></svg></div>
  <div class="sh-title">Commit &amp; Push</div>
  <button class="sh-close" onclick="closeSheet()"><svg><use href="#i-close"/></svg></button>
</div>
<div class="sheet-sub">${esc(f.path)} · branch <b style="color:var(--purple)">${esc(session.currentBranch)}</b></div>
<div class="sheet-body">
  <div class="sheet-error" id="commitError"></div>
  <div class="sheet-field"><label>Message</label>
    <textarea class="sheet-textarea" id="commitMsg" placeholder="feat: update ${esc(f.name)}"></textarea></div>
  <button class="sheet-btn" id="commitBtn" onclick="submitCommit()"><svg><use href="#i-commit"/></svg> Commit &amp; Push</button>
</div>`);
}
async function submitCommit() {
  const f = files.find(f => f.id === activeId); if (!f) return;
  const msg = document.getElementById('commitMsg').value.trim();
  const err = document.getElementById('commitError'); err.classList.remove('show');
  if (!msg) { err.textContent = 'Message required.'; err.classList.add('show'); return; }
  const btn = document.getElementById('commitBtn'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
  // grab fresh editor contents in case active file is this one
  if (f.id === activeId) f.content = src.value;
  const { id } = session.currentRepo; const branch = session.currentBranch;
  const encoded = btoa(unescape(encodeURIComponent(f.content)));
  try {
    const res = await api(`/projects/${id}/repository/files/${encodeURIComponent(f.path)}`, {
      method: 'PUT',
      body: JSON.stringify({
        branch, content: encoded, encoding: 'base64',
        commit_message: msg, author_name: session.username, author_email: session.email
      })
    });
    if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.message || `HTTP ${res.status}`); }
    f.originalContent = f.content;
    closeSheet(); clean(); persistFiles();
    toast(`Pushed: "${msg.slice(0, 40)}"`, 'ok');
  } catch (e) {
    err.textContent = String(e.message); err.classList.add('show');
    btn.disabled = false; btn.innerHTML = '<svg><use href="#i-commit"/></svg> Commit & Push';
  }
}
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&#34;').replace(/'/g, '&#39;'); }

/* expose what onclick handlers need */
Object.assign(window, {
  newFile, selectFile, saveFile, deleteFile,
  openGitlabPanel, openAuthSheet, submitAuth, signOut, openRepoBrowser,
  selectRepo, openFileTree, openRemoteFile, openCommitSheet, submitCommit,
  closeSheet, maybeCloseSheet, filterRepos, runCode, jumpToLine,
  fixOne, fixAllProblems,
  openLocalDir, closeDir, closeRepo, refreshDirTree, resumeDirAccess,
  openDirFile, forceDisconnectGitlab, clearAllStorage,
});

/* ──────────────────────────────────────────────────────────────
   INIT
   ────────────────────────────────────────────────────────────── */
// apply saved preferences (theme, accent, editor theme, sizing) before paint
applyTheme(); applyAccent(); applyEditorTheme(); applyTabWidth(); applyFontSize();
if (prefs.kbdAlwaysOn) kbdForced = true;
if (prefs.sidebarOpen) { workspace.setAttribute('data-side', 'open'); document.getElementById('btnExplorer').classList.add('active'); }
restoreLayout();

// restore persisted state: GitLab session → open files → folder handle
if (loadPersistedGitlab()) {
  document.getElementById('glDot').style.display = 'none';
  document.getElementById('btnGitlab').classList.add('active');
  document.getElementById('stBranch').innerHTML =
    `<svg><use href="#i-branch"/></svg> ${esc(session.currentBranch || ('@' + (session.username || '')))}`;
}
loadPersistedFiles();
if (activeId) {
  const f = files.find(x => x.id === activeId);
  if (f) {
    src.value = f.content || '';
    fileLabel.textContent = f.name;
    document.getElementById('bcFile').textContent = f.name;
    document.getElementById('bcPath').textContent =
      f.source === 'gitlab' ? 'gitlab' : f.source === 'dir' ? 'folder' : 'local';
    if (f.originalContent !== undefined && f.originalContent !== f.content) dirty(); else clean();
  }
}

renderHighlight(); renderTree(); applyLayout(); rebuildTabs();
attachSlotDropTargets();

// attempt to silently re-attach the saved folder handle (FS Access API)
tryRestoreDir().catch(() => {});

// kick off pyodide load in the background
loadPyodideOnce().catch(() => { });

