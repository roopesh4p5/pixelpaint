/* PixelPaint · tools.js — ToolManager, BrushEngine and all canvas tools
 *
 * Every tool receives events in DOCUMENT coordinates (from View.toDoc).
 * Selection tools rasterize the user's own geometry into an antialiased mask —
 * the recorded path is always the authority; nothing is inferred.
 */
(function () {
'use strict';
const PP = window.PP, U = PP.Util, P = PP.Pixel, bus = PP.bus, M = PP.Model;
const app = () => PP.app, O = () => PP.app.opts, doc = () => PP.app.doc, view = () => PP.app.view;
const toast = (m, k) => PP.UI && PP.UI.toast(m, k);

/* ───────────── shared helpers ───────────── */
const scratch = {};
function scratchCanvas(name, w, h) {
  let c = scratch[name];
  if (!c || c.width < w || c.height < h) c = scratch[name] = U.canvas(Math.max(w, c ? c.width : 0), Math.max(h, c ? c.height : 0));
  return c;
}

const tipCache = new Map();
/** Round brush tip; hardness 0…1. Soft falloff uses a smooth (cosine) profile. */
function tip(d, hardness, rgb) {
  const key = d.toFixed(2) + '|' + hardness.toFixed(3) + '|' + rgb;
  let c = tipCache.get(key);
  if (c) return c;
  if (tipCache.size > 64) tipCache.clear();
  const size = Math.ceil(d) + 2, r = d / 2, cx = size / 2;
  c = U.canvas(size, size);
  const g = c.getContext('2d');
  if (hardness >= 0.999 || d < 2) { g.fillStyle = `rgb(${rgb})`; g.beginPath(); g.arc(cx, cx, r, 0, Math.PI * 2); g.fill(); }
  else {
    const grad = g.createRadialGradient(cx, cx, 0, cx, cx, r);
    grad.addColorStop(0, `rgba(${rgb},1)`); grad.addColorStop(hardness, `rgba(${rgb},1)`);
    for (let i = 1; i <= 6; i++) { const t = i / 6; grad.addColorStop(hardness + (1 - hardness) * t, `rgba(${rgb},${(0.5 + 0.5 * Math.cos(Math.PI * t)).toFixed(4)})`); }
    g.fillStyle = grad; g.fillRect(0, 0, size, size);
  }
  tipCache.set(key, c);
  return c;
}

function selMode(e) {
  if (e.shift && e.alt) return 'intersect';
  if (e.shift) return 'add';
  if (e.alt) return 'subtract';
  return O().select.mode;
}

/** Rasterize document-space geometry into a full-document mask, drawing only inside bbox. */
function rasterMask(bbox, draw, aa = true) {
  const d = doc(), W = d.width, H = d.height, mask = new Uint8Array(W * H);
  const r = bbox && U.intersect(U.snap({ x: bbox.x - 1, y: bbox.y - 1, w: bbox.w + 2, h: bbox.h + 2 }), { x: 0, y: 0, w: W, h: H });
  if (!r) return mask;
  const c = scratchCanvas('raster', r.w, r.h), g = c.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, r.w, r.h);
  g.translate(-r.x, -r.y); g.fillStyle = '#fff';
  draw(g);
  g.setTransform(1, 0, 0, 1, 0, 0);
  const a = g.getImageData(0, 0, r.w, r.h).data;
  for (let y = 0; y < r.h; y++) {
    const o = (r.y + y) * W + r.x;
    for (let x = 0; x < r.w; x++) { const v = a[(y * r.w + x) * 4 + 3]; mask[o + x] = aa ? v : v >= 128 ? 255 : 0; }
  }
  return mask;
}

function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y; }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Ramer–Douglas–Peucker. eps in document px. Keeps corners; never moves points. */
function simplify(pts, eps) {
  if (eps <= 0 || pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(), A = pts[a], B = pts[b], dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs(dy * pts[i].x - dx * pts[i].y + B.x * A.y - B.y * A.x) / L; if (d > best) { best = d; bi = i; } }
    if (best > eps) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function commitShapeSelection(mask, mode, label) {
  const o = O().select;
  if (o.feather > 0) mask = P.feather(mask, doc().width, doc().height, o.feather);
  PP.Ops.combineSelection(mask, mode, label);
}

function sampleColor(x, y, merged, size) {
  const d = doc(), l = d.active;
  let src, sx = Math.floor(x), sy = Math.floor(y);
  if (merged || !l) src = view().flattened();
  else { src = l.source(); sx -= l.x; sy -= l.y; }
  const r = (size - 1) >> 1, x0 = U.clamp(sx - r, 0, src.width - 1), y0 = U.clamp(sy - r, 0, src.height - 1);
  if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) return null;
  const w = Math.min(size, src.width - x0), h = Math.min(size, src.height - y0), px = U.read(src, x0, y0, w, h).data;
  let R = 0, G = 0, B = 0, A = 0;
  for (let i = 0; i < px.length; i += 4) { const a = px[i + 3]; R += px[i] * a; G += px[i + 1] * a; B += px[i + 2] * a; A += a; }
  if (!A) return null;
  return [R / A, G / A, B / A, A / (px.length / 4)];
}

function constrain45(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), L = Math.hypot(dx, dy);
  return { x: a.x + Math.cos(ang) * L, y: a.y + Math.sin(ang) * L };
}

/** Drag rectangle with Shift = square, Alt = from centre. Integer pixel aligned when snap. */
function dragRect(a, b, e, snap) {
  let w = b.x - a.x, h = b.y - a.y;
  if (e.shift) { const s = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * s; h = Math.sign(h || 1) * s; }
  let x = a.x, y = a.y;
  if (e.alt) { x -= w; y -= h; w *= 2; h *= 2; }
  let r = { x: Math.min(x, x + w), y: Math.min(y, y + h), w: Math.abs(w), h: Math.abs(h) };
  if (snap) { const x0 = Math.round(r.x), y0 = Math.round(r.y); r = { x: x0, y: y0, w: Math.round(r.x + r.w) - x0, h: Math.round(r.y + r.h) - y0 }; }
  return r;
}

function strokeDocRect(g, v, r, dash) {
  const x = Math.round(v.X(r.x)) + 0.5, y = Math.round(v.Y(r.y)) + 0.5, w = Math.round(r.w * v.scale), h = Math.round(r.h * v.scale);
  g.lineWidth = 1; g.setLineDash([]); g.strokeStyle = '#fff'; g.strokeRect(x, y, w, h);
  g.setLineDash(dash ? [4, 4] : []); g.strokeStyle = '#000'; g.strokeRect(x, y, w, h); g.setLineDash([]);
}

function strokeDocPath(g, v, pts, close, extra) {
  if (!pts.length) return;
  g.beginPath(); g.moveTo(v.X(pts[0].x), v.Y(pts[0].y));
  for (let i = 1; i < pts.length; i++) g.lineTo(v.X(pts[i].x), v.Y(pts[i].y));
  if (extra) g.lineTo(v.X(extra.x), v.Y(extra.y));
  if (close) g.closePath();
  g.lineWidth = v.dpr; g.setLineDash([]); g.strokeStyle = '#fff'; g.stroke();
  g.setLineDash([4 * v.dpr, 4 * v.dpr]); g.strokeStyle = '#000'; g.stroke(); g.setLineDash([]);
}

function handle(g, v, x, y) { const X = Math.round(v.X(x)), Y = Math.round(v.Y(y)), s = 4 * v.dpr; g.fillStyle = '#fff'; g.strokeStyle = '#000'; g.lineWidth = 1; g.fillRect(X - s, Y - s, s * 2, s * 2); g.strokeRect(X - s + 0.5, Y - s + 0.5, s * 2 - 1, s * 2 - 1); }

/* ───────────── BrushEngine ─────────────
 * Dabs accumulate (by flow) into a stroke buffer; each frame the touched rect of the target is
 * rebuilt as base + buffer × opacity (clipped by selection). Opacity therefore never stacks within
 * a stroke, eraser/reveal/hide use the same path, and history stores only touched tiles. */
