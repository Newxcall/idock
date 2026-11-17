// Fernzugriff: Verbindung zum PC über das Internet.
// Supabase Realtime dient nur als Treffpunkt (Vermittlung). Danach steht eine direkte, verschlüsselte
// WebRTC-Verbindung – im WLAN genauso wie unterwegs. RemoteSocket verhält sich wie ein WebSocket,
// damit connection.js nichts weiter wissen muss.

import { sha256Hex, hmacHex } from './sha256.js';

// Öffentliche Projektdaten (der „publishable key“ darf in Webseiten stehen).
export const SUPABASE_URL = 'https://snafgyzhegwkxmunmxje.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_0Et4ZNVpB4VItHiFUFkTug_r62daswS';

const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
const CONNECT_TIMEOUT_MS = 15000;
const REMOTE_KEY = 'idock.remote';

/** Soll die Seite den Fernzugriff verwenden? (?remote=1 schaltet ihn für Tests ein, ?remote=0 aus) */
export function isRemoteMode() {
  const q = new URLSearchParams(location.search).get('remote');
  try {
    if (q === '1') localStorage.setItem(REMOTE_KEY, '1');
    if (q === '0') localStorage.removeItem(REMOTE_KEY);
    if (localStorage.getItem(REMOTE_KEY) === '1') return true;
  } catch { }
  return remoteOnly();
}

/** Fernzugriff ein-/ausschalten (gilt für dieses Gerät, bis es wieder geändert wird). */
export function setRemoteMode(on) {
  try { on ? localStorage.setItem(REMOTE_KEY, '1') : localStorage.removeItem(REMOTE_KEY); } catch { }
}

/** Liegt die Seite im Internet (GitHub Pages) statt auf dem PC? Dann gibt es nur den Fernzugriff. */
export const remoteOnly = () =>
  document.querySelector('meta[name="idock-hosted"]')?.content === '1' || location.hostname.endsWith('.github.io');

/** Kopplungscode vereinheitlichen: Großbuchstaben, nur Buchstaben/Ziffern (Bindestriche weg). */
export const normalizeCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const formatCode = (code) => normalizeCode(code).slice(0, 12).replace(/(.{4})(?=.)/g, '$1-');
export const pairChannelFor = (code) => 'idock-pair-' + sha256Hex('idock-pair|' + code).slice(0, 32);

export const tokenHashOf = (token) => sha256Hex(token).toUpperCase();
export const channelFor = (tokenHash) => 'idock-' + sha256Hex('idock-channel|' + tokenHash).slice(0, 32);

function randomId() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Minimaler Supabase-Realtime-Client (Phoenix-Protokoll) für einen Kanal. */
class Signal {
  constructor(channel, onBroadcast) {
    this.channel = channel;
    this.topic = 'realtime:' + channel;
    this.onBroadcast = onBroadcast;
    this.ref = 0;
    this.ws = null;
    this.beat = null;
  }

  open() {
    return new Promise((resolve, reject) => {
      const host = new URL(SUPABASE_URL).host;
      const ws = new WebSocket(`wss://${host}/realtime/v1/websocket?apikey=${encodeURIComponent(SUPABASE_KEY)}&vsn=1.0.0`);
      this.ws = ws;
      const joinRef = String(++this.ref);
      ws.onopen = () => {
        this.raw({
          topic: this.topic, event: 'phx_join', ref: joinRef, join_ref: joinRef,
          payload: { config: { broadcast: { ack: false, self: false }, presence: { key: '', enabled: false }, postgres_changes: [], private: false } },
        });
        this.beat = setInterval(() => this.raw({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++this.ref) }), 25000);
      };
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.event === 'phx_reply' && m.ref === joinRef) {
          if (m.payload && m.payload.status === 'ok') resolve();
          else reject(new Error('join'));
        } else if (m.event === 'broadcast' && m.topic === this.topic && m.payload) {
          this.onBroadcast(m.payload.event, m.payload.payload);
        }
      };
      ws.onerror = () => reject(new Error('signal'));
      ws.onclose = () => reject(new Error('signal'));
    });
  }

  raw(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  broadcast(event, payload) {
    this.raw({ topic: this.topic, event: 'broadcast', ref: String(++this.ref), payload: { type: 'broadcast', event, payload } });
  }

  close() {
    clearInterval(this.beat);
    if (this.ws) {
      this.ws.onclose = this.ws.onerror = this.ws.onmessage = null;
      try { this.ws.close(); } catch { }
      this.ws = null;
    }
  }
}

