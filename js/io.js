/* PixelPaint · io.js — ImportExportManager + StorageManager
 *  IndexedDB      : autosave/recovery records (layer PNG blobs, original source files),
 *                   undo history (one record per step in 'hist', canvases it needs in 'blobs')
 *  localStorage   : small preferences (tool options, colours, panels, view prefs)
 *  sessionStorage : this tab's active document id + clean-exit hint
 * Nothing ever leaves the device. */
(function () {
'use strict';
const PP = window.PP, U = PP.Util, P = PP.Pixel, bus = PP.bus, M = PP.Model, C = PP.Config;
const app = () => PP.app, toast = (m, k) => PP.UI && PP.UI.toast(m, k);

const IO = PP.IO = {};

/* ───────────── preferences ───────────── */
const PREFS_KEY = 'pp.prefs.v1';
IO.loadPrefs = function () {
  try { const p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null'); return p && typeof p === 'object' ? p : {}; }
  catch (e) { return {}; }
};
IO.savePrefs = U.debounce(() => {
  const a = app();
  const p = { opts: a.opts, colors: a.colors, tool: a.tools && a.tools.current && a.tools.current.id, panels: a.panels, bg: a.view.bg, grid: a.view.showGrid };
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) { /* quota/private mode: prefs are optional */ }
}, 400);
const session = {
  get(k) { try { return JSON.parse(sessionStorage.getItem('pp.' + k)); } catch (e) { return null; } },
  set(k, v) { try { sessionStorage.setItem('pp.' + k, JSON.stringify(v)); } catch (e) { /* optional */ } }
};
IO.session = session;

/* ───────────── IndexedDB ───────────── */
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    if (!window.indexedDB) return rej(new Error('IndexedDB unavailable'));
    const r = indexedDB.open('pixelpaint', 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
      for (const n of ['hist', 'blobs']) if (!db.objectStoreNames.contains(n)) db.createObjectStore(n, { keyPath: 'key' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new Error('IndexedDB blocked'));
  });
  dbp.catch(() => { dbp = null; });
  return dbp;
}
function tx(mode, fn, store = 'docs') {
  return db().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode), s = t.objectStore(store), out = fn(s);
    t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
    t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('Transaction aborted'));
  }));
}
IO.listSaved = () => tx('readonly', s => s.getAll()).then(a => (a || []).map(r => ({ id: r.id, name: r.name, updatedAt: r.updatedAt, width: r.width, height: r.height, thumb: r.thumb })).sort((x, y) => y.updatedAt - x.updatedAt));
const docRange = id => IDBKeyRange.bound(id + '|', id + '|\uffff');
IO.deleteSaved = id => Promise.all([tx('readwrite', s => s.delete(id)), tx('readwrite', s => s.delete(docRange(id)), 'hist'), tx('readwrite', s => s.delete(docRange(id)), 'blobs')]);
IO.getSaved = id => tx('readonly', s => s.get(id));
const discarded = new Set(); // documents thrown away with "Clear all": never autosave them again
IO.discard = id => { discarded.add(id); return IO.deleteSaved(id).catch(() => { /* nothing stored */ }); };

/* ───────────── serialization ───────────── */
const blobCache = new WeakMap(); // canvas → {rev, blob}
async function canvasBlob(c, rev) {
  const hit = blobCache.get(c);
  if (hit && hit.rev === rev) return hit.blob;
  const blob = await U.toBlob(c, 'image/png');
  blobCache.set(c, { rev, blob });
  return blob;
}
const LAYER_PROPS = ['id', 'name', 'type', 'visible', 'locked', 'opacity', 'blend', 'x', 'y', 'maskEnabled'];