class Stroke {
  constructor(o) {
    Object.assign(this, o);
    const d = doc();
    if (this.target === 'selection') {
      const s = d.selection;
      this.canvas = U.maskToCanvas(s.mask || new Uint8Array(s.w * s.h), s.w, s.h);
      this.ox = 0; this.oy = 0; this.sel = null;
      app().qmPreview = this.canvas;
    } else {
      this.canvas = this.target === 'mask' ? this.layer.mask : this.layer.canvas;
      this.ox = this.layer.x; this.oy = this.layer.y;
      this.edit = new M.PixelEdit(this.layer, this.target);
      this.sel = d.selection.canvas();
    }
    const w = this.canvas.width, h = this.canvas.height;
    this.base = U.clone(this.canvas);
    this.buf = scratchCanvas('stroke', w, h); this.bg = this.buf.getContext('2d');
    this.bg.setTransform(1, 0, 0, 1, 0, 0); this.bg.globalCompositeOperation = 'source-over'; this.bg.clearRect(0, 0, w, h);
    this.pending = null; this.last = null; this.carry = 0; this.raf = 0;
    if (this.kind === 'clone' || this.kind === 'heal') this.dab = U.canvas(1, 1);
    if (this.airbrush) this.air = setInterval(() => { if (this.last) { this.dabAt(this.last.x, this.last.y, this.last.p); this.schedule(); } }, 50);
  }
  dabAt(x, y, p) {
    const ps = this.pressure ? p : 1, size = Math.max(0.5, this.size * (this.pressure ? 0.15 + 0.85 * p : 1)), g = this.bg;
    g.globalAlpha = U.clamp(this.flow * ps, 0, 1);
    let r;
    if (this.kind === 'pencil') {
      const n = Math.max(1, Math.round(size)), x0 = Math.floor(x - (n - 1) / 2), y0 = Math.floor(y - (n - 1) / 2);
      g.fillStyle = `rgb(${this.rgb})`;
      if (n <= 3) g.fillRect(x0, y0, n, n);
      else { const rr = n / 2; for (let j = 0; j < n; j++) { const dy = j + 0.5 - rr, hw = Math.round(Math.sqrt(Math.max(0, rr * rr - dy * dy))); g.fillRect(Math.floor(x0 + rr - hw), y0 + j, hw * 2, 1); } }
      r = { x: x0, y: y0, w: n, h: n };
    } else if (this.kind === 'clone' || this.kind === 'heal') {
      const t = tip(size, this.hardness, '255,255,255'), s = t.width, dc = this.dab;
      if (dc.width !== s) { dc.width = s; dc.height = s; }
      const dg = dc.getContext('2d'), sx = x + this.ox + this.offX - this.srcOX - s / 2, sy = y + this.oy + this.offY - this.srcOY - s / 2;
      dg.globalCompositeOperation = 'copy'; dg.drawImage(this.src, sx, sy, s, s, 0, 0, s, s);
      if (this.kind === 'heal') this.healDab(dc, x - s / 2, y - s / 2, t);
      dg.globalCompositeOperation = 'destination-in'; dg.drawImage(t, 0, 0);
      g.drawImage(dc, x - s / 2, y - s / 2);
      r = { x: x - s / 2, y: y - s / 2, w: s, h: s };
    } else {
      const t = tip(size, this.hardness, this.rgb);
      g.drawImage(t, x - t.width / 2, y - t.height / 2);
      r = { x: x - t.width / 2, y: y - t.height / 2, w: t.width, h: t.height };
    }
    this.pending = U.union(this.pending, r);
  }
  /** Healing: shift source texture by the difference of tip-weighted mean colours (dest − source). */
  healDab(dc, bx, by, t) {
    const s = dc.width, src = U.read(dc), dst = U.read(this.base, Math.floor(bx), Math.floor(by), s, s), w = U.read(t).data;
    const ms = [0, 0, 0], md = [0, 0, 0]; let ws = 0, wd = 0;
    for (let i = 0; i < w.length; i += 4) {
      const k = w[i + 3], ka = (k * src.data[i + 3]) / 255, kd = (k * dst.data[i + 3]) / 255;
      for (let c = 0; c < 3; c++) { ms[c] += src.data[i + c] * ka; md[c] += dst.data[i + c] * kd; }
      ws += ka; wd += kd;
    }
    if (!ws || !wd) return;
    const off = [0, 1, 2].map(c => md[c] / wd - ms[c] / ws), d = src.data;
    for (let i = 0; i < d.length; i += 4) { d[i] += off[0]; d[i + 1] += off[1]; d[i + 2] += off[2]; }
    dc.getContext('2d').putImageData(src, 0, 0);
  }
  to(e) {
    const x = e.x - this.ox, y = e.y - this.oy, p = e.pressure;
    if (!this.last) { this.dabAt(x, y, p); this.last = { x, y, p }; this.schedule(); return; }
    const L = this.last, dx = x - L.x, dy = y - L.y, dist = Math.hypot(dx, dy);
    const step = this.kind === 'pencil' ? 1 : Math.max(0.5, (this.spacing / 100) * this.size);
    let t = step - this.carry;
    while (t <= dist) { const k = t / dist; this.dabAt(L.x + dx * k, L.y + dy * k, L.p + (p - L.p) * k); t += step; }
    this.carry = dist - (t - step);
    this.last = { x, y, p };
    this.schedule();
  }
  schedule() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.flush(); }); }
  flush() {
    const c = this.canvas, rr = this.pending && U.intersect(U.snap(this.pending), { x: 0, y: 0, w: c.width, h: c.height });
    this.pending = null;
    if (!rr) return;
    if (this.edit) this.edit.save(rr, this.base);
    const g = c.getContext('2d');
    g.save();
    g.clearRect(rr.x, rr.y, rr.w, rr.h);
    g.drawImage(this.base, rr.x, rr.y, rr.w, rr.h, rr.x, rr.y, rr.w, rr.h);
    let src = this.buf, sx = rr.x, sy = rr.y;
    if (this.sel) {
      const t = scratchCanvas('clip', rr.w, rr.h), tg = t.getContext('2d');
      tg.globalCompositeOperation = 'copy'; tg.drawImage(this.buf, rr.x, rr.y, rr.w, rr.h, 0, 0, rr.w, rr.h);
      tg.globalCompositeOperation = 'destination-in'; tg.drawImage(this.sel, rr.x + this.ox, rr.y + this.oy, rr.w, rr.h, 0, 0, rr.w, rr.h);
      tg.globalCompositeOperation = 'source-over';
      src = t; sx = 0; sy = 0;
    }
    g.globalAlpha = this.opacity; g.globalCompositeOperation = this.op;
    g.drawImage(src, sx, sy, rr.w, rr.h, rr.x, rr.y, rr.w, rr.h);
    g.restore();
    if (this.target === 'selection') view().requestOverlay(); else this.layer.touch(rr);
  }
  end() {
    clearInterval(this.air); cancelAnimationFrame(this.raf); this.raf = 0;
    this.flush();
    if (this.target === 'selection') { app().qmPreview = null; PP.Ops.setSelection(U.canvasAlpha(this.canvas), this.label); }
    else this.edit.commit(this.label);
  }
  cancel() {
    clearInterval(this.air); cancelAnimationFrame(this.raf); this.raf = 0;
    if (this.target === 'selection') { app().qmPreview = null; view().requestOverlay(); return; }
    const g = this.canvas.getContext('2d'); g.save(); g.globalCompositeOperation = 'copy'; g.drawImage(this.base, 0, 0); g.restore();
    this.layer.touch();
  }
}

