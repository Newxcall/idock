// Blätter von unten (Einstellungen, Apps im Dock, Hintergrund):
// – nach unten wegwischen schließt sie (wie bei iOS),
// – sie passen sich dem sichtbaren Bereich an, auch wenn die iPhone-Tastatur offen ist.

const CLOSE_MS = 220;

/** Blatt schließen (mit kurzer Animation nach unten). */
export function closeSheet(backdrop) {
  if (!backdrop || backdrop.hidden) return;
  const sheet = backdrop.querySelector('.sheet');
  sheet.style.transition = `transform ${CLOSE_MS}ms ease-in`;
  sheet.style.transform = 'translateY(100%)';
  backdrop.classList.add('closing');
  setTimeout(() => {
    backdrop.hidden = true;
    backdrop.classList.remove('closing');
    sheet.style.transition = '';
    sheet.style.transform = '';
    backdrop.dispatchEvent(new Event('sheetclose'));
  }, CLOSE_MS);
}

function trackViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement.style;
  const update = () => {
    root.setProperty('--vvh', `${vv ? vv.height : window.innerHeight}px`);
    root.setProperty('--vvtop', `${vv ? vv.offsetTop : 0}px`);
  };
  update();
  if (vv) { vv.addEventListener('resize', update); vv.addEventListener('scroll', update); }
  window.addEventListener('resize', update);
}

/** Nach unten wischen: am Griff, an der Überschrift oder in einer Liste, die schon ganz oben ist. */
function attachSwipe(backdrop) {
  const sheet = backdrop.querySelector('.sheet');
  if (!sheet) return;
  let startY = 0, startT = 0, dy = 0;
  let tracking = false;   // Finger liegt auf, Wischen nach unten möglich
  let dragging = false;   // Blatt folgt dem Finger
  let scroller = null;

  sheet.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { tracking = false; return; }
    const t = e.target;
    // Schieberegler und Eingabefelder brauchen den Finger selbst.
    if (t.closest('input[type=range], input[type=text], input[type=search], textarea')) { tracking = false; return; }
    scroller = t.closest('.sheet-scroll, .apps-list');
    tracking = !scroller || scroller.scrollTop <= 0;
    dragging = false;
    startY = e.touches[0].clientY;
    startT = performance.now();
    dy = 0;
  }, { passive: true });

  sheet.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    dy = e.touches[0].clientY - startY;
    if (!dragging) {
      if (dy < -4) { tracking = false; return; }            // nach oben = Liste scrollen
      if (dy < 8) return;                                   // noch unklar
      if (scroller && scroller.scrollTop > 0) { tracking = false; return; }
      dragging = true;
      sheet.style.transition = 'none';
    }
    e.preventDefault();                                     // Seite/Liste nicht mitscrollen
    sheet.style.transform = `translateY(${Math.max(0, dy - 8)}px)`;
  }, { passive: false });

  const end = () => {
    if (!dragging) { tracking = false; return; }
    tracking = dragging = false;
    const speed = dy / Math.max(1, performance.now() - startT);  // Pixel je ms
    if (dy > sheet.offsetHeight * 0.25 || (speed > 0.5 && dy > 40)) {
      document.activeElement && document.activeElement.blur && document.activeElement.blur();
      closeSheet(backdrop);
    } else {
      sheet.style.transition = 'transform .2s cubic-bezier(.2, .9, .3, 1)';
      sheet.style.transform = '';
    }
  };
  sheet.addEventListener('touchend', end);
  sheet.addEventListener('touchcancel', end);
}

export function initSheets() {
  trackViewport();
  document.querySelectorAll('.sheet-backdrop').forEach(attachSwipe);
}
