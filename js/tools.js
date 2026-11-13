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
  if (e.button === 2) return 'subtract';
  if (e.shift && e.alt) return 'intersect';
  if (e.shift) return 'add';
  if (e.alt) return 'subtract';
  const m = O().select.mode; // subtracting from / intersecting with nothing would silently do nothing
  return (m === 'subtract' || m === 'intersect') && !doc().selection.active ? 'replace' : m;
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
  options: [{ type: 'note', text: 'Drag to move the selected layer · squares resize · round knob rotates · arrows nudge' }],
  init() { bus.on('layers', () => PP.app.view && PP.app.view.requestOverlay()); },
  /** Box handles of the selected layer (doc coords) — only for an unlocked, visible layer. */
  box() {
    const d = doc(), l = d && d.active; if (!l || l.locked || !l.visible || app().floating) return null;
    const hs = [];
    for (const hy of [-1, 0, 1]) for (const hx of [-1, 0, 1]) if (hx || hy) hs.push({ hx, hy, p: { x: l.x + ((hx + 1) / 2) * l.w, y: l.y + ((hy + 1) / 2) * l.h } });
    const top = { x: l.x + l.w / 2, y: l.y };
    return { l, hs, top, knob: rotKnob(view(), top, { x: l.x + l.w / 2, y: l.y + l.h / 2 }) };
  },
  boxHit(e) {
    const B = this.box(); if (!B) return null;
    const v = view(), tol = (8 * v.dpr) / v.scale;
    if (Math.hypot(B.knob.x - e.x, B.knob.y - e.y) < tol * 1.2) return 'rotate';
    const h = B.hs.find(h => Math.hypot(h.p.x - e.x, h.p.y - e.y) < tol);
    return h ? h : null;
  },
  hoverMove(e) { const h = this.boxHit(e); view().over.style.cursor = !h ? 'move' : h === 'rotate' ? ROT_CURSOR : RESIZE_CURSOR[h.hx + ',' + h.hy]; },
  down(e) {
    if (this.boxHit(e)) { // a handle or the knob: continue this same drag as a live transform
      const tm = app().tools; tm.select('transform');
      if (tm.current.id === 'transform') { tm.active = true; tm.current.down(e); }
      return;
    }
    const l = PP.Ops.editableLayer({ any: true }); if (!l) return; this.s = { l, x0: l.x, y0: l.y, px: e.x, py: e.y };
  },
  overlay(g, v) {
    const B = this.box(); if (!B || this.s) return;
    strokeDocRect(g, v, { x: B.l.x, y: B.l.y, w: B.l.w, h: B.l.h }, true);
    drawKnob(g, v, B.top, B.knob);
    for (const h of B.hs) handle(g, v, h.p.x, h.p.y);
  },
  move(e) {
    if (!this.s) return;
    let dx = Math.round(e.x - this.s.px), dy = Math.round(e.y - this.s.py);
    if (e.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    const l = this.s.l; l.x = this.s.x0 + dx; l.y = this.s.y0 + dy;
    bus.emit('pixels', { rect: null });
  },
  up() { if (!this.s) return; const s = this.s; this.s = null; PP.Ops.recordMove(s.l, s.x0, s.y0); },
  cancel() { if (this.s) { const l = this.s.l; l.x = this.s.x0; l.y = this.s.y0; this.s = null; bus.emit('pixels', { rect: null }); } },
  onKey(e) {
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


/** MS Paint style: dragging inside the selection lifts its pixels into a floating selection
 * (Ctrl+drag lifts a copy and leaves the original). Returns true when the click was consumed. */
function liftAt(e) {
  const s = doc().selection;
  if (e.shift || e.alt || e.button === 2 || O().select.mode !== 'replace' || !s.active) return false;
  const x = Math.floor(e.x), y = Math.floor(e.y);
  if (x < 0 || y < 0 || x >= s.w || y >= s.h || s.mask[y * s.w + x] < 128) return false;
  const tm = app().tools;
  if (PP.Ops.liftSelection(e.ctrl) && tm.current.id === 'paste') { tm.active = true; tm.current.down(e); }
  return true;
}

/* Rectangular / elliptical marquee */
function marquee(id, name, key, icon, ellipse) {
  return def({
    id, name, key, cursor: 'crosshair', icon, rightClick: true, options: selOpts([{ type: 'note', text: 'Shift adds · right-drag subtracts · drag inside a selection to move it (Ctrl duplicates)' }]),
    down(e) { if (liftAt(e)) return; this.a = { x: e.x, y: e.y }; this.mode = selMode(e); this.r = null; },
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
  id: 'lasso', name: 'Lasso', key: 'l', cursor: 'crosshair', rightClick: true,
  icon: 'M7 17c-3-2-4-6 0-9s12-3 13 2-6 7-10 6M7 17c-1 2 0 4 2 4',
  options: selOpts([{ key: 'select.smoothing', label: 'Smoothing', type: 'range', min: 0, max: 5, step: 0.1, unit: 'px' }]),
  down(e) { if (liftAt(e)) return; this.pts = [{ x: e.x, y: e.y }]; this.mode = selMode(e); },
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

/** Switch to the plain selection brush in add ('reveal') or remove ('hide') mode — manual fine-tuning. */
function selBrush(mode) {
  O().maskBrush.mode = mode; PP.IO.savePrefs();
  const tm = app().tools;
  if (tm.current.id === 'mask-brush') bus.emit('tool', tm.current); else tm.select('mask-brush');
}
const brushJump = [{ type: 'button', label: '+ Add brush', action: () => selBrush('reveal') }, { type: 'button', label: '− Remove brush', action: () => selBrush('hide') }];

/* Smart select — draw roughly around an object; the outline snaps to the strongest nearby edges
 * (Sobel gradient searched along the outline's normals, outliers median-filtered). When the snapped
 * contour is well described by an ellipse/circle, a clean least-squares ellipse is used instead.
 * Classical image processing only: the user's rough outline is always the starting point. */
function resampleClosed(pts, step) {
  const out = [], n = pts.length;
  let carry = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n], L = Math.hypot(b.x - a.x, b.y - a.y);
    let t = carry;
    while (t < L) { const k = t / L; out.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }); t += step; }
    carry = t - L;
  }
  return out;
}
/** Move each point along its normal (±R) to the strongest edge; points with no edge keep their place. */
function snapToEdges(pts, R, thr) {
  const d = doc(), bb = bboxOf(pts);
  const r = U.intersect(U.snap({ x: bb.x - R - 2, y: bb.y - R - 2, w: bb.w + 2 * R + 4, h: bb.h + 2 * R + 4 }), { x: 0, y: 0, w: d.width, h: d.height });
  if (!r) return { pts, hits: 0 };
  const g = P.sobelMagnitude(U.read(view().flattened(), r.x, r.y, r.w, r.h)), n = pts.length, off = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const p = pts[i], a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    let nx = -(b.y - a.y), ny = b.x - a.x; const L = Math.hypot(nx, ny) || 1; nx /= L; ny /= L;
    let best = -1, bt = NaN;
    for (let t = -R; t <= R; t += 0.5) {
      const x = Math.round(p.x + nx * t) - r.x, y = Math.round(p.y + ny * t) - r.y;
      if (x < 0 || y < 0 || x >= r.w || y >= r.h) continue;
      const v = g[y * r.w + x]; if (v < thr) continue;
      const s = v * (1 - (0.7 * Math.abs(t)) / R);
      if (s > best) { best = s; bt = t; }
    }
    off[i] = bt; p.nx = nx; p.ny = ny;
  }
  // robust smoothing: median of valid neighbours (window 7), then a light average
  const med = new Float32Array(n), win = [];
  let hits = 0;
  for (let i = 0; i < n; i++) {
    win.length = 0;
    for (let k = -3; k <= 3; k++) { const v = off[(i + k + n) % n]; if (v === v) win.push(v); }
    win.sort((x, y) => x - y);
    med[i] = win.length ? win[win.length >> 1] : 0;
    if (off[i] === off[i]) hits++;
  }
  const out = pts.map((p, i) => { const t = (med[(i - 1 + n) % n] + med[i] + med[(i + 1) % n]) / 3; return { x: p.x + p.nx * t, y: p.y + p.ny * t, ok: off[i] === off[i] }; });
  return { pts: out, hits: hits / n };
}
/** Least-squares conic Ax²+Bxy+Cy²+Dx+Ey=1 → ellipse {cx,cy,a,b,rot,err} or null. */
function fitEllipse(pts) {
  if (pts.length < 8) return null;
  let mx = 0, my = 0; for (const p of pts) { mx += p.x; my += p.y; } mx /= pts.length; my /= pts.length;
  let sc = 0; for (const p of pts) sc += Math.hypot(p.x - mx, p.y - my); sc = sc / pts.length || 1;
  const M = Array.from({ length: 5 }, () => new Float64Array(6));
  for (const p of pts) {
    const x = (p.x - mx) / sc, y = (p.y - my) / sc, row = [x * x, x * y, y * y, x, y];
    for (let i = 0; i < 5; i++) { for (let j = 0; j < 5; j++) M[i][j] += row[i] * row[j]; M[i][5] += row[i]; }
  }
  for (let c = 0; c < 5; c++) { // Gaussian elimination, partial pivoting
    let piv = c; for (let r = c + 1; r < 5; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < 5; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k < 6; k++) M[r][k] -= f * M[c][k]; }
  }
  const [A, B, C, D, E] = M.map((r, i) => r[5] / r[i]), F = -1, den = B * B - 4 * A * C;
  if (den >= 0) return null; // not an ellipse
  const x0 = (2 * C * D - B * E) / den, y0 = (2 * A * E - B * D) / den;
  const F0 = A * x0 * x0 + B * x0 * y0 + C * y0 * y0 + D * x0 + E * y0 + F;
  const rot = 0.5 * Math.atan2(B, A - C), c = Math.cos(rot), s = Math.sin(rot);
  const lu = A * c * c + B * s * c + C * s * s, lv = A * s * s - B * s * c + C * c * c;
  if (-F0 / lu <= 0 || -F0 / lv <= 0) return null;
  const e = { cx: x0 * sc + mx, cy: y0 * sc + my, a: Math.sqrt(-F0 / lu) * sc, b: Math.sqrt(-F0 / lv) * sc, rot };
  let err = 0;
  for (const p of pts) {
    const dx = p.x - e.cx, dy = p.y - e.cy, u = dx * c + dy * s, v = -dx * s + dy * c;
    err += Math.abs(Math.hypot(u / e.a, v / e.b) - 1);
  }
  e.err = err / pts.length;
  return e;
}
const ellipsePts = (e, step) => {
  const n = Math.max(24, Math.ceil((Math.PI * (e.a + e.b)) / step)), c = Math.cos(e.rot), s = Math.sin(e.rot), out = [];
  for (let i = 0; i < n; i++) { const t = (i / n) * Math.PI * 2, u = e.a * Math.cos(t), v = e.b * Math.sin(t); out.push({ x: e.cx + u * c - v * s, y: e.cy + u * s + v * c }); }
  return out;
};