/* ───────────── tool definitions ───────────── */
const sizeOpt = (k = 'brush') => [
  { key: k + '.size', label: 'Size', type: 'range', min: 1, max: 1000, step: 1, unit: 'px', log: true },
  { key: k + '.hardness', label: 'Hardness', type: 'range', min: 0, max: 100, unit: '%' },
  { key: k + '.opacity', label: 'Opacity', type: 'range', min: 1, max: 100, unit: '%' },
  { key: k + '.flow', label: 'Flow', type: 'range', min: 1, max: 100, unit: '%' }
];
const brushExtras = [
  { key: 'brush.spacing', label: 'Spacing', type: 'range', min: 1, max: 200, unit: '%' },
  { key: 'brush.smoothing', label: 'Smoothing', type: 'range', min: 0, max: 95, unit: '%' },
  { key: 'brush.pressure', label: 'Pressure', type: 'check' }
];
const selOpts = (extra = []) => [
  { key: 'select.mode', label: 'Mode', type: 'select', options: [['replace', 'New'], ['add', 'Add'], ['subtract', 'Subtract'], ['intersect', 'Intersect']] },
  { key: 'select.feather', label: 'Feather', type: 'range', min: 0, max: 250, step: 0.5, unit: 'px' },
  { key: 'select.antialias', label: 'Anti-alias', type: 'check' },
  ...extra
];

/** Base for brush-like tools. */
function paintTool(def) {
  return Object.assign({
    stroke: null, smooth: null,
    radius() { return O().brush.size / 2; },
    down(e) {
      const o = O().brush, cfg = this.config(e);
      if (!cfg) return;
      const layer = cfg.target === 'selection' ? null : PP.Ops.editableLayer({ mask: cfg.target === 'mask' });
      if (cfg.target !== 'selection' && !layer) return;
      this.stroke = new Stroke(Object.assign({
        layer, size: o.size, hardness: o.hardness / 100, opacity: o.opacity / 100, flow: o.flow / 100,
        spacing: o.spacing, pressure: o.pressure && e.type === 'pen', label: this.name
      }, cfg));
      this.smooth = { x: e.x, y: e.y };
      this.stroke.to(e);
    },
    move(e) {
      if (!this.stroke) return;
      const s = O().brush.smoothing / 100;
      if (s > 0) { this.smooth.x += (e.x - this.smooth.x) * (1 - s); this.smooth.y += (e.y - this.smooth.y) * (1 - s); e = Object.assign({}, e, this.smooth); }
      this.stroke.to(e);
    },
    up() { if (this.stroke) { this.stroke.end(); this.stroke = null; } },
    cancel() { if (this.stroke) { this.stroke.cancel(); this.stroke = null; } }
  }, def);
}

function layerTargetConfig(e, colorRgb, erase) {
  const t = app().target;
  if (t === 'mask' && doc().active && doc().active.mask) {
    const reveal = !erase && (colorRgb[0] * 0.2126 + colorRgb[1] * 0.7152 + colorRgb[2] * 0.0722) >= 128;
    return { target: 'mask', rgb: '255,255,255', op: reveal ? 'source-over' : 'destination-out' };
  }
  return { target: 'pixels', rgb: colorRgb.join(','), op: erase ? 'destination-out' : 'source-over' };
}

const fg = () => U.hexToRgb(app().colors.fg), bgc = () => U.hexToRgb(app().colors.bg);

const tools = [];
const def = t => (tools.push(t), t);

/* Move — moves the active layer (arrow keys nudge: 1 px, Shift 10 px). */
def({
  id: 'move', name: 'Move', key: 'v', cursor: 'move',
  icon: 'M12 2v20M2 12h20M12 2l-3 3M12 2l3 3M12 22l-3-3M12 22l3-3M2 12l3-3M2 12l3 3M22 12l-3-3M22 12l-3 3',
  options: [{ type: 'note', text: 'Drag to move the active layer · arrows nudge' }],
  down(e) { const l = PP.Ops.editableLayer({ any: true }); if (!l) return; this.s = { l, x0: l.x, y0: l.y, px: e.x, py: e.y }; },
  move(e) {
    if (!this.s) return;
    let dx = Math.round(e.x - this.s.px), dy = Math.round(e.y - this.s.py);
    if (e.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    const l = this.s.l; l.x = this.s.x0 + dx; l.y = this.s.y0 + dy;
    bus.emit('pixels', { rect: null });
  },
  up() { if (!this.s) return; const s = this.s; this.s = null; PP.Ops.recordMove(s.l, s.x0, s.y0); },
  cancel() { if (this.s) { const l = this.s.l; l.x = this.s.x0; l.y = this.s.y0; this.s = null; bus.emit('pixels', { rect: null }); } },
  key(e) {
    const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!k) return false;
    const l = PP.Ops.editableLayer({ any: true }); if (!l) return true;
    const n = e.shiftKey ? 10 : 1, x0 = l.x, y0 = l.y;
    l.x += k[0] * n; l.y += k[1] * n;
    PP.Ops.recordMove(l, x0, y0); bus.emit('pixels', { rect: null });
    return true;
  }
});

def({
  id: 'hand', name: 'Hand', key: 'h', cursor: 'grab',
  icon: 'M8 13V5a1.5 1.5 0 0 1 3 0v7M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V5a1.5 1.5 0 0 1 3 0v8M17 9a1.5 1.5 0 0 1 3 0v5a7 7 0 0 1-7 7h-1a7 7 0 0 1-5.6-2.8L3.5 15a1.5 1.5 0 0 1 2.3-1.9L8 15',
  options: [{ type: 'button', label: 'Fit', action: () => view().fit() }, { type: 'button', label: '100%', action: () => view().actual() }],
  down(e) { this.p = { x: e.clientX, y: e.clientY }; },
  move(e) { if (!this.p) return; view().panBy(e.clientX - this.p.x, e.clientY - this.p.y); this.p = { x: e.clientX, y: e.clientY }; },
  up() { this.p = null; }, cancel() { this.p = null; }
});

def({
  id: 'zoom', name: 'Zoom', key: 'z', cursor: 'zoom-in',
  icon: 'M10.5 3a7.5 7.5 0 1 0 0 15a7.5 7.5 0 1 0 0-15M16 16l5 5M10.5 7v7M7 10.5h7',
  options: [{ type: 'note', text: 'Click to zoom in · Alt+click to zoom out' }, { type: 'button', label: 'Fit', action: () => view().fit() }, { type: 'button', label: '100%', action: () => view().actual() }],
  down(e) { view().step(e.alt ? -1 : 1, e.clientX, e.clientY); }
});

/* Rectangular / elliptical marquee */
function marquee(id, name, key, icon, ellipse) {
  return def({
    id, name, key, cursor: 'crosshair', icon, options: selOpts(),
    down(e) { this.a = { x: e.x, y: e.y }; this.mode = selMode(e); this.r = null; },
    move(e) { if (this.a) { this.r = dragRect(this.a, e, e, true); view().requestOverlay(); } },
    up() {
      if (!this.a) return;
      const r = this.r; this.a = null; this.r = null;
      if (!r || r.w < 1 || r.h < 1) { if (this.mode === 'replace') PP.Ops.deselect(); view().requestOverlay(); return; }
      const aa = O().select.antialias;
      const mask = rasterMask(r, g => { g.beginPath(); if (ellipse) g.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2); else g.rect(r.x, r.y, r.w, r.h); g.fill(); }, ellipse ? aa : false);
      commitShapeSelection(mask, this.mode, name);
    },
    cancel() { this.a = null; this.r = null; view().requestOverlay(); },
    overlay(g, v) {
      if (!this.r) return;
      const r = this.r;
      if (ellipse) { g.beginPath(); g.ellipse(v.X(r.x + r.w / 2), v.Y(r.y + r.h / 2), (r.w / 2) * v.scale, (r.h / 2) * v.scale, 0, 0, Math.PI * 2); g.lineWidth = v.dpr; g.strokeStyle = '#fff'; g.stroke(); g.setLineDash([4 * v.dpr, 4 * v.dpr]); g.strokeStyle = '#000'; g.stroke(); }
      else strokeDocRect(g, v, r, true);
      PP.UI && PP.UI.status({ sel: `${r.w} × ${r.h}` });
    }
  });
}
marquee('rect-select', 'Rectangular Marquee', 'm', 'M4 4h16v16H4z', false);
marquee('ellipse-select', 'Elliptical Marquee', null, 'M4 12a8 7 0 1 0 16 0a8 7 0 1 0-16 0', true);