/**
 * Verhält sich wie ein WebSocket (readyState, send, close, onopen/onmessage/onclose), läuft aber über WebRTC.
 * new RemoteSocket(token) → Kanal des gekoppelten Geräts; new RemoteSocket({ pairCode }) → Kopplungskanal.
 */
export class RemoteSocket {
  constructor(opts) {
    this.readyState = 0;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    if (typeof opts === 'string') {
      this.key = tokenHashOf(opts);
      this.channel = channelFor(this.key);
    } else {
      this.key = normalizeCode(opts.pairCode);
      this.channel = pairChannelFor(this.key);
    }
    this.session = randomId();
    this.pc = null;
    this.dc = null;
    this.signal = null;
    this.remoteIce = [];
    this.localIce = [];
    this.offerSent = false;
    this.timer = setTimeout(() => this.fail('timeout'), CONNECT_TIMEOUT_MS);
    this.start().catch((e) => this.fail(e && e.message));
  }

  sign(k, d) { return { k, s: this.session, d, m: hmacHex(this.key, `${k}|${this.session}|${d}`) }; }

  async start() {
    if (typeof RTCPeerConnection === 'undefined') throw new Error('nowebrtc');
    this.signal = new Signal(this.channel, (event, p) => this.onSignal(event, p));
    await this.signal.open();
    if (this.readyState > 1) return;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc = pc;
    const dc = pc.createDataChannel('idock', { ordered: true });
    dc.binaryType = 'arraybuffer';
    this.dc = dc;
    dc.onopen = () => {
      if (this.readyState !== 0) return;
      clearTimeout(this.timer);
      this.readyState = 1;
      // Vermittlung wird nicht mehr gebraucht.
      setTimeout(() => { if (this.signal) { this.signal.close(); this.signal = null; } }, 2000);
      this.onopen && this.onopen();
    };
    dc.onmessage = (e) => this.onmessage && this.onmessage({ data: e.data });
    dc.onclose = () => this.fail('closed');
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const d = JSON.stringify(e.candidate.toJSON());
      if (this.offerSent) this.signal && this.signal.broadcast('sig', this.sign('ice', d));
      else this.localIce.push(d);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.fail(pc.connectionState);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.signal.broadcast('sig', this.sign('offer', pc.localDescription.sdp));
    this.offerSent = true;
    for (const d of this.localIce.splice(0)) this.signal.broadcast('sig', this.sign('ice', d));
  }

  async onSignal(event, p) {
    if (event !== 'sig' || !p || p.s !== this.session || typeof p.d !== 'string') return;
    if (p.m !== hmacHex(this.key, `${p.k}|${p.s}|${p.d}`)) return; // nicht vom eigenen PC
    const pc = this.pc;
    if (!pc) return;
    try {
      if (p.k === 'answer' && !pc.currentRemoteDescription) {
        await pc.setRemoteDescription({ type: 'answer', sdp: p.d });
        for (const c of this.remoteIce.splice(0)) await pc.addIceCandidate(c).catch(() => { });
      } else if (p.k === 'ice') {
        const c = JSON.parse(p.d);
        if (!c.candidate) return;
        if (c.sdpMid == null && c.sdpMLineIndex == null) c.sdpMLineIndex = 0;
        if (pc.currentRemoteDescription) await pc.addIceCandidate(c).catch(() => { });
        else this.remoteIce.push(c);
      }
    } catch (e) {
      this.fail('sdp');
    }
  }

  send(text) {
    if (this.readyState === 1 && this.dc && this.dc.readyState === 'open') this.dc.send(text);
  }

  /** Wie viele Bytes noch auf dem Weg sind (für Gegendruck bei großen Uploads). */
  get bufferedAmount() { return this.dc ? this.dc.bufferedAmount : 0; }

  fail(reason) {
    if (this.readyState === 3) return;
    this.lastError = reason;
    this.close();
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    clearTimeout(this.timer);
    if (this.signal) { this.signal.close(); this.signal = null; }
    if (this.dc) { this.dc.onclose = this.dc.onmessage = this.dc.onopen = null; try { this.dc.close(); } catch { } }
    if (this.pc) { this.pc.onconnectionstatechange = this.pc.onicecandidate = null; try { this.pc.close(); } catch { } }
    this.onclose && this.onclose({ reason: this.lastError });
  }
}