async function serialize(d) {
  const layers = [];
  for (const l of d.layers) {
    const o = {}; for (const k of LAYER_PROPS) o[k] = l[k];
    o.text = l.text ? Object.assign({}, l.text) : null;
    o.png = await canvasBlob(l.canvas, l.rev);
    o.canvasUid = uidOf(l.canvas); o.maskUid = l.mask ? uidOf(l.mask) : null;
    o.mask = l.mask ? await canvasBlob(l.mask, 'm' + l.rev) : null;
    layers.push(o);
  }
  return {
    id: d.id, schemaVersion: C.SCHEMA, name: d.name, width: d.width, height: d.height, colorSpace: 'srgb',
    activeId: d.activeId, createdAt: d.createdAt, updatedAt: Date.now(), layers,
    selection: d.selection.mask ? P.rleEncode(d.selection.mask) : null,
    saved: (d.saved || []).map(s => ({ name: s.name, w: s.w, h: s.h, rle: s.rle })),
    sources: d.sources || []
  };
}

async function blobToCanvas(blob) {
  const bmp = await decodeBitmap(blob);
  const c = U.canvas(bmp.width, bmp.height); c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close && bmp.close();
  return c;
}

/** Validate and rebuild a document from a record (IndexedDB or parsed project). Throws on bad data. */
async function deserialize(r) {
  const bad = m => { throw new Error('Project file corrupt: ' + m); };
  if (!r || typeof r !== 'object') bad('not an object');
  if (r.schemaVersion !== C.SCHEMA) throw new Error(`Unsupported project version ${r.schemaVersion}`);
  if (!U.validSize(r.width, r.height)) bad('invalid dimensions');
  if (!Array.isArray(r.layers) || !r.layers.length || r.layers.length > 1000) bad('invalid layer list');
  const d = new M.Doc({ id: typeof r.id === 'string' ? r.id : undefined, name: String(r.name || 'Untitled').slice(0, 200), width: r.width, height: r.height, createdAt: r.createdAt });
  for (const o of r.layers) {
    if (!(o.png instanceof Blob)) bad('missing layer pixels');
    const canvas = await blobToCanvas(o.png);
    const mask = o.mask instanceof Blob ? await blobToCanvas(o.mask) : null;
    if (mask && (mask.width !== canvas.width || mask.height !== canvas.height)) bad('mask size mismatch');
    const num = (v, lo, hi, def) => (Number.isFinite(v) ? U.clamp(v, lo, hi) : def);
    const l = new M.Layer({
      id: typeof o.id === 'string' ? o.id : undefined, name: String(o.name || 'Layer').slice(0, 200), type: o.type === 'text' && o.text ? 'text' : 'raster',
      visible: o.visible !== false, locked: !!o.locked, opacity: num(o.opacity, 0, 1, 1), blend: o.blend,
      x: Math.round(num(o.x, -1e6, 1e6, 0)), y: Math.round(num(o.y, -1e6, 1e6, 0)), canvas, mask, maskEnabled: o.maskEnabled !== false,
      text: o.type === 'text' && o.text && typeof o.text === 'object' ? sanitizeText(o.text) : null
    });
    d.layers.push(l);
  }
  d.activeId = d.byId(r.activeId) ? r.activeId : d.layers[d.layers.length - 1].id;
  if (r.selection instanceof Uint8Array) d.selection.set(P.rleDecode(r.selection, d.width * d.height));
  d.saved = Array.isArray(r.saved) ? r.saved.filter(s => s && s.rle instanceof Uint8Array && s.w === d.width && s.h === d.height).map(s => ({ name: String(s.name).slice(0, 100), w: s.w, h: s.h, rle: s.rle })) : [];
  d.sources = Array.isArray(r.sources) ? r.sources.filter(s => s && s.blob instanceof Blob).map(s => ({ name: String(s.name).slice(0, 200), type: String(s.type), blob: s.blob })) : [];
  return d;
}
function sanitizeText(t) {
  const o = {};
  for (const k in M.TEXT_DEFAULTS) {
    const def = M.TEXT_DEFAULTS[k], v = t[k];
    o[k] = typeof v === typeof def ? (typeof v === 'string' ? v.slice(0, 10000) : v) : def;
  }
  o.size = U.clamp(o.size, 1, 2000);
  return o;
}