function finishPolygonSelection(pts, mode, label) {
  if (pts.length < 3) { if (mode === 'replace') PP.Ops.deselect(); return; }
  const mask = rasterMask(bboxOf(pts), g => { g.beginPath(); g.moveTo(pts[0].x, pts[0].y); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y); g.closePath(); g.fill('nonzero'); }, O().select.antialias);
  commitShapeSelection(mask, mode, label);
}

/* Freehand lasso — records the user's exact pointer path (coalesced events, sub-pixel). */
def({
  id: 'lasso', name: 'Lasso', key: 'l', cursor: 'crosshair',
  icon: 'M7 17c-3-2-4-6 0-9s12-3 13 2-6 7-10 6M7 17c-1 2 0 4 2 4',
  options: selOpts([{ key: 'select.smoothing', label: 'Smoothing', type: 'range', min: 0, max: 5, step: 0.1, unit: 'px' }]),
  down(e) { this.pts = [{ x: e.x, y: e.y }]; this.mode = selMode(e); },
  move(e) {
    if (!this.pts) return;
    const l = this.pts[this.pts.length - 1];
    if (Math.hypot(e.x - l.x, e.y - l.y) >= 0.35) { this.pts.push({ x: e.x, y: e.y }); view().requestOverlay(); }
  },
  up() {
    if (!this.pts) return;
    const pts = simplify(this.pts, O().select.smoothing); this.pts = null;
    finishPolygonSelection(pts, this.mode, 'Lasso');
  },
  cancel() { this.pts = null; view().requestOverlay(); },
  overlay(g, v) { if (this.pts) strokeDocPath(g, v, this.pts, false); }
});

/* Polygon lasso — click vertices; double-click, Enter, or click the first vertex to close. */
def({
  id: 'poly-lasso', name: 'Polygonal Lasso', key: null, cursor: 'crosshair',
  icon: 'M4 19L6 5l7 4l7-3l-2 11z',
  options: selOpts([{ type: 'note', text: 'Backspace removes a vertex · Enter closes · Esc cancels' }]),
  pts: null, hover: null,
  down(e) {
    let p = { x: e.x, y: e.y };
    if (!this.pts) { this.pts = [p]; this.mode = selMode(e); return; }
    if (e.shift) p = constrain45(this.pts[this.pts.length - 1], p);
    const f = this.pts[0], v = view();
    if (this.pts.length > 2 && Math.hypot((p.x - f.x) * v.scale, (p.y - f.y) * v.scale) < 8 * v.dpr) return this.commit();
    this.pts.push(p);
  },
  hoverMove(e) { if (this.pts) { this.hover = e.shift ? constrain45(this.pts[this.pts.length - 1], e) : { x: e.x, y: e.y }; view().requestOverlay(); } },
  dblclick() { if (this.pts) this.commit(); },
  commit() { const pts = this.pts; this.pts = null; this.hover = null; if (pts) finishPolygonSelection(pts, this.mode, 'Polygonal Lasso'); view().requestOverlay(); },
  cancel() { this.pts = null; this.hover = null; view().requestOverlay(); },
  key(e) {
    if (!this.pts) return false;
    if (e.key === 'Backspace' || e.key === 'Delete') { this.pts.pop(); if (!this.pts.length) this.pts = null; view().requestOverlay(); return true; }
    if (e.key === 'Enter') { this.commit(); return true; }
    return false;
  },
  overlay(g, v) {
    if (!this.pts) return;
    strokeDocPath(g, v, this.pts, false, this.hover);
    for (const p of this.pts) handle(g, v, p.x, p.y);
  }
});

/* Magnetic (edge-assisted) lasso — Sobel gradient snapping within a user-set radius. Classical edge detection only. */
def({
  id: 'magnetic-lasso', name: 'Magnetic Lasso', key: null, cursor: 'crosshair',
  icon: 'M5 16c-3-3 0-11 8-11s9 6 4 9-9 2-9 2M8 16v3a2 2 0 0 0 4 0v-3',
  options: selOpts([
    { key: 'magnetic.width', label: 'Width', type: 'range', min: 1, max: 40, unit: 'px' },
    { key: 'magnetic.contrast', label: 'Edge contrast', type: 'range', min: 1, max: 100, unit: '%' },
    { key: 'magnetic.frequency', label: 'Frequency', type: 'range', min: 2, max: 40, unit: 'px' },
    { type: 'note', text: 'Click to start/anchor · move along an edge · Enter/double-click closes' }
  ]),
  pts: null, anchors: 0,
  grad() {
    const d = doc();
    if (!this.g || this.gRev !== this.compRev) {
      const img = U.read(view().flattened());
      this.g = P.sobelMagnitude(img); this.gRev = this.compRev; this.gw = d.width; this.gh = d.height;
    }
    return this.g;
  },
  init() { bus.on('pixels', () => { this.compRev = (this.compRev || 0) + 1; }); },
  snap(p) {
    const o = O().magnetic, g = this.grad(), w = this.gw, h = this.gh, R = o.width, thr = (o.contrast / 100) * 400;
    let best = null, bv = -Infinity;
    const cx = Math.round(p.x), cy = Math.round(p.y);
    for (let y = Math.max(0, cy - R); y <= Math.min(h - 1, cy + R); y++) for (let x = Math.max(0, cx - R); x <= Math.min(w - 1, cx + R); x++) {
      const dd = Math.hypot(x - p.x, y - p.y); if (dd > R) continue;
      const v = g[y * w + x]; if (v < thr) continue;
      const score = v * (1 - (0.5 * dd) / R);
      if (score > bv) { bv = score; best = { x: x + 0.5, y: y + 0.5 }; }
    }
    return best || { x: p.x, y: p.y };
  },
  down(e) {
    if (!this.pts) { this.mode = selMode(e); this.pts = [this.snap(e)]; this.anchors = 1; this.anchorIdx = [0]; view().requestOverlay(); return; }
    const f = this.pts[0], v = view();
    if (this.pts.length > 2 && Math.hypot((e.x - f.x) * v.scale, (e.y - f.y) * v.scale) < 8 * v.dpr) return this.commit();
    this.pts.push({ x: e.x, y: e.y }); this.anchorIdx.push(this.pts.length - 1);
  },
  move(e) { this.track(e); },
  hoverMove(e) { this.track(e); },
  track(e) {
    if (!this.pts) return;
    const last = this.pts[this.pts.length - 1], step = O().magnetic.frequency, dist = Math.hypot(e.x - last.x, e.y - last.y);
    if (dist >= step) {
      const n = Math.floor(dist / step);
      for (let i = 1; i <= n; i++) { const k = (i * step) / dist; this.pts.push(this.snap({ x: last.x + (e.x - last.x) * k, y: last.y + (e.y - last.y) * k })); }
    }
    this.hover = { x: e.x, y: e.y }; view().requestOverlay();
  },
  dblclick() { this.commit(); },
  commit() { const pts = this.pts; this.pts = null; this.hover = null; if (pts) finishPolygonSelection(pts, this.mode, 'Magnetic Lasso'); view().requestOverlay(); },
  cancel() { this.pts = null; this.hover = null; view().requestOverlay(); },
  key(e) {
    if (!this.pts) return false;
    if (e.key === 'Enter') { this.commit(); return true; }
    if (e.key === 'Backspace') { // remove back to previous anchor
      const a = this.anchorIdx; if (a.length > 1) a.pop();
      this.pts.length = a[a.length - 1] + 1; view().requestOverlay(); return true;
    }
    return false;
  },
  overlay(g, v) { if (this.pts) { strokeDocPath(g, v, this.pts, false, this.hover); for (const i of this.anchorIdx) handle(g, v, this.pts[i].x, this.pts[i].y); } }
});