def({
  id: 'smart-select', name: 'Smart Select', key: null, cursor: 'crosshair', rightClick: true,
  icon: 'M4 12a7 6 0 1 0 14 0a7 6 0 1 0-14 0M19 2v4M17 4h4M20 9v2M19 10h2',
  options: selOpts([
    { key: 'smart.radius', label: 'Snap distance', type: 'range', min: 3, max: 60, unit: 'px' },
    { key: 'smart.contrast', label: 'Edge contrast', type: 'range', min: 1, max: 100, unit: '%' },
    { key: 'smart.shapes', label: 'Snap to circle/ellipse', type: 'check' }, ...brushJump,
    { type: 'note', text: 'Draw roughly around an object — it snaps to the edges · Shift adds · right-drag subtracts' }
  ]),
  down(e) { if (liftAt(e)) return; this.pts = [{ x: e.x, y: e.y }]; this.mode = selMode(e); },
  move(e) {
    if (!this.pts) return;
    const l = this.pts[this.pts.length - 1];
    if (Math.hypot(e.x - l.x, e.y - l.y) >= 0.5) { this.pts.push({ x: e.x, y: e.y }); view().requestOverlay(); }
  },
  up() {
    if (!this.pts) return;
    const raw = this.pts; this.pts = null; view().requestOverlay();
    const bb = bboxOf(raw);
    if (raw.length < 3 || bb.w < 3 || bb.h < 3) { if (this.mode === 'replace') PP.Ops.deselect(); return; }
    const o = O().smart, R = o.radius, thr = (o.contrast / 100) * 400, step = Math.max(1, Math.min(3, Math.max(bb.w, bb.h) / 150));
    PP.UI.busy(true, 'Finding edges…');
    setTimeout(() => { // let the busy indicator paint first
      try {
        let snap = snapToEdges(resampleClosed(raw, step), R, thr), shape = null;
        if (o.shapes && snap.hits > 0.3) {
          let el = fitEllipse(snap.pts.filter(p => p.ok));
          if (el && el.err < 0.08) { // refine once more from the clean ellipse with a tighter search
            const again = snapToEdges(ellipsePts(el, step), Math.max(3, R / 2), thr), el2 = fitEllipse(again.pts.filter(p => p.ok));
            if (el2 && el2.err < el.err * 1.5) el = el2;
          }
          if (el && el.err < 0.05 && el.a > 2 && el.b > 2) shape = el;
        }
        if (shape) {
          const r = Math.max(shape.a, shape.b);
          const mask = rasterMask({ x: shape.cx - r, y: shape.cy - r, w: 2 * r, h: 2 * r }, g => { g.beginPath(); g.ellipse(shape.cx, shape.cy, shape.a, shape.b, shape.rot, 0, Math.PI * 2); g.fill(); }, O().select.antialias);
          commitShapeSelection(mask, this.mode, 'Smart Select');
          toast(Math.abs(shape.a - shape.b) < 0.03 * Math.max(shape.a, shape.b) ? 'Snapped to a circle' : 'Snapped to an ellipse');
        } else {
          finishPolygonSelection(snap.pts, this.mode, 'Smart Select');
          toast(snap.hits < 0.15 ? 'No clear edges found — kept your outline (try lower Edge contrast)' : 'Snapped to edges');
        }
      } finally { PP.UI.busy(false); }
    }, 16);
  },
  cancel() { this.pts = null; view().requestOverlay(); },
  overlay(g, v) { if (this.pts) strokeDocPath(g, v, this.pts, true); }
});

