// Touchpad: 1 Finger = Maus, Tippen = Klick, 2 Finger = Scrollen, 2-Finger-Tipp = Rechtsklick,
// 3-Finger-Tipp = Mittelklick, lange drücken = Ziehen. Dazu Links-/Rechts-Tasten unter der Fläche.

const STORE_KEY = 'idock.touchpad';
export const DEFAULTS = {
  speed: 1.6,        // Grundtempo der Maus
  accel: 1.0,        // Beschleunigung bei schnellen Bewegungen
  scrollSpeed: 1.0,
  natural: true,     // Inhalt folgt dem Finger (wie am iPhone)
  fineScroll: true,  // feines statt rastendes Scrollen
  tapToClick: true,
  inertia: true,     // Scrollen läuft nach dem Loslassen aus
};

const TAP_MAX_MS = 260;
const TAP_MAX_MOVE = 8;          // Pixel, bis aus einem Tipp eine Bewegung wird
const TWO_TAP_MAX_MS = 320;
const LONG_PRESS_MS = 450;
const WHEEL_PER_PX = 2.4;        // 1 px Fingerweg ≈ 2,4/120 Raste

export function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
export function saveSettings(s) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { }
}

export function initTouchpad({ pad, leftBtn, rightBtn, dragBadge, conn, getSettings }) {
  let mode = 'idle';            // idle | pending | move | drag | scroll | done
  let maxFingers = 0;
  let startTime = 0;
  let startX = 0, startY = 0;   // für die Tipp-Erkennung
  let lastX = 0, lastY = 0, lastT = 0;
  let travel = 0;               // gesamter Fingerweg in dieser Geste
  let longPress = null;
  let scrollVX = 0, scrollVY = 0;
  let inertiaFrame = null;

  // Bewegungen gehen sofort raus (das iPhone liefert Fingerbewegungen ohnehin nur einmal pro Bild).
  // Ist die Leitung gerade verstopft, wird kurz gesammelt statt Nachrichten zu stauen.
  let pendX = 0, pendY = 0, pendWX = 0, pendWY = 0;
  let retryTimer = null;

  function queueFlush() {
    if (!retryTimer) flush();
  }
  function flush() {
    retryTimer = null;
    const ws = conn.ws;
    if (ws && ws.bufferedAmount > 2048) { retryTimer = setTimeout(flush, 8); return; }
    if (pendX || pendY) {
      conn.send({ t: 'm', dx: round2(pendX), dy: round2(pendY) });
      pendX = pendY = 0;
    }
    if (pendWX || pendWY) {
      conn.send({ t: 'scroll', dx: round2(pendWX), dy: round2(pendWY), fine: getSettings().fineScroll });
      pendWX = pendWY = 0;
    }
  }
  const round2 = (v) => Math.round(v * 100) / 100;

  function centroid(touches) {
    let x = 0, y = 0;
    for (const t of touches) { x += t.clientX; y += t.clientY; }
    return { x: x / touches.length, y: y / touches.length };
  }

  function addScroll(dxPx, dyPx) {
    const s = getSettings();
    const k = WHEEL_PER_PX * s.scrollSpeed * (s.natural ? 1 : -1);
    // Rad: positiv = nach oben. Natürlich: Finger nach oben (dy < 0) → nach unten scrollen.
    pendWY += dyPx * k;
    pendWX += -dxPx * k;
    queueFlush();
  }

  function stopInertia() {
    if (inertiaFrame) cancelAnimationFrame(inertiaFrame);
    inertiaFrame = null;
  }

  function startInertia() {
    if (!getSettings().inertia) return;
    const speed = Math.hypot(scrollVX, scrollVY);
    if (speed < 0.25) return; // px/ms
    let vx = scrollVX, vy = scrollVY, prev = performance.now();
    const step = (now) => {
      const dt = Math.min(40, now - prev);
      prev = now;
      const decay = Math.pow(0.94, dt / 16.7);
      vx *= decay; vy *= decay;
      addScroll(vx * dt, vy * dt);
      if (Math.hypot(vx, vy) > 0.03) inertiaFrame = requestAnimationFrame(step);
      else inertiaFrame = null;
    };
    inertiaFrame = requestAnimationFrame(step);
  }

  function setDrag(on) {
    dragBadge.hidden = !on;
    pad.classList.toggle('dragging', on);
  }

  function ripple(x, y) {
    const r = pad.getBoundingClientRect();
    const dot = document.createElement('i');
    dot.className = 'ripple';
    dot.style.left = (x - r.left) + 'px';
    dot.style.top = (y - r.top) + 'px';
    pad.appendChild(dot);
    setTimeout(() => dot.remove(), 450);
  }

  pad.addEventListener('touchstart', (e) => {
    e.preventDefault();
    stopInertia();
    const touches = e.targetTouches;
    const n = touches.length;

    if (mode === 'idle' || mode === 'done') {
      // Neue Geste beginnt.
      maxFingers = 0;
      startTime = performance.now();
      travel = 0;
      mode = 'pending';
    }
    maxFingers = Math.max(maxFingers, n);
    const c = centroid(touches);
    lastX = startX = c.x;
    lastY = startY = c.y;
    lastT = performance.now();

    clearTimeout(longPress);
    if (n === 1 && mode === 'pending') {
      longPress = setTimeout(() => {
        if (mode === 'pending' && travel < TAP_MAX_MOVE) {
          mode = 'drag';
          conn.send({ t: 'down', b: 'left' });
          setDrag(true);
        }
      }, LONG_PRESS_MS);
    } else if (n >= 2 && mode !== 'drag') {
      mode = n === 2 ? 'scroll' : 'done';
      scrollVX = scrollVY = 0;
    }
  }, { passive: false });

  pad.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const touches = e.targetTouches;
    if (!touches.length) return;
    const c = centroid(touches);
    const now = performance.now();
    let dx = c.x - lastX, dy = c.y - lastY;
    const dt = Math.max(1, now - lastT);
    lastX = c.x; lastY = c.y; lastT = now;
    travel += Math.hypot(dx, dy);

    if (mode === 'pending' && travel >= TAP_MAX_MOVE) {
      clearTimeout(longPress);
      mode = 'move';
      if (touches.length === 1) { dx = c.x - startX; dy = c.y - startY; } // Weg seit Beginn nicht verschlucken
    }

    if ((mode === 'move' || mode === 'drag') && touches.length === 1) {
      const s = getSettings();
      const speed = Math.hypot(dx, dy) / dt;                 // px pro ms
      const gain = s.speed * (1 + s.accel * Math.min(Math.max(speed - 0.15, 0), 2.5));
      pendX += dx * gain;
      pendY += dy * gain;
      queueFlush();
    } else if (mode === 'scroll' && touches.length === 2) {
      addScroll(dx, dy);
      // geglättete Geschwindigkeit für das Auslaufen
      scrollVX = scrollVX * 0.6 + (dx / dt) * 0.4;
      scrollVY = scrollVY * 0.6 + (dy / dt) * 0.4;
    }
  }, { passive: false });

  function onEnd(e) {
    e.preventDefault();
    const left = e.targetTouches.length;
    if (left > 0) {
      // Ein Finger von zweien gehoben: nicht plötzlich die Maus bewegen.
      if (mode === 'scroll') mode = 'scrollTail';      // Auslaufen trotzdem erlauben
      else if (mode === 'pending') mode = 'done';
      const c = centroid(e.targetTouches);
      lastX = c.x; lastY = c.y;
      return;
    }
    clearTimeout(longPress);
    const duration = performance.now() - startTime;
    const s = getSettings();

    if (mode === 'drag') {
      conn.send({ t: 'up', b: 'left' });
      setDrag(false);
    } else if (s.tapToClick && maxFingers === 1 && mode === 'pending' && duration < TAP_MAX_MS) {
      conn.send({ t: 'click', b: 'left' });
      ripple(startX, startY);
    } else if (s.tapToClick && maxFingers === 2 && travel < TAP_MAX_MOVE * 2 && duration < TWO_TAP_MAX_MS) {
      conn.send({ t: 'click', b: 'right' });
      ripple(startX, startY);
    } else if (s.tapToClick && maxFingers === 3 && travel < TAP_MAX_MOVE * 3 && duration < TWO_TAP_MAX_MS) {
      conn.send({ t: 'click', b: 'middle' });
      ripple(startX, startY);
    } else if ((mode === 'scroll' || mode === 'scrollTail') && maxFingers === 2) {
      startInertia();
    }
    mode = 'idle';
  }
  pad.addEventListener('touchend', onEnd, { passive: false });
  pad.addEventListener('touchcancel', onEnd, { passive: false });

  // Links-/Rechts-Taste: gedrückt halten = Maustaste halten. So kann man mit einem zweiten Finger
  // auf der Fläche ziehen (wie bei einem Laptop-Touchpad).
  function bindButton(btn, b) {
    let downAt = 0;
    btn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      downAt = performance.now();
      btn.classList.add('pressed');
      conn.send({ t: 'down', b });
    }, { passive: false });
    const up = (e) => {
      e.preventDefault();
      if (!downAt) return;
      downAt = 0;
      btn.classList.remove('pressed');
      conn.send({ t: 'up', b });
    };
    btn.addEventListener('touchend', up, { passive: false });
    btn.addEventListener('touchcancel', up, { passive: false });
    // Maus (zum Ausprobieren am PC-Browser)
    btn.addEventListener('mousedown', () => conn.send({ t: 'down', b }));
    btn.addEventListener('mouseup', () => conn.send({ t: 'up', b }));
  }
  bindButton(leftBtn, 'left');
  bindButton(rightBtn, 'right');

  // Verbindung weg → Ziehen beenden (der PC lässt die Taste dann selbst los).
  conn.addEventListener('state', (e) => {
    if (e.detail.state !== 'online') {
      if (mode === 'drag') setDrag(false);
      mode = 'idle';
      stopInertia();
      pendX = pendY = pendWX = pendWY = 0;
    }
  });
}