/* ───────────── persistent undo history ─────────────
 * Each step is written once to 'hist' (key docId|stepUid). Canvases that only history still references
 * (e.g. the pre-crop image) go to 'blobs' (key docId|canvasUid) and are re-encoded only when changed.
 * Live layer canvases are not duplicated: the doc record carries their uids. Unreferenced records are
 * deleted after the doc record (which holds the step order) is written. */
const HIST_PERSIST_BYTES = 400 * 1024 * 1024;
const canvasUid = new WeakMap(), canvasVer = new WeakMap(), savedVer = new WeakMap(), savedSteps = new WeakSet();
function uidOf(c) { let u = canvasUid.get(c); if (!u) { u = U.uid(); canvasUid.set(c, u); } return u; }
bus.on('pixels', e => { const l = e && e.layer; if (l) for (const c of [l.canvas, l.mask]) if (c) canvasVer.set(c, (canvasVer.get(c) || 0) + 1); });
let histLoading = false;

const LAYER_SNAP = ['x', 'y', 'type', 'name', 'opacity', 'blend', 'visible', 'locked', 'maskEnabled'];
function encodeSnap(s, need) {
  return {
    width: s.width, height: s.height, activeId: s.activeId, sel: s.sel ? P.rleEncode(s.sel) : null,
    layers: s.layers.map(o => {
      need.add(o.canvas); if (o.mask) need.add(o.mask);
      const r = { id: o.l.id, canvas: uidOf(o.canvas), mask: o.mask ? uidOf(o.mask) : null, text: o.text ? Object.assign({}, o.text) : null };
      for (const k of LAYER_SNAP) r[k] = o[k];
      return r;
    })
  };
}
function encodeStep(d, e, need) {
  const r = { key: d.id + '|' + e.uid, uid: e.uid, kind: e.kind, label: e.label, bytes: e.bytes || 0 };
  for (const k of ['selBefore', 'selAfter', 'selN']) if (k in e) r[k] = e[k];
  switch (e.kind) {
    case 'pixels': return Object.assign(r, { layerId: e.layer.id, target: e.target, area: e.area, tiles: e.tiles.map(t => ({ x: t.x, y: t.y, before: t.before, after: t.after })) });
    case 'doc': return Object.assign(r, { before: encodeSnap(e.before, need), after: encodeSnap(e.after, need) });
    case 'sel': return Object.assign(r, { before: e.before, after: e.after, n: e.n });
    case 'move': return Object.assign(r, { layerId: e.layer.id, x0: e.x0, y0: e.y0, dx: e.dx, dy: e.dy });
    case 'text': return Object.assign(r, { layerId: e.layer.id, before: e.before, after: e.after });
  }
  return null;
}
/** Persist the history window; returns the meta stored in the doc record ({order, index, base}). */
async function saveHistory(d) {
  const h = app().history, st = h.stack;
  let start = st.length, sum = 0;
  while (start > 0 && sum + (st[start - 1].bytes || 0) <= HIST_PERSIST_BYTES) sum += st[--start].bytes || 0;
  if (h.index < start - 1) start = st.length; // current position is older than what fits: keep only the present
  const kept = st.slice(start).filter(e => e.kind), live = new Set();
  for (const l of d.layers) { live.add(l.canvas); if (l.mask) live.add(l.mask); }
  const need = new Set(), steps = [];
  for (const e of kept) {
    if (e.kind === 'doc') { // canvases are needed every time (they may have become history-only since)
      for (const s of [e.before, e.after]) for (const o of s.layers) { need.add(o.canvas); if (o.mask) need.add(o.mask); }
    }
    if (!savedSteps.has(e)) { const r = encodeStep(d, e, need); if (r) steps.push([e, r]); }
  }
  if (steps.length) await tx('readwrite', s => { for (const [, r] of steps) s.put(r); }, 'hist');
  for (const [e] of steps) savedSteps.add(e);
  const stored = new Set(await tx('readonly', s => s.getAllKeys(docRange(d.id)), 'blobs'));
  const keepBlobs = new Set();
  for (const c of need) {
    if (live.has(c)) continue;
    const key = d.id + '|' + uidOf(c), ver = canvasVer.get(c) || 0;
    keepBlobs.add(key);
    if (stored.has(key) && savedVer.get(c) === ver) continue;
    const blob = await U.toBlob(c, 'image/png');
    await tx('readwrite', s => s.put({ key, blob }), 'blobs');
    savedVer.set(c, ver);
  }
  const meta = { order: kept.map(e => e.uid), index: h.index - (st.length - kept.length), base: start ? 'Older steps' : h.base };
  return { meta, gc: async () => {
    const keepSteps = new Set(meta.order.map(u => d.id + '|' + u));
    const oldSteps = await tx('readonly', s => s.getAllKeys(docRange(d.id)), 'hist');
    const dropS = oldSteps.filter(k => !keepSteps.has(k)), dropB = [...stored].filter(k => !keepBlobs.has(k));
    if (dropS.length) await tx('readwrite', s => { for (const k of dropS) s.delete(k); }, 'hist');
    if (dropB.length) await tx('readwrite', s => { for (const k of dropB) s.delete(k); }, 'blobs');
  } };
}