/* Quick select brush — paint over an object: everything under the brush is selected and the selection
 * grows outward (up to 2× the brush radius) into neighbouring pixels of similar colour, stopping at
 * colour edges. Left = add, right-drag / Alt = subtract (or the Mode option, for touch). */
def({
  id: 'quick-select', name: 'Quick Select Brush', key: null, cursor: 'none', rightClick: true,
  icon: 'M4 20c2.5 0 4-1.5 4-3.5a2 2 0 0 0-4 0M8 15l9.5-9.5a2 2 0 0 0-3-3L5 12M14 20h1M17 18h1M19 15v1',
  options: [
    { key: 'quick.mode', label: 'Mode', type: 'select', options: [['add', 'Add'], ['subtract', 'Subtract']] },
    { key: 'quick.size', label: 'Size', type: 'range', min: 2, max: 400, unit: 'px', log: true },
    { key: 'quick.tolerance', label: 'Tolerance', type: 'range', min: 1, max: 100 },
    { key: 'select.feather', label: 'Feather', type: 'range', min: 0, max: 250, step: 0.5, unit: 'px' }, ...brushJump,
    { type: 'note', text: 'Paint over the object · right-drag or Alt removes · blue = adding, red = removing' }
  ],
  init() { bus.on('pixels', () => { this.compRev = (this.compRev || 0) + 1; }); },
  radius() { return O().quick.size / 2; },
  image() { // composite pixels, cached until the image changes
    if (!this.img || this.imgRev !== this.compRev || this.img.width !== doc().width || this.img.height !== doc().height) { this.img = U.read(view().flattened()); this.imgRev = this.compRev; }
    return this.img;
  },
  down(e) {
    const d = doc(), o = O().quick;
    let sub = o.mode === 'subtract'; if (e.alt || e.button === 2) sub = !sub;
    this.s = { sub, mask: new Uint8Array(d.width * d.height), tint: U.canvas(d.width, d.height), last: null, img: this.image() };
    this.to(e);
  },
  move(e) { if (this.s) this.to(e); },
  to(e) {
    const S = this.s, r = Math.max(1, O().quick.size / 2), step = Math.max(1, r / 2);
    if (!S.last) { this.dab(e.x, e.y, r); S.last = { x: e.x, y: e.y }; return; }
    const L = S.last, dist = Math.hypot(e.x - L.x, e.y - L.y); if (dist < step) return;
    for (let t = step; t <= dist; t += step) this.dab(L.x + ((e.x - L.x) * t) / dist, L.y + ((e.y - L.y) * t) / dist, r);
    S.last = { x: e.x, y: e.y };
  },
  dab(x, y, r) {
    const S = this.s, d = doc(), W = d.width, H = d.height, px = S.img.data, m = S.mask, tol = O().quick.tolerance;
    const cx = Math.round(x), cy = Math.round(y), R = Math.ceil(r * 2);
    const x0 = Math.max(0, cx - R), y0 = Math.max(0, cy - R), x1 = Math.min(W - 1, cx + R), y1 = Math.min(H - 1, cy + R);
    if (x1 < x0 || y1 < y0) return;
    // the brush disc is always taken; its mean colour bounds how far the growth may drift
    const seeds = []; let n = 0, mr = 0, mg = 0, mb = 0;
    for (let yy = Math.max(y0, cy - Math.ceil(r)); yy <= Math.min(y1, cy + Math.ceil(r)); yy++) for (let xx = Math.max(x0, cx - Math.ceil(r)); xx <= Math.min(x1, cx + Math.ceil(r)); xx++) {
      if ((xx - x) * (xx - x) + (yy - y) * (yy - y) > r * r) continue;
      const p = yy * W + xx, i = p * 4; mr += px[i]; mg += px[i + 1]; mb += px[i + 2]; n++;
      if (m[p] !== 255) { m[p] = 255; seeds.push(p); } else seeds.push(p);
    }
    if (!n) return;
    mr /= n; mg /= n; mb /= n;
    const stepT = tol * tol, driftT = (2.5 * tol) * (2.5 * tol), R2 = R * R, stack = seeds;
    const near = (a, b) => { const i = a * 4, j = b * 4, dr = px[i] - px[j], dg = px[i + 1] - px[j + 1], db = px[i + 2] - px[j + 2]; return dr * dr + dg * dg + db * db <= stepT; };
    const drift = q => { const j = q * 4, dr = px[j] - mr, dg = px[j + 1] - mg, db = px[j + 2] - mb; return dr * dr + dg * dg + db * db <= driftT; };
    const seen = new Set(seeds);
    while (stack.length) {
      const p = stack.pop(), X = p % W, Y = (p - X) / W;
      for (const [q, qx, qy] of [[p - 1, X - 1, Y], [p + 1, X + 1, Y], [p - W, X, Y - 1], [p + W, X, Y + 1]]) {
        if (qx < x0 || qx > x1 || qy < y0 || qy > y1 || seen.has(q)) continue;
        if ((qx - cx) * (qx - cx) + (qy - cy) * (qy - cy) > R2) continue;
        seen.add(q);
        if (near(p, q) && drift(q)) { m[q] = 255; stack.push(q); }
      }
    }
    // refresh the tint for this window
    const ww = x1 - x0 + 1, hh = y1 - y0 + 1, img = new ImageData(ww, hh), t = img.data, c = S.sub ? [255, 60, 60] : [40, 140, 255];
    for (let yy = 0; yy < hh; yy++) for (let xx = 0; xx < ww; xx++) if (m[(y0 + yy) * W + x0 + xx]) { const k = (yy * ww + xx) * 4; t[k] = c[0]; t[k + 1] = c[1]; t[k + 2] = c[2]; t[k + 3] = 255; }
    U.write(S.tint, img, x0, y0);
    view().requestOverlay();
  },
  up() {
    const S = this.s; this.s = null; if (!S) return;
    const d = doc();
    if (!P.bounds(S.mask, d.width, d.height)) { view().requestOverlay(); return; }
    commitShapeSelection(P.antialias(S.mask, d.width, d.height), S.sub ? 'subtract' : 'add', S.sub ? 'Quick Select −' : 'Quick Select +');
  },
  cancel() { this.s = null; view().requestOverlay(); },
  overlay(g, v) {
    if (!this.s) return;
    v.docTransform(g); g.imageSmoothingEnabled = v.zoom < 1; g.globalAlpha = 0.45; g.drawImage(this.s.tint, 0, 0);
    g.globalAlpha = 1; g.setTransform(1, 0, 0, 1, 0, 0);
  }
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
  onKey(e) {
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
  onKey(e) {
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
  id: 'wand', name: 'Magic Wand', key: 'w', cursor: 'crosshair', rightClick: true,
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
  id: 'color-range', name: 'Color Range', key: null, cursor: 'crosshair', rightClick: true,
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
  id: 'mask-brush', name: 'Selection Brush', key: 'q', cursor: 'none', rightClick: true,
  icon: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M12 3v18M12 7l4-3M12 12l7-5M12 17l8-6',
  options: [{ key: 'maskBrush.mode', label: 'Mode', type: 'select', options: [['reveal', 'Reveal (add)'], ['hide', 'Hide (remove)']] }, ...sizeOpt(), { type: 'note', text: 'Right-drag or Alt does the opposite · red = unselected' }],
  activate() { app().quickMask = true; view().requestOverlay(); },
  optionChanged(k) { if (k === 'maskBrush.mode') bus.emit('tool', this); },
  deactivate() { app().quickMask = !!app().quickMaskSticky; view().requestOverlay(); },
  config(e) {
    let hide = O().maskBrush.mode === 'hide'; if (e.alt || e.button === 2) hide = !hide;
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

/* Skin smoothing brush — two classical retouching modes (no AI):
 *  smooth : edge-preserving bilateral blur (smooths texture/wrinkles, stops at strong edges like eyes and lips),
 *           computed lazily per 64 px tile from the stroke's starting pixels and painted through a soft brush.
 *  heal   : blemish removal — a clean donor patch next to the spot is chosen by matching the surrounding ring,
 *           then corrected by a membrane (Laplace) solve so its colour/lighting meet the surroundings seamlessly. */
/** Bilateral filter of src (sw×sh RGBA) for the inner rect; writes RGBA into out (iw×ih). sigma: colour tolerance. */
function bilateralTile(src, sw, sh, r, sigma, ix, iy, iw, ih, out) {
  const st = Math.max(1, Math.floor(r / 6)), ss = Math.max(0.5, r / 2), offs = [];
  for (let dy = -r; dy <= r; dy += st) for (let dx = -r; dx <= r; dx += st) if (dx * dx + dy * dy <= r * r) offs.push(dx, dy, Math.exp(-(dx * dx + dy * dy) / (2 * ss * ss)));
  const lut = new Float32Array(766); for (let d = 0; d < 766; d++) lut[d] = Math.exp(-((d / sigma) ** 2) / 2);
  for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
    const X = ix + x, Y = iy + y, i = (Y * sw + X) * 4, o = (y * iw + x) * 4, R0 = src[i], G0 = src[i + 1], B0 = src[i + 2];
    let W = 0, r_ = 0, g_ = 0, b_ = 0;
    for (let k = 0; k < offs.length; k += 3) {
      const xx = X + offs[k], yy = Y + offs[k + 1];
      if (xx < 0 || yy < 0 || xx >= sw || yy >= sh) continue;
      const j = (yy * sw + xx) * 4; if (!src[j + 3]) continue;
      const w = offs[k + 2] * lut[Math.abs(src[j] - R0) + Math.abs(src[j + 1] - G0) + Math.abs(src[j + 2] - B0)];
      W += w; r_ += src[j] * w; g_ += src[j + 1] * w; b_ += src[j + 2] * w;
    }
    out[o] = W ? r_ / W : R0; out[o + 1] = W ? g_ / W : G0; out[o + 2] = W ? b_ / W : B0; out[o + 3] = src[i + 3];
  }
}
/** Heal a disc of radius R centred (cx,cy) in a bs×bs box T (RGBA, modified in place) from candidate donor boxes.
 * mask (optional, bs×bs 0–255) limits the change. Returns false when no donor was usable. */
function healBox(T, donors, bs, cx, cy, R, strength, mask) {
  const n = bs * bs, dist = new Float32Array(n);
  for (let y = 0; y < bs; y++) for (let x = 0; x < bs; x++) dist[y * bs + x] = Math.hypot(x - cx, y - cy);
  let best = null, bestS = Infinity;
  for (const D of donors) { // ring similarity + smoothness inside (avoid donors that contain blemishes)
    let ring = 0, rc = 0, mr = 0, mg = 0, mb = 0, ic = 0;
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      if (dist[p] >= R && dist[p] <= R + 2) { ring += (T[i] - D[i]) ** 2 + (T[i + 1] - D[i + 1]) ** 2 + (T[i + 2] - D[i + 2]) ** 2; rc++; }
      else if (dist[p] < R) { mr += D[i]; mg += D[i + 1]; mb += D[i + 2]; ic++; }
    }
    if (!rc || !ic) continue;
    mr /= ic; mg /= ic; mb /= ic;
    let v = 0; for (let p = 0; p < n; p++) if (dist[p] < R) { const i = p * 4; v += (D[i] - mr) ** 2 + (D[i + 1] - mg) ** 2 + (D[i + 2] - mb) ** 2; }
    const s = ring / rc + 0.5 * (v / ic);
    if (s < bestS) { bestS = s; best = D; }
  }
  if (!best) return false;
  const D = best, iters = Math.min(600, Math.max(30, Math.ceil(R * 4))), omega = 1.85;
  for (let c = 0; c < 3; c++) {
    const f = new Float32Array(n); let bsum = 0, bc = 0;
    for (let p = 0; p < n; p++) if (dist[p] >= R) { f[p] = T[p * 4 + c] - D[p * 4 + c]; if (dist[p] <= R + 2) { bsum += f[p]; bc++; } }
    const init = bc ? bsum / bc : 0;
    for (let p = 0; p < n; p++) if (dist[p] < R) f[p] = init;
    for (let it = 0; it < iters; it++) // SOR on the interior; the ring is the fixed boundary
      for (let y = 1; y < bs - 1; y++) for (let x = 1; x < bs - 1; x++) {
        const p = y * bs + x; if (dist[p] >= R) continue;
        f[p] += omega * ((f[p - 1] + f[p + 1] + f[p - bs] + f[p + bs]) / 4 - f[p]);
      }
    for (let p = 0; p < n; p++) {
      if (dist[p] >= R) continue;
      let w = strength * Math.min(1, (R - dist[p]) / Math.max(1, R * 0.25)); if (mask) w *= mask[p] / 255;
      const i = p * 4 + c; T[i] += (D[i] + f[p] - T[i]) * w;
    }
  }
  return true;
}

def({
  id: 'skin', name: 'Skin Smoothing Brush', key: null, cursor: 'none',
  icon: 'M12 3a7 7.5 0 1 0 0 15a7 7.5 0 1 0 0-15M9.5 9.5h.01M14.5 9.5h.01M9.5 13.5c1.4 1 3.6 1 5 0M19 2v4M17 4h4M5 20l3-3',
  options: [
    { key: 'skin.mode', label: 'Mode', type: 'select', options: [['smooth', 'Smooth skin (wrinkles, texture)'], ['heal', 'Remove blemish (pimples, spots)']] },
    { key: 'skin.size', label: 'Size', type: 'range', min: 4, max: 400, unit: 'px', log: true },
    { key: 'skin.strength', label: 'Strength', type: 'range', min: 5, max: 100, unit: '%' },
    { key: 'skin.radius', label: 'Smoothness', type: 'range', min: 2, max: 24, unit: 'px' },
    { key: 'skin.detail', label: 'Keep edges', type: 'range', min: 5, max: 80 },
    { type: 'note', text: 'Smooth: paint over skin — eyes/lips stay sharp · Blemish: click each spot with a brush a little bigger than it' }
  ],
  radius() { return O().skin.size / 2; },
  down(e) {
    const l = PP.Ops.editableLayer({ rasterizeText: true }); if (!l) return;
    const o = O().skin;
    if (o.mode === 'heal') { this.h = { l, edit: new M.PixelEdit(l), last: null, sm: l.selMask(doc().selection) }; this.healTo(e); return; }
    const st = this.stroke = new Stroke({ layer: l, target: 'pixels', kind: 'clone', op: 'source-over', rgb: '0,0,0', label: 'Smooth Skin', size: o.size, hardness: 0.3, opacity: o.strength / 100, flow: 1, spacing: 12, pressure: false });
    const proc = U.canvas(l.w, l.h), done = new Set(), r = Math.round(o.radius), sigma = Math.max(4, 90 - o.detail), T = 64, base = st.base, dab = st.dabAt.bind(st);
    Object.assign(st, { src: proc, srcOX: l.x, srcOY: l.y, offX: 0, offY: 0 });
    st.dabAt = (x, y, p) => { // filter only the tiles this dab touches (from the stroke's starting pixels)
      const s = st.size / 2 + 2;
      for (let ty = Math.max(0, Math.floor((y - s) / T)); ty <= Math.min(Math.ceil(l.h / T) - 1, Math.floor((y + s) / T)); ty++)
        for (let tx = Math.max(0, Math.floor((x - s) / T)); tx <= Math.min(Math.ceil(l.w / T) - 1, Math.floor((x + s) / T)); tx++) {
          const key = tx + ',' + ty; if (done.has(key)) continue; done.add(key);
          const X = tx * T, Y = ty * T, tw = Math.min(T, l.w - X), th = Math.min(T, l.h - Y);
          const rx = Math.max(0, X - r), ry = Math.max(0, Y - r), rw = Math.min(l.w, X + tw + r) - rx, rh = Math.min(l.h, Y + th + r) - ry;
          const out = new ImageData(tw, th);
          bilateralTile(U.read(base, rx, ry, rw, rh).data, rw, rh, r, sigma, X - rx, Y - ry, tw, th, out.data);
          U.write(proc, out, X, Y);
        }
      dab(x, y, p);
    };
    st.to(e);
  },
  move(e) { if (this.stroke) this.stroke.to(e); else if (this.h) this.healTo(e); },
  healTo(e) {
    const H = this.h, l = H.l, R = Math.max(1.5, O().skin.size / 2), x = e.x - l.x, y = e.y - l.y;
    if (!H.last) { this.spot(x, y, R); H.last = { x, y }; return; }
    const dx = x - H.last.x, dy = y - H.last.y, d = Math.hypot(dx, dy), step = Math.max(1, R * 0.5);
    if (d < step) return;
    for (let t = step; t <= d; t += step) this.spot(H.last.x + (dx * t) / d, H.last.y + (dy * t) / d, R);
    H.last = { x, y };
  },
  spot(x, y, R) {
    const H = this.h, l = H.l, r = Math.ceil(R) + 2, bs = 2 * r + 1, bx = Math.round(x) - r, by = Math.round(y) - r;
    if (bx + bs <= 0 || by + bs <= 0 || bx >= l.w || by >= l.h) return;
    const donors = [];
    for (let k = 0; k < 16; k++) {
      const a = (k * Math.PI) / 8, ox = bx + Math.round(Math.cos(a) * R * 2.3), oy = by + Math.round(Math.sin(a) * R * 2.3);
      if (ox >= 0 && oy >= 0 && ox + bs <= l.w && oy + bs <= l.h) donors.push(U.read(l.canvas, ox, oy, bs, bs).data);
    }
    const T = U.read(l.canvas, bx, by, bs, bs);
    let mask = null;
    if (H.sm) { mask = new Uint8Array(bs * bs); for (let yy = 0; yy < bs; yy++) for (let xx = 0; xx < bs; xx++) { const X = bx + xx, Y = by + yy; mask[yy * bs + xx] = X >= 0 && Y >= 0 && X < l.w && Y < l.h ? H.sm[Y * l.w + X] : 0; } }
    if (!healBox(T.data, donors, bs, x - bx, y - by, R, O().skin.strength / 100, mask)) { if (!H.warned) { H.warned = true; toast('Too close to the edge to find clean skin nearby', 'warn'); } return; }
    const rect = { x: bx, y: by, w: bs, h: bs };
    H.edit.save(rect); U.write(l.canvas, T, bx, by); l.touch(rect);
  },
  up() {
    if (this.stroke) { this.stroke.end(); this.stroke = null; }
    if (this.h) { this.h.edit.commit('Remove Blemish'); this.h = null; }
  },
  cancel() {
    if (this.stroke) { this.stroke.cancel(); this.stroke = null; }
    if (this.h) { const H = this.h; for (const t of H.edit.tiles.values()) U.write(H.l.canvas, t.before, t.x, t.y); H.l.touch(); this.h = null; }
  }
});
PP.SkinMath = { bilateralTile, healBox }; // exposed for checks

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
  onKey(e) { if (e.key === 'Enter' && this.r) { this.commit(); return true; } return false; },
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
    onKey(e) { if (kind === 'polygon' && this.pts && e.key === 'Enter') { this.commit(); return true; } if (kind === 'polygon' && this.pts && e.key === 'Backspace') { this.pts.pop(); if (!this.pts.length) this.pts = null; view().requestOverlay(); return true; } return false; },
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

/* Free transform (Ctrl+T, or drag a Move-tool handle): drag inside to move, square handles to resize
 * (Shift keeps proportions), the round knob — or anywhere outside — to rotate (Shift snaps 15°).
 * Live preview only; Enter / Apply / switching tools bakes it in one step, Esc cancels. */
const ROT_KNOB = 26; // screen px above the top edge
function rotKnob(v, top, centre) { // knob position beyond the top-centre handle, away from the centre
  const dx = top.x - centre.x, dy = top.y - centre.y, L = Math.hypot(dx, dy) || 1, k = (ROT_KNOB * v.dpr) / v.scale / L;
  return { x: top.x + dx * k, y: top.y + dy * k };
}
function drawKnob(g, v, top, knob) {
  g.beginPath(); g.moveTo(v.X(top.x), v.Y(top.y)); g.lineTo(v.X(knob.x), v.Y(knob.y));
  g.lineWidth = v.dpr; g.strokeStyle = '#fff'; g.stroke();
  g.beginPath(); g.arc(v.X(knob.x), v.Y(knob.y), 5.5 * v.dpr, 0, Math.PI * 2);
  g.fillStyle = '#4f9dff'; g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 1.5 * v.dpr; g.stroke();
}
const ROT_CURSOR = 'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2724%27 height=%2724%27 viewBox=%270 0 24 24%27%3E%3Cpath d=%27M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5%27 fill=%27none%27 stroke=%27white%27 stroke-width=%274%27/%3E%3Cpath d=%27M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5%27 fill=%27none%27 stroke=%27black%27 stroke-width=%272%27/%3E%3C/svg%3E") 12 12, crosshair';

def({
  id: 'transform', name: 'Transform Layer', key: null, cursor: 'default', hidden: true,
  icon: 'M4 4h4v4H4zM16 4h4v4h-4zM4 16h4v4H4zM16 16h4v4h-4zM8 6h8M8 18h8M6 8v8M18 8v8',
  options: [
    { key: 'xf.sx', label: 'W %', type: 'number', live: true }, { key: 'xf.sy', label: 'H %', type: 'number', live: true }, { key: 'xf.rot', label: 'Angle °', type: 'number', live: true },
    { type: 'button', label: 'Apply', action: () => PP.app.tools.byId.get('transform').commit() }, { type: 'button', label: 'Cancel', action: () => PP.app.tools.cancel() },
    { type: 'note', text: 'Squares resize (Shift keeps ratio) · round knob rotates (Shift snaps 15°) · drag inside moves · Enter applies · Esc cancels' }
  ],
  activate() {
    const l = PP.Ops.editableLayer({ rasterizeText: true });
    if (!l) { PP.app.tools.select(this.prev || 'move'); return; }
    this.tl = l; this.st = { tx: 0, ty: 0, sx: 1, sy: 1, rot: 0 };
    O().xf = { sx: 100, sy: 100, rot: 0 };
    this.apply();
  },
  deactivate() { this.bake(); }, // switching tools keeps the change, like MS Paint
  /** Write the previewed transform into the layer (one undo step); pure moves stay lossless. */
  bake() {
    const l = this.tl; if (!l) return;
    const s = this.st, m = this.matrix(); l.xform = null; this.tl = null; this.drag = null;
    if (s.sx === 1 && s.sy === 1 && !s.rot) {
      const x0 = l.x, y0 = l.y; l.x += Math.round(s.tx); l.y += Math.round(s.ty);
      PP.Ops.recordMove(l, x0, y0); bus.emit('pixels', { rect: null });
    } else PP.Ops.applyTransform(l, m, 'Transform Layer');
  },
  matrix() {
    const l = this.tl, s = this.st, c = Math.cos(s.rot), n = Math.sin(s.rot), cx = l.x + l.w / 2 + s.tx, cy = l.y + l.h / 2 + s.ty;
    const a = c * s.sx, b = n * s.sx, cc = -n * s.sy, d = c * s.sy;
    return { a, b, c: cc, d, e: cx - a * (l.w / 2) - cc * (l.h / 2), f: cy - b * (l.w / 2) - d * (l.h / 2) };
  },
  pt(m, x, y) { return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }; },
  apply() { if (!this.tl) return; this.tl.xform = this.matrix(); O().xf = { sx: +(this.st.sx * 100).toFixed(2), sy: +(this.st.sy * 100).toFixed(2), rot: +((this.st.rot * 180) / Math.PI).toFixed(2) }; bus.emit('pixels', { rect: null }); bus.emit('options-values'); },
  optionChanged() { const x = O().xf; if (!this.tl) return; this.st.sx = (+x.sx || 100) / 100; this.st.sy = (+x.sy || 100) / 100; this.st.rot = ((+x.rot || 0) * Math.PI) / 180; this.tl.xform = this.matrix(); bus.emit('pixels', { rect: null }); },
  handles() { const l = this.tl, m = this.matrix(), out = []; for (const hy of [-1, 0, 1]) for (const hx of [-1, 0, 1]) if (hx || hy) out.push({ hx, hy, p: this.pt(m, ((hx + 1) / 2) * l.w, ((hy + 1) / 2) * l.h) }); return out; },
  knob() { const l = this.tl, m = this.matrix(), top = this.pt(m, l.w / 2, 0); return { top, knob: rotKnob(view(), top, this.pt(m, l.w / 2, l.h / 2)) }; },
  hit(e) {
    const v = view(), tol = (8 * v.dpr) / v.scale, k = this.knob().knob;
    if (Math.hypot(k.x - e.x, k.y - e.y) < tol * 1.2) return { kind: 'rotate' };
    const h = this.handles().find(h => Math.hypot(h.p.x - e.x, h.p.y - e.y) < tol);
    if (h) return { kind: 'scale', h };
    const m = this.matrix(), det = m.a * m.d - m.b * m.c, lx = (m.d * (e.x - m.e) - m.c * (e.y - m.f)) / det, ly = (-m.b * (e.x - m.e) + m.a * (e.y - m.f)) / det;
    return { kind: lx >= 0 && ly >= 0 && lx <= this.tl.w && ly <= this.tl.h ? 'move' : 'rotate', outside: true };
  },
  down(e) {
    if (!this.tl) return;
    const H = this.hit(e);
    this.drag = { kind: H.kind, h: H.h, e0: { x: e.x, y: e.y }, st: Object.assign({}, this.st), c: { x: this.tl.x + this.tl.w / 2 + this.st.tx, y: this.tl.y + this.tl.h / 2 + this.st.ty } };
  },
  hoverMove(e) {
    if (!this.tl) return;
    const H = this.hit(e), c = this.st.rot;
    view().over.style.cursor = H.kind === 'move' ? 'move' : H.kind === 'rotate' ? ROT_CURSOR : RESIZE_CURSOR[resizeKey(H.h.hx, H.h.hy, c)];
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
      const lx = c * dx + n * dy, ly = -n * dx + c * dy, W = this.tl.w, H = this.tl.h, { hx, hy } = D.h;
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
  abort() { const D = this.drag; this.drag = null; if (D && this.tl) { Object.assign(this.st, D.st); this.apply(); } },
  commit() { this.bake(); PP.app.tools.select(this.prev || 'move'); },
  cancel() { if (this.tl) { this.tl.xform = null; this.tl = null; this.drag = null; bus.emit('pixels', { rect: null }); } if (!PP.app.tools.switching) PP.app.tools.select(this.prev || 'move'); },
  onKey(e) { if (e.key === 'Enter') { this.commit(); return true; } return false; },
  overlay(g, v) {
    if (!this.tl) return;
    const m = this.matrix(), l = this.tl, c = [[0, 0], [l.w, 0], [l.w, l.h], [0, l.h]].map(([x, y]) => this.pt(m, x, y));
    strokeDocPath(g, v, c, true);
    const k = this.knob(); drawKnob(g, v, k.top, k.knob);
    for (const h of this.handles()) handle(g, v, h.p.x, h.p.y);
    PP.UI && PP.UI.status({ sel: `${Math.round(Math.abs(l.w * this.st.sx))} × ${Math.round(Math.abs(l.h * this.st.sy))} · ${(+((this.st.rot * 180) / Math.PI).toFixed(1))}°` });
  }
});
/** Resize cursor for a handle, turned with the layer's rotation (nearest 45°). */
function resizeKey(hx, hy, rot) {
  const a = Math.atan2(hy, hx) + rot, q = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  return ['1,0', '1,1', '0,1', '-1,1', '-1,0', '-1,-1', '0,-1', '1,-1'][q];
}

/* Floating selection (MS Paint style): pasted or lifted pixels hover above the active layer until stamped.
 * Drag inside to move, drag handles to resize (Shift / Keep ratio holds proportions), arrows nudge (Shift 10 px).
 * Enter, clicking outside or switching tools stamps it down; Esc puts everything back; Delete discards it. */
function floatImage(f) {
  if (!O().paste.transparent) return f.src;
  const key = app().colors.bg;
  if (f.kKey !== key) { // knock out pixels matching the background colour
    const c = U.clone(f.src), img = U.read(c), d = img.data, [r, g, b] = bgc();
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - r) <= 12 && Math.abs(d[i + 1] - g) <= 12 && Math.abs(d[i + 2] - b) <= 12) d[i + 3] = 0;
    U.write(c, img); f.kImg = c; f.kKey = key;
  }
  return f.kImg;
}
const RESIZE_CURSOR = { '-1,-1': 'nwse-resize', '1,1': 'nwse-resize', '1,-1': 'nesw-resize', '-1,1': 'nesw-resize', '0,-1': 'ns-resize', '0,1': 'ns-resize', '-1,0': 'ew-resize', '1,0': 'ew-resize' };
const floatTool = () => PP.app.tools.byId.get('paste');

def({
  id: 'paste', name: 'Floating Selection', key: null, cursor: 'move', hidden: true,
  icon: 'M4 4h16v16H4z',
  options: [
    { key: 'paste.x', label: 'X', type: 'number' }, { key: 'paste.y', label: 'Y', type: 'number' },
    { key: 'paste.w', label: 'W', type: 'number' }, { key: 'paste.h', label: 'H', type: 'number' },
    { key: 'paste.ratio', label: 'Keep ratio', type: 'check' }, { key: 'paste.transparent', label: 'Transparent (bg colour)', type: 'check' },
    { type: 'button', label: 'Flip H', action: () => floatTool().flip('h') }, { type: 'button', label: 'Flip V', action: () => floatTool().flip('v') },
    { type: 'button', label: 'Rotate 90°', action: () => floatTool().flip('r') },
    { type: 'button', label: 'Done', action: () => floatTool().commit() }, { type: 'button', label: 'Delete', action: () => floatTool().drop() },
    { type: 'note', text: 'Drag to move · handles resize · arrows nudge · Enter or click outside to place · Esc cancels' }
  ],
  f: null, pending: null, shown: null,
  activate() {
    const p = this.pending; this.pending = null;
    if (!p) { PP.app.tools.select(this.prev || 'rect-select'); return; }
    const s = doc().selection;
    const f = this.f = app().floating = Object.assign({ w: p.src.width, h: p.src.height, sel: s.mask ? P.rleEncode(s.mask) : null }, p);
    f.image = () => floatImage(f);
    f.render = () => { const c = U.canvas(f.w, f.h), g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(floatImage(f), 0, 0, f.w, f.h); return c; };
    s.set(null); // the float replaces the selection; restored if cancelled or undone
    this.touch();
  },
  deactivate() { this.finish('stamp'); },
  /** Repaint the old and new float area and mirror geometry into the options bar. */
  touch() {
    const f = this.f; if (!f) return;
    const r = U.snap({ x: f.x - 1, y: f.y - 1, w: f.w + 2, h: f.h + 2 });
    bus.emit('pixels', { rect: U.union(this.shown, r) }); this.shown = r;
    if (f.ownLayer) { // show the pasted layer itself at the float's geometry
      const l = f.layer; l.preview = floatImage(f);
      l.xform = { a: f.w / f.src.width, b: 0, c: 0, d: f.h / f.src.height, e: f.x, f: f.y };
    }
    Object.assign(O().paste, { x: f.x, y: f.y, w: f.w, h: f.h });
    bus.emit('options-values'); view().requestOverlay();
  },
  /** mode: 'stamp' draws it onto the layer, 'drop' discards it (a lifted hole stays), 'revert' restores everything. */
  finish(mode) {
    const f = this.f; if (!f) return;
    this.f = app().floating = null; this.drag = null;
    bus.emit('pixels', { rect: this.shown }); this.shown = null;
    const l = f.layer, d = doc(), sel = d.selection, n = sel.w * sel.h;
    const restoreSel = () => sel.set(f.sel ? P.rleDecode(f.sel, n) : null);
    if (f.ownLayer) {
      const h = PP.app.history; l.xform = null; l.preview = null;
      if (mode !== 'stamp') { // Esc / Delete take the whole paste (and its layer) back
        if (h.index === f.hist) { h.undo(); h.stack.splice(h.index + 1); bus.emit('history'); } else restoreSel();
        return;
      }
      if (f.src === l.canvas && f.w === l.w && f.h === l.h && !O().paste.transparent) {
        const x0 = l.x, y0 = l.y; l.x = f.x; l.y = f.y; PP.Ops.recordMove(l, x0, y0); bus.emit('pixels', { rect: null });
      } else M.docCommand('Resize Pasted', () => { l.canvas = f.render(); l.x = f.x; l.y = f.y; l.rev++; });
      return;
    }
    if (mode === 'revert') {
      if (f.edit) { for (const t of f.edit.tiles.values()) U.write(l.canvas, t.before, t.x, t.y); l.touch(); }
      restoreSel(); return;
    }
    const h = PP.app.history, wrapTop = () => Object.assign(h.stack[h.index], { selBefore: f.sel, selAfter: null, selN: n }); // one undo step also brings the selection back
    const edit = f.edit || new M.PixelEdit(l);
    if (mode === 'stamp') {
      const r = U.intersect(U.snap({ x: f.x - l.x, y: f.y - l.y, w: f.w, h: f.h }), { x: 0, y: 0, w: l.w, h: l.h });
      if (r) {
        edit.save(r);
        const g = l.canvas.getContext('2d'); g.save(); g.imageSmoothingQuality = 'high';
        g.drawImage(floatImage(f), f.x - l.x, f.y - l.y, f.w, f.h); g.restore();
        l.touch(r);
      }
    }
    if (edit.commit(mode === 'drop' ? 'Delete Selection' : f.label)) wrapTop();
    else if (f.sel) h.push(M.entry('sel', 'Deselect', { before: f.sel, after: null, n }));
  },
  done(mode) { this.finish(mode); if (!PP.app.tools.switching && PP.app.tools.current === this) PP.app.tools.select(this.prev || 'rect-select'); },
  commit() { this.done('stamp'); },
  drop() { this.done('drop'); },
  cancel() { this.done('revert'); },
  optionChanged(k) {
    const f = this.f, o = O().paste; if (!f) return;
    if (k === 'paste.w' || k === 'paste.h') {
      let w = Math.max(1, Math.round(+o.w) || f.w), h = Math.max(1, Math.round(+o.h) || f.h);
      if (o.ratio) { if (k === 'paste.w') h = Math.max(1, Math.round((w * f.h) / f.w)); else w = Math.max(1, Math.round((h * f.w) / f.h)); }
      if (!U.validSize(w, h)) { toast('Too large', 'warn'); this.touch(); return; }
      f.w = w; f.h = h;
    } else if (k === 'paste.x' || k === 'paste.y') { f.x = Math.round(+o.x) || 0; f.y = Math.round(+o.y) || 0; }
    else if (k === 'paste.transparent') f.kKey = null;
    this.touch();
  },
  flip(kind) {
    const f = this.f; if (!f) return;
    const s = f.src, rot = kind === 'r', c = U.canvas(rot ? s.height : s.width, rot ? s.width : s.height), g = c.getContext('2d');
    if (kind === 'h') { g.translate(c.width, 0); g.scale(-1, 1); } else if (kind === 'v') { g.translate(0, c.height); g.scale(1, -1); } else { g.translate(c.width, 0); g.rotate(Math.PI / 2); }
    g.drawImage(s, 0, 0); f.src = c; f.kKey = null;
    if (rot) { const cx = f.x + f.w / 2, cy = f.y + f.h / 2; [f.w, f.h] = [f.h, f.w]; f.x = Math.round(cx - f.w / 2); f.y = Math.round(cy - f.h / 2); }
    this.touch();
  },
  hit(e) {
    const f = this.f, v = view(), tol = (7 * v.dpr) / v.scale;
    if (f.w * v.scale >= 20 * v.dpr && f.h * v.scale >= 20 * v.dpr) { // tiny floats: whole box moves; use W/H to resize
      for (const hy of [-1, 0, 1]) for (const hx of [-1, 0, 1]) {
        if (!hx && !hy) continue;
        if (Math.abs(e.x - (f.x + ((hx + 1) / 2) * f.w)) <= tol && Math.abs(e.y - (f.y + ((hy + 1) / 2) * f.h)) <= tol) return { hx, hy };
      }
    }
    return e.x >= f.x && e.y >= f.y && e.x <= f.x + f.w && e.y <= f.y + f.h ? 'in' : null;
  },
  down(e) {
    const f = this.f; if (!f) return;
    const h = this.hit(e);
    if (!h) { // clicking outside places it and hands the click to the previous tool (e.g. starts a new marquee)
      const tm = PP.app.tools; this.commit();
      if (tm.current !== this) { tm.active = true; tm.current.down && tm.current.down(e); }
      return;
    }
    this.drag = { h, e0: { x: e.x, y: e.y }, r0: { x: f.x, y: f.y, w: f.w, h: f.h } };
  },
  move(e) {
    const D = this.drag, f = this.f; if (!D || !f) return;
    let dx = e.x - D.e0.x, dy = e.y - D.e0.y;
    const r = D.r0;
    if (D.h === 'in') {
      if (e.shift) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      f.x = Math.round(r.x + dx); f.y = Math.round(r.y + dy);
    } else {
      const { hx, hy } = D.h;
      let x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
      if (hx < 0) x0 = Math.min(x1 - 1, Math.round(r.x + dx)); else if (hx > 0) x1 = Math.max(x0 + 1, Math.round(r.x + r.w + dx));
      if (hy < 0) y0 = Math.min(y1 - 1, Math.round(r.y + dy)); else if (hy > 0) y1 = Math.max(y0 + 1, Math.round(r.y + r.h + dy));
      let w = x1 - x0, h = y1 - y0;
      if ((e.shift || O().paste.ratio) && hx && hy) {
        const k = Math.max(w / r.w, h / r.h); w = Math.max(1, Math.round(r.w * k)); h = Math.max(1, Math.round(r.h * k));
        if (hx < 0) x0 = x1 - w; if (hy < 0) y0 = y1 - h;
      }
      if (!U.validSize(w, h)) return;
      f.x = x0; f.y = y0; f.w = w; f.h = h;
    }
    this.touch();
  },
  up() { this.drag = null; },
  /** Interrupted gesture (pinch, pointercancel, tool switch mid-drag): undo just this drag, keep the float. */
  abort() { const D = this.drag; this.drag = null; if (D && this.f) { Object.assign(this.f, D.r0); this.touch(); } },
  hoverMove(e) {
    if (!this.f) return;
    const h = this.hit(e);
    view().over.style.cursor = !h ? 'default' : h === 'in' ? 'move' : RESIZE_CURSOR[h.hx + ',' + h.hy];
  },
  onKey(e) {
    const f = this.f; if (!f) return false;
    const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (k) { const n = e.shiftKey ? 10 : 1; f.x += k[0] * n; f.y += k[1] * n; this.touch(); return true; }
    if (e.key === 'Enter') { this.commit(); return true; }
    if (e.key === 'Escape') { this.cancel(); return true; }
    if (e.key === 'Delete' || e.key === 'Backspace') { this.drop(); return true; }
    return false;
  },
  overlay(g, v) {
    const f = this.f; if (!f) return;
    strokeDocRect(g, v, f, true);
    if (f.w * v.scale >= 20 * v.dpr && f.h * v.scale >= 20 * v.dpr) for (const hy of [0, 0.5, 1]) for (const hx of [0, 0.5, 1]) if (hx !== 0.5 || hy !== 0.5) handle(g, v, f.x + hx * f.w, f.y + hy * f.h);
    PP.UI && PP.UI.status({ sel: `${f.w} × ${f.h} at ${f.x}, ${f.y}` });
  }
});

/** Begin a floating selection. p: {src, x, y, layer, edit?, label}. Any current float is stamped first. */
function startFloat(p) {
  const tm = PP.app.tools, t = floatTool();
  settleFloat();
  t.pending = p; tm.select('paste');
  return tm.current === t;
}
/** Finish any live, uncommitted edit (floating paste or layer transform) before another command runs. */
function settleFloat() {
  const t = floatTool(); if (t.f) t.commit();
  const x = PP.app.tools.byId.get('transform'); if (PP.app.tools.current === x && x.tl) x.commit();
}

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
    try { if (prev) { if (this.active && prev.abort) prev.abort(); else if (prev.cancel && (this.active || prev.pts || prev.r || prev.l)) prev.cancel(); prev.deactivate && prev.deactivate(); } }
    finally { this.switching = false; }
    this.active = false;
    t.prev = prev && !prev.hidden ? prev.id : t.prev;
    this.current = t;
    this.view.over.style.cursor = t.cursor || 'default';
    t.activate && t.activate();
    if (this.current !== t) return; // activate() redirected to another tool
    if (!t.hidden) try { localStorage.setItem('pp.tool', id); } catch (e) { /* storage blocked */ }
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
        if (this.touches.size === 2) { if (this.active) { this.interrupt(); this.active = false; } this.startPinch(); return; }
        if (this.touches.size > 2) return;
      }
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (e.button === 1 || this.spaceHeld || (e.button === 0 && this.current.id === 'hand')) { this.temp = { x: e.clientX, y: e.clientY }; el.style.cursor = 'grabbing'; return; }
      if (e.button !== 0 && !(e.button === 2 && (this.current.id === 'picker' || this.current.rightClick))) return;
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
      if (cancelled) this.interrupt(); else this.current.up && this.current.up(this.ev(e));
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
  interrupt() { const t = this.current; if (t.abort) t.abort(); else t.cancel && t.cancel(); }
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

PP.Tools = { ToolManager, list: tools, Stroke, rasterMask, scratchCanvas, startFloat, settleFloat, selBrush };
})();