/* Magic wand */
def({
  id: 'wand', name: 'Magic Wand', key: 'w', cursor: 'crosshair',
  icon: 'M4 20l12-12M14 6l2 2M18 2v4M16 4h4M20 9v2M19 10h2M11 3v2M10 4h2',
  options: selOpts([
    { key: 'wand.tolerance', label: 'Tolerance', type: 'range', min: 0, max: 255 },
    { key: 'wand.contiguous', label: 'Contiguous', type: 'check' },
    { key: 'wand.diagonal', label: '8-way', type: 'check' },
    { key: 'wand.merged', label: 'Sample merged', type: 'check' }
  ]),
  down(e) {
    const o = O().wand, d = doc(), l = d.active, mode = selMode(e);
    let mask;
    if (o.merged || !l) mask = P.floodMask(U.read(view().flattened()), e.x, e.y, o);
    else { // sample active layer, map to document space
      const lm = P.floodMask(U.read(l.source()), e.x - l.x, e.y - l.y, o);
      mask = new Uint8Array(d.width * d.height);
      for (let y = Math.max(0, l.y); y < Math.min(d.height, l.y + l.h); y++) {
        const x0 = Math.max(0, l.x), x1 = Math.min(d.width, l.x + l.w);
        if (x1 > x0) mask.set(lm.subarray((y - l.y) * l.w + (x0 - l.x), (y - l.y) * l.w + (x1 - l.x)), y * d.width + x0);
      }
    }
    if (O().select.antialias) mask = P.antialias(mask, d.width, d.height);
    commitShapeSelection(mask, mode, 'Magic Wand');
  }
});

/* Colour range — global colour match of the clicked colour. */
def({
  id: 'color-range', name: 'Color Range', key: null, cursor: 'crosshair',
  icon: 'M20 4a2.8 2.8 0 0 0-4 0l-3 3-1-1-2 2 6 6 2-2-1-1 3-3a2.8 2.8 0 0 0 0-4zM11 9l-7 7v4h4l7-7M3 3h4M5 1v4',
  options: selOpts([
    { key: 'range.tolerance', label: 'Tolerance', type: 'range', min: 0, max: 255 },
    { key: 'range.fuzziness', label: 'Fuzziness', type: 'range', min: 0, max: 255 },
    { key: 'wand.merged', label: 'Sample merged', type: 'check' }
  ]),
  down(e) {
    const o = O().range, merged = O().wand.merged, c = sampleColor(e.x, e.y, merged, 1);
    const color = c || [0, 0, 0, 0], src = merged || !doc().active ? view().flattened() : null;
    PP.Ops.colorRange(color, o.tolerance, o.fuzziness, selMode(e), src);
  }
});

/* Mask brush — paint the selection directly (Reveal = add, Hide = remove). Quick-mask overlay shown. */
def(paintTool({
  id: 'mask-brush', name: 'Selection Brush', key: 'q', cursor: 'none',
  icon: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 3v18M12 7l4-3M12 12l7-5M12 17l8-6',
  options: [{ key: 'maskBrush.mode', label: 'Mode', type: 'select', options: [['reveal', 'Reveal (add)'], ['hide', 'Hide (remove)']] }, ...sizeOpt(), { type: 'note', text: 'Alt inverts mode · red = unselected' }],
  activate() { app().quickMask = true; view().requestOverlay(); },
  deactivate() { app().quickMask = !!app().quickMaskSticky; view().requestOverlay(); },
  config(e) {
    let hide = O().maskBrush.mode === 'hide'; if (e.alt) hide = !hide;
    return { target: 'selection', rgb: '255,255,255', op: hide ? 'destination-out' : 'source-over', label: hide ? 'Hide Mask' : 'Reveal Mask' };
  }
}));

def(paintTool({
  id: 'brush', name: 'Brush', key: 'b', cursor: 'none',
  icon: 'M18.4 2.6a2 2 0 0 1 3 3L11 16l-3-3zM8 13c-2 0-4 1.5-4 4 0 1.5-1 2.5-2 3 3 1 7 0 8-3',
  options: [...sizeOpt(), ...brushExtras, { key: 'brush.airbrush', label: 'Airbrush', type: 'check' }],
  config(e) { return Object.assign(layerTargetConfig(e, fg()), { airbrush: O().brush.airbrush }); }
}));

def(paintTool({
  id: 'pencil', name: 'Pencil', key: 'n', cursor: 'none',
  icon: 'M3 21l1-5L16 4l4 4L8 20zM14 6l4 4',
  options: [{ key: 'brush.size', label: 'Size', type: 'range', min: 1, max: 100, unit: 'px' }, { key: 'brush.opacity', label: 'Opacity', type: 'range', min: 1, max: 100, unit: '%' }],
  radius() { return Math.max(0.5, Math.round(O().brush.size) / 2); },
  config(e) { return Object.assign(layerTargetConfig(e, fg()), { kind: 'pencil', flow: 1, pressure: false }); }
}));

def(paintTool({
  id: 'eraser', name: 'Eraser', key: 'e', cursor: 'none',
  icon: 'M8 20h12M5 16l9-11 6 5-9 10H8zM10 9l6 5',
  options: [...sizeOpt(), ...brushExtras],
  config(e) { return layerTargetConfig(e, [0, 0, 0], true); }
}));

/* Clone stamp / Healing brush — Alt+click sets the source point. */
function cloneTool(id, name, key, icon, kind) {
  return def(paintTool({
    id, name, key, icon, cursor: 'none',
    options: [...sizeOpt(), { key: 'clone.aligned', label: 'Aligned', type: 'check' }, { key: 'clone.merged', label: 'Sample merged', type: 'check' }, { type: 'note', text: 'Alt+click sets source' }],
    down(e) {
      if (e.alt) { this.source = { x: e.x, y: e.y }; this.offset = null; toast('Source set'); return; }
      if (!this.source) { toast('Alt+click to set a source point first', 'warn'); return; }
      const o = O().clone, l = PP.Ops.editableLayer(); if (!l) return;
      if (!o.aligned || !this.offset) this.offset = { x: this.source.x - e.x, y: this.source.y - e.y };
      const b = O().brush, merged = o.merged;
      this.stroke = new Stroke({
        layer: l, target: 'pixels', kind, op: 'source-over', rgb: '0,0,0', label: name,
        size: b.size, hardness: b.hardness / 100, opacity: b.opacity / 100, flow: b.flow / 100, spacing: Math.min(b.spacing, 25), pressure: b.pressure && e.type === 'pen'
      });
      Object.assign(this.stroke, { src: merged ? view().flattened() : this.stroke.base, srcOX: merged ? 0 : l.x, srcOY: merged ? 0 : l.y, offX: this.offset.x, offY: this.offset.y });
      this.smooth = { x: e.x, y: e.y }; this.cur = e; this.stroke.to(e);
    },
    hoverMove(e) { this.cur = e; },
    overlay(g, v) {
      if (!this.source) return;
      let p = this.source;
      if (this.stroke && this.cur) p = { x: this.cur.x + this.offset.x, y: this.cur.y + this.offset.y };
      const X = v.X(p.x), Y = v.Y(p.y), s = 6 * v.dpr;
      g.lineWidth = v.dpr; g.strokeStyle = '#fff'; g.beginPath(); g.moveTo(X - s, Y); g.lineTo(X + s, Y); g.moveTo(X, Y - s); g.lineTo(X, Y + s); g.stroke();
    },
    move(e) { this.cur = e; if (this.stroke) this.stroke.to(e); }
  }));
}
cloneTool('clone', 'Clone Stamp', 's', 'M9 3h6v5l3 4H6l3-4zM5 15h14v3H5zM5 21h14', 'clone');
cloneTool('heal', 'Healing Brush', 'j', 'M4.9 13.4l8.5-8.5a3 3 0 0 1 4.2 0l1.5 1.5a3 3 0 0 1 0 4.2l-8.5 8.5a3 3 0 0 1-4.2 0l-1.5-1.5a3 3 0 0 1 0-4.2zM10 10h.01M14 14h.01M12 12h.01', 'heal');

