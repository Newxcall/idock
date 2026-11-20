import { closeSheet } from './sheets.js';
// Dock: App-Raster wie am iPhone-Home-Bildschirm. Antippen startet die App am PC.
// Bearbeiten: wackelnde Icons, „−“ entfernt, ziehen sortiert um (an den Rand ziehen = andere Seite),
// „+ App“ fügt hinzu, „+ Seite“ legt eine neue Seite an, eigener Hintergrund.

export function initDock({ root, conn, toast }) {
  const pagesEl = root.querySelector('#dock-pages');
  const dotsEl = root.querySelector('#dock-dots');
  const bgEl = root.querySelector('#dock-bg');
  const editBtn = root.querySelector('#dock-edit');
  const tools = root.querySelector('#dock-tools');
  const fileInput = root.querySelector('#dock-file');
  const appsSheet = document.querySelector('#apps-sheet');
  const appsList = document.querySelector('#apps-list');
  const appsSearch = document.querySelector('#apps-search');
  const wallSheet = document.querySelector('#wall-sheet');

  let dock = null;          // { pages: [{ items: [{id, name}] }], wallpaper }
  let apps = null;          // alle Windows-Apps [{id, name}]
  let editing = false;
  let page = 0;
  let drag = null;
  let serverDockWhileDragging = null;

  pagesEl.innerHTML = '<p class="dock-empty">Dock wird geladen …</p>';

  const token = () => encodeURIComponent(conn.token || '');
  const iconUrl = (id) => `api/icon?id=${encodeURIComponent(id)}&t=${token()}`;

  /* ---------- Nachrichten vom PC ---------- */

  conn.on('dock', (m) => {
    if (drag) { serverDockWhileDragging = m.dock; return; }
    dock = m.dock;
    render();
  });
  conn.on('apps', (m) => { apps = m.items; renderAppList(); });
  conn.on('launched', (m) => { if (!m.ok) toast('Die App konnte nicht gestartet werden.'); });
  conn.addEventListener('state', (e) => { if (e.detail.state === 'online') conn.send({ t: 'dock.get' }); });

  function save() {
    conn.send({ t: 'dock.set', dock: { pages: dock.pages } });
  }

  /* ---------- Zeichnen ---------- */

  function render() {
    if (!dock) return;
    if (dock.wallpaper) {
      const v = dock.wallpaper;
      conn.imageUrl(`api/wallpaper?t=${token()}&v=${v}`)
        .then((u) => { if (dock && dock.wallpaper === v) bgEl.style.backgroundImage = `url("${u}")`; })
        .catch(() => { });
    } else {
      bgEl.style.backgroundImage = '';
    }
    root.classList.toggle('has-wallpaper', !!dock.wallpaper);
    root.classList.toggle('editing', editing);
    editBtn.textContent = editing ? 'Fertig' : 'Bearbeiten';
    tools.hidden = !editing;

    pagesEl.innerHTML = '';
    const total = dock.pages.reduce((n, p) => n + p.items.length, 0);
    dock.pages.forEach((p, pi) => {
      const pageEl = document.createElement('div');
      pageEl.className = 'dock-page';
      const grid = document.createElement('div');
      grid.className = 'dock-grid';
      grid.dataset.page = pi;
      p.items.forEach((item, ii) => grid.appendChild(makeTile(item, ii)));
      pageEl.appendChild(grid);
      if (!p.items.length) {
        const hint = document.createElement('p');
        hint.className = 'dock-empty';
        hint.textContent = total === 0 && !editing
          ? 'Noch keine Apps. Tippe oben auf „Bearbeiten“ und dann auf „+ App“.'
          : 'Leere Seite – tippe auf „+ App“ oder zieh eine App hierher.';
        pageEl.appendChild(hint);
      }
      pagesEl.appendChild(pageEl);
    });
    page = Math.min(page, dock.pages.length - 1);
    pagesEl.scrollLeft = page * pagesEl.clientWidth;
    renderDots();
  }

  function renderDots() {
    dotsEl.innerHTML = '';
    if (!dock || dock.pages.length < 2) return;
    dock.pages.forEach((_, i) => {
      const d = document.createElement('i');
      if (i === page) d.className = 'on';
      dotsEl.appendChild(d);
    });
  }

  // Beim Anzeigen des Reiters oder Drehen des Geräts: auf der aktuellen Seite bleiben.
  if (window.ResizeObserver) {
    new ResizeObserver(() => { if (!drag) pagesEl.scrollLeft = page * pagesEl.clientWidth; }).observe(pagesEl);
  }

  pagesEl.addEventListener('scroll', () => {
    const w = pagesEl.clientWidth || 1;
    const p = Math.round(pagesEl.scrollLeft / w);
    if (p !== page) { page = p; renderDots(); }
  });

  function iconEl(item) {
    const box = document.createElement('div');
    box.className = 'tile-icon';
    const img = document.createElement('img');
    conn.imageUrl(iconUrl(item.id)).then((u) => { img.src = u; }).catch(() => img.onerror && img.onerror());
    img.alt = '';
    img.draggable = false;
    img.loading = 'lazy';
    img.onerror = () => { box.textContent = (item.name || '?').trim().charAt(0).toUpperCase(); box.classList.add('ph'); };
    box.appendChild(img);
    return box;
  }

  function makeTile(item, index) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.style.setProperty('--wiggle-delay', `${(index % 5) * -0.07}s`);
    tile._item = item;
    tile.appendChild(iconEl(item));
    const label = document.createElement('span');
    label.textContent = item.name;
    tile.appendChild(label);
    if (editing) {
      const del = document.createElement('button');
      del.className = 'tile-del';
      del.setAttribute('aria-label', `${item.name} entfernen`);
      del.textContent = '−';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        removeItem(item);
      });
      tile.appendChild(del);
    }
    bindTile(tile, item);
    return tile;
  }

  /* ---------- Antippen, lange drücken, ziehen ---------- */

  function bindTile(tile, item) {
    let longPress = null, suppressClick = false;

    tile.addEventListener('touchstart', (e) => {
      if (e.target.closest('.tile-del')) return;
      const t = e.touches[0];
      drag = { tile, item, x0: t.clientX, y0: t.clientY, active: false, ghost: null, edgeTimer: null, edge: 0 };
      if (!editing) {
        longPress = setTimeout(() => {
          suppressClick = true;
          drag = null;
          setEditing(true);
        }, 550);
      }
    }, { passive: true });

    tile.addEventListener('touchmove', (e) => {
      if (!drag || drag.tile !== tile) return;
      const t = e.touches[0];
      const moved = Math.hypot(t.clientX - drag.x0, t.clientY - drag.y0);
      if (!editing) {
        if (moved > 10) { clearTimeout(longPress); drag = null; } // normal blättern
        return;
      }
      if (!drag.active) {
        if (moved < 8) return;
        startDrag(t);
      }
      e.preventDefault();
      moveDrag(t);
    }, { passive: false });

    const end = () => {
      clearTimeout(longPress);
      if (drag && drag.tile === tile) {
        if (drag.active) endDrag();
        drag = null;
      }
    };
    tile.addEventListener('touchend', end);
    tile.addEventListener('touchcancel', end);

    tile.addEventListener('click', () => {
      if (suppressClick) { suppressClick = false; return; }
      if (editing) return;
      conn.send({ t: 'launch', id: item.id });
      tile.classList.remove('launching');
      void tile.offsetWidth; // Animation neu starten
      tile.classList.add('launching');
    });
    tile.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function startDrag(t) {
    drag.active = true;
    const r = drag.tile.getBoundingClientRect();
    const ghost = drag.tile.cloneNode(true);
    ghost.classList.add('ghost');
    ghost.style.left = r.left + 'px';
    ghost.style.top = r.top + 'px';
    ghost.style.width = r.width + 'px';
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    drag.offX = t.clientX - r.left;
    drag.offY = t.clientY - r.top;
    drag.tile.classList.add('drag-src');
    pagesEl.classList.add('locked');
  }

  function moveDrag(t) {
    drag.ghost.style.left = (t.clientX - drag.offX) + 'px';
    drag.ghost.style.top = (t.clientY - drag.offY) + 'px';

    // Über welcher anderen App ist der Finger? → dort einsortieren
    const under = document.elementFromPoint(t.clientX, t.clientY);
    const target = under && under.closest('.tile');
    const grid = drag.tile.parentElement;
    if (target && target !== drag.tile && target.parentElement === grid) {
      const tiles = [...grid.children];
      const from = tiles.indexOf(drag.tile), to = tiles.indexOf(target);
      grid.insertBefore(drag.tile, from < to ? target.nextSibling : target);
    }

    // Am linken/rechten Rand kurz halten → Seite wechseln
    const w = window.innerWidth;
    const edge = t.clientX < 30 ? -1 : t.clientX > w - 30 ? 1 : 0;
    if (edge !== drag.edge) {
      drag.edge = edge;
      clearTimeout(drag.edgeTimer);
      if (edge) drag.edgeTimer = setTimeout(() => switchPageWhileDragging(edge), 600);
    }
  }

  function switchPageWhileDragging(dir) {
    if (!drag || !drag.active) return;
    let target = page + dir;
    if (target < 0) return;
    if (target >= dock.pages.length) {
      // rechts hinter der letzten Seite: neue Seite anlegen
      dock.pages.push({ items: [] });
      const pageEl = document.createElement('div');
      pageEl.className = 'dock-page';
      const grid = document.createElement('div');
      grid.className = 'dock-grid';
      pageEl.appendChild(grid);
      pagesEl.appendChild(pageEl);
    }
    const grid = pagesEl.children[target].querySelector('.dock-grid');
    pagesEl.children[target].querySelector('.dock-empty')?.remove();
    grid.appendChild(drag.tile);
    page = target;
    pagesEl.scrollTo({ left: page * pagesEl.clientWidth, behavior: 'smooth' });
    renderDots();
    drag.edge = 0;
  }

  function endDrag() {
    clearTimeout(drag.edgeTimer);
    drag.ghost.remove();
    drag.tile.classList.remove('drag-src');
    pagesEl.classList.remove('locked');
    // Reihenfolge aus der Anzeige übernehmen
    dock.pages = [...pagesEl.querySelectorAll('.dock-grid')].map(g => ({ items: [...g.children].map(t => t._item) }));
    drag = null;
    serverDockWhileDragging = null;
    save();
    render();
  }

  /* ---------- Bearbeiten ---------- */

  function setEditing(on) {
    editing = on;
    if (!on && dock) {
      // leere Seiten aufräumen (mindestens eine bleibt)
      const before = dock.pages.length;
      dock.pages = dock.pages.filter(p => p.items.length);
      if (!dock.pages.length) dock.pages = [{ items: [] }];
      if (dock.pages.length !== before) save();
    }
    render();
  }
  editBtn.addEventListener('click', () => setEditing(!editing));

  function removeItem(item) {
    for (const p of dock.pages) {
      const i = p.items.indexOf(item);
      if (i >= 0) p.items.splice(i, 1);
    }
    save();
    render();
  }

  root.querySelector('#dock-addpage').addEventListener('click', () => {
    dock.pages.push({ items: [] });
    page = dock.pages.length - 1;
    save();
    render();
  });

  /* ---------- Apps hinzufügen ---------- */

  const inDock = (id) => dock.pages.some(p => p.items.some(i => i.id === id));

  root.querySelector('#dock-add').addEventListener('click', () => {
    appsSearch.value = '';
    appsSheet.hidden = false;
    if (!apps) {
      appsList.innerHTML = '<p class="dim center">Apps werden geladen …</p>';
      conn.send({ t: 'apps.list' });
    } else renderAppList();
  });
  document.querySelector('#apps-done').addEventListener('click', () => closeSheet(appsSheet));
  appsSheet.addEventListener('click', (e) => { if (e.target === appsSheet) closeSheet(appsSheet); });
  appsSearch.addEventListener('input', renderAppList);
  document.querySelector('#apps-refresh').addEventListener('click', () => {
    apps = null;
    appsList.innerHTML = '<p class="dim center">Apps werden neu eingelesen …</p>';
    conn.send({ t: 'apps.list', refresh: true });
  });

  function renderAppList() {
    if (appsSheet.hidden || !apps || !dock) return;
    const q = appsSearch.value.trim().toLowerCase();
    const list = q ? apps.filter(a => a.name.toLowerCase().includes(q)) : apps;
    appsList.innerHTML = '';
    if (!list.length) { appsList.innerHTML = '<p class="dim center">Nichts gefunden.</p>'; return; }
    for (const a of list.slice(0, 400)) {
      const row = document.createElement('button');
      row.className = 'app-row';
      const added = inDock(a.id);
      row.innerHTML = `<span class="app-name"></span><span class="app-toggle ${added ? 'added' : ''}">${added ? '✓' : '+'}</span>`;
      row.prepend(iconEl(a));
      row.querySelector('.app-name').textContent = a.name;
      row.addEventListener('click', () => {
        if (inDock(a.id)) {
          for (const p of dock.pages) p.items = p.items.filter(i => i.id !== a.id);
        } else {
          dock.pages[Math.min(page, dock.pages.length - 1)].items.push({ id: a.id, name: a.name });
        }
        const now = inDock(a.id);
        const tg = row.querySelector('.app-toggle');
        tg.textContent = now ? '✓' : '+';
        tg.classList.toggle('added', now);
        save();
        render();
      });
      appsList.appendChild(row);
    }
  }

  /* ---------- Hintergrund ---------- */

  root.querySelector('#dock-wall').addEventListener('click', () => {
    wallSheet.querySelector('#wall-remove').hidden = !dock?.wallpaper;
    wallSheet.hidden = false;
  });
  wallSheet.querySelector('#wall-cancel').addEventListener('click', () => closeSheet(wallSheet));
  wallSheet.addEventListener('click', (e) => { if (e.target === wallSheet) closeSheet(wallSheet); });
  wallSheet.querySelector('#wall-pick').addEventListener('click', () => { wallSheet.hidden = true; fileInput.click(); });
  wallSheet.querySelector('#wall-remove').addEventListener('click', async () => {
    wallSheet.hidden = true;
    await conn.apiFetch('api/wallpaper', { method: 'DELETE', headers: { 'X-IDock-Token': conn.token || '' } }).catch(() => { });
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    toast('Hintergrund wird hochgeladen …');
    try {
      const blob = await shrinkImage(file, 2400);
      const res = await conn.apiFetch('api/wallpaper', {
        method: 'POST',
        headers: { 'X-IDock-Token': conn.token || '', 'Content-Type': 'image/jpeg' },
        body: blob,
      });
      toast(res.ok ? 'Hintergrund gespeichert.' : 'Das Bild konnte nicht gespeichert werden.');
    } catch {
      toast('Das Bild konnte nicht gelesen werden.');
    }
  });

  return { refresh: () => conn.send({ t: 'dock.get' }) };
}

/** Bild verkleinern und als JPEG liefern (iPhone-Fotos sind sonst viele MB groß). */
function shrinkImage(file, maxSide) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/jpeg', 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bild')); };
    img.src = url;
  });
}
