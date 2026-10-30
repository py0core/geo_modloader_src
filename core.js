'use strict';
// Geoplanetical Mod Loader - core (Electron MAIN process).
// Loaded by a one-line hook at the top of the game's electron/main.js. Everything else (this file, ui.js, the
// mods) lives OUTSIDE the game archive, so adding / removing / editing / toggling mods never needs a rebuild.
//
//  * discovers <game>/mods/<id>/mod.json, keeps enable/disable state in <game>/mods/_loader.json
//  * applies each enabled mod's patches to the game's renderer files IN MEMORY (the archive is never modified)
//  * serves the patched files by intercepting the file: protocol; patched Web Workers are written to a cache
//    file and the page's Worker constructor is redirected there (Electron does not route workers through protocol handlers)
//  * runs mods' optional main-process script, injects optional renderer scripts / css
//  * exposes a token-protected loopback API used by the in-game panel (ui.js)
const LOADER_VERSION = '1.1.0';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const zlib = require('zlib');
const vm = require('vm');
const { pathToFileURL, fileURLToPath } = require('url');

let electron = null;
try { electron = require('electron'); } catch (_) { return; }
const { app, protocol, net, shell } = electron;
if (!app || !protocol || process.argv.includes('--geomod-off') || process.env.GEOMOD_OFF) return;

const ROOT = process.env.GEOMOD_ROOT || path.resolve(__dirname, '..', '..');
const MODS_DIR = path.join(ROOT, 'mods');
const CACHE_DIR = path.join(ROOT, 'ModLoader', 'cache');
const LOG_FILE = path.join(ROOT, 'ModLoader', 'loader.log');
const STATE_FILE = path.join(MODS_DIR, '_loader.json');
const ID_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
const SOURCES_DIR = path.join(MODS_DIR, '_sources');
// When the loader is sealed, the stub passes __seal = { derive(salt, info) -> 32-byte key, ui } (the secret never leaves the native module).
// Unsealed (development) runs fall back to a throw-away key, so packages made then are NOT portable.
const SEAL = (typeof __seal !== 'undefined' && __seal) ? __seal : {
  dev: true, ui: null,
  derive: (salt, info) => crypto.createHmac('sha256', 'GEOMOD-DEV-ONLY-SECRET').update(Buffer.concat([salt, Buffer.from(info)])).digest(),
};
const PKG_MAGIC = Buffer.from('GEOMOD1\n');
const PKG_MAX_HEADER = 1 << 20;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };

// ------------------------------------------------------------------ packages (.geomod): AES-256-GCM, key derived from the sealed secret
function pkgSeal(header, files) {
  const salt = crypto.randomBytes(16), nonce = crypto.randomBytes(12);
  const hj = Buffer.from(JSON.stringify({ v: 1, ...header, salt: salt.toString('base64'), nonce: nonce.toString('base64') }), 'utf8');
  const len = Buffer.alloc(4); len.writeUInt32BE(hj.length);
  const aad = Buffer.concat([PKG_MAGIC, len, hj]);
  const payload = zlib.deflateSync(Buffer.from(JSON.stringify({ files: Object.fromEntries([...files].map(([k, v]) => [k, v.toString('base64')])) })));
  const c = crypto.createCipheriv('aes-256-gcm', SEAL.derive(salt, 'geomod-pkg-v1'), nonce); c.setAAD(aad);
  const enc = Buffer.concat([c.update(payload), c.final()]);
  return Buffer.concat([aad, enc, c.getAuthTag()]);
}
function pkgReadHeader(fd) {                      // public header only (no decryption)
  const head = Buffer.alloc(12);
  if (fs.readSync(fd, head, 0, 12, 0) !== 12 || !head.subarray(0, 8).equals(PKG_MAGIC)) throw new Error('not a .geomod package');
  const n = head.readUInt32BE(8); if (n < 2 || n > PKG_MAX_HEADER) throw new Error('bad package header');
  const hj = Buffer.alloc(n); if (fs.readSync(fd, hj, 0, n, 12) !== n) throw new Error('truncated package');
  return { header: JSON.parse(hj.toString('utf8')), aadLen: 12 + n };
}
function pkgOpen(file) {                          // -> Map(rel -> Buffer); throws if damaged / tampered / sealed with another secret
  const buf = fs.readFileSync(file);
  if (buf.length < 12 + 16 || !buf.subarray(0, 8).equals(PKG_MAGIC)) throw new Error('not a .geomod package');
  const n = buf.readUInt32BE(8); if (n < 2 || n > PKG_MAX_HEADER || 12 + n + 16 > buf.length) throw new Error('bad package header');
  const hdr = JSON.parse(buf.subarray(12, 12 + n).toString('utf8'));
  const d = crypto.createDecipheriv('aes-256-gcm', SEAL.derive(Buffer.from(hdr.salt, 'base64'), 'geomod-pkg-v1'), Buffer.from(hdr.nonce, 'base64'));
  d.setAAD(buf.subarray(0, 12 + n)); d.setAuthTag(buf.subarray(buf.length - 16));
  let raw; try { raw = Buffer.concat([d.update(buf.subarray(12 + n, buf.length - 16)), d.final()]); }
  catch (_) { throw new Error('package is damaged, edited, or was made for a different loader'); }
  const obj = JSON.parse(zlib.inflateSync(raw).toString('utf8'));
  return new Map(Object.entries(obj.files).map(([k, v]) => [k, Buffer.from(v, 'base64')]));
}