/* Fill bucket */
def({
  id: 'fill', name: 'Fill Bucket', key: 'g', cursor: 'crosshair',
  icon: 'M5 11l7-7 8 8-7 7a2 2 0 0 1-3 0l-5-5a2 2 0 0 1 0-3zM5 11h15M21 17s-2 2.5-2 4a2 2 0 0 0 4 0c0-1.5-2-4-2-4',
  options: [
    { key: 'fill.tolerance', label: 'Tolerance', type: 'range', min: 0, max: 255 },
    { key: 'fill.opacity', label: 'Opacity', type: 'range', min: 1, max: 100, unit: '%' },
    { key: 'fill.contiguous', label: 'Contiguous', type: 'check' }, { key: 'fill.diagonal', label: '8-way', type: 'check' },
    { key: 'fill.merged', label: 'Sample merged', type: 'check' }, { key: 'fill.antialias', label: 'Anti-alias', type: 'check' }
  ],
  down(e) {
    const l = PP.Ops.editableLayer(); if (!l) return;
    const o = O().fill, src = o.merged ? view().flattened() : null;
    let mask;
    if (src) mask = P.floodMask(U.read(src), e.x, e.y, o);
    else mask = P.floodMask(U.read(l.canvas), e.x - l.x, e.y - l.y, o);
    // to layer-local
    if (src) { const full = mask; mask = new Uint8Array(l.w * l.h); const d = doc(); for (let y = 0; y < l.h; y++) { const dy = y + l.y; if (dy < 0 || dy >= d.height) continue; for (let x = 0; x < l.w; x++) { const dx = x + l.x; if (dx >= 0 && dx < d.width) mask[y * l.w + x] = full[dy * d.width + dx]; } } }
    if (o.antialias) mask = P.antialias(mask, l.w, l.h);
    const sm = l.selMask(doc().selection);
    if (sm) mask = P.combine(mask, sm, 'intersect');
    const bb = P.bounds(mask, l.w, l.h); if (!bb) return;
    const edit = new M.PixelEdit(l); edit.save(bb);
    const img = U.read(l.canvas, bb.x, bb.y, bb.w, bb.h), sub = new Uint8Array(bb.w * bb.h);
    for (let y = 0; y < bb.h; y++) sub.set(mask.subarray((bb.y + y) * l.w + bb.x, (bb.y + y) * l.w + bb.x + bb.w), y * bb.w);
    P.fillThroughMask(img.data, sub, fg(), o.opacity / 100);
    U.write(l.canvas, img, bb.x, bb.y); l.touch(bb); edit.commit('Fill');
  }
});

/* Colour picker */
def({
  id: 'picker', name: 'Color Picker', key: 'i', cursor: 'crosshair',
  icon: 'M20 4a2.8 2.8 0 0 0-4 0l-3 3-1-1-2 2 6 6 2-2-1-1 3-3a2.8 2.8 0 0 0 0-4zM11 9l-7 7v4h4l7-7',
  options: [{ key: 'picker.size', label: 'Sample', type: 'select', options: [[1, 'Point'], [3, '3×3 avg'], [5, '5×5 avg'], [11, '11×11 avg']] }, { key: 'picker.merged', label: 'Sample merged', type: 'check' }, { type: 'note', text: 'Alt+click sets background' }],
  down(e) { this.pick(e); }, move(e) { this.pick(e); },
  pick(e) { const c = sampleColor(e.x, e.y, O().picker.merged, +O().picker.size); if (c) PP.Ops.setColor(e.alt ? 'bg' : 'fg', U.rgbToHex(c[0], c[1], c[2])); }
});

/* Crop */
def({
  id: 'crop', name: 'Crop', key: 'c', cursor: 'crosshair',
  icon: 'M6 2v16h16M2 6h16v16',
  options: [{ key: 'crop.delete', label: 'Delete cropped pixels', type: 'check' }, { type: 'button', label: 'Apply', action: () => PP.app.tools.current.commit && PP.app.tools.current.commit() }, { type: 'button', label: 'Cancel', action: () => PP.app.tools.cancel() }],
  r: null,
  down(e) {
    if (this.r && e.x >= this.r.x && e.y >= this.r.y && e.x <= this.r.x + this.r.w && e.y <= this.r.y + this.r.h) { this.drag = { px: e.x, py: e.y, r: Object.assign({}, this.r) }; return; }
    this.a = { x: e.x, y: e.y }; this.r = null;
  },
  move(e) {
    if (this.drag) { const d = this.drag; this.r = Object.assign({}, d.r, { x: Math.round(d.r.x + e.x - d.px), y: Math.round(d.r.y + e.y - d.py) }); }
    else if (this.a) this.r = dragRect(this.a, e, e, true);
    view().requestOverlay();
  },
  up() { this.a = null; this.drag = null; if (this.r && (this.r.w < 1 || this.r.h < 1)) this.r = null; view().requestOverlay(); },
  dblclick() { this.commit(); },
  commit() { if (this.r) { const r = this.r; this.r = null; PP.Ops.crop(r, O().crop.delete); } },
  cancel() { this.r = null; this.a = null; this.drag = null; view().requestOverlay(); },
  key(e) { if (e.key === 'Enter' && this.r) { this.commit(); return true; } return false; },
  overlay(g, v) {
    if (!this.r) return;
    const r = this.r, X = v.X(r.x), Y = v.Y(r.y), W = r.w * v.scale, H = r.h * v.scale;
    g.fillStyle = 'rgba(0,0,0,.55)'; g.beginPath(); g.rect(0, 0, g.canvas.width, g.canvas.height); g.rect(X, Y + H, W, -H); g.fill('evenodd');
    strokeDocRect(g, v, r, false);
    g.strokeStyle = 'rgba(255,255,255,.35)'; g.beginPath();
    for (let i = 1; i < 3; i++) { g.moveTo(X + (W * i) / 3, Y); g.lineTo(X + (W * i) / 3, Y + H); g.moveTo(X, Y + (H * i) / 3); g.lineTo(X + W, Y + (H * i) / 3); }
    g.stroke();
    PP.UI && PP.UI.status({ sel: `${r.w} × ${r.h}` });
  }
});

/* Text — click to create; click an existing text layer to edit it. */
def({
  id: 'text', name: 'Text', key: 't', cursor: 'text',
  icon: 'M4 6V4h16v2M12 4v16M9 20h6',
  options: [{ type: 'note', text: 'Click to add text · click a text layer to edit · text stays editable until rasterized' }],
  down(e) {
    const d = doc();
    const hit = [...d.layers].reverse().find(l => l.type === 'text' && l.visible && e.x >= l.x && e.y >= l.y && e.x < l.x + l.w && e.y < l.y + l.h);
    if (hit) { d.setActive(hit); PP.UI.textDialog(hit, false); return; }
    PP.Ops.addTextLayer(Math.round(e.x), Math.round(e.y));
  }
});