/** Rebuild the saved undo history for a freshly restored document. Any inconsistency → start with none. */
async function loadHistory(d, rec) {
  const meta = rec.history;
  if (!meta || !Array.isArray(meta.order) || !meta.order.length) return;
  histLoading = true;
  try {
    const recs = await tx('readonly', s => s.getAll(docRange(d.id)), 'hist'), byUid = new Map(recs.map(r => [r.uid, r]));
    const canvases = new Map(), layers = new Map(d.layers.map(l => [l.id, l]));
    rec.layers.forEach((o, i) => { // live layers keep their identity
      const l = d.layers[i];
      if (o.canvasUid) { canvasUid.set(l.canvas, o.canvasUid); canvases.set(o.canvasUid, l.canvas); }
      if (o.maskUid && l.mask) { canvasUid.set(l.mask, o.maskUid); canvases.set(o.maskUid, l.mask); }
    });
    const layer = id => { if (typeof id !== 'string') throw new Error('bad layer'); let l = layers.get(id); if (!l) { l = new M.Layer({ id }); layers.set(id, l); } return l; };
    const canvas = async uid => {
      if (canvases.has(uid)) return canvases.get(uid);
      const b = await tx('readonly', s => s.get(d.id + '|' + uid), 'blobs');
      if (!b || !(b.blob instanceof Blob)) throw new Error('missing history image');
      const c = await blobToCanvas(b.blob);
      canvasUid.set(c, uid); savedVer.set(c, 0); canvases.set(uid, c);
      return c;
    };
    const snap = async s => ({
      width: s.width, height: s.height, activeId: s.activeId, sel: s.sel ? P.rleDecode(s.sel, s.width * s.height) : null,
      layers: await Promise.all(s.layers.map(async o => Object.assign({ l: layer(o.id), canvas: await canvas(o.canvas), mask: o.mask ? await canvas(o.mask) : null, text: o.text ? Object.assign({}, o.text) : null },
        Object.fromEntries(LAYER_SNAP.map(k => [k, o[k]])))))
    });
    const stack = [];
    for (const uid of meta.order) {
      const r = byUid.get(uid); if (!r) throw new Error('missing history step');
      let data;
      switch (r.kind) {
        case 'pixels': data = { layer: layer(r.layerId), target: r.target, area: r.area, tiles: r.tiles }; break;
        case 'doc': data = { before: await snap(r.before), after: await snap(r.after) }; break;
        case 'sel': data = { before: r.before, after: r.after, n: r.n }; break;
        case 'move': data = { layer: layer(r.layerId), x0: r.x0, y0: r.y0, dx: r.dx, dy: r.dy }; break;
        case 'text': data = { layer: layer(r.layerId), before: r.before, after: r.after }; break;
        default: throw new Error('unknown history step');
      }
      for (const k of ['selBefore', 'selAfter', 'selN']) if (k in r) data[k] = r[k];
      const e = M.entry(r.kind, String(r.label), data, r.bytes, uid);
      savedSteps.add(e); stack.push(e);
    }
    if (app().doc !== d) return; // user moved on while loading
    const h = app().history;
    h.stack = stack; h.index = U.clamp(meta.index | 0, -1, stack.length - 1); h.base = String(meta.base || 'Open');
    h.bytes = stack.reduce((a, e) => a + (e.bytes || 0), 0);
    bus.emit('history');
  } catch (e) {
    console.warn('History not restored', e);
    toast('Undo history could not be restored — the image itself is fine', 'warn');
  } finally { histLoading = false; }
}