function log(...args) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    try { if (fs.statSync(LOG_FILE).size > 512 * 1024) fs.writeFileSync(LOG_FILE, ''); } catch (_) {}
    const text = args.map(a => typeof a === 'string' ? a : (a && a.stack) || JSON.stringify(a)).join(' ');
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + text + '\n');
  } catch (_) {}
}

// ------------------------------------------------------------------ state
function readState() {
  const base = { enabled: {}, hotkey: 'Home', bannerSeconds: 6, settings: {} };
  try { const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); return { ...base, ...s, enabled: { ...(s.enabled || {}) }, settings: { ...(s.settings || {}) } }; }
  catch (_) { return base; }
}
function writeState(state) {
  fs.mkdirSync(MODS_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ------------------------------------------------------------------ discovery
const safeRel = s => typeof s === 'string' && s.length > 0 && s.length < 200 && !/^([a-zA-Z]:|[\\/])/.test(s)
  && !s.split(/[\\/]/).some(p => p === '..' || p === '') && !/[\u0000-\u001f]/.test(s);
const strList = v => v == null ? [] : (Array.isArray(v) ? v : [v]);

function validateManifest(m, dirName) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'mod.json must be an object';
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) return 'invalid "id" (lowercase letters, digits, hyphens; 2-48 chars)';
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 100) return 'invalid "name"';
  if (typeof m.version !== 'string' || !m.version || m.version.length > 32) return 'invalid "version"';
  if (m.loaderApi !== 1) return `unsupported loaderApi (${JSON.stringify(m.loaderApi)}); this loader supports 1`;
  for (const k of ['author', 'description']) if (m[k] != null && typeof m[k] !== 'string') return `"${k}" must be a string`;
  if (m.requires != null && (!Array.isArray(m.requires) || m.requires.some(x => typeof x !== 'string' || !ID_RE.test(x)))) return 'invalid "requires"';
  for (const k of ['renderer', 'css']) if (strList(m[k]).some(f => !safeRel(f))) return `invalid file in "${k}"`;
  if (m.main != null && !safeRel(m.main)) return 'invalid "main"';
  if (m.patches != null && !Array.isArray(m.patches)) return '"patches" must be an array';
  for (const p of m.patches || []) {
    if (!p || typeof p !== 'object' || typeof p.file !== 'string' || typeof p.find !== 'string' || (p.replace != null && typeof p.replace !== 'string')) return 'invalid entry in "patches"';
    if (!/^renderer\/[^\0]+$/.test(p.file) || !safeRel(p.file)) return `patch file must be under renderer/: ${p.file}`;
  }
  if (m.transforms != null && !Array.isArray(m.transforms)) return '"transforms" must be an array';
  for (const t of m.transforms || []) {
    if (!t || typeof t.file !== 'string' || !/^renderer\//.test(t.file) || !safeRel(t.file) || !safeRel(t.script)) return 'invalid entry in "transforms"';
  }
  if (m.settings != null) {
    if (!Array.isArray(m.settings) || m.settings.length > 64) return '"settings" must be an array (max 64)';
    const keys = new Set();
    for (const d of m.settings) {
      if (!d || typeof d !== 'object' || typeof d.key !== 'string' || !/^[A-Za-z0-9_]{1,40}$/.test(d.key) || keys.has(d.key)) return 'invalid "settings" entry (key)';
      keys.add(d.key);
      if (!['number', 'bool', 'select', 'text'].includes(d.type) || typeof d.label !== 'string' || d.label.length > 100) return `invalid "settings" entry ${d.key}`;
      if (d.type === 'select' && (!Array.isArray(d.options) || !d.options.length || d.options.length > 50)) return `settings ${d.key}: "options" required`;
    }
  }
  if (m.csp != null && (typeof m.csp !== 'object' || Array.isArray(m.csp)
    || Object.values(m.csp).some(v => !Array.isArray(v) || v.some(s => typeof s !== 'string' || /[;\s,"']/.test(s) && !/^'[a-z-]+'$/.test(s))))) return 'invalid "csp"';
  return null;
}

function discover() {
  const mods = [];
  let entries = [];
  try { entries = fs.readdirSync(MODS_DIR, { withFileTypes: true }).filter(d => d.isDirectory() && !/^[._]/.test(d.name)).map(d => d.name).sort(); } catch (_) {}
  const seen = new Set();
  for (const name of entries) {
    const dir = path.join(MODS_DIR, name);
    const file = path.join(dir, 'mod.json');
    if (!fs.existsSync(file)) continue;
    const mod = { dir, folder: name, manifest: null, id: name, name, version: '', author: '', description: '', status: 'disabled', message: '' };
    try {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
      const error = validateManifest(manifest, name);
      if (error) { mod.status = 'failed'; mod.message = error; }
      else if (seen.has(manifest.id)) { mod.status = 'failed'; mod.message = `duplicate id "${manifest.id}"`; }
      else {
        seen.add(manifest.id); mod.manifest = manifest; mod.id = manifest.id; mod.name = manifest.name; mod.version = manifest.version;
        mod.author = manifest.author || ''; mod.description = manifest.description || '';
      }
    } catch (e) { mod.status = 'failed'; mod.message = 'mod.json: ' + e.message; }
    mods.push(mod);
  }
  let pk = []; try { pk = fs.readdirSync(MODS_DIR, { withFileTypes: true }).filter(d => d.isFile() && /\.geomod$/i.test(d.name) && !/^[._]/.test(d.name)).map(d => d.name).sort(); } catch (_) {}
  for (const name of pk) {
    const file = path.join(MODS_DIR, name);
    const mod = { dir: MODS_DIR, file, folder: name, packaged: true, manifest: null, id: name, name, version: '', author: '', description: '', status: 'disabled', message: '' };
    try {
      const fd = fs.openSync(file, 'r'); let h;
      try { h = pkgReadHeader(fd).header; } finally { fs.closeSync(fd); }
      const lite = { id: h.id, name: h.name, version: h.version, author: h.author, description: h.description, requires: h.requires, loaderApi: h.loaderApi, settings: h.settings };
      const error = validateManifest(lite, name);
      if (error) { mod.status = 'failed'; mod.message = error; }
      else if (seen.has(lite.id)) { mod.status = 'failed'; mod.message = `duplicate id "${lite.id}" (a plain folder with the same id exists: move it to mods/_sources)`; }
      else { seen.add(lite.id); mod.manifest = lite; mod.id = lite.id; mod.name = lite.name; mod.version = lite.version; mod.author = lite.author || ''; mod.description = lite.description || ''; }
    } catch (e) { mod.status = 'failed'; mod.message = name + ': ' + e.message; }
    mods.push(mod);
  }
  return mods;
}

// files of a mod, whether it lives in a folder or inside a package
function modRead(mod, rel) {
  rel = norm(rel);
  if (mod.pkg) { const b = mod.pkg.get(rel); if (!b) { const e = new Error('ENOENT ' + rel); e.code = 'ENOENT'; throw e; } return b; }
  return fs.readFileSync(path.join(mod.dir, rel));
}
function memRequire(mod, fromRel) {
  return spec => {
    if (typeof spec === 'string' && (spec.startsWith('./') || spec.startsWith('../'))) {
      const base = path.posix.join(path.posix.dirname(fromRel), spec);
      for (const c of [base, base + '.js', base + '.json', base + '/index.js']) if (mod.pkg.has(c)) return memLoad(mod, c);
      throw new Error(`Cannot find module '${spec}' in package ${mod.id}`);
    }
    return require(spec);
  };
}
function memLoad(mod, rel) {
  if (!mod.modCache) mod.modCache = new Map();
  const hit = mod.modCache.get(rel); if (hit) return hit.exports;
  const text = mod.pkg.get(rel).toString('utf8');
  const m = { exports: {} }; mod.modCache.set(rel, m);
  if (/\.json$/i.test(rel)) { m.exports = JSON.parse(text); return m.exports; }
  const fn = vm.compileFunction(text, ['exports', 'require', 'module', '__filename', '__dirname'], { filename: `geomod-pkg://${mod.id}/${rel}` });
  fn(m.exports, memRequire(mod, rel), m, rel, path.posix.dirname(rel));
  return m.exports;
}
const modRequire = (mod, rel) => mod.pkg ? memLoad(mod, norm(rel)) : require(path.join(mod.dir, rel));

function loadConfig(mod) {
  let cfg = { ...(mod.manifest.config || {}) };
  try { cfg = { ...cfg, ...JSON.parse(modRead(mod, 'config.json').toString('utf8')) }; } catch (e) { if (e.code !== 'ENOENT') throw new Error('config.json: ' + e.message); }
  for (const d of mod.manifest.settings || []) if (d.default !== undefined && cfg[d.key] === undefined) cfg[d.key] = d.default;
  return { ...cfg, ...(readState().settings[mod.id] || {}) };
}

// ------------------------------------------------------------------ patch engine
let APP = null;                        // game archive root (…/resources/app.asar)
const files = new Map();               // rel -> { text, enc, dirty }
const norm = rel => rel.replace(/\\/g, '/');

function openFile(rel) {
  rel = norm(rel);
  let f = files.get(rel);
  if (!f) {
    const buf = fs.readFileSync(path.join(APP, rel));
    const text = buf.toString('utf8');
    // Files that are not valid UTF-8 are patched byte-for-byte as latin1 so nothing is corrupted.
    f = Buffer.from(text, 'utf8').equals(buf) ? { text, enc: 'utf8', dirty: false } : { text: buf.toString('latin1'), enc: 'latin1', dirty: false };
    files.set(rel, f);
  }
  return f;
}
const conv = (s, enc) => enc === 'latin1' ? Buffer.from(s, 'utf8').toString('latin1') : s;

function applyPatch(text, enc, p, label) {
  const find = conv(p.find, enc), repl = conv(p.replace == null ? '' : p.replace, enc);
  let count, out;
  if (p.regex) {
    const re = new RegExp(find, (p.flags || '').replace(/[gy]/g, '') + 'g');
    count = (text.match(re) || []).length;
    out = count ? text.replace(re, repl) : text;
  } else {
    const parts = text.split(find);
    count = parts.length - 1;
    out = count ? parts.join(repl) : text;
  }
  const want = p.all ? null : (Number.isInteger(p.count) ? p.count : 1);
  if (count === 0 && p.optional) return text;
  if (want === null ? count < 1 : count !== want) {
    throw new Error(`${label}: expected ${want === null ? 'at least 1' : want} match(es) of the patch anchor in ${p.file}, found ${count} (the game may have been updated)`);
  }
  return out;
}

const loadedMods = [];
function applyMod(mod) {
  if (mod.packaged && !mod.pkg) {
    mod.pkg = pkgOpen(mod.file);
    let full; try { full = JSON.parse(modRead(mod, 'mod.json').toString('utf8')); } catch (e) { throw new Error('package has no valid mod.json: ' + e.message); }
    const error = validateManifest(full, mod.folder);
    if (error) throw new Error(error);
    if (full.id !== mod.id) throw new Error('package id does not match its header');
    mod.manifest = full; mod.version = full.version;
  }
  const staged = new Map();
  const view = rel => { rel = norm(rel); if (!staged.has(rel)) { const f = openFile(rel); staged.set(rel, { text: f.text, enc: f.enc }); } return staged.get(rel); };
  const cfg = loadConfig(mod);
  (mod.manifest.patches || []).forEach((p, i) => { const f = view(p.file); f.text = applyPatch(f.text, f.enc, p, `patch #${i + 1}`); });
  (mod.manifest.transforms || []).forEach((t, i) => {
    const f = view(t.file);
    const fn = modRequire(mod, t.script);
    if (typeof fn !== 'function') throw new Error(`transform ${t.script} must export a function (text, ctx) => text`);
    const out = fn(f.text, { mod: mod.manifest, config: cfg, file: norm(t.file), enc: f.enc, args: t.args || {},
      readModFile: rel => modRead(mod, rel).toString('utf8') });
    if (typeof out !== 'string') throw new Error(`transform ${t.script} did not return a string`);
    f.text = out;
  });
  const api = { app, electron, loaderVersion: LOADER_VERSION, modId: mod.id, rootDir: ROOT, config: cfg,
    modDir: mod.packaged ? (() => { const d = path.join(MODS_DIR, '_data', mod.id); try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} return d; })() : mod.dir,
    readFile: rel => modRead(mod, rel),                                     // works for folders and packages
    saveConfig: values => { const st = readState(); st.settings[mod.id] = { ...(st.settings[mod.id] || {}), ...values }; writeState(st); },
    userData: (() => { try { return app.getPath('userData'); } catch (_) { return ''; } })(), log: (...a) => log(`[${mod.id}]`, ...a),
    // route(name, async (body) => result): callable from the mod's renderer scripts as POST /mod/<id>/<name> (loopback + token)
    route: (name, fn) => { if (/^[a-z0-9-]+$/i.test(name) && typeof fn === 'function') modRoutes.set(mod.id + '/' + name, fn); } };
  if (mod.manifest.main) {
    const entry = modRequire(mod, mod.manifest.main);
    if (entry && typeof entry.start === 'function') entry.start(api);
  }
  for (const [rel, f] of staged) { const t = files.get(rel); t.text = f.text; t.dirty = true; }
}

function loadAll(mods, state) {
  const candidates = mods.filter(m => m.manifest);
  for (const m of candidates) m.status = state.enabled[m.id] === false ? 'disabled' : 'pending';
  const byId = new Map(candidates.map(m => [m.id, m]));
  const order = [], mark = new Map();
  const visit = m => {
    if (mark.get(m) === 'done') return;
    if (mark.get(m) === 'temp') { m.cycle = true; return; }
    mark.set(m, 'temp');
    for (const r of m.manifest.requires || []) { const d = byId.get(r); if (d) visit(d); }
    mark.set(m, 'done'); order.push(m);
  };
  candidates.forEach(visit);
  for (const m of order) {
    if (m.status !== 'pending') continue;
    if (m.cycle) { m.status = 'failed'; m.message = 'circular "requires"'; continue; }
    const missing = (m.manifest.requires || []).filter(id => byId.get(id)?.status !== 'loaded');
    if (missing.length) { m.status = 'failed'; m.message = 'requires: ' + missing.join(', ') + ' (missing, disabled or failed)'; continue; }
    try { applyMod(m); m.status = 'loaded'; loadedMods.push(m); log('loaded', m.id, m.version); }
    catch (e) { m.status = 'failed'; m.message = String(e.message || e).slice(0, 400); log('FAILED', m.id, e); }
  }
}

// ------------------------------------------------------------------ worker cache
function buildWorkerCache() {
  const map = {};
  const workerFiles = [...files.entries()].filter(([rel, f]) => f.dirty && /^renderer\/[^/]*worker[^/]*\.js$/i.test(rel));
  if (!workerFiles.length) return map;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const names = workerFiles.map(([rel]) => path.posix.basename(rel));
  // Prelude: the cached copy lives elsewhere, so give it the ORIGINAL location (the game resolves its data files and
  // nested workers relative to `location`), and keep nested workers on their patched copies too.
  const prelude = (rel) => {
    const orig = pathToFileURL(path.join(APP, rel)).href;
    return `var location={href:${JSON.stringify(orig)},origin:"file://",protocol:"file:",host:"",hostname:"",port:"",pathname:${JSON.stringify(new URL(orig).pathname)},search:"",hash:"",toString(){return this.href}};` +
      `(function(){var M=__GEOMOD_WORKERS__,W=self.Worker;if(W)self.Worker=class extends W{constructor(u,o){var k=String(u).split("?")[0].split("/").pop();super(Object.prototype.hasOwnProperty.call(M,k)?M[k]:u,o)}}})();\n`;
  };
  const bodies = new Map();
  for (const [rel, f] of workerFiles) {
    const body = Buffer.from(f.text, f.enc);
    const hash = crypto.createHash('sha256').update(rel).update(body).digest('hex').slice(0, 12);
    const base = path.posix.basename(rel).replace(/\.js$/i, '');
    const file = path.join(CACHE_DIR, `${base}.${hash}.js`);
    map[path.posix.basename(rel)] = pathToFileURL(file).href;
    bodies.set(file, { rel, body, base });
  }
  for (const [file, { rel, body, base }] of bodies) {
    const head = Buffer.from(prelude(rel).replace('__GEOMOD_WORKERS__', () => JSON.stringify(map)), 'utf8');
    const content = Buffer.concat([head, body]);
    let ok = false;
    try { ok = fs.statSync(file).size === content.length; } catch (_) {}
    if (!ok) fs.writeFileSync(file, content);
    try { for (const old of fs.readdirSync(CACHE_DIR)) if (old.startsWith(base + '.') && path.join(CACHE_DIR, old) !== file && /\.[0-9a-f]{12}\.js$/.test(old)) fs.unlinkSync(path.join(CACHE_DIR, old)); } catch (_) {}
  }
  return map;
}

// ------------------------------------------------------------------ page assembly
function mergeCsp(csp, extra) {
  const dirs = new Map();
  for (const part of csp.split(';')) { const t = part.trim().split(/\s+/).filter(Boolean); if (t.length) dirs.set(t[0], t.slice(1)); }
  for (const [name, sources] of Object.entries(extra)) {
    const cur = dirs.get(name) || (dirs.get('default-src') || []).slice();
    for (const s of sources) if (!cur.includes(s)) cur.push(s);
    dirs.set(name, cur);
  }
  return [...dirs].map(([k, v]) => [k, ...v].join(' ')).join('; ');
}

let apiPort = 0, apiToken = '', workerMap = {}, bootState = null;
function snapshot() { return Object.fromEntries(loadedMods.map(m => [m.id, true])); }

function indexHtml() {
  const rel = 'renderer/index.html';
  let html = files.has(rel) ? files.get(rel).text : fs.readFileSync(path.join(APP, rel), 'utf8');
  const extra = { 'connect-src': [`http://127.0.0.1:${apiPort}`] };
  for (const m of loadedMods) for (const [k, v] of Object.entries(m.manifest.csp || {})) extra[k] = [...(extra[k] || []), ...v];
  html = html.replace(/(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/i, (_, a, csp, c) => a + mergeCsp(csp, extra) + c);
  let tail = '<script defer src="__geomod/ui.js"></script>';
  for (const m of loadedMods) {
    for (const f of strList(m.manifest.css)) tail += `<link rel="stylesheet" href="__geomod/mods/${m.id}/${norm(f)}">`;
    for (const f of strList(m.manifest.renderer)) tail += `<script defer src="__geomod/mods/${m.id}/${norm(f)}"></script>`;
  }
  html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, h => h + '<script src="__geomod/boot.js"></script>') : '<script src="__geomod/boot.js"></script>' + html;
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, tail + '</head>') : html + tail;
}

function bootJs(state) {
  const cfg = { port: apiPort, token: apiToken, loaderVersion: LOADER_VERSION, hotkey: state.hotkey, bannerSeconds: state.bannerSeconds,
    workers: workerMap, loaded: loadedMods.length, failed: allMods.filter(m => m.status === 'failed').length };
  return `window.__GEOMOD=${JSON.stringify(cfg)};(function(){var W=window.Worker,G=window.__GEOMOD,M=G.workers;G.NativeWorker=W;G.spawned=[];if(W)window.Worker=class extends W{constructor(u,o){var k=String(u).split("?")[0].split("#")[0].split("/").pop(),has=Object.prototype.hasOwnProperty.call(M,k);G.spawned.push(k+(has?" (patched)":""));super(has?M[k]:u,o)}}})();`;
}

function virtual(sub, state) {
  const send = (body, ext) => new Response(body, { headers: { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' } });
  if (sub === 'boot.js') return send(bootJs(state), '.js');
  if (sub === 'ui.js') return send(SEAL.ui != null ? SEAL.ui : fs.readFileSync(path.join(__dirname, 'ui.js')), '.js');
  const m = /^mods\/([a-z0-9-]+)\/(.+)$/.exec(sub);
  if (m) {
    const mod = loadedMods.find(x => x.id === m[1]);
    const declared = mod && [...strList(mod.manifest.renderer), ...strList(mod.manifest.css)].map(norm);
    if (mod && declared.includes(m[2])) return send(modRead(mod, m[2]), path.extname(m[2]).toLowerCase());
  }
  return new Response('not found', { status: 404 });
}

// ------------------------------------------------------------------ loopback API for the in-game panel
let allMods = [];
const modRoutes = new Map();
let bootSettings = {};
function settingValues(m, state) {
  const out = {}, stored = state.settings[m.id] || {};
  for (const d of (m.manifest && m.manifest.settings) || []) out[d.key] = stored[d.key] !== undefined ? stored[d.key] : (m.manifest.config && m.manifest.config[d.key] !== undefined ? m.manifest.config[d.key] : d.default);
  return out;
}
function cleanSetting(d, v) {
  if (d.type === 'bool') return !!v;
  if (d.type === 'number') {
    let n = Number(v); if (!Number.isFinite(n)) throw new Error(`${d.label}: not a number`);
    if (Number.isFinite(d.min)) n = Math.max(d.min, n); if (Number.isFinite(d.max)) n = Math.min(d.max, n);
    if (Number.isFinite(d.step) && d.step > 0) n = Math.round(n / d.step) * d.step;
    return +n.toPrecision(10);
  }
  if (d.type === 'select') { const vals = d.options.map(o => (o && typeof o === 'object') ? o.value : o); if (!vals.includes(v)) throw new Error(`${d.label}: not an allowed option`); return v; }
  return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').slice(0, Number.isInteger(d.maxLength) ? Math.min(d.maxLength, 2000) : 200);
}
function setSettings(id, values) {
  const mod = allMods.find(m => m.id === id && m.manifest);
  if (!mod || !(mod.manifest.settings || []).length) throw new Error('this mod has no settings');
  const st = readState(), cur = st.settings[id] || {}, next = { ...cur };
  for (const d of mod.manifest.settings) if (values && Object.prototype.hasOwnProperty.call(values, d.key)) next[d.key] = cleanSetting(d, values[d.key]);
  st.settings[id] = next; writeState(st); log('settings', id);
  return st;
}
const settingsChanged = (m, state) => JSON.stringify(state.settings[m.id] || {}) !== JSON.stringify(bootSettings[m.id] || {});

// Build a locked package from a plain mod folder (the in-game "Create" tab).
function packMod(id, moveSource) {
  const mod = allMods.find(m => m.id === id && m.manifest && !m.packaged);
  if (!mod) throw new Error('unknown mod, or it is already a package');
  const files = new Map(); let total = 0;
  (function walk(dir, rel) {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.name === '.git' || /\.geomod$/i.test(d.name)) continue;
      const r = rel ? rel + '/' + d.name : d.name, full = path.join(dir, d.name);
      if (d.isDirectory()) walk(full, r);
      else if (d.isFile()) { const b = fs.readFileSync(full); total += b.length; if (total > 64 * 1024 * 1024) throw new Error('mod is larger than 64 MB'); files.set(r, b); }
    }
  })(mod.dir, '');
  if (!files.has('mod.json')) throw new Error('mod.json missing');
  const m = mod.manifest;
  const header = { id: m.id, name: m.name, version: m.version, author: m.author, description: m.description, requires: m.requires, loaderApi: 1,
    settings: m.settings, created: new Date().toISOString() };
  const out = pkgSeal(header, files);
  const dest = path.join(MODS_DIR, m.id + '.geomod'), tmp = dest + '.tmp';
  fs.writeFileSync(tmp, out); fs.renameSync(tmp, dest);
  pkgOpen(dest);                                                   // verify it opens before touching the source
  let moved = null;
  if (moveSource) {
    mod.pkg = files;                                              // keep serving this session from memory once the folder is gone
    fs.mkdirSync(SOURCES_DIR, { recursive: true });
    let to = path.join(SOURCES_DIR, mod.folder); if (fs.existsSync(to)) to += '-' + Date.now();
    fs.renameSync(mod.dir, to); moved = path.relative(ROOT, to);
  }
  log('packed', m.id, files.size + ' files', moved ? 'source moved to ' + moved : 'source kept');
  return { file: path.relative(ROOT, dest), files: files.size, moved, dev: !!SEAL.dev };
}

function publicState(state) {
  const now = snapshot();
  const mods = allMods.filter(m => !m.hidden).map(m => {
    const enabled = m.manifest ? state.enabled[m.id] !== false : false;
    const sc = !!m.manifest && settingsChanged(m, state);
    return { id: m.id, name: m.name, version: m.version, author: m.author, description: m.description, enabled,
      status: m.status, message: m.message, changed: !!m.manifest && (enabled !== !!now[m.id] || (enabled && sc)),
      locked: !!m.packaged, settings: (m.manifest && m.manifest.settings) || [], values: settingValues(m, state) };
  });
  return { loaderVersion: LOADER_VERSION, modsDir: MODS_DIR, mods, restartRequired: mods.some(m => m.changed), sealed: !SEAL.dev };
}
function startApi(state) {
  apiToken = crypto.randomBytes(16).toString('hex');
  const server = http.createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'x-geomod-token, content-type',
      'access-control-allow-private-network': 'true', 'cache-control': 'no-store' };
    const json = (code, body) => { res.writeHead(code, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    if (req.headers['x-geomod-token'] !== apiToken) return json(403, { ok: false });
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size < (req.url.startsWith('/mod/') ? 4194304 : 16384)) chunks.push(c); });
    req.on('end', () => {
      try {
        const st = readState();
        if (req.method === 'GET' && req.url === '/state') return json(200, publicState(st));
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (req.method === 'POST' && req.url.startsWith('/mod/')) {
          const fn = modRoutes.get(req.url.slice(5));
          if (!fn) return json(404, { ok: false, error: 'no such route' });
          return Promise.resolve().then(() => fn(body)).then(r => json(200, { ok: true, result: r }), e => json(200, { ok: false, error: String((e && e.message) || e) }));
        }
        if (req.method === 'POST' && req.url === '/toggle') {
          const mod = allMods.find(m => m.id === body.id && m.manifest);
          if (!mod || typeof body.enabled !== 'boolean') return json(400, { ok: false });
          st.enabled[mod.id] = body.enabled; writeState(st); log('toggle', mod.id, body.enabled);
          return json(200, publicState(st));
        }
        if (req.method === 'POST' && req.url === '/settings') {
          try { return json(200, publicState(setSettings(String(body.id), body.values))); } catch (e) { return json(400, { ok: false, error: String(e.message || e) }); }
        }
        if (req.method === 'POST' && req.url === '/pack') {
          try { const old = allMods.find(m => m.id === String(body.id) && !m.packaged);
            const r = packMod(String(body.id), !!body.moveSource);
            if (r.moved) { const fresh = discover().find(m => m.packaged && m.id === old.id); if (fresh) { fresh.status = old.status; fresh.message = 'locked package created - restart to load it'; old.hidden = true; allMods.push(fresh); } }
            return json(200, { ok: true, ...r, state: publicState(readState()) }); }
          catch (e) { log('pack failed', e); return json(400, { ok: false, error: String(e.message || e) }); }
        }
        if (req.method === 'POST' && req.url === '/open-folder') { shell.openPath(MODS_DIR); return json(200, { ok: true }); }
        if (req.method === 'POST' && req.url === '/restart') { json(200, { ok: true }); setTimeout(() => { app.relaunch(); app.quit(); }, 150); return; }
        json(404, { ok: false });
      } catch (e) { json(400, { ok: false, error: String(e.message || e) }); }
    });
  });
  return new Promise(resolve => { server.on('error', e => { log('api error', e); resolve(); }); server.listen(0, '127.0.0.1', () => { apiPort = server.address().port; resolve(); }); });
}