/* Shapes — rasterized onto the active layer. Stroke = foreground, fill = background. */
function shapeTool(id, name, key, icon, kind) {
  return def({
    id, name, key, icon, cursor: 'crosshair',
    options: [
      { key: 'shape.stroke', label: 'Stroke', type: 'check' }, { key: 'shape.width', label: 'Width', type: 'range', min: 1, max: 200, unit: 'px' },
      ...(kind === 'line' || kind === 'arrow' ? [] : [{ key: 'shape.fill', label: 'Fill (bg colour)', type: 'check' }]),
      ...(kind === 'rrect' ? [{ key: 'shape.radius', label: 'Radius', type: 'range', min: 0, max: 500, unit: 'px' }] : []),
      { key: 'shape.antialias', label: 'Anti-alias', type: 'check' },
      ...(kind === 'polygon' ? [{ type: 'note', text: 'Click vertices · Enter/double-click to finish' }] : [])
    ],
    pts: null,
    geom() {
      if (kind === 'polygon') return this.pts && { pts: this.hover ? [...this.pts, this.hover] : this.pts };
      if (!this.a || !this.b) return null;
      if (kind === 'line' || kind === 'arrow') return { a: this.a, b: this.b };
      return { r: dragRect(this.a, this.b, this.mods, false) };
    },
    path(g, G) {
      const o = O().shape;
      g.beginPath();
      if (G.pts) { g.moveTo(G.pts[0].x, G.pts[0].y); for (const p of G.pts.slice(1)) g.lineTo(p.x, p.y); g.closePath(); return; }
      if (G.a) {
        g.moveTo(G.a.x, G.a.y); g.lineTo(G.b.x, G.b.y);
        if (kind === 'arrow') {
          const ang = Math.atan2(G.b.y - G.a.y, G.b.x - G.a.x), L = Math.max(10, o.width * 4);
          g.moveTo(G.b.x - L * Math.cos(ang - 0.45), G.b.y - L * Math.sin(ang - 0.45)); g.lineTo(G.b.x, G.b.y); g.lineTo(G.b.x - L * Math.cos(ang + 0.45), G.b.y - L * Math.sin(ang + 0.45));
        }
        return;
      }
      const r = G.r;
      if (kind === 'ellipse') g.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      else if (kind === 'rrect') { const rad = Math.min(o.radius, r.w / 2, r.h / 2); if (g.roundRect) g.roundRect(r.x, r.y, r.w, r.h, rad); else g.rect(r.x, r.y, r.w, r.h); }
      else g.rect(r.x, r.y, r.w, r.h);
    },
    paint(g, G) {
      const o = O().shape, open = kind === 'line' || kind === 'arrow';
      g.lineJoin = 'round'; g.lineCap = 'round';
      this.path(g, G);
      if (!open && o.fill) { g.fillStyle = app().colors.bg; g.fill(); }
      if (open || o.stroke) { g.strokeStyle = app().colors.fg; g.lineWidth = o.width; g.stroke(); }
    },
    down(e) {
      if (kind === 'polygon') {
        const p = this.pts && e.shift ? constrain45(this.pts[this.pts.length - 1], e) : { x: e.x, y: e.y };
        (this.pts = this.pts || []).push(p); view().requestOverlay(); return;
      }
      this.a = { x: e.x, y: e.y }; this.b = null; this.mods = e;
    },
    move(e) { if (kind !== 'polygon' && this.a) { this.mods = e; this.b = (kind === 'line' || kind === 'arrow') && e.shift ? constrain45(this.a, e) : { x: e.x, y: e.y }; view().requestOverlay(); } },
    hoverMove(e) { if (kind === 'polygon' && this.pts) { this.hover = { x: e.x, y: e.y }; view().requestOverlay(); } },
    up() { if (kind !== 'polygon') this.commit(); },
    dblclick() { if (kind === 'polygon') this.commit(); },
    key(e) { if (kind === 'polygon' && this.pts && e.key === 'Enter') { this.commit(); return true; } if (kind === 'polygon' && this.pts && e.key === 'Backspace') { this.pts.pop(); if (!this.pts.length) this.pts = null; view().requestOverlay(); return true; } return false; },
    commit() {
      this.hover = null;
      const G = this.geom(); this.a = this.b = null; this.pts = null;
      view().requestOverlay();
      if (!G || (G.r && (G.r.w < 1 || G.r.h < 1)) || (G.pts && G.pts.length < 3) || (G.a && G.a.x === G.b.x && G.a.y === G.b.y)) return;
      PP.Ops.paintOnLayer(name, g => { g.imageSmoothingEnabled = true; this.paint(g, G); }, O().shape.antialias);
    },
    cancel() { this.a = this.b = null; this.pts = null; this.hover = null; view().requestOverlay(); },
    overlay(g, v) {
      const G = this.geom(); if (!G) return;
      g.save(); v.docTransform(g); g.globalAlpha = 0.85; this.paint(g, G); g.restore();
    }
  });
}
shapeTool('line', 'Line', 'u', 'M4 20L20 4', 'line');
shapeTool('arrow', 'Arrow', null, 'M4 20L19 5M10 5h9v9', 'arrow');
shapeTool('rect', 'Rectangle', null, 'M4 6h16v12H4z', 'rect');
shapeTool('rrect', 'Rounded Rectangle', null, 'M7 5h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z', 'rrect');
shapeTool('ellipse', 'Ellipse', null, 'M3 12a9 7 0 1 0 18 0a9 7 0 1 0-18 0', 'ellipse');
shapeTool('polygon', 'Polygon', null, 'M12 3l9 7-3.5 10h-11L3 10z', 'polygon');

/* Free transform (Ctrl+T): move inside, scale with handles (Shift keeps aspect), rotate outside (Shift snaps 15°). */
def({
  id: 'transform', name: 'Free Transform', key: null, cursor: 'default', hidden: true,
  icon: 'M4 4h4v4H4zM16 4h4v4h-4zM4 16h4v4H4zM16 16h4v4h-4zM8 6h8M8 18h8M6 8v8M18 8v8',
  options: [
    { key: 'xf.sx', label: 'W %', type: 'number', live: true }, { key: 'xf.sy', label: 'H %', type: 'number', live: true }, { key: 'xf.rot', label: 'Angle °', type: 'number', live: true },
    { type: 'button', label: 'Apply', action: () => PP.app.tools.current.commit() }, { type: 'button', label: 'Cancel', action: () => PP.app.tools.cancel() }
  ],
  activate() {
    const l = PP.Ops.editableLayer({ rasterizeText: true });
    if (!l) { PP.app.tools.select(this.prev || 'move'); return; }
    this.l = l; this.st = { tx: 0, ty: 0, sx: 1, sy: 1, rot: 0 };
    O().xf = { sx: 100, sy: 100, rot: 0 };
    this.apply();
  },
  deactivate() { if (this.l) { this.l.xform = null; this.l = null; bus.emit('pixels', { rect: null }); } },
  matrix() {
    const l = this.l, s = this.st, c = Math.cos(s.rot), n = Math.sin(s.rot), cx = l.x + l.w / 2 + s.tx, cy = l.y + l.h / 2 + s.ty;
    const a = c * s.sx, b = n * s.sx, cc = -n * s.sy, d = c * s.sy;
    return { a, b, c: cc, d, e: cx - a * (l.w / 2) - cc * (l.h / 2), f: cy - b * (l.w / 2) - d * (l.h / 2) };
  },
  pt(m, x, y) { return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }; },
  apply() { if (!this.l) return; this.l.xform = this.matrix(); O().xf = { sx: +(this.st.sx * 100).toFixed(2), sy: +(this.st.sy * 100).toFixed(2), rot: +((this.st.rot * 180) / Math.PI).toFixed(2) }; bus.emit('pixels', { rect: null }); bus.emit('options-values'); },
  optionChanged() { const x = O().xf; if (!this.l) return; this.st.sx = (+x.sx || 100) / 100; this.st.sy = (+x.sy || 100) / 100; this.st.rot = ((+x.rot || 0) * Math.PI) / 180; this.l.xform = this.matrix(); bus.emit('pixels', { rect: null }); },
  handles() { const l = this.l, m = this.matrix(), out = []; for (const hy of [-1, 0, 1]) for (const hx of [-1, 0, 1]) if (hx || hy) out.push({ hx, hy, p: this.pt(m, ((hx + 1) / 2) * l.w, ((hy + 1) / 2) * l.h) }); return out; },
  down(e) {
    if (!this.l) return;
    const v = view(), tol = 8 * v.dpr / v.scale;
    const h = this.handles().find(h => Math.hypot(h.p.x - e.x, h.p.y - e.y) < tol);
    const m = this.matrix(), det = m.a * m.d - m.b * m.c, lx = (m.d * (e.x - m.e) - m.c * (e.y - m.f)) / det, ly = (-m.b * (e.x - m.e) + m.a * (e.y - m.f)) / det;
    const inside = lx >= 0 && ly >= 0 && lx <= this.l.w && ly <= this.l.h;
    this.drag = { kind: h ? 'scale' : inside ? 'move' : 'rotate', h, e0: { x: e.x, y: e.y }, st: Object.assign({}, this.st), c: { x: this.l.x + this.l.w / 2 + this.st.tx, y: this.l.y + this.l.h / 2 + this.st.ty } };
  },
  move(e) {
    const D = this.drag; if (!D) return;
    const s0 = D.st, st = this.st;
    if (D.kind === 'move') { st.tx = s0.tx + e.x - D.e0.x; st.ty = s0.ty + e.y - D.e0.y; }
    else if (D.kind === 'rotate') {
      let a = s0.rot + Math.atan2(e.y - D.c.y, e.x - D.c.x) - Math.atan2(D.e0.y - D.c.y, D.e0.x - D.c.x);
      if (e.shift) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
      st.rot = a;
    } else {
      const c = Math.cos(s0.rot), n = Math.sin(s0.rot), dx = e.x - D.c.x, dy = e.y - D.c.y;
      const lx = c * dx + n * dy, ly = -n * dx + c * dy, W = this.l.w, H = this.l.h, { hx, hy } = D.h;
      let sx = s0.sx, sy = s0.sy, shx = 0, shy = 0;
      if (hx) { const fixed = -hx * (W * s0.sx) / 2, nw = (lx - fixed) * hx; sx = (nw / W) * Math.sign(s0.sx) || 0.001; }
      if (hy) { const fixed = -hy * (H * s0.sy) / 2, nh = (ly - fixed) * hy; sy = (nh / H) * Math.sign(s0.sy) || 0.001; }
      if (e.shift && hx && hy) { const k = Math.max(Math.abs(sx / s0.sx), Math.abs(sy / s0.sy)); sx = s0.sx * k * Math.sign(sx * s0.sx); sy = s0.sy * k * Math.sign(sy * s0.sy); }
      if (hx) shx = (hx * (W * (Math.abs(sx) - Math.abs(s0.sx)))) / 2;
      if (hy) shy = (hy * (H * (Math.abs(sy) - Math.abs(s0.sy)))) / 2;
      st.sx = sx; st.sy = sy; st.tx = s0.tx + c * shx - n * shy; st.ty = s0.ty + n * shx + c * shy;
    }
    this.apply();
  },
  up() { this.drag = null; },
  commit() {
    if (!this.l) return;
    const l = this.l, m = this.matrix(); l.xform = null; this.l = null;
    PP.Ops.applyTransform(l, m);
    PP.app.tools.select(this.prev || 'move');
  },
  cancel() { if (this.l) { this.l.xform = null; this.l = null; bus.emit('pixels', { rect: null }); } if (!PP.app.tools.switching) PP.app.tools.select(this.prev || 'move'); },
  key(e) { if (e.key === 'Enter') { this.commit(); return true; } return false; },
  overlay(g, v) {
    if (!this.l) return;
    const m = this.matrix(), l = this.l, c = [[0, 0], [l.w, 0], [l.w, l.h], [0, l.h]].map(([x, y]) => this.pt(m, x, y));
    strokeDocPath(g, v, c, true);
    for (const h of this.handles()) handle(g, v, h.p.x, h.p.y);
  }
});

