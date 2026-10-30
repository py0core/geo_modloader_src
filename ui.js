(() => {
  'use strict';
  // Geoplanetical Mod Loader - in-game UI: a short toast on the main menu and a mod panel on the HOME key.
  const G = window.__GEOMOD;
  if (!G || window.__GEOMOD_UI) return;
  window.__GEOMOD_UI = true;
  const base = 'http://127.0.0.1:' + G.port;
  const api = async (path, body) => {
    const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'x-geomod-token': G.token, 'content-type': 'text/plain' },
      body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) { let m = 'HTTP ' + r.status; try { const j = await r.json(); if (j && j.error) m = j.error; } catch (_) {} throw new Error(m); }
    return r.json();
  };

  const host = document.createElement('div');
  host.id = 'geomod-host';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: Consolas, "Lucida Console", "DejaVu Sans Mono", monospace; font-size: 13px; }
    /* Dear ImGui "dark" palette, as used by the ReShade overlay */
    .toast { position: fixed; top: 8px; left: 10px; color: #fff; line-height: 1.45; text-shadow: 1px 1px 0 #000, 0 0 3px #000; opacity: 0; transition: opacity .2s; pointer-events: none; white-space: pre; }
    .toast.show { opacity: 1; }
    .toast .dim { color: #b3b3b3; } .toast .ok { color: #7fe27f; } .toast .bad { color: #ff7d7d; }
    .panel { position: fixed; top: 40px; left: 40px; width: 480px; max-width: calc(100vw - 20px); max-height: calc(100vh - 80px); display: none; flex-direction: column;
      background: rgba(15,15,15,.94); color: #fff; border: 1px solid rgba(110,110,128,.5); pointer-events: auto; }
    .panel.open { display: flex; }
    .title { display: flex; align-items: center; justify-content: space-between; padding: 3px 6px 3px 8px; background: #29487a; cursor: move; user-select: none; }
    .title b { font-weight: normal; } .title .x { cursor: pointer; padding: 0 6px; color: #fff; background: none; border: 0; }
    .title .x:hover { background: rgba(255,255,255,.18); }
    .tabs { display: flex; gap: 2px; padding: 6px 8px 0; border-bottom: 1px solid rgba(110,110,128,.5); }
    .tab { padding: 3px 12px; background: rgba(66,150,250,.31); color: #fff; border: 0; cursor: pointer; }
    .tab:hover { background: rgba(66,150,250,.8); } .tab.on { background: rgba(66,150,250,.68); }
    .body { overflow: auto; padding: 8px; min-height: 80px; }
    .body::-webkit-scrollbar { width: 12px; } .body::-webkit-scrollbar-track { background: rgba(5,5,5,.53); } .body::-webkit-scrollbar-thumb { background: #4f4f4f; } .body::-webkit-scrollbar-thumb:hover { background: #696969; }
    .empty, .about { color: #b3b3b3; line-height: 1.55; padding: 4px 2px; white-space: normal; } .about b { color: #fff; font-weight: normal; } .about hr, hr.sep { border: 0; border-top: 1px solid rgba(110,110,128,.5); margin: 8px 0; }
    .mod { display: grid; grid-template-columns: auto 1fr auto; gap: 1px 8px; align-items: center; padding: 5px 4px; border-bottom: 1px solid rgba(110,110,128,.22); }
    .mod:hover { background: rgba(66,150,250,.1); }
    .name { color: #fff; } .ver { color: #808080; margin-left: 8px; }
    .desc { grid-column: 2 / span 2; color: #b3b3b3; line-height: 1.4; font-size: 12px; }
    .chip { grid-column: 3; grid-row: 1; justify-self: end; } .loaded { color: #7fe27f; } .disabled { color: #808080; } .failed { color: #ff7d7d; } .pending { color: #ffd24d; }
    .msg { grid-column: 2 / span 2; color: #ff7d7d; font-size: 12px; line-height: 1.35; word-break: break-word; }
    .sw { grid-row: 1; grid-column: 1; position: relative; width: 16px; height: 16px; padding: 0; border: 0; cursor: pointer; background: rgba(41,74,122,.54); }
    .sw:hover { background: rgba(66,150,250,.4); }
    .sw[aria-checked="true"]::after { content: ""; position: absolute; left: 5px; top: 1px; width: 4px; height: 9px; border: solid #4296fa; border-width: 0 2px 2px 0; transform: rotate(40deg); }
    .sw:disabled { opacity: .35; cursor: not-allowed; }
    .restart { display: none; color: #ffd24d; padding: 6px 8px; border-top: 1px solid rgba(110,110,128,.5); align-items: center; justify-content: space-between; gap: 10px; }
    .restart.show { display: flex; }
    .foot { display: flex; gap: 6px; align-items: center; justify-content: space-between; padding: 6px 8px; border-top: 1px solid rgba(110,110,128,.5); color: #808080; }
    .lockb { color: #ffd24d; margin-left: 8px; font-size: 11px; } a.lnk { color: #4296fa; cursor: pointer; margin-left: 10px; font-size: 12px; } a.lnk:hover { text-decoration: underline; }
    .sets { grid-column: 1 / -1; margin: 4px 0 2px 24px; padding: 4px 8px; background: rgba(41,74,122,.18); display: grid; grid-template-columns: 1fr 150px 56px; gap: 3px 8px; align-items: center; }
    .sets .l { color: #b3b3b3; } .sets .h { grid-column: 1 / -1; color: #808080; font-size: 12px; margin-top: -2px; }
    .sets select, .sets input[type=text], .sets input[type=number] { background: rgba(41,74,122,.54); color: #fff; border: 0; padding: 2px 4px; outline: none; max-width: 100%; } .sets select option { background: #1a1a1a; }
    .sets input[type=range] { accent-color: #4296fa; width: 100%; } .sets input[type=checkbox] { accent-color: #4296fa; justify-self: start; }
    .crow { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; align-items: center; padding: 6px 4px; border-bottom: 1px solid rgba(110,110,128,.22); } .crow .desc { grid-column: 1 / -1; color: #b3b3b3; font-size: 12px; }
    .okt { color: #7fe27f; } .warnt { color: #ffd24d; } .badt { color: #ff7d7d; }
    button.btn { background: rgba(66,150,250,.4); color: #fff; border: 0; padding: 3px 10px; cursor: pointer; }
    button.btn:hover { background: #4296fa; } button.btn:active { background: #0f87fa; }
  </style>
  <div class="toast" id="toast"></div>
  <div class="panel" id="panel" role="dialog" aria-label="Mod Loader">
    <div class="title" id="title"><b id="titleText">Mod Loader</b><button class="x" id="closeBtn" title="Close">x</button></div>
    <div class="tabs"><button class="tab on" data-tab="mods">Mods</button><button class="tab" data-tab="create">Create</button><button class="tab" data-tab="about">About</button></div>
    <div class="body" id="list"></div>
    <div class="restart" id="restart"><span>Restart the game to apply your changes.</span><button class="btn" id="restartBtn">Restart now</button></div>
    <div class="foot"><span id="hint">HOME: close</span><button class="btn" id="folderBtn">Open mods folder</button></div>
  </div>`;
  const $ = id => root.getElementById(id);
  for (const ev of ['keyup', 'keypress', 'wheel', 'contextmenu']) host.addEventListener(ev, e => e.stopPropagation());   // typing in the panel must not trigger game shortcuts
  host.addEventListener('keydown', e => { if (e.key !== 'Escape' && !((e.code || '').toUpperCase() === (G.hotkey || 'Home').toUpperCase())) e.stopPropagation(); });
  const attach = () => { if (!host.isConnected) (document.body || document.documentElement).appendChild(host); };

  // ---- toast on the main menu
  let toastTimer = null;
  const showToast = (html, ms) => {
    const t = $('toast'); t.innerHTML = html; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  };
  const keyName = (G.hotkey || 'Home').toUpperCase();
  const announce = () => {
    const n = G.loaded, f = G.failed;
    const head = n === 0 && f === 0 ? 'No mods installed' : `<b>${n}</b> mod${n === 1 ? '' : 's'} loaded`;
    showToast(`Mod Loader by py_core ${G.loaderVersion || ''}\n${n === 0 && f === 0 ? 'No mods installed.' : `<span class="ok">${n}</span> mod${n === 1 ? '' : 's'} loaded`}${f ? `, <span class="bad">${f} failed</span>` : ''}.\n<span class="dim">Press ${keyName} to open the mod menu.</span>`, Math.max(2, G.bannerSeconds || 6) * 1000);
  };
  let announced = false;
  // The game shows its own splash (#loading, which gets .is-done when finished) above the main menu: announce once it is gone.
  const splashGone = () => {
    const l = document.getElementById('loading');
    if (!l || !l.isConnected || l.classList.contains('is-done')) return true;
    const cs = getComputedStyle(l);
    return cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05;
  };
  const waitForMenu = () => {
    const t0 = Date.now();
    const tick = () => {
      if (announced) return;
      const menu = document.getElementById('screen-menu');
      const ready = menu && menu.classList.contains('active') && splashGone();
      if (ready || Date.now() - t0 > 180000) { announced = true; setTimeout(announce, ready ? 600 : 0); return; }
      setTimeout(tick, 400);
    };
    tick();
  };

  // ---- panel
  let state = null;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let tab = 'mods';
  const openSets = new Set(); let packMsg = null, moveSrc = true;
  const aboutHtml = () => `<div class="about"><b>Geoplanetical Mod Loader</b> ${esc(state ? state.loaderVersion : '')}<hr>
    Mods live in the <b>mods</b> folder next to the game: one folder per mod, with a mod.json inside.<br>
    Tick or untick a mod here; changes apply after restarting the game.<br><br>
    Menu key: <b>${esc(keyName)}</b> (change "hotkey" in mods/_loader.json)<br>
    Start with all mods off: launcher option <b>--safe</b><br>
    Share a mod without its source: <b>Create</b> tab (locks it into one .geomod file)<br>
    Put the original game files back: <b>loader.py restore</b></div>`;
  const setsHtml = m => {
    const rows = m.settings.map(d => {
      const v = m.values[d.key], id = 'k=' + esc(d.key);
      let ctl = '';
      if (d.type === 'bool') ctl = `<input type="checkbox" data-k="${esc(d.key)}" ${v ? 'checked' : ''}><span></span>`;
      else if (d.type === 'select') ctl = `<select data-k="${esc(d.key)}" style="grid-column:2/4">${d.options.map(o => { const val = (o && typeof o === 'object') ? o.value : o, lab = (o && typeof o === 'object') ? (o.label || o.value) : o; return `<option value="${esc(val)}" ${val === v ? 'selected' : ''}>${esc(lab)}</option>`; }).join('')}</select>`;
      else if (d.type === 'text') ctl = `<input type="text" data-k="${esc(d.key)}" value="${esc(v)}" maxlength="${d.maxLength || 200}" style="grid-column:2/4">`;
      else {
        const lo = Number.isFinite(d.min) ? d.min : 0, hi = Number.isFinite(d.max) ? d.max : 100, st = Number.isFinite(d.step) ? d.step : 'any';
        ctl = Number.isFinite(d.min) && Number.isFinite(d.max)
          ? `<input type="range" min="${lo}" max="${hi}" step="${st}" value="${esc(v)}" data-k="${esc(d.key)}"><input type="number" min="${lo}" max="${hi}" step="${st}" value="${esc(v)}" data-kn="${esc(d.key)}">`
          : `<input type="number" step="${st}" value="${esc(v)}" data-k="${esc(d.key)}" style="grid-column:2/4">`;
      }
      return `<span class="l">${esc(d.label)}</span>${ctl}${d.help ? `<span class="h">${esc(d.help)}</span>` : ''}`;
    }).join('');
    return `<div class="sets" data-sid="${esc(m.id)}">${rows}</div>`;
  };
  const createHtml = () => {
    const plain = state.mods.filter(m => !m.locked && m.status !== 'failed' && m.id);
    const head = `<div class="about"><b>Lock a mod into one file</b><hr>Packs a mod folder into a single encrypted <b>.geomod</b> file. Share that file; players can enable it and change the
      settings you expose (a "settings" list in mod.json), but cannot read or edit its code or config. ${state.sealed ? '' : '<br><span class="warnt">This loader build is not sealed (development): packages made now will not open on other copies.</span>'}</div>
      <label class="desc" style="display:block;margin:6px 4px;color:#b3b3b3"><input type="checkbox" id="moveSrc" ${moveSrc ? 'checked' : ''}> move the original folder to mods/_sources afterwards (keep this on: a folder and its package can't both load)</label>`;
    const msg = packMsg ? `<div class="${packMsg.ok ? 'okt' : 'badt'}" style="margin:4px;white-space:pre-wrap">${esc(packMsg.text)}</div>` : '';
    if (!plain.length) return head + msg + '<div class="empty">No unlocked mods to pack.</div>';
    return head + msg + plain.map(m => `<div class="crow"><div><span class="name">${esc(m.name)}</span><span class="ver">v${esc(m.version)}</span></div>
      <button class="btn" data-pack="${esc(m.id)}">Encrypt</button><div class="desc">${esc(m.description)}</div></div>`).join('');
  };
  const render = () => {
    if (!state) return;
    $('titleText').textContent = 'Mod Loader ' + state.loaderVersion;
    $('hint').textContent = keyName + ': close';
    $('restart').classList.toggle('show', !!state.restartRequired);
    root.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.dataset.tab === tab));
    const list = $('list');
    if (tab === 'about') { list.innerHTML = aboutHtml(); return; }
    if (tab === 'create') { list.innerHTML = createHtml(); return; }
    if (!state.mods.length) { list.innerHTML = '<div class="empty">No mods found.<br>Drop mod folders into the "mods" folder next to the game, then restart.</div>'; return; }
    list.innerHTML = state.mods.map(m => {
      const canToggle = m.status !== 'failed' || m.enabled;
      const label = m.changed ? (m.enabled ? 'loads after restart' : 'unloads after restart') : m.status;
      const cls = m.changed ? 'pending' : m.status;
      return `<div class="mod" data-id="${esc(m.id)}">
        <button class="sw" role="checkbox" aria-checked="${m.enabled}" ${m.status === 'failed' && !m.enabled ? 'disabled' : ''} title="${canToggle ? 'Enable / disable' : ''}"></button>
        <div><span class="name">${esc(m.name)}</span><span class="ver">v${esc(m.version)}${m.author ? ' by ' + esc(m.author) : ''}</span>${m.locked ? '<span class="lockb">[locked]</span>' : ''}${m.settings.length ? `<a class="lnk" data-sets="${esc(m.id)}">${openSets.has(m.id) ? 'hide settings' : 'settings'}</a>` : ''}</div>
        <span class="chip ${cls}">${esc(label)}</span>
        <div class="desc">${esc(m.description)}</div>
        ${m.message ? `<div class="msg">${esc(m.message)}</div>` : ''}${m.settings.length && openSets.has(m.id) ? setsHtml(m) : ''}</div>`;
    }).join('');
  };
  const refresh = async () => { try { state = await api('/state'); render(); } catch (e) { $('list').innerHTML = '<div class="empty">Could not reach the mod loader.</div>'; } };
  const open = async () => { attach(); $('panel').classList.add('open'); await refresh(); };
  const close = () => $('panel').classList.remove('open');
  const isOpen = () => $('panel').classList.contains('open');

  root.addEventListener('click', async e => {
    const sw = e.target.closest && e.target.closest('.sw');
    if (sw && !sw.disabled) {
      const id = sw.closest('.mod').dataset.id;
      const on = sw.getAttribute('aria-checked') !== 'true';
      sw.disabled = true;
      try { state = await api('/toggle', { id, enabled: on }); render(); } catch (_) { sw.disabled = false; }
    }
    const sl = e.target.closest && e.target.closest('[data-sets]');
    if (sl) { const id = sl.dataset.sets; openSets.has(id) ? openSets.delete(id) : openSets.add(id); render(); return; }
    const pk = e.target.closest && e.target.closest('[data-pack]');
    if (pk && !pk.disabled) {
      pk.disabled = true; pk.textContent = 'Encrypting...';
      try { const r = await api('/pack', { id: pk.dataset.pack, moveSource: moveSrc }); state = r.state;
        packMsg = { ok: true, text: `Created ${r.file} (${r.files} files).` + (r.moved ? `\nOriginal moved to ${r.moved}.` : '\nThe original folder is still in mods/ - move it away before restarting or the package will be rejected as a duplicate.') + (r.dev ? '\nDevelopment build: this package only opens on this build.' : '') + '\nRestart the game to use the locked version.' };
      } catch (err) { packMsg = { ok: false, text: String(err.message || err) }; }
      render(); return;
    }
    if (e.target.id === 'restartBtn' && window.confirm('Restart the game now? Save first if needed.')) api('/restart', {});
    if (e.target.id === 'folderBtn') api('/open-folder', {});
    if (e.target.id === 'closeBtn') close();
    const tb = e.target.closest && e.target.closest('.tab');
    if (tb) { tab = tb.dataset.tab; render(); }
  });
  const commit = async (sid, key, val) => {
    try { state = await api('/settings', { id: sid, values: { [key]: val } }); $('restart').classList.toggle('show', !!state.restartRequired);
      const m = state.mods.find(x => x.id === sid), row = root.querySelector(`.mod[data-id="${sid}"] .chip`); if (m && row) { row.textContent = m.changed ? 'applies after restart' : m.status; row.className = 'chip ' + (m.changed ? 'pending' : m.status); }
    } catch (err) { packMsg = { ok: false, text: String(err.message || err) }; }
  };
  const debounce = new Map();
  const onSetting = (e, final) => {
    const el = e.target, box = el.closest && el.closest('.sets'); if (!box) return;
    const key = el.dataset.k || el.dataset.kn; if (!key) return;
    const val = el.type === 'checkbox' ? el.checked : el.value;
    if (el.type === 'range') { const n = box.querySelector(`[data-kn="${key}"]`); if (n) n.value = el.value; }
    if (el.dataset.kn) { const r = box.querySelector(`[data-k="${key}"]`); if (r) r.value = el.value; }
    const dk = box.dataset.sid + ':' + key; clearTimeout(debounce.get(dk));
    debounce.set(dk, setTimeout(() => commit(box.dataset.sid, key, el.type === 'number' || el.type === 'range' ? Number(val) : val), final ? 0 : 350));
  };
  root.addEventListener('input', e => onSetting(e, false));
  root.addEventListener('change', e => { if (e.target.id === 'moveSrc') { moveSrc = e.target.checked; return; } onSetting(e, true); });
  // drag the window by its title bar, like any ImGui window
  (() => {
    const p = $('panel'), t = $('title'); let d = null;
    t.addEventListener('pointerdown', e => { if (e.target.id === 'closeBtn') return; const r = p.getBoundingClientRect(); d = { x: e.clientX - r.left, y: e.clientY - r.top }; t.setPointerCapture(e.pointerId); });
    t.addEventListener('pointermove', e => { if (!d) return; p.style.left = Math.max(0, Math.min(innerWidth - 80, e.clientX - d.x)) + 'px'; p.style.top = Math.max(0, Math.min(innerHeight - 40, e.clientY - d.y)) + 'px'; });
    t.addEventListener('pointerup', () => { d = null; });
  })();

  const matches = e => (e.code || '').toUpperCase() === (G.hotkey || 'Home').toUpperCase() || (e.key || '').toUpperCase() === (G.hotkey || 'Home').toUpperCase();
  const swallow = e => { e.preventDefault(); e.stopImmediatePropagation(); };
  window.addEventListener('keydown', e => {
    if (matches(e)) {
      const t = e.target, typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (typing && !isOpen()) return;
      swallow(e); if (!e.repeat) (isOpen() ? close() : open());
    } else if (e.key === 'Escape' && isOpen()) { swallow(e); close(); }
  }, true);
  window.addEventListener('keyup', e => { if (matches(e)) swallow(e); }, true);

  const start = () => { attach(); waitForMenu(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
