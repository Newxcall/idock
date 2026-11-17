// Verbindung zum PC: Koppeln per PIN, WebSocket (WLAN) oder Fernzugriff (WebRTC), Herzschlag,
// automatisches Neuverbinden und – beim Fernzugriff – ein Tunnel für Bilder und andere HTTP-Abrufe.

import { RemoteSocket, isRemoteMode, normalizeCode } from './remote.js';

const TOKEN_KEY = 'idock.token';
const HEARTBEAT_MS = 2000;   // alle 2 s ein "ping"
const DEAD_AFTER_MS = 6000;  // 6 s ohne "pong" → Verbindung gilt als tot
const MAX_DELAY_MS = 5000;   // spätestens alle 5 s neuer Versuch
const TUNNEL_TIMEOUT_MS = 20000;
const BODY_CHUNK = 12 * 1024;

export class Connection extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.state = 'idle';     // idle | unpaired | connecting | online | offline
    this.info = {};          // { pc, device, version } nach erfolgreicher Anmeldung
    this.retry = 0;
    this.retryTimer = null;
    this.heartbeat = null;
    this.lastPong = 0;
    this.handlers = new Map();
    this.remote = isRemoteMode(); // über das Internet (WebRTC) statt direkt im WLAN
    this.tunnel = new Map();      // offene HTTP-Abrufe über die Verbindung (nur Fernzugriff)
    this.tunnelId = 1;
    this.imageCache = new Map();

    // iPhone kommt aus dem Hintergrund / Netz ist wieder da → sofort prüfen.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.probe(); });
    window.addEventListener('pageshow', () => this.probe());
    window.addEventListener('online', () => this.probe());
  }

  get token() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } }
  set token(v) {
    try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch { }
  }

  /** Eigene Reaktion auf eine Nachricht vom PC, z. B. on('media', m => …). */
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }

  setState(state, extra = {}) {
    this.state = state;
    this.dispatchEvent(new CustomEvent('state', { detail: { state, ...extra } }));
  }

  async pair(pin, name, code) {
    if (this.remote) return this.pairRemote(code, pin, name);
    let res;
    try {
      res = await fetch('api/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, name }),
      });
    } catch {
      return { ok: false, error: 'network' };
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.token) {
      this.token = data.token;
      this.retry = 0;
      this.connect();
      return { ok: true, ...data };
    }
    return { ok: false, ...data };
  }

  /**
   * Koppeln über das Internet: mit Kopplungscode (aus dem iDock-Fenster) den PC finden,
   * dann wie im WLAN die PIN schicken und den Schlüssel bekommen.
   */
  async pairRemote(code, pin, name) {
    code = normalizeCode(code);
    if (code.length !== 12) return { ok: false, error: 'code' };
    const r = await new Promise((resolve) => {
      let done = false;
      const sock = new RemoteSocket({ pairCode: code });
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sock.onclose = null;
        try { sock.close(); } catch { }
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, error: 'notfound' }), 20000);
      sock.onopen = () => sock.send(JSON.stringify({ t: 'pair', pin, name }));
      sock.onmessage = (e) => {
        if (typeof e.data !== 'string') return;
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === 'paired' && m.token) finish({ ok: true, ...m });
        else if (m.t === 'pair_fail') finish({ ok: false, ...m });
      };
      sock.onclose = () => finish({ ok: false, error: 'notfound' });
    });
    if (r.ok) {
      this.token = r.token;
      this.retry = 0;
      this.connect();
    }
    return r;
  }

  connect() {
    if (!this.token) { this.setState('unpaired'); return; }
    if (this.ws && this.ws.readyState <= 1) return; // verbindet schon / ist offen
    clearTimeout(this.retryTimer);
    this.setState('connecting');

    let ws;
    if (this.remote) {
      ws = new RemoteSocket(this.token);
    } else {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${proto}//${location.host}/ws`);
    }
    this.ws = ws;

    ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token: this.token }));
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      if (typeof e.data !== 'string') { this.lastPong = Date.now(); this.tunnelChunk(e.data); return; }
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.lastPong = Date.now(); // jede Nachricht zeigt: Leitung lebt
      if (msg.t === 'hello') {
        this.retry = 0;
        this.info = { pc: msg.pc, device: msg.device, version: msg.version, build: msg.build, remote: !!msg.remote };
        this.startHeartbeat();
        this.setState('online', this.info);
      } else if (msg.t === 'http_res') {
        this.tunnelHead(msg);
      } else if (msg.t === 'auth_fail') {
        // Gerät wurde am PC entfernt → neu koppeln.
        this.token = null;
      }
      for (const fn of this.handlers.get(msg.t) || []) fn(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.drop();
    };
    ws.onerror = () => { };
  }

  /** Verbindung aufgeben und (falls gekoppelt) neuen Versuch planen. */
  drop() {
    const old = this.ws;
    this.ws = null;
    this.stopHeartbeat();
    this.failTunnel();
    if (old) {
      old.onclose = old.onmessage = old.onopen = null;
      try { old.close(); } catch { }
    }
    if (!this.token) { this.setState('unpaired'); return; }
    const delay = Math.min(MAX_DELAY_MS, 300 * 2 ** this.retry);
    this.retry++;
    this.setState('offline', { delay });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  /** Sofort nachsehen, ob die Leitung noch lebt (z. B. nach Rückkehr aus dem Hintergrund). */
  probe() {
    if (!this.token) return;
    if (this.state === 'online' && this.ws && this.ws.readyState === 1) {
      const sent = Date.now();
      this.send({ t: 'ping' });
      setTimeout(() => { if (this.state === 'online' && this.lastPong < sent) { this.retry = 0; this.drop(); } }, 1500);
    } else {
      this.reconnectNow();
    }
  }

  reconnectNow() {
    this.retry = 0;
    clearTimeout(this.retryTimer);
    if (this.ws && this.ws.readyState > 1) this.ws = null;
    this.connect();
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.lastPong = Date.now();
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastPong > DEAD_AFTER_MS) { this.drop(); return; }
      this.send({ t: 'ping' });
    }, HEARTBEAT_MS);
  }

  stopHeartbeat() {
    clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  /** Nachricht an den PC. Gibt false zurück, wenn gerade keine Verbindung besteht. */
  send(obj) {
    if (this.state !== 'online' || !this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  /** Von diesem PC abmelden (Gerät wird auch am PC entfernt). */
  forget() {
    this.send({ t: 'forget' });
    this.token = null;
    this.info = {};
    setTimeout(() => this.drop(), 150);
  }

  /* ---------- HTTP-Abrufe (Bilder, Live-Bild, Hintergrund) ---------- */

  /**
   * Wie fetch(), aber auch beim Fernzugriff: dann läuft der Abruf durch die Verbindung zum PC.
   * Liefert immer ein echtes Response-Objekt (res.ok, res.json(), res.blob(), res.headers …).
   */
  apiFetch(path, init = {}) {
    if (!this.remote) return fetch(path, init);
    return this.tunnelFetch(path, init);
  }

  /** Adresse für <img>/Hintergrund: im WLAN direkt, beim Fernzugriff als geladenes Bild (blob:). */
  async imageUrl(path) {
    if (!this.remote) return path;
    const hit = this.imageCache.get(path);
    if (hit) return hit;
    const res = await this.tunnelFetch(path, {});
    if (!res.ok) throw new Error('http ' + res.status);
    const url = URL.createObjectURL(await res.blob());
    this.imageCache.set(path, url);
    if (this.imageCache.size > 400) {
      const [oldPath, oldUrl] = this.imageCache.entries().next().value;
      this.imageCache.delete(oldPath);
      URL.revokeObjectURL(oldUrl);
    }
    return url;
  }

  async tunnelFetch(path, init) {
    if (this.state !== 'online' || !this.ws) throw new TypeError('offline');
    const id = this.tunnelId++;
    if (this.tunnelId > 0x7fffffff) this.tunnelId = 1;
    const p = '/' + String(path).replace(/^\.?\//, '');
    const headers = {};
    for (const [k, v] of Object.entries(init.headers || {})) headers[k] = v;

    if (init.body != null) {
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
      for (let off = 0; off < bytes.length; off += BODY_CHUNK) {
        const part = bytes.subarray(off, off + BODY_CHUNK);
        let bin = '';
        for (let i = 0; i < part.length; i++) bin += String.fromCharCode(part[i]);
        if (!this.send({ t: 'http_body', id, d: btoa(bin) })) throw new TypeError('offline');
        // Nicht zu viel auf einmal in die Leitung stopfen.
        while (this.ws && this.ws.bufferedAmount > 512 * 1024) await new Promise((r) => setTimeout(r, 10));
      }
    }

    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, parts: [], got: 0, n: -1, s: 0, ct: '', h: {} };
      entry.timer = setTimeout(() => { this.tunnel.delete(id); reject(new TypeError('timeout')); }, TUNNEL_TIMEOUT_MS);
      this.tunnel.set(id, entry);
      if (!this.send({ t: 'http', id, m: init.method || 'GET', p, h: headers })) {
        clearTimeout(entry.timer);
        this.tunnel.delete(id);
        reject(new TypeError('offline'));
      }
    });
  }

  tunnelHead(msg) {
    const e = this.tunnel.get(msg.id);
    if (!e) return;
    e.n = msg.n | 0; e.s = msg.s | 0; e.ct = msg.ct || ''; e.h = msg.h || {};
    if (e.got >= e.n) this.tunnelDone(msg.id, e);
  }

  tunnelChunk(buf) {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < 4) return;
    const id = new DataView(buf).getUint32(0);
    const e = this.tunnel.get(id);
    if (!e) return;
    e.parts.push(new Uint8Array(buf, 4));
    e.got += buf.byteLength - 4;
    if (e.n >= 0 && e.got >= e.n) this.tunnelDone(id, e);
  }

  tunnelDone(id, e) {
    clearTimeout(e.timer);
    this.tunnel.delete(id);
    const headers = new Headers(e.h);
    if (e.ct) headers.set('Content-Type', e.ct);
    const status = e.s >= 200 && e.s <= 599 ? e.s : 502;
    const body = status === 204 || status === 304 ? null : new Blob(e.parts, { type: e.ct });
    e.resolve(new Response(body, { status, headers }));
  }

  failTunnel() {
    for (const [id, e] of this.tunnel) {
      clearTimeout(e.timer);
      e.reject(new TypeError('offline'));
      this.tunnel.delete(id);
    }
  }
}