/* ───────────── ToolManager ───────────── */
class ToolManager {
  constructor(view) {
    this.view = view; this.list = tools; this.byId = new Map(tools.map(t => [t.id, t]));
    this.current = null; this.active = false; this.touches = new Map(); this.temp = null; this.spaceHeld = false;
    for (const t of tools) t.init && t.init();
    this.attach(view.over);
  }
  select(id) {
    const t = this.byId.get(id); if (!t || t === this.current) return;
    const prev = this.current;
    this.switching = true;
    try { if (prev) { if (prev.cancel && (this.active || prev.pts || prev.r || prev.l)) prev.cancel(); prev.deactivate && prev.deactivate(); } }
    finally { this.switching = false; }
    this.active = false;
    t.prev = prev && prev.id !== 'transform' ? prev.id : t.prev;
    this.current = t;
    this.view.over.style.cursor = t.cursor || 'default';
    t.activate && t.activate();
    if (this.current !== t) return; // activate() redirected to another tool
    if (t.id !== 'transform') try { localStorage.setItem('pp.tool', id); } catch (e) { /* storage blocked */ }
    bus.emit('tool', t);
    this.view.requestOverlay();
  }
  cancel() { const t = this.current; this.active = false; t && t.cancel && t.cancel(); this.view.requestOverlay(); }
  /** Normalize a pointer event into document space. */
  ev(e) {
    const p = this.view.toDoc(e.clientX, e.clientY);
    return { x: p.x, y: p.y, pressure: e.pointerType === 'pen' ? (e.pressure || 0.5) : 1, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, button: e.button, type: e.pointerType, clientX: e.clientX, clientY: e.clientY };
  }
  attach(el) {
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('pointerdown', e => {
      if (!PP.app.doc) return;
      e.preventDefault(); el.focus && el.focus();
      if (e.pointerType === 'touch') {
        this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.touches.size === 2) { if (this.active) { this.current.cancel && this.current.cancel(); this.active = false; } this.startPinch(); return; }
        if (this.touches.size > 2) return;
      }
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (e.button === 1 || this.spaceHeld || (e.button === 0 && this.current.id === 'hand')) { this.temp = { x: e.clientX, y: e.clientY }; el.style.cursor = 'grabbing'; return; }
      if (e.button !== 0 && !(e.button === 2 && this.current.id === 'picker')) return;
      this.active = true;
      this.current.down && this.current.down(this.ev(e));
      this.view.requestOverlay();
    });
    el.addEventListener('pointermove', e => {
      if (!PP.app.doc) return;
      if (this.touches.has(e.pointerId)) { this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (this.pinch) { this.updatePinch(); return; } }
      if (this.temp) { this.view.panBy(e.clientX - this.temp.x, e.clientY - this.temp.y); this.temp = { x: e.clientX, y: e.clientY }; return; }
      const ev = this.ev(e), t = this.current;
      if (this.active) {
        const list = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
        if (list && list.length) for (const ce of list) t.move && t.move(this.ev(ce)); else t.move && t.move(ev);
      } else t.hoverMove && t.hoverMove(ev);
      this.view.cursor = t.radius ? { x: ev.x, y: ev.y, r: t.radius() } : null;
      if (t.radius || t.overlay || this.active) this.view.requestOverlay();
      PP.UI && PP.UI.status({ pos: ev });
    });
    const end = (e, cancelled) => {
      this.touches.delete(e.pointerId);
      if (this.pinch) { if (this.touches.size < 2) this.pinch = null; return; }
      if (this.temp) { this.temp = null; el.style.cursor = this.spaceHeld ? 'grab' : this.current.cursor || 'default'; return; }
      if (!this.active) return;
      this.active = false;
      if (cancelled) this.current.cancel && this.current.cancel(); else this.current.up && this.current.up(this.ev(e));
      this.view.requestOverlay();
    };
    el.addEventListener('pointerup', e => end(e, false));
    el.addEventListener('pointercancel', e => end(e, true));
    el.addEventListener('pointerleave', () => { this.view.cursor = null; this.view.requestOverlay(); });
    el.addEventListener('dblclick', e => { const t = this.current; t && t.dblclick && t.dblclick(this.ev(e)); });
    el.addEventListener('wheel', e => {
      if (!PP.app.doc) return;
      e.preventDefault();
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      if (e.ctrlKey || e.metaKey || e.altKey) this.view.setZoom(this.view.zoom * Math.exp(-e.deltaY * k * 0.0025), e.clientX, e.clientY);
      else this.view.panBy(-(e.shiftKey ? e.deltaY : e.deltaX) * k, -(e.shiftKey ? 0 : e.deltaY) * k);
    }, { passive: false });
  }
  startPinch() {
    const [a, b] = [...this.touches.values()];
    this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, z: this.view.zoom };
  }
  updatePinch() {
    const [a, b] = [...this.touches.values()], P0 = this.pinch, c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this.view.setZoom(P0.z * (Math.hypot(a.x - b.x, a.y - b.y) / P0.d), c.x, c.y);
    this.view.panBy(c.x - P0.c.x, c.y - P0.c.y); P0.c = c;
  }
  setSpace(held) {
    this.spaceHeld = held;
    this.view.over.style.cursor = held ? 'grab' : (this.current && this.current.cursor) || 'default';
  }
}

PP.Tools = { ToolManager, list: tools, Stroke, rasterMask, scratchCanvas };
})();