/* ───────────── autosave & recovery ───────────── */
let saving = false, again = false;
IO.autosave = U.debounce(() => IO.saveNow(), C.AUTOSAVE_MS);
IO.saveNow = async function () {
  const d = app().doc; if (!d || discarded.has(d.id)) return;
  if (histLoading) { IO.autosave(); return; } // never overwrite stored history with a half-loaded one
  if (saving) { again = true; return; }
  saving = true; PP.UI.status({ save: 'Saving…' });
  try {
    const rec = await serialize(d);
    rec.thumb = await thumbnail();
    let hist = null;
    try { hist = await saveHistory(d); rec.history = hist.meta; } catch (e) { console.warn('History not saved', e); }
    await tx('readwrite', s => s.put(rec));
    if (hist) await hist.gc().catch(e => console.warn('History cleanup failed', e));
    if (discarded.has(rec.id)) { await IO.deleteSaved(rec.id); return; } // cleared while this save was in flight
    PP.UI.status({ save: 'Saved locally' });
    session.set('doc', d.id);
  } catch (e) {
    console.error(e);
    const quota = e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message));
    PP.UI.status({ save: quota ? 'Storage full — export a .pforge backup' : 'Autosave failed' });
    if (quota) toast('Browser storage is full. Save a .pforge project to keep your work.', 'error');
  } finally {
    saving = false;
    if (again) { again = false; IO.autosave(); }
  }
};
async function thumbnail() {
  const f = app().view.flattened(), k = Math.min(1, 160 / Math.max(f.width, f.height));
  const c = U.canvas(Math.max(1, Math.round(f.width * k)), Math.max(1, Math.round(f.height * k)));
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(f, 0, 0, c.width, c.height);
  return U.toBlob(c, 'image/png');
}
IO.restore = async function (id) {
  const r = await IO.getSaved(id);
  if (!r) throw new Error('Recovery record not found');
  const d = await deserialize(r); // the stored record is kept until the user deletes it
  PP.App.setDocument(d, 'Restored');
  await loadHistory(d, r);
  toast(`Restored “${d.name}”`);
};
IO.storageInfo = async function () {
  const out = { persisted: null, usage: null, quota: null };
  try { if (navigator.storage && navigator.storage.persisted) out.persisted = await navigator.storage.persisted(); } catch (e) { /* unsupported */ }
  try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); out.usage = e.usage; out.quota = e.quota; } } catch (e) { /* unsupported */ }
  return out;
};
IO.requestPersist = async function () {
  try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) { /* unsupported */ }
  return false;
};

/* ───────────── import ───────────── */
const IMAGE_TYPES = /^image\/(png|jpe?g|webp|bmp|x-ms-bmp|gif|svg\+xml|avif)$/;
const EXT = /\.(png|jpe?g|webp|bmp|gif|svg|avif)$/i;

