// Zwischenablage: Text zum PC schicken, Verlauf vom PC, Einträge aufs iPhone kopieren.

/**
 * Kopiert Text in die iPhone-Zwischenablage. Über HTTP gibt es die moderne Clipboard-API nicht,
 * deshalb der klassische Weg über ein unsichtbares Textfeld (klappt nur direkt nach einem Tippen).
 */
export function copyToDevice(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => { });
    return true;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:-1000px;left:0;font-size:16px;opacity:0;';
  document.body.appendChild(ta);
  const range = document.createRange();
  range.selectNodeContents(ta);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  sel.removeAllRanges();
  ta.remove();
  return ok;
}

function timeLabel(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const hm = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const today = new Date().toDateString() === d.toDateString();
  return today ? hm : `${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })} ${hm}`;
}

export function initClipboard({ root, conn, toast }) {
  const $ = (s) => root.querySelector(s);
  const input = $('#clip-input');
  const list = $('#clip-list');
  const empty = $('#clip-empty');
  const clearBtn = $('#clip-clear');
  let items = [];

  function render() {
    list.innerHTML = '';
    empty.hidden = items.length > 0;
    clearBtn.hidden = items.length === 0;
    items.forEach((it, idx) => {
      const el = document.createElement('div');
      el.className = 'clip-item' + (idx === 0 ? ' current' : '');
      el.dataset.id = it.id;

      const text = document.createElement('button');
      text.className = 'clip-text';
      text.textContent = it.text;
      text.dataset.act = 'device';
      text.setAttribute('aria-label', 'Aufs iPhone kopieren');

      const meta = document.createElement('div');
      meta.className = 'clip-meta';
      const badge = document.createElement('span');
      badge.className = 'clip-badge ' + it.src;
      badge.textContent = it.src === 'pc' ? 'PC' : 'iPhone';
      meta.append(badge, ` ${timeLabel(it.at)}`);
      if (idx === 0) meta.append(' · liegt in der PC-Zwischenablage');
      if (it.trunc) meta.append(' · gekürzt');

      const actions = document.createElement('div');
      actions.className = 'clip-actions';
      const mk = (act, label, cls = '') => {
        const b = document.createElement('button');
        b.dataset.act = act;
        b.textContent = label;
        if (cls) b.className = cls;
        return b;
      };
      actions.append(mk('device', 'Aufs iPhone'));
      if (idx !== 0) actions.append(mk('pc', 'Zum PC'));
      actions.append(mk('paste', 'Am PC einfügen'), mk('del', 'Löschen', 'danger'));

      el.append(text, meta, actions);
      list.appendChild(el);
    });
  }

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = +btn.closest('.clip-item').dataset.id;
    const it = items.find(i => i.id === id);
    if (!it) return;
    switch (btn.dataset.act) {
      case 'device':
        toast(copyToDevice(it.text) ? 'Aufs iPhone kopiert' : 'Kopieren ging nicht – Text lange drücken und „Kopieren“ wählen');
        break;
      case 'pc':
        conn.send({ t: 'clip.copy', id });
        toast('In der PC-Zwischenablage');
        break;
      case 'paste':
        conn.send({ t: 'clip.copy', id, paste: true });
        toast('Am PC eingefügt');
        break;
      case 'del':
        conn.send({ t: 'clip.delete', id });
        break;
    }
  });

  function send(paste) {
    const text = input.value;
    if (!text.trim()) { toast('Erst Text eingeben oder einfügen'); input.focus(); return; }
    if (conn.state !== 'online') { toast('Nicht verbunden'); return; }
    conn.send({ t: 'clip.set', text, paste });
    input.value = '';
    input.blur();
    toast(paste ? 'Am PC eingefügt' : 'In der PC-Zwischenablage');
  }
  $('#clip-send').addEventListener('click', () => send(false));
  $('#clip-paste').addEventListener('click', () => send(true));

  clearBtn.addEventListener('click', () => {
    if (confirm('Den ganzen Verlauf löschen? (Die PC-Zwischenablage selbst bleibt.)')) conn.send({ t: 'clip.clear' });
  });

  conn.on('clip', (m) => { items = m.items || []; render(); });
  conn.addEventListener('state', (e) => { if (e.detail.state === 'online') conn.send({ t: 'clip.get' }); });
  render();
}
