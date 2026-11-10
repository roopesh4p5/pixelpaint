/* PixelPaint · doc.js — DocumentManager, LayerManager (model), Selection model, HistoryManager */
(function () {
'use strict';
const PP = window.PP, U = PP.Util, P = PP.Pixel, bus = PP.bus;

const BLEND = {
  normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay',
  darken: 'darken', lighten: 'lighten', 'soft-light': 'soft-light', 'hard-light': 'hard-light',
  'color-dodge': 'color-dodge', 'color-burn': 'color-burn', difference: 'difference', exclusion: 'exclusion',
  hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity'
};

const TEXT_DEFAULTS = {
  text: 'Text', font: 'system-ui, sans-serif', size: 48, weight: 400, italic: false, underline: false,
  align: 'left', lineHeight: 1.2, letterSpacing: 0, fill: '#ffffff', strokeColor: '#000000', strokeWidth: 0,
  shadowColor: '#000000', shadowBlur: 0, shadowX: 0, shadowY: 0, rotation: 0, ax: 0, ay: 0
};

/* ───────────── Layer ───────────── */
class Layer {
  constructor(o = {}) {
    this.id = o.id || U.uid();
    this.name = o.name || 'Layer';
    this.type = o.type || 'raster';          // 'raster' | 'text'
    this.visible = o.visible !== false;
    this.locked = !!o.locked;
    this.opacity = o.opacity == null ? 1 : o.opacity;
    this.blend = BLEND[o.blend] ? o.blend : 'normal';
    this.x = o.x || 0; this.y = o.y || 0;
    this.canvas = o.canvas || U.canvas(o.w || 1, o.h || 1);
    this.mask = o.mask || null;               // canvas, alpha = mask value (255 reveal)
    this.maskEnabled = o.maskEnabled !== false;
    this.text = o.text ? Object.assign({}, TEXT_DEFAULTS, o.text) : null;
    this.rev = 0; this._mrev = -1; this._masked = null;
    this.preview = null;                      // canvas temporarily shown instead of pixels (filter preview)
    this.xform = null;                        // live free-transform preview {a,b,c,d,e,f}
  }
  get w() { return this.canvas.width; }
  get h() { return this.canvas.height; }
  get bounds() { return { x: this.x, y: this.y, w: this.w, h: this.h }; }
  /** Mark pixels changed. rect in layer-local coords (optional → whole layer). */
  touch(rect) {
    this.rev++;
    // keep the masked cache incrementally valid: remember which local rect changed since it was built
    if (rect && this._mvalid === this.rev - 1) { this._mpend = U.union(this._mpend, U.snap(rect)); this._mvalid = this.rev; }
    const r = rect ? { x: rect.x + this.x, y: rect.y + this.y, w: rect.w, h: rect.h } : this.bounds;
    bus.emit('pixels', { layer: this, rect: r });
  }
  /** Source for compositing: pixels with the layer mask applied (cached by revision). */
  source() {
    const src = this.preview || this.canvas;
    if (!this.mask || !this.maskEnabled) return src;
    if (this._mrev !== this.rev || this.preview || !this._masked) {
      const reuse = this._masked && this._masked.width === src.width && this._masked.height === src.height;
      const c = reuse ? this._masked : U.canvas(src.width, src.height), x = c.getContext('2d');
      const partial = reuse && !this.preview && this._mrev !== -1 && this._mvalid === this.rev && this._mpend;
      const r = partial ? this._mpend : { x: 0, y: 0, w: src.width, h: src.height };
      x.save(); x.beginPath(); x.rect(r.x, r.y, r.w, r.h); x.clip();
      x.globalCompositeOperation = 'copy'; x.drawImage(src, 0, 0);
      x.globalCompositeOperation = 'destination-in'; x.drawImage(this.mask, 0, 0);
      x.restore();
      this._masked = c; this._mrev = this.preview ? -1 : this.rev; this._mvalid = this.rev; this._mpend = null;
    }
    return this._masked;
  }
  /** Document-coordinate selection mask cropped to this layer's rect, or null. */
  selMask(sel) { return sel.maskForRect(this.x, this.y, this.w, this.h); }
}

function renderText(layer) {
  const t = layer.text, lines = String(t.text).split('\n');
  const font = `${t.italic ? 'italic ' : ''}${t.weight} ${t.size}px ${t.font}`;
  const m = U.canvas(1, 1).getContext('2d');
  m.font = font; if ('letterSpacing' in m) m.letterSpacing = t.letterSpacing + 'px';
  const widths = lines.map(s => m.measureText(s).width), boxW = Math.max(1, ...widths), lh = t.size * t.lineHeight, boxH = lh * lines.length;
  const pad = Math.ceil(t.strokeWidth + t.shadowBlur * 2 + Math.max(Math.abs(t.shadowX), Math.abs(t.shadowY)) + 2);
  const W = boxW + pad * 2, H = boxH + pad * 2, a = (t.rotation * Math.PI) / 180;
  const cw = Math.ceil(Math.abs(W * Math.cos(a)) + Math.abs(H * Math.sin(a))), ch = Math.ceil(Math.abs(W * Math.sin(a)) + Math.abs(H * Math.cos(a)));
  if (!U.validSize(cw, ch)) throw new Error('Text is too large');
  const c = U.canvas(cw, ch), x = c.getContext('2d');
  x.translate(cw / 2, ch / 2); x.rotate(a); x.translate(-W / 2, -H / 2);
  x.font = font; if ('letterSpacing' in x) x.letterSpacing = t.letterSpacing + 'px';
  x.textBaseline = 'middle'; x.lineJoin = 'round';
  lines.forEach((s, i) => {
    const lx = pad + (t.align === 'center' ? (boxW - widths[i]) / 2 : t.align === 'right' ? boxW - widths[i] : 0), ly = pad + i * lh + lh / 2;
    x.shadowColor = t.shadowBlur || t.shadowX || t.shadowY ? t.shadowColor : 'transparent';
    x.shadowBlur = t.shadowBlur; x.shadowOffsetX = t.shadowX; x.shadowOffsetY = t.shadowY;
    if (t.strokeWidth > 0) { x.strokeStyle = t.strokeColor; x.lineWidth = t.strokeWidth * 2; x.strokeText(s, lx, ly); x.shadowColor = 'transparent'; }
    x.fillStyle = t.fill; x.fillText(s, lx, ly);
    if (t.underline) x.fillRect(lx, ly + t.size * 0.55, widths[i], Math.max(1, t.size / 15));
  });
  layer.canvas = c;
  layer.x = Math.round(t.ax + W / 2 - cw / 2); layer.y = Math.round(t.ay + H / 2 - ch / 2);
  if (layer.mask) layer.mask = null; // text layers keep no mask; rasterize first to mask
  layer.touch();
}

/* ───────────── Selection ───────────── */
class Selection {
  constructor(w, h) { this.w = w; this.h = h; this.mask = null; this.rev = 0; this._b = undefined; this._o = null; this._c = null; this._crev = -1; }
  get active() { return !!this.mask; }
  set(mask) {
    this.mask = mask && P.bounds(mask, this.w, this.h) ? mask : null;
    this.rev++; this._b = undefined; this._o = null;
    bus.emit('selection', this);
  }
  resize(w, h) { this.w = w; this.h = h; this.set(null); }
  get bounds() { if (this._b === undefined) this._b = this.mask ? P.bounds(this.mask, this.w, this.h) : null; return this._b; }
  get outline() {
    if (!this.mask) return null;
    if (!this._o) {
      const segs = P.outline(this.mask, this.w, this.h, this.bounds), p = new Path2D();
      for (let i = 0; i < segs.length; i += 4) { p.moveTo(segs[i], segs[i + 1]); p.lineTo(segs[i + 2], segs[i + 3]); }
      this._o = p;
    }
    return this._o;
  }
  /** Canvas whose alpha is the mask (for clipping via destination-in). */
  canvas() {
    if (!this.mask) return null;
    if (this._crev !== this.rev) { this._c = U.maskToCanvas(this.mask, this.w, this.h, [255, 255, 255], this._c && this._c.width === this.w && this._c.height === this.h ? this._c : null); this._crev = this.rev; }
    return this._c;
  }
  /** Sub-mask for a document rect; outside the document = 0. null when no selection. */
  maskForRect(x, y, w, h) {
    if (!this.mask) return null;
    const out = new Uint8Array(w * h);
    const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(this.w, x + w), y1 = Math.min(this.h, y + h);
    for (let yy = y0; yy < y1; yy++) out.set(this.mask.subarray(yy * this.w + x0, yy * this.w + x1), (yy - y) * w + (x0 - x));
    return out;
  }
}

/* ───────────── Document ───────────── */
class Doc {
  constructor(o = {}) {
    this.id = o.id || U.uid();
    this.name = o.name || 'Untitled';
    this.width = o.width; this.height = o.height;
    this.colorSpace = 'srgb';
    this.layers = [];                         // bottom → top
    this.activeId = null;
    this.selection = new Selection(this.width, this.height);
    this.createdAt = o.createdAt || Date.now(); this.updatedAt = o.updatedAt || Date.now();
  }
  get active() { return this.byId(this.activeId) || this.layers[this.layers.length - 1] || null; }
  byId(id) { return this.layers.find(l => l.id === id) || null; }
  index(l) { return this.layers.indexOf(l); }
  insert(layer, index = this.layers.length) { this.layers.splice(index, 0, layer); this.activeId = layer.id; bus.emit('layers'); bus.emit('pixels', { rect: null }); }
  remove(layer) {
    const i = this.index(layer); if (i < 0) return -1;
    this.layers.splice(i, 1);
    if (this.activeId === layer.id) this.activeId = (this.layers[Math.max(0, i - 1)] || {}).id || null;
    bus.emit('layers'); bus.emit('pixels', { rect: null });
    return i;
  }
  setActive(layer) { this.activeId = layer ? layer.id : null; bus.emit('layers'); }
}

/* ───────────── History (command based) ───────────── */
class History {
  constructor() { this.stack = []; this.index = -1; this.bytes = 0; this.base = 'Open'; }
  clear(base = 'Open') { this.stack = []; this.index = -1; this.bytes = 0; this.base = base; bus.emit('history'); }
  /** entry: {label, undo(), redo(), bytes?} — redo has already been applied when pushed. */
  push(entry) {
    for (const e of this.stack.splice(this.index + 1)) this.bytes -= e.bytes || 0;
    entry.bytes = entry.bytes || 0; entry.time = Date.now();
    this.stack.push(entry); this.index++; this.bytes += entry.bytes;
    const C = PP.Config;
    while (this.stack.length > 1 && (this.stack.length > C.HISTORY_STEPS || this.bytes > C.HISTORY_BYTES)) {
      this.bytes -= this.stack.shift().bytes; this.index--;
    }
    bus.emit('history', { change: true });
  }
  get canUndo() { return this.index >= 0; }
  get canRedo() { return this.index < this.stack.length - 1; }
  undo() { if (!this.canUndo) return; this.stack[this.index--].undo(); bus.emit('history', { change: true }); }
  redo() { if (!this.canRedo) return; this.stack[++this.index].redo(); bus.emit('history', { change: true }); }
  goto(i) { while (this.index > i) this.undo(); while (this.index < i && this.canRedo) this.redo(); }
}

/** Records tile-granular before/after pixel deltas for one layer target ('pixels' | 'mask'). */
class PixelEdit {
  constructor(layer, target = 'pixels') { this.layer = layer; this.target = target; this.tiles = new Map(); }
  get canvas() { return this.target === 'mask' ? this.layer.mask : this.layer.canvas; }
  /** Save "before" for a layer-local rect. src: canvas holding the pre-edit pixels (default: current). */
  save(rect, src) {
    const T = PP.Config.TILE, c = this.canvas, r = U.intersect(U.snap(rect), { x: 0, y: 0, w: c.width, h: c.height });
    if (!r) return;
    for (let ty = Math.floor(r.y / T) * T; ty < r.y + r.h; ty += T) {
      for (let tx = Math.floor(r.x / T) * T; tx < r.x + r.w; tx += T) {
        const key = tx + ',' + ty;
        if (this.tiles.has(key)) continue;
        const tw = Math.min(T, c.width - tx), th = Math.min(T, c.height - ty);
        this.tiles.set(key, { x: tx, y: ty, before: U.read(src || c, tx, ty, tw, th), after: null });
      }
    }
  }
  saveAll() { this.save({ x: 0, y: 0, w: this.canvas.width, h: this.canvas.height }); }
  commit(label) {
    if (!this.tiles.size) return false;
    const tiles = [...this.tiles.values()], layer = this.layer, getC = () => (this.target === 'mask' ? layer.mask : layer.canvas);
    let bytes = 0, area = null;
    for (const t of tiles) { t.after = U.read(getC(), t.x, t.y, t.before.width, t.before.height); bytes += t.before.data.length * 2; area = U.union(area, { x: t.x, y: t.y, w: t.before.width, h: t.before.height }); }
    const apply = key => { const c = getC(); if (!c) return; for (const t of tiles) U.write(c, t[key], t.x, t.y); layer.touch(area); };
    PP.app.history.push({ label, bytes, undo: () => apply('before'), redo: () => apply('after') });
    this.tiles.clear();
    return true;
  }
}

/** Snapshot whole-document geometry (canvas refs, not copies) for crop/resize/rotate style ops. */
function docSnapshot(doc) {
  return {
    width: doc.width, height: doc.height, activeId: doc.activeId,
    layers: doc.layers.map(l => ({ l, canvas: l.canvas, mask: l.mask, x: l.x, y: l.y, text: l.text && Object.assign({}, l.text), type: l.type,
      name: l.name, opacity: l.opacity, blend: l.blend, visible: l.visible, locked: l.locked, maskEnabled: l.maskEnabled })),
    sel: doc.selection.mask
  };
}
function docRestore(doc, s) {
  doc.width = s.width; doc.height = s.height; doc.activeId = s.activeId;
  doc.layers = s.layers.map(o => {
    Object.assign(o.l, { canvas: o.canvas, mask: o.mask, x: o.x, y: o.y, text: o.text && Object.assign({}, o.text), type: o.type,
      name: o.name, opacity: o.opacity, blend: o.blend, visible: o.visible, locked: o.locked, maskEnabled: o.maskEnabled });
    o.l.rev++; return o.l;
  });
  if (PP.app.target === 'mask' && !(doc.active && doc.active.mask)) PP.app.target = 'pixels';
  doc.selection.w = s.width; doc.selection.h = s.height; doc.selection.set(s.sel);
  bus.emit('docsize'); bus.emit('layers'); bus.emit('pixels', { rect: null });
}
/** Memory held only by the "before" snapshot (canvases no longer referenced after the op). */
function snapBytes(before, after) {
  const live = new Set(); for (const o of after.layers) { live.add(o.canvas); if (o.mask) live.add(o.mask); }
  let n = 0;
  for (const o of before.layers) for (const c of [o.canvas, o.mask]) if (c && !live.has(c)) n += c.width * c.height * 4;
  return n + (before.sel && before.sel !== after.sel ? before.sel.length : 0);
}

/** Run fn() that replaces canvases/geometry on doc, recording an undoable snapshot pair. */
function docCommand(label, fn) {
  const doc = PP.app.doc, before = docSnapshot(doc);
  if (fn(doc) === false) return false;
  const after = docSnapshot(doc);
  bus.emit('docsize'); bus.emit('layers'); bus.emit('pixels', { rect: null });
  PP.app.history.push({ label, bytes: snapBytes(before, after), undo: () => docRestore(doc, before), redo: () => docRestore(doc, after) });
}

PP.Model = { Layer, Doc, Selection, History, PixelEdit, BLEND, TEXT_DEFAULTS, renderText, docCommand, docSnapshot, docRestore };
})();