// ------------------------------------------------------------------ boot
const README = `Geoplanetical mods
==================
Put mods in this folder: one sub-folder per mod, each with a mod.json.
Press HOME in the game to turn mods on/off (changes apply after a restart).
Folders starting with "_" or "." are ignored. Mod authors: see ModLoader/MODDING.md.
`;

app.whenReady().then(async () => {
  try {
    APP = app.getAppPath();
    fs.mkdirSync(MODS_DIR, { recursive: true });
    try { if (!fs.existsSync(path.join(MODS_DIR, 'README.txt'))) fs.writeFileSync(path.join(MODS_DIR, 'README.txt'), README); } catch (_) {}
    const state = readState();
    bootSettings = JSON.parse(JSON.stringify(state.settings));
    allMods = discover();
    log(`Mod Loader ${LOADER_VERSION}${SEAL.dev ? ' (UNSEALED dev build)' : ' (sealed)'}; app=${APP}; ${allMods.length} mod(s)`);
    loadAll(allMods, state);
    workerMap = buildWorkerCache();
    await startApi(state);

    const appLower = APP.toLowerCase() + path.sep;
    const missing = new Set();
    protocol.handle('file', async req => {
      try {
        const url = new URL(req.url);
        if (!url.host) {
          const p = fileURLToPath(url);
          if (p.toLowerCase().startsWith(appLower)) {
            const rel = norm(p.slice(APP.length + 1));
            if (rel.startsWith('renderer/__geomod/')) return virtual(rel.slice('renderer/__geomod/'.length), readState());
            if (rel === 'renderer/index.html') return new Response(indexHtml(), { headers: { 'content-type': MIME['.html'], 'cache-control': 'no-store' } });
            const f = files.get(rel);
            if (f && f.dirty) return new Response(Buffer.from(f.text, f.enc), { headers: { 'content-type': MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' } });
          }
        }
      } catch (e) { log('protocol error', req.url, e); }
      try { return await net.fetch(req, { bypassCustomProtocolHandlers: true }); }
      catch (e) {                                    // the game probes for optional files: answer 404 quietly instead of leaking an unhandled rejection
        if (missing.size < 25 && !missing.has(req.url)) { missing.add(req.url); log('not found (passed through):', req.url); }
        return new Response(null, { status: 404 });
      }
    });
    log(`ready: ${loadedMods.length} loaded, ${allMods.filter(m => m.status === 'failed').length} failed, api port ${apiPort}`);
  } catch (e) { log('Mod Loader failed to start', e); }
});