async function decodeBitmap(blob) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
    catch (e) { /* fall through to <img> (e.g. SVG, older Safari) */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image(); img.decoding = 'async'; img.src = url;
    await img.decode();
    return img;
  } finally { URL.revokeObjectURL(url); }
}

/** Strip scripts, event handlers, external references and foreign content from SVG. */
function sanitizeSVG(text) {
  const docu = new DOMParser().parseFromString(text, 'image/svg+xml'), root = docu.documentElement;
  if (docu.getElementsByTagName('parsererror').length || root.nodeName.toLowerCase() !== 'svg') throw new Error('Invalid SVG');
  const banned = /^(script|foreignobject|iframe|embed|object|audio|video|animate|animatemotion|animatetransform|set|handler|listener)$/i;
  const walk = el => {
    for (const ch of [...el.children]) { if (banned.test(ch.localName)) ch.remove(); else walk(ch); }
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase(), v = a.value.trim().toLowerCase();
      if (n.startsWith('on')) el.removeAttribute(a.name);
      else if ((n === 'href' || n === 'xlink:href' || n === 'src') && !(v.startsWith('#') || v.startsWith('data:image/'))) el.removeAttribute(a.name);
      else if ((n === 'style' || /^(fill|stroke|filter|mask|clip-path)$/.test(n)) && /url\(\s*['"]?(?!#)/.test(v)) el.removeAttribute(a.name);
    }
  };
  walk(root);
  for (const st of [...root.getElementsByTagName('style')]) if (/@import|url\(\s*['"]?(?!#|data:)/i.test(st.textContent)) st.remove();
  let w = parseFloat(root.getAttribute('width')), h = parseFloat(root.getAttribute('height'));
  const vb = (root.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  if (!(w > 0 && h > 0)) { if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) { w = vb[2]; h = vb[3]; } else { w = 1024; h = 1024; } }
  root.setAttribute('width', w); root.setAttribute('height', h);
  return new Blob([new XMLSerializer().serializeToString(root)], { type: 'image/svg+xml' });
}

/** Decode a File/Blob to a canvas. Validates type, byte size and pixel dimensions. */
IO.decodeImage = async function (file) {
  if (!(IMAGE_TYPES.test(file.type) || (!file.type && EXT.test(file.name || '')))) throw new Error(`Unsupported format: ${file.name || file.type}`);
  if (file.size > C.MAX_IMPORT_BYTES) throw new Error(`File too large (${U.formatBytes(file.size)})`);
  let blob = file;
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name || '')) blob = sanitizeSVG(await file.text());
  let bmp;
  try { bmp = await decodeBitmap(blob); } catch (e) { throw new Error(`Could not decode ${file.name || 'image'} (corrupt or unsupported)`); }
  const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
  if (!U.validSize(w, h)) { bmp.close && bmp.close(); throw new Error(`Image too large: ${w} × ${h} (max ${C.MAX_SIDE}px per side)`); }
  const c = U.canvas(w, h); c.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close && bmp.close();
  return c;
};

/** Import files. First image opens a document when asked (or none is open); the rest become layers. */
IO.importFiles = async function (files, { newDoc = false, paste = false, intoLayer = false } = {}) {
  files = [...files];
  if (intoLayer && app().doc) { // first image only, drawn into the active layer
    const f = files.find(x => !/\.pforge$/i.test(x.name)); if (!f) return;
    try { PP.UI.busy(true, `Decoding ${f.name || 'image'}…`); PP.Ops.importIntoLayer(await IO.decodeImage(f)); }
    catch (e) { toast(e.message, 'error'); }
    finally { PP.UI.busy(false); }
    return;
  }
  const proj = files.find(f => /\.pforge$/i.test(f.name));
  if (proj) return IO.openProject(proj);
  let opened = false;
  for (const f of files) {
    try {
      PP.UI.busy(true, `Decoding ${f.name || 'image'}…`);
      const c = await IO.decodeImage(f), name = (f.name || 'Image').replace(/\.[^.]+$/, '');
      if (!app().doc || (newDoc && !opened)) {
        const d = new M.Doc({ name, width: c.width, height: c.height });
        d.layers.push(new M.Layer({ name: 'Background', canvas: c })); d.activeId = d.layers[0].id;
        d.sources = [{ name: f.name || 'image', type: f.type, blob: f }];
        PP.App.setDocument(d, 'Open'); opened = true;
      } else {
        const d = app().doc;
        (d.sources = d.sources || []).push({ name: f.name || 'image', type: f.type, blob: f });
        const m = app().clipboard, mine = paste && m && m.canvas.width === c.width && m.canvas.height === c.height;
        if (paste) PP.Ops.pasteFloating(c, mine ? m.x : null, mine ? m.y : null); else PP.Ops.pasteCanvas(c, null, null, name);
      }
    } catch (e) { toast(e.message, 'error'); }
    finally { PP.UI.busy(false); }
  }
};

IO.pickFiles = function (opts) {
  const inp = U.el('input', { type: 'file', multiple: true, accept: 'image/*,.pforge,.svg,.bmp' });
  inp.addEventListener('change', () => { if (inp.files.length) IO.importFiles(inp.files, opts); });
  inp.click();
};

/* ───────────── project files (.pforge = versioned JSON, base64 assets) ───────────── */
IO.saveProject = async function () {
  const d = app().doc; if (!d) return;
  PP.UI.busy(true, 'Saving project…');
  try {
    const rec = await serialize(d), b64 = async b => U.base64FromBytes(new Uint8Array(await b.arrayBuffer()));
    const out = {
      format: 'pforge', app: 'PixelPaint', schemaVersion: rec.schemaVersion, id: rec.id, name: rec.name, width: rec.width, height: rec.height,
      colorSpace: 'srgb', activeId: rec.activeId, createdAt: rec.createdAt, updatedAt: rec.updatedAt,
      layers: await Promise.all(rec.layers.map(async l => Object.assign({}, l, { png: await b64(l.png), mask: l.mask ? await b64(l.mask) : null }))),
      selection: rec.selection ? U.base64FromBytes(rec.selection) : null,
      saved: rec.saved.map(s => ({ name: s.name, w: s.w, h: s.h, rle: U.base64FromBytes(s.rle) })),
      sources: await Promise.all(rec.sources.map(async s => ({ name: s.name, type: s.type, data: await b64(s.blob) })))
    };
    U.download(new Blob([JSON.stringify(out)], { type: 'application/json' }), (d.name || 'Untitled') + '.pforge');
    toast('Project saved');
  } catch (e) { toast('Project save failed: ' + e.message, 'error'); }
  finally { PP.UI.busy(false); }
};

IO.openProject = async function (file) {
  if (file.size > C.MAX_PROJECT_BYTES) { toast('Project file too large', 'error'); return; }
  PP.UI.busy(true, 'Opening project…');
  try {
    let j;
    try { j = JSON.parse(await file.text()); } catch (e) { throw new Error('Project file corrupt: not valid JSON'); }
    if (!j || j.format !== 'pforge') throw new Error('Not a PixelPaint project');
    const bytes = (s, what) => { if (typeof s !== 'string') throw new Error('Project file corrupt: ' + what); return U.bytesFromBase64(s); };
    const blob = (s, type, what) => new Blob([bytes(s, what)], { type });
    const rec = Object.assign({}, j, {
      layers: Array.isArray(j.layers) ? j.layers.map(l => Object.assign({}, l, { png: blob(l.png, 'image/png', 'layer'), mask: l.mask ? blob(l.mask, 'image/png', 'mask') : null })) : null,
      selection: j.selection ? bytes(j.selection, 'selection') : null,
      saved: Array.isArray(j.saved) ? j.saved.map(s => Object.assign({}, s, { rle: bytes(s.rle, 'saved selection') })) : [],
      sources: Array.isArray(j.sources) ? j.sources.map(s => ({ name: s.name, type: s.type, blob: blob(s.data, String(s.type), 'source') })) : []
    });
    const d = await deserialize(rec);
    PP.App.setDocument(d, 'Open Project');
    toast(`Opened “${d.name}”`);
  } catch (e) { toast(e.message, 'error'); }
  finally { PP.UI.busy(false); }
};

/* ───────────── export ───────────── */
IO.supports = (() => { const c = document.createElement('canvas'); c.width = c.height = 1; return { webp: c.toDataURL('image/webp').startsWith('data:image/webp') }; })();

/** opts: {format:'png'|'jpeg'|'webp', quality 0..1, scope:'flat'|'layer'|'selection', width, height, bg, smooth} */
IO.renderExport = function (opts) {
  const d = app().doc, l = d.active;
  let src;
  if (opts.scope === 'layer') src = U.clone(l.source());
  else src = app().view.flattened();
  if (opts.scope === 'selection') {
    const b = d.selection.bounds; if (!b) throw new Error('No selection to export');
    const c = U.canvas(b.w, b.h); c.getContext('2d').drawImage(src, -b.x, -b.y);
    const img = U.read(c); P.applyMaskToAlpha(img.data, d.selection.maskForRect(b.x, b.y, b.w, b.h), true); U.write(c, img);
    src = c;
  }
  if (opts.width && opts.height && (opts.width !== src.width || opts.height !== src.height)) {
    if (!U.validSize(opts.width, opts.height)) throw new Error('Invalid output size');
    src = PP.Ops.resample(src, opts.width, opts.height, opts.smooth !== false);
  }
  if (opts.format === 'jpeg') { // JPEG has no alpha: flatten over the chosen background
    const c = U.canvas(src.width, src.height), g = c.getContext('2d');
    g.fillStyle = opts.bg || '#ffffff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(src, 0, 0); src = c;
  }
  return src;
};
IO.exportImage = async function (opts) {
  try {
    PP.UI.busy(true, 'Exporting…');
    const c = IO.renderExport(opts), type = 'image/' + opts.format;
    const blob = await U.toBlob(c, type, opts.format === 'png' ? undefined : opts.quality);
    if (blob.type !== type) toast(`${opts.format.toUpperCase()} not supported by this browser — saved as ${blob.type}`, 'warn');
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[blob.type] || 'png';
    U.download(blob, `${(opts.name || app().doc.name || 'image').replace(/[\\/:*?"<>|]+/g, '_')}.${ext}`);
    return blob;
  } catch (e) { toast('Export failed: ' + e.message, 'error'); }
  finally { PP.UI.busy(false); }
};

/* ───────────── drag & drop, paste ───────────── */
IO.bindInputs = function () {
  window.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); document.body.classList.add('dropping'); } });
  window.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
  window.addEventListener('drop', e => {
    document.body.classList.remove('dropping');
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault(); IO.importFiles(e.dataTransfer.files);
  });
  window.addEventListener('blur', () => { app().clipboardFresh = false; }); // user may copy elsewhere
  document.addEventListener('paste', e => {
    if (U.isTyping(e.target)) return;
    const files = [...(e.clipboardData ? e.clipboardData.files : [])].filter(f => f.type.startsWith('image/'));
    if (!app().doc) { if (files.length) { e.preventDefault(); IO.importFiles(files); } return; }
    e.preventDefault();
    if (app().clipboard && (!files.length || app().clipboardFresh)) { PP.Ops.pasteInternal(); return; }
    if (files.length) IO.importFiles(files, { paste: true });
    else if (!PP.Ops.pasteInternal()) toast('Clipboard has no image', 'warn');
  });
};
})();
