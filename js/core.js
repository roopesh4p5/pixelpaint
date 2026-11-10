/* PixelPaint · core.js — PixelPaintConfig, PixelPaintUtils, event bus, worker job runner */
(function () {
'use strict';
const PP = window.PP;

PP.Config = Object.freeze({
  SCHEMA: 1,
  MAX_SIDE: 16384,                // hard canvas side limit (most browsers)
  MAX_PIXELS: 120e6,              // per canvas
  TILE: 64,                       // history tile size (px)
  HISTORY_STEPS: 100,
  HISTORY_BYTES: 768 * 1024 * 1024,
  AUTOSAVE_MS: 2500,
  ZOOM_MIN: 0.01, ZOOM_MAX: 64,
  WORKER_MIN_PIXELS: 300000,      // smaller jobs run inline (worker overhead not worth it)
  MAX_IMPORT_BYTES: 400 * 1024 * 1024,
  MAX_PROJECT_BYTES: 1024 * 1024 * 1024
});

/* ───────────── utilities ───────────── */
const U = PP.Util = {
  uid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  },
  clamp: (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v),

  /** Canvas with a CPU-backed 2D context (fast getImageData/putImageData for pixel work). */
  canvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    c.getContext('2d', { willReadFrequently: true });
    return c;
  },
  ctx: c => c.getContext('2d'),
  clone(src) { const c = U.canvas(src.width, src.height); c.getContext('2d').drawImage(src, 0, 0); return c; },
  read(c, x = 0, y = 0, w = c.width, h = c.height) { return c.getContext('2d').getImageData(x, y, w, h); },
  write(c, img, x = 0, y = 0) { c.getContext('2d').putImageData(img, x, y); },
  /** New ImageData from raw RGBA (copy-free when possible). */
  imageData(data, w, h) { return new ImageData(data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data.buffer), w, h); },

  /** Mask (Uint8Array) → canvas whose alpha = mask, colour = rgb. */
  maskToCanvas(mask, w, h, rgb = [255, 255, 255], target) {
    const c = target || U.canvas(w, h), img = new ImageData(w, h), d = img.data;
    for (let p = 0, i = 0; p < mask.length; p++, i += 4) { d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; d[i + 3] = mask[p]; }
    c.getContext('2d').putImageData(img, 0, 0);
    return c;
  },
  canvasAlpha(c) { return PP.Pixel.alphaToMask(U.read(c)); },

  validSize(w, h) {
    return Number.isFinite(w) && Number.isFinite(h) && w >= 1 && h >= 1 &&
      w <= PP.Config.MAX_SIDE && h <= PP.Config.MAX_SIDE && w * h <= PP.Config.MAX_PIXELS;
  },

  hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    const n = m ? parseInt(m[1], 16) : 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  },
  rgbToHex: (r, g, b) => '#' + [r, g, b].map(v => U.clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join(''),

  rect: (x, y, w, h) => ({ x, y, w, h }),
  union(a, b) {
    if (!a) return b; if (!b) return a;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  },
  intersect(a, b) {
    const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
    const w = Math.min(a.x + a.w, b.x + b.w) - x, h = Math.min(a.y + a.h, b.y + b.h) - y;
    return w > 0 && h > 0 ? { x, y, w, h } : null;
  },
  /** Expand to integer pixel grid. */
  snap(r) { const x = Math.floor(r.x), y = Math.floor(r.y); return { x, y, w: Math.ceil(r.x + r.w) - x, h: Math.ceil(r.y + r.h) - y }; },

  debounce(fn, ms) { let t; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.flush = () => { clearTimeout(t); fn(); }; return d; },

  /** Minimal safe DOM builder: text always via textContent, never innerHTML. */
  el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k in e && typeof v !== 'string') e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return e;
  },

  download(blob, name) {
    const url = URL.createObjectURL(blob), a = U.el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  },
  toBlob: (c, type, q) => new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('Encoding failed'))), type, q)),
  formatBytes(n) { const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return n.toFixed(i ? 1 : 0) + ' ' + u[i]; },
  isTyping(t) { t = t || document.activeElement; return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) && t.type !== 'range' && t.type !== 'checkbox'; },
  base64FromBytes(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); },
  bytesFromBase64(b64) { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
};

/* ───────────── event bus ───────────── */
const handlers = new Map();
PP.bus = {
  on(ev, fn) { if (!handlers.has(ev)) handlers.set(ev, new Set()); handlers.get(ev).add(fn); return () => handlers.get(ev).delete(fn); },
  emit(ev, data) { const s = handlers.get(ev); if (s) for (const fn of s) { try { fn(data); } catch (e) { console.error('[PixelPaint]', ev, e); } } }
};

/* ───────────── worker job runner ─────────────
 * One lazily-created worker per channel. A new job on a busy channel terminates the
 * running worker (true cancellation) and rejects the superseded promise with {cancelled:true}.
 * Falls back to inline execution if workers are unavailable (feature detection, file:// quirks). */
let workerURL = null, workerBroken = false;
const channels = new Map();

function workerSource() {
  return 'const P=(' + PP.PixelFactory.toString() + ')();\n' +
    'onmessage=function(e){var m=e.data;try{var out=P.runFilter(m.name,{data:m.data,width:m.w,height:m.h},m.params,m.mask);' +
    'postMessage({ok:true,out:out},[out.buffer]);}catch(err){postMessage({ok:false,error:String(err&&err.message||err)});}};';
}

function spawn() {
  if (workerBroken || typeof Worker === 'undefined') return null;
  try {
    workerURL = workerURL || URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' }));
    return new Worker(workerURL);
  } catch (e) { workerBroken = true; console.warn('Workers unavailable, using main thread', e); return null; }
}

PP.Jobs = {
  /** Run a pixel.js filter. img: ImageData. mask: Uint8Array|null. Resolves Uint8ClampedArray. */
  filter(name, img, params, mask, channel = 'default') {
    const inline = () => new Promise((res, rej) => setTimeout(() => {
      try { res(PP.Pixel.runFilter(name, img, params, mask)); } catch (e) { rej(e); }
    }, 0));
    const prev = channels.get(channel);
    if (prev) { prev.worker && prev.worker.terminate(); prev.reject({ cancelled: true }); channels.delete(channel); }
    if (img.width * img.height < PP.Config.WORKER_MIN_PIXELS) return inline();
    const worker = spawn();
    if (!worker) return inline();
    PP.bus.emit('busy', true);
    return new Promise((resolve, reject) => {
      const job = { worker, reject };
      channels.set(channel, job);
      const done = () => { worker.terminate(); if (channels.get(channel) === job) channels.delete(channel); if (!channels.size) PP.bus.emit('busy', false); };
      worker.onmessage = e => { done(); e.data.ok ? resolve(e.data.out) : reject(new Error(e.data.error)); };
      worker.onerror = e => { done(); e.preventDefault(); workerBroken = true; inline().then(resolve, reject); };
      const data = img.data.slice(), m = mask ? mask.slice() : null;
      worker.postMessage({ name, w: img.width, h: img.height, data, params, mask: m }, m ? [data.buffer, m.buffer] : [data.buffer]);
    });
  },
  cancel(channel) {
    const j = channels.get(channel);
    if (j) { j.worker && j.worker.terminate(); j.reject({ cancelled: true }); channels.delete(channel); if (!channels.size) PP.bus.emit('busy', false); }
  }
};
})();
